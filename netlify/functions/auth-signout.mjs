import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().authSignout);
export const config = { path: '/api/auth/signout', method: 'POST' };
