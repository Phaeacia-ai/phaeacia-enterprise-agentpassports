/* E7-20's third arm, the adapter's catch, as a child process (E7 design 1.5). toNetlify takes no deps, so there is no
   capture seam in it: the alert goes to the child's stderr, which is what the case reads. The handler is a WRAPPER
   that throws before the pipeline runs, with a thrown value named and coded by a synthetic string, and the request
   carries the same strings in its body, query and headers. The child prints nothing of its own to stderr, so every
   stderr line it writes is the product's. Run: node tests/e7/fixtures/adapter-escaped.mjs */
import { toNetlify } from '../../../lib/http/netlify.mjs';
import { makeRoutes } from '../../../lib/http/routes.mjs';

const STRINGS = JSON.parse(process.env.E7_STRINGS);
const COMPANY = 'bbbbbbbb-2222-4333-8444-555555555555';

/* A named route from makeRoutes(), then a stand-in for its handler that throws where the adapter's catch is the only
   boundary left: toNetlify checks route and routeName, so the stand-in carries the real ones. */
const real = makeRoutes().membersList;
const throwing = () => {
  const e = new Error(`escaped: ${STRINGS[0]} for ${STRINGS[1]}`);
  e.name = `${STRINGS[2]}-name`;
  e.code = `${STRINGS[3]}-code`;
  e.details = `row: ${STRINGS[0]}`;
  e.stack = `Error: ${STRINGS[0]}\n    at wrapper (${STRINGS[3]})`;
  throw e;
};
Object.defineProperty(throwing, 'route', { value: real.route, enumerable: true });
Object.defineProperty(throwing, 'routeName', { value: real.routeName, enumerable: true });

const res = await toNetlify(throwing)(
  new Request(`https://enterprise.example.invalid/api/companies/${COMPANY}/members?note=${encodeURIComponent(STRINGS[0])}`, {
    method: 'GET',
    headers: {
      'x-nf-request-id': '01JA-child-arm',
      'x-synthetic-header': STRINGS[1],
      cookie: `sb-access-token=${STRINGS[2]}`,
    },
  }),
  { params: { companyId: COMPANY } },
);
process.stdout.write(`${JSON.stringify({ status: res.status, body: await res.text() })}\n`);
