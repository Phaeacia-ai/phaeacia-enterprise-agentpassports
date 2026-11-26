/* HB-F2: the route's bound on wrong second-factor codes, without a stack (migration 012; lib/services/factor-bound.mjs;
   design evidence/ena7-end1-hbf2.md sections 3 and 5; evidence/hosted-blockers.md 5.1, the route halves of Q1-1, Q1-6
   and Q1-7). GoTrue and the Data API are one stub at the global fetch, which records every call. The SQL half (the
   count, the window, the reservations) runs against the migrations on the local stack and, here, on PGlite
   (evidence/ena7-end1-hbf2-repro/). FAIL-BEFORE on main: the route made no begin or end call at all. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { hs256, userClaims } from '../helpers/jwt.mjs';

const SECRET = 'example-unit-secret-with-at-least-32-characters-long';
const BASE = 'http://127.0.0.1:54321';
process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = SECRET;
process.env.ENTERPRISE_ACCESS_STATE = 'open';
process.env.ENTERPRISE_ORIGIN = 'https://enterprise.example.invalid';

const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { END_BOUND_MS, endVerification } = await import('../../../lib/services/factor-bound.mjs');

const SUB = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11';
const FACTOR = '6f1d2c3b-4a59-4e68-8d7c-0b1a2f3e4d5c';
const CHALLENGE = '8b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const ATTEMPT = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const REPO = new URL('../../../', import.meta.url);

const token = (aal = 'aal1') =>
  hs256(userClaims({ sub: SUB, email: 'v@example.invalid', issuer: `${BASE}/auth/v1`, aal }), SECRET);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

/* gotrue(path) answers the challenge and verify calls; begin and end answer the two routines. */
async function verify({
  code = '123456',
  challenge = () => json({ id: CHALLENGE, type: 'totp' }),
  verified = () => json({ access_token: token('aal2'), refresh_token: 'r-9', expires_in: 1800 }),
  begin = () => json([{ allowed: true, retry_after: null, attempt_id: ATTEMPT }]),
  end = () => new Response('null'),
} = {}) {
  const calls = [];
  const logs = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ path: u.pathname, body });
    if (u.pathname === '/rest/v1/rpc/mfa_verify_begin') return begin();
    if (u.pathname === '/rest/v1/rpc/mfa_verify_end') return end();
    if (u.pathname.endsWith('/challenge')) return challenge();
    if (u.pathname.endsWith('/verify')) return verified();
    return json({}, 404);
  };
  try {
    const routes = makeRoutes({ log: (e) => logs.push(e) });
    const handler = routes.factorsVerify;
    const result = await handler(
      makeRequest({
        method: 'POST',
        path: handler.route.path,
        params: { factorId: FACTOR },
        headers: { cookie: `${COOKIES.access}=${token()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      }),
    );
    const parsed = result.body === null ? null : JSON.parse(result.body);
    const ends = calls.filter((c) => c.path === '/rest/v1/rpc/mfa_verify_end').map((c) => c.body);
    const gotrue = calls.filter((c) => c.path.startsWith('/auth/v1/')).map((c) => c.path.split('/').pop());
    return { result, parsed, calls, logs, ends, gotrue };
  } finally {
    globalThis.fetch = original;
  }
}

test('HB-F2: an allowed attempt is begun before GoTrue and ended after it with what GoTrue judged', async () => {
  const ok = await verify();
  assert.equal(ok.result.status, 204);
  assert.deepEqual(
    ok.calls.map((c) => c.path.split('/').pop()),
    ['mfa_verify_begin', 'challenge', 'verify', 'mfa_verify_end'],
    'begin, then GoTrue, then end',
  );
  assert.deepEqual(ok.ends, [{ p_attempt: ATTEMPT, p_outcome: 'valid' }]);
  assert.deepEqual(ok.calls[0].body, {}, 'begin names no user: the actor is the server token s subject');
});

test('Q1-1, the route: an exhausted account is refused 429 with the window s end, and GoTrue is never called', async () => {
  const r = await verify({
    begin: () => json([{ allowed: false, retry_after: '2026-10-24T10:15:00+00:00', attempt_id: null }]),
  });
  assert.equal(r.result.status, 429);
  assert.equal(r.parsed.code, 'E_MFA_ATTEMPTS_EXHAUSTED');
  assert.equal(r.parsed.retryAfter, '2026-10-24T10:15:00.000Z');
  assert.deepEqual(r.gotrue, [], 'not one GoTrue call, so a correct sixth code cannot win');
  assert.deepEqual(r.ends, [], 'and nothing to settle');
});

test('Q1-7, the route: a database that does not answer begin is 503, and GoTrue is never called (fail-closed)', async () => {
  for (const begin of [() => json({ message: 'down' }, 503), () => json([]), () => json([{ allowed: true }])]) {
    const r = await verify({ begin });
    assert.equal(r.result.status, 503);
    assert.equal(r.parsed.code, 'E_MFA_UNAVAILABLE');
    assert.deepEqual(r.gotrue, []);
  }
});

test('HB-F2: a malformed code spends nothing: no begin, no GoTrue, the refusal as before', async () => {
  const r = await verify({ code: '12345' });
  assert.equal(r.result.status, 422);
  assert.equal(r.parsed.code, 'E_MFA_CODE_INVALID');
  assert.deepEqual(r.calls, []);
  assert.equal(r.logs[0].event, 'gotrue_refused', 'the same line the route wrote before the bound');
});

/* The closed rule of D8 (HB-C1): undecided only before the verify request and for a verify answer GoTrue gives before
   it checks the code; every other verify-stage answer counts, so no judged guess is ever refunded. */
test('HB-C1: each GoTrue answer settles the attempt by the closed rule', async () => {
  const cases = [
    [
      'a wrong code',
      { verified: () => json({ error_code: 'mfa_verification_failed', msg: 'x' }, 422) },
      'invalid',
      422,
    ],
    [
      'a verify 429 (per address, before the code)',
      { verified: () => json({ error_code: 'over_request_rate_limit' }, 429) },
      'undecided',
      429,
    ],
    ['an expired challenge', { verified: () => json({ error_code: 'mfa_challenge_expired' }, 422) }, 'undecided', 503],
    ['an address mismatch', { verified: () => json({ error_code: 'mfa_ip_address_mismatch' }, 422) }, 'undecided', 503],
    ['a verify 500 (may follow a judged code)', { verified: () => json({ msg: 'x' }, 500) }, 'invalid', 503],
    ['a verify 502 from a proxy', { verified: () => new Response('bad gateway', { status: 502 }) }, 'invalid', 503],
    [
      'a 422 with an unknown error code',
      { verified: () => json({ error_code: 'something_new' }, 422) },
      'invalid',
      503,
    ],
    ['a 2xx without tokens', { verified: () => json({}) }, 'invalid', 503],
    ['a failed challenge', { challenge: () => json({ msg: 'x' }, 503) }, 'undecided', 503],
    ['a challenge 429', { challenge: () => json({}, 429) }, 'undecided', 429],
  ];
  for (const [label, stubs, outcome, status] of cases) {
    const r = await verify(stubs);
    assert.deepEqual(r.ends, [{ p_attempt: ATTEMPT, p_outcome: outcome }], label);
    assert.equal(r.result.status, status, `${label}: the answer is the one the route gave before the bound`);
  }
  const lost = await verify({
    verified: () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.deepEqual(lost.ends, [{ p_attempt: ATTEMPT, p_outcome: 'invalid' }], 'a lost verify answer counts');
});

test('HB-C7: an end that fails or hangs is logged and never changes the answer, and the answer waits at most the bound', async () => {
  const failed = await verify({ end: () => json({ message: 'x' }, 500) });
  assert.equal(failed.result.status, 204);
  assert.deepEqual(failed.logs, [{ event: 'mfa_bound_unsettled' }]);
  const started = Date.now();
  const hung = await verify({ end: () => new Promise(() => {}) });
  const waited = Date.now() - started;
  assert.equal(hung.result.status, 204, 'the aal2 cookies still go out');
  assert.ok(waited >= END_BOUND_MS - 50 && waited < END_BOUND_MS + 1500, `${waited} ms`);
  assert.deepEqual(hung.logs, [{ event: 'mfa_bound_unsettled' }]);
});

/* HBF2-R-I1: callAs mints its token synchronously, so a throw there (a session the minting refuses, or a missing
   signing secret) came out of endVerification as a rejection, which in the route is a 500 after GoTrue issued aal2
   tokens. FAIL-BEFORE at 717815d: the call rejects with serverToken's TypeError. */
test('HBF2-R-I1: an end whose token cannot be minted answers { ok: false } and never throws', async () => {
  const started = Date.now();
  assert.deepEqual(await endVerification({}, ATTEMPT, 'valid'), { ok: false });
  assert.ok(Date.now() - started < END_BOUND_MS, 'at once, not at the bound');
});

/* HB-C8: the route's bound and 004's hook are one rule written twice, on purpose (the hook bounds every path when the
   Team plan installs it; the route bounds the route without it). The two copies must not drift. */
test('HB-C8: 012 s begin and 004 s hook carry the same budget and the same window', () => {
  const read = (f) => readFileSync(new URL(`supabase/migrations/${f}`, REPO), 'utf8');
  const of = (text, fn) => {
    const at = text.indexOf(`create or replace function ${fn}(`);
    assert.ok(at >= 0, fn);
    const body = text.slice(at, text.indexOf('end $$;', at));
    return {
      budget: /budget constant integer := (\d+);/.exec(body)?.[1],
      window: /window_length constant interval := interval '([^']+)';/.exec(body)?.[1],
    };
  };
  const hook = of(read('004_content_rules_and_profiles.sql'), 'app.hook_mfa_verification_attempt');
  const route = of(read('012_mfa_route_bound.sql'), 'api.mfa_verify_begin');
  assert.deepEqual(hook, { budget: '5', window: '15 minutes' });
  assert.deepEqual(route, hook);
});
