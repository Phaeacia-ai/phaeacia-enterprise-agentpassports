/* The E3 intake pages' vocabulary and helpers (docs/e3/intake-pages-design.md sections 2 and 4 to 7), shared by the
   author's list, the upload page, the draft page and the submitted page, as passport-view.mjs is for E4 and E5. A page
   module runs when it is loaded, so anything a unit test calls lives here.

   Three rules hold these pages, and each is kept here in one place:
     the browser never validates a passport (E3 design 4.6): nothing here reads a passport's text, computes a hash of it
       or says it is valid; the one test on the page's side is the size bound, MAX_PASSPORT_BYTES, the server's own
       number, pinned to lib/http/request.mjs by tests/e2/unit/web-intake-modules.test.mjs, so a passport the server
       would refuse as too large is not sent;
     the author's bytes are sent as they are: a chosen file goes as its Blob and is never copied into the text box,
       whose value turns every carriage return into a line feed and would hide the refusal that exists for them;
     a refusal is the server's: problemsView shows the line and code of each problem the answer lists and never any
       text of the passport, which the server never sends.
   Every fixed sentence is in INTAKE_TEXT or comes from one of the functions below it, and none repeats a server
   message (pages rule 7, U8). */

import { add, button, el, fill, isolated } from './dom.mjs';
import { candidateStateName, fact, hash, memberLabel } from './passport-view.mjs';
import { dateLine, link } from './shell.mjs';

/** The raw passport bound of lib/http/request.mjs (MAX_PASSPORT_BYTES, E3 design 2.6 item 3), a presentation copy. */
export const MAX_PASSPORT_BYTES = 262144;
/** What the file input offers; the route decides what it accepts, and the page sends text/markdown whatever is chosen. */
export const PASSPORT_FILE_TYPES = '.md,.markdown,.txt,text/markdown,text/plain';
/** app.submission_fields' confidence vocabulary, in the order the form offers it. */
export const CONFIDENCE_LEVELS = Object.freeze(['high', 'medium', 'low']);

export const INTAKE_TEXT = Object.freeze({
  listTitle: 'Your agents',
  listLead: 'Drafts you are working on and the versions you submitted in this company. Only you can see your drafts.',
  listEmpty: 'You have not uploaded an agent in this company yet.',
  listEmptyHow:
    'Capture an agent, above, gives you the capture prompt for an assistant your company has approved and takes the passport file its interview produces. It stays a private draft until you submit it.',
  listOthers: 'Versions other people submitted are on the Reviews page, for reviewers and administrators.',
  listNoneYet: 'None of your versions is on the part of the list read so far, and more follows.',
  listMore: 'More versions follow. Show more before reading this list as complete.',
  showMore: 'Show more',
  captureAgent: 'Capture an agent',
  uploadVersion: 'Upload a new version',
  uploadTitle: 'Upload a new agent',
  uploadLead:
    'Paste the passport your assistant produced, or choose the file it saved. The service checks it and keeps it as a private draft that only you can see.',
  nameLabel: 'Agent name',
  nameHelp:
    'Lowercase letters, digits, dots and hyphens, starting with a letter or a digit, at most 64 characters. The name stays with every version.',
  nameTakenHint:
    'To add a version to an agent of yours, open it from Your agents and choose Upload a new version. A name somebody else chose cannot be reused.',
  textLabel: 'The passport, pasted as text',
  fileLabel: 'Or choose the passport file',
  clearFile: 'Clear the chosen file',
  empty: 'There is nothing to send yet: paste the passport or choose its file.',
  nothingStored:
    'The content checks refused this passport, so nothing was stored. Each problem is listed with its line; the text itself is never sent back.',
  nothingSaved:
    'The content checks refused this text, so nothing was saved. The stored draft shown below is unchanged. Each problem is listed with its line.',
  uploadButton: 'Upload and check',
  uploading: 'Uploading and checking.',
  goToList: 'Go to Your agents',
  idempotencyHint: 'Open Your agents to see where this upload went before trying again.',
  draftTitle: 'Draft',
  editHeading: 'Edit',
  editLead: 'Edit the text, or choose a corrected file, and save. Saving checks it again and replaces the stored draft.',
  saveButton: 'Save and check',
  saved: 'Saved and checked. The preview below is what the service stored.',
  loadStored: 'Load the stored draft',
  conflictHint: 'Your text stays in the box until you load the stored draft.',
  storedHeading: 'What the service stored',
  storedLead: "This is the service's own reading of the stored draft, not of the text box.",
  staleDraft: 'The content checks changed since this draft was last checked. Saving it checks it again under the current checks.',
  staleSubmitted: 'The content checks changed after this version was submitted. Reviewers see this too.',
  lastCheck: 'The last check',
  notDraftAnyMore: 'This version has been submitted and can no longer be edited.',
  openSubmitted: 'Open the submitted version',
  stillDraft: 'This version is still a draft.',
  openDraft: 'Open the draft',
  submitHeading: 'Submit for review',
  submitLead:
    'Submitting sends the stored draft for review. The service checks it again under the current content checks and freezes it with that check. Nothing in a submitted version can change; a change is a new version.',
  unsaved: 'Save your changes first: submitting sends the stored draft, not the text box.',
  sourceLabel: 'Where the agent was built',
  sourceHelp: 'For example Claude Code, ChatGPT or claude.ai. 1 to 80 characters.',
  confidenceLegend: 'How sure you are that the passport describes the agent completely',
  permittedLabel: 'What data it may see',
  permittedHelp: 'In your own words, for example "internal weekly reports, no client names". 1 to 2,000 characters.',
  dependenciesLabel: 'What it depends on (optional)',
  dependenciesHelp: 'One per line, for example a shared folder or a calendar. At most 40, each up to 200 characters.',
  colleaguesLegend: 'Colleagues who worked on it',
  colleaguesHelp: 'Tick anyone in this company who helped build or edit it. Nobody listed as a contributor can review it.',
  noColleagues: 'Nobody else is an active member of this company.',
  unnamedColleagues:
    'Some colleagues have not set a display name, so they appear here only by their roles. Each person sets theirs on their own account page; ask them to before you name them.',
  namesLabel: 'People outside Phaeacia who helped (optional)',
  namesHelp:
    'One name per line. They are recorded as you name them and nobody checks them. At most 50 people in all, each name up to 120 characters.',
  submitButton: 'Submit for review',
  submitNow: 'Submit now',
  cancel: 'Cancel',
  submitted: 'Submitted for review.',
  gateFailsHint: 'Edit the text and save it: saving checks it under the current content checks.',
  bodyHint: 'Check each field against the lengths stated beside it.',
  submittedTitle: 'Submitted version',
  whatHappened: 'What happened to it',
  noEnvelope: 'No reviewer has proposed a release of this version yet.',
  awaiting: 'Submitted and waiting for review. Reviewers find it on their Reviews page.',
  changesRequested: 'Changes were requested on this version. It is closed; you answer with a new version.',
  approvedLine: 'Approved. An administrator publishes it to the audience the reviewers approved.',
  supersededLine: 'A newer version of this agent replaced this one.',
  startSuccessor: 'Start a new version from this one',
  successorLead:
    'This makes a new draft with this text, which you edit, save and submit again. The contributors of this version carry over to it.',
  successorExistsHint: 'Open Your agents to find the version already started from this one.',
  newVersionLead:
    'A new version of an agent starts from a new file: nothing from earlier versions carries over except the agent. To answer a change request instead, open that version and start a new version from it.',
  contributorsHeading: 'Contributors',
  noContributor: 'No contributor is recorded.',
  unverified: ' · Named by the submitter, not a member of this company in Phaeacia',
  unavailableTitle: 'Not available',
  unavailableText:
    'This draft or version does not exist, or you cannot open it. A draft can be opened by its author only.',
  goHome: 'Go to your companies',
});

const KINDS = Object.freeze({
  author: 'Author',
  editor: 'Editor',
  submitter: 'Submitter',
  declared_member: 'Named colleague',
  declared_offline: 'Named outside Phaeacia',
});

/* ---------- targets of the four pages, each checked by shell.mjs link() or navigate() where it is used ---------- */

export const draftsTarget = (companyId) => `/drafts/?company=${companyId}`;
export const newAgentTarget = (companyId) => `/drafts/new/?company=${companyId}`;
export const newVersionTarget = (candidateId) => `/drafts/new/?candidate=${candidateId}`;
export const draftTarget = (candidateId) => `/draft/?candidate=${candidateId}`;
export const submittedTarget = (candidateId) => `/submitted/?candidate=${candidateId}`;
/** The page a version opens on: a draft on the draft page, every other state on the submitted page. */
export const pageFor = (candidate) =>
  candidate?.state === 'draft' ? draftTarget(candidate.candidateId) : submittedTarget(candidate.candidateId);

/** The candidate query value as sent, or null; the server's 404 decides (rule 10). */
export function candidateParam() {
  const value = new URLSearchParams(location.search).get('candidate');
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/* ---------- pure helpers, called by the unit test ---------- */

/** The UTF-8 length of a text, which is what the server counts. */
export function byteLength(text) {
  return new TextEncoder().encode(String(text)).length;
}

/** A byte count as the pages write it. */
export const bytesWord = (n) => `${Number(n).toLocaleString('en-US')} bytes`;

/** The passport a press sends: the chosen file when there is one, sent as its Blob, otherwise the text. Refused on the
    page, and so never sent: nothing at all, and more than MAX_PASSPORT_BYTES. Whitespace goes to the server, which
    decides. -> { ok: true, passport, bytes, from } | { ok: false, reason: 'empty' | 'too-large', bytes }. */
export function choosePassport({ text = '', file = null } = {}) {
  const from = file ? 'file' : 'text';
  const bytes = file ? file.size : byteLength(text);
  if (!Number.isFinite(bytes) || bytes <= 0) return { ok: false, reason: 'empty', bytes: 0 };
  if (bytes > MAX_PASSPORT_BYTES) return { ok: false, reason: 'too-large', bytes };
  return { ok: true, passport: file ?? String(text), bytes, from };
}

/** The page's sentence for a passport refused before sending. */
export function refusedBeforeSending(choice) {
  if (choice.reason === 'too-large')
    return `This passport is ${bytesWord(choice.bytes)}; the service accepts at most ${bytesWord(MAX_PASSPORT_BYTES)} (256 KiB). Nothing was sent.`;
  return INTAKE_TEXT.empty;
}

/** The sentence under a chosen file: its name and size, and that the text box is not sent. */
export const chosenFileSentence = (file) =>
  `Chosen file: ${file.name}, ${bytesWord(file.size)}. It will be sent exactly as it was saved, and the text box will not be sent.`;

const lines = (text) =>
  String(text ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** The submit route's JSON body from the form's values (design 4.4): the fields as typed, dependencies and outside names
    one per non-empty line with the line's surrounding spaces removed, ticked colleagues by membership id. The server
    decides every length and shape again. */
export function submissionFromForm({ sourcePlatform = '', confidence = null, permittedData = '', dependencies = '', colleagues = [], names = '' } = {}) {
  return {
    sourcePlatform: String(sourcePlatform),
    ...(confidence === null ? {} : { confidence }),
    permittedData: String(permittedData),
    dependencies: lines(dependencies),
    declaredContributors: [
      ...colleagues.map((membershipId) => ({ membershipId })),
      ...lines(names).map((displayName) => ({ displayName })),
    ],
  };
}

const activityOf = (c) => String(c.submittedAt ?? c.validatedAt ?? '');

/** The caller's own rows of a list answer, grouped by agent: each group's versions newest first, the groups by their
    newest activity (submission, else the last check) newest first, then by agent id so the order is stable. Rows
    authored by anybody else are left out; the Reviews page lists those. */
export function groupByAgent(rows, membershipId) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.authorMembershipId !== membershipId) continue;
    if (!groups.has(row.agentId)) groups.set(row.agentId, []);
    groups.get(row.agentId).push(row);
  }
  const out = [...groups.entries()].map(([agentId, versions]) => {
    versions.sort((a, b) => b.sequence - a.sequence);
    return { agentId, versions, latest: versions.map(activityOf).sort().at(-1) ?? '' };
  });
  out.sort((a, b) => (a.latest === b.latest ? (a.agentId < b.agentId ? -1 : 1) : a.latest < b.latest ? 1 : -1));
  return out.map(({ agentId, versions }) => ({ agentId, versions }));
}

/** The problems of a refused answer as the page shows them: line and code, and the kind for a secret, nothing else. */
export function problemsOf(result) {
  return (Array.isArray(result?.problems) ? result.problems : []).map((p) => ({
    code: String(p.code),
    line: Number.isInteger(p.line) ? p.line : null,
    kind: typeof p.kind === 'string' ? p.kind : null,
  }));
}

/* ---------- DOM ---------- */

/** A content gate refusal: the server's message, the page's sentence that nothing was stored, and the problem table. */
export function problemsView(result, lead = INTAKE_TEXT.nothingStored) {
  const problems = problemsOf(result);
  const rows = problems.map((p) =>
    el(
      'tr',
      { 'data-problem': p.code },
      el('td', {}, p.line === null ? 'not given' : `line ${p.line}`),
      el('td', {}, el('code', {}, p.code)),
      el('td', {}, p.kind ?? ''),
    ),
  );
  return el(
    'div',
    { class: 'notice', role: 'alert', 'data-state': 'refused', 'data-code': result.code ?? 'none' },
    el('p', { 'data-role': 'server-message' }, result.message ?? ''),
    el('p', { class: 'meta', 'data-role': 'nothing-stored' }, lead),
    el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data', 'data-role': 'problems-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Where'), el('th', {}, 'Problem'), el('th', {}, 'Kind'))),
        el('tbody', {}, rows),
      ),
    ),
  );
}

/** The passport input: a text box and a file input, with the chosen file named under them and a control to clear it.
    read() answers what a press sends through choosePassport; nothing is read from the file here. hold(true) makes the
    text box read-only and the file and its clear control unusable while a write is in flight, so nothing the author
    types then can be replaced by the page the answer draws (INTR-F2); hold(false) gives them back. */
export function passportInput({ id, text = '', onChange = () => undefined }) {
  const area = el('textarea', { id: `${id}-text`, name: `${id}-text`, class: 'passport-text', spellcheck: 'false', autocapitalize: 'none', 'data-role': 'passport-text' });
  area.value = text;
  area.rows = 18;
  const file = el('input', { type: 'file', id: `${id}-file`, name: `${id}-file`, 'data-role': 'passport-file' });
  file.accept = PASSPORT_FILE_TYPES;
  const chosen = el('div', { class: 'meta', 'aria-live': 'polite', 'data-role': 'chosen-file' });
  let held = false;
  let clearControl = null;
  const show = () => {
    const f = file.files?.[0] ?? null;
    clearControl = f ? button(INTAKE_TEXT.clearFile, clear, { class: 'quiet', 'data-role': 'clear-file' }) : null;
    if (clearControl) clearControl.disabled = held;
    fill(chosen, f ? [el('p', {}, isolated(chosenFileSentence(f))), clearControl] : null);
    onChange();
  };
  const clear = () => {
    file.value = '';
    show();
  };
  file.addEventListener('change', show);
  area.addEventListener('input', () => onChange());
  const node = el(
    'div',
    { class: 'passport-input', 'data-role': 'passport-input' },
    el('div', { class: 'field' }, el('label', { for: `${id}-text` }, INTAKE_TEXT.textLabel), area),
    el('div', { class: 'field' }, el('label', { for: `${id}-file` }, INTAKE_TEXT.fileLabel), file),
    chosen,
    el('p', { class: 'meta' }, `At most ${bytesWord(MAX_PASSPORT_BYTES)} (256 KiB), Markdown text.`),
  );
  return {
    node,
    area,
    file,
    read: () => ({ text: area.value, file: file.files?.[0] ?? null }),
    hasFile: () => Boolean(file.files?.[0]),
    clear,
    hold: (on) => {
      held = on;
      area.readOnly = on;
      file.disabled = on;
      if (clearControl) clearControl.disabled = on;
    },
  };
}

/** A version's state as its tag. */
export const stateTag = (state) => el('span', { class: 'tag', 'data-role': 'state', 'data-state': state }, candidateStateName(state));

/** One version of the list: its page, its state, when it was last checked and submitted, and a stale-checks line. */
export function versionItem(c) {
  return el(
    'li',
    { 'data-candidate': c.candidateId, 'data-state': c.state },
    link(pageFor(c), `Version ${c.sequence}`, { 'data-role': 'version-link' }),
    ' ',
    stateTag(c.state),
    el('span', { class: 'meta' }, dateLine(' · Checked ', c.validatedAt), dateLine(' · Submitted ', c.submittedAt)),
    c.gateStatus === 'stale' ? el('p', { class: 'meta stale', 'data-role': 'gate-stale' }, 'The content checks changed since this version was checked.') : null,
  );
}

/** One agent of the list: its versions, and the upload of a new version from the newest one. */
export function agentCard(group, { newest = group.versions[0] } = {}) {
  const count = group.versions.length;
  return el(
    'li',
    { class: 'card', 'data-agent': group.agentId },
    el('div', { class: 'card-head' }, el('span', {}, `An agent with ${count} version${count === 1 ? '' : 's'}`)),
    el('ul', { class: 'lines', 'data-role': 'versions' }, group.versions.map(versionItem)),
    el('div', { class: 'actions' }, link(newVersionTarget(newest.candidateId), INTAKE_TEXT.uploadVersion, { class: 'button secondary', 'data-role': 'new-version' })),
  );
}

/** The attestation of the last check of a draft: which checks, when, and the hashes it bound. No submitter: a draft
    has none. */
export function lastCheckView(candidate) {
  const a = candidate?.attestation ?? {};
  return el(
    'div',
    { class: 'attestation', 'data-role': 'last-check' },
    el('h3', {}, INTAKE_TEXT.lastCheck),
    el(
      'dl',
      { class: 'facts' },
      fact('Content checks', a.gateStatus === 'current' ? 'current' : 'changed since this draft was checked'),
      fact('Checked', dateLine('', a.validatedAt) ?? 'at an unknown time'),
      fact('Validator version', String(a.validatorVersion ?? '')),
      fact('Gate identity', hash(a.gateIdentitySha256)),
      fact('Content SHA-256', hash(candidate?.contentSha256)),
      fact('Derived record SHA-256', hash(candidate?.derivedSha256)),
    ),
  );
}

/** The contributors of a version with their kind, the declared outsiders marked as unverified and inherited rows marked. */
export function contributorsView(contributors, labels) {
  const rows = (Array.isArray(contributors) ? contributors : []).map((c) =>
    el(
      'li',
      { 'data-kind': c.kind, 'data-inherited': c.inheritedFromCandidateId ? 'yes' : 'no' },
      el('span', { class: 'kind' }, Object.hasOwn(KINDS, c.kind) ? KINDS[c.kind] : String(c.kind)),
      ': ',
      c.membershipId ? memberLabel(labels, c.membershipId) : [isolated(String(c.displayName ?? '')), el('span', { class: 'meta', 'data-role': 'unverified' }, INTAKE_TEXT.unverified)],
      c.inheritedFromCandidateId ? el('span', { class: 'meta', 'data-role': 'inherited' }, ' · from an earlier version') : null,
    ),
  );
  return el(
    'section',
    { 'data-role': 'contributors' },
    el('h2', {}, `${INTAKE_TEXT.contributorsHeading} (${rows.length})`),
    rows.length ? el('ul', { class: 'lines' }, rows) : el('p', { class: 'meta' }, INTAKE_TEXT.noContributor),
  );
}

/** The not-available state of a draft or a version: the same for an unknown, foreign, malformed or no longer permitted
    id, and for somebody else's draft. */
export function unavailableDraft() {
  return el(
    'div',
    { class: 'notice', role: 'alert', 'data-state': 'not-found' },
    el('h1', {}, INTAKE_TEXT.unavailableTitle),
    el('p', {}, INTAKE_TEXT.unavailableText),
    link('/', INTAKE_TEXT.goHome, { 'data-role': 'home-link' }),
  );
}

/** A short notice with a link beside it. */
export function noticeWithLink(text, target, label, state) {
  return add(el('div', { class: 'notice', role: 'status', 'data-state': state }), [el('p', {}, text), link(target, label, { 'data-role': `${state}-link` })]);
}
