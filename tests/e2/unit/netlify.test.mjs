/* lib/http/netlify.mjs, M3 of the E2 implementation critique, through the exported toNetlify
   wrapper: the maintenance switch is checked before anything is read from the web Request; a
   route declared body: 'none' never reads the body; a JSON route reads at most MAX_BODY_BYTES + 1
   bytes and answers 413; a failing stream is a controlled response, never a rejection. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hs256, userClaims } from '../helpers/jwt.mjs';

const SECRET = 'example-unit-secret-with-at-least-32-characters-long';
const BASE = 'http://127.0.0.1:54321';
process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = SECRET;
process.env.ENTERPRISE_ACCESS_STATE = 'open';

const { COOKIES } = await import('../../../lib/session.mjs');
const { MAX_BODY_BYTES } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { toNetlify } = await import('../../../lib/http/netlify.mjs');

const SUB = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11';
const cookie = () =>
  `${COOKIES.access}=${hs256(userClaims({ sub: SUB, email: 's@example.invalid', issuer: `${BASE}/auth/v1` }), SECRET)}`;
const routes = makeRoutes({ log: () => {} });

/* A counted stream of `chunks` chunks of `size` bytes; pulls records how many were handed out.
   highWaterMark 0: the stream pulls only when a reader asks, so a pull is an actual read and
   not the eager fill a default stream performs at construction. */
function countedStream(chunks, size = 1024) {
  const stats = { pulls: 0, cancelled: false };
  const stream = new ReadableStream(
    {
      pull(controller) {
        if (stats.pulls >= chunks) {
          controller.close();
          return;
        }
        stats.pulls++;
        controller.enqueue(new Uint8Array(size).fill(0x61));
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, stats };
}
function failingStream() {
  const stats = { pulls: 0 };
  const stream = new ReadableStream(
    {
      pull(controller) {
        stats.pulls++;
        if (stats.pulls === 1) controller.enqueue(new Uint8Array([0x7b]));
        else controller.error(new Error('synthetic-body-read-failure'));
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, stats };
}
const webRequest = (path, stream, headers = {}) =>
  new Request(`https://enterprise.example.invalid${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie(), ...headers },
    body: stream,
    duplex: 'half',
  });
const bodyOf = async (res) => (res.status === 204 ? null : await res.json());

test('M3: a closed switch answers 503 through the adapter without pulling a single chunk of a 1 MiB body', async () => {
  process.env.ENTERPRISE_ACCESS_STATE = 'closed_restore';
  try {
    for (const [name, fn] of [
      ['authSignout', toNetlify(routes.authSignout)],
      ['invitationsAccept', toNetlify(routes.invitationsAccept)],
    ]) {
      const { stream, stats } = countedStream(1024, 1024);
      const res = await fn(webRequest('/api/x', stream), {});
      assert.equal(res.status, 503, name);
      assert.deepEqual((await bodyOf(res)).code, 'E_MAINTENANCE', name);
      assert.equal(stats.pulls, 0, `${name}: chunks pulled while closed`);
    }
  } finally {
    process.env.ENTERPRISE_ACCESS_STATE = 'open';
  }
});

test('M3: sign-out (body: none) never reads the body and still clears both cookies', async () => {
  const { stream, stats } = countedStream(64, 1024);
  const res = await toNetlify(routes.authSignout)(webRequest('/api/auth/signout', stream, { cookie: '' }), {});
  assert.equal(res.status, 204);
  assert.equal(stats.pulls, 0, 'chunks pulled for a body: none route');
  const set = res.headers.getSetCookie();
  assert.equal(set.length, 2);
  for (const c of set) assert.match(c, /Max-Age=0/);
});

test('M3: a failing body stream is a controlled response with the private headers, not a rejection', async () => {
  const { stream } = failingStream();
  let res;
  try {
    res = await toNetlify(routes.invitationsAccept)(webRequest('/api/invitations/accept', stream), {});
  } catch (e) {
    assert.fail(`the adapter rejected: ${e?.message}`);
  }
  assert.equal(res.status, 422);
  assert.deepEqual(await bodyOf(res), { ok: false, code: 'E_BODY_INVALID', message: 'The request is not valid.' });
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
});

test('M3: an unsized body over the limit is 413 and the read stops at MAX_BODY_BYTES + 1', async () => {
  const chunks = 4 * MAX_BODY_BYTES; /* 64 MiB on offer at 1 KiB per chunk */
  const { stream, stats } = countedStream(chunks, 1024);
  const req = webRequest('/api/invitations/accept', stream);
  assert.equal(req.headers.get('content-length'), null, 'the request is unsized');
  const res = await toNetlify(routes.invitationsAccept)(req, {});
  assert.equal(res.status, 413);
  assert.deepEqual((await bodyOf(res)).code, 'E_BODY_TOO_LARGE');
  assert.ok(stats.pulls * 1024 <= MAX_BODY_BYTES + 1 + 1024, `pulled ${stats.pulls} KiB chunks`);
  assert.ok(stats.pulls < chunks, 'the stream was not consumed to the end');
});

/* M3-R1 (evidence/e2-implementation-critique-2.md): the bound is on the bytes kept and copied, not only on
   the pulls. At 5b2c4b4 one 8 MiB chunk was kept whole and Buffer.concat copied all 8,388,608 bytes before
   the MAX_BODY_BYTES + 1 subarray was taken. Buffer.concat is wrapped without changing its result, and the
   byte lengths it is given and returns are recorded while the adapter runs. The instrument assumes the
   adapter copies through Buffer.concat; if that changes, the call-count assertion fails rather than letting
   this test pass without observing anything. */
test('M3-R1: a single 8 MiB chunk on an unsized stream is cut to MAX_BODY_BYTES + 1 before it is kept or copied', async (t) => {
  const bound = MAX_BODY_BYTES + 1;
  const { stream, stats } = countedStream(1, 8 * 1024 * 1024);
  const req = webRequest('/api/invitations/accept', stream);
  assert.equal(req.headers.get('content-length'), null, 'the request is unsized');
  const concat = Buffer.concat;
  const copies = [];
  Buffer.concat = function recordedConcat(list, totalLength) {
    const result = concat.call(this, list, totalLength);
    copies.push({ given: list.reduce((n, b) => n + b.byteLength, 0), returned: result.byteLength });
    return result;
  };
  let res;
  try {
    res = await toNetlify(routes.invitationsAccept)(req, {});
  } finally {
    Buffer.concat = concat;
  }
  t.diagnostic(`Buffer.concat calls: ${JSON.stringify(copies)}; pulls ${stats.pulls}; cancelled ${stats.cancelled}`);
  assert.equal(res.status, 413);
  assert.deepEqual((await bodyOf(res)).code, 'E_BODY_TOO_LARGE');
  assert.equal(stats.pulls, 1);
  assert.equal(stats.cancelled, true);
  assert.ok(copies.length >= 1, 'no Buffer.concat call observed: the instrument no longer sees the copy');
  assert.deepEqual(
    copies.filter((c) => c.given > bound || c.returned > bound),
    [],
    `bytes given to or returned by Buffer.concat above ${bound}: ${JSON.stringify(copies)}`,
  );
  assert.equal(Math.max(...copies.map((c) => c.returned)), bound, 'the kept body is exactly the bound');
});

/* HTTP-D1 (evidence/http-d1.md): on a JSON route too, every refusal before the body read is answered with no
   chunk pulled, and a stream that would fail does not turn it into 422. At 725447e the adapter read up to
   MAX_BODY_BYTES + 1 before the pipeline ran, so each case pulled 17 chunks and each failing stream was 422. The
   415 is step 6's first check, which also comes before the read. */
test('HTTP-D1: on a JSON route, method, cross-site, session, route-id and media-type refusals pull nothing', async () => {
  const COMPANY = '2a5d1b3c-4e6f-4a8b-9c0d-1e2f3a4b5c6d';
  const accept = toNetlify(routes.invitationsAccept);
  const roles = toNetlify(routes.membersSetRoles);
  const offered = (method, stream, headers) =>
    new Request('https://enterprise.example.invalid/api/x', {
      method,
      headers: { 'content-type': 'application/json', cookie: cookie(), ...headers },
      body: stream,
      duplex: 'half',
    });
  const cases = [
    ['method', accept, 'PUT', {}, {}, 405, 'E_METHOD_NOT_ALLOWED'],
    ['cross-site', accept, 'POST', { 'sec-fetch-site': 'cross-site' }, {}, 403, 'E_CROSS_SITE'],
    ['no session cookie', accept, 'POST', { cookie: '' }, {}, 401, 'E_UNAUTHENTICATED'],
    ['malformed route id', roles, 'PATCH', {}, { companyId: COMPANY, membershipId: 'not-a-uuid' }, 404, 'E_NOT_FOUND'],
    ['media type', accept, 'POST', { 'content-type': 'text/plain' }, {}, 415, 'E_UNSUPPORTED_MEDIA_TYPE'],
  ];
  for (const [label, fn, method, headers, params, status, code] of cases) {
    const counted = countedStream(20, 1024);
    const res = await fn(offered(method, counted.stream, headers), { params });
    assert.deepEqual([res.status, (await bodyOf(res)).code], [status, code], label);
    assert.equal(counted.stats.pulls, 0, `${label}: chunks pulled before the refusal`);
    const failing = failingStream();
    const again = await fn(offered(method, failing.stream, headers), { params });
    assert.deepEqual([again.status, (await bodyOf(again)).code], [status, code], `${label}, failing stream`);
    assert.equal(failing.stats.pulls, 0, `${label}, failing stream: chunks pulled before the refusal`);
  }
});

test('M3 control: a sized body under the limit reaches the route through the adapter', async () => {
  const res = await toNetlify(routes.authStart)(
    new Request('https://enterprise.example.invalid/api/auth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email":""}',
    }),
    {},
  );
  assert.equal(res.status, 422);
  assert.deepEqual((await bodyOf(res)).code, 'E_EMAIL_INVALID');
});
