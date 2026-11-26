/* U8, the back-forward cache case, found by journey J12 on 2026-09-14. api.mjs stops sending once the page navigates,
   so queued session work is discarded (rule 6). A page restored from the back-forward cache keeps its module state, and
   before the correction it kept that stop as well: the members page restored after sign-out cleared its data, asked for
   GET /api/me, got 401, and then neither refreshed nor moved to sign-in, because every call answered "navigating".
   shell.startPage() now listens for pageshow with persisted and runs the restore listeners, and api.mjs clears the stop
   in one. Run in Node with an injected fetch, location, history, document and addEventListener, in a file of its own so
   its globals are not shared with web-modules.test.mjs. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const listeners = {};
const navigations = [];
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define('location', { hash: '', pathname: '/members/', search: '', assign: (target) => navigations.push(target) });
define('history', { replaceState: () => undefined });
define('document', { getElementById: (id) => ({ id }) });
define('addEventListener', (type, listener) => {
  listeners[type] ??= [];
  listeners[type].push(listener);
});

const APP = '../../../web/assets/app';

test('U8 restore: after the navigation that froze it, a page restored from the back-forward cache sends again', async () => {
  const shell = await import(`${APP}/shell.mjs`);
  const api = await import(`${APP}/api.mjs`);
  const sent = [];
  globalThis.fetch = async (path, init) => {
    sent.push(`${init.method} ${path}`);
    return new Response(JSON.stringify({ ok: true, user: { id: 'u', email: 'u@example.invalid', aal: 'aal1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  shell.startPage();
  shell.navigate('/signin/?reason=signed-out');
  assert.deepEqual(navigations, ['/signin/?reason=signed-out']);
  /* While the page is leaving, an ordinary call may still go out, and its answer is not acted on. */
  assert.equal((await api.me()).action, 'navigating', 'while the page is leaving, no answer is acted on');
  for (const listener of listeners.pageshow ?? []) listener({ persisted: false });
  assert.equal((await api.me()).action, 'navigating', 'an ordinary pageshow changes nothing');
  for (const listener of listeners.pageshow ?? []) listener({ persisted: true });
  const r = await api.me();
  assert.equal(r.ok, true, 'restored from the back-forward cache, the page acts on its answers again');
  assert.equal(r.data.user.id, 'u');
  assert.deepEqual(sent, ['GET /api/me', 'GET /api/me', 'GET /api/me']);
});
