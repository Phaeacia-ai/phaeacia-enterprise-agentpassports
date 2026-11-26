/* Section 6 of the E4 design: the capacity sample, and case 52's query plans. Local numbers from one machine running the
   database, PostgREST, GoTrue and every request, written with the seed that produced them to .scratch/e4/capacity.txt,
   and to evidence/e4-server-repro/capacity.txt only when CAPACITY_EVIDENCE=1. They are recorded, never claimed: the test asserts that every measured
   request succeeded and that the plans and sizes were read, and the record compares each p95 with the plan's two
   seconds. The ordinary seed is owner-side SQL with every trigger in force (identity, canonical, splice and immutability
   triggers compute and check what they always do); the requests that are measured go through the routes with real
   sessions, and every write measured is replayed by the service against content the routes stored. Reseeds once. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { stackEnv } from '../../e2/helpers/stack.mjs';
import {
  activePolicyId,
  attribution,
  e4routes,
  e4world,
  enableTargets,
  largePassport,
  MAX_BYTES,
  PROSE,
  passportText,
  percentile,
  ROOT,
  reseed,
  sql,
  withFetch,
} from './helpers.mjs';

const ids = reseed();
enableTargets();
const R = await e4routes();
const W = e4world('capacity', ids);
const { gate } = await import('../../../lib/passport/gate.mjs');
const { replayStored, assembledSha256 } = await import('../../../lib/passport/packet.mjs');

const COMPANIES = 10;
const AGENTS = 50;
const PLAN_MS = 2000;
const SEED_LINE = [];

/* The owner-side SQL script runner: statements on standard input, so a 256 KiB literal never meets an argument limit. */
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
/* A derived record as the gate stamps it, restamped in SQL at insert: the candidate trigger accepts an attestation made
   within five minutes. */
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
  percentile(
    [...values].sort((a, b) => a - b),
    95,
  ) < PLAN_MS
    ? 'p95 under the plan two seconds'
    : 'p95 NOT under the plan two seconds';

/* Every Data API request a route call makes, counted and timed to its response headers, attributed to the call. */
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

function company(slug, extraMembers) {
  const admin = W.user(`${slug}-admin`);
  const author = W.user(`${slug}-author`);
  const it = W.user(`${slug}-it`);
  const business = W.user(`${slug}-business`);
  const c = W.company(slug, admin);
  const ms = {
    admin: c.adminMembership,
    author: W.member(c.id, author),
    it: W.member(c.id, it, '{it_reviewer,member}'),
    business: W.member(c.id, business, '{business_reviewer,member}'),
  };
  sqlScript(`insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'e4-capacity-${W.run}-${slug}-' || g || '@example.invalid', now(), now() from generate_series(1, ${extraMembers}) g;
insert into app.memberships (company_id, user_id, roles) select '${c.id}', u.id, '{member}' from auth.users u where u.email like 'e4-capacity-${W.run}-${slug}-%';`);
  return { id: c.id, admin, adminHi: W.aal2(admin), author, it, business, ms };
}

const seedText = passportText('capacity');
const SEED_MARK = `${PROSE} Revision capacity.`;
const contentExpr = (expr) => `replace(${dollar('c', seedText)}, ${literal(SEED_MARK)}, ${literal(`${PROSE} Revision `)} || ${expr} || '.')`;
const activeGate = '(select id from app.gate_identities where active)';

/* The ordinary seed of section 6 for one company: 50 agents of ten candidates (1 to 5 published in turn for claude-ai,
   1 to 4 superseded, 5 approved with its current claude-ai release and, for even agents, a current chatgpt release; 6
   and 7 approved and unpublished; 8 changes_requested; 9 submitted; 10 a draft), two envelopes on 5, 6, 7 and 9 and one
   on 1 to 4, two approvals on each envelope of 1 to 7, a candidate-level change request on 8, ten groups of the
   company's 25 members, 25 ledger rows per current release. */
function ordinarySeed(c) {
  return `
insert into app.groups (company_id, name, created_by_membership_id) select '${c.id}', 'Capacity group ' || g, '${c.ms.admin}' from generate_series(0, 9) g;
insert into app.group_members (group_id, company_id, membership_id, added_by_membership_id) select gr.id, gr.company_id, m.id, '${c.ms.admin}' from app.groups gr join app.memberships m on m.company_id = gr.company_id and m.status = 'active' where gr.company_id = '${c.id}';
insert into app.agents (company_id, name, creator_membership_id, owner_membership_id) select '${c.id}', 'capacity-' || g, '${c.ms.author}', '${c.ms.author}' from generate_series(1, ${AGENTS}) g;
create temp table seed_agents as select id as agent_id, company_id, substring(name from 10)::int as agent_no from app.agents where company_id = '${c.id}' and name like 'capacity-%';
insert into app.candidate_versions (company_id, agent_id, sequence, author_membership_id, content, derived_canonical, gate_id, attested_by)
select a.company_id, a.agent_id, s, '${c.ms.author}', ${contentExpr("a.agent_no || '-' || s")}, ${derivedOf(seedText)}, ${activeGate}, '${c.ms.author}'
from seed_agents a, generate_series(1, 10) s;
insert into app.candidate_contributors (candidate_id, membership_id, kind, observed) select v.id, v.author_membership_id, 'author', true from app.candidate_versions v join seed_agents a using (agent_id);
insert into app.candidate_contributors (candidate_id, membership_id, kind, observed) select v.id, v.author_membership_id, 'submitter', true from app.candidate_versions v join seed_agents a using (agent_id) where v.sequence <= 9;
insert into app.candidate_contributors (candidate_id, kind, display_name, observed) select v.id, 'declared_offline', 'Offline colleague', false from app.candidate_versions v join seed_agents a using (agent_id) where v.sequence = 9;
update app.candidate_versions v set state = 'submitted', submitted_at = clock_timestamp(), submitted_by_membership_id = v.author_membership_id from seed_agents a where v.agent_id = a.agent_id and v.sequence <= 9;
update app.candidate_versions v set state = 'approved' from seed_agents a where v.agent_id = a.agent_id and v.sequence <= 7;
update app.candidate_versions v set state = 'changes_requested' from seed_agents a where v.agent_id = a.agent_id and v.sequence = 8;
create temp table seed_shape (sequence int, revision int, target text);
insert into seed_shape values (1,1,'claude-ai'),(2,1,'claude-ai'),(3,1,'claude-ai'),(4,1,'claude-ai'),(5,1,'claude-ai'),(5,2,'chatgpt'),(6,1,'claude-ai'),(6,2,'chatgpt'),(7,1,'claude-ai'),(7,2,'chatgpt'),(9,1,'claude-ai'),(9,2,'chatgpt');
insert into app.review_envelopes (company_id, agent_id, candidate_id, revision, content_sha256, derived_sha256, gate_id, gate_identity_sha256, target, installer_text_sha256, core_sha256, branch_sha256, judge_sha256, policy_id, policy_sha256, assembled_bytes, audience_group_ids, envelope_canonical, envelope_sha256, created_by_membership_id)
select v.company_id, v.agent_id, v.id, x.revision, v.content_sha256, v.derived_sha256, i.gate_id, g.identity_sha256, x.target, i.text_sha256, i.core_sha256, i.branch_sha256, i.judge_sha256, p.id, p.sha256, 1,
       array[(select gr.id from app.groups gr where gr.company_id = v.company_id and gr.name = 'Capacity group 0')], 'seed', sha256('seed'), v.author_membership_id
from app.candidate_versions v join seed_agents a using (agent_id) join seed_shape x on x.sequence = v.sequence
join app.gate_identities g on g.active join app.installer_texts i on i.gate_id = g.id and i.target = x.target cross join app.release_policies p where p.active;
insert into app.reviews (company_id, candidate_id, envelope_id, role, decision, reviewer_membership_id, reason)
select e.company_id, e.candidate_id, e.id, r.role, 'approved', case r.role when 'it' then '${c.ms.it}'::uuid else '${c.ms.business}'::uuid end, 'Seeded approval.'
from app.review_envelopes e join seed_agents a using (agent_id) join app.candidate_versions v on v.id = e.candidate_id and v.sequence <= 7 cross join (values ('it'), ('business')) r(role);
insert into app.reviews (company_id, candidate_id, envelope_id, role, decision, reviewer_membership_id, reason)
select v.company_id, v.id, null, 'it', 'changes_requested', '${c.ms.it}', 'Seeded change request.' from app.candidate_versions v join seed_agents a using (agent_id) where v.sequence = 8;
do $seed$
declare k int;
begin
  set constraints all deferred;
  for k in 1..5 loop
    drop table if exists seed_level;
    create temp table seed_level as
      select e.id as envelope_id, e.agent_id, e.target, gen_random_uuid() as release_id
        from app.review_envelopes e join seed_agents a using (agent_id) join app.candidate_versions v on v.id = e.candidate_id
       where v.sequence = k and (e.target = 'claude-ai' or (k = 5 and e.target = 'chatgpt' and a.agent_no % 2 = 0));
    update app.releases r set superseded_by_release_id = l.release_id, superseded_at = clock_timestamp()
      from seed_level l where r.agent_id = l.agent_id and r.target = l.target and r.state = 'published' and r.superseded_by_release_id is null;
    insert into app.releases (id, company_id, agent_id, candidate_id, envelope_id, target, gate_id, content_sha256, derived_sha256, installer_text_sha256, core_sha256, branch_sha256, judge_sha256, policy_id, policy_sha256, audience_group_ids, envelope_sha256, assembled_content, published_by_membership_id)
    select l.release_id, e.company_id, e.agent_id, e.candidate_id, e.id, e.target, e.gate_id, e.content_sha256, e.derived_sha256, e.installer_text_sha256, e.core_sha256, e.branch_sha256, e.judge_sha256, e.policy_id, e.policy_sha256, e.audience_group_ids, e.envelope_sha256, replace(v.content, app.installer_placeholder(), i.text), '${c.ms.admin}'
      from seed_level l join app.review_envelopes e on e.id = l.envelope_id join app.candidate_versions v on v.id = e.candidate_id
      join app.installer_texts i on i.gate_id = e.gate_id and i.target = e.target;
  end loop;
end $seed$;
update app.candidate_versions v set state = 'superseded' from seed_agents a where v.agent_id = a.agent_id and v.sequence <= 4;
insert into app.release_downloads (company_id, release_id, membership_id)
select r.company_id, r.id, m.id from app.releases r join seed_agents a using (agent_id) join app.memberships m on m.company_id = r.company_id and m.status = 'active'
 where r.state = 'published' and r.superseded_by_release_id is null;
drop table seed_agents; drop table seed_shape; drop table if exists seed_level;
select 'SEEDED|' || (select count(*) from app.candidate_versions where company_id = '${c.id}') || '|' || (select count(*) from app.review_envelopes where company_id = '${c.id}') || '|' || (select count(*) from app.reviews where company_id = '${c.id}') || '|' || (select count(*) from app.releases where company_id = '${c.id}') || '|' || (select count(*) from app.release_downloads where company_id = '${c.id}');`;
}

test('section 6: the capacity sample, recorded with its seed; case 52 query plans', async (t) => {
  const t0 = performance.now();
  const companies = [];
  for (let i = 0; i < COMPANIES; i++) {
    const c = company(`c${i}`, 21);
    const seeded = sqlScript(ordinarySeed(c)).split('\n').find((l) => l.startsWith('SEEDED|'));
    assert.equal(seeded, `SEEDED|${AGENTS * 10}|${AGENTS * 12}|${AGENTS * 20 + AGENTS}|${AGENTS * 5 + AGENTS / 2}|${(AGENTS + AGENTS / 2) * 25}`, `company ${i}`);
    companies.push(c);
  }
  const policyId = activePolicyId();

  /* The worst queue page: a company of 50 agents, each with one submitted candidate at 20 envelopes and three reviews. */
  const worst = company('worst', 21);
  sqlScript(`
insert into app.groups (company_id, name, created_by_membership_id) select '${worst.id}', 'Capacity group ' || g, '${worst.ms.admin}' from generate_series(0, 4) g;
insert into app.agents (company_id, name, creator_membership_id, owner_membership_id) select '${worst.id}', 'worst-' || g, '${worst.ms.author}', '${worst.ms.author}' from generate_series(1, ${AGENTS}) g;
insert into app.candidate_versions (company_id, agent_id, sequence, author_membership_id, content, derived_canonical, gate_id, attested_by)
select a.company_id, a.id, 1, '${worst.ms.author}', ${contentExpr('a.name')}, ${derivedOf(seedText)}, ${activeGate}, '${worst.ms.author}' from app.agents a where a.company_id = '${worst.id}';
update app.candidate_versions set state = 'submitted', submitted_at = clock_timestamp(), submitted_by_membership_id = author_membership_id where company_id = '${worst.id}';
insert into app.review_envelopes (company_id, agent_id, candidate_id, revision, content_sha256, derived_sha256, gate_id, gate_identity_sha256, target, installer_text_sha256, core_sha256, branch_sha256, judge_sha256, policy_id, policy_sha256, assembled_bytes, audience_group_ids, envelope_canonical, envelope_sha256, created_by_membership_id)
select v.company_id, v.agent_id, v.id, row_number() over (partition by v.id order by i.target, gr.name)::int, v.content_sha256, v.derived_sha256, i.gate_id, g.identity_sha256, i.target, i.text_sha256, i.core_sha256, i.branch_sha256, i.judge_sha256, p.id, p.sha256, 1, array[gr.id], 'seed', sha256('seed'), v.author_membership_id
from app.candidate_versions v join app.groups gr on gr.company_id = v.company_id join app.gate_identities g on g.active join app.installer_texts i on i.gate_id = g.id cross join app.release_policies p
where v.company_id = '${worst.id}' and p.active;
insert into app.reviews (company_id, candidate_id, envelope_id, role, decision, reviewer_membership_id, reason)
select e.company_id, e.candidate_id, e.id, 'it', 'approved', '${worst.ms.it}', 'Seeded approval.' from app.review_envelopes e where e.company_id = '${worst.id}' and e.revision <= 3;`);
  assert.equal(sql(`select count(*) || '|' || (select count(*) from app.reviews where company_id='${worst.id}') from app.review_envelopes where company_id='${worst.id}'`), `${AGENTS * 20}|${AGENTS * 3}`);

  /* The worst review read: a 21-version chain in company 0 with 1,052 contributor rows, 20 envelopes, 61 reviews and
     256 KiB of content on the newest version. */
  const c0 = companies[0];
  const large = largePassport('chain').toString('utf8');
  const chain = sqlScript(`
insert into app.agents (company_id, name, creator_membership_id, owner_membership_id) values ('${c0.id}', 'capacity-chain', '${c0.ms.author}', '${c0.ms.author}');
insert into app.candidate_versions (company_id, agent_id, sequence, author_membership_id, content, derived_canonical, gate_id, attested_by)
select '${c0.id}', a.id, s, '${c0.ms.author}', ${contentExpr("'chain-' || s")}, ${derivedOf(seedText)}, ${activeGate}, '${c0.ms.author}' from app.agents a, generate_series(1, 20) s where a.company_id = '${c0.id}' and a.name = 'capacity-chain';
insert into app.candidate_versions (company_id, agent_id, sequence, author_membership_id, content, derived_canonical, gate_id, attested_by)
select '${c0.id}', a.id, 21, '${c0.ms.author}', ${dollar('l', large)}, ${derivedOf(large)}, ${activeGate}, '${c0.ms.author}' from app.agents a where a.company_id = '${c0.id}' and a.name = 'capacity-chain';
create temp table chain_versions as select v.* from app.candidate_versions v join app.agents a on a.id = v.agent_id where a.company_id = '${c0.id}' and a.name = 'capacity-chain';
insert into app.candidate_contributors (candidate_id, membership_id, kind, observed) select id, author_membership_id, k, true from chain_versions, (values ('author'), ('submitter')) x(k);
insert into app.candidate_contributors (candidate_id, kind, display_name, observed) select id, 'declared_offline', 'Offline colleague ' || n, false from chain_versions, generate_series(1, 48) n;
insert into app.candidate_contributors (candidate_id, kind, display_name, observed) select id, 'declared_offline', 'Offline colleague extra ' || n, false from chain_versions, generate_series(1, 2) n where sequence = 21;
update app.candidate_versions set state = 'submitted', submitted_at = clock_timestamp(), submitted_by_membership_id = author_membership_id where id in (select id from chain_versions);
update app.candidate_versions set state = 'changes_requested' where id in (select id from chain_versions where sequence <= 20);
insert into app.review_envelopes (company_id, agent_id, candidate_id, revision, content_sha256, derived_sha256, gate_id, gate_identity_sha256, target, installer_text_sha256, core_sha256, branch_sha256, judge_sha256, policy_id, policy_sha256, assembled_bytes, audience_group_ids, envelope_canonical, envelope_sha256, created_by_membership_id)
select v.company_id, v.agent_id, v.id, row_number() over (order by i.target, gr.name)::int, v.content_sha256, v.derived_sha256, i.gate_id, g.identity_sha256, i.target, i.text_sha256, i.core_sha256, i.branch_sha256, i.judge_sha256, p.id, p.sha256, 1, array[gr.id], 'seed', sha256('seed'), v.author_membership_id
from chain_versions v join app.groups gr on gr.company_id = v.company_id and gr.name in ('Capacity group 0', 'Capacity group 1', 'Capacity group 2', 'Capacity group 3', 'Capacity group 4')
join app.gate_identities g on g.active join app.installer_texts i on i.gate_id = g.id cross join app.release_policies p where v.sequence = 21 and p.active;
insert into app.reviews (company_id, candidate_id, envelope_id, role, decision, reviewer_membership_id, reason)
select e.company_id, e.candidate_id, e.id, r.role, 'approved', case r.role when 'it' then '${c0.ms.it}'::uuid else '${c0.ms.business}'::uuid end, 'Seeded approval.'
from app.review_envelopes e join chain_versions v on v.id = e.candidate_id cross join (values ('it'), ('business')) r(role);
insert into app.reviews (company_id, candidate_id, envelope_id, role, decision, reviewer_membership_id, reason)
select e.company_id, e.candidate_id, e.id, 'it', 'changes_requested', '${c0.ms.it}', 'Seeded change request.' from app.review_envelopes e join chain_versions v on v.id = e.candidate_id;
insert into app.reviews (company_id, candidate_id, envelope_id, role, decision, reviewer_membership_id, reason)
select company_id, id, null, 'business', 'changes_requested', '${c0.ms.business}', 'Seeded candidate change request.' from chain_versions where sequence = 21;
select 'CHAIN|' || v.id || '|' || v.agent_id || '|' || octet_length(v.content) || '|' || (select count(*) from app.candidate_contributors k join chain_versions x on x.id = k.candidate_id) || '|' || (select count(*) from app.review_envelopes where candidate_id = v.id) || '|' || (select count(*) from app.reviews where candidate_id = v.id)
from chain_versions v where v.sequence = 21;`)
    .split('\n')
    .find((l) => l.startsWith('CHAIN|'))
    .split('|');
  const [, chainCandidate, chainAgent, chainBytes, chainContributors, chainEnvelopes, chainReviews] = chain;
  assert.deepEqual([chainBytes, chainContributors, chainEnvelopes, chainReviews], [String(MAX_BYTES), '1052', '20', '61']);

  /* The withdrawal company: 500 members; 20 agents each with one published release whose ledger holds 5,000 rows, over
     25 distinct recipients for ten of them and 500 for the other ten. */
  const wd = company('withdraw', 496);
  sqlScript(`
insert into app.groups (company_id, name, created_by_membership_id) values ('${wd.id}', 'Capacity group 0', '${wd.ms.admin}');
insert into app.agents (company_id, name, creator_membership_id, owner_membership_id) select '${wd.id}', 'withdraw-' || g, '${wd.ms.author}', '${wd.ms.author}' from generate_series(1, 20) g;
insert into app.candidate_versions (company_id, agent_id, sequence, author_membership_id, content, derived_canonical, gate_id, attested_by)
select a.company_id, a.id, 1, '${wd.ms.author}', ${contentExpr('a.name')}, ${derivedOf(seedText)}, ${activeGate}, '${wd.ms.author}' from app.agents a where a.company_id = '${wd.id}';
update app.candidate_versions set state = 'submitted', submitted_at = clock_timestamp(), submitted_by_membership_id = author_membership_id where company_id = '${wd.id}';
update app.candidate_versions set state = 'approved' where company_id = '${wd.id}';
insert into app.review_envelopes (company_id, agent_id, candidate_id, revision, content_sha256, derived_sha256, gate_id, gate_identity_sha256, target, installer_text_sha256, core_sha256, branch_sha256, judge_sha256, policy_id, policy_sha256, assembled_bytes, audience_group_ids, envelope_canonical, envelope_sha256, created_by_membership_id)
select v.company_id, v.agent_id, v.id, 1, v.content_sha256, v.derived_sha256, i.gate_id, g.identity_sha256, i.target, i.text_sha256, i.core_sha256, i.branch_sha256, i.judge_sha256, p.id, p.sha256, 1, array[(select id from app.groups where company_id = '${wd.id}')], 'seed', sha256('seed'), v.author_membership_id
from app.candidate_versions v join app.gate_identities g on g.active join app.installer_texts i on i.gate_id = g.id and i.target = 'claude-ai' cross join app.release_policies p where v.company_id = '${wd.id}' and p.active;
insert into app.reviews (company_id, candidate_id, envelope_id, role, decision, reviewer_membership_id, reason)
select e.company_id, e.candidate_id, e.id, r.role, 'approved', case r.role when 'it' then '${wd.ms.it}'::uuid else '${wd.ms.business}'::uuid end, 'Seeded approval.' from app.review_envelopes e cross join (values ('it'), ('business')) r(role) where e.company_id = '${wd.id}';
insert into app.releases (company_id, agent_id, candidate_id, envelope_id, target, gate_id, content_sha256, derived_sha256, installer_text_sha256, core_sha256, branch_sha256, judge_sha256, policy_id, policy_sha256, audience_group_ids, envelope_sha256, assembled_content, published_by_membership_id)
select e.company_id, e.agent_id, e.candidate_id, e.id, e.target, e.gate_id, e.content_sha256, e.derived_sha256, e.installer_text_sha256, e.core_sha256, e.branch_sha256, e.judge_sha256, e.policy_id, e.policy_sha256, e.audience_group_ids, e.envelope_sha256, replace(v.content, app.installer_placeholder(), i.text), '${wd.ms.admin}'
from app.review_envelopes e join app.candidate_versions v on v.id = e.candidate_id join app.installer_texts i on i.gate_id = e.gate_id and i.target = e.target where e.company_id = '${wd.id}';
create temp table wd_members as select id, row_number() over (order by id) as n from app.memberships where company_id = '${wd.id}' and status = 'active';
create temp table wd_releases as select id, company_id, row_number() over (order by id) as n from app.releases where company_id = '${wd.id}';
insert into app.release_downloads (company_id, release_id, membership_id)
select r.company_id, r.id, m.id from wd_releases r join wd_members m on m.n <= 25 cross join generate_series(1, 200) where r.n <= 10;
insert into app.release_downloads (company_id, release_id, membership_id)
select r.company_id, r.id, m.id from wd_releases r join wd_members m on m.n <= 500 cross join generate_series(1, 10) where r.n > 10;`);
  const withdrawals = sql(
    `select string_agg(r.id || ':' || (select count(distinct membership_id) from app.release_downloads d where d.release_id = r.id) || ':' || (select count(*) from app.release_downloads d where d.release_id = r.id), ',' order by r.id) from app.releases r where r.company_id = '${wd.id}'`,
  )
    .split(',')
    .map((x) => x.split(':'));
  assert.equal(withdrawals.length, 20);
  assert.ok(withdrawals.every(([, recipients, rows]) => (recipients === '25' || recipients === '500') && rows === '5000'), 'ledgers of 5,000 rows');
  const seedSeconds = ((performance.now() - t0) / 1000).toFixed(0);
  SEED_LINE.push(
    `seed (${seedSeconds} s, owner-side SQL with every trigger in force): ${COMPANIES} companies of 25 members (an admin, an author, an IT and a business reviewer with real sessions, 21 more members), each with ten groups of all 25 members and ${AGENTS} agents of ten candidates (${AGENTS * 10} candidates, ${AGENTS * 12} envelopes, ${AGENTS * 21} reviews, ${AGENTS * 5 + AGENTS / 2} releases of which ${AGENTS + AGENTS / 2} current, 25 ledger rows per current release) as ordinarySeed() states; a worst-queue company of ${AGENTS} submitted candidates at 20 envelopes and 3 reviews; in company 0 a 21-version chain with ${chainContributors} contributor rows, ${chainEnvelopes} envelopes, ${chainReviews} reviews and ${chainBytes} content bytes on the newest; a withdrawal company of 500 members with 20 releases of 5,000 ledger rows each (ten over 25 recipients, ten over 500).`,
    'reading of the seed: three approved candidates per agent (5, 6 and 7) with a current release on 5 is the design seed as written; the routines would have moved an older approved candidate to superseded at each publication (1.3 rule 4), which is why the older four are superseded here and 6 and 7 carry no release.',
  );

  /* ---------- the reads ---------- */
  const lines = [];
  const queueOrdinary = await rounds('queue, ordinary', { warmup: 1, count: 10 }, () =>
    companies.flatMap((c) => [() => R.queue(c.it, c.id), () => R.queue(c.business, c.id)]),
  );
  lines.push(
    `GET review-queue, ordinary seed, 20 concurrent sessions over ten companies, 10 rounds: whole request ${summary(queueOrdinary.totals)} (${verdictOf(queueOrdinary.totals)}); Data API time ${summary(queueOrdinary.db)}; Data API requests per call ${Math.min(...queueOrdinary.calls)} to ${Math.max(...queueOrdinary.calls)}`,
  );
  const worstPage = await R.queue(worst.it, worst.id);
  assert.deepEqual([worstPage.body.awaitingDecision.length, worstPage.body.awaitingDecision[0].envelopes.length], [50, 20]);
  const queueWorst = await rounds('queue, worst page', { warmup: 1, count: 5 }, () => Array.from({ length: 20 }, () => () => R.queue(worst.it, worst.id)));
  lines.push(
    `GET review-queue, the worst page (50 submitted candidates at 20 envelopes and 3 reviews), 20 concurrent calls, 5 rounds: whole request ${summary(queueWorst.totals)} (${verdictOf(queueWorst.totals)}); Data API time ${summary(queueWorst.db)}; Data API requests per call ${Math.min(...queueWorst.calls)} to ${Math.max(...queueWorst.calls)}`,
  );

  const ordinaryCandidates = companies.map((c) =>
    sql(`select v.id from app.candidate_versions v join app.agents a on a.id = v.agent_id where a.company_id = '${c.id}' and a.name = 'capacity-1' and v.sequence = 9`),
  );
  const readOrdinary = await rounds('review read, ordinary', { warmup: 1, count: 10 }, () =>
    companies.flatMap((c, i) => [() => R.reviewRead(c.it, ordinaryCandidates[i]), () => R.reviewRead(c.business, ordinaryCandidates[i])]),
  );
  lines.push(
    `GET /api/candidates/{id}/review, ordinary (3 contributors, 2 envelopes, the agent's 5 releases, 10 groups), 20 concurrent over ten companies, 10 rounds: whole request ${summary(readOrdinary.totals)} (${verdictOf(readOrdinary.totals)}); Data API time ${summary(readOrdinary.db)}; Data API requests per call ${Math.min(...readOrdinary.calls)} to ${Math.max(...readOrdinary.calls)}`,
  );
  const chainRead = await R.reviewRead(c0.it, chainCandidate);
  assert.deepEqual([chainRead.status, chainRead.body.envelopes?.length, chainRead.body.reviews?.length], [200, 20, 61], chainRead.raw?.slice(0, 300));
  const readWorst = await rounds('review read, worst bound', { warmup: 1, count: 20 }, () => [() => R.reviewRead(c0.it, chainCandidate)]);
  lines.push(
    `GET /api/candidates/{id}/review, the worst bound (21-version chain, ${chainContributors} contributor rows, 20 envelopes, 61 reviews, ${chainBytes} content bytes), 20 sequential calls: whole request ${summary(readWorst.totals)} (${verdictOf(readWorst.totals)}); Data API time ${summary(readWorst.db)}; Data API requests per call ${Math.min(...readWorst.calls)} to ${Math.max(...readWorst.calls)}; answer ${Buffer.byteLength(chainRead.raw)} bytes`,
  );

  /* ---------- the writes, through the routes on content the routes stored ---------- */
  /* A new version of a seeded agent, never a new agent: every company already holds the 50 agents E3's limit allows. */
  const created = async (c, agentNo, bytes) => {
    const agentId = sql(`select id from app.agents where company_id='${c.id}' and name='capacity-${agentNo}'`);
    const d = await R.create(c.author, c.id, { agentId, bytes });
    assert.equal(d.status, 201, d.raw);
    const s = await R.submit(c.author, d.body.candidateId, 1);
    assert.equal(s.status, 200, s.raw);
    return { candidateId: d.body.candidateId, agentId: d.body.agentId };
  };
  const envelope = async (c, candidateId, target) => {
    const r = await R.envelope(c.author, candidateId, { target, audienceGroupIds: [sql(`select id from app.groups where company_id='${c.id}' and name='Capacity group 0'`)], policyId });
    assert.equal(r.status, 201, r.raw);
    return r.body.envelope.envelopeId;
  };
  const approve = async (c, candidateId, envelopeId) => {
    for (const [user, role] of [
      [c.it, 'it'],
      [c.business, 'business'],
    ]) {
      const r = await R.review(user, candidateId, { envelopeId, role, decision: 'approved', reason: 'Approved.' });
      assert.equal(r.status, 201, r.raw);
    }
  };

  const approvals = [];
  for (const [i, c] of companies.entries()) {
    for (const j of [0, 1]) {
      const { candidateId } = await created(c, 11 + j, largePassport(`approve-${i}-${j}`));
      approvals.push({ c, candidateId, envelopeId: await envelope(c, candidateId, 'claude-ai') });
    }
  }
  const reviewRound = async (role) =>
    batch(
      `POST reviews, ${role}`,
      approvals.map(({ c, candidateId, envelopeId }) => () => R.review(role === 'it' ? c.it : c.business, candidateId, { envelopeId, role, decision: 'approved', reason: 'Approved at 256 KiB.' })),
      201,
    );
  const firstApprovals = await reviewRound('it');
  const secondApprovals = await reviewRound('business');
  const replayTimes = [];
  const largest = largePassport('replay-alone').toString('utf8');
  const stored = gate(Buffer.from(largest, 'utf8'), 'text/markdown', { validatedAt: new Date().toISOString() });
  for (let i = 0; i < 30; i++) {
    const s = performance.now();
    assert.equal(replayStored({ content: largest, derivedCanonical: stored.derivedCanonical }).ok, true);
    replayTimes.push(performance.now() - s);
  }
  const reviewTotals = [...firstApprovals, ...secondApprovals].map((x) => x.total);
  lines.push(
    `POST reviews, approvals of 262,144-byte candidates, 20 concurrent across ten companies, two rounds (the first role's approvals, then the second role's, which approve the candidates): whole request ${summary(reviewTotals)} (${verdictOf(reviewTotals)}); Data API time ${summary([...firstApprovals, ...secondApprovals].map((x) => x.db))}; the service replay alone on the largest content, 30 sequential runs: ${summary(replayTimes)}`,
  );

  const publications = [];
  for (const [i, c] of companies.entries()) {
    for (const j of [0, 1]) {
      const first = await created(c, 21 + j, Buffer.from(passportText(`publish-${i}-${j}`), 'utf8'));
      for (const target of ['claude-code', 'generic']) {
        const e = await envelope(c, first.candidateId, target);
        await approve(c, first.candidateId, e);
        const p = await R.publish(c.adminHi, first.candidateId, e);
        assert.equal(p.status, 201, p.raw);
      }
      const d = await R.create(c.author, c.id, { agentId: first.agentId, bytes: largePassport(`publish-large-${i}-${j}`) });
      assert.equal(d.status, 201, d.raw);
      assert.equal((await R.submit(c.author, d.body.candidateId, 1)).status, 200);
      const e = await envelope(c, d.body.candidateId, 'claude-code');
      await approve(c, d.body.candidateId, e);
      publications.push({ c, candidateId: d.body.candidateId, envelopeId: e });
    }
  }
  const published = await batch(
    'POST releases',
    publications.map(({ c, candidateId, envelopeId }) => () => R.publish(c.adminHi, candidateId, envelopeId)),
    201,
  );
  for (const x of published) assert.equal(x.r.body.superseded.releaseIds.length, 2, 'each publication supersedes two releases');
  /* The vendored text, checked against the registered hash: the owner SQL helper trims its output, which would drop the
     text's final newline. */
  const { installerText } = await import('../../../lib/passport/assemble.mjs');
  const codeText = installerText(join(ROOT, 'vendor/passport'), 'claude-code.md');
  assert.equal(
    createHash('sha256').update(codeText, 'utf8').digest('hex'),
    sql(
      `select encode(i.text_sha256, 'hex') from app.installer_texts i join app.gate_identities g on g.id = i.gate_id and g.active where i.target = 'claude-code'`,
    ),
    'the vendored claude-code text is the registered one',
  );
  const largeContent = largePassport('assembly-alone').toString('utf8');
  const assemblyTimes = [];
  for (let i = 0; i < 30; i++) {
    const s = performance.now();
    assembledSha256(largeContent, codeText);
    assemblyTimes.push(performance.now() - s);
  }
  const toast = sql(
    `select assembled_bytes || '|' || pg_column_size(assembled_content) from app.releases where id = '${published[0].r.body.release.releaseId}'`,
  ).split('|');
  lines.push(
    `POST releases, the largest assembly (${MAX_BYTES} content bytes, the ${Buffer.byteLength(codeText)}-byte claude-code text, ${toast[0]} assembled bytes), each superseding two releases, 20 concurrent across ten companies: whole request ${summary(published.map((x) => x.total))} (${verdictOf(published.map((x) => x.total))}); Data API time ${summary(published.map((x) => x.db))}; Node's split, join and hash alone, 30 sequential runs: ${summary(assemblyTimes)}`,
    `release row storage: the largest assembled release holds ${toast[0]} bytes of text stored in ${toast[1]} bytes (pg_column_size, after TOAST compression)`,
  );

  const withdrawTimes = { 25: [], 500: [] };
  for (const [releaseId, recipients] of withdrawals) {
    const s = performance.now();
    const r = await R.withdraw(wd.adminHi, releaseId, 'Capacity withdrawal.');
    withdrawTimes[recipients].push(performance.now() - s);
    assert.deepEqual([r.status, r.body.recipientCount], [200, Number(recipients)], r.raw?.slice(0, 300));
  }
  lines.push(
    `POST withdraw, 25 distinct recipients over a 5,000-row ledger, 10 sequential: ${summary(withdrawTimes[25])} (${verdictOf(withdrawTimes[25])})`,
    `POST withdraw, 500 distinct recipients over a 5,000-row ledger, 10 sequential: ${summary(withdrawTimes[500])} (${verdictOf(withdrawTimes[500])})`,
  );

  /* ---------- case 52: the plans, as PostgREST's reader sees them ---------- */
  const queueIds = sql(
    `select string_agg(quote_literal(id), ',') from (select id from app.candidate_versions where company_id = '${worst.id}' and state = 'submitted' order by submitted_at, id limit 50) x`,
  );
  const approvedIds = sql(
    `select string_agg(quote_literal(id), ',') from (select id from app.candidate_versions where company_id = '${c0.id}' and state = 'approved' order by id limit 50) x`,
  );
  const reader = (userId, query) =>
    sqlScript(
      `begin;\nselect set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated"}', true);\nset local role authenticated;\nexplain (analyze, costs off, timing off, summary off) ${query};\nrollback;\n`,
    )
      .split('\n')
      .filter((l) => l !== 'BEGIN' && l !== 'SET' && l !== 'ROLLBACK' && !l.startsWith('{'))
      .join('\n');
  const plans = [
    ['queue: submitted candidates of the worst company', worst.it.id, `select id, agent_id, sequence, state, submitted_at, author_membership_id, gate_id from api.candidate_versions where company_id = '${worst.id}' and state = 'submitted' order by submitted_at asc, id asc limit 51`],
    ['queue: envelopes of 50 candidates', worst.it.id, `select id, candidate_id, revision, target, status, gate_id, policy_id from api.review_envelopes where candidate_id in (${queueIds}) order by id limit 200`],
    ['queue: reviews of 50 candidates', worst.it.id, `select id, envelope_id, role, decision from api.reviews where candidate_id in (${queueIds}) order by id limit 200`],
    ['queue: current releases of 50 approved candidates', c0.it.id, `select id, envelope_id from api.releases where candidate_id in (${approvedIds}) and state = 'published' and superseded_by_release_id is null order by id limit 200`],
    ['review read: envelopes of the chain candidate', c0.it.id, `select * from api.review_envelopes where candidate_id = '${chainCandidate}' order by id limit 200`],
    ['review read: reviews of the chain candidate', c0.it.id, `select * from api.reviews where candidate_id = '${chainCandidate}' order by id limit 200`],
    ['review read: releases of the agent', c0.it.id, `select id, candidate_id, state from api.releases where agent_id = '${chainAgent}' order by id limit 200`],
    ['release list: published releases of company 0', c0.admin.id, `select id, target, state from api.releases where company_id = '${c0.id}' and state = 'published' order by id asc limit 51`],
  ];
  const planLines = [];
  const sequential = [];
  for (const [label, userId, query] of plans) {
    const plan = reader(userId, query);
    assert.match(plan, /Limit|Scan|Sort/, label);
    for (const m of plan.matchAll(/Seq Scan on (\w+)/g)) sequential.push(`${label}: ${m[1]}`);
    planLines.push(`-- ${label}\n${plan}`);
  }
  lines.push(
    `case 52, sequential scans of reviews, review_envelopes or releases in the eight plans: ${sequential.filter((s) => /: (reviews|review_envelopes|releases)$/.test(s)).join('; ') || 'none'}; every sequential scan in them: ${sequential.join('; ') || 'none'}`,
  );

  const header = [
    `section 6 capacity sample, measured ${new Date().toISOString()}`,
    ...SEED_LINE,
    `machine: ${cpus()[0]?.model ?? 'unknown'}, ${availableParallelism()} logical CPUs; Node ${process.version}; PostgreSQL ${sql('show server_version')}`,
  ];
  const limits = [
    'reading: the Data API time of a call is the sum of its requests, several of which run at once, so it can exceed the whole request; and all requests share one Node process, so an answer that arrives while another request computes waits for the event loop inside that sum. The whole request is the figure this sample can state without either ambiguity.',
    'limits: one machine runs the database, PostgREST, GoTrue and every request; separate function instances would run in parallel; loopback, no TLS; the local stack is not the hosted plan; the rows are synthetic; no cold start; a local sample is not production readiness and none of these figures is a claim.',
  ];
  const record = `${[...header, ...lines, ...limits].join('\n')}\n\ncase 52 plans (explain analyze, costs, timing and summary off, as the authenticated reader with its claims):\n${planLines.join('\n\n')}\n`;
  mkdirSync(join(ROOT, '.scratch', 'e4'), { recursive: true });
  writeFileSync(join(ROOT, '.scratch', 'e4', 'capacity.txt'), record);
  /* The evidence copy is replaced only by a run that says so (Q5R-F1-R-F1, evidence/e5-pages-review.md): this file runs
     inside bash scripts/check.sh, and a check that rewrites an accepted record on every run leaves the checkout dirty
     and the record describing whichever run came last. */
  if (process.env.CAPACITY_EVIDENCE === '1') {
    mkdirSync(join(ROOT, 'evidence', 'e4-server-repro'), { recursive: true });
    writeFileSync(join(ROOT, 'evidence', 'e4-server-repro', 'capacity.txt'), record);
  }
  for (const line of [...header, ...lines]) t.diagnostic(line);
});
