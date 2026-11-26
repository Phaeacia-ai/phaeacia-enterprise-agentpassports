/* Quota rules, pure (E6 design 1.7, 2.1). No IO, no client, no environment: lib/rules holds the arithmetic a page
   and a service must agree on, and nothing else.

   The seven names are app.quota_names() in migration 008 and the order is that array's, because the register and
   GET /api/companies/{id}/quotas both answer them in it. The VALUE of a quota is never here: a company's value is
   app.quota(company, name) in the database, falling through to app.limit_*() when no row overrides it, and there is
   one reader precisely so that no call site gains a second source of truth (design 1.7). What is here is what the
   database cannot answer for a page: which name is a per-subject quota, so a page can say "the busiest agent has
   198 of 200" rather than pretending 198 is the company's total, and where the warning line begins.

   near is `used >= ceil(value * NEAR_FRACTION)`, design 1.7's sentence, in one place so the members page, the groups
   page and the operator register cannot drift. It is a WARNING and never a substitute for the server's refusal: at
   the limit the page shows the refusal beside the control that caused it (pages rule 7). */

export const NEAR_FRACTION = 0.8;

export const QUOTA_NAMES = Object.freeze([
  'members_per_company',
  'pending_invitations_per_company',
  'agents_per_company',
  'groups_per_company',
  'versions_per_agent',
  'downloads_per_recipient',
  'reports_per_recipient',
]);

/* The three whose `used` is the LARGEST such count in the company and not a company total, because the refusal
   compares one agent's or one recipient's (evidence/e6-db.md section 5, app.quota_used). A page that renders
   "23 of 25 used" for one of these without saying whose is telling the reader something untrue. */
export const PER_SUBJECT_QUOTAS = Object.freeze([
  'versions_per_agent',
  'downloads_per_recipient',
  'reports_per_recipient',
]);

/* The label a page puts beside a number. Fixed sentences, in the register of lib/errors.mjs: what the number counts,
   not what the column is called. */
const LABELS = Object.freeze({
  members_per_company: 'People in this company',
  pending_invitations_per_company: 'Open invitations',
  agents_per_company: 'Agents',
  groups_per_company: 'Groups',
  versions_per_agent: 'Versions of one agent',
  downloads_per_recipient: 'Downloads of one release by one person',
  reports_per_recipient: 'Installation reports of one release by one person',
});

/** Whether `name` is one of the seven. Anything else is refused before a call (422 E_BODY_INVALID). */
export function isQuotaName(name) {
  return typeof name === 'string' && QUOTA_NAMES.includes(name);
}

/** Whether `used` counts one subject (an agent, a recipient) rather than the whole company. */
export function isPerSubject(name) {
  return PER_SUBJECT_QUOTAS.includes(name);
}

/** The fixed label, or null for a name outside the vocabulary. */
export function quotaLabel(name) {
  return isQuotaName(name) ? LABELS[name] : null;
}

/** design 1.7: `used >= ceil(value * 0.8)`. False for a value that is not a positive integer count. */
export function isNear(used, value) {
  if (!Number.isInteger(used) || !Number.isInteger(value) || value < 1 || used < 0) return false;
  return used >= Math.ceil(value * NEAR_FRACTION);
}
