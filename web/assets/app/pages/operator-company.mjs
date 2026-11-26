/* One company as the operator sees it, /operator/company/?company=<uuid> (E6 design 1.1, 1.3, 1.5, 1.6, 1.7, 4.1 items
   1 to 9, and 4.2).

   Order of calls. GET /api/me for the header's address and GET /api/operator/companies/{id}/takeout-manifest
   together. The manifest read is the register row of this one company plus its counts-only manifest, and it is the
   only read: every block below is drawn from it, and every control is rendered only after it answered 200, which
   only an operator at aal2 gets. Its refusal routes the page as the register's does: E_OPERATOR_MFA_REQUIRED to the
   link to /mfa/, E_NOT_OPERATOR to the not-found state with the server's message and a link home, E_NOT_FOUND to
   the company's own not-found state (an unknown, deleted or malformed id, one answer). After every write the page
   reads the manifest again and shows where the company now is; a refusal whose action is reload (E_COMPANY_CLOSED)
   does the same.

   What it shows, top to bottom (design 4.1): a company with no agreement dates says so above everything; identity
   and counts with the fixed sentence about what the page does not show; status with Suspend or Resume and a reason
   the audit row records, hidden for a closed company; the access period with the two derived states as sentences
   and a form that sets it; the quotas, each with its value, usage, source and a field, the allowed range decided by
   the server alone (it is in no answer, so the page keeps no copy of it); pending invitations as a count and never an
   address; administrator succession, by account id and by a new invitation whose link is shown once; the manifest
   as counts, with no control that takes a copy, because Phaeacia does not take a customer's records from here; Close
   only when suspended, with the typed slug and, while the reading window is open, the one reason the server admits
   and the sentence that closing cuts the window short; Delete only when closed, with the deletion state above it,
   the typed slug, the two admissible reasons and, after the answer, what was deleted section by section.

   Writes carry no Idempotency-Key (design 3.3). The three set-to-a-value writes are last-writer-wins (E6D-C-F10): a
   repeat answers changed: false, and the page says "Nothing changed" rather than claiming a write. */

import { closeCompany, deleteCompany, grantAdministrator, inviteAdministrator, me, setAccessPeriod, setCompanyQuota, setCompanyStatus, signOutHere, takeoutManifest } from '../api.mjs';
import { button, el, field, fill, form, isolated } from '../dom.mjs';
import { companyParam } from '../params.mjs';
import { acceptLinkBlock, accessSentence, accessWord, choice, closeReasonLabel, count, dataTable, dayText, DELETE_REASON_CODES, deleteReasonLabel, deletionSentence, deletionWord, fact, LIFECYCLE_REASON_CODES, LIFECYCLE_TEXT, notOperatorView, operatorCompanyGoneView, quotaLabel, isPerSubject, STATUS_REASON_CODES, statusReasonLabel, statusWord } from '../lifecycle-view.mjs';
import { failureView, heading, isOperator, keepFresh, link, loading, notice, renderHeader, renderPlainHeader, showPageState, startPage, statusRegion } from '../shell.mjs';

const { header, main } = startPage();
const companyId = companyParam();
let row = null;
let flash = null;
/* The answer that made a succession invitation, for this page's life only (design 1.2 rule 1). */
let handover = null;
/* The deletion's answer: the company no longer exists, so the page shows it and reads nothing again. */
let deleted = null;

const COUNT_LABELS = Object.freeze({
  membershipsActive: 'Active members',
  membershipsRemoved: 'Former members',
  admins: 'Administrators',
  invitationsPending: 'Open invitations',
  invitationsAccepted: 'Accepted invitations',
  groups: 'Audience groups',
  agentsActive: 'Agents with an owner',
  agentsOrphaned: 'Agents without an owner',
  agentsArchived: 'Archived agents',
  candidatesDraft: 'Drafts',
  candidatesSubmitted: 'Submitted versions',
  candidatesApproved: 'Approved versions',
  candidatesChangesRequested: 'Versions sent back for changes',
  candidatesSuperseded: 'Superseded versions',
  envelopes: 'Review envelopes',
  reviews: 'Reviews',
  releasesPublished: 'Published releases',
  releasesWithdrawn: 'Withdrawn releases',
  downloads: 'Download authorizations',
  reports: 'Installation reports',
  witnesses: 'Witness statements',
  auditRows: 'Audit rows',
  contentBytes: 'Content bytes',
  assembledBytes: 'Assembled bytes',
});
const countLabel = (key) => (Object.hasOwn(COUNT_LABELS, key) ? COUNT_LABELS[key] : key);
const dateOnly = (iso) => (typeof iso === 'string' ? iso.slice(0, 10) : '');
const dayStart = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : null);

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

function gone() {
  row = null;
  handover = null;
  fill(main, operatorCompanyGoneView());
}

/* An answer to an action: not an operator and not found replace the page; reload reads the company again; anything
   else shows beside the control that caused it, with the action api.mjs names. */
function settle(r, status, retry) {
  if (r.action === 'navigating') return;
  if (r.code === 'E_NOT_OPERATOR') return fill(main, notOperatorView(r.message));
  if (r.action === 'not-found') return gone();
  if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
  if (r.action === 'reload') {
    flash = failureView(r);
    return load();
  }
  fill(status, failureView(r, { retry }));
}

/* A write followed by a fresh read: the page shows the company as the service now has it. */
async function write(send, status, done) {
  fill(status);
  const r = await send();
  if (r.action === 'navigating') return;
  if (r.ok) {
    flash = notice(r.data?.changed === false ? 'Nothing changed: it was already that way.' : done, 'operator-changed');
    return load();
  }
  settle(r, status, () => write(send, status, done));
}

/* ---------- 1. identity and counts ---------- */

function identitySection() {
  const given = row.counts !== null && typeof row.counts === 'object' ? row.counts : {};
  /* In the order of the label list, which groups what belongs together; a key the list does not know follows. */
  const keys = [...Object.keys(COUNT_LABELS).filter((k) => Object.hasOwn(given, k)), ...Object.keys(given).filter((k) => !Object.hasOwn(COUNT_LABELS, k))];
  const counts = keys.map((k) => [k, given[k]]);
  return el(
    'section',
    { 'data-role': 'identity' },
    el('p', { class: 'meta' }, LIFECYCLE_TEXT.companyLead),
    el(
      'dl',
      { class: 'facts' },
      fact('Slug', isolated(String(row.slug ?? ''))),
      fact('Created', dayText(row.createdAt) ?? 'unknown'),
      fact('Status', el('span', { 'data-role': 'status-word' }, statusWord(row.status))),
    ),
    el('h2', {}, 'What it holds, counted'),
    dataTable('counts-table', ['What', 'How many'], counts.map(([key, n]) => [countLabel(key), count(n)])),
  );
}

/* ---------- 2. status ---------- */

function statusSection() {
  const box = el('section', { class: 'panel', 'data-role': 'status' }, el('h2', {}, 'Status'));
  if (row.status === 'closed') {
    box.append(el('p', { 'data-role': 'closed-sentence' }, LIFECYCLE_TEXT.closedCompany));
    return box;
  }
  const status = statusRegion('status-status');
  const tools = el('div', { class: 'tools' });
  const target = row.status === 'active' ? 'suspended' : 'active';
  const label = target === 'suspended' ? 'Suspend' : 'Resume';
  const ask = () => {
    const reason = choice('status-reason', 'Why', STATUS_REASON_CODES.map((c) => [c, statusReasonLabel(c)]));
    fill(
      tools,
      el(
        'div',
        { class: 'confirm-box', 'data-role': 'confirm-status' },
        el(
          'p',
          {},
          target === 'suspended'
            ? 'Suspend this company? Nobody in it can read or change anything until it is resumed.'
            : 'Resume this company? Its members can work in it again, within its agreement dates.',
        ),
        reason.wrap,
        el(
          'div',
          { class: 'actions' },
          button(
            `${label} now`,
            () => write(() => setCompanyStatus(companyId, { status: target, reasonCode: reason.value() }), status, target === 'suspended' ? 'Suspended.' : 'Resumed.'),
            { class: target === 'suspended' ? 'danger' : '', 'data-role': 'confirm-status-change' },
          ),
          button('Cancel', rest, { class: 'quiet', 'data-role': 'cancel' }),
        ),
      ),
    );
  };
  const rest = () => fill(tools, button(label, ask, { class: 'secondary', 'data-role': target === 'suspended' ? 'suspend' : 'resume' }));
  rest();
  box.append(el('p', {}, `This company is ${statusWord(row.status).toLowerCase()}.`), tools, status);
  return box;
}

/* ---------- 3. access period ---------- */

function periodSection() {
  const p = row.accessPeriod ?? { state: 'none' };
  const status = statusRegion('period-status');
  const starts = field({ label: 'Agreement starts', id: 'period-start', type: 'date', value: dateOnly(p.startsAt) });
  const ends = field({ label: 'Agreement ends', id: 'period-end', type: 'date', value: dateOnly(p.endsAt) });
  const invoice = field({ label: 'Invoice reference, if there is one', id: 'invoice-ref', autocomplete: 'off', spellcheck: 'false', value: p.invoiceRef ?? '' });
  const submit = el('button', { type: 'submit', 'data-role': 'set-period' }, 'Set the agreement dates');
  const send = async () => {
    submit.disabled = true;
    await write(
      () =>
        setAccessPeriod(companyId, {
          startsAt: dayStart(starts.input.value),
          endsAt: dayStart(ends.input.value),
          invoiceRef: invoice.input.value === '' ? null : invoice.input.value,
        }),
      status,
      'The agreement dates are set.',
    );
    submit.disabled = false;
  };
  return el(
    'section',
    { class: 'panel', 'data-role': 'access-period', 'data-access': p.state ?? 'none', 'data-deletion': p.deletionState ?? 'not_eligible' },
    el('h2', {}, 'Access period'),
    p.state === 'none'
      ? null
      : el(
          'dl',
          { class: 'facts' },
          fact('Invoice reference', p.invoiceRef ? isolated(String(p.invoiceRef)) : 'none'),
          fact('Starts', dayText(p.startsAt) ?? 'no date'),
          fact('Ends', dayText(p.endsAt) ?? 'no date'),
          fact('Reading and exporting stop', dayText(p.exportBy) ?? 'no date'),
          fact('Deletion due by', dayText(p.deleteBy) ?? 'no date'),
          fact('Access', accessWord(p.state)),
          fact('Deletion', deletionWord(p.deletionState)),
        ),
    el('p', { 'data-role': 'access-sentence' }, accessSentence(p)),
    el('p', { 'data-role': 'deletion-sentence' }, deletionSentence(p)),
    form(
      { class: 'stack', 'data-role': 'period-form' },
      send,
      starts.wrap,
      ends.wrap,
      invoice.wrap,
      el('p', { class: 'meta' }, LIFECYCLE_TEXT.datesAreUtc),
      el('p', { class: 'meta' }, LIFECYCLE_TEXT.periodComputed),
      submit,
      status,
    ),
  );
}

/* ---------- 4. quotas ---------- */

function quotaRow(q) {
  const status = statusRegion('quota-status');
  const id = `quota-${q.name}`;
  const input = el('input', { type: 'number', id, name: id, inputmode: 'numeric', step: 1, value: q.value, 'data-role': 'quota-value' });
  const set = () =>
    write(() => setCompanyQuota(companyId, { name: q.name, value: Number(input.value) }), status, `${quotaLabel(q.name)} is set.`);
  const usage = Number.isInteger(q.used)
    ? `${count(q.used)} of ${count(q.value)}${isPerSubject(q.name) ? ', for the busiest agent or person' : ''}`
    : count(q.value);
  return el(
    'li',
    { class: 'card', 'data-quota': q.name, 'data-source': q.source ?? 'unknown' },
    el('div', { class: 'card-head' }, el('span', {}, quotaLabel(q.name)), el('span', { class: 'tag' }, q.source === 'company' ? 'Set for this company' : 'Default')),
    el('p', { class: 'meta', 'data-role': 'quota-usage' }, usage),
    el(
      'div',
      { class: 'actions' },
      el('label', { for: id }, 'New value'),
      input,
      button('Set', set, { class: 'secondary', 'data-role': 'set-quota' }),
    ),
    status,
  );
}

function quotasSection() {
  const list = Array.isArray(row.quotas) ? row.quotas : [];
  return el(
    'section',
    { 'data-role': 'quotas' },
    el('h2', {}, 'Quotas'),
    el('p', { class: 'meta' }, LIFECYCLE_TEXT.quotaBoundsServer),
    el('ul', { class: 'cards' }, list.map(quotaRow)),
  );
}

/* ---------- 5. pending invitations ---------- */

function pendingSection() {
  return el(
    'section',
    { 'data-role': 'pending-invitations' },
    el('h2', {}, 'Open invitations'),
    el('p', { 'data-role': 'pending-count' }, `Open invitations: ${count(row.counts?.invitationsPending)}.`),
    el('p', { class: 'meta' }, LIFECYCLE_TEXT.pendingInvitationsLead),
  );
}

/* ---------- 6. administrator succession ---------- */

function successionSection() {
  if (row.status === 'closed') return null;
  const grantStatus = statusRegion('grant-status');
  const user = field({ label: 'Account id', id: 'grant-user', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const grant = () =>
    write(() => grantAdministrator(companyId, user.input.value.trim()), grantStatus, 'The administrator role is granted.');
  const inviteStatus = statusRegion('admin-invite-status');
  const email = field({ label: 'Address of the new administrator', id: 'admin-email', type: 'email', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const days = field({ label: 'Days until the invitation expires, 1 to 30', id: 'admin-days', type: 'number', min: 1, max: 30, step: 1, value: 7, inputmode: 'numeric' });
  const invite = async () => {
    fill(inviteStatus);
    const r = await inviteAdministrator(companyId, { email: email.input.value, expiresInDays: Number(days.input.value) });
    if (r.action === 'navigating') return;
    if (r.ok) {
      handover = r.data;
      flash = notice('A new administrator invitation is open. Any earlier one for that address has stopped working.', 'admin-invited');
      return load();
    }
    settle(r, inviteStatus, invite);
  };
  return el(
    'section',
    { class: 'panel', 'data-role': 'succession' },
    el('h2', {}, 'Administrator succession'),
    el('h3', {}, 'Grant the administrator role to a member'),
    el('p', { class: 'meta' }, LIFECYCLE_TEXT.grantHint),
    form({ class: 'stack', 'data-role': 'grant-form' }, grant, user.wrap, el('button', { type: 'submit', 'data-role': 'grant-admin' }, 'Grant administrator'), grantStatus),
    el('h3', {}, 'Invite a new administrator'),
    form(
      { class: 'stack', 'data-role': 'admin-invite-form' },
      invite,
      email.wrap,
      days.wrap,
      el('button', { type: 'submit', 'data-role': 'invite-admin' }, 'Invite a new administrator'),
      inviteStatus,
    ),
    handover ? acceptLinkBlock(handover, { id: 'admin-accept-link', operator: true }) : null,
  );
}

/* ---------- 7. the counts-only manifest ---------- */

function manifestSection() {
  const m = row.exportManifest ?? {};
  const sections = m.sections !== null && typeof m.sections === 'object' ? Object.entries(m.sections) : [];
  return el(
    'section',
    { 'data-role': 'manifest', 'data-over-ceiling': m.overRouteCeiling === true ? 'yes' : 'no' },
    el('h2', {}, 'Export manifest'),
    el('p', { class: 'boundary', 'data-role': 'manifest-no-copy' }, LIFECYCLE_TEXT.manifestNoCopy),
    dataTable('manifest-table', ['Section', 'Rows'], sections.map(([name, n]) => [el('code', {}, name), count(n)])),
    el(
      'dl',
      { class: 'facts' },
      fact('Content bytes', count(m.contentBytes)),
      fact('Assembled bytes', count(m.assembledBytes)),
      fact('Estimated size of the file', `${count(m.estimatedSerializedBytes)} bytes`),
      fact('The most one answer carries', `${count(m.routeCeilingBytes)} bytes`),
    ),
    el('p', { 'data-role': 'manifest-sentence' }, m.overRouteCeiling === true ? LIFECYCLE_TEXT.manifestOver : LIFECYCLE_TEXT.manifestUnder),
  );
}

/* ---------- 8. close ---------- */

function closeSection() {
  if (row.status !== 'suspended') return null;
  const p = row.accessPeriod ?? { state: 'none' };
  const windowOpen = p.state === 'current' || p.state === 'export_window';
  const reason = choice(
    'close-reason',
    'Why',
    (windowOpen ? ['customer_instruction'] : LIFECYCLE_REASON_CODES).map((c) => [c, closeReasonLabel(c)]),
  );
  const slug = field({ label: 'Type the slug to confirm', id: 'close-slug', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const status = statusRegion('close-status');
  const close = () =>
    write(() => closeCompany(companyId, { confirmSlug: slug.input.value, reasonCode: reason.value() }), status, 'The company is closed.');
  return el(
    'section',
    { class: 'panel', 'data-role': 'close', 'data-window-open': windowOpen ? 'yes' : 'no' },
    el('h2', {}, 'Close'),
    windowOpen
      ? el(
          'p',
          { class: 'notice', 'data-role': 'cut-short' },
          `This company can still read its records, and take a copy with Export, until ${dayText(p.exportBy) ?? 'the end of its window'}. Closing now ends that early. `,
          LIFECYCLE_TEXT.closeOnlyInstruction,
        )
      : null,
    el('p', { class: 'boundary' }, LIFECYCLE_TEXT.closeWarning),
    form(
      { class: 'stack', 'data-role': 'close-form' },
      close,
      reason.wrap,
      slug.wrap,
      el('button', { type: 'submit', class: 'danger', 'data-role': 'close-company' }, 'Close this company'),
      status,
    ),
  );
}

/* ---------- 9. delete ---------- */

function deleteSection() {
  if (row.status !== 'closed') return null;
  const reason = choice('delete-reason', 'Why', DELETE_REASON_CODES.map((c) => [c, deleteReasonLabel(c)]));
  const slug = field({ label: 'Type the slug to confirm', id: 'delete-slug', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const status = statusRegion('delete-status');
  const remove = async () => {
    fill(status);
    const r = await deleteCompany(companyId, { confirmSlug: slug.input.value, reasonCode: reason.value() });
    if (r.action === 'navigating') return;
    if (r.ok) {
      deleted = { answer: r.data, slug: row.slug, name: row.name };
      return renderDeleted();
    }
    settle(r, status, remove);
  };
  return el(
    'section',
    { class: 'panel', 'data-role': 'delete', 'data-deletion': row.accessPeriod?.deletionState ?? 'not_eligible' },
    el('h2', {}, 'Delete'),
    el('p', { 'data-role': 'delete-deletion-sentence' }, deletionSentence(row.accessPeriod)),
    el('p', { class: 'boundary' }, LIFECYCLE_TEXT.deleteWhat),
    form(
      { class: 'stack', 'data-role': 'delete-form' },
      remove,
      reason.wrap,
      slug.wrap,
      el('button', { type: 'submit', class: 'danger', 'data-role': 'delete-company' }, "Delete this company's records"),
      status,
    ),
  );
}

function renderDeleted() {
  const { answer, slug, name } = deleted;
  const sections = answer.deleted !== null && typeof answer.deleted === 'object' ? Object.entries(answer.deleted) : [];
  const orphaned = Array.isArray(answer.orphanedUserIds) ? answer.orphanedUserIds.length : 0;
  fill(
    main,
    heading('Company deleted'),
    el(
      'section',
      { class: 'panel', 'data-role': 'deleted' },
      el('p', {}, isolated(String(name ?? '')), ' ', el('span', { class: 'tag' }, isolated(String(slug ?? ''))), ': every record listed below is gone.'),
      dataTable('deleted-table', ['Section', 'Rows deleted'], sections.map(([k, n]) => [el('code', {}, k), count(n)])),
      el('p', { 'data-role': 'orphaned-accounts' }, `Accounts that now belong to no company: ${orphaned}. ${LIFECYCLE_TEXT.deletedAccounts}`),
      link('/operator/', 'Go to the register', { class: 'button', 'data-role': 'register-link' }),
    ),
  );
}

function render() {
  const shown = flash;
  flash = null;
  const noPeriod = (row.accessPeriod?.state ?? 'none') === 'none';
  fill(
    main,
    noPeriod ? el('p', { class: 'notice', role: 'status', 'data-state': 'no-period' }, LIFECYCLE_TEXT.noPeriod) : null,
    shown,
    el(
      'div',
      { class: 'page-head' },
      heading(isolated(String(row.name ?? ''))),
      el(
        'div',
        { class: 'toolbar' },
        link('/operator/', 'Register', { class: 'button secondary', 'data-role': 'register-link' }),
        button('Reload', load, { class: 'secondary', 'data-role': 'reload' }),
      ),
    ),
    identitySection(),
    statusSection(),
    periodSection(),
    quotasSection(),
    pendingSection(),
    successionSection(),
    manifestSection(),
    closeSection(),
    deleteSection(),
  );
}

async function load() {
  if (deleted) return renderDeleted();
  if (!row) fill(main, loading('Loading the company.'));
  const [m, r] = await Promise.all([me(), companyId ? takeoutManifest(companyId) : null]);
  if (m.action === 'navigating' || r?.action === 'navigating') return;
  if (m.ok) renderHeader(header, { email: m.data.user.email, onSignOut: signOut, operator: isOperator(r) });
  else return showPageState(header, main, failureView(m, { retry: load }));
  if (!r) return gone();
  if (!r.ok) {
    if (r.code === 'E_NOT_OPERATOR') return fill(main, notOperatorView(r.message));
    if (r.action === 'not-found') return gone();
    if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
    row = null;
    return fill(main, heading('Company'), failureView(r, { retry: load }));
  }
  row = r.data;
  render();
}

keepFresh({
  clear: () => {
    row = null;
    flash = null;
    handover = null;
    deleted = null;
    fill(main);
    renderPlainHeader(header);
  },
  reload: load,
});
load();
