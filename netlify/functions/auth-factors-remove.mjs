import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().factorsRemove);
export const config = { path: '/api/auth/factors/:factorId', method: 'DELETE' };
