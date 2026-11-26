/* The home page, / (pages design section 1). Its first call is session discovery (rule 6). Signed out: moves to
   /signin/. An administrator without a verified factor: moves to /mfa/ before any company is shown. No active
   membership: fixed text. One membership: moves to that company's members page. Several: a list of companies.

   What E6 adds (design 4.1's `/` row and table, E6D-C-F16). GET /api/me now carries each membership's companyStatus and
   accessState. A membership whose company is not active, or whose access is not current, is listed with the company
   name, its state as a word and one fixed sentence (lifecycle-view.mjs homeStateSentence), and none of the company's
   page links, because every one of them would answer the same refusal; and a person whose one membership is such a
   company stays here rather than being moved to a page that refuses them. The sentences carry no date, because the
   identity answer carries none (E6P-D1). The one control such a row may carry is Export, for an administrator at aal2
   of a company that is not closed and whose window has not closed: design 4.1's table row, which the takeout routine
   decides again. That covers the suspended company inside its window, which the design's first version left with no
   way to reach its own copy. The answer is saved through save-file.mjs and what it left out is said beside it.

   E6PW-R-F1 (evidence/e6-pages-review.md; design 1.5 over 4.1's table): an ACTIVE company in its reading window (past ends_at, before export_by) still
   serves every read until export_by, so its row keeps the links to the three read pages (catalog, members, releases;
   not reviews or groups, whose point is a write). The row's sentence says changes have stopped. A person whose one
   membership is such a company STAYS here and sees that row (B3-R-F1, evidence/batch-3-review.md: forwarded to the
   members page, they never saw the sentence, and the refusal's link home forwarded them straight back). A suspended
   company in the window keeps no links: its status refuses the reads.

   HOSTED-F2 (evidence/e1-lead.md; evidence/operator-landing.md). An operator holds no membership (001 and 008 keep the
   two disjoint), so this page used to tell an operator "No company yet" and link nowhere useful. A person with no
   membership now makes one more call, the register's read, and its answer decides (shell.mjs operatorStanding): an
   operator at aal2 moves to /operator/, an operator at aal1 to /mfa/, whose verification comes back here and on to
   /operator/, and only E_NOT_OPERATOR shows the empty state. Any other answer shows the failure with Retry
   (shell.mjs standingUnknown, whatever action its code carries: PC-1) under the signed-in header, so sign-out stays;
   maintenance is the whole-page state as on every page. Never the empty state, so an operator never reads it. A
   person with a membership never sends the call.

   UI updates U5 (evidence/ui-updates.md): the signed-in header is drawn only once the page knows it stays, after the
   operator check, so an operator moved on to /operator/ or /mfa/ is never shown the header of a member's home page
   first; the observation before the change is in evidence/ui-updates-repro/before-cd6be20/observed.json. Every load
   starts from the plain header, as the first one does, so a Retry after a register read that said nothing does not
   leave a member's header up while its second read decides (PEER-1). */

import { discoverSession, operatorCompanies, sendAdminsToEnrolment, signOutHere, takeout } from '../api.mjs';
import { button, el, fill, isolated } from '../dom.mjs';
import { homeStateSentence, isInactiveMembership, LIFECYCLE_TEXT, mayTakeCopy, readsStillServed, statusWord, takeoutFileName, takeoutNotice, takeoutText } from '../lifecycle-view.mjs';
import { nameSafe, saveBytes } from '../save-file.mjs';
import { companyLinks, failureView, heading, keepFresh, link, loading, membersTarget, navigate, notice, operatorLanding, operatorStanding, renderHeader, renderPlainHeader, roleNames, showPageState, standingUnknown, startPage, statusRegion } from '../shell.mjs';

const { header, main } = startPage();

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

/* The state word a row shows: the company's status, or for an active company the access state that stops it. */
function stateWord(m) {
  if (m.companyStatus !== 'active') return statusWord(m.companyStatus);
  if (m.accessState === 'export_window') return 'Agreement ended';
  if (m.accessState === 'expired') return 'Window closed';
  return statusWord(m.companyStatus);
}

function takeoutControl(m, aal) {
  if (!mayTakeCopy(m, aal)) return null;
  const status = statusRegion('takeout-status');
  const run = async () => {
    fill(status);
    const r = await takeout(m.companyId);
    if (r.action === 'navigating') return;
    if (!r.ok) {
      if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
      return fill(status, failureView(r, { retry: run }));
    }
    saveBytes(takeoutFileName(nameSafe, m.companySlug, r.data.exportedAt), takeoutText(r.data), 'application/json');
    fill(status, takeoutNotice(r.data));
  };
  return el(
    'div',
    { class: 'actions', 'data-role': 'takeout-entry' },
    el('p', { class: 'meta' }, LIFECYCLE_TEXT.takeoutLead),
    button('Export this company’s records', run, { 'data-role': 'takeout' }),
    status,
  );
}

const WINDOW_PAGES = [
  ['/catalog/', 'Catalog'],
  ['/members/', 'Members'],
  ['/releases/', 'Releases'],
];

/* The read pages of a company in its reading window (E6PW-R-F1): each a link of the fixed set, drawn by shell.mjs's link. */
function windowLinks(companyId) {
  return el(
    'nav',
    { class: 'company-links', 'aria-label': 'Company pages still readable', 'data-role': 'window-links' },
    WINDOW_PAGES.map(([path, label]) => link(`${path}?company=${companyId}`, label, { 'data-role': `link-${path.slice(1, -1)}` })),
  );
}

function companyCard(c, aal) {
  if (isInactiveMembership(c))
    return el(
      'li',
      { class: 'card', 'data-company': c.companyId, 'data-state': 'inactive', 'data-company-status': c.companyStatus, 'data-access': c.accessState },
      el('div', { class: 'card-head' }, isolated(c.companyName), el('span', { class: 'tag', 'data-role': 'company-state' }, stateWord(c))),
      el('p', { 'data-role': 'inactive-sentence' }, homeStateSentence(c)),
      el('p', { class: 'meta' }, roleNames(c.roles)),
      readsStillServed(c) ? windowLinks(c.companyId) : null,
      takeoutControl(c, aal),
    );
  return el(
    'li',
    { class: 'card', 'data-company': c.companyId, 'data-state': 'active' },
    el('div', { class: 'card-head' }, link(membersTarget(c.companyId), isolated(c.companyName), { 'data-role': 'company-link' })),
    el('p', { class: 'meta' }, roleNames(c.roles)),
    companyLinks(c.companyId, null),
  );
}

async function load() {
  renderPlainHeader(header);
  fill(main, loading('Loading your companies.'));
  const d = await discoverSession();
  if (d.unavailable) return showPageState(header, main, failureView(d.answer, { retry: load }));
  if (d.error) return showPageState(header, main, failureView(d.error, { retry: load }));
  if (!d.signedIn) return navigate('/signin/');
  const identity = d.me;
  const enrolment = await sendAdminsToEnrolment(identity);
  if (enrolment.moved || enrolment.answer?.action === 'navigating') return;
  if (enrolment.answer) return showPageState(header, main, failureView(enrolment.answer, { retry: load }));
  const signedInHeader = () => renderHeader(header, { email: identity.user.email, onSignOut: signOut });
  const companies = identity.memberships;
  if (companies.length === 1 && !identity.truncated && !isInactiveMembership(companies[0]))
    return navigate(membersTarget(companies[0].companyId));
  if (companies.length === 0) {
    const standing = await operatorCompanies();
    if (standing.action === 'navigating') return;
    const landing = operatorLanding(standing);
    if (landing) return navigate(landing);
    if (standing.action === 'maintenance') return showPageState(header, main, failureView(standing, { retry: load }));
    signedInHeader();
    if (operatorStanding(standing) !== 'none')
      return fill(main, el('section', { class: 'state', 'data-state': 'standing-unknown' }, failureView(standingUnknown(standing), { retry: load })));
    return fill(
      main,
      el(
        'section',
        { class: 'narrow', 'data-state': 'no-membership' },
        heading('No company yet', 'This account has no active company membership.'),
        el('p', {}, 'An administrator of your company can invite you. Your own details are on ', link('/account/', 'your account page'), '.'),
      ),
    );
  }
  signedInHeader();
  fill(
    main,
    heading('Your companies'),
    identity.truncated ? notice('This list is incomplete: you belong to more companies than this page shows.', 'truncated') : null,
    el('ul', { class: 'cards', 'data-role': 'companies' }, companies.map((c) => companyCard(c, identity.user.aal))),
  );
}

keepFresh({
  clear: () => {
    fill(main);
    renderPlainHeader(header);
  },
  reload: load,
});
load();
