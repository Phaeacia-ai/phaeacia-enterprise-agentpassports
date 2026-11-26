/* Migration 006 part B's text against the design and the code it must agree with, no stack (E4 design 2.3 part B, 2.4,
   2.5 and 3.5). The behaviour is probes 22 to 25; this holds what text can hold:
   - each of the four routines meets its refusals, locks, claim lookup and change in 3.5's row order and 2.5's lock order;
   - api.record_review reads the agent-wide exclusion set under the company lock and before the claim lookup (1.2, row 22);
   - api.publish_release repeats the size arithmetic after the role and state preconditions and before replace (1.3);
   - api.withdraw_release takes the release row FOR UPDATE, then updates, then reads the ledger in a later statement (1.4);
   - every audit row part B writes carries exactly the keys of 2.4, and each key is one A8's guard admits;
   - the binding lists of lib/db/server.mjs are the four signatures in order, and the operation lists design 2.6 item 1's;
   - EXECUTE on the four routines is app_server's alone; the RLS doors are authenticated's; release_recipients is VOLATILE. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.SUPABASE_URL ??= 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY ??= 'unit';
const { BOUND, bindCall } = await import('../../../lib/db/server.mjs');

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const M006 = readFileSync(join(REPO, 'supabase/migrations/006_reviews_releases.sql'), 'utf8');
const PART_B = M006.slice(M006.indexOf('-- Part B. E4 itself'));

function definitionOf(source, name) {
  const start = source.lastIndexOf(`create or replace function ${name}(`);
  if (start < 0) return null;
  const open = source.indexOf('$$', start);
  return source.slice(start, source.indexOf('$$;', open + 2) + 3);
}

/* Each anchor must occur after the one before it; the first missing or out-of-order anchor is reported. */
function inOrder(def, anchors) {
  let at = -1;
  for (const anchor of anchors) {
    const next = def.indexOf(anchor, at + 1);
    if (next < 0) return `missing or out of order: ${anchor}`;
    at = next;
  }
  return null;
}

const ORDER = {
  'api.create_envelope': [
    "raise exception 'E_BODY_INVALID'", // row 16
    'audience := app.audience_group_ids(p_audience_canonical);', // row 16, the canonical audience
    "raise exception 'E_NOT_FOUND'", // row 17
    'perform app.require_standing(company, actor);',
    'from app.groups g where g.id = any (audience)', // row 18, before any lock
    'perform app.lock_company(company);', // rows 19 and 20
    'for update;', // 2.5 level 5
    'if not app.candidate_visible_to(p_candidate, actor) then', // row 21
    "app.idempotency_lookup(member_id, p_idempotency_key, 'create_envelope', operation)", // rows 22 to 24
    'perform app.idempotency_ceiling(member_id);', // row 25
    "'E_NOT_REVIEWABLE'", // row 26
    "'E_POLICY_CHANGED'", // row 27
    'gate := app.active_gate(p_gate_identity);', // row 28
    "'E_INSTALLER_UNREGISTERED'", // row 29
    "'E_ASSEMBLY_TOO_LARGE'", // row 29a
    "jsonb_build_object('existing', true)", // row 30
    "'E_ENVELOPE_LIMIT'", // row 31
    'insert into app.review_envelopes',
    "'envelope.create'",
    "app.idempotency_claim(member_id, p_idempotency_key, 'create_envelope', operation, result)",
  ],
  'api.record_review': [
    "raise exception 'E_BODY_INVALID'", // row 16
    'v_reason := app.review_reason(p_reason);',
    "raise exception 'E_NOT_FOUND'", // row 17
    'perform app.require_standing(company, actor);',
    'perform app.lock_company(company);', // rows 18 and 19
    'for update;',
    'if not app.candidate_visible_to(p_candidate, actor) then', // row 20
    "'E_ROLE_REQUIRED'", // row 21
    'from app.candidate_contributors k where k.candidate_id = p_candidate', // row 22, the candidate's own rows, under the lock
    "'E_REVIEWER_IS_CONTRIBUTOR'",
    'app.idempotency_lookup(reviewer.id', // rows 23 to 25
    'perform app.idempotency_ceiling(reviewer.id);', // row 26
    "'E_NOT_REVIEWABLE'", // row 27
    "'E_ENVELOPE_REQUIRED'", // row 28
    "'E_ENVELOPE_CLOSED'", // row 29
    "'E_ENVELOPE_APPROVED'", // row 30
    "'E_ALREADY_SIGNED'", // row 31
    'gate := app.active_gate(p_gate_identity);', // row 32
    "'E_ADAPTER_CHANGED'", // row 33
    "'E_POLICY_CHANGED'", // row 34
    'insert into app.reviews',
    "'review.record'",
    "app.idempotency_claim(reviewer.id, p_idempotency_key, 'record_review', operation, result)",
  ],
  'api.publish_release': [
    "raise exception 'E_BODY_INVALID'", // row 16
    "raise exception 'E_NOT_FOUND'", // row 17
    'perform app.require_standing(company, actor);',
    'perform app.lock_company(company);', // rows 18 and 19
    'admin := app.require_admin(company, actor);', // rows 20 and 21
    'from app.agents g', // 2.5 level 4
    'order by v.id for update;', // level 5
    'order by r.id for update;', // level 6
    'app.idempotency_lookup(admin.id', // rows 22 to 24
    'perform app.idempotency_ceiling(admin.id);', // row 25
    "'E_CANDIDATE_SUPERSEDED'", // row 26
    "'E_NOT_APPROVED'",
    "'E_ENVELOPE_NOT_APPROVED'", // row 27
    "'E_AGENT_ORPHANED'", // row 28
    "'E_AGENT_ARCHIVED'",
    'v.sequence > cand_sequence', // row 29
    "'E_TARGET_NOT_PUBLISHABLE'", // row 30
    'gate := app.active_gate(p_gate_identity);', // row 31
    "'E_ADAPTER_CHANGED'", // row 32
    "'E_POLICY_CHANGED'", // row 33
    "'E_INSTALLER_UNREGISTERED'", // row 34
    "'E_ASSEMBLY_DIVERGED'", // row 35
    "jsonb_build_object('existing', true", // row 36
    "'E_ASSEMBLY_TOO_LARGE'", // 1.3: the arithmetic under the locks
    'replace(v.content, app.installer_placeholder(), ins.text)',
    'if assembled_hash is distinct from p_expected_assembled_sha256 then', // row 37
    'update app.releases r set superseded_by_release_id = new_release', // rules 1 and 2
    "update app.candidate_versions v set state = 'superseded'", // rule 4
    'insert into app.releases',
    "'release.publish'",
    "'release.supersede'",
    "'candidate.supersede'",
    "app.idempotency_claim(admin.id, p_idempotency_key, 'publish_release', operation, result)",
  ],
  'api.withdraw_release': [
    "raise exception 'E_BODY_INVALID'", // row 14
    'v_reason := app.review_reason(p_reason);',
    "raise exception 'E_NOT_FOUND'", // row 15
    'perform app.require_standing(company, actor);',
    'perform app.lock_company(company);', // rows 16 and 17
    'from app.releases r where r.id = p_release for update;', // the linearization point
    'if not app.release_visible_to(p_release, actor) then', // row 18
    'if agent_owner is distinct from member_id then', // rows 19 and 20
    'perform app.require_admin(company, actor);',
    'app.idempotency_lookup(member_id', // rows 21 to 23
    'perform app.idempotency_ceiling(member_id);', // row 24
    "'E_ALREADY_WITHDRAWN'", // row 25
    'update app.releases r',
    'recipients := app.release_recipients(p_release);', // a later statement
    "'release.withdraw'",
    "app.idempotency_claim(member_id, p_idempotency_key, 'withdraw_release', operation, result)",
  ],
};

for (const [name, anchors] of Object.entries(ORDER)) {
  test(`${name} meets design 3.5 s refusals and 2.5 s locks in their order`, () => {
    const def = definitionOf(M006, name);
    assert.ok(def, `${name} is defined`);
    assert.equal(inOrder(def, anchors), null);
  });
}

test('control: the order check reports a swapped pair and a missing anchor', () => {
  assert.equal(inOrder('a b c', ['a', 'b', 'c']), null);
  assert.match(inOrder('a c b', ['a', 'b', 'c']), /out of order: c/);
  assert.match(inOrder('a b', ['a', 'x']), /missing or out of order: x/);
});

test('1.2 row 22 (Q5 as answered 2026-09-15): the routine reads the candidate s own rows; the agent-wide set is history', () => {
  const routine = definitionOf(M006, 'api.record_review');
  assert.match(
    routine,
    /if exists \(select 1 from app\.candidate_contributors k where k\.candidate_id = p_candidate and k\.membership_id is not null and k\.membership_id = reviewer\.id\) then\s+raise exception 'E_REVIEWER_IS_CONTRIBUTOR'/,
  );
  const code = routine.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(code, /agent_contributor_memberships|agent_reviewer_exclusions|cand_agent\) x/, 'no agent-wide read at row 22');
  /* The history the page reads keeps its shape: every candidate row of the agent, membership ids and kinds only. */
  const set = definitionOf(M006, 'app.agent_contributor_memberships');
  assert.match(set, /from app\.candidate_versions v\s+join app\.candidate_contributors k on k\.candidate_id = v\.id\s+where v\.agent_id = p_agent/);
  assert.doesNotMatch(set, /v\.id = /, 'no candidate filter');
  const door = definitionOf(M006, 'app.agent_reviewer_exclusions');
  assert.match(door, /app\.is_active_member\(a\.company_id\)/);
  assert.match(PART_B, /create view api\.agent_reviewer_exclusions with \(security_invoker = true\) as\s+select a\.id as agent_id, x\.membership_id, x\.kind/);
});

test('1.3: the size arithmetic runs after the role and state preconditions and before replace, in the routine and the trigger', () => {
  const pub = definitionOf(M006, 'api.publish_release');
  const arithmetic = pub.indexOf('app.assembled_bytes(v.content, ins.text)');
  assert.ok(pub.indexOf('app.require_admin') < arithmetic && arithmetic < pub.indexOf('replace(v.content'));
  const trigger = definitionOf(M006, 'app.release_identity');
  assert.ok(trigger.indexOf('app.assembled_bytes(cand_content, ins_text)') < trigger.indexOf('replace(cand_content'));
  const env = definitionOf(M006, 'app.envelope_identity');
  assert.match(env, /projected := app\.assembled_bytes\(cand\.content, ins\.text\);/);
  assert.match(env, /new\.assembled_bytes := projected;/);
  assert.ok(env.indexOf('new.assembled_bytes := projected;') < env.indexOf('new.envelope_canonical := app.envelope_canonical(new);'));
});

test('B4 and 1.4: the status rule is SECURITY INVOKER and the view reads it through a DEFINER door guarded by candidate visibility; the recipients read is VOLATILE; no E4 routine is STABLE', () => {
  const status = definitionOf(M006, 'app.envelope_status');
  assert.doesNotMatch(status, /security definer/);
  const door = definitionOf(M006, 'app.reader_envelope_status');
  assert.match(door, /security definer/);
  assert.match(door, /app\.envelope_status\(e\.id\)[\s\S]*app\.candidate_visible\(e\.candidate_id\)/);
  const view = /create view api\.review_envelopes with \(security_invoker = true\) as([\s\S]*?)from app\.review_envelopes;/.exec(PART_B)?.[1];
  assert.ok(
    view?.includes('app.reader_envelope_status(id) as status') && !view.includes('app.envelope_status('),
    'the view calls the door, never the invoker rule, whose body a request role could not parse',
  );
  assert.match(definitionOf(M006, 'app.release_recipients'), /language sql volatile/);
  for (const name of Object.keys(ORDER)) assert.doesNotMatch(definitionOf(M006, name).split('$$')[0], /\b(stable|immutable)\b/, name);
});

/* The top-level arguments of the call that opens at `open` (an index of its opening parenthesis). */
function argsAt(source, open) {
  const out = [];
  let depth = 0;
  let quote = false;
  let start = open + 1;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "'") quote = !quote;
    if (quote) continue;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        out.push(source.slice(start, i).trim());
        return { args: out, end: i };
      }
    } else if (ch === ',' && depth === 1) {
      out.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  throw new Error('unbalanced call');
}

function auditKeys(source) {
  const byAction = {};
  for (const m of source.matchAll(/perform app\.audit\(/g)) {
    const { args } = argsAt(source, m.index + m[0].length - 1);
    const action = /^'([a-z_.]+)'$/.exec(args[3])?.[1];
    const keys = new Set();
    const details = args.slice(6).join(',');
    for (const call of details.matchAll(/jsonb_build_object\(/g)) {
      const inner = argsAt(details, call.index + call[0].length - 1).args;
      for (let i = 0; i < inner.length; i += 2) keys.add(/^'([a-z0-9_]+)'$/.exec(inner[i])?.[1]);
    }
    byAction[action] = [...new Set([...(byAction[action] ?? []), ...keys])].sort();
  }
  return byAction;
}

test('2.4: every audit row part B writes carries exactly the design s keys, and A8 s guard admits each key', () => {
  const expected = {
    'envelope.create': ['candidate_id', 'envelope_id', 'envelope_revision', 'envelope_sha256', 'gate_identity_sha256', 'policy_sha256', 'release_target'],
    'review.record': ['candidate_id', 'candidate_state_after', 'envelope_id', 'review_decision', 'review_id', 'review_role'],
    'release.publish': ['agent_id', 'assembled_sha256', 'candidate_id', 'content_sha256', 'envelope_id', 'release_id', 'release_target'],
    'release.supersede': ['release_id', 'superseded_by_release_id'],
    'candidate.supersede': ['candidate_id', 'candidate_state_after'],
    'release.withdraw': ['recipient_count', 'release_id', 'release_state_after'],
  };
  assert.deepEqual(auditKeys(PART_B), expected);
  const guard = definitionOf(M006, 'app.audit_details_guard');
  for (const key of new Set(Object.values(expected).flat())) assert.match(guard, new RegExp(`'${key}'`), key);
  assert.doesNotMatch(PART_B.slice(PART_B.indexOf('B8.')), /'reason'\s*,/, 'no reason key in any details');
});

test('2.6 item 1: lib/db/server.mjs binds each E4 routine in its signature s parameter order, and identifies the operation without the gate, the expected hash or the key', () => {
  const E4 = ['create_envelope', 'record_review', 'publish_release', 'withdraw_release'];
  for (const fn of E4) {
    const signature = new RegExp(`create or replace function api\\.${fn}\\(([^)]*)\\)`).exec(M006)?.[1];
    const params = [...signature.matchAll(/(p_[a-z0-9_]+) /g)].map((m) => m[1]);
    assert.deepEqual(Object.keys(bindCall(fn, {}).body), params, fn);
    for (const excluded of ['gate_identity', 'expected_assembled_sha256', 'idempotency_key'])
      assert.ok(!BOUND[fn].operation.includes(excluded), `${fn} operation omits ${excluded}`);
  }
  assert.deepEqual(BOUND.create_envelope.operation, ['candidate_id', 'target', 'audience_canonical', 'policy_id']);
  assert.deepEqual(BOUND.record_review.operation, ['candidate_id', 'envelope_id', 'role', 'decision', 'reason']);
  assert.deepEqual(BOUND.publish_release.operation, ['candidate_id', 'envelope_id']);
  assert.deepEqual(BOUND.withdraw_release.operation, ['release_id', 'reason']);
});

test('B7 and B8 grants: the four routines to app_server alone by full signature; the four doors to authenticated; no assembled_content grant', () => {
  const grant = /grant execute on function api\.create_envelope\(uuid, text, text, uuid, bytea, uuid\),\s+api\.record_review\(uuid, uuid, text, text, text, bytea, uuid\),\s+api\.publish_release\(uuid, uuid, bytea, bytea, uuid\),\s+api\.withdraw_release\(uuid, text, uuid\) to app_server;/;
  assert.match(PART_B, grant);
  assert.match(PART_B, /api\.withdraw_release\(uuid, text, uuid\) from public, anon, authenticated;/);
  assert.match(
    PART_B,
    /grant execute on function app\.reader_envelope_status\(uuid\), app\.release_visible\(uuid\), app\.ledger_visible\(uuid\),\s+app\.agent_reviewer_exclusions\(uuid\) to authenticated;/,
  );
  const releaseGrant = /grant select \(([^)]*)\)\s+on app\.releases to authenticated;/.exec(PART_B)?.[1];
  assert.ok(releaseGrant && !releaseGrant.includes('assembled_content') && releaseGrant.includes('assembled_bytes'));
  const view = /create view api\.releases with \(security_invoker = true\) as([\s\S]*?)from app\.releases;/.exec(PART_B)?.[1];
  assert.ok(view && !view.includes('assembled_content'));
});
