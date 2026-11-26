import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().operatorCompanyClose);
export const config = { path: '/api/operator/companies/:companyId/close', method: 'POST' };
