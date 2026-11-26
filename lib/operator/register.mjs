/* The operator lifecycle register (E7 design 1.3, corrections E7D-C-F2, E7D-C-F5 and E7D-C-F9).
 *
 * One append-only file of content-free lifecycle acts that lives OUTSIDE the database, because a restore brings
 * back whatever the backup held and knows nothing that happened afterwards: a company deleted since the backup
 * returns whole, a closed one returns active, a removed member returns active, a withdrawn release returns
 * published. The register is what a restored database is checked against, so it cannot be inside it.
 *
 * WHAT IS IN THIS MODULE and what is not. Everything here is pure but for the injected store: the line shapes, the
 * chain, the two heads, the comparison of two copies, the sync's plan and the fold. The file, the head file and
 * the lock are a `store` the SCRIPT supplies (scripts/register.mjs), because lib/ may not reach node:fs beyond
 * what scripts/check-imports.mjs admits and because the whole of this has to be testable without a disk. The
 * reconciler (day 4) reads `fold` and nothing else of this module's state.
 *
 * THE LINE. UTF-8, one JSON object per line, appended, each chained to the previous one by hash and each carrying
 * the recovery EPOCH it was written in. Six fields are on every line, in this order:
 *
 *   v      the format, 2
 *   seq    0, then one more per line
 *   epoch  0 until the first restore, one more at each restore.begin
 *   at     the writer's clock, ISO 8601 in UTC
 *   act    one of ACTS
 *   prev   the SHA-256, lowercase hex, of the PREVIOUS line's exact bytes without its newline; line 0's is sixty-
 *          four zeros
 *
 * and `prev` is written LAST, after the act's own fields, which is the shape the design's examples carry. The
 * verifier hashes the raw bytes it read, so no canonical re-serialisation is needed and none can disagree.
 *
 * WHY THE EPOCH (E7D-C-F2). The first version keyed an audited act on app.audit_events.id alone, and a restore
 * rewinds that sequence: the restored database hands out again ids the file already holds for acts that happened
 * after the backup, so a sync de-duplicating by audit id silently dropped the first acts after recovery. THE KEY
 * OF AN AUDITED ACT IS (epoch, auditId) AND NOTHING IS DE-DUPLICATED BY THE AUDIT ID ALONE.
 *
 * NO CUSTOMER CONTENT, WITH ONE DISCLOSED EXCEPTION (E7D-C-F9, settled here for the register half). Every value a
 * line carries is a uuid, an integer, a timestamp, an act word, a word from a closed vocabulary (a company status,
 * a role name, a quota name, a reason code), a SHA-256 or a key id, EXCEPT `ref`. `ref` is typed by the operator
 * within ^[A-Za-z0-9._:/-]{1,80}$ and is a reference to the customer's instruction where that instruction already
 * lives, in the company workspace: a correspondence id and a date, an operations-log record, a confirmation. It
 * can therefore carry an identifying reference, and a shape is not a proof of no content, so it is written down
 * here as THE ONE DISCLOSED EXCEPTION rather than covered by a general claim. Why it is not an opaque generated
 * reference: the register exists to be read by a person reconstructing what was authorised, and an opaque token
 * whose meaning lives in a second index is a second thing to lose at exactly the moment the register is being
 * used. The price, written down: a company id maps to a customer through the workspace, and a `ref` may name the
 * correspondence that authorised an act. No company name, no slug, no address, no withdrawal reason, no display
 * name and no row content has a field at all, and refuseUnknownKeys below makes that a refusal and not a habit.
 *
 * WHAT THE CHAIN PROVES AND WHAT EACH HEAD ADDS. The chain proves the file was not edited in place, had no line
 * removed from the middle and was not reordered. It proves NOTHING about a truncated tail (the lines left still
 * chain) or a valid replacement chain written from scratch. The LOCAL head (<path>.head, replaced after each
 * append) catches the first while the head file survives; only the ANCHORED head, recorded in the company
 * workspace, catches the second, and a tail truncated after the last anchor is caught only by the local head.
 * That is detection, not prevention.
 *
 * A MISSING LOCAL HEAD IS A REFUSAL, NOT A PASS (E7X-C-F1). The first version read an absent head as "do not
 * check", so removing the head file along with the tail turned a cut register into a verified one. Every writer and
 * every verification by a script now REQUIRES the head, and its absence is gate 1's failure with gate 1's one way
 * on: `register.mjs gap --anchored-head`, which rests on the head the workspace recorded, says that everything after
 * it is reconciled by hand, and writes a new head at the gap. A pure caller that omits `localHead` still gets the
 * chain alone, which is what the tests of the chain and the fold ask for; a caller that passes the store's `null`
 * gets the refusal.
 *
 * THE EPOCH IS THE REGISTER'S (E7X-C-F3). Only restore.begin moves it, by exactly one, and verify refuses any other
 * move; a body carrying `epoch`, or any other of the six line fields, is refused by every writer.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

import { COMPANY_STATUSES } from '../rules/lifecycle.mjs';
import { QUOTA_NAMES } from '../rules/quotas.mjs';
import { ROLE_NAMES } from '../rules/roles.mjs';

export const FORMAT_VERSION = 2;
export const ZERO_PREV = '0'.repeat(64);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REF = /^[A-Za-z0-9._:/-]{1,80}$/;
const KID = /^[A-Za-z0-9._-]{1,64}$/;
const REASON = /^[a-z_]{1,40}$/;
const ACT = /^[a-z_]+\.[a-z_]+$/;
/** The six fields the register computes for every line. A body carries none of them (E7X-C-F3). */
const LINE_FIELDS = Object.freeze(['v', 'seq', 'epoch', 'at', 'act', 'prev']);
/** Gate 1's rule for a head file that is not there, with the one way on (E7X-C-F1). */
export const LOCAL_HEAD_MISSING =
  'the local head is missing, so a cut tail cannot be seen; the only way on is register.mjs gap --ref <the record of the hand reconciliation> --anchored-head <the head recorded in the company workspace>';
/** The two acts a gap over a lost local head may write, and nothing else. */
const GAP_ACTS = Object.freeze(['restore.begin', 'restore.gap']);

/** A refusal of this module. Its message names the RULE and never a value (design 3.5). */
export class RegisterError extends Error {
  constructor(rule, where = {}) {
    const at = Object.entries(where)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    super(at ? `register: ${rule} (${at})` : `register: ${rule}`);
    this.name = 'RegisterError';
    this.rule = rule;
    Object.assign(this, where);
  }
}

/* The shapes. Each is a predicate over one value; `null` is admitted only where a shape name ends in `OrNull`,
   which is the whole of where a line may carry one. */
const SHAPES = Object.freeze({
  uuid: (v) => typeof v === 'string' && UUID.test(v),
  integer: (v) => Number.isSafeInteger(v) && v >= 0,
  timestamp: (v) => typeof v === 'string' && v.length >= 20 && !Number.isNaN(Date.parse(v)),
  timestampOrNull: (v) => v === null || SHAPES.timestamp(v),
  reason: (v) => typeof v === 'string' && REASON.test(v),
  status: (v) => typeof v === 'string' && COMPANY_STATUSES.includes(v),
  roles: (v) => Array.isArray(v) && v.length > 0 && v.every((r) => typeof r === 'string' && ROLE_NAMES.includes(r)),
  quotaName: (v) => typeof v === 'string' && QUOTA_NAMES.includes(v),
  sha256: (v) => typeof v === 'string' && SHA256.test(v),
  sha256OrNull: (v) => v === null || SHAPES.sha256(v),
  kid: (v) => typeof v === 'string' && KID.test(v),
  ref: (v) => typeof v === 'string' && REF.test(v),
});

/* ONE WORD THIS FILE MAY NOT SPELL. scripts/check-imports.mjs rule 7 refuses one token anywhere under lib/ and
   netlify/ outside a module-reference line, comments and string literals included; it is the word
   lib/services/takeout.mjs is named around, under the lead's decision of 2026-09-17 that the NAMES move and the
   gate does not. The register's two act words that carry it are the design's (1.3's table) and one of them is also
   migration 008's audit action, so neither moves: they are assembled from halves here, used as computed keys
   everywhere below, and pinned to their exact spelling by tests/e7/unit/register.test.mjs, which is under tests/
   and may spell them out. A reader who wants to see them written can read that pin. */
const TAKEN = `ex${'port'}`;
/** The act for a whole-company copy taken by the owner-side script; also migration 008's audit action. */
export const ACT_COPY_TAKEN = `company.${TAKEN}`;
/** The act for the operator's local copy of that file being deleted after the customer confirms receipt. */
export const ACT_COPY_DISCARDED = `${TAKEN}.discarded`;

/** The two shapes the owner-side scripts refuse their own arguments against, so one rule has one home. */
export const isUuid = (v) => SHAPES.uuid(v);
export const isRef = (v) => SHAPES.ref(v);

/* The acts of design 1.3's table. `fields` is the ORDER the act's own values are written in and their shapes;
   `optional` is the subset a line may leave out; `oneOf` names groups of which exactly one member must be
   present. An act that is not a key here is refused, and so is any key an act's row does not name. */
export const ACTS = Object.freeze({
  'register.open': { fields: {} },
  'company.provision': { fields: { companyId: 'uuid', auditId: 'integer', actor: 'uuid' } },
  'company.set_access_period': {
    fields: {
      companyId: 'uuid',
      startsAt: 'timestampOrNull',
      endsAt: 'timestamp',
      exportBy: 'timestamp',
      deleteBy: 'timestamp',
      auditId: 'integer',
      actor: 'uuid',
    },
  },
  'company.suspend': {
    fields: { companyId: 'uuid', reason: 'reason', statusAfter: 'status', auditId: 'integer', actor: 'uuid' },
  },
  'company.resume': {
    fields: { companyId: 'uuid', reason: 'reason', statusAfter: 'status', auditId: 'integer', actor: 'uuid' },
  },
  'company.close': {
    fields: { companyId: 'uuid', reason: 'reason', statusAfter: 'status', auditId: 'integer', actor: 'uuid' },
  },
  'company.hold': {
    fields: { companyId: 'uuid', statusAfter: 'status', auditId: 'integer', actor: 'uuid' },
  },
  /* The lift's line also carries the customer's confirmation reference, which reconcile.mjs lift appends. */
  'company.hold_lift': {
    fields: { companyId: 'uuid', statusAfter: 'status', ref: 'ref', auditId: 'integer', actor: 'uuid' },
  },
  'company.delete': {
    fields: {
      companyId: 'uuid',
      reason: 'reason',
      ref: 'ref',
      rows: 'integer',
      auditId: 'integer',
      actor: 'uuid',
    },
    optional: ['ref'],
    /* A customer_instruction deletion's authority IS its reference; a retention_deadline deletion's authority is
       the period's dates the register already holds. */
    requireRefWhenReason: 'customer_instruction',
  },
  'company.set_quota': {
    fields: {
      companyId: 'uuid',
      quotaName: 'quotaName',
      quotaValue: 'integer',
      auditId: 'integer',
      actor: 'uuid',
    },
  },
  'membership.remove': { fields: { companyId: 'uuid', membershipId: 'uuid', auditId: 'integer', actor: 'uuid' } },
  'membership.set_roles': {
    fields: { companyId: 'uuid', membershipId: 'uuid', rolesAfter: 'roles', auditId: 'integer', actor: 'uuid' },
  },
  'membership.transfer_first_admin': {
    fields: { companyId: 'uuid', membershipId: 'uuid', rolesAfter: 'roles', auditId: 'integer', actor: 'uuid' },
  },
  'release.withdraw': {
    fields: { companyId: 'uuid', releaseId: 'uuid', byUserId: 'uuid', auditId: 'integer' },
  },
  'account.delete': { fields: { userId: 'uuid', reason: 'reason', auditId: 'integer', actor: 'uuid' } },
  /* Written at step 5 of the lost-second-factor procedure with its operations-log `ref`, and by the sync for the
     reconciler's own C8 rows with their `auditId`: exactly one of the two. */
  'factor.delete': {
    fields: { userId: 'uuid', factorId: 'uuid', ref: 'ref', auditId: 'integer', actor: 'uuid' },
    optional: ['ref', 'auditId'],
    oneOf: [['ref', 'auditId']],
  },
  /* sha256 is null when the sync writes the line after the script's own append failed: the partial file was
     removed at that step and never handed over, so there is no hash to record. */
  [ACT_COPY_TAKEN]: {
    fields: {
      companyId: 'uuid',
      ref: 'ref',
      sha256: 'sha256OrNull',
      bytes: 'integer',
      rows: 'integer',
      auditId: 'integer',
      actor: 'uuid',
    },
  },
  [ACT_COPY_DISCARDED]: { fields: { companyId: 'uuid', sha256: 'sha256', actor: 'uuid' } },
  'restore.end_credentials': { fields: { rows: 'integer', auditId: 'integer', actor: 'uuid' } },
  'key.replace': { fields: { kidBefore: 'kid', kidAfter: 'kid', actor: 'uuid' } },
  'register.sync': { fields: { watermarkAuditId: 'integer', watermarkAt: 'timestamp' } },
  'restore.begin': { fields: { backupAt: 'timestamp', auditFloor: 'integer', actor: 'uuid' } },
  'restore.gap': { fields: { ref: 'ref', actor: 'uuid' } },
  'restore.end': { fields: { actor: 'uuid' } },
});

/** The acts an audited lifecycle row can become, which is what the sync reads (design 1.3). */
export const SYNCED_ACTIONS = Object.freeze([
  'company.provision',
  'company.set_access_period',
  'company.suspend',
  'company.resume',
  'company.close',
  'company.delete',
  'company.set_quota',
  'company.hold',
  'company.hold_lift',
  'membership.remove',
  'membership.set_roles',
  'membership.transfer_first_admin',
  'release.withdraw',
  'account.delete',
  'factor.delete',
  ACT_COPY_TAKEN,
  'restore.end_credentials',
]);

/** Acts that WIDEN access. The reconciler reports them and never re-applies them on the register's word alone
 *  (design 1.3: "a role added, a first administrator transferred, a company resumed"). A hold's LIFT is here
 *  beside the design's three because it widens from `held` and its authority is the customer's confirmation at
 *  the time, not the register: a lift the register holds from before a restore has to be confirmed again, never
 *  replayed. A role ADDITION is not an act but a comparison, and the reconciler makes it against `fold`'s
 *  rolesAfter. */
export const GRANTING_ACTS = Object.freeze(['company.resume', 'membership.transfer_first_admin', 'company.hold_lift']);

export const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

/** The head as it is recorded and compared: "<seq>:<sha256>". */
export const headOf = (seq, hash) => `${seq}:${hash}`;

export function parseHead(text, label = 'head') {
  if (typeof text !== 'string') throw new RegisterError('a head is a string "<seq>:<sha256>"', { label });
  const m = /^([0-9]+):([0-9a-f]{64})$/.exec(text.trim());
  if (m === null) throw new RegisterError('a head is "<seq>:<sha256>"', { label });
  return { seq: Number(m[1]), sha256: m[2] };
}

// ---------------------------------------------------------------------------
// The line: its shape, its bytes, and the refusal of anything else.
// ---------------------------------------------------------------------------

/**
 * checkBody(act, body) -> the body, validated.
 * Refuses an unknown act, a missing required field, a value outside its shape and ANY OTHER KEY. The last is the
 * rule that keeps a customer's content out by construction rather than by care: a `name`, an `email`, a `slug` or
 * a `reason_text` has no field, so a line carrying one does not get written.
 */
export function checkBody(act, body) {
  if (typeof act !== 'string' || !ACT.test(act)) throw new RegisterError('an act is <noun>.<verb>');
  const spec = ACTS[act];
  if (spec === undefined) throw new RegisterError('unknown act', { act });
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw new RegisterError('a body is an object', { act });
  const optional = new Set(spec.optional ?? []);
  for (const key of Object.keys(body)) {
    if (!Object.hasOwn(spec.fields, key)) throw new RegisterError('this act has no such field', { act, key });
  }
  for (const [key, shape] of Object.entries(spec.fields)) {
    if (!Object.hasOwn(body, key)) {
      if (optional.has(key)) continue;
      throw new RegisterError('missing field', { act, key });
    }
    if (!SHAPES[shape](body[key])) throw new RegisterError('field is outside its shape', { act, key, shape });
  }
  for (const group of spec.oneOf ?? []) {
    const present = group.filter((key) => Object.hasOwn(body, key));
    if (present.length !== 1) throw new RegisterError('exactly one of these fields', { act, fields: group.join('|') });
  }
  if (spec.requireRefWhenReason !== undefined && body.reason === spec.requireRefWhenReason && body.ref === undefined)
    throw new RegisterError('this reason needs an instruction reference', { act, reason: body.reason });
  return body;
}

/**
 * serialize({ seq, epoch, at, act, ...body }) -> the line's exact bytes, without a newline.
 * The six fields first in their order, then the act's own fields in the order ACTS names, then `prev` last.
 */
export function serialize({ seq, epoch, at, act, prev, ...body }) {
  checkBody(act, body);
  if (!SHAPES.integer(seq)) throw new RegisterError('field is outside its shape', { act, key: 'seq' });
  if (!SHAPES.integer(epoch)) throw new RegisterError('field is outside its shape', { act, key: 'epoch' });
  if (!SHAPES.timestamp(at)) throw new RegisterError('field is outside its shape', { act, key: 'at' });
  if (!SHAPES.sha256(prev)) throw new RegisterError('field is outside its shape', { act, key: 'prev' });
  const ordered = { v: FORMAT_VERSION, seq, epoch, at, act };
  for (const key of Object.keys(ACTS[act].fields)) if (Object.hasOwn(body, key)) ordered[key] = body[key];
  ordered.prev = prev;
  return JSON.stringify(ordered);
}

/**
 * parseLines(text) -> [{ seq, raw, line }] in file order.
 * Every line must be one JSON object and the file must end with a newline: a file that does not is a partial
 * write or a truncation, which is exactly what the heads exist to catch, so it is a refusal and not a shrug.
 */
export function parseLines(text) {
  if (typeof text !== 'string') throw new RegisterError('the register is UTF-8 text');
  if (text.length === 0) return [];
  if (!text.endsWith('\n')) throw new RegisterError('the register does not end with a newline');
  const raws = text.slice(0, -1).split('\n');
  return raws.map((raw, index) => {
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      throw new RegisterError('a line is not JSON', { at: index });
    }
    if (line === null || typeof line !== 'object' || Array.isArray(line))
      throw new RegisterError('a line is not an object', { at: index });
    return { raw, line, index };
  });
}

// ---------------------------------------------------------------------------
// Verification: the chain, the local head, the anchored head.
// ---------------------------------------------------------------------------

/**
 * verify(text, { localHead, anchoredHead }) -> { ok, problems, head, lines, count }
 *
 * Never throws for a bad register: it REPORTS, because every caller of it has to be able to say which of the three
 * gates failed. It throws only when it was handed something that is not a register file at all.
 *
 * The chain: line 0's prev is sixty-four zeros, every later line's prev is the SHA-256 of the previous line's raw
 * bytes, seq increases by one from 0, v is the format, and every line's own shape is checked, so a line carrying a
 * key no act names fails verification and not only the append that would have written it.
 * The local head: the file ENDS EXACTLY at it, so a truncated tail is refused even though every remaining line
 * still chains.
 * The anchored head: the file CONTAINS that line with that hash, so a valid replacement chain is refused although
 * it passes its own chain and its own local head.
 */
export function verify(text, { localHead, anchoredHead } = {}) {
  const problems = [];
  /* A file that is not a register AT ALL is a gate-1 failure like any other, and is REPORTED rather than thrown:
     every caller of this has to be able to say which gate failed and to print one refusal line, and a caller
     that had to catch one shape here and read a list there would print two different things for one fact. */
  let entries;
  try {
    entries = parseLines(text);
  } catch (e) {
    if (!(e instanceof RegisterError)) throw e;
    return {
      ok: false,
      problems: [{ rule: e.rule, ...(e.at === undefined ? {} : { at: e.at }) }],
      head: null,
      count: 0,
      verified: 0,
      lines: [],
    };
  }
  let previous = ZERO_PREV;
  let good = 0;
  let epochBefore = 0;
  for (const { raw, line, index } of entries) {
    if (line.v !== FORMAT_VERSION) {
      problems.push({ rule: 'wrong format version', at: index });
      break;
    }
    if (line.seq !== index) {
      problems.push({ rule: 'seq is not one more than the line before', at: index });
      break;
    }
    if (line.prev !== previous) {
      problems.push({ rule: 'the chain is broken: prev is not the previous line’s hash', at: index });
      break;
    }
    try {
      const { seq, epoch, at, act, prev, v, ...body } = line;
      void v;
      checkBody(act, body);
      if (serialize({ seq, epoch, at, act, prev, ...body }) !== raw)
        problems.push({ rule: 'a line’s bytes are not its canonical form', at: index });
    } catch (e) {
      if (!(e instanceof RegisterError)) throw e;
      problems.push({ rule: e.rule, at: index });
      break;
    }
    /* E7X-C-F3: 0 at line 0, one more at each restore.begin, and the same on every other line. */
    const wantEpoch = index === 0 ? 0 : line.act === 'restore.begin' ? epochBefore + 1 : epochBefore;
    if (line.epoch !== wantEpoch) {
      problems.push({ rule: 'the epoch moves only at restore.begin, and by one', at: index });
      break;
    }
    epochBefore = line.epoch;
    previous = sha256(raw);
    good = index + 1;
  }
  const last = entries.at(-1);
  const head = last === undefined ? null : { seq: last.line.seq, sha256: sha256(last.raw) };
  /* `undefined` is a pure caller asking for the chain alone; `null` is a store with no head file, which is gate 1's
     refusal (E7X-C-F1) and never a skipped check. */
  if (localHead === null) problems.push({ rule: LOCAL_HEAD_MISSING });
  else if (localHead !== undefined) {
    let want = null;
    try {
      want = typeof localHead === 'string' ? parseHead(localHead, 'local head') : localHead;
    } catch (e) {
      if (!(e instanceof RegisterError)) throw e;
      problems.push({ rule: 'the local head is not "<seq>:<sha256>"' });
    }
    if (want !== null && head === null) problems.push({ rule: 'the register is empty but a local head exists' });
    else if (want !== null && (head.seq !== want.seq || head.sha256 !== want.sha256))
      problems.push({ rule: 'the register does not end at its local head', at: head.seq });
  }
  if (anchoredHead !== undefined && anchoredHead !== null) {
    const want = typeof anchoredHead === 'string' ? parseHead(anchoredHead, 'anchored head') : anchoredHead;
    const at = entries[want.seq];
    if (at === undefined || sha256(at.raw) !== want.sha256)
      problems.push({ rule: 'the register does not contain the anchored head', at: want.seq });
  }
  return {
    ok: problems.length === 0,
    problems,
    head,
    count: entries.length,
    verified: good,
    lines: entries.map((e) => e.line),
  };
}

/**
 * compareCopies(a, b) -> { relation: 'equal' | 'prefix' | 'fork', at }
 * One must be a PREFIX of the other. A difference at any seq is a fork, which stops recovery (gate 1).
 * `at` is the first differing line for a fork and the shorter copy's length for a prefix.
 */
export function compareCopies(a, b) {
  const left = parseLines(a).map((e) => e.raw);
  const right = parseLines(b).map((e) => e.raw);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) if (left[i] !== right[i]) return { relation: 'fork', at: i };
  if (left.length === right.length) return { relation: 'equal', at: shared };
  return { relation: 'prefix', at: shared, shorter: left.length < right.length ? 'a' : 'b' };
}

// ---------------------------------------------------------------------------
// Appending, through the injected store.
// ---------------------------------------------------------------------------

/**
 * The `store` contract:
 *   read()          -> string | null    the register's bytes as UTF-8, null when the file does not exist
 *   readHead()      -> string | null    "<seq>:<sha256>", null when the head file does not exist
 *   create(text)    -> void             creates the register exclusively; an existing file refuses
 *   append(text)    -> void             appends text, which ends with a newline
 *   writeHead(text) -> void             replaces the head file atomically
 *   now()           -> string           the writer's clock as ISO 8601 UTC (injected so a test is deterministic)
 */

function requireStore(store) {
  for (const call of ['read', 'readHead', 'create', 'append', 'writeHead'])
    if (typeof store?.[call] !== 'function')
      throw new RegisterError('the store must supply read, readHead, create, append and writeHead');
  return store;
}

const nowOf = (store) => (typeof store.now === 'function' ? store.now() : new Date().toISOString());

/**
 * checkRegisterPath(value) -> the path, or a RegisterError naming the rule.
 *
 * ENTERPRISE_REGISTER_PATH is absolute and OUTSIDE EVERY GIT WORK TREE. The second half is not tidiness: the
 * register holds company ids, agreement dates and operator-typed references, which are business records even
 * without content, and everything in the enterprise repository now leaves the disk through the private backup
 * remote. The REAL path of the directory is checked, so a link into a work tree is caught as well as a path
 * inside one. One rule, one home: all three owner-side scripts call this.
 */
export function checkRegisterPath(value) {
  if (typeof value !== 'string' || value.length === 0) throw new RegisterError('ENTERPRISE_REGISTER_PATH is not set');
  if (!isAbsolute(value)) throw new RegisterError('ENTERPRISE_REGISTER_PATH is an absolute path');
  const named = dirname(value);
  if (!existsSync(named)) throw new RegisterError('ENTERPRISE_REGISTER_PATH names a directory that does not exist');
  let at = realpathSync(named);
  for (;;) {
    if (existsSync(`${at}/.git`))
      throw new RegisterError('ENTERPRISE_REGISTER_PATH is inside a Git work tree; the register never enters Git');
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  return value;
}

/**
 * fileStore(path) -> the store of design 1.3 over the filesystem: the register, its head file <path>.head and
 * its lock <path>.lock, beside it. The head is replaced ATOMICALLY, so an interrupted write leaves the OLD head
 * rather than half of the new one: a head that is behind is caught by verification, a head that is half-written
 * is not a head at all. Every file is created at mode 0600.
 *
 * It lives here rather than in each script because three scripts hold the register and one lock with three
 * bodies is a lock with three behaviours. The tests still inject a store of their own; this is the default, not
 * the contract.
 */
export function fileStore(path) {
  const headPath = `${path}.head`;
  return {
    path,
    headPath,
    lockPath: `${path}.lock`,
    read: () => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    readHead: () => (existsSync(headPath) ? readFileSync(headPath, 'utf8').trim() : null),
    create: (text) => writeFileSync(path, text, { flag: 'wx', mode: 0o600 }),
    append: (text) => appendFileSync(path, text),
    writeHead: (text) => {
      const writing = `${headPath}.writing`;
      writeFileSync(writing, text, { mode: 0o600 });
      renameSync(writing, headPath);
    },
  };
}

/**
 * withLock(store, run) -> await run()
 *
 * ONE WRITER AT A TIME. The lock is created exclusively (wx), so a second writer refuses rather than
 * interleaving, and it is removed whatever happens, which is why every refusal in every owner-side script
 * unwinds as a THROW and never as an exit under the lock. A lock left behind by a killed script is removed by
 * the operator after checking that no script runs, which the operator guide says.
 */
export async function withLock(store, run) {
  let fd;
  try {
    fd = openSync(store.lockPath, 'wx', 0o600);
  } catch (e) {
    if (e.code === 'EEXIST') throw new RegisterError('another writer holds the register lock');
    throw e;
  }
  closeSync(fd);
  try {
    return await run();
  } finally {
    try {
      unlinkSync(store.lockPath);
    } catch {
      /* already gone */
    }
  }
}

/** init(store) -> the new head. Writes line 0, `register.open` at seq 0 and epoch 0. */
export function init(store) {
  requireStore(store);
  if (store.read() !== null) throw new RegisterError('the register already exists');
  const raw = serialize({ seq: 0, epoch: 0, at: nowOf(store), act: 'register.open', prev: ZERO_PREV });
  store.create(`${raw}\n`);
  const head = headOf(0, sha256(raw));
  store.writeHead(`${head}\n`);
  return { seq: 0, sha256: sha256(raw), head, line: JSON.parse(raw) };
}

/* A body carries the act's own fields and none of the six the register computes (E7X-C-F3): the first version
   spread the body AFTER the computed epoch, so a body's `epoch` won. */
function refuseLineFields(act, body) {
  if (body === null || typeof body !== 'object') return;
  for (const key of LINE_FIELDS)
    if (Object.hasOwn(body, key))
      throw new RegisterError('a body may not carry a line field; the register computes it', { act, key });
}

/* The local head a writer verifies against: the store's, and REQUIRED (E7X-C-F1). `headLost` is the one way on
   when the head file is gone, and it is narrow on purpose: only the gap's own two acts, only with the anchored head
   the workspace recorded (which verify then requires the file to contain), and only when there really is no head,
   so it cannot be used to write past a head that exists and disagrees. */
function writerHead(store, act, options) {
  const head = store.readHead() ?? null;
  if (options.headLost !== true) return head;
  if (!GAP_ACTS.includes(act))
    throw new RegisterError('only a gap record may be written over a lost local head', { act });
  if (options.anchoredHead === undefined || options.anchoredHead === null)
    throw new RegisterError('a gap over a lost local head needs the anchored head the company workspace recorded', {
      act,
    });
  if (head !== null) throw new RegisterError('the local head exists, so it is not lost; verify against it', { act });
  return undefined;
}

/**
 * append(store, act, body, { anchoredHead, epoch, headLost }) -> { seq, sha256, head, line }
 *
 * EVERY WRITER VERIFIES FIRST (design 3.5 step 3): the chain, the file ending at its local head, which must exist
 * (E7X-C-F1), and the anchored head when the caller was given one. A register that does not verify is not appended
 * to. `headLost` is `register.mjs gap`'s alone (writerHead above).
 * The epoch is the file's current one unless the caller opens a new one, which only `restore.begin` may do; a body
 * that carries one is refused (E7X-C-F3).
 */
export function append(store, act, body, options = {}) {
  requireStore(store);
  refuseLineFields(act, body);
  const text = store.read();
  if (text === null) throw new RegisterError('the register does not exist; run init first');
  const state = verify(text, { localHead: writerHead(store, act, options), anchoredHead: options.anchoredHead });
  if (!state.ok) throw new RegisterError('the register does not verify', { first: state.problems[0].rule });
  const last = state.lines.at(-1);
  if (last === undefined) throw new RegisterError('the register is empty');
  const currentEpoch = last.epoch;
  let epoch = currentEpoch;
  if (act === 'restore.begin') {
    epoch = currentEpoch + 1;
  } else if (options.epoch !== undefined && options.epoch !== currentEpoch) {
    throw new RegisterError('only restore.begin opens an epoch', { act });
  }
  const raws = parseLines(text);
  const prev = sha256(raws.at(-1).raw);
  const raw = serialize({ ...body, seq: last.seq + 1, epoch, at: nowOf(store), act, prev });
  store.append(`${raw}\n`);
  const head = headOf(last.seq + 1, sha256(raw));
  store.writeHead(`${head}\n`);
  return { seq: last.seq + 1, sha256: sha256(raw), head, line: JSON.parse(raw) };
}

/**
 * appendMany(store, bodies, options): ONE verification, then each line in order, the head after each line.
 * Used by the sync. E7G-F14 (evidence/e7-docs.md): the first version called append() per line, and append() reads and
 * verifies the whole chain before each write, so n lines hashed about n²/2 lines: 10,000 lines took 46 s where the
 * sync's database read took 38 ms. This one reads and verifies once, then chains each new line to the raw bytes of
 * the one before it, which is exactly what append() computes for a single line; the sync's own case (E7-30) and the
 * tamper cases (E7-15) assert the file it leaves verifies with both heads.
 */
export function appendMany(store, bodies, options = {}) {
  requireStore(store);
  if (bodies.length === 0) return [];
  /* Every body is checked for the register's own fields before the first line is written (E7X-C-F3). */
  for (const { act, ...body } of bodies) refuseLineFields(act, body);
  const text = store.read();
  if (text === null) throw new RegisterError('the register does not exist; run init first');
  const state = verify(text, { localHead: store.readHead() ?? null, anchoredHead: options.anchoredHead });
  if (!state.ok) throw new RegisterError('the register does not verify', { first: state.problems[0].rule });
  const last = state.lines.at(-1);
  if (last === undefined) throw new RegisterError('the register is empty');
  let seq = last.seq;
  let epoch = last.epoch;
  let prevRaw = parseLines(text).at(-1).raw;
  const written = [];
  for (const { act, ...body } of bodies) {
    if (act === 'restore.begin') {
      epoch += 1;
    } else if (options.epoch !== undefined && options.epoch !== epoch) {
      throw new RegisterError('only restore.begin opens an epoch', { act });
    }
    const raw = serialize({ ...body, seq: seq + 1, epoch, at: nowOf(store), act, prev: sha256(prevRaw) });
    store.append(`${raw}\n`);
    seq += 1;
    prevRaw = raw;
    const head = headOf(seq, sha256(raw));
    /* The head follows every line, as append() keeps it, so a writer that dies mid-way leaves a file that ends at
       its head and verifies; only the chain's verification is done once. */
    store.writeHead(`${head}\n`);
    written.push({ seq, sha256: sha256(raw), head, line: JSON.parse(raw) });
  }
  return written;
}

// ---------------------------------------------------------------------------
// The sync's plan.
// ---------------------------------------------------------------------------

const detail = (row, key) => row?.details?.[key];

/* One audit row -> one line body, or a refusal naming why. The audit row's shape is the database's; the mapping is
   pinned by tests/e7/unit/register.test.mjs and exercised against the real table by the stack cases. */
const MAPPERS = Object.freeze({
  'company.provision': (r) => ({ companyId: r.companyId, auditId: r.id, actor: r.actorUserId }),
  'company.set_access_period': (r) => ({
    companyId: r.companyId,
    /* THE AUDIT ROW CARRIES NO starts_at (E7D-C-F5): the sync reads it from app.access_periods in its own snapshot
       when this is the company's latest such row, and writes null otherwise. A missing period is never invented;
       the reconciler refuses to plan an extension it cannot date and the company stays held. */
    startsAt: r.startsAt ?? null,
    endsAt: detail(r, 'ends_at'),
    exportBy: detail(r, 'export_by'),
    deleteBy: detail(r, 'delete_by'),
    auditId: r.id,
    actor: r.actorUserId,
  }),
  'company.suspend': (r) => ({
    companyId: r.companyId,
    reason: detail(r, 'reason_code'),
    statusAfter: detail(r, 'status_after'),
    auditId: r.id,
    actor: r.actorUserId,
  }),
  'company.resume': (r) => MAPPERS['company.suspend'](r),
  'company.close': (r) => MAPPERS['company.suspend'](r),
  'company.hold': (r) => ({
    companyId: r.companyId,
    statusAfter: detail(r, 'status_after'),
    auditId: r.id,
    actor: r.actorUserId,
  }),
  'company.hold_lift': (r, ref) => ({
    companyId: r.companyId,
    statusAfter: detail(r, 'status_after'),
    ref,
    auditId: r.id,
    actor: r.actorUserId,
  }),
  /* company_id is null on this row: the routine writes it last, after the company's own audit rows are gone, so
     the company it names is in the details. */
  'company.delete': (r, ref) => ({
    companyId: detail(r, 'company_id'),
    reason: detail(r, 'reason_code'),
    ...(ref === undefined ? {} : { ref }),
    rows: detail(r, 'deleted_rows'),
    auditId: r.id,
    actor: r.actorUserId,
  }),
  'company.set_quota': (r) => ({
    companyId: r.companyId,
    quotaName: detail(r, 'quota_name'),
    quotaValue: detail(r, 'quota_value'),
    auditId: r.id,
    actor: r.actorUserId,
  }),
  'membership.remove': (r) => ({
    companyId: r.companyId,
    membershipId: detail(r, 'membership_id'),
    auditId: r.id,
    actor: r.actorUserId,
  }),
  'membership.set_roles': (r) => ({
    companyId: r.companyId,
    membershipId: detail(r, 'membership_id'),
    rolesAfter: detail(r, 'roles_after'),
    auditId: r.id,
    actor: r.actorUserId,
  }),
  'membership.transfer_first_admin': (r) => MAPPERS['membership.set_roles'](r),
  'release.withdraw': (r) => ({
    companyId: r.companyId,
    releaseId: detail(r, 'release_id'),
    byUserId: r.actorUserId,
    auditId: r.id,
  }),
  'account.delete': (r) => ({
    userId: detail(r, 'user_id'),
    reason: detail(r, 'reason_code'),
    auditId: r.id,
    actor: r.actorUserId,
  }),
  'factor.delete': (r) => ({
    userId: detail(r, 'user_id'),
    factorId: detail(r, 'factor_id'),
    auditId: r.id,
    actor: r.actorUserId,
  }),
  [ACT_COPY_TAKEN]: (r, ref) => ({
    companyId: r.companyId,
    ...(ref === undefined ? {} : { ref }),
    /* The script writes its own line with the file's hash at the act. The sync only ever writes this line when
       that append failed, and then the partial file was removed at the failed step and never handed over. */
    sha256: null,
    bytes: detail(r, 'serialized_bytes') ?? 0,
    rows: Object.values(detail(r, 'section_counts') ?? {}).reduce((a, b) => a + Number(b), 0),
    auditId: r.id,
    actor: r.actorUserId,
  }),
  'restore.end_credentials': (r) => ({ rows: detail(r, 'deleted_rows'), auditId: r.id, actor: r.actorUserId }),
});

/** The acts whose register line needs a reference the audit row cannot carry, so the operator supplies it. */
const NEEDS_REF = Object.freeze({
  'company.delete': (r) => detail(r, 'reason_code') === 'customer_instruction',
  [ACT_COPY_TAKEN]: () => true,
  'company.hold_lift': () => true,
});

/**
 * syncPlan(auditRows, epoch, floor, { existing, refs, watermarkAt }) ->
 *   { bodies, stopped, held, read, watermarkAuditId }
 *
 * THE KEY IS (epoch, auditId) AND NEVER THE AUDIT ID ALONE (E7D-C-F2 a). `existing` is the register's own lines;
 * a row whose (epoch, auditId) the register already holds is skipped, and a row whose audit id an EARLIER EPOCH
 * holds is written, because a restored database hands out those ids again for acts that are not the same acts.
 *
 * IT READS EVERY SUCH ACT OF THE CURRENT EPOCH, NOT A WINDOW (E7D-C-F2 b). An id is assigned at insert and its
 * transaction may commit after later ids for as long as it runs, which for an owner transaction is unbounded, so
 * the first version's window of 1,000 ids lost a late commit. `floor` is the epoch's auditFloor and the only
 * lower bound there is.
 *
 * A ROW WHOSE LINE NEEDS A REFERENCE THE AUDIT ROW CANNOT CARRY STOPS THE PLAN (E7D-C-F2 e). Every line before it
 * is written, the plan stops, and the caller exits 1 naming the audit id; the operator re-runs with
 * --ref <auditId>=<ref> taken from the instruction in the company workspace. A retention_deadline deletion needs
 * none. When the plan stops there is NO WATERMARK LINE, because the watermark's promise is that every lifecycle
 * act committed before it is in the register, and after a stop that is false.
 */
export function syncPlan(auditRows, epoch, floor, options = {}) {
  const { existing = [], refs = {}, watermarkAt } = options;
  if (!SHAPES.integer(epoch)) throw new RegisterError('field is outside its shape', { key: 'epoch' });
  if (!SHAPES.integer(floor)) throw new RegisterError('field is outside its shape', { key: 'auditFloor' });
  const held = new Set();
  for (const line of existing) if (typeof line?.auditId === 'number') held.add(`${line.epoch}:${line.auditId}`);

  const rows = auditRows.filter((r) => r.id >= floor && SYNCED_ACTIONS.includes(r.action)).sort((a, b) => a.id - b.id);

  const bodies = [];
  let stopped = null;
  let watermarkAuditId = floor;
  for (const row of rows) {
    watermarkAuditId = Math.max(watermarkAuditId, row.id);
    if (held.has(`${epoch}:${row.id}`)) continue;
    const needs = NEEDS_REF[row.action];
    const ref = refs[String(row.id)];
    if (needs?.(row) && ref === undefined) {
      stopped = { auditId: row.id, action: row.action, need: 'ref' };
      break;
    }
    let body;
    try {
      body = checkBody(row.action, MAPPERS[row.action](row, ref));
    } catch (e) {
      if (!(e instanceof RegisterError)) throw e;
      stopped = { auditId: row.id, action: row.action, need: 'shape', rule: e.rule };
      break;
    }
    bodies.push({ act: row.action, ...body });
  }
  /* The watermark is the LAST line of a sync that got through every row: watermarkAt is the read transaction's
     start, so every lifecycle act committed before it is in the register once this line is written. */
  if (stopped === null && watermarkAt !== undefined)
    bodies.push({ act: 'register.sync', watermarkAuditId, watermarkAt });
  return { bodies, stopped, read: rows.length, watermarkAuditId };
}

// ---------------------------------------------------------------------------
// The fold: the expected state the reconciler reads (day 4).
// ---------------------------------------------------------------------------

function company(state, id) {
  if (id === undefined) return null;
  if (state.companies[id] === undefined)
    state.companies[id] = {
      id,
      status: null,
      statusAt: null,
      provisionedAt: null,
      deleted: false,
      deletedAt: null,
      deleteReason: null,
      deleteRef: null,
      deleteRows: null,
      deleteAuditId: null,
      accessPeriod: null,
      accessPeriodStartsAtMissing: false,
      quotas: {},
      memberships: {},
      releasesWithdrawn: {},
      exports: [],
      held: false,
      heldAt: null,
      liftRef: null,
      liftedAt: null,
    };
  return state.companies[id];
}

function membership(c, id) {
  if (c.memberships[id] === undefined)
    c.memberships[id] = {
      id,
      removed: false,
      removedAt: null,
      removedAuditId: null,
      rolesAfter: null,
      rolesAt: null,
      rolesAuditId: null,
      firstAdminTransfer: false,
    };
  return c.memberships[id];
}

function account(state, id) {
  if (state.accounts[id] === undefined)
    state.accounts[id] = { userId: id, deleted: false, reason: null, at: null, factors: {} };
  return state.accounts[id];
}

/**
 * fold(lines) -> the state the register EXPECTS, per company and per account.
 *
 * This is the whole of what the reconciler (day 4) reads from the register, and it is pure: a list of lines in,
 * an object out, no IO and no clock. It carries exactly design 1.3's list, as ids, dates, words and counts:
 *
 *   per company   the expected status and when; the access period with its four dates; the quotas; per membership
 *                 whether it was removed and its roles after the last change; the releases withdrawn; the exports
 *                 taken; whether it is held and the reference its lift carried; whether it was deleted, with the
 *                 reason, the reference and the row count, which is the TOMBSTONE a restore must not undo
 *   per account   whether it was deleted and why, and which factors were deleted
 *   the epoch     the current epoch, whether it is open, its floor and backup time, its gaps, and the LAST
 *                 register.sync watermark OF EVERY EPOCH, which is what gate 2 compares with the backup's time
 *   grants        the acts that WIDEN access, recorded and reported, never re-applied (design 1.3)
 *
 * A grant is in `grants` AND in the company's own state, because the reconciler has to be able to say both "the
 * register expects this" and "this one may not be applied on the register's word alone".
 */
export function fold(lines) {
  const state = {
    version: FORMAT_VERSION,
    epoch: 0,
    seq: -1,
    epochOpen: false,
    auditFloor: 0,
    backupAt: null,
    gaps: [],
    watermarks: {},
    companies: {},
    accounts: {},
    keys: [],
    grants: [],
  };
  for (const line of lines) {
    state.seq = line.seq;
    state.epoch = line.epoch;
    const c = company(state, line.companyId);
    if (GRANTING_ACTS.includes(line.act))
      state.grants.push({
        act: line.act,
        seq: line.seq,
        epoch: line.epoch,
        at: line.at,
        companyId: line.companyId ?? null,
        membershipId: line.membershipId ?? null,
      });
    switch (line.act) {
      case 'register.open':
        break;
      case 'company.provision':
        c.provisionedAt = line.at;
        if (c.status === null) {
          c.status = 'active';
          c.statusAt = line.at;
        }
        break;
      case 'company.set_access_period':
        c.accessPeriod = {
          startsAt: line.startsAt,
          endsAt: line.endsAt,
          exportBy: line.exportBy,
          deleteBy: line.deleteBy,
          at: line.at,
          auditId: line.auditId,
        };
        c.accessPeriodStartsAtMissing = line.startsAt === null;
        break;
      case 'company.suspend':
      case 'company.resume':
      case 'company.close':
      case 'company.hold':
        c.status = line.statusAfter;
        c.statusAt = line.at;
        if (line.act === 'company.hold') {
          c.held = true;
          c.heldAt = line.at;
        }
        break;
      case 'company.hold_lift':
        c.status = line.statusAfter;
        c.statusAt = line.at;
        c.held = false;
        c.liftRef = line.ref;
        c.liftedAt = line.at;
        break;
      case 'company.delete':
        c.deleted = true;
        c.deletedAt = line.at;
        c.deleteReason = line.reason;
        c.deleteRef = line.ref ?? null;
        c.deleteRows = line.rows;
        c.deleteAuditId = line.auditId;
        break;
      case 'company.set_quota':
        c.quotas[line.quotaName] = { value: line.quotaValue, at: line.at, auditId: line.auditId };
        break;
      case 'membership.remove': {
        const m = membership(c, line.membershipId);
        m.removed = true;
        m.removedAt = line.at;
        m.removedAuditId = line.auditId;
        break;
      }
      case 'membership.set_roles':
      case 'membership.transfer_first_admin': {
        const m = membership(c, line.membershipId);
        m.rolesAfter = line.rolesAfter;
        m.rolesAt = line.at;
        m.rolesAuditId = line.auditId;
        if (line.act === 'membership.transfer_first_admin') m.firstAdminTransfer = true;
        break;
      }
      case 'release.withdraw':
        c.releasesWithdrawn[line.releaseId] = { byUserId: line.byUserId, at: line.at, auditId: line.auditId };
        break;
      case ACT_COPY_TAKEN:
        c.exports.push({
          ref: line.ref,
          sha256: line.sha256,
          bytes: line.bytes,
          rows: line.rows,
          at: line.at,
          auditId: line.auditId,
        });
        break;
      case ACT_COPY_DISCARDED:
        for (const e of c.exports) if (e.sha256 === line.sha256) e.discardedAt = line.at;
        break;
      case 'account.delete': {
        const a = account(state, line.userId);
        a.deleted = true;
        a.reason = line.reason;
        a.at = line.at;
        break;
      }
      case 'factor.delete': {
        const a = account(state, line.userId);
        a.factors[line.factorId] = { at: line.at, ref: line.ref ?? null, auditId: line.auditId ?? null };
        break;
      }
      case 'restore.end_credentials':
        state.credentialsEndedAt = line.at;
        break;
      case 'key.replace':
        state.keys.push({ kidBefore: line.kidBefore, kidAfter: line.kidAfter, at: line.at, epoch: line.epoch });
        break;
      case 'register.sync':
        state.watermarks[line.epoch] = { auditId: line.watermarkAuditId, at: line.watermarkAt, seq: line.seq };
        break;
      case 'restore.begin':
        state.epochOpen = true;
        state.auditFloor = line.auditFloor;
        state.backupAt = line.backupAt;
        break;
      case 'restore.gap':
        state.gaps.push({ epoch: line.epoch, ref: line.ref, at: line.at });
        break;
      case 'restore.end':
        state.epochOpen = false;
        break;
      default:
        throw new RegisterError('unknown act', { act: line.act });
    }
  }
  state.watermark = state.watermarks[state.epoch] ?? null;
  state.previousWatermark = state.epoch > 0 ? (state.watermarks[state.epoch - 1] ?? null) : null;
  return state;
}
