/* Case 45 (E4 design section 5, with evidence/e4-design-critique.md F7): the idempotency matrix through the routes. Each
   routine's stored answer is replayed after the state it answered has moved on and comes back with idempotentReplay,
   with no second write and no second audit row. Each branch has its own fresh-key control, the answer 3.5 gives for
   that branch, rather than one blanket control (F7: publication rows 26, 29 and 36 govern fresh keys after
   supersession). Then one routine's found claim aged past the window, presented with identical and with changed
   operation bytes: E_IDEMPOTENCY_EXPIRED for both, expiry before conflict. Reseeds once through tests/db/00-seed.sh.
   Run one file at a time: node --test --test-concurrency=1 tests/e4/stack/ */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activePolicyId,
  approveBoth,
  auditsOf,
  count,
  e4routes,
  e4world,
  enableTargets,
  envelopeFor,
  key,
  published,
  reseed,
  reviewCompany,
  sql,
  submitted,
} from './helpers.mjs';

const ids = reseed();
enableTargets();
const R = await e4routes();
const W = e4world('matrix', ids);
const A = await reviewCompany(W, R, 'a');

const refused = (r, status, code, label) => assert.deepEqual([r.status, r.body?.code], [status, code], `${label}: ${r.raw}`);
const age = (membershipId, k, expression) =>
  sql(`update app.idempotency_keys set created_at = ${expression} where membership_id='${membershipId}' and key='${k}'`);

test('case 45, create_envelope: replayed after the candidate became changes_requested, the stored answer; a fresh key is E_NOT_REVIEWABLE', async () => {
  const { candidateId } = await submitted(R, A);
  const body = { target: 'claude-ai', audienceGroupIds: [A.groupId], policyId: activePolicyId() };
  const k = key();
  const first = await R.envelope(A.author, candidateId, body, k);
  assert.equal(first.status, 201, first.raw);
  const envelopeId = first.body.envelope.envelopeId;
  const change = await R.review(A.it, candidateId, {
    envelopeId,
    role: 'it',
    decision: 'changes_requested',
    reason: 'Please fix the totals.',
  });
  assert.deepEqual([change.status, change.body.candidateState], [201, 'changes_requested'], change.raw);
  const before = [auditsOf(A.id), count(`app.review_envelopes where candidate_id='${candidateId}'`)];
  const replay = await R.envelope(A.author, candidateId, body, k);
  assert.deepEqual([replay.status, replay.body.idempotentReplay, replay.body.envelope.envelopeId], [201, true, envelopeId], replay.raw);
  assert.deepEqual([auditsOf(A.id), count(`app.review_envelopes where candidate_id='${candidateId}'`)], before, 'no second write');
  refused(await R.envelope(A.author, candidateId, body), 409, 'E_NOT_REVIEWABLE', 'control: a fresh key');
});

test('case 45, record_review: replayed after the envelope became approved, the stored answer; a fresh key is E_ENVELOPE_APPROVED', async () => {
  const { candidateId } = await submitted(R, A);
  const envelopeId = await envelopeFor(R, A, candidateId);
  const body = { envelopeId, role: 'it', decision: 'approved', reason: 'IT approves.' };
  const k = key();
  const first = await R.review(A.it, candidateId, body, k);
  assert.deepEqual([first.status, first.body.envelopeStatus], [201, 'open'], first.raw);
  const second = await R.review(A.business, candidateId, { ...body, role: 'business', reason: 'Business approves.' });
  assert.deepEqual([second.status, second.body.envelopeStatus], [201, 'approved'], second.raw);
  const before = [auditsOf(A.id), count(`app.reviews where envelope_id='${envelopeId}'`)];
  const replay = await R.review(A.it, candidateId, body, k);
  assert.deepEqual(
    [replay.status, replay.body.idempotentReplay, replay.body.review.reviewId, replay.body.candidateState, replay.body.envelopeStatus],
    [201, true, first.body.review.reviewId, 'submitted', 'open'],
    `the stored answer, as it was first given: ${replay.raw}`,
  );
  assert.deepEqual([auditsOf(A.id), count(`app.reviews where envelope_id='${envelopeId}'`)], before, 'no second write');
  refused(await R.review(A.it, candidateId, body), 409, 'E_ENVELOPE_APPROVED', 'control: a fresh key');
});

test('case 45, publish_release: replayed after its release was superseded, the stored answer; the fresh-key control per branch', async () => {
  /* Branch 1, rows 26 and 29: superseded by a newer candidate of the agent. */
  const c1 = await submitted(R, A);
  const e1 = await envelopeFor(R, A, c1.candidateId, 'claude-ai');
  await approveBoth(R, A, c1.candidateId, e1);
  const k1 = key();
  const p1 = await R.publish(A.adminHi, c1.candidateId, e1, k1);
  assert.equal(p1.status, 201, p1.raw);
  const c2 = await submitted(R, A, { agentId: c1.agentId });
  const e2 = await envelopeFor(R, A, c2.candidateId, 'chatgpt');
  await approveBoth(R, A, c2.candidateId, e2);
  const p2 = await R.publish(A.adminHi, c2.candidateId, e2);
  assert.deepEqual([p2.status, p2.body.superseded.releaseIds], [201, [p1.body.release.releaseId]], p2.raw);
  let before = [auditsOf(A.id), count(`app.releases where agent_id='${c1.agentId}'`)];
  const replay1 = await R.publish(A.adminHi, c1.candidateId, e1, k1);
  assert.deepEqual(
    [replay1.status, replay1.body.idempotentReplay, replay1.body.release.releaseId, replay1.body.release.supersededByReleaseId],
    [201, true, p1.body.release.releaseId, p2.body.release.releaseId],
    replay1.raw,
  );
  assert.deepEqual([auditsOf(A.id), count(`app.releases where agent_id='${c1.agentId}'`)], before, 'branch 1: no second write');
  refused(await R.publish(A.adminHi, c1.candidateId, e1), 409, 'E_CANDIDATE_SUPERSEDED', 'branch 1 control: a fresh key (row 26)');

  /* Branch 2, rule 2: superseded by the same candidate's release for the same target under another envelope. */
  const wider = await R.groupsCreate(A.adminHi, A.id, `Wider ${W.run}`);
  assert.equal(wider.status, 201, wider.raw);
  const c3 = await submitted(R, A);
  const ea = await envelopeFor(R, A, c3.candidateId, 'claude-ai');
  const eb = await envelopeFor(R, A, c3.candidateId, 'claude-ai', { groups: [A.groupId, wider.body.groupId] });
  await approveBoth(R, A, c3.candidateId, ea);
  await approveBoth(R, A, c3.candidateId, eb);
  const ka = key();
  const pa = await R.publish(A.adminHi, c3.candidateId, ea, ka);
  assert.equal(pa.status, 201, pa.raw);
  const pb = await R.publish(A.adminHi, c3.candidateId, eb);
  assert.deepEqual(
    [pb.status, pb.body.superseded],
    [201, { releaseIds: [pa.body.release.releaseId], candidateIds: [] }],
    pb.raw,
  );
  before = [auditsOf(A.id), count(`app.releases where candidate_id='${c3.candidateId}'`)];
  const replayA = await R.publish(A.adminHi, c3.candidateId, ea, ka);
  assert.deepEqual([replayA.status, replayA.body.idempotentReplay, replayA.body.release.releaseId], [201, true, pa.body.release.releaseId], replayA.raw);
  assert.deepEqual([auditsOf(A.id), count(`app.releases where candidate_id='${c3.candidateId}'`)], before, 'branch 2: no second write');
  const freshA = await R.publish(A.adminHi, c3.candidateId, ea);
  assert.deepEqual(
    [freshA.status, freshA.body.existing, freshA.body.superseded.releaseIds],
    [201, false, [pb.body.release.releaseId]],
    `branch 2 control: a fresh key passes rows 26 and 29 and, with no current release for its envelope, publishes again under rule 2: ${freshA.raw}`,
  );

  /* Branch 3, row 36: the envelope's release is still current. */
  const again = await R.publish(A.adminHi, c3.candidateId, ea);
  assert.deepEqual([again.status, again.body.existing, again.body.release.releaseId], [200, true, freshA.body.release.releaseId], 'branch 3 control: existing true');
});

test('case 45, withdraw_release: replayed after withdrawal, the stored answer; a fresh key is E_ALREADY_WITHDRAWN', async () => {
  const release = await published(R, A, 'generic');
  const k = key();
  const first = await R.withdraw(A.adminHi, release.releaseId, 'Withdrawn once.', k);
  assert.deepEqual([first.status, first.body.release.state], [200, 'withdrawn'], first.raw);
  const before = auditsOf(A.id);
  const replay = await R.withdraw(A.adminHi, release.releaseId, 'Withdrawn once.', k);
  assert.deepEqual([replay.status, replay.body.idempotentReplay, replay.body.revokesCopies], [200, true, false], replay.raw);
  assert.equal(auditsOf(A.id), before, 'no second audit row');
  refused(await R.withdraw(A.adminHi, release.releaseId, 'Withdrawn once.'), 409, 'E_ALREADY_WITHDRAWN', 'control: a fresh key');
});

test('case 45, a found claim aged past the window: identical and changed operation bytes are both E_IDEMPOTENCY_EXPIRED; inside the window, the stored answer and E_IDEMPOTENCY_CONFLICT', async () => {
  const { candidateId } = await submitted(R, A);
  const body = { target: 'claude-code', audienceGroupIds: [A.groupId], policyId: activePolicyId() };
  const changed = { ...body, target: 'generic' };
  const k = key();
  const first = await R.envelope(A.author, candidateId, body, k);
  assert.equal(first.status, 201, first.raw);
  age(A.ms.author, k, "clock_timestamp() - app.idempotency_window() + interval '20 seconds'");
  const inside = await R.envelope(A.author, candidateId, body, k);
  assert.deepEqual([inside.status, inside.body.idempotentReplay], [201, true], `control: twenty seconds inside the window: ${inside.raw}`);
  refused(await R.envelope(A.author, candidateId, changed, k), 409, 'E_IDEMPOTENCY_CONFLICT', 'control: changed bytes inside the window');
  age(A.ms.author, k, "clock_timestamp() - app.idempotency_window() - interval '1 second'");
  const before = [auditsOf(A.id), count(`app.review_envelopes where candidate_id='${candidateId}'`), count('app.idempotency_keys')];
  refused(await R.envelope(A.author, candidateId, body, k), 409, 'E_IDEMPOTENCY_EXPIRED', 'identical operation bytes past the window');
  refused(await R.envelope(A.author, candidateId, changed, k), 409, 'E_IDEMPOTENCY_EXPIRED', 'changed operation bytes past the window');
  assert.deepEqual(
    [auditsOf(A.id), count(`app.review_envelopes where candidate_id='${candidateId}'`), count('app.idempotency_keys')],
    before,
    'nothing written past the window',
  );
});
