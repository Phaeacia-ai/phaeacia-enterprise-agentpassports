/* E8-1 and E8-2 (docs/e8/design.md 2.1, 2.3 rows E8-1 and E8-2, 2.4), against the running local stack.

   E8-1, THE WHOLE-SURFACE TENANCY SWEEP. The 58 routes `makeRoutes()` declares, split by a declared exclusion
   table with a reason per route, because 16 of the 58 carry no company-bearing id (E8D-R-F6; the sixteenth is the
   alerts design's mail event route, slice 1, which takes no session and no id). The 42 that do are
   called by wrong-company callers, for reads and writes, and must answer the same refusal and write nothing. The
   route list is READ from lib/http/routes.mjs and never copied, and the completeness assertion is over
   `declared minus excluded`, so a route added tomorrow either joins the swept table, or joins the exclusion table
   with a reason, or fails this file (design 7.3 scenario 1). The shape of that assertion is S11h's in
   tests/e2/stack/pages-bound.test.mjs: a derived set compared with a pinned literal, with a comment saying who
   joined and why, so the set changing is a visible edit and not a silent one.

   THE ANSWER IS NOT ONE ANSWER, AND THE DESIGN SAID IT WAS. Design 2.3 row E8-1 gives class (a) one result, "404
   E_NOT_FOUND", for all four wrong-company caller classes. Eight of the 42 are operator routes that carry a
   `:companyId` (`operatorCompanyStatus` and its seven siblings), and lib/services/operator.mjs decides them with
   `app.operator_actor()` and loads no membership at all: a member, an admin or a reviewer of another company meets
   403 E_NOT_OPERATOR there, not 404, and the operator caller class is not a wrong-company caller for them at all,
   because an operator is global and every company is theirs. The swept table therefore carries a CLASS per route,
   `tenant` (34 routes) or `operator-company` (8), and section 5 of evidence/e8-tenancy.md states the arithmetic.
   This is E8T-F1 and it is a deviation from the design, entered in docs/e8/design.md's day-2 amendment block.

   WHY EVERY CALL CARRIES A WELL-FORMED BODY, KEY AND If-Match. The pipeline's order (lib/http/pipeline.mjs) puts
   the body at step 6, before the route function, and several services validate their own inputs before they load
   the caller's standing: `idempotencyKeyOf` and `expectedVersionOf` in lib/services/candidates.mjs, `submissionOf`,
   `envelopeRequestOf` in lib/services/reviews.mjs, `objectWithKeys` in lib/services/installations.mjs, the shape
   checks in lib/services/operator.mjs. A sweep that sent `{}` everywhere would collect 422s and would prove
   nothing about tenancy. Each entry below therefore states the request an ENTITLED caller would have sent, and the
   only thing wrong with it is who is sending it (E8-1) or which id it names (E8-2).

   E8-2, THE GUESSED IDS. The same 42 routes, called by a caller of company A who IS entitled, with the route's own
   ids replaced. Design 2.3 row E8-2 names three classes: a uuid of an existing object of another class, a uuid
   that exists nowhere, and a uuid of an object of a company that has since been deleted through the operator's one
   door. A FOURTH is added here, `foreign-company`: a well-formed id of an object that exists, in a company the
   caller is not in. Reason: the design's three all resolve to nothing for everybody, so they cannot separate an
   oracle from an honest refusal, and the row's own fail-before is stated in terms of the fourth ("403 for an
   existing foreign object and 404 for a nonexistent one"). Every class must answer the same status and the same
   body bytes. The fourth class is undefined for the eight operator-company routes, whose entitled caller is the
   operator, for whom no company is foreign, and it is skipped there with that reason.

   FAIL-BEFORE, one per case, each shown failing at the intended check and recorded under
   evidence/e8-tenancy-repro/:
     - E8-1's completeness: a route dropped from both tables (in-test, `completeness()` called on a short list);
     - E8-1's wrong-company arm: `lib/services/principal.mjs` mutated so that a caller whose membership is not in
       the path's company falls back to their own membership, which is the principal confusion case 43's mutant
       named and the one design 4.1's unentitled load half exists to catch;
     - E8-2: one route mutated to answer 403 when the object exists in another company and 404 when it exists
       nowhere, which is the oracle;
     - E8-9's helper: `writeOneAuditRow()` inside `noWrite()`.
   A mutant is a COPY of lib/ under .scratch/, never an edit of lib/: this lane owns no file under lib/.

   THE STACK. This file reseeds once through tests/db/00-seed.sh and builds its own users and companies. Run alone:
   node --test --test-concurrency=1 tests/e8/stack/ */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { caller, passport } from '../../e3/stack/helpers.mjs';
import { SUBMISSION } from '../../e3/unit/submission-shapes.mjs';
import {
  activePolicyId,
  e4world,
  enableTargets,
  e6routes,
  freshEmail,
  operators,
  periodBody,
  published,
  reseed,
  reviewCompany,
  setStatus,
  sql,
} from '../../e6/stack/helpers.mjs';
import {
  caught,
  caughtAsync,
  mutantRoutes,
  ownerCount,
  ownerCountSource,
  removeMutants,
} from '../helpers/mutant-lib.mjs';
import { deleteAuditRow, difference, noWrite, snapshot, writeOneAuditRow } from '../helpers/no-write.mjs';

after(() => removeMutants());

const ids = reseed();
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');

/* The sweep's own route table, with BOTH seams wired: deps.log for the stderr line and deps.alert for the
   content-free alert. Design 2.3 row E8-1's result includes "no alert", and the only way to observe that is the
   seam the pipeline reads (E7 design 1.5). A refusal raises nothing; `internal` and `mail_not_configured` do. */
const logged = [];
const alerts = [];
const routes = makeRoutes({ log: (entry) => logged.push(entry), alert: (event, fields) => alerts.push({ event, fields }) });
const call = caller(routes, COOKIES, makeRequest);
/* A second table for the world's construction, so the sweep's capture arrays hold only the sweep's own calls. */
const R = await e6routes([]);
const W = e4world('e8t', ids);
const OP = operators(ids);

/* Handover is the invitation delivery default and this file asserts it rather than assuming it (E8T-F2):
   `requireDelivery` runs BEFORE `requireAdminPrincipal` in lib/services/invitations.mjs, so in `mail` mode with no
   transport the four invitation paths answer 503 E_MAIL_NOT_CONFIGURED before the tenancy refusal. That writes
   nothing and discloses no tenant, but it is a different answer, so the sweep's contract is stated for the mode it
   runs in. */
assert.ok(
  process.env.ENTERPRISE_INVITATION_DELIVERY === undefined || process.env.ENTERPRISE_INVITATION_DELIVERY === '',
  'the sweep runs in handover mode; see E8T-F2 for what mail mode changes',
);

/* ---------------------------------------------------------------------------------------------------
   The world: company A holds every object the sweep names, company B is where the wrong-company callers
   live, and company C is built, filled and then deleted so that E8-2's third id class exists.
   --------------------------------------------------------------------------------------------------- */

/* Every target publishable, owner-side under the registry bypass, as every E4 and E5 stack file does before it
   publishes (tests/e4/stack/helpers.mjs `enableTargets`). Without it a publish answers E_TARGET_NOT_PUBLISHABLE. */
enableTargets();

const A = await reviewCompany(W, R, 'victim');
const B = await reviewCompany(W, R, 'attacker');
const PUBLISHED = await published(R, A, 'claude-ai');
/** One setup call that must have succeeded, with the answer in the message when it did not. */
function built(label, answer, ...statuses) {
  assert.ok(statuses.includes(answer.status), `${label}: ${answer.status} ${answer.raw}`);
  return answer.body;
}
const DRAFT = built('A draft', await R.create(A.author, A.id, { name: `e8t-draft-${W.run}`, bytes: passport('draft') }), 201);
/* A report needs the block first: lib/services/installations.mjs answers E_NOT_DOWNLOADED otherwise, which is
   design 1.4's own order and not something to work around. */
built('A download', await R.download(A.member, PUBLISHED.releaseId), 200, 201);
const REPORT = built('A report', await R.report(A.member, PUBLISHED.releaseId, { status: 'pass' }), 201).report;
const INVITATION = built(
  'A pending invitation',
  await R.invite(A.adminHi, A.id, { email: freshEmail('victim-pending'), roles: ['member'] }),
  201,
);

/* Company B holds one object of every id class too, so that E8-2 can ask its fourth question: a well-formed id of
   an object that EXISTS, in a company the caller is not in. The three classes design 2.3 row E8-2 names are all
   ids that resolve to nothing for anybody, and none of them can tell an oracle from a correct refusal, because a
   404 for a row nobody has is the same 404 either way. This class is the one that can, and it is also the input
   the row's own fail-before needs ("403 for an existing foreign object and 404 for a nonexistent one"). Added as a
   deviation, D2-A3 in docs/e8/design.md's day-2 amendment block. */
const B_PUBLISHED = await published(R, B, 'claude-ai');
const B_DRAFT = built('B draft', await R.create(B.author, B.id, { name: `e8t-bdraft-${W.run}`, bytes: passport('bdraft') }), 201);
built('B download', await R.download(B.member, B_PUBLISHED.releaseId), 200, 201);
const B_REPORT = built('B report', await R.report(B.member, B_PUBLISHED.releaseId, { status: 'pass' }), 201).report;
const B_INVITATION = built(
  'B pending invitation',
  await R.invite(B.adminHi, B.id, { email: freshEmail('attacker-pending'), roles: ['member'] }),
  201,
);
const FOREIGN = {
  companyId: B.id,
  membershipId: B.ms.member,
  invitationId: B_INVITATION.invitationId,
  groupId: B.groupId,
  candidateId: B_DRAFT.candidateId,
  releaseId: B_PUBLISHED.releaseId,
  reportId: B_REPORT.reportId,
  agentId: B_PUBLISHED.agentId,
};

/* Company C, filled and then deleted through the operator's one door (design 1.6): suspend, close on a recorded
   instruction, delete on a recorded instruction. Its ids are then ids of objects of a company that no longer
   exists, which is E8-2's third class. Its audit rows are gone with it and the deletion's own row carries a null
   company_id, which is what makes the class worth asking about at all. */
const C = await reviewCompany(W, R, 'deleted');
const C_PUBLISHED = await published(R, C, 'claude-ai');
const C_DRAFT = built('C draft', await R.create(C.author, C.id, { name: `e8t-cdraft-${W.run}`, bytes: passport('cdraft') }), 201);
built('C download', await R.download(C.member, C_PUBLISHED.releaseId), 200, 201);
const C_REPORT = built('C report', await R.report(C.member, C_PUBLISHED.releaseId, { status: 'pass' }), 201).report;
const C_INVITATION = built(
  'C pending invitation',
  await R.invite(C.adminHi, C.id, { email: freshEmail('deleted-pending'), roles: ['member'] }),
  201,
);
const C_SLUG = sql(`select slug from app.companies where id = '${C.id}'`);
const GONE = {
  companyId: C.id,
  membershipId: C.ms.member,
  invitationId: C_INVITATION.invitationId,
  groupId: C.groupId,
  candidateId: C_DRAFT.candidateId,
  releaseId: C_PUBLISHED.releaseId,
  reportId: C_REPORT.reportId,
  agentId: C_PUBLISHED.agentId,
};
{
  setStatus(C.id, 'suspended');
  const closed = await R.companyClose(OP.aal2, C.id, { confirmSlug: C_SLUG, reasonCode: 'customer_instruction' });
  assert.equal(closed.status, 200, `company C closed: ${closed.raw}`);
  const deleted = await R.companyDelete(OP.aal2, C.id, { confirmSlug: C_SLUG, reasonCode: 'customer_instruction' });
  assert.equal(deleted.status, 200, `company C deleted: ${deleted.raw}`);
  assert.equal(sql(`select count(*) from app.companies where id = '${C.id}'`), '0', 'company C is gone');
}

/* ---------------------------------------------------------------------------------------------------
   The declared exclusion table (design 2.3 row E8-1 classes b and c), sixteen routes, a reason each
   --------------------------------------------------------------------------------------------------- */

/* `also403` marks class (b): three operator-only routes with no company id. The wrong-company arm is undefined for
   them, because there is no company in the path to be wrong about, and it is excluded; the 403 arm is NOT, and
   every non-operator caller must meet it. Design 2.3 row E8-1: "the 403 arm is not". */
const EXCLUDED = Object.freeze({
  authStart: { why: 'authentication: no session and no company; the subject is an address the answer never confirms' },
  authVerify: { why: 'authentication: exchanges a token hash for cookies; no company in the path or the body' },
  authRefresh: { why: 'authentication: the refresh cookie is the whole subject' },
  authSignout: { why: 'authentication: clears the caller own cookies; session optional by design' },
  factorsList: { why: 'self: the caller own second factors, keyed by their session and by nothing else' },
  factorsEnroll: { why: 'self: enrols a factor on the caller own account' },
  factorsVerify: { why: 'self: the factorId is the caller own factor; GoTrue refuses another account factor' },
  factorsRemove: { why: 'self: the factorId is the caller own factor' },
  me: { why: 'self: the caller own memberships across every company; there is no one company to be wrong about' },
  meDisplayName: { why: 'self: writes the caller own profile row, which no company scopes' },
  gateRead: { why: 'self: the build own gate identity, the same answer for every caller' },
  invitationsAccept: {
    why: 'self and authentication: the invite code IS the authorization, and the company it names is the code own; a wrong-company arm would be a wrong-code arm, which tests/db/04-invitations.sh already sweeps',
  },
  operatorCompanyCreate: {
    why: 'operator-only, no company id: it creates one. The wrong-company arm is undefined; the 403 arm is kept',
    also403: true,
  },
  operatorRegister: {
    why: 'operator-only, no company id: the register is every company. The wrong-company arm is undefined; the 403 arm is kept',
    also403: true,
  },
  operatorExpiryRun: {
    why: 'operator-only, no company id: the sweep is over every company. The wrong-company arm is undefined; the 403 arm is kept',
    also403: true,
  },
  /* The alerts design 1.4 and section 7 (slice 1): joined 2026-09-21 by the slice 1 build lane. */
  mailEvents: {
    why: 'the mail provider only: no session, no company-bearing id, authenticated by the signature over the raw body; a company id arrives only inside a verified event tag and reaches nothing but the operator alert',
  },
});

/* ---------------------------------------------------------------------------------------------------
   The swept table: the 42 routes that carry a company-bearing id
   --------------------------------------------------------------------------------------------------- */

const TENANT = 'tenant';
const OPERATOR_COMPANY = 'operator-company';
const idem = () => ({ 'idempotency-key': randomUUID() });

/**
 * One entry per swept route:
 *   cls        `tenant` (404 E_NOT_FOUND for every wrong-company caller) or `operator-company`
 *              (403 E_NOT_OPERATOR for every non-operator caller; the operator arm is undefined)
 *   ids        the id parameters, as names resolved against a world: which of A's or a guessed object's ids
 *   request(w) params, body and headers a caller entitled to `w` would have sent
 *   entitled   who E8-2 calls it as: the principal whose standing is NOT the thing wrong with the call
 *   writes     true for a route whose success would write, which is what E8-9's counts are about here
 */
const SWEPT = {
  /* --- E2 and the pages surface --- */
  invitationsCreate: {
    cls: TENANT,
    ids: ['companyId'],
    writes: true,
    request: (w) => ({ params: { companyId: w.companyId }, body: { email: freshEmail('sweep'), roles: ['member'] } }),
    entitled: () => A.adminHi,
  },
  invitationsRevoke: {
    cls: TENANT,
    ids: ['companyId', 'invitationId'],
    writes: true,
    request: (w) => ({ params: { companyId: w.companyId, invitationId: w.invitationId } }),
    entitled: () => A.adminHi,
  },
  invitationsResend: {
    cls: TENANT,
    ids: ['companyId', 'invitationId'],
    writes: true,
    request: (w) => ({ params: { companyId: w.companyId, invitationId: w.invitationId } }),
    entitled: () => A.adminHi,
  },
  invitationsList: {
    cls: TENANT,
    ids: ['companyId'],
    request: (w) => ({ params: { companyId: w.companyId } }),
    entitled: () => A.adminHi,
  },
  membersList: {
    cls: TENANT,
    ids: ['companyId'],
    request: (w) => ({ params: { companyId: w.companyId } }),
    entitled: () => A.member,
  },
  membersSetRoles: {
    cls: TENANT,
    ids: ['companyId', 'membershipId'],
    writes: true,
    request: (w) => ({
      params: { companyId: w.companyId, membershipId: w.membershipId },
      body: { roles: ['member'] },
    }),
    entitled: () => A.adminHi,
  },
  membersRemove: {
    cls: TENANT,
    ids: ['companyId', 'membershipId'],
    writes: true,
    request: (w) => ({ params: { companyId: w.companyId, membershipId: w.membershipId } }),
    entitled: () => A.adminHi,
  },
  membersDeparture: {
    cls: TENANT,
    ids: ['companyId', 'membershipId'],
    request: (w) => ({ params: { companyId: w.companyId, membershipId: w.membershipId } }),
    entitled: () => A.adminHi,
  },
  quotasRead: {
    cls: TENANT,
    ids: ['companyId'],
    request: (w) => ({ params: { companyId: w.companyId } }),
    entitled: () => A.adminHi,
  },
  companyTakeout: {
    cls: TENANT,
    ids: ['companyId'],
    request: (w) => ({ params: { companyId: w.companyId } }),
    entitled: () => A.adminHi,
  },
  /* --- E3, the passport surface --- */
  candidatesCreate: {
    cls: TENANT,
    ids: ['companyId'],
    writes: true,
    request: (w) => ({
      params: { companyId: w.companyId },
      headers: { ...idem(), 'x-agent-name': `sweep-${randomUUID().slice(0, 8)}` },
      body: passport('sweep'),
    }),
    entitled: () => A.author,
  },
  candidatesList: {
    cls: TENANT,
    ids: ['companyId'],
    request: (w) => ({ params: { companyId: w.companyId } }),
    entitled: () => A.author,
  },
  candidatesSave: {
    cls: TENANT,
    ids: ['candidateId'],
    writes: true,
    request: (w) => ({
      params: { candidateId: w.candidateId },
      headers: { ...idem(), 'if-match': '1' },
      body: passport('sweep-save'),
    }),
    entitled: () => A.author,
  },
  candidatesSubmit: {
    cls: TENANT,
    ids: ['candidateId'],
    writes: true,
    request: (w) => ({
      params: { candidateId: w.candidateId },
      headers: { ...idem(), 'if-match': '1' },
      body: { ...SUBMISSION },
    }),
    entitled: () => A.author,
  },
  candidatesSuccessor: {
    cls: TENANT,
    ids: ['candidateId'],
    writes: true,
    request: (w) => ({ params: { candidateId: w.candidateId }, headers: idem(), body: {} }),
    entitled: () => A.author,
  },
  candidatesRead: {
    cls: TENANT,
    ids: ['candidateId'],
    request: (w) => ({ params: { candidateId: w.candidateId } }),
    entitled: () => A.author,
  },
  /* --- E4, review and release --- */
  reviewQueue: {
    cls: TENANT,
    ids: ['companyId'],
    request: (w) => ({ params: { companyId: w.companyId } }),
    entitled: () => A.it,
  },
  reviewRead: {
    cls: TENANT,
    ids: ['candidateId'],
    request: (w) => ({ params: { candidateId: w.candidateId } }),
    entitled: () => A.it,
  },
  envelopesCreate: {
    cls: TENANT,
    ids: ['candidateId'],
    writes: true,
    request: (w) => ({
      params: { candidateId: w.candidateId },
      headers: idem(),
      body: { target: 'claude-ai', audienceGroupIds: [A.groupId], policyId: activePolicyId() },
    }),
    entitled: () => A.author,
  },
  reviewsCreate: {
    cls: TENANT,
    ids: ['candidateId'],
    writes: true,
    request: (w) => ({
      params: { candidateId: w.candidateId },
      headers: idem(),
      body: {
        envelopeId: PUBLISHED.envelopeId,
        role: 'it',
        decision: 'approved',
        reason: 'The sweep never reaches a decision.',
      },
    }),
    entitled: () => A.it,
  },
  releasesPublish: {
    cls: TENANT,
    ids: ['candidateId'],
    writes: true,
    request: (w) => ({
      params: { candidateId: w.candidateId },
      headers: idem(),
      body: { envelopeId: PUBLISHED.envelopeId },
    }),
    entitled: () => A.adminHi,
  },
  releasesWithdraw: {
    cls: TENANT,
    ids: ['releaseId'],
    writes: true,
    request: (w) => ({
      params: { releaseId: w.releaseId },
      headers: idem(),
      body: { reason: 'The sweep never withdraws anything.' },
    }),
    entitled: () => A.adminHi,
  },
  releasesRead: {
    cls: TENANT,
    ids: ['releaseId'],
    request: (w) => ({ params: { releaseId: w.releaseId } }),
    entitled: () => A.member,
  },
  releasesList: {
    cls: TENANT,
    ids: ['companyId'],
    request: (w) => ({ params: { companyId: w.companyId } }),
    entitled: () => A.member,
  },
  groupsList: {
    cls: TENANT,
    ids: ['companyId'],
    request: (w) => ({ params: { companyId: w.companyId } }),
    entitled: () => A.adminHi,
  },
  groupsCreate: {
    cls: TENANT,
    ids: ['companyId'],
    writes: true,
    request: (w) => ({ params: { companyId: w.companyId }, body: { name: `Sweep ${randomUUID().slice(0, 8)}` } }),
    entitled: () => A.adminHi,
  },
  groupMembersAdd: {
    cls: TENANT,
    ids: ['companyId', 'groupId', 'membershipId'],
    writes: true,
    request: (w) => ({ params: { companyId: w.companyId, groupId: w.groupId, membershipId: w.membershipId } }),
    entitled: () => A.adminHi,
  },
  groupMembersRemove: {
    cls: TENANT,
    ids: ['companyId', 'groupId', 'membershipId'],
    writes: true,
    request: (w) => ({ params: { companyId: w.companyId, groupId: w.groupId, membershipId: w.membershipId } }),
    entitled: () => A.adminHi,
  },
  agentsTransfer: {
    cls: TENANT,
    ids: ['agentId'],
    writes: true,
    request: (w) => ({
      params: { agentId: w.agentId },
      body: { toMembershipId: A.ms.it, expectedOwnerMembershipId: A.ms.author },
    }),
    entitled: () => A.adminHi,
  },
  /* --- E5, catalogue, download and installation --- */
  catalogRead: {
    cls: TENANT,
    ids: ['companyId'],
    request: (w) => ({ params: { companyId: w.companyId } }),
    entitled: () => A.member,
  },
  releasesDownload: {
    cls: TENANT,
    ids: ['releaseId'],
    writes: true,
    request: (w) => ({ params: { releaseId: w.releaseId } }),
    entitled: () => A.member,
  },
  installationsList: {
    cls: TENANT,
    ids: ['releaseId'],
    request: (w) => ({ params: { releaseId: w.releaseId } }),
    entitled: () => A.member,
  },
  installationsCreate: {
    cls: TENANT,
    ids: ['releaseId'],
    writes: true,
    request: (w) => ({ params: { releaseId: w.releaseId }, headers: idem(), body: { status: 'pass' } }),
    entitled: () => A.member,
  },
  installationsWitness: {
    cls: TENANT,
    ids: ['reportId'],
    writes: true,
    request: (w) => ({
      params: { reportId: w.reportId },
      headers: idem(),
      body: { status: 'pass', note: 'The sweep witnesses nothing.' },
    }),
    entitled: () => A.it,
  },
  /* --- E6, the operator surface that carries a company id --- */
  operatorTransferAdmin: {
    cls: OPERATOR_COMPANY,
    ids: ['companyId'],
    writes: true,
    request: (w) => ({ params: { companyId: w.companyId }, body: { userId: ids.U_alpha_admin2 } }),
    entitled: () => OP.aal2,
  },
  operatorTakeoutManifest: {
    cls: OPERATOR_COMPANY,
    ids: ['companyId'],
    request: (w) => ({ params: { companyId: w.companyId } }),
    entitled: () => OP.aal2,
  },
  operatorCompanyStatus: {
    cls: OPERATOR_COMPANY,
    ids: ['companyId'],
    writes: true,
    request: (w) => ({
      params: { companyId: w.companyId },
      body: { status: 'suspended', reasonCode: 'customer_request' },
    }),
    entitled: () => OP.aal2,
  },
  operatorAccessPeriod: {
    cls: OPERATOR_COMPANY,
    ids: ['companyId'],
    writes: true,
    request: (w) => ({ params: { companyId: w.companyId }, body: periodBody() }),
    entitled: () => OP.aal2,
  },
  operatorCompanyQuota: {
    cls: OPERATOR_COMPANY,
    ids: ['companyId'],
    writes: true,
    request: (w) => ({
      params: { companyId: w.companyId },
      body: { name: 'members_per_company', value: 41 },
    }),
    entitled: () => OP.aal2,
  },
  operatorAdminInvitation: {
    cls: OPERATOR_COMPANY,
    ids: ['companyId'],
    writes: true,
    request: (w) => ({ params: { companyId: w.companyId }, body: { email: freshEmail('sweep-admin') } }),
    entitled: () => OP.aal2,
  },
  /* The two doors. The confirmation slug is DELIBERATELY one no company has, so that even a mutant that admitted
     the caller could not close or delete anything: the typed confirmation is compared in the routine (design 3.5
     rows 16 and 17). That is a second guard on the sweep and not a weakening of it, because the refusal under test
     is reached before the comparison. */
  operatorCompanyClose: {
    cls: OPERATOR_COMPANY,
    ids: ['companyId'],
    writes: true,
    request: (w) => ({
      params: { companyId: w.companyId },
      body: { confirmSlug: 'no-company-has-this-slug', reasonCode: 'customer_instruction' },
    }),
    entitled: () => OP.aal2,
  },
  operatorCompanyDelete: {
    cls: OPERATOR_COMPANY,
    ids: ['companyId'],
    writes: true,
    request: (w) => ({
      params: { companyId: w.companyId },
      body: { confirmSlug: 'no-company-has-this-slug', reasonCode: 'customer_instruction' },
    }),
    entitled: () => OP.aal2,
  },
};

/* A's own ids, which is what an entitled caller would have named. */
const VICTIM = {
  companyId: A.id,
  membershipId: A.ms.member,
  invitationId: INVITATION.invitationId,
  groupId: A.groupId,
  candidateId: DRAFT.candidateId,
  releaseId: PUBLISHED.releaseId,
  reportId: REPORT.reportId,
  agentId: PUBLISHED.agentId,
};

/* The four wrong-company caller classes of design 2.3 row E8-1. Every one of them holds a valid session; what is
   wrong is which company they are in. The reviewer and the admin are at aal2 so that a step-up refusal can never
   be mistaken for the tenancy refusal, and the member is at aal1 because that is the ordinary case. */
const WRONG_COMPANY = [
  ['member of another company (aal1)', B.member],
  ['admin of another company (aal2)', B.adminHi],
  ['it_reviewer of another company (aal2)', W.aal2(B.it)],
  ['operator (aal2)', OP.aal2],
];
const NOT_OPERATOR = WRONG_COMPANY.filter(([label]) => !label.startsWith('operator'));

/* ---------------------------------------------------------------------------------------------------
   The completeness assertion, in S11h's shape
   --------------------------------------------------------------------------------------------------- */

/**
 * completeness(declared) -> the swept set the declaration list implies.
 * Exported shape so the fail-before can call it on a declaration list with one route removed from both tables.
 * Throws when a declared route is in neither table, when a table names a route that is not declared, or when the
 * two tables overlap.
 */
function completeness(declared) {
  const excluded = Object.keys(EXCLUDED);
  const swept = Object.keys(SWEPT);
  const both = swept.filter((n) => excluded.includes(n));
  assert.deepEqual(both, [], 'a route is in the swept table and in the exclusion table');
  for (const name of [...swept, ...excluded])
    assert.ok(declared.includes(name), `${name} is in a table and is not declared by makeRoutes()`);
  const unclassified = declared.filter((n) => !swept.includes(n) && !excluded.includes(n));
  assert.deepEqual(
    unclassified,
    [],
    'every declared route joins the sweep or the exclusion table with a reason; these joined neither',
  );
  return declared.filter((n) => !excluded.includes(n)).sort();
}

test('E8-1 completeness: declared minus excluded is exactly the swept set, and a route in neither table fails', () => {
  const declared = Object.keys(routes).sort();
  /* 58 on this revision (57 until the alerts design's mail event route). The number is asserted so that a route
     added without a table entry is a failure here and not a silently shorter sweep; the exclusion table is what a new
     route is added to (design 7.3 scenario 1). */
  assert.equal(declared.length, 58, 'the declared route count');
  assert.equal(Object.keys(EXCLUDED).length, 16, 'sixteen routes carry no company-bearing id');
  assert.deepEqual(completeness(declared), Object.keys(SWEPT).sort(), 'declared minus excluded = swept');
  assert.equal(Object.keys(SWEPT).length, 42, 'the sweep is defined on 42 routes');

  /* The class partition, pinned as S11h pins its capability holders: a literal list with the reason it is this
     list. E8T-F1: the design gave all 42 one answer; the eight operator routes that carry a company id answer a
     non-operator 403 E_NOT_OPERATOR, because lib/services/operator.mjs loads no membership and decides with
     app.operator_actor(). A route that moves between the classes is an edit of this list. */
  const byClass = (cls) =>
    Object.entries(SWEPT)
      .filter(([, e]) => e.cls === cls)
      .map(([n]) => n)
      .sort();
  assert.deepEqual(byClass(OPERATOR_COMPANY), [
    'operatorAccessPeriod',
    'operatorAdminInvitation',
    'operatorCompanyClose',
    'operatorCompanyDelete',
    'operatorCompanyQuota',
    'operatorCompanyStatus',
    'operatorTakeoutManifest',
    'operatorTransferAdmin',
  ]);
  assert.equal(byClass(TENANT).length, 34, '34 tenant routes and 8 operator-company routes make the 42');

  /* Every exclusion carries a reason a person wrote, and exactly three keep the 403 arm (design 2.3 class b). */
  for (const [name, entry] of Object.entries(EXCLUDED))
    assert.ok(entry.why.length > 40, `${name}: the exclusion reason is a sentence and not a word`);
  assert.deepEqual(
    Object.entries(EXCLUDED)
      .filter(([, e]) => e.also403)
      .map(([n]) => n)
      .sort(),
    ['operatorCompanyCreate', 'operatorExpiryRun', 'operatorRegister'],
  );

  /* Every swept route takes at least one id, which is what "company-bearing" means, and every id it names is a
     parameter of its declared path. */
  for (const [name, entry] of Object.entries(SWEPT)) {
    assert.ok(entry.ids.length >= 1, `${name}: a swept route carries at least one id`);
    for (const id of entry.ids)
      assert.ok(routes[name].route.path.includes(`:${id}`), `${name}: :${id} is not in ${routes[name].route.path}`);
  }
});

test('E8-1 completeness fail-before: a route dropped from both tables fails the assertion (mutant declared-minus-one)', (t) => {
  /* The mutant is the declaration list with one route removed from the tables' reach: `companyTakeout` is in the
     swept table, so a declaration list that still declares it while the tables do not classify it is exactly the
     "a route added tomorrow joins no sweep" case. It is built by asking completeness() about a list that contains
     a route name no table holds. */
  const withNewRoute = [...Object.keys(routes), 'somethingAddedTomorrow'].sort();
  const failure = caught('E8-1 completeness', () => completeness(withNewRoute));
  assert.ok(failure instanceof assert.AssertionError, `an assertion failure, not ${failure?.name}`);
  assert.match(failure.message, /joined neither/);
  assert.match(failure.message, /somethingAddedTomorrow/);
  t.diagnostic(`E8-1 completeness mutant: ${failure.message.split('\n')[0]}`);
});

/* ---------------------------------------------------------------------------------------------------
   E8-1: the wrong-company arm
   --------------------------------------------------------------------------------------------------- */

/** The answer the class expects: the status, the code, and the label the failure message carries. */
function expected(cls) {
  return cls === TENANT ? { status: 404, code: 'E_NOT_FOUND' } : { status: 403, code: 'E_NOT_OPERATOR' };
}

/** One route called by every wrong-company caller its class defines, with the answers it gave. */
async function sweepRoute(name, entry, table = routes, calls = call) {
  const want = expected(entry.cls);
  const callers = entry.cls === TENANT ? WRONG_COMPANY : NOT_OPERATOR;
  const answers = [];
  for (const [label, user] of callers) {
    const { params = {}, body, headers = {} } = entry.request(VICTIM);
    const answer = await calls(name, { user, params, headers, body });
    answers.push({ label, status: answer.status, code: answer.body?.code ?? null, raw: answer.raw });
    assert.equal(
      answer.status,
      want.status,
      `${name} (${entry.cls}) called by a ${label}: ${answer.status} ${answer.raw}`,
    );
    assert.equal(answer.body?.code, want.code, `${name} called by a ${label}: the code`);
  }
  assert.ok(table[name], `${name} is a declared route`);
  return answers;
}

test('E8-1 the 42 swept routes refuse every wrong-company caller, write nothing and raise no alert', async (t) => {
  const started = snapshot();
  let previous = started;
  const shape = [];
  await noWrite('E8-1 the whole sweep', async () => {
    for (const [name, entry] of Object.entries(SWEPT)) {
      alerts.length = 0;
      const answers = await sweepRoute(name, entry);
      /* Per-route attribution: the chain reuses each route's "after" as the next route's "before", so a write is
         named with the route that made it rather than with the sweep. */
      const after = snapshot();
      assert.deepEqual(difference(previous, after), [], `${name}: a refused call wrote something`);
      previous = after;
      assert.deepEqual(alerts, [], `${name}: a refusal raised an alert`);
      /* Every caller of one route met the same bytes, so the answer does not say which caller it was. */
      const distinct = new Set(answers.map((a) => a.raw));
      assert.equal(distinct.size, 1, `${name}: the callers got different bodies: ${[...distinct].join(' | ')}`);
      shape.push(`${name} ${entry.cls} ${answers[0].status} ${answers[0].code} x${answers.length}`);
    }
  });
  assert.deepEqual(difference(started, snapshot()), [], 'the sweep as a whole wrote nothing');
  const calls = Object.values(SWEPT).reduce((n, e) => n + (e.cls === TENANT ? 4 : 3), 0);
  t.diagnostic(`E8-1: ${Object.keys(SWEPT).length} routes, ${calls} refused calls`);
  for (const line of shape) t.diagnostic(`E8-1 ${line}`);
});

test('E8-1 class b: the three operator-only routes with no company id refuse every non-operator caller with 403', async () => {
  await noWrite('E8-1 class b', async () => {
    for (const [name, entry] of Object.entries(EXCLUDED)) {
      if (!entry.also403) continue;
      for (const [label, user] of NOT_OPERATOR) {
        alerts.length = 0;
        /* The body a well-formed call would carry, for the same reason the swept table carries one: the service's
           own shape checks run before app.operator_actor(), so `{}` on operatorCompanyCreate answers 422
           E_BODY_INVALID and the 403 arm would never be reached. */
        const body =
          name === 'operatorCompanyCreate'
            ? {
                slug: `e8t-never-${W.run}`,
                name: 'SYNTHETIC Never AG',
                firstAdminEmail: freshEmail('never'),
                ...periodBody(),
              }
            : name === 'operatorExpiryRun'
              ? { limit: 1 }
              : undefined;
        const answer = await call(name, { user, body });
        assert.equal(answer.status, 403, `${name} called by a ${label}: ${answer.status} ${answer.raw}`);
        assert.equal(answer.body?.code, 'E_NOT_OPERATOR', `${name} called by a ${label}: the code`);
        assert.deepEqual(alerts, [], `${name}: a refusal raised an alert`);
      }
    }
  });
});

test('E8-1 fail-before: a principal that falls back to the caller own company admits the wrong-company caller', async (t) => {
  /* The mutant, named: `loadPrincipal` answers with the caller's OWN membership when the path's company is not
     one of theirs, instead of E_NOT_FOUND. That is case 43's "reads the company from the body rather than the
     path" one level down, and it is the principal-confusion defect design 4.1's unentitled load half exists to
     catch. It is a COPY of lib/ under .scratch/; nothing under lib/ is edited by this lane.

     Only the `:companyId` tenant routes are driven here. The row-keyed routes (`:candidateId`, `:releaseId`) do
     not reach this loader at all for a foreign row, which lib/services/principal.mjs says in its own comment: RLS
     answers them empty first. So this mutant is the counterexample for the loader's half of the arm, and the
     sweep's other half rests on RLS, which tests/db/02-tenancy.sh drives directly. */
  const mutant = await mutantRoutes('principal-own-company-fallback', [
    [
      'lib/services/principal.mjs',
      [
        [
          "  if (!m) return { ok: false, code: 'E_NOT_FOUND' };",
          "  const fallback = m ?? rows[0] ?? (await select(session, 'my_standing', { select: 'membership_id,roles,membership_status,company_status,access_state,company_name' }, options)).find((r) => r?.membership_status === 'active');\n  if (!fallback) return { ok: false, code: 'E_NOT_FOUND' };\n  const m2 = fallback;",
        ],
        ["  if (m.company_status === 'closed')", "  if (m2.company_status === 'closed')"],
        ["  if (m.access_state === 'expired')", "  if (m2.access_state === 'expired')"],
        ["  if (m.company_status !== 'active')", "  if (m2.company_status !== 'active')"],
        ['    membershipId: m.membership_id,', '    membershipId: m2.membership_id,'],
        ['    roles: [...m.roles],', '    roles: [...m2.roles],'],
        ['    companyStatus: m.company_status,', '    companyStatus: m2.company_status,'],
        [
          "    accessState: typeof m.access_state === 'string' ? m.access_state : 'none',",
          "    accessState: typeof m2.access_state === 'string' ? m2.access_state : 'none',",
        ],
        [
          "    companyName: typeof m.company_name === 'string' ? m.company_name : null,",
          "    companyName: typeof m2.company_name === 'string' ? m2.company_name : null,",
        ],
      ],
    ],
  ]);
  const mutantCall = caller(mutant.table, COOKIES, makeRequest);
  const admitted = [];
  for (const name of ['membersList', 'quotasRead', 'candidatesList', 'releasesList', 'catalogRead', 'groupsList']) {
    const entry = SWEPT[name];
    const { params = {}, body, headers = {} } = entry.request(VICTIM);
    const answer = await mutantCall(name, { user: B.adminHi, params, headers, body });
    admitted.push(`${name}: ${answer.status} ${answer.body?.code ?? 'ok'}`);
  }
  t.diagnostic(`E8-1 mutant answers: ${admitted.join(', ')}`);
  /* The intended check, run against the mutant: it must fail. */
  const failure = await caughtAsync('E8-1 the wrong-company arm', () =>
    sweepRoute('membersList', SWEPT.membersList, mutant.table, mutantCall),
  );
  assert.ok(failure instanceof assert.AssertionError, `an assertion failure, not ${failure?.name}`);
  assert.match(failure.message, /membersList \(tenant\) called by a/);
  t.diagnostic(`E8-1 fail-before at the intended check: ${failure.message.split('\n')[0]}`);
  assert.ok(
    admitted.some((line) => line.includes(': 200')),
    `the mutant admitted at least one wrong-company read: ${admitted.join(', ')}`,
  );
});

/* ---------------------------------------------------------------------------------------------------
   E8-2: guessed ids of the wrong class, of no company, and of a deleted company's object
   --------------------------------------------------------------------------------------------------- */

/* The four id classes. `wrong-class` replaces each id with the id of an existing object of ANOTHER class in the
   same company A, so the id resolves to a real row that is not the row the route wants; `nowhere` is a fresh uuid;
   `deleted-company` is the id company C held before the operator's one door removed it; `foreign-company` is
   company B's live object of the same class, which is the only class whose row actually exists at call time. */
const WRONG_CLASS = {
  companyId: () => PUBLISHED.releaseId,
  membershipId: () => PUBLISHED.candidateId,
  invitationId: () => A.ms.member,
  groupId: () => PUBLISHED.releaseId,
  candidateId: () => PUBLISHED.releaseId,
  releaseId: () => PUBLISHED.candidateId,
  reportId: () => PUBLISHED.releaseId,
  agentId: () => PUBLISHED.candidateId,
};

function guessedWorld(kind) {
  if (kind === 'nowhere') return Object.fromEntries(Object.keys(VICTIM).map((k) => [k, randomUUID()]));
  if (kind === 'deleted-company') return { ...GONE };
  if (kind === 'foreign-company') return { ...FOREIGN };
  return Object.fromEntries(Object.keys(VICTIM).map((k) => [k, WRONG_CLASS[k]()]));
}

/* `foreign-company` for an operator-company route would name a company the operator IS entitled to, so the call
   would not be a guessed-id call at all: it would be a correct call with a confirmation slug no company has, and
   the routine would answer its own 409 or 422. The class is skipped there and the skip is asserted to be exactly
   the eight routes of that class. */
const KINDS = ['wrong-class', 'nowhere', 'deleted-company', 'foreign-company'];
const kindsFor = (entry) => (entry.cls === OPERATOR_COMPANY ? KINDS.filter((k) => k !== 'foreign-company') : KINDS);

test('E8-2 four guessed-id classes meet the same answer on every swept route, and none is an existence oracle', async (t) => {
  const timings = new Map(KINDS.map((k) => [k, []]));
  const rows = [];
  const skipped = [];
  await noWrite('E8-2 the guessed-id sweep', async () => {
    for (const [name, entry] of Object.entries(SWEPT)) {
      const seen = new Map();
      if (kindsFor(entry).length !== KINDS.length) skipped.push(name);
      for (const kind of kindsFor(entry)) {
        alerts.length = 0;
        const { params = {}, body, headers = {} } = entry.request(guessedWorld(kind));
        const t0 = performance.now();
        const answer = await call(name, { user: entry.entitled(), params, headers, body });
        timings.get(kind).push(performance.now() - t0);
        seen.set(kind, `${answer.status} ${answer.raw}`);
        assert.deepEqual(alerts, [], `${name} ${kind}: a refusal raised an alert`);
        assert.ok(answer.status < 500, `${name} ${kind}: ${answer.status} ${answer.raw}`);
      }
      const distinct = new Set(seen.values());
      assert.equal(
        distinct.size,
        1,
        `${name}: the id classes answered differently, which is an existence oracle\n  ${[...seen]
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n  ')}`,
      );
      const [only] = distinct;
      assert.match(only, /^404 /, `${name}: a guessed id answered ${only.slice(0, 120)}`);
      rows.push(`${name} ${only.slice(0, 60)}`);
    }
  });
  /* Timing, with its limit stated. The claim is the absence of a GROSS separation between the classes, which is
     what an existence oracle by delay looks like: E2 design section 6 records refusals at 43 to 64 ms and the
     same refusal at about 3.7 s when a foreign company's row was held. It is not a constant-time claim and this
     file does not make one. */
  assert.deepEqual(
    skipped.sort(),
    Object.entries(SWEPT)
      .filter(([, e]) => e.cls === OPERATOR_COMPANY)
      .map(([n]) => n)
      .sort(),
    'the foreign-company class is skipped for exactly the eight operator-company routes',
  );
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const medians = KINDS.map((k) => [k, median(timings.get(k))]);
  const worst = Math.max(...KINDS.flatMap((k) => timings.get(k)));
  for (const [kind, ms] of medians) t.diagnostic(`E8-2 ${kind}: median ${ms.toFixed(1)} ms over ${timings.get(kind).length} calls`);
  t.diagnostic(`E8-2 slowest single refusal ${worst.toFixed(1)} ms`);
  const lo = Math.min(...medians.map(([, ms]) => ms));
  const hi = Math.max(...medians.map(([, ms]) => ms));
  assert.ok(hi <= lo * 3, `the classes' medians are within a factor of three: ${JSON.stringify(medians)}`);
  assert.ok(worst < 1500, `no single refusal waited on a lock: slowest ${worst.toFixed(1)} ms`);
  for (const line of rows) t.diagnostic(`E8-2 ${line}`);
});

test('E8-2 fail-before: a route that answers 403 for an existing foreign object and 404 for an unknown one is an oracle', async (t) => {
  /* The mutant, named `installations-existence-oracle`: lib/services/installations.mjs distinguishes "this report
     exists and is not yours" from "no such report", which is exactly the oracle design 2.3 row E8-2 names.

     THE CONSTRUCTION, AND ITS LIMIT, BECAUSE THE LIMIT IS ITSELF THE FINDING (E8T-F3). A service cannot build this
     oracle out of what it holds. Every read in lib/services/ goes through lib/db/user.mjs with the caller's own
     token, so a row in another company is indistinguishable from a row that does not exist: both are an empty
     result, which is why the real answer is the same 404 and why E8-2 passes. lib/db/operator.mjs, the one holder
     of the service key, exports `adminRequest` and `generateLink` and no table client at all, and
     scripts/check-imports.mjs refuses even that import outside lib/operator/, scripts/, tests/ and one named
     function. So the counterexample has to be GIVEN the privilege from outside, and it is: the mutant reads
     `app.installation_reports` through the project's own database container, as tests/db/lib.sh does. What that
     buys is a real demonstration that E8-2's same-answer assertion catches an oracle; what it does not buy is the
     claim that a service could build one today. Both sentences are in evidence/e8-tenancy.md section 3.

     The separating input is `foreign-company`, company B's own report, which is the class added for this reason:
     against `nowhere` the mutant answers 404 like the real code, so the three classes the design named could not
     have shown the mutant at all. */
  assert.equal(ownerCount('installation_reports', FOREIGN.reportId), 1, "company B's report exists owner-side");
  const mutant = await mutantRoutes('installations-existence-oracle', [
    [
      'lib/services/installations.mjs',
      [
        [
          "  const visible = await select(session, 'installation_reports', { select: 'id', id: `eq.${reportId}` }, options);\n  if (visible.length !== 1) throw new AppError('E_NOT_FOUND');",
          "  const visible = await select(session, 'installation_reports', { select: 'id', id: `eq.${reportId}` }, options);\n  if (visible.length !== 1)\n    throw new AppError(e8ownerCount('installation_reports', reportId) === 1 ? 'E_FORBIDDEN' : 'E_NOT_FOUND');",
        ],
        ["import { AppError } from '../errors.mjs';", `import { AppError } from '../errors.mjs';${ownerCountSource()}`],
      ],
    ],
  ]);
  const mutantCall = caller(mutant.table, COOKIES, makeRequest);
  const entry = SWEPT.installationsWitness;
  const answers = new Map();
  for (const kind of ['foreign-company', 'nowhere']) {
    const { params, headers, body } = entry.request(guessedWorld(kind));
    const answer = await mutantCall('installationsWitness', { user: entry.entitled(), params, headers, body });
    answers.set(kind, `${answer.status} ${answer.body?.code}`);
  }
  t.diagnostic(`E8-2 oracle mutant: ${[...answers].map(([k, v]) => `${k} -> ${v}`).join(', ')}`);
  assert.equal(answers.get('foreign-company'), '403 E_FORBIDDEN', 'the mutant says the foreign report exists');
  assert.equal(answers.get('nowhere'), '404 E_NOT_FOUND', 'and says an unknown one does not');
  /* The intended check is the same-answer assertion, run here on the mutant's two classes: it must fail. */
  const failure = caught('E8-2 the same-answer assertion', () =>
    assert.equal(
      new Set(answers.values()).size,
      1,
      `installationsWitness: the id classes answered differently, which is an existence oracle\n  ${[...answers]
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n  ')}`,
    ),
  );
  assert.ok(failure instanceof assert.AssertionError, `an assertion failure, not ${failure?.name}`);
  assert.match(failure.message, /existence oracle/);
  t.diagnostic(`E8-2 fail-before at the intended check: ${failure.message.split('\n')[0]}`);
  /* And the real code answers both classes alike, which is the pass this mutant is the before of. */
  const real = new Set();
  for (const kind of ['foreign-company', 'nowhere']) {
    const { params, headers, body } = entry.request(guessedWorld(kind));
    const answer = await call('installationsWitness', { user: entry.entitled(), params, headers, body });
    real.add(`${answer.status} ${answer.body?.code}`);
  }
  assert.deepEqual([...real], ['404 E_NOT_FOUND'], 'the real code answers both classes alike');
});

/* ---------------------------------------------------------------------------------------------------
   E8-9's helper: its own counterexample
   --------------------------------------------------------------------------------------------------- */

test('E8-9 the no-write contract fails for a block that writes one audit row, and names the table', async (t) => {
  let written = null;
  const failure = await caughtAsync('E8-9 the no-write contract', () =>
    noWrite('E8-9 the helper own fail-before', async () => {
      written = writeOneAuditRow();
    }),
  );
  assert.ok(failure instanceof assert.AssertionError, `an assertion failure, not ${failure?.name}`);
  assert.match(failure.message, /app\.audit_events: \d+ -> \d+/);
  t.diagnostic(`E8-9 fail-before: ${failure.message.split('\n').slice(0, 2).join(' / ')}`);
  deleteAuditRow(written);
  /* And the helper passes for a block that reads: the same counts around a refused read. */
  await noWrite('E8-9 a refused read writes nothing', async () => {
    const answer = await call('membersList', { user: B.adminHi, params: { companyId: A.id } });
    assert.equal(answer.status, 404);
  });
});
