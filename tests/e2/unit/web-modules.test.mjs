/* U8 (pages design 7.1): the browser modules under web/assets/app/ run in Node with an injected fetch, location and
   history. The ordinary path: one refresh for a burst of 401s, one repeat, no refresh on any other refusal, a refused
   refresh moving to /signin/?reason=expired, the session-call queue never overlapping a refresh with a factor
   verification, queued work discarded on navigation. Session discovery: exactly one refresh and zero navigations on
   every branch, the 401/204/401 control, the unavailable answers, a burst sharing one refresh, and the ordinary path
   unchanged beside it. params.mjs scrubs the fragment before the first request and touches no storage; the step-up
   decision is any verified factor; navigation admits the fixed set only; no string under web/ equals a message of
   lib/errors.mjs. Each test imports a fresh api.mjs (a query on its URL), so no refresh promise or queue leaks
   between tests; shell.mjs and params.mjs are shared unless a test imports its own. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES, messageFor } from '../../../lib/errors.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const APP = '../../../web/assets/app';

/* ---------- the injected browser ---------- */

const navigations = [];
const order = [];
const touched = [];
const setGlobal = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

setGlobal('location', {
  hash: '',
  pathname: '/signin/',
  search: '',
  assign: (target) => {
    navigations.push(target);
    order.push(`navigate ${target}`);
  },
});
setGlobal('history', {
  replaceState: (_state, _title, url) => {
    order.push(`replaceState ${url}`);
    globalThis.location.hash = '';
  },
});
for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'caches']) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      touched.push(name);
      return undefined;
    },
  });
}
setGlobal('document', {
  get cookie() {
    touched.push('document.cookie');
    return '';
  },
  set cookie(_v) {
    touched.push('document.cookie');
  },
  getElementById: (id) => ({ id }),
});
/* shell.startPage() listens for pageshow; the back-forward cache case itself is in web-bfcache.test.mjs. */
setGlobal('addEventListener', () => undefined);

let serial = 0;
const freshApi = () => import(`${APP}/api.mjs?u8=${++serial}`);

const json = (status, value) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const refusal = (status, code) => () => json(status, { ok: false, code, message: `server text for ${code}` });
const noContent = () => () => new Response(null, { status: 204 });
const identity = (tag) => () =>
  json(200, { ok: true, user: { id: tag, email: `${tag}@example.invalid`, aal: 'aal1' } });
const thrown = () => () => {
  throw new TypeError('network');
};

/** A scripted service: routes['METHOD /path'] is a list of answer factories used in order (the last repeats), or a
    function (entry) => answer. Every request is logged with its start and end. */
function service(routes) {
  const log = [];
  const counts = new Map();
  globalThis.fetch = async (path, init) => {
    const key = `${init.method} ${path}`;
    const entry = { key, init, start: performance.now(), end: null };
    log.push(entry);
    order.push(`fetch ${key}`);
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    const route = routes[key];
    try {
      if (!route) throw new Error(`unscripted ${key}`);
      const answer = Array.isArray(route) ? route[Math.min(n, route.length - 1)] : route;
      return await answer(entry);
    } finally {
      entry.end = performance.now();
    }
  };
  return log;
}
const keys = (log) => log.map((e) => e.key);
const reset = () => {
  navigations.length = 0;
  order.length = 0;
};
const barrier = () => {
  let open;
  const opened = new Promise((r) => {
    open = r;
  });
  return { open, opened };
};

/* ---------- the ordinary path ---------- */

test('U8 ordinary: the plain success path is one request with the rule 2 request shape', async () => {
  reset();
  const api = await freshApi();
  const log = service({ 'GET /api/me': [identity('plain')], 'PUT /api/me/display-name': [noContent()] });
  const r = await api.me();
  assert.equal(r.ok, true);
  assert.equal(r.data.user.id, 'plain');
  assert.deepEqual(keys(log), ['GET /api/me']);
  assert.deepEqual(log[0].init, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: { accept: 'application/json' },
  });
  await api.setDisplayName('Ada');
  assert.equal(log[1].init.headers['content-type'], 'application/json');
  assert.equal(log[1].init.body, '{"displayName":"Ada"}');
  assert.deepEqual(navigations, []);
});

test('U8 ordinary: a burst of 401s causes one refresh, and each call is repeated once', async () => {
  reset();
  const api = await freshApi();
  const gate = barrier();
  let refreshedNow = false;
  const log = service({
    'GET /api/me': (entry) => (refreshedNow ? identity('after')(entry) : refusal(401, 'E_UNAUTHENTICATED')()),
    'POST /api/auth/refresh': async () => {
      await gate.opened;
      refreshedNow = true;
      return new Response(null, { status: 204 });
    },
  });
  const burst = Promise.all([api.me(), api.me(), api.me()]);
  await new Promise((r) => setTimeout(r, 20));
  gate.open();
  const results = await burst;
  assert.ok(results.every((r) => r.ok && r.data.user.id === 'after'));
  assert.equal(keys(log).filter((k) => k === 'POST /api/auth/refresh').length, 1, 'one refresh');
  assert.equal(keys(log).filter((k) => k === 'GET /api/me').length, 6, 'three calls, each repeated once');
  assert.deepEqual(navigations, []);
});

test('U8 ordinary: a call sent before another call refreshed repeats without a second refresh', async () => {
  reset();
  const api = await freshApi();
  const slow = barrier();
  let refreshedNow = false;
  const log = service({
    'GET /api/me': [refusal(401, 'E_UNAUTHENTICATED'), identity('a')],
    'GET /api/auth/factors': [
      async () => {
        await slow.opened;
        return refusal(401, 'E_UNAUTHENTICATED')();
      },
      () => json(200, { ok: true, aal: 'aal1', factors: [] }),
    ],
    'POST /api/auth/refresh': () => {
      refreshedNow = true;
      return new Response(null, { status: 204 });
    },
  });
  const late = api.factors();
  const early = await api.me();
  assert.ok(early.ok && refreshedNow);
  slow.open();
  assert.equal((await late).ok, true);
  assert.equal(keys(log).filter((k) => k === 'POST /api/auth/refresh').length, 1);
});

test('U8 ordinary: no refresh on E_AUTH_INVALID, 403, 404, 409, 422 or 503; each answer keeps its code and action', async () => {
  const cases = [
    [401, 'E_AUTH_INVALID', 'message'],
    [403, 'E_FORBIDDEN', 'message'],
    [403, 'E_ADMIN_MFA_REQUIRED', 'mfa'],
    [403, 'E_EMAIL_MISMATCH', 'sign-out'],
    [404, 'E_NOT_FOUND', 'not-found'],
    [409, 'E_BUSY', 'retry'],
    [422, 'E_BODY_INVALID', 'message'],
    [503, 'E_MAINTENANCE', 'maintenance'],
    [503, 'E_SESSION_UNAVAILABLE', 'retry'],
  ];
  for (const [status, code, action] of cases) {
    reset();
    const api = await freshApi();
    const log = service({ 'POST /api/auth/verify': [refusal(status, code)] });
    const r = await api.verifyLink('h'.repeat(20), 'magiclink');
    assert.deepEqual(
      { ok: r.ok, status: r.status, code: r.code, action: r.action, message: r.message },
      { ok: false, status, code, action, message: `server text for ${code}` },
      code,
    );
    assert.deepEqual(keys(log), ['POST /api/auth/verify'], `${code}: no refresh`);
    assert.deepEqual(navigations, [], `${code}: no navigation`);
  }
});

test('U8 ordinary: a refused refresh moves to /signin/?reason=expired; an unavailable one does not', async () => {
  for (const [label, refresh, navigated] of [
    ['401', refusal(401, 'E_AUTH_INVALID'), true],
    ['500', refusal(500, 'E_INTERNAL'), true],
    ['503', refusal(503, 'E_MAINTENANCE'), false],
    ['thrown', thrown(), false],
  ]) {
    reset();
    const api = await freshApi();
    const log = service({ 'GET /api/me': [refusal(401, 'E_UNAUTHENTICATED')], 'POST /api/auth/refresh': [refresh] });
    const r = await api.me();
    assert.deepEqual(keys(log), ['GET /api/me', 'POST /api/auth/refresh'], label);
    if (navigated) {
      assert.deepEqual(navigations, ['/signin/?reason=expired'], label);
      assert.equal(r.action, 'navigating', label);
    } else {
      assert.deepEqual(navigations, [], label);
      assert.ok(r.network === true || r.status === 503, label);
    }
  }
});

test('U8 ordinary: a repeat answering 401 after a 204 refresh moves to sign-in with no second refresh', async () => {
  reset();
  const api = await freshApi();
  const log = service({ 'GET /api/me': [refusal(401, 'E_UNAUTHENTICATED')], 'POST /api/auth/refresh': [noContent()] });
  const r = await api.me();
  assert.deepEqual(keys(log), ['GET /api/me', 'POST /api/auth/refresh', 'GET /api/me']);
  assert.deepEqual(navigations, ['/signin/?reason=expired']);
  assert.equal(r.action, 'navigating');
});

test('U8 queue: a refresh never overlaps a factor verification, and session calls run one at a time', async () => {
  reset();
  const api = await freshApi();
  const hold = barrier();
  const factor = '6f1d2c3b-4a59-4e68-8d7c-0b1a2f3e4d5c';
  const log = service({
    [`POST /api/auth/factors/${factor}/verify`]: async () => {
      await hold.opened;
      return new Response(null, { status: 204 });
    },
    [`DELETE /api/auth/factors/${factor}`]: [noContent()],
    'GET /api/me': [refusal(401, 'E_UNAUTHENTICATED'), identity('queued')],
    'POST /api/auth/refresh': [noContent()],
  });
  const verifying = api.verifyFactor(factor, '123456');
  const removing = api.removeFactor(factor);
  const reading = api.me();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(
    [...keys(log)].sort(),
    ['GET /api/me', `POST /api/auth/factors/${factor}/verify`],
    'the refresh and the removal wait behind the verification',
  );
  hold.open();
  await Promise.all([verifying, removing, reading]);
  const at = (key) => log.find((e) => e.key === key);
  const verify = at(`POST /api/auth/factors/${factor}/verify`);
  const remove = at(`DELETE /api/auth/factors/${factor}`);
  const refresh = at('POST /api/auth/refresh');
  assert.ok(refresh.start >= verify.end, 'the refresh started after the verification ended');
  assert.ok(remove.start >= verify.end, 'the removal started after the verification ended');
  assert.ok(refresh.start >= remove.end || remove.start >= refresh.end, 'the refresh and the removal did not overlap');
});

test('U8 queue: queued work that has not started is discarded when the page navigates', async () => {
  reset();
  const api = await freshApi();
  const shell = await import(`${APP}/shell.mjs`);
  const hold = barrier();
  const factor = '6f1d2c3b-4a59-4e68-8d7c-0b1a2f3e4d5c';
  const log = service({
    [`POST /api/auth/factors/${factor}/verify`]: async () => {
      await hold.opened;
      return new Response(null, { status: 204 });
    },
    [`DELETE /api/auth/factors/${factor}`]: [noContent()],
  });
  const verifying = api.verifyFactor(factor, '123456');
  const removing = api.removeFactor(factor);
  await new Promise((r) => setTimeout(r, 10));
  shell.navigate('/');
  hold.open();
  assert.equal((await verifying).action, 'navigating');
  assert.equal((await removing).action, 'navigating');
  assert.deepEqual(keys(log), [`POST /api/auth/factors/${factor}/verify`], 'the removal was never sent');
});

/* ---------- session discovery ---------- */

test('U8 discovery: a first 200 is the identity with no refresh', async () => {
  reset();
  const api = await freshApi();
  const log = service({ 'GET /api/me': [identity('first')] });
  const d = await api.discoverSession();
  assert.deepEqual(d, {
    signedIn: true,
    me: { ok: true, user: { id: 'first', email: 'first@example.invalid', aal: 'aal1' } },
  });
  assert.deepEqual(keys(log), ['GET /api/me']);
  assert.deepEqual(navigations, []);
});

test('U8 discovery: 401 then a refused refresh is signed out, one refresh, zero navigations, the link still readable', async () => {
  reset();
  const params = await import(`${APP}/params.mjs?u8=${++serial}`);
  globalThis.location.hash = '#token_hash=discoveryhashvalue0000&type=magiclink';
  const landing = params.readLanding();
  const api = await freshApi();
  const log = service({
    'GET /api/me': [refusal(401, 'E_UNAUTHENTICATED')],
    'POST /api/auth/refresh': [refusal(401, 'E_AUTH_INVALID')],
  });
  assert.deepEqual(await api.discoverSession(), { signedIn: false });
  assert.deepEqual(keys(log), ['GET /api/me', 'POST /api/auth/refresh']);
  assert.deepEqual(navigations, []);
  assert.deepEqual(params.readLanding(), landing);
  assert.equal(landing.tokenHash, 'discoveryhashvalue0000');
  /* The ordinary path in the same module instance is unchanged: the same answers navigate. */
  const ordinary = await api.me();
  assert.equal(ordinary.action, 'navigating');
  assert.deepEqual(navigations, ['/signin/?reason=expired']);
  assert.equal(keys(log).filter((k) => k === 'POST /api/auth/refresh').length, 2, 'one refresh each');
});

test('U8 discovery: 401, 204, then the identity the repeated read gives', async () => {
  reset();
  const api = await freshApi();
  const log = service({
    'GET /api/me': [refusal(401, 'E_UNAUTHENTICATED'), identity('repeat')],
    'POST /api/auth/refresh': [noContent()],
  });
  const d = await api.discoverSession();
  assert.equal(d.signedIn, true);
  assert.equal(d.me.user.id, 'repeat');
  assert.deepEqual(keys(log), ['GET /api/me', 'POST /api/auth/refresh', 'GET /api/me']);
  assert.deepEqual(navigations, []);
});

test('U8 discovery, the 401/204/401 control: signed out, exactly one refresh in the whole call, zero navigations', async () => {
  reset();
  const api = await freshApi();
  const log = service({ 'GET /api/me': [refusal(401, 'E_UNAUTHENTICATED')], 'POST /api/auth/refresh': [noContent()] });
  assert.deepEqual(await api.discoverSession(), { signedIn: false });
  assert.deepEqual(keys(log), ['GET /api/me', 'POST /api/auth/refresh', 'GET /api/me']);
  assert.deepEqual(navigations, []);
});

test('U8 discovery: 503 or a thrown request at any of the three calls is unavailable, never signed out, zero navigations', async () => {
  const cases = [
    ['first 503 E_MAINTENANCE', { 'GET /api/me': [refusal(503, 'E_MAINTENANCE')] }, 'E_MAINTENANCE', 1],
    [
      'first 503 E_SESSION_UNAVAILABLE',
      { 'GET /api/me': [refusal(503, 'E_SESSION_UNAVAILABLE')] },
      'E_SESSION_UNAVAILABLE',
      1,
    ],
    ['first thrown', { 'GET /api/me': [thrown()] }, null, 1],
    [
      'refresh 503',
      { 'GET /api/me': [refusal(401, 'E_UNAUTHENTICATED')], 'POST /api/auth/refresh': [refusal(503, 'E_MAINTENANCE')] },
      'E_MAINTENANCE',
      2,
    ],
    [
      'refresh thrown',
      { 'GET /api/me': [refusal(401, 'E_UNAUTHENTICATED')], 'POST /api/auth/refresh': [thrown()] },
      null,
      2,
    ],
    [
      'repeat 503',
      {
        'GET /api/me': [refusal(401, 'E_UNAUTHENTICATED'), refusal(503, 'E_SESSION_UNAVAILABLE')],
        'POST /api/auth/refresh': [noContent()],
      },
      'E_SESSION_UNAVAILABLE',
      3,
    ],
    [
      'repeat thrown',
      { 'GET /api/me': [refusal(401, 'E_UNAUTHENTICATED'), thrown()], 'POST /api/auth/refresh': [noContent()] },
      null,
      3,
    ],
  ];
  for (const [label, routes, code, requests] of cases) {
    reset();
    const api = await freshApi();
    const log = service(routes);
    const d = await api.discoverSession();
    assert.deepEqual(
      { unavailable: d.unavailable, code: d.code, signedIn: d.signedIn },
      { unavailable: true, code, signedIn: undefined },
      label,
    );
    assert.equal(d.answer.ok, false, `${label}: the failed answer rides along for the landing's state`);
    assert.equal(log.length, requests, label);
    assert.ok(keys(log).filter((k) => k === 'POST /api/auth/refresh').length <= 1, label);
    assert.deepEqual(navigations, [], label);
  }
});

test('U8 discovery: an answer the contract does not name is an error state, not signed out and not a navigation', async () => {
  reset();
  const api = await freshApi();
  service({
    'GET /api/me': [refusal(401, 'E_UNAUTHENTICATED'), refusal(500, 'E_INTERNAL')],
    'POST /api/auth/refresh': [noContent()],
  });
  const d = await api.discoverSession();
  assert.equal(d.error?.code, 'E_INTERNAL');
  assert.equal(d.signedIn, undefined);
  assert.deepEqual(navigations, []);
});

test('U8 discovery: a burst of discovery calls shares the one refresh', async () => {
  reset();
  const api = await freshApi();
  const gate = barrier();
  let refreshedNow = false;
  const log = service({
    'GET /api/me': (entry) => (refreshedNow ? identity('burst')(entry) : refusal(401, 'E_UNAUTHENTICATED')()),
    'POST /api/auth/refresh': async () => {
      await gate.opened;
      refreshedNow = true;
      return new Response(null, { status: 204 });
    },
  });
  const burst = Promise.all([api.discoverSession(), api.discoverSession(), api.discoverSession()]);
  await new Promise((r) => setTimeout(r, 20));
  gate.open();
  const results = await burst;
  assert.ok(results.every((d) => d.signedIn === true && d.me.user.id === 'burst'));
  assert.equal(keys(log).filter((k) => k === 'POST /api/auth/refresh').length, 1);
  assert.deepEqual(navigations, []);
});

/* ---------- params.mjs, shell.mjs, the step-up decision and the message table ---------- */

test('U8 params: the fragment is scrubbed before the first request, read once, and no storage is touched', async () => {
  reset();
  touched.length = 0;
  const shell = await import(`${APP}/shell.mjs`);
  const api = await freshApi();
  const log = service({
    'GET /api/me': [refusal(401, 'E_UNAUTHENTICATED')],
    'POST /api/auth/refresh': [refusal(401, 'E_AUTH_INVALID')],
  });
  globalThis.location.hash = '#token_hash=scrubbedhashvalue0000&type=magiclink&invite=' + 'a'.repeat(64);
  globalThis.location.pathname = '/accept';
  const page = shell.startPage();
  assert.equal(page.main.id, 'main');
  await api.discoverSession();
  assert.equal(order[0], 'replaceState /accept', 'the scrub is the first thing that happens');
  assert.equal(order.indexOf('fetch GET /api/me'), 1, 'and the first request follows it');
  assert.equal(globalThis.location.hash, '');
  const params = await import(`${APP}/params.mjs`);
  assert.deepEqual(params.readLanding(), {
    tokenHash: 'scrubbedhashvalue0000',
    type: 'magiclink',
    invite: 'a'.repeat(64),
  });
  assert.equal(order.filter((o) => o.startsWith('replaceState')).length, 1, 'read once');
  assert.ok(
    log.every((e) => !e.key.includes('scrubbedhashvalue') && !(e.init.body ?? '').includes('scrubbedhashvalue')),
  );
  assert.deepEqual(touched, [], 'no storage and no document.cookie');
  params.forgetLinkHash();
  assert.equal(params.readLanding().tokenHash, null);
  assert.equal(params.readLanding().invite, 'a'.repeat(64));
});

/* HOSTED-F1 (evidence/e1-lead.md, 2026-09-21): the first hosted sign-in mail carried `<site>//signin/#token_hash=...`,
   because the project's Site URL ended in a slash and the template appends `/signin/`. A path that begins with two
   slashes is a scheme-relative URL to `history.replaceState`, which a browser refuses with a SecurityError (another
   origin), so the scrub threw, the page stayed blank and the link was never exchanged. The scrub now collapses leading
   slashes, and no failure of the scrub may stop the page or leave the token in the address. */
test('U8 params: a doubled leading slash in the path cannot stop the scrub, and a failing scrub still clears the fragment', async () => {
  reset();
  const browserLike = (url) => {
    if (String(url).startsWith('//'))
      throw new Error("SecurityError: a history state object with URL 'https://signin/' cannot be created");
  };
  globalThis.history.replaceState = (_state, _title, url) => {
    browserLike(url);
    order.push(`replaceState ${url}`);
    globalThis.location.hash = '';
  };
  globalThis.location.hash = '#token_hash=doubledslashvalue0000&type=magiclink';
  globalThis.location.pathname = '//signin/';
  const params = await import(`${APP}/params.mjs?u8slash=${++serial}`);
  assert.deepEqual(params.readLanding(), { tokenHash: 'doubledslashvalue0000', type: 'magiclink', invite: null });
  assert.equal(order[0], 'replaceState /signin/', 'the path is scrubbed with one leading slash');
  assert.equal(globalThis.location.hash, '');

  /* A scrub that fails for any other reason: the values are still read and the fragment is still cleared. */
  reset();
  globalThis.history.replaceState = () => {
    throw new Error('SecurityError');
  };
  globalThis.location.hash = '#token_hash=failingscrubvalue0000&type=magiclink';
  globalThis.location.pathname = '/signin/';
  const again = await import(`${APP}/params.mjs?u8slash=${++serial}`);
  assert.deepEqual(again.readLanding(), { tokenHash: 'failingscrubvalue0000', type: 'magiclink', invite: null });
  assert.equal(globalThis.location.hash, '', 'the fragment is cleared even when replaceState throws');
});

test('U8 navigation: the fixed set and its query are admitted, anything else throws before location is written', async () => {
  reset();
  const shell = await import(`${APP}/shell.mjs`);
  const company = '2a5d1b3c-4e6f-4a8b-9c0d-1e2f3a4b5c6d';
  for (const target of [
    '/',
    '/signin/',
    '/accept/',
    '/accept',
    '/mfa/',
    '/members/',
    '/account/',
    `/members/?company=${company}`,
    '/signin/?reason=expired',
    '/signin/?reason=signed-out',
  ])
    assert.equal(shell.isAllowedTarget(target), true, target);
  for (const target of [
    'https://example.invalid/',
    '//example.invalid/',
    '/admin/',
    '/members',
    '/members/?company=not-a-uuid',
    `/members/?company=${company}&next=/`,
    '/signin/?next=/account/',
    '/signin/?reason=elsewhere',
    '/signin/#token_hash=x',
    '/signin/?',
    `/members/?company=${company.toUpperCase()}`,
  ]) {
    assert.equal(shell.isAllowedTarget(target), false, target);
    assert.throws(() => shell.navigate(target), TypeError, target);
  }
  assert.deepEqual(navigations, []);
  assert.throws(() => shell.membersTarget('../../api/me'), TypeError);
});

test('U8: the step-up decision is any verified factor of a supported type, never a comparison with totp', async () => {
  const api = await freshApi();
  assert.equal(api.hasVerifiedFactor([{ type: 'webauthn', status: 'verified' }]), true, 'a second supported type');
  assert.equal(api.hasVerifiedFactor([{ type: 'totp', status: 'verified' }]), true);
  assert.equal(api.hasVerifiedFactor([{ type: 'totp', status: 'unverified' }]), false);
  assert.equal(api.hasVerifiedFactor([]), false);
  assert.equal(api.hasVerifiedFactor(undefined), false);
  const source = readFileSync(join(REPO, 'web/assets/app/api.mjs'), 'utf8');
  assert.equal(/===\s*['"]totp['"]/.test(source), false, 'no comparison with the type name in api.mjs');
});

test('U8: the code table maps to actions, never to text, and an unknown code gets the message alone', async () => {
  const api = await freshApi();
  const actions = new Set(['sign-in', 'maintenance', 'retry', 'mfa', 'not-found', 'sign-out', 'reload', 'message']);
  for (const code of Object.keys(CODES)) {
    const action = api.actionFor(code);
    assert.ok(actions.has(action), `${code} -> ${action}`);
    assert.notEqual(action, messageFor(code));
  }
  assert.equal(api.actionFor('E_A_CODE_ADDED_LATER'), 'message');
  assert.equal(api.actionFor(null), 'retry');
});

/* K2 (evidence/hardening-k.md; XR-12; the peer check's CK-1): an E_INTERNAL answer's request id reaches the page so the
   failure view can show it. Only that code, only the request id's shape, and nothing else the server might add. */
test("K2: send() returns an E_INTERNAL answer's request id when it has the shape, and no other answer's", async () => {
  const ID = '01JAB2CD3EF4GH5JK6MN7PQ8RS';
  const answer = (status, value) => () => json(status, value);
  const internal = (extra) => answer(500, { ok: false, code: 'E_INTERNAL', message: 'Internal error.', ...extra });
  const call = async (factory) => {
    reset();
    const api = await freshApi();
    service({ 'PUT /api/me/display-name': [factory] });
    return api.setDisplayName('Ada');
  };

  const r = await call(internal({ requestId: ID }));
  assert.deepEqual(r, {
    ok: false,
    status: 500,
    code: 'E_INTERNAL',
    message: 'Internal error.',
    action: 'retry',
    requestId: ID,
  });
  assert.deepEqual(Object.keys(r), ['ok', 'status', 'code', 'message', 'action', 'requestId']);

  for (const bad of [undefined, 42, null, {}, ['a'], '', 'a b', 'x'.repeat(65), '<b>id</b>', 'undefined '])
    assert.equal(Object.hasOwn(await call(internal({ requestId: bad })), 'requestId'), false, JSON.stringify(bad));
  for (const [status, code] of [
    [403, 'E_FORBIDDEN'],
    [409, 'E_BUSY'],
    [503, 'E_MAINTENANCE'],
  ])
    assert.equal(
      Object.hasOwn(await call(answer(status, { ok: false, code, message: 'x', requestId: ID })), 'requestId'),
      false,
      code,
    );
  const unreadable = await call(() => new Response('not json', { status: 500 }));
  assert.equal(Object.hasOwn(unreadable, 'requestId'), false, 'an unreadable answer');
  assert.equal(Object.hasOwn(await call(internal({ requestId: ID, other: 'kept?' })), 'other'), false, 'no other key');

  /* The shape is written twice, because nothing under web/ imports lib/: the page's copy must be the server's. */
  const shapeIn = (rel) => /\nconst REQUEST_ID = (\/.+\/);\n/.exec(readFileSync(join(REPO, rel), 'utf8'))?.[1];
  assert.ok(shapeIn('lib/http/alerts.mjs'), "the server's shape is found");
  assert.equal(shapeIn('web/assets/app/api.mjs'), shapeIn('lib/http/alerts.mjs'), "api.mjs's copy is the server's");
});

/* HB-F2 (migration 012; the design critique's HB-C4): an account whose wrong second-factor codes are spent is told when
   it may try again. Only that code returns retryAfter, only an ISO time in UTC, and the answer offers no retry. */
test("HB-F2: send() returns E_MFA_ATTEMPTS_EXHAUSTED's retryAfter when it is an ISO UTC time, and no other answer's", async () => {
  const AT = '2026-10-24T10:15:00.000Z';
  const answer = (status, value) => () => json(status, value);
  const exhausted = (extra) =>
    answer(429, {
      ok: false,
      code: 'E_MFA_ATTEMPTS_EXHAUSTED',
      message: messageFor('E_MFA_ATTEMPTS_EXHAUSTED'),
      ...extra,
    });
  const call = async (factory) => {
    reset();
    const api = await freshApi();
    service({ 'PUT /api/me/display-name': [factory] });
    return api.setDisplayName('Ada');
  };
  const r = await call(exhausted({ retryAfter: AT }));
  assert.equal(r.retryAfter, AT);
  assert.equal(r.action, 'message', 'no retry: before that time the answer would be the same');
  for (const bad of [undefined, 42, '', 'soon', '2026-10-24 10:15:00', `${AT}<b>`, '2026-10-24T10:15:00+02:00'])
    assert.equal(Object.hasOwn(await call(exhausted({ retryAfter: bad })), 'retryAfter'), false, JSON.stringify(bad));
  const rate = await call(answer(429, { ok: false, code: 'E_RATE_LIMITED', message: 'x', retryAfter: AT }));
  assert.equal(Object.hasOwn(rate, 'retryAfter'), false, "GoTrue's per-address 429 carries no window");
});

function webFiles(dir = join(REPO, 'web'), rel = 'web') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...webFiles(join(dir, entry.name), `${rel}/${entry.name}`));
    else out.push(`${rel}/${entry.name}`);
  }
  return out;
}

test('U8: no string under web/ equals a message of lib/errors.mjs, and no longer message appears in any file', () => {
  const messages = new Set(Object.keys(CODES).map(messageFor));
  const literals = [];
  for (const rel of webFiles()) {
    const text = readFileSync(join(REPO, rel), 'utf8');
    if (rel.endsWith('.mjs')) {
      for (const m of text.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g))
        for (const part of (m[1] ?? m[2] ?? m[3]).split(/\$\{[^}]*\}/)) literals.push([rel, part.trim()]);
    }
    if (rel.endsWith('.html')) for (const m of text.matchAll(/>([^<]+)</g)) literals.push([rel, m[1].trim()]);
    for (const message of messages)
      if (message.length >= 16) assert.equal(text.includes(message), false, `${rel} contains "${message}"`);
  }
  assert.ok(literals.length > 50, 'the scan read the strings of web/');
  for (const [rel, value] of literals)
    assert.equal(messages.has(value), false, `${rel}: "${value}" is a server message`);
});
