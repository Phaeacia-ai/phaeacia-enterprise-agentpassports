/* The reconciler (E7 design 1.3), pure: what a restored database has to be corrected to, and the exact statements
 * that correct it. The credential, the owner connection, GoTrue and the register file are the script's
 * (scripts/reconcile.mjs); everything here is a function of two values, the register's fold and the database's
 * state, and returns a plan.
 *
 * WHY THIS EXISTS. A restore brings back whatever the backup held and knows nothing that happened afterwards: a
 * company deleted since the backup returns whole, a closed one returns active, an extended agreement returns at
 * its old dates, a removed member returns active, a withdrawn release returns published, a reset authenticator
 * returns working, and every link token the backup held is redeemable again. The register (lib/operator/register.mjs)
 * is the record of what actually happened, kept outside the database for exactly this moment. This module folds the
 * two together.
 *
 * THE THREE RULES THAT SHAPE EVERY LINE BELOW.
 *
 * 1. NARROWING ONLY. A correction may take access away and may never give it. Resuming a company, reactivating a
 *    membership, granting a role, un-withdrawing a release and moving a company out of `closed` are never applied:
 *    they are REPORTED, and the customer's own administrator makes them through the pages after the lift, where
 *    each is an ordinary audited act. `fold`'s `grants` list is the acts that widen, and this module reads it to
 *    report and never to apply.
 * 2. A CORRECTION THAT CANNOT BE APPLIED KEEPS THE COMPANY HELD, and never suspends it instead. Suspension is not a
 *    quarantine (E7D-C-F1: app.export_admin admits an administrator of a suspended company at aal2 on purpose, so a
 *    suspended restored tenant is exportable whole). Each refusal below carries its ONE named way out, and none of
 *    them is a resume.
 * 3. ONE TRANSACTION PER CORRECTION, holding the state change and its audit row and nothing else (E2 section 5).
 *    correctionStatements() builds exactly that: begin, the lock timeout, the recovery setting where the correction
 *    needs it, the company row lock where the correction is a company's, the writes, the audit rows, commit. A
 *    correction that fails after its update therefore leaves neither the change nor an audit row, and the next
 *    correction still runs; case E7-13 builds every one of them with a raising statement AT THE SEAM, which is what
 *    the `fault` option exists for and the only thing it is for.
 *
 * WHAT THIS MODULE MAY NOT DO, and why the statements are text rather than calls. The reconciler cannot call
 * api.remove_member: that routine requires an administrator OF THE COMPANY as its actor, and impersonating one
 * would write an audit trail saying a customer's administrator removed someone at restore time, which is false. So
 * C3 carries the routine's own writes, in the routine's own lock order, and tests/e7/unit/reconcile-text.test.mjs
 * (case E7-27) reads api.remove_member's current body out of the migrations and fails when it gains or loses a
 * write C3 does not mirror. C4 and C7 need no pin of the same kind: api.withdraw_release writes the release row and
 * its audit row, and api.set_roles the membership row and its audit row, and each correction writes the same two.
 * Since migration 011 (END-1) api.remove_member and api.set_roles also revoke the pending invitations the removed or
 * demoted administrator issued, through app.revoke_issued_invitations. C3 and C7 do not mirror that, by design: C5
 * revokes EVERY pending invitation of a restored company, whoever issued it, so none survives for an issuer to use.
 * E7-27 names this as C3's second named difference.
 *
 * WHAT THE AUDIT ROWS SAY. Every one: actor_kind `operator`, the named operator, reason_code
 * `restore_reconciliation` (E2 section 5's own word), and only keys app.audit_details_guard already admits. That is
 * one deliberate difference from the routines being mirrored, which use their own member reason codes: these rows
 * were written by Phaeacia at a recovery, not by a customer's administrator, and the reason code is where a reader
 * sees that. The one exception is C9, which goes through app.sweep_recorded unchanged (design 1.3) and therefore
 * carries that function's own `unclaimed_invitation`.
 *
 * EVERY VALUE THAT ENTERS A STATEMENT IS SHAPE-CHECKED FIRST. uuids, timestamps, integers and words from closed
 * vocabularies are all this module ever interpolates, and each goes through the literal helpers below, which throw
 * rather than quote something they do not recognise. The one free-form value the whole slice carries, a `ref`, is
 * never put in SQL at all: it reaches the register line and nothing else.
 */

import { COMPANY_STATUSES } from '../rules/lifecycle.mjs';
import { ROLE_NAMES } from '../rules/roles.mjs';

/** A refusal of this module. Its message names the RULE and never a value (design 3.5). */
export class ReconcileError extends Error {
  constructor(rule, where = {}) {
    const at = Object.entries(where)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    super(at ? `reconcile: ${rule} (${at})` : `reconcile: ${rule}`);
    this.name = 'ReconcileError';
    this.rule = rule;
    Object.assign(this, where);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** E2 section 5's transaction preamble, on every correction. */
export const LOCK_TIMEOUT = "set local lock_timeout = '5s'";
/** 009's tripwire: no routine sets it and PostgREST cannot, so only an owner session moves a company into or out
 *  of `held`. C0, C1 and the lift are the three corrections that need it. */
export const RECOVERY_SETTING = "set local app.recovery_reconcile = 'on'";
/** E2 section 5's own word, on every audit row this module writes but C9's. */
export const REASON_CODE = 'restore_reconciliation';
/** app.release_immutable requires a withdrawal reason equal to app.review_reason of itself; this text is a fixed
 *  point of it (btrim of the declared-name characters, 1 to 2000 characters, no control characters). */
export const WITHDRAWAL_REASON = 'Withdrawn again by Phaeacia after a restore from backup.';

/* How narrow a company status is. The lift restores THE NARROWER of what the register expects and what C0 recorded,
   because a wider one is a grant and a grant is never re-applied on the register's word alone. */
const STATUS_RANK = Object.freeze({ active: 0, suspended: 1, held: 2, closed: 3 });
export const narrower = (a, b) => (STATUS_RANK[a] >= STATUS_RANK[b] ? a : b);

// ---------------------------------------------------------------------------
// Literals. Nothing reaches a statement except through one of these.
// ---------------------------------------------------------------------------

export function uuidLit(value, key = 'id') {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ReconcileError('not a lowercase uuid', { key });
  return `'${value}'`;
}

export function tsLit(value, key = 'at') {
  if (typeof value !== 'string' || value.length < 20 || Number.isNaN(Date.parse(value)))
    throw new ReconcileError('not a timestamp', { key });
  return `'${new Date(value).toISOString()}'::timestamptz`;
}

export function statusLit(value) {
  if (!COMPANY_STATUSES.includes(value)) throw new ReconcileError('not a company status', { key: 'status' });
  return `'${value}'`;
}

/** A role array as a PostgreSQL text[] literal, every element a word of app.role_names(). */
export function rolesArrayLit(roles) {
  if (!Array.isArray(roles) || roles.length === 0) throw new ReconcileError('not a role list', { key: 'roles' });
  for (const r of roles) if (!ROLE_NAMES.includes(r)) throw new ReconcileError('not a role name', { key: 'roles' });
  return `array[${roles.map((r) => `'${r}'`).join(', ')}]::text[]`;
}

/** The same list as the jsonb an audit row's roles_before and roles_after carry. */
export function rolesJsonLit(roles) {
  rolesArrayLit(roles);
  return `'${JSON.stringify(roles)}'::jsonb`;
}

/* One audit row. Its details are built from named keys only, each already a literal, so this function cannot be
   handed a string that becomes SQL. `entity` is null for the account-level rows, whose subject is not a uuid the
   table's entity_id can hold. */
function auditStatement({ company, operator, action, entityType, entity, details }) {
  const pairs = Object.entries(details).flatMap(([k, v]) => [`'${k}'`, v]);
  return (
    `select app.audit(${company === null ? 'null' : uuidLit(company, 'company')}, ${uuidLit(operator, 'operator')}, ` +
    `'operator', '${action}', '${entityType}', ${entity === null ? 'null' : uuidLit(entity, 'entity')}, ` +
    `jsonb_build_object(${pairs.join(', ')}))`
  );
}

// ---------------------------------------------------------------------------
// C6 and C0: what `begin` runs, before any register is trusted.
// ---------------------------------------------------------------------------

/** The six link-token columns of auth.users C6 clears, in the design's order. */
export const LINK_TOKEN_COLUMNS = Object.freeze([
  'confirmation_token',
  'recovery_token',
  'email_change_token_new',
  'email_change_token_current',
  'phone_change_token',
  'reauthentication_token',
]);

/** The token and challenge tables C6 empties, beside the two session tables it empties first. */
export const CREDENTIAL_TABLES = Object.freeze(['one_time_tokens', 'flow_state', 'mfa_challenges']);
export const SESSION_TABLES = Object.freeze(['refresh_tokens', 'sessions']);

/**
 * C6: END EVERY RESTORED CREDENTIAL (E7D-C-F3). Runs first, once per epoch, in `begin`.
 *
 * A restore brings back every link a person was sent and has since used or replaced: the backup's auth.users holds
 * the token each carried, and neither deleting sessions nor replacing a signing key consumes one, because a link is
 * exchanged at GoTrue's verify for a NEW session signed with whatever key is then current. The empty string is the
 * value GoTrue itself writes when a token is used, and it is '' rather than NULL because GoTrue reads these columns
 * as strings.
 *
 * The count is carried between the writes and the audit row in a transaction-local temporary table rather than in a
 * single combined statement, because the audit insert has to be the LAST statement of the transaction and separable
 * from the writes: that separation is the whole of E7-13's control.
 */
export function credentialStatements({ operator }) {
  const writes = [
    'create temporary table reconcile_c6_counts (source text, row_count bigint) on commit drop',
    ...SESSION_TABLES.map(
      (t) =>
        `with d as (delete from auth.${t} returning 1) insert into reconcile_c6_counts select '${t}', count(*) from d`,
    ),
    `with d as (update auth.users set ${LINK_TOKEN_COLUMNS.map((c) => `${c} = ''`).join(', ')} where ${LINK_TOKEN_COLUMNS.map(
      (c) => `${c} is distinct from ''`,
    ).join(' or ')} returning 1) insert into reconcile_c6_counts select 'users', count(*) from d`,
    ...CREDENTIAL_TABLES.map(
      (t) =>
        `with d as (delete from auth.${t} returning 1) insert into reconcile_c6_counts select '${t}', count(*) from d`,
    ),
  ];
  const audits = [
    auditStatement({
      company: null,
      operator,
      action: 'restore.end_credentials',
      entityType: 'credentials',
      entity: null,
      details: {
        deleted_rows: '(select coalesce(sum(row_count), 0)::int from reconcile_c6_counts)',
        reason_code: `'${REASON_CODE}'`,
      },
    }),
  ];
  return { id: 'C6', kind: 'credentials', companyId: null, lock: false, setting: false, writes, audits };
}

/**
 * C0: HOLD. Runs in `begin` for every company that is not `closed`, before the register is even read, because
 * holding narrows whatever the register turns out to say. A company already `held` is left alone, which is what
 * makes a second `begin` after a `gap` harmless.
 */
export function holdCorrection({ companyId, statusBefore, operator }) {
  return {
    id: 'C0',
    kind: 'hold',
    companyId,
    statusBefore,
    lock: true,
    setting: true,
    writes: [
      `update app.companies set status = 'held' where id = ${uuidLit(companyId, 'company')} and status = ${statusLit(statusBefore)}`,
    ],
    audits: [
      auditStatement({
        company: companyId,
        operator,
        action: 'company.hold',
        entityType: 'company',
        entity: companyId,
        details: {
          company_id: uuidLit(companyId, 'company'),
          status_before: statusLit(statusBefore),
          status_after: "'held'",
          reason_code: `'${REASON_CODE}'`,
        },
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// The corrections `apply` runs.
// ---------------------------------------------------------------------------

function closeCorrection({ companyId, operator }) {
  return {
    id: 'C1',
    kind: 'close',
    companyId,
    lock: true,
    setting: true,
    writes: [
      `update app.companies set status = 'closed' where id = ${uuidLit(companyId, 'company')} and status = 'held'`,
    ],
    audits: [
      auditStatement({
        company: companyId,
        operator,
        action: 'company.close',
        entityType: 'company',
        entity: companyId,
        details: {
          company_id: uuidLit(companyId, 'company'),
          status_before: "'held'",
          status_after: "'closed'",
          reason_code: `'${REASON_CODE}'`,
        },
      }),
    ],
  };
}

function periodCorrection({ companyId, operator, period, mode, direction }) {
  const dates = {
    endsAt: tsLit(period.endsAt, 'endsAt'),
    exportBy: tsLit(period.exportBy, 'exportBy'),
    deleteBy: tsLit(period.deleteBy, 'deleteBy'),
  };
  const startsAt =
    period.startsAt === null || period.startsAt === undefined ? null : tsLit(period.startsAt, 'startsAt');
  const writes =
    mode === 'insert'
      ? [
          `insert into app.access_periods (company_id, invoice_ref, starts_at, ends_at, export_by, delete_by) ` +
            `values (${uuidLit(companyId, 'company')}, null, ${startsAt}, ${dates.endsAt}, ${dates.exportBy}, ${dates.deleteBy})`,
        ]
      : [
          `update app.access_periods set ${startsAt === null ? '' : `starts_at = ${startsAt}, `}` +
            `ends_at = ${dates.endsAt}, export_by = ${dates.exportBy}, delete_by = ${dates.deleteBy}, updated_at = now() ` +
            `where company_id = ${uuidLit(companyId, 'company')}`,
        ];
  return {
    id: 'C2',
    kind: 'access_period',
    companyId,
    mode,
    direction,
    lock: true,
    setting: false,
    writes,
    audits: [
      auditStatement({
        company: companyId,
        operator,
        action: 'company.set_access_period',
        entityType: 'company',
        entity: companyId,
        details: {
          company_id: uuidLit(companyId, 'company'),
          ends_at: dates.endsAt,
          export_by: dates.exportBy,
          delete_by: dates.deleteBy,
          reason_code: `'${REASON_CODE}'`,
        },
      }),
    ],
  };
}

/**
 * C3: a membership's removal, carrying api.remove_member's own three writes (006 lines 218 to 290) in design 2.5's
 * lock order: the company row, then the membership row, then the group rows by group id, then the agent rows by id.
 * The two temporary tables carry the ids of what was actually deleted and orphaned from the writes to the audit
 * rows, so the audit rows stay the LAST statements of the transaction and still name exactly the rows that moved.
 */
function removeMembershipCorrection({ companyId, membershipId, rolesBefore, removedAt, operator }) {
  const m = uuidLit(membershipId, 'membership');
  const c = uuidLit(companyId, 'company');
  return {
    id: 'C3',
    kind: 'membership_remove',
    companyId,
    membershipId,
    lock: true,
    setting: false,
    writes: [
      'create temporary table reconcile_c3_groups (group_id uuid) on commit drop',
      'create temporary table reconcile_c3_agents (agent_id uuid) on commit drop',
      `update app.memberships set status = 'removed', removed_at = ${tsLit(removedAt, 'removedAt')} where id = ${m} and status = 'active'`,
      `select 1 from app.group_members gm where gm.company_id = ${c} and gm.membership_id = ${m} order by gm.group_id for update`,
      `with removed as (delete from app.group_members gm where gm.company_id = ${c} and gm.membership_id = ${m} returning gm.group_id) insert into reconcile_c3_groups select group_id from removed`,
      `select 1 from app.agents g where g.company_id = ${c} and g.owner_membership_id = ${m} and g.status = 'active' order by g.id for update`,
      `with orphaned as (update app.agents g set status = 'orphaned' where g.company_id = ${c} and g.owner_membership_id = ${m} and g.status = 'active' returning g.id) insert into reconcile_c3_agents select id from orphaned`,
    ],
    audits: [
      auditStatement({
        company: companyId,
        operator,
        action: 'membership.remove',
        entityType: 'membership',
        entity: membershipId,
        details: {
          membership_id: m,
          status_before: "'active'",
          status_after: "'removed'",
          roles_before: rolesJsonLit(rolesBefore),
          reason_code: `'${REASON_CODE}'`,
        },
      }),
      `select app.audit(${c}, ${uuidLit(operator, 'operator')}, 'operator', 'group.remove_member', 'group', g.group_id, ` +
        `jsonb_build_object('group_id', g.group_id, 'membership_id', ${m}, 'reason_code', '${REASON_CODE}')) ` +
        'from reconcile_c3_groups g order by g.group_id',
      `select app.audit(${c}, ${uuidLit(operator, 'operator')}, 'operator', 'agent.orphan', 'agent', a.agent_id, ` +
        `jsonb_build_object('agent_id', a.agent_id, 'membership_id', ${m}, 'agent_status_after', 'orphaned', ` +
        `'reason_code', '${REASON_CODE}')) from reconcile_c3_agents a order by a.agent_id`,
    ],
  };
}

/** C7: a role reduction, api.set_roles's one write. It NEVER adds a role: the new list is the row's own roles
 *  intersected with what the register recorded, which cannot grow. */
function reduceRolesCorrection({ companyId, membershipId, rolesBefore, rolesAfter, operator }) {
  const m = uuidLit(membershipId, 'membership');
  return {
    id: 'C7',
    kind: 'roles_reduce',
    companyId,
    membershipId,
    rolesBefore,
    rolesAfter,
    lock: true,
    setting: false,
    writes: [`update app.memberships set roles = ${rolesArrayLit(rolesAfter)} where id = ${m} and status = 'active'`],
    audits: [
      auditStatement({
        company: companyId,
        operator,
        action: 'membership.set_roles',
        entityType: 'membership',
        entity: membershipId,
        details: {
          membership_id: m,
          roles_before: rolesJsonLit(rolesBefore),
          roles_after: rolesJsonLit(rolesAfter),
          reason_code: `'${REASON_CODE}'`,
        },
      }),
    ],
  };
}

/** C4: a release's withdrawal, api.withdraw_release's one write, with the fixed reason app.release_immutable
 *  requires and the restored membership of the user the register recorded. */
function withdrawReleaseCorrection({ companyId, releaseId, membershipId, withdrawnAt, operator }) {
  const r = uuidLit(releaseId, 'release');
  return {
    id: 'C4',
    kind: 'release_withdraw',
    companyId,
    releaseId,
    membershipId,
    lock: true,
    setting: false,
    writes: [
      `update app.releases set state = 'withdrawn', withdrawn_at = ${tsLit(withdrawnAt, 'withdrawnAt')}, ` +
        `withdrawn_by_membership_id = ${uuidLit(membershipId, 'membership')}, ` +
        `withdrawal_reason = '${WITHDRAWAL_REASON}' where id = ${r} and state = 'published'`,
    ],
    audits: [
      auditStatement({
        company: companyId,
        operator,
        action: 'release.withdraw',
        entityType: 'release',
        entity: releaseId,
        details: {
          release_id: r,
          release_state_after: "'withdrawn'",
          reason_code: `'${REASON_CODE}'`,
        },
      }),
    ],
  };
}

/** C5: one pending invitation revoked, one transaction each, because every one of them is a live token the backup
 *  brought back. */
function revokeInvitationCorrection({ companyId, invitationId, operator }) {
  const i = uuidLit(invitationId, 'invitation');
  return {
    id: 'C5',
    kind: 'invitation_revoke',
    companyId,
    invitationId,
    lock: true,
    setting: false,
    writes: [
      `update app.invitations set revoked_at = now() where id = ${i} and accepted_at is null and revoked_at is null`,
    ],
    audits: [
      auditStatement({
        company: companyId,
        operator,
        action: 'invitation.revoke',
        entityType: 'invitation',
        entity: invitationId,
        details: { invitation_id: i, reason_code: `'${REASON_CODE}'` },
      }),
    ],
  };
}

/** L: the lift, the only way out of the hold. */
export function liftCorrection({ companyId, statusAfter, operator }) {
  return {
    id: 'L',
    kind: 'lift',
    companyId,
    statusAfter,
    lock: true,
    setting: true,
    writes: [
      `update app.companies set status = ${statusLit(statusAfter)} where id = ${uuidLit(companyId, 'company')} and status = 'held'`,
    ],
    audits: [
      auditStatement({
        company: companyId,
        operator,
        action: 'company.hold_lift',
        entityType: 'company',
        entity: companyId,
        details: {
          company_id: uuidLit(companyId, 'company'),
          status_before: "'held'",
          status_after: statusLit(statusAfter),
          reason_code: `'${REASON_CODE}'`,
        },
      }),
    ],
  };
}

/**
 * C8's audit row: the factor deletion GoTrue has already performed. 008's audit guard admits no `factor_id` key and
 * no migration adds one (E7S-F5, the lead's decision of 2026-09-20), so this row names the USER and not the factor,
 * and the factor id is carried by the register line the script appends beside it.
 */
export function factorAuditStatement({ userId, operator }) {
  return auditStatement({
    company: null,
    operator,
    action: 'factor.delete',
    entityType: 'factor',
    entity: null,
    details: { user_id: uuidLit(userId, 'user'), reason_code: `'${REASON_CODE}'` },
  });
}

/** C9's record, the sweep's own recorder unchanged (E6 1.5): one account.delete row per id GoTrue actually
 *  deleted. Its reason_code is that function's `unclaimed_invitation` and not this module's, which is the one
 *  audit row of the reconciler that does not say restore_reconciliation. */
export function sweepRecordedStatement({ operator, userIds }) {
  const ids = userIds.map((u) => uuidLit(u, 'user')).join(', ');
  return `select app.sweep_recorded(${uuidLit(operator, 'operator')}, array[${ids}]::uuid[])`;
}

// ---------------------------------------------------------------------------
// correctionStatements: the transaction, with the one seam E7-13 uses.
// ---------------------------------------------------------------------------

/**
 * correctionStatements(correction, { fault }) -> the statements of its ONE transaction, in order.
 *
 * `fault` is a statement spliced between the writes and the audit rows. No production caller passes it and no flag
 * reaches it: case E7-13 composes the list itself and puts a raising statement there, which is how the design's
 * probe-8c pattern is built without a fault flag existing in the product at all.
 */
export function correctionStatements(correction, options = {}) {
  const { fault } = options;
  if (correction === null || typeof correction !== 'object') throw new ReconcileError('not a correction');
  const out = ['begin', LOCK_TIMEOUT];
  if (correction.setting) out.push(RECOVERY_SETTING);
  if (correction.lock)
    out.push(`select id from app.companies where id = ${uuidLit(correction.companyId, 'company')} for no key update`);
  out.push(...correction.writes);
  if (fault !== undefined) out.push(fault);
  out.push(...correction.audits);
  out.push('commit');
  return out;
}

/** The transaction as psql reads it: one statement per line, each terminated. */
export const transactionSql = (correction, options) =>
  `${correctionStatements(correction, options)
    .map((s) => `${s};`)
    .join('\n')}\n`;

// ---------------------------------------------------------------------------
// The three gates a recovery passes (design 1.3).
// ---------------------------------------------------------------------------

/**
 * checkGates(folded, { verified, problems, copies, anchoredHeadGiven, backupAt }) -> { ok, problems }
 *
 * Gate 1 VERIFIED: the chain, the local head, the anchored head and the two copies' agreement. A register that is
 * lost, forked or rewritten STOPS recovery; `plan` and `apply` refuse and every company stays held.
 * Gate 2 NOT OLDER THAN THE BACKUP: the PREVIOUS epoch's last watermark is at or after the backup's point in time.
 * A register older than the backup can tell the reconciler nothing the backup does not already say.
 * The only way past either is `register.mjs gap --ref`, which records that the interval is being reconciled by hand
 * from the customers' confirmations; a gap line of THIS epoch satisfies both.
 * Gate 3 CONFIRMED is not here: it is every company's own lift, because the interval between the watermark and the
 * incident is unrecorded by construction.
 */
export function checkGates(folded, state = {}) {
  const { verified = false, problems = [], copies = null, anchoredHeadGiven = false, backupAt = null } = state;
  const found = [];
  const gapped = folded.gaps.some((g) => g.epoch === folded.epoch);
  if (!verified)
    for (const p of problems) found.push({ gate: 1, rule: p.rule, ...(p.at === undefined ? {} : { at: p.at }) });
  if (!anchoredHeadGiven)
    found.push({ gate: 1, rule: 'plan and apply need --anchored-head, the head recorded in the company workspace' });
  if (copies === 'fork') found.push({ gate: 1, rule: 'the two copies FORK' });
  if (!folded.epochOpen) found.push({ gate: 2, rule: 'no recovery epoch is open; run begin first' });
  const at = backupAt ?? folded.backupAt;
  if (at === null || at === undefined) found.push({ gate: 2, rule: 'the open epoch records no backup time' });
  else if (!gapped) {
    const watermark = folded.previousWatermark;
    if (watermark === null)
      found.push({
        gate: 2,
        rule: 'the epoch before this one ended with no watermark; the only way on is register.mjs gap --ref',
      });
    else if (Date.parse(watermark.at) < Date.parse(at))
      found.push({ gate: 2, rule: 'the register is OLDER than the backup; the only way on is register.mjs gap --ref' });
  }
  return { ok: found.length === 0, problems: found, gapped };
}

// ---------------------------------------------------------------------------
// The plan.
// ---------------------------------------------------------------------------

const asList = (v) => (Array.isArray(v) ? v : Object.values(v ?? {}));

/* The database's state, normalised. The script reads it over the owner connection; a test hands it in directly. */
function readCompanies(dbState) {
  const out = new Map();
  for (const c of asList(dbState.companies)) {
    const memberships = new Map();
    for (const m of asList(c.memberships))
      memberships.set(m.id, { id: m.id, userId: m.userId, status: m.status, roles: [...m.roles] });
    out.set(c.id, {
      id: c.id,
      slug: c.slug ?? null,
      status: c.status,
      holdStatusBefore: c.holdStatusBefore ?? null,
      period: c.period ?? null,
      memberships,
      releases: new Map(asList(c.releases).map((r) => [r.id, { id: r.id, state: r.state }])),
      invitationsPending: [...(c.invitationsPending ?? [])],
    });
  }
  return out;
}

const activeAdmins = (memberships, exclude = null) =>
  [...memberships.values()].filter(
    (m) => m.id !== exclude && m.status === 'active' && m.roles.includes('company_admin'),
  ).length;

/** The four dates a period needs before it can be written at all. A missing one is refused, never invented. */
const wholePeriod = (p) =>
  p !== null && p !== undefined && [p.startsAt, p.endsAt, p.exportBy, p.deleteBy].every((d) => typeof d === 'string');

/* Which direction a period difference goes, DATE BY DATE (E7X-C-F7). Each date that differs narrows or widens on
   its own: an end date (endsAt, exportBy, deleteBy) narrows when the fold's is EARLIER, the start when the fold's is
   LATER. Every differing date narrowing is a narrowing and is applied; every one widening is an extension recorded
   after the backup, which is an authorized recovery backed by the current agreement and is applied only at the lift
   (E7D-C-F5). A MIX of the two is neither, and the design defines no correction for it, so it is `mixed` and
   refused. The first version let the first differing date decide for all four, as one tuple, so a fold with an
   earlier endsAt and a later exportBy was planned as a narrowing whose statement wrote the later exportBy. */
function periodDirection(expected, actual) {
  const moves = new Set();
  for (const key of ['endsAt', 'exportBy', 'deleteBy']) {
    const a = Date.parse(expected[key]);
    const b = Date.parse(actual[key]);
    if (a < b) moves.add('narrowing');
    else if (a > b) moves.add('agreement_recovery');
  }
  if (expected.startsAt !== null && expected.startsAt !== undefined) {
    const a = Date.parse(expected.startsAt);
    const b = Date.parse(actual.startsAt);
    if (a > b) moves.add('narrowing');
    else if (a < b) moves.add('agreement_recovery');
  }
  if (moves.size === 0) return 'same';
  return moves.size === 1 ? [...moves][0] : 'mixed';
}

/**
 * foldToPlan(folded, dbState, { operator, lift }) -> the plan.
 *
 * Per company, in the design's order: C1, C2, C3, C7, C4, C5, each only where the DATABASE'S CURRENT STATE still
 * asks for it, which is what makes a second run plan nothing and an interrupted run continue. Then the account-level
 * C8 and C9 from the fold's factor and account deletions.
 *
 * `lift` carries one company's customer confirmation: the narrowing acts it may apply (`remove`, `roles`,
 * `withdrawnBy`, `agreement`), which reach THAT company and no other, and the status the operator gives
 * (`status`). The lift's own company must plan nothing but those, which is what `liftable` says.
 *
 * A LIFT PLANS THE WHOLE RECOVERY, NOT ONE COMPANY (E7X-C-F8). The first version planned the lifted company alone,
 * and C8 and C9 are not a company's: its plan dropped every factor and account deletion the register records, so a
 * lift reopened a company whose administrator's recorded-deleted factor was still live at the target (the
 * critique's stack probe: that factor verified again at aal2 after the lift and the administrator exported). The
 * plan is now the one `plan` prints, and the lifted company additionally carries, as refusals:
 *   - every C8 and every C9 the plan holds, WHOEVER THE USER IS. Each is work `apply` can do at once, a lift is not a
 *     way to skip `apply`, and a deletion owed to a user with no membership in any held company would otherwise
 *     hold no lift at all, so `end` would close the epoch with it undone and plan and apply would never run again;
 *   - an account the register records deleted that still holds an ACTIVE membership in THIS company once the lift's
 *     own removals are planned (reported to `plan` as account_held, not yet applicable). The same state for
 *     another company's member does not hold this lift: it becomes applicable only after an act of that company,
 *     its deletion re-applied or its own customer's --remove, and the account reaches nothing here.
 */
export function foldToPlan(folded, dbState, options = {}) {
  const { operator, lift = null } = options;
  if (typeof operator !== 'string' || !UUID.test(operator)) throw new ReconcileError('an operator is a lowercase uuid');
  const actual = readCompanies(dbState);
  const companies = [];
  const reports = [];
  const liftId = lift === null ? null : lift.companyId;
  /* The users holding an active membership in the lifted company once its corrections are planned. */
  let liftMembers = new Set();

  for (const [id, row] of actual) {
    /* The lift's options are the customer's confirmation for ITS company; every other company is planned as
       `plan` plans it. */
    const own = id === liftId ? lift : null;
    const expected = folded.companies[id] ?? null;
    const corrections = [];
    const refusals = [];
    const notes = [];
    /* The working copy: corrections are planned against the state the corrections before them leave, so the
       last-administrator rule sees the removal planned two lines above it and not only the restored row. */
    const memberships = new Map([...row.memberships].map(([k, m]) => [k, { ...m, roles: [...m.roles] }]));

    if (expected === null) {
      reports.push({ kind: 'company_unknown', companyId: id, rule: 'the register does not know this company' });
      notes.push('the register does not know this company: it is held until --status on the customer’s confirmation');
    }

    /* C1. The register says closed, or records the deletion the restore undid. A deleted company is CLOSED here and
       its rows are deleted by the one door, separately, with the register's own reason and reference. */
    if (expected !== null && (expected.deleted || expected.status === 'closed') && row.status === 'held') {
      const c1 = closeCorrection({ companyId: id, operator });
      if (expected.deleted)
        c1.deletion = {
          companyId: id,
          slug: row.slug,
          reason: expected.deleteReason,
          ref: expected.deleteRef,
          rows: expected.deleteRows,
        };
      corrections.push(c1);
    }

    /* C2. The access period. */
    if (expected !== null && expected.accessPeriod !== null && !expected.deleted && expected.status !== 'closed') {
      const want = expected.accessPeriod;
      if (row.period === null) {
        if (wholePeriod(want))
          corrections.push(
            periodCorrection({ companyId: id, operator, period: want, mode: 'insert', direction: 'insert' }),
          );
        else
          refusals.push({
            correction: 'C2',
            companyId: id,
            rule: 'the register cannot date this access period, and a missing period is never invented',
            wayOut: 'api.set_access_period from the current agreement, or lift --agreement <ref>',
          });
      } else {
        const direction = periodDirection(want, row.period);
        if (direction === 'narrowing')
          corrections.push(periodCorrection({ companyId: id, operator, period: want, mode: 'update', direction }));
        else if (direction === 'mixed')
          refusals.push({
            correction: 'C2',
            companyId: id,
            rule: 'the register’s period is earlier on some dates and later on others than the restored one, which is neither a narrowing nor an extension',
            wayOut: 'api.set_access_period from the current agreement, then plan again',
          });
        else if (direction === 'agreement_recovery') {
          const agreement = own?.agreement;
          if (agreement === undefined || agreement === null)
            refusals.push({
              correction: 'C2',
              companyId: id,
              rule: 'the register records an extension made after the backup, which is an authorized recovery and not a narrowing',
              wayOut: 'lift --agreement <the current agreement’s reference>',
            });
          else {
            const c2 = periodCorrection({ companyId: id, operator, period: want, mode: 'update', direction });
            c2.agreement = agreement;
            c2.viaLift = true;
            corrections.push(c2);
          }
        }
      }
    }

    /* C3. Every membership the register removed whose restored row is active. */
    if (expected !== null)
      for (const m of Object.values(expected.memberships)) {
        if (!m.removed) continue;
        const row2 = memberships.get(m.id);
        if (row2 === undefined || row2.status !== 'active') continue;
        if (row2.roles.includes('company_admin') && activeAdmins(memberships, m.id) === 0) {
          refusals.push({
            correction: 'C3',
            companyId: id,
            membershipId: m.id,
            rule: 'this removal would leave the company without an active administrator',
            wayOut: 'api.transfer_first_admin to the member the customer confirms, then apply again',
          });
          continue;
        }
        corrections.push(
          removeMembershipCorrection({
            companyId: id,
            membershipId: m.id,
            rolesBefore: row2.roles,
            removedAt: m.removedAt,
            operator,
          }),
        );
        row2.status = 'removed';
      }

    /* The lift's own removals, which the customer confirmed on the call: C3's statements for a membership the
       register does not know about, never a reactivation. */
    for (const membershipId of own?.remove ?? []) {
      const row2 = memberships.get(membershipId);
      if (row2 === undefined) {
        refusals.push({
          correction: 'C3',
          companyId: id,
          membershipId,
          rule: 'no such membership in this company',
          wayOut: 'check the membership id against the plan’s list',
        });
        continue;
      }
      if (row2.status !== 'active') continue;
      if (row2.roles.includes('company_admin') && activeAdmins(memberships, membershipId) === 0) {
        refusals.push({
          correction: 'C3',
          companyId: id,
          membershipId,
          rule: 'this removal would leave the company without an active administrator',
          wayOut: 'api.transfer_first_admin to the member the customer confirms, then lift again',
        });
        continue;
      }
      const removal = removeMembershipCorrection({
        companyId: id,
        membershipId,
        rolesBefore: row2.roles,
        removedAt: own.at,
        operator,
      });
      removal.viaLift = true;
      corrections.push(removal);
      row2.status = 'removed';
    }

    /* C7. A role reduction. Never an addition: what the register holds beyond the row's roles is REPORTED. */
    if (expected !== null)
      for (const m of Object.values(expected.memberships)) {
        if (m.rolesAfter === null) continue;
        const row2 = memberships.get(m.id);
        if (row2 === undefined || row2.status !== 'active') continue;
        const added = m.rolesAfter.filter((r) => !row2.roles.includes(r));
        if (added.length > 0)
          reports.push({
            kind: 'role_added',
            companyId: id,
            membershipId: m.id,
            rule: 'the register holds a role the restored row lacks; a grant is never re-applied',
          });
        const next = row2.roles.filter((r) => m.rolesAfter.includes(r) || r === 'member');
        if (next.length === row2.roles.length) continue;
        if (
          row2.roles.includes('company_admin') &&
          !next.includes('company_admin') &&
          activeAdmins(memberships, m.id) === 0
        ) {
          refusals.push({
            correction: 'C7',
            companyId: id,
            membershipId: m.id,
            rule: 'this reduction would leave the company without an active administrator',
            wayOut: 'api.transfer_first_admin to the member the customer confirms, then apply again',
          });
          continue;
        }
        corrections.push(
          reduceRolesCorrection({
            companyId: id,
            membershipId: m.id,
            rolesBefore: row2.roles,
            rolesAfter: next,
            operator,
          }),
        );
        row2.roles = next;
      }

    /* The lift's own reductions, the same rule: what the customer says is gone is taken away, and nothing is given. */
    for (const [membershipId, roles] of Object.entries(own?.roles ?? {})) {
      const row2 = memberships.get(membershipId);
      if (row2 === undefined || row2.status !== 'active') {
        refusals.push({
          correction: 'C7',
          companyId: id,
          membershipId,
          rule: 'no such active membership in this company',
          wayOut: 'check the membership id against the plan’s list',
        });
        continue;
      }
      const added = roles.filter((r) => !row2.roles.includes(r));
      if (added.length > 0) {
        refusals.push({
          correction: 'C7',
          companyId: id,
          membershipId,
          rule: '--roles may only take a role away; a role to grant waits for the customer’s administrator after the lift',
          wayOut: 'drop the added role from --roles; the administrator grants it through the pages',
        });
        continue;
      }
      const next = row2.roles.filter((r) => roles.includes(r) || r === 'member');
      if (next.length === row2.roles.length) continue;
      if (
        row2.roles.includes('company_admin') &&
        !next.includes('company_admin') &&
        activeAdmins(memberships, membershipId) === 0
      ) {
        refusals.push({
          correction: 'C7',
          companyId: id,
          membershipId,
          rule: 'this reduction would leave the company without an active administrator',
          wayOut: 'api.transfer_first_admin to the member the customer confirms, then lift again',
        });
        continue;
      }
      const reduction = reduceRolesCorrection({
        companyId: id,
        membershipId,
        rolesBefore: row2.roles,
        rolesAfter: next,
        operator,
      });
      reduction.viaLift = true;
      corrections.push(reduction);
      row2.roles = next;
    }

    /* C4. A release the register withdrew whose restored row is published again. */
    if (expected !== null)
      for (const [releaseId, w] of Object.entries(expected.releasesWithdrawn)) {
        const release = row.releases.get(releaseId);
        if (release === undefined || release.state !== 'published') continue;
        const byUser = [...memberships.values()].find((m) => m.userId === w.byUserId);
        const attributed = byUser?.id ?? own?.withdrawnBy ?? null;
        if (attributed === null) {
          refusals.push({
            correction: 'C4',
            companyId: id,
            releaseId,
            rule: 'the user the register recorded has no restored membership in this company',
            wayOut: 'lift --withdrawn-by <the membership of the administrator who confirmed the withdrawal>',
          });
          continue;
        }
        if (byUser === undefined && memberships.get(attributed) === undefined) {
          refusals.push({
            correction: 'C4',
            companyId: id,
            releaseId,
            rule: '--withdrawn-by names no membership of this company',
            wayOut: 'give a membership id from the plan’s list',
          });
          continue;
        }
        const withdrawal = withdrawReleaseCorrection({
          companyId: id,
          releaseId,
          membershipId: attributed,
          withdrawnAt: w.at,
          operator,
        });
        /* Only where the LIFT's option is what made it possible: a withdrawal the register can attribute by
           itself is `apply`'s work and not the lift's. */
        if (byUser === undefined) withdrawal.viaLift = true;
        corrections.push(withdrawal);
      }

    /* C5. Every pending invitation, whatever the register says: each is a token the backup brought back. */
    for (const invitationId of row.invitationsPending)
      corrections.push(revokeInvitationCorrection({ companyId: id, invitationId, operator }));

    /* The widenings the register itself holds, reported and never applied. */
    if (expected !== null)
      for (const grant of folded.grants.filter((g) => g.companyId === id))
        reports.push({
          kind: 'widening',
          companyId: id,
          act: grant.act,
          membershipId: grant.membershipId,
          seq: grant.seq,
          rule: 'a widening is reported and never re-applied on the register’s word alone',
        });

    companies.push({
      id,
      status: row.status,
      expectedStatus: expected?.status ?? null,
      expectedDeleted: expected?.deleted ?? false,
      holdStatusBefore: row.holdStatusBefore,
      corrections,
      refusals,
      notes,
      known: expected !== null,
    });
    if (id === liftId)
      liftMembers = new Set([...memberships.values()].filter((m) => m.status === 'active').map((m) => m.userId));
  }

  /* A company the register knows and the database lacks: created after the backup, reported and never invented. */
  for (const [id, expected] of Object.entries(folded.companies)) {
    if (actual.has(id) || expected.deleted) continue;
    reports.push({
      kind: 'company_missing',
      companyId: id,
      rule: 'the register knows this company and the restored database lacks it; it is re-onboarded and its customer told',
    });
  }

  /* C8 and C9, which are not database transactions: GoTrue owns what they delete, so the audit row is written only
     after GoTrue has answered success (the sweep's rule, E6D-C-F13's known bound carried and not widened). */
  const factors = [];
  const accounts = [];
  const held = [];
  const present = new Set(asList(dbState.factors).map((f) => `${f.userId}:${f.factorId}`));
  const membershipsOf = new Map(asList(dbState.accounts).map((a) => [a.userId, a.memberships ?? 0]));
  for (const account of Object.values(folded.accounts)) {
    for (const [factorId, f] of Object.entries(account.factors)) {
      if (!present.has(`${account.userId}:${factorId}`)) continue;
      factors.push({
        id: 'C8',
        kind: 'factor_delete',
        userId: account.userId,
        factorId,
        at: f.at,
        ref: f.ref ?? null,
      });
    }
    if (!account.deleted) continue;
    if (!membershipsOf.has(account.userId)) continue;
    if (membershipsOf.get(account.userId) > 0) {
      reports.push({
        kind: 'account_held',
        userId: account.userId,
        rule: 'the register records this account swept and it still holds a membership; the second apply, after the deletions are re-applied, is when it goes',
      });
      held.push(account.userId);
      continue;
    }
    accounts.push({ id: 'C9', kind: 'account_delete', userId: account.userId, reason: account.reason });
  }

  /* THE LIFT'S OWN RULE (design 1.3): its company must plan nothing BUT what the lift itself applies, which is the
     narrowing the customer confirmed on the call (--remove, --roles, --withdrawn-by) and the extension the
     current agreement backs (--agreement). A correction that came from the register alone is `apply`'s work: a
     lift is the last step of a recovery and not a way to skip one. And the credentials the register records
     deleted are owed before ANY lift (E7X-C-F8, the rule in this function's comment). */
  const target = liftId === null ? undefined : companies.find((c) => c.id === liftId);
  if (target !== undefined) {
    for (const f of factors)
      target.refusals.push({
        correction: 'C8',
        companyId: liftId,
        userId: f.userId,
        factorId: f.factorId,
        rule: 'the register records this factor deleted and the target still holds it; no company is lifted while a recorded credential deletion is owed',
        wayOut: 'run apply, which deletes it through GoTrue; then lift again',
      });
    for (const a of accounts)
      target.refusals.push({
        correction: 'C9',
        companyId: liftId,
        userId: a.userId,
        rule: 'the register records this account deleted and the target still holds it; no company is lifted while a recorded credential deletion is owed',
        wayOut: 'run apply, which deletes it through GoTrue; then lift again',
      });
    for (const userId of held)
      if (liftMembers.has(userId))
        target.refusals.push({
          correction: 'C9',
          companyId: liftId,
          userId,
          rule: 'the register records this account deleted and it holds an active membership in this company',
          /* Not "then apply deletes it": a removed membership row still references the account, which is why the
             sweep and C9 both leave an account holding any membership row (008, B12). The account then reaches
             nothing, which is what the lift needs. */
          wayOut: 'lift --remove <its membership> on the customer’s confirmation that the person has left',
        });
  }
  const liftable =
    target !== undefined && target.refusals.length === 0 && target.corrections.every((c) => c.viaLift === true);

  return {
    companies,
    factors,
    accounts,
    reports,
    liftable,
    counts: {
      corrections: companies.reduce((n, c) => n + c.corrections.length, 0) + factors.length + accounts.length,
      refusals: companies.reduce((n, c) => n + c.refusals.length, 0),
      reports: reports.length,
    },
  };
}

/**
 * liftStatus(company, folded, given) -> the status the lift writes, or a refusal.
 *
 * The narrower of what the register expects and what C0 recorded as the status before the hold; a WIDER status, and
 * any status at all for a company the register does not know, only on the operator's explicit --status, which they
 * give on the customer's confirmation.
 */
export function liftStatus(company, folded, given = null) {
  const expected = folded.companies[company.id]?.status ?? null;
  const before = company.holdStatusBefore;
  if (given !== null) {
    if (!['active', 'suspended'].includes(given)) throw new ReconcileError('--status is active or suspended');
    const narrowest = expected === null ? before : narrower(expected, before ?? expected);
    return {
      status: given,
      widening: narrowest !== null && STATUS_RANK[given] < STATUS_RANK[narrowest],
      from: narrowest,
    };
  }
  if (expected === null)
    return { status: null, rule: 'the register does not know this company, so the lift needs --status', from: before };
  if (before === null)
    return {
      status: null,
      rule: 'no company.hold audit row records the status before the hold, so the lift needs --status',
      from: null,
    };
  return { status: narrower(expected, before), widening: false, from: before, expected };
}
