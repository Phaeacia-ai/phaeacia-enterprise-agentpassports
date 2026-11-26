/* Local-stack helpers for the E6 route tests (E6 design section 5 and section 6). They reuse
   tests/e5/stack/helpers.mjs, which reuses E4's and E3's and, through the e3lib bridge, tests/db/e3-lib.sh; e6lib
   below is the same bridge over tests/db/e6-lib.sh, so the fixtures the probes use (aging a period, dropping one,
   reading the two derived states, the schema-cache reload of E6DB-F14) are the same code and not a second copy.
   Every file reseeds and builds its own users and companies. Nothing here prints a key. */
import { spawnSync } from 'node:child_process';

import { mintUserToken } from '../../e2/helpers/stack.mjs';
import { percentile, timedFetch } from '../../e3/stack/helpers.mjs';
import {
  activePolicyId,
  approveBoth,
  auditsOf,
  count,
  e3lib,
  e4world,
  e5routes,
  enableTargets,
  envelopeFor,
  key,
  psqlSession,
  published,
  reseed,
  reviewCompany,
  ROOT,
  sql,
  submitted,
  TARGETS,
  waitFor,
  withFetch,
} from '../../e5/stack/helpers.mjs';

export {
  activePolicyId,
  approveBoth,
  auditsOf,
  count,
  e3lib,
  e4world,
  enableTargets,
  envelopeFor,
  key,
  percentile,
  psqlSession,
  published,
  reseed,
  reviewCompany,
  ROOT,
  sql,
  submitted,
  TARGETS,
  timedFetch,
  waitFor,
  withFetch,
};

/** One tests/db/e6-lib.sh function with positional arguments; returns trimmed stdout, throws on failure. */
export function e6lib(script, ...args) {
  const r = spawnSync(
    'bash',
    [
      '-c',
      `cd "$0" && source tests/db/lib.sh && source .scratch/e2/ids.env && source tests/db/e3-lib.sh && source tests/db/e4-lib.sh && source tests/db/e6-lib.sh && ${script}`,
      ROOT,
      ...args,
    ],
    { encoding: 'utf8', env: process.env },
  );
  if (r.status !== 0) throw new Error(`e6-lib failed (exit ${r.status}): ${r.stderr.slice(0, 400)}`);
  return r.stdout.trim();
}

/* Owner-side period fixtures, design section 5's "owner-side" label: no route ages a timestamp, and the whole
   point of case 38 is a company whose dates have passed WITHOUT the sweep having run. */
export const agePeriod = (companyId, endsAgo, exportByAgo, deleteByAgo) =>
  e6lib('age_period "$1" "$2" "$3" "$4"', companyId, endsAgo, exportByAgo, deleteByAgo);
export const futurePeriod = (companyId) => e6lib('future_period "$1"', companyId);
export const dropPeriod = (companyId) => e6lib('drop_period "$1"', companyId);
export const accessState = (companyId) => e6lib('access_state "$1"', companyId);
export const deletionState = (companyId) => e6lib('deletion_state "$1"', companyId);
/* A company's status owner-side, including a move out of closed, which app.company_status_guard admits only
   under the deletion bypass (design 1.6). */
export const setStatus = (companyId, status) => e6lib('set_status "$1" "$2"', companyId, status);

/** The seeded operator, at aal1 and at aal2. Minting is the only local way to aal2 (tests/e2/helpers/stack.mjs). */
export function operators(ids) {
  const at = (aal) => ({
    who: `operator-${aal}`,
    id: ids.U_op,
    email: 'synthetic-op@example.invalid',
    token: () => mintUserToken({ sub: ids.U_op, email: 'synthetic-op@example.invalid', aal, ttl: 3600 }),
  });
  return { aal1: at('aal1'), aal2: at('aal2') };
}

/** The E3, E4, E5 and E6 routes as the tests call them. No E6 route carries an Idempotency-Key (design 3.3). */
export async function e6routes(logged = []) {
  const R = await e5routes(logged);
  /* The route table itself, for callRaw: the shared caller returns no cookies, and the accept flow needs the
     Set-Cookie the verify route writes. Same handlers, same log array; a route function holds no state. */
  const { makeRoutes } = await import('../../../lib/http/routes.mjs');
  const table = makeRoutes({ log: (entry) => logged.push(entry) });
  return {
    ...R,
    table,
    /* operator */
    companyCreate: (user, body) => R.call('operatorCompanyCreate', { user, body }),
    register: (user, query = {}) => R.call('operatorRegister', { user, query }),
    takeoutManifest: (user, companyId) => R.call('operatorTakeoutManifest', { user, params: { companyId } }),
    companyStatus: (user, companyId, body) => R.call('operatorCompanyStatus', { user, params: { companyId }, body }),
    accessPeriod: (user, companyId, body) => R.call('operatorAccessPeriod', { user, params: { companyId }, body }),
    companyQuota: (user, companyId, body) => R.call('operatorCompanyQuota', { user, params: { companyId }, body }),
    adminInvitation: (user, companyId, body) =>
      R.call('operatorAdminInvitation', { user, params: { companyId }, body }),
    companyClose: (user, companyId, body) => R.call('operatorCompanyClose', { user, params: { companyId }, body }),
    companyDelete: (user, companyId, body) => R.call('operatorCompanyDelete', { user, params: { companyId }, body }),
    expiryRun: (user, body = {}) => R.call('operatorExpiryRun', { user, body }),
    transferFirstAdmin: (user, companyId, body) =>
      R.call('operatorTransferAdmin', { user, params: { companyId }, body }),
    /* company-facing */
    resend: (user, companyId, invitationId) =>
      R.call('invitationsResend', { user, params: { companyId, invitationId } }),
    departure: (user, companyId, membershipId) =>
      R.call('membersDeparture', { user, params: { companyId, membershipId } }),
    transferAgent: (user, agentId, body) => R.call('agentsTransfer', { user, params: { agentId }, body }),
    quotas: (user, companyId) => R.call('quotasRead', { user, params: { companyId } }),
    takeout: (user, companyId) => R.call('companyTakeout', { user, params: { companyId } }),
    me: (user) => R.call('me', { user }),
    invite: (user, companyId, body) => R.call('invitationsCreate', { user, params: { companyId }, body }),
    invitations: (user, companyId) => R.call('invitationsList', { user, params: { companyId } }),
    acceptInvite: (user, inviteCode) => R.call('invitationsAccept', { user, body: { inviteCode } }),
    removeMember: (user, companyId, membershipId) =>
      R.call('membersRemove', { user, params: { companyId, membershipId } }),
  };
}

/** Call one route with a raw access token and get the whole answer, cookies included: the accept flow needs the
    Set-Cookie the verify route writes, which the shared caller does not return. */
export async function callRaw(routes, name, { params = {}, query = {}, token, body, headers = {} } = {}) {
  const { COOKIES } = await import('../../../lib/session.mjs');
  const { makeRequest } = await import('../../../lib/http/request.mjs');
  const handler = routes[name];
  const h = { ...headers };
  if (token) h.cookie = `${COOKIES.access}=${token}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await handler(
    makeRequest({
      method: handler.route.method,
      path: handler.route.path,
      params,
      query,
      headers: h,
      body: body === undefined ? null : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.body === null ? null : JSON.parse(res.body), raw: res.body, res };
}

/** The three parts of a handover accept link, read from the fragment the way the accept page reads them. */
export function linkParts(acceptUrl) {
  const url = new URL(acceptUrl);
  const parts = new URLSearchParams(url.hash.slice(1));
  return {
    origin: url.origin,
    pathname: url.pathname,
    search: url.search,
    keys: [...parts.keys()],
    tokenHash: parts.get('token_hash'),
    type: parts.get('type'),
    inviteCode: parts.get('invite'),
  };
}

/** An access period an operator route would write: two dates a month apart, starting yesterday. */
export function periodBody(over = {}) {
  const day = 86_400_000;
  return {
    startsAt: new Date(Date.now() - day).toISOString(),
    endsAt: new Date(Date.now() + 56 * day).toISOString(),
    ...over,
  };
}

/* A synthetic address nothing else in the run uses. The local GoTrue hook admits an address only when a pending
   invitation holds it, which is exactly what api.create_company writes in the same transaction. */
export const freshEmail = (tag) => `e6-${tag}-${Math.random().toString(16).slice(2, 10)}@example.invalid`;

/** A user object for an address created through the product path, whose session is a real sign-in. */
export function userFor(ids, email) {
  const id = sql(`select id from auth.users where lower(email) = '${email}'`);
  let token = null;
  return {
    who: email,
    id,
    email,
    token: () => {
      token ??= e3lib('user_jwt "$1" "$PW"', email);
      return token;
    },
  };
}

export const membershipOf = (companyId, userId) =>
  sql(`select id from app.memberships where company_id='${companyId}' and user_id='${userId}'`);
export const companyStatusOf = (companyId) => sql(`select status from app.companies where id='${companyId}'`);
export const companyExists = (companyId) => sql(`select count(*) from app.companies where id='${companyId}'`) === '1';
