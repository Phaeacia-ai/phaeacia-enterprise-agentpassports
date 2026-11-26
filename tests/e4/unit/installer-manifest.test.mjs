/* E4 design 1.8 and 2.6 item 4, no stack. lib/passport/installer-manifest.mjs is what scripts/installer-texts.mjs
   computes from the vendored tree; each row recomputes from assemble.mjs installerText() and from upstream.lock.json,
   independently of the generator; and the generator refuses a tree whose vendored bytes moved (case 49, the manifest
   gate's arm), a tree without a judge prompt, and a text carrying its SQL quote tag. The database half, that the
   registered rows hold these hashes, is tests/db/21-groups-and-registers.sh. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BRANCHES, installerText } from '../../../lib/passport/assemble.mjs';
import { GATE_IDENTITY_SHA256 } from '../../../lib/passport/gate-manifest.mjs';
import * as committed from '../../../lib/passport/installer-manifest.mjs';
import { installerManifest, registrationSql, render, SQL_TAG } from '../../../scripts/installer-texts.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GENERATOR = join(REPO, 'scripts/installer-texts.mjs');
const run = (...args) => spawnSync(process.execPath, [GENERATOR, ...args], { encoding: 'utf8' });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lock = JSON.parse(readFileSync(join(REPO, 'upstream.lock.json'), 'utf8'));

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/* The smallest tree the generator reads: lib/passport with both manifests, the lock, and the vendored web modules, installer
   and verification prompt. */
function scratchTree() {
  const root = mkdtempSync(join(tmpdir(), 'e4-installer-'));
  roots.push(root);
  cpSync(join(REPO, 'lib/passport'), join(root, 'lib/passport'), { recursive: true });
  cpSync(join(REPO, 'upstream.lock.json'), join(root, 'upstream.lock.json'));
  for (const dir of ['web/lib', 'installer', 'verification'])
    cpSync(join(REPO, 'vendor/passport', dir), join(root, 'vendor/passport', dir), { recursive: true });
  return root;
}

test('the committed module is the generator output for this tree, under the committed gate identity', async () => {
  const m = await installerManifest(REPO);
  assert.equal(readFileSync(join(REPO, 'lib/passport/installer-manifest.mjs'), 'utf8'), render(m));
  assert.equal(committed.GATE_IDENTITY_SHA256, GATE_IDENTITY_SHA256);
  assert.deepEqual(
    committed.INSTALLER_TEXTS.map((r) => r.target),
    [...BRANCHES],
  );
  assert.ok(Object.isFrozen(committed.INSTALLER_TEXTS) && committed.INSTALLER_TEXTS.every((r) => Object.isFrozen(r)));
});

test('each row recomputes from installerText() and upstream.lock.json, not from the generator', () => {
  for (const row of committed.INSTALLER_TEXTS) {
    const text = installerText(join(REPO, 'vendor/passport'), `${row.target}.md`);
    assert.equal(row.textSha256, sha(Buffer.from(text, 'utf8')), row.target);
    assert.equal(row.bytes, Buffer.byteLength(text, 'utf8'), row.target);
    assert.equal(row.coreSha256, lock.imported['installer/core.md'], row.target);
    assert.equal(row.branchSha256, lock.imported[`installer/branches/${row.target}.md`], row.target);
    assert.equal(row.judgeSha256, lock.imported['verification/judge-prompt.md'], row.target);
  }
  /* Design 1.8's measured sizes at this pin. */
  assert.deepEqual(Object.fromEntries(committed.INSTALLER_TEXTS.map((r) => [r.target, r.bytes])), {
    chatgpt: 68071,
    'claude-ai': 61940,
    'claude-code': 70728,
    generic: 52276,
  });
});

test('the manifest gate passes on an unchanged copy of the tree (control)', () => {
  const r = run('--check', '--root', scratchTree());
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /committed module matches/);
});

test('case 49: the manifest gate refuses a tree with one vendored branch byte changed, and names the stale module', () => {
  const root = scratchTree();
  appendFileSync(join(root, 'vendor/passport/installer/branches/generic.md'), 'x');
  const r = run('--check', '--root', root);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /^REFUSE lib\/passport\/installer-manifest\.mjs is stale/);
});

test('the generator refuses a tree without a judge prompt, and a text that carries its SQL quote tag', () => {
  const noJudge = scratchTree();
  rmSync(join(noJudge, 'vendor/passport/verification'), { recursive: true, force: true });
  const a = run('--sql', '--root', noJudge);
  assert.equal(a.status, 2, a.stdout + a.stderr);
  assert.match(a.stdout, /^REFUSE installer-texts: no judge under /);
  const tagged = scratchTree();
  appendFileSync(join(tagged, 'vendor/passport/installer/branches/chatgpt.md'), `\n${SQL_TAG}\n`);
  const b = run('--sql', '--root', tagged);
  assert.equal(b.status, 2, b.stdout + b.stderr);
  assert.match(b.stdout, /^REFUSE installer-texts: chatgpt: the text contains \$installer_text\$/);
});

test('the registration SQL carries each text whole between its tags, and checks hashes and lengths after the insert', async () => {
  const m = await installerManifest(REPO);
  const sql = registrationSql(m);
  for (const t of m.texts) {
    assert.ok(sql.includes(`('${t.target}', ${SQL_TAG}${t.text}${SQL_TAG},\n`), t.target);
    assert.ok(sql.includes(`('${t.target}', '${t.textSha256}', ${t.bytes})`), t.target);
  }
  assert.equal(sql.split(SQL_TAG).length - 1, 2 * m.texts.length);
  assert.ok(sql.indexOf('insert into app.installer_texts') < sql.indexOf('do $registered$'));
  assert.match(sql, /\) <> 4 then\n\s*raise exception 'installer text registration differs/);
});
