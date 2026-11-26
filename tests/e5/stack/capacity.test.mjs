/* Section 6 of the E5 design: the capacity sample for the catalog read, the download and the installations read, and
   case 30's query plans. Local numbers from one machine running the database, PostgREST, GoTrue and every request,
   written with the seed that produced them to .scratch/e5/capacity.txt, and to evidence/e5-pages-repro/capacity.txt only when CAPACITY_EVIDENCE=1. They
   are recorded, never claimed: this file asserts that every measured request succeeded and that the plans were read,
   and the record compares each p95 with the plan's two seconds. The method is E4's (tests/e4/stack/capacity.test.mjs):
   the seed is owner-side SQL with every trigger in force, and every measured request goes through the routes with a
   real session. Reseeds once, and runs alone as every stack file does.

   The seed is design section 6's, stated here so the numbers are readable without it: per company, ten groups holding
   all 25 members; 50 agents of three candidates each, every candidate bound to a claude-ai and a chatgpt envelope, and
   three releases per agent and target, the older two superseded (300 release rows per company, 3,000 over ten); 25
   ledger rows per current release; five installation reports per current release, one of them witnessed. Even agents
   address all ten groups and odd agents the first alone, so a member of all ten groups reads the company's 300 release
   rows, of which 100 are current and appear in their catalog, and a member of one of the other nine reads 150 rows of
   which 50 are current. Beside them one worst release with 25 recipients, 500 reports and 250 witnesses, which is
   design 6's bound for the installations read.

   What this does not measure, and why. The withdrawal re-measured over a 5,000-row ledger written by the real routine
   (design 6's sixth row) needs E4's 500-member company and is E4's figure; the two bound writes at both text bounds
   are measured here, the concurrent-download row is measured here, and nothing else in design 6's table is claimed. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { stackEnv } from '../../e2/helpers/stack.mjs';
import { attribution, passportText, percentile } from '../../e3/stack/helpers.mjs';
import { e4world, e5routes, enableTargets, key, reseed, ROOT, sql, withFetch } from './helpers.mjs';

const ids = reseed();
enableTargets();
const R = await e5routes();
const W = e4world('e5-capacity', ids);
const { gate } = await import('../../../lib/passport/gate.mjs');

const COMPANIES = 10;
const AGENTS = 50;
const PLAN_MS = 2000;
const SEED_LINE = [];

/* The owner-side SQL script runner: statements on standard input, so a large literal never meets an argument limit. */
function sqlScript(text) {
  const { dbContainer } = stackEnv();
  const r = spawnSync('docker', ['exec', '-i', dbContainer, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'], {
    input: text,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`sqlScript failed (exit ${r.status}): ${`${r.stderr}${r.stdout}`.slice(0, 800)}`);
  return r.stdout.trim();
}
const dollar = (tag, s) => {
  const t = `$${tag}$`;
  if (s.includes(t)) throw new Error(`dollar tag ${tag} occurs in the text`);
  return `${t}${s}${t}`;
};
const literal = (s) => `'${s.replaceAll("'", "''")}'`;
/* A derived record as the gate stamps it, restamped in SQL at insert: the candidate trigger accepts an attestation
   made within five minutes. E4's capacity file does the same, for the same reason. */
function derivedOf(text) {
  const verdict = gate(Buffer.from(text, 'utf8'), 'text/markdown', { validatedAt: new Date().toISOString() });
  if (!verdict.ok || verdict.text !== text) throw new Error('the seed text does not pass the gate unchanged');
  const stamp = /"validated_at":"[^"]+"/.exec(verdict.derivedCanonical)[0];
  return `replace(${dollar('d', verdict.derivedCanonical)}, ${literal(stamp)}, '"validated_at":"' || to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '"')`;
}

const summary = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const f = (x) => x.toFixed(1);
  return `n=${s.length} p50=${f(percentile(s, 50))} p95=${f(percentile(s, 95))} p99=${f(percentile(s, 99))} max=${f(s.at(-1))} ms`;
};
const verdictOf = (values) =>
  percentile([...values].sort((a, b) => a - b), 95) < PLAN_MS ? 'p95 under the plan two seconds' : 'p95 NOT under the plan two seconds';

function countingFetch(url, init, original) {
  const store = attribution.getStore();
  if (store) store.calls += 1;
  const t0 = performance.now();
  return original(url, init).then((res) => {
    if (store) store.db += performance.now() - t0;
    return res;
  });
}
async function batch(label, calls, expected) {
  const results = await withFetch(countingFetch, () =>
    Promise.all(
      calls.map(async (call) => {
        const store = { db: 0, calls: 0 };
        const t0 = performance.now();
        const r = await attribution.run(store, call);
        return { r, total: performance.now() - t0, db: store.db, calls: store.calls };
      }),
    ),
  );
  for (const x of results) assert.equal(x.r.status, expected, `${label}: ${x.r.raw?.slice(0, 300)}`);
  return results;
}
async function rounds(label, { warmup, count }, makeCalls, expected = 200) {
  const out = { totals: [], db: [], calls: [] };
  for (let round = 0; round < warmup + count; round++) {
    const results = await batch(label, makeCalls(round), expected);
    if (round < warmup) continue;
    for (const x of results) {
      out.totals.push(x.total);
      out.db.push(x.db);
      out.calls.push(x.calls);
    }
  }
  return out;
}

/* ---------- the companies and their people ---------- */

function company(slug, { extraMembers = 20, readers = 2 } = {}) {
  const admin = W.user(`${slug}-admin`);
  const author = W.user(`${slug}-author`);
  const it = W.user(`${slug}-it`);
  const c = W.company(slug, admin);
  const ms = {
    admin: c.adminMembership,
    author: W.member(c.id, author),
    it: W.member(c.id, it, '{it_reviewer,member}'),
  };
  /* The people whose requests are measured hold real sessions, so each is a GoTrue account with a password; the rest
     of the 25 are membership rows alone, because nothing signs in as them. */
  const people = [];
  for (let i = 0; i < readers; i++) {
    const u = W.user(`${slug}-reader${i}`);
    people.push({ user: u, membershipId: W.member(c.id, u) });
  }
  sqlScript(`insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'e5-capacity-${W.run}-${slug}-' || g || '@example.invalid', now(), now() from generate_series(1, ${extraMembers}) g;
insert into app.memberships (company_id, user_id, roles) select '${c.id}', u.id, '{member}' from auth.users u where u.email like 'e5-capacity-${W.run}-${slug}-%';`);
  return { id: c.id, slug, admin, adminHi: W.aal2(admin), author, it, ms, people };
}

const seedText = passportText('capacity');
const PROSE_MARK = `Revision capacity.`;
const contentExpr = (expr) => `replace(${dollar('c', seedText)}, ${literal(PROSE_MARK)}, 'Revision ' || ${expr} || '.')`;
const activeGate = '(select id from app.gate_identities where active)';

/* Design section 6's ordinary seed for one company, as owner-side SQL with every trigger in force. Labelled as setup:
   no route creates a release without its review, and none of these rows is evidence of anything but paging and size.
   Each release is inserted published and current, as app.release_identity requires, and the one before it in its chain
   is superseded in the statement before, which is the transition app.release_immutable admits. */
function ordinarySeed(c) {
  return `
insert into app.groups (company_id, name, created_by_membership_id) select '${c.id}', 'Capacity group ' || g, '${c.ms.admin}' from generate_series(0, 9) g;
insert into app.group_members (group_id, company_id, membership_id, added_by_membership_id) select gr.id, gr.company_id, m.id, '${c.ms.admin}' from app.groups gr join app.memberships m on m.company_id = gr.company_id and m.status = 'active' where gr.company_id = '${c.id}';
insert into app.agents (company_id, name, creator_membership_id, owner_membership_id) select '${c.id}', 'capacity-' || g, '${c.ms.author}', '${c.ms.author}' from generate_series(1, ${AGENTS}) g;
create temp table seed_agents as select id as agent_id, company_id, substring(name from 10)::int as agent_no from app.agents where company_id = '${c.id}' and name like 'capacity-%';
insert into app.candidate_versions (company_id, agent_id, sequence, author_membership_id, content, derived_canonical, gate_id, attested_by)
select a.company_id, a.agent_id, s, '${c.ms.author}', ${contentExpr("a.agent_no || '-' || s")}, ${derivedOf(seedText)}, ${activeGate}, '${c.ms.author}'
from seed_agents a, generate_series(1, 3) s;
update app.candidate_versions v set state = 'submitted', submitted_at = clock_timestamp(), submitted_by_membership_id = v.author_membership_id from seed_agents a where v.agent_id = a.agent_id;
update app.candidate_versions v set state = 'approved' from seed_agents a where v.agent_id = a.agent_id;
insert into app.review_envelopes (company_id, agent_id, candidate_id, revision, content_sha256, derived_sha256, gate_id, gate_identity_sha256, target, installer_text_sha256, core_sha256, branch_sha256, judge_sha256, policy_id, policy_sha256, assembled_bytes, audience_group_ids, envelope_canonical, envelope_sha256, created_by_membership_id)
select v.company_id, v.agent_id, v.id, case i.target when 'claude-ai' then 1 else 2 end, v.content_sha256, v.derived_sha256, i.gate_id, g.identity_sha256, i.target, i.text_sha256, i.core_sha256, i.branch_sha256, i.judge_sha256, p.id, p.sha256, 1,
       case when a.agent_no % 2 = 0 then (select array_agg(gr.id order by gr.id) from app.groups gr where gr.company_id = v.company_id)
            else array[(select gr.id from app.groups gr where gr.company_id = v.company_id and gr.name = 'Capacity group 0')] end,
       'seed', sha256('seed'), v.author_membership_id
from app.candidate_versions v join seed_agents a using (agent_id)
join app.gate_identities g on g.active join app.installer_texts i on i.gate_id = g.id and i.target in ('claude-ai', 'chatgpt')
cross join app.release_policies p where p.active;
do $seed$
declare k int;
begin
  set constraints all deferred;
  for k in 1..3 loop
    drop table if exists seed_level;
    create temp table seed_level as
      select e.id as envelope_id, e.agent_id, e.target, gen_random_uuid() as release_id
        from app.review_envelopes e join seed_agents a using (agent_id) join app.candidate_versions v on v.id = e.candidate_id
       where v.sequence = k;
    update app.releases r set superseded_by_release_id = l.release_id, superseded_at = clock_timestamp()
      from seed_level l where r.agent_id = l.agent_id and r.target = l.target and r.state = 'published' and r.superseded_by_release_id is null;
    insert into app.releases (id, company_id, agent_id, candidate_id, envelope_id, target, gate_id, content_sha256, derived_sha256, installer_text_sha256, core_sha256, branch_sha256, judge_sha256, policy_id, policy_sha256, audience_group_ids, envelope_sha256, assembled_content, published_by_membership_id)
    select l.release_id, e.company_id, e.agent_id, e.candidate_id, e.id, e.target, e.gate_id, e.content_sha256, e.derived_sha256, e.installer_text_sha256, e.core_sha256, e.branch_sha256, e.judge_sha256, e.policy_id, e.policy_sha256, e.audience_group_ids, e.envelope_sha256, replace(v.content, app.installer_placeholder(), i.text), '${c.ms.admin}'
      from seed_level l join app.review_envelopes e on e.id = l.envelope_id join app.candidate_versions v on v.id = e.candidate_id
      join app.installer_texts i on i.gate_id = e.gate_id and i.target = e.target;
  end loop;
end $seed$;
update app.candidate_versions v set state = 'superseded' from seed_agents a where v.agent_id = a.agent_id and v.sequence <= 2;
insert into app.release_downloads (company_id, release_id, membership_id)
select r.company_id, r.id, m.id from app.releases r join seed_agents a using (agent_id)
 join lateral (select id from app.memberships where company_id = r.company_id and status = 'active' order by id limit 25) m on true
 where r.state = 'published' and r.superseded_by_release_id is null;
insert into app.installation_reports (company_id, release_id, membership_id, status, losses, assistance, source)
select d.company_id, d.release_id, d.membership_id, 'pass', null, null, 'recipient_app'
  from (select company_id, release_id, membership_id, row_number() over (partition by release_id order by membership_id) as n
          from (select distinct company_id, release_id, membership_id from app.release_downloads
                 where release_id in (select id from app.releases where company_id = '${c.id}')
                   and membership_id <> '${c.ms.it}') x) d
 where d.n <= 5;
insert into app.installation_witnesses (company_id, report_id, release_id, witness_membership_id, witness_role, status, note)
select p.company_id, p.id, p.release_id, '${c.ms.it}', 'it_reviewer', 'pass', 'Seeded witness.'
  from (select r.*, row_number() over (partition by r.release_id order by r.id) as n from app.installation_reports r where r.company_id = '${c.id}') p
 where p.n = 1;
drop table seed_agents; drop table if exists seed_level;
select 'SEEDED|' || (select count(*) from app.releases where company_id = '${c.id}') || '|' || (select count(*) from app.release_downloads where company_id = '${c.id}') || '|' || (select count(*) from app.installation_reports where company_id = '${c.id}') || '|' || (select count(*) from app.installation_witnesses where company_id = '${c.id}');`;
}

test('E5 section 6: the capacity sample for the catalog, the download and the installations read; case 30 query plans', async (t) => {
  const t0 = performance.now();
  const companies = [];
  for (let i = 0; i < COMPANIES; i++) {
    const c = company(`c${i}`, i === 1 ? { extraMembers: 2, readers: 20 } : {});
    const seeded = sqlScript(ordinarySeed(c)).split('\n').find((l) => l.startsWith('SEEDED|'));
    const [, releases, ledger, reports, witnesses] = seeded.split('|');
    assert.equal(releases, String(AGENTS * 6), `company ${i}: ${AGENTS * 6} release rows`);
    assert.equal(ledger, String(AGENTS * 2 * 25), `company ${i}: 25 ledger rows per current release`);
    assert.equal(reports, String(AGENTS * 2 * 5), `company ${i}: five reports per current release`);
    assert.equal(witnesses, String(AGENTS * 2), `company ${i}: one witnessed report per current release`);
    assert.equal(Number(sql(`select count(*) from app.memberships where company_id = '${c.id}' and status = 'active'`)), 25, `company ${i}: 25 members`);
    companies.push(c);
  }

  /* Two of each company's members are measured: the first stays in all ten groups the seed put every membership in,
     and the second is left in Capacity group 5 alone, so one reads every current release and the other only what the
     even agents address to every group. Removing a group row is owner-side setup, not a route. */
  const readers = companies.map((c) => {
    const one = c.people[1];
    sql(`delete from app.group_members where membership_id = '${one.membershipId}' and group_id <> (select id from app.groups where company_id = '${c.id}' and name = 'Capacity group 5')`);
    return { ten: c.people[0].user, oneGroup: one.user, oneMs: one.membershipId };
  });
  const visible = async (c, u) => {
    const seen = { available: 0, earlier: 0, pages: 0 };
    let cursor = null;
    do {
      const r = await R.catalog(u, c.id, cursor === null ? {} : { cursor });
      assert.equal(r.status, 200, r.raw);
      seen.available += r.body.available.length;
      seen.earlier += r.body.earlier.length;
      seen.pages += 1;
      cursor = r.body.nextCursor;
    } while (cursor !== null);
    return seen;
  };
  const tenSees = await visible(companies[0], readers[0].ten);
  const oneSees = await visible(companies[0], readers[0].oneGroup);
  assert.equal(tenSees.available, AGENTS * 2, 'a member of all ten groups reads every current release of the company');
  assert.equal(oneSees.available, AGENTS, 'a member of one of the other nine reads only what the even agents address to it');
  assert.equal(tenSees.pages, 6, 'and pages through the 300 rows of the company in six pages of 50');

  const seedSeconds = ((performance.now() - t0) / 1000).toFixed(0);
  SEED_LINE.push(
    `seed (${seedSeconds} s, owner-side SQL with every trigger in force): ${COMPANIES} companies of 25 members (an admin, an author, an IT reviewer and the measured readers with real sessions, the rest membership rows alone), each with ten groups of all 25 members and ${AGENTS} agents of three candidates, every candidate bound to a claude-ai and a chatgpt envelope and every chain published three deep, so ${AGENTS * 6} release rows of which ${AGENTS * 2} current; 25 ledger rows per current release (${AGENTS * 2 * 25}); five installation reports per current release (${AGENTS * 2 * 5}), one of them witnessed (${AGENTS * 2}). Even agents address all ten groups and odd agents the first alone.`,
    `reading of the seed: the catalog partition is "current and not refused" against "an authorization of mine", so a member of all ten groups reads the ${AGENTS * 2} current releases and not the ${AGENTS * 4} superseded ones they never downloaded; the superseded rows are in the table the page pages over and in every plan below.`,
  );

  /* Every session used below is minted before anything is timed. A first use of an account in this process is a real
     GoTrue password sign-in, and the first run of this file measured 3.2 s at p50 for a write whose database time was
     21 ms, which was ten concurrent first sign-ins inside the timed call and not the route (E5P-F6). */
  for (const c of companies) {
    c.admin.token();
    c.adminHi.token();
    c.it.token();
    for (const p of c.people) p.user.token();
  }

  /* ---------- the reads ---------- */
  const lines = [];
  const catalogTen = await rounds('catalog, a member of ten groups', { warmup: 1, count: 10 }, () =>
    companies.flatMap((c, i) => [() => R.catalog(readers[i].ten, c.id), () => R.catalog(readers[i].oneGroup, c.id)]),
  );
  lines.push(
    `GET /api/companies/{id}/catalog, first page of 50, 20 concurrent sessions over ten companies (ten members of all ten groups and ten members of one), 10 rounds: whole request ${summary(catalogTen.totals)} (${verdictOf(catalogTen.totals)}); Data API time ${summary(catalogTen.db)}; Data API requests per call ${Math.min(...catalogTen.calls)} to ${Math.max(...catalogTen.calls)}`,
  );

  /* The worst release for the installations read, design 6's bound: 25 recipients, 500 reports, 250 witnesses. */
  const worstRelease = sql(`select id from app.releases where company_id = '${companies[0].id}' and state = 'published' and superseded_by_release_id is null order by id limit 1`);
  sqlScript(`
insert into app.release_downloads (company_id, release_id, membership_id)
select r.company_id, r.id, m.id from app.releases r
 join lateral (select id from app.memberships where company_id = r.company_id and status = 'active' order by id limit 25) m on true
 cross join generate_series(1, 7) where r.id = '${worstRelease}';
insert into app.installation_reports (company_id, release_id, membership_id, status, losses, assistance, source)
select r.company_id, r.id, m.id, 'partial', repeat('x', 200), repeat('y', 200), 'recipient_app' from app.releases r
 join lateral (select id from app.memberships where company_id = r.company_id and status = 'active' order by id limit 25) m on true
 cross join generate_series(1, 19) where r.id = '${worstRelease}' and m.id <> '${companies[0].ms.it}';
insert into app.installation_witnesses (company_id, report_id, release_id, witness_membership_id, witness_role, status, note)
select p.company_id, p.id, p.release_id, '${companies[0].ms.it}', 'it_reviewer', 'partial', 'Seeded witness.'
  from (select r.*, row_number() over (order by r.id) as n from app.installation_reports r where r.release_id = '${worstRelease}') p
 where p.n <= 250 and not exists (select 1 from app.installation_witnesses w where w.report_id = p.id);
select 'WORST|' || (select count(*) from app.release_downloads where release_id = '${worstRelease}') || '|' || (select count(distinct membership_id) from app.release_downloads where release_id = '${worstRelease}') || '|' || (select count(*) from app.installation_reports where release_id = '${worstRelease}') || '|' || (select count(*) from app.installation_witnesses where release_id = '${worstRelease}');`);
  const worst = sql(
    `select (select count(distinct membership_id) from app.release_downloads where release_id = '${worstRelease}') || '|' || (select count(*) from app.installation_reports where release_id = '${worstRelease}') || '|' || (select count(*) from app.installation_witnesses where release_id = '${worstRelease}')`,
  ).split('|');
  assert.equal(worst[0], '25', 'the worst release has 25 recipients');
  assert.ok(Number(worst[1]) >= 456, `the worst release carries ${worst[1]} reports, against design 6's bound of 500`);
  assert.ok(Number(worst[2]) >= 250, `and ${worst[2]} witnesses, against design 6's bound of 250`);
  SEED_LINE.push(`the worst release for the installations read: ${worst[0]} recipients, ${worst[1]} reports at 400 text bytes each, ${worst[2]} witnesses (design 6's bound is 25, 500 and 250).`);

  const installAdmin = await rounds('installations, the admin scope', { warmup: 1, count: 5 }, () =>
    Array.from({ length: 20 }, () => () => R.installations(companies[0].adminHi, worstRelease)),
  );
  lines.push(
    `GET /api/releases/{id}/installations, scope "company" (an administrator; 25 recipients, a 350-row ledger, 500 reports at 400 text bytes each and 250 witnesses), 20 concurrent, 5 rounds: whole request ${summary(installAdmin.totals)} (${verdictOf(installAdmin.totals)}); Data API time ${summary(installAdmin.db)}; Data API requests per call ${Math.min(...installAdmin.calls)} to ${Math.max(...installAdmin.calls)}`,
  );
  const installReviewer = await rounds('installations, the reviewer scope', { warmup: 1, count: 5 }, () =>
    Array.from({ length: 20 }, () => () => R.installations(companies[0].it, worstRelease)),
  );
  lines.push(
    `GET /api/releases/{id}/installations, scope "company-reports" (an IT reviewer, the same release, no ledger read): whole request ${summary(installReviewer.totals)} (${verdictOf(installReviewer.totals)}); Data API time ${summary(installReviewer.db)}; Data API requests per call ${Math.min(...installReviewer.calls)} to ${Math.max(...installReviewer.calls)}`,
  );
  /* A recipient reading their own summary of the same release: the reader of company 0 who is in all ten groups, who
     downloads it here so the own scope has something to answer about. */
  await R.download(readers[0].ten, worstRelease);
  const installOwn = await rounds('installations, the own scope', { warmup: 1, count: 5 }, () =>
    Array.from({ length: 20 }, () => () => R.installations(readers[0].ten, worstRelease)),
  );
  lines.push(
    `GET /api/releases/{id}/installations, scope "own" (a recipient reading their own summary and their own reports of the same release): whole request ${summary(installOwn.totals)} (${verdictOf(installOwn.totals)}); Data API time ${summary(installOwn.db)}; Data API requests per call ${Math.min(...installOwn.calls)} to ${Math.max(...installOwn.calls)}`,
  );

  /* ---------- the writes ---------- */
  /* Company 0's first current release is the worst release above, seeded to the 500-report bound, which is 25 recipients
     at the 20-per-recipient ceiling: a timed report on it answers E_REPORT_LIMIT by the product's own rule (the full run
     on a75503b). The writers report on a release the seed left room on. */
  const downloaders = companies.map((c, i) => ({ user: readers[i].ten, release: sql(`select id from app.releases where company_id = '${c.id}' and state = 'published' and superseded_by_release_id is null and id <> '${worstRelease}' order by id limit 1`) }));
  const downloads = await rounds('download', { warmup: 1, count: 3 }, () => downloaders.flatMap((d) => [() => R.download(d.user, d.release), () => R.download(d.user, d.release)]));
  const bytes = Number(sql(`select assembled_bytes from app.releases where id = '${downloaders[0].release}'`));
  lines.push(
    `POST /api/releases/{id}/download, ${bytes} assembled bytes, a member of ten groups over a ledger that grows with the sample, 20 concurrent across ten companies, 3 rounds: whole request ${summary(downloads.totals)} (${verdictOf(downloads.totals)}); Data API time ${summary(downloads.db)}; Data API requests per call ${Math.min(...downloads.calls)} to ${Math.max(...downloads.calls)}`,
  );

  const text = 'x'.repeat(2000);
  const reportCalls = downloaders.map((d) => () => R.report(d.user, d.release, { status: 'partial', losses: text, assistance: text }, key()));
  const reports = await batch('report', reportCalls, 201);
  lines.push(`POST /api/releases/{id}/installations, both text fields at 2,000 code points, ten concurrent across ten companies: whole request ${summary(reports.map((x) => x.total))} (${verdictOf(reports.map((x) => x.total))}); Data API time ${summary(reports.map((x) => x.db))}`);
  const witnessCalls = reports.map((x, i) => () => R.witness(companies[i].it, x.r.body.report.reportId, { status: 'partial', note: text }, key()));
  const witnesses = await batch('witness', witnessCalls, 201);
  lines.push(`POST /api/installations/{id}/witness, the note at 2,000 code points, ten concurrent across ten companies: whole request ${summary(witnesses.map((x) => x.total))} (${verdictOf(witnesses.map((x) => x.total))}); Data API time ${summary(witnesses.map((x) => x.db))}`);

  /* Design 6's concurrent row: 20 sessions downloading the same release; the row count and the deadlock counter. */
  /* A release of an even agent, which is addressed to all ten groups, so every one of the twenty sessions is in its
     audience; the odd agents address the first group alone and one of the twenty is in the fifth alone. */
  const concurrentRelease = sql(
    `select id from app.releases where company_id = '${companies[1].id}' and state = 'published' and superseded_by_release_id is null and array_length(audience_group_ids, 1) = 10 order by id limit 1`,
  );
  const deadlocksBefore = Number(sql(`select deadlocks from pg_stat_database where datname = current_database()`));
  const rowsBefore = Number(sql(`select count(*) from app.release_downloads where release_id = '${concurrentRelease}'`));
  const concurrentIds = companies[1].people.map((p) => p.user);
  await batch('concurrent downloads', concurrentIds.map((u) => () => R.download(u, concurrentRelease)), 200);
  const rowsAfter = Number(sql(`select count(*) from app.release_downloads where release_id = '${concurrentRelease}'`));
  const deadlocksAfter = Number(sql(`select deadlocks from pg_stat_database where datname = current_database()`));
  assert.equal(rowsAfter - rowsBefore, concurrentIds.length, 'exactly one ledger row per concurrent download');
  assert.equal(deadlocksAfter, deadlocksBefore, 'no deadlock');
  lines.push(
    `Concurrent downloads of one release, ${concurrentIds.length} sessions at once: ${rowsAfter - rowsBefore} ledger rows written, pg_stat_database.deadlocks unchanged at ${deadlocksAfter}`,
  );

  /* ---------- case 30: the plans, as PostgREST's reader sees them ---------- */
  const reader = (userId, query) =>
    sqlScript(
      `begin;\nselect set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated"}', true);\nset local role authenticated;\nexplain (analyze, costs off, timing off, summary off) ${query};\nrollback;\n`,
    )
      .split('\n')
      .filter((l) => l !== 'BEGIN' && l !== 'SET' && l !== 'ROLLBACK' && !l.startsWith('{'))
      .join('\n');
  const c0 = companies[0];
  const tenId = readers[0].ten.id;
  const tenMs = sql(`select id from app.memberships where company_id = '${c0.id}' and user_id = '${tenId}'`);
  /* The plans over api. views are read as the authenticated reader with its claims, which is how PostgREST reads them;
     the two over app. tables are read in an owner session, because no request role holds USAGE on that schema and the
     definer doors are the only things that run them (E4S-F1's shape). Each is labelled with which it is. */
  const ownerPlan = (query) =>
    sqlScript(`explain (analyze, costs off, timing off, summary off) ${query};`)
      .split('\n')
      .filter((l) => !l.startsWith('{'))
      .join('\n');
  const plans = [
    ['catalog page: the first 51 rows of a company (authenticated reader)', tenId, `select id, company_id, agent_id, target, state, blocked_reason, my_authorizations from api.release_catalog where company_id = '${c0.id}' order by id asc limit 51`],
    ["the caller's own summary of one release (authenticated reader)", tenId, `select my_authorizations from api.release_catalog where id = '${worstRelease}'`],
    ["a release's ledger page (authenticated reader, an administrator)", c0.admin.id, `select id, membership_id, authorized_at from api.release_downloads where release_id = '${worstRelease}' order by id limit 200`],
    ["a release's reports page (authenticated reader, an administrator)", c0.admin.id, `select id, membership_id, status, reported_at from api.installation_reports where release_id = '${worstRelease}' order by id limit 200`],
    ["a release's witnesses page (authenticated reader, an administrator)", c0.admin.id, `select id, report_id, witness_role from api.installation_witnesses where release_id = '${worstRelease}' order by id limit 200`],
    ['the audience overlap for this membership (owner session, as the definer door runs it)', null, `select 1 from app.group_members gm where gm.membership_id = '${tenMs}'`],
    ["the installed-earlier list: this membership's authorizations (owner session, as the definer door runs it)", null, `select release_id, authorized_at from app.release_downloads where membership_id = '${tenMs}' order by release_id`],
  ];
  const planLines = [];
  const sequential = [];
  for (const [label, userId, query] of plans) {
    const plan = userId === null ? ownerPlan(query) : reader(userId, query);
    assert.match(plan, /Scan|Sort|Limit/, label);
    for (const m of plan.matchAll(/Seq Scan on (\w+)/g)) sequential.push(`${label}: ${m[1]}`);
    planLines.push(`-- ${label}\n${plan}`);
  }
  lines.push(
    `case 30, sequential scans of releases, release_downloads, installation_reports or installation_witnesses in the seven plans: ${sequential.filter((s) => /: (releases|release_downloads|installation_reports|installation_witnesses)$/.test(s)).join('; ') || 'none'}; every sequential scan in them: ${sequential.join('; ') || 'none'}`,
  );

  const storage = sql(
    `select pg_size_pretty(pg_total_relation_size('app.installation_reports')) || '|' || pg_size_pretty(pg_total_relation_size('app.release_downloads')) || '|' || (select count(*) from app.installation_reports) || '|' || (select count(*) from app.release_downloads)`,
  ).split('|');
  lines.push(`storage at this sample: ${storage[2]} installation report rows in ${storage[0]} and ${storage[3]} ledger rows in ${storage[1]} (pg_total_relation_size, after TOAST compression)`);

  const header = [
    `E5 section 6 capacity sample, measured ${new Date().toISOString()}`,
    ...SEED_LINE,
    `machine: ${cpus()[0]?.model ?? 'unknown'}, ${availableParallelism()} logical CPUs; Node ${process.version}; PostgreSQL ${sql('show server_version')}`,
  ];
  const limits = [
    'reading: the Data API time of a call is the sum of its requests, several of which run at once, so it can exceed the whole request; and all requests share one Node process, so an answer that arrives while another request computes waits for the event loop inside that sum. The whole request is the figure this sample can state without ambiguity.',
    'limits: one machine runs the database, PostgREST, GoTrue and every request; separate function instances would run in parallel; loopback, no TLS; the local stack is not the hosted plan; the rows are synthetic; no cold start; the browser is not in any figure here, so no page-render time is claimed; a local sample is not production readiness and none of these figures is a claim.',
    "not measured here: E4's withdrawal re-measured over a 5,000-row ledger written by the real routine (design 6's sixth row), which needs E4's 500-member company and is E4's figure; and everything hosted.",
  ];
  const record = `${[...header, ...lines, ...limits].join('\n')}\n\ncase 30 plans (explain analyze, costs, timing and summary off, as the authenticated reader with its claims):\n${planLines.join('\n\n')}\n`;
  mkdirSync(join(ROOT, '.scratch', 'e5'), { recursive: true });
  writeFileSync(join(ROOT, '.scratch', 'e5', 'capacity.txt'), record);
  /* The evidence copy is replaced only by a run that says so (Q5R-F1-R-F1, evidence/e5-pages-review.md): this file runs
     inside bash scripts/check.sh, and a check that rewrites an accepted record on every run leaves the checkout dirty
     and the record describing whichever run came last. */
  if (process.env.CAPACITY_EVIDENCE === '1') {
    mkdirSync(join(ROOT, 'evidence', 'e5-pages-repro'), { recursive: true });
    writeFileSync(join(ROOT, 'evidence', 'e5-pages-repro', 'capacity.txt'), record);
  }
  for (const line of [...header, ...lines]) t.diagnostic(line);
});
