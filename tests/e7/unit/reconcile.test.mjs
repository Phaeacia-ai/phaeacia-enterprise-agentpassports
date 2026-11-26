/* E7 design 1.3 and section 5 case E7-17: the reconciler's plan over constructed folds and constructed database
   states. No stack, no owner connection, no GoTrue: foldToPlan is a function of two values and this file is where
   every correction, every refusal and its named way out, the three gates, the lift's narrowing-only options and
   idempotence are proven.

   THE FOLDS ARE BUILT FROM REGISTER LINES, not hand-written objects: every line goes through the register module's
   own checkBody and then through its own fold, so a shape this file invents cannot pass and the expected state is
   the one the register actually produces (evidence/e7-scripts.md section 5).

   This file also holds deleteFactor's unit half (design 1.3 C8, 2.2): the module is lib/operator/accounts.mjs's,
   the E6 file holds deleteAccount's cases, and the call is E7's, so its cases are here beside the correction that
   uses it rather than inside an accepted E6 file this lane does not own. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'example-service-role-key-never-logged';

const {
  checkBody,
  fold,
  FORMAT_VERSION,
  serialize,
  ZERO_PREV,
  sha256,
} = await import('../../../lib/operator/register.mjs');
const {
  checkGates,
  correctionStatements,
  credentialStatements,
  factorAuditStatement,
  foldToPlan,
  holdCorrection,
  liftCorrection,
  liftStatus,
  LINK_TOKEN_COLUMNS,
  narrower,
  REASON_CODE,
  RECOVERY_SETTING,
  ReconcileError,
  sweepRecordedStatement,
  transactionSql,
  WITHDRAWAL_REASON,
} = await import('../../../lib/operator/reconcile.mjs');
const { deleteAccount, deleteFactor } = await import('../../../lib/operator/accounts.mjs');

const OP = '00000000-0000-4000-9000-000000000001';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const X = '33333333-3333-4333-8333-333333333333';
const mA = 'aaaaaaaa-0000-4000-8000-000000000001';
const mB = 'aaaaaaaa-0000-4000-8000-000000000002';
const mC = 'aaaaaaaa-0000-4000-8000-000000000003';
const uA = 'bbbbbbbb-0000-4000-8000-000000000001';
const uB = 'bbbbbbbb-0000-4000-8000-000000000002';
const uGone = 'bbbbbbbb-0000-4000-8000-000000000009';
const REL = 'cccccccc-0000-4000-8000-000000000001';
const INV = 'dddddddd-0000-4000-8000-000000000001';
const FACTOR = 'eeeeeeee-0000-4000-8000-000000000001';

const T = (n) => new Date(Date.UTC(2026, 8, 1, 0, 0, 0) + n * 3600_000).toISOString();

/* A register, as lines: each body is checked by the register's own rule and each line serialized and chained the
   way the file holds it, so nothing here is a shape the register would refuse to write. */
function register(acts) {
  const lines = [];
  let prev = ZERO_PREV;
  let epoch = 0;
  let seq = 0;
  const push = (act, body = {}, at = T(seq)) => {
    checkBody(act, body);
    if (act === 'restore.begin') epoch += 1;
    const raw = serialize({ seq, epoch, at, act, prev, ...body });
    lines.push(JSON.parse(raw));
    prev = sha256(raw);
    seq += 1;
  };
  push('register.open');
  for (const [act, body, at] of acts) push(act, body, at);
  return { lines, fold: fold(lines) };
}

/** A recovery that has begun: the epoch is open, the backup is dated and the epoch before it has a watermark. */
const recovery = (acts, { backupAt = T(50), watermarkAt = T(60) } = {}) =>
  register([
    ...acts,
    ['register.sync', { watermarkAuditId: 900, watermarkAt }],
    ['restore.begin', { backupAt, auditFloor: 1000, actor: OP }],
  ]);

const company = (over = {}) => ({
  id: A,
  slug: 'company-a',
  status: 'held',
  holdStatusBefore: 'active',
  period: null,
  memberships: [],
  releases: [],
  invitationsPending: [],
  ...over,
});
const member = (id, userId, roles, status = 'active') => ({ id, userId, roles, status });
const db = (companies, over = {}) => ({ companies, factors: [], accounts: [], ...over });

const only = (plan) => {
  assert.equal(plan.companies.length, 1, JSON.stringify(plan.companies.map((c) => c.id)));
  return plan.companies[0];
};
const ids = (list) => list.map((c) => c.id);

// ---------------------------------------------------------------------------
// E7-17, arm 1: the register's removal of A's last administrator.
// ---------------------------------------------------------------------------

const removalOfLastAdmin = () =>
  recovery([['membership.remove', { companyId: A, membershipId: mA, auditId: 11, actor: OP }]]);

test('E7-17 arm 1: a removal that would leave no active administrator KEEPS THE COMPANY HELD, with its way out', () => {
  const r = removalOfLastAdmin();
  const state = db([company({ memberships: [member(mA, uA, ['member', 'company_admin']), member(mB, uB, ['member'])] })]);
  const plan = foldToPlan(r.fold, state, { operator: OP });
  const c = only(plan);
  assert.deepEqual(ids(c.corrections), [], 'nothing is applied');
  assert.equal(c.refusals.length, 1);
  assert.deepEqual(
    { correction: c.refusals[0].correction, membershipId: c.refusals[0].membershipId },
    { correction: 'C3', membershipId: mA },
  );
  assert.match(c.refusals[0].wayOut, /api\.transfer_first_admin/);
  assert.equal(c.status, 'held', 'and the company is held, never suspended instead');
});

test('E7-17 arm 1: after api.transfer_first_admin gives the confirmed successor the role, the removal applies', () => {
  const r = removalOfLastAdmin();
  /* The operator's transfer, which admits a held company, has made mB an administrator. */
  const state = db([
    company({ memberships: [member(mA, uA, ['member', 'company_admin']), member(mB, uB, ['member', 'company_admin'])] }),
  ]);
  const c = only(foldToPlan(r.fold, state, { operator: OP }));
  assert.deepEqual(ids(c.corrections), ['C3']);
  assert.equal(c.refusals.length, 0);
  const sql = transactionSql(c.corrections[0]);
  assert.match(sql, /update app\.memberships set status = 'removed'/);
  assert.match(sql, /delete from app\.group_members/);
  assert.match(sql, /update app\.agents g set status = 'orphaned'/);
});

// ---------------------------------------------------------------------------
// E7-17, arm 2: a role reduction on the last administrator.
// ---------------------------------------------------------------------------

const reductionOfLastAdmin = () =>
  recovery([
    ['membership.set_roles', { companyId: A, membershipId: mA, rolesAfter: ['member'], auditId: 12, actor: OP }],
  ]);

test('E7-17 arm 2: a reduction that would leave no active administrator is refused, and the company stays held', () => {
  const state = db([company({ memberships: [member(mA, uA, ['member', 'company_admin']), member(mB, uB, ['member'])] })]);
  const c = only(foldToPlan(reductionOfLastAdmin().fold, state, { operator: OP }));
  assert.deepEqual(ids(c.corrections), []);
  assert.equal(c.refusals[0].correction, 'C7');
  assert.match(c.refusals[0].wayOut, /api\.transfer_first_admin/);
});

test('E7-17 arm 2: after the transfer the reduction applies, and it takes the role away and adds none', () => {
  const state = db([
    company({ memberships: [member(mA, uA, ['member', 'company_admin']), member(mB, uB, ['member', 'company_admin'])] }),
  ]);
  const c = only(foldToPlan(reductionOfLastAdmin().fold, state, { operator: OP }));
  assert.deepEqual(ids(c.corrections), ['C7']);
  assert.deepEqual(c.corrections[0].rolesAfter, ['member']);
  assert.match(transactionSql(c.corrections[0]), /set roles = array\['member'\]::text\[\]/);
});

test('E7-17: a role the REGISTER holds and the restored row lacks is reported as a widening and never applied', () => {
  const r = recovery([
    ['membership.set_roles', { companyId: A, membershipId: mB, rolesAfter: ['member', 'it_reviewer'], auditId: 13, actor: OP }],
  ]);
  const state = db([company({ memberships: [member(mA, uA, ['member', 'company_admin']), member(mB, uB, ['member'])] })]);
  const plan = foldToPlan(r.fold, state, { operator: OP });
  assert.deepEqual(ids(only(plan).corrections), []);
  const report = plan.reports.find((x) => x.kind === 'role_added');
  assert.equal(report.membershipId, mB);
});

// ---------------------------------------------------------------------------
// E7-17, arm 3: a withdrawal whose recorded user has no restored membership.
// ---------------------------------------------------------------------------

const withdrawalByAStranger = () =>
  recovery([['release.withdraw', { companyId: A, releaseId: REL, byUserId: uGone, auditId: 14 }]]);

test('E7-17 arm 3: a withdrawal the register cannot attribute keeps the company held, with the lift as its way out', () => {
  const state = db([
    company({ memberships: [member(mA, uA, ['member', 'company_admin'])], releases: [{ id: REL, state: 'published' }] }),
  ]);
  const c = only(foldToPlan(withdrawalByAStranger().fold, state, { operator: OP }));
  assert.deepEqual(ids(c.corrections), []);
  assert.equal(c.refusals[0].correction, 'C4');
  assert.match(c.refusals[0].wayOut, /--withdrawn-by/);
});

test('E7-17 arm 3: with --withdrawn-by the withdrawal applies, with the fixed reason the immutability rule needs', () => {
  const state = db([
    company({ memberships: [member(mA, uA, ['member', 'company_admin'])], releases: [{ id: REL, state: 'published' }] }),
  ]);
  const plan = foldToPlan(withdrawalByAStranger().fold, state, {
    operator: OP,
    lift: { companyId: A, withdrawnBy: mA, confirmation: 'rehearsal:call-1', at: T(70) },
  });
  const c = only(plan);
  assert.deepEqual(ids(c.corrections), ['C4']);
  const sql = transactionSql(c.corrections[0]);
  assert.match(sql, new RegExp(`withdrawn_by_membership_id = '${mA}'`));
  assert.ok(sql.includes(WITHDRAWAL_REASON), 'the reason app.release_immutable requires');
  assert.equal(plan.liftable, true);
});

test('E7-17 arm 3: a withdrawal the register CAN attribute needs no option at all', () => {
  const r = recovery([['release.withdraw', { companyId: A, releaseId: REL, byUserId: uB, auditId: 15 }]]);
  const state = db([
    company({
      memberships: [member(mA, uA, ['member', 'company_admin']), member(mB, uB, ['member'], 'removed')],
      releases: [{ id: REL, state: 'published' }],
    }),
  ]);
  const c = only(foldToPlan(r.fold, state, { operator: OP }));
  assert.deepEqual(ids(c.corrections), ['C4']);
  assert.equal(c.corrections[0].membershipId, mB, 'a removed membership still carries the attribution');
});

// ---------------------------------------------------------------------------
// E7-17, arms 4 and 5: the access period.
// ---------------------------------------------------------------------------

const PERIOD = { startsAt: T(0), endsAt: T(1000), exportBy: T(1336), deleteBy: T(2056) };
const EARLIER = { startsAt: T(0), endsAt: T(500), exportBy: T(836), deleteBy: T(1556) };

test('E7-17: an EARLIER period is a narrowing and applies at once', () => {
  const r = recovery([['company.set_access_period', { companyId: A, ...EARLIER, auditId: 16, actor: OP }]]);
  const state = db([company({ period: PERIOD })]);
  const c = only(foldToPlan(r.fold, state, { operator: OP }));
  assert.deepEqual(ids(c.corrections), ['C2']);
  assert.equal(c.corrections[0].direction, 'narrowing');
  assert.match(transactionSql(c.corrections[0]), /update app\.access_periods set starts_at =/);
});

test('E7-17 arm 4: a LATER period is an authorized recovery, refused until lift --agreement', () => {
  const r = recovery([['company.set_access_period', { companyId: A, ...PERIOD, auditId: 17, actor: OP }]]);
  const state = db([company({ period: EARLIER })]);
  const c = only(foldToPlan(r.fold, state, { operator: OP }));
  assert.deepEqual(ids(c.corrections), []);
  assert.equal(c.refusals[0].correction, 'C2');
  assert.match(c.refusals[0].rule, /extension made after the backup/);
  assert.match(c.refusals[0].wayOut, /--agreement/);

  const lifted = only(
    foldToPlan(r.fold, state, {
      operator: OP,
      lift: { companyId: A, agreement: 'synthetic:agreement-2026-09', confirmation: 'rehearsal:call-2', at: T(70) },
    }),
  );
  assert.deepEqual(ids(lifted.corrections), ['C2']);
  assert.equal(lifted.corrections[0].direction, 'agreement_recovery');
  assert.equal(lifted.corrections[0].agreement, 'synthetic:agreement-2026-09');
});

test('E7-17 arm 5: a period the register cannot date is refused, and never invented', () => {
  const r = recovery([
    ['company.set_access_period', { companyId: A, startsAt: null, endsAt: T(1000), exportBy: T(1336), deleteBy: T(2056), auditId: 18, actor: OP }],
  ]);
  assert.equal(r.fold.companies[A].accessPeriodStartsAtMissing, true);
  const c = only(foldToPlan(r.fold, db([company({ period: null })]), { operator: OP }));
  assert.deepEqual(ids(c.corrections), []);
  assert.equal(c.refusals[0].correction, 'C2');
  assert.match(c.refusals[0].rule, /cannot date/);
  assert.match(c.refusals[0].wayOut, /api\.set_access_period/);
});

test('E7-17 arm 5: a missing row WITH all four dates is inserted', () => {
  const r = recovery([['company.set_access_period', { companyId: A, ...PERIOD, auditId: 19, actor: OP }]]);
  const c = only(foldToPlan(r.fold, db([company({ period: null })]), { operator: OP }));
  assert.equal(c.corrections[0].mode, 'insert');
  assert.match(transactionSql(c.corrections[0]), /insert into app\.access_periods/);
});

// ---------------------------------------------------------------------------
// E7-17, arms 6, 7 and 8: the lift's status, and the two companies nobody can correct.
// ---------------------------------------------------------------------------

test('E7-17 arm 6: the register says active and the database said suspended: the lift takes THE NARROWER', () => {
  const r = recovery([['company.provision', { companyId: A, auditId: 20, actor: OP }]]);
  const state = db([company({ holdStatusBefore: 'suspended' })]);
  const c = only(foldToPlan(r.fold, state, { operator: OP, lift: { companyId: A, confirmation: 'rehearsal:call-3', at: T(70) } }));
  const chosen = liftStatus(c, r.fold);
  assert.equal(chosen.status, 'suspended');
  assert.equal(chosen.widening, false);
  const wider = liftStatus(c, r.fold, 'active');
  assert.equal(wider.status, 'active');
  assert.equal(wider.widening, true, 'and going to active is reported as a widening');
  assert.equal(narrower('active', 'suspended'), 'suspended');
});

test('E7-17 arm 7: a company the register does not know stays held until --status', () => {
  const r = recovery([['company.provision', { companyId: B, auditId: 21, actor: OP }]]);
  const state = db([company({ id: A, holdStatusBefore: 'active' })]);
  const plan = foldToPlan(r.fold, state, { operator: OP, lift: { companyId: A, confirmation: 'rehearsal:call-4', at: T(70) } });
  const c = only(plan);
  assert.equal(c.known, false);
  assert.ok(plan.reports.some((x) => x.kind === 'company_unknown' && x.companyId === A));
  assert.equal(liftStatus(c, r.fold).status, null, 'no status can be chosen for it');
  assert.match(liftStatus(c, r.fold).rule, /--status/);
  assert.equal(liftStatus(c, r.fold, 'suspended').status, 'suspended');
});

test('E7-17 arm 8: a company the register knows and the database lacks is REPORTED, never invented', () => {
  const r = recovery([
    ['company.provision', { companyId: A, auditId: 22, actor: OP }],
    ['company.provision', { companyId: X, auditId: 23, actor: OP }],
  ]);
  const plan = foldToPlan(r.fold, db([company({ id: A })]), { operator: OP });
  const report = plan.reports.find((x) => x.kind === 'company_missing');
  assert.equal(report.companyId, X);
  assert.match(report.rule, /re-onboarded/);
});

test('E7-17: a company the register records DELETED is closed by C1, with the one door’s command beside it', () => {
  const r = recovery([
    ['company.close', { companyId: A, reason: 'customer_instruction', statusAfter: 'closed', auditId: 24, actor: OP }],
    ['company.delete', { companyId: A, reason: 'customer_instruction', ref: 'synthetic:instruction-7', rows: 812, auditId: 25, actor: OP }],
  ]);
  const c = only(foldToPlan(r.fold, db([company({ slug: 'company-a' })]), { operator: OP }));
  assert.deepEqual(ids(c.corrections), ['C1']);
  assert.deepEqual(c.corrections[0].deletion, {
    companyId: A,
    slug: 'company-a',
    reason: 'customer_instruction',
    ref: 'synthetic:instruction-7',
    rows: 812,
  });
  const sql = transactionSql(c.corrections[0]);
  assert.match(sql, /set status = 'closed'/);
  assert.match(sql, /set local app\.recovery_reconcile = 'on'/);
});

test('E7-17: a lift is NOT liftable while the plan holds a correction the lift does not apply', () => {
  /* The register says this company was closed, so C1 is in its plan. A lift would close it and then write a
     company.hold_lift audit row for a status change its own predicate (status = 'held') no longer matches: an
     audit row claiming a lift that did not happen. The plan says so, and the script refuses --apply on it. */
  const r = recovery([
    ['company.close', { companyId: A, reason: 'customer_request', statusAfter: 'closed', auditId: 50, actor: OP }],
  ]);
  const plan = foldToPlan(r.fold, db([company({ status: 'held' })]), {
    operator: OP,
    lift: { companyId: A, confirmation: 'rehearsal:call-5', at: T(70) },
  });
  assert.deepEqual(ids(only(plan).corrections), ['C1']);
  assert.equal(plan.liftable, false);

  /* The control: with nothing but what the lift applies, it is liftable. */
  const clean = foldToPlan(recovery([['company.provision', { companyId: A, auditId: 51, actor: OP }]]).fold, db([company()]), {
    operator: OP,
    lift: { companyId: A, confirmation: 'rehearsal:call-6', at: T(70) },
  });
  assert.equal(clean.liftable, true);
});

test('E7-17: a lift is not liftable while the plan holds work APPLY owes, and is once only its own acts remain', () => {
  /* A pending invitation is C5's, which `apply` does. The lift is the last step of a recovery and not a way to
     skip one, so its plan must be empty but for what the lift itself applies. */
  const r = recovery([['company.provision', { companyId: A, auditId: 60, actor: OP }]]);
  const owed = foldToPlan(r.fold, db([company({ invitationsPending: [INV] })]), {
    operator: OP,
    lift: { companyId: A, confirmation: 'rehearsal:call-7', at: T(70) },
  });
  assert.deepEqual(ids(only(owed).corrections), ['C5']);
  assert.equal(owed.companies[0].corrections[0].viaLift, undefined, 'C5 is not the lift’s own');
  assert.equal(owed.liftable, false);

  /* The same company once apply has done it, with one act the customer confirmed on the call: liftable. */
  const confirmed = foldToPlan(r.fold, db([company({ memberships: [member(mA, uA, ['member', 'company_admin']), member(mB, uB, ['member'])] })]), {
    operator: OP,
    lift: { companyId: A, remove: [mB], confirmation: 'rehearsal:call-7', at: T(70) },
  });
  assert.deepEqual(ids(only(confirmed).corrections), ['C3']);
  assert.equal(confirmed.companies[0].corrections[0].viaLift, true, 'the removal the customer confirmed IS the lift’s own');
  assert.equal(confirmed.liftable, true);
});

// ---------------------------------------------------------------------------
// C5, C8, C9 and the second run.
// ---------------------------------------------------------------------------

test('design 1.3 C5: every pending invitation is revoked, one transaction each', () => {
  const r = recovery([['company.provision', { companyId: A, auditId: 26, actor: OP }]]);
  const second = 'dddddddd-0000-4000-8000-000000000002';
  const c = only(foldToPlan(r.fold, db([company({ invitationsPending: [INV, second] })]), { operator: OP }));
  assert.deepEqual(ids(c.corrections), ['C5', 'C5']);
  assert.deepEqual(
    c.corrections.map((x) => x.invitationId),
    [INV, second],
  );
  assert.match(transactionSql(c.corrections[0]), /set revoked_at = now\(\) where id = 'dddddddd/);
});

test('design 1.3 C8 and C9: the fold’s factor and account deletions, only where the target still has them', () => {
  const r = recovery([
    ['factor.delete', { userId: uA, factorId: FACTOR, ref: 'opslog:2026-09-19/1', actor: OP }],
    ['account.delete', { userId: uB, reason: 'unclaimed_invitation', auditId: 27, actor: OP }],
  ]);
  const state = db([company()], {
    factors: [{ userId: uA, factorId: FACTOR }],
    accounts: [
      { userId: uA, memberships: 1 },
      { userId: uB, memberships: 0 },
    ],
  });
  const plan = foldToPlan(r.fold, state, { operator: OP });
  assert.deepEqual(plan.factors.map((f) => f.factorId), [FACTOR]);
  assert.deepEqual(plan.accounts.map((a) => a.userId), [uB]);

  /* The same fold against a target that no longer holds either plans neither. */
  const after = foldToPlan(r.fold, db([company()], { factors: [], accounts: [{ userId: uA, memberships: 1 }] }), { operator: OP });
  assert.deepEqual(after.factors, []);
  assert.deepEqual(after.accounts, []);
});

test('design 1.3 C9: an account that still holds a membership is HELD for the second apply, not deleted now', () => {
  const r = recovery([['account.delete', { userId: uB, reason: 'unclaimed_invitation', auditId: 28, actor: OP }]]);
  const plan = foldToPlan(r.fold, db([company()], { accounts: [{ userId: uB, memberships: 1 }] }), { operator: OP });
  assert.deepEqual(plan.accounts, []);
  assert.ok(plan.reports.some((x) => x.kind === 'account_held' && x.userId === uB));
});

test('E7-17: THE SECOND RUN PLANS NOTHING, because every condition reads current state', () => {
  const r = recovery([
    ['company.set_access_period', { companyId: A, ...EARLIER, auditId: 30, actor: OP }],
    ['membership.remove', { companyId: A, membershipId: mB, auditId: 31, actor: OP }],
    ['membership.set_roles', { companyId: A, membershipId: mC, rolesAfter: ['member'], auditId: 32, actor: OP }],
    ['release.withdraw', { companyId: A, releaseId: REL, byUserId: uA, auditId: 33 }],
  ]);
  const before = db([
    company({
      period: PERIOD,
      memberships: [
        member(mA, uA, ['member', 'company_admin']),
        member(mB, uB, ['member']),
        member(mC, 'bbbbbbbb-0000-4000-8000-000000000003', ['member', 'it_reviewer']),
      ],
      releases: [{ id: REL, state: 'published' }],
      invitationsPending: [INV],
    }),
  ]);
  const first = only(foldToPlan(r.fold, before, { operator: OP }));
  assert.deepEqual(ids(first.corrections), ['C2', 'C3', 'C7', 'C4', 'C5'], 'the design’s order');
  assert.equal(first.refusals.length, 0);

  /* The database as those corrections leave it. */
  const after = db([
    company({
      period: EARLIER,
      memberships: [
        member(mA, uA, ['member', 'company_admin']),
        member(mB, uB, ['member'], 'removed'),
        member(mC, 'bbbbbbbb-0000-4000-8000-000000000003', ['member']),
      ],
      releases: [{ id: REL, state: 'withdrawn' }],
      invitationsPending: [],
    }),
  ]);
  const second = foldToPlan(r.fold, after, { operator: OP });
  assert.deepEqual(ids(only(second).corrections), []);
  assert.equal(second.counts.corrections, 0);
  assert.equal(second.counts.refusals, 0);
});

// ---------------------------------------------------------------------------
// The transaction's shape, and the one seam case E7-13 uses.
// ---------------------------------------------------------------------------

test('E2 section 5: one transaction per correction, the lock timeout, the lock, the writes, THEN the audit row', () => {
  const c = holdCorrection({ companyId: A, statusBefore: 'active', operator: OP });
  const statements = correctionStatements(c);
  assert.equal(statements[0], 'begin');
  assert.equal(statements[1], "set local lock_timeout = '5s'");
  assert.equal(statements[2], RECOVERY_SETTING);
  assert.match(statements[3], /for no key update$/);
  assert.match(statements[4], /update app\.companies set status = 'held'/);
  assert.match(statements[5], /select app\.audit\(/);
  assert.equal(statements.at(-1), 'commit');
  assert.ok(statements[5].includes(`'reason_code', '${REASON_CODE}'`));
});

test('E7-13’s seam: a fault sits BETWEEN the last write and the first audit row, and nowhere else', () => {
  const c = holdCorrection({ companyId: A, statusBefore: 'active', operator: OP });
  const statements = correctionStatements(c, { fault: "do $$ begin raise exception 'E7_13' using errcode = 'P0001'; end $$" });
  const write = statements.findIndex((s) => s.startsWith('update app.companies'));
  const fault = statements.findIndex((s) => s.includes('E7_13'));
  const audit = statements.findIndex((s) => s.startsWith('select app.audit('));
  assert.ok(write < fault && fault < audit, statements.join(' | '));
  assert.equal(statements.filter((s) => s.includes('E7_13')).length, 1);
});

test('design 1.3 C6: the six link-token columns and the five tables, and the count carried to the audit row', () => {
  const c = credentialStatements({ operator: OP });
  const sql = transactionSql(c);
  for (const column of LINK_TOKEN_COLUMNS) assert.ok(sql.includes(`${column} = ''`), column);
  for (const table of ['refresh_tokens', 'sessions', 'one_time_tokens', 'flow_state', 'mfa_challenges'])
    assert.match(sql, new RegExp(`delete from auth\\.${table}`), table);
  assert.match(sql, /restore\.end_credentials/);
  assert.match(sql, /'deleted_rows', \(select coalesce\(sum\(row_count\), 0\)::int from reconcile_c6_counts\)/);
  assert.equal(c.setting, false, 'C6 writes schema auth and needs no recovery setting');
  assert.equal(c.lock, false, 'and it is not a company’s correction');
});

test('design 1.3: C8’s audit row names the USER and not the factor, because the guard admits no factor_id', () => {
  const row = factorAuditStatement({ userId: uA, operator: OP });
  assert.match(row, new RegExp(`'user_id', '${uA}'`));
  assert.equal(row.includes('factor_id'), false, 'E7S-F5: no such key exists and no migration adds one');
  assert.match(row, /'factor\.delete', 'factor', null/);
});

test('design 1.3 C9: the sweep’s own recorder, unchanged', () => {
  assert.match(sweepRecordedStatement({ operator: OP, userIds: [uA, uB] }), /select app\.sweep_recorded\('/);
});

test('design 3.5: every value that enters a statement is shape-checked, and a bad one throws', () => {
  assert.throws(() => holdCorrection({ companyId: 'not-a-uuid', statusBefore: 'active', operator: OP }), ReconcileError);
  assert.throws(() => holdCorrection({ companyId: A, statusBefore: 'nonsense', operator: OP }), ReconcileError);
  assert.throws(() => liftCorrection({ companyId: A, statusAfter: "active'; drop table app.companies --", operator: OP }), ReconcileError);
  assert.throws(() => foldToPlan(fold([]), db([]), { operator: 'nope' }), ReconcileError);
});

// ---------------------------------------------------------------------------
// The three gates (design 1.3). The stack file runs them through the script.
// ---------------------------------------------------------------------------

test('E7-17: each gate refuses on its own, and `gap` is the only way on', () => {
  const r = recovery([['company.provision', { companyId: A, auditId: 40, actor: OP }]]);
  const good = { verified: true, problems: [], copies: 'equal', anchoredHeadGiven: true };
  assert.equal(checkGates(r.fold, good).ok, true);

  const unverified = checkGates(r.fold, { ...good, verified: false, problems: [{ rule: 'the chain is broken', at: 3 }] });
  assert.equal(unverified.ok, false);
  assert.equal(unverified.problems[0].gate, 1);

  assert.equal(checkGates(r.fold, { ...good, copies: 'fork' }).problems.some((p) => /FORK/.test(p.rule)), true);
  assert.equal(
    checkGates(r.fold, { ...good, anchoredHeadGiven: false }).problems.some((p) => /--anchored-head/.test(p.rule)),
    true,
  );

  /* Older than the backup: the previous epoch's watermark is before the backup's point in time. */
  const stale = recovery([['company.provision', { companyId: A, auditId: 41, actor: OP }]], {
    backupAt: T(80),
    watermarkAt: T(10),
  });
  const gate2 = checkGates(stale.fold, good);
  assert.equal(gate2.ok, false);
  assert.equal(gate2.problems[0].gate, 2);
  assert.match(gate2.problems[0].rule, /OLDER than the backup/);

  /* The gap line of this epoch is what lets recovery go on, and the companies are still held. */
  const gapped = register([
    ['register.sync', { watermarkAuditId: 900, watermarkAt: T(10) }],
    ['restore.begin', { backupAt: T(80), auditFloor: 1000, actor: OP }],
    ['restore.gap', { ref: 'synthetic:hand-reconciliation', actor: OP }],
  ]);
  const past = checkGates(gapped.fold, good);
  assert.equal(past.ok, true);
  assert.equal(past.gapped, true);
});

test('design 1.3: with no epoch open, plan and apply refuse', () => {
  const r = register([['company.provision', { companyId: A, auditId: 42, actor: OP }]]);
  const gates = checkGates(r.fold, { verified: true, problems: [], copies: 'equal', anchoredHeadGiven: true });
  assert.equal(gates.ok, false);
  assert.match(gates.problems[0].rule, /no recovery epoch is open/);
});

// ---------------------------------------------------------------------------
// E7-23's reconciler arm: malformed arguments, refused before anything is opened.
// ---------------------------------------------------------------------------

function runReconcile(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [join(REPO, 'scripts/reconcile.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, ENTERPRISE_REGISTER_PATH: '', ENTERPRISE_DB_PSQL: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (e) {
    return { status: e.status, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('E7-23: every malformed argument to reconcile.mjs exits 2 with a usage line naming the rule and echoes no value', () => {
  const secret = '/Users/synthetic-operator/example-registers/tenant-0001.jsonl';
  const upper = '00000000-0000-4000-8000-00000000000A';
  const head = `3:${'b'.repeat(64)}`;
  const cases = [
    [[], /the first argument is one of begin, plan, apply, lift, end/],
    [['reconcile'], /the first argument is one of/],
    [['end'], /end needs --operator/],
    [['end', '--operator', upper], /--operator takes a lowercase uuid/],
    [['end', '--operator'], /--operator takes a value/],
    [['end', '--operator', OP, '--force'], /unknown argument --force/],
    [['begin', '--operator', OP], /begin needs --closed-target/],
    [['begin', '--operator', OP, '--closed-target'], /begin needs --backup-at/],
    [['begin', '--operator', OP, '--closed-target', '--backup-at', 'yesterday'], /--backup-at takes an ISO 8601/],
    [['plan', '--operator', OP, '--closed-target'], /plan needs --anchored-head/],
    [['plan', '--operator', OP, '--closed-target', '--anchored-head', 'nine'], /--anchored-head takes SEQ:SHA256/],
    [['plan', '--operator', OP, '--closed-target', '--anchored-head', head, '--apply'], /plan never applies/],
    [['apply', '--operator', OP, '--closed-target', '--anchored-head', head, '--dry-run'], /apply applies/],
    [['plan', '--operator', OP, '--closed-target', '--anchored-head', head, '--copy', 'relative'], /--copy takes an absolute path/],
    [['lift', '--operator', OP], /lift needs --company/],
    [['lift', '--operator', OP, '--company', A], /lift needs --confirmation/],
    [['lift', '--operator', OP, '--company', A, '--confirmation', 'has a space'], /--confirmation matches/],
    [['lift', '--operator', OP, '--company', A, '--confirmation', `s:${'x'.repeat(80)}`], /--confirmation matches/],
    [['lift', '--operator', OP, '--company', A, '--confirmation', 'r:1', '--status', 'held'], /--status is active or suspended/],
    [['lift', '--operator', OP, '--company', A, '--confirmation', 'r:1', '--roles', `${mA}=archivist`], /--roles takes UUID=ROLE/],
    [['lift', '--operator', OP, '--company', A, '--confirmation', 'r:1', '--remove', upper], /--remove takes a lowercase membership uuid/],
    [['lift', '--operator', OP, '--company', A, '--confirmation', 'r:1', '--agreement', 'has a space'], /--agreement matches/],
    [['plan', '--operator', OP, '--closed-target', '--anchored-head', head, '--company', A], /--company belongs to lift/],
    [['apply', '--operator', OP, '--closed-target', '--anchored-head', head, '--remove', mA], /--remove, --roles and --withdrawn-by belong to lift/],
    [['end', '--operator', OP, '--backup-at', '2026-09-20T00:00:00Z'], /--backup-at belongs to begin/],
  ];
  for (const [args, rule] of cases) {
    const r = runReconcile(args, { ENTERPRISE_REGISTER_PATH: secret, ENTERPRISE_DB_PSQL: 'false' });
    assert.equal(r.status, 2, `${args.join(' ')}: exit ${r.status}\n${r.output}`);
    assert.match(r.output, rule, args.join(' '));
    assert.equal(r.output.includes(secret), false, 'the register path is never echoed');
    assert.equal(r.output.includes(upper), false, 'no rejected value is echoed');
  }
});

test('E7-23: the register path rule is the register module’s, and reconcile.mjs refuses on it before any verb runs', () => {
  const unset = runReconcile(['end', '--operator', OP], { ENTERPRISE_REGISTER_PATH: '' });
  assert.equal(unset.status, 2);
  assert.match(unset.output, /ENTERPRISE_REGISTER_PATH is not set/);
  const inRepo = runReconcile(['end', '--operator', OP], { ENTERPRISE_REGISTER_PATH: join(REPO, 'register.jsonl') });
  assert.equal(inRepo.status, 2);
  assert.match(inRepo.output, /inside a Git work tree/);
});

// ---------------------------------------------------------------------------
// deleteFactor (design 1.3 C8, 2.2), beside deleteAccount's cases in the E6 file.
// ---------------------------------------------------------------------------

const fetchOf = (status, seen = []) => ({
  fetchImpl: async (url, init) => {
    seen.push({ url: String(url), method: init.method });
    return { status, json: async () => ({}) };
  },
});

test('design 1.3 C8: deleteFactor calls GoTrue’s admin factor delete, and a 2xx is a deletion', async () => {
  const seen = [];
  assert.equal(await deleteFactor(uA, FACTOR, fetchOf(200, seen)), 'deleted');
  assert.equal(seen[0].method, 'DELETE');
  assert.equal(seen[0].url.endsWith(`/auth/v1/admin/users/${uA}/factors/${FACTOR}`), true);
  assert.equal(await deleteFactor(uA, FACTOR, fetchOf(204)), 'deleted');
});

test('design 1.3 C8: a 404 is already gone and anything else is a refusal, and neither is a deletion to record', async () => {
  assert.equal(await deleteFactor(uA, FACTOR, fetchOf(404)), 'gone');
  for (const status of [401, 403, 409, 422, 500, 503]) assert.equal(await deleteFactor(uA, FACTOR, fetchOf(status)), 'refused');
  /* The same three outcomes deleteAccount has, which is the point of putting the call beside it. */
  assert.equal(await deleteAccount(uA, fetchOf(200)), 'deleted');
  assert.equal(await deleteAccount(uA, fetchOf(500)), 'refused');
});

test('design 1.3 C8: the answer carries the STATUS only, and no body reaches the caller', async () => {
  const outcome = await deleteFactor(uA, FACTOR, {
    fetchImpl: async () => ({
      status: 500,
      json: async () => ({ msg: 'synthetic-upstream-detail', factor: FACTOR }),
    }),
  });
  assert.equal(outcome, 'refused');
  assert.equal(typeof outcome, 'string', 'the outcome is one of three words and never the provider’s answer');
});

test('design 1.3: the version the fold carries is the register’s own', () => {
  assert.equal(fold([]).version, FORMAT_VERSION);
});
