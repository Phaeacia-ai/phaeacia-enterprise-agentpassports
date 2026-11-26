import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().operatorTransferAdmin);
export const config = { path: '/api/operator/companies/:companyId/transfer-first-admin', method: 'POST' };
