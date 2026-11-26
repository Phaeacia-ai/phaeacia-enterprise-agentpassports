/* Local-stack helpers for the E2 integration tests. Reuses tests/db/lib.sh (user minting, SQL
   through the project's own database container, the seed) by sourcing it in bash, so the seed
   and the identities are the probes' own; nothing here duplicates them. Keys are read from
   `supabase status` at run time and placed in process.env for lib/; they are never printed. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hs256, userClaims } from './jwt.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const ORIGIN = 'https://enterprise.example.invalid';
let env = null;

function statusEnv() {
  const r = spawnSync('supabase', ['status', '-o', 'env'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0)
    throw new Error('E2 stack: local Supabase is not running (supabase start); skipping is not a pass');
  const out = {};
  for (const line of r.stdout.split('\n')) {
    const m = /^([A-Z_]+)="?([^"]*)"?$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  for (const k of ['API_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'JWT_SECRET']) {
    if (!out[k]) throw new Error(`E2 stack: supabase status did not report ${k}`);
  }
  return out;
}

/** Load the local stack's configuration into process.env for lib/ and return non-secret facts. */
export function stackEnv() {
  if (!env) {
    env = statusEnv();
    process.env.SUPABASE_URL = env.API_URL;
    process.env.SUPABASE_ANON_KEY = env.ANON_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.SERVICE_ROLE_KEY;
    process.env.SUPABASE_JWT_SECRET = env.JWT_SECRET;
    process.env.ENTERPRISE_ACCESS_STATE = 'open';
    process.env.ENTERPRISE_ORIGIN = ORIGIN;
    delete process.env.ENTERPRISE_SERVER_SIGNING_ALG;
  }
  const projectId = /project_id *= *"([^"]+)"/.exec(readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8'))?.[1];
  return { apiUrl: env.API_URL, projectId, dbContainer: `supabase_db_${projectId}` };
}

/** Run one function of tests/db/lib.sh with arguments; returns trimmed stdout, throws on failure. */
export function libsh(fn, ...args) {
  const r = spawnSync('bash', ['-c', 'cd "$0" && source tests/db/lib.sh && "$@"', ROOT, fn, ...args], {
    encoding: 'utf8',
    env: process.env,
  });
  if (r.status !== 0) throw new Error(`lib.sh ${fn} failed (exit ${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}

/** Reset and seed through tests/db/00-seed.sh; returns the seeded ids. */
export function seed() {
  stackEnv();
  mkdirSync(join(ROOT, '.scratch', 'e2'), { recursive: true });
  const r = spawnSync('bash', ['tests/db/00-seed.sh'], { cwd: ROOT, encoding: 'utf8', env: process.env });
  writeFileSync(join(ROOT, '.scratch', 'e2', 'seed-node.log'), `${r.stdout}\n${r.stderr}`);
  if (r.status !== 0) throw new Error(`seed failed (exit ${r.status}); see .scratch/e2/seed-node.log`);
  const ids = {};
  for (const line of readFileSync(join(ROOT, '.scratch', 'e2', 'ids.env'), 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) ids[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return ids;
}

export const sql = (query) => libsh('sql', '-c', query);
export const userJwt = (email, password) => libsh('user_jwt', email, password);

/** A GoTrue-shaped access token minted with the local secret: the only local way to a session at
 *  aal2 (no TOTP enrolment exists on the local stack; the hosted flow is section 11 work). */
export function mintUserToken({ sub, email, aal, ttl }) {
  stackEnv();
  return hs256(userClaims({ sub, email, aal, issuer: `${env.API_URL}/auth/v1`, ttl }), env.JWT_SECRET);
}

/** The DB container's psql, kept open: run statements over time (lock holders for cases 22 and 26). */
export function psqlSession() {
  const { dbContainer } = stackEnv();
  const child = spawn('docker', ['exec', '-i', dbContainer, 'psql', '-U', 'postgres', '-X', '-At'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    out += d;
  });
  return {
    write: (s) => child.stdin.write(`${s}\n`),
    output: () => out,
    end: () =>
      new Promise((res) => {
        child.on('close', res);
        child.stdin.end();
      }),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
