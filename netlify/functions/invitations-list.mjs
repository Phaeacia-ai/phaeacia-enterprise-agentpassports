import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().invitationsList);
export const config = { path: '/api/companies/:companyId/invitations', method: 'GET' };
