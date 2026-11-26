/* E7 design 1.2 and section 5 case E7-10: the owner-side copy's section list, columns and orders pinned to
   api.export_company's own text in migration 008, with the two named differences and no others. No stack.

   WHY A TEXT PIN AND NOT A COMPARISON OF TWO ANSWERS. Case E7-9 compares the two documents row by row against
   the running stack, and that is the behavioural check. It can only compare what the fixture happens to hold: a
   section with no rows in the fixture compares equal whatever the script's column list says, and a column that
   is always null compares equal when it is dropped. This pin reads the ROUTINE'S OWN TEXT out of 008 and the
   script's list out of the module and requires them to agree, so a later change to the routine that the module
   does not follow, and a column quietly dropped from the module, both fail here rather than producing a copy
   that is not the tenant.

   THE PARSER BELOW IS THIS FILE'S OWN. It is written against the migration's text from the outside, and it does
   not import anything the module uses to build its own table, so the two are not the same derivation wearing two
   hats. Its own correctness is asserted first: it must find exactly twenty sections in the routine, and the one
   the routine emits as an empty array must NOT be among them.

   The fail-before is a mutant of the MODULE'S table, built here: a column dropped from one section's select, and
   the filter that withholds another author's draft put back. Each is shown failing this pin. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  checkOutputPath,
  completeness,
  gitWorkTreeAt,
  hasher,
  HEAD_MARK,
  makeDocument,
  OMITTED,
  REASON_CODE,
  SECTION_MARK,
  SECTION_NAMES,
  SECTIONS,
  sectionSql,
  snapshotSql,
  TakeoutError,
} from '../../../lib/operator/takeout.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const EIGHT = readFileSync(join(REPO, 'supabase/migrations/008_lifecycle.sql'), 'utf8');

/* The routine's body: from its create or replace to the $$; that closes it. The same shape
   tests/e6/unit/migration-text.test.mjs uses, because that is how a definition is delimited in these files. */
function routineBody(name) {
  const start = EIGHT.lastIndexOf(`create or replace function ${name}(`);
  assert.ok(start >= 0, `${name} is defined in 008`);
  const open = EIGHT.indexOf('$$', start);
  return EIGHT.slice(start, EIGHT.indexOf('$$;', open + 2) + 3);
}

/** Whitespace-normalised to one line, which is how the module holds a select. */
const oneLine = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .join(' ');

/**
 * Every section api.export_company ASSEMBLES, as { name, select }, in the routine's own order. A section the
 * routine emits as a literal (access_periods, which it emits as '[]'::jsonb) is not assembled and is not here.
 */
function routineSections() {
  const body = routineBody('api.export_company');
  const pattern = /'([a-z_]+)', \(select coalesce\(jsonb_agg\(to_jsonb\(x\)\), '\[\]'::jsonb\) from\n/g;
  const found = [];
  for (const m of body.matchAll(pattern)) {
    let i = body.indexOf('(', m.index + m[0].length);
    let depth = 0;
    let j = i;
    for (;;) {
      if (body[j] === '(') depth += 1;
      else if (body[j] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      j += 1;
    }
    found.push({ name: m[1], select: oneLine(body.slice(i + 1, j)) });
  }
  return found;
}

/** The section names the database itself lists, which is what the audit guard checks a count object against. */
function databaseSectionNames() {
  const m = /function app\.export_section_names\(\)[\s\S]*?select array\[([\s\S]*?)\]::text\[\]/.exec(EIGHT);
  assert.ok(m, 'app.export_section_names is defined in 008');
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

/** The one filter the copy drops, written out here rather than imported, so the pin is not circular. */
const VISIBILITY_FILTER = ' and app.export_candidate_visible(v.id, me.id)';

// ---------------------------------------------------------------------------
// The parser's own correctness, first.
// ---------------------------------------------------------------------------

test('E7-10: the parser finds exactly the twenty sections the routine ASSEMBLES, and not the one it emits empty', () => {
  const found = routineSections();
  assert.equal(found.length, 20);
  assert.equal(
    found.some((s) => s.name === 'access_periods'),
    false,
    'the routine emits access_periods as a literal, so it is not assembled',
  );
  assert.match(routineBody('api.export_company'), /'access_periods', '\[\]'::jsonb/);
});

// ---------------------------------------------------------------------------
// E7-10 proper.
// ---------------------------------------------------------------------------

test('E7-10: the copy has the database’s twenty-one section names, in its order', () => {
  assert.deepEqual([...SECTION_NAMES], databaseSectionNames());
  assert.equal(SECTION_NAMES.length, 21);
});

test('E7-10: every section’s columns and order are the routine’s, except the two named differences', () => {
  const routine = new Map(routineSections().map((s) => [s.name, s.select]));
  const differences = [];
  for (const section of SECTIONS) {
    if (section.name === 'access_periods') {
      /* Difference 1: the routine emits this empty, so there is nothing to compare; its columns are asserted on
         their own below, against the table 008 creates. */
      differences.push(section.name);
      continue;
    }
    const theirs = routine.get(section.name);
    assert.ok(theirs !== undefined, `the routine assembles ${section.name}`);
    if (section.select === theirs) continue;
    /* Difference 2: and it may ONLY be the visibility filter, nothing else. */
    assert.equal(
      section.select,
      theirs.replace(VISIBILITY_FILTER, ''),
      `${section.name}: the copy's select differs from the routine's by something other than the visibility filter`,
    );
    differences.push(section.name);
  }
  assert.deepEqual(differences, ['access_periods', 'candidate_versions', 'candidate_contributors']);
});

test('E7-10: the two candidate sections drop the visibility filter and NOTHING else', () => {
  const routine = new Map(routineSections().map((s) => [s.name, s.select]));
  for (const name of ['candidate_versions', 'candidate_contributors']) {
    const theirs = routine.get(name);
    const ours = SECTIONS.find((s) => s.name === name).select;
    assert.ok(theirs.includes(VISIBILITY_FILTER), `the routine still filters ${name}`);
    assert.equal(ours.includes('export_candidate_visible'), false, `the copy does not filter ${name}`);
    assert.equal(ours.includes('me.id'), false, `the copy has no calling membership at all`);
    /* Column for column and order for order, the routine's. */
    assert.equal(ours.slice(0, ours.indexOf(' where ')), theirs.slice(0, theirs.indexOf(' where ')));
    assert.equal(ours.slice(ours.indexOf(' order by ')), theirs.slice(theirs.indexOf(' order by ')));
  }
});

test('E7-10: access_periods carries every column 008 gives the table, and no more', () => {
  const create = /create table app\.access_periods \(([\s\S]*?)\n\);/.exec(EIGHT);
  assert.ok(create, '008 creates app.access_periods');
  const columns = create[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[a-z_]+ +/.test(l) && !/^(primary|unique|check|constraint|foreign)\b/.test(l))
    .map((l) => l.split(/\s+/)[0]);
  const ours = SECTIONS.find((s) => s.name === 'access_periods').select;
  const selected = ours.slice('select '.length, ours.indexOf(' from ')).split(', ');
  assert.deepEqual(selected, columns, 'the agreement and its four dates, whole');
});

test('E7-10: `omitted` is the routine’s list minus access_periods, which this copy carries', () => {
  const m = /'omitted', to_jsonb\(array\[([\s\S]*?)\]::text\[\]\)/.exec(routineBody('api.export_company'));
  assert.ok(m, 'the routine has an omitted list');
  const theirs = [...m[1].matchAll(/'([A-Za-z0-9_.]+)'/g)].map((x) => x[1]);
  assert.deepEqual([...OMITTED], theirs.filter((n) => n !== 'access_periods'));
  assert.equal(theirs.includes('access_periods'), true, 'the route omits it and says so');
});

test('E7-10: the audit action and reason code this copy writes are ones 008’s guard already admits', () => {
  const guard = routineBody('app.audit_details_guard');
  /* section_counts is checked against app.export_section_names() for this action, so the copy's own count object
     passes the guard with no migration; the three other keys are named in the guard's uuid and number lists. */
  assert.match(guard, /when 'section_counts' then/);
  assert.match(guard, /app\.export_section_names\(\)/);
  for (const key of ['company_id', 'operator_user_id']) assert.ok(guard.includes(`'${key}'`), key);
  for (const key of ['withheld_rows', 'serialized_bytes']) assert.ok(guard.includes(`'${key}'`), key);
  assert.match(guard, /when 'reason_code' then/);
  assert.equal(REASON_CODE, 'customer_instruction');
});

// ---------------------------------------------------------------------------
// The fail-before: two mutants of the module's own table, each shown failing the pin above.
// ---------------------------------------------------------------------------

/**
 * The check above, over a table given to it, so a mutant runs through THE SAME RULE and not a looser copy of it.
 * It returns the names that differ from the routine, which the caller compares with the two named differences:
 * a section that differs by something else fails, AND a section that is expected to differ and does not fails
 * too, which is the counterexample of a copy that quietly filters what it must not.
 */
function compare(table) {
  const routine = new Map(routineSections().map((s) => [s.name, s.select]));
  const differs = [];
  for (const section of table) {
    if (section.name === 'access_periods') {
      differs.push(section.name);
      continue;
    }
    const theirs = routine.get(section.name);
    if (theirs === undefined) throw new Error(`the routine does not assemble ${section.name}`);
    if (section.select === theirs) continue;
    if (section.select !== theirs.replace(VISIBILITY_FILTER, ''))
      throw new Error(`${section.name} differs by something other than the visibility filter`);
    differs.push(section.name);
  }
  return differs;
}
const NAMED_DIFFERENCES = ['access_periods', 'candidate_versions', 'candidate_contributors'];

test('E7-10 fail-before: a column dropped from one section is found by the pin', () => {
  assert.deepEqual(compare(SECTIONS), NAMED_DIFFERENCES, 'the real table differs by the two named differences and no more');
  const mutant = SECTIONS.map((s) =>
    s.name === 'installation_witnesses' ? { ...s, select: s.select.replace(', note,', ',') } : s,
  );
  assert.throws(() => compare(mutant), /installation_witnesses differs/);
});

test('E7-10 fail-before: the visibility filter put BACK into the copy is found by the pin', () => {
  /* The counterexample E7-9 is about: a copy that withholds another author's unsubmitted draft is not the
     tenant, and the customer who could not take their own copy gets a file that is quietly short. */
  const mutant = SECTIONS.map((s) =>
    s.name === 'candidate_versions'
      ? { ...s, select: s.select.replace(' order by', `${VISIBILITY_FILTER} order by`) }
      : s,
  );
  /* It does not "differ by something else"; it stops differing at all, which is exactly the failure mode, so the
     pin is the LIST of differences and not a per-section tolerance. */
  assert.notDeepEqual(compare(mutant), NAMED_DIFFERENCES);
  assert.deepEqual(compare(mutant), ['access_periods', 'candidate_contributors']);
});

test('E7-10 fail-before: a section removed from the copy is found by the section-name check', () => {
  const mutant = SECTION_NAMES.filter((n) => n !== 'installation_witnesses');
  assert.notDeepEqual(mutant, databaseSectionNames());
});

// ---------------------------------------------------------------------------
// The snapshot's SQL, the streaming writer and the completeness comparison.
// ---------------------------------------------------------------------------

const C = '11111111-1111-4111-8111-111111111111';
const OP = '22222222-2222-4222-8222-222222222222';

test('design 1.2 step 4: the snapshot is ONE read-only repeatable-read transaction over the twenty-one sections', () => {
  const sql = snapshotSql(C);
  assert.match(sql, /^begin isolation level repeatable read read only;/);
  assert.match(sql, /\ncommit;\n$/);
  assert.equal(/(^|[^A-Za-z0-9_.])c\.id\b/.test(sql), false, 'the routine’s own reference is replaced by the company’s uuid');
  /* And ONLY that reference: candidate_contributors selects cc.id, which ends in the same three characters. A
     plain substring replacement turned it into `c'<uuid>'::uuid` and the whole snapshot failed 42704, "type c
     does not exist", against the local stack on 2026-09-20. */
  assert.ok(sectionSql('candidate_contributors', C).startsWith('select cc.id, cc.candidate_id,'), 'cc.id survives');
  assert.ok(sql.includes('select cc.id, cc.candidate_id,'), 'and it survives in the whole snapshot');
  for (const name of SECTION_NAMES) assert.equal(sectionSql(name, C).includes(`c'${C}'`), false, name);
  for (const name of SECTION_NAMES) assert.ok(sql.includes(`${SECTION_MARK}${name}`), `${name} has its marker`);
  assert.equal(sql.split(SECTION_MARK).length - 1, 21);
  assert.ok(sql.includes(`app.export_section_counts('${C}'::uuid)`), 'the counts are read in the same snapshot');
  /* A marker cannot begin a JSON object, so no row can be read as one and no row can be read as a marker. */
  assert.equal(SECTION_MARK.startsWith('{'), false);
  assert.equal(HEAD_MARK.startsWith('{'), false);
});

test('design 1.2: a company id that is not a uuid never reaches a statement', () => {
  for (const bad of ['1; drop table app.companies', '1111111A-1111-4111-8111-111111111111'.toUpperCase(), '', null])
    assert.throws(() => snapshotSql(bad), TakeoutError);
  assert.throws(() => sectionSql('no_such_section', C), TakeoutError);
});

test('design 1.2 step 5: the writer streams, holds no section, and produces the route’s document shape', () => {
  const chunks = [];
  const doc = makeDocument({
    sink: { write: (t) => chunks.push(t) },
    company: { id: C, slug: 'synthetic-alpha', name: 'SYNTHETIC Alpha AG', status: 'closed', created_at: '2026-01-01T00:00:00Z' },
    exportedAt: '2026-10-01T08:00:00.000Z',
    instructionRef: 'synthetic:2026-10-01/1',
    operatorUserId: OP,
  });
  doc.begin();
  for (const name of SECTION_NAMES) {
    doc.beginSection(name);
    if (name === 'memberships') {
      doc.row('{"id":"a"}');
      doc.row('{"id":"b"}');
    }
    doc.endSection();
  }
  const written = doc.end();
  const text = chunks.join('');
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed), ['exportedAt', 'schemaVersion', 'company', 'sections', 'counts', 'withheld', 'omitted', 'authority']);
  assert.deepEqual(Object.keys(parsed.sections), [...SECTION_NAMES]);
  assert.equal(parsed.counts.memberships, 2);
  assert.deepEqual(parsed.withheld, {}, 'nothing is withheld, and the key is still present');
  assert.deepEqual(parsed.omitted, [...OMITTED]);
  assert.deepEqual(parsed.authority, {
    kind: 'owner_side',
    reasonCode: 'customer_instruction',
    instructionRef: 'synthetic:2026-10-01/1',
    operatorUserId: OP,
  });
  assert.equal(written.rows, 2);
  /* `authority` is the one key the route's document does not have: a reader who finds it knows the file is the
     whole tenant and why. */
  assert.equal(routineBody('api.export_company').includes("'authority'"), false);
});

test('design 1.2 step 5: the writer refuses a row that is not one, a section out of order and a short document', () => {
  const make = () => {
    const doc = makeDocument({
      sink: { write: () => {} },
      company: { id: C },
      exportedAt: '2026-10-01T08:00:00.000Z',
      instructionRef: 'synthetic:1',
      operatorUserId: OP,
    });
    doc.begin();
    return doc;
  };
  let doc = make();
  doc.beginSection('access_periods');
  for (const bad of ['', 'BEGIN', '@section memberships', '{"a":1}extra', 'not json'])
    assert.throws(() => doc.row(bad), TakeoutError, JSON.stringify(bad));

  doc = make();
  assert.throws(() => doc.beginSection('memberships'), /out of order/);

  doc = make();
  doc.beginSection('access_periods');
  doc.endSection();
  assert.throws(() => doc.end(), /short of sections/);

  assert.throws(() => makeDocument({ sink: { write: () => {} }, company: { id: C }, exportedAt: 'x', instructionRef: 'has a space', operatorUserId: OP }), TakeoutError);
  assert.throws(() => makeDocument({ sink: {}, company: { id: C }, exportedAt: 'x', instructionRef: 'a', operatorUserId: OP }), TakeoutError);
});

test('design 1.2 step 6: the completeness comparison is per section and names sections, never rows', () => {
  const counts = Object.fromEntries(SECTION_NAMES.map((n) => [n, 0]));
  assert.equal(completeness(counts, counts).ok, true);
  const short = { ...counts, memberships: 2 };
  const check = completeness(short, { ...counts, memberships: 3 });
  assert.equal(check.ok, false);
  assert.deepEqual(check.problems, [{ section: 'memberships', rule: 'the written count is not the snapshot’s', wrote: 2, expected: 3 }]);
  const missing = { ...counts };
  delete missing.audit_events;
  assert.equal(completeness(missing, counts).ok, false);
  assert.equal(completeness({ ...counts, invented: 1 }, counts).ok, false);
});

// ---------------------------------------------------------------------------
// E7D-C-F8: where an owner-side output file may be written.
// ---------------------------------------------------------------------------

test('E7D-C-F8: an output path inside a Git work tree is refused, and so is a relative one', () => {
  assert.throws(() => checkOutputPath(join(REPO, 'copy.json')), /Git work tree/);
  assert.throws(() => checkOutputPath('relative/copy.json'), /absolute/);
  assert.throws(() => checkOutputPath(join(REPO, 'package.json')), /already exists/);
  assert.throws(() => checkOutputPath('/no/such/directory/anywhere/copy.json'), /directory does not exist/);
  /* This repository IS a Git work tree, and so is every worktree of it; the check walks up from the REAL path. */
  assert.equal(gitWorkTreeAt(REPO), REPO);
  assert.equal(gitWorkTreeAt('/'), null);
});

test('design 1.2: the hasher digests exactly the bytes the sink was given', async () => {
  const { createHash } = await import('node:crypto');
  const h = hasher();
  h.update('{"a":1}');
  h.update('\n');
  assert.equal(h.digest(), createHash('sha256').update('{"a":1}\n', 'utf8').digest('hex'));
});
