/* Two E4 tripwires and case 46's Node half, no stack.
   - Every E_ code an E4 module or part B can answer is in lib/errors.mjs CODES with 3.5's status, so
     a refusal never becomes 500 E_INTERNAL; a code the registry lacks fails here by name (brief item 5).
   - Case 46: the canonical vectors under tests/e4/fixtures hash as their text says, their group ids sort by code unit,
     and the crafted pair shows an ICU numeric collation ordering them the other way (tests/db/e4.mjs canonical-sql is
     the SQL half and runs the same collation in PostgreSQL). */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../../lib/errors.mjs';
import { canonical } from '../../../lib/passport/canonical.mjs';
import { envelopeCanonical } from '../../../lib/passport/packet.mjs';
import { CRAFTED_PAIR, ENVELOPE_VECTORS } from '../fixtures/canonical-vectors.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

const E4_SOURCES = [
  'lib/services/reviews.mjs',
  'lib/services/releases.mjs',
  'lib/services/groups.mjs',
  'lib/services/evidence-reads.mjs',
  'lib/rules/reviews.mjs',
  'lib/passport/packet.mjs',
  /* tests/db/fixtures/e4-download-seam.sql was here until E5 design 2.7 retired it; api.authorize_download raises
     those codes now and tests/e5/unit/errors.test.mjs reads migration 007 and the E5 modules for the same rule. */
];
/* Raised only where no PostgREST role reaches (design 3.5, the owner-side refusals). */
const OWNER_SIDE = new Set(['E_ENVELOPE_DELETE', 'E_RELEASE_DELETE', 'E_LEDGER_APPEND_ONLY', 'E_GROUP_DELETE']);
const codesIn = (text) => new Set([...text.matchAll(/'(E_[A-Z0-9_]+)'/g)].map((m) => m[1]));

function missing(sources) {
  const out = [];
  for (const [name, text] of sources) for (const code of codesIn(text)) if (!(code in CODES) && !OWNER_SIDE.has(code)) out.push(`${name}: ${code}`);
  return out;
}

test('every code an E4 module or migration 006 part B can answer is in CODES', () => {
  const m006 = read('supabase/migrations/006_reviews_releases.sql');
  const sources = [...E4_SOURCES.map((rel) => [rel, read(rel)]), ['006 part B', m006.slice(m006.indexOf('-- Part B. E4 itself'))]];
  assert.deepEqual(missing(sources), []);
  const all = new Set(sources.flatMap(([, text]) => [...codesIn(text)]));
  assert.ok(all.size >= 30, `${all.size} codes read`);
});

test('control: a code the registry lacks is named', () => {
  assert.deepEqual(missing([['x.mjs', "throw new AppError('E_REVIEW_MADE_UP');"]]), ['x.mjs: E_REVIEW_MADE_UP']);
});

test('3.5 s statuses for the codes the E4 services raise before any call', () => {
  const expected = {
    E_IDEMPOTENCY_KEY_INVALID: 422,
    E_BODY_INVALID: 422,
    E_NOT_FOUND: 404,
    E_NOT_REVIEWABLE: 409,
    E_GATE_FAILS_NOW: 422,
    E_DERIVED_CHANGED: 409,
    E_ASSEMBLY_TOO_LARGE: 422,
    E_INSTALLER_UNREGISTERED: 503,
    E_ASSEMBLY_DIVERGED: 500,
    E_FORBIDDEN: 403,
    E_READ_OVER_BOUND: 500,
  };
  for (const [code, status] of Object.entries(expected)) assert.equal(CODES[code], status, code);
});

test('case 46, Node half: every vector s text is canonical() of itself, its hash is its text s, and its group ids sort by code unit', () => {
  assert.ok(ENVELOPE_VECTORS.length >= 10);
  const counts = new Set();
  for (const v of ENVELOPE_VECTORS) {
    const text = envelopeCanonical(v);
    assert.equal(canonical(JSON.parse(text)), text, 'already canonical');
    assert.equal(createHash('sha256').update(text, 'utf8').digest('hex'), v.expectedSha256);
    const ids = JSON.parse(text).audience.group_ids;
    assert.deepEqual(ids, [...v.group_ids].sort());
    for (let i = 1; i < ids.length; i++) assert.ok(ids[i - 1] < ids[i], 'strictly ascending by code unit');
    counts.add(ids.length);
  }
  assert.ok(counts.has(1) && counts.has(20), 'one and twenty groups');
  assert.deepEqual(
    new Set(ENVELOPE_VECTORS.map((v) => v.target)),
    new Set(['chatgpt', 'claude-ai', 'claude-code', 'generic']),
  );
});

test('case 46 counterexample, Node half: an ICU numeric collation orders the crafted pair against byte order', () => {
  const bytesOrder = [...CRAFTED_PAIR].sort();
  const numeric = [...CRAFTED_PAIR].sort(new Intl.Collator('en', { numeric: true }).compare);
  assert.deepEqual(bytesOrder, ['10000000-0000-4000-8000-000000000000', '1a000000-0000-4000-8000-000000000000']);
  assert.notDeepEqual(numeric, bytesOrder);
  /* The hyphen sits at the same offsets in every uuid, so a collation that only ignores it orders uuids as bytes do. */
  const ignoringHyphen = [...CRAFTED_PAIR].sort((a, b) => (a.replaceAll('-', '') < b.replaceAll('-', '') ? -1 : 1));
  assert.deepEqual(ignoringHyphen, bytesOrder);
});
