import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().meDisplayName);
export const config = { path: '/api/me/display-name', method: 'PUT' };
