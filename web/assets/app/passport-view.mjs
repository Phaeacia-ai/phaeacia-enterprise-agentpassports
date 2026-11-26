/* The review packet as DOM (E4 design 4.1): a stored passport as structured data and plain text, and the envelopes and
   releases that bind it, built with dom.mjs and never parsed (pages rule 9). No Markdown becomes markup: the derived
   record gives the title, the summary and the needs; the losses are the service's reading of section 6
   (lib/passport/packet.mjs lossRows); every stored byte is shown as text in a read-only pane.

   The three product rules on these screens, each kept in one place here:
     capability names, never values: needsTable shows each capability's name, whether the passport requires it, and
       whether version 0.1 installs it, and no other part of the row; a capability that is not installable reads
       "declared, not installed", the words of lib/passport/render.mjs;
     losses always render: lossesTable returns a table in every state, the declared rows under their label or the one
       pending row, and a state it does not know renders as pending, never as a clean result;
     the boundary: BOUNDARY is 4.1 item 2's fixed sentence, which the review page places above every action.

   Shared by the review, release, queue and release list pages: member labels from a member list, target, role and
   state names, the envelope card and its approvals, the assembled size beside its bound, targets of the two E4 detail
   pages, and the not-available state of a candidate or a release. The byte bound and the names are presentation
   copies; the service decides both. */

import { el, isolated } from './dom.mjs';
import { dateLine, link } from './shell.mjs';

export const BOUNDARY =
  "Approval governs the distributed configuration and its evidence. Phaeacia does not enforce read-only execution inside the recipient's assistant. Tools the recipient enables natively may still write even when this configuration is unchanged; the recipient's native permissions govern them.";
export const DECLARED_NOT_INSTALLED = 'declared, not installed';
export const LOSSES_DECLARED_LABEL = 'Declared by the owner, not inferred';
export const LOSSES_PENDING = 'Not installed yet; losses not assessed';
/* app.limit_assembled_bytes(), shown beside every assembled size (E4S-F10). */
export const ASSEMBLED_BYTES_MAX = 393216;

const TARGETS = { chatgpt: 'ChatGPT', 'claude-ai': 'claude.ai', 'claude-code': 'Claude Code', generic: 'Other assistant' };
const REVIEW_ROLES = { it: 'IT', business: 'Business' };
const CANDIDATE_STATES = {
  draft: 'Draft',
  submitted: 'Submitted',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  superseded: 'Superseded',
};
const ENVELOPE_STATES = { open: 'Open', approved: 'Approved', changes_requested: 'Changes requested' };

const named = (table, key) => (Object.hasOwn(table, key) ? table[key] : String(key));
export const targetName = (target) => named(TARGETS, target);
export const reviewRoleName = (role) => named(REVIEW_ROLES, role);
export const candidateStateName = (state) => named(CANDIDATE_STATES, state);
export const releaseStateName = (release) =>
  release?.state === 'withdrawn' ? 'Withdrawn' : release?.current ? 'Published, current' : 'Published, superseded';

export const bytesText = (n) => (Number.isFinite(n) ? `${Number(n).toLocaleString('en-US')} bytes` : 'an unknown number of bytes');
export const assembledLine = (n) => `${bytesText(n)} of the ${ASSEMBLED_BYTES_MAX.toLocaleString('en-US')}-byte bound`;
export const reviewTarget = (candidateId) => `/review/?candidate=${candidateId}`;
export const releaseTarget = (releaseId) => `/release/?release=${releaseId}`;

/** One term and its description, for a dl of class facts. */
export function fact(term, ...details) {
  return el('div', {}, el('dt', {}, term), el('dd', {}, ...details));
}

/** A hash as monospace text that breaks anywhere. */
export function hash(value) {
  return el('code', { class: 'hash' }, String(value ?? ''));
}

/** labelsOf(memberList) -> Map(membershipId -> label), from a GET /api/companies/{id}/members answer or null. */
export function labelsOf(list) {
  return new Map((Array.isArray(list?.members) ? list.members : []).map((m) => [m.membershipId, m.label]));
}

/** A membership as the member list labels it for this viewer; a membership the list does not carry is said to be so. */
export function memberLabel(labels, membershipId) {
  const label = labels.get(membershipId);
  if (!label) return el('span', { class: 'muted', 'data-label': 'unknown' }, 'a member this page cannot name');
  if (label.kind === 'self') return el('span', { 'data-label': 'self' }, isolated(label.value), ' (you)');
  if (label.kind === 'display_name' || label.kind === 'invitation_email')
    return el('span', { 'data-label': label.kind }, isolated(label.value));
  return el('span', { class: 'muted', 'data-label': 'none' }, 'a member with no name set');
}

/** An audience: each group's name and current member count, from Map(groupId -> { name, memberCount }). */
export function audienceNode(groupIds, groupsById) {
  const ids = Array.isArray(groupIds) ? groupIds : [];
  return el(
    'span',
    { 'data-role': 'audience' },
    ids.map((id, i) => {
      const g = groupsById.get(id);
      const count = g ? ` (${g.memberCount} member${g.memberCount === 1 ? '' : 's'})` : '';
      return [i ? ', ' : '', g ? [isolated(g.name), count] : el('span', { class: 'muted' }, 'a group this page cannot list')];
    }),
    ids.length ? null : 'no group',
  );
}

function reasonOf(reviewsById, reviewId) {
  const reason = reviewsById.get(reviewId)?.reason;
  return typeof reason === 'string' ? el('p', { class: 'reason', 'data-role': 'reason' }, isolated(reason)) : null;
}

/** Each role's approval of an envelope with its reviewer, date and reason, or that it has none yet. */
export function approvalsList(envelope, labels, reviewsById) {
  return el(
    'ul',
    { class: 'lines', 'data-role': 'approvals' },
    ['it', 'business'].map((role) => {
      const a = envelope?.approvals?.[role] ?? null;
      if (!a) return el('li', { 'data-approval': role, 'data-state': 'none' }, `${reviewRoleName(role)}: not approved yet`);
      return el(
        'li',
        { 'data-approval': role, 'data-state': 'approved' },
        `${reviewRoleName(role)}: approved by `,
        memberLabel(labels, a.reviewerMembershipId),
        dateLine(' on ', a.createdAt),
        reasonOf(reviewsById, a.reviewId),
      );
    }),
  );
}

/** An envelope with its binding, sizes, approvals, change request and the releases made from it. */
export function envelopeCard(envelope, { labels, groupsById, reviewsById, releases = [] }) {
  const change = envelope.changeRequest;
  const made = releases.filter((r) => r.envelopeId === envelope.envelopeId);
  return el(
    'li',
    { class: 'card envelope', 'data-envelope': envelope.envelopeId, 'data-status': envelope.status },
    el(
      'div',
      { class: 'card-head' },
      el('span', {}, `${targetName(envelope.target)}, revision ${envelope.revision}`),
      el('span', { class: 'tag', 'data-role': 'envelope-status' }, named(ENVELOPE_STATES, envelope.status)),
    ),
    el(
      'dl',
      { class: 'facts' },
      fact('Audience', audienceNode(envelope.audience?.groupIds, groupsById)),
      fact(
        'Release policy',
        `version ${envelope.policy?.version ?? 'unknown'}`,
        envelope.policy?.policyStatus === 'stale'
          ? el('span', { class: 'stale', 'data-role': 'policy-stale' }, ', changed since this envelope was proposed')
          : null,
      ),
      fact(
        'Content checks',
        envelope.gate?.gateStatus === 'stale'
          ? el('span', { class: 'stale', 'data-role': 'gate-stale' }, 'changed since this envelope was proposed')
          : 'current',
      ),
      fact('Assembled size', assembledLine(envelope.assembledBytes)),
      fact('Proposed by', memberLabel(labels, envelope.createdByMembershipId), dateLine(' on ', envelope.createdAt)),
    ),
    approvalsList(envelope, labels, reviewsById),
    change
      ? el(
          'div',
          { class: 'change-request', 'data-role': 'change-request' },
          el(
            'p',
            {},
            `Changes requested by the ${reviewRoleName(change.role)} reviewer `,
            memberLabel(labels, change.reviewerMembershipId),
            dateLine(' on ', change.createdAt),
          ),
          reasonOf(reviewsById, change.reviewId),
        )
      : null,
    made.map((r) =>
      el(
        'p',
        { class: 'meta', 'data-role': 'release-of-envelope', 'data-release': r.releaseId },
        `${releaseStateName(r)}: `,
        link(releaseTarget(r.releaseId), 'open the release'),
      ),
    ),
  );
}

/** The derived record's title and summary. */
export function derivedView(derived) {
  const record = derived !== null && typeof derived === 'object' ? derived : {};
  return el(
    'div',
    { class: 'derived', 'data-role': 'derived' },
    el('h3', { 'data-role': 'passport-title' }, isolated(String(record.title ?? ''))),
    typeof record.summary === 'string' ? el('p', { 'data-role': 'summary' }, isolated(record.summary)) : null,
  );
}

function table(role, headers, rows) {
  const body = rows.map((row) => {
    if (row.span !== undefined) {
      const cell = el('td', { 'data-role': 'single-row' }, row.span);
      cell.colSpan = headers.length;
      return el('tr', {}, cell);
    }
    return el('tr', row.attributes ?? {}, row.cells.map((c) => el('td', {}, c)));
  });
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      { class: 'data', 'data-role': `${role}-table` },
      el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, h)))),
      el('tbody', {}, body),
    ),
  );
}

/** The needs of the derived record: the capability's name, required or optional, installable or declared only. */
export function needsTable(needs) {
  const rows = Array.isArray(needs) ? needs : [];
  return el(
    'div',
    { class: 'needs', 'data-role': 'needs' },
    el('h3', {}, 'What it needs'),
    table(
      'needs',
      ['Capability', 'Required', 'Installation'],
      rows.length
        ? rows.map((n) => ({
            attributes: { 'data-installable': n?.installable === true ? 'yes' : 'no' },
            cells: [
              isolated(String(n?.capability ?? '')),
              n?.required === true ? 'Required' : 'Optional',
              n?.installable === true ? 'installable' : DECLARED_NOT_INSTALLED,
            ],
          }))
        : [{ span: 'The derived record lists no capability.' }],
    ),
  );
}

/** The losses table, rendered in every state: declared rows with their label, or the one pending row. `lastReport` is
    the reader's own newest report where the caller has one; `handed` says a download answer is in hand in this page
    lifetime, and `blocked` is the release's blockedReason; the three decide the pending row's sentence together
    (E5PW-R-F1, E5C-R-F3, pendingLossesSentence), and no caller composes that sentence itself. Only the release page's
    install section knows the last two, so every other caller passes neither. The table is the same table in every
    state, which is the rule this function holds. */
export function lossesTable(losses, { lastReport = null, handed = false, blocked = null } = {}) {
  const declared = losses?.state === 'declared' && Array.isArray(losses.rows) && losses.rows.length > 0;
  return el(
    'div',
    { class: 'losses', 'data-role': 'losses', 'data-losses': declared ? 'declared' : 'pending' },
    el('h3', {}, 'Losses'),
    el('p', { class: 'meta', 'data-role': 'losses-label' }, declared ? LOSSES_DECLARED_LABEL : 'Pending an installation'),
    table(
      'losses',
      ['What', 'Status', 'What that means in practice'],
      declared
        ? losses.rows.map((r) => ({
            cells: [isolated(String(r?.what ?? '')), isolated(String(r?.status ?? '')), isolated(String(r?.meaning ?? ''))],
          }))
        : [{ span: pendingLossesSentence(lastReport, { handed, blocked }) }],
    ),
  );
}

/** The submission metadata a candidate carries. */
export function submissionView(candidate) {
  const deps = Array.isArray(candidate?.dependencies) ? candidate.dependencies : [];
  return el(
    'div',
    { class: 'submission', 'data-role': 'submission' },
    el('h3', {}, 'Submission'),
    el(
      'dl',
      { class: 'facts' },
      fact('Source platform', isolated(String(candidate?.sourcePlatform ?? ''))),
      fact('Confidence', String(candidate?.confidence ?? '')),
      fact('Permitted data', isolated(String(candidate?.permittedData ?? ''))),
      fact(
        'Dependencies',
        deps.length ? el('ul', { class: 'lines' }, deps.map((d) => el('li', {}, isolated(String(d))))) : 'none declared',
      ),
    ),
  );
}

/** The attestation panel: the identity that checked the content, when, and the hashes it bound. */
export function attestationView(candidate, labels) {
  const a = candidate?.attestation ?? {};
  return el(
    'div',
    { class: 'attestation', 'data-role': 'attestation' },
    el('h3', {}, 'Attestation'),
    el(
      'dl',
      { class: 'facts' },
      fact('Content checks', a.gateStatus === 'current' ? 'current' : 'changed since this version was checked'),
      fact('Checked', dateLine('', a.validatedAt) ?? 'at an unknown time'),
      fact('Validator version', String(a.validatorVersion ?? '')),
      fact('Gate identity', hash(a.gateIdentitySha256)),
      fact('Adapter lock', hash(a.adapterLockSha256)),
      fact('Manifest', hash(a.manifestSha256)),
      fact('Content SHA-256', hash(candidate?.contentSha256)),
      fact('Derived record SHA-256', hash(candidate?.derivedSha256)),
      fact('Submitted by', memberLabel(labels, candidate?.submittedByMembershipId), dateLine(' on ', candidate?.submittedAt)),
    ),
  );
}

/** Every stored byte as text in a scrollable, read-only pane. */
export function contentPane(content) {
  const pane = el('pre', { class: 'content-pane', tabindex: '0', 'data-role': 'content', 'aria-label': 'The passport as stored' });
  pane.textContent = typeof content === 'string' ? content : '';
  return el(
    'div',
    { class: 'content' },
    el('h3', {}, 'The passport as stored'),
    el('p', { class: 'meta' }, 'Every stored byte, shown as text and never rendered.'),
    pane,
  );
}

/** The not-found state of a candidate or a release: the same for an unknown, foreign, malformed or no longer permitted
    id. */
export function unavailableView(kind) {
  const release = kind === 'release';
  return el(
    'div',
    { class: 'notice', role: 'alert', 'data-state': 'not-found' },
    el('h1', {}, release ? 'Release not available' : 'Review not available'),
    el('p', {}, `This ${release ? 'release' : 'review'} does not exist, or you cannot read it in a company you belong to.`),
    link('/', 'Go to your companies', { 'data-role': 'home-link' }),
  );
}

/* ---------- E5: the installation surfaces (design 1.3, 1.5, 1.6, 4.1) ----------

   Every fixed sentence the catalog and the release page say about an installation lives in INSTALLATION_TEXT, and the
   five pure functions below are the only places a client turns a server value into one of them. Two rules hold them:

     truthful labels (design 1.5, E5D-C-F5). A ledger row proves that the server authorized a download and nothing
       more, so authorizationLabel speaks of an authorized download and never of an installation; installation words
       come from a report object, whose own `label` the service composed with lib/rules/installations.mjs. The word
       "verified" appears on no installation sentence here, which tests/e2/unit/web-e5-modules.test.mjs checks over
       labelTable() with the same refusedLabelTokens the server's own gate uses;
     the status names are a presentation copy of app.installation_statuses(), pinned to lib/rules/installations.mjs
       statusName() by that same test, so a vocabulary change fails a check instead of drifting.

   The five are pure and answer strings, so the unit test calls them directly; everything below them builds DOM and is
   checked in a browser by the E5 journeys. */

export const INSTALLATION_TEXT = Object.freeze({
  statusPass: 'It works',
  statusPartial: 'It partly works',
  statusFail: 'It does not work',
  statusRemoved: 'I have removed it',
  authorizedOnce: 'Download authorized',
  noAuthorization: 'You have not been given this block yet.',
  noAuthorizationOther: 'No download of this release has been authorized for this member.',
  emptyNoTargetEnabled:
    'No agent is available to you yet. Phaeacia enables installation for a platform only after a run in that product is recorded, and none is enabled yet.',
  emptyNoGroups: 'You are in no group yet. An administrator adds you to the groups an agent is addressed to.',
  emptyNoneForMyGroups: 'No agent has been published to your groups.',
  emptyUnknown: 'No release on the pages read so far is addressed to you.',
  morePagesFollow:
    'No release on the pages read so far is addressed to you, and more releases follow. Read the next page before reading this as an empty catalog.',
  blockTargetPrefix: 'Installation for ',
  blockTargetSuffix: ' is not enabled. Copies already installed are unchanged.',
  blockAgentOrphaned: 'This agent has no owner at the moment, so new downloads have stopped.',
  blockAgentArchived: 'This agent is archived, so new downloads have stopped.',
  blockWithdrawn: 'Withdrawn. New downloads of this release have stopped.',
  blockSuperseded: 'This version is no longer the current one.',
  blockDownloadLimit: 'You have reached the number of downloads this service allows you for this release.',
  blockNotAddressed: 'This release is not addressed to your groups now.',
  blockOther: 'This release cannot be downloaded now.',
  copiesNoReport: 'Any copy you downloaded is unchanged; Phaeacia cannot see or remove it.',
  copiesRemoved: 'You reported that you removed it. Phaeacia cannot see or remove copies.',
  copiesInstalled: 'Your installed copy is unchanged; Phaeacia cannot see or remove it.',
  replacementAddressed: 'A newer version is addressed to your groups.',
  replacementNotAddressed: 'A newer version exists but is not addressed to your groups.',
  replacementNone: 'No newer version has been published.',
  checkInDue: 'Your check-in is due. Tell us whether this is still installed and working.',
  installLead: 'This records that you were given the block.',
  hashCompare: 'Compare this with what you paste.',
  lossesRequired: 'Say what did not come across. This is required for a partial or a failed installation.',
  nothingReported: 'Nothing has been reported about this release yet.',
  lossesPendingHanded: 'The losses declared for this release are shown here when the service hands the block over.',
  /* E5C-R-F3: a block in hand whose owner declared nothing, and a release whose downloads have stopped. Neither is a
     no-loss statement and neither claims an installation. */
  lossesNothingDeclared: 'The owner declared nothing in this section of the block you were given. Nothing has been assessed.',
  lossesPendingBlocked: 'Downloads of this release have stopped, so the losses declared for it are not shown here.',
});

const STATUS_NAMES = Object.freeze({
  pass: INSTALLATION_TEXT.statusPass,
  partial: INSTALLATION_TEXT.statusPartial,
  fail: INSTALLATION_TEXT.statusFail,
  removed: INSTALLATION_TEXT.statusRemoved,
});
/** app.installation_statuses() order, which the report form's radio buttons follow. */
export const INSTALLATION_STATUSES = Object.freeze(['pass', 'partial', 'fail', 'removed']);
/** The statuses whose report needs a losses statement, said by the page before the server says it (design 1.4a). */
export const LOSSES_REQUIRED_STATUSES = Object.freeze(['partial', 'fail']);
export const lossesRequiredFor = (status) => LOSSES_REQUIRED_STATUSES.includes(status);

/** The plain name of a status (design 4.1 item 3); an unknown value is shown as itself and decides nothing. */
export const installationStatusName = (status) => named(STATUS_NAMES, status);

/** What a ledger count alone supports (E5D-C-F5): an authorized download, never an installation. Null at zero. */
export function authorizationLabel(authorizations) {
  if (!Number.isInteger(authorizations) || authorizations <= 0) return null;
  return authorizations === 1 ? INSTALLATION_TEXT.authorizedOnce : `Download authorized ${authorizations} times`;
}

/** Why the catalog has no row for this member (design 1.3); an unnamed reason gets the neutral sentence. */
export function emptySentence(reason) {
  if (reason === 'no_target_enabled') return INSTALLATION_TEXT.emptyNoTargetEnabled;
  if (reason === 'no_groups') return INSTALLATION_TEXT.emptyNoGroups;
  if (reason === 'none_for_my_groups') return INSTALLATION_TEXT.emptyNoneForMyGroups;
  return INSTALLATION_TEXT.emptyUnknown;
}

/** Why a row cannot be downloaded, from the one predicate's code (design 1.1, 1.3). Null when it can be. */
export function blockedSentence(code, target) {
  if (code === null || code === undefined) return null;
  if (code === 'E_TARGET_NOT_PUBLISHABLE')
    return `${INSTALLATION_TEXT.blockTargetPrefix}${targetName(target)}${INSTALLATION_TEXT.blockTargetSuffix}`;
  if (code === 'E_AGENT_ORPHANED') return INSTALLATION_TEXT.blockAgentOrphaned;
  if (code === 'E_AGENT_ARCHIVED') return INSTALLATION_TEXT.blockAgentArchived;
  if (code === 'E_RELEASE_WITHDRAWN') return INSTALLATION_TEXT.blockWithdrawn;
  if (code === 'E_RELEASE_SUPERSEDED') return INSTALLATION_TEXT.blockSuperseded;
  if (code === 'E_DOWNLOAD_LIMIT') return INSTALLATION_TEXT.blockDownloadLimit;
  if (code === 'E_NOT_FOUND') return INSTALLATION_TEXT.blockNotAddressed;
  return INSTALLATION_TEXT.blockOther;
}

/** What is true of the copies, said conditionally (E5D-C-F5): only this member's own report makes "installed" true. */
export function copiesSentence(lastReport) {
  if (lastReport === null || lastReport === undefined) return INSTALLATION_TEXT.copiesNoReport;
  if (lastReport.status === 'removed') return INSTALLATION_TEXT.copiesRemoved;
  return INSTALLATION_TEXT.copiesInstalled;
}

/** The pending losses row's sentence (E5PW-R-F1, E5C-R-F3). The table's rows come from the download answer and the
    release read carries none, so on any load that is not preceded by a download the table is pending. In order:
      an answer in hand (`handed`) whose table is still pending is a block whose owner declared nothing, and it says so
        (E5C-R-F3: it used to promise the losses would appear when the block was handed over, which had happened);
      a blocked release (`blocked`, the release's blockedReason) and a member with a report of their own is told the
        losses are not shown because downloads have stopped (E5C-R-F3: it used to promise a hand-over that will not
        come, on a page that says so above it);
      a member whose own newest report exists is told what the table will hold, which claims nothing about whether they
        installed anything (E5PW-R-F1);
      anyone else gets E5D-C-F8's sentence, unchanged, including a blocked release read by a member with no report.
    `lastReport` is the server's `my.lastReport`; the page does not look through a list for it. */
export function pendingLossesSentence(lastReport, { handed = false, blocked = null } = {}) {
  const reported = lastReport !== null && lastReport !== undefined;
  if (handed === true) return INSTALLATION_TEXT.lossesNothingDeclared;
  if (blocked !== null && blocked !== undefined && reported) return INSTALLATION_TEXT.lossesPendingBlocked;
  if (reported) return INSTALLATION_TEXT.lossesPendingHanded;
  return LOSSES_PENDING;
}

/** The sentence for a recipient entry the ledger has no label for, that is, a membership with zero authorizations
    (E5PW-R-F2). `own` is whether the entry is the reader's own: the second person belongs there and nowhere else, and
    an administrator reading another member's entry gets the third person, the register recipientsSection already uses
    in its empty state. */
export function noAuthorizationSentence(own) {
  return own === true ? INSTALLATION_TEXT.noAuthorization : INSTALLATION_TEXT.noAuthorizationOther;
}

/** Every sentence those five can produce, with the values that produce them: the label gate reads this rather than the
    source text, so a sentence added without a check is still checked (design 1.5, the rule module's own labelTable). */
export function labelTable() {
  const rows = [];
  for (const status of INSTALLATION_STATUSES)
    rows.push({ kind: 'status', status, label: installationStatusName(status) });
  for (const authorizations of [1, 2, 200])
    rows.push({ kind: 'ledger', authorizations, label: authorizationLabel(authorizations) });
  for (const reason of ['no_target_enabled', 'no_groups', 'none_for_my_groups', 'other'])
    rows.push({ kind: 'empty', reason, label: emptySentence(reason) });
  const codes = [
    'E_TARGET_NOT_PUBLISHABLE',
    'E_AGENT_ORPHANED',
    'E_AGENT_ARCHIVED',
    'E_RELEASE_WITHDRAWN',
    'E_RELEASE_SUPERSEDED',
    'E_DOWNLOAD_LIMIT',
    'E_NOT_FOUND',
    'E_SOMETHING_THIS_PAGE_DOES_NOT_KNOW',
  ];
  for (const code of codes)
    for (const target of [...Object.keys(TARGETS), 'a-target-this-page-does-not-know'])
      rows.push({ kind: 'blocked', code, target, label: blockedSentence(code, target) });
  for (const report of [null, { status: 'removed' }, { status: 'pass' }, { status: 'partial' }, { status: 'fail' }]) {
    const status = report === null ? null : report.status;
    rows.push({ kind: 'copies', status, label: copiesSentence(report) });
    rows.push({ kind: 'losses-pending', status, label: pendingLossesSentence(report) });
    rows.push({ kind: 'losses-pending', status, handed: true, label: pendingLossesSentence(report, { handed: true }) });
    rows.push({ kind: 'losses-pending', status, blocked: true, label: pendingLossesSentence(report, { blocked: 'E_TARGET_NOT_PUBLISHABLE' }) });
  }
  for (const own of [true, false]) rows.push({ kind: 'no-authorization', own, label: noAuthorizationSentence(own) });
  for (const [key, label] of Object.entries(INSTALLATION_TEXT)) rows.push({ kind: 'fixed', key, label });
  return Object.freeze(rows.map((r) => Object.freeze(r)));
}

/** One witness of a report: the label the service composed, the status it states, its note and its time. */
export function witnessLine(witness) {
  return el(
    'li',
    { 'data-witness': witness.witnessId, 'data-status': witness.status },
    el('span', { class: 'kind', 'data-role': 'witness-label' }, String(witness.label ?? '')),
    `: ${installationStatusName(witness.status)}`,
    dateLine(' on ', witness.witnessedAt),
    el('p', { class: 'reason', 'data-role': 'witness-note' }, isolated(String(witness.note ?? ''))),
  );
}

/** The ledger line of one recipient entry in "What happened after" (design 4.1 item 4), for the entries whose answer
    carries the count at all; a reviewer's entries carry none and get no line (E5D-C-F3), which is the caller's test to
    make, not this function's. `own` says whether the entry is the reader's own, and it decides only which sentence a
    zero gets (E5PW-R-F2). The count itself is authorizationLabel's, so this line can say nothing about an installation.
    It is here rather than in the page because a page module exports nothing a check can render. */
export function authorizationLine(entry, { own = false } = {}) {
  return el(
    'p',
    { class: 'meta', 'data-role': 'authorization', 'data-own': own === true ? 'yes' : 'no' },
    authorizationLabel(entry?.authorizations) ?? noAuthorizationSentence(own),
    dateLine(', first ', entry?.firstAuthorizedAt),
    dateLine(', last ', entry?.lastAuthorizedAt),
  );
}

/** One report: its provenance label, its status by its plain name, its time, its losses and assistance, and the
    witnesses beneath it. witnessControl is the node a reviewer's or an administrator's page puts under a report that
    is not their own; the server decides again whatever this page renders. */
export function reportCard(report, { witnessControl = null } = {}) {
  const witnesses = Array.isArray(report.witnesses) ? report.witnesses : [];
  return el(
    'li',
    { class: 'card report', 'data-report': report.reportId, 'data-status': report.status, 'data-source': report.source },
    el(
      'div',
      { class: 'card-head' },
      el('span', { 'data-role': 'report-status' }, installationStatusName(report.status)),
      el('span', { class: 'tag', 'data-role': 'report-label' }, String(report.label ?? '')),
      dateLine('', report.reportedAt),
    ),
    typeof report.losses === 'string'
      ? el('p', { class: 'reason', 'data-role': 'report-losses' }, 'What did not come across: ', isolated(report.losses))
      : null,
    typeof report.assistance === 'string'
      ? el('p', { class: 'reason', 'data-role': 'report-assistance' }, 'What help was needed: ', isolated(report.assistance))
      : null,
    witnesses.length ? el('ul', { class: 'lines', 'data-role': 'witnesses' }, witnesses.map(witnessLine)) : null,
    witnessControl,
  );
}
