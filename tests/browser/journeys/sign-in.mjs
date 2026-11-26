/* S6, J1, J2 and J3 (pages design sections 6 and 7): the sign-in form, the link landing for a new and a returning
   profile, and a token hash fetched, loaded, pressed and replayed. */

import { ADDRESS, apiRequests, line, linkHash, scrubbedFirst, signinLink, sleep, tag, waitPath } from './common.mjs';

/** S6: the hash survives GETs of the pages through the shell and is consumed only by its POST. */
export async function s6(ctx, j) {
  const hash = await linkHash(ADDRESS.beta);
  const origin = j.origin;
  for (const path of ['/accept', '/signin/']) {
    const page = await fetch(`${origin}${path}`);
    j.equal(`GET ${path} through the shell answers 200`, page.status, 200);
  }
  const verifyGet = await fetch(`${origin}/api/auth/verify`);
  j.check('GET /api/auth/verify is not 204', verifyGet.status !== 204, verifyGet.status);
  j.record('GET /api/auth/verify status', verifyGet.status);
  const post = () =>
    fetch(`${origin}/api/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokenHash: hash, type: 'magiclink' }),
    });
  const first = await post();
  j.equal('the first POST after the GETs answers 204: the hash was still usable', first.status, 204);
  const second = await post();
  const body = await second.json().catch(() => ({}));
  j.equal('a second POST of the same hash answers 401 E_AUTH_INVALID', [second.status, body.code], [401, 'E_AUTH_INVALID']);
}

/** J1: a known and an unknown address leave the same page state, one 204 each. */
export async function j1(ctx, j) {
  const tab = await j.tab('j1', 'form');
  await tab.navigate(`${j.origin}/signin/`);
  await tab.waitForSelector('[data-role="signin-form"]');
  await j.cookies(tab, 0, 'no session');
  await j.capture(tab, 'form');
  const send = async (email) => {
    const from = tab.requests.length;
    await tab.type('#email', email);
    await tab.click('[data-role="send-link"]');
    await tab.waitForSelector('[data-state="sent"]');
    const starts = (await apiRequests(tab, j.origin, from)).filter((x) => x.path === '/api/auth/start');
    return {
      text: await tab.text(),
      field: await tab.evaluate(`document.querySelector('#email').value`),
      starts: starts.map((x) => x.status),
    };
  };
  const known = await send(ADDRESS.member);
  await j.capture(tab, 'confirmation');
  const unknown = await send(`nobody-${tag()}@example.invalid`);
  j.equal('the page state is identical for a known and an unknown address', unknown.text, known.text);
  j.equal('the field is emptied for both', [known.field, unknown.field], ['', '']);
  j.equal('one 204 for the known address', known.starts, [204]);
  j.equal('one 204 for the unknown address', unknown.starts, [204]);
  await j.cookies(tab, 0, 'after both requests');
}

/** J2: the landing on a profile with no cookies at all, and on a profile holding only its refresh cookie. */
export async function j2(ctx, j) {
  const tab = await j.tab('member', 'landing');
  await j.cookies(tab, 0, 'a profile with no cookies at all');
  await tab.navigate(signinLink(j.origin, await linkHash(ADDRESS.member)));
  await sleep(3000);
  const landing = await apiRequests(tab, j.origin);
  j.equal(
    'after 3 s: one GET /api/me 401, one refresh 401, no second read, no verification',
    landing.map(line),
    ['GET /api/me 401 E_UNAUTHENTICATED', 'POST /api/auth/refresh 401 E_AUTH_INVALID'],
  );
  j.equal('zero navigations after the landing', tab.documents.length, 1);
  const where = await tab.location();
  j.equal('the document is still /signin/ and location.hash is empty', [where.pathname, where.hash], ['/signin/', '']);
  j.check('the fragment left the address bar before the first request', scrubbedFirst(tab), tab.events.slice(0, 20));
  j.check(
    'Continue is present and pressable',
    await tab.evaluate(`(() => { const b = document.querySelector('[data-role="continue"]'); return Boolean(b && !b.disabled); })()`),
  );
  await j.cookies(tab, 0, 'the landing before the press');
  await j.capture(tab, 'landing-before-press');

  const from = tab.requests.length;
  await tab.click('[data-role="continue"]');
  await waitPath(tab, '/members/');
  await tab.waitForSelector('[data-role="members"]');
  const pressed = await apiRequests(tab, j.origin, from);
  j.equal('the press posts the link once, 204', pressed.filter((x) => x.path === '/api/auth/verify').map(line), ['POST /api/auth/verify 204']);
  await j.cookies(tab, 2, 'signed in');
  const next = pressed.find((x) => x.path === '/api/auth/factors');
  j.check(
    'Secure cookies over http://127.0.0.1: the next API request carried both',
    next && ['enterprise_access', 'enterprise_refresh'].every((n) => next.entry.sentCookies?.includes(n)),
    next?.entry.sentCookies,
  );
  j.check('home moved the one-membership account to its members page', true);
  await j.capture(tab, 'home-after');

  const returning = await j.tab('member', 'returning');
  await returning.deleteCookie('enterprise_access', j.origin);
  await j.cookies(returning, 1, 'the refresh cookie alone before the returning landing');
  await returning.navigate(signinLink(j.origin, await linkHash(ADDRESS.member)));
  await returning.waitForSelector('[data-role="continue-as"]');
  const again = await apiRequests(returning, j.origin);
  j.equal(
    'discovery on a returning profile: 401, one refresh 204, the repeated read 200',
    again.map(line),
    ['GET /api/me 401 E_UNAUTHENTICATED', 'POST /api/auth/refresh 204', 'GET /api/me 200'],
  );
  j.equal(
    'the page shows "Continue as <address>"',
    await returning.evaluate(`document.querySelector('[data-role="continue-as"]').textContent.replace(/\\s+/g, ' ').trim()`),
    `Continue as ${ADDRESS.member}`,
  );
  j.equal('zero navigations on the returning landing', returning.documents.length, 1);
  await j.cookies(returning, 2, 'after the discovery refresh');
  await j.capture(returning, 'returning-session-landing');
}

/** J3: a hash fetched by GET and loaded without a press stays usable; a replayed press is refused. */
export async function j3(ctx, j) {
  const url = signinLink(j.origin, await linkHash(ADDRESS.outsider));
  const got = await fetch(url);
  j.equal('(a) the harness fetches the landing URL with a plain GET: 200', got.status, 200);
  const loader = await j.tab('j3-loader', 'load-only');
  await loader.navigate(url);
  await sleep(2500);
  j.equal('(a) a second profile loads it without pressing: no verification sent', (await apiRequests(loader, j.origin)).filter((x) => x.path === '/api/auth/verify').length, 0);

  const presser = await j.tab('j3-presser', 'press');
  await presser.navigate(url);
  await presser.waitForSelector('[data-role="continue"]');
  await presser.click('[data-role="continue"]');
  await waitPath(presser, '/');
  await presser.waitForSelector('[data-state="no-membership"]');
  const pressed = await apiRequests(presser, j.origin);
  j.equal('(a) a third profile presses Continue: 204, the hash was not consumed', pressed.filter((x) => x.path === '/api/auth/verify').map(line), ['POST /api/auth/verify 204']);
  await j.cookies(presser, 2, 'the third profile signed in');
  await j.capture(presser, 'no-membership');

  const replay = await j.tab('j3-replay', 'replay');
  await replay.navigate(url);
  await replay.waitForSelector('[data-role="continue"]');
  await replay.click('[data-role="continue"]');
  await replay.waitForSelector('[data-state="email-form"] [data-code="E_AUTH_INVALID"]');
  const replayed = await apiRequests(replay, j.origin);
  j.equal('(b) the same link pressed again: 401 E_AUTH_INVALID', replayed.filter((x) => x.path === '/api/auth/verify').map(line), ['POST /api/auth/verify 401 E_AUTH_INVALID']);
  j.check("(b) the server's message is shown, with the email form", (await replay.text()).includes('Sign-in link is not valid.'));
  await j.cookies(replay, 0, '(b) no cookie set');
  await j.capture(replay, 'replay-refusal');

  const direct = await fetch(`${j.origin}/api/auth/verify`);
  j.check('(c) GET /api/auth/verify directly is not 204', direct.status !== 204, direct.status);
  j.record('(c) GET /api/auth/verify status', direct.status);
}
