/* Review rules (E4 design 1.1, 1.2, 1.7, 3.2 and 4.1), pure. Hints and early refusals: the database decides.

   Each rule has one SQL twin and a corpus shared with it under tests/e4/fixtures/. tests/e4/unit/reviews-rules.test.mjs
   runs the Node column here, and the probes run the SQL column against the database, so a change to one copy that the
   other does not make fails a test instead of drifting:
     envelopeStatus  app.envelope_status: a change request closes the envelope; both roles' approvals on that one
                     envelope approve it; otherwise it is open. Approvals on two envelopes never combine;
     viewerVerdict   api.record_review rows 21 and 22 of 3.5, per role: the role's reviewer role first, then independence
                     over the candidate's own contributor rows, inherited ones included (Q5 as answered 2026-09-15:
                     contributors of earlier candidates of the agent are history and exclude nobody). A declared offline
                     name carries no membership and excludes nobody (E3 1.4);
     reviewReasonOf  app.review_reason: String.prototype.trim(), which is migration 004's declared-name class (E3A-R-D1,
                     held over every code point by tests/e3/unit/migration-text.test.mjs), then 1 to 2,000 code points,
                     no C0 control other than tab and line feed, no DEL. U+0000 and a lone surrogate are refused here
                     because text cannot hold either and PostgREST would answer them with 500;
     groupNameOf     api.create_group's name rule (006 part A): trim U+0020 only, 1 to 80 code points, no C0 or C1
                     control and no Bidi_Control character. The shape of lib/rules/profiles.mjs with its own bound and its
                     own corpus, on purpose: another field with another consumer.
   Code points are compared as numbers, because lib/ refuses escape sequences in source. */

export const REVIEW_ROLES = Object.freeze(['it', 'business']);
export const REVIEW_DECISIONS = Object.freeze(['approved', 'changes_requested']);
export const REVIEWER_ROLE_OF = Object.freeze({ it: 'it_reviewer', business: 'business_reviewer' });
/* The contributor kinds that carry a membership id, in vocabulary order. */
export const EXCLUDING_KINDS = Object.freeze(['author', 'editor', 'submitter', 'declared_member']);
export const REASON_MAX_CODE_POINTS = 2000;
export const GROUP_NAME_MAX_CODE_POINTS = 80;

const INVALID = Object.freeze({ ok: false, code: 'E_BODY_INVALID' });
const ANY_CASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Inclusive ranges of refused code points. */
const REASON_REFUSED = Object.freeze([
  Object.freeze([0x0, 0x8]),
  Object.freeze([0xb, 0x1f]),
  Object.freeze([0x7f, 0x7f]),
]);
const NAME_REFUSED = Object.freeze([
  Object.freeze([0x0, 0x1f]),
  Object.freeze([0x7f, 0x9f]),
  Object.freeze([0x61c, 0x61c]),
  Object.freeze([0x200e, 0x200f]),
  Object.freeze([0x202a, 0x202e]),
  Object.freeze([0x2066, 0x2069]),
]);

const within = (ranges, point) => ranges.some(([low, high]) => point >= low && point <= high);

/**
 * uuidOf(value) -> the lowercase uuid, or null. The Idempotency-Key header and a body's ids take a uuid in either case,
 * as E3b's services take the header (evidence/e3b.md D5); the database compares the lowercase text.
 */
export function uuidOf(value) {
  return typeof value === 'string' && ANY_CASE_UUID.test(value) ? value.toLowerCase() : null;
}

/**
 * envelopeStatus(reviews) -> 'changes_requested' | 'approved' | 'open'
 * reviews: every review row of one envelope, as { role, decision }.
 */
export function envelopeStatus(reviews) {
  if (!Array.isArray(reviews)) throw new TypeError('envelopeStatus: reviews is not an array');
  if (reviews.some((r) => r?.decision === 'changes_requested')) return 'changes_requested';
  const approvedRoles = new Set(reviews.filter((r) => r?.decision === 'approved').map((r) => r.role));
  return approvedRoles.size === 2 ? 'approved' : 'open';
}

/**
 * viewerVerdict({ membershipId, roles, contributors })
 *   -> { excluded, exclusionKinds, refusals: { it, business }, mayApproveAs, mayRequestChangesAs }
 * contributors: the candidate's own contributor rows as the review read answers them, own and inherited through the
 * successor chain, [{ kind, membershipId?, displayName?, inheritedFromCandidateId? }]. Never the agent-wide history of
 * api.agent_reviewer_exclusions: an earlier candidate's contributor is not excluded. Each refusal is the code
 * api.record_review answers that viewer for that role, or null. Every field is a hint and grants nothing.
 */
export function viewerVerdict({ membershipId, roles, contributors }) {
  const held = Array.isArray(roles) ? roles : [];
  const rows = Array.isArray(contributors) ? contributors : [];
  const exclusionKinds =
    typeof membershipId === 'string'
      ? EXCLUDING_KINDS.filter((kind) => rows.some((c) => c?.membershipId === membershipId && c.kind === kind))
      : [];
  const excluded = exclusionKinds.length > 0;
  const refusals = {};
  for (const role of REVIEW_ROLES) {
    if (!held.includes(REVIEWER_ROLE_OF[role])) refusals[role] = 'E_ROLE_REQUIRED';
    else refusals[role] = excluded ? 'E_REVIEWER_IS_CONTRIBUTOR' : null;
  }
  const eligible = REVIEW_ROLES.filter((role) => refusals[role] === null);
  return {
    excluded,
    exclusionKinds,
    refusals,
    mayApproveAs: eligible,
    mayRequestChangesAs: [...eligible],
  };
}

/**
 * reviewReasonOf(value) -> { ok: true, value: <the trimmed reason> } | { ok: false, code: 'E_BODY_INVALID' }
 */
export function reviewReasonOf(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) return INVALID;
  const trimmed = value.trim();
  const points = [...trimmed];
  if (points.length < 1 || points.length > REASON_MAX_CODE_POINTS) return INVALID;
  for (const ch of points) if (within(REASON_REFUSED, ch.codePointAt(0))) return INVALID;
  return { ok: true, value: trimmed };
}

/**
 * groupNameOf(value) -> { ok: true, value: <the trimmed name> } | { ok: false, code: 'E_BODY_INVALID' }
 */
export function groupNameOf(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) return INVALID;
  const trimmed = value.replace(/^ +| +$/g, '');
  const points = [...trimmed];
  if (points.length < 1 || points.length > GROUP_NAME_MAX_CODE_POINTS) return INVALID;
  for (const ch of points) if (within(NAME_REFUSED, ch.codePointAt(0))) return INVALID;
  return { ok: true, value: trimmed };
}
