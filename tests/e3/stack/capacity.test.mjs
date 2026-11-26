/* Case 20 (E3 design section 6 and 7.2): 20 concurrent saves of 256 KiB across 10 companies, through the save route,
   against the local stack. For every save it records the whole request's time and the time the request spent awaiting
   PostgREST (every read and call it made, attributed to it); separately, the gate's own time on the largest fixture,
   run alone. The plan's target is p95 under two seconds excluding gate time. These are local numbers from one machine
   running the database, PostgREST and all 20 requests, with every limit written beside them in
   .scratch/e3b/capacity.txt; they are never a production claim. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  attribution,
  caller,
  key,
  largePassport,
  MAX_BYTES,
  percentile,
  ROOT,
  reseed,
  sql,
  timedFetch,
  withFetch,
  world,
} from './helpers.mjs';

const ids = reseed();
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { gate } = await import('../../../lib/passport/gate.mjs');

const routes = makeRoutes({ log: () => {} });
const call = caller(routes, COOKIES, makeRequest);
const W = world('capacity', ids);

const COMPANIES = 10;
const PER_COMPANY = 2;
const WARMUP_ROUNDS = 1;
const ROUNDS = 10;
const GATE_RUNS = 30;

const summary = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const f = (x) => x.toFixed(1);
  return `n=${s.length} p50=${f(percentile(s, 50))} p95=${f(percentile(s, 95))} p99=${f(percentile(s, 99))} max=${f(s.at(-1))} ms`;
};

test('case 20: 20 concurrent 256 KiB saves across 10 companies; p95 excluding gate time, and the gate alone for the largest fixture', async (t) => {
  const drafts = [];
  for (let i = 0; i < COMPANIES; i++) {
    const admin = W.user(`admin-${i}`);
    const author = W.user(`author-${i}`);
    const company = W.company(`c${i}`, admin);
    W.member(company.id, author);
    for (let j = 0; j < PER_COMPANY; j++) {
      const r = await call('candidatesCreate', {
        user: author,
        params: { companyId: company.id },
        headers: { 'idempotency-key': key(), 'x-agent-name': `capacity-${i}-${j}` },
        body: largePassport(`create-${i}-${j}`),
      });
      assert.equal(r.status, 201, r.raw);
      drafts.push({ author, candidateId: r.body.candidateId, version: 1 });
    }
  }
  assert.equal(drafts.length, COMPANIES * PER_COMPANY);

  const largest = largePassport('gate-alone');
  assert.equal(largest.length, MAX_BYTES);
  const gateTimes = [];
  for (let i = 0; i < GATE_RUNS; i++) {
    const t0 = performance.now();
    const verdict = gate(largest, 'text/markdown', { validatedAt: new Date().toISOString() });
    gateTimes.push(performance.now() - t0);
    assert.equal(verdict.ok, true);
  }

  const totals = [];
  const database = [];
  const rest = [];
  const statuses = new Map();
  for (let round = 0; round < WARMUP_ROUNDS + ROUNDS; round++) {
    const bodies = drafts.map((_, i) => largePassport(`round-${round}-${i}`));
    const results = await withFetch(timedFetch, () =>
      Promise.all(
        drafts.map(async (d, i) => {
          const store = { db: 0 };
          const t0 = performance.now();
          const r = await attribution.run(store, () =>
            call('candidatesSave', {
              user: d.author,
              params: { candidateId: d.candidateId },
              headers: { 'idempotency-key': key(), 'if-match': String(d.version) },
              body: bodies[i],
            }),
          );
          return { d, r, total: performance.now() - t0, db: store.db };
        }),
      ),
    );
    for (const { d, r, total, db } of results) {
      statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
      if (r.status === 200) d.version = r.body.version;
      if (round < WARMUP_ROUNDS) continue;
      totals.push(total);
      database.push(db);
      rest.push(total - db);
    }
  }
  assert.deepEqual([...statuses.entries()], [[200, (WARMUP_ROUNDS + ROUNDS) * drafts.length]], 'every save succeeded');

  const lines = [
    `case 20, measured ${new Date().toISOString()}`,
    `seed: ${COMPANIES} companies, one member author each, ${PER_COMPANY} drafts each; every body exactly ${MAX_BYTES} bytes (the synthetic passport with 3,000 prose lines in section 3 and trailing spaces, a new revision marker per save); ${ROUNDS} measured rounds of ${drafts.length} concurrent saves after ${WARMUP_ROUNDS} warm-up round; every save a fresh Idempotency-Key and the current If-Match`,
    `save, whole request through the route, gate included (standing read, gate, bound call, answer): ${summary(totals)}`,
    `save, from each PostgREST request to its parsed answer (the draft read and save_draft): ${summary(database)}`,
    `save, the remainder (this request's own gate and JSON work): ${summary(rest)}`,
    `gate alone, the largest fixture, ${GATE_RUNS} sequential runs: ${summary(gateTimes)}`,
    `machine: ${cpus()[0]?.model ?? 'unknown'}, ${availableParallelism()} logical CPUs; Node ${process.version}; PostgreSQL ${sql('show server_version')}`,
    'reading: the 20 requests share one Node process, so the gates run one after another on one event loop; a PostgREST answer that arrives while another request gates waits for the loop, and that wait is counted in the PostgREST figure, not in the remainder. The two cannot be separated in one process, so the figure this case can state without that ambiguity is the whole request, gate time included, which bounds the time excluding it from above.',
    'limits: one machine runs the database, PostgREST, GoTrue and all 20 requests; separate function instances would gate in parallel; the database round trip is loopback; no TLS; the local stack is not the hosted plan; the rows are synthetic; no cold start is included; a local measurement is not production readiness.',
  ];
  mkdirSync(join(ROOT, '.scratch', 'e3b'), { recursive: true });
  writeFileSync(join(ROOT, '.scratch', 'e3b', 'capacity.txt'), `${lines.join('\n')}\n`);
  for (const line of lines) t.diagnostic(line);
  const sortedTotals = [...totals].sort((a, b) => a - b);
  assert.ok(
    percentile(sortedTotals, 95) < 2000,
    `p95 of the whole request, gate included, is under the plan's two seconds: ${summary(totals)}`,
  );
});
