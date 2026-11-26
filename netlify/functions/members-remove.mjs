import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().membersRemove);
export const config = { path: '/api/companies/:companyId/members/:membershipId', method: 'DELETE' };
