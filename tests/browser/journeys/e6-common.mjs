/* What the E6 journeys share (E6 design sections 4 and 5): one fresh E6 company per run with its accounts, an agent
   owned by one member and published to an audience group, the seeded operator's browser at aal1 and at aal2, and the
   owner-side fixtures design section 5 labels as such. The starting states are made in this process through the route
   functions under sessions minted with the local secret, as tests/e6/stack/ makes them: that is the harness setting
   up, never a page's request, and the universal assertions read only what the pages send. Owner-side steps are the
   ones no route does (aging an access period without running the sweep), each labelled where it is used.

   The accept link is a live first factor for somebody else. It is held in this process's memory for the one navigation
   that uses it, and it is never recorded, logged, written into a check's detail or captured: the harness masks the
   read-only field for every capture and fails the capture if any link value is still on the page. Nothing here prints a
   token, a key or a link. */

import { mintUserToken } from '../../e2/helpers/stack.mjs';
import { linkIn } from '../../e7/mail-catcher.mjs';
import { e3lib, sql } from '../../e3/stack/helpers.mjs';
import { signIn, sleep, startSetup, tag, verifySetup, waitPath } from './common.mjs';
import { approveBoth, envelope, published, routes, submitted } from './e4-common.mjs';

export const OPERATOR_EMAIL = 'synthetic-op@example.invalid';
export const E6_GROUP = 'E6 audience';

/* The company's accounts and their roles; the administrator's membership comes with the company. The E4 helpers this
   reuses name the author, the IT reviewer and the business reviewer, so the E6 world carries the same three names. */
const ROLES = Object.freeze({
  admin: null,
  author: '{it_reviewer,member}',
  it: '{it_reviewer,member}',
  business: '{business_reviewer,member}',
  owner: '{member}',
  heir: '{member}',
  recipient: '{member}',
  leaver: '{member}',
  plain: '{member}',
});

export function ok(r, label) {
  if (r.status < 200 || r.status >= 300) throw new Error(`E6 setup, ${label}: ${r.status} ${String(r.raw).slice(0, 300)}`);
  return r.body;
}

const aal2 = (u) => ({ ...u, token: () => mintUserToken({ sub: u.id, email: u.email, aal: 'aal2', ttl: 3600 }) });

/** The seeded operator as a user object for in-process calls, at a named assurance level. */
export function operatorUser(ctx, aal = 'aal2') {
  const id = ctx.ids.U_op;
  return { who: `operator-${aal}`, id, email: OPERATOR_EMAIL, token: () => mintUserToken({ sub: id, email: OPERATOR_EMAIL, aal, ttl: 3600 }) };
}

/* Owner-side, labelled as design section 5 labels it: no route writes a date in the past, and the point of JL9 is a
   company whose export_by has passed WITHOUT the sweep having run (tests/db/e6-lib.sh age_period, the same SQL). */
export function agePeriod(companyId, endsAgo, exportByAgo, deleteByAgo) {
  sql(`insert into app.access_periods (company_id, starts_at, ends_at, export_by, delete_by)
       values ('${companyId}', clock_timestamp() - interval '${endsAgo}' - interval '1 day',
               clock_timestamp() - interval '${endsAgo}', clock_timestamp() - interval '${exportByAgo}',
               clock_timestamp() - interval '${deleteByAgo}')
       on conflict on constraint access_periods_pkey do update
         set starts_at = excluded.starts_at, ends_at = excluded.ends_at,
             export_by = excluded.export_by, delete_by = excluded.delete_by`);
}

/** The run's E6 company, made once: accounts, memberships, an access period through the operator route, one audience
    group holding the recipient, claude-ai publishable, and one agent owned by `owner` published to that group. */
export async function e6world(ctx) {
  if (ctx.state.e6) return ctx.state.e6;
  const run = tag();
  const users = {};
  for (const who of Object.keys(ROLES)) {
    const email = `e6p-${run}-${who}@example.invalid`;
    const id = e3lib('create_user "$1" "$PW"', email);
    users[who] = { who, id, email, identity: `e6-${who}`, token: () => mintUserToken({ sub: id, email, aal: 'aal1', ttl: 3600 }) };
  }
  const slug = `e6p-${run}`;
  const companyId = e3lib('company "$1" "$2"', slug, users.admin.id);
  const ms = { admin: e3lib('membership_of "$1" "$2"', companyId, users.admin.id) };
  for (const [who, roles] of Object.entries(ROLES)) if (roles) ms[who] = e3lib('member "$1" "$2" "$3"', companyId, users[who].id, roles);
  const { call } = await routes(ctx);
  const op = operatorUser(ctx);
  const day = 86_400_000;
  ok(
    await call('operatorAccessPeriod', {
      user: op,
      params: { companyId },
      body: { startsAt: new Date(Date.now() - day).toISOString(), endsAt: new Date(Date.now() + 56 * day).toISOString(), invoiceRef: `INV-${run}` },
    }),
    'access period',
  );
  const group = ok(await call('groupsCreate', { user: aal2(users.admin), params: { companyId }, body: { name: E6_GROUP } }), 'group');
  ok(
    await call('groupMembersAdd', { user: aal2(users.admin), params: { companyId, groupId: group.groupId, membershipId: ms.recipient } }),
    'group member',
  );
  e3lib('enable_target "$1"', 'claude-ai');
  const companyName = sql(`select name from app.companies where id = '${companyId}'`);
  const W = { run, users, ms, companyId, slug, companyName, groupId: group.groupId, aal2 };
  ctx.state.e6 = W;
  return W;
}

/** A fresh agent owned by `owner` (the author of its first version is `owner` too), published to the E6 group. */
export async function ownedRelease(ctx, W, owner = W.users.owner) {
  const C = await submitted(ctx, W, { author: owner });
  const e = await envelope(ctx, W, C.candidateId, { by: W.users.it, groups: [W.groupId] });
  await approveBoth(ctx, W, C.candidateId, e);
  const releaseId = await published(ctx, W, C.candidateId, e);
  return { ...C, envelopeId: e, releaseId };
}

/** The account's browser signed in once per run through its own link; the identity name. */
export async function signedIn(j, W, who) {
  const u = W.users[who];
  W.signed ??= new Set();
  if (!W.signed.has(who)) {
    const tab = await signIn(j, u.identity, u.email, { label: `sign-in-${who}` });
    await tab.until(async () => (await tab.location().catch(() => ({}))).pathname !== '/signin/', { timeout: 20000, what: 'the signed-in landing' });
    await tab.close().catch(() => undefined);
    W.signed.add(who);
  }
  return u.identity;
}

/** The administrator's browser at aal2: signed in, moved to enrolment by the forced-enrolment rule, and enrolled
    against the real provider, once per run. */
export async function adminAal2(j, W) {
  if (W.adminKey) return W.users.admin.identity;
  const tab = await signIn(j, W.users.admin.identity, W.users.admin.email, { label: 'e6-admin-enrol' });
  await waitPath(tab, '/mfa/');
  await tab.waitForSelector('[data-state="enrol"]');
  const key = await startSetup(tab);
  await verifySetup(tab, key);
  await waitPath(tab, '/members/');
  W.adminKey = key;
  W.signed ??= new Set();
  W.signed.add('admin');
  await tab.close().catch(() => undefined);
  return W.users.admin.identity;
}

/** The operator's browser signed in, at aal1, once per run: the seeded operator belongs to no company and has no factor
    yet, so the sign-in lands on /mfa/'s enrolment by the operator landing rule (HOSTED-F2, evidence/operator-landing.md).
    Before that rule it landed on the home page's no-membership state, design 4.1's accepted consequence. */
export async function operatorAal1(j, ctx) {
  ctx.state.e6op ??= {};
  if (!ctx.state.e6op.signed) {
    const tab = await signIn(j, 'e6-operator', OPERATOR_EMAIL, { label: 'e6-operator-sign-in' });
    await waitPath(tab, '/mfa/');
    await tab.waitForSelector('[data-state="enrol"]');
    await tab.close().catch(() => undefined);
    ctx.state.e6op.signed = true;
  }
  return 'e6-operator';
}

/** The operator's browser at aal2: the register refuses at aal1 and routes to /mfa/, where the operator enrols a
    factor against the real provider; once per run. `onAal1(tab)` sees the refused register first, for its capture. */
export async function operatorAal2(j, ctx, { onAal1 } = {}) {
  await operatorAal1(j, ctx);
  if (ctx.state.e6op.key) return 'e6-operator';
  const tab = await j.tab('e6-operator', 'operator-enrol');
  await tab.navigate(`${j.origin}/operator/`);
  await tab.waitForSelector('[data-state="mfa"]');
  if (onAal1) await onAal1(tab);
  await tab.click('[data-role="mfa-link"]');
  await waitPath(tab, '/mfa/');
  await tab.waitForSelector('[data-state="enrol"]');
  const key = await startSetup(tab);
  await verifySetup(tab, key);
  await tab.until(async () => (await tab.location().catch(() => ({}))).pathname !== '/mfa/', { timeout: 20000, what: 'leaving /mfa/' });
  ctx.state.e6op.key = key;
  return 'e6-operator';
}

/** A request an operator page never sends from this session, sent from the page's own api.mjs so the service's
    refusal is observed rather than the page's (evidence/e4-pages-review.md, E4PW-R-F4's method); status and code. */
export function handBuilt(tab, expression) {
  return tab.evaluate(`import('/assets/app/api.mjs').then(async (api) => { const r = await (${expression}); return { status: r.status, code: r.code ?? null }; })`);
}

export const text = (tab, selector) =>
  tab.evaluate(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? null)?.replace(/\\s+/g, ' ').trim() ?? null`);
export const exists = (tab, selector) => tab.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
export const count = (from, where) => Number(sql(`select count(*) from ${from} where ${where}`));

/** The accept link a handover answer put on the page: read from the one read-only field, held in memory only. */
export const acceptLinkOnPage = (tab, scope = '') =>
  tab.evaluate(`document.querySelector(${JSON.stringify(`${scope} input[data-role="accept-link"]`.trim())})?.value ?? null`);

/** Whether any a element on the page carries a link value, and whether the document's own address does (design 4.3). */
export const linkInAnchors = (tab) =>
  tab.evaluate(`[...document.querySelectorAll('a')].some((a) => /token_hash|[#?&]invite=/.test(a.getAttribute('href') ?? '') || /token_hash|[#?&]invite=/.test(a.href))`);
export const linkInLocation = (tab) => tab.evaluate(`/token_hash|invite/.test(location.href)`);

/** Whether the server is mailing invitations for this step (E7 design 1.1). lib/services/invitations.mjs reads the
    same variable per request, so a journey may set it for its own steps and put it back. */
export const mailMode = () => process.env.ENTERPRISE_INVITATION_DELIVERY === 'mail';

/**
 * acceptLinkFor(j, tab, scope, address) -> the accept link the answer produced, in either delivery mode (E7 1.1).
 * In `handover` it is the value of the page's one read-only field, as E6 wrote it. In `mail` the page has no link at
 * all, so the link comes from the newest message the local catcher recorded for that address, which is the link the
 * person would have received. It takes the journey and not only the tab because the catcher lives on the shell, which
 * the journey's context holds; the address is what picks the message out.
 */
export async function acceptLinkFor(j, tab, scope, address) {
  if (!mailMode()) return acceptLinkOnPage(tab, scope);
  const catcher = j.ctx.shell.mail;
  if (!catcher) throw new Error('acceptLinkFor: the shell has no mail catcher');
  const message = await waitForMail(catcher, address);
  return linkIn(message);
}

/** The newest message to an address, waiting briefly for the send the page's request made. */
export async function waitForMail(catcher, address, { timeout = 10000 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const message = catcher.newestTo(address);
    if (message) return message;
    if (Date.now() > until) throw new Error(`acceptLinkFor: no mail reached the catcher for that address in ${timeout} ms`);
    await sleep(100);
  }
}

/** Accepts an invitation in a fresh browser from its link, pressing the landing's one button; the tab where it lands. */
export async function acceptIn(j, identity, acceptUrl, label) {
  const tab = await j.tab(identity, label);
  await tab.navigate(acceptUrl);
  await tab.waitForSelector('[data-role="accept"], [data-role="accept-as"], [data-role="use-link"]');
  const role = await tab.evaluate(
    `document.querySelector('[data-role="accept"]') ? 'accept' : document.querySelector('[data-role="use-link"]') ? 'use-link' : 'accept-as'`,
  );
  await tab.click(`[data-role="${role}"]`);
  return tab;
}

/** A small company of its own: an administrator, a plain member, and dates through the operator route. */
export async function smallCompany(ctx, name) {
  const run = tag();
  const users = {};
  for (const who of ['admin', 'member']) {
    const email = `e6p-${name}-${run}-${who}@example.invalid`;
    const id = e3lib('create_user "$1" "$PW"', email);
    users[who] = { who, id, email, identity: `e6-${name}-${who}`, token: () => mintUserToken({ sub: id, email, aal: 'aal1', ttl: 3600 }) };
  }
  const slug = `e6p-${name}-${run}`;
  const companyId = e3lib('company "$1" "$2"', slug, users.admin.id);
  const ms = { admin: e3lib('membership_of "$1" "$2"', companyId, users.admin.id), member: e3lib('member "$1" "$2" "$3"', companyId, users.member.id, '{member}') };
  const { call } = await routes(ctx);
  const day = 86_400_000;
  ok(
    await call('operatorAccessPeriod', {
      user: operatorUser(ctx),
      params: { companyId },
      body: { startsAt: new Date(Date.now() - day).toISOString(), endsAt: new Date(Date.now() + 56 * day).toISOString() },
    }),
    'access period',
  );
  return { run, users, ms, companyId, slug, name: sql(`select name from app.companies where id = '${companyId}'`) };
}

/** An administrator of a small company at aal2 in their own browser, through forced enrolment. */
export async function smallAdminAal2(j, C) {
  const tab = await signIn(j, C.users.admin.identity, C.users.admin.email, { label: `${C.users.admin.identity}-enrol` });
  await waitPath(tab, '/mfa/');
  await tab.waitForSelector('[data-state="enrol"]');
  await verifySetup(tab, await startSetup(tab));
  await tab.until(async () => (await tab.location().catch(() => ({}))).pathname !== '/mfa/', { timeout: 20000, what: 'leaving /mfa/' });
  await tab.close().catch(() => undefined);
  return C.users.admin.identity;
}

export { sleep, waitPath };
