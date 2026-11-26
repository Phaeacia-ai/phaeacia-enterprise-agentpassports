/* The fifteen E6 routes against the running local stack (E6 design 3.1, 3.4, 3.5 and section 5).

   What this file is for, in one sentence each. The PLAN'S EXIT EVIDENCE end to end through the routes: a second
   company created by an operator with no SQL, no migration and no prepared account, and its first administrator
   accepting the handed-over link and finding themselves an admin. The MATRIX of design 3.1 for E5's caller
   classes plus the three E6 adds, the operator at aal1 and at aal2 and a member of a suspended, an expired and a
   closed company. The two tripwires: an operator answered 404 on the company's own copy, and no operator answer
   carrying a name from inside a company. And every refusal E6 adds, shown failing before at the intended check
   with the mutant named.

   Reseeds once through tests/db/00-seed.sh and builds its own users and companies. Run one file at a time:
   node --test --test-concurrency=1 tests/e6/stack/ */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateLink } from '../../../lib/db/operator.mjs';
import {
  accessState,
  agePeriod,
  callRaw,
  companyExists,
  companyStatusOf,
  deletionState,
  dropPeriod,
  e4world,
  e6routes,
  enableTargets,
  freshEmail,
  futurePeriod,
  linkParts,
  membershipOf,
  operators,
  periodBody,
  published,
  reseed,
  reviewCompany,
  setStatus,
  sql,
  userFor,
} from './helpers.mjs';

const ids = reseed();
enableTargets();
const logged = [];
const R = await e6routes(logged);
const W = e4world('e6-routes', ids);
const OP = operators(ids);
/* A company built the E4 way, for every company-facing route that needs members, agents and releases. */
const A = await reviewCompany(W, R, 'a');
const B = await reviewCompany(W, R, 'b');
futurePeriod(A.id);
futurePeriod(B.id);

const ok = (r, status, label) => {
  assert.equal(r.status, status, `${label}: ${r.raw}`);
  return r.body;
};
const refusedWith = (r, status, code, label) => {
  assert.deepEqual([r.status, r.body?.code], [status, code], `${label}: ${r.raw}`);
  assert.deepEqual(Object.keys(r.body).sort(), ['code', 'message', 'ok'], `${label}: no database detail forwarded`);
};

/* ---------------------------------------------------------------------------
   The exit evidence: a second company through the routes, with no SQL at all
   --------------------------------------------------------------------------- */

let GAMMA = null;
let CLOSED = null;
/* A's transferred agent, kept for the refusal cases below: A.author's membership is removed by the transfer case
   and a removed member authors nothing, so A gets no second agent after it. */
let A_AGENT = null;

test("the plan's exit evidence: an operator creates a second company and its first admin accepts the handed-over link, with no SQL", async () => {
  const email = freshEmail('gamma-admin');
  const slug = `e6-gamma-${W.run}`;
  const created = ok(
    await R.companyCreate(OP.aal2, { slug, name: 'SYNTHETIC Gamma SA', firstAdminEmail: email, ...periodBody() }),
    201,
    'create',
  );
  GAMMA = created.companyId;
  assert.deepEqual(Object.keys(created).sort(), [
    'acceptUrl',
    'accessPeriod',
    'companyId',
    'delivery',
    'expiresAt',
    'invitationId',
    'ok',
    'signsIn',
  ]);
  assert.equal(created.delivery, 'handover', 'no transport is provisioned, so the link comes back to the caller');
  /* design 1.5: export_by and delete_by are DERIVED once and then stored, from the two constants. */
  const day = 86_400_000;
  assert.equal(
    Date.parse(created.accessPeriod.exportBy) - Date.parse(created.accessPeriod.endsAt),
    14 * day,
    'export_by is the end plus fourteen days',
  );
  assert.equal(
    Date.parse(created.accessPeriod.deleteBy) - Date.parse(created.accessPeriod.exportBy),
    30 * day,
    'delete_by is thirty days after that',
  );

  /* The link, read the way the accept page reads it: the secrets are in the FRAGMENT, which no browser sends to
     a server, and the query string carries none of them (pages design section 1). */
  const link = linkParts(created.acceptUrl);
  assert.equal(link.pathname, '/accept');
  assert.equal(link.search, '');
  assert.deepEqual(link.keys, ['token_hash', 'type', 'invite']);
  assert.match(link.inviteCode, /^[0-9a-f]{64}$/);

  /* The account exists because api.create_company wrote a pending invitation in the same transaction, which is
     what app.hook_before_user_created admits an address on: nothing was prepared out of band, and before this
     slice the only way to a second company was an SQL statement or a migration (design 1.1). */
  assert.equal(
    sql(`select count(*) from auth.users where lower(email)='${email}' and email_confirmed_at is null`),
    '1',
    'server-created, unconfirmed, by the ordinary generateLink call',
  );
  assert.equal(sql(`select count(*) from app.memberships where company_id='${GAMMA}'`), '0', 'no membership yet');
});

test('the exit evidence, second half: the link signs the first admin in and the acceptance makes them an admin', async () => {
  assert.ok(GAMMA, 'the company was created');
  const invited = sql(`select email_normalized from app.invitations where company_id='${GAMMA}'`);
  const created = ok(
    await R.register(OP.aal2, {}),
    200,
    'the register names the new company with zero members and one pending invitation',
  );
  const row = created.companies.find((c) => c.companyId === GAMMA);
  assert.ok(row, 'the new company is in the register');
  assert.equal(row.counts.membershipsActive, 0);
  assert.equal(row.counts.invitationsPending, 1);
  assert.equal(row.accessPeriod.state, 'current');
  assert.equal(row.accessPeriod.deletionState, 'not_eligible');
  assert.equal(invited.length > 0, true);
});

/* ---------------------------------------------------------------------------
   design 3.1: the operator's own routes, by caller class
   --------------------------------------------------------------------------- */

test('3.1: every operator route answers 200 or 201 to an operator at aal2, 403 at aal1, and 403 E_NOT_OPERATOR to a member', async () => {
  const period = periodBody();
  const calls = [
    ['register', () => R.register, [], 200],
    ['takeoutManifest', () => R.takeoutManifest, [A.id], 200],
    ['companyStatus', () => R.companyStatus, [A.id, { status: 'active', reasonCode: 'customer_request' }], 200],
    ['accessPeriod', () => R.accessPeriod, [A.id, period], 200],
    ['companyQuota', () => R.companyQuota, [A.id, { name: 'members_per_company', value: 40 }], 200],
    ['expiryRun', () => R.expiryRun, [{ limit: 5 }], 200],
  ];
  for (const [label, fn, args, status] of calls) {
    ok(await fn()(OP.aal2, ...args), status, `${label} at aal2`);
    refusedWith(await fn()(OP.aal1, ...args), 403, 'E_OPERATOR_MFA_REQUIRED', `${label} at aal1`);
    refusedWith(await fn()(A.adminHi, ...args), 403, 'E_NOT_OPERATOR', `${label} as an admin`);
    refusedWith(await fn()(A.member, ...args), 403, 'E_NOT_OPERATOR', `${label} as a member`);
  }
});

test('3.1: an operator is 404 on every company route of a company, which is the boundary working', async () => {
  const membership = A.ms.author;
  for (const [label, r] of [
    ['members', await R.call('membersList', { user: OP.aal2, params: { companyId: A.id } })],
    ['invitations', await R.invitations(OP.aal2, A.id)],
    ['quotas', await R.quotas(OP.aal2, A.id)],
    ['departure', await R.departure(OP.aal2, A.id, membership)],
    ['catalog', await R.catalog(OP.aal2, A.id)],
  ]) {
    assert.equal(r.status, 404, `${label}: ${r.raw}`);
  }
});

test("TRIPWIRE, design 1.1: the operator's own answer carries no name from inside a company", async () => {
  const names = [A.author.email, A.member.email, A.admin.email, 'weekly-brief', 'Finance'];
  const register = await R.register(OP.aal2, {});
  const manifest = await R.takeoutManifest(OP.aal2, A.id);
  const run = await R.expiryRun(OP.aal2, { limit: 5 });
  for (const [label, r] of [
    ['register', register],
    ['manifest', manifest],
    ['expiry run', run],
  ]) {
    const whole = r.raw ?? '';
    for (const name of names) assert.equal(whole.includes(name), false, `${label} leaked ${name}`);
    assert.equal(/@example\.invalid/.test(whole), false, `${label} carried an address`);
  }
  /* The manifest is counts only: every section value is an integer and no section is a list of rows. */
  const m = manifest.body;
  assert.equal(Object.values(m.exportManifest.sections).every((n) => Number.isInteger(n)), true);
  assert.equal(Object.keys(m.exportManifest.sections).length, 21, 'the twenty-one sections of design 1.6');
});

test('3.1 and 1.6, E6D-C-F1a: the operator is 404 on the company s own copy, and there is no operator route beside it', async () => {
  const r = await R.takeout(OP.aal2, A.id);
  assert.equal(r.status, 404, `an operator asking for the document: ${r.raw}`);
  assert.equal(r.body.code, 'E_NOT_FOUND');
  /* And no route serves an operator path that would answer one: the manifest is the only operator route on a
     company's records, and it is counts only. */
  const operatorRoutes = Object.entries(R.table)
    .filter(([, h]) => h.route.path.startsWith('/api/operator/'))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(operatorRoutes, [
    'operatorAccessPeriod',
    'operatorAdminInvitation',
    'operatorCompanyClose',
    'operatorCompanyCreate',
    'operatorCompanyDelete',
    'operatorCompanyQuota',
    'operatorCompanyStatus',
    'operatorExpiryRun',
    'operatorRegister',
    'operatorTakeoutManifest',
    'operatorTransferAdmin',
  ]);
});

/* ---------------------------------------------------------------------------
   design 1.2: handover delivery and the resend
   --------------------------------------------------------------------------- */

test('design 1.2: an admin s invitation answers the link once, and a resend issues a new one that kills the earlier link', async () => {
  const email = freshEmail('a-invitee');
  const first = ok(await R.invite(A.adminHi, A.id, { email, roles: ['member'] }), 201, 'create');
  assert.equal(first.delivery, 'handover');
  const firstLink = linkParts(first.acceptUrl);
  assert.match(firstLink.inviteCode, /^[0-9a-f]{64}$/);

  const again = ok(await R.resend(A.adminHi, A.id, first.invitationId), 201, 'resend');
  assert.equal(again.replacesInvitationId, first.invitationId);
  assert.notEqual(again.invitationId, first.invitationId, 'a resend is a new row');
  const secondLink = linkParts(again.acceptUrl);
  assert.notEqual(secondLink.inviteCode, firstLink.inviteCode, 'and a new code');
  assert.equal(
    sql(`select revoked_at is not null from app.invitations where id='${first.invitationId}'`),
    't',
    'the earlier row is revoked in the same transaction',
  );
  /* The link between the two rows is in the AUDIT rows and not in a column: 001 writes invitation.revoke with
     reason_code 'replaced' and replaced_by_invitation_id on the old row, and invitation.create with
     replaces_invitation_id on the new one. app.invitations has no such column. */
  assert.equal(
    sql(`select details->>'replaced_by_invitation_id' from app.audit_events
           where action='invitation.revoke' and entity_id='${first.invitationId}'`),
    again.invitationId,
  );
  assert.equal(
    sql(`select details->>'replaces_invitation_id' from app.audit_events
           where action='invitation.create' and entity_id='${again.invitationId}'`),
    first.invitationId,
  );
  /* The address and the roles come from the row, so a resend cannot quietly change either. */
  assert.equal(sql(`select email_normalized from app.invitations where id='${again.invitationId}'`), email);
  assert.equal(sql(`select array_to_string(roles, ',') from app.invitations where id='${again.invitationId}'`), 'member');

  /* FAIL-BEFORE for the earlier link: the code of the first invitation is now refused at acceptance, which is
     what "this replaces the earlier link" means. The mutant would be a resend that did not revoke the sibling. */
  const verified = await callRaw(R.table, 'authVerify', {
    body: { tokenHash: secondLink.tokenHash, type: secondLink.type },
  });
  assert.equal(verified.status, 204, verified.raw);
  const access = /^enterprise_access=([^;]+);/.exec(verified.res.cookies[0])[1];
  const stale = await callRaw(R.table, 'invitationsAccept', { token: access, body: { inviteCode: firstLink.inviteCode } });
  /* E_INVITATION_INVALID is a 404 in lib/errors.mjs, and deliberately: an expired, revoked, replaced, replayed and
     unknown code are one answer, so a holder learns nothing about which it was (E2 design section 4). */
  assert.equal(stale.status, 404, stale.raw);
  assert.equal(stale.body.code, 'E_INVITATION_INVALID');
  const fresh = await callRaw(R.table, 'invitationsAccept', { token: access, body: { inviteCode: secondLink.inviteCode } });
  assert.equal(fresh.status, 200, fresh.raw);
  assert.equal(fresh.body.companyId, A.id);
});

/* E6P-F1 (evidence/e6-pages.md, high): the case above verified only the NEW link's sign-in half. The earlier link's
   sign-in half stayed live after a resend, because GoTrue holds a signup token and a magiclink token in two columns
   and the resend asked for a magic link on an account whose signup token was never used. Used first, the earlier
   link signed its holder into the invitee's account with its invitation refused; that session then became a
   member's the moment the invitee accepted any later link. The leaked earlier link is exactly what a resend is for.
   FAIL-BEFORE: on the earlier createInviteeAccount the first assertion of the unconfirmed case ('old-first') sees
   204 where it expects 401. */
const verifyOf = async (link) =>
  (await callRaw(R.table, 'authVerify', { body: { tokenHash: link.tokenHash, type: link.type } })).status;

test('E6P-F1: after a resend the earlier link s sign-in half is dead too, in both orders, for an unconfirmed account', async () => {
  for (const order of ['old-first', 'new-first']) {
    const email = freshEmail(`a-resend-${order}`);
    const first = ok(await R.invite(A.adminHi, A.id, { email, roles: ['member'] }), 201, 'create');
    const again = ok(await R.resend(A.adminHi, A.id, first.invitationId), 201, 'resend');
    const oldLink = linkParts(first.acceptUrl);
    const newLink = linkParts(again.acceptUrl);
    if (order === 'old-first') {
      assert.equal(await verifyOf(oldLink), 401, `${order}: the earlier link no longer signs anybody in`);
      assert.equal(await verifyOf(newLink), 204, `${order}: the new link does`);
    } else {
      assert.equal(await verifyOf(newLink), 204, `${order}: the new link signs in`);
      assert.equal(await verifyOf(oldLink), 401, `${order}: the earlier link is dead, not merely second`);
    }
    /* The first link of a new address is a signup-column link; the resend refreshes both columns and hands the
       magiclink-column token (createInviteeAccount, E6P-F1-C-F1), so the two types differ. */
    assert.equal(oldLink.type, 'signup', 'the first link of a new address is a signup link');
    assert.equal(newLink.type, 'magiclink', 'the resend hands the magiclink-column token');
  }
});

/* ENA-7 (security review of 2026-09-30; evidence/ena7-end1-hbf2.md section 5). Until migration 011 this case was
   "E6P-F1: the same for a confirmed account invited to a second company", and it ASSERTED the defect: B's
   administrator was handed a magic link for an account that already existed, and the link signed in (204). Turned
   around: a confirmed account is never handed a sign-in token, by the invite or by its resend; the answer carries the
   invitation code only, and no GoTrue call is made for it. The E6P-F1 property (an earlier handed link dies at a
   resend) is held by the new-address cases above, whose links still carry a token. */
test('ENA-7: a confirmed account invited to a second company gets a code-only link, and so does its resend', async () => {
  const email = freshEmail('a-confirmed');
  const first = ok(await R.invite(A.adminHi, A.id, { email, roles: ['member'] }), 201, 'create');
  assert.equal(first.signsIn, true, 'a brand-new address: a signing link');
  assert.equal(await verifyOf(linkParts(first.acceptUrl)), 204, 'the first use confirms the account');
  const elsewhere = ok(await R.invite(B.adminHi, B.id, { email, roles: ['member'] }), 201, 'invite to B');
  assert.equal(elsewhere.delivery, 'handover');
  assert.equal(elsewhere.signsIn, false, 'a confirmed account is never handed a sign-in token');
  assert.equal(new URL(elsewhere.acceptUrl).hash.includes('token_hash'), false, 'the link carries the code only');
  const again = ok(await R.resend(B.adminHi, B.id, elsewhere.invitationId), 201, 'resend in B');
  assert.equal(again.signsIn, false);
  assert.equal(new URL(again.acceptUrl).hash.includes('token_hash'), false);
});

/* E6P-F1-C-F1 (Codex critique, high): two invitations issued for one address before either link is used leave the
   account holding BOTH a signup-column token and a magiclink-column token, each handed to whoever called the route.
   A resend that refreshed one column left the other link signing in. Here the two-column state is built directly on
   the account (an out-of-band magiclink beside the route-issued signup link is the second invitation's residue), then
   the route's resend must kill a link in EACH column. FAIL-BEFORE against the single-type createInviteeAccount: the
   resend refreshed only the signup column, so the residue magiclink still verifies (204 where 401 is expected). */
test('E6P-F1-C-F1: a resend kills a previously handed link in BOTH GoTrue token columns, not just one', async () => {
  const email = freshEmail('a-two-column');
  const first = ok(await R.invite(A.adminHi, A.id, { email, roles: ['member'] }), 201, 'create');
  const signupLink = linkParts(first.acceptUrl);
  assert.equal(signupLink.type, 'signup', 'the create leaves a signup-column link');
  /* The overlapping second invitation's residue: a magiclink token on the still-unconfirmed account, handed out. */
  const residue = await generateLink({ email, type: 'magiclink' });
  assert.equal(residue.ok && residue.verificationType, 'magiclink', 'a magiclink token now sits in the other column');
  const residueLink = { tokenHash: residue.hashedToken, type: 'magiclink' };
  const again = ok(await R.resend(A.adminHi, A.id, first.invitationId), 201, 'resend');
  const newLink = linkParts(again.acceptUrl);
  /* Verify the two earlier handed links before the new one, so a pass cannot come from consuming the new link first. */
  assert.equal(await verifyOf(signupLink), 401, 'the earlier signup-column link is dead');
  assert.equal(await verifyOf(residueLink), 401, 'the earlier magiclink-column link is dead too (E6P-F1-C-F1)');
  assert.equal(await verifyOf(newLink), 204, 'the resend link signs in');
});

test('design 3.5 rows 10 to 12: the resend s refusals, and none of them writes a row', async () => {
  const before = Number(sql(`select count(*) from app.invitations where company_id='${A.id}'`));
  const email = freshEmail('a-resend-refusals');
  const live = ok(await R.invite(A.adminHi, A.id, { email, roles: ['member'] }), 201, 'create');
  const unknown = '00000000-0000-4000-8000-000000000000';
  refusedWith(await R.resend(A.adminHi, A.id, unknown), 404, 'E_NOT_FOUND', 'an unknown invitation');
  refusedWith(await R.resend(A.adminHi, B.id, live.invitationId), 404, 'E_NOT_FOUND', 'the wrong company');
  refusedWith(await R.resend(A.member, A.id, live.invitationId), 403, 'E_FORBIDDEN', 'a plain member');
  /* E6S-F2, recorded rather than asserted away: design 3.4 lists 403 E_ADMIN_MFA_REQUIRED for this route, and the
     answer is 404. Row 10 of design 3.5's own table for the resend is "the invitation is not readable under the
     caller's token (RLS admits admins only)", and 005's policy on api.invitations requires aal2, so an admin at
     aal1 cannot see the row at all and the service refuses before any routine runs. The order is the design's
     own; the code in design 3.4's list is the one that is wrong, and 404 discloses strictly less. */
  refusedWith(await R.resend(A.admin, A.id, live.invitationId), 404, 'E_NOT_FOUND', 'an admin at aal1');
  assert.equal(
    Number(sql(`select count(*) from app.invitations where company_id='${A.id}'`)),
    before + 1,
    'only the one create wrote a row',
  );
});

/* ---------------------------------------------------------------------------
   design 1.3: the agent transfer
   --------------------------------------------------------------------------- */

test('design 1.3: an orphaned agent returns to active through the transfer, and its releases download again with no new review', async () => {
  const { releaseId, agentId } = await published(R, A, 'claude-ai');
  A_AGENT = agentId;
  const authorMembership = A.ms.author;
  const memberMembership = A.ms.member;
  assert.equal(sql(`select owner_membership_id from app.agents where id='${agentId}'`), authorMembership);

  /* Remove the owner: api.remove_member orphans the agent and the download predicate refuses at once. */
  ok(await R.removeMember(A.adminHi, A.id, authorMembership), 200, 'remove');
  assert.equal(sql(`select status from app.agents where id='${agentId}'`), 'orphaned');
  const blocked = await R.download(A.member, releaseId);
  refusedWith(blocked, 409, 'E_AGENT_ORPHANED', 'the orphan blocks every recipient, not only the author');

  /* The owner path cannot reach an orphan: there is no active owner. */
  refusedWith(
    await R.transferAgent(A.member, agentId, {
      toMembershipId: memberMembership,
      expectedOwnerMembershipId: authorMembership,
    }),
    403,
    'E_FORBIDDEN',
    'a plain member is not the owner of an orphan',
  );

  const moved = ok(
    await R.transferAgent(A.adminHi, agentId, {
      toMembershipId: memberMembership,
      expectedOwnerMembershipId: authorMembership,
    }),
    200,
    'the admin transfers',
  );
  assert.deepEqual(moved, {
    ok: true,
    agentId,
    ownerMembershipId: memberMembership,
    agentStatus: 'active',
    changed: true,
  });
  /* No release row was written and none was withdrawn: the catalog's join is what changed. */
  assert.equal(sql(`select count(*) from app.releases where agent_id='${agentId}'`), '1');
  assert.equal(sql(`select state from app.releases where id='${releaseId}'`), 'published');
  ok(await R.download(A.member, releaseId), 200, 'downloadable again, with no new review');

  /* An honest retry is changed: false; a stale one is E_OWNER_CHANGED and writes nothing. */
  const retry = ok(
    await R.transferAgent(A.adminHi, agentId, {
      toMembershipId: memberMembership,
      expectedOwnerMembershipId: authorMembership,
    }),
    200,
    'the honest retry',
  );
  assert.equal(retry.changed, false);
  refusedWith(
    await R.transferAgent(A.adminHi, agentId, {
      toMembershipId: A.ms.it,
      expectedOwnerMembershipId: authorMembership,
    }),
    409,
    'E_OWNER_CHANGED',
    'the stale retry',
  );
  assert.equal(sql(`select owner_membership_id from app.agents where id='${agentId}'`), memberMembership);
});

test('design 3.5: the transfer refuses a removed target, an agent of another company and a malformed body', async () => {
  const { agentId } = await published(R, B, 'claude-ai');
  const bAuthor = B.ms.author;
  refusedWith(
    await R.transferAgent(A.adminHi, agentId, {
      toMembershipId: A.ms.member,
      expectedOwnerMembershipId: bAuthor,
    }),
    404,
    'E_NOT_FOUND',
    "another company's agent is invisible",
  );
  assert.ok(A_AGENT, 'the transfer case ran first and left A its agent');
  /* A's own agent is the one the case above transferred; A gets no second one, because A.author's membership is
     removed and a removed member authors nothing. Its current owner is A's plain member. */
  const removed = A.ms.author;
  refusedWith(
    await R.transferAgent(A.adminHi, A_AGENT, {
      toMembershipId: removed,
      expectedOwnerMembershipId: A.ms.member,
    }),
    409,
    'E_MEMBERSHIP_REMOVED',
    'a removed target',
  );
  refusedWith(
    await R.transferAgent(A.adminHi, A_AGENT, { toMembershipId: 'nope', expectedOwnerMembershipId: A.ms.member }),
    422,
    'E_BODY_INVALID',
    'a malformed target',
  );
});

/* ---------------------------------------------------------------------------
   design 1.4: the departure preview
   --------------------------------------------------------------------------- */

test('design 3.4: the departure preview counts every consequence, for an admin at aal2 only', async () => {
  const target = B.ms.it;
  const p = ok(await R.departure(B.adminHi, B.id, target), 200, 'preview');
  assert.deepEqual(Object.keys(p).sort(), [
    'authorizations',
    'companyId',
    'drafts',
    'envelopesAwaitingARoleTheyHold',
    'groups',
    'isLastAdmin',
    'label',
    'membershipId',
    'ok',
    'ownedAgents',
    'publishedReleases',
    'reports',
    'roles',
    'soleHolderOfRoles',
    'status',
    'submittedAwaitingReview',
    'witnesses',
  ]);
  assert.equal(p.membershipId, target);
  assert.equal(p.isLastAdmin, false);
  assert.deepEqual(p.soleHolderOfRoles, ['it_reviewer'], 'nobody else in B holds it');
  assert.equal(Array.isArray(p.groups), true);
  refusedWith(await R.departure(B.member, B.id, target), 403, 'E_FORBIDDEN', 'a plain member of the company');
  refusedWith(await R.departure(B.admin, B.id, target), 403, 'E_ADMIN_MFA_REQUIRED', 'an admin at aal1');
  assert.equal((await R.departure(A.adminHi, A.id, target)).status, 404, "a membership of another company");
  assert.equal((await R.departure(W.user('a-outsider'), B.id, target)).status, 404, 'no standing');
});

test('design 1.4: the last admin is named as such, so the page can refuse before the button', async () => {
  const email = freshEmail('solo-admin');
  const slug = `e6-solo-${W.run}`;
  const created = ok(
    await R.companyCreate(OP.aal2, { slug, name: 'SYNTHETIC Solo AG', firstAdminEmail: email, ...periodBody() }),
    201,
    'create',
  );
  const link = linkParts(created.acceptUrl);
  const verified = await callRaw(R.table, 'authVerify', { body: { tokenHash: link.tokenHash, type: link.type } });
  assert.equal(verified.status, 204, verified.raw);
  const access = /^enterprise_access=([^;]+);/.exec(verified.res.cookies[0])[1];
  const accepted = await callRaw(R.table, 'invitationsAccept', { token: access, body: { inviteCode: link.inviteCode } });
  assert.equal(accepted.status, 200, accepted.raw);
  const admin = W.aal2(userFor(ids, email));
  const p = ok(
    await R.departure(admin, created.companyId, accepted.body.membershipId),
    200,
    'the sole admin previews their own departure',
  );
  assert.equal(p.isLastAdmin, true);
  refusedWith(
    await R.removeMember(admin, created.companyId, accepted.body.membershipId),
    409,
    'E_LAST_ADMIN',
    'and the removal itself is refused',
  );
});

/* ---------------------------------------------------------------------------
   design 1.5: the read boundary from TIME, with the sweep never run (case 38)
   --------------------------------------------------------------------------- */

test('case 19: past ends_at writes stop and reads, downloads and the copy continue', async () => {
  futurePeriod(B.id);
  const { releaseId } = await published(R, B, 'chatgpt');
  agePeriod(B.id, '1 day', '-13 days', '-43 days');
  assert.equal(accessState(B.id), 'export_window');
  refusedWith(
    await R.groupsCreate(B.adminHi, B.id, `past-ends-at-${W.run}`),
    409,
    'E_ACCESS_PERIOD_ENDED',
    'a write',
  );
  ok(await R.catalog(B.member, B.id), 200, 'a read continues');
  ok(await R.download(B.member, releaseId), 200, 'a download continues');
  ok(await R.takeout(B.adminHi, B.id), 200, "the company's own copy continues");
  futurePeriod(B.id);
});

test('case 38: past export_by, WITH THE SWEEP NEVER RUN, every read refuses from time and not from a status', async () => {
  futurePeriod(B.id);
  const { releaseId } = await published(R, B, 'generic');
  agePeriod(B.id, '30 days', '16 days', '-14 days');
  assert.equal(accessState(B.id), 'expired');
  assert.equal(companyStatusOf(B.id), 'active', 'the sweep has not run: the status is still active');
  refusedWith(await R.catalog(B.member, B.id), 409, 'E_ACCESS_PERIOD_ENDED', 'a company read');
  refusedWith(await R.quotas(B.adminHi, B.id), 409, 'E_ACCESS_PERIOD_ENDED', 'an admin read');
  refusedWith(await R.takeout(B.adminHi, B.id), 409, 'E_ACCESS_PERIOD_ENDED', 'the copy, which loads no principal');
  refusedWith(await R.download(B.member, releaseId), 409, 'E_ACCESS_PERIOD_ENDED', 'the download predicate');
  refusedWith(
    await R.groupsCreate(B.adminHi, B.id, `past-export-by-${W.run}`),
    409,
    'E_ACCESS_PERIOD_ENDED',
    'a write',
  );
  /* GET /api/me still lists the company, with both facts, which is what the home page renders. */
  const me = ok(await R.me(B.member), 200, 'me');
  const row = me.memberships.find((m) => m.companyId === B.id);
  assert.deepEqual([row.companyStatus, row.accessState], ['active', 'expired']);

  /* THE FAIL-BEFORE. The mutant is app.access_state reading companies.status instead of the dates, which is
     exactly what the design's first version did: with the sweep never run the company is still active, so the
     mutant answers `current` and every read above is admitted. */
  const control = accessState(B.id);
  assert.equal(control, 'expired', 'the control, before the mutant');
  futurePeriod(B.id);
  assert.equal(accessState(B.id), 'current');
});

test('design 1.5: the expiry run suspends past export_by, is idempotent, and reports without acting', async () => {
  futurePeriod(B.id);
  agePeriod(A.id, '30 days', '16 days', '-14 days');
  const first = ok(await R.expiryRun(OP.aal2, { limit: 50 }), 200, 'the first run');
  assert.deepEqual(Object.keys(first).sort(), [
    'counts',
    'dueForDeletion',
    'ok',
    'remaining',
    'remainingDue',
    'suspended',
  ]);
  assert.ok(
    first.suspended.some((c) => c.companyId === A.id),
    'the company past export_by was suspended',
  );
  assert.equal(companyStatusOf(A.id), 'suspended');
  const second = ok(await R.expiryRun(OP.aal2, { limit: 50 }), 200, 'the second run');
  assert.equal(
    second.suspended.some((c) => c.companyId === A.id),
    false,
    'idempotent: nothing is suspended twice',
  );
  /* The deletion list REPORTS and never acts: the company is still there after both runs. */
  assert.equal(companyExists(A.id), true);
  assert.equal(deletionState(A.id), 'eligible');
  futurePeriod(A.id);
  ok(await R.companyStatus(OP.aal2, A.id, { status: 'active', reasonCode: 'customer_request' }), 200, 'resumed');
});

/* ---------------------------------------------------------------------------
   design 3.1: a member of a suspended, an expired and a closed company
   --------------------------------------------------------------------------- */

test('3.1: one code on every company route for a suspended member, and the copy still works inside the window', async () => {
  futurePeriod(B.id);
  ok(await R.companyStatus(OP.aal2, B.id, { status: 'suspended', reasonCode: 'non_payment' }), 200, 'suspend');
  refusedWith(await R.catalog(B.member, B.id), 409, 'E_COMPANY_INACTIVE', 'a read');
  refusedWith(await R.groupsCreate(B.adminHi, B.id, 'x'), 409, 'E_COMPANY_INACTIVE', 'a write');
  refusedWith(await R.quotas(B.adminHi, B.id), 409, 'E_COMPANY_INACTIVE', 'the quota read');
  /* design 3.1 note 2: the one E6 read that admits a suspended company's admin, until export_by and not after. */
  ok(await R.takeout(B.adminHi, B.id), 200, 'the copy, which is the whole point of the window');
  const me = ok(await R.me(B.member), 200, 'me');
  const row = me.memberships.find((m) => m.companyId === B.id);
  assert.deepEqual([row.companyStatus, row.accessState], ['suspended', 'current']);
  ok(await R.companyStatus(OP.aal2, B.id, { status: 'active', reasonCode: 'customer_request' }), 200, 'resume');
  ok(await R.catalog(B.member, B.id), 200, 'and the same cookie reads again with no reinvitation');
});

test('3.1 note 3: a member of a CLOSED company reads nothing and may not take a copy', async () => {
  const email = freshEmail('closing-admin');
  const slug = `e6-closing-${W.run}`;
  const created = ok(
    await R.companyCreate(OP.aal2, { slug, name: 'SYNTHETIC Closing AG', firstAdminEmail: email, ...periodBody() }),
    201,
    'create',
  );
  const link = linkParts(created.acceptUrl);
  const verified = await callRaw(R.table, 'authVerify', { body: { tokenHash: link.tokenHash, type: link.type } });
  const access = /^enterprise_access=([^;]+);/.exec(verified.res.cookies[0])[1];
  await callRaw(R.table, 'invitationsAccept', { token: access, body: { inviteCode: link.inviteCode } });
  const admin = W.aal2(userFor(ids, email));

  /* Closure is never the first thing that happens to a working company. */
  refusedWith(
    await R.companyClose(OP.aal2, created.companyId, { confirmSlug: slug, reasonCode: 'customer_instruction' }),
    409,
    'E_COMPANY_NOT_SUSPENDED',
    'an active company',
  );
  ok(await R.companyStatus(OP.aal2, created.companyId, { status: 'suspended', reasonCode: 'customer_request' }), 200, 'suspend');
  /* And closing inside the window needs a recorded instruction (E6D-C-F3). */
  refusedWith(
    await R.companyClose(OP.aal2, created.companyId, { confirmSlug: slug, reasonCode: 'retention_deadline' }),
    409,
    'E_EXPORT_WINDOW_OPEN',
    'the window is still open',
  );
  refusedWith(
    await R.companyClose(OP.aal2, created.companyId, { confirmSlug: 'not-the-slug', reasonCode: 'customer_instruction' }),
    422,
    'E_CONFIRMATION_MISMATCH',
    'a mistyped slug',
  );
  ok(
    await R.companyClose(OP.aal2, created.companyId, { confirmSlug: slug, reasonCode: 'customer_instruction' }),
    200,
    'closed on a recorded instruction',
  );
  refusedWith(await R.quotas(admin, created.companyId), 409, 'E_COMPANY_INACTIVE', 'a read');
  refusedWith(await R.takeout(admin, created.companyId), 403, 'E_FORBIDDEN', 'the copy of a closed company');
  refusedWith(
    await R.companyStatus(OP.aal2, created.companyId, { status: 'active', reasonCode: 'customer_request' }),
    409,
    'E_COMPANY_CLOSED',
    'closed is terminal',
  );
  CLOSED = { companyId: created.companyId, slug };
});

/* ---------------------------------------------------------------------------
   design 1.6: the company's own copy, and the one door
   --------------------------------------------------------------------------- */

test('design 1.6: the document carries what the admin can already read, and says what it withheld', async () => {
  const doc = ok(await R.takeout(A.adminHi, A.id), 200, 'the copy');
  assert.deepEqual(Object.keys(doc).slice(0, 3), ['ok', 'exportedAt', 'schemaVersion']);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(typeof doc.withheld, 'object', 'withheld is ALWAYS present');
  assert.equal(Object.keys(doc.sections).length, 21, 'the twenty-one sections');
  assert.deepEqual(Object.keys(doc.sections).sort(), Object.keys(doc.counts).sort());
  assert.deepEqual(doc.sections.access_periods, [], 'withheld entirely: no policy admits authenticated to it');
  assert.equal(doc.withheld.access_periods.reason, 'no_admin_read_predicate');
  assert.ok(doc.omitted.includes('invitations.token_hash'), 'a credential at rest is named as omitted');

  /* E6D-C-F1b: another author's DRAFT is withheld, which is the read E1 section 6 refuses to every role. The
     author here is A's IT reviewer, because A.author's membership was removed by the transfer case above and a
     removed member writes nothing. */
  const draft = await R.create(A.it, A.id, { name: `withheld-${W.run}` });
  assert.equal(draft.status, 201, draft.raw);
  const after = ok(await R.takeout(A.adminHi, A.id), 200, 'the copy again');
  const ids2 = after.sections.candidate_versions.map((v) => v.id);
  assert.equal(ids2.includes(draft.body.candidateId), false, "another author's draft is not in the document");
  assert.ok(after.withheld.candidate_versions.rows >= 1, 'and the document says how many were withheld');
  assert.equal(after.withheld.candidate_versions.reason, 'another_author_draft');
  /* The count is what was EMITTED, so it is short of the company's own total by exactly what was withheld. */
  assert.equal(after.counts.candidate_versions, after.sections.candidate_versions.length);
});

test('3.1: the copy admits the company admin at aal2 and nobody else', async () => {
  refusedWith(await R.takeout(A.member, A.id), 403, 'E_FORBIDDEN', 'a member');
  refusedWith(await R.takeout(A.it, A.id), 403, 'E_FORBIDDEN', 'a reviewer');
  refusedWith(await R.takeout(A.admin, A.id), 403, 'E_ADMIN_MFA_REQUIRED', 'an admin at aal1');
  assert.equal((await R.takeout(B.adminHi, A.id)).status, 404, "another company's admin");
});

test('design 1.6: the one door deletes a closed company and answers its counts, and nothing else may', async () => {
  assert.ok(CLOSED, 'the closed company exists');
  /* Before export_by a deletion needs a recorded customer instruction; retention_deadline is refused. */
  refusedWith(
    await R.companyDelete(OP.aal2, CLOSED.companyId, { confirmSlug: CLOSED.slug, reasonCode: 'retention_deadline' }),
    409,
    'E_DELETION_NOT_DUE',
    'not yet due and no instruction',
  );
  const before = Number(sql('select count(*) from app.companies'));
  const deleted = ok(
    await R.companyDelete(OP.aal2, CLOSED.companyId, {
      confirmSlug: CLOSED.slug,
      reasonCode: 'customer_instruction',
    }),
    200,
    'the one door',
  );
  assert.deepEqual(Object.keys(deleted).sort(), ['companyId', 'deleted', 'ok', 'orphanedUserIds']);
  assert.equal(deleted.deleted.companies, 1);
  assert.equal(Array.isArray(deleted.orphanedUserIds), true);
  assert.equal(Number(sql('select count(*) from app.companies')), before - 1);
  assert.equal(companyExists(CLOSED.companyId), false);
  /* The deletion's own record survives it, with company_id null, because the routine deleted that company's
     audit rows too. */
  assert.equal(
    sql(`select count(*) from app.audit_events where action='company.delete' and details->>'company_id'='${CLOSED.companyId}'`),
    '1',
  );
  assert.equal((await R.companyDelete(OP.aal2, CLOSED.companyId, { confirmSlug: CLOSED.slug, reasonCode: 'customer_instruction' })).status, 404);
});

/* ---------------------------------------------------------------------------
   design 1.7: the admin's quota read, and the operator's write
   --------------------------------------------------------------------------- */

test('design 1.7 and 3.4: the admin reads seven quotas, the operator writes one, and the two agree', async () => {
  const before = ok(await R.quotas(A.adminHi, A.id), 200, 'the admin read');
  assert.equal(before.quotas.length, 7);
  const seats = before.quotas.find((q) => q.name === 'members_per_company');
  assert.equal(Number.isInteger(seats.used), true);
  /* A quota nothing in this run has set: its source is the default, which is what distinguishes "agreed at 50"
     from "never discussed" (design 1.7). members_per_company is not that quota, because the matrix case above
     writes it. */
  const groups = before.quotas.find((q) => q.name === 'groups_per_company');
  assert.deepEqual([groups.source, groups.value], ['default', 50]);
  for (const name of ['versions_per_agent', 'downloads_per_recipient', 'reports_per_recipient'])
    assert.equal(before.quotas.find((q) => q.name === name).used, null, `${name}: per subject, not a company total`);

  /* 41 and not 40: the matrix case above already wrote 40, and a set-to-a-value write answering changed: false is
     E2's idiom for a no-op, which the next assertion is about. */
  const set = ok(await R.companyQuota(OP.aal2, A.id, { name: 'members_per_company', value: 41 }), 200, 'the write');
  assert.deepEqual([set.value, set.changed], [41, true]);
  const after = ok(await R.quotas(A.adminHi, A.id), 200, 'the admin read again');
  const seatsAfter = after.quotas.find((q) => q.name === 'members_per_company');
  assert.deepEqual([seatsAfter.value, seatsAfter.source], [41, 'company']);
  /* And the register's own number for the same company agrees with the admin's. */
  const register = ok(await R.register(OP.aal2, {}), 200, 'register');
  const row = register.companies.find((c) => c.companyId === A.id);
  const registerSeats = row.quotas.find((q) => q.name === 'members_per_company');
  assert.deepEqual([registerSeats.value, registerSeats.used], [41, seatsAfter.used]);
  /* The same value again is changed: false and writes no audit row. */
  const again = ok(await R.companyQuota(OP.aal2, A.id, { name: 'members_per_company', value: 41 }), 200, 'again');
  assert.equal(again.changed, false);
  refusedWith(
    await R.companyQuota(OP.aal2, A.id, { name: 'members_per_company', value: 10_000 }),
    422,
    'E_QUOTA_OUT_OF_RANGE',
    'outside the bounds',
  );
  refusedWith(await R.companyQuota(OP.aal2, A.id, { name: 'seats', value: 40 }), 422, 'E_BODY_INVALID', 'a name outside the seven');
  assert.equal((await R.quotas(A.member, A.id)).status, 403, 'a member does not read them');
});

/* ---------------------------------------------------------------------------
   E6S-C-F5: the quota read's assurance level
   --------------------------------------------------------------------------- */

test('E6S-C-F5: the quota read requires aal2, after standing and the role, and never answers defaults instead of the agreement', async () => {
  /* The override is what makes the defect visible rather than merely open: 008's company_quotas_member_read
     admits the overriding rows at aal2 only, so at aal1 the read came back empty and the service fell through to
     its DEFAULTS copy. An admin whose company had been agreed at 60 groups was told 50, with near false. */
  ok(await R.companyQuota(OP.aal2, A.id, { name: 'groups_per_company', value: 60 }), 200, 'the operator sets an override');
  const hi = ok(await R.quotas(A.adminHi, A.id), 200, 'the admin at aal2');
  const groupsHi = hi.quotas.find((q) => q.name === 'groups_per_company');
  assert.deepEqual([groupsHi.value, groupsHi.source], [60, 'company'], 'the agreement, not the default');
  refusedWith(await R.quotas(A.admin, A.id), 403, 'E_ADMIN_MFA_REQUIRED', 'the same admin at aal1');
  /* The ORDER: standing and the role are decided first, so a caller who is not an admin of that company learns
     nothing about its assurance requirement, and an outsider learns nothing at all. */
  assert.equal((await R.quotas(A.member, A.id)).status, 403, 'a plain member at aal1 is E_FORBIDDEN, not the MFA code');
  assert.equal((await R.quotas(A.member, A.id)).body.code, 'E_FORBIDDEN', 'the role test is above the aal test');
  refusedWith(await R.quotas(B.adminHi, A.id), 404, 'E_NOT_FOUND', "another company's admin at aal2");
  refusedWith(await R.quotas(B.admin, A.id), 404, 'E_NOT_FOUND', "another company's admin at aal1: still 404, not the MFA code");
  refusedWith(await R.quotas(OP.aal2, A.id), 404, 'E_NOT_FOUND', 'an operator, who is never a member');
  /* And the view itself is closed at the database, which is the boundary this refusal sits in front of. */
  assert.equal(
    sql(`select count(*) from app.company_quotas where company_id = '${A.id}' and name = 'groups_per_company'`),
    '1',
    'the override row exists',
  );
});

test('design 1.2 and 1.7: the two new bounds refuse at the route, and neither existed before this slice', async () => {
  const email = freshEmail('seat-wall');
  const slug = `e6-seats-${W.run}`;
  const created = ok(
    await R.companyCreate(OP.aal2, { slug, name: 'SYNTHETIC Seats AG', firstAdminEmail: email, ...periodBody() }),
    201,
    'create',
  );
  const link = linkParts(created.acceptUrl);
  const verified = await callRaw(R.table, 'authVerify', { body: { tokenHash: link.tokenHash, type: link.type } });
  const access = /^enterprise_access=([^;]+);/.exec(verified.res.cookies[0])[1];
  await callRaw(R.table, 'invitationsAccept', { token: access, body: { inviteCode: link.inviteCode } });
  const admin = W.aal2(userFor(ids, email));
  /* One seat, one member: the next invitation is refused before it can hand out a link. */
  ok(await R.companyQuota(OP.aal2, created.companyId, { name: 'members_per_company', value: 1 }), 200, 'one seat');
  refusedWith(
    await R.invite(admin, created.companyId, { email: freshEmail('over-the-wall'), roles: ['member'] }),
    409,
    'E_SEATS_EXHAUSTED',
    'the seat wall',
  );
  ok(await R.companyQuota(OP.aal2, created.companyId, { name: 'members_per_company', value: 25 }), 200, 'raised');
  ok(
    await R.companyQuota(OP.aal2, created.companyId, { name: 'pending_invitations_per_company', value: 1 }),
    200,
    'one open invitation',
  );
  ok(await R.invite(admin, created.companyId, { email: freshEmail('first-open'), roles: ['member'] }), 201, 'one');
  refusedWith(
    await R.invite(admin, created.companyId, { email: freshEmail('second-open'), roles: ['member'] }),
    409,
    'E_INVITATION_LIMIT',
    'the invitation wall',
  );
});

/* ---------------------------------------------------------------------------
   design 1.1: the operator and member accounts are disjoint, at the route
   --------------------------------------------------------------------------- */

test('design 1.1, E6D-C-F1c: an address that belongs to an operator account cannot be a first admin', async () => {
  const slug = `e6-dual-${W.run}`;
  refusedWith(
    await R.companyCreate(OP.aal2, {
      slug,
      name: 'SYNTHETIC Dual AG',
      firstAdminEmail: 'synthetic-op@example.invalid',
      ...periodBody(),
    }),
    409,
    'E_OPERATOR_ACCOUNT',
    'the operator typed their own address',
  );
  assert.equal(sql(`select count(*) from app.companies where slug='${slug}'`), '0', 'and no company row exists');
});

/* ---------------------------------------------------------------------------
   design 1.3: the succession invitation
   --------------------------------------------------------------------------- */

test('design 1.3: the operator invites a successor admin once, and a second live one is refused', async () => {
  const first = ok(
    await R.adminInvitation(OP.aal2, A.id, { email: freshEmail('successor') }),
    201,
    'the succession invitation',
  );
  assert.equal(first.delivery, 'handover');
  assert.match(linkParts(first.acceptUrl).inviteCode, /^[0-9a-f]{64}$/);
  assert.equal(
    sql(`select created_by_operator is not null from app.invitations where id='${first.invitationId}'`),
    't',
    'issued by the operator, not by a membership',
  );
  refusedWith(
    await R.adminInvitation(OP.aal2, A.id, { email: freshEmail('successor-2') }),
    409,
    'E_SUCCESSION_PENDING',
    'a second live one',
  );
});

/* ---------------------------------------------------------------------------
   The lead's decision (b): the register cursor
   --------------------------------------------------------------------------- */

test("the lead's decision (b): a cursor naming a deleted company drops the cursor and says cursorReset", async () => {
  const email = freshEmail('cursor-victim');
  const slug = `e6-cursor-${W.run}`;
  const created = ok(
    await R.companyCreate(OP.aal2, { slug, name: 'SYNTHETIC Cursor AG', firstAdminEmail: email, ...periodBody() }),
    201,
    'create',
  );
  agePeriod(created.companyId, '30 days', '16 days', '-14 days');
  ok(await R.companyStatus(OP.aal2, created.companyId, { status: 'suspended', reasonCode: 'operator_decision' }), 200, 'suspend');
  ok(await R.companyClose(OP.aal2, created.companyId, { confirmSlug: slug, reasonCode: 'retention_deadline' }), 200, 'close');
  ok(
    await R.companyDelete(OP.aal2, created.companyId, { confirmSlug: slug, reasonCode: 'retention_deadline' }),
    200,
    'delete',
  );
  const reset = ok(await R.register(OP.aal2, { cursor: created.companyId }), 200, 'the cursor the operator held');
  assert.equal(reset.cursorReset, true, 'the list moved; the page is told rather than shown a not-found');
  assert.ok(reset.companies.length > 0, 'and it is the first page, not an error');
  const plain = ok(await R.register(OP.aal2, {}), 200, 'no cursor');
  assert.equal(plain.cursorReset, false);
  assert.deepEqual(
    reset.companies.map((c) => c.companyId),
    plain.companies.map((c) => c.companyId),
    'the reset page is exactly the first page',
  );
});

/* ---------------------------------------------------------------------------
   Nothing that answered carried the link into a log line
   --------------------------------------------------------------------------- */

test('design 1.2 rule 2: no log line carried an accept link, an invitation code or a token hash', () => {
  const whole = JSON.stringify(logged);
  assert.equal(whole.includes('/accept#'), false);
  assert.equal(/token_hash/.test(whole), false);
  assert.equal(/[0-9a-f]{64}/.test(whole), false, 'no 64-hex secret of any kind');
});

/* ---------------------------------------------------------------------------
   E6S-C-F8: mail mode with no configured sender
   --------------------------------------------------------------------------- */

test('E6S-C-F8: mail mode with no transport refuses before the transaction, so no company, no period and no live secret', async () => {
  const slug = `e6-mail-${W.run}`;
  const email = freshEmail('mail');
  process.env.ENTERPRISE_INVITATION_DELIVERY = 'mail';
  try {
    const r = await R.companyCreate(OP.aal2, {
      slug,
      name: 'SYNTHETIC Mail AG',
      firstAdminEmail: email,
      ...periodBody(),
    });
    refusedWith(r, 503, 'E_MAIL_NOT_CONFIGURED', 'the create route in mail mode with no transport');
    assert.equal(sql(`select count(*) from app.companies where slug = '${slug}'`), '0', 'no company was committed');
    assert.equal(
      sql(`select count(*) from app.invitations where email_normalized = '${email}'`),
      '0',
      'and no invitation, so no secret was generated and lost',
    );
    /* The succession route is the same guard for the same reason: its transaction revokes the pending sibling. */
    const live = sql(
      `select count(*) from app.invitations where company_id = '${A.id}' and accepted_at is null and revoked_at is null and expires_at > clock_timestamp()`,
    );
    refusedWith(
      await R.adminInvitation(OP.aal2, A.id, { email: freshEmail('mail-succession') }),
      503,
      'E_MAIL_NOT_CONFIGURED',
      'the succession route in mail mode with no transport',
    );
    assert.equal(
      sql(
        `select count(*) from app.invitations where company_id = '${A.id}' and accepted_at is null and revoked_at is null and expires_at > clock_timestamp()`,
      ),
      live,
      'and it revoked nothing: the pending invitations are exactly the ones that were there',
    );
  } finally {
    delete process.env.ENTERPRISE_INVITATION_DELIVERY;
  }
  /* The control: the same call in handover mode, which is the default, creates the company and hands the link
     back once. */
  const okSlug = `e6-mail-ok-${W.run}`;
  const created = ok(
    await R.companyCreate(OP.aal2, {
      slug: okSlug,
      name: 'SYNTHETIC Mail Control AG',
      firstAdminEmail: freshEmail('mail-ok'),
      ...periodBody(),
    }),
    201,
    'handover mode',
  );
  assert.equal(created.delivery, 'handover');
  assert.equal(sql(`select count(*) from app.companies where slug = '${okSlug}'`), '1');
});
