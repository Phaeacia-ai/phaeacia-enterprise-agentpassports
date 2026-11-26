/* The review screen, /review/?candidate=<uuid> (E4 design 4.1, 4.2 and 3.4).

   Order of calls. GET /api/me; an administrator without a verified factor is moved to /mfa/ before anything else is
   requested. Then the review read: its 404 is the not-found state, the same for an unknown, foreign, malformed or no
   longer permitted id, and its E_READ_OVER_BOUND is the server's message with this page's incomplete-review sentence
   (E4S-F11). Then the company's member list, for labels. Every write is followed by all three again.

   Top to bottom, 4.1's order: (1) agent, version and state, with the banners the read can show; (2) the boundary
   sentence, fixed text above every action and never collapsible; (3) the passport (passport-view.mjs); (4) the
   contributors and the viewer's verdict; (5) the agent's history; (6) the envelopes, newest first; (7) the actions,
   each shown only where a viewer hint allows and each decided by the server.

   Writes. Each press composes a new attempt with its own Idempotency-Key (api.mjs writeAttempt), and the retry button
   of its failure sends the same key, so a retry after a lost answer shows the stored answer as success; existing true
   reads "already proposed" or "already published". The sign-off is read once, at the press, and held from the press to
   the answer: the reason read-only, the role and envelope choices and both buttons held. Its Retry sends that press
   again under its key only while the form is unchanged; once it differs, Retry sends nothing and says so, and a press
   composes a new attempt (INF-N3). The reload action reads the page again and shows the server's
   message above it; not found discards the page. An approval refused E_GATE_FAILS_NOW or E_DERIVED_CHANGED shows the
   message and points to requesting changes. A proposal refused E_ASSEMBLY_TOO_LARGE shows the bound, the passport's
   own size and how many placeholders take the installation text, because the refusal carries no projected size. */

import { me, members, proposeEnvelope, publishRelease, recordReview, review, sendAdminsToEnrolment, signOutHere, writeAttempt } from '../api.mjs';
import { add, button, el, fill, form, isolated } from '../dom.mjs';
import { companyLinks, dateLine, failureView, heading, keepFresh, link, loading, notice, renderHeader, renderPlainHeader, showPageState, startPage, statusRegion } from '../shell.mjs';
import { ASSEMBLED_BYTES_MAX, attestationView, audienceNode, BOUNDARY, bytesText, candidateStateName, contentPane, derivedView, envelopeCard, labelsOf, lossesTable, memberLabel, needsTable, releaseTarget, reviewRoleName, reviewTarget, submissionView, targetName, unavailableView } from '../passport-view.mjs';

const { header, main } = startPage();
const candidateId = new URLSearchParams(location.search).get('candidate');
/* The installer placeholder of passport format 0.1, counted for the size sentence only. */
const PLACEHOLDER = '<!-- installer core and branches inserted on upload -->';
const INCOMPLETE =
  'This review cannot be shown in full: the agent has more records than this page reads, so the page shows none of them rather than part.';
const KINDS = {
  author: 'Author',
  editor: 'Editor',
  submitter: 'Submitter',
  declared_member: 'Declared contributor',
  declared_offline: 'Declared by name',
};
const LISTED_AS = { author: 'author', editor: 'editor', submitter: 'submitter', declared_member: 'a declared contributor' };
/* What the page says when the Retry of a sign-off would send an earlier form (INF-N3). */
const SIGN_OFF_CHANGED =
  'The form changed after this sign-off failed, so Retry would send the earlier reason and choices. Nothing was sent. Press Approve or Request changes again to sign with the form as it is now; if the earlier sign-off was stored, the service answers that you have already signed.';

let identity = null;
let flash = null;

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

function discard() {
  flash = null;
  fill(main, unavailableView('review'));
}

/* An answer to a write: not found discards the page, maintenance replaces it, reload reads the page again with the
   message above it, anything else shows beside the action. */
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

function option(type, name, value, label, { id, checked = false }) {
  const input = el('input', { type, name, id, value, checked });
  return { input, wrap: el('div', { class: 'option' }, input, el('label', { for: id }, label)) };
}
const pickedOne = (options) => options.find((o) => o.input.checked)?.input.value;
const pickedAll = (options) => options.filter((o) => o.input.checked).map((o) => o.input.value);

function verdictText(viewer) {
  if (viewer.excluded)
    return `You cannot sign off: you are listed as ${viewer.exclusionKinds.map((k) => LISTED_AS[k] ?? k).join(' and ')}`;
  const roles = [...new Set([...viewer.mayApproveAs, ...viewer.mayRequestChangesAs])];
  if (roles.length) return `You may sign off as ${roles.map((r) => `${reviewRoleName(r)} reviewer`).join(' or ')}`;
  const holds = viewer.roles.includes('it_reviewer') || viewer.roles.includes('business_reviewer');
  return holds ? 'This version is not open for sign-off' : 'You hold no reviewer role';
}

/* ---------- (1) the head ---------- */

function banner(state, ...content) {
  return el('div', { class: 'notice', role: 'status', 'data-state': state }, el('p', {}, ...content));
}

function banners(data, labels, reviewsById) {
  const { candidate, agentHistory } = data;
  const out = [];
  if (candidate.gateStatus === 'stale')
    out.push(
      banner('gate-stale', 'The content checks changed after this version was submitted; it can still be reviewed if the current checks pass it.'),
    );
  if (Number.isInteger(agentHistory.newestPublishedSequence) && agentHistory.newestPublishedSequence > candidate.sequence)
    out.push(banner('newer-published', `A newer version of this agent is published: version ${agentHistory.newestPublishedSequence}.`));
  if (candidate.state === 'changes_requested') {
    const requests = data.reviews.filter((x) => x.decision === 'changes_requested');
    out.push(
      el(
        'div',
        { class: 'notice', role: 'status', 'data-state': 'changes-requested' },
        el('p', {}, 'Changes were requested on this version. It is closed to approval; its author answers with a new version.'),
        el(
          'ul',
          { class: 'lines', 'data-role': 'change-reasons' },
          requests.map((x) =>
            el(
              'li',
              {},
              `${reviewRoleName(x.role)} reviewer `,
              memberLabel(labels, x.reviewerMembershipId),
              dateLine(' on ', x.createdAt),
              ': ',
              isolated(reviewsById.get(x.reviewId)?.reason ?? ''),
            ),
          ),
        ),
      ),
    );
  }
  if (candidate.state === 'superseded')
    out.push(banner('superseded', 'A later version of this agent took the place of this one. It can no longer be reviewed or published.'));
  if (candidate.state === 'approved')
    out.push(banner('approved', 'Both review roles approved an envelope of this version. It can be published for that envelope.'));
  return out;
}

/* ---------- (4) and (5) ---------- */

function contributorsSection(data, labels) {
  const sequenceOf = new Map(data.agentHistory.candidates.map((v) => [v.candidateId, v.sequence]));
  const rows = data.contributors.map((c) =>
    el(
      'li',
      { 'data-kind': c.kind, 'data-inherited': c.inheritedFromCandidateId ? 'yes' : 'no' },
      el('span', { class: 'kind' }, KINDS[c.kind] ?? c.kind),
      ': ',
      c.membershipId
        ? memberLabel(labels, c.membershipId)
        : [
            isolated(String(c.displayName ?? '')),
            el('span', { class: 'meta', 'data-role': 'unverified' }, ' · Unverified declaration: not a member of this company in Phaeacia'),
          ],
      c.inheritedFromCandidateId
        ? el(
            'span',
            { class: 'meta', 'data-role': 'inherited' },
            sequenceOf.has(c.inheritedFromCandidateId)
              ? ` · from version ${sequenceOf.get(c.inheritedFromCandidateId)}`
              : ' · from an earlier version',
          )
        : null,
    ),
  );
  return el(
    'section',
    { 'data-role': 'contributors' },
    el('h2', {}, `Contributors (${rows.length})`),
    rows.length ? el('ul', { class: 'lines' }, rows) : el('p', { class: 'meta' }, 'No contributor is recorded.'),
    el('p', { class: 'verdict', 'data-role': 'verdict', 'data-excluded': data.viewer.excluded ? 'yes' : 'no' }, verdictText(data.viewer)),
  );
}

/* Attribution across versions (Q5 as answered 2026-09-15): who built each version stays visible here, and nobody listed
   here is excluded for that reason; the verdict of (4) is computed over this version's own contributors. */
function historySection(data, labels) {
  const h = data.agentHistory;
  const contributors = Array.isArray(h.contributorMembershipIds) ? h.contributorMembershipIds : [];
  return el(
    'section',
    { 'data-role': 'history' },
    el('h2', {}, 'Agent history'),
    el('p', {}, 'Earlier versions of this agent and who contributed to them.'),
    el(
      'ul',
      { class: 'lines' },
      h.candidates.map((v) =>
        el(
          'li',
          { 'data-candidate': v.candidateId },
          v.candidateId === data.candidate.candidateId
            ? el('strong', {}, `Version ${v.sequence}, this one`)
            : link(reviewTarget(v.candidateId), `Version ${v.sequence}`),
          ` · ${candidateStateName(v.state)} · author `,
          memberLabel(labels, v.authorMembershipId),
        ),
      ),
    ),
    h.olderCount > 0 ? el('p', { class: 'meta' }, `${h.olderCount} older version${h.olderCount === 1 ? '' : 's'} not listed.`) : null,
    el(
      'p',
      { class: 'meta', 'data-role': 'history-contributors' },
      'Listed as a contributor of a version of this agent: ',
      contributors.length ? contributors.map((id, i) => [i ? ', ' : '', memberLabel(labels, id)]) : 'nobody',
      '.',
    ),
  );
}

/* ---------- (7) the actions ---------- */

function sizeLine(content, target) {
  const text = typeof content === 'string' ? content : '';
  const places = text.split(PLACEHOLDER).length - 1;
  return el(
    'p',
    { class: 'meta', 'data-role': 'assembly-size' },
    `The assembled installation may hold at most ${bytesText(ASSEMBLED_BYTES_MAX)}. This passport alone is ${bytesText(new TextEncoder().encode(text).length)}, and the installation text for ${targetName(target)} is inserted at each of its ${places} placeholder${places === 1 ? '' : 's'}.`,
  );
}

function proposeSection(data) {
  const { candidate, options } = data;
  const first = options.targets.find((t) => t.publishable)?.target ?? options.targets[0]?.target;
  const targets = options.targets.map((t) =>
    option('radio', 'target', t.target, [targetName(t.target), t.publishable ? null : el('span', { class: 'meta' }, ', publishing not enabled yet')], {
      id: `target-${t.target}`,
      checked: t.target === first,
    }),
  );
  const groups = options.groups.map((g) =>
    option('checkbox', 'audience', g.groupId, [isolated(g.name), el('span', { class: 'meta' }, ` (${g.memberCount} member${g.memberCount === 1 ? '' : 's'})`)], {
      id: `audience-${g.groupId}`,
    }),
  );
  const status = statusRegion('propose-status');
  const submit = el('button', { type: 'submit', 'data-role': 'propose' }, 'Propose');
  const run = async (attempt, target) => {
    submit.disabled = true;
    fill(status);
    const r = await attempt();
    submit.disabled = false;
    if (r.action === 'navigating') return;
    if (r.ok) {
      const revision = r.data.envelope.revision;
      flash = success(r.data.existing ? `Already proposed: the same envelope is revision ${revision}.` : `Proposed as revision ${revision}.`, r.data.existing ? 'already-proposed' : 'proposed', r.data);
      return load();
    }
    settle(r, status, () => run(attempt, target));
    if (r.code === 'E_ASSEMBLY_TOO_LARGE') add(status, [sizeLine(candidate.content, target)]);
  };
  return el(
    'section',
    { class: 'panel', 'data-role': 'propose-section' },
    el('h3', {}, 'Propose an envelope'),
    el('p', { class: 'meta' }, 'An envelope binds this version to one target, its audience groups and the release policy. Both review roles approve one envelope.'),
    form(
      { class: 'stack', 'data-role': 'propose-form' },
      () => {
        const target = pickedOne(targets);
        const body = { target, audienceGroupIds: pickedAll(groups), policyId: options.policy?.policyId ?? null };
        return run(writeAttempt((key) => proposeEnvelope(candidate.candidateId, body, key)), target);
      },
      el('fieldset', { class: 'choice', 'data-role': 'target-choice' }, el('legend', {}, 'Target'), targets.map((t) => t.wrap)),
      el(
        'fieldset',
        { class: 'choice', 'data-role': 'audience-choice' },
        el('legend', {}, 'Audience groups'),
        groups.length ? groups.map((g) => g.wrap) : el('p', { class: 'meta' }, 'This company has no audience group yet.'),
      ),
      options.groupsTruncated ? notice('This group list is incomplete: the company has more groups or group members than this page shows.', 'truncated') : null,
      el('p', { class: 'meta', 'data-role': 'policy' }, options.policy ? `Release policy version ${options.policy.version}, fixed.` : 'No release policy is active.'),
      submit,
      status,
    ),
  );
}

function signedText(result, decision) {
  if (decision !== 'approved') return 'Changes requested. The reason is shown with this review.';
  return result.envelopeStatus === 'approved'
    ? 'Approved. Both review roles have now approved this envelope.'
    : 'Approved. The other review role has not approved this envelope yet.';
}

function signOffSection(data) {
  const { candidate, viewer, envelopes } = data;
  const roles = [...new Set([...viewer.mayApproveAs, ...viewer.mayRequestChangesAs])];
  const roleOptions = roles.map((role, i) => option('radio', 'role', role, `${reviewRoleName(role)} reviewer`, { id: `role-${role}`, checked: i === 0 }));
  const open = envelopes.filter((e) => e.status === 'open');
  const envelopeOptions = open.map((e, i) =>
    option('radio', 'envelope', e.envelopeId, `${targetName(e.target)}, revision ${e.revision}`, { id: `envelope-${e.envelopeId}`, checked: i === 0 }),
  );
  if (candidate.state === 'submitted')
    envelopeOptions.push(option('radio', 'envelope', '', 'The whole version, for a change request', { id: 'envelope-none', checked: open.length === 0 }));
  const reason = el('textarea', { id: 'review-reason', name: 'review-reason', spellcheck: 'true', 'data-role': 'reason' });
  const status = statusRegion('sign-off-status');
  const approve = open.length ? button('Approve', () => send('approved'), { 'data-role': 'approve' }) : null;
  const requestChanges = envelopeOptions.length
    ? button('Request changes', () => send('changes_requested'), { class: 'secondary', 'data-role': 'request-changes' })
    : null;
  /* The body a press sends, from what the form holds now. */
  const bodyOf = (decision) => {
    const chosen = pickedOne(envelopeOptions);
    return { envelopeId: chosen ? chosen : null, role: pickedOne(roleOptions), decision, reason: reason.value };
  };
  /* From the press to the answer, so nothing typed or chosen then is replaced by the page the answer draws. */
  const hold = (on) => {
    reason.readOnly = on;
    for (const o of [...roleOptions, ...envelopeOptions]) o.input.disabled = on;
    for (const b of [approve, requestChanges]) if (b) b.disabled = on;
  };
  const run = async (attempt, body) => {
    const { decision } = body;
    hold(true);
    fill(status);
    const r = await attempt();
    hold(false);
    if (r.action === 'navigating') return;
    if (r.ok) {
      flash = success(signedText(r.data, decision), 'signed', r.data);
      return load();
    }
    const retry = () =>
      JSON.stringify(bodyOf(decision)) === JSON.stringify(body)
        ? run(attempt, body)
        : fill(status, el('p', { class: 'notice', role: 'status', 'data-state': 'sign-off-changed' }, SIGN_OFF_CHANGED));
    settle(r, status, retry);
    if (decision === 'approved' && (r.code === 'E_GATE_FAILS_NOW' || r.code === 'E_DERIVED_CHANGED'))
      add(status, [
        el(
          'div',
          { 'data-role': 'point-to-changes' },
          el('p', {}, 'This version cannot be approved as it is stored. You can still request changes, with your reason.'),
          button('Request changes instead', () => send('changes_requested'), { class: 'secondary', 'data-role': 'request-changes-instead' }),
        ),
      ]);
  };
  const send = (decision) => {
    const body = bodyOf(decision);
    return run(writeAttempt((key) => recordReview(candidate.candidateId, body, key)), body);
  };
  return el(
    'section',
    { class: 'panel', 'data-role': 'sign-off' },
    el('h3', {}, 'Sign off'),
    el('fieldset', { class: 'choice', 'data-role': 'role-choice' }, el('legend', {}, 'Sign as'), roleOptions.map((o) => o.wrap)),
    el(
      'fieldset',
      { class: 'choice', 'data-role': 'envelope-choice' },
      el('legend', {}, 'Envelope'),
      envelopeOptions.length ? envelopeOptions.map((o) => o.wrap) : el('p', { class: 'meta' }, 'No envelope of this version is open.'),
    ),
    el('div', { class: 'field' }, el('label', { for: 'review-reason' }, 'Reason, shown to everyone who reads this review'), reason),
    el('div', { class: 'actions' }, approve, requestChanges),
    status,
  );
}

function publishedNotice(result) {
  const count = result.superseded?.releaseIds?.length ?? 0;
  const node = el(
    'div',
    { class: 'notice confirm', role: 'status', 'data-state': result.existing ? 'already-published' : 'published' },
    el(
      'p',
      {},
      result.existing ? 'Already published: this envelope has a current release.' : 'Published.',
      count ? ` It takes the place of ${count} earlier release${count === 1 ? '' : 's'}.` : '',
    ),
    link(releaseTarget(result.release.releaseId), 'Open the release', { 'data-role': 'release-link' }),
  );
  if (result.idempotentReplay === true) node.setAttribute('data-replay', 'true');
  return node;
}

function publishSection(data, envelope, groupsById) {
  const status = statusRegion('publish-status');
  const tools = el('div', { class: 'actions' });
  const run = async (attempt) => {
    fill(status);
    const r = await attempt();
    if (r.action === 'navigating') return;
    if (r.ok) {
      flash = publishedNotice(r.data);
      return load();
    }
    settle(r, status, () => run(attempt));
  };
  const show = () => fill(tools, button('Publish', ask, { 'data-role': 'publish' }));
  const ask = () =>
    fill(
      tools,
      el(
        'div',
        { class: 'confirm-box', 'data-role': 'confirm-publish' },
        el(
          'p',
          {},
          `Publish version ${data.candidate.sequence} of `,
          isolated(data.agentHistory.agentName ?? 'this agent'),
          ` for ${targetName(envelope.target)} to `,
          audienceNode(envelope.audience?.groupIds, groupsById),
          '?',
        ),
        el(
          'div',
          { class: 'actions' },
          button('Confirm publication', () => run(writeAttempt((key) => publishRelease(data.candidate.candidateId, envelope.envelopeId, key))), {
            'data-role': 'confirm-publication',
          }),
          button('Cancel', show, { class: 'quiet', 'data-role': 'cancel' }),
        ),
      ),
    );
  show();
  return el(
    'section',
    { class: 'panel', 'data-role': 'publish-section', 'data-envelope': envelope.envelopeId },
    el('h3', {}, `Publish for ${targetName(envelope.target)}`),
    el('p', { class: 'meta' }, `Envelope revision ${envelope.revision}, approved by both review roles.`),
    tools,
    status,
  );
}

function actionsSection(data, groupsById) {
  const { viewer } = data;
  const parts = [];
  if (viewer.mayProposeEnvelope) parts.push(proposeSection(data));
  if (viewer.mayApproveAs.length || viewer.mayRequestChangesAs.length) parts.push(signOffSection(data));
  const current = new Set(data.releases.filter((r) => r.current).map((r) => r.envelopeId));
  const ready = data.envelopes.filter((e) => e.status === 'approved' && !current.has(e.envelopeId));
  if (ready.length && viewer.mayPublish) parts.push(...ready.map((e) => publishSection(data, e, groupsById)));
  else if (ready.length && viewer.roles.includes('company_admin'))
    parts.push(
      el(
        'section',
        { class: 'panel', 'data-role': 'publish-step-up' },
        el('h3', {}, 'Publish'),
        el('p', {}, 'Publishing needs a session verified with your second factor.'),
        link('/mfa/', 'Verify with your second factor', { class: 'button', 'data-role': 'mfa-link' }),
      ),
    );
  return el(
    'section',
    { 'data-role': 'actions' },
    el('h2', {}, 'Actions'),
    parts.length ? parts : el('p', { class: 'meta', 'data-role': 'no-action' }, 'No action on this version is open to you.'),
  );
}

/* ---------- the page ---------- */

function render(data, labels) {
  const { candidate } = data;
  const shown = flash;
  flash = null;
  const groupsById = new Map((data.options?.groups ?? []).map((g) => [g.groupId, { name: g.name, memberCount: g.memberCount }]));
  const reviewsById = new Map(data.reviews.map((x) => [x.reviewId, x]));
  fill(
    main,
    shown,
    el(
      'section',
      { 'data-role': 'candidate-head', 'data-state': candidate.state },
      heading(isolated(data.agentHistory.agentName ?? 'Agent'), `Version ${candidate.sequence} · ${candidateStateName(candidate.state)}`),
      banners(data, labels, reviewsById),
    ),
    el('p', { class: 'boundary', 'data-role': 'boundary' }, BOUNDARY),
    el(
      'div',
      { class: 'toolbar-row' },
      companyLinks(candidate.companyId, null),
      button('Reload', load, { class: 'secondary', 'data-role': 'reload' }),
    ),
    el(
      'section',
      { class: 'packet', 'data-role': 'passport' },
      el('h2', {}, 'The passport'),
      derivedView(candidate.derived),
      needsTable(candidate.derived?.needs),
      lossesTable(data.losses),
      submissionView(candidate),
      attestationView(candidate, labels),
      contentPane(candidate.content),
    ),
    contributorsSection(data, labels),
    historySection(data, labels),
    el(
      'section',
      { 'data-role': 'envelopes' },
      el('h2', {}, `Envelopes (${data.envelopes.length})`),
      data.envelopes.length
        ? el('ul', { class: 'cards' }, data.envelopes.map((e) => envelopeCard(e, { labels, groupsById, reviewsById, releases: data.releases })))
        : el('p', { class: 'meta' }, 'No envelope has been proposed for this version.'),
    ),
    actionsSection(data, groupsById),
  );
}

function refusedRead(r) {
  if (r.action === 'not-found') return discard();
  if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
  const shown = flash;
  flash = null;
  fill(
    main,
    shown,
    heading('Review'),
    failureView(r, { retry: load }),
    r.code === 'E_READ_OVER_BOUND' ? notice(INCOMPLETE, 'truncated') : null,
  );
}

async function load() {
  fill(main, loading('Loading the review.'));
  const m = await me();
  if (m.action === 'navigating') return;
  if (!m.ok) return showPageState(header, main, failureView(m, { retry: load }));
  const enrolment = await sendAdminsToEnrolment(m.data);
  if (enrolment.moved || enrolment.answer?.action === 'navigating') return;
  if (enrolment.answer) return showPageState(header, main, failureView(enrolment.answer, { retry: load }));
  identity = m.data;
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
  if (list.action === 'maintenance') return showPageState(header, main, failureView(list, { retry: load }));
  if (!list.ok) return fill(main, heading('Review'), failureView(list, { retry: load }));
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
