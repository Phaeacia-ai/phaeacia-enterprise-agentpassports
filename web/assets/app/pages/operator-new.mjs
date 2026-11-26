/* Create a company with its first administrator, /operator/new/ (E6 design 1.1, 1.2, 1.5, 4.1 and 4.2).

   Order of calls. GET /api/me for the header's address and GET /api/operator/companies together; the form is a write
   control, so it is rendered only after the register answered 200 (design 4.1's table), and the register's refusal
   routes the page exactly as it does on /operator/. POST /api/operator/companies on the press.

   The form. The slug, the name, the first administrator's address, the days the invitation lives (1 to 30, default 7),
   and the access period: its start and end dates and an optional invoice reference. The dates are required because
   the routine writes the period in the same transaction as the company and refuses a company without one (design 1.5);
   the page sends them as the start of that day in UTC and says so. The copying and deletion dates are not computed
   here: the only rule for them is the database's, and web/ may not keep a copy of it, so the page shows the dates the
   service stored, from its answer, once it has stored them (E6P-F3 in evidence/e6-pages.md).

   The answer. 201 shows the company, the stored period and the accept link once, in a read-only field with a copy
   control and never as a link (design 4.3), under design 1.2's paragraph, rule 5's sentence that Phaeacia is holding
   the person's first factor (for a link that signs in; ENA-7), and the recovery line; in mail mode the one sentence instead. The answer is kept in page
   memory for this page's life and dropped on pagehide, so a reload or the back button does not show the link again
   (design 1.2 rule 1). A refusal is shown beside the field it concerns: a taken or malformed slug at the slug, an
   address the service refuses at the address. */

import { createCompany, me, operatorCompanies, signOutHere } from '../api.mjs';
import { button, el, field, fill, form, isolated } from '../dom.mjs';
import { acceptLinkBlock, dayText, LIFECYCLE_TEXT, notOperatorView, operatorCompanyTarget } from '../lifecycle-view.mjs';
import { failureView, heading, isOperator, keepFresh, link, loading, renderHeader, renderPlainHeader, showPageState, startPage, statusRegion } from '../shell.mjs';

const { header, main } = startPage();
let created = null;

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

function refused(r) {
  if (r.code === 'E_NOT_OPERATOR') return fill(main, notOperatorView(r.message));
  if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
  return fill(main, heading('New company'), failureView(r, { retry: load }));
}

/* A date field's value as the start of that day in UTC, or null for an empty field, which the service refuses. */
const dayStart = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : null);
const today = () => new Date().toISOString().slice(0, 10);

const SLUG_CODES = new Set(['E_CONFLICT', 'E_SLUG_INVALID']);
const ADDRESS_CODES = new Set(['E_EMAIL_INVALID', 'E_OPERATOR_ACCOUNT']);

function renderForm() {
  const slug = field({ label: 'Slug, lower-case letters, digits and hyphens', id: 'company-slug', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const name = field({ label: 'Name', id: 'company-name', autocomplete: 'off' });
  const email = field({ label: "First administrator's address", id: 'first-admin-email', type: 'email', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const days = field({ label: 'Days until the invitation expires, 1 to 30', id: 'invite-days', type: 'number', min: 1, max: 30, step: 1, value: 7, inputmode: 'numeric' });
  const starts = field({ label: 'Agreement starts', id: 'period-start', type: 'date', value: today() });
  const ends = field({ label: 'Agreement ends', id: 'period-end', type: 'date' });
  const invoice = field({ label: 'Invoice reference, if there is one', id: 'invoice-ref', autocomplete: 'off', spellcheck: 'false' });
  const slugStatus = statusRegion('slug-status');
  const emailStatus = statusRegion('email-status');
  const status = statusRegion('create-status');
  const submit = el('button', { type: 'submit', 'data-role': 'create-company' }, 'Create the company');
  const send = async () => {
    submit.disabled = true;
    fill(slugStatus);
    fill(emailStatus);
    fill(status);
    const r = await createCompany({
      slug: slug.input.value,
      name: name.input.value,
      firstAdminEmail: email.input.value,
      expiresInDays: Number(days.input.value),
      startsAt: dayStart(starts.input.value),
      endsAt: dayStart(ends.input.value),
      invoiceRef: invoice.input.value === '' ? null : invoice.input.value,
    });
    submit.disabled = false;
    if (r.action === 'navigating') return;
    if (r.ok) {
      created = { answer: r.data, slug: slug.input.value, name: name.input.value };
      return renderCreated();
    }
    if (r.code === 'E_NOT_OPERATOR') return fill(main, notOperatorView(r.message));
    if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
    const where = SLUG_CODES.has(r.code) ? slugStatus : ADDRESS_CODES.has(r.code) ? emailStatus : status;
    fill(where, failureView(r, { retry: send }));
  };
  fill(
    main,
    el(
      'div',
      { class: 'page-head' },
      heading('New company', 'A company, its agreement dates, and an invitation for its first administrator, in one step.'),
      el('div', { class: 'toolbar' }, link('/operator/', 'Back to the register', { class: 'button secondary', 'data-role': 'register-link' })),
    ),
    form(
      { class: 'stack', 'data-role': 'create-form' },
      send,
      slug.wrap,
      slugStatus,
      name.wrap,
      email.wrap,
      emailStatus,
      days.wrap,
      el(
        'fieldset',
        { class: 'choice', 'data-role': 'period' },
        el('legend', {}, 'The access period'),
        starts.wrap,
        ends.wrap,
        invoice.wrap,
        el('p', { class: 'meta' }, LIFECYCLE_TEXT.datesAreUtc),
        el('p', { class: 'meta', 'data-role': 'period-computed' }, LIFECYCLE_TEXT.periodComputed),
      ),
      submit,
      status,
    ),
  );
}

function renderCreated() {
  const { answer, slug, name } = created;
  const period = answer.accessPeriod ?? {};
  fill(
    main,
    heading('Company created'),
    el(
      'section',
      { class: 'panel', 'data-role': 'created' },
      el('p', { 'data-role': 'created-company' }, isolated(name), ' ', el('span', { class: 'tag' }, isolated(slug))),
      el(
        'p',
        { class: 'meta', 'data-role': 'stored-period' },
        `Stored: the agreement ends on ${dayText(period.endsAt) ?? 'no date'}, reading and exporting stop on ${dayText(period.exportBy) ?? 'no date'}, and deletion is due by ${dayText(period.deleteBy) ?? 'no date'}.`,
      ),
      el('p', { class: 'meta' }, `The invitation expires on ${dayText(answer.expiresAt) ?? 'a date the service did not give'}.`),
    ),
    el('section', { 'data-role': 'first-admin-link' }, el('h2', {}, 'The first administrator’s link'), acceptLinkBlock(answer, { id: 'accept-link', operator: true })),
    el(
      'div',
      { class: 'actions' },
      link(operatorCompanyTarget(answer.companyId), 'Open the company', { class: 'button', 'data-role': 'company-link' }),
      button('Create another company', () => {
        created = null;
        renderForm();
      }, { class: 'secondary', 'data-role': 'create-another' }),
    ),
  );
}

async function load() {
  fill(main, loading('Checking that this session may create a company.'));
  const [m, r] = await Promise.all([me(), operatorCompanies()]);
  if (m.action === 'navigating' || r.action === 'navigating') return;
  if (m.ok) renderHeader(header, { email: m.data.user.email, onSignOut: signOut, operator: isOperator(r) });
  else return showPageState(header, main, failureView(m, { retry: load }));
  if (!r.ok) return refused(r);
  if (created) return renderCreated();
  renderForm();
}

keepFresh({
  clear: () => {
    created = null;
    fill(main);
    renderPlainHeader(header);
  },
  reload: load,
});
load();
