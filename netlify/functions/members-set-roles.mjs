import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().membersSetRoles);
export const config = { path: '/api/companies/:companyId/members/:membershipId/roles', method: 'PATCH' };
