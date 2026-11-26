/* The members page, /members/?company=<uuid> (pages design sections 1, 2.2, 2.3 and 2.5).

   Order of calls. GET /api/me first; an administrator without a verified factor is moved to /mfa/ before any company
   data is requested. Then the member list, and the invitation list only when this company's membership holds
   company_admin and the session is aal2; nobody else sends that request. "Reload" sends the identity, the member list
   and, when due, the invitation list together.

   What each viewer sees. An administrator at aal2: members with roles, status and dates, "Change roles" and "Remove"
   with an in-page confirmation for active members, former members, the invite form, and invitations grouped pending,
   accepted, revoked and expired, with "Revoke" and "Invite again". An administrator at aal1: the same list read-only
   and one panel linking to /mfa/. A member without the administrator role: their own roles and the list read-only.
   The page renders the labels the answer carries and nothing about a label it did not carry; the line about addresses
   appears only when viewer.mayReadLabels is true and the session is not aal2, the one case in which stepping up would
   show addresses (2.2). Names are placed in bdi elements.

   Not found. Any company answer of 404 replaces the page body with the not-found state and discards the data already
   shown, so a member removed while the page is open stops seeing the list at their next action.

   What E6 adds (design 4.1 items 1 to 5, 1.2, 1.3, 1.4 and 1.7; E6D-C-F16). Every control is server-decided: it is
   rendered only where the answer that fed the page says the caller may act, and pressing it is refused again.
     - Remove reads the departure preview first and shows its counts as What stops and What stays, in the sentences
       lifecycle-view.mjs builds from lib/rules/lifecycle.mjs's consequences; the last administrator gets the reason and
       no Remove button. Each owned agent carries Transfer, a choice of the other active members of the page's own list,
       with expectedOwnerMembershipId the preview's membership, which is the owner the page last read; a refusal whose
       action is reload (E_OWNER_CHANGED) reads the page again.
     - A former member's card offers "What they left", the same preview for a removed membership, whose owned agents
       are the orphans only a transfer brings back (1.3), each with Transfer.
     - "Agents you own", for an administrator at aal2, is their own preview's agent list (E6P-D2: no route answers a
       plain member's own agents, so nobody else gets the block).
     - Resend on each pending, revoked or expired invitation, after design 1.2's fixed sentence; the invite form's and
       the resend's handover answers show the accept link once, read-only, never as a link, for this page's life only.
     - The quota lines from GET /api/companies/{id}/quotas, which only an administrator at aal2 may read (E6S-C-F5): the
       people and open-invitation values with their usage and the server's own `near` warning. At aal1 the line says
       it needs the second factor rather than showing a default.
     - Export, for an administrator at aal2 of a company whose window is open: the company's own copy saved as a file
       through save-file.mjs, and what it left out said beside it. */

import { departure, invitations, invite, me, members, quotas, removeMember, resendInvitation, revokeInvitation, sendAdminsToEnrolment, setRoles, signOutHere, takeout, transferAgent } from '../api.mjs';
import { add, button, el, field, fill, form, isolated } from '../dom.mjs';
import { acceptLinkBlock, departureSentences, inviteLinkNote, LIFECYCLE_TEXT, mayTakeCopy, nearSentence, quotaLabel, quotaUsage, takeoutFileName, takeoutNotice, takeoutText } from '../lifecycle-view.mjs';
import { companyParam } from '../params.mjs';
import { nameSafe, saveBytes } from '../save-file.mjs';
import { companyLinks, dateLine, failureView, heading, keepFresh, link, loading, notFoundView, notice, renderHeader, renderPlainHeader, roleName, roleNames, showPageState, startPage, statusRegion } from '../shell.mjs';

const { header, main } = startPage();
const companyId = companyParam();
let view = null;
let inviteForm = null;
let flash = null;
/* A notice for the top of the page: a transfer's answer, or a refusal whose action is reload (E6). `flash` above stays
   the invite form's, as E2 placed it. */
let pageFlash = null;
/* The answer that made the last invitation or resend, for this page's life only (design 1.2 rule 1): its accept link is
   shown once, beside the invite form, and dropped on pagehide. */
let handover = null;

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

function discard() {
  view = null;
  inviteForm = null;
  handover = null;
  fill(main, notFoundView());
}

/* An answer to an action: not found discards the page, maintenance replaces it, anything else shows beside the action. */
function settle(r, status, retry) {
  if (r.action === 'navigating') return;
  if (r.action === 'not-found') return discard();
  if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
  if (r.action === 'reload') {
    pageFlash = failureView(r);
    return reload();
  }
  fill(status, failureView(r, { retry }));
}

const membershipOf = (identity) => identity.memberships.find((m) => m.companyId === companyId) ?? null;
const wantsInvitations = (identity) => {
  const m = membershipOf(identity);
  return Boolean(m?.roles.includes('company_admin') && identity.user.aal === 'aal2');
};

function labelNode(label) {
  if (label?.kind === 'self')
    return el('span', { class: 'label', 'data-label': 'self' }, isolated(label.value), ' ', el('span', { class: 'tag' }, 'you'));
  if (label?.kind === 'display_name') return el('span', { class: 'label', 'data-label': 'display_name' }, isolated(label.value));
  if (label?.kind === 'invitation_email') return el('span', { class: 'label', 'data-label': 'invitation_email' }, isolated(label.value));
  return el('span', { class: 'label muted', 'data-label': 'none' }, 'No name set');
}

function checkboxes(prefix, roles, checked) {
  return roles.map((role) => {
    const id = `${prefix}-${role}`;
    const input = el('input', { type: 'checkbox', id, value: role, checked: checked.includes(role), disabled: role === 'member' });
    return { role, input, wrap: el('div', { class: 'option' }, input, el('label', { for: id }, roleName(role))) };
  });
}

function memberCard(row, manage, assignable) {
  const status = statusRegion('row-status');
  const tools = el('div', { class: 'tools' });
  const showTools = () => {
    if (manage && row.status !== 'active')
      return fill(tools, button('What they left', leftBehind, { class: 'secondary', 'data-role': 'left-behind' }));
    if (!manage || row.status !== 'active') return fill(tools);
    fill(
      tools,
      button('Change roles', editRoles, { class: 'secondary', 'data-role': 'change-roles' }),
      button('Remove', askRemoval, { class: 'secondary danger', 'data-role': 'remove' }),
    );
  };
  const editRoles = () => {
    const boxes = checkboxes(`role-${row.membershipId}`, assignable, row.roles);
    const save = async () => {
      fill(status);
      const roles = boxes.filter((b) => b.input.checked && b.role !== 'member').map((b) => b.role);
      const r = await setRoles(companyId, row.membershipId, roles);
      if (r.ok) return reload();
      settle(r, status, save);
    };
    fill(
      tools,
      el('fieldset', { class: 'choice', 'data-role': 'roles-editor' }, el('legend', {}, 'Roles'), boxes.map((b) => b.wrap)),
      el(
        'div',
        { class: 'actions' },
        button('Save roles', save, { 'data-role': 'save-roles' }),
        button('Cancel', () => {
          fill(status);
          showTools();
        }, { class: 'quiet', 'data-role': 'cancel' }),
      ),
    );
  };
  const askRemoval = async (done = null) => {
    fill(status);
    const preview = await departure(companyId, row.membershipId);
    if (preview.action === 'navigating') return;
    if (!preview.ok) return settle(preview, status, askRemoval);
    const remove = async () => {
      fill(status);
      const r = await removeMember(companyId, row.membershipId);
      if (r.ok) return reload();
      settle(r, status, remove);
    };
    const p = preview.data;
    fill(
      tools,
      el(
        'div',
        { class: 'confirm-box', 'data-role': 'confirm-remove' },
        done instanceof Node ? done : null,
        el('p', {}, 'Remove ', row.label?.kind === 'none' ? 'this member' : isolated(row.label.value), ' from this company? The membership moves to former members.'),
        departureView(p, row.membershipId, askRemoval),
        el(
          'div',
          { class: 'actions' },
          p.isLastAdmin === true ? null : button('Confirm removal', remove, { class: 'danger', 'data-role': 'confirm-removal' }),
          button('Cancel', showTools, { class: 'quiet', 'data-role': 'cancel' }),
        ),
      ),
    );
  };
  /* A former member's preview: what they still own, which is what only a transfer brings back (design 1.3). */
  const leftBehind = async (done = null) => {
    fill(status);
    const preview = await departure(companyId, row.membershipId);
    if (preview.action === 'navigating') return;
    if (!preview.ok) return settle(preview, status, leftBehind);
    const agents = Array.isArray(preview.data.ownedAgents) ? preview.data.ownedAgents : [];
    fill(
      tools,
      el(
        'div',
        { class: 'confirm-box', 'data-role': 'left-behind-box' },
        done instanceof Node ? done : null,
        el('p', { class: 'meta' }, agents.length ? LIFECYCLE_TEXT.leftBehindLead : LIFECYCLE_TEXT.leftNothing),
        agents.length ? ownedAgentsList(agents, preview.data.membershipId, leftBehind) : null,
        el('div', { class: 'actions' }, button('Close', showTools, { class: 'quiet', 'data-role': 'cancel' })),
      ),
    );
  };
  showTools();
  return el(
    'li',
    { class: 'card member', 'data-membership': row.membershipId, 'data-status': row.status },
    el('div', { class: 'card-head' }, labelNode(row.label)),
    el('p', { class: 'meta' }, el('span', { 'data-role': 'roles' }, roleNames(row.roles)), dateLine(' · Joined ', row.createdAt), dateLine(' · Removed ', row.removedAt)),
    tools,
    status,
  );
}

/* ---------- E6: the departure preview, the transfer, the quota lines and Export ---------- */

/* The preview's two lists, with the counts that make them concrete (design 1.4). The page owns the sentences; which
   ones a preview earns is lib/rules/lifecycle.mjs's rule, copied and pinned in lifecycle-view.mjs. */
function departureView(p, subjectId, refresh) {
  const { stops, stays } = departureSentences(p);
  const agents = Array.isArray(p.ownedAgents) ? p.ownedAgents : [];
  return el(
    'div',
    { class: 'departure', 'data-role': 'departure', 'data-last-admin': p.isLastAdmin === true ? 'yes' : 'no' },
    el('p', { class: 'meta' }, LIFECYCLE_TEXT.departureLead),
    el('h3', {}, 'What stops'),
    el('ul', { class: 'lines', 'data-role': 'what-stops' }, stops.map((x) => el('li', { 'data-kind': x.kind }, x.text))),
    agents.length
      ? el('div', { 'data-role': 'owned-agents' }, el('p', {}, LIFECYCLE_TEXT.transferFirst), ownedAgentsList(agents, subjectId, refresh))
      : null,
    el('h3', {}, 'What stays'),
    el('ul', { class: 'lines', 'data-role': 'what-stays' }, stays.map((x) => el('li', { 'data-kind': x.kind }, x.text))),
  );
}

/* Each agent a preview says this membership owns, with Transfer. The chooser is the page's own list of the company's
   other active members; expectedOwnerMembershipId is the membership whose preview named the agent, the owner this page
   last read, and it is a stale-retry guard for the server, never authority (E6D-C-F2). After a transfer the preview is
   read again through refresh(done), which shows the agent gone from the list and the answer's notice above it. */
function ownedAgentsList(agents, ownerId, refresh) {
  return el(
    'ul',
    { class: 'cards' },
    agents.map((a) => {
      const status = statusRegion('transfer-status');
      const tools = el('div', { class: 'tools' });
      const candidates = (view?.list.members ?? []).filter((m) => m.status === 'active' && m.membershipId !== ownerId);
      const choose = () => {
        if (candidates.length === 0) return fill(tools, el('p', { class: 'meta', 'data-role': 'no-other-member' }, LIFECYCLE_TEXT.noOtherMember));
        const options = candidates.map((m, i) => {
          const id = `to-${a.agentId}-${m.membershipId}`;
          const input = el('input', { type: 'radio', name: `to-${a.agentId}`, id, value: m.membershipId, checked: i === 0 });
          return { input, wrap: el('div', { class: 'option' }, input, el('label', { for: id }, labelNode(m.label), el('span', { class: 'meta' }, ` · ${roleNames(m.roles)}`))) };
        });
        const send = async () => {
          fill(status);
          const to = options.find((o) => o.input.checked)?.input.value;
          const r = await transferAgent(a.agentId, { toMembershipId: to, expectedOwnerMembershipId: ownerId });
          if (r.action === 'navigating') return;
          if (r.ok) {
            const done = notice(r.data.changed === false ? 'Nothing changed: that member already owns it.' : 'Transferred. The agent works again under its new owner.', 'transferred');
            return refresh(done);
          }
          settle(r, status, send);
        };
        fill(
          tools,
          el('fieldset', { class: 'choice scroll', 'data-role': 'transfer-choice' }, el('legend', {}, 'Give it to'), options.map((o) => o.wrap)),
          el(
            'div',
            { class: 'actions' },
            button('Transfer now', send, { 'data-role': 'confirm-transfer' }),
            button('Cancel', rest, { class: 'quiet', 'data-role': 'cancel-transfer' }),
          ),
        );
      };
      const rest = () => fill(tools, a.status === 'archived' ? null : button('Transfer this agent', choose, { class: 'secondary', 'data-role': 'transfer' }));
      rest();
      return el(
        'li',
        { class: 'card', 'data-agent': a.agentId, 'data-agent-status': a.status },
        el('div', { class: 'card-head' }, isolated(String(a.name ?? '')), el('span', { class: 'tag' }, a.status === 'orphaned' ? 'No owner' : String(a.status))),
        el('p', { class: 'meta' }, `Current releases: ${a.currentReleases ?? 0}. Members in their audience: ${a.recipients ?? 0}.`),
        tools,
        status,
      );
    }),
  );
}

/* "Agents you own", for an administrator at aal2: their own preview's agent list. Read on request, because it costs the
   preview's three reads and most visits do not need it. */
function ownAgentsSection(viewer) {
  const status = statusRegion('own-agents-status');
  const box = el('div', { 'data-role': 'own-agents-list' });
  const show = async (done = null) => {
    fill(status);
    const r = await departure(companyId, viewer.membershipId);
    if (r.action === 'navigating') return;
    if (!r.ok) return settle(r, status, show);
    const agents = Array.isArray(r.data.ownedAgents) ? r.data.ownedAgents : [];
    fill(box, done instanceof Node ? done : null, agents.length ? [el('p', { class: 'meta' }, LIFECYCLE_TEXT.ownedLead), ownedAgentsList(agents, viewer.membershipId, show)] : el('p', { class: 'meta' }, LIFECYCLE_TEXT.ownedNone));
  };
  fill(box, button('Show the agents you own', show, { class: 'secondary', 'data-role': 'show-own-agents' }));
  return el('section', { 'data-role': 'own-agents' }, el('h2', {}, 'Agents you own'), box, status);
}

/* The quota lines of design 4.1 item 4, from the server's own read and its own `near` flag. */
function quotaLines(answer, aal) {
  if (aal !== 'aal2') return el('p', { class: 'meta', 'data-role': 'quota-needs-factor' }, LIFECYCLE_TEXT.quotaNeedsFactor);
  if (!answer) return null;
  if (!answer.ok) return el('div', { 'data-role': 'quota-lines' }, failureView(answer, { retry: reload }));
  const list = (answer.data.quotas ?? []).filter((q) => q.name === 'members_per_company' || q.name === 'pending_invitations_per_company');
  return el(
    'div',
    { class: 'panel', 'data-role': 'quota-lines' },
    list.map((q) =>
      el(
        'div',
        { 'data-quota': q.name, 'data-near': q.near === true ? 'yes' : 'no' },
        el('p', {}, `${quotaLabel(q.name)}: `, el('span', { 'data-role': 'quota-usage' }, quotaUsage(q))),
        q.near === true ? el('p', { class: 'notice', role: 'status', 'data-state': 'quota-near' }, nearSentence(q.name)) : null,
      ),
    ),
  );
}

/* Export (E6D-C-F16): the company's own copy, for an administrator at aal2 of a company whose window is open. The
   answer is saved through save-file.mjs; the takeout routine tests the window and the caller again. */
function takeoutSection(membership, aal) {
  const status = statusRegion('takeout-status');
  const run = async () => {
    fill(status);
    const r = await takeout(companyId);
    if (r.action === 'navigating') return;
    if (!r.ok) return settle(r, status, run);
    saveBytes(takeoutFileName(nameSafe, membership.companySlug, r.data.exportedAt), takeoutText(r.data), 'application/json');
    fill(status, takeoutNotice(r.data));
  };
  return el(
    'section',
    { class: 'panel', 'data-role': 'takeout' },
    el('h2', {}, 'Export'),
    mayTakeCopy(membership, aal)
      ? [el('p', {}, LIFECYCLE_TEXT.takeoutLead), button('Export', run, { 'data-role': 'takeout' })]
      : el('p', {}, LIFECYCLE_TEXT.takeoutNeedsFactor, ' ', link('/mfa/', 'Verify now', { 'data-role': 'takeout-mfa' })),
    status,
  );
}

function stepUpPanel(factorList) {
  const verified = factorList ? factorList.factors.some((f) => f.status === 'verified') : true;
  return el(
    'section',
    { class: 'panel', 'data-role': 'step-up-panel' },
    el('h2', {}, 'Administrator actions need your second factor'),
    el('p', {}, 'The member list below is read-only until this session is verified with a second factor.'),
    link('/mfa/', verified ? 'Verify with your second factor' : 'Set up a second factor to manage members', { class: 'button', 'data-role': 'mfa-link' }),
  );
}

function inviteSection(assignable) {
  const email = field({ label: 'Email address', id: 'invite-email', type: 'email', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const boxes = checkboxes('invite-role', assignable.filter((r) => r !== 'member'), []);
  const days = field({ label: 'Days until the invitation expires, 1 to 30', id: 'invite-days', type: 'number', min: 1, max: 30, step: 1, value: 7, inputmode: 'numeric' });
  const status = statusRegion('invite-status');
  if (flash) {
    fill(status, flash);
    flash = null;
  }
  const submit = el('button', { type: 'submit', 'data-role': 'send-invitation' }, 'Send invitation');
  const send = async () => {
    submit.disabled = true;
    fill(status);
    const r = await invite(companyId, {
      email: email.input.value,
      roles: boxes.filter((b) => b.input.checked).map((b) => b.role),
      expiresInDays: Number(days.input.value),
    });
    submit.disabled = false;
    if (r.ok) {
      handover = r.data;
      /* Three-way (E7 section 4 item 2): sent, not confirmed as sent (`failed` or `unconfirmed`, one sentence true of
         both), or made with its link on this page (handover). The not-confirmed one is built here rather than through
         notice(), which styles every state but `truncated` as a confirmation: a sentence that reports a delivery
         nobody can confirm must not be shown in the colour that means it worked. Its data-state stays `invited`, the
         one the pages and the journeys read. */
      const d = r.data.delivery;
      flash = Object.hasOwn(INVITED_FLASH, d)
        ? el('p', { class: `notice ${INVITED_FLASH[d].tone}`, role: 'status', 'data-state': 'invited' }, INVITED_FLASH[d].text)
        : notice('Invitation created.', 'invited');
      return reload();
    }
    settle(r, status, send);
  };
  inviteForm = { email, boxes };
  return el(
    'section',
    { 'data-role': 'invite' },
    el('h2', {}, 'Invite someone'),
    inviteLinkNote(handover),
    form(
      { class: 'stack', 'data-role': 'invite-form' },
      send,
      email.wrap,
      el('fieldset', { class: 'choice' }, el('legend', {}, 'Roles besides member'), boxes.map((b) => b.wrap)),
      days.wrap,
      submit,
      status,
    ),
    handover ? acceptLinkBlock(handover, { id: 'invite-accept-link' }) : null,
  );
}

const NOT_CONFIRMED = Object.freeze({ text: 'Invitation made; its mail could not be confirmed as sent.', tone: 'error' });
const INVITED_FLASH = Object.freeze({
  mail: Object.freeze({ text: 'Invitation sent.', tone: 'confirm' }),
  failed: NOT_CONFIRMED,
  unconfirmed: NOT_CONFIRMED,
});

function inviteAgain(invitation) {
  if (!inviteForm) return;
  inviteForm.email.input.value = invitation.email;
  for (const b of inviteForm.boxes) b.input.checked = invitation.roles.includes(b.role);
  inviteForm.email.input.focus();
}

/* What the row records about its delivery (E6 design 1.2.1, lane K4), on a pending card only: a resend or a revoke
   is what the line is for, and neither matters once the row is accepted, revoked or expired. The list answer carries
   `delivery` already read (lib/rules/invitations.mjs deliveryView): the stored word, `not_recorded` for a row no
   attempt recorded itself on and none can still be running, `in_progress` or null (a row older than the record) for
   nothing to say. One sentence for the three words that confirm nothing, because it is true of each: a failed send, a
   send whose answer was lost, and one whose record was lost all leave nobody able to say the invitation arrived. */
const NOTHING_CONFIRMS = 'Nothing confirms this invitation reached anyone. Resend makes a new link and stops any earlier one.';
const DELIVERY_LINES = Object.freeze({
  mail: Object.freeze({ text: 'Sent by mail.', warn: false }),
  handover: Object.freeze({ text: 'Its link was handed to whoever made it.', warn: false }),
  failed: Object.freeze({ text: NOTHING_CONFIRMS, warn: true }),
  unconfirmed: Object.freeze({ text: NOTHING_CONFIRMS, warn: true }),
  not_recorded: Object.freeze({ text: NOTHING_CONFIRMS, warn: true }),
});

function deliveryLine(invitation) {
  if (invitation.state !== 'pending' || !Object.hasOwn(DELIVERY_LINES, invitation.delivery)) return null;
  const line = DELIVERY_LINES[invitation.delivery];
  return el('p', { class: line.warn ? 'notice' : 'meta', 'data-role': 'delivery', 'data-delivery': invitation.delivery }, line.text);
}

const INVITATION_DATES = { pending: ' · Expires ', accepted: ' · Accepted ', revoked: ' · Revoked ', expired: ' · Expired ' };
const INVITATION_WHEN = { pending: 'expiresAt', accepted: 'acceptedAt', revoked: 'revokedAt', expired: 'expiresAt' };

function invitationCard(invitation) {
  const status = statusRegion('row-status');
  const revoke = async () => {
    fill(status);
    const r = await revokeInvitation(companyId, invitation.invitationId);
    if (r.ok) return reload();
    settle(r, status, revoke);
  };
  const tools = el('div', { class: 'tools' });
  const resend = async () => {
    fill(status);
    const r = await resendInvitation(companyId, invitation.invitationId);
    if (r.action === 'navigating') return;
    if (r.ok) {
      handover = r.data;
      flash = notice('A new link is made. The earlier one has stopped working.', 'resent');
      return reload();
    }
    settle(r, status, resend);
  };
  const askResend = () =>
    fill(
      tools,
      el(
        'div',
        { class: 'confirm-box', 'data-role': 'confirm-resend' },
        el('p', {}, LIFECYCLE_TEXT.resendWarning),
        el(
          'div',
          { class: 'actions' },
          button('Resend now', resend, { 'data-role': 'confirm-resend-now' }),
          button('Cancel', showTools, { class: 'quiet', 'data-role': 'cancel' }),
        ),
      ),
    );
  const showTools = () =>
    fill(
      tools,
      invitation.state === 'pending' ? button('Revoke', revoke, { class: 'secondary danger', 'data-role': 'revoke' }) : null,
      ['pending', 'revoked', 'expired'].includes(invitation.state) ? button('Resend', askResend, { class: 'secondary', 'data-role': 'resend' }) : null,
      invitation.state === 'expired' ? button('Invite again', () => inviteAgain(invitation), { class: 'secondary', 'data-role': 'invite-again' }) : null,
    );
  showTools();
  return el(
    'li',
    { class: 'card', 'data-invitation': invitation.invitationId, 'data-state': invitation.state },
    el('div', { class: 'card-head' }, el('span', { class: 'label' }, isolated(invitation.email))),
    /* `createdAt` is when the row was written, and the delivery the row records carries no time, so the date label is
       Created, never Sent (E7M-C-F6); what the attempt came to is the delivery line's, below. */
    el('p', { class: 'meta' }, roleNames(invitation.roles), dateLine(' · Created ', invitation.createdAt), dateLine(INVITATION_DATES[invitation.state] ?? ' · ', invitation[INVITATION_WHEN[invitation.state]])),
    deliveryLine(invitation),
    tools,
    status,
  );
}

function invitationsSection(answer) {
  const box = el('section', { 'data-role': 'invitations' }, el('h2', {}, 'Invitations'));
  if (!answer) return add(box, [el('p', { class: 'meta' }, 'The invitation list was not read for this session.')]);
  if (!answer.ok) return add(box, [failureView(answer, { retry: reload })]);
  const list = answer.data.invitations;
  if (answer.data.truncated) add(box, [notice('This invitation list is incomplete: the company has more invitations than this page shows.', 'truncated')]);
  if (list.length === 0) add(box, [el('p', { class: 'meta' }, 'No invitations yet.')]);
  for (const [state, title] of [['pending', 'Pending'], ['accepted', 'Accepted'], ['revoked', 'Revoked'], ['expired', 'Expired']]) {
    const rows = list.filter((i) => i.state === state);
    if (rows.length) add(box, [el('h3', {}, `${title} (${rows.length})`), el('ul', { class: 'cards', 'data-group': state }, rows.map(invitationCard))]);
  }
  return box;
}

function render() {
  const { list, invites, membership, factorList, quota } = view;
  const viewer = list.viewer;
  const shown = pageFlash;
  pageFlash = null;
  const admin = viewer.roles.includes('company_admin');
  const manage = admin && viewer.aal === 'aal2';
  const active = list.members.filter((r) => r.status === 'active');
  const former = list.members.filter((r) => r.status !== 'active');
  inviteForm = null;
  fill(
    main,
    shown,
    el(
      'div',
      { class: 'page-head' },
      heading(membership?.companyName ?? 'Members'),
      el('div', { class: 'toolbar' }, button('Reload', reload, { class: 'secondary', 'data-role': 'reload' })),
    ),
    companyLinks(companyId, '/members/'),
    el('p', { class: 'meta', 'data-role': 'own-roles' }, 'Your roles: ', roleNames(viewer.roles)),
    list.truncated ? notice('This member list is incomplete: the company has more memberships than this page shows.', 'truncated') : null,
    admin && !manage ? stepUpPanel(factorList) : null,
    viewer.mayReadLabels && viewer.aal !== 'aal2'
      ? el('p', { class: 'meta', 'data-role': 'addresses-need-mfa' }, 'Addresses need your second factor. ', link('/mfa/', 'Verify now'))
      : null,
    el(
      'section',
      { 'data-role': 'members' },
      el('h2', {}, `Members (${active.length})`),
      el('ul', { class: 'cards' }, active.map((row) => memberCard(row, manage, list.assignableRoles))),
    ),
    former.length
      ? el('section', { 'data-role': 'former-members' }, el('h2', {}, `Former members (${former.length})`), el('ul', { class: 'cards' }, former.map((row) => memberCard(row, manage, []))))
      : null,
    admin ? quotaLines(quota, viewer.aal) : null,
    manage ? inviteSection(list.assignableRoles) : null,
    manage ? invitationsSection(invites) : null,
    manage ? ownAgentsSection(viewer) : null,
    admin && membership ? takeoutSection(membership, viewer.aal) : null,
  );
}

async function show(identity, factorList, answers) {
  const membership = membershipOf(identity);
  renderHeader(header, { email: identity.user.email, companyName: membership?.companyName ?? null, onSignOut: signOut });
  if (!companyId) return discard();
  const [list, invites, quota] = answers;
  if (list.action === 'navigating' || invites?.action === 'navigating' || quota?.action === 'navigating') return;
  if (!list.ok || (invites && invites.action === 'not-found')) {
    if (!list.ok && list.action === 'maintenance') return showPageState(header, main, failureView(list, { retry: load }));
    if (list.action === 'not-found' || invites?.action === 'not-found') return discard();
    view = null;
    return fill(main, heading(membership?.companyName ?? 'Members'), failureView(list, { retry: load }));
  }
  view = { identity, membership, factorList, list: list.data, invites, quota: quota ?? null };
  render();
}

async function load() {
  view = null;
  fill(main, loading('Loading the member list.'));
  const m = await me();
  if (m.action === 'navigating') return;
  if (!m.ok) return showPageState(header, main, failureView(m, { retry: load }));
  const enrolment = await sendAdminsToEnrolment(m.data);
  if (enrolment.moved || enrolment.answer?.action === 'navigating') return;
  if (enrolment.answer) return showPageState(header, main, failureView(enrolment.answer, { retry: load }));
  if (!companyId) return show(m.data, enrolment.factors, [null, null, null]);
  /* The quota read is the invitation list's twin: an administrator at aal2 only, because the route answers nobody else
     (E6S-C-F5), so nobody else sends it. */
  const due = wantsInvitations(m.data);
  const answers = await Promise.all([members(companyId), due ? invitations(companyId) : null, due ? quotas(companyId) : null]);
  await show(m.data, enrolment.factors, answers);
}

async function reload() {
  if (!companyId) return load();
  const known = view?.identity ?? null;
  const knownDue = Boolean(known && wantsInvitations(known));
  const [m, list, early, earlyQuota] = await Promise.all([
    me(),
    members(companyId),
    knownDue ? invitations(companyId) : null,
    knownDue ? quotas(companyId) : null,
  ]);
  if (m.action === 'navigating' || list.action === 'navigating' || early?.action === 'navigating' || earlyQuota?.action === 'navigating') return;
  if (!m.ok) return showPageState(header, main, failureView(m, { retry: load }));
  const due = wantsInvitations(m.data);
  const invites = early ?? (due ? await invitations(companyId) : null);
  const quota = earlyQuota ?? (due ? await quotas(companyId) : null);
  await show(m.data, view?.factorList ?? null, [list, invites, quota]);
}

keepFresh({
  clear: () => {
    view = null;
    inviteForm = null;
    handover = null;
    pageFlash = null;
    fill(main);
    renderPlainHeader(header);
  },
  reload: load,
});
load();
