/* E7 design 1.3, "B7, and what closes it": THE LOCAL RESTORE REHEARSAL, the ten steps, against the running local
   stack. Case E7-16, and section 6's C7 measurement.

   WHAT THIS FILE DOES TO THE SHARED LOCAL DATABASE. It dumps schemas `app` and `auth` with the container's own
   `pg_dump -Fc`, TRUNCATES BOTH SCHEMAS and loads the dump back with `pg_restore --data-only`. That is a
   destructive operation outside tests/db/00-seed.sh, which design 1.3 says the lead grants to the E7 builder
   explicitly, and the day 5 assignment does. It runs alone like every stack file, reseeds at its start, and its
   `finally` reseeds and verifies whatever happens (E7D-C-F13, below).

   THE `finally` CONTRACT, E7D-C-F13. Every step that closes the local analog of the provider's ingress closure
   restores it in a `finally`: the `usage` grant on schema `api`, the switch, PostgREST's schema cache, and then a
   reseed, after which the schema grants, the Auth state, the sequences and the migration registry are the
   migrations' own again and are VERIFIED rather than assumed. Each test carries an explicit timeout so the file
   fails at a bound rather than hanging, which is the other half of that debt.

   WHAT IT PROVES AND WHAT IT CANNOT (design section 9). It proves the reconciler, the hold, C6, C8, C9, the
   switch, the order and the closure analog, with stale credentials held from before the dump throughout. It
   CANNOT prove the provider-side closure or the key replacement: the local stack signs with HS256 and its secret
   cannot be rotated, so after the local lift a stale user access token and every stale server bearer STILL
   VERIFY. That is asserted below AS AN OBSERVATION AND NEVER AS A PASS, and `tests/e7/unit/key-replacement.test.mjs`
   (E7-31) is the local evidence that a replaced key refuses what a re-imported one admits. B7 closes at the
   hosted rehearsal H-R1 to H-R6, not here.

   EVERY PATH IT WRITES IS UNDER os.tmpdir(): the dump, the register and every scratch file. The TOTP secret the
   test keeps is GoTrue's own for a synthetic account and is never printed. No key, token, link or secret is
   printed or placed in an assertion message.

   Run alone: node --test --test-concurrency=1 tests/e7/stack/ */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { ORIGIN, stackEnv } from '../../e2/helpers/stack.mjs';
import { published } from '../../e4/stack/helpers.mjs';
import {
  count,
  e3lib,
  e4world,
  e6routes,
  enableTargets,
  futurePeriod,
  operators,
  reseed,
  reviewCompany,
  ROOT,
  sql,
} from '../../e6/stack/helpers.mjs';

/* Timeouts. Every one is a bound this file fails at rather than hanging (E7D-C-F13); each is generously above
   the durations section 6 C7 records, so a machine under load does not turn a slow run into a red gate. */
const MINUTE = 60_000;
const TIMEOUTS = { probe: 6 * MINUTE, rehearsal: 20 * MINUTE, failBefore: 15 * MINUTE };
const CHILD_MS = 5 * MINUTE;

const ids = reseed();
enableTargets();
/**
 * A reseed AFTER the module's own, which rewrites every seeded identity. `ids` is updated IN PLACE rather than
 * rebound, because the world and the route caller above already closed over this object; `enableTargets` runs
 * again because a reset takes the registry with it. Used only where a reseed is the recovery: this file's
 * `after`, and a restore that did not complete.
 */
function reseedInPlace() {
  const fresh = reseed();
  for (const k of Object.keys(ids)) delete ids[k];
  Object.assign(ids, fresh);
  enableTargets();
  return ids;
}
const { apiUrl, dbContainer } = stackEnv();
/** The operator's own command, as design 1.2 defines it: one shell command reading a statement on stdin. */
const OWNER_PSQL = `docker exec -i ${dbContainer} psql -U postgres -X -At`;
process.env.ENTERPRISE_DB_PSQL = OWNER_PSQL;

const { deleteFactor } = await import('../../../lib/operator/accounts.mjs');
const { generateLink } = await import('../../../lib/db/operator.mjs');
const { enrollTotp, verifyTotp } = await import('../../../lib/auth/factors.mjs');
const { COOKIES, verifySession } = await import('../../../lib/session.mjs');
const { serverToken } = await import('../../../lib/db/server.mjs');

const scratches = [];
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `e7-restore-${prefix}-`));
  scratches.push(dir);
  return dir;
}
/** Every duration this file measures, written out by the C7 test at the end, with the seed that produced them. */
const durations = [];
let c7Seed = null;
const timed = (label, run) => {
  const t0 = performance.now();
  const value = run();
  durations.push({ step: label, ms: Math.round(performance.now() - t0) });
  return value;
};
const timedAsync = async (label, run) => {
  const t0 = performance.now();
  const value = await run();
  durations.push({ step: label, ms: Math.round(performance.now() - t0) });
  return value;
};

after(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
  reopenLocally();
  /* Whatever happened above, the next file starts from the seed: the grants, the Auth state, the sequences and
     the migration registry are the migrations' own again. */
  reseedInPlace();
  reloadSchemaCache();
});

// ---------------------------------------------------------------------------
// The local analog of the provider's closure, and the restore mechanism.
// ---------------------------------------------------------------------------

/** What "the exposed schema is not `api`" means at the database the local PostgREST serves (design 1.3 step 5). */
function closeLocally() {
  process.env.ENTERPRISE_ACCESS_STATE = 'closed';
  sql("revoke usage on schema api from authenticated, app_server");
  reloadSchemaCache();
}
/** The other half, run in every `finally`: the grant back and the switch open (design 1.3 step 7, step 8). */
function reopenLocally() {
  sql("grant usage on schema api to authenticated, app_server");
  process.env.ENTERPRISE_ACCESS_STATE = 'open';
  reloadSchemaCache();
}
const reloadSchemaCache = () => sql("notify pgrst, 'reload schema'");
const schemaUsage = (role) => sql(`select has_schema_privilege('${role}', 'api', 'usage')`);

/**
 * PostgREST answers a NOTIFY asynchronously, so the grant and what the Data API does with it are not the same
 * instant. This waits for the two to agree, bounded, rather than sleeping a guessed interval: `open` true waits
 * until a valid user token is answered, false until it is refused. It is a wait for a state, never a retry of an
 * assertion; the assertions above and below it still say what they say.
 */
async function awaitDataApi(open, token, bound = 15_000) {
  const until = Date.now() + bound;
  let last = null;
  for (;;) {
    last = (await postgrest('/my_standing?select=membership_id', token)).status;
    if (open ? last < 400 : last >= 400) return last;
    if (Date.now() > until) throw new Error(`the Data API did not become ${open ? 'open' : 'closed'}: ${last}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** One docker command, with a bound. Returns { status, stdout (Buffer), stderr }. */
function docker(args, { input, label }) {
  const r = spawnSync('docker', args, {
    input,
    maxBuffer: 512 * 1024 * 1024,
    timeout: CHILD_MS,
    encoding: 'buffer',
  });
  const stderr = (r.stderr ?? Buffer.alloc(0)).toString('utf8');
  if (r.error) throw new Error(`${label}: ${r.error.code ?? r.error.message}`);
  if (r.status !== 0) throw new Error(`${label}: exit ${r.status}\n${stderr.slice(0, 800)}`);
  return { stdout: r.stdout ?? Buffer.alloc(0), stderr };
}

/**
 * THE BACKUP. The container's own `pg_dump -Fc` of the APPLICATION'S DATA: schemas `app` and `auth`, data only,
 * with GoTrue's own migration table excepted, into the test's scratch directory. Data only and not a whole
 * database, because the local rehearsal restores IN PLACE over a database whose schema, roles and extensions are
 * already there; a provider restore brings all three, and section 5 of the report says which.
 */
function pgDump(outPath) {
  const { stdout } = docker(
    ['exec', dbContainer, 'pg_dump', '-U', 'postgres', '-Fc', '--data-only',
      '-n', 'app', '-n', 'auth', '-T', 'auth.schema_migrations', '--no-owner', '--no-privileges'],
    { label: 'pg_dump' },
  );
  assert.ok(stdout.length > 1024, `pg_dump wrote ${stdout.length} bytes`);
  writeFileSync(outPath, stdout);
  return stdout.length;
}

/* The tables the restore is checked against, named rather than derived: a derived list would pass on a dump that
   silently lost a table. Every one is asserted to exist before it is compared. */
const RESTORE_CHECK_TABLES = Object.freeze([
  'app.companies', 'app.access_periods', 'app.memberships', 'app.groups', 'app.group_members',
  'app.agents', 'app.candidate_versions', 'app.releases', 'app.invitations', 'app.audit_events',
  'app.review_envelopes', 'app.reviews', 'app.profiles',
  'auth.users', 'auth.sessions', 'auth.refresh_tokens', 'auth.mfa_factors', 'auth.identities',
]);

/** Row count and an order-independent digest per table: what "the database equals the dump" is asserted with. */
function worldDigest() {
  const parts = RESTORE_CHECK_TABLES.map((t) => {
    const [schema, table] = t.split('.');
    return `select '${t}' as t, count(*)::text as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '-') as d from ${schema}.${table} x`;
  });
  const out = sql(`${parts.join(' union all ')} order by 1`);
  return Object.fromEntries(
    out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [t, n, d] = line.split('|');
        return [t, `${n}/${d}`];
      }),
  );
}

/**
 * THE RESTORE, in place. As the container's superuser with `session_replication_role = replica`, so the
 * append-only triggers and the foreign keys do not fire during the load, it truncates the data of `app` and
 * `auth` (GoTrue's own migration table excepted) and loads the dump with `pg_restore --data-only`.
 */
function restoreInPlace(dumpPath) {
  sql(`set session_replication_role = replica;
       do $$ declare list text; begin
         select string_agg(format('%I.%I', schemaname, tablename), ', ') into list
           from pg_tables
          where schemaname in ('app', 'auth')
            and not (schemaname = 'auth' and tablename = 'schema_migrations');
         execute 'truncate table ' || list || ' cascade';
       end $$;`);
  /* THE LOAD RUNS AS THE CONTAINER'S SUPERUSER, `supabase_admin`, WITH session_replication_role = replica ON THE
     CONNECTION, which is design 1.3's own mechanism and the only shape that works here. Two things were observed
     and are recorded in section 5 of evidence/e7-restore.md, because both are properties of this local analog and
     not of a hosted restore:
       - `--disable-triggers` is refused. It emits `ALTER TABLE ... DISABLE TRIGGER ALL`, and a foreign key's own
         triggers are SYSTEM triggers: "permission denied: RI_ConstraintTrigger_... is a system trigger". The
         container's `postgres` role is NOT a superuser (`pg_user.usesuper` is false for it; the only superuser is
         `supabase_admin`), which is what the local stack differs from a plain PostgreSQL in.
       - `postgres` may `SET session_replication_role` inside a session but may NOT set it through PGOPTIONS at
         connection time ("permission denied to set parameter"), and pg_restore has nowhere to put a `SET`. So the
         load connects as `supabase_admin`, for which both work. */
  docker(
    ['exec', '-i', '-e', 'PGOPTIONS=-c session_replication_role=replica', dbContainer,
      'pg_restore', '-U', 'supabase_admin', '-d', 'postgres',
      '--data-only', '--single-transaction', '--no-owner', '--no-privileges'],
    { input: readFileSync(dumpPath), label: 'pg_restore' },
  );
}

// ---------------------------------------------------------------------------
// Driving the owner-side scripts, as commands. The same harness shape as
// tests/e7/stack/reconcile.test.mjs and scripts.test.mjs, deliberately.
// ---------------------------------------------------------------------------

function run(script, args, env = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, ENTERPRISE_DB_PSQL: OWNER_PSQL, ...env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: CHILD_MS,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const events = (r, name) =>
  r.stdout
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
    .filter((e) => name === undefined || e.event === name);
const one = (r, name) => {
  const found = events(r, name);
  assert.equal(found.length, 1, `${name}: expected one, got ${found.length}\n${r.output.slice(0, 800)}`);
  return found[0];
};
const lines = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** The register, under os.tmpdir() and outside every Git work tree, as the scripts require. */
function newRegister(prefix) {
  const dir = scratch(prefix);
  const path = join(dir, 'register.jsonl');
  const env = { ENTERPRISE_REGISTER_PATH: path };
  const r = run('register.mjs', ['init'], env);
  assert.equal(r.status, 0, r.output);
  return { dir, path, env };
}

/** A sync that gets through, the way an operator gets through one (scripts.test.mjs's own loop). */
function syncAll(reg, refs = {}) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const args = ['sync', '--operator', ids.U_op];
    for (const [auditId, ref] of Object.entries(refs)) args.push('--ref', `${auditId}=${ref}`);
    const r = run('register.mjs', args, reg.env);
    if (r.status === 0) return r;
    const stopped = events(r, 'register_sync_stopped')[0];
    assert.ok(stopped, `the sync failed for a reason that is not a missing reference:\n${r.output.slice(0, 700)}`);
    assert.equal(stopped.need, 'ref', r.output.slice(0, 400));
    refs[stopped.auditId] = `rehearsal:instruction-${stopped.auditId}`;
  }
  throw new Error('the sync never got through');
}
/** Sync, then anchor, and return the head the operator records in the company workspace. */
function syncAndAnchor(reg, refs) {
  syncAll(reg, refs);
  const anchored = run('register.mjs', ['anchor'], reg.env);
  assert.equal(anchored.status, 0, anchored.output);
  return one(anchored, 'register_anchor').head;
}

// ---------------------------------------------------------------------------
// Credentials held from before the dump, presented at every later step.
// ---------------------------------------------------------------------------

/** A VerifiedSession for a raw GoTrue access token, for minting a server bearer the way a route does. */
async function sessionOf(accessToken) {
  const v = await verifySession({ headers: { cookie: `${COOKIES.access}=${accessToken}` } });
  assert.equal(v.ok, true, 'the token verifies at the time it is held');
  return v.session;
}
/** A user object the route caller accepts, whose token is FIXED: a stale cookie, never refreshed. */
const stale = (who, token) => ({ who, token: () => token });

/** The local PostgREST, asked directly with a bearer: what a stale token meets at the Data API. */
async function postgrest(path, bearer, { method = 'GET', body } = {}) {
  const r = await fetch(`${apiUrl}/rest/v1${path}`, {
    method,
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${bearer}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
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
/** GoTrue's verify, where a sign-in link is exchanged. Used to consume L and to show it refused afterwards. */
async function verifyLink(tokenHash) {
  const r = await fetch(`${apiUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
    redirect: 'manual',
  });
  return r.status;
}

/* RFC 6238 TOTP over the secret GoTrue returned at enrolment, so that "D reaches aal2 with a code from the held
   secret" and "the same code is refused once the factor is gone" are the same operation. Six digits, SHA-1,
   thirty-second step, which is what GoTrue's TOTP is. The secret is never printed. */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(text) {
  let bits = '';
  for (const ch of text.replace(/=+$/, '').toUpperCase()) {
    const i = BASE32.indexOf(ch);
    if (i < 0) continue;
    bits += i.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totpCode(secret, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const value = mac.readUInt32BE(offset) & 0x7f_ff_ff_ff;
  return String(value % 1_000_000).padStart(6, '0');
}

const logged = [];
const R = await e6routes(logged);
const W = e4world('e7-restore', ids);
const RUN = Math.random().toString(16).slice(2, 8);
/* The seeded operator at aal2. Minting is the only local way to aal2 for a session that is not a real TOTP
   verification (tests/e2/helpers/stack.mjs); D's own aal2 below IS a real one, because the rehearsal needs a
   factor whose secret it holds. */
const OP = operators(ids).aal2;

const slugOf = (companyId) => sql(`select slug from app.companies where id = '${companyId}'`);
const statusOf = (companyId) => sql(`select status from app.companies where id = '${companyId}'`);
const rolesOf = (membershipId) =>
  sql(`select coalesce((select string_agg(r, ',' order by r) from unnest(roles) r), '') from app.memberships where id = '${membershipId}'`);

// ---------------------------------------------------------------------------
// THE IN-PLACE RESTORE PROBE, first (design 1.3: "whether GoTrue's tables load
// cleanly this way on the pinned CLI is the builder's first probe").
// ---------------------------------------------------------------------------

test('the in-place restore probe: a truncate-and-load over the live database equals the dump, and the finally holds', { timeout: TIMEOUTS.probe }, async () => {
  const dir = scratch('probe');
  const dumpPath = join(dir, 'probe.dump');

  for (const t of RESTORE_CHECK_TABLES) {
    const [schema, table] = t.split('.');
    assert.equal(
      sql(`select count(*) from information_schema.tables where table_schema='${schema}' and table_name='${table}'`),
      '1',
      `${t} is in the catalogue, so the comparison below is a comparison and not a skip`,
    );
  }

  /* Something of every kind in the dump, so the load is exercised on real rows and not on a bare seed. */
  const P = await reviewCompany(W, R, `probe${RUN}`);
  futurePeriod(P.id);
  await published(R, P);
  const before = worldDigest();
  assert.ok(Number(before['app.companies'].split('/')[0]) >= 3, before['app.companies']);
  assert.ok(Number(before['auth.users'].split('/')[0]) >= 5, before['auth.users']);

  const bytes = timed('probe:dump', () => pgDump(dumpPath));
  assert.ok(bytes > 0);

  let restored = false;
  try {
    closeLocally();
    assert.equal(schemaUsage('authenticated'), 'f', 'the closure analog is in force before anything is loaded');

    /* The database is changed AFTER the dump, so a load that did nothing would be caught by the comparison. */
    sql(`update app.companies set name = name || ' (after the backup)' where id = '${P.id}'`);
    assert.notEqual(worldDigest()['app.companies'], before['app.companies'], 'the world moved after the dump');

    timed('probe:truncate-and-load', () => restoreInPlace(dumpPath));
    restored = true;
    const after = worldDigest();
    for (const t of RESTORE_CHECK_TABLES)
      assert.equal(after[t], before[t], `${t}: the restored database does not equal the dump`);
  } finally {
    reopenLocally();
    /* The load IS the recovery on the happy path: it puts the database back to the dump, which is this probe's
       whole point, and a reseed here would rewrite every seeded identity the tests below already hold. A restore
       that did not complete leaves the database truncated, and then a reseed is the only way back. */
    if (!restored) reseedInPlace();
    reloadSchemaCache();
  }
  assert.equal(restored, true);

  /* And the `finally` contract: the grants, the Auth state, the sequences, the migration registry and the schema
     cache are the migrations' own again, VERIFIED rather than assumed (E7D-C-F13). */
  assert.equal(schemaUsage('authenticated'), 't', 'usage on schema api is back for authenticated');
  assert.equal(schemaUsage('app_server'), 't', 'and for app_server');
  assert.equal(process.env.ENTERPRISE_ACCESS_STATE, 'open', 'the switch is open again');
  assert.ok(
    Number(sql('select count(*) from supabase_migrations.schema_migrations')) >= 9,
    'the migration registry holds every migration',
  );
  assert.ok(Number(sql('select last_value from app.audit_events_id_seq')) >= 1, 'the audit sequence is a seeded one');
  /* And the whole chain answers again: PostgREST, the api schema, the principal, for a company that was in the
     dump and came back with it. */
  const served = await R.releasesList(P.admin, P.id);
  assert.equal(served.status, 200, `the reopened schema serves a restored company: ${served.status} ${served.raw ?? ''}`);
});

// ---------------------------------------------------------------------------
// The world the rehearsal restores, built once and used by both arms.
// ---------------------------------------------------------------------------

/**
 * Design 1.3's step 1: three companies through the routes, with M owning an agent with a published release R, U
 * holding `it_reviewer`, and an administrator D who ENROLS A TOTP FACTOR whose secret the test keeps.
 */
async function buildWorld(tag) {
  const A = await reviewCompany(W, R, `${tag}a`);
  futurePeriod(A.id);
  const B = await reviewCompany(W, R, `${tag}b`);
  futurePeriod(B.id);
  const C = await reviewCompany(W, R, `${tag}c`);
  futurePeriod(C.id);

  const release = await published(R, A);

  /* One PENDING invitation in A, because C5's subject is the live link a restore brings back: every invitation
     the backup held is redeemable again at the target, whatever the customer did with it afterwards. */
  const pendingEmail = `e7-restore-pending-${RUN}@example.invalid`;
  const pending = await R.invite(A.adminHi, A.id, { email: pendingEmail, roles: ['member'] });
  assert.equal(pending.status, 201, pending.raw);

  /* D is A's administrator, and D's aal2 is a REAL TOTP verification, because step 10 needs a challenge and a
     verify from a secret this test holds. The seeded admin's aal2 elsewhere is minted; here it is enrolled. */
  const session = await sessionOf(A.admin.token());
  const enrolled = await enrollTotp(session);
  assert.equal(enrolled.ok, true, `TOTP enrolment on this stack: ${JSON.stringify(enrolled).slice(0, 200)}`);
  const verified = await verifyTotp(session, enrolled.factorId, totpCode(enrolled.secret));
  assert.equal(verified.ok, true, `TOTP verification on this stack: ${JSON.stringify(verified).slice(0, 200)}`);
  const D = {
    who: 'D',
    id: A.admin.id,
    email: A.admin.email,
    factorId: enrolled.factorId,
    secret: enrolled.secret,
    aal2Token: verified.tokens.accessToken,
    token: () => verified.tokens.accessToken,
  };
  assert.equal((await sessionOf(D.aal2Token)).aal, 'aal2', 'D reached aal2 through its own factor');

  /* X: an invitee of C who never accepted, so GoTrue's account for it is UNCONFIRMED, plus a membership of C
     added owner-side (the seed's own pattern; no route gives a membership to an unconfirmed account). It is the
     account C9 re-applies: at the source its membership went with C's deletion and the sweep took it; at the
     restored target C is back and the membership with it, so C9 is HELD at the first apply and applies at the
     second, which is design 1.3 C9's own sentence. */
  const xEmail = `e7-restore-x-${RUN}@example.invalid`;
  const invited = await R.invite(C.adminHi, C.id, { email: xEmail, roles: ['member'] });
  assert.equal(invited.status, 201, invited.raw);
  const xId = sql(`select id from auth.users where lower(email) = '${xEmail}'`);
  assert.match(xId, /^[0-9a-f-]{36}$/, xId);
  assert.equal(sql(`select coalesce(email_confirmed_at::text, 'null') from auth.users where id = '${xId}'`), 'null');
  const xMembership = W.member(C.id, { id: xId });
  assert.match(xMembership, /^[0-9a-f-]{36}$/, xMembership);

  return {
    A, B, C, D, release,
    M: A.author,
    U: A.it,
    X: { id: xId, email: xEmail, membershipId: xMembership },
    cMember: C.member,
    slugs: { a: slugOf(A.id), b: slugOf(B.id), c: slugOf(C.id) },
  };
}

/**
 * Design 1.3's step 2: the stale credentials, held from before the dump and never refreshed.
 *
 * ONE THING THE DESIGN ASKS FOR CANNOT BE HELD LITERALLY (E7B-F1). A server bearer lives SIXTY SECONDS
 * (lib/db/server.mjs TOKEN_TTL_SECONDS), so a bearer minted before the dump is expired minutes later, before the
 * restore has even finished, and a refusal at the Data API would then be about `exp` and not about the closed
 * schema or a replaced key. So two things are held per person, and the report says which assertion each carries:
 *   `bearer`  the bearer minted BEFORE the dump. What it carries is its SIGNATURE, which is what the hosted key
 *             replacement breaks and what the local HS256 secret cannot. Never sent anywhere.
 *   `token`   the browser access token, which lives an hour and mints new bearers. It is what is presented at
 *             every later step, and `bearerNow()` is what a route would mint from it at that moment.
 */
async function holdCredentials(w) {
  const held = {};
  for (const [name, user] of [['M', w.M], ['U', w.U], ['cMember', w.cMember], ['D', w.D]]) {
    const token = user.token();
    held[name] = {
      token,
      cookie: stale(name, token),
      bearer: serverToken(await sessionOf(token)),
      bearerNow: async () => serverToken(await sessionOf(token)),
    };
  }
  /* A sign-in link for U through GoTrue's admin API, as the stack tests already make one: L, whose token hash is
     kept and which is CONSUMED after the dump, so that the restore brings a used link back. */
  const link = await generateLink({ email: w.U.email, type: 'magiclink' });
  assert.equal(link.ok, true, 'GoTrue issued a sign-in link for U');
  held.L = { tokenHash: link.hashedToken };
  return held;
}

/** Design 1.3's step 4, and the one place the rehearsal's story is written: what the customers did AFTER the
 *  backup, each through the routes, each followed by a sync and an anchor. Returns what step 10 checks against. */
async function actAfterTheBackup(w, reg, refs, held) {
  const ok = (r, status, label) => {
    assert.equal(r.status, status, `${label}: ${r.status} ${r.raw ?? ''}`);
    return r.body;
  };
  const anchors = [];
  /* Every act is followed by a sync and an anchor, which is what the operator guide asks for and what makes the
     register as fresh as the last act rather than as fresh as the last weekly check. */
  const step = async (label, act) => {
    const value = await act();
    anchors.push([label, syncAndAnchor(reg, refs)]);
    return value;
  };

  /* B is suspended. */
  await step('suspend B', async () =>
    ok(await R.companyStatus(OP, w.B.id, { status: 'suspended', reasonCode: 'non_payment' }), 200, 'suspend B'),
  );
  assert.equal(statusOf(w.B.id), 'suspended');

  /* A's access period is EXTENDED, which is the one difference the reconciler may not narrow away: an extension
     recorded after the backup is an authorized recovery and is applied only by `lift --agreement` (E7D-C-F5). */
  const periodBefore = JSON.parse(
    sql(`select jsonb_build_object('startsAt', starts_at, 'endsAt', ends_at, 'exportBy', export_by, 'deleteBy', delete_by) from app.access_periods where company_id = '${w.A.id}'`),
  );
  const extendedEndsAt = new Date(Date.parse(periodBefore.endsAt) + 90 * 86_400_000).toISOString();
  await step('extend A', async () =>
    ok(await R.accessPeriod(OP, w.A.id, { startsAt: periodBefore.startsAt, endsAt: extendedEndsAt }), 200, 'extend A'),
  );
  const periodAfter = JSON.parse(
    sql(`select jsonb_build_object('startsAt', starts_at, 'endsAt', ends_at, 'exportBy', export_by, 'deleteBy', delete_by) from app.access_periods where company_id = '${w.A.id}'`),
  );
  assert.ok(Date.parse(periodAfter.endsAt) > Date.parse(periodBefore.endsAt), 'the period was extended');

  /* R is withdrawn, then M is removed and U loses it_reviewer. */
  await step('withdraw R', async () =>
    ok(await R.withdraw(w.A.adminHi, w.release.releaseId, 'Withdrawn by the customer after the backup.'), 200, 'withdraw'),
  );
  await step('remove M', async () => ok(await R.removeMember(w.A.adminHi, w.A.id, w.A.ms.author), 200, 'remove M'));
  await step('reduce U', async () =>
    ok(
      await R.call('membersSetRoles', {
        user: w.A.adminHi,
        params: { companyId: w.A.id, membershipId: w.A.ms.it },
        body: { roles: ['member'] },
      }),
      200,
      'reduce U',
    ),
  );
  assert.equal(rolesOf(w.A.ms.it), 'member');

  /* C is SUSPENDED, then closed, then deleted through the one door. The suspension is not decoration: E6's
     api.close_company requires `suspended` and answers E_COMPANY_NOT_SUSPENDED otherwise, so design 1.3's "close
     and delete C" is three operator acts and not two. Observed, and named in the report. */
  await step('suspend C', async () =>
    ok(await R.companyStatus(OP, w.C.id, { status: 'suspended', reasonCode: 'customer_request' }), 200, 'suspend C'),
  );
  await step('close C', async () =>
    ok(await R.companyClose(OP, w.C.id, { confirmSlug: w.slugs.c, reasonCode: 'customer_instruction' }), 200, 'close C'),
  );
  await step('delete C', async () =>
    ok(await R.companyDelete(OP, w.C.id, { confirmSlug: w.slugs.c, reasonCode: 'customer_instruction' }), 200, 'delete C'),
  );
  assert.equal(count(`app.companies where id = '${w.C.id}'`), 0, 'C is gone at the source');

  /* X, whose membership went with C, is swept: an account the register records as deleted. At the restored
     target C is back and X holds a membership again, so C9 is HELD at the first apply and applies at the second
     (design 1.3 C9). Only X is aged past the sweep's fourteen-day grace, so only X is a candidate. */
  sql(`update auth.users set created_at = created_at - interval '20 days' where id = '${w.X.id}'`);
  const swept = await step('sweep X', () => run('sweep-accounts.mjs', ['--apply', '--operator', ids.U_op]));
  assert.equal(swept.status, 0, swept.output.slice(0, 600));
  assert.equal(count(`auth.users where id = '${w.X.id}'`), 0, 'X was deleted at GoTrue');

  /* L is USED ONCE, which is what makes it a consumed link: the restore brings a used link back live. */
  const consumed = await verifyLink(held.L.tokenHash);
  assert.ok(consumed < 400, `L verifies while it is live: ${consumed}`);
  const reused = await verifyLink(held.L.tokenHash);
  assert.ok(reused >= 400, `and a second use is refused at the source: ${reused}`);

  /* D's authenticator is lost: the factor is deleted through GoTrue's admin API and the register line appended,
     which is step 5 of the lost-second-factor procedure as the reconciler now needs it (C8). */
  assert.equal(await deleteFactor(w.D.id, w.D.factorId), 'deleted');
  assert.equal(count(`auth.mfa_factors where id = '${w.D.factorId}'`), 0, 'the factor is gone at the source');
  const appended = run(
    'register.mjs',
    ['append', '--act', 'factor.delete', '--user-id', w.D.id, '--factor-id', w.D.factorId,
      '--ref', `rehearsal:opslog-${RUN}`, '--operator', ids.U_op],
    reg.env,
  );
  assert.equal(appended.status, 0, appended.output.slice(0, 400));
  anchors.push(['delete D’s factor', syncAndAnchor(reg, refs)]);

  return { anchoredHead: anchors.at(-1)[1], anchors, periodBefore, periodAfter };
}

// ---------------------------------------------------------------------------
// E7-16: B7's ten steps, in order, each an assertion with the credential named.
// ---------------------------------------------------------------------------

/** A's company-scoped routes that LOAD THE PRINCIPAL, where the hold's refusal is loadPrincipal's own 409. Each
 *  one is named rather than swept up by a loop over the route table, because what each refusal means differs:
 *  the export takes no principal at all and the download reaches the database through api.authorize_download. */
const A_PRINCIPAL_ROUTES = (w) => [
  ['releases', (u) => R.releasesList(u, w.A.id)],
  ['catalog', (u) => R.catalog(u, w.A.id)],
  ['groups', (u) => R.groupsList(u, w.A.id)],
];
/** Everything step 6 walks with every stale cookie: the account route, the principal routes, the export and the
 *  download. The switch is before all of them, so every one answers alike while it is closed. */
const A_ROUTES = (w) => [
  ['me', (u) => R.me(u)],
  ...A_PRINCIPAL_ROUTES(w),
  ['takeout', (u) => R.takeout(u, w.A.id)],
  ['download', (u) => R.download(u, w.release.releaseId)],
];

test('E7-16: B7 end to end on the local stack, the ten steps in order', { timeout: TIMEOUTS.rehearsal }, async () => {
  const reg = newRegister('e16');
  const dumpPath = join(scratch('e16'), 'backup.dump');
  const refs = {};

  // --- 1. the three-company world through the routes, a register started, synced and anchored ---------------
  const w = await timedAsync('world', () => buildWorld(`r16${RUN}`));
  /* The seed the C7 measurement belongs to, read HERE and not at the end: the fail-before arm reseeds, and a
     measurement reported against the wrong world is worse than no measurement. */
  c7Seed = {
    companies: count('app.companies'),
    memberships: count('app.memberships'),
    releases: count('app.releases'),
    auditEvents: count('app.audit_events'),
    authUsers: count('auth.users'),
  };
  const firstHead = syncAndAnchor(reg, refs);
  assert.match(firstHead, /^[0-9]+:[0-9a-f]{64}$/, 'the anchored head the operator records in the workspace');

  // --- 2. the stale credentials, held from before the dump and never refreshed -------------------------------
  const held = await holdCredentials(w);
  for (const name of ['M', 'U', 'cMember', 'D'])
    assert.equal((await sessionOf(held[name].token)).authUserId.length, 36, `${name}: a live session before the dump`);

  // --- 3. the dump: "the oldest open-state backup" ------------------------------------------------------------
  const backupAt = new Date().toISOString();
  const dumpBytes = timed('dump', () => pgDump(dumpPath));
  /* Recorded here and not at the end of the case, so that the C7 line carries it whatever happens after. */
  durations.push({ step: 'dump-bytes', ms: dumpBytes });

  // --- 4. the acts after the backup, through the routes, each synced and anchored -----------------------------
  const acted = await timedAsync('acts-after-the-backup', () => actAfterTheBackup(w, reg, refs, held));
  const anchoredHead = acted.anchoredHead;

  let reopened = false;
  try {
    // --- 5. the restore, with the local closure analog in force first, then `begin` --------------------------
    closeLocally();
    assert.equal(schemaUsage('authenticated'), 'f', 'schema api is closed to authenticated before anything is loaded');
    assert.equal(schemaUsage('app_server'), 'f', 'and to app_server');
    await awaitDataApi(false, held.U.token);
    timed('truncate-and-load', () => restoreInPlace(dumpPath));
    assert.equal(count(`app.companies where id = '${w.C.id}'`), 1, 'the restore brought the deleted company back');
    assert.equal(statusOf(w.B.id), 'active', 'and the suspension with it');
    assert.equal(count(`auth.mfa_factors where id = '${w.D.factorId}'`), 1, 'and D’s deleted factor');
    assert.equal(count(`auth.users where id = '${w.X.id}'`), 1, 'and the swept account');

    const begun = timed('begin', () =>
      run('reconcile.mjs', ['begin', '--operator', ids.U_op, '--closed-target', '--backup-at', backupAt, '--apply'], reg.env),
    );
    assert.equal(begun.status, 0, begun.output.slice(0, 900));
    assert.ok(one(begun, 'begin_done').held >= 3, 'every company that is not closed is held');
    for (const table of ['sessions', 'refresh_tokens', 'one_time_tokens', 'flow_state', 'mfa_challenges'])
      assert.equal(count(`auth.${table}`), 0, `C6 emptied auth.${table}`);

    // --- 6. NO DOOR OPENS -------------------------------------------------------------------------------------
    const closedDoors = { token: [], bearer: [] };
    for (const name of ['M', 'U', 'cMember', 'D']) {
      for (const [label, call] of A_ROUTES(w)) {
        const r = await call(held[name].cookie);
        assert.equal(r.status, 503, `${name} at ${label}: ${r.status} ${r.raw ?? ''}`);
        assert.equal(r.body.code, 'E_MAINTENANCE', `${name} at ${label}`);
      }
      /* The same credential straight at the local PostgREST, which the switch does not protect: it meets the
         closed schema instead, which is the local analog of the exposed-schema setting. */
      const direct = await postgrest('/my_standing?select=*', held[name].token);
      assert.ok(direct.status >= 400, `${name}'s access token at PostgREST: ${direct.status}`);
      /* The bearer is minted from the held session AT THIS MOMENT, so that the refusal is about the closed
         schema and not about a sixty-second `exp` (E7B-F1). The probe is the one read routine a server bearer
         may call, api.departure_preview, which is answered when the schema is open and A is active. */
      const asServer = await postgrest('/rpc/departure_preview', await held[name].bearerNow(), {
        method: 'POST',
        body: { p_membership: w.A.ms.member },
      });
      assert.ok(asServer.status >= 400, `${name}'s server bearer at PostgREST: ${asServer.status}`);
      closedDoors.token.push(`${name}:${direct.status}/${direct.json?.code ?? '-'}`);
      closedDoors.bearer.push(`${name}:${asServer.status}/${asServer.json?.code ?? '-'}`);
    }
    /* And L, the consumed sign-in link the restore brought back, is refused at GoTrue's verify after C6. */
    const linkClosed = await verifyLink(held.L.tokenHash);
    assert.ok(linkClosed >= 400, 'L is refused at GoTrue’s verify after begin');
    /* What an operator would SEE at a closed target, recorded for day 7's runbook: the exact answers, not just
       "refused". The user access tokens and the server bearers go straight at PostgREST, past the switch. */
    console.log(
      `recorded, step 6, what each stale credential meets at the CLOSED target: every route answers 503 ` +
        `E_MAINTENANCE for every stale cookie; at PostgREST the access tokens answer ` +
        `${closedDoors.token.join(', ')} and the server bearers ${closedDoors.bearer.join(', ')} ` +
        `(status/PostgREST code); GoTrue's verify answers ${linkClosed} for the consumed sign-in link.`,
    );

    // --- 7. reconcile: plan, apply, the deletion re-applied, apply again, plan again ---------------------------
    const planArgs = ['--operator', ids.U_op, '--closed-target', '--anchored-head', anchoredHead];
    const planned = timed('plan', () => run('reconcile.mjs', ['plan', ...planArgs], reg.env));
    assert.equal(planned.status, 0, planned.output.slice(0, 900));
    /* A company with nothing to do may print no plan_company line at all, so the reader is total by construction
       and the three lists are RECORDED before anything is asserted about them. */
    const planFor = (companyId) =>
      events(planned, 'plan_company').find((e) => e.companyId === companyId)?.corrections ?? [];
    console.log(
      `recorded, step 7's first plan: A ${JSON.stringify(planFor(w.A.id))}, B ${JSON.stringify(planFor(w.B.id))}, ` +
        `C ${JSON.stringify(planFor(w.C.id))}.`,
    );
    if (process.env.E7_16_TRACE === '1')
      console.log(`TRACE first plan:\n${events(planned).map((e) => JSON.stringify(e)).join('\n')}`);
    assert.ok(planFor(w.C.id).includes('C1'), 'C1 for the company the register records as deleted');
    for (const id of ['C3', 'C7', 'C4', 'C5'])
      assert.ok(planFor(w.A.id).includes(id), `A's plan carries ${id}: ${JSON.stringify(planFor(w.A.id))}`);
    /* C2 IS A REFUSAL AND NOT A CORRECTION, which is what E7D-C-F5 asks for and one word away from how
       evidence/e7-reconcile.md section 5 describes it ("planned as `agreement_recovery`"): the extension is not
       something `apply` may do at all, so it is printed as the refusal that holds A with its named way out, and
       the word `agreement_recovery` appears at the LIFT, where the correction is finally built. Recorded as
       E7B-F3; what it changes here is where the assertion goes, not what the reconciler does. */
    const c2 = events(planned, 'plan_refusal').find((e) => e.correction === 'C2' && e.companyId === w.A.id);
    assert.ok(c2, `the extension holds A: ${JSON.stringify(events(planned, 'plan_refusal'))}`);
    assert.match(c2.rule, /authorized recovery and not a narrowing/);
    assert.match(c2.wayOut, /lift --agreement/, 'and it names the way out');
    assert.equal(
      events(planned, 'plan_company').find((e) => e.companyId === w.A.id).refusals,
      1,
      'A is held by exactly that one refusal',
    );
    /* B was only SUSPENDED after the backup, which the register records and the lift restores as the narrower of
       the two statuses: there is no correction for it, and its status comes back at step 9 and not here. */
    assert.deepEqual(planFor(w.B.id), [], `B has nothing to correct: ${JSON.stringify(planFor(w.B.id))}`);
    assert.equal(
      events(planned, 'plan_correction').some((e) => e.correction === 'C8' && e.userId === w.D.id),
      true,
      'C8 for D’s factor, which the restore brought back',
    );
    assert.equal(
      events(planned, 'plan_report').some((e) => e.kind === 'account_held' && e.userId === w.X.id),
      true,
      'C9 is HELD at the first plan: X holds a membership again until C’s deletion is re-applied',
    );
    const deletion = events(planned, 'plan_deletion').find((e) => e.companyId === w.C.id);
    assert.equal(deletion.hasRef, true, 'the deletion carries the instruction reference the register holds');

    const applied = timed('apply', () => run('reconcile.mjs', ['apply', ...planArgs], reg.env));
    assert.equal(applied.status, 0, applied.output.slice(0, 900));
    assert.equal(statusOf(w.C.id), 'closed', 'C1 closed the company the register records as deleted');
    assert.equal(sql(`select status from app.memberships where id = '${w.A.ms.author}'`), 'removed', 'C3');
    assert.equal(rolesOf(w.A.ms.it), 'member', 'C7');
    assert.equal(sql(`select state from app.releases where id = '${w.release.releaseId}'`), 'withdrawn', 'C4');
    assert.equal(count(`auth.mfa_factors where id = '${w.D.factorId}'`), 0, 'C8 deleted D’s restored factor');
    assert.equal(count(`auth.users where id = '${w.X.id}'`), 1, 'and C9 has not run: X still holds a membership');

    /* The one door, run separately, exactly as the plan printed it. */
    const deleted = timed('delete-company', () =>
      run('delete-company.mjs', ['--company', w.C.id, '--slug', slugOf(w.C.id), '--reason', 'customer_instruction',
        '--instruction', `rehearsal:recovery-${RUN}`, '--operator', ids.U_op, '--apply'], reg.env),
    );
    assert.equal(deleted.status, 0, deleted.output.slice(0, 900));
    assert.equal(count(`app.companies where id = '${w.C.id}'`), 0, 'C is gone again');

    const second = timed('apply-again', () => run('reconcile.mjs', ['apply', ...planArgs], reg.env));
    assert.equal(second.status, 0, second.output.slice(0, 900));
    assert.equal(count(`auth.users where id = '${w.X.id}'`), 0, 'C9 applied at the SECOND apply, as design 1.3 says');
    assert.equal(
      count(`app.audit_events where action = 'account.delete' and details->>'user_id' = '${w.X.id}'`),
      1,
      'and its audit row is the sweep’s own recorder, written after GoTrue answered',
    );

    const third = run('reconcile.mjs', ['plan', ...planArgs], reg.env);
    assert.equal(third.status, 0, third.output.slice(0, 900));
    const remaining = (companyId) =>
      events(third, 'plan_company').find((e) => e.companyId === companyId)?.corrections ?? [];
    console.log(
      `recorded, step 7's final plan: A ${JSON.stringify(remaining(w.A.id))}, B ${JSON.stringify(remaining(w.B.id))}; ` +
        `summary ${JSON.stringify(events(third, 'plan_summary')[0] ?? null)}.`,
    );
    /* What is left is only what the LIFT applies. A's extension is an authorized recovery that `apply` never
       touches (E7D-C-F5): it stays the one refusal holding A, and `lift --agreement` is what applies it. B waits
       for its confirmation alone. Nothing else is planned for either. */
    assert.deepEqual(remaining(w.A.id), [], `A has no correction left: ${JSON.stringify(remaining(w.A.id))}`);
    assert.equal(
      events(third, 'plan_refusal').filter((e) => e.companyId === w.A.id).map((e) => e.correction).join(','),
      'C2',
      'and exactly one refusal, the agreement, which is what A waits for at its lift',
    );
    assert.deepEqual(remaining(w.B.id), [], `B waits for its confirmation alone: ${JSON.stringify(remaining(w.B.id))}`);
    assert.deepEqual(
      events(third, 'plan_refusal').filter((e) => e.companyId === w.B.id),
      [],
      'B is held by nothing but its confirmation',
    );
    assert.equal(
      events(third, 'plan_company').some((e) => e.companyId === w.C.id),
      false,
      'and C is not in the plan at all: it is deleted',
    );

    // --- 8. reopen locally: every company is still held ---------------------------------------------------------
    timed('reopen', () => reopenLocally());
    reopened = true;
    assert.equal(schemaUsage('authenticated'), 't');
    await awaitDataApi(true, held.U.token);
    /* U and D are still active members of A, so what they meet is the HOLD. */
    for (const who of ['U', 'D']) {
      for (const [label, call] of A_PRINCIPAL_ROUTES(w)) {
        const r = await call(held[who].cookie);
        assert.equal(r.status, 409, `${who} at ${label} while A is held: ${r.status} ${r.raw ?? ''}`);
        assert.equal(r.body.code, 'E_COMPANY_INACTIVE', `${who} at ${label}`);
      }
    }
    /* M IS 404 HERE AND NOT 409, and design 1.3's step 8 says 409 for M as well. It is a sentence in the design
       that the rehearsal corrects, not a defect: C3 has already re-applied M's removal, and loadPrincipal tests
       the MEMBERSHIP before the company's status on purpose (lib/services/principal.mjs, E6's own comment: a
       loader that answered the company's state first could not tell a suspension from a foreign id). The refusal
       M meets is the stricter of the two, and step 10's assertion for M is unchanged. Recorded as E7B-F2. */
    for (const [label, call] of A_PRINCIPAL_ROUTES(w)) {
      const r = await call(held.M.cookie);
      assert.equal(r.status, 404, `M, already removed by C3, at ${label}: ${r.status} ${r.raw ?? ''}`);
      assert.equal(r.body.code, 'E_NOT_FOUND', `M at ${label}`);
    }
    const exportHeld = await R.takeout(held.D.cookie, w.A.id);
    assert.equal(exportHeld.status, 403, exportHeld.raw);
    assert.equal(exportHeld.body.code, 'E_FORBIDDEN', 'D’s export of a held company is refused (009’s export door)');
    /* The download of a held company's release, which takes no principal: refused, and its code recorded rather
       than asserted, because it comes from api.authorize_download's own membership test and not from the hold. */
    const heldDownload = await R.download(w.A.member, w.release.releaseId);
    assert.ok(heldDownload.status >= 400, `a held company's download: ${heldDownload.status}`);
    console.log(
      `recorded, step 8: the download of a held company's release answered ${heldDownload.status} ` +
        `${heldDownload.body?.code ?? ''} (api.authorize_download's own membership test, not the principal's 409).`,
    );

    // --- 9. the lift, A with its agreement and a rehearsal reference, then B ------------------------------------
    const liftA = timed('lift', () =>
      run('reconcile.mjs', ['lift', '--operator', ids.U_op, '--company', w.A.id,
        '--confirmation', `rehearsal:call-a-${RUN}`, '--agreement', `rehearsal:agreement-a-${RUN}`,
        '--anchored-head', anchoredHead, '--apply'], reg.env),
    );
    assert.equal(liftA.status, 0, liftA.output.slice(0, 900));
    assert.equal(one(liftA, 'lift_done').statusAfter, 'active', 'A comes back active');
    assert.equal(liftA.output.includes('@example.invalid'), false, 'no address reached this output');
    const liftB = run(
      'reconcile.mjs',
      ['lift', '--operator', ids.U_op, '--company', w.B.id, '--confirmation', `rehearsal:call-b-${RUN}`,
        '--anchored-head', anchoredHead, '--apply'],
      reg.env,
    );
    assert.equal(liftB.status, 0, liftB.output.slice(0, 900));
    assert.equal(one(liftB, 'lift_done').statusAfter, 'suspended', 'B comes back SUSPENDED, as the register says');

    // --- 10. after the lift ------------------------------------------------------------------------------------
    for (const [label, call] of A_PRINCIPAL_ROUTES(w)) {
      const r = await call(held.M.cookie);
      assert.equal(r.status, 404, `M, removed, at ${label}: ${r.status} ${r.raw ?? ''}`);
      assert.equal(r.body.code, 'E_NOT_FOUND', `M at ${label} after the lift`);
    }
    assert.equal(count(`app.companies where id = '${w.C.id}'`), 0, 'C is gone');
    const download = await R.download(w.A.member, w.release.releaseId);
    assert.equal(download.status, 409, download.raw);
    assert.equal(download.body.code, 'E_RELEASE_WITHDRAWN', 'R’s download is refused: withdrawn again');
    const period = JSON.parse(
      sql(`select jsonb_build_object('endsAt', ends_at) from app.access_periods where company_id = '${w.A.id}'`),
    );
    assert.equal(
      new Date(period.endsAt).toISOString(),
      new Date(acted.periodAfter.endsAt).toISOString(),
      'A’s period carries the extended dates, applied by the lift’s --agreement',
    );
    const bMember = await R.releasesList(w.B.member, w.B.id);
    assert.equal(bMember.status, 409, bMember.raw);
    assert.equal(bMember.body.code, 'E_COMPANY_INACTIVE', 'B is suspended, as the register says');
    assert.equal(rolesOf(w.A.ms.it), 'member', 'U holds no it_reviewer');
    assert.ok(await verifyLink(held.L.tokenHash) >= 400, 'L is STILL refused at GoTrue’s verify after the lift');

    /* D's old factor is refused, and the two reasons are kept apart, because conflating them would have let a
       session refusal pass for a factor refusal.
       FIRST, WHAT C6 DID, which is more than the design claims for the local stack: the held access token still
       VERIFIES at the product's own verifier and is still answered by PostgREST, because neither consults a
       session row, but GOTRUE REFUSES IT (`session_not_found`), because C6 deleted auth.sessions and GoTrue looks
       the session up. So C6 does end a restored session for everything that asks GoTrue. Recorded as E7B-F4. */
    const staleAtGoTrue = await enrollTotp(await sessionOf(held.D.token));
    assert.equal(staleAtGoTrue.ok, false, 'GoTrue refuses the session C6 deleted');
    assert.equal(staleAtGoTrue.gotrueErrorCode, 'session_not_found', JSON.stringify(staleAtGoTrue));

    /* SECOND, the factor itself, asked with a session GoTrue does accept: D signs in again, the way the person
       would, and challenges the OLD factor id with a code from the secret this test has held since step 1. */
    const dSession = await sessionOf(e3lib('user_jwt "$1" "$PW"', w.D.email));
    assert.equal(dSession.aal, 'aal1', 'a fresh sign-in is aal1: the second factor is gone');
    const oldFactor = await verifyTotp(dSession, w.D.factorId, totpCode(w.D.secret));
    assert.equal(oldFactor.ok, false, 'THE DELETED FACTOR CANNOT BE CHALLENGED, for want of the factor');
    console.log(
      `recorded, step 10: a challenge of D's deleted factor answered ${JSON.stringify({
        code: oldFactor.code,
        gotrueStatus: oldFactor.gotrueStatus,
        gotrueErrorCode: oldFactor.gotrueErrorCode,
      })}, with a live session and a code from the secret held since step 1.`,
    );

    /* And D reaches aal2 again ONLY by enrolling a new one. */
    const fresh = await enrollTotp(dSession);
    assert.equal(fresh.ok, true, `D enrols a new factor: ${JSON.stringify(fresh).slice(0, 200)}`);
    const freshVerified = await verifyTotp(dSession, fresh.factorId, totpCode(fresh.secret));
    assert.equal(freshVerified.ok, true, 'and reaches aal2 only that way');
    assert.equal((await sessionOf(freshVerified.tokens.accessToken)).aal, 'aal2');

    /* THE LOCAL LIMIT, ASSERTED AS AN OBSERVATION AND NEVER AS A PASS (design 1.3 step 10, section 9). The local
       stack signs with HS256 and its secret cannot be rotated, so nothing above replaced the verification
       authority and every credential minted before the incident still verifies. At the hosted target restore
       step 6 is what refuses these, and case E7-31 is the local evidence that a replaced key refuses what a
       re-imported one admits. */
    const limit = { userTokens: [], serverBearers: [], dataApi: [], serverAtDataApi: null, atGoTrue: staleAtGoTrue.gotrueErrorCode };
    for (const name of ['U', 'cMember', 'D']) {
      const v = await verifySession({ headers: { cookie: `${COOKIES.access}=${held[name].token}` } });
      limit.userTokens.push(`${name}:${v.ok ? 'verifies' : 'refused'}`);
      /* The bearer held from BEFORE the dump, checked by its signature and not by sending it: sixty seconds have
         long passed, and what the hosted key replacement breaks is exactly this signature (E7B-F1, E7-31). */
      const [h, p, sig] = held[name].bearer.split('.');
      const recomputed = createHmac('sha256', process.env.SUPABASE_JWT_SECRET).update(`${h}.${p}`).digest('base64url');
      limit.serverBearers.push(`${name}:${recomputed === sig ? 'verifies' : 'refused'}`);
      limit.dataApi.push(`${name}:${(await postgrest('/my_standing?select=*', held[name].token)).status}`);
    }
    /* And the same chain end to end: the session held from before the incident mints a bearer the Data API
       ANSWERS, because nothing local replaced the verification authority. A read, and D is A's administrator. */
    const asServerNow = await postgrest('/rpc/departure_preview', await held.D.bearerNow(), {
      method: 'POST',
      body: { p_membership: w.A.ms.member },
    });
    limit.serverAtDataApi = asServerNow.status;
    assert.equal(limit.userTokens.includes('U:verifies'), true, 'OBSERVED, not a pass: U’s stale access token still verifies');
    assert.equal(
      limit.serverBearers.every((x) => x.endsWith(':verifies')),
      true,
      'OBSERVED, not a pass: every server bearer held from before the dump still verifies under the unrotatable local HS256 secret',
    );
    console.log(
      `recorded, THE LOCAL LIMIT of the rehearsal (design section 9, B7 is NOT closed here): after the lift, the ` +
        `stale user access tokens ${limit.userTokens.join(', ')}; the stale server bearers ` +
        `${limit.serverBearers.join(', ')}; the Data API answered those tokens ${limit.dataApi.join(', ')}, and a ` +
        `bearer minted from D's held session reached api.departure_preview with ${limit.serverAtDataApi}. The ` +
        `local stack cannot rotate its HS256 secret, so restore step 6 has no local effect; H-R1 to H-R6 are what ` +
        `assert the refusal at a real target, and E7-31 is the local control for the key replacement itself. ` +
        `WHAT DOES REFUSE THE SAME TOKEN LOCALLY: GoTrue, with ${limit.atGoTrue}, because C6 deleted the session ` +
        `row it looks up. The verifier and PostgREST do not look one up, which is why they still answer it.`,
    );

    /* The register is intact across the whole rehearsal and still verifies against the head anchored before it. */
    const verified = run('register.mjs', ['verify', '--anchored-head', firstHead], reg.env);
    assert.equal(verified.status, 0, verified.output.slice(0, 500));
    const written = lines(reg.path);
    assert.equal(written.some((l) => l.act === 'restore.begin' && l.epoch === 1), true);
    assert.equal(written.filter((l) => l.act === 'company.hold_lift').length, 2, 'one lift line per company lifted');
    /* `end` REFUSES while any company is still held, and names each one. The seed's own two companies are held
       by C0 like every other, and the rehearsal lifted only A and B, so this arm is here by construction rather
       than by contrivance: it is what an operator meets when a company's confirmation call has not happened. */
    const refusedEnd = run('reconcile.mjs', ['end', '--operator', ids.U_op], reg.env);
    assert.equal(refusedEnd.status, 1, refusedEnd.output.slice(0, 600));
    const waiting = events(refusedEnd, 'end_waiting').map((e) => e.companyId);
    assert.ok(waiting.length >= 1, `it names each company still waiting: ${JSON.stringify(waiting)}`);
    assert.equal(waiting.includes(w.A.id), false, 'and none of them is a company the rehearsal lifted');
    assert.equal(waiting.includes(w.B.id), false);
    assert.equal(
      waiting.length,
      Number(count("app.companies where status = 'held'")),
      'it names EVERY held company and no other',
    );
    assert.equal(lines(reg.path).at(-1).act !== 'restore.end', true, 'a refused end appends nothing');

    /* Their confirmations, and then `end` closes the epoch. */
    for (const companyId of waiting) {
      const lifted = run(
        'reconcile.mjs',
        ['lift', '--operator', ids.U_op, '--company', companyId, '--confirmation', `rehearsal:call-seed-${RUN}`,
          '--anchored-head', anchoredHead, '--apply'],
        reg.env,
      );
      assert.equal(lifted.status, 0, lifted.output.slice(0, 600));
    }
    assert.equal(count("app.companies where status = 'held'"), 0, 'no company is held');
    const ended = run('reconcile.mjs', ['end', '--operator', ids.U_op], reg.env);
    assert.equal(ended.status, 0, ended.output.slice(0, 600));
    assert.equal(lines(reg.path).at(-1).act, 'restore.end');
  } finally {
    if (!reopened) reopenLocally();
  }
});

// ---------------------------------------------------------------------------
// E7-16's FAIL-BEFORE: the same restore with `begin` and the reconciler skipped
// and the closure opened. It is B7's counterexample and E7D-C-F3's, observed.
// ---------------------------------------------------------------------------

/* WHY IT IS BEHIND A SEAM. This arm is a SECOND whole restore cycle: it doubles the rehearsal's duration, which
   section 6 C7 measures precisely because the rehearsal is now an unconditional full-suite gate. So it is run
   once, deliberately, with E7_16_FAIL_BEFORE=1, and its output is the recorded fail-before under
   evidence/e7-restore-repro/. The gate never sets it. It is evidence, not a check: the check is the case above,
   whose every refusal this arm shows admitted when the controls are removed. */
const FAIL_BEFORE = process.env.E7_16_FAIL_BEFORE === '1';

test('E7-16 FAIL-BEFORE: without begin, without the reconciler and with the schema open, every door is open', { timeout: TIMEOUTS.failBefore, skip: FAIL_BEFORE ? false : 'E7_16_FAIL_BEFORE is not set: this arm is recorded evidence, not a gate' }, async () => {
  const reg = newRegister('fb');
  const dumpPath = join(scratch('fb'), 'backup.dump');
  const refs = {};

  const w = await buildWorld(`fb${RUN}`);
  syncAndAnchor(reg, refs);
  const held = await holdCredentials(w);
  pgDump(dumpPath);
  await actAfterTheBackup(w, reg, refs, held);

  const observed = [];
  try {
    /* THE ONLY DIFFERENCE: the closure is NOT applied, `begin` is NOT run and the reconciler is NOT run. The
       restore is the same restore, from the same dump, with the same credentials held throughout. */
    restoreInPlace(dumpPath);

    const mReads = await R.releasesList(held.M.cookie, w.A.id);
    observed.push(`M, removed after the backup, reads A: ${mReads.status}`);
    assert.equal(mReads.status, 200, 'M READS A, which is B7’s counterexample');

    const download = await R.download(w.A.member, w.release.releaseId);
    observed.push(`R, withdrawn after the backup, downloads: ${download.status}`);
    assert.equal(download.status, 200, 'THE WITHDRAWN RELEASE DOWNLOADS');

    observed.push(`C, deleted after the backup, is back: ${count(`app.companies where id = '${w.C.id}'`)} row(s)`);
    assert.equal(count(`app.companies where id = '${w.C.id}'`), 1, 'C IS BACK');

    const link = await verifyLink(held.L.tokenHash);
    observed.push(`L, consumed after the backup, signs U in again: ${link}`);
    assert.ok(link < 400, 'THE CONSUMED SIGN-IN LINK WORKS AGAIN');

    const dSession = await sessionOf(held.D.token);
    const oldFactor = await verifyTotp(dSession, w.D.factorId, totpCode(w.D.secret));
    observed.push(`D’s deleted authenticator reaches aal2 again: ${oldFactor.ok}`);
    assert.equal(oldFactor.ok, true, 'D’S DELETED FACTOR REACHES aal2 AGAIN');

    observed.push(`X, swept after the backup, is back: ${count(`auth.users where id = '${w.X.id}'`)} row(s)`);
    observed.push(`B, suspended after the backup, is ${statusOf(w.B.id)} again`);
    observed.push(`U’s reduced role is ${rolesOf(w.A.ms.it)} again`);
  } finally {
    console.log(`recorded, E7-16's FAIL-BEFORE (no closure, no begin, no reconciler):\n  ${observed.join('\n  ')}`);
    reopenLocally();
    reseedInPlace();
  }
});

// ---------------------------------------------------------------------------
// Section 6, C7: the rehearsal's durations, measured once and recorded.
// ---------------------------------------------------------------------------

test('section 6 C7: the rehearsal’s durations, recorded with the seed that produced them', () => {
  assert.ok(durations.length > 0, 'the rehearsal above ran and timed its steps');
  const bytes = durations.find((d) => d.step === 'dump-bytes')?.ms ?? 0;
  const named = durations.filter((d) => d.step !== 'dump-bytes');
  const total = named.reduce((n, d) => n + d.ms, 0);
  assert.ok(c7Seed !== null, 'the rehearsal recorded the world it measured');
  /* Printed, not asserted: section 6 says these are measurements to take and none is a claim until measured.
     The one thing asserted is that the whole rehearsal fits inside the bound this file fails at, because that
     is what makes it safe as an unconditional full-suite gate (E7D-C-F13). */
  console.log(
    `recorded, section 6 C7, the local restore rehearsal on this stack: ` +
      `${named.map((d) => `${d.step} ${d.ms} ms`).join(', ')}; total ${total} ms; the dump is ${bytes} bytes; ` +
      `the world that produced them, counted at the dump: ${JSON.stringify(c7Seed)}.`,
  );
  assert.ok(total < TIMEOUTS.rehearsal, `the whole rehearsal took ${total} ms, inside its ${TIMEOUTS.rehearsal} ms bound`);
});
