/* The seven E3 route declarations and their handlers without a stack (E3 design 4.4 and 4.5): each declaration's
   method, path, uuid parameters and body mode; the gate refusal body a passport write answers with; and case 1's unit
   half, that values a client supplies next to the passport change nothing the service sends. The route cases against
   the database are tests/e3/stack/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  answer,
  CANDIDATE,
  COMPANY,
  COOKIES,
  fakeDb,
  KEY,
  manifest,
  OLD_GATE_ID,
  OTHER_IDENTITY,
  PROSE,
  STORED_AT,
  userToken,
  X,
} from './fake-postgrest.mjs';
import { CR, cp, lineOf, SYNTHETIC, variant } from './helpers.mjs';
import { SUBMISSION } from './submission-shapes.mjs';

const { messageFor } = await import('../../../lib/errors.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { toNetlify } = await import('../../../lib/http/netlify.mjs');

test('the seven E3 declarations: method, path, uuid parameters and body mode, as design 4.4 gives them', async () => {
  const routes = makeRoutes();
  const expected = {
    candidatesCreate: { method: 'POST', session: 'required', body: 'passport', path: '/api/companies/:companyId/candidates' },
    candidatesSave: { method: 'PUT', session: 'required', body: 'passport', path: '/api/candidates/:candidateId' },
    candidatesSubmit: {
      method: 'POST',
      session: 'required',
      body: 'submission',
      path: '/api/candidates/:candidateId/submit',
    },
    candidatesSuccessor: {
      method: 'POST',
      session: 'required',
      body: 'json',
      path: '/api/candidates/:candidateId/successor',
    },
    candidatesRead: { method: 'GET', session: 'required', body: 'none', path: '/api/candidates/:candidateId' },
    candidatesList: { method: 'GET', session: 'required', body: 'none', path: '/api/companies/:companyId/candidates' },
    gateRead: { method: 'GET', session: 'required', body: 'none', path: '/api/gate' },
  };
  for (const [name, declaration] of Object.entries(expected)) assert.deepEqual(routes[name].route, declaration, name);
  /* A malformed route id answers 404 before anything is read, which is the uuid parameter doing its work. */
  const db = fakeDb();
  const original = globalThis.fetch;
  globalThis.fetch = db.fetchImpl;
  try {
    for (const [name, param] of [
      ['candidatesCreate', 'companyId'],
      ['candidatesSave', 'candidateId'],
      ['candidatesSubmit', 'candidateId'],
      ['candidatesSuccessor', 'candidateId'],
      ['candidatesRead', 'candidateId'],
      ['candidatesList', 'companyId'],
    ]) {
      const res = await routes[name](
        makeRequest({
          method: expected[name].method,
          params: { [param]: 'not-a-uuid' },
          headers: { cookie: `${COOKIES.access}=${userToken}` },
        }),
      );
      assert.equal(res.status, 404, name);
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(db.calls, []);
});

test('the route answers a gate refusal with the code, its fixed message and the problem list, and nothing of the document; the boundary logs it once (E3b critique F4)', async () => {
  const text = variant([[PROSE, `${PROSE}${CR}SYNTHETIC-PRIVATE-MARKER.`]]);
  const db = fakeDb();
  const original = globalThis.fetch;
  globalThis.fetch = db.fetchImpl;
  const logged = [];
  try {
    const routes = makeRoutes({ log: (e) => logged.push(e) });
    const res = await routes.candidatesCreate(
      makeRequest({
        method: 'POST',
        params: { companyId: COMPANY },
        headers: {
          cookie: `${COOKIES.access}=${userToken}`,
          'content-type': 'text/markdown',
          'idempotency-key': KEY,
          'x-agent-name': 'weekly-brief',
        },
        body: Buffer.from(text, 'utf8'),
      }),
    );
    assert.equal(res.status, 422);
    assert.deepEqual(JSON.parse(res.body), {
      ok: false,
      code: 'E_CANONICAL',
      message: messageFor('E_CANONICAL'),
      problems: [{ code: 'E_CANONICAL', line: lineOf(text, PROSE) }],
    });
    assert.deepEqual(Object.keys(JSON.parse(res.body)), ['ok', 'code', 'message', 'problems'], 'the body key order');
    assert.ok(!res.body.includes('SYNTHETIC-PRIVATE-MARKER'));
    assert.ok(!db.calls.some((c) => c.rpc));
    assert.equal(res.headers['cache-control'], 'private, no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.deepEqual(res.cookies, []);
    assert.deepEqual(logged, [{ event: 'refused', code: 'E_CANONICAL', status: 422 }], 'exactly one refused event');
    assert.ok(!JSON.stringify(logged).includes('SYNTHETIC-PRIVATE-MARKER'));

    /* Control: an E3 refusal without data answers the three keys and is logged the same way. */
    logged.length = 0;
    const plain = await routes.candidatesCreate(
      makeRequest({
        method: 'POST',
        params: { companyId: COMPANY },
        headers: { cookie: `${COOKIES.access}=${userToken}`, 'content-type': 'text/markdown', 'x-agent-name': 'weekly-brief' },
        body: Buffer.from(SYNTHETIC, 'utf8'),
      }),
    );
    assert.equal(plain.status, 422);
    assert.deepEqual(JSON.parse(plain.body), {
      ok: false,
      code: 'E_IDEMPOTENCY_KEY_INVALID',
      message: messageFor('E_IDEMPOTENCY_KEY_INVALID'),
    });
    assert.deepEqual(logged, [{ event: 'refused', code: 'E_IDEMPOTENCY_KEY_INVALID', status: 422 }]);
  } finally {
    globalThis.fetch = original;
  }
});

test('case 1 (unit half): hashes, derived bytes, a gate id and a validated time the client sends in headers or the query change nothing the service sends', async () => {
  const original = globalThis.fetch;
  const bodies = [];
  try {
    for (const forgedRun of [false, true]) {
      const db = fakeDb();
      globalThis.fetch = db.fetchImpl;
      const routes = makeRoutes({ log: () => {} });
      const forged = forgedRun
        ? {
            'x-content-sha256': 'a'.repeat(64),
            'x-derived-sha256': 'b'.repeat(64),
            'x-derived': '{"title":"forged"}',
            'x-gate-id': OLD_GATE_ID,
            'x-gate-identity-sha256': OTHER_IDENTITY,
            'x-validated-at': '2020-01-01T00:00:00.000Z',
          }
        : {};
      const res = await routes.candidatesCreate(
        makeRequest({
          method: 'POST',
          params: { companyId: COMPANY },
          query: forgedRun ? { contentSha256: 'a'.repeat(64), validatedAt: '2020-01-01T00:00:00.000Z' } : {},
          headers: {
            cookie: `${COOKIES.access}=${userToken}`,
            'content-type': 'text/markdown',
            'idempotency-key': KEY,
            'x-agent-name': 'weekly-brief',
            ...forged,
          },
          body: Buffer.from(SYNTHETIC, 'utf8'),
        }),
      );
      assert.equal(res.status, 201, res.body);
      const call = db.calls.find((c) => c.rpc);
      const derived = JSON.parse(call.body.p_derived_canonical);
      assert.notEqual(derived.validated_at, '2020-01-01T00:00:00.000Z');
      delete derived.validated_at;
      bodies.push({ ...call.body, p_derived_canonical: derived });
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(bodies[1], bodies[0]);
  assert.equal(bodies[0].p_gate_identity, `${X}${manifest.GATE_IDENTITY_SHA256}`);
});

test('row 10 order at the route (E3b critique F5): both headers absent or both malformed on save and submit answer 422 E_IDEMPOTENCY_KEY_INVALID with no request', async () => {
  const original = globalThis.fetch;
  const routes = makeRoutes({ log: () => {} });
  const cookie = `${COOKIES.access}=${userToken}`;
  try {
    for (const [label, bad] of [
      ['both absent', {}],
      ['both malformed', { 'idempotency-key': 'nope', 'if-match': 'W/"1"' }],
    ]) {
      const db = fakeDb({ tables: { candidate_versions: [{ id: CANDIDATE, content: SYNTHETIC }] } });
      globalThis.fetch = db.fetchImpl;
      const save = await routes.candidatesSave(
        makeRequest({
          method: 'PUT',
          params: { candidateId: CANDIDATE },
          headers: { cookie, 'content-type': 'text/markdown', ...bad },
          body: Buffer.from(SYNTHETIC, 'utf8'),
        }),
      );
      const submit = await routes.candidatesSubmit(
        makeRequest({
          method: 'POST',
          params: { candidateId: CANDIDATE },
          headers: { cookie, 'content-type': 'application/json', ...bad },
          body: JSON.stringify(SUBMISSION),
        }),
      );
      for (const [name, res] of [
        ['save', save],
        ['submit', submit],
      ])
        assert.deepEqual([res.status, JSON.parse(res.body).code], [422, 'E_IDEMPOTENCY_KEY_INVALID'], `${name}, ${label}`);
      assert.deepEqual(db.calls, [], label);
    }
  } finally {
    globalThis.fetch = original;
  }
});

/* E3b critique F1. The critic's legal maximum: 40 dependencies of 200 characters, 50 names of 120, 2,000 characters of
   permitted data. */
const WIDE = Object.freeze({
  ...SUBMISSION,
  permittedData: 'p'.repeat(2000),
  dependencies: Array.from({ length: 40 }, () => 'd'.repeat(200)),
  declaredContributors: Array.from({ length: 50 }, (_, i) => ({
    displayName: `${String(i).padStart(3, '0')}${'n'.repeat(117)}`,
  })),
});
/* Every field the service bounds at its limit, in a character JSON writes as six bytes (U+0001). This is the service's
   own rule at its widest encoding, not a claim about the routine; whitespace a client adds between tokens or around a
   trimmed name is bounded by no field rule and meets row 8 like any other byte. */
const ESCAPED = Object.freeze({
  sourcePlatform: cp(1).repeat(80),
  confidence: 'medium',
  permittedData: cp(1).repeat(2000),
  dependencies: Array.from({ length: 40 }, () => cp(1).repeat(200)),
  declaredContributors: Array.from({ length: 50 }, () => ({ displayName: cp(1).repeat(120) })),
});
/* A JSON object of exactly `bytes` bytes. */
const jsonOf = (bytes) => {
  const head = '{"permittedData":"';
  return `${head}${'p'.repeat(bytes - head.length - 2)}"}`;
};

test('E3b critique F1: submit reads JSON under 262,144 bytes at the pipeline and through the adapter; successor and an E2 JSON route keep 16,384', async () => {
  const original = globalThis.fetch;
  const routes = makeRoutes({ log: () => {} });
  const headers = (over = {}) => ({
    cookie: `${COOKIES.access}=${userToken}`,
    'content-type': 'application/json',
    'idempotency-key': KEY,
    'if-match': '1',
    ...over,
  });
  const viaPipeline = async (name, text, params, over) => {
    const res = await routes[name](makeRequest({ method: 'POST', params, headers: headers(over), body: text }));
    return { status: res.status, body: res.body };
  };
  const viaAdapter = async (name, text, params, over) => {
    const req = new Request(`https://enterprise.example.invalid${routes[name].route.path}`, {
      method: 'POST',
      headers: headers(over),
      body: text,
    });
    const res = await toNetlify(routes[name])(req, { params });
    return { status: res.status, body: await res.text() };
  };
  try {
    assert.equal(Buffer.byteLength(JSON.stringify(WIDE)), 17183, 'the critic’s figure');
    for (const [label, value] of [
      ['17,183 bytes of legal metadata', WIDE],
      ['every bounded field at its widest encoding', ESCAPED],
    ]) {
      const text = JSON.stringify(value);
      const size = Buffer.byteLength(text);
      assert.ok(size > 16384 && size <= 262144, `${label}: ${size} bytes`);
      for (const via of [viaPipeline, viaAdapter]) {
        const db = fakeDb({
          tables: { candidate_versions: [{ id: CANDIDATE, content: SYNTHETIC }] },
          rpc: () => answer({ state: 'submitted', version: 2, submitted_at: STORED_AT }, SYNTHETIC),
        });
        globalThis.fetch = db.fetchImpl;
        const r = await via('candidatesSubmit', text, { candidateId: CANDIDATE });
        assert.equal(r.status, 200, `${label}, ${via.name}: ${r.body}`);
        const sent = JSON.parse(db.calls.find((c) => c.rpc === 'submit_candidate').body.p_submission_canonical);
        assert.equal(sent.declared_contributors.length, 50, `${label}, ${via.name}`);
        assert.equal(sent.dependencies.length, 40, `${label}, ${via.name}`);
      }
    }

    /* The bound itself: 262,145 bytes are 413 before anything is read; 262,144 reach the service, which refuses the
       shape before anything is read. */
    for (const via of [viaPipeline, viaAdapter]) {
      const over = fakeDb();
      globalThis.fetch = over.fetchImpl;
      const r = await via('candidatesSubmit', jsonOf(262145), { candidateId: CANDIDATE });
      assert.deepEqual([r.status, JSON.parse(r.body).code], [413, 'E_BODY_TOO_LARGE'], via.name);
      assert.deepEqual(over.calls, [], via.name);
      const at = fakeDb();
      globalThis.fetch = at.fetchImpl;
      const s = await via('candidatesSubmit', jsonOf(262144), { candidateId: CANDIDATE });
      assert.deepEqual([s.status, JSON.parse(s.body).code], [422, 'E_BODY_INVALID'], `${via.name}: 262,144 is admitted`);
      assert.deepEqual(at.calls, [], via.name);
    }
    let reads = 0;
    const declared = await routes.candidatesSubmit(
      makeRequest({
        method: 'POST',
        params: { candidateId: CANDIDATE },
        headers: headers({ 'content-length': '262145' }),
        readBody: async () => {
          reads++;
          return JSON.stringify(WIDE);
        },
      }),
    );
    assert.deepEqual([declared.status, reads], [413, 0], 'a declared 262,145 is refused without a read');

    /* The counterexample for an implicit widening: successor and an E2 JSON route still answer 413 at 16,385. */
    for (const via of [viaPipeline, viaAdapter]) {
      for (const [name, params] of [
        ['candidatesSuccessor', { candidateId: CANDIDATE }],
        ['invitationsAccept', {}],
      ]) {
        const db = fakeDb();
        globalThis.fetch = db.fetchImpl;
        const r = await via(name, jsonOf(16385), params);
        assert.deepEqual([r.status, JSON.parse(r.body).code], [413, 'E_BODY_TOO_LARGE'], `${name}, ${via.name}`);
        const s = await via(name, jsonOf(16384), params);
        assert.notEqual(s.status, 413, `${name}, ${via.name}: 16,384 is within the E2 bound`);
      }
    }
  } finally {
    globalThis.fetch = original;
  }
});

/* E3B-RC-R2 (evidence/e3b-recheck.md, R2): a submission's text reaches the routine as the client wrote it. U+2028 is a
   line terminator an adapter could decode or normalise into a space, and an astral character is four UTF-8 bytes; both
   must arrive byte-identical in p_submission_canonical through the adapter the deployed function runs, and through the
   pipeline. The recheck's mutant replaced U+2028 with a space in the adapter's submission reader and passed 272 tests. */
test('E3B-RC-R2: U+2028 and an astral character in a submission reach submit_candidate byte-identical, through the adapter and the pipeline', async () => {
  const original = globalThis.fetch;
  const routes = makeRoutes({ log: () => {} });
  const LS = cp(0x2028);
  const ASTRAL = cp(0x1f600);
  const body = {
    ...SUBMISSION,
    permittedData: `First line${LS}second line ${ASTRAL}`,
    declaredContributors: [{ displayName: `Ada${LS}Lovelace ${ASTRAL}` }],
  };
  const text = JSON.stringify(body);
  const headers = {
    cookie: `${COOKIES.access}=${userToken}`,
    'content-type': 'application/json',
    'idempotency-key': KEY,
    'if-match': '1',
  };
  const viaAdapter = async () => {
    const req = new Request(`https://enterprise.example.invalid${routes.candidatesSubmit.route.path}`, {
      method: 'POST',
      headers,
      body: text,
    });
    return (await toNetlify(routes.candidatesSubmit)(req, { params: { candidateId: CANDIDATE } })).status;
  };
  const viaPipeline = async () =>
    (await routes.candidatesSubmit(makeRequest({ method: 'POST', params: { candidateId: CANDIDATE }, headers, body: text })))
      .status;
  const bytes = (s) => Buffer.from(s, 'utf8');
  try {
    for (const via of [viaAdapter, viaPipeline]) {
      const db = fakeDb({
        tables: { candidate_versions: [{ id: CANDIDATE, content: SYNTHETIC }] },
        rpc: () => answer({ state: 'submitted', version: 2, submitted_at: STORED_AT }, SYNTHETIC),
      });
      globalThis.fetch = db.fetchImpl;
      assert.equal(await via(), 200, via.name);
      const sent = db.calls.find((c) => c.rpc === 'submit_candidate').body.p_submission_canonical;
      const bound = JSON.parse(sent);
      assert.deepEqual(bytes(bound.permitted_data), bytes(body.permittedData), `${via.name}: permitted data`);
      assert.deepEqual(
        bytes(bound.declared_contributors[0].display_name),
        bytes(body.declaredContributors[0].displayName),
        `${via.name}: the declared name, whose inner U+2028 no trim removes`,
      );
      assert.ok(bytes(sent).includes(Buffer.from([0xe2, 0x80, 0xa8])), `${via.name}: U+2028 as its own three bytes`);
      assert.ok(bytes(sent).includes(Buffer.from([0xf0, 0x9f, 0x98, 0x80])), `${via.name}: the astral character as four`);
    }
  } finally {
    globalThis.fetch = original;
  }
});
