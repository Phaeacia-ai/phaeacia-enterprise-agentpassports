/* J5 and J6 (pages design sections 1, 2.4, 2.5 and 6): an administrator without a factor forced to enrol, with a
   second tab's superseded setup; an administrator with a factor challenged at aal1, and a profile signed in before the
   step-up losing its session. */

import { currentCode, refusedCode } from '../totp.mjs';
import { ADDRESS, apiRequests, line, signIn, signinLink, linkHash, sql, startSetup, verifySetup, waitPath } from './common.mjs';

const ADMIN_CONTROLS = '[data-role="change-roles"], [data-role="remove"], [data-role="invite-form"], [data-role="revoke"]';

export async function j5(ctx, j) {
  const admin1 = ctx.ids.U_alpha_admin1;
  const unverified = () => Number(sql(`select count(*) from auth.mfa_factors where user_id = '${admin1}' and status = 'unverified'`));
  const verified = () => Number(sql(`select count(*) from auth.mfa_factors where user_id = '${admin1}' and status = 'verified'`));

  const tabA = await j.tab('admin1', 'tab-a');
  await tabA.navigate(signinLink(j.origin, await linkHash(ADDRESS.admin1)));
  await tabA.waitForSelector('[data-role="continue"]');
  await tabA.click('[data-role="continue"]');
  await waitPath(tabA, '/mfa/');
  await tabA.waitForSelector('[data-state="enrol"]');
  const beforeEnrol = await apiRequests(tabA, j.origin);
  j.equal('no member list is requested before the move to /mfa/', beforeEnrol.filter((x) => x.path.endsWith('/members')).length, 0);
  j.check(
    'the page states that until enrolment the email link is the only factor',
    (await tabA.text()).includes('the link in your email is the only factor that protects this account'),
  );
  await j.cookies(tabA, 2, 'an administrator at aal1 without a factor');
  await j.capture(tabA, 'enrol');

  let from = tabA.requests.length;
  const keyA = await startSetup(tabA);
  const enrolA = (await apiRequests(tabA, j.origin, from)).find((x) => x.path === '/api/auth/factors/totp');
  j.equal('enrolment against the real provider answers 201', enrolA?.status, 201);
  j.record('enrolment answer, bytes on the wire (Network.loadingFinished encodedDataLength, headers included)', enrolA?.entry.encodedDataLength);
  const qr = await tabA.evaluate(`(() => { const i = document.querySelector('img.qr'); return { prefix: i.getAttribute('src').slice(0, 18), decoded: i.complete && i.naturalWidth > 0, width: i.getBoundingClientRect().width }; })()`);
  j.equal("the QR image's src starts data:image/svg+xml", qr.prefix, 'data:image/svg+xml');
  j.check('the QR image decoded as an image', qr.decoded, qr);
  await j.capture(tabA, 'enrol-qr');

  const tabB = await j.tab('admin1', 'tab-b');
  await tabB.navigate(`${j.origin}/mfa/`);
  await tabB.waitForSelector('[data-role="start-enrolment"]');
  const keyB = await startSetup(tabB);
  j.equal('both enrolments exist while the first QR is shown', unverified(), 2);

  await tabB.type('#enrol-code', refusedCode(keyB));
  await tabB.click('[data-role="verify-enrolment"]');
  await tabB.waitForSelector('[data-role="enrol-form"] [data-code="E_MFA_CODE_INVALID"]');
  j.check("a wrong code shows the server's E_MFA_CODE_INVALID message", (await tabB.text()).includes('The code is not valid.'));
  await j.capture(tabB, 'wrong-code');

  from = tabB.requests.length;
  await verifySetup(tabB, keyB);
  await waitPath(tabB, '/members/');
  await tabB.waitForSelector('[data-role="invite-form"]');
  ctx.state.admin1Key = keyB;
  const afterVerify = await apiRequests(tabB, j.origin, from);
  j.check('the right code gives 204', afterVerify.some((x) => /\/verify$/.test(x.path) && x.status === 204), afterVerify.map(line));
  /* The body of an answer to an earlier document is gone once the tab navigates; the members page's own read is the one
     still held. Every GET /api/me after the verification answered 200. */
  j.check('every GET /api/me after the verification answered 200', afterVerify.filter((x) => x.path === '/api/me').every((x) => x.status === 200), afterVerify.map(line));
  const meAfter = afterVerify.filter((x) => x.path === '/api/me' && x.status === 200).at(-1);
  j.equal('GET /api/me after the verification answers aal2', meAfter ? (await tabB.responseJson(meAfter.entry)).user.aal : null, 'aal2');
  j.check('the administrator controls appear', await tabB.evaluate(`Boolean(document.querySelector(${JSON.stringify(ADMIN_CONTROLS)}))`));
  await j.cookies(tabB, 2, 'an administrator at aal2');
  await j.capture(tabB, 'admin-controls');
  j.equal('the verification left one verified factor and removed the other setup itself', [verified(), unverified()], [1, 0]);

  await tabA.type('#enrol-code', await currentCode(keyA));
  await tabA.click('[data-role="verify-enrolment"]');
  await tabA.waitForSelector('[data-state="superseded"]');
  j.check('the first tab shows the superseded-enrolment state', (await tabA.text()).includes('This setup was replaced by another one. Start again.'));
  await j.capture(tabA, 'superseded');
  from = tabA.requests.length;
  await tabA.click('[data-role="start-again"]');
  await tabA.waitForSelector('[data-role="secret"]');
  j.equal('"Start again" works: a new setup answers 201', (await apiRequests(tabA, j.origin, from)).filter((x) => x.path === '/api/auth/factors/totp').map((x) => x.status), [201]);
  j.equal('no DELETE was sent by either tab in the whole journey', [...tabA.requests, ...tabB.requests].filter((r) => r.method === 'DELETE').length, 0);
}

export async function j6(ctx, j) {
  const pre = await signIn(j, 'admin1-pre', ADDRESS.admin1, { label: 'pre-step-up' });
  await waitPath(pre, '/mfa/');
  await pre.waitForSelector('[data-state="challenge"]');

  const tab = await signIn(j, 'admin1-b', ADDRESS.admin1, { label: 'challenge' });
  await waitPath(tab, '/mfa/');
  await tab.waitForSelector('[data-state="challenge"]');
  j.check('the landing sends an administrator with a verified factor at aal1 to the challenge', true);
  await j.cookies(tab, 2, 'aal1 with a verified factor');
  await j.capture(tab, 'challenge');

  const panel = await j.tab('admin1-b', 'read-only');
  await panel.navigate(`${j.origin}/members/?company=${ctx.ids.ALPHA}`);
  await panel.waitForSelector('[data-role="step-up-panel"]');
  j.check('an administrator at aal1 sees the list read-only: no administrator control in the DOM', await panel.evaluate(`!document.querySelector(${JSON.stringify(ADMIN_CONTROLS)})`));
  j.equal('an administrator at aal1 sends no invitation list request', (await apiRequests(panel, j.origin)).filter((x) => x.path.endsWith('/invitations')).length, 0);
  j.check('the addresses line is shown at aal1 for a viewer the read predicate admits', await panel.evaluate(`Boolean(document.querySelector('[data-role="addresses-need-mfa"]'))`));
  await j.capture(panel, 'read-only-panel');

  await tab.type('#code', await currentCode(ctx.state.admin1Key));
  await tab.click('[data-role="verify"]');
  await waitPath(tab, '/members/');
  await tab.waitForSelector('[data-role="invite-form"]');
  j.check('after the challenge the administrator controls appear', true);
  await j.cookies(tab, 2, 'aal2 after the challenge');

  await pre.deleteCookie('enterprise_access', j.origin);
  await j.cookies(pre, 1, 'the pre-step-up profile with its refresh cookie alone');
  await pre.navigate(`${j.origin}/account/`);
  await waitPath(pre, '/signin/', { search: '?reason=expired' });
  const refused = (await apiRequests(pre, j.origin)).filter((x) => x.path === '/api/auth/refresh');
  j.equal("the pre-step-up profile's refresh fails and it reaches /signin/?reason=expired", refused.map((x) => x.status).at(-1), 401);
  await pre.waitForSelector('[data-state="reason-expired"]');
  await j.cookies(pre, 0, 'after the refused refresh');
  await j.capture(pre, 'expired-notice');
}
