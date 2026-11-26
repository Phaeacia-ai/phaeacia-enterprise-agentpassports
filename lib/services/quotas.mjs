/* The admin's view of their company's quotas (E6 design 1.7, 3.4 and 4.1).

   A read for a company admin at aal2, and the aal2 half is tested HERE as well as at the view's own policy
   (E6S-C-F5): without it an admin at aal1 read the view, saw none of the overriding rows it hides at aal1, and
   received the DEFAULTS as if they were the agreement. An admin cannot CHANGE a quota and does not ask through the product,
   because a quota is the commercial agreement, the plan invoices manually, and a self-service raise is a billing
   decision the product does not have. An admin reads them so that "ask Phaeacia to raise this" does not arrive at
   the moment they are already blocked, which in a 25-seat pilot is the middle of an onboarding session.

   Where each number comes from.
     value   app.quota(company, name): the api.company_quotas row when one overrides, else the constant. The view
             carries only the overriding rows, and 008 admits a company admin at aal2 to them (E6D-C-F12 added
             that predicate on 005's accepted precedent). The constants are repeated in DEFAULTS below purely as
             the fallback, and tests/e6/unit pins every one of them equal to the migration's own text.
     source  `company` when a row overrides, `default` otherwise, which is what lets an operator tell "agreed at
             25" from "never discussed" (design 1.7).
     used    the count the routine that refuses would take, for the FOUR company-wide quotas, read here under the
             admin's own token with the paging every list read in this repository uses.
     near    lib/rules/quotas.mjs's one rule, shared with the pages, a WARNING and never a substitute for the
             server's refusal (pages rule 7).

   THE THREE PER-SUBJECT QUOTAS ANSWER `used: null`, and that is a decision with a reason rather than an
   omission. versions_per_agent, downloads_per_recipient and reports_per_recipient are refused against ONE
   agent's or ONE recipient's count, so the honest `used` for them is the largest such count in the company
   (evidence/e6-db.md section 5). Computing it here means reading every candidate version, every ledger row and
   every report of the company under the admin's token and grouping them in Node: at the plan's own envelope that
   is about 7,500 ledger rows, 38 paged reads, for a line no page renders. Design 4.1 renders the seat and
   invitation lines on the members page and the group line on the groups page, and says in as many words that the
   catalog and the release page say nothing, because a recipient is not the person who can act on a download
   quota. So the admin's answer carries the VALUE and the SOURCE for all seven, `perSubject: true` for these
   three and `used: null`, and the page renders no usage for them. The operator register carries the real largest
   count for all seven, computed by aggregates inside the database, which is what a support call needs. Carried
   as E6S-F4 with that consequence. */

import { select } from '../db/user.mjs';
import { AppError } from '../errors.mjs';
import { QUOTA_NAMES, isNear, isPerSubject } from '../rules/quotas.mjs';
import { readAll } from './evidence-reads.mjs';
import { requireAdminPrincipal } from './members.mjs';

/* The seven defaults, which are app.quota_default's, which are the existing app.limit_*() constants; pinned equal
   to the migration's text by tests/e6/unit so the two cannot drift. The database remains the authority and
   refuses against its own number whatever this module says. */
const DEFAULTS = Object.freeze({
  members_per_company: 25,
  pending_invitations_per_company: 50,
  agents_per_company: 50,
  groups_per_company: 50,
  versions_per_agent: 200,
  downloads_per_recipient: 200,
  reports_per_recipient: 20,
});

/* Each ceiling is app.quota_bounds(name)'s own top, so a read that exceeds it is reading a company that cannot
   exist, except for the invitations one. Invitation rows ACCUMULATE: every resend leaves the replaced row behind,
   and an unrevoked row that simply expired stays for ever, so the live bound of 500 does not bound the rows this
   read walks. Four times the live bound is the ceiling, and a company past it answers E_READ_OVER_BOUND rather
   than a count that is silently short (E3b critique F3, E4S-C-F1). Every read pages with readAll, so no sentinel
   depends on a limit above PostgREST's max_rows of 200. */
const CEILINGS = Object.freeze({
  memberships: 500,
  invitations: 2000,
  agents: 500,
  groups: 200,
});

/** readQuotas(session, { companyId }) -> { companyId, quotas: [ { name, value, used, source, near, perSubject } ] } */
export async function readQuotas(session, { companyId }, options) {
  await requireAdminPrincipal(session, companyId, options);
  /* E6S-C-F5. The aal2 test, AFTER membership visibility and the role test, which is the order design 3.1's row
     for this route gives: 404 for a caller with no standing in the company, 403 E_FORBIDDEN for a member who is
     not an admin, then 403 E_ADMIN_MFA_REQUIRED for an admin at aal1. requireAdminPrincipal answers the first
     two and does NOT test the assurance level: there is no later write routine here to repeat the check the way
     every admin mutation has one, because this route only reads.
     Without it the answer was not merely open, it was WRONG. api.company_quotas carries the overriding rows and
     008's company_quotas_member_read admits them at aal2 only, so at aal1 the override read came back empty, the
     map below fell through to DEFAULTS for every name, and an admin whose company had been agreed at 60 groups
     was told 50, with near: false. A read that answers a number nobody agreed is worse than one that refuses.
     The view keeps its own predicate, so the direct read is closed at the database too (008 B3); this is the
     explicit refusal in front of it, which is what makes the answer a code rather than silence. */
  if (session.aal !== 'aal2') throw new AppError('E_ADMIN_MFA_REQUIRED');
  const scope = { company_id: `eq.${companyId}` };
  const [overrideRows, memberships, invitations, agents, groups] = await Promise.all([
    /* app.company_quotas is keyed by (company_id, name) and has no id, so readAll's keyset does not apply and
       none is needed: app.quota_names() bounds the table at seven rows per company by a CHECK, so one read with
       a sentinel of eight is complete by construction and is far under max_rows. An eighth row would mean the
       vocabulary moved without this module, and it answers E_READ_OVER_BOUND rather than a short list. */
    select(
      session,
      'company_quotas',
      { select: 'name,value', ...scope, order: 'name.asc', limit: String(QUOTA_NAMES.length + 1) },
      options,
    ),
    readAll(session, 'memberships', { select: 'id', ...scope, status: 'eq.active' }, CEILINGS.memberships, options),
    /* Live invitations are the accepted count: not accepted, not revoked, not past their expiry. The first two
       are filters the Data API takes; the expiry is a timestamp, and lib/db/user.mjs's value alphabet admits no
       colon or plus, so it is compared here against the rows those filters returned. The comparison is the same
       one api.invite_member makes under the company lock, and that one is the truth. */
    readAll(
      session,
      'invitations',
      { select: 'id,expires_at', ...scope, accepted_at: 'is.null', revoked_at: 'is.null' },
      CEILINGS.invitations,
      options,
    ),
    readAll(session, 'agents', { select: 'id', ...scope }, CEILINGS.agents, options),
    readAll(session, 'groups', { select: 'id', ...scope }, CEILINGS.groups, options),
  ]);
  if (overrideRows.length > QUOTA_NAMES.length) throw new AppError('E_READ_OVER_BOUND');
  const now = Date.now();
  const used = {
    members_per_company: memberships.length,
    pending_invitations_per_company: invitations.filter((i) => Date.parse(i.expires_at) > now).length,
    agents_per_company: agents.length,
    groups_per_company: groups.length,
  };
  const overrides = new Map(overrideRows.map((r) => [r.name, r.value]));
  return {
    companyId,
    quotas: QUOTA_NAMES.map((name) => {
      const value = overrides.has(name) ? overrides.get(name) : DEFAULTS[name];
      if (!Number.isInteger(value)) throw new AppError('E_INTERNAL');
      const perSubject = isPerSubject(name);
      const u = perSubject ? null : used[name];
      return {
        name,
        value,
        used: u,
        source: overrides.has(name) ? 'company' : 'default',
        near: perSubject ? false : isNear(u, value),
        perSubject,
      };
    }),
  };
}

/** The constants this module falls back to, for the unit test that pins them against migration 008's own text. */
export const QUOTA_DEFAULTS = DEFAULTS;
