/* lib/db/server.mjs, lib/db/user.mjs, lib/db/operator.mjs (design sections 1.1, 1.3, 6 and 8.1).
   Case 20: serverToken refuses anything but the object verifySession produced. Case 25 (unit part):
   the operator client accepts /auth/v1/admin/ paths only. No stack: fetch is injected. */
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { test } from 'node:test';

import { hs256, userClaims } from '../helpers/jwt.mjs';

const SECRET = 'example-unit-secret-with-at-least-32-characters-long';
const BASE = 'http://127.0.0.1:54321';
process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = SECRET;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'example-service-role-key-never-logged';

const { COOKIES, verifySession } = await import('../../../lib/session.mjs');
const { FUNCTIONS, rpc, serverToken } = await import('../../../lib/db/server.mjs');
const { select } = await import('../../../lib/db/user.mjs');
const { ACCOUNT_LINK_FAILED, createInviteeAccount } = await import('../../../lib/services/invitations.mjs');

const SUB = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11';
const decode = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url'));
async function session(aal) {
  const token = hs256(userClaims({ sub: SUB, email: 's@example.invalid', issuer: `${BASE}/auth/v1`, aal }), SECRET);
  const v = await verifySession({ headers: { cookie: `${COOKIES.access}=${token}` } });
  assert.equal(v.ok, true);
  return v.session;
}
const fakeFetch = (status, body, log = []) => {
  const f = async (url, init) => {
    log.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  f.log = log;
  return f;
};
/* One answer per call, in order; a call past the list answers 500 so a test sees an extra request. */
const fakeFetchSequence = (answers, log = []) => {
  let i = 0;
  const f = async (url, init) => {
    log.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body });
    const [status, body] = answers[i++] ?? [500, {}];
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  f.log = log;
  return f;
};

test('case 20: serverToken refuses a plain object, a copy and a lookalike; accepts the verified session', async () => {
  const s = await session('aal2');
  for (const x of [{ authUserId: SUB, aal: 'aal2' }, { ...s }, Object.freeze({ ...s }), null, undefined, SUB]) {
    assert.throws(() => serverToken(x), /not a VerifiedSession/);
  }
  const t = serverToken(s);
  assert.equal(typeof t, 'string');
});

test('the server token copies sub and aal verbatim from the verified session, 60 s, HS256 by default', async () => {
  for (const aal of ['aal1', 'aal2', undefined]) {
    const s = await session(aal);
    const t = serverToken(s, { now: 1_800_000_000 });
    const c = decode(t);
    assert.deepEqual(c, {
      role: 'app_server',
      sub: SUB,
      aal: aal ?? 'aal1',
      iss: 'phaeacia-server',
      iat: 1_800_000_000,
      exp: 1_800_000_060,
    });
    const [h, p, sig] = t.split('.');
    assert.equal(createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url'), sig);
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  }
});

test('ES256 signing mode uses the configured private key and kid', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.ENTERPRISE_SERVER_SIGNING_ALG = 'ES256';
  process.env.ENTERPRISE_SERVER_SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
  process.env.ENTERPRISE_SERVER_SIGNING_KID = 'server-k1';
  try {
    const t = serverToken(await session('aal2'));
    const [h, p, sig] = t.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', typ: 'JWT', kid: 'server-k1' });
    const ok = cryptoVerify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig, 'base64url'),
    );
    assert.equal(ok, true);
  } finally {
    delete process.env.ENTERPRISE_SERVER_SIGNING_ALG;
    delete process.env.ENTERPRISE_SERVER_SIGNING_KEY;
    delete process.env.ENTERPRISE_SERVER_SIGNING_KID;
  }
});

test('rpc posts to /rest/v1/rpc/<fn> with the server bearer and the anon apikey; unknown names refused', async () => {
  const s = await session('aal2');
  const t = serverToken(s);
  const f = fakeFetch(200, [{ membership_id: 'm', roles: ['member'], changed: false }]);
  const rows = await rpc('set_roles', { p_membership: 'm', p_roles: ['member'] }, t, { fetchImpl: f });
  assert.deepEqual(rows, [{ membership_id: 'm', roles: ['member'], changed: false }]);
  assert.equal(f.log[0].url, `${BASE}/rest/v1/rpc/set_roles`);
  assert.equal(f.log[0].method, 'POST');
  assert.equal(f.log[0].headers.authorization, `Bearer ${t}`);
  assert.equal(f.log[0].headers.apikey, 'unit-anon-key');
  assert.deepEqual(JSON.parse(f.log[0].body), { p_membership: 'm', p_roles: ['member'] });
  await assert.rejects(rpc('drop_everything', {}, t, { fetchImpl: f }), /not an api function/);
  await assert.rejects(rpc('set_roles', {}, 'not-a-token', { fetchImpl: f }), /server token/);
  assert.deepEqual([...FUNCTIONS].sort(), [
    'accept_invitation',
    'add_group_member',
    'add_operator',
    'authorize_download',
    'claim_invitation_handover',
    'close_company',
    'create_company',
    'create_group',
    'delete_company',
    'departure_preview',
    'export_company',
    'invite_member',
    'mfa_verify_begin',
    'mfa_verify_end',
    'operator_expiry_run',
    'operator_export_manifest',
    'operator_invite_admin',
    'operator_register',
    'provision_company',
    'record_invitation_delivery',
    'remove_group_member',
    'remove_member',
    'revoke_invitation',
    'set_access_period',
    'set_company_quota',
    'set_company_status',
    'set_display_name',
    'set_roles',
    'transfer_agent',
    'transfer_first_admin',
  ]);
});

test('an importer cannot widen the thirty-name rpc allowlist (E3-PREQ-D1; set_display_name joined with 004, the group routines with 006, authorize_download with 007, the thirteen lifecycle routines ahead of the E6 migration, record_invitation_delivery with 010, claim_invitation_handover with 011, the two bound routines with 012)', async () => {
  /* Object.freeze on a Set freezes the object and not its entries: FUNCTIONS.add('save_draft') used to
     succeed, and rpc then posted a name outside the allowlist (evidence/e3-prereq-critique.md, finding
     3). Every route an importer has to the exported value must refuse, and rpc must still refuse. */
  const t = serverToken(await session('aal2'));
  const widen = [
    ['add', () => FUNCTIONS.add('save_draft')],
    ['Set.prototype.add', () => Set.prototype.add.call(FUNCTIONS, 'save_draft')],
    ['push', () => FUNCTIONS.push('save_draft')],
    ['Array.prototype.push', () => Array.prototype.push.call(FUNCTIONS, 'save_draft')],
    [
      'index past the end',
      () => {
        FUNCTIONS[30] = 'save_draft';
      },
    ],
    [
      'overwrite an entry',
      () => {
        FUNCTIONS[0] = 'save_draft';
      },
    ],
  ];
  for (const [how, attempt] of widen) assert.throws(attempt, TypeError, how);
  const f = fakeFetch(200, {});
  for (const name of ['save_draft', 'create_draft']) {
    await assert.rejects(rpc(name, {}, t, { fetchImpl: f }), /not an api function/, name);
  }
  assert.equal(f.log.length, 0, 'nothing was sent');
  assert.equal([...FUNCTIONS].length, 30);
});

test('rpc maps PostgREST errors through lib/errors and forwards no details', async () => {
  const t = serverToken(await session('aal2'));
  const f = fakeFetch(400, {
    code: 'P0002',
    message: 'E_NOT_FOUND',
    details: 'Failing row contains (synthetic-reviewer@example.invalid)',
    hint: null,
  });
  await assert.rejects(rpc('set_roles', {}, t, { fetchImpl: f }), (e) => {
    assert.equal(e.code, 'E_NOT_FOUND');
    assert.equal(e.status, 404);
    assert.ok(!JSON.stringify({ ...e, message: e.message, stack: e.stack }).includes('example.invalid'));
    return true;
  });
  const busy = fakeFetch(500, {
    code: '55P03',
    message: 'canceling statement due to lock timeout',
    details: null,
    hint: null,
  });
  await assert.rejects(rpc('set_roles', {}, t, { fetchImpl: busy }), (e) => e.code === 'E_BUSY' && e.status === 409);
  const jwt = fakeFetch(401, { code: 'PGRST301', message: 'JWSError', details: null, hint: null });
  await assert.rejects(rpc('set_roles', {}, t, { fetchImpl: jwt }), (e) => e.code === 'E_INTERNAL' && e.status === 500);
});

test('the user client reads api views with the browser token, GET only, allowlisted views and filters', async () => {
  const s = await session('aal1');
  const f = fakeFetch(200, [{ id: 'm1', roles: ['member'], status: 'active' }]);
  const rows = await select(
    s,
    'memberships',
    { select: 'id,roles,status', company_id: `eq.${SUB}`, user_id: `eq.${SUB}` },
    { fetchImpl: f },
  );
  assert.deepEqual(rows, [{ id: 'm1', roles: ['member'], status: 'active' }]);
  assert.equal(f.log[0].method, 'GET');
  assert.equal(f.log[0].headers.apikey, 'unit-anon-key');
  assert.match(f.log[0].headers.authorization, /^Bearer eyJ/);
  assert.equal(
    f.log[0].url,
    `${BASE}/rest/v1/memberships?select=id%2Croles%2Cstatus&company_id=eq.${SUB}&user_id=eq.${SUB}`,
  );
  await assert.rejects(select({ ...s }, 'memberships', {}, { fetchImpl: f }), /not a VerifiedSession/);
  await assert.rejects(select(s, 'rpc/set_roles', {}, { fetchImpl: f }), /not a readable view/);
  await assert.rejects(select(s, 'memberships', { or: '(id.eq.1,id.eq.2)' }, { fetchImpl: f }), /filter/);
  await assert.rejects(select(s, 'memberships', { company_id: 'eq.x;drop' }, { fetchImpl: f }), /filter/);
  const err = fakeFetch(500, { code: 'XX000', message: 'boom', details: 'row', hint: null });
  await assert.rejects(select(s, 'memberships', {}, { fetchImpl: err }), (e) => e.code === 'E_INTERNAL');
  /* XR-12's remainder: the read's failure keeps the database's code and its status, and nothing else of the body. */
  const timeout = fakeFetch(500, { code: '57014', message: 'canceling statement', details: 'row', hint: 'h' });
  await assert.rejects(select(s, 'memberships', {}, { fetchImpl: timeout }), (e) => {
    assert.deepEqual(e.cause, { postgrestStatus: 500, dbCode: '57014' });
    return e.code === 'E_INTERNAL';
  });
  const odd = fakeFetch(500, { code: 'synthetic tenant text', message: 'boom' });
  await assert.rejects(select(s, 'memberships', {}, { fetchImpl: odd }), (e) => e.cause.dbCode === undefined);
});

/* Pages design 2.2, option (A), decided by the lead 2026-09-13: the user client admits one long value, an in.(...) list
   of one to 150 lowercase uuids matched exactly, beside the unchanged 400-character alphabet. Every row goes through the
   real select with an injected fetch: an admitted value reaches the URL whole, a refused one is refused before any
   request. Each refused value is longer than 400 characters, so the unchanged bound cannot be what admits or refuses it. */
test('option (A): an exact in.(...) list of 1 to 150 lowercase uuids is admitted beside the 400-character bound, and nothing else long', async () => {
  const s = await session('aal1');
  const id = (n) => `0f7d3a51-2f4a-4a7b-9c3e-${String(n).padStart(12, '0')}`;
  const ids = (count, from = 1) => Array.from({ length: count }, (_, i) => id(from + i));
  const list = (items) => `in.(${items.join(',')})`;
  const admitted = async (label, value) => {
    const f = fakeFetch(200, []);
    await select(s, 'profiles', { select: 'user_id,display_name', user_id: value }, { fetchImpl: f });
    assert.equal(f.log.length, 1, `${label}: one request`);
    assert.equal(new URL(f.log[0].url).searchParams.get('user_id'), value, `${label}: the value reaches the URL whole`);
  };
  const refused = async (label, value, key = 'user_id') => {
    const f = fakeFetch(200, []);
    await assert.rejects(select(s, 'profiles', { [key]: value }, { fetchImpl: f }), /refused filter/, label);
    assert.equal(f.log.length, 0, `${label}: nothing was sent`);
  };

  for (const n of [1, 10, 11, 150]) await admitted(`${n} uuids`, list(ids(n)));
  assert.ok(list(ids(10)).length <= 400, 'ten uuids fit the old bound');
  assert.ok(list(ids(11)).length > 400, 'eleven do not, so the exception is what admits them');
  assert.equal(list(ids(150)).length, 4 + 37 * 150, 'the design’s arithmetic, 4 + 37n: 5,554 characters at the bound');

  const eleven = ids(11);
  const long = (label, value) => {
    assert.ok(value.length > 400, `${label} is longer than 400 characters`);
    return refused(label, value);
  };
  await long('151 uuids', list(ids(151)));
  await long('an uppercase uuid', list([...eleven.slice(0, 10), eleven[10].toUpperCase()]));
  await long('an item that is not a uuid', list([...eleven.slice(0, 10), 'g'.repeat(36)]));
  await long('a space after a comma', `in.(${eleven.slice(0, 5).join(',')}, ${eleven.slice(5).join(',')})`);
  await long('a doubled comma', `in.(${eleven.slice(0, 5).join(',')},,${eleven.slice(5).join(',')})`);
  await long('a trailing comma', `in.(${eleven.join(',')},)`);
  await long('a leading comma, an empty first item', `in.(,${eleven.join(',')})`);
  await long('text before in.(', `not.${list(eleven)}`);
  await long('another operator ending in in.(', `xin.(${eleven.join(',')})`);
  await long('text after )', `${list(eleven)}x`);
  await long('a second list after )', `${list(eleven)},(${eleven[0]})`);
  await long('no closing parenthesis', `in.(${eleven.join(',')}`);
  await long('401 characters of the alphabet that are not a list', 'a'.repeat(401));

  /* The logic keys stay refused whatever their value, the exact list included. */
  for (const key of ['or', 'and', 'not']) await refused(`the logic key ${key} with an exact list`, list(eleven), key);

  /* A value the exception does not admit is judged by the unchanged alphabet exactly as before, so a short malformed
     list inside it is still admitted: the exception admits no long value but the exact list, and it is not a validator
     of short ones (design 2.2). */
  await admitted('a short malformed list inside the alphabet', 'in.(a,,b)');
  await admitted('an empty list, five characters', 'in.()');
});

test('case 25 (unit): createInviteeAccount uses the operator client against /auth/v1/admin/ only', async () => {
  /* Since E6P-F1-C-F1 the call refreshes BOTH token columns every time: `signup` first (tolerating a new
     address's 400 and a confirmed account's 422), then `magiclink`, which is the token handed back. So it is
     always two admin requests, both generate_link, against the admin path, and the returned type is the
     magiclink step's; see the note on the function. */
  const two = fakeFetchSequence([
    [200, { id: 'u', hashed_token: 'hs', verification_type: 'signup', action_link: 'http://x' }],
    [200, { id: 'u', hashed_token: 'hm', verification_type: 'magiclink', action_link: 'http://x' }],
  ]);
  const r = await createInviteeAccount('r@example.invalid', { fetchImpl: two });
  /* signup 200 is an existing UNCONFIRMED account: GoTrue agrees nobody has signed in to it (ENA-7, `unclaimed`). */
  assert.deepEqual(r, { hashedToken: 'hm', verificationType: 'magiclink', unclaimed: true });
  assert.equal(two.log.length, 2, 'signup then magiclink');
  for (const l of two.log) {
    const u = new URL(l.url);
    assert.equal(u.origin, BASE);
    assert.equal(u.pathname, '/auth/v1/admin/generate_link');
    assert.equal(l.headers.authorization, 'Bearer example-service-role-key-never-logged');
  }
  assert.deepEqual(
    two.log.map((l) => JSON.parse(l.body).type),
    ['signup', 'magiclink'],
  );

  /* A brand-new address: signup 400 (nothing created), then the magiclink that creates the account UNCONFIRMED. */
  const created = fakeFetchSequence([
    [400, { code: 400, msg: 'Signup requires a valid password' }],
    [200, { id: 'u2', hashed_token: 'h2', verification_type: 'signup', action_link: 'http://x' }],
  ]);
  assert.deepEqual(await createInviteeAccount('n@example.invalid', { fetchImpl: created }), {
    hashedToken: 'h2',
    verificationType: 'signup',
    unclaimed: true,
  });
  assert.equal(created.log.length, 2, 'a new address is still two requests');

  /* A confirmed account: signup 422, then the magiclink that replaces its one token. */
  const confirmed = fakeFetchSequence([
    [422, { code: 422, msg: 'already registered' }],
    [200, { id: 'u3', hashed_token: 'h3', verification_type: 'magiclink', action_link: 'http://x' }],
  ]);
  assert.deepEqual(await createInviteeAccount('c@example.invalid', { fetchImpl: confirmed }), {
    hashedToken: 'h3',
    verificationType: 'magiclink',
    unclaimed: false,
  });

  /* ENA-7 (ENA7-C3): in handover mode a confirmed account gets no magiclink at all, so no token is minted to be thrown
     away and the person's own resend timer is not started. Mail mode, above, still makes both calls. */
  const confirmedHandover = fakeFetchSequence([[422, { code: 422, msg: 'already registered' }]]);
  assert.deepEqual(
    await createInviteeAccount('c@example.invalid', { fetchImpl: confirmedHandover }, { handover: true }),
    { unclaimed: false },
  );
  assert.equal(confirmedHandover.log.length, 1, 'signup only');

  /* A 400 whose magiclink does NOT report creating the account (another call made it between the two) is not
     unclaimed by GoTrue's own account, so it reads as claimed: a code-only link, the safe side. */
  const raced = fakeFetchSequence([
    [400, { code: 400, msg: 'Signup requires a valid password' }],
    [200, { id: 'u4', hashed_token: 'h4', verification_type: 'magiclink', action_link: 'http://x' }],
  ]);
  assert.equal(
    (await createInviteeAccount('r2@example.invalid', { fetchImpl: raced }, { handover: true })).unclaimed,
    false,
  );

  /* CR-ENA7-3: signup 200 (unconfirmed then), but the magiclink answer's account is confirmed: an earlier link was
     used between the two calls. Not unclaimed, so its token is not handed. FAIL-BEFORE at 717815d: unclaimed true. */
  const confirmedBetween = fakeFetchSequence([
    [200, { id: 'u5', hashed_token: 'hs', verification_type: 'signup', action_link: 'http://x' }],
    [
      200,
      {
        id: 'u5',
        hashed_token: 'h5',
        verification_type: 'magiclink',
        action_link: 'http://x',
        email_confirmed_at: '2026-10-24T10:00:00Z',
      },
    ],
  ]);
  assert.equal(
    (await createInviteeAccount('r3@example.invalid', { fetchImpl: confirmedBetween }, { handover: true })).unclaimed,
    false,
  );

  /* Any other refusal of signup fails closed: no magiclink follows, so no account is created behind a failed guard. */
  const down = fakeFetchSequence([[503, { msg: 'unavailable' }]]);
  await assert.rejects(
    createInviteeAccount('d@example.invalid', { fetchImpl: down }),
    (e) => e.message === ACCOUNT_LINK_FAILED,
  );
  assert.equal(down.log.length, 1, 'a 503 on signup is not followed by a magiclink');

  /* The hook's refusal for an uninvited address (403 on the creating magiclink after the 400), or any non-2xx, is
     the one fixed word ACCOUNT_LINK_FAILED with no GoTrue text and no key in the error; deliverInvitation turns it
     into the `failed` answer (E7 1.1; E_DELIVERY_FAILED is retired). */
  const refused = fakeFetchSequence([
    [400, { code: 400, msg: 'Signup requires a valid password' }],
    [403, { code: 403, msg: 'Invitation required.' }],
  ]);
  await assert.rejects(createInviteeAccount('x@example.invalid', { fetchImpl: refused }), (e) => {
    assert.equal(e.message, ACCOUNT_LINK_FAILED);
    assert.equal(e.code, undefined);
    assert.ok(!JSON.stringify({ ...e, message: e.message, stack: e.stack }).includes('example-service-role-key'));
    return true;
  });
});

test('M1: adminRequest refuses encoded and literal traversal, foreign origins and empty operations before any fetch', async () => {
  const { adminRequest } = await import('../../../lib/db/operator.mjs');
  const refused = [
    '/auth/v1/admin/%2e%2e/%2e%2e/%2e%2e/rest/v1/companies',
    '/auth/v1/admin/../../../rest/v1/companies',
    '/auth/v1/admin/%2E%2E/rest/v1/companies',
    '/auth/v1/admin/x/..%5crest',
    '/auth/v1/admin/..\\rest/v1/companies',
    '/auth/v1/admin\\generate_link',
    '/auth/v1/admin/%67enerate_link',
    'http://evil.example.invalid/auth/v1/admin/generate_link',
    'https://127.0.0.1:54321/auth/v1/admin/generate_link',
    '//evil.example.invalid/auth/v1/admin/generate_link',
    '/auth/v1/admin/',
    '/auth/v1/admin',
    '/auth/v1/admin/generate_link?x=1',
    '/auth/v1/admin/generate_link#f',
    'auth/v1/admin/generate_link',
    '/rest/v1/companies',
    '',
    42,
  ];
  for (const path of refused) {
    const f = fakeFetch(200, {});
    await assert.rejects(adminRequest(path, { body: {} }, { fetchImpl: f }), TypeError, `refused: ${String(path)}`);
    assert.equal(f.log.length, 0, `no fetch for ${String(path)}`);
  }
  const ok = fakeFetch(200, { id: 'u' });
  const r = await adminRequest('/auth/v1/admin/generate_link', { body: { a: 1 } }, { fetchImpl: ok });
  assert.deepEqual(r, { status: 200, json: { id: 'u' } });
  assert.equal(ok.log.length, 1);
  assert.equal(ok.log[0].url, `${BASE}/auth/v1/admin/generate_link`);
});
