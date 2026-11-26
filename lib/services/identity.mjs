/* The caller's identity and memberships (pages design 2.1; E6 design 1.1, 1.5 and 3.4).

   user.id, user.email and user.aal come from the VerifiedSession lib/session.mjs built from this request's
   GoTrue-signed access token; they are never read from the database, from GoTrue's user endpoint or from the request.
   The address is for display only, and nothing authorizes on it. The display name goes to its owner only and is
   never logged.

   Since E6 this is TWO user-client reads and not three: the caller's own standing through api.my_standing, which
   carries the membership, the company's slug, name and status and the company's access state in one row, and the
   caller's own profile, which profiles_comember_read always admits. The memberships-and-companies pair it replaces
   admitted a row only through app.is_active_member in an ACTIVE company, so a suspended or closed company
   disappeared from the person's list entirely and the home page said the account had no active company membership,
   which is false and unexplained (design 1.1). It also needed a drop-and-truncate step, because a membership whose
   company was missing from the second read had to be dropped and the answer called partial; one statement cannot
   disagree with itself, so that step is gone and `truncated` is now the one read's own.

   companyStatus and accessState are two fields and not one, because a company the operator suspended inside its
   window and one whose agreement simply ran out are different facts and the home page says a different true
   sentence for each (design 1.5, 3.4). The view filters ACTIVE memberships inside the definer door (E6D-C-F6,
   settled in 008), so a company the person has left is not listed at all; `membership_status` is always 'active'
   and is kept in the shape because both loaders' branches are written against it.

   The order is the company's name and then the membership id. api.my_standing carries no created_at, so the
   membership-creation order the two-read version had is not available from it; a name order is stable, is the order
   the companies read already used, and ends with an id so equal names cannot move a row between two identical
   requests. */

import { select } from '../db/user.mjs';
import { LIST_BOUNDS, readList } from './directory.mjs';

/** loadIdentity(session): the answer of GET /api/me without its ok. */
export async function loadIdentity(session) {
  const standing = await readList(
    session,
    'my_standing',
    {
      select: 'membership_id,company_id,company_slug,company_name,company_status,access_state,roles',
      order: 'company_name.asc,membership_id.asc',
    },
    LIST_BOUNDS.personMemberships,
  );
  const profile = await select(session, 'profiles', {
    select: 'display_name',
    user_id: `eq.${session.authUserId}`,
    limit: '1',
  });
  return {
    user: {
      id: session.authUserId,
      email: session.email,
      aal: session.aal,
      displayName: typeof profile[0]?.display_name === 'string' ? profile[0].display_name : null,
    },
    memberships: standing.rows.map((m) => ({
      membershipId: m.membership_id,
      companyId: m.company_id,
      companySlug: m.company_slug,
      companyName: m.company_name,
      companyStatus: m.company_status,
      accessState: m.access_state,
      roles: m.roles,
    })),
    truncated: standing.truncated,
  };
}
