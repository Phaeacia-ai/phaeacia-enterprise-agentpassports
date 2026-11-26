/* Service-level unit checks without a stack: the principal is loaded per call and never cached,
   the invitation service writes nothing without a configured delivery, and the pure roles rule. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hs256, userClaims } from '../helpers/jwt.mjs';

const SECRET = 'example-unit-secret-with-at-least-32-characters-long';
const BASE = 'http://127.0.0.1:54321';
process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = SECRET;

const { COOKIES, verifySession } = await import('../../../lib/session.mjs');
const { loadPrincipal } = await import('../../../lib/services/principal.mjs');
const { createInvitation, normalizeEmail } = await import('../../../lib/services/invitations.mjs');
const { normalizeRoles, isAdmin } = await import('../../../lib/rules/roles.mjs');

const SUB = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11';
const COMPANY = '2a5d1b3c-4e6f-4a8b-9c0d-1e2f3a4b5c6d';
async function session(aal) {
  const token = hs256(userClaims({ sub: SUB, email: 's@example.invalid', issuer: `${BASE}/auth/v1`, aal }), SECRET);
  return (await verifySession({ headers: { cookie: `${COOKIES.access}=${token}` } })).session;
}

/* Since E6 the read is api.my_standing, the one read in the product that sees past a company's status, so that a
   member of a suspended company meets one code on a read and on a write instead of 404 on one and 409 on the
   other (E6 design 1.1). The four ordered answers are tests/e6/unit/services.test.mjs's; what this pins is that the
   read is one statement, with the caller's own token, on every call. */
const standingRow = (over = {}) => ({
  membership_id: 'm1',
  roles: ['company_admin', 'member'],
  membership_status: 'active',
  company_status: 'active',
  access_state: 'current',
  ...over,
});

test('loadPrincipal reads the standing on every call with the user token; nothing is memoised', async () => {
  const s = await session('aal2');
  const calls = [];
  const rows = [[standingRow()], []];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.authorization });
    const body = rows[calls.length - 1] ?? [];
    return { status: 200, json: async () => body };
  };
  const first = await loadPrincipal(s, COMPANY, { fetchImpl });
  assert.deepEqual(first, {
    ok: true,
    authUserId: SUB,
    membershipId: 'm1',
    roles: ['company_admin', 'member'],
    aal: 'aal2',
    companyStatus: 'active',
    accessState: 'current',
    companyName: null,
  });
  const second = await loadPrincipal(s, COMPANY, { fetchImpl });
  assert.deepEqual(second, { ok: false, code: 'E_NOT_FOUND' }, 'the second call sees the second answer, not the first');
  assert.equal(calls.length, 2);
  assert.match(
    calls[0].url,
    /\/rest\/v1\/my_standing\?select=membership_id%2Croles%2Cmembership_status%2Ccompany_status%2Caccess_state%2Ccompany_name&company_id=eq\.[0-9a-f-]+$/,
  );
  assert.match(calls[0].auth, /^Bearer eyJ/);
  const removedOnly = async () => ({
    status: 200,
    json: async () => [standingRow({ roles: ['member'], membership_status: 'removed' })],
  });
  assert.deepEqual(await loadPrincipal(s, COMPANY, { fetchImpl: removedOnly }), { ok: false, code: 'E_NOT_FOUND' });
  assert.deepEqual(await loadPrincipal(s, 'not-a-uuid', { fetchImpl }), { ok: false, code: 'E_NOT_FOUND' });
  assert.equal(calls.length, 2, 'a malformed company id never reaches the database');
});

/* E6 design 1.2 made delivery a MODE, so E_MAIL_NOT_CONFIGURED is no longer the answer to every invitation: it
   keeps its meaning for `mail` mode with no transport supplied, and there it still refuses before any read or
   write. Handover mode is E6's default and has no transport to be missing; tests/e6/unit/services.test.mjs is
   where its own answer is asserted. */
test('createInvitation in mail mode without a configured delivery refuses before any read or write', async () => {
  const s = await session('aal2');
  let touched = 0;
  const original = globalThis.fetch;
  const originalMode = process.env.ENTERPRISE_INVITATION_DELIVERY;
  process.env.ENTERPRISE_INVITATION_DELIVERY = 'mail';
  globalThis.fetch = async () => {
    touched++;
    return { status: 200, json: async () => [] };
  };
  try {
    await assert.rejects(
      createInvitation(s, { companyId: COMPANY, email: 'x@example.invalid', roles: [] }),
      (e) => e.code === 'E_MAIL_NOT_CONFIGURED',
    );
    await assert.rejects(
      createInvitation(s, { companyId: COMPANY, email: 'x@example.invalid', roles: [] }, { deliver: 'no' }),
      (e) => e.code === 'E_MAIL_NOT_CONFIGURED',
    );
  } finally {
    globalThis.fetch = original;
    if (originalMode === undefined) delete process.env.ENTERPRISE_INVITATION_DELIVERY;
    else process.env.ENTERPRISE_INVITATION_DELIVERY = originalMode;
  }
  assert.equal(touched, 0);
});

test('normalizeEmail and normalizeRoles mirror the database contracts', () => {
  assert.equal(normalizeEmail('  Reviewer@Example.COM '), 'reviewer@example.com');
  for (const bad of [
    'a b@example.invalid',
    'a@b',
    'a@@b.c',
    '',
    'x',
    null,
    undefined,
    3,
    `${'a'.repeat(250)}@example.invalid`,
  ])
    assert.equal(normalizeEmail(bad), null, String(bad));
  assert.deepEqual(normalizeRoles([]), { ok: true, roles: ['member'] });
  assert.deepEqual(normalizeRoles(['company_admin', 'member', 'company_admin']), {
    ok: true,
    roles: ['company_admin', 'member'],
  });
  for (const bad of [null, undefined, 'member', [['member']], [null], ['owner'], [1], ['member', undefined]])
    assert.deepEqual(normalizeRoles(bad), { ok: false, code: 'E_ROLES_INVALID' }, JSON.stringify(bad));
  assert.equal(isAdmin(['member', 'company_admin']), true);
  assert.equal(isAdmin(['member']), false);
  assert.equal(isAdmin('company_admin'), false);
});
