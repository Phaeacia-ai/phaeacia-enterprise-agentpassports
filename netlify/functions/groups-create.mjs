import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().groupsCreate);
export const config = { path: '/api/companies/:companyId/groups', method: 'POST' };
