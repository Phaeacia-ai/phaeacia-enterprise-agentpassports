/* lib/db/server.mjs, the bound bearer (E3 design section 2.6 item 2, with 4.3's operation lists and the
   Node half of test-plan cases 11 and 14). No stack and no E3 routine: the four functions do not exist in
   the database yet, so callBound runs against an injected fetch only, and what the database does with a
   bound token is tests/db/01-privilege-boundary.sh section 1g. Expected digests are either computed with
   shasum, outside this module, or are the ten the E3 critique's SQL run confirmed
   (evidence/e3-design-critique-repro/vectors.sql and vectors-output.txt). */
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';

import { hs256, userClaims } from '../helpers/jwt.mjs';

const SECRET = 'example-unit-secret-with-at-least-32-characters-long';
const BASE = 'http://127.0.0.1:54321';
process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = SECRET;

const { COOKIES, verifySession } = await import('../../../lib/session.mjs');
const { BOUND, FUNCTIONS, bindCall, bindingSql, callBound, operationSql, rpc, serverToken } = await import(
  '../../../lib/db/server.mjs'
);

const SUB = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11';
const COMPANY = '0b5c3f0e-8d4a-4c1e-9f2a-6d7e8f9a0b1c';
const AGENT = '3c9e1a2b-4d5f-4a6b-8c7d-9e0f1a2b3c4d';
/* The critique's identifier, key and gate identity, so its recorded digests apply unchanged. */
const ID = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const GATE = 'a'.repeat(64);
/* SHA-256 of short inputs, computed with shasum. */
const SHA = Object.freeze({
  content: 'ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73',
  emptyObject: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  weeklyBrief: '10393fb0af11ff3aca27b0e42e48a1535800239854e70fccc8ea397c69c0bbac',
  body: '230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5',
  empty: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
});
/* The unbound names: E2's nine and E4's three group routines (migration 006 part A), which follow E2's template. */
/* lib/db/server.mjs FUNCTIONS: every api routine called through the unbound bearer. E2's nine, E4's three group
   routines, E5's api.authorize_download, which is unbound by decision (E5 design 1.2), E6's thirteen and K4's
   api.record_invitation_delivery (E6 design 1.2.1, migration 010). app.server_actor() refuses
   every token carrying `fn`, so binding one of these could only fail, and serverToken refuses it before signing. */
const UNBOUND_NAMES = Object.freeze([
  'accept_invitation',
  'add_group_member',
  'add_operator',
  'authorize_download',
  'claim_invitation_handover',
  'close_company',
  'create_company',
  'create_group',
  'delete_company',
  'departure_preview',
  'export_company',
  'invite_member',
  'mfa_verify_begin',
  'mfa_verify_end',
  'operator_expiry_run',
  'operator_export_manifest',
  'operator_invite_admin',
  'operator_register',
  'provision_company',
  'record_invitation_delivery',
  'remove_group_member',
  'remove_member',
  'revoke_invitation',
  'set_access_period',
  'set_company_quota',
  'set_company_status',
  'set_display_name',
  'set_roles',
  'transfer_agent',
  'transfer_first_admin',
]);
/* app.bound_actor's jti pattern (E3 design 2.3). */
const JTI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const decode = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url'));
const linesOf = (call) => call.binding.split('\n');

async function session(aal = 'aal2') {
  const token = hs256(userClaims({ sub: SUB, email: 's@example.invalid', issuer: `${BASE}/auth/v1`, aal }), SECRET);
  const v = await verifySession({ headers: { cookie: `${COOKIES.access}=${token}` } });
  assert.equal(v.ok, true);
  return v.session;
}
const fakeFetch = (status, body) => {
  const log = [];
  const f = async (url, init) => {
    log.push({ url: String(url), method: init?.method, headers: init?.headers ?? {}, body: init?.body });
    return { status, json: async () => body };
  };
  f.log = log;
  return f;
};

/* The design 4.4 signatures, written out here independently of the module's table, with Postgres's
   observed reading of each JSON value (evidence/e3-prereq-2-6.md, the json_to_record probe): uuid::text
   is lowercase; a bytea string is hex only after \x and is otherwise its own bytes. recompute() is what
   the SQL side will do with the parameters that actually left this process. */
const pg = Object.freeze({
  uuid: (v) => (v === null ? '-' : v.toLowerCase()),
  integer: (v) => (v === null ? '-' : String(v)),
  text: (v) => (v === null ? '-' : sha(v)),
  bytea: (v) =>
    v === null ? '-' : v.startsWith('\\x') ? v.slice(2).toLowerCase() : Buffer.from(v, 'utf8').toString('hex'),
});
const SIGNATURES = Object.freeze({
  create_draft: [
    ['p_company', pg.uuid],
    ['p_agent', pg.uuid],
    ['p_agent_name', pg.text],
    ['p_content', pg.text],
    ['p_derived_canonical', pg.text],
    ['p_gate_identity', pg.bytea],
    ['p_idempotency_key', pg.uuid],
  ],
  save_draft: [
    ['p_candidate', pg.uuid],
    ['p_expected_version', pg.integer],
    ['p_content', pg.text],
    ['p_derived_canonical', pg.text],
    ['p_gate_identity', pg.bytea],
    ['p_idempotency_key', pg.uuid],
  ],
  submit_candidate: [
    ['p_candidate', pg.uuid],
    ['p_expected_version', pg.integer],
    ['p_content_sha256', pg.bytea],
    ['p_derived_canonical', pg.text],
    ['p_submission_canonical', pg.text],
    ['p_gate_identity', pg.bytea],
    ['p_idempotency_key', pg.uuid],
  ],
  create_successor: [
    ['p_candidate', pg.uuid],
    ['p_content_sha256', pg.bytea],
    ['p_derived_canonical', pg.text],
    ['p_gate_identity', pg.bytea],
    ['p_idempotency_key', pg.uuid],
  ],
  /* E4 design 2.3 B8, the four signatures migration 006 part B defines. */
  create_envelope: [
    ['p_candidate', pg.uuid],
    ['p_target', pg.text],
    ['p_audience_canonical', pg.text],
    ['p_policy', pg.uuid],
    ['p_gate_identity', pg.bytea],
    ['p_idempotency_key', pg.uuid],
  ],
  record_review: [
    ['p_candidate', pg.uuid],
    ['p_envelope', pg.uuid],
    ['p_role', pg.text],
    ['p_decision', pg.text],
    ['p_reason', pg.text],
    ['p_gate_identity', pg.bytea],
    ['p_idempotency_key', pg.uuid],
  ],
  publish_release: [
    ['p_candidate', pg.uuid],
    ['p_envelope', pg.uuid],
    ['p_expected_assembled_sha256', pg.bytea],
    ['p_gate_identity', pg.bytea],
    ['p_idempotency_key', pg.uuid],
  ],
  withdraw_release: [
    ['p_release', pg.uuid],
    ['p_reason', pg.text],
    ['p_idempotency_key', pg.uuid],
  ],
  /* E5 design 2.3 B10, the two signatures migration 007 defines. Both optional texts of a report are bound, so an
     absent losses and the text "-" are told apart by the hash rather than by concat_ws skipping a NULL. */
  report_installation: [
    ['p_release', pg.uuid],
    ['p_status', pg.text],
    ['p_losses', pg.text],
    ['p_assistance', pg.text],
    ['p_idempotency_key', pg.uuid],
  ],
  witness_installation: [
    ['p_report', pg.uuid],
    ['p_status', pg.text],
    ['p_note', pg.text],
    ['p_idempotency_key', pg.uuid],
  ],
});
const recompute = (fn, sent) => [fn, ...SIGNATURES[fn].map(([param, read]) => read(sent[param]))].join('\n');

/* Every field present, so each can be removed in turn. create_draft carries both agent fields; the
   database refuses both at once (22023), which is its rule, not this encoder's. */
const FULL = Object.freeze({
  create_draft: {
    company_id: COMPANY,
    agent_id: AGENT,
    agent_name: 'weekly-brief',
    content: 'content',
    derived_canonical: '{}',
    gate_identity: GATE,
    idempotency_key: KEY,
  },
  save_draft: {
    candidate_id: ID,
    expected_version: 3,
    content: 'content',
    derived_canonical: '{}',
    gate_identity: GATE,
    idempotency_key: KEY,
  },
  submit_candidate: {
    candidate_id: ID,
    expected_version: 4,
    content_sha256: SHA.body,
    derived_canonical: '{}',
    submission_canonical: '{"confidence":"high"}',
    gate_identity: GATE,
    idempotency_key: KEY,
  },
  create_successor: {
    candidate_id: ID,
    content_sha256: SHA.content,
    derived_canonical: '{}',
    gate_identity: GATE,
    idempotency_key: KEY,
  },
  create_envelope: {
    candidate_id: ID,
    target: 'claude-code',
    audience_canonical: `{"group_ids":["${COMPANY}"]}`,
    policy_id: AGENT,
    gate_identity: GATE,
    idempotency_key: KEY,
  },
  record_review: {
    candidate_id: ID,
    envelope_id: AGENT,
    role: 'it',
    decision: 'approved',
    reason: 'Synthetic review reason.',
    gate_identity: GATE,
    idempotency_key: KEY,
  },
  publish_release: {
    candidate_id: ID,
    envelope_id: AGENT,
    expected_assembled_sha256: SHA.content,
    gate_identity: GATE,
    idempotency_key: KEY,
  },
  withdraw_release: {
    release_id: ID,
    reason: 'Synthetic withdrawal reason.',
    idempotency_key: KEY,
  },
  report_installation: {
    release_id: ID,
    status: 'partial',
    losses: 'Synthetic losses statement.',
    assistance: 'Synthetic assistance statement.',
    idempotency_key: KEY,
  },
  witness_installation: {
    report_id: ID,
    status: 'partial',
    note: 'Synthetic witness note.',
    idempotency_key: KEY,
  },
});

test('2.6 item 2, E4 2.6 item 1 and E5 2.6 item 1: the table holds the E3, E4 and E5 field and operation lists, frozen, disjoint from E2', () => {
  assert.deepEqual(Object.keys(BOUND).sort(), [
    'create_draft',
    'create_envelope',
    'create_successor',
    'publish_release',
    'record_review',
    'report_installation',
    'save_draft',
    'submit_candidate',
    'withdraw_release',
    'witness_installation',
  ]);
  assert.deepEqual(BOUND.report_installation.binding, [
    'release_id',
    'status',
    'losses',
    'assistance',
    'idempotency_key',
  ]);
  assert.deepEqual(BOUND.witness_installation.binding, ['report_id', 'status', 'note', 'idempotency_key']);
  /* Only the key is absent from either operation list: neither routine touches content, the gate or the installer, so
     there is no gate identity to leave out (E5 design 2.6 item 1). */
  assert.deepEqual(BOUND.report_installation.operation, ['release_id', 'status', 'losses', 'assistance']);
  assert.deepEqual(BOUND.witness_installation.operation, ['report_id', 'status', 'note']);
  assert.deepEqual(BOUND.create_envelope.binding, [
    'candidate_id',
    'target',
    'audience_canonical',
    'policy_id',
    'gate_identity',
    'idempotency_key',
  ]);
  assert.deepEqual(BOUND.record_review.binding, [
    'candidate_id',
    'envelope_id',
    'role',
    'decision',
    'reason',
    'gate_identity',
    'idempotency_key',
  ]);
  assert.deepEqual(BOUND.publish_release.binding, [
    'candidate_id',
    'envelope_id',
    'expected_assembled_sha256',
    'gate_identity',
    'idempotency_key',
  ]);
  assert.deepEqual(BOUND.withdraw_release.binding, ['release_id', 'reason', 'idempotency_key']);
  assert.deepEqual(BOUND.create_envelope.operation, ['candidate_id', 'target', 'audience_canonical', 'policy_id']);
  assert.deepEqual(BOUND.record_review.operation, ['candidate_id', 'envelope_id', 'role', 'decision', 'reason']);
  assert.deepEqual(BOUND.publish_release.operation, ['candidate_id', 'envelope_id']);
  assert.deepEqual(BOUND.withdraw_release.operation, ['release_id', 'reason']);
  assert.deepEqual(BOUND.create_draft.binding, [
    'company_id',
    'agent_id',
    'agent_name',
    'content',
    'derived_canonical',
    'gate_identity',
    'idempotency_key',
  ]);
  assert.deepEqual(BOUND.save_draft.binding, [
    'candidate_id',
    'expected_version',
    'content',
    'derived_canonical',
    'gate_identity',
    'idempotency_key',
  ]);
  assert.deepEqual(BOUND.submit_candidate.binding, [
    'candidate_id',
    'expected_version',
    'content_sha256',
    'derived_canonical',
    'submission_canonical',
    'gate_identity',
    'idempotency_key',
  ]);
  assert.deepEqual(BOUND.create_successor.binding, [
    'candidate_id',
    'content_sha256',
    'derived_canonical',
    'gate_identity',
    'idempotency_key',
  ]);
  assert.deepEqual(BOUND.create_draft.operation, ['company_id', 'agent_id', 'agent_name', 'content']);
  assert.deepEqual(BOUND.save_draft.operation, ['candidate_id', 'expected_version', 'content']);
  assert.deepEqual(BOUND.submit_candidate.operation, ['candidate_id', 'expected_version', 'submission_canonical']);
  assert.deepEqual(BOUND.create_successor.operation, ['candidate_id']);
  assert.ok(Object.isFrozen(BOUND));
  for (const [fn, spec] of Object.entries(BOUND)) {
    assert.equal([...FUNCTIONS].includes(fn), false, `${fn} is not an E2 function`);
    assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.binding) && Object.isFrozen(spec.operation), fn);
    let at = 0;
    for (const field of spec.operation) {
      at = spec.binding.indexOf(field, at) + 1;
      assert.ok(at > 0, `${fn}: operation field ${field} is a binding field, in order`);
    }
    for (const moving of ['derived_canonical', 'gate_identity', 'idempotency_key', 'expected_assembled_sha256']) {
      assert.equal(spec.operation.includes(moving), false, `${fn}: ${moving} moves between honest attempts`);
    }
  }
});

test('the request body is the design 4.4 signature in order, bytea values carry \\x, absent values are explicit null', () => {
  for (const [fn, args] of Object.entries(FULL)) {
    const call = bindCall(fn, args);
    assert.deepEqual(
      Object.keys(call.body),
      SIGNATURES[fn].map(([param]) => param),
      fn,
    );
    assert.ok(Object.isFrozen(call) && Object.isFrozen(call.body), fn);
    /* withdraw_release binds no gate identity (E4 design 2.3, after B8), and neither E5 routine does (E5 design 2.3,
       after B10): none of the three touches content, the gate or the installer. */
    if (!['withdraw_release', 'report_installation', 'witness_installation'].includes(fn))
      assert.equal(call.body.p_gate_identity, `\\x${GATE}`, fn);
  }
  const byName = bindCall('create_draft', { ...FULL.create_draft, agent_id: undefined });
  assert.equal(byName.body.p_agent, null);
  assert.match(JSON.stringify(byName.body), /"p_agent":null/);
  assert.equal(bindCall('create_successor', FULL.create_successor).body.p_content_sha256, `\\x${SHA.content}`);
});

test('binding and operation strings, line by line, against digests computed with shasum', () => {
  const byName = bindCall('create_draft', { ...FULL.create_draft, agent_id: undefined });
  assert.equal(
    byName.binding,
    ['create_draft', COMPANY, '-', SHA.weeklyBrief, SHA.content, SHA.emptyObject, GATE, KEY].join('\n'),
  );
  assert.equal(byName.argsSha256, 'a93ee57075e8ac17ae2f2419426a488703274b3bd20a06d18f8eb5fcf1d23119');
  assert.equal(byName.operation, ['create_draft', COMPANY, '-', SHA.weeklyBrief, SHA.content].join('\n'));
  assert.equal(byName.operationSha256, '992db0b522992a87dff2e1707eb2450073859e02079776a774f7fe22266c19a3');

  const byId = bindCall('create_draft', { ...FULL.create_draft, agent_name: null });
  assert.equal(byId.binding, ['create_draft', COMPANY, AGENT, '-', SHA.content, SHA.emptyObject, GATE, KEY].join('\n'));
  assert.equal(byId.argsSha256, '6914d2f2b21126afdd08824dbdfc18a07b54c73600a14ad6dcbab68ae7be4353');

  const successor = bindCall('create_successor', FULL.create_successor);
  assert.equal(successor.binding, ['create_successor', ID, SHA.content, SHA.emptyObject, GATE, KEY].join('\n'));
  assert.equal(successor.argsSha256, '373fecafe1bf3b4fd198eda810fd89968e08522fbc49a08c055610e4156f863d');
  assert.equal(successor.operation, `create_successor\n${ID}`);
  assert.equal(successor.operationSha256, 'd56f138d12a8609babeff20eb64888b652e4ce67a6ed0d40fd39399fb0a3e339');

  const save = bindCall('save_draft', { ...FULL.save_draft, content: 'c\u2028' });
  assert.equal(save.operationSha256, '3633b1b6aa0d0451a5e11c6876e0b879ae494d5d22e77805009df67c988eae52');
  const submit = bindCall('submit_candidate', FULL.submit_candidate);
  assert.equal(submit.operation, ['submit_candidate', ID, '4', sha('{"confidence":"high"}')].join('\n'));
  assert.equal(submit.operationSha256, 'ed529a467d449d5eff26e272663086226b09521ea689a439cb96b9633bfa2520');
});

test('case 14 seed: the ten binding digests the critique confirmed in SQL, through the current builder', () => {
  /* Five used the save_draft and submit_candidate lists, which have not changed since the critique:
     the current builder must produce those digests exactly. */
  const same = [
    [
      'separator',
      'save_draft',
      { ...FULL.save_draft, content: 'c\u2028', derived_canonical: '{"x":"\u2028"}' },
      'be8458b4ecea437a3a5789bfa31bb7243dfe5b8f4f390f0a92f85ccdb9166c24',
    ],
    [
      'large',
      'save_draft',
      { ...FULL.save_draft, content: 'x'.repeat(262144) },
      '569ff2243ebb1d94443715b3882be290fa24722d558a4ec795d16c23e8d76155',
    ],
    [
      'submit',
      'submit_candidate',
      FULL.submit_candidate,
      '6a857c2e3101c75e576da2b6f20c91ceea8a861bc91bbdeef727ff734c53bd51',
    ],
    [
      'version_max',
      'save_draft',
      { ...FULL.save_draft, expected_version: 2147483647, content: 'x' },
      'b46a5b9439268623dd63541ceba8bbb32c91f13ef43d37b2b84c67e0b4edb874',
    ],
    [
      'unicode',
      'save_draft',
      { ...FULL.save_draft, expected_version: 1, content: '\u00e9', derived_canonical: '{"slash":"/"}' },
      '965a4a913e48071c6df79e0734e2817cc0884f38c20d3b4d2348f310760007de',
    ],
  ];
  for (const [name, fn, args, digest] of same) assert.equal(bindCall(fn, args).argsSha256, digest, name);

  /* The other five used the create_draft and create_successor lists as they stood before H2 and H3.
     Deleting exactly the lines those corrections added must give the critique's digest: every other
     line then matches what SQL agreed to, and the added lines are the only difference. */
  const draft = {
    content: 'content',
    derived_canonical: '{}',
    gate_identity: GATE,
    idempotency_key: KEY,
    company_id: COMPANY,
  };
  const withoutCompany = (call) => sha(linesOf(call).toSpliced(1, 1).join('\n'));
  const superseded = [
    [
      'create_null',
      bindCall('create_draft', draft),
      '622d43eac5bae65f6833d07a386120307eea174a6fe68ffa0b9ed8c04003ddb3',
    ],
    [
      'create_name',
      bindCall('create_draft', { ...draft, agent_name: 'weekly-brief' }),
      'd9cc65f03a929f7df0c2c5db41ae9b3b5a7541e6ce13b420cd6df210046a7eaf',
    ],
    [
      'astral',
      bindCall('create_draft', { ...draft, agent_id: ID, agent_name: String.fromCodePoint(0x1f600) }),
      'f41f9abb02e3a86b08ae7451e488030ff7185c2bf62b2f1d102a69993511d9a0',
    ],
    [
      'empty_name',
      bindCall('create_draft', { ...draft, agent_id: ID, agent_name: '', content: 'x' }),
      'c0958004089226cd2e521c1c48554d51d84e7073070c74c89e869e63ff0acf62',
    ],
  ];
  for (const [name, call, digest] of superseded) {
    assert.equal(linesOf(call).length, 8, name);
    assert.equal(withoutCompany(call), digest, name);
    assert.notEqual(call.argsSha256, digest, `${name}: H2's company line is in the binding`);
  }
  const successor = bindCall('create_successor', FULL.create_successor);
  const preH3 = sha(linesOf(successor).toSpliced(2, 3).join('\n'));
  assert.equal(preH3, 'b9d22d529d055d9aca1690b9403e78535498a00abb56bebb89b299b8840ed935');
  assert.notEqual(successor.argsSha256, preH3, "H3's content, derived and gate lines are in the binding");
});

test('an absent field is "-" in the binding and null in the body, for every field; a line is never skipped', () => {
  for (const [fn, args] of Object.entries(FULL)) {
    const whole = bindCall(fn, args);
    const count = BOUND[fn].binding.length + 1;
    assert.equal(linesOf(whole).length, count, fn);
    BOUND[fn].binding.forEach((field, i) => {
      for (const how of ['missing', null, undefined]) {
        const a = { ...args };
        if (how === 'missing') delete a[field];
        else a[field] = how;
        const call = bindCall(fn, a);
        const label = `${fn} with ${field} ${String(how)}`;
        assert.equal(linesOf(call).length, count, label);
        assert.equal(linesOf(call)[i + 1], '-', label);
        assert.deepEqual(linesOf(call).toSpliced(i + 1, 1), linesOf(whole).toSpliced(i + 1, 1), label);
        assert.equal(call.body[SIGNATURES[fn][i][0]], null, label);
        assert.equal(call.argsSha256, sha(recompute(fn, JSON.parse(JSON.stringify(call.body)))), label);
      }
    });
  }
});

test('the concat_ws trap: skipping an absent value instead of writing "-" is a shorter string and another digest', () => {
  const call = bindCall('create_draft', { ...FULL.create_draft, agent_id: null });
  const skipped = linesOf(call).filter((line) => line !== '-');
  assert.equal(linesOf(call).length, 8);
  assert.equal(skipped.length, 7);
  assert.notEqual(sha(skipped.join('\n')), call.argsSha256, 'an uncoalesced SQL side would never bind');
  /* Values that look like absence are values: they are hashed, never coalesced. */
  assert.equal(linesOf(bindCall('create_draft', { ...FULL.create_draft, agent_name: '-' }))[3], sha('-'));
  assert.equal(linesOf(bindCall('create_draft', { ...FULL.create_draft, agent_name: '' }))[3], SHA.empty);
});

test('every line is the function name, a uuid, an integer, 64 lowercase hex or "-"; the digest is over UTF-8 bytes', () => {
  const astral = String.fromCodePoint(0x1f600);
  const calls = [
    bindCall('create_draft', {
      ...FULL.create_draft,
      agent_id: null,
      agent_name: `brief ${astral}`,
      content: `a${astral}\u2028b`,
      derived_canonical: '{"s":"\\/","x":"\u2028"}',
    }),
    bindCall('save_draft', { ...FULL.save_draft, expected_version: 2147483647, content: 'x'.repeat(262144) }),
    bindCall('submit_candidate', { ...FULL.submit_candidate, expected_version: -2147483648 }),
    bindCall('create_successor', { ...FULL.create_successor, derived_canonical: `{"name":"${astral}"}` }),
  ];
  const LINE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|-?(?:0|[1-9][0-9]*)|[0-9a-f]{64}|-)$/;
  for (const call of calls) {
    const [fn, ...rest] = linesOf(call);
    assert.equal(fn, call.fn);
    for (const line of rest) assert.match(line, LINE, call.fn);
    assert.equal(call.binding.endsWith('\n'), false);
    assert.equal(call.argsSha256, createHash('sha256').update(Buffer.from(call.binding, 'utf8')).digest('hex'));
  }
  assert.equal(Buffer.byteLength(astral, 'utf8'), 4);
  assert.equal(linesOf(calls[0])[3], sha(`brief ${astral}`));
  assert.equal(linesOf(calls[1])[3], sha('x'.repeat(262144)));
});

test('values the database would read differently are canonicalized once, or refused before either projection', () => {
  const upper = bindCall('create_successor', {
    ...FULL.create_successor,
    candidate_id: AGENT.toUpperCase(),
    content_sha256: SHA.content.toUpperCase(),
    gate_identity: 'AB'.repeat(32),
  });
  assert.equal(upper.body.p_candidate, AGENT);
  assert.equal(linesOf(upper)[1], AGENT);
  assert.equal(upper.body.p_content_sha256, `\\x${SHA.content}`);
  assert.equal(linesOf(upper)[2], SHA.content);
  assert.equal(upper.body.p_gate_identity, `\\x${'ab'.repeat(32)}`);
  const refused = [
    ['save_draft', { candidate_id: 'not-a-uuid' }],
    ['save_draft', { candidate_id: `{${ID}}` }],
    ['save_draft', { candidate_id: ID.replaceAll('-', '') }],
    /* E3-PREQ-D2: Postgres refuses a uuid with surrounding space, so a canonicalizer that tested a
       trimmed copy and returned the original would sign and send it. Each of these kills that mutant. */
    ['save_draft', { candidate_id: ` ${ID}` }],
    ['save_draft', { candidate_id: `${ID} ` }],
    ['create_draft', { company_id: ` ${COMPANY} ` }],
    ['save_draft', { idempotency_key: `${KEY}\n` }],
    ['save_draft', { expected_version: '3' }],
    ['save_draft', { expected_version: 3.5 }],
    ['save_draft', { expected_version: 2147483648 }],
    ['save_draft', { expected_version: Number.NaN }],
    ['save_draft', { content: 42 }],
    ['save_draft', { content: 'lone \ud800 surrogate' }],
    ['save_draft', { gate_identity: 'a'.repeat(63) }],
    ['save_draft', { gate_identity: `\\x${GATE}` }],
    ['save_draft', { gate_identity: 'g'.repeat(64) }],
    ['save_draft', { candidateId: ID }],
    ['create_draft', { candidate_id: ID }],
  ];
  for (const [fn, patch] of refused) {
    assert.throws(() => bindCall(fn, { ...FULL[fn], ...patch }), TypeError, `${fn} ${JSON.stringify(patch)}`);
  }
  for (const args of [null, undefined, 'x', [ID]]) assert.throws(() => bindCall('save_draft', args), TypeError);
  for (const fn of [...UNBOUND_NAMES, 'drop_everything', 'toString', undefined]) {
    assert.throws(() => bindCall(fn, {}), /not a bound function/, String(fn));
  }
});

test('U+0000 in any text field is refused before either projection, so nothing is hashed, signed or sent', async () => {
  /* Critique finding 2 (evidence/e3-prereq-critique.md). NUL is a well-formed scalar value, so
     isWellFormed() admits it, but Postgres text cannot hold it: the JSON-to-text conversion refuses the
     escape before any routine could recompute the digest, and the call used to be signed and sent first.
     The text fields come from the independent 4.4 signatures above, not from the module's table. */
  const NUL = String.fromCharCode(0);
  const textFields = Object.entries(BOUND).flatMap(([fn, spec]) =>
    spec.binding.filter((_, i) => SIGNATURES[fn][i][1] === pg.text).map((field) => [fn, field]),
  );
  assert.equal(textFields.length, 19, 'every text parameter of the ten signatures: E3 eight, E4 six, E5 five');
  const s = await session();
  const f = fakeFetch(200, {});
  for (const [fn, field] of textFields) {
    for (const value of [NUL, `before${NUL}after`, `end${NUL}`]) {
      const label = `${fn} ${field} ${JSON.stringify(value)}`;
      assert.throws(() => bindCall(fn, { ...FULL[fn], [field]: value }), TypeError, label);
      await assert.rejects(callBound(s, fn, { ...FULL[fn], [field]: value }, { fetchImpl: f }), TypeError, label);
    }
  }
  assert.equal(f.log.length, 0, 'nothing was signed and sent');
  /* NUL only: every other scalar value round-trips through Postgres text with the same UTF-8 digest
     (evidence/e3-prereq-corrections.md, the all-scalars probe), and an escaped NUL is six characters of text. */
  for (const value of [String.fromCharCode(1), '\t\n\r', String.fromCharCode(0x1f, 0x7f), '\\u0000']) {
    assert.equal(
      linesOf(bindCall('save_draft', { ...FULL.save_draft, content: value }))[3],
      sha(value),
      JSON.stringify(value),
    );
  }
});

test('4.3 and H2: a retry with fresh derived bytes or gate identity keeps the operation and changes the binding', () => {
  const first = bindCall('save_draft', {
    ...FULL.save_draft,
    derived_canonical: '{"validated_at":"2026-09-13T10:00:00Z"}',
  });
  const retry = bindCall('save_draft', {
    ...FULL.save_draft,
    derived_canonical: '{"validated_at":"2026-09-13T10:00:01Z"}',
    gate_identity: 'b'.repeat(64),
  });
  assert.notEqual(retry.argsSha256, first.argsSha256);
  assert.equal(retry.operationSha256, first.operationSha256);
  assert.notEqual(
    bindCall('save_draft', { ...FULL.save_draft, content: 'other' }).operationSha256,
    first.operationSha256,
  );
  assert.notEqual(
    bindCall('save_draft', { ...FULL.save_draft, expected_version: 4 }).operationSha256,
    first.operationSha256,
  );
  const other = '9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b';
  const a = bindCall('create_draft', { ...FULL.create_draft, agent_id: null });
  const b = bindCall('create_draft', { ...FULL.create_draft, agent_id: null, company_id: other });
  assert.notEqual(a.argsSha256, b.argsSha256, 'two companies are two bindings (H2_COMPANY_PROJECTION)');
  assert.notEqual(a.operationSha256, b.operationSha256);
  assert.notDeepEqual(a.body, b.body);
});

test('serverToken refuses bind for each of the thirteen unbound functions, an unknown name and a malformed digest', async () => {
  const s = await session();
  assert.deepEqual([...FUNCTIONS].sort(), UNBOUND_NAMES);
  for (const fn of UNBOUND_NAMES) {
    assert.throws(() => serverToken(s, { bind: { fn, args_sha256: GATE } }), /E2 function and is never bound/, fn);
  }
  for (const bind of [
    null,
    {},
    { fn: 'drop_everything', args_sha256: GATE },
    { fn: 'save_draft' },
    { fn: 'save_draft', args_sha256: GATE.toUpperCase() },
    { fn: 'save_draft', args_sha256: 'a'.repeat(63) },
    { fn: 'save_draft', args_sha256: `\\x${GATE}` },
  ]) {
    assert.throws(() => serverToken(s, { bind }), TypeError, JSON.stringify(bind));
  }
});

test('a bound token is the unbound claims plus fn, args_sha256 and a fresh lowercase uuid jti', async () => {
  const s = await session('aal2');
  const unbound = decode(serverToken(s, { now: 1_800_000_000 }));
  for (const claim of ['fn', 'args_sha256', 'jti']) assert.equal(claim in unbound, false, claim);
  const t1 = serverToken(s, { now: 1_800_000_000, bind: { fn: 'save_draft', args_sha256: GATE } });
  const t2 = serverToken(s, { now: 1_800_000_000, bind: { fn: 'save_draft', args_sha256: GATE } });
  const [c1, c2] = [decode(t1), decode(t2)];
  assert.deepEqual({ ...c1, jti: undefined }, { ...unbound, fn: 'save_draft', args_sha256: GATE, jti: undefined });
  assert.match(c1.jti, JTI);
  assert.match(c2.jti, JTI);
  assert.notEqual(c1.jti, c2.jti);
  const [h, p, sig] = t1.split('.');
  assert.equal(createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url'), sig);
});

test('callBound: the body that leaves the process, read as Postgres reads it, gives the digest in the token', async () => {
  const s = await session();
  const mixed = {
    create_draft: {
      ...FULL.create_draft,
      company_id: COMPANY.toUpperCase(),
      agent_id: null,
      agent_name: 'Wöchentlich \u{1f600}',
    },
    save_draft: { ...FULL.save_draft, candidate_id: AGENT.toUpperCase(), content: 'line\u2028two' },
    submit_candidate: { ...FULL.submit_candidate, content_sha256: SHA.body.toUpperCase() },
    create_successor: { ...FULL.create_successor, gate_identity: 'CD'.repeat(32) },
  };
  for (const [fn, args] of Object.entries(mixed)) {
    const f = fakeFetch(200, { ok: fn });
    assert.deepEqual(await callBound(s, fn, args, { fetchImpl: f }), { ok: fn });
    assert.equal(f.log.length, 1, fn);
    assert.equal(f.log[0].url, `${BASE}/rest/v1/rpc/${fn}`);
    assert.equal(f.log[0].method, 'POST');
    assert.equal(f.log[0].headers.apikey, 'unit-anon-key');
    const sent = JSON.parse(f.log[0].body);
    assert.deepEqual(
      Object.keys(sent),
      SIGNATURES[fn].map(([param]) => param),
      fn,
    );
    const claims = decode(f.log[0].headers.authorization.slice('Bearer '.length));
    assert.equal(claims.fn, fn);
    assert.equal(claims.args_sha256, sha(recompute(fn, sent)), fn);
    assert.equal(claims.args_sha256, bindCall(fn, args).argsSha256, fn);
    assert.match(claims.jti, JTI);
    assert.equal(claims.role, 'app_server');
    assert.equal(claims.sub, SUB);
  }
});

test('callBound reads each argument once, so a value that changes between reads cannot split body from binding', async () => {
  let reads = 0;
  const args = {
    ...FULL.save_draft,
    get content() {
      reads += 1;
      return `read ${reads}`;
    },
  };
  const f = fakeFetch(200, {});
  await callBound(await session(), 'save_draft', args, { fetchImpl: f });
  assert.equal(reads, 1);
  const sent = JSON.parse(f.log[0].body);
  assert.equal(decode(f.log[0].headers.authorization.slice(7)).args_sha256, sha(recompute('save_draft', sent)));
});

test('callBound refuses before any request; rpc refuses the four bound names; errors map through lib/errors', async () => {
  const s = await session();
  const f = fakeFetch(200, {});
  for (const fn of UNBOUND_NAMES)
    await assert.rejects(callBound(s, fn, {}, { fetchImpl: f }), /not a bound function/, fn);
  await assert.rejects(
    callBound(s, 'save_draft', { ...FULL.save_draft, candidateId: ID }, { fetchImpl: f }),
    /takes no/,
  );
  await assert.rejects(
    callBound(s, 'save_draft', { ...FULL.save_draft, expected_version: '3' }, { fetchImpl: f }),
    TypeError,
  );
  await assert.rejects(callBound({ ...s }, 'save_draft', FULL.save_draft, { fetchImpl: f }), /not a VerifiedSession/);
  const t = serverToken(s);
  for (const fn of Object.keys(BOUND))
    await assert.rejects(rpc(fn, {}, t, { fetchImpl: f }), /not an api function/, fn);
  assert.equal(f.log.length, 0, 'nothing was sent');
  const refused = fakeFetch(403, { code: '42501', message: 'E_NOT_SERVER', details: 'row text', hint: null });
  await assert.rejects(
    callBound(s, 'save_draft', FULL.save_draft, { fetchImpl: refused }),
    (e) => e.code === 'E_NOT_SERVER' && e.status === 403 && e.cause === undefined,
  );
});

test('bindingSql and operationSql print the recomputation from the same rows, every field coalesced to "-"', () => {
  assert.equal(
    bindingSql('save_draft'),
    "sha256(convert_to(concat_ws(E'\\n', 'save_draft', coalesce(p_candidate::text, '-'), " +
      "coalesce(p_expected_version::text, '-'), coalesce(encode(sha256(convert_to(p_content, 'UTF8')), 'hex'), '-'), " +
      "coalesce(encode(sha256(convert_to(p_derived_canonical, 'UTF8')), 'hex'), '-'), " +
      "coalesce(encode(p_gate_identity, 'hex'), '-'), coalesce(p_idempotency_key::text, '-')), 'UTF8'))",
  );
  assert.equal(
    operationSql('create_successor'),
    "sha256(convert_to(concat_ws(E'\\n', 'create_successor', coalesce(p_candidate::text, '-')), 'UTF8'))",
  );
  for (const fn of Object.keys(BOUND)) {
    const binding = bindingSql(fn);
    const operation = operationSql(fn);
    assert.equal(binding.match(/coalesce\(/g).length, BOUND[fn].binding.length, fn);
    assert.equal(operation.match(/coalesce\(/g).length, BOUND[fn].operation.length, fn);
    assert.deepEqual(
      binding.match(/\bp_[a-z0-9_]+/g),
      SIGNATURES[fn].map(([param]) => param),
      fn,
    );
    assert.ok(binding.includes(`'${fn}'`), fn);
  }
  for (const fn of ['invite_member', 'drop_everything']) {
    assert.throws(() => bindingSql(fn), TypeError);
    assert.throws(() => operationSql(fn), TypeError);
  }
});
