import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().agentsTransfer);
export const config = { path: '/api/agents/:agentId/transfer', method: 'POST' };
