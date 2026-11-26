/* lib/rules/reviews.mjs without a stack (E4 design 1.2, 1.7, 3.2 and 3.5 rows 21 and 22): the Node column of each shared
   corpus under tests/e4/fixtures/, whose SQL column tests/db/23-review-routines.sh runs against the database, and the
   rule constants against migration 006's own text. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXCLUDING_KINDS,
  envelopeStatus,
  GROUP_NAME_MAX_CODE_POINTS,
  groupNameOf,
  REASON_MAX_CODE_POINTS,
  REVIEW_DECISIONS,
  REVIEW_ROLES,
  REVIEWER_ROLE_OF,
  reviewReasonOf,
  uuidOf,
  viewerVerdict,
} from '../../../lib/rules/reviews.mjs';
import { ROLE_NAMES } from '../../../lib/rules/roles.mjs';
import { GROUP_NAME_CORPUS } from '../fixtures/group-name-corpus.mjs';
import { REASON_CORPUS } from '../fixtures/reason-corpus.mjs';
import { STATUS_CORPUS, VERDICT_CORPUS } from '../fixtures/status-and-verdict-corpus.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const text = (rel) => readFileSync(join(REPO, rel), 'utf8');
const M006 = text('supabase/migrations/006_reviews_releases.sql');
const M003 = text('supabase/migrations/003_content.sql');
const M004 = text('supabase/migrations/004_content_rules_and_profiles.sql');

function definitionOf(source, name) {
  const start = source.lastIndexOf(`create or replace function ${name}(`);
  if (start < 0) return null;
  const open = source.indexOf('$$', start);
  return source.slice(start, source.indexOf('$$;', open + 2) + 3);
}
const arrayOf = (name) => [...definitionOf(M006, name).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

test('the reason corpus, Node column: reviewReasonOf answers every row as the corpus states', () => {
  assert.ok(REASON_CORPUS.length >= 25);
  for (const row of REASON_CORPUS) {
    const expected = row.node === 'E_BODY_INVALID' ? { ok: false, code: 'E_BODY_INVALID' } : row.node;
    assert.deepEqual(reviewReasonOf(row.input), expected, row.label);
    if (row.sql !== 'unrepresentable') assert.equal(row.sql, row.node === 'E_BODY_INVALID' ? 'E_BODY_INVALID' : 'ok');
  }
});

test('the group-name corpus, Node column: groupNameOf answers every row as the corpus states', () => {
  assert.ok(GROUP_NAME_CORPUS.length >= 20);
  for (const row of GROUP_NAME_CORPUS) {
    const expected = row.node === 'E_BODY_INVALID' ? { ok: false, code: 'E_BODY_INVALID' } : row.node;
    assert.deepEqual(groupNameOf(row.input), expected, row.label);
  }
});

test('the status corpus, Node column: envelopeStatus, a change request closes, two roles approve, else open', () => {
  for (const row of STATUS_CORPUS) assert.equal(envelopeStatus(row.reviews), row.expected, row.label);
  assert.throws(() => envelopeStatus(null), TypeError);
});

test('the verdict corpus, Node column: viewerVerdict refuses per role as api.record_review rows 21 then 22', () => {
  const me = '3b6e2c4d-5f70-4b9c-8d1e-2f3a4b5c6d7e';
  const someoneElse = '4c7f3d5e-6081-4cad-9e2f-3a4b5c6d7e8f';
  assert.ok(VERDICT_CORPUS.some((row) => row.kinds.length === 0 && row.earlierKinds?.length > 0), 'the earlier-version row');
  for (const row of VERDICT_CORPUS) {
    /* The candidate's own rows only: a row's earlierKinds sit on another candidate of the agent, which is history and
       never this input (services.test.mjs drives the same corpus through the review read, where both are served). */
    const contributors = [
      ...row.kinds.map((kind) => (kind === 'declared_offline' ? { kind, displayName: 'Jane Doe' } : { kind, membershipId: me })),
      { kind: 'author', membershipId: someoneElse },
    ];
    const v = viewerVerdict({ membershipId: me, roles: row.roles, contributors });
    assert.deepEqual(v.refusals, row.refusals, row.label);
    const eligible = REVIEW_ROLES.filter((r) => row.refusals[r] === null);
    assert.deepEqual(v.mayApproveAs, eligible, row.label);
    assert.deepEqual(v.mayRequestChangesAs, eligible, row.label);
    assert.equal(v.excluded, row.kinds.some((k) => EXCLUDING_KINDS.includes(k)), row.label);
  }
  /* No membership id, no exclusion: a viewer is never matched to a row by a missing id. */
  const v = viewerVerdict({ membershipId: undefined, roles: ['it_reviewer'], contributors: [{ kind: 'author' }] });
  assert.equal(v.excluded, false);
});

test('the vocabularies are the migration s: app.review_roles(), app.review_decisions(), the reviewer role names, the kinds', () => {
  assert.deepEqual(arrayOf('app.review_roles'), [...REVIEW_ROLES]);
  assert.deepEqual(arrayOf('app.review_decisions'), [...REVIEW_DECISIONS]);
  for (const role of REVIEW_ROLES) assert.ok(ROLE_NAMES.includes(REVIEWER_ROLE_OF[role]), role);
  assert.match(definitionOf(M006, 'api.record_review'), /\(p_role \|\| '_reviewer'\) = any \(reviewer\.roles\)/);
  const kinds = [...definitionOf(M003, 'app.contributor_kinds').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(EXCLUDING_KINDS, kinds.filter((k) => k !== 'declared_offline'));
  assert.match(definitionOf(M006, 'app.agent_contributor_memberships'), /k\.membership_id is not null/);
});

test('the reason rule is app.review_reason s: the declared-name trim, the bound, and exactly the refused code points', () => {
  const def = definitionOf(M006, 'app.review_reason');
  assert.match(def, /v text := app\.declared_name\(p_reason\);/);
  assert.match(def, new RegExp(`char_length\\(v\\) not between 1 and ${REASON_MAX_CODE_POINTS}`));
  assert.match(def, /v ~ '\[\\x01-\\x08\\x0B-\\x1F\\x7F\]'/);
  /* The class above, as numbers: 1 to 8, 11 to 31, 127. Node refuses those and U+0000 inside, and nothing else. */
  const sqlRefused = new Set([...Array.from({ length: 8 }, (_, i) => i + 1), ...Array.from({ length: 21 }, (_, i) => i + 11), 127]);
  for (let c = 0; c < 0x3000; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const ch = String.fromCodePoint(c);
    const inside = reviewReasonOf(`a${ch}b`).ok;
    assert.equal(inside, !(sqlRefused.has(c) || c === 0), `U+${c.toString(16)}`);
  }
  /* The trim class is 004's, which String.prototype.trim() is (tests/e3/unit/migration-text.test.mjs holds that over
     every code point): each of its code points around a reason is removed, and the rest is kept. */
  const trimClass = [...definitionOf(M004, 'app.declared_name_trim_characters').matchAll(/chr\((\d+)\)/g)].map((m) => Number(m[1]));
  assert.equal(trimClass.length, 25);
  for (const c of trimClass) {
    const ch = String.fromCodePoint(c);
    assert.deepEqual(reviewReasonOf(`${ch}ok${ch}`), { ok: true, value: 'ok' }, `U+${c.toString(16)}`);
  }
  assert.match(M006, /reason\s+text not null check \(char_length\(reason\) between 1 and 2000/);
});

test('the group name rule is api.create_group s: U+0020 trim, the bound, and the refused set, by code point', () => {
  const def = definitionOf(M006, 'api.create_group');
  assert.match(def, new RegExp(`char_length\\(v\\) not between 1 and ${GROUP_NAME_MAX_CODE_POINTS}`));
  const refused = new Set();
  for (const m of def.matchAll(/ascii\(ch\) in \(([0-9, ]+)\)/g)) for (const n of m[1].split(',')) refused.add(Number(n));
  for (const m of def.matchAll(/ascii\(ch\) between (\d+) and (\d+)/g))
    for (let c = Number(m[1]); c <= Number(m[2]); c++) refused.add(c);
  for (let c = 1; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    if (c > 0x3000 && c < 0xe000) continue;
    assert.equal(groupNameOf(`a${String.fromCodePoint(c)}`).ok, !refused.has(c), `U+${c.toString(16)}`);
  }
});

test('uuidOf takes a uuid in either case and answers it lowercase; anything else is null', () => {
  assert.equal(uuidOf('0F7D3A51-2F4A-4A7B-9C3E-1B9D3C0F5A11'), '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11');
  for (const bad of ['', 'x', '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a1', ' 0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11', null, 7, {}])
    assert.equal(uuidOf(bad), null, String(bad));
});
