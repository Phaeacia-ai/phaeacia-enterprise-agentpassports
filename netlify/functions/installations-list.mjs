import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().installationsList);
export const config = { path: '/api/releases/:releaseId/installations', method: 'GET' };
