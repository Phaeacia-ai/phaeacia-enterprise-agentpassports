/* Local-stack helpers for the E4 route tests (E4 design section 5 cases 19 to 22 and 42 to 45, and section 6). They reuse
   tests/e3/stack/helpers.mjs (the seed through tests/db/00-seed.sh, owner SQL, GoTrue sessions, the route caller) and,
   through its e3lib bridge, tests/db/e4-lib.sh (publishable targets, probe calls under another gate identity). A session
   at aal2 is minted with the local secret, the only local way to aal2 (tests/e2/helpers/stack.mjs). Every file reseeds
   and builds its own users and companies. Nothing here prints a key. */
import { randomBytes } from 'node:crypto';

import { mintUserToken } from '../../e2/helpers/stack.mjs';
import {
  attribution,
  audits,
  caller,
  count,
  e3lib,
  key,
  largePassport,
  MAX_BYTES,
  PROSE,
  passport,
  passportText,
  percentile,
  psqlSession,
  ROOT,
  reseed,
  sql,
  timedFetch,
  withFetch,
  world,
} from '../../e3/stack/helpers.mjs';
import { SUBMISSION } from '../../e3/unit/submission-shapes.mjs';

export {
  attribution,
  audits,
  count,
  e3lib,
  key,
  largePassport,
  MAX_BYTES,
  PROSE,
  passport,
  passportText,
  percentile,
  psqlSession,
  ROOT,
  reseed,
  sql,
  timedFetch,
  withFetch,
};

export const TARGETS = Object.freeze(['chatgpt', 'claude-ai', 'claude-code', 'generic']);

/** Every target publishable, owner-side under the registry bypass, as a later numbered migration would. */
export function enableTargets() {
  for (const target of TARGETS) e3lib('enable_target "$1"', target);
}
export const activePolicyId = () => sql('select id from app.release_policies where active');
export const auditsOf = (companyId) => Number(sql(`select count(*) from app.audit_events where company_id='${companyId}'`));

/** Poll a condition every 50 ms until it holds, or throw after the timeout. */
export async function waitFor(condition, label, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`waitFor: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The E3 helpers' world, with a way to the same user at aal2. */
export function e4world(tag, ids) {
  const W = world(`e4-${tag}`, ids);
  const aal2 = (u) => ({ ...u, token: () => mintUserToken({ sub: u.id, email: u.email, aal: 'aal2', ttl: 3600 }) });
  return { ...W, aal2 };
}

/** The E3 and E4 routes as the tests call them; every write takes a fresh Idempotency-Key unless one is given. */
export async function e4routes(logged = []) {
  const { COOKIES } = await import('../../../lib/session.mjs');
  const { makeRequest } = await import('../../../lib/http/request.mjs');
  const { makeRoutes } = await import('../../../lib/http/routes.mjs');
  const routes = makeRoutes({ log: (entry) => logged.push(entry) });
  const call = caller(routes, COOKIES, makeRequest);
  const idem = (k) => ({ 'idempotency-key': k ?? key() });
  return {
    call,
    create: (user, companyId, { name, agentId, bytes = passport('0'), k } = {}) =>
      call('candidatesCreate', {
        user,
        params: { companyId },
        headers: { ...idem(k), ...(name ? { 'x-agent-name': name } : {}), ...(agentId ? { 'x-agent-id': agentId } : {}) },
        body: bytes,
      }),
    submit: (user, candidateId, version = 1) =>
      call('candidatesSubmit', {
        user,
        params: { candidateId },
        headers: { ...idem(), 'if-match': String(version) },
        body: { ...SUBMISSION },
      }),
    envelope: (user, candidateId, body, k) =>
      call('envelopesCreate', { user, params: { candidateId }, headers: idem(k), body }),
    review: (user, candidateId, body, k) => call('reviewsCreate', { user, params: { candidateId }, headers: idem(k), body }),
    publish: (user, candidateId, envelopeId, k) =>
      call('releasesPublish', { user, params: { candidateId }, headers: idem(k), body: { envelopeId } }),
    withdraw: (user, releaseId, reason, k) =>
      call('releasesWithdraw', { user, params: { releaseId }, headers: idem(k), body: { reason } }),
    queue: (user, companyId) => call('reviewQueue', { user, params: { companyId } }),
    reviewRead: (user, candidateId) => call('reviewRead', { user, params: { candidateId } }),
    releaseRead: (user, releaseId) => call('releasesRead', { user, params: { releaseId } }),
    releasesList: (user, companyId, query = {}) => call('releasesList', { user, params: { companyId }, query }),
    groupsList: (user, companyId) => call('groupsList', { user, params: { companyId } }),
    groupsCreate: (user, companyId, name) => call('groupsCreate', { user, params: { companyId }, body: { name } }),
    memberAdd: (user, companyId, groupId, membershipId) =>
      call('groupMembersAdd', { user, params: { companyId, groupId, membershipId } }),
    memberRemove: (user, companyId, groupId, membershipId) =>
      call('groupMembersRemove', { user, params: { companyId, groupId, membershipId } }),
  };
}

const ok = (r, status, label) => {
  if (r.status !== status) throw new Error(`${label}: expected ${status}, got ${r.status} ${r.raw}`);
  return r.body;
};

/** A company with an admin (and the same admin at aal2), an author, an IT and a business reviewer, and a plain member
    who is the one member of an audience group created through the routes. */
export async function reviewCompany(W, R, slug) {
  const admin = W.user(`${slug}-admin`);
  const author = W.user(`${slug}-author`);
  const it = W.user(`${slug}-it`);
  const business = W.user(`${slug}-business`);
  const member = W.user(`${slug}-member`);
  const company = W.company(slug, admin);
  const ms = {
    admin: company.adminMembership,
    author: W.member(company.id, author),
    it: W.member(company.id, it, '{it_reviewer,member}'),
    business: W.member(company.id, business, '{business_reviewer,member}'),
    member: W.member(company.id, member),
  };
  const adminHi = W.aal2(admin);
  const group = ok(await R.groupsCreate(adminHi, company.id, `Audience ${slug} ${W.run}`), 201, 'audience group');
  ok(await R.memberAdd(adminHi, company.id, group.groupId, ms.member), 200, 'audience member');
  return { id: company.id, admin, adminHi, author, it, business, member, ms, groupId: group.groupId };
}

let revisions = 0;
/** A submitted candidate through the E3 routes: a new agent, or a new version of agentId. */
export async function submitted(R, C, { agentId, author = C.author, bytes } = {}) {
  revisions += 1;
  const tag = `${revisions}-${randomBytes(3).toString('hex')}`;
  const d = ok(
    await R.create(author, C.id, agentId ? { agentId, bytes: bytes ?? passport(tag) } : { name: `agent-${tag}`, bytes: bytes ?? passport(tag) }),
    201,
    'draft',
  );
  ok(await R.submit(author, d.candidateId, 1), 200, 'submit');
  return { candidateId: d.candidateId, agentId: d.agentId };
}

/** An envelope through the route; its id. */
export async function envelopeFor(R, C, candidateId, target = 'claude-ai', { by = C.author, groups = [C.groupId] } = {}) {
  const r = await R.envelope(by, candidateId, { target, audienceGroupIds: groups, policyId: activePolicyId() });
  if (r.status !== 201 && r.status !== 200) throw new Error(`envelope: ${r.status} ${r.raw}`);
  return r.body.envelope.envelopeId;
}

export async function approveBoth(R, C, candidateId, envelopeId) {
  ok(await R.review(C.it, candidateId, { envelopeId, role: 'it', decision: 'approved', reason: 'IT approves.' }), 201, 'IT');
  ok(
    await R.review(C.business, candidateId, { envelopeId, role: 'business', decision: 'approved', reason: 'Business approves.' }),
    201,
    'business',
  );
}

/** A submitted candidate with an approved envelope for the target, published by the admin at aal2. */
export async function published(R, C, target = 'claude-ai', options = {}) {
  const { candidateId, agentId } = await submitted(R, C, options);
  const envelopeId = await envelopeFor(R, C, candidateId, target);
  await approveBoth(R, C, candidateId, envelopeId);
  const body = ok(await R.publish(C.adminHi, candidateId, envelopeId), 201, 'publish');
  return { candidateId, agentId, envelopeId, releaseId: body.release.releaseId };
}
