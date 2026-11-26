/* Q1-14, residual R3 observed (evidence/hosted-blockers.md 5.1; evidence/ena7-end1-hbf2.md sections 3 and 9): with the
   MFA verification hook off, as it is on the hosted project, the route's own bound (migration 012) refuses a sixth
   wrong code, and a sixth wrong code sent straight to GoTrue's verify endpoint with the caller's own bearer is still
   judged. A lead-scheduled destructive phase in S11f's style: the lead runs it, never a worker, and it is kept out of
   tests/e2/stack/ because it alters the shared stack's schema for the length of the phase.
   Run: node --test --test-concurrency=1 tests/e2/phases/q1-14.test.mjs (it reseeds).

   How the hook is off. GoTrue reads [auth.hook.mfa_verification_attempt] only at `supabase start`, so the hosted
   state, no hook configured, is reachable locally only by a configuration change and a stack restart. S11f's drop is a
   different state: GoTrue still calls the hook, the call fails and the verification fails closed (503). This phase
   instead replaces the function, for its length, with one that answers {"decision": "continue"} and writes nothing.
   GoTrue v2.192.0 calls the hook only to let it refuse: on continue, verifyTOTPFactor goes on exactly as with the hook
   disabled, to its 422 mfa_verification_failed for a wrong code (mfa.go lines 594 to 656, in
   evidence/hosted-blockers-repro/pages/gotrue-v2.192.0-mfa.txt). What is left of the hook is the call itself, which no
   assertion here depends on. The configuration and its SHA-256 stay those of pages design 2.7, and nothing restarts.

   Method: read the hook's definition out of migration 004's own text, as S11f does, so the restore is the accepted
   bytes. Show first, on a control account, that GoTrue calls the hook in this configuration and the hook counts. Then
   install the pass-through; five wrong codes through the verify route, each judged and counted by the route alone; the
   sixth through the route refused by 012's bound with the window's end; a sixth wrong code sent directly (each code is
   drawn afresh by wrongCode), judged 422, with the route's counter unmoved and the factor unverified. Restore, in a
   finally, and assert the hook counts a direct wrong code again. Both counterexamples fail before any sixth code is
   sent. Without 012 the first precondition, "migration 012 is applied", fails; past it, every route call would answer
   503 E_MFA_UNAVAILABLE, because beginVerification has no routine to call, and the route's sixth is judged (422) only
   by the code from before 717815d. With the hook in force the five route codes reach it, so "the hook counted none"
   fails at five, and a direct sixth would be refused (S11b's 429). A crash between the replacement and the restore
   leaves the shared stack's hook failing open, unlike S11f's, until the next reseed: tests/db/00-seed.sh runs
   `supabase db reset`, which applies 004 again, and every E2 stack file and phase reseeds before its first case. Probe
   20b, which calls the hook directly, would show the stand-in if run alone before then. The configuration's SHA-256
   and the method are recorded with the observation. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  caller,
  configSha256,
  gotrueDirect,
  linkSession,
  newAccount,
  ROOT,
  sql,
  wrongCode,
} from '../helpers/pages.mjs';
import { seed } from '../helpers/stack.mjs';

seed();
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');

const routes = makeRoutes({ log: () => {} });
const { call } = caller(routes, { COOKIES, makeRequest });

const MIGRATION = readFileSync(join(ROOT, 'supabase', 'migrations', '004_content_rules_and_profiles.sql'), 'utf8');
const start = MIGRATION.indexOf('create or replace function app.hook_mfa_verification_attempt(event jsonb)');
const grantLine = 'grant execute on function app.hook_mfa_verification_attempt(jsonb) to supabase_auth_admin;';
const end = MIGRATION.indexOf(grantLine) + grantLine.length;
assert.ok(start > 0 && end > start, 'the hook definition is found in migration 004');
const HOOK_DEFINITION = MIGRATION.slice(start, end);
/* The stand-in. `create or replace` keeps the function's owner and its grant to supabase_auth_admin, and the parameter
   keeps its name, which a replacement may not change. */
const PASS_THROUGH = `create or replace function app.hook_mfa_verification_attempt(event jsonb) returns jsonb
language sql as $$ select '{"decision": "continue"}'::jsonb $$`;

/* Which hook body is installed: 004's is plpgsql and security definer, the stand-in neither. */
const hookForm = () =>
  sql(
    "select l.lanname || ' ' || p.prosecdef::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang where n.nspname = 'app' and p.proname = 'hook_mfa_verification_attempt'",
  );
const routeBound = () =>
  sql(
    "select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.proname in ('mfa_verify_begin', 'mfa_verify_end')",
  );
const failures = (userId) =>
  sql(`select coalesce((select failures::text from app.mfa_attempt_windows where user_id = '${userId}'), 'none')`);
const routeFailures = (userId) =>
  sql(`select coalesce((select failures::text from app.mfa_route_attempts where user_id = '${userId}'), 'none')`);

async function enrolled(tag) {
  const account = newAccount(tag);
  const session = await linkSession(call, account.email);
  const e = await call('factorsEnroll', session);
  assert.equal(e.status, 201, `${tag}: enrolment answered ${e.status}`);
  return { ...account, session, factorId: e.body.factorId, secret: e.body.secret };
}
const viaRoute = (a) =>
  call('factorsVerify', {
    access: a.session.access,
    refresh: a.session.refresh,
    params: { factorId: a.factorId },
    body: { code: wrongCode(a.secret) },
  });
/* One wrong code sent straight to GoTrue with the caller's own bearer: a fresh challenge, then the code (S11b). */
async function direct(a) {
  const challenge = await gotrueDirect('POST', `/factors/${a.factorId}/challenge`, a.session.access, {});
  assert.equal(challenge.status, 200, 'the direct challenge');
  return gotrueDirect('POST', `/factors/${a.factorId}/verify`, a.session.access, {
    challenge_id: challenge.json.id,
    code: wrongCode(a.secret),
  });
}

test('Q1-14 with the hook off, the route refuses a sixth wrong code (429 E_MFA_ATTEMPTS_EXHAUSTED) and GoTrue s verify endpoint, called directly with the caller s bearer, still judges a sixth (422): residual R3', async (t) => {
  t.diagnostic(`Q1-14 configuration sha256 ${configSha256()}`);
  t.diagnostic('Q1-14 method: the hook function replaced by a pass-through for the phase, restored from migration 004');
  assert.equal(routeBound(), '2', 'precondition: migration 012 is applied');
  assert.equal(hookForm(), 'plpgsql true', 'precondition: the installed hook is 004 s');
  /* So that it is the stand-in, and not the configuration, that takes the hook's bound away below. */
  const control = await enrolled('q1-14-control');
  assert.equal((await direct(control)).status, 422, 'precondition: a direct wrong code is judged');
  assert.equal(failures(control.id), '1', 'precondition: GoTrue calls the hook in this configuration');

  const a = await enrolled('q1-14');
  sql(PASS_THROUGH);
  try {
    assert.equal(hookForm(), 'sql false', 'the pass-through is installed for this phase');
    for (let i = 1; i <= 5; i++) {
      const r = await viaRoute(a);
      assert.equal(r.status, 422, `route attempt ${i}`);
      assert.equal(r.body.code, 'E_MFA_CODE_INVALID', `route attempt ${i}`);
    }
    assert.equal(routeFailures(a.id), '5', 'the route counted five');
    assert.equal(failures(a.id), 'none', 'the hook counted none: its bound is off');

    const sixth = await viaRoute(a);
    t.diagnostic(`Q1-14 the sixth through the route: ${sixth.status} ${sixth.body?.code ?? ''}`);
    assert.equal(sixth.status, 429, 'the route s own bound refuses the sixth');
    assert.equal(sixth.body.code, 'E_MFA_ATTEMPTS_EXHAUSTED');
    assert.match(sixth.body.retryAfter, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'with the window s end');
    assert.equal(routeFailures(a.id), '5', 'a refusal does not count');

    const residual = await direct(a);
    t.diagnostic(`Q1-14 the sixth sent directly to GoTrue: ${residual.status} ${residual.json?.error_code ?? ''} (R3)`);
    assert.equal(
      residual.status,
      422,
      'GoTrue judged the sixth code: without the hook nothing of ours bounds this path',
    );
    assert.equal(residual.json?.error_code, 'mfa_verification_failed');
    assert.equal(routeFailures(a.id), '5', 'the route s counter never sees the direct path');
    assert.equal(failures(a.id), 'none');
    assert.equal(sql(`select status from auth.mfa_factors where id = '${a.factorId}'`), 'unverified');
  } finally {
    sql(HOOK_DEFINITION);
  }
  assert.equal(hookForm(), 'plpgsql true', 'restored from the migration text');
  assert.equal((await direct(a)).status, 422, 'restored: a direct wrong code is judged');
  assert.equal(failures(a.id), '1', 'and counted by the hook again');
});
