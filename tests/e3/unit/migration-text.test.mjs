/* The migration's text against the code it must agree with, no stack:
   - case 14, SQL half: 003 contains bindingSql(fn) and operationSql(fn) of lib/db/server.mjs verbatim, as the
     argument of app.bound_actor and as the operation digest, for all four functions (design 2.6 item 2), and so does
     the latest definition of each, which is the one a database runs (004 redefines api.submit_candidate);
   - 2.6 item 5: P0003 is raised with E_GATE_UNREGISTERED and nothing else, in every migration;
   - case 41's check.sh half: no migration creates a tests schema;
   - design 2.7: the identity 003 registers is the committed manifest's, as the generator writes it;
   - the decided limits (design 2.3, the lead's 2026-09-13 decisions) and case 42's text-level inequality;
   - migration 004 Part A: the declared-name trim class is String.prototype.trim()'s (E3A-R-D1), no type test in
     app.submission_fields can run before the one that makes it safe (E3A-D2), and every later migration that writes
     the gate registry sets the migration-time bypass first (E3A-D1);
   - migration 006 part A (E4 design 2.3): E4's four bound routines are pending in part B or bind verbatim; P0003 and
     P0004 carry only their named codes; the claim table admits exactly the bound functions, in the latest migration
     that widens it; 006 registers the generator's installer texts; the group name rule against Unicode;
     api.remove_member keeps 003's body and clears group rows at lock level 3; and the registry tripwire covers the
     three registers 006 freezes;
   - migration 007 (E5 design 2.3): the limits and the check-in interval are the values lib/rules/installations.mjs
     holds, so the two copies of the fourteen-day rule cannot drift (E5 design 1.4c). */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { manifest, registrationSql } from '../../../scripts/gate-manifest.mjs';
import { installerManifest, registrationSql as installerRegistrationSql } from '../../../scripts/installer-texts.mjs';
import { REPO } from './helpers.mjs';

process.env.SUPABASE_URL ??= 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY ??= 'unit';
const { BOUND, bindingSql, operationSql } = await import('../../../lib/db/server.mjs');

const DIR = join(REPO, 'supabase/migrations');
const MIGRATIONS = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(DIR, name), 'utf8') }));
const CONTENT = MIGRATIONS.find((m) => m.name === '003_content.sql')?.text ?? '';
const PART_A = MIGRATIONS.find((m) => m.name === '006_reviews_releases.sql')?.text ?? '';
const E5 = MIGRATIONS.find((m) => m.name === '007_installations.sql')?.text ?? '';

/* One function's last definition in a migration's text: from its create or replace to the $$; that closes its body. */
function definitionOf(text, name) {
  const start = text.lastIndexOf(`create or replace function ${name}(`);
  if (start < 0) return null;
  const open = text.indexOf('$$', start);
  return text.slice(start, text.indexOf('$$;', open + 2) + 3);
}
/* The definition a database runs: the one in the last migration that defines the function. */
function latest(name) {
  return MIGRATIONS.map((m) => ({ name: m.name, def: definitionOf(m.text, name) }))
    .filter((d) => d.def)
    .at(-1);
}

test('003_content.sql exists', () => {
  assert.ok(CONTENT.length > 0);
});

/* The four E3 routines are 003's. E4's four (design 2.6 item 1) are migration 006 part B's: until the E4 lane writes one,
   006 names it on its "Part B pending" line and no migration may define it; once written, the line no longer names it
   and its latest definition binds and identifies verbatim, as E3's do. No routine passes on nothing: each is checked or
   pending, and only an E4 routine can be pending. */
const E3_BOUND = Object.freeze(['create_draft', 'save_draft', 'submit_candidate', 'create_successor']);
const pendingOf = (text) => (/^-- Part B pending: (.+)$/m.exec(text)?.[1] ?? '').split(', ').filter(Boolean);
const PENDING = pendingOf(PART_A);

for (const fn of E3_BOUND) {
  test(`case 14, SQL half: ${fn} binds with bindingSql and identifies its operation with operationSql, verbatim`, () => {
    assert.ok(CONTENT.includes(`actor uuid := app.bound_actor('${fn}', ${bindingSql(fn)});`), `binding of ${fn}`);
    assert.ok(CONTENT.includes(`operation bytea := ${operationSql(fn)};`), `operation of ${fn}`);
    const signature = new RegExp(`create or replace function api\\.${fn}\\(`);
    assert.match(CONTENT, signature);
  });
}
for (const fn of Object.keys(BOUND)) {
  test(`case 14, SQL half, the definition a database runs: the latest api.${fn} binds and identifies verbatim, or is pending in 006 part B`, () => {
    const d = latest(`api.${fn}`);
    if (PENDING.includes(`api.${fn}`)) {
      assert.equal(E3_BOUND.includes(fn), false, `${fn} is E3's and cannot be pending`);
      assert.equal(d, undefined, `api.${fn} is named pending, yet ${d?.name} defines it`);
      return;
    }
    assert.ok(d, `api.${fn} is defined`);
    assert.ok(d.def.includes(`actor uuid := app.bound_actor('${fn}', ${bindingSql(fn)});`), `binding of ${fn} in ${d.name}`);
    assert.ok(d.def.includes(`operation bytea := ${operationSql(fn)};`), `operation of ${fn} in ${d.name}`);
  });
}

test('E4 2.6 item 1 and E5 2.6 item 1: BOUND is E3 s four, E4 s four and E5 s two, and the pending line names only E4 routines BOUND holds', () => {
  assert.deepEqual(
    Object.keys(BOUND)
      .filter((fn) => !E3_BOUND.includes(fn))
      .sort(),
    [
      'create_envelope',
      'publish_release',
      'record_review',
      'report_installation',
      'withdraw_release',
      'witness_installation',
    ],
  );
  for (const name of PENDING) {
    const fn = name.replace(/^api\./, '');
    assert.ok(Object.hasOwn(BOUND, fn) && !E3_BOUND.includes(fn), name);
  }
  /* The reader, on text: a pending line is read whole, and a file without one pends nothing. */
  assert.deepEqual(pendingOf('x\n-- Part B pending: api.a, api.b\ny'), ['api.a', 'api.b']);
  assert.deepEqual(pendingOf('-- no such line'), []);
});

test('case 14 control: a projection that drifts by one field is not in the migration', () => {
  const drifted = bindingSql('save_draft').replace("coalesce(p_expected_version::text, '-'), ", '');
  assert.notEqual(drifted, bindingSql('save_draft'));
  assert.equal(CONTENT.includes(drifted), false);
});

/* Every raise statement, with its message token and errcode. */
function raises(text) {
  return [...text.matchAll(/raise exception '([^']*)'[^;]*?errcode = '([0-9A-Z]{5})'/g)].map((m) => ({
    token: m[1].split(' ')[0],
    errcode: m[2],
  }));
}

/* One named class for each status the database answers outside 403, 404, 409 and 422 (lib/errors.mjs SQLSTATE_STATUS):
   P0003 is 503 and carries E_GATE_UNREGISTERED (E3 2.6 item 5) or E_INSTALLER_UNREGISTERED (E4 2.6 item 3); P0004 is
   500 and carries E_ASSEMBLY_DIVERGED (E4 1.9). Each rule is two-sided, and the parser is held to every errcode of the
   class written in the text, so a raise it cannot read fails rather than slips past. Until 006, the last assertion
   compared P0003 with 003 alone; it now counts every migration, so part B's raises are held to the same rule. */
const CLASSES = Object.freeze({
  P0003: ['E_GATE_UNREGISTERED', 'E_INSTALLER_UNREGISTERED'],
  P0004: ['E_ASSEMBLY_DIVERGED'],
});
function classViolations(migrations) {
  const all = migrations.flatMap((m) => raises(m.text).map((r) => ({ ...r, file: m.name })));
  const out = [];
  for (const [errcode, tokens] of Object.entries(CLASSES)) {
    for (const r of all) {
      if (r.errcode === errcode && !tokens.includes(r.token)) out.push(`${r.file}: ${r.token} under ${errcode}`);
      if (tokens.includes(r.token) && r.errcode !== errcode) out.push(`${r.file}: ${r.token} under ${r.errcode}`);
    }
    const written = migrations.reduce((n, m) => n + (m.text.match(new RegExp(`errcode = '${errcode}'`, 'g')) ?? []).length, 0);
    const parsed = all.filter((r) => r.errcode === errcode).length;
    if (written !== parsed) out.push(`${errcode}: ${written} written, ${parsed} parsed`);
  }
  return out;
}

test('2.6 item 5 and E4 2.6 item 3: P0003 carries only the two 503 refusals and P0004 only E_ASSEMBLY_DIVERGED, in every migration', () => {
  assert.ok(
    MIGRATIONS.flatMap((m) => raises(m.text)).some((r) => r.errcode === 'P0003' && r.token === 'E_GATE_UNREGISTERED'),
    'E3 raises E_GATE_UNREGISTERED under P0003',
  );
  assert.deepEqual(classViolations(MIGRATIONS), []);
});

test('the class rule refuses each crossing: another code under P0003 or P0004, a named code under another class, an unread raise', () => {
  const at = (sql) => classViolations([{ name: '099_x.sql', text: sql }]);
  assert.deepEqual(at("raise exception 'E_INSTALLER_UNREGISTERED' using errcode = 'P0003';"), []);
  assert.deepEqual(at("raise exception 'E_ASSEMBLY_DIVERGED' using errcode = 'P0004';"), []);
  assert.deepEqual(at("raise exception 'E_BUSY' using errcode = 'P0004';"), ['099_x.sql: E_BUSY under P0004']);
  assert.deepEqual(at("raise exception 'E_NOT_FOUND' using errcode = 'P0003';"), ['099_x.sql: E_NOT_FOUND under P0003']);
  assert.deepEqual(at("raise exception 'E_ASSEMBLY_DIVERGED' using errcode = 'P0001';"), [
    '099_x.sql: E_ASSEMBLY_DIVERGED under P0001',
  ]);
  assert.deepEqual(at("raise exception 'E_INSTALLER_UNREGISTERED' using errcode = 'P0001';"), [
    '099_x.sql: E_INSTALLER_UNREGISTERED under P0001',
  ]);
  assert.deepEqual(at("raise exception using errcode = 'P0004';"), ['P0004: 1 written, 0 parsed']);
});

test('every E_ token the migrations raise with a mapped SQLSTATE reaches its status through lib/errors.mjs', async () => {
  const { CODES } = await import('../../../lib/errors.mjs');
  const STATUS = { 42501: 403, P0002: 404, P0001: 409, P0003: 503, P0004: 500, 22023: 422, 23514: 422 };
  /* Raised only where no client path reaches: the audit guard, and the owner-side refusals of candidate history
     (003), of the gate registry and E4's registers (004, E3A-D1), of groups (006 part A) and of part B's envelopes,
     releases and ledger (E4 design 3.5), which answer a maintenance command and never a request. */
  const OWNER_SIDE = new Set([
    'E_CANDIDATE_DELETE',
    'E_REGISTRY_FROZEN',
    'E_GROUP_DELETE',
    'E_ENVELOPE_DELETE',
    'E_RELEASE_DELETE',
    'E_LEDGER_APPEND_ONLY',
    /* E5 design 3.5: the two evidence tables' append-only refusals, reachable by no PostgREST role. */
    'E_REPORT_APPEND_ONLY',
    'E_WITNESS_APPEND_ONLY',
    /* E6 design 2.6 item 3: the company guard's two refusals are reachable by no PostgREST role and join CODES only
       if a route could surface them; neither can, exactly as E_MEMBERSHIP_DELETE does not. E_DUAL_PRINCIPAL is
       narrower still: it aborts migration 008 itself over data nobody has looked at (E6 design 1.1) and no session
       of any role can reach it. */
    'E_COMPANY_DELETE',
    'E_COMPANY_IDENTITY',
    'E_DUAL_PRINCIPAL',
  ]);
  /* Three tokens that a ROUTE raises at one SQLSTATE and an owner-side trigger raises at another: 008's twelve
     replaced guards each keep their own 42501, while the routines of the same slice answer a caller at P0001 or
     22023. The token alone cannot say which, so the owner-side arm is named by its pair. */
  /* E7 design 2.1 (migration 009): the same split for the recovery hold. app.company_status_guard refuses a move
     into or out of `held` at 42501 without the recovery setting, which only an owner session can set and no
     PostgREST role reaches; api.set_company_status answers a caller at P0001, which is CODES' 409. */
  const OWNER_SIDE_PAIRS = new Set([
    'E_COMPANY_CLOSED 42501',
    'E_MEMBERSHIP_DELETE 42501',
    'E_MEMBERSHIP_IDENTITY 42501',
    'E_RECOVERY_HOLD 42501',
  ]);
  const unmapped = [];
  for (const { name, text } of MIGRATIONS.filter((m) => m.name >= '003')) {
    for (const r of raises(text)) {
      if (r.token.startsWith('E_AUDIT_') || OWNER_SIDE.has(r.token)) continue;
      if (OWNER_SIDE_PAIRS.has(`${r.token} ${r.errcode}`)) continue;
      if (CODES[r.token] !== STATUS[r.errcode]) unmapped.push(`${name}: ${r.token} ${r.errcode}`);
    }
  }
  assert.deepEqual(unmapped, []);
});

const CREATES_TESTS_SCHEMA = /create\s+schema\s+(?:if\s+not\s+exists\s+)?"?tests"?(?![A-Za-z0-9_])/i;

test('case 41: no migration creates a tests schema', () => {
  assert.deepEqual(
    MIGRATIONS.filter((m) => CREATES_TESTS_SCHEMA.test(m.text)).map((m) => m.name),
    [],
  );
});

test('case 41 control: the detector finds the mutant fixture and the spellings a migration could use', () => {
  /* E5 design 2.7: tests/db/fixtures/e4-download-seam.sql is retired and E5's owner-only counterexample is the file
     that still creates a tests schema, so the control reads that one. */
  const fixture = readFileSync(join(REPO, 'tests/db/fixtures/e5-download-mutant.sql'), 'utf8');
  assert.match(fixture, CREATES_TESTS_SCHEMA);
  for (const s of ['create schema tests;', 'CREATE SCHEMA IF NOT EXISTS "tests";', 'create  schema\ntests']) {
    assert.match(s, CREATES_TESTS_SCHEMA, s);
  }
  assert.doesNotMatch('create schema tests_archive;', CREATES_TESTS_SCHEMA);
});

test('design 2.7: 003 registers exactly the committed manifest identity, as the generator writes it', async () => {
  const m = await manifest(REPO);
  const { GATE_IDENTITY_SHA256 } = await import('../../../lib/passport/gate-manifest.mjs');
  assert.equal(m.gateIdentitySha256, GATE_IDENTITY_SHA256);
  assert.ok(CONTENT.includes(registrationSql(m)), 'the registration block is the generator output for this manifest');
});

test('the decided limits are the values in the migration', () => {
  const fn = (name) => new RegExp(`function app\\.${name}\\(\\)[^;]*?\\$\\$\\s*select ([^$]+?)\\s*\\$\\$`, 's').exec(CONTENT)?.[1];
  assert.equal(fn('limit_agents_per_company'), '50');
  assert.equal(fn('limit_versions_per_agent'), '200');
  assert.equal(fn('limit_idempotency_rows'), '4000');
  assert.equal(fn('idempotency_sweep_batch'), '20');
  assert.equal(fn('idempotency_window'), "interval '7 days'");
  assert.equal(fn('idempotency_retention'), "app.idempotency_window() + interval '1 hour'");
});

test("case 42, text half: retention's margin over the window exceeds lib/db/server.mjs TOKEN_TTL_SECONDS", () => {
  const ttl = Number(/const TOKEN_TTL_SECONDS = (\d+);/.exec(readFileSync(join(REPO, 'lib/db/server.mjs'), 'utf8'))?.[1]);
  const margin = /app\.idempotency_window\(\) \+ interval '(\d+) hour'/.exec(CONTENT)?.[1];
  assert.ok(Number.isInteger(ttl) && ttl > 0);
  assert.ok(Number(margin) * 3600 > ttl, `margin ${margin} h against TTL ${ttl} s`);
});

test('E3A-R-D1: the declared-name trim class is exactly what String.prototype.trim() removes, over every code point', () => {
  const d = latest('app.declared_name_trim_characters');
  assert.ok(d, 'the class is defined');
  const sqlClass = [...d.def.matchAll(/chr\((\d+)\)/g)].map((m) => Number(m[1]));
  const trimmed = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    /* A lone surrogate is not text in either runtime: PostgreSQL has no UTF-8 form for it and the service refuses it. */
    if (c >= 0xd800 && c <= 0xdfff) continue;
    if (String.fromCodePoint(c).trim() === '') trimmed.push(c);
  }
  assert.deepEqual(sqlClass, trimmed);
  assert.equal(trimmed.length, 25);
  /* The class is the one the service applies, and the routine judges and stores the name through it. */
  const service = readFileSync(join(REPO, 'lib/services/candidates.mjs'), 'utf8');
  assert.match(service, /const name = entry\.displayName\.trim\(\);/, 'the service trims with String.prototype.trim()');
  assert.match(latest('app.declared_name').def, /select btrim\(p_name, app\.declared_name_trim_characters\(\)\)/);
  assert.match(latest('app.submission_fields').def, /char_length\(app\.declared_name\(e->>'display_name'\)\) between 1 and 120/);
  const submit = latest('api.submit_candidate');
  assert.equal(submit.name, '004_content_rules_and_profiles.sql');
  assert.match(submit.def, /select cand\.id, 'declared_offline', app\.declared_name\(e->>'display_name'\), false/);
});

/* E3A-D2. The per-element test is a CASE whose first branch is the object test, so jsonb_object_keys(e) is reached only
   by an object; a type test on the whole submission or on a list is its own IF statement before the functions that
   raise on the wrong type. PostgreSQL's executor happens to run one OR's operands left to right, so no stack probe
   tells 003's OR chain from this; the text is where that difference can be checked (tests/db/19, mutant A3). */
const ELEMENT_CASE =
  /where case\s*\n(?:\s*--[^\n]*\n)*\s*when jsonb_typeof\(e\) <> 'object' then true\s*\n\s*when \(select count\(\*\) from jsonb_object_keys\(e\)\) <> 1 then true\s*\n/;

test('E3A-D2: in the latest app.submission_fields no test that raises on the wrong JSON type runs before the test that makes it safe', () => {
  const def = latest('app.submission_fields').def;
  assert.match(def, ELEMENT_CASE);
  assert.equal(def.split('jsonb_object_keys(e)').length - 1, 1, 'jsonb_object_keys(e) only inside the CASE');
  const objectTest = def.indexOf("if jsonb_typeof(s) is distinct from 'object' then");
  assert.ok(objectTest > 0 && objectTest < def.indexOf('jsonb_object_keys(s)'), 'the object test is its own statement first');
  for (const key of ['dependencies', 'declared_contributors']) {
    const arrayTest = def.indexOf(`if jsonb_typeof(s->'${key}') is distinct from 'array' then`);
    const raiseEnd = def.indexOf('end if;', arrayTest);
    assert.ok(arrayTest > 0, `${key}: its own array test`);
    for (const use of [`jsonb_array_length(s->'${key}')`, `jsonb_array_elements(s->'${key}')`]) {
      assert.ok(def.indexOf(use) > raiseEnd, `${use} only after the statement that refuses a non-array`);
    }
  }
});

test('E3A-D2 control: 003 wrote the element test as one OR chain, which the CASE check refuses', () => {
  const old = definitionOf(CONTENT, 'app.submission_fields');
  assert.doesNotMatch(old, ELEMENT_CASE);
  assert.match(old, /where jsonb_typeof\(e\) <> 'object'\s*\n\s*or \(select count\(\*\) from jsonb_object_keys\(e\)\) <> 1/);
});

/* E3A-D1. 004's trigger refuses an owner's UPDATE, DELETE and TRUNCATE on the gate registry unless the migration sets the
   bypass, and scripts/gate-manifest.mjs --sql deactivates the old identity with an UPDATE. A registration migration
   that pasted it bare would learn about the trigger at deploy; this makes it learn at the check gate (the lead,
   2026-09-14). A comment naming such a statement would trip it too; that is the cheap side to err on. */
/* Since 006 part A the same trigger freezes app.release_targets, app.installer_texts and app.release_policies (E4 design
   1.8), so a later migration that enables a target or registers a policy is held to the same bypass rule. */
const REGISTRY_WRITE =
  /\b(?:update|delete\s+from|truncate(?:\s+table)?)\s+(?:only\s+)?app\.(?:gate_identit(?:ies|y_files)|release_targets|installer_texts|release_policies)\b/i;
const BYPASS = "set local app.registry_migration = 'on';";
function registryWritesWithoutBypass(migrations) {
  return migrations
    .filter((m) => Number(m.name.slice(0, 3)) > 4)
    .filter((m) => {
      const write = m.text.search(REGISTRY_WRITE);
      const bypass = m.text.indexOf(BYPASS);
      return write >= 0 && (bypass < 0 || bypass > write);
    })
    .map((m) => m.name);
}

test('E3A-D1: every migration after 004 that updates, deletes or truncates the gate registry sets the bypass before it', async () => {
  assert.deepEqual(registryWritesWithoutBypass(MIGRATIONS), []);
  const bare = registrationSql(await manifest(REPO));
  assert.match(bare, REGISTRY_WRITE, 'control: the generator deactivates the old identity with an UPDATE');
  assert.deepEqual(registryWritesWithoutBypass([{ name: '005_register.sql', text: bare }]), ['005_register.sql'], 'pasted bare');
  assert.deepEqual(registryWritesWithoutBypass([{ name: '005_register.sql', text: `${BYPASS}\n${bare}` }]), [], 'after the bypass');
  assert.deepEqual(
    registryWritesWithoutBypass([{ name: '005_register.sql', text: `${bare}\n${BYPASS}` }]),
    ['005_register.sql'],
    'the bypass set after the write',
  );
  assert.deepEqual(registryWritesWithoutBypass([{ name: '003_content.sql', text: bare }]), [], '003 ran before the trigger');
});

test('E4 1.8: a later migration that writes one of the three registers 006 freezes sets the bypass before it', () => {
  const enable = "update app.release_targets set publishable = true where target = 'generic';";
  assert.deepEqual(registryWritesWithoutBypass([{ name: '007_enable.sql', text: enable }]), ['007_enable.sql']);
  assert.deepEqual(registryWritesWithoutBypass([{ name: '007_enable.sql', text: `${BYPASS}\n${enable}` }]), []);
  for (const statement of ['delete from app.installer_texts;', 'truncate app.release_policies;'])
    assert.deepEqual(registryWritesWithoutBypass([{ name: '007_x.sql', text: statement }]), ['007_x.sql'], statement);
  for (const table of ['release_targets', 'installer_texts', 'release_policies']) {
    assert.match(PART_A, new RegExp(`create trigger ${table}_1_frozen before update or delete on app\\.${table}\\n`));
    assert.match(PART_A, new RegExp(`create trigger ${table}_no_truncate before truncate on app\\.${table}\\n`));
  }
});

/* Migration 004 Part B. The profile display-name rule is its own (pages design 2.1): api.set_display_name trims U+0020
   alone, not Part A's declared-name class, and refuses the controls from U+0001 and exactly Unicode's Bidi_Control set,
   which Node's regular expressions name. The Node copy, normalizeDisplayName, is pages construction's and meets this
   rule in the shared corpus (U13, S13d); this holds the database copy against Unicode itself. */
test('pages 2.1: api.set_display_name trims U+0020 only and refuses exactly the controls from U+0001 and the Bidi_Control set', () => {
  const d = latest('api.set_display_name');
  assert.ok(d, 'the function is defined');
  assert.equal(d.name, '004_content_rules_and_profiles.sql');
  assert.match(d.def, /v text := btrim\(p_display_name, ' '\);/);
  assert.doesNotMatch(d.def, /declared_name/, 'not the declared-name class');
  const refused = new Set();
  for (const m of d.def.matchAll(/ascii\(ch\) in \(([0-9, ]+)\)/g)) for (const n of m[1].split(',')) refused.add(Number(n));
  for (const m of d.def.matchAll(/ascii\(ch\) between (\d+) and (\d+)/g))
    for (let c = Number(m[1]); c <= Number(m[2]); c++) refused.add(c);
  const unicode = [];
  for (let c = 1; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const s = String.fromCodePoint(c);
    if (/\p{Cc}/u.test(s) || /\p{Bidi_Control}/u.test(s)) unicode.push(c);
  }
  assert.deepEqual(
    [...refused].sort((a, b) => a - b),
    unicode,
  );
  assert.equal(unicode.length, 31 + 33 + 12);
});

/* Pages design 2.8. The hook refuses with the error shape and never with a reject decision, which would sign the
   account out of every session; it takes the row before it decides; and it reads the budget before valid (mutant B2 in
   tests/db/20 is the behaviour; this is the text). */
test('pages 2.8: the MFA hook locks its row first, reads the budget before valid, and answers continue or 429, never reject', () => {
  const d = latest('app.hook_mfa_verification_attempt');
  assert.ok(d, 'the hook is defined');
  assert.doesNotMatch(d.def, /reject/i);
  assert.match(d.def, /'decision', 'continue'/);
  assert.match(d.def, /'http_code', 429/);
  const lock = d.def.indexOf('insert into app.mfa_attempt_windows');
  const budget = d.def.indexOf('if failed >= budget then');
  assert.ok(lock > 0 && !d.def.slice(0, lock).includes('app.mfa_attempt_windows'), 'the locking insert touches the table first');
  assert.match(d.def.slice(lock, budget), /on conflict \(user_id\) do update set updated_at = now\(\)/);
  assert.ok(budget > lock && budget < d.def.indexOf("(event->'valid')"), 'the budget is decided before valid is read');
});

/* Migration 005 (pages design 2.3, Q2, lent to pages construction by the lead). The policy a database runs is the last
   one a migration creates: company_admin and aal2, the aal read through auth.jwt(), which authenticated may execute,
   and never through app.jwt_claims(), which it may not (001 lines 353 to 355). */
test('pages 2.3 Q2: the latest invitations_admin_read admits company_admin at aal2 through auth.jwt(), never app.jwt_claims()', () => {
  const created = MIGRATIONS.flatMap((m) =>
    [
      ...m.text.matchAll(
        /create policy invitations_admin_read on app\.invitations for select to authenticated\s+using \(([\s\S]*?)\);/g,
      ),
    ].map((x) => ({ name: m.name, using: x[1].replace(/\s+/g, ' ') })),
  );
  assert.deepEqual(
    created.map((c) => c.name),
    ['001_identity.sql', '005_invitations_aal2.sql'],
  );
  const last = created.at(-1);
  assert.equal(last.using, "app.has_role(company_id, 'company_admin') and (select auth.jwt()->>'aal') = 'aal2'");
  assert.doesNotMatch(last.using, /jwt_claims/);
  const text = MIGRATIONS.find((m) => m.name === '005_invitations_aal2.sql').text;
  assert.ok(
    text.indexOf('drop policy invitations_admin_read on app.invitations;') < text.indexOf('create policy'),
    'the old policy is dropped before the new one is created',
  );
});

/* Migration 006 part A (E4 design 2.3 part A). */
test('E4 1.8: 006 registers exactly the generator s four installer texts, under the committed gate identity', async () => {
  const m = await installerManifest(REPO);
  assert.ok(PART_A.includes(installerRegistrationSql(m)), 'the block is scripts/installer-texts.mjs --sql for this tree');
  const { GATE_IDENTITY_SHA256 } = await import('../../../lib/passport/gate-manifest.mjs');
  const committed = await import('../../../lib/passport/installer-manifest.mjs');
  assert.equal(m.gateIdentitySha256, GATE_IDENTITY_SHA256);
  assert.equal(committed.GATE_IDENTITY_SHA256, GATE_IDENTITY_SHA256);
  assert.deepEqual(
    committed.INSTALLER_TEXTS.map((r) => r.textSha256),
    m.texts.map((t) => t.textSha256),
  );
  /* The registration runs after the audit allowlist that admits its keys, and after the targets it references. */
  const registration = PART_A.indexOf('insert into app.installer_texts');
  assert.ok(PART_A.indexOf('create or replace function app.audit_details_guard()') < registration);
  assert.ok(PART_A.indexOf('insert into app.release_targets') < registration);
});

/* The constraint a database runs is the one the last migration that re-adds it wrote: 006 part A widened it to E4's
   four, 007 to E5's two, and a later slice widens it again. Reading 006 alone would pass while the live constraint
   refused a bound function, which is why the selection follows the file order rather than naming a file. */
const CLAIM_CONSTRAINT = /add constraint idempotency_keys_fn_check check \(fn in \(([^)]*)\)\);/;
function latestClaimConstraint() {
  return MIGRATIONS.map((m) => ({ name: m.name, m: CLAIM_CONSTRAINT.exec(m.text), text: m.text }))
    .filter((x) => x.m)
    .at(-1);
}

test('E4 1.9 A7 and E5 2.3 B8: the latest migration that widens the claim table admits exactly the functions lib/db/server.mjs binds', () => {
  const widened = latestClaimConstraint();
  assert.ok(widened, 'the constraint is re-added');
  assert.equal(widened.name, '007_installations.sql');
  assert.deepEqual([...widened.m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort(), Object.keys(BOUND).sort());
  for (const { name, text } of MIGRATIONS.filter((m) => CLAIM_CONSTRAINT.test(m.text))) {
    assert.ok(
      text.indexOf('drop constraint idempotency_keys_fn_check') < CLAIM_CONSTRAINT.exec(text).index,
      `${name}: the old constraint is dropped first`,
    );
  }
  assert.match(CONTENT, /fn +text not null check \(fn in \('create_draft', 'save_draft', 'submit_candidate', 'create_successor'\)\)/);
});

/* The refused code points a name rule written in 004's form names: ascii(ch) in (...) and ascii(ch) between a and b. */
function refusedCodePoints(def) {
  const refused = new Set();
  for (const m of def.matchAll(/ascii\(ch\) in \(([0-9, ]+)\)/g)) for (const n of m[1].split(',')) refused.add(Number(n));
  for (const m of def.matchAll(/ascii\(ch\) between (\d+) and (\d+)/g))
    for (let c = Number(m[1]); c <= Number(m[2]); c++) refused.add(c);
  return [...refused].sort((a, b) => a - b);
}

test('E4 1.7: api.create_group trims U+0020 only, bounds 1 to 80 code points, and refuses exactly the controls from U+0001 and Bidi_Control', () => {
  const d = latest('api.create_group');
  assert.ok(d, 'the routine is defined');
  /* 008 replaces this routine to read its group ceiling through app.quota (E6 design 2.3 B4), carrying every other
     line of 006's body, so the definition a database runs is 008's and every assertion below still holds. The
     selection follows the file order; the name is asserted so that a slice which replaces it again has to say so. */
  assert.equal(d.name, '008_lifecycle.sql');
  assert.match(d.def, /app\.quota\(p_company, 'groups_per_company'\)/);
  assert.match(d.def, /v text := btrim\(p_name, ' '\);/);
  assert.match(d.def, /char_length\(v\) not between 1 and 80/);
  assert.doesNotMatch(d.def, /declared_name/, 'not the declared-name class');
  const unicode = [];
  for (let c = 1; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const s = String.fromCodePoint(c);
    if (/\p{Cc}/u.test(s) || /\p{Bidi_Control}/u.test(s)) unicode.push(c);
  }
  assert.deepEqual(refusedCodePoints(d.def), unicode);
  assert.deepEqual(refusedCodePoints(latest('api.set_display_name').def), unicode, 'the display-name rule s set, on purpose');
  /* The name is judged before standing, as design 3.5 orders the group routes. */
  assert.ok(d.def.indexOf("raise exception 'E_BODY_INVALID'") < d.def.indexOf('app.require_standing'));
  assert.ok(d.def.indexOf("'E_GROUP_NAME_TAKEN'") < d.def.indexOf("'E_GROUP_LIMIT'"));
});

/* Migration 007 (E5 design 2.3 B1). The fourteen-day rule and the three ceilings live in two places by necessity, a SQL
   function the routines call and a Node constant the services and the pages compute with; this holds the two copies to
   each other, so the second interval of design 7 scenario 3 cannot be changed on one side only. */
test('E5 1.4c and 2.3 B1: the limits and the check-in interval in 007 are the values lib/rules/installations.mjs holds', async () => {
  const rules = await import('../../../lib/rules/installations.mjs');
  const body = (name) => new RegExp(`function app\\.${name}\\(\\)[^;]*?\\$\\$\\s*select ([^$]+?)\\s*\\$\\$`, 's').exec(E5)?.[1];
  assert.equal(body('limit_downloads_per_recipient'), String(rules.LIMIT_DOWNLOADS_PER_RECIPIENT));
  assert.equal(body('limit_reports_per_recipient'), String(rules.LIMIT_REPORTS_PER_RECIPIENT));
  assert.equal(body('limit_witnesses_per_report'), String(rules.LIMIT_WITNESSES_PER_REPORT));
  assert.equal(body('check_in_interval'), `interval '${rules.CHECK_IN_INTERVAL_DAYS} days'`);
  /* The two vocabularies, in the order both copies list them. */
  const array = (name) => {
    const m = new RegExp(`function app\\.${name}\\(\\)[\\s\\S]*?select array\\[([^\\]]+)\\]`, '').exec(E5)?.[1];
    return m ? [...m.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : null;
  };
  assert.deepEqual(array('installation_statuses'), [...rules.INSTALLATION_STATUSES]);
  assert.deepEqual(array('installation_sources'), [...rules.INSTALLATION_SOURCES]);
  /* The witness roles are a CHECK on the column rather than a vocabulary function, because they are E2's role names
     and app.role_names() already owns them; the Node copy is held to that CHECK's text. */
  const roles = /witness_role +text not null check \(witness_role in \(([^)]*)\)\)/.exec(E5)?.[1];
  assert.ok(roles, 'the witness role CHECK is in 007');
  assert.deepEqual([...roles.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort(), [...rules.WITNESS_ROLES].sort());
});

test('E4 1.7 A5: the latest api.remove_member keeps every line of 003 s in order, and clears group rows between the membership and agent locks', () => {
  const d = latest('api.remove_member');
  /* 011 (END-1) copies 006's body forward and adds the issued-invitation revocation after the agent rows; every line
     of 003's is still there, in order, which is what this case holds. */
  assert.equal(d.name, '011_invitation_standing.sql');
  const lines = d.def.split('\n');
  let at = 0;
  for (const line of definitionOf(CONTENT, 'api.remove_member').split('\n')) {
    if (line.trim() === '') continue;
    at = lines.indexOf(line, at) + 1;
    assert.ok(at > 0, `003's line is kept, in order: ${line.trim()}`);
  }
  const membershipLock = d.def.indexOf('from app.memberships where id = p_membership for update');
  const groupLock = d.def.indexOf('perform 1 from app.group_members gm');
  const groupDelete = d.def.indexOf('delete from app.group_members gm');
  const agentLock = d.def.indexOf('perform 1 from app.agents g');
  assert.ok(membershipLock > 0 && membershipLock < groupLock, 'group rows after the membership row (2.5 levels 2, 3)');
  assert.ok(groupLock < groupDelete && groupDelete < agentLock, 'group rows before agent rows (2.5 levels 3, 4)');
  assert.match(d.def.slice(groupDelete, agentLock), /'group.remove_member'[\s\S]*'reason_code', 'membership_removed'/);
  /* END-1 (011, D4): the invitations the removed member issued are revoked last, after the agent rows (2.5's order). */
  const revoke = d.def.indexOf("perform app.revoke_issued_invitations(target.company_id, target.id, actor, admin.id, 'issuer_removed')");
  assert.ok(revoke > d.def.indexOf("'agent.orphan'"), 'the revocation follows the agent orphaning');
});
