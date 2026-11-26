/* The review packet's pure readings of a stored passport and an envelope (E4 design 1.1, 1.3, 2.1 and 4.1).

   Not on the gate graph: no file of the gate identity imports this module, so adding or changing it changes no gate
   identity (lib/passport/gate-manifest.mjs lists the four files that do). No IO: the gate and the renderer's table reader
   are pure, and the installer text arrives as an argument.
     replayStored             the replay verification of attestation contract section 7, run by this build's gate before
                              an envelope is created and before an approval (1.1): the stored content, gated with the
                              validated_at stored inside derived_canonical, must pass, come back byte-equal, and derive
                              byte-equal canonical bytes. E_GATE_FAILS_NOW or E_DERIVED_CHANGED otherwise;
     lossRows                 section 6's declared loss rows, read with the vendored section slicer and the renderer's own
                              tableRows exactly as lossesState reads them, so the review read and the renderer cannot
                              disagree about whether losses are declared. An empty section is the empty table, [];
     projectedAssembledBytes  the size of the assembly without building it (E4D-C-F3): the accepted assembler replaces
                              every placeholder occurrence, so content + occurrences x (text - placeholder) UTF-8 bytes,
                              the occurrences counted with indexOf and never with a split over the whole content.
                              app.assembled_bytes is the SQL twin;
     assembledSha256          the expected hash publication binds (1.3), over content.split(PLACEHOLDER).join(text), the
                              substitution the routine's replace() must reproduce. It refuses, before building anything,
                              an assembly whose projected size exceeds ASSEMBLED_BYTES_MAX;
     envelopeCanonical        the canonical JSON of an envelope binding (1.1), group ids sorted by code unit, the text
                              app.envelope_canonical builds byte for byte (case 46). */

import { createHash } from 'node:crypto';

import { sectionLines as sliceSection } from '../../vendor/passport/web/lib/_sections.mjs';
import { PLACEHOLDER } from './assemble.mjs';
import { canonical } from './canonical.mjs';
import { gate } from './gate.mjs';
import { tableRows } from './render.mjs';

/* app.limit_assembled_bytes(): 262,144 content bytes and 131,072 installer bytes (design 2.3 B5). */
export const ASSEMBLED_BYTES_MAX = 393216;

const PLACEHOLDER_BYTES = Buffer.byteLength(PLACEHOLDER, 'utf8');
const FAILS_NOW = Object.freeze({ ok: false, code: 'E_GATE_FAILS_NOW' });
const DERIVED_CHANGED = Object.freeze({ ok: false, code: 'E_DERIVED_CHANGED' });
const sha256hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * replayStored({ content, derivedCanonical })
 *   -> { ok: true, contentSha256, derivedSha256, gateIdentitySha256 } | { ok: false, code }
 */
export function replayStored({ content, derivedCanonical }) {
  if (typeof content !== 'string' || typeof derivedCanonical !== 'string') return FAILS_NOW;
  let validatedAt;
  try {
    validatedAt = JSON.parse(derivedCanonical)?.validated_at;
  } catch {
    return FAILS_NOW;
  }
  if (typeof validatedAt !== 'string') return FAILS_NOW;
  let verdict;
  try {
    verdict = gate(Buffer.from(content, 'utf8'), 'text/markdown', { validatedAt });
  } catch {
    /* gate() throws for a validatedAt that is not a millisecond UTC timestamp, which the row's trigger never stores. */
    return FAILS_NOW;
  }
  if (!verdict.ok || verdict.text !== content) return FAILS_NOW;
  if (verdict.derivedCanonical !== derivedCanonical) return DERIVED_CHANGED;
  return Object.freeze({
    ok: true,
    contentSha256: verdict.contentSha256,
    derivedSha256: verdict.derivedSha256,
    gateIdentitySha256: verdict.gateIdentitySha256,
  });
}

/** lossRows(content) -> [{ what, status, meaning }], the declared rows of section 6 in order; [] when none. */
export function lossRows(content) {
  if (typeof content !== 'string') throw new TypeError('lossRows: content is not a string');
  return tableRows(sliceSection(content.split('\n'), '## 6. Losses')).data.map((cells) =>
    Object.freeze({ what: cells[0] ?? '', status: cells[1] ?? '', meaning: cells[2] ?? '' }),
  );
}

/** projectedAssembledBytes(content, text) -> the UTF-8 byte length content.split(PLACEHOLDER).join(text) would have. */
export function projectedAssembledBytes(content, text) {
  if (typeof content !== 'string' || typeof text !== 'string')
    throw new TypeError('projectedAssembledBytes: content and text are strings');
  let occurrences = 0;
  for (let at = content.indexOf(PLACEHOLDER); at !== -1; at = content.indexOf(PLACEHOLDER, at + PLACEHOLDER.length))
    occurrences++;
  return Buffer.byteLength(content, 'utf8') + occurrences * (Buffer.byteLength(text, 'utf8') - PLACEHOLDER_BYTES);
}

/** assembledSha256(content, text) -> hex SHA-256 of the assembly. Throws RangeError above ASSEMBLED_BYTES_MAX. */
export function assembledSha256(content, text) {
  if (projectedAssembledBytes(content, text) > ASSEMBLED_BYTES_MAX)
    throw new RangeError('assembledSha256: the assembly would exceed ASSEMBLED_BYTES_MAX');
  return sha256hex(content.split(PLACEHOLDER).join(text));
}

/**
 * envelopeCanonical(binding) -> the canonical JSON text whose SHA-256 is the envelope hash.
 * binding: { group_ids, candidate_id, content_sha256, derived_sha256, gate_identity_sha256,
 *            installer: { text_sha256, core_sha256, branch_sha256, judge_sha256 }, policy: { id, sha256 }, target }
 */
export function envelopeCanonical(binding) {
  return canonical({
    audience: { group_ids: [...binding.group_ids].sort() },
    candidate_id: binding.candidate_id,
    content_sha256: binding.content_sha256,
    derived_sha256: binding.derived_sha256,
    envelope_version: 1,
    gate_identity_sha256: binding.gate_identity_sha256,
    installer: {
      branch_sha256: binding.installer.branch_sha256,
      core_sha256: binding.installer.core_sha256,
      judge_sha256: binding.installer.judge_sha256,
      text_sha256: binding.installer.text_sha256,
    },
    policy: { id: binding.policy.id, sha256: binding.policy.sha256 },
    target: binding.target,
  });
}
