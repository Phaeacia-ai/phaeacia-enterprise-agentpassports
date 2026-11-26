/* Review services (E4 design 1.1, 1.2, 3.3 to 3.5 and 4.1): the review queue, the review read, proposing an envelope and
   recording a sign-off or a change request. Results are plain data; failures are AppErrors.

   A write meets its refusals in the order of design 3.5, and each service step sits where that table puts it:
     row 10   the Idempotency-Key header; row 11 the body's shape and, for a review, the reason rule; nothing is read;
     row 12   the candidate, and a named envelope of it, read under the caller's own token, so row level security decides:
              unknown, foreign, stale and invisible all answer E_NOT_FOUND;
     row 12a  createEnvelope only (E4D-C-F2, settled with the lead 2026-09-15): a candidate read as a draft is 409
              E_NOT_REVIEWABLE before the replay, so the replayed bytes are frozen and are the bytes the routine locks and
              copies. It precedes the claim lookup safely: a create_envelope claim is written only by a creation on a
              submitted or approved candidate, and no candidate returns to draft. The one answer that differs from the
              routine's is a key reused from another operation on a draft (E_NOT_REVIEWABLE, not E_IDEMPOTENCY_CONFLICT);
     rows 13 and 14  the replay of 1.1 (lib/passport/packet.mjs replayStored) before every envelope creation and every
              approval: E_GATE_FAILS_NOW or E_DERIVED_CHANGED before any call, so a replay of such a request never reaches
              its claim (the accepted residual of 3.3, as E3 4.5 row 18);
     row 14a  createEnvelope: the projected assembly for the target under this build's active identity, counted without
              building it, above 393,216 bytes is E_ASSEMBLY_TOO_LARGE before any hash of it (E4D-C-F3);
     rows 15 on  the routine, through callBound with this build's GATE_IDENTITY_SHA256.
   Beyond row 12a nothing here reads a state, a role or a claim to refuse early: those are the routine's, after its claim
   lookup (E3 4.3, H1). The reads assemble design 3.4's objects from the views, each read bounded by a derived ceiling
   (design 6) and refusing E_READ_OVER_BOUND above it; every may* and verdict field is a hint and grants nothing. */

import { callBound } from '../db/server.mjs';
import { select } from '../db/user.mjs';
import { AppError } from '../errors.mjs';
import { BRANCHES } from '../passport/assemble.mjs';
import { canonical } from '../passport/canonical.mjs';
import { GATE_IDENTITY_SHA256 } from '../passport/gate-manifest.mjs';
import { ASSEMBLED_BYTES_MAX, lossRows, projectedAssembledBytes, replayStored } from '../passport/packet.mjs';
import { REVIEW_DECISIONS, REVIEW_ROLES, reviewReasonOf, uuidOf, viewerVerdict } from '../rules/reviews.mjs';
import { EXCLUDING_KINDS } from '../rules/reviews.mjs';
import { readCandidate } from './candidates.mjs';
import { listGroups } from './directory.mjs';
import * as evidence from './evidence-reads.mjs';
import { isUuid, loadPrincipal } from './principal.mjs';

const { ENVELOPE_COLUMNS, RELEASE_COLUMNS, REVIEW_COLUMNS, envelopeObject, readAll, readAllByKey, readRegisters } =
  evidence;
const { releaseObject, reviewObject } = evidence;

/* app.release_target_names() is assemble.mjs BRANCHES (tests/e4/unit/vocabulary.test.mjs). */
const TARGETS = BRANCHES;
const AUDIENCE_MAX = 20;
const QUEUE_PAGE = 50;
/* Derived bounds (design 6): app.limit_envelopes_per_candidate() = 20; at most two approvals and one change request per
   envelope plus one candidate-level change request, 20 x 3 + 1 = 61 reviews; app.limit_versions_per_agent() = 200. */
const ENVELOPES_PER_CANDIDATE = 20;
const REVIEWS_PER_CANDIDATE = 61;
const VERSIONS_PER_AGENT = 200;
/* No limit bounds the releases of one agent (a withdrawn envelope may be published again): a fixed ceiling, recorded as a
   debt in evidence/e4-server.md. Current releases are bounded: one per agent and target. */
const RELEASES_PER_AGENT = 1000;
const CURRENT_RELEASES_PER_CANDIDATE = TARGETS.length;
/* The review screen's agent history (Q5 as answered 2026-09-15: history, not exclusion): the distinct (membership, kind)
   pairs of one agent's contributors. Four kinds carry a membership, so at most four per membership. Read in keyset pages
   on membership_id (readAllByKey), because PostgREST answers at most max_rows (200) per read and a 201st sentinel row
   never arrives (E4S-C-F1); above HISTORY_ROWS the read refuses (design 6, the plan's 25 users; E4S-F11). */
const HISTORY_ROWS = 200;
const HISTORY_NEWEST = 10;

const invalid = () => new AppError('E_BODY_INVALID');
const replayed = (stored) => (stored.idempotent_replay === true ? { idempotentReplay: true } : {});
const inList = (ids) => `in.(${ids.join(',')})`;

/* ---------- rows 10 and 11: decided without the database ---------- */

function idempotencyKeyOf(value) {
  const key = uuidOf(value);
  if (key === null) throw new AppError('E_IDEMPOTENCY_KEY_INVALID');
  return key;
}

function objectWithKeys(body, allowed) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid();
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw invalid();
}

/** The envelope request (3.5 envelope row 11): the audience sorted, deduplicated and rendered as the canonical text the
    routine binds and requires. */
function envelopeRequestOf(body) {
  objectWithKeys(body, ['target', 'audienceGroupIds', 'policyId']);
  if (!TARGETS.includes(body.target)) throw invalid();
  const ids = body.audienceGroupIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > AUDIENCE_MAX) throw invalid();
  const lower = ids.map(uuidOf);
  if (lower.includes(null) || new Set(lower).size !== lower.length) throw invalid();
  const policyId = uuidOf(body.policyId);
  if (policyId === null) throw invalid();
  return { target: body.target, audienceCanonical: canonical({ group_ids: [...lower].sort() }), policyId };
}

/** The review request (3.5 review row 11): the trimmed reason is what is bound and stored (E3A-R-D1's pattern). */
function reviewRequestOf(body) {
  objectWithKeys(body, ['envelopeId', 'role', 'decision', 'reason']);
  if (!REVIEW_ROLES.includes(body.role) || !REVIEW_DECISIONS.includes(body.decision)) throw invalid();
  let envelopeId = null;
  if (body.envelopeId !== undefined && body.envelopeId !== null) {
    envelopeId = uuidOf(body.envelopeId);
    if (envelopeId === null) throw invalid();
  }
  if (body.decision === 'approved' && envelopeId === null) throw invalid();
  const reason = reviewReasonOf(body.reason);
  if (!reason.ok) throw invalid();
  return { envelopeId, role: body.role, decision: body.decision, reason: reason.value };
}

/* ---------- row 12 on: under the caller's own token ---------- */

async function readableCandidate(session, candidateId, columns, options) {
  if (!isUuid(candidateId)) throw new AppError('E_NOT_FOUND');
  const rows = await select(session, 'candidate_versions', { select: columns, id: `eq.${candidateId}` }, options);
  if (rows.length !== 1) throw new AppError('E_NOT_FOUND');
  return rows[0];
}

function replayOrRefuse(row) {
  const verdict = replayStored({ content: row.content, derivedCanonical: row.derived_canonical });
  if (!verdict.ok) throw new AppError(verdict.code);
}

/* The id of this build's identity when it is the active registration; null otherwise, when the routine refuses. */
async function activeGateOfThisBuild(session, options) {
  const rows = await select(session, 'gate_identities', { select: 'id,identity_sha256', active: 'is.true' }, options);
  return rows.length === 1 && evidence.hexOf(rows[0].identity_sha256) === GATE_IDENTITY_SHA256 ? rows[0].id : null;
}

function storedWith(answer, field) {
  if (typeof answer !== 'object' || answer === null || typeof answer[field] !== 'string')
    throw new AppError('E_INTERNAL');
  return answer;
}

async function envelopeById(session, envelopeId, options) {
  const [rows, reviews, registers] = await Promise.all([
    select(session, 'review_envelopes', { select: ENVELOPE_COLUMNS, id: `eq.${envelopeId}` }, options),
    readAll(session, 'reviews', { select: REVIEW_COLUMNS, envelope_id: `eq.${envelopeId}` }, 3, options),
    readRegisters(session, options),
  ]);
  if (rows.length !== 1) throw new AppError('E_NOT_FOUND');
  return envelopeObject(rows[0], reviews, registers);
}

/** POST /api/candidates/{candidateId}/envelopes (design 1.1, 3.4). { ok, envelope, existing }; a replay is the stored
    answer's envelope with idempotentReplay. The route answers 201, or 200 when existing. */
export async function createEnvelope(session, { candidateId, idempotencyKey, body }, options) {
  const key = idempotencyKeyOf(idempotencyKey);
  const request = envelopeRequestOf(body);
  const row = await readableCandidate(session, candidateId, 'id,state,content,derived_canonical', options);
  if (row.state === 'draft') throw new AppError('E_NOT_REVIEWABLE');
  replayOrRefuse(row);
  const gateId = await activeGateOfThisBuild(session, options);
  if (gateId !== null) {
    const texts = await select(
      session,
      'installer_texts',
      { select: 'text', gate_id: `eq.${gateId}`, target: `eq.${request.target}` },
      options,
    );
    if (texts.length === 1 && projectedAssembledBytes(row.content, texts[0].text) > ASSEMBLED_BYTES_MAX)
      throw new AppError('E_ASSEMBLY_TOO_LARGE');
  }
  const stored = storedWith(
    await callBound(
      session,
      'create_envelope',
      {
        candidate_id: candidateId,
        target: request.target,
        audience_canonical: request.audienceCanonical,
        policy_id: request.policyId,
        gate_identity: GATE_IDENTITY_SHA256,
        idempotency_key: key,
      },
      options,
    ),
    'envelope_id',
  );
  return {
    ok: true,
    envelope: await envelopeById(session, stored.envelope_id, options),
    existing: stored.existing === true,
    ...replayed(stored),
  };
}

/** POST /api/candidates/{candidateId}/reviews (design 1.2, 3.4). { ok, review, candidateState, envelopeStatus }. */
export async function recordReview(session, { candidateId, idempotencyKey, body }, options) {
  const key = idempotencyKeyOf(idempotencyKey);
  const request = reviewRequestOf(body);
  const approval = request.decision === 'approved';
  const row = await readableCandidate(session, candidateId, approval ? 'id,content,derived_canonical' : 'id', options);
  if (request.envelopeId !== null) {
    const rows = await select(
      session,
      'review_envelopes',
      { select: 'id', id: `eq.${request.envelopeId}`, candidate_id: `eq.${candidateId}` },
      options,
    );
    if (rows.length !== 1) throw new AppError('E_NOT_FOUND');
  }
  if (approval) replayOrRefuse(row);
  const stored = storedWith(
    await callBound(
      session,
      'record_review',
      {
        candidate_id: candidateId,
        envelope_id: request.envelopeId,
        role: request.role,
        decision: request.decision,
        reason: request.reason,
        gate_identity: GATE_IDENTITY_SHA256,
        idempotency_key: key,
      },
      options,
    ),
    'review_id',
  );
  const reviews = await select(session, 'reviews', { select: REVIEW_COLUMNS, id: `eq.${stored.review_id}` }, options);
  if (reviews.length !== 1) throw new AppError('E_NOT_FOUND');
  return {
    ok: true,
    review: reviewObject(reviews[0]),
    candidateState: stored.candidate_state,
    envelopeStatus: stored.envelope_status ?? null,
    ...replayed(stored),
  };
}

/* ---------- the two reads ---------- */

const approvedRolesOf = (reviews, envelopeId) =>
  [
    ...new Set(reviews.filter((r) => r.envelope_id === envelopeId && r.decision === 'approved').map((r) => r.role)),
  ].sort();

/** GET /api/companies/{companyId}/review-queue (design 3.4): the company's submitted candidates the caller may read,
    oldest submission first, and the envelopes of approved candidates that are open or approved without a current
    release, each list at most 50, truncated when either reached its bound. */
export async function readReviewQueue(session, { companyId }, options) {
  const principal = await loadPrincipal(session, companyId, options);
  if (!principal.ok) throw new AppError(principal.code);
  const [submitted, approved, registers] = await Promise.all([
    select(
      session,
      'candidate_versions',
      {
        select: 'id,agent_id,sequence,state,submitted_at,author_membership_id,gate_id',
        company_id: `eq.${companyId}`,
        state: 'eq.submitted',
        order: 'submitted_at.asc,id.asc',
        limit: String(QUEUE_PAGE + 1),
      },
      options,
    ),
    select(
      session,
      'candidate_versions',
      {
        select: 'id,agent_id,sequence',
        company_id: `eq.${companyId}`,
        state: 'eq.approved',
        order: 'id.asc',
        limit: String(QUEUE_PAGE + 1),
      },
      options,
    ),
    readRegisters(session, options),
  ]);
  const awaiting = submitted.slice(0, QUEUE_PAGE);
  const approvedPage = approved.slice(0, QUEUE_PAGE);
  const candidates = [...awaiting, ...approvedPage];
  const ids = candidates.map((c) => c.id);
  const agentIds = [...new Set(candidates.map((c) => c.agent_id))];
  const approvedIds = approvedPage.map((c) => c.id);
  const none = Promise.resolve([]);
  const awaitingIds = awaiting.map((c) => c.id);
  const [envelopes, reviews, agents, viewerRows, releases] = await Promise.all([
    ids.length === 0
      ? none
      : readAll(
          session,
          'review_envelopes',
          { select: 'id,candidate_id,revision,target,status,gate_id,policy_id', candidate_id: inList(ids) },
          ids.length * ENVELOPES_PER_CANDIDATE,
          options,
        ),
    ids.length === 0
      ? none
      : readAll(
          session,
          'reviews',
          { select: 'id,envelope_id,role,decision', candidate_id: inList(ids) },
          ids.length * REVIEWS_PER_CANDIDATE,
          options,
        ),
    agentIds.length === 0 ? none : select(session, 'agents', { select: 'id,name', id: inList(agentIds) }, options),
    /* The viewer's own contributor rows on each candidate awaiting decision, inherited ones included: the independence
       set of row 22 (Q5 as answered 2026-09-15). The unique (candidate, kind, membership) key bounds one membership to
       one row per kind that carries a membership. */
    awaitingIds.length === 0
      ? none
      : readAll(
          session,
          'candidate_contributors',
          {
            select: 'id,candidate_id,kind,membership_id',
            candidate_id: inList(awaitingIds),
            membership_id: `eq.${principal.membershipId}`,
          },
          awaitingIds.length * EXCLUDING_KINDS.length,
          options,
        ),
    approvedIds.length === 0
      ? none
      : readAll(
          session,
          'releases',
          {
            select: 'id,envelope_id',
            candidate_id: inList(approvedIds),
            state: 'eq.published',
            superseded_by_release_id: 'is.null',
          },
          approvedIds.length * CURRENT_RELEASES_PER_CANDIDATE,
          options,
        ),
  ]);
  const nameOf = new Map(agents.map((a) => [a.id, a.name]));
  const current = new Set(releases.map((r) => r.envelope_id));
  const policyStatus = (e) => (registers.policies.get(e.policy_id)?.active === true ? 'current' : 'stale');
  const gateStatus = (gateId) => (gateId === registers.activeGateId ? 'current' : 'stale');
  const byRevision = (a, b) => a.revision - b.revision;
  const awaitingDecision = awaiting.map((c) => ({
    candidateId: c.id,
    agentId: c.agent_id,
    agentName: nameOf.get(c.agent_id) ?? null,
    sequence: c.sequence,
    state: c.state,
    submittedAt: evidence.isoOf(c.submitted_at),
    authorMembershipId: c.author_membership_id,
    gateStatus: gateStatus(c.gate_id),
    viewerExcluded: viewerVerdict({
      membershipId: principal.membershipId,
      roles: principal.roles,
      contributors: viewerRows
        .filter((x) => x.candidate_id === c.id)
        .map((x) => ({ membershipId: x.membership_id, kind: x.kind })),
    }).excluded,
    envelopes: envelopes
      .filter((e) => e.candidate_id === c.id)
      .sort(byRevision)
      .map((e) => ({
        envelopeId: e.id,
        revision: e.revision,
        target: e.target,
        status: e.status,
        approvedRoles: approvedRolesOf(reviews, e.id),
        gateStatus: gateStatus(e.gate_id),
        policyStatus: policyStatus(e),
      })),
  }));
  const open = [];
  for (const c of approvedPage) {
    for (const e of envelopes.filter((x) => x.candidate_id === c.id).sort(byRevision)) {
      const hasCurrentRelease = current.has(e.id);
      if (e.status !== 'open' && !(e.status === 'approved' && !hasCurrentRelease)) continue;
      open.push({
        candidateId: c.id,
        agentId: c.agent_id,
        agentName: nameOf.get(c.agent_id) ?? null,
        sequence: c.sequence,
        envelopeId: e.id,
        revision: e.revision,
        target: e.target,
        status: e.status,
        approvedRoles: approvedRolesOf(reviews, e.id),
        hasCurrentRelease,
      });
    }
  }
  return {
    ok: true,
    companyId,
    awaitingDecision,
    openEnvelopes: open.slice(0, QUEUE_PAGE),
    truncated: submitted.length > QUEUE_PAGE || approved.length > QUEUE_PAGE || open.length > QUEUE_PAGE,
  };
}

/** GET /api/candidates/{candidateId}/review (design 3.4 and 4.1): what the review screen reads, for a reader of the
    candidate (E3 4.1); E_NOT_FOUND for anyone else. */
export async function readReview(session, { candidateId }, options) {
  const { candidate, contributors } = await readCandidate(session, { candidateId }, options);
  const principal = await loadPrincipal(session, candidate.companyId, options);
  if (!principal.ok) throw new AppError(principal.code);
  const [envelopeRows, reviewRows, releaseRows, versions, agents, history, registers, targets, groups] =
    await Promise.all([
      readAll(
        session,
        'review_envelopes',
        { select: ENVELOPE_COLUMNS, candidate_id: `eq.${candidate.candidateId}` },
        ENVELOPES_PER_CANDIDATE,
        options,
      ),
      readAll(
        session,
        'reviews',
        { select: REVIEW_COLUMNS, candidate_id: `eq.${candidate.candidateId}` },
        REVIEWS_PER_CANDIDATE,
        options,
      ),
      readAll(
        session,
        'releases',
        { select: RELEASE_COLUMNS, agent_id: `eq.${candidate.agentId}` },
        RELEASES_PER_AGENT,
        options,
      ),
      readAll(
        session,
        'candidate_versions',
        { select: 'id,sequence,state,author_membership_id', agent_id: `eq.${candidate.agentId}` },
        VERSIONS_PER_AGENT,
        options,
      ),
      select(session, 'agents', { select: 'id,name', id: `eq.${candidate.agentId}` }, options),
      readAllByKey(
        session,
        'agent_reviewer_exclusions',
        { select: 'membership_id,kind', agent_id: `eq.${candidate.agentId}` },
        'membership_id',
        HISTORY_ROWS,
        options,
      ),
      readRegisters(session, options),
      select(session, 'release_targets', { select: 'target,publishable', order: 'target.asc' }, options),
      listGroups(session, candidate.companyId),
    ]);
  /* Row 22's set is the candidate's own contributor rows, inherited ones included; the agent-wide history is shown, never
     used to exclude (Q5 as answered 2026-09-15). */
  const verdict = viewerVerdict({ membershipId: principal.membershipId, roles: principal.roles, contributors });
  const rows = lossRows(candidate.content);
  const sequenceOf = new Map(versions.map((v) => [v.id, v.sequence]));
  const referenced = new Set(releaseRows.map((r) => r.candidate_id));
  const newest = [...versions].sort((a, b) => b.sequence - a.sequence);
  const shown = newest.filter((v, i) => i < HISTORY_NEWEST || referenced.has(v.id));
  const published = releaseRows
    .filter((r) => r.state === 'published')
    .map((r) => sequenceOf.get(r.candidate_id))
    .filter((s) => Number.isInteger(s));
  const reviewable = candidate.state === 'submitted' || candidate.state === 'approved';
  return {
    ok: true,
    candidate,
    contributors,
    losses: { state: rows.length > 0 ? 'declared' : 'pending', rows },
    viewer: {
      membershipId: principal.membershipId,
      roles: principal.roles,
      aal: session.aal,
      excluded: verdict.excluded,
      exclusionKinds: verdict.exclusionKinds,
      mayApproveAs: reviewable ? verdict.mayApproveAs : [],
      mayRequestChangesAs: reviewable ? verdict.mayRequestChangesAs : [],
      mayProposeEnvelope: reviewable,
      mayPublish: principal.roles.includes('company_admin') && session.aal === 'aal2',
    },
    envelopes: [...envelopeRows]
      .sort((a, b) => b.revision - a.revision)
      .map((e) => envelopeObject(e, reviewRows, registers)),
    reviews: reviewRows.map(reviewObject),
    releases: releaseRows
      .filter((r) => r.candidate_id === candidate.candidateId)
      .map((r) => releaseObject(r, registers)),
    agentHistory: {
      agentName: agents[0]?.name ?? null,
      newestPublishedSequence: published.length > 0 ? Math.max(...published) : null,
      candidates: shown.map((v) => ({
        candidateId: v.id,
        sequence: v.sequence,
        state: v.state,
        authorMembershipId: v.author_membership_id,
      })),
      olderCount: versions.length - shown.length,
      contributorMembershipIds: [...new Set(history.map((x) => x.membership_id))].sort(),
    },
    options: {
      targets: targets.map((t) => ({ target: t.target, publishable: t.publishable === true })),
      policy: registers.activePolicy
        ? {
            policyId: registers.activePolicy.policyId,
            version: registers.activePolicy.version,
            sha256: registers.activePolicy.sha256,
          }
        : null,
      groups: groups.groups.map((g) => ({ groupId: g.groupId, name: g.name, memberCount: g.memberIds.length })),
      groupsTruncated: groups.truncated,
    },
  };
}
