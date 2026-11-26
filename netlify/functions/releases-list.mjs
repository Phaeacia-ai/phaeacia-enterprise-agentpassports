import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().releasesList);
export const config = { path: '/api/companies/:companyId/releases', method: 'GET' };
