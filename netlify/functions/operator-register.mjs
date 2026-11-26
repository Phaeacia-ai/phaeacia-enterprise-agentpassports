import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().operatorRegister);
export const config = { path: '/api/operator/companies', method: 'GET' };
