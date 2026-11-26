/* E3b critique F3 against the running local stack: a contributor list longer than PostgREST's max_rows (200,
   supabase/config.toml) comes back whole in the submit answer and through the read route. The chains are built
   through the routes as the critic built them (evidence/e3b-critique-repro/extra.mjs.txt, probe.mjs.txt): every
   version submitted through the route with 50 declarations (the last with 49 names and the reviewer's membership),
   a change request through api.record_review, the successor through the route. Four versions hold 202 rows,
   twenty-one hold 1,052. The 21-version build is the slow part and lives only in this file. Reseeds once and builds
   its own world. Run one file at a time: node --test --test-concurrency=1 tests/e3/stack/ */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SUBMISSION } from '../unit/submission-shapes.mjs';
import { caller, key, passport, requestChanges, reseed, sql, withFetch, world } from './helpers.mjs';

const ids = reseed();
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');

const call = caller(makeRoutes({ log: () => {} }), COOKIES, makeRequest);
const W = world('contrib', ids);
const admin = W.user('admin');
const author = W.user('author');
const reviewer = W.user('reviewer');
const A = W.company('a', admin);
const M = { author: W.member(A.id, author), reviewer: W.member(A.id, reviewer, '{it_reviewer,member}') };

/* One contributor as a comparable line, from the API and from the table. */
const fromApi = (c) => [c.kind, c.membershipId ?? '', c.displayName ?? '', c.inheritedFromCandidateId ?? ''].join('|');
const stored = (candidateId) =>
  JSON.parse(
    sql(
      `select coalesce(json_agg(json_build_object('k', kind, 'm', membership_id, 'd', display_name, 'i', inherited_from_candidate_id)), '[]') from app.candidate_contributors where candidate_id='${candidateId}'`,
    ),
  ).map((r) => [r.k, r.m ?? '', r.d ?? '', r.i ?? ''].join('|'));

async function chain(name, versions) {
  const d = await call('candidatesCreate', {
    user: author,
    params: { companyId: A.id },
    headers: { 'x-agent-name': name, 'idempotency-key': key() },
    body: passport(name),
  });
  assert.equal(d.status, 201, d.raw);
  let candidateId = d.body.candidateId;
  let submitted = null;
  for (let n = 1; n <= versions; n++) {
    const declaredContributors = Array.from({ length: n === versions ? 49 : 50 }, (_, i) => ({
      displayName: `${name}-${n}-${i}`,
    }));
    if (n === versions) declaredContributors.push({ membershipId: M.reviewer });
    submitted = await call('candidatesSubmit', {
      user: author,
      params: { candidateId },
      headers: { 'idempotency-key': key(), 'if-match': '1' },
      body: { ...SUBMISSION, declaredContributors },
    });
    assert.equal(submitted.status, 200, submitted.raw);
    if (n < versions) {
      requestChanges(candidateId);
      const next = await call('candidatesSuccessor', {
        user: author,
        params: { candidateId },
        headers: { 'idempotency-key': key() },
        body: {},
      });
      assert.equal(next.status, 201, next.raw);
      candidateId = next.body.candidateId;
    }
  }
  return { candidateId, submitted };
}

/* The read route, with the number of contributor pages it asked PostgREST for. */
async function readCounted(user, candidateId) {
  let pages = 0;
  const r = await withFetch(
    (url, init, original) => {
      if (String(url).includes('/rest/v1/candidate_contributors?')) pages++;
      return original(url, init);
    },
    () => call('candidatesRead', { user, params: { candidateId } }),
  );
  return { ...r, pages };
}

function assertWhole(label, contributors, rows, candidateId) {
  assert.equal(contributors.length, rows.length, `${label}: every stored row`);
  assert.deepEqual(contributors.map(fromApi).sort(), [...rows].sort(), `${label}: the stored list itself`);
  assert.ok(
    contributors.some((c) => c.kind === 'declared_member' && c.membershipId === M.reviewer && !c.inheritedFromCandidateId),
    `${label}: the reviewer's own declaration of ${candidateId}`,
  );
  const own = contributors.findIndex((c) => c.inheritedFromCandidateId);
  assert.ok(own > 0 && contributors.slice(own).every((c) => c.inheritedFromCandidateId), `${label}: own rows first`);
}

test('E3b critique F3: a four-version chain holds 202 contributors; the submit answer and the read route return all 202', async () => {
  const { candidateId, submitted } = await chain(`four-${W.run}`, 4);
  const rows = stored(candidateId);
  assert.equal(rows.length, 202);
  assertWhole('submit', submitted.body.contributors, rows, candidateId);
  const read = await readCounted(reviewer, candidateId);
  assert.equal(read.status, 200, read.raw);
  assertWhole('read', read.body.contributors, rows, candidateId);
  assert.equal(read.pages, 2, 'a full page of 200, then a short page of 2');
});

test('E3b critique F3: a 21-version chain holds 1,052 contributors; submit, the reviewer and the author read all of them', async (t) => {
  const started = performance.now();
  const { candidateId, submitted } = await chain(`twentyone-${W.run}`, 21);
  const seconds = (performance.now() - started) / 1000;
  t.diagnostic(`21-version chain built through the routes in ${seconds.toFixed(1)} s`);
  const rows = stored(candidateId);
  assert.equal(rows.length, 1052);
  assertWhole('submit', submitted.body.contributors, rows, candidateId);
  for (const user of [reviewer, author]) {
    const read = await readCounted(user, candidateId);
    assert.equal(read.status, 200, read.raw);
    assertWhole(`read by ${user.who}`, read.body.contributors, rows, candidateId);
    assert.equal(read.pages, 6, 'five full pages, then 52');
  }
});
