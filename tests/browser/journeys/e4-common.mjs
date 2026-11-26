/* What the E4 journeys share (E4 design 4 and 5): one fresh company per run with its accounts, and the candidates,
   envelopes, reviews and releases a journey starts from. The starting states are made in this process through the route
   functions under sessions minted with the local secret, as tests/e4/stack/ makes them: that is the harness setting up,
   never a page's request, and the universal assertions read only what the pages send. Each account signs in to its own
   browser through its own link (common.mjs signIn), so every page request carries a real session. The seeded E2
   accounts are never given another membership (evidence/e3a-recheck.md, reviewer lesson). Owner-side SQL is labelled
   where it is used. Nothing here prints a token or a key. */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mintUserToken } from '../../e2/helpers/stack.mjs';
import { caller, e3lib, PROSE, passportText, ROOT, sql } from '../../e3/stack/helpers.mjs';
import { SUBMISSION } from '../../e3/unit/submission-shapes.mjs';
import { currentCode } from '../totp.mjs';
import { signIn, sleep, startSetup, tag, verifySetup, waitPath } from './common.mjs';

/* The company's accounts and their roles; the administrator's membership comes with the company. */
const ROLES = Object.freeze({
  admin: null,
  author: '{it_reviewer,member}',
  owner: '{member}',
  it: '{it_reviewer,member}',
  business: '{business_reviewer,member}',
  leaver: '{business_reviewer,member}',
  member: '{member}',
});

export const GROUP_NAME = 'Finance reviewers';
export const fixture = (name) => readFileSync(join(ROOT, 'tests', 'passport', 'fixtures', name), 'utf8');
export const activePolicyId = () => sql('select id from app.release_policies where active');

function ok(r, label) {
  if (r.status < 200 || r.status >= 300) throw new Error(`E4 setup, ${label}: ${r.status} ${String(r.raw).slice(0, 200)}`);
  return r.body;
}

/** The route functions of this process, with a mail capture. */
export async function routes(ctx) {
  if (!ctx.state.e4routes) {
    const { COOKIES } = await import('../../../lib/session.mjs');
    const { makeRequest } = await import('../../../lib/http/request.mjs');
    const { makeRoutes } = await import('../../../lib/http/routes.mjs');
    const mail = [];
    const table = makeRoutes({
      deliver: async (message) => {
        mail.push(message);
      },
      log: () => undefined,
    });
    ctx.state.e4routes = { call: caller(table, COOKIES, makeRequest), mail };
  }
  return ctx.state.e4routes;
}

/** The run's E4 company, made once: accounts, memberships, one audience group holding the member, claude-ai publishable. */
export async function e4world(ctx) {
  if (ctx.state.e4) return ctx.state.e4;
  const run = tag();
  const users = {};
  for (const who of Object.keys(ROLES)) {
    const email = `e4p-${run}-${who}@example.invalid`;
    const id = e3lib('create_user "$1" "$PW"', email);
    users[who] = { who, id, email, identity: `e4-${who}`, token: () => mintUserToken({ sub: id, email, aal: 'aal1', ttl: 3600 }) };
  }
  const companyId = e3lib('company "$1" "$2"', `e4p-${run}`, users.admin.id);
  const ms = { admin: e3lib('membership_of "$1" "$2"', companyId, users.admin.id) };
  for (const [who, roles] of Object.entries(ROLES)) if (roles) ms[who] = e3lib('member "$1" "$2" "$3"', companyId, users[who].id, roles);
  const aal2 = (u) => ({ ...u, token: () => mintUserToken({ sub: u.id, email: u.email, aal: 'aal2', ttl: 3600 }) });
  const { call } = await routes(ctx);
  const group = ok(await call('groupsCreate', { user: aal2(users.admin), params: { companyId }, body: { name: GROUP_NAME } }), 'group');
  ok(await call('groupMembersAdd', { user: aal2(users.admin), params: { companyId, groupId: group.groupId, membershipId: ms.member } }), 'group member');
  /* Owner-side, labelled as design 1.8 labels it: a target enabled for publication, as a later migration would. */
  e3lib('enable_target "$1"', 'claude-ai');
  const companyName = sql(`select name from app.companies where id = '${companyId}'`);
  ctx.state.e4 = { run, users, ms, companyId, companyName, groupId: group.groupId, aal2 };
  return ctx.state.e4;
}

/** A submitted candidate of a new agent (or a new version of agentId) by an author, through the E3 routes. */
export async function submitted(ctx, W, { author = W.users.author, text, agentName, agentId } = {}) {
  const { call } = await routes(ctx);
  const name = agentName ?? `weekly-brief-${tag()}`;
  const headers = { 'idempotency-key': randomUUID(), ...(agentId ? { 'x-agent-id': agentId } : { 'x-agent-name': name }) };
  const body = Buffer.from(text ?? passportText(tag()), 'utf8');
  const draft = ok(await call('candidatesCreate', { user: author, params: { companyId: W.companyId }, headers, body }), 'draft');
  ok(
    await call('candidatesSubmit', {
      user: author,
      params: { candidateId: draft.candidateId },
      headers: { 'idempotency-key': randomUUID(), 'if-match': String(draft.version) },
      body: { ...SUBMISSION },
    }),
    'submit',
  );
  return { candidateId: draft.candidateId, agentId: draft.agentId, agentName: name, author };
}

/** An envelope for the run's audience group, proposed by a reader of the candidate; its id. */
export async function envelope(ctx, W, candidateId, { by = W.users.it, target = 'claude-ai', groups = [W.groupId] } = {}) {
  const { call } = await routes(ctx);
  const body = { target, audienceGroupIds: groups, policyId: activePolicyId() };
  return ok(await call('envelopesCreate', { user: by, params: { candidateId }, headers: { 'idempotency-key': randomUUID() }, body }), 'envelope').envelope.envelopeId;
}

/** One review through the route. */
export async function reviewed(ctx, candidateId, user, body) {
  const { call } = await routes(ctx);
  return ok(await call('reviewsCreate', { user, params: { candidateId }, headers: { 'idempotency-key': randomUUID() }, body }), `review ${body.role} ${body.decision}`);
}

export async function approveBoth(ctx, W, candidateId, envelopeId) {
  await reviewed(ctx, candidateId, W.users.it, { envelopeId, role: 'it', decision: 'approved', reason: 'Reads the weekly report only; the declared write stays inactive.' });
  await reviewed(ctx, candidateId, W.users.business, { envelopeId, role: 'business', decision: 'approved', reason: 'The audience is the finance team that owns the report.' });
}

/** Publication by the administrator at aal2; the release id. */
export async function published(ctx, W, candidateId, envelopeId) {
  const { call } = await routes(ctx);
  const r = ok(
    await call('releasesPublish', { user: W.aal2(W.users.admin), params: { candidateId }, headers: { 'idempotency-key': randomUUID() }, body: { envelopeId } }),
    'publish',
  );
  return r.release.releaseId;
}

/** An invitation to an address in the run's company, sent in-process; its accept URL, held in memory.

    Changed by the E6 pages lane under the lead's grant (2026-09-18): since E6 the default delivery is handover (design
    1.2), in which the route returns the link in its answer and mails nothing, so the link is read from the answer
    rather than from the mail capture, which stays empty. The mail path stays covered by
    tests/e2/stack/pages-reads.test.mjs and handlers.test.mjs, which pin ENTERPRISE_INVITATION_DELIVERY=mail. */
export async function invitationUrl(ctx, W, email) {
  const { call } = await routes(ctx);
  const answer = ok(
    await call('invitationsCreate', { user: W.aal2(W.users.admin), params: { companyId: W.companyId }, body: { email, roles: [], expiresInDays: 7 } }),
    'invitation',
  );
  if (answer.delivery !== 'handover' || typeof answer.acceptUrl !== 'string') throw new Error('E4 setup: the invitation answer carried no link');
  return answer.acceptUrl;
}

export const reviewUrl = (j, candidateId) => `${j.origin}/review/?candidate=${candidateId}`;
export const companyUrl = (j, path, companyId) => `${j.origin}${path}?company=${companyId}`;
export const releaseUrl = (j, releaseId) => `${j.origin}/release/?release=${releaseId}`;
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const count = (from, where) => Number(sql(`select count(*) from ${from} where ${where}`));

/** The account's browser signed in once per run through its own link; the identity name. */
export async function signedIn(j, W, who) {
  const u = W.users[who];
  W.signed ??= new Set();
  if (!W.signed.has(who)) {
    const tab = await signIn(j, u.identity, u.email, { label: `sign-in-${who}` });
    await tab.until(async () => ['/members/', '/'].includes((await tab.location().catch(() => ({}))).pathname), {
      timeout: 20000,
      what: 'the signed-in landing',
    });
    W.signed.add(who);
  }
  return u.identity;
}

/** The administrator's browser at aal2: signed in, moved to enrolment by the forced-enrolment rule, and enrolled against
    the real provider, once per run. The key stays in memory for later challenges. */
export async function adminAal2(j, W) {
  if (W.adminKey) return W.users.admin.identity;
  const tab = await signIn(j, W.users.admin.identity, W.users.admin.email, { label: 'admin-enrol' });
  await waitPath(tab, '/mfa/');
  await tab.waitForSelector('[data-state="enrol"]');
  const key = await startSetup(tab);
  await verifySetup(tab, key);
  await waitPath(tab, '/members/');
  W.adminKey = key;
  W.adminStep = Math.floor(Date.now() / 30000);
  W.signed ??= new Set();
  W.signed.add('admin');
  return W.users.admin.identity;
}

/** A code for the administrator's factor from a period after the last one used, so no code is presented twice. */
export async function freshCode(W) {
  const wait = (W.adminStep + 1) * 30000 - Date.now();
  if (wait > 0) await sleep(wait + 300);
  const code = await currentCode(W.adminKey);
  W.adminStep = Math.floor(Date.now() / 30000);
  return code;
}

/** The Idempotency-Key of every request a tab sends to a path ending with suffix, as Chrome sent the request. */
export function keysSent(tab, suffix) {
  const keys = [];
  tab.on('Network.requestWillBeSent', (p) => {
    let path;
    try {
      path = new URL(p.request.url).pathname;
    } catch {
      return;
    }
    if (!path.endsWith(suffix)) return;
    const headers = p.request.headers ?? {};
    const name = Object.keys(headers).find((h) => h.toLowerCase() === 'idempotency-key');
    keys.push(name ? headers[name] : null);
  });
  return keys;
}

/** The next answer to a request whose path ends with suffix is lost on its way back: the service has answered (its
    status is returned), and the page sees a network failure. DevTools Fetch interception at the response stage. */
export async function loseNextAnswer(tab, suffix) {
  let done;
  const answered = new Promise((resolve) => {
    done = resolve;
  });
  let used = false;
  tab.on('Fetch.requestPaused', async (p) => {
    if (used) return;
    if (!new URL(p.request.url).pathname.endsWith(suffix)) {
      await tab.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => undefined);
      return;
    }
    used = true;
    await tab.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionReset' }).catch(() => undefined);
    await tab.send('Fetch.disable').catch(() => undefined);
    done({ status: p.responseStatusCode ?? null });
  });
  await tab.send('Fetch.enable', { patterns: [{ urlPattern: `*${suffix}`, requestStage: 'Response' }] });
  return answered;
}

/** Holds the next request of a method whose path ends with suffix before it reaches the service: { held } settles once
    the page has sent it, and release() lets it go on. Every other request continues untouched. The page sees a write in
    flight for as long as it is held. Once released the hold is spent and its listener does nothing, so a later hold on
    the same tab has the paused requests to itself (the tab cannot remove a listener). Moved here from intake.mjs by the
    capture-once lane (evidence/capture-once.md), which holds the E4 and E5 writes with it too. */
export async function holdNext(tab, method, suffix) {
  let requestId = null;
  let spent = false;
  let reached;
  const held = new Promise((resolve) => {
    reached = resolve;
  });
  tab.on('Fetch.requestPaused', async (p) => {
    if (spent || p.responseStatusCode || p.responseErrorReason) return;
    if (requestId !== null || p.request.method !== method || !new URL(p.request.url).pathname.endsWith(suffix)) {
      await tab.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => undefined);
      return;
    }
    requestId = p.requestId;
    reached();
  });
  await tab.send('Fetch.enable', { patterns: [{ urlPattern: `*${suffix}`, requestStage: 'Request' }] });
  return {
    held,
    release: async () => {
      await tab.send('Fetch.continueRequest', { requestId });
      await tab.send('Fetch.disable').catch(() => undefined);
      spent = true;
    },
  };
}

/** A membership removed through the route by the administrator at aal2. */
export async function removeMembership(ctx, W, who) {
  const { call } = await routes(ctx);
  ok(await call('membersRemove', { user: W.aal2(W.users.admin), params: { companyId: W.companyId, membershipId: W.ms[who] } }), 'member removal');
}

/* Owner-side, labelled: the stored bytes changed under the immutability trigger so the current gate refuses them, as
   tests/e4/stack/replay.test.mjs case 21 does. */
export const breakStoredContent = (candidateId) =>
  sql(
    `begin; alter table app.candidate_versions disable trigger candidate_1_immutable; update app.candidate_versions set content = replace(content, '${PROSE}', '${PROSE} Share it at app.phaeacia.ai today.') where id='${candidateId}'; alter table app.candidate_versions enable trigger candidate_1_immutable; commit;`,
  );

/* Owner-side, labelled: a claim aged past the idempotency window, as tests/e4/stack/matrix.test.mjs case 45 ages one. */
export const ageClaim = (membershipId, key) =>
  sql(
    `update app.idempotency_keys set created_at = clock_timestamp() - app.idempotency_window() - interval '1 second' where membership_id='${membershipId}' and key='${key}'`,
  );

/* One authorized download, so a release has a recipient. api.authorize_download under that membership's own server
   bearer since E5 design 2.7 retired tests/db/fixtures/e4-download-seam.sql; the helper's shape is unchanged, so this
   journey's callers are not. */
export const authorizeDownload = (releaseId, membershipId) =>
  e3lib('authorize_download "$1" "$2"', releaseId, membershipId);

/** The text of an element, whitespace collapsed, or null. */
export const textOf = (tab, selector) =>
  tab.evaluate(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? null)?.replace(/\\s+/g, ' ').trim() ?? null`);
export const exists = (tab, selector) => tab.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
