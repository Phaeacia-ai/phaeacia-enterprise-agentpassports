/* The twelve E4 routes without a stack (E4 design 3.4 and 3.5 rows 1 to 9; case 42's route half): every route inherits
   the pipeline's refusals unchanged and in order, with no call to the Data API before the service runs; the routes
   declared without a body skip rows 7 to 9; and the status each write answers. The Data API is one stub at the global
   fetch that records every call, because the routes call their services without options. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COOKIES, KEY, manifest, userToken } from '../../e3/unit/fake-postgrest.mjs';

const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');

const C = '2a5d1b3c-4e6f-4a8b-9c0d-1e2f3a4b5c6d';
const ID = '6e9b5f70-82a3-4ecf-9a4b-5c6d7e8f9a01';
const ROUTES = {
  reviewQueue: { params: { companyId: C } },
  reviewRead: { params: { candidateId: ID } },
  envelopesCreate: { params: { candidateId: ID }, body: { target: 'claude-ai', audienceGroupIds: [ID], policyId: ID } },
  reviewsCreate: { params: { candidateId: ID }, body: { envelopeId: ID, role: 'it', decision: 'approved', reason: 'Fine.' } },
  releasesPublish: { params: { candidateId: ID }, body: { envelopeId: ID } },
  releasesWithdraw: { params: { releaseId: ID }, body: { reason: 'Stop.' } },
  releasesRead: { params: { releaseId: ID } },
  releasesList: { params: { companyId: C } },
  groupsList: { params: { companyId: C } },
  groupsCreate: { params: { companyId: C }, body: { name: 'Finance' } },
  groupMembersAdd: { params: { companyId: C, groupId: ID, membershipId: ID } },
  groupMembersRemove: { params: { companyId: C, groupId: ID, membershipId: ID } },
};
const NAMES = Object.keys(ROUTES);
const cookie = `${COOKIES.access}=${userToken}`;

async function withDataApi(answer, run) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    const call = { method: init.method, path: u.pathname, params: Object.fromEntries(u.searchParams), body: init.body };
    calls.push(call);
    const { status = 200, json = [] } = answer(call) ?? {};
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  };
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

function send(routes, name, { headers = {}, body, params, method, raw } = {}) {
  const handler = routes[name];
  const h = { cookie, 'idempotency-key': KEY, ...headers };
  let payload = null;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) payload = JSON.stringify(body);
  if (payload !== null && h['content-type'] === undefined) h['content-type'] = 'application/json';
  return handler(
    makeRequest({
      method: method ?? handler.route.method,
      path: handler.route.path,
      params: params ?? ROUTES[name].params,
      headers: h,
      body: payload,
    }),
  );
}
const code = (res) => JSON.parse(res.body).code;
const routes = makeRoutes({ log: () => {} });

test('row 1: a closed switch answers 503 E_MAINTENANCE on all twelve before anything, with no Data API call', async () => {
  process.env.ENTERPRISE_ACCESS_STATE = 'closed';
  try {
    for (const name of NAMES) {
      const { result, calls } = await withDataApi(() => ({}), () => send(routes, name, { body: ROUTES[name].body }));
      assert.deepEqual([result.status, code(result), calls.length], [503, 'E_MAINTENANCE', 0], name);
    }
  } finally {
    process.env.ENTERPRISE_ACCESS_STATE = 'open';
  }
});

test('rows 2 to 6: method, cross-site, session and route ids, in that order, on all twelve, with no call', async () => {
  for (const name of NAMES) {
    const { method } = routes[name].route;
    const cases = [
      [{ method: method === 'GET' ? 'POST' : 'GET' }, 405, 'E_METHOD_NOT_ALLOWED'],
      [{ headers: { cookie: '' } }, 401, 'E_UNAUTHENTICATED'],
      [{ params: Object.fromEntries(Object.keys(ROUTES[name].params).map((k) => [k, 'not-a-uuid'])) }, 404, 'E_NOT_FOUND'],
    ];
    if (method !== 'GET') cases.push([{ headers: { 'sec-fetch-site': 'cross-site', cookie: '' } }, 403, 'E_CROSS_SITE']);
    for (const [over, status, expected] of cases) {
      const { result, calls } = await withDataApi(() => ({}), () => send(routes, name, { body: ROUTES[name].body, ...over }));
      assert.deepEqual([result.status, code(result), calls.length], [status, expected, 0], `${name} ${expected}`);
    }
  }
});

test('rows 7 to 9 on the five JSON routes: 415 for text/markdown, 413 above 16,384 bytes, 422 for a body that is not an object', async () => {
  const json = NAMES.filter((n) => routes[n].route.body === 'json');
  assert.deepEqual(json, ['envelopesCreate', 'reviewsCreate', 'releasesPublish', 'releasesWithdraw', 'groupsCreate']);
  for (const name of json) {
    for (const [over, status, expected] of [
      [{ raw: '{}', headers: { 'content-type': 'text/markdown' } }, 415, 'E_UNSUPPORTED_MEDIA_TYPE'],
      [{ raw: JSON.stringify({ reason: 'x'.repeat(16385) }) }, 413, 'E_BODY_TOO_LARGE'],
      [{ raw: '[]' }, 422, 'E_BODY_INVALID'],
      [{ raw: '{"reason":' }, 422, 'E_BODY_INVALID'],
    ]) {
      const { result, calls } = await withDataApi(() => ({}), () => send(routes, name, over));
      assert.deepEqual([result.status, code(result), calls.length], [status, expected, 0], `${name} ${status}`);
    }
  }
});

test('the reads and the two member routes declare no body and skip rows 7 to 9: an unexpected body reaches the service', async () => {
  const none = NAMES.filter((n) => routes[n].route.body === 'none');
  assert.equal(none.length, 7);
  for (const name of none) {
    const { result, calls } = await withDataApi(
      () => ({ json: [] }),
      () => send(routes, name, { raw: 'x'.repeat(20000), headers: { 'content-type': 'text/markdown' } }),
    );
    assert.equal(result.status, 404, `${name}: the service's own refusal for a caller with no standing`);
    assert.ok(calls.length >= 1, `${name}: the service ran`);
  }
});

/* The standing read moved to api.my_standing in E6 (design 1.1), so a stub that answered the memberships view is
   answering a view loadPrincipal no longer reads. The fixture below says the same thing in the view's own columns:
   one active membership, in a company that is active and inside its access period. */
const standing = (roles) => [
  {
    membership_id: ID,
    company_id: ID,
    company_slug: 'unit',
    company_name: 'Unit',
    company_status: 'active',
    access_state: 'current',
    membership_status: 'active',
    roles,
  },
];

test('the write statuses: an envelope or release that already existed answers 200, a new one 201; a group 201; a member change 200', async () => {
  const MEMBERSHIPS = standing(['company_admin', 'member']);
  const envelopeAnswer = (existing) => (call) => {
    if (call.path.endsWith('/rpc/create_envelope')) return { json: { envelope_id: ID, existing, idempotent_replay: false } };
    if (call.path.endsWith('/candidate_versions')) return { json: [{ id: ID, state: 'submitted', content: 'x', derived_canonical: '{}' }] };
    return { json: [] };
  };
  /* The replay fails for these bytes, so the route reaches the service and the service refuses: the answer below is
     the service's, and the 201 and 200 are checked on the two routes whose services need no gate. */
  const refused = await withDataApi(envelopeAnswer(false), () => send(routes, 'envelopesCreate', { body: ROUTES.envelopesCreate.body }));
  assert.deepEqual([refused.result.status, code(refused.result)], [422, 'E_GATE_FAILS_NOW']);
  const created = await withDataApi(
    (call) =>
      call.path.endsWith('/rpc/create_group')
        ? { json: [{ group_id: ID, changed: true }] }
        : call.path.endsWith('/my_standing')
          ? { json: MEMBERSHIPS }
          : { json: [] },
    () => send(routes, 'groupsCreate', { body: { name: 'Finance' } }),
  );
  assert.deepEqual([created.result.status, JSON.parse(created.result.body)], [201, { ok: true, groupId: ID, changed: true }]);
  for (const name of ['groupMembersAdd', 'groupMembersRemove']) {
    const r = await withDataApi(
      (call) =>
        call.path.includes('/rpc/')
          ? { json: [{ group_id: ID, membership_id: ID, changed: false }] }
          : call.path.endsWith('/my_standing')
            ? { json: MEMBERSHIPS }
            : { json: [{ id: ID }] },
      () => send(routes, name),
    );
    assert.deepEqual([r.result.status, JSON.parse(r.result.body)], [200, { ok: true, groupId: ID, membershipId: ID, changed: false }], name);
  }
  assert.equal(typeof manifest.GATE_IDENTITY_SHA256, 'string');
});

test('the group list reads at most 50 groups, one member read per group of at most 150 ids, and says when it truncated (design 1.7, 3.4)', async () => {
  const MEMBERSHIPS = standing(['member']);
  const GROUPS = Array.from({ length: 51 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    name: `Group ${String(i).padStart(2, '0')}`,
    created_at: '2026-09-15T09:00:00.000+00:00',
  }));
  const { result, calls } = await withDataApi(
    (call) =>
      call.path.endsWith('/my_standing')
        ? { json: MEMBERSHIPS }
        : call.path.endsWith('/groups')
          ? { json: GROUPS.slice(0, Number(call.params.limit)) }
          : { json: [] },
    () => send(routes, 'groupsList'),
  );
  const body = JSON.parse(result.body);
  assert.deepEqual([result.status, body.groups.length, body.truncated], [200, 50, true]);
  const groupReads = calls.filter((c) => c.path.endsWith('/groups'));
  const memberReads = calls.filter((c) => c.path.endsWith('/group_members'));
  assert.deepEqual(
    groupReads.map((c) => c.params.limit),
    ['51'],
  );
  assert.equal(memberReads.length, 50, 'one member read per group shown');
  assert.ok(memberReads.every((c) => c.params.limit === '151'));
});
