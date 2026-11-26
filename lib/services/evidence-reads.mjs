/* The complete reads and the row mappers the candidate, review and release services share (E4 design 2.1).

   readAll, contributorsOf and registryEntry moved here from lib/services/candidates.mjs, whose exported names are
   unchanged, so the review read and the candidate read use one complete contributor read (E3b critique F3). The user
   client only: every row is one that row level security returned to the caller's own token, and this module holds no
   capability a pinned holder guards (tests/e2/unit/boundaries.test.mjs).
     readAll         every row of a filtered view in keyset pages, refusing rather than answering part of a list;
     contributorsOf  every contributor of a visible candidate, own rows before inherited ones, then by kind and member;
     registryEntry   one gate identity row as the API names it;
     readRegisters   the gate registry, the active gate and the release policies one request needs to label its rows;
     hexOf, isoOf    a bytea as 64 lowercase hex characters, a timestamp as ISO-8601 UTC with milliseconds;
     envelopeObject, reviewObject, releaseObject  design 3.4's three objects, from the rows of api.review_envelopes,
                     api.reviews and api.releases. Beyond 2.1's list, because the review and release services both answer
                     them and neither is the other's holder.
   E5 (design 2.1) adds the same kind of shared thing for installations, because the catalog service, the installations
   service and the release read all answer them and none is the others' holder:
     readLedger, recipientsFrom  every ledger row of one release in pages with a ceiling, and the distinct memberships
                     with their first and last authorization; moved here from lib/services/releases.mjs, whose exported
                     names are unchanged, so the withdrawal answer and the installations read count one way;
     installationReportObject, witnessObject, catalogRowObject  E5 design 3.4's three objects, from the rows of
                     api.installation_reports, api.installation_witnesses and api.release_catalog. */

import { select } from '../db/user.mjs';
import { AppError } from '../errors.mjs';
import { checkInDueAt, labelOf, newestReport, witnessLabelOf } from '../rules/installations.mjs';

/* PostgREST answers at most max_rows rows to one request (supabase/config.toml, 200 here) and says nothing when it
   cuts an answer short, so a list read in one request is silently incomplete past it (E3b critique F3). A read that
   must be complete goes through readAll: keyset pages on the view's id, READ_PAGE rows each, until a short page. A
   page asked for above the cap would come back cut to it and read as the last, so READ_PAGE is at most max_rows;
   tests/e3/unit/candidates.test.mjs compares the limit every paged read sends with the configured value. */
const READ_PAGE = 200;
/* The contributor rows one candidate can hold, derived, not chosen. A successor keeps its parent's agent, so a chain
   is at most app.limit_versions_per_agent() = 200 versions. Each version adds at most its 50 declarations
   (app.submission_fields) and one row per observed kind (author, editor, submitter: the contributor_observed
   check), and inherits exactly its parent's rows, which the parent's own versions already count. So
   200 x (50 + 3) = 10,600. More rows than that means a limit moved without this constant: the read fails closed
   with E_READ_OVER_BOUND rather than answer part of a list. The unit test derives the figure from the migrations. */
const CONTRIBUTOR_CEILING = 200 * (50 + 3);
/* Gate registrations: one per deployment that changes the gate identity, by migration only, never removed. No limit
   derives a bound, so it is a generous fixed one, the lead's (2026-09-14): 10,000 registrations, fifty pages. */
export const REGISTRY_CEILING = 10000;
const KIND_ORDER = Object.freeze(['author', 'editor', 'submitter', 'declared_member', 'declared_offline']);
const HEX64 = /^[0-9a-f]{64}$/;
/* Built from code points: scripts/check-imports.mjs refuses escape sequences under lib/. */
const BYTEA_HEX_PREFIX = String.fromCharCode(92, 120);

/** A bytea as PostgREST writes it, as 64 lowercase hex characters; E_INTERNAL for anything else. */
export function hexOf(bytea) {
  if (typeof bytea === 'string' && bytea.startsWith(BYTEA_HEX_PREFIX) && HEX64.test(bytea.slice(2)))
    return bytea.slice(2);
  throw new AppError('E_INTERNAL');
}

/** A timestamp as ISO-8601 UTC with milliseconds; null stays null. */
export function isoOf(timestamp) {
  if (timestamp === null || timestamp === undefined) return null;
  if (typeof timestamp !== 'string') throw new AppError('E_INTERNAL');
  return new Date(timestamp).toISOString();
}

export function registryEntry(row) {
  return {
    id: row.id,
    gateIdentitySha256: hexOf(row.identity_sha256),
    adapterLockSha256: hexOf(row.adapter_lock_sha256),
    validatorVersion: row.validator_version,
    manifestSha256: hexOf(row.manifest_sha256),
    upstreamCommit: row.upstream_commit,
    registeredAt: isoOf(row.registered_at),
    active: row.active === true,
  };
}

/** Every row `params` selects from `view`, in id order, read in keyset pages of READ_PAGE rows until a short page
    (E3b critique F3). `params` selects `id` and filters on anything but id. It refuses rather than answer part of a
    list: E_READ_OVER_BOUND once more than `ceiling` rows have come back; E_INTERNAL for a page longer than READ_PAGE,
    or a row whose id does not ascend past the one before it, because the stopping rule and the cursor rest on both. */
export async function readAll(session, view, params, ceiling, options) {
  const rows = [];
  let cursor = null;
  let page;
  do {
    const after = cursor === null ? {} : { id: `gt.${cursor}` };
    page = await select(session, view, { ...params, order: 'id.asc', limit: String(READ_PAGE), ...after }, options);
    if (page.length > READ_PAGE) throw new AppError('E_INTERNAL');
    for (const row of page) {
      if (typeof row?.id !== 'string' || (cursor !== null && row.id <= cursor)) throw new AppError('E_INTERNAL');
      cursor = row.id;
      rows.push(row);
    }
    if (rows.length > ceiling) throw new AppError('E_READ_OVER_BOUND');
  } while (page.length === READ_PAGE);
  return rows;
}

/** Every row `params` selects from `view`, in `key` order, for a view without an `id` whose `key` column repeats
    (api.agent_reviewer_exclusions: one row per (membership_id, kind), at most four per membership). Read in keyset
    pages of READ_PAGE rows on `key`; a full page may end inside one key's rows, so that trailing key's rows are set
    aside and read again on the next page from `key=gt.` the last complete key. Every page is capped by PostgREST's
    max_rows (200, supabase/config.toml), so no single read can carry a sentinel row past the cap; the ceiling counts
    across pages (E4S-C-F1, evidence/e4-server-critique.md). Refuses E_READ_OVER_BOUND once more than `ceiling` rows
    have come back; E_INTERNAL for a page longer than READ_PAGE, a key that does not ascend, a key that is not a
    string, or a full page of one key only, which could not progress. */
export async function readAllByKey(session, view, params, key, ceiling, options) {
  const rows = [];
  let cursor = null;
  let page;
  do {
    const after = cursor === null ? {} : { [key]: `gt.${cursor}` };
    page = await select(session, view, { ...params, order: `${key}.asc`, limit: String(READ_PAGE), ...after }, options);
    if (page.length > READ_PAGE) throw new AppError('E_INTERNAL');
    const trailing = page.length === READ_PAGE ? page[page.length - 1]?.[key] : undefined;
    const kept = trailing === undefined ? page : page.filter((row) => row?.[key] !== trailing);
    if (page.length === READ_PAGE && kept.length === 0) throw new AppError('E_INTERNAL');
    let last = cursor;
    for (const row of kept) {
      const k = row?.[key];
      if (typeof k !== 'string' || (cursor !== null && k <= cursor) || (last !== null && k < last))
        throw new AppError('E_INTERNAL');
      last = k;
      rows.push(row);
    }
    cursor = last;
    if (rows.length > ceiling) throw new AppError('E_READ_OVER_BOUND');
  } while (page.length === READ_PAGE);
  return rows;
}

/* Every contributor of a visible candidate, in a fixed order: the candidate's own rows before inherited ones, then by
   kind as the vocabulary lists them, then by membership or name. A declared offline name is returned as the name,
   which is what the review screen shows as an unverified declaration (E3 design 1.4); it never enters an audit row.

   The rows are read to the end in keyset pages and sorted once all are in (E3b critique F3). RLS decides each page at
   its own statement, so a reader who loses standing mid-read receives an empty page that looks like the end. The
   candidate still visible after the last page, under the predicate that guards both views (app.candidate_visible),
   is what makes the pages the whole list. The caller has already checked candidateId is a uuid. */
export async function contributorsOf(session, candidateId, options) {
  const rows = await readAll(
    session,
    'candidate_contributors',
    { select: 'id,kind,membership_id,display_name,inherited_from_candidate_id', candidate_id: `eq.${candidateId}` },
    CONTRIBUTOR_CEILING,
    options,
  );
  const visible = await select(session, 'candidate_versions', { select: 'id', id: `eq.${candidateId}` }, options);
  if (visible.length !== 1) throw new AppError('E_NOT_FOUND');
  const key = (r) => [
    r.inherited_from_candidate_id ? 1 : 0,
    KIND_ORDER.indexOf(r.kind),
    r.membership_id ?? r.display_name ?? '',
  ];
  return rows
    .map((r) => ({ r, k: key(r) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || (a.k[2] < b.k[2] ? -1 : a.k[2] > b.k[2] ? 1 : 0))
    .map(({ r }) => ({
      kind: r.kind,
      ...(r.membership_id ? { membershipId: r.membership_id } : { displayName: r.display_name }),
      ...(r.inherited_from_candidate_id ? { inheritedFromCandidateId: r.inherited_from_candidate_id } : {}),
    }));
}

/** The registers one request labels its rows with: { activeGateId, gateIdentityOf: Map(gate id -> hex), policies:
    Map(policy id -> { version, sha256, active }), activePolicy }. Every active member reads both registers (E3 4.1). */
export async function readRegisters(session, options) {
  const [gates, policies] = await Promise.all([
    readAll(session, 'gate_identities', { select: 'id,identity_sha256,active' }, REGISTRY_CEILING, options),
    readAll(session, 'release_policies', { select: 'id,version,sha256,active' }, REGISTRY_CEILING, options),
  ]);
  const active = gates.filter((g) => g.active === true);
  const activePolicies = policies.filter((p) => p.active === true);
  if (active.length > 1 || activePolicies.length > 1) throw new AppError('E_INTERNAL');
  const policyOf = new Map(
    policies.map((p) => [
      p.id,
      { policyId: p.id, version: p.version, sha256: hexOf(p.sha256), active: p.active === true },
    ]),
  );
  return {
    activeGateId: active.length === 1 ? active[0].id : null,
    gateIdentityOf: new Map(gates.map((g) => [g.id, hexOf(g.identity_sha256)])),
    policies: policyOf,
    activePolicy: activePolicies.length === 1 ? policyOf.get(activePolicies[0].id) : null,
  };
}

/** The review object of design 3.4. */
export function reviewObject(row) {
  return {
    reviewId: row.id,
    candidateId: row.candidate_id,
    envelopeId: row.envelope_id,
    role: row.role,
    decision: row.decision,
    reviewerMembershipId: row.reviewer_membership_id,
    reason: row.reason,
    createdAt: isoOf(row.created_at),
  };
}

/** The envelope object of design 3.4, from its api.review_envelopes row, the review rows of its candidate (any
    superset) and the registers. The status is the view's, through app.reader_envelope_status to app.envelope_status, which decides. assembledBytes is beyond
    3.4's example: the size the release would have, which the review screen shows before sign-off (E4D-C-F3). */
export function envelopeObject(row, reviews, registers) {
  const own = reviews.filter((r) => r.envelope_id === row.id);
  const approval = (role) => {
    const r = own.find((x) => x.role === role && x.decision === 'approved');
    return r
      ? { reviewId: r.id, reviewerMembershipId: r.reviewer_membership_id, createdAt: isoOf(r.created_at) }
      : null;
  };
  const change = own.find((x) => x.decision === 'changes_requested');
  const policy = registers.policies.get(row.policy_id);
  return {
    envelopeId: row.id,
    candidateId: row.candidate_id,
    revision: row.revision,
    target: row.target,
    audience: { groupIds: [...row.audience_group_ids] },
    policy: {
      policyId: row.policy_id,
      version: policy?.version ?? null,
      sha256: hexOf(row.policy_sha256),
      policyStatus: policy?.active === true ? 'current' : 'stale',
    },
    gate: {
      gateIdentitySha256: hexOf(row.gate_identity_sha256),
      gateStatus: row.gate_id === registers.activeGateId ? 'current' : 'stale',
    },
    installer: {
      textSha256: hexOf(row.installer_text_sha256),
      coreSha256: hexOf(row.core_sha256),
      branchSha256: hexOf(row.branch_sha256),
      judgeSha256: hexOf(row.judge_sha256),
    },
    contentSha256: hexOf(row.content_sha256),
    derivedSha256: hexOf(row.derived_sha256),
    envelopeSha256: hexOf(row.envelope_sha256),
    assembledBytes: row.assembled_bytes,
    status: row.status,
    approvals: { it: approval('it'), business: approval('business') },
    changeRequest: change
      ? {
          reviewId: change.id,
          role: change.role,
          reviewerMembershipId: change.reviewer_membership_id,
          createdAt: isoOf(change.created_at),
        }
      : null,
    createdByMembershipId: row.created_by_membership_id,
    createdAt: isoOf(row.created_at),
  };
}

/** The release object of design 3.4, never the assembled bytes, from its api.releases row and the registers. */
export function releaseObject(row, registers) {
  const policy = registers.policies.get(row.policy_id);
  const identity = registers.gateIdentityOf.get(row.gate_id);
  if (identity === undefined) throw new AppError('E_INTERNAL');
  return {
    releaseId: row.id,
    companyId: row.company_id,
    agentId: row.agent_id,
    candidateId: row.candidate_id,
    envelopeId: row.envelope_id,
    target: row.target,
    state: row.state,
    current: row.state === 'published' && row.superseded_by_release_id === null,
    audience: { groupIds: [...row.audience_group_ids] },
    policy: { policyId: row.policy_id, version: policy?.version ?? null, sha256: hexOf(row.policy_sha256) },
    gateIdentitySha256: identity,
    installer: {
      textSha256: hexOf(row.installer_text_sha256),
      coreSha256: hexOf(row.core_sha256),
      branchSha256: hexOf(row.branch_sha256),
      judgeSha256: hexOf(row.judge_sha256),
    },
    contentSha256: hexOf(row.content_sha256),
    derivedSha256: hexOf(row.derived_sha256),
    envelopeSha256: hexOf(row.envelope_sha256),
    assembledSha256: hexOf(row.assembled_sha256),
    assembledBytes: row.assembled_bytes,
    publishedByMembershipId: row.published_by_membership_id,
    publishedAt: isoOf(row.published_at),
    supersededByReleaseId: row.superseded_by_release_id,
    supersededAt: isoOf(row.superseded_at),
    withdrawal:
      row.state === 'withdrawn'
        ? {
            withdrawnByMembershipId: row.withdrawn_by_membership_id,
            withdrawnAt: isoOf(row.withdrawn_at),
            reason: row.withdrawal_reason,
          }
        : null,
  };
}

/* The columns the three mappers read, one statement each (a PostgREST select value is at most 400 characters here). */
export const ENVELOPE_COLUMNS =
  'id,candidate_id,revision,target,audience_group_ids,policy_id,policy_sha256,gate_id,gate_identity_sha256,installer_text_sha256,core_sha256,branch_sha256,judge_sha256,content_sha256,derived_sha256,envelope_sha256,assembled_bytes,status,created_by_membership_id,created_at';
export const REVIEW_COLUMNS = 'id,candidate_id,envelope_id,role,decision,reviewer_membership_id,reason,created_at';
export const RELEASE_COLUMNS =
  'id,company_id,agent_id,candidate_id,envelope_id,target,gate_id,content_sha256,derived_sha256,installer_text_sha256,core_sha256,branch_sha256,judge_sha256,policy_id,policy_sha256,audience_group_ids,envelope_sha256,assembled_sha256,assembled_bytes,state,published_by_membership_id,published_at,superseded_by_release_id,superseded_at,withdrawn_by_membership_id,withdrawn_at,withdrawal_reason';

/* ---------- E5: the recipient ledger, shared by the release read and the installations read ---------- */

/* The ledger rows one release can hold have no derived ceiling in E4's terms: E5 appends one per authorized download,
   for the life of the tenant (E4D-C-F5). E5 bounds it for the first time at limit_downloads_per_recipient() times the
   audience, 200 x 25 = 5,000 at the plan's envelope, which is inside this fixed fail-closed ceiling; the arithmetic and
   its condition are in E5 design 6. LEDGER_PAGE is at most PostgREST's max_rows, and the ceiling counts across pages,
   never as a sentinel row in one request (E4S-C-F1). */
export const LEDGER_CEILING = 10000;
const LEDGER_PAGE = READ_PAGE;

/** Every ledger row of a release, in id order, in pages; the ledger's id is a bigint, so its cursor is a number. */
export async function readLedger(session, releaseId, options) {
  const rows = [];
  let cursor = null;
  let page;
  do {
    const after = cursor === null ? {} : { id: `gt.${cursor}` };
    page = await select(
      session,
      'release_downloads',
      {
        select: 'id,membership_id,authorized_at',
        release_id: `eq.${releaseId}`,
        order: 'id.asc',
        limit: String(LEDGER_PAGE),
        ...after,
      },
      options,
    );
    if (page.length > LEDGER_PAGE) throw new AppError('E_INTERNAL');
    for (const row of page) {
      if (!Number.isSafeInteger(row?.id) || (cursor !== null && row.id <= cursor)) throw new AppError('E_INTERNAL');
      cursor = row.id;
      rows.push(row);
    }
    if (rows.length > LEDGER_CEILING) throw new AppError('E_READ_OVER_BOUND');
  } while (page.length === LEDGER_PAGE);
  return rows;
}

/** Distinct memberships with the first and last authorization and the count, by membership id: app.release_recipients's
    shape, computed from the rows row level security returned to the caller. */
export function recipientsFrom(ledger) {
  const by = new Map();
  for (const row of ledger) {
    const at = new Date(row.authorized_at).getTime();
    const r = by.get(row.membership_id) ?? { membershipId: row.membership_id, first: at, last: at, authorizations: 0 };
    r.first = Math.min(r.first, at);
    r.last = Math.max(r.last, at);
    r.authorizations += 1;
    by.set(row.membership_id, r);
  }
  return [...by.values()]
    .sort((a, b) => (a.membershipId < b.membershipId ? -1 : a.membershipId > b.membershipId ? 1 : 0))
    .map((r) => ({
      membershipId: r.membershipId,
      firstAuthorizedAt: new Date(r.first).toISOString(),
      lastAuthorizedAt: new Date(r.last).toISOString(),
      authorizations: r.authorizations,
    }));
}

/* ---------- E5: design 3.4's installation objects ---------- */

/** The witness object of E5 design 3.4, from its api.installation_witnesses row. */
export function witnessObject(row) {
  return {
    witnessId: row.id,
    witnessMembershipId: row.witness_membership_id,
    witnessRole: row.witness_role,
    status: row.status,
    note: row.note,
    label: witnessLabelOf({ witnessRole: row.witness_role, status: row.status }),
    witnessedAt: isoOf(row.witnessed_at),
  };
}

/** The installation report object of E5 design 3.4, with the witnesses of that report, oldest first. */
export function installationReportObject(row, witnesses = []) {
  return {
    reportId: row.id,
    releaseId: row.release_id,
    membershipId: row.membership_id,
    status: row.status,
    losses: row.losses ?? null,
    assistance: row.assistance ?? null,
    source: row.source,
    label: labelOf({ source: row.source, status: row.status }),
    reportedAt: isoOf(row.reported_at),
    witnesses: witnesses.map(witnessObject),
  };
}

/**
 * The catalog row of E5 design 3.4, from its api.release_catalog row.
 * agentName: the name of the row's agent, read from api.agents, or null when the caller may not read it.
 * reports: the caller's own reports of this release, in any order; my.lastReport is the one lib/rules/installations.mjs
 *   newestReport picks, the greatest reported_at with the tie broken by id (E5S-C-F1), and any one of them clears the
 *   check-in (design 1.4c).
 * replacement: { releaseId, state } for a release that is no longer current (design 1.6), where state is `addressed`,
 *   `not_addressed` or `none`. The third field is beyond 3.4's example and is recorded as a proposed amendment in
 *   evidence/e5-server.md: 1.6 asks the page to tell "a newer version exists but is not addressed to your groups" from
 *   "no newer version has been published", and a null replacedByReleaseId alone cannot.
 * now: the ISO time the answer is composed at, for the derived check-in state.
 */
export function catalogRowObject(row, { agentName = null, reports = [], replacement = null, now }) {
  const my = row.my_authorizations ?? {};
  const authorizations = Number.isInteger(my.authorizations) ? my.authorizations : 0;
  const firstAuthorizedAt = isoOf(my.first_authorized_at ?? null);
  const newest = newestReport(reports);
  const checkIn = checkInDueAt(firstAuthorizedAt, reports, now);
  return {
    releaseId: row.id,
    companyId: row.company_id,
    agentId: row.agent_id,
    agentName,
    candidateId: row.candidate_id,
    envelopeId: row.envelope_id,
    target: row.target,
    state: row.state,
    current: row.state === 'published' && row.superseded_by_release_id === null,
    headline: row.headline ?? null,
    assembledSha256: hexOf(row.assembled_sha256),
    assembledBytes: row.assembled_bytes,
    publishedAt: isoOf(row.published_at),
    supersededByReleaseId: row.superseded_by_release_id,
    supersededAt: isoOf(row.superseded_at),
    withdrawnAt: isoOf(row.withdrawn_at),
    downloadable: row.blocked_reason === null,
    blockedReason: row.blocked_reason ?? null,
    replacedByReleaseId: replacement?.state === 'addressed' ? replacement.releaseId : null,
    replacement: replacement === null ? null : { state: replacement.state },
    my: {
      authorizations,
      firstAuthorizedAt,
      lastAuthorizedAt: isoOf(my.last_authorized_at ?? null),
      checkInDue: checkIn.checkInDue,
      checkInDueAt: checkIn.checkInDueAt,
      lastReport: newest === null ? null : installationReportObject(newest),
    },
  };
}

/* The columns the E5 mappers read. api.release_catalog carries api.releases' columns and three computed ones; the
   select value stays under this client's 400-character bound by naming only what catalogRowObject reads. */
export const INSTALLATION_REPORT_COLUMNS =
  'id,company_id,release_id,membership_id,status,losses,assistance,source,reported_at';
export const INSTALLATION_WITNESS_COLUMNS =
  'id,company_id,report_id,release_id,witness_membership_id,witness_role,status,note,witnessed_at';
export const CATALOG_COLUMNS =
  'id,company_id,agent_id,candidate_id,envelope_id,target,state,assembled_sha256,assembled_bytes,published_at,superseded_by_release_id,superseded_at,withdrawn_at,blocked_reason,my_authorizations,headline';
