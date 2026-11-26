/* The release page, /release/?release=<uuid> (E4 design 4.1, 4.2, 1.4 and 3.4; E5 design 4.1 items 1 to 5, 4.2).

   Order of calls. GET /api/me; an administrator without a verified factor is moved to /mfa/ first. Then the release
   read: its 404 is the not-found state, the same for an unknown, foreign, malformed or no longer permitted id. Then the
   company's member list, its group list and GET /api/releases/{id}/installations together, for reviewer, publisher and
   recipient labels, the audience's group names and the evidence. A withdrawal, a download, a report and a witness are
   each followed by all of them again.

   What it shows, E4's part. The target, state and its banner (current, superseded with a link to the release that took
   its place, or withdrawn); the audience groups with their current member counts; the policy; the publisher; the
   assembled size beside its bound; the hashes; the approvals with reviewer labels and reasons when the service returns
   the envelope (a reader who may not read the candidate receives none, and the page says where they are); the
   withdrawal with its reason. When the service returns recipients, which it does only for an administrator or the
   agent's owner, the recipients; and for a published release the withdrawal form, with the fixed withdrawal text and
   the manual removal checklist above it. An administrator at aal1 sees the second-factor link beside the form: the
   service lets the owner withdraw at aal1 and asks an administrator who does not own the agent for aal2. A withdrawn
   release shows the recipients and the fixed text again.

   What E5 adds, in the order a recipient meets it (design 4.1):
     1. the check-in notice, when the caller's own `my.checkInDue` is true, at the top. It is the caller's own state and
        no one else's, because `my` is the only place the service puts it for this caller;
     2. the install section, whose control the service's own `download.blockedReason` decides and the routine decides
        again. The losses table renders in every one of its three states, before a download, when blocked and after
        (E5D-C-F8), the pending row saying "Not installed yet; losses not assessed" and never a no-loss statement; the
        boundary sentence stands immediately above the pane; the answer's bytes are shown as text and its hash beside
        them; "Save as a file" is the one control that is not a navigation (4.3's new rule, below);
     3. the report form, for a member with an authorization: the four statuses by their plain names, and losses, which
        the page requires for the two middle ones before the server does and the server requires again;
     4. "What happened after", from the installations read, one block per recipient the service returned. The five
        ledger fields are rendered only where that answer carries them: a reviewer's entries carry none, absent rather
        than null, so this page renders no count, date or check-in state it was not given (E5D-C-F3). A reviewer or an
        administrator gets a witness control beneath each report that is not their own, and the server decides again;
     5. the withdrawal checklist's third line, which E4 wrote to be replaced here (E5 design 1.6).

   Truthful labels (design 1.5, E5D-C-F5). Every sentence about an installation comes from passport-view.mjs, whose
   label table tests/e2/unit/web-e5-modules.test.mjs reads with the server's own refusedLabelTokens. A ledger row says
   only that a download was authorized; installation words come from a report, whose `label` the service composed.

   Three writes composed from a form: the report, a witness and the withdrawal. Each is read once, at its press (the
   withdrawal at Confirm withdrawal, not when the confirmation opens), and its inputs are held from the press to the
   answer. The Retry of its failure sends that press again under its key only while the form is unchanged; once it
   differs, Retry sends nothing and says so, and a press composes a new attempt (INF-N4 to INF-N6).

   The save control (pages design section 3's new rule, E5 design 4.3). It is not a navigation, so it does not go
   through shell.mjs's fixed-target rule: an object URL is created only for the bytes of the answer this page is
   handling, revoked in the same task, and never assigned to location. A journey asserts that no blob URL ever becomes
   a document of this tab. Since E6 the control itself is save-file.mjs's, shared with the home and members pages. */

import { download, groups, installations, me, members, release, reportInstallation, sendAdminsToEnrolment, signOutHere, withdrawRelease, witnessInstallation, writeAttempt } from '../api.mjs';
import { button, el, fill, form, isolated } from '../dom.mjs';
import { approvalsList, assembledLine, audienceNode, authorizationLabel, authorizationLine, blockedSentence, BOUNDARY, fact, hash, INSTALLATION_STATUSES, INSTALLATION_TEXT, installationStatusName, labelsOf, lossesRequiredFor, lossesTable, memberLabel, releaseStateName, releaseTarget, reportCard, reviewTarget, targetName, unavailableView } from '../passport-view.mjs';
import { companyLinks, dateLine, failureView, heading, keepFresh, link, loading, notice, renderHeader, renderPlainHeader, showPageState, startPage, statusRegion } from '../shell.mjs';
import { nameSafe, saveBytes } from '../save-file.mjs';

const { header, main } = startPage();
const releaseId = new URLSearchParams(location.search).get('release');
const WITHDRAWAL =
  "Withdrawal stops new downloads through Phaeacia. It cannot remove copies already downloaded, vendor account grants, or configurations already installed in a recipient's assistant.";
/* The third line is E5's, which E4 wrote to be replaced when an installation record existed (E4 4.1, E5 design 1.6). */
const CHECKLIST = [
  'Ask each recipient listed to remove the installed instructions from their assistant.',
  'Ask the native administrator to remove any connector or account grant the configuration asked for.',
  'A recipient who confirms can record it here as a removal report, and a reviewer or administrator can witness it. Both are statements by people, not checks by Phaeacia.',
];
const WITNESS_ROLES = ['it_reviewer', 'business_reviewer', 'company_admin'];
/* What the page says when the Retry of a write would send an earlier form (INF-N4 to INF-N6). */
const CHANGED_TEXT = Object.freeze({
  report:
    'The form changed after this report failed, so Retry would send the earlier answers. Nothing was sent. Press Record what happened to send the form as it is now; if the earlier report was stored, that adds a second, newer report.',
  witness:
    'The form changed after this witness failed, so Retry would send the earlier answers. Nothing was sent. Press Record this witness to send the form as it is now; if the earlier witness was stored, the service answers that you have already witnessed this report.',
  withdraw:
    'The reason changed after this withdrawal failed, so Retry would send the earlier reason. Nothing was sent. Press Confirm withdrawal again to send the reason as it is now; if the earlier withdrawal was stored, the service answers that the release is already withdrawn.',
});

let identity = null;
let flash = null;
/* The download answer of this page lifetime and nothing longer (pages rule 1: the data of the current API answers).
   keepFresh's clear drops it on pagehide, so a restored page shows no bytes before it has read them again. */
let handed = null;

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

function discard() {
  flash = null;
  handed = null;
  fill(main, unavailableView('release'));
}

function settle(r, status, retry) {
  if (r.action === 'navigating') return;
  if (r.action === 'not-found') return discard();
  if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
  if (r.action === 'reload') {
    flash = failureView(r);
    return load();
  }
  fill(status, failureView(r, { retry }));
}

function success(text, state, result) {
  const node = notice(text, state);
  if (result?.idempotentReplay === true) node.setAttribute('data-replay', 'true');
  return node;
}

function option(name, value, label, { id, checked = false }) {
  const input = el('input', { type: 'radio', name, id, value, checked });
  return { input, wrap: el('div', { class: 'option' }, input, el('label', { for: id }, label)) };
}
const pickedOne = (options) => options.find((o) => o.input.checked)?.input.value;
const changedNotice = (state, text) => el('p', { class: 'notice', role: 'status', 'data-state': state }, text);
/* The Retry of a write composed from a form: that press again, while the form would still send the same body. */
const retryWhileSame = (bodyNow, body, again, status, state, text) => () =>
  JSON.stringify(bodyNow()) === JSON.stringify(body) ? again() : fill(status, changedNotice(state, text));

function removalText() {
  return el(
    'div',
    { class: 'removal', 'data-role': 'removal-text' },
    el('p', { class: 'boundary', 'data-role': 'withdrawal-text' }, WITHDRAWAL),
    el('ol', { class: 'lines', 'data-role': 'removal-checklist' }, CHECKLIST.map((line) => el('li', {}, line))),
  );
}

function stateBanner(r) {
  if (r.state === 'withdrawn')
    return el('p', { class: 'notice', role: 'status', 'data-state': 'withdrawn' }, 'Withdrawn: new downloads of this release have stopped.');
  if (!r.current)
    return el(
      'p',
      { class: 'notice', role: 'status', 'data-state': 'superseded' },
      'A later release took the place of this one',
      dateLine(' on ', r.supersededAt),
      '. ',
      r.supersededByReleaseId ? link(releaseTarget(r.supersededByReleaseId), 'Open the later release', { 'data-role': 'superseded-by' }) : null,
    );
  return el('p', { class: 'meta', 'data-state': 'current' }, `The current release of this agent for ${targetName(r.target)}.`);
}

function withdrawnNotice(result) {
  const count = result.recipientCount ?? 0;
  const node = el(
    'div',
    { class: 'notice confirm', role: 'status', 'data-state': 'withdrawn-now' },
    el('p', {}, `Withdrawn. ${count} recipient${count === 1 ? '' : 's'} had a download authorized.`),
    result.revokesCopies === false ? el('p', { 'data-role': 'copies-not-revoked' }, 'Copies already downloaded are not revoked.') : null,
  );
  if (result.idempotentReplay === true) node.setAttribute('data-replay', 'true');
  return node;
}

/* ---------- E5 (1): the check-in notice ---------- */

/* The caller's own derived state and nobody else's: the service puts checkInDue in `my`, which is answered about the
   caller alone. The control moves the keyboard to the report form rather than navigating anywhere. */
function checkInNotice() {
  return el(
    'div',
    { class: 'notice', role: 'status', 'data-state': 'check-in-due', 'data-role': 'check-in' },
    el('p', {}, INSTALLATION_TEXT.checkInDue),
    button('Go to the report form', () => main.querySelector('[data-role="report-heading"]')?.focus(), {
      class: 'secondary',
      'data-role': 'check-in-report',
    }),
  );
}

/* ---------- E5 (2): the install section ---------- */

/* A file name from values the service supplied: the agent reference, the target and the first eight characters of the
   assembled hash (design 1.3), each through save-file.mjs's nameSafe, so a value this page did not choose cannot shape
   the name a browser writes. The save itself is save-file.mjs's, the one control that is not a navigation (E6 moved it
   there so the home and members pages share it; scripts/check-web.mjs names that file as its one owner). */
const fileNameFor = (r, sha) => `${nameSafe(String(r.agentId).slice(0, 8))}-${nameSafe(r.target)}-${nameSafe(String(sha).slice(0, 8))}.md`;

function handedPane(r, answer) {
  const pane = el('pre', {
    class: 'content-pane',
    tabindex: '0',
    'data-role': 'assembled',
    'aria-label': 'The installation block as stored',
  });
  pane.textContent = typeof answer.assembledContent === 'string' ? answer.assembledContent : '';
  return el(
    'div',
    { class: 'content', 'data-role': 'handed-block' },
    el('h3', {}, 'The installation block'),
    el('p', { class: 'meta' }, 'Every stored byte, shown as text and never rendered. Paste it into your assistant.'),
    el(
      'p',
      { class: 'meta', 'data-role': 'assembled-hash' },
      'SHA-256 ',
      hash(answer.assembledSha256),
      `. ${INSTALLATION_TEXT.hashCompare}`,
    ),
    pane,
    button('Save as a file', () => saveBytes(fileNameFor(r, answer.assembledSha256), answer.assembledContent, 'text/markdown'), {
      class: 'secondary',
      'data-role': 'save-file',
    }),
  );
}

function installSection(r, data) {
  const blocked = data.download?.blockedReason ?? null;
  const blockedText = blockedSentence(blocked, r.target);
  const status = statusRegion('download-status');
  const run = async () => {
    fill(status);
    const got = await download(r.releaseId);
    if (got.action === 'navigating') return;
    if (got.ok) {
      handed = got.data;
      flash = success(
        authorizationLabel(got.data.authorization?.authorizations ?? 1) ?? INSTALLATION_TEXT.authorizedOnce,
        'download-authorized',
        got.data,
      );
      return load();
    }
    settle(got, status, run);
  };
  return el(
    'section',
    { class: 'panel', 'data-role': 'install-section', 'data-blocked': blocked ?? 'none' },
    el('h2', {}, 'Install'),
    blockedText
      ? el('p', { class: 'notice', role: 'status', 'data-state': 'blocked', 'data-code': blocked }, blockedText)
      : el(
          'div',
          { class: 'actions', 'data-role': 'download-actions' },
          button('Get the installation block', run, { 'data-role': 'download' }),
          el('p', { class: 'meta' }, INSTALLATION_TEXT.installLead),
        ),
    /* The declared rows exist only in a download answer, which this page lifetime may not have made; the pending row
       then follows this member's own newest report, as the server read it, rather than telling a member who has just
       reported that nothing is installed yet (E5PW-R-F1), and whether an answer is in hand and the release is blocked,
       so it neither promises a hand-over that happened nor one that will not come (E5C-R-F3). */
    lossesTable(handed?.losses ?? null, { lastReport: data.my?.lastReport ?? null, handed: handed !== null, blocked }),
    el('p', { class: 'boundary', 'data-role': 'install-boundary' }, BOUNDARY),
    /* E6P-F11, E5C-R-F3's class: under a blocked release the placeholder promised a hand-over that will not come, on the
       page that says above it that downloads have stopped. It now says so instead. */
    handed
      ? handedPane(r, handed)
      : blockedText
        ? el('p', { class: 'meta', 'data-role': 'no-block-blocked' }, 'No block is handed over while downloads of this release are stopped.')
        : el('p', { class: 'meta', 'data-role': 'no-block-yet' }, 'The block is shown here once the service has handed it over.'),
    status,
  );
}

/* ---------- E5 (3): the report form ---------- */

function reportSection(r) {
  const options = INSTALLATION_STATUSES.map((s, i) =>
    option('install-status', s, installationStatusName(s), { id: `install-status-${s}`, checked: i === 0 }),
  );
  const losses = el('textarea', { id: 'report-losses', name: 'report-losses', spellcheck: 'true', 'data-role': 'losses-field' });
  const assistance = el('textarea', { id: 'report-assistance', name: 'report-assistance', spellcheck: 'true', 'data-role': 'assistance-field' });
  const status = statusRegion('report-status');
  const submit = el('button', { type: 'submit', 'data-role': 'report' }, 'Record what happened');
  const bodyOf = () => ({
    status: pickedOne(options),
    losses: losses.value.trim() === '' ? null : losses.value,
    assistance: assistance.value.trim() === '' ? null : assistance.value,
  });
  const hold = (on) => {
    for (const o of options) o.input.disabled = on;
    losses.readOnly = on;
    assistance.readOnly = on;
    submit.disabled = on;
  };
  const run = async (attempt, body) => {
    hold(true);
    fill(status);
    const r2 = await attempt();
    hold(false);
    if (r2.action === 'navigating') return;
    if (r2.ok) {
      flash = success('Recorded. This is your own statement; Phaeacia does not check it.', 'reported', r2.data);
      return load();
    }
    settle(r2, status, retryWhileSame(bodyOf, body, () => run(attempt, body), status, 'report-changed', CHANGED_TEXT.report));
  };
  return el(
    'section',
    { class: 'panel', 'data-role': 'report-section' },
    el('h2', { tabindex: '-1', 'data-role': 'report-heading' }, 'Record what happened'),
    el(
      'p',
      { class: 'meta' },
      'Your own statement about what happened after you were given this block. It is a self-report: Phaeacia records it and checks nothing.',
    ),
    form(
      { class: 'stack', 'data-role': 'report-form' },
      () => {
        const body = bodyOf();
        /* The page says the losses rule before the server does (design 4.1 item 3); the routine says it again. */
        if (lossesRequiredFor(body.status) && body.losses === null) {
          fill(
            status,
            el('p', { class: 'notice', role: 'alert', 'data-state': 'losses-required', 'data-role': 'losses-required' }, INSTALLATION_TEXT.lossesRequired),
          );
          return undefined;
        }
        return run(writeAttempt((key) => reportInstallation(r.releaseId, body, key)), body);
      },
      el('fieldset', { class: 'choice', 'data-role': 'status-choice' }, el('legend', {}, 'What happened'), options.map((o) => o.wrap)),
      el('div', { class: 'field' }, el('label', { for: 'report-losses' }, 'What did not come across'), losses),
      el('p', { class: 'meta' }, INSTALLATION_TEXT.lossesRequired),
      el('div', { class: 'field' }, el('label', { for: 'report-assistance' }, 'What help was needed'), assistance),
      submit,
      status,
    ),
  );
}

/* ---------- E5 (4): what happened after ---------- */

function witnessControl(report) {
  const options = INSTALLATION_STATUSES.map((s, i) =>
    option(`witness-status-${report.reportId}`, s, installationStatusName(s), { id: `witness-${report.reportId}-${s}`, checked: i === 0 }),
  );
  const note = el('textarea', {
    id: `witness-note-${report.reportId}`,
    name: `witness-note-${report.reportId}`,
    spellcheck: 'true',
    'data-role': 'witness-note-field',
  });
  const status = statusRegion('witness-status');
  const tools = el('div', { class: 'tools', 'data-role': 'witness-tools' });
  const submit = el('button', { type: 'submit', 'data-role': 'witness-submit' }, 'Record this witness');
  /* Read once, at the press: the Retry of a lost answer sends this body again, never one read afresh (INF-N5). */
  const bodyOf = () => ({ status: pickedOne(options), note: note.value });
  const hold = (on) => {
    for (const o of options) o.input.disabled = on;
    note.readOnly = on;
    submit.disabled = on;
  };
  const run = async (attempt, body) => {
    hold(true);
    fill(status);
    const r2 = await attempt();
    hold(false);
    if (r2.action === 'navigating') return;
    if (r2.ok) {
      flash = success('Witnessed. This states who said it, not that anything was independently established.', 'witnessed', r2.data);
      return load();
    }
    settle(r2, status, retryWhileSame(bodyOf, body, () => run(attempt, body), status, 'witness-changed', CHANGED_TEXT.witness));
  };
  const show = () => fill(tools, button('Witness this report', open, { class: 'secondary', 'data-role': 'witness' }));
  const open = () =>
    fill(
      tools,
      el(
        'div',
        { class: 'confirm-box', 'data-role': 'witness-box' },
        form(
          { class: 'stack', 'data-role': 'witness-form' },
          () => {
            const body = bodyOf();
            return run(writeAttempt((key) => witnessInstallation(report.reportId, body, key)), body);
          },
          el('fieldset', { class: 'choice' }, el('legend', {}, 'What you observed'), options.map((o) => o.wrap)),
          el('div', { class: 'field' }, el('label', { for: note.id }, 'What you observed, in your own words'), note),
          el(
            'div',
            { class: 'actions' },
            submit,
            button('Cancel', show, { class: 'quiet', 'data-role': 'witness-cancel' }),
          ),
        ),
      ),
    );
  show();
  return el('div', { 'data-role': 'witness-control' }, tools, status);
}

/* One recipient's block. The five ledger fields are rendered only where the answer carries them: a reviewer's entry
   carries none of them, absent rather than null, so this page renders no count, date or check-in state it was not
   given (E5D-C-F3). Object.hasOwn, never a falsy test, because zero and null are values the admin's answer can carry
   and absence is the thing being distinguished. */
function recipientEvidence(entry, labels, viewer) {
  const carriesLedger = Object.hasOwn(entry, 'authorizations');
  const reports = Array.isArray(entry.reports) ? entry.reports : [];
  return el(
    'li',
    { class: 'card', 'data-membership': entry.membershipId, 'data-ledger': carriesLedger ? 'shown' : 'absent' },
    el('div', { class: 'card-head' }, memberLabel(labels, entry.membershipId)),
    carriesLedger ? authorizationLine(entry, { own: entry.membershipId === viewer.membershipId }) : null,
    carriesLedger && entry.checkInDue === true
      ? el('p', { class: 'meta', 'data-role': 'check-in-due' }, 'Check-in due', dateLine(' since ', entry.checkInDueAt))
      : null,
    reports.length
      ? el(
          'ul',
          { class: 'cards', 'data-role': 'reports' },
          /* Newest first (design 4.2): the service answers oldest first, and the newest report is the one every
             derived state on this page rests on, so it is the one a reader meets first. */
          [...reports].reverse().map((report) =>
            reportCard(report, {
              witnessControl: viewer.mayWitness && report.membershipId !== viewer.membershipId ? witnessControl(report) : null,
            }),
          ),
        )
      : el('p', { class: 'meta', 'data-state': 'no-reports' }, INSTALLATION_TEXT.nothingReported),
  );
}

function evidenceSection(list, labels, viewer) {
  const entries = Array.isArray(list?.recipients) ? list.recipients : [];
  return el(
    'section',
    { 'data-role': 'installation-evidence', 'data-scope': list?.scope ?? 'none' },
    el('h2', {}, `What happened after (${entries.length})`),
    el(
      'p',
      { class: 'meta' },
      'Statements by people. A report is the recipient, a witness is a second person holding a named role at that moment; neither is a check by Phaeacia.',
    ),
    entries.length
      ? el('ul', { class: 'cards' }, entries.map((entry) => recipientEvidence(entry, labels, viewer)))
      : el('p', { class: 'meta', 'data-state': 'empty' }, INSTALLATION_TEXT.nothingReported),
    list?.truncated === true
      ? notice('This list is incomplete: the release has more reports than this page shows.', 'truncated')
      : null,
  );
}

/* ---------- E4's sections ---------- */

function withdrawSection(r, stepUp) {
  const reason = el('textarea', { id: 'withdraw-reason', name: 'withdraw-reason', spellcheck: 'true', 'data-role': 'withdraw-reason' });
  const status = statusRegion('withdraw-status');
  const tools = el('div', { class: 'actions' });
  /* The controls tools holds now: Withdraw this release, or the confirmation's two buttons. They are held with the
     reason from the press to the answer, so no second withdrawal starts inside the first and no answer gives the
     reason back while another withdrawal is in flight. */
  let controls = [];
  const hold = (on) => {
    reason.readOnly = on;
    for (const c of controls) c.disabled = on;
  };
  const run = async (attempt, text) => {
    hold(true);
    fill(status);
    const answer = await attempt();
    hold(false);
    if (answer.action === 'navigating') return;
    if (answer.ok) {
      flash = withdrawnNotice(answer.data);
      return load();
    }
    settle(answer, status, retryWhileSame(() => reason.value, text, () => run(attempt, text), status, 'withdraw-changed', CHANGED_TEXT.withdraw));
  };
  /* The reason is read at Confirm withdrawal, the press that sends, so an edit made with the confirmation open is the
     reason withdrawn with (INF-N6); a withdrawal is one-way. */
  const confirm = () => {
    const text = reason.value;
    return run(writeAttempt((key) => withdrawRelease(r.releaseId, text, key)), text);
  };
  const show = () => {
    controls = [button('Withdraw this release', ask, { class: 'secondary danger', 'data-role': 'withdraw' })];
    fill(tools, controls);
  };
  const ask = () => {
    controls = [
      button('Confirm withdrawal', confirm, { class: 'danger', 'data-role': 'confirm-withdrawal' }),
      button('Cancel', show, { class: 'quiet', 'data-role': 'cancel' }),
    ];
    fill(
      tools,
      el(
        'div',
        { class: 'confirm-box', 'data-role': 'confirm-withdraw' },
        el('p', {}, 'Withdraw this release? New downloads stop at once; nothing already downloaded or installed is removed.'),
        el('div', { class: 'actions' }, controls),
      ),
    );
  };
  show();
  return el(
    'section',
    { class: 'panel', 'data-role': 'withdraw-section' },
    el('h2', {}, 'Withdraw'),
    removalText(),
    stepUp
      ? el(
          'p',
          { class: 'meta', 'data-role': 'withdraw-step-up' },
          'An administrator who does not own this agent needs a session verified with a second factor to withdraw. ',
          link('/mfa/', 'Verify now', { 'data-role': 'mfa-link' }),
        )
      : null,
    el('div', { class: 'field' }, el('label', { for: 'withdraw-reason' }, 'Reason, kept with the release'), reason),
    tools,
    status,
  );
}

function recipientsSection(recipients, labels) {
  return el(
    'section',
    { 'data-role': 'recipients' },
    el('h2', {}, `Recipients (${recipients.length})`),
    recipients.length
      ? el(
          'ul',
          { class: 'cards' },
          recipients.map((x) =>
            el(
              'li',
              { class: 'card', 'data-membership': x.membershipId },
              el('div', { class: 'card-head' }, memberLabel(labels, x.membershipId)),
              el(
                'p',
                { class: 'meta' },
                dateLine('First download authorized ', x.firstAuthorizedAt),
                dateLine(' · last ', x.lastAuthorizedAt),
                ` · ${x.authorizations} authorization${x.authorizations === 1 ? '' : 's'}`,
              ),
            ),
          ),
        )
      : el('p', { class: 'meta', 'data-role': 'no-recipients' }, 'No download of this release has been authorized.'),
  );
}

/* ---------- the page ---------- */

/* Whether this caller is offered the install section at all (design 4.1 item 2 and 4.2). A caller the predicate
   refuses with E_NOT_FOUND on a release that is not current is not a recipient and sees no section rather than a
   disabled one; a recipient whose download is blocked sees the section with its reason and its losses table, which is
   E5D-C-F8's "when blocked". The control inside it is the service's decision, and the routine decides again. */
function showsInstall(r, data) {
  /* `?? 'E_NOT_FOUND'` would read the service's own "nothing blocks this download" as a refusal, because null is
     nullish: the absent `download` block and a null blockedReason are two different answers and are read as two. */
  const blocked = data.download ? data.download.blockedReason : 'E_NOT_FOUND';
  if (blocked === null) return true;
  if ((data.my?.authorizations ?? 0) > 0) return true;
  return r.state === 'published' && r.current === true && blocked !== 'E_NOT_FOUND';
}

function render(data, labels, groupsById, groupsTruncated, membership, list) {
  const r = data.release;
  const shown = flash;
  flash = null;
  const reviewsById = new Map((data.reviews ?? []).map((x) => [x.reviewId, x]));
  const roles = membership?.roles ?? [];
  const admin = roles.includes('company_admin');
  const viewer = {
    membershipId: membership?.membershipId ?? null,
    mayWitness: WITNESS_ROLES.some((role) => roles.includes(role)),
  };
  fill(
    main,
    shown,
    data.my?.checkInDue === true ? checkInNotice() : null,
    el(
      'section',
      { 'data-role': 'release-head', 'data-state': r.state, 'data-current': r.current ? 'yes' : 'no' },
      heading(`${targetName(r.target)} release`, releaseStateName(r)),
      stateBanner(r),
    ),
    el(
      'div',
      { class: 'toolbar-row' },
      companyLinks(r.companyId, null),
      button('Reload', load, { class: 'secondary', 'data-role': 'reload' }),
    ),
    data.envelope ? el('p', {}, link(reviewTarget(r.candidateId), 'Open the review of this version', { 'data-role': 'review-link' })) : null,
    showsInstall(r, data) ? installSection(r, data) : null,
    (data.my?.authorizations ?? 0) > 0 ? reportSection(r) : null,
    el(
      'section',
      { 'data-role': 'release-facts' },
      el('h2', {}, 'What was published'),
      groupsTruncated ? notice('This group list is incomplete: the company has more groups or group members than this page shows.', 'truncated') : null,
      el(
        'dl',
        { class: 'facts' },
        fact('Target', targetName(r.target)),
        fact('Audience', audienceNode(r.audience?.groupIds, groupsById)),
        fact('Release policy', `version ${r.policy?.version ?? 'unknown'}`),
        fact('Published by', memberLabel(labels, r.publishedByMembershipId), dateLine(' on ', r.publishedAt)),
        fact('Assembled size', assembledLine(r.assembledBytes)),
        fact('Assembled SHA-256', hash(r.assembledSha256)),
        fact('Content SHA-256', hash(r.contentSha256)),
        fact('Derived record SHA-256', hash(r.derivedSha256)),
        fact('Envelope SHA-256', hash(r.envelopeSha256)),
        fact('Gate identity', hash(r.gateIdentitySha256)),
        fact('Installer text SHA-256', hash(r.installer?.textSha256)),
        fact('Policy SHA-256', hash(r.policy?.sha256)),
      ),
    ),
    evidenceSection(list, labels, viewer),
    el(
      'section',
      { 'data-role': 'release-approvals' },
      el('h2', {}, 'Approvals'),
      data.envelope
        ? approvalsList(data.envelope, labels, reviewsById)
        : el('p', { class: 'meta', 'data-role': 'approvals-elsewhere' }, "The approvals and their reasons are shown to readers of this version's review."),
    ),
    r.withdrawal
      ? el(
          'section',
          { 'data-role': 'withdrawal' },
          el('h2', {}, 'Withdrawal'),
          el(
            'dl',
            { class: 'facts' },
            fact('Withdrawn by', memberLabel(labels, r.withdrawal.withdrawnByMembershipId), dateLine(' on ', r.withdrawal.withdrawnAt)),
            fact('Reason', isolated(String(r.withdrawal.reason ?? ''), { 'data-role': 'withdrawal-reason' })),
          ),
        )
      : null,
    data.recipients ? recipientsSection(data.recipients, labels) : null,
    r.state === 'withdrawn' ? removalText() : null,
    r.state === 'published' && data.recipients ? withdrawSection(r, admin && identity.user.aal !== 'aal2') : null,
  );
}

function refusedRead(r) {
  if (r.action === 'not-found') return discard();
  if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
  const shown = flash;
  flash = null;
  fill(main, shown, heading('Release'), failureView(r, { retry: load }));
}

async function load() {
  fill(main, loading('Loading the release.'));
  const m = await me();
  if (m.action === 'navigating') return;
  if (!m.ok) return showPageState(header, main, failureView(m, { retry: load }));
  const enrolment = await sendAdminsToEnrolment(m.data);
  if (enrolment.moved || enrolment.answer?.action === 'navigating') return;
  if (enrolment.answer) return showPageState(header, main, failureView(enrolment.answer, { retry: load }));
  identity = m.data;
  renderHeader(header, { email: identity.user.email, onSignOut: signOut });
  if (!releaseId) return discard();
  const read = await release(releaseId);
  if (read.action === 'navigating') return;
  if (!read.ok) return refusedRead(read);
  const companyId = read.data.release.companyId;
  const membership = identity.memberships.find((x) => x.companyId === companyId) ?? null;
  renderHeader(header, { email: identity.user.email, companyName: membership?.companyName ?? null, onSignOut: signOut });
  const answers = await Promise.all([members(companyId), groups(companyId), installations(releaseId)]);
  if (answers.some((a) => a.action === 'navigating')) return;
  if (answers.some((a) => a.action === 'not-found')) return discard();
  const failed = answers.find((a) => !a.ok);
  if (failed?.action === 'maintenance') return showPageState(header, main, failureView(failed, { retry: load }));
  if (failed) return fill(main, heading('Release'), failureView(failed, { retry: load }));
  const [list, groupList, evidence] = answers;
  const groupsById = new Map(groupList.data.groups.map((g) => [g.groupId, { name: g.name, memberCount: g.memberIds.length }]));
  render(read.data, labelsOf(list.data), groupsById, groupList.data.truncated, membership, evidence.data);
}

keepFresh({
  clear: () => {
    flash = null;
    handed = null;
    fill(main);
    renderPlainHeader(header);
  },
  reload: load,
});
load();
