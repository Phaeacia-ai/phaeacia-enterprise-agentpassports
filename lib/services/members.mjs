/* Membership operations (E2 design sections 3, 6 and 8.3): set roles, remove.

   Sequence per request (architecture section 5 as amended): the handler
   verified the session; loadPrincipal reads the caller's standing in the
   route's company with the user token (early 404); the pure rule gives an
   early refusal; the target is checked to belong to the route's company
   (case 21) so the URL and the audit row always agree; then one api function
   runs under a server token minted from the same session, and the database
   decides again under the company lock (standing, admin role, aal2, last
   admin). Results are plain data; failures are AppErrors. */

import { callAs } from '../db/server.mjs';
import { select } from '../db/user.mjs';
import { AppError } from '../errors.mjs';
import { isAdmin, normalizeRoles } from '../rules/roles.mjs';
import { isUuid, loadPrincipal } from './principal.mjs';

/** Caller's principal in the company, refused early unless an active admin. The database repeats
 *  the check (E_NOT_FOUND, E_FORBIDDEN, E_ADMIN_MFA_REQUIRED) authoritatively. `options` is threaded to the
 *  standing read as every other service threads it, so a caller can supply its own fetch (E6, tests/e6/unit). */
export async function requireAdminPrincipal(session, companyId, options) {
  const p = await loadPrincipal(session, companyId, options);
  if (!p.ok) throw new AppError(p.code);
  if (!isAdmin(p.roles)) throw new AppError('E_FORBIDDEN');
  return p;
}

/** The target membership must be a row of the route's company as the caller sees it (RLS). */
async function requireMembershipInCompany(session, companyId, membershipId) {
  if (!isUuid(membershipId)) throw new AppError('E_NOT_FOUND');
  const rows = await select(session, 'memberships', {
    select: 'id',
    id: `eq.${membershipId}`,
    company_id: `eq.${companyId}`,
  });
  if (rows.length !== 1) throw new AppError('E_NOT_FOUND');
}

export async function setRoles(session, { companyId, membershipId, roles }) {
  await requireAdminPrincipal(session, companyId);
  const n = normalizeRoles(roles);
  if (!n.ok) throw new AppError('E_ROLES_INVALID');
  await requireMembershipInCompany(session, companyId, membershipId);
  const [row] = await callAs(session, 'set_roles', { p_membership: membershipId, p_roles: n.roles });
  return { membershipId: row.membership_id, roles: row.roles, changed: row.changed === true };
}

export async function removeMember(session, { companyId, membershipId }) {
  await requireAdminPrincipal(session, companyId);
  await requireMembershipInCompany(session, companyId, membershipId);
  const [row] = await callAs(session, 'remove_member', { p_membership: membershipId });
  return { membershipId: row.membership_id, status: row.status, changed: row.changed === true };
}
