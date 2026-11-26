import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().catalogRead);
export const config = { path: '/api/companies/:companyId/catalog', method: 'GET' };
