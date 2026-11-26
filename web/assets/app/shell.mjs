/* What every page shares around its own content (pages design sections 1 and 3): the start of a page, the header,
   the full-page and inline states an answer can put a page in, the back-button rule, and navigation.

   Navigation (rule 10). navigate() is the only writer of location under web/ (scripts/check-web.mjs refuses the
   writers anywhere else). It admits a target only from the fixed set /, /signin/, /accept/, /accept, /mfa/,
   /members/, /account/, E4's /reviews/, /review/, /releases/, /release/ and /groups/ (E4 design 4.3), E5's
   /catalog/ (E5 design 4.1), E6's three operator pages, the E3 intake pages /drafts/, /drafts/new/, /draft/ and
   /submitted/ (docs/e3/intake-pages-design.md) and the capture prompt's page /capture/ (HOSTED-F3, evidence/
   operator-landing.md), with no query or exactly company=<uuid>, candidate=<uuid>, release=<uuid> or
   reason=expired|signed-out, and never a fragment; anything else throws before location is touched. The journeys'
   document assertion holds the same set (tests/browser/harness.mjs, compared with this one in both directions by
   tests/e2/unit/web-e4-modules.test.mjs). No page reads a redirect or next parameter. Listeners
   registered with onNavigate run first, which is how api.mjs discards queued session work when the page leaves.
   Internal links are built by link(), which applies the same check.

   The back button (rule 10). keepFresh() clears the rendered data on pagehide and, when a page is restored from the
   back-forward cache, clears it again and reloads the data before anything is shown, so a signed-out browser cannot
   show a cached member list.

   States (rule 7). A failed answer carries an action from api.mjs's table; failureView() renders the server's
   message as text beside that action, and never looks a message up. The page owns two sentences of its own: the
   network failure sentence, and the sentence for an answer it cannot read, and one label: an E_INTERNAL answer's
   request id is shown under its message after REFERENCE_LABEL, as text, for the person to quote to support (lane K2,
   evidence/hardening-k.md). */

import { add, button, el, fill, isolated } from './dom.mjs';
import { readLanding } from './params.mjs';

const PATHS = new Set([
  '/',
  '/signin/',
  '/accept/',
  '/accept',
  '/mfa/',
  '/members/',
  '/account/',
  '/reviews/',
  '/review/',
  '/releases/',
  '/release/',
  '/groups/',
  '/catalog/',
  /* E6 design 2.6 item 6, landed by the lead before construction: the three operator pages. */
  '/operator/',
  '/operator/company/',
  '/operator/new/',
  /* The four E3 intake pages (docs/e3/intake-pages-design.md section 1), with the query forms above and no other. */
  '/drafts/',
  '/drafts/new/',
  '/draft/',
  '/submitted/',
  /* The capture page of HOSTED-F3, reached from Your agents beside the upload link. */
  '/capture/',
]);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const QUERY = new RegExp(`^(?:company=${UUID}|candidate=${UUID}|release=${UUID}|reason=(?:expired|signed-out))$`);
const listeners = [];
const restoreListeners = [];

export const NETWORK_SENTENCE = 'The service could not be reached.';
export const UNREADABLE_SENTENCE = 'The service sent an answer this page could not read.';
export const REFERENCE_LABEL = 'Reference for support: ';
/* HB-F2 (migration 012): when an account's wrong second-factor codes are spent, the time the window ends, in UTC as
   every date on these pages is. The answer has no Retry: retrying before that time is refused again. */
export const RETRY_AFTER_LABEL = 'You can try again after ';
/* The window's end, rounded UP to the minute: it falls between whole minutes, and a time cut down to the minute would
   name a moment that is still refused (HBF2-R-F2). api.mjs admits only an ISO UTC time, so the parse is finite. */
const retryAfterText = (iso) =>
  `${new Date(Math.ceil(Date.parse(iso) / 60_000) * 60_000).toISOString().slice(0, 16).replace('T', ' ')} UTC.`;

/** isAllowedTarget(target): a member of the fixed set with at most the admitted query and no fragment. */
export function isAllowedTarget(target) {
  if (typeof target !== 'string' || target.includes('#')) return false;
  const parts = target.split('?');
  if (!PATHS.has(parts[0])) return false;
  return parts.length === 1 || (parts.length === 2 && QUERY.test(parts[1]));
}

export function onNavigate(listener) {
  listeners.push(listener);
}

export function navigate(target) {
  if (!isAllowedTarget(target)) throw new TypeError('shell.mjs: a navigation outside the fixed set');
  for (const listener of listeners) listener(target);
  location.assign(target);
}

/** The members page of a company id taken from an answer; throws for anything that is not a uuid. */
export function membersTarget(companyId) {
  const target = `/members/?company=${companyId}`;
  if (!isAllowedTarget(target)) throw new TypeError('shell.mjs: a company id that is not a uuid');
  return target;
}

/** An internal link to a target of the fixed set. */
export function link(target, label, attributes = {}) {
  if (!isAllowedTarget(target)) throw new TypeError('shell.mjs: a link outside the fixed set');
  const node = el('a', attributes, label);
  node.href = target;
  return node;
}

const COMPANY_PAGES = [
  ['/drafts/', 'Your agents'],
  ['/catalog/', 'Catalog'],
  ['/members/', 'Members'],
  ['/reviews/', 'Reviews'],
  ['/releases/', 'Releases'],
  ['/groups/', 'Audience groups'],
];

/** The pages of one company (E4 design 4.1, E5 design 4.1): the author's own agents (the E3 intake pages), the catalog,
    members, reviews, releases and audience groups, each a link of the fixed set; the current page, when named, is shown
    and not linked. Every company page and the home page draw this nav, so /catalog/ and /drafts/ are reachable from each
    of them. Throws for a company id that is not a uuid. */
export function companyLinks(companyId, current = null) {
  return el(
    'nav',
    { class: 'company-links', 'aria-label': 'Company pages', 'data-role': 'company-links' },
    COMPANY_PAGES.map(([path, label]) =>
      path === current
        ? el('span', { 'aria-current': 'page' }, label)
        : link(`${path}?company=${companyId}`, label, { 'data-role': `link-${path.slice(1, -1)}` }),
    ),
  );
}

/** onRestore(listener): runs when the page is restored from the back-forward cache, before the page's own reload. A
    restored page keeps its module state, so whatever a navigation stopped must start again here (api.mjs's queue). */
export function onRestore(listener) {
  restoreListeners.push(listener);
}

/** startPage() -> { header, main }. Scrubs the address first (params.mjs), before the page sends anything, and runs
    the restore listeners on every pageshow with persisted; keepFresh's listener, registered later, runs after them. */
export function startPage() {
  readLanding();
  addEventListener('pageshow', (event) => {
    if (event.persisted) for (const listener of restoreListeners) listener();
  });
  return { header: document.getElementById('site-header'), main: document.getElementById('main') };
}

/** keepFresh({ clear, reload }): the back-button rule. */
export function keepFresh({ clear, reload }) {
  addEventListener('pagehide', () => clear());
  addEventListener('pageshow', (event) => {
    if (event.persisted) {
      clear();
      reload();
    }
  });
}

function lockup() {
  return link('/', [el('span', { class: 'mark' }, 'Phaeacia'), el('span', { class: 'product' }, 'Enterprise')], {
    class: 'lockup',
  });
}

/* HOSTED-F2 (evidence/e1-lead.md; evidence/operator-landing.md). The identity answer says nothing about operators and E6
   added nothing that does (E6 design 4.1), so a page learns it the way the operator pages always have: it asks an
   operator route and reads the answer. app.operator_actor() looks the caller up in app.operators BEFORE it tests the
   assurance level (001_identity.sql), so the answer is decisive: 200 is an operator at aal2, 403
   E_OPERATOR_MFA_REQUIRED an operator at aal1, 403 E_NOT_OPERATOR anyone else. Any other answer, a network failure
   included, says nothing, which is null; a page shows no operator link on null and no member's empty state either. */
const OPERATOR_LANDING = Object.freeze({ aal2: '/operator/', aal1: '/mfa/' });

/** operatorStanding(answer) -> 'aal2' | 'aal1' | 'none' | null: what an operator route's answer says about the caller. */
export function operatorStanding(answer) {
  if (answer?.ok === true) return 'aal2';
  if (answer?.code === 'E_OPERATOR_MFA_REQUIRED') return 'aal1';
  if (answer?.code === 'E_NOT_OPERATOR') return 'none';
  return null;
}

/** Whether an operator route's answer shows the caller is an operator, at either assurance level. */
export const isOperator = (answer) => OPERATOR_LANDING[operatorStanding(answer)] !== undefined;

/** Where the home page sends an operator: the register at aal2, the second factor at aal1; null for anyone else. */
export const operatorLanding = (answer) => OPERATOR_LANDING[operatorStanding(answer)] ?? null;

/** An operator route's answer that says nothing about the caller (standing null), as the failure a page shows for it:
    maintenance stays maintenance, and every other answer is offered again with Retry whatever action its code carries.
    An unknown 403 carries 'message' and a 404 'not-found', which failureView draws without Retry (PC-1,
    evidence/operator-landing.md); the lead's rule for the home page is Retry for anything but E_NOT_OPERATOR. */
export const standingUnknown = (answer) => (answer?.action === 'maintenance' ? answer : { ...answer, action: 'retry' });

/* The operator's Account entry left this list with UI updates U2 (evidence/ui-updates.md): the header's account icon
   links to /account/ on every signed-in page. */
const OPERATOR_PAGES = [
  ['/operator/', 'Companies', 'nav-companies'],
  ['/operator/new/', 'New company', 'nav-new-company'],
];

/** The operator's own pages, drawn in the header of every page an operator reaches and nobody else's (HOSTED-F2). The
    page the browser is on is shown and not linked, as companyLinks does. */
function operatorNav() {
  const here = location.pathname;
  return el(
    'nav',
    { class: 'operator-nav', 'aria-label': 'Operator pages', 'data-role': 'operator-nav' },
    OPERATOR_PAGES.map(([path, label, role]) =>
      path === here ? el('span', { 'aria-current': 'page', 'data-role': role }, label) : link(path, label, { 'data-role': role }),
    ),
  );
}

/** The link to /account/ as a small person icon (UI updates U2, evidence/ui-updates.md). The glyph is drawn by the
    stylesheet from an empty span, since an inline SVG element needs a namespace string this tree may not hold
    (scripts/check-web.mjs rule 2). The signed-in address is the link's accessible name and its tooltip, set as
    attribute text and never as markup; on the account page itself the link is marked current. */
function accountLink(email) {
  const name = `Account, ${email}`;
  const node = link('/account/', el('span', { class: 'user-icon', 'aria-hidden': 'true' }), {
    class: 'account',
    'data-role': 'account-link',
    'aria-label': name,
    'aria-current': location.pathname === '/account/' ? 'page' : null,
  });
  node.title = name;
  return node;
}

/** A Sign out that asks first (UI updates U3 and U6, evidence/ui-updates.md): a button that opens a modal dialog saying
    that the sign-out ends this device's session only (section 1, Q10). The dialog's Sign out runs the page's
    onSignOut, unchanged; Cancel and Escape close it with nothing sent, and closing returns focus to the button. The
    dialog opens with focus on Cancel, the choice that changes nothing, so a held Enter that opened it cannot also
    confirm it (PEER-5). The header and the account page's own button use it; the button's role names its dialog, the
    dialog's two buttons and its question (`<role>-dialog`, `<role>-confirm`, `<role>-cancel`, `<role>-question`), so
    each pair on a page is its own. The failure view's own sign-out (mismatch-sign-out) stays a direct action.
    Returns [button, dialog], for the caller to place side by side. */
export function askingSignOut(onSignOut, label, { role, className }) {
  const cancel = button('Cancel', () => dialog.close(), { class: 'secondary', 'data-role': `${role}-cancel` });
  cancel.autofocus = true;
  const dialog = el(
    'dialog',
    { class: 'modal', 'data-role': `${role}-dialog`, 'aria-labelledby': `${role}-question` },
    el('p', { id: `${role}-question` }, 'Sign out of this device? Other devices stay signed in.'),
    el(
      'div',
      { class: 'actions' },
      button(
        'Sign out',
        async () => {
          await onSignOut();
          if (dialog.open) dialog.close();
        },
        { 'data-role': `${role}-confirm` },
      ),
      cancel,
    ),
  );
  const opener = button(label, () => dialog.showModal(), { class: className, 'data-role': role });
  dialog.addEventListener('close', () => opener.focus());
  return [opener, dialog];
}

/** The header of a signed-in page: the lockup, the company on the members page, the account icon linking to /account/,
    and Sign out with its confirmation. `operator`, true only when an operator route's answer showed it (isOperator),
    adds the operator's navigation; a member's header is drawn exactly as before. */
export function renderHeader(header, { email, companyName = null, onSignOut, operator = false }) {
  fill(
    header,
    el(
      'div',
      { class: 'bar' },
      lockup(),
      companyName ? el('span', { class: 'company', 'data-role': 'company-name' }, isolated(companyName)) : null,
      operator === true ? operatorNav() : null,
      el(
        'div',
        { class: 'who' },
        accountLink(email),
        el('div', { class: 'signout' }, askingSignOut(onSignOut, 'Sign out', { role: 'sign-out', className: 'quiet' })),
      ),
    ),
  );
}

/** The header of a page nobody is signed in on: the lockup alone. */
export function renderPlainHeader(header) {
  fill(header, el('div', { class: 'bar' }, lockup()));
}

/** A page heading with an optional lead paragraph. */
export function heading(title, lead) {
  return el('div', { class: 'heading' }, el('h1', { tabindex: '-1' }, title), lead ? el('p', { class: 'lead' }, lead) : null);
}

/** failureView(result, { retry, signOut, notFoundHere }): a failed answer as the state its action names.
    notFoundHere marks a company page, where E_NOT_FOUND is the not-found state rather than a message. */
export function failureView(result, { retry, signOut, notFoundHere = false } = {}) {
  if (notFoundHere && result.action === 'not-found') return notFoundView();
  const message = result.network ? NETWORK_SENTENCE : (result.message ?? UNREADABLE_SENTENCE);
  const box = el('div', { class: 'notice', role: 'alert', 'data-state': result.action, 'data-code': result.code ?? 'none' });
  add(box, [el('p', {}, message)]);
  /* K2: only E_INTERNAL carries it, and api.mjs admits only the request id's shape; it is text either way. */
  if (result.code === 'E_INTERNAL' && typeof result.requestId === 'string')
    add(box, [el('p', { 'data-role': 'request-id' }, REFERENCE_LABEL, result.requestId)]);
  if (result.code === 'E_MFA_ATTEMPTS_EXHAUSTED' && typeof result.retryAfter === 'string')
    add(box, [el('p', { 'data-role': 'retry-after' }, RETRY_AFTER_LABEL, retryAfterText(result.retryAfter))]);
  if ((result.action === 'retry' || result.action === 'maintenance') && retry)
    add(box, [button(result.action === 'maintenance' ? 'Try again' : 'Retry', retry, { 'data-role': 'retry' })]);
  if (result.action === 'mfa') add(box, [link('/mfa/', 'Go to second-factor verification', { 'data-role': 'mfa-link' })]);
  /* E6P-F8 (E6 design 4.2): the two states a read answers for a whole company are shown with a link home, because
     every page of that company says the same thing and the home page is where the company's state is explained. */
  if (result.code === 'E_COMPANY_INACTIVE' || result.code === 'E_ACCESS_PERIOD_ENDED')
    add(box, [link('/', 'Go to your companies', { 'data-role': 'home-link' })]);
  if (result.action === 'sign-out' && signOut) add(box, [button('Sign out', signOut, { 'data-role': 'mismatch-sign-out' })]);
  return box;
}

/** The whole page replaced by a state: maintenance, and any failure before a page has anything to show. */
export function showPageState(header, main, node) {
  renderPlainHeader(header);
  fill(main, el('section', { class: 'state' }, node));
}

const ROLE_LABELS = {
  member: 'Member',
  it_reviewer: 'IT reviewer',
  business_reviewer: 'Business reviewer',
  company_admin: 'Administrator',
};

/** A known role's label, and the raw name for a role this page has no label for (4.2): no decision depends on it. */
export function roleName(role) {
  return Object.hasOwn(ROLE_LABELS, role) ? ROLE_LABELS[role] : String(role);
}

export function roleNames(roles) {
  return (Array.isArray(roles) ? roles : []).map(roleName).join(', ');
}

/** A label and the calendar date of an ISO timestamp, or nothing when there is no timestamp. */
export function dateLine(label, iso) {
  if (typeof iso !== 'string' || iso.length < 10) return null;
  return el('span', { class: 'date' }, label, el('time', { datetime: iso }, iso.slice(0, 10)));
}

export function loading(text) {
  return el('p', { class: 'loading', 'data-state': 'loading', role: 'status' }, text);
}

/** A short page-owned notice, such as a confirmation or an incomplete list. */
export function notice(text, state) {
  return el('p', { class: `notice ${state === 'truncated' ? '' : 'confirm'}`, role: 'status', 'data-state': state }, text);
}

/** An empty live region where an answer to an action is shown. */
export function statusRegion(role = 'status') {
  return el('div', { class: 'status', 'aria-live': 'polite', 'data-role': role });
}

/** The not-found state of a company page: the same for an unknown, foreign, malformed or no longer permitted id. */
export function notFoundView() {
  return el(
    'div',
    { class: 'notice', role: 'alert', 'data-state': 'not-found' },
    el('h1', {}, 'Company not available'),
    el('p', {}, 'This company does not exist, or you are not an active member of it.'),
    link('/', 'Go to your companies', { 'data-role': 'home-link' }),
  );
}
