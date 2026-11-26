/* The release list, /releases/?company=<uuid> (E4 design 4.1 and 4.2).

   Order of calls. GET /api/me; an administrator without a verified factor is moved to /mfa/ first. Then the first page
   of GET /api/companies/{id}/releases, 50 releases in id order; its 404 is the not-found state. "Show more" reads the
   next page with the answer's nextCursor and adds it below, without a navigation.

   What it shows. Each release the viewer may read, with its target, its state (published and current, published and
   superseded, or withdrawn), its publication, supersession and withdrawal dates, and a link to the release page. The
   release object names its agent by id only, so the list shows a short agent reference rather than a name
   (evidence/e4-pages.md, the findings table). */

import { me, releases, sendAdminsToEnrolment, signOutHere } from '../api.mjs';
import { button, el, fill } from '../dom.mjs';
import { companyParam } from '../params.mjs';
import { companyLinks, dateLine, failureView, heading, keepFresh, link, loading, notFoundView, renderHeader, renderPlainHeader, showPageState, startPage, statusRegion } from '../shell.mjs';
import { releaseStateName, releaseTarget, targetName } from '../passport-view.mjs';

const { header, main } = startPage();
const companyId = companyParam();
let items = [];
let next = null;

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

function card(x) {
  return el(
    'li',
    { class: 'card', 'data-release': x.releaseId, 'data-state': x.state, 'data-current': x.current ? 'yes' : 'no' },
    el(
      'div',
      { class: 'card-head' },
      link(releaseTarget(x.releaseId), `${targetName(x.target)} release`, { 'data-role': 'release-link' }),
      el('span', { class: 'tag' }, releaseStateName(x)),
    ),
    el(
      'p',
      { class: 'meta' },
      'Agent reference ',
      el('code', { class: 'hash', 'data-role': 'agent-reference' }, String(x.agentId).slice(0, 8)),
      dateLine(' · Published ', x.publishedAt),
      dateLine(' · Superseded ', x.supersededAt),
      x.withdrawal ? dateLine(' · Withdrawn ', x.withdrawal.withdrawnAt) : null,
    ),
  );
}

async function more(status) {
  fill(status);
  const r = await releases(companyId, next);
  if (r.action === 'navigating') return;
  if (r.action === 'not-found') return fill(main, notFoundView());
  if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
  if (!r.ok) return fill(status, failureView(r, { retry: () => more(status) }));
  items = [...items, ...r.data.releases];
  next = r.data.nextCursor;
  render();
}

function render() {
  const status = statusRegion('more-status');
  fill(
    main,
    el(
      'div',
      { class: 'page-head' },
      heading('Releases'),
      el('div', { class: 'toolbar' }, button('Reload', load, { class: 'secondary', 'data-role': 'reload' })),
    ),
    companyLinks(companyId, '/releases/'),
    el(
      'section',
      { 'data-role': 'releases' },
      el('h2', {}, next ? `Releases (${items.length} shown, more follow)` : `Releases (${items.length})`),
      items.length
        ? el('ul', { class: 'cards' }, items.map(card))
        : el('p', { class: 'meta', 'data-state': 'empty' }, 'No release has been published in this company.'),
      next ? button('Show more', () => more(status), { class: 'secondary', 'data-role': 'show-more' }) : null,
      status,
    ),
  );
}

async function load() {
  items = [];
  next = null;
  fill(main, loading('Loading the releases.'));
  const m = await me();
  if (m.action === 'navigating') return;
  if (!m.ok) return showPageState(header, main, failureView(m, { retry: load }));
  const enrolment = await sendAdminsToEnrolment(m.data);
  if (enrolment.moved || enrolment.answer?.action === 'navigating') return;
  if (enrolment.answer) return showPageState(header, main, failureView(enrolment.answer, { retry: load }));
  const membership = m.data.memberships.find((x) => x.companyId === companyId) ?? null;
  renderHeader(header, { email: m.data.user.email, companyName: membership?.companyName ?? null, onSignOut: signOut });
  if (!companyId) return fill(main, notFoundView());
  const r = await releases(companyId);
  if (r.action === 'navigating') return;
  if (r.action === 'not-found') return fill(main, notFoundView());
  if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
  if (!r.ok) return fill(main, heading('Releases'), failureView(r, { retry: load }));
  items = r.data.releases;
  next = r.data.nextCursor;
  render();
}

keepFresh({
  clear: () => {
    items = [];
    next = null;
    fill(main);
    renderPlainHeader(header);
  },
  reload: load,
});
load();
