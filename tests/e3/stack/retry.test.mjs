/* The retry cases through the HTTP service against the running local stack (E3 design 4.3, 4.5 and section 6):
   case 35's H1 retry matrix with every first response discarded, case 42's route half with the bearer the service
   itself minted, and case 28a's gate row (a parent whose stored bytes the active gate now refuses). E3a ran the
   routine halves (tests/db/15-idempotency.sh, tests/db/14-content-routines.sh). Reseeds once; builds its own world.
   Owner-side SQL moves only what a case must move and says so: a claim row's age, the gate registry's active row, and
   one frozen parent's bytes. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { SUBMISSION } from '../unit/submission-shapes.mjs';
import {
  caller,
  count,
  key,
  PROSE,
  passport,
  ROOT,
  requestChanges,
  reseed,
  sql,
  withFetch,
  world,
} from './helpers.mjs';

const ids = reseed();
const { COOKIES, verifySession } = await import('../../../lib/session.mjs');
const { callBound } = await import('../../../lib/db/server.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { gate } = await import('../../../lib/passport/gate.mjs');
const { ADAPTER_LOCK_SHA256, GATE_IDENTITY_SHA256, MANIFEST_SHA256, VALIDATOR_VERSION } = await import(
  '../../../lib/passport/gate-manifest.mjs'
);

const routes = makeRoutes({ log: () => {} });
const call = caller(routes, COOKIES, makeRequest);
const W = world('retry', ids);
const admin = W.user('admin');
const author = W.user('author');
const reviewer = W.user('reviewer');
const A = W.company('a', admin);
const M = { author: W.member(A.id, author), reviewer: W.member(A.id, reviewer, '{it_reviewer,member}') };

const create = (user, { name, agentId, bytes = passport('0'), idem = key() } = {}) =>
  call('candidatesCreate', {
    user,
    params: { companyId: A.id },
    headers: { 'idempotency-key': idem, ...(name ? { 'x-agent-name': name } : {}), ...(agentId ? { 'x-agent-id': agentId } : {}) },
    body: bytes,
  });
const save = (user, candidateId, version, { bytes = passport('s'), idem = key() } = {}) =>
  call('candidatesSave', {
    user,
    params: { candidateId },
    headers: { 'idempotency-key': idem, 'if-match': String(version) },
    body: bytes,
  });
const submit = (user, candidateId, version, { idem = key() } = {}) =>
  call('candidatesSubmit', {
    user,
    params: { candidateId },
    headers: { 'idempotency-key': idem, 'if-match': String(version) },
    body: { ...SUBMISSION },
  });
const successor = (user, candidateId, { idem = key() } = {}) =>
  call('candidatesSuccessor', { user, params: { candidateId }, headers: { 'idempotency-key': idem }, body: {} });
const auditsOf = (action, entity) =>
  Number(sql(`select count(*) from app.audit_events where action='${action}' and entity_id='${entity}'`));
const ok = (r, status) => assert.equal(r.status, status, r.raw);

/* The gate registry's active row, moved owner-side for case 35's rotation and put back after. */
const ROTATED = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const rotate = () =>
  sql(
    `set local app.registry_migration = 'on'; update app.gate_identities set active = false where active; insert into app.gate_identities (identity_sha256, adapter_lock_sha256, validator_version, manifest_sha256, upstream_commit, active) values (decode('${ROTATED}','hex'), sha256('e3b-lock'), '0.1.0', sha256('e3b-manifest'), repeat('d', 40), true);`,
  );
const unrotate = () =>
  sql(
    `set local app.registry_migration = 'on'; update app.gate_identities set active = false where active; update app.gate_identities set active = true where identity_sha256 = decode('${GATE_IDENTITY_SHA256}','hex');`,
  );

test('case 35: every retry of the H1 matrix, first response discarded, answers the stored result and writes nothing twice; fresh keys meet their refusals', async () => {
  const d = await create(author, { name: `m35-${W.run}` });
  ok(d, 201);
  const c = d.body.candidateId;
  const agentId = d.body.agentId;

  /* A save replayed after the version already moved. */
  const ks = key();
  await save(author, c, 1, { idem: ks, bytes: passport('m35-save') });
  const saveReplay = await save(author, c, 1, { idem: ks, bytes: passport('m35-save') });
  ok(saveReplay, 200);
  assert.equal(saveReplay.body.idempotentReplay, true);
  assert.equal(saveReplay.body.version, 2);
  assert.equal(auditsOf('candidate.save', c), 1, 'one candidate.save audit row');
  const saveFresh = await save(author, c, 1, { bytes: passport('m35-save') });
  assert.deepEqual([saveFresh.status, saveFresh.body.code], [409, 'E_VERSION_CONFLICT'], 'control: a fresh key');

  /* A submit replayed after the state is already submitted. */
  const kb = key();
  await submit(author, c, 2, { idem: kb });
  const submitReplay = await submit(author, c, 2, { idem: kb });
  ok(submitReplay, 200);
  assert.equal(submitReplay.body.idempotentReplay, true);
  assert.equal(submitReplay.body.state, 'submitted');
  assert.equal(auditsOf('candidate.submit', c), 1);
  assert.equal(count(`app.candidate_contributors where candidate_id='${c}' and kind='submitter'`), 1);
  const submitFresh = await submit(author, c, 2);
  assert.deepEqual([submitFresh.status, submitFresh.body.code], [409, 'E_NOT_DRAFT'], 'control: a fresh key');

  /* A create replayed when the agent it would create by name now exists. */
  const kn = key();
  const name = `m35-name-${W.run}`;
  await create(author, { name, idem: kn, bytes: passport('m35-name') });
  const nameReplay = await create(author, { name, idem: kn, bytes: passport('m35-name') });
  ok(nameReplay, 201);
  assert.equal(nameReplay.body.idempotentReplay, true);
  assert.equal(count(`app.agents where company_id='${A.id}' and name='${name}'`), 1);
  assert.equal(count(`app.candidate_versions v join app.agents g on g.id = v.agent_id where g.name='${name}'`), 1);
  const nameFresh = await create(author, { name, bytes: passport('m35-name') });
  assert.deepEqual([nameFresh.status, nameFresh.body.code], [409, 'E_AGENT_NAME_TAKEN'], 'control: a fresh key');

  /* A create replayed against an agent at the version ceiling. 198 rows are added owner-side to reach 199, copied
     from the agent's first row a moment after it was attested, so the identity trigger's freshness holds. */
  sql(
    `insert into app.candidate_versions (company_id, agent_id, sequence, author_membership_id, content, derived_canonical, gate_id, attested_by) select company_id, agent_id, g, author_membership_id, content, derived_canonical, gate_id, attested_by from app.candidate_versions, generate_series(2, 199) g where id='${nameReplay.body.candidateId}'`,
  );
  const ceilingAgent = nameReplay.body.agentId;
  const kc = key();
  await create(author, { agentId: ceilingAgent, idem: kc, bytes: passport('m35-ceiling') });
  assert.equal(count(`app.candidate_versions where agent_id='${ceilingAgent}'`), 200, 'the agent is now at its ceiling');
  const ceilingReplay = await create(author, { agentId: ceilingAgent, idem: kc, bytes: passport('m35-ceiling') });
  ok(ceilingReplay, 201);
  assert.equal(ceilingReplay.body.idempotentReplay, true);
  assert.equal(ceilingReplay.body.sequence, 200);
  assert.equal(count(`app.candidate_versions where agent_id='${ceilingAgent}'`), 200);
  const ceilingFresh = await create(author, { agentId: ceilingAgent, bytes: passport('m35-ceiling') });
  assert.deepEqual([ceilingFresh.status, ceilingFresh.body.code], [409, 'E_VERSION_LIMIT'], 'control: a fresh key');

  /* A create and a save replayed after the active gate identity rotated between the attempts. */
  const kg = key();
  const ks2 = key();
  const d2 = await create(author, { agentId, bytes: passport('m35-rot') });
  ok(d2, 201);
  await create(author, { agentId, idem: kg, bytes: passport('m35-rot-create') });
  await save(author, d2.body.candidateId, 1, { idem: ks2, bytes: passport('m35-rot-save') });
  rotate();
  try {
    const rows = count(`app.candidate_versions where agent_id='${agentId}'`);
    const createReplay = await create(author, { agentId, idem: kg, bytes: passport('m35-rot-create') });
    ok(createReplay, 201);
    assert.equal(createReplay.body.idempotentReplay, true);
    assert.deepEqual(
      [
        createReplay.body.attestation.gateIdentitySha256,
        createReplay.body.attestation.validatorVersion,
        createReplay.body.attestation.gateStatus,
      ],
      [GATE_IDENTITY_SHA256, VALIDATOR_VERSION, 'stale'],
      'the stored identity, now stale',
    );
    const saveRotReplay = await save(author, d2.body.candidateId, 1, { idem: ks2, bytes: passport('m35-rot-save') });
    ok(saveRotReplay, 200);
    assert.equal(saveRotReplay.body.idempotentReplay, true);
    assert.equal(count(`app.candidate_versions where agent_id='${agentId}'`), rows, 'no second row');
    const rotFresh = await create(author, { agentId, bytes: passport('m35-rot-create') });
    assert.deepEqual([rotFresh.status, rotFresh.body.code], [503, 'E_GATE_UNREGISTERED'], 'control: a fresh key');
  } finally {
    unrotate();
  }

  /* The one that goes the other way: a submit replayed after the stored bytes stopped passing the gate is 422
     E_GATE_FAILS_NOW from the service, and the claim holding its first answer is never consulted. */
  const d3 = await create(author, { agentId, bytes: passport('m35-rule') });
  const kf = key();
  await submit(author, d3.body.candidateId, 1, { idem: kf });
  assert.equal(count(`app.idempotency_keys where key='${kf}'`), 1, 'the first attempt stored its answer');
  const refuseStoredBytes = (candidateId) =>
    sql(
      `begin; alter table app.candidate_versions disable trigger candidate_1_immutable; update app.candidate_versions set content = replace(content, '${PROSE}', '${PROSE} Share it at app.phaeacia.ai today.') where id='${candidateId}'; alter table app.candidate_versions enable trigger candidate_1_immutable; commit;`,
    );
  refuseStoredBytes(d3.body.candidateId);
  const audits = Number(sql('select count(*) from app.audit_events'));
  const ruleReplay = await submit(author, d3.body.candidateId, 1, { idem: kf });
  assert.deepEqual([ruleReplay.status, ruleReplay.body.code], [422, 'E_GATE_FAILS_NOW'], ruleReplay.raw);
  assert.ok(!Object.hasOwn(ruleReplay.body, 'idempotentReplay'));
  assert.equal(Number(sql('select count(*) from app.audit_events')), audits);
  const ruleFresh = await submit(author, d3.body.candidateId, 1);
  assert.deepEqual([ruleFresh.status, ruleFresh.body.code], [422, 'E_GATE_FAILS_NOW'], 'the same refusal for a fresh key');
});

test('E3b critique F2: a replay reports its stored identity from the whole registry: current with every component past 100 later registrations, stale with its own after the draft is re-attested under another identity', async () => {
  const THIS_BUILD = {
    gateIdentitySha256: GATE_IDENTITY_SHA256,
    validatorVersion: VALIDATOR_VERSION,
    adapterLockSha256: ADAPTER_LOCK_SHA256,
    manifestSha256: MANIFEST_SHA256,
  };
  const d = await create(author, { name: `f2-${W.run}` });
  ok(d, 201);
  const agentId = d.body.agentId;

  /* The critic's registry-limit probe: this build's registration stays active, 100 inactive ones are registered
     after it, and a create is replayed with its original key and bytes. */
  const k1 = key();
  const first = await create(author, { agentId, idem: k1, bytes: passport('f2-registry') });
  ok(first, 201);
  sql(
    `insert into app.gate_identities (identity_sha256, adapter_lock_sha256, validator_version, manifest_sha256, upstream_commit, registered_at, active) select sha256(convert_to('e3b-f2-' || g, 'UTF8')), sha256('e3b-f2-lock'), '0.1.0', sha256('e3b-f2-manifest'), repeat('d', 40), clock_timestamp() + interval '1 second', false from generate_series(1, 100) g`,
  );
  const replay1 = await create(author, { agentId, idem: k1, bytes: passport('f2-registry') });
  ok(replay1, 201);
  assert.equal(replay1.body.idempotentReplay, true);
  assert.deepEqual(replay1.body.attestation, {
    ...THIS_BUILD,
    validatedAt: first.body.attestation.validatedAt,
    gateStatus: 'current',
  });
  const gateAnswer = await call('gateRead', { user: author });
  assert.equal(gateAnswer.body.agrees, true, 'control: the gate route says this build is active');

  /* The re-attestation the stored hash exists for (the lead, 2026-09-14): key K under this build's identity; another
     identity becomes active and saves the draft, as a newer deployment would; K is retried. The candidate row names
     the other identity by then; the stored answer does not. */
  const OTHER = 'f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2';
  const k2 = key();
  const raced = await create(author, { agentId, idem: k2, bytes: passport('f2-race') });
  ok(raced, 201);
  sql(
    `set local app.registry_migration = 'on'; update app.gate_identities set active = false where active; insert into app.gate_identities (identity_sha256, adapter_lock_sha256, validator_version, manifest_sha256, upstream_commit, active) values (decode('${OTHER}','hex'), sha256('e3b-f2-other-lock'), '0.2.0', sha256('e3b-f2-other-manifest'), repeat('e', 40), true);`,
  );
  try {
    const session = (await verifySession({ headers: { cookie: `${COOKIES.access}=${author.token()}` } })).session;
    const verdict = gate(passport('f2-race-newer-build'), 'text/markdown', { validatedAt: new Date().toISOString() });
    assert.ok(verdict.ok);
    const saved = await callBound(session, 'save_draft', {
      candidate_id: raced.body.candidateId,
      expected_version: 1,
      content: verdict.text,
      derived_canonical: verdict.derivedCanonical,
      gate_identity: OTHER,
      idempotency_key: key(),
    });
    assert.equal(saved.version, 2);
    assert.equal(
      sql(
        `select encode(g.identity_sha256, 'hex') from app.candidate_versions v join app.gate_identities g on g.id = v.gate_id where v.id='${raced.body.candidateId}'`,
      ),
      OTHER,
      'the row is attested by the other identity now',
    );
    const replay2 = await create(author, { agentId, idem: k2, bytes: passport('f2-race') });
    ok(replay2, 201);
    assert.equal(replay2.body.idempotentReplay, true);
    assert.equal(replay2.body.version, 1, 'the stored answer, not the row as it is now');
    assert.deepEqual(replay2.body.attestation, {
      ...THIS_BUILD,
      validatedAt: raced.body.attestation.validatedAt,
      gateStatus: 'stale',
    });
  } finally {
    unrotate();
  }
});

test('case 42, route half: a bearer the service minted and answered from the claim never writes after the window; the refused-bearer residual is asserted as behaviour', async () => {
  const ttl = Number(/const TOKEN_TTL_SECONDS = (\d+);/.exec(readFileSync(join(ROOT, 'lib/db/server.mjs'), 'utf8'))[1]);
  const margin = Number(sql('select extract(epoch from app.idempotency_retention() - app.idempotency_window())::int'));
  assert.ok(margin > ttl, `retention exceeds the window by ${margin} s, more than the bearer's ${ttl} s`);
  const d = await create(author, { name: `r42-${W.run}` });
  const agentId = d.body.agentId;
  const rows = () => count(`app.candidate_versions where agent_id='${agentId}'`);
  const creates = () =>
    Number(sql(`select count(*) from app.audit_events where action='candidate.create' and details->>'agent_id'='${agentId}'`));
  const age = (k, expression) =>
    sql(`update app.idempotency_keys set created_at = ${expression} where membership_id='${M.author}' and key='${k}'`);
  /* The bearer and body the service sends for one route call. */
  const captured = async (run) => {
    let bearer = null;
    const response = await withFetch(async (url, init, original) => {
      if (String(url).endsWith('/rest/v1/rpc/create_draft')) bearer = { url: String(url), init: { ...init } };
      return original(url, init);
    }, run);
    return { response, bearer };
  };
  const present = async ({ url, init }) => {
    const r = await fetch(url, init);
    return { status: r.status, body: await r.json() };
  };

  const k = key();
  await create(author, { agentId, idem: k, bytes: passport('r42') });
  age(k, "clock_timestamp() - app.idempotency_window() + interval '20 seconds'");
  const inside = await captured(() => create(author, { agentId, idem: k, bytes: passport('r42') }));
  ok(inside.response, 201);
  assert.equal(inside.response.body.idempotentReplay, true, 'twenty seconds inside the window: the stored answer');
  const rows0 = rows();
  const creates0 = creates();
  age(k, "clock_timestamp() - app.idempotency_window() - interval '1 second'");
  ok(await create(author, { name: `r42-sweep-${W.run}`, bytes: passport('r42-sweep') }), 201);
  assert.equal(count(`app.idempotency_keys where membership_id='${M.author}' and key='${k}'`), 1, 'past the window, not past retention: kept');
  const again = await present(inside.bearer);
  assert.match(again.body.message, /^E_IDEMPOTENCY_EXPIRED/, JSON.stringify(again.body));
  const routeAgain = await create(author, { agentId, idem: k, bytes: passport('r42') });
  assert.deepEqual([routeAgain.status, routeAgain.body.code], [409, 'E_IDEMPOTENCY_EXPIRED']);
  assert.deepEqual([rows(), creates()], [rows0, creates0], 'the answered bearer wrote nothing, and no audit row');

  /* The accepted residual, run as the control: a bearer refused in the tombstone band writes after the sweep. */
  const kb = key();
  await create(author, { agentId, idem: kb, bytes: passport('r42b') });
  age(kb, "clock_timestamp() - app.idempotency_retention() + interval '20 seconds'");
  const rows1 = rows();
  const creates1 = creates();
  const band = await captured(() => create(author, { agentId, idem: kb, bytes: passport('r42b') }));
  assert.deepEqual([band.response.status, band.response.body.code], [409, 'E_IDEMPOTENCY_EXPIRED'], 'RESIDUAL_FIRST');
  age(kb, "clock_timestamp() - app.idempotency_retention() - interval '1 second'");
  ok(await create(author, { name: `r42b-sweep-${W.run}`, bytes: passport('r42b-sweep') }), 201);
  assert.equal(count(`app.idempotency_keys where membership_id='${M.author}' and key='${kb}'`), 0, 'the sweep removed the tombstone');
  const second = await present(band.bearer);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.idempotent_replay, false, 'RESIDUAL_SECOND: no claim, a new candidate');
  const repeat = await present(band.bearer);
  assert.equal(repeat.body.idempotent_replay, true, 'RESIDUAL_REPEAT: the new claim answers it');
  assert.deepEqual([rows() - rows1, creates() - creates1], [1, 1], 'RESIDUAL_TOTAL_NEW_WRITES: one row, one audit row');
});

test('case 28a, the successor rows the route owns: its attestation is this request’s, and a parent the active gate now refuses is 422 E_GATE_FAILS_NOW before any call', async () => {
  const d = await create(author, { name: `s28-${W.run}` });
  const agentId = d.body.agentId;
  const parent = await create(author, { agentId, bytes: passport('s28-parent') });
  ok(await submit(author, parent.body.candidateId, 1), 200);
  requestChanges(parent.body.candidateId);
  await new Promise((r) => setTimeout(r, 20));
  const made = await successor(author, parent.body.candidateId);
  ok(made, 201);
  assert.equal(
    sql(
      `select (s.content_sha256 = p.content_sha256)||'|'||(s.derived_canonical <> p.derived_canonical)||'|'||(s.derived_sha256 <> p.derived_sha256)||'|'||(s.validated_at <> p.validated_at)||'|'||(s.gate_id = p.gate_id) from app.candidate_versions s, app.candidate_versions p where s.id='${made.body.candidateId}' and p.id='${parent.body.candidateId}'`,
    ),
    'true|true|true|true|true',
    'same bytes; this request’s derived bytes and validated_at; the active gate',
  );
  assert.equal(made.body.attestation.validatedAt, sql(`select to_char(validated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from app.candidate_versions where id='${made.body.candidateId}'`));

  const refused = await create(author, { agentId, bytes: passport('s28-refused') });
  ok(await submit(author, refused.body.candidateId, 1), 200);
  requestChanges(refused.body.candidateId);
  sql(
    `begin; alter table app.candidate_versions disable trigger candidate_1_immutable; update app.candidate_versions set content = replace(content, '${PROSE}', '${PROSE} Share it at app.phaeacia.ai today.') where id='${refused.body.candidateId}'; alter table app.candidate_versions enable trigger candidate_1_immutable; commit;`,
  );
  assert.equal(
    sql(`select content_sha256 = sha256(convert_to(content,'UTF8')) from app.candidate_versions where id='${refused.body.candidateId}'`),
    't',
    'the fixture keeps the row self-consistent: the identity trigger recomputed the hash',
  );
  const rows = count(`app.candidate_versions where agent_id='${agentId}'`);
  const audits = Number(sql('select count(*) from app.audit_events'));
  let rpc = 0;
  const r = await withFetch((url, init, original) => {
    if (String(url).includes('/rest/v1/rpc/')) rpc++;
    return original(url, init);
  }, () => successor(author, refused.body.candidateId));
  assert.deepEqual([r.status, r.body.code], [422, 'E_GATE_FAILS_NOW'], r.raw);
  assert.equal(rpc, 0, 'no call');
  assert.equal(count(`app.candidate_versions where agent_id='${agentId}'`), rows, 'no successor row');
  assert.equal(Number(sql('select count(*) from app.audit_events')), audits, 'no audit row');
  /* Control: the author's own successor of a parent the current gate passes, above. And the reviewer, who may read
     the refused parent, meets the same refusal. */
  const byReviewer = await successor(reviewer, refused.body.candidateId);
  assert.deepEqual([byReviewer.status, byReviewer.body.code], [422, 'E_GATE_FAILS_NOW']);
});
