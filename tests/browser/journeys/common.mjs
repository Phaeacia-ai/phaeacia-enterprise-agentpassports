/* Helpers shared by the journeys: the seeded addresses, sign-in links from the admin API, waiting for a page, the /api/
   requests of a tab, clicks inside one card, SQL through the migration owner, and fresh synthetic accounts. A link's
   token hash is held in memory for the one navigation that uses it and never written anywhere. */

import { generateLink } from '../../../lib/db/operator.mjs';
import { newAccount, sql } from '../../e2/helpers/pages.mjs';
import { keyFromPage, currentCode } from '../totp.mjs';

export { newAccount, sql };

export const ADDRESS = Object.freeze({
  admin1: 'synthetic-alpha-admin1@example.invalid',
  admin2: 'synthetic-alpha-admin2@example.invalid',
  member: 'synthetic-alpha-member@example.invalid',
  removed: 'synthetic-alpha-removed@example.invalid',
  beta: 'synthetic-beta-member@example.invalid',
  outsider: 'synthetic-outsider@example.invalid',
});

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tag = () => Math.random().toString(16).slice(2, 8);

export async function linkHash(email) {
  const link = await generateLink({ email, type: 'magiclink' });
  if (!link.ok) throw new Error(`the admin API gave no link (status ${link.status})`);
  return link.hashedToken;
}

export const signinLink = (origin, hash) => `${origin}/signin/#token_hash=${hash}&type=magiclink`;

export async function waitPath(page, pathname, { search, timeout = 20000 } = {}) {
  await page.until(
    async () => {
      const l = await page.location().catch(() => null);
      return Boolean(l && l.pathname === pathname && (search === undefined || l.search === search));
    },
    { timeout, what: `${pathname}${search ?? ''}` },
  );
}

/** The /api/ requests of a tab after an index, once every one of them has an answer and its error code is read. */
export async function apiRequests(page, origin, from = 0) {
  const isApi = (r) => {
    try {
      const u = new URL(r.url);
      return u.origin === origin && u.pathname.startsWith('/api/');
    } catch {
      return false;
    }
  };
  await page.until(() => page.requests.slice(from).filter(isApi).every((r) => r.status !== null || r.failed), {
    timeout: 20000,
    what: 'answers to every /api/ request',
  });
  await page.settle();
  return page.requests
    .slice(from)
    .filter(isApi)
    .map((r) => ({ method: r.method, path: new URL(r.url).pathname, status: r.status, code: r.code ?? null, entry: r }));
}

export const line = (x) => `${x.method} ${x.path} ${x.status}${x.code ? ` ${x.code}` : ''}`;

/** Clicks the element of a role inside a scope, once it exists. */
export async function clickIn(page, scope, role) {
  const selector = `${scope} [data-role="${role}"]`;
  await page.waitForSelector(selector);
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

/** Whether the fragment scrub (a same-document history navigation) came before the tab's first /api/ request. */
export function scrubbedFirst(page) {
  const scrub = page.events.findIndex((e) => e.kind === 'navigatedWithinDocument');
  const request = page.events.findIndex((e) => e.kind === 'request' && /\/api\//.test(e.url));
  return scrub !== -1 && (request === -1 || scrub < request);
}

/** Signs an identity in through the sign-in landing and its press, and returns the tab where it lands. `watch` installs
    watchDrawing on the tab before the link is opened. */
export async function signIn(j, identity, email, { label = 'sign-in', watch = false } = {}) {
  const tab = await j.tab(identity, label);
  if (watch) await watchDrawing(tab);
  await tab.navigate(signinLink(j.origin, await linkHash(email)));
  await tab.waitForSelector('[data-role="continue"], [data-role="use-link"]');
  const role = await tab.evaluate(`document.querySelector('[data-role="continue"]') ? 'continue' : 'use-link'`);
  await tab.click(`[data-role="${role}"]`);
  await tab.until(async () => (await tab.location().catch(() => ({ pathname: '/signin/' }))).pathname !== '/signin/', {
    timeout: 20000,
    what: 'leaving the sign-in page',
  });
  return tab;
}

/** On /mfa/ in the enrolment state: starts a setup and returns its key as the page shows it. */
export async function startSetup(tab) {
  await tab.click('[data-role="start-enrolment"]');
  await tab.waitForSelector('[data-role="secret"]');
  return keyFromPage(await tab.evaluate(`document.querySelector('[data-role="secret"]').textContent`));
}

/** Types the current code for a key into the enrolment form and verifies. */
export async function verifySetup(tab, key) {
  await tab.type('#enrol-code', await currentCode(key));
  await tab.click('[data-role="verify-enrolment"]');
}

/** The header's lockup as laid out (UI updates U1): whether "Enterprise" sits wholly below "Phaeacia", and whether
    their left edges agree to within a pixel. null when the page draws no lockup. */
export const lockupShape = (tab) =>
  tab.evaluate(
    `(() => { const m = document.querySelector('#site-header .lockup .mark')?.getBoundingClientRect(); const p = document.querySelector('#site-header .lockup .product')?.getBoundingClientRect(); return m && p ? { stacked: p.top >= m.bottom - 1, leftAligned: Math.abs(p.left - m.left) <= 1 } : null; })()`,
  );

/** The account the header names as signed in (UI updates U2): the account icon's accessible name, "Account, <address>",
    which its tooltip repeats; null when the header draws no account link. The address is no longer header text. */
export const headerAccount = (tab) =>
  tab.evaluate(
    `(() => { const a = document.querySelector('#site-header [data-role="account-link"]'); return a ? { name: a.getAttribute('aria-label'), title: a.title } : null; })()`,
  );
/** Whether the header names this address as signed in, by the icon's name and tooltip alike. */
export const headerNames = async (tab, address) => {
  const a = await headerAccount(tab);
  return a?.name === `Account, ${address}` && a.title === a.name;
};

/** Signs out through the header (UI updates U3): its Sign out opens the confirmation, whose own Sign out sends the
    request. Returns once that press is made; the caller waits for where the page goes. */
export async function signOutThroughHeader(tab) {
  await tab.click('#site-header [data-role="sign-out"]');
  await tab.waitFor(`document.querySelector('[data-role="sign-out-dialog"]')?.open`);
  await tab.click('[data-role="sign-out-dialog"] [data-role="sign-out-confirm"]');
}

/** Waits, up to two seconds, for focus to reach the element of a role. A dialog's close event, on which the page
    returns focus, is queued by close() rather than run inside it, so a read straight after Cancel or Escape can come
    before it (UI-F13, evidence/ui-updates.md). A focus that never arrives is left for the caller's check to report. */
export const focusSettles = (tab, role) =>
  tab.waitFor(`document.activeElement?.dataset.role === ${JSON.stringify(role)}`, { timeout: 2000 }).catch(() => undefined);

/** The corner each box and control draws (UI updates U4): for each selector, the computed top-left radius of the first
    element it finds, read from the pseudo-element named after '::' when there is one; null where the page has none. */
export const cornerOf = (tab, selectors) =>
  tab.evaluate(
    `(() => { const out = {}; for (const s of ${JSON.stringify(selectors)}) { const [sel, pseudo] = s.split('::'); const n = document.querySelector(sel); out[s] = n ? getComputedStyle(n, pseudo ? '::' + pseudo : null).borderTopLeftRadius : null; } return out; })()`,
  );
/** What a corner should read: a pill is the vendored 999px, a multi-line box the 20px of the public app's boxes. */
export const PILL = '999px';
export const BOX = '20px';

/* What the header and main draw, reported once per document in the order it first appears, through the harness's
   binding: the account link, the sign-out button, the operator navigation, and main's text (UI updates U5). Installed
   before any page script of every later document of the tab; it reads the page and changes nothing. */
const DRAWING_OBSERVER = `(() => {
  const report = globalThis.__journeyReport;
  if (typeof report !== 'function') return;
  const seen = new Set();
  const say = (what) => {
    if (seen.has(what)) return;
    seen.add(what);
    report(JSON.stringify({ kind: 'drawn', page: location.pathname, what }));
  };
  const look = () => {
    const header = document.getElementById('site-header');
    const main = document.getElementById('main');
    if (header?.querySelector('[data-role="account-link"]')) say('header: account link');
    if (header?.querySelector('[data-role="sign-out"]')) say('header: sign-out');
    if (header?.querySelector('[data-role="operator-nav"]')) say('header: operator navigation');
    const text = main?.innerText?.trim().replace(/\\s+/g, ' ');
    if (text) say('main: ' + text.slice(0, 70));
  };
  new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true });
})();`;
export const watchDrawing = (tab) => tab.send('Page.addScriptToEvaluateOnNewDocument', { source: DRAWING_OBSERVER });
/** The tab's documents in order since an event index, each with what it drew (watchDrawing). */
export function drawnPerDocument(tab, from = 0) {
  const out = [];
  for (const e of tab.events.slice(from)) {
    if (e.kind === 'frameNavigated') out.push({ document: new URL(e.url).pathname, drew: [] });
    else if (e.kind === 'drawn' && out.length) out.at(-1).drew.push(e.what);
  }
  return out;
}

export const userId = (email) => sql(`select id from auth.users where email = '${email}'`);
export const membershipId = (company, email) =>
  sql(`select m.id from app.memberships m join auth.users u on u.id = m.user_id where m.company_id = '${company}' and u.email = '${email}'`);
export const invitationId = (email) => sql(`select id from app.invitations where email_normalized = '${email}' order by created_at desc limit 1`);
export const auditCount = (action) => Number(sql(`select count(*) from app.audit_events where action = '${action}'`));
