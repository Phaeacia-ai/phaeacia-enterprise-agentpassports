/* E8-10 (docs/e8/design.md 2.1's maintenance-endpoints row, 2.3 row E8-10, 7.1 day 3), in the corrected form
   E8D-R-F1 gave it, against the running local stack.

   WHAT THIS CASE PINS, AND WHAT IT DOES NOT. It pins the DISCLOSED BOUNDARY OF A ROLE. It says nothing about the
   power of the E7 reconciler, and it must not be read as if it did. Two documents bound the claim and both are
   asserted below so the citation cannot rot:
     - docs/e2/identity-tenancy-design.md section 5 discloses this role's reach in the same words the migration's
       own comment at supabase/migrations/001_identity.sql:465-473 uses: "read standing in every tenant; update
       companies.status, memberships status/removed_at/roles and invitations.revoked_at in both directions across
       all tenants (using (true)), with no rule check and no audit coupling; append audit rows. It cannot delete
       anything, read invitation token hashes, rewrite membership identity or call api functions."
     - docs/e7/design.md 1.3 amends it: "It runs as the owner, not as app_maintenance." The reconciler writes
       app.access_periods, app.agents, app.releases and schema auth, none of which this role holds. So a reader who
       took this file for a proof about recovery would have it backwards: what is pinned here is the boundary of a
       CREDENTIAL, and the reconciler is outside it.
   The first version of row E8-10 claimed "every write refused by the grant", which the migration text refutes:
   001:485-488 grants four writes and 001:476-479 create four `for all ... using (true) with check (true)` policies
   that admit them. That claim is withdrawn and this is what the grants support.

   WHY THE FOUR `for all` POLICIES MATTER. They are what makes "refused by the GRANT and not by a POLICY"
   observable at all. On app.companies, app.memberships, app.invitations and app.audit_events the row-level policy
   would admit any command; the refusal that arrives is the column grant's. The two are told apart by the message
   class and both are recorded: a grant refusal reads "permission denied for table X", a policy refusal reads "new
   row violates row-level security policy". Every refusal below is asserted to be the first kind.

   E6DB-F21, AND WHY THIS IS AN EARNED ASSERTION AND NOT PROBE 09'S. The open debt (docs/e8/debts.md 7.3) is that
   probe 09's `set role app_maintenance` works only because line 71 grants that membership to the owner for the
   probe's duration, so a refusal observed there could be an artefact of how the role was assumed rather than the
   grant's. This file answers that directly rather than repeating it:
     - it records `current_user`, `session_user` and `rolsuper(current_user)` inside the transaction, so the
       privilege drop is observed and not assumed;
     - the SAME transaction contains successes AND refusals. A session that had not really left superuser would
       have no refusals at all, so the refusals are the control on the role assumption;
     - and one representative refusal is run a second time AS POSTGRES, in its own rolled-back transaction, where
       it succeeds. That is the attribution the debt asks for: the statement is fine, the role is what refuses it.

   THE GRANT TABLE IS READ FROM THE CATALOGUE, NOT COPIED FROM THE MIGRATION. Every attempt below is driven by what
   `information_schema.role_table_grants` and the column ACLs actually say on the revision under test, and the
   derived table is then pinned against the disclosed boundary. A migration that widens the role fails M1 by the
   table it changed, and the sweep in M4 widens with it rather than going quiet.

   NOTHING COMMITS. Every attempt runs inside one transaction that ends in `rollback`, including the fail-before's
   `grant update (name)`, so no grant this file writes ever reaches a commit; M9 re-reads the catalogue afterwards
   and asserts the role's write surface is what it was. The one thing that does commit is the role membership
   `grant app_maintenance to postgres`, which is the local stand-in for the out-of-band login at a recovery target
   that probes 09 and 12 also use; it is revoked in `after()` and M0 asserts it was not there beforehand.

   THE STACK. Held by this lane. This file reseeds through tests/db/00-seed.sh like every stack file here, and runs
   under the gate's --test-concurrency=1. Run alone:
   node --test --test-concurrency=1 tests/e8/stack/maintenance.test.mjs */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { stackEnv } from '../../e2/helpers/stack.mjs';
import { e4world, e6routes, freshEmail, reseed, ROOT, sql } from '../../e6/stack/helpers.mjs';
import { caught } from '../helpers/mutant-lib.mjs';
import { difference, noWrite, snapshot } from '../helpers/no-write.mjs';

const { dbContainer } = stackEnv();

/** One psql script through the project's own database container, as tests/e8/helpers/no-write.mjs addresses it. */
function psql(script) {
  const r = spawnSync(
    'docker',
    ['exec', '-i', dbContainer, 'psql', '-U', 'postgres', '-X', '-At', '-F|', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: script },
  );
  if (r.status !== 0) throw new Error(`psql exited ${r.status}: ${(r.stderr ?? '').slice(0, 600)}\n${(r.stdout ?? '').slice(0, 600)}`);
  return (r.stdout ?? '').trim();
}

/* The attempt runner, created inside the transaction by postgres and called after the role change. SECURITY
   INVOKER, which is the default and what this needs: the dynamic statement runs with the privileges of the role
   in force at call time, which is app_maintenance. Its own EXCEPTION block opens a subtransaction, so a refusal
   does not abort the outer one and the next attempt still runs. ROW_COUNT is reported for a success, because
   "the grant admitted it" and "it matched no row" are different answers. */
const ATTEMPT_FN = `create function public.e8_attempt(label text, stmt text)
  returns table(id text, outcome text, state text, msg text) language plpgsql as $fn$
declare n integer;
begin
  begin
    execute stmt;
    get diagnostics n = ROW_COUNT;
    return query select label, 'ok:' || n, ''::text, ''::text;
  exception when others then
    return query select label, 'refused'::text, SQLSTATE::text, SQLERRM::text;
  end;
end $fn$;`;

/** Run `attempts` as app_maintenance inside one rolled-back transaction; returns Map<id, {outcome, state, msg}>. */
function asMaintenance(attempts, { ownerPrelude = '' } = {}) {
  const script = [
    'begin;',
    ATTEMPT_FN,
    ownerPrelude,
    'set local role app_maintenance;',
    `select 'WHO', current_user, session_user, (select rolsuper from pg_roles where rolname = current_user)::text;`,
    ...attempts.map(([id, statement]) => `select * from public.e8_attempt('${id}', $stmt$${statement}$stmt$);`),
    'rollback;',
  ].join('\n');
  const rows = new Map();
  let who = null;
  for (const line of psql(script).split('\n')) {
    const [a, b, c, d] = line.split('|');
    if (a === 'WHO') who = { currentUser: b, sessionUser: c, superuser: d };
    else if (a !== undefined && a !== '') rows.set(a, { outcome: b, state: c ?? '', msg: d ?? '' });
  }
  return { who, rows };
}

const ids = reseed();
assert.ok(ids, 'the seed ran');

/* THE STAND-IN FOR THE OUT-OF-BAND LOGIN, AND WHAT IT ACTUALLY CHANGES. `pg_has_role('postgres',
   'app_maintenance', 'MEMBER')` is TRUE on this stack before anything here runs, and asserting on it would have
   been a false start: `supabase_admin` created the role, so `pg_auth_members` already carries
   postgres -> app_maintenance with `admin_option = true` and, decisively, `inherit_option = false` and
   `set_option = false`. That grant confers no privilege and does not permit `SET ROLE`. What probes 09 and 12 and
   this file add is a second grant, by postgres, WITH the set option, and that is the one thing that makes the role
   assumable; it is what is revoked afterwards. Measured on PostgreSQL 17.6.
   E6DB-F21's residue is therefore sharper than the debt states: the stand-in grant is not decoration, it is the
   only thing that admits `SET ROLE` at all, which is exactly what an out-of-band login at a recovery target
   would be. Recorded in evidence/e8-approval.md section 5. */
const settableGrants = () =>
  sql(`select count(*) from pg_auth_members m
         join pg_roles r on r.oid = m.roleid join pg_roles g on g.oid = m.member
        where r.rolname = 'app_maintenance' and g.rolname = 'postgres' and m.set_option`);
const settableBefore = settableGrants();
sql('grant app_maintenance to postgres');
let membershipHeld = true;
after(() => {
  if (membershipHeld) sql('revoke app_maintenance from postgres');
  membershipHeld = false;
});

/* ---------- The grant table, read from the catalogue ---------- */

const tableGrants = sql(`select coalesce(string_agg(table_name || ':' || privilege_type, ',' order by table_name, privilege_type), '')
  from information_schema.role_table_grants where grantee = 'app_maintenance' and table_schema = 'app'`)
  .split(',')
  .filter(Boolean);
const columnGrants = sql(`select coalesce(string_agg(x, ',' order by x), '') from (
  select c.relname || ':' || p.privilege_type || ':' || a.attname as x
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    cross join lateral aclexplode(a.attacl) p
   where n.nspname = 'app' and p.grantee = 'app_maintenance'::regrole) s`)
  .split(',')
  .filter(Boolean);

/** name -> the write privileges app_maintenance holds on it, whole-table or by column. */
const WRITE_GRANTS = (() => {
  const out = new Map();
  const put = (t, v) => out.set(t, [...(out.get(t) ?? []), v].sort());
  for (const g of tableGrants) {
    const [t, p] = g.split(':');
    if (p !== 'SELECT') put(t, p);
  }
  for (const g of columnGrants) {
    const [t, p, col] = g.split(':');
    if (p !== 'SELECT') put(t, `${p}(${col})`);
  }
  return out;
})();

const READABLE = [...new Set([...tableGrants.map((g) => g.split(':')[0]), ...columnGrants.map((g) => g.split(':')[0])])].sort();
const SELECT_ONLY = READABLE.filter((t) => !WRITE_GRANTS.has(t));
const ALL_APP_TABLES = sql(
  `select string_agg(c.relname, ',' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind = 'r'`,
).split(',');
const UNREACHABLE = ALL_APP_TABLES.filter((t) => !READABLE.includes(t));

/* ---------- The rows the granted writes act on ---------- */

/* The seed leaves companies and memberships and NO invitation, so this file builds its own world through the
   product's own routes, as every stack file here does, rather than inserting an invitation row owner-side: an
   invitation carries a token hash and an expiry that the route computes, and a hand-made row could be refused by
   a constraint for a reason that had nothing to do with the grant under test. */
const R = await e6routes([]);
const W = e4world('e8m', ids);
const ADMIN = W.user('maintenance-admin');
const COMPANY = W.company('maintenance', ADMIN).id;
const MEMBERSHIP = W.member(COMPANY, W.user('maintenance-member'));
const invited = await R.invite(W.aal2(ADMIN), COMPANY, { email: freshEmail('maintenance'), roles: ['member'] });
assert.equal(invited.status, 201, `the pending invitation: ${invited.status} ${invited.raw}`);
const INVITATION = invited.body.invitationId;
assert.ok(COMPANY && MEMBERSHIP && INVITATION, 'a company, a membership and a pending invitation');

/* A write that is legal in every other way, one per table, so a refusal can only be the grant's. For a table
   whose insert would meet a not-null or a foreign key first, the write is an UPDATE of one of its own columns to
   its own value: no constraint can fail it, and a 42501 is therefore the grant and nothing else. */
const selfUpdate = (table) => {
  /* Not simply the first column: app.release_downloads.id is GENERATED ALWAYS AS IDENTITY, and writing it answers
     428C9 (`column can only be updated to DEFAULT`) BEFORE the privilege check, which would have recorded a
     refusal that says nothing about the grant. Identity and generated columns are skipped for that reason. */
  const column = sql(
    `select attname from pg_attribute where attrelid = 'app.${table}'::regclass and attnum > 0 and not attisdropped
       and attidentity::text = '' and attgenerated::text = '' order by attnum limit 1`,
  );
  assert.ok(column, `app.${table} has no ordinary column to write, so this sweep cannot speak for it`);
  return `update app.${table} set ${column} = ${column}`;
};

const GRANTED = [
  ['g1 companies.status', `update app.companies set status = status where id = '${COMPANY}'`],
  [
    'g2 memberships.status+removed_at+roles',
    `update app.memberships set status = status, removed_at = removed_at, roles = roles where id = '${MEMBERSHIP}'`,
  ],
  ['g3 invitations.revoked_at', `update app.invitations set revoked_at = clock_timestamp() where id = '${INVITATION}'`],
  [
    'g4 audit_events insert',
    `insert into app.audit_events (company_id, actor_kind, action, entity_type, entity_id, details)
       values ('${COMPANY}', 'operator', 'restore.reconciliation', 'membership', '${MEMBERSHIP}', '{}'::jsonb)`,
  ],
];

/* A fifth column of each of the four. app.audit_events is the stated exception: its grant is whole-table INSERT,
   so it has no fifth column, and the attempt that stands in its place is an UPDATE of one column, which no grant
   carries. Recorded as a deviation in docs/e8/design.md's day-3 amendment block. */
const FIFTH_COLUMN = [
  ['x1 companies.name', `update app.companies set name = name where id = '${COMPANY}'`],
  ['x2 memberships.user_id', `update app.memberships set user_id = user_id where id = '${MEMBERSHIP}'`],
  ['x3 invitations.email_normalized', `update app.invitations set email_normalized = email_normalized where id = '${INVITATION}'`],
  ['x4 audit_events update', `update app.audit_events set action = action where id = (select min(id) from app.audit_events)`],
];

const DELETES = [
  ['d1 delete companies', `delete from app.companies where id = '${COMPANY}'`],
  ['d2 delete memberships', `delete from app.memberships where id = '${MEMBERSHIP}'`],
  ['d3 delete invitations', `delete from app.invitations where id = '${INVITATION}'`],
  ['d4 delete audit_events', `delete from app.audit_events where id = (select min(id) from app.audit_events)`],
];

const SELECT_ONLY_WRITES = SELECT_ONLY.map((t) => [`s ${t}`, selfUpdate(t)]);
const UNREACHABLE_ATTEMPTS = UNREACHABLE.flatMap((t) => [
  [`u-read ${t}`, `select count(*) from app.${t}`],
  [`u-write ${t}`, selfUpdate(t)],
]);
const WITHHELD = [['t1 invitations.token_hash', 'select token_hash from app.invitations limit 1']];

const ATTEMPTS = [...GRANTED, ...FIFTH_COLUMN, ...DELETES, ...SELECT_ONLY_WRITES, ...UNREACHABLE_ATTEMPTS, ...WITHHELD];

/* THE ONE TRANSACTION, wrapped in E8-9's contract WITH THE CONTENT DIGEST (B12-R-F1). A count alone would not do
   for this case and the review was right to say so: three of the four granted writes are UPDATEs, and a
   transaction that failed to roll one of them back would leave every count in `no-write.mjs` unchanged. The four
   writable tables are therefore named, so their rows are digested before and after and an in-place change is
   caught. `no-write.mjs` reads the committed state from a second connection, so what it sees is exactly what a
   rollback should have left. */
const WRITABLE = ['companies', 'memberships', 'invitations', 'audit_events'];
const { who, rows: OBSERVED } = await noWrite(
  'E8-10 the whole maintenance transaction',
  async () => asMaintenance(ATTEMPTS),
  { content: WRITABLE },
);

const refusal = (id) => {
  const r = OBSERVED.get(id);
  assert.ok(r, `${id}: the attempt produced no row`);
  return r;
};
const GRANT_REFUSAL = /^permission denied for (table|relation|column)/;
const POLICY_REFUSAL = /row-level security policy/;

/* ---------- The cases ---------- */

test('E8-10 M0: the role became assumable only through the stand-in grant, and the privilege drop is observed', () => {
  assert.equal(settableBefore, '0', 'a SET-capable grant of app_maintenance to postgres was already in place');
  assert.equal(settableGrants(), '1', 'the stand-in grant is what makes SET ROLE possible');
  assert.deepEqual(who, { currentUser: 'app_maintenance', sessionUser: 'postgres', superuser: 'false' });
  /* And the pre-existing creation grant, which confers nothing: this is the row that makes pg_has_role() true. */
  assert.equal(
    sql(`select coalesce(string_agg(gr.rolname || ' admin=' || m.admin_option || ' inherit=' || m.inherit_option || ' set=' || m.set_option, ', ' order by gr.rolname), 'none')
           from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles g on g.oid = m.member
           join pg_roles gr on gr.oid = m.grantor
          where r.rolname = 'app_maintenance' and g.rolname = 'postgres' and gr.rolname <> 'postgres'`),
    'supabase_admin admin=true inherit=false set=false',
    'the creation grant changed shape, so what the stand-in grant adds is no longer what this case says it is',
  );
});

test('E8-10 M1: the write surface read from the catalogue is exactly the disclosed boundary', () => {
  assert.deepEqual(
    Object.fromEntries([...WRITE_GRANTS].sort()),
    {
      audit_events: ['INSERT'],
      companies: ['UPDATE(status)'],
      invitations: ['UPDATE(revoked_at)'],
      memberships: ['UPDATE(removed_at)', 'UPDATE(roles)', 'UPDATE(status)'],
    },
    'app_maintenance holds a write grant the disclosed boundary of 001:465-473 does not name',
  );
  /* The withheld column, from the ACL rather than from the migration text: token_hash is not in the select list. */
  assert.equal(
    columnGrants.includes('invitations:SELECT:token_hash'),
    false,
    'invitations.token_hash is readable by app_maintenance, which 001:483-484 withholds',
  );
  /* HB-F2 (migration 012): the route bound's two tables are granted to nobody, as 004's hook table is. */
  assert.deepEqual(UNREACHABLE, [
    'idempotency_keys',
    'mfa_attempt_windows',
    'mfa_route_attempts',
    'mfa_route_reservations',
    'operator_allowlist',
  ]);
  assert.equal(READABLE.length + UNREACHABLE.length, ALL_APP_TABLES.length);
  console.log(
    `E8-10 grant table: 4 writable (${[...WRITE_GRANTS.keys()].sort().join(', ')}), ${SELECT_ONLY.length} select-only, ${UNREACHABLE.length} unreachable, of ${ALL_APP_TABLES.length} app tables`,
  );
});

test('E8-10 M2: the four policies that would admit any command are there, so a refusal is the grant s', () => {
  const policies = sql(`select coalesce(string_agg(tablename || ':' || cmd || ':' || qual || ':' || with_check, ',' order by tablename), '')
    from pg_policies where schemaname = 'app' and 'app_maintenance' = any(roles) and cmd = 'ALL'`);
  assert.deepEqual(policies.split(','), [
    'audit_events:ALL:true:true',
    'companies:ALL:true:true',
    'invitations:ALL:true:true',
    'memberships:ALL:true:true',
  ]);
  assert.deepEqual([...WRITE_GRANTS.keys()].sort(), ['audit_events', 'companies', 'invitations', 'memberships'],
    'the four tables with a `for all` policy are exactly the four with a write grant');
});

test('E8-10 M3: the four granted writes succeed, each on exactly one row', () => {
  for (const [id] of GRANTED) {
    const r = refusal(id);
    assert.equal(r.outcome, 'ok:1', `${id}: ${r.outcome} ${r.state} ${r.msg}`);
  }
});

test('E8-10 M4: a fifth column of each of the four is refused by the grant, not by a policy', () => {
  for (const [id] of FIFTH_COLUMN) {
    const r = refusal(id);
    assert.equal(r.outcome, 'refused', `${id}: ${r.outcome}`);
    assert.equal(r.state, '42501', `${id}: SQLSTATE ${r.state}`);
    assert.match(r.msg, GRANT_REFUSAL, `${id}: ${r.msg}`);
    assert.doesNotMatch(r.msg, POLICY_REFUSAL, `${id}: refused by the policy, which using (true) with check (true) cannot do`);
  }
});

test('E8-10 M5: a delete on each of the four is refused', () => {
  for (const [id] of DELETES) {
    const r = refusal(id);
    assert.equal(r.outcome, 'refused', `${id}: ${r.outcome}`);
    assert.equal(r.state, '42501', `${id}: SQLSTATE ${r.state}`);
    assert.match(r.msg, GRANT_REFUSAL, `${id}: ${r.msg}`);
  }
});

test('E8-10 M6: a write to every select-only table is refused, and the sweep is over the catalogue', () => {
  assert.ok(SELECT_ONLY.length >= 20, `the sweep covers ${SELECT_ONLY.length} select-only tables`);
  /* Every table design 2.3 row E8-10 names by hand is in the derived set, so widening the derivation did not
     quietly drop one of them. */
  for (const named of [
    'profiles', 'operators', 'access_periods', 'company_quotas', 'agents', 'candidate_versions',
    'groups', 'review_envelopes', 'reviews', 'releases', 'release_downloads', 'installation_reports',
  ])
    assert.ok(SELECT_ONLY.includes(named), `${named} is not in the derived select-only set`);

  for (const [id] of SELECT_ONLY_WRITES) {
    const r = refusal(id);
    assert.equal(r.outcome, 'refused', `${id}: ${r.outcome}`);
    assert.equal(r.state, '42501', `${id}: SQLSTATE ${r.state}`);
    assert.match(r.msg, GRANT_REFUSAL, `${id}: ${r.msg}`);
  }
  console.log(`E8-10 select-only sweep: ${SELECT_ONLY_WRITES.length} tables, all 42501, all "permission denied for table"`);
});

test('E8-10 M7: the three tables the role holds nothing on refuse both the read and the write', () => {
  for (const [id] of UNREACHABLE_ATTEMPTS) {
    const r = refusal(id);
    assert.equal(r.outcome, 'refused', `${id}: ${r.outcome}`);
    assert.equal(r.state, '42501', `${id}: SQLSTATE ${r.state}`);
  }
});

test('E8-10 M8: the withheld column refuses the select', () => {
  const r = refusal('t1 invitations.token_hash');
  assert.equal(r.outcome, 'refused');
  assert.equal(r.state, '42501');
  assert.match(r.msg, GRANT_REFUSAL, r.msg);
  /* And the granted columns of the same table read, so the refusal is the column grant and not the table. */
  const ok = asMaintenance([['t2 invitations granted columns', 'select id, company_id, revoked_at from app.invitations limit 1']]);
  assert.equal(ok.rows.get('t2 invitations granted columns').outcome, 'ok:1');
});

test('E8-10 M9: the refusals are the role s, shown by the same statement succeeding as postgres', () => {
  /* E6DB-F21's attribution. One representative select-only write, run as the owner in its own rolled-back
     transaction: it succeeds, so nothing about the statement is what refused it. */
  const statement = selfUpdate('profiles');
  const out = psql(`begin;\n${ATTEMPT_FN}\nselect * from public.e8_attempt('owner-control', $stmt$${statement}$stmt$);\nrollback;`);
  const [, outcome, state, msg] = out.trim().split('\n').pop().split('|');
  assert.match(outcome, /^ok:/, `the owner could not run it either (${state} ${msg}), so the refusal is not attributable to the role`);
  assert.equal(refusal('s profiles').outcome, 'refused', 'and app_maintenance is refused the identical statement');
});

test('E8-10 M10: this case pins a role s boundary, and the document and the migration that say so still say it', () => {
  /* The claim's framing is asserted, not narrated, so a later edit to either text is visible here. */
  const doc = readFileSync(join(ROOT, 'docs/architecture.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(
    doc.includes('It cannot delete anything, read `invitations.token_hash`, rewrite membership identity or call `api` functions.'),
    'docs/architecture.md section 5 no longer carries the disclosed boundary this case pins',
  );
  assert.ok(
    doc.includes('`app_maintenance` is a trusted repair principal, not a removal-only role.'),
    'docs/architecture.md no longer says the role is a trusted repair principal, which is the sentence E8-10 rests on',
  );
  /* And the migration comment the document paraphrases, so the two cannot drift apart unnoticed. */
  assert.ok(
    readFileSync(join(ROOT, 'supabase/migrations/001_identity.sql'), 'utf8').includes(
      /* One line of the comment: the sentence wraps across three `--` lines, so the substring stops at the
         line break rather than spanning it. */
      'delete anything, read invitation token hashes, rewrite membership identity or call api',
    ),
    '001_identity.sql no longer carries the comment this case pins',
  );
  assert.ok(
    doc.includes('The reconciler runs as the owner, not as `app_maintenance`'),
    'docs/architecture.md no longer says the reconciler runs as the owner, so what E8-10 does NOT prove has changed',
  );
});

/* ---------- The fail-before ---------- */

test('E8-10 fail-before: a fifth column added to one update grant turns that refusal into a success', () => {
  /* The GRANT is executed by postgres inside the transaction, before the role change, and the transaction ends in
     rollback, so no grant commits. M11 re-reads the catalogue and proves it. */
  const { rows } = asMaintenance([FIFTH_COLUMN[0]], {
    ownerPrelude: 'grant update (name) on app.companies to app_maintenance;',
  });
  const r = rows.get('x1 companies.name');
  assert.equal(r.outcome, 'ok:1', `the mutant grant did not admit the write: ${r.outcome} ${r.state} ${r.msg}`);
  const e = caught('E8-10 M4', () => {
    assert.equal(r.outcome, 'refused', 'x1 companies.name: ok:1');
    assert.equal(r.state, '42501', 'x1 companies.name: SQLSTATE ');
  });
  assert.match(e.message, /x1 companies\.name/);
  console.log(`E8-10 fail-before at the intended check: ${e.message.split('\n')[0]}`);
});

test('E8-10 M12: no-write s content digest catches an in-place update that no count would show', () => {
  /* B12-R-F1's own fail-before, and the extension's. One owner-side UPDATE of a column of one existing row:
     nothing is added and nothing removed, so every count in no-write.mjs is unchanged and a wrapped block would
     pass; the digest of app.companies moves. Restored immediately afterwards, and the restore is asserted. */
  const name = sql(`select name from app.companies where id = '${COMPANY}'`);
  const countsOnly = snapshot();
  const withContent = snapshot({ content: ['companies'] });
  sql(`update app.companies set name = name || '-e8' where id = '${COMPANY}'`);
  try {
    assert.deepEqual(difference(countsOnly, snapshot()), [], 'a count saw the in-place update, so this case is not what it says');
    const moved = difference(withContent, snapshot({ content: ['companies'] }));
    assert.equal(moved.length, 1, JSON.stringify(moved));
    assert.match(moved[0], /^content:app\.companies: the rows changed in place/);
    console.log(`E8-10 M12 (B12-R-F1): ${moved[0]}`);
  } finally {
    sql(`update app.companies set name = '${name.replace(/'/g, "''")}' where id = '${COMPANY}'`);
  }
  assert.deepEqual(difference(withContent, snapshot({ content: ['companies'] })), [], 'the restore did not restore');
});

test('E8-10 M13: the whole attempt table, printed, because it is what the acceptance record carries', () => {
  /* Not an assertion: the observation. Every attempt with its outcome, SQLSTATE and message, in the order it was
     made, so evidence/e8-approval.md section 5 quotes a run rather than a retyped table. */
  const lines = [];
  for (const [id] of ATTEMPTS) {
    const r = OBSERVED.get(id);
    lines.push(`  ${id.padEnd(34)} ${r.outcome.padEnd(8)} ${r.state.padEnd(6)} ${r.msg}`);
  }
  console.log(`E8-10 attempt table (${ATTEMPTS.length} attempts, one rolled-back transaction as app_maintenance):\n${lines.join('\n')}`);
  assert.equal(OBSERVED.size, ATTEMPTS.length, 'an attempt produced no row');
});

test('E8-10 M11: no grant this file wrote survived, and the role membership is released', () => {
  const after11 = sql(`select coalesce(string_agg(c.relname || ':' || p.privilege_type || ':' || a.attname, ',' order by a.attname), '')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    cross join lateral aclexplode(a.attacl) p
   where n.nspname = 'app' and c.relname = 'companies' and p.grantee = 'app_maintenance'::regrole`);
  assert.equal(after11, 'companies:UPDATE:status', 'the fail-before s grant reached a commit');

  sql('revoke app_maintenance from postgres');
  membershipHeld = false;
  assert.equal(settableGrants(), settableBefore, 'the stand-in grant is still held, so the role is still assumable');
});
