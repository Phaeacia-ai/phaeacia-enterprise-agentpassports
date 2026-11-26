/* Two shared corpora of E4 design 1.2 and 3.2.

   STATUS_CORPUS: lib/rules/reviews.mjs envelopeStatus and app.envelope_status over the review rows of one envelope. sql
   is 'ok' when the rows can exist in app.reviews (probe 23 inserts them in a rolled-back transaction and reads the
   function) or 'unrepresentable' when a unique index refuses them.

   VERDICT_CORPUS: viewerVerdict and api.record_review rows 21 and 22 of 3.5, per role, for a viewer holding the roles, the
   contributor kinds on the reviewed candidate itself (kinds), and, where given, kinds on an earlier candidate of the same
   agent only (earlierKinds), which exclude nobody (Q5 as answered 2026-09-15). Probe 23 drives each row through the
   routine, tests/e4/unit/services.test.mjs through the review read, tests/e4/unit/reviews-rules.test.mjs through the rule. */

export const STATUS_CORPUS = Object.freeze([
  { label: 'no review', reviews: [], expected: 'open', sql: 'ok' },
  { label: 'the IT approval alone', reviews: [{ role: 'it', decision: 'approved' }], expected: 'open', sql: 'ok' },
  { label: 'the business approval alone', reviews: [{ role: 'business', decision: 'approved' }], expected: 'open', sql: 'ok' },
  {
    label: 'both roles approved',
    reviews: [
      { role: 'it', decision: 'approved' },
      { role: 'business', decision: 'approved' },
    ],
    expected: 'approved',
    sql: 'ok',
  },
  { label: 'a change request alone', reviews: [{ role: 'business', decision: 'changes_requested' }], expected: 'changes_requested', sql: 'ok' },
  {
    label: 'one approval and a change request',
    reviews: [
      { role: 'it', decision: 'approved' },
      { role: 'it', decision: 'changes_requested' },
    ],
    expected: 'changes_requested',
    sql: 'ok',
  },
  {
    label: 'both approvals and a change request written owner-side: the change request wins',
    reviews: [
      { role: 'it', decision: 'approved' },
      { role: 'business', decision: 'approved' },
      { role: 'it', decision: 'changes_requested' },
    ],
    expected: 'changes_requested',
    sql: 'ok',
  },
  {
    label: 'one role approving twice is not two roles',
    reviews: [
      { role: 'it', decision: 'approved' },
      { role: 'it', decision: 'approved' },
    ],
    expected: 'open',
    sql: 'unrepresentable',
  },
  {
    label: 'two change requests',
    reviews: [
      { role: 'it', decision: 'changes_requested' },
      { role: 'business', decision: 'changes_requested' },
    ],
    expected: 'changes_requested',
    sql: 'unrepresentable',
  },
]);

const both = (code) => ({ it: code, business: code });

export const VERDICT_CORPUS = Object.freeze([
  { label: 'a member with no reviewer role', roles: ['member'], kinds: [], refusals: both('E_ROLE_REQUIRED') },
  { label: 'an IT reviewer, no contribution', roles: ['it_reviewer', 'member'], kinds: [], refusals: { it: null, business: 'E_ROLE_REQUIRED' } },
  {
    label: 'a business reviewer who authored a version',
    roles: ['business_reviewer', 'member'],
    kinds: ['author'],
    refusals: { it: 'E_ROLE_REQUIRED', business: 'E_REVIEWER_IS_CONTRIBUTOR' },
  },
  { label: 'both reviewer roles, no contribution', roles: ['business_reviewer', 'it_reviewer', 'member'], kinds: [], refusals: both(null) },
  {
    label: 'both reviewer roles, declared by membership',
    roles: ['business_reviewer', 'it_reviewer', 'member'],
    kinds: ['declared_member'],
    refusals: both('E_REVIEWER_IS_CONTRIBUTOR'),
  },
  { label: 'an IT reviewer who edited', roles: ['it_reviewer', 'member'], kinds: ['editor'], refusals: { it: 'E_REVIEWER_IS_CONTRIBUTOR', business: 'E_ROLE_REQUIRED' } },
  { label: 'an IT reviewer who submitted', roles: ['it_reviewer', 'member'], kinds: ['submitter'], refusals: { it: 'E_REVIEWER_IS_CONTRIBUTOR', business: 'E_ROLE_REQUIRED' } },
  { label: 'an admin without a reviewer role who authored', roles: ['company_admin', 'member'], kinds: ['author'], refusals: both('E_ROLE_REQUIRED') },
  { label: 'an admin who is also an IT reviewer', roles: ['company_admin', 'it_reviewer', 'member'], kinds: [], refusals: { it: null, business: 'E_ROLE_REQUIRED' } },
  {
    label: 'a declared offline name carries no membership and excludes nobody',
    roles: ['it_reviewer', 'member'],
    kinds: ['declared_offline'],
    refusals: { it: null, business: 'E_ROLE_REQUIRED' },
  },
  {
    label: 'contributor of an earlier version only: not excluded',
    roles: ['business_reviewer', 'it_reviewer', 'member'],
    kinds: [],
    earlierKinds: ['author'],
    refusals: both(null),
  },
]);
