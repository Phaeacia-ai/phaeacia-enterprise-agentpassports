/* The upload form, one implementation for the two pages that draw it: the upload page, /drafts/new/, for a new agent or
   a new version, and step 2 of Capture an agent, /capture/, for a new agent (docs/e3/intake-pages-design.md sections 4
   to 6 and "Raffael's direction, 2026-09-22"; evidence/add-agent.md). A page module runs when it is loaded, so the form
   lives here, where both pages and the unit test reach the same code.

   The upload. One press composes one attempt with its own Idempotency-Key (api.mjs writeAttempt), from what the form
   holds at the press; the Retry of a failed answer sends that same attempt again, key, bytes and name, so a lost answer
   comes back as the stored draft, not a second one. Once the text box, the chosen file or the name differs from the
   press, Retry sends nothing and says so, and a new press composes a new attempt (INF-N2, as draft.mjs does for a save).
   From the press to the answer the text box is read-only and the file input, the name and the button are held, so
   nothing typed then is left behind when the page moves to the draft. The passport is the chosen file as its Blob, or
   the text box, and a passport over the server's bound or empty is refused here and not sent (intake-view.mjs
   choosePassport). On 201, a replay included, the page moves to the new draft, which reads the stored result back as
   its preview, and the form stays held while it goes. A content gate refusal shows the server's message and every
   problem's line and code; nothing was stored. An answer that replaces the whole page, not found or maintenance, is
   handed to the page that drew the form, which knows what its page shows then. */

import { createDraft, writeAttempt } from './api.mjs';
import { add, el, field, fill, form } from './dom.mjs';
import { choosePassport, draftsTarget, draftTarget, INTAKE_TEXT, passportInput, problemsView, refusedBeforeSending } from './intake-view.mjs';
import { failureView, link, navigate, statusRegion } from './shell.mjs';

/* What the form says when it no longer matches the press a Retry would send (INF-N2). */
const UPLOAD_RETRY_CHANGED =
  'The text box, the chosen file or the name changed after this upload failed, so Retry would send the earlier upload. Nothing was sent. Press Upload and check to send the form as it is now; if the earlier upload was stored, it is already a draft on Your agents.';

/* The answer to an upload, beside the form: the move to the draft, the refusal list, or the server's message with the
   page's hint for the codes it names. */
function answer(r, status, retry, target, replacePage) {
  if (r.action === 'navigating') return;
  if (r.ok) return navigate(draftTarget(r.data.candidateId));
  if (r.action === 'not-found' || r.action === 'maintenance') return replacePage(r);
  if (Array.isArray(r.problems) && r.problems.length) return fill(status, problemsView(r));
  const box = failureView(r, { retry });
  if (r.code === 'E_AGENT_NAME_TAKEN') add(box, [el('p', { class: 'meta', 'data-role': 'hint' }, INTAKE_TEXT.nameTakenHint)]);
  if (r.action === 'reload')
    add(box, [el('p', { class: 'meta', 'data-role': 'hint' }, INTAKE_TEXT.idempotencyHint), link(draftsTarget(target.companyId), INTAKE_TEXT.goToList, { 'data-role': 'list-link' })]);
  fill(status, box);
}

/** The form. target: { companyId } for a new agent, with the name field, or { companyId, agentId } for a new version,
    without it. replacePage(answer) draws the page's own state for an upload answered not found or maintenance. */
export function uploadForm(target, { replacePage }) {
  const status = statusRegion('upload-status');
  const input = passportInput({ id: 'passport' });
  const name = target.agentId ? null : field({ label: INTAKE_TEXT.nameLabel, id: 'agent-name', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const submit = el('button', { type: 'submit', 'data-role': 'upload' }, INTAKE_TEXT.uploadButton);
  const hold = (on) => {
    input.hold(on);
    if (name) name.input.readOnly = on;
    submit.disabled = on;
  };
  const read = () => ({ ...input.read(), name: name ? name.input.value : null });
  const upload = async () => {
    fill(status);
    const pressed = read();
    const choice = choosePassport(pressed);
    if (!choice.ok) return fill(status, el('p', { class: 'notice', role: 'alert', 'data-state': 'not-sent' }, refusedBeforeSending(choice)));
    const agent = target.agentId ? { agentId: target.agentId } : { agentName: pressed.name };
    const run = writeAttempt((key) => createDraft(target.companyId, agent, choice.passport, key));
    /* Retry resends this press's bytes and name under its key, and a stored upload moves the page to the draft of what
       was pressed, so once the form differs from the press it sends nothing and says so (INF-N2). */
    const retry = () => {
      const now = read();
      if (now.text !== pressed.text || now.file !== pressed.file || now.name !== pressed.name)
        return fill(status, el('p', { class: 'notice', role: 'status', 'data-state': 'upload-changed' }, UPLOAD_RETRY_CHANGED));
      return go();
    };
    const go = async () => {
      hold(true);
      fill(status, el('p', { class: 'loading', role: 'status', 'data-state': 'uploading' }, INTAKE_TEXT.uploading));
      const r = await run();
      if (!r.ok && r.action !== 'navigating') hold(false);
      answer(r, status, retry, target, replacePage);
    };
    await go();
  };
  return form(
    { class: 'stack wide', 'data-role': 'upload-form' },
    upload,
    name ? [name.wrap, el('p', { class: 'meta' }, INTAKE_TEXT.nameHelp)] : null,
    input.node,
    submit,
    status,
  );
}
