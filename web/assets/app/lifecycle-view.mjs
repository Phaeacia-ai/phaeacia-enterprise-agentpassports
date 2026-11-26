/* E6's page vocabulary (E6 design 1.2, 1.4, 1.5, 1.6, 1.7, 4.1 and 4.3), shared by the three operator pages and the
   members, groups and home pages, as passport-view.mjs is for E4 and E5. A page module runs when it is loaded, so a
   function inside one cannot be unit tested or shared; and a page may not reach lib/ (pages design 4.5), so the
   rules a page needs are here as presentation copies, each pinned equal to its authority under lib/rules by
   tests/e2/unit/web-e6-modules.test.mjs:
     the company statuses, access states, deletion states and the two reason vocabularies: lib/rules/lifecycle.mjs;
     departureConsequences: lib/rules/lifecycle.mjs's, the same rows in the same order for every preview shape;
     the seven quota names, the three counted per subject, their labels and the near rule: lib/rules/quotas.mjs.
   A pin is the whole value of a copy: without it the two drift silently, which is the duplicated-rule defect the
   quality gates name. The server decides every one of these again; the page only says what they mean.

   Every fixed sentence is in LIFECYCLE_TEXT or comes from one of the sentence functions below, and labelTable() lists
   every sentence they can produce with the values that produce it, so the unit test reads the table rather than the
   source (E5's label gate, extended here). No sentence repeats a server message (pages rule 7, U8), which is why the
   closed company is "Phaeacia has closed this company." and not the design's sentence, and none holds the module
   keyword the module-statement gate refuses outside a statement, which is why the design's sentences about a copy are
   reworded; the control a person presses is still called Export.

   The accept link (design 4.3's one new rule). acceptLinkBlock puts a handover link in the value of a read-only
   input with a copy control and never in an a element, an href or anything the browser can follow or prefetch: it
   is a single-use credential. The page keeps it in page memory only, for the answer that made it (design 1.2 rule
   1), and a reload does not show it again. */

import { button, el, isolated } from './dom.mjs';
import { link, roleNames } from './shell.mjs';

/* ---------- presentation copies, pinned to lib/rules ---------- */

export const COMPANY_STATUSES = Object.freeze(['active', 'suspended', 'closed', 'held']);
export const ACCESS_STATES = Object.freeze(['none', 'current', 'export_window', 'expired']);
export const DELETION_STATES = Object.freeze(['not_eligible', 'eligible', 'due', 'overdue']);
export const STATUS_REASON_CODES = Object.freeze(['customer_request', 'non_payment', 'operator_decision']);
export const LIFECYCLE_REASON_CODES = Object.freeze(['retention_deadline', 'customer_instruction', 'operator_request']);

export const QUOTA_NAMES = Object.freeze([
  'members_per_company',
  'pending_invitations_per_company',
  'agents_per_company',
  'groups_per_company',
  'versions_per_agent',
  'downloads_per_recipient',
  'reports_per_recipient',
]);
export const PER_SUBJECT_QUOTAS = Object.freeze(['versions_per_agent', 'downloads_per_recipient', 'reports_per_recipient']);
const QUOTA_LABELS = Object.freeze({
  members_per_company: 'People in this company',
  pending_invitations_per_company: 'Open invitations',
  agents_per_company: 'Agents',
  groups_per_company: 'Groups',
  versions_per_agent: 'Versions of one agent',
  downloads_per_recipient: 'Downloads of one release by one person',
  reports_per_recipient: 'Installation reports of one release by one person',
});
export const NEAR_FRACTION = 0.8;

/** The fixed label of a quota name, and the name itself for one this page does not know: no decision depends on it. */
export const quotaLabel = (name) => (Object.hasOwn(QUOTA_LABELS, name) ? QUOTA_LABELS[name] : String(name));
export const isPerSubject = (name) => PER_SUBJECT_QUOTAS.includes(name);
/** design 1.7: `used >= ceil(value * 0.8)`, false for anything that is not a count. A warning, never a refusal. */
export function isNear(used, value) {
  if (!Number.isInteger(used) || !Number.isInteger(value) || value < 1 || used < 0) return false;
  return used >= Math.ceil(value * NEAR_FRACTION);
}

const CONSEQUENCES = Object.freeze([
  ['last_admin', 'isLastAdmin'],
  ['owned_agents', 'ownedAgents'],
  ['agent_releases', 'currentReleases'],
  ['agent_recipients', 'recipients'],
  ['sole_reviewer_roles', 'soleHolderOfRoles'],
  ['envelopes_waiting', 'envelopesAwaitingARoleTheyHold'],
  ['groups', 'groups'],
  ['authorizations', 'authorizations'],
  ['drafts', 'drafts'],
  ['submitted', 'submittedAwaitingReview'],
]);
function countOf(preview, of) {
  if (of === 'isLastAdmin') return preview.isLastAdmin === true ? 1 : 0;
  if (of === 'currentReleases' || of === 'recipients') {
    let n = 0;
    for (const a of Array.isArray(preview.ownedAgents) ? preview.ownedAgents : []) n += Number.isInteger(a?.[of]) ? a[of] : 0;
    return n;
  }
  const v = preview[of];
  if (Array.isArray(v)) return v.length;
  return Number.isInteger(v) ? v : 0;
}
/** The consequences a departure preview earns, in reading order, a zero count left out: lib/rules/lifecycle.mjs's
    departureConsequences, copied because a page cannot reach it and pinned equal to it over every preview shape. */
export function departureConsequences(preview) {
  if (preview === null || typeof preview !== 'object') return [];
  const out = [];
  for (const [kind, of] of CONSEQUENCES) {
    const count = countOf(preview, of);
    if (count > 0) out.push(Object.freeze({ kind, count }));
  }
  return out;
}

/* ---------- the fixed sentences ---------- */

export const LIFECYCLE_TEXT = Object.freeze({
  registerLead: "This page lists Phaeacia's customer companies. It shows how much each one holds and never what it holds.",
  companyLead: 'This page shows how much this company holds and never what it holds.',
  noCompanies: 'No companies yet.',
  cursorReset: 'The list moved since its last page was read: a company it named no longer exists, so it starts again here.',
  moreCompanies: 'More companies follow.',
  sweepLead: 'The sweep suspends every company whose window for reading its records has closed, and lists the ones whose deletion is due. It deletes nothing.',
  sweepNothing: 'The sweep changed nothing: no company was waiting for it.',
  unclaimedAccounts: 'Deleting these runs from a terminal, not from this page.',
  closedCompany: 'Phaeacia has closed this company.',
  noPeriod: 'This company has no agreement dates. Set them.',
  periodComputed:
    'The service computes the date reading and exporting stop, and the date deletion is due, from the end date, and stores both.',
  datesAreUtc: 'Dates are taken as the start of that day in UTC.',
  quotaBoundsServer: 'The service decides which values are allowed, and says so if one is not.',
  pendingInvitationsLead: 'Open invitations are counted here; who they are for is not shown.',
  grantHint: 'Ask the person for their account id.',
  manifestNoCopy: "Phaeacia takes no copy of a customer's records from here. These are counts, not contents.",
  manifestUnder: "This company's administrator can take a copy with Export on the company's own pages.",
  manifestOver: 'This company is larger than one HTTP response. Its Export runs from a terminal.',
  closeWarning: 'Closing is permanent. Nobody in the company can read anything afterwards. Nothing is deleted yet.',
  closeOnlyInstruction: 'Only a recorded instruction from the customer allows closing before that date.',
  deleteWhat:
    'Every member, invitation, agent, version, review, release, download, report and audit row of this company. Accounts are not deleted here.',
  deletedAccounts: 'They are left for the account sweep, which runs from a terminal.',
  acceptLinkWhat:
    'This link signs its holder in and gives them these roles. It is the whole of their first factor. Hand it over the way you would hand over a password, and only to the person whose address is on it.',
  acceptLinkOperator: "You are holding this person's first factor until they use it.",
  /* ENA-7 (evidence/ena7-end1-hbf2.md section 5, D2): the answer for an address whose account someone already uses,
     or that another company was handed a signing link for within that link's life. The link carries the invitation
     code and no sign-in. The page cannot tell the two apart, so it names both: in the second, the person has no way
     to sign in yet, and the remedy is a fresh invitation once the other link has expired (CR-ENA7-1). */
  acceptCodeWhat:
    'This link does not sign anyone in. A person who already has an account signs in with their own email address first, then opens it and accepts. A person who has never signed in cannot use it yet, because another company invited this address within the last hour: issue this invitation again after that hour for a link that signs them in. It gives these roles only to the address it was made for.',
  /* The members page's note above its invite form (inviteLinkNote below). Since ENA-7 a link signs in only for an
     address whose account is unclaimed, so the note says "can"; beside a code-only answer it is left out (CR-Q114-1). */
  inviteLinkNote:
    "An invitation's link can sign its holder in. Until the invited person sets up a second factor, a link that does is as sensitive as a password.",
  acceptLinkOnceOperator:
    'This is shown once. If you lose it, open the company and invite the administrator again, which issues a new link and kills this one.',
  acceptLinkOnceAdmin:
    'This is shown once. If you lose it, use Resend on the invitation, which issues a new link and stops this one.',
  acceptLinkMailed: 'The link was emailed.',
  /* E7 design section 4 and 2.6 item 5 (E7D-C-F7's wording): true whether the provider refused the message or its
     answer was lost after it left. The operator's sentence names no company being made (E7M-F15, E8 day 5): the
     succession block on the operator's company page renders it too, where no company was just made. */
  acceptLinkFailedAdmin:
    'The invitation is made, but its mail could not be confirmed as sent. Use Resend on it to send a new link; that also stops any link that did go out.',
  acceptLinkFailedOperator:
    "The administrator's invitation is made, but its mail could not be confirmed as sent. Invite the administrator again from the company's page with the same address; that also stops any link that did go out.",
  copyDone: 'Copied.',
  copyByHand: 'Select the link and copy it.',
  resendWarning: 'This replaces the earlier link. The earlier link stops working.',
  departureLead: 'These counts were true when this page read them. Somebody can change them before you press Remove.',
  departureAccess: 'They lose all access to this company at their next request.',
  transferFirst: 'Transfer these first and they keep working.',
  noOtherMember: 'There is no other active member to give this to.',
  lastAdmin: "This is the company's last administrator. Give another member the administrator role before removing this one.",
  staysMembership: 'The membership stays, as a former member, so every earlier record still names who did what.',
  staysHistory: 'Everything they contributed, reviewed, published, downloaded, reported or witnessed stays recorded as it is.',
  staysAccount: 'Their account stays. It belongs to them, not to this company, and any other company they belong to is unaffected.',
  staysReactivation: 'Inviting them again restores the membership, but not their groups and not the agents they owned.',
  leftBehindLead: 'What this former member owned. An agent without an owner publishes nothing and serves no download until it is transferred.',
  leftNothing: 'This former member owns no agent.',
  ownedNone: 'You own no agent in this company.',
  ownedLead: 'Agents you own. You can hand one to another active member.',
  quotaNeedsFactor: 'How many seats are in use is shown once this session has your second factor.',
  groupQuotaNeedsFactor: 'How many groups this company may have is shown once this session has your second factor.',
  seatsNear: "This company is close to the number of people its agreement allows. Ask Phaeacia to raise it before inviting more.",
  invitationsNear: 'This company is close to the number of open invitations this service allows. Revoke the ones no longer needed.',
  groupsNear: 'This company is close to the number of groups its agreement allows. Ask Phaeacia to raise it before creating more.',
  perSubject: 'counted for each agent or each person, not for the whole company',
  homeSuspended:
    'This company is suspended. Nobody can read or change anything in it until Phaeacia resumes it; an administrator can still take a copy with Export.',
  homeExportWindow:
    "This company's agreement has ended. Changes have stopped; its records can be read and exported until its window closes, and Phaeacia can tell you the date.",
  homeExpired: "This company's agreement ended and its window for reading and exporting its records has closed.",
  takeoutLead: 'Export writes every record of this company that you can read into one file on this device.',
  takeoutNeedsFactor: 'Export needs your second factor.',
  takeoutSaved: 'Saved as a file on this device.',
  takeoutNothingWithheld: 'Nothing you could read was left out.',
  operatorCompanyGone: 'No company has this id. It may never have existed, or it has been deleted.',
  /* E4P-F8, the lead's decision on Raffael's recommendation: an audience group lists its members by name, so a member
     with no display name is not added to one. A page rule only; the service refuses nothing new. */
  audienceUnnamed:
    'This member has no display name yet, and an audience group lists its members by name. Ask them to set one on their account page, then add them.',
  audienceUnnamedSelf: 'Set your display name on your account page first. An audience group lists its members by name.',
});

/* ---------- words and sentences from a server value ---------- */

const STATUS_WORDS = Object.freeze({ active: 'Active', suspended: 'Suspended', closed: 'Closed', held: 'Held after a restore' });
const ACCESS_WORDS = Object.freeze({
  none: 'No agreement dates',
  current: 'Current',
  export_window: 'Reading window',
  expired: 'Ended',
});
const DELETION_WORDS = Object.freeze({ not_eligible: 'Not yet', eligible: 'Eligible', due: 'Due', overdue: 'Overdue' });
const STATUS_REASONS = Object.freeze({
  customer_request: 'The customer asked for it',
  non_payment: 'An invoice is unpaid',
  operator_decision: 'Phaeacia decided it',
});
const CLOSE_REASONS = Object.freeze({
  retention_deadline: 'The retention deadline applies',
  customer_instruction: 'The customer instructed us to close it',
  operator_request: 'Phaeacia decided it',
});
const DELETE_REASONS = Object.freeze({
  retention_deadline: 'The retention deadline applies',
  customer_instruction: 'The customer instructed us to delete',
});
const WITHHELD_REASONS = Object.freeze({
  no_admin_read_predicate: 'no administrator can read that section',
  another_author_draft: "an unsubmitted draft is readable by its author alone",
});

const named = (table, key) => (Object.hasOwn(table, key) ? table[key] : String(key));
export const statusWord = (status) => named(STATUS_WORDS, status);
export const accessWord = (state) => named(ACCESS_WORDS, state);
export const deletionWord = (state) => named(DELETION_WORDS, state);
export const statusReasonLabel = (code) => named(STATUS_REASONS, code);
export const closeReasonLabel = (code) => named(CLOSE_REASONS, code);
export const deleteReasonLabel = (code) => named(DELETE_REASONS, code);
/** The two reasons a deletion admits, in the order the delete block offers them (design 4.1 item 9). */
export const DELETE_REASON_CODES = Object.freeze(Object.keys(DELETE_REASONS));

/** A calendar date as a person reads it, "10 December 2026", in UTC so every browser says the same; null for none. */
export function dayText(iso) {
  if (typeof iso !== 'string' || Number.isNaN(Date.parse(iso))) return null;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
const on = (iso) => dayText(iso) ?? 'a date this page was not given';

/** Where a company stands against its agreement dates, as one sentence (design 4.1 item 3). */
export function accessSentence(period) {
  const state = period?.state;
  if (state === 'none' || !period) return LIFECYCLE_TEXT.noPeriod;
  if (state === 'current') return `The agreement runs until ${on(period.endsAt)}. Reading and exporting stop on ${on(period.exportBy)}.`;
  if (state === 'export_window') return `The agreement ended on ${on(period.endsAt)}. Reading and exporting stop on ${on(period.exportBy)}.`;
  if (state === 'expired') return `Reading and exporting stopped on ${on(period.exportBy)}.`;
  return 'This page does not know this access state; the service decides what is allowed.';
}

/** The deletion state as one sentence with the date it turns on (design 4.1 items 3 and 9). */
export function deletionSentence(period) {
  const state = period?.deletionState;
  if (!period || period.state === 'none') return 'Deletion has no date, because this company has no agreement dates.';
  if (state === 'not_eligible') return `Deletion becomes possible on ${on(period.exportBy)} and is due by ${on(period.deleteBy)}.`;
  if (state === 'eligible') return `Deletion has been possible since ${on(period.exportBy)} and is due by ${on(period.deleteBy)}.`;
  if (state === 'due') return `Deletion is due by ${on(period.deleteBy)}.`;
  if (state === 'overdue') return `Deletion was due on ${on(period.deleteBy)}.`;
  return 'This page does not know this deletion state; the service decides whether deletion is allowed.';
}

/** The short register cell: the access state word with the date it turns on. */
export function accessCell(period) {
  const state = period?.state ?? 'none';
  if (state === 'current') return `${accessWord(state)} until ${on(period.endsAt)}`;
  if (state === 'export_window') return `${accessWord(state)} until ${on(period.exportBy)}`;
  if (state === 'expired') return `${accessWord(state)} since ${on(period.exportBy)}`;
  return accessWord(state);
}

/** The short register cell for deletion: the word, and the date that matters for it. */
export function deletionCell(period) {
  const state = period?.deletionState ?? 'not_eligible';
  if (state === 'eligible') return `${deletionWord(state)} since ${on(period.exportBy)}`;
  if (state === 'due') return `${deletionWord(state)} by ${on(period.deleteBy)}`;
  if (state === 'overdue') return `${deletionWord(state)} since ${on(period.deleteBy)}`;
  return deletionWord(state);
}

/** E4P-F8: whether a member may be added to an audience group from the groups page, which lists members by name. A
    label of kind display_name is named; the viewer's own row (kind self, which carries the address) is named when the
    viewer's identity carries a display name; an invitation address or no label is not. Presentation only: the service
    admits the add either way, and the page says so in its header. */
export function namedForAudience(label, ownDisplayName = null) {
  if (label?.kind === 'display_name') return typeof label.value === 'string' && label.value.length > 0;
  if (label?.kind === 'self') return typeof ownDisplayName === 'string' && ownDisplayName.length > 0;
  return false;
}

/** The home page's sentence for a membership whose company is not active or whose access is not current (design 4.1's
    table), or null for one that is both. The date the design's sentences carry is not in GET /api/me (E6P-D1). */
export function homeStateSentence(membership) {
  if (membership?.companyStatus === 'closed') return LIFECYCLE_TEXT.closedCompany;
  if (membership?.accessState === 'expired') return LIFECYCLE_TEXT.homeExpired;
  if (membership?.companyStatus === 'suspended') return LIFECYCLE_TEXT.homeSuspended;
  if (membership?.accessState === 'export_window') return LIFECYCLE_TEXT.homeExportWindow;
  if (membership?.companyStatus === 'active') return null;
  return 'This company cannot be used at the moment.';
}

/** Whether the home page lists this membership as inactive rather than as a working company. */
export const isInactiveMembership = (m) => homeStateSentence(m) !== null;

/** E6PW-R-F1 (design 1.5 over 4.1's home table): reads stop at export_by, not at ends_at, so an active company in its
    reading window (past ends_at, before export_by) still serves its read pages, and the home page keeps their links
    on its row (and no longer forwards a one-membership person past that row, B3-R-F1). A suspended company in the
    same window does not: its status stops the reads. Presentation only; the server answers E_ACCESS_PERIOD_ENDED or
    E_COMPANY_INACTIVE on its own. */
export const readsStillServed = (m) => m?.companyStatus === 'active' && m?.accessState === 'export_window';

/** The design 4.1 table's Export row: an administrator at aal2 of a company that is not closed and whose window has not
    closed. Presentation only; the takeout routine tests the same things again and more. */
export function mayTakeCopy(membership, aal) {
  /* Only `active` and `suspended` (E7 2.6 item 5): a held company offers no Export on any page, because the recovery
     hold refuses the takeout routine too (E7 1.3, E7D-C-F1). */
  return (
    Array.isArray(membership?.roles) &&
    membership.roles.includes('company_admin') &&
    aal === 'aal2' &&
    (membership.companyStatus === 'active' || membership.companyStatus === 'suspended') &&
    membership.accessState !== 'expired'
  );
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One sentence per consequence a departure preview earns (design 1.4 "What stops"), in the rule's order, and the
    fixed sentences of what stays, with the counts of the answer that make them concrete. */
export function departureSentences(preview) {
  const stops = [{ kind: 'access', text: LIFECYCLE_TEXT.departureAccess }];
  const stays = [
    { kind: 'membership', text: LIFECYCLE_TEXT.staysMembership },
    { kind: 'history', text: LIFECYCLE_TEXT.staysHistory },
  ];
  for (const { kind, count } of departureConsequences(preview)) {
    if (kind === 'last_admin') stops.push({ kind, text: LIFECYCLE_TEXT.lastAdmin });
    else if (kind === 'owned_agents')
      stops.push({
        kind,
        text: `They own ${plural(count, 'agent', 'agents')}. Nobody can publish ${count === 1 ? 'it' : 'them'} after they leave until an administrator transfers ${count === 1 ? 'it' : 'them'}.`,
      });
    else if (kind === 'agent_releases')
      stops.push({
        kind,
        text: `${plural(count, 'current release', 'current releases')} of those agents ${count === 1 ? 'stops' : 'stop'} being downloadable, for everybody, until the agent is transferred.`,
      });
    else if (kind === 'agent_recipients')
      stops.push({ kind, text: `${plural(count, 'member is', 'members are')} in the audience of those releases.` });
    else if (kind === 'sole_reviewer_roles')
      stops.push({
        kind,
        text: `Nobody else holds ${roleNames(preview.soleHolderOfRoles)}, so a review that needs it waits until somebody is given it.`,
      });
    else if (kind === 'envelopes_waiting')
      stops.push({ kind, text: `${plural(count, 'envelope is', 'envelopes are')} waiting for a review in a role they hold.` });
    else if (kind === 'groups')
      stops.push({
        kind,
        text: `They leave ${plural(count, 'audience group', 'audience groups')}, so releases addressed to ${count === 1 ? 'it' : 'them'} stop reaching them.`,
      });
    else if (kind === 'authorizations')
      stays.push({ kind, text: `Their ${plural(count, 'earlier download', 'earlier downloads')} stay recorded; they can download nothing more.` });
    else if (kind === 'drafts')
      stops.push({ kind, text: `${plural(count, 'draft', 'drafts')} of theirs become unreachable: nobody else can open a draft.` });
    else if (kind === 'submitted')
      stays.push({ kind, text: `${plural(count, 'version', 'versions')} they submitted can still be reviewed by others.` });
  }
  if (Number.isInteger(preview?.publishedReleases) && preview.publishedReleases > 0)
    stays.push({
      kind: 'published',
      text: `${plural(preview.publishedReleases, 'release', 'releases')} they published ${preview.publishedReleases === 1 ? 'stays' : 'stay'} published.`,
    });
  stays.push({ kind: 'account', text: LIFECYCLE_TEXT.staysAccount });
  stays.push({ kind: 'reactivation', text: LIFECYCLE_TEXT.staysReactivation });
  return { stops, stays };
}

/** A quota's usage line: "20 of 25", or the value alone with why for the three counted per subject (E6S-F4). */
export function quotaUsage(q) {
  if (q?.used === null || q?.used === undefined || isPerSubject(q?.name))
    return `${q?.value ?? 'no value'}, ${LIFECYCLE_TEXT.perSubject}`;
  return `${q.used} of ${q.value}`;
}

/** The warning a near quota earns on the page that can act on it, or null. */
export function nearSentence(name) {
  if (name === 'members_per_company') return LIFECYCLE_TEXT.seatsNear;
  if (name === 'pending_invitations_per_company') return LIFECYCLE_TEXT.invitationsNear;
  if (name === 'groups_per_company') return LIFECYCLE_TEXT.groupsNear;
  return null;
}

/** What a company's own copy left out, one sentence per section the answer names (design 1.6's `withheld`). */
export function withheldSentences(withheld) {
  const entries = withheld !== null && typeof withheld === 'object' ? Object.entries(withheld) : [];
  if (entries.length === 0) return [LIFECYCLE_TEXT.takeoutNothingWithheld];
  return entries.map(
    ([section, w]) =>
      `${plural(Number.isInteger(w?.rows) ? w.rows : 0, 'row', 'rows')} of ${section} ${w?.rows === 1 ? 'was' : 'were'} left out: ${named(WITHHELD_REASONS, w?.reason)}.`,
  );
}

/** labelTable(): every sentence the functions above can produce, with the values that produce it, and every fixed
    sentence, so the unit test reads the table rather than the source. */
export function labelTable() {
  const rows = [];
  const period = {
    endsAt: '2026-11-26T00:00:00Z',
    exportBy: '2026-12-10T00:00:00Z',
    deleteBy: '2027-01-09T00:00:00Z',
  };
  for (const state of [...ACCESS_STATES, 'a-state-this-page-does-not-know']) {
    rows.push({ kind: 'access', state, label: accessSentence({ ...period, state, deletionState: 'not_eligible' }) });
    rows.push({ kind: 'access-cell', state, label: accessCell({ ...period, state }) });
  }
  for (const deletionState of [...DELETION_STATES, 'a-state-this-page-does-not-know']) {
    rows.push({ kind: 'deletion', deletionState, label: deletionSentence({ ...period, state: 'current', deletionState }) });
    rows.push({ kind: 'deletion-cell', deletionState, label: deletionCell({ ...period, deletionState }) });
  }
  rows.push({ kind: 'deletion', deletionState: 'no-period', label: deletionSentence({ state: 'none' }) });
  for (const companyStatus of [...COMPANY_STATUSES, 'unknown'])
    for (const accessState of ACCESS_STATES)
      rows.push({ kind: 'home', companyStatus, accessState, label: homeStateSentence({ companyStatus, accessState }) });
  for (const s of [...COMPANY_STATUSES, 'unknown']) rows.push({ kind: 'status', s, label: statusWord(s) });
  for (const c of STATUS_REASON_CODES) rows.push({ kind: 'status-reason', c, label: statusReasonLabel(c) });
  for (const c of LIFECYCLE_REASON_CODES) rows.push({ kind: 'close-reason', c, label: closeReasonLabel(c) });
  for (const c of DELETE_REASON_CODES) rows.push({ kind: 'delete-reason', c, label: deleteReasonLabel(c) });
  for (const name of [...QUOTA_NAMES, 'a-quota-this-page-does-not-know']) {
    rows.push({ kind: 'quota', name, label: quotaLabel(name) });
    rows.push({ kind: 'quota-usage', name, label: quotaUsage({ name, value: 25, used: isPerSubject(name) ? null : 20 }) });
    rows.push({ kind: 'quota-near', name, label: nearSentence(name) });
  }
  const full = {
    isLastAdmin: true,
    soleHolderOfRoles: ['it_reviewer'],
    groups: [{ groupId: 'g', name: 'n' }, { groupId: 'h', name: 'm' }],
    ownedAgents: [{ agentId: 'a', name: 'n', status: 'active', currentReleases: 2, recipients: 7 }],
    drafts: 3,
    submittedAwaitingReview: 1,
    envelopesAwaitingARoleTheyHold: 2,
    authorizations: 12,
    publishedReleases: 5,
  };
  const one = {
    isLastAdmin: false,
    soleHolderOfRoles: ['business_reviewer'],
    groups: [{ groupId: 'g', name: 'n' }],
    ownedAgents: [{ agentId: 'a', name: 'n', status: 'active', currentReleases: 1, recipients: 1 }],
    drafts: 1,
    submittedAwaitingReview: 1,
    envelopesAwaitingARoleTheyHold: 1,
    authorizations: 1,
    publishedReleases: 1,
  };
  for (const [shape, preview] of [['all', full], ['one', one], ['nothing', {}]]) {
    const { stops, stays } = departureSentences(preview);
    for (const s of stops) rows.push({ kind: 'departure-stops', shape, what: s.kind, label: s.text });
    for (const s of stays) rows.push({ kind: 'departure-stays', shape, what: s.kind, label: s.text });
  }
  for (const [shape, withheld] of [
    ['none', {}],
    ['both', { access_periods: { rows: 1, reason: 'no_admin_read_predicate' }, candidate_versions: { rows: 2, reason: 'another_author_draft' } }],
    ['unknown', { x: { rows: 1, reason: 'a-reason-this-page-does-not-know' } }],
  ])
    for (const label of withheldSentences(withheld)) rows.push({ kind: 'withheld', shape, label });
  for (const [key, label] of Object.entries(LIFECYCLE_TEXT)) rows.push({ kind: 'fixed', key, label });
  return Object.freeze(rows.filter((r) => r.label !== null).map((r) => Object.freeze(r)));
}

/* ---------- builders ---------- */

/** A fact line of a definition list. */
export function fact(term, ...details) {
  return el('div', {}, el('dt', {}, term), el('dd', {}, ...details));
}

/** A number as a person reads it. */
export const count = (n) => (Number.isFinite(n) ? Number(n).toLocaleString('en-US') : 'not given');

/** A table with a header row, each cell a string or a node; its horizontal overflow is its own (table-wrap). */
export function dataTable(role, headers, rows) {
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      { class: 'data', 'data-role': role },
      el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map((c) => el('td', {}, c))))),
    ),
  );
}

/** The answer to a call that made an invitation: the accept link once, in a read-only field with a copy control and
    never in an a element (design 4.3), under the fixed paragraph of 1.2 rule 3; or, in mail mode, the one sentence.
    `id` names the field; `operator` adds rule 5's sentence and the operator's recovery line. */
export function acceptLinkBlock(answer, { id, operator = false }) {
  /* `unconfirmed` (E7D-C-F7, the E7 mail lane): the answer was lost after the request left, so the mail may have gone.
     The one sentence below was written true of both values, so both render it; "The link was emailed." is true of
     neither. */
  if (answer?.delivery === 'failed' || answer?.delivery === 'unconfirmed')
    return el(
      'p',
      { class: 'notice error', role: 'status', 'data-state': 'link-failed' },
      operator ? LIFECYCLE_TEXT.acceptLinkFailedOperator : LIFECYCLE_TEXT.acceptLinkFailedAdmin,
    );
  if (answer?.delivery !== 'handover' || typeof answer.acceptUrl !== 'string')
    return el('p', { class: 'notice confirm', role: 'status', 'data-state': 'link-mailed' }, LIFECYCLE_TEXT.acceptLinkMailed);
  const input = el('input', {
    type: 'text',
    id,
    class: 'accept-link',
    autocomplete: 'off',
    spellcheck: 'false',
    autocapitalize: 'none',
    'data-role': 'accept-link',
  });
  input.readOnly = true;
  input.value = answer.acceptUrl;
  /* Only an explicit false is a code-only link; an answer without the field reads as a signing link, the cautious text. */
  const signsIn = answer.signsIn !== false;
  const status = el('span', { class: 'meta', 'aria-live': 'polite', 'data-role': 'copy-status' });
  const copy = async () => {
    input.focus();
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
      status.textContent = LIFECYCLE_TEXT.copyDone;
    } catch {
      status.textContent = LIFECYCLE_TEXT.copyByHand;
    }
  };
  return el(
    'div',
    { class: 'handover', 'data-role': 'handover', 'data-signs-in': signsIn ? 'true' : 'false' },
    el('p', { class: 'boundary', 'data-role': 'link-what' }, signsIn ? LIFECYCLE_TEXT.acceptLinkWhat : LIFECYCLE_TEXT.acceptCodeWhat),
    operator && signsIn ? el('p', { class: 'boundary', 'data-role': 'link-held' }, LIFECYCLE_TEXT.acceptLinkOperator) : null,
    el('div', { class: 'field' }, el('label', { for: id }, 'The accept link'), input),
    el('div', { class: 'actions' }, button('Copy the link', copy, { class: 'secondary', 'data-role': 'copy-link' }), status),
    el('p', { class: 'meta', 'data-role': 'link-once' }, operator ? LIFECYCLE_TEXT.acceptLinkOnceOperator : LIFECYCLE_TEXT.acceptLinkOnceAdmin),
  );
}

/** The invite form's note on what a link is, or null beside a code-only answer, whose own sentence says the link signs
    nobody in; the two side by side would contradict each other (ENA-7, CR-Q114-1). Only an explicit false is code-only,
    as in acceptLinkBlock. */
export function inviteLinkNote(answer) {
  if (answer?.delivery === 'handover' && answer.signsIn === false) return null;
  return el('p', { class: 'meta', 'data-role': 'invite-link-note' }, LIFECYCLE_TEXT.inviteLinkNote);
}

/** A labelled choice of values, radio buttons, the first checked: { wrap, value() }. */
export function choice(name, legend, options) {
  const inputs = options.map(([value, label], i) => {
    const id = `${name}-${value}`;
    const input = el('input', { type: 'radio', name, id, value, checked: i === 0 });
    return { input, wrap: el('div', { class: 'option' }, input, el('label', { for: id }, label)) };
  });
  return {
    wrap: el('fieldset', { class: 'choice', 'data-role': `${name}-choice` }, el('legend', {}, legend), inputs.map((i) => i.wrap)),
    value: () => inputs.find((i) => i.input.checked)?.input.value ?? null,
  };
}

/** The file name of a company's own copy: the slug and the time the service stamped, each made safe by the caller's
    nameSafe (save-file.mjs), so a value the page did not choose cannot shape the name. */
export const takeoutFileName = (nameSafe, slug, exportedAt) =>
  `${nameSafe(slug)}-records-${nameSafe(String(exportedAt ?? '').slice(0, 10))}.json`;

/** The saved copy's text: the answer without its envelope's ok flag, indented so a person can read it. */
export function takeoutText(data) {
  const { ok, ...doc } = data ?? {};
  return JSON.stringify(doc, null, 2);
}

/** What the page says after a company's own copy was saved: the counts it holds and what it left out. */
export function takeoutNotice(doc) {
  const counts = doc?.counts !== null && typeof doc?.counts === 'object' ? Object.values(doc.counts) : [];
  const rows = counts.reduce((a, n) => a + (Number.isInteger(n) ? n : 0), 0);
  return el(
    'div',
    { class: 'notice confirm', role: 'status', 'data-state': 'takeout-saved' },
    el('p', {}, `${LIFECYCLE_TEXT.takeoutSaved} It holds ${plural(rows, 'record', 'records')} in ${plural(counts.length, 'section', 'sections')}.`),
    el('ul', { class: 'lines', 'data-role': 'withheld' }, withheldSentences(doc?.withheld).map((s) => el('li', {}, s))),
  );
}

/** A company's name and slug, each isolated. */
export function companyName(row) {
  return el('span', { class: 'label' }, isolated(String(row?.name ?? '')), ' ', el('span', { class: 'tag' }, isolated(String(row?.slug ?? ''))));
}

/* ---------- the operator pages' own states (design 4.2) ---------- */

/** An operator page answered E_NOT_OPERATOR: the server's message, a link home and no form (design 4.2), the page's
    not-found state, because to anyone who is not an operator these pages do not exist. */
export function notOperatorView(message) {
  return el(
    'div',
    { class: 'notice', role: 'alert', 'data-state': 'not-operator' },
    el('h1', {}, 'Page not available'),
    el('p', {}, String(message ?? '')),
    link('/', 'Go to your companies', { 'data-role': 'home-link' }),
  );
}

/** The operator company page's not-found state: an unknown, deleted or malformed company id, one answer. */
export function operatorCompanyGoneView() {
  return el(
    'div',
    { class: 'notice', role: 'alert', 'data-state': 'not-found' },
    el('h1', {}, 'Company not available'),
    el('p', {}, LIFECYCLE_TEXT.operatorCompanyGone),
    link('/operator/', 'Go to the register', { 'data-role': 'register-link' }),
  );
}

/** The operator company page of a company id from an answer; link() refuses anything that is not a uuid. */
export const operatorCompanyTarget = (companyId) => `/operator/company/?company=${companyId}`;
