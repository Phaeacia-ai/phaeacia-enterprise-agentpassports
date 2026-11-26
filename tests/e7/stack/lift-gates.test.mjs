/* E7X-C-F8 (evidence/e7-milestone-critique.md), on the running local stack: the critic's own sequence. An
   administrator enrols and verifies a TOTP factor; the register records that factor's deletion (the lost-second-
   factor procedure's line, the act after the backup) while the database still holds it, which is exactly a restored
   state; `begin` holds the company. On c0f5d8f `lift --apply` exited 0 and made the company active with the factor
   still present, and after a fresh sign-in that factor verified again at aal2 and the administrator took a copy of
   the company's records through the route.

   What this case asserts instead: the critic's exact lift is refused before anything opens (it carries no anchored
   head, and a lift now passes the gates plan passes); with the anchored head the lift is refused while the factor's
   deletion and the recorded account deletion are owed, and names both; nothing is written by either refusal; `apply`
   re-applies both through the real GoTrue; the lift then succeeds; and the recorded-deleted factor never verifies
   again. The planner and command halves are tests/e7/unit/critique-fixes.test.mjs.

   IT HOLDS EVERY COMPANY, MOVES THE AUDIT SEQUENCE, EMPTIES SCHEMA auth's SESSIONS AND DELETES A SEEDED ACCOUNT, so it
   reseeds at its start and after itself. Run alone: node --test --test-concurrency=1 tests/e7/stack/ */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { stackEnv } from '../../e2/helpers/stack.mjs';
import { e4world, e6routes, enableTargets, futurePeriod, reseed, reviewCompany, ROOT, sql } from '../../e6/stack/helpers.mjs';

const ids = reseed();
enableTargets();
const { apiUrl, dbContainer } = stackEnv();
const OWNER_PSQL = `docker exec -i ${dbContainer} psql -U postgres -X -At`;
process.env.ENTERPRISE_DB_PSQL = OWNER_PSQL;

const { append, fileStore, init, verify } = await import('../../../lib/operator/register.mjs');
const { COOKIES, verifySession } = await import('../../../lib/session.mjs');
const { enrollTotp, verifyTotp } = await import('../../../lib/auth/factors.mjs');
const { generateLink } = await import('../../../lib/db/operator.mjs');

const dir = mkdtempSync(join(tmpdir(), 'e7x-lift-'));
after(() => {
  rmSync(dir, { recursive: true, force: true });
  reseed();
});

function run(script, args, env) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    env: { ...process.env, ENTERPRISE_DB_PSQL: OWNER_PSQL, ...env },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? '', output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const events = (r, name) =>
  r.stdout
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === name);

async function sessionOf(accessToken) {
  const v = await verifySession({ headers: { cookie: `${COOKIES.access}=${accessToken}` } });
  assert.equal(v.ok, true, 'the token verifies');
  return v.session;
}
/* RFC 6238 over the secret this test holds, the same arithmetic as restore.test.mjs's. */
function totpCode(secret, at = Date.now()) {
  let bits = '';
  for (const ch of secret.replace(/=+$/, '')) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  return String((mac.readUInt32BE(mac.at(-1) & 0x0f) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

test('E7X-C-F8: a lift is refused while the register’s factor and account deletions are owed, and the deleted factor never verifies again', async () => {
  const R = await e6routes([]);
  const W = e4world('e7x-lift', ids);
  const A = await reviewCompany(W, R, `x${Date.now().toString(36)}`);
  futurePeriod(A.id);
  const path = join(dir, 'register.jsonl');
  const store = fileStore(path);
  init(store);
  const env = { ENTERPRISE_REGISTER_PATH: path };
  const OP = ids.U_op;

  /* The administrator's factor, enrolled and verified: the authenticator a lost-second-factor reset removes. */
  const admin = await sessionOf(A.admin.token());
  const factor = await enrollTotp(admin);
  assert.equal(factor.ok, true, 'factor enrolled');
  assert.equal((await verifyTotp(admin, factor.factorId, totpCode(factor.secret))).ok, true, 'factor verified');

  assert.equal(run('register.mjs', ['sync', '--operator', OP], env).status, 0, 'sync');
  /* The acts after the backup, which the restored database does not hold: the factor's deletion by the procedure's
     step 5, and an unconfirmed account the sweep removed. */
  append(store, 'factor.delete', { userId: A.admin.id, factorId: factor.factorId, actor: OP, ref: 'synthetic:post-backup-reset' });
  sql(`update auth.users set email_confirmed_at = null where id = '${ids.U_outsider}'`);
  append(store, 'account.delete', { userId: ids.U_outsider, reason: 'unclaimed_invitation', auditId: 1500, actor: OP });

  const backupAt = new Date(Date.now() - 3600_000).toISOString();
  const begin = run('reconcile.mjs', ['begin', '--operator', OP, '--closed-target', '--backup-at', backupAt, '--apply'], env);
  assert.equal(begin.status, 0, begin.output.slice(0, 800));
  assert.equal(sql(`select status from app.companies where id = '${A.id}'`), 'held');
  const anchored = store.readHead();
  const factorCount = () => Number(sql(`select count(*) from auth.mfa_factors where id = '${factor.factorId}'`));
  const registerLines = () => verify(store.read()).lines.length;
  const linesBefore = registerLines();

  /* 1. The critic's lift with the anchored head plan takes, so the gates pass. On c0f5d8f this exits 0, makes the
     company active and leaves the factor present. Now the owed deletions refuse it, each named. */
  const liftArgs = ['lift', '--operator', OP, '--company', A.id, '--confirmation', 'synthetic:confirmed', '--anchored-head', anchored];
  const owed = run('reconcile.mjs', [...liftArgs, '--apply'], env);
  assert.equal(owed.status, 1, `the lift is refused while the deletions are owed\n${owed.output.slice(0, 1200)}`);
  const refusals = events(owed, 'plan_refusal');
  assert.equal(refusals.find((e) => e.correction === 'C8')?.factorId, factor.factorId, owed.output.slice(0, 1200));
  assert.equal(refusals.find((e) => e.correction === 'C9')?.userId, ids.U_outsider, owed.output.slice(0, 1200));
  assert.match(owed.output, /1 factor \(C8\) and 1 account \(C9\)/);
  assert.equal(sql(`select status from app.companies where id = '${A.id}'`), 'held', 'still held');
  assert.equal(factorCount(), 1, 'the factor is untouched by a refused lift');
  assert.equal(registerLines(), linesBefore, 'and the refusal wrote no register line');
  assert.equal(
    Number(sql(`select count(*) from app.audit_events where company_id = '${A.id}' and action = 'company.hold_lift'`)),
    0,
    'nor a lift audit row',
  );

  /* 2. THE CRITIC'S EXACT COMMAND, which carried no anchored head: refused before anything opens. */
  const bare = run('reconcile.mjs', ['lift', '--operator', OP, '--company', A.id, '--confirmation', 'synthetic:confirmed', '--apply'], env);
  assert.equal(bare.status, 2, `the lift without the anchored head is refused before anything opens\n${bare.output.slice(0, 800)}`);
  assert.match(bare.output, /lift needs --anchored-head/);
  assert.equal(sql(`select status from app.companies where id = '${A.id}'`), 'held', 'still held');
  assert.equal(factorCount(), 1);
  assert.equal(registerLines(), linesBefore, 'and neither refusal wrote a register line');

  /* 3. apply re-applies both through the real GoTrue, and the same lift then succeeds. */
  const applied = run('reconcile.mjs', ['apply', '--operator', OP, '--closed-target', '--anchored-head', anchored], env);
  assert.equal(applied.status, 0, applied.output.slice(0, 1200));
  assert.equal(factorCount(), 0, 'C8 deleted the recorded factor');
  assert.equal(Number(sql(`select count(*) from auth.users where id = '${ids.U_outsider}'`)), 0, 'C9 deleted the recorded account');
  const lifted = run('reconcile.mjs', [...liftArgs, '--apply'], env);
  assert.equal(lifted.status, 0, lifted.output.slice(0, 1200));
  assert.equal(events(lifted, 'lift_done').length, 1);
  assert.equal(sql(`select status from app.companies where id = '${A.id}'`), events(lifted, 'lift_done')[0].statusAfter);

  /* 4. After a fresh sign-in, the factor the register recorded as deleted does not verify: aal2 is not reached with it. */
  const link = await generateLink({ email: A.admin.email, type: 'magiclink' });
  assert.equal(link.ok, true, 'a fresh sign-in link');
  const response = await fetch(`${apiUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: link.hashedToken }),
  });
  assert.equal(response.status, 200, 'the fresh sign-in');
  const fresh = await sessionOf((await response.json()).access_token);
  assert.equal(fresh.aal, 'aal1');
  const again = await verifyTotp(fresh, factor.factorId, totpCode(factor.secret));
  assert.equal(again.ok, false, 'the recorded-deleted factor cannot be verified after the lift');
});
