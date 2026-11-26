/* The catalog, /catalog/?company=<uuid> (E5 design 1.3, 1.6, 4.1 and 4.2): the member's own gallery of the releases
   they may install and of the releases they were authorized earlier.

   Order of calls. GET /api/me; an administrator without a verified factor is moved to /mfa/ first (pages section 1).
   Then the first page of GET /api/companies/{id}/catalog, 50 releases in id order; its 404 is the not-found state, the
   same for an unknown, foreign, malformed or no longer permitted id. "Show more" reads the next page with the answer's
   nextCursor and adds it below, without a navigation.

   What it shows, top to bottom (4.1): the boundary sentence as fixed page text, above everything and never
   collapsible, because the plan asks for it on the installation screen; "Available to you", the rows the service put
   there, each with its agent, target, headline, assembled size, a link to the release page and, where the one
   predicate refused it, that refusal's fixed sentence; "Earlier downloads", the rows the member has an authorization
   for and cannot download now, each with what replaced it and the member's own newest report.

   Two rules this page follows and does not decide (E5D-C-F5, design 1.5). A ledger row proves that the server
   authorized a download and nothing more, so a row with authorizations and no report reads "Download authorized" and
   never "You have this"; installation words appear only where the member's own report supplies them, and the report's
   own label is the service's. Every sentence here comes from passport-view.mjs, whose label table the unit gate reads.

   The empty states (1.3, and rule 11 of evidence/e5-design-critique.md). With no row on any page read so far: the
   service's `empty` reason gets its fixed sentence when the catalog has ended, and, when a cursor still follows, the
   page offers the continuation instead, because an empty filtered page above a non-null nextCursor is a page
   continuation and not a statement that nothing exists. No spinner is left behind and no "something went wrong": an
   empty catalog is a normal state with a reason. */

import { catalog, me, sendAdminsToEnrolment, signOutHere } from '../api.mjs';
import { button, el, fill, isolated } from '../dom.mjs';
import { companyParam } from '../params.mjs';
import { assembledLine, authorizationLabel, blockedSentence, BOUNDARY, copiesSentence, emptySentence, installationStatusName, INSTALLATION_TEXT, releaseTarget, targetName } from '../passport-view.mjs';
import { companyLinks, dateLine, failureView, heading, keepFresh, link, loading, notFoundView, renderHeader, renderPlainHeader, showPageState, startPage, statusRegion } from '../shell.mjs';

const { header, main } = startPage();
const companyId = companyParam();
let available = [];
let earlier = [];
let empty = null;
let next = null;

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

/* The sentence for a replacement of a release the member downloaded earlier (1.6). The service answers one of three
   states, and only `addressed` carries an id, so this page can never link a member to a release they may not read. */
function replacementLine(row) {
  const state = row.replacement?.state ?? null;
  if (state === null) return null;
  if (state === 'addressed' && typeof row.replacedByReleaseId === 'string')
    return el(
      'p',
      { class: 'meta', 'data-role': 'replacement', 'data-replacement': 'addressed' },
      `${INSTALLATION_TEXT.replacementAddressed} `,
      link(releaseTarget(row.replacedByReleaseId), 'Open the newer version', { 'data-role': 'replacement-link' }),
    );
  return el(
    'p',
    { class: 'meta', 'data-role': 'replacement', 'data-replacement': state },
    state === 'not_addressed' ? INSTALLATION_TEXT.replacementNotAddressed : INSTALLATION_TEXT.replacementNone,
  );
}

/* What this member's own ledger and reports say about a row, in that order: the authorization label, which claims only
   an authorized download; the check-in when it is due; and the newest report with the service's own provenance label.
   A row with neither says so rather than saying nothing. */
function mineLines(row) {
  const my = row.my ?? {};
  const label = authorizationLabel(my.authorizations);
  const report = my.lastReport ?? null;
  return el(
    'div',
    { 'data-role': 'mine', 'data-authorizations': String(my.authorizations ?? 0) },
    label
      ? el('p', { class: 'meta', 'data-role': 'authorization' }, label, dateLine(', first ', my.firstAuthorizedAt), dateLine(', last ', my.lastAuthorizedAt))
      : el('p', { class: 'meta', 'data-role': 'no-authorization' }, INSTALLATION_TEXT.noAuthorization),
    my.checkInDue === true
      ? el('p', { class: 'notice', role: 'status', 'data-state': 'check-in-due' }, INSTALLATION_TEXT.checkInDue)
      : null,
    report
      ? el(
          'p',
          { class: 'meta', 'data-role': 'last-report', 'data-status': report.status },
          `${installationStatusName(report.status)} · `,
          el('span', { class: 'kind', 'data-role': 'last-report-label' }, String(report.label ?? '')),
          dateLine(' on ', report.reportedAt),
        )
      : null,
  );
}

/* One row of either section. The link to the release page is always offered: it is a read, not a write control, and a
   member whose download is blocked still has to reach the page that carries the losses table, the honest state and,
   when they have an authorization, the report form (E5P-F1). What the block is, is said beside it. */
function card(row, section) {
  const blocked = blockedSentence(row.blockedReason, row.target);
  const headline = row.headline ?? null;
  return el(
    'li',
    {
      class: 'card',
      'data-release': row.releaseId,
      'data-section': section,
      'data-state': row.state,
      'data-downloadable': row.downloadable ? 'yes' : 'no',
      'data-blocked': row.blockedReason ?? 'none',
    },
    el(
      'div',
      { class: 'card-head' },
      typeof row.agentName === 'string'
        ? isolated(row.agentName, { 'data-role': 'agent-name' })
        : el('code', { class: 'hash', 'data-role': 'agent-reference' }, String(row.agentId).slice(0, 8)),
      el('span', { class: 'tag', 'data-role': 'target' }, targetName(row.target)),
    ),
    headline && typeof headline.title === 'string'
      ? el('p', { 'data-role': 'headline-title' }, isolated(headline.title))
      : null,
    headline && typeof headline.summary === 'string'
      ? el('p', { class: 'meta', 'data-role': 'headline-summary' }, isolated(headline.summary))
      : null,
    el('p', { class: 'meta', 'data-role': 'assembled-size' }, assembledLine(row.assembledBytes), dateLine(' · Published ', row.publishedAt)),
    blocked ? el('p', { class: 'notice', role: 'status', 'data-state': 'blocked', 'data-code': row.blockedReason }, blocked) : null,
    section === 'earlier'
      ? el('p', { class: 'meta', 'data-role': 'copies' }, copiesSentence(row.my?.lastReport ?? null))
      : null,
    section === 'earlier' ? replacementLine(row) : null,
    mineLines(row),
    el('p', {}, link(releaseTarget(row.releaseId), 'Open this release', { 'data-role': 'release-link' })),
  );
}

function section(id, title, lead, rows) {
  return el(
    'section',
    { 'data-role': id },
    el('h2', {}, `${title} (${rows.length})`),
    el('p', { class: 'meta' }, lead),
    rows.length
      ? el('ul', { class: 'cards' }, rows.map((row) => card(row, id)))
      : el('p', { class: 'meta', 'data-state': 'empty' }, 'Nothing here.'),
  );
}

/* Nothing on any page read so far. Rule 11: a cursor that still follows means the catalog has not ended, so the page
   says so and offers the continuation rather than the terminal sentence for an empty catalog. */
function emptyView(status) {
  if (next !== null)
    return el(
      'section',
      { 'data-role': 'catalog-empty', 'data-state': 'more-pages' },
      el('p', { class: 'notice', role: 'status', 'data-role': 'empty-sentence' }, INSTALLATION_TEXT.morePagesFollow),
      button('Show more', () => more(status), { class: 'secondary', 'data-role': 'show-more' }),
      status,
    );
  return el(
    'section',
    { 'data-role': 'catalog-empty', 'data-state': empty ?? 'unknown' },
    el('p', { class: 'notice', role: 'status', 'data-role': 'empty-sentence' }, emptySentence(empty)),
  );
}

function render() {
  const status = statusRegion('more-status');
  const nothing = available.length === 0 && earlier.length === 0;
  fill(
    main,
    el(
      'div',
      { class: 'page-head' },
      heading('Catalog', 'The agents your company has approved for your groups.'),
      el('div', { class: 'toolbar' }, button('Reload', load, { class: 'secondary', 'data-role': 'reload' })),
    ),
    el('p', { class: 'boundary', 'data-role': 'boundary' }, BOUNDARY),
    companyLinks(companyId, '/catalog/'),
    nothing ? emptyView(status) : null,
    nothing ? null : section('available', 'Available to you', 'Releases addressed to your groups now.', available),
    nothing ? null : section('earlier', 'Earlier downloads', 'Releases you were authorized to download and cannot download now.', earlier),
    nothing || next === null ? null : button('Show more', () => more(status), { class: 'secondary', 'data-role': 'show-more' }),
    nothing ? null : status,
  );
}

async function more(status) {
  fill(status);
  const r = await catalog(companyId, next);
  if (r.action === 'navigating') return;
  if (r.action === 'not-found') return fill(main, notFoundView());
  if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
  if (!r.ok) return fill(status, failureView(r, { retry: () => more(status) }));
  take(r.data);
  render();
}

function take(data) {
  available = [...available, ...(Array.isArray(data.available) ? data.available : [])];
  earlier = [...earlier, ...(Array.isArray(data.earlier) ? data.earlier : [])];
  empty = data.empty ?? null;
  next = data.nextCursor ?? null;
}

async function load() {
  available = [];
  earlier = [];
  empty = null;
  next = null;
  fill(main, loading('Loading the catalog.'));
  const m = await me();
  if (m.action === 'navigating') return;
  if (!m.ok) return showPageState(header, main, failureView(m, { retry: load }));
  const enrolment = await sendAdminsToEnrolment(m.data);
  if (enrolment.moved || enrolment.answer?.action === 'navigating') return;
  if (enrolment.answer) return showPageState(header, main, failureView(enrolment.answer, { retry: load }));
  const membership = m.data.memberships.find((x) => x.companyId === companyId) ?? null;
  renderHeader(header, { email: m.data.user.email, companyName: membership?.companyName ?? null, onSignOut: signOut });
  if (!companyId) return fill(main, notFoundView());
  const r = await catalog(companyId);
  if (r.action === 'navigating') return;
  if (r.action === 'not-found') return fill(main, notFoundView());
  if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
  if (!r.ok) return fill(main, heading('Catalog'), failureView(r, { retry: load }));
  take(r.data);
  render();
}

keepFresh({
  clear: () => {
    available = [];
    earlier = [];
    empty = null;
    next = null;
    fill(main);
    renderPlainHeader(header);
  },
  reload: load,
});
load();
