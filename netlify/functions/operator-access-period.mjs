import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().operatorAccessPeriod);
export const config = { path: '/api/operator/companies/:companyId/access-period', method: 'POST' };
