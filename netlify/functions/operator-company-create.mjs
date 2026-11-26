import { alert } from '../../lib/http/alerts.mjs';
import { toNetlify } from '../../lib/http/netlify.mjs';
import { makeRoutes } from '../../lib/http/routes.mjs';
import { mailTransport } from '../../lib/services/mail.mjs';

export default toNetlify(makeRoutes({ alert, mail: mailTransport() }).operatorCompanyCreate);
export const config = { path: '/api/operator/companies', method: 'POST' };
