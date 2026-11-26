/* Audience groups (E4 design 1.7, 3.4 and 3.5 "Group routes"): create a group, add a member, remove a member.

   E2's admin template, as lib/services/members.mjs follows it. The body and the name rule first, decided without the
   database (E_BODY_INVALID, the routine's own answer); the caller's standing in the route's company read under the
   caller's own token (an early E_NOT_FOUND); for a member change, the group and the membership checked to be rows of the
   route's company as the caller sees them, so the URL and the audit row agree (E_NOT_FOUND); then the pure role rule's
   early E_FORBIDDEN, in that order because the routine answers a stranger 404 before it answers a member 403. Then one
   api routine under the unbound server token (callAs), which decides again under the company lock: standing, the admin
   role, aal2 (E_ADMIN_MFA_REQUIRED, which only the database answers), a removed membership, a taken name, the limit.
   E2's retry model, not the claim protocol (design 3.3): a repeated add or remove answers changed false. Results are
   plain data; failures are AppErrors. */

import { callAs } from '../db/server.mjs';
import { select } from '../db/user.mjs';
import { AppError } from '../errors.mjs';
import { groupNameOf } from '../rules/reviews.mjs';
import { isAdmin } from '../rules/roles.mjs';
import { isUuid, loadPrincipal } from './principal.mjs';

async function standing(session, companyId, options) {
  const principal = await loadPrincipal(session, companyId, options);
  if (!principal.ok) throw new AppError(principal.code);
  return principal;
}

function nameOf(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new AppError('E_BODY_INVALID');
  if (Object.keys(body).some((k) => k !== 'name')) throw new AppError('E_BODY_INVALID');
  const name = groupNameOf(body.name);
  if (!name.ok) throw new AppError('E_BODY_INVALID');
  return name.value;
}

/** POST /api/companies/{companyId}/groups, body { name }: { groupId, changed }. */
export async function createGroup(session, { companyId, body }, options) {
  const name = nameOf(body);
  const principal = await standing(session, companyId, options);
  if (!isAdmin(principal.roles)) throw new AppError('E_FORBIDDEN');
  const rows = await callAs(session, 'create_group', { p_company: companyId, p_name: name }, options);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (typeof row?.group_id !== 'string') throw new AppError('E_INTERNAL');
  return { groupId: row.group_id, changed: row.changed === true };
}

async function memberChange(session, fn, { companyId, groupId, membershipId }, options) {
  const principal = await standing(session, companyId, options);
  if (!isUuid(groupId) || !isUuid(membershipId)) throw new AppError('E_NOT_FOUND');
  const [groups, memberships] = await Promise.all([
    select(session, 'groups', { select: 'id', id: `eq.${groupId}`, company_id: `eq.${companyId}` }, options),
    select(session, 'memberships', { select: 'id', id: `eq.${membershipId}`, company_id: `eq.${companyId}` }, options),
  ]);
  if (groups.length !== 1 || memberships.length !== 1) throw new AppError('E_NOT_FOUND');
  if (!isAdmin(principal.roles)) throw new AppError('E_FORBIDDEN');
  const rows = await callAs(session, fn, { p_group: groupId, p_membership: membershipId }, options);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (typeof row?.group_id !== 'string' || typeof row.membership_id !== 'string') throw new AppError('E_INTERNAL');
  return { groupId: row.group_id, membershipId: row.membership_id, changed: row.changed === true };
}

/** PUT /api/companies/{companyId}/groups/{groupId}/members/{membershipId}: { groupId, membershipId, changed }. */
export function addGroupMember(session, ids, options) {
  return memberChange(session, 'add_group_member', ids, options);
}

/** DELETE /api/companies/{companyId}/groups/{groupId}/members/{membershipId}: { groupId, membershipId, changed }. */
export function removeGroupMember(session, ids, options) {
  return memberChange(session, 'remove_group_member', ids, options);
}
