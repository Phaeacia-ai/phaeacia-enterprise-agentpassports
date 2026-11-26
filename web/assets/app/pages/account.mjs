/* The account page, /account/ (pages design sections 1 and 2.1, revision 6).

   The signed-in address; the display name, prefilled from GET /api/me and empty when none is set, with "Save name",
   which sends { displayName: <the field's value> } and nothing else, keeps no copy of the rule (no length limit and no
   pattern, because a browser counts differently from the rule), shows the server's message on 422, and reads
   GET /api/me again on 204 to show the stored name in a bdi element; whether this session is verified with a second
   factor; the authenticators with their names and dates, remove (a verified one only at aal2) and add another (at
   aal2, on /mfa/); and sign out, this device only, which asks first in the header's dialog (UI updates U6,
   evidence/ui-updates.md: Raffael's decision relayed by the lead, shell.mjs askingSignOut). An administrator without a verified factor is moved to /mfa/
   before the page shows anything. After a removal the page reads GET /api/me again, because a removal can drop the
   session to aal1. A person with no membership may be an operator: the page reads the register once to learn it and
   draws the operator's navigation in the header when the answer shows one (HOSTED-F2, evidence/operator-landing.md). */

import { factors, me, operatorCompanies, removeFactor, sendAdminsToEnrolment, setDisplayName, signOutHere } from '../api.mjs';
import { add, button, el, field, fill, form, isolated } from '../dom.mjs';
import { askingSignOut, dateLine, failureView, heading, isOperator, keepFresh, link, loading, notice, renderHeader, renderPlainHeader, showPageState, startPage, statusRegion } from '../shell.mjs';

const { header, main } = startPage();

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

function stopped(r) {
  if (r.action === 'navigating') return true;
  if (r.action === 'maintenance') {
    showPageState(header, main, failureView(r, { retry: () => load() }));
    return true;
  }
  return false;
}

function nameSection(user) {
  const name = field({ label: 'Display name', id: 'display-name', type: 'text', autocomplete: 'name', spellcheck: 'false' });
  name.input.value = user.displayName ?? '';
  const status = statusRegion('name-status');
  const submit = el('button', { type: 'submit', 'data-role': 'save-name' }, 'Save name');
  const save = form(
    { class: 'stack', 'data-role': 'name-form' },
    async () => {
      submit.disabled = true;
      fill(status);
      const r = await setDisplayName(name.input.value);
      submit.disabled = false;
      if (stopped(r)) return;
      if (r.ok) return load(notice('Name saved.', 'name-saved'));
      fill(status, failureView(r, { retry: () => save.requestSubmit() }));
    },
    name.wrap,
    submit,
    status,
  );
  return el(
    'section',
    { class: 'panel', 'data-role': 'display-name' },
    el('h2', {}, 'Display name'),
    el(
      'p',
      { 'data-role': 'stored-name-line' },
      'Members of your companies see: ',
      user.displayName ? isolated(user.displayName, { 'data-role': 'stored-name' }) : el('span', { class: 'muted', 'data-role': 'stored-name-none' }, 'no name set'),
    ),
    save,
  );
}

function factorCard(factor, verifiedSession) {
  const status = statusRegion('row-status');
  const tools = el('div', { class: 'tools' });
  const verified = factor.status === 'verified';
  const show = () => {
    if (verified && !verifiedSession) return fill(tools, el('p', { class: 'meta' }, 'Removing a verified authenticator needs your second factor.'));
    fill(tools, button('Remove', askRemoval, { class: 'secondary danger', 'data-role': 'remove-factor' }));
  };
  const remove = async () => {
    fill(status);
    const r = await removeFactor(factor.factorId);
    if (stopped(r)) return;
    if (r.ok) return load(notice('Authenticator removed.', 'factor-removed'));
    fill(status, failureView(r, { retry: remove }));
  };
  const askRemoval = () =>
    fill(
      tools,
      el(
        'div',
        { class: 'confirm-box', 'data-role': 'confirm-remove-factor' },
        el('p', {}, verified ? 'Remove this authenticator? If this session was verified with it, the session is no longer verified.' : 'Remove this unfinished setup?'),
        el(
          'div',
          { class: 'actions' },
          button('Confirm removal', remove, { class: 'danger', 'data-role': 'confirm-removal' }),
          button('Cancel', show, { class: 'quiet', 'data-role': 'cancel' }),
        ),
      ),
    );
  show();
  return el(
    'li',
    { class: 'card', 'data-factor': factor.factorId, 'data-status': factor.status },
    el('div', { class: 'card-head' }, el('span', { class: 'label' }, factor.friendlyName ?? 'Authenticator app'), el('span', { class: 'tag' }, verified ? 'verified' : 'not finished')),
    el('p', { class: 'meta' }, dateLine('Added ', factor.createdAt)),
    tools,
    status,
  );
}

function factorSection(user, answer) {
  const verifiedSession = user.aal === 'aal2';
  const box = el(
    'section',
    { class: 'panel', 'data-role': 'factors' },
    el('h2', {}, 'Second factor'),
    el('p', { 'data-role': 'session-aal', 'data-aal': user.aal }, verifiedSession ? 'This session is verified with a second factor.' : 'This session is not verified with a second factor.'),
  );
  if (!answer.ok) return add(box, [failureView(answer, { retry: () => load() })]);
  const list = answer.data.factors;
  if (list.length === 0) return add(box, [el('p', {}, 'No authenticator is set up. '), link('/mfa/', 'Set up an authenticator app', { class: 'button', 'data-role': 'mfa-link' })]);
  add(box, [el('ul', { class: 'cards', 'data-role': 'factor-list' }, list.map((f) => factorCard(f, verifiedSession)))]);
  add(box, [
    el(
      'div',
      { class: 'actions' },
      verifiedSession
        ? link('/mfa/', 'Add another authenticator', { class: 'button secondary', 'data-role': 'add-factor' })
        : link('/mfa/', 'Verify this session', { class: 'button secondary', 'data-role': 'mfa-link' }),
    ),
  ]);
  return box;
}

async function load(before = null) {
  fill(main, loading('Loading your account.'));
  const m = await me();
  if (stopped(m)) return;
  if (!m.ok) return showPageState(header, main, failureView(m, { retry: () => load() }));
  const enrolment = await sendAdminsToEnrolment(m.data);
  if (enrolment.moved || enrolment.answer?.action === 'navigating') return;
  if (enrolment.answer) return showPageState(header, main, failureView(enrolment.answer, { retry: () => load() }));
  const list = enrolment.factors ? { ok: true, data: enrolment.factors } : await factors();
  if (list.action === 'navigating') return;
  const standing = m.data.memberships.length === 0 ? await operatorCompanies() : null;
  if (standing?.action === 'navigating') return;
  const user = m.data.user;
  renderHeader(header, { email: user.email, onSignOut: signOut, operator: isOperator(standing) });
  fill(
    main,
    heading('Your account'),
    before,
    el(
      'section',
      { class: 'panel', 'data-role': 'address' },
      el('h2', {}, 'Email address'),
      el('p', {}, isolated(user.email, { 'data-role': 'address-value' })),
      el('p', { class: 'meta' }, 'Your sign-in links go to this address.'),
    ),
    nameSection(user),
    factorSection(user, list),
    el(
      'section',
      { class: 'panel', 'data-role': 'sign-out-section' },
      el('h2', {}, 'Sign out'),
      el('p', {}, 'Signing out ends the session in this browser. Your other devices stay signed in.'),
      askingSignOut(signOut, 'Sign out of this device', { role: 'sign-out-account', className: 'secondary' }),
    ),
  );
}

keepFresh({
  clear: () => {
    fill(main);
    renderPlainHeader(header);
  },
  reload: () => load(),
});
load();
