/* The service-role client (E2 design section 1.1, fourth credential place).

   The only holder of SUPABASE_SERVICE_ROLE_KEY. Its one E2 use is
   createInviteeAccount() in lib/services/invitations.mjs, which needs
   GoTrue's admin generate_link because public signup is closed (H1). The
   client refuses any path outside /auth/v1/admin/ before a request is built,
   so it cannot be pointed at the Data API even by mistake; the key has no
   grants there anyway (probe 9c). The key never appears in an error, a log
   or a return value. Importers: lib/operator/, scripts/, tests/ and
   lib/services/invitations.mjs only (scripts/check-imports.mjs).

   Path guard (critique M1, 2026-09-11): the path is judged after URL
   normalization, not as text. It must be an absolute path with no
   percent-encoding, backslash, "..", query or fragment; the URL built from it
   against SUPABASE_URL must keep the configured origin, must normalize to the
   same path, and that path must start with the admin prefix and name an
   operation. `/auth/v1/admin/%2e%2e/rest/v1/companies` normalizes to
   `/rest/v1/companies` and is refused before any fetch. */

const ADMIN_PREFIX = '/auth/v1/admin/';

function adminUrl(path, base) {
  const refuse = () => new TypeError(`operator client: only ${ADMIN_PREFIX} paths are permitted`);
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw refuse();
  if (/[%\\?#]/.test(path) || path.includes('..')) throw refuse();
  let url;
  let origin;
  try {
    url = new URL(path, base);
    origin = new URL(base).origin;
  } catch {
    throw refuse();
  }
  if (url.origin !== origin || url.username || url.password || url.search || url.hash) throw refuse();
  if (url.pathname !== path) throw refuse();
  if (!url.pathname.startsWith(ADMIN_PREFIX) || url.pathname.length <= ADMIN_PREFIX.length) throw refuse();
  return url;
}

function env(name) {
  const v = process.env[name];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`E_CONFIG ${name}`);
  return v;
}

/** adminRequest(path, { method, body }) -> { status, json }. path: an operation under
 *  /auth/v1/admin/, judged after normalization (see adminUrl); anything else throws before a fetch. */
export async function adminRequest(path, { method = 'POST', body } = {}, { fetchImpl = fetch } = {}) {
  const url = adminUrl(path, env('SUPABASE_URL'));
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const r = await fetchImpl(url.href, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  return { status: r.status, json };
}

/** GoTrue admin generate_link: creates the account for a new address (hook-gated, unconfirmed,
 *  no password) and returns the single-use link material; a magiclink for an existing account.
 *  GoTrue's answer is the account with the link fields beside it; emailConfirmedAt is the account's own field,
 *  null when absent, which lib/services/invitations.mjs reads in handover mode (ENA-7, CR-ENA7-3). */
export async function generateLink({ email, type = 'magiclink', redirectTo }, options) {
  const body = { type, email };
  if (redirectTo) body.redirect_to = redirectTo;
  const { status, json } = await adminRequest('/auth/v1/admin/generate_link', { body }, options);
  if (status < 200 || status >= 300 || typeof json?.hashed_token !== 'string') return { ok: false, status };
  return {
    ok: true,
    userId: typeof json.id === 'string' ? json.id : null,
    hashedToken: json.hashed_token,
    verificationType: typeof json.verification_type === 'string' ? json.verification_type : null,
    actionLink: typeof json.action_link === 'string' ? json.action_link : null,
    emailConfirmedAt: typeof json.email_confirmed_at === 'string' ? json.email_confirmed_at : null,
  };
}
