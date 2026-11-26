/* Pages construction, lib/auth/factors.mjs with a stubbed GoTrue (pages design 7.1, U5). The stub replaces the global
   fetch the module calls and records every request. The enrolment fixture is tests/e2/fixtures/retired-factor-enrolment.json:
   a QR captured byte-exact from a retired synthetic factor beside a synthetic secret and a secretless URI that are
   stated not to be the QR's own (2.4). The route half of U5 (the log lines) is in tests/e2/unit/pages-routes.test.mjs. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { hs256, userClaims } from '../helpers/jwt.mjs';

const SECRET = 'example-unit-secret-with-at-least-32-characters-long';
const BASE = 'http://127.0.0.1:54321';
process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = SECRET;

const { COOKIES, verifySession } = await import('../../../lib/session.mjs');
const { CODES } = await import('../../../lib/errors.mjs');
const factors = await import('../../../lib/auth/factors.mjs');
const { enrollTotp, GOTRUE_ERROR_CODES, listFactors, QR_CODE_MAX_BYTES, QR_PROLOGUE, removeFactor, verifyTotp } =
  factors;

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/retired-factor-enrolment.json', import.meta.url), 'utf8'));
const F = '6f1d2c3b-4a59-4e68-8d7c-0b1a2f3e4d5c';
const OTHER = '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const CHALLENGE = '8b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const TOKENS = { access_token: 'header.payload.signature', refresh_token: 'refresh-x', expires_in: 3600 };

async function session(sub = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11') {
  const token = hs256(userClaims({ sub, email: 's@example.invalid', issuer: `${BASE}/auth/v1`, aal: 'aal1' }), SECRET);
  return { token, session: (await verifySession({ headers: { cookie: `${COOKIES.access}=${token}` } })).session };
}

const reply = (status, json) =>
  json === undefined ? new Response(null, { status }) : new Response(JSON.stringify(json), { status });

/* handler({ method, path, body }) -> Response | Promise<Response>, or throws for a failed fetch. */
async function withGoTrue(handler, run) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    const call = {
      method: init.method,
      path: `${u.pathname}${u.search}`,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      authorization: init.headers.authorization,
      apikey: init.headers.apikey,
    };
    calls.push(call);
    return handler(call);
  };
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

test('U5 fixture: the committed enrolment fixture is what 2.4 says it is', () => {
  const qr = FIXTURE.answer.totp.qr_code;
  assert.ok(qr.startsWith(QR_PROLOGUE), 'the real serializer prologue');
  assert.equal(Buffer.byteLength(QR_PROLOGUE), 53);
  assert.ok(qr.endsWith('</svg>\n'));
  assert.equal(Buffer.byteLength(qr), FIXTURE.captured.qrCodeBytes);
  assert.ok(FIXTURE.captured.qrCodeBytes > 64 * 1024, 'above revision 1 s 64 KiB cap, which refused real answers');
  assert.doesNotMatch(FIXTURE.answer.totp.uri, /secret=/, 'the URI carries no secret parameter');
  assert.match(FIXTURE.about.join(' '), /NOT the values the QR encodes/);
});

test('U5 enrolment: the retired fixture passes the shape check through one POST /factors with a timestamped, suffixed name and no issuer', async () => {
  const { token, session: s } = await session();
  const { result, calls } = await withGoTrue(
    () => reply(200, FIXTURE.answer),
    () => enrollTotp(s),
  );
  assert.deepEqual(result, {
    ok: true,
    factorId: FIXTURE.answer.id,
    qrCodeSvg: FIXTURE.answer.totp.qr_code,
    uri: FIXTURE.answer.totp.uri,
    secret: FIXTURE.answer.totp.secret,
  });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/auth/v1/factors');
  assert.deepEqual(Object.keys(call.body).sort(), ['factor_type', 'friendly_name'], 'no issuer');
  assert.equal(call.body.factor_type, 'totp');
  assert.match(call.body.friendly_name, /^Authenticator app, \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC · [0-9a-f]{6}$/);
  assert.equal(call.authorization, `Bearer ${token}`, "the caller's own token");
  assert.equal(call.apikey, 'unit-anon-key', 'the anon key, never the service key');
});

test('U5 enrolment shape check: a bare <svg>, the size bound, a bad id, URI or secret each answer E_MFA_UNAVAILABLE; trailing whitespace is tolerated', async () => {
  const { session: s } = await session();
  const qr = FIXTURE.answer.totp.qr_code;
  const withTotp = (over) => ({ ...FIXTURE.answer, totp: { ...FIXTURE.answer.totp, ...over } });
  const enrol = async (answer) =>
    (
      await withGoTrue(
        () => reply(200, answer),
        () => enrollTotp(s),
      )
    ).result;
  const refused = [
    ['a stub beginning <svg without the prologue', withTotp({ qr_code: qr.slice(QR_PROLOGUE.length - 4) })],
    ['the prologue with a different generator comment', withTotp({ qr_code: qr.replace('SVGo', 'Other') })],
    ['no closing tag', withTotp({ qr_code: qr.replace('</svg>', '') })],
    ['text after the closing tag', withTotp({ qr_code: `${qr}x` })],
    ['one byte over the bound', withTotp({ qr_code: `${QR_PROLOGUE}${'x'.repeat(QR_CODE_MAX_BYTES - 58)}</svg>` })],
    ['a QR that is not a string', withTotp({ qr_code: 42 })],
    ['a URI of another scheme', withTotp({ uri: 'otpauth://hotp/x' })],
    ['a URI that is not a string', withTotp({ uri: null })],
    ['a lower-case secret', withTotp({ secret: 'aaaaaaaaaaaaaaaa' })],
    ['a 15-character secret', withTotp({ secret: 'AAAAAAAAAAAAAAA' })],
    ['a 129-character secret', withTotp({ secret: 'A'.repeat(129) })],
    ['a secret with a digit outside base32', withTotp({ secret: 'AAAAAAAAAAAAAAA1' })],
    ['an id that is not a uuid', { ...FIXTURE.answer, id: 'factor-1' }],
    ['no totp object', { id: FIXTURE.answer.id }],
    ['a body that is not JSON', undefined],
  ];
  for (const [label, answer] of refused) {
    const got =
      answer === undefined
        ? (
            await withGoTrue(
              () => new Response('<html>', { status: 200 }),
              () => enrollTotp(s),
            )
          ).result
        : await enrol(answer);
    assert.equal(got.code, 'E_MFA_UNAVAILABLE', label);
    assert.equal(got.ok, false, label);
  }
  const atBound = `${QR_PROLOGUE}${'x'.repeat(QR_CODE_MAX_BYTES - 59)}</svg>`;
  assert.equal(Buffer.byteLength(atBound), QR_CODE_MAX_BYTES);
  assert.equal((await enrol(withTotp({ qr_code: atBound }))).ok, true, 'exactly the bound is accepted');
  assert.equal((await enrol(withTotp({ qr_code: qr.trimEnd() }))).ok, true, 'no trailing newline');
  assert.equal((await enrol(withTotp({ qr_code: `${qr}\n  \t` }))).ok, true, 'more trailing whitespace');
  assert.equal((await enrol(withTotp({ secret: `${'A'.repeat(128)}==` }))).ok, true, '128 characters and padding');
  const huge = await withGoTrue(
    () => reply(200, withTotp({ qr_code: `${QR_PROLOGUE}${'x'.repeat(QR_CODE_MAX_BYTES + 70 * 1024)}</svg>` })),
    () => enrollTotp(s),
  );
  assert.equal(huge.result.code, 'E_MFA_UNAVAILABLE', 'an answer larger than the read bound is never held whole');
});

test('U5 enrolment deletes nothing: for a caller with unverified factors 200 and 400 seconds old and a verified one, the call list is one POST', async () => {
  const { session: s } = await session();
  const now = Date.now();
  const state = [
    { id: F, status: 'unverified', created_at: new Date(now - 200_000).toISOString() },
    { id: OTHER, status: 'unverified', created_at: new Date(now - 400_000).toISOString() },
    { id: CHALLENGE, status: 'verified', created_at: new Date(now - 900_000).toISOString() },
  ];
  const { result, calls } = await withGoTrue(
    ({ method, path }) =>
      method === 'GET' && path === '/auth/v1/user'
        ? reply(200, { id: 'u', factors: state.map((f) => ({ ...f, factor_type: 'totp', friendly_name: f.id })) })
        : reply(200, FIXTURE.answer),
    () => enrollTotp(s),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ['POST /auth/v1/factors'],
  );
});

test('U5 explicit removal: one DELETE per id the person was shown, none for a factor created after the list was rendered', async () => {
  const { session: s } = await session();
  const shown = [F, OTHER];
  const createdAfterRender = CHALLENGE;
  const { calls } = await withGoTrue(
    ({ path }) => reply(200, { id: path.split('/').pop() }),
    async () => {
      for (const id of shown) assert.deepEqual(await removeFactor(s, id), { ok: true });
    },
  );
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [`DELETE /auth/v1/factors/${F}`, `DELETE /auth/v1/factors/${OTHER}`],
  );
  assert.ok(!calls.some((c) => c.path.includes(createdAfterRender)));
});

/* The barrier-controlled read-verify-delete case (R-M1). A fake GoTrue holds every DELETE until a verification of the
   same factor has returned success, then applies it to the factor's state at that moment, so a DELETE issued on a
   stale read lands on a verified factor. The control shows the barrier catches the counterexample: revision 2's
   enrolment, which read the factor list and deleted unverified factors older than 300 seconds, destroys the verified
   factor. The module under test must issue no DELETE at all. */
function barrierGoTrue() {
  const factorsById = new Map([[F, { status: 'unverified', createdMsAgo: 400_000 }]]);
  let release;
  const verified = new Promise((r) => {
    release = r;
  });
  const deletes = [];
  const handler = async ({ method, path, body }) => {
    const id = path.split('/')[4];
    if (method === 'GET' && path === '/auth/v1/user')
      return reply(200, {
        factors: [...factorsById].map(([fid, f]) => ({
          id: fid,
          factor_type: 'totp',
          status: f.status,
          friendly_name: fid,
          created_at: new Date(Date.now() - f.createdMsAgo).toISOString(),
        })),
      });
    if (method === 'DELETE') {
      await verified;
      deletes.push({ id, statusAtDelete: factorsById.get(id)?.status ?? 'absent' });
      factorsById.delete(id);
      return reply(200, { id });
    }
    if (method === 'POST' && path.endsWith('/challenge'))
      return reply(200, { id: CHALLENGE, type: 'totp', expires_at: 1 });
    if (method === 'POST' && path.endsWith('/verify')) {
      assert.equal(body.challenge_id, CHALLENGE);
      factorsById.get(id).status = 'verified';
      setImmediate(release);
      return reply(200, TOKENS);
    }
    if (method === 'POST' && path === '/auth/v1/factors') return reply(200, FIXTURE.answer);
    return reply(404, { code: 404, error_code: 'not_found', msg: 'x' });
  };
  return { handler, deletes, factorsById };
}

async function revision2Enrol(s) {
  const r = await fetch(`${BASE}/auth/v1/user`, { method: 'GET', headers: { authorization: 'Bearer x' } });
  const { factors: listed } = await r.json();
  const cleanups = listed
    .filter((f) => f.status === 'unverified' && Date.now() - Date.parse(f.created_at) > 300_000)
    .map((f) => fetch(`${BASE}/auth/v1/factors/${f.id}`, { method: 'DELETE', headers: { authorization: 'Bearer x' } }));
  const created = await enrollTotp(s);
  await Promise.all(cleanups);
  return created;
}

test('U5 barrier-controlled case: a verification in another tab racing an enrolment leaves no DELETE from the enrolment and the factor verified', async () => {
  const { session: tabA } = await session();
  const { session: tabB } = await session();
  const fake = barrierGoTrue();
  const { result, calls } = await withGoTrue(fake.handler, async () => {
    const enrolment = enrollTotp(tabB);
    const verification = verifyTotp(tabA, F, '123456');
    return Promise.all([enrolment, verification]);
  });
  assert.equal(result[0].ok, true, 'the enrolment succeeded');
  assert.equal(result[1].ok, true, 'the other tab verified');
  assert.deepEqual(fake.deletes, [], 'no DELETE reached GoTrue');
  assert.ok(!calls.some((c) => c.method === 'DELETE'), 'the module under test issued no DELETE');
  assert.equal(fake.factorsById.get(F)?.status, 'verified', 'the just-verified factor survives');

  /* Control: the barrier does catch revision 2's read-then-delete. */
  const control = barrierGoTrue();
  await withGoTrue(control.handler, () => Promise.all([revision2Enrol(tabB), verifyTotp(tabA, F, '123456')]));
  assert.deepEqual(
    control.deletes,
    [{ id: F, statusAtDelete: 'verified' }],
    'the counterexample destroys a verified factor',
  );
});

test('U5 enrolment name conflict: exactly one retry with a different name, then E_MFA_UNAVAILABLE', async () => {
  const { session: s } = await session();
  const conflict = { code: 422, error_code: 'mfa_factor_name_conflict', msg: 'A factor with the friendly name exists' };
  const once = await withGoTrue(
    (() => {
      let n = 0;
      return () => (n++ === 0 ? reply(422, conflict) : reply(200, FIXTURE.answer));
    })(),
    () => enrollTotp(s),
  );
  assert.equal(once.result.ok, true);
  assert.equal(once.calls.length, 2);
  assert.notEqual(once.calls[0].body.friendly_name, once.calls[1].body.friendly_name, 'a fresh suffix');
  const twice = await withGoTrue(
    () => reply(422, conflict),
    () => enrollTotp(s),
  );
  assert.equal(twice.calls.length, 2, 'one retry, not more');
  assert.equal(twice.result.code, 'E_MFA_UNAVAILABLE');
  assert.equal(twice.result.gotrueErrorCode, 'mfa_factor_name_conflict');
});

test('U5 verification: a code that is not exactly six digits, or a malformed factor id, makes zero GoTrue calls', async () => {
  const { session: s } = await session();
  for (const code of [
    '12345',
    '1234567',
    ' 123456',
    '123456 ',
    '12345a',
    '123456\n',
    '１２３４５６',
    123456,
    ['123456'],
    null,
    undefined,
    {},
  ]) {
    const { result, calls } = await withGoTrue(
      () => reply(200, TOKENS),
      () => verifyTotp(s, F, code),
    );
    assert.equal(result.code, 'E_MFA_CODE_INVALID', JSON.stringify(code));
    assert.equal(calls.length, 0, JSON.stringify(code));
  }
  for (const id of ['not-a-uuid', '', `${F}/../x`, null]) {
    const { result, calls } = await withGoTrue(
      () => reply(200, TOKENS),
      () => verifyTotp(s, id, '123456'),
    );
    assert.equal(result.code, 'E_NOT_FOUND', String(id));
    assert.equal(calls.length, 0);
    assert.equal(
      (
        await withGoTrue(
          () => reply(200, {}),
          () => removeFactor(s, id),
        )
      ).calls.length,
      0,
    );
  }
});

test('U5 verification: challenge precedes verify with the same bearer, and the tokens come back for the cookies', async () => {
  const { token, session: s } = await session();
  const { result, calls } = await withGoTrue(
    ({ path }) =>
      path.endsWith('/challenge') ? reply(200, { id: CHALLENGE, type: 'totp', expires_at: 1 }) : reply(200, TOKENS),
    () => verifyTotp(s, F, '012345'),
  );
  assert.deepEqual(result, {
    ok: true,
    tokens: { accessToken: TOKENS.access_token, refreshToken: TOKENS.refresh_token, expiresIn: 3600 },
    /* HB-F2: what the route's bound records for this answer (lib/auth/factors.mjs's closed rule). */
    judged: 'valid',
  });
  assert.deepEqual(
    calls.map((c) => [c.method, c.path, c.body, c.authorization]),
    [
      ['POST', `/auth/v1/factors/${F}/challenge`, {}, `Bearer ${token}`],
      ['POST', `/auth/v1/factors/${F}/verify`, { challenge_id: CHALLENGE, code: '012345' }, `Bearer ${token}`],
    ],
  );
  const noRefresh = await withGoTrue(
    ({ path }) => (path.endsWith('/challenge') ? reply(200, { id: CHALLENGE }) : reply(200, { access_token: 'a.b.c' })),
    () => verifyTotp(s, F, '012345'),
  );
  assert.equal(noRefresh.result.code, 'E_MFA_UNAVAILABLE');
  const badChallenge = await withGoTrue(
    () => reply(200, { id: 'nope' }),
    () => verifyTotp(s, F, '012345'),
  );
  assert.equal(badChallenge.result.code, 'E_MFA_UNAVAILABLE');
  assert.equal(badChallenge.calls.length, 1, 'no verify without a well-formed challenge');
});

test('U5 mapping: every error_code target and every fallback is a key of CODES; the status-keyed rule on the verification path', async () => {
  for (const [errorCode, code] of Object.entries(GOTRUE_ERROR_CODES))
    assert.ok(Object.hasOwn(CODES, code), `${errorCode} -> ${code}`);
  assert.ok(Object.isFrozen(GOTRUE_ERROR_CODES));
  const { session: s } = await session();
  const verifyAnswering = (status, json) =>
    withGoTrue(
      ({ path }) => (path.endsWith('/challenge') ? reply(200, { id: CHALLENGE }) : reply(status, json)),
      () => verifyTotp(s, F, '123456'),
    );
  const seen = new Set();
  const expectVerify = async (status, json, code, label) => {
    const { result } = await verifyAnswering(status, json);
    assert.equal(result.code, code, label);
    seen.add(result.code);
  };
  await expectVerify(
    422,
    { code: 422, error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' },
    'E_MFA_CODE_INVALID',
    'wrong code',
  );
  await expectVerify(
    429,
    { code: 429, msg: 'Too many attempts. Try again after 2026-09-14T10:12:03Z.' },
    'E_RATE_LIMITED',
    'a 429 with no error_code',
  );
  await expectVerify(
    429,
    { code: 429, error_code: 'unknown', msg: 'Too many attempts. Try again after 2026-09-14T10:12:03Z.' },
    'E_RATE_LIMITED',
    'the hook refusal as GoTrue v2.192.0 writes it, error_code unknown',
  );
  for (const status of [400, 403, 422, 500, 502, 503])
    await expectVerify(
      status,
      { code: status, msg: 'hook failed' },
      'E_MFA_UNAVAILABLE',
      `${status} with no error_code`,
    );
  await expectVerify(
    404,
    { code: 404, error_code: 'mfa_factor_not_found', msg: 'Factor not found' },
    'E_NOT_FOUND',
    'another user s factor',
  );
  await expectVerify(
    400,
    { code: 400, error_code: 'mfa_ip_address_mismatch', msg: 'x' },
    'E_MFA_UNAVAILABLE',
    'address mismatch',
  );
  await expectVerify(
    422,
    { code: 422, error_code: 'mfa_challenge_expired', msg: 'x' },
    'E_MFA_UNAVAILABLE',
    'challenge expired',
  );
  await expectVerify(
    422,
    { code: 422, error_code: 'mfa_totp_verify_not_enabled', msg: 'x' },
    'E_MFA_NOT_ENABLED',
    'verify disabled',
  );
  await expectVerify(
    429,
    { code: 429, error_code: 'over_request_rate_limit', msg: 'x' },
    'E_RATE_LIMITED',
    'rate limit',
  );
  await expectVerify(
    403,
    { code: 403, error_code: 'session_not_found', msg: 'x' },
    'E_UNAUTHENTICATED',
    'session ended',
  );
  const challengeRefused = await withGoTrue(
    () => reply(404, { code: 404, error_code: 'mfa_factor_not_found', msg: 'Factor not found' }),
    () => verifyTotp(s, F, '123456'),
  );
  assert.equal(challengeRefused.result.code, 'E_NOT_FOUND');
  assert.equal(challengeRefused.calls.length, 1, 'no verify after a refused challenge');

  /* Off the verification path: an unknown 4xx with a recognised shape is E_INTERNAL, a 5xx or a thrown fetch
     E_MFA_UNAVAILABLE, for each of the other three calls. */
  const unknown4xx = { code: 400, error_code: 'validation_failed', msg: 'x' };
  const paths = [
    ['list', () => listFactors(s)],
    ['enrol', () => enrollTotp(s)],
    ['remove', () => removeFactor(s, F)],
  ];
  for (const [label, run] of paths) {
    const internal = await withGoTrue(() => reply(400, unknown4xx), run);
    assert.equal(internal.result.code, 'E_INTERNAL', `${label}: unknown 4xx`);
    assert.equal(
      internal.result.gotrueErrorCode,
      'unknown',
      `${label}: a code the table does not name is the fixed word`,
    );
    seen.add(internal.result.code);
    assert.equal(
      (await withGoTrue(() => reply(503, { code: 503, msg: 'x' }), run)).result.code,
      'E_MFA_UNAVAILABLE',
      `${label}: 5xx`,
    );
    const thrown = await withGoTrue(() => {
      throw new TypeError('fetch failed');
    }, run);
    assert.equal(thrown.result.code, 'E_MFA_UNAVAILABLE', `${label}: thrown fetch`);
    assert.equal(thrown.result.gotrueStatus, null);
  }
  const thrownVerify = await withGoTrue(
    () => {
      throw new TypeError('fetch failed');
    },
    () => verifyTotp(s, F, '123456'),
  );
  assert.equal(thrownVerify.result.code, 'E_MFA_UNAVAILABLE');
  const enrolDisabled = await withGoTrue(
    () => reply(422, { code: 422, error_code: 'mfa_totp_enroll_not_enabled', msg: 'x' }),
    () => enrollTotp(s),
  );
  assert.equal(enrolDisabled.result.code, 'E_MFA_NOT_ENABLED');
  const limit = await withGoTrue(
    () => reply(422, { code: 422, error_code: 'too_many_enrolled_mfa_factors', msg: 'x' }),
    () => enrollTotp(s),
  );
  assert.equal(limit.result.code, 'E_MFA_FACTOR_LIMIT');
  const stepUp = await withGoTrue(
    () => reply(422, { code: 422, error_code: 'insufficient_aal', msg: 'x' }),
    () => removeFactor(s, F),
  );
  assert.equal(stepUp.result.code, 'E_MFA_STEP_UP_REQUIRED');
  const prototypeName = await withGoTrue(
    () => reply(400, { code: 400, error_code: 'constructor', msg: 'x' }),
    () => removeFactor(s, F),
  );
  assert.equal(prototypeName.result.code, 'E_INTERNAL', 'an inherited name is not a table entry');
  for (const code of seen) assert.ok(Object.hasOwn(CODES, code), code);
  const noisy = await withGoTrue(
    () => reply(400, { code: 400, error_code: 'Has Spaces And A Secret JBSWY3DP', msg: 'x' }),
    () => removeFactor(s, F),
  );
  assert.equal(noisy.result.gotrueErrorCode, 'unknown', 'a string outside the table is the fixed word, never copied');
  /* E7M-C-F5: a well-shaped token that is not a key of the table used to reach the log line as itself (the
     critique's synthetic_tenant_private, through the real list route). Fail-before: the shape-only rule of
     7e68c6d copies it; the table rule answers `unknown`. Absent string: null. */
  const shaped = await withGoTrue(
    () => reply(422, { code: 422, error_code: 'synthetic_tenant_private_zz', msg: 'x' }),
    () => listFactors(s),
  );
  assert.equal(shaped.result.gotrueErrorCode, 'unknown', 'E7M-C-F5: a shaped foreign code is not copied');
  assert.equal(JSON.stringify(shaped.result).includes('synthetic_tenant_private'), false);
  const absent = await withGoTrue(
    () => reply(400, { code: 400, msg: 'x' }),
    () => listFactors(s),
  );
  assert.equal(absent.result.gotrueErrorCode, null, 'no string, no word');
});

test('U5 list: GET /user, totp factors only, verified and unverified; no factors key is an empty list; a malformed factor is E_MFA_UNAVAILABLE', async () => {
  const { token, session: s } = await session();
  const user = {
    id: 'u',
    factors: [
      { id: F.toUpperCase(), factor_type: 'totp', status: 'verified', friendly_name: 'A', created_at: 't1', phone: '' },
      { id: OTHER, factor_type: 'totp', status: 'unverified', friendly_name: 'B', created_at: 't2' },
      { id: CHALLENGE, factor_type: 'phone', status: 'verified', friendly_name: 'C', created_at: 't3' },
    ],
  };
  const { result, calls } = await withGoTrue(
    () => reply(200, user),
    () => listFactors(s),
  );
  assert.deepEqual(
    calls.map((c) => [c.method, c.path, c.authorization]),
    [['GET', '/auth/v1/user', `Bearer ${token}`]],
  );
  assert.deepEqual(result, {
    ok: true,
    factors: [
      { factorId: F, type: 'totp', status: 'verified', friendlyName: 'A', createdAt: 't1' },
      { factorId: OTHER, type: 'totp', status: 'unverified', friendlyName: 'B', createdAt: 't2' },
    ],
  });
  assert.deepEqual(
    (
      await withGoTrue(
        () => reply(200, { id: 'u' }),
        () => listFactors(s),
      )
    ).result,
    { ok: true, factors: [] },
  );
  for (const bad of [
    { factors: 'x' },
    { factors: [{ id: 'nope', factor_type: 'totp', status: 'verified', friendly_name: 'A', created_at: 't' }] },
    { factors: [{ id: F, factor_type: 'totp', status: 'weird', friendly_name: 'A', created_at: 't' }] },
  ])
    assert.equal(
      (
        await withGoTrue(
          () => reply(200, bad),
          () => listFactors(s),
        )
      ).result.code,
      'E_MFA_UNAVAILABLE',
    );
  const ended = await withGoTrue(
    () =>
      reply(403, {
        code: 403,
        error_code: 'session_not_found',
        msg: 'Session from session_id claim in JWT does not exist',
      }),
    () => listFactors(s),
  );
  assert.equal(ended.result.code, 'E_UNAUTHENTICATED');
});

test('U5 removal: one DELETE of the named factor; 200 is ok; a refusal carries only codes, never the id or a body', async () => {
  const { session: s } = await session();
  const { result, calls } = await withGoTrue(
    () => reply(200, { id: F }),
    () => removeFactor(s, F),
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    calls.map((c) => [c.method, c.path, c.body]),
    [['DELETE', `/auth/v1/factors/${F}`, undefined]],
  );
  const notFound = await withGoTrue(
    () => reply(404, { code: 404, error_code: 'mfa_factor_not_found', msg: 'Factor not found' }),
    () => removeFactor(s, F),
  );
  assert.deepEqual(notFound.result, {
    ok: false,
    code: 'E_NOT_FOUND',
    gotrueStatus: 404,
    gotrueErrorCode: 'mfa_factor_not_found',
  });
});
