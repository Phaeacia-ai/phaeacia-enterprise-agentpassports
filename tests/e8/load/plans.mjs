#!/usr/bin/env node
/* The five hottest reads' query plans, with their buffer counts (docs/e8/design.md 4.1, last
 * paragraph): "the catalog predicate; the review queue's envelope and review reads; the release
 * read; the download authorization's audience overlap and ledger count; the members list's in.(…).
 * Each plan is recorded with its buffer counts, and the check is that no plan is a sequential scan
 * on a table above 10,000 rows and that each uses the index its design names."
 *
 *   node tests/e8/load/plans.mjs --label <label>
 *
 * NOT A GATE. It records; it asserts nothing. The two checks above are reported as booleans beside
 * each plan so that a reader sees which plan failed which, and the record is the evidence.
 *
 * WHOSE CONNECTION, AND WHOSE ROLE. The connection is the OWNER's, because `explain (analyze,
 * buffers)` needs it. Every read a REQUEST makes is then explained with `set local role
 * authenticated` and the caller's own `request.jwt.claims`, which is how tests/e4/stack and
 * tests/e5/stack read their plans: the plan a reader gets is the plan with that reader's row-level
 * policies in it, and the owner's plan would be a different one. The two reads that a SECURITY
 * DEFINER routine makes (the download authorization's audience overlap and its ledger count) are
 * explained AS THE OWNER, because that is the role they really run under; each says so in its row.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';

import { ROOT, stackEnv } from '../../e2/helpers/stack.mjs';
import { readWorld } from './seed.mjs';

const OUT_DIR = join(ROOT, 'evidence', 'e8-load-repro');
/* Design 4.1's check: no sequential scan on a table above this many rows. */
const SEQ_SCAN_ROWS = 10000;

function sqlScript(text) {
  const { dbContainer } = stackEnv();
  const r = spawnSync(
    'docker',
    ['exec', '-i', dbContainer, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'],
    { input: text, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000 },
  );
  if (r.status !== 0) throw new Error(`owner psql exited ${r.status}: ${`${r.stderr}${r.stdout}`.slice(0, 900)}`);
  return (r.stdout ?? '').trim();
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const noise = new Set(['BEGIN', 'SET', 'ROLLBACK', 'COMMIT']);
const value = (text) => {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !noise.has(l));
  return lines[0] ?? '';
};

/** One plan. `as` is a user id for an authenticated reader, or null for the owner. */
function explain(statement, as) {
  const body = as === null
    ? `explain (analyze, buffers, costs off, timing off, summary off) ${statement};`
    : `select set_config('request.jwt.claims', '{"sub":"${as}","role":"authenticated"}', true);
       set local role authenticated;
       explain (analyze, buffers, costs off, timing off, summary off) ${statement};`;
  return sqlScript(`begin;\n${body}\nrollback;\n`)
    .split('\n')
    .filter((l) => !noise.has(l.trim()) && !l.trim().startsWith('{') && l.trim().length > 0)
    .join('\n');
}

/** The tables a plan sequentially scans, and their live row counts. */
function sequentialScans(plan) {
  const names = [...plan.matchAll(/Seq Scan on ([a-z_]+)/g)].map((m) => m[1]);
  return [...new Set(names)].map((name) => {
    /* A relation the plan names that is not a base table of schema `app` (a CTE, a function scan, a
       table of another schema) has no row count here, and -1 says so rather than guessing. */
    let rows = -1;
    try {
      rows = Number(value(sqlScript(`select count(*) from app.${name};`)));
    } catch {
      rows = -1;
    }
    return { table: name, rows };
  });
}

/** A plan's buffer counts. A node's Buffers line already includes its children's, so the ROOT
    node's line is the statement's total and summing every line would count the tree several times
    over; the planner's own line is reported separately, as EXPLAIN prints it. */
function buffers(plan) {
  const [execution, planning] = plan.split(/^Planning:/m);
  const read = (text) => {
    const m = /Buffers: ([^\n]+)/.exec(text ?? '');
    if (m === null) return { sharedHit: 0, read: 0, dirtied: 0 };
    const n = (re) => Number(re.exec(m[1])?.[1] ?? 0);
    return { sharedHit: n(/shared hit=(\d+)/), read: n(/read=(\d+)/), dirtied: n(/dirtied=(\d+)/) };
  };
  return { ...read(execution), planning: read(planning) };
}

function parseArgs(argv) {
  const a = { label: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--label') a.label = argv[++i];
    else {
      process.stderr.write(`plans: unknown argument ${argv[i]}\n`);
      process.exit(2);
    }
  }
  if (a.label === null) {
    process.stderr.write('plans: --label names the world seed.mjs built\n');
    process.exit(2);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
stackEnv();
const world = readWorld(args.label);
const c = world.companies[0];
const loadBefore = loadavg().map((n) => Number(n.toFixed(2)));

/* The ids each statement needs, read once as the owner. */
const releaseId = c.downloadRelease;
const queueIds = value(
  sqlScript(`select string_agg(quote_literal(id), ',')
               from (select id from app.candidate_versions
                      where company_id = ${q(c.companyId)} and state = 'submitted'
                      order by submitted_at asc, id asc limit 50) x;`),
);
const memberUserIds = value(
  sqlScript(`select string_agg(quote_literal(user_id), ',')
               from (select user_id from app.memberships where company_id = ${q(c.companyId)}
                      and status = 'active' order by user_id limit 25) x;`),
);
const reviewerMembership = c.reviewer.membershipId;

/* The five hottest reads. Two of them are two statements, as design 4.1 names them. */
const HOTTEST = [
  {
    id: 'P1',
    hottest: 'the catalog predicate',
    read: 'GET /api/companies/{id}/catalog, the first page of 50 (lib/services/catalog.mjs readCatalog)',
    index: 'releases_company_id, with app.release_visible as the row filter (E5 design 10.2)',
    as: c.admin.userId,
    statements: [
      `select id,agent_id,target,state,superseded_by_release_id,blocked_reason,my_authorizations
         from api.release_catalog where company_id = ${q(c.companyId)} order by id asc limit 51`,
    ],
  },
  {
    id: 'P2',
    hottest: "the review queue's envelope and review reads",
    read: 'GET /api/companies/{id}/review-queue (lib/services/reviews.mjs readReviewQueue), the worst page',
    index: 'candidate_versions_company_state; review_envelopes_candidate_id_revision_key; reviews_candidate',
    as: c.admin.userId,
    statements: [
      `select id,agent_id,sequence,state,submitted_at,author_membership_id,gate_id
         from api.candidate_versions where company_id = ${q(c.companyId)} and state = 'submitted'
        order by submitted_at asc, id asc limit 51`,
      `select id,candidate_id,revision,target,status,gate_id,policy_id
         from api.review_envelopes where candidate_id in (${queueIds}) order by id limit 200`,
      `select id,envelope_id,role,decision from api.reviews where candidate_id in (${queueIds}) order by id limit 200`,
    ],
  },
  {
    id: 'P3',
    hottest: 'the release read',
    read: 'GET /api/releases/{id} (lib/services/releases.mjs readRelease), as a recipient',
    index: 'releases_pkey with app.release_visible; release_catalog by id',
    as: c.reviewer.userId,
    statements: [
      `select id,company_id,agent_id,candidate_id,envelope_id,target,state,assembled_sha256,assembled_bytes,
              superseded_by_release_id,published_at from api.releases where id = ${q(releaseId)}`,
      `select id,blocked_reason,my_authorizations from api.release_catalog where id = ${q(releaseId)}`,
    ],
  },
  {
    id: 'P4',
    hottest: "the download authorization's audience overlap and ledger count",
    read: 'POST /api/releases/{id}/download (app.download_refusal_for, 007:101-106), AS THE OWNER, which is the role a SECURITY DEFINER routine runs under',
    index: 'group_members_membership; release_downloads_release with authorized_at included (E5 design 10.2)',
    as: null,
    statements: [
      `select exists (select 1 from app.group_members gm, app.releases r
                       where r.id = ${q(releaseId)} and gm.membership_id = ${q(reviewerMembership)}
                         and gm.group_id = any (r.audience_group_ids))`,
      `select count(*) from app.release_downloads d
        where d.release_id = ${q(releaseId)} and d.membership_id = ${q(reviewerMembership)}`,
    ],
  },
  {
    id: 'P5',
    hottest: "the members list's in.(…)",
    read: 'GET /api/companies/{id}/members (lib/services/directory.mjs listMembers), the memberships read and the profiles in-list H-N7 asks about',
    index: 'memberships by company_id; profiles by user_id',
    as: c.admin.userId,
    statements: [
      `select id,user_id,status,roles,created_at,removed_at from api.memberships
        where company_id = ${q(c.companyId)} order by status asc, created_at asc, id asc limit 201`,
      `select user_id,display_name from api.profiles where user_id in (${memberUserIds}) order by user_id asc limit 201`,
    ],
  },
];

const plans = [];
for (const h of HOTTEST) {
  const parts = h.statements.map((s) => {
    const plan = explain(s, h.as);
    const scans = sequentialScans(plan);
    return {
      statement: s.replace(/\s+/g, ' ').trim(),
      plan,
      buffers: buffers(plan),
      sequentialScans: scans,
      sequentialScanOverBound: scans.filter((x) => x.rows > SEQ_SCAN_ROWS),
      /* EXPLAIN writes "Index Scan using <index> on <table>" and "Bitmap Index Scan on <index>". */
      indexesUsed: [
        ...new Set(
          [...plan.matchAll(/(?:Index Scan|Index Only Scan) using ([a-z0-9_]+)|Bitmap Index Scan on ([a-z0-9_]+)/g)].map(
            (m) => m[1] ?? m[2],
          ),
        ),
      ],
    };
  });
  plans.push({
    ...h,
    statements: undefined,
    role:
      h.as === null
        ? "owner, which is the role a SECURITY DEFINER routine runs under"
        : "authenticated, with the caller's own request.jwt.claims",
    parts,
    /* The read's total is the sum of its statements' root nodes, which is what a request pays. */
    buffers: parts.reduce(
      (a, p) => ({
        sharedHit: a.sharedHit + p.buffers.sharedHit,
        read: a.read + p.buffers.read,
        dirtied: a.dirtied + p.buffers.dirtied,
        planningSharedHit: a.planningSharedHit + p.buffers.planning.sharedHit,
      }),
      { sharedHit: 0, read: 0, dirtied: 0, planningSharedHit: 0 },
    ),
    noSequentialScanOverBound: parts.every((p) => p.sequentialScanOverBound.length === 0),
  });
}

const out = {
  id: 'E8-LOAD-PLANS',
  label: world.label,
  at: new Date().toISOString(),
  command: `node tests/e8/load/plans.mjs --label ${world.label}`,
  seed: { label: world.label, command: `node tests/e8/load/seed.mjs --label ${world.label}`, builtAt: world.builtAt },
  sequentialScanRowBound: SEQ_SCAN_ROWS,
  loadAverageBefore: loadBefore,
  loadAverageAfter: loadavg().map((n) => Number(n.toFixed(2))),
  tableSizes: JSON.parse(
    value(
      sqlScript(`select jsonb_object_agg(k, n)::text from (
                   select 'candidate_versions' as k, (select count(*) from app.candidate_versions) as n
         union all select 'releases', (select count(*) from app.releases)
         union all select 'review_envelopes', (select count(*) from app.review_envelopes)
         union all select 'reviews', (select count(*) from app.reviews)
         union all select 'release_downloads', (select count(*) from app.release_downloads)
         union all select 'memberships', (select count(*) from app.memberships)
         union all select 'group_members', (select count(*) from app.group_members)
       ) t;`),
    ),
  ),
  plans,
  allPlansWithinBound: plans.every((p) => p.noSequentialScanOverBound),
};
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, `plans-${world.label}.json`), `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(
  join(OUT_DIR, `plans-${world.label}.txt`),
  `${plans
    .map(
      (p) =>
        `-- ${p.id}: ${p.hottest}\n-- read: ${p.read}\n-- role: ${p.role}\n-- indexes the design names: ${p.index}\n-- buffers (the statements' root nodes): shared hit=${p.buffers.sharedHit} read=${p.buffers.read} dirtied=${p.buffers.dirtied}; planning shared hit=${p.buffers.planningSharedHit}\n${p.parts
          .map((x) => `-- statement: ${x.statement}\n-- indexes used: ${x.indexesUsed.join(', ') || 'none'}\n${x.plan}`)
          .join('\n\n')}`,
    )
    .join('\n\n')}\n`,
);
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
