/* Case 22: a held company lock is 409 E_BUSY in under 6 s with no partial write, and the retry
   succeeds. Case 26: 20 concurrent set_roles requests across 10 companies, measured on this
   machine against the local stack (a measurement with limits, not a production claim). */
import assert from 'node:assert/strict';

import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, mintUserToken, psqlSession, seed, sleep, sql } from '../helpers/stack.mjs';

const ids = seed();
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');

const routes = makeRoutes({ log: () => {} });
const token = (sub, who) => mintUserToken({ sub, email: `synthetic-${who}@example.invalid`, aal: 'aal2' });
const setRoles = async (tok, company, membership, roles) => {
  const res = await routes.membersSetRoles(
    makeRequest({
      method: 'PATCH',
      path: '/api/test',
      params: { companyId: company, membershipId: membership },
      headers: { cookie: `${COOKIES.access}=${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ roles }),
    }),
  );
  return { status: res.status, body: JSON.parse(res.body) };
};
const memberRow = (userId, company) =>
  sql(
    `select id || ' ' || array_to_string(roles, ',') from app.memberships where user_id='${userId}' and company_id='${company}'`,
  );

test('case 22: lock timeout is 409 E_BUSY in under 6 s, nothing is written, and the retry succeeds', async () => {
  const admin = token(ids.U_alpha_admin1, 'alpha-admin1');
  const [membershipId] = memberRow(ids.U_alpha_member, ids.ALPHA).split(' ');
  const auditsBefore = Number(sql('select count(*) from app.audit_events'));
  const holder = psqlSession();
  let r;
  let elapsed;
  try {
    holder.write('begin;');
    holder.write(`select id from app.companies where id='${ids.ALPHA}' for no key update;`);
    await sleep(500);
    const t0 = performance.now();
    r = await setRoles(admin, ids.ALPHA, membershipId, ['it_reviewer']);
    elapsed = performance.now() - t0;
    /* Session A holds the lock for 6 s in total; the request must answer before that. */
    await sleep(Math.max(0, 6000 - 500 - elapsed));
  } finally {
    holder.write('commit;');
    await holder.end();
  }
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'E_BUSY');
  assert.ok(elapsed < 6000, `answered in ${elapsed.toFixed(0)} ms`);
  assert.ok(elapsed >= 4000, `the app_server lock_timeout is 5 s; answered in ${elapsed.toFixed(0)} ms`);
  assert.equal(memberRow(ids.U_alpha_member, ids.ALPHA), `${membershipId} member`, 'no partial write');
  assert.equal(Number(sql('select count(*) from app.audit_events')), auditsBefore, 'no audit row');
  const retry = await setRoles(admin, ids.ALPHA, membershipId, ['it_reviewer']);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.deepEqual(retry.body.roles, ['it_reviewer', 'member']);
  assert.equal(Number(sql('select count(*) from app.audit_events')), auditsBefore + 1);
  writeFileSync(
    join(ROOT, '.scratch', 'e2', 'case22.json'),
    JSON.stringify({ elapsedMs: Math.round(elapsed), retryStatus: retry.status }),
  );
});

test('case 26 measurement: 20 concurrent set_roles across 10 companies, no E_BUSY, p95 under 2 s', async () => {
  /* Fixture, OWNER-SIDE since E6: ten companies with alpha's admin1 as first admin and alpha's member as the
     target member in each. It was built through POST /api/operator/companies, which until E6 called
     api.provision_company with a prepared auth.users id; that route is now api.create_company, which takes an
     ADDRESS and creates no membership at all, so it cannot make this fixture (E6 design 1.1, lead decision
     2026-09-17). The rows are inserted here instead, which is what the next statement already did for the member
     memberships: this test's subject is twenty concurrent set_roles, and the companies are its setup. */
  const companies = sql(
    `insert into app.companies (slug, name) select 'synthetic-cap-' || g, 'SYNTHETIC Capacity ' || g
       from generate_series(0, 9) g returning id`,
  )
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(line));
  assert.equal(companies.length, 10, 'ten companies');
  const values = companies
    .flatMap((c) => [
      `('${c}', '${ids.U_alpha_admin1}', '{company_admin,member}')`,
      `('${c}', '${ids.U_alpha_member}', '{member}')`,
    ])
    .join(',');
  sql(`insert into app.memberships (company_id, user_id, roles) values ${values}`);
  const targets = companies.map((c) => memberRow(ids.U_alpha_member, c).split(' ')[0]);
  const admin = token(ids.U_alpha_admin1, 'alpha-admin1');
  const auditsBefore = Number(sql('select count(*) from app.audit_events'));

  const calls = [];
  for (let i = 0; i < 10; i++) {
    calls.push({ company: companies[i], membership: targets[i], roles: ['it_reviewer'] });
    calls.push({ company: companies[i], membership: targets[i], roles: ['business_reviewer'] });
  }
  const t0 = performance.now();
  const results = await Promise.all(
    calls.map(async (c) => {
      const s = performance.now();
      const r = await setRoles(admin, c.company, c.membership, c.roles);
      return { ...r, ms: performance.now() - s };
    }),
  );
  const wall = performance.now() - t0;
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)];
  const summary = {
    calls: results.length,
    statuses: results.reduce((m, r) => {
      m[r.status] = (m[r.status] ?? 0) + 1;
      return m;
    }, {}),
    busy: results.filter((r) => r.body.code === 'E_BUSY').length,
    p50Ms: Math.round(pct(50)),
    p95Ms: Math.round(pct(95)),
    maxMs: Math.round(latencies.at(-1)),
    wallMs: Math.round(wall),
    changedTrue: results.filter((r) => r.body.changed === true).length,
    deadlocks: Number(sql('select deadlocks from pg_stat_database where datname = current_database()')),
  };
  writeFileSync(join(ROOT, '.scratch', 'e2', 'case26.json'), JSON.stringify(summary, null, 2));
  assert.equal(summary.busy, 0, JSON.stringify(summary));
  assert.deepEqual(summary.statuses, { 200: 20 }, JSON.stringify(summary));
  assert.ok(summary.p95Ms < 2000, JSON.stringify(summary));
  /* Both calls per company serialised under the company lock: each changed the roles, so every
     call is changed:true and the final roles are one of the two sets; audit rows equal changes. */
  assert.equal(summary.changedTrue, 20);
  assert.equal(Number(sql('select count(*) from app.audit_events')), auditsBefore + 20);
  for (const c of companies) {
    const roles = memberRow(ids.U_alpha_member, c).split(' ')[1];
    assert.ok(roles === 'it_reviewer,member' || roles === 'business_reviewer,member', roles);
  }
});
