import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().releasesPublish);
export const config = { path: '/api/candidates/:candidateId/releases', method: 'POST' };
