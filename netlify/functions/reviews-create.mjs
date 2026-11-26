import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().reviewsCreate);
export const config = { path: '/api/candidates/:candidateId/reviews', method: 'POST' };
