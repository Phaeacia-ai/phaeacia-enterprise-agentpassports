#!/usr/bin/env node
/* The operator lifecycle register, as a command (E7 design 1.3). Owner-side, run from a terminal.
 *
 *   node scripts/register.mjs init
 *   node scripts/register.mjs verify [--anchored-head SEQ:SHA256] [--copy PATH]
 *   node scripts/register.mjs anchor [--anchored-head SEQ:SHA256] [--copy PATH]
 *   node scripts/register.mjs append --act ACT [the act's own values] --operator UUID
 *   node scripts/register.mjs sync --operator UUID [--ref AUDITID=REFERENCE ...] [--anchored-head SEQ:SHA256]
 *   node scripts/register.mjs gap --ref REFERENCE --operator UUID [--backup-at ISO8601] [--audit-floor N]
 *
 * WHAT EACH ONE IS FOR.
 *
 *   init     writes line 0, `register.open`, and the head file beside it. An existing register refuses.
 *   verify   the chain, the file ending at its LOCAL head, and, when given, the ANCHORED head recorded in the
 *            company workspace and a second COPY of the file, which must be a prefix of this one or it is a fork.
 *            Those three are recovery's gate 1, and each is a refusal and not a warning.
 *   anchor   verifies, then prints the head to record in the company workspace. Run after every sync and after
 *            every deletion: a tombstone is durable only once its line is written AND the head anchored.
 *   append   the three acts a person appends by hand: `factor.delete` at step 5 of the lost-second-factor
 *            procedure, the discard line when the operator's local copy of a takeout file is deleted after the
 *            customer confirms receipt, and `key.replace` at restore step 6 and at every key rotation. Every
 *            other act is written by the script that performs it or by the sync, and this command refuses them,
 *            so nothing a database committed can be claimed here by hand.
 *   sync     reads app.audit_events over the owner connection for the lifecycle acts OF THE CURRENT EPOCH at or
 *            above its floor, in one repeatable-read snapshot, and appends those whose (epoch, auditId) the
 *            register does not already hold, in audit-id order, ending with a `register.sync` watermark line.
 *   gap      the one way on when gate 1 or gate 2 fails: the operator records that the interval is being
 *            reconciled by hand from the customers' confirmations. When no recovery epoch is open it opens one
 *            first, writing `restore.begin` before `restore.gap` (design 1.3's table names this command as that
 *            line's second writer, for the case where the register had to be recovered before the reconciler ran).
 *            It is also the one way on when the LOCAL HEAD IS MISSING (E7X-C-F1): every other verb refuses then,
 *            and gap proceeds only with --anchored-head, which the file must contain; every line after that head
 *            is unproven, the gap says so, and the head it writes starts from the gap.
 *
 * WHAT THIS COMMAND DOES NOT DO, said plainly because a reader will look for it here. It does not move
 * `app.audit_events_id_seq`. `reconcile.mjs begin` does that, above both the highest audit id the register holds
 * in any epoch and the restored table's own highest, and the reconciler is day 4's. `gap` therefore computes the
 * same floor and RECORDS it, and prints that the sequence move is still owed; until it is run, two acts can share
 * an audit id across epochs, which is exactly why the register's key is (epoch, auditId) and never the id alone.
 *
 * REFUSALS IN ORDER (design 3.5): the arguments, then the environment, then the lock, then the chain and the
 * heads, then the operator, then the act's own rules. Every refusal is before anything is written, exits non-zero
 * with a line naming the RULE, and echoes no value. A failure of the owner connection is one `owner_db_failed`
 * line and exit 1 (scripts/owner-db.mjs); the database's own text never reaches this terminal.
 *
 * What it needs:
 *   ENTERPRISE_REGISTER_PATH  the canonical register file, an ABSOLUTE path OUTSIDE every Git work tree. Its head
 *                             file is <path>.head and its lock <path>.lock, beside it. The register holds company
 *                             ids, dates and act words and, in `ref`, an operator-typed reference: business
 *                             records, which is why it is not in Git and not in the backup remote.
 *   ENTERPRISE_DB_PSQL        the owner connection, for `sync` and for `gap`'s floor only. The other verbs read
 *                             no database at all.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACT_COPY_DISCARDED,
  ACT_COPY_TAKEN,
  append as appendLine,
  appendMany,
  checkRegisterPath,
  compareCopies,
  fileStore,
  fold,
  init as initRegister,
  isRef,
  isUuid,
  parseHead,
  RegisterError,
  SYNCED_ACTIONS,
  syncPlan,
  verify,
  withLock,
} from '../lib/operator/register.mjs';
import { OwnerDbError, outputFailure, ownerQuery } from './owner-db.mjs';

const VERBS = ['init', 'verify', 'anchor', 'append', 'sync', 'gap'];
/** The acts a person may append by hand. Everything else is written by the act's own script or by the sync. */
const HAND_ACTS = [ACT_COPY_DISCARDED, 'factor.delete', 'key.replace'];
const SHA256 = /^[0-9a-f]{64}$/;
const KID = /^[A-Za-z0-9._-]{1,64}$/;
/* psql prints a command tag for BEGIN and COMMIT on stdout even under -At, and the operator's own command may add
   flags this script does not choose, so the payload of a multi-statement read is marked rather than positioned. */
const MARK = '@json ';

const out = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);

/** A refusal that has to unwind through the lock before it exits. Its message names the rule, never a value. */
class Refusal extends Error {
  constructor(code, lines, usage = false) {
    super('register: refused');
    this.name = 'Refusal';
    this.code = code;
    this.lines = lines;
    this.usage = usage;
  }
}

const USAGE =
  'usage: node scripts/register.mjs init | verify [--anchored-head SEQ:SHA256] [--copy PATH] | anchor |\n' +
  '       append --act ACT ... --operator UUID | sync --operator UUID [--ref AUDITID=REFERENCE] |\n' +
  '       gap --ref REFERENCE --operator UUID [--backup-at ISO8601] [--audit-floor N]\n';

const refuse = (rule) => {
  throw new Refusal(2, [`register: ${rule}`], true);
};

/* Every value comes off the command line as a string and is matched against its shape BEFORE it is used and
   before anything is opened. A refusal names the flag and its rule; it never prints what was passed, because a
   reference and a path are the two arguments that can carry something identifying. */
function parseArgs(argv) {
  const verb = argv[0];
  if (!VERBS.includes(verb)) refuse(`the first argument is one of ${VERBS.join(', ')}`);
  const a = { verb, refs: {} };
  const value = (i, flag) => {
    const v = argv[i];
    if (typeof v !== 'string' || v.startsWith('--')) refuse(`${flag} takes a value`);
    return v;
  };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--operator': {
        const v = value(++i, flag);
        if (!isUuid(v)) refuse('--operator takes a lowercase uuid');
        a.operator = v;
        break;
      }
      case '--act': {
        const v = value(++i, flag);
        if (!HAND_ACTS.includes(v))
          refuse(
            `--act is one of ${HAND_ACTS.join(', ')}; every other act is written by the script that performs it or by the sync`,
          );
        a.act = v;
        break;
      }
      case '--company': {
        const v = value(++i, flag);
        if (!isUuid(v)) refuse('--company takes a lowercase uuid');
        a.company = v;
        break;
      }
      case '--user-id': {
        const v = value(++i, flag);
        if (!isUuid(v)) refuse('--user-id takes a lowercase uuid');
        a.userId = v;
        break;
      }
      case '--factor-id': {
        const v = value(++i, flag);
        if (!isUuid(v)) refuse('--factor-id takes a lowercase uuid');
        a.factorId = v;
        break;
      }
      case '--ref': {
        const v = value(++i, flag);
        if (a.verb === 'sync') {
          const at = v.indexOf('=');
          const id = v.slice(0, at);
          const ref = v.slice(at + 1);
          if (at < 1 || !/^[0-9]+$/.test(id) || !isRef(ref))
            refuse('--ref takes AUDITID=REFERENCE, the reference matching ^[A-Za-z0-9._:/-]{1,80}$');
          a.refs[id] = ref;
        } else {
          if (!isRef(v))
            refuse(
              '--ref matches ^[A-Za-z0-9._:/-]{1,80}$: a reference to the instruction in the company workspace, never free text',
            );
          a.ref = v;
        }
        break;
      }
      case '--sha256': {
        const v = value(++i, flag);
        if (!SHA256.test(v)) refuse('--sha256 takes 64 lowercase hex characters');
        a.sha256 = v;
        break;
      }
      case '--kid-before':
      case '--kid-after': {
        const v = value(++i, flag);
        if (!KID.test(v)) refuse(`${flag} matches ^[A-Za-z0-9._-]{1,64}$`);
        a[flag === '--kid-before' ? 'kidBefore' : 'kidAfter'] = v;
        break;
      }
      case '--anchored-head': {
        const v = value(++i, flag);
        try {
          parseHead(v, 'anchored head');
        } catch {
          refuse('--anchored-head takes SEQ:SHA256, as `anchor` printed it');
        }
        a.anchoredHead = v;
        break;
      }
      case '--copy': {
        const v = value(++i, flag);
        if (!isAbsolute(v)) refuse('--copy takes an absolute path to the workspace copy');
        a.copy = v;
        break;
      }
      case '--backup-at': {
        const v = value(++i, flag);
        if (Number.isNaN(Date.parse(v))) refuse('--backup-at takes an ISO 8601 timestamp');
        a.backupAt = new Date(v).toISOString();
        break;
      }
      case '--audit-floor': {
        const v = value(++i, flag);
        if (!/^[0-9]+$/.test(v)) refuse('--audit-floor takes a non-negative integer');
        a.auditFloor = Number(v);
        break;
      }
      default:
        refuse(`unknown argument ${/^--[a-z0-9-]{1,32}$/.test(flag) ? flag : 'given'}`);
    }
  }
  if (['append', 'sync', 'gap'].includes(verb) && a.operator === undefined)
    refuse(`${verb} needs --operator: every act the register records names who performed it`);
  if (verb === 'append') {
    if (a.act === undefined) refuse('append needs --act');
    if (a.act === 'factor.delete' && (a.userId === undefined || a.factorId === undefined || a.ref === undefined))
      refuse('append --act factor.delete needs --user-id, --factor-id and --ref (the operations-log record)');
    if (a.act === ACT_COPY_DISCARDED && (a.company === undefined || a.sha256 === undefined))
      refuse(`append --act ${ACT_COPY_DISCARDED} needs --company and --sha256 (the file that was deleted)`);
    if (a.act === 'key.replace' && (a.kidBefore === undefined || a.kidAfter === undefined))
      refuse('append --act key.replace needs --kid-before and --kid-after');
  }
  if (verb === 'gap' && a.ref === undefined)
    refuse('gap needs --ref: the record of the hand reconciliation, in the company workspace');
  return a;
}

/* The register path, the store and the lock are the register module's (design 1.3): one rule with one home, and
   three scripts hold this file. A RegisterError from any of them becomes this script's own refusal below. */
function registerPath() {
  try {
    return checkRegisterPath(process.env.ENTERPRISE_REGISTER_PATH);
  } catch (e) {
    if (!(e instanceof RegisterError)) throw e;
    refuse(e.rule);
  }
}

/** Gate 1: the chain, the local head, the anchored head, and the two copies. Every failure is a refusal. A
 *  missing local head is one (E7X-C-F1), except to `gap` with an anchored head, which is `headLost`. */
function verifyOrRefuse(store, anchoredHead, copyPath, { headLost = false } = {}) {
  const text = store.read();
  if (text === null) throw new Refusal(1, ['register: the register does not exist; run init first']);
  const state = verify(text, { localHead: headLost ? undefined : (store.readHead() ?? null), anchoredHead });
  const problems = [...state.problems];
  let copies = null;
  if (copyPath !== undefined) {
    if (!existsSync(copyPath)) problems.push({ rule: 'the workspace copy does not exist' });
    else {
      copies = compareCopies(text, readFileSync(copyPath, 'utf8'));
      if (copies.relation === 'fork') problems.push({ rule: 'the two copies FORK', at: copies.at });
    }
  }
  if (problems.length > 0)
    throw new Refusal(
      1,
      problems.map((p) =>
        JSON.stringify({ event: 'register_refused', rule: p.rule, ...(p.at === undefined ? {} : { at: p.at }) }),
      ),
    );
  return { text, state, copies };
}

// ---------------------------------------------------------------------------
// The owner-side reads. Two, both read only.
// ---------------------------------------------------------------------------

/** The one marked payload line of a multi-statement read; anything else is an `output` failure. */
function marked(answer) {
  const lines = answer.split('\n').filter((l) => l.startsWith(MARK));
  if (lines.length !== 1) throw outputFailure();
  try {
    return JSON.parse(lines[0].slice(MARK.length));
  } catch {
    throw outputFailure();
  }
}

/* One repeatable-read read-only snapshot over the epoch's lifecycle acts at or above its floor. now() in that
   transaction is its START, which is what makes the watermark's promise true: every lifecycle act committed
   before it is in the register once the watermark line is written.
   IT READS EVERY SUCH ACT, NOT A WINDOW (E7D-C-F2 b). An id is assigned at insert and its transaction may commit
   after later ids for as long as it runs, so a window of 1,000 ids loses a late commit.
   The whole-company copy action is taken only where the OPERATOR performed it: the company admin's own route
   writes the same audit action as a member act, which is not the operator's register.
   startsAt is read from app.access_periods in the SAME snapshot, and only for the company's LATEST such row,
   because the audit row carries no starts_at (E7D-C-F5); anything else is null and is never invented. */
function readAudit(floor) {
  const actions = SYNCED_ACTIONS.map((a) => `'${a}'`).join(', ');
  const sql = `begin isolation level repeatable read read only;
select '${MARK}' || jsonb_build_object(
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
     where a.id >= ${Number(floor)}
       and a.action in (${actions})
       and (a.action <> '${ACT_COPY_TAKEN}' or a.actor_kind = 'operator')), '[]'::jsonb))::text;
commit;`;
  const answer = marked(ownerQuery(sql));
  if (answer === null || typeof answer !== 'object' || !Array.isArray(answer.rows)) throw outputFailure();
  return answer;
}

/** The highest audit id the whole register holds, in any epoch, and the restored table's own highest, plus one. */
function floorFrom(lines) {
  let highest = 0;
  for (const line of lines) if (typeof line.auditId === 'number') highest = Math.max(highest, line.auditId);
  const answer = ownerQuery('select coalesce(max(id), 0) from app.audit_events;');
  if (!/^[0-9]+$/.test(answer)) throw outputFailure();
  return Math.max(highest, Number(answer)) + 1;
}

// ---------------------------------------------------------------------------

async function run(args, store) {
  switch (args.verb) {
    case 'init':
      return withLock(store, () => {
        if (store.read() !== null)
          throw new Refusal(1, ['register: the register already exists; init refuses to write over one']);
        const head = initRegister(store);
        out({ event: 'register_init', seq: head.seq, head: head.head });
        return 0;
      });

    case 'verify': {
      const { state, copies } = verifyOrRefuse(store, args.anchoredHead, args.copy);
      const folded = fold(state.lines);
      out({
        event: 'register_verified',
        lines: state.count,
        head: `${state.head.seq}:${state.head.sha256}`,
        epoch: folded.epoch,
        epochOpen: folded.epochOpen,
        auditFloor: folded.auditFloor,
        anchoredHeadChecked: args.anchoredHead !== undefined,
        copies: copies === null ? null : copies.relation,
        watermark: folded.watermark,
      });
      return 0;
    }

    case 'anchor': {
      const { state } = verifyOrRefuse(store, args.anchoredHead, args.copy);
      out({ event: 'register_anchor', head: `${state.head.seq}:${state.head.sha256}`, lines: state.count });
      process.stdout.write(
        'register: record this head in the company workspace. It is the only head a person who can write this machine cannot also rewrite.\n',
      );
      return 0;
    }

    case 'append':
      return withLock(store, () => {
        verifyOrRefuse(store, args.anchoredHead, args.copy);
        const body =
          args.act === 'factor.delete'
            ? { userId: args.userId, factorId: args.factorId, ref: args.ref, actor: args.operator }
            : args.act === ACT_COPY_DISCARDED
              ? { companyId: args.company, sha256: args.sha256, actor: args.operator }
              : { kidBefore: args.kidBefore, kidAfter: args.kidAfter, actor: args.operator };
        const written = appendLine(store, args.act, body, { anchoredHead: args.anchoredHead });
        out({ event: 'register_appended', act: args.act, seq: written.seq, head: written.head });
        return 0;
      });

    case 'sync':
      return withLock(store, () => {
        const { state } = verifyOrRefuse(store, args.anchoredHead, args.copy);
        const folded = fold(state.lines);
        const { watermarkAt, rows } = readAudit(folded.auditFloor);
        const plan = syncPlan(rows, folded.epoch, folded.auditFloor, {
          existing: state.lines,
          refs: args.refs,
          watermarkAt: new Date(watermarkAt).toISOString(),
        });
        const written = appendMany(store, plan.bodies, { anchoredHead: args.anchoredHead });
        for (const w of written) out({ event: 'register_appended', act: w.line.act, seq: w.seq });
        const head = written.at(-1)?.head ?? `${state.head.seq}:${state.head.sha256}`;
        if (plan.stopped !== null) {
          out({
            event: 'register_sync_stopped',
            auditId: plan.stopped.auditId,
            action: plan.stopped.action,
            need: plan.stopped.need,
            appended: written.length,
            head,
          });
          throw new Refusal(1, [
            `register: audit row ${plan.stopped.auditId} needs an operator-supplied reference; re-run with --ref ${plan.stopped.auditId}=<the reference from the company workspace>. No watermark was written, because the acts after that row are not in the register.`,
          ]);
        }
        out({
          event: 'register_synced',
          epoch: folded.epoch,
          auditFloor: folded.auditFloor,
          read: plan.read,
          appended: written.length,
          watermarkAuditId: plan.watermarkAuditId,
          head,
        });
        return 0;
      });

    default:
      return withLock(store, () => {
        /* The head file is gone and the operator names the head the workspace recorded: the one case in which a
           writer proceeds without a local head (E7X-C-F1). Without --anchored-head this refuses like every verb. */
        let headLost = store.read() !== null && (store.readHead() ?? null) === null && args.anchoredHead !== undefined;
        const lostAtStart = headLost;
        const { state } = verifyOrRefuse(store, args.anchoredHead, args.copy, { headLost });
        const folded = fold(state.lines);
        const written = [];
        if (!folded.epochOpen) {
          const backupAt = args.backupAt ?? new Date().toISOString();
          const auditFloor = args.auditFloor ?? floorFrom(state.lines);
          written.push(
            appendLine(
              store,
              'restore.begin',
              { backupAt, auditFloor, actor: args.operator },
              { anchoredHead: args.anchoredHead, headLost },
            ),
          );
          headLost = false;
          out({
            event: 'register_appended',
            act: 'restore.begin',
            seq: written.at(-1).seq,
            epoch: folded.epoch + 1,
            auditFloor,
          });
          process.stdout.write(
            'register: this opened a recovery epoch and recorded its audit floor. It did NOT move app.audit_events_id_seq; reconcile.mjs begin does that, and until it runs two acts can share an audit id across epochs, which is why the key is (epoch, auditId).\n',
          );
        }
        written.push(
          appendLine(
            store,
            'restore.gap',
            { ref: args.ref, actor: args.operator },
            { anchoredHead: args.anchoredHead, headLost },
          ),
        );
        const last = written.at(-1);
        out({ event: 'register_appended', act: 'restore.gap', seq: last.seq, head: last.head });
        out({ event: 'register_gap', epoch: last.line.epoch, head: last.head, localHeadWasMissing: lostAtStart });
        if (lostAtStart)
          process.stdout.write(
            'register: the local head was MISSING. This gap rests on the anchored head you gave: every line after it is unproven and is reconciled by hand like the rest of the interval. A new local head was written at the gap; record it in the company workspace with anchor.\n',
          );
        process.stdout.write(
          'register: recorded. The reconciler applies what the register can support, and EVERY company still needs its customer’s confirmation at its lift.\n',
        );
        return 0;
      });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  return run(args, fileStore(registerPath()));
}

/* Runs only when this file IS the command, so another script may import a helper from it without running it
   (the shape scripts/check-migrations.mjs already has). */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = (await main()) ?? 0;
  } catch (failure) {
    if (failure instanceof Refusal) {
      for (const line of failure.lines) process.stderr.write(`${line}\n`);
      if (failure.usage) process.stderr.write(USAGE);
      process.exit(failure.code);
    }
    if (failure instanceof OwnerDbError) {
      out(failure.line);
      process.exit(1);
    }
    if (failure instanceof RegisterError) {
      out({ event: 'register_refused', rule: failure.rule });
      process.exit(1);
    }
    throw failure;
  }
}
