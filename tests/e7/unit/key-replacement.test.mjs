/* E7 design 1.3 restore step 6, 1.4 D15, section 5 case E7-31 (E7D-C-F4): AT A RECOVERY THE SERVER'S SIGNING KEY
   IS REPLACED, NEVER RE-IMPORTED.

   The first version of the design's step 6 imported "the server's signing key" into the target, and that keeps
   every server bearer minted before the incident valid there. This file observes both halves of that in one run:
   the bearer the product's own `serverToken` minted under pair A is ACCEPTED by a target holding A re-imported,
   which is the counterexample, and REFUSED by a target holding a newly generated pair B, which is the correction.
   Nothing here is about ES256 being better than HS256: ES256 is the path on which a key can be replaced at all
   (the hosted legacy secret cannot be rotated, 1.3), and it is not the replacement.

   THE LOCAL LIMIT THIS CONTROL STANDS IN FOR. `tests/e7/stack/restore.test.mjs` records as an observation that
   after the local rehearsal's lift every stale server bearer still verifies, because the local stack signs with
   HS256 and its secret cannot be rotated. This file is the evidence that a replaced key refuses what a re-imported
   one admits; that an old bearer is refused at a real target is the hosted rehearsal's (H-R, H-K1), not this one's.

   FAIL-BEFORE (section 5's list names E7-31). `E7_31_REPLACEMENT=reimport` makes step 6 re-import pair A instead
   of generating pair B, which is the first version's step, and the refusal assertions below then fail. The gate
   never sets it; evidence/e7-restore-repro/ holds the failing run and the passing one.

   No stack, no network, no provider: every key is generated in this process and no key material is printed. */
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { test } from 'node:test';

import { keySetFindings } from '../fixtures/key-set.mjs';
import { hs256, userClaims } from '../../e2/helpers/jwt.mjs';

const SECRET = 'example-unit-secret-with-at-least-32-characters-long';
const BASE = 'http://127.0.0.1:54321';
process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = SECRET;

const { COOKIES, verifySession } = await import('../../../lib/session.mjs');
const { serverToken } = await import('../../../lib/db/server.mjs');

const SUB = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11';

/** One ES256 pair, as the operator's machine generates one at step 6. `kid` is the id the target publishes. */
function pair(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    kid,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey,
  };
}

/** A verified session, the only thing `serverToken` will mint from (lib/session.mjs's WeakSet brand). */
async function session(aal = 'aal2') {
  const token = hs256(userClaims({ sub: SUB, email: 'synthetic@example.invalid', issuer: `${BASE}/auth/v1`, aal }), SECRET);
  const v = await verifySession({ headers: { cookie: `${COOKIES.access}=${token}` } });
  assert.equal(v.ok, true);
  return v.session;
}

/** A server bearer signed by `key`, minted by the product's own `serverToken` and not by a copy of it. */
async function bearerUnder(key) {
  const before = {
    alg: process.env.ENTERPRISE_SERVER_SIGNING_ALG,
    key: process.env.ENTERPRISE_SERVER_SIGNING_KEY,
    kid: process.env.ENTERPRISE_SERVER_SIGNING_KID,
  };
  process.env.ENTERPRISE_SERVER_SIGNING_ALG = 'ES256';
  process.env.ENTERPRISE_SERVER_SIGNING_KEY = key.privatePem;
  process.env.ENTERPRISE_SERVER_SIGNING_KID = key.kid;
  try {
    return serverToken(await session());
  } finally {
    for (const [name, value] of [
      ['ENTERPRISE_SERVER_SIGNING_ALG', before.alg],
      ['ENTERPRISE_SERVER_SIGNING_KEY', before.key],
      ['ENTERPRISE_SERVER_SIGNING_KID', before.kid],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * What a target does with a bearer: check its signature against a verification key it holds. The KID is not
 * consulted, deliberately: a refusal that came only from an unknown kid would prove nothing about the signature,
 * and the whole question here is whether the old SIGNATURE still verifies. The kid half is D15's, below.
 */
function signatureVerifies(bearer, publicKey) {
  const [h, p, sig] = bearer.split('.');
  return cryptoVerify(
    'sha256',
    Buffer.from(`${h}.${p}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(sig, 'base64url'),
  );
}

const headerOf = (bearer) => JSON.parse(Buffer.from(bearer.split('.')[0], 'base64url'));

/**
 * Restore step 6, as the runbook runs it: what the operator puts at the target as the server's verification key.
 * Correct, and the default: a NEWLY GENERATED pair. The mutant, which the gate never selects: pair A re-imported,
 * which is the first version's step and the counterexample E7D-C-F4 named.
 */
function stepSix(sourceKey) {
  if (process.env.E7_31_REPLACEMENT === 'reimport')
    return { kid: sourceKey.kid, publicKey: createPublicKey(createPrivateKey(sourceKey.privatePem)), reimported: true };
  const generated = pair('server-target-b');
  return { kid: generated.kid, publicKey: generated.publicKey, privatePem: generated.privatePem, reimported: false };
}

// ---------------------------------------------------------------------------
// E7-31: the signature half.
// ---------------------------------------------------------------------------

test('E7-31: the old bearer is ACCEPTED by A re-imported (the counterexample) and REFUSED by the replacement', async () => {
  const A = pair('server-source-a');
  const stale = await bearerUnder(A);
  assert.equal(headerOf(stale).alg, 'ES256');
  assert.equal(headerOf(stale).kid, A.kid, 'the bearer carries the source key’s id');

  /* The counterexample, observed rather than argued: importing the SOURCE's own signing key at the target is
     exactly what makes a bearer minted before the incident verify after it. Neither ending sessions nor a
     restore consumes it, so this is the door E7D-C-F4 closed. */
  const reimportedA = createPublicKey(createPrivateKey(A.privatePem));
  assert.equal(signatureVerifies(stale, reimportedA), true, 'THE FIRST VERSION’S STEP 6 ADMITS THE STALE BEARER');

  /* And the correction, in the same run: the target holds a key the source never had. This assertion is the
     INTENDED CHECK, and it is the first thing said about the replacement, so the re-import mutant fails HERE and
     not at a guard about which mode ran. */
  const replacement = stepSix(A);
  assert.equal(
    signatureVerifies(stale, replacement.publicKey),
    false,
    'THE STALE BEARER IS REFUSED UNDER THE REPLACEMENT (a re-imported source key admits it)',
  );
  assert.equal(replacement.reimported, false, 'and the default step 6 generated a new pair');

  /* The control, so a refusal cannot be read as a broken key: the replacement signs and verifies its own. */
  const fresh = await bearerUnder({ kid: replacement.kid, privatePem: replacement.privatePem });
  assert.equal(signatureVerifies(fresh, replacement.publicKey), true, 'a bearer minted after the replacement verifies');
  assert.equal(signatureVerifies(fresh, reimportedA), false, 'and does not verify under the retired key');
  assert.notEqual(replacement.kid, A.kid, 'the replacement has its own key id, so the register’s key.replace line has two');
});

test('E7-31: a re-import is not a rotation: the same pair re-imported from PEM verifies just as it did', async () => {
  /* Named because "we imported the key freshly at the target" is the sentence the first version rested on: a
     round trip through PKCS#8 and SPKI changes nothing about which signatures verify. */
  const A = pair('server-source-a2');
  const stale = await bearerUnder(A);
  const viaPrivate = createPublicKey(createPrivateKey(A.privatePem));
  const viaSpki = createPublicKey(A.publicKey.export({ type: 'spki', format: 'pem' }));
  const viaJwk = createPublicKey({ key: A.publicKey.export({ format: 'jwk' }), format: 'jwk' });
  for (const [how, key] of [['the private key', viaPrivate], ['SPKI', viaSpki], ['a JWK', viaJwk]])
    assert.equal(signatureVerifies(stale, key), true, `re-imported through ${how}, the stale bearer still verifies`);
});

// ---------------------------------------------------------------------------
// E7-31: D15's key-set half. The predicate is tests/e7/fixtures/key-set.mjs, for day 6 to wire.
// ---------------------------------------------------------------------------

test('E7-31: D15 fails a fixture key set that still lists the retired key id, and passes the replaced one', () => {
  const A = pair('server-source-a3');
  const B = stepSix(A);
  const hosted = { alg: 'ES256', kid: B.kid, retiredKids: [A.kid], hosted: true };

  /* The control first, and it is this case's INTENDED CHECK for the mutant: after a real replacement the target
     publishes a key id that is NOT the retired one, so D15 is clean. A re-import leaves the two the same id, and
     D15's third condition then reports the very key the file names. */
  assert.deepEqual(
    keySetFindings({ ...hosted, publishedKids: [B.kid, 'auth-key-1'] }),
    [],
    'after step 6 the published key id is not the retired one',
  );

  /* The fixture key set that still lists A's key id: one finding, naming the rule and the variable. */
  const stillListed = keySetFindings({ ...hosted, publishedKids: [B.kid, A.kid, 'auth-key-1'] });
  assert.equal(stillListed.length, 1, JSON.stringify(stillListed));
  assert.match(stillListed[0].rule, /retired key id is absent/);
  assert.equal(stillListed[0].variable, '--retired-kid[0]');

  /* The other two conditions, one case each. */
  assert.deepEqual(
    keySetFindings({ ...hosted, alg: 'HS256', publishedKids: [B.kid] }).map((f) => f.variable),
    ['ENTERPRISE_SERVER_SIGNING_ALG'],
    'a hosted file on the legacy secret, which cannot be rotated, is a finding on its own',
  );
  assert.deepEqual(
    keySetFindings({ ...hosted, publishedKids: ['auth-key-1'] }).map((f) => f.variable),
    ['ENTERPRISE_SERVER_SIGNING_KID'],
    'a server key id the target does not publish',
  );
  assert.deepEqual(
    keySetFindings({ ...hosted, kid: undefined, publishedKids: ['auth-key-1'] }).map((f) => f.variable),
    ['ENTERPRISE_SERVER_SIGNING_KID'],
    'and an absent one',
  );
  /* The local file is not hosted: HS256 with no key id is what the local stack is, and it is not a finding. */
  assert.deepEqual(keySetFindings({ alg: 'HS256', publishedKids: [], hosted: false }), []);
});

test('E7-31: D15 echoes no value it read', () => {
  const A = pair('server-source-a4');
  const B = pair('server-target-b4');
  const findings = keySetFindings({
    alg: 'HS256',
    kid: B.kid,
    retiredKids: [A.kid],
    publishedKids: [A.kid, 'auth-key-1'],
  });
  assert.equal(findings.length, 3, JSON.stringify(findings));
  const printed = JSON.stringify(findings);
  for (const value of ['HS256', A.kid, B.kid, 'auth-key-1'])
    assert.equal(printed.includes(value), false, `the output carries ${value}`);
});
