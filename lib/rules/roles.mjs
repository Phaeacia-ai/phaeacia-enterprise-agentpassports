/* Role vocabulary and normalisation, pure (E2 design sections 2, 4 and 10 scenario C).

   Mirrors app.role_names() and app.normalize_roles() for early refusals and UI
   hints; SQL is authoritative and decides again after the company lock. A
   stack test compares ROLE_NAMES with the database function so drift fails
   the check. No IO here; lib/rules imports nothing. */

export const ROLE_NAMES = Object.freeze(['member', 'it_reviewer', 'business_reviewer', 'company_admin']);
export const ADMIN_ROLE = 'company_admin';

/**
 * normalizeRoles(input) -> { ok: true, roles } | { ok: false, code: 'E_ROLES_INVALID' }
 * Same contract as app.normalize_roles: a flat array of known role names; null, a non-array,
 * a nested array, a null or non-string element and an unknown name are invalid; the empty
 * array means "member only"; the result is the sorted distinct set with member present.
 */
export function normalizeRoles(input) {
  if (!Array.isArray(input)) return { ok: false, code: 'E_ROLES_INVALID' };
  for (const r of input) {
    if (typeof r !== 'string' || !ROLE_NAMES.includes(r)) return { ok: false, code: 'E_ROLES_INVALID' };
  }
  const roles = [...new Set(['member', ...input])].sort();
  return { ok: true, roles };
}

export function isAdmin(roles) {
  return Array.isArray(roles) && roles.includes(ADMIN_ROLE);
}
