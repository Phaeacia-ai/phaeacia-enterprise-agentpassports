/* Capture an agent, /capture/ and /capture/?company=<uuid>: the page the one control on Your agents opens, shaped like
   the public app's /create page and made to fit Enterprise (Raffael's direction, 2026-09-22, which also named it;
   docs/e3/intake-pages-design.md, "Raffael's direction, 2026-09-22"; evidence/add-agent.md). It began as the capture
   prompt's page (HOSTED-F3, evidence/operator-landing.md); the path is kept, so the fixed navigation set is unchanged.

   What it shows. A heading and one sentence on what happens, then three numbered steps. Step 1, the capture prompt: the
   prompt's exact text and one button that copies it. The text is capture/enterprise.md, which the site build publishes
   as capture-text.mjs and refuses to publish unless the published string decodes to the file's exact bytes; this page
   sets it as the value of a read-only text area, so it is shown as text and never rendered, and a selection of it is
   the whole value, final line break included (a pre element's selection drops that break, found by OL-1). The copy is
   navigator.clipboard.writeText from the button's click; nothing is stored. When the browser refuses it the page
   selects the whole text in its box and says so, and the text stays selectable either way. Step 2, the upload form of
   upload-form.mjs, the one implementation the upload page /drafts/new/ draws too. Step 3, one line on the draft that
   follows.

   Order of calls. GET /api/me, for the header and for the company: an administrator without a verified factor is moved
   to /mfa/ first, as on every signed-in page. The prompt is the same for every company and nothing about it is read from
   the service. With a company query naming an active membership of the caller, the page draws that company's links and
   the upload form for it; a membership that is not active gets the home page's sentence and its link in step 2, and no
   form, as the upload page does; no company query, or one naming no membership of the caller (an operator's included),
   gets a sentence and a link home in step 2. The service decides again on upload.

   Nothing from the public site's page comes across (evidence/intake-compare.md, table 3, Q1 and Q6): no choice of a
   folder path, whose public skill publishes, and no link to the public site, skill or repository; no public block, no
   public upload address or warning, no copy counter and no network call on a copy. */

import { me, sendAdminsToEnrolment, signOutHere } from '../api.mjs';
import { CAPTURE_TEXT } from '../capture-text.mjs';
import { button, el, fill } from '../dom.mjs';
import { INTAKE_TEXT } from '../intake-view.mjs';
import { homeStateSentence, isInactiveMembership } from '../lifecycle-view.mjs';
import { companyParam } from '../params.mjs';
import { companyLinks, failureView, heading, keepFresh, link, loading, notFoundView, renderHeader, renderPlainHeader, showPageState, startPage, statusRegion } from '../shell.mjs';
import { uploadForm } from '../upload-form.mjs';

const { header, main } = startPage();
const companyId = companyParam();

const TEXT = Object.freeze({
  lead: 'An interview by your own assistant, one your company has approved, produces one passport file, which you upload here; it stays a private draft that only you can see until you submit it.',
  promptTitle: 'Copy the capture prompt',
  promptHow: 'Paste it into a new chat with that assistant and answer its questions. At the end it gives you the passport as one Markdown file: save it on your computer.',
  folder: 'An agent that lives in a folder on your computer is captured the same way for now: paste its instructions into the chat when the interview asks for them.',
  secret: 'Never paste a password, key or other secret into that chat, even if the assistant asks for one.',
  paneLabel: 'The capture prompt, as text',
  copy: 'Copy the prompt',
  copied: 'Copied. Paste it into your assistant.',
  refused: 'This browser did not let the page copy. The prompt is selected in the box above: copy it yourself.',
  missing: 'The capture prompt is not available on this page. Ask Phaeacia for it.',
  uploadTitle: 'Upload the passport file',
  noCompany: 'The file is uploaded into one of your companies: open Capture an agent from Your agents in that company.',
  nextTitle: 'Check it and submit it for review',
  next: "Upload and check opens your draft, which only you can see: read the service's preview, edit and save it if you need to, then submit it for review.",
});

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

/* One numbered step: its number beside its heading, as the public page draws it, inside an ordered list (its bullets
   hidden by the stylesheet; whether a screen reader still announces it as a list is AA-R-F3, a debt). */
function step(number, role, title, ...content) {
  return el(
    'li',
    { class: 'panel add-step', 'data-role': role },
    el('div', { class: 'step-head' }, el('span', { class: 'step-number', 'aria-hidden': 'true' }, String(number)), el('h2', {}, title)),
    ...content,
  );
}

function promptBlock() {
  if (typeof CAPTURE_TEXT !== 'string' || CAPTURE_TEXT.length === 0)
    return el('p', { class: 'notice error', role: 'alert', 'data-state': 'capture-missing' }, TEXT.missing);
  const pane = el('textarea', {
    class: 'content-pane capture-pane',
    spellcheck: 'false',
    autocapitalize: 'none',
    autocomplete: 'off',
    'data-role': 'capture-text',
    'aria-label': TEXT.paneLabel,
  });
  pane.readOnly = true;
  pane.value = CAPTURE_TEXT;
  const status = statusRegion('copy-status');
  const copy = async () => {
    fill(status);
    try {
      await navigator.clipboard.writeText(CAPTURE_TEXT);
      fill(status, el('p', { class: 'meta', 'data-state': 'copied' }, TEXT.copied));
    } catch {
      pane.focus();
      pane.select();
      fill(status, el('p', { class: 'meta', 'data-state': 'copy-refused' }, TEXT.refused));
    }
  };
  return el(
    'div',
    { class: 'capture', 'data-role': 'capture' },
    pane,
    el('div', { class: 'actions' }, button(TEXT.copy, copy, { 'data-role': 'copy-prompt' }), status),
  );
}

/* Step 2's content: the form for an active membership, the home page's sentence for one that is not active, and a
   sentence with a link home without a membership. An upload answered not found or maintenance replaces the page. */
function uploadStep(membership) {
  if (!membership) return el('div', { class: 'notice', 'data-state': 'no-company' }, el('p', {}, TEXT.noCompany), link('/', INTAKE_TEXT.goHome, { 'data-role': 'home-link' }));
  if (isInactiveMembership(membership))
    return el('div', { class: 'notice', role: 'alert', 'data-state': 'inactive' }, el('p', {}, homeStateSentence(membership)), link('/', INTAKE_TEXT.goHome, { 'data-role': 'home-link' }));
  const replacePage = (r) => (r.action === 'not-found' ? fill(main, notFoundView()) : showPageState(header, main, failureView(r, { retry: load })));
  return [el('p', {}, INTAKE_TEXT.uploadLead), uploadForm({ companyId: membership.companyId }, { replacePage })];
}

function render(membership) {
  const active = membership && !isInactiveMembership(membership);
  fill(
    main,
    heading(INTAKE_TEXT.captureAgent, TEXT.lead),
    active ? companyLinks(membership.companyId, null) : null,
    el(
      'ol',
      { class: 'add-steps', 'data-role': 'add-steps' },
      step(
        1,
        'step-prompt',
        TEXT.promptTitle,
        el('div', { 'data-role': 'capture-what' }, el('p', {}, TEXT.promptHow), el('p', { 'data-role': 'capture-folder' }, TEXT.folder)),
        el('p', { class: 'boundary', 'data-role': 'capture-secret' }, TEXT.secret),
        promptBlock(),
      ),
      step(2, 'step-upload', TEXT.uploadTitle, uploadStep(membership)),
      step(3, 'step-next', TEXT.nextTitle, el('p', {}, TEXT.next)),
    ),
  );
}

async function load() {
  fill(main, loading('Loading Capture an agent.'));
  const m = await me();
  if (m.action === 'navigating') return;
  if (!m.ok) return showPageState(header, main, failureView(m, { retry: load }));
  const enrolment = await sendAdminsToEnrolment(m.data);
  if (enrolment.moved || enrolment.answer?.action === 'navigating') return;
  if (enrolment.answer) return showPageState(header, main, failureView(enrolment.answer, { retry: load }));
  const membership = companyId ? (m.data.memberships.find((x) => x.companyId === companyId) ?? null) : null;
  renderHeader(header, { email: m.data.user.email, companyName: membership?.companyName ?? null, onSignOut: signOut });
  render(membership);
}

keepFresh({
  clear: () => {
    fill(main);
    renderPlainHeader(header);
  },
  reload: load,
});
load();
