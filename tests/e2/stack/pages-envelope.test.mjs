/* Pages construction, the bounds and the envelope against the local stack (pages design 7.2): S2's and S3's volume
   arms (149, 150, 151 and 250 memberships; 149, 150 and 151 invitations) and S10's measurement. Reseeds once. The
   volume fixtures are written by the migration owner in bulk: auth.users rows with synthetic addresses, their
   memberships, and pending invitations, because a label or a flag, not the invitation path, is what these cases test.
   The viewer is the fixture company's admin with a token minted at aal2 with the local secret.

   S10's timed region is one route call: from immediately before the route function is invoked with its request
   object to the moment its answer resolves, measured with performance.now() inside the same process, so it includes
   the pipeline, session verification, every PostgREST round trip and JSON encoding, and it includes waiting behind the
   other calls of its batch. Each batch is 20 calls started together with Promise.all; five batches per size after one
   unmeasured warm-up call. Percentiles are nearest-rank over the sorted samples: p is the smallest sample with at
   least p percent of the samples at or below it. The result is written to .scratch/pages-server/s10.json. This measures
   one local machine and establishes no hosted capacity. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { caller, mint, percentile, ROOT, sql } from '../helpers/pages.mjs';
import { seed } from '../helpers/stack.mjs';

seed();
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');

const routes = makeRoutes({ log: () => {} });
const { call } = caller(routes, { COOKIES, makeRequest });
const run = randomBytes(3).toString('hex');
const first = (text) => text.split('\n')[0];

/** A company with its admin, written by the owner; returns { companyId, adminId, adminMembership, token }. */
function company(tag) {
  const companyId = first(
    sql(`insert into app.companies (slug, name) values ('pages-${tag}-${run}', 'SYNTHETIC ${tag}') returning id`),
  );
  const email = `pages-${tag}-${run}-admin@example.invalid`;
  const adminId = first(
    sql(
      `insert into auth.users (id, email, aud, role, created_at, updated_at) values (gen_random_uuid(), '${email}', 'authenticated', 'authenticated', now(), now()) returning id`,
    ),
  );
  const adminMembership = first(
    sql(
      `insert into app.memberships (company_id, user_id, roles) values ('${companyId}', '${adminId}', '{company_admin,member}') returning id`,
    ),
  );
  return { companyId, adminId, adminMembership, token: mint({ sub: adminId, email, aal: 'aal2' }) };
}

let batch = 0;
function addMembers(c, n) {
  batch++;
  sql(
    `with u as (insert into auth.users (id, email, aud, role, created_at, updated_at) select gen_random_uuid(), 'pages-m-${run}-${batch}-' || g || '@example.invalid', 'authenticated', 'authenticated', now(), now() from generate_series(1, ${n}) g returning id) insert into app.memberships (company_id, user_id, roles) select '${c.companyId}', id, '{member}' from u`,
  );
}
function addInvitations(c, n) {
  batch++;
  sql(
    `insert into app.invitations (company_id, email_normalized, token_hash, roles, expires_at, created_by) select '${c.companyId}', 'pages-i-${run}-${batch}-' || g || '@example.invalid', extensions.gen_random_bytes(32), '{member}', now() + interval '7 days', '${c.adminMembership}' from generate_series(1, ${n}) g`,
  );
}
const count = (from, companyId) => Number(sql(`select count(*) from ${from} where company_id = '${companyId}'`));

test('S2 volume: 149, 150 and 151 visible memberships answer truncated false, false and true; 250 still answers 150 rows, truncated', async () => {
  const c = company('members');
  addMembers(c, 148);
  const cases = [
    [0, 149, false, 149],
    [1, 150, false, 150],
    [1, 151, true, 150],
    [99, 250, true, 150],
  ];
  for (const [add, total, truncated, rows] of cases) {
    if (add) addMembers(c, add);
    assert.equal(count('app.memberships', c.companyId), total);
    const r = await call('membersList', { access: c.token, params: { companyId: c.companyId } });
    assert.equal(r.status, 200, `${total}: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.equal(r.body.truncated, truncated, `${total} memberships`);
    assert.equal(r.body.members.length, rows, `${total} memberships`);
  }
});

test('S3 volume: 149, 150 and 151 invitations answer truncated false, false and true', async () => {
  const c = company('invitations');
  addInvitations(c, 149);
  for (const [add, total, truncated] of [
    [0, 149, false],
    [1, 150, false],
    [1, 151, true],
  ]) {
    if (add) addInvitations(c, add);
    assert.equal(count('app.invitations', c.companyId), total);
    const r = await call('invitationsList', { access: c.token, params: { companyId: c.companyId } });
    assert.equal(r.status, 200);
    assert.equal(r.body.truncated, truncated, `${total} invitations`);
    assert.equal(r.body.invitations.length, Math.min(total, 150));
  }
});

test('S10 envelope: 25 members and 149, 150, 151 and 400 invitations, 20 concurrent list calls per batch; p50, p95 and maximum recorded; target p95 under 2 s', async (t) => {
  const c = company('envelope');
  addMembers(c, 24);
  assert.equal(count('app.memberships', c.companyId), 25);
  const timed = async (name) => {
    const t0 = performance.now();
    const r = await call(name, { access: c.token, params: { companyId: c.companyId } });
    return { ms: performance.now() - t0, status: r.status, truncated: r.body?.truncated };
  };
  await timed('membersList');
  await timed('invitationsList');
  const results = [];
  let present = 0;
  for (const [size, truncated] of [
    [149, false],
    [150, false],
    [151, true],
    [400, true],
  ]) {
    addInvitations(c, size - present);
    present = size;
    for (const name of ['invitationsList', 'membersList']) {
      const samples = [];
      for (let b = 0; b < 5; b++) {
        const answers = await Promise.all(Array.from({ length: 20 }, () => timed(name)));
        for (const a of answers) {
          assert.equal(a.status, 200, `${name} at ${size}`);
          assert.equal(a.truncated, name === 'membersList' ? false : truncated, `${name} at ${size}`);
          samples.push(a.ms);
        }
      }
      samples.sort((a, b) => a - b);
      const row = {
        route: name,
        invitations: size,
        members: 25,
        calls: samples.length,
        p50: Math.round(percentile(samples, 50)),
        p95: Math.round(percentile(samples, 95)),
        max: Math.round(samples.at(-1)),
      };
      results.push(row);
      t.diagnostic(`S10 ${JSON.stringify(row)}`);
    }
  }
  mkdirSync(join(ROOT, '.scratch', 'pages-server'), { recursive: true });
  writeFileSync(
    join(ROOT, '.scratch', 'pages-server', 's10.json'),
    `${JSON.stringify({ at: new Date().toISOString(), node: process.version, cpus: cpus().length, method: 'nearest-rank; region: route call; 5 batches of 20 concurrent calls after one warm-up call', results }, null, 2)}\n`,
  );
  for (const row of results) assert.ok(row.p95 < 2000, `${row.route} at ${row.invitations}: p95 ${row.p95} ms`);
});
