/* lib/passport/packet.mjs without a stack (E4 design 1.1, 1.3, 2.1 and case 53): the replay, the losses reading against
   the renderer's over a fixture corpus, the assembly arithmetic against the real splice and against the critic's two
   inputs (evidence/e4-design-critique-repro/packet-cases.sh.txt: eight placeholders, then 4,633 counted by arithmetic
   only), the four golden hashes, and the constants against migration 006. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assemble, installerText, PLACEHOLDER, readText } from '../../../lib/passport/assemble.mjs';
import { gate } from '../../../lib/passport/gate.mjs';
import {
  ASSEMBLED_BYTES_MAX,
  assembledSha256,
  envelopeCanonical,
  lossRows,
  projectedAssembledBytes,
  replayStored,
} from '../../../lib/passport/packet.mjs';
import { lossesState } from '../../../lib/passport/render.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const VENDOR = join(REPO, 'vendor/passport');
const SYNTHETIC = readText(join(REPO, 'tests/native-transfer/passport/fixtures/SYNTHETIC-passport.md'));
const EMPTY = readFileSync(join(REPO, 'tests/passport/fixtures/synthetic-empty.md'), 'utf8');
const M006 = readFileSync(join(REPO, 'supabase/migrations/006_reviews_releases.sql'), 'utf8');
const STAMP = '2026-09-15T08:00:00.000Z';
const sha = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const GOLDEN = {
  chatgpt: '11070a1ffbdc39030b661cddc332b8b5594bb78d6ab3c137000739609743ad7a',
  'claude-ai': '8e686b27e554e35af47af16a20cc24b48ae40323b4f5bcf37d64192f8b30e761',
  'claude-code': '5cdaf5c50d37c355c086f9f05aec2b810de10f109d0d1464682d4f13c85a3dff',
  generic: 'd558746392a835f3da4c4a779616761a8e0dba9157962d7da22d772e5d28546d',
};

const gated = (text, validatedAt = STAMP) => gate(Buffer.from(text, 'utf8'), 'text/markdown', { validatedAt });

test('replayStored: stored bytes the gate passes, with the stored validated_at, replay to the stored derived bytes', () => {
  const g = gated(SYNTHETIC);
  assert.equal(g.ok, true);
  const r = replayStored({ content: g.text, derivedCanonical: g.derivedCanonical });
  assert.deepEqual(r, {
    ok: true,
    contentSha256: g.contentSha256,
    derivedSha256: g.derivedSha256,
    gateIdentitySha256: g.gateIdentitySha256,
  });
});

test('replayStored: E_DERIVED_CHANGED when the current gate derives other bytes; E_GATE_FAILS_NOW for bytes it refuses or reshapes', () => {
  const stored = gated(SYNTHETIC);
  const other = SYNTHETIC.replace('It runs when you paste records and ask it to run.', 'It runs when you paste records.');
  assert.notEqual(other, SYNTHETIC);
  assert.equal(gated(other).ok, true, 'the other bytes pass the gate themselves');
  assert.deepEqual(replayStored({ content: other, derivedCanonical: stored.derivedCanonical }), {
    ok: false,
    code: 'E_DERIVED_CHANGED',
  });
  const FAILS = { ok: false, code: 'E_GATE_FAILS_NOW' };
  assert.deepEqual(replayStored({ content: 'not a passport', derivedCanonical: stored.derivedCanonical }), FAILS);
  const cr = SYNTHETIC.replace('\n', String.fromCharCode(13, 10));
  assert.deepEqual(replayStored({ content: cr, derivedCanonical: stored.derivedCanonical }), FAILS, 'a carriage return');
  assert.deepEqual(replayStored({ content: stored.text, derivedCanonical: '{' }), FAILS, 'unreadable derived record');
  const noStamp = stored.derivedCanonical.replace(STAMP, '2026-09-15T08:00:00Z');
  assert.deepEqual(replayStored({ content: stored.text, derivedCanonical: noStamp }), FAILS, 'a stamp gate() refuses');
  assert.deepEqual(replayStored({ content: null, derivedCanonical: stored.derivedCanonical }), FAILS);
});

function passportsUnder(dirs) {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.md')) out.push(p);
    }
  };
  for (const d of dirs) walk(d);
  return out.sort();
}

test('lossRows agrees with the renderer: rows exactly when lossesState says declared, over the fixture corpus and two built cases', () => {
  const files = passportsUnder([
    join(VENDOR, 'tools/fixtures'),
    join(VENDOR, 'examples'),
    join(REPO, 'tests/passport/fixtures'),
    join(REPO, 'tests/native-transfer/passport/fixtures'),
  ]);
  const declaredRow = '| Slack posting | not available | The digest is shown in chat instead |';
  const declared = SYNTHETIC.replace('| | | |', declaredRow);
  assert.notEqual(declared, SYNTHETIC);
  const fenced = SYNTHETIC.replace('| | | |', `| | | |\n\n\`\`\`\n${declaredRow}\n\`\`\``);
  const texts = [...files.map((f) => readFileSync(f, 'utf8')), declared, fenced, '', 'no sections at all'];
  assert.ok(files.length >= 5, `a corpus of ${files.length} files`);
  const states = new Set();
  for (const t of texts) {
    const rows = lossRows(t);
    assert.ok(Array.isArray(rows), 'always an array, never nothing');
    const state = lossesState(t, null);
    states.add(state);
    assert.equal(rows.length > 0, state === 'declared');
  }
  assert.deepEqual([...states].sort(), ['declared', 'pending'], 'both states occur in the corpus');
  assert.deepEqual(lossRows(declared), [
    { what: 'Slack posting', status: 'not available', meaning: 'The digest is shown in chat instead' },
  ]);
  assert.deepEqual(lossRows(SYNTHETIC), [], 'the empty template is the empty table');
  assert.deepEqual(lossRows(fenced), [], 'a fenced example row is not a declared row');
});

test('projectedAssembledBytes equals the byte length of the real splice for zero, one, several and adjacent placeholders', () => {
  const text = installerText(VENDOR, 'claude-code.md');
  const cases = [
    'no placeholder here',
    SYNTHETIC,
    `${PLACEHOLDER}${PLACEHOLDER}`,
    `a${PLACEHOLDER}b${PLACEHOLDER}c${PLACEHOLDER}`,
    `${'é'.repeat(10)}${PLACEHOLDER}${String.fromCodePoint(0x1f600)}`,
    PLACEHOLDER.slice(0, -1),
  ];
  for (const c of cases) {
    assert.equal(projectedAssembledBytes(c, text), bytes(c.split(PLACEHOLDER).join(text)), c.slice(0, 40));
    assert.equal(projectedAssembledBytes(c, 'x'), bytes(c.split(PLACEHOLDER).join('x')), `short text: ${c.slice(0, 40)}`);
  }
});

test('case 53, the critic s first input: eight placeholders in 3,129 gate-valid bytes project to 568,513, and no hash is built', () => {
  const text = installerText(VENDOR, 'claude-code.md');
  const eight = `${EMPTY}\n${Array(7).fill(PLACEHOLDER).join('\n')}\n`;
  assert.equal(gated(eight).ok, true);
  assert.equal(bytes(eight), 3129);
  assert.equal(eight.split(PLACEHOLDER).length - 1, 8);
  assert.equal(projectedAssembledBytes(eight, text), 568513);
  assert.throws(() => assembledSha256(eight, text), RangeError);
  assert.equal(projectedAssembledBytes(EMPTY, text), 73409, 'the same content with one placeholder');
  assert.equal(assembledSha256(EMPTY, text), sha(EMPTY.split(PLACEHOLDER).join(text)));
});

test('case 53, the critic s second input: 4,633 placeholders in 262,129 gate-valid bytes project to 327,690,138 by arithmetic alone', () => {
  const text = installerText(VENDOR, 'claude-code.md');
  const count = Math.floor((262144 - bytes(EMPTY) - 2) / bytes(`${PLACEHOLDER}\n`));
  const big = `${EMPTY}\n${Array(count).fill(PLACEHOLDER).join('\n')}\n`;
  assert.equal(bytes(big), 262129);
  assert.equal(gated(big).ok, true);
  assert.equal(projectedAssembledBytes(big, text), 327690138);
  assert.throws(() => assembledSha256(big, text), RangeError);
});

test('projectedAssembledBytes counts with indexOf and never splits the whole content (design 1.3, E4D-C-F3)', () => {
  const source = readFileSync(join(REPO, 'lib/passport/packet.mjs'), 'utf8');
  const body = source.slice(source.indexOf('export function projectedAssembledBytes'), source.indexOf('export function assembledSha256'));
  assert.match(body, /content\.indexOf\(PLACEHOLDER/);
  assert.doesNotMatch(body, /split\(/);
  const hash = source.slice(source.indexOf('export function assembledSha256'), source.indexOf('export function envelopeCanonical'));
  assert.ok(hash.indexOf('projectedAssembledBytes(') < hash.indexOf('split('), 'the arithmetic runs before the splice is built');
});

test('case 25 s Node half: assembledSha256 of the SYNTHETIC fixture gives the four golden hashes, as assemble() does', () => {
  for (const [target, golden] of Object.entries(GOLDEN)) {
    const text = installerText(VENDOR, `${target}.md`);
    assert.equal(assembledSha256(SYNTHETIC, text), golden, target);
    assert.equal(sha(assemble(SYNTHETIC, { root: VENDOR, branch: target })), golden, `${target}: assemble() agrees`);
  }
});

test('the constants are migration 006 s: the bound, the placeholder and the arithmetic', () => {
  assert.equal(ASSEMBLED_BYTES_MAX, 262144 + 131072);
  assert.match(M006, /function app\.limit_assembled_bytes\(\)[^$]*\$\$ select 393216 \$\$;/);
  assert.match(M006, new RegExp(`function app\\.installer_placeholder\\(\\)[^$]*\\$\\$\\s*select '${PLACEHOLDER}'::text\\s*\\$\\$;`));
  assert.match(M006, /assembled_bytes\s+integer not null check \(assembled_bytes between 1 and 393216\)/);
  assert.match(M006, /check \(octet_length\(assembled_content\) between 1 and 393216\)/);
  assert.match(M006, /replace\(p_content, app\.installer_placeholder\(\), ''\)/);
});

test('envelopeCanonical: design 1.1 s key order, sorted group ids, no whitespace, and nothing but the binding', () => {
  const binding = {
    group_ids: ['7f000000-0000-4000-8000-000000000000', '1a2b0000-0000-4000-8000-000000000000'],
    candidate_id: '9c0e0000-0000-4000-8000-000000000000',
    content_sha256: 'a'.repeat(64),
    derived_sha256: 'b'.repeat(64),
    gate_identity_sha256: 'c'.repeat(64),
    installer: { text_sha256: '1'.repeat(64), core_sha256: '2'.repeat(64), branch_sha256: '3'.repeat(64), judge_sha256: '4'.repeat(64) },
    policy: { id: 'c3d40000-0000-4000-8000-000000000000', sha256: 'd'.repeat(64) },
    target: 'claude-ai',
    ignored: 'not part of the binding',
  };
  assert.equal(
    envelopeCanonical(binding),
    `{"audience":{"group_ids":["1a2b0000-0000-4000-8000-000000000000","7f000000-0000-4000-8000-000000000000"]},"candidate_id":"9c0e0000-0000-4000-8000-000000000000","content_sha256":"${'a'.repeat(64)}","derived_sha256":"${'b'.repeat(64)}","envelope_version":1,"gate_identity_sha256":"${'c'.repeat(64)}","installer":{"branch_sha256":"${'3'.repeat(64)}","core_sha256":"${'2'.repeat(64)}","judge_sha256":"${'4'.repeat(64)}","text_sha256":"${'1'.repeat(64)}"},"policy":{"id":"c3d40000-0000-4000-8000-000000000000","sha256":"${'d'.repeat(64)}"},"target":"claude-ai"}`,
  );
  assert.deepEqual(binding.group_ids[0], '7f000000-0000-4000-8000-000000000000', 'the caller s array is not reordered');
});
