/* The enterprise intake gate (E3 design 3.1; attestation contract sections 3 to 6).

   gate(bytes, contentType, { validatedAt })
     -> { ok: true, text, derived, derivedCanonical, contentSha256, derivedSha256, gateIdentitySha256,
          validatedAt }
      | { ok: false, code, problems: [{ code, line }] }

   `bytes` is a Buffer and never a string: the pinned transport() is the only decoder, so an invalid byte
   sequence reaches E_NOT_UTF8 instead of being replaced before it can be refused. `validatedAt` is one
   ISO-8601 timestamp the caller computes once per request, or the stored value on replay (C3); it is required,
   because a derived record stamped with a time nobody chose cannot be reproduced.

   Order, and why each stage sits where it does:
     1. transport(bytes, contentType): content type, size, UTF-8, byte-order mark, CRLF, controls. Fails fast.
     2. The fixed-point rule, E_CANONICAL. Fails fast, before validate(), because everything after it assumes
        the stored bytes are the bytes the assembly decoder would produce (design 3.1, the lead's Q5).
     3. validate(text): the pinned stages 2 and 3, the secret scan included.
     4. derive(front, lines, { validatedAt }) whenever validate() found nothing, as the pinned parity pipeline
        does; its refusals are part of the verdict.
     5. The four missing format checks, in the order 15, 12, 14, 13.
     6. The public publisher route scan.
     7. canonical(record) and the two hashes.
   Stages 3 to 6 all run before the gate answers, so one upload reports every format problem it has.

   Refusal shape (design 3.5). A refusal is a list of { code, line } and nothing else: the pinned `message`
   is dropped because values from the document are substituted into it; each `details` entry contributes only
   the number read from its leading "line N"; a code whose error carries no line gives line null. For
   E_SECRET_FOUND alone a problem also carries `kind`, and only a kind that is a name in the pinned SECRETS
   list, so the forwarded vocabulary is closed. Identical problems are reported once. `code` is the code of the
   first problem in stage order.

   Called by lib/services/candidates.mjs in production (E3b) and by scripts/verify-attestation.mjs for replay.
   The identity it reports is GATE_IDENTITY_SHA256 of the generated gate-manifest.mjs, which names every file
   outside vendor/ this module reaches (design 2.7). */

import { createHash } from 'node:crypto';

import { derive } from '../../vendor/passport/web/lib/_derive.mjs';
import { SECRETS, transport, validate } from '../../vendor/passport/web/lib/_validate.mjs';
import { canonical } from './canonical.mjs';
import { GATE_IDENTITY_SHA256 } from './gate-manifest.mjs';
import { fixedPoint, formatChecks, publicRoutes } from './rules.mjs';

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LINE = /^line (\d+)/;
const SECRET_KIND = /^line \d+: (.+)$/;
const SECRET_NAMES = new Set(SECRETS.map(([name]) => name));

const sha256hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/* Shape, then a round trip through Date, because Date.parse repairs an impossible date instead of failing it. */
function isTimestamp(value) {
  if (typeof value !== 'string' || !ISO_MS.test(value)) return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === value;
}

/* The pinned { code, message, details? } errors, reduced to problems. */
function problemsOf(errors) {
  const out = [];
  for (const error of errors) {
    const details = Array.isArray(error.details) ? error.details : [];
    let located = 0;
    for (const detail of details) {
      const m = LINE.exec(String(detail));
      if (!m) continue;
      const p = { code: error.code, line: Number(m[1]) };
      if (error.code === 'E_SECRET_FOUND') {
        const k = SECRET_KIND.exec(String(detail));
        if (k && SECRET_NAMES.has(k[1])) p.kind = k[1];
      }
      out.push(p);
      located++;
    }
    if (located === 0) out.push({ code: error.code, line: null });
  }
  return out;
}

function refused(problems) {
  const seen = new Set();
  const unique = [];
  for (const p of problems) {
    const key = `${p.code}|${p.line}|${p.kind ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(Object.freeze({ ...p }));
  }
  return Object.freeze({ ok: false, code: unique[0].code, problems: Object.freeze(unique) });
}

/** Run the intake gate over the bytes a client sent. Throws TypeError for a caller error (bytes not a Buffer,
    validatedAt missing or not a real millisecond UTC timestamp); every verdict about the document is a value. */
export function gate(bytes, contentType, { validatedAt } = {}) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('gate: bytes is not a Buffer');
  if (!isTimestamp(validatedAt)) throw new TypeError('gate: validatedAt is not an ISO-8601 UTC millisecond timestamp');

  const t = transport(bytes, contentType);
  if (t.error) return refused(problemsOf([t.error]));

  const canonicalProblems = fixedPoint(t.text);
  if (canonicalProblems.length > 0) return refused(canonicalProblems);

  const v = validate(t.text);
  const problems = problemsOf(v.errors);
  let record = null;
  if (v.errors.length === 0) {
    const d = derive(v.front, v.lines, { validatedAt });
    if (d.error) problems.push(...problemsOf([d.error]));
    else record = d.record;
  }
  problems.push(...formatChecks(v.lines, v.inside), ...publicRoutes(v.lines));
  if (problems.length > 0) return refused(problems);

  const derivedCanonical = canonical(record);
  return Object.freeze({
    ok: true,
    text: t.text,
    derived: record,
    derivedCanonical,
    contentSha256: sha256hex(t.text),
    derivedSha256: sha256hex(derivedCanonical),
    gateIdentitySha256: GATE_IDENTITY_SHA256,
    validatedAt,
  });
}
