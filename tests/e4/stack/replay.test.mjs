/* Cases 19 to 22 (E4 design section 5): the service replay and the gate identity at review and publication, through the
   routes on the running local stack. The server's identity is this build's (lib/passport/gate-manifest.mjs) and cannot
   move inside one process, so where the design moves the server to a new identity the test moves the envelope the other
   way: the envelope is proposed, and for case 20 approved, under a second identity registered owner-side with the same
   four installer texts and activated for the purpose, through the probe client (tests/db/e4-lib.sh) under that identity;
   this build's identity is then active again. Both orders meet the same routine rows (review rows 32 and 33, publication
   rows 31 and 32). Case 22's scratch gate is this build's gate with one added derived field, substituted for
   lib/passport/gate.mjs by a resolution hook installed before any lib module loads. Reseeds once through
   tests/db/00-seed.sh. Run one file at a time: node --test --test-concurrency=1 tests/e4/stack/ */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const SCRATCH = new URL('./scratch-gate.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.endsWith('/lib/passport/gate.mjs') && context.parentURL !== SCRATCH) {
      return { ...resolved, url: SCRATCH, shortCircuit: true };
    }
    return resolved;
  },
});

const H = await import('./helpers.mjs');
const { GATE_IDENTITY_SHA256 } = await import('../../../lib/passport/gate-manifest.mjs');
const ids = H.reseed();
H.enableTargets();
const R = await H.e4routes();
const W = H.e4world('replay', ids);
const A = await H.reviewCompany(W, R, 'a');

const refused = (r, status, code, label) => assert.deepEqual([r.status, r.body?.code], [status, code], `${label}: ${r.raw}`);
const idOf = (field, out) => {
  const m = new RegExp(`"${field}": *"([0-9a-f-]{36})"`).exec(out);
  if (!m) throw new Error(`${field} not in: ${out.slice(0, 300)}`);
  return m[1];
};
const deadlocks = () => Number(H.sql('select deadlocks from pg_stat_database where datname = current_database()'));

/* The second identity, owner-side under the registry bypass, with this build's four installer texts. */
const SECOND = createHash('sha256').update('e4 stack second identity').digest('hex');
H.sql(
  `set local app.registry_migration = 'on'; with g as (insert into app.gate_identities (identity_sha256, adapter_lock_sha256, validator_version, manifest_sha256, upstream_commit, active) values (decode('${SECOND}','hex'), sha256('e4-stack-lock'), '0.1.0', sha256('e4-stack-manifest'), repeat('e', 40), false) returning id) insert into app.installer_texts (gate_id, target, text, text_sha256, core_sha256, branch_sha256, judge_sha256) select g.id, i.target, i.text, i.text_sha256, i.core_sha256, i.branch_sha256, i.judge_sha256 from g, app.installer_texts i join app.gate_identities b on b.id = i.gate_id where b.identity_sha256 = decode('${GATE_IDENTITY_SHA256}','hex');`,
);
const activate = (hex) =>
  H.sql(
    `set local app.registry_migration = 'on'; update app.gate_identities set active = false where active; update app.gate_identities set active = true where identity_sha256 = decode('${hex}','hex');`,
  );
async function underSecond(run) {
  activate(SECOND);
  try {
    return await run();
  } finally {
    activate(GATE_IDENTITY_SHA256);
  }
}
const probeEnvelope = (user, candidateId, target) =>
  idOf(
    'envelope_id',
    H.e3lib('envelope "$1" "$2" "$3" "$(audience "$4")" @uuid --gate "$5"', user.id, candidateId, target, A.groupId, SECOND),
  );
const probeApproval = (user, candidateId, envelopeId, role) =>
  H.e3lib(
    'review "$1" "$2" "$3" "$4" approved "Under the second identity." @uuid --gate "$5"',
    user.id,
    candidateId,
    envelopeId,
    role,
    SECOND,
  );

/* Every Data API call a route makes that reaches a routine. */
async function rpcCalls(run) {
  const seen = [];
  const result = await H.withFetch((url, init, original) => {
    if (String(url).includes('/rest/v1/rpc/')) seen.push(String(url).split('/rpc/')[1]);
    return original(url, init);
  }, run);
  return { result, seen };
}

test('case 19: a stale gate at review; the server on the active identity refuses an approval of the old envelope and records a change request on it', async () => {
  const current = await H.submitted(R, A);
  const currentEnvelope = await H.envelopeFor(R, A, current.candidateId);
  const retired = await H.submitted(R, A);
  const before = [H.auditsOf(A.id), H.count('app.reviews'), H.count('app.idempotency_keys')];
  const oldEnvelope = await underSecond(async () => {
    refused(
      await R.review(A.it, current.candidateId, { envelopeId: currentEnvelope, role: 'it', decision: 'approved', reason: 'Stale server.' }),
      503,
      'E_GATE_UNREGISTERED',
      'an approval by a server whose identity is no longer active',
    );
    assert.deepEqual([H.auditsOf(A.id), H.count('app.reviews'), H.count('app.idempotency_keys')], before, 'nothing written');
    return probeEnvelope(A.author, retired.candidateId, 'claude-ai');
  });
  const dl = deadlocks();
  refused(
    await R.review(A.it, retired.candidateId, { envelopeId: oldEnvelope, role: 'it', decision: 'approved', reason: 'Old envelope.' }),
    409,
    'E_ADAPTER_CHANGED',
    'an approval of an envelope proposed under an identity no longer active',
  );
  const change = await R.review(A.business, retired.candidateId, {
    envelopeId: oldEnvelope,
    role: 'business',
    decision: 'changes_requested',
    reason: 'Propose it again under the current identity.',
  });
  assert.deepEqual([change.status, change.body.candidateState], [201, 'changes_requested'], `control: a change request on it: ${change.raw}`);
  assert.equal(deadlocks(), dl, 'no deadlock');
});

test('case 20: an envelope approved under a retired identity cannot publish; a new envelope under the active identity passes the replay and publishes', async () => {
  const { candidateId } = await H.submitted(R, A);
  const oldEnvelope = await underSecond(async () => {
    const e = probeEnvelope(A.author, candidateId, 'claude-ai');
    assert.match(probeApproval(A.it, candidateId, e, 'it'), /^HTTP 200/);
    assert.match(probeApproval(A.business, candidateId, e, 'business'), /^HTTP 200/);
    return e;
  });
  assert.equal(H.sql(`select app.envelope_status('${oldEnvelope}') || '|' || state from app.candidate_versions where id='${candidateId}'`), 'approved|approved');
  const before = [H.auditsOf(A.id), H.count(`app.releases where candidate_id='${candidateId}'`), H.count('app.idempotency_keys')];
  refused(await R.publish(A.adminHi, candidateId, oldEnvelope), 409, 'E_ADAPTER_CHANGED', 'publication of the envelope approved under the retired identity');
  assert.deepEqual([H.auditsOf(A.id), H.count(`app.releases where candidate_id='${candidateId}'`), H.count('app.idempotency_keys')], before, 'nothing written');

  const fresh = await H.envelopeFor(R, A, candidateId, 'claude-ai');
  assert.notEqual(fresh, oldEnvelope, 'the active identity binds a different envelope');
  await H.approveBoth(R, A, candidateId, fresh);
  const pub = await R.publish(A.adminHi, candidateId, fresh);
  assert.deepEqual([pub.status, pub.body.release.gateIdentitySha256], [201, GATE_IDENTITY_SHA256], `control: ${pub.raw}`);
  assert.equal(H.sql(`select app.envelope_status('${oldEnvelope}')`), 'approved', 'the old envelope stays approved');
  refused(await R.publish(A.adminHi, candidateId, oldEnvelope), 409, 'E_ADAPTER_CHANGED', 'and stays unpublishable');
});

test('case 21: stored bytes the current gate refuses: 422 E_GATE_FAILS_NOW from the service before any call; a change request records and a new draft follows through E3', async () => {
  const { candidateId, agentId } = await H.submitted(R, A);
  const envelopeId = await H.envelopeFor(R, A, candidateId);
  H.sql(
    `begin; alter table app.candidate_versions disable trigger candidate_1_immutable; update app.candidate_versions set content = replace(content, '${H.PROSE}', '${H.PROSE} Share it at app.phaeacia.ai today.') where id='${candidateId}'; alter table app.candidate_versions enable trigger candidate_1_immutable; commit;`,
  );
  const proposal = await rpcCalls(() =>
    R.envelope(A.author, candidateId, { target: 'chatgpt', audienceGroupIds: [A.groupId], policyId: H.activePolicyId() }),
  );
  refused(proposal.result, 422, 'E_GATE_FAILS_NOW', 'a proposal');
  const approval = await rpcCalls(() => R.review(A.it, candidateId, { envelopeId, role: 'it', decision: 'approved', reason: 'Approve.' }));
  refused(approval.result, 422, 'E_GATE_FAILS_NOW', 'an approval');
  assert.deepEqual([...proposal.seen, ...approval.seen], [], 'no call reached a routine');

  const change = await R.review(A.it, candidateId, { envelopeId, role: 'it', decision: 'changes_requested', reason: 'The passport names a public route.' });
  assert.deepEqual([change.status, change.body.candidateState], [201, 'changes_requested'], `control: a change request: ${change.raw}`);
  const next = await R.create(A.author, A.id, { agentId, bytes: H.passport('case-21-next') });
  assert.equal(next.status, 201, `control: a new draft of the agent through E3: ${next.raw}`);
});

test('case 22: a derived record changed under the current gate: 409 E_DERIVED_CHANGED from the service before any call; the unchanged gate: 201', async () => {
  const { candidateId } = await H.submitted(R, A);
  const envelopeId = await H.envelopeFor(R, A, candidateId);
  const { gate } = await import('../../../lib/passport/gate.mjs');
  globalThis.E4_SCRATCH_DERIVE = true;
  try {
    const probe = gate(H.passport('scratch'), 'text/markdown', { validatedAt: new Date().toISOString() });
    assert.equal(JSON.parse(probe.derivedCanonical).scratch_field, true, 'the scratch gate is the one lib modules load');
    const proposal = await rpcCalls(() =>
      R.envelope(A.author, candidateId, { target: 'chatgpt', audienceGroupIds: [A.groupId], policyId: H.activePolicyId() }),
    );
    refused(proposal.result, 409, 'E_DERIVED_CHANGED', 'a proposal');
    const approval = await rpcCalls(() => R.review(A.it, candidateId, { envelopeId, role: 'it', decision: 'approved', reason: 'Approve.' }));
    refused(approval.result, 409, 'E_DERIVED_CHANGED', 'an approval');
    assert.deepEqual([...proposal.seen, ...approval.seen], [], 'no call reached a routine');
  } finally {
    globalThis.E4_SCRATCH_DERIVE = false;
  }
  const proposal = await R.envelope(A.author, candidateId, { target: 'chatgpt', audienceGroupIds: [A.groupId], policyId: H.activePolicyId() });
  assert.equal(proposal.status, 201, `control, the unchanged gate: a proposal: ${proposal.raw}`);
  const approval = await R.review(A.it, candidateId, { envelopeId, role: 'it', decision: 'approved', reason: 'Approve.' });
  assert.equal(approval.status, 201, `control, the unchanged gate: an approval: ${approval.raw}`);
});
