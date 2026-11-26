/* Lifecycle rules, pure (E6 design 1.5, 1.6, 3.2, 2.1). No IO, no client, no environment.

   Three vocabularies and two derived answers. The vocabularies are the database's, copied here so a page and a
   service can refuse a value before a call and so tests/e6/unit can pin the two lists equal; the database is the
   authority and each refusal below is repeated there (design 3.5). Everything about TIME is derived and never
   stored, so nothing here computes a state from a clock: access_state and deletion_state arrive in the answer,
   from app.access_state and app.deletion_state, and this module only says what they mean.

   departureConsequences is design 1.4's list turned into the fixed sentences a preview EARNS: an admin about to
   remove somebody is told what stops, and a consequence with a count of zero is not shown, because a page that
   lists eight things that will not happen buries the one that will. */

/* `held` is E7's recovery hold (E7 design 1.3, migration 009): a fourth status every member path refuses because
   each tests `= 'active'`, lifted per company by the reconciler alone. Landed with the E7 shared contracts. */
export const COMPANY_STATUSES = Object.freeze(['active', 'suspended', 'closed', 'held']);

/* The edges of design 3.2, as the routine that owns each one. closed is terminal: app.company_status_guard refuses
   every move out of it for every role including the owner, outside the deletion door's bypass. */
const NEXT = Object.freeze({
  active: Object.freeze(['suspended']),
  suspended: Object.freeze(['active', 'closed']),
  closed: Object.freeze([]),
  /* No route reaches or leaves `held`: api.set_company_status refuses it with E_RECOVERY_HOLD, and only the
     reconciler's owner session lifts it (E7 design 1.3, 2.1). An empty array, so every status in the vocabulary
     answers the array contract (E7M-C-F4). */
  held: Object.freeze([]),
});

/* app.access_state: where a company stands against its agreement dates. `none` is a company with no access-period
   row at all, which no product route can create (design 1.5): api.create_company writes the row in the same
   transaction, and only the seed's api.provision_company leaves one absent. */
export const ACCESS_STATES = Object.freeze(['none', 'current', 'export_window', 'expired']);

/* app.deletion_state: eligible from export_by, due within app.deletion_due_notice() of delete_by, overdue after it.
   Nothing here deletes anything: a date makes a deletion permissible and an operator makes it happen. */
export const DELETION_STATES = Object.freeze(['not_eligible', 'eligible', 'due', 'overdue']);

/* The closed list of three the lead decided for api.set_company_status (evidence/e6-db.md section 5 question 1,
   settled): a suspension over an unpaid invoice and one at the customer's own request are different audit rows. */
export const STATUS_REASON_CODES = Object.freeze(['customer_request', 'non_payment', 'operator_decision']);

/* api.close_company and api.delete_company share one vocabulary, and each has its own rule above it: a closure
   while export_by is still ahead needs customer_instruction (E_EXPORT_WINDOW_OPEN), and a deletion before export_by
   needs the same (E_DELETION_NOT_DUE). Those two rules are the database's; this list is the shape check. */
export const LIFECYCLE_REASON_CODES = Object.freeze(['retention_deadline', 'customer_instruction', 'operator_request']);

export function isCompanyStatus(status) {
  return typeof status === 'string' && COMPANY_STATUSES.includes(status);
}

/** The statuses api.set_company_status and api.close_company can reach from `status`; [] for closed and for junk. */
export function nextStatuses(status) {
  return isCompanyStatus(status) ? NEXT[status] : Object.freeze([]);
}

export function isStatusReasonCode(code) {
  return typeof code === 'string' && STATUS_REASON_CODES.includes(code);
}

export function isLifecycleReasonCode(code) {
  return typeof code === 'string' && LIFECYCLE_REASON_CODES.includes(code);
}

export function isAccessState(state) {
  return typeof state === 'string' && ACCESS_STATES.includes(state);
}

export function isDeletionState(state) {
  return typeof state === 'string' && DELETION_STATES.includes(state);
}

/* One row per consequence design 1.4 names, in the order an admin needs to read them: what stops for everybody
   first, then what stops for the person. `count` is the number the preview answered; `kind` is what a page keys a
   fixed sentence on. A row is earned when its count is above zero, except the two that are facts and not counts. */
const CONSEQUENCES = Object.freeze([
  Object.freeze({ kind: 'last_admin', of: 'isLastAdmin' }),
  Object.freeze({ kind: 'owned_agents', of: 'ownedAgents' }),
  Object.freeze({ kind: 'agent_releases', of: 'currentReleases' }),
  Object.freeze({ kind: 'agent_recipients', of: 'recipients' }),
  Object.freeze({ kind: 'sole_reviewer_roles', of: 'soleHolderOfRoles' }),
  Object.freeze({ kind: 'envelopes_waiting', of: 'envelopesAwaitingARoleTheyHold' }),
  Object.freeze({ kind: 'groups', of: 'groups' }),
  Object.freeze({ kind: 'authorizations', of: 'authorizations' }),
  Object.freeze({ kind: 'drafts', of: 'drafts' }),
  Object.freeze({ kind: 'submitted', of: 'submittedAwaitingReview' }),
]);

const countOf = (preview, of) => {
  if (of === 'isLastAdmin') return preview.isLastAdmin === true ? 1 : 0;
  if (of === 'currentReleases' || of === 'recipients') {
    const agents = Array.isArray(preview.ownedAgents) ? preview.ownedAgents : [];
    let n = 0;
    for (const a of agents) n += Number.isInteger(a?.[of]) ? a[of] : 0;
    return n;
  }
  const v = preview[of];
  if (Array.isArray(v)) return v.length;
  return Number.isInteger(v) ? v : 0;
};

/**
 * departureConsequences(preview) -> [ { kind, count } ], the consequences this departure earns, in reading order.
 * A count of zero is left out. It reads the camelCase answer of GET .../departure, so the page and this rule share
 * one shape; it takes no clock and asserts nothing about when the removal happens, because the preview was true
 * when it was read and a transfer can commit before the admin presses (design 1.4).
 */
export function departureConsequences(preview) {
  if (preview === null || typeof preview !== 'object') return [];
  const out = [];
  for (const c of CONSEQUENCES) {
    const count = countOf(preview, c.of);
    if (count > 0) out.push(Object.freeze({ kind: c.kind, count }));
  }
  return out;
}
