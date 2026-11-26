/* E2 handler and service tests against the running local stack (design section 9). Seeds through
   tests/db/00-seed.sh once, then exercises the route functions of lib/http/routes.mjs with cookie
   sessions: real GoTrue tokens (password grant, aal1) and, for aal2, tokens minted with the local
   secret (the stack has no TOTP enrolment; the honest limit is recorded in the evidence). Cases:
   19 (stack), 21, 23 (email normalisation), handler-level 1, 2, 7, 8, 9, 10, 13, 18 (server-created
   account and single-use link through the verify route), roles drift (scenario C). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ORIGIN, mintUserToken, seed, sql, userJwt } from '../helpers/stack.mjs';

/* E6 design 1.2 made delivery a MODE and made `handover` its default, so an invitation now answers the accept
   link to its caller unless the server is configured for mail. THIS FILE IS THE MAIL PATH, which E6 keeps
   unchanged: a transport receives the link, the answer carries none of it, and an absent transport is 503
   E_MAIL_NOT_CONFIGURED before any write. The handover path is tests/e6/stack/routes.test.mjs's, where the link
   in the answer is the exit evidence. Setting the mode here rather than rewriting the arms keeps every accepted
   assertion of this file, including the one that no answer of it carries an invitation secret. */
process.env.ENTERPRISE_INVITATION_DELIVERY = 'mail';

const ids = seed();
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { ROLE_NAMES } = await import('../../../lib/rules/roles.mjs');

const delivered = [];
const logged = [];
const routes = makeRoutes({ deliver: async (m) => delivered.push(m), log: (e) => logged.push(e) });
const unconfigured = makeRoutes({ log: (e) => logged.push(e) });
const responses = [];

const email = (who) => `synthetic-${who}@example.invalid`;
const real = (who) => userJwt(email(who), ids.PW);
const aal2 = (who, sub) => mintUserToken({ sub, email: email(who), aal: 'aal2' });
const call = async (fn, { method = 'POST', params = {}, token, body, headers = {} } = {}) => {
  const h = { ...headers };
  if (token) h.cookie = `${COOKIES.access}=${token}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fn(
    makeRequest({
      method,
      path: '/api/test',
      params,
      headers: h,
      body: body === undefined ? null : JSON.stringify(body),
    }),
  );
  const parsed = res.body === null ? null : JSON.parse(res.body);
  responses.push({ status: res.status, body: res.body, cookies: res.cookies });
  return { status: res.status, body: parsed, res };
};
const audits = () => Number(sql('select count(*) from app.audit_events'));
const membershipOf = (userId, company) =>
  sql(
    `select id || ' ' || status || ' ' || array_to_string(roles, ',') from app.memberships where user_id='${userId}' and company_id='${company}'`,
  );

const T = {
  admin1: real('alpha-admin1'),
  admin1aal2: aal2('alpha-admin1', ids.U_alpha_admin1),
  admin2aal2: aal2('alpha-admin2', ids.U_alpha_admin2),
  member: real('alpha-member'),
  memberAal2: aal2('alpha-member', ids.U_alpha_member),
  removedAal2: aal2('alpha-removed', ids.U_alpha_removed),
  betaAal2: aal2('beta-member', ids.U_beta_member),
  outsiderAal2: aal2('outsider', ids.U_outsider),
  opAal2: aal2('op', ids.U_op),
  op: real('op'),
};
const M = {
  admin1: membershipOf(ids.U_alpha_admin1, ids.ALPHA).split(' ')[0],
  admin2: membershipOf(ids.U_alpha_admin2, ids.ALPHA).split(' ')[0],
  member: membershipOf(ids.U_alpha_member, ids.ALPHA).split(' ')[0],
  removed: membershipOf(ids.U_alpha_removed, ids.ALPHA).split(' ')[0],
  beta: membershipOf(ids.U_beta_member, ids.BETA).split(' ')[0],
};
const setRoles = (token, company, membership, roles) =>
  call(routes.membersSetRoles, {
    method: 'PATCH',
    params: { companyId: company, membershipId: membership },
    token,
    body: { roles },
  });

test('scenario C: lib/rules/roles.mjs mirrors app.role_names()', () => {
  const db = sql("select array_to_string(app.role_names(), ',')").split(',');
  assert.deepEqual([...ROLE_NAMES], db);
});

test('case 19 (stack): a real GoTrue cookie reaches the handler; an admin at aal1 is refused by the database with 403 E_ADMIN_MFA_REQUIRED', async () => {
  const before = audits();
  const r = await setRoles(T.admin1, ids.ALPHA, M.member, ['member', 'it_reviewer']);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'E_ADMIN_MFA_REQUIRED');
  assert.equal(audits(), before, 'no audit row for a refused call');
  assert.equal(membershipOf(ids.U_alpha_member, ids.ALPHA), `${M.member} active member`);
});

test('an admin at aal2 changes roles; the same roles again is changed:false with no audit row', async () => {
  const before = audits();
  const r = await setRoles(T.admin1aal2, ids.ALPHA, M.member, ['it_reviewer']);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, membershipId: M.member, roles: ['it_reviewer', 'member'], changed: true });
  assert.equal(audits(), before + 1);
  const again = await setRoles(T.admin1aal2, ids.ALPHA, M.member, ['member', 'it_reviewer', 'it_reviewer']);
  assert.deepEqual(again.body, { ok: true, membershipId: M.member, roles: ['it_reviewer', 'member'], changed: false });
  assert.equal(audits(), before + 1);
});

test('case 21: a target membership from another company under the route company is 404 and writes nothing', async () => {
  const before = audits();
  const r = await setRoles(T.admin1aal2, ids.ALPHA, M.beta, ['member']);
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'E_NOT_FOUND');
  const rm = await call(routes.membersRemove, {
    method: 'DELETE',
    params: { companyId: ids.ALPHA, membershipId: M.beta },
    token: T.admin1aal2,
  });
  assert.equal(rm.status, 404);
  assert.equal(audits(), before);
  assert.match(membershipOf(ids.U_beta_member, ids.BETA), / active company_admin,member$/);
  /* Control: the beta admin, whose company matches, changes the same membership's roles. */
  const ok = await setRoles(T.betaAal2, ids.BETA, M.beta, ['company_admin', 'business_reviewer']);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.changed, true);
  /* The case that only the handler can refuse: alpha's admin is also an admin of beta, so the
     database would accept the change and audit it under beta while the URL names alpha. */
  sql(
    `insert into app.memberships (company_id, user_id, roles) values ('${ids.BETA}', '${ids.U_alpha_admin1}', '{company_admin,member}')`,
  );
  try {
    const both = audits();
    const mismatch = await setRoles(T.admin1aal2, ids.ALPHA, M.beta, ['member']);
    assert.equal(mismatch.status, 404, JSON.stringify(mismatch.body));
    assert.equal(audits(), both, 'no audit row under either company');
    assert.match(membershipOf(ids.U_beta_member, ids.BETA), / active business_reviewer,company_admin,member$/);
    const matching = await setRoles(T.admin1aal2, ids.BETA, M.beta, ['company_admin']);
    assert.equal(matching.status, 200, 'the same actor under the matching route company succeeds');
    assert.equal(
      sql(`select company_id from app.audit_events where id = (select max(id) from app.audit_events)`),
      ids.BETA,
    );
  } finally {
    sql(
      `update app.memberships set status='removed', removed_at=now() where company_id='${ids.BETA}' and user_id='${ids.U_alpha_admin1}'`,
    );
  }
});

test('handler-level cases 1, 2 and 17: foreign company, unknown company, outsider, removed member and non-admin answer 404 or 403', async () => {
  const before = audits();
  const foreign = await setRoles(T.admin1aal2, ids.BETA, M.beta, ['member']);
  assert.equal(foreign.status, 404);
  const unknown = await setRoles(T.admin1aal2, '00000000-0000-4000-8000-000000000000', M.member, ['member']);
  assert.equal(unknown.status, 404);
  const outsider = await setRoles(T.outsiderAal2, ids.ALPHA, M.member, ['member']);
  assert.equal(outsider.status, 404);
  const removed = await setRoles(T.removedAal2, ids.ALPHA, M.member, ['member']);
  assert.equal(removed.status, 404);
  const nonAdmin = await setRoles(T.memberAal2, ids.ALPHA, M.admin2, ['member']);
  assert.equal(nonAdmin.status, 403);
  assert.equal(nonAdmin.body.code, 'E_FORBIDDEN');
  assert.equal(audits(), before);
});

test('handler-level case 9: nested, null, unknown and non-array roles are 422 E_ROLES_INVALID; empty means member only', async () => {
  for (const roles of [[['member']], [null], ['owner'], 'member', null, [1], [{}]]) {
    const r = await setRoles(T.admin1aal2, ids.ALPHA, M.member, roles);
    assert.equal(r.status, 422, JSON.stringify(roles));
    assert.equal(r.body.code, 'E_ROLES_INVALID');
  }
  const missing = await call(routes.membersSetRoles, {
    method: 'PATCH',
    params: { companyId: ids.ALPHA, membershipId: M.member },
    token: T.admin1aal2,
    body: {},
  });
  assert.equal(missing.status, 422);
  const empty = await setRoles(T.admin1aal2, ids.ALPHA, M.member, []);
  assert.deepEqual(empty.body, { ok: true, membershipId: M.member, roles: ['member'], changed: true });
});

test('handler-level case 11 (sequential form): demoting the last admin is 409 E_LAST_ADMIN', async () => {
  const demote2 = await setRoles(T.admin1aal2, ids.ALPHA, M.admin2, ['member']);
  assert.equal(demote2.status, 200, JSON.stringify(demote2.body));
  const self = await setRoles(T.admin1aal2, ids.ALPHA, M.admin1, ['member']);
  assert.equal(self.status, 409);
  assert.equal(self.body.code, 'E_LAST_ADMIN');
  const selfRemove = await call(routes.membersRemove, {
    method: 'DELETE',
    params: { companyId: ids.ALPHA, membershipId: M.admin1 },
    token: T.admin1aal2,
  });
  assert.equal(selfRemove.status, 409);
  assert.equal(selfRemove.body.code, 'E_LAST_ADMIN');
  const restore = await setRoles(T.admin1aal2, ids.ALPHA, M.admin2, ['company_admin']);
  assert.equal(restore.body.changed, true);
  const demotedAdminActs = await setRoles(T.admin2aal2, ids.ALPHA, M.member, ['business_reviewer']);
  assert.equal(demotedAdminActs.status, 200, 'restored admin acts again');
});

test('handler-level case 2: removal, idempotent repeat, and the removed member is stale at once', async () => {
  const before = audits();
  const r = await call(routes.membersRemove, {
    method: 'DELETE',
    params: { companyId: ids.ALPHA, membershipId: M.member },
    token: T.admin1aal2,
  });
  assert.deepEqual(r.body, { ok: true, membershipId: M.member, status: 'removed', changed: true });
  assert.equal(audits(), before + 1);
  const again = await call(routes.membersRemove, {
    method: 'DELETE',
    params: { companyId: ids.ALPHA, membershipId: M.member },
    token: T.admin1aal2,
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.changed, false);
  assert.equal(audits(), before + 1);
  const stale = await setRoles(T.memberAal2, ids.ALPHA, M.admin2, ['member']);
  assert.equal(stale.status, 404, 'the removed member with a still-valid token is not found');
  const rolesOnRemoved = await setRoles(T.admin1aal2, ids.ALPHA, M.member, ['it_reviewer']);
  assert.equal(rolesOnRemoved.status, 409);
  assert.equal(rolesOnRemoved.body.code, 'E_MEMBERSHIP_REMOVED');
});

let invited = null;
test('invitation create: no configured delivery is 503 before any write; then create, account, single-use link, accept (cases 7, 8, 10, 18 at the handler)', async () => {
  const before = audits();
  const invBefore = Number(sql('select count(*) from app.invitations'));
  const none = await call(unconfigured.invitationsCreate, {
    params: { companyId: ids.ALPHA },
    token: T.admin1aal2,
    body: { email: 'Reviewer@Example.invalid', roles: ['it_reviewer'] },
  });
  assert.equal(none.status, 503);
  assert.equal(none.body.code, 'E_MAIL_NOT_CONFIGURED');
  assert.equal(Number(sql('select count(*) from app.invitations')), invBefore);
  assert.equal(audits(), before);

  const r = await call(routes.invitationsCreate, {
    params: { companyId: ids.ALPHA },
    token: T.admin1aal2,
    body: { email: '  Reviewer@Example.invalid ', roles: ['it_reviewer'], expiresInDays: 7 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  /* `delivery` joined the answer in E6 (design 1.2) and says which hop ran; in `mail` there is no link in it. */
  assert.deepEqual(Object.keys(r.body).sort(), ['delivery', 'expiresAt', 'invitationId', 'ok']);
  assert.equal(r.body.delivery, 'mail');
  assert.equal(audits(), before + 1);
  assert.equal(delivered.length, 1);
  const mail = delivered[0];
  assert.equal(mail.to, 'reviewer@example.invalid', 'case 23: email normalised (trimmed, lower-cased)');
  const url = new URL(mail.acceptUrl);
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, '/accept');
  /* Pages design section 1: the link secrets travel in the fragment, which no browser sends to a server. */
  assert.equal(url.search, '', 'no link secret in the query string');
  const link = new URLSearchParams(url.hash.slice(1));
  assert.deepEqual([...link.keys()], ['token_hash', 'type', 'invite']);
  const tokenHash = link.get('token_hash');
  const type = link.get('type');
  const code = link.get('invite');
  assert.match(code, /^[0-9a-f]{64}$/);
  assert.equal(type, 'signup', 'a new address gets a signup-type link (design 4.1)');
  assert.equal(
    sql(`select email_normalized from app.invitations where id='${r.body.invitationId}'`),
    'reviewer@example.invalid',
  );
  assert.equal(
    sql("select count(*) from auth.users where email='reviewer@example.invalid' and email_confirmed_at is null"),
    '1',
    'server-created, unconfirmed',
  );
  invited = { id: r.body.invitationId, code, tokenHash, type };

  /* Case 8: a different signed-in user with the code is refused; an unconfirmed account too. */
  const wrongUser = await call(routes.invitationsAccept, { token: T.outsiderAal2, body: { inviteCode: code } });
  assert.equal(wrongUser.status, 403);
  assert.equal(wrongUser.body.code, 'E_EMAIL_MISMATCH');
  const inviteeId = sql("select id from auth.users where email='reviewer@example.invalid'");
  const unconfirmedSession = mintUserToken({ sub: inviteeId, email: 'reviewer@example.invalid' });
  const unconfirmed = await call(routes.invitationsAccept, { token: unconfirmedSession, body: { inviteCode: code } });
  assert.equal(unconfirmed.status, 403);
  assert.equal(unconfirmed.body.code, 'E_EMAIL_MISMATCH');

  /* Case 18: the verify route turns the link into cookies (server side); the link is single use. */
  const verify = await call(routes.authVerify, { body: { tokenHash, type } });
  assert.equal(verify.status, 204, JSON.stringify(verify.body));
  assert.equal(verify.res.cookies.length, 2);
  const access = /^enterprise_access=([^;]+);/.exec(verify.res.cookies[0])[1];
  assert.match(verify.res.cookies[0], /HttpOnly; Secure; SameSite=Strict/);
  const replayLink = await call(routes.authVerify, { body: { tokenHash, type } });
  assert.equal(replayLink.status, 401);
  assert.equal(replayLink.body.code, 'E_AUTH_INVALID');
  assert.equal(
    sql("select count(*) from auth.users where email='reviewer@example.invalid' and email_confirmed_at is not null"),
    '1',
  );

  /* Case 7: malformed codes; then the recipient accepts once; replay is refused. */
  for (const bad of ['', 'x', code.slice(0, 63), `${code}0`, r.body.invitationId, 'Z'.repeat(64), 123, null]) {
    const m = await call(routes.invitationsAccept, { token: access, body: { inviteCode: bad } });
    assert.equal(m.status, 404, JSON.stringify(bad));
    assert.equal(m.body.code, 'E_INVITATION_INVALID');
  }
  const accept = await call(routes.invitationsAccept, { token: access, body: { inviteCode: code.toUpperCase() } });
  assert.equal(accept.status, 200, JSON.stringify(accept.body));
  assert.deepEqual(accept.body, {
    ok: true,
    companyId: ids.ALPHA,
    membershipId: accept.body.membershipId,
    roles: ['it_reviewer', 'member'],
    reactivated: false,
  });
  const replay = await call(routes.invitationsAccept, { token: access, body: { inviteCode: code } });
  assert.equal(replay.status, 404);
  assert.equal(replay.body.code, 'E_INVITATION_INVALID');
  assert.equal(sql(`select count(*) from app.memberships where user_id='${inviteeId}'`), '1');
});

test('case 10 at the handler: re-inviting a removed member reactivates the same membership row', async () => {
  const beforeId = M.member;
  const r = await call(routes.invitationsCreate, {
    params: { companyId: ids.ALPHA },
    token: T.admin1aal2,
    body: { email: email('alpha-member'), roles: ['business_reviewer'] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const url = new URL(delivered.at(-1).acceptUrl);
  assert.equal(url.search, '', 'no link secret in the query string');
  const link = new URLSearchParams(url.hash.slice(1));
  assert.equal(link.get('type'), 'magiclink', 'an existing confirmed account gets a magiclink');
  const accept = await call(routes.invitationsAccept, {
    token: T.memberAal2,
    body: { inviteCode: link.get('invite') },
  });
  assert.equal(accept.status, 200, JSON.stringify(accept.body));
  assert.equal(accept.body.membershipId, beforeId);
  assert.equal(accept.body.reactivated, true);
  assert.deepEqual(accept.body.roles, ['business_reviewer', 'member']);
  assert.equal(sql(`select count(*) from app.memberships where user_id='${ids.U_alpha_member}'`), '1');
});

test('invitation refusals at the handler: active member, spaces in the email, bad expiry, non-admin, foreign company', async () => {
  const before = audits();
  const already = await call(routes.invitationsCreate, {
    params: { companyId: ids.ALPHA },
    token: T.admin1aal2,
    body: { email: email('alpha-admin2') },
  });
  assert.equal(already.status, 409);
  assert.equal(already.body.code, 'E_ALREADY_MEMBER');
  for (const bad of [
    'some one@example.invalid',
    'no-at-sign',
    '@example.invalid',
    'a@b',
    `${'a'.repeat(250)}@example.invalid`,
    42,
    null,
    undefined,
  ]) {
    const r = await call(routes.invitationsCreate, {
      params: { companyId: ids.ALPHA },
      token: T.admin1aal2,
      body: { email: bad },
    });
    assert.equal(r.status, 422, JSON.stringify(bad));
    assert.equal(r.body.code, 'E_EMAIL_INVALID');
  }
  for (const days of [0, 31, 1.5, '7', -1]) {
    const r = await call(routes.invitationsCreate, {
      params: { companyId: ids.ALPHA },
      token: T.admin1aal2,
      body: { email: 'new@example.invalid', expiresInDays: days },
    });
    assert.equal(r.status, 422, String(days));
    assert.equal(r.body.code, 'E_EXPIRY_INVALID');
  }
  const nonAdmin = await call(routes.invitationsCreate, {
    params: { companyId: ids.ALPHA },
    token: T.memberAal2,
    body: { email: 'new@example.invalid' },
  });
  assert.equal(nonAdmin.status, 403);
  const foreign = await call(routes.invitationsCreate, {
    params: { companyId: ids.BETA },
    token: T.admin1aal2,
    body: { email: 'new@example.invalid' },
  });
  assert.equal(foreign.status, 404);
  const aal1 = await call(routes.invitationsCreate, {
    params: { companyId: ids.ALPHA },
    token: T.admin1,
    body: { email: 'new@example.invalid' },
  });
  assert.equal(aal1.status, 403);
  assert.equal(aal1.body.code, 'E_ADMIN_MFA_REQUIRED');
  assert.equal(audits(), before);
});

test('invitation revoke: 204 and idempotent; accepted is 409; a foreign invitation under the route company is 404 (case 21)', async () => {
  const r = await call(routes.invitationsCreate, {
    params: { companyId: ids.ALPHA },
    token: T.admin1aal2,
    body: { email: 'pending@example.invalid' },
  });
  assert.equal(r.status, 201);
  const revoke = () =>
    call(routes.invitationsRevoke, {
      params: { companyId: ids.ALPHA, invitationId: r.body.invitationId },
      token: T.admin1aal2,
    });
  const first = await revoke();
  assert.equal(first.status, 204);
  assert.equal(first.res.body, null);
  const second = await revoke();
  assert.equal(second.status, 204);
  assert.equal(
    sql(
      `select count(*) from app.audit_events where entity_id='${r.body.invitationId}' and action='invitation.revoke'`,
    ),
    '1',
  );
  const accepted = await call(routes.invitationsRevoke, {
    params: { companyId: ids.ALPHA, invitationId: invited.id },
    token: T.admin1aal2,
  });
  assert.equal(accepted.status, 409);
  assert.equal(accepted.body.code, 'E_INVITATION_ACCEPTED');
  const betaInv = await call(routes.invitationsCreate, {
    params: { companyId: ids.BETA },
    token: T.betaAal2,
    body: { email: 'beta-pending@example.invalid' },
  });
  assert.equal(betaInv.status, 201);
  const cross = await call(routes.invitationsRevoke, {
    params: { companyId: ids.ALPHA, invitationId: betaInv.body.invitationId },
    token: T.admin1aal2,
  });
  assert.equal(cross.status, 404);
  assert.equal(sql(`select revoked_at is null from app.invitations where id='${betaInv.body.invitationId}'`), 't');
  const asMember = await call(routes.invitationsRevoke, {
    params: { companyId: ids.ALPHA, invitationId: r.body.invitationId },
    token: T.memberAal2,
  });
  assert.equal(asMember.status, 403);
});

/* E6 design 1.1 and 3.4 (lead decision, 2026-09-17): POST /api/operator/companies is api.create_company and no
   longer api.provision_company. The E2 route it replaces took a confirmed auth.users id that no route creates, and
   it made a company with NO access period, which design 1.5 says the product path may not do. Every refusal arm
   below that still has an input is unchanged, in the same order: 201, a taken slug 409 E_CONFLICT, a non-operator
   403 E_NOT_OPERATOR, an operator at aal1 403 E_OPERATOR_MFA_REQUIRED, and the malformed bodies 422. Two arms
   moved with the body. The 'unknown first-admin user id' arm is REMOVED, because the route no longer takes an id
   at all: the address it takes instead is covered by tests/e6/stack/routes.test.mjs, where an address belonging to
   an operator account answers 409 E_OPERATOR_ACCOUNT and the accepted link creates the first admin. Two arms are
   ADDED that the new body needs, and they are here rather than in E6's file because they are this route's own
   shape: a missing period and an out-of-order one, each refused before any company row exists. */
test('operator routes: create a company (201), slug taken (409), non-operator (403), aal1 (403), transfer first admin (200 / 404)', async () => {
  const before = audits();
  const period = { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-11-26T00:00:00.000Z' };
  const newCompany = (over = {}) => ({
    slug: 'synthetic-gamma',
    name: 'SYNTHETIC Gamma SA',
    firstAdminEmail: `synthetic-gamma-admin-${Math.random().toString(16).slice(2, 10)}@example.invalid`,
    ...period,
    ...over,
  });
  const p = await call(routes.operatorCompanyCreate, { token: T.opAal2, body: newCompany() });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  /* This file runs in `mail` mode (the header says why), so the link goes to the transport and the answer carries
     none of it. tests/e6/stack/routes.test.mjs is where the handover answer carries it once. */
  assert.deepEqual(Object.keys(p.body).sort(), [
    'accessPeriod',
    'companyId',
    'delivery',
    'expiresAt',
    'invitationId',
    'ok',
  ]);
  assert.equal(p.body.delivery, 'mail');
  const handed = delivered[delivered.length - 1];
  assert.match(handed.acceptUrl, /\/accept#token_hash=/, 'the transport received the link');
  /* company.provision, company.set_access_period and invitation.create, in one transaction. */
  assert.equal(audits(), before + 3);
  assert.equal(sql(`select count(*) from app.access_periods where company_id='${p.body.companyId}'`), '1');
  const taken = await call(routes.operatorCompanyCreate, {
    token: T.opAal2,
    body: newCompany({ name: 'Again' }),
  });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.code, 'E_CONFLICT');
  const notOp = await call(routes.operatorCompanyCreate, {
    token: T.admin1aal2,
    body: newCompany({ slug: 'synthetic-delta' }),
  });
  assert.equal(notOp.status, 403);
  assert.equal(notOp.body.code, 'E_NOT_OPERATOR');
  const opAal1 = await call(routes.operatorCompanyCreate, {
    token: T.op,
    body: newCompany({ slug: 'synthetic-delta' }),
  });
  assert.equal(opAal1.status, 403);
  assert.equal(opAal1.body.code, 'E_OPERATOR_MFA_REQUIRED');
  for (const over of [
    { slug: 'Bad Slug' },
    { name: '' },
    { firstAdminEmail: 'nope' },
    { expiresInDays: 31 },
    /* The two the new body needs: design 1.5 makes the period required, because a company with no access-period
       row is not time-bounded at all and no product path may create one. */
    { startsAt: undefined, endsAt: undefined },
    { startsAt: period.endsAt, endsAt: period.startsAt },
  ]) {
    const body = newCompany({ slug: 'synthetic-delta', ...over });
    if (over.startsAt === undefined && 'startsAt' in over) {
      body.startsAt = undefined;
      body.endsAt = undefined;
    }
    const r = await call(routes.operatorCompanyCreate, { token: T.opAal2, body });
    assert.equal(r.status, 422, JSON.stringify(over));
    assert.equal(sql("select count(*) from app.companies where slug='synthetic-delta'"), '0', 'no row exists');
  }
  const transfer = await call(routes.operatorTransferAdmin, {
    params: { companyId: ids.ALPHA },
    token: T.opAal2,
    body: { userId: ids.U_alpha_member },
  });
  assert.equal(transfer.status, 200, JSON.stringify(transfer.body));
  assert.equal(transfer.body.changed, true);
  assert.deepEqual(transfer.body.roles, ['business_reviewer', 'company_admin', 'member']);
  const notMember = await call(routes.operatorTransferAdmin, {
    params: { companyId: ids.ALPHA },
    token: T.opAal2,
    body: { userId: ids.U_beta_member },
  });
  assert.equal(notMember.status, 404);
  assert.equal(
    sql(
      `select count(*) from app.audit_events where company_id='${ids.ALPHA}' and action='membership.transfer_first_admin'`,
    ),
    '1',
  );
});

test('sign-out clears cookies and revokes; refresh without a cookie is 401 and clears', async () => {
  const out = await call(routes.authSignout, { token: T.admin1 });
  assert.equal(out.status, 204);
  assert.equal(out.res.cookies.length, 2);
  for (const c of out.res.cookies) assert.match(c, /Max-Age=0/);
  const outNoSession = await call(routes.authSignout, {});
  assert.equal(outNoSession.status, 204);
  const refresh = await call(routes.authRefresh, {});
  assert.equal(refresh.status, 401);
  assert.equal(refresh.body.code, 'E_AUTH_INVALID');
  for (const c of refresh.res.cookies) assert.match(c, /Max-Age=0/);
  const start = await call(routes.authStart, { body: { email: email('alpha-admin2') } });
  assert.equal(start.status, 204);
  const startUnknown = await call(routes.authStart, { body: { email: 'nobody@example.invalid' } });
  assert.equal(startUnknown.status, 204, 'no account enumeration');
});

/* Q10 (Raffael, 2026-09-13; pages design 2.5 and S12): two GoTrue sessions of one account, each with its
   own refresh token, made the way a returning person signs in: an admin-generated magic link exchanged
   through the verify route, which sets both cookies (case 18 above does the same for an invitee). Not the
   password grant tests/db/lib.sh uses: scripts/check-secrets.mjs refuses a password key in a tracked file
   whatever its value. No token value is printed or placed in an assertion message. */
const linkSession = async (who) => {
  const { generateLink } = await import('../../../lib/db/operator.mjs');
  const link = await generateLink({ email: email(who), type: 'magiclink' });
  assert.equal(link.ok, true, 'magic link generated');
  const v = await call(routes.authVerify, { body: { tokenHash: link.hashedToken, type: 'magiclink' } });
  assert.equal(v.status, 204, 'link exchanged for a session');
  const cookieValue = (name) =>
    new RegExp(`^${name}=([^;]+);`).exec(v.res.cookies.find((c) => c.startsWith(`${name}=`)) ?? '')?.[1];
  const access = cookieValue(COOKIES.access);
  const refresh = cookieValue(COOKIES.refresh);
  assert.ok(typeof access === 'string' && typeof refresh === 'string', 'both session cookies set');
  return { access, refresh };
};

test('Q10: sign-out ends this device only; the other session of the same account still refreshes, the signed-out one does not', async () => {
  const here = await linkSession('alpha-admin2');
  const elsewhere = await linkSession('alpha-admin2');
  const refreshWith = (refreshToken) =>
    call(routes.authRefresh, { headers: { cookie: `${COOKIES.refresh}=${refreshToken}` } });
  const out = await call(routes.authSignout, { token: here.access });
  assert.equal(out.status, 204);
  const survivor = await refreshWith(elsewhere.refresh);
  assert.equal(survivor.status, 204, 'the other session of the same account survives sign-out');
  assert.equal(survivor.res.cookies.length, 2);
  const ended = await refreshWith(here.refresh);
  assert.equal(ended.status, 401, 'the signed-out session cannot be refreshed');
  assert.equal(ended.body.code, 'E_AUTH_INVALID');
});

test('no response body and no log line carried an email address or an invitation secret', () => {
  const secrets = [invited.code, invited.tokenHash];
  for (const r of responses) {
    if (r.body === null) continue;
    assert.ok(!r.body.includes('@'), r.body);
    for (const s of secrets) assert.ok(!r.body.includes(s));
  }
  const log = JSON.stringify(logged);
  assert.ok(!log.includes('@'), log.slice(0, 500));
  for (const s of secrets) assert.ok(!log.includes(s));
  assert.ok(logged.length > 0);
});
