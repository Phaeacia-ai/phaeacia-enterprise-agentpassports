/* Pages construction, the eight routes without a stack (pages design 7.1): U1 the declaration table, U6 the aal source,
   U7 the pipeline order, the route half of U13 over the shared corpus, and the route half of U5 (what a factor route
   logs and answers). GoTrue and the Data API are one stub at the global fetch, which records every call. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CORPUS, routeBody } from '../fixtures/display-name-corpus.mjs';
import { hs256, userClaims } from '../helpers/jwt.mjs';

const SECRET = 'example-unit-secret-with-at-least-32-characters-long';
const BASE = 'http://127.0.0.1:54321';
const ORIGIN = 'https://enterprise.example.invalid';
process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = SECRET;
process.env.ENTERPRISE_ACCESS_STATE = 'open';
process.env.ENTERPRISE_ORIGIN = ORIGIN;

const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest, MAX_BODY_BYTES } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/retired-factor-enrolment.json', import.meta.url), 'utf8'));
const SUB = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11';
const EMAIL = 'viewer@example.invalid';
const COMPANY = '2a5d1b3c-4e6f-4a8b-9c0d-1e2f3a4b5c6d';
const FACTOR = '6f1d2c3b-4a59-4e68-8d7c-0b1a2f3e4d5c';
const CHALLENGE = '8b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';

const now = () => Math.floor(Date.now() / 1000);
const token = ({ aal = 'aal1', signedWith = SECRET, exp } = {}) =>
  hs256(
    userClaims({ sub: SUB, email: EMAIL, issuer: `${BASE}/auth/v1`, aal, ...(exp ? { now: exp - 3600 } : {}) }),
    signedWith,
  );
const claimsOf = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

const NEW = [
  'me',
  'meDisplayName',
  'membersList',
  'invitationsList',
  'factorsList',
  'factorsEnroll',
  'factorsVerify',
  'factorsRemove',
];
const MUTATIONS = ['meDisplayName', 'factorsEnroll', 'factorsVerify', 'factorsRemove'];
const PARAMS = {
  membersList: { companyId: COMPANY },
  invitationsList: { companyId: COMPANY },
  factorsVerify: { factorId: FACTOR },
  factorsRemove: { factorId: FACTOR },
};
const BODIES = { meDisplayName: { displayName: 'Ada' }, factorsVerify: { code: '123456' } };

/* HB-F2 (migration 012): the verify route begins and ends the account's bound around GoTrue. A REST stub that does
   not name the two routines answers them as an untouched account would: allowed, then settled. */
const ATTEMPT = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const boundAnswer = ({ path }) => {
  if (path === '/rest/v1/rpc/mfa_verify_begin')
    return new Response(JSON.stringify([{ allowed: true, retry_after: null, attempt_id: ATTEMPT }]));
  if (path === '/rest/v1/rpc/mfa_verify_end') return new Response('null');
  return null;
};

/* One stub for both services: gotrue({ method, path, body }) and rest({ method, path, body }) each return a Response. */
async function withStack(
  { gotrue = () => new Response('{}', { status: 500 }), rest = (call) => boundAnswer(call) ?? new Response('[]') } = {},
  run,
) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    const call = {
      method: init.method,
      path: `${u.pathname}${u.search}`,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      authorization: init.headers.authorization,
    };
    calls.push(call);
    return u.pathname.startsWith('/auth/v1/') ? gotrue(call) : rest(call);
  };
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

function request(routes, name, { cookie, headers = {}, body, params, method } = {}) {
  const handler = routes[name];
  const h = { ...headers };
  if (cookie !== undefined) h.cookie = cookie;
  if (body !== undefined && h['content-type'] === undefined) h['content-type'] = 'application/json';
  return handler(
    makeRequest({
      method: method ?? handler.route.method,
      path: handler.route.path,
      params: params ?? PARAMS[name] ?? {},
      headers: h,
      body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}
const access = (t) => `${COOKIES.access}=${t}`;
const parsed = (res) => (res.body === null ? null : JSON.parse(res.body));

test('U1: the declaration table, 58 routes, each with its method, session, body and path; the eight pages routes as 2.1 to 2.4 give them, the twelve E4 routes as E4 design 3.4 gives them, the five E5 routes as E5 design 3.4 gives them and the fifteen E6 routes as E6 design 3.4 gives them', () => {
  const table = makeRoutes();
  const expected = {
    invitationsCreate: ['POST', 'required', 'json', '/api/companies/:companyId/invitations'],
    invitationsRevoke: ['POST', 'required', 'none', '/api/companies/:companyId/invitations/:invitationId/revoke'],
    invitationsAccept: ['POST', 'required', 'json', '/api/invitations/accept'],
    membersSetRoles: ['PATCH', 'required', 'json', '/api/companies/:companyId/members/:membershipId/roles'],
    membersRemove: ['DELETE', 'required', 'none', '/api/companies/:companyId/members/:membershipId'],
    /* E6 design 1.1 and 3.4: this declaration REPLACES E2's operatorProvision on the same method and path, which
       called api.provision_company with a prepared auth.users id no route creates and made a company with no
       access period, which design 1.5 says the product path may not do (lead decision, 2026-09-17). */
    operatorCompanyCreate: ['POST', 'required', 'json', '/api/operator/companies'],
    operatorRegister: ['GET', 'required', 'none', '/api/operator/companies'],
    operatorTransferAdmin: ['POST', 'required', 'json', '/api/operator/companies/:companyId/transfer-first-admin'],
    authStart: ['POST', 'none', 'json', '/api/auth/start'],
    authVerify: ['POST', 'none', 'json', '/api/auth/verify'],
    authRefresh: ['POST', 'none', 'none', '/api/auth/refresh'],
    authSignout: ['POST', 'optional', 'none', '/api/auth/signout'],
    candidatesCreate: ['POST', 'required', 'passport', '/api/companies/:companyId/candidates'],
    candidatesSave: ['PUT', 'required', 'passport', '/api/candidates/:candidateId'],
    candidatesSubmit: ['POST', 'required', 'submission', '/api/candidates/:candidateId/submit'],
    candidatesSuccessor: ['POST', 'required', 'json', '/api/candidates/:candidateId/successor'],
    candidatesRead: ['GET', 'required', 'none', '/api/candidates/:candidateId'],
    candidatesList: ['GET', 'required', 'none', '/api/companies/:companyId/candidates'],
    gateRead: ['GET', 'required', 'none', '/api/gate'],
    me: ['GET', 'required', 'none', '/api/me'],
    meDisplayName: ['PUT', 'required', 'json', '/api/me/display-name'],
    membersList: ['GET', 'required', 'none', '/api/companies/:companyId/members'],
    invitationsList: ['GET', 'required', 'none', '/api/companies/:companyId/invitations'],
    factorsList: ['GET', 'required', 'none', '/api/auth/factors'],
    factorsEnroll: ['POST', 'required', 'none', '/api/auth/factors/totp'],
    factorsVerify: ['POST', 'required', 'json', '/api/auth/factors/:factorId/verify'],
    factorsRemove: ['DELETE', 'required', 'none', '/api/auth/factors/:factorId'],
    /* E4 design 3.4, lent to the E4 server lane by the lead (2026-09-15). */
    reviewQueue: ['GET', 'required', 'none', '/api/companies/:companyId/review-queue'],
    reviewRead: ['GET', 'required', 'none', '/api/candidates/:candidateId/review'],
    envelopesCreate: ['POST', 'required', 'json', '/api/candidates/:candidateId/envelopes'],
    reviewsCreate: ['POST', 'required', 'json', '/api/candidates/:candidateId/reviews'],
    releasesPublish: ['POST', 'required', 'json', '/api/candidates/:candidateId/releases'],
    releasesWithdraw: ['POST', 'required', 'json', '/api/releases/:releaseId/withdraw'],
    releasesRead: ['GET', 'required', 'none', '/api/releases/:releaseId'],
    releasesList: ['GET', 'required', 'none', '/api/companies/:companyId/releases'],
    groupsList: ['GET', 'required', 'none', '/api/companies/:companyId/groups'],
    groupsCreate: ['POST', 'required', 'json', '/api/companies/:companyId/groups'],
    groupMembersAdd: ['PUT', 'required', 'none', '/api/companies/:companyId/groups/:groupId/members/:membershipId'],
    groupMembersRemove: [
      'DELETE',
      'required',
      'none',
      '/api/companies/:companyId/groups/:groupId/members/:membershipId',
    ],
    /* E5 design 3.4. The download declares no body and takes no Idempotency-Key (E5 design 1.2); a third pair shares
       one path by method, the GET and POST on a release's installations. */
    catalogRead: ['GET', 'required', 'none', '/api/companies/:companyId/catalog'],
    releasesDownload: ['POST', 'required', 'none', '/api/releases/:releaseId/download'],
    installationsList: ['GET', 'required', 'none', '/api/releases/:releaseId/installations'],
    installationsCreate: ['POST', 'required', 'json', '/api/releases/:releaseId/installations'],
    installationsWitness: ['POST', 'required', 'json', '/api/installations/:reportId/witness'],
    /* E6 design 3.4 as evidence/e6-design-corrections.md section 4 item 4 lists them: fifteen declarations on
       fourteen paths, the fourth pair sharing a path by method being the register and the create above. Two
       names are not the design's: the module and the two routes it named after the word scripts/check-imports.mjs
       rule 7 refuses under lib/ and netlify/ are `takeout` here, and the database keeps every one of its own
       names (lead decision, 2026-09-17; evidence/e6-services.md section 5). */
    operatorTakeoutManifest: ['GET', 'required', 'none', '/api/operator/companies/:companyId/takeout-manifest'],
    operatorCompanyStatus: ['POST', 'required', 'json', '/api/operator/companies/:companyId/status'],
    operatorAccessPeriod: ['POST', 'required', 'json', '/api/operator/companies/:companyId/access-period'],
    operatorCompanyQuota: ['POST', 'required', 'json', '/api/operator/companies/:companyId/quotas'],
    operatorAdminInvitation: ['POST', 'required', 'json', '/api/operator/companies/:companyId/admin-invitation'],
    operatorCompanyClose: ['POST', 'required', 'json', '/api/operator/companies/:companyId/close'],
    operatorCompanyDelete: ['POST', 'required', 'json', '/api/operator/companies/:companyId/delete'],
    operatorExpiryRun: ['POST', 'required', 'json', '/api/operator/expiry-run'],
    invitationsResend: ['POST', 'required', 'none', '/api/companies/:companyId/invitations/:invitationId/resend'],
    membersDeparture: ['GET', 'required', 'none', '/api/companies/:companyId/members/:membershipId/departure'],
    agentsTransfer: ['POST', 'required', 'json', '/api/agents/:agentId/transfer'],
    quotasRead: ['GET', 'required', 'none', '/api/companies/:companyId/quotas'],
    companyTakeout: ['GET', 'required', 'none', '/api/companies/:companyId/takeout'],
    /* The alerts design 1.4 and section 7 (slice 1): the mail provider's delivery events, no session, the raw body
       verified by its signature before anything is parsed. */
    mailEvents: ['POST', 'none', 'signed', '/api/mail/events'],
  };
  assert.deepEqual(Object.keys(table), Object.keys(expected), 'the table, in order');
  for (const [name, [method, session, body, path]] of Object.entries(expected))
    assert.deepEqual(table[name].route, { method, session, body, path }, name);
  assert.equal(table.invitationsList.route.path, table.invitationsCreate.route.path, 'O10: one path, two methods');
  assert.equal(table.groupsList.route.path, table.groupsCreate.route.path, 'E4 O10: the groups path, two methods');
  assert.equal(
    table.groupMembersAdd.route.path,
    table.groupMembersRemove.route.path,
    'E4 O10: a group member, two methods',
  );
  assert.equal(
    table.installationsList.route.path,
    table.installationsCreate.route.path,
    'E5 O10: a release s installations, two methods',
  );
  assert.equal(
    table.operatorRegister.route.path,
    table.operatorCompanyCreate.route.path,
    'E6 O10: the operator register and the company create, two methods on one path',
  );
  assert.equal(
    Object.keys(table).length,
    58,
    'E2 to E5 s forty-two, minus operatorProvision, plus E6 s fifteen, plus the mail event route',
  );
  assert.equal(
    new Set(Object.values(table).map((h) => h.route.path)).size,
    51,
    'seven paths carry two methods each; E6 adds exactly one of them (design 2.6 item 4, pages O10)',
  );
});

test('U7: a closed switch answers 503 before verification on all eight routes, with a tampered cookie and zero calls', async () => {
  const routes = makeRoutes({ log: () => {} });
  const tampered = `${token({ aal: 'aal2' }).slice(0, -4)}AAAA`;
  for (const state of ['closed', undefined]) {
    if (state === undefined) delete process.env.ENTERPRISE_ACCESS_STATE;
    else process.env.ENTERPRISE_ACCESS_STATE = state;
    try {
      for (const name of NEW) {
        const { result, calls } = await withStack({}, () =>
          request(routes, name, { cookie: access(tampered), body: BODIES[name] }),
        );
        assert.equal(result.status, 503, `${name} ${state}`);
        assert.equal(parsed(result).code, 'E_MAINTENANCE', name);
        assert.equal(calls.length, 0, name);
      }
    } finally {
      process.env.ENTERPRISE_ACCESS_STATE = 'open';
    }
  }
  for (const name of NEW) {
    const { result } = await withStack({}, () =>
      request(routes, name, { cookie: access(tampered), body: BODIES[name] }),
    );
    assert.equal(result.status, 401, `${name}: control, open, the same cookie reaches verification`);
  }
});

test('U7: cross-site Sec-Fetch-Site and a foreign Origin answer 403 on the four mutations before any GoTrue or database call', async () => {
  const routes = makeRoutes({ log: () => {} });
  const t = token({ aal: 'aal2' });
  for (const name of MUTATIONS) {
    for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { origin: 'https://evil.example.invalid' }]) {
      const { result, calls } = await withStack({}, () =>
        request(routes, name, { cookie: access(t), headers, body: BODIES[name] }),
      );
      assert.equal(result.status, 403, `${name} ${JSON.stringify(headers)}`);
      assert.equal(parsed(result).code, 'E_CROSS_SITE');
      assert.equal(calls.length, 0, `${name}: no call`);
    }
  }
  for (const name of ['me', 'membersList', 'invitationsList', 'factorsList']) {
    const { result } = await withStack({}, () =>
      request(routes, name, { cookie: access(t), headers: { 'sec-fetch-site': 'cross-site' } }),
    );
    assert.notEqual(result.status, 403, `${name}: a read is not a mutation`);
  }
});

test('U2 at the route: each read route answers with its own service, wrapped in ok', async () => {
  const routes = makeRoutes({ log: () => {} });
  const rest = ({ path }) => {
    const u = new URL(`http://unit${path}`);
    /* The standing read moved to api.my_standing in E6 (design 1.1); loadPrincipal names a company and loadIdentity
       does not, which is what tells the two reads of the one view apart. */
    const principal = u.pathname === '/rest/v1/my_standing' && u.searchParams.has('company_id');
    return new Response(
      principal
        ? JSON.stringify([
            {
              membership_id: FACTOR,
              roles: ['company_admin', 'member'],
              membership_status: 'active',
              company_status: 'active',
              access_state: 'current',
            },
          ])
        : '[]',
    );
  };
  const me = await withStack({ rest }, () => request(routes, 'me', { cookie: access(token({ aal: 'aal2' })) }));
  assert.deepEqual(Object.keys(parsed(me.result)), ['ok', 'user', 'memberships', 'truncated']);
  const list = await withStack({ rest }, () => request(routes, 'membersList', { cookie: access(token()) }));
  assert.equal(list.result.status, 200);
  assert.deepEqual(Object.keys(parsed(list.result)), [
    'ok',
    'companyId',
    'viewer',
    'assignableRoles',
    'members',
    'truncated',
  ]);
  const stepUp = await withStack({ rest }, () => request(routes, 'invitationsList', { cookie: access(token()) }));
  assert.equal(
    stepUp.result.status,
    403,
    'an admin at aal1 is refused by the invitation list, not served the member list',
  );
  assert.equal(parsed(stepUp.result).code, 'E_MFA_STEP_UP_REQUIRED');
  const invitations = await withStack({ rest }, () =>
    request(routes, 'invitationsList', { cookie: access(token({ aal: 'aal2' })) }),
  );
  assert.deepEqual(Object.keys(parsed(invitations.result)), [
    'ok',
    'companyId',
    'stateDerivedAt',
    'invitations',
    'truncated',
  ]);
});

test('U7: a malformed companyId or factorId answers 404 with zero database and GoTrue calls and no log line; wrong methods answer 405', async () => {
  const seen = [];
  const routes = makeRoutes({ log: (e) => seen.push(e) });
  const t = token({ aal: 'aal2' });
  const idRoutes = [
    ['membersList', 'companyId'],
    ['invitationsList', 'companyId'],
    ['factorsVerify', 'factorId'],
    ['factorsRemove', 'factorId'],
  ];
  for (const [name, param] of idRoutes) {
    for (const bad of ['not-a-uuid', '', `${FACTOR}x`, '../x', 'totp']) {
      seen.length = 0;
      const { result, calls } = await withStack({}, () =>
        request(routes, name, { cookie: access(t), params: { [param]: bad }, body: BODIES[name] }),
      );
      assert.equal(result.status, 404, `${name} ${bad}`);
      assert.equal(parsed(result).code, 'E_NOT_FOUND');
      assert.equal(calls.length, 0, `${name} ${bad}: no call`);
      /* The pipeline's uuid-parameter refusal logs nothing. The same 404 from the service's isUuid or from the factor
         module's own uuid check, which is what a route without the declaration gives, is logged as refused, so the empty
         log is what observes the declaration (U1 points here). */
      assert.deepEqual(seen, [], `${name} ${bad}: refused by the declaration, not by a service`);
    }
    const control = await withStack({}, () => request(routes, name, { cookie: access(t), body: BODIES[name] }));
    assert.ok(control.calls.length > 0, `${name}: control, a well-formed id reaches the stub`);
  }
  const wrong = { GET: 'POST', PUT: 'GET', POST: 'GET', DELETE: 'POST' };
  for (const name of NEW) {
    const { result, calls } = await withStack({}, () =>
      request(routes, name, { cookie: access(t), method: wrong[routes[name].route.method] }),
    );
    assert.equal(result.status, 405, name);
    assert.equal(calls.length, 0);
  }
});

test('U7: the two JSON routes refuse a wrong content type (415), a 17 KiB body (413) and an array, null or scalar body (422) before any call', async () => {
  const routes = makeRoutes({ log: () => {} });
  const t = token({ aal: 'aal2' });
  const big = JSON.stringify({ displayName: 'x'.repeat(17 * 1024), code: 'x'.repeat(17 * 1024) });
  assert.ok(Buffer.byteLength(big) > MAX_BODY_BYTES);
  for (const name of ['meDisplayName', 'factorsVerify']) {
    const cases = [
      [
        'text/plain',
        { headers: { 'content-type': 'text/plain' }, body: JSON.stringify(BODIES[name]) },
        415,
        'E_UNSUPPORTED_MEDIA_TYPE',
      ],
      ['17 KiB', { body: big }, 413, 'E_BODY_TOO_LARGE'],
      ['array', { body: '[1]' }, 422, 'E_BODY_INVALID'],
      ['null', { body: 'null' }, 422, 'E_BODY_INVALID'],
      ['scalar', { body: '"123456"' }, 422, 'E_BODY_INVALID'],
    ];
    for (const [label, over, status, code] of cases) {
      const { result, calls } = await withStack({}, () => request(routes, name, { cookie: access(t), ...over }));
      assert.equal(result.status, status, `${name} ${label}`);
      assert.equal(parsed(result).code, code, `${name} ${label}`);
      assert.equal(calls.length, 0, `${name} ${label}`);
    }
  }
});

test('U7, R-H5 (O21): GET /api/me with no access cookie, an expired one or a wrongly signed one answers 401 E_UNAUTHENTICATED, never E_AUTH_INVALID', async () => {
  const seen = [];
  const routes = makeRoutes({ log: (e) => seen.push(e) });
  const inputs = [
    ['no access cookie', undefined, 'E_NO_SESSION'],
    ['expired', access(token({ exp: now() - 60 })), 'E_SESSION_EXPIRED'],
    ['wrongly signed', access(token({ signedWith: [...SECRET].reverse().join('') })), 'E_SESSION_INVALID'],
  ];
  for (const [label, cookie, logged] of inputs) {
    seen.length = 0;
    const { result, calls } = await withStack({}, () => request(routes, 'me', { cookie }));
    assert.equal(result.status, 401, label);
    assert.deepEqual(parsed(result), { ok: false, code: 'E_UNAUTHENTICATED', message: 'Sign in required.' }, label);
    assert.deepEqual(seen, [{ event: 'session_refused', code: logged }], label);
    assert.equal(calls.length, 0);
  }
  for (const name of NEW) {
    const { result } = await withStack({}, () => request(routes, name, { body: BODIES[name] }));
    assert.equal(parsed(result).code, 'E_UNAUTHENTICATED', `${name} without a cookie`);
  }
});

const dataApi = (call) => {
  const bound = boundAnswer(call);
  if (bound) return bound;
  const { path } = call;
  const view = path.split('?')[0].replace('/rest/v1/', '');
  /* api.my_standing joined the readable views in E6: GET /api/me reads it in place of the memberships-and-companies
     pair (design 1.1), so a stub that answered 404 for it turned this route's answer into 500 E_INTERNAL. */
  if (view === 'memberships' || view === 'companies' || view === 'profiles' || view === 'my_standing')
    return new Response('[]');
  return new Response('[]', { status: 404 });
};

test('U6: aal comes from verification, not from the route: a verify answer whose aal2 token is badly signed sets the cookies, and me then answers 401', async () => {
  const routes = makeRoutes({ log: () => {} });
  const signedAal2 = token({ aal: 'aal2' });
  const forged = `${signedAal2.slice(0, signedAal2.lastIndexOf('.'))}.${'A'.repeat(43)}`;
  assert.equal(claimsOf(forged).aal, 'aal2', 'the forged token says aal2');
  const verifyWith = (issued) =>
    withStack(
      {
        gotrue: ({ path }) =>
          path.endsWith('/challenge')
            ? new Response(JSON.stringify({ id: CHALLENGE, type: 'totp' }))
            : new Response(JSON.stringify({ access_token: issued, refresh_token: 'r-1', expires_in: 3600 })),
        rest: dataApi,
      },
      async () => {
        const verified = await request(routes, 'factorsVerify', { cookie: access(token()), body: { code: '123456' } });
        assert.equal(verified.status, 204);
        assert.equal(verified.body, null, 'the route returns no body and no aal');
        const cookie = /^enterprise_access=([^;]+);/.exec(verified.cookies[0])[1];
        assert.equal(cookie, issued, 'the cookie holds exactly the token GoTrue returned');
        return request(routes, 'me', { cookie: access(cookie) });
      },
    );
  const forgedMe = await verifyWith(forged);
  assert.equal(forgedMe.result.status, 401, 'never aal2');
  assert.equal(parsed(forgedMe.result).code, 'E_UNAUTHENTICATED');
  const signedMe = await verifyWith(signedAal2);
  assert.equal(signedMe.result.status, 200);
  assert.equal(parsed(signedMe.result).user.aal, 'aal2', 'control: a correctly signed aal2 token');
});

test('U13, the route: every corpus row the Node column refuses answers 422 E_BODY_INVALID with zero server-client calls; accepted rows send exactly the normalized name', async () => {
  const seen = [];
  const routes = makeRoutes({ log: (e) => seen.push(e) });
  const t = token({ aal: 'aal1' });
  for (const row of CORPUS) {
    seen.length = 0;
    const { result, calls } = await withStack({ rest: () => new Response(JSON.stringify([{ changed: true }])) }, () =>
      request(routes, 'meDisplayName', { cookie: access(t), body: routeBody(row) }),
    );
    if (row.node === null) {
      assert.equal(result.status, 422, row.label);
      assert.equal(parsed(result).code, 'E_BODY_INVALID', row.label);
      assert.equal(calls.length, 0, `${row.label}: no server-client call`);
      assert.deepEqual(seen, [{ event: 'refused', code: 'E_BODY_INVALID', status: 422 }], row.label);
    } else {
      assert.equal(result.status, 204, row.label);
      assert.equal(result.body, null);
      assert.equal(calls.length, 1, row.label);
      assert.equal(calls[0].path, '/rest/v1/rpc/set_display_name');
      assert.deepEqual(calls[0].body, { p_display_name: row.node }, row.label);
      const bearer = claimsOf(calls[0].authorization.slice('Bearer '.length));
      assert.equal(bearer.role, 'app_server');
      assert.equal(bearer.sub, SUB, 'the server token names the session subject');
      assert.deepEqual(seen, [], `${row.label}: nothing logged`);
    }
  }
  const extra = await withStack({ rest: () => new Response('[{"changed":false}]') }, () =>
    request(routes, 'meDisplayName', {
      cookie: access(t),
      body: { displayName: 'Ada', userId: '11111111-2222-4333-8444-555555555555', p_display_name: 'Other' },
    }),
  );
  assert.equal(extra.result.status, 204, 'unchanged is 204 too');
  assert.deepEqual(extra.calls[0].body, { p_display_name: 'Ada' }, 'unknown keys never reach the function');
});

/* The GoTrue stub for the factor routes, answering as GoTrue v2.192.0 did on the local stack. */
const goTrue =
  (over = {}) =>
  ({ method, path, body }) => {
    const key = `${method} ${path.split('?')[0]}`;
    if (over[key]) return over[key]({ method, path, body });
    if (key === 'GET /auth/v1/user')
      return new Response(
        JSON.stringify({
          id: SUB,
          factors: [{ id: FACTOR, factor_type: 'totp', status: 'verified', friendly_name: 'A', created_at: 't' }],
        }),
      );
    if (key === 'POST /auth/v1/factors') return new Response(JSON.stringify(FIXTURE.answer));
    if (key.endsWith('/challenge')) return new Response(JSON.stringify({ id: CHALLENGE, type: 'totp', expires_at: 1 }));
    if (key.endsWith('/verify'))
      return new Response(
        JSON.stringify({ code: 422, error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' }),
        { status: 422 },
      );
    if (key.startsWith('DELETE /auth/v1/factors/')) return new Response(JSON.stringify({ id: FACTOR }));
    if (key === 'POST /auth/v1/token')
      return new Response(
        JSON.stringify({ access_token: token({ aal: 'aal1' }), refresh_token: 'r-2', expires_in: 3600 }),
      );
    return new Response('{}', { status: 500 });
  };

test('U5, the routes: list, enrol, verify and remove answer as 2.4 gives them, and no log line or refusal carries a secret, URI, QR, code or challenge id', async () => {
  const seen = [];
  const routes = makeRoutes({ log: (e) => seen.push(e) });
  const aal1 = token({ aal: 'aal1' });
  const both = `${access(aal1)}; ${COOKIES.refresh}=r-1`;
  const responses = [];
  const call = async (name, stub, opts) => {
    const { result, calls } = await withStack({ gotrue: stub }, () => request(routes, name, opts));
    responses.push(result);
    return { result, calls };
  };

  const listed = await call('factorsList', goTrue(), { cookie: both });
  assert.equal(listed.result.status, 200);
  assert.deepEqual(parsed(listed.result), {
    ok: true,
    aal: 'aal1',
    factors: [{ factorId: FACTOR, type: 'totp', status: 'verified', friendlyName: 'A', createdAt: 't' }],
  });

  const enrolled = await call('factorsEnroll', goTrue(), { cookie: both });
  assert.equal(enrolled.result.status, 201);
  assert.equal(enrolled.result.headers['cache-control'], 'private, no-store');
  assert.deepEqual(Object.keys(parsed(enrolled.result)), ['ok', 'factorId', 'qrCodeSvg', 'uri', 'secret']);
  assert.equal(parsed(enrolled.result).qrCodeSvg, FIXTURE.answer.totp.qr_code);

  const wrong = await call('factorsVerify', goTrue(), { cookie: both, body: { code: '123456' } });
  assert.equal(wrong.result.status, 422);
  assert.equal(parsed(wrong.result).code, 'E_MFA_CODE_INVALID');
  assert.deepEqual(wrong.result.cookies, [], 'a refused verification changes no cookie');

  const hookRefusal = goTrue({
    'POST /auth/v1/factors/6f1d2c3b-4a59-4e68-8d7c-0b1a2f3e4d5c/verify': () =>
      new Response(
        JSON.stringify({
          code: 429,
          error_code: 'unknown',
          msg: 'Too many attempts. Try again after 2026-09-14T10:12:03Z.',
        }),
        { status: 429 },
      ),
  });
  const limited = await call('factorsVerify', hookRefusal, { cookie: both, body: { code: '654321' } });
  assert.equal(limited.result.status, 429);
  assert.equal(parsed(limited.result).code, 'E_RATE_LIMITED');

  const okVerify = goTrue({
    'POST /auth/v1/factors/6f1d2c3b-4a59-4e68-8d7c-0b1a2f3e4d5c/verify': () =>
      new Response(JSON.stringify({ access_token: token({ aal: 'aal2' }), refresh_token: 'r-9', expires_in: 1800 })),
  });
  const verified = await call('factorsVerify', okVerify, { cookie: both, body: { code: '000111' } });
  assert.equal(verified.result.status, 204);
  assert.equal(verified.result.cookies.length, 2);
  assert.match(
    verified.result.cookies[0],
    /^enterprise_access=[^;]+; Max-Age=1800; Path=\/; HttpOnly; Secure; SameSite=Strict$/,
  );
  assert.match(
    verified.result.cookies[1],
    /^enterprise_refresh=r-9; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Strict$/,
  );

  const removed = await call('factorsRemove', goTrue(), { cookie: both });
  assert.equal(removed.result.status, 204);
  assert.deepEqual(
    removed.calls.map((c) => `${c.method} ${c.path}`),
    [`DELETE /auth/v1/factors/${FACTOR}`, 'POST /auth/v1/token?grant_type=refresh_token'],
  );
  assert.deepEqual(removed.calls[1].body, { refresh_token: 'r-1' }, 'the refresh cookie of this request');
  assert.match(removed.result.cookies[1], /^enterprise_refresh=r-2;/, 'cookies replaced by the refresh');

  const refreshRefused = await call(
    'factorsRemove',
    goTrue({ 'POST /auth/v1/token': () => new Response('{"error":"invalid_grant"}', { status: 400 }) }),
    { cookie: both },
  );
  assert.equal(refreshRefused.result.status, 204);
  assert.ok(
    refreshRefused.result.cookies.every((c) => /Max-Age=0/.test(c)),
    'both cookies cleared when the refresh fails',
  );
  const refreshThrew = await call(
    'factorsRemove',
    goTrue({
      'POST /auth/v1/token': () => {
        throw new TypeError('fetch failed');
      },
    }),
    { cookie: both },
  );
  assert.equal(refreshThrew.result.status, 204);
  assert.ok(
    refreshThrew.result.cookies.every((c) => /Max-Age=0/.test(c)),
    'and when it cannot run',
  );

  const stepUp = await call(
    'factorsRemove',
    goTrue({
      [`DELETE /auth/v1/factors/${FACTOR}`]: () =>
        new Response(JSON.stringify({ code: 422, error_code: 'insufficient_aal', msg: 'AAL2 required' }), {
          status: 422,
        }),
    }),
    { cookie: both },
  );
  assert.equal(stepUp.result.status, 403);
  assert.equal(parsed(stepUp.result).code, 'E_MFA_STEP_UP_REQUIRED');
  assert.equal(stepUp.calls.length, 1, 'no refresh after a refused removal');
  assert.deepEqual(stepUp.result.cookies, []);

  assert.deepEqual(
    seen.filter((e) => e.event === 'gotrue_refused'),
    [
      {
        event: 'gotrue_refused',
        code: 'E_MFA_CODE_INVALID',
        gotrueStatus: 422,
        gotrueErrorCode: 'mfa_verification_failed',
      },
      { event: 'gotrue_refused', code: 'E_RATE_LIMITED', gotrueStatus: 429, gotrueErrorCode: 'unknown' },
      {
        event: 'gotrue_refused',
        code: 'E_MFA_STEP_UP_REQUIRED',
        gotrueStatus: 422,
        gotrueErrorCode: 'insufficient_aal',
      },
    ],
  );
  const log = JSON.stringify(seen);
  const forbidden = [
    FIXTURE.answer.totp.secret,
    FIXTURE.answer.totp.uri,
    'otpauth://',
    '<svg',
    FIXTURE.answer.totp.qr_code.slice(200, 260),
    CHALLENGE,
    '123456',
    '654321',
    '000111',
    'r-1',
    '@',
  ];
  for (const s of forbidden) assert.ok(!log.includes(s), `a log line carried ${s.slice(0, 20)}`);
  for (const res of responses.filter((r) => r.status >= 400))
    for (const s of forbidden) assert.ok(!(res.body ?? '').includes(s), `a refusal carried ${s.slice(0, 20)}`);
});
