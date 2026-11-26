import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().factorsList);
export const config = { path: '/api/auth/factors', method: 'GET' };
