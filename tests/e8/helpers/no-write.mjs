/* E8-9's contract as one helper (docs/e8/design.md 2.3 row E8-9 and 2.4): the before-and-after counts of
   `app.audit_events`, every other `app` content table and the register file, taken around a block and asserted
   unchanged. Day 2 owns this file; days 3 and 5 import it and apply it to their own cases, which is how E8-9 is
   carried across the package rather than written once in one file (E8D-R-F15).

   HOW THE TABLE LIST IS OBTAINED. It is read from the catalogue at snapshot time, not copied into this file:
   every base table of schema `app`, whatever they are on the revision under test. Design 7.3 scenario 2 asks for
   exactly this property ("written against table names, so a renamed table breaks them loudly"), and a table added
   by a later migration joins the contract with no edit here. One statement does all of it through
   `query_to_xml`, so a snapshot is ONE psql call and not one per table: a per-table call would put twenty-seven
   container round trips on both sides of every wrapped block.

   WHAT IS COUNTED, AND WHAT IS NOT.
     - every `app` base table, by name, including `app.audit_events` (the row E8-1's "no audit row" is about) and
       `app.idempotency_keys` (a bound write that refuses must leave no key behind);
     - `auth.users`, because a refused invitation or accept path must not create an account;
     - the register file named by ENTERPRISE_REGISTER_PATH, its line count and its head file, or the word `absent`
       when the variable is unset, which is the state every stack case in this package runs in. A wrapped block
       that is expected to write no register line therefore asserts that none appeared AND that none was
       configured into existence.
   NOT counted: `auth.sessions` and `auth.refresh_tokens`. GoTrue writes both on its own schedule (a refresh, a
   session touch), so a count of them around a block would fail for reasons that are not the block's; the E2
   design's section 5 says what a session row does and does not mean. A case that needs them asserts them itself.
   NOT counted either: the alert sink, which is not storage. A route's alerts are captured through `deps.alert` by
   the caller, and each of this day's cases asserts its own capture empty; the design's "no alert" clause is
   therefore in the case, not in this helper, because this helper holds no route table.

   THE LIMIT OF A COUNT, AND THE CONTENT OPTION (B12-R-F1, the batched review of days 1 and 2, added by day 3).
   A row count cannot see an IN-PLACE UPDATE. A block that rewrote a company's name, a membership's roles or a
   ledger row's timestamp and inserted nothing would leave every count in this file unchanged and pass. That is
   not a theoretical gap for this package: three of the four writes 001 grants `app_maintenance` are UPDATEs, and
   E8-8's result sentence is "no path deletes OR REWRITES it". So every caller must decide which of the two its
   claim needs, and say so in its report:
     - `noWrite(label, block)` alone asserts that NOTHING WAS ADDED OR REMOVED. That is the whole claim for a
       refusal that could only have inserted (an audit row, an invitation, an account);
     - `noWrite(label, block, { content: ['releases', 'companies', ...] })` additionally takes an MD5 over every
       row of each named table, cast to text, so an in-place update of any column of any row of those tables is
       caught. A case whose claim is "unchanged" and not merely "none added" names its tables here.
   The list is per caller and not global on purpose: the digest reads every row of a named table, where the count
   does not, so making it the default would put the cost of the largest table on every wrapped block in the
   package. `contentDigestOf()` below is the extension's own fail-before: an owner-side in-place update that moves
   no count and is caught by the digest, asserted in tests/e8/stack/maintenance.test.mjs.

   THE HELPER'S OWN FAIL-BEFORE (design 2.3 row E8-9): `writeOneAuditRow()` below is an asserted block that
   writes exactly one audit row. tests/e8/stack/tenancy-sweep.test.mjs passes it to noWrite() and asserts that the
   call throws, with `audit_events` named in the message. Without that case the helper could count nothing and
   every wrapped block would pass. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { sql, stackEnv } from '../../e2/helpers/stack.mjs';

export const REGISTER_ENV = 'ENTERPRISE_REGISTER_PATH';

/* One statement, one round trip: `name=count` per line, the `app` tables in name order and then auth.users.
   query_to_xml runs the count for each table found in pg_class, so the list is the catalogue's and not this
   file's. relkind 'r' is an ordinary table: a view holds no rows of its own and a partition would be counted
   through its parent. */
const COUNTS_SQL = `
select string_agg(line, E'\\n' order by line) from (
  select 'app.' || c.relname || '=' ||
         (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from app.%I', c.relname), false, true, '')))[1]::text
         as line
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'app' and c.relkind = 'r'
  union all
  select 'auth.users=' || (select count(*) from auth.users)::text
) rows`;

/* WHY THIS DOES NOT USE tests/e2/helpers/stack.mjs's sql() FOR THE COUNTS. That helper runs the statement through
   `bash -c 'source tests/db/lib.sh'`, and lib.sh runs `supabase status -o env` when it is sourced: measured at 595
   to 812 ms per call on this machine. This contract is taken TWICE around every wrapped block and once per route in
   the sweep, so that cost is the whole cost of the case. The counts therefore go straight to the project's own
   database container, named from supabase/config.toml's project_id by stackEnv(), which is where lib.sh sends them
   too and which tests/e2/helpers/stack.mjs psqlSession() already opens the same way. No key is read or printed:
   `psql -U postgres` inside the container needs none. Everything else here keeps sql(), because it runs once.
   Measured after the change: 95 to 130 ms per snapshot. */
function ownerRead(statement) {
  const { dbContainer } = stackEnv();
  const r = spawnSync('docker', ['exec', '-i', dbContainer, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`no-write: the count statement failed (exit ${r.status}): ${(r.stderr ?? '').slice(0, 300)}`);
  return (r.stdout ?? '').trim();
}

/** The register file's state: its line count and its anchored head, or `absent` when no path is configured. */
export function registerState() {
  const path = process.env[REGISTER_ENV];
  if (typeof path !== 'string' || path.length === 0) return 'absent';
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0;
  const head = existsSync(`${path}.head`) ? readFileSync(`${path}.head`, 'utf8').trim() : 'none';
  return `lines=${lines} head=${head}`;
}

const TABLE_NAME = /^[a-z][a-z0-9_]*$/;

/* One MD5 over every row of a named table, cast to text, so an UPDATE of any column of any row moves it where a
   count does not. Ordered by the row text itself, so the digest does not depend on physical order, which an
   UPDATE changes on its own. An empty table digests to the word `empty` rather than to null. */
const contentSql = (tables) =>
  tables
    .map(
      (t) =>
        `select 'content:app.${t}=' || coalesce(md5(string_agg(x, '|' order by x)), 'empty') from (select t::text as x from app.${t} t) s`,
    )
    .join('\nunion all\n');

/**
 * snapshot({ content }) -> { counts: Map<string, string>, register: string }
 * Every counted name with its count as text, plus a `content:app.<table>` digest for each table named in
 * `content`, plus the register file's state. One psql call whether or not `content` is given.
 */
export function snapshot({ content = [] } = {}) {
  for (const t of content)
    if (!TABLE_NAME.test(t)) throw new Error(`no-write: ${JSON.stringify(t)} is not an app table name`);
  const statement =
    content.length === 0 ? COUNTS_SQL : `${COUNTS_SQL.replace(/\) rows$/, '')}\nunion all\n${contentSql(content)}\n) rows`;
  const counts = new Map();
  for (const line of ownerRead(statement).split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) counts.set(line.slice(0, at), line.slice(at + 1));
  }
  if (counts.size === 0) throw new Error('no-write: the count statement returned nothing');
  for (const t of content)
    if (!counts.has(`content:app.${t}`)) throw new Error(`no-write: no content digest came back for app.${t}`);
  return { counts, register: registerState() };
}

/** One table's content digest, for a case that wants to show what the count cannot see. */
export function contentDigestOf(table) {
  return snapshot({ content: [table] }).counts.get(`content:app.${table}`);
}

/**
 * difference(before, after) -> string[]
 * One entry per name whose count moved, per name that appeared or vanished, and for the register file.
 * An empty array is the pass.
 */
export function difference(before, after) {
  const moved = [];
  for (const [name, n] of before.counts) {
    if (!after.counts.has(name)) moved.push(`${name}: the table is gone (was ${n})`);
    else if (after.counts.get(name) !== n)
      moved.push(
        name.startsWith('content:')
          ? `${name}: the rows changed in place (${n.slice(0, 8)} -> ${after.counts.get(name).slice(0, 8)}), which no count would have shown`
          : `${name}: ${n} -> ${after.counts.get(name)}`,
      );
  }
  for (const [name, n] of after.counts) if (!before.counts.has(name)) moved.push(`${name}: new table (${n})`);
  if (before.register !== after.register) moved.push(`register: ${before.register} -> ${after.register}`);
  return moved;
}

/** Throws with every moved name in the message when anything moved between the two snapshots. */
export function assertUnchanged(label, before, after) {
  const moved = difference(before, after);
  assert.deepEqual(moved, [], `${label}: these wrote something\n  ${moved.join('\n  ')}`);
}

/**
 * noWrite(label, block) -> the block's value
 * Snapshot, run the block, snapshot again, assert nothing moved. The block's own rejection is left to propagate
 * before the second snapshot is taken, because a block that threw was not the block the caller asserted about.
 */
export async function noWrite(label, block, options = {}) {
  const before = snapshot(options);
  const value = await block();
  assertUnchanged(label, before, snapshot(options));
  return value;
}

/**
 * The row writeOneAuditRow() wrote, removed again, so the counterexample leaves the file's later cases alone.
 * `app.audit_events` is append-only to the owner too (trigger `audit_append_only`, E_AUDIT_APPEND_ONLY), so the
 * trigger is disabled inside one owner transaction for the delete and enabled again in it, which is the technique
 * tests/e5/stack/helpers.mjs `ageLedger` already uses on the download ledger's append-only trigger and the one
 * thing only the migration owner can do. Nothing in the product has this power.
 */
export function deleteAuditRow(id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`no-write: ${JSON.stringify(id)} is not an audit row id`);
  sql(`begin;
    alter table app.audit_events disable trigger audit_append_only;
    delete from app.audit_events where id = ${n};
    alter table app.audit_events enable trigger audit_append_only;
    commit;`);
}

/**
 * The helper's own counterexample (design 2.3 row E8-9): a block that writes exactly one audit row, so that
 * noWrite() can be shown to fail at the assertion rather than trusted to count. Owner-side, because no route is
 * needed to prove that the counter counts. Returns the id it wrote.
 */
export function writeOneAuditRow() {
  /* psql -At still prints the command tag for an INSERT, so the id is the first line and not the whole output. */
  return sql(
    `insert into app.audit_events (company_id, actor_kind, action, entity_type, details)
     values (null, 'system', 'enterprise_test.no_write_fail_before', 'e8_fail_before', '{}'::jsonb) returning id`,
  ).split('\n')[0];
}
