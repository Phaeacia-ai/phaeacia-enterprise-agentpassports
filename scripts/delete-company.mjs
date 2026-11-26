#!/usr/bin/env node
/* The owner-side tenant deletion, as a command (E7 design 1.2, correction E7D-C-F12).
 *
 *   node scripts/delete-company.mjs --company UUID --slug SLUG
 *                                   --reason retention_deadline|customer_instruction|operator_request
 *                                   [--instruction REF] --operator UUID [--apply]
 *
 * A DRY RUN IS THE DEFAULT AND DELETES NOTHING. It reads the company's status, whether the slug matches,
 * app.deletion_state, the before-counts of all eighteen deletion sections and their total against
 * app.limit_delete_rows(), and reports what --apply would answer, in the routine's own refusal order.
 *
 * WITH --apply IT GOES THROUGH THE ONE DOOR: one owner transaction that sets the named operator's claims and
 * calls api.delete_company(company, slug, reason). Every precondition is the routine's, evaluated once, in its
 * order. Above app.limit_delete_rows() it refuses with the routine's own E_DELETE_TOO_LARGE; E6 1.6's handoff of
 * "the script above the bound" is declined, and lib/operator/deletion.mjs says why at length.
 *
 * AFTERWARDS, in order: the after-counts (zero in all eighteen tables, candidate_contributors through the ids
 * captured before), the routine's own `deleted` answer compared with the before-counts SECTION BY SECTION, the
 * register line with the audit id read back, and the NEW HEAD PRINTED. A tombstone is durable only once its line
 * is written and the head anchored, so the operator records that head in the company workspace and the guide does
 * not let a deletion be reported to a customer as done before then. If the append fails after the commit, the
 * script exits 1 NAMING THE AUDIT ID, and `register.mjs sync --ref <auditId>=<ref>` writes the line.
 *
 * WHAT IS LOGGED AND WHAT NEVER IS. Logged: the company id, the eighteen counts, the total, the audit id, the
 * register head. NEVER logged: a row, a column value, the company's name, an address. The slug IS printed back
 * only as a yes/no match, never echoed, because it is the customer's own identifier. A failure of the owner
 * connection is ONE owner_db_failed line (scripts/owner-db.mjs) and never the database's text.
 *
 * What it needs:
 *   ENTERPRISE_DB_PSQL        the owner connection. Never printed.
 *   ENTERPRISE_REGISTER_PATH  the register, outside every Git work tree.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  afterSql,
  beforeCounts,
  beforeSql,
  claimsStatement,
  compare,
  DELETION_SECTIONS,
  DeletionError,
  dryRun,
  isRef,
  isSlug,
  isUuid,
  REASON_CODES,
  REASON_NEEDING_REFERENCE,
} from '../lib/operator/deletion.mjs';
import {
  append as appendLine,
  checkRegisterPath,
  fileStore,
  RegisterError,
  verify,
  withLock,
} from '../lib/operator/register.mjs';
import { OwnerDbError, outputFailure, ownerQuery } from './owner-db.mjs';

/** The marker before a payload line, so a psql command tag is never read as the answer. */
const MARK = '@json ';

const out = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);

class Refusal extends Error {
  constructor(code, lines, usage = false) {
    super('delete-company: refused');
    this.name = 'Refusal';
    this.code = code;
    this.lines = lines;
    this.usage = usage;
  }
}

const USAGE =
  'usage: node scripts/delete-company.mjs --company UUID --slug SLUG --reason ' +
  `${REASON_CODES.join('|')} [--instruction REF] --operator UUID [--apply]\n`;

const refuse = (rule) => {
  throw new Refusal(2, [`delete-company: ${rule}`], true);
};

/* Every value is matched against its shape BEFORE anything is opened, and a refusal names the flag and its rule
   and never what was passed: the slug is the customer's own identifier and the reference names correspondence. */
function parseArgs(argv) {
  const a = { apply: false };
  const value = (i, flag) => {
    const v = argv[i];
    if (typeof v !== 'string' || v.startsWith('--')) refuse(`${flag} takes a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--apply':
        a.apply = true;
        break;
      case '--dry-run':
        a.apply = false;
        break;
      case '--company':
      case '--operator': {
        const v = value(++i, flag);
        if (!isUuid(v)) refuse(`${flag} takes a lowercase uuid`);
        a[flag.slice(2)] = v;
        break;
      }
      case '--slug': {
        const v = value(++i, flag);
        if (!isSlug(v)) refuse('--slug matches ^[a-z0-9][a-z0-9-]{1,62}$');
        a.slug = v;
        break;
      }
      case '--reason': {
        const v = value(++i, flag);
        if (!REASON_CODES.includes(v)) refuse(`--reason is one of ${REASON_CODES.join(', ')}`);
        a.reason = v;
        break;
      }
      case '--instruction': {
        const v = value(++i, flag);
        if (!isRef(v))
          refuse(
            '--instruction matches ^[A-Za-z0-9._:/-]{1,80}$: a reference to the customer’s instruction in the company workspace, never free text',
          );
        a.instruction = v;
        break;
      }
      default:
        refuse(`unknown argument ${/^--[a-z0-9-]{1,32}$/.test(flag) ? flag : 'given'}`);
    }
  }
  for (const required of ['company', 'slug', 'reason', 'operator'])
    if (a[required] === undefined) refuse(`--${required} is required`);
  /* The script's own rule, added to the route's (design 1.2): the audit guard has no key for free text, so a
     deletion at a customer's instruction carries its reference in the REGISTER line or it does not run. */
  if (a.reason === REASON_NEEDING_REFERENCE && a.instruction === undefined)
    refuse(`--instruction is required when --reason is ${REASON_NEEDING_REFERENCE}: the register line carries it`);
  return a;
}

function registerPath() {
  try {
    return checkRegisterPath(process.env.ENTERPRISE_REGISTER_PATH);
  } catch (e) {
    if (!(e instanceof RegisterError)) throw e;
    refuse(e.rule);
  }
}

function marked(answer) {
  const lines = answer.split('\n').filter((l) => l.startsWith(MARK));
  if (lines.length !== 1) throw outputFailure();
  try {
    return JSON.parse(lines[0].slice(MARK.length));
  } catch {
    throw outputFailure();
  }
}

/** Gate 1 for this script: the chain and the local head. Nothing runs against a register that does not verify. */
function verifyRegister(store) {
  const text = store.read();
  if (text === null) throw new Refusal(1, ['delete-company: the register does not exist; run register.mjs init first']);
  const state = verify(text, { localHead: store.readHead() });
  if (!state.ok)
    throw new Refusal(
      1,
      state.problems.map((p) =>
        JSON.stringify({ event: 'register_refused', rule: p.rule, ...(p.at === undefined ? {} : { at: p.at }) }),
      ),
    );
  return state;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = fileStore(registerPath());

  return withLock(store, () => {
    /* Design 3.5 step 3: the register verifies before anything is read, let alone written. A dry run verifies it
       too, so an operator who runs the dry run learns that the register is broken BEFORE they reach for --apply. */
    verifyRegister(store);

    /* Step 4 and the dry run's whole body: one read-only snapshot. */
    const read = marked(ownerQuery(beforeSql(args.company, MARK)));
    const before = beforeCounts(read);
    const plan = dryRun({
      company: read.company,
      deletionState: read.deletionState,
      before,
      limit: Number(read.limit),
      slug: args.slug,
      reason: args.reason,
      instructionRef: args.instruction,
    });

    for (const section of DELETION_SECTIONS) out({ event: 'delete_before', section, rows: before.counts[section] });
    out({
      event: 'delete_plan',
      companyId: args.company,
      status: plan.status,
      slugMatches: plan.slugMatches,
      deletionState: plan.deletionState,
      rows: plan.rows,
      limit: plan.limit,
      overLimit: plan.overLimit,
      wouldRefuse: plan.wouldRefuse,
      apply: args.apply,
    });

    if (!args.apply) {
      process.stdout.write(
        plan.wouldRefuse === null
          ? 'delete-company: a DRY RUN. Nothing was deleted. Re-run with --apply to go through api.delete_company.\n'
          : `delete-company: a DRY RUN. Nothing was deleted, and --apply would be refused with ${plan.wouldRefuse}.\n`,
      );
      return 0;
    }

    /* --apply. The routine is the door and every precondition is ITS: this script does not pre-refuse what the
       routine would refuse, because the routine holds the company lock and this read does not, so a check here
       would be a second opinion taken at a different moment. The one exception is --instruction, refused at the
       argument step above, because the routine has no such rule to hold. */
    const answer = marked(
      ownerQuery(`begin;
${claimsStatement(args.operator)}
select '${MARK}' || jsonb_build_object(
  'deleted', (select d.deleted from api.delete_company('${args.company}'::uuid, ${quote(args.slug)}, ${quote(args.reason)}) d),
  'auditId', currval(pg_get_serial_sequence('app.audit_events', 'id')))::text;
commit;
`),
    );
    const deleted = answer.deleted;
    const auditId = Number(answer.auditId);
    if (deleted === null || typeof deleted !== 'object' || !Number.isSafeInteger(auditId)) throw outputFailure();
    out({
      event: 'delete_applied',
      companyId: args.company,
      auditId,
      orphanedAccounts: (deleted.orphaned_user_ids ?? []).length,
    });

    /* The after-counts, and the comparison of BOTH sides. */
    const after = marked(ownerQuery(afterSql(args.company, read.candidateIds ?? [], MARK)));
    const check = compare({ before: before.counts, deleted, after });
    for (const section of DELETION_SECTIONS)
      out({
        event: 'delete_after',
        section,
        before: before.counts[section],
        deleted: Number(deleted[section]),
        left: Number(after[section]),
      });
    if (!check.ok) {
      for (const p of check.problems) out({ event: 'delete_mismatch', ...p });
      /* The rows are gone either way: the routine committed. What failed is the ACCOUNT of what was deleted, so
         the register line is still written below by the next sync with its reference, and this exit is loud. */
      throw new Refusal(1, [
        `delete-company: the deletion committed as audit row ${auditId} and the counts DISAGREE; the sections above say how. The register line was not written: run node scripts/register.mjs sync --operator ${args.operator} --ref ${auditId}=<the instruction reference>`,
      ]);
    }

    /* The register line, with the audit id read back, then the new head. */
    let line;
    try {
      line = appendLine(
        store,
        'company.delete',
        {
          companyId: args.company,
          reason: args.reason,
          ...(args.instruction === undefined ? {} : { ref: args.instruction }),
          rows: before.total,
          auditId,
          actor: args.operator,
        },
        {},
      );
    } catch (failure) {
      out({ event: 'register_append_failed', auditId, act: 'company.delete' });
      throw new Refusal(1, [
        `delete-company: the deletion committed as audit row ${auditId} and its register line was NOT written. THE TOMBSTONE IS NOT DURABLE YET: run node scripts/register.mjs sync --operator ${args.operator}${args.reason === REASON_NEEDING_REFERENCE ? ` --ref ${auditId}=<the instruction reference>` : ''}, then node scripts/register.mjs anchor.`,
        `delete-company: the register refused: ${failure instanceof RegisterError ? failure.rule : 'unknown'}`,
      ]);
    }

    out({
      event: 'delete_done',
      companyId: args.company,
      auditId,
      rows: before.total,
      seq: line.seq,
      head: line.head,
    });
    process.stdout.write(
      `delete-company: record the head ${line.head} in the company workspace. The deletion is not durable until that head is anchored, and it is not reported to the customer as done before then.\n`,
    );
    return 0;
  });
}

/** A SQL string literal. Every value that reaches one here has matched its shape first. */
const quote = (text) => `'${String(text).replaceAll("'", "''")}'`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = (await main()) ?? 0;
  } catch (failure) {
    if (failure instanceof Refusal) {
      for (const l of failure.lines) process.stderr.write(`${l}\n`);
      if (failure.usage) process.stderr.write(USAGE);
      process.exit(failure.code);
    }
    if (failure instanceof OwnerDbError) {
      out(failure.line);
      process.exit(1);
    }
    if (failure instanceof DeletionError || failure instanceof RegisterError) {
      out({ event: 'delete_refused', rule: failure.rule });
      process.exit(1);
    }
    throw failure;
  }
}
