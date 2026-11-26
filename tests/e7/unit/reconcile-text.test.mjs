/* E7 design 1.3 and section 5 case E7-27: C3's statement list pinned to the CURRENT api.remove_member, read out
   of the migrations. No stack.

   WHY A PIN AND NOT A CALL. The reconciler cannot call api.remove_member: that routine takes an administrator OF
   THE COMPANY as its actor and must not be impersonated, because the audit trail would then say a customer's
   administrator removed someone at restore time, which is false. So C3 carries the routine's own writes, and a
   later change to what a removal DOES would silently leave the reconciler behind: a membership removed at a
   recovery keeping group rows that the product's own removal clears, which under E4's dynamic audience is a grant
   no administrator made. 006 already made exactly that change once (it added the group-row delete to 003's body,
   E4's A5), which is why this file exists and what its fail-before re-runs.

   THE PARSER IS THIS FILE'S OWN, written against the migration text from the outside; it does not import anything
   the module builds its statements with. Its own correctness is asserted first: it must find three writes and
   three audit actions in the current body and two of each in 003's.

   THE FAIL-BEFORE is 003's body handed to the same comparison as the latest: C3 then has a write and an audit row
   the routine does not, and the pin fails. That is the drift 006 would have caused had C3 been written against
   003 and nobody looked again. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { checkBody, fold, serialize, sha256, ZERO_PREV } = await import('../../../lib/operator/register.mjs');
const { foldToPlan, transactionSql } = await import('../../../lib/operator/reconcile.mjs');

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MIGRATIONS = join(REPO, 'supabase/migrations');
const ROUTINE = 'api.remove_member';

/* ---------------------------------------------------------------------------
   The routine's text, and the writes and audit rows in it.
   --------------------------------------------------------------------------- */

/** Every migration that defines the routine, in migration order. The LAST definition of the LAST one is current. */
function definitions() {
  const found = [];
  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (!file.endsWith('.sql')) continue;
    const text = readFileSync(join(MIGRATIONS, file), 'utf8');
    const at = text.lastIndexOf(`create or replace function ${ROUTINE}(`);
    if (at < 0) continue;
    const open = text.indexOf('$$', at);
    found.push({ file, body: text.slice(at, text.indexOf('$$;', open + 2) + 3) });
  }
  return found;
}

const flat = (text) =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join(' ')
    .replace(/\s+/g, ' ');

/** Every write against an `app.` table, in the order the text makes it: { verb, table, columns }. */
function writesIn(body) {
  const text = flat(body);
  const out = [];
  const pattern = /\b(update|delete from|insert into)\s+(app\.[a-z_]+)/g;
  for (const m of text.matchAll(pattern)) {
    const verb = m[1] === 'delete from' ? 'delete' : m[1] === 'insert into' ? 'insert' : 'update';
    const entry = { verb, table: m[2], columns: [] };
    if (verb === 'update') {
      const from = text.indexOf(' set ', m.index + m[0].length);
      const to = text.indexOf(' where ', from);
      entry.columns = text
        .slice(from + 5, to)
        .split(',')
        .map((part) => part.split('=')[0].trim().replace(/^[a-z]+\./, ''))
        .filter(Boolean)
        .sort();
    }
    out.push(entry);
  }
  return out;
}

/** Every audit action the text writes, in order. */
const auditsIn = (body) => [...flat(body).matchAll(/app\.audit\([^)]*?'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]);

/** Every row lock the text takes, in order, as the table it locks. */
function locksIn(body) {
  const text = flat(body);
  const out = [];
  for (const m of text.matchAll(/\bfor (?:no key )?update\b/g)) {
    const before = text.slice(0, m.index);
    const table = [...before.matchAll(/\b(?:from|join)\s+(app\.[a-z_]+)/g)].at(-1);
    if (table) out.push(table[1]);
  }
  return out;
}

/* ---------------------------------------------------------------------------
   C3, as the plan builds it.
   --------------------------------------------------------------------------- */

const OP = '00000000-0000-4000-9000-000000000001';
const COMPANY = '11111111-1111-4111-8111-111111111111';
const M = 'aaaaaaaa-0000-4000-8000-000000000001';
const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000002';

/** C3's own statements, taken from the plan and not from a private helper, so what is pinned is what runs. */
function c3Sql() {
  const lines = [];
  let prev = ZERO_PREV;
  let seq = 0;
  const push = (act, body = {}) => {
    checkBody(act, body);
    const raw = serialize({ seq, epoch: 0, at: new Date(Date.UTC(2026, 8, 1, seq)).toISOString(), act, prev, ...body });
    lines.push(JSON.parse(raw));
    prev = sha256(raw);
    seq += 1;
  };
  push('register.open');
  push('membership.remove', { companyId: COMPANY, membershipId: M, auditId: 11, actor: OP });
  push('register.sync', { watermarkAuditId: 11, watermarkAt: new Date(Date.UTC(2026, 8, 2)).toISOString() });
  push('restore.begin', { backupAt: new Date(Date.UTC(2026, 8, 1)).toISOString(), auditFloor: 100, actor: OP });
  const plan = foldToPlan(
    fold(lines),
    {
      companies: [
        {
          id: COMPANY,
          slug: 'company-a',
          status: 'held',
          holdStatusBefore: 'active',
          period: null,
          memberships: [
            { id: M, userId: 'bbbbbbbb-0000-4000-8000-000000000001', status: 'active', roles: ['member'] },
            {
              id: ADMIN,
              userId: 'bbbbbbbb-0000-4000-8000-000000000002',
              status: 'active',
              roles: ['member', 'company_admin'],
            },
          ],
          releases: [],
          invitationsPending: [],
        },
      ],
      factors: [],
      accounts: [],
    },
    { operator: OP },
  );
  const c3 = plan.companies[0].corrections.find((c) => c.id === 'C3');
  assert.ok(c3, 'the plan holds C3');
  return transactionSql(c3);
}

/* ---------------------------------------------------------------------------
   The cases.
   --------------------------------------------------------------------------- */

test('E7-27: the parser finds what it is supposed to, in the current body and in 003’s', () => {
  const defs = definitions();
  assert.deepEqual(
    defs.map((d) => d.file),
    ['001_identity.sql', '003_content.sql', '006_reviews_releases.sql', '011_invitation_standing.sql'],
    'the routine is defined in these migrations and the last one is current',
  );
  const current = defs.at(-1);
  assert.deepEqual(
    writesIn(current.body).map((w) => `${w.verb} ${w.table}`),
    ['update app.memberships', 'delete app.group_members', 'update app.agents'],
  );
  assert.deepEqual(auditsIn(current.body), ['membership.remove', 'group.remove_member', 'agent.orphan']);
  const older = defs.find((d) => d.file === '003_content.sql');
  assert.deepEqual(
    writesIn(older.body).map((w) => `${w.verb} ${w.table}`),
    ['update app.memberships', 'update app.agents'],
    '003 clears no group rows, which is the change 006 made',
  );
});

test('E7-27: C3 writes exactly the tables the current api.remove_member writes, in its order', () => {
  const routine = writesIn(definitions().at(-1).body);
  const mine = writesIn(c3Sql());
  assert.deepEqual(
    mine.map((w) => `${w.verb} ${w.table}`),
    routine.map((w) => `${w.verb} ${w.table}`),
    'the same three writes, in the same order, and nothing else against an app table',
  );
  for (let i = 0; i < routine.length; i++)
    assert.deepEqual(mine[i].columns, routine[i].columns, `${routine[i].table}: the same columns are set`);
});

test('E7-27: C3 writes exactly the audit rows the routine writes, in its order', () => {
  assert.deepEqual(auditsIn(c3Sql()), auditsIn(definitions().at(-1).body));
});

test('E7-27: C3 takes the routine’s row locks, in design 2.5’s order, with one named difference', () => {
  const routine = locksIn(definitions().at(-1).body);
  const mine = locksIn(c3Sql());
  assert.deepEqual(routine, ['app.memberships', 'app.group_members', 'app.agents']);
  /* THE NAMED DIFFERENCE, asserted so that a change in either direction fails here. The routine locks the
     membership row and re-reads it to re-check its status; C3 holds the COMPANY row lock (which the routine takes
     through app.lock_company before any of this) and makes the same check the predicate of its own update, whose
     row lock is the same lock. So C3's explicit locks are the two collection locks, in the routine's order. */
  assert.deepEqual(mine, ['app.companies', 'app.group_members', 'app.agents']);
  assert.match(c3Sql(), /update app\.memberships set .* where id = '[0-9a-f-]{36}' and status = 'active'/);
});

test('E7-27, FAIL-BEFORE: with 003’s body as the latest, C3 has a write and an audit row the routine does not', () => {
  const older = definitions().find((d) => d.file === '003_content.sql').body;
  const mine = c3Sql();
  /* The same two comparisons the two cases above make, against 003 instead of the current body. Each must fail. */
  assert.throws(
    () =>
      assert.deepEqual(
        writesIn(mine).map((w) => `${w.verb} ${w.table}`),
        writesIn(older).map((w) => `${w.verb} ${w.table}`),
      ),
    /group_members/,
    'the write pin fails against 003',
  );
  assert.throws(() => assert.deepEqual(auditsIn(mine), auditsIn(older)), /group\.remove_member/, 'and so does the audit pin');
});

/* THE SECOND NAMED DIFFERENCE (011, END-1). The routine revokes the removed member's pending issued invitations through
   one helper call, which this parser does not read as a write: the helper is the statement, so the case names it.
   C3 does not mirror it, because C5 revokes EVERY pending invitation of the restored company (one transaction each,
   whatever the register says), so no invitation the removed issuer made survives the restore. A routine that stops
   calling the helper, or a C3 that starts revoking, fails here. */
test('E7-27: the routine revokes the issuer s pending invitations through one helper, which C3 leaves to C5', () => {
  const current = definitions().at(-1).body;
  assert.match(
    current,
    /perform app\.revoke_issued_invitations\(target\.company_id, target\.id, actor, admin\.id, 'issuer_removed'\);/,
  );
  assert.equal(/revoke_issued_invitations|app\.invitations/.test(c3Sql()), false, 'C3 revokes no invitation');
  const reconcile = readFileSync(join(REPO, 'lib/operator/reconcile.mjs'), 'utf8');
  assert.match(reconcile, /for \(const invitationId of row\.invitationsPending\)/, 'C5 walks every pending invitation');
});

test('E7-27: and the routine C3 mirrors is still the one this pin reads', () => {
  const current = definitions().at(-1);
  assert.match(current.body, /perform app\.lock_company\(target\.company_id\)/, 'it takes the company lock first');
  assert.match(current.body, /E_LAST_ADMIN/, 'and it has the last-administrator rule C3’s refusal mirrors');
});
