/* The Codex milestone critique of E7 days 2 to 7 (evidence/e7-milestone-critique.md), the four code findings this
   lane fixes, each as the counterexample the critic built: E7X-C-F8 (a lift reopened a held company with a recorded
   factor deletion still owed, and skipped the recovery gates), E7X-C-F1 (a missing local head was read as "do not
   check"), E7X-C-F3 (a body's own `epoch` overrode the computed one, and verify accepted the jump) and E7X-C-F7 (an
   access period compared as one tuple, so a mixed period widened a date).

   Every case here FAILS on the modules at c0f5d8f and passes after (evidence/e7x-fixes.md section 4 and
   evidence/e7x-fixes-repro/). No stack: the command fixture is the critic's own, an owner connection played by a
   child process that answers the reconciler's reads from a fixed state and records every statement it is sent, so
   "wrote nothing" is observed and not inferred. The stack half of E7X-C-F8 is tests/e7/stack/lift-gates.test.mjs.
   Every id is synthetic. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  append,
  appendMany,
  checkBody,
  fileStore,
  fold,
  init,
  RegisterError,
  serialize,
  sha256,
  verify,
  ZERO_PREV,
} from '../../../lib/operator/register.mjs';
import { foldToPlan, transactionSql } from '../../../lib/operator/reconcile.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OP = uuid(1);
const A = uuid(2);
const B = uuid(3);
const U_ADMIN = uuid(4);
const FACTOR = uuid(5);
const M_ADMIN = uuid(6);
const U_MEMBER = uuid(7);
const M_MEMBER = uuid(8);
const U_OTHER = uuid(9);
const M_OTHER = uuid(10);
const U_LONER = uuid(11);
const FACTOR_LONER = uuid(12);
const U_SWEPT = uuid(13);
const M_B_ADMIN = uuid(14);

const scratches = [];
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `e7x-${prefix}-`));
  scratches.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

const T = (n) => new Date(Date.UTC(2026, 8, 1) + n * 3600_000).toISOString();

/* A register as lines, through the register's own shape check and serializer (the reconcile unit file's helper,
   reproduced here so this file stands alone). */
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
const recovery = (acts) =>
  register([
    ...acts,
    ['register.sync', { watermarkAuditId: 900, watermarkAt: T(60) }],
    ['restore.begin', { backupAt: T(50), auditFloor: 1000, actor: OP }],
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
const LIFT = { companyId: A, confirmation: 'synthetic:confirmed', at: T(70) };

// ---------------------------------------------------------------------------
// E7X-C-F8, the planner: a lift plans the whole recovery, and the recorded credential deletions are owed first.
// ---------------------------------------------------------------------------

test('E7X-C-F8: a factor the register records deleted and the target still holds is owed before the lift, and names its way out', () => {
  /* The critic's isolated fixture: the full plan owes C8; the lift's plan dropped it and said liftable. */
  const r = recovery([
    ['company.provision', { companyId: A, auditId: 1, actor: OP }],
    ['factor.delete', { userId: U_ADMIN, factorId: FACTOR, actor: OP, ref: 'synthetic:factor' }],
  ]);
  const state = {
    companies: [company({ memberships: [member(M_ADMIN, U_ADMIN, ['member', 'company_admin'])] })],
    factors: [{ userId: U_ADMIN, factorId: FACTOR }],
    accounts: [{ userId: U_ADMIN, memberships: 1 }],
  };
  const full = foldToPlan(r.fold, state, { operator: OP });
  assert.deepEqual(full.factors.map((f) => f.factorId), [FACTOR], 'plan owes C8');
  const lift = foldToPlan(r.fold, state, { operator: OP, lift: LIFT });
  assert.deepEqual(lift.factors.map((f) => f.factorId), [FACTOR], 'the lift plans what plan plans');
  assert.equal(lift.liftable, false, 'and a lift with C8 owed is not liftable');
  const refusal = lift.companies.find((c) => c.id === A).refusals.find((x) => x.correction === 'C8');
  assert.ok(refusal, JSON.stringify(lift.companies));
  assert.equal(refusal.factorId, FACTOR);
  assert.equal(refusal.userId, U_ADMIN);
  assert.match(refusal.wayOut, /run apply/);

  /* The control: once apply has deleted it, the same lift is liftable. */
  const after = foldToPlan(r.fold, { ...state, factors: [] }, { operator: OP, lift: LIFT });
  assert.equal(after.liftable, true, JSON.stringify(after.companies[0].refusals));
});

test('E7X-C-F8: a C8 or C9 owed to ANY user holds every lift, including one with no membership in the lifted company', () => {
  /* The rule chosen, and why: each is apply's work and apply can make it at once, and a deletion owed to a user
     in no held company would otherwise hold no lift at all, so `end` would close the epoch with it undone. */
  const r = recovery([
    ['company.provision', { companyId: A, auditId: 1, actor: OP }],
    ['factor.delete', { userId: U_LONER, factorId: FACTOR_LONER, actor: OP, ref: 'synthetic:factor-2' }],
    ['account.delete', { userId: U_SWEPT, reason: 'unclaimed_invitation', auditId: 2, actor: OP }],
  ]);
  const state = {
    companies: [company({ memberships: [member(M_ADMIN, U_ADMIN, ['member', 'company_admin'])] })],
    factors: [{ userId: U_LONER, factorId: FACTOR_LONER }],
    accounts: [
      { userId: U_LONER, memberships: 0 },
      { userId: U_SWEPT, memberships: 0 },
    ],
  };
  const lift = foldToPlan(r.fold, state, { operator: OP, lift: LIFT });
  const owed = lift.companies[0].refusals.map((x) => `${x.correction}:${x.userId}`).sort();
  assert.deepEqual(owed, [`C8:${U_LONER}`, `C9:${U_SWEPT}`].sort());
  assert.equal(lift.liftable, false);
});

test('E7X-C-F8: an account the register records deleted and still holding an ACTIVE membership in the lifted company holds it, with --remove as its way out', () => {
  const r = recovery([
    ['company.provision', { companyId: A, auditId: 1, actor: OP }],
    ['account.delete', { userId: U_MEMBER, reason: 'unclaimed_invitation', auditId: 2, actor: OP }],
  ]);
  const state = {
    companies: [
      company({
        memberships: [member(M_ADMIN, U_ADMIN, ['member', 'company_admin']), member(M_MEMBER, U_MEMBER, ['member'])],
      }),
    ],
    factors: [],
    accounts: [{ userId: U_MEMBER, memberships: 1 }],
  };
  const held = foldToPlan(r.fold, state, { operator: OP, lift: LIFT });
  const refusal = held.companies[0].refusals.find((x) => x.correction === 'C9');
  assert.equal(refusal?.userId, U_MEMBER, JSON.stringify(held.companies[0].refusals));
  assert.match(refusal.wayOut, /--remove/);
  assert.equal(held.liftable, false);

  /* The customer confirms the person has left: the lift's own removal, and the lift is possible. */
  const removed = foldToPlan(r.fold, state, { operator: OP, lift: { ...LIFT, remove: [M_MEMBER] } });
  assert.deepEqual(removed.companies[0].corrections.map((c) => c.id), ['C3']);
  assert.equal(removed.liftable, true, JSON.stringify(removed.companies[0].refusals));
});

test('E7X-C-F8: the same not-yet-applicable account in ANOTHER company does not hold this lift, and the lift’s options reach only its own company', () => {
  const r = recovery([
    ['company.provision', { companyId: A, auditId: 1, actor: OP }],
    ['company.provision', { companyId: B, auditId: 2, actor: OP }],
    ['account.delete', { userId: U_OTHER, reason: 'unclaimed_invitation', auditId: 3, actor: OP }],
  ]);
  const state = {
    companies: [
      company({ memberships: [member(M_ADMIN, U_ADMIN, ['member', 'company_admin'])] }),
      company({
        id: B,
        slug: 'company-b',
        memberships: [member(M_B_ADMIN, uuid(15), ['member', 'company_admin']), member(M_OTHER, U_OTHER, ['member'])],
        invitationsPending: [uuid(16)],
      }),
    ],
    factors: [],
    accounts: [{ userId: U_OTHER, memberships: 1 }],
  };
  const lift = foldToPlan(r.fold, state, { operator: OP, lift: { ...LIFT, remove: [M_OTHER] } });
  const a = lift.companies.find((c) => c.id === A);
  const b = lift.companies.find((c) => c.id === B);
  assert.equal(lift.companies.length, 2, 'the whole recovery is planned');
  assert.ok(lift.reports.some((x) => x.kind === 'account_held' && x.userId === U_OTHER));
  assert.equal(a.refusals.some((x) => x.correction === 'C9'), false, 'B’s member’s account does not hold A');
  /* --remove names B's membership, and the lift is A's: it is refused in A and does nothing in B. */
  assert.equal(a.refusals.some((x) => x.correction === 'C3' && x.membershipId === M_OTHER), true);
  assert.deepEqual(b.corrections.map((c) => c.id), ['C5'], 'B is planned as plan plans it, C5 and nothing of the lift');
  assert.equal(b.corrections.some((c) => c.viaLift), false);
});

// ---------------------------------------------------------------------------
// E7X-C-F8, the command: the critic's owner-connection fixture.
// ---------------------------------------------------------------------------

/**
 * A register under os.tmpdir() and an owner connection played by a child process: it answers the operator check,
 * the state read and the lift's audit-id read, and appends every statement it is sent to a file, so a test can
 * say which writes reached "the database".
 */
function commandFixture({ acts, state }) {
  const dir = scratch('cmd');
  const path = join(dir, 'register.jsonl');
  const store = fileStore(path);
  init(store);
  for (const [act, body] of acts) append(store, act, body);
  const statements = join(dir, 'statements.sql');
  const owner = join(dir, 'owner.cjs');
  writeFileSync(
    owner,
    `const fs=require('fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{` +
      `fs.appendFileSync(${JSON.stringify(statements)},s+'\\n');` +
      `if(s.includes('select count(*) from app.operators'))process.stdout.write('1');` +
      `else if(s.includes("'companies', coalesce"))process.stdout.write('@json '+${JSON.stringify(JSON.stringify(state))});` +
      `else if(s.includes("'auditId', (select max"))process.stdout.write('@json {"auditId":101}');` +
      `else process.stdout.write('');});`,
  );
  const env = { ...process.env, ENTERPRISE_REGISTER_PATH: path, ENTERPRISE_DB_PSQL: `exec node '${owner}'` };
  const run = (args) => {
    const r = spawnSync(process.execPath, [join(REPO, 'scripts/reconcile.mjs'), ...args], { env, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '', output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const sent = () => (existsSync(statements) ? readFileSync(statements, 'utf8') : '');
  return { store, path, run, sent };
}
const heldState = (factors) => ({
  companies: [company({ memberships: [member(M_ADMIN, U_ADMIN, ['member', 'company_admin'])] })],
  factors,
  accounts: [{ userId: U_ADMIN, memberships: 1 }],
  auditMax: 100,
});
const events = (r, name) =>
  r.stdout
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === name);
const LIFT_ARGS = ['lift', '--operator', OP, '--company', A, '--confirmation', 'synthetic:confirmed'];

test('E7X-C-F8: with the recovery gates failing, plan refuses AND SO DOES THE LIFT, which writes nothing', () => {
  /* The critic's command fixture: no restore.begin, so gate 2 fails. plan refused; lift --apply exited 0 and sent
     the active update. */
  const f = commandFixture({
    acts: [
      ['company.provision', { companyId: A, auditId: 1, actor: OP }],
      ['factor.delete', { userId: U_ADMIN, factorId: FACTOR, actor: OP, ref: 'synthetic:factor' }],
    ],
    state: heldState([{ userId: U_ADMIN, factorId: FACTOR }]),
  });
  const anchor = f.store.readHead();
  const plan = f.run(['plan', '--operator', OP, '--closed-target', '--anchored-head', anchor]);
  assert.equal(plan.status, 1, plan.output);
  assert.ok(events(plan, 'gate_refused').length > 0);

  const lift = f.run([...LIFT_ARGS, '--anchored-head', anchor, '--apply']);
  assert.equal(lift.status, 1, lift.output);
  assert.ok(events(lift, 'gate_refused').some((e) => /no recovery epoch is open/.test(e.rule)), lift.output);
  assert.equal(f.sent().includes("set status = 'active'"), false, 'no lift was sent to the database');
  assert.equal(verify(f.store.read()).lines.some((l) => l.act === 'company.hold_lift'), false, 'no register line');

  /* And the critic's exact command, which carried no anchored head at all: refused before anything is opened. */
  const bare = f.run([...LIFT_ARGS, '--apply']);
  assert.equal(bare.status, 2, bare.output);
  assert.match(bare.output, /lift needs --anchored-head/);
  assert.equal(f.sent().includes("set status = 'active'"), false);
});

test('E7X-C-F8: with the gates passing, a lift with a recorded factor deletion owed refuses and names it; once applied, it lifts', () => {
  const acts = [
    ['company.provision', { companyId: A, auditId: 1, actor: OP }],
    ['factor.delete', { userId: U_ADMIN, factorId: FACTOR, actor: OP, ref: 'synthetic:factor' }],
    ['register.sync', { watermarkAuditId: 1, watermarkAt: T(60) }],
    ['restore.begin', { backupAt: T(50), auditFloor: 2, actor: OP }],
  ];
  const owed = commandFixture({ acts, state: heldState([{ userId: U_ADMIN, factorId: FACTOR }]) });
  const anchor = owed.store.readHead();
  const dry = owed.run([...LIFT_ARGS, '--anchored-head', anchor]);
  assert.equal(dry.status, 0, dry.output);
  const named = events(dry, 'plan_refusal').find((e) => e.correction === 'C8');
  assert.equal(named?.factorId, FACTOR, dry.output);

  const refused = owed.run([...LIFT_ARGS, '--anchored-head', anchor, '--apply']);
  assert.equal(refused.status, 1, refused.output);
  assert.match(refused.output, /1 factor \(C8\) and 0 account \(C9\)/);
  assert.equal(owed.sent().includes("set status = 'active'"), false, 'nothing was lifted');
  assert.equal(verify(owed.store.read()).lines.at(-1).act, 'restore.begin', 'and no register line was written');

  /* The control, the same register against a target apply has already corrected. */
  const clean = commandFixture({ acts, state: heldState([]) });
  const lifted = clean.run([...LIFT_ARGS, '--anchored-head', clean.store.readHead(), '--apply']);
  assert.equal(lifted.status, 0, lifted.output);
  assert.equal(clean.sent().includes("set status = 'active'"), true);
  assert.equal(verify(clean.store.read()).lines.at(-1).act, 'company.hold_lift');
});

// ---------------------------------------------------------------------------
// E7X-C-F1: a missing local head is a refusal, with gap as the one way on.
// ---------------------------------------------------------------------------

function registerCli(path, args) {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts/register.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ENTERPRISE_REGISTER_PATH: path, ENTERPRISE_DB_PSQL: 'false' },
  });
  return { status: r.status, stdout: r.stdout ?? '', output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('E7X-C-F1: a cut tail with its head file removed no longer verifies against an older anchored head', () => {
  /* The critic's register probe: a tombstone appended, the tail cut, the head removed, and verify against the
     anchor taken before the tombstone exited 0 with the tombstone gone. */
  const dir = scratch('head');
  const path = join(dir, 'register.jsonl');
  const store = fileStore(path);
  assert.equal(registerCli(path, ['init']).status, 0);
  const anchor = store.readHead();
  append(store, 'company.delete', {
    companyId: A,
    reason: 'customer_instruction',
    ref: 'synthetic:delete',
    rows: 1,
    auditId: 1500,
    actor: OP,
  });
  writeFileSync(path, `${store.read().split('\n')[0]}\n`);
  assert.equal(registerCli(path, ['verify']).status, 1, 'the cut tail fails its local head');
  unlinkSync(`${path}.head`);

  const cut = registerCli(path, ['verify', '--anchored-head', anchor]);
  assert.equal(cut.status, 1, cut.output);
  assert.equal(cut.stdout.includes('register_verified'), false);
  assert.match(cut.output, /the local head is missing/);
  assert.match(cut.output, /register\.mjs gap/, 'and the refusal names the one way on');
  /* The pure check says the same for any caller that hands it the store's null. */
  const state = verify(store.read(), { localHead: store.readHead(), anchoredHead: anchor });
  assert.equal(state.ok, false);
  assert.match(state.problems[0].rule, /the local head is missing/);
});

test('E7X-C-F1: every append refuses without a local head, and nothing reaches the file', () => {
  const dir = scratch('head-append');
  const path = join(dir, 'register.jsonl');
  const store = fileStore(path);
  init(store);
  append(store, 'company.provision', { companyId: A, auditId: 1, actor: OP });
  unlinkSync(`${path}.head`);
  const before = store.read();
  assert.throws(
    () => append(store, 'company.provision', { companyId: B, auditId: 2, actor: OP }),
    (e) => e instanceof RegisterError && /does not verify/.test(e.rule) && /local head is missing/.test(e.first),
  );
  assert.throws(
    () => appendMany(store, [{ act: 'company.provision', companyId: B, auditId: 2, actor: OP }]),
    (e) => e instanceof RegisterError && /local head is missing/.test(e.first),
  );
  const cli = registerCli(path, [
    'append', '--act', 'factor.delete', '--user-id', U_ADMIN, '--factor-id', FACTOR, '--ref', 'synthetic:factor', '--operator', OP,
  ]);
  assert.equal(cli.status, 1, cli.output);
  assert.match(cli.output, /the local head is missing/);
  assert.equal(store.read(), before, 'nothing was appended');
  assert.equal(existsSync(`${path}.head`), false, 'and no head was invented');
});

test('E7X-C-F1: gap is the one way on, only with an anchored head the file contains, and it writes a new head', () => {
  const dir = scratch('head-gap');
  const path = join(dir, 'register.jsonl');
  const store = fileStore(path);
  init(store);
  append(store, 'company.provision', { companyId: A, auditId: 1, actor: OP });
  append(store, 'register.sync', { watermarkAuditId: 1, watermarkAt: T(60) });
  const anchor = store.readHead();
  unlinkSync(`${path}.head`);

  /* Without the anchored head, gap refuses too: nothing then says the file holds what the workspace recorded. */
  const bare = registerCli(path, ['gap', '--ref', 'synthetic:hand-reconciliation', '--operator', OP, '--audit-floor', '2']);
  assert.equal(bare.status, 1, bare.output);
  assert.match(bare.output, /the local head is missing/);
  /* With an anchored head the file does not contain, it refuses on that. */
  const wrong = registerCli(path, [
    'gap', '--ref', 'synthetic:hand-reconciliation', '--operator', OP, '--audit-floor', '2', '--anchored-head', `1:${'a'.repeat(64)}`,
  ]);
  assert.equal(wrong.status, 1, wrong.output);
  assert.match(wrong.output, /anchored head/);

  const gap = registerCli(path, [
    'gap', '--ref', 'synthetic:hand-reconciliation', '--operator', OP, '--audit-floor', '2', '--anchored-head', anchor,
  ]);
  assert.equal(gap.status, 0, gap.output);
  const lines = verify(store.read()).lines;
  assert.deepEqual(lines.slice(-2).map((l) => l.act), ['restore.begin', 'restore.gap']);
  assert.equal(existsSync(`${path}.head`), true, 'gap wrote a new head at the gap line');
  assert.equal(registerCli(path, ['verify', '--anchored-head', anchor]).status, 0, 'and the register verifies again');
  /* The head gap writes cannot be used to skip the gap: an ordinary append now needs the head it wrote. */
  assert.equal(verify(store.read(), { localHead: store.readHead() }).ok, true);
});

test('E7X-C-F1: a gap over a lost head may write only the gap’s own lines, and only when the head is actually absent', () => {
  const dir = scratch('head-rule');
  const store = fileStore(join(dir, 'register.jsonl'));
  init(store);
  const anchor = store.readHead();
  /* The head is present: the option refuses rather than skipping a head that exists. */
  assert.throws(
    () => append(store, 'restore.gap', { ref: 'synthetic:x', actor: OP }, { anchoredHead: anchor, headLost: true }),
    (e) => e instanceof RegisterError && /not lost/.test(e.rule),
  );
  unlinkSync(`${store.path}.head`);
  assert.throws(
    () => append(store, 'company.provision', { companyId: A, auditId: 1, actor: OP }, { anchoredHead: anchor, headLost: true }),
    (e) => e instanceof RegisterError && /only a gap/.test(e.rule),
  );
  assert.throws(
    () => append(store, 'restore.gap', { ref: 'synthetic:x', actor: OP }, { headLost: true }),
    (e) => e instanceof RegisterError && /anchored head/.test(e.rule),
  );
});

// ---------------------------------------------------------------------------
// E7X-C-F3: the epoch is the register's to compute, never a body's.
// ---------------------------------------------------------------------------

function memoryStore() {
  let text = null;
  let head = null;
  let tick = 0;
  return {
    get text() {
      return text;
    },
    read: () => text,
    readHead: () => head,
    create: (t) => {
      text = t;
    },
    append: (t) => {
      text += t;
    },
    writeHead: (t) => {
      head = t.trim();
    },
    now: () => new Date(Date.parse('2026-10-01T08:00:00.000Z') + 1000 * tick++).toISOString(),
  };
}

test('E7X-C-F3: a body carrying `epoch` is refused by append and by appendMany, and nothing is written', () => {
  const store = memoryStore();
  init(store);
  const before = store.read();
  assert.throws(
    () => appendMany(store, [{ act: 'register.sync', epoch: 44, watermarkAuditId: 1500, watermarkAt: T(60) }]),
    (e) => e instanceof RegisterError && e.key === 'epoch',
  );
  assert.throws(
    () => append(store, 'register.sync', { epoch: 44, watermarkAuditId: 1500, watermarkAt: T(60) }),
    (e) => e instanceof RegisterError && e.key === 'epoch',
  );
  /* The other line fields are the register's too: none of them can be carried in a body. */
  for (const key of ['v', 'seq', 'at', 'act', 'prev'])
    assert.throws(
      () => append(store, 'register.sync', { [key]: 1, watermarkAuditId: 1500, watermarkAt: T(60) }),
      (e) => e instanceof RegisterError && e.key === key,
      key,
    );
  assert.equal(store.read(), before);
  assert.equal(fold(verify(store.read()).lines).epoch, 0);
});

test('E7X-C-F3: verify refuses an epoch that moves anywhere but at restore.begin, and by one', () => {
  const lines = [];
  let prev = ZERO_PREV;
  const push = (seq, epoch, act, body) => {
    const raw = serialize({ seq, epoch, at: T(seq), act, prev, ...body });
    lines.push(raw);
    prev = sha256(raw);
  };
  push(0, 0, 'register.open', {});
  push(1, 44, 'register.sync', { watermarkAuditId: 1500, watermarkAt: T(60) });
  const jumped = verify(`${lines.join('\n')}\n`);
  assert.equal(jumped.ok, false, 'the critic’s jump from 0 to 44 with no restore.begin');
  assert.equal(jumped.problems[0].at, 1);
  assert.match(jumped.problems[0].rule, /epoch/);

  const build = (epochs) => {
    const out = [];
    let p = ZERO_PREV;
    const acts = [
      ['register.open', {}],
      ['restore.begin', { backupAt: T(1), auditFloor: 5, actor: OP }],
      ['register.sync', { watermarkAuditId: 5, watermarkAt: T(2) }],
    ];
    acts.forEach(([act, body], seq) => {
      const raw = serialize({ seq, epoch: epochs[seq], at: T(seq), act, prev: p, ...body });
      out.push(raw);
      p = sha256(raw);
    });
    return verify(`${out.join('\n')}\n`);
  };
  assert.equal(build([0, 1, 1]).ok, true, 'the control: restore.begin opens exactly one epoch');
  assert.equal(build([0, 2, 2]).ok, false, 'a restore.begin that skips an epoch');
  assert.equal(build([0, 1, 0]).ok, false, 'an epoch that goes back');
  assert.equal(build([1, 2, 2]).ok, false, 'a register that does not start at epoch 0');
});

// ---------------------------------------------------------------------------
// E7X-C-F7: an access period is narrowed date by date, never as one tuple.
// ---------------------------------------------------------------------------

test('E7X-C-F7: a register period with an earlier end and LATER export and delete dates is refused, and no date is widened', () => {
  /* The critic's isolated fixture: C2 was planned and its SQL wrote the later export deadline. */
  const stamp = (n) => `2026-${String(n).padStart(2, '0')}-01T00:00:00.000Z`;
  const r = recovery([
    [
      'company.set_access_period',
      { companyId: A, startsAt: stamp(1), endsAt: stamp(3), exportBy: stamp(10), deleteBy: stamp(11), auditId: 20, actor: OP },
    ],
  ]);
  const restored = { startsAt: stamp(1), endsAt: stamp(4), exportBy: stamp(5), deleteBy: stamp(6) };
  const plan = foldToPlan(r.fold, { companies: [company({ period: restored })], factors: [], accounts: [] }, { operator: OP });
  const c = plan.companies[0];
  assert.deepEqual(c.corrections.map((x) => x.id), [], 'no C2 is planned');
  assert.equal(c.refusals.length, 1);
  assert.equal(c.refusals[0].correction, 'C2');
  assert.match(c.refusals[0].rule, /earlier on some dates and later on others/);
  assert.match(c.refusals[0].wayOut, /api\.set_access_period/);
  for (const x of c.corrections) assert.equal(transactionSql(x).includes(stamp(10)), false);

  /* Neither does the lift's --agreement apply it: a mixed period is not an extension either. */
  const lifted = foldToPlan(r.fold, { companies: [company({ period: restored })], factors: [], accounts: [] }, {
    operator: OP,
    lift: { ...LIFT, agreement: 'synthetic:agreement' },
  });
  assert.deepEqual(lifted.companies[0].corrections.map((x) => x.id), []);
  assert.equal(lifted.companies[0].refusals[0].correction, 'C2');
});

test('E7X-C-F7: componentwise, each date only earlier (and the start only later) is a narrowing; each only later is an extension', () => {
  const P = { startsAt: T(0), endsAt: T(1000), exportBy: T(1336), deleteBy: T(2056) };
  const planFor = (want, row, lift) => {
    const r = recovery([['company.set_access_period', { companyId: A, ...want, auditId: 21, actor: OP }]]);
    return foldToPlan(r.fold, { companies: [company({ period: row })], factors: [], accounts: [] }, {
      operator: OP,
      ...(lift ? { lift } : {}),
    }).companies[0];
  };
  /* One date earlier, the rest equal: a narrowing, and only that date moves. */
  const oneEarlier = planFor({ ...P, deleteBy: T(2000) }, P);
  assert.equal(oneEarlier.corrections[0]?.direction, 'narrowing');
  /* The start later and the end earlier: both narrow access, so a narrowing. */
  assert.equal(planFor({ ...P, startsAt: T(10), endsAt: T(900) }, P).corrections[0]?.direction, 'narrowing');
  /* The start EARLIER with every end equal widens access: an extension, the lift's --agreement and never apply's. */
  const earlierStart = planFor({ ...P, startsAt: T(-10) }, P);
  assert.deepEqual(earlierStart.corrections, []);
  assert.match(earlierStart.refusals[0].rule, /extension made after the backup/);
  /* Every date later: the E7D-C-F5 extension, unchanged. */
  const later = { startsAt: T(0), endsAt: T(1100), exportBy: T(1436), deleteBy: T(2156) };
  assert.match(planFor(later, P).refusals[0].rule, /extension made after the backup/);
  assert.equal(planFor(later, P, { ...LIFT, agreement: 'synthetic:agreement' }).corrections[0]?.direction, 'agreement_recovery');
  /* The same period: nothing. */
  assert.deepEqual(planFor(P, P).corrections, []);
  assert.deepEqual(planFor(P, P).refusals, []);
});
