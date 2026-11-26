import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().groupMembersRemove);
export const config = { path: '/api/companies/:companyId/groups/:groupId/members/:membershipId', method: 'DELETE' };
