import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().reviewQueue);
export const config = { path: '/api/companies/:companyId/review-queue', method: 'GET' };
