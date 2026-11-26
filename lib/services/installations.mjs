/* Installation evidence (E5 design 1.4, 1.5, 1.7, 3.3, 3.4 and 3.5): what a recipient states about what happened after
   a download, and what a second person states about that report. Results are plain data; failures are AppErrors.

   Each write meets its refusals in the order of design 3.5, and each service step sits where that table puts it:
     row 10   the Idempotency-Key header;
     row 11   the body's shape, the status vocabulary and the shared text rule, and the losses rule; nothing is read.
              A whitespace-only losses trims to nothing and is E_BODY_INVALID here, not E_LOSSES_REQUIRED, because the
              rule that judges it is E3's and E4's one text rule and this slice does not write a second one (E5D-C-F9);
     row 12   the release, or the report, read under the caller's own token, so row level security decides: unknown,
              foreign, stale and invisible all answer E_NOT_FOUND;
     rows 13 on  the routine, through callBound, which decides again under the company lock.
   Nothing here reads a state, a role or a claim to refuse early: those are the routine's, after its claim lookup
   (E3 4.3, H1).

   readInstallations composes one entry per membership from two reads, and the row level security of each read decides
   what it may carry (E5D-C-F3). The five ledger fields, authorizations, firstAuthorizedAt, lastAuthorizedAt,
   checkInDue and checkInDueAt, appear only where E4's app.ledger_visible admits the caller, which is a company admin
   or the agent's owner, or where the entry is the caller's own, which app.my_authorizations answers about nobody else.
   A reviewer reads the company's reports and witnesses because a witness who cannot read a report cannot make a
   statement about it, and reads no ledger fact at all: their entries carry those five fields absent, not null, so a
   page cannot render a count or a date it was not given. The service never widens what the reads returned. */

import { callBound } from '../db/server.mjs';
import { select } from '../db/user.mjs';
import { AppError } from '../errors.mjs';
import { checkInDueAt, compareReports, installationStatusOf, lossesRequired } from '../rules/installations.mjs';
import { reviewReasonOf, uuidOf } from '../rules/reviews.mjs';
import * as evidence from './evidence-reads.mjs';
import { isUuid, loadPrincipal } from './principal.mjs';

const { INSTALLATION_REPORT_COLUMNS, INSTALLATION_WITNESS_COLUMNS } = evidence;
const { installationReportObject, readAll, readLedger, recipientsFrom, witnessObject } = evidence;

/* A release's reports are at most limit_reports_per_recipient() times the audience, 20 x 25 = 500 at the plan's
   envelope; its witnesses at most ten per report. No member limit derives a bound, so both ceilings are fixed and
   generous at twenty times the envelope, and each read fails closed with E_READ_OVER_BOUND above it rather than
   answering part of a list (design 6). readAll pages at PostgREST's max_rows and counts across pages, so no sentinel
   row is ever relied on (E4S-C-F1). */
const REPORTS_CEILING = 10000;
const WITNESSES_CEILING = 10000;
/* The reviewer roles of design 1.4b, which E2's app.role_names() owns. */
const REVIEWER_ROLES = Object.freeze(['it_reviewer', 'business_reviewer']);

const invalid = () => new AppError('E_BODY_INVALID');

function idempotencyKeyOf(value) {
  const key = uuidOf(value);
  if (key === null) throw new AppError('E_IDEMPOTENCY_KEY_INVALID');
  return key;
}

function objectWithKeys(body, allowed) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid();
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw invalid();
}

/* An optional text field: absent, null, or a string the shared rule accepts. Anything else, including a string that
   trims to nothing, is E_BODY_INVALID. */
function optionalText(value) {
  if (value === undefined || value === null) return null;
  const judged = reviewReasonOf(value);
  if (!judged.ok) throw invalid();
  return judged.value;
}

function requiredText(value) {
  const judged = reviewReasonOf(value);
  if (!judged.ok) throw invalid();
  return judged.value;
}

function statusOf(value) {
  const judged = installationStatusOf(value);
  if (!judged.ok) throw invalid();
  return judged.value;
}

/** POST /api/releases/{releaseId}/installations (design 1.4a, 3.4): 201 { ok, report }. */
export async function reportInstallation(session, { releaseId, idempotencyKey, body }, options = {}) {
  const key = idempotencyKeyOf(idempotencyKey);
  objectWithKeys(body, ['status', 'losses', 'assistance']);
  const status = statusOf(body.status);
  const losses = optionalText(body.losses);
  const assistance = optionalText(body.assistance);
  /* Row 11's last line: the page says so before the server does, and the server says it again (row 24). */
  if (losses === null && lossesRequired(status)) throw new AppError('E_LOSSES_REQUIRED');
  if (!isUuid(releaseId)) throw new AppError('E_NOT_FOUND');
  const visible = await select(session, 'releases', { select: 'id', id: `eq.${releaseId}` }, options);
  if (visible.length !== 1) throw new AppError('E_NOT_FOUND');
  const stored = await callBound(
    session,
    'report_installation',
    { release_id: releaseId, status, losses, assistance, idempotency_key: key },
    options,
  );
  if (typeof stored !== 'object' || stored === null || typeof stored.report_id !== 'string')
    throw new AppError('E_INTERNAL');
  return {
    ok: true,
    report: await readReport(session, stored.report_id, options),
    ...(stored.idempotent_replay === true ? { idempotentReplay: true } : {}),
  };
}

/** POST /api/installations/{reportId}/witness (design 1.4b, 3.4): 201 { ok, witness, report }. */
export async function witnessInstallation(session, { reportId, idempotencyKey, body }, options = {}) {
  const key = idempotencyKeyOf(idempotencyKey);
  objectWithKeys(body, ['status', 'note']);
  const status = statusOf(body.status);
  const note = requiredText(body.note);
  if (!isUuid(reportId)) throw new AppError('E_NOT_FOUND');
  const visible = await select(session, 'installation_reports', { select: 'id', id: `eq.${reportId}` }, options);
  if (visible.length !== 1) throw new AppError('E_NOT_FOUND');
  const stored = await callBound(
    session,
    'witness_installation',
    { report_id: reportId, status, note, idempotency_key: key },
    options,
  );
  if (typeof stored !== 'object' || stored === null || typeof stored.witness_id !== 'string')
    throw new AppError('E_INTERNAL');
  const rows = await select(
    session,
    'installation_witnesses',
    { select: INSTALLATION_WITNESS_COLUMNS, id: `eq.${stored.witness_id}` },
    options,
  );
  if (rows.length !== 1) throw new AppError('E_NOT_FOUND');
  return {
    ok: true,
    witness: witnessObject(rows[0]),
    report: await readReport(session, reportId, options),
    ...(stored.idempotent_replay === true ? { idempotentReplay: true } : {}),
  };
}

/* One report with its witnesses, oldest first. */
async function readReport(session, reportId, options) {
  const [rows, witnesses] = await Promise.all([
    select(session, 'installation_reports', { select: INSTALLATION_REPORT_COLUMNS, id: `eq.${reportId}` }, options),
    readAll(
      session,
      'installation_witnesses',
      { select: INSTALLATION_WITNESS_COLUMNS, report_id: `eq.${reportId}` },
      WITNESSES_CEILING,
      options,
    ),
  ]);
  if (rows.length !== 1) throw new AppError('E_NOT_FOUND');
  return installationReportObject(rows[0], witnesses);
}

/** GET /api/releases/{releaseId}/installations (design 3.4): { ok, releaseId, recipients, scope, truncated }. */
export async function readInstallations(session, { releaseId }, options = {}) {
  if (!isUuid(releaseId)) throw new AppError('E_NOT_FOUND');
  const releases = await select(
    session,
    'releases',
    { select: 'id,company_id,agent_id', id: `eq.${releaseId}` },
    options,
  );
  if (releases.length !== 1) throw new AppError('E_NOT_FOUND');
  const release = releases[0];
  const principal = await loadPrincipal(session, release.company_id, options);
  if (!principal.ok) throw new AppError(principal.code);
  const now = options.now ?? new Date().toISOString();

  const [agents, reports, witnesses] = await Promise.all([
    select(session, 'agents', { select: 'id,owner_membership_id', id: `eq.${release.agent_id}` }, options),
    readAll(
      session,
      'installation_reports',
      { select: INSTALLATION_REPORT_COLUMNS, release_id: `eq.${releaseId}` },
      REPORTS_CEILING,
      options,
    ),
    readAll(
      session,
      'installation_witnesses',
      { select: INSTALLATION_WITNESS_COLUMNS, release_id: `eq.${releaseId}` },
      WITNESSES_CEILING,
      options,
    ),
  ]);
  const ledgerVisible =
    principal.roles.includes('company_admin') || agents[0]?.owner_membership_id === principal.membershipId;
  const reviewer = REVIEWER_ROLES.some((r) => principal.roles.includes(r));
  const scope = ledgerVisible ? 'company' : reviewer ? 'company-reports' : 'own';

  const witnessesOf = new Map();
  for (const w of witnesses) {
    if (!witnessesOf.has(w.report_id)) witnessesOf.set(w.report_id, []);
    witnessesOf.get(w.report_id).push(w);
  }
  const reportsOf = new Map();
  for (const r of reports) {
    if (!reportsOf.has(r.membership_id)) reportsOf.set(r.membership_id, []);
    reportsOf.get(r.membership_id).push(r);
  }
  /* Oldest first by the one rule (E5S-C-F1; E5C-R-F2 found this third place still on the old comparator). The release
     page renders this list reversed and rests its derived states on the first row, so the order has to be the rule's. */
  for (const list of reportsOf.values()) list.sort(compareReports);
  const reportObjects = (membershipId) =>
    (reportsOf.get(membershipId) ?? []).map((r) => installationReportObject(r, witnessesOf.get(r.id) ?? []));

  let recipients;
  if (scope === 'company') {
    /* The ledger's distinct memberships, plus any membership with a report and no authorization, which api.report
       _installation cannot produce and which is not assumed away. */
    const ledger = recipientsFrom(await readLedger(session, releaseId, options));
    const known = new Set(ledger.map((r) => r.membershipId));
    const extra = [...reportsOf.keys()].filter((m) => !known.has(m)).sort();
    recipients = [
      ...ledger.map((r) => withCheckIn(r, reportsOf.get(r.membershipId) ?? [], now, reportObjects(r.membershipId))),
      ...extra.map((membershipId) => ({
        membershipId,
        authorizations: 0,
        firstAuthorizedAt: null,
        lastAuthorizedAt: null,
        checkInDue: false,
        checkInDueAt: null,
        reports: reportObjects(membershipId),
      })),
    ];
  } else if (scope === 'company-reports') {
    /* One entry per membership that has reported, with no ledger field present at all (E5D-C-F3). */
    recipients = [...reportsOf.keys()]
      .sort()
      .map((membershipId) => ({ membershipId, reports: reportObjects(membershipId) }));
  } else {
    const own = await select(
      session,
      'release_catalog',
      { select: 'id,my_authorizations', id: `eq.${releaseId}` },
      options,
    );
    const my = own[0]?.my_authorizations ?? {};
    const authorizations = Number.isInteger(my.authorizations) ? my.authorizations : 0;
    const ownReports = reportsOf.get(principal.membershipId) ?? [];
    recipients =
      authorizations === 0 && ownReports.length === 0
        ? []
        : [
            withCheckIn(
              {
                membershipId: principal.membershipId,
                authorizations,
                firstAuthorizedAt: evidence.isoOf(my.first_authorized_at ?? null),
                lastAuthorizedAt: evidence.isoOf(my.last_authorized_at ?? null),
              },
              ownReports,
              now,
              reportObjects(principal.membershipId),
            ),
          ];
  }
  /* readAll refuses rather than answering part of a list, so a short answer is impossible and this field is always
     false; it stays in the shape because design 3.4 names it and a client reads it. */
  return { ok: true, releaseId, recipients, scope, truncated: false };
}

function withCheckIn(entry, rawReports, now, reports) {
  const checkIn = checkInDueAt(entry.firstAuthorizedAt, rawReports, now);
  return {
    membershipId: entry.membershipId,
    authorizations: entry.authorizations,
    firstAuthorizedAt: entry.firstAuthorizedAt,
    lastAuthorizedAt: entry.lastAuthorizedAt,
    checkInDue: checkIn.checkInDue,
    checkInDueAt: checkIn.checkInDueAt,
    reports,
  };
}
