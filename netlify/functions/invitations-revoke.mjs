import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().invitationsRevoke);
export const config = { path: '/api/companies/:companyId/invitations/:invitationId/revoke', method: 'POST' };
