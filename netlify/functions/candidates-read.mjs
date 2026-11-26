import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().candidatesRead);
export const config = { path: '/api/candidates/:candidateId', method: 'GET' };
