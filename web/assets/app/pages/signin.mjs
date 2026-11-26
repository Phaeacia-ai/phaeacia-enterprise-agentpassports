/* The sign-in page, /signin/ (pages design section 1).

   Without a link: an email field and one button, and after any answer the same confirmation for every address, so the
   page says nothing about which addresses have accounts. With reason=expired or reason=signed-out: one notice above
   the form.

   With a token_hash fragment, the link landing. startPage() has removed the fragment before anything runs (rule 5).
   The first call is session discovery, only to learn whether a session exists; the hash is never posted on load.
   Without a session: "Continue signing in". With one: the current address, "Continue as <address>", which goes home
   and leaves the hash unused, and "Sign in with this link instead". Only a press posts { tokenHash, type }, so a link
   cannot silently replace another account's session in this browser. On 204 the factor list decides: a verified
   factor at aal1 goes to /mfa/, anything else goes home. On 401 the server's message and the email form. The page
   does not judge type; the server does.

   The back button (rule 10, PW-R-F3). The page clears what it rendered on pagehide and, restored from the back-forward
   cache, runs again from its start, so a browser that signed out since cannot show the address it was signed in as;
   the link, still unused in page memory, is offered again. Journey JF3 shows the restored landing. */

import { discoverSession, factors, hasVerifiedFactor, signOutHere, startSignIn, verifyLink } from '../api.mjs';
import { add, button, el, field, fill, form, isolated } from '../dom.mjs';
import { forgetLinkHash, readLanding, reasonParam } from '../params.mjs';
import { failureView, heading, keepFresh, loading, navigate, renderHeader, renderPlainHeader, showPageState, startPage, statusRegion } from '../shell.mjs';

const { header, main } = startPage();
renderPlainHeader(header);

const REASONS = {
  expired: 'Your session ended. Sign in again to continue.',
  'signed-out': 'Signed out on this device.',
};

function emailForm(before = null) {
  renderPlainHeader(header);
  const reason = reasonParam();
  const email = field({ label: 'Work email address', id: 'email', type: 'email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false' });
  const status = statusRegion();
  const send = el('button', { type: 'submit', 'data-role': 'send-link' }, 'Email me a sign-in link');
  const signin = form(
    { class: 'stack', 'data-role': 'signin-form' },
    async () => {
      send.disabled = true;
      fill(status);
      const r = await startSignIn(email.input.value);
      send.disabled = false;
      if (r.action === 'navigating') return;
      if (r.ok) {
        email.input.value = '';
        fill(status, el('p', { class: 'confirm', 'data-state': 'sent' }, 'If an account exists for that address, a sign-in link is on its way. Open it in this browser.'));
        return;
      }
      if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: () => emailForm() }));
      fill(status, failureView(r, { retry: () => signin.requestSubmit() }));
    },
    email.wrap,
    send,
    status,
  );
  fill(
    main,
    el(
      'section',
      { class: 'narrow', 'data-state': 'email-form' },
      reason ? el('p', { class: 'notice', role: 'status', 'data-state': `reason-${reason}` }, REASONS[reason]) : null,
      heading('Sign in', 'We email you a link. Opening it signs you in; there is no password.'),
      before,
      signin,
    ),
  );
}

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

async function useLink(status) {
  const { tokenHash, type } = readLanding();
  if (!tokenHash) return emailForm();
  fill(status);
  const r = await verifyLink(tokenHash, type);
  if (r.action === 'navigating') return;
  if (r.ok) {
    forgetLinkHash();
    const list = await factors();
    if (list.action === 'navigating') return;
    if (list.ok && list.data.aal !== 'aal2' && hasVerifiedFactor(list.data.factors)) return navigate('/mfa/');
    return navigate('/');
  }
  if (r.status === 401) {
    forgetLinkHash();
    return emailForm(failureView(r));
  }
  if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: landing }));
  fill(status, failureView(r, { retry: () => useLink(status) }));
}

async function landing() {
  fill(main, el('section', { class: 'narrow' }, heading('Sign in'), loading('Checking this browser.')));
  const d = await discoverSession();
  const box = el('section', { class: 'narrow', 'data-role': 'landing' });
  if (d.unavailable || d.error) {
    renderPlainHeader(header);
    return fill(main, add(box, [heading('Sign in'), failureView(d.answer ?? d.error, { retry: landing })]));
  }
  const status = statusRegion();
  if (d.signedIn) {
    const email = d.me.user.email;
    renderHeader(header, { email, onSignOut: signOut });
    box.setAttribute('data-state', 'signed-in-choice');
    return fill(
      main,
      add(box, [
        heading('This browser is already signed in'),
        el('p', {}, 'Signed in as ', isolated(email), '. Continue with that account, or use the link you opened to sign in with the account it was sent to.'),
        el(
          'div',
          { class: 'actions' },
          button(['Continue as ', isolated(email)], () => navigate('/'), { 'data-role': 'continue-as' }),
          button('Sign in with this link instead', () => useLink(status), { class: 'secondary', 'data-role': 'use-link' }),
        ),
        status,
      ]),
    );
  }
  renderPlainHeader(header);
  box.setAttribute('data-state', 'signed-out-landing');
  fill(
    main,
    add(box, [
      heading('Sign in', 'Continue to sign in with the link from your email.'),
      el('div', { class: 'actions' }, button('Continue signing in', () => useLink(status), { 'data-role': 'continue' })),
      status,
    ]),
  );
}

const start = () => (readLanding().tokenHash ? landing() : emailForm());

keepFresh({
  clear: () => {
    fill(main);
    renderPlainHeader(header);
  },
  reload: start,
});
start();
