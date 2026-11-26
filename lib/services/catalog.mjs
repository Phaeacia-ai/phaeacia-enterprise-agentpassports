/* The catalog and the download (E5 design 1.1, 1.2, 1.3, 3.4 and 3.5): the list of releases a member may install or has
   installed, and the one write that sits inside B6's lock protocol. Results are plain data; failures are AppErrors.

   readCatalog answers one predicate's reading of every release row level security returns, never a second copy of it:
   api.release_catalog carries `blocked_reason` from app.download_refusal, so for every row whose blockedReason is null
   a download by that member authorizes, and for every row whose blockedReason is a code the download refuses with
   exactly that code, unless something changed between the two requests (design 1.1, case 13). The service decides only
   which of the two sections a row belongs to, and that decision is made from the row's own fields.

   The partition, and why it is not the one design 1.1 first wrote (E5D-C-F4). "Available to you" is every current
   release whose only refusal is something other than "not addressed to you": a target that was disabled after
   publication, an orphaned or archived agent and an exhausted per-recipient ceiling are all shown with their reason,
   because the member's company approved this agent for them and naming the block is more truthful than hiding the row
   (design 1.3, cases 8 and 9). "You installed earlier" is every other row the member has an authorization for, which
   is what keeps a still-current release in their history after they leave its audience, and with it their report entry
   point and their outstanding check-in. A row that is neither is not shown: a reviewer or an admin reads releases
   addressed to other people's groups, and the catalog is the member's own gallery, not the company's list.

   authorizeDownload meets its refusals in the order of design 3.5's download table: row 10, the release readable under
   the caller's own token; then the routine, which decides again under its own lock protocol. It takes no
   Idempotency-Key by decision (design 1.2): a download performs no state transition and has no fresh-only
   precondition, so an honest retry is a true second authorization and is answered as one. */

import { callAs } from '../db/server.mjs';
import { select } from '../db/user.mjs';
import { AppError } from '../errors.mjs';
import { lossRows } from '../passport/packet.mjs';
import { compareReports, LIMIT_REPORTS_PER_RECIPIENT } from '../rules/installations.mjs';
import * as evidence from './evidence-reads.mjs';
import { isUuid, loadPrincipal } from './principal.mjs';

const { CATALOG_COLUMNS, INSTALLATION_REPORT_COLUMNS, RELEASE_COLUMNS } = evidence;
const { catalogRowObject, readAll, readRegisters, releaseObject } = evidence;

/* 50 rows a page, keyset on the release id, sentinel limit 51. The sentinel is admissible only because 51 is below
   PostgREST's max_rows (200): a sentinel row is a valid stopping signal when page + 1 <= max_rows, and above it a read
   goes through readAll with a ceiling instead (E4S-C-F1, restated as a rule in design 1.1). */
const LIST_PAGE = 50;
/* The caller's own reports for the releases of one page: at most limit_reports_per_recipient() per release. */
const OWN_REPORTS_CEILING = LIST_PAGE * LIMIT_REPORTS_PER_RECIPIENT;
/* The current releases of the agents on one page, for the "what replaced it" link of design 1.6. One per agent and
   target, and no limit bounds the number of targets, so this is a generous fixed ceiling: twenty per agent, five times
   the four registered today, and the read fails closed above it rather than answering part of a list. E5 enumerates no
   target anywhere, so adding one is data to this service and not a change to it (design 7 scenario 1). */
const CURRENT_RELEASES_PER_AGENT = 20;

const invalid = () => new AppError('E_BODY_INVALID');
const inList = (ids) => `in.(${ids.join(',')})`;

/** GET /api/companies/{companyId}/catalog?cursor=<release id> (design 3.4): { ok, companyId, available, earlier, empty,
    nextCursor }. A caller who is not an active member of the company is E_NOT_FOUND; a malformed cursor is
    E_BODY_INVALID. options.now fixes the moment the derived check-in state is computed at. */
export async function readCatalog(session, { companyId, query = {} }, options = {}) {
  const cursor = Object.hasOwn(query, 'cursor') ? query.cursor : undefined;
  if (cursor !== undefined && !isUuid(cursor)) throw invalid();
  for (const k of Object.keys(query)) if (k !== 'cursor') throw invalid();
  const principal = await loadPrincipal(session, companyId, options);
  if (!principal.ok) throw new AppError(principal.code);
  const now = options.now ?? new Date().toISOString();

  const params = {
    select: CATALOG_COLUMNS,
    company_id: `eq.${companyId}`,
    order: 'id.asc',
    limit: String(LIST_PAGE + 1),
  };
  if (cursor !== undefined) params.id = `gt.${cursor}`;
  const rows = await select(session, 'release_catalog', params, options);
  const page = rows.slice(0, LIST_PAGE);
  const nextCursor = rows.length > LIST_PAGE ? page[page.length - 1].id : null;

  const agentIds = [...new Set(page.map((r) => r.agent_id))];
  const releaseIds = page.map((r) => r.id);
  const [agents, ownReports] = await Promise.all([
    agentIds.length === 0 ? [] : select(session, 'agents', { select: 'id,name', id: inList(agentIds) }, options),
    releaseIds.length === 0
      ? []
      : readAll(
          session,
          'installation_reports',
          {
            select: INSTALLATION_REPORT_COLUMNS,
            membership_id: `eq.${principal.membershipId}`,
            release_id: inList(releaseIds),
          },
          OWN_REPORTS_CEILING,
          options,
        ),
  ]);
  const nameOf = new Map(agents.map((a) => [a.id, a.name]));
  const reportsOf = new Map();
  for (const r of ownReports) {
    if (!reportsOf.has(r.release_id)) reportsOf.set(r.release_id, []);
    reportsOf.get(r.release_id).push(r);
  }
  /* Oldest first by the one rule (E5S-C-F1), so every reader of this list meets one order. The comparator it replaces
     answered 1 for two equal times, which is not antisymmetric and left a tie to the sort's own discretion; the row
     object no longer takes the newest report from a position, but a list handed on in a defined order is still worth
     more than one in the read's order. */
  for (const list of reportsOf.values()) list.sort(compareReports);

  const isAvailable = (r) =>
    r.state === 'published' && r.superseded_by_release_id === null && r.blocked_reason !== 'E_NOT_FOUND';
  const mine = (r) => Number.isInteger(r.my_authorizations?.authorizations) && r.my_authorizations.authorizations > 0;
  const availableRows = page.filter(isAvailable);
  const earlierRows = page.filter((r) => !isAvailable(r) && mine(r));
  const replacements = await replacementsFor(session, earlierRows, options);

  const rowOf = (r) =>
    catalogRowObject(r, {
      agentName: nameOf.get(r.agent_id) ?? null,
      reports: reportsOf.get(r.id) ?? [],
      replacement: replacements.get(r.id) ?? null,
      now,
    });
  const available = availableRows.map(rowOf);
  const earlier = earlierRows.map(rowOf);
  return {
    ok: true,
    companyId,
    available,
    earlier,
    empty: await emptyReason(session, principal, available.length + earlier.length, nextCursor, options),
    nextCursor,
  };
}

/* What replaced each release of `earlierRows`: the current release of the same agent and target, with whether it is
   addressed to this caller. `addressed` carries its id; `not_addressed` and `none` carry none, so no page can link a
   member to a release they may not read. The three states are beyond design 3.4's example and are the proposed
   amendment of evidence/e5-server.md: 1.6 asks the page to tell "a newer version exists but is not addressed to your
   groups" from "no newer version has been published", and a null replacedByReleaseId alone cannot. */
async function replacementsFor(session, earlierRows, options) {
  const out = new Map();
  if (earlierRows.length === 0) return out;
  const agentIds = [...new Set(earlierRows.map((r) => r.agent_id))];
  const currents = await readAll(
    session,
    'release_catalog',
    {
      select: 'id,agent_id,target,blocked_reason',
      agent_id: inList(agentIds),
      state: 'eq.published',
      superseded_by_release_id: 'is.null',
    },
    agentIds.length * CURRENT_RELEASES_PER_AGENT,
    options,
  );
  const currentOf = new Map(currents.map((c) => [`${c.agent_id}|${c.target}`, c]));
  for (const r of earlierRows) {
    const current = currentOf.get(`${r.agent_id}|${r.target}`);
    if (current === undefined || current.id === r.id) {
      out.set(r.id, { releaseId: null, state: 'none' });
    } else if (current.blocked_reason === 'E_NOT_FOUND') {
      out.set(r.id, { releaseId: null, state: 'not_addressed' });
    } else {
      out.set(r.id, { releaseId: current.id, state: 'addressed' });
    }
  }
  return out;
}

/* Why a catalog has no rows (design 1.3), null when it has some. Null too when a page is empty and a cursor follows
   it: that is a page continuation and not a statement that nothing exists, so the page offers the continuation rather
   than a terminal sentence (the design critique's rule 11). The two reads run only in the empty case. */
async function emptyReason(session, principal, shown, nextCursor, options) {
  if (shown > 0 || nextCursor !== null) return null;
  const [targets, groups] = await Promise.all([
    select(session, 'release_targets', { select: 'target', publishable: 'eq.true', limit: '1' }, options),
    select(
      session,
      'group_members',
      { select: 'group_id', membership_id: `eq.${principal.membershipId}`, limit: '1' },
      options,
    ),
  ]);
  if (targets.length === 0) return 'no_target_enabled';
  if (groups.length === 0) return 'no_groups';
  return 'none_for_my_groups';
}

/** POST /api/releases/{releaseId}/download (design 1.2, 3.4): { ok, release, assembledContent, assembledSha256,
    authorization, losses }. No body and no Idempotency-Key. The losses are this service's reading of the bytes the
    routine just returned, through the one parser the review screen uses over the same section 6. */
export async function authorizeDownload(session, { releaseId }, options = {}) {
  /* The malformed id is refused HERE and never reaches the database, which is this service's own row 12.
     THE VISIBILITY PRE-READ IS GONE (E6S-C-F2, the lead's grant of 2026-09-18). It was one read of app.releases
     under the CALLER'S token before the call, and it answered E_NOT_FOUND whenever that read came back empty.
     E6's read cutoff closes that read for a company past export_by, so the pre-read began answering 404 to a
     member whose company's agreement had ended, which is the one case api.authorize_download exists to answer
     honestly: app.download_refusal_for carries the export_by boundary and the routine raises 409
     E_ACCESS_PERIOD_ENDED for it (design 1.5, 3.1; tests/e6/stack case 38). A read that cannot tell "you may not
     see this release" from "your company's access period ended" cannot stand in front of a routine that can.
     Nothing is lost by removing it, because the routine makes the SAME decision authoritatively and in the right
     order: app.release_visible_to with the server actor decides visibility first and raises E_NOT_FOUND, which
     is E5D-C-F1's rule and what tests/e5/stack "E5D-C-F1: a caller who could never see a withdrawn release is
     told E_NOT_FOUND, not the state code" holds it to for an outsider and for another company's member; only
     then does it answer the state code. The post-read below is unchanged: it runs after a successful answer and
     is what builds the release object the page renders. */
  if (!isUuid(releaseId)) throw new AppError('E_NOT_FOUND');
  const answer = await callAs(session, 'authorize_download', { p_release: releaseId }, options);
  if (typeof answer !== 'object' || answer === null || typeof answer.assembled_content !== 'string')
    throw new AppError('E_INTERNAL');
  const [rows, registers] = await Promise.all([
    select(session, 'releases', { select: RELEASE_COLUMNS, id: `eq.${releaseId}` }, options),
    readRegisters(session, options),
  ]);
  if (rows.length !== 1) throw new AppError('E_INTERNAL');
  const rows6 = lossRows(answer.assembled_content);
  return {
    ok: true,
    release: releaseObject(rows[0], registers),
    assembledContent: answer.assembled_content,
    assembledSha256: answer.assembled_sha256,
    authorization: {
      authorizedAt: evidence.isoOf(answer.authorization?.authorized_at ?? null),
      authorizations: answer.authorization?.authorizations ?? null,
    },
    losses: { state: rows6.length > 0 ? 'declared' : 'pending', rows: rows6 },
  };
}
