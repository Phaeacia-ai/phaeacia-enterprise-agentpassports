/* Agent ownership transfer (E6 design 1.3, 3.4 and 3.5).

   One routine, api.transfer_agent, unbound, called through callAs with the unbound bearer as E2's admin routines
   and E4's three group routines are. It is unbound by decision and not by omission (design 3.3): a transfer
   carries no free text, so two calls with the same arguments are the same operation, and its three ordered
   branches express the postcondition exactly. The E3 claim protocol would spend a per-membership ceiling of
   4,000 unexpired rows on an admin action to say what three comparisons say.

   Who may transfer: the agent's CURRENT owner at any aal while their membership is active and the agent is
   active, or a company admin at aal2. An orphaned agent has no active owner, so only the admin path reaches it,
   and an archived agent is refused. The operator may not, for any company: an operator transfer would need the
   operator to read the company's agent list and its member list in order to choose, which is exactly the tenant
   content design 1.1 refuses, and the lever for a company with no admin who can reach aal2 is
   api.transfer_first_admin and then this routine.

   AUTHORITY IS READ FROM THE LOCKED ROW, which is E6D-C-F2 and the reason rows 18, 21 and 22 of design 3.5
   moved: the first version of the routine re-read the caller's membership after the company lock and then used
   it in a comparison without testing it, so a caller removed while the lock was waited on produced NULL = owner,
   `if not (NULL)` never ran, and the departed caller transferred the agent. The routine now refuses `me.id is
   null` on its own line and evaluates the owner arm from the agent row it locked. p_expected_owner is a
   stale-retry guard and is never authority: it is the caller's own input, and nothing here treats it otherwise.

   The one read before the call is the agent under the caller's own token, so RLS decides visibility and a caller
   with no standing in the agent's company meets 404 without the routine running at all (design 3.5 row 11). */

import { callAs } from '../db/server.mjs';
import { select } from '../db/user.mjs';
import { AppError } from '../errors.mjs';
import { isUuid } from './principal.mjs';

/** readAgent(session, agentId): the agent as its own company's members may read it, or E_NOT_FOUND. */
export async function readAgent(session, { agentId }, options) {
  if (!isUuid(agentId)) throw new AppError('E_NOT_FOUND');
  const rows = await select(
    session,
    'agents',
    { select: 'id,company_id,name,status,owner_membership_id,creator_membership_id', id: `eq.${agentId}` },
    options,
  );
  if (rows.length !== 1) throw new AppError('E_NOT_FOUND');
  const a = rows[0];
  return {
    agentId: a.id,
    companyId: a.company_id,
    name: a.name,
    status: a.status,
    ownerMembershipId: a.owner_membership_id,
    creatorMembershipId: a.creator_membership_id,
  };
}

/**
 * transferAgent(session, { agentId, toMembershipId, expectedOwnerMembershipId })
 *   -> { agentId, ownerMembershipId, agentStatus, changed }
 * An orphaned agent returns to `active` here and nowhere else, so every release of it becomes downloadable again
 * at the next read with no new review, no new release row and no notice to any recipient: app.download_refusal_for
 * reads app.agents.status live, and that is E1 section 7's sentence implemented as a join rather than as a
 * withdrawal.
 */
export async function transferAgent(session, { agentId, toMembershipId, expectedOwnerMembershipId }, options) {
  if (!isUuid(agentId)) throw new AppError('E_NOT_FOUND');
  if (!isUuid(toMembershipId) || !isUuid(expectedOwnerMembershipId)) throw new AppError('E_BODY_INVALID');
  /* Row 11 of design 3.5: the agent is located under the caller's own token first, so a caller who cannot see it
     learns nothing about who owns what. The routine repeats the test authoritatively under the lock. */
  await readAgent(session, { agentId }, options);
  const [row] = await callAs(
    session,
    'transfer_agent',
    { p_agent: agentId, p_to_membership: toMembershipId, p_expected_owner: expectedOwnerMembershipId },
    options,
  );
  return {
    agentId: row.agent_id,
    ownerMembershipId: row.owner_membership_id,
    agentStatus: row.agent_status,
    changed: row.changed === true,
  };
}
