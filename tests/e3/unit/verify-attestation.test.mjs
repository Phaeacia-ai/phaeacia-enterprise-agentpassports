/* Case 10, fixture half (attestation contract 7): scripts/verify-attestation.mjs over rows built from the
   synthetic fixtures by the gate at the committed identity, then over tampered rows. The database half, rows
   exported after the routines wrote them in two companies, is tests/db/14-content-routines.sh. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { PLACEHOLDER } from '../../../lib/passport/assemble.mjs';
import { gate } from '../../../lib/passport/gate.mjs';
import * as M from '../../../lib/passport/gate-manifest.mjs';
import { verifyRow } from '../../../scripts/verify-attestation.mjs';
import { REPO, SYNTHETIC, variant } from './helpers.mjs';

const SCRIPT = join(REPO, 'scripts/verify-attestation.mjs');
const sha = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const dir = mkdtempSync(join(tmpdir(), 'e3-verify-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const GATE_ROW = {
  identity_sha256: `\\x${M.GATE_IDENTITY_SHA256}`,
  adapter_lock_sha256: M.ADAPTER_LOCK_SHA256,
  validator_version: M.VALIDATOR_VERSION,
  manifest_sha256: M.MANIFEST_SHA256,
  upstream_commit: M.UPSTREAM_COMMIT,
};

function rowOf(text, validatedAt = '2026-09-12T08:00:00.000Z') {
  const g = gate(Buffer.from(text, 'utf8'), 'text/markdown', { validatedAt });
  assert.equal(g.ok, true);
  return {
    content: g.text,
    derived_canonical: g.derivedCanonical,
    content_sha256: `\\x${g.contentSha256}`,
    derived_sha256: g.derivedSha256,
    gate: GATE_ROW,
  };
}

let n = 0;
function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}
function file(value) {
  const path = join(dir, `input-${n++}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const ROWS = [
  rowOf(SYNTHETIC),
  rowOf(variant([['    access: open\n', '    access: credentialed\n    binding: delivery_target\n']]), '2026-09-12T09:00:00.000Z'),
  rowOf(variant([['- B2: blue\n', '- B2: teal\n']]), '2026-09-12T10:00:00.000Z'),
];
const failures = (r) => r.stdout.split('\n').filter((l) => l.startsWith('FAIL'));

test('case 10 control: untampered rows at the committed identity pass every check, exit 0', () => {
  const r = run('--rows', file(ROWS));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /verify-attestation: 3 row\(s\), 0 failed check\(s\)/);
  assert.deepEqual(failures(r), []);
});

test('case 10: one tampered content byte is a content hash mismatch, and nothing else about the row is trusted', () => {
  const tampered = { ...ROWS[0], content: ROWS[0].content.replace('amber', 'ambeR') };
  const r = run('--rows', file([ROWS[1], tampered]));
  assert.equal(r.status, 2);
  assert.deepEqual(
    failures(r).map((l) => l.replace(/ \(.*\)$/, '')),
    ['FAIL row 1: content_sha256 matches content'],
  );
});

test('case 10: one tampered derived_canonical byte is a hash mismatch and a replay mismatch', () => {
  const tampered = { ...ROWS[0], derived_canonical: ROWS[0].derived_canonical.replace('SYNTHETIC Record Sorter', 'SYNTHETIC Record Sortes') };
  const r = run('--row', file(tampered));
  assert.equal(r.status, 2);
  assert.deepEqual(
    failures(r).map((l) => l.replace(/ \(.*\)$/, '')),
    ['FAIL row 0: derived_sha256 matches derived_canonical', 'FAIL row 0: replay derived record is byte-equal to derived_canonical'],
  );
});

test('case 10: content rewritten with its hash kept consistent is caught by the verdict when the bytes fail the gate', () => {
  const content = ROWS[0].content.replace('It runs when you paste', 'Share it at app.phaeacia.ai. It runs when you paste');
  const r = run('--row', file({ ...ROWS[0], content, content_sha256: sha(content) }));
  assert.equal(r.status, 2);
  assert.ok(failures(r).some((l) => l.startsWith('FAIL row 0: replay verdict passes (refused E_PUBLIC_ROUTE@15')), r.stdout);
});

test('a row attested by another gate identity is not replayed here, and the tool says what to check out', () => {
  const other = sha('another identity');
  const components = { adapter_lock_sha256: sha('lock'), validator_version: '0.2.0', manifest_sha256: sha('manifest') };
  const identity = sha(`${components.adapter_lock_sha256}\n0.2.0\n${components.manifest_sha256}`);
  const r = run('--row', file({ ...ROWS[0], gate: { ...components, identity_sha256: identity, upstream_commit: 'a'.repeat(40) } }));
  assert.equal(r.status, 2);
  assert.match(r.stdout, /FAIL row 0: replayable at this checkout \(row identity [0-9a-f]{64} \(upstream a{40}\); this checkout is /);
  assert.doesNotMatch(r.stdout, /replay verdict/);
  const inconsistent = run('--row', file({ ...ROWS[0], gate: { ...GATE_ROW, identity_sha256: other } }));
  assert.match(inconsistent.stdout, /FAIL row 0: the registered identity reproduces from its components/);
});

test('--release: the splice of the exported installer text must reproduce assembled_sha256', () => {
  const installer = 'Synthetic installer text.\n';
  const assembled = ROWS[0].content.split(PLACEHOLDER).join(installer);
  assert.equal(run('--row', file(ROWS[0]), '--release', file({ installer_text: installer, assembled_sha256: sha(assembled) })).status, 0);
  const wrong = run('--row', file(ROWS[0]), '--release', file({ installer_text: installer, assembled_sha256: sha('x') }));
  assert.equal(wrong.status, 2);
  assert.match(wrong.stdout, /FAIL row 0: release assembled_sha256 matches the splice/);
});

/* E3a critique F4: Node's JSON.parse error message quotes part of the input, so a parser error must never be
   forwarded. The marker is synthetic; a real export would carry passport text in the same position. */
test('F4: syntactically malformed JSON exits 1 with one fixed message, and no fragment of the input is printed', () => {
  const marker = 'SYNTHETIC_PRIVATE_REPLAY_MARKER';
  let path;
  for (const text of [marker, `{"content":${marker}}`, `[{"content":"${marker}"`]) {
    path = join(dir, `malformed-${n++}.json`);
    writeFileSync(path, text);
    for (const flag of ['--row', '--rows']) {
      const r = run(flag, path);
      assert.equal(r.status, 1, `${flag} ${text}`);
      assert.equal(r.stdout, '', `${flag} ${text}`);
      assert.equal(r.stderr, 'verify-attestation: an input file is not valid JSON\n', `${flag} ${text}`);
      assert.doesNotMatch(r.stdout + r.stderr, /SYNTHETIC|MARKER|content/, `${flag} ${text}`);
    }
  }
  const release = run('--row', file(ROWS[0]), '--release', path);
  assert.equal(release.stderr, 'verify-attestation: an input file is not valid JSON\n');
});

test('F4 control: a well-formed row with an invalid field exits 1 naming the field, and nothing of the content is printed', () => {
  const r = run('--row', file({ content: 'SYNTHETIC secret prose', derived_canonical: '{}', content_sha256: 'zz' }));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'verify-attestation: content_sha256 is not a 32-byte digest\n');
  assert.doesNotMatch(r.stdout + r.stderr, /secret prose/);
});

test('no input is a usage error, exit 1', () => {
  assert.equal(run().status, 1);
});

test('verifyRow never includes content or derived text in a detail', () => {
  const details = verifyRow({ ...ROWS[0], content: `${ROWS[0].content} ` }).map((c) => c.detail).join(' ');
  assert.doesNotMatch(details, /Record Sorter|amber|pasted records/);
});
