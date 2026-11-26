/* The departure preview (E6 design 1.4, 3.4 and 3.5).

   One read, api.departure_preview, for a company admin at aal2. E6 changes nothing about api.remove_member: the
   two effects a departure has beyond the status column, deleting the person's group rows and orphaning the agents
   they own, were designed and tested where they landed with a stated re-run condition, and adding to the routine
   would reopen that condition for every accepted slice. What E6 adds is the READ the admin sees first.

   Why it is one definer read and not eight round trips: the counts cross tables whose RLS an admin satisfies
   individually, but eight separate reads have no consistent moment between them. api.departure_preview is
   `language sql stable`, ONE statement whose eight aggregates are scalar subqueries, so every number comes from
   one snapshot (E6D-C-F9: a VOLATILE plpgsql body taking eight separate SELECTs under read committed takes a new
   snapshot per statement, and two of its numbers can then come from two different moments).

   It is still a PREVIEW AND NOT A PROMISE. A transfer, a role change or a removal can commit between this read
   and the admin pressing Remove, and the page says the counts were true when the page loaded. It takes no lock,
   writes nothing and writes no audit row.

   The refusals are app.require_admin's, which is the accepted idiom and the database lane's amendment 4 to design
   case 18: an unknown membership is 404, a caller with no standing in its company is 404, a member of that
   company who is not an admin is 403 E_FORBIDDEN, and an admin without a second factor is 403
   E_ADMIN_MFA_REQUIRED. Design case 18's control expected 404 for the plain member and is the thing that needs
   correcting, because every other admin-only routine in the product answers E_FORBIDDEN there. */

import { callAs } from '../db/server.mjs';
import { select } from '../db/user.mjs';
import { AppError } from '../errors.mjs';
import { requireAdminPrincipal } from './members.mjs';
import { isUuid } from './principal.mjs';

/**
 * departurePreview(session, { companyId, membershipId }) -> design 3.4's answer without its ok.
 *
 * It is a company-scoped route, so it loads the principal first and therefore answers 409 E_COMPANY_INACTIVE for
 * a suspended or closed company and 409 E_ACCESS_PERIOD_ENDED past export_by, which is design 3.1's row for it.
 * Then the target membership is checked to belong to the route's company under the caller's own token, so the URL
 * and what is previewed always agree, which is case 21's rule for every membership route since E2. Then the
 * routine, which repeats the admin test and the second factor authoritatively.
 */
export async function departurePreview(session, { companyId, membershipId }, options) {
  if (!isUuid(companyId) || !isUuid(membershipId)) throw new AppError('E_NOT_FOUND');
  await requireAdminPrincipal(session, companyId, options);
  const rows = await select(
    session,
    'memberships',
    { select: 'id', id: `eq.${membershipId}`, company_id: `eq.${companyId}` },
    options,
  );
  if (rows.length !== 1) throw new AppError('E_NOT_FOUND');
  const answer = await callAs(session, 'departure_preview', { p_membership: membershipId }, options);
  if (answer === null || typeof answer !== 'object') throw new AppError('E_INTERNAL');
  return shapeOf(answer, companyId, membershipId);
}

/* The database answers snake_case (evidence/e6-db.md section 5) and design 3.4's route answer is camelCase. The
   mapping is written out rather than derived, because this one is the members page's whole contract and every
   name in it is a fixed sentence's subject. */
function shapeOf(a, companyId, membershipId) {
  if (a.membership_id !== membershipId) throw new AppError('E_NOT_FOUND');
  return {
    companyId,
    membershipId: a.membership_id,
    roles: a.roles ?? [],
    status: a.status,
    label: a.label ?? null,
    isLastAdmin: a.is_last_admin === true,
    soleHolderOfRoles: a.sole_holder_of_roles ?? [],
    groups: (a.groups ?? []).map((g) => ({ groupId: g.group_id, name: g.name })),
    ownedAgents: (a.owned_agents ?? []).map((g) => ({
      agentId: g.agent_id,
      name: g.name,
      status: g.status,
      currentReleases: g.current_releases,
      recipients: g.recipients,
    })),
    drafts: a.drafts,
    submittedAwaitingReview: a.submitted_awaiting_review,
    envelopesAwaitingARoleTheyHold: a.envelopes_awaiting_a_role_they_hold,
    authorizations: a.authorizations,
    reports: a.reports,
    witnesses: a.witnesses,
    publishedReleases: a.published_releases,
  };
}
