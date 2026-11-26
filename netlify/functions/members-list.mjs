import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().membersList);
export const config = { path: '/api/companies/:companyId/members', method: 'GET' };
