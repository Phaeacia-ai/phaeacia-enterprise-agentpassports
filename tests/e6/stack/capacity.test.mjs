/* Section 6 of the E6 design: the capacity sample for the operator register, the departure preview, the agent
   transfer, the expiry run, the company's own copy and the deletion. Local numbers from one machine running the
   database, PostgREST, GoTrue and every request, written with the seed that produced them to
   .scratch/e6/capacity.txt, and to the evidence copy only when CAPACITY_EVIDENCE=1. They are RECORDED, never
   claimed: this file asserts that every measured request succeeded and that the wire byte figure was read, and
   the record compares each p95 with the plan's two seconds.

   THE SEED IS A SAMPLE AND NOT THE DESIGN'S FULL ENVELOPE, and that is the first limit of every number below.
   Design section 6 asks for ten companies at 25 members with 50 agents and 300 release rows each, plus three
   further companies at the two size ceilings. Building that here would take longer than the whole E6 stack gate,
   so this file measures what it can build in one run: the companies it creates through the operator route, one
   of them filled owner-side to the plan's 25 active and 25 removed memberships and to its pending-invitation
   quota, and the E4-shaped company tests/e6/stack/routes.test.mjs builds. Every number therefore says how many
   companies and how many rows produced it, and the register's cost is the one that grows with the whole table
   rather than with a page (P16), so the company count is the number to read it against.

   EVERY SESSION IS MADE BEFORE THE FIRST TIMED CALL. An ordinary test user's token is a real GoTrue sign-in made
   lazily on first use, so a measurement that also signs somebody in measures the sign-in.

   Reseeds once, and runs alone as every stack file does. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  agePeriod,
  e4world,
  e6lib,
  e6routes,
  enableTargets,
  freshEmail,
  futurePeriod,
  linkParts,
  operators,
  percentile,
  periodBody,
  published,
  reseed,
  reviewCompany,
  ROOT,
  sql,
  withFetch,
} from './helpers.mjs';

const ids = reseed();
enableTargets();
const R = await e6routes();
const W = e4world('e6-cap', ids);
const OP = operators(ids);

/* The measured companies. One is the E4-shaped company with members, agents, releases and a ledger; the rest are
   created through the operator route so the register has a page worth of rows to order and count. */
const A = await reviewCompany(W, R, 'cap');
futurePeriod(A.id);
const EXTRA = 11;
const created = [];
for (let i = 0; i < EXTRA; i++) {
  const slug = `e6-cap-${W.run}-${i}`;
  const r = await R.companyCreate(OP.aal2, {
    slug,
    name: `SYNTHETIC Capacity ${i}`,
    firstAdminEmail: freshEmail(`cap-${i}`),
    ...periodBody(),
  });
  assert.equal(r.status, 201, r.raw);
  created.push({ slug, companyId: r.body.companyId, link: linkParts(r.body.acceptUrl) });
}
/* One company at the plan's own shape: 25 active memberships, 25 removed ones (so the register's lifetime figure
   is exercised) and its pending-invitation quota filled. */
const FILLED = created[0].companyId;
e6lib('fill_members "$1" "$2" "$3"', FILLED, '25', `cap-${W.run}-f`);
e6lib('fill_members "$1" "$2" "$3"', FILLED, '25', `cap-${W.run}-r`);
sql(`update app.memberships set status='removed', removed_at=now() where company_id='${FILLED}'
       and user_id in (select user_id from app.memberships where company_id='${FILLED}' order by created_at desc limit 25)`);
e6lib('fill_invitations "$1" "$2" "$3" "$4"', FILLED, A.ms.admin, '40', `cap-${W.run}`);
/* Three companies past their dates so the expiry run has work and the register has something to sort first. */
for (const c of created.slice(1, 4)) agePeriod(c.companyId, '30 days', '16 days', '-14 days');

/* A release and an agent to transfer, and the departure subject. */
const { agentId } = await published(R, A, 'claude-ai');

/* WARM EVERY SESSION FIRST. */
for (const u of [OP.aal2, OP.aal1, A.adminHi, A.admin, A.member, A.author, A.it, A.business]) u.token();

const companyCount = () => Number(sql('select count(*) from app.companies'));
const ok = (r, label) => {
  assert.ok(r.status >= 200 && r.status < 300, `${label}: ${r.status} ${r.raw}`);
  return r.body;
};

/** Run `call` n times, returning { p50, p95, p99, statements }: the wall time per call and the PostgREST
    requests one call made, counted by replacing fetch for exactly one of them. */
async function sample(n, call) {
  const ms = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const r = await call();
    ms.push(performance.now() - t0);
    assert.ok(r.status >= 200 && r.status < 300, `sample: ${r.status} ${r.raw}`);
  }
  let statements = 0;
  await withFetch(
    (url, init, original) => {
      if (String(url).includes('/rest/v1/')) statements += 1;
      return original(url, init);
    },
    () => call(),
  );
  ms.sort((a, b) => a - b);
  return { p50: percentile(ms, 50), p95: percentile(ms, 95), p99: percentile(ms, 99), statements, n };
}

const lines = [];
const record = (label, s, note = '') =>
  lines.push(
    `${label}: p50 ${s.p50.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms, p99 ${s.p99.toFixed(1)} ms over ${s.n} calls, ${s.statements} PostgREST request(s) per call${note ? `; ${note}` : ''}`,
  );

test('section 6: the register, the preview, the transfer, the expiry run and GET /api/me', async (t) => {
  const companies = companyCount();
  const register = await sample(10, () => R.register(OP.aal2, {}));
  record('GET /api/operator/companies', register, `${companies} companies in the table, one page of 50`);
  assert.equal(register.statements, 1, 'one RPC, whatever the company count: the counts are aggregates, not a loop');

  const preview = await sample(10, () => R.departure(A.adminHi, A.id, A.ms.author));
  record('GET departure', preview, 'a membership with one group, one owned agent and one published release');

  const me = await sample(10, () => R.me(A.member));
  record('GET /api/me', me, 'one api.my_standing read and one profile read, where E2 took three reads');
  assert.equal(me.statements, 2, 'the pair of reads E6 replaced with one is gone');

  const expiry = await sample(5, () => R.expiryRun(OP.aal2, { limit: 50 }));
  record('POST /api/operator/expiry-run', expiry, 'three companies past export_by on the first call, none after');

  const transfer = await sample(6, () =>
    R.transferAgent(A.adminHi, agentId, {
      toMembershipId: A.ms.member,
      expectedOwnerMembershipId: A.ms.author,
    }),
  );
  record('POST /api/agents/{id}/transfer', transfer, 'the first call moves it, the rest are changed: false');

  const quotas = await sample(6, () => R.quotas(A.adminHi, A.id));
  record('GET /api/companies/{id}/quotas', quotas, 'one override read and four paged counts');

  for (const line of lines) t.diagnostic(line);
});

test("section 6: the company's own copy, its two byte figures, and what the function holds at once", async (t) => {
  /* One of the two figures design section 6 says decide whether 4 MiB is the right number: what this function
     actually serialized for the wire. The routine's own octet_length is probe 30's; the note below says why. */
  const before = process.memoryUsage().heapUsed;
  const r = await R.takeout(A.adminHi, A.id);
  const afterParse = process.memoryUsage().heapUsed;
  const body = ok(r, 'takeout');
  const wire = Buffer.byteLength(r.raw, 'utf8');
  const afterSerialize = process.memoryUsage().heapUsed;
  const sections = Object.keys(body.sections).length;
  const rows = Object.values(body.counts).reduce((a, b) => a + b, 0);
  const takeout = await sample(5, () => R.takeout(A.adminHi, A.id));
  record('GET /api/companies/{id}/takeout', takeout, `${sections} sections, ${rows} rows emitted`);
  lines.push(
    `takeout bytes: ${wire} on the wire (this function's own JSON.stringify), ceiling 4194304, ` +
      `heap used before the call ${before}, after the parse ${afterParse}, after the re-serialization ${afterSerialize}`,
  );
  lines.push(
    'takeout limits: only ONE of design section 6 s two byte figures is here. The routine measures ' +
      'octet_length(doc::text) INSIDE its own transaction and refuses above the ceiling there, and this file ' +
      'cannot read that number: api.export_company runs under app.server_actor(), so an owner-side call of it ' +
      'raises E_NOT_SERVER, and a second call through the route would measure a second document rather than the ' +
      'same one. tests/db/30-deletion.sh records the routine s own measurement owner-side with the claims set, ' +
      'and the comparison of the two is that probe s. The heap figures are one process on one machine and hold ' +
      'everything else this file holds; they show the ORDER of the parsed graph against the text, not a bound.',
  );
  assert.ok(wire > 0);
  assert.ok(wire <= 4 * 1024 * 1024, 'the sample company is under the route ceiling');
  for (const line of lines.slice(-3)) t.diagnostic(line);
});

test('section 6: the deletion is the one operation whose cost grows with a company s whole history', async (t) => {
  const victim = created[created.length - 1];
  agePeriod(victim.companyId, '30 days', '16 days', '-14 days');
  ok(
    await R.companyStatus(OP.aal2, victim.companyId, { status: 'suspended', reasonCode: 'operator_decision' }),
    'suspend',
  );
  ok(await R.companyClose(OP.aal2, victim.companyId, { confirmSlug: victim.slug, reasonCode: 'retention_deadline' }), 'close');
  const t0 = performance.now();
  const deleted = ok(
    await R.companyDelete(OP.aal2, victim.companyId, {
      confirmSlug: victim.slug,
      reasonCode: 'retention_deadline',
    }),
    'delete',
  );
  const ms = performance.now() - t0;
  const rows = Object.values(deleted.deleted).reduce((a, b) => a + (Number.isInteger(b) ? b : 0), 0);
  lines.push(
    `POST /api/operator/companies/{id}/delete: ${ms.toFixed(1)} ms for ${rows} rows across eighteen sections, ` +
      'one transaction; the ceiling is app.limit_delete_rows() = 500,000 and this company is far under it, so ' +
      'this number says nothing about where the real edge is',
  );
  t.diagnostic(lines[lines.length - 1]);
});

/* The pages' reads, added by the E6 pages lane (design 4.1 and section 6). The services lane's sample above covers the
   register (/operator/), GET /api/me (the home page's one read, which is also every page's first), the departure
   preview, the transfer, the quota read and the takeout, each as one route. Three page reads it did not cover: the
   operator company page's one read, GET /api/operator/companies/{id}/takeout-manifest; and the members and groups
   pages' loads for an administrator at aal2, which since E6 send the quota read beside their E2 and E4 reads, measured
   the way the pages send them, together, so the number is the page's and not a route's. Written to their own record,
   .scratch/e6/pages-capacity.txt, and to evidence/e6-pages-repro/capacity.txt only under CAPACITY_EVIDENCE=1. Run
   alone with --test-name-pattern "pages" so the services lane's record above is not rewritten. */
const pageLines = [];
const recordPage = (label, s, note = '') =>
  pageLines.push(
    `${label}: p50 ${s.p50.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms, p99 ${s.p99.toFixed(1)} ms over ${s.n} loads, ${s.statements} PostgREST request(s) per load${note ? `; ${note}` : ''}`,
  );
/* Several route calls sent together, as a page sends them, answered as one: the first refusal, or 200. */
const together = (calls) =>
  Promise.all(calls.map((c) => c())).then((rs) => rs.find((r) => r.status < 200 || r.status >= 300) ?? { status: 200, raw: '' });

test('section 6, the pages: the operator company page, and the members and groups pages at aal2', async (t) => {
  const small = await sample(10, () => R.takeoutManifest(OP.aal2, A.id));
  recordPage('/operator/company/ (GET /api/operator/companies/{id}/takeout-manifest)', small, 'the E4-shaped company');
  const filled = await sample(10, () => R.takeoutManifest(OP.aal2, FILLED));
  recordPage('/operator/company/ (GET /api/operator/companies/{id}/takeout-manifest)', filled, 'the filled company: 25 active, 25 removed, 40 pending invitations');
  assert.equal(filled.statements, 1, 'one RPC: counts and the manifest are aggregates in the database');
  const membersLoad = await sample(10, () =>
    together([
      () => R.me(A.adminHi),
      () => R.call('membersList', { user: A.adminHi, params: { companyId: A.id } }),
      () => R.invitations(A.adminHi, A.id),
      () => R.quotas(A.adminHi, A.id),
    ]),
  );
  recordPage('/members/ at aal2 (me, members, invitations, quotas together)', membersLoad, 'the E4-shaped company');
  const groupsLoad = await sample(10, () =>
    together([
      () => R.me(A.adminHi),
      () => R.call('groupsList', { user: A.adminHi, params: { companyId: A.id } }),
      () => R.call('membersList', { user: A.adminHi, params: { companyId: A.id } }),
      () => R.quotas(A.adminHi, A.id),
    ]),
  );
  recordPage('/groups/ at aal2 (me, groups, members, quotas together)', groupsLoad, 'the E4-shaped company');
  for (const line of pageLines) t.diagnostic(line);
});

test('section 6, the pages: the record, written with the seed that produced it', () => {
  const text = `${[
    `E6 pages capacity sample, ${new Date().toISOString()}`,
    'One machine running the database, PostgREST, GoTrue and every request. Local numbers, recorded, not claimed.',
    'The seed is this file s (see the services lane s record for the same seed): the E4-shaped company and a company',
    'filled owner-side to 25 active and 25 removed memberships and 40 pending invitations.',
    'Covered by the services lane s sample and not repeated: /operator/ (the register), GET /api/me (the home page),',
    'the departure preview, the transfer, the quota read and the takeout as single routes.',
    'Not measured: the browser s own time (rendering, the phone), hosted latency, cold starts.',
    '',
    'Measurements:',
    ...pageLines.map((l) => `  ${l}`),
    '',
    "Against the plan's p95 of two seconds for the catalog and review APIs: none of these is one of those, and every",
    'line is recorded beside it.',
  ].join('\n')}\n`;
  mkdirSync(join(ROOT, '.scratch', 'e6'), { recursive: true });
  writeFileSync(join(ROOT, '.scratch', 'e6', 'pages-capacity.txt'), text);
  if (process.env.CAPACITY_EVIDENCE === '1') {
    mkdirSync(join(ROOT, 'evidence', 'e6-pages-repro'), { recursive: true });
    writeFileSync(join(ROOT, 'evidence', 'e6-pages-repro', 'capacity.txt'), text);
  }
  assert.equal(pageLines.length, 4, `${pageLines.length} page measurements recorded`);
});

test('section 6: the record, written with the seed that produced it', () => {
  const header = [
    `E6 section 6 capacity sample, ${new Date().toISOString()}`,
    'One machine running the database, PostgREST, GoTrue and every request. Local numbers, recorded, not claimed.',
    '',
    'Seed:',
    `  companies in the table at the register measurement: ${companyCount()}`,
    `  one E4-shaped company: five members, an audience group, one published release and its ledger`,
    `  one filled company: 25 active and 25 removed memberships, 40 pending invitations`,
    '  three companies aged past export_by with the sweep not yet run',
    '',
    'Not measured here, and each is a real limit:',
    "  the design's full envelope (ten companies at 50 agents and 300 release rows each, and the three ceiling",
    '  companies) is not built: these numbers are a sample at a smaller seed and say so per line',
    '  hosted latency, cold starts, Netlify behaviour at its documented 6 MB buffered limit',
    "  the browser's handling of a 4 MiB download on a phone",
    '  query plans: design case 34 is the database lane and the integrator s, not this file s',
    '',
    'Measurements:',
  ];
  const limits = [
    '',
    "Against the plan's target of p95 under two seconds for the catalog and review APIs, every line above is",
    'recorded beside it; none of these routes is one of those two, and E6 claims no target of its own.',
  ];
  const text = `${[...header, ...lines.map((l) => `  ${l}`), ...limits].join('\n')}\n`;
  mkdirSync(join(ROOT, '.scratch', 'e6'), { recursive: true });
  writeFileSync(join(ROOT, '.scratch', 'e6', 'capacity.txt'), text);
  /* The evidence copy is replaced only by a run that says so (Q5R-F1-R-F1): this file runs inside
     bash scripts/check.sh, and a check that rewrites an accepted record on every run leaves the checkout dirty
     and the record describing whichever run came last. */
  if (process.env.CAPACITY_EVIDENCE === '1') {
    mkdirSync(join(ROOT, 'evidence', 'e6-services-repro'), { recursive: true });
    writeFileSync(join(ROOT, 'evidence', 'e6-services-repro', 'capacity.txt'), text);
  }
  assert.ok(lines.length >= 8, `${lines.length} measurements recorded`);
});
