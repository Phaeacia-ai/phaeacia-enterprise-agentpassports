/* The user's own client (E2 design sections 2, 6 and 8.1): GET on the api
   views with the browser's GoTrue token, so RLS evaluates the caller's
   current membership and company status at statement time. Reads only; no
   other verb exists here. The token is obtained through lib/session.mjs
   from a VerifiedSession, never passed in by a caller. */

import { AppError, dbErrorCode } from '../errors.mjs';
import { accessTokenOf } from '../session.mjs';

const VIEWS = new Set([
  'companies',
  'memberships',
  'profiles',
  'invitations',
  'audit_events',
  // E3 (migration 003, security_invoker views): read by lib/services/candidates.mjs under RLS (design 4.1).
  'agents',
  'candidate_versions',
  'candidate_contributors',
  'gate_identities',
  'gate_identity_files',
  /* E4 design 2.6 item 2. Migration 006 part A creates the first five views; the last four are part B's, and until
     part B lands a read of one reaches no view and answers E_INTERNAL like any failed read. */
  'groups',
  'group_members',
  'release_targets',
  'installer_texts',
  'release_policies',
  'review_envelopes',
  'reviews',
  'releases',
  'release_downloads',
  /* E4D-C-F1 (migration 006 part B): the agent-wide independence set, membership ids and kinds only, for the review read's
     viewer verdict (lent to the E4 server lane by the lead, 2026-09-15). */
  'agent_reviewer_exclusions',
  /* E5 design 2.6 item 2 (migration 007). release_catalog is api.releases with three computed columns, so a read of it
     is decided by the same row level security as a read of api.releases; the two evidence views carry E5's own
     policies. */
  'release_catalog',
  'installation_reports',
  'installation_witnesses',
  /* E6 design 2.6 item 2, landed by the lead before construction: the caller's standing with its access state, and a
     company's quotas with usage. Neither view exists before the lifecycle migration. */
  'my_standing',
  'company_quotas',
]);
const PARAM_KEY = /^[a-z_]{1,40}$/;
/* PostgREST filter values: `eq.<uuid>`, `in.(a,b)`, `is.null`, `select=id,roles`. Logic-tree
   parameters (`or`, `and`, `not`) and anything outside this alphabet are refused so a
   caller cannot compose a filter the service did not write. */
const PARAM_VALUE = /^[A-Za-z0-9_.,()-]{1,400}$/;
/* The one longer value (pages design 2.2, option (A), decided by the lead 2026-09-13): an in.(...) list of one to
   UUID_LIST_MAX lowercase uuids, matched exactly, which the member list's display-name read needs for up to 150 users
   (4 + 37n characters, so the bound above admits ten). Nothing else long is admitted: a longer list, an empty or
   doubled item, a capital, a space, or anything before in.( or after ) is judged by PARAM_VALUE exactly as before. The
   alphabet is unchanged, so a caller still cannot compose a filter the service did not write. 150 is this client's
   own protective ceiling, written here rather than imported from LIST_BOUNDS in lib/services/, which would add an edge
   from lib/db/ back to lib/services/. Written without a backslash: lib/ refuses escape sequences. */
const UUID_LIST_MAX = 150;
const LOWER_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_LIST = new RegExp(`^in[.][(]${LOWER_UUID}(?:,${LOWER_UUID}){0,${UUID_LIST_MAX - 1}}[)]$`);
const LOGIC = new Set(['or', 'and', 'not']);

function env(name) {
  const v = process.env[name];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`E_CONFIG ${name}`);
  return v;
}

/** select(session, view, params) -> rows. params: { select: 'a,b', column: 'eq.value', ... } */
export async function select(session, view, params = {}, { fetchImpl = fetch } = {}) {
  const token = accessTokenOf(session);
  if (!VIEWS.has(view)) throw new TypeError(`user client: ${String(view)} is not a readable view`);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (!PARAM_KEY.test(k) || LOGIC.has(k) || typeof v !== 'string' || !(PARAM_VALUE.test(v) || UUID_LIST.test(v)))
      throw new TypeError(`user client: refused filter ${k}`);
    qs.set(k, v);
  }
  const query = qs.toString();
  const r = await fetchImpl(`${env('SUPABASE_URL')}/rest/v1/${view}${query ? `?${query}` : ''}`, {
    method: 'GET',
    headers: { apikey: env('SUPABASE_ANON_KEY'), authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  let body = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  if (r.status >= 200 && r.status < 300 && Array.isArray(body)) return body;
  /* A read that fails is an internal condition: the token is verified and the views are
     granted; the status is kept, and of the body only the database's code (dbErrorCode). */
  throw new AppError('E_INTERNAL', { postgrestStatus: r.status, dbCode: dbErrorCode(body) });
}
