/* J4, J4b and J18 (pages design sections 1, 2.1, 2.2 and 6): an invitation accepted by a new profile, accepted through
   "Use this link instead", refused as a mismatch and recovered, and a display name set and seen. */

import {
  ADDRESS,
  apiRequests,
  auditCount,
  headerNames,
  invitationId,
  line,
  membershipId,
  scrubbedFirst,
  signIn,
  sleep,
  sql,
  tag,
  userId,
  waitPath,
} from './common.mjs';

async function membersOf(j, identity, label, company, ready = '[data-role="members"]') {
  const tab = await j.tab(identity, label);
  await tab.navigate(`${j.origin}/members/?company=${company}`);
  await tab.waitForSelector(ready);
  return tab;
}

/** Invites an address from an administrator's members tab and returns the accept URL, held in memory.

    Changed by the E6 pages lane under the lead's grant (2026-09-18): handover is the product's delivery since E6
    (design 1.2; ENTERPRISE_INVITATION_DELIVERY unset is handover), so the service returns the link to the page that made
    the invitation and mails nothing, and the dev shell's mail capture stays empty. The link is read from the members
    page's one read-only field, which is the path an administrator takes. Before: the link was read from
    ctx.shell.mail. The mail path itself stays covered by tests/e2/stack/pages-reads.test.mjs and handlers.test.mjs,
    which pin ENTERPRISE_INVITATION_DELIVERY=mail. */
async function invite(ctx, admin, address) {
  await admin.type('#invite-email', address);
  await admin.click('[data-role="send-invitation"]');
  await admin.waitForSelector('[data-state="invited"]');
  await admin.waitForSelector(`[data-group="pending"] [data-invitation="${invitationId(address)}"]`);
  const acceptUrl = await admin.evaluate(`document.querySelector('input[data-role="accept-link"]')?.value ?? null`);
  if (!acceptUrl) throw new Error('the members page showed no accept link for the new address');
  return acceptUrl;
}

export async function j4(ctx, j) {
  const alpha = ctx.ids.ALPHA;
  const admin = await membersOf(j, 'admin1', 'invite', alpha, '[data-role="invite-form"]');
  const invitee = `pages-j4-${tag()}@example.invalid`;
  const acceptUrl = await invite(ctx, admin, invitee);
  j.check('an administrator at aal2 invites a new address from the members page, and it appears as pending', true);
  const parsed = new URL(acceptUrl);
  j.check('the captured accept URL carries its values in the fragment and none in the query', parsed.search === '' && parsed.hash.length > 1);
  const audits = auditCount('invitation.accept');

  const tab = await j.tab('j4-invitee', 'landing');
  await j.cookies(tab, 0, 'a new profile with no cookies');
  await tab.navigate(acceptUrl);
  await sleep(3000);
  const landing = await apiRequests(tab, j.origin);
  j.equal(
    'one GET /api/me 401, one refresh 401, no second read, no verification and no other post',
    landing.map(line),
    ['GET /api/me 401 E_UNAUTHENTICATED', 'POST /api/auth/refresh 401 E_AUTH_INVALID'],
  );
  j.equal('zero navigations after the landing', tab.documents.length, 1);
  const where = await tab.location();
  j.equal('the document is still /accept and location.hash is empty', [where.pathname, where.hash], ['/accept', '']);
  j.check('the fragment left the address bar before the first request', scrubbedFirst(tab));
  j.check('Accept is present', await tab.evaluate(`Boolean(document.querySelector('[data-role="accept"]'))`));
  await j.capture(tab, 'landing');

  const from = tab.requests.length;
  await tab.click('[data-role="accept"]');
  await waitPath(tab, '/members/', { search: `?company=${alpha}` });
  await tab.waitForSelector('[data-role="members"]');
  const pressed = await apiRequests(tab, j.origin, from);
  j.equal('the press verifies, then accepts', pressed.slice(0, 2).map(line), ['POST /api/auth/verify 204', 'POST /api/invitations/accept 200']);
  j.check('it lands on the members page as a member', (await tab.text()).includes('Your roles: Member'));
  await j.cookies(tab, 2, 'the invitee signed in');
  j.equal('the audit log gained one invitation.accept', auditCount('invitation.accept'), audits + 1);
  await j.capture(tab, 'accepted');
  ctx.state.j4Invitee = { identity: 'j4-invitee', email: invitee };

  const other = `pages-j4-other-${tag()}@example.invalid`;
  const otherUrl = await invite(ctx, admin, other);
  const outsider = await signIn(j, 'j4-other', ADDRESS.outsider, { label: 'signed-in-elsewhere' });
  await outsider.waitForSelector('[data-state="no-membership"]');
  const choice = await j.tab('j4-other', 'use-link');
  await choice.navigate(otherUrl);
  await choice.waitForSelector('[data-role="use-link"]');
  j.check(
    'signed in as another account, the landing shows that address and both choices',
    (await choice.text()).includes(ADDRESS.outsider) && (await choice.evaluate(`Boolean(document.querySelector('[data-role="accept-as"]'))`)),
  );
  await choice.click('[data-role="use-link"]');
  await waitPath(choice, '/members/', { search: `?company=${alpha}` });
  await choice.waitForSelector('[data-role="members"]');
  j.check('"Use this link instead" reaches its own success: the header shows the invited address', await headerNames(choice, other));
  ctx.state.j4Other = { identity: 'j4-other', email: other };

  const consumed = await j.tab('j4-other', 'consumed-link');
  await consumed.navigate(acceptUrl);
  await consumed.waitForSelector('[data-role="use-link"]');
  const at = consumed.requests.length;
  await consumed.click('[data-role="use-link"]');
  await consumed.waitForSelector('[data-state="signed-in-choice"] [data-code="E_AUTH_INVALID"]');
  const refused = (await apiRequests(consumed, j.origin, at)).find((x) => x.path === '/api/auth/verify');
  j.equal(
    'a failed verification answers 401 E_AUTH_INVALID and its answer sets no cookie',
    [refused?.status, refused?.code, refused?.entry.setCookieNames ?? []],
    [401, 'E_AUTH_INVALID', []],
  );
  j.check("the current account's session is unchanged: discovery answers the same address again", (await consumed.text()).includes(other));
  await j.cookies(consumed, 2, 'unchanged after the failed verification');
}

export async function j4b(ctx, j) {
  const alpha = ctx.ids.ALPHA;
  const admin = await membersOf(j, 'admin1', 'invite', alpha, '[data-role="invite-form"]');
  const address = `pages-j4b-${tag()}@example.invalid`;
  const url = await invite(ctx, admin, address);
  const current = await signIn(j, 'j4b', ADDRESS.removed, { label: 'someone-else' });
  await current.waitForSelector('[data-state="no-membership"]');

  const tab = await j.tab('j4b', 'landing');
  await tab.navigate(url);
  await tab.waitForSelector('[data-role="accept-as"]');
  j.check(
    'the landing shows the current address and both choices',
    (await tab.text()).includes(ADDRESS.removed) && (await tab.evaluate(`Boolean(document.querySelector('[data-role="use-link"]'))`)),
  );
  await j.capture(tab, 'choice');
  const at = tab.requests.length;
  await tab.click('[data-role="accept-as"]');
  await tab.waitForSelector('[data-code="E_EMAIL_MISMATCH"]');
  j.equal('"Accept as" the current account answers 403 E_EMAIL_MISMATCH', (await apiRequests(tab, j.origin, at)).map(line), ['POST /api/invitations/accept 403 E_EMAIL_MISMATCH']);
  j.check('the mismatch offers a sign-out action', await tab.evaluate(`Boolean(document.querySelector('[data-role="mismatch-sign-out"]'))`));
  await j.capture(tab, 'mismatch');

  await tab.click('[data-role="mismatch-sign-out"]');
  await tab.waitForSelector('[data-state="signed-out-landing"] [data-role="accept"]');
  await j.cookies(tab, 0, 'signed out on this device, the invitation still on the page');
  await tab.click('[data-role="accept"]');
  await waitPath(tab, '/members/', { search: `?company=${alpha}` });
  await tab.waitForSelector('[data-role="members"]');
  j.check('after the sign-out action the invitation is accepted with its own link', await headerNames(tab, address));
}

export async function j18(ctx, j) {
  const invitee = ctx.state.j4Invitee;
  if (!invitee) return j.check('a member whose membership came from an accepted invitation exists (J4)', false, 'J4 left none');
  const alpha = ctx.ids.ALPHA;
  const inviteeId = userId(invitee.email);
  const card = `[data-membership="${membershipId(alpha, invitee.email)}"]`;

  const account = await j.tab(invitee.identity, 'account');
  const saveName = async (value) => {
    await account.navigate(`${j.origin}/account/`);
    await account.waitForSelector('[data-role="name-form"]');
    const at = account.requests.length;
    await account.type('#display-name', value);
    await account.click('[data-role="save-name"]');
    await account.waitForSelector('[data-state="name-saved"], [data-role="name-status"] [data-code]');
    return apiRequests(account, j.origin, at);
  };

  const name = 'Ada Example';
  const saved = await saveName(name);
  j.equal('one PUT /api/me/display-name answering 204', saved.filter((x) => x.path === '/api/me/display-name').map(line), ['PUT /api/me/display-name 204']);
  j.equal('the page shows the stored name', await account.evaluate(`document.querySelector('[data-role="stored-name"]')?.textContent ?? null`), name);
  j.check('the stored name is rendered in a bdi element', await account.evaluate(`document.querySelector('[data-role="stored-name"]')?.tagName === 'BDI'`));
  j.equal('the database holds that name', sql(`select display_name from app.profiles where user_id = '${inviteeId}'`), name);
  await j.capture(account, 'account-with-name');

  const member = await membersOf(j, 'member', 'members-as-member', alpha);
  const memberList = (await apiRequests(member, j.origin)).find((x) => x.path.endsWith('/members') && x.status === 200);
  const memberBody = await member.responseJson(memberList.entry);
  j.equal('the member view: the answer labels the row display_name', memberBody.members.find((m) => m.userId === inviteeId)?.label, { kind: 'display_name', value: name });
  j.equal(
    "the member view: no @ outside the viewer's own self row",
    memberBody.members.filter((m) => m.membershipId !== memberBody.viewer.membershipId && JSON.stringify(m).includes('@')).length,
    0,
  );
  j.check('the member view: the row shows the name inside a bdi element', await member.evaluate(`document.querySelector('${card} [data-label="display_name"] bdi')?.textContent === ${JSON.stringify(name)}`));
  j.equal('the member view: no /invitations request', (await apiRequests(member, j.origin)).filter((x) => x.path.endsWith('/invitations')).length, 0);
  await j.capture(member, 'members-as-member');

  const admin = await membersOf(j, 'admin1', 'members-as-admin', alpha, '[data-role="invite-form"]');
  const adminList = (await apiRequests(admin, j.origin)).find((x) => x.path.endsWith('/members') && x.status === 200);
  const adminBody = await admin.responseJson(adminList.entry);
  j.equal('an administrator at aal2 gets the row labelled with the name, not the address', adminBody.members.find((m) => m.userId === inviteeId)?.label, { kind: 'display_name', value: name });
  j.check(
    'and the administrator page shows the name and not the address on that row',
    await admin.evaluate(`(() => { const c = document.querySelector('${card}'); return c.innerText.includes(${JSON.stringify(name)}) && !c.innerText.includes(${JSON.stringify(invitee.email)}); })()`),
  );
  await j.capture(admin, 'members-as-admin');

  const rtl = 'שלום Ada';
  await saveName(rtl);
  const rtlView = await membersOf(j, 'member', 'rtl-name', alpha);
  j.equal('beside a right-to-left name, the roles line keeps its own text', await rtlView.evaluate(`document.querySelector('${card} [data-role="roles"]').textContent`), 'Member');
  j.equal('the right-to-left name is isolated in its bdi element', await rtlView.evaluate(`document.querySelector('${card} bdi').textContent`), rtl);
  await j.capture(rtlView, 'rtl-name');

  const long = 'Maximiliane Alexandra Hohenzollern-Sigmaringen von und zu Liechtenstein-Vaduz und Werdenberg';
  await saveName(long);
  await j.capture(account, 'account-long-name');

  const refused = await saveName('x'.repeat(121));
  j.equal('a 121-character name answers 422 E_BODY_INVALID', refused.filter((x) => x.path === '/api/me/display-name').map(line), ['PUT /api/me/display-name 422 E_BODY_INVALID']);
  j.check("the page shows the server's message", (await account.text()).includes('The request is not valid.'));
  await j.capture(account, 'refused-name');
}
