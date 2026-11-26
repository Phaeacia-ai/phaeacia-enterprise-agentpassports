/* J11 and J12 (pages design sections 2.4, 2.5, 2.9, 3 rule 6 and 6): refresh on an expired access cookie, two calls and
   two tabs sharing it, the step-up boundary for a pre-step-up refresh cookie, and sign-out ending this device only.
   Since UI updates U3 (evidence/ui-updates.md) the header's Sign out asks in a modal dialog first: J12 opens it at phone
   width, reads its corners (U4), closes it with Cancel and with Escape, and signs out through its own button.
   The J11 boundary arm is asserted, not recorded: under legacy sessions 2.9 predicts it fails, and a failure here is
   that finding observed in a browser, not a defect to work around. */

import { PHONE } from '../cdp.mjs';
import { ADDRESS, apiRequests, BOX, cornerOf, focusSettles, line, newAccount, PILL, signIn, signOutThroughHeader, sleep, sql, startSetup, verifySetup, waitPath } from './common.mjs';

async function membersTab(j, identity, label, company) {
  const tab = await j.tab(identity, label);
  await tab.navigate(`${j.origin}/members/?company=${company}`);
  await tab.waitForSelector('[data-role="members"]');
  return tab;
}

const expired = async (tab) => {
  const l = await tab.location().catch(() => ({}));
  return l.pathname === '/signin/' && l.search === '?reason=expired';
};

export async function j11(ctx, j) {
  const alpha = ctx.ids.ALPHA;
  const tab = await membersTab(j, 'member', 'expiry', alpha);
  await tab.deleteCookie('enterprise_access', j.origin);
  await j.cookies(tab, 1, 'the access cookie deleted');
  let from = tab.requests.length;
  await tab.click('[data-role="reload"]');
  await tab.until(async () => (await apiRequests(tab, j.origin, from)).filter((x) => x.status === 200).length >= 2, { timeout: 20000, what: 'the repeated calls' });
  await sleep(500);
  const reload = await apiRequests(tab, j.origin, from);
  j.equal('the next action causes exactly one refresh, and it answers 204', reload.filter((x) => x.path === '/api/auth/refresh').map((x) => x.status), [204]);
  const statuses = (path) => reload.filter((x) => x.path === path).map((x) => x.status);
  j.equal(
    'two calls fired together share that one refresh, and each repeat succeeds',
    [statuses('/api/me'), statuses(`/api/companies/${alpha}/members`)],
    [
      [401, 200],
      [401, 200],
    ],
  );
  await j.cookies(tab, 2, 'after the refresh');

  const second = await membersTab(j, 'member', 'second-tab', alpha);
  const sessions = () => Number(sql(`select count(*) from auth.sessions where user_id = '${ctx.ids.U_alpha_member}'`));
  const before = sessions();
  await tab.deleteCookie('enterprise_access', j.origin);
  const f1 = tab.requests.length;
  const f2 = second.requests.length;
  await Promise.all([tab.click('[data-role="reload"]'), second.click('[data-role="reload"]')]);
  await sleep(4000);
  const r1 = await apiRequests(tab, j.origin, f1);
  const r2 = await apiRequests(second, j.origin, f2);
  j.record('the refreshes each tab sent, by status', [r1, r2].map((r) => r.filter((x) => x.path === '/api/auth/refresh').map((x) => x.status)));
  const signedIn = async (t) => (await t.location()).pathname === '/members/' && (await t.evaluate(`Boolean(document.querySelector('[data-role="members"]'))`));
  j.check('two tabs of the same profile refreshing at once both end signed in', (await signedIn(tab)) && (await signedIn(second)), [r1.map(line), r2.map(line)]);
  j.equal('with one session', sessions(), before);
  await j.cookies(second, 2, 'both tabs signed in');

  const stepped = await signIn(j, 'j11-stepup', ADDRESS.admin2, { label: 'step-up' });
  await waitPath(stepped, '/mfa/');
  await stepped.waitForSelector('[data-state="enrol"]');
  const captured = await stepped.captureCookies(j.origin);
  const key = await startSetup(stepped);
  await verifySetup(stepped, key);
  await waitPath(stepped, '/members/');
  await stepped.waitForSelector('[data-role="invite-form"]');
  ctx.state.admin2Key = key;

  const restored = await j.tab('j11-restored', 'restored');
  await restored.restoreCookies(captured);
  await restored.deleteCookie('enterprise_access', j.origin);
  await j.cookies(restored, 1, 'the pre-step-up refresh cookie alone, restored after the step-up');
  await restored.navigate(`${j.origin}/account/`);
  await sleep(4000);
  const answers = await apiRequests(restored, j.origin);
  const aals = [];
  /* A body of an earlier document may already be gone; that is recorded as unreadable, never as an answer. */
  for (const x of answers.filter((a) => a.path === '/api/me' && a.status === 200))
    aals.push(await restored.responseJson(x.entry).then((b) => b.user.aal, () => 'unreadable'));
  j.record('restored tab: every /api/ answer', answers.map(line));
  j.record('restored tab: the aal of each GET /api/me that answered 200', aals);
  j.check('asserted: the restored pre-step-up tab reaches /signin/?reason=expired', await expired(restored), { location: await restored.location(), answers: answers.map(line) });
  j.check('asserted: GET /api/me with the restored cookies never answers aal2', !aals.includes('aal2'), aals);

  from = stepped.requests.length;
  await stepped.deleteCookie('enterprise_access', j.origin);
  await stepped.navigate(`${j.origin}/account/`);
  await sleep(4000);
  const next = await apiRequests(stepped, j.origin, from);
  j.record('stepped-up tab at its next refresh: every /api/ answer', next.map(line));
  j.check('asserted: the stepped-up tab also reaches /signin/?reason=expired at its explicit next refresh', await expired(stepped), { location: await stepped.location(), answers: next.map(line) });

  const bare = await membersTab(j, 'member', 'no-cookies', alpha);
  await bare.deleteCookie('enterprise_access', j.origin);
  await bare.deleteCookie('enterprise_refresh', j.origin);
  await j.cookies(bare, 0, 'both cookies deleted');
  from = bare.requests.length;
  await bare.click('[data-role="reload"]');
  await waitPath(bare, '/signin/', { search: '?reason=expired' });
  j.equal('with both cookies deleted the refresh answers 401 and the page reaches /signin/?reason=expired', (await apiRequests(bare, j.origin, from)).filter((x) => x.path === '/api/auth/refresh').map((x) => x.status), [401]);
  await bare.waitForSelector('[data-state="reason-expired"]');
  await j.capture(bare, 'expired-notice');
}

export async function j12(ctx, j) {
  const alpha = ctx.ids.ALPHA;
  const account = newAccount('j12');
  sql(`insert into app.memberships (company_id, user_id, roles) values ('${alpha}', '${account.id}', '{member}')`);
  const signedInOnList = async (identity, label) => {
    const tab = await signIn(j, identity, account.email, { label });
    await waitPath(tab, '/members/');
    await tab.waitForSelector('[data-role="members"]');
    return tab;
  };
  const survives = async (tab, label) => {
    await tab.deleteCookie('enterprise_access', j.origin);
    const from = tab.requests.length;
    await tab.click('[data-role="reload"]');
    await tab.until(async () => (await apiRequests(tab, j.origin, from)).some((x) => x.path.endsWith('/members') && x.status !== null), { timeout: 20000, what: 'the reload' });
    const r = await apiRequests(tab, j.origin, from);
    j.check(
      `${label}: the untouched second profile refreshes (204) and GET /api/me answers 200`,
      r.some((x) => x.path === '/api/auth/refresh' && x.status === 204) && r.some((x) => x.path === '/api/me' && x.status === 200),
      r.map(line),
    );
  };
  const signOutAnswer = (mark) => ctx.shell.record.slice(mark).find((e) => e.path === '/api/auth/signout');

  const a = await signedInOnList('j12-a', 'arm-1');
  const b = await signedInOnList('j12-b', 'second-profile');
  await a.deleteCookie('enterprise_access', j.origin);
  await j.cookies(a, 1, 'arm 1: the refresh cookie alone before the press');
  let mark = ctx.shell.record.length;
  /* UI updates U3 (evidence/ui-updates.md): the header's Sign out asks first, in a modal dialog that fits a phone.
     Opening it, Cancel and Escape send nothing and give focus back to the header's button; only the dialog's own Sign
     out sends the request, which arm 1 then follows as before. */
  const dialogState = () =>
    a.evaluate(
      `(() => { const d = document.querySelector('[data-role="sign-out-dialog"]'); const r = d.getBoundingClientRect(); return { open: d.open, modal: d.matches(':modal'), focus: document.activeElement?.dataset.role ?? null, fits: r.left >= 0 && r.right <= innerWidth && r.width > 0 === d.open }; })()`,
    );
  const openDialog = async () => {
    await a.click('#site-header [data-role="sign-out"]');
    await a.waitFor(`document.querySelector('[data-role="sign-out-dialog"]')?.open`);
  };
  await a.setViewport(PHONE);
  await openDialog();
  const opened = await dialogState();
  j.equal(
    'UI updates U4: the dialog has the 20-pixel corner and its two buttons are pills',
    await cornerOf(a, ['[data-role="sign-out-dialog"]', '[data-role="sign-out-confirm"]', '[data-role="sign-out-cancel"]']),
    { '[data-role="sign-out-dialog"]': BOX, '[data-role="sign-out-confirm"]': PILL, '[data-role="sign-out-cancel"]': PILL },
  );
  await j.capture(a, 'sign-out-dialog');
  await a.click('[data-role="sign-out-dialog"] [data-role="sign-out-cancel"]');
  await focusSettles(a, 'sign-out');
  const cancelled = await dialogState();
  await openDialog();
  for (const type of ['keyDown', 'keyUp']) await a.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await a.waitFor(`!document.querySelector('[data-role="sign-out-dialog"]').open`);
  await focusSettles(a, 'sign-out');
  const escaped = await dialogState();
  j.equal(
    'the header Sign out opens a modal dialog that fits the phone; Cancel and Escape close it, send nothing and return focus to the header button',
    { opened, cancelled, escaped, sent: signOutAnswer(mark) ?? null, path: (await a.location()).pathname },
    {
      opened: { open: true, modal: true, focus: 'sign-out-cancel', fits: true },
      cancelled: { open: false, modal: false, focus: 'sign-out', fits: true },
      escaped: { open: false, modal: false, focus: 'sign-out', fits: true },
      sent: null,
      path: '/members/',
    },
  );
  await signOutThroughHeader(a);
  await waitPath(a, '/signin/', { search: '?reason=signed-out' });
  const out1 = signOutAnswer(mark);
  j.equal('arm 1: sign-out answers 204 and its request made zero provider calls', [out1?.status, out1?.provider], [204, []]);
  await j.cookies(a, 0, 'arm 1: after sign-out');
  j.check('the confirmation reads "Signed out on this device."', (await a.text()).includes('Signed out on this device.'));
  await j.capture(a, 'signed-out');
  await survives(b, 'arm 1');

  let shows = a.pageshows.length;
  await a.back();
  await waitPath(a, '/signin/', { search: '?reason=expired' });
  j.record('arm 1, back: pageshow events on /members/', a.pageshows.slice(shows).filter((p) => p.page === '/members/'));
  j.check('back to the members page shows no member data and ends at sign-in', await a.evaluate(`!document.querySelector('[data-role="members"]')`));
  await j.capture(a, 'after-back');
  let from = a.requests.length;
  await a.navigate(`${j.origin}/members/?company=${alpha}`);
  await waitPath(a, '/signin/', { search: '?reason=expired' });
  await a.back();
  await waitPath(a, '/signin/', { search: '?reason=expired' });
  j.equal(
    'an ordinary load and a history reload of the members page read no member list and end at sign-in',
    (await apiRequests(a, j.origin, from)).filter((x) => x.path.endsWith('/members')).length,
    0,
  );

  const c = await signedInOnList('j12-c', 'arm-2');
  const captured = await c.captureCookies(j.origin);
  mark = ctx.shell.record.length;
  await signOutThroughHeader(c);
  await waitPath(c, '/signin/', { search: '?reason=signed-out' });
  const out2 = signOutAnswer(mark);
  j.check('arm 2: sign-out answers 204 after its provider logout ran', out2?.status === 204 && out2.provider.includes('POST /auth/v1/logout'), out2);
  await j.cookies(c, 0, 'arm 2: after sign-out');

  shows = c.pageshows.length;
  const refusals = c.bfcacheRefusals.length;
  await c.back();
  await waitPath(c, '/signin/', { search: '?reason=expired' });
  const restoredFromCache = c.pageshows.slice(shows).some((p) => p.page === '/members/' && p.persisted);
  j.record('arm 2, back: restored from the back-forward cache, and any refusal Chrome reported', { restoredFromCache, refusals: c.bfcacheRefusals.slice(refusals) });
  j.check('a back-forward cache restore (pageshow with persisted) happened', restoredFromCache, c.bfcacheRefusals.slice(refusals));
  j.check('after that restore: no member data, and the page ends at sign-in', await c.evaluate(`!document.querySelector('[data-role="members"]')`));
  await j.capture(c, 'after-bfcache-restore');

  await survives(b, 'arm 2 (i)');

  await c.restoreCookies(captured);
  await c.deleteCookie('enterprise_access', j.origin);
  from = c.requests.length;
  await c.navigate(`${j.origin}/account/`);
  await waitPath(c, '/signin/', { search: '?reason=expired' });
  j.equal(
    "arm 2 (ii): the signed-out session's own refresh answers 401 and the page reaches /signin/?reason=expired",
    (await apiRequests(c, j.origin, from)).filter((x) => x.path === '/api/auth/refresh').map((x) => x.status),
    [401],
  );

  await c.restoreCookies(captured);
  from = c.requests.length;
  await c.navigate(`${j.origin}/`);
  await waitPath(c, '/members/');
  const iii = await apiRequests(c, j.origin, from);
  j.check('arm 2 (iii): the access token captured before sign-out still verifies until its exp', iii.some((x) => x.path === '/api/me' && x.status === 200), iii.map(line));
}
