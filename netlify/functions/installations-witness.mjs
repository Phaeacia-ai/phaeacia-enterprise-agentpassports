import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().installationsWitness);
export const config = { path: '/api/installations/:reportId/witness', method: 'POST' };
