import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().factorsVerify);
export const config = { path: '/api/auth/factors/:factorId/verify', method: 'POST' };
