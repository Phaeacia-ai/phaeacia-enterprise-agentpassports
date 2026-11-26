/* E7 design 1.3 and section 5 cases E7-15 and E7-30's unit half: the register's line shapes, its chain, its two
   heads, the fork, the sync's plan keyed by (epoch, auditId) and the fold. Pure: the store is an object in memory
   and the clock is injected, so every line in every case has a fixed `at` and the whole file is deterministic.

   The two fail-befores E7-30 requires are MUTANTS OF THE PLANNER, built here and run against the same fixtures:
   M-D1 de-duplicates by the audit id alone, which drops the first acts after a recovery, and M-W1 reads a window
   of the last 1,000 ids, which drops a late commit. Each is shown accepting the counterexample and the real
   planner refusing it.

   Nothing here touches a disk, a database or a network. Every id is synthetic and every `ref` is of the
   `synthetic`/`example-` shape scripts/check-secrets.mjs excludes. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  ACT_COPY_DISCARDED,
  ACT_COPY_TAKEN,
  ACTS,
  append,
  appendMany,
  checkBody,
  compareCopies,
  fold,
  FORMAT_VERSION,
  GRANTING_ACTS,
  init,
  parseHead,
  parseLines,
  RegisterError,
  serialize,
  sha256,
  SYNCED_ACTIONS,
  syncPlan,
  verify,
  ZERO_PREV,
} from '../../../lib/operator/register.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const C1 = uuid(1);
const C2 = uuid(2);
const OP = uuid(9);
const M1 = uuid(11);
const U1 = uuid(21);
const R1 = uuid(31);
const F1 = uuid(41);

/** The injected store: the file, the head and a clock, all in memory. */
function memory(startAt = Date.parse('2026-10-01T08:00:00.000Z')) {
  let text = null;
  let head = null;
  let tick = 0;
  return {
    get text() {
      return text;
    },
    set text(v) {
      text = v;
    },
    get headText() {
      return head;
    },
    set headText(v) {
      head = v;
    },
    read: () => text,
    readHead: () => head,
    create: (t) => {
      if (text !== null) throw new Error('exists');
      text = t;
    },
    append: (t) => {
      text += t;
    },
    writeHead: (t) => {
      head = t.trim();
    },
    now: () => new Date(startAt + 1000 * tick++).toISOString(),
  };
}

/** A register of ten lines: the open, then nine acts that between them use most of the field shapes. */
function tenLines() {
  const store = memory();
  init(store);
  appendMany(store, [
    { act: 'company.provision', companyId: C1, auditId: 1000, actor: OP },
    {
      act: 'company.set_access_period',
      companyId: C1,
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2026-12-31T00:00:00.000Z',
      exportBy: '2027-01-14T00:00:00.000Z',
      deleteBy: '2027-02-13T00:00:00.000Z',
      auditId: 1001,
      actor: OP,
    },
    { act: 'company.set_quota', companyId: C1, quotaName: 'agents_per_company', quotaValue: 25, auditId: 1002, actor: OP },
    { act: 'membership.set_roles', companyId: C1, membershipId: M1, rolesAfter: ['member'], auditId: 1003, actor: OP },
    { act: 'membership.remove', companyId: C1, membershipId: M1, auditId: 1004, actor: OP },
    { act: 'release.withdraw', companyId: C1, releaseId: R1, byUserId: U1, auditId: 1005 },
    { act: 'company.suspend', companyId: C1, reason: 'non_payment', statusAfter: 'suspended', auditId: 1006, actor: OP },
    { act: 'company.close', companyId: C1, reason: 'customer_instruction', statusAfter: 'closed', auditId: 1007, actor: OP },
    { act: 'register.sync', watermarkAuditId: 1007, watermarkAt: '2026-10-01T09:00:00.000Z' },
  ]);
  return store;
}

const linesOf = (text) => text.slice(0, -1).split('\n');
const rebuild = (lines) => `${lines.join('\n')}\n`;

// ---------------------------------------------------------------------------
// The line shapes: every act of design 1.3's table, and the refusal of anything else.
// ---------------------------------------------------------------------------

test('design 1.3: every act of the table exists, with the fields the table names and in its order', () => {
  assert.equal(Object.keys(ACTS).length, 24);
  assert.deepEqual(Object.keys(ACTS[ACT_COPY_TAKEN].fields), [
    'companyId',
    'ref',
    'sha256',
    'bytes',
    'rows',
    'auditId',
    'actor',
  ]);
  assert.deepEqual(Object.keys(ACTS['company.set_access_period'].fields), [
    'companyId',
    'startsAt',
    'endsAt',
    'exportBy',
    'deleteBy',
    'auditId',
    'actor',
  ]);
  /* The two act words the import gate will not let lib/ spell are pinned here, where tests/ may spell them. */
  assert.equal(ACT_COPY_TAKEN, 'company.export');
  assert.equal(ACT_COPY_DISCARDED, 'export.discarded');
  /* The design names three grants; the lift is here beside them because it widens from `held` and its authority
     is the customer's confirmation at the time and not the register (the module's comment says why). */
  assert.deepEqual(GRANTING_ACTS, ['company.resume', 'membership.transfer_first_admin', 'company.hold_lift']);
  assert.equal(SYNCED_ACTIONS.length, 17);
});

test('design 1.3: a line carries EXACTLY its act’s fields; any other key is refused', () => {
  /* E7-15's "an append carrying a `name` key". A company's name, a slug, an address and a withdrawal reason have
     no field at all, which is what keeps customer content out by construction. */
  for (const key of ['name', 'slug', 'email', 'displayName', 'withdrawalReason', 'content']) {
    assert.throws(
      () => checkBody('company.provision', { companyId: C1, auditId: 1, actor: OP, [key]: 'x' }),
      (e) => e instanceof RegisterError && e.rule === 'this act has no such field' && e.key === key,
    );
  }
  assert.throws(
    () => checkBody('company.invent', { companyId: C1 }),
    (e) => e instanceof RegisterError && e.rule === 'unknown act',
  );
});

test('design 1.3: every field shape, each refused by one value outside it', () => {
  const good = { companyId: C1, auditId: 1, actor: OP };
  assert.deepEqual(checkBody('company.provision', good), good);
  const bad = [
    ['company.provision', { ...good, companyId: '0000000A-0000-4000-8000-000000000001' }, 'companyId'],
    ['company.provision', { ...good, auditId: -1 }, 'auditId'],
    ['company.provision', { ...good, auditId: 1.5 }, 'auditId'],
    ['company.suspend', { companyId: C1, reason: 'Not A Reason', statusAfter: 'suspended', auditId: 1, actor: OP }, 'reason'],
    ['company.suspend', { companyId: C1, reason: 'non_payment', statusAfter: 'deleted', auditId: 1, actor: OP }, 'statusAfter'],
    ['membership.set_roles', { companyId: C1, membershipId: M1, rolesAfter: ['owner'], auditId: 1, actor: OP }, 'rolesAfter'],
    ['membership.set_roles', { companyId: C1, membershipId: M1, rolesAfter: [], auditId: 1, actor: OP }, 'rolesAfter'],
    ['company.set_quota', { companyId: C1, quotaName: 'seats', quotaValue: 1, auditId: 1, actor: OP }, 'quotaName'],
    ['key.replace', { kidBefore: 'a b', kidAfter: 'k2', actor: OP }, 'kidBefore'],
    [ACT_COPY_DISCARDED, { companyId: C1, sha256: 'AB', actor: OP }, 'sha256'],
    ['restore.gap', { ref: 'has a space', actor: OP }, 'ref'],
    ['restore.gap', { ref: 'x'.repeat(81), actor: OP }, 'ref'],
    ['restore.begin', { backupAt: 'yesterday', auditFloor: 1, actor: OP }, 'backupAt'],
  ];
  for (const [act, body, key] of bad)
    assert.throws(
      () => checkBody(act, body),
      (e) => e instanceof RegisterError && e.rule === 'field is outside its shape' && e.key === key,
      `${act}.${key}`,
    );
});

test('design 1.3: a newline in a reference is refused, so no line can carry one', () => {
  assert.throws(() => checkBody('restore.gap', { ref: 'synthetic:2026-10-02\nsecond line', actor: OP }), RegisterError);
});

test('E7D-C-F5: a period whose starts_at the register could not read is written null, never invented', () => {
  const body = {
    companyId: C1,
    startsAt: null,
    endsAt: '2026-12-31T00:00:00.000Z',
    exportBy: '2027-01-14T00:00:00.000Z',
    deleteBy: '2027-02-13T00:00:00.000Z',
    auditId: 5,
    actor: OP,
  };
  assert.deepEqual(checkBody('company.set_access_period', body), body);
  assert.equal(fold([{ seq: 0, epoch: 0, act: 'company.set_access_period', at: 'x', ...body }]).companies[C1].accessPeriodStartsAtMissing, true);
});

test('design 1.3: a deletion for customer_instruction needs a reference; a retention deadline does not', () => {
  const base = { companyId: C1, reason: 'retention_deadline', rows: 10, auditId: 7, actor: OP };
  assert.deepEqual(checkBody('company.delete', base), base);
  assert.throws(
    () => checkBody('company.delete', { ...base, reason: 'customer_instruction' }),
    (e) => e instanceof RegisterError && e.rule === 'this reason needs an instruction reference',
  );
  const withRef = { ...base, reason: 'customer_instruction', ref: 'synthetic:2026-10-02/1' };
  assert.equal(checkBody('company.delete', withRef).ref, 'synthetic:2026-10-02/1');
});

test('design 1.3: a factor deletion carries EXACTLY one of the operations-log reference and the audit id', () => {
  const base = { userId: U1, factorId: F1, actor: OP };
  assert.ok(checkBody('factor.delete', { ...base, ref: 'opslog:2026-10-03/1' }));
  assert.ok(checkBody('factor.delete', { ...base, auditId: 12 }));
  for (const body of [base, { ...base, ref: 'opslog:2026-10-03/1', auditId: 12 }])
    assert.throws(
      () => checkBody('factor.delete', body),
      (e) => e instanceof RegisterError && e.rule === 'exactly one of these fields',
    );
});

test('design 1.3: the six fields come first in their order and prev is last', () => {
  const raw = serialize({ seq: 3, epoch: 1, at: '2026-10-01T08:00:00.000Z', act: 'company.provision', prev: ZERO_PREV, companyId: C1, auditId: 4, actor: OP });
  assert.deepEqual(Object.keys(JSON.parse(raw)), ['v', 'seq', 'epoch', 'at', 'act', 'companyId', 'auditId', 'actor', 'prev']);
  assert.equal(JSON.parse(raw).v, FORMAT_VERSION);
});

// ---------------------------------------------------------------------------
// E7-15: the chain, the two heads, the fork, and the two refused appends.
// ---------------------------------------------------------------------------

test('E7-15 control: the untouched file verifies with both heads', () => {
  const store = tenLines();
  const state = verify(store.text, { localHead: store.headText });
  assert.equal(state.ok, true, JSON.stringify(state.problems));
  assert.equal(state.count, 10);
  const anchored = `${state.head.seq}:${state.head.sha256}`;
  assert.equal(verify(store.text, { localHead: store.headText, anchoredHead: anchored }).ok, true);
  /* And an anchor taken EARLIER, at line 4, is still contained in the file. */
  const line4 = linesOf(store.text)[4];
  assert.equal(verify(store.text, { localHead: store.headText, anchoredHead: `4:${sha256(line4)}` }).ok, true);
});

test('E7-15: one byte of line 3 of 10 changed: verify fails AT LINE 4, where the chain first disagrees', () => {
  const store = tenLines();
  const lines = linesOf(store.text);
  lines[3] = lines[3].replace('"quotaValue":25', '"quotaValue":26');
  const state = verify(rebuild(lines), { localHead: store.headText });
  assert.equal(state.ok, false);
  assert.equal(state.problems[0].at, 4);
  assert.match(state.problems[0].rule, /chain is broken/);
});

test('E7-15: a line removed from the middle is refused', () => {
  const store = tenLines();
  const lines = linesOf(store.text);
  lines.splice(5, 1);
  const state = verify(rebuild(lines), { localHead: store.headText });
  assert.equal(state.ok, false);
  assert.equal(state.problems[0].at, 5);
});

test('E7-15: two lines swapped are refused', () => {
  const store = tenLines();
  const lines = linesOf(store.text);
  [lines[6], lines[7]] = [lines[7], lines[6]];
  const state = verify(rebuild(lines), { localHead: store.headText });
  assert.equal(state.ok, false);
  assert.equal(state.problems[0].at, 6);
});

test('E7-15: the tail removed fails the LOCAL head; with the head rewritten to match it fails the ANCHORED head', () => {
  const store = tenLines();
  const anchored = `${9}:${sha256(linesOf(store.text)[9])}`;
  const lines = linesOf(store.text).slice(0, 9);
  const truncated = rebuild(lines);

  /* The chain of what is left is intact, which is exactly what the local head exists for. */
  assert.equal(verify(truncated).ok, true, 'the remaining lines still chain');
  const withOldHead = verify(truncated, { localHead: store.headText });
  assert.equal(withOldHead.ok, false);
  assert.match(withOldHead.problems[0].rule, /does not end at its local head/);

  /* Now the attacker rewrites the local head too. The chain passes, the local head passes, the ANCHORED head does
     not, because line 9 is not in the file any more. */
  const rewrittenHead = `8:${sha256(lines[8])}`;
  assert.equal(verify(truncated, { localHead: rewrittenHead }).ok, true, 'the local head alone no longer catches it');
  const withAnchor = verify(truncated, { localHead: rewrittenHead, anchoredHead: anchored });
  assert.equal(withAnchor.ok, false);
  assert.match(withAnchor.problems[0].rule, /does not contain the anchored head/);
});

test('E7-15: the whole file replaced by a VALID new chain passes its own chain and local head and fails the anchored head', () => {
  const original = tenLines();
  const anchored = `${9}:${sha256(linesOf(original.text)[9])}`;
  const replacement = memory(Date.parse('2026-11-01T08:00:00.000Z'));
  init(replacement);
  appendMany(replacement, [
    { act: 'company.provision', companyId: C2, auditId: 1000, actor: OP },
    { act: 'company.set_quota', companyId: C2, quotaName: 'agents_per_company', quotaValue: 99, auditId: 1001, actor: OP },
  ]);
  const state = verify(replacement.text, { localHead: replacement.headText });
  assert.equal(state.ok, true, 'a replacement chain is internally perfect');
  const withAnchor = verify(replacement.text, { localHead: replacement.headText, anchoredHead: anchored });
  assert.equal(withAnchor.ok, false);
  assert.match(withAnchor.problems[0].rule, /does not contain the anchored head/);
});

test('E7-15: a workspace copy diverging at line 8 is reported as a FORK, and a prefix is not', () => {
  const store = tenLines();
  const lines = linesOf(store.text);
  assert.deepEqual(compareCopies(store.text, store.text), { relation: 'equal', at: 10 });
  assert.deepEqual(compareCopies(rebuild(lines.slice(0, 6)), store.text), { relation: 'prefix', at: 6, shorter: 'a' });
  const forked = [...lines];
  forked[8] = lines[8].replace('"customer_instruction"', '"operator_request"');
  const c = compareCopies(store.text, rebuild(forked));
  assert.equal(c.relation, 'fork');
  assert.equal(c.at, 8);
});

test('E7-15: EVERY WRITER refuses while verification fails, and the two refused appends never reach the file', () => {
  /* A tampered file: an append must not extend it. */
  const store = tenLines();
  const lines = linesOf(store.text);
  lines[3] = lines[3].replace('"quotaValue":25', '"quotaValue":26');
  store.text = rebuild(lines);
  const before = store.text;
  assert.throws(
    () => append(store, 'company.provision', { companyId: C2, auditId: 2000, actor: OP }),
    (e) => e instanceof RegisterError && e.rule === 'the register does not verify',
  );
  assert.equal(store.text, before, 'nothing was appended');

  /* An append carrying a key no act names, and one whose body is missing a required field: both refused, and a
     good file stays exactly as it was. */
  const clean = tenLines();
  const cleanBefore = clean.text;
  assert.throws(() => append(clean, 'company.provision', { companyId: C2, auditId: 2000, actor: OP, name: 'SYNTHETIC AG' }), RegisterError);
  assert.throws(() => append(clean, 'company.provision', { companyId: C2, actor: OP }), RegisterError);
  assert.equal(clean.text, cleanBefore, 'neither refused append reached the file');
});

test('E7-15: a line that is not canonical, a wrong version and a file without a final newline are each refused', () => {
  const store = tenLines();
  const lines = linesOf(store.text);
  /* Keys re-ordered but the same values: the chain would still pass at that line, the canonical check does not. */
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(lines[1])).reverse()));
  const withReordered = [...lines];
  withReordered[1] = reordered;
  assert.equal(verify(rebuild(withReordered)).ok, false);

  const wrongVersion = [...lines];
  wrongVersion[1] = lines[1].replace('"v":2', '"v":3');
  const v = verify(rebuild(wrongVersion));
  assert.equal(v.ok, false);
  assert.match(v.problems[0].rule, /format version/);

  /* A file that is not a register at all is REPORTED by verify, like every other gate-1 failure, so that every
     caller prints one refusal line for one fact. parseLines still throws for a direct caller. */
  const noNewline = verify(store.text.slice(0, -1));
  assert.equal(noNewline.ok, false);
  assert.match(noNewline.problems[0].rule, /newline/);
  assert.throws(() => parseLines(store.text.slice(0, -1)), (e) => e instanceof RegisterError && /newline/.test(e.rule));
  const notJson = verify('this is not a register\n');
  assert.equal(notJson.ok, false);
  assert.match(notJson.problems[0].rule, /not JSON/);
});

test('design 1.3: only restore.begin opens an epoch, and it opens exactly one', () => {
  const store = tenLines();
  append(store, 'restore.begin', { backupAt: '2026-10-01T07:00:00.000Z', auditFloor: 1100, actor: OP });
  const state = verify(store.text, { localHead: store.headText });
  assert.equal(state.ok, true);
  assert.equal(state.lines.at(-1).epoch, 1);
  append(store, 'restore.gap', { ref: 'synthetic:hand-reconciliation/1', actor: OP });
  assert.equal(verify(store.text).lines.at(-1).epoch, 1, 'a later line carries the new epoch');
  assert.throws(() => append(store, 'company.provision', { companyId: C2, auditId: 1200, actor: OP }, { epoch: 2 }), RegisterError);
});

test('design 1.3: parseHead refuses anything that is not SEQ:SHA256', () => {
  assert.deepEqual(parseHead(`9:${'a'.repeat(64)}`), { seq: 9, sha256: 'a'.repeat(64) });
  for (const bad of ['9', 'a:b', `9:${'A'.repeat(64)}`, `-1:${'a'.repeat(64)}`, '']) assert.throws(() => parseHead(bad), RegisterError);
});

// ---------------------------------------------------------------------------
// E7-30's unit half: the sync's plan, keyed by (epoch, auditId), with no window and with the reference rule.
// ---------------------------------------------------------------------------

const auditRow = (id, action, over = {}) => ({
  id,
  companyId: C1,
  actorUserId: OP,
  actorKind: 'operator',
  action,
  at: '2026-10-05T08:00:00.000Z',
  details: {},
  startsAt: null,
  ...over,
});

/** A register at epoch 0 holding audit ids up to 1,500, then a restore that opened epoch 1 with a floor of 1,501. */
function afterRestore(floor = 1501) {
  const store = memory();
  init(store);
  appendMany(store, [
    { act: 'company.provision', companyId: C1, auditId: 1000, actor: OP },
    { act: 'company.close', companyId: C1, reason: 'customer_instruction', statusAfter: 'closed', auditId: 1500, actor: OP },
    { act: 'register.sync', watermarkAuditId: 1500, watermarkAt: '2026-10-04T08:00:00.000Z' },
    { act: 'restore.begin', backupAt: '2026-10-04T07:00:00.000Z', auditFloor: floor, actor: OP },
  ]);
  return store;
}

test('E7-30: a deletion after a restore whose audit id the register already holds FROM EPOCH 0 is written, not dropped', () => {
  const store = afterRestore(1);
  const state = verify(store.text, { localHead: store.headText });
  const folded = fold(state.lines);
  assert.equal(folded.epoch, 1);

  /* The restored table's highest id is below 1,000, so the new deletion is handed id 1,000: an id the register
     ALREADY HOLDS from epoch 0, for a different act entirely. */
  const rows = [auditRow(1000, 'company.delete', { companyId: null, details: { company_id: C2, reason_code: 'retention_deadline', deleted_rows: 812 } })];
  const plan = syncPlan(rows, folded.epoch, folded.auditFloor, { existing: state.lines, watermarkAt: '2026-10-05T09:00:00.000Z' });
  assert.equal(plan.stopped, null);
  assert.deepEqual(
    plan.bodies.map((b) => b.act),
    ['company.delete', 'register.sync'],
  );
  assert.equal(plan.bodies[0].companyId, C2);
  assert.equal(plan.bodies[0].rows, 812);

  /* M-D1, the mutant of E7D-C-F2 a: de-duplication by the audit id alone. */
  const droppedByMutant = mutantDedupByAuditId(rows, state.lines);
  assert.deepEqual(droppedByMutant, [], 'the mutant plans nothing: the post-restore deletion is silently dropped');
});

test('E7-30: a commit whose id is below the last one read by more than 1,000 is written by the next sync', () => {
  const store = afterRestore(1);
  const state = verify(store.text, { localHead: store.headText });
  const folded = fold(state.lines);
  /* A long owner transaction took id 1,100 and committed after id 3,000 was already visible and synced. */
  const already = appendMany(store, [{ act: 'company.suspend', companyId: C1, reason: 'non_payment', statusAfter: 'suspended', auditId: 3000, actor: OP }]);
  void already;
  const lines = verify(store.text).lines;
  const rows = [
    auditRow(1100, 'membership.remove', { details: { membership_id: M1 } }),
    auditRow(3000, 'company.suspend', { details: { reason_code: 'non_payment', status_after: 'suspended' } }),
  ];
  const plan = syncPlan(rows, folded.epoch, folded.auditFloor, { existing: lines, watermarkAt: '2026-10-06T09:00:00.000Z' });
  assert.deepEqual(
    plan.bodies.map((b) => b.act),
    ['membership.remove', 'register.sync'],
    'the late commit is written and the already-held act is not written twice',
  );
  assert.equal(plan.bodies.at(-1).watermarkAuditId, 3000);

  /* M-W1, the mutant of E7D-C-F2 b: a window of the last 1,000 ids. */
  const windowed = mutantWindow(rows, lines, 1000);
  assert.deepEqual(windowed, [], 'the mutant plans nothing: the late commit is outside its window');
});

test('E7-30: a page deletion for customer_instruction STOPS the plan and names its audit id, until --ref', () => {
  const store = afterRestore(1);
  const state = verify(store.text, { localHead: store.headText });
  const folded = fold(state.lines);
  const rows = [
    auditRow(1101, 'membership.remove', { details: { membership_id: M1 } }),
    auditRow(1102, 'company.delete', { companyId: null, details: { company_id: C2, reason_code: 'customer_instruction', deleted_rows: 9 } }),
    auditRow(1103, 'company.set_quota', { details: { quota_name: 'groups_per_company', quota_value: 10 } }),
  ];
  const stopped = syncPlan(rows, folded.epoch, folded.auditFloor, { existing: state.lines, watermarkAt: '2026-10-06T09:00:00.000Z' });
  assert.deepEqual(stopped.stopped, { auditId: 1102, action: 'company.delete', need: 'ref' });
  assert.deepEqual(
    stopped.bodies.map((b) => b.act),
    ['membership.remove'],
    'every line BEFORE that row is written, and no watermark line, because the acts after it are not in the register',
  );

  const resumed = syncPlan(rows, folded.epoch, folded.auditFloor, {
    existing: state.lines,
    refs: { 1102: 'synthetic:2026-10-06/deletion-1' },
    watermarkAt: '2026-10-06T09:00:00.000Z',
  });
  assert.equal(resumed.stopped, null);
  assert.deepEqual(
    resumed.bodies.map((b) => b.act),
    ['membership.remove', 'company.delete', 'company.set_quota', 'register.sync'],
  );
  assert.equal(resumed.bodies[1].ref, 'synthetic:2026-10-06/deletion-1');
});

test('E7-30: a retention-deadline deletion needs no reference, because its authority is the period the register holds', () => {
  const store = afterRestore(1);
  const state = verify(store.text, { localHead: store.headText });
  const rows = [auditRow(1104, 'company.delete', { companyId: null, details: { company_id: C2, reason_code: 'retention_deadline', deleted_rows: 4 } })];
  const plan = syncPlan(rows, 1, 1, { existing: state.lines, watermarkAt: '2026-10-06T09:00:00.000Z' });
  assert.equal(plan.stopped, null);
  assert.equal(plan.bodies[0].ref, undefined);
});

test('E7-30: a whole-company copy the operator took needs a reference too, and the member’s own route is not read at all', () => {
  const store = afterRestore(1);
  const lines = verify(store.text).lines;
  const operatorCopy = auditRow(1200, ACT_COPY_TAKEN, {
    details: { company_id: C1, operator_user_id: OP, section_counts: { memberships: 3, agents: 2 }, serialized_bytes: 4096, withheld_rows: 0 },
  });
  const stopped = syncPlan([operatorCopy], 1, 1, { existing: lines, watermarkAt: '2026-10-06T09:00:00.000Z' });
  assert.deepEqual(stopped.stopped, { auditId: 1200, action: ACT_COPY_TAKEN, need: 'ref' });
  const resumed = syncPlan([operatorCopy], 1, 1, { existing: lines, refs: { 1200: 'synthetic:2026-10-06/copy-1' }, watermarkAt: '2026-10-06T09:00:00.000Z' });
  assert.equal(resumed.stopped, null);
  /* The sync writes this line only where the script's own append failed, so there is no file and no hash. */
  assert.equal(resumed.bodies[0].sha256, null);
  assert.equal(resumed.bodies[0].rows, 5);
  assert.equal(resumed.bodies[0].bytes, 4096);
});

test('E7-30: every sync ends with a watermark line, and a sync that read nothing still writes one at the floor', () => {
  const store = afterRestore(1);
  const lines = verify(store.text).lines;
  const plan = syncPlan([], 1, 1501, { existing: lines, watermarkAt: '2026-10-06T09:00:00.000Z' });
  assert.deepEqual(plan.bodies, [{ act: 'register.sync', watermarkAuditId: 1501, watermarkAt: '2026-10-06T09:00:00.000Z' }]);
});

test('design 1.3: rows below the floor and actions the register does not carry are not read', () => {
  const rows = [
    auditRow(5, 'company.provision'),
    auditRow(1600, 'invitation.create'),
    auditRow(1601, 'candidate.submit'),
    auditRow(1602, 'company.provision'),
  ];
  const plan = syncPlan(rows, 1, 1501, { existing: [], watermarkAt: '2026-10-06T09:00:00.000Z' });
  assert.deepEqual(
    plan.bodies.map((b) => b.act),
    ['company.provision', 'register.sync'],
  );
  assert.equal(plan.bodies[0].auditId, 1602);
  assert.equal(plan.read, 1);
});

/* M-D1: de-duplicate by the audit id ALONE, which is the design's first version (E7D-C-F2 a). */
function mutantDedupByAuditId(rows, existing) {
  const held = new Set(existing.filter((l) => typeof l.auditId === 'number').map((l) => l.auditId));
  return rows.filter((r) => !held.has(r.id));
}
/* M-W1: read only a window of the last N ids, which is the design's first version (E7D-C-F2 b). */
function mutantWindow(rows, existing, size) {
  let highest = 0;
  for (const l of existing) if (typeof l.auditId === 'number') highest = Math.max(highest, l.auditId);
  const held = new Set(existing.filter((l) => typeof l.auditId === 'number').map((l) => `${l.epoch}:${l.auditId}`));
  return rows.filter((r) => r.id > highest - size && !held.has(`1:${r.id}`));
}

// ---------------------------------------------------------------------------
// The fold: the state the reconciler reads on day 4.
// ---------------------------------------------------------------------------

test('design 1.3: the fold carries the expected state per company, per account and per epoch', () => {
  const store = tenLines();
  appendMany(store, [
    { act: 'company.delete', companyId: C1, reason: 'customer_instruction', ref: 'synthetic:2026-10-07/1', rows: 812, auditId: 1010, actor: OP },
    { act: 'account.delete', userId: U1, reason: 'unclaimed_invitation', auditId: 1011, actor: OP },
    { act: 'factor.delete', userId: U1, factorId: F1, ref: 'opslog:2026-10-07/1', actor: OP },
    { act: 'key.replace', kidBefore: 'kid-a', kidAfter: 'kid-b', actor: OP },
    { act: 'company.resume', companyId: C2, reason: 'customer_request', statusAfter: 'active', auditId: 1012, actor: OP },
  ]);
  const f = fold(verify(store.text).lines);

  const c = f.companies[C1];
  assert.equal(c.status, 'closed');
  assert.equal(c.deleted, true);
  assert.equal(c.deleteReason, 'customer_instruction');
  assert.equal(c.deleteRef, 'synthetic:2026-10-07/1');
  assert.equal(c.deleteRows, 812);
  assert.equal(c.accessPeriod.exportBy, '2027-01-14T00:00:00.000Z');
  assert.equal(c.accessPeriodStartsAtMissing, false);
  assert.deepEqual(c.quotas.agents_per_company.value, 25);
  assert.equal(c.memberships[M1].removed, true);
  assert.deepEqual(c.memberships[M1].rolesAfter, ['member']);
  assert.equal(c.releasesWithdrawn[R1].byUserId, U1);

  assert.equal(f.accounts[U1].deleted, true);
  assert.equal(f.accounts[U1].reason, 'unclaimed_invitation');
  assert.deepEqual(Object.keys(f.accounts[U1].factors), [F1]);
  assert.deepEqual(f.keys, [{ kidBefore: 'kid-a', kidAfter: 'kid-b', at: f.keys[0].at, epoch: 0 }]);

  /* A grant is recorded AND reported, and never re-applied on the register's word alone. */
  assert.equal(f.companies[C2].status, 'active');
  assert.deepEqual(
    f.grants.map((g) => g.act),
    ['company.resume'],
  );

  assert.equal(f.epoch, 0);
  assert.equal(f.epochOpen, false);
  assert.deepEqual(f.watermark, { auditId: 1007, at: '2026-10-01T09:00:00.000Z', seq: 9 });
});

test('design 1.3 gate 2: the fold exposes the PREVIOUS epoch’s watermark beside this epoch’s backup time', () => {
  const store = afterRestore(1501);
  const f = fold(verify(store.text).lines);
  assert.equal(f.epoch, 1);
  assert.equal(f.epochOpen, true);
  assert.equal(f.auditFloor, 1501);
  assert.equal(f.backupAt, '2026-10-04T07:00:00.000Z');
  assert.deepEqual(f.previousWatermark, { auditId: 1500, at: '2026-10-04T08:00:00.000Z', seq: 3 });
  /* The gate itself is the reconciler's; what the register owes it is these two values side by side. */
  assert.equal(Date.parse(f.previousWatermark.at) >= Date.parse(f.backupAt), true);
  assert.deepEqual(f.gaps, []);
  assert.equal(f.watermark, null, 'the new epoch has not been synced yet');
});

test('design 1.3: a gap line is folded per epoch, which is how the reconciler knows the interval was reconciled by hand', () => {
  const store = afterRestore(1501);
  append(store, 'restore.gap', { ref: 'synthetic:hand-reconciliation/1', actor: OP });
  const f = fold(verify(store.text).lines);
  assert.deepEqual(f.gaps, [{ epoch: 1, ref: 'synthetic:hand-reconciliation/1', at: f.gaps[0].at }]);
});

// ---------------------------------------------------------------------------
// E7-23's register arm: malformed arguments. Refused before anything is opened, with no value echoed.
// ---------------------------------------------------------------------------

function runRegister(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [join(REPO, 'scripts/register.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, ENTERPRISE_REGISTER_PATH: '', ENTERPRISE_DB_PSQL: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (e) {
    return { status: e.status, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('E7-23: every malformed argument to register.mjs exits 2 with a usage line naming the rule and echoes no value', () => {
  const secret = '/Users/synthetic-operator/example-registers/tenant-0001.jsonl';
  const cases = [
    [[], /the first argument is one of/],
    [['verify', '--operator', '00000000-0000-4000-8000-00000000000A'], /--operator takes a lowercase uuid/],
    [['verify', '--operator'], /--operator takes a value/],
    [['verify', '--nonsense'], /unknown argument --nonsense/],
    [['sync'], /sync needs --operator/],
    [['append', '--operator', OP], /append needs --act/],
    [['append', '--act', 'company.delete', '--operator', OP], /--act is one of/],
    [['append', '--act', 'factor.delete', '--operator', OP], /needs --user-id, --factor-id and --ref/],
    [['gap', '--operator', OP], /gap needs --ref/],
    [['gap', '--operator', OP, '--ref', `synthetic:${'x'.repeat(80)}`], /--ref matches/],
    [['gap', '--operator', OP, '--ref', 'has a space'], /--ref matches/],
    [['sync', '--operator', OP, '--ref', 'notanid=synthetic:1'], /--ref takes AUDITID=REFERENCE/],
    [['verify', '--anchored-head', 'nine'], /--anchored-head takes SEQ:SHA256/],
    [['verify', '--copy', 'relative/path'], /--copy takes an absolute path/],
  ];
  for (const [args, rule] of cases) {
    const r = runRegister(args, { ENTERPRISE_REGISTER_PATH: secret });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.output}`);
    assert.match(r.output, rule, args.join(' '));
    assert.equal(r.output.includes(secret), false, 'the register path is never echoed');
    assert.equal(r.output.includes('00000000-0000-4000-8000-00000000000A'), false, 'no rejected value is echoed');
  }
});

test('E7-23: the register path must be set, absolute, and outside every Git work tree', () => {
  const unset = runRegister(['verify'], { ENTERPRISE_REGISTER_PATH: '' });
  assert.equal(unset.status, 2);
  assert.match(unset.output, /ENTERPRISE_REGISTER_PATH is not set/);

  const relative = runRegister(['verify'], { ENTERPRISE_REGISTER_PATH: 'register.jsonl' });
  assert.equal(relative.status, 2);
  assert.match(relative.output, /is an absolute path/);

  /* This repository IS a Git work tree, so a register path inside it is refused: a file of company ids and
     agreement dates is business records, and everything here leaves the disk through the backup remote. */
  const inRepo = runRegister(['verify'], { ENTERPRISE_REGISTER_PATH: join(REPO, 'register.jsonl') });
  assert.equal(inRepo.status, 2);
  assert.match(inRepo.output, /inside a Git work tree/);
});

/* E7G-F14 (evidence/e7-docs.md): appendMany() verified the whole chain before EVERY line, so n lines hashed n²/2
   lines and a 10,000-line sync took 46 s where its database read took 38 ms. It now verifies once and chains each
   line to the raw bytes of the one before it, writing the head after each line as append() does. Fail-before on the
   module at 8fb37b7: the store is read once per line (3,000 reads) and the same 4,000 lines take about 25 s. */
test('E7G-F14: appendMany reads and verifies the register once, chains every line, and the file verifies with both heads', () => {
  const inner = memory();
  let reads = 0;
  const store = {
    get text() {
      return inner.text;
    },
    get head() {
      return inner.head;
    },
    read: () => {
      reads += 1;
      return inner.read();
    },
    readHead: () => inner.readHead(),
    create: (t) => inner.create(t),
    append: (t) => inner.append(t),
    writeHead: (t) => inner.writeHead(t),
    now: () => inner.now(),
  };
  init(store);
  reads = 0;
  const bodies = [];
  for (let i = 0; i < 3000; i++) bodies.push({ act: 'company.suspend', companyId: C1, reason: 'non_payment', statusAfter: 'suspended', auditId: 5000 + i, actor: OP });
  const started = performance.now();
  const written = appendMany(store, bodies);
  const took = performance.now() - started;
  assert.equal(reads, 1, 'one read of the file for the whole batch');
  assert.equal(written.length, 3000);
  assert.equal(written.at(-1).seq, 3000);
  const state = verify(store.text, { localHead: store.head, anchoredHead: written[1500].head });
  assert.equal(state.ok, true, JSON.stringify(state.problems?.[0]));
  assert.equal(state.lines.length, 3001);
  /* A single append after the batch chains to the batch's last line. */
  const one = append(store, 'company.resume', { companyId: C1, reason: 'customer_request', statusAfter: 'active', auditId: 9000, actor: OP });
  assert.equal(one.seq, 3001);
  assert.equal(verify(store.text, { localHead: store.head }).ok, true);
  assert.ok(took < 5000, `3,000 lines in ${Math.round(took)} ms; the quadratic version took about 25,000 ms for 4,000`);
});
