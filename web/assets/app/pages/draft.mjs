/* The draft, /draft/?candidate=<uuid> (docs/e3/intake-pages-design.md sections 1 and 4 to 7).

   Order of calls. GET /api/me; an administrator without a verified factor is moved to /mfa/ first. Then the version,
   through GET /api/candidates/{id}/review, the one read that carries the losses rows and the agent's name, with the
   permission of the E3 read it begins with: a draft is its author's alone, so anybody else's draft, an unknown id and a
   company the reader has left all answer 404, the not-available state. Then the company's member list, for the labels
   and the colleagues the submission may name. Every write is followed by all three again.

   Top to bottom. The agent's name, the version and its state, with the stale-checks line and, for a draft started from
   a version on which changes were requested, which version it continues. Edit: the text box holding the stored text,
   the file input, Save and check. What the service stored: the title and summary, what it needs with each
   capability's name and "declared, not installed", the losses table in every state, the last check and the stored text
   in a read-only pane; all of it the server's reading, never the text box's. Contributors. Submit for review: held while
   the text box differs from the stored text or a file is chosen, because submitting sends the stored draft; the
   declarations, the attestation said before the button, and an in-page confirmation.

   Writes. Each press composes one attempt with its own key, from what the form holds at the press, and the Retry of its
   failure sends that same attempt again, key and body; once the form differs from the press, Retry sends nothing and
   says so, and a new press composes a new attempt (INTR-F2, INTC-F2). While a write is in flight the text box is
   read-only and the file input, Save and Submit for review are held, so nothing typed then is replaced by the page the
   answer draws; while a submit is in flight the declarations are held too (INF-N8). One write at a time: while a save
   is in flight Submit for review is held and an open confirmation closes, and a save or its Retry does not start while
   a submit is, so the answer that comes first never gives the box back while the other write has still to redraw the
   page (INTRR-F1). The declarations are never stored
   before a submit, so every redraw of this draft (after a save, a reload action, Load the stored draft or Reload)
   carries what they hold into the new form, the colleagues still offered keeping their ticks (INF-N1); they are
   dropped with the page on pagehide, on not found and once the version is submitted. An edit or a chosen file closes
   an open submit confirmation with the reason, and Submit now refuses a form that holds unsaved changes (INTR-F1). A
   content gate refusal shows the server's message and the problem list and says the stored draft is unchanged; the
   text box keeps what the author typed. A conflict (E_VERSION_CONFLICT, E_CONTENT_CHANGED) shows the server's message
   and a control that loads the stored draft, so unsaved text is never discarded without a press. E_NOT_DRAFT links to
   the submitted page. A reload action reads the page again with the message above it; not found discards the page,
   the text box included. A version that is no longer a draft shows a notice and the link to its submitted page, and
   no editor. */

import { me, members, review, saveDraft, sendAdminsToEnrolment, signOutHere, submitDraft, writeAttempt } from '../api.mjs';
import { add, button, el, field, fill, form, isolated } from '../dom.mjs';
import { candidateParam, choosePassport, CONFIDENCE_LEVELS, contributorsView, draftsTarget, INTAKE_TEXT, lastCheckView, noticeWithLink, passportInput, problemsView, refusedBeforeSending, stateTag, submissionFromForm, submittedTarget, unavailableDraft } from '../intake-view.mjs';
import { contentPane, derivedView, labelsOf, lossesTable, memberLabel, needsTable } from '../passport-view.mjs';
import { companyLinks, failureView, heading, keepFresh, link, loading, notice, renderHeader, renderPlainHeader, roleNames, showPageState, startPage, statusRegion } from '../shell.mjs';

const { header, main } = startPage();
const candidateId = candidateParam();
let flash = null;
/* The submit form drawn last: { candidateId, read } where read() answers what its declarations hold (INF-N1). */
let declarations = null;

const CONFIDENCE_NAMES = { high: 'High', medium: 'Medium', low: 'Low' };

/* What the page says when the form no longer matches a press (INTR-F1, INTR-F2, INTC-F2). */
const CHANGED_TEXT = Object.freeze({
  confirmClosed:
    'The confirmation closed because the text box or the chosen file changed. Submitting sends the stored draft: save your changes, then submit.',
  notSubmitted: 'Nothing was submitted: the text box or the chosen file holds changes that are not saved. Save them, then submit.',
  saveRetry:
    'The text box or the chosen file changed after this save failed, so Retry would send the earlier text. Nothing was sent. Press Save and check to save what the box holds now; if the earlier save was stored, the service answers that the draft changed and your text stays in the box.',
  submitRetry:
    'The form changed after this submission failed, so Retry would send the earlier answers. Nothing was sent. Press Submit for review to confirm the form as it is now.',
});

const changedNotice = (state, text) => el('p', { class: 'notice', role: 'status', 'data-state': state }, text);

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

function discard() {
  flash = null;
  declarations = null;
  fill(main, unavailableDraft());
}

/* The answers both writes share: not found discards, maintenance replaces, reload reads again with the message above,
   a conflict offers the stored draft, a draft that is no longer one links to its page. Anything else: the message with
   Retry, which sends the same key. Returns true when it settled the answer. */
function settledCommon(r, status, retry) {
  if (r.action === 'navigating') return true;
  if (r.action === 'not-found') {
    discard();
    return true;
  }
  if (r.action === 'maintenance') {
    showPageState(header, main, failureView(r, { retry: load }));
    return true;
  }
  if (r.action === 'reload') {
    flash = failureView(r);
    load();
    return true;
  }
  if (r.code === 'E_VERSION_CONFLICT' || r.code === 'E_CONTENT_CHANGED') {
    fill(status, add(failureView(r), [el('p', { class: 'meta' }, INTAKE_TEXT.conflictHint), button(INTAKE_TEXT.loadStored, load, { 'data-role': 'load-stored' })]));
    return true;
  }
  if (r.code === 'E_NOT_DRAFT') {
    fill(status, add(failureView(r), [link(submittedTarget(candidateId), INTAKE_TEXT.openSubmitted, { 'data-role': 'submitted-link' })]));
    return true;
  }
  return false;
}

function banners(data) {
  const { candidate } = data;
  const out = [];
  if (candidate.gateStatus === 'stale') out.push(el('p', { class: 'notice', role: 'status', 'data-state': 'gate-stale' }, INTAKE_TEXT.staleDraft));
  if (candidate.supersedesCandidateId) {
    const parent = (data.agentHistory?.candidates ?? []).find((v) => v.candidateId === candidate.supersedesCandidateId);
    out.push(
      el(
        'p',
        { class: 'notice', role: 'status', 'data-state': 'successor' },
        `This draft continues ${parent ? `version ${parent.sequence}` : 'an earlier version'}, on which changes were requested. Its contributors carry over. `,
        link(submittedTarget(candidate.supersedesCandidateId), 'Open that version and its change request', { 'data-role': 'parent-link' }),
      ),
    );
  }
  return out;
}

function option(type, name, value, label, id) {
  const input = el('input', { type, name, id, value });
  return { value, input, wrap: el('div', { class: 'option' }, input, el('label', { for: id }, label)) };
}

/* The submit section (design 7): the declarations, the attestation said before the button, and the confirmation.
   kept: what the previous form of this draft held, or null. */
function submitSection(data, list, { isDirty, isSaving, holdEdit, kept }) {
  const { candidate } = data;
  const status = statusRegion('submit-status');
  const viewerId = list.viewer?.membershipId ?? null;
  const colleagues = (list.members ?? []).filter((m) => m.status === 'active' && m.membershipId !== viewerId);
  const labels = labelsOf(list);
  const source = field({ label: INTAKE_TEXT.sourceLabel, id: 'source-platform', autocomplete: 'off' });
  const confidence = CONFIDENCE_LEVELS.map((level) => option('radio', 'confidence', level, CONFIDENCE_NAMES[level], `confidence-${level}`));
  const permitted = el('textarea', { id: 'permitted-data', name: 'permitted-data', 'data-role': 'permitted-data' });
  const dependencies = el('textarea', { id: 'dependencies', name: 'dependencies', 'data-role': 'dependencies' });
  const names = el('textarea', { id: 'outside-names', name: 'outside-names', 'data-role': 'outside-names' });
  /* INT-F10: the member list names a colleague without a display name "a member with no name set" and shows a plain
     member no addresses, so each option carries the colleague's roles, and the form says when some have no name. */
  const ticks = colleagues.map((m) =>
    option('checkbox', 'colleagues', m.membershipId, [memberLabel(labels, m.membershipId), el('span', { class: 'meta', 'data-role': 'colleague-roles' }, ` · ${roleNames(m.roles)}`)], `colleague-${m.membershipId}`),
  );
  const unnamed = colleagues.some((m) => !m.label || m.label.kind === 'none');
  if (kept) {
    source.input.value = kept.sourcePlatform;
    for (const o of confidence) o.input.checked = o.value === kept.confidence;
    permitted.value = kept.permittedData;
    dependencies.value = kept.dependencies;
    for (const o of ticks) o.input.checked = kept.colleagues.includes(o.value);
    names.value = kept.names;
  }
  const typed = [source.input, permitted, dependencies, names];
  const chosen = [...confidence, ...ticks].map((o) => o.input);
  const unsaved = el('p', { class: 'notice', role: 'status', 'data-state': 'unsaved' }, INTAKE_TEXT.unsaved);
  const submit = el('button', { type: 'submit', 'data-role': 'submit' }, INTAKE_TEXT.submitButton);
  const tools = el('div', { class: 'tools', 'data-role': 'submit-tools' });
  let confirming = false;
  let sending = false;
  const closeConfirmation = () => {
    confirming = false;
    fill(tools);
  };
  /* Submit sends the stored draft, so while the form holds an unsaved edit or a chosen file Submit for review is held
     and an open confirmation closes with the reason (INTR-F1); it is also held while a submit is in flight (INTR-F14),
     and so are the declarations, which the press has already read (INF-N8). While a save is in flight it is held and an
     open confirmation closes, because the two writes share the hold on the text box (INTRR-F1). */
  const refresh = () => {
    const dirty = isDirty();
    const saving = isSaving();
    unsaved.hidden = !dirty;
    submit.disabled = dirty || sending || saving;
    for (const c of typed) c.readOnly = sending;
    for (const c of chosen) c.disabled = sending;
    if (dirty && confirming) {
      closeConfirmation();
      fill(status, changedNotice('confirm-closed', CHANGED_TEXT.confirmClosed));
    } else if (saving && confirming) closeConfirmation();
  };
  const values = () => ({
    sourcePlatform: source.input.value,
    confidence: confidence.find((o) => o.input.checked)?.value ?? null,
    permittedData: permitted.value,
    dependencies: dependencies.value,
    colleagues: ticks.filter((o) => o.input.checked).map((o) => o.value),
    names: names.value,
  });
  const refuseUnsaved = () => {
    refresh();
    fill(status, changedNotice('not-submitted', CHANGED_TEXT.notSubmitted));
  };
  const send = async () => {
    if (sending || isSaving()) return;
    fill(status);
    if (isDirty()) return refuseUnsaved();
    /* The submission is read once, at the press (INTC-F2): Retry sends it again under the same key, and a form that
       changed since needs a new confirmed attempt with a new key. */
    const submission = submissionFromForm(values());
    const run = writeAttempt((key) => submitDraft(candidateId, candidate.version, submission, key));
    const retry = () => {
      if (sending || isSaving()) return undefined;
      if (isDirty()) return refuseUnsaved();
      if (JSON.stringify(submissionFromForm(values())) !== JSON.stringify(submission)) return fill(status, changedNotice('submit-changed', CHANGED_TEXT.submitRetry));
      return go();
    };
    const go = async () => {
      closeConfirmation();
      sending = true;
      refresh();
      holdEdit(true);
      fill(status, el('p', { class: 'loading', role: 'status', 'data-state': 'submitting' }, 'Submitting for review.'));
      const r = await run();
      sending = false;
      holdEdit(false);
      refresh();
      if (r.ok) {
        flash = notice(INTAKE_TEXT.submitted, 'submitted');
        if (r.data.idempotentReplay === true) flash.setAttribute('data-replay', 'true');
        return load();
      }
      if (settledCommon(r, status, retry)) return;
      const box = failureView(r, { retry });
      if (r.code === 'E_GATE_FAILS_NOW') add(box, [el('p', { class: 'meta', 'data-role': 'hint' }, INTAKE_TEXT.gateFailsHint)]);
      if (r.code === 'E_BODY_INVALID') add(box, [el('p', { class: 'meta', 'data-role': 'hint' }, INTAKE_TEXT.bodyHint)]);
      fill(status, box);
    };
    await go();
  };
  const ask = () => {
    if (sending || isSaving()) return undefined;
    fill(status);
    if (isDirty()) return refresh();
    confirming = true;
    fill(
      tools,
      el(
        'div',
        { class: 'confirm-box', 'data-role': 'confirm-submit' },
        el('p', {}, `Submit version ${candidate.sequence} for review? It cannot be changed afterwards.`),
        el(
          'div',
          { class: 'actions' },
          button(INTAKE_TEXT.submitNow, send, { 'data-role': 'confirm-submit-now' }),
          button(INTAKE_TEXT.cancel, closeConfirmation, { class: 'quiet', 'data-role': 'cancel' }),
        ),
      ),
    );
  };
  const section = el(
    'section',
    { class: 'panel', 'data-role': 'submit-section' },
    el('h2', {}, INTAKE_TEXT.submitHeading),
    el('p', { 'data-role': 'attestation-lead' }, INTAKE_TEXT.submitLead),
    unsaved,
    form(
      { class: 'stack wide', 'data-role': 'submit-form' },
      ask,
      source.wrap,
      el('p', { class: 'meta' }, INTAKE_TEXT.sourceHelp),
      el('fieldset', { class: 'choice', 'data-role': 'confidence' }, el('legend', {}, INTAKE_TEXT.confidenceLegend), confidence.map((o) => o.wrap)),
      el('div', { class: 'field' }, el('label', { for: 'permitted-data' }, INTAKE_TEXT.permittedLabel), permitted),
      el('p', { class: 'meta' }, INTAKE_TEXT.permittedHelp),
      el('div', { class: 'field' }, el('label', { for: 'dependencies' }, INTAKE_TEXT.dependenciesLabel), dependencies),
      el('p', { class: 'meta' }, INTAKE_TEXT.dependenciesHelp),
      el(
        'fieldset',
        { class: `choice${ticks.length > 6 ? ' scroll' : ''}`, 'data-role': 'colleagues' },
        el('legend', {}, INTAKE_TEXT.colleaguesLegend),
        el('p', { class: 'meta' }, INTAKE_TEXT.colleaguesHelp),
        unnamed ? el('p', { class: 'meta', 'data-role': 'unnamed-colleagues' }, INTAKE_TEXT.unnamedColleagues) : null,
        ticks.length ? ticks.map((o) => o.wrap) : el('p', { class: 'meta' }, INTAKE_TEXT.noColleagues),
      ),
      el('div', { class: 'field' }, el('label', { for: 'outside-names' }, INTAKE_TEXT.namesLabel), names),
      el('p', { class: 'meta' }, INTAKE_TEXT.namesHelp),
      submit,
      tools,
      status,
    ),
  );
  return { section, refresh, values, sending: () => sending };
}

function render(data, list) {
  const { candidate } = data;
  const shown = flash;
  flash = null;
  const agentName = data.agentHistory?.agentName ?? 'Agent';
  const head = el(
    'section',
    { 'data-role': 'candidate-head', 'data-state': candidate.state },
    heading(isolated(agentName), [`Version ${candidate.sequence} · `, stateTag(candidate.state)]),
  );
  const nav = el(
    'div',
    { class: 'toolbar-row' },
    companyLinks(candidate.companyId, null),
    link(draftsTarget(candidate.companyId), INTAKE_TEXT.goToList, { 'data-role': 'list-link' }),
    button('Reload', load, { class: 'secondary', 'data-role': 'reload' }),
  );
  if (candidate.state !== 'draft') {
    declarations = null;
    return fill(main, shown, head, nav, noticeWithLink(INTAKE_TEXT.notDraftAnyMore, submittedTarget(candidate.candidateId), INTAKE_TEXT.openSubmitted, 'not-draft'));
  }
  const saveStatus = statusRegion('save-status');
  let submitRefresh = () => undefined;
  let submitting = () => false;
  let saving = false;
  const input = passportInput({ id: 'draft', text: candidate.content, onChange: () => submitRefresh() });
  const isDirty = () => input.hasFile() || input.area.value !== candidate.content;
  const saveButton = el('button', { type: 'submit', 'data-role': 'save' }, INTAKE_TEXT.saveButton);
  const holdEdit = (on) => {
    input.hold(on);
    saveButton.disabled = on;
  };
  const save = async () => {
    if (submitting()) return undefined;
    fill(saveStatus);
    const pressed = input.read();
    const choice = choosePassport(pressed);
    if (!choice.ok) return fill(saveStatus, el('p', { class: 'notice', role: 'alert', 'data-state': 'not-sent' }, refusedBeforeSending(choice)));
    const run = writeAttempt((key) => saveDraft(candidateId, candidate.version, choice.passport, key));
    /* Retry resends this press's bytes under its key and the page then draws the stored text, so once the box or the
       chosen file differs from the press it sends nothing and says so (INTR-F2). */
    const retry = () => {
      if (submitting()) return undefined;
      const now = input.read();
      if (now.text !== pressed.text || now.file !== pressed.file) return fill(saveStatus, changedNotice('save-changed', CHANGED_TEXT.saveRetry));
      return go();
    };
    const go = async () => {
      saving = true;
      holdEdit(true);
      submitRefresh();
      fill(saveStatus, el('p', { class: 'loading', role: 'status', 'data-state': 'saving' }, 'Saving and checking.'));
      const r = await run();
      saving = false;
      holdEdit(false);
      submitRefresh();
      if (r.ok) {
        flash = notice(INTAKE_TEXT.saved, 'saved');
        if (r.data.idempotentReplay === true) flash.setAttribute('data-replay', 'true');
        return load();
      }
      if (Array.isArray(r.problems) && r.problems.length) return fill(saveStatus, problemsView(r, INTAKE_TEXT.nothingSaved));
      if (settledCommon(r, saveStatus, retry)) return;
      fill(saveStatus, failureView(r, { retry }));
    };
    await go();
  };
  const kept = declarations?.candidateId === candidate.candidateId ? declarations.read() : null;
  const submit = submitSection(data, list, { isDirty, isSaving: () => saving, holdEdit, kept });
  declarations = { candidateId: candidate.candidateId, read: submit.values };
  submitRefresh = submit.refresh;
  submitting = submit.sending;
  fill(
    main,
    shown,
    head,
    banners(data),
    nav,
    el(
      'section',
      { class: 'panel', 'data-role': 'edit' },
      el('h2', {}, INTAKE_TEXT.editHeading),
      el('p', { class: 'meta' }, INTAKE_TEXT.editLead),
      form({ class: 'stack wide', 'data-role': 'edit-form' }, save, input.node, saveButton, saveStatus),
    ),
    el(
      'section',
      { class: 'packet', 'data-role': 'stored' },
      el('h2', {}, INTAKE_TEXT.storedHeading),
      el('p', { class: 'meta' }, INTAKE_TEXT.storedLead),
      derivedView(candidate.derived),
      needsTable(candidate.derived?.needs),
      lossesTable(data.losses),
      lastCheckView(candidate),
      contentPane(candidate.content),
    ),
    contributorsView(data.contributors, labelsOf(list)),
    submit.section,
  );
  submit.refresh();
}

function refusedRead(r) {
  if (r.action === 'not-found') return discard();
  if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
  const shown = flash;
  flash = null;
  fill(main, shown, heading(INTAKE_TEXT.draftTitle), failureView(r, { retry: load }));
}

async function load() {
  fill(main, loading('Loading the draft.'));
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
  render(read.data, list.data);
}

keepFresh({
  clear: () => {
    flash = null;
    declarations = null;
    fill(main);
    renderPlainHeader(header);
  },
  reload: load,
});
load();
