#!/usr/bin/env node
/* The reconciler, as a command (E7 design 1.3). Owner-side, run from a terminal at a closed recovery target.
 *
 *   node scripts/reconcile.mjs begin --operator UUID --closed-target --backup-at ISO8601 [--apply]
 *   node scripts/reconcile.mjs plan  --operator UUID --closed-target --anchored-head SEQ:SHA256 [--copy PATH]
 *   node scripts/reconcile.mjs apply --operator UUID --closed-target --anchored-head SEQ:SHA256 [--copy PATH]
 *   node scripts/reconcile.mjs lift  --operator UUID --company UUID --confirmation REF --anchored-head SEQ:SHA256
 *                                    [--remove UUID]... [--roles UUID=ROLE,ROLE]... [--withdrawn-by UUID]
 *                                    [--agreement REF] [--status active|suspended] [--copy PATH] [--apply]
 *   node scripts/reconcile.mjs end   --operator UUID
 *
 * WHAT EACH ONE IS FOR.
 *
 *   begin  NEEDS NO REGISTER, because everything it does narrows whatever the register turns out to say. It moves
 *          app.audit_events_id_seq above both the highest audit id the register holds IN ANY EPOCH and the restored
 *          table's own highest and records that value as the epoch's auditFloor; runs C6, which ends every restored
 *          credential; runs C0, which holds every company that is not closed; and appends `restore.begin` if the
 *          register verifies. When it does not verify, begin prints the floor and the `restore.begin` line is
 *          written by the `register.mjs gap` record that the only way on requires.
 *   plan   folds the verified register into one expected state per company, reads the database's state over the
 *          owner connection, and prints the plan: the corrections in the design's order, the refusals with their
 *          named ways out, and the reports.
 *   apply  runs it. One transaction per correction, each holding the state change and its audit row and nothing
 *          else; C8 and C9 through GoTrue, where the audit row is written only after the delete succeeded.
 *   lift   ends ONE company's hold after its customer has confirmed its current members and roles. It is the only
 *          way out of the hold: no operator route lifts one (009's api.set_company_status refuses a held company).
 *          It passes the same three gates as plan and plans the WHOLE recovery as plan does (E7X-C-F8), and it
 *          refuses while that plan owes the company anything but the lift's own acts, or owes any recorded
 *          credential deletion (C8, C9) that apply can make, whoever the user is.
 *   end    appends `restore.end` once no company is held, or names each one still waiting for its customer.
 *
 * --closed-target IS AN ATTESTATION, not a check. The reconciler cannot observe the provider's exposed-schema
 * setting or its Auth mail from SQL, so it says so rather than pretending: the runner states that the switch is
 * closed and the provider-side closure of the restore procedure is in force. `lift` does not take it, because a
 * lift runs after the Data API has reopened.
 *
 * IT RUNS AS THE OWNER, NOT AS app_maintenance, AND THAT IS DISCLOSED (design 1.3, amending E2 section 5). C2
 * writes app.access_periods, on which app_maintenance holds nothing; C3 writes app.agents and C4 app.releases,
 * neither in its grants; C0, C1 and the lift need the recovery setting; C6 writes schema auth. And at a closed
 * recovery target the operator necessarily holds the owner credential, because they ran the restore. So the
 * credential that runs this is the owner, which can do anything, not a repair principal bounded by grants; the
 * safety is the transaction contract, the narrowing-only rule, the hold and closed ingress.
 *
 * WHAT IS PRINTED AND WHAT NEVER IS. JSON lines of ids, counts, words and hashes (design 1.2 rule 6). TWO
 * DISCLOSED EXCEPTIONS, both deliberate and neither ever written to the register, a report or any retained file:
 *   1. C1 prints the exact `delete-company.mjs` command for a company the register records as deleted, and that
 *      command carries the company's SLUG, because the one door takes the slug as its confirmation and the command
 *      cannot be run without it.
 *   2. `lift` prints the company's active memberships with their roles AND THEIR ACCOUNT ADDRESSES, so that the
 *      operator can read the list to the customer's administrator on the confirmation call. It is printed ONLY
 *      when standard output is a terminal, and when it is not, the addresses ARE NOT EVEN READ.
 * A failure of the owner connection is one `owner_db_failed` line and exit 1 (scripts/owner-db.mjs); the
 * database's own text never reaches this terminal.
 *
 * What it needs:
 *   ENTERPRISE_DB_PSQL        the owner connection. Never printed.
 *   ENTERPRISE_REGISTER_PATH  the register, absolute and outside every Git work tree.
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  for C8 and C9 only, read by lib/db/operator.mjs and never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deleteAccount, deleteFactor, RECORD_BATCH } from '../lib/operator/accounts.mjs';
import {
  checkGates,
  correctionStatements,
  credentialStatements,
  factorAuditStatement,
  foldToPlan,
  holdCorrection,
  liftCorrection,
  liftStatus,
  ReconcileError,
  sweepRecordedStatement,
  transactionSql,
} from '../lib/operator/reconcile.mjs';
import {
  append as appendLine,
  checkRegisterPath,
  compareCopies,
  fileStore,
  fold,
  isRef,
  isUuid,
  parseHead,
  RegisterError,
  verify,
  withLock,
} from '../lib/operator/register.mjs';
import { ROLE_NAMES } from '../lib/rules/roles.mjs';
import { OwnerDbError, outputFailure, ownerQuery } from './owner-db.mjs';

const VERBS = ['begin', 'plan', 'apply', 'lift', 'end'];
const ATTESTING = ['begin', 'plan', 'apply'];
const GATED = ['plan', 'apply'];
/* The lift passes the gates too (E7X-C-F8), but its --anchored-head is refused after its own two arguments, so
   that a lift missing --company is told so first. */
/** The marker before a payload line, so a psql command tag is never read as the answer. */
const MARK = '@json ';

const out = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);
const say = (text) => process.stdout.write(`${text}\n`);

/** A refusal that has to unwind through the register lock before it exits. It names the rule, never a value. */
class Refusal extends Error {
  constructor(code, lines, usage = false) {
    super('reconcile: refused');
    this.name = 'Refusal';
    this.code = code;
    this.lines = lines;
    this.usage = usage;
  }
}

const USAGE =
  'usage: node scripts/reconcile.mjs begin --operator UUID --closed-target --backup-at ISO8601 [--apply] |\n' +
  '       plan|apply --operator UUID --closed-target --anchored-head SEQ:SHA256 [--copy PATH] |\n' +
  '       lift --operator UUID --company UUID --confirmation REF --anchored-head SEQ:SHA256 [--remove UUID]\n' +
  '            [--roles UUID=ROLE,ROLE] [--withdrawn-by UUID] [--agreement REF] [--status active|suspended]\n' +
  '            [--copy PATH] [--apply] |\n' +
  '       end --operator UUID\n';

const refuse = (rule) => {
  throw new Refusal(2, [`reconcile: ${rule}`], true);
};

/* Every value comes off the command line as a string and is matched against its shape BEFORE it is used and
   before anything is opened. A refusal names the flag and its rule and never prints what was passed: a reference
   and a path are the two arguments that can carry something identifying. */
function parseArgs(argv) {
  const verb = argv[0];
  if (!VERBS.includes(verb)) refuse(`the first argument is one of ${VERBS.join(', ')}`);
  const a = { verb, apply: verb === 'apply' || verb === 'end', remove: [], roles: {} };
  const value = (i, flag) => {
    const v = argv[i];
    if (typeof v !== 'string' || v.startsWith('--')) refuse(`${flag} takes a value`);
    return v;
  };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--apply':
        if (verb === 'plan') refuse('plan never applies; run apply');
        a.apply = true;
        break;
      case '--dry-run':
        if (verb === 'apply') refuse('apply applies; run plan for a dry run');
        a.apply = false;
        break;
      case '--closed-target':
        a.closedTarget = true;
        break;
      case '--operator':
      case '--company':
      case '--withdrawn-by': {
        const v = value(++i, flag);
        if (!isUuid(v)) refuse(`${flag} takes a lowercase uuid`);
        a[flag === '--withdrawn-by' ? 'withdrawnBy' : flag.slice(2)] = v;
        break;
      }
      case '--remove': {
        const v = value(++i, flag);
        if (!isUuid(v)) refuse('--remove takes a lowercase membership uuid');
        a.remove.push(v);
        break;
      }
      case '--roles': {
        const v = value(++i, flag);
        const at = v.indexOf('=');
        const membership = v.slice(0, at);
        const roles = v.slice(at + 1).split(',');
        if (at < 1 || !isUuid(membership) || roles.length === 0 || !roles.every((r) => ROLE_NAMES.includes(r)))
          refuse(`--roles takes UUID=ROLE,ROLE with roles among ${ROLE_NAMES.join(', ')}`);
        a.roles[membership] = roles;
        break;
      }
      case '--confirmation':
      case '--agreement': {
        const v = value(++i, flag);
        if (!isRef(v))
          refuse(
            `${flag} matches ^[A-Za-z0-9._:/-]{1,80}$: a reference to the record in the company workspace, never free text`,
          );
        a[flag.slice(2)] = v;
        break;
      }
      case '--status': {
        const v = value(++i, flag);
        if (!['active', 'suspended'].includes(v)) refuse('--status is active or suspended');
        a.status = v;
        break;
      }
      case '--backup-at': {
        const v = value(++i, flag);
        if (Number.isNaN(Date.parse(v))) refuse('--backup-at takes an ISO 8601 timestamp');
        a.backupAt = new Date(v).toISOString();
        break;
      }
      case '--anchored-head': {
        const v = value(++i, flag);
        try {
          parseHead(v, 'anchored head');
        } catch {
          refuse('--anchored-head takes SEQ:SHA256, as `register.mjs anchor` printed it');
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
      default:
        refuse(`unknown argument ${/^--[a-z0-9-]{1,32}$/.test(flag) ? flag : 'given'}`);
    }
  }
  /* Every act this command performs names the operator who performed it, and --apply without one is refused
     before anything is opened (design 3.5 step 1). */
  if (a.operator === undefined) refuse(`${verb} needs --operator: every act it records names who performed it`);
  if (ATTESTING.includes(verb) && a.closedTarget !== true)
    refuse(
      `${verb} needs --closed-target: the runner attests that the switch is closed and the provider-side closure is in force, which this command cannot observe from SQL`,
    );
  if (verb === 'begin' && a.backupAt === undefined) refuse('begin needs --backup-at, the backup’s point in time');
  if (GATED.includes(verb) && a.anchoredHead === undefined)
    refuse(`${verb} needs --anchored-head, the head recorded in the company workspace (gate 1)`);
  if (verb === 'lift') {
    if (a.company === undefined) refuse('lift needs --company');
    if (a.confirmation === undefined)
      refuse('lift needs --confirmation: the reference of the call on which the customer confirmed this company');
    if (a.anchoredHead === undefined)
      refuse(
        'lift needs --anchored-head, the head recorded in the company workspace (gate 1): a lift passes the gates plan passes',
      );
  }
  for (const [flag, verbs] of Object.entries({
    '--company': ['lift'],
    '--confirmation': ['lift'],
    '--status': ['lift'],
    '--agreement': ['lift'],
    '--backup-at': ['begin'],
    '--anchored-head': ['plan', 'apply', 'lift'],
  }))
    if (!verbs.includes(verb) && a[flag.slice(2).replace('-at', 'At').replace('-head', 'Head')] !== undefined)
      refuse(`${flag} belongs to ${verbs.join(' and ')}`);
  if (verb !== 'lift' && (a.remove.length > 0 || Object.keys(a.roles).length > 0 || a.withdrawnBy !== undefined))
    refuse('--remove, --roles and --withdrawn-by belong to lift, which is where the customer’s confirmation is');
  return a;
}

/* The register path, the store and the lock are the register module's: one rule with one home, and four scripts
   hold this file. */
function registerPath() {
  try {
    return checkRegisterPath(process.env.ENTERPRISE_REGISTER_PATH);
  } catch (e) {
    if (!(e instanceof RegisterError)) throw e;
    refuse(e.rule);
  }
}

/** The register as it stands: verified or not, folded either way when it parses at all. */
function readRegister(store, { anchoredHead, copy } = {}) {
  const text = store.read();
  if (text === null)
    return {
      exists: false,
      ok: false,
      problems: [{ rule: 'the register does not exist' }],
      folded: fold([]),
      copies: null,
    };
  const state = verify(text, { localHead: store.readHead(), anchoredHead });
  let copies = null;
  const problems = [...state.problems];
  if (copy !== undefined) {
    if (!existsSync(copy)) problems.push({ rule: 'the workspace copy does not exist' });
    else {
      copies = compareCopies(text, readFileSync(copy, 'utf8')).relation;
      if (copies === 'fork') problems.push({ rule: 'the two copies FORK' });
    }
  }
  return { exists: true, ok: problems.length === 0, problems, folded: fold(state.lines), state, copies };
}

const refuseRegister = (problems) => {
  throw new Refusal(
    1,
    problems.map((p) =>
      JSON.stringify({ event: 'register_refused', rule: p.rule, ...(p.at === undefined ? {} : { at: p.at }) }),
    ),
  );
};

// ---------------------------------------------------------------------------
// The owner-side reads. Every one of them is read only.
// ---------------------------------------------------------------------------

function marked(answer) {
  const lines = answer.split('\n').filter((l) => l.startsWith(MARK));
  if (lines.length !== 1) throw outputFailure();
  try {
    return JSON.parse(lines[0].slice(MARK.length));
  } catch {
    throw outputFailure();
  }
}

/* Defence in depth, not the rule: these ids come from a register this command has already VERIFIED, and
   verification re-checks every line against the act's own shapes, so a value that is not a uuid cannot reach
   here. One check costs nothing and makes that argument local. */
const uuidList = (ids) => {
  for (const id of ids) if (!isUuid(id)) throw new ReconcileError('not a lowercase uuid', { key: 'userId' });
  return ids.map((id) => `'${id}'`).join(', ');
};

/**
 * The database's state, in one repeatable-read read-only snapshot: every company with its period, memberships,
 * published releases and pending invitations; the factors and accounts THE REGISTER NAMES and no others, because
 * nothing else is any of this command's business.
 *
 * holdStatusBefore is the status C0 recorded when it held the company, which is what the lift restores the
 * narrower of. It is read from the company's own latest company.hold audit row.
 */
function readState(userIds) {
  const accounts =
    userIds.length === 0
      ? "'[]'::jsonb"
      : `coalesce((select jsonb_agg(jsonb_build_object('userId', u.id, 'memberships',
           (select count(*) from app.memberships m where m.user_id = u.id)) order by u.id)
         from auth.users u where u.id in (${uuidList(userIds)})), '[]'::jsonb)`;
  const factors =
    userIds.length === 0
      ? "'[]'::jsonb"
      : `coalesce((select jsonb_agg(jsonb_build_object('userId', f.user_id, 'factorId', f.id) order by f.id)
         from auth.mfa_factors f where f.user_id in (${uuidList(userIds)})), '[]'::jsonb)`;
  const sql = `begin isolation level repeatable read read only;
select '${MARK}' || jsonb_build_object(
  'companies', coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'slug', c.slug, 'status', c.status,
      'holdStatusBefore', (select a.details->>'status_before' from app.audit_events a
                            where a.company_id = c.id and a.action = 'company.hold' order by a.id desc limit 1),
      'period', (select jsonb_build_object('startsAt', p.starts_at, 'endsAt', p.ends_at,
                                           'exportBy', p.export_by, 'deleteBy', p.delete_by)
                   from app.access_periods p where p.company_id = c.id),
      'memberships', coalesce((select jsonb_agg(jsonb_build_object(
                        'id', m.id, 'userId', m.user_id, 'status', m.status, 'roles', to_jsonb(m.roles))
                        order by m.id) from app.memberships m where m.company_id = c.id), '[]'::jsonb),
      'releases', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'state', r.state) order by r.id)
                     from app.releases r where r.company_id = c.id and r.state = 'published'), '[]'::jsonb),
      'invitationsPending', coalesce((select jsonb_agg(i.id order by i.id) from app.invitations i
                     where i.company_id = c.id and i.accepted_at is null and i.revoked_at is null), '[]'::jsonb))
      order by c.id) from app.companies c), '[]'::jsonb),
  'factors', ${factors},
  'accounts', ${accounts},
  'auditMax', (select coalesce(max(id), 0) from app.audit_events))::text;
commit;`;
  const answer = marked(ownerQuery(sql));
  if (answer === null || typeof answer !== 'object' || !Array.isArray(answer.companies)) throw outputFailure();
  return answer;
}

/** The operator is a row of app.operators (design 3.5 step 4). */
function requireOperator(operator) {
  const answer = ownerQuery(`select count(*) from app.operators where user_id = '${operator}';`);
  if (answer !== '1') throw new Refusal(1, ['reconcile: --operator is not a row of app.operators']);
}

/**
 * The confirmation list, and the ONE read in this command that touches personal data. It is called only when
 * standard output is a terminal, so at every other moment the addresses are not read at all, let alone printed.
 * Nothing here is returned to a caller that writes a file (design 1.3, 3.1).
 */
function readAddresses(companyId) {
  const sql = `select '${MARK}' || coalesce((select jsonb_agg(jsonb_build_object(
    'membershipId', m.id, 'roles', to_jsonb(m.roles), 'address', u.email) order by m.id)
  from app.memberships m join auth.users u on u.id = m.user_id
  where m.company_id = '${companyId}' and m.status = 'active'), '[]'::jsonb)::text;`;
  const list = marked(ownerQuery(sql));
  if (!Array.isArray(list)) throw outputFailure();
  return list;
}

// ---------------------------------------------------------------------------
// Running a correction.
// ---------------------------------------------------------------------------

/** One correction, one transaction. ON_ERROR_STOP means a failure ends the session before `commit`, so the
 *  statements before it roll back and neither the state change nor its audit row survives. */
function runCorrection(correction) {
  ownerQuery(transactionSql(correction));
  out({
    event: 'apply_correction',
    correction: correction.id,
    kind: correction.kind,
    companyId: correction.companyId,
    ...(correction.membershipId === undefined ? {} : { membershipId: correction.membershipId }),
    ...(correction.releaseId === undefined ? {} : { releaseId: correction.releaseId }),
    ...(correction.invitationId === undefined ? {} : { invitationId: correction.invitationId }),
    statements: correctionStatements(correction).length,
  });
}

const printCorrection = (c) =>
  out({
    event: 'plan_correction',
    correction: c.id,
    kind: c.kind,
    companyId: c.companyId,
    ...(c.membershipId === undefined ? {} : { membershipId: c.membershipId }),
    ...(c.releaseId === undefined ? {} : { releaseId: c.releaseId }),
    ...(c.invitationId === undefined ? {} : { invitationId: c.invitationId }),
    ...(c.rolesAfter === undefined ? {} : { rolesAfter: c.rolesAfter }),
    ...(c.direction === undefined ? {} : { direction: c.direction }),
    ...(c.statusAfter === undefined ? {} : { statusAfter: c.statusAfter }),
    statements: correctionStatements(c).length,
  });

/** C1's own line: the exact command the one door is run with, which carries the slug because the door takes it
 *  as its confirmation. Printed, never written anywhere. */
function printDeletion(deletion, operator) {
  out({
    event: 'plan_deletion',
    companyId: deletion.companyId,
    reason: deletion.reason,
    rows: deletion.rows,
    hasRef: deletion.ref !== null,
  });
  const ref = deletion.ref === null ? '' : ` --instruction ${deletion.ref}`;
  say(
    `reconcile: this company is CLOSED by C1 and its rows are deleted by the one door, separately:\n` +
      `  node scripts/delete-company.mjs --company ${deletion.companyId} --slug ${deletion.slug} ` +
      `--reason ${deletion.reason}${ref} --operator ${operator} --apply`,
  );
}

/** The user ids the register names: the only accounts and factors this command reads or touches. */
const namedUsers = (folded) => Object.keys(folded.accounts);

// ---------------------------------------------------------------------------
// The verbs.
// ---------------------------------------------------------------------------

async function runBegin(args, store) {
  const register = readRegister(store);
  const folded = register.folded;

  /* A second begin in an epoch that has no restore.end refuses: a recovery is in progress and a mistaken re-run
     must not open a second epoch. THE ONE EXCEPTION is an epoch `register.mjs gap` opened, which writes
     restore.begin and deliberately does NOT move app.audit_events_id_seq or run C6 and C0 (E7S-F4): that epoch's
     database half is still owed, so begin does it and appends nothing a second time. C6 and C0 are both
     idempotent (C6 clears what is there; C0 holds what is not closed and not already held) and the floor is a
     maximum, so running the database half twice in such an epoch changes nothing. */
  const gapped = folded.gaps.some((g) => g.epoch === folded.epoch);
  if (register.ok && folded.epochOpen && !gapped)
    throw new Refusal(1, [
      'reconcile: a recovery epoch is already open and has no restore.end. A second begin cannot open a second epoch; run plan, or end when every company is lifted.',
    ]);

  requireOperator(args.operator);
  const state = readState([]);
  let highest = 0;
  /* Number.isSafeInteger and not typeof, because begin reads these lines from a register that may NOT have
     verified: what it takes from an unverified file is one number, and that number is bounded here. */
  for (const line of register.state?.lines ?? [])
    if (Number.isSafeInteger(line.auditId)) highest = Math.max(highest, line.auditId);
  /* Above BOTH maxima, and above a floor `gap` already recorded, so the epoch's floor never moves backwards. */
  const floor = Math.max(highest + 1, Number(state.auditMax) + 1, gapped ? folded.auditFloor : 0);
  const companies = state.companies.filter((c) => c.status !== 'closed' && c.status !== 'held');

  out({
    event: 'begin_plan',
    registerVerifies: register.ok,
    epoch: folded.epoch + (folded.epochOpen ? 0 : 1),
    epochOpenedByGap: gapped,
    auditFloor: floor,
    registerHighestAuditId: highest,
    tableHighestAuditId: Number(state.auditMax),
    companiesToHold: companies.length,
    companiesAlreadyHeld: state.companies.filter((c) => c.status === 'held').length,
    companiesClosed: state.companies.filter((c) => c.status === 'closed').length,
    apply: args.apply,
  });
  if (!register.ok)
    for (const p of register.problems)
      out({ event: 'register_refused', rule: p.rule, ...(p.at === undefined ? {} : { at: p.at }) });

  if (!args.apply) {
    say(
      'reconcile: a DRY RUN. Nothing was moved, ended or held. Re-run with --apply to move the sequence, run C6 and hold every company.',
    );
    return 0;
  }

  /* 1. The sequence, above every id the register holds in any epoch and the restored table's own highest. */
  ownerQuery(`select setval(pg_get_serial_sequence('app.audit_events', 'id'), ${floor}, false);`);
  out({ event: 'begin_sequence_moved', auditFloor: floor });

  /* 2. C6, first and once per epoch: every restored credential ended before anything reopens. */
  runCorrection(credentialStatements({ operator: args.operator }));

  /* 3. C0, for every company that is not closed and not already held. */
  for (const c of companies)
    runCorrection(holdCorrection({ companyId: c.id, statusBefore: c.status, operator: args.operator }));

  /* 4. The register line, when the register verifies and the epoch is not already open. */
  let head = null;
  if (register.ok && !folded.epochOpen) {
    const line = appendLine(
      store,
      'restore.begin',
      { backupAt: args.backupAt, auditFloor: floor, actor: args.operator },
      {},
    );
    head = line.head;
    out({ event: 'register_appended', act: 'restore.begin', seq: line.seq, epoch: line.line.epoch, head });
  }
  out({ event: 'begin_done', auditFloor: floor, held: companies.length, registerLine: head !== null, head });
  if (!register.ok)
    say(
      'reconcile: the register does NOT verify, so no restore.begin line was written. Recover the register or run node scripts/register.mjs gap --ref <the record of the hand reconciliation>, which writes that line with this floor.',
    );
  say('reconcile: from here nothing of the backup’s credentials or tenants is live, whatever the register says.');
  return 0;
}

function gateOrRefuse(args, register) {
  const gates = checkGates(register.folded, {
    verified: register.ok,
    problems: register.problems,
    copies: register.copies,
    anchoredHeadGiven: args.anchoredHead !== undefined,
  });
  if (!gates.ok) {
    for (const p of gates.problems)
      out({ event: 'gate_refused', gate: p.gate, rule: p.rule, ...(p.at === undefined ? {} : { at: p.at }) });
    throw new Refusal(1, [
      'reconcile: recovery does not pass its gates, so nothing is planned and EVERY COMPANY STAYS HELD. The only way on is node scripts/register.mjs gap --ref <the record of the hand reconciliation>.',
    ]);
  }
  return gates;
}

/* `only` is the lift's company: a lift prints its own company's plan, whose refusals carry every C8 and C9 the
   whole plan owes (lib/operator/reconcile.mjs, E7X-C-F8), and not every other company's. */
function printPlan(plan, operator, only = null) {
  const companies = only === null ? plan.companies : plan.companies.filter((c) => c.id === only);
  for (const company of companies) {
    out({
      event: 'plan_company',
      companyId: company.id,
      status: company.status,
      expectedStatus: company.expectedStatus,
      known: company.known,
      corrections: company.corrections.map((c) => c.id),
      refusals: company.refusals.length,
    });
    for (const c of company.corrections) {
      printCorrection(c);
      if (c.deletion !== undefined) printDeletion(c.deletion, operator);
    }
    for (const r of company.refusals) out({ event: 'plan_refusal', ...r });
  }
  if (only !== null) {
    const reports = plan.reports.filter((x) => x.companyId === only);
    for (const r of reports) out({ event: 'plan_report', ...r });
    out({
      event: 'plan_summary',
      companies: companies.length,
      corrections: companies.reduce((n, c) => n + c.corrections.length, 0),
      refusals: companies.reduce((n, c) => n + c.refusals.length, 0),
      reports: reports.length,
    });
    return;
  }
  for (const f of plan.factors)
    out({ event: 'plan_correction', correction: 'C8', kind: f.kind, userId: f.userId, factorId: f.factorId });
  for (const a of plan.accounts) out({ event: 'plan_correction', correction: 'C9', kind: a.kind, userId: a.userId });
  for (const r of plan.reports) out({ event: 'plan_report', ...r });
  out({
    event: 'plan_summary',
    companies: plan.companies.length,
    corrections: plan.counts.corrections,
    refusals: plan.counts.refusals,
    reports: plan.counts.reports,
  });
}

async function runPlanOrApply(args, store) {
  const register = readRegister(store, { anchoredHead: args.anchoredHead, copy: args.copy });
  gateOrRefuse(args, register);
  requireOperator(args.operator);
  const state = readState(namedUsers(register.folded));
  const plan = foldToPlan(register.folded, state, { operator: args.operator });
  printPlan(plan, args.operator);
  if (!args.apply) {
    say(
      'reconcile: a PLAN. Nothing was written. Every refusal above keeps its company held until its named way out is taken.',
    );
    return 0;
  }

  for (const company of plan.companies) for (const c of company.corrections) runCorrection(c);
  await runAccountCorrections(args, store, plan);
  out({
    event: 'apply_summary',
    corrections: plan.counts.corrections,
    refusals: plan.counts.refusals,
    companiesHeld: plan.companies.filter((c) => c.status === 'held').length,
  });
  say('reconcile: applied. Run plan again; what is left is what each company’s customer has to confirm at its lift.');
  return 0;
}

/**
 * C8 and C9. NOT database transactions, because GoTrue owns what they delete: the audit row is written only after
 * GoTrue answered success, so the audit never claims a deletion that did not happen, and a run interrupted between
 * the two leaves a deletion unrecorded, which is E6D-C-F13's known debt, carried and not widened.
 *
 * C8 APPENDS ITS OWN REGISTER LINE (E7S-F5, the lead's decision of 2026-09-20): 008's audit guard admits no
 * factor_id key and no migration adds one, so the audit row names the user alone and the factor id lives in the
 * register line this script writes directly, the way the other owner-side scripts write theirs (design 1.2 rule 5).
 * The sync then skips that (epoch, auditId), which is what it already does for every line the register holds.
 */
/* A GoTrue call that cannot be made at all (a refused connection, a name that does not resolve, TLS) is a
   REFUSAL like any other non-2xx answer and not a crash: nothing was deleted, so nothing is recorded, and the
   run goes on to the next id. The error itself is dropped rather than printed, because a fetch failure's message
   carries the endpoint. */
async function refusalSafe(call) {
  try {
    return await call();
  } catch {
    return 'unreachable';
  }
}

async function runAccountCorrections(args, store, plan) {
  for (const f of plan.factors) {
    const outcome = await refusalSafe(() => deleteFactor(f.userId, f.factorId));
    if (outcome !== 'deleted') {
      out({ event: 'factor_not_deleted', userId: f.userId, factorId: f.factorId, outcome });
      continue;
    }
    const answer = marked(
      ownerQuery(`begin;
${factorAuditStatement({ userId: f.userId, operator: args.operator })};
select '${MARK}' || jsonb_build_object('auditId', currval(pg_get_serial_sequence('app.audit_events', 'id')))::text;
commit;`),
    );
    const auditId = Number(answer.auditId);
    if (!Number.isSafeInteger(auditId)) throw outputFailure();
    const line = appendLine(
      store,
      'factor.delete',
      { userId: f.userId, factorId: f.factorId, auditId, actor: args.operator },
      {},
    );
    out({ event: 'factor_deleted', userId: f.userId, factorId: f.factorId, auditId, seq: line.seq });
  }

  const deleted = [];
  const record = () => {
    if (deleted.length === 0) return;
    const batch = deleted.splice(0, deleted.length);
    ownerQuery(`${sweepRecordedStatement({ operator: args.operator, userIds: batch })};`);
    out({ event: 'accounts_recorded', accounts: batch.length });
  };
  for (const a of plan.accounts) {
    const outcome = await refusalSafe(() => deleteAccount(a.userId));
    if (outcome !== 'deleted') {
      out({ event: 'account_not_deleted', userId: a.userId, outcome });
      continue;
    }
    deleted.push(a.userId);
    out({ event: 'account_deleted', userId: a.userId });
    if (deleted.length >= RECORD_BATCH) record();
  }
  record();
}

async function runLift(args, store) {
  const register = readRegister(store, { anchoredHead: args.anchoredHead, copy: args.copy });
  /* THE SAME GATES AS PLAN (E7X-C-F8). The first version checked the chain and the heads and nothing else, so a
     lift ran with no recovery epoch open and against a register older than the backup. */
  gateOrRefuse(args, register);
  requireOperator(args.operator);
  const state = readState(namedUsers(register.folded));
  const row = state.companies.find((c) => c.id === args.company);
  if (row === undefined) throw new Refusal(1, ['reconcile: no such company']);
  if (row.status !== 'held') {
    out({ event: 'lift_skipped', companyId: args.company, status: row.status });
    say('reconcile: this company is not held, so there is nothing to lift and NOTHING WAS WRITTEN.');
    return 0;
  }

  const lift = {
    companyId: args.company,
    remove: args.remove,
    roles: args.roles,
    withdrawnBy: args.withdrawnBy,
    agreement: args.agreement,
    confirmation: args.confirmation,
    at: new Date().toISOString(),
  };
  const plan = foldToPlan(register.folded, state, { operator: args.operator, lift });
  printPlan(plan, args.operator, args.company);
  const company = plan.companies.find((c) => c.id === args.company);
  const chosen = liftStatus(company, register.folded, args.status ?? null);
  out({
    event: 'lift_plan',
    companyId: args.company,
    statusAfter: chosen.status,
    from: chosen.from,
    widening: chosen.widening ?? false,
    ...(chosen.rule === undefined ? {} : { rule: chosen.rule }),
    corrections: company.corrections.map((c) => c.id),
    refusals: company.refusals.length,
    apply: args.apply,
  });
  if (chosen.widening)
    say(
      'reconcile: --status is WIDER than the narrower of the register and the hold. That is a grant, and it is applied only because the operator gave it on the customer’s confirmation.',
    );

  /* The confirmation list: the operator reads it to the customer's administrator on the call and compares it with
     the customer's own. TERMINAL ONLY, and when this is not a terminal the addresses are not even read. */
  if (process.stdout.isTTY) {
    for (const m of readAddresses(args.company))
      say(`  confirm  ${m.membershipId}  ${m.roles.join(',')}  ${m.address}`);
    say(
      'reconcile: the list above is printed to this terminal only. It is in no file, no register line and no report.',
    );
  } else {
    out({
      event: 'lift_addresses_withheld',
      companyId: args.company,
      rule: 'stdout is not a terminal, so the addresses were not read',
    });
  }

  if (!args.apply) {
    say('reconcile: a PLAN. Nothing was written. Re-run with --apply once the customer has confirmed the list above.');
    return 0;
  }
  if (company.refusals.length > 0 || chosen.status === null || !plan.liftable) {
    const owed = company.corrections.filter((c) => c.viaLift !== true).map((c) => c.id);
    const credentials = company.refusals.filter((r) => r.correction === 'C8' || r.correction === 'C9');
    throw new Refusal(1, [
      'reconcile: --apply refuses while any refusal remains, and while the plan holds a correction the lift itself does not apply. A company is lifted only when its plan is empty but for what the lift applies.',
      ...(owed.length === 0
        ? []
        : [`reconcile: run apply first; it owes this company ${[...new Set(owed)].join(', ')}.`]),
      ...(credentials.length === 0
        ? []
        : [
            `reconcile: the register records credentials deleted that the target still holds, owed before any lift: ${credentials.filter((r) => r.correction === 'C8').length} factor (C8) and ${credentials.filter((r) => r.correction === 'C9').length} account (C9), each named on a plan_refusal line above with its way out.`,
          ]),
    ]);
  }

  for (const c of company.corrections) runCorrection(c);
  const l = liftCorrection({ companyId: args.company, statusAfter: chosen.status, operator: args.operator });
  runCorrection(l);
  const answer = marked(
    ownerQuery(
      `select '${MARK}' || jsonb_build_object('auditId', (select max(a.id) from app.audit_events a where a.company_id = '${args.company}' and a.action = 'company.hold_lift'))::text;`,
    ),
  );
  const auditId = Number(answer.auditId);
  if (!Number.isSafeInteger(auditId)) throw outputFailure();
  const line = appendLine(
    store,
    'company.hold_lift',
    {
      companyId: args.company,
      statusAfter: chosen.status,
      ref: args.confirmation,
      auditId,
      actor: args.operator,
    },
    {},
  );
  out({
    event: 'lift_done',
    companyId: args.company,
    statusAfter: chosen.status,
    auditId,
    seq: line.seq,
    head: line.head,
  });
  say(`reconcile: lifted. Record the head ${line.head} in the company workspace.`);
  return 0;
}

async function runEnd(args, store) {
  const register = readRegister(store);
  if (!register.ok) refuseRegister(register.problems);
  if (!register.folded.epochOpen)
    throw new Refusal(1, ['reconcile: no recovery epoch is open, so there is nothing to end']);
  requireOperator(args.operator);
  const state = readState([]);
  const held = state.companies.filter((c) => c.status === 'held');
  for (const c of held) out({ event: 'end_waiting', companyId: c.id });
  if (held.length > 0)
    throw new Refusal(1, [
      `reconcile: ${held.length} company or companies are still held, each waiting for its customer’s confirmation. end refuses until every one is lifted or closed.`,
    ]);
  const line = appendLine(store, 'restore.end', { actor: args.operator }, {});
  out({ event: 'end_done', epoch: line.line.epoch, seq: line.seq, head: line.head });
  say(
    `reconcile: the recovery is closed. Record the head ${line.head} in the company workspace, and run register.mjs sync then anchor.`,
  );
  return 0;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = fileStore(registerPath());
  /* One writer at a time, for every verb: plan reads the file that apply and lift write, and a plan taken while
     another writer appends is a plan of a register that no longer exists. */
  return withLock(store, async () => {
    switch (args.verb) {
      case 'begin':
        return runBegin(args, store);
      case 'lift':
        return runLift(args, store);
      case 'end':
        return runEnd(args, store);
      default:
        return runPlanOrApply(args, store);
    }
  });
}

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
    if (failure instanceof ReconcileError || failure instanceof RegisterError) {
      out({ event: 'reconcile_refused', rule: failure.rule });
      process.exit(1);
    }
    throw failure;
  }
}
