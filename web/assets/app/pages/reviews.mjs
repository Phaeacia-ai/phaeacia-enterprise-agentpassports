/* The review queue, /reviews/?company=<uuid> (E4 design 4.1 and 4.2).

   Order of calls. GET /api/me; an administrator without a verified factor is moved to /mfa/ first. Then the queue and
   the member list together, the list for the author labels. Either answering 404 is the not-found state, the same for
   an unknown, foreign, malformed or no longer permitted company.

   What it shows. "Awaiting a decision": the company's submitted candidates this viewer may read, oldest submission
   first, each with agent, version, author, submission date, a stale-checks line when the checks changed, each envelope's
   target, revision, status and approving roles, and "You cannot sign off: you are listed as a contributor" where the
   service's viewerExcluded hint is true. "Approved, not yet published or open": the open envelopes. Every entry links
   to its review screen. The lists are what the service returns; the page filters nothing. */

import { me, members, reviewQueue, sendAdminsToEnrolment, signOutHere } from '../api.mjs';
import { button, el, fill, isolated } from '../dom.mjs';
import { companyParam } from '../params.mjs';
import { companyLinks, dateLine, failureView, heading, keepFresh, link, loading, notFoundView, notice, renderHeader, renderPlainHeader, showPageState, startPage } from '../shell.mjs';
import { labelsOf, memberLabel, reviewRoleName, reviewTarget, targetName } from '../passport-view.mjs';

const { header, main } = startPage();
const companyId = companyParam();

const STATUS = { open: 'open', approved: 'approved', changes_requested: 'changes requested' };

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

const approvedBy = (roles) =>
  roles.length ? `approved by ${roles.map(reviewRoleName).join(' and ')}` : 'no approval yet';

function awaitingCard(c, labels) {
  return el(
    'li',
    { class: 'card', 'data-candidate': c.candidateId, 'data-excluded': c.viewerExcluded ? 'yes' : 'no' },
    el(
      'div',
      { class: 'card-head' },
      link(reviewTarget(c.candidateId), [isolated(c.agentName ?? 'An agent'), `, version ${c.sequence}`], { 'data-role': 'review-link' }),
    ),
    el('p', { class: 'meta' }, 'Author ', memberLabel(labels, c.authorMembershipId), dateLine(' · Submitted ', c.submittedAt)),
    c.gateStatus === 'stale'
      ? el('p', { class: 'meta stale', 'data-role': 'gate-stale' }, 'The content checks changed after this version was submitted.')
      : null,
    c.envelopes.length
      ? el(
          'ul',
          { class: 'lines', 'data-role': 'queue-envelopes' },
          c.envelopes.map((e) =>
            el('li', { 'data-envelope': e.envelopeId, 'data-status': e.status }, `${targetName(e.target)}, revision ${e.revision}: ${STATUS[e.status] ?? e.status}, ${approvedBy(e.approvedRoles)}`),
          ),
        )
      : el('p', { class: 'meta' }, 'No envelope proposed yet.'),
    c.viewerExcluded
      ? el('p', { class: 'verdict', 'data-role': 'viewer-excluded' }, 'You cannot sign off: you are listed as a contributor')
      : null,
  );
}

function openCard(e) {
  return el(
    'li',
    { class: 'card', 'data-candidate': e.candidateId, 'data-envelope': e.envelopeId, 'data-status': e.status },
    el(
      'div',
      { class: 'card-head' },
      link(reviewTarget(e.candidateId), [isolated(e.agentName ?? 'An agent'), `, version ${e.sequence}`], { 'data-role': 'review-link' }),
    ),
    el('p', { class: 'meta' }, `${targetName(e.target)}, revision ${e.revision}: ${STATUS[e.status] ?? e.status}, ${approvedBy(e.approvedRoles)}`),
  );
}

function render(queue, labels) {
  fill(
    main,
    el(
      'div',
      { class: 'page-head' },
      heading('Reviews'),
      el('div', { class: 'toolbar' }, button('Reload', load, { class: 'secondary', 'data-role': 'reload' })),
    ),
    companyLinks(companyId, '/reviews/'),
    queue.truncated
      ? notice('This queue is incomplete: the company has more candidates or open envelopes than this page shows.', 'truncated')
      : null,
    el(
      'section',
      { 'data-role': 'awaiting' },
      el('h2', {}, `Awaiting a decision (${queue.awaitingDecision.length})`),
      queue.awaitingDecision.length
        ? el('ul', { class: 'cards' }, queue.awaitingDecision.map((c) => awaitingCard(c, labels)))
        : el('p', { class: 'meta', 'data-state': 'empty' }, 'Nothing is waiting for a decision.'),
    ),
    el(
      'section',
      { 'data-role': 'open-envelopes' },
      el('h2', {}, `Approved, not yet published or open (${queue.openEnvelopes.length})`),
      queue.openEnvelopes.length
        ? el('ul', { class: 'cards' }, queue.openEnvelopes.map(openCard))
        : el('p', { class: 'meta', 'data-state': 'empty' }, 'No approved version is waiting for publication.'),
    ),
  );
}

async function load() {
  fill(main, loading('Loading the review queue.'));
  const m = await me();
  if (m.action === 'navigating') return;
  if (!m.ok) return showPageState(header, main, failureView(m, { retry: load }));
  const enrolment = await sendAdminsToEnrolment(m.data);
  if (enrolment.moved || enrolment.answer?.action === 'navigating') return;
  if (enrolment.answer) return showPageState(header, main, failureView(enrolment.answer, { retry: load }));
  const membership = m.data.memberships.find((x) => x.companyId === companyId) ?? null;
  renderHeader(header, { email: m.data.user.email, companyName: membership?.companyName ?? null, onSignOut: signOut });
  if (!companyId) return fill(main, notFoundView());
  const answers = await Promise.all([reviewQueue(companyId), members(companyId)]);
  if (answers.some((r) => r.action === 'navigating')) return;
  if (answers.some((r) => r.action === 'not-found')) return fill(main, notFoundView());
  const failed = answers.find((r) => !r.ok);
  if (failed?.action === 'maintenance') return showPageState(header, main, failureView(failed, { retry: load }));
  if (failed) return fill(main, heading('Reviews'), failureView(failed, { retry: load }));
  render(answers[0].data, labelsOf(answers[1].data));
}

keepFresh({
  clear: () => {
    fill(main);
    renderPlainHeader(header);
  },
  reload: load,
});
load();
