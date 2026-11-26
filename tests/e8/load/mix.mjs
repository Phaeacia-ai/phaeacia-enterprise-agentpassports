#!/usr/bin/env node
/* The mixed run at the capacity envelope, and the excess sweep (docs/e8/design.md 4.1, as amended
 * 2026-09-20 by E8D-R-F2 and E8D-R-F5; evidence/e8-design.md 5.1, day 4).
 *
 *   node tests/e8/load/mix.mjs --label <label> [--rounds 10] [--phase mix|excess]
 *
 * It reads the world seed.mjs wrote and appends one record per phase under
 * evidence/e8-load-repro/. NOT A GATE: scripts/check.sh does not run this directory and nothing
 * here asserts the plan's two-second target. The run DOES fail on the clause of item 6 that is not
 * a number: an entitled caller refused, an unentitled caller admitted, or an unexplained non-2xx.
 *
 * THE TWO HALVES (E8D-R-F2). The entitled half is five request classes over twenty sessions. The
 * unentitled half is interleaved at ten per cent of the requests issued, with refusals counted per
 * class and required to equal the unentitled requests issued and admissions required to be zero. It
 * is excluded from the headline p95 and reported beside it with its own p95 and code distribution,
 * because a tenancy refusal is a short path and folding it in would flatter the envelope.
 *
 * THE p95 EXCLUDES LOGIN BY CONSTRUCTION. Every session is established before the first timed call
 * and no timed call performs one (E6's capacity header records why).
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg } from 'node:os';
import { join } from 'node:path';

import { mintUserToken, ROOT, sql, stackEnv, userJwt } from '../../e2/helpers/stack.mjs';
import { attribution, caller, largePassport, passport, percentile, withFetch } from '../../e3/stack/helpers.mjs';
import { readWorld, SHAPE } from './seed.mjs';

const OUT_DIR = join(ROOT, 'evidence', 'e8-load-repro');
const PLAN_MS = 2000; // the plan's item 6 target, compared against and never asserted
const ERROR_KEYS = new Set(['ok', 'code', 'message', 'problems']); // lib/http/response.mjs error()
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* ---------------------------------------------------------------- the mix, as a table */

/* Design 4.1's shares, met by two per-session cycles rather than by one cycle both sessions draw
   from. THE REASON, entered as a deviation in the day-4 amendment block: the envelope gives one
   company twenty concurrent sessions over ten companies, which is two identities per company, and
   4.1 asks five caller shapes of them. The members list's caller is "an admin at aal2" and the
   release read's is "a recipient"; an admin's release read takes the ledger branch
   (lib/services/releases.mjs:225-227) and would measure a different read. So the admin identity
   carries the members list and no release read, the reviewer identity carries the release read and
   no members list, and the union over the two is exactly 4.1's table. */
const CYCLES = Object.freeze({
  admin: Object.freeze(['catalog', 'queue', 'download', 'members', 'catalog', 'download', 'queue', 'catalog', 'download', 'members']),
  reviewer: Object.freeze(['catalog', 'queue', 'release', 'catalog', 'release', 'queue', 'download', 'release', 'catalog', 'release']),
});
const CLASSES = Object.freeze(['catalog', 'queue', 'release', 'download', 'members']);
/* The share each class holds of the entitled half, for the record to compare with what ran. */
const SHARES = Object.freeze({ catalog: 0.3, queue: 0.2, release: 0.2, download: 0.2, members: 0.1 });

/* The four refusable caller shapes of 4.1's second table. `aal1` is not defined on the five classes
   above, because none of them is an aal2 route (the members list has an aal2 BRANCH for invitation
   addresses and answers a member at aal1 with 200); it is driven against the aal2 route it is
   defined on. Finding E8L-F2 and deviation D4-A3 record that. */
const SHAPES = Object.freeze(['other-company', 'removed-member', 'stranger', 'aal1']);

/* ---------------------------------------------------------------- owner-side plumbing */

function sqlScript(text, { timeoutMs = 600_000 } = {}) {
  const { dbContainer } = stackEnv();
  const r = spawnSync(
    'docker',
    ['exec', '-i', dbContainer, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'],
    { input: text, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: timeoutMs },
  );
  if (r.status !== 0) throw new Error(`owner psql exited ${r.status}: ${`${r.stderr}${r.stdout}`.slice(0, 900)}`);
  return (r.stdout ?? '').trim();
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
/* psql under -At prints a data-modifying statement's command tag AFTER its RETURNING row, so a read
   that expects one value drops the tags and takes the first line that is left (see seed.mjs). */
const TAG =
  /^(INSERT|UPDATE|DELETE|MERGE|COPY|CREATE|ALTER|DROP|TRUNCATE|BEGIN|COMMIT|ROLLBACK|SET|DO|NOTIFY|GRANT|REVOKE|ANALYZE|VACUUM|SELECT [0-9]+$)\b/;
const lastLine = (text) => {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !TAG.test(l));
  return lines[0] ?? '';
};

/** The seeded password, read from the scratch ids the reseed wrote. Never printed, never recorded. */
function seededPassword() {
  for (const line of readFileSync(join(ROOT, '.scratch', 'e2', 'ids.env'), 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && line.slice(0, i).trim() === 'PW') return line.slice(i + 1).trim();
  }
  throw new Error('the scratch ids file carries no PW; reseed first');
}

const summary = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const f = (x) => Number(x.toFixed(1));
  return s.length === 0
    ? { n: 0 }
    : { n: s.length, p50: f(percentile(s, 50)), p95: f(percentile(s, 95)), p99: f(percentile(s, 99)), max: f(s.at(-1)) };
};

/** Every Data API request a route call makes, timed to its response headers and attributed. */
function countingFetch(url, init, original) {
  const store = attribution.getStore();
  if (store) store.calls += 1;
  const t0 = performance.now();
  return original(url, init).then((res) => {
    if (store) store.db += performance.now() - t0;
    return res;
  });
}

/** An answer to an unentitled call carries a row when its body holds any key the error envelope
    does not. lib/http/response.mjs: an error body is { ok, code, message } and `problems` alone. */
function carriesRow(body) {
  if (body === null || typeof body !== 'object') return false;
  return Object.keys(body).some((k) => !ERROR_KEYS.has(k));
}

/* ---------------------------------------------------------------- phase: the mixed run */

async function runMix(world, rounds) {
  const { COOKIES } = await import('../../../lib/session.mjs');
  const { makeRequest } = await import('../../../lib/http/request.mjs');
  const { makeRoutes } = await import('../../../lib/http/routes.mjs');
  const alerts = [];
  const logged = [];
  const routes = makeRoutes({ log: (entry) => logged.push(entry), alert: (a) => alerts.push(a) });
  const call = caller(routes, COOKIES, makeRequest);
  const PW = seededPassword();

  /* ---- the sessions, every one established before the first timed call ---- */
  const sessions = [];
  for (const c of world.companies) {
    /* The admin at aal2: minting with the local secret is the only local way to aal2
       (tests/e2/helpers/stack.mjs), and the members list's caller is an admin at aal2. */
    const adminToken = mintUserToken({ sub: c.admin.userId, email: c.admin.email, aal: 'aal2', ttl: 7200 });
    /* The reviewer's is a real GoTrue password grant, so at least half the run's sessions are ones
       GoTrue issued rather than ones this harness minted. */
    const reviewerToken = userJwt(c.reviewer.email, PW);
    const adminAal1 = mintUserToken({ sub: c.admin.userId, email: c.admin.email, aal: 'aal1', ttl: 7200 });
    sessions.push({
      id: `c${c.index}-admin`,
      company: c,
      cycle: CYCLES.admin,
      user: { token: () => adminToken },
      aal1: { token: () => adminAal1 },
    });
    sessions.push({
      id: `c${c.index}-reviewer`,
      company: c,
      cycle: CYCLES.reviewer,
      user: { token: () => reviewerToken },
      /* The fourth refusable shape is "a member at aal1 on an aal2 route", and the member for whom
         aal2 decides anything is the administrator: a reviewer's own token meets the ROLE refusal
         (E_FORBIDDEN) before the assurance one and would exercise a different shape. So both of a
         company's sessions drive that shape with the company's administrator at aal1. */
      aal1: { token: () => adminAal1 },
    });
  }
  /* Two identities per company, which at the envelope's ten companies is its twenty concurrent
     sessions. A world of fewer companies (a smoke run) is allowed and the record says so. */
  if (sessions.length !== world.companies.length * 2)
    throw new Error(`${sessions.length} sessions for ${world.companies.length} companies`);
  const atEnvelope = sessions.length === world.envelope.concurrentSessions;

  /* ---- the unentitled half's two built identities, established and then made unentitled ---- */
  /* A stranger: a confirmed account with a valid session and no membership anywhere. */
  const strangerEmail = `e8l-${world.label}-stranger@example.invalid`;
  const strangerId = lastLine(
    sqlScript(`insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
      values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${q(strangerEmail)}, clock_timestamp(), clock_timestamp(), clock_timestamp())
      on conflict (id) do nothing;
    select id::text from auth.users where email = ${q(strangerEmail)};`),
  );
  if (!UUID_RE.test(strangerId)) throw new Error(`the stranger account was not created: ${strangerId}`);
  const strangerUser = { token: () => mintUserToken({ sub: strangerId, email: strangerEmail, aal: 'aal1', ttl: 7200 }) };
  strangerUser.token();

  /* A removed member with a live cookie, one per company: an active membership created here, its
     session established here, and the membership set `removed` BEFORE the first timed call. The
     company therefore holds exactly the envelope's 25 active members for the whole timed run, and
     the cookie is the one that was minted while the membership was active (4.1's second row). */
  const removed = new Map();
  for (const c of world.companies) {
    const email = `e8l-${world.label}-c${c.index}-removable@example.invalid`;
    const userId = lastLine(
      sqlScript(`insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
        select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
               ${q(email)}, clock_timestamp(), clock_timestamp(), clock_timestamp()
         where not exists (select 1 from auth.users where email = ${q(email)});
      select id::text from auth.users where email = ${q(email)};`),
    );
    if (!UUID_RE.test(userId)) throw new Error(`the removable account was not created: ${userId}`);
    sqlScript(`insert into app.memberships (company_id, user_id, roles)
                 values (${q(c.companyId)}, ${q(userId)}, '{member}')
               on conflict (company_id, user_id) do update set status = 'active', removed_at = null;`);
    const user = { token: () => mintUserToken({ sub: userId, email, aal: 'aal1', ttl: 7200 }) };
    user.token(); /* established while the membership is active */
    removed.set(c.index, user);
  }
  /* Now, and only now, the removals. */
  sqlScript(`update app.memberships m set status = 'removed', removed_at = clock_timestamp()
               from auth.users u
              where u.id = m.user_id and u.email like ${q(`e8l-${world.label}-c%-removable@example.invalid`)}
                and m.status = 'active';`);
  const activeNow = Number(
    lastLine(sqlScript(`select count(*) from app.memberships m
                          join app.companies c on c.id = m.company_id
                         where m.status = 'active' and c.slug like ${q(`e8l-${world.label}-c%`)};`)),
  );

  /* ---- the request table ---- */
  const entitled = {
    catalog: (s) => call('catalogRead', { user: s.user, params: { companyId: s.company.companyId } }),
    queue: (s) => call('reviewQueue', { user: s.user, params: { companyId: s.company.companyId } }),
    release: (s) => call('releasesRead', { user: s.user, params: { releaseId: s.company.downloadRelease } }),
    download: (s) => call('releasesDownload', { user: s.user, params: { releaseId: s.company.downloadRelease } }),
    members: (s) => call('membersList', { user: s.user, params: { companyId: s.company.companyId } }),
  };
  /* The unentitled half. 15 combinations of three shapes by the five classes, plus the aal1 shape on
     the aal2 route it is defined on, is 16; the run walks them evenly. */
  const other = (s) => world.companies[(s.company.index + 1) % world.companies.length];
  const unentitled = [];
  for (const klass of CLASSES) {
    unentitled.push({
      klass,
      shape: 'other-company',
      expect: 404,
      run: (s) => {
        const o = other(s);
        return klass === 'release'
          ? call('releasesRead', { user: s.user, params: { releaseId: o.downloadRelease } })
          : klass === 'download'
            ? call('releasesDownload', { user: s.user, params: { releaseId: o.downloadRelease } })
            : call(klass === 'catalog' ? 'catalogRead' : klass === 'queue' ? 'reviewQueue' : 'membersList', {
                user: s.user,
                params: { companyId: o.companyId },
              });
      },
    });
    unentitled.push({
      klass,
      shape: 'removed-member',
      expect: 404,
      run: (s) => entitled[klass]({ ...s, user: removed.get(s.company.index) }),
    });
    unentitled.push({
      klass,
      shape: 'stranger',
      expect: 404,
      run: (s) => entitled[klass]({ ...s, user: strangerUser }),
    });
  }
  unentitled.push({
    klass: 'invitations',
    shape: 'aal1',
    expect: 403,
    run: (s) => call('invitationsList', { user: s.aal1, params: { companyId: s.company.companyId } }),
  });

  /* ---- the round loop ---- */
  const log = [];
  const record = (row) => {
    log.push(row);
    return row;
  };
  const oneCall = async (row, fn) => {
    const store = { db: 0, calls: 0 };
    const t0 = performance.now();
    let r;
    try {
      r = await attribution.run(store, fn);
    } catch (e) {
      return record({ ...row, ms: performance.now() - t0, status: 0, code: `THROWN:${e.constructor.name}`, db: store.db, calls: store.calls, row: false });
    }
    return record({
      ...row,
      ms: Number((performance.now() - t0).toFixed(2)),
      status: r.status,
      code: r.body && typeof r.body === 'object' && typeof r.body.code === 'string' ? r.body.code : null,
      db: Number(store.db.toFixed(2)),
      calls: store.calls,
      row: carriesRow(r.body),
    });
  };

  const loadDuring = [];
  const sampler = setInterval(() => loadDuring.push(loadavg().map((n) => Number(n.toFixed(2)))), 5000);
  const startedAt = Date.now();
  const t0 = performance.now();
  await withFetch(countingFetch, () =>
    Promise.all(
      sessions.map(async (s, si) => {
        let cursor = 0;
        for (let round = 0; round < rounds; round++) {
          for (let k = 0; k < 9; k++) {
            const klass = s.cycle[cursor % s.cycle.length];
            cursor += 1;
            await oneCall({ session: s.id, company: s.company.index, half: 'entitled', klass, shape: 'entitled', round }, () =>
              entitled[klass](s),
            );
          }
          const u = unentitled[(si * rounds + round) % unentitled.length];
          await oneCall(
            { session: s.id, company: s.company.index, half: 'unentitled', klass: u.klass, shape: u.shape, round, expect: u.expect },
            () => u.run(s),
          );
        }
      }),
    ),
  );
  const wallMs = performance.now() - t0;
  clearInterval(sampler);

  return { log, wallMs, startedAt, alerts, activeNow, loadDuring, sessions: sessions.length, atEnvelope };
}

/* ---------------------------------------------------------------- the classification */

/* Every non-2xx is classified. Design 4.1: an unexplained E_INTERNAL fails the run (E6SC-F5), and
   E_READ_OVER_BOUND is an EXPECTED 500 wherever the sweep drives PostgREST's max_rows, so the two
   are kept apart here rather than counted together. */
function classify(log) {
  const findings = [];
  const falseRefusals = [];
  const admissions = [];
  const unexplained = [];
  const offDesign = [];
  for (const r of log) {
    if (r.half === 'entitled') {
      /* item 6's first direction: a 401, a 403 or a 404 where the caller WAS entitled. */
      if (r.status < 200 || r.status >= 300) {
        falseRefusals.push(r);
        unexplained.push(r);
      }
      continue;
    }
    /* item 6's second direction, which the first version of 4.1 could not observe (E8D-R-F2): any
       2xx, and any answer carrying a row, on a call that should have been refused. */
    if (r.status >= 200 && r.status < 300) {
      admissions.push(r);
      continue;
    }
    if (r.row) {
      admissions.push(r);
      continue;
    }
    /* Every remaining non-2xx is classified. A 5xx and an E_INTERNAL are unexplained and fail the
       run (E6SC-F5); E_READ_OVER_BOUND is an expected 500 and is driven by the excess sweep, never
       by the mix, so meeting one here would be unexplained too and is not special-cased away. */
    if (r.status >= 500 || r.code === 'E_INTERNAL' || r.status === 0) {
      unexplained.push(r);
      continue;
    }
    /* A refusal that carried no row. It counts toward "refusals equal requests issued" whatever its
       code, which is the clause 4.1 states; a code other than the one the design names is recorded
       as a finding for the lead rather than failing the run, because the refusal did happen. */
    if (r.expect !== undefined && r.status !== r.expect) offDesign.push(r);
  }
  if (falseRefusals.length > 0)
    findings.push({ id: 'AUTHZ-FALSE-REFUSAL', severity: 'blocking', n: falseRefusals.length, sample: falseRefusals.slice(0, 5) });
  if (admissions.length > 0)
    findings.push({ id: 'AUTHZ-ADMISSION', severity: 'blocking', n: admissions.length, sample: admissions.slice(0, 5) });
  if (unexplained.length > 0)
    findings.push({ id: 'UNEXPLAINED-NON-2XX', severity: 'blocking', n: unexplained.length, sample: unexplained.slice(0, 5) });
  if (offDesign.length > 0)
    findings.push({
      id: 'REFUSAL-CODE-OFF-DESIGN',
      severity: 'recorded',
      n: offDesign.length,
      sample: offDesign.slice(0, 5),
      note: 'refused, and carried no row, with a status other than the one design 4.1 names for that caller shape',
    });
  return {
    findings,
    blocking: findings.filter((f) => f.severity === 'blocking'),
    falseRefusals: falseRefusals.length,
    admissions: admissions.length,
    unexplained: unexplained.length,
    offDesign: offDesign.length,
  };
}

/* ---------------------------------------------------------------- phase: the excess sweep */

/* Design 4.1's three kinds of ceiling, each driven past, each required to answer ITS OWN code, each
   OUTSIDE the timed mix so none of it enters the p95. The seven quota ceilings answer their own 409;
   E_READ_OVER_BOUND is a 500 BY DESIGN (lib/errors.mjs:83) and is classified as an expected one; the
   body bound is two bounds and neither is on the mix's read path, so each names the route it drives. */
async function runExcess(world, PW) {
  const { COOKIES } = await import('../../../lib/session.mjs');
  const { makeRequest } = await import('../../../lib/http/request.mjs');
  const { makeRoutes } = await import('../../../lib/http/routes.mjs');
  const routes = makeRoutes({ log: () => {} });
  const call = caller(routes, COOKIES, makeRequest);
  const c = world.companies[0];
  const admin = { token: () => mintUserToken({ sub: c.admin.userId, email: c.admin.email, aal: 'aal2', ttl: 7200 }) };
  const author = { token: () => mintUserToken({ sub: c.author.userId, email: c.author.email, aal: 'aal1', ttl: 7200 }) };
  const key = () => randomUUID();
  const arms = [];
  const arm = (ceiling, route, expectStatus, expectCode, answer, notes = null) =>
    arms.push({
      ceiling,
      route,
      expectStatus,
      expectCode,
      status: answer.status,
      code: answer.body?.code ?? null,
      met: answer.status === expectStatus && (answer.body?.code ?? null) === expectCode,
      notes,
    });
  /* The quota ceilings count ROWS, so the drafts that drive them carry the ordinary synthetic
     passport and not the 262,144-byte one: 190 drafts at the content bound would add fifty
     megabytes and several minutes to a sweep that is measuring a refusal, not a size. The two body
     bounds below are the arms that need the large one. */
  const body = (tag) => passport(`e8-load-${tag}`);

  /* 1. agents_per_company (default 50). The company holds the envelope's 50 agents, so the next
        create_draft that names a new agent meets the ceiling. */
  arm(
    'agents_per_company',
    'POST /api/companies/{id}/candidates (new agent)',
    409,
    'E_AGENT_LIMIT',
    await call('candidatesCreate', {
      user: author,
      params: { companyId: c.companyId },
      headers: { 'idempotency-key': key(), 'x-agent-name': 'e8-load-excess-agent' },
      body: body('agent'),
    }),
  );

  /* 2. versions_per_agent (default 200). The seed leaves ten versions on each agent, so 190 more
        drafts on one agent bring it to the ceiling and the 201st is refused. */
  const agentId = lastLine(
    sqlScript(`select id::text from app.agents where company_id = ${q(c.companyId)} order by name limit 1;`),
  );
  let versionArm = null;
  for (let i = 0; i < 195; i++) {
    const r = await call('candidatesCreate', {
      user: author,
      params: { companyId: c.companyId },
      headers: { 'idempotency-key': key(), 'x-agent-id': agentId },
      body: body(`v${i}`),
    });
    if (r.status !== 201) {
      versionArm = r;
      break;
    }
  }
  arm(
    'versions_per_agent',
    'POST /api/companies/{id}/candidates (existing agent)',
    409,
    'E_VERSION_LIMIT',
    versionArm ?? { status: 0, body: { code: 'NOT-REACHED' } },
    versionArm === null ? 'the ceiling was not reached in 195 drafts' : null,
  );

  /* 3. groups_per_company (default 50). Ten exist; forty more reach the ceiling. */
  let groupArm = null;
  for (let i = 0; i < 45; i++) {
    const r = await call('groupsCreate', {
      user: admin,
      params: { companyId: c.companyId },
      body: { name: `e8-load-excess-group-${i}` },
    });
    if (r.status !== 201 && r.status !== 200) {
      groupArm = r;
      break;
    }
  }
  arm(
    'groups_per_company',
    'POST /api/companies/{id}/groups',
    409,
    'E_GROUP_LIMIT',
    groupArm ?? { status: 0, body: { code: 'NOT-REACHED' } },
    groupArm === null ? 'the ceiling was not reached in 45 creations' : null,
  );

  /* 4. members_per_company (default 25). The company holds exactly the envelope's 25 active members,
        so an invitation meets api.invite_member's seat test (008:552), which is the defense in depth
        in front of api.accept_invitation's authoritative one (008:646). The sweep drives 552; the
        routine at 646 is the one a member actually meets and is not driven here. */
  arm(
    'members_per_company',
    'POST /api/companies/{id}/invitations',
    409,
    'E_SEATS_EXHAUSTED',
    await call('invitationsCreate', {
      user: admin,
      params: { companyId: c.companyId },
      headers: { 'idempotency-key': key() },
      body: { email: `e8l-${world.label}-seat@example.invalid`, roles: ['member'], expiresInDays: 7 },
    }),
    'driven at 008:552, the defense in depth; 008:646 is the authoritative seat test and is not driven here',
  );

  /* 5. pending_invitations_per_company (default 50). UNREACHABLE at the default seat quota, and that
        is itself the finding: api.invite_member tests seats (active + pending >= members_per_company,
        25) BEFORE it can ever count fifty pending invitations, so the fifty-invitation ceiling cannot
        refuse anybody while members_per_company is 25. The sweep raises members_per_company to its
        own upper bound on a company of its own, which is an IN-RANGE operator write and therefore
        never produces E_QUOTA_OUT_OF_RANGE (E8D-R-F18 stands). Deviation D4-A4. */
  const sweepAdminEmail = `e8l-${world.label}-sweep-admin@example.invalid`;
  const sweepAdminId = lastLine(
    sqlScript(`insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
      select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
             ${q(sweepAdminEmail)}, clock_timestamp(), clock_timestamp(), clock_timestamp()
       where not exists (select 1 from auth.users where email = ${q(sweepAdminEmail)});
    select id::text from auth.users where email = ${q(sweepAdminEmail)};`),
  );
  const sweepCompany = lastLine(
    spawnSync(
      'bash',
      [
        '-c',
        'cd "$0" && source tests/db/lib.sh && source .scratch/e2/ids.env && source tests/db/e3-lib.sh && company "$1" "$2"',
        ROOT,
        `e8l-${world.label}-sweep`,
        sweepAdminId,
      ],
      { encoding: 'utf8', env: process.env },
    ).stdout ?? '',
  );
  if (!UUID_RE.test(sweepCompany)) throw new Error(`the sweep company was not provisioned: ${sweepCompany}`);
  sqlScript(`insert into app.company_quotas (company_id, name, value)
               values (${q(sweepCompany)}, 'members_per_company', 500)
             on conflict on constraint company_quotas_pkey do update set value = excluded.value;`);
  const sweepAdmin = {
    token: () => mintUserToken({ sub: sweepAdminId, email: sweepAdminEmail, aal: 'aal2', ttl: 7200 }),
  };
  let invitationArm = null;
  for (let i = 0; i < 55; i++) {
    const r = await call('invitationsCreate', {
      user: sweepAdmin,
      params: { companyId: sweepCompany },
      headers: { 'idempotency-key': key() },
      body: { email: `e8l-${world.label}-inv-${i}@example.invalid`, roles: ['member'], expiresInDays: 7 },
    });
    if (r.status !== 201 && r.status !== 200) {
      invitationArm = r;
      break;
    }
  }
  arm(
    'pending_invitations_per_company',
    'POST /api/companies/{id}/invitations',
    409,
    'E_INVITATION_LIMIT',
    invitationArm ?? { status: 0, body: { code: 'NOT-REACHED' } },
    'unreachable at the default members_per_company of 25; driven on a sweep-only company whose seat quota was set to 500, which is inside app.quota_bounds and so is not E_QUOTA_OUT_OF_RANGE',
  );

  /* 6. downloads_per_recipient (default 200) on one recipient and one release of the sweep company's
        own world: the ledger is filled owner-side to one below the ceiling and the route drives the
        last two, so the refusal is the routine's and not two hundred round trips'. */
  const dlRelease = c.downloadRelease;
  const dlMembership = c.reviewer.membershipId;
  const dlUser = { token: () => userJwt(c.reviewer.email, PW) };
  const already = Number(
    lastLine(
      sqlScript(`select count(*) from app.release_downloads
                  where release_id = ${q(dlRelease)} and membership_id = ${q(dlMembership)};`),
    ),
  );
  if (already < 199)
    sqlScript(`insert into app.release_downloads (company_id, release_id, membership_id)
                 select r.company_id, r.id, ${q(dlMembership)} from app.releases r, generate_series(1, ${199 - already})
                  where r.id = ${q(dlRelease)};`);
  const lastGood = await call('releasesDownload', { user: dlUser, params: { releaseId: dlRelease } });
  arm(
    'downloads_per_recipient',
    'POST /api/releases/{id}/download',
    409,
    'E_DOWNLOAD_LIMIT',
    await call('releasesDownload', { user: dlUser, params: { releaseId: dlRelease } }),
    `the two hundredth authorization answered ${lastGood.status}`,
  );

  /* 7. reports_per_recipient (default 20). */
  let reportArm = null;
  for (let i = 0; i < 25; i++) {
    const r = await call('installationsCreate', {
      user: dlUser,
      params: { releaseId: dlRelease },
      headers: { 'idempotency-key': key() },
      body: { status: 'pass' },
    });
    if (r.status !== 201 && r.status !== 200) {
      reportArm = r;
      break;
    }
  }
  arm(
    'reports_per_recipient',
    'POST /api/releases/{id}/installations',
    409,
    'E_REPORT_LIMIT',
    reportArm ?? { status: 0, body: { code: 'NOT-REACHED' } },
    reportArm === null ? 'the ceiling was not reached in 25 reports' : null,
  );

  /* 8. PostgREST's max_rows of 200, through readAll's E_READ_OVER_BOUND, which is a 500 BY DESIGN
        (lib/errors.mjs:83) and is classified as an expected 500 and not with the unexplained ones.
        The ledger of one release is filled past LEDGER_CEILING (10,000) and its admin reads it. */
  /* A release the timed mix never touched, so the ledger's size is this sweep's and not the run's. */
  const boundRelease = lastLine(
    sqlScript(`select r.id::text from app.releases r join app.agents a on a.id = r.agent_id
                where r.company_id = ${q(world.companies[1].companyId)}
                  and r.superseded_by_release_id is null
                  and substring(a.name from '[0-9]+$') :: int = 4;`),
  );
  if (!UUID_RE.test(boundRelease)) throw new Error(`no bound release: ${boundRelease}`);
  const boundAdmin = {
    token: () =>
      mintUserToken({
        sub: world.companies[1].admin.userId,
        email: world.companies[1].admin.email,
        aal: 'aal2',
        ttl: 7200,
      }),
  };
  /* First, E4D-C-F5's bound measured AT the bound: 5,000 retained download rows, which E5 design 6
     derives as 200 downloads x 25 members and which E4's 10,000-row LEDGER_CEILING contains. */
  const seeded = Number(
    lastLine(sqlScript(`select count(*) from app.release_downloads where release_id = ${q(boundRelease)};`)),
  );
  if (seeded > SHAPE.boundLedgerRows)
    throw new Error(`the bound release already holds ${seeded} ledger rows, above ${SHAPE.boundLedgerRows}`);
  sqlScript(`insert into app.release_downloads (company_id, release_id, membership_id)
               select r.company_id, r.id, m.id
                 from app.releases r
                 join lateral (select id from app.memberships
                                where company_id = r.company_id and status = 'active' order by id limit 25) m on true,
                      generate_series(1, ${Math.ceil((SHAPE.boundLedgerRows - seeded) / 25)})
                where r.id = ${q(boundRelease)}
                limit ${SHAPE.boundLedgerRows - seeded};`);
  const atBound = Number(
    lastLine(sqlScript(`select count(*) from app.release_downloads where release_id = ${q(boundRelease)};`)),
  );
  const boundReads = [];
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    const r = await call('releasesRead', { user: boundAdmin, params: { releaseId: boundRelease } });
    boundReads.push({ ms: performance.now() - t, status: r.status, recipients: r.body?.recipientCount ?? null });
  }
  /* Then past the ceiling. */
  sqlScript(`insert into app.release_downloads (company_id, release_id, membership_id)
               select r.company_id, r.id, m.id
                 from app.releases r
                 join lateral (select id from app.memberships
                                where company_id = r.company_id and status = 'active' order by id limit 1) m on true,
                      generate_series(1, ${Math.max(1, 10_001 - atBound)})
                where r.id = ${q(boundRelease)};`);
  const overBound = Number(
    lastLine(sqlScript(`select count(*) from app.release_downloads where release_id = ${q(boundRelease)};`)),
  );
  arm(
    'PostgREST max_rows, readAll ceiling',
    'GET /api/releases/{id} (an admin, so the ledger is read)',
    500,
    'E_READ_OVER_BOUND',
    await call('releasesRead', { user: boundAdmin, params: { releaseId: boundRelease } }),
    `${overBound} ledger rows, above LEDGER_CEILING 10000; an EXPECTED 500 by lib/errors.mjs:83 and not an unexplained one`,
  );

  /* 9. MAX_PASSPORT_BYTES (262,144) on a route declared body: 'passport'. */
  const tooBig = Buffer.concat([largePassport('over'), Buffer.from('x'.repeat(64), 'utf8')]);
  arm(
    'MAX_PASSPORT_BYTES',
    'POST /api/companies/{id}/candidates (body: passport)',
    413,
    'E_BODY_TOO_LARGE',
    await call('candidatesCreate', {
      user: author,
      params: { companyId: c.companyId },
      headers: { 'idempotency-key': key(), 'x-agent-id': agentId },
      body: tooBig,
    }),
    `${tooBig.length} bytes, 64 past the bound; outside the timed mix, whose five classes are four GETs and a download with no body`,
  );

  /* 10. MAX_BODY_BYTES (16 KiB) on an ordinary JSON route. */
  arm(
    'MAX_BODY_BYTES',
    'POST /api/companies/{id}/groups (body: json)',
    413,
    'E_BODY_TOO_LARGE',
    await call('groupsCreate', {
      user: admin,
      params: { companyId: c.companyId },
      body: `{"name":"${'g'.repeat(17 * 1024)}"}`,
    }),
    `${17 * 1024 + 12} bytes, past the 16 KiB bound`,
  );

  return {
    arms,
    e4dcf5: {
      ledgerRows: atBound,
      reads: summary(boundReads.map((r) => r.ms)),
      statuses: [...new Set(boundReads.map((r) => r.status))],
      recipients: boundReads[0]?.recipients ?? null,
    },
    overBoundLedgerRows: overBound,
    sweepCompany,
  };
}

/* ---------------------------------------------------------------- phase: E6SC-F1's own row */

/* E6SC-F1 (docs/e8/debts.md 7.2) measured E4's worst review-queue page at 2,122.4 and 2,159.0 ms p95
 * with **twenty concurrent callers on ONE page**, and design 4.3 says day 4 records what that row
 * does today. The mixed run above is a different and more realistic configuration: its twenty
 * sessions read TEN different companies' queues, so no single page is hammered. This arm reproduces
 * E6SC-F1's configuration exactly (tests/e4/stack/capacity.test.mjs: "20 concurrent calls, 5
 * rounds", one warm-up round discarded) so the decision Raffael is asked to make rests on the same
 * shape of measurement as the number it is compared with. It runs AFTER the timed mix and is never
 * part of its p95.
 */
async function runWorstPage(world, rounds) {
  const { COOKIES } = await import('../../../lib/session.mjs');
  const { makeRequest } = await import('../../../lib/http/request.mjs');
  const { makeRoutes } = await import('../../../lib/http/routes.mjs');
  const call = caller(makeRoutes({ log: () => {} }), COOKIES, makeRequest);
  const c = world.companies[0];
  const reader = {
    token: () => mintUserToken({ sub: c.admin.userId, email: c.admin.email, aal: 'aal2', ttl: 7200 }),
  };
  reader.token();
  /* The page's own shape, asserted rather than assumed: the seed's worst queue page is 50 submitted
     candidates each carrying SHAPE.queueEnvelopes envelopes, which is E4's own worst page. */
  const first = await call('reviewQueue', { user: reader, params: { companyId: c.companyId } });
  if (first.status !== 200) throw new Error(`the queue read answered ${first.status}`);
  const page = {
    awaitingDecision: first.body?.awaitingDecision?.length ?? null,
    envelopesOnTheFirst: first.body?.awaitingDecision?.[0]?.envelopes?.length ?? null,
  };
  const totals = [];
  const loadDuring = [];
  const sampler = setInterval(() => loadDuring.push(loadavg().map((n) => Number(n.toFixed(2)))), 5000);
  for (let round = 0; round < rounds + 1; round++) {
    const batch = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const t = performance.now();
        const r = await call('reviewQueue', { user: reader, params: { companyId: c.companyId } });
        return { ms: performance.now() - t, status: r.status };
      }),
    );
    for (const b of batch) if (b.status !== 200) throw new Error(`the queue read answered ${b.status}`);
    if (round > 0) for (const b of batch) totals.push(b.ms);
  }
  clearInterval(sampler);
  return { page, rounds, concurrency: 20, summary: summary(totals), loadDuring, company: c.index };
}

/* ---------------------------------------------------------------- records */

function writeRecord(name, value) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const a = { label: null, rounds: 10, phase: 'mix' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--label') a.label = argv[++i];
    else if (argv[i] === '--rounds') a.rounds = Number.parseInt(argv[++i], 10);
    else if (argv[i] === '--phase') a.phase = argv[++i];
    else {
      process.stderr.write(`mix: unknown argument ${argv[i]}\n`);
      process.exit(2);
    }
  }
  if (a.label === null) {
    process.stderr.write('mix: --label names the world seed.mjs built\n');
    process.exit(2);
  }
  if (!['mix', 'excess', 'worst-page'].includes(a.phase)) {
    process.stderr.write('mix: --phase is mix, excess or worst-page\n');
    process.exit(2);
  }
  if (!Number.isInteger(a.rounds) || a.rounds < 1) {
    process.stderr.write('mix: --rounds is an integer of at least 1\n');
    process.exit(2);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
stackEnv();
const world = readWorld(args.label);
const machine = {
  cpu: cpus()[0]?.model ?? 'unknown',
  logicalCpus: availableParallelism(),
  node: process.version,
  postgres: sql('show server_version'),
};
const loadBefore = loadavg().map((n) => Number(n.toFixed(2)));

if (args.phase === 'mix') {
  const { log, wallMs, startedAt, alerts, activeNow, loadDuring, sessions, atEnvelope } = await runMix(world, args.rounds);
  const verdict = classify(log);
  const entitledRows = log.filter((r) => r.half === 'entitled');
  const unentitledRows = log.filter((r) => r.half === 'unentitled');
  const perClass = {};
  for (const klass of CLASSES) {
    const rows = entitledRows.filter((r) => r.klass === klass);
    perClass[klass] = {
      ...summary(rows.map((r) => r.ms)),
      dataApi: summary(rows.map((r) => r.db)),
      requestsPerCall: rows.length === 0 ? null : [Math.min(...rows.map((r) => r.calls)), Math.max(...rows.map((r) => r.calls))],
      share: Number((rows.length / entitledRows.length).toFixed(4)),
      sharePlanned: SHARES[klass],
      underTarget: rows.length === 0 ? null : percentile([...rows.map((r) => r.ms)].sort((a, b) => a - b), 95) < PLAN_MS,
    };
  }
  const refusalCodes = {};
  for (const r of unentitledRows) {
    const k = `${r.klass}|${r.shape}|${r.status}|${r.code ?? 'null'}`;
    refusalCodes[k] = (refusalCodes[k] ?? 0) + 1;
  }
  const perShape = {};
  for (const shape of SHAPES) {
    const rows = unentitledRows.filter((r) => r.shape === shape);
    perShape[shape] = { issued: rows.length, refused: rows.filter((r) => r.status >= 400).length, carriedRow: rows.filter((r) => r.row).length };
  }
  const out = {
    id: 'E8-LOAD-MIX',
    label: world.label,
    at: new Date(startedAt).toISOString(),
    command: `node tests/e8/load/mix.mjs --label ${world.label} --rounds ${args.rounds}`,
    seed: { label: world.label, command: `node tests/e8/load/seed.mjs --label ${world.label}`, builtAt: world.builtAt, totals: world.totals },
    envelope: world.envelope,
    machine,
    loadAverageBefore: loadBefore,
    loadAverageDuring: loadDuring,
    loadAverageAfter: loadavg().map((n) => Number(n.toFixed(2))),
    sessions,
    sessionsAtEnvelope: atEnvelope,
    companies: world.companies.length,
    activeMembersDuringRun: activeNow,
    rounds: args.rounds,
    wallSeconds: Number((wallMs / 1000).toFixed(1)),
    requests: { total: log.length, entitled: entitledRows.length, unentitled: unentitledRows.length, unentitledShare: Number((unentitledRows.length / log.length).toFixed(4)) },
    planTargetMs: PLAN_MS,
    entitledPerClass: perClass,
    unentitled: {
      count: unentitledRows.length,
      p95: summary(unentitledRows.map((r) => r.ms)),
      refused: unentitledRows.filter((r) => r.status >= 400).length,
      admitted: verdict.admissions,
      perShape,
      codes: refusalCodes,
    },
    authorizationFailures: { falseRefusals: verdict.falseRefusals, admissions: verdict.admissions },
    unexplainedNon2xx: verdict.unexplained,
    alerts: alerts.length,
    refusalsOffDesign: verdict.offDesign,
    findings: verdict.findings,
    pass: verdict.blocking.length === 0,
  };
  writeRecord(`mix-${world.label}.json`, out);
  writeRecord(
    `mix-${world.label}-requests.tsv`,
    `session\tcompany\thalf\tclass\tshape\tround\tstatus\tcode\tms\tdb_ms\tdb_calls\tcarried_row\n${log
      .map((r) => [r.session, r.company, r.half, r.klass, r.shape, r.round, r.status, r.code ?? '', r.ms, r.db, r.calls, r.row].join('\t'))
      .join('\n')}\n`,
  );
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!out.pass) process.exitCode = 1;
} else if (args.phase === 'worst-page') {
  const worst = await runWorstPage(world, args.rounds < 5 ? 5 : args.rounds);
  const out = {
    id: 'E8-LOAD-WORST-PAGE',
    label: world.label,
    at: new Date().toISOString(),
    command: `node tests/e8/load/mix.mjs --label ${world.label} --phase worst-page`,
    seed: { label: world.label, command: `node tests/e8/load/seed.mjs --label ${world.label}`, builtAt: world.builtAt },
    debt: 'E6SC-F1 (docs/e8/debts.md 7.2), measured at 2,122.4 and 2,159.0 ms p95 on 2026-09-18',
    configuration: "E4's own: twenty concurrent calls on ONE company's review queue, one warm-up round discarded",
    machine,
    planTargetMs: PLAN_MS,
    loadAverageBefore: loadBefore,
    loadAverageAfter: loadavg().map((n) => Number(n.toFixed(2))),
    ...worst,
    underTarget: worst.summary.p95 < PLAN_MS,
  };
  writeRecord(`worst-page-${world.label}.json`, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} else {
  const excess = await runExcess(world, seededPassword());
  const out = {
    id: 'E8-LOAD-EXCESS',
    label: world.label,
    at: new Date().toISOString(),
    command: `node tests/e8/load/mix.mjs --label ${world.label} --phase excess`,
    seed: { label: world.label, command: `node tests/e8/load/seed.mjs --label ${world.label}` },
    machine,
    loadAverageBefore: loadBefore,
    loadAverageAfter: loadavg().map((n) => Number(n.toFixed(2))),
    ...excess,
    met: excess.arms.filter((a) => a.met).length,
    total: excess.arms.length,
    pass: excess.arms.every((a) => a.met),
  };
  writeRecord(`excess-${world.label}.json`, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!out.pass) process.exitCode = 1;
}
