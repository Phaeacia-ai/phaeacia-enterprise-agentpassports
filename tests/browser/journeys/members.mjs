/* J7, J8, J9 and J10 (pages design sections 1, 2.2, 2.3 and 6): member management at aal2, the member view, a foreign
   and a malformed company, and a member removed while the page is open. */

import { psqlSession } from '../../e2/helpers/stack.mjs';
import { ADDRESS, apiRequests, clickIn, invitationId, line, membershipId, sleep, tag, waitPath } from './common.mjs';

const ADMIN_CONTROLS =
  '[data-role="change-roles"], [data-role="remove"], [data-role="invite-form"], [data-role="revoke"], [data-role="invite-again"], [data-role="step-up-panel"]';

async function openMembers(j, identity, label, company, ready = '[data-role="members"]') {
  const tab = await j.tab(identity, label);
  await tab.navigate(`${j.origin}/members/?company=${company}`);
  await tab.waitForSelector(ready);
  return tab;
}

const card = (id) => `[data-membership="${id}"]`;
const rolesOf = (tab, id) => tab.evaluate(`document.querySelector('${card(id)} [data-role="roles"]')?.textContent ?? null`);

async function saveRoles(tab, id, change) {
  await clickIn(tab, card(id), 'change-roles');
  await tab.waitForSelector(`${card(id)} [data-role="roles-editor"]`);
  for (const [role, checked] of Object.entries(change))
    await tab.evaluate(`(() => { const box = document.querySelector('${card(id)} input[value="${role}"]'); if (box.checked !== ${checked}) box.click(); })()`);
  await clickIn(tab, card(id), 'save-roles');
}

export async function j7(ctx, j) {
  const alpha = ctx.ids.ALPHA;
  const tab = await openMembers(j, 'admin1', 'manage', alpha, '[data-role="invite-form"]');
  await j.cookies(tab, 2, 'an administrator at aal2');
  await j.capture(tab, 'list');

  await tab.type('#invite-email', 'not-an-address');
  await tab.click('[data-role="send-invitation"]');
  await tab.waitForSelector('[data-role="invite-status"] [data-code="E_EMAIL_INVALID"]');
  j.check('an invitation to a malformed address shows E_EMAIL_INVALID', (await tab.text()).includes('Email address is not valid.'));
  await j.capture(tab, 'invite-error');

  const address = `pages-j7-${tag()}@example.invalid`;
  await tab.type('#invite-email', address);
  await tab.click('[data-role="send-invitation"]');
  await tab.waitForSelector('[data-state="invited"]');
  const pending = invitationId(address);
  await tab.waitForSelector(`[data-group="pending"] [data-invitation="${pending}"]`);
  j.check('a valid invitation appears as pending', true);
  await clickIn(tab, `[data-invitation="${pending}"]`, 'revoke');
  await tab.waitForSelector(`[data-group="revoked"] [data-invitation="${pending}"]`);
  j.check('revoking moves it to revoked', true);

  const member = membershipId(alpha, ADDRESS.member);
  await saveRoles(tab, member, { it_reviewer: true });
  await tab.waitFor(`document.querySelector('${card(member)} [data-role="roles"]')?.textContent.includes('IT reviewer')`);
  j.check('it_reviewer added to a member', (await rolesOf(tab, member)).includes('IT reviewer'));

  const other = ctx.state.j4Other?.email;
  if (other) {
    const removed = membershipId(alpha, other);
    await clickIn(tab, card(removed), 'remove');
    await tab.waitForSelector(`${card(removed)} [data-role="confirm-remove"]`);
    j.check('removal asks for an in-page confirmation first', true);
    await j.capture(tab, 'confirm-remove');
    await clickIn(tab, card(removed), 'confirm-removal');
    await tab.waitForSelector(`[data-role="former-members"] ${card(removed)}`);
    j.check('the removed member moves to former members', true);
  } else j.check('a member to remove exists (J4 invited one)', false, 'J4 did not leave ctx.state.j4Other');

  const admin2 = membershipId(alpha, ADDRESS.admin2);
  const self = membershipId(alpha, ADDRESS.admin1);
  await saveRoles(tab, admin2, { company_admin: false });
  await tab.waitFor(`!document.querySelector('${card(admin2)} [data-role="roles"]')?.textContent.includes('Administrator')`);
  await saveRoles(tab, self, { company_admin: false });
  await tab.waitForSelector(`${card(self)} [data-code="E_LAST_ADMIN"]`);
  j.check('demoting the last administrator shows E_LAST_ADMIN', (await tab.text()).includes('A company keeps at least one administrator.'));
  await j.capture(tab, 'last-admin');
  await tab.navigate(`${j.origin}/members/?company=${alpha}`);
  await tab.waitForSelector('[data-role="invite-form"]');
  await saveRoles(tab, admin2, { company_admin: true });
  await tab.waitFor(`document.querySelector('${card(admin2)} [data-role="roles"]')?.textContent.includes('Administrator')`);
  j.check('the second administrator is restored', true);

  const holder = psqlSession();
  let heldFor = 0;
  try {
    holder.write('begin;');
    holder.write(`select id from app.companies where id='${alpha}' for no key update;`);
    await sleep(500);
    const t0 = Date.now();
    await saveRoles(tab, member, { business_reviewer: true });
    await tab.waitForSelector(`${card(member)} [data-code="E_BUSY"]`, { timeout: 9000 });
    j.check("the held company lock shows E_BUSY with the server's message and a retry", (await tab.evaluate(`Boolean(document.querySelector('${card(member)} [data-role="retry"]'))`)));
    heldFor = Date.now() - t0;
    await j.capture(tab, 'busy');
    await sleep(Math.max(0, 6000 - (Date.now() - t0)));
  } finally {
    holder.write('commit;');
    await holder.end();
  }
  j.record('milliseconds from the Save roles press to the E_BUSY state', heldFor);
  await clickIn(tab, card(member), 'retry');
  await tab.waitFor(`document.querySelector('${card(member)} [data-role="roles"]')?.textContent.includes('Business reviewer')`);
  j.check('the retry after the release succeeds', (await rolesOf(tab, member)).includes('Business reviewer'));
}

export async function j8(ctx, j) {
  const tab = await openMembers(j, 'member', 'member-view', ctx.ids.ALPHA);
  j.check('own roles and the read-only list', (await tab.text()).includes('Your roles: Member'));
  const api = await apiRequests(tab, j.origin);
  j.equal('no /invitations request in the log', api.filter((x) => x.path.endsWith('/invitations')).length, 0);
  j.check('no administrator control in the DOM', await tab.evaluate(`!document.querySelector(${JSON.stringify(ADMIN_CONTROLS)})`));
  j.check(
    'no address outside the own row',
    await tab.evaluate(`[...document.querySelectorAll('[data-role="members"] .card, [data-role="former-members"] .card')].filter((c) => !c.querySelector('[data-label="self"]')).every((c) => !c.innerText.includes('@'))`),
  );
  await j.cookies(tab, 2, 'a member');
  await j.capture(tab, 'member-view');
}

export async function j9(ctx, j) {
  const tab = await openMembers(j, 'admin1', 'foreign', ctx.ids.BETA, '[data-state="not-found"]');
  const foreign = (await apiRequests(tab, j.origin)).filter((x) => x.path.includes('/companies/'));
  j.equal('the beta member list answers 404', foreign.map(line), [`GET /api/companies/${ctx.ids.BETA}/members 404 E_NOT_FOUND`]);
  j.check('the 404 body contains no beta id', foreign.every((x) => !(x.entry.errorText ?? '').includes(ctx.ids.BETA)), foreign.map((x) => x.entry.errorText));
  const shown = await tab.evaluate('document.body.innerText');
  j.check('nothing of beta is rendered', !shown.includes('Beta') && !shown.includes(ctx.ids.BETA));
  await j.capture(tab, 'not-found');

  const malformed = await j.tab('admin1', 'malformed', { landingOutsideSet: true });
  await malformed.navigate(`${j.origin}/members/?company=not-a-uuid`);
  await malformed.waitForSelector('[data-state="not-found"]');
  j.equal('a malformed id answers 404 and the not-found state', (await apiRequests(malformed, j.origin)).filter((x) => x.path.includes('/companies/')).map(line), ['GET /api/companies/not-a-uuid/members 404 E_NOT_FOUND']);
}

export async function j10(ctx, j) {
  const invitee = ctx.state.j4Invitee;
  if (!invitee) return j.check('a member to remove exists (J4 accepted one)', false, 'J4 did not leave ctx.state.j4Invitee');
  const alpha = ctx.ids.ALPHA;
  const open = await openMembers(j, invitee.identity, 'open-list', alpha);
  const id = membershipId(alpha, invitee.email);
  const admin = await openMembers(j, 'admin1', 'remove', alpha, '[data-role="invite-form"]');
  await clickIn(admin, card(id), 'remove');
  await clickIn(admin, card(id), 'confirm-removal');
  await admin.waitForSelector(`[data-role="former-members"] ${card(id)}`);

  const from = open.requests.length;
  await open.click('[data-role="reload"]');
  await open.waitForSelector('[data-state="not-found"]');
  const reload = await apiRequests(open, j.origin, from);
  j.equal('the removed member presses Reload: the member list answers 404', reload.filter((x) => x.path.endsWith('/members')).map((x) => x.status), [404]);
  j.check('the list is discarded and the not-found state shown', await open.evaluate(`!document.querySelector('[data-role="members"]')`));
  await j.capture(open, 'after-removal');

  const me = reload.find((x) => x.path === '/api/me' && x.status === 200);
  const identity = me ? await open.responseJson(me.entry) : null;
  j.check("the same cookie's GET /api/me no longer lists alpha", identity && !identity.memberships.some((m) => m.companyId === alpha), identity?.memberships?.length);
  const home = await j.tab(invitee.identity, 'home');
  await home.navigate(`${j.origin}/`);
  await home.waitForSelector('[data-state="no-membership"]');
  j.check('home shows no active membership for that account', true);
  await waitPath(home, '/');
}
