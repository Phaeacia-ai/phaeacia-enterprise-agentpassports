/* Installation rules (E5 design 1.4, 1.5, 3.2 and 4.1), pure. Hints, labels and one arithmetic; the database decides.

   Each rule has one SQL twin and a check that holds the two together, so a change to one copy that the other does not
   make fails a test instead of drifting:
     installationStatusOf   app.installation_statuses(): pass, partial, fail, removed. `removed` means "I have taken
                            this configuration out of my assistant", which is what makes E4's withdrawal checklist
                            actionable;
     lossesRequired         api.report_installation row 24 and the report_losses_required CHECK: a partial or failed
                            installation with no statement of what did not come across is not evidence. A
                            whitespace-only losses is not an absent one: it trims to nothing and is E_BODY_INVALID from
                            the shared text rule before this is asked (E5D-C-F9);
     newestReport           no SQL twin: no routine answers a newest report, because every read hands the service a
                            membership's own reports and the service composes `my.lastReport` from them. One rule all
                            the same, in one place, because three surfaces name the same report and a disagreement
                            between them is what E5S-C-F1 was;
     checkInDueAt           app.check_in_interval(): a pair is due when the membership has an authorization, the FIRST
                            of them is at least fourteen days old, and there is no report. First, not last, so a
                            recipient cannot postpone a check-in for ever by downloading again; derived, never stored,
                            so it cannot go stale and needs no sweep. tests/e3/unit/migration-text.test.mjs pins
                            CHECK_IN_INTERVAL_DAYS against the migration's own text;
     labelOf, witnessLabelOf, authorizationLabelOf, statusName
                            every sentence any client renders about an installation (design 1.5). A label says who
                            stated something and, for a witness, the role they held at the moment; it never says that
                            anything was independently established. The word "verified" appears on no installation
                            label, and refusedLabelTokens is the check that keeps it that way.

   What these labels may not claim, stated here because it is the rule and not a preference: a ledger row proves that
   the server authorized a download, and nothing more. It does not prove that anybody installed anything, or that the
   bytes were ever opened. So authorizationLabelOf speaks of an authorized download, and only a report by the recipient
   moves a surface to installation words (E5D-C-F5).

   Code points are compared as numbers and no sentence is built by concatenation of caller text, because lib/ refuses
   escape sequences in source and because a label is a fixed string or it is not a label. */

/** The statuses a recipient and a witness may choose, in app.installation_statuses() order. */
export const INSTALLATION_STATUSES = Object.freeze(['pass', 'partial', 'fail', 'removed']);
/** Who produced a row, in app.installation_sources() order. The server sets it; no routine takes it as a parameter. */
export const INSTALLATION_SOURCES = Object.freeze(['recipient_app', 'recipient_mail', 'founder_run']);
/** The roles a witness may hold, in the order api.witness_installation picks one when a membership holds several. */
export const WITNESS_ROLES = Object.freeze(['it_reviewer', 'business_reviewer', 'company_admin']);
/** app.check_in_interval(), in days. */
export const CHECK_IN_INTERVAL_DAYS = 14;
const CHECK_IN_INTERVAL_MS = CHECK_IN_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
/** The per-pair and per-report ceilings of design 1.2 and 1.4, the values migration 007 holds. */
export const LIMIT_DOWNLOADS_PER_RECIPIENT = 200;
export const LIMIT_REPORTS_PER_RECIPIENT = 20;
export const LIMIT_WITNESSES_PER_REPORT = 10;
/** The words no installation label carries (design 1.5). Compared case-insensitively over the whole sentence. */
export const REFUSED_LABEL_TOKENS = Object.freeze(['verified', 'validated', 'confirmed working', 'certified']);

const INVALID = Object.freeze({ ok: false, code: 'E_BODY_INVALID' });

/* One sentence per source. The status does not change it: provenance is what a label states, and the status is
   rendered beside it by its own plain name, so no client has to compose a sentence from two values. */
const SOURCE_LABELS = Object.freeze({
  recipient_app: 'Recipient-reported',
  recipient_mail: 'Recipient-reported through a check-in mail',
  founder_run: 'Founder-run transfer, recorded by the operator',
});
const WITNESS_LABELS = Object.freeze({
  it_reviewer: 'Witnessed by an IT reviewer',
  business_reviewer: 'Witnessed by a business reviewer',
  company_admin: 'Witnessed by a company administrator',
});
/* The plain names of design 4.1 item 3, which a page shows beside the radio buttons and beside a stored status. */
const STATUS_NAMES = Object.freeze({
  pass: 'It works',
  partial: 'It partly works',
  fail: 'It does not work',
  removed: 'I have removed it',
});

/**
 * installationStatusOf(value) -> { ok: true, value } | { ok: false, code: 'E_BODY_INVALID' }
 */
export function installationStatusOf(value) {
  return typeof value === 'string' && INSTALLATION_STATUSES.includes(value) ? { ok: true, value } : INVALID;
}

/** lossesRequired(status) -> true for the two statuses that are not evidence without a statement of what was lost. */
export function lossesRequired(status) {
  return status === 'partial' || status === 'fail';
}

/**
 * checkInDueAt(firstAuthorizedAt, reports, now) -> { checkInDue, checkInDueAt }
 * firstAuthorizedAt: the ISO time of the membership's FIRST authorization of this release, or null when it has none.
 * reports: the membership's own reports of this release; any one of them, whatever its status, clears the check-in.
 * now: the ISO time the answer is composed at.
 * Both fields are null when there is no authorization, and checkInDueAt is null once a report has cleared it, so a page
 * cannot render a date for a state that no longer exists.
 */
export function checkInDueAt(firstAuthorizedAt, reports, now) {
  const cleared = Object.freeze({ checkInDue: false, checkInDueAt: null });
  if (typeof firstAuthorizedAt !== 'string') return cleared;
  const first = Date.parse(firstAuthorizedAt);
  if (!Number.isFinite(first)) return cleared;
  if (Array.isArray(reports) && reports.length > 0) return cleared;
  const due = first + CHECK_IN_INTERVAL_MS;
  const at = typeof now === 'string' ? Date.parse(now) : Number.NaN;
  return Object.freeze({
    checkInDue: Number.isFinite(at) && at >= due,
    checkInDueAt: new Date(due).toISOString(),
  });
}

/* The ordering of a membership's own reports, in one place (E5S-C-F1, design amendment 2026-09-17 item 3). A read
   answers rows in whatever order it likes: api.installation_reports is ordered by id, which is a random uuid, so the
   last row of a read is not the last report. `reported_at` is the server's own time, set by the routine, and it is what
   "newest" means. The tie is broken by id so that two reports of the same millisecond order the same way on every
   surface and in every read; the value of the tie rule is that it is fixed, not that id means anything.

   An unparseable or absent `reported_at` sorts oldest rather than throwing: these rows come from the database, where the
   column is NOT NULL, so this is the shape a caller could only reach by handing in something else, and the safe answer
   there is the one that does not promote a row over a real report. */
const reportedAtMs = (row) => {
  const at = Date.parse(row?.reported_at);
  return Number.isFinite(at) ? at : -Infinity;
};
/* The column is timestamptz at microsecond resolution and Date.parse keeps milliseconds, so two reports inside one
   millisecond would tie and fall to the id, which is the defect this rule exists to end, narrowed to a millisecond
   (E5C-R-F1, evidence/batch-2-review.md). The digits after the third fractional place break that tie before the id
   does: "…:05.000900+00:00" answers 900000 (the six places after the millisecond, read as one integer, so only the
   order of two values means anything; B3-R-F8), an absent or shorter fraction answers 0. */
const reportedAtSubMs = (row) => {
  const m = typeof row?.reported_at === 'string' ? /\.(\d+)/.exec(row.reported_at) : null;
  if (m === null) return 0;
  return Number(m[1].padEnd(9, '0').slice(3, 9));
};
const reportIdOf = (row) => (typeof row?.id === 'string' ? row.id : '');

/**
 * compareReports(a, b) -> a negative number, zero or a positive number, ordering two report rows oldest first: by
 * `reported_at` to the microsecond, ties broken by `id`. Total and antisymmetric, so `sort` is deterministic whatever order the read
 * returned and two rows of the same time cannot swap between two calls.
 */
export function compareReports(a, b) {
  const at = reportedAtMs(a);
  const bt = reportedAtMs(b);
  if (at !== bt) return at < bt ? -1 : 1;
  const au = reportedAtSubMs(a);
  const bu = reportedAtSubMs(b);
  if (au !== bu) return au < bu ? -1 : 1;
  const ai = reportIdOf(a);
  const bi = reportIdOf(b);
  if (ai === bi) return 0;
  return ai < bi ? -1 : 1;
}

/**
 * newestReport(reports) -> the one report of `reports` with the greatest `reported_at`, ties broken by the greater
 * `id`, or null for an empty or absent list. A single pass, so it does not depend on the order it was given and does
 * not reorder the caller's array.
 */
export function newestReport(reports) {
  if (!Array.isArray(reports)) return null;
  let newest = null;
  for (const row of reports) {
    if (row === null || typeof row !== 'object') continue;
    if (newest === null || compareReports(row, newest) > 0) newest = row;
  }
  return newest;
}

/**
 * labelOf({ source, status }) -> the one sentence a client renders about who stated this report.
 * Throws TypeError for a source or a status outside the vocabularies, so an unknown pair can never reach a page as an
 * empty string.
 */
export function labelOf({ source, status } = {}) {
  if (!INSTALLATION_SOURCES.includes(source)) throw new TypeError(`labelOf: ${String(source)} is not a source`);
  if (!INSTALLATION_STATUSES.includes(status)) throw new TypeError(`labelOf: ${String(status)} is not a status`);
  return SOURCE_LABELS[source];
}

/** witnessLabelOf({ witnessRole, status }) -> the sentence naming the role held at the moment of witnessing. */
export function witnessLabelOf({ witnessRole, status } = {}) {
  if (!WITNESS_ROLES.includes(witnessRole)) throw new TypeError(`witnessLabelOf: ${String(witnessRole)} is not a role`);
  if (!INSTALLATION_STATUSES.includes(status)) throw new TypeError(`witnessLabelOf: ${String(status)} is not a status`);
  return WITNESS_LABELS[witnessRole];
}

/**
 * authorizationLabelOf({ authorizations }) -> what the ledger alone supports (E5D-C-F5).
 * A ledger row is the server's statement that it handed over the bytes, so the sentence speaks of an authorized
 * download and never of an installation. Zero authorizations has no label.
 */
export function authorizationLabelOf({ authorizations } = {}) {
  if (!Number.isInteger(authorizations) || authorizations < 0)
    throw new TypeError('authorizationLabelOf: authorizations is not a count');
  if (authorizations === 0) return null;
  return authorizations === 1 ? 'Download authorized' : `Download authorized ${authorizations} times`;
}

/** statusName(status) -> the plain name of design 4.1 item 3. */
export function statusName(status) {
  if (!INSTALLATION_STATUSES.includes(status)) throw new TypeError(`statusName: ${String(status)} is not a status`);
  return STATUS_NAMES[status];
}

/**
 * labelTable() -> every sentence this module can produce, each with the values that produce it. The label gate reads
 * this rather than the source text, so a sentence added without a check is still checked.
 */
export function labelTable() {
  const rows = [];
  for (const source of INSTALLATION_SOURCES)
    for (const status of INSTALLATION_STATUSES)
      rows.push({ kind: 'report', source, status, label: labelOf({ source, status }) });
  for (const witnessRole of WITNESS_ROLES)
    for (const status of INSTALLATION_STATUSES)
      rows.push({ kind: 'witness', witnessRole, status, label: witnessLabelOf({ witnessRole, status }) });
  for (const status of INSTALLATION_STATUSES) rows.push({ kind: 'status', status, label: statusName(status) });
  for (const authorizations of [1, 2])
    rows.push({ kind: 'ledger', authorizations, label: authorizationLabelOf({ authorizations }) });
  return Object.freeze(rows.map((r) => Object.freeze(r)));
}

/**
 * refusedLabelTokens(text) -> the tokens of REFUSED_LABEL_TOKENS the text carries, lowercased, in vocabulary order.
 * A string check over a fixed list, not a content detector, and it is stated as that: it catches the four words this
 * product must never put beside an installation status, and it claims nothing about any other sentence.
 */
export function refusedLabelTokens(text) {
  if (typeof text !== 'string') throw new TypeError('refusedLabelTokens: text is not a string');
  const haystack = text.toLowerCase();
  return REFUSED_LABEL_TOKENS.filter((token) => haystack.includes(token));
}
