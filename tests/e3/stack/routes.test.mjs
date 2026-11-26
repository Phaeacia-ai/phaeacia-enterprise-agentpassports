/* The E3 routes against the running local stack (E3 design section 6): cases 1, 8, 12's route half, 18, 19, 29 and
   30, the service's shape rules against the routine's own, and the reads of 4.1 through the routes. Reseeds through
   tests/db/00-seed.sh once and builds its own users and companies. Each case's control is section 6's last column.
   Run one file at a time: node --test --test-concurrency=1 tests/e3/stack/ */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { SUBMISSION, SUBMISSION_SHAPES, TRIMMED_SHAPES } from '../unit/submission-shapes.mjs';
import {
  audits,
  CR,
  caller,
  count,
  key,
  ORIGIN,
  PROSE,
  passport,
  passportText,
  psqlSession,
  requestChanges,
  reseed,
  sql,
  withFetch,
  world,
} from './helpers.mjs';

const ids = reseed();
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { toNetlify } = await import('../../../lib/http/netlify.mjs');
const { GATE_IDENTITY_SHA256, MANIFEST } = await import('../../../lib/passport/gate-manifest.mjs');
const { submissionOf } = await import('../../../lib/services/candidates.mjs');

const logged = [];
const routes = makeRoutes({ log: (e) => logged.push(e) });
const call = caller(routes, COOKIES, makeRequest);
const W = world('routes', ids);
const sha = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

const admin = W.user('admin');
const author = W.user('author');
const other = W.user('other');
const reviewer = W.user('reviewer');
const bAdmin = W.user('b-admin');
const bOnly = W.user('b-only');
const outsider = W.user('outsider');
const A = W.company('a', admin);
const B = W.company('b', bAdmin);
const M = {
  author: W.member(A.id, author),
  other: W.member(A.id, other),
  reviewer: W.member(A.id, reviewer, '{it_reviewer,member}'),
  authorInB: W.member(B.id, author),
  bOnly: W.member(B.id, bOnly),
};

/* Every PostgREST call the service makes, counted by kind, around one route call. */
async function counted(run) {
  const seen = { reads: 0, rpc: 0 };
  const result = await withFetch(
    (url, init, original) => {
      if (String(url).includes('/rest/v1/rpc/')) seen.rpc++;
      else seen.reads++;
      return original(url, init);
    },
    run,
  );
  return { ...result, seen };
}
const create = (user, companyId, { name, agentId, bytes = passport('0'), idem = key(), headers = {} } = {}) =>
  call('candidatesCreate', {
    user,
    params: { companyId },
    headers: {
      'idempotency-key': idem,
      ...(name ? { 'x-agent-name': name } : {}),
      ...(agentId ? { 'x-agent-id': agentId } : {}),
      ...headers,
    },
    body: bytes,
  });
const save = (user, candidateId, version, { bytes = passport('s'), idem = key(), headers = {} } = {}) =>
  call('candidatesSave', {
    user,
    params: { candidateId },
    headers: { 'idempotency-key': idem, 'if-match': String(version), ...headers },
    body: bytes,
  });
const submit = (user, candidateId, version, { body = { ...SUBMISSION }, idem = key(), headers = {} } = {}) =>
  call('candidatesSubmit', {
    user,
    params: { candidateId },
    headers: { 'idempotency-key': idem, 'if-match': String(version), ...headers },
    body,
  });
const successor = (user, candidateId, { idem = key() } = {}) =>
  call('candidatesSuccessor', { user, params: { candidateId }, headers: { 'idempotency-key': idem }, body: {} });
const read = (user, candidateId) => call('candidatesRead', { user, params: { candidateId } });
const list = (user, companyId, query = {}) => call('candidatesList', { user, params: { companyId }, query });
const row = (id) =>
  sql(
    `select state||'|'||version||'|'||encode(content_sha256,'hex')||'|'||to_char(validated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from app.candidate_versions where id='${id}'`,
  );
const auditsOf = (company) => Number(sql(`select count(*) from app.audit_events where company_id='${company}'`));
const onlyErrorKeys = (body) => assert.deepEqual(Object.keys(body).sort(), ['code', 'message', 'ok']);

test('vocabularies: the service states and confidence values are the database’s', async () => {
  const states = sql("select array_to_string(app.candidate_states(), ',')").split(',');
  for (const state of states) assert.equal((await list(author, A.id, { state })).status, 200, state);
  assert.equal((await list(author, A.id, { state: 'withdrawn' })).status, 422);
  for (const confidence of ['high', 'medium', 'low'])
    assert.doesNotThrow(() => submissionOf({ ...SUBMISSION, confidence }), confidence);
});

/* Lesson 4 of this assignment: the service never relies on the routine to refuse a shape it can refuse first, and
   never refuses a shape the routine would accept. Each body goes to app.submission_fields as the routine would read
   it, API names mapped to its names and nothing else changed. */
const ROUTINE_NAMES = {
  sourcePlatform: 'source_platform',
  permittedData: 'permitted_data',
  declaredContributors: 'declared_contributors',
  membershipId: 'membership_id',
  displayName: 'display_name',
};
const routineText = (value) =>
  JSON.stringify(value, function rename(k, v) {
    if (v && typeof v === 'object' && !Array.isArray(v))
      return Object.fromEntries(Object.entries(v).map(([name, inner]) => [ROUTINE_NAMES[name] ?? name, inner]));
    return v;
  });
const routineAcceptsText = (text) => {
  try {
    sql(`select app.submission_fields($j$${text}$j$) is not null`);
    return true;
  } catch (e) {
    assert.match(e.message, /E_BODY_INVALID/, 'the routine refuses with E_BODY_INVALID and nothing else');
    return false;
  }
};
const routineAccepts = (body) => routineAcceptsText(routineText(body));
const serviceAccepts = (body) => {
  try {
    submissionOf(body);
    return true;
  } catch (e) {
    assert.equal(e.code, 'E_BODY_INVALID');
    return false;
  }
};

test('lesson 4: on every submission shape the service and app.submission_fields agree, the trimmed names included', () => {
  /* The API names are camelCase; a snake_case key is a name the API does not have, so it is refused at the service
     and has no routine counterpart to compare. */
  const apiOnly = new Set(['a snake_case key']);
  for (const [label, body, expected] of SUBMISSION_SHAPES) {
    assert.equal(serviceAccepts(body), expected, `service: ${label}`);
    if (!apiOnly.has(label)) assert.equal(routineAccepts(body), expected, `routine: ${label}`);
  }
  /* E3A-R-D1, paid at the routine by migration 004. Before it the routine read these three names untrimmed, so it
     accepted the whitespace-only and the tab-and-newline name the service refuses, and refused the 120 characters
     inside spaces the service accepts. It now trims with the service's class, so its verdict on each body as sent is
     the service's, on all 45 shapes. */
  for (const [label, body, expected] of TRIMMED_SHAPES) {
    assert.equal(serviceAccepts(body), expected, `service: ${label}`);
    assert.equal(routineAccepts(body), expected, `routine, the name untrimmed as sent: ${label}`);
  }
  /* The direction a write depends on: whatever the service accepts, the routine accepts in the text the service sends. */
  for (const [label, body, expected] of [...SUBMISSION_SHAPES, ...TRIMMED_SHAPES])
    if (expected) assert.equal(routineAcceptsText(submissionOf(body)), true, `routine, the service's own text: ${label}`);
});

test('E3A-R-D1 through the route: a whitespace-only declared name is 422 before any call; a padded name is stored trimmed', async () => {
  const d = await create(author, A.id, { name: `trim-${W.run}` });
  assert.equal(d.status, 201, d.raw);
  const before = { audits: audits(), contributors: count(`app.candidate_contributors where candidate_id='${d.body.candidateId}'`) };
  const r = await counted(() =>
    submit(author, d.body.candidateId, 1, { body: { ...SUBMISSION, declaredContributors: [{ displayName: ` ${CR}\t` }] } }),
  );
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'E_BODY_INVALID');
  assert.equal(r.seen.reads + r.seen.rpc, 0, 'refused before any read or call');
  assert.equal(audits(), before.audits);
  assert.equal(count(`app.candidate_contributors where candidate_id='${d.body.candidateId}'`), before.contributors);
  assert.match(row(d.body.candidateId), /^draft\|1\|/);
  const ok = await submit(author, d.body.candidateId, 1, {
    body: { ...SUBMISSION, declaredContributors: [{ displayName: '  Jane Doe (former intern)  ' }] },
  });
  assert.equal(ok.status, 200, ok.raw);
  assert.equal(
    sql(`select display_name from app.candidate_contributors where candidate_id='${d.body.candidateId}' and kind='declared_offline'`),
    'Jane Doe (former intern)',
  );
  assert.deepEqual(ok.body.contributors.at(-1), { kind: 'declared_offline', displayName: 'Jane Doe (former intern)' });
});

test('case 1: hashes, derived bytes, a gate id and a validated time the client supplies next to passport B are ignored; the row holds B’s own', async () => {
  const text = passportText('case1');
  const forged = {
    'x-content-sha256': 'a'.repeat(64),
    'x-derived-sha256': 'b'.repeat(64),
    'x-derived': '{"title":"forged"}',
    'x-gate-id': '00000000-0000-4000-8000-000000000000',
    'x-gate-identity-sha256': 'c'.repeat(64),
    'x-validated-at': '2020-01-01T00:00:00.000Z',
  };
  const started = Date.now();
  const r = await call('candidatesCreate', {
    user: author,
    params: { companyId: A.id },
    query: { contentSha256: 'a'.repeat(64), validatedAt: '2020-01-01T00:00:00.000Z' },
    headers: { 'idempotency-key': key(), 'x-agent-name': `case1-${W.run}`, ...forged },
    body: Buffer.from(text, 'utf8'),
  });
  assert.equal(r.status, 201, r.raw);
  const [state, version, contentSha, validatedAt] = row(r.body.candidateId).split('|');
  assert.deepEqual([state, version], ['draft', '1']);
  assert.equal(contentSha, sha(text), 'the row holds B’s true hash');
  assert.notEqual(contentSha, 'a'.repeat(64));
  assert.equal(r.body.contentSha256, contentSha);
  assert.equal(r.body.attestation.validatedAt, validatedAt, 'the server’s time, the one the row holds');
  assert.ok(Date.parse(validatedAt) >= started - 1000, 'this request’s time, not the client’s');
  assert.equal(
    sql(
      `select encode(v.derived_sha256,'hex') = encode(sha256(convert_to(v.derived_canonical,'UTF8')),'hex') and v.derived->>'title' <> 'forged' and encode(g.identity_sha256,'hex') = '${GATE_IDENTITY_SHA256}' from app.candidate_versions v join app.gate_identities g on g.id = v.gate_id where v.id='${r.body.candidateId}'`,
    ),
    't',
    'derived bytes and gate identity are the server’s',
  );
  const s = await save(author, r.body.candidateId, 1, { bytes: passport('case1-save'), headers: forged });
  assert.equal(s.status, 200, s.raw);
  assert.equal(row(r.body.candidateId).split('|')[2], sha(passportText('case1-save')));
  /* Submit's body is metadata with a closed key set: a hash in it is refused, and nothing is frozen. */
  const auditsBefore = audits();
  const sub = await submit(author, r.body.candidateId, 2, { body: { ...SUBMISSION, contentSha256: 'a'.repeat(64) } });
  assert.equal(sub.status, 422);
  assert.equal(sub.body.code, 'E_BODY_INVALID');
  assert.match(row(r.body.candidateId), /^draft\|2\|/);
  assert.equal(audits(), auditsBefore);
  /* Control: the plain upload. */
  const plain = await create(author, A.id, { name: `case1-plain-${W.run}`, bytes: Buffer.from(text, 'utf8') });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.contentSha256, sha(text));
});

test('case 8: a lone CR and a CR CR LF through create and save are 422 E_CANONICAL with the line; nothing stored, no audit row', async () => {
  const d = await create(author, A.id, { name: `case8-${W.run}` });
  assert.equal(d.status, 201);
  for (const [label, sequence] of [
    ['a lone CR', `${CR}More prose.`],
    ['CR CR LF', `${CR}${CR}\nMore prose.`],
  ]) {
    const text = passportText('case8').replace(PROSE, `${PROSE}${sequence}`);
    const line = text.slice(0, text.indexOf(PROSE)).split('\n').length;
    const before = { audits: audits(), rows: count('app.candidate_versions'), row: row(d.body.candidateId) };
    const c = await counted(() => create(author, A.id, { name: `case8-new-${W.run}`, bytes: Buffer.from(text, 'utf8') }));
    assert.equal(c.status, 422, `${label} create`);
    assert.deepEqual(c.body.problems, [{ code: 'E_CANONICAL', line }], `${label} create`);
    assert.equal(c.body.code, 'E_CANONICAL');
    assert.equal(c.seen.rpc, 0);
    const s = await counted(() => save(author, d.body.candidateId, 1, { bytes: Buffer.from(text, 'utf8') }));
    assert.equal(s.status, 422, `${label} save`);
    assert.deepEqual(s.body.problems, [{ code: 'E_CANONICAL', line }], `${label} save`);
    assert.equal(s.seen.rpc, 0);
    assert.equal(audits(), before.audits, `${label}: no audit row`);
    assert.equal(count('app.candidate_versions'), before.rows, `${label}: no candidate row`);
    assert.equal(row(d.body.candidateId), before.row, `${label}: the draft is unchanged`);
    assert.equal(count(`app.agents where name='case8-new-${W.run}'`), 0);
  }
  /* The same bytes through the Netlify adapter, so the Buffer the gate reads is the one the web request carried. */
  const text = passportText('case8-adapter').replace(PROSE, `${PROSE}${CR}More prose.`);
  const res = await toNetlify(routes.candidatesCreate)(
    new Request(`${ORIGIN}/api/companies/${A.id}/candidates`, {
      method: 'POST',
      headers: {
        cookie: `${COOKIES.access}=${author.token()}`,
        'content-type': 'text/markdown',
        'idempotency-key': key(),
        'x-agent-name': `case8-adapter-${W.run}`,
      },
      body: Buffer.from(text, 'utf8'),
    }),
    { params: { companyId: A.id } },
  );
  assert.equal(res.status, 422);
  assert.equal((await res.json()).problems[0].code, 'E_CANONICAL');
  const notUtf8 = await toNetlify(routes.candidatesCreate)(
    new Request(`${ORIGIN}/api/companies/${A.id}/candidates`, {
      method: 'POST',
      headers: {
        cookie: `${COOKIES.access}=${author.token()}`,
        'content-type': 'text/markdown',
        'idempotency-key': key(),
        'x-agent-name': `case8-utf8-${W.run}`,
      },
      body: Buffer.concat([passport('utf8'), Buffer.from([0xff])]),
    }),
    { params: { companyId: A.id } },
  );
  assert.equal(notUtf8.status, 422);
  assert.equal((await notUtf8.json()).code, 'E_NOT_UTF8', 'the bytes reach the gate undecoded');
  /* Control: the same passport with line feeds. */
  const control = await create(author, A.id, {
    name: `case8-control-${W.run}`,
    bytes: Buffer.from(passportText('case8').replace(PROSE, `${PROSE}\nMore prose.`), 'utf8'),
  });
  assert.equal(control.status, 201, control.raw);
});

test('case 18: an honest create retry, first response discarded and a second of real clock later, answers the stored result; the same key with other content conflicts', async () => {
  const name = `case18-${W.run}`;
  const idem = key();
  const auditsBefore = auditsOf(A.id);
  await create(author, A.id, { name, idem, bytes: passport('case18') });
  const stored = sql(
    `select v.id||'|'||to_char(v.validated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from app.candidate_versions v join app.agents g on g.id = v.agent_id where g.name='${name}'`,
  ).split('|');
  await new Promise((r) => setTimeout(r, 1100));
  const retry = await create(author, A.id, { name, idem, bytes: passport('case18') });
  assert.equal(retry.status, 201, retry.raw);
  assert.equal(retry.body.idempotentReplay, true);
  assert.equal(retry.body.candidateId, stored[0]);
  assert.equal(retry.body.attestation.validatedAt, stored[1], 'the first attempt’s validatedAt');
  assert.ok(Date.now() - Date.parse(stored[1]) >= 1000, 'at least a second of real clock between the attempts');
  assert.equal(count(`app.agents where name='${name}'`), 1);
  assert.equal(count(`app.candidate_versions v join app.agents g on g.id = v.agent_id where g.name='${name}'`), 1);
  assert.equal(count(`app.audit_events where action='candidate.create' and entity_id='${stored[0]}'`), 1);
  assert.equal(auditsOf(A.id) - auditsBefore, 2, 'agent.create and candidate.create, once each');
  const changed = await create(author, A.id, { name, idem, bytes: passport('case18-other') });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'E_IDEMPOTENCY_CONFLICT');
  /* Control: a fresh key makes a second candidate, by agent id since the name is now taken. */
  const agentId = retry.body.agentId;
  const fresh = await create(author, A.id, { agentId, bytes: passport('case18') });
  assert.equal(fresh.status, 201);
  assert.notEqual(fresh.body.candidateId, stored[0]);
  assert.equal(count(`app.candidate_versions where agent_id='${agentId}'`), 2);
});

test('case 12, route half: two requests present one key at once; one claim, one audit row, both answers the same candidate', async () => {
  const d = await create(author, A.id, { name: `case12-${W.run}` });
  const agentId = d.body.agentId;
  const holder = psqlSession();
  holder.write('begin;');
  holder.write(`select id from app.companies where id='${A.id}' for no key update;`);
  await new Promise((r) => setTimeout(r, 400));
  const idem = key();
  const auditsBefore = auditsOf(A.id);
  const both = Promise.all([
    create(author, A.id, { agentId, idem, bytes: passport('case12') }),
    create(author, A.id, { agentId, idem, bytes: passport('case12') }),
  ]);
  await new Promise((r) => setTimeout(r, 1200));
  holder.write('commit;');
  const [first, second] = await both;
  await holder.end();
  assert.deepEqual([first.status, second.status], [201, 201], `${first.raw} ${second.raw}`);
  assert.equal(first.body.candidateId, second.body.candidateId);
  assert.equal([first.body.idempotentReplay, second.body.idempotentReplay].filter((x) => x === true).length, 1);
  assert.equal(count(`app.idempotency_keys where key='${idem}'`), 1);
  assert.equal(auditsOf(A.id) - auditsBefore, 1);
  /* Sequentially, the same key answers the same candidate again, and still one audit row. */
  const third = await create(author, A.id, { agentId, idem, bytes: passport('case12') });
  assert.equal(third.body.candidateId, first.body.candidateId);
  assert.equal(auditsOf(A.id) - auditsBefore, 1);
  /* Control: two distinct keys at once make two candidates. */
  const [x, y] = await Promise.all([
    create(author, A.id, { agentId, bytes: passport('case12') }),
    create(author, A.id, { agentId, bytes: passport('case12') }),
  ]);
  assert.notEqual(x.body.candidateId, y.body.candidateId);
});

test('case 19: the company at the authoritative boundary, through the routes', async () => {
  const name = `case19-${W.run}`;
  /* A member of both companies creates the same agent name in each: two distinct agents. */
  const inA = await create(author, A.id, { name });
  const inB = await create(author, B.id, { name });
  assert.deepEqual([inA.status, inB.status], [201, 201], `${inA.raw} ${inB.raw}`);
  assert.notEqual(inA.body.agentId, inB.body.agentId);
  assert.equal(sql(`select count(distinct company_id) from app.agents where name='${name}'`), '2');
  const auditsBefore = audits();
  /* A member of B only posts to A's path: 404 at the principal read, no call. */
  const foreign = await counted(() => create(bOnly, A.id, { name: `case19-foreign-${W.run}` }));
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.code, 'E_NOT_FOUND');
  assert.equal(foreign.seen.rpc, 0);
  /* A member of A names B's agent id with A in the route; so does the member of both, who can read B's agent. */
  for (const user of [other, author]) {
    const r = await counted(() => create(user, A.id, { agentId: inB.body.agentId }));
    assert.equal(r.status, 404, user.who);
    assert.equal(r.seen.rpc, 0, `${user.who}: no call`);
  }
  /* A member of A names B's candidate id on save, submit and successor, and B's company id on list. */
  for (const [label, run] of [
    ['save', () => save(other, inB.body.candidateId, 1)],
    ['submit', () => submit(other, inB.body.candidateId, 1)],
    ['successor', () => successor(other, inB.body.candidateId)],
    ['read', () => read(other, inB.body.candidateId)],
    ['list', () => list(other, B.id)],
  ]) {
    const r = await counted(run);
    assert.equal(r.status, 404, label);
    assert.equal(r.seen.rpc, 0, `${label}: no call`);
  }
  /* A membership of B declared on A's draft: the routine's E_NOT_FOUND, before any lock, nothing frozen. */
  const declared = await submit(author, inA.body.candidateId, 1, {
    body: { ...SUBMISSION, declaredContributors: [{ membershipId: M.bOnly }] },
  });
  assert.equal(declared.status, 404, declared.raw);
  assert.match(row(inA.body.candidateId), /^draft\|1\|/);
  assert.equal(audits(), auditsBefore, 'no audit row in any refused case');
  /* Controls: own company ids succeed; the same name twice in one company is E_AGENT_NAME_TAKEN. */
  const again = await create(author, A.id, { name });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'E_AGENT_NAME_TAKEN');
  const own = await submit(author, inA.body.candidateId, 1, {
    body: { ...SUBMISSION, declaredContributors: [{ membershipId: M.other }] },
  });
  assert.equal(own.status, 200, own.raw);
});

test('case 29: a valid session whose membership is removed mid-session answers 404 on every route, with no audit row', async () => {
  const stale = W.user('stale');
  const membership = W.member(A.id, stale);
  const setStatus = (status) =>
    sql(`update app.memberships set status='${status}', removed_at=${status === 'removed' ? 'now()' : 'null'} where id='${membership}'`);
  const d = await create(stale, A.id, { name: `case29-${W.run}` });
  const p = await create(stale, A.id, { agentId: d.body.agentId, bytes: passport('case29-parent') });
  assert.equal((await submit(stale, p.body.candidateId, 1)).status, 200);
  requestChanges(p.body.candidateId);
  const routesUnderTest = () => [
    ['create', () => create(stale, A.id, { agentId: d.body.agentId, bytes: passport('case29-new') })],
    ['save', () => save(stale, d.body.candidateId, 1)],
    ['submit', () => submit(stale, d.body.candidateId, 1)],
    ['successor', () => successor(stale, p.body.candidateId)],
    ['read', () => read(stale, d.body.candidateId)],
    ['list', () => list(stale, A.id)],
    ['gate', () => call('gateRead', { user: stale })],
  ];
  /* Control: the same user before removal reads, lists and sees the gate. */
  for (const [label, run] of routesUnderTest().filter(([l]) => ['read', 'list', 'gate'].includes(l)))
    assert.equal((await run()).status, 200, `before removal: ${label}`);
  setStatus('removed');
  const auditsBefore = audits();
  for (const [label, run] of routesUnderTest()) {
    const r = await counted(run);
    assert.equal(r.status, 404, `${label}: ${r.raw}`);
    assert.equal(r.body.code, 'E_NOT_FOUND', label);
    assert.equal(r.seen.rpc, 0, `${label}: refused under the user token before any call`);
  }
  assert.equal(audits(), auditsBefore);
  /* The routine's own answer: the membership is removed after the service's reads and before its call. */
  for (const [label, run] of routesUnderTest().slice(0, 4)) {
    setStatus('active');
    const r = await withFetch((url, init, original) => {
      if (String(url).includes('/rest/v1/rpc/')) setStatus('removed');
      return original(url, init);
    }, run);
    assert.equal(r.status, 404, `${label} (routine): ${r.raw}`);
    assert.equal(r.body.code, 'E_NOT_FOUND', label);
    assert.equal(audits(), auditsBefore, `${label} (routine): no audit row`);
  }
  assert.match(row(d.body.candidateId), /^draft\|1\|/);
});

test('case 30: malformed input on every route answers the status and code of 4.5, with no database details and no call', async () => {
  const d = await create(author, A.id, { name: `case30-${W.run}` });
  const c = d.body.candidateId;
  const auditsBefore = audits();
  const cases = [
    ['create, company id not a uuid', () => create(author, 'not-a-uuid', { name: 'x' }), 404, 'E_NOT_FOUND'],
    ['save, candidate id not a uuid', () => save(author, 'not-a-uuid', 1), 404, 'E_NOT_FOUND'],
    ['submit, candidate id not a uuid', () => submit(author, `${c}0`, 1), 404, 'E_NOT_FOUND'],
    ['successor, candidate id not a uuid', () => successor(author, 'x'), 404, 'E_NOT_FOUND'],
    ['read, candidate id not a uuid', () => read(author, 'x'), 404, 'E_NOT_FOUND'],
    ['list, company id not a uuid', () => list(author, 'x'), 404, 'E_NOT_FOUND'],
    [
      'create, no Idempotency-Key',
      () =>
        call('candidatesCreate', { user: author, params: { companyId: A.id }, headers: { 'x-agent-name': 'x' }, body: passport() }),
      422,
      'E_IDEMPOTENCY_KEY_INVALID',
    ],
    ['save, Idempotency-Key not a uuid', () => save(author, c, 1, { idem: 'key-1' }), 422, 'E_IDEMPOTENCY_KEY_INVALID'],
    [
      'submit, no Idempotency-Key',
      () =>
        call('candidatesSubmit', { user: author, params: { candidateId: c }, headers: { 'if-match': '1' }, body: SUBMISSION }),
      422,
      'E_IDEMPOTENCY_KEY_INVALID',
    ],
    [
      'successor, no Idempotency-Key',
      () => call('candidatesSuccessor', { user: author, params: { candidateId: c }, body: {} }),
      422,
      'E_IDEMPOTENCY_KEY_INVALID',
    ],
    ['save, If-Match not an integer', () => save(author, c, '1a'), 428, 'E_VERSION_REQUIRED'],
    ['submit, If-Match an entity tag', () => submit(author, c, '"1"'), 428, 'E_VERSION_REQUIRED'],
    [
      'save, no If-Match',
      () =>
        call('candidatesSave', { user: author, params: { candidateId: c }, headers: { 'idempotency-key': key() }, body: passport() }),
      428,
      'E_VERSION_REQUIRED',
    ],
    [
      'create, a JSON body on a passport route',
      () =>
        call('candidatesCreate', {
          user: author,
          params: { companyId: A.id },
          headers: { 'idempotency-key': key(), 'x-agent-name': 'x' },
          body: '{"content":"x"}',
          contentType: 'application/json',
        }),
      415,
      'E_UNSUPPORTED_MEDIA_TYPE',
    ],
    [
      'submit, a markdown body on a JSON route',
      () =>
        call('candidatesSubmit', {
          user: author,
          params: { candidateId: c },
          headers: { 'idempotency-key': key(), 'if-match': '1' },
          body: passport(),
          contentType: 'text/markdown',
        }),
      415,
      'E_UNSUPPORTED_MEDIA_TYPE',
    ],
    [
      'successor, a markdown body on a JSON route',
      () =>
        call('candidatesSuccessor', {
          user: author,
          params: { candidateId: c },
          headers: { 'idempotency-key': key() },
          body: passport(),
          contentType: 'text/markdown',
        }),
      415,
      'E_UNSUPPORTED_MEDIA_TYPE',
    ],
    ['save, an empty body', () => save(author, c, 1, { bytes: Buffer.alloc(0) }), 422, 'E_BODY_INVALID'],
    ['create, an empty body', () => create(author, A.id, { name: 'x', bytes: Buffer.alloc(0) }), 422, 'E_BODY_INVALID'],
    [
      'submit, an empty body',
      () =>
        call('candidatesSubmit', {
          user: author,
          params: { candidateId: c },
          headers: { 'idempotency-key': key(), 'if-match': '1' },
          body: '',
          contentType: 'application/json',
        }),
      422,
      'E_BODY_INVALID',
    ],
    ['successor, a non-empty body', () => call('candidatesSuccessor', { user: author, params: { candidateId: c }, headers: { 'idempotency-key': key() }, body: { contentSha256: 'a'.repeat(64) } }), 422, 'E_BODY_INVALID'],
    [
      'create, both agent headers',
      () => create(author, A.id, { name: 'x', agentId: d.body.agentId }),
      422,
      'E_BODY_INVALID',
    ],
    ['create, neither agent header', () => create(author, A.id, {}), 422, 'E_BODY_INVALID'],
    ['create, an agent id not a uuid', () => create(author, A.id, { agentId: 'agent-1' }), 404, 'E_NOT_FOUND'],
    [
      'submit, a declaration holding both keys',
      () =>
        submit(author, c, 1, { body: { ...SUBMISSION, declaredContributors: [{ membershipId: M.other, displayName: 'x' }] } }),
      422,
      'E_BODY_INVALID',
    ],
    ['submit, confidence outside the vocabulary', () => submit(author, c, 1, { body: { ...SUBMISSION, confidence: 'sure' } }), 422, 'E_BODY_INVALID'],
    [
      'submit, 41 dependencies',
      () => submit(author, c, 1, { body: { ...SUBMISSION, dependencies: Array.from({ length: 41 }, (_, i) => `d${i}`) } }),
      422,
      'E_BODY_INVALID',
    ],
    ['list, a state outside the vocabulary', () => list(author, A.id, { state: 'withdrawn' }), 422, 'E_BODY_INVALID'],
    ['list, a cursor not a uuid', () => list(author, A.id, { cursor: '10' }), 422, 'E_BODY_INVALID'],
  ];
  for (const [label, run, status, code] of cases) {
    const r = await counted(run);
    assert.equal(r.status, status, `${label}: ${r.raw}`);
    assert.equal(r.body.code, code, label);
    onlyErrorKeys(r.body);
    assert.equal(r.seen.rpc, 0, `${label}: no call`);
  }
  /* 10 MB through the Netlify adapter, on a passport route and a JSON route: 413 from what was kept. */
  const tenMb = Buffer.alloc(10 * 1024 * 1024, 0x61);
  for (const [name, params, headers, contentType] of [
    ['candidatesCreate', { companyId: A.id }, { 'x-agent-name': 'x', 'idempotency-key': key() }, 'text/markdown'],
    ['candidatesSave', { candidateId: c }, { 'if-match': '1', 'idempotency-key': key() }, 'text/markdown'],
    ['candidatesSubmit', { candidateId: c }, { 'if-match': '1', 'idempotency-key': key() }, 'application/json'],
  ]) {
    const handler = routes[name];
    const res = await toNetlify(handler)(
      new Request(`${ORIGIN}${handler.route.path}`, {
        method: handler.route.method,
        headers: { cookie: `${COOKIES.access}=${author.token()}`, 'content-type': contentType, ...headers },
        body: tenMb,
      }),
      { params },
    );
    assert.equal(res.status, 413, name);
    const body = await res.json();
    assert.equal(body.code, 'E_BODY_TOO_LARGE', name);
    onlyErrorKeys(body);
  }
  assert.equal(audits(), auditsBefore);
  assert.match(row(c), /^draft\|1\|/);
  /* Control: valid input. */
  assert.equal((await save(author, c, 1)).status, 200);
});

test('E3b critique F1: 17,183 bytes of legal metadata submit through the pipeline and the adapter and the row holds all of it; 262,145 bytes are 413 with nothing written', async () => {
  const wide = {
    ...SUBMISSION,
    permittedData: 'p'.repeat(2000),
    dependencies: Array.from({ length: 40 }, () => 'd'.repeat(200)),
    declaredContributors: Array.from({ length: 50 }, (_, i) => ({
      displayName: `${String(i).padStart(3, '0')}${'n'.repeat(117)}`,
    })),
  };
  const text = JSON.stringify(wide);
  assert.equal(Buffer.byteLength(text), 17183);
  const adapterSubmit = async (candidateId, bytes) => {
    const res = await toNetlify(routes.candidatesSubmit)(
      new Request(`${ORIGIN}/api/candidates/${candidateId}/submit`, {
        method: 'POST',
        headers: {
          cookie: `${COOKIES.access}=${author.token()}`,
          'content-type': 'application/json',
          'idempotency-key': key(),
          'if-match': '1',
        },
        body: bytes,
      }),
      { params: { candidateId } },
    );
    return { status: res.status, body: await res.json() };
  };
  const stored = (id) =>
    sql(
      `select (select count(*) from app.candidate_contributors where candidate_id='${id}' and kind='declared_offline')||'|'||coalesce(array_length(dependencies, 1), 0)||'|'||length(permitted_data)||'|'||state from app.candidate_versions where id='${id}'`,
    );

  const viaPipeline = (await create(author, A.id, { name: `f1-pipeline-${W.run}` })).body.candidateId;
  const p = await submit(author, viaPipeline, 1, { body: wide });
  assert.equal(p.status, 200, p.raw);
  assert.equal(p.body.contributors.filter((x) => x.kind === 'declared_offline').length, 50);
  assert.equal(stored(viaPipeline), '50|40|2000|submitted');

  const viaAdapter = (await create(author, A.id, { name: `f1-adapter-${W.run}` })).body.candidateId;
  const a = await adapterSubmit(viaAdapter, text);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(stored(viaAdapter), '50|40|2000|submitted');

  const tooLarge = (await create(author, A.id, { name: `f1-over-${W.run}` })).body.candidateId;
  const head = '{"permittedData":"';
  const over = `${head}${'p'.repeat(262145 - head.length - 2)}"}`;
  const auditsBefore = audits();
  const r1 = await counted(() => submit(author, tooLarge, 1, { body: over }));
  assert.deepEqual([r1.status, r1.body.code, r1.seen.reads, r1.seen.rpc], [413, 'E_BODY_TOO_LARGE', 0, 0]);
  const r2 = await adapterSubmit(tooLarge, over);
  assert.deepEqual([r2.status, r2.body.code], [413, 'E_BODY_TOO_LARGE']);
  assert.equal(audits(), auditsBefore);
  assert.match(row(tooLarge), /^draft\|1\|/);
});

test('4.1 through the routes: who reads a draft, a submitted candidate and the gate; who may create a successor (case 28a matrix rows)', async () => {
  const d = await create(author, A.id, { name: `read-${W.run}` });
  const c = d.body.candidateId;
  const r = await read(author, c);
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.candidate.content, passportText('0'));
  assert.equal(r.body.candidate.gateStatus, 'current');
  assert.equal(r.body.candidate.attestation.gateIdentitySha256, GATE_IDENTITY_SHA256);
  assert.deepEqual(r.body.contributors, [{ kind: 'author', membershipId: M.author }]);
  for (const user of [other, reviewer, admin, bOnly, outsider]) assert.equal((await read(user, c)).status, 404, `draft: ${user.who}`);
  assert.equal((await submit(author, c, 1)).status, 200);
  for (const user of [author, reviewer, admin]) assert.equal((await read(user, c)).status, 200, `submitted: ${user.who}`);
  for (const user of [other, bOnly, outsider]) assert.equal((await read(user, c)).status, 404, `submitted: ${user.who}`);
  const reviewerList = await list(reviewer, A.id, { state: 'submitted' });
  assert.ok(reviewerList.body.candidates.some((x) => x.candidateId === c));
  const otherList = await list(other, A.id);
  assert.ok(!otherList.body.candidates.some((x) => x.candidateId === c));
  assert.equal((await list(outsider, A.id)).status, 404);
  requestChanges(c);
  const refused = await successor(other, c);
  assert.equal(refused.status, 404, 'an ordinary member who may not read the parent');
  const made = await successor(reviewer, c);
  assert.equal(made.status, 201, made.raw);
  assert.equal(made.body.supersedesCandidateId, c);
  assert.equal(made.body.inheritedContributors, 2);
  const g = await call('gateRead', { user: other });
  assert.equal(g.status, 200);
  assert.equal(g.body.active.gateIdentitySha256, GATE_IDENTITY_SHA256);
  assert.equal(g.body.agrees, true);
  assert.deepEqual(
    g.body.active.files.map((f) => [f.path, f.sha256]),
    MANIFEST.map(([path, hash]) => [path, hash]),
  );
  assert.equal((await call('gateRead', { user: outsider })).status, 404, 'no active membership anywhere');
});

test('no response body and no log line carried passport text or an email address', () => {
  const log = JSON.stringify(logged);
  assert.ok(!log.includes('@'), log.slice(0, 300));
  assert.ok(!log.includes('SYNTHETIC Record Sorter'));
  assert.ok(!log.includes(PROSE));
});
