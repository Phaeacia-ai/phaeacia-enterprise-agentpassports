import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().membersDeparture);
export const config = { path: '/api/companies/:companyId/members/:membershipId/departure', method: 'GET' };
