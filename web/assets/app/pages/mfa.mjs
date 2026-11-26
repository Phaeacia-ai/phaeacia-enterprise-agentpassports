/* The second-factor page, /mfa/ (pages design sections 1, 2.4 and 2.5).

   At aal2: verified, a link home, and a button to add another authenticator. At aal1 with a verified factor: the
   challenge, one code field, and a choice by name first when several factors are verified. At aal1 without one:
   enrolment, with the one sentence that before enrolment the email link is the only factor. An enrolment answer shows
   the QR code as an image, the setup key grouped for typing by hand, and the code field for the new factor; the key and
   the QR stay in page memory until the factor is verified, replaced or the page is left. A verification answering
   E_NOT_FOUND means another tab verified a different setup, or removed this one: the superseded state, "Start again".
   "Remove unfinished setups" sends one removal for each unfinished factor the page listed, by id, and none for a
   factor created after the list was read. After every verification and removal the page reads GET /api/me again,
   because the provider judges aal from the session and the page never trusts the aal it saw before. Verifications are
   sent one at a time (api.mjs's queue), never in parallel.

   The operator (HOSTED-F2, evidence/operator-landing.md). A person with no membership may be an operator, whom the home
   page sends here at aal1; the page reads the register once to learn it (shell.mjs operatorStanding) and draws the
   operator's navigation in the header when the answer shows one. A verified factor goes home as before, and the home
   page moves an operator on to /operator/. */

import { enrollFactor, factors, hasVerifiedFactor, me, operatorCompanies, removeFactor, signOutHere, verifyFactor } from '../api.mjs';
import { button, el, field, fill, form, qrImage } from '../dom.mjs';
import { failureView, heading, isOperator, keepFresh, link, loading, navigate, renderHeader, renderPlainHeader, showPageState, startPage, statusRegion } from '../shell.mjs';

const { header, main } = startPage();
let enrolment = null;

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

const digits = (input) => input.value.replace(/\s+/g, '');
const grouped = (secret) => (secret.match(/.{1,4}/g) ?? []).join(' ');
const codeField = (id) =>
  field({ label: 'Six-digit code', id, type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'done' });

function stopped(r) {
  if (r.action === 'navigating') return true;
  if (r.action === 'maintenance') {
    showPageState(header, main, failureView(r, { retry: load }));
    return true;
  }
  return false;
}

async function afterVerified() {
  enrolment = null;
  const m = await me();
  if (stopped(m)) return;
  if (!m.ok) return showPageState(header, main, failureView(m, { retry: load }));
  if (m.data.user.aal !== 'aal2') return load();
  fill(main, el('section', { class: 'narrow', 'data-state': 'verified-now' }, heading('Second factor verified', 'Taking you to your companies.')));
  navigate('/');
}

function unfinishedPanel(shown, { always = false } = {}) {
  if (shown.length === 0 && !always) return null;
  const status = statusRegion();
  const ids = shown.map((f) => f.factorId);
  const remove = async () => {
    fill(status);
    for (const id of ids) {
      const r = await removeFactor(id);
      if (stopped(r)) return;
      if (!r.ok && r.code !== 'E_NOT_FOUND') return fill(status, failureView(r, { retry: remove }));
    }
    enrolment = null;
    load();
  };
  return el(
    'section',
    { class: 'panel', 'data-role': 'unfinished' },
    el('h2', {}, 'Unfinished setups'),
    el(
      'p',
      {},
      shown.length === 1
        ? 'One authenticator setup on this account was started and not finished.'
        : `${shown.length} authenticator setups on this account were started and not finished.`,
    ),
    el('p', { class: 'meta' }, 'Removes setups you have not finished. If you just finished one in another tab, finish or reload here first.'),
    ids.length ? button('Remove unfinished setups', remove, { class: 'secondary', 'data-role': 'remove-unfinished' }) : null,
    status,
  );
}

function superseded(area) {
  enrolment = null;
  fill(
    area,
    el(
      'div',
      { class: 'notice', role: 'alert', 'data-state': 'superseded' },
      el('p', {}, 'This setup was replaced by another one. Start again.'),
      button('Start again', () => startEnrolment(area), { 'data-role': 'start-again' }),
    ),
  );
}

async function startEnrolment(area) {
  const r = await enrollFactor();
  if (stopped(r)) return;
  if (!r.ok) {
    if (r.code === 'E_MFA_FACTOR_LIMIT') {
      const list = await factors();
      if (stopped(list)) return;
      const shown = list.ok ? list.data.factors.filter((f) => f.status !== 'verified') : [];
      return fill(area, failureView(r), unfinishedPanel(shown, { always: true }));
    }
    return fill(area, failureView(r, { retry: () => startEnrolment(area) }));
  }
  enrolment = { factorId: r.data.factorId, qrCodeSvg: r.data.qrCodeSvg, secret: r.data.secret };
  const status = statusRegion();
  const code = codeField('enrol-code');
  const submit = el('button', { type: 'submit', 'data-role': 'verify-enrolment' }, 'Verify and turn on');
  const factorId = enrolment.factorId;
  const verify = form(
    { class: 'stack', 'data-role': 'enrol-form' },
    async () => {
      submit.disabled = true;
      fill(status);
      const v = await verifyFactor(factorId, digits(code.input));
      submit.disabled = false;
      if (stopped(v)) return;
      if (v.ok) return afterVerified();
      if (v.code === 'E_NOT_FOUND') return superseded(area);
      fill(status, failureView(v, { retry: () => verify.requestSubmit() }));
    },
    code.wrap,
    submit,
    status,
  );
  fill(
    area,
    el(
      'ol',
      { class: 'steps', 'data-role': 'enrolment', 'data-factor': factorId },
      el('li', {}, el('p', {}, 'Scan this code with your authenticator app.'), el('div', { class: 'qr-frame' }, qrImage(enrolment.qrCodeSvg, 'QR code that adds this account to an authenticator app'))),
      el('li', {}, el('p', {}, 'Or type this setup key into the app by hand:'), el('code', { class: 'secret', 'data-role': 'secret' }, grouped(enrolment.secret))),
      el('li', {}, el('p', {}, 'Enter the six-digit code the app now shows.'), verify),
    ),
  );
}

function enrolState(unfinished) {
  const area = el('div', { 'data-role': 'enrolment-area' });
  fill(
    main,
    el(
      'section',
      { class: 'narrow', 'data-state': 'enrol' },
      heading('Set up a second factor', 'An authenticator app on your phone shows a new six-digit code every thirty seconds. Administrators need one to manage their company.'),
      el('p', { class: 'notice', 'data-role': 'bootstrap-statement' }, 'Before you set up an authenticator, the link in your email is the only factor that protects this account.'),
      area,
      unfinishedPanel(unfinished),
    ),
  );
  fill(area, el('div', { class: 'actions' }, button('Set up an authenticator app', () => startEnrolment(area), { 'data-role': 'start-enrolment' })));
}

function challengeState(verified, unfinished) {
  const status = statusRegion();
  const code = codeField('code');
  let chosen = verified[0].factorId;
  const choice =
    verified.length > 1
      ? el(
          'fieldset',
          { class: 'choice', 'data-role': 'factor-choice' },
          el('legend', {}, 'Authenticator'),
          verified.map((f, i) => {
            const input = el('input', { type: 'radio', name: 'factor', id: `factor-${i}`, value: f.factorId, checked: i === 0 });
            input.addEventListener('change', () => {
              chosen = f.factorId;
            });
            return el('div', { class: 'option' }, input, el('label', { for: `factor-${i}` }, f.friendlyName ?? 'Authenticator app'));
          }),
        )
      : null;
  const submit = el('button', { type: 'submit', 'data-role': 'verify' }, 'Verify');
  const challenge = form(
    { class: 'stack', 'data-role': 'challenge-form' },
    async () => {
      submit.disabled = true;
      fill(status);
      const r = await verifyFactor(chosen, digits(code.input));
      submit.disabled = false;
      if (stopped(r)) return;
      if (r.ok) return afterVerified();
      fill(status, failureView(r, { retry: () => challenge.requestSubmit() }));
    },
    choice,
    code.wrap,
    submit,
    status,
  );
  fill(
    main,
    el(
      'section',
      { class: 'narrow', 'data-state': 'challenge' },
      heading('Verify with your second factor', 'Enter the current six-digit code from your authenticator app.'),
      challenge,
      unfinishedPanel(unfinished),
    ),
  );
}

function verifiedState(unfinished) {
  const area = el('div', { 'data-role': 'enrolment-area' });
  fill(
    main,
    el(
      'section',
      { class: 'narrow', 'data-state': 'verified' },
      heading('Second factor verified', 'This session is verified with a second factor.'),
      el('div', { class: 'actions' }, link('/', 'Go to your companies', { class: 'button', 'data-role': 'home-link' })),
      el('h2', {}, 'Add another authenticator'),
      el('p', {}, 'A second authenticator lets you sign in if you lose the first one.'),
      area,
      unfinishedPanel(unfinished),
    ),
  );
  fill(area, button('Set up another authenticator app', () => startEnrolment(area), { class: 'secondary', 'data-role': 'start-enrolment' }));
}

async function load() {
  enrolment = null;
  fill(main, loading('Checking your second factor.'));
  const m = await me();
  if (stopped(m)) return;
  if (!m.ok) return showPageState(header, main, failureView(m, { retry: load }));
  const standing = m.data.memberships.length === 0 ? await operatorCompanies() : null;
  if (standing && stopped(standing)) return;
  renderHeader(header, { email: m.data.user.email, onSignOut: signOut, operator: isOperator(standing) });
  const list = await factors();
  if (stopped(list)) return;
  if (!list.ok) return fill(main, el('section', { class: 'narrow' }, heading('Second factor'), failureView(list, { retry: load })));
  const all = list.data.factors;
  const unfinished = all.filter((f) => f.status !== 'verified');
  if (m.data.user.aal === 'aal2') return verifiedState(unfinished);
  if (hasVerifiedFactor(all)) return challengeState(all.filter((f) => f.status === 'verified'), unfinished);
  return enrolState(unfinished);
}

keepFresh({
  clear: () => {
    enrolment = null;
    fill(main);
    renderPlainHeader(header);
  },
  reload: load,
});
load();
