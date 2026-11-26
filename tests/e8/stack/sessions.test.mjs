/* E8-3 (docs/e8/design.md 2.1's cached-and-expired-sessions row, 2.3 row E8-3), against the running local stack:
   a role change mid-session, on the cookie held across it.

   WHAT S2b ALREADY COVERS, AND WHAT IS LEFT (E8D-R-F16). tests/e2/stack/pages-reads.test.mjs S2b demotes a
   `company_admin` to `member` through `membersSetRoles` and asserts that account's `members` and `invitations`
   reads refused at both `aal1` and `aal2`, with the database agreeing, and repeats it at `:417`. Two things it
   does not do, and they are this case:
     1. BREADTH. S2b calls two E2 views, and for its demoted account only one of them refuses: a plain member may
        read the member list, so S2b's own `if (answer.status === 200) continue` skips it there and the demotion's
        refusal is asserted on the invitation read alone (its other refusals belong to its removed-member and
        outsider classes, which are a different attack). This file calls every route a plain member of the same company is not
        admitted by, fifteen of them, and that set is not written down here either: it is DERIVED by asking a
        comparable plain member the same well-formed request. Thirteen of the fifteen are refused for the role
        itself and two for the row's visibility, and the sweep covers both, because a route that never reaches the
        role check is still one a demoted administrator must not get through. The derived sets are pinned as
        literals in S11h's shape (tests/e2/stack/pages-bound.test.mjs), so a route joining or leaving either is a
        visible edit.
     2. THE HELD COOKIE. S2b mints its token AFTER the demotion (`mint({ sub: demoted.id, … })`), so the
        credential it presents was issued by a system that already knew the new role. Here the access token is
        minted ONCE, before the demotion, and the same bytes are presented afterwards. That is the difference the
        fail-before turns on.

   THE EXPECTED ANSWER IS NOT WRITTEN DOWN EITHER. For each admin-only route the demoted holder's answer must equal
   the answer a plain member of the same company got from the same request, byte for byte. Design 2.3 row E8-3's
   result is "each refused with the member's own refusal, not the admin's", and comparing with the member's actual
   observed answer is that sentence rather than a paraphrase of it.

   THE FAIL-BEFORE, and why it is one S2b would not catch. The mutant is a principal CACHED ACROSS REQUESTS in
   lib/services/principal.mjs: the first request for a (caller, company) pair keeps its answer and every later
   request reuses it. S2b cannot reach it, because S2b's demoted account makes no request before the demotion, so
   nothing is cached for it; and it calls only two routes. Here the held cookie makes one admin read BEFORE the
   demotion, which is what arms the cache, and then calls routes S2b never touches. The mutant is a COPY of lib/
   under .scratch/ (tests/e8/helpers/mutant-lib.mjs); nothing under lib/ is edited by this lane.

   WHAT THIS FILE DOES NOT CLAIM. Not that the token stops verifying: it does not, and that is by design. E2 design
   section 6 says `verifySession` checks the signature and the claims and never calls the Auth server, and section
   5 says deleting `auth.sessions` invalidates nothing. The claim here is narrower and is the one that matters for
   a demotion: the ROLE is read from `app.memberships` on every request, so an unchanged credential carries no
   authority it has lost.

   THE STACK. This file reseeds once through tests/db/00-seed.sh and builds its own users and companies. It runs
   after tests/e8/stack/tenancy-sweep.test.mjs in the gate's alphabetical order, and the gate runs
   --test-concurrency=1, so the two never share the stack at one time. Run alone:
   node --test --test-concurrency=1 tests/e8/stack/sessions.test.mjs */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { mintUserToken } from '../../e2/helpers/stack.mjs';
import { caller } from '../../e3/stack/helpers.mjs';
import {
  e4world,
  e6routes,
  enableTargets,
  freshEmail,
  published,
  reseed,
  reviewCompany,
  sql,
} from '../../e6/stack/helpers.mjs';
import { caughtAsync, mutantRoutes, removeMutants } from '../helpers/mutant-lib.mjs';
import { difference, noWrite, snapshot } from '../helpers/no-write.mjs';

after(() => removeMutants());

const ids = reseed();
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');

const alerts = [];
const routes = makeRoutes({ log: () => {}, alert: (event, fields) => alerts.push({ event, fields }) });
const call = caller(routes, COOKIES, makeRequest);
const R = await e6routes([]);
const W = e4world('e8s', ids);
enableTargets();

/** One setup call that must have succeeded, with the answer in the message when it did not. */
function built(label, answer, ...statuses) {
  assert.ok(statuses.includes(answer.status), `${label}: ${answer.status} ${answer.raw}`);
  return answer.body;
}

const A = await reviewCompany(W, R, 'demotion');
/* Three more memberships: the account that will be demoted while holding its cookie, a second one for the mutant
   run, and one disposable member to be the target of the removal and role-change routes, so that an admitted call
   would change a row nothing else in this file reads. A keeps two other administrators throughout, so the
   last-admin rule (E2 design section 3) never decides any of these answers. */
const HELD_USER = W.user('held-admin');
const HELD_MEMBERSHIP = W.member(A.id, HELD_USER, '{company_admin,member}');
const MUTANT_USER = W.user('mutant-admin');
const MUTANT_MEMBERSHIP = W.member(A.id, MUTANT_USER, '{company_admin,member}');
const SPARE_USER = W.user('spare');
const SPARE_MEMBERSHIP = W.member(A.id, SPARE_USER, '{member}');

const P = await published(R, A, 'claude-ai');
const INVITATION = built(
  'a pending invitation',
  await R.invite(A.adminHi, A.id, { email: freshEmail('demotion-pending'), roles: ['member'] }),
  201,
);
const AGENT_OWNER = sql(
  `select owner_membership_id from app.agents where id = '${P.agentId}'`,
);

/**
 * THE HELD COOKIE. Minted once, memoized, and presented unchanged for the rest of the file. `W.aal2(u)` mints on
 * every call, which is what S2b's `mint(...)` does per request, so it cannot express "the same cookie": the point
 * of this case is that the bytes in the cookie were issued before the demotion. The local stack has no TOTP
 * enrolment, so minting with the local secret is the only way to an `aal2` session (tests/e2/helpers/stack.mjs).
 */
const heldToken = mintUserToken({ sub: HELD_USER.id, email: HELD_USER.email, aal: 'aal2', ttl: 3600 });
const held = { who: 'the held admin cookie', id: HELD_USER.id, email: HELD_USER.email, token: () => heldToken };
/**
 * THE BASELINE PROBE, and why it is not `A.member`. The expected answer for the demoted holder is "the member's
 * own refusal", so the baseline has to be a member who differs from the demoted holder in the ROLE and in nothing
 * else. `reviewCompany` puts `A.member` in the company's audience group, and audience membership decides whether a
 * release row is visible at all (E5 design's catalogue predicate), so `A.member` answers `releasesWithdraw` 403
 * E_FORBIDDEN while an identical member outside the audience group answers 404 E_NOT_FOUND. Comparing the demoted
 * holder against `A.member` would have compared two things at once. The baseline is therefore SPARE_USER, a plain
 * member outside the audience group, which is exactly the demoted holder's standing; `A.member` is kept as a
 * second probe and the routes where the two disagree are asserted to be the release-keyed ones, with that reason,
 * rather than left as a surprise (E8T-F5).
 */
const spareHi = W.aal2(SPARE_USER);
const audienceHi = W.aal2(A.member);

/* ---------------------------------------------------------------------------------------------------
   The routes this case asks about, each with a request an entitled administrator would have sent
   --------------------------------------------------------------------------------------------------- */

/* WHY THIS TABLE IS NOT tests/e8/stack/tenancy-sweep.test.mjs's. That file's requests need only be well formed,
   because every call in it is refused for the tenant it names. These requests have to be ones that would SUCCEED
   for an administrator of THIS company, or "the demoted holder was admitted" could not be observed at all, and
   their ids are this file's own world. The two tables answer different questions and neither is a copy of the
   other; the exclusion table and the completeness assertion exist once, in the sweep. */
const idem = () => ({ 'idempotency-key': randomUUID() });
const CANDIDATES = {
  invitationsList: () => ({ params: { companyId: A.id } }),
  invitationsCreate: () => ({ params: { companyId: A.id }, body: { email: freshEmail('demoted'), roles: ['member'] } }),
  invitationsRevoke: () => ({ params: { companyId: A.id, invitationId: INVITATION.invitationId } }),
  invitationsResend: () => ({ params: { companyId: A.id, invitationId: INVITATION.invitationId } }),
  membersSetRoles: () => ({
    params: { companyId: A.id, membershipId: SPARE_MEMBERSHIP },
    body: { roles: ['member', 'it_reviewer'] },
  }),
  membersRemove: () => ({ params: { companyId: A.id, membershipId: SPARE_MEMBERSHIP } }),
  membersDeparture: () => ({ params: { companyId: A.id, membershipId: SPARE_MEMBERSHIP } }),
  quotasRead: () => ({ params: { companyId: A.id } }),
  companyTakeout: () => ({ params: { companyId: A.id } }),
  groupsList: () => ({ params: { companyId: A.id } }),
  groupsCreate: () => ({ params: { companyId: A.id }, body: { name: `Demotion ${randomUUID().slice(0, 8)}` } }),
  groupMembersAdd: () => ({ params: { companyId: A.id, groupId: A.groupId, membershipId: SPARE_MEMBERSHIP } }),
  groupMembersRemove: () => ({ params: { companyId: A.id, groupId: A.groupId, membershipId: A.ms.member } }),
  releasesPublish: () => ({
    params: { candidateId: P.candidateId },
    headers: idem(),
    body: { envelopeId: P.envelopeId },
  }),
  releasesWithdraw: () => ({
    params: { releaseId: P.releaseId },
    headers: idem(),
    body: { reason: 'A demoted administrator withdraws nothing.' },
  }),
  agentsTransfer: () => ({
    params: { agentId: P.agentId },
    body: { toMembershipId: A.ms.it, expectedOwnerMembershipId: AGENT_OWNER },
  }),
  /* Not admin-only, and here on purpose: after the demotion the held cookie must STILL be admitted by these, or
     the case would be proving that the cookie stopped working rather than that the role did. */
  membersList: () => ({ params: { companyId: A.id } }),
  candidatesList: () => ({ params: { companyId: A.id } }),
  releasesList: () => ({ params: { companyId: A.id } }),
  catalogRead: () => ({ params: { companyId: A.id } }),
  me: () => ({}),
};

/** One call, as `user`, with the request `name`'s entry builds. */
const ask = (name, user) => call(name, { user, ...CANDIDATES[name]() });
/** The answer as this file compares answers: the status and the code, which is what "the member's own refusal" is. */
const shape = (answer) => `${answer.status} ${answer.body?.code ?? 'ok'}`;

/* The codes that mean "refused for who you are", as opposed to a state or a visibility refusal. lib/errors.mjs
   maps all three to 403: E_FORBIDDEN is the role, E_ADMIN_MFA_REQUIRED and E_MFA_STEP_UP_REQUIRED are the step-up,
   and a demoted administrator at aal2 meets the first. */
const ROLE_REFUSALS = new Set(['E_FORBIDDEN', 'E_ADMIN_MFA_REQUIRED', 'E_MFA_STEP_UP_REQUIRED']);

/* TWO SETS, AND WHY (measured, not assumed). The set this case sweeps is every route a plain member of the company
   is NOT admitted by, and inside it the ones refused for a ROLE reason are the admin-only ones proper. They are
   not the same set, and the difference is a fact about the product worth stating: `releasesPublish` is admin-only
   and answers a plain member 404 E_NOT_FOUND, because a published candidate's row is not visible to a member at
   all, so the route never reaches the role check. Filtering on the role codes alone would have dropped it from the
   sweep, which is why the sweep is over the wider set and the narrower one is reported beside it. `groupsList`
   goes the other way: a plain member IS admitted, so it is a control and not admin-only, which the first version
   of this pin got wrong (E8T-F4). */
let MEMBER_ANSWERS;
let AUDIENCE_ANSWERS;
let MEMBER_REFUSED;
let ROLE_REFUSED;
let PERMITTED;

test('E8-3 setup: the swept set is derived from a comparable plain member own answers, and the held cookie is an admin before the demotion', async (t) => {
  MEMBER_ANSWERS = new Map();
  AUDIENCE_ANSWERS = new Map();
  await noWrite('E8-3 the member probes', async () => {
    for (const [who, into] of [
      [spareHi, MEMBER_ANSWERS],
      [audienceHi, AUDIENCE_ANSWERS],
    ]) {
      for (const name of Object.keys(CANDIDATES)) {
        alerts.length = 0;
        const answer = await ask(name, who);
        into.set(name, shape(answer));
        assert.deepEqual(alerts, [], `${name}: a member probe raised an alert`);
        assert.ok(answer.status !== 500, `${name}: a member probe answered 500 ${answer.raw}`);
      }
    }
  });
  MEMBER_REFUSED = [...MEMBER_ANSWERS]
    .filter(([, s]) => Number(s.slice(0, 3)) >= 400)
    .map(([name]) => name)
    .sort();
  ROLE_REFUSED = MEMBER_REFUSED.filter((n) => ROLE_REFUSALS.has(MEMBER_ANSWERS.get(n).slice(4))).sort();
  PERMITTED = [...MEMBER_ANSWERS]
    .filter(([, s]) => Number(s.slice(0, 3)) < 300)
    .map(([name]) => name)
    .sort();
  for (const [name, s] of MEMBER_ANSWERS) t.diagnostic(`E8-3 plain member at aal2: ${name} -> ${s}`);
  const disagree = [...MEMBER_ANSWERS].filter(([n, s]) => AUDIENCE_ANSWERS.get(n) !== s).map(([n]) => n);
  for (const n of disagree)
    t.diagnostic(`E8-3 audience member at aal2 differs: ${n} -> ${AUDIENCE_ANSWERS.get(n)}`);

  /* The derived sets, pinned as S11h pins its capability holders: a literal list with the reason it is this list.
     Each of these was reached with a request an administrator of this company would have succeeded with, so the
     refusal is about the caller and not about the request. A route joining or leaving either list is an edit here.
     `companyTakeout` is worth a sentence: design 1.6 says it loads NO principal, so its refusal is the routine's
     own predicate rather than requireAdminPrincipal's, and it is admin-only all the same. */
  assert.deepEqual(MEMBER_REFUSED, [
    'agentsTransfer',
    'companyTakeout',
    'groupMembersAdd',
    'groupMembersRemove',
    'groupsCreate',
    'invitationsCreate',
    'invitationsList',
    'invitationsResend',
    'invitationsRevoke',
    'membersDeparture',
    'membersRemove',
    'membersSetRoles',
    'quotasRead',
    'releasesPublish',
    'releasesWithdraw',
  ]);
  assert.deepEqual(
    MEMBER_REFUSED.filter((n) => !ROLE_REFUSED.includes(n)),
    ['releasesPublish', 'releasesWithdraw'],
    'the two routes refused for visibility rather than for the role: the row is not visible to a plain member outside the audience group, so the route never reaches the role check',
  );
  /* And the second probe's disagreement is exactly the release the audience group makes visible, which is the
     reason the baseline is SPARE_USER and not A.member. */
  assert.deepEqual(
    [...MEMBER_ANSWERS].filter(([n, a]) => AUDIENCE_ANSWERS.get(n) !== a).map(([n]) => n),
    ['releasesWithdraw'],
    'the audience member differs from the plain member on exactly the release-keyed write',
  );
  assert.equal(AUDIENCE_ANSWERS.get('releasesWithdraw'), '403 E_FORBIDDEN');
  assert.deepEqual(PERMITTED, ['candidatesList', 'catalogRead', 'groupsList', 'me', 'membersList', 'releasesList']);
  /* Breadth, said as a number and said exactly. S2b calls two views, `members` and `invitations`, and for its
     DEMOTED account only one of them refuses: a plain member may read the member list, so S2b's `if (answer.status
     === 200) continue` skips it there and the demoted account's refusal is asserted on the invitation read alone.
     Its other refusals belong to its removed-member and outsider classes, which are a different attack. So the
     demotion is covered on ONE of these fifteen routes today, and `invitationsList` is that one. */
  assert.ok(MEMBER_REFUSED.includes('invitationsList'), 'the one route S2b covers for a demotion is in the set');
  assert.ok(PERMITTED.includes('membersList'), "and S2b's other view admits a plain member, which is why it is a control");
  assert.ok(MEMBER_REFUSED.length >= 12, `${MEMBER_REFUSED.length} routes swept, against S2b's two views`);
  assert.equal(ROLE_REFUSED.length, 13, 'thirteen of them are refused for the role itself');

  /* The held cookie is an administrator's, right now, and this read is also what arms the fail-before's cache:
     one request for (this caller, this company) before anything changes. */
  const before = await ask('invitationsList', held);
  assert.equal(before.status, 200, `the held cookie reads the invitation list before the demotion: ${before.raw}`);
  assert.equal(
    sql(`select roles::text from app.memberships where id = '${HELD_MEMBERSHIP}'`),
    '{company_admin,member}',
    'and the row says company_admin',
  );
});

test('E8-3 the demotion writes one audit row and nothing else', async () => {
  const before = snapshot();
  const demotion = await call('membersSetRoles', {
    user: A.adminHi,
    params: { companyId: A.id, membershipId: HELD_MEMBERSHIP },
    body: { roles: ['member'] },
  });
  assert.equal(demotion.status, 200, demotion.raw);
  assert.equal(sql(`select roles::text from app.memberships where id = '${HELD_MEMBERSHIP}'`), '{member}');
  const moved = difference(before, snapshot());
  assert.equal(moved.length, 1, `the demotion moved ${moved.length} counts: ${moved.join(', ')}`);
  const counted = /^app\.audit_events: (\d+) -> (\d+)$/.exec(moved[0]);
  assert.ok(counted, `the one thing that moved is the audit count: ${moved[0]}`);
  assert.equal(Number(counted[2]) - Number(counted[1]), 1, 'exactly one audit row');
});

test('E8-3 the same unchanged cookie meets the member own answer at every route a member is refused by, and writes nothing', async (t) => {
  const answers = [];
  await noWrite('E8-3 the held cookie after the demotion', async () => {
    for (const name of MEMBER_REFUSED) {
      alerts.length = 0;
      const answer = await ask(name, held);
      answers.push(`${name} -> ${shape(answer)}`);
      assert.equal(
        shape(answer),
        MEMBER_ANSWERS.get(name),
        `${name}: the demoted admin held cookie got ${shape(answer)} where a plain member got ${MEMBER_ANSWERS.get(name)}\n  ${answer.raw}`,
      );
      assert.deepEqual(alerts, [], `${name}: a refusal raised an alert`);
    }
  });
  for (const line of answers) t.diagnostic(`E8-3 held cookie after the demotion: ${line}`);
  /* The cookie itself still works, which is what makes the refusals about the role. A demoted administrator is
     still a member, and the routes a member may call answer them exactly as they answer any member. */
  for (const name of PERMITTED) {
    const answer = await ask(name, held);
    assert.equal(
      shape(answer),
      MEMBER_ANSWERS.get(name),
      `${name}: the held cookie is still a member's and got ${shape(answer)}`,
    );
  }
  t.diagnostic(`E8-3 the held cookie is still admitted by ${PERMITTED.join(', ')}`);
  /* And the token has not expired or stopped verifying: E2 design section 6. Its own /api/me still answers. */
  const me = await ask('me', held);
  assert.equal(me.status, 200, `the held token still verifies: ${me.raw}`);
});

test('E8-3 fail-before: a principal cached across requests admits the demoted admin held cookie on routes S2b does not call', async (t) => {
  /* The mutant, named `principal-cached-across-requests`: the first answer for a (caller, company) pair is kept in
     a module-level map and every later request reuses it, which is precisely what
     lib/services/principal.mjs's own header forbids ("loaded once per request and never cached") and what
     lib/http/pipeline.mjs repeats ("No result is cached; the session and the principal live for one request").

     The run needs its own demotion, because the held account above is already a member: MUTANT_USER is A's third
     administrator, its cookie is minted once, it makes ONE admin read through the mutant table to arm the cache,
     and then it is demoted. Only READ routes are driven afterwards, so a mutant that admits writes nothing: the
     fail-before has to show the check failing, not leave rows behind for the next case. */
  const mutant = await mutantRoutes('principal-cached-across-requests', [
    [
      'lib/services/principal.mjs',
      [
        [
          'export async function loadPrincipal(session, companyId, options) {',
          `const E8_CACHE = new Map();
export async function loadPrincipal(session, companyId, options) {
  const e8key = \`\${session?.authUserId}:\${companyId}\`;
  if (E8_CACHE.has(e8key)) return E8_CACHE.get(e8key);
  const e8answer = await e8loadPrincipal(session, companyId, options);
  if (e8answer.ok) E8_CACHE.set(e8key, e8answer);
  return e8answer;
}
async function e8loadPrincipal(session, companyId, options) {`,
        ],
      ],
    ],
  ]);
  const mutantCall = caller(mutant.table, COOKIES, makeRequest);
  const mutantToken = mintUserToken({ sub: MUTANT_USER.id, email: MUTANT_USER.email, aal: 'aal2', ttl: 3600 });
  const mutantHeld = {
    who: 'the mutant held cookie',
    id: MUTANT_USER.id,
    email: MUTANT_USER.email,
    token: () => mutantToken,
  };
  const armed = await mutantCall('invitationsList', { user: mutantHeld, params: { companyId: A.id } });
  assert.equal(armed.status, 200, `the mutant cookie is an admin before the demotion: ${armed.raw}`);

  const demotion = await call('membersSetRoles', {
    user: A.adminHi,
    params: { companyId: A.id, membershipId: MUTANT_MEMBERSHIP },
    body: { roles: ['member'] },
  });
  assert.equal(demotion.status, 200, demotion.raw);
  assert.equal(sql(`select roles::text from app.memberships where id = '${MUTANT_MEMBERSHIP}'`), '{member}');

  /* The real table refuses it, as the case above already showed for the other account. */
  const real = await call('invitationsList', { user: mutantHeld, params: { companyId: A.id } });
  assert.equal(shape(real), MEMBER_ANSWERS.get('invitationsList'), 'the real code refuses the demoted cookie');

  /* The mutant does not, and the intended check is the comparison with the member's answer. Read-only routes only. */
  const readOnly = ROLE_REFUSED.filter((n) => routes[n].route.method === 'GET');
  const admitted = [];
  for (const name of readOnly) {
    const answer = await mutantCall(name, { user: mutantHeld, ...CANDIDATES[name]() });
    admitted.push(`${name} -> ${shape(answer)}`);
  }
  t.diagnostic(`E8-3 mutant answers on the admin-only reads: ${admitted.join(', ')}`);
  const failure = await caughtAsync('E8-3 the held-cookie comparison', async () => {
    for (const name of readOnly) {
      const answer = await mutantCall(name, { user: mutantHeld, ...CANDIDATES[name]() });
      assert.equal(
        shape(answer),
        MEMBER_ANSWERS.get(name),
        `${name}: the demoted admin held cookie got ${shape(answer)} where a plain member got ${MEMBER_ANSWERS.get(name)}`,
      );
    }
  });
  assert.ok(failure instanceof assert.AssertionError, `the intended check must fail on the mutant, not ${failure}`);
  assert.match(failure.message, /where a plain member got 403 E_FORBIDDEN/);
  t.diagnostic(`E8-3 fail-before at the intended check: ${failure.message.split('\n')[0]}`);
  /* And the routes S2b covers are not the only ones it reaches, which is the breadth half of the same statement. */
  assert.ok(
    readOnly.some((n) => n !== 'invitationsList'),
    `the mutant was reached on a route S2b does not call: ${readOnly.join(', ')}`,
  );
});
