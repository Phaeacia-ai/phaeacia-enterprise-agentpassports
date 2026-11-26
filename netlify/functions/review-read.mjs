import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().reviewRead);
export const config = { path: '/api/candidates/:candidateId/review', method: 'GET' };
