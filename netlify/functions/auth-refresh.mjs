import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().authRefresh);
export const config = { path: '/api/auth/refresh', method: 'POST' };
