/* Local-stack helpers for the E3 route tests (E3 design section 6, the route cases). They reuse, rather than copy,
   tests/e2/helpers/stack.mjs (configuration from `supabase status`, the seed through tests/db/00-seed.sh, owner SQL,
   real GoTrue sessions) and tests/db/e3-lib.sh (companies provisioned by the seeded operator, members, change requests
   through api.record_review), which are the probes' own fixtures. Every file builds its own users and companies after reseeding: seeded E2
   users are never given another membership, because the E2 probes assume they hold only their own (evidence/
   e3a-recheck.md, reviewer lesson). A user's credential is the seed's, read from the scratch ids file by bash and
   handed to GoTrue as an argument; no credential appears in this tracked file. Nothing here prints a key. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ORIGIN, psqlSession, ROOT, seed, sql, userJwt } from '../../e2/helpers/stack.mjs';

export { ORIGIN, psqlSession, ROOT, sql };

export const SYNTHETIC = readFileSync(join(ROOT, 'tests/native-transfer/passport/fixtures/SYNTHETIC-passport.md'), 'utf8');
export const PROSE = 'It runs when you paste records and ask it to run.';
export const CR = String.fromCharCode(13);
export const MAX_BYTES = 262144;

/* One tests/db/e3-lib.sh function with positional arguments; returns trimmed stdout, throws on failure. */
export function e3lib(script, ...args) {
  const r = spawnSync(
    'bash',
    ['-c', `cd "$0" && source tests/db/lib.sh && source .scratch/e2/ids.env && source tests/db/e3-lib.sh && ${script}`, ROOT, ...args],
    { encoding: 'utf8', env: process.env },
  );
  if (r.status !== 0) throw new Error(`e3-lib failed (exit ${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}

/** Reseed, then, for a fail-before run only, apply the owner SQL named by E3B_AFTER_SEED_SQL (a database mutant the
    next reseed removes). Returns the seeded ids. */
export function reseed() {
  const ids = seed();
  const mutant = process.env.E3B_AFTER_SEED_SQL;
  if (mutant) sql(readFileSync(mutant, 'utf8'));
  return ids;
}

/** A world of fresh synthetic users and companies for one test file. */
export function world(tag, ids) {
  const run = randomBytes(3).toString('hex');
  const users = new Map();
  const user = (who) => {
    if (users.has(who)) return users.get(who);
    const email = `e3b-${tag}-${run}-${who}@example.invalid`;
    const id = e3lib('create_user "$1" "$PW"', email);
    let token = null;
    const u = {
      who,
      id,
      email,
      token: () => {
        token ??= userJwt(email, ids.PW);
        return token;
      },
    };
    users.set(who, u);
    return u;
  };
  const company = (slug, admin) => {
    const id = e3lib('company "$1" "$2"', `e3b-${tag}-${run}-${slug}`, admin.id);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`company ${slug} was not provisioned`);
    return { id, adminMembership: e3lib('membership_of "$1" "$2"', id, admin.id) };
  };
  const member = (companyId, u, roles = '{member}') => e3lib('member "$1" "$2" "$3"', companyId, u.id, roles);
  return { run, user, company, member };
}

/* A candidate-level change request through api.record_review, by the company's independent probe reviewer
   (tests/db/e4-lib.sh). The E4 review seam it replaces is retired (E4 design 2.6 item 8). */
export const requestChanges = (candidateId) => e3lib('request_changes "$1"', candidateId);

/** The synthetic passport with a revision marker, as bytes the gate accepts. */
export function passportText(revision = '0') {
  return SYNTHETIC.replace(PROSE, `${PROSE} Revision ${revision}.`);
}
export const passport = (revision) => Buffer.from(passportText(revision), 'utf8');

/** A passport of exactly 262,144 bytes: prose lines at the end of section 3, then trailing spaces, as the gate accepts
    (the largest fixture of case 20). */
export function largePassport(revision = '0') {
  const base = passportText(revision);
  const line = 'The sorter keeps every record it was given and lists them in order of the first column.\n';
  const at = base.indexOf('## 4.');
  const room = MAX_BYTES - Buffer.byteLength(base) - 100;
  let text = `${base.slice(0, at)}${line.repeat(Math.floor(room / line.length))}\n${base.slice(at)}`;
  text += ' '.repeat(MAX_BYTES - Buffer.byteLength(text));
  if (Buffer.byteLength(text) !== MAX_BYTES) throw new Error('largePassport: not 262,144 bytes');
  return Buffer.from(text, 'utf8');
}

export const key = () => randomUUID();
export const audits = () => Number(sql('select count(*) from app.audit_events'));
export const count = (from) => Number(sql(`select count(*) from ${from}`));

/** Call one route function the way the Netlify adapter hands it a request: a Buffer for a passport route, JSON text
    for a JSON route, the session in the access cookie. */
export function caller(routes, COOKIES, makeRequest) {
  return async (name, { user, params = {}, query = {}, headers = {}, body, contentType } = {}) => {
    const handler = routes[name];
    const h = { ...headers };
    if (user) h.cookie = `${COOKIES.access}=${user.token()}`;
    let raw = null;
    if (body !== undefined) {
      const passportRoute = handler.route.body === 'passport';
      raw = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
      h['content-type'] = contentType ?? (passportRoute ? 'text/markdown' : 'application/json');
    }
    const res = await handler(
      makeRequest({ method: handler.route.method, path: handler.route.path, params, query, headers: h, body: raw }),
    );
    return { status: res.status, body: res.body === null ? null : JSON.parse(res.body), raw: res.body };
  };
}

/** Replace globalThis.fetch for the length of `run`; the hook receives (url, init, original). */
export async function withFetch(hook, run) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => hook(url, init, original);
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/* Attribution of database round trips to the request that made them (case 20): time from the request to the parsed
   answer of every PostgREST call made inside one route call. */
export const attribution = new AsyncLocalStorage();
export function timedFetch(url, init, original) {
  const store = attribution.getStore();
  const t0 = performance.now();
  return original(url, init).then((r) => {
    const json = () =>
      r.json().finally(() => {
        if (store) store.db += performance.now() - t0;
      });
    return { status: r.status, json };
  });
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}
