import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().candidatesList);
export const config = { path: '/api/companies/:companyId/candidates', method: 'GET' };
