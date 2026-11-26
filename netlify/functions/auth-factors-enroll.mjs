import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().factorsEnroll);
export const config = { path: '/api/auth/factors/totp', method: 'POST' };
