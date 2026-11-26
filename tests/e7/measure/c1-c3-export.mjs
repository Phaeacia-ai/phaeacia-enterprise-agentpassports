#!/usr/bin/env node
/* Section 6 C1, C2 and C3: the owner-side copy script's duration, peak RSS and bytes.
 *
 *   node tests/e7/measure/c1-c3-export.mjs --label <label>
 *
 * C1  the script on case 25a's fixture, and on a company seeded at the plan's figures. Peak RSS is SAMPLED from
 *     outside the child every 100 ms, not reported by it: the script prints its RSS at one instant, and a peak is
 *     not an instant. The expectation of "near 250 MB, up to twice with JSON escaping" is RECORDED beside the
 *     measured bytes and asserted nowhere, which is section 6's own rule.
 * C2  the same export with a concurrent writer in ANOTHER company, which must not be blocked: the snapshot is
 *     `repeatable read read only` and takes no lock a writer waits on. What is recorded is the export's duration
 *     under that load and the writer's own committed count and worst single-write latency.
 * C3  the SHA-256 and the completeness check, timed STANDALONE over the same file and the same company. In the
 *     script the hash is computed while the rows stream, so it has no separable slice of the run; what this
 *     records is what the same work costs on its own, which is the honest form of "its share".
 *
 * Nothing here is a gate. Run alone, on a reseeded stack, and reseed after it: it leaves a 250 MB company behind.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { seed as seedStack } from '../../e2/helpers/stack.mjs';
import { events, ownerPsql, ownerTimed, record, ROOT, runSampled, sleep } from './helpers.mjs';

const label = (() => {
  const i = process.argv.indexOf('--label');
  const v = i > 0 ? process.argv[i + 1] : null;
  if (v === null || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(v)) {
    process.stderr.write('usage: node tests/e7/measure/c1-c3-export.mjs --label LABEL\n');
    process.exit(2);
  }
  return v;
})();

const ids = seedStack();
const scratch = mkdtempSync(join(tmpdir(), 'e7-measure-'));
const SEED_COMMANDS = ['bash tests/db/00-seed.sh'];

function fixture(...args) {
  const command = `node tests/e7/measure/seed.mjs ${args.join(' ')}`;
  SEED_COMMANDS.push(command);
  const out = execFileSync(process.execPath, [join(ROOT, 'tests/e7/measure/seed.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

/** A register of this run's own, under os.tmpdir(), initialised. Never inside the work tree. */
function register(name) {
  const path = join(scratch, `${name}.jsonl`);
  execFileSync(process.execPath, [join(ROOT, 'scripts/register.mjs'), 'init'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ENTERPRISE_REGISTER_PATH: path },
  });
  return path;
}

/** One run of the copy script, with the child's RSS sampled from outside. */
async function exportRun(companyId, tag) {
  const out = join(scratch, `${tag}.json`);
  const registerPath = register(tag);
  const args = [
    join(ROOT, 'scripts/export-company.mjs'),
    '--company', companyId,
    '--operator', ids.U_op,
    '--instruction', `rehearsal:e7-measure/${tag}`,
    '--out', out,
  ];
  const r = await runSampled(process.execPath, args, {
    env: { ENTERPRISE_DB_PSQL: ownerPsql(), ENTERPRISE_REGISTER_PATH: registerPath },
  });
  const done = events(r.stdout, 'export_done')[0] ?? null;
  const written = events(r.stdout, 'export_written')[0] ?? null;
  if (r.status !== 0 || done === null) {
    throw new Error(`export-company exited ${r.status}\n${r.stdout.slice(-1200)}\n${r.stderr.slice(-800)}`);
  }
  return { out, r, done, written, fileBytes: statSync(out).size };
}

/* ------------------------------------------------------------------ C1 */
const small = fixture('case-25a', '--label', label);
const smallRun = await exportRun(small.companyId, 'c1-case25a');
record('C1-case-25a', {
  condition:
    "the copy script on case 25a's fixture, the company whose content alone is above the export route's 4 MiB gate",
  numbers: {
    rows: smallRun.done.rows,
    documentBytes: smallRun.done.bytes,
    fileBytes: smallRun.fileBytes,
    durationMs: smallRun.done.durationMs,
    peakRssBytes: smallRun.r.peakRssBytes,
    rssSamples: smallRun.r.samples,
    scriptReportedRssBytes: smallRun.written.peakRssBytes,
  },
  seed: { label, commands: [...SEED_COMMANDS] },
  command: `node scripts/export-company.mjs --company ${small.companyId} --operator <operator> --instruction rehearsal:e7-measure/c1-case25a --out <tmp>`,
  notes: [
    'peakRssBytes is sampled from outside the child every 100 ms; scriptReportedRssBytes is the one instant the script prints.',
    'The route refuses this company E_EXPORT_TOO_LARGE at gate 1; the script has no ceiling, which is why it exists.',
  ],
});

const plan = fixture('plan-figure', '--label', label);
const planRun = await exportRun(plan.companyId, 'c1-plan');
record('C1-plan-figure', {
  condition:
    "the copy script on a company at the plan's figures: 50 agents, ten versions each at 262,144 bytes, 300 releases near 393,216, 25 active and 25 removed memberships, a 10,000-row ledger",
  numbers: {
    rows: planRun.done.rows,
    documentBytes: planRun.done.bytes,
    fileBytes: planRun.fileBytes,
    durationMs: planRun.done.durationMs,
    throughputMiBPerSecond: Number(((planRun.done.bytes / 1048576) / (planRun.done.durationMs / 1000)).toFixed(2)),
    peakRssBytes: planRun.r.peakRssBytes,
    rssSamples: planRun.r.samples,
    storedContentBytes: plan.contentBytes,
    storedAssembledBytes: plan.assembledBytes,
    sectionCounts: plan.sectionCounts,
  },
  seed: { label, commands: [...SEED_COMMANDS] },
  command: `node scripts/export-company.mjs --company ${plan.companyId} --operator <operator> --instruction rehearsal:e7-measure/c1-plan --out <tmp>`,
  notes: [
    'The design expects this document near 250 MB and up to twice that with JSON escaping. That expectation is RECORDED against documentBytes and asserted nowhere.',
    'The design expects peak RSS flat and under 200 MB because the script streams. RECORDED, not asserted.',
    'The fixture is owner-side: the envelope and release identity triggers were disabled for the bulk insert (tests/e7/measure/seed.mjs says why), so these rows are of the right size and number and are not proof of the assembly rules at this size.',
  ],
});

/* ------------------------------------------------------------------ C2 */
/* A writer in ANOTHER company, one small committed write at a time, while the export holds its snapshot. */
const other = fixture('sized', '--rows', '200', '--label', `${label}-w`);
let writes = 0;
let worstMs = 0;
let writing = true;
const writer = (async () => {
  while (writing) {
    const { ms } = ownerTimed(
      `insert into app.audit_events (company_id, actor_user_id, actor_kind, action, entity_type, entity_id, details)
       values ('${other.companyId}', '${other.adminUserId}', 'member', 'membership.set_roles', 'membership',
               '${other.adminMembershipId}', jsonb_build_object('membership_id', '${other.adminMembershipId}',
               'roles_before', '{member}'::text[], 'roles_after', '{it_reviewer,member}'::text[],
               'reason_code', 'measurement_writer'));`,
      { timeoutMs: 60_000 },
    );
    writes += 1;
    worstMs = Math.max(worstMs, ms);
    await sleep(50);
  }
})();
const planRun2 = await exportRun(plan.companyId, 'c2-plan-concurrent');
writing = false;
await writer;
record('C2-snapshot-with-writer', {
  condition:
    'the same export with a concurrent writer committing into another company throughout; the snapshot is repeatable read read only',
  numbers: {
    exportDurationMs: planRun2.done.durationMs,
    exportDurationMsWithoutWriter: planRun.done.durationMs,
    documentBytes: planRun2.done.bytes,
    concurrentWrites: writes,
    worstSingleWriteMs: Number(worstMs.toFixed(1)),
  },
  seed: { label, commands: [...SEED_COMMANDS] },
  command: 'the C1 plan-figure command, with an owner session committing one audit row every 50 ms in another company',
  notes: [
    'No write was blocked: each write is one committed statement and worstSingleWriteMs is its longest.',
    'The number recorded is the SCRIPT’s duration, and the snapshot spans it: the script opens `begin isolation level repeatable read read only` before the first section and commits after the last.',
    'The cost this number is about is vacuum: a long snapshot holds back the whole database, not one company.',
  ],
});

/* ------------------------------------------------------------------ C3 */
const hashStarted = process.hrtime.bigint();
const hash = createHash('sha256');
await new Promise((res, rej) => {
  const s = createReadStream(planRun.out);
  s.on('data', (d) => hash.update(d));
  s.on('end', res);
  s.on('error', rej);
});
const digest = hash.digest('hex');
const hashMs = Number(process.hrtime.bigint() - hashStarted) / 1e6;
const counts = ownerTimed(
  `begin isolation level repeatable read read only;
   select app.export_section_counts('${plan.companyId}')::text;
   commit;`,
);
record('C3-hash-and-completeness', {
  condition:
    "the SHA-256 over the plan-figure document and the completeness check's own snapshot count, each timed standalone",
  numbers: {
    documentBytes: planRun.done.bytes,
    sha256Ms: Number(hashMs.toFixed(1)),
    sha256MatchesScript: digest === planRun.done.sha256,
    completenessCountMs: Number(counts.ms.toFixed(1)),
    exportDurationMs: planRun.done.durationMs,
    shareOfExportPerCent: Number((((hashMs + counts.ms) / planRun.done.durationMs) * 100).toFixed(1)),
  },
  seed: { label, commands: [...SEED_COMMANDS] },
  command: `sha256 over the produced file; select app.export_section_counts('${plan.companyId}') in one repeatable-read transaction`,
  notes: [
    'In the script the hash is computed WHILE the rows stream, so it has no separable slice of the run. shareOfExportPerCent is therefore what the same work costs on its own against the whole run, not a decomposition of it.',
    'sha256MatchesScript is the check that the standalone hash is the same one the script wrote to the register.',
  ],
});

rmSync(scratch, { recursive: true, force: true });
process.stdout.write('c1-c3: done. Reseed before anything else runs: bash tests/db/00-seed.sh\n');
