/* Pages construction, the read routes against the local stack (pages design 7.2): S1 GET /api/me, S2 the member list,
   S2b the subset invariant, S3 the invitation list, S7's scan of these answers with its must-pass and must-fail
   fixtures, and S9 the closed switch. Reseeds once through tests/db/00-seed.sh and needs migration 005 applied, which
   the reseed does. Read-only callers carry tokens minted with the local secret, which verifySession and PostgREST both
   accept; the invitation and membership fixtures go through the real routes where a label depends on them. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import {
  addressFindings,
  caller,
  logFindings,
  mint,
  newAccount,
  scratchCopy,
  sessionOf,
  shell,
  sql,
} from '../helpers/pages.mjs';
import { seed } from '../helpers/stack.mjs';

/* E6 design 1.2 made delivery a MODE whose default is `handover`. This file invites through a transport it
   supplies and reads the link out of what the transport received, which is the `mail` path; E6 keeps it
   unchanged, and the handover path is tests/e6/stack/routes.test.mjs's. */
process.env.ENTERPRISE_INVITATION_DELIVERY = 'mail';

const ids = seed();
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { select } = await import('../../../lib/db/user.mjs');
const { canReadInvitations } = await import('../../../lib/rules/members.mjs');

const delivered = [];
const logged = [];
const routes = makeRoutes({ deliver: async (m) => delivered.push(m), log: (e) => logged.push(e) });
const { call, answers } = caller(routes, { COOKIES, makeRequest });
const run = randomBytes(3).toString('hex');
const seeded = (who) => `synthetic-${who}@example.invalid`;
const pair = (who, sub) => ({
  email: seeded(who),
  aal1: mint({ sub, email: seeded(who), aal: 'aal1' }),
  aal2: mint({ sub, email: seeded(who), aal: 'aal2' }),
});
const ADMIN = pair('alpha-admin1', ids.U_alpha_admin1);
const MEMBER = pair('alpha-member', ids.U_alpha_member);
const REMOVED = pair('alpha-removed', ids.U_alpha_removed);
const BETA = pair('beta-member', ids.U_beta_member);
const OUTSIDER = pair('outsider', ids.U_outsider);
const OPERATOR = pair('op', ids.U_op);
const ADMIN_ROLES = ['company_admin', 'member'];
const MEMBERS_READ = {
  select: 'id,user_id,status,roles,created_at,removed_at',
  company_id: `eq.${ids.ALPHA}`,
  order: 'status.asc,created_at.asc,id.asc',
  limit: '151',
};
const INVITATIONS_READ = {
  /* delivery: E6 design 1.2.1 (lane K4, migration 010). */
  select:
    'id,roles,email_normalized,expires_at,created_by,created_at,accepted_membership_id,accepted_at,revoked_at,delivery',
  company_id: `eq.${ids.ALPHA}`,
  order: 'created_at.desc,id.desc',
  limit: '151',
};
const members = (access, companyId = ids.ALPHA) => call('membersList', { access, params: { companyId } });
const invitations = (access, companyId = ids.ALPHA) => call('invitationsList', { access, params: { companyId } });
const rowOf = (answer, membershipId) => answer.body.members.find((m) => m.membershipId === membershipId);
const secrets = [];

/** Invite a fresh address into alpha through the routes and accept it: the membership then has an accepted invitation. */
async function inviteAndAccept(tag, roles = ['member']) {
  const address = `pages-${tag}-${run}@example.invalid`;
  const created = await call('invitationsCreate', {
    access: ADMIN.aal2,
    params: { companyId: ids.ALPHA },
    body: { email: address, roles },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const link = new URLSearchParams(new URL(delivered.at(-1).acceptUrl).hash.slice(1));
  secrets.push(link.get('token_hash'), link.get('invite'));
  const verified = await call('authVerify', { body: { tokenHash: link.get('token_hash'), type: link.get('type') } });
  assert.equal(verified.status, 204, 'the link is exchanged');
  const accepted = await call('invitationsAccept', {
    access: verified.access,
    body: { inviteCode: link.get('invite') },
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return {
    email: address,
    userId: sql(`select id from auth.users where email = '${address}'`),
    membershipId: accepted.body.membershipId,
    access: verified.access,
    invitationId: created.body.invitationId,
  };
}

const profileRead = (session, userIds) =>
  select(session, 'profiles', {
    select: 'user_id,display_name',
    user_id: `in.(${[...userIds].sort().join(',')})`,
    order: 'user_id.asc',
    limit: '151',
  });

/* E6 design 1.1 moved half of this test's subject, and the half it moved is the whole point of the change: a
   REMOVED membership still disappears at the next call with the same cookie, and a SUSPENDED company no longer
   does. Until E6 the company vanished from the person's list and the home page said the account had no active
   company membership, which is false and unexplained; api.my_standing is the one read in the product that sees
   past a company's status, so the company is listed with companyStatus and accessState and the page says the true
   sentence. The removal arm is unchanged, because the view filters active memberships inside the door. */
test('S1 GET /api/me: the admin lists alpha; two companies list both; a removal disappears at the next call with the same cookie, and a suspension is listed with its state', async () => {
  const admin = await call('me', { access: ADMIN.aal1 });
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.body.user, {
    id: ids.U_alpha_admin1,
    email: ADMIN.email,
    aal: 'aal1',
    displayName: null,
  });
  assert.deepEqual(
    admin.body.memberships.map((m) => [m.companyId, m.companySlug, m.companyName, [...m.roles].sort()]),
    [[ids.ALPHA, 'synthetic-alpha', 'SYNTHETIC Alpha AG', ADMIN_ROLES]],
  );
  assert.equal(admin.body.truncated, false);
  assert.equal((await call('me', { access: ADMIN.aal2 })).body.user.aal, 'aal2', 'aal is the token s');

  const two = newAccount('two');
  shell('member "$1" "$2" "$3"', ids.ALPHA, two.id, '{member}');
  shell('member "$1" "$2" "$3"', ids.BETA, two.id, '{it_reviewer,member}');
  const twoToken = mint({ sub: two.id, email: two.email, aal: 'aal1' });
  const slugs = async () => (await call('me', { access: twoToken })).body.memberships.map((m) => m.companySlug).sort();
  assert.deepEqual(await slugs(), ['synthetic-alpha', 'synthetic-beta'], 'control: both before any change');

  const gone = newAccount('gone');
  const goneMembership = shell('member "$1" "$2" "$3"', ids.ALPHA, gone.id, '{member}');
  const goneToken = mint({ sub: gone.id, email: gone.email, aal: 'aal2' });
  assert.deepEqual(
    (await call('me', { access: goneToken })).body.memberships.map((m) => m.membershipId),
    [goneMembership],
  );
  const removal = await call('membersRemove', {
    access: ADMIN.aal2,
    params: { companyId: ids.ALPHA, membershipId: goneMembership },
  });
  assert.equal(removal.status, 200, JSON.stringify(removal.body));
  assert.deepEqual((await call('me', { access: goneToken })).body.memberships, [], 'the same cookie, no alpha');

  sql(`update app.companies set status = 'suspended' where id = '${ids.BETA}'`);
  try {
    assert.deepEqual(await slugs(), ['synthetic-alpha', 'synthetic-beta'], 'the suspended company is still listed');
    const rows = (await call('me', { access: twoToken })).body.memberships;
    const beta = rows.find((m) => m.companySlug === 'synthetic-beta');
    assert.deepEqual(
      [beta.companyStatus, beta.accessState],
      ['suspended', 'none'],
      'with its status and its access state, which are two different facts (design 1.5)',
    );
    assert.equal(
      rows.find((m) => m.companySlug === 'synthetic-alpha').companyStatus,
      'active',
      'and the other company is unaffected',
    );
  } finally {
    sql(`update app.companies set status = 'active' where id = '${ids.BETA}'`);
  }
  assert.deepEqual(await slugs(), ['synthetic-alpha', 'synthetic-beta']);
  const operator = await call('me', { access: OPERATOR.aal2 });
  assert.deepEqual(operator.body.memberships, [], 'an operator with no membership');
});

let named;
let unnamed;
const CLASSES = [
  ['member at aal1', () => MEMBER.aal1, MEMBER.email, false],
  ['member at aal2', () => MEMBER.aal2, MEMBER.email, false],
  ['admin at aal1', () => ADMIN.aal1, ADMIN.email, true],
  ['admin at aal2', () => ADMIN.aal2, ADMIN.email, true],
];

test('S2 before any display name: self and none for a member and an admin at aal1, invitation labels for an admin at aal2, and mayReadLabels agrees with the rows', async () => {
  named = await inviteAndAccept('named');
  unnamed = await inviteAndAccept('unnamed');
  const scratch = await scratchCopy('lib/services/directory.mjs', [
    ["standing.mayReadInvitations && session.aal === 'aal2'", 'true'],
  ]);
  for (const [label, access, viewerEmail, mayRead] of CLASSES) {
    const r = await members(access());
    assert.equal(r.status, 200, label);
    const own = rowOf(r, r.body.viewer.membershipId);
    assert.deepEqual(own.label, { kind: 'self', value: viewerEmail }, `${label}: own row`);
    assert.equal(r.body.viewer.mayReadLabels, mayRead, label);
    assert.equal(r.body.viewer.mayReadLabels, canReadInvitations(r.body.viewer.roles), `${label}: the read predicate`);
    const addresses = r.body.members.filter((m) => m.label.kind === 'invitation_email');
    if (label === 'admin at aal2') {
      assert.deepEqual(rowOf(r, named.membershipId).label, { kind: 'invitation_email', value: named.email }, label);
      assert.deepEqual(rowOf(r, unnamed.membershipId).label, { kind: 'invitation_email', value: unnamed.email });
    } else {
      assert.deepEqual(addresses, [], `${label}: no address labels`);
      assert.deepEqual(rowOf(r, named.membershipId).label, { kind: 'none' }, label);
    }
    if (addresses.length > 0) assert.ok(r.body.viewer.mayReadLabels && r.body.viewer.aal === 'aal2', label);
    assert.deepEqual(r.body.assignableRoles, ['member', 'it_reviewer', 'business_reviewer', 'company_admin']);
    if (label !== 'admin at aal2') {
      /* The label branch removed: the database returns no invitation rows to this caller, so nothing changes. */
      const copy = await scratch.listMembers(await sessionOf(access()), ids.ALPHA);
      assert.deepEqual(
        copy.members.map((m) => m.label),
        r.body.members.map((m) => m.label),
        `${label}: the same labels with the branch removed (Q2, migration 005)`,
      );
    }
  }
  for (const [label, access, companyId] of [
    ['beta member with alpha id', BETA.aal2, ids.ALPHA],
    ['unknown uuid', ADMIN.aal2, '00000000-0000-4000-8000-000000000000'],
    ['malformed id', ADMIN.aal2, 'not-a-uuid'],
    ['removed member, same cookie', REMOVED.aal2, ids.ALPHA],
    ['outsider', OUTSIDER.aal2, ids.ALPHA],
  ]) {
    const r = await members(access, companyId);
    assert.equal(r.status, 404, label);
    assert.equal(r.body.code, 'E_NOT_FOUND', label);
  }
});

test('S2 display names: a named row is display_name for a member and an admin at either aal, a beta name stays out, and every class sees exactly the profile rows its own read returns', async () => {
  const name = `Named @ ${run}`;
  assert.equal((await call('meDisplayName', { access: named.access, body: { displayName: name } })).status, 204);
  const betaName = `Beta Name ${run}`;
  assert.equal((await call('meDisplayName', { access: BETA.aal1, body: { displayName: betaName } })).status, 204);
  for (const [label, access] of CLASSES) {
    const r = await members(access());
    assert.deepEqual(rowOf(r, named.membershipId).label, { kind: 'display_name', value: name }, label);
    assert.ok(!r.body.members.some((m) => m.label.value === betaName), `${label}: no beta name`);
    if (label.startsWith('member')) {
      const outsideSelf = r.body.members.filter((m) => m.membershipId !== r.body.viewer.membershipId);
      assert.ok(!outsideSelf.some((m) => m.label.kind === 'invitation_email'), `${label}: no address`);
    } else if (label === 'admin at aal2') {
      assert.deepEqual(rowOf(r, unnamed.membershipId).label, { kind: 'invitation_email', value: unnamed.email });
    }
    const session = await sessionOf(access());
    const direct = await profileRead(session, new Set(r.body.members.map((m) => m.userId)));
    const byUser = new Map(direct.map((p) => [p.user_id, p.display_name]));
    for (const m of r.body.members) {
      if (m.membershipId === r.body.viewer.membershipId) continue;
      if (m.label.kind === 'display_name')
        assert.equal(m.label.value, byUser.get(m.userId), `${label}: a shown name is one its own read returns`);
      else assert.ok(!byUser.has(m.userId), `${label}: a row with a readable profile is labelled by it`);
    }
  }
});

test('S2 former member, single-company arm: after removal the named row is none for a member and invitation_email for an admin at aal2', async () => {
  const removal = await call('membersRemove', {
    access: ADMIN.aal2,
    params: { companyId: ids.ALPHA, membershipId: named.membershipId },
  });
  assert.equal(removal.status, 200);
  const asMember = rowOf(await members(MEMBER.aal1), named.membershipId);
  assert.equal(asMember.status, 'removed');
  assert.deepEqual(asMember.label, { kind: 'none' });
  const asAdmin = rowOf(await members(ADMIN.aal2), named.membershipId);
  assert.equal(asAdmin.status, 'removed');
  assert.deepEqual(asAdmin.label, { kind: 'invitation_email', value: named.email });
});

test('S2 former member, shared-company arm: the name stays for a viewer who still shares beta with that person, and not for one who does not', async () => {
  const shared = await inviteAndAccept('shared');
  const peer = newAccount('peer');
  shell('member "$1" "$2" "$3"', ids.ALPHA, peer.id, '{member}');
  shell('member "$1" "$2" "$3"', ids.BETA, peer.id, '{member}');
  shell('member "$1" "$2" "$3"', ids.BETA, shared.userId, '{member}');
  const name = `Shared Person ${run}`;
  assert.equal((await call('meDisplayName', { access: shared.access, body: { displayName: name } })).status, 204);
  const removal = await call('membersRemove', {
    access: ADMIN.aal2,
    params: { companyId: ids.ALPHA, membershipId: shared.membershipId },
  });
  assert.equal(removal.status, 200);
  const peerToken = mint({ sub: peer.id, email: peer.email, aal: 'aal1' });
  const peerView = rowOf(await members(peerToken), shared.membershipId);
  assert.equal(peerView.status, 'removed');
  assert.deepEqual(
    peerView.label,
    { kind: 'display_name', value: name },
    'profiles_comember_read admits it through beta',
  );
  assert.deepEqual(rowOf(await members(MEMBER.aal1), shared.membershipId).label, { kind: 'none' }, 'not in beta: none');
});

let demoted;
test('S2b subset invariant: whenever a route refuses an authenticated caller early, that caller s own read of the same view returns no row', async () => {
  demoted = newAccount('demoted');
  const demotedMembership = shell('member "$1" "$2" "$3"', ids.ALPHA, demoted.id, '{company_admin,member}');
  const demotion = await call('membersSetRoles', {
    access: ADMIN.aal2,
    params: { companyId: ids.ALPHA, membershipId: demotedMembership },
    body: { roles: ['member'] },
  });
  assert.equal(demotion.status, 200, JSON.stringify(demotion.body));
  const classes = [
    ['non-admin member', MEMBER.email, ids.U_alpha_member],
    ['demoted admin', demoted.email, demoted.id],
    ['removed member', REMOVED.email, ids.U_alpha_removed],
    ['outsider', OUTSIDER.email, ids.U_outsider],
    ['admin', ADMIN.email, ids.U_alpha_admin1],
  ];
  let refusals = 0;
  for (const [label, address, sub] of classes) {
    for (const aal of ['aal1', 'aal2']) {
      const access = mint({ sub, email: address, aal });
      const session = await sessionOf(access);
      for (const [route, view, params, answer] of [
        ['members', 'memberships', MEMBERS_READ, await members(access)],
        ['invitations', 'invitations', INVITATIONS_READ, await invitations(access)],
      ]) {
        if (answer.status === 200) continue;
        refusals++;
        assert.ok([403, 404].includes(answer.status), `${label} ${aal} ${route}: ${answer.status}`);
        assert.deepEqual(await select(session, view, params), [], `${label} ${aal} ${route}: the database agrees`);
      }
    }
  }
  assert.ok(refusals >= 13, `the early refusals were exercised (${refusals})`);
  const control = await sessionOf(ADMIN.aal2);
  assert.equal((await members(ADMIN.aal2)).status, 200);
  assert.equal((await invitations(ADMIN.aal2)).status, 200, 'control: an admin at aal2 is refused by neither');
  assert.ok((await select(control, 'invitations', INVITATIONS_READ)).length > 0);
});

test('S2b anonymous class: the routes answer 401 before any read, and the anon key alone is refused by the Data API, where a [] would be a failure', async () => {
  for (const [route, params] of [
    ['me', {}],
    ['membersList', { companyId: ids.ALPHA }],
    ['invitationsList', { companyId: ids.ALPHA }],
  ]) {
    const r = await call(route, { params });
    assert.equal(r.status, 401, route);
    assert.equal(r.body.code, 'E_UNAUTHENTICATED');
  }
  for (const view of ['memberships', 'invitations', 'profiles', 'companies']) {
    for (const withBearer of [false, true]) {
      const headers = { apikey: process.env.SUPABASE_ANON_KEY, accept: 'application/json' };
      if (withBearer) headers.authorization = `Bearer ${process.env.SUPABASE_ANON_KEY}`;
      const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${view}?select=*&limit=1`, { headers });
      const body = await r.json().catch(() => null);
      assert.ok(!Array.isArray(body), `${view}: anon read answered a list, the grants were widened`);
      assert.ok(r.status >= 400, `${view} ${withBearer}: ${r.status}`);
      assert.equal(body?.code, '42501', `${view}: a privilege refusal`);
    }
  }
});

test('S3 invitation list: states, the early refusals and the database alone with each branch removed, stale and foreign callers', async () => {
  const pending = await call('invitationsCreate', {
    access: ADMIN.aal2,
    params: { companyId: ids.ALPHA },
    body: { email: `pages-pending-${run}@example.invalid` },
  });
  const revoked = await call('invitationsCreate', {
    access: ADMIN.aal2,
    params: { companyId: ids.ALPHA },
    body: { email: `pages-revoked-${run}@example.invalid` },
  });
  const expired = await call('invitationsCreate', {
    access: ADMIN.aal2,
    params: { companyId: ids.ALPHA },
    body: { email: `pages-expired-${run}@example.invalid` },
  });
  for (const r of [pending, revoked, expired]) assert.equal(r.status, 201, JSON.stringify(r.body));
  for (const m of delivered.slice(-3)) {
    const link = new URLSearchParams(new URL(m.acceptUrl).hash.slice(1));
    secrets.push(link.get('token_hash'), link.get('invite'));
  }
  const revoke = await call('invitationsRevoke', {
    access: ADMIN.aal2,
    params: { companyId: ids.ALPHA, invitationId: revoked.body.invitationId },
  });
  assert.equal(revoke.status, 204);
  sql(`update app.invitations set expires_at = now() - interval '1 second' where id = '${expired.body.invitationId}'`);

  const list = await invitations(ADMIN.aal2);
  assert.equal(list.status, 200);
  assert.ok(Math.abs(Date.parse(list.body.stateDerivedAt) - Date.now()) < 60_000);
  const stateOf = (id) => list.body.invitations.find((i) => i.invitationId === id)?.state;
  assert.equal(stateOf(pending.body.invitationId), 'pending');
  assert.equal(stateOf(revoked.body.invitationId), 'revoked');
  assert.equal(stateOf(expired.body.invitationId), 'expired');
  assert.equal(stateOf(unnamed.invitationId), 'accepted');
  const accepted = list.body.invitations.find((i) => i.invitationId === unnamed.invitationId);
  assert.equal(accepted.email, unnamed.email);
  assert.equal(accepted.acceptedMembershipId, unnamed.membershipId);

  const stepUp = await invitations(ADMIN.aal1);
  assert.equal(stepUp.status, 403);
  assert.equal(stepUp.body.code, 'E_MFA_STEP_UP_REQUIRED');
  const reviewer = newAccount('reviewer');
  shell('member "$1" "$2" "$3"', ids.ALPHA, reviewer.id, '{it_reviewer,member}');
  const reviewerToken = (aal) => mint({ sub: reviewer.id, email: reviewer.email, aal });
  const forbidden = await invitations(reviewerToken('aal2'));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, 'E_FORBIDDEN');

  const noAal = await scratchCopy('lib/services/directory.mjs', [
    ["if (session.aal !== 'aal2') throw new AppError('E_MFA_STEP_UP_REQUIRED');", ''],
  ]);
  const noRole = await scratchCopy('lib/services/directory.mjs', [
    ["if (!standing.mayReadInvitations) throw new AppError('E_FORBIDDEN');", ''],
    ["if (session.aal !== 'aal2') throw new AppError('E_MFA_STEP_UP_REQUIRED');", ''],
  ]);
  const adminAal1 = await noAal.listInvitations(await sessionOf(ADMIN.aal1), ids.ALPHA);
  assert.deepEqual(
    adminAal1.invitations,
    [],
    'the aal branch removed: an admin at aal1 gets 200 and an empty list (Q2)',
  );
  const demotedToken = (aal) => mint({ sub: demoted.id, email: demoted.email, aal });
  for (const [label, access] of [
    ['it_reviewer at aal1', reviewerToken('aal1')],
    ['it_reviewer at aal2', reviewerToken('aal2')],
    ['demoted admin at aal1', demotedToken('aal1')],
    ['demoted admin at aal2', demotedToken('aal2')],
  ]) {
    const answer = await noRole.listInvitations(await sessionOf(access), ids.ALPHA);
    assert.deepEqual(answer.invitations, [], `${label}: both branches removed, the database returns no row`);
  }
  const stale = await invitations(REMOVED.aal2);
  assert.equal(stale.status, 404);
  const foreign = await invitations(BETA.aal2);
  assert.equal(foreign.status, 404);
});

test('S9 closed switch: all eight routes answer 503 with a tampered cookie, which would be 401 after verification', async () => {
  const tampered = `${ADMIN.aal2.slice(0, -4)}AAAA`;
  const bodies = { meDisplayName: { displayName: 'Ada' }, factorsVerify: { code: '123456' } };
  const params = {
    membersList: { companyId: ids.ALPHA },
    invitationsList: { companyId: ids.ALPHA },
    factorsVerify: { factorId: '00000000-0000-4000-8000-000000000000' },
    factorsRemove: { factorId: '00000000-0000-4000-8000-000000000000' },
  };
  const names = [
    'me',
    'meDisplayName',
    'membersList',
    'invitationsList',
    'factorsList',
    'factorsEnroll',
    'factorsVerify',
    'factorsRemove',
  ];
  process.env.ENTERPRISE_ACCESS_STATE = 'closed';
  try {
    for (const name of names) {
      const r = await call(name, { access: tampered, params: params[name], body: bodies[name] });
      assert.equal(r.status, 503, name);
      assert.equal(r.body.code, 'E_MAINTENANCE', name);
    }
  } finally {
    process.env.ENTERPRISE_ACCESS_STATE = 'open';
  }
  for (const name of names) {
    const r = await call(name, { access: tampered, params: params[name], body: bodies[name] });
    assert.equal(r.status, 401, `${name}: control, open`);
  }
});

test('S7 scan fixtures: the must-pass and must-fail answers of 7.2, then every answer and log line of this file', async () => {
  const storedNames = new Map(
    sql(
      "select coalesce(string_agg(user_id || '|' || encode(convert_to(display_name, 'UTF8'), 'hex'), ','), '') from app.profiles",
    )
      .split(',')
      .filter(Boolean)
      .map((pairText) => {
        const [id, hex] = pairText.split('|');
        return [id, Buffer.from(hex, 'hex').toString('utf8')];
      }),
  );
  const ownMembers = await members(MEMBER.aal1);
  assert.deepEqual(
    addressFindings('membersList', ownMembers.body, { storedNames }),
    [],
    'an ordinary member s own list',
  );
  const adminView = await members(ADMIN.aal2);
  assert.deepEqual(addressFindings('membersList', adminView.body, { storedNames }), []);
  const hidden = structuredClone(adminView.body);
  hidden.viewer.mayReadLabels = false;
  assert.ok(
    addressFindings('membersList', hidden, { storedNames }).some((f) => /label\.value holds an address/.test(f)),
    'must fail: an address on a row that is not the viewer s own and not a name while mayReadLabels is false',
  );
  const renamed = structuredClone(ownMembers.body);
  const target = renamed.members.find((m) => m.membershipId !== renamed.viewer.membershipId);
  target.label = { kind: 'display_name', value: 'someone@example.invalid' };
  assert.ok(
    addressFindings('membersList', renamed, { storedNames }).some((f) => /not the stored name/.test(f)),
    'must fail: an address placed in a display_name label that is not the stored name',
  );
  assert.ok(
    addressFindings('factorsList', { ok: true, aal: 'aal1', factors: [{ friendlyName: 'x@example.invalid' }] }).length >
      0,
    'must fail: an @ anywhere in the factor list',
  );
  assert.ok(
    addressFindings('factorsEnroll', {
      ok: true,
      factorId: 'f',
      qrCodeSvg: '<svg/>',
      uri: 'otpauth://totp/a@b',
      secret: 'A@',
    }).length > 0,
    'must fail: an @ in an enrolment field other than uri',
  );
  assert.ok(
    [...storedNames.values()].some((n) => n.includes('@')),
    'a fixture name holding @ is stored and must pass the scan',
  );
  for (const a of answers)
    assert.deepEqual(addressFindings(a.route, a.body, { storedNames }), [], `${a.route} ${a.status}`);
  const names = [...storedNames.values()];
  assert.deepEqual(logFindings(logged, [...secrets, ...names]), []);
  assert.ok(logged.length > 0);
});
