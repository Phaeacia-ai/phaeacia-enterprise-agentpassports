/* Migration 008's text against the contracts it must agree with, no stack (docs/e6/design.md 1.1, 1.4, 1.5, 1.6,
   1.7, 2.3, 2.4, 2.5, 2.7; section 5 cases 5, 18, 24, 26, 35). Every assertion here is a TRIPWIRE OVER MIGRATION
   TEXT and is labelled as one, in the same spirit as scripts/check-migrations.mjs: it can tell that a routine no
   longer says what the design decided, and it cannot tell that the routine behaves. The behaviour is tests/db/29 to
   31's, and each test below names the probe that carries it.

   The one the design asks for by name is the operator surface (1.1): app.operator_company_row is the ONLY function
   that turns a company into something an operator reads, so an operator-facing routine that selects a tenant content
   column outside it is refused here before anybody has to notice it in a register answer. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const M = readFileSync(join(REPO, 'supabase/migrations/008_lifecycle.sql'), 'utf8');

/* One function's definition: from its create or replace to the $$; that closes its body. The LATEST one from 008
   on, because a later migration that copies a routine forward replaces it, and a pin read from 008's copy would keep
   passing against code that no longer runs (END1-C1 of evidence/ena7-end1-hbf2.md: 011 replaces api.invite_member
   and api.accept_invitation). A routine 008 introduced and nothing replaced reads exactly as before. */
const LATER = readdirSync(join(REPO, 'supabase/migrations'))
  .filter((f) => /^\d{3}_.*\.sql$/.test(f) && f >= '008')
  .sort()
  .map((f) => readFileSync(join(REPO, 'supabase/migrations', f), 'utf8'));
function def(name) {
  let found = null;
  for (const text of LATER) {
    const start = text.lastIndexOf(`create or replace function ${name}(`);
    if (start < 0) continue;
    const open = text.indexOf('$$', start);
    found = text.slice(start, text.indexOf('$$;', open + 2) + 3);
  }
  return found;
}
const body = (name) => {
  const d = def(name);
  assert.ok(d, `${name} is defined in 008 or later`);
  return d;
};
/* The text of a `select array[...]` vocabulary, as its names. */
function names(fn) {
  const m = new RegExp(`function app\\.${fn}\\(\\)[\\s\\S]*?select array\\[([^\\]]+)\\]`).exec(M);
  assert.ok(m, `app.${fn} is defined`);
  return [...m[1].matchAll(/'([a-z_.]+)'/g)].map((x) => x[1]);
}

test('008 exists and is the E6 migration', () => {
  assert.ok(M.length > 0);
  assert.match(M, /008_lifecycle\.sql: onboarding and lifecycle \(E6\)/);
});

/* ---------------------------------------------------------------------------
   Design 1.1's named boundary. Probe 29c is the behavioural half: it searches the register's and the manifest's
   whole answers for every name the company holds and installs a mutant that leaks two of them.
   --------------------------------------------------------------------------- */
/* The columns that are a company's own content or a person's identity. A count of them is not one of them, which is
   why the detector reads a SELECT LIST and not the whole body: app.operator_company_row counts rows of every one of
   these tables. */
const CONTENT_COLUMNS = Object.freeze([
  'a.name', 'g.name', 'v.content', 'v.derived_canonical', 'v.derived', 'v.title',
  'cc.display_name', 'f.display_name', 'r.reason', 'p.losses', 'p.assistance', 'w.note',
  'i.email_normalized', 'u.email', 'rel.assembled_content', 'e.envelope_canonical', 'it.text',
]);
/* Every routine an operator may call, by the grant list of design 2.3 B14, each with the content columns it is
   allowed to name. api.create_company is the one exception and design 1.1 states it: the first admin's address is
   known to the operator BECAUSE THE OPERATOR TYPED IT, and the routine reads auth.users to refuse an address that
   belongs to an operator account. No later read gives the operator an address of anyone else. */
const OPERATOR_ROUTINES = Object.freeze([
  ['api.create_company', ['u.email']],
  /* E6S-C-F6 added the second allowance, and it is the SAME allowance: the succession count is taken net of the
     pending invitation for the address THE OPERATOR TYPED, so the routine compares i.email_normalized against
     p_email's normalised form. No address of anyone else is read and none is answered, which the assertion below
     holds it to exactly as it holds api.create_company. */
  ['api.operator_invite_admin', ['i.email_normalized']],
  ['api.set_company_status', []],
  ['api.set_access_period', []],
  ['api.set_company_quota', []],
  ['api.operator_register', []],
  ['api.operator_export_manifest', []],
  ['api.operator_expiry_run', []],
  ['api.close_company', []],
  ['api.delete_company', []],
]);

test("design 1.1: app.operator_company_row is the only function that turns a company into something an operator reads", () => {
  const row = body('app.operator_company_row');
  /* It selects identity, status, the access period, the quotas and counts, and nothing whose value is a name from
     inside the company. count(*) over those tables is what a count IS. */
  for (const col of ['a.name', 'g.name', 'v.content', 'f.display_name', 'r.reason', 'p.losses', 'w.note']) {
    assert.equal(row.includes(`'${col.split('.')[1]}', ${col}`), false, `${col} is not a field of the register`);
  }
  /* The comment that says what the line is, which sits above the function and is what a later reader adding a
     field is meant to read first. */
  assert.match(M, /COUNTS ONLY: no\s*\n-- agent name, no group name, no candidate title, no member address/i);
  /* Its own select list carries slug and name, which are the COMPANY'S identity and not tenant content, and the
     design says so in 1.1's "two things that look like exceptions and are not". */
  assert.match(row, /'slug', c\.slug/);
  assert.match(row, /'name', c\.name/);
});

test('design 1.1: no operator-facing routine names a tenant content column anywhere in its own body', () => {
  const offenders = [];
  for (const [fn, allowed] of OPERATOR_ROUTINES) {
    const d = body(fn);
    for (const col of CONTENT_COLUMNS) if (d.includes(col) && !allowed.includes(col)) offenders.push(`${fn}: ${col}`);
  }
  assert.deepEqual(offenders, []);
  /* And the one allowance is where design 1.1 puts it: the address the operator typed, compared against the operator
     table, and never returned. */
  const cc = body('api.create_company');
  assert.match(cc, /from app\.operators o join auth\.users u on u\.id = o\.user_id\s*\n?\s*where lower\(u\.email\) = email_n/);
  assert.equal(/return query select[^;]*email/.test(cc), false, 'no address is in what it answers');
  /* E6S-C-F6's allowance, held to the same two things: the only address it names is the one the operator typed,
     compared against the pending invitations of the company the operator named, and none is answered. */
  const oia = body('api.operator_invite_admin');
  assert.match(oia, /email_n text := lower\(btrim\(p_email\)\)/);
  assert.match(oia, /and i\.email_normalized <> email_n\) then/);
  assert.equal(/return query select[^;]*email_normalized/.test(oia), false, 'no address is in what it answers');
});

test('design 1.1 control: the detector finds the mutant fixture probe 29c installs', () => {
  const fixture = readFileSync(join(REPO, 'tests/db/fixtures/e6-operator-surface-mutant.sql'), 'utf8');
  assert.match(fixture, /''agent_names'', \(select coalesce\(jsonb_agg\(a\.name/);
  assert.match(fixture, /''group_names'', \(select coalesce\(jsonb_agg\(g\.name/);
  assert.match(fixture, /tests\.e6_mutate\('app\.operator_company_row\(app\.companies, boolean\)'/);
  assert.ok(CONTENT_COLUMNS.includes('a.name'), 'a.name is in the detector s list');
  assert.ok(CONTENT_COLUMNS.includes('g.name'), 'g.name too');
});

test('design 1.1, 1.6 (E6D-C-F1a): there is no operator arm in the export and no operator export routine', () => {
  assert.equal(M.includes('api.operator_export('), false, 'no api.operator_export');
  const admin = body('app.export_admin');
  assert.equal(/app\.operators/.test(admin), false, 'app.export_admin tests no operator row');
  const exp = body('api.export_company');
  assert.equal(/app\.operator_actor\(\)/.test(exp), false, 'api.export_company never derives an operator');
  assert.match(M, /A COMPANY ADMIN at aal2 of that company, and NOBODY ELSE/);
});

/* ---------------------------------------------------------------------------
   Design 1.5's two locks. Probe 29n (case 35) is the behavioural half, with the mutant that puts one operator
   routine back on the member-facing lock.
   --------------------------------------------------------------------------- */
const OPERATOR_LOCK = Object.freeze([
  'api.set_company_status', 'api.set_access_period', 'api.set_company_quota', 'api.close_company',
  'api.delete_company', 'api.operator_invite_admin', 'api.transfer_first_admin',
]);

test('design 1.5: every operator routine takes app.lock_company_operator and none takes app.lock_company', () => {
  for (const fn of OPERATOR_LOCK) {
    const d = body(fn);
    assert.match(d, /app\.lock_company_operator\(/, `${fn} takes the operator lock`);
    assert.equal(/app\.lock_company\(/.test(d), false, `${fn} does not take the member-facing lock`);
  }
  /* api.operator_expiry_run locks SEVERAL company rows in one transaction, which no other routine does, and it is
     the eighth (design 1.5, 2.5). */
  const run = body('api.operator_expiry_run');
  assert.match(run, /app\.lock_company_operator\(rec\.id\)/);
  assert.equal(/app\.lock_company\(/.test(run), false);
  assert.match(run, /order by c2\.id/, 'selected and locked in ascending company id');
  /* api.create_company locks a row it has just inserted, through app.new_company, so either lock serves and it
     takes the operator one for consistency (design 2.3 B5). */
  assert.match(body('app.new_company'), /app\.lock_company_operator\(c\.id\)/);
});

test('design 1.5: app.lock_company keeps its own refusals and gains exactly one test', () => {
  const d = body('app.lock_company');
  assert.match(d, /for no key update/);
  assert.match(d, /raise exception 'E_NOT_FOUND' using errcode = 'P0002'/);
  assert.match(d, /raise exception 'E_COMPANY_INACTIVE' using errcode = 'P0001'/);
  assert.match(d, /p\.ends_at <= clock_timestamp\(\)/, 'the write boundary is ends_at');
  assert.match(d, /raise exception 'E_ACCESS_PERIOD_ENDED' using errcode = 'P0001'/);
  /* And app.lock_company_operator tests NEITHER the status nor the period: each of the eight applies its own rule
     to the row it gets back, which is what makes an expired agreement extendable at all. */
  const o = body('app.lock_company_operator');
  assert.match(o, /for no key update/);
  assert.equal(/E_COMPANY_INACTIVE/.test(o), false);
  assert.equal(/E_ACCESS_PERIOD_ENDED/.test(o), false);
});

test('design 1.5: api.accept_invitation keeps app.lock_company, which is the restore step a succession needs', () => {
  const d = body('api.accept_invitation');
  assert.match(d, /perform app\.lock_company\(inv\.company_id\)/);
  assert.equal(/lock_company_operator/.test(d), false);
});

test('design 1.5, E6D-C-F3: the read boundary is computed from TIME and never from companies.status', () => {
  const state = body('app.access_state');
  assert.match(state, /clock_timestamp\(\)/);
  assert.equal(/status/.test(state), false, 'app.access_state reads no status column');
  const standing = body('app.my_standing');
  assert.match(standing, /app\.access_state\(c\.id\)/);
  /* E6D-C-F6 settled inside the door: the predicate filters active memberships. */
  assert.match(standing, /m\.user_id = \(select auth\.uid\(\)\) and m\.status = 'active'/);
  /* The download's half of the boundary, in the same replacement as its quota (E6D-C-F4). */
  const dl = body('app.download_refusal_for');
  assert.match(dl, /p\.export_by <= clock_timestamp\(\)/);
  assert.match(dl, /then 'E_ACCESS_PERIOD_ENDED'/);
  assert.match(dl, /app\.quota\(r\.company_id, 'downloads_per_recipient'\)/);
  /* And the export's own test, because it loads no principal. */
  assert.match(body('api.export_company'), /p\.export_by <= clock_timestamp\(\)/);
});

/* ---------------------------------------------------------------------------
   Design 2.5's stated rule: a three-valued comparison never guards an authorization, so test for NULL first.
   Probe 31a (case 36) is the behavioural half, and its mutant removes exactly the line this test requires.
   --------------------------------------------------------------------------- */
test('design 2.5, E6D-C-F2: every record a routine authorizes from is refused `is null` on its own line first', () => {
  const t = body('api.transfer_agent');
  const meNull = t.indexOf("if me.id is null then raise exception 'E_NOT_FOUND'");
  const meUsed = t.indexOf('me.id = a.owner_membership_id');
  assert.ok(meNull > 0, 'the caller s standing is refused explicitly');
  assert.ok(meNull < meUsed, 'and before any comparison uses it');
  const targetNull = t.indexOf("if target.id is null then raise exception 'E_NOT_FOUND'");
  assert.ok(targetNull > 0 && targetNull < meUsed);
  /* The agent is re-read under its own FOR UPDATE and the owner arm is evaluated from THAT row. */
  const locked = t.lastIndexOf('for update;           -- level 4');
  assert.ok(locked > 0 && locked < meUsed, 'the authority comes from the locked row');
  /* The honest retry is FIRST and requires status = active, so an orphan is un-orphaned rather than answered
     changed: false (design 2.3 B7's note, probe 29g's third branch). */
  const honest = t.indexOf("a.owner_membership_id = p_to_membership and a.status = 'active'");
  const stale = t.indexOf('a.owner_membership_id <> p_expected_owner');
  assert.ok(honest > 0 && stale > 0 && honest < stale);
  for (const fn of ['app.export_admin', 'app.departure_subject']) {
    assert.match(body(fn), /is null then raise exception 'E_NOT_FOUND'/, `${fn} refuses a missing row explicitly`);
  }
});

/* ---------------------------------------------------------------------------
   Design 1.4's snapshot (E6D-C-F9). Probe 29h asserts the same two facts against the live catalog; this asserts
   them against the text, so a later edit that makes the routine plpgsql has to change this line too.
   --------------------------------------------------------------------------- */
test('design 1.4, E6D-C-F9: api.departure_preview is language sql stable and one statement', () => {
  const d = body('api.departure_preview');
  assert.match(d, /language sql stable security definer/);
  assert.equal(/plpgsql/.test(d), false);
  assert.equal(/begin\b/.test(d), false, 'no block, so no second statement');
  /* One statement: one select, and its semicolons are inside the string-free body of scalar subqueries. */
  const sql = d.slice(d.indexOf('$$') + 2, d.lastIndexOf('$$'));
  assert.equal(sql.split(';').length - 1, 0, 'no statement separator inside the body');
  assert.equal((sql.match(/^\s*select /gm) ?? []).length >= 1, true);
});

test('design 1.6, 2.5, E6D-C-F9: the export s snapshot is the function s own setting and no inline SET', () => {
  assert.match(M, /alter function api\.export_company\(uuid\) set default_transaction_isolation = 'repeatable read';/);
  const d = body('api.export_company');
  assert.equal(/set transaction isolation level/i.test(d), false, 'never a SET inside the body');
  assert.equal(/language plpgsql security definer/.test(d), true);
  assert.equal(/\bstable\b/.test(d.slice(0, d.indexOf('as $$'))), false, 'it stays VOLATILE, because it audits');
});

/* ---------------------------------------------------------------------------
   Design 1.6's one door. Probe 30d is the behavioural half, table by table and role by role.
   --------------------------------------------------------------------------- */
const REPLACED_GUARDS = Object.freeze([
  'app.audit_append_only', 'app.membership_identity_guard', 'app.candidate_no_delete', 'app.contributors_frozen',
  'app.group_no_delete', 'app.envelope_immutable', 'app.review_immutable', 'app.release_immutable',
  'app.ledger_append_only', 'app.report_append_only', 'app.witness_append_only', 'app.company_status_guard',
]);

test('design 1.6: the twelve replaced guards each carry the bypass with its tg_op = DELETE test, and nothing else does', () => {
  const BYPASS = "if tg_op = 'DELETE' and current_setting('app.tenant_deletion', true) = 'on' then return old; end if;";
  for (const fn of REPLACED_GUARDS) {
    const d = body(fn);
    assert.ok(d.includes(BYPASS), `${fn} carries the bypass, DELETE only`);
    /* The bypass is the FIRST statement of the body, so no refusal runs ahead of it. */
    const begin = d.indexOf('begin');
    assert.ok(d.indexOf(BYPASS) - begin < 220, `${fn}: the bypass is first`);
  }
  assert.equal(REPLACED_GUARDS.length, 12);
  /* app.registry_frozen is NOT among them: the registers are Phaeacia's, not a company's rows. */
  assert.equal(def('app.registry_frozen'), null, '008 does not replace app.registry_frozen');
  assert.match(M, /app\.registry_frozen is NOT among/i);
});

test('design 1.6 control: the mutant fixture probe 30d installs is the bypass WITHOUT the tg_op test', () => {
  const fixture = readFileSync(join(REPO, 'tests/db/fixtures/e6-bypass-no-tgop-mutant.sql'), 'utf8');
  assert.match(fixture, /if current_setting\(''app\.tenant_deletion'', true\) = ''on'' then return coalesce\(new, old\)/);
  assert.equal(/tg_op = ''DELETE'' and current_setting.*then return coalesce/.test(fixture), false);
});

test('design 1.6, 2.4: the two section vocabularies are the eighteen and the twenty-one, and the export emits exactly its own', () => {
  const del = names('deletion_section_names');
  const exp = names('export_section_names');
  assert.equal(del.length, 18);
  assert.equal(exp.length, 21);
  /* E6D-C-F15: five of the export's sections are not deletion sections, which is why one shared list refused the
     export's own audit insert. */
  const onlyExport = exp.filter((n) => !del.includes(n));
  assert.deepEqual(onlyExport.sort(), ['gate_identities', 'installer_texts', 'profiles', 'release_policies', 'release_targets']);
  /* The guard checks each key against THE ACTING ACTION'S list. */
  const guard = body('app.audit_details_guard');
  assert.match(guard, /new\.action in \('company\.delete', 'company\.export'\)/);
  assert.match(guard, /when new\.action = 'company\.delete'\s*\n?\s*then app\.deletion_section_names\(\)/);
  assert.match(guard, /else app\.export_section_names\(\) end/);
  /* The export's own document names all twenty-one sections and nothing else. */
  const e = body('api.export_company');
  for (const n of exp) assert.ok(e.includes(`'${n}',`), `the export emits ${n}`);
  /* And the deletion deletes all eighteen, children before parents. */
  const d = body('api.delete_company');
  for (const n of del) assert.ok(d.includes(`jsonb_build_object('${n}',`), `the deletion counts ${n}`);
  const order = del.map((n) => d.indexOf(`jsonb_build_object('${n}',`));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the eighteen are in the order of design 1.6');
});

test('design 1.6: the deletion is eligible from export_by and the closure carries the export-window rule', () => {
  const d = body('api.delete_company');
  assert.match(d, /p\.export_by <= clock_timestamp\(\)/);
  assert.equal(/p\.delete_by <= clock_timestamp\(\)/.test(d), false, 'never delete_by, which left no window');
  assert.match(d, /raise exception 'E_DELETION_NOT_DUE'/);
  /* The slug confirmation is told BEFORE the policy answer (design 3.5's note). */
  assert.ok(d.indexOf('E_CONFIRMATION_MISMATCH') < d.indexOf('E_DELETION_NOT_DUE'));
  const c = body('api.close_company');
  assert.match(c, /p\.export_by > clock_timestamp\(\)/);
  assert.match(c, /window_open and p_reason_code <> 'customer_instruction'/);
  assert.match(c, /raise exception 'E_EXPORT_WINDOW_OPEN'/);
  /* Both vocabularies are the plan's two reasons plus the operator's own. */
  for (const fn of ['api.close_company', 'api.delete_company']) {
    assert.match(body(fn), /'retention_deadline', 'customer_instruction', 'operator_request'/);
  }
});

/* ---------------------------------------------------------------------------
   Design 1.7's quotas, and the one arithmetic E6 inherits (design section 6).
   --------------------------------------------------------------------------- */
test('design 1.7: the seven quota names are the vocabulary, the default table and the bounds table, all three', () => {
  const q = names('quota_names');
  assert.equal(q.length, 7);
  const dflt = body('app.quota_default');
  const bounds = body('app.quota_bounds');
  for (const n of q) {
    assert.ok(dflt.includes(`when '${n}'`), `app.quota_default branches on ${n}`);
    assert.ok(bounds.includes(`when '${n}'`), `app.quota_bounds branches on ${n}`);
  }
  /* The default of a quota IS the existing constant, so the constant keeps its arithmetic and its comment. */
  for (const c of ['app.limit_agents_per_company()', 'app.limit_groups_per_company()', 'app.limit_versions_per_agent()',
                   'app.limit_downloads_per_recipient()', 'app.limit_reports_per_recipient()']) {
    assert.ok(dflt.includes(c), `${c} is the default it falls through to`);
  }
  /* One reader, granted to nobody. */
  assert.match(M, /revoke all on function app\.quota\(uuid, text\) from public;/);
  assert.match(body('app.quota'), /coalesce\(\(select q\.value from app\.company_quotas q/);
});

test('design section 6: app.limit_ledger_rows is the number lib/services/evidence-reads.mjs holds', async () => {
  const sql = /function app\.limit_ledger_rows\(\)[\s\S]*?select (\d+) \$\$/.exec(M);
  assert.ok(sql, 'app.limit_ledger_rows is defined');
  const js = readFileSync(join(REPO, 'lib/services/evidence-reads.mjs'), 'utf8');
  const ceiling = /export const LEDGER_CEILING = (\d+);/.exec(js);
  assert.ok(ceiling, 'LEDGER_CEILING is exported');
  assert.equal(Number(sql[1]), Number(ceiling[1]),
    'the two copies of E4 s ledger ceiling cannot drift, as 007 s limits cannot drift from lib/rules/installations.mjs');
  /* And api.set_company_quota compares the PRODUCT against it, which is what turns an inherited condition into a
     refusal (probe 29e is the behavioural half of the quota table; this is the arithmetic). */
  const s = body('api.set_company_quota');
  assert.match(s, /lifetime \* downloads_after > app\.limit_ledger_rows\(\)/);
  assert.match(s, /select count\(\*\)::int into lifetime from app\.memberships m where m\.company_id = c\.id/);
});

test('design 1.7: the five accepted call sites read app.quota and no longer read their constant directly', () => {
  const sites = [
    ['api.create_draft', "app.quota(p_company, 'agents_per_company')", 'app.limit_agents_per_company()'],
    ['api.create_draft', "app.quota(p_company, 'versions_per_agent')", 'app.limit_versions_per_agent()'],
    ['api.create_successor', "app.quota(company, 'versions_per_agent')", 'app.limit_versions_per_agent()'],
    ['api.create_group', "app.quota(p_company, 'groups_per_company')", 'app.limit_groups_per_company()'],
    ['api.report_installation', "app.quota(company, 'reports_per_recipient')", 'app.limit_reports_per_recipient()'],
    ['app.download_refusal_for', "app.quota(r.company_id, 'downloads_per_recipient')", 'app.limit_downloads_per_recipient()'],
  ];
  for (const [fn, now, before] of sites) {
    const d = body(fn);
    assert.ok(d.includes(now), `${fn} reads ${now}`);
    assert.equal(d.includes(before), false, `${fn} no longer reads ${before}`);
  }
});

test('design 1.2, 1.7: the two new bounds count NET of the sibling being replaced (E6D-C-F7 settled)', () => {
  const d = body('api.invite_member');
  const net = (d.match(/i\.email_normalized <> email_n/g) ?? []).length;
  assert.equal(net, 2, 'both counts exclude the address this call is about to revoke');
  assert.match(d, /raise exception 'E_INVITATION_LIMIT'/);
  assert.match(d, /raise exception 'E_SEATS_EXHAUSTED'/);
  /* The authoritative check is at acceptance, with the one named exception worth exactly one seat (E6D-C-F5). */
  const a = body('api.accept_invitation');
  assert.match(a, /seat_bonus := case when inv\.created_by_operator is not null/);
  assert.match(a, /\+ seat_bonus then/);
  assert.match(a, /if m\.id is null or m\.status = 'removed' then/, 'only when it would ADD an active membership');
});

test('design 1.1, E6D-C-F1c and E6S-C-F1: the disjointness rule lives at the three creation points, under one account lock, and nowhere else', () => {
  /* E6S-C-F1 moved the rule out of three inline `if exists` tests and into ONE routine that reads BOTH tables,
     called under app.lock_account at each of the three doors. What the three doors must show is therefore the
     lock and the call, in that order, and what the rule itself must show is that it reads both tables and raises
     each code for the principal the caller is not creating. */
  const dis = body('app.require_disjoint_principal');
  assert.match(dis, /select exists \(select 1 from app\.operators o where o\.user_id = p_user\),\s*\n\s*exists \(select 1 from app\.memberships m where m\.user_id = p_user\)/);
  assert.match(dis, /if p_becoming = 'member' and is_operator then\s*\n\s*raise exception 'E_OPERATOR_ACCOUNT'/);
  assert.match(dis, /if p_becoming = 'operator' and is_member then\s*\n\s*raise exception 'E_MEMBER_ACCOUNT'/);
  /* The lock is one advisory lock on the ACCOUNT, and it is level 0: each door takes it before any other lock. */
  const lock = body('app.lock_account');
  assert.match(lock, /pg_advisory_xact_lock\(hashtext\('app\.principal_of_account'\), hashtext\(p_user::text\)\)/);
  const accept = body('api.accept_invitation');
  assert.match(accept, /perform app\.lock_account\(actor\);\s*\n\s*perform app\.require_disjoint_principal\(actor, 'member'\);/);
  assert.ok(accept.indexOf('app.lock_account(actor)') < accept.indexOf('app.lock_company(inv.company_id)'),
    'the account lock is taken before the company lock, which is what makes the order total');
  /* And BOTH identities are re-read after the one wait this routine has. */
  assert.equal((accept.match(/perform app\.require_disjoint_principal\(actor, 'member'\);/g) ?? []).length, 2);
  assert.ok(accept.indexOf('app.lock_company(inv.company_id)') <
    accept.lastIndexOf("perform app.require_disjoint_principal(actor, 'member');"));
  const prov = body('api.provision_company');
  assert.match(prov, /perform app\.lock_account\(p_first_admin_user\);\s*\n\s*perform app\.require_disjoint_principal\(p_first_admin_user, 'member'\);/);
  assert.ok(prov.indexOf('app.lock_account(p_first_admin_user)') < prov.indexOf('app.new_company('));
  const add = body('api.add_operator');
  assert.match(add, /perform app\.lock_account\(p_user\);\s*\n\s*perform app\.require_disjoint_principal\(p_user, 'operator'\);/);
  assert.ok(add.indexOf('app.require_disjoint_principal') < add.indexOf('from app.operators o where o.user_id = p_user'),
    'above the idempotent branch, so an account that should never have been an operator is refused');
  /* No door tests only its own half any more, which is what the critique's schedule defeated. */
  for (const fn of ['api.accept_invitation', 'api.provision_company', 'api.add_operator']) {
    assert.equal(/if exists \(select 1 from app\.(operators|memberships) [\s\S]{0,120}?raise exception 'E_(OPERATOR|MEMBER)_ACCOUNT'/.test(body(fn)), false,
      `${fn} does not carry its own copy of half the rule`);
  }
  /* api.operator_invite_admin and app.operator_invitation deliberately do NOT test the invited address. */
  for (const fn of ['api.operator_invite_admin', 'app.operator_invitation']) {
    assert.equal(/E_OPERATOR_ACCOUNT/.test(body(fn)), false, `${fn} does not repeat the rule`);
  }
  /* ENA-7 (011, D3): the administrator's api.invite_member refuses an operator's address EARLY, as api.create_company
     does for the operator's own path. It is an early answer and not the rule: acceptance stays authoritative. Until
     011 the invitation was made and, in handover mode, its link signed the administrator in as the operator. */
  assert.match(
    body('api.invite_member'),
    /if exists \(select 1 from app\.operators o join auth\.users u on u\.id = o\.user_id where lower\(u\.email\) = email_n\) then\s*\n\s*raise exception 'E_OPERATOR_ACCOUNT'/,
  );
  /* api.transfer_first_admin needs no check: it grants a role to a membership that already exists. */
  assert.equal(/E_OPERATOR_ACCOUNT|E_MEMBER_ACCOUNT/.test(body('api.transfer_first_admin')), false);
  /* And the one-time check is a DO block that fails the migration, not a constraint. */
  assert.match(M, /raise exception 'E_DUAL_PRINCIPAL' using errcode = 'P0001'/);
  assert.equal(/add constraint .*operators/.test(M), false, 'no constraint is installed over data nobody looked at');
});

/* The lead's decision on the database lane's question 1 (E6DB-F4, evidence/e6-db.md section 5): the suspension's
   reason is the operator's word from a closed list of three and no longer the fixed 'operator_request', so an audit
   row can tell a non-payment suspension from one the customer asked for. Probe 29's case 21 is the behavioural half,
   with the refusal of a word outside the list. */
test("the lead's decision (a): api.set_company_status takes a reason code from a closed list of three", () => {
  const d = body('api.set_company_status');
  assert.match(d, /function api\.set_company_status\(p_company uuid, p_status text, p_reason_code text\)/);
  const list = /p_reason_code not in \(([^)]+)\)/.exec(d);
  assert.ok(list, 'the closed list is a literal in the routine, not a table nobody can read');
  assert.deepEqual(
    [...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    ['customer_request', 'non_payment', 'operator_decision'],
  );
  assert.match(d, /p_reason_code is null/, 'an absent reason code is refused, not defaulted');
  assert.match(d, /'reason_code', p_reason_code\)\)/, "the audit row carries the operator's word");
  assert.equal(/'operator_request'/.test(d), false, 'the fixed reason code is gone from this routine');
  for (const line of ['  api.set_company_status(uuid, text, text),'])
    assert.equal(M.split(line).length - 1, 2, 'the revoke and the grant both name the three-argument signature');
  assert.equal(M.includes('api.set_company_status(uuid, text),'), false, 'no two-argument signature survives');
});

/* E6S-F1, the lead's condition (1). 008's B15 replaces api.authorize_download, which is B6's download half and was
   accepted under a full Codex critique, so the replacement has to be provably 007's text plus ONE arm rather than a
   hundred lines a reviewer diffs by eye. This test lifts both definitions from the two migration files and does
   that comparison itself. */
function definitionOf(file, name) {
  const text = readFileSync(join(REPO, 'supabase/migrations', file), 'utf8');
  const start = text.lastIndexOf(`create or replace function ${name}(`);
  assert.ok(start >= 0, `${name} is in ${file}`);
  const open = text.indexOf('$$', start);
  return text.slice(start, text.indexOf('$$;', open + 2) + 3);
}

test("E6S-F1: 008's api.authorize_download is 007's body with exactly one more arm and no other difference", () => {
  const accepted = definitionOf('007_installations.sql', 'api.authorize_download');
  const replaced = definitionOf('008_lifecycle.sql', 'api.authorize_download');
  const ARM = "      when 'E_ACCESS_PERIOD_ENDED' then\n        raise exception 'E_ACCESS_PERIOD_ENDED' using errcode = 'P0001';\n";
  assert.equal(replaced.includes(ARM), true, 'the new arm is there');
  assert.equal(replaced.replace(ARM, ''), accepted, "and removing it leaves 007's text character for character");
  /* The four properties the lead asked to be said out loud, each read from the text above rather than assumed. */
  assert.match(replaced, /^create or replace function api\.authorize_download\(p_release uuid\) returns jsonb\n/);
  assert.match(replaced, /language plpgsql security definer set search_path = ''/);
  /* No company lock is TAKEN: E4 1.4 forbids it here and E5 1.2 is why the predicate carries the read boundary
     instead. The name appears once, in the comment that says exactly that. */
  assert.equal(/perform app\.lock_company/.test(replaced), false, 'no company lock is taken');
  assert.equal(replaced.split('app.lock_company').length - 1, 1, 'the one occurrence is the comment that says so');
  const order = ['for share', 'pg_advisory_xact_lock', 'app.download_refusal_for', 'insert into app.release_downloads'];
  let at = -1;
  for (const step of order) {
    const next = replaced.indexOf(step, at + 1);
    assert.ok(next > at, `the lock order keeps ${step} in place`);
    at = next;
  }
  /* CREATE OR REPLACE keeps a function's privileges, owner and settings, so 007's grant line still governs and
     008 repeats no grant for it. The thirteen E6 routines are granted in B14 and this is not one of them. */
  assert.equal(/grant execute on function api\.authorize_download/.test(M), false);
  assert.equal(/revoke execute on function api\.authorize_download/.test(M), false);
});

test('design 2.3 B14: the thirteen api routines are granted to app_server alone', () => {
  const grant = M.slice(M.indexOf('grant execute on function\n  api.create_company'));
  const granted = [...grant.matchAll(/^  (api\.[a-z_]+)\(/gm)].map((m) => m[1]);
  assert.equal(granted.length, 13, 'thirteen, which is what lib/db/server.mjs FUNCTIONS carries');
  assert.match(grant, /to app_server;/);
  assert.match(M, /from public, anon, authenticated, service_role;/);
});

test('design 2.6 item 1: lib/db/server.mjs FUNCTIONS carries exactly those thirteen names, and BOUND gains nothing', async () => {
  process.env.SUPABASE_URL ??= 'http://127.0.0.1:1';
  process.env.SUPABASE_ANON_KEY ??= 'unit';
  const { FUNCTIONS, BOUND } = await import('../../../lib/db/server.mjs');
  const E6 = ['create_company', 'operator_invite_admin', 'set_company_status', 'set_access_period',
              'set_company_quota', 'operator_register', 'operator_export_manifest', 'operator_expiry_run',
              'close_company', 'delete_company', 'export_company', 'transfer_agent', 'departure_preview'];
  for (const fn of E6) {
    assert.ok(FUNCTIONS.includes(fn), `FUNCTIONS carries ${fn}`);
    assert.equal(Object.hasOwn(BOUND, fn), false, `${fn} is unbound, so BOUND gains nothing`);
  }
  assert.equal(E6.length, 13);
  /* And every one of them is in the migration, by that name. */
  for (const fn of E6) assert.ok(def(`api.${fn}`), `api.${fn} is defined in 008`);
});

test('design 2.4: the new audit keys are ids, integers, enumerated values and short codes, and no free text', () => {
  const guard = body('app.audit_details_guard');
  for (const k of ['previous_owner_membership_id']) assert.ok(guard.includes(`'${k}'`), `${k} is an id key`);
  for (const k of ['quota_value', 'quota_value_before', 'deleted_rows', 'withheld_rows', 'serialized_bytes']) {
    assert.ok(guard.includes(`'${k}'`), `${k} is an integer key`);
  }
  for (const k of ['ends_at', 'export_by', 'delete_by']) assert.ok(guard.includes(`'${k}'`), `${k} is a timestamp key`);
  assert.match(guard, /when 'quota_name' then\s*\n\s*ok := jsonb_typeof\(v\) = 'string' and \(v #>> '\{\}'\) = any \(app\.quota_names\(\)\)/);
  /* The size bound and the else arm are unchanged, so an unknown key is still refused by name. */
  assert.match(guard, /raise exception 'E_AUDIT_DETAILS_KEY %', k using errcode = '23514'/);
  assert.match(guard, /octet_length\(new\.details::text\) > 2048/);
});

test("design 2.3, the number: 008 registers no gate identity, no installer text and no target, so the two slices commute", () => {
  /* app.release_target_names() appears once, inside the audit guard, because 008 carries 007's whole body for it and
     that vocabulary reference is one of 007's own lines. What the number rests on is that 008 WRITES to none of the
     registers and never sets the registry bypass. */
  const SQL = M.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  assert.equal((SQL.match(/app\.release_target_names\(\)/g) ?? []).length, 1);
  const guard = body('app.audit_details_guard');
  assert.ok(guard.includes('app.release_target_names()'), 'and that one is the guard s inherited line');
  assert.equal(/insert into app\.gate_identities/.test(SQL), false);
  assert.equal(/insert into app\.installer_texts/.test(SQL), false);
  assert.equal(/insert into app\.release_targets/.test(SQL), false);
  assert.equal(/insert into app\.release_policies/.test(SQL), false);
  assert.equal(/app\.registry_migration/.test(SQL), false, 'and it never sets the registry bypass');
  assert.equal(/app\.registry_frozen/.test(SQL), false, 'and it never replaces the registers guard');
});

test('design 1.6: the export names what it omits, and never selects token_hash', () => {
  const e = body('api.export_company');
  assert.match(e, /'omitted', to_jsonb\(array\['invitations\.token_hash'/);
  for (const n of ['idempotency_keys', 'auth.users', 'operators', 'operator_allowlist', 'mfa_attempt_windows',
                   'gate_identity_files', 'access_periods']) {
    assert.ok(e.includes(`'${n}'`), `the omitted array names ${n}`);
  }
  /* The invitations section's column list does not name token_hash at all. */
  const inv = e.slice(e.indexOf("'invitations', (select"), e.indexOf("'profiles', (select"));
  assert.equal(/token_hash/.test(inv), false);
  /* E6S-C-F3: the candidate filter is the TAKEOUT'S own predicate, because app.candidate_visible_to reaches
     app.membership_of, which requires an active company and therefore emptied the document for exactly the
     suspended company the fourteen-day window exists for. The withheld object still names its reason, and after
     the correction that reason is true of what is withheld. */
  assert.match(e, /app\.export_candidate_visible\(v\.id, me\.id\)/);
  assert.equal(/app\.candidate_visible_to/.test(e), false, 'the accepted predicate is not the takeout filter any more');
  const vis = body('app.export_candidate_visible');
  assert.match(vis, /m\.status = 'active'/);
  assert.match(vis, /'company_admin' = any \(m\.roles\)/);
  assert.match(vis, /app\.jwt_claims\(\) ->> 'aal' = 'aal2'/);
  assert.match(vis, /v\.author_membership_id = m\.id or v\.state <> 'draft'/);
  assert.equal(/c\.status|companies/.test(vis), false, 'it does not test the company s status, which is the correction');
  /* E6S-C-F4: authority first, then time, then rows, so a caller with no standing learns nothing about the
     company's existence or its time state. */
  assert.ok(e.indexOf('me := app.export_admin(p_company)') < e.indexOf("raise exception 'E_ACCESS_PERIOD_ENDED'"));
  assert.ok(e.indexOf("raise exception 'E_ACCESS_PERIOD_ENDED'") < e.indexOf('app.export_candidate_visible(v.id, me.id)'),
    'the time test is above the first section, so no row predicate runs past export_by');
  assert.match(e, /'reason', 'another_author_draft'/);
  assert.match(e, /'reason', 'no_admin_read_predicate'/);
  /* Both gates, the estimate and the exact one. */
  assert.match(e, /2 \* \(app\.company_content_bytes\(c\.id\) \+ app\.company_assembled_bytes\(c\.id\)\)/);
  assert.match(e, /octet_length\(doc::text\)/);
  assert.equal((e.match(/E_EXPORT_TOO_LARGE/g) ?? []).length, 2, 'one refusal per gate');
});

/* ---------------------------------------------------------------------------
   011 (END-1 and ENA-7; evidence/ena7-end1-hbf2.md sections 5 and 6). TRIPWIRES OVER MIGRATION TEXT, as above. The
   behaviour is the PGlite cases of evidence/ena7-end1-hbf2-repro/pglite/ and is owed to a tests/db probe (XRR2-D5).
   These pins exist because the review found nothing in the repository that held D4, D5 or the claim's window
   (END1-CR-F3, F2): a later copy of either routine without them failed no repository check.
   --------------------------------------------------------------------------- */
test("END-1 (011, D5): acceptance tests the issuer's standing on the row re-read under the company lock", () => {
  const accept = body('api.accept_invitation');
  const reread = accept.indexOf('select * into inv from app.invitations where id = inv.id for update;');
  const standing = accept.search(
    /if inv\.created_by is not null\s+and not exists \(select 1 from app\.memberships im\s+where im\.id = inv\.created_by and im\.status = 'active'\s+and 'company_admin' = any \(im\.roles\)\) then\s+raise exception 'E_INVITATION_INVALID'/,
  );
  assert.ok(reread > 0 && standing > reread, 'after the re-read');
  assert.ok(standing < accept.indexOf('insert into app.memberships'), 'before any membership is written');
});

test("END-1 (011, D4): a removal, a demotion and a self-demoting acceptance revoke the issuer's pending invitations", () => {
  assert.match(
    body('api.set_roles'),
    /perform app\.revoke_issued_invitations\(target\.company_id, target\.id, actor, admin\.id, 'issuer_demoted'\);/,
  );
  assert.match(
    body('api.remove_member'),
    /perform app\.revoke_issued_invitations\(target\.company_id, target\.id, actor, admin\.id, 'issuer_removed'\);/,
  );
  const accept = body('api.accept_invitation');
  const revoke = accept.indexOf(
    "perform app.revoke_issued_invitations(inv.company_id, m.id, actor, null, 'issuer_demoted');",
  );
  assert.ok(revoke > 0, 'the self-demotion revokes');
  /* END1-CR-F6: after the acceptance is written, so the invitation being accepted is no longer pending. */
  assert.ok(revoke > accept.indexOf('update app.invitations set accepted_at = decided_at'), 'after the acceptance');
});

test("ENA-7 (011): the claim counts another company's claim for a signing link's life only, and locks in one order", () => {
  const claim = body('api.claim_invitation_handover');
  const life = /signing_life constant interval := interval '(\d+) minutes';/.exec(claim);
  assert.ok(life, 'one named interval');
  /* CR-ENA7-1: the interval is GoTrue's otp_expiry with a margin, held against both places that set it. */
  const otp = /^\s*otp_expiry\s*=\s*(\d+)\s*$/m.exec(readFileSync(join(REPO, 'supabase/config.toml'), 'utf8'));
  const table = /\| Email OTP expiry \| (\d+) seconds \|/.exec(readFileSync(join(REPO, 'docs/self-hosting.md'), 'utf8'));
  assert.ok(otp && table, "config.toml and the self-hosting guide's Auth table both name it");
  assert.equal(otp[1], table[1], 'and agree');
  assert.ok(Number(life[1]) * 60 >= Number(otp[1]) + 300, 'the interval covers the link and five minutes');
  assert.match(
    claim,
    /o\.company_id <> inv\.company_id\s+and o\.handover_claimed_at > clock_timestamp\(\) - signing_life\) then\s+return false;/,
    "whatever the other row's state now: its link lives on after a revocation",
  );
  /* END1-CR-F2: advisory, then the company's row, then the invitation's. */
  const advisory = claim.indexOf('pg_advisory_xact_lock');
  const company = claim.indexOf('app.lock_company_operator(inv.company_id)');
  const row = claim.indexOf('for no key update');
  assert.ok(advisory > 0 && advisory < company && company < row, 'the lock order');
  assert.match(claim, /if co\.status = 'closed' or \(inv\.created_by is not null and co\.status <> 'active'\) then\s+return false;/);
});
