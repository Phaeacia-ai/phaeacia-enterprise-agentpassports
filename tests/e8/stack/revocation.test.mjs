/* E8-8 and E8-11 (docs/e8/design.md 2.2's revocation and concurrency rows, 2.3 rows E8-8 and E8-11, 7.1 day 3),
   against the running local stack.

   E8-8, DOWNLOADED CONTENT IS OUTSIDE REVOCATION, ASSERTED AND NOT STATED. docs/e5/design.md and the release page
   say that a withdrawal is never a revocation; `lib/services/releases.mjs:159-160` says it in the answer
   (`revokesCopies: false`). What no case did was WATCH it: download, withdraw, and then assert that the bytes that
   left are unaffected and that the ledger row survives as the record of what left. This file does that, and it
   asserts the three things the design row names: the second download is refused with the withdrawal's own code;
   the first ledger row is unchanged and still names what left; and no path deletes or rewrites it. The last is
   asserted twice, once as a count and once against the append-only trigger itself, because "no path deletes it" is
   a claim about a table and not about one request.

   E8-11, CONCURRENCY. Two schedules, ordered by a lock a third connection holds, which is how
   tests/e4/stack/routes.test.mjs case 44 and tests/db/25-review-concurrency.sh make a race deterministic:
     S1  a publication of the successor against a withdrawal of the predecessor, both of the same agent;
     S2  a download authorization against the publication.
   The invariant after every schedule is E4 design 2.5's: exactly one current release per agent and target. The
   ledger is asserted consistent with what each download was told, and `pg_stat_database.deadlocks` is read before
   and after and required not to move.

   THE FAIL-BEFORES, AND ONE DEVIATION STATED IN FULL. Row E8-11's fail-before is "the schedule run against a copy
   of the routine without the agent lock, in a rolled-back transaction". What is built here is F1 and F2 below, and
   the deviation is recorded in docs/e8/design.md's day-3 amendment block with this reason: a copy of
   `api.publish_release` installed inside one session's transaction is invisible to the second session a race needs,
   and a copy installed under the real name for long enough to be seen would be a committed change to a shipped
   routine, which this lane may not make. So the lock is observed directly instead, which is a stronger observation
   than a mutant of it would have been:
     F1  with a third connection holding the agent row, the shipped publish WAITS and answers 409 E_BUSY at
         `app_server`'s `lock_timeout` (001:43, five seconds), and the same publish succeeds once the row is
         released. A routine that had lost the lock would not wait, so F1 is the check the missing mutant would
         have failed;
     F2  the invariant assertion itself, shown failing against a state with two current releases for one agent and
         target, built owner-side inside a transaction that is rolled back. Without F2 the invariant could be
         written wrongly and pass on every schedule.
   E8-8's fail-before is F3: a withdrawal that deletes the ledger rows of the withdrawn release, built against the
   trigger with the one privilege only the migration owner has, on a release published for that purpose so nothing
   else in this file reads it.

   E8-9. `no-write.mjs` wraps the refusals of both cases: the second download after the withdrawal, and every
   refused call in S1 and S2. It does not wrap the publications, the withdrawals or the first download, which write
   by design and whose writes are asserted instead.

   THE STACK. Held by this lane. Reseeds through tests/db/00-seed.sh, runs under --test-concurrency=1. Run alone:
   node --test --test-concurrency=1 tests/e8/stack/revocation.test.mjs */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { psqlSession, sleep } from '../../e2/helpers/stack.mjs';
import {
  e4world,
  e6routes,
  enableTargets,
  envelopeFor,
  approveBoth,
  published,
  reseed,
  reviewCompany,
  sql,
  submitted,
  waitFor,
} from '../../e6/stack/helpers.mjs';
import { ledgerCount } from '../../e5/stack/helpers.mjs';
import { caught, caughtAsync } from '../helpers/mutant-lib.mjs';
import { noWrite } from '../helpers/no-write.mjs';

const ids = reseed();
enableTargets();
const R = await e6routes([]);
const W = e4world('e8r', ids);
const A = await reviewCompany(W, R, 'revocation');

const ok = (label, answer, ...statuses) => {
  assert.ok(statuses.includes(answer.status), `${label}: ${answer.status} ${answer.raw}`);
  return answer.body;
};
const refusedWith = (answer, status, code, label) => {
  assert.deepEqual([answer.status, answer.body?.code], [status, code], `${label}: ${answer.status} ${answer.raw}`);
  return answer;
};

/** One ledger row, as the database holds it, for the assertion that nothing rewrote it. */
const ledgerRow = (releaseId, membershipId) =>
  sql(`select coalesce(string_agg(id || '|' || company_id || '|' || release_id || '|' || membership_id || '|' || authorized_at, ' ; ' order by id), 'none')
         from app.release_downloads where release_id = '${releaseId}' and membership_id = '${membershipId}'`);

/** The invariant of E4 design 2.5, per agent: how many releases are current for each target. */
const currentPerTarget = (agentId) =>
  sql(`select coalesce(string_agg(target || '=' || n, ',' order by target), 'none') from (
         select target, count(*) as n from app.releases
          where agent_id = '${agentId}' and state = 'published' and superseded_by_release_id is null
          group by target) s`);

const deadlocks = () => sql(`select deadlocks from pg_stat_database where datname = current_database()`);

/* ---------- E8-8 ---------- */

test('E8-8: a recipient downloads, the release is withdrawn, and what left is untouched', async () => {
  const P = await published(R, A, 'claude-ai');
  const recipient = A.member;
  const membershipId = A.ms.member;

  const first = ok('the first download', await R.download(recipient, P.releaseId), 200);
  assert.equal(typeof first.assembledContent, 'string');
  assert.ok(first.assembledContent.length > 0, 'the download carried no bytes');
  assert.equal(first.release.state, 'published');
  const bytesThatLeft = first.assembledContent;
  const shaThatLeft = first.assembledSha256;
  const rowAfterDownload = ledgerRow(P.releaseId, membershipId);
  assert.notEqual(rowAfterDownload, 'none', 'the download wrote no ledger row');
  assert.equal(ledgerCount(P.releaseId, membershipId), 1);

  const withdrawal = ok('the withdrawal', await R.withdraw(A.adminHi, P.releaseId, 'E8-8: withdrawn after a download.'), 200);
  assert.equal(withdrawal.revokesCopies, false, 'the answer claims a withdrawal revokes copies');
  assert.equal(withdrawal.release.state, 'withdrawn');

  /* 1. The second download is refused with the withdrawal's own code, and writes nothing. */
  /* THE CONTENT DIGEST, not the count alone (B12-R-F1). E8-8's result sentence is "no path deletes OR REWRITES
     it", and a rewrite of the ledger row's timestamp, or of the release's frozen assembly, moves no count. The
     three tables a second download could touch are named, so an in-place change is caught here as well as by the
     row comparison below, which is this case's own stronger assertion on the one row it cares about. */
  const second = await noWrite(
    'E8-8 the second download after the withdrawal',
    async () => R.download(recipient, P.releaseId),
    { content: ['release_downloads', 'releases', 'audit_events'] },
  );
  refusedWith(second, 409, 'E_RELEASE_WITHDRAWN', 'the second download');

  /* 2. The ledger row is unchanged, byte for byte, and still names what left. */
  assert.equal(ledgerRow(P.releaseId, membershipId), rowAfterDownload, 'the withdrawal changed the ledger row');
  assert.equal(ledgerCount(P.releaseId, membershipId), 1, 'the withdrawal changed the number of ledger rows');

  /* 3. The operator's view of it: the recipients the release read reports are still the recipients, after the
        withdrawal, because the ledger is the record of what left and not of what is current. */
  const read = ok('the release read after the withdrawal', await R.releaseRead(A.adminHi, P.releaseId), 200);
  assert.equal(read.release.state, 'withdrawn');
  assert.equal(
    read.recipients?.some?.((r) => r.membershipId === membershipId) ?? read.recipientCount >= 1,
    true,
    `the withdrawn release no longer reports the recipient it was downloaded by: ${JSON.stringify(read.recipients ?? read.recipientCount)}`,
  );

  /* 4. And the bytes themselves. The frozen assembly is still what the download returned: read it owner-side,
        which is the only way to compare what left with what is stored now. */
  const stored = sql(`select assembled_content from app.releases where id = '${P.releaseId}'`);
  assert.equal(stored.length > 0, true);
  assert.equal(
    sql(`select encode(sha256(convert_to(assembled_content, 'UTF8')), 'hex') from app.releases where id = '${P.releaseId}'`),
    shaThatLeft,
    'the stored assembly no longer hashes to what the download was told',
  );
  assert.equal(stored.split('\n')[0], bytesThatLeft.split('\n')[0], 'the stored assembly no longer starts with what left');
});

test('E8-8 control: the ledger is append-only to the owner too, so "no path deletes it" is the table s rule', () => {
  const P = sql(`select release_id from app.release_downloads limit 1`);
  assert.ok(P, 'the ledger is empty, so this control has nothing to protect');
  for (const [what, statement] of [
    ['update', `update app.release_downloads set authorized_at = now() where release_id = '${P}'`],
    ['delete', `delete from app.release_downloads where release_id = '${P}'`],
  ]) {
    const e = caught(`E8-8 ledger ${what}`, () => sql(statement));
    assert.match(e.message, /E_LEDGER_APPEND_ONLY/, `${what}: ${e.message.slice(0, 200)}`);
  }
});

test('E8-8 fail-before: a withdrawal that deleted the ledger rows fails the unchanged assertion, naming it', async () => {
  /* Its own release, published for this counterexample, so the case above keeps its row. */
  const P = await published(R, A, 'generic');
  ok('the disposable download', await R.download(A.member, P.releaseId), 200);
  const before = ledgerRow(P.releaseId, A.ms.member);
  assert.notEqual(before, 'none');

  /* The deletion a losing withdrawal would perform. The append-only trigger refuses it to everyone including the
     owner, so it is disabled inside one owner transaction and enabled again in it, which is the technique
     tests/e5/stack/helpers.mjs ageLedger already uses and the one thing only the migration owner can do.
     Nothing in the product has this power; that is what the control above asserts. */
  sql(`begin;
    alter table app.release_downloads disable trigger release_downloads_append_only;
    delete from app.release_downloads where release_id = '${P.releaseId}';
    alter table app.release_downloads enable trigger release_downloads_append_only;
    commit;`);
  ok('the withdrawal', await R.withdraw(A.adminHi, P.releaseId, 'E8-8 fail-before.'), 200);

  const e = caught('E8-8', () => {
    assert.equal(ledgerRow(P.releaseId, A.ms.member), before, 'the withdrawal changed the ledger row');
    assert.equal(ledgerCount(P.releaseId, A.ms.member), 1, 'the withdrawal changed the number of ledger rows');
  });
  assert.match(e.message, /the withdrawal changed the ledger row/);
  assert.equal(ledgerRow(P.releaseId, A.ms.member), 'none');
  console.log(`E8-8 fail-before at the intended check: ${e.message.split('\n')[0]}`);
});

/* ---------- E8-11 ---------- */

/** A connection holding `for update` on one agent row, which is the lock publish_release takes at 006:3779. */
async function holdingAgent(agentId, run) {
  const holder = psqlSession();
  holder.write('begin;');
  holder.write(`select 'HELD|' || count(*) from (select id from app.agents where id = '${agentId}' for update) x;`);
  try {
    await waitFor(() => holder.output().includes('HELD|1'), 'the agent row locked by another connection');
    return await run();
  } finally {
    holder.write('commit;');
    await holder.end();
  }
}

test('E8-11 S1: a publication and a withdrawal of the same agent, ordered by the agent lock', async () => {
  const deadlocksBefore = deadlocks();
  const P = await published(R, A, 'claude-ai');
  const successor = await submitted(R, A, { agentId: P.agentId });
  const envelopeId = await envelopeFor(R, A, successor.candidateId, 'claude-ai');
  await approveBoth(R, A, successor.candidateId, envelopeId);

  /* Both calls are started while the agent row is held, so neither can reach the routine's body; both are then
     released at once and the database orders them. Whatever order it picks, the invariant must hold. */
  const answers = await holdingAgent(P.agentId, async () => {
    const publish = R.publish(A.adminHi, successor.candidateId, envelopeId);
    const withdraw = R.withdraw(A.adminHi, P.releaseId, 'E8-11 S1: withdrawn beside a publication.');
    await sleep(200); /* both are inside the routine, waiting on the agent row */
    return { publish, withdraw };
  });
  const publish = await answers.publish;
  const withdraw = await answers.withdraw;

  /* Each is either done or refused with a code; neither may be a 500, and neither may be a silent success that
     left the agent with two current releases. */
  for (const [label, answer] of [['the publication', publish], ['the withdrawal', withdraw]]) {
    assert.ok(answer.status < 500, `${label}: ${answer.status} ${answer.raw}`);
    assert.ok([200, 201, 409].includes(answer.status), `${label}: ${answer.status} ${answer.raw}`);
  }
  assert.equal(currentPerTarget(P.agentId), 'claude-ai=1', 'the agent ended the schedule with more than one current release');
  assert.equal(deadlocks(), deadlocksBefore, 'the schedule deadlocked');
  console.log(`E8-11 S1: publish ${publish.status} ${publish.body?.code ?? 'ok'}, withdraw ${withdraw.status} ${withdraw.body?.code ?? 'ok'}, current claude-ai=1`);
});

test('E8-11 S2: a download authorization against the publication of the successor', async () => {
  const deadlocksBefore = deadlocks();
  const P = await published(R, A, 'chatgpt');
  const successor = await submitted(R, A, { agentId: P.agentId });
  const envelopeId = await envelopeFor(R, A, successor.candidateId, 'chatgpt');
  await approveBoth(R, A, successor.candidateId, envelopeId);
  const ledgerBefore = ledgerCount(P.releaseId, A.ms.member);

  const answers = await holdingAgent(P.agentId, async () => {
    const publish = R.publish(A.adminHi, successor.candidateId, envelopeId);
    const download = R.download(A.member, P.releaseId);
    await sleep(200);
    return { publish, download };
  });
  const publish = await answers.publish;
  const download = await answers.download;

  assert.ok([200, 201, 409].includes(publish.status), `the publication: ${publish.status} ${publish.raw}`);
  assert.ok([200, 409, 404].includes(download.status), `the download: ${download.status} ${download.raw}`);

  /* THE LEDGER IS CONSISTENT WITH WHAT THE DOWNLOAD WAS TOLD, in both directions: a 200 leaves exactly one more
     row, and a refusal leaves none. A row written for a refused download, or a 200 with nothing recorded, is the
     defect this assertion exists for. */
  const ledgerAfter = ledgerCount(P.releaseId, A.ms.member);
  assert.equal(
    ledgerAfter,
    ledgerBefore + (download.status === 200 ? 1 : 0),
    `the ledger and the answer disagree: the download answered ${download.status} and the rows went ${ledgerBefore} -> ${ledgerAfter}`,
  );
  if (download.status === 200) assert.equal(typeof download.body.assembledContent, 'string');

  assert.equal(currentPerTarget(P.agentId), 'chatgpt=1', 'the agent ended the schedule with more than one current release');
  assert.equal(deadlocks(), deadlocksBefore, 'the schedule deadlocked');
  console.log(`E8-11 S2: publish ${publish.status} ${publish.body?.code ?? 'ok'}, download ${download.status} ${download.body?.code ?? 'ok'}, ledger ${ledgerBefore} -> ${ledgerAfter}`);
});

test('E8-11 F1 fail-before: the shipped publish WAITS on the agent lock, and answers E_BUSY rather than proceeding', async () => {
  const P = await published(R, A, 'claude-code');
  const successor = await submitted(R, A, { agentId: P.agentId });
  const envelopeId = await envelopeFor(R, A, successor.candidateId, 'claude-code');
  await approveBoth(R, A, successor.candidateId, envelopeId);

  /* Held for longer than app_server's lock_timeout of five seconds (001:43), so the routine gives up on the lock
     rather than being released into it. A routine that had lost its agent lock would publish straight through
     here, which is what the mutant row E8-11 names would have shown; this shows the same thing from the other
     side, on the shipped routine, and writes nothing. */
  const holder = psqlSession();
  holder.write('begin;');
  holder.write(`select 'HELD|' || count(*) from (select id from app.agents where id = '${P.agentId}' for update) x;`);
  let busy;
  try {
    await waitFor(() => holder.output().includes('HELD|1'), 'the agent row locked');
    const started = Date.now();
    busy = await noWrite(
      'E8-11 F1 the publish that meets the held agent lock',
      async () => R.publish(A.adminHi, successor.candidateId, envelopeId),
      { content: ['releases', 'candidate_versions', 'agents', 'idempotency_keys', 'audit_events'] },
    );
    const waited = Date.now() - started;
    refusedWith(busy, 409, 'E_BUSY', 'the publish under a held agent row');
    assert.ok(waited >= 4500, `the publish answered after ${waited} ms, which is not a wait on the lock`);
    console.log(`E8-11 F1: the publish waited ${waited} ms on the held agent row and answered 409 E_BUSY`);
  } finally {
    holder.write('commit;');
    await holder.end();
  }
  /* And the control: the same call, with nothing held, publishes. The refusal was the lock and not the call. */
  const free = await R.publish(A.adminHi, successor.candidateId, envelopeId);
  assert.equal(free.status, 201, `the control publish: ${free.status} ${free.raw}`);
  assert.equal(currentPerTarget(P.agentId), 'claude-code=1');
});

test('E8-11 F2 fail-before: the invariant assertion fails against two current releases for one agent and target', async () => {
  const P = await published(R, A, 'claude-ai');
  await published(R, A, 'claude-ai', { agentId: P.agentId }); /* a successor, so one row is superseded */
  assert.equal(currentPerTarget(P.agentId), 'claude-ai=1');

  /* THE COUNTEREXAMPLE HAS TO DEFEAT THREE GUARDS, WHICH IS THE RESULT. "Two current releases for one agent and
     target" cannot be reached by any ordinary write, and it took two failed attempts here to find out how many
     things stop it, each recorded rather than smoothed over:
       1. the agent lock at 006:3779, which serialises the two publications S1 races;
       2. `releases_1_immutable` (006:3258), which refuses even the OWNER's update of `superseded_by_release_id`
          with E_IMMUTABLE. F3 below asserts that refusal on its own;
       3. `create unique index releases_one_current on app.releases (agent_id, target)` (006:3155), which makes the
          state unrepresentable: with the trigger disabled the update still fails, 23505, "Key (agent_id, target)
          already exists".
     That is defence in depth and not an inconsistent policy: the lock orders the writers, the trigger refuses a
     hand edit, and the index refuses the state itself. So the counterexample drops the index AND disables the
     trigger, both INSIDE the transaction, and the whole transaction is rolled back: the index and the trigger come
     back with it, and the state this counterexample needs never commits. Nothing in the product can produce it. */
  const observed = sql(`begin;
    alter table app.releases disable trigger releases_1_immutable;
    drop index app.releases_one_current;
    update app.releases set superseded_by_release_id = null, superseded_at = null
     where agent_id = '${P.agentId}' and target = 'claude-ai' and state = 'published';
    alter table app.releases enable trigger releases_1_immutable;
    select coalesce(string_agg(target || '=' || n, ',' order by target), 'none') from (
      select target, count(*) as n from app.releases
       where agent_id = '${P.agentId}' and state = 'published' and superseded_by_release_id is null
       group by target) s;
    rollback;`)
    /* psql prints a command tag per statement, so the answer is the line shaped like the invariant read and not
       the last line, which is `ROLLBACK`. */
    .split('\n')
    .filter((line) => /^[a-z-]+=\d+(,[a-z-]+=\d+)*$/.test(line.trim()))
    .pop();
  const e = caught('E8-11 the invariant', () =>
    assert.equal(observed, 'claude-ai=1', 'the agent ended the schedule with more than one current release'),
  );
  assert.match(observed, /^claude-ai=[2-9]/, `the counterexample built only ${observed}`);
  assert.match(e.message, /more than one current release/);
  assert.equal(currentPerTarget(P.agentId), 'claude-ai=1', 'the counterexample committed');
  assert.equal(
    sql(`select count(*) from pg_indexes where schemaname = 'app' and indexname = 'releases_one_current'`),
    '1',
    'the unique index the counterexample dropped did not come back with the rollback',
  );
  console.log(`E8-11 F2 fail-before at the intended check: observed ${observed}, expected claude-ai=1`);
});

test('E8-11 F3: the same state is refused to the owner outright, which is the second guard on the invariant', async () => {
  const P = await published(R, A, 'generic');
  await published(R, A, 'generic', { agentId: P.agentId });
  const e = caught('E8-11 the immutability trigger', () =>
    sql(`update app.releases set superseded_by_release_id = null where agent_id = '${P.agentId}' and target = 'generic'`),
  );
  assert.match(e.message, /E_IMMUTABLE/, e.message.slice(0, 200));
  assert.equal(currentPerTarget(P.agentId), 'generic=1');
  console.log('E8-11 F3: an owner-side un-superseding of a release is refused with E_IMMUTABLE by releases_1_immutable');
});

after(() => {});
