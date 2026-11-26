/* Browser session verification (E2 design section 6, 1.4 and 4.1).

   Imports node:crypto only. This module is the sole constructor of a
   VerifiedSession and the only holder of the browser's access token. The
   session object is frozen, carries exactly the listed fields, and is
   registered in a module-private WeakSet; `isVerifiedSession()` answers by
   identity, so a lookalike object, a spread copy, a Proxy or a subclass is
   never accepted by `serverToken()` (lib/db/server.mjs) or by the user client
   (lib/db/user.mjs). The access token lives in a module-private WeakMap and is
   read through `accessTokenOf(session)`, so it is never a property that a log
   line or JSON.stringify can pick up.

   verifySession reads only the HTTP-only cookie named COOKIES.access; never an
   Authorization header from the browser. It verifies the signature (HS256
   with SUPABASE_JWT_SECRET, or ES256/RS256 against the project's JWKS, cached
   for at most JWKS_MAX_AGE_SECONDS and refetched at most once a minute on a
   kid miss), then exp, nbf, aud, iss, role and sub, and reads email, aal, amr
   and session_id. It never calls the Auth server per request, never
   refreshes, never caches a result, and never reads user_metadata or
   app_metadata.

   JWKS trust (critique H1, 2026-09-11): a cached key is used only while the
   cache is younger than JWKS_MAX_AGE_SECONDS; past that the JWKS is fetched
   again before any key from it is trusted, so a key removed from the
   project's JWKS stops verifying within that bound. A refetch that fails
   while the cache is stale refuses the token (E_SESSION_INVALID) rather than
   trusting the stale key or throwing. A JWKS that cannot be loaded at all
   (cold cache: the fetch throws, answers non-2xx, or returns a body without
   a keys array) is E_SESSION_UNAVAILABLE, which the pipeline answers as 503;
   verifySession never rejects for a JWKS failure.

   The sign-in helpers below talk to GoTrue's public endpoints with the anon
   key for the server-side flows: start (OTP request, never creates a user),
   verify (token hash from the emailed link; the server sets the cookies,
   the browser never holds a token), refresh and sign-out. Design correction
   marked in section 4.1/6: a browser-side verifyOtp cannot produce the
   HTTP-only cookie session, so verification is server-side by token hash. */

import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';

export const COOKIES = Object.freeze({ access: 'enterprise_access', refresh: 'enterprise_refresh' });

const sessions = new WeakSet();
const tokens = new WeakMap();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALGS = Object.freeze({ HS256: 'hmac', ES256: 'ec', RS256: 'rsa' });
const REFRESH_MAX_AGE = 30 * 24 * 3600;
const JWKS_REFETCH_MIN_MS = 60_000;
/** Longest a cached JWKS is trusted without refetching: the bound on key-removal delay. */
export const JWKS_MAX_AGE_SECONDS = 600;

function env(name) {
  const v = process.env[name];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`E_CONFIG ${name}`);
  return v;
}

export function isVerifiedSession(x) {
  return typeof x === 'object' && x !== null && sessions.has(x);
}

/** The browser's access token for a session this module verified; throws for anything else. */
export function accessTokenOf(session) {
  if (!isVerifiedSession(session)) throw new TypeError('not a VerifiedSession');
  return tokens.get(session);
}

/* ---------- cookies ---------- */

function parseCookies(header) {
  const out = new Map();
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !out.has(k)) out.set(k, v);
  }
  return out;
}

function cookieHeaderOf(request) {
  const h = request?.headers;
  if (!h) return undefined;
  if (typeof h.get === 'function') return h.get('cookie') ?? undefined;
  return h.cookie ?? h.Cookie;
}

const ATTRS = '; Path=/; HttpOnly; Secure; SameSite=Strict';

/** Set-Cookie values for a GoTrue session, or the two clearing cookies when given null. */
export function sessionCookies(session) {
  if (session === null) return [`${COOKIES.access}=; Max-Age=0${ATTRS}`, `${COOKIES.refresh}=; Max-Age=0${ATTRS}`];
  const { accessToken, refreshToken, expiresIn } = session;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') throw new TypeError('session tokens');
  const ttl = Number.isInteger(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
  return [
    `${COOKIES.access}=${accessToken}; Max-Age=${ttl}${ATTRS}`,
    `${COOKIES.refresh}=${refreshToken}; Max-Age=${REFRESH_MAX_AGE}${ATTRS}`,
  ];
}

/* ---------- JWT verification ---------- */

function decodeSegment(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/* loadedAt and attemptedAt are in verifier seconds (the `now` option), so tests drive the
   age without touching the clock. loadedAt is the last successful load; attemptedAt is the
   last refetch attempt (stale reload or kid miss), successful or not, for the throttle. */
let jwksCache = { keys: [], loaded: false, loadedAt: 0, attemptedAt: 0 };

/* The verifier calls it with no signal, as it always has (the request path's key-set fetch has no bound, ALD-F15,
   and the alerts design does not change that); signingKeysReady passes its own. */
async function defaultFetchJwks(signal) {
  const r = await fetch(`${env('SUPABASE_URL')}/auth/v1/.well-known/jwks.json`, {
    headers: { apikey: env('SUPABASE_ANON_KEY') },
    signal,
  });
  if (!r.ok) throw new Error(`E_JWKS ${r.status}`);
  return r.json();
}

/** The check-in's bound on its own key-set load, in milliseconds (the alerts design 1.8). */
export const KEY_SET_TIMEOUT_MS = 3000;
/* The codes the "Session keys" line may name: the network errnos a fetch can carry, and E_SESSION_UNAVAILABLE for
   everything else, which is the verifier's own word for "the signing keys could not be loaded". */
const KEY_SET_CODES = Object.freeze([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * signingKeysReady({ fetchJwks }) -> Promise<{ ok: true } | { ok: false, code }>
 * The key-set load the verifier makes on a cold start, without a token and without touching the verifier's cache:
 * `ok` when the project's key set answers with a keys array, which is the verifier's own test (a cold load that fails
 * it is E_SESSION_UNAVAILABLE, the fault behind the `session_unavailable` alert). The default fetch carries a
 * KEY_SET_TIMEOUT_MS bound; a timeout is ETIMEDOUT. Never rejects. Read by the check-in's "Session keys" line
 * (docs/e7/alerts-and-checkin-design.md 1.8), which reaches it through lib/http/checkin.mjs because lib/services/
 * may not reach this module.
 */
export async function signingKeysReady({
  fetchJwks = () => defaultFetchJwks(AbortSignal.timeout(KEY_SET_TIMEOUT_MS)),
} = {}) {
  try {
    const doc = await fetchJwks();
    return Array.isArray(doc?.keys) ? { ok: true } : { ok: false, code: 'E_SESSION_UNAVAILABLE' };
  } catch (e) {
    if (e?.name === 'TimeoutError') return { ok: false, code: 'ETIMEDOUT' };
    const code = typeof e?.cause?.code === 'string' ? e.cause.code : null;
    return { ok: false, code: code !== null && KEY_SET_CODES.includes(code) ? code : 'E_SESSION_UNAVAILABLE' };
  }
}

class JwksUnavailable extends Error {}

/* findJwk(kid, kty, fetchJwks, now) -> jwk | null. Throws JwksUnavailable only when there is no
   loaded cache and the JWKS cannot be fetched or is not a key set.
   - cold cache: load; a failure is JwksUnavailable (503 at the pipeline);
   - cache older than JWKS_MAX_AGE_SECONDS: reload before trusting any key; a failed reload
     returns null (the stale key is not used; the caller refuses);
   - kid miss on a fresh cache (key rotation): refetch, then decide from the fresh set.
   Refetches of both kinds are attempted at most once per minute, so neither unknown kids nor
   a JWKS outage with a stale cache turns the verifier into a JWKS request generator; while
   throttled, a stale cache refuses and a fresh one answers from what it has. */
async function findJwk(kid, kty, fetchJwks, now) {
  const pick = () => jwksCache.keys.find((k) => k?.kid === kid && k?.kty === kty) ?? null;
  const throttled = () => now - jwksCache.attemptedAt < JWKS_REFETCH_MIN_MS / 1000;
  const load = async () => {
    const doc = await fetchJwks();
    if (!Array.isArray(doc?.keys)) throw new JwksUnavailable('jwks body');
    jwksCache = { keys: doc.keys, loaded: true, loadedAt: now, attemptedAt: jwksCache.attemptedAt };
  };
  const refetch = async () => {
    jwksCache = { ...jwksCache, attemptedAt: now };
    try {
      await load();
      return true;
    } catch {
      return false;
    }
  };
  if (!jwksCache.loaded) {
    try {
      await load();
    } catch {
      throw new JwksUnavailable('jwks load');
    }
  } else if (now - jwksCache.loadedAt > JWKS_MAX_AGE_SECONDS) {
    if (throttled() || !(await refetch())) return null;
  }
  const k = pick();
  if (k) return k;
  if (throttled() || !(await refetch())) return null;
  return pick();
}

async function signatureValid(header, signingInput, signature, fetchJwks, now) {
  const kind = ALGS[header.alg];
  if (!kind) return false;
  const sig = Buffer.from(signature, 'base64url');
  if (sig.length === 0) return false;
  const data = Buffer.from(signingInput);
  if (kind === 'hmac') {
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (typeof secret !== 'string' || secret.length < 32) return false;
    const expected = createHmac('sha256', secret).update(data).digest();
    return expected.length === sig.length && timingSafeEqual(expected, sig);
  }
  if (typeof header.kid !== 'string') return false;
  const jwk = await findJwk(header.kid, kind === 'ec' ? 'EC' : 'RSA', fetchJwks, now);
  if (!jwk) return false;
  let key;
  try {
    key = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return false;
  }
  try {
    return kind === 'ec'
      ? cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)
      : cryptoVerify('sha256', data, key, sig);
  } catch {
    return false;
  }
}

/**
 * verifySession(request) -> { ok: true, session } | { ok: false, code }
 * codes: E_NO_SESSION | E_SESSION_EXPIRED | E_SESSION_INVALID | E_SESSION_UNAVAILABLE
 * E_SESSION_UNAVAILABLE means the signing keys could not be loaded, not that the token is bad.
 */
export async function verifySession(
  request,
  { now = Math.floor(Date.now() / 1000), fetchJwks = defaultFetchJwks } = {},
) {
  const token = parseCookies(cookieHeaderOf(request)).get(COOKIES.access);
  if (!token) return { ok: false, code: 'E_NO_SESSION' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, code: 'E_SESSION_INVALID' };
  const [h, p, s] = parts;
  const header = decodeSegment(h);
  const claims = decodeSegment(p);
  if (!header || !claims || (header.typ !== 'JWT' && header.typ !== undefined))
    return { ok: false, code: 'E_SESSION_INVALID' };
  let valid;
  try {
    valid = await signatureValid(header, `${h}.${p}`, s, fetchJwks, now);
  } catch (e) {
    if (e instanceof JwksUnavailable) return { ok: false, code: 'E_SESSION_UNAVAILABLE' };
    throw e;
  }
  if (!valid) return { ok: false, code: 'E_SESSION_INVALID' };
  const issuer = `${env('SUPABASE_URL')}/auth/v1`;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    claims.iss !== issuer ||
    !aud.includes('authenticated') ||
    claims.role !== 'authenticated' ||
    claims.is_anonymous === true ||
    typeof claims.sub !== 'string' ||
    !UUID.test(claims.sub) ||
    !Number.isFinite(claims.exp)
  )
    return { ok: false, code: 'E_SESSION_INVALID' };
  if (claims.exp <= now) return { ok: false, code: 'E_SESSION_EXPIRED' };
  /* A present nbf must be a number (critique L2): a string or null nbf is malformed, not absent. */
  if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now))
    return { ok: false, code: 'E_SESSION_INVALID' };
  const aal = claims.aal === 'aal2' ? 'aal2' : 'aal1';
  const amr = Array.isArray(claims.amr)
    ? claims.amr.map((m) => (typeof m?.method === 'string' ? m.method : 'unknown'))
    : [];
  const session = Object.freeze({
    authUserId: claims.sub.toLowerCase(),
    email: typeof claims.email === 'string' ? claims.email : '',
    /* GoTrue issues no session to an unconfirmed account while confirmations are required
       (design 4.1, probes 11b and 11c), so a verified session implies a confirmed address; the
       claim is not read from user_metadata, which the user can edit. The database checks
       auth.users.email_confirmed_at itself where it matters (accept_invitation). */
    emailConfirmed: amr.length > 0,
    aal,
    amr: Object.freeze(amr),
    sessionId: typeof claims.session_id === 'string' ? claims.session_id : '',
    expiresAt: claims.exp,
  });
  sessions.add(session);
  tokens.set(session, token);
  return { ok: true, session };
}

/* ---------- GoTrue public endpoints (anon key) for the server-side sign-in flows ---------- */

async function gotrue(path, { method = 'POST', body, bearer } = {}) {
  const headers = { apikey: env('SUPABASE_ANON_KEY'), 'content-type': 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const r = await fetch(`${env('SUPABASE_URL')}/auth/v1${path}`, {
    method,
    headers,
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

function tokensOf(json) {
  if (typeof json?.access_token !== 'string' || typeof json?.refresh_token !== 'string') return null;
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: json.expires_in };
}

/** Request a sign-in link for an existing confirmed account. Always `{ ok: true }`, and the route always answers
 *  204 (no account enumeration); GoTrue's own refusal for unknown or unconfirmed addresses is not surfaced.
 *  `limited` is true when GoTrue answered 429 (lane K3, XR-3): its per-address limits see the functions' shared
 *  egress address and its email limit is per project, so a 429 can mean nobody is getting a link, and until K3 it
 *  was invisible. The route logs it and raises the `signin_limited` alert with nothing of the address; the person
 *  still sees the confirmation every address sees. This module imports nothing (scripts/check-imports.mjs), which
 *  is why the line and the alert are the route's and not written here. */
export async function startSignIn(email) {
  const { status } = await gotrue('/otp', { body: { email, create_user: false } });
  return { ok: true, limited: status === 429 };
}

/** Exchange the emailed token hash for a session. type: 'magiclink' | 'signup' | 'recovery' | 'email'. */
export async function verifyTokenHash({ tokenHash, type }) {
  if (typeof tokenHash !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(tokenHash))
    return { ok: false, code: 'E_AUTH_INVALID' };
  if (!['magiclink', 'signup', 'recovery', 'email'].includes(type)) return { ok: false, code: 'E_AUTH_INVALID' };
  const { json } = await gotrue('/verify', { body: { type, token_hash: tokenHash } });
  const t = tokensOf(json);
  return t ? { ok: true, tokens: t } : { ok: false, code: 'E_AUTH_INVALID' };
}

export async function refreshSession(refreshToken) {
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) return { ok: false, code: 'E_AUTH_INVALID' };
  const { json } = await gotrue('/token?grant_type=refresh_token', { body: { refresh_token: refreshToken } });
  const t = tokensOf(json);
  return t ? { ok: true, tokens: t } : { ok: false, code: 'E_AUTH_INVALID' };
}

/** End this device's session at GoTrue, and no other device's (Q10, pages design 2.5). scope=local
 *  deletes the one auth.sessions row that the bearer's session_id claim names, so that session's
 *  refresh token can no longer be exchanged, and leaves every other session of the account in place
 *  (GoTrue v2.192.0 logout.go 32 to 33 and 55 to 56, sessions.go 362 to 365). A bearer naming no
 *  session would fall through to the account-wide delete (logout.go 51 to 52 and 63 to 64); GoTrue
 *  mints no access token without one (tokens/service.go 661 to 663). Best effort: the cookies are
 *  cleared regardless of the answer. */
export async function signOut(session) {
  const token = accessTokenOf(session);
  const { status } = await gotrue('/logout?scope=local', { bearer: token });
  return { ok: status === 204 || status === 200 };
}

/** Cookie value of the refresh token, for the refresh handler only. */
export function refreshTokenOf(request) {
  return parseCookies(cookieHeaderOf(request)).get(COOKIES.refresh) ?? null;
}
