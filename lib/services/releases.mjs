/* Release services (E4 design 1.3, 1.4, 3.4 to 3.6): publish an approved envelope, withdraw a release, read one, list a
   company's. Results are plain data; failures are AppErrors.

   Publication meets its refusals in the order of 3.5's publication table:
     row 10   the Idempotency-Key header; row 11 the body, { envelopeId } and nothing else;
     row 12   the candidate and the envelope, read under the caller's own token, the envelope of that candidate;
     row 13   the installer text registered for the envelope's gate and target, readable to the caller, or 503
              E_INSTALLER_UNREGISTERED;
     row 14a  the arithmetic (E4D-C-F3): the projected assembly above 393,216 bytes is E_ASSEMBLY_TOO_LARGE before any hash
              and before anything is built;
     row 14   when the envelope's gate is this build's, the text's SHA-256 against the generated manifest constant of this
              build (INSTALLER_MANIFEST); a difference is 500 E_ASSEMBLY_DIVERGED, logged with the two hashes, and no call;
     then the expected assembled hash from those rows, and the routine under a bearer bound to it, which splices in SQL and
              refuses a different hash before anything is written (row 37).
   A caller who is not an admin at aal2 is refused by the routine; the service's own work per call is bounded by one
   393,216-byte assembly. Withdrawal: row 10, row 11 (the reason rule), row 12 (the release readable), then the routine.
   The reads answer design 3.4's release object; a release reader who may not read its candidate (an owner who is
   neither author, reviewer nor admin) receives envelope and reviews as null, which is what row level security returns
   (E4D-C-F4 settled: 3.1 and B7 govern), and recipients as null unless an admin or the agent's owner.

   E5 (design 3.4, E5D-C-F6) extends the single-release read and nothing else here: it gains `download`, the
   authoritative decision api.authorize_download would make for this caller right now, and `my`, the caller's own
   authorization summary and check-in state. Without them a page opened directly at /release/?release=... would have to
   scan catalog pages or reconstruct a permission rule in the browser to know whether to offer the install control. The
   routine stays authoritative: these two fields are a hint for what to render, and the download decides again. */

import { createHash } from 'node:crypto';

import { callBound } from '../db/server.mjs';
import { select } from '../db/user.mjs';
import { AppError } from '../errors.mjs';
import { GATE_IDENTITY_SHA256 } from '../passport/gate-manifest.mjs';
import { INSTALLER_TEXTS } from '../passport/installer-manifest.mjs';
import { ASSEMBLED_BYTES_MAX, assembledSha256, projectedAssembledBytes } from '../passport/packet.mjs';
import { checkInDueAt, LIMIT_REPORTS_PER_RECIPIENT, newestReport } from '../rules/installations.mjs';
import { reviewReasonOf, uuidOf } from '../rules/reviews.mjs';
import * as evidence from './evidence-reads.mjs';
import { isUuid, loadPrincipal } from './principal.mjs';

const { ENVELOPE_COLUMNS, RELEASE_COLUMNS, REVIEW_COLUMNS, envelopeObject, hexOf, isoOf, readAll } = evidence;
const { readRegisters, releaseObject, reviewObject } = evidence;
/* E5 design 2.1: the ledger read and the recipient aggregate moved to lib/services/evidence-reads.mjs, because the
   installations read answers the same numbers and neither service is the other's holder. */
const { INSTALLATION_REPORT_COLUMNS, installationReportObject, readLedger, recipientsFrom } = evidence;

const RELEASE_STATES = Object.freeze(['published', 'withdrawn']);
const LIST_PAGE = 50;

const invalid = () => new AppError('E_BODY_INVALID');
const replayed = (stored) => (stored.idempotent_replay === true ? { idempotentReplay: true } : {});
const sha256hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const defaultLog = (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`);

function idempotencyKeyOf(value) {
  const key = uuidOf(value);
  if (key === null) throw new AppError('E_IDEMPOTENCY_KEY_INVALID');
  return key;
}

function objectWithKeys(body, allowed) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid();
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw invalid();
}

function storedWith(answer, field) {
  if (typeof answer !== 'object' || answer === null || typeof answer[field] !== 'string')
    throw new AppError('E_INTERNAL');
  return answer;
}

async function releaseById(session, releaseId, options) {
  const [rows, registers] = await Promise.all([
    select(session, 'releases', { select: RELEASE_COLUMNS, id: `eq.${releaseId}` }, options),
    readRegisters(session, options),
  ]);
  if (rows.length !== 1) throw new AppError('E_NOT_FOUND');
  return releaseObject(rows[0], registers);
}

/* The recipients of design 1.4 as the API names them, from the routine's answer. */
const recipientOf = (r) => ({
  membershipId: r.membership_id,
  firstAuthorizedAt: isoOf(r.first_authorized_at),
  lastAuthorizedAt: isoOf(r.last_authorized_at),
  authorizations: r.authorizations,
});

/** POST /api/candidates/{candidateId}/releases (design 1.3, 3.4). { ok, release, superseded, existing }. The route
    answers 201, or 200 when existing. options.log receives the one log line of a manifest divergence. */
export async function publishRelease(session, { candidateId, idempotencyKey, body }, options = {}) {
  const key = idempotencyKeyOf(idempotencyKey);
  objectWithKeys(body, ['envelopeId']);
  const envelopeId = uuidOf(body.envelopeId);
  if (envelopeId === null) throw invalid();
  if (!isUuid(candidateId)) throw new AppError('E_NOT_FOUND');
  const [candidates, envelopes] = await Promise.all([
    select(session, 'candidate_versions', { select: 'id,content', id: `eq.${candidateId}` }, options),
    select(
      session,
      'review_envelopes',
      { select: 'id,gate_id,gate_identity_sha256,target', id: `eq.${envelopeId}`, candidate_id: `eq.${candidateId}` },
      options,
    ),
  ]);
  if (candidates.length !== 1 || envelopes.length !== 1) throw new AppError('E_NOT_FOUND');
  const envelope = envelopes[0];
  const content = candidates[0].content;
  const texts = await select(
    session,
    'installer_texts',
    { select: 'text', gate_id: `eq.${envelope.gate_id}`, target: `eq.${envelope.target}` },
    options,
  );
  if (texts.length !== 1 || typeof texts[0].text !== 'string') throw new AppError('E_INSTALLER_UNREGISTERED');
  const text = texts[0].text;
  if (projectedAssembledBytes(content, text) > ASSEMBLED_BYTES_MAX) throw new AppError('E_ASSEMBLY_TOO_LARGE');
  if (hexOf(envelope.gate_identity_sha256) === GATE_IDENTITY_SHA256) {
    const manifestTextSha256 = INSTALLER_TEXTS.find((t) => t.target === envelope.target)?.textSha256;
    const registeredTextSha256 = sha256hex(text);
    if (registeredTextSha256 !== manifestTextSha256) {
      (options.log ?? defaultLog)({
        event: 'assembly_diverged',
        stage: 'installer_text',
        target: envelope.target,
        registeredTextSha256,
        manifestTextSha256: manifestTextSha256 ?? null,
      });
      throw new AppError('E_ASSEMBLY_DIVERGED');
    }
  }
  const expected = assembledSha256(content, text);
  const stored = storedWith(
    await callBound(
      session,
      'publish_release',
      {
        candidate_id: candidateId,
        envelope_id: envelopeId,
        expected_assembled_sha256: expected,
        gate_identity: GATE_IDENTITY_SHA256,
        idempotency_key: key,
      },
      options,
    ),
    'release_id',
  );
  return {
    ok: true,
    release: await releaseById(session, stored.release_id, options),
    superseded: {
      releaseIds: Array.isArray(stored.superseded_release_ids) ? stored.superseded_release_ids : [],
      candidateIds: Array.isArray(stored.superseded_candidate_ids) ? stored.superseded_candidate_ids : [],
    },
    existing: stored.existing === true,
    ...replayed(stored),
  };
}

/** POST /api/releases/{releaseId}/withdraw (design 1.4, 3.4). { ok, release, recipients, recipientCount,
    revokesCopies: false }: withdrawal is never a revocation, so no client can render it as one. */
export async function withdrawRelease(session, { releaseId, idempotencyKey, body }, options) {
  const key = idempotencyKeyOf(idempotencyKey);
  objectWithKeys(body, ['reason']);
  const reason = reviewReasonOf(body.reason);
  if (!reason.ok) throw invalid();
  if (!isUuid(releaseId)) throw new AppError('E_NOT_FOUND');
  const visible = await select(session, 'releases', { select: 'id', id: `eq.${releaseId}` }, options);
  if (visible.length !== 1) throw new AppError('E_NOT_FOUND');
  const stored = storedWith(
    await callBound(
      session,
      'withdraw_release',
      { release_id: releaseId, reason: reason.value, idempotency_key: key },
      options,
    ),
    'release_id',
  );
  const recipients = Array.isArray(stored.recipients) ? stored.recipients.map(recipientOf) : [];
  return {
    ok: true,
    release: await releaseById(session, stored.release_id, options),
    recipients,
    recipientCount: recipients.length,
    revokesCopies: false,
    ...replayed(stored),
  };
}

/** GET /api/releases/{releaseId} (design 3.4): the release, its envelope and reviews when the caller may read the
    candidate (else null), and its recipients when the caller is an admin or the agent's owner (else null). */
export async function readRelease(session, { releaseId }, options = {}) {
  if (!isUuid(releaseId)) throw new AppError('E_NOT_FOUND');
  const rows = await select(session, 'releases', { select: RELEASE_COLUMNS, id: `eq.${releaseId}` }, options);
  if (rows.length !== 1) throw new AppError('E_NOT_FOUND');
  const row = rows[0];
  const principal = await loadPrincipal(session, row.company_id, options);
  if (!principal.ok) throw new AppError(principal.code);
  /* The download decision and the caller's own summary come from api.release_catalog, which is api.releases with the
     three computed columns; it is read by id in its own request rather than folded into the read above, because this
     client bounds a filter value at 400 characters and RELEASE_COLUMNS already fills most of that. The caller's own
     reports are at most limit_reports_per_recipient() rows, read to the end. */
  const [envelopes, reviews, agents, registers, decision, ownReports] = await Promise.all([
    select(session, 'review_envelopes', { select: ENVELOPE_COLUMNS, id: `eq.${row.envelope_id}` }, options),
    readAll(session, 'reviews', { select: REVIEW_COLUMNS, envelope_id: `eq.${row.envelope_id}` }, 3, options),
    select(session, 'agents', { select: 'id,owner_membership_id', id: `eq.${row.agent_id}` }, options),
    readRegisters(session, options),
    select(
      session,
      'release_catalog',
      { select: 'id,blocked_reason,my_authorizations', id: `eq.${releaseId}` },
      options,
    ),
    readAll(
      session,
      'installation_reports',
      {
        select: INSTALLATION_REPORT_COLUMNS,
        release_id: `eq.${releaseId}`,
        membership_id: `eq.${principal.membershipId}`,
      },
      LIMIT_REPORTS_PER_RECIPIENT,
      options,
    ),
  ]);
  const mayReadRecipients =
    principal.roles.includes('company_admin') || agents[0]?.owner_membership_id === principal.membershipId;
  const recipients = mayReadRecipients ? recipientsFrom(await readLedger(session, releaseId, options)) : null;
  const envelope = envelopes.length === 1 ? envelopeObject(envelopes[0], reviews, registers) : null;
  return {
    ok: true,
    release: releaseObject(row, registers),
    envelope,
    reviews: envelope === null ? null : reviews.map(reviewObject),
    recipients,
    recipientCount: recipients === null ? null : recipients.length,
    ...ownSummary(decision[0] ?? null, ownReports, options.now ?? new Date().toISOString()),
  };
}

/* E5D-C-F6: `download` and `my` for the caller of a single-release read. The catalog row is absent only if row level
   security stopped admitting the release between the two statements of one request, which is a caller who has just
   lost standing; the fields are then null and the page offers nothing. */
function ownSummary(catalogRow, ownReports, now) {
  if (catalogRow === null) {
    return { download: { downloadable: false, blockedReason: 'E_NOT_FOUND' }, my: null };
  }
  const my = catalogRow.my_authorizations ?? {};
  const authorizations = Number.isInteger(my.authorizations) ? my.authorizations : 0;
  const firstAuthorizedAt = isoOf(my.first_authorized_at ?? null);
  const checkIn = checkInDueAt(firstAuthorizedAt, ownReports, now);
  const newest = newestReport(ownReports);
  return {
    download: { downloadable: catalogRow.blocked_reason === null, blockedReason: catalogRow.blocked_reason ?? null },
    my: {
      authorizations,
      firstAuthorizedAt,
      lastAuthorizedAt: isoOf(my.last_authorized_at ?? null),
      checkInDue: checkIn.checkInDue,
      checkInDueAt: checkIn.checkInDueAt,
      lastReport: newest === null ? null : installationReportObject(newest),
    },
  };
}

/** GET /api/companies/{companyId}/releases?state=<state>&cursor=<release id> (design 3.4): the releases of the company the
    caller may read, in id order, 50 a page. An unknown state or a malformed cursor is E_BODY_INVALID; a caller who is
    not an active member of the company is E_NOT_FOUND. */
export async function listReleases(session, { companyId, query = {} }, options) {
  const state = Object.hasOwn(query, 'state') ? query.state : undefined;
  if (state !== undefined && !RELEASE_STATES.includes(state)) throw invalid();
  const cursor = Object.hasOwn(query, 'cursor') ? query.cursor : undefined;
  if (cursor !== undefined && !isUuid(cursor)) throw invalid();
  const principal = await loadPrincipal(session, companyId, options);
  if (!principal.ok) throw new AppError(principal.code);
  const params = {
    select: RELEASE_COLUMNS,
    company_id: `eq.${companyId}`,
    order: 'id.asc',
    limit: String(LIST_PAGE + 1),
  };
  if (state !== undefined) params.state = `eq.${state}`;
  if (cursor !== undefined) params.id = `gt.${cursor}`;
  const [rows, registers] = await Promise.all([
    select(session, 'releases', params, options),
    readRegisters(session, options),
  ]);
  const page = rows.slice(0, LIST_PAGE);
  return {
    ok: true,
    releases: page.map((r) => releaseObject(r, registers)),
    nextCursor: rows.length > LIST_PAGE ? page[page.length - 1].id : null,
  };
}
