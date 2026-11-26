/* lib/services/candidates.mjs without a stack (E3 design 4.1 to 4.5). A PostgREST double records every read and every
   call, so each test states which requests were made and in what order: design 4.5's row 10 before any read, row 11
   (standing under the caller's own token) before the gate, the gate before the routine, and nothing that decides a
   fresh-only precondition in front of the claim. The route halves of cases 1, 8, 18, 19, 29, 30 and 35 are
   tests/e3/stack/; these are their service halves, each layer checked with the other out of the way
   (evidence/http-d1.md, lesson 1). */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  AGENT,
  answer,
  CANDIDATE,
  COMPANY,
  fakeDb,
  GATE_ID,
  gateRow,
  KEY,
  MEMBERSHIP,
  manifest,
  OLD_GATE_ID,
  OTHER_IDENTITY,
  OTHER_MEMBERSHIP,
  oldGateRow,
  PROSE,
  refusal,
  STORED_AT,
  SUB,
  session,
  sha,
  userToken,
  X,
} from './fake-postgrest.mjs';
import { CR, cp, lineOf, REPO, SYNTHETIC, variant } from './helpers.mjs';
import { SUBMISSION, SUBMISSION_SHAPES, TRIMMED_SHAPES } from './submission-shapes.mjs';

const { bindCall } = await import('../../../lib/db/server.mjs');
const { CODES, messageFor } = await import('../../../lib/errors.mjs');
const service = await import('../../../lib/services/candidates.mjs');

const stored = (over = {}) => answer(over, SYNTHETIC);
const createArgs = (over = {}) => ({
  companyId: COMPANY,
  agentName: 'weekly-brief',
  idempotencyKey: KEY,
  contentType: 'text/markdown',
  bytes: Buffer.from(SYNTHETIC, 'utf8'),
  ...over,
});
const saveArgs = (over = {}) => ({
  candidateId: CANDIDATE,
  idempotencyKey: KEY,
  ifMatch: '3',
  contentType: 'text/markdown',
  bytes: Buffer.from(SYNTHETIC, 'utf8'),
  ...over,
});
const submitArgs = (over = {}) => ({
  candidateId: CANDIDATE,
  idempotencyKey: KEY,
  ifMatch: '4',
  body: { ...SUBMISSION },
  ...over,
});
const successorArgs = (over = {}) => ({ candidateId: CANDIDATE, idempotencyKey: KEY, body: {}, ...over });
const candidateRow = (content = SYNTHETIC) => [{ id: CANDIDATE, content }];
const kinds = (db) => db.calls.map((c) => c.read ?? c.rpc);
const FRESH_ATTESTATION = Object.freeze({
  gateIdentitySha256: manifest.GATE_IDENTITY_SHA256,
  validatorVersion: manifest.VALIDATOR_VERSION,
  adapterLockSha256: manifest.ADAPTER_LOCK_SHA256,
  manifestSha256: manifest.MANIFEST_SHA256,
  validatedAt: STORED_AT,
  gateStatus: 'current',
});

test('row 10: a missing or malformed Idempotency-Key refuses every write before anything is read', async () => {
  for (const bad of [undefined, '', 'nope', `${KEY}0`, KEY.replaceAll('-', ''), ` ${KEY}`]) {
    const db = fakeDb();
    await assert.rejects(
      service.createCandidate(session, createArgs({ idempotencyKey: bad }), db.options),
      refusal('E_IDEMPOTENCY_KEY_INVALID'),
    );
    await assert.rejects(
      service.saveCandidate(session, saveArgs({ idempotencyKey: bad }), db.options),
      refusal('E_IDEMPOTENCY_KEY_INVALID'),
    );
    await assert.rejects(
      service.submitCandidate(session, submitArgs({ idempotencyKey: bad }), db.options),
      refusal('E_IDEMPOTENCY_KEY_INVALID'),
    );
    await assert.rejects(
      service.createSuccessor(session, successorArgs({ idempotencyKey: bad }), db.options),
      refusal('E_IDEMPOTENCY_KEY_INVALID'),
    );
    assert.deepEqual(db.calls, [], JSON.stringify(bad));
  }
});

test('row 10: If-Match must be a plain decimal integer the routine holds; 428 before anything is read', async () => {
  for (const bad of [undefined, '', '3abc', '"3"', 'W/"3"', '3.0', '1e3', '03', '+3', ' 3', '2147483648', '-2147483649']) {
    const db = fakeDb();
    await assert.rejects(service.saveCandidate(session, saveArgs({ ifMatch: bad }), db.options), refusal('E_VERSION_REQUIRED'));
    await assert.rejects(
      service.submitCandidate(session, submitArgs({ ifMatch: bad }), db.options),
      refusal('E_VERSION_REQUIRED'),
    );
    assert.deepEqual(db.calls, [], JSON.stringify(bad));
  }
  /* Values the routine's integer parameter holds are not refused here: it answers them (E_VERSION_CONFLICT). */
  for (const [header, expected] of [
    ['0', 0],
    ['-1', -1],
    ['2147483647', 2147483647],
    ['-2147483648', -2147483648],
  ]) {
    const db = fakeDb({ tables: { candidate_versions: [{ id: CANDIDATE }] } });
    await service.saveCandidate(session, saveArgs({ ifMatch: header }), db.options);
    assert.equal(db.calls.at(-1).body.p_expected_version, expected, header);
  }
});

/* E3b critique F5: each header above is tested beside a valid other, which cannot tell the order apart. The critic's
   mutant S1 swaps If-Match ahead of Idempotency-Key and every row above still passes; these do not. */
test('row 10 order (E3b critique F5): with both headers bad, save and submit answer E_IDEMPOTENCY_KEY_INVALID; If-Match precedes the submission shape; nothing is read', async () => {
  const bothBad = [
    ['both absent', undefined, undefined],
    ['both malformed', 'nope', 'W/"3"'],
    ['key absent, If-Match malformed', undefined, '3abc'],
    ['key malformed, If-Match absent', `${KEY}0`, undefined],
  ];
  for (const [label, idempotencyKey, ifMatch] of bothBad) {
    const db = fakeDb({ tables: { candidate_versions: candidateRow() } });
    await assert.rejects(
      service.saveCandidate(session, saveArgs({ idempotencyKey, ifMatch }), db.options),
      refusal('E_IDEMPOTENCY_KEY_INVALID'),
      `save, ${label}`,
    );
    await assert.rejects(
      service.submitCandidate(session, submitArgs({ idempotencyKey, ifMatch }), db.options),
      refusal('E_IDEMPOTENCY_KEY_INVALID'),
      `submit, ${label}`,
    );
    await assert.rejects(
      service.submitCandidate(session, submitArgs({ idempotencyKey, ifMatch, body: { sourcePlatform: 7 } }), db.options),
      refusal('E_IDEMPOTENCY_KEY_INVALID'),
      `submit, ${label}, and a malformed submission`,
    );
    assert.deepEqual(db.calls, [], label);
  }
  const db = fakeDb({ tables: { candidate_versions: candidateRow() } });
  await assert.rejects(
    service.submitCandidate(session, submitArgs({ ifMatch: undefined, body: { sourcePlatform: 7 } }), db.options),
    refusal('E_VERSION_REQUIRED'),
    'a valid key, If-Match absent and a malformed submission',
  );
  assert.deepEqual(db.calls, []);
});

test('create: X-Agent-Name or X-Agent-Id, exactly one; a bad name is E_BODY_INVALID, a bad id E_NOT_FOUND, before any read', async () => {
  const cases = [
    [{ agentName: undefined }, 'E_BODY_INVALID'],
    [{ agentId: AGENT }, 'E_BODY_INVALID'],
    [{ agentName: '' }, 'E_BODY_INVALID'],
    [{ agentName: 'Weekly-Brief' }, 'E_BODY_INVALID'],
    [{ agentName: '-brief' }, 'E_BODY_INVALID'],
    [{ agentName: 'a'.repeat(65) }, 'E_BODY_INVALID'],
    [{ agentName: 'weekly_brief' }, 'E_BODY_INVALID'],
    [{ agentName: undefined, agentId: 'not-a-uuid' }, 'E_NOT_FOUND'],
    [{ agentName: undefined, agentId: `${AGENT}0` }, 'E_NOT_FOUND'],
  ];
  for (const [over, code] of cases) {
    const db = fakeDb();
    await assert.rejects(service.createCandidate(session, createArgs(over), db.options), refusal(code));
    assert.deepEqual(db.calls, [], JSON.stringify(over));
  }
  const db = fakeDb();
  await service.createCandidate(session, createArgs({ agentName: 'a'.repeat(64) }), db.options);
  assert.equal(db.calls.at(-1).body.p_agent_name, 'a'.repeat(64), 'the 64-character name the grammar allows');
});

test('row 11 before the gate (case 19, service half): a non-member of the route company is E_NOT_FOUND after one read under the user token, even with a passport the gate refuses', async () => {
  const withCr = variant([[PROSE, `${PROSE}${CR}More.`]]);
  const db = fakeDb({ tables: { memberships: [] } });
  await assert.rejects(
    service.createCandidate(session, createArgs({ bytes: Buffer.from(withCr, 'utf8') }), db.options),
    refusal('E_NOT_FOUND'),
  );
  assert.deepEqual(kinds(db), ['my_standing']);
  assert.equal(db.calls[0].auth, `Bearer ${userToken}`);
  assert.equal(db.calls[0].params.company_id, `eq.${COMPANY}`);
  /* api.my_standing is scoped to auth.uid() inside its definer function, so the caller is the token and not a
     filter: a user_id parameter on this read would be a filter the service composed and the view already refuses
     to need (E6 design 1.1). */
  assert.equal(db.calls[0].params.user_id, undefined);
  const removed = fakeDb({ tables: { memberships: [{ id: MEMBERSHIP, roles: ['member'], status: 'removed' }] } });
  await assert.rejects(service.createCandidate(session, createArgs(), removed.options), refusal('E_NOT_FOUND'));
  assert.ok(!removed.calls.some((c) => c.rpc), 'no call for a removed membership');
});

test('row 11 before the gate (case 19, service half): an agent id is read inside the route company; one that is not there is E_NOT_FOUND with no call', async () => {
  const db = fakeDb({ tables: { agents: [] } });
  await assert.rejects(
    service.createCandidate(session, createArgs({ agentName: undefined, agentId: AGENT.toUpperCase() }), db.options),
    refusal('E_NOT_FOUND'),
  );
  assert.deepEqual(kinds(db), ['my_standing', 'agents']);
  assert.deepEqual(db.calls[1].params, { select: 'id', id: `eq.${AGENT}`, company_id: `eq.${COMPANY}` });
  assert.equal(db.calls[1].auth, `Bearer ${userToken}`);
  const found = fakeDb({ tables: { agents: [{ id: AGENT }] } });
  await service.createCandidate(session, createArgs({ agentName: undefined, agentId: AGENT }), found.options);
  const call = found.calls.at(-1);
  assert.equal(call.rpc, 'create_draft');
  assert.equal(call.body.p_agent, AGENT);
  assert.equal(call.body.p_agent_name, null);
});

test('save, submit and successor (row 11): an invisible candidate is E_NOT_FOUND after one read under the user token, before the gate and with no call', async () => {
  const withCr = Buffer.from(variant([[PROSE, `${PROSE}${CR}More.`]]), 'utf8');
  const runs = [
    ['save', (o) => service.saveCandidate(session, saveArgs({ bytes: withCr }), o)],
    ['submit', (o) => service.submitCandidate(session, submitArgs(), o)],
    ['successor', (o) => service.createSuccessor(session, successorArgs(), o)],
  ];
  for (const [label, run] of runs) {
    const db = fakeDb({ tables: { candidate_versions: [] } });
    await assert.rejects(run(db.options), refusal('E_NOT_FOUND'), label);
    assert.deepEqual(kinds(db), ['candidate_versions'], label);
    assert.equal(db.calls[0].params.id, `eq.${CANDIDATE}`, label);
    assert.equal(db.calls[0].auth, `Bearer ${userToken}`, label);
  }
  const malformed = fakeDb();
  await assert.rejects(service.saveCandidate(session, saveArgs({ candidateId: 'x' }), malformed.options), refusal('E_NOT_FOUND'));
  assert.deepEqual(malformed.calls, []);
});

test('rows 12 to 17 (case 8, service half): a surviving carriage return is PassportRefused E_CANONICAL with its line, after standing, with no call', async () => {
  for (const [label, text] of [
    ['a lone CR in prose', variant([[PROSE, `${PROSE}${CR}More.`]])],
    ['CR CR LF', variant([[PROSE, `${PROSE}${CR}${CR}\nMore.`]])],
  ]) {
    for (const run of ['create', 'save']) {
      const db = fakeDb({ tables: { candidate_versions: [{ id: CANDIDATE }] } });
      const bytes = Buffer.from(text, 'utf8');
      const p =
        run === 'create'
          ? service.createCandidate(session, createArgs({ bytes }), db.options)
          : service.saveCandidate(session, saveArgs({ bytes }), db.options);
      await assert.rejects(p, (e) => {
        assert.ok(e instanceof service.PassportRefused, `${label} ${run}: ${e.name}`);
        assert.equal(e.code, 'E_CANONICAL');
        assert.equal(e.status, 422);
        assert.deepEqual(JSON.parse(JSON.stringify(e.data)), { problems: [{ code: 'E_CANONICAL', line: lineOf(text, PROSE) }] });
        return true;
      });
      assert.equal(db.calls.length, 1, `${label} ${run}: only the standing read, no call`);
    }
  }
  const control = fakeDb();
  await service.createCandidate(session, createArgs(), control.options);
  assert.equal(control.calls.at(-1).rpc, 'create_draft', 'control: the same passport with line feeds is called');
});

test('create: the call carries the transport text, fresh derived bytes stamped once, this server identity and the lowercased key, bound to exactly that body', async () => {
  const sent = `${cp(0xfeff)}${SYNTHETIC.replaceAll('\n', `${CR}\n`)}`;
  const db = fakeDb({ rpc: () => stored() });
  const before = Date.now();
  const r = await service.createCandidate(
    session,
    createArgs({
      bytes: Buffer.from(sent, 'utf8'),
      idempotencyKey: KEY.toUpperCase(),
      contentType: 'text/markdown; charset=utf-8',
    }),
    db.options,
  );
  const after = Date.now();
  assert.deepEqual(kinds(db), ['my_standing', 'create_draft'], 'a fresh write reads no registry');
  const { body, claims } = db.calls[1];
  assert.equal(body.p_company, COMPANY);
  assert.equal(body.p_agent, null);
  assert.equal(body.p_agent_name, 'weekly-brief');
  assert.equal(body.p_content, SYNTHETIC, 'the transport output: no BOM, CR LF as LF');
  assert.equal(body.p_gate_identity, `${X}${manifest.GATE_IDENTITY_SHA256}`);
  assert.equal(body.p_idempotency_key, KEY);
  const derived = JSON.parse(body.p_derived_canonical);
  const stamped = Date.parse(derived.validated_at);
  assert.ok(stamped >= before && stamped <= after, 'validatedAt is this request');
  assert.equal(claims.role, 'app_server');
  assert.equal(claims.sub, SUB);
  assert.equal(claims.fn, 'create_draft');
  const expected = bindCall('create_draft', {
    company_id: COMPANY,
    agent_name: 'weekly-brief',
    content: SYNTHETIC,
    derived_canonical: body.p_derived_canonical,
    gate_identity: manifest.GATE_IDENTITY_SHA256,
    idempotency_key: KEY,
  });
  assert.equal(claims.args_sha256, expected.argsSha256);
  assert.deepEqual(r, {
    ok: true,
    candidateId: CANDIDATE,
    agentId: AGENT,
    sequence: 1,
    version: 1,
    state: 'draft',
    contentSha256: sha(SYNTHETIC),
    derivedSha256: 'd'.repeat(64),
    attestation: FRESH_ATTESTATION,
    derived: {
      title: derived.title,
      summary: derived.summary,
      needs: derived.needs.map((n) => ({ capability: n.capability, required: n.required, installable: n.installable })),
    },
    lossesPresent: false,
  });
});

test('a replay answers the stored result, reads the registry for its attestation, and says so; a rotated identity is stale', async () => {
  const replay = (identity) => () => stored({ idempotent_replay: true, version: 2, gate_identity_sha256: identity });
  const current = fakeDb({ tables: { candidate_versions: [{ id: CANDIDATE }] }, rpc: replay(manifest.GATE_IDENTITY_SHA256) });
  const r = await service.saveCandidate(session, saveArgs(), current.options);
  assert.equal(r.idempotentReplay, true);
  assert.equal(r.version, 2, 'the stored version, not a new one');
  assert.equal(r.attestation.validatedAt, STORED_AT, "the first attempt's time");
  assert.equal(r.attestation.gateStatus, 'current');
  assert.deepEqual(current.calls.find((c) => c.read === 'gate_identities').params, {
    select: 'id,identity_sha256,adapter_lock_sha256,validator_version,manifest_sha256,upstream_commit,registered_at,active',
    order: 'id.asc',
    limit: '200',
  });
  const rotated = fakeDb({
    tables: {
      candidate_versions: [{ id: CANDIDATE }],
      gate_identities: [gateRow({ identity_sha256: `${X}${'c'.repeat(64)}` }), oldGateRow()],
    },
    rpc: replay(OTHER_IDENTITY),
  });
  const s = await service.saveCandidate(session, saveArgs(), rotated.options);
  assert.deepEqual(s.attestation, {
    gateIdentitySha256: OTHER_IDENTITY,
    validatorVersion: '0.0.9',
    adapterLockSha256: 'a'.repeat(64),
    manifestSha256: 'b'.repeat(64),
    validatedAt: STORED_AT,
    gateStatus: 'stale',
  });
  /* E3b critique F2: a stored identity the visible registry lacks is a defect, never null components; a reader who sees
     no registration at all has lost standing since the call. */
  const unknown = fakeDb({ tables: { candidate_versions: [{ id: CANDIDATE }] }, rpc: replay('f'.repeat(64)) });
  await assert.rejects(service.saveCandidate(session, saveArgs(), unknown.options), refusal('E_INTERNAL'));
  const unseen = fakeDb({
    tables: { candidate_versions: [{ id: CANDIDATE }], gate_identities: [] },
    rpc: replay(manifest.GATE_IDENTITY_SHA256),
  });
  await assert.rejects(service.saveCandidate(session, saveArgs(), unseen.options), refusal('E_NOT_FOUND'));
  const fresh = fakeDb({ tables: { candidate_versions: [{ id: CANDIDATE }] } });
  const f = await service.saveCandidate(session, saveArgs(), fresh.options);
  assert.ok(!Object.hasOwn(f, 'idempotentReplay'), 'a fresh answer carries no replay field');
});

test('save: the candidate read, then the gate, then save_draft carrying If-Match; nothing decides state or version first', async () => {
  const db = fakeDb({ tables: { candidate_versions: [{ id: CANDIDATE }] } });
  await service.saveCandidate(session, saveArgs({ ifMatch: '7' }), db.options);
  assert.deepEqual(kinds(db), ['candidate_versions', 'save_draft']);
  assert.deepEqual(db.calls[0].params, { select: 'id', id: `eq.${CANDIDATE}` });
  const { body } = db.calls[1];
  assert.deepEqual(Object.keys(body), [
    'p_candidate',
    'p_expected_version',
    'p_content',
    'p_derived_canonical',
    'p_gate_identity',
    'p_idempotency_key',
  ]);
  assert.equal(body.p_candidate, CANDIDATE);
  assert.equal(body.p_expected_version, 7);
  assert.equal(body.p_content, SYNTHETIC);
});

test('submit: the stored bytes are re-gated, their own hash is bound, the metadata is canonical snake_case, names trimmed', async () => {
  const db = fakeDb({
    tables: {
      candidate_versions: candidateRow(),
      /* In id order, as the paged read asks for them (E3b critique F3); the answer's order is the service's sort. */
      candidate_contributors: [
        { id: '00000000-0000-4000-8000-000000000001', kind: 'author', membership_id: OTHER_MEMBERSHIP, display_name: null, inherited_from_candidate_id: AGENT },
        { id: '00000000-0000-4000-8000-000000000002', kind: 'declared_offline', membership_id: null, display_name: 'Jane Doe (former intern)', inherited_from_candidate_id: null },
        { id: '00000000-0000-4000-8000-000000000003', kind: 'submitter', membership_id: MEMBERSHIP, display_name: null, inherited_from_candidate_id: null },
        { id: '00000000-0000-4000-8000-000000000004', kind: 'declared_member', membership_id: OTHER_MEMBERSHIP, display_name: null, inherited_from_candidate_id: null },
        { id: '00000000-0000-4000-8000-000000000005', kind: 'author', membership_id: MEMBERSHIP, display_name: null, inherited_from_candidate_id: null },
      ],
    },
    rpc: () => stored({ state: 'submitted', version: 5, submitted_at: '2026-09-13T08:00:01.234567+00:00' }),
  });
  const before = Date.now();
  const r = await service.submitCandidate(
    session,
    submitArgs({
      body: {
        ...SUBMISSION,
        dependencies: ['files.read', 'chat.notify'],
        declaredContributors: [{ membershipId: OTHER_MEMBERSHIP }, { displayName: `  Jane Doe (former intern)${cp(0x09)}` }],
      },
    }),
    db.options,
  );
  assert.deepEqual(
    kinds(db),
    ['candidate_versions', 'submit_candidate', 'candidate_contributors', 'candidate_versions'],
    'the candidate is read again after the last contributor page (E3b critique F3)',
  );
  assert.deepEqual(db.calls[0].params, { select: 'id,content', id: `eq.${CANDIDATE}` });
  const { body, claims } = db.calls[1];
  assert.equal(body.p_candidate, CANDIDATE);
  assert.equal(body.p_expected_version, 4);
  assert.equal(body.p_content_sha256, `${X}${sha(SYNTHETIC)}`);
  assert.ok(Date.parse(JSON.parse(body.p_derived_canonical).validated_at) >= before, 'a fresh re-gate');
  assert.equal(
    body.p_submission_canonical,
    `{"confidence":"high","declared_contributors":[{"membership_id":"${OTHER_MEMBERSHIP}"},{"display_name":"Jane Doe (former intern)"}],"dependencies":["files.read","chat.notify"],"permitted_data":"Internal weekly reports, no client names","source_platform":"claude_code"}`,
  );
  assert.equal(claims.fn, 'submit_candidate');
  assert.deepEqual(r, {
    ok: true,
    candidateId: CANDIDATE,
    state: 'submitted',
    version: 5,
    submittedAt: '2026-09-13T08:00:01.234Z',
    attestationFrozen: true,
    attestation: FRESH_ATTESTATION,
    contributors: [
      { kind: 'author', membershipId: MEMBERSHIP },
      { kind: 'submitter', membershipId: MEMBERSHIP },
      { kind: 'declared_member', membershipId: OTHER_MEMBERSHIP },
      { kind: 'declared_offline', displayName: 'Jane Doe (former intern)' },
      { kind: 'author', membershipId: OTHER_MEMBERSHIP, inheritedFromCandidateId: AGENT },
    ],
  });
});

test('row 18 (case 28a gate row, service half): stored bytes the gate refuses, or would change, are E_GATE_FAILS_NOW on submit and successor, with no call', async () => {
  const cases = [
    ['a carriage return', variant([[PROSE, `${PROSE}${CR}More.`]])],
    ['a public publisher route', variant([[PROSE, `${PROSE} Share it at app.phaeacia.ai today.`]])],
    ['a leading byte-order mark transport would strip', `${cp(0xfeff)}${SYNTHETIC}`],
  ];
  for (const [label, content] of cases) {
    const a = fakeDb({ tables: { candidate_versions: candidateRow(content) } });
    await assert.rejects(service.submitCandidate(session, submitArgs(), a.options), refusal('E_GATE_FAILS_NOW'), label);
    assert.deepEqual(kinds(a), ['candidate_versions'], label);
    const b = fakeDb({ tables: { candidate_versions: candidateRow(content) } });
    await assert.rejects(service.createSuccessor(session, successorArgs(), b.options), refusal('E_GATE_FAILS_NOW'), label);
    assert.deepEqual(kinds(b), ['candidate_versions'], label);
  }
});

test('successor: an empty JSON object only; the parent read, then create_successor with its hash and fresh derived bytes', async () => {
  for (const body of [{ contentSha256: 'a'.repeat(64) }, [], null, { '': 1 }]) {
    const db = fakeDb();
    await assert.rejects(service.createSuccessor(session, successorArgs({ body }), db.options), refusal('E_BODY_INVALID'));
    assert.deepEqual(db.calls, [], JSON.stringify(body));
  }
  const db = fakeDb({
    tables: { candidate_versions: candidateRow() },
    rpc: () => stored({ candidate_id: AGENT, sequence: 4, supersedes_candidate_id: CANDIDATE, inherited_contributors: 3 }),
  });
  const r = await service.createSuccessor(session, successorArgs(), db.options);
  assert.deepEqual(kinds(db), ['candidate_versions', 'create_successor']);
  const { body } = db.calls[1];
  assert.deepEqual(Object.keys(body), [
    'p_candidate',
    'p_content_sha256',
    'p_derived_canonical',
    'p_gate_identity',
    'p_idempotency_key',
  ]);
  assert.equal(body.p_content_sha256, `${X}${sha(SYNTHETIC)}`);
  assert.equal(JSON.parse(body.p_derived_canonical).title, 'SYNTHETIC Record Sorter');
  assert.deepEqual(r, {
    ok: true,
    candidateId: AGENT,
    sequence: 4,
    state: 'draft',
    supersedesCandidateId: CANDIDATE,
    inheritedContributors: 3,
    attestation: FRESH_ATTESTATION,
  });
});

test('submission shapes: E_BODY_INVALID exactly where app.submission_fields refuses, plus the trimmed display name (E3A-R-D1)', () => {
  for (const [label, body, ok] of [...SUBMISSION_SHAPES, ...TRIMMED_SHAPES]) {
    if (ok) assert.equal(typeof service.submissionOf(body), 'string', label);
    else assert.throws(() => service.submissionOf(body), refusal('E_BODY_INVALID'), label);
  }
  const proto = JSON.parse('{"__proto__":{"x":1},"sourcePlatform":"x","confidence":"high","permittedData":"x"}');
  for (const body of [null, [], 'x', proto])
    assert.throws(() => service.submissionOf(body), refusal('E_BODY_INVALID'), JSON.stringify(body));
  assert.equal(
    JSON.parse(service.submissionOf(TRIMMED_SHAPES[2][1])).declared_contributors[0].display_name,
    'n'.repeat(120),
    'the trimmed name is what is bound',
  );
});

test('submit: a malformed submission is E_BODY_INVALID before the candidate is read', async () => {
  const db = fakeDb({ tables: { candidate_versions: candidateRow() } });
  await assert.rejects(
    service.submitCandidate(
      session,
      submitArgs({ body: { ...SUBMISSION, declaredContributors: [{ displayName: '  ' }] } }),
      db.options,
    ),
    refusal('E_BODY_INVALID'),
  );
  assert.deepEqual(db.calls, []);
});

test('read: RLS decides the row; the answer maps it with the identity that attested it, contributors and gateStatus', async () => {
  const losses = variant([['| | | |', '| Calendar read | lost | The brief omits meetings. |']]);
  const row = {
    id: CANDIDATE,
    company_id: COMPANY,
    agent_id: AGENT,
    sequence: 2,
    state: 'submitted',
    version: 5,
    author_membership_id: MEMBERSHIP,
    supersedes_candidate_id: null,
    content: losses,
    content_sha256: `${X}${sha(losses)}`,
    derived: { title: 'SYNTHETIC Record Sorter' },
    derived_sha256: `${X}${'d'.repeat(64)}`,
    gate_id: OLD_GATE_ID,
    validated_at: '2026-09-13T08:00:00.5+00:00',
    attested_by: MEMBERSHIP,
    attested_at: '2026-09-13T08:00:01+00:00',
    submitted_at: '2026-09-13T08:00:01+00:00',
    submitted_by_membership_id: MEMBERSHIP,
    source_platform: 'claude_code',
    confidence: 'high',
    permitted_data: 'x',
    dependencies: ['a'],
  };
  const db = fakeDb({
    tables: {
      candidate_versions: [row],
      gate_identities: (params) => (params.id ? [oldGateRow()] : [{ id: GATE_ID }]),
      candidate_contributors: [
        { id: '00000000-0000-4000-8000-000000000001', kind: 'author', membership_id: MEMBERSHIP, display_name: null, inherited_from_candidate_id: null },
      ],
    },
  });
  const r = await service.readCandidate(session, { candidateId: CANDIDATE }, db.options);
  assert.equal(r.candidate.content, losses);
  assert.equal(r.candidate.lossesPresent, true, 'a declared losses row');
  assert.equal(r.candidate.gateStatus, 'stale');
  assert.equal(r.candidate.attestationFrozen, true);
  assert.equal(r.candidate.contentSha256, sha(losses));
  assert.deepEqual(r.candidate.attestation, {
    gateIdentitySha256: OTHER_IDENTITY,
    validatorVersion: '0.0.9',
    adapterLockSha256: 'a'.repeat(64),
    manifestSha256: 'b'.repeat(64),
    validatedAt: '2026-09-13T08:00:00.500Z',
    gateStatus: 'stale',
  });
  assert.deepEqual(r.contributors, [{ kind: 'author', membershipId: MEMBERSHIP }]);
  assert.deepEqual(db.calls[0].params.id, `eq.${CANDIDATE}`);
  assert.ok(db.calls.some((c) => c.read === 'gate_identities' && c.params.id === `eq.${OLD_GATE_ID}`));
  assert.ok(db.calls.some((c) => c.read === 'gate_identities' && c.params.active === 'is.true'));
  const none = fakeDb({ tables: { candidate_versions: [] } });
  await assert.rejects(service.readCandidate(session, { candidateId: CANDIDATE }, none.options), refusal('E_NOT_FOUND'));
  assert.equal(none.calls.length, 1);
});

test('list: state and cursor refused before any read; standing first; a page of 50 in id order with nextCursor', async () => {
  for (const query of [{ state: 'bogus' }, { state: '' }, { state: 'Draft' }, { cursor: 'x' }, { cursor: CANDIDATE.toUpperCase() }]) {
    const db = fakeDb();
    await assert.rejects(service.listCandidates(session, { companyId: COMPANY, query }, db.options), refusal('E_BODY_INVALID'));
    assert.deepEqual(db.calls, [], JSON.stringify(query));
  }
  const outsider = fakeDb({ tables: { memberships: [] } });
  await assert.rejects(service.listCandidates(session, { companyId: COMPANY }, outsider.options), refusal('E_NOT_FOUND'));
  assert.deepEqual(kinds(outsider), ['my_standing']);
  const ids = Array.from({ length: 51 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`);
  const listRow = (id) => ({
    id,
    agent_id: AGENT,
    sequence: 1,
    state: 'submitted',
    version: 2,
    author_membership_id: MEMBERSHIP,
    supersedes_candidate_id: null,
    content_sha256: `${X}${'1'.repeat(64)}`,
    derived_sha256: `${X}${'2'.repeat(64)}`,
    gate_id: GATE_ID,
    validated_at: STORED_AT,
    submitted_at: null,
  });
  const db = fakeDb({ tables: { candidate_versions: ids.map(listRow), gate_identities: [{ id: GATE_ID }] } });
  const r = await service.listCandidates(
    session,
    { companyId: COMPANY, query: { state: 'submitted', cursor: CANDIDATE } },
    db.options,
  );
  assert.equal(r.candidates.length, 50);
  assert.equal(r.nextCursor, ids[49]);
  assert.equal(r.candidates[0].gateStatus, 'current');
  assert.ok(!Object.hasOwn(r.candidates[0], 'content'));
  assert.deepEqual(db.calls.find((c) => c.read === 'candidate_versions').params, {
    select:
      'id,agent_id,sequence,state,version,author_membership_id,supersedes_candidate_id,content_sha256,derived_sha256,gate_id,validated_at,submitted_at',
    company_id: `eq.${COMPANY}`,
    order: 'id.asc',
    limit: '51',
    state: 'eq.submitted',
    id: `gt.${CANDIDATE}`,
  });
  const last = fakeDb({ tables: { candidate_versions: ids.slice(0, 50).map(listRow) } });
  assert.equal((await service.listCandidates(session, { companyId: COMPANY }, last.options)).nextCursor, null);
});

test('gate read: the active identity with its files, the server constant and agrees; no visible active row is E_NOT_FOUND', async () => {
  const files = [{ path: 'lib/passport/gate.mjs', sha256: `${X}${'3'.repeat(64)}` }];
  const db = fakeDb({ tables: { gate_identity_files: files } });
  const r = await service.readGate(session, db.options);
  assert.deepEqual(r, {
    ok: true,
    active: {
      gateIdentitySha256: manifest.GATE_IDENTITY_SHA256,
      adapterLockSha256: manifest.ADAPTER_LOCK_SHA256,
      validatorVersion: manifest.VALIDATOR_VERSION,
      manifestSha256: manifest.MANIFEST_SHA256,
      upstreamCommit: manifest.UPSTREAM_COMMIT,
      registeredAt: '2026-09-13T07:00:00.123Z',
      files: [{ path: 'lib/passport/gate.mjs', sha256: '3'.repeat(64) }],
    },
    server: { gateIdentitySha256: manifest.GATE_IDENTITY_SHA256 },
    agrees: true,
  });
  assert.deepEqual(db.calls[1].params, { select: 'path,sha256', gate_id: `eq.${GATE_ID}`, order: 'path.asc' });
  const other = fakeDb({ tables: { gate_identities: [oldGateRow()] } });
  assert.equal((await service.readGate(session, other.options)).agrees, false);
  const stale = fakeDb({ tables: { gate_identities: [] } });
  await assert.rejects(service.readGate(session, stale.options), refusal('E_NOT_FOUND'));
});

test('every refusal code the gate modules can emit is in CODES with its status, so a refusal never becomes 500', () => {
  const sources = [
    'vendor/passport/web/lib/_validate.mjs',
    'vendor/passport/web/lib/_derive.mjs',
    'vendor/passport/web/lib/_sections.mjs',
    'lib/passport/rules.mjs',
    'lib/passport/gate.mjs',
  ];
  const codes = new Set();
  for (const s of sources) for (const m of readFileSync(join(REPO, s), 'utf8').matchAll(/'(E_[A-Z0-9_]+)'/g)) codes.add(m[1]);
  assert.ok(codes.size >= 36, `found ${codes.size} codes`);
  for (const code of codes) {
    const status = code === 'E_CONTENT_TYPE' ? 415 : code === 'E_TOO_LARGE' ? 413 : 422;
    assert.equal(CODES[code], status, code);
    assert.notEqual(messageFor(code), messageFor('E_INTERNAL'), code);
  }
});

/* ---------- E3b critique F3 and F2: reads that must be complete ---------- */

/* PostgREST as configured: the keyset filter honoured, and every answer cut to max_rows without a word
   (supabase/config.toml), which is the truncation F3 is. */
const MAX_ROWS = Number(/^max_rows\s*=\s*(\d+)\s*$/m.exec(readFileSync(join(REPO, 'supabase/config.toml'), 'utf8'))[1]);
const uuidOf = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const keyset = (rows) => (params) => {
  const sorted = [...rows].sort(byId);
  const after = params.id?.startsWith('gt.') ? params.id.slice(3) : null;
  const limit = Math.min(params.limit === undefined ? Number.POSITIVE_INFINITY : Number(params.limit), MAX_ROWS);
  return (after === null ? sorted : sorted.filter((r) => r.id > after)).slice(0, limit);
};
/* n contributor rows whose ids run against the service's own order, so the answer's order is the service's sort. */
const contributorRows = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: uuidOf(n - i),
    kind: i === 0 ? 'author' : i === 1 ? 'submitter' : 'declared_offline',
    membership_id: i < 2 ? MEMBERSHIP : null,
    display_name: i < 2 ? null : `offline-${String(i).padStart(5, '0')}`,
    inherited_from_candidate_id: null,
  }));
const submitted = () => stored({ state: 'submitted', version: 5, submitted_at: STORED_AT });
const CONTRIBUTOR_SELECT = 'id,kind,membership_id,display_name,inherited_from_candidate_id';

test('F3 (U2b): the contributor read pages by id at a limit no larger than max_rows until a short page, and answers the three pages whole', async () => {
  assert.equal(MAX_ROWS, 200, 'supabase/config.toml max_rows');
  const all = contributorRows(417);
  const sorted = [...all].sort(byId);
  const db = fakeDb({
    tables: { candidate_versions: candidateRow(), candidate_contributors: keyset(all) },
    rpc: submitted,
  });
  const r = await service.submitCandidate(session, submitArgs(), db.options);
  const pages = db.calls.filter((c) => c.read === 'candidate_contributors');
  const first = { select: CONTRIBUTOR_SELECT, candidate_id: `eq.${CANDIDATE}`, order: 'id.asc', limit: '200' };
  assert.deepEqual(
    pages.map((c) => c.params),
    [first, { ...first, id: `gt.${sorted[199].id}` }, { ...first, id: `gt.${sorted[399].id}` }],
  );
  for (const c of pages) assert.ok(Number(c.params.limit) <= MAX_ROWS, 'a page asked for above max_rows is cut to it');
  assert.deepEqual(kinds(db), [
    'candidate_versions',
    'submit_candidate',
    'candidate_contributors',
    'candidate_contributors',
    'candidate_contributors',
    'candidate_versions',
  ]);
  assert.deepEqual(db.calls.at(-1).params, { select: 'id', id: `eq.${CANDIDATE}` }, 'still visible after the last page');
  assert.equal(r.contributors.length, 417);
  const name = (c) => c.displayName ?? c.display_name ?? `${c.kind}:${c.membershipId ?? c.membership_id}`;
  assert.deepEqual(r.contributors.map(name).sort(), all.map(name).sort(), 'the concatenation of the three pages');
  assert.deepEqual(r.contributors.slice(0, 2), [
    { kind: 'author', membershipId: MEMBERSHIP },
    { kind: 'submitter', membershipId: MEMBERSHIP },
  ]);
  /* The registry scan a replay makes asks for the same page. */
  const replay = fakeDb({
    tables: { candidate_versions: [{ id: CANDIDATE }] },
    rpc: () => stored({ idempotent_replay: true }),
  });
  await service.saveCandidate(session, saveArgs(), replay.options);
  for (const c of replay.calls.filter((x) => x.read === 'gate_identities'))
    assert.ok(Number(c.params.limit) <= MAX_ROWS, 'the registry page too');
});

test('F3: the contributor ceiling derives from the migrations; at it every row is answered, one row past it fails closed with E_READ_OVER_BOUND', async () => {
  const dir = join(REPO, 'supabase/migrations');
  const text = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
  const last = (re) => [...text.matchAll(re)].at(-1)?.[1];
  const versions = Number(last(/function app\.limit_versions_per_agent\(\)[\s\S]*?select (\d+) \$\$/g));
  const declared = Number(last(/jsonb_array_length\(s->'declared_contributors'\) > (\d+)/g));
  const observed = last(/constraint contributor_observed check \(\(kind in \(([^)]*)\)\) = observed\)/g).split(',').length;
  const ceiling = versions * (declared + observed);
  assert.deepEqual([versions, declared, observed, ceiling], [200, 50, 3, 10600]);

  const at = fakeDb({
    tables: { candidate_versions: candidateRow(), candidate_contributors: keyset(contributorRows(ceiling)) },
    rpc: submitted,
  });
  assert.equal((await service.submitCandidate(session, submitArgs(), at.options)).contributors.length, ceiling);
  assert.equal(at.calls.filter((c) => c.read === 'candidate_contributors').length, ceiling / 200 + 1);

  const past = fakeDb({
    tables: { candidate_versions: candidateRow(), candidate_contributors: keyset(contributorRows(ceiling + 1)) },
    rpc: submitted,
  });
  await assert.rejects(service.submitCandidate(session, submitArgs(), past.options), refusal('E_READ_OVER_BOUND'));
  assert.equal(past.calls.filter((c) => c.read === 'candidate_contributors').length, ceiling / 200 + 1);
  assert.equal(CODES.E_READ_OVER_BOUND, 500);
  assert.notEqual(messageFor('E_READ_OVER_BOUND'), messageFor('E_INTERNAL'));
});

test('F3: a page longer than asked or ids that do not ascend are a defect, never an answer; an empty page is the end only while the candidate is still visible', async () => {
  const sorted = contributorRows(450).sort(byId);
  const runWith = (contributors, visibleAtEnd = true) => {
    const db = fakeDb({
      tables: {
        candidate_versions: (params) => (params.select === 'id' ? (visibleAtEnd ? [{ id: CANDIDATE }] : []) : candidateRow()),
        candidate_contributors: contributors,
      },
      rpc: submitted,
    });
    return { db, run: service.submitCandidate(session, submitArgs(), db.options) };
  };
  await assert.rejects(runWith(() => sorted.slice(0, 201)).run, refusal('E_INTERNAL'), 'a page of 201 rows');
  const stuck = runWith(() => sorted.slice(0, 200));
  await assert.rejects(stuck.run, refusal('E_INTERNAL'), 'the cursor ignored: the same page again');
  assert.equal(stuck.db.calls.filter((c) => c.read === 'candidate_contributors').length, 2);
  const lost = runWith((params) => (params.id ? [] : sorted.slice(0, 200)), false);
  await assert.rejects(lost.run, refusal('E_NOT_FOUND'), 'standing lost after the first page');
  const whole = runWith((params) => (params.id ? [] : sorted.slice(0, 200)));
  assert.equal((await whole.run).contributors.length, 200, 'control: still visible, 200 rows are the whole list');
});

test('F2: a replay finds its stored identity in the whole registry, in keyset pages, whatever its age; components are never null', async () => {
  const later = Array.from({ length: 250 }, (_, i) =>
    gateRow({ id: uuidOf(i + 1), identity_sha256: `${X}${sha(`later-${i}`)}`, active: false }),
  );
  const replayOf = (identity) => () => stored({ idempotent_replay: true, gate_identity_sha256: identity });
  const THIS_BUILD = {
    validatorVersion: manifest.VALIDATOR_VERSION,
    adapterLockSha256: manifest.ADAPTER_LOCK_SHA256,
    manifestSha256: manifest.MANIFEST_SHA256,
  };
  const run = async (registry, identity) => {
    const db = fakeDb({
      tables: { candidate_versions: [{ id: CANDIDATE }], gate_identities: keyset(registry) },
      rpc: replayOf(identity),
    });
    const r = await service.saveCandidate(session, saveArgs(), db.options);
    return { db, attestation: r.attestation };
  };

  /* The critic's registry-limit case: this build's identity still active, 250 inactive registrations after it in id
     order, so it is on the second page. */
  const a = await run([...later, gateRow()], manifest.GATE_IDENTITY_SHA256);
  assert.deepEqual(a.attestation, {
    gateIdentitySha256: manifest.GATE_IDENTITY_SHA256,
    ...THIS_BUILD,
    validatedAt: STORED_AT,
    gateStatus: 'current',
  });
  const first = {
    select: 'id,identity_sha256,adapter_lock_sha256,validator_version,manifest_sha256,upstream_commit,registered_at,active',
    order: 'id.asc',
    limit: '200',
  };
  assert.deepEqual(
    a.db.calls.filter((c) => c.read === 'gate_identities').map((c) => c.params),
    [first, { ...first, id: `gt.${uuidOf(200)}` }],
    'the exact filters: two pages, no candidate read, no window',
  );
  assert.deepEqual(kinds(a.db), ['candidate_versions', 'save_draft', 'gate_identities', 'gate_identities']);

  /* Rotated away: the stored identity's own components, stale. */
  const rotatedTo = gateRow({ id: uuidOf(900), identity_sha256: `${X}${'c'.repeat(64)}` });
  const b = await run([...later, gateRow({ active: false }), rotatedTo], manifest.GATE_IDENTITY_SHA256);
  assert.deepEqual(b.attestation, {
    gateIdentitySha256: manifest.GATE_IDENTITY_SHA256,
    ...THIS_BUILD,
    validatedAt: STORED_AT,
    gateStatus: 'stale',
  });

  /* An older identity reactivated: its components, current. */
  const c = await run([...later, gateRow({ active: false }), { ...oldGateRow(), active: true }], OTHER_IDENTITY);
  assert.deepEqual(c.attestation, {
    gateIdentitySha256: OTHER_IDENTITY,
    validatorVersion: '0.0.9',
    adapterLockSha256: 'a'.repeat(64),
    manifestSha256: 'b'.repeat(64),
    validatedAt: STORED_AT,
    gateStatus: 'current',
  });

  /* Past the fixed registry ceiling of 10,000 the scan fails closed. */
  const crowded = Array.from({ length: 10001 }, (_, i) =>
    gateRow({ id: uuidOf(i + 1), identity_sha256: `${X}${sha(`crowd-${i}`)}`, active: i === 10000 }),
  );
  const db = fakeDb({
    tables: { candidate_versions: [{ id: CANDIDATE }], gate_identities: keyset(crowded) },
    rpc: replayOf(sha('crowd-0')),
  });
  await assert.rejects(service.saveCandidate(session, saveArgs(), db.options), refusal('E_READ_OVER_BOUND'));
});

/* E3B-RC-R1 (evidence/e3b-recheck.md, R1): the whole answer in its stated order across page boundaries. Own rows before
   inherited ones, then kind in the vocabulary's order, then membership id or name by UTF-16 code units, with several
   memberships and several names in every group. Row ids are a fixed permutation of the stated order, so every page
   cuts through the groups and id order disagrees with the stated order inside each group. A sort without its third
   comparator keeps id order inside a group, because Array.prototype.sort is stable, and fails here; the recheck's
   mutant passed U2b with all 417 rows kept. The expected list is written out group by group, not computed with the
   service's comparator. */
test('E3B-RC-R1: across page boundaries the contributor list comes back in its full stated order, memberships and names ordered inside every group', async () => {
  const PARENT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const ms = (n) => `3b6e2c4d-5f70-4b9c-8d1e-${String(n).padStart(12, '0')}`;
  const range = (from, count) => Array.from({ length: count }, (_, i) => from + i);
  const tagged = (prefix, count) => range(0, count).map((i) => `${prefix}-${String(i).padStart(3, '0')}`);
  const inheritance = (inherited) => (inherited ? { inheritedFromCandidateId: PARENT } : {});
  const member = (kind, n, inherited) => ({ kind, membershipId: ms(n), ...inheritance(inherited) });
  const offline = (displayName, inherited) => ({ kind: 'declared_offline', displayName, ...inheritance(inherited) });
  /* Names in UTF-16 code unit order: a capital before lower case, Latin-1 after ASCII, Greek after Latin-1. A
     locale-aware comparison would put adam before Zed and bob before Bob. */
  const expected = [
    member('author', 1),
    ...range(10, 5).map((n) => member('editor', n)),
    member('submitter', 2),
    ...range(100, 80).map((n) => member('declared_member', n)),
    ...['Zed', 'adam', ...tagged('own', 120), 'Émile', 'Ωmega'].map((name) => offline(name)),
    member('author', 3, true),
    ...range(20, 4).map((n) => member('editor', n, true)),
    member('submitter', 4, true),
    ...range(200, 70).map((n) => member('declared_member', n, true)),
    ...['Bob', 'bob', ...tagged('inherited', 120)].map((name) => offline(name, true)),
  ];
  /* Row i of the stated order gets id number (i * 7919) mod 409 + 1; 409 is prime, so that is a permutation. */
  assert.equal(expected.length, 409);
  const rows = expected.map((c, i) => ({
    id: uuidOf(((i * 7919) % expected.length) + 1),
    kind: c.kind,
    membership_id: c.membershipId ?? null,
    display_name: c.displayName ?? null,
    inherited_from_candidate_id: c.inheritedFromCandidateId ?? null,
  }));
  const groupOf = (r) => `${r.inherited_from_candidate_id ? 'inherited' : 'own'} ${r.kind}`;
  const inIdOrder = [...rows].sort(byId);
  for (const group of new Set(rows.map(groupOf))) {
    const members = inIdOrder.filter((r) => groupOf(r) === group);
    const stated = rows.filter((r) => groupOf(r) === group);
    if (members.length > 1)
      assert.notDeepEqual(members, stated, `fixture: id order is not already the stated order in ${group}`);
  }
  for (let page = 0; page < inIdOrder.length; page += MAX_ROWS)
    assert.ok(new Set(inIdOrder.slice(page, page + MAX_ROWS).map(groupOf)).size > 1, 'fixture: every page cuts through groups');

  const db = fakeDb({
    tables: { candidate_versions: candidateRow(), candidate_contributors: keyset(rows) },
    rpc: submitted,
  });
  const r = await service.submitCandidate(session, submitArgs(), db.options);
  assert.equal(db.calls.filter((c) => c.read === 'candidate_contributors').length, 3, 'pages of 200, 200 and 9 rows');
  assert.deepEqual(r.contributors, expected);
});
