/* The audience groups, /groups/?company=<uuid> (E4 design 1.7, 3.4, 4.1 and 4.2).

   Order of calls. GET /api/me; an administrator without a verified factor is moved to /mfa/ first. Then the group list
   and the member list together; either answering 404 is the not-found state. The group list costs the service one read
   per group (E4S-F12), so the page reads it once when it loads and again only after a change it made, or when the
   person presses Reload.

   What each viewer sees. Every active member: each group with its members' labels. An administrator at aal1: the same,
   and one panel linking to /mfa/. An administrator at aal2: a form to create a group, "Remove" beside each group member,
   and a choice of the company's active members not yet in the group with "Add to group". Each change is decided by the
   service; a refusal shows its message with the action api.mjs names. Group names are placed in bdi elements.

   What E6 adds (design 4.1, the groups row): one line, the groups_per_company quota with its usage and, when the server
   says `near`, the warning. GET /api/companies/{id}/quotas answers an administrator at aal2 alone (E6S-C-F5), so only
   that session reads it; an administrator at aal1 is told the line needs the second factor rather than shown a
   default, and anybody else sees no line.

   E4P-F8 (evidence/e4-pages.md; the lead's decision on Raffael's recommendation, 2026-09-17): a display name is required
   before a member can be added to an audience group, because the group lists its members by name and an administrator
   choosing an audience cannot tell unnamed members apart. "Add to group" refuses an unnamed member with a sentence that
   says what to do (lifecycle-view.mjs namedForAudience and its two sentences) and sends nothing. It is a page rule and
   nothing more: the service refuses nothing new, and a request built by hand still adds an unnamed member. */

import { addGroupMember, createGroup, groups, me, members, quotas, removeGroupMember, sendAdminsToEnrolment, signOutHere } from '../api.mjs';
import { button, el, field, fill, form, isolated } from '../dom.mjs';
import { companyParam } from '../params.mjs';
import { companyLinks, dateLine, failureView, heading, keepFresh, link, loading, notFoundView, notice, renderHeader, renderPlainHeader, roleNames, showPageState, startPage, statusRegion } from '../shell.mjs';
import { LIFECYCLE_TEXT, namedForAudience, nearSentence, quotaLabel, quotaUsage } from '../lifecycle-view.mjs';
import { labelsOf, memberLabel } from '../passport-view.mjs';

const { header, main } = startPage();
const companyId = companyParam();
let identity = null;
let flash = null;

async function signOut() {
  const r = await signOutHere();
  if (!r.ok && r.action !== 'navigating') main.prepend(failureView(r, { retry: signOut }));
}

function discard() {
  flash = null;
  fill(main, notFoundView());
}

function settle(r, status, retry) {
  if (r.action === 'navigating') return;
  if (r.action === 'not-found') return discard();
  if (r.action === 'maintenance') return showPageState(header, main, failureView(r, { retry: load }));
  fill(status, failureView(r, { retry }));
}

async function change(send, status, done) {
  fill(status);
  const r = await send();
  if (r.action === 'navigating') return;
  if (r.ok) {
    flash = notice(r.data.changed === false ? 'Nothing changed: the group was already that way.' : done, 'group-changed');
    return load();
  }
  settle(r, status, () => change(send, status, done));
}

function createSection() {
  const name = field({ label: 'Group name', id: 'group-name', type: 'text', autocomplete: 'off', spellcheck: 'false' });
  const status = statusRegion('create-status');
  const submit = el('button', { type: 'submit', 'data-role': 'create-group' }, 'Create group');
  const send = async () => {
    submit.disabled = true;
    fill(status);
    const r = await createGroup(companyId, name.input.value);
    submit.disabled = false;
    if (r.action === 'navigating') return;
    if (r.ok) {
      flash = notice('Group created.', 'group-created');
      return load();
    }
    settle(r, status, send);
  };
  return el(
    'section',
    { class: 'panel', 'data-role': 'create' },
    el('h2', {}, 'Create a group'),
    form({ class: 'stack', 'data-role': 'create-form' }, send, name.wrap, submit, status),
  );
}

/* A member as the list labels it, with roles and join date beside the label: an administrator choosing an audience
   may meet several members the list labels alike (evidence/e4-pages.md, the findings table). */
function who(labels, row, id) {
  return [
    memberLabel(labels, id),
    row ? el('span', { class: 'meta' }, ` · ${roleNames(row.roles)}`, dateLine(' · joined ', row.createdAt)) : null,
  ];
}

function groupCard(g, labels, members, manage) {
  const status = statusRegion('group-status');
  const inGroup = new Set(g.memberIds);
  const rowOf = new Map(members.map((m) => [m.membershipId, m]));
  const active = members.filter((m) => m.status === 'active');
  const rows = g.memberIds.map((id) =>
    el(
      'li',
      { 'data-membership': id },
      who(labels, rowOf.get(id), id),
      manage
        ? button('Remove', () => change(() => removeGroupMember(companyId, g.groupId, id), status, 'Removed from the group.'), {
            class: 'quiet',
            'data-role': 'remove-from-group',
          })
        : null,
    ),
  );
  const addable = active.filter((m) => !inGroup.has(m.membershipId));
  const choices = addable.map((m, i) => {
    const id = `add-${g.groupId}-${m.membershipId}`;
    const input = el('input', { type: 'radio', name: `add-${g.groupId}`, id, value: m.membershipId, checked: i === 0 });
    return { input, wrap: el('div', { class: 'option' }, input, el('label', { for: id }, who(labels, m, m.membershipId))) };
  });
  const adder =
    manage && choices.length
      ? el(
          'div',
          { class: 'add-member', 'data-role': 'add-member' },
          el('fieldset', { class: 'choice scroll' }, el('legend', {}, 'Add a member'), choices.map((c) => c.wrap)),
          button(
            'Add to group',
            () => {
              const chosen = choices.find((c) => c.input.checked)?.input.value ?? addable[0].membershipId;
              const label = labels.get(chosen);
              if (!namedForAudience(label, identity.user.displayName))
                return fill(
                  status,
                  el(
                    'p',
                    { class: 'notice', role: 'alert', 'data-state': 'unnamed-member' },
                    label?.kind === 'self' ? LIFECYCLE_TEXT.audienceUnnamedSelf : LIFECYCLE_TEXT.audienceUnnamed,
                  ),
                );
              return change(() => addGroupMember(companyId, g.groupId, chosen), status, 'Added to the group.');
            },
            { class: 'secondary', 'data-role': 'add-to-group' },
          ),
        )
      : null;
  return el(
    'li',
    { class: 'card', 'data-group-id': g.groupId },
    el(
      'div',
      { class: 'card-head' },
      isolated(g.name, { 'data-role': 'group-name' }),
      el('span', { class: 'tag' }, `${g.memberIds.length} member${g.memberIds.length === 1 ? '' : 's'}`),
    ),
    rows.length ? el('ul', { class: 'lines', 'data-role': 'group-members' }, rows) : el('p', { class: 'meta' }, 'No member yet.'),
    adder,
    status,
  );
}

/* The groups line of design 4.1: the server's value, usage and `near`; at aal1 the sentence that it needs the factor. */
function quotaLine(answer, aal) {
  if (aal !== 'aal2') return el('p', { class: 'meta', 'data-role': 'quota-needs-factor' }, LIFECYCLE_TEXT.groupQuotaNeedsFactor);
  if (!answer) return null;
  if (!answer.ok) return el('div', { 'data-role': 'quota-lines' }, failureView(answer, { retry: load }));
  const q = (answer.data.quotas ?? []).find((x) => x.name === 'groups_per_company');
  if (!q) return null;
  return el(
    'div',
    { class: 'panel', 'data-role': 'quota-lines', 'data-quota': q.name, 'data-near': q.near === true ? 'yes' : 'no' },
    el('p', {}, `${quotaLabel(q.name)}: `, el('span', { 'data-role': 'quota-usage' }, quotaUsage(q))),
    q.near === true ? el('p', { class: 'notice', role: 'status', 'data-state': 'quota-near' }, nearSentence(q.name)) : null,
  );
}

function render(groupData, list, membership, quota) {
  const labels = labelsOf(list);
  const admin = Boolean(membership?.roles.includes('company_admin'));
  const manage = admin && identity.user.aal === 'aal2';
  const shown = flash;
  flash = null;
  fill(
    main,
    shown,
    el(
      'div',
      { class: 'page-head' },
      heading('Audience groups', 'An envelope names groups as its audience. Who is in a group is read when a download is authorized, so a change here changes whom a release reaches.'),
      el('div', { class: 'toolbar' }, button('Reload', load, { class: 'secondary', 'data-role': 'reload' })),
    ),
    companyLinks(companyId, '/groups/'),
    groupData.truncated ? notice('This group list is incomplete: the company has more groups or group members than this page shows.', 'truncated') : null,
    list.truncated ? notice('The member list behind these labels is incomplete, so some members cannot be named or added here.', 'truncated') : null,
    admin && !manage
      ? el(
          'section',
          { class: 'panel', 'data-role': 'step-up-panel' },
          el('h2', {}, 'Changing groups needs your second factor'),
          el('p', {}, 'The groups below are read-only until this session is verified with a second factor.'),
          link('/mfa/', 'Verify with your second factor', { class: 'button', 'data-role': 'mfa-link' }),
        )
      : null,
    admin ? quotaLine(quota, identity.user.aal) : null,
    manage ? createSection() : null,
    el(
      'section',
      { 'data-role': 'groups' },
      el('h2', {}, `Groups (${groupData.groups.length})`),
      groupData.groups.length
        ? el('ul', { class: 'cards' }, groupData.groups.map((g) => groupCard(g, labels, list.members, manage)))
        : el('p', { class: 'meta', 'data-state': 'empty' }, 'This company has no audience group yet.'),
    ),
  );
}

async function load() {
  fill(main, loading('Loading the audience groups.'));
  const m = await me();
  if (m.action === 'navigating') return;
  if (!m.ok) return showPageState(header, main, failureView(m, { retry: load }));
  const enrolment = await sendAdminsToEnrolment(m.data);
  if (enrolment.moved || enrolment.answer?.action === 'navigating') return;
  if (enrolment.answer) return showPageState(header, main, failureView(enrolment.answer, { retry: load }));
  identity = m.data;
  const membership = identity.memberships.find((x) => x.companyId === companyId) ?? null;
  renderHeader(header, { email: identity.user.email, companyName: membership?.companyName ?? null, onSignOut: signOut });
  if (!companyId) return discard();
  const readsQuota = Boolean(membership?.roles.includes('company_admin') && identity.user.aal === 'aal2');
  const [groupAnswer, memberAnswer, quota] = await Promise.all([groups(companyId), members(companyId), readsQuota ? quotas(companyId) : null]);
  const answers = [groupAnswer, memberAnswer];
  if ([...answers, quota].some((a) => a?.action === 'navigating')) return;
  if (answers.some((a) => a.action === 'not-found')) return discard();
  const failed = answers.find((a) => !a.ok);
  if (failed?.action === 'maintenance') return showPageState(header, main, failureView(failed, { retry: load }));
  if (failed) return fill(main, heading('Audience groups'), failureView(failed, { retry: load }));
  render(groupAnswer.data, memberAnswer.data, membership, quota);
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
