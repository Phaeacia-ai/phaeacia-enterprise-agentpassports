/* Your agents, /drafts/?company=<uuid> (docs/e3/intake-pages-design.md sections 1, 4 and 5).

   Order of calls. GET /api/me; an administrator without a verified factor is moved to /mfa/ first. Then the company's
   candidate list, the first page of 50. Its 404 is the not-found state, the same for an unknown, foreign, malformed or no
   longer permitted company and for an operator account, which holds no membership; E_COMPANY_INACTIVE and
   E_ACCESS_PERIOD_ENDED are the server's message with the link home that failureView draws.

   What it shows. The caller's own rows only, grouped by agent (intake-view.mjs groupByAgent), each version linking to
   its draft or submitted page, with its state, when it was checked and submitted, and a stale-checks line. The rows are
   the caller's by the membership id of GET /api/me for this company; a person whose identity answer is truncated and
   does not carry this membership reads it from the member list's viewer instead. A reviewer's or an administrator's
   list answer also carries colleagues' submitted versions, which this page leaves to the Reviews page. The list carries
   no agent name (design 9.2), so an agent is shown by its versions; its pages show the name.

   The one primary control, "Capture an agent", opens /capture/ for this company: the capture prompt, then the upload
   form, then what follows (Raffael's direction, 2026-09-22; evidence/add-agent.md). It replaces the two controls
   "Upload a new agent" and "Get the capture prompt"; the upload page keeps its address and a new version is still
   uploaded from its agent's card.

   Show more reads the next page while nextCursor is not null, including when the pages read so far held none of the
   caller's own rows, so an empty-looking list is never read as complete (E5's rule 11). */

import { candidates, me, members, sendAdminsToEnrolment, signOutHere } from '../api.mjs';
import { add, button, el, fill } from '../dom.mjs';
import { agentCard, groupByAgent, INTAKE_TEXT } from '../intake-view.mjs';
import { companyParam } from '../params.mjs';
import { companyLinks, failureView, heading, keepFresh, link, loading, notFoundView, notice, renderHeader, renderPlainHeader, showPageState, startPage, statusRegion } from '../shell.mjs';

const { header, main } = startPage();
const companyId = companyParam();
/* The rows read so far, across Show more, and the cursor of the next page. */
let rows = [];
let cursor = null;
let ownId = null;

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

function refused(r) {
  if (r.action === 'navigating') return;
  if (r.action === 'not-found') return fill(main, notFoundView());
  if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
  fill(main, heading(INTAKE_TEXT.listTitle), failureView(r, { retry: load }));
}

function render() {
  const groups = groupByAgent(rows, ownId);
  const more = statusRegion('more-status');
  const showMore = async () => {
    fill(more);
    const r = await candidates(companyId, cursor);
    if (r.action === 'navigating') return;
    if (!r.ok) {
      if (r.action === 'not-found' || r.action === 'maintenance') return refused(r);
      return fill(more, failureView(r, { retry: showMore }));
    }
    rows = [...rows, ...r.data.candidates];
    cursor = r.data.nextCursor ?? null;
    render();
  };
  fill(
    main,
    el(
      'div',
      { class: 'page-head' },
      heading(INTAKE_TEXT.listTitle, INTAKE_TEXT.listLead),
      el(
        'div',
        { class: 'toolbar' },
        link(`/capture/?company=${companyId}`, INTAKE_TEXT.captureAgent, { class: 'button', 'data-role': 'capture-agent' }),
        button('Reload', load, { class: 'secondary', 'data-role': 'reload' }),
      ),
    ),
    companyLinks(companyId, '/drafts/'),
    groups.length
      ? el('ul', { class: 'cards', 'data-role': 'agents' }, groups.map((g) => agentCard(g)))
      : el(
          'div',
          { class: 'panel', 'data-state': cursor === null ? 'empty' : 'none-yet' },
          el('p', {}, cursor === null ? INTAKE_TEXT.listEmpty : INTAKE_TEXT.listNoneYet),
          cursor === null ? el('p', { class: 'meta' }, INTAKE_TEXT.listEmptyHow) : null,
        ),
    cursor === null
      ? null
      : add(el('div', { class: 'actions', 'data-role': 'more' }), [
          notice(INTAKE_TEXT.listMore, 'truncated'),
          button(INTAKE_TEXT.showMore, showMore, { class: 'secondary', 'data-role': 'show-more' }),
          more,
        ]),
    el('p', { class: 'meta', 'data-role': 'others' }, INTAKE_TEXT.listOthers),
  );
}

async function load() {
  rows = [];
  cursor = null;
  ownId = null;
  fill(main, loading('Loading your agents.'));
  const m = await me();
  if (m.action === 'navigating') return;
  if (!m.ok) return showPageState(header, main, failureView(m, { retry: load }));
  const enrolment = await sendAdminsToEnrolment(m.data);
  if (enrolment.moved || enrolment.answer?.action === 'navigating') return;
  if (enrolment.answer) return showPageState(header, main, failureView(enrolment.answer, { retry: load }));
  const membership = m.data.memberships.find((x) => x.companyId === companyId) ?? null;
  renderHeader(header, { email: m.data.user.email, companyName: membership?.companyName ?? null, onSignOut: signOut });
  if (!companyId) return fill(main, notFoundView());
  const r = await candidates(companyId);
  if (r.action === 'navigating') return;
  if (!r.ok) return refused(r);
  ownId = membership?.membershipId ?? null;
  if (ownId === null) {
    const list = await members(companyId);
    if (list.action === 'navigating') return;
    if (!list.ok) return refused(list);
    ownId = list.data.viewer?.membershipId ?? null;
  }
  rows = r.data.candidates;
  cursor = r.data.nextCursor ?? null;
  render();
}

keepFresh({
  clear: () => {
    rows = [];
    cursor = null;
    ownId = null;
    fill(main);
    renderPlainHeader(header);
  },
  reload: load,
});
load();
