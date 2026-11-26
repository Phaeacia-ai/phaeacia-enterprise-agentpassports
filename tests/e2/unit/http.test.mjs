/* lib/http: cases 23 (malformed bodies) and 24 (maintenance switch before session verification)
   at the handler without a stack; response headers; the Netlify adapter conversion. */
import assert from 'node:assert/strict';
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
const { AppError, messageFor } = await import('../../../lib/errors.mjs');
const { BodyReadError, makeRequest, readJsonBody, MAX_BODY_BYTES } = await import('../../../lib/http/request.mjs');
const { route } = await import('../../../lib/http/pipeline.mjs');
const { error, json, noContent } = await import('../../../lib/http/response.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { fromWebRequest, toNetlify, toWebResponse } = await import('../../../lib/http/netlify.mjs');

const SUB = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11';
const COMPANY = '2a5d1b3c-4e6f-4a8b-9c0d-1e2f3a4b5c6d';
const validToken = () => hs256(userClaims({ sub: SUB, email: 's@example.invalid', issuer: `${BASE}/auth/v1` }), SECRET);
const cookie = (t) => `${COOKIES.access}=${t}`;
const quiet = { log: () => {} };
const body = (r) => (r.body === null ? null : JSON.parse(r.body));

/* A protected echo route: everything the pipeline does, then the parsed body back. */
const echo = route(
  {
    method: 'POST',
    path: '/api/companies/:companyId/echo',
    uuidParams: ['companyId'],
    handle: async ({ session, params, body }) => json(200, { sub: session.authUserId, params, body }),
  },
  quiet,
);
const post = ({ headers, body, ...over } = {}) =>
  makeRequest({
    method: 'POST',
    path: '/api/x',
    params: { companyId: COMPANY },
    headers: { cookie: cookie(validToken()), 'content-type': 'application/json', ...headers },
    body: body === undefined ? '{"email":"A@Example.com"}' : body,
    ...over,
  });

test('case 23: non-JSON, wrong content type, oversized, empty, array and scalar bodies are refused at the handler', async () => {
  const cases = [
    ['not json', { body: '{not json' }, 422, 'E_BODY_INVALID'],
    ['wrong content type', { headers: { 'content-type': 'text/plain' } }, 415, 'E_UNSUPPORTED_MEDIA_TYPE'],
    [
      'form content type',
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
      415,
      'E_UNSUPPORTED_MEDIA_TYPE',
    ],
    ['no content type', { headers: { 'content-type': undefined } }, 415, 'E_UNSUPPORTED_MEDIA_TYPE'],
    ['10 MB declared', { headers: { 'content-length': String(10 * 1024 * 1024) } }, 413, 'E_BODY_TOO_LARGE'],
    ['oversized actual', { body: `{"a":"${'x'.repeat(MAX_BODY_BYTES)}"}` }, 413, 'E_BODY_TOO_LARGE'],
    ['empty', { body: '' }, 422, 'E_BODY_INVALID'],
    ['null body', { body: null }, 422, 'E_BODY_INVALID'],
    ['array', { body: '[1,2]' }, 422, 'E_BODY_INVALID'],
    ['scalar', { body: '"x"' }, 422, 'E_BODY_INVALID'],
    ['json null', { body: 'null' }, 422, 'E_BODY_INVALID'],
  ];
  for (const [label, over, status, code] of cases) {
    const r = await echo(post(over));
    assert.equal(r.status, status, label);
    assert.deepEqual(body(r).code, code, label);
    assert.equal(r.headers['cache-control'], 'private, no-store', label);
  }
  const ok = await echo(post({ headers: { 'content-type': 'application/json; charset=utf-8' } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(body(ok), { sub: SUB, params: { companyId: COMPANY }, body: { email: 'A@Example.com' } });
});

test('readJsonBody keeps nothing but the parsed object and reports the three codes', async () => {
  assert.deepEqual(
    await readJsonBody(makeRequest({ headers: { 'content-type': 'application/json' }, body: '{"a":1}' })),
    {
      ok: true,
      value: { a: 1 },
    },
  );
  assert.deepEqual(await readJsonBody(makeRequest({ headers: {}, body: '{"a":1}' })), {
    ok: false,
    code: 'E_UNSUPPORTED_MEDIA_TYPE',
  });
  assert.deepEqual(await readJsonBody(makeRequest({ headers: { 'content-type': 'application/json' }, body: 'x' })), {
    ok: false,
    code: 'E_BODY_INVALID',
  });
  assert.deepEqual(
    await readJsonBody(makeRequest({ headers: { 'content-type': 'application/json' }, body: '{}' }), { maxBytes: 1 }),
    { ok: false, code: 'E_BODY_TOO_LARGE' },
  );
});

/* HTTP-D1 (evidence/http-d1.md): the request carries a reader and no body. makeRequest({ body }) and
   makeRequest({ readBody }) meet one contract: the reader runs on the first call only and every call returns that
   promise, a Uint8Array is viewed as a Buffer either way, and passing both is refused. */
test('HTTP-D1: makeRequest carries readBody and no body; the reader runs once, on the first call', async () => {
  const fromValue = makeRequest({ body: '{"a":1}' });
  assert.ok(Object.isFrozen(fromValue));
  assert.equal(Object.hasOwn(fromValue, 'body'), false);
  assert.equal(await fromValue.readBody(), '{"a":1}');
  assert.equal(await makeRequest({}).readBody(), null);

  let calls = 0;
  const supplied = makeRequest({
    readBody: async () => {
      calls++;
      return new Uint8Array([0x00, 0x7b, 0x7d]).subarray(1);
    },
  });
  assert.equal(calls, 0, 'building the request called the reader');
  const first = supplied.readBody();
  assert.equal(supplied.readBody(), first, 'a second call returns the first promise');
  const got = await first;
  assert.ok(Buffer.isBuffer(got));
  assert.deepEqual(got, Buffer.from('{}'));
  assert.equal(await supplied.readBody(), got);
  assert.equal(calls, 1);

  const thrown = makeRequest({
    readBody: () => {
      throw new BodyReadError('synthetic');
    },
  });
  await assert.rejects(thrown.readBody(), BodyReadError);

  assert.throws(() => makeRequest({ body: 'x', readBody: async () => 'y' }), {
    name: 'TypeError',
    message: /not both/,
  });
  assert.throws(() => makeRequest({ readBody: 'x' }), { name: 'TypeError', message: /not a function/ });
});

test('HTTP-D1 at the pipeline: readBody is first called at step 6, after its media-type and declared-length checks', async () => {
  let calls = 0;
  const counting = async () => {
    calls++;
    return '{"email":"A@Example.com"}';
  };
  const refusals = [
    ['method', { method: 'GET' }, 405],
    ['cross-site', { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
    ['no session cookie', { headers: { cookie: undefined } }, 401],
    ['malformed route id', { params: { companyId: 'not-a-uuid' } }, 404],
    ['media type', { headers: { 'content-type': 'text/plain' } }, 415],
    ['declared length', { headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }, 413],
  ];
  for (const [label, over, status] of refusals) {
    calls = 0;
    const r = await echo(post({ ...over, body: null, readBody: counting }));
    assert.equal(r.status, status, label);
    assert.equal(calls, 0, `${label}: the reader was called before the refusal`);
  }
  calls = 0;
  const ok = await echo(post({ body: null, readBody: counting }));
  assert.equal(ok.status, 200);
  assert.deepEqual(body(ok).body, { email: 'A@Example.com' });
  assert.equal(calls, 1);

  calls = 0;
  const none = route({ method: 'POST', path: '/api/probe', body: 'none', handle: async () => json(200, {}) }, quiet);
  assert.equal((await none(post({ body: null, readBody: counting }))).status, 200);
  assert.equal(calls, 0, 'a body: none route called the reader');
});

test('E3b critique F4 control: an AppError without data is answered exactly as before, three keys, one refused event', async () => {
  const seen = [];
  const refusing = route(
    {
      method: 'POST',
      path: '/api/companies/:companyId/echo',
      uuidParams: ['companyId'],
      handle: async () => {
        throw new AppError('E_FORBIDDEN');
      },
    },
    { log: (e) => seen.push(e) },
  );
  const r = await refusing(post());
  assert.equal(r.status, 403);
  assert.equal(r.body, JSON.stringify({ ok: false, code: 'E_FORBIDDEN', message: messageFor('E_FORBIDDEN') }));
  assert.equal(r.headers['cache-control'], 'private, no-store');
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(r.cookies, []);
  assert.deepEqual(seen, [{ event: 'refused', code: 'E_FORBIDDEN', status: 403 }]);
});

test('HTTP-D1 at the pipeline: a reader failing with BodyReadError is 422; any other rejection is 500 E_INTERNAL', async () => {
  const seen = [];
  const probe = route(
    { method: 'POST', path: '/api/probe', handle: async () => json(200, { ok: true }) },
    { log: (e) => seen.push(e) },
  );
  const failed = await probe(
    post({
      body: null,
      readBody: async () => {
        throw new BodyReadError('synthetic-transport-private-detail');
      },
    }),
  );
  assert.deepEqual(body(failed), { ok: false, code: 'E_BODY_INVALID', message: 'The request is not valid.' });
  assert.equal(failed.status, 422);
  assert.deepEqual(seen, []);

  const defect = await probe(
    post({
      body: null,
      readBody: async () => {
        throw new TypeError('synthetic-reader-defect-private-detail');
      },
    }),
  );
  assert.equal(defect.status, 500);
  assert.equal(body(defect).code, 'E_INTERNAL');
  assert.deepEqual(seen, [{ event: 'internal', errorName: 'TypeError' }]);
});

test('case 24: every route answers 503 E_MAINTENANCE before session verification when the switch is not open', async () => {
  const routes = makeRoutes(quiet);
  const tampered = `${validToken().slice(0, -4)}AAAA`;
  for (const state of ['closed_restore', 'closed', '', undefined, 'OPEN', 'open ']) {
    if (state === undefined) delete process.env.ENTERPRISE_ACCESS_STATE;
    else process.env.ENTERPRISE_ACCESS_STATE = state;
    try {
      for (const [name, handler] of Object.entries(routes)) {
        /* A tampered cookie would be 401 if the session were verified first; 503 proves the order. */
        const r = await handler(post({ headers: { cookie: cookie(tampered) } }));
        assert.equal(r.status, 503, `${name} with state ${JSON.stringify(state)}`);
        assert.equal(body(r).code, 'E_MAINTENANCE', name);
        assert.equal(r.headers['cache-control'], 'private, no-store');
      }
    } finally {
      process.env.ENTERPRISE_ACCESS_STATE = 'open';
    }
  }
  /* Control: open, the same tampered cookie reaches verification and is 401. */
  const r = await routes.membersSetRoles(post({ method: 'PATCH', headers: { cookie: cookie(tampered) } }));
  assert.equal(r.status, 401);
  assert.equal(body(r).code, 'E_UNAUTHENTICATED');
});

test('case 19 at the pipeline: no cookie, expired and tampered cookies are 401 with one generic code; the specific code is logged only', async () => {
  const seen = [];
  const r = route(
    { method: 'POST', path: '/api/probe', handle: async () => json(200, { ok: true }) },
    { log: (e) => seen.push(e) },
  );
  const now = Math.floor(Date.now() / 1000);
  const expired = hs256(
    userClaims({ sub: SUB, email: 'x@example.invalid', issuer: `${BASE}/auth/v1`, now: now - 7200 }),
    SECRET,
  );
  const cases = [
    ['no cookie', undefined, 'E_NO_SESSION'],
    ['expired', cookie(expired), 'E_SESSION_EXPIRED'],
    ['tampered', cookie(`${validToken().slice(0, -4)}AAAA`), 'E_SESSION_INVALID'],
  ];
  for (const [label, c, logged] of cases) {
    seen.length = 0;
    const res = await r(post({ headers: { cookie: c } }));
    assert.equal(res.status, 401, label);
    assert.deepEqual(body(res), { ok: false, code: 'E_UNAUTHENTICATED', message: 'Sign in required.' }, label);
    assert.deepEqual(seen, [{ event: 'session_refused', code: logged }], label);
  }
  const ok = await r(post());
  assert.equal(ok.status, 200);
});

test('a malformed route id is 404, the method is checked, and a cross-site mutation is refused', async () => {
  for (const bad of ['not-a-uuid', '', `${COMPANY}x`, '../x']) {
    const r = await echo(post({ params: { companyId: bad } }));
    assert.equal(r.status, 404, bad);
    assert.equal(body(r).code, 'E_NOT_FOUND');
  }
  const upper = await echo(post({ params: { companyId: COMPANY.toUpperCase() } }));
  assert.equal(upper.status, 200);
  assert.equal(body(upper).params.companyId, COMPANY);
  const get = await echo(post({ method: 'GET' }));
  assert.equal(get.status, 405);
  const cross = await echo(post({ headers: { 'sec-fetch-site': 'cross-site' } }));
  assert.equal(cross.status, 403);
  assert.equal(body(cross).code, 'E_CROSS_SITE');
  const foreignOrigin = await echo(post({ headers: { origin: 'https://evil.example.invalid' } }));
  assert.equal(foreignOrigin.status, 403);
  const sameOrigin = await echo(
    post({ headers: { origin: 'https://enterprise.example.invalid', 'sec-fetch-site': 'same-origin' } }),
  );
  assert.equal(sameOrigin.status, 200);
});

/* K1 (evidence/hardening-k.md; XR-2 in evidence/external-review-2026-09-28.md). Until K1 an unset ENTERPRISE_ORIGIN
   admitted every Origin, and a malformed one was compared as text. Now the variable is read through acceptOrigin():
   unset or not a valid origin, any Origin is refused, the literal 'null' included since ENA-5; a request with no Origin
   and no fetch metadata, which is what the Svix webhook sends, is still admitted. */
async function withOrigin(value, fn) {
  const before = process.env.ENTERPRISE_ORIGIN;
  if (value === undefined) delete process.env.ENTERPRISE_ORIGIN;
  else process.env.ENTERPRISE_ORIGIN = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.ENTERPRISE_ORIGIN;
    else process.env.ENTERPRISE_ORIGIN = before;
  }
}

test('K1: with ENTERPRISE_ORIGIN unset or malformed an Origin is refused, a request without one is admitted', async () => {
  const site = 'https://enterprise.example.invalid';
  /* fetchSite null sends no Sec-Fetch-Site, as a server such as the Svix webhook does (ENA5-3). */
  const withHeader = (origin, fetchSite = 'same-site') =>
    echo(
      post({
        headers: {
          ...(origin === undefined ? {} : { origin }),
          ...(fetchSite === null ? {} : { 'sec-fetch-site': fetchSite }),
        },
      }),
    );
  await withOrigin(undefined, async () => {
    const foreign = await withHeader('https://other.example.invalid');
    assert.equal(foreign.status, 403, 'unset: a foreign same-site Origin');
    assert.equal(body(foreign).code, 'E_CROSS_SITE');
    assert.equal(
      (await withHeader(site, 'same-origin')).status,
      403,
      'unset: nothing can match, the site itself neither',
    );
    assert.equal((await withHeader('')).status, 403, 'unset: an empty Origin');
    assert.equal(
      (await withHeader(undefined, null)).status,
      200,
      'unset: no Origin and no fetch metadata, as the webhook sends',
    );
    assert.equal((await withHeader('null', 'same-origin')).status, 403, "unset: the literal 'null' is refused (ENA-5)");
  });
  await withOrigin(site, async () => {
    assert.equal((await withHeader(site, 'same-origin')).status, 200, 'set: the matching Origin');
    assert.equal((await withHeader('https://other.example.invalid')).status, 403, 'set: a foreign Origin');
    assert.equal((await withHeader(undefined)).status, 200, 'set: no Origin');
  });
  /* Each malformed value is treated as unset: an Origin equal to the raw text, which a text comparison admitted, and
     the well-formed site are both refused. */
  for (const bad of [
    '',
    `${site}/`,
    `${site}/app`,
    'enterprise.example.invalid',
    'ftp://enterprise.example.invalid',
    'https://user@enterprise.example.invalid',
    'https://Enterprise.example.invalid',
  ]) {
    await withOrigin(bad, async () => {
      if (bad !== '')
        assert.equal((await withHeader(bad)).status, 403, `malformed ${JSON.stringify(bad)}: its own text`);
      assert.equal((await withHeader(site, 'same-origin')).status, 403, `malformed ${JSON.stringify(bad)}: the site`);
      assert.equal((await withHeader(undefined)).status, 200, `malformed ${JSON.stringify(bad)}: no Origin`);
    });
  }
});

/* ENA-5 (evidence/security-review-2026-09-30.md). A sibling subdomain that sets Referrer-Policy: no-referrer and posts
   a form sends Origin 'null' with the SameSite=Strict cookies, and an old browser sends no fetch metadata beside it;
   until ENA-5 the guard admitted the literal whatever came with it. The site never sends it: its mutations are fetch()
   calls carrying the page's own origin (evidence/xr-residuals-repro/origin-probe-chromium.json), and the request shape
   the site does send stays admitted, as does the webhook's. */
test('ENA-5: the literal Origin null is refused on a mutation whatever the fetch metadata says', async () => {
  const site = 'https://enterprise.example.invalid';
  const call = (origin, fetchSite) =>
    echo(
      post({
        headers: {
          ...(origin === undefined ? {} : { origin }),
          ...(fetchSite === undefined ? {} : { 'sec-fetch-site': fetchSite }),
        },
      }),
    );
  for (const configured of [site, undefined, `${site}/`]) {
    await withOrigin(configured, async () => {
      const label = `ENTERPRISE_ORIGIN ${JSON.stringify(configured)}`;
      for (const fetchSite of ['same-site', 'same-origin', 'none', 'cross-site', undefined]) {
        const r = await call('null', fetchSite);
        assert.equal(r.status, 403, `${label}: 'null' with Sec-Fetch-Site ${fetchSite ?? 'absent'}`);
        assert.equal(body(r).code, 'E_CROSS_SITE');
      }
      assert.equal((await call(undefined, undefined)).status, 200, `${label}: the webhook's shape, no Origin`);
    });
  }
  await withOrigin(site, async () => {
    assert.equal((await call(site, 'same-origin')).status, 200, "the site's own fetch: its origin, same-origin");
  });
});

test('an unexpected error is 500 E_INTERNAL with only the error name logged', async () => {
  const seen = [];
  const r = route(
    {
      method: 'POST',
      path: '/api/probe',
      handle: async () => {
        throw new Error('database said: synthetic-reviewer@example.invalid');
      },
    },
    { log: (e) => seen.push(e) },
  );
  const res = await r(post());
  assert.equal(res.status, 500);
  assert.deepEqual(body(res), { ok: false, code: 'E_INTERNAL', message: 'Internal error.' });
  assert.ok(!JSON.stringify(seen).includes('example.invalid'), JSON.stringify(seen));
  assert.deepEqual(seen, [{ event: 'internal', errorName: 'Error' }]);
});

/* K2 (evidence/hardening-k.md; XR-12). Netlify's request id rides on the pipeline's `internal` and `refused` lines
   through shapeFields, and an E_INTERNAL answer, thrown or refused, echoes it as `requestId` after ok, code and message,
   so a person can quote it and the operator can find the line. No other code's answer carries it, the message stays
   the fixed sentence, and a value without the request id's shape is `invalid` on the line and absent from the body. */
test('K2: the request id is on the internal and refused lines, and in the E_INTERNAL answer only', async () => {
  const ID = '01JAB2CD3EF4GH5JK6MN7PQ8RS';
  const probe = (thrown, seen) =>
    route(
      {
        method: 'POST',
        path: '/api/probe',
        handle: async () => {
          throw thrown;
        },
      },
      { log: (e) => seen.push(e), alert: async () => {} },
    );
  const withId = (id) => post(id === undefined ? {} : { headers: { 'x-nf-request-id': id } });

  let seen = [];
  let res = await probe(new Error('database said: synthetic-reviewer@example.invalid'), seen)(withId(ID));
  assert.equal(res.status, 500);
  assert.equal(res.body, JSON.stringify({ ok: false, code: 'E_INTERNAL', message: 'Internal error.', requestId: ID }));
  assert.deepEqual(seen, [{ event: 'internal', errorName: 'Error', requestId: ID }]);

  seen = [];
  res = await probe(new AppError('E_INTERNAL'), seen)(withId(ID));
  assert.equal(res.status, 500);
  assert.equal(res.body, JSON.stringify({ ok: false, code: 'E_INTERNAL', message: 'Internal error.', requestId: ID }));
  assert.deepEqual(seen, [{ event: 'refused', code: 'E_INTERNAL', status: 500, requestId: ID }]);

  seen = [];
  res = await probe(new AppError('E_FORBIDDEN'), seen)(withId(ID));
  assert.equal(res.status, 403);
  assert.deepEqual(Object.keys(body(res)), ['ok', 'code', 'message'], 'no other code carries the id');
  assert.deepEqual(seen, [{ event: 'refused', code: 'E_FORBIDDEN', status: 403, requestId: ID }]);

  for (const bad of ['a b', 'x'.repeat(65), 'eyJhbGciOiJIUzI1NiJ9.e30.sig', '<b>', '']) {
    seen = [];
    res = await probe(new Error('x'), seen)(withId(bad));
    assert.deepEqual(Object.keys(body(res)), ['ok', 'code', 'message'], `body for ${JSON.stringify(bad)}`);
    assert.deepEqual(
      seen,
      [{ event: 'internal', errorName: 'Error', requestId: 'invalid' }],
      `line for ${JSON.stringify(bad)}`,
    );
  }
  seen = [];
  res = await probe(new Error('x'), seen)(withId(undefined));
  assert.deepEqual(Object.keys(body(res)), ['ok', 'code', 'message'], 'no id, no key');
  assert.deepEqual(seen, [{ event: 'internal', errorName: 'Error' }]);
});

test('K2: error() adds requestId to an E_INTERNAL body only, an unknown code answering E_INTERNAL included', () => {
  const ID = '01JAB2CD3EF4GH5JK6MN7PQ8RS';
  assert.deepEqual(JSON.parse(error('E_INTERNAL', { requestId: ID }).body), {
    ok: false,
    code: 'E_INTERNAL',
    message: messageFor('E_INTERNAL'),
    requestId: ID,
  });
  assert.equal(JSON.parse(error('E_NOT_A_CODE', { requestId: ID }).body).requestId, ID);
  for (const code of ['E_FORBIDDEN', 'E_UNAUTHENTICATED', 'E_MAINTENANCE', 'E_AUTH_INVALID', 'E_READ_OVER_BOUND'])
    assert.deepEqual(Object.keys(JSON.parse(error(code, { requestId: ID }).body)), ['ok', 'code', 'message'], code);
  for (const bad of [42, null, {}, ['a'], 'a b', 'x'.repeat(65)])
    assert.equal(JSON.parse(error('E_INTERNAL', { requestId: bad }).body).requestId, undefined, JSON.stringify(bad));
});

test("K2: the adapter's catch writes the shaped request id on its line and echoes it in the E_INTERNAL answer", async () => {
  const ID = '01JAB2CD3EF4GH5JK6MN7PQ8RS';
  const thrower = async () => {
    throw new TypeError('escaped past the pipeline');
  };
  Object.defineProperty(thrower, 'route', {
    value: Object.freeze({ method: 'POST', session: 'none', body: 'json', path: '/api/probe' }),
  });
  Object.defineProperty(thrower, 'routeName', { value: 'probe' });
  const written = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    const done = rest.at(-1);
    if (typeof done === 'function') done();
    return true;
  };
  let res;
  try {
    res = await toNetlify(thrower)(
      new Request('https://enterprise.example.invalid/api/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nf-request-id': ID },
        body: '{}',
      }),
      {},
    );
  } finally {
    process.stderr.write = realWrite;
  }
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { ok: false, code: 'E_INTERNAL', message: 'Internal error.', requestId: ID });
  const lines = written
    .join('')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { event: 'internal', errorName: 'TypeError', requestId: ID });
});

/* K3 (evidence/hardening-k.md; XR-3): GoTrue's 429 on /otp. The caller's answer is the 204 every address gets, with
   the same headers and no cookie; the operator gets one signin_limited line and one alert carrying the route, the code,
   the status and the request id, and nothing of the address. Any other GoTrue answer writes neither. */
test('K3: a GoTrue 429 on sign-in is one shaped line and one alert, and the caller still gets the same 204', async () => {
  const ID = '01JAB2CD3EF4GH5JK6MN7PQ8RS';
  const ADDRESS = 'Synthetic.Person@Example.invalid';
  const realFetch = globalThis.fetch;
  const start = (routes, id = ID) =>
    routes.authStart(
      makeRequest({
        method: 'POST',
        path: '/api/auth/start',
        headers: { 'content-type': 'application/json', ...(id === null ? {} : { 'x-nf-request-id': id }) },
        body: JSON.stringify({ email: ADDRESS }),
      }),
    );
  const answers = [];
  try {
    for (const [status, gotrue] of [
      [200, {}],
      [422, { code: 422, error_code: 'otp_disabled', msg: 'Signups not allowed for otp' }],
      [500, null],
      [429, { code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }],
      [429, { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' }],
    ]) {
      globalThis.fetch = async () => new Response(gotrue === null ? 'not json' : JSON.stringify(gotrue), { status });
      const lines = [];
      const alerts = [];
      const res = await start(makeRoutes({ log: (e) => lines.push(e), alert: async (...a) => alerts.push(a) }));
      answers.push(res);
      const expected =
        status === 429
          ? [{ event: 'signin_limited', route: 'authStart', code: 'E_RATE_LIMITED', status: 429, requestId: ID }]
          : [];
      assert.deepEqual(lines, expected, `line for GoTrue ${status}`);
      assert.deepEqual(
        alerts.map(([event, fields]) => ({ event, ...fields })),
        expected,
        `alert for GoTrue ${status}`,
      );
      const said = JSON.stringify([lines, alerts.map(([e, f]) => [e, f])]).toLowerCase();
      for (const part of ['synthetic', 'person', 'example']) assert.equal(said.includes(part), false, part);
    }
    for (const res of answers) {
      assert.equal(res.status, 204);
      assert.equal(res.body, null);
      assert.deepEqual(res.cookies, []);
      assert.deepEqual(res.headers, answers[0].headers, 'a limited answer is indistinguishable from any other');
    }

    /* A request id of the wrong shape is the word invalid; a missing one is absent. */
    globalThis.fetch = async () => new Response('{}', { status: 429 });
    for (const [id, want] of [
      ['a b', { requestId: 'invalid' }],
      [null, {}],
    ]) {
      const lines = [];
      await start(makeRoutes({ log: (e) => lines.push(e), alert: async () => {} }), id);
      assert.deepEqual(lines, [
        { event: 'signin_limited', route: 'authStart', code: 'E_RATE_LIMITED', status: 429, ...want },
      ]);
    }

    /* An alert capture that throws changes nothing the caller sees. */
    const res = await start(
      makeRoutes({
        log: () => {},
        alert: async () => {
          throw new Error('sink down');
        },
      }),
    );
    assert.equal(res.status, 204);

    /* Nor does a logger that throws (the peer check's CR2-2): a 500 on the limited path alone would tell the caller
       what GoTrue answered. The 429 and the 422 get the same 204. */
    const throwing = () =>
      makeRoutes({
        log: () => {
          throw new Error('log down');
        },
        alert: async () => {},
      });
    for (const status of [422, 429]) {
      globalThis.fetch = async () => new Response('{}', { status });
      const r = await start(throwing());
      assert.deepEqual([r.status, r.body], [204, null], `GoTrue ${status} with a throwing logger`);
    }

    /* With no capture wired, the module's own alert() raises it: the event is on the list and folds like every other. */
    const { resetAlertWindow } = await import('../../../lib/http/alerts.mjs');
    resetAlertWindow();
    const written = [];
    const sent = [];
    let t = Date.parse('2026-09-28T12:00:00Z');
    const folding = makeRoutes({
      log: () => {},
      alertWrite: (e) => written.push(e),
      alertSink: async (record) => sent.push(record),
      alertNow: () => t,
    });
    await start(folding);
    t += 1000;
    await start(folding);
    const record = {
      event: 'signin_limited',
      route: 'authStart',
      code: 'E_RATE_LIMITED',
      status: 429,
      requestId: ID,
      v: 1,
      count: 0,
    };
    assert.deepEqual(
      written.map(({ at, ...rest }) => rest),
      [record],
      'one line; the second occurrence folds',
    );
    assert.deepEqual(
      sent.map(({ at, ...rest }) => rest),
      [record],
      'one send',
    );
  } finally {
    globalThis.fetch = realFetch;
    const { resetAlertWindow } = await import('../../../lib/http/alerts.mjs');
    resetAlertWindow();
  }
});

/* HKC-F1 (evidence/hardening-k.md, "HKC-F1"; the Codex critique of lane K): the first 429 of a fold window answered
   only once its alert's send had settled, up to SEND_BOUND_MS later, while every other GoTrue answer came at once, so
   the time of the 204 told the caller what GoTrue had said. The answer now comes while the send is still out; the line
   and the fold record are written before it; the adapter hands the send to Netlify's context.waitUntil, and the promise
   it hands never rejects. Without waitUntil (the dev shell, a direct call) the send runs on detached. */
test('HKC-F1: the first limited sign-in answers before its alert is sent, and the adapter hands the send to waitUntil', async () => {
  const { resetAlertWindow } = await import('../../../lib/http/alerts.mjs');
  const ID = '01JAB2CD3EF4GH5JK6MN7PQ8RS';
  const LINE = { event: 'signin_limited', route: 'authStart', code: 'E_RATE_LIMITED', status: 429, requestId: ID };
  const realFetch = globalThis.fetch;
  const request = () =>
    new Request('https://enterprise.example.invalid/api/auth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nf-request-id': ID },
      body: JSON.stringify({ email: 'synthetic.person@example.invalid' }),
    });
  /* Which comes first, the answer or a quarter of a second: SEND_BOUND_MS is 1.5 s, so a route that waits for a held
     send loses by more than a second, and one that does not wins by all of it. */
  const firstOf = async (answer) => {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(resolve, 250, 'the quarter second');
    });
    try {
      return await Promise.race([answer.then(() => 'the answer'), late]);
    } finally {
      clearTimeout(timer);
    }
  };
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const rejected = [];
  const onRejection = (e) => rejected.push(e);
  process.on('unhandledRejection', onRejection);
  try {
    globalThis.fetch = async () => new Response('{}', { status: 429 });

    /* A send held open: the answer does not wait for it, and waitUntil holds it until it settles. */
    resetAlertWindow();
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const lines = [];
    const written = [];
    const sent = [];
    const handed = [];
    const handler = toNetlify(
      makeRoutes({
        log: (e) => lines.push(e),
        alertWrite: (e) => written.push(e),
        alertSink: (record) => {
          sent.push(record);
          return held;
        },
      }).authStart,
    );
    const answer = handler(request(), { waitUntil: (p) => handed.push(p) });
    assert.equal(await firstOf(answer), 'the answer', 'the 204 waited for the alert to be sent');
    const res = await answer;
    assert.deepEqual([res.status, await res.text(), res.headers.get('set-cookie')], [204, '', null]);
    assert.deepEqual(lines, [LINE], 'the line is written before the answer');
    assert.deepEqual(
      written.map(({ at, ...rest }) => rest),
      [{ ...LINE, v: 1, count: 0 }],
      'the fold record is written before the answer',
    );
    assert.equal(sent.length, 1, 'the send was started');
    assert.equal(handed.length, 1, 'the send was handed to waitUntil');
    let settled = false;
    handed[0].then(() => {
      settled = true;
    });
    await turn();
    assert.equal(settled, false, 'what waitUntil holds settles with the send, not before');
    release();
    assert.equal(await handed[0], undefined);
    assert.equal(written.length, 1, 'a send that answered in time drops nothing');

    /* A second occurrence folds: no send, and what it hands is already settled. */
    const again = await handler(request(), { waitUntil: (p) => handed.push(p) });
    assert.equal(again.status, 204);
    assert.deepEqual([sent.length, handed.length], [1, 2]);
    assert.equal(await handed[1], undefined);

    /* Any other GoTrue answer hands nothing. */
    globalThis.fetch = async () => new Response('{}', { status: 422 });
    assert.equal((await handler(request(), { waitUntil: (p) => handed.push(p) })).status, 204);
    assert.equal(handed.length, 2);

    /* A send that rejects, one that throws, a waitUntil that throws and no waitUntil at all: the same prompt 204,
       what is handed resolves, and the failed send is still recorded as dropped. */
    globalThis.fetch = async () => new Response('{}', { status: 429 });
    for (const [label, alertSink, context] of [
      ['a rejecting send', () => Promise.reject(new Error('provider down')), { waitUntil: (p) => handed.push(p) }],
      [
        'a throwing send',
        () => {
          throw new Error('provider down');
        },
        { waitUntil: (p) => handed.push(p) },
      ],
      [
        'a throwing waitUntil',
        () => held,
        {
          waitUntil: () => {
            throw new Error('platform');
          },
        },
      ],
      ['no waitUntil', () => new Promise(() => {}), {}],
      /* The peer check H5's PC-1 and PC-2: a context whose waitUntil getter throws, and a waitUntil that rejects. */
      [
        'a throwing waitUntil getter',
        () => held,
        Object.defineProperty({}, 'waitUntil', {
          get() {
            throw new Error('platform');
          },
        }),
      ],
      [
        'a rejecting waitUntil',
        () => held,
        {
          waitUntil: (p) => {
            handed.push(p);
            return Promise.reject(new Error('platform'));
          },
        },
      ],
    ]) {
      resetAlertWindow();
      const out = [];
      const handedBefore = handed.length;
      const fn = toNetlify(makeRoutes({ log: () => {}, alertWrite: (e) => out.push(e), alertSink }).authStart);
      const pending = fn(request(), context);
      assert.equal(await firstOf(pending), 'the answer', label);
      assert.equal((await pending).status, 204, label);
      for (const p of handed.slice(handedBefore)) assert.equal(await p, undefined, label);
      if (label.includes('send')) assert.deepEqual(out.at(-1), { event: 'alert_dropped' }, label);
    }
    await turn();
    assert.deepEqual(rejected, []);
  } finally {
    process.off('unhandledRejection', onRejection);
    globalThis.fetch = realFetch;
    resetAlertWindow();
  }
});

/* K5 (evidence/hardening-k.md; XR-4): every API answer carries the four private headers, the policy included. */
test('K5: json(), noContent() and error() answers carry exactly the private headers, a default-src none policy among them', () => {
  const PRIVATE = {
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  };
  assert.deepEqual(noContent().headers, PRIVATE);
  assert.deepEqual(json(200, { ok: true }).headers, { ...PRIVATE, 'content-type': 'application/json; charset=utf-8' });
  assert.deepEqual(error('E_INTERNAL').headers, { ...PRIVATE, 'content-type': 'application/json; charset=utf-8' });
});

test('the Netlify adapter converts a web Request and back, keeping cookies and private headers', async () => {
  const req = new Request('https://enterprise.example.invalid/api/companies/x/invitations?a=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'k=v' },
    body: '{"email":"e@example.invalid"}',
  });
  const r = await fromWebRequest(req, { params: { companyId: COMPANY } });
  assert.equal(r.method, 'POST');
  assert.equal(r.path, '/api/companies/x/invitations');
  assert.deepEqual(r.query, { a: '1' });
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers.cookie, 'k=v');
  assert.deepEqual(r.params, { companyId: COMPANY });
  assert.equal(await r.readBody(), '{"email":"e@example.invalid"}');
  const big = new Request('https://enterprise.example.invalid/api/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(10 * 1024 * 1024) },
    body: 'x',
  });
  const rb = await fromWebRequest(big, {});
  assert.deepEqual(await readJsonBody(rb), { ok: false, code: 'E_BODY_TOO_LARGE' });
  const res = toWebResponse(json(201, { ok: true }, { cookies: ['a=1; Path=/', 'b=2; Path=/'] }));
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(res.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
  assert.deepEqual(await res.json(), { ok: true });
});

test('HTTP-D5: fromWebRequest keeps query names an object inherits, and the first value of a repeated name', async () => {
  const req = new Request(
    'https://enterprise.example.invalid/api/x?constructor=1&toString=2&a=3&__proto__=p&hasOwnProperty=h&a=4',
  );
  const r = await fromWebRequest(req, {}, 'none');
  /* JSON.parse, not an object literal: a literal's __proto__ key sets the prototype instead of an own name. */
  const expected = JSON.parse('{"constructor":"1","toString":"2","a":"3","__proto__":"p","hasOwnProperty":"h"}');
  assert.deepEqual(r.query, expected, JSON.stringify(r.query));
  assert.equal(Object.getPrototypeOf(r.query), Object.prototype);
  assert.ok(Object.isFrozen(r.query));
});
