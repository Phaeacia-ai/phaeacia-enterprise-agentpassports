#!/usr/bin/env node
/* Section 6 C8: the register's verification at 10,000 lines, and the sync's FULL read of an epoch.
 *
 *   node tests/e7/measure/c8-register.mjs --label <label>
 *
 * The register half. A 10,000-line register is built with the module's own `serialize` and hash, so the chain is
 * the real one, and `node scripts/register.mjs verify` is then timed as a command. The design's figure is "verify
 * under one second"; it is RECORDED and asserted nowhere.
 *
 * The sync half. E7D-C-F2 removed the window: the sync reads EVERY lifecycle act of the current epoch at or above
 * its floor, in one repeatable-read snapshot, because an owner transaction can commit an id after later ones for
 * as long as it runs. That read is what this measures, over an app.audit_events of 100,000 rows of which 5,000 are
 * lifecycle acts, with its query plan, because it scans the audit table by action above the floor.
 *
 * Nothing here is a gate. It leaves 100,000 audit rows behind; reseed after it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { seed as seedStack } from '../../e2/helpers/stack.mjs';
import {
  ACT_COPY_TAKEN,
  fileStore,
  init as initRegister,
  serialize,
  sha256,
  SYNCED_ACTIONS,
} from '../../../lib/operator/register.mjs';
import { owner, ownerPsql, record, ROOT, runSampled } from './helpers.mjs';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const label = arg('--label');
if (label === null || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(label)) {
  process.stderr.write('usage: node tests/e7/measure/c8-register.mjs --label LABEL\n');
  process.exit(2);
}
const LINES = Number.parseInt(arg('--lines', '10000'), 10);
const AUDIT_ROWS = Number.parseInt(arg('--audit-rows', '100000'), 10);
const LIFECYCLE_ROWS = Number.parseInt(arg('--lifecycle-rows', '5000'), 10);

const ids = seedStack();
const scratch = mkdtempSync(join(tmpdir(), 'e7-measure-reg-'));
const SEED_COMMANDS = ['bash tests/db/00-seed.sh'];

function fixture(...args) {
  SEED_COMMANDS.push(`node tests/e7/measure/seed.mjs ${args.join(' ')}`);
  const out = execFileSync(process.execPath, [join(ROOT, 'tests/e7/measure/seed.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

/* ------------------------------------------------------- the 10,000-line register */
/* Built with the module's OWN serializer and hash, line by line, rather than through `append`, which verifies the
   whole file before each line and is quadratic. The chain, the shapes and the head are the module's either way,
   and `verify` below is what reads them back. */
const path = join(scratch, 'big.jsonl');
const store = fileStore(path);
initRegister(store);
const buildStarted = process.hrtime.bigint();
{
  const text = store.read();
  const last = text.slice(0, -1).split('\n').at(-1);
  let prev = sha256(last);
  let seq = 1;
  const out = [];
  for (let i = 0; i < LINES - 1; i++) {
    const raw = serialize({
      seq,
      epoch: 0,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + seq * 1000).toISOString(),
      act: 'factor.delete',
      prev,
      userId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      factorId: `00000000-0000-4000-9000-${String(seq).padStart(12, '0')}`,
      actor: ids.U_op,
      ref: `measure:${label}/${seq}`,
    });
    out.push(raw);
    prev = sha256(raw);
    seq += 1;
  }
  store.append(`${out.join('\n')}\n`);
  store.writeHead(`${seq - 1}:${sha256(out.at(-1))}\n`);
}
const buildMs = Number(process.hrtime.bigint() - buildStarted) / 1e6;

const verifyRun = await runSampled(process.execPath, [join(ROOT, 'scripts/register.mjs'), 'verify'], {
  env: { ENTERPRISE_REGISTER_PATH: path },
});
const anchorRun = await runSampled(process.execPath, [join(ROOT, 'scripts/register.mjs'), 'anchor'], {
  env: { ENTERPRISE_REGISTER_PATH: path },
});
record('C8-register-verify', {
  condition: `register.mjs verify over a register of ${LINES} lines built with the module's own serializer and hash`,
  numbers: {
    lines: LINES,
    fileBytes: statSync(path).size,
    verifyExitStatus: verifyRun.status,
    verifyDurationMs: verifyRun.durationMs,
    verifyPeakRssBytes: verifyRun.peakRssBytes,
    anchorDurationMs: anchorRun.durationMs,
    buildMs: Number(buildMs.toFixed(1)),
  },
  seed: { label, commands: [...SEED_COMMANDS] },
  command: 'node scripts/register.mjs verify, with ENTERPRISE_REGISTER_PATH at a file under os.tmpdir()',
  notes: [
    "The design's figure is verify under one second. RECORDED, not asserted.",
    'verifyDurationMs is the whole command, Node’s start-up included, which is what an operator waits.',
  ],
});

/* ------------------------------------------------------- the sync's full read */
const f = fixture('sized', '--rows', '200', '--label', `${label}-sync`);
const lifecycleActions = SYNCED_ACTIONS.filter((a) => a !== ACT_COPY_TAKEN);
owner(`insert into app.audit_events (company_id, actor_user_id, actor_kind, action, entity_type, entity_id, details)
       select '${f.companyId}', '${f.adminUserId}', 'member', 'membership.set_roles', 'membership',
              '${f.adminMembershipId}', jsonb_build_object('membership_id', '${f.adminMembershipId}',
              'roles_before', '{member}'::text[], 'roles_after', '{it_reviewer,member}'::text[],
              'reason_code', 'measurement_lifecycle')
         from generate_series(1, ${LIFECYCLE_ROWS});`);
/* The rest are NOT lifecycle acts, so the read has to skip them: that is what makes the plan interesting.
   `probe.padding` is deliberately not an action any routine writes, and `action` is pattern-checked and not
   drawn from a vocabulary (001 line 159), so the padding cannot be mistaken for a real act by anything. */
owner(`insert into app.audit_events (company_id, actor_user_id, actor_kind, action, entity_type, entity_id, details)
       select '${f.companyId}', '${f.adminUserId}', 'member', 'probe.padding', 'company',
              '${f.companyId}', jsonb_build_object('company_id', '${f.companyId}', 'reason_code', 'measurement_noise')
         from generate_series(1, ${Math.max(0, AUDIT_ROWS - LIFECYCLE_ROWS)});`);
const totalAudit = Number(owner('select count(*) from app.audit_events;'));
const lifecycleCount = Number(
  owner(`select count(*) from app.audit_events where action in (${lifecycleActions.map((a) => `'${a}'`).join(', ')});`),
);

/* The sync's own read statement, reproduced for EXPLAIN. The script builds this text in readAudit(floor). */
const actions = SYNCED_ACTIONS.map((a) => `'${a}'`).join(', ');
const readSql = (floor) => `select jsonb_build_object(
  'watermarkAt', now(),
  'rows', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'companyId', a.company_id, 'actorUserId', a.actor_user_id, 'actorKind', a.actor_kind,
      'action', a.action, 'at', a.at, 'details', a.details,
      'startsAt', case
        when a.action = 'company.set_access_period'
             and a.id = (select max(b.id) from app.audit_events b
                          where b.company_id = a.company_id and b.action = 'company.set_access_period')
        then (select p.starts_at from app.access_periods p where p.company_id = a.company_id)
        else null end)
      order by a.id)
      from app.audit_events a
     where a.id >= ${floor}
       and a.action in (${actions})
       and (a.action <> '${ACT_COPY_TAKEN}' or a.actor_kind = 'operator')), '[]'::jsonb))::text`;
const plan = owner(
  `begin isolation level repeatable read read only;
   explain (analyze, buffers, format text) ${readSql(0)};
   commit;`,
  { timeoutMs: 900_000 },
);
writeFileSync(join(scratch, 'plan.txt'), `${plan}\n`);

const syncPath = join(scratch, 'sync.jsonl');
execFileSync(process.execPath, [join(ROOT, 'scripts/register.mjs'), 'init'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, ENTERPRISE_REGISTER_PATH: syncPath },
});
const syncRun = await runSampled(
  process.execPath,
  [join(ROOT, 'scripts/register.mjs'), 'sync', '--operator', ids.U_op],
  { env: { ENTERPRISE_DB_PSQL: ownerPsql(), ENTERPRISE_REGISTER_PATH: syncPath }, timeoutMs: 1_800_000 },
);
const syncedLines = syncRun.status === 0 ? readFileSync(syncPath, 'utf8').trim().split('\n').length : null;

record('C8-sync-full-read', {
  condition: `the sync's full read of the epoch's lifecycle acts over an app.audit_events of ${totalAudit} rows, of which ${lifecycleCount} are lifecycle acts`,
  numbers: {
    auditRows: totalAudit,
    lifecycleRows: lifecycleCount,
    syncExitStatus: syncRun.status,
    syncDurationMs: syncRun.durationMs,
    syncPeakRssBytes: syncRun.peakRssBytes,
    linesWritten: syncedLines,
  },
  seed: { label, commands: [...SEED_COMMANDS] },
  command: 'node scripts/register.mjs sync --operator <operator>; the read statement explained separately',
  notes: [
    'The query plan is beside this record, in plan.txt: it is the sync’s own statement, reproduced from scripts/register.mjs readAudit(0).',
    'There is no window: E7D-C-F2 removed it, because an owner transaction can commit an id after later ids for as long as it runs.',
    'syncDurationMs is the whole command: the read, the mapping of each row to a line, the chain and the writes.',
  ],
});

/* The plan is retained beside the record, because a number without its plan says nothing about why. */
const outDir = join(ROOT, 'evidence', 'e7-docs-repro', 'measurements');
writeFileSync(join(outDir, 'C8-sync-query-plan.txt'), `${plan}\n`);

rmSync(scratch, { recursive: true, force: true });
process.stdout.write('c8: done. Reseed before anything else runs: bash tests/db/00-seed.sh\n');
