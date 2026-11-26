import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().authVerify);
export const config = { path: '/api/auth/verify', method: 'POST' };
