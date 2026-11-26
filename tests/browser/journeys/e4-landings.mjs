/* JF3, PW-R-F3 paid (evidence/pages-web-review.md; the critic's probes P1 and P2 are its shape): the sign-in landing and
   the invitation landing, restored from the back-forward cache after the browser signed out, no longer show the identity
   that signed out. Each arm asserts first that a restore with persisted happened, so a pass describes a restored page and
   not a fresh load. Each landing is the first document of its own tab, as rule 10's landing predicate requires. Since
   UI updates (evidence/ui-updates.md) arm 1 signs out through the header's dialog (U3), arm 2 through the account page's
   (U6, asserted), and both hold the restored header to naming no account (U2). */

import { ADDRESS, apiRequests, focusSettles, headerAccount, headerNames, line, linkHash, signIn, signinLink, signOutThroughHeader, sleep, tag, waitPath } from './common.mjs';
import { e4world, invitationUrl } from './e4-common.mjs';

const restored = (tab, from, pathname) => tab.pageshows.slice(from).some((p) => p.page === pathname && p.persisted);
const present = (tab, selector) => tab.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);

async function atPath(tab, pathname, search) {
  await tab.until(
    async () => {
      const l = await tab.location().catch(() => null);
      return l?.pathname === pathname && (search === undefined || l.search === search);
    },
    { timeout: 15000, what: `${pathname}${search ?? ''}` },
  );
}

export async function jf3(ctx, j) {
  /* Arm 1, the sign-in landing (P1): the seeded member signed in, a fresh link for another account in a new tab, the
     header's Sign out, then Back. */
  await signIn(j, 'jf3-signin', ADDRESS.member, { label: 'sign-in' });
  const a = await j.tab('jf3-signin', 'signin-landing');
  await a.navigate(signinLink(j.origin, await linkHash(ADDRESS.outsider)));
  await a.waitForSelector('[data-state="signed-in-choice"]');
  j.check('arm 1: signed in, the sign-in landing shows the signed-in choice with that address', (await a.text()).includes(ADDRESS.member));
  await signOutThroughHeader(a);
  await waitPath(a, '/signin/', { search: '?reason=signed-out' });
  await j.cookies(a, 0, 'arm 1: after sign-out');
  await sleep(300);
  let shows = a.pageshows.length;
  await a.back();
  await atPath(a, '/signin/', '');
  await sleep(2500);
  j.check('arm 1: the landing came back from the back-forward cache (pageshow with persisted)', restored(a, shows, '/signin/'), {
    pageshows: a.pageshows.slice(shows),
    refusals: a.bfcacheRefusals,
  });
  j.check('arm 1: the restored landing is not the signed-in choice', !(await present(a, '[data-state="signed-in-choice"]')));
  j.check(
    'arm 1: neither the page nor its header shows the address that signed out',
    !(await a.evaluate('document.body.innerText')).includes(ADDRESS.member),
  );
  /* UI updates U2: the header names the signed-in account only in the account icon's name and tooltip, which the text
     above does not read, so the restored header is held to having no account link at all. */
  j.equal('arm 1: the restored header names no account', await headerAccount(a), null);
  const canContinue = await present(a, '[data-state="signed-out-landing"] [data-role="continue"]');
  j.check('arm 1: it offers to continue signing in with the link still in page memory', canContinue);
  await j.cookies(a, 0, 'arm 1: the restored landing');
  await j.capture(a, 'signin-landing-restored');
  if (canContinue) {
    const from = a.requests.length;
    await a.click('[data-state="signed-out-landing"] [data-role="continue"]');
    await waitPath(a, '/');
    await a.waitForSelector('[data-state="no-membership"]');
    j.equal(
      'arm 1: pressing it verifies the link once',
      (await apiRequests(a, j.origin, from)).filter((x) => x.path === '/api/auth/verify').map(line),
      ['POST /api/auth/verify 204'],
    );
    j.check('arm 1: and signs in as the account the link was sent to', await headerNames(a, ADDRESS.outsider));
  }

  /* Arm 2, the invitation landing (P2): a company member signed in opens an invitation for another address in a new tab,
     leaves for the account page through the header, signs out there, and returns to the landing's history entry. */
  const W = await e4world(ctx);
  const url = await invitationUrl(ctx, W, `e4p-jf3-${tag()}@example.invalid`);
  await signIn(j, 'jf3-accept', W.users.member.email, { label: 'sign-in' });
  const b = await j.tab('jf3-accept', 'accept-landing');
  await b.navigate(url);
  await b.waitForSelector('[data-state="signed-in-choice"]');
  j.check('arm 2: signed in, the invitation landing shows the signed-in choice with that address', (await b.text()).includes(W.users.member.email));
  const history = await b.history();
  const landing = history.entries[history.currentIndex];
  await b.click('[data-role="account-link"]');
  await waitPath(b, '/account/');
  /* UI updates U6 (evidence/ui-updates.md): the account page's own Sign out asks through the header's dialog. Opening
     it and Cancel send nothing and give focus back to the button; only the dialog's own Sign out sends the request. */
  await b.waitForSelector('[data-role="sign-out-account"]');
  const atAccount = b.requests.length;
  const signOutsSent = () => b.requests.slice(atAccount).filter((r) => new URL(r.url).pathname === '/api/auth/signout').length;
  const accountDialog = () =>
    b.evaluate(
      `(() => { const d = document.querySelector('[data-role="sign-out-account-dialog"]'); return d ? { open: d.open, modal: d.matches(':modal'), focus: document.activeElement?.dataset.role ?? null } : null; })()`,
    );
  const openAccountDialog = async () => {
    await b.click('[data-role="sign-out-account"]');
    await b.waitFor(`document.querySelector('[data-role="sign-out-account-dialog"]')?.open`);
  };
  await openAccountDialog();
  const opened = await accountDialog();
  await b.click('[data-role="sign-out-account-cancel"]');
  await focusSettles(b, 'sign-out-account');
  const cancelled = await accountDialog();
  j.equal(
    "arm 2: the account page's Sign out asks in its own modal dialog, opened on Cancel; Cancel closes it, sends nothing and returns focus",
    { opened, cancelled, sent: signOutsSent() },
    {
      opened: { open: true, modal: true, focus: 'sign-out-account-cancel' },
      cancelled: { open: false, modal: false, focus: 'sign-out-account' },
      sent: 0,
    },
  );
  await openAccountDialog();
  await b.click('[data-role="sign-out-account-dialog"] [data-role="sign-out-account-confirm"]');
  await waitPath(b, '/signin/', { search: '?reason=signed-out' });
  await j.cookies(b, 0, 'arm 2: after sign-out');
  await sleep(300);
  shows = b.pageshows.length;
  await b.send('Page.navigateToHistoryEntry', { entryId: landing.id });
  await atPath(b, new URL(url).pathname);
  await sleep(2500);
  j.check('arm 2: the landing came back from the back-forward cache (pageshow with persisted)', restored(b, shows, new URL(url).pathname), {
    pageshows: b.pageshows.slice(shows),
    refusals: b.bfcacheRefusals,
  });
  j.check('arm 2: the restored landing is not the signed-in choice', !(await present(b, '[data-state="signed-in-choice"]')));
  j.check(
    'arm 2: neither the page nor its header shows the address that signed out',
    !(await b.evaluate('document.body.innerText')).includes(W.users.member.email),
  );
  j.equal('arm 2: the restored header names no account', await headerAccount(b), null);
  j.check('arm 2: it offers to accept with the link still in page memory', await present(b, '[data-state="signed-out-landing"] [data-role="accept"]'));
  await j.cookies(b, 0, 'arm 2: the restored landing');
  await j.capture(b, 'accept-landing-restored');
}
