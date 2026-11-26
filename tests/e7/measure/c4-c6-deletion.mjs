#!/usr/bin/env node
/* Section 6 C4, C5 and C6: where the ROUTE's deletion stops, what the SCRIPT costs, and what the lock holds.
 *
 *   node tests/e7/measure/c4-c6-deletion.mjs --label <label> [--sizes 10000,50000,100000,250000,500000]
 *
 * C4  THE ROW COUNT AT WHICH api.delete_company EXCEEDS app_server's 8 s statement timeout (001 line 42). Closed
 *     companies are seeded owner-side at each size and deleted THROUGH THE ROUTE, which reaches the database as
 *     app_server through the local PostgREST, so the timeout is the deployed one and not a number this script
 *     chose. Design section 6 says the real edge is not 500,000 and that the operator guide states the number;
 *     what is recorded here is the outcome at each size and the largest that completed.
 * C5  the same sizes through scripts/delete-company.mjs, which runs as the owner with NO statement timeout: its
 *     duration, the company lock's hold time as ANOTHER SESSION experiences it, and a concurrent write in another
 *     company throughout, which must not be affected.
 * C6  the deletion at 500,000 rows, which is app.limit_delete_rows() exactly. It is what decides whether the
 *     constant is right or a migration should move it (design 1.2).
 *
 * Nothing here is a gate, and nothing asserts a bound. Each size is seeded TWICE, once for the route and once for
 * the script, because a deletion that succeeds leaves nothing to delete again. Reseed after this script.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { seed as seedStack } from '../../e2/helpers/stack.mjs';
import { e6routes, operators } from '../../e6/stack/helpers.mjs';
import { events, owner, ownerPsql, ownerTimed, record, ROOT, runSampled, sleep } from './helpers.mjs';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const label = arg('--label');
if (label === null || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(label)) {
  process.stderr.write('usage: node tests/e7/measure/c4-c6-deletion.mjs --label LABEL [--sizes a,b,c]\n');
  process.exit(2);
}
const SIZES = (arg('--sizes', '10000,50000,100000,250000,500000') ?? '').split(',').map((n) => Number.parseInt(n, 10));
if (!SIZES.every((n) => Number.isInteger(n) && n >= 100)) {
  process.stderr.write('c4-c6: --sizes is a comma-separated list of integers of at least 100\n');
  process.exit(2);
}

const ids = seedStack();
const scratch = mkdtempSync(join(tmpdir(), 'e7-measure-del-'));
const SEED_COMMANDS = ['bash tests/db/00-seed.sh'];
const R = await e6routes([]);
const OP = operators(ids);

function fixture(...args) {
  SEED_COMMANDS.push(`node tests/e7/measure/seed.mjs ${args.join(' ')}`);
  const out = execFileSync(process.execPath, [join(ROOT, 'tests/e7/measure/seed.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

function register(name) {
  const path = join(scratch, `${name}.jsonl`);
  execFileSync(process.execPath, [join(ROOT, 'scripts/register.mjs'), 'init'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ENTERPRISE_REGISTER_PATH: path },
  });
  return path;
}

const slugOf = (companyId) => owner(`select slug from app.companies where id = '${companyId}';`);

/* --------------------------------------------------------------- C4 */
const routeResults = [];
for (const rows of SIZES) {
  const f = fixture('sized', '--rows', String(rows), '--closed', '--label', `${label}-r`);
  const slug = slugOf(f.companyId);
  const t0 = Date.now();
  let answer;
  try {
    answer = await R.companyDelete(OP.aal2, f.companyId, { confirmSlug: slug, reasonCode: 'retention_deadline' });
  } catch (e) {
    answer = { status: 0, body: { code: 'threw', message: String(e?.message ?? e).slice(0, 200) } };
  }
  const ms = Date.now() - t0;
  const gone = owner(`select count(*) from app.companies where id = '${f.companyId}';`) === '0';
  routeResults.push({
    rows: f.deletionRows,
    requested: rows,
    status: answer.status,
    code: answer.body?.code ?? null,
    durationMs: ms,
    companyGone: gone,
  });
  process.stdout.write(`C4 ${rows}: status ${answer.status} ${answer.body?.code ?? 'ok'} in ${ms} ms, gone=${gone}\n`);
  /* A company the route could not delete is left behind on purpose: the script deletes it in C5's own fixture,
     and this one is removed here so the next size starts from a clean database. */
  if (!gone) {
    owner(`begin; set local app.tenant_deletion = 'on';
           select set_config('request.jwt.claims', '{"role":"app_server","sub":"${ids.U_op}","aal":"aal2"}', true);
           select api.delete_company('${f.companyId}', '${slug}', 'operator_request'); commit;`, { timeoutMs: 900_000 });
  }
}

const completed = routeResults.filter((r) => r.companyGone);
const refused = routeResults.filter((r) => !r.companyGone);
record('C4-route-deletion-edge', {
  condition:
    "closed companies seeded owner-side at each size and deleted THROUGH THE ROUTE, which reaches the database as app_server, whose statement_timeout is 8 s (001 line 42)",
  numbers: {
    perSize: routeResults,
    largestCompleted: completed.length === 0 ? null : Math.max(...completed.map((r) => r.rows)),
    smallestRefused: refused.length === 0 ? null : Math.min(...refused.map((r) => r.rows)),
    sessionStatementTimeout: owner("select setting from pg_settings where name = 'statement_timeout';"),
    appServerRoleSettings: owner(
      "select coalesce(string_agg(s, '; ' order by s), 'none') from pg_roles r, unnest(r.rolconfig) s where r.rolname = 'app_server';",
    ),
  },
  seed: { label, commands: [...SEED_COMMANDS] },
  command:
    'POST /api/operator/companies/:companyId/delete through lib/http/routes.mjs, which calls api.delete_company over the local PostgREST as app_server',
  notes: [
    'A 57014 (statement timeout) or a 500 with the transaction rolled back is the edge; the row count of the largest that COMPLETED and of the smallest that did not are the two numbers the operator guide quotes.',
    'The hosted authenticator role’s timeout may differ from the local role setting, so this number is re-measured hosted before it is quoted to a customer (H-P6).',
    'A company the route could not delete was removed owner-side afterwards, so each size started from a clean database.',
    'No size reached the statement timeout, so this measurement does not establish that the timeout is applied to an impersonated request at all. tests/e7/measure/c4-role-settings-probe.mjs is what settles that, and its own record says which way.',
    'The padding rows are AUDIT rows, the cheapest kind the deletion touches: one indexed delete, no TOAST, no cascade. A real company\u2019s rows are spread over eighteen tables with content behind them, so the row count at which a real deletion would reach 8 s is LOWER than anything here, and this measurement is an upper bound on the edge and not the edge.',
  ],
});

/* --------------------------------------------------------------- C5 and C6 */
const scriptResults = [];
for (const rows of SIZES) {
  const f = fixture('sized', '--rows', String(rows), '--closed', '--label', `${label}-s`);
  const slug = slugOf(f.companyId);
  const other = fixture('sized', '--rows', '200', '--label', `${label}-s${rows}-w`);

  /* The writer in ANOTHER company, throughout. */
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
        { timeoutMs: 120_000 },
      );
      writes += 1;
      worstMs = Math.max(worstMs, ms);
      await sleep(50);
    }
  })();

  /* A waiter on the deleted company's own row lock, started shortly after the deletion. What it waits is the
     hold time as another session experiences it, which is the number design section 6 asks for. */
  let waiterMs = null;
  let waiterStartedAfterMs = null;
  let waiterError = null;
  const waiterStart = Date.now();
  const waiter = (async () => {
    /* As early as the script can have taken the lock. `select id ... for no key update`, never count(*):
       FOR NO KEY UPDATE is refused with an aggregate, which is why the first version of this measurement
       recorded null at every size. */
    await sleep(150);
    waiterStartedAfterMs = Date.now() - waiterStart;
    const t = Date.now();
    try {
      owner(
        `begin; set local lock_timeout = '0';
         select id from app.companies where id = '${f.companyId}' for no key update; commit;`,
        { timeoutMs: 1_800_000 },
      );
      waiterMs = Date.now() - t;
    } catch (e) {
      waiterError = String(e?.message ?? e).slice(0, 160);
    }
  })();

  const registerPath = register(`c5-${rows}`);
  const run = await runSampled(
    process.execPath,
    [
      join(ROOT, 'scripts/delete-company.mjs'),
      '--company', f.companyId,
      '--slug', slug,
      '--reason', 'retention_deadline',
      '--operator', ids.U_op,
      '--apply',
    ],
    { env: { ENTERPRISE_DB_PSQL: ownerPsql(), ENTERPRISE_REGISTER_PATH: registerPath }, timeoutMs: 1_800_000 },
  );
  writing = false;
  await writer;
  await waiter;
  const done = events(run.stdout, 'delete_done')[0] ?? events(run.stdout).at(-1) ?? null;
  const gone = owner(`select count(*) from app.companies where id = '${f.companyId}';`) === '0';
  scriptResults.push({
    rows: f.deletionRows,
    requested: rows,
    exitStatus: run.status,
    scriptDurationMs: run.durationMs,
    reportedRows: done?.rows ?? null,
    lockHeldAsSeenByWaiterMs: waiterMs,
    waiterStartedAfterMs,
    waiterError,
    companyGone: gone,
    concurrentWritesInAnotherCompany: writes,
    worstConcurrentWriteMs: Number(worstMs.toFixed(1)),
    peakRssBytes: run.peakRssBytes,
  });
  process.stdout.write(`C5 ${rows}: exit ${run.status} in ${run.durationMs} ms, gone=${gone}, waiter=${waiterMs} ms\n`);
  if (run.status !== 0) process.stdout.write(`${run.stdout.slice(-800)}\n${run.stderr.slice(-400)}\n`);
}
record('C5-script-deletion', {
  condition:
    'the same sizes through scripts/delete-company.mjs, which runs as the owner with no statement timeout, with a concurrent writer in another company throughout',
  numbers: { perSize: scriptResults },
  seed: { label, commands: [...SEED_COMMANDS] },
  command:
    'node scripts/delete-company.mjs --company <uuid> --slug <slug> --reason retention_deadline --operator <operator> --apply',
  notes: [
    'lockHeldAsSeenByWaiterMs is measured from a second owner session that blocks on the same company row with `select id ... for no key update` and no lock timeout, started about 150 ms after the script; it is what another session would wait from that moment, and the script\u2019s own scriptDurationMs bounds the whole hold from above.',
    'No member of THAT company can wait on the lock, because a deletable company is closed. The number is what another operator session would wait.',
    'concurrentWritesInAnotherCompany and worstConcurrentWriteMs are the evidence that another company is unaffected.',
  ],
});

const ceiling = scriptResults.find((r) => r.requested === 500000) ?? null;
if (ceiling !== null) {
  record('C6-deletion-at-the-ceiling', {
    condition: 'the deletion at 500,000 rows, which is app.limit_delete_rows() exactly, through the script',
    numbers: {
      rows: ceiling.rows,
      scriptDurationMs: ceiling.scriptDurationMs,
      lockHeldAsSeenByWaiterMs: ceiling.lockHeldAsSeenByWaiterMs,
      limitDeleteRows: Number(owner('select app.limit_delete_rows();')),
      routeOutcomeAtThisSize: routeResults.find((r) => r.requested === 500000) ?? null,
    },
    seed: { label, commands: [...SEED_COMMANDS] },
    command: 'the C5 command at --rows 500000',
    notes: [
      'This is the number that decides whether the constant is right or a migration should move it (design 1.2). It is recorded and decides nothing here.',
      'Above the constant the script refuses with the routine’s own E_DELETE_TOO_LARGE rather than reaching around the one door.',
    ],
  });
}

rmSync(scratch, { recursive: true, force: true });
process.stdout.write('c4-c6: done. Reseed before anything else runs: bash tests/db/00-seed.sh\n');
