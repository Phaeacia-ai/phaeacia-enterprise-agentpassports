/* lib/session.mjs: verifySession (design section 6, test-plan case 19 at the unit level) and the
   VerifiedSession brand (case 20's precondition: only this module constructs one). */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { es256, hs256, userClaims } from '../helpers/jwt.mjs';

const SECRET = 'example-unit-secret-with-at-least-32-characters-long';
const URL = 'http://127.0.0.1:54321';
const ISS = `${URL}/auth/v1`;
process.env.SUPABASE_URL = URL;
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = SECRET;

const { COOKIES, accessTokenOf, isVerifiedSession, sessionCookies, signOut, startSignIn, verifySession } = await import(
  '../../../lib/session.mjs'
);

const SUB = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11';
const req = (cookie) => ({ method: 'POST', headers: cookie === undefined ? {} : { cookie } });
const withToken = (t) => req(`${COOKIES.access}=${t}; other=1`);
const mint = (over = {}) =>
  hs256(userClaims({ sub: SUB, email: 'synthetic@example.invalid', issuer: ISS, ...over }), SECRET);

test('no cookie, empty cookie and a cookie for another name are E_NO_SESSION', async () => {
  for (const r of [req(undefined), req(''), req('other=1'), req(`${COOKIES.refresh}=abc`)]) {
    const v = await verifySession(r);
    assert.deepEqual(v, { ok: false, code: 'E_NO_SESSION' });
  }
});

test('an expired token is E_SESSION_EXPIRED', async () => {
  const now = Math.floor(Date.now() / 1000);
  const v = await verifySession(withToken(mint({ now: now - 7200, ttl: 3600 })));
  assert.deepEqual(v, { ok: false, code: 'E_SESSION_EXPIRED' });
});

test('a tampered or foreign token is E_SESSION_INVALID', async () => {
  const good = mint();
  const [h, p] = good.split('.');
  const cases = {
    'wrong signature': `${h}.${p}.${'A'.repeat(43)}`,
    'other secret': hs256(userClaims({ sub: SUB, email: 'x@example.invalid', issuer: ISS }), `${SECRET}x`),
    'claims changed after signing': `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), aal: 'aal2' })).toString('base64url')}.${good.split('.')[2]}`,
    'alg none': `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`,
    'wrong aud': mint({ extra: { aud: 'anon' } }),
    'wrong iss': mint({ issuer: 'https://evil.example.invalid/auth/v1' }),
    'role not authenticated': mint({ extra: { role: 'app_server' } }),
    'role service_role': mint({ extra: { role: 'service_role' } }),
    'anonymous user': mint({ extra: { is_anonymous: true } }),
    'sub not a uuid': mint({ sub: 'not-a-uuid' }),
    'not a jwt': 'abc',
    'two segments': `${h}.${p}`,
    'garbage segments': 'a.b.c',
  };
  for (const [label, token] of Object.entries(cases)) {
    const v = await verifySession(withToken(token));
    assert.deepEqual(v, { ok: false, code: 'E_SESSION_INVALID' }, label);
  }
});

test('a valid HS256 token yields a frozen VerifiedSession with the listed fields only', async () => {
  const token = mint({ aal: 'aal2', extra: { amr: [{ method: 'totp', timestamp: 1 }] } });
  const v = await verifySession(withToken(token));
  assert.equal(v.ok, true);
  const s = v.session;
  assert.ok(Object.isFrozen(s));
  assert.deepEqual(
    Object.keys(s).sort(),
    ['aal', 'amr', 'authUserId', 'email', 'emailConfirmed', 'expiresAt', 'sessionId'].sort(),
  );
  assert.equal(s.authUserId, SUB);
  assert.equal(s.aal, 'aal2');
  assert.deepEqual(s.amr, ['totp']);
  assert.equal(s.email, 'synthetic@example.invalid');
  assert.equal(s.sessionId, '11111111-2222-4333-8444-555555555555');
  assert.equal(typeof s.expiresAt, 'number');
  assert.equal(isVerifiedSession(s), true);
  assert.equal(accessTokenOf(s), token);
  assert.ok(!JSON.stringify(s).includes(token.slice(0, 20)), 'the token is not a property of the session');
});

test('aal is aal1 when the claim is absent, and user_metadata and app_metadata are not surfaced', async () => {
  const v = await verifySession(withToken(mint({ extra: { user_metadata: { aal: 'aal2', role: 'company_admin' } } })));
  assert.equal(v.ok, true);
  assert.equal(v.session.aal, 'aal1');
  assert.equal('user_metadata' in v.session, false);
  assert.equal('app_metadata' in v.session, false);
});

test('a lookalike object, a copy, a proxy or a subclass is not a VerifiedSession', async () => {
  const v = await verifySession(withToken(mint({ aal: 'aal2' })));
  const s = v.session;
  const lookalike = Object.freeze({ ...s });
  const proxied = new Proxy(s, {});
  const created = Object.freeze(Object.create(s));
  for (const x of [lookalike, proxied, created, { authUserId: SUB, aal: 'aal2' }, null, undefined, 'string']) {
    assert.equal(isVerifiedSession(x), false);
    assert.throws(() => accessTokenOf(x), /not a VerifiedSession/);
  }
  assert.throws(() => {
    s.aal = 'aal2';
  }, TypeError);
});

test('ES256 tokens verify through the JWKS, with one refetch on a kid miss', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'ES256' };
  const fetches = [];
  const fetchJwks = async () => {
    fetches.push(1);
    return { keys: fetches.length === 1 ? [] : [jwk] };
  };
  const token = es256(userClaims({ sub: SUB, email: 'e@example.invalid', issuer: ISS, aal: 'aal2' }), pem, 'k1');
  const v = await verifySession(withToken(token), { fetchJwks });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.session.aal, 'aal2');
  assert.equal(fetches.length, 2, 'first fetch had no key for kid k1; one refetch');
  const bad = es256(userClaims({ sub: SUB, email: 'e@example.invalid', issuer: ISS }), pem, 'k9');
  const v2 = await verifySession(withToken(bad), { fetchJwks: async () => ({ keys: [jwk] }) });
  assert.deepEqual(v2, { ok: false, code: 'E_SESSION_INVALID' });
  /* Algorithm confusion: an HS256 token signed with the public key material must not verify. */
  const confused = hs256(userClaims({ sub: SUB, email: 'e@example.invalid', issuer: ISS }), jwk.x, {
    alg: 'HS256',
    typ: 'JWT',
    kid: 'k1',
  });
  const v3 = await verifySession(withToken(confused), { fetchJwks: async () => ({ keys: [jwk] }) });
  assert.deepEqual(v3, { ok: false, code: 'E_SESSION_INVALID' });
});

test('session cookies are HttpOnly, Secure, SameSite=Strict, path-scoped; clearing expires both', () => {
  const set = sessionCookies({ accessToken: 'a.b.c', refreshToken: 'r1', expiresIn: 3600 });
  assert.equal(set.length, 2);
  for (const c of set) {
    assert.match(c, /; HttpOnly/);
    assert.match(c, /; Secure/);
    assert.match(c, /; SameSite=Strict/);
    assert.match(c, /; Path=\//);
  }
  assert.match(set[0], new RegExp(`^${COOKIES.access}=a\\.b\\.c; `));
  assert.match(set[0], /; Max-Age=3600/);
  assert.match(set[1], new RegExp(`^${COOKIES.refresh}=r1; `));
  const cleared = sessionCookies(null);
  assert.equal(cleared.length, 2);
  for (const c of cleared) assert.match(c, /; Max-Age=0/);
});

test('L2: a present nbf that is not a number is E_SESSION_INVALID; a numeric future nbf too; a past one passes', async () => {
  const now = Math.floor(Date.now() / 1000);
  const stringFuture = await verifySession(withToken(mint({ extra: { nbf: String(now + 3600) } })));
  assert.deepEqual(stringFuture, { ok: false, code: 'E_SESSION_INVALID' }, 'string future nbf');
  const nullNbf = await verifySession(withToken(mint({ extra: { nbf: null } })));
  assert.deepEqual(nullNbf, { ok: false, code: 'E_SESSION_INVALID' }, 'null nbf');
  const numericFuture = await verifySession(withToken(mint({ extra: { nbf: now + 3600 } })));
  assert.deepEqual(numericFuture, { ok: false, code: 'E_SESSION_INVALID' }, 'numeric future nbf');
  const past = await verifySession(withToken(mint({ extra: { nbf: now - 60 } })));
  assert.equal(past.ok, true, 'numeric past nbf');
});

/* Q10 (Raffael, 2026-09-13; pages design 2.5): sign-out ends this device only. GoTrue is stubbed at
   the global fetch that lib/session.mjs calls, so the request it sends is the thing asserted. */
test('Q10: signOut asks GoTrue to end this session only, scope=local, with the session own bearer', async () => {
  const token = mint();
  const { session } = await verifySession(withToken(token));
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  };
  let result;
  try {
    result = await signOut(session);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1, 'one provider call');
  const sent = new globalThis.URL(calls[0].url);
  assert.equal(`${sent.origin}${sent.pathname}`, `${URL}/auth/v1/logout`);
  assert.deepEqual([...sent.searchParams], [['scope', 'local']], 'this session only: never global, others or absent');
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(calls[0].init.headers.authorization === `Bearer ${token}`, 'the bearer is the signed-out session token');
});

/* K3 (evidence/hardening-k.md; XR-3): GoTrue's 429 on /otp was answered 204 and seen by nobody. startSignIn still
   resolves { ok: true } for every answer, and says `limited` only for a 429, which is what the route logs and alerts. */
test('K3: startSignIn is ok for every GoTrue answer and limited only for a 429', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  try {
    for (const [status, body, limited] of [
      [200, {}, false],
      [422, { code: 422, error_code: 'otp_disabled', msg: 'Signups not allowed for otp' }, false],
      [429, { code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }, true],
      [429, { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' }, true],
      [500, null, false],
    ]) {
      globalThis.fetch = async (url, init) => {
        seen.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(body === null ? 'not json' : JSON.stringify(body), { status });
      };
      assert.deepEqual(await startSignIn('synthetic@example.invalid'), { ok: true, limited }, `GoTrue ${status}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(seen.every((c) => c.url === `${URL}/auth/v1/otp` && c.body.create_user === false));
});
