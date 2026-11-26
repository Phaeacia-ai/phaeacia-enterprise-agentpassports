import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().invitationsAccept);
export const config = { path: '/api/invitations/accept', method: 'POST' };
