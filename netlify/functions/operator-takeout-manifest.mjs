import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().operatorTakeoutManifest);
export const config = { path: '/api/operator/companies/:companyId/takeout-manifest', method: 'GET' };
