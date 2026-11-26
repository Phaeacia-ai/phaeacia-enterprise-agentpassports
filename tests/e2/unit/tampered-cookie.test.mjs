/* HTTP-D1's boundary, guarded: a request whose signed cookie does not verify is refused 401 before a
   single byte of its body is pulled, on a JSON route and on a passport route, with a counting stream
   and with a failing one. The Codex critique of HTTP-D1 (evidence/http-d1-critique.md, C4) built a
   one-line mutant that awaits request.readBody() in the invalid-session branch before logging the
   refusal: the response stays 401, the stream is consumed, and every other test in this directory
   stayed green. Missing-cookie coverage does not reach that branch; this does. The fixture is the
   critic's, retained by the lead with plain specifiers. Synthetic token material only. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hs256, userClaims } from '../helpers/jwt.mjs';

const SECRET = 'example-unit-secret-with-at-least-32-characters-long';
const BASE = 'http://127.0.0.1:54321';
process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = SECRET;
process.env.ENTERPRISE_ACCESS_STATE = 'open';

const { COOKIES } = await import('../../../lib/session.mjs');
const { route } = await import('../../../lib/http/pipeline.mjs');
const { toNetlify } = await import('../../../lib/http/netlify.mjs');
const { json } = await import('../../../lib/http/response.mjs');

const SUB = '2a5d1b3c-4e6f-4a8b-9c0d-1e2f3a4b5c6d';
/* Signed with the wrong secret: a well-formed cookie that verifySession refuses as E_SESSION_INVALID. */
const tampered = hs256(
  userClaims({ sub: SUB, email: 'unit@example.invalid', issuer: `${BASE}/auth/v1` }),
  `${SECRET}-wrong`,
);

for (const mode of ['json', 'passport']) {
  for (const failing of [false, true]) {
    test(`tampered cookie on a ${mode} route with a ${failing ? 'failing' : 'counted'} stream: 401 and zero pulls`, async () => {
      let pulls = 0;
      let handled = 0;
      const stream = new ReadableStream(
        {
          pull(controller) {
            pulls++;
            if (failing) return controller.error(new Error('synthetic transport failure'));
            controller.enqueue(new Uint8Array(1024).fill(0x61));
          },
        },
        { highWaterMark: 0 },
      );
      const handler = route(
        {
          method: 'POST',
          path: '/api/probe',
          body: mode,
          handle() {
            handled++;
            return json(200, { ok: true });
          },
        },
        { log() {} },
      );
      handler.routeName = 'unitTampered';
      const req = new Request('https://enterprise.example.invalid/api/probe', {
        method: 'POST',
        headers: {
          cookie: `${COOKIES.access}=${tampered}`,
          'content-type': mode === 'json' ? 'application/json' : 'text/markdown',
        },
        body: stream,
        duplex: 'half',
      });
      const res = await toNetlify(handler)(req, { params: {} });
      const body = await res.json();
      assert.deepEqual([res.status, body.code], [401, 'E_UNAUTHENTICATED']);
      assert.equal(pulls, 0, `the stream was pulled ${pulls} time(s) behind a refused cookie`);
      assert.equal(handled, 0);
    });
  }
}
