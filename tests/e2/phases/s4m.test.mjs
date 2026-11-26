/* S4m, the refresh-token mode and the step-up boundary (pages design 2.9), a lead-scheduled phase kept out of
   tests/e2/stack/ on the lead's decision of 2026-09-14: in legacy mode it fails by design, and that must not turn the
   E2 stack gate red. Run: node --test --test-concurrency=1 tests/e2/phases/s4m.test.mjs (it reseeds).

   The first case reads, through the migration owner, whether a fresh session's auth.sessions row carries a
   refresh-token counter, and fails with the legacy message when it does not. No token, cookie or secret value is read,
   printed or compared; the answer is one boolean. The three timings each run on their own freshly stepped-up session,
   with the control, that session's own refresh which must work and stay aal2, before the destructive probe: immediately
   after the step-up, after the session has refreshed once more, and after the former 10-second reuse interval has
   passed since its last refresh. The probe presents the pre-step-up refresh token directly to GoTrue's token endpoint,
   so its sb-auth-refresh-token-reuse-cause header is observable, and asserts no usable session and no aal2 token
   result, and that the session is terminated. The last case records, without asserting, what the pre-step-up token does
   when no refresh follows the step-up, which the control-first ordering keeps the timings from seeing in legacy mode
   (evidence/pages-server.md). Each observation goes to .scratch/pages-server/s4m.json. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  aalOf,
  caller,
  claimsOf,
  configSha256,
  gotrueDirect,
  linkSession,
  newAccount,
  ROOT,
  sql,
  totp,
} from '../helpers/pages.mjs';
import { seed, sleep } from '../helpers/stack.mjs';

seed();
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');

const routes = makeRoutes({ log: () => {} });
const { call } = caller(routes, { COOKIES, makeRequest });
const observations = { configSha256: configSha256(), cases: [] };
const record = (t, entry) => {
  observations.cases.push(entry);
  t.diagnostic(`S4m ${JSON.stringify(entry)}`);
  mkdirSync(join(ROOT, '.scratch', 'pages-server'), { recursive: true });
  writeFileSync(join(ROOT, '.scratch', 'pages-server', 's4m.json'), `${JSON.stringify(observations, null, 2)}\n`);
};

async function steppedUp(tag) {
  const account = newAccount(tag);
  const signedIn = await linkSession(call, account.email);
  const enrolment = await call('factorsEnroll', signedIn);
  assert.equal(enrolment.status, 201, `${tag}: enrolment answered ${enrolment.status}`);
  const verified = await call('factorsVerify', {
    ...signedIn,
    params: { factorId: enrolment.body.factorId },
    body: { code: totp(enrolment.body.secret) },
  });
  assert.equal(verified.status, 204, `${tag}: step-up answered ${verified.status}`);
  return {
    preStepUpRefresh: signedIn.refresh,
    current: { access: verified.access, refresh: verified.refresh },
    sessionId: claimsOf(verified.access).session_id,
  };
}

async function control(state, label) {
  const r = await call('authRefresh', { refresh: state.current.refresh });
  assert.equal(r.status, 204, `${label}: the stepped-up session's own refresh works`);
  assert.equal(await aalOf(r.access), 'aal2', `${label}: and stays aal2`);
  state.current = { access: r.access, refresh: r.refresh };
}

async function probe(t, state, label, { assertBoundary = true } = {}) {
  const answer = await gotrueDirect('POST', '/token?grant_type=refresh_token', null, {
    refresh_token: state.preStepUpRefresh,
  });
  const issuedAal = typeof answer.json?.access_token === 'string' ? claimsOf(answer.json.access_token).aal : null;
  const sessionRows = sql(`select count(*) from auth.sessions where id = '${state.sessionId}'`);
  const current = await gotrueDirect('POST', '/token?grant_type=refresh_token', null, {
    refresh_token: state.current.refresh,
  });
  const entry = {
    label,
    status: answer.status,
    errorCode: answer.json?.error_code ?? null,
    issuedAal,
    reuseCause: answer.headers.get('sb-auth-refresh-token-reuse-cause'),
    sessionRowsAfterProbe: sessionRows,
    currentRefreshStatusAfterProbe: current.status,
  };
  record(t, entry);
  if (!assertBoundary) return;
  assert.notEqual(issuedAal, 'aal2', `${label}: the pre-step-up refresh token yielded an aal2 access token`);
  assert.ok(answer.status >= 400, `${label}: the pre-step-up refresh token produced a usable session`);
  assert.ok(
    sessionRows === '0' || current.status >= 400,
    `${label}: the session was not terminated under the 2.7 configuration`,
  );
}

test('S4m mode: a fresh session records whether it carries a refresh-token counter; legacy sessions cannot hold the step-up boundary', async (t) => {
  const account = newAccount('s4m-mode');
  const signedIn = await linkSession(call, account.email);
  const counter = sql(
    `select (refresh_token_counter is not null) from auth.sessions where id = '${claimsOf(signedIn.access).session_id}'`,
  );
  record(t, { label: 'mode', refreshTokenCounterPresent: counter });
  assert.equal(
    counter,
    't',
    'legacy sessions cannot hold the step-up boundary of pages design 2.9: a pre-step-up refresh token is accepted while it is the parent of the active one, and refresh_token_reuse_interval does not reach that branch',
  );
});

test('S4m timing 1, immediately after the step-up (control first): the pre-step-up refresh token is not a usable session, never aal2, and the session is terminated', async (t) => {
  const state = await steppedUp('s4m-t1');
  await control(state, 'timing 1');
  await probe(t, state, 'immediately after the step-up');
});

test('S4m timing 2, after the stepped-up session has refreshed once more: the same', async (t) => {
  const state = await steppedUp('s4m-t2');
  await control(state, 'timing 2');
  await control(state, 'timing 2, the further refresh');
  await probe(t, state, 'after the stepped-up session refreshed once more');
});

test('S4m timing 3, after the former 10-second reuse interval has passed since the last refresh: the same', async (t) => {
  const state = await steppedUp('s4m-t3');
  await control(state, 'timing 3');
  await sleep(11_000);
  await probe(t, state, 'after the former reuse interval elapsed');
});

test('S4m recorded, not asserted: the pre-step-up token presented with no refresh after the step-up', async (t) => {
  const state = await steppedUp('s4m-parent');
  await probe(t, state, 'no refresh after the step-up (recorded)', { assertBoundary: false });
});
