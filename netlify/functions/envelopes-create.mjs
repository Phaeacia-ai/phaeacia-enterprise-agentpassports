import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';

export default toNetlify(makeRoutes().envelopesCreate);
export const config = { path: '/api/candidates/:candidateId/envelopes', method: 'POST' };
