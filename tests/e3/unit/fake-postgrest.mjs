/* A PostgREST double and a verified session for the E3 service and route unit tests. No stack. Importing this module
   sets the environment lib/ reads, so import it before any lib/ module. Every read and every call is recorded, so a
   test states which requests were made and in what order. */
import { createHash } from 'node:crypto';

import { hs256, userClaims } from '../../e2/helpers/jwt.mjs';

const SECRET = 'example-unit-secret-with-at-least-32-characters-long';
export const BASE = 'http://127.0.0.1:54321';
process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = SECRET;
process.env.ENTERPRISE_ACCESS_STATE = 'open';
delete process.env.ENTERPRISE_SERVER_SIGNING_ALG;
delete process.env.ENTERPRISE_ORIGIN;

const { COOKIES, verifySession } = await import('../../../lib/session.mjs');
export const manifest = await import('../../../lib/passport/gate-manifest.mjs');
export { COOKIES };

export const SUB = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11';
export const COMPANY = '2a5d1b3c-4e6f-4a8b-9c0d-1e2f3a4b5c6d';
export const MEMBERSHIP = '3b6e2c4d-5f70-4b9c-8d1e-2f3a4b5c6d7e';
export const OTHER_MEMBERSHIP = '4c7f3d5e-6081-4cad-9e2f-3a4b5c6d7e8f';
export const AGENT = '5d8a4e6f-7192-4dbe-8f3a-4b5c6d7e8f90';
export const CANDIDATE = '6e9b5f70-82a3-4ecf-9a4b-5c6d7e8f9a01';
export const GATE_ID = '7fa06a81-93b4-4fd0-8b5c-6d7e8f9a0b12';
export const OLD_GATE_ID = '80b17b92-a4c5-4ae1-9c6d-7e8f9a0b1c23';
export const KEY = '91c28ca3-b5d6-4bf2-8d7e-8f9a0b1c2d34';
export const STORED_AT = '2026-09-13T08:00:00.000Z';
export const PROSE = 'It runs when you paste records and ask it to run.';
/* The bytea prefix PostgREST writes, built from code points like the rest of the invisible characters here. */
export const X = String.fromCharCode(92, 120);
export const OTHER_IDENTITY = 'e'.repeat(64);

export const sha = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
export const userToken = hs256(userClaims({ sub: SUB, email: 's@example.invalid', issuer: `${BASE}/auth/v1` }), SECRET);
export const session = (await verifySession({ headers: { cookie: `${COOKIES.access}=${userToken}` } })).session;
if (!session) throw new Error('fake-postgrest: the unit session did not verify');

export const gateRow = (over = {}) => ({
  id: GATE_ID,
  identity_sha256: `${X}${manifest.GATE_IDENTITY_SHA256}`,
  adapter_lock_sha256: `${X}${manifest.ADAPTER_LOCK_SHA256}`,
  validator_version: manifest.VALIDATOR_VERSION,
  manifest_sha256: `${X}${manifest.MANIFEST_SHA256}`,
  upstream_commit: manifest.UPSTREAM_COMMIT,
  registered_at: '2026-09-13T07:00:00.123456+00:00',
  active: true,
  ...over,
});
export const oldGateRow = () =>
  gateRow({
    id: OLD_GATE_ID,
    identity_sha256: `${X}${OTHER_IDENTITY}`,
    adapter_lock_sha256: `${X}${'a'.repeat(64)}`,
    manifest_sha256: `${X}${'b'.repeat(64)}`,
    validator_version: '0.0.9',
    active: false,
  });

/** A routine's answer, as app.candidate_response builds it. */
export const answer = (over = {}, content = '') => ({
  candidate_id: CANDIDATE,
  agent_id: AGENT,
  company_id: COMPANY,
  sequence: 1,
  version: 1,
  state: 'draft',
  content_sha256: sha(content),
  derived_sha256: 'd'.repeat(64),
  gate_identity_sha256: manifest.GATE_IDENTITY_SHA256,
  validated_at: STORED_AT,
  supersedes_candidate_id: null,
  submitted_at: null,
  idempotent_replay: false,
  ...over,
});

/* Since E6 loadPrincipal reads api.my_standing and not api.memberships (E6 design 1.1). A test that has not said
   otherwise gets its standing DERIVED from the memberships fixture it already writes: the same membership, in a
   company that is active and inside its access period, which is what the memberships fixture meant. A test that
   wants a suspended, closed or expired company writes `tables.my_standing` itself and this derivation steps aside.
   Deriving rather than adding a second default is deliberate: three slices of accepted tests set `memberships` to
   say "no standing", "removed" or "an it_reviewer", and every one of those sentences stays true here. */
const standingFrom = (rows) =>
  rows.map((m) => ({
    membership_id: m.id,
    company_id: COMPANY,
    company_slug: 'synthetic-unit',
    company_name: 'SYNTHETIC Unit AG',
    company_status: 'active',
    access_state: 'current',
    membership_status: m.status,
    roles: m.roles,
  }));

/** Reads answer from `tables` (rows, or a function of the query parameters); calls answer from `rpc`. */
/* `claim` answers ENA-7's api.claim_invitation_handover (migration 011): granted by default, so a handover path keeps
   its signing link unless a case says otherwise; a function receives (body, claims). */
export function fakeDb({ tables = {}, rpc = () => answer(), claim = true } = {}) {
  const calls = [];
  const defaults = {
    memberships: [{ id: MEMBERSHIP, roles: ['member'], status: 'active' }],
    gate_identities: [gateRow()],
  };
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    const name = u.pathname.split('/').pop();
    if (init.method === 'GET') {
      const params = Object.fromEntries(u.searchParams);
      calls.push({ read: name, params, auth: init.headers.authorization });
      if (name === 'my_standing' && !Object.hasOwn(tables, 'my_standing')) {
        const source = Object.hasOwn(tables, 'memberships') ? tables.memberships : defaults.memberships;
        const rows = standingFrom(typeof source === 'function' ? source(params) : source);
        return { status: 200, json: async () => rows };
      }
      const t = Object.hasOwn(tables, name) ? tables[name] : (defaults[name] ?? []);
      const rows = typeof t === 'function' ? t(params) : t;
      return { status: 200, json: async () => rows };
    }
    const body = JSON.parse(init.body);
    const claims = JSON.parse(Buffer.from(init.headers.authorization.split(' ')[1].split('.')[1], 'base64url'));
    calls.push({ rpc: name, body, claims });
    if (name === 'claim_invitation_handover')
      return { status: 200, json: async () => (typeof claim === 'function' ? claim(body, claims) : claim) };
    return { status: 200, json: async () => rpc(name, body, claims) };
  };
  return { calls, options: { fetchImpl }, fetchImpl };
}

/** An assert.rejects / assert.throws validator for one AppError code. */
export const refusal = (code) => (e) => {
  if (e?.code !== code) throw new Error(`expected ${code}, got ${e?.code}: ${e?.message}`);
  return true;
};
