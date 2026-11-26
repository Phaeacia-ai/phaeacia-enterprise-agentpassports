/* S11f, the fail-closed case of the account bound (pages design 2.8 part 5, 7.2): with the hook function dropped on
   the shared local stack, a verification fails rather than succeeding unbounded, and the function is restored in the
   same phase. A lead-scheduled destructive phase (lead decision 4 of 2026-09-12, carried in the design's revision 3):
   the lead runs it, never a worker, and it is kept out of tests/e2/stack/ because it alters the shared stack's schema
   for the length of one verification. Run: node --test --test-concurrency=1 tests/e2/phases/s11f.test.mjs (it reseeds).

   Method: read the hook's definition out of migration 004's own text (from its create or replace to its grant), so the
   restore is the accepted bytes and not a copy; drop the function; send one wrong code through the application's
   verify route and assert the answer is neither the code check's 422 nor a 204, that the factor stays unverified and
   that no window row was written; restore, in a finally, and assert the next wrong code is judged again (422, one
   failure recorded). The counterexample is a fail-open hook invocation, where a missing function lets the code check
   run unbounded. The configuration's SHA-256 is recorded with the observation. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { caller, configSha256, linkSession, newAccount, ROOT, sql, wrongCode } from '../helpers/pages.mjs';
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

const hookExists = () =>
  sql(
    "select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'hook_mfa_verification_attempt'",
  );
const failures = (userId) =>
  sql(`select coalesce((select failures::text from app.mfa_attempt_windows where user_id = '${userId}'), 'none')`);

test('S11f with the hook function dropped, a verification fails rather than succeeding unbounded; the function is restored in the same phase', async (t) => {
  t.diagnostic(`S11f configuration sha256 ${configSha256()}`);
  const account = newAccount('s11f');
  const session = await linkSession(call, account.email);
  const e = await call('factorsEnroll', session);
  assert.equal(e.status, 201);
  const factorId = e.body.factorId;
  const attempt = () =>
    call('factorsVerify', {
      access: session.access,
      refresh: session.refresh,
      params: { factorId },
      body: { code: wrongCode(e.body.secret) },
    });
  assert.equal(hookExists(), '1', 'precondition: the hook is installed');
  sql('drop function app.hook_mfa_verification_attempt(jsonb)');
  try {
    assert.equal(hookExists(), '0', 'the hook is dropped for this one verification');
    const r = await attempt();
    t.diagnostic(`S11f with the hook dropped: ${r.status} ${r.body?.code ?? ''}`);
    assert.notEqual(r.status, 204, 'fail-closed: the verification does not succeed');
    assert.notEqual(r.status, 422, 'fail-closed: the code check is not reached unbounded');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'E_MFA_UNAVAILABLE');
    assert.equal(sql(`select status from auth.mfa_factors where id = '${factorId}'`), 'unverified');
    assert.equal(failures(account.id), 'none', 'no window row was written without the hook');
  } finally {
    sql(HOOK_DEFINITION);
  }
  assert.equal(hookExists(), '1', 'restored from the migration text');
  const again = await attempt();
  assert.equal(again.status, 422, 'restored: the code check is judged again');
  assert.equal(again.body.code, 'E_MFA_CODE_INVALID');
  assert.equal(failures(account.id), '1');
});
