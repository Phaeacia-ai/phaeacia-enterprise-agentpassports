/* E7 design 1.3 and section 5: the reconciler against the running local stack. Cases E7-13 whole, E7-17's stack
   arms (the three gates, and `gap` as the only way on), E7-30's `begin` arms, the second `begin` an open epoch
   refuses, and a lift on a company that is not held.

   A NEW FILE, not arms added to tests/e7/stack/scripts.test.mjs: that file is the scripts-and-register lane's
   accepted work, this lane owns the reconciler, and the two have no fixture in common (this one holds companies,
   moves app.audit_events_id_seq and empties schema auth, which nothing in that file wants to happen underneath
   it). The harness below is the same shape as that file's, deliberately: one command run as a command, its JSON
   lines read by event, and every register under os.tmpdir().

   IT MOVES THE AUDIT SEQUENCE AND EMPTIES SCHEMA auth, so it reseeds at its start and again after itself.
   Run alone: node --test --test-concurrency=1 tests/e7/stack/ */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { stackEnv } from '../../e2/helpers/stack.mjs';
import { published } from '../../e4/stack/helpers.mjs';
import {
  count,
  e4world,
  e6routes,
  enableTargets,
  freshEmail,
  futurePeriod,
  reseed,
  reviewCompany,
  ROOT,
  sql,
} from '../../e6/stack/helpers.mjs';

const ids = reseed();
enableTargets();
const { dbContainer } = stackEnv();
/** The operator's own command, as design 1.2 defines it: one shell command reading a statement on stdin. */
const OWNER_PSQL = `docker exec -i ${dbContainer} psql -U postgres -X -At`;
process.env.ENTERPRISE_DB_PSQL = OWNER_PSQL;

const { append: appendLine, fileStore, fold, init: initRegister } = await import('../../../lib/operator/register.mjs');
const { foldToPlan, holdCorrection, liftCorrection, transactionSql } = await import(
  '../../../lib/operator/reconcile.mjs'
);
const { OwnerDbError, ownerQuery } = await import('../../../scripts/owner-db.mjs');

const scratches = [];
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `e7-${prefix}-`));
  scratches.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
  /* The sequence was moved and schema auth was emptied: the next file starts from the seed. */
  reseed();
});

/** One script, as a command. */
function run(script, args, env = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, ENTERPRISE_DB_PSQL: OWNER_PSQL, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
/**
 * The same, ASYNCHRONOUSLY. It exists for exactly one case: E7-13's refusal arm runs the script against a GoTrue
 * stand-in that lives IN THIS PROCESS, and spawnSync blocks this process's event loop, so the stand-in could
 * never answer the request the child makes and the two would wait for each other for ever. Observed as a deadlock
 * before this was written (section 4 of evidence/e7-reconcile.md).
 */
function runAsync(script, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      env: { ...process.env, ENTERPRISE_DB_PSQL: OWNER_PSQL, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr, output: `${stdout}${stderr}` }));
  });
}

const events = (r, name) =>
  r.stdout
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
    .filter((e) => name === undefined || e.event === name);
const one = (r, name) => {
  const found = events(r, name);
  assert.equal(found.length, 1, `${name}: expected one, got ${found.length}\n${r.output.slice(0, 600)}`);
  return found[0];
};
const lines = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** A register of its own, built with the register module's own writer, then the acts this case needs. */
function registerWith(prefix, acts = []) {
  const dir = scratch(prefix);
  const path = join(dir, 'register.jsonl');
  const store = fileStore(path);
  initRegister(store);
  for (const [act, body] of acts) appendLine(store, act, body, {});
  return { dir, path, store, env: { ENTERPRISE_REGISTER_PATH: path }, head: () => store.readHead().trim() };
}

const OP_ID = ids.U_op;
const iso = (d) => new Date(d).toISOString();

/** The database's state for one company, in the shape lib/operator/reconcile.mjs reads. Written here rather than
 *  imported from the script, so what foldToPlan is given is assembled independently of the command under test. */
function dbStateOf(companyId) {
  const json = sql(`select jsonb_build_object(
  'companies', coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'slug', c.slug, 'status', c.status,
      'holdStatusBefore', (select a.details->>'status_before' from app.audit_events a
                            where a.company_id = c.id and a.action = 'company.hold' order by a.id desc limit 1),
      'period', (select jsonb_build_object('startsAt', p.starts_at, 'endsAt', p.ends_at,
                                           'exportBy', p.export_by, 'deleteBy', p.delete_by)
                   from app.access_periods p where p.company_id = c.id),
      'memberships', coalesce((select jsonb_agg(jsonb_build_object(
                        'id', m.id, 'userId', m.user_id, 'status', m.status, 'roles', to_jsonb(m.roles))
                        order by m.id) from app.memberships m where m.company_id = c.id), '[]'::jsonb),
      'releases', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'state', r.state) order by r.id)
                     from app.releases r where r.company_id = c.id and r.state = 'published'), '[]'::jsonb),
      'invitationsPending', coalesce((select jsonb_agg(i.id order by i.id) from app.invitations i
                     where i.company_id = c.id and i.accepted_at is null and i.revoked_at is null), '[]'::jsonb))
      ) from app.companies c where c.id = '${companyId}'), '[]'::jsonb),
  'factors', '[]'::jsonb, 'accounts', '[]'::jsonb)`);
  return JSON.parse(json);
}

const hold = (companyId) =>
  sql(`begin; set local app.recovery_reconcile = 'on'; update app.companies set status = 'held' where id = '${companyId}'; commit;`);
const statusOf = (companyId) => sql(`select status from app.companies where id = '${companyId}'`);
const auditsOfCompany = (companyId) => Number(count(`app.audit_events where company_id = '${companyId}'`));

/** The fault E7-13 splices between the last write and the first audit row. No production flag reaches it. */
const FAULT = "do $$ begin raise exception 'E7_13_FAULT' using errcode = 'P0001'; end $$";

/** Run one correction with the fault, then without it, and check what each left behind. */
function faultThenClean(correction, { probe, before, after: expected, company }) {
  const auditsBefore = company === null ? null : auditsOfCompany(company);
  assert.equal(probe(), before, `${correction.id}: the state before`);
  let category = null;
  try {
    ownerQuery(transactionSql(correction, { fault: FAULT }));
  } catch (e) {
    category = e instanceof OwnerDbError ? e.category : 'other';
  }
  assert.equal(category, 'statement', `${correction.id}: the faulted transaction failed at the fault`);
  assert.equal(probe(), before, `${correction.id}: THE STATE CHANGE DID NOT PERSIST`);
  if (company !== null)
    assert.equal(auditsOfCompany(company), auditsBefore, `${correction.id}: NO AUDIT ROW PERSISTED either`);

  /* And the same correction without the fault commits both halves, so the control is in the same run. */
  ownerQuery(transactionSql(correction));
  assert.equal(probe(), expected, `${correction.id}: the clean transaction changed the state`);
  if (company !== null)
    assert.ok(auditsOfCompany(company) > auditsBefore, `${correction.id}: and wrote its audit row`);
}

const logged = [];
const R = await e6routes(logged);
const W = e4world('e7-recon', ids);
const RUN = Math.random().toString(16).slice(2, 8);

// ---------------------------------------------------------------------------
// E7-13: the failure-after-update control, on every SQL correction.
// ---------------------------------------------------------------------------

test('E7-13: C2, C3, C7, C4 and C5 with a raising statement at the seam commit NOTHING, and the next one still runs', async () => {
  const A = await reviewCompany(W, R, `r13${RUN}`);
  futurePeriod(A.id);
  const release = await published(R, A);
  const invite = await R.invite(A.adminHi, A.id, { email: freshEmail('r13'), roles: ['member'] });
  assert.equal(invite.status, 201, invite.raw);
  hold(A.id);
  assert.equal(statusOf(A.id), 'held');

  const period = JSON.parse(
    sql(`select jsonb_build_object('startsAt', starts_at, 'endsAt', ends_at, 'exportBy', export_by, 'deleteBy', delete_by) from app.access_periods where company_id = '${A.id}'`),
  );
  /* The same shift on all three dates keeps ends_at <= export_by <= delete_by, and it is at most half the
     period's own length so that starts_at < ends_at, which app.access_periods' own check constraint requires. */
  const shift = Math.min(30 * 86400_000, Math.max(86400_000, (Date.parse(period.endsAt) - Date.parse(period.startsAt)) / 2));
  const earlier = {
    startsAt: period.startsAt,
    endsAt: iso(Date.parse(period.endsAt) - shift),
    exportBy: iso(Date.parse(period.exportBy) - shift),
    deleteBy: iso(Date.parse(period.deleteBy) - shift),
  };
  /* The register: the acts this company's customer made after the backup, which the restore undid. */
  const reg = registerWith('r13', [
    ['company.provision', { companyId: A.id, auditId: 1, actor: OP_ID }],
    ['company.set_access_period', { companyId: A.id, ...earlier, auditId: 2, actor: OP_ID }],
    ['membership.remove', { companyId: A.id, membershipId: A.ms.member, auditId: 3, actor: OP_ID }],
    ['membership.set_roles', { companyId: A.id, membershipId: A.ms.it, rolesAfter: ['member'], auditId: 4, actor: OP_ID }],
    ['release.withdraw', { companyId: A.id, releaseId: release.releaseId, byUserId: A.author.id, auditId: 5 }],
  ]);
  const plan = foldToPlan(fold(lines(reg.path)), dbStateOf(A.id), { operator: OP_ID });
  const company = plan.companies[0];
  assert.deepEqual(company.refusals, [], JSON.stringify(company.refusals));
  const by = (id) => company.corrections.filter((c) => c.id === id);
  assert.deepEqual(company.corrections.map((c) => c.id), ['C2', 'C3', 'C7', 'C4', 'C5'], 'the design’s order');

  faultThenClean(by('C2')[0], {
    company: A.id,
    probe: () =>
      sql(`select to_char(ends_at at time zone 'UTC', 'YYYY-MM-DD') from app.access_periods where company_id = '${A.id}'`),
    before: period.endsAt.slice(0, 10),
    after: earlier.endsAt.slice(0, 10),
  });
  const groupsBefore = Number(count(`app.group_members where membership_id = '${A.ms.member}'`));
  assert.ok(groupsBefore > 0, 'the member is in the audience group, so C3 has group rows to clear');
  faultThenClean(by('C3')[0], {
    company: A.id,
    probe: () =>
      `${sql(`select status from app.memberships where id = '${A.ms.member}'`)}/${count(`app.group_members where membership_id = '${A.ms.member}'`)}`,
    before: `active/${groupsBefore}`,
    after: 'removed/0',
  });
  faultThenClean(by('C7')[0], {
    company: A.id,
    probe: () =>
      sql(`select (select string_agg(r, ',' order by r) from unnest(roles) r) from app.memberships where id = '${A.ms.it}'`),
    before: 'it_reviewer,member',
    after: 'member',
  });
  faultThenClean(by('C4')[0], {
    company: A.id,
    probe: () => sql(`select state from app.releases where id = '${release.releaseId}'`),
    before: 'published',
    after: 'withdrawn',
  });
  faultThenClean(by('C5')[0], {
    company: A.id,
    probe: () => count(`app.invitations where id = '${invite.body.invitationId}' and revoked_at is null`),
    before: 1,
    after: 0,
  });

  /* The withdrawal carries the fixed reason app.release_immutable requires, and the audit rows say who wrote them. */
  const withdrawn = JSON.parse(sql(`select to_jsonb(r) from app.releases r where r.id = '${release.releaseId}'`));
  assert.match(withdrawn.withdrawal_reason, /^Withdrawn again by Phaeacia after a restore from backup\.$/);
  assert.equal(withdrawn.withdrawn_by_membership_id, A.ms.author, 'attributed to the restored membership of the user the register recorded');
  const rows = JSON.parse(
    sql(`select coalesce(jsonb_agg(jsonb_build_object('action', a.action, 'kind', a.actor_kind, 'reason', a.details->>'reason_code') order by a.id), '[]'::jsonb)
         from app.audit_events a where a.company_id = '${A.id}' and a.actor_kind = 'operator' and a.details->>'reason_code' = 'restore_reconciliation'`),
  );
  assert.deepEqual(
    rows.map((x) => x.action),
    ['company.set_access_period', 'membership.remove', 'group.remove_member', 'membership.set_roles', 'release.withdraw', 'invitation.revoke'],
    'one audit row per correction, in the corrections’ own order, and C3’s group row with it',
  );
  for (const row of rows) assert.equal(row.kind, 'operator');

  /* And a second plan against the corrected database plans nothing at all. */
  const second = foldToPlan(fold(lines(reg.path)), dbStateOf(A.id), { operator: OP_ID });
  assert.deepEqual(second.companies[0].corrections, [], 'the second run plans nothing');
});

test('E7-13: C1, C0 and the lift, the three corrections that need the recovery setting', async () => {
  const B = await reviewCompany(W, R, `r13b${RUN}`);
  futurePeriod(B.id);
  const C = await reviewCompany(W, R, `r13c${RUN}`);
  futurePeriod(C.id);

  /* C0: an active company becomes held, under the setting no routine sets. */
  faultThenClean(holdCorrection({ companyId: C.id, statusBefore: 'active', operator: OP_ID }), {
    company: C.id,
    probe: () => statusOf(C.id),
    before: 'active',
    after: 'held',
  });

  /* C1: the register says this company was closed, and the restore brought it back active. */
  hold(B.id);
  const closing = registerWith('r13b-closed', [
    ['company.provision', { companyId: B.id, auditId: 1, actor: OP_ID }],
    ['company.close', { companyId: B.id, reason: 'customer_request', statusAfter: 'closed', auditId: 2, actor: OP_ID }],
  ]);
  const plan = foldToPlan(fold(lines(closing.path)), dbStateOf(B.id), { operator: OP_ID });
  const c1 = plan.companies[0].corrections.find((c) => c.id === 'C1');
  assert.ok(c1, JSON.stringify(plan.companies[0].corrections.map((c) => c.id)));
  faultThenClean(c1, { company: B.id, probe: () => statusOf(B.id), before: 'held', after: 'closed' });

  /* L: the lift, back to the narrower of what the register expects and what the hold recorded. */
  faultThenClean(liftCorrection({ companyId: C.id, statusAfter: 'suspended', operator: OP_ID }), {
    company: C.id,
    probe: () => statusOf(C.id),
    before: 'held',
    after: 'suspended',
  });
});

test('E7-13: the hold’s export door, with the same company merely SUSPENDED as the control in the same run', async () => {
  const D = await reviewCompany(W, R, `r13d${RUN}`);
  futurePeriod(D.id);

  /* The control first, so a refusal cannot come from something else about this company: suspended, the route
     exports every one of its twenty-one sections, which is the defect the first version of the design had. */
  sql(`update app.companies set status = 'suspended' where id = '${D.id}'`);
  const suspended = await R.takeout(D.adminHi, D.id);
  assert.equal(suspended.status, 200, suspended.raw);
  assert.equal(Object.keys(suspended.body.sections).length, 21, 'a SUSPENDED company exports all twenty-one sections');

  sql(`begin; set local app.recovery_reconcile = 'on'; update app.companies set status = 'held' where id = '${D.id}'; commit;`);
  const held = await R.takeout(D.adminHi, D.id);
  assert.equal(held.status, 403, held.raw);
  assert.equal(held.body.code, 'E_FORBIDDEN', 'the same administrator at aal2, the same route, and the hold refuses');
});

// ---------------------------------------------------------------------------
// E7-13: C8 and C9 with GoTrue refusing.
// ---------------------------------------------------------------------------

test('E7-13: C8 and C9 write NO audit row and NO register line when GoTrue answers 500', async () => {
  const E = await reviewCompany(W, R, `r13e${RUN}`);
  futurePeriod(E.id);
  /* An account with no membership, made the product's own way: an invitee who has not accepted. */
  const email = freshEmail('r13e-sweep');
  const invited = await R.invite(E.adminHi, E.id, { email, roles: ['member'] });
  assert.equal(invited.status, 201, invited.raw);
  const orphan = sql(`select id from auth.users where lower(email) = '${email.toLowerCase()}'`);
  assert.match(orphan, /^[0-9a-f-]{36}$/, orphan);
  assert.equal(count(`app.memberships where user_id = '${orphan}'`), 0);

  /* A factor at the target, inserted owner-side: what a restore brings back for an administrator whose
     authenticator was reset after the backup. */
  const adminUser = sql(`select user_id from app.memberships where id = '${E.ms.admin}'`);
  /* The columns are read from the catalogue rather than assumed, because GoTrue's mfa_factors differs by
     version and this fixture must not be the thing that breaks on an upgrade. */
  const factorColumns = sql(
    "select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema='auth' and table_name='mfa_factors'",
  ).split(',');
  const factorFields = [
    ['id', 'gen_random_uuid()'],
    ['user_id', `'${adminUser}'`],
    ['friendly_name', "'restored'"],
    ['factor_type', "'totp'"],
    ['status', "'verified'"],
    ['created_at', 'now()'],
    ['updated_at', 'now()'],
    ['secret', "'SYNTHETICSECRET'"],
  ].filter(([c]) => factorColumns.includes(c));
  /* psql prints the command tag ("INSERT 0 1") after the RETURNING row even under -At, which is the same thing
     E7S-F17 recorded for BEGIN and COMMIT: the row is the FIRST line and the tag is not part of the answer. */
  const factorId = sql(
    `insert into auth.mfa_factors (${factorFields.map(([c]) => c).join(', ')}) values (${factorFields
      .map(([, v]) => v)
      .join(', ')}) returning id`,
  ).split('\n')[0];
  assert.match(factorId, /^[0-9a-f-]{36}$/, factorId);

  const reg = registerWith('r13e', [
    ['company.provision', { companyId: E.id, auditId: 1, actor: OP_ID }],
    ['factor.delete', { userId: adminUser, factorId, ref: `synthetic:opslog-${RUN}`, actor: OP_ID }],
    ['account.delete', { userId: orphan, reason: 'unclaimed_invitation', auditId: 2, actor: OP_ID }],
    ['register.sync', { watermarkAuditId: 2, watermarkAt: iso(Date.now()) }],
    ['restore.begin', { backupAt: iso(Date.now() - 3600_000), auditFloor: 1, actor: OP_ID }],
  ]);
  hold(E.id);

  /* A GoTrue that answers 500 to everything: the reconciler's own client, pointed here for this run only. */
  const upstream = createServer((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"msg":"synthetic-upstream-refusal"}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = upstream.address().port;

  const factorsBefore = Number(count('app.audit_events'));
  const r = await runAsync('reconcile.mjs', ['apply', '--operator', OP_ID, '--closed-target', '--anchored-head', reg.head()], {
    ...reg.env,
    SUPABASE_URL: `http://127.0.0.1:${port}`,
  });
  upstream.close();
  assert.equal(r.status, 0, r.output.slice(0, 800));

  const refusedFactor = events(r, 'factor_not_deleted');
  const refusedAccount = events(r, 'account_not_deleted');
  assert.equal(refusedFactor.length, 1, r.output.slice(0, 600));
  assert.equal(refusedFactor[0].outcome, 'refused', 'the status only, never the provider’s body');
  assert.equal(refusedAccount.length, 1, r.output.slice(0, 600));
  assert.equal(refusedAccount[0].outcome, 'refused');
  assert.equal(r.output.includes('synthetic-upstream-refusal'), false, 'no upstream body reached the terminal');

  assert.equal(
    count(`app.audit_events where action = 'factor.delete' and details->>'user_id' = '${adminUser}'`),
    0,
    'no factor.delete audit row for a delete GoTrue refused',
  );
  assert.equal(
    count(`app.audit_events where action = 'account.delete' and details->>'user_id' = '${orphan}'`),
    0,
    'and no account.delete row',
  );
  assert.equal(
    lines(reg.path).some((l) => l.act === 'factor.delete' && l.auditId !== undefined),
    false,
    'and no register line of its own',
  );
  assert.equal(count(`auth.mfa_factors where id = '${factorId}'`), 1, 'the factor is still there');
  assert.equal(count(`auth.users where id = '${orphan}'`), 1, 'and so is the account');
  assert.ok(Number(count('app.audit_events')) >= factorsBefore, 'nothing was removed');
});

// ---------------------------------------------------------------------------
// E7-17's stack arms: the three gates, and `gap` as the only way on.
// ---------------------------------------------------------------------------

test('E7-17: each gate refuses `plan`, every company stays held, and `gap` is the only way on', async () => {
  const F = await reviewCompany(W, R, `r17${RUN}`);
  futurePeriod(F.id);
  hold(F.id);
  const before = { status: statusOf(F.id), audits: auditsOfCompany(F.id) };

  const good = registerWith('r17', [
    ['company.provision', { companyId: F.id, auditId: 1, actor: OP_ID }],
    ['register.sync', { watermarkAuditId: 1, watermarkAt: iso(Date.now()) }],
    ['restore.begin', { backupAt: iso(Date.now() - 3600_000), auditFloor: 1, actor: OP_ID }],
  ]);
  const head = good.head();
  const planArgs = ['plan', '--operator', OP_ID, '--closed-target', '--anchored-head', head];

  /* The control, first and in the same run: this register passes all three gates. */
  const ok = run('reconcile.mjs', planArgs, good.env);
  assert.equal(ok.status, 0, ok.output.slice(0, 600));
  assert.equal(one(ok, 'plan_summary').companies >= 1, true);

  /* 1. UNVERIFIED: one byte of the file changed. */
  const text = readFileSync(good.path, 'utf8');
  writeFileSync(good.path, `${text.slice(0, 40)}x${text.slice(41)}`);
  const tampered = run('reconcile.mjs', planArgs, good.env);
  assert.equal(tampered.status, 1, tampered.output.slice(0, 400));
  assert.ok(events(tampered, 'gate_refused').some((e) => e.gate === 1), tampered.output.slice(0, 600));
  writeFileSync(good.path, text);

  /* 2. WITHOUT THE ANCHORED HEAD, both ways: not given at all, and given one the file does not contain. */
  const missing = run('reconcile.mjs', ['plan', '--operator', OP_ID, '--closed-target'], good.env);
  assert.equal(missing.status, 2, missing.output.slice(0, 300));
  assert.match(missing.output, /--anchored-head/);
  const wrong = run(
    'reconcile.mjs',
    ['plan', '--operator', OP_ID, '--closed-target', '--anchored-head', `99:${'a'.repeat(64)}`],
    good.env,
  );
  assert.equal(wrong.status, 1, wrong.output.slice(0, 400));
  assert.ok(events(wrong, 'gate_refused').some((e) => /anchored head/.test(e.rule)), wrong.output.slice(0, 600));

  /* 3. FORKED: a workspace copy that diverges. */
  const copy = join(good.dir, 'workspace-copy.jsonl');
  const kept = readFileSync(good.path, 'utf8').split('\n').filter(Boolean);
  /* The copy agrees up to its last line and disagrees there: one line at a shared seq differing is a FORK. */
  writeFileSync(copy, `${[...kept.slice(0, -1), kept.at(-2)].join('\n')}\n`);
  const fork = run('reconcile.mjs', [...planArgs, '--copy', copy], good.env);
  assert.equal(fork.status, 1, fork.output.slice(0, 400));
  assert.ok(events(fork, 'gate_refused').some((e) => /FORK/.test(e.rule)), fork.output.slice(0, 600));

  /* 4. OLDER THAN THE BACKUP: the epoch before this one ended at a watermark before the backup's point in time. */
  const stale = registerWith('r17-stale', [
    ['company.provision', { companyId: F.id, auditId: 1, actor: OP_ID }],
    ['register.sync', { watermarkAuditId: 1, watermarkAt: iso(Date.now() - 7 * 86400_000) }],
    ['restore.begin', { backupAt: iso(Date.now() - 3600_000), auditFloor: 1, actor: OP_ID }],
  ]);
  const old = run(
    'reconcile.mjs',
    ['plan', '--operator', OP_ID, '--closed-target', '--anchored-head', stale.head()],
    stale.env,
  );
  assert.equal(old.status, 1, old.output.slice(0, 400));
  const gate2 = events(old, 'gate_refused').find((e) => e.gate === 2);
  assert.ok(gate2, old.output.slice(0, 600));
  assert.match(gate2.rule, /OLDER than the backup/);
  assert.match(old.output, /register\.mjs gap/, 'and it names the only way on');

  /* `gap` IS the way on: the operator records the hand reconciliation and the plan runs. */
  const gap = run('register.mjs', ['gap', '--ref', `synthetic:hand-${RUN}`, '--operator', OP_ID], stale.env);
  assert.equal(gap.status, 0, gap.output.slice(0, 400));
  const after = run(
    'reconcile.mjs',
    ['plan', '--operator', OP_ID, '--closed-target', '--anchored-head', stale.head()],
    stale.env,
  );
  assert.equal(after.status, 0, after.output.slice(0, 600));

  /* AND NOTHING WAS WRITTEN BY ANY REFUSAL: the company is still held and has no new audit row. */
  assert.equal(statusOf(F.id), before.status);
  assert.equal(auditsOfCompany(F.id), before.audits);
});

// ---------------------------------------------------------------------------
// E7-30's `begin` arms.
// ---------------------------------------------------------------------------

test('E7-30: begin moves the sequence above the register’s highest id and writes restore.begin at epoch 1', () => {
  const G = sql("select id from app.companies where status = 'active' order by created_at limit 1");
  assert.match(G, /^[0-9a-f-]{36}$/, G);
  /* A register that holds an audit id of 1,500, above anything this seeded table has handed out. */
  const tableMax = Number(sql('select coalesce(max(id), 0) from app.audit_events'));
  /* The design's number is 1,500 against a table whose highest is 1,000. Here it is the table's own maximum plus
     five hundred, so the case holds whatever the fixtures above this one have written. */
  const HIGH = tableMax + 500;
  const reg = registerWith('r30', [
    ['company.provision', { companyId: G, auditId: 1, actor: OP_ID }],
    ['company.set_quota', { companyId: G, quotaName: 'agents_per_company', quotaValue: 7, auditId: HIGH, actor: OP_ID }],
    ['register.sync', { watermarkAuditId: HIGH, watermarkAt: iso(Date.now()) }],
  ]);
  assert.ok(tableMax < HIGH, `the table's own highest id is ${tableMax}, below the register's ${HIGH}`);

  const dry = run('reconcile.mjs', ['begin', '--operator', OP_ID, '--closed-target', '--backup-at', iso(Date.now() - 3600_000)], reg.env);
  assert.equal(dry.status, 0, dry.output.slice(0, 600));
  assert.equal(one(dry, 'begin_plan').auditFloor, HIGH + 1, 'the floor is above BOTH maxima');
  assert.ok(Number(sql('select last_value from app.audit_events_id_seq')) <= HIGH, 'the dry run moved nothing');

  const r = run('reconcile.mjs', ['begin', '--operator', OP_ID, '--closed-target', '--backup-at', iso(Date.now() - 3600_000), '--apply'], reg.env);
  assert.equal(r.status, 0, r.output.slice(0, 800));
  assert.equal(one(r, 'begin_sequence_moved').auditFloor, HIGH + 1);
  /* The observable effect: the first audit row C6 writes carries an id above 1,500. */
  const credentials = Number(
    sql("select coalesce(max(id), 0) from app.audit_events where action = 'restore.end_credentials'"),
  );
  assert.ok(credentials > HIGH, `the restore.end_credentials row is ${credentials}, above the register's ${HIGH}`);

  const written = lines(reg.path);
  const begun = written.at(-1);
  assert.equal(begun.act, 'restore.begin');
  assert.equal(begun.epoch, 1);
  assert.equal(begun.auditFloor, HIGH + 1);
  /* The epoch-0 line and the epoch-1 acts coexist, which is what makes (epoch, auditId) the key. */
  assert.equal(written.some((l) => l.epoch === 0 && l.auditId === HIGH), true);

  /* C6 ran: every session and every token of the restored database is gone. */
  for (const table of ['sessions', 'refresh_tokens', 'one_time_tokens', 'flow_state', 'mfa_challenges'])
    assert.equal(count(`auth.${table}`), 0, `auth.${table} is empty after C6`);
  assert.equal(
    sql("select count(*) from auth.users where confirmation_token <> '' or recovery_token <> ''"),
    '0',
    'and every link-token column is the empty string',
  );
  /* C0 held every company that was not closed, and left the closed ones alone. */
  assert.equal(
    count("app.companies where status = 'active' or status = 'suspended'"),
    0,
    'every company is held or closed',
  );
  assert.ok(one(r, 'begin_done').held >= 1);

  /* A SECOND begin in an epoch with no restore.end refuses, so a mistaken re-run cannot open a second epoch. */
  const again = run('reconcile.mjs', ['begin', '--operator', OP_ID, '--closed-target', '--backup-at', iso(Date.now()), '--apply'], reg.env);
  assert.equal(again.status, 1, again.output.slice(0, 400));
  assert.match(again.output, /a recovery epoch is already open/);
  assert.deepEqual(lines(reg.path).map((l) => l.seq), written.map((l) => l.seq), 'and nothing was appended');
});

test('E7-30 and E7S-F4: where `gap` opened the epoch, begin still does the database half and appends nothing', () => {
  const H = sql("select id from app.companies where status = 'held' order by created_at limit 1");
  assert.match(H, /^[0-9a-f-]{36}$/, H);
  /* `register.mjs gap` writes restore.begin when no epoch is open and deliberately does NOT move the sequence. */
  const reg = registerWith('r30-gap', [
    ['company.provision', { companyId: H, auditId: 1, actor: OP_ID }],
    ['register.sync', { watermarkAuditId: 1, watermarkAt: iso(Date.now()) }],
  ]);
  const gap = run('register.mjs', ['gap', '--ref', `synthetic:gap-${RUN}`, '--operator', OP_ID, '--backup-at', iso(Date.now() - 3600_000)], reg.env);
  assert.equal(gap.status, 0, gap.output.slice(0, 400));
  const opened = lines(reg.path);
  assert.deepEqual(opened.slice(-2).map((l) => l.act), ['restore.begin', 'restore.gap']);
  assert.match(gap.output, /It did NOT move app\.audit_events_id_seq/);

  const sequenceBefore = Number(sql('select last_value from app.audit_events_id_seq'));
  const r = run('reconcile.mjs', ['begin', '--operator', OP_ID, '--closed-target', '--backup-at', iso(Date.now() - 3600_000), '--apply'], reg.env);
  assert.equal(r.status, 0, r.output.slice(0, 800));
  assert.equal(one(r, 'begin_plan').epochOpenedByGap, true, 'begin knows this epoch was opened by gap');
  assert.ok(one(r, 'begin_sequence_moved').auditFloor >= sequenceBefore, 'and it is begin that moves the sequence');
  assert.equal(events(r, 'register_appended').length, 0, 'it appends NOTHING a second time');
  assert.deepEqual(lines(reg.path).map((l) => l.seq), opened.map((l) => l.seq));
  /* And C6 ran again, which is harmless because it is idempotent: what it clears is already clear. */
  assert.ok(Number(count("app.audit_events where action = 'restore.end_credentials'")) >= 1);
});

// ---------------------------------------------------------------------------
// The lift.
// ---------------------------------------------------------------------------

test('E7-17: a lift through the command writes the hold_lift row and the register line with its confirmation', () => {
  /* A held company whose plan is empty: nothing pending, and a register that knows it and expects it active. */
  const held = sql(`select id from app.companies c where c.status = 'held'
    and not exists (select 1 from app.invitations i where i.company_id = c.id and i.accepted_at is null and i.revoked_at is null)
    order by c.created_at limit 1`);
  assert.match(held, /^[0-9a-f-]{36}$/, held);
  const reg = registerWith('r-lift-ok', [
    ['company.provision', { companyId: held, auditId: 1, actor: OP_ID }],
    ['register.sync', { watermarkAuditId: 1, watermarkAt: iso(Date.now()) }],
    ['restore.begin', { backupAt: iso(Date.now() - 3600_000), auditFloor: 1, actor: OP_ID }],
  ]);
  const confirmation = `rehearsal:call-${RUN}`;
  const r = run(
    'reconcile.mjs',
    /* E7X-C-F8: a lift passes the gates plan passes, so it carries the anchored head as plan does. */
    ['lift', '--operator', OP_ID, '--company', held, '--confirmation', confirmation, '--anchored-head', reg.head(), '--apply'],
    reg.env,
  );
  assert.equal(r.status, 0, r.output.slice(0, 800));
  const done = one(r, 'lift_done');
  assert.ok(['active', 'suspended'].includes(done.statusAfter), JSON.stringify(done));
  assert.equal(statusOf(held), done.statusAfter, 'the company left the hold');

  /* The audit row, and the register line with the customer's confirmation reference. */
  const row = JSON.parse(sql(`select to_jsonb(a) from app.audit_events a where a.id = ${done.auditId}`));
  assert.equal(row.action, 'company.hold_lift');
  assert.equal(row.actor_kind, 'operator');
  assert.equal(row.actor_user_id, OP_ID);
  assert.equal(row.details.status_before, 'held');
  assert.equal(row.details.status_after, done.statusAfter);
  assert.equal(row.details.reason_code, 'restore_reconciliation');
  const line = lines(reg.path).at(-1);
  assert.equal(line.act, 'company.hold_lift');
  assert.equal(line.ref, confirmation);
  assert.equal(line.auditId, done.auditId);
  assert.equal(line.statusAfter, done.statusAfter);

  /* And the confirmation list was not even read, because standard output is not a terminal. */
  assert.equal(events(r, 'lift_addresses_withheld').length, 1);
  assert.equal(r.output.includes('@example.invalid'), false, 'no address reached this output');
});

test('E7-17: a lift on a company that is NOT held says so and writes nothing at all', () => {
  const closed = sql("select id from app.companies where status = 'closed' order by created_at limit 1");
  const target = closed.length === 36 ? closed : null;
  assert.ok(target, 'a closed company exists after the corrections above');
  const reg = registerWith('r-lift', [
    ['company.provision', { companyId: target, auditId: 1, actor: OP_ID }],
    ['register.sync', { watermarkAuditId: 1, watermarkAt: iso(Date.now()) }],
    ['restore.begin', { backupAt: iso(Date.now() - 3600_000), auditFloor: 1, actor: OP_ID }],
  ]);
  const before = { lines: lines(reg.path).length, audits: auditsOfCompany(target), status: statusOf(target) };
  const r = run(
    'reconcile.mjs',
    ['lift', '--operator', OP_ID, '--company', target, '--confirmation', `rehearsal:call-${RUN}`, '--anchored-head', reg.head(), '--apply'],
    reg.env,
  );
  assert.equal(r.status, 0, r.output.slice(0, 600));
  assert.equal(one(r, 'lift_skipped').status, before.status);
  assert.equal(lines(reg.path).length, before.lines, 'no register line');
  assert.equal(auditsOfCompany(target), before.audits, 'no audit row');
  assert.equal(statusOf(target), before.status, 'and no status change');
});
