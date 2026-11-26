import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().operatorExpiryRun);
export const config = { path: '/api/operator/expiry-run', method: 'POST' };
