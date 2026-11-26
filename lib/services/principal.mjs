/* loadPrincipal (E2 design section 6; E6 design 1.1, 1.5 and 3.5): the caller's current membership in the
   requested company, read with the user's own token, loaded once per request and never cached.

   Since E6 the read is api.my_standing and not api.memberships. api.memberships admits a row only through
   app.is_active_member, which requires the company to be ACTIVE, so a member of a suspended company read an empty
   list and this loader could not tell a suspension from a foreign id: the same person met 409 E_COMPANY_INACTIVE on
   a write, from app.lock_company, and 404 E_NOT_FOUND on a read. api.my_standing is the one read in the product
   that sees past a company's status, and it is scoped to auth.uid() by the definer function behind it, so it
   discloses the caller's own memberships and nothing else.

   The order of the four answers is design 1.5's and the reason for each:
     1. no row                        404 E_NOT_FOUND       the view already filters active memberships, so a
                                                            removed one is no row (E6D-C-F6 settled in 008)
     2. company_status = 'closed'     409 E_COMPANY_INACTIVE closure is terminal; there is nothing to wait for
     3. access_state = 'expired'      409 E_ACCESS_PERIOD_ENDED  ABOVE the suspension test on purpose: a company
                                                            the sweep suspended because its period expired should
                                                            say why, and one the operator suspended inside its
                                                            window should say that instead
     4. company_status <> 'active'    409 E_COMPANY_INACTIVE the operator's own quarantine
   The expired test is computed from TIME inside app.access_state and never from companies.status, so the read
   boundary at export_by does not wait for api.operator_expiry_run to have been pressed (E6D-C-F3, case 38).

   Why the row-keyed routes still answer 404, stated here because this is the boundary that decides it. A route
   that names a company, /api/companies/:companyId/..., reaches this loader with the company id from the URL, so it
   can be told the company's state. A route keyed by a row, /api/candidates/:id, /api/releases/:id,
   /api/installations/:id/witness, resolves the row FIRST, under RLS with the user's own token, and only then knows
   which company to ask about. For a suspended or closed company that row read is already empty, because every E3
   to E5 policy requires app.is_active_member, so the route answers 404 and never reaches this loader: the 404 is
   RLS's answer and not a second visibility rule written here. Making those routes answer 409 would need a definer
   read per request that tells a caller who guesses a uuid that the row exists, which is exactly the refusal-order
   rule E5S-F10 established (design 1.1). A company PAST ITS EXPORT WINDOW is still active, so its rows are still
   visible, the route does reach this loader, and E_ACCESS_PERIOD_ENDED is the honest answer there: the caller has
   already proved they may read the row, so nothing is disclosed by naming the window.

   The service's callers throw AppError(principal.code) rather than a fixed E_NOT_FOUND, so the two new codes reach
   the client on every company-scoped route, read and write. */

import { select } from '../db/user.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(x) {
  return typeof x === 'string' && UUID.test(x);
}

/**
 * loadPrincipal(session, companyId)
 *   -> { ok: true, authUserId, membershipId, roles, aal, companyStatus, accessState }
 *    | { ok: false, code: 'E_NOT_FOUND' | 'E_COMPANY_INACTIVE' | 'E_ACCESS_PERIOD_ENDED' }
 */
export async function loadPrincipal(session, companyId, options) {
  if (!isUuid(companyId)) return { ok: false, code: 'E_NOT_FOUND' };
  const rows = await select(
    session,
    'my_standing',
    {
      select: 'membership_id,roles,membership_status,company_status,access_state,company_name',
      company_id: `eq.${companyId}`,
    },
    options,
  );
  const m = rows.find(
    (r) => r?.membership_status === 'active' && typeof r.membership_id === 'string' && Array.isArray(r.roles),
  );
  if (!m) return { ok: false, code: 'E_NOT_FOUND' };
  if (m.company_status === 'closed') return { ok: false, code: 'E_COMPANY_INACTIVE' };
  if (m.access_state === 'expired') return { ok: false, code: 'E_ACCESS_PERIOD_ENDED' };
  if (m.company_status !== 'active') return { ok: false, code: 'E_COMPANY_INACTIVE' };
  return {
    ok: true,
    authUserId: session.authUserId,
    membershipId: m.membership_id,
    roles: [...m.roles],
    aal: session.aal,
    companyStatus: m.company_status,
    accessState: typeof m.access_state === 'string' ? m.access_state : 'none',
    /* E7 2.6 item 3: the company's display name for the invitation mail's one arbitrary slot (E7 1.1). */
    companyName: typeof m.company_name === 'string' ? m.company_name : null,
  };
}
