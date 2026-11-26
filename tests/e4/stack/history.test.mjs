/* The review read's agent history against the running local stack (E4S-C-F1, evidence/e4-server-critique.md): the
   history is complete up to HISTORY_ROWS distinct (membership, kind) rows and refuses E_READ_OVER_BOUND above them.
   PostgREST caps every answer at max_rows (200, supabase/config.toml), so a single read with limit 201 can never carry
   the sentinel row the ceiling once rested on; the rows must be paged. Reseeds once through tests/db/00-seed.sh and
   builds its own users and company. Run one file at a time: node --test --test-concurrency=1 tests/e4/stack/ */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { e4routes, e4world, enableTargets, key, reseed, reviewCompany, sql, submitted } from './helpers.mjs';

const HISTORY_ROWS = 200;
const PER_DRAFT = 50;

const ids = reseed();
enableTargets();
const R = await e4routes();
const W = e4world('history', ids);
const C = await reviewCompany(W, R, 'h');

/** `n` fresh members of C with no other role, inserted owner-side; their membership ids. */
function members(n, tag) {
  const memberships = Array.from({ length: n }, () => key());
  const users = memberships.map(() => key());
  sql(
    `insert into auth.users(id,email) values ${users.map((u, i) => `('${u}','e4-history-${tag}-${i}-${W.run}@example.invalid')`).join(',')};
     insert into app.memberships(id,company_id,user_id,roles) values ${memberships.map((m, i) => `('${m}','${C.id}','${users[i]}','{member}')`).join(',')}`,
  );
  return memberships;
}

/** One declared_member row per membership on a fresh draft of the agent, at most PER_DRAFT per draft. */
async function declare(agentId, memberships) {
  for (let i = 0; i < memberships.length; i += PER_DRAFT) {
    const slice = memberships.slice(i, i + PER_DRAFT);
    const d = await R.create(C.author, C.id, { agentId });
    assert.equal(d.status, 201, d.raw);
    sql(
      `insert into app.candidate_contributors(candidate_id,membership_id,kind,observed) values ${slice.map((m) => `('${d.body.candidateId}','${m}','declared_member',false)`).join(',')}`,
    );
  }
}

test('the agent history is complete at HISTORY_ROWS rows and refuses one above it (E4S-C-F1)', async () => {
  const hc = await submitted(R, C);
  const rows = () => Number(sql(`select count(*) from app.agent_contributor_memberships('${hc.agentId}')`));
  const own = rows();
  assert.ok(own >= 1 && own < HISTORY_ROWS, `the author's own rows: ${own}`);

  const declared = members(HISTORY_ROWS - own, 'fill');
  await declare(hc.agentId, declared);
  assert.equal(rows(), HISTORY_ROWS, 'the history holds exactly HISTORY_ROWS rows');

  const full = await R.reviewRead(C.author, hc.candidateId);
  assert.equal(full.status, 200, full.raw);
  const listed = new Set(full.body.agentHistory.contributorMembershipIds);
  const missing = declared.filter((m) => !listed.has(m));
  assert.deepEqual(missing, [], `every declared member is in the history (${missing.length} missing of ${declared.length})`);
  assert.ok(listed.has(C.ms.author), 'the author is in the history');

  await declare(hc.agentId, members(1, 'over'));
  assert.equal(rows(), HISTORY_ROWS + 1);
  const over = await R.reviewRead(C.author, hc.candidateId);
  assert.deepEqual([over.status, over.body?.code], [500, 'E_READ_OVER_BOUND'], 'the read above HISTORY_ROWS refuses');
  assert.deepEqual(Object.keys(over.body).sort(), ['code', 'message', 'ok'], 'no database details forwarded');
});
