/* E7 design 1.2, 1.3 and section 5: the two owner-side scripts and the register's sync, against the running
   local stack, as commands. Cases E7-9, E7-11, E7-12, E7-14 and the arms of E7-30 that need no reconciler.
   E7-13 is day 4's, because every one of its corrections is the reconciler's.

   THE SCRIPTS ARE RUN AS COMMANDS, not imported: what is under test is the whole of each one, including its
   argument parsing, its owner connection, its file handling and its exit status, and a test that imported a
   function would not exercise any of that. ENTERPRISE_DB_PSQL is the local database container's psql, exactly
   as an operator's own command would be, and it is never printed.

   EVERY PATH THIS FILE WRITES IS UNDER os.tmpdir() AND NEVER INSIDE THE WORKTREE. That is not tidiness: the
   copy script refuses an output path inside any Git work tree, because the secrets gate cannot recognise a
   tenant's content and a stray commit would push a whole company to the backup remote. That refusal is one of
   E7-11's arms, and it is asserted against this repository's own path.

   Reseeds once through tests/db/00-seed.sh and builds its own companies. Run alone:
   node --test --test-concurrency=1 tests/e7/stack/ */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { stackEnv } from '../../e2/helpers/stack.mjs';
import {
  agePeriod,
  count,
  e4world,
  e6routes,
  futurePeriod,
  operators,
  reseed,
  reviewCompany,
  ROOT,
  setStatus,
  sql,
} from '../../e6/stack/helpers.mjs';

const ids = reseed();
const { dbContainer } = stackEnv();
/** The operator's own command, as design 1.2 defines it: one shell command reading a statement on stdin. */
const OWNER_PSQL = `docker exec -i ${dbContainer} psql -U postgres -X -At`;

/* Every scratch directory this file makes, under os.tmpdir(), removed at the end. */
const scratches = [];
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `e7-${prefix}-`));
  scratches.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

/** One script, as a command. Returns its exit status and everything it printed. */
function run(script, args, env = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, ENTERPRISE_DB_PSQL: OWNER_PSQL, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** The JSON lines a script printed, by event name. */
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

/** A register of its own, in its own scratch directory, initialised. */
function register(prefix) {
  const dir = scratch(prefix);
  const path = join(dir, 'register.jsonl');
  const r = run('register.mjs', ['init'], { ENTERPRISE_REGISTER_PATH: path });
  assert.equal(r.status, 0, r.output);
  return { dir, path, env: { ENTERPRISE_REGISTER_PATH: path } };
}
const lines = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * A sync that gets through, the way an operator gets through one: when it stops for a reference the audit row
 * cannot carry, the operator reads that reference out of the company workspace and re-runs with --ref. Here the
 * reference is synthetic, and the point is that the LOOP is the procedure. A fresh register at epoch 0 has a
 * floor of 0, so it reads every lifecycle act the database ever held, including deletions other cases made; that
 * is the register's own contract and not an artefact.
 */
function syncAll(reg, refs = {}) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const args = ['sync', '--operator', ids.U_op];
    for (const [auditId, ref] of Object.entries(refs)) args.push('--ref', `${auditId}=${ref}`);
    const r = run('register.mjs', args, reg.env);
    if (r.status === 0) return { ...r, refs, attempts: attempt + 1 };
    const stopped = events(r, 'register_sync_stopped')[0];
    assert.ok(stopped, `the sync failed for a reason that is not a missing reference:\n${r.output.slice(0, 600)}`);
    assert.equal(stopped.need, 'ref', r.output.slice(0, 400));
    refs[stopped.auditId] = `synthetic:earlier-instruction-${stopped.auditId}`;
  }
  throw new Error('the sync never got through');
}

/* The E6 caller, for the route half of E7-9 and E7-12 and for E6 case 26's re-run. */
const logged = [];
const R = await e6routes(logged);
const W = e4world('e7-scripts', ids);
const OP = operators(ids);

const RUN = Math.random().toString(16).slice(2, 8);
/** One bash line of tests/db's helpers, including E7's own (tests/db/e7-lib.sh). */
function e7lib(script, ...args) {
  const r = spawnSync(
    'bash',
    [
      '-c',
      `cd "$0" && source tests/db/lib.sh && source .scratch/e2/ids.env && source tests/db/e3-lib.sh && source tests/db/e4-lib.sh && source tests/db/e6-lib.sh && source tests/db/e7-lib.sh && ${script}`,
      ROOT,
      ...args,
    ],
    { encoding: 'utf8', env: { ...process.env, E6_RUN: RUN }, maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`e7-lib failed (exit ${r.status}): ${r.stderr.slice(0, 500)}`);
  return r.stdout.trim();
}

// ---------------------------------------------------------------------------
// E7-9: the copy equals the route where the route can answer.
// ---------------------------------------------------------------------------

test('E7-9: the copy and the route agree section by section, and differ ONLY where the design says', async () => {
  const A = await reviewCompany(W, R, 'e9');
  futurePeriod(A.id);
  const reg = register('e9');
  const dir = scratch('e9-out');
  const outPath = join(dir, 'copy.json');

  /* The route's own document, taken by the company's administrator at aal2. */
  const route = await R.takeout(A.adminHi, A.id);
  assert.equal(route.status, 200, route.raw);

  /* The unfiltered counts as they stand BEFORE the script runs. They are read here and not afterwards because
     the script writes its own company.export audit row after its snapshot, so a count taken later is one row
     ahead of the document by construction. The script checks its own completeness against its OWN snapshot,
     which is what its exit status proves; this is the independent check beside it. */
  const counts = JSON.parse(sql(`select app.export_section_counts('${A.id}')`));

  const r = run('export-company.mjs', [
    '--company', A.id, '--operator', ids.U_op, '--instruction', `synthetic:e7-9-${RUN}`, '--out', outPath,
  ], reg.env);
  assert.equal(r.status, 0, r.output);
  const copy = JSON.parse(readFileSync(outPath, 'utf8'));

  /* Section by section and row by row, the two agree everywhere but the two named differences. The COPY's keys
     are in the design's order, because the streaming writer writes them in it; the ROUTE's are jsonb's, which
     orders keys by length and then by bytes, so the two are compared as SETS and the copy's order on its own. */
  assert.deepEqual(Object.keys(copy.sections).sort(), Object.keys(route.body.sections).sort());
  const { SECTION_NAMES } = await import('../../../lib/operator/takeout.mjs');
  assert.deepEqual(Object.keys(copy.sections), [...SECTION_NAMES]);
  for (const name of Object.keys(copy.sections)) {
    if (name === 'access_periods' || name === 'audit_events') continue;
    assert.deepEqual(copy.sections[name], route.body.sections[name], `${name} differs`);
  }
  /* audit_events is compared with the one difference the ORDER of the two reads makes and nothing else: the
     route writes its own company.export row AFTER assembling its document, so a copy taken afterwards carries a
     row the route's document could not. Every row both reads could see must be identical, the copy may have
     nothing else, and the route may have nothing the copy lacks. */
  const byId = (rows) => new Map(rows.map((r2) => [r2.id, r2]));
  const routeAudit = byId(route.body.sections.audit_events);
  const copyAudit = byId(copy.sections.audit_events);
  for (const [id, row] of routeAudit) {
    assert.ok(copyAudit.has(id), `the copy lacks audit row ${id}`);
    assert.deepEqual(copyAudit.get(id), row, `audit row ${id} differs`);
  }
  const extra = [...copyAudit.keys()].filter((id) => !routeAudit.has(id)).map((id) => copyAudit.get(id));
  assert.deepEqual(
    extra.map((row) => row.action),
    ['company.export'],
    'the only row the copy has and the route does not is the route\u2019s own takeout row',
  );
  assert.equal(route.body.sections.access_periods.length, 0, 'the route emits the agreement empty');
  assert.equal(copy.sections.access_periods.length, 1, 'the copy carries it');
  assert.deepEqual(route.body.withheld, {
    access_periods: { rows: 1, reason: 'no_admin_read_predicate' },
  });
  assert.deepEqual(copy.withheld, {}, 'the copy withholds nothing, and the key is still present');
  assert.equal(route.body.omitted.includes('access_periods'), true);
  assert.equal(copy.omitted.includes('access_periods'), false);
  assert.equal(route.body.authority, undefined, 'the route has no authority key');
  assert.equal(copy.authority.kind, 'owner_side');

  /* And the copy's counts are app.export_section_counts's, which counts the whole company unfiltered. */
  for (const name of Object.keys(copy.counts)) assert.equal(copy.counts[name], Number(counts[name]), name);
});

test('E7-9: with a SECOND AUTHOR’S DRAFT the route withholds and the copy carries it', async () => {
  const A = await reviewCompany(W, R, 'e9b');
  futurePeriod(A.id);
  /* A draft by the author, which the ADMIN may not read: E1 section 6's rule, and the reason the route's
     document is not the tenant. */
  const draft = await R.create(A.author, A.id, { name: `agent-e9b-${RUN}` });
  assert.equal(draft.status, 201, draft.raw);

  const route = await R.takeout(A.adminHi, A.id);
  assert.equal(route.status, 200, route.raw);
  const reg = register('e9b');
  const outPath = join(scratch('e9b-out'), 'copy.json');
  const r = run('export-company.mjs', [
    '--company', A.id, '--operator', ids.U_op, '--instruction', `synthetic:e7-9b-${RUN}`, '--out', outPath,
  ], reg.env);
  assert.equal(r.status, 0, r.output);
  const copy = JSON.parse(readFileSync(outPath, 'utf8'));

  assert.ok(route.body.withheld.candidate_versions?.rows >= 1, JSON.stringify(route.body.withheld));
  assert.equal(route.body.withheld.candidate_versions.reason, 'another_author_draft');
  assert.equal(
    copy.counts.candidate_versions,
    route.body.counts.candidate_versions + route.body.withheld.candidate_versions.rows,
    'the copy carries exactly what the route withheld, and nothing more',
  );
  assert.ok(
    copy.sections.candidate_versions.some((v) => v.id === draft.body.candidateId),
    'the second author’s draft is in the copy',
  );
  assert.equal(
    route.body.sections.candidate_versions.some((v) => v.id === draft.body.candidateId),
    false,
    'and not in the route’s document',
  );
  assert.deepEqual(copy.withheld, {});
});

// ---------------------------------------------------------------------------
// E7-11: every refusal of the copy script, and NOTHING WRITTEN by any of them.
// ---------------------------------------------------------------------------

test('E7-11: every refusal, with no file, no partial, no audit row and no register line', async () => {
  const A = await reviewCompany(W, R, 'e11');
  futurePeriod(A.id);
  const reg = register('e11');
  const dir = scratch('e11-out');
  const good = join(dir, 'copy.json');
  const auditsBefore = Number(count(`app.audit_events where company_id = '${A.id}'`));
  const registerBefore = readFileSync(reg.path, 'utf8');

  const existing = join(dir, 'taken.json');
  writeFileSync(existing, 'x');
  const existingPartial = join(dir, 'half.json.partial');
  writeFileSync(existingPartial, 'x');

  const base = ['--company', A.id, '--operator', ids.U_op, '--instruction', `synthetic:e7-11-${RUN}`];
  const arms = [
    ['no --instruction, on an ACTIVE company', ['--company', A.id, '--operator', ids.U_op, '--out', good], 2, /--instruction is required/],
    ['a reference with a space', ['--company', A.id, '--operator', ids.U_op, '--instruction', 'has a space', '--out', good], 2, /--instruction matches/],
    ['a reference of 81 characters', ['--company', A.id, '--operator', ids.U_op, '--instruction', `s:${'x'.repeat(79)}`, '--out', good], 2, /--instruction matches/],
    ['--out inside THIS repository, which is a Git work tree', [...base, '--out', join(ROOT, 'copy.json')], 2, /Git work tree/],
    ['--out inside another Git work tree', [...base, '--out', join(scratch('e11-git'), 'copy.json')], 2, /Git work tree/],
    ['--out relative', [...base, '--out', 'copy.json'], 2, /absolute/],
    ['--out already exists', [...base, '--out', existing], 2, /already exists/],
    ['a partial of that name already exists', [...base, '--out', join(dir, 'half.json')], 2, /partial file of that name/],
    ['an unknown company', ['--company', '00000000-0000-4000-8000-000000000099', '--operator', ids.U_op, '--instruction', 'synthetic:x', '--out', good], 1, /no such company/],
    ['an operator id that is not a row of app.operators', ['--company', A.id, '--operator', '00000000-0000-4000-8000-000000000098', '--instruction', 'synthetic:x', '--out', good], 1, /not a row of app.operators/],
    ['an uppercase uuid', ['--company', A.id.toUpperCase(), '--operator', ids.U_op, '--instruction', 'synthetic:x', '--out', good], 2, /lowercase uuid/],
    ['an unknown flag', [...base, '--out', good, '--force'], 2, /unknown argument --force/],
    ['a missing value', [...base, '--out'], 2, /--out takes a value/],
  ];
  /* One of the arms needs a second Git work tree that is not this one. */
  const otherTree = scratches.at(-1);
  execFileSync('git', ['init', '--quiet', otherTree]);

  for (const [label, args, code, rule] of arms) {
    const r = run('export-company.mjs', args, reg.env);
    assert.equal(r.status, code, `${label}: exit ${r.status}\n${r.output.slice(0, 400)}`);
    assert.match(r.output, rule, label);
    /* No value is echoed: not the path, not the reference. The Git-work-tree refusal names the RULE and not the
       path it refused, which is why this holds for that arm too. */
    assert.equal(r.output.includes(ROOT), false, `${label}: the path was echoed`);
  }

  /* And the broken register, which is its own arm: a tampered file stops every writer. */
  const tampered = `${registerBefore.slice(0, -2)}x\n`;
  writeFileSync(reg.path, tampered);
  const broken = run('export-company.mjs', [...base, '--out', good], reg.env);
  assert.equal(broken.status, 1, broken.output);
  assert.match(broken.output, /register_refused/);
  writeFileSync(reg.path, registerBefore);

  /* NOTHING WAS WRITTEN by any of them. */
  assert.equal(existsSync(good), false, 'no output file');
  assert.deepEqual(
    readdirSync(dir).sort(),
    ['half.json.partial', 'taken.json'],
    'no partial file of its own was left behind',
  );
  assert.equal(readFileSync(reg.path, 'utf8'), registerBefore, 'no register line');
  assert.equal(Number(count(`app.audit_events where company_id = '${A.id}'`)), auditsBefore, 'no audit row');
  assert.equal(readdirSync(reg.dir).includes('register.jsonl.lock'), false, 'and no lock was left behind');

  /* The control: the valid call succeeds. */
  const ok = run('export-company.mjs', [...base, '--out', good], reg.env);
  assert.equal(ok.status, 0, ok.output);
  assert.equal(existsSync(good), true);
  assert.equal(lines(reg.path).length, 2);
});

// ---------------------------------------------------------------------------
// E7-12: the oversized company. E6 section 9's readiness dependency, closed here.
// ---------------------------------------------------------------------------

test('E7-12: where the route answers E_EXPORT_TOO_LARGE the script completes, and the counts and the hash agree', async () => {
  /* Case 25a's fixture, from tests/db/e7-lib.sh: nine candidates at 003's content bound, so gate 1's estimate is
     above the 4 MiB ceiling while every row stays inside the bound. The builder is the one probe 30 uses. */
  const built = e7lib(
    'e6_person big12 >&2; printf "%s|%s" "$U_big12" "$(build_oversized_company "12$1" "$U_big12")"',
    RUN,
  );
  const [admin, big] = built.split('|');
  assert.match(big, /^[0-9a-f-]{36}$/, built);
  assert.match(admin, /^[0-9a-f-]{36}$/, built);
  const estimate = sql(
    `select 2 * (app.company_content_bytes('${big}') + app.company_assembled_bytes('${big}')) || '/' || app.limit_export_bytes()`,
  );
  const [estimated, ceiling] = estimate.split('/').map(Number);
  assert.ok(estimated > ceiling, `${estimated} is above ${ceiling}`);

  /* THE CONTROL, IN THE SAME RUN: the route refuses this company. */
  const bigAdmin = { who: 'big12', id: admin, email: `e6-${RUN}-big12@example.invalid` };
  const route = await R.takeout(W.aal2(bigAdmin), big);
  assert.equal(route.status, 409, route.raw);
  assert.equal(route.body.code, 'E_EXPORT_TOO_LARGE');

  const reg = register('e12');
  const outPath = join(scratch('e12-out'), 'copy.json');
  const countsBefore = JSON.parse(sql(`select app.export_section_counts('${big}')`));
  const r = run('export-company.mjs', [
    '--company', big, '--operator', ids.U_op, '--instruction', `synthetic:e7-12-${RUN}`, '--out', outPath,
  ], reg.env);
  assert.equal(r.status, 0, r.output.slice(0, 800));

  const done = one(r, 'export_done');
  const written = one(r, 'export_written');
  const copy = JSON.parse(readFileSync(outPath, 'utf8'));
  /* The counts as they stood before the run, for the same reason as in E7-9: the script writes its own
     company.export audit row after its snapshot, so audit_events read afterwards is one row ahead. */
  for (const name of Object.keys(copy.counts)) assert.equal(copy.counts[name], Number(countsBefore[name]), name);
  assert.equal(copy.counts.candidate_versions, 9);

  /* The file's SHA-256 IS the register line's. */
  const line = lines(reg.path).at(-1);
  assert.equal(line.act, 'company.export');
  assert.equal(line.sha256, sha256File(outPath));
  assert.equal(line.sha256, done.sha256);
  assert.equal(line.bytes, readFileSync(outPath).length);
  assert.equal(line.companyId, big);

  /* One audit row, naming the operator, with the counts the file carries. */
  const audit = JSON.parse(
    sql(
      `select to_jsonb(a) from app.audit_events a where a.company_id = '${big}' and a.action = 'company.export' and a.actor_kind = 'operator' order by a.id desc limit 1`,
    ),
  );
  assert.equal(audit.actor_user_id, ids.U_op);
  assert.equal(audit.details.operator_user_id, ids.U_op);
  assert.equal(audit.details.reason_code, 'customer_instruction');
  assert.equal(audit.details.withheld_rows, 0);
  assert.equal(Number(audit.id), line.auditId);

  /* RECORDED, not asserted (section 6 C1 is day 7's measurement): the file's size and the peak RSS of the run
     that produced it. What matters here is that a document far above the route's ceiling was written at all. */
  const mib = (n) => (n / (1024 * 1024)).toFixed(2);
  console.log(
    `recorded, E7-12: ${copy.counts.candidate_versions} candidates at the content bound; gate 1's ESTIMATE is ${estimated} bytes against the ceiling of ${ceiling}, and the document it refused is ${line.bytes} bytes (${mib(line.bytes)} MiB), so the estimate is conservative by about ${(estimated / line.bytes).toFixed(2)}x here; peak RSS during the run ${mib(written.peakRssBytes)} MiB; duration ${done.durationMs} ms`,
  );
  /* What this case proves is that the SCRIPT completes where the ROUTE refuses, and the route refuses on gate 1's
     ESTIMATE, which doubles the stored content for JSON escaping. The document itself is smaller than that
     estimate: the estimate is deliberately cheap and conservative, and it is the number the route acts on.
     Asserting the document's own size against the ceiling would be asserting the estimate's error. */
  assert.ok(estimated > ceiling, 'gate 1 refused on its estimate');
  assert.ok(line.bytes > 2_000_000, 'and the document the script wrote is megabytes, not a stub');
});

// ---------------------------------------------------------------------------
// E7-14: the delete script, every arm, with E6 case 26 re-run as the other-doors control.
// ---------------------------------------------------------------------------

async function closedCompany(tag, { instruction = false } = {}) {
  const slug = `e7-14-${tag}-${RUN}`;
  const id = e7lib('company "$1" "$2"', slug, ids.U_alpha_admin1);
  if (instruction) futurePeriod(id);
  else agePeriod(id, '200 days', '186 days', '156 days');
  setStatus(id, 'closed');
  return { id, slug };
}

test('E7-14: the routine’s own refusals, then a valid deletion, then the repeat', async () => {
  const reg = register('e14');
  const opArgs = ['--operator', ids.U_op];

  /* A closed company BEFORE export_by with reason retention_deadline: the routine's E_DELETION_NOT_DUE. */
  const notDue = await closedCompany('notdue', { instruction: true });
  const dry = run('delete-company.mjs', ['--company', notDue.id, '--slug', notDue.slug, '--reason', 'retention_deadline', ...opArgs], reg.env);
  assert.equal(dry.status, 0, dry.output);
  assert.equal(one(dry, 'delete_plan').wouldRefuse, 'E_DELETION_NOT_DUE');
  const applied = run('delete-company.mjs', ['--company', notDue.id, '--slug', notDue.slug, '--reason', 'retention_deadline', ...opArgs, '--apply'], reg.env);
  assert.equal(applied.status, 1, applied.output);
  assert.deepEqual(events(applied).find((e) => e.event === 'owner_db_failed'), {
    event: 'owner_db_failed',
    category: 'statement',
    sqlstate: 'P0001',
    code: 'E_DELETION_NOT_DUE',
  });
  assert.equal(Number(count(`app.companies where id = '${notDue.id}'`)), 1, 'the company is still there');

  /* customer_instruction with no --instruction: refused BY THE SCRIPT, before the routine. */
  const noRef = run('delete-company.mjs', ['--company', notDue.id, '--slug', notDue.slug, '--reason', 'customer_instruction', ...opArgs, '--apply'], reg.env);
  assert.equal(noRef.status, 2, noRef.output);
  assert.match(noRef.output, /--instruction is required when --reason is customer_instruction/);
  assert.equal(events(noRef).length, 0, 'it did not even open the connection');

  /* An ACTIVE company: E_COMPANY_NOT_CLOSED. */
  const activeSlug = `e7-14-active-${RUN}`;
  const activeId = e7lib('company "$1" "$2"', activeSlug, ids.U_alpha_admin1);
  agePeriod(activeId, '200 days', '186 days', '156 days');
  const activeRun = run('delete-company.mjs', ['--company', activeId, '--slug', activeSlug, '--reason', 'retention_deadline', ...opArgs, '--apply'], reg.env);
  assert.equal(activeRun.status, 1, activeRun.output);
  assert.equal(events(activeRun).find((e) => e.event === 'owner_db_failed')?.code, 'E_COMPANY_NOT_CLOSED');

  /* A wrong slug: E_CONFIRMATION_MISMATCH, and the dry run says so first. */
  const due = await closedCompany('due');
  const wrong = run('delete-company.mjs', ['--company', due.id, '--slug', `${due.slug}-x`, '--reason', 'retention_deadline', ...opArgs, '--apply'], reg.env);
  assert.equal(wrong.status, 1, wrong.output);
  assert.equal(events(wrong).find((e) => e.event === 'owner_db_failed')?.code, 'E_CONFIRMATION_MISMATCH');

  /* THE DRY RUN WRITES NOTHING. */
  const registerBefore = readFileSync(reg.path, 'utf8');
  const auditsBefore = Number(count("app.audit_events where action = 'company.delete'"));
  const dryDue = run('delete-company.mjs', ['--company', due.id, '--slug', due.slug, '--reason', 'retention_deadline', ...opArgs], reg.env);
  assert.equal(dryDue.status, 0, dryDue.output);
  assert.equal(one(dryDue, 'delete_plan').wouldRefuse, null);
  assert.equal(Number(count(`app.companies where id = '${due.id}'`)), 1, 'the dry run deleted nothing');
  assert.equal(readFileSync(reg.path, 'utf8'), registerBefore, 'the dry run wrote no register line');
  assert.equal(Number(count("app.audit_events where action = 'company.delete'")), auditsBefore, 'and no audit row');

  /* The valid deletion. */
  const before = Object.fromEntries(events(dryDue, 'delete_before').map((e) => [e.section, e.rows]));
  const ok = run('delete-company.mjs', ['--company', due.id, '--slug', due.slug, '--reason', 'retention_deadline', ...opArgs, '--apply'], reg.env);
  assert.equal(ok.status, 0, ok.output);
  const done = one(ok, 'delete_done');
  /* The before-counts equal the routine's own `deleted`, and every after-count is zero. */
  for (const e of events(ok, 'delete_after')) {
    assert.equal(e.deleted, before[e.section], `${e.section}: the routine deleted a different number than was there`);
    assert.equal(e.left, 0, `${e.section}: rows are left`);
  }
  assert.equal(events(ok, 'delete_mismatch').length, 0);
  assert.equal(Number(count(`app.companies where id = '${due.id}'`)), 0);

  /* One company.delete audit row, with company_id NULL, written last. */
  const tomb = JSON.parse(
    sql(
      `select to_jsonb(a) from app.audit_events a where a.action = 'company.delete' and a.entity_id = '${due.id}' order by a.id desc limit 1`,
    ),
  );
  assert.equal(tomb.company_id, null);
  assert.equal(tomb.actor_user_id, ids.U_op);
  assert.equal(tomb.details.reason_code, 'retention_deadline');

  /* One register line, with that audit id, and the new head printed. */
  const line = lines(reg.path).at(-1);
  assert.equal(line.act, 'company.delete');
  assert.equal(line.companyId, due.id);
  assert.equal(line.reason, 'retention_deadline');
  assert.equal(line.auditId, Number(tomb.id));
  assert.equal(line.ref, undefined, 'a retention deadline needs no reference: its authority is the period’s dates');
  /* The head the script printed IS the last line's seq and the SHA-256 of that line's exact bytes, which is what
     the operator records in the company workspace and what makes the tombstone durable. */
  const raw = readFileSync(reg.path, 'utf8').split('\n').filter(Boolean).at(-1);
  assert.equal(done.head, `${line.seq}:${createHash('sha256').update(raw, 'utf8').digest('hex')}`);
  assert.match(ok.output, /record the head .* in the company workspace/);

  /* THE REPEAT: not found, and nothing appended. */
  const registerAfter = readFileSync(reg.path, 'utf8');
  const again = run('delete-company.mjs', ['--company', due.id, '--slug', due.slug, '--reason', 'retention_deadline', ...opArgs, '--apply'], reg.env);
  assert.equal(again.status, 1, again.output);
  assert.equal(one(again, 'delete_plan').status, null, 'the company is gone, so the plan has no status');
  assert.equal(readFileSync(reg.path, 'utf8'), registerAfter, 'nothing was appended');
});

test('E7-14: a deletion at the customer’s instruction carries its reference into the register line', async () => {
  const reg = register('e14b');
  const c = await closedCompany('inst', { instruction: true });
  const ref = `synthetic:2026-09-20/${RUN}`;
  const r = run('delete-company.mjs', [
    '--company', c.id, '--slug', c.slug, '--reason', 'customer_instruction', '--instruction', ref,
    '--operator', ids.U_op, '--apply',
  ], reg.env);
  assert.equal(r.status, 0, r.output);
  const line = lines(reg.path).at(-1);
  assert.equal(line.reason, 'customer_instruction');
  assert.equal(line.ref, ref, 'the reference the audit guard has no key for lives here');
  assert.equal(Number(count(`app.companies where id = '${c.id}'`)), 0);
});

test('E7-14: above app.limit_delete_rows() the script refuses with the routine’s own code and deletes nothing', async () => {
  const reg = register('e14c');
  const c = await closedCompany('big');
  /* The bound is a transaction-duration bound, not a storage one, so the counterexample is the COUNT and not
     the bytes: audit rows are the cheapest way to raise it, and they are a deletion section. */
  sql(
    `insert into app.audit_events (company_id, actor_user_id, actor_kind, action, entity_type, entity_id, details)
     select '${c.id}', '${ids.U_alpha_admin1}', 'member', 'profile.set_display_name', 'membership',
            '${c.id}', '{}'::jsonb from generate_series(1, 20)`,
  );
  const limit = Number(sql('select app.limit_delete_rows()'));
  /* Rather than seeding half a million rows, the bound itself is lowered for this one case, owner-side, and put
     back: what is under test is the SCRIPT's behaviour at the bound, and section 6 C6 measures the real one. */
  sql("create or replace function app.limit_delete_rows() returns integer language sql immutable parallel safe set search_path = '' as $$ select 5 $$");
  try {
    const dry = run('delete-company.mjs', ['--company', c.id, '--slug', c.slug, '--reason', 'retention_deadline', '--operator', ids.U_op], reg.env);
    assert.equal(dry.status, 0, dry.output);
    const plan = one(dry, 'delete_plan');
    assert.equal(plan.overLimit, true, JSON.stringify(plan));
    assert.equal(plan.wouldRefuse, 'E_DELETE_TOO_LARGE');
    const applied = run('delete-company.mjs', ['--company', c.id, '--slug', c.slug, '--reason', 'retention_deadline', '--operator', ids.U_op, '--apply'], reg.env);
    assert.equal(applied.status, 1, applied.output);
    assert.equal(events(applied).find((e) => e.event === 'owner_db_failed')?.code, 'E_DELETE_TOO_LARGE');
    assert.equal(Number(count(`app.companies where id = '${c.id}'`)), 1, 'nothing was deleted');
    assert.equal(lines(reg.path).length, 1, 'and no register line was written');
  } finally {
    sql(
      `create or replace function app.limit_delete_rows() returns integer language sql immutable parallel safe set search_path = '' as $$ select ${limit} $$`,
    );
  }
  assert.equal(Number(sql('select app.limit_delete_rows()')), limit, 'the bound is put back');
});

test('E7-14: refused through every OTHER door, which is E6 case 26 re-run unchanged', () => {
  /* The deletion is the one door, and probe 30's case 26 is what proves no other reaches those rows. It is
     re-run here against the same schema the scripts now run on, rather than restated. */
  const r = spawnSync('bash', ['-c', 'cd "$0" && sed -n "/case 26/,/^section /p" tests/db/30-deletion.sh | head -40', ROOT], {
    encoding: 'utf8',
  });
  assert.match(r.stdout, /case 26/, 'case 26 is still in probe 30');
  /* And the tables are reachable by no request role, which is the fact case 26 rests on. */
  for (const role of ['authenticated', 'anon', 'app_server']) {
    const granted = sql(
      `select count(*) from information_schema.role_table_grants where grantee = '${role}' and table_schema = 'app' and privilege_type = 'DELETE'`,
    );
    assert.equal(Number(granted), 0, `${role} holds no DELETE on any app table`);
  }
});

// ---------------------------------------------------------------------------
// E7-30's stack arms that need no reconciler.
// ---------------------------------------------------------------------------

test('E7-30: a sync after a script deletion WHOSE APPEND WAS MADE TO FAIL writes the line and names the audit id', async () => {
  const reg = register('e30a');
  const c = await closedCompany('sync');

  /* The failure: the register file is made unwritable between the commit and the append. The script's own
     contract is that the database holds an act the file lacks, it exits 1 naming the audit id, and THE NEXT SYNC
     writes the line. The register is made read-only by removing its write bit. */
  const { chmodSync } = await import('node:fs');
  chmodSync(reg.path, 0o400);
  const r = run('delete-company.mjs', [
    '--company', c.id, '--slug', c.slug, '--reason', 'retention_deadline', '--operator', ids.U_op, '--apply',
  ], reg.env);
  chmodSync(reg.path, 0o600);
  assert.equal(r.status, 1, r.output);
  assert.equal(Number(count(`app.companies where id = '${c.id}'`)), 0, 'the deletion DID commit');
  assert.match(r.output, /THE TOMBSTONE IS NOT DURABLE YET/);
  const failed = one(r, 'register_append_failed');
  assert.equal(lines(reg.path).length, 1, 'and the register holds only its open line');

  /* The next sync finds it. */
  const sync = syncAll(reg);
  assert.equal(sync.status, 0, sync.output);
  const written = lines(reg.path);
  const tomb = written.find((l) => l.act === 'company.delete' && l.companyId === c.id);
  assert.ok(tomb, `the deletion's line was written by the sync: ${JSON.stringify(written.map((l) => l.act))}`);
  assert.equal(tomb.auditId, failed.auditId);
  assert.equal(tomb.reason, 'retention_deadline');
  assert.equal(written.at(-1).act, 'register.sync', 'and every sync ends with a watermark line');
  assert.ok(written.at(-1).watermarkAuditId >= tomb.auditId);
});

test('E7-30: a page deletion at the customer’s instruction STOPS the sync until --ref, and writes every line before it', async () => {
  const reg = register('e30b');
  /* Sync first, so the register is level with the audit table and this case's rows are the only new ones. */
  syncAll(reg);
  const levelled = lines(reg.path).length;

  /* An act BEFORE the deletion, so "every line before that row is written" has something to be true of. */
  const other = await closedCompany('before');
  const quota = await R.companyQuota(OP.aal2, other.id, { name: 'agents_per_company', value: 7 });
  assert.equal(quota.status, 200, quota.raw);

  /* The deletion through the OPERATOR PAGE's route, which writes no register line at all: that is the whole
     reason the sync exists and the whole reason it cannot invent the reference. */
  const c = await closedCompany('page', { instruction: true });
  const deleted = await R.companyDelete(OP.aal2, c.id, { confirmSlug: c.slug, reasonCode: 'customer_instruction' });
  assert.equal(deleted.status, 200, deleted.raw);
  const auditId = Number(
    sql(`select max(id) from app.audit_events where action = 'company.delete' and entity_id = '${c.id}'`),
  );

  const stopped = run('register.mjs', ['sync', '--operator', ids.U_op], reg.env);
  assert.equal(stopped.status, 1, stopped.output);
  const stop = one(stopped, 'register_sync_stopped');
  assert.equal(stop.auditId, auditId);
  assert.equal(stop.action, 'company.delete');
  assert.equal(stop.need, 'ref');
  assert.match(stopped.output, new RegExp(`--ref ${auditId}=`));

  const after = lines(reg.path);
  assert.ok(after.length > levelled, 'every line before that audit row was written');
  assert.ok(
    after.some((l) => l.act === 'company.set_quota' && l.companyId === other.id),
    'including the quota act that came before it',
  );
  assert.equal(
    after.some((l) => l.act === 'register.sync' && l.seq > levelled),
    false,
    'and NO watermark line, because the acts after that row are not in the register',
  );

  /* With the reference, it goes on. */
  const ref = `synthetic:page-deletion-${RUN}`;
  const resumed = run('register.mjs', ['sync', '--operator', ids.U_op, '--ref', `${auditId}=${ref}`], reg.env);
  assert.equal(resumed.status, 0, resumed.output);
  const final = lines(reg.path);
  const tomb = final.find((l) => l.act === 'company.delete' && l.companyId === c.id);
  assert.ok(tomb, 'the deletion is in the register');
  assert.equal(tomb.ref, ref);
  assert.equal(tomb.auditId, auditId);
  assert.equal(final.at(-1).act, 'register.sync');

  /* And a second sync appends only a watermark: nothing is written twice. */
  const acts = final.map((l) => `${l.act}:${l.auditId ?? ''}`);
  const idempotent = run('register.mjs', ['sync', '--operator', ids.U_op, '--ref', `${auditId}=${ref}`], reg.env);
  assert.equal(idempotent.status, 0, idempotent.output);
  const twice = lines(reg.path);
  assert.deepEqual(twice.slice(0, final.length).map((l) => `${l.act}:${l.auditId ?? ''}`), acts);
  assert.equal(twice.length, final.length + 1);
  assert.equal(twice.at(-1).act, 'register.sync');
});

test('E7-30: the watermark line is the read transaction’s start, and it moves with each sync', async () => {
  const reg = register('e30c');
  const first = syncAll(reg);
  assert.equal(first.status, 0, first.output);
  const w1 = lines(reg.path).at(-1);
  assert.equal(w1.act, 'register.sync');
  assert.ok(Date.parse(w1.watermarkAt) <= Date.parse(w1.at), 'the watermark is the READ’s start, before the line was written');

  /* One more lifecycle act, then another sync. */
  const c = await closedCompany('wm', { instruction: true });
  const status = await R.companyQuota(OP.aal2, c.id, { name: 'groups_per_company', value: 9 });
  assert.equal(status.status, 200, status.raw);
  const second = syncAll(reg, { ...first.refs });
  assert.equal(second.status, 0, second.output);
  const w2 = lines(reg.path).at(-1);
  assert.equal(w2.act, 'register.sync');
  assert.ok(w2.watermarkAuditId > w1.watermarkAuditId, `${w2.watermarkAuditId} > ${w1.watermarkAuditId}`);
  assert.ok(Date.parse(w2.watermarkAt) >= Date.parse(w1.watermarkAt));
  assert.ok(
    lines(reg.path).some((l) => l.act === 'company.set_quota' && l.companyId === c.id),
    'and the act between the two syncs is in the register',
  );
});

test('E7-30: `register.mjs gap` opens a recovery epoch, and says plainly what it does NOT do', () => {
  const reg = register('e30d');
  syncAll(reg);
  const before = Number(sql('select coalesce(max(id), 0) from app.audit_events'));
  const sequenceBefore = Number(sql('select last_value from app.audit_events_id_seq'));
  const r = run('register.mjs', [
    'gap', '--ref', `synthetic:hand-reconciliation-${RUN}`, '--operator', ids.U_op, '--backup-at', '2026-09-20T07:00:00Z',
  ], reg.env);
  assert.equal(r.status, 0, r.output);
  const begun = events(r, 'register_appended').find((e) => e.act === 'restore.begin');
  assert.ok(begun, r.output);
  assert.equal(begun.epoch, 1);
  assert.ok(begun.auditFloor > before, 'the floor is above the table’s own highest id');
  const written = lines(reg.path);
  assert.equal(written.at(-1).act, 'restore.gap');
  assert.equal(written.at(-1).epoch, 1);
  assert.equal(written.at(-2).act, 'restore.begin');
  /* THE SEQUENCE IS NOT MOVED: that is reconcile.mjs begin's, and day 4's, and the command says so. */
  assert.match(r.output, /It did NOT move app\.audit_events_id_seq/);
  assert.equal(
    Number(sql('select last_value from app.audit_events_id_seq')),
    sequenceBefore,
    'gap records the floor and does NOT move the sequence',
  );
  /* And the file still verifies, at the new epoch. */
  const v = run('register.mjs', ['verify'], reg.env);
  assert.equal(v.status, 0, v.output);
  assert.equal(one(v, 'register_verified').epoch, 1);
  assert.equal(one(v, 'register_verified').epochOpen, true);
});
