/* Upload, /drafts/new/?company=<uuid> for a new agent and /drafts/new/?candidate=<uuid> for a new version of that
   version's agent (docs/e3/intake-pages-design.md sections 1, 4, 5 and 6).

   Order of calls. GET /api/me; an administrator without a verified factor is moved to /mfa/ first. For a new agent the
   company comes from the address and its standing from the identity answer: no membership there is the not-found state
   (an operator account included), and a company that is not active or whose access has ended shows the home page's
   sentence and its link, with no form; the server decides both again on upload. For a new version the version is read
   (GET /api/candidates/{id}/review), which gives the company, the agent and its name; its 404 is the not-available state.

   The upload form is upload-form.mjs, the one implementation this page shares with step 2 of Capture an agent,
   /capture/ (evidence/add-agent.md): one attempt per press under its own key, its Retry sending that press again only
   while the form is unchanged (INF-N2), the form held from the press to the answer, the move to the new draft on 201,
   and a content gate refusal shown with every problem's line and code. This page decides only what replaces it when an
   upload is answered not found or maintenance. */

import { me, review, sendAdminsToEnrolment, signOutHere } from '../api.mjs';
import { el, fill, isolated } from '../dom.mjs';
import { draftsTarget, INTAKE_TEXT, candidateParam, unavailableDraft } from '../intake-view.mjs';
import { homeStateSentence, isInactiveMembership } from '../lifecycle-view.mjs';
import { companyParam } from '../params.mjs';
import { companyLinks, failureView, heading, keepFresh, link, loading, notFoundView, renderHeader, renderPlainHeader, showPageState, startPage } from '../shell.mjs';
import { uploadForm } from '../upload-form.mjs';

const { header, main } = startPage();
const companyQuery = companyParam();
const candidateQuery = candidateParam();

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

/* target: { companyId, agentId } for a new version, { companyId } for a new agent. An upload answered not found or
   maintenance replaces the page here. */
function render(target, { agentName = null } = {}) {
  const replacePage = (r) =>
    r.action === 'not-found' ? fill(main, target.agentId ? unavailableDraft() : notFoundView()) : showPageState(header, main, failureView(r, { retry: load }));
  fill(
    main,
    el(
      'div',
      { class: 'page-head' },
      target.agentId
        ? heading([INTAKE_TEXT.uploadVersion, ': ', isolated(agentName ?? 'this agent')], INTAKE_TEXT.newVersionLead)
        : heading(INTAKE_TEXT.uploadTitle, INTAKE_TEXT.uploadLead),
    ),
    companyLinks(target.companyId, null),
    el('p', {}, link(draftsTarget(target.companyId), INTAKE_TEXT.goToList, { 'data-role': 'list-link' })),
    uploadForm(target, { replacePage }),
  );
}

async function load() {
  fill(main, loading('Loading the upload page.'));
  const m = await me();
  if (m.action === 'navigating') return;
  if (!m.ok) return showPageState(header, main, failureView(m, { retry: load }));
  const enrolment = await sendAdminsToEnrolment(m.data);
  if (enrolment.moved || enrolment.answer?.action === 'navigating') return;
  if (enrolment.answer) return showPageState(header, main, failureView(enrolment.answer, { retry: load }));
  const identity = m.data;
  renderHeader(header, { email: identity.user.email, onSignOut: signOut });
  if (candidateQuery !== null) {
    const read = await review(candidateQuery);
    if (read.action === 'navigating') return;
    if (read.action === 'not-found') return fill(main, unavailableDraft());
    if (read.action === 'maintenance') return showPageState(header, main, failureView(read, { retry: load }));
    if (!read.ok) return fill(main, heading(INTAKE_TEXT.uploadVersion), failureView(read, { retry: load }));
    const { companyId, agentId } = read.data.candidate;
    const membership = identity.memberships.find((x) => x.companyId === companyId) ?? null;
    renderHeader(header, { email: identity.user.email, companyName: membership?.companyName ?? null, onSignOut: signOut });
    return render({ companyId, agentId }, { agentName: read.data.agentHistory?.agentName ?? null });
  }
  const membership = identity.memberships.find((x) => x.companyId === companyQuery) ?? null;
  if (!companyQuery || !membership) return fill(main, notFoundView());
  renderHeader(header, { email: identity.user.email, companyName: membership.companyName, onSignOut: signOut });
  if (isInactiveMembership(membership))
    return fill(
      main,
      heading(INTAKE_TEXT.uploadTitle),
      el('div', { class: 'notice', role: 'alert', 'data-state': 'inactive' }, el('p', {}, homeStateSentence(membership)), link('/', INTAKE_TEXT.goHome, { 'data-role': 'home-link' })),
    );
  render({ companyId: companyQuery });
}

keepFresh({
  clear: () => {
    fill(main);
    renderPlainHeader(header);
  },
  reload: load,
});
load();
