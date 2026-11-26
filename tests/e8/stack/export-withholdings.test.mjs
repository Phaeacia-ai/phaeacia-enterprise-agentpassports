/* E8-4, the export's withholdings on a hard company (docs/e8/design.md 2.1's export-endpoints row, 2.3 row E8-4,
   2.4), against the running local stack. Built by the E8-4 lane after day 6's acceptance found the case never
   built (evidence/e8-release.md E8R-F3); the lane's record is evidence/e8-export-withholdings.md.

   WHAT E7-9 ALREADY PROVES AND WHAT IT DOES NOT. tests/e7/stack/scripts.test.mjs E7-9 exports two EASY companies,
   one plain and one with a single draft, through the administrator's route (`api.export_company`) and through the
   operator's script (`scripts/export-company.mjs` with `lib/operator/takeout.mjs`), and compares them section by
   section. It never compares the envelope (`company`, `counts`, `exportedAt`), it iterates the COPY's own count
   keys, and no company it builds holds a removed member, a withdrawn release, a pending invitation or an ended
   agreement. This file builds ONE company holding all five of the row's hard features at once:
     - a SECOND AUTHOR's unsubmitted draft, which the route must withhold and the script must carry;
     - a REMOVED MEMBER's rows: their membership, profile, a submitted candidate, an unsubmitted draft (withheld by
       the route like any other author's), an agent the removal orphaned, a download and an installation report
       with its witness;
     - a WITHDRAWN RELEASE, with a download ledger row taken before the withdrawal;
     - a PENDING INVITATION, whose token hash neither document may carry;
     - a CLOSED ACCESS PERIOD, read as an agreement whose `ends_at` has passed and whose `export_by` has not
       (`app.access_state` = `export_window`): the one closed state in which the route can still answer, because
       past `export_by` it refuses 409 and there is nothing to compare. `app.access_periods` holds one row per
       company (its primary key is `company_id`), so an ended period beside a current one cannot exist. Recorded as
       E8-4-A1 in the design's amendment block;
   plus two controls the row does not name: the administrator's OWN draft, which the route must NOT withhold, and
   the first author's published release with its download, report and witness.

   THE ASSERTION IS AN EXACT SET OF PATHS. `documentDifferences(route, copy)` walks both documents whole, rows
   aligned by their key, and names every place they differ. The case asserts that list EQUALS the named
   differences, built from ids the fixture holds and never from either document: E7-9's list (`access_periods`,
   `omitted`, `withheld`, `authority`, and with the drafts their `candidate_versions` and `candidate_contributors`
   rows), plus three that follow from it and are named rather than skipped (E8-4-A2): `counts` at the four sections
   whose rows differ, `exportedAt`, which is the time each was taken, and `audit_events`' one row, which is the
   route's own `company.export` row that a copy taken afterwards carries (E7S-F14, as E7-9 built it). Because the
   walk is whole, a difference nobody named fails the case; because the list is exact, a named difference that did
   NOT happen fails it too, which is the counterexample of a copy that quietly filters what it must carry. And
   because an empty comparison passes on an easy company, each hard feature's row is also asserted present where
   the contract puts it, so the case cannot pass on a company that lost its hard features.

   THE COUNTS. The route's `counts` plus its `withheld` rows equal `app.export_section_counts` read before the route
   ran, over the FUNCTION's key set; the script's `counts` equal it read after the route and before the script,
   again over the function's keys. `withheld` is exactly the sections where the route counted fewer rows than the
   function, each with that deficit and a reason.

   E8-9, ON TWO BLOCKS THAT WRITE BY DESIGN (E8-4-A3). `tests/e8/helpers/no-write.mjs`'s snapshot, with the content
   digest over every `app` base table except `app.audit_events`, is taken around the route's read and around the
   script's run. Each block's difference must be EXACTLY one `app.audit_events` row, a `company.export` naming its
   own actor, plus, for the script, exactly one register line; every other count and every other table's content
   is unchanged. `app.audit_events` is left out of the digest because its insert moves it by construction; the rows
   that were there before are digested separately, by id, and must be unchanged.

   THE FAIL-BEFORE (design row E8-4): E7-10's mutant, a section silently dropped from the script's list, re-run
   against this company. `tests/e7/unit/takeout-text.test.mjs` builds it as `SECTION_NAMES` without
   `installation_witnesses`; here it is built in a COPY of `scripts/` and `lib/` under `.scratch/e8/`, run as the
   command, and its document fails the comparison naming exactly that section (E8-4-A4). What the run also shows is
   the finding E8W-F1: the mutant EXITS 0, writes its audit row and its register line, and publishes a copy one
   section short, because the script's completeness check reads the section names from its own list and never asks
   whether the snapshot counted a section the list lacks. With ENTERPRISE_E8_MUTANT_UNCAUGHT=1 the comparison's
   failure is rethrown, which is how evidence/e8-export-withholdings-repro/fail-before.log.txt was produced. A
   stack-free sweep beside it (E8-4-A5) drops each of the twenty-one sections from the real copy in turn, filters
   each hard feature's row from one document or the other, and changes one column, and every one fails the
   comparison.

   EVERY PATH THIS FILE WRITES IS UNDER os.tmpdir(), apart from the mutant copy under `.scratch/`, which is ignored
   by Git and by every gate. The script refuses an output path inside a Git work tree.

   THE STACK. Reseeds once through tests/db/00-seed.sh and builds its own company. Run alone:
   node --test --test-concurrency=1 tests/e8/stack/export-withholdings.test.mjs */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { SECTION_NAMES } from '../../../lib/operator/takeout.mjs';
import { takeoutText } from '../../../web/assets/app/lifecycle-view.mjs';
import { stackEnv } from '../../e2/helpers/stack.mjs';
import {
  accessState,
  agePeriod,
  e4world,
  e6routes,
  enableTargets,
  freshEmail,
  futurePeriod,
  published,
  reseed,
  reviewCompany,
  ROOT,
  sql,
  submitted,
} from '../../e6/stack/helpers.mjs';
import { caught } from '../helpers/mutant-lib.mjs';
import { difference, REGISTER_ENV, snapshot } from '../helpers/no-write.mjs';

const ids = reseed();
enableTargets();
const { dbContainer } = stackEnv();
/** The operator's own command, as E7 design 1.2 defines it: one shell command reading a statement on stdin. */
const OWNER_PSQL = `docker exec -i ${dbContainer} psql -U postgres -X -At`;
const R = await e6routes([]);
const W = e4world('e8w', ids);
const RUN = W.run;

/* Every scratch directory this file makes: under os.tmpdir(), and the mutant copy under .scratch/. */
const scratches = [];
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `e8w-${prefix}-`));
  scratches.push(dir);
  return dir;
}
const registerBefore = process.env[REGISTER_ENV];
after(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
  if (registerBefore === undefined) delete process.env[REGISTER_ENV];
  else process.env[REGISTER_ENV] = registerBefore;
});

const ok = (label, answer, ...statuses) => {
  assert.ok(statuses.includes(answer.status), `${label}: ${answer.status} ${answer.raw}`);
  return answer.body;
};

/** One script as a command, from `scriptsDir` (the real one, or a mutant copy's). */
function run(script, args, env = {}, scriptsDir = join(ROOT, 'scripts')) {
  const r = spawnSync(process.execPath, [join(scriptsDir, script), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, ENTERPRISE_DB_PSQL: OWNER_PSQL, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const events = (r, name) =>
  r.stdout
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === name);

/** A register of its own, in its own scratch directory, initialised. */
function register(prefix) {
  const dir = scratch(prefix);
  const path = join(dir, 'register.jsonl');
  const r = run('register.mjs', ['init'], { [REGISTER_ENV]: path });
  assert.equal(r.status, 0, r.output);
  return { dir, path, env: { [REGISTER_ENV]: path } };
}
const registerLines = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const counts = (companyId) => JSON.parse(sql(`select app.export_section_counts('${companyId}')`));
const maxAuditId = () => Number(sql('select coalesce(max(id), 0) from app.audit_events'));
const auditRowsAfter = (id) =>
  JSON.parse(sql(`select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]') from app.audit_events a where a.id > ${id}`));
/** The audit rows that were there before a block, digested by id, so the insert a block makes does not move it. */
const auditDigestUpTo = (id) =>
  sql(`select coalesce(md5(string_agg(t::text, '|' order by t.id)), 'empty') from app.audit_events t where t.id <= ${id}`);
/** Every `app` base table but the audit table, from the catalogue, for the content digest. */
const CONTENT = sql(
  "select string_agg(relname, ',' order by relname) from pg_class where relnamespace = 'app'::regnamespace and relkind = 'r' and relname <> 'audit_events'",
).split(',');

// ---------------------------------------------------------------------------
// The hard company.
// ---------------------------------------------------------------------------

const A = await reviewCompany(W, R, 'withholdings');
futurePeriod(A.id);
const second = W.user('withholdings-second');
const leaver = W.user('withholdings-leaver');
A.ms.second = W.member(A.id, second);
A.ms.leaver = W.member(A.id, leaver);
for (const [user, name] of [
  [second, 'Second Author E8W'],
  [leaver, 'Leaver E8W'],
])
  ok(`${name}'s profile`, await R.call('meDisplayName', { user, body: { displayName: name } }), 200, 204);
ok('the leaver joins the audience', await R.memberAdd(A.adminHi, A.id, A.groupId, A.ms.leaver), 200);

/* The first author's release, downloaded by the leaver, reported by the leaver and witnessed by IT. */
const kept = await published(R, A);
ok('the leaver downloads', await R.download(leaver, kept.releaseId), 200);
const leaverReport = ok('the leaver reports', await R.report(leaver, kept.releaseId, { status: 'pass' }), 201).report;
const witness = ok(
  'IT witnesses',
  await R.witness(A.it, leaverReport.reportId, { status: 'pass', note: 'Witnessed for E8-4.' }),
  201,
);

/* The withdrawn release, with a ledger row taken before the withdrawal. */
const withdrawn = await published(R, A);
ok('the member downloads the release to be withdrawn', await R.download(A.member, withdrawn.releaseId), 200);
ok('the withdrawal', await R.withdraw(A.adminHi, withdrawn.releaseId, 'Withdrawn for the E8-4 case.'), 200);

/* The leaver's submitted candidate and unsubmitted draft; the second author's draft; the admin's own draft. */
const leaverSubmitted = await submitted(R, A, { author: leaver });
const leaverDraft = ok('the leaver’s draft', await R.create(leaver, A.id, { name: `agent-e8w-leaver-${RUN}` }), 201);
const secondDraft = ok('the second author’s draft', await R.create(second, A.id, { name: `agent-e8w-second-${RUN}` }), 201);
const adminDraft = ok('the admin’s own draft', await R.create(A.admin, A.id, { name: `agent-e8w-admin-${RUN}` }), 201);

/* The pending invitation. */
const invitee = freshEmail('e8w');
ok('the invitation', await R.invite(A.adminHi, A.id, { email: invitee, roles: ['member'] }), 201);
const invitationId = sql(`select id from app.invitations where company_id = '${A.id}' and email_normalized = '${invitee}'`);

/* The removal, then the agreement's end. Nothing is written after this line but the two exports. */
ok('the leaver is removed', await R.removeMember(A.adminHi, A.id, A.ms.leaver), 200);
agePeriod(A.id, '1 hour', '-13 days', '-43 days');

/** The drafts the route must withhold, and their contributor rows, from the database and not from a document. */
const WITHHELD_DRAFTS = [secondDraft.candidateId, leaverDraft.candidateId].sort();
const WITHHELD_CONTRIBUTORS = sql(
  `select coalesce(string_agg(id::text, ',' order by id), '') from app.candidate_contributors where candidate_id in ('${WITHHELD_DRAFTS.join("','")}')`,
)
  .split(',')
  .filter(Boolean);

// ---------------------------------------------------------------------------
// The comparison.
// ---------------------------------------------------------------------------

/* A row's identity within its section: `id` where the table has one, else the columns its `order by` leads with. */
const ROW_KEY = {
  access_periods: (r) => r.company_id,
  company_quotas: (r) => r.name,
  profiles: (r) => r.user_id,
  group_members: (r) => `${r.group_id}/${r.membership_id}`,
  release_targets: (r) => r.target,
  installer_texts: (r) => `${r.gate_id}/${r.target}`,
};
function keyed(name, rows) {
  const keyOf = ROW_KEY[name] ?? ((r) => r.id);
  const map = new Map();
  for (const row of rows) {
    const raw = keyOf(row);
    assert.ok(raw !== undefined && raw !== null && raw !== '', `${name}: a row with no key ${JSON.stringify(row).slice(0, 120)}`);
    const k = String(raw);
    assert.equal(map.has(k), false, `${name}: two rows share the key ${k}`);
    map.set(k, row);
  }
  return map;
}
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const union = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();

function sectionDifferences(route, copy) {
  const out = [];
  for (const name of union(route, copy)) {
    if (!(name in copy)) out.push(`sections.${name}: route only`);
    else if (!(name in route)) out.push(`sections.${name}: copy only`);
    else {
      const r = keyed(name, route[name]);
      const c = keyed(name, copy[name]);
      for (const k of r.keys()) if (!c.has(k)) out.push(`sections.${name}[${k}]: route only`);
      for (const k of c.keys()) if (!r.has(k)) out.push(`sections.${name}[${k}]: copy only`);
      for (const [k, row] of r) {
        if (!c.has(k)) continue;
        for (const col of union(row, c.get(k)))
          if (!isDeepStrictEqual(row[col], c.get(k)[col])) out.push(`sections.${name}[${k}].${col}: differs`);
      }
      const common = (m, other) => [...m.keys()].filter((k) => other.has(k));
      if (!isDeepStrictEqual(common(r, c), common(c, r))) out.push(`sections.${name}: rows in another order`);
    }
  }
  return out;
}

/**
 * documentDifferences(route, copy) -> every place the two documents differ, as sorted path strings. Whole: the
 * envelope's keys, one level into each object-valued key, and every section row by row and column by column.
 */
function documentDifferences(route, copy) {
  const out = [];
  for (const k of union(route, copy)) {
    if (!(k in copy)) out.push(`${k}: route only`);
    else if (!(k in route)) out.push(`${k}: copy only`);
    else if (k === 'sections') out.push(...sectionDifferences(route.sections, copy.sections));
    else if (isObject(route[k]) && isObject(copy[k])) {
      for (const sub of union(route[k], copy[k])) {
        if (!(sub in copy[k])) out.push(`${k}.${sub}: route only`);
        else if (!(sub in route[k])) out.push(`${k}.${sub}: copy only`);
        else if (!isDeepStrictEqual(route[k][sub], copy[k][sub])) out.push(`${k}.${sub}: differs`);
      }
    } else if (!isDeepStrictEqual(route[k], copy[k])) out.push(`${k}: differs`);
  }
  return out.sort();
}

/**
 * The named differences, from ids the fixture holds: E7-9's list, plus the three that follow from it (E8-4-A2).
 * `routeAuditId` is the id of the route's own company.export row, read from the database.
 */
function namedDifferences(routeAuditId) {
  return [
    /* E7-9's: the agreement, carried by the copy and emitted empty by the route. */
    `sections.access_periods[${A.id}]: copy only`,
    'omitted: differs',
    'withheld.access_periods: route only',
    /* E7-9's, with the drafts: another author's unsubmitted drafts and their contributor rows. */
    ...WITHHELD_DRAFTS.map((id) => `sections.candidate_versions[${id}]: copy only`),
    ...WITHHELD_CONTRIBUTORS.map((id) => `sections.candidate_contributors[${id}]: copy only`),
    'withheld.candidate_versions: route only',
    'withheld.candidate_contributors: route only',
    /* E7-9's: the script's alone. */
    'authority: copy only',
    /* E8-4-A2: the counts of the four sections whose rows differ, the time each was taken, and the route's own
       audit row, which the copy was taken after. */
    'counts.access_periods: differs',
    'counts.candidate_versions: differs',
    'counts.candidate_contributors: differs',
    'counts.audit_events: differs',
    'exportedAt: differs',
    `sections.audit_events[${routeAuditId}]: copy only`,
  ].sort();
}
const unexplained = (observed, named) => ({
  extra: observed.filter((d) => !named.includes(d)),
  missing: named.filter((d) => !observed.includes(d)),
});

/** The file the members and home pages save from the route's answer, parsed: the page's own function. */
function adminFile(body) {
  assert.equal(body.ok, true);
  const file = JSON.parse(takeoutText(body));
  assert.deepEqual(Object.keys(body).filter((k) => !(k in file)), ['ok'], 'the page drops the answer flag and nothing else');
  return file;
}

/** One export pair's state, shared by the cases below. */
const taken = {};

// ---------------------------------------------------------------------------
// The cases.
// ---------------------------------------------------------------------------

test('E8-4: the company holds every hard feature, owner-side', () => {
  const state = JSON.parse(
    sql(`select jsonb_build_object(
      'company', (select status from app.companies where id = '${A.id}'),
      'leaver', (select status from app.memberships where id = '${A.ms.leaver}'),
      'leaverGroups', (select count(*) from app.group_members where membership_id = '${A.ms.leaver}'),
      'leaverAgents', (select jsonb_agg(status order by status) from app.agents where owner_membership_id = '${A.ms.leaver}'),
      'drafts', (select jsonb_object_agg(id, state) from app.candidate_versions
                  where id in ('${secondDraft.candidateId}', '${leaverDraft.candidateId}', '${adminDraft.candidateId}')),
      'withdrawn', (select state from app.releases where id = '${withdrawn.releaseId}'),
      'withdrawnDownloads', (select count(*) from app.release_downloads where release_id = '${withdrawn.releaseId}'),
      'invitation', (select jsonb_build_object('pending', accepted_at is null and revoked_at is null and expires_at > now())
                       from app.invitations where id = '${invitationId}'),
      'witnesses', (select count(*) from app.installation_witnesses where company_id = '${A.id}'))`),
  );
  assert.deepEqual(state, {
    company: 'active',
    leaver: 'removed',
    leaverGroups: 0,
    leaverAgents: ['orphaned', 'orphaned'],
    drafts: { [secondDraft.candidateId]: 'draft', [leaverDraft.candidateId]: 'draft', [adminDraft.candidateId]: 'draft' },
    withdrawn: 'withdrawn',
    withdrawnDownloads: 1,
    invitation: { pending: true },
    witnesses: 1,
  });
  assert.equal(accessState(A.id), 'export_window', 'the agreement has ended and its export window is open');
  assert.equal(WITHHELD_CONTRIBUTORS.length >= 2, true, `each withheld draft has a contributor row: ${WITHHELD_CONTRIBUTORS}`);
});

test('E8-4 and E8-9: the route’s read writes exactly its own company.export audit row and nothing else', async () => {
  const reg = register('route');
  process.env[REGISTER_ENV] = reg.path;
  taken.register = reg;
  taken.countsBeforeRoute = counts(A.id);
  const maxBefore = maxAuditId();
  const digestBefore = auditDigestUpTo(maxBefore);
  const before = snapshot({ content: CONTENT });
  const route = await R.takeout(A.adminHi, A.id);
  const afterRoute = snapshot({ content: CONTENT });
  assert.equal(route.status, 200, route.raw);
  const auditsBefore = Number(before.counts.get('app.audit_events'));
  assert.deepEqual(difference(before, afterRoute), [`app.audit_events: ${auditsBefore} -> ${auditsBefore + 1}`]);
  assert.equal(auditDigestUpTo(maxBefore), digestBefore, 'no audit row that was there before was touched');
  const [row, ...more] = auditRowsAfter(maxBefore);
  assert.deepEqual(more, [], 'one audit row, not more');
  assert.deepEqual(
    [row.company_id, row.action, row.actor_kind, row.actor_user_id, row.entity_id],
    [A.id, 'company.export', 'member', A.admin.id, A.id],
  );
  assert.equal(row.details.membership_id, A.ms.admin);
  assert.deepEqual(row.details.section_counts, route.body.counts, 'the audit row counts what the document carries');
  const withheldRows = Object.values(route.body.withheld).reduce((n, w) => n + w.rows, 0);
  assert.equal(row.details.withheld_rows, withheldRows, 'and agrees with the document about what it withheld');
  assert.ok(Number.isInteger(row.details.serialized_bytes) && row.details.serialized_bytes > 0);
  /* The administrator's DOCUMENT is the file the page saves, which is the answer less its `ok` flag
     (web/assets/app/lifecycle-view.mjs takeoutText). That file, and not the HTTP answer, is what is compared. */
  taken.route = adminFile(route.body);
  taken.routeAuditId = row.id;
});

test('E8-4 and E8-9: the script’s run writes exactly its own company.export audit row and one register line', () => {
  assert.ok(taken.route, 'the route’s document was taken');
  const reg = taken.register;
  taken.countsBeforeScript = counts(A.id);
  const outPath = join(scratch('out'), 'copy.json');
  const instructionRef = `synthetic:e8-4-${RUN}`;
  const maxBefore = maxAuditId();
  const digestBefore = auditDigestUpTo(maxBefore);
  const linesBefore = registerLines(reg.path).length;
  const before = snapshot({ content: CONTENT });
  const r = run(
    'export-company.mjs',
    ['--company', A.id, '--operator', ids.U_op, '--instruction', instructionRef, '--out', outPath],
    reg.env,
  );
  const afterScript = snapshot({ content: CONTENT });
  assert.equal(r.status, 0, r.output.slice(0, 800));
  const auditsBefore = Number(before.counts.get('app.audit_events'));
  assert.deepEqual(difference(before, afterScript), [
    `app.audit_events: ${auditsBefore} -> ${auditsBefore + 1}`,
    `register: ${before.register} -> ${afterScript.register}`,
  ]);
  assert.equal(auditDigestUpTo(maxBefore), digestBefore, 'no audit row that was there before was touched');
  const copy = JSON.parse(readFileSync(outPath, 'utf8'));
  const [row, ...more] = auditRowsAfter(maxBefore);
  assert.deepEqual(more, [], 'one audit row, not more');
  assert.deepEqual(
    [row.company_id, row.action, row.actor_kind, row.actor_user_id, row.entity_id],
    [A.id, 'company.export', 'operator', ids.U_op, A.id],
  );
  assert.deepEqual(row.details, {
    company_id: A.id,
    operator_user_id: ids.U_op,
    section_counts: copy.counts,
    withheld_rows: 0,
    serialized_bytes: readFileSync(outPath).length,
    reason_code: 'customer_instruction',
  });
  /* One register line, naming that row and this file. */
  const lines = registerLines(reg.path);
  assert.equal(lines.length, linesBefore + 1, 'one register line');
  const line = lines.at(-1);
  const sha256 = createHash('sha256').update(readFileSync(outPath)).digest('hex');
  assert.deepEqual(
    [line.act, line.companyId, line.ref, line.sha256, line.bytes, line.auditId],
    ['company.export', A.id, instructionRef, sha256, readFileSync(outPath).length, Number(row.id)],
  );
  assert.equal(line.rows, Object.values(copy.counts).reduce((a, b) => a + b, 0));
  assert.deepEqual(readdirSync(reg.dir).sort(), ['register.jsonl', 'register.jsonl.head'], 'no lock and no partial left');
  assert.deepEqual(readdirSync(join(outPath, '..')), ['copy.json'], 'the partial file was published, not left');
  taken.copy = copy;
  taken.instructionRef = instructionRef;
});

test('E8-4: the counts equal app.export_section_counts, and `withheld` names every withheld section with its reason', () => {
  const { route, copy, countsBeforeRoute: c0, countsBeforeScript: c1 } = taken;
  assert.ok(route && copy, 'both documents were taken');
  const names = Object.keys(c0).sort();
  assert.equal(names.length, 21);
  /* Over the FUNCTION's key set, so a section either document lacks fails here and is not skipped. */
  assert.deepEqual(Object.keys(route.counts).sort(), names, 'the route counts every section the function counts');
  assert.deepEqual(Object.keys(copy.counts).sort(), names, 'and so does the copy');
  for (const name of names)
    assert.equal(route.counts[name] + (route.withheld[name]?.rows ?? 0), c0[name], `the route's ${name}`);
  assert.deepEqual(copy.counts, c1, 'the copy counts exactly what the function counted before it ran');
  /* The two reads of the function differ by the route's own audit row and nothing else. */
  assert.deepEqual(c1, { ...c0, audit_events: c0.audit_events + 1 });
  /* `withheld` is exactly the deficit, section by section, each with a reason. */
  const deficits = names.filter((n) => route.counts[n] < c0[n]);
  assert.deepEqual(Object.keys(route.withheld).sort(), deficits, 'withheld names every section the route counted short');
  assert.deepEqual(route.withheld, {
    access_periods: { rows: 1, reason: 'no_admin_read_predicate' },
    candidate_versions: { rows: WITHHELD_DRAFTS.length, reason: 'another_author_draft' },
    candidate_contributors: { rows: WITHHELD_CONTRIBUTORS.length, reason: 'another_author_draft' },
  });
  assert.deepEqual(copy.withheld, {}, 'the copy withholds nothing, and the key is present');
});

test('E8-4: the two documents differ ONLY by the named differences, and each hard feature is where the contract puts it', () => {
  const { route, copy, routeAuditId } = taken;
  assert.ok(route && copy, 'both documents were taken');
  const observed = documentDifferences(route, copy);
  assert.deepEqual(unexplained(observed, namedDifferences(routeAuditId)), { extra: [], missing: [] });

  /* The named differences' values. */
  assert.deepEqual(route.omitted, [...copy.omitted, 'access_periods'], 'the route omits the agreement and says so');
  assert.deepEqual(copy.authority, {
    kind: 'owner_side',
    reasonCode: 'customer_instruction',
    instructionRef: taken.instructionRef,
    operatorUserId: ids.U_op,
  });
  assert.equal(route.authority, undefined);
  assert.equal(route.sections.access_periods.length, 0);
  assert.deepEqual(copy.sections.access_periods.map((p) => p.company_id), [A.id]);
  assert.ok(Date.parse(route.exportedAt) <= Date.parse(copy.exportedAt), 'the route was taken first');
  /* The section list, against the LIVE database's own list and not only 008's text (E7-10 reads 008 alone): the
     order the copy writes, and the module's list itself, which is the runtime half of E8W-F1. */
  const live = JSON.parse(sql('select array_to_json(app.export_section_names())'));
  assert.deepEqual(Object.keys(copy.sections), live, 'the copy writes the database’s sections in its order');
  assert.deepEqual([...SECTION_NAMES], live, 'the module’s list is the live database’s');
  console.log(
    `recorded, E8-4: ${observed.length} differences, all named; withheld ${JSON.stringify(route.withheld)}; exportedAt route ${JSON.stringify(route.exportedAt)} copy ${JSON.stringify(copy.exportedAt)}; counts route/copy ${['access_periods', 'candidate_versions', 'candidate_contributors', 'audit_events'].map((n) => `${n} ${route.counts[n]}/${copy.counts[n]}`).join(', ')}`,
  );

  /* Each hard feature, present where the contract puts it, so the empty comparison above is about THIS company. */
  const rowIn = (doc, section, key) => keyed(section, doc.sections[section]).get(key);
  for (const [label, doc] of [
    ['route', route],
    ['copy', copy],
  ]) {
    assert.equal(rowIn(doc, 'memberships', A.ms.leaver)?.status, 'removed', `${label}: the removed membership`);
    assert.equal(rowIn(doc, 'profiles', leaver.id)?.display_name, 'Leaver E8W', `${label}: the removed member’s profile`);
    assert.equal(rowIn(doc, 'candidate_versions', leaverSubmitted.candidateId)?.state, 'submitted', `${label}: the removed member’s submission`);
    assert.equal(rowIn(doc, 'agents', leaverSubmitted.agentId)?.status, 'orphaned', `${label}: the agent the removal orphaned`);
    assert.equal(rowIn(doc, 'installation_reports', leaverReport.reportId)?.membership_id, A.ms.leaver, `${label}: the removed member’s report`);
    assert.equal(rowIn(doc, 'installation_witnesses', witness.witness.witnessId)?.report_id, leaverReport.reportId, `${label}: its witness`);
    assert.ok(doc.sections.release_downloads.some((d) => d.membership_id === A.ms.leaver), `${label}: the removed member’s download`);
    assert.equal(rowIn(doc, 'releases', withdrawn.releaseId)?.state, 'withdrawn', `${label}: the withdrawn release`);
    assert.ok(doc.sections.release_downloads.some((d) => d.release_id === withdrawn.releaseId), `${label}: its ledger row`);
    const invitation = rowIn(doc, 'invitations', invitationId);
    assert.equal(invitation?.accepted_at, null, `${label}: the pending invitation`);
    assert.equal('token_hash' in invitation, false, `${label}: carries no token hash`);
    assert.equal(rowIn(doc, 'candidate_versions', adminDraft.candidateId)?.state, 'draft', `${label}: the admin’s own draft is not withheld`);
    assert.equal(doc.sections.group_members.some((g) => g.membership_id === A.ms.leaver), false, `${label}: the removal took the group row`);
  }
  for (const id of WITHHELD_DRAFTS) {
    assert.equal(rowIn(copy, 'candidate_versions', id)?.state, 'draft', 'the copy carries another author’s draft');
    assert.equal(rowIn(route, 'candidate_versions', id), undefined, 'the route withholds it');
  }
  assert.equal(rowIn(copy, 'candidate_versions', leaverDraft.candidateId).author_membership_id, A.ms.leaver, 'one of them is the removed member’s');
});

/* The fail-before's mutant: a copy of scripts/ and lib/ under .scratch/, with one replacement that must occur
   exactly once, so a replacement that matched nothing cannot produce a mutant identical to the real code. */
const MUTANT_DIR = join(ROOT, '.scratch', 'e8', 'mutant-e8w-dropped-section');
after(() => rmSync(MUTANT_DIR, { recursive: true, force: true }));
function mutantScripts(file, from, to) {
  rmSync(MUTANT_DIR, { recursive: true, force: true });
  mkdirSync(MUTANT_DIR, { recursive: true });
  cpSync(join(ROOT, 'lib'), join(MUTANT_DIR, 'lib'), { recursive: true });
  cpSync(join(ROOT, 'scripts'), join(MUTANT_DIR, 'scripts'), { recursive: true });
  const path = join(MUTANT_DIR, file);
  const text = readFileSync(path, 'utf8');
  assert.equal(text.split(from).length, 2, `the mutant's anchor occurs once in ${file}`);
  writeFileSync(path, text.replace(from, to));
  return join(MUTANT_DIR, 'scripts');
}

test('E8-4 fail-before: E7-10’s mutant, a section silently dropped from the script’s list, fails the comparison', async () => {
  const scriptsDir = mutantScripts(
    'lib/operator/takeout.mjs',
    '  ].map(Object.freeze),\n);',
    "  ].filter((s) => s.name !== 'installation_witnesses').map(Object.freeze),\n);",
  );
  /* A fresh route document, so the audit row the comparison names is this pair's. */
  const maxBefore = maxAuditId();
  const route = await R.takeout(A.adminHi, A.id);
  assert.equal(route.status, 200, route.raw);
  const routeAuditId = auditRowsAfter(maxBefore)[0].id;
  const routeFile = adminFile(route.body);
  const reg = register('mutant');
  const outPath = join(scratch('mutant-out'), 'copy.json');
  const m = run(
    'export-company.mjs',
    ['--company', A.id, '--operator', ids.U_op, '--instruction', `synthetic:e8-4-mutant-${RUN}`, '--out', outPath],
    reg.env,
    scriptsDir,
  );
  /* E8W-F1, paid by the lead (lib/operator/takeout.mjs completeness() reads the snapshot's keys): the script refuses
     the mutant itself, before any register line or audit row. The first version of this arm observed the defect
     (exit 0, a register line and an audit row claiming a complete copy); the fixed behaviour is asserted here and the
     old observation stays in evidence/e8-export-withholdings.md E8W-F1. */
  assert.equal(m.status, 1, `the mutant is refused by the script\n${m.output.slice(0, 600)}`);
  const incomplete = events(m, 'export_incomplete');
  assert.equal(incomplete.length, 1, 'one export_incomplete line');
  assert.equal(incomplete[0].section, 'installation_witnesses');
  assert.equal(incomplete[0].rule, 'the snapshot counted a section this document does not carry');
  assert.equal(events(m, 'export_done').length, 0, 'the mutant published nothing');
  assert.notEqual(registerLines(reg.path).at(-1).act, 'company.export', 'and registered no copy');
  assert.equal(existsSync(outPath), false, 'and left no file, partial or whole');
  assert.equal(
    auditRowsAfter(maxBefore).filter((a) => a.actor_kind === 'operator').length,
    0,
    'and wrote no operator audit row',
  );
  assert.ok(routeFile.sections.installation_witnesses.length > 0, 'and this company has rows in the dropped section');

  /* The control: the real script against the same route document passes the comparison; and the comparison itself
     still names a dropped section, shown on a copy with that section removed by hand, which is the design's stated
     fail-before for the comparison now that the script refuses to produce such a copy. */
  const realOut = join(scratch('control-out'), 'copy.json');
  const real = run(
    'export-company.mjs',
    ['--company', A.id, '--operator', ids.U_op, '--instruction', `synthetic:e8-4-control-${RUN}`, '--out', realOut],
    reg.env,
  );
  assert.equal(real.status, 0, real.output.slice(0, 600));
  const realCopy = JSON.parse(readFileSync(realOut, 'utf8'));
  assert.deepEqual(unexplained(documentDifferences(routeFile, realCopy), namedDifferences(routeAuditId)), { extra: [], missing: [] });
  const shortCopy = structuredClone(realCopy);
  delete shortCopy.sections.installation_witnesses;
  delete shortCopy.counts.installation_witnesses;
  const observed = documentDifferences(routeFile, shortCopy);
  const failure = caught('the comparison against a copy missing the section', () =>
    assert.deepEqual(unexplained(observed, namedDifferences(routeAuditId)), { extra: [], missing: [] }),
  );
  assert.deepEqual(unexplained(observed, namedDifferences(routeAuditId)), {
    extra: ['counts.installation_witnesses: route only', 'sections.installation_witnesses: route only'],
    missing: [],
  });
  assert.match(failure.message, /sections\.installation_witnesses: route only/);
});

test('E8-4: the comparison names every section dropped, every hard row filtered and one column changed (stack-free)', () => {
  const { route, copy, routeAuditId } = taken;
  assert.ok(route && copy, 'both documents were taken');
  const named = namedDifferences(routeAuditId);
  const fails = (label, mutate, side = 'copy') => {
    const r = structuredClone(route);
    const c = structuredClone(copy);
    mutate(side === 'copy' ? c : r);
    const u = unexplained(documentDifferences(r, c), named);
    assert.ok(u.extra.length + u.missing.length > 0, `${label}: the comparison did not notice`);
    return u;
  };
  /* Every one of the function's sections, dropped from the copy in turn. */
  for (const name of Object.keys(taken.countsBeforeRoute)) {
    const u = fails(`${name} dropped`, (c) => {
      delete c.sections[name];
      delete c.counts[name];
    });
    assert.ok(u.extra.includes(`sections.${name}: route only`), `${name}: ${JSON.stringify(u)}`);
  }
  const drop = (section, key) => (doc) => {
    const keyOf = ROW_KEY[section] ?? ((r) => r.id);
    const before = doc.sections[section].length;
    doc.sections[section] = doc.sections[section].filter((row) => keyOf(row) !== key);
    assert.equal(doc.sections[section].length, before - 1, `${section}[${key}] was there to drop`);
    doc.counts[section] -= 1;
  };
  /* Each hard feature's row, filtered from the COPY, as a script that followed the route's rules would. A row both
     documents carry becomes the route's alone; a row only the copy carries leaves a named difference unmet. */
  for (const [section, key, found] of [
    ['memberships', A.ms.leaver, 'extra'],
    ['profiles', leaver.id, 'extra'],
    ['releases', withdrawn.releaseId, 'extra'],
    ['invitations', invitationId, 'extra'],
    ['installation_reports', leaverReport.reportId, 'extra'],
    ['candidate_versions', secondDraft.candidateId, 'missing'],
    ['candidate_versions', leaverDraft.candidateId, 'missing'],
    ['access_periods', A.id, 'missing'],
  ]) {
    const u = fails(`${section}[${key}] filtered from the copy`, drop(section, key));
    const entry = found === 'extra' ? `sections.${section}[${key}]: route only` : `sections.${section}[${key}]: copy only`;
    assert.ok(u[found].includes(entry), `${section}[${key}]: ${JSON.stringify(u)}`);
  }
  /* And from the ROUTE, as a route that silently dropped a removed member or a withdrawn release would. */
  for (const [section, key] of [
    ['memberships', A.ms.leaver],
    ['releases', withdrawn.releaseId],
    ['invitations', invitationId],
    ['candidate_versions', adminDraft.candidateId],
  ]) {
    const u = fails(`${section}[${key}] filtered from the route`, drop(section, key), 'route');
    assert.ok(u.extra.includes(`sections.${section}[${key}]: copy only`), JSON.stringify(u));
  }
  /* One column of one row. */
  const u = fails('the withdrawn release read as published', (c) => {
    c.sections.releases.find((x) => x.id === withdrawn.releaseId).state = 'published';
  });
  assert.deepEqual(u, { extra: [`sections.releases[${withdrawn.releaseId}].state: differs`], missing: [] });
});
