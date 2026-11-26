/* lib/session.mjs, H1 of the E2 implementation critique: a cached signing key is trusted for at
   most JWKS_MAX_AGE, after which the JWKS is refetched before the key is used, and a refetch that
   fails while the cache is stale refuses the token instead of trusting the stale key or throwing.
   Own file so the module-level JWKS cache starts empty in this process. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { es256, userClaims } from '../helpers/jwt.mjs';

const URL = 'http://127.0.0.1:54321';
const ISS = `${URL}/auth/v1`;
process.env.SUPABASE_URL = URL;
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';

const { COOKIES, JWKS_MAX_AGE_SECONDS, verifySession } = await import('../../../lib/session.mjs');

const SUB = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11';
const withToken = (t) => ({ method: 'POST', headers: { cookie: `${COOKIES.access}=${t}` } });

test('H1: a key removed from the JWKS is accepted inside the cache age and refused after it; a failing refetch refuses', async () => {
  /* The bound is read from the module; 600 s stands in when the export is missing so the
     substantive assertions below still run against the counterexample. */
  const MAX = typeof JWKS_MAX_AGE_SECONDS === 'number' ? JWKS_MAX_AGE_SECONDS : 600;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'ES256' };
  let keys = [jwk];
  let fetches = 0;
  let fail = false;
  const fetchJwks = async () => {
    fetches++;
    if (fail) throw new Error('synthetic-jwks-outage-private-detail');
    return { keys };
  };
  const t0 = Math.floor(Date.now() / 1000);
  const mint = (now) =>
    es256(userClaims({ sub: SUB, email: 'e@example.invalid', issuer: ISS, now, aal: 'aal2' }), pem, 'k1');

  /* Cold start: one fetch, the key is trusted. */
  const first = await verifySession(withToken(mint(t0)), { now: t0, fetchJwks });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(fetches, 1);

  /* The key disappears from the source. Inside the bound the cached key is still used, without a fetch. */
  keys = [];
  const inside = t0 + MAX - 1;
  const second = await verifySession(withToken(mint(inside)), { now: inside, fetchJwks });
  assert.equal(second.ok, true, `inside the bound: ${JSON.stringify(second)}`);
  assert.equal(fetches, 1, 'no fetch inside the bound');

  /* Past the bound the JWKS is refetched before the key is trusted; the removed key is refused. */
  const after = t0 + MAX + 1;
  const third = await verifySession(withToken(mint(after)), { now: after, fetchJwks });
  assert.deepEqual(third, { ok: false, code: 'E_SESSION_INVALID' });
  assert.equal(fetches, 2, 'exactly one refetch after the bound');

  /* The key returns; a fresh cache trusts it again. */
  keys = [jwk];
  const back = after + MAX + 1;
  const fourth = await verifySession(withToken(mint(back)), { now: back, fetchJwks });
  assert.equal(fourth.ok, true, JSON.stringify(fourth));
  assert.equal(fetches, 3);

  /* Stale cache and a failing refetch: fail closed with the invalid code, never an exception,
     and never the stale key. */
  fail = true;
  const outage = back + MAX + 1;
  let outcome;
  try {
    outcome = await verifySession(withToken(mint(outage)), { now: outage, fetchJwks });
  } catch (e) {
    assert.fail(`verifySession threw: ${e?.message}`);
  }
  assert.deepEqual(outcome, { ok: false, code: 'E_SESSION_INVALID' });
  assert.equal(fetches, 4);
  assert.equal(typeof JWKS_MAX_AGE_SECONDS, 'number', 'the bound is exported and named');
  assert.ok(JWKS_MAX_AGE_SECONDS >= 300 && JWKS_MAX_AGE_SECONDS <= 900, 'between 5 and 15 minutes');
});

test('H1: the once-per-minute miss throttle is kept next to the age bound', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k2', use: 'sig', alg: 'ES256' };
  let fetches = 0;
  const fetchJwks = async () => {
    fetches++;
    return { keys: [jwk] };
  };
  const now = Math.floor(Date.now() / 1000) + 10 * (JWKS_MAX_AGE_SECONDS ?? 600);
  const unknown = (kid) => es256(userClaims({ sub: SUB, email: 'e@example.invalid', issuer: ISS, now }), pem, kid);
  /* Stale from the previous test: the first call refetches (k2 appears), the kid is unknown anyway. */
  const a = await verifySession(withToken(unknown('k9')), { now, fetchJwks });
  assert.deepEqual(a, { ok: false, code: 'E_SESSION_INVALID' });
  const afterA = fetches;
  const b = await verifySession(withToken(unknown('k8')), { now: now + 30, fetchJwks });
  assert.deepEqual(b, { ok: false, code: 'E_SESSION_INVALID' });
  assert.equal(fetches, afterA, 'a second miss within a minute does not refetch');
  const c = await verifySession(withToken(unknown('k7')), { now: now + 61, fetchJwks });
  assert.deepEqual(c, { ok: false, code: 'E_SESSION_INVALID' });
  assert.equal(fetches, afterA + 1, 'a miss after a minute refetches once');
});
