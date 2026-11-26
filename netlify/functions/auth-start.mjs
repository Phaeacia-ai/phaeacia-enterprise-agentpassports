import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().authStart);
export const config = { path: '/api/auth/start', method: 'POST' };
