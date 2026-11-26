/* A submitted version, /submitted/?candidate=<uuid> (docs/e3/intake-pages-design.md sections 1, 4 and 5).

   Order of calls. GET /api/me; an administrator without a verified factor is moved to /mfa/ first. Then the version
   through GET /api/candidates/{id}/review, whose 404 is the not-available state, the same for an unknown, foreign or
   malformed id, somebody else's version a member may not read and a company the reader has left; then the company's
   member list for the labels.

   What it shows, read-only. The agent's name, the version and its state, and one sentence saying where the version
   stands: waiting for review, changes requested with each reason, approved, or replaced. What happened to it: each
   review envelope with its audience, approvals and change request, and the releases made from it (passport-view.mjs
   envelopeCard, the review page's own). The passport as it was frozen: title and summary, needs, the losses table in
   every state, the submission, the attestation with its submitter, the stored text. Contributors.

   The one write. On a version on which changes were requested, "Start a new version from this one" creates the
   successor draft through POST /api/candidates/{id}/successor with one key per attempt, and moves to it. The server
   decides again who may: whoever may read the version. E_SUCCESSOR_EXISTS shows the server's message and the link to Your
   agents; any version can also start a fresh new version of its agent from a new file. A draft opened here shows a
   notice and the link to the draft page. */

import { createSuccessor, me, members, review, sendAdminsToEnrolment, signOutHere, writeAttempt } from '../api.mjs';
import { add, button, el, fill, isolated } from '../dom.mjs';
import { candidateParam, contributorsView, draftsTarget, draftTarget, INTAKE_TEXT, newVersionTarget, noticeWithLink, stateTag, unavailableDraft } from '../intake-view.mjs';
import { attestationView, contentPane, derivedView, envelopeCard, labelsOf, lossesTable, memberLabel, needsTable, reviewRoleName, submissionView } from '../passport-view.mjs';
import { companyLinks, dateLine, failureView, heading, keepFresh, link, loading, navigate, renderHeader, renderPlainHeader, showPageState, startPage, statusRegion } from '../shell.mjs';

const { header, main } = startPage();
const candidateId = candidateParam();
let flash = null;

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

function discard() {
  flash = null;
  fill(main, unavailableDraft());
}

/* Where the version stands, in one sentence, with each change request's reason under it. */
function standing(data, labels, reviewsById) {
  const { candidate } = data;
  if (candidate.state === 'changes_requested') {
    const requests = data.reviews.filter((x) => x.decision === 'changes_requested');
    return el(
      'div',
      { class: 'notice', role: 'status', 'data-state': 'changes-requested' },
      el('p', {}, INTAKE_TEXT.changesRequested),
      el(
        'ul',
        { class: 'lines', 'data-role': 'change-reasons' },
        requests.map((x) =>
          el('li', {}, `${reviewRoleName(x.role)} reviewer `, memberLabel(labels, x.reviewerMembershipId), dateLine(' on ', x.createdAt), ': ', isolated(reviewsById.get(x.reviewId)?.reason ?? '')),
        ),
      ),
    );
  }
  const text = { submitted: INTAKE_TEXT.awaiting, approved: INTAKE_TEXT.approvedLine, superseded: INTAKE_TEXT.supersededLine }[candidate.state];
  return text ? el('p', { class: 'notice', role: 'status', 'data-state': candidate.state }, text) : null;
}

function successorSection() {
  const status = statusRegion('successor-status');
  const start = async () => {
    fill(status);
    const run = writeAttempt((key) => createSuccessor(candidateId, key));
    const go = async () => {
      const r = await run();
      if (r.action === 'navigating') return;
      if (r.ok) return navigate(draftTarget(r.data.candidateId));
      if (r.action === 'not-found') return discard();
      if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
      if (r.action === 'reload' || r.code === 'E_STATE_TRANSITION') {
        flash = failureView(r);
        return load();
      }
      const box = failureView(r, { retry: go });
      if (r.code === 'E_SUCCESSOR_EXISTS') add(box, [el('p', { class: 'meta', 'data-role': 'hint' }, INTAKE_TEXT.successorExistsHint)]);
      fill(status, box);
    };
    await go();
  };
  return el(
    'section',
    { class: 'panel', 'data-role': 'successor' },
    el('h2', {}, INTAKE_TEXT.startSuccessor),
    el('p', {}, INTAKE_TEXT.successorLead),
    button(INTAKE_TEXT.startSuccessor, start, { 'data-role': 'start-successor' }),
    status,
  );
}

function render(data, labels) {
  const { candidate } = data;
  const shown = flash;
  flash = null;
  const head = el(
    'section',
    { 'data-role': 'candidate-head', 'data-state': candidate.state },
    heading(isolated(data.agentHistory?.agentName ?? 'Agent'), [`Version ${candidate.sequence} · `, stateTag(candidate.state)]),
  );
  const nav = el(
    'div',
    { class: 'toolbar-row' },
    companyLinks(candidate.companyId, null),
    link(draftsTarget(candidate.companyId), INTAKE_TEXT.goToList, { 'data-role': 'list-link' }),
    button('Reload', load, { class: 'secondary', 'data-role': 'reload' }),
  );
  if (candidate.state === 'draft') return fill(main, shown, head, nav, noticeWithLink(INTAKE_TEXT.stillDraft, draftTarget(candidate.candidateId), INTAKE_TEXT.openDraft, 'draft'));
  const groupsById = new Map((data.options?.groups ?? []).map((g) => [g.groupId, { name: g.name, memberCount: g.memberCount }]));
  const reviewsById = new Map(data.reviews.map((x) => [x.reviewId, x]));
  fill(
    main,
    shown,
    head,
    standing(data, labels, reviewsById),
    candidate.gateStatus === 'stale' ? el('p', { class: 'notice', role: 'status', 'data-state': 'gate-stale' }, INTAKE_TEXT.staleSubmitted) : null,
    nav,
    candidate.state === 'changes_requested' ? successorSection() : null,
    el(
      'section',
      { 'data-role': 'what-happened' },
      el('h2', {}, INTAKE_TEXT.whatHappened),
      data.envelopes.length
        ? el('ul', { class: 'cards', 'data-role': 'envelopes' }, data.envelopes.map((e) => envelopeCard(e, { labels, groupsById, reviewsById, releases: data.releases })))
        : el('p', { class: 'meta', 'data-state': 'no-envelope' }, INTAKE_TEXT.noEnvelope),
    ),
    el(
      'section',
      { class: 'packet', 'data-role': 'passport' },
      el('h2', {}, 'The passport as submitted'),
      derivedView(candidate.derived),
      needsTable(candidate.derived?.needs),
      lossesTable(data.losses),
      submissionView(candidate),
      attestationView(candidate, labels),
      contentPane(candidate.content),
    ),
    contributorsView(data.contributors, labels),
    el('p', { class: 'actions' }, link(newVersionTarget(candidate.candidateId), INTAKE_TEXT.uploadVersion, { class: 'button secondary', 'data-role': 'new-version' })),
  );
}

function refusedRead(r) {
  if (r.action === 'not-found') return discard();
  if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
  const shown = flash;
  flash = null;
  fill(main, shown, heading(INTAKE_TEXT.submittedTitle), failureView(r, { retry: load }));
}

async function load() {
  fill(main, loading('Loading the version.'));
  const m = await me();
  if (m.action === 'navigating') return;
  if (!m.ok) return showPageState(header, main, failureView(m, { retry: load }));
  const enrolment = await sendAdminsToEnrolment(m.data);
  if (enrolment.moved || enrolment.answer?.action === 'navigating') return;
  if (enrolment.answer) return showPageState(header, main, failureView(enrolment.answer, { retry: load }));
  const identity = m.data;
  renderHeader(header, { email: identity.user.email, onSignOut: signOut });
  if (!candidateId) return discard();
  const read = await review(candidateId);
  if (read.action === 'navigating') return;
  if (!read.ok) return refusedRead(read);
  const companyId = read.data.candidate.companyId;
  const membership = identity.memberships.find((x) => x.companyId === companyId) ?? null;
  renderHeader(header, { email: identity.user.email, companyName: membership?.companyName ?? null, onSignOut: signOut });
  const list = await members(companyId);
  if (list.action === 'navigating') return;
  if (list.action === 'not-found') return discard();
  if (!list.ok) return refusedRead(list);
  render(read.data, labelsOf(list.data));
}

keepFresh({
  clear: () => {
    flash = null;
    fill(main);
    renderPlainHeader(header);
  },
  reload: load,
});
load();
