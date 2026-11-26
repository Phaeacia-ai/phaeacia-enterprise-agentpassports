/* Pages construction, the per-account bound on failed verifications driven through GoTrue (pages design 2.8 and 7.2):
   S11a to S11e, S11g and S11h. S11f, the fail-closed case with the hook function dropped and restored, is the lead's
   destructive phase and is not here, nor is Q1-14, the hook-off phase that observes residual R3 (HB-F2,
   tests/e2/phases/q1-14.test.mjs). Reseeds once. Each case uses a fresh account with a link session and an
   unverified TOTP factor enrolled through the route; the hook's state is read by the migration owner. Wrong codes are
   chosen outside every period GoTrue accepts, so a wrong guess can never be valid. The configuration's SHA-256 is
   recorded. */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import { test } from 'node:test';

import {
  aalOf,
  caller,
  configSha256,
  gotrueDirect,
  linkSession,
  newAccount,
  ROOT,
  sourcesNaming,
  sql,
  totp,
  wrongCode,
} from '../helpers/pages.mjs';
import { seed, sleep } from '../helpers/stack.mjs';
import { moduleReferences } from '../../../scripts/check-imports.mjs';

seed();
/* E7 (evidence/e7-scripts.md; the lead, 2026-09-20): lib/operator/takeout.mjs names the bound's table once, in the
   `omitted` list of the owner-side copy, to say the copy does not carry it; it is not a reader, holds no client and
   builds SQL text a script runs as the owner. It is excluded by name and asserted not to query the table; every
   other lib/ and netlify/ module stays under the "no second reader" scan. */
const OMITS_ONLY = 'lib/operator/takeout.mjs';
function readersNaming(needle) {
  const takeout = readFileSync(join(ROOT, OMITS_ONLY), 'utf8');
  assert.doesNotMatch(
    takeout,
    /* E7Y-C-F1 (evidence/e7-critique-remainder.md): SQL keywords are case-insensitive, so the scan is too. The first
       version matched lowercase only, and `SELECT count(*) FROM app.mfa_attempt_windows` in snapshotSql passed it. */
    new RegExp(`(from|join|update|into|table|using)\\s+(only\\s+)?app\\.${needle}`, 'i'),
    `${OMITS_ONLY} only names the table it omits`,
  );
  return sourcesNaming(needle).filter((f) => f !== OMITS_ONLY);
}
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { END_BOUND_MS } = await import('../../../lib/services/factor-bound.mjs');

const routes = makeRoutes({ log: () => {} });
const { call } = caller(routes, { COOKIES, makeRequest });
const failures = (userId) =>
  sql(`select coalesce((select failures::text from app.mfa_attempt_windows where user_id = '${userId}'), 'none')`);
/* HB-F2 (migration 012; evidence/ena7-end1-hbf2.md sections 3, 5 and 7): the route has its own bound, which applies
   wherever the route is called, so on the local stack, where the hook is also on, a route call meets both: the
   route's begin first, then GoTrue and its hook. `failures` above reads the hook's table; this reads the route's. The
   hook's own assertions are made through GoTrue's endpoint directly, as S11b does, because a route call that the
   route's bound refuses never reaches the hook. */
const routeFailures = (userId) =>
  sql(`select coalesce((select failures::text from app.mfa_route_attempts where user_id = '${userId}'), 'none')`);
/* One verification sent straight to GoTrue with the caller's own bearer: a fresh challenge, then the code. */
async function direct(a, code, factorId = a.factorId) {
  const challenge = await gotrueDirect('POST', `/factors/${factorId}/challenge`, a.session.access, {});
  assert.equal(challenge.status, 200, 'the direct challenge');
  return gotrueDirect('POST', `/factors/${factorId}/verify`, a.session.access, {
    challenge_id: challenge.json.id,
    code,
  });
}

async function enrolled(tag) {
  const account = newAccount(tag);
  const session = await linkSession(call, account.email);
  const e = await call('factorsEnroll', session);
  assert.equal(e.status, 201, `${tag}: enrolment answered ${e.status}`);
  return {
    ...account,
    session,
    factorId: e.body.factorId,
    secret: e.body.secret,
    secrets: { [e.body.factorId]: e.body.secret },
  };
}
const attempt = (a, code, factorId = a.factorId) =>
  call('factorsVerify', { access: a.session.access, refresh: a.session.refresh, params: { factorId }, body: { code } });
const wrong = (a, factorId = a.factorId) => attempt(a, wrongCode(a.secrets[factorId]), factorId);
const right = (a, factorId = a.factorId) => attempt(a, totp(a.secrets[factorId]), factorId);

let exhausted;
test('S11a five wrong codes answer 422 E_MFA_CODE_INVALID and the sixth answers 429 E_MFA_ATTEMPTS_EXHAUSTED from the route s own bound', async (t) => {
  t.diagnostic(`S11 configuration sha256 ${configSha256()}`);
  exhausted = await enrolled('s11a');
  for (let i = 1; i <= 5; i++) {
    const r = await wrong(exhausted);
    assert.equal(r.status, 422, `attempt ${i}`);
    assert.equal(r.body.code, 'E_MFA_CODE_INVALID', `attempt ${i}`);
  }
  assert.equal(failures(exhausted.id), '5');
  assert.equal(routeFailures(exhausted.id), '5', 'the route counted the same five');
  /* HB-F2: the route's bound refuses the sixth before GoTrue, so it never reaches the hook. Until 012 this was the
     hook's 429, answered E_RATE_LIMITED; S11b and S11d show the hook's own refusal through GoTrue directly. */
  const sixth = await wrong(exhausted);
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.code, 'E_MFA_ATTEMPTS_EXHAUSTED');
  assert.match(sixth.body.retryAfter, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'with the window s end');
  assert.equal(failures(exhausted.id), '5', 'a refusal does not count');
  assert.equal(routeFailures(exhausted.id), '5');
});

test('S11b the sixth attempt sent directly to GoTrue s public endpoint with the caller s own bearer is refused by the hook, and no application code reads the bound', async () => {
  const b = await enrolled('s11b');
  for (let i = 1; i <= 5; i++) assert.equal((await wrong(b)).status, 422, `attempt ${i}`);
  const challenge = await gotrueDirect('POST', `/factors/${b.factorId}/challenge`, b.session.access, {});
  assert.equal(challenge.status, 200);
  const direct = await gotrueDirect('POST', `/factors/${b.factorId}/verify`, b.session.access, {
    challenge_id: challenge.json.id,
    code: wrongCode(b.secret),
  });
  assert.equal(direct.status, 429, 'GoTrue itself refuses: the rule is inside the provider');
  assert.equal(failures(b.id), '5');
  assert.deepEqual(readersNaming('mfa_attempt_windows'), [], 'no lib/ or netlify/ module names the bound s table');
});

test('S11c ten verifications fired simultaneously against a fresh account: at most five reach mfa_verification_failed and the rest are refused', async (t) => {
  /* Lead correction, 2026-09-14 (evidence/e1-lead.md, "The pages-server stack phases"): the lane's version fired ten
     route calls at once, and each route call creates its own challenge before it verifies. Ten concurrent challenge
     creations for one factor deadlock inside GoTrue itself ("deadlock detected (SQLSTATE 40P01)" on
     /factors/{id}/challenge, answered 500, mapped to 503 E_MFA_UNAVAILABLE): eight of ten answered 503 and never
     reached the hook. That is a GoTrue limit at the challenge step, not the bound. What S11c exists to show is the
     bound's atomicity under concurrent verifications, so the ten challenges are created one after another through
     GoTrue's own endpoint with the caller's bearer, as S11b does, and only the ten verifications race. The
     counterexample is unchanged: a non-atomic counter lets more than five reach the code check. */
  const c = await enrolled('s11c');
  const challenges = [];
  for (let i = 0; i < 10; i++) {
    const ch = await gotrueDirect('POST', `/factors/${c.factorId}/challenge`, c.session.access, {});
    assert.equal(ch.status, 200, `challenge ${i + 1}`);
    challenges.push(ch.json.id);
  }
  const results = await Promise.all(
    challenges.map((challengeId) =>
      gotrueDirect('POST', `/factors/${c.factorId}/verify`, c.session.access, {
        challenge_id: challengeId,
        code: wrongCode(c.secret),
      }),
    ),
  );
  const statuses = results.map((r) => r.status).sort();
  const invalid = results.filter((r) => r.status === 422 && r.json?.error_code === 'mfa_verification_failed').length;
  const refused = results.filter((r) => r.status === 429).length;
  t.diagnostic(`S11c statuses ${statuses.join(',')}`);
  assert.ok(invalid <= 5, `${invalid} reached the code check: ${statuses}`);
  assert.equal(invalid + refused, 10, `every attempt was one or the other: ${statuses}`);
  assert.equal(Number(failures(c.id)), invalid);
  /* The route, for the record: one further wrong code through the application answers the hook's 429 as E_RATE_LIMITED. */
  const viaRoute = await wrong(c);
  assert.equal(viaRoute.status, 429);
  assert.equal(viaRoute.body.code, 'E_RATE_LIMITED');
});

test('S11c-route (PM-C-F1) ten verifications through the application route at once: every answer is a counted 422, a 429 or a 503 GoTrue gave no code decision for, and the budget closes at five judged codes', async (t) => {
  /* PM-C-F1 (evidence/pages-milestone-critique.md): S11c above races verifications at GoTrue directly, because ten route
     calls create ten challenges and GoTrue deadlocks on concurrent challenge creation for one factor, which the route
     answers 503. That leaves the application route's own concurrency untested, and a 503 could hide an uncounted
     decision: a verification GoTrue judged, whose answer the route turned into an availability refusal. Here every
     GoTrue request is attributed to the call that made it, with GoTrue's status, so each answer is held to what GoTrue
     said: a 422 had one verification GoTrue answered 422; a 429 ended at a GoTrue 429; a 503 carried no GoTrue 4xx on any
     verification. The hook's counter then holds the 422s, and at most one more for each verify fetch that threw
     (CR-Q114-2), the rest of the budget is spent one call at a time, and a correct code after it is refused. How the
     race splits between 422 and 503 is GoTrue's schedule and is recorded as a diagnostic, not asserted. */
  const a = await enrolled('s11c-route');
  const calls = new AsyncLocalStorage();
  const seen = Array.from({ length: 10 }, () => []);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const i = calls.getStore();
    const path = new URL(String(url)).pathname;
    const step = path.slice(path.lastIndexOf('/') + 1);
    const watched = i !== undefined && path.startsWith('/auth/v1/factors/');
    let answer;
    try {
      answer = await originalFetch(url, init);
    } catch (error) {
      /* HBF2-R-I3: a fetch that throws is recorded too. At the verify stage the closed rule counts it as a wrong code,
         because GoTrue may have judged a request whose answer was lost, so the route's counter below holds it and the
         hook's may. */
      if (watched) seen[i].push({ step, status: 'threw' });
      throw error;
    }
    if (watched) seen[i].push({ step, status: answer.status });
    return answer;
  };
  let results;
  try {
    results = await Promise.all(seen.map((_, i) => calls.run(i, () => wrong(a))));
  } finally {
    globalThis.fetch = originalFetch;
  }
  const tally = {};
  results.forEach((r, i) => {
    const verifies = seen[i].filter((s) => s.step === 'verify');
    const stage = seen[i].at(-1);
    tally[`${r.status} at ${stage?.step} ${stage?.status}`] =
      (tally[`${r.status} at ${stage?.step} ${stage?.status}`] ?? 0) + 1;
    if (r.status === 422) {
      assert.equal(r.body.code, 'E_MFA_CODE_INVALID', `call ${i}`);
      assert.deepEqual(
        verifies.map((s) => s.status),
        [422],
        `call ${i}: one verification, judged by GoTrue`,
      );
    } else if (r.status === 429 && r.body.code === 'E_MFA_ATTEMPTS_EXHAUSTED') {
      /* HB-F2: the route's bound refused this call before GoTrue: no GoTrue request at all. */
      assert.deepEqual(seen[i], [], `call ${i}: refused by the route's bound, GoTrue never called`);
    } else if (r.status === 429) {
      assert.equal(r.body.code, 'E_RATE_LIMITED', `call ${i}`);
      assert.equal(stage?.status, 429, `call ${i}: GoTrue itself refused`);
    } else {
      assert.equal(r.status, 503, `call ${i}: ${r.status}`);
      assert.equal(r.body.code, 'E_MFA_UNAVAILABLE', `call ${i}`);
      assert.ok(
        verifies.every((s) => s.status === 'threw' || s.status >= 500),
        `call ${i}: a 503 with a GoTrue code decision behind it: ${JSON.stringify(seen[i])}`,
      );
    }
  });
  t.diagnostic(`S11c-route answers ${JSON.stringify(tally)}`);
  const judged = results.filter((r) => r.status === 422).length;
  assert.ok(judged >= 1 && judged <= 5, `${judged} codes judged in the race`);
  /* CR-Q114-2: the hook counted every code GoTrue judged, and also a verify whose answer was lost after GoTrue judged
     it. A verify fetch that threw is either that or one GoTrue never saw, and nothing here tells which, so the hook's
     counter holds the judged codes and at most one more for each verify that threw. */
  const threw = seen.flat().filter((s) => s.step === 'verify' && s.status === 'threw').length;
  const hookCount = Number(failures(a.id));
  assert.ok(
    hookCount >= judged && hookCount <= judged + threw,
    `the hook s counter holds the judged codes, and at most the ${threw} verifies that threw besides: ${hookCount}`,
  );
  /* HB-F2: the route's counter holds the judged codes plus every verification that came back with no code decision, a
     5xx or a fetch that threw. The route counts each of these whether or not GoTrue judged its code (the closed rule,
     HB-C1), where the hook counts only what GoTrue judged, as above; a challenge-stage 503 was refunded. */
  const verifyStageCounted = results.filter(
    (r, i) => r.status === 503 && seen[i].some((s) => s.step === 'verify' && (s.status === 'threw' || s.status >= 500)),
  ).length;
  /* HBF2-R-I3: the route answers once its end has settled or after END_BOUND_MS, whichever is first, so an end that
     lands later, an undecided one's refund, can still move the counter after every call has answered. The counter is
     read until it holds what the answers account for, for twice the bound, and asserted then. */
  const expected = judged + verifyStageCounted;
  const deadline = Date.now() + 2 * END_BOUND_MS;
  while (Number(routeFailures(a.id)) !== expected && Date.now() < deadline) await sleep(100);
  assert.equal(Number(routeFailures(a.id)), expected, 'the route s counter');
  while (Number(routeFailures(a.id)) < 5) assert.equal((await wrong(a)).status, 422, 'a sequential judged code');
  const after = await right(a);
  assert.equal(after.status, 429, 'a correct code after the budget is spent is refused');
  assert.equal(after.body.code, 'E_MFA_ATTEMPTS_EXHAUSTED');
  assert.equal(routeFailures(a.id), '5');
});

test('S11d a correct code on the sixth attempt is still refused; a correct code on the fifth succeeds and resets the budget', async () => {
  const x = await enrolled('s11d-sixth');
  for (let i = 1; i <= 5; i++) assert.equal((await wrong(x)).status, 422);
  const sixth = await right(x);
  assert.equal(sixth.status, 429, 'the budget is checked before valid');
  assert.equal(sixth.body.code, 'E_MFA_ATTEMPTS_EXHAUSTED', 'by the route s own bound (HB-F2)');
  /* The hook's half, through GoTrue directly: a correct sixth code is refused by the hook too, so the hook still
     checks its budget before `valid`, which is what a later Team plan relies on. */
  const hook = await direct(x, totp(x.secret));
  assert.equal(hook.status, 429, 'the hook refuses a correct sixth code');
  assert.equal(sql(`select status from auth.mfa_factors where id = '${x.factorId}'`), 'unverified');
  assert.equal(await aalOf(x.session.access), 'aal1');

  const y = await enrolled('s11d-fifth');
  for (let i = 1; i <= 4; i++) assert.equal((await wrong(y)).status, 422);
  const fifth = await right(y);
  assert.equal(fifth.status, 204);
  assert.equal(failures(y.id), '0', 'a valid attempt resets the budget');
  y.session = { access: fifth.access, refresh: fifth.refresh };
  assert.equal((await wrong(y)).status, 422, 'the next failure counts from one');
  assert.equal(failures(y.id), '1');
});

test('S11e a second factor of the same account shares its budget; another account does not', async () => {
  const z = await enrolled('s11e');
  const second = await call('factorsEnroll', z.session);
  assert.equal(second.status, 201);
  const f2 = second.body.factorId;
  z.secrets[f2] = second.body.secret;
  for (let i = 1; i <= 3; i++) assert.equal((await wrong(z)).status, 422, `first factor ${i}`);
  for (let i = 1; i <= 2; i++) assert.equal((await wrong(z, f2)).status, 422, `second factor ${i}`);
  assert.equal(failures(z.id), '5');
  assert.equal((await wrong(z, f2)).status, 429, 'the second factor, sixth attempt');
  assert.equal((await wrong(z)).status, 429, 'the first factor, too');
  assert.equal(
    (await direct(z, wrongCode(z.secrets[f2]), f2)).status,
    429,
    'and the hook, directly, on the second factor',
  );
  const w = await enrolled('s11e-other');
  const first = await wrong(w);
  assert.equal(first.status, 422, 'another account s first wrong code');
  assert.equal(failures(w.id), '1');
  assert.equal(failures(z.id), '5');
});

test('S11g after the window passes (moved into the past by the migration owner) the next attempt is allowed again', async () => {
  assert.equal((await wrong(exhausted)).status, 429, 'control: still inside the window');
  /* HB-F2: both windows, the hook's and the route's, are moved; either alone still refuses. */
  sql(
    `update app.mfa_attempt_windows set window_started_at = now() - interval '15 minutes 1 second' where user_id = '${exhausted.id}'`,
  );
  sql(
    `update app.mfa_route_attempts set window_started_at = now() - interval '15 minutes 1 second' where user_id = '${exhausted.id}'`,
  );
  const next = await wrong(exhausted);
  assert.equal(next.status, 422, 'a wrong code is judged again');
  assert.equal(failures(exhausted.id), '1', 'and starts a new window');
  assert.equal(routeFailures(exhausted.id), '1', 'in both counters');
  const valid = await right(exhausted);
  assert.equal(valid.status, 204);
});

test('S11h no application path reads app.mfa_attempt_windows: no grant to anon, authenticated or app_server, no module names it, and the capability holders are unchanged', () => {
  assert.equal(
    sql(
      "select bool_or(has_table_privilege(r, 'app.mfa_attempt_windows', p)) from unnest(array['anon', 'authenticated', 'app_server']) r, unnest(array['select', 'insert', 'update', 'delete']) p",
    ),
    'f',
  );
  assert.equal(
    sql(
      "select count(*) from information_schema.table_privileges where table_schema = 'app' and table_name = 'mfa_attempt_windows' and grantee in ('anon', 'authenticated', 'app_server')",
    ),
    '0',
  );
  assert.deepEqual(readersNaming('mfa_attempt_windows'), []);
  /* HB-F2 (migration 012; Q1-9 of evidence/ena7-end1-hbf2.md section 4, review finding F5): the route's two tables
     likewise, granted to nobody and named by no module. Only 012's two SECURITY DEFINER routines touch them, which
     lib/services/factor-bound.mjs calls by name. */
  for (const table of ['mfa_route_attempts', 'mfa_route_reservations']) {
    assert.equal(
      sql(
        `select count(*) from information_schema.table_privileges where table_schema = 'app' and table_name = '${table}' and grantee in ('anon', 'authenticated', 'app_server', 'app_maintenance')`,
      ),
      '0',
      table,
    );
    assert.deepEqual(readersNaming(table), [], table);
  }
  const holders = [];
  /* Separators made '/' (F10): readdirSync names a nested file with the platform's, and on Windows every holder in a
     subdirectory came out unmatched, so the list below could not have passed there. */
  for (const f of readdirSync(join(ROOT, 'lib'), { recursive: true })
    .map((name) => String(name).split(sep).join('/'))
    .sort()) {
    if (!f.endsWith('.mjs')) continue;
    const rel = `lib/${f}`;
    const targets = moduleReferences(readFileSync(join(ROOT, rel), 'utf8'))
      .specifiers.filter(({ spec }) => spec.startsWith('.'))
      .map(({ spec }) => posix.join(posix.dirname(rel), spec));
    if (targets.some((t) => t === 'lib/db/operator.mjs' || t === 'lib/db/server.mjs')) holders.push(rel);
  }
  /* E4 design 2.6 item 6: the three E4 holders joined this list in the E4 server lane, as they joined
     PINNED_HOLDER_EXPORTS in tests/e2/unit/boundaries.test.mjs (lent by the lead, 2026-09-15). E5 design 2.6 item 5:
     lib/services/catalog.mjs and lib/services/installations.mjs joined both in the E5 server lane.
     lib/services/evidence-reads.mjs is not here and does not join: it holds the user client only. E6 design 2.6
     item 5: lib/services/agents.mjs, lifecycle.mjs and takeout.mjs joined in the E6 services lane, and
     lib/operator/accounts.mjs joined as the first module of lib/operator/, which is the directory E1 reserved for
     exactly this and which no route can reach. lib/services/quotas.mjs is NOT here, for evidence-reads.mjs's
     reason: it holds the user client only. HB-F2 (migration 012): lib/services/factor-bound.mjs joined, the verify
     route's holder of the bound's two routines, because lib/http/ may not reach lib/db/. */
  assert.deepEqual(holders, [
    'lib/operator/accounts.mjs',
    'lib/services/agents.mjs',
    'lib/services/candidates.mjs',
    'lib/services/catalog.mjs',
    'lib/services/factor-bound.mjs',
    'lib/services/groups.mjs',
    'lib/services/installations.mjs',
    'lib/services/invitations.mjs',
    'lib/services/lifecycle.mjs',
    'lib/services/members.mjs',
    'lib/services/operator.mjs',
    'lib/services/profiles.mjs',
    'lib/services/releases.mjs',
    'lib/services/reviews.mjs',
    'lib/services/takeout.mjs',
  ]);
});
