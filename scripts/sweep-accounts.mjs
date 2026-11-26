#!/usr/bin/env node
/* The account sweep's entry point (E6 design 1.5). Owner-side maintenance, run from a terminal.
 *
 *   node scripts/sweep-accounts.mjs                       a dry run: report the candidates, delete nothing
 *   node scripts/sweep-accounts.mjs --apply                delete them through GoTrue and record each one
 *   node scripts/sweep-accounts.mjs --limit 50             at most 50 this run (1 to 1000, default 100)
 *   node scripts/sweep-accounts.mjs --apply --operator ID  the operator whose act this is; required to apply
 *
 * --dry-run is the default and is also accepted explicitly. Nothing is deleted without --apply.
 *
 * What it needs, and where each thing comes from:
 *   SUPABASE_URL                    GoTrue's origin, as every other caller reads it
 *   SUPABASE_SERVICE_ROLE_KEY       lib/db/operator.mjs's one credential; never printed by anything here
 *   ENTERPRISE_DB_PSQL              how to reach the database AS THE OWNER, one shell command that reads a
 *                                   statement on stdin and prints tab-free rows, e.g.
 *                                   'docker exec -i supabase_db_x psql -U postgres -X -At'
 *                                   The four functions it calls are granted to NOBODY, so an owner connection is
 *                                   what makes them callable at all and the whole of the authorization, in the
 *                                   same terms E2 section 5 uses for app_maintenance.
 *
 * Why the database access is here and not in lib/operator/accounts.mjs: scripts/check-imports.mjs admits only
 * node:crypto, node:fs and node:path under lib/, so a psql child process cannot live there. The module takes the
 * two owner-side calls as a dependency, which also lets tests/e6/unit run the whole protocol without a stack.
 *
 * It adds NO import edge: scripts/ may import lib/operator/, and lib/operator/ already holds the operator client
 * (scripts/check-imports.mjs, EDGES and OPERATOR_IMPORTERS). No route can reach any of this.
 */
import { sweepAccounts } from '../lib/operator/accounts.mjs';
import { OwnerDbError, ownerQuery } from './owner-db.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function usage(message) {
  process.stderr.write(`sweep-accounts: ${message}\n`);
  process.stderr.write('usage: node scripts/sweep-accounts.mjs [--apply] [--limit N] [--operator UUID]\n');
  process.exit(2);
}

function parseArgs(argv) {
  const out = { apply: false, limit: 100, operatorId: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 1000) usage('--limit takes an integer from 1 to 1000');
      out.limit = n;
    } else if (a === '--operator') {
      const v = argv[++i];
      if (typeof v !== 'string' || !UUID.test(v)) usage('--operator takes a lowercase uuid');
      out.operatorId = v;
    } else usage(`unknown argument ${a}`);
  }
  if (out.apply && out.operatorId === undefined) usage('--apply needs --operator: the audit row names who acted');
  return out;
}

function env(name) {
  const v = process.env[name];
  if (typeof v !== 'string' || v.length === 0) usage(`${name} is not set`);
  return v;
}

/* One statement as the owner, through the shared helper (E7 design 1.2, E7D-C-F6). The command is the operator's
   own and is not built from any value this script read; every value that goes INTO a statement below is a uuid this
   script matched against UUID first or an integer, so nothing user-supplied is interpolated as text.

   What changed in E7 and why: this function used to run its own spawnSync with Node's DEFAULT maxBuffer and, on a
   failure, to print THE FIRST 500 BYTES OF STDERR. A check violation's DETAIL echoes the failing row and a
   connection failure's diagnostic names the host, the role and the database, so that line carried a tenant's
   content past the error boundary lib/errors.mjs keeps everywhere else. scripts/owner-db.mjs maps every failure to
   one category, a SQLSTATE and a CODES key and drops the text; the bound is explicit and refuses rather than
   truncating. The fail-before is a run of this file as it stood at f842da1
   (evidence/e7-scripts-repro/e7-32-sweep-fail-before.log.txt). */
function ownerSql(statement) {
  env('ENTERPRISE_DB_PSQL');
  return ownerQuery(statement);
}

const requireUuid = (id) => {
  if (typeof id !== 'string' || !UUID.test(id)) throw new TypeError('sweep-accounts: not a uuid');
  return id;
};

const db = {
  candidates(limit) {
    const answer = JSON.parse(ownerSql(`select app.sweep_candidates(${Number(limit)});`));
    return { userIds: answer.user_ids ?? [], remaining: answer.remaining ?? 0 };
  },
  /* The same predicate as app.sweep_candidates, for ONE id, read immediately before that id's delete
     (E6D-C-F13). app.sweep_candidate_ids has no single-id form, so membership in the current candidate set is
     what is asked: it is the same predicate by construction and cannot drift from it. */
  stillCandidate(userId) {
    const id = requireUuid(userId);
    const answer = ownerSql(`select '${id}'::uuid = any (app.sweep_candidate_ids(2147483647)) and true;`);
    return answer === 't';
  },
  recorded(operatorId, ids) {
    const op = requireUuid(operatorId);
    const checked = ids.map(requireUuid);
    if (checked.length === 0) return { recorded: 0 };
    const answer = JSON.parse(
      ownerSql(`select app.sweep_recorded('${op}'::uuid, array['${checked.join("','")}']::uuid[]);`),
    );
    return { recorded: answer.recorded ?? 0 };
  },
};

const args = parseArgs(process.argv.slice(2));
const log = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);
/* A failure of the owner connection is ONE line and exit 1 (E7 design 1.2). The detail of a failed statement is in
   the database's own log, read there under the owner's credential; it is never copied into a terminal, the register,
   a ticket or an evidence file. */
let result;
try {
  result = await sweepAccounts({
    dryRun: !args.apply,
    limit: args.limit,
    operatorId: args.operatorId,
    db,
    log,
  });
} catch (failure) {
  if (!(failure instanceof OwnerDbError)) throw failure;
  log(failure.line);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ event: 'sweep_done', dryRun: !args.apply, ...result }, null, 2)}\n`);
if (!args.apply && result.candidates > 0) {
  process.stdout.write('sweep-accounts: a dry run. Nothing was deleted. Re-run with --apply --operator UUID.\n');
}
process.exit(result.refused > 0 ? 1 : 0);
