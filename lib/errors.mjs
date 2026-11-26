/* Error codes and the database-to-HTTP mapping (E2 design section 6).

   Every failure the server reports is a code and a status; the message is a
   fixed English sentence per code, never database text, never an email
   address, never a row. PostgREST error bodies carry `code` (SQLSTATE or a
   PGRST code), `message`, `details` and `hint`; only the SQLSTATE and, when
   the message starts with an E_ token, that token are read. `details` and
   `hint` are dropped here and nowhere else, so a CHECK violation's echoed row
   (probe 4d) cannot reach a response or a log. */

/* Handler and service codes with their status. Database codes are listed too
   so that a code the database raises but this table does not know is refused
   as internal rather than forwarded. */
export const CODES = Object.freeze({
  E_UNAUTHENTICATED: 401,
  E_SESSION_UNAVAILABLE: 503,
  E_MAINTENANCE: 503,
  E_GATE_UNREGISTERED: 503,
  E_METHOD_NOT_ALLOWED: 405,
  E_UNSUPPORTED_MEDIA_TYPE: 415,
  E_BODY_TOO_LARGE: 413,
  E_BODY_INVALID: 422,
  E_EMAIL_INVALID: 422,
  E_ROLES_INVALID: 422,
  E_EXPIRY_INVALID: 422,
  E_SLUG_INVALID: 422,
  E_NAME_INVALID: 422,
  E_ID_INVALID: 422,
  E_CROSS_SITE: 403,
  E_FORBIDDEN: 403,
  E_ADMIN_MFA_REQUIRED: 403,
  E_OPERATOR_MFA_REQUIRED: 403,
  E_NOT_OPERATOR: 403,
  E_EMAIL_MISMATCH: 403,
  E_NOT_SERVER: 403,
  E_NOT_FOUND: 404,
  E_INVITATION_INVALID: 404,
  E_USER_NOT_FOUND: 404,
  E_LAST_ADMIN: 409,
  E_ALREADY_MEMBER: 409,
  E_INVITATION_ACCEPTED: 409,
  E_MEMBERSHIP_REMOVED: 409,
  E_COMPANY_INACTIVE: 409,
  E_CONFLICT: 409,
  E_BUSY: 409,
  E_AUTH_INVALID: 401,
  E_MAIL_NOT_CONFIGURED: 503,
  E_INTERNAL: 500,
  /* E3 design 4.5. The database raises each 403 with 42501, each 409 with P0001, each 422 with 22023
     and E_GATE_UNREGISTERED with P0003; 428 and 500 are handler-side and never raised by the database. */
  E_CANONICAL: 422,
  E_ACCESS: 422,
  E_BINDING: 422,
  E_FIDELITY: 422,
  E_STATE_REQUIRED: 422,
  E_PUBLIC_ROUTE: 422,
  E_SECRET_FOUND: 422,
  E_DERIVED_INVALID: 422,
  E_CLOCK: 422,
  E_GATE_FAILS_NOW: 422,
  E_VERSION_REQUIRED: 428,
  E_IDEMPOTENCY_KEY_INVALID: 422,
  E_NOT_AUTHOR: 403,
  E_NOT_BOUND: 403,
  E_NOT_DRAFT: 409,
  E_VERSION_CONFLICT: 409,
  E_CONTENT_CHANGED: 409,
  E_IDEMPOTENCY_CONFLICT: 409,
  E_IMMUTABLE: 409,
  E_STATE_RESET: 409,
  E_STATE_TRANSITION: 409,
  E_CONTRIBUTORS_FROZEN: 409,
  E_AGENT_NAME_TAKEN: 409,
  E_AGENT_ARCHIVED: 409,
  E_AGENT_LIMIT: 409,
  E_VERSION_LIMIT: 409,
  E_ASSEMBLY_DIVERGED: 500,
  E_IDEMPOTENCY_EXPIRED: 409,
  E_IDEMPOTENCY_LIMIT: 409,
  E_SUCCESSOR_EXISTS: 409,
  /* Handler-side (E3b critique F3 and F2): a read that must be complete, lib/services/candidates.mjs readAll, came
     back with more rows than its stated ceiling, and fails closed rather than answer part of a list. */
  E_READ_OVER_BOUND: 500,
  /* The gate's own refusal codes (E3 design 3.5, 4.5 rows 12, 14 and 15), added by E3b: a 422 answer names the first
     problem's code and lists every problem with its line. The vendored transport, validator and deriver emit these;
     the enterprise rules' codes are above. Rows 7 and 8 refuse a wrong type and an oversized body before the gate
     runs, so the gate's 415 and 413 are defense in depth. tests/e3/unit/candidates.test.mjs reads every code the
     gate's modules can emit and fails on one missing here. */
  E_CONTENT_TYPE: 415,
  E_TOO_LARGE: 413,
  E_TOO_SMALL: 422,
  E_NOT_UTF8: 422,
  E_CONTROL_CHARS: 422,
  E_FRONTMATTER: 422,
  E_MISSING_KEY: 422,
  E_BAD_VALUE: 422,
  E_UNKNOWN_VERSION: 422,
  E_SECTIONS: 422,
  E_SECTION_ORDER: 422,
  E_UNFILLED: 422,
  E_GOLDEN_COUNT: 422,
  E_CAPABILITY: 422,
  E_BAD_ENVELOPE: 422,
  E_ENVELOPE_FLOOR: 422,
  E_SCRUB_GATE: 422,
  E_HTML: 422,
  E_ACTIVE_CONTENT: 422,
  E_DENIED_PATH: 422,
  E_COMPARISON_MODE: 422,
  E_FENCE_INVISIBLE: 422,
  E_DERIVE_TITLE: 422,
  E_DERIVE_SUMMARY: 422,
  E_DERIVE_NEEDS: 422,
  E_DERIVE_ENVELOPE: 422,
  E_DERIVE_ENVELOPE_TOKEN: 422,
  E_DERIVE_ENVELOPE_OPAQUE: 422,
  E_DERIVE_ENVELOPE_INPUT: 422,
  E_DERIVE_ENVELOPE_FIXED: 422,
  /* E2 pages design 2.6 (revision 7): the second-factor routes and the per-account verification bound of 2.8. GoTrue's
     answers map to them in lib/auth/factors.mjs, which pages construction builds; none is raised by the database. */
  E_MFA_CODE_INVALID: 422,
  E_MFA_STEP_UP_REQUIRED: 403,
  E_MFA_FACTOR_LIMIT: 409,
  E_MFA_NOT_ENABLED: 503,
  E_MFA_UNAVAILABLE: 503,
  E_RATE_LIMITED: 429,
  /* HB-F2 (migration 012): the account's own budget of wrong second-factor codes is spent; the answer carries
     retryAfter, the window's end, which GoTrue's per-address 429 (E_RATE_LIMITED) cannot say. */
  E_MFA_ATTEMPTS_EXHAUSTED: 429,
  /* E4 design 3.5. The database raises each 403 with 42501, each 409 with P0001, each 422 with 22023,
     E_INSTALLER_UNREGISTERED with P0003 beside E_GATE_UNREGISTERED, and E_ASSEMBLY_DIVERGED (above) with P0004.
     E_DERIVED_CHANGED is the service's alone; E_ASSEMBLY_TOO_LARGE is both the service's and the routines'
     (E4D-C-F3); E_RELEASE_WITHDRAWN is reserved for E5's download and raised by its test seam. The owner-side
     refusals (E_GROUP_DELETE, and part B's E_ENVELOPE_DELETE, E_RELEASE_DELETE, E_LEDGER_APPEND_ONLY) are reachable
     by no PostgREST role and are not listed. */
  E_NOT_REVIEWABLE: 409,
  E_ROLE_REQUIRED: 403,
  E_REVIEWER_IS_CONTRIBUTOR: 403,
  E_ALREADY_SIGNED: 409,
  E_ENVELOPE_CLOSED: 409,
  E_ENVELOPE_APPROVED: 409,
  E_ENVELOPE_REQUIRED: 409,
  E_ENVELOPE_LIMIT: 409,
  E_DERIVED_CHANGED: 409,
  E_ADAPTER_CHANGED: 409,
  E_POLICY_CHANGED: 409,
  E_NOT_APPROVED: 409,
  E_ENVELOPE_NOT_APPROVED: 409,
  E_CANDIDATE_SUPERSEDED: 409,
  E_AGENT_ORPHANED: 409,
  E_TARGET_NOT_PUBLISHABLE: 409,
  E_INSTALLER_UNREGISTERED: 503,
  E_ALREADY_WITHDRAWN: 409,
  E_GROUP_NAME_TAKEN: 409,
  E_GROUP_LIMIT: 409,
  E_ASSEMBLY_TOO_LARGE: 422,
  E_RELEASE_WITHDRAWN: 409,
  /* E5 design 3.5. The database raises each 403 with 42501, each 409 with P0001 and each 422 with 22023.
     E_RELEASE_WITHDRAWN above stops being reserved: api.authorize_download is its first production raiser. The
     owner-side refusals E_REPORT_APPEND_ONLY and E_WITNESS_APPEND_ONLY are reachable by no PostgREST role and are not
     listed, exactly as E_LEDGER_APPEND_ONLY is not. */
  E_RELEASE_SUPERSEDED: 409,
  E_DOWNLOAD_LIMIT: 409,
  E_NOT_DOWNLOADED: 409,
  E_LOSSES_REQUIRED: 422,
  E_REPORT_LIMIT: 409,
  E_ALREADY_WITNESSED: 409,
  E_WITNESS_LIMIT: 409,
  E_WITNESS_IS_RECIPIENT: 403,
  /* E6 design 3.5, landed by the lead before construction (evidence/e6-design-corrections.md section 4 item 3). The
     database raises each 409 with P0001 and each 422 with 22023. No E6 routine exists yet; a code without a raiser is
     harmless, and a raiser without a code would answer 500 E_INTERNAL. */
  E_ACCESS_PERIOD_ENDED: 409,
  E_SEATS_EXHAUSTED: 409,
  E_INVITATION_LIMIT: 409,
  E_OWNER_CHANGED: 409,
  E_COMPANY_CLOSED: 409,
  E_COMPANY_NOT_SUSPENDED: 409,
  E_COMPANY_NOT_CLOSED: 409,
  E_DELETION_NOT_DUE: 409,
  E_DELETE_TOO_LARGE: 409,
  E_EXPORT_TOO_LARGE: 409,
  E_OPERATOR_ACCOUNT: 409,
  E_MEMBER_ACCOUNT: 409,
  E_EXPORT_WINDOW_OPEN: 409,
  E_SUCCESSION_PENDING: 409,
  E_CONFIRMATION_MISMATCH: 422,
  E_QUOTA_OUT_OF_RANGE: 422,
  /* E7 design 2.6 item 1, landed by the lead before construction (evidence/e7-design-corrections.md): raised by
     migration 009's recovery hold and mapped by the operator's status route. E_DELIVERY_FAILED is RETIRED in the same
     change: a delivery failure after the invitation row is written answers 201 with delivery "failed" (E7 1.1),
     so no path answers it any more. */
  E_RECOVERY_HOLD: 409,
  /* The alerts design 2.5, granted to the slice 1 build lane (docs/e7/alerts-and-checkin-design.md 1.4): the mail event
     route's one refusal, for a missing or malformed Svix header, a timestamp outside the tolerance, no matching
     signature, and a signing secret that is unset or malformed (ALD-R-F1), so an unconfigured route and a forger
     meet the same answer. A 4xx, so it raises no alert (E7 1.5, case E7-22). */
  E_WEBHOOK_INVALID: 401,
});

const MESSAGES = Object.freeze({
  E_UNAUTHENTICATED: 'Sign in required.',
  E_SESSION_UNAVAILABLE: 'Sign-in could not be verified right now. Retry shortly.',
  E_MAINTENANCE: 'The service is temporarily closed for maintenance.',
  E_GATE_UNREGISTERED: 'Content checks are being updated. Retry shortly.',
  E_METHOD_NOT_ALLOWED: 'Method not allowed.',
  /* Neutral since HTTP-D2: JSON routes and passport routes accept different types, and naming one was wrong
     on the other. */
  E_UNSUPPORTED_MEDIA_TYPE: 'This request body has a content type the route does not accept.',
  E_BODY_TOO_LARGE: 'Request body too large.',
  /* Neutral since E3b's T1: the code also answers a bad agent header and a bad list query parameter. */
  E_BODY_INVALID: 'The request is not valid.',
  E_EMAIL_INVALID: 'Email address is not valid.',
  E_ROLES_INVALID: 'Roles are not valid.',
  E_EXPIRY_INVALID: 'Expiry must be between 1 and 30 days.',
  E_SLUG_INVALID: 'Company slug is not valid.',
  E_NAME_INVALID: 'Company name is not valid.',
  E_ID_INVALID: 'Identifier is not valid.',
  E_CROSS_SITE: 'Cross-site request refused.',
  E_FORBIDDEN: 'Not permitted.',
  E_ADMIN_MFA_REQUIRED: 'A second factor is required for administrator actions.',
  E_OPERATOR_MFA_REQUIRED: 'A second factor is required for operator actions.',
  E_NOT_OPERATOR: 'Not an operator.',
  E_EMAIL_MISMATCH: 'This invitation is for a different address.',
  E_NOT_SERVER: 'Not permitted.',
  E_NOT_FOUND: 'Not found.',
  E_INVITATION_INVALID: 'Invitation is not valid.',
  E_USER_NOT_FOUND: 'User not found.',
  E_LAST_ADMIN: 'A company keeps at least one administrator.',
  E_ALREADY_MEMBER: 'Already an active member.',
  E_INVITATION_ACCEPTED: 'Invitation was already accepted.',
  E_MEMBERSHIP_REMOVED: 'Membership is removed.',
  E_COMPANY_INACTIVE: 'Company is not active.',
  E_CONFLICT: 'Conflicts with an existing record.',
  E_BUSY: 'Busy, retry.',
  E_AUTH_INVALID: 'Sign-in link is not valid.',
  E_MAIL_NOT_CONFIGURED: 'Invitation delivery is not configured.',
  E_INTERNAL: 'Internal error.',
  E_CANONICAL:
    'The passport contains a carriage return that would change when it is installed. Save it with plain line feeds.',
  E_ACCESS: 'An input access value is not open or credentialed.',
  E_BINDING: 'A credentialed input needs a binding that names a personal slot.',
  E_FIDELITY: 'An input fidelity value is not exact or lossy.',
  E_STATE_REQUIRED: 'A verification check compares against an earlier run, and the passport declares no state.',
  E_PUBLIC_ROUTE: 'The passport names a public publishing route.',
  E_SECRET_FOUND: 'The passport contains something that looks like a credential. It was not stored.',
  E_DERIVED_INVALID: 'The derived record is not valid.',
  E_CLOCK: 'The validation time is not current.',
  E_GATE_FAILS_NOW: 'The stored passport no longer passes the current content checks.',
  E_VERSION_REQUIRED: 'The version this change is based on is required.',
  E_IDEMPOTENCY_KEY_INVALID: 'An idempotency key is required.',
  E_NOT_AUTHOR: 'Only the author can change this draft.',
  E_NOT_BOUND: 'Not permitted.',
  E_NOT_DRAFT: 'This candidate is no longer a draft.',
  E_VERSION_CONFLICT: 'This draft changed since you loaded it. Reload it.',
  E_CONTENT_CHANGED: 'The draft changed while it was being checked. Reload it.',
  E_IDEMPOTENCY_CONFLICT: 'This request key was already used for a different request.',
  E_IMMUTABLE: 'A submitted candidate cannot change.',
  E_STATE_RESET: 'A candidate cannot return to draft.',
  E_STATE_TRANSITION: 'That change of state is not allowed.',
  E_CONTRIBUTORS_FROZEN: 'Contributors are fixed once a candidate is submitted.',
  E_AGENT_NAME_TAKEN: 'An agent with this name already exists.',
  E_AGENT_ARCHIVED: 'This agent is archived.',
  E_AGENT_LIMIT: 'This company has reached its agent limit.',
  E_VERSION_LIMIT: 'This agent has reached its version limit.',
  E_ASSEMBLY_DIVERGED: 'Internal error.',
  E_IDEMPOTENCY_EXPIRED: 'This request key has expired. Reload to see where the work is.',
  E_IDEMPOTENCY_LIMIT: 'Too many recent requests for this member. Retry later.',
  E_SUCCESSOR_EXISTS: 'A successor of this candidate already exists.',
  E_READ_OVER_BOUND: 'The records this answer needs are more than this service reads in full.',
  /* Fixed sentences: the vendored messages substitute values from the document, which never leave the gate. */
  E_CONTENT_TYPE: 'The passport is not a Markdown or plain text file.',
  E_TOO_LARGE: 'The passport is larger than 256 KiB.',
  E_TOO_SMALL: 'The passport is too short to be a passport.',
  E_NOT_UTF8: 'The passport is not valid UTF-8 text.',
  E_CONTROL_CHARS: 'The passport contains control characters or broken Unicode.',
  E_FRONTMATTER: 'The block at the top of the passport is missing or unreadable.',
  E_MISSING_KEY: 'The passport is missing required information at the top of the file.',
  E_BAD_VALUE: 'A value at the top of the passport is not valid.',
  E_UNKNOWN_VERSION: 'The passport declares a format version this validator does not know.',
  E_SECTIONS: 'The passport is missing one of its six sections, or has one twice.',
  E_SECTION_ORDER: 'The passport sections are out of order.',
  E_UNFILLED: 'The passport still carries template placeholders.',
  E_GOLDEN_COUNT: 'A passport needs between one and three golden examples.',
  E_CAPABILITY: 'The passport asks for a capability outside the published vocabulary.',
  E_BAD_ENVELOPE: 'The passport declares an envelope this format version does not accept.',
  E_ENVELOPE_FLOOR: 'The passport marks a capability that writes to the world as installable.',
  E_SCRUB_GATE: 'The passport has redacted sections nobody confirmed were reviewed.',
  E_HTML: 'The passport contains HTML. Passports are Markdown only.',
  E_ACTIVE_CONTENT: 'The passport contains a link or address that can run code.',
  E_DENIED_PATH: 'The passport names a file or folder capture may not read.',
  E_COMPARISON_MODE: 'The passport sets a comparison mode the format does not allow.',
  E_FENCE_INVISIBLE: 'A code fence in the passport is hidden behind an invisible character.',
  E_DERIVE_TITLE: 'The passport title is empty.',
  E_DERIVE_SUMMARY: 'Section 1 of the passport could not be read as a description.',
  E_DERIVE_NEEDS: 'The capability table in section 2 of the passport could not be read.',
  E_DERIVE_ENVELOPE: 'The envelope of the passport could not be derived.',
  E_DERIVE_ENVELOPE_TOKEN: 'A consent row names a capability that writes to the world and marks it installable.',
  E_DERIVE_ENVELOPE_OPAQUE: 'A consent row carries a token this site will not repeat back.',
  E_DERIVE_ENVELOPE_INPUT: 'An input writes to the world and the consent table does not declare it.',
  E_DERIVE_ENVELOPE_FIXED: 'A consent row that writes to the world is marked installable.',
  /* E2 pages design 2.6, verbatim. */
  E_MFA_CODE_INVALID: 'The code is not valid. Enter the current code from your authenticator app.',
  E_MFA_STEP_UP_REQUIRED: 'Verify with your second factor first.',
  E_MFA_FACTOR_LIMIT: 'Too many authenticators are set up. Remove one first.',
  E_MFA_NOT_ENABLED: 'Second-factor sign-in is not enabled on this service.',
  E_MFA_UNAVAILABLE: 'Second-factor verification is unavailable right now. Retry shortly.',
  E_RATE_LIMITED: 'Too many attempts. Wait a minute and retry.',
  E_MFA_ATTEMPTS_EXHAUSTED: 'Too many wrong codes for this account. Try again after the time shown.',
  /* E4 design 3.5. The design names the codes and statuses and leaves the sentences to this table
     (evidence/e4-prereqs.md). */
  E_NOT_REVIEWABLE: 'This candidate is not open for review.',
  E_ROLE_REQUIRED: 'This review needs a reviewer role you do not hold.',
  E_REVIEWER_IS_CONTRIBUTOR: 'A contributor to any version of this agent cannot review it.',
  E_ALREADY_SIGNED: 'This role has already approved this review.',
  E_ENVELOPE_CLOSED: 'Changes were requested on this review, so it is closed.',
  E_ENVELOPE_APPROVED: 'This review is already approved.',
  E_ENVELOPE_REQUIRED: 'A change request on an approved candidate names the review it is for.',
  E_ENVELOPE_LIMIT: 'This candidate has reached its limit of reviews.',
  E_DERIVED_CHANGED: 'The stored passport now reads differently under the current content checks.',
  E_ADAPTER_CHANGED: 'Content checks changed since this review was proposed. Propose it again.',
  E_POLICY_CHANGED: 'The release policy changed since this review was proposed. Propose it again.',
  E_NOT_APPROVED: 'This candidate is not approved.',
  E_ENVELOPE_NOT_APPROVED: 'This review does not have both approvals.',
  E_CANDIDATE_SUPERSEDED: 'A newer version of this agent replaces this candidate.',
  E_AGENT_ORPHANED: 'This agent has no active owner.',
  E_TARGET_NOT_PUBLISHABLE: 'Publishing to this platform is not enabled.',
  E_INSTALLER_UNREGISTERED: 'Installation texts are being updated. Retry shortly.',
  E_ALREADY_WITHDRAWN: 'This release is already withdrawn.',
  E_GROUP_NAME_TAKEN: 'A group with this name already exists.',
  E_GROUP_LIMIT: 'This company has reached its group limit.',
  E_ASSEMBLY_TOO_LARGE: 'The installation for this platform would be larger than the service stores.',
  E_RELEASE_WITHDRAWN: 'This release was withdrawn.',
  /* E5 design 3.5. The design names the codes and statuses and leaves the sentences to this table, as E4's did. Each
     says what happened and what the reader can do, and none of them asserts anything about an installation. */
  E_RELEASE_SUPERSEDED: 'A newer version of this agent replaces this release.',
  E_DOWNLOAD_LIMIT: 'You have been given this installation block as often as this service allows.',
  E_NOT_DOWNLOADED: 'Get the installation block before recording what happened.',
  E_LOSSES_REQUIRED: 'Say what did not come across before recording a partial or failed installation.',
  E_REPORT_LIMIT: 'You have recorded this installation as often as this service allows.',
  E_ALREADY_WITNESSED: 'You have already witnessed this report.',
  E_WITNESS_LIMIT: 'This report has as many witnesses as this service allows.',
  E_WITNESS_IS_RECIPIENT: 'A witness is somebody other than the person who made the report.',
  /* E6 design 3.5's sentences, with one lead amendment: the design's sentence for E_ACCESS_PERIOD_ENDED went on "Its
     records can still be read and exported.", which the F3 correction made false, because the same code now answers a
     read after export_by. The sentence here claims neither. */
  E_ACCESS_PERIOD_ENDED: "This company's access period has ended.",
  E_SEATS_EXHAUSTED: 'This company has as many people as its agreement allows. Ask Phaeacia to raise it.',
  E_INVITATION_LIMIT: 'This company has as many open invitations as this service allows. Revoke one first.',
  E_OWNER_CHANGED: "Somebody else changed this agent's owner. Reload to see who owns it now.",
  E_COMPANY_CLOSED: 'This company is closed.',
  E_COMPANY_NOT_SUSPENDED: 'Suspend this company before closing it.',
  E_COMPANY_NOT_CLOSED: 'Close this company before deleting it.',
  E_DELETION_NOT_DUE: "This company's deletion date has not passed and no deletion instruction was given.",
  E_DELETE_TOO_LARGE: 'This company holds more records than this service deletes in one request.',
  E_EXPORT_TOO_LARGE: 'This company holds more than this service exports in one request.',
  E_OPERATOR_ACCOUNT: 'This account belongs to Phaeacia and cannot be a member of a company.',
  E_MEMBER_ACCOUNT: 'This account is a member of a company and cannot be an operator.',
  /* Reworded from the design's sentence: scripts/check-imports.mjs refuses the bare module keyword for sending a
     binding out anywhere but in a module's own statements, the design's sentence carried it as a verb, and the
     sentence moves rather than the tripwire. */
  E_EXPORT_WINDOW_OPEN:
    "This company's window for reading and exporting its records is still open. Closing now needs a recorded instruction from the customer.",
  E_SUCCESSION_PENDING: 'This company already has an open administrator invitation from Phaeacia. Revoke it first.',
  E_CONFIRMATION_MISMATCH: 'The name you typed does not match this company.',
  E_QUOTA_OUT_OF_RANGE: 'That value is outside the range this service allows for this quota.',
  E_RECOVERY_HOLD: 'This company is held after a restore until Phaeacia has confirmed it with you.',
  E_WEBHOOK_INVALID: 'The event could not be verified.',
});

/* SQLSTATE to status (design section 6). A code the message names is kept only
   when its SQLSTATE class is listed here and CODES gives the code that same status.
   P0003 is the database's 503 class (E3 design section 2.6 item 5), raised only with
   E_GATE_UNREGISTERED and, since E4 (design 2.6 item 3), E_INSTALLER_UNREGISTERED. The two
   entries work only together: either one alone maps that refusal to 500 E_INTERNAL
   (evidence/e3-design-critique-repro/extra-output.txt). No PT503: the status here comes
   from the SQLSTATE, never from PostgREST's own. P0004 is the database's named 500 (E4
   design 1.9 and 3.5), raised only with E_ASSEMBLY_DIVERGED: the routine refuses a splice
   whose hash differs from the service's before anything is written, and the answer stays
   internal while the code stays loggable. tests/e3/unit/migration-text.test.mjs holds both
   classes to their codes in every migration. */
const SQLSTATE_STATUS = Object.freeze({
  42501: 403,
  P0002: 404,
  P0001: 409,
  P0003: 503,
  P0004: 500,
  22023: 422,
  23514: 422,
  23505: 409,
  '55P03': 409,
});

/* The keys every error body starts with; an AppError's data may name none of them. */
const BODY_KEYS = Object.freeze(['ok', 'code', 'message']);

export class AppError extends Error {
  /** @param {string} code a key of CODES
      @param {unknown} [cause] kept on the error, never answered
      @param {object} [data] a plain object whose keys the pipeline's boundary appends to the answer after ok, code
        and message, such as a gate refusal's problem list (E3 design 3.5); it names none of those three */
  constructor(code, cause, data) {
    if (!(code in CODES)) throw new TypeError(`unknown error code ${String(code)}`);
    if (
      data !== undefined &&
      (typeof data !== 'object' ||
        data === null ||
        Array.isArray(data) ||
        BODY_KEYS.some((k) => Object.hasOwn(data, k)))
    )
      throw new TypeError('AppError data is a plain object naming none of ok, code and message');
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.status = CODES[code];
    if (cause !== undefined) this.cause = cause;
    if (data !== undefined) this.data = data;
  }
}

export function isAppError(e) {
  return e instanceof AppError;
}

export function messageFor(code) {
  return MESSAGES[code] ?? MESSAGES.E_INTERNAL;
}

/** Response body for a code: `{ ok: false, code, message }`, then the keys of `data` (an AppError's) when given.
    Nothing in `data` replaces one of the three, and an unknown code answers E_INTERNAL without it. */
export function errorBody(code, data) {
  const known = code in CODES ? code : 'E_INTERNAL';
  const body = { ok: false, code: known, message: messageFor(known) };
  if (data === undefined || known !== code) return body;
  for (const [k, v] of Object.entries(data)) if (!BODY_KEYS.includes(k)) body[k] = v;
  return body;
}

const E_TOKEN = /^(E_[A-Z_]+)\b/;

/** The shape of a database error code: a five-character SQLSTATE or a PostgREST `PGRST` code. Either names a class
    of failure and carries no content, so the pipeline may log it (lib/http/alerts.mjs ALERT_FIELDS.dbCode). */
export const DB_CODE = /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/;

/** dbErrorCode(body) -> the error body's `code` when it has DB_CODE's shape, else undefined. Nothing else of the
    body is read (XR-12's remainder: a 500 that came from the database kept no trace of which failure it was). */
export function dbErrorCode(body) {
  const code = body?.code;
  return typeof code === 'string' && DB_CODE.test(code) ? code : undefined;
}

/* Map a PostgREST error to an AppError. `postgrest` is `{ status, body }`
   where body is the parsed JSON error or null. Nothing of the body survives
   except the derived code and, on an internal answer, the database's own code
   when it has DB_CODE's shape; the cause holds those two values only, so a
   logged error cannot echo `details`, `hint` or `message`. */
export function fromPostgrest({ status, body }) {
  const sqlstate = typeof body?.code === 'string' ? body.code : '';
  const token = typeof body?.message === 'string' ? (E_TOKEN.exec(body.message)?.[1] ?? null) : null;
  if (sqlstate === '55P03') return new AppError('E_BUSY');
  if (sqlstate === '23505') return new AppError('E_CONFLICT');
  const mapped = SQLSTATE_STATUS[sqlstate];
  if (mapped !== undefined && token && token in CODES && CODES[token] === mapped) return new AppError(token);
  if (mapped === 422) return new AppError('E_BODY_INVALID');
  /* Known class but an unlisted code (a new raise in a later migration), any
     PGRST code, a 401/403 from PostgREST on the server's own token: internal.
     The status is kept as a number only, beside the database's code. */
  return new AppError('E_INTERNAL', { postgrestStatus: status, dbCode: dbErrorCode(body) });
}
