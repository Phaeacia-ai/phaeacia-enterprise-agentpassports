/* The invitation landing, /accept/ and /accept (pages design section 1).

   startPage() has removed token_hash, type and invite from the address bar before anything runs (rule 5). Without an
   invite value the page shows fixed text that the link is incomplete and makes no call. Otherwise its first call is
   session discovery. Signed out: one paragraph and "Accept invitation", which verifies the link and then accepts.
   Signed in: the address, "Accept as <address>", which accepts without the link, and "Use this link instead". When
   verification answers 401, discovery runs again: with a session the page offers "Accept as <address>" with the code
   still in memory; without one it shows the server's message and keeps the code, and "Check again" finds a session
   the person opens in another tab. Acceptance errors show the server's message with one action: E_EMAIL_MISMATCH
   signs out here and keeps the invitation on the page; E_BUSY and E_INTERNAL retry the acceptance, which writes
   nothing on a refusal; E_INVITATION_INVALID and E_COMPANY_INACTIVE link home.

   The back button (rule 10, PW-R-F3). The page clears what it rendered on pagehide and, restored from the back-forward
   cache, runs discovery again, so a browser that signed out since cannot show the address it was signed in as; the
   invitation, still in page memory, is offered again. Journey JF3 shows the restored landing. */

import { acceptInvitation, discoverSession, signOut, verifyLink } from '../api.mjs';
import { button, el, fill, isolated } from '../dom.mjs';
import { forgetInvite, forgetLinkHash, readLanding } from '../params.mjs';
import { failureView, heading, keepFresh, link, loading, membersTarget, navigate, renderHeader, renderPlainHeader, showPageState, startPage, statusRegion } from '../shell.mjs';

const { header, main } = startPage();
renderPlainHeader(header);

const section = (state, ...children) => el('section', { class: 'narrow', 'data-role': 'invitation', 'data-state': state }, ...children);

async function signOutHere(status) {
  const r = await signOut();
  if (r.action === 'navigating') return;
  if (!r.ok) return fill(status, failureView(r, { retry: () => signOutHere(status) }));
  load(el('p', { class: 'notice confirm', role: 'status', 'data-state': 'signed-out-here' }, 'Signed out on this device.'));
}

async function accept(withLink, status) {
  fill(status);
  if (withLink) {
    const { tokenHash, type } = readLanding();
    const v = await verifyLink(tokenHash, type);
    if (v.action === 'navigating') return;
    if (v.action === 'maintenance') return showPageState(header, main, failureView(v, { retry: () => load() }));
    if (!v.ok && v.status === 401) {
      forgetLinkHash();
      return load(failureView(v));
    }
    if (!v.ok) return fill(status, failureView(v, { retry: () => accept(withLink, status) }));
    forgetLinkHash();
  }
  const r = await acceptInvitation(readLanding().invite);
  if (r.action === 'navigating') return;
  if (r.ok) {
    forgetInvite();
    return navigate(membersTarget(r.data.companyId));
  }
  if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: () => load() }));
  if (r.code === 'E_INVITATION_INVALID' || r.code === 'E_COMPANY_INACTIVE') {
    forgetInvite();
    return fill(status, failureView(r), link('/', 'Go to your companies', { 'data-role': 'home-link' }));
  }
  if (r.code === 'E_EMAIL_MISMATCH') return fill(status, failureView(r, { signOut: () => signOutHere(status) }));
  fill(status, failureView(r, { retry: () => accept(false, status) }));
}

async function load(before = null) {
  if (!readLanding().invite) {
    renderPlainHeader(header);
    return fill(
      main,
      section(
        'incomplete',
        heading('This invitation link is incomplete', 'Open the link from your invitation email again, in full.'),
        el('p', {}, 'If it still does not work, ask the administrator who invited you to send the invitation again.'),
      ),
    );
  }
  fill(main, section('checking', heading('Invitation'), before, loading('Checking this browser.')));
  const d = await discoverSession();
  if (d.unavailable || d.error) {
    renderPlainHeader(header);
    return fill(main, section('unavailable', heading('Invitation'), before, failureView(d.answer ?? d.error, { retry: () => load(before) })));
  }
  const { tokenHash } = readLanding();
  const status = statusRegion();
  if (d.signedIn) {
    const email = d.me.user.email;
    renderHeader(header, { email, onSignOut: () => signOutHere(status) });
    return fill(
      main,
      section(
        'signed-in-choice',
        heading('Invitation'),
        before,
        el('p', {}, 'You are signed in as ', isolated(email), '.'),
        tokenHash ? el('p', {}, 'Accept with this account, or use the link to sign in with the account it was sent to and accept there.') : null,
        el(
          'div',
          { class: 'actions' },
          button(['Accept as ', isolated(email)], () => accept(false, status), { 'data-role': 'accept-as' }),
          tokenHash ? button('Use this link instead', () => accept(true, status), { class: 'secondary', 'data-role': 'use-link' }) : null,
        ),
        status,
      ),
    );
  }
  renderPlainHeader(header);
  if (tokenHash) {
    return fill(
      main,
      section(
        'signed-out-landing',
        heading('Invitation'),
        before,
        el('p', {}, 'Continuing signs you in with this link and accepts the invitation.'),
        el('div', { class: 'actions' }, button('Accept invitation', () => accept(true, status), { 'data-role': 'accept' })),
        status,
      ),
    );
  }
  fill(
    main,
    section(
      'needs-sign-in',
      heading('Invitation'),
      before,
      el('p', {}, 'Sign in with a link from your email in another tab of this browser, then check again here. The invitation stays open on this page until you leave it.'),
      el('div', { class: 'actions' }, button('Check again', () => load(), { 'data-role': 'check-again' })),
      status,
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
