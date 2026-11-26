/* lib/http/pipeline.mjs, M4 of the E2 implementation critique: a session verification that cannot
   complete (thrown JWKS fetch, non-2xx JWKS response, malformed JWKS body) is a controlled 503
   E_SESSION_UNAVAILABLE through the route entry point, logged without exception text, and sign-out
   still clears both cookies. Own file: the JWKS cache must be cold for every shape, and the
   default JWKS source is the global fetch, replaced here. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { es256, userClaims } from '../helpers/jwt.mjs';

const BASE = 'http://127.0.0.1:54321';
process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = 'example-unit-secret-with-at-least-32-characters-long';
process.env.ENTERPRISE_ACCESS_STATE = 'open';

const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');

const SUB = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11';
const COMPANY = '2a5d1b3c-4e6f-4a8b-9c0d-1e2f3a4b5c6d';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const token = es256(userClaims({ sub: SUB, email: 'e@example.invalid', issuer: `${BASE}/auth/v1` }), pem, 'k-unknown');
const seen = [];
/* E7 design 1.5, day 6: the alert sink as a capture beside the log capture, so every case in this file can say what
   the boundary raised as well as what it logged, and the module's own alert() is never reached from here. */
const raised = [];
const routes = makeRoutes({
  log: (e) => seen.push(e),
  alert: async (event, fields) => {
    raised.push({ event, fields });
  },
});
const request = (method, path, body) =>
  makeRequest({
    method,
    path,
    params: { companyId: COMPANY, membershipId: COMPANY },
    headers: { cookie: `${COOKIES.access}=${token}`, 'content-type': 'application/json' },
    body,
  });
const parse = (r) => (r.body === null ? null : JSON.parse(r.body));

const SHAPES = {
  'thrown fetch': async () => {
    throw new Error('synthetic-jwks-outage-private-detail');
  },
  'non-2xx response': async () => ({
    ok: false,
    status: 502,
    json: async () => ({ msg: 'synthetic-gateway-private-detail' }),
  }),
  'malformed body': async () => ({ ok: true, status: 200, json: async () => 'synthetic-not-a-jwks-private-detail' }),
  'unparseable body': async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('synthetic-parse-private-detail');
    },
  }),
};

const realFetch = globalThis.fetch;
async function withFetch(impl, fn) {
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

for (const [label, impl] of Object.entries(SHAPES)) {
  test(`M4: ${label} at the JWKS is 503 E_SESSION_UNAVAILABLE on a protected route, logged without exception text`, async () => {
    seen.length = 0;
    raised.length = 0;
    let res;
    try {
      res = await withFetch(impl, () => routes.membersSetRoles(request('PATCH', '/api/x', '{"roles":["member"]}')));
    } catch (e) {
      assert.fail(`the route rejected: ${e?.message}`);
    }
    assert.equal(res.status, 503, JSON.stringify(res));
    assert.deepEqual(parse(res).code, 'E_SESSION_UNAVAILABLE');
    assert.equal(res.headers['cache-control'], 'private, no-store');
    assert.ok(seen.length >= 1, 'one log entry');
    assert.ok(!JSON.stringify(seen).includes('private-detail'), JSON.stringify(seen));
    assert.equal(seen[0].event, 'session_unavailable', JSON.stringify(seen));
    /* E7 design 1.5 and case E7-22, the fifth event's call site (the lead's grant of 2026-09-20). A verifier outage
       is the one fault that takes every signed-in page down, and it RETURNS 503 rather than throwing, so the
       boundary's catch never sees it and the alert is raised at this log site instead. One alert, the allowlisted
       fields, and no exception text in it. Fails before: at 6af5d48 the pipeline logged the line and raised nothing,
       so `raised` was empty for every shape. */
    assert.equal(raised.length, 1, `one alert: ${JSON.stringify(raised)}`);
    assert.deepEqual(raised[0], {
      event: 'session_unavailable',
      fields: { route: 'membersSetRoles', code: 'E_SESSION_UNAVAILABLE', status: 503 },
    });
    assert.ok(!JSON.stringify(raised).includes('private-detail'), JSON.stringify(raised));
  });

  test(`M4: ${label} at the JWKS still lets sign-out clear both cookies`, async () => {
    seen.length = 0;
    raised.length = 0;
    let res;
    try {
      res = await withFetch(impl, () => routes.authSignout(request('POST', '/api/auth/signout', null)));
    } catch (e) {
      assert.fail(`sign-out rejected: ${e?.message}`);
    }
    assert.equal(res.status, 204, JSON.stringify(res));
    assert.equal(res.cookies.length, 2);
    for (const c of res.cookies) assert.match(c, /Max-Age=0/);
    assert.ok(!JSON.stringify(seen).includes('private-detail'), JSON.stringify(seen));
  });
}

/* HTTP-D1 (evidence/http-d1.md): through the adapter, the 503 of an unloadable JWKS is answered before any chunk of
   the body is pulled. At 725447e the adapter kept MAX_BODY_BYTES + 1 first, 17 chunks of 1 KiB. It sits before the
   control below on purpose: the control warms the JWKS cache, after which a kid miss is 401, not 503. */
test('HTTP-D1: through the adapter, an unloadable JWKS is 503 E_SESSION_UNAVAILABLE with no chunk pulled', async () => {
  const { toNetlify } = await import('../../../lib/http/netlify.mjs');
  const stats = { pulls: 0 };
  const stream = new ReadableStream(
    {
      pull(controller) {
        if (stats.pulls >= 64) return controller.close();
        stats.pulls++;
        controller.enqueue(new Uint8Array(1024).fill(0x61));
      },
    },
    { highWaterMark: 0 },
  );
  const req = new Request(`https://enterprise.example.invalid/api/companies/${COMPANY}/members/${COMPANY}/roles`, {
    method: 'PATCH',
    headers: { cookie: `${COOKIES.access}=${token}`, 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  });
  seen.length = 0;
  const res = await withFetch(SHAPES['thrown fetch'], () =>
    toNetlify(routes.membersSetRoles)(req, { params: { companyId: COMPANY, membershipId: COMPANY } }),
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'E_SESSION_UNAVAILABLE');
  assert.equal(stats.pulls, 0, 'chunks pulled before the 503');
});

test('M4 control: an unknown kid with a reachable JWKS is 401 E_UNAUTHENTICATED, not 503', async () => {
  seen.length = 0;
  raised.length = 0;
  const res = await withFetch(
    async () => ({ ok: true, status: 200, json: async () => ({ keys: [] }) }),
    () => routes.membersSetRoles(request('PATCH', '/api/x', '{"roles":["member"]}')),
  );
  assert.equal(res.status, 401);
  assert.deepEqual(seen, [{ event: 'session_refused', code: 'E_SESSION_INVALID' }]);
  assert.deepEqual(raised, [], 'E7-22: a refused session is the product working and alerts nothing');
});
