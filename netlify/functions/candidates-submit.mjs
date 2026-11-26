import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().candidatesSubmit);
export const config = { path: '/api/candidates/:candidateId/submit', method: 'POST' };
