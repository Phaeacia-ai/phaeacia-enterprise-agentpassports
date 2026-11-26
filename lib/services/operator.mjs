/* Operator routines (E2 design sections 1.3 and 8.3; E6 design 1.1, 1.5, 1.6 and 3.4).

   No membership is loaded and none exists: operators are not members, so nothing here calls loadPrincipal and
   every company-scoped route answers an operator the same 404 an outsider gets. app.operator_actor() decides,
   under the server token minted from the caller's own session, and refuses E_NOT_OPERATOR and
   E_OPERATOR_MFA_REQUIRED below every routine.

   THE OPERATOR NEVER RECEIVES TENANT CONTENT (design 1.1). Every answer this module returns is a company's
   identity (slug and name, which the operator chose at provisioning), its dates, its quota values and COUNTS. No
   agent name, no group name, no candidate title, no member address, no display name, no review reason, no report
   text, no passport byte. readExportManifest is counts only and there is no operator arm anywhere in
   api.export_company, so a company that cannot take its own copy is served by E7's owner-side
   scripts/export_company.mjs script under the boundary E2 section 5 discloses, never through a request route
   (E6D-C-F1a). The boundary is drawn in one database function, app.operator_company_row, and tests/e6/unit
   asserts that no answer of this module carries a content field.

   The two operator-issued invitations return an accept link once, in handover mode, and that link is the whole
   first factor of the customer's first administrator: for the length of its life a Phaeacia person holds it and
   could use it (design 1.1 exception 1, 1.2 rule 5, section 8 question 7). It is single use, its issuance and
   its acceptance are two audit rows naming two different principals, and the first admin enrols their own
   second factor at first sign-in. Nothing here logs it or stores it; lib/services/invitations.mjs assembles it.

   Field names. The database answers snake_case, which is the accepted convention for a jsonb answer
   (app.installation_response, app.release_response); design 3.4's route answers are camelCase and the mapping is
   this module's. camel() does it by rule rather than by a table of sixty names, and tests/e6/unit pins the
   produced key sets against design 3.4's literal lists, so a key the database adds later cannot arrive in an
   answer unnoticed. */

import { callAs } from '../db/server.mjs';
import { AppError } from '../errors.mjs';
import { isLifecycleReasonCode, isStatusReasonCode } from '../rules/lifecycle.mjs';
import { isQuotaName } from '../rules/quotas.mjs';
import { deliverInvitation, deliveryMode, normalizeEmail, requireDelivery } from './invitations.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const DEFAULT_EXPIRY_DAYS = 7;
/* The register's page size. 50 is design 3.4's and design section 6 derives it: at the plan's envelope of ten
   companies the whole register is one page, and 51 rows are under PostgREST's max_rows of 200 so no answer can
   be cut short without the routine noticing. The routine itself refuses a limit outside 1 to 200. */
const REGISTER_PAGE = 50;

const isUuid = (x) => typeof x === 'string' && UUID.test(x);
const isTimestamp = (x) => typeof x === 'string' && TIMESTAMP.test(x) && !Number.isNaN(Date.parse(x));

/** snake_case to camelCase, one rule: an underscore and the character after it become that character upper-cased. */
const camel = (key) => key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** Every key of a plain object, and of the objects inside it, renamed by camel(). Arrays keep their order. */
function camelKeys(value) {
  if (Array.isArray(value)) return value.map(camelKeys);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[camel(k)] = camelKeys(v);
  return out;
}

/* The database refuses each of these too, authoritatively, under the company lock. These are the early answers,
   so a malformed body never becomes an RPC and a caller cannot learn which companies exist by sending junk. */
function requireCompanyId(companyId) {
  if (!isUuid(companyId)) throw new AppError('E_NOT_FOUND');
  return companyId;
}
function requireSlug(slug) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) throw new AppError('E_SLUG_INVALID');
  return slug;
}
function requireName(name) {
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 200) throw new AppError('E_NAME_INVALID');
  return name.trim();
}
function requireExpiryDays(days) {
  const d = days === undefined ? DEFAULT_EXPIRY_DAYS : days;
  if (!Number.isInteger(d) || d < 1 || d > 30) throw new AppError('E_EXPIRY_INVALID');
  return d;
}
/* The typed confirmation is a SHAPE check here and a COMPARISON in the routine (design 3.5 rows 16 and 17): a
   value that is not a bounded string is 422 E_BODY_INVALID at the service's own row 10, and every string,
   including a wrong one, goes to the routine so that E_COMPANY_NOT_SUSPENDED or E_COMPANY_NOT_CLOSED is still
   answered above E_CONFIRMATION_MISMATCH where the design puts it. */
function requireConfirmation(confirmSlug) {
  if (typeof confirmSlug !== 'string' || confirmSlug.length < 1 || confirmSlug.length > 200)
    throw new AppError('E_BODY_INVALID');
  return confirmSlug;
}
/* design 1.5: startsAt and endsAt are REQUIRED, because a company with no access-period row is not time-bounded
   at all and no product path may create one. The routine writes the row in the same transaction as the company
   and refuses the same 422 itself. */
function requirePeriod({ startsAt, endsAt, invoiceRef }) {
  if (!isTimestamp(startsAt) || !isTimestamp(endsAt)) throw new AppError('E_BODY_INVALID');
  if (Date.parse(startsAt) >= Date.parse(endsAt)) throw new AppError('E_BODY_INVALID');
  if (invoiceRef !== undefined && invoiceRef !== null) {
    if (typeof invoiceRef !== 'string' || invoiceRef.length < 1 || invoiceRef.length > 80)
      throw new AppError('E_BODY_INVALID');
  }
  return { startsAt, endsAt, invoiceRef: invoiceRef ?? null };
}

/* ---------------------------------------------------------------------------
   E2's two, unchanged in behaviour
   --------------------------------------------------------------------------- */

/** api.transfer_first_admin: grant company_admin to an active member the operator names by auth.users id.
 *  The operator has no member list (design 1.1), so the target is an account id the person reads aloud on a
 *  supported call and /account/ shows with a copy control. */
export async function transferFirstAdmin(session, { companyId, userId }, options) {
  requireCompanyId(companyId);
  if (!isUuid(userId)) throw new AppError('E_ID_INVALID');
  const [row] = await callAs(session, 'transfer_first_admin', { p_company: companyId, p_target_user: userId }, options);
  return { membershipId: row.membership_id, roles: row.roles, changed: row.changed === true };
}

/* ---------------------------------------------------------------------------
   design 1.1: provisioning and the register
   --------------------------------------------------------------------------- */

/**
 * createCompany(session, { slug, name, firstAdminEmail, expiresInDays, startsAt, endsAt, invoiceRef }, deps)
 * One transaction in the database: the company row, its access period, and an operator-issued invitation for the
 * first administrator with roles {company_admin, member}. It creates NO membership: the first admin becomes one
 * by accepting, through api.accept_invitation unchanged, which is the path every other member takes.
 *
 * This replaces the E2 route that called api.provision_company on the same method and path. api.provision_company
 * is unchanged in the database and stays the seed's path; it has no route because it takes a confirmed
 * auth.users id no route creates, and because it makes a company with NO access period, which design 1.5 says
 * the product path may not do (lead decision, 2026-09-17; report section 5).
 */
export async function createCompany(
  session,
  { slug, name, firstAdminEmail, expiresInDays, startsAt, endsAt, invoiceRef },
  deps = {},
  options,
) {
  /* E6S-C-F8: delivery availability is validated BEFORE the transaction, which is the guard
     lib/services/invitations.mjs's member paths have used since E2 and these two did not. In `mail` mode with no
     transport this used to create the company, its access period and the first admin's invitation, commit all
     three, and only then fail at the last hop with 502 E_DELIVERY_FAILED: a company nobody asked for, a slug
     taken, and a live invitation secret that had been generated and not delivered. It is a KNOWN configuration
     refusal, answerable before anything is written, so it is answered there: 503 E_MAIL_NOT_CONFIGURED (B4-RC-F1:
     this comment said 422 until 2026-09-20; lib/errors.mjs:47 maps the code to 503 and four tests pin it), no
     company, no period, no secret. It is the first statement of the routine, above the body checks, because a
     server that cannot deliver cannot complete this route whatever the body says. */
  requireDelivery(deps);
  const slugN = requireSlug(slug);
  const nameN = requireName(name);
  const emailN = normalizeEmail(firstAdminEmail);
  if (!emailN) throw new AppError('E_EMAIL_INVALID');
  const days = requireExpiryDays(expiresInDays);
  const period = requirePeriod({ startsAt, endsAt, invoiceRef });
  const [row] = await callAs(
    session,
    'create_company',
    {
      p_slug: slugN,
      p_name: nameN,
      p_first_admin_email: emailN,
      p_expires_in: `${days} days`,
      p_starts_at: period.startsAt,
      p_ends_at: period.endsAt,
      p_invoice_ref: period.invoiceRef,
    },
    options,
  );
  const delivered = await deliverInvitation(
    {
      session,
      email: emailN,
      inviteCode: row.invite_code,
      expiresAt: row.expires_at,
      companyName: nameN,
      kind: 'first_admin',
      companyId: row.company_id,
      invitationId: row.invitation_id,
    },
    deps,
    options,
  );
  return {
    companyId: row.company_id,
    invitationId: row.invitation_id,
    expiresAt: row.expires_at,
    accessPeriod: { endsAt: row.ends_at, exportBy: row.export_by, deleteBy: row.delete_by },
    ...delivered,
  };
}

/**
 * readRegister(session, { cursor, limit }) -> { companies, sweepableAccounts, nextCursor, cursorReset }
 *
 * THE UNKNOWN CURSOR, and it is the lead's decision on the database lane's question 2 (E6DB-F5). The register is
 * ordered by a pair, the deletion-state rank and then the company id, so its keyset has to compare that pair
 * against the cursor company's OWN rank; a company that no longer exists has no rank, and the routine therefore
 * refuses 404 rather than silently answering the first page. A deleted company is exactly the cursor an operator
 * holds after a deletion, so the page will meet this, and a not-found error where a list was expected is not
 * something to show a person. Decided: the service drops the cursor, re-reads the first page ONCE, and says
 * `cursorReset: true` in its answer so the page can say the list moved rather than pretending it did not. A
 * second failure is surfaced, because a register that cannot be read without a cursor is a real fault and
 * retrying it again would hide it.
 */
export async function readRegister(session, { cursor, limit } = {}, options) {
  if (cursor !== undefined && cursor !== null && !isUuid(cursor)) throw new AppError('E_BODY_INVALID');
  const n = limit === undefined ? REGISTER_PAGE : limit;
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new AppError('E_BODY_INVALID');
  const read = (p_cursor) => callAs(session, 'operator_register', { p_cursor, p_limit: n }, options);
  let answer;
  let cursorReset = false;
  try {
    answer = await read(cursor ?? null);
  } catch (error) {
    if (!(cursor && error?.code === 'E_NOT_FOUND')) throw error;
    answer = await read(null);
    cursorReset = true;
  }
  return { ...camelKeys(answer), cursorReset };
}

/** api.operator_export_manifest: one company's counts, cut by the 21 exported sections. Counts only, no row. */
export async function readExportManifest(session, { companyId }, options) {
  requireCompanyId(companyId);
  const answer = await callAs(session, 'operator_export_manifest', { p_company: companyId }, options);
  return camelKeys(answer);
}

/* ---------------------------------------------------------------------------
   design 1.1 and 1.5: the lifecycle writes

   E6D-C-F10, settled here as contract text, because this is the module the debt is about. The three writes below
   that set a value, setCompanyStatus, setAccessPeriod and setQuota, are LAST-WRITER-WINS. Each answers
   `changed: false` when the value it was given is already the one in force and writes no audit row, which is E2's
   idiom; it does NOT detect that somebody else changed the value in between, and it has no expected-value
   argument to detect it with. So a delayed retry of an earlier decision overwrites a later one, silently, and the
   only record that it happened is the two audit rows. That is stated rather than left as the impression design
   3.3's table gave, which was that a repeat is always a no-op.
   The two halves of F10 that are NOT settled here, with where each lands:
     the operator's recovery after a lost answer to createCompany is re-entering the address through
     api.operator_invite_admin, which issues a fresh invitation and revokes the pending sibling through the same
     helper; design 3.3's first version named a Resend control, and Resend is the company admin's route, which
     answers an operator 404. The page that has to say this is the pages lane's. That recovery was written here
     as if it had always worked and it had not: until E6S-C-F6 the routine refused the re-entered address with
     E_SUCCESSION_PENDING (evidence/e6-server-critique.md; corrected in 008 by the corrections lane, E6SC-F3
     records the stale note). It works from the corrected 008 onwards, with exactly one live invitation and one
     seat of headroom, and the earlier secret never replayed;
     an honest replay of transferAgent by a FORMER owner is 403 E_FORBIDDEN and never reaches `changed: false`,
     because the authority is read from the locked agent row (E6D-C-F2). lib/services/agents.mjs says so at the
     routine and the page's action for E_OWNER_CHANGED is `reload`; whether that is enough for the former-owner
     case is the pages lane's and the code review's.
   --------------------------------------------------------------------------- */

/** api.set_company_status: suspend and resume. The reason code is a closed list of three (the lead's decision on
 *  E6DB-F4), so a suspension over an unpaid invoice and one at the customer's own request are different rows. */
export async function setCompanyStatus(session, { companyId, status, reasonCode }, options) {
  requireCompanyId(companyId);
  if (status !== 'active' && status !== 'suspended') throw new AppError('E_BODY_INVALID');
  if (!isStatusReasonCode(reasonCode)) throw new AppError('E_BODY_INVALID');
  const [row] = await callAs(
    session,
    'set_company_status',
    { p_company: companyId, p_status: status, p_reason_code: reasonCode },
    options,
  );
  return { companyId: row.company_id, status: row.status, changed: row.changed === true };
}

/** api.set_access_period: export_by and delete_by are derived from two constants and then STORED, because they
 *  are the promise made to a customer at a moment in time. Re-setting recomputes both from the new end date. */
export async function setAccessPeriod(session, { companyId, startsAt, endsAt, invoiceRef }, options) {
  requireCompanyId(companyId);
  const period = requirePeriod({ startsAt, endsAt, invoiceRef });
  const [row] = await callAs(
    session,
    'set_access_period',
    {
      p_company: companyId,
      p_invoice_ref: period.invoiceRef,
      p_starts_at: period.startsAt,
      p_ends_at: period.endsAt,
    },
    options,
  );
  return {
    companyId: row.company_id,
    endsAt: row.ends_at,
    exportBy: row.export_by,
    deleteBy: row.delete_by,
    changed: row.changed === true,
  };
}

/**
 * api.set_company_quota. A name outside the seven is 422 E_BODY_INVALID here and again in the routine.
 *
 * E_QUOTA_OUT_OF_RANGE answers TWO conditions with one sentence: a value outside app.quota_bounds(name), and a
 * value whose product with the company's lifetime memberships would exceed E4's 10,000-row ledger ceiling
 * (design section 6). The lead asked for the distinction in the answer's data only if the database answer lets
 * the two be told apart without a second call. It does not: both raise the same token with SQLSTATE 22023 and no
 * DETAIL, and this service holds no copy of app.quota_bounds to decide the first itself, by design, because one
 * reader of a quota bound is the whole point of design 1.7. So it is carried as a debt (E6S-F3) with its
 * consequence: an operator told "outside the range this service allows" cannot tell whether to type a smaller
 * number or to raise the other quota first, and the page cannot tell them either.
 */
export async function setQuota(session, { companyId, name, value }, options) {
  requireCompanyId(companyId);
  if (!isQuotaName(name)) throw new AppError('E_BODY_INVALID');
  if (!Number.isInteger(value)) throw new AppError('E_BODY_INVALID');
  const [row] = await callAs(
    session,
    'set_company_quota',
    { p_company: companyId, p_name: name, p_value: value },
    options,
  );
  return {
    companyId: row.company_id,
    name: row.name,
    value: row.value,
    previous: row.previous,
    changed: row.changed === true,
  };
}

/* The company's display name for the succession mail, or null when the read fails: the name is chosen by the operator
   at provisioning and is not tenant content (008, app.operator_company_row), and this reads nothing else of the row. */
async function operatorCompanyName(session, companyId, options) {
  try {
    const row = await callAs(session, 'operator_export_manifest', { p_company: companyId }, options);
    return typeof row?.name === 'string' ? row.name : null;
  } catch {
    return null;
  }
}

/** api.operator_invite_admin: the succession invitation for a company whose sole admin is gone, worth exactly
 *  one seat of headroom, granted authoritatively at acceptance. In handover mode the link comes back here, to
 *  the operator, which is the credential this module's header names. */
export async function inviteAdmin(session, { companyId, email, expiresInDays }, deps = {}, options) {
  /* E6S-C-F8, the same guard and the same reason: this routine's transaction revokes the pending sibling and
     writes a new invitation, so failing after it would leave a revoked link the customer may already hold and a
     new secret nobody received. */
  requireDelivery(deps);
  requireCompanyId(companyId);
  const emailN = normalizeEmail(email);
  if (!emailN) throw new AppError('E_EMAIL_INVALID');
  const days = requireExpiryDays(expiresInDays);
  const [row] = await callAs(
    session,
    'operator_invite_admin',
    { p_company: companyId, p_email: emailN, p_expires_in: `${days} days` },
    options,
  );
  /* E7 1.1: the succession mail names the company. api.operator_invite_admin answers no name, so in `mail` mode the
     name is read from app.operator_company_row through api.operator_export_manifest, the one operator read of one
     company, AFTER the routine has committed: the refusals of design 3.5 keep their order in both modes, and handover
     makes no extra call. A failed read renders the template's fixed words instead of a name and never turns a written
     invitation into an error (the E7 mail lane; the gap the contract commit recorded in evidence/e1-lead.md). */
  const companyName = deliveryMode() === 'mail' ? await operatorCompanyName(session, companyId, options) : null;
  const delivered = await deliverInvitation(
    {
      session,
      email: emailN,
      inviteCode: row.invite_code,
      expiresAt: row.expires_at,
      companyName,
      kind: 'succession',
      companyId,
      invitationId: row.invitation_id,
    },
    deps,
    options,
  );
  return { invitationId: row.invitation_id, expiresAt: row.expires_at, ...delivered };
}

/** api.operator_expiry_run: idempotent, bounded per call, one audit row per company changed and nothing for a
 *  company it only listed. It is the TIDY-UP and not the control: every read boundary tests time. */
export async function runExpiry(session, { limit } = {}, options) {
  const n = limit === undefined ? REGISTER_PAGE : limit;
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new AppError('E_BODY_INVALID');
  const answer = await callAs(session, 'operator_expiry_run', { p_limit: n }, options);
  return camelKeys(answer);
}

/* ---------------------------------------------------------------------------
   design 1.6: closure and deletion
   --------------------------------------------------------------------------- */

/** api.close_company: from `suspended` only, with the company's own slug typed back, and with a reason code whose
 *  rule is the routine's: while export_by is still ahead it must be customer_instruction, because closing then
 *  cuts the customer's fourteen-day window short. */
export async function closeCompany(session, { companyId, confirmSlug, reasonCode }, options) {
  requireCompanyId(companyId);
  requireConfirmation(confirmSlug);
  if (!isLifecycleReasonCode(reasonCode)) throw new AppError('E_BODY_INVALID');
  const [row] = await callAs(
    session,
    'close_company',
    { p_company: companyId, p_confirm_slug: confirmSlug, p_reason_code: reasonCode },
    options,
  );
  return { companyId: row.company_id, status: row.status, changed: row.changed === true };
}

/** api.delete_company: the one door, from `closed` only, admitted from export_by or on a recorded customer
 *  instruction. The answer's counts are what was removed, section by section, and orphanedUserIds are the
 *  accounts that now hold no membership anywhere, which the account sweep and nothing else deletes. */
export async function deleteCompany(session, { companyId, confirmSlug, reasonCode }, options) {
  requireCompanyId(companyId);
  requireConfirmation(confirmSlug);
  if (!isLifecycleReasonCode(reasonCode)) throw new AppError('E_BODY_INVALID');
  const [row] = await callAs(
    session,
    'delete_company',
    { p_company: companyId, p_confirm_slug: confirmSlug, p_reason_code: reasonCode },
    options,
  );
  /* The routine answers one object carrying the eighteen section counts AND orphaned_user_ids (evidence/e6-db.md
     section 5); design 3.4's route answer keeps the counts in `deleted` and puts the accounts beside it, because
     an account is not a section of the company and a page renders the two in different places. */
  const { orphanedUserIds = [], ...deleted } = camelKeys(row.deleted ?? {});
  return { companyId: row.company_id, deleted, orphanedUserIds };
}
