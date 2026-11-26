/* Candidate content services (E3 design 1.3, 1.4, 3.8 and 4.1 to 4.5): create, save, submit, successor, read one,
   list, and the gate read. Results are plain data; failures are AppErrors, and a gate refusal is a PassportRefused
   carrying its { code, line } list as its data (design 3.5).

   A write meets its refusals in the order of design 4.5, and each step sits where it does for a reason:
     row 10  the Idempotency-Key header, then If-Match on save and submit, then the shape of what the caller sent;
             nothing is read before these, and none needs the database to decide;
     row 11  standing, read under the caller's own token so RLS decides (4.1): the membership in the route's
             company for a create (principal.mjs), then a named agent inside that company; the candidate itself for
             a save, a submit or a successor. Unknown, foreign, stale and invisible all answer E_NOT_FOUND;
     rows 12 to 17  the gate on the exact bytes: the request's Buffer for a create or a save, handed on undecoded;
             the stored text for a submit or a successor. One validatedAt per request;
     row 18  submit and successor only: stored bytes the active gate no longer passes are E_GATE_FAILS_NOW, before
             any call, so a replay of such a request never reaches its claim (the residual 4.3 accepts);
     rows 19 to 33  the routine, through callBound, which binds the bearer to exactly this call and passes this
             server's GATE_IDENTITY_SHA256 (3.8).
   Nothing here reads a state, a version, an author, a quota or a claim to refuse early. Those are fresh-only
   preconditions the routine decides after its claim lookup, and a replay must reach that lookup (4.3, H1); a guess
   here would turn an honest retry into a refusal. The shapes refused here are exactly the routine's, so no request
   the routine would accept is refused, with one stated exception: a declared display name is trimmed and a
   whitespace-only one refused (E3A-R-D1, evidence/e3a-recheck.md), defense in depth until migration 004 adds the
   same rule at the routine.

   What the responses hold that the routine does not return: `derived` and `lossesPresent` come from this request's
   gate run over the same bytes (a replay's operation digest covers the content, so they describe the stored row
   except for validated_at, which comes from the stored answer); a fresh write's attestation components are this
   server's manifest constants, which the routine has just accepted as the active identity; a replay's are read from
   the registry, because the identity may have rotated since the first attempt (case 35). lossesPresent is the
   renderer's one reading of section 6 (lib/passport/render.mjs lossesState), a presentation value outside the gate
   identity and never an attestation. */

import { callBound } from '../db/server.mjs';
import { select } from '../db/user.mjs';
import { AppError } from '../errors.mjs';
import { canonical } from '../passport/canonical.mjs';
import { gate } from '../passport/gate.mjs';
import * as manifest from '../passport/gate-manifest.mjs';
import { lossesState } from '../passport/render.mjs';
import { contributorsOf, hexOf, isoOf, REGISTRY_CEILING, readAll, registryEntry } from './evidence-reads.mjs';
import { isUuid, loadPrincipal } from './principal.mjs';

/* scripts/check-imports.mjs accepts a module reference only on one line, and the four names do not fit on one. */
const { ADAPTER_LOCK_SHA256, GATE_IDENTITY_SHA256, MANIFEST_SHA256, VALIDATOR_VERSION } = manifest;

const ANY_CASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/* app.agents.name and api.create_draft's own refusal. */
const AGENT_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const DECIMAL = /^-?(0|[1-9][0-9]*)$/;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
/* Built from its code point: scripts/check-imports.mjs refuses escape sequences under lib/. */
const NUL = String.fromCharCode(0);

/* app.candidate_states() and the confidence CHECK of 003_content.sql; tests/e3/stack/routes.test.mjs compares
   both with the database through the list route and the submit route. */
const CANDIDATE_STATES = Object.freeze(['draft', 'submitted', 'changes_requested', 'approved', 'superseded']);
const CONFIDENCE = Object.freeze(['high', 'medium', 'low']);

/* The API's submission names and the names app.submission_fields reads. */
const SUBMISSION_KEYS = Object.freeze({
  sourcePlatform: 'source_platform',
  confidence: 'confidence',
  permittedData: 'permitted_data',
  dependencies: 'dependencies',
  declaredContributors: 'declared_contributors',
});

const LIST_PAGE = 50;
/* The paged-read bound, the contributor ceiling and the registry ceiling live with readAll and contributorsOf in
   lib/services/evidence-reads.mjs (E4 design 2.1), which this module and the review services share. */
const GATE_COLUMNS =
  'id,identity_sha256,adapter_lock_sha256,validator_version,manifest_sha256,upstream_commit,registered_at,active';
const CANDIDATE_COLUMNS =
  'id,company_id,agent_id,sequence,state,version,author_membership_id,supersedes_candidate_id,content,content_sha256,derived,derived_sha256,gate_id,validated_at,attested_by,attested_at,submitted_at,submitted_by_membership_id,source_platform,confidence,permitted_data,dependencies';
const LIST_COLUMNS =
  'id,agent_id,sequence,state,version,author_membership_id,supersedes_candidate_id,content_sha256,derived_sha256,gate_id,validated_at,submitted_at';

/** A gate refusal (design 3.5): the first problem's code, and every problem as { code, line } (and kind, for
    E_SECRET_FOUND, from the pinned closed vocabulary) in its AppError data, which the pipeline's boundary appends to
    the answer as `problems`. Never the offending text. */
export class PassportRefused extends AppError {
  constructor(verdict) {
    super(verdict.code, undefined, { problems: verdict.problems });
    this.name = 'PassportRefused';
  }
}

/* ---------- row 10 and the request's own shape: decided without the database ---------- */

/* Idempotency-Key: a uuid in either case, lowercased. Anything else, absence included, is E_IDEMPOTENCY_KEY_INVALID. */
function idempotencyKeyOf(value) {
  if (typeof value !== 'string' || !ANY_CASE_UUID.test(value)) throw new AppError('E_IDEMPOTENCY_KEY_INVALID');
  return value.toLowerCase();
}

/* If-Match: a plain decimal integer that fits the routine's integer parameter. Anything else, absence and a quoted
   entity tag included, is 428 E_VERSION_REQUIRED. A value the routine would accept is not refused here: 0 or a
   negative number reaches it and meets E_VERSION_CONFLICT. */
function expectedVersionOf(value) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new AppError('E_VERSION_REQUIRED');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < INT32_MIN || n > INT32_MAX) throw new AppError('E_VERSION_REQUIRED');
  return n;
}

/* X-Agent-Id or X-Agent-Name, exactly one (design 4.4). Neither or both, and a name outside the slug grammar, are
   E_BODY_INVALID, the routine's own answer; an id that is not a uuid names no agent, so it is E_NOT_FOUND, as a
   malformed route id is. */
function agentOf(agentId, agentName) {
  const hasId = typeof agentId === 'string';
  const hasName = typeof agentName === 'string';
  if (hasId === hasName) throw new AppError('E_BODY_INVALID');
  if (hasName) {
    if (!AGENT_NAME.test(agentName)) throw new AppError('E_BODY_INVALID');
    return { agent_name: agentName };
  }
  if (!ANY_CASE_UUID.test(agentId)) throw new AppError('E_NOT_FOUND');
  return { agent_id: agentId.toLowerCase() };
}

/* PostgreSQL's length() counts characters, and a JSON string holding NUL or a lone surrogate never becomes jsonb. */
function textWithin(value, min, max) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes(NUL)) return false;
  const n = [...value].length;
  return n >= min && n <= max;
}

/** The submission metadata of design 4.4 as the canonical JSON text api.submit_candidate reads and binds. Refuses,
    with E_BODY_INVALID, exactly what app.submission_fields refuses: a key outside the five, a missing or
    out-of-range source platform, confidence or permitted data, more than 40 dependencies or one outside 1 to 200
    characters, more than 50 declarations, and a declaration that is not one object with exactly one of a lowercase
    membership uuid or a name of 1 to 120 characters. And one thing more (E3A-R-D1): each display name is trimmed
    of ECMAScript white space and line terminators, and the trimmed name is what is bound, stored and length
    checked, so a whitespace-only name is refused. Case is never changed. */
export function submissionOf(body) {
  const invalid = () => new AppError('E_BODY_INVALID');
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid();
  for (const key of Object.keys(body)) if (!Object.hasOwn(SUBMISSION_KEYS, key)) throw invalid();
  const out = {};
  if (!textWithin(body.sourcePlatform, 1, 80)) throw invalid();
  out.source_platform = body.sourcePlatform;
  if (!CONFIDENCE.includes(body.confidence)) throw invalid();
  out.confidence = body.confidence;
  if (!textWithin(body.permittedData, 1, 2000)) throw invalid();
  out.permitted_data = body.permittedData;
  if (Object.hasOwn(body, 'dependencies')) {
    const list = body.dependencies;
    if (!Array.isArray(list) || list.length > 40 || !list.every((d) => textWithin(d, 1, 200))) throw invalid();
    out.dependencies = [...list];
  }
  if (Object.hasOwn(body, 'declaredContributors')) {
    const list = body.declaredContributors;
    if (!Array.isArray(list) || list.length > 50) throw invalid();
    out.declared_contributors = list.map((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw invalid();
      const keys = Object.keys(entry);
      if (keys.length !== 1) throw invalid();
      if (keys[0] === 'membershipId') {
        if (typeof entry.membershipId !== 'string' || !LOWER_UUID.test(entry.membershipId)) throw invalid();
        return { membership_id: entry.membershipId };
      }
      if (keys[0] === 'displayName' && typeof entry.displayName === 'string') {
        const name = entry.displayName.trim();
        if (!textWithin(name, 1, 120)) throw invalid();
        return { display_name: name };
      }
      throw invalid();
    });
  }
  return canonical(out);
}

function emptyObject(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).length > 0)
    throw new AppError('E_BODY_INVALID');
}

/* ---------- row 11: standing under the caller's own token ---------- */

async function visibleCandidate(session, candidateId, columns, options) {
  if (!isUuid(candidateId)) throw new AppError('E_NOT_FOUND');
  const rows = await select(session, 'candidate_versions', { select: columns, id: `eq.${candidateId}` }, options);
  if (rows.length !== 1) throw new AppError('E_NOT_FOUND');
  return rows[0];
}

async function requireMember(session, companyId, options) {
  const principal = await loadPrincipal(session, companyId, options);
  if (!principal.ok) throw new AppError(principal.code);
}

/* ---------- rows 12 to 18: the gate ---------- */

function gateReceived(bytes, contentType, validatedAt) {
  const verdict = gate(bytes, contentType, { validatedAt });
  if (!verdict.ok) throw new PassportRefused(verdict);
  return verdict;
}

/* The stored text is canonical by construction, so the gate's transport must hand it back unchanged: a verdict about
   other bytes is not a verdict about these. The content hash bound to the call is therefore the stored bytes' own. */
function regateStored(content, validatedAt) {
  if (typeof content !== 'string') throw new AppError('E_INTERNAL');
  const verdict = gate(Buffer.from(content, 'utf8'), 'text/markdown', { validatedAt });
  if (!verdict.ok || verdict.text !== content) throw new AppError('E_GATE_FAILS_NOW');
  return verdict;
}

/* ---------- mapping database answers ---------- */

function storedOf(answer) {
  if (typeof answer !== 'object' || answer === null || typeof answer.candidate_id !== 'string')
    throw new AppError('E_INTERNAL');
  return answer;
}

/* Every component comes from a registry entry or this build's constants; there is no null form (E3b critique F2). */
function attestationOf(identity, validatedAt, entry, gateStatus) {
  return {
    gateIdentitySha256: identity,
    validatorVersion: entry.validatorVersion,
    adapterLockSha256: entry.adapterLockSha256,
    manifestSha256: entry.manifestSha256,
    validatedAt,
    gateStatus,
  };
}

/* ---------- complete reads: readAll and contributorsOf are lib/services/evidence-reads.mjs's ---------- */

/* The attestation a write answers with. A fresh write under this server's identity was just accepted by
   app.active_gate in the same transaction, so it is current and its components are this build's constants.

   A replay answers the stored result, and the stored identity hash is the fact (E3b critique F2). The candidate row's
   gate_id is not: a draft saved under another identity since the first attempt names that identity, and the routine
   answers the replay from its claim before it asks which identity is active. A window of the newest registrations is
   not either: an identity registered before it has no components in it. So the replay reads the whole registry and
   finds the stored identity and the active one in that one answer. Every active member sees every registration (4.1)
   and none is ever removed: a reader who sees none at all has lost standing since the call (E_NOT_FOUND), and a
   stored identity missing from a visible registry is a defect (E_INTERNAL, logged at the boundary). */
async function writeAttestation(session, stored, options) {
  const identity = stored.gate_identity_sha256;
  if (stored.idempotent_replay !== true && identity === GATE_IDENTITY_SHA256) {
    const constants = {
      validatorVersion: VALIDATOR_VERSION,
      adapterLockSha256: ADAPTER_LOCK_SHA256,
      manifestSha256: MANIFEST_SHA256,
    };
    return attestationOf(identity, stored.validated_at, constants, 'current');
  }
  const rows = await readAll(session, 'gate_identities', { select: GATE_COLUMNS }, REGISTRY_CEILING, options);
  if (rows.length === 0) throw new AppError('E_NOT_FOUND');
  const entries = rows.map(registryEntry);
  const entry = entries.find((e) => e.gateIdentitySha256 === identity);
  const active = entries.filter((e) => e.active);
  if (entry === undefined || active.length > 1) throw new AppError('E_INTERNAL');
  const gateStatus = active.length === 1 && active[0].gateIdentitySha256 === identity ? 'current' : 'stale';
  return attestationOf(identity, stored.validated_at, entry, gateStatus);
}

function derivedSummary(record) {
  const needs = Array.isArray(record?.needs) ? record.needs : [];
  return {
    title: record?.title ?? null,
    summary: record?.summary ?? null,
    needs: needs.map((n) => ({ capability: n.capability, required: n.required, installable: n.installable })),
  };
}

const replayed = (stored) => (stored.idempotent_replay === true ? { idempotentReplay: true } : {});

async function draftAnswer(session, answer, verdict, options) {
  const stored = storedOf(answer);
  return {
    ok: true,
    candidateId: stored.candidate_id,
    agentId: stored.agent_id,
    sequence: stored.sequence,
    version: stored.version,
    state: stored.state,
    contentSha256: stored.content_sha256,
    derivedSha256: stored.derived_sha256,
    attestation: await writeAttestation(session, stored, options),
    derived: derivedSummary(verdict.derived),
    lossesPresent: lossesState(verdict.text, null) === 'declared',
    ...replayed(stored),
  };
}

/* ---------- the four writes ---------- */

/** POST /api/companies/{companyId}/candidates (design 4.4). 201 answer; a replay is the stored answer. */
export async function createCandidate(
  session,
  { companyId, agentId, agentName, idempotencyKey, contentType, bytes },
  options,
) {
  const key = idempotencyKeyOf(idempotencyKey);
  const agent = agentOf(agentId, agentName);
  await requireMember(session, companyId, options);
  if (agent.agent_id) {
    const rows = await select(
      session,
      'agents',
      { select: 'id', id: `eq.${agent.agent_id}`, company_id: `eq.${companyId}` },
      options,
    );
    if (rows.length !== 1) throw new AppError('E_NOT_FOUND');
  }
  const verdict = gateReceived(bytes, contentType, new Date().toISOString());
  const answer = await callBound(
    session,
    'create_draft',
    {
      company_id: companyId,
      ...agent,
      content: verdict.text,
      derived_canonical: verdict.derivedCanonical,
      gate_identity: GATE_IDENTITY_SHA256,
      idempotency_key: key,
    },
    options,
  );
  return draftAnswer(session, answer, verdict, options);
}

/** PUT /api/candidates/{candidateId} (design 4.4). 200 answer; a replay is the stored answer. */
export async function saveCandidate(session, { candidateId, idempotencyKey, ifMatch, contentType, bytes }, options) {
  const key = idempotencyKeyOf(idempotencyKey);
  const expectedVersion = expectedVersionOf(ifMatch);
  await visibleCandidate(session, candidateId, 'id', options);
  const verdict = gateReceived(bytes, contentType, new Date().toISOString());
  const answer = await callBound(
    session,
    'save_draft',
    {
      candidate_id: candidateId,
      expected_version: expectedVersion,
      content: verdict.text,
      derived_canonical: verdict.derivedCanonical,
      gate_identity: GATE_IDENTITY_SHA256,
      idempotency_key: key,
    },
    options,
  );
  return draftAnswer(session, answer, verdict, options);
}

/** POST /api/candidates/{candidateId}/submit (design 4.4). The body is the submission metadata; the content is the
    stored draft's, re-gated here and bound by its hash. */
export async function submitCandidate(session, { candidateId, idempotencyKey, ifMatch, body }, options) {
  const key = idempotencyKeyOf(idempotencyKey);
  const expectedVersion = expectedVersionOf(ifMatch);
  const submission = submissionOf(body);
  const row = await visibleCandidate(session, candidateId, 'id,content', options);
  const verdict = regateStored(row.content, new Date().toISOString());
  const stored = storedOf(
    await callBound(
      session,
      'submit_candidate',
      {
        candidate_id: candidateId,
        expected_version: expectedVersion,
        content_sha256: verdict.contentSha256,
        derived_canonical: verdict.derivedCanonical,
        submission_canonical: submission,
        gate_identity: GATE_IDENTITY_SHA256,
        idempotency_key: key,
      },
      options,
    ),
  );
  const [attestation, contributors] = await Promise.all([
    writeAttestation(session, stored, options),
    contributorsOf(session, stored.candidate_id, options),
  ]);
  return {
    ok: true,
    candidateId: stored.candidate_id,
    state: stored.state,
    version: stored.version,
    submittedAt: isoOf(stored.submitted_at),
    attestationFrozen: stored.state !== 'draft',
    attestation,
    contributors,
    ...replayed(stored),
  };
}

/** POST /api/candidates/{candidateId}/successor (design 1.4, 4.4). The body is an empty JSON object. The parent is
    read under the caller's token, its stored bytes re-gated here, and the fresh derived bytes bound to the call. */
export async function createSuccessor(session, { candidateId, idempotencyKey, body }, options) {
  const key = idempotencyKeyOf(idempotencyKey);
  emptyObject(body);
  const parent = await visibleCandidate(session, candidateId, 'id,content', options);
  const verdict = regateStored(parent.content, new Date().toISOString());
  const stored = storedOf(
    await callBound(
      session,
      'create_successor',
      {
        candidate_id: candidateId,
        content_sha256: verdict.contentSha256,
        derived_canonical: verdict.derivedCanonical,
        gate_identity: GATE_IDENTITY_SHA256,
        idempotency_key: key,
      },
      options,
    ),
  );
  return {
    ok: true,
    candidateId: stored.candidate_id,
    sequence: stored.sequence,
    state: stored.state,
    supersedesCandidateId: stored.supersedes_candidate_id,
    inheritedContributors: stored.inherited_contributors,
    attestation: await writeAttestation(session, stored, options),
    ...replayed(stored),
  };
}

/* ---------- the three reads ---------- */

async function activeGateId(session, options) {
  const rows = await select(session, 'gate_identities', { select: 'id', active: 'is.true' }, options);
  return rows.length === 1 ? rows[0].id : null;
}

/** GET /api/candidates/{candidateId}: what RLS lets the caller read (4.1), with content, contributors and the
    attestation of the identity that attested it; E_NOT_FOUND for anything else. */
export async function readCandidate(session, { candidateId }, options) {
  const row = await visibleCandidate(session, candidateId, CANDIDATE_COLUMNS, options);
  const [identityRows, activeId, contributors] = await Promise.all([
    select(session, 'gate_identities', { select: GATE_COLUMNS, id: `eq.${row.gate_id}` }, options),
    activeGateId(session, options),
    contributorsOf(session, row.id, options),
  ]);
  /* The row's own gate_id is its attestation, so this lookup is exact. That identity row always exists (a foreign key)
     and every active member sees the registry: when neither it nor an active row is visible, the reader lost standing
     mid-request (E_NOT_FOUND, 4.1); when only it is missing, a defect. Never null components (E3b critique F2). */
  if (identityRows.length !== 1) throw new AppError(activeId === null ? 'E_NOT_FOUND' : 'E_INTERNAL');
  const entry = registryEntry(identityRows[0]);
  const gateStatus = row.gate_id === activeId ? 'current' : 'stale';
  const validatedAt = isoOf(row.validated_at);
  return {
    ok: true,
    candidate: {
      candidateId: row.id,
      companyId: row.company_id,
      agentId: row.agent_id,
      sequence: row.sequence,
      state: row.state,
      version: row.version,
      authorMembershipId: row.author_membership_id,
      supersedesCandidateId: row.supersedes_candidate_id,
      contentSha256: hexOf(row.content_sha256),
      derivedSha256: hexOf(row.derived_sha256),
      derived: row.derived,
      lossesPresent: lossesState(row.content, null) === 'declared',
      attestation: attestationOf(entry.gateIdentitySha256, validatedAt, entry, gateStatus),
      attestedBy: row.attested_by,
      attestedAt: isoOf(row.attested_at),
      submittedAt: isoOf(row.submitted_at),
      submittedByMembershipId: row.submitted_by_membership_id,
      sourcePlatform: row.source_platform,
      confidence: row.confidence,
      permittedData: row.permitted_data,
      dependencies: row.dependencies,
      attestationFrozen: row.state !== 'draft',
      gateStatus,
      content: row.content,
    },
    contributors,
  };
}

/** GET /api/companies/{companyId}/candidates?state=<state>&cursor=<candidate id>: the candidates of the company the
    caller may read (4.1), without content, in candidate id order, at most LIST_PAGE per page. `nextCursor` is the
    last id of a full page when another page follows. An unknown state or a malformed cursor is E_BODY_INVALID; a
    caller who is not an active member of the company is E_NOT_FOUND. */
export async function listCandidates(session, { companyId, query = {} }, options) {
  const state = Object.hasOwn(query, 'state') ? query.state : undefined;
  if (state !== undefined && !CANDIDATE_STATES.includes(state)) throw new AppError('E_BODY_INVALID');
  const cursor = Object.hasOwn(query, 'cursor') ? query.cursor : undefined;
  if (cursor !== undefined && !isUuid(cursor)) throw new AppError('E_BODY_INVALID');
  await requireMember(session, companyId, options);
  const params = { select: LIST_COLUMNS, company_id: `eq.${companyId}`, order: 'id.asc', limit: String(LIST_PAGE + 1) };
  if (state !== undefined) params.state = `eq.${state}`;
  if (cursor !== undefined) params.id = `gt.${cursor}`;
  const [rows, activeId] = await Promise.all([
    select(session, 'candidate_versions', params, options),
    activeGateId(session, options),
  ]);
  const page = rows.slice(0, LIST_PAGE);
  return {
    ok: true,
    candidates: page.map((row) => ({
      candidateId: row.id,
      agentId: row.agent_id,
      sequence: row.sequence,
      state: row.state,
      version: row.version,
      authorMembershipId: row.author_membership_id,
      supersedesCandidateId: row.supersedes_candidate_id,
      contentSha256: hexOf(row.content_sha256),
      derivedSha256: hexOf(row.derived_sha256),
      validatedAt: isoOf(row.validated_at),
      submittedAt: isoOf(row.submitted_at),
      gateStatus: row.gate_id === activeId ? 'current' : 'stale',
    })),
    nextCursor: rows.length > LIST_PAGE ? page[page.length - 1].id : null,
  };
}

/** GET /api/gate (design 3.8, 4.4): the registered active identity with its files, this server's constant, and
    whether they agree. RLS shows the registry only to a reader holding an active membership in an active company
    (4.1, E3a F3), so a reader who sees no active row is E_NOT_FOUND. */
export async function readGate(session, options) {
  const rows = await select(session, 'gate_identities', { select: GATE_COLUMNS, active: 'is.true' }, options);
  if (rows.length === 0) throw new AppError('E_NOT_FOUND');
  if (rows.length > 1) throw new AppError('E_INTERNAL');
  const active = registryEntry(rows[0]);
  const files = await select(
    session,
    'gate_identity_files',
    { select: 'path,sha256', gate_id: `eq.${active.id}`, order: 'path.asc' },
    options,
  );
  return {
    ok: true,
    active: {
      gateIdentitySha256: active.gateIdentitySha256,
      adapterLockSha256: active.adapterLockSha256,
      validatorVersion: active.validatorVersion,
      manifestSha256: active.manifestSha256,
      upstreamCommit: active.upstreamCommit,
      registeredAt: active.registeredAt,
      files: files.map((f) => ({ path: f.path, sha256: hexOf(f.sha256) })),
    },
    server: { gateIdentitySha256: GATE_IDENTITY_SHA256 },
    agrees: active.gateIdentitySha256 === GATE_IDENTITY_SHA256,
  };
}
