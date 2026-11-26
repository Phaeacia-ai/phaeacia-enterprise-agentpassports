/* Stack helpers for the pages construction cases (pages design 7.2). They reuse tests/e2/helpers/stack.mjs (the
   configuration from `supabase status`, the seed, owner SQL) and tests/db/lib.sh with tests/db/e3-lib.sh (accounts
   through the admin API, companies provisioned by the seeded operator). A new account's credential is the seed's,
   read from the scratch ids file by bash and handed to GoTrue as an argument; none appears in this tracked file.
   Sessions a case needs GoTrue to know are made the way a returning person signs in: an admin-generated magic link
   exchanged through the authVerify route (S12's method). Nothing here prints a token, a secret, a URI or a key. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { mintUserToken, ROOT, sql, stackEnv } from './stack.mjs';

export { mintUserToken, ROOT, sql };

/** SHA-256 of supabase/config.toml, the configuration S4, S4m and S11 record they ran against. */
export const configSha256 = () =>
  createHash('sha256')
    .update(readFileSync(join(ROOT, 'supabase', 'config.toml')))
    .digest('hex');

/** One tests/db/e3-lib.sh or lib.sh function with positional arguments, the seeded ids in scope; trimmed stdout. */
export function shell(script, ...args) {
  const r = spawnSync(
    'bash',
    [
      '-c',
      `cd "$0" && source tests/db/lib.sh && source .scratch/e2/ids.env && source tests/db/e3-lib.sh && ${script}`,
      ROOT,
      ...args,
    ],
    { encoding: 'utf8', env: process.env },
  );
  if (r.status !== 0) throw new Error(`shell failed (exit ${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}

/* ---------- TOTP (RFC 6238 with the parameters GoTrue v2.192.0 uses: SHA-1, 30 seconds, six digits) ---------- */

function base32(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of text.replace(/=+$/, '')) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret, atMs = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const h = createHmac('sha1', base32(secret)).update(counter).digest();
  const o = h[19] & 15;
  const n = (((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000;
  return String(n).padStart(6, '0');
}

/** A six-digit code no period from one before to one after accepts, so a wrong guess can never be a valid one. */
export function wrongCode(secret, atMs = Date.now()) {
  const valid = new Set([-1, 0, 1, 2].map((k) => totp(secret, atMs + k * 30_000)));
  let n = Number.parseInt(randomBytes(3).toString('hex'), 16) % 1_000_000;
  while (valid.has(String(n).padStart(6, '0'))) n = (n + 1) % 1_000_000;
  return String(n).padStart(6, '0');
}

/* ---------- calling route functions with cookies ---------- */

/** Which route call a fetch belongs to, so a case can attribute every GoTrue request (S4's unattended-DELETE check). */
export const attribution = new AsyncLocalStorage();

export const cookieValue = (cookies, name) =>
  new RegExp(`^${name}=([^;]*);`).exec(cookies.find((c) => c.startsWith(`${name}=`)) ?? '')?.[1];

export const claimsOf = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

/** call(name, { access, refresh, params, body, headers, method }) through a route function; records every answer. */
export function caller(routes, { COOKIES, makeRequest }) {
  const answers = [];
  const call = async (name, { access, refresh, params = {}, body, headers = {}, method, rawBody } = {}) => {
    const handler = routes[name];
    const h = { ...headers };
    const jar = [];
    if (access) jar.push(`${COOKIES.access}=${access}`);
    if (refresh) jar.push(`${COOKIES.refresh}=${refresh}`);
    if (jar.length) h.cookie = jar.join('; ');
    if ((body !== undefined || rawBody !== undefined) && h['content-type'] === undefined)
      h['content-type'] = 'application/json';
    const request = makeRequest({
      method: method ?? handler.route.method,
      path: handler.route.path,
      params,
      headers: h,
      body: rawBody ?? (body === undefined ? null : JSON.stringify(body)),
    });
    const res = await attribution.run({ route: name }, () => handler(request));
    const answer = {
      route: name,
      status: res.status,
      body: res.body === null ? null : JSON.parse(res.body),
      raw: res.body,
      cookies: res.cookies,
      headers: res.headers,
      access: cookieValue(res.cookies, COOKIES.access),
      refresh: cookieValue(res.cookies, COOKIES.refresh),
    };
    answers.push(answer);
    return answer;
  };
  return { call, answers };
}

/* ---------- accounts and sessions ---------- */

/** A fresh synthetic account through the admin API; returns { id, email }. */
export function newAccount(tag) {
  const email = `pages-${tag}-${randomBytes(3).toString('hex')}@example.invalid`;
  const id = shell('create_user "$1" "$PW"', email);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`account ${tag} was not created`);
  return { id, email };
}

/** A GoTrue session for an account, made through a magic link and the authVerify route: { access, refresh }. */
export async function linkSession(call, email) {
  const { generateLink } = await import('../../../lib/db/operator.mjs');
  const link = await generateLink({ email, type: 'magiclink' });
  if (!link.ok) throw new Error('magic link not generated');
  const verified = await call('authVerify', { body: { tokenHash: link.hashedToken, type: 'magiclink' } });
  if (verified.status !== 204 || !verified.access || !verified.refresh)
    throw new Error(`link not exchanged: ${verified.status}`);
  return { access: verified.access, refresh: verified.refresh };
}

/** The aal verifySession reads from an access cookie, or null when it does not verify. */
export async function aalOf(access) {
  const { COOKIES, verifySession } = await import('../../../lib/session.mjs');
  const v = await verifySession({ headers: { cookie: `${COOKIES.access}=${access}` } });
  return v.ok ? v.session.aal : null;
}

/** A VerifiedSession for an access token, for calling a service or a scratch copy directly. */
export async function sessionOf(access) {
  const { COOKIES, verifySession } = await import('../../../lib/session.mjs');
  const v = await verifySession({ headers: { cookie: `${COOKIES.access}=${access}` } });
  if (!v.ok) throw new Error(`session did not verify: ${v.code}`);
  return v.session;
}

/** GoTrue's public API called directly with a bearer, as an API client outside this site would (S11b, S4m). */
export async function gotrueDirect(method, path, bearer, body) {
  stackEnv();
  const headers = { apikey: process.env.SUPABASE_ANON_KEY, 'content-type': 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1${path}`, {
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
  return { status: r.status, json, headers: r.headers };
}

/* ---------- scratch copies ---------- */

/** A copy of a lib/ module with exact one-occurrence replacements, loaded so that it shares every other module instance
    with the real tree (its relative imports are rewritten to the real files' URLs), so a VerifiedSession passes its
    brand check. Used for "the branch removed in a scratch copy" (S2, S3). */
export async function scratchCopy(rel, replacements) {
  let text = readFileSync(join(ROOT, rel), 'utf8');
  for (const [from, to] of replacements) {
    if (text.split(from).length !== 2) throw new Error(`scratchCopy: ${JSON.stringify(from)} does not occur once`);
    text = text.replace(from, to);
  }
  const base = pathToFileURL(join(ROOT, rel)).href;
  text = text.replace(/from '(\.\.?\/[^']+)'/g, (_, spec) => `from '${new URL(spec, base).href}'`);
  const dir = join(ROOT, '.scratch', 'pages-server', `copy-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, rel.split('/').pop());
  writeFileSync(file, text);
  return import(pathToFileURL(file).href);
}

/* ---------- S7: addresses in answers, by route and field ---------- */

function leaves(value, path = '', out = []) {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) leaves(value[i], `${path}[${i}]`, out);
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) leaves(v, `${path}.${k}`, out);
  return out;
}

/**
 * Findings for one answer; an empty list is a pass. The permitted fields are exactly: me user.email; members
 * members[].label.value when the label is self on the viewer's own row, or invitation_email while the viewer may read
 * labels at aal2; invitations invitations[].email; the enrolment answer's top-level uri. user.displayName and a
 * display_name label are compared with the stored name of that user (storedNames: userId -> name) instead of scanned,
 * since a name its owner wrote may hold '@'. Every other string of every answer holds no '@'.
 */
export function addressFindings(route, body, { storedNames = new Map() } = {}) {
  const findings = [];
  if (body === null) return findings;
  const nameOf = (userId) => (storedNames.has(userId) ? storedNames.get(userId) : null);
  if (route === 'me' && body.user) {
    const stored = nameOf(body.user.id);
    if ((body.user.displayName ?? null) !== stored) findings.push('.user.displayName is not the stored name');
  }
  if (route === 'membersList' && Array.isArray(body.members)) {
    body.members.forEach((m, i) => {
      if (m.label?.kind === 'display_name' && m.label.value !== nameOf(m.userId))
        findings.push(`.members[${i}].label.value is not the stored name`);
    });
  }
  for (const [path, value] of leaves(body)) {
    if (!value.includes('@')) continue;
    if (route === 'me' && path === '.user.email') continue;
    if (route === 'me' && path === '.user.displayName') continue;
    if (route === 'invitationsList' && /^\.invitations\[\d+\]\.email$/.test(path)) continue;
    if (route === 'factorsEnroll' && path === '.uri') continue;
    const label = /^\.members\[(\d+)\]\.label\.value$/.exec(path);
    if (route === 'membersList' && label) {
      const member = body.members[Number(label[1])];
      const kind = member.label.kind;
      if (kind === 'display_name') continue;
      if (kind === 'self' && member.membershipId === body.viewer?.membershipId) continue;
      if (kind === 'invitation_email' && body.viewer?.mayReadLabels === true && body.viewer?.aal === 'aal2') continue;
    }
    findings.push(`${path} holds an address`);
  }
  return findings;
}

/** Log lines: none may carry '@' or any of the given secret strings. */
export function logFindings(entries, secrets) {
  const text = JSON.stringify(entries);
  const out = [];
  if (text.includes('@')) out.push('a log line carries @');
  for (const s of secrets)
    if (typeof s === 'string' && s.length >= 6 && text.includes(s)) out.push('a log line carries a secret');
  return out;
}

/** lib/ and netlify/ files that name a string, for S11h's "no second reader" check. */
export function sourcesNaming(needle) {
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${name.name}`;
      if (name.isDirectory()) walk(rel);
      else if (name.name.endsWith('.mjs') && readFileSync(join(ROOT, rel), 'utf8').includes(needle)) hits.push(rel);
    }
  };
  walk('lib');
  walk('netlify');
  return hits;
}

/* Nearest-rank percentile over sorted samples: the smallest sample with at least p percent of samples at or below it. */
export function percentile(sorted, p) {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export { mintUserToken as mint };
