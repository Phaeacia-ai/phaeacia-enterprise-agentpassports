/* The register, /operator/ (E6 design 4.1 and 4.2): Phaeacia's customer companies, how much each holds and never what
   it holds (design 1.1).

   Order of calls. GET /api/me for the header's address only, and GET /api/operator/companies together. Nothing about
   who is an operator is read from the identity: the register answer decides, and its refusal routes the page (design
   4.1). 403 E_OPERATOR_MFA_REQUIRED carries api.mjs's mfa action, so the page shows the server's sentence and the link
   to /mfa/; 403 E_NOT_OPERATOR is this page's not-found state, the server's message with a link home and no form.
   Every control below is rendered only after the register answered 200, and each is refused again by
   app.operator_actor() whatever this page renders.

   What it shows. First the glance (HOSTED-F2 item 3, evidence/operator-landing.md; operator-glance.mjs holds its
   rules): how many companies by status, the agreements ending soonest with their days, and what needs the operator,
   each its own element so any one can be dropped or moved. Then one row per company, soonest end date first by default
   (companies with none last), or, by the order control, in the order the answer sends them, which is the routine's:
   eligible, due and overdue deletion first, then by id (OPL-F5: the service's order is one of the three things that
   make a deletion happen on time, so it stays one choice away and the glance names due and overdue deletions). Each
   row: name and slug linking to /operator/company/, status, the access state with the date it turns on, the days left,
   the deletion state, people against the seat quota, agents, published releases and content bytes. The glance, the
   table and the sweep's counts read only the rows this page holds; when more pages follow, each says so. "Show more" whenever the answer names a next cursor, even under an empty page (E5's rule 11
   lesson). cursorReset, when the cursor named a company that no longer exists, is said as a moved list and not shown
   as a not-found. The lifecycle sweep with its button, whose answer is listed and which deletes nothing; the count of
   unclaimed accounts, with no control, because their deletion runs from a terminal (design 1.5).

   Not linked from any company page and linking to none (design 4.1). Since HOSTED-F2 (evidence/operator-landing.md) an
   operator's sign-in lands here, and the header of every operator page, /account/ and /mfa/ carries the operator's
   navigation when the register's answer shows an operator (shell.mjs isOperator); no member's page links here. */

import { expiryRun, me, operatorCompanies, signOutHere } from '../api.mjs';
import { add, button, el, fill, isolated } from '../dom.mjs';
import { accessCell, count, dataTable, deletionCell, deletionWord, LIFECYCLE_TEXT, notOperatorView, operatorCompanyTarget, statusWord } from '../lifecycle-view.mjs';
import { agreementWord, daysLeft, daysText, endingSoonest, needsYou, ORDERS, orderRows, statusSentence, statusSummary } from '../operator-glance.mjs';
import { failureView, heading, isOperator, keepFresh, link, loading, notice, renderHeader, renderPlainHeader, showPageState, startPage, statusRegion } from '../shell.mjs';

const { header, main } = startPage();
let rows = [];
let next = null;
let reset = false;
let sweepable = null;
let swept = null;
/* The table's order, one of operator-glance.mjs ORDERS; soonest ending first until the operator chooses otherwise. */
let order = 'ending';

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

/* A refused register answer: not an operator is the not-found state; anything else is the shared failure view with
   the action api.mjs names, which for E_OPERATOR_MFA_REQUIRED is the link to /mfa/. */
function refused(r) {
  if (r.code === 'E_NOT_OPERATOR') return fill(main, notOperatorView(r.message));
  if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
  return fill(main, heading('Customer companies'), failureView(r, { retry: load }));
}

const quotaOf = (row, name) => (Array.isArray(row.quotas) ? row.quotas.find((q) => q.name === name) : null) ?? null;

function peopleCell(row) {
  const seats = quotaOf(row, 'members_per_company');
  return `${count(row.counts?.membershipsActive)} of ${count(seats?.value)}`;
}

function agentsCell(row) {
  const orphaned = row.counts?.agentsOrphaned ?? 0;
  return `${count(row.counts?.agentsActive)}${orphaned > 0 ? `, ${count(orphaned)} without an owner` : ''}`;
}

/* The days-left cell: the count, and "Ending soon" as a word beside it at 30 days or fewer (an ended agreement's text
   already says Ended). */
function daysCell(row, now) {
  const days = daysLeft(row.accessPeriod, now);
  const word = agreementWord(row.accessPeriod, days);
  return el(
    'span',
    { 'data-role': 'days-left', 'data-days': days ?? 'none' },
    word === 'Ending soon' ? `${word}: ` : '',
    daysText(row.accessPeriod, days),
  );
}

function registerRow(row, now) {
  return [
    el(
      'span',
      { 'data-company': row.companyId, 'data-status': row.status, 'data-deletion': row.accessPeriod?.deletionState ?? 'none' },
      link(operatorCompanyTarget(row.companyId), isolated(String(row.name ?? '')), { 'data-role': 'company-link' }),
      el('span', { class: 'meta' }, ' ', isolated(String(row.slug ?? ''))),
    ),
    statusWord(row.status),
    accessCell(row.accessPeriod),
    daysCell(row, now),
    deletionCell(row.accessPeriod),
    peopleCell(row),
    agentsCell(row),
    count(row.counts?.releasesPublished),
    count(row.counts?.contentBytes),
  ];
}

async function more() {
  const r = await operatorCompanies(next);
  if (r.action === 'navigating') return;
  if (!r.ok) return refused(r);
  accept(r.data, true);
  render();
}

function accept(data, appending) {
  const companies = Array.isArray(data.companies) ? data.companies : [];
  reset = data.cursorReset === true;
  rows = appending && !reset ? [...rows, ...companies] : companies;
  next = typeof data.nextCursor === 'string' ? data.nextCursor : null;
  sweepable = Number.isInteger(data.sweepableAccounts) ? data.sweepableAccounts : null;
}

const ORDER_LABELS = Object.freeze({
  ending: 'Soonest ending first',
  service: 'As the service sorts them: deletion due first',
});

/** The two-way order of the table: a radio pair whose change redraws the rows alone, so the choice keeps its focus. */
function orderControl(redraw) {
  const box = el(
    'fieldset',
    { class: 'choice order', 'data-role': 'register-order' },
    el('legend', {}, 'Order'),
    ORDERS.map((value) =>
      el(
        'div',
        { class: 'option' },
        el('input', { type: 'radio', name: 'register-order', id: `order-${value}`, value, checked: value === order }),
        el('label', { for: `order-${value}` }, ORDER_LABELS[value]),
      ),
    ),
  );
  box.addEventListener('change', (event) => {
    if (!ORDERS.includes(event.target?.value)) return;
    order = event.target.value;
    redraw();
  });
  return box;
}

function registerTable(now) {
  return dataTable(
    'register-table',
    ['Company', 'Status', 'Access', 'Days left', 'Deletion', 'People', 'Agents', 'Published releases', 'Content bytes'],
    orderRows(rows, order).map((row) => registerRow(row, now)),
  );
}

function registerSection(now) {
  const box = el('section', { 'data-role': 'register' }, el('h2', {}, `Companies (${rows.length}${next ? ' so far' : ''})`));
  if (reset) box.append(notice(LIFECYCLE_TEXT.cursorReset, 'cursor-reset'));
  if (rows.length === 0 && !next)
    box.append(
      el(
        'div',
        { class: 'notice', 'data-state': 'empty' },
        el('p', {}, LIFECYCLE_TEXT.noCompanies),
        link('/operator/new/', 'New company', { 'data-role': 'new-company-empty' }),
      ),
    );
  else if (rows.length) {
    const table = el('div', { 'data-role': 'register-rows' }, registerTable(now));
    add(box, [
      orderControl(() => fill(table, registerTable(now))),
      next ? el('p', { class: 'meta', 'data-role': 'order-partial' }, 'Ordered over the companies listed so far.') : null,
      table,
    ]);
  }
  if (next)
    box.append(
      el(
        'div',
        { class: 'actions', 'data-role': 'continuation' },
        el('p', { class: 'meta' }, LIFECYCLE_TEXT.moreCompanies),
        button('Show more', more, { class: 'secondary', 'data-role': 'show-more' }),
      ),
    );
  return box;
}

/* The sweep's counts are read from the rows this page holds, which the routine sorted and labelled: a company still
   active past the end of its reading window is waiting for the sweep's suspension, and a due or overdue one is on its
   deletion list. When more pages follow, the counts say so rather than claiming the whole register. */
function sweepSection() {
  const status = statusRegion('sweep-status');
  const waiting = rows.filter((r) => r.status === 'active' && r.accessPeriod?.state === 'expired').length;
  const due = rows.filter((r) => ['due', 'overdue'].includes(r.accessPeriod?.deletionState)).length;
  const run = async () => {
    fill(status);
    const r = await expiryRun();
    if (r.action === 'navigating') return;
    if (!r.ok) {
      if (r.code === 'E_NOT_OPERATOR') return fill(main, notOperatorView(r.message));
      return fill(status, failureView(r, { retry: run }));
    }
    swept = r.data;
    return load();
  };
  return el(
    'section',
    { class: 'panel', 'data-role': 'sweep' },
    el('h2', {}, 'Lifecycle sweep'),
    el('p', {}, LIFECYCLE_TEXT.sweepLead),
    el(
      'p',
      { class: 'meta', 'data-role': 'sweep-counts' },
      `Waiting for suspension: ${waiting}. Due or overdue for deletion: ${due}.${next ? ' Counted over the companies listed so far.' : ''}`,
    ),
    button('Run the sweep', run, { 'data-role': 'run-sweep' }),
    status,
    swept ? sweepResult(swept) : null,
  );
}

function sweepResult(r) {
  const suspended = Array.isArray(r.suspended) ? r.suspended : [];
  const due = Array.isArray(r.dueForDeletion) ? r.dueForDeletion : [];
  return el(
    'div',
    { class: 'notice confirm', role: 'status', 'data-state': 'swept' },
    suspended.length === 0 && due.length === 0 ? el('p', {}, LIFECYCLE_TEXT.sweepNothing) : null,
    suspended.length
      ? el(
          'div',
          { 'data-role': 'swept-suspended' },
          el('p', {}, `Suspended now: ${suspended.length}.`),
          el('ul', { class: 'lines' }, suspended.map((c) => el('li', {}, isolated(String(c.slug ?? ''))))),
        )
      : null,
    due.length
      ? el(
          'div',
          { 'data-role': 'swept-due' },
          el('p', {}, `Due for deletion: ${due.length}. Delete each from its own page.`),
          el(
            'ul',
            { class: 'lines' },
            due.map((c) => el('li', {}, isolated(String(c.slug ?? '')), `: ${deletionWord(c.deletionState)}`)),
          ),
        )
      : null,
    Number.isInteger(r.remaining) && r.remaining > 0 ? el('p', {}, `${r.remaining} more are waiting; run the sweep again.`) : null,
  );
}

/* The glance's pieces, each drawn alone from the rows this page holds (operator-glance.mjs). */
const glanceLink = (row) =>
  link(operatorCompanyTarget(row.companyId), isolated(String(row.name ?? '')), { 'data-role': 'glance-company-link' });
const PARTIAL = ' Counted over the companies listed so far.';

function glanceStatus() {
  return el('p', { 'data-role': 'glance-status' }, `${statusSentence(statusSummary(rows))}${next ? PARTIAL : ''}`);
}

function glanceEnding(now) {
  const { items, later } = endingSoonest(rows, now);
  return el(
    'div',
    { class: 'glance-part', 'data-role': 'glance-ending' },
    el('h3', {}, 'Agreements ending soonest'),
    items.length
      ? el(
          'ol',
          { class: 'lines' },
          items.map((i) =>
            el(
              'li',
              { 'data-glance-company': i.row.companyId, 'data-word': i.word ?? 'none', 'data-days': i.days },
              i.word ? el('span', { class: 'tag', 'data-role': 'agreement-word' }, i.word) : null,
              i.word ? ' ' : null,
              glanceLink(i.row),
              ': ',
              i.sentence,
            ),
          ),
        )
      : el('p', {}, 'No company listed here has agreement dates.'),
    el(
      'p',
      { class: 'meta' },
      `${later > 0 ? `${later} more with later end dates are in the table below. ` : ''}Closed companies are left out; a closed company whose deletion is due or overdue is under Needs you.${next ? PARTIAL : ''}`,
    ),
  );
}

function glanceNeeds() {
  const needs = needsYou(rows);
  return el(
    'div',
    { class: 'glance-part', 'data-role': 'glance-needs' },
    el('h3', {}, 'Needs you'),
    needs.length
      ? el(
          'ul',
          { class: 'lines' },
          needs.map((x) => el('li', { 'data-glance-company': x.row.companyId }, glanceLink(x.row), ': ', `${x.reasons.join('; ')}.`)),
        )
      : el('p', {}, 'Nothing in the companies listed here needs you now.'),
    el('p', { class: 'meta' }, `Open invitations are counted for every role; the register does not say whose they are.${next ? PARTIAL : ''}`),
  );
}

function glanceSection(now) {
  return el('section', { class: 'panel glance', 'data-role': 'glance' }, el('h2', {}, 'At a glance'), glanceStatus(), glanceEnding(now), glanceNeeds());
}

function render() {
  const now = Date.now();
  fill(
    main,
    el(
      'div',
      { class: 'page-head' },
      heading('Customer companies', LIFECYCLE_TEXT.registerLead),
      el(
        'div',
        { class: 'toolbar' },
        link('/operator/new/', 'New company', { class: 'button', 'data-role': 'new-company' }),
        button('Reload', load, { class: 'secondary', 'data-role': 'reload' }),
      ),
    ),
    glanceSection(now),
    registerSection(now),
    sweepSection(),
    el(
      'section',
      { class: 'panel', 'data-role': 'unclaimed' },
      el('h2', {}, 'Unclaimed accounts'),
      el('p', { 'data-role': 'unclaimed-count' }, `Accounts nobody confirmed, with no company, no session and no open invitation: ${count(sweepable)}.`),
      el('p', { class: 'meta' }, LIFECYCLE_TEXT.unclaimedAccounts),
    ),
  );
}

async function load() {
  fill(main, loading('Loading the register.'));
  const [m, r] = await Promise.all([me(), operatorCompanies()]);
  if (m.action === 'navigating' || r.action === 'navigating') return;
  if (m.ok) renderHeader(header, { email: m.data.user.email, onSignOut: signOut, operator: isOperator(r) });
  else return showPageState(header, main, failureView(m, { retry: load }));
  if (!r.ok) return refused(r);
  accept(r.data, false);
  render();
}

keepFresh({
  clear: () => {
    rows = [];
    next = null;
    swept = null;
    fill(main);
    renderPlainHeader(header);
  },
  reload: load,
});
load();
