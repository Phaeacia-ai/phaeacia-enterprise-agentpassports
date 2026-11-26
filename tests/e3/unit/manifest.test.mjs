/* Case 24: the gate identity names every enterprise file on the gate's module graph (E3 design 2.7, lead
   correction C1), and a stale committed manifest fails the scripts/check.sh gate. The database half of case 24,
   a server whose identity is not the active registered one meeting E_GATE_UNREGISTERED, is
   tests/db/13-attestation.sh. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import * as committed from '../../../lib/passport/gate-manifest.mjs';
import { manifest, render, walk } from '../../../scripts/gate-manifest.mjs';
import { RULES_VERSION } from '../../../vendor/passport/web/lib/_validate.mjs';
import { REPO } from './helpers.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const GENERATOR = join(REPO, 'scripts/gate-manifest.mjs');
const generator = (...args) => spawnSync(process.execPath, [GENERATOR, ...args], { encoding: 'utf8' });

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/* The smallest tree the generator reads: lib/passport, the lock and the vendored web modules. */
function scratchTree() {
  const root = mkdtempSync(join(tmpdir(), 'e3-manifest-'));
  roots.push(root);
  cpSync(join(REPO, 'lib/passport'), join(root, 'lib/passport'), { recursive: true });
  cpSync(join(REPO, 'upstream.lock.json'), join(root, 'upstream.lock.json'));
  cpSync(join(REPO, 'vendor/passport/web/lib'), join(root, 'vendor/passport/web/lib'), { recursive: true });
  return root;
}

test('case 24: the walk from gate.mjs reaches exactly the enterprise gate files, and not the manifest itself', () => {
  assert.deepEqual(walk(REPO), {
    files: ['lib/passport/assemble.mjs', 'lib/passport/canonical.mjs', 'lib/passport/gate.mjs', 'lib/passport/rules.mjs'],
    vendor: [
      'vendor/passport/web/lib/_derive.mjs',
      'vendor/passport/web/lib/_sections.mjs',
      'vendor/passport/web/lib/_validate.mjs',
    ],
  });
});

test('case 24: the committed constants are what a recomputation from the files gives', () => {
  const rows = walk(REPO).files.map((path) => [path, sha(readFileSync(join(REPO, path)))]);
  assert.deepEqual(
    committed.MANIFEST.map((row) => [...row]),
    rows,
  );
  const manifestSha = sha(Buffer.from(rows.map(([path, hash]) => `${path}\n${hash}\n`).join(''), 'utf8'));
  const lockBytes = readFileSync(join(REPO, 'upstream.lock.json'));
  assert.equal(committed.MANIFEST_SHA256, manifestSha);
  assert.equal(committed.ADAPTER_LOCK_SHA256, sha(lockBytes));
  assert.equal(committed.VALIDATOR_VERSION, RULES_VERSION);
  assert.equal(committed.UPSTREAM_COMMIT, JSON.parse(lockBytes.toString('utf8')).commit);
  assert.equal(
    committed.GATE_IDENTITY_SHA256,
    sha(Buffer.from(`${sha(lockBytes)}\n${RULES_VERSION}\n${manifestSha}`, 'utf8')),
  );
  assert.ok(Object.isFrozen(committed.MANIFEST) && committed.MANIFEST.every((row) => Object.isFrozen(row)));
});

test('case 24: the committed module is byte for byte what the generator writes, which is the check.sh gate', async () => {
  assert.equal(readFileSync(join(REPO, 'lib/passport/gate-manifest.mjs'), 'utf8'), render(await manifest(REPO)));
  const r = generator('--check');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('case 24: one changed byte of rules.mjs moves the identity, and the stale committed manifest fails the gate', async () => {
  const root = scratchTree();
  assert.equal(generator('--check', '--root', root).status, 0, 'control: an unchanged copy matches');
  appendFileSync(join(root, 'lib/passport/rules.mjs'), ' ');
  const stale = generator('--check', '--root', root);
  assert.equal(stale.status, 2);
  assert.match(stale.stdout, /REFUSE lib\/passport\/gate-manifest\.mjs is stale/);
  const next = await manifest(root);
  assert.notEqual(next.gateIdentitySha256, committed.GATE_IDENTITY_SHA256);
  assert.notEqual(next.manifestSha256, committed.MANIFEST_SHA256);
  assert.equal(next.adapterLockSha256, committed.ADAPTER_LOCK_SHA256);
  assert.equal(generator('--root', root).status, 0);
  assert.equal(generator('--check', '--root', root).status, 0, 'regenerated, the copy matches again');
});

test('case 24: a changed byte in assemble.mjs, whose folding decides route verdicts, moves the identity too', async () => {
  const root = scratchTree();
  appendFileSync(join(root, 'lib/passport/assemble.mjs'), ' ');
  assert.notEqual((await manifest(root)).gateIdentitySha256, committed.GATE_IDENTITY_SHA256);
});

test('case 24 control: a file off the graph (render.mjs) does not move the identity', async () => {
  const root = scratchTree();
  appendFileSync(join(root, 'lib/passport/render.mjs'), ' ');
  assert.equal((await manifest(root)).gateIdentitySha256, committed.GATE_IDENTITY_SHA256);
});

test('case 24: a module the gate newly reaches joins the manifest', async () => {
  const root = scratchTree();
  writeFileSync(join(root, 'lib/passport/extra.mjs'), 'export const x = 1;\n');
  const path = join(root, 'lib/passport/canonical.mjs');
  writeFileSync(path, `import './extra.mjs';\n${readFileSync(path, 'utf8')}`);
  const m = await manifest(root);
  assert.ok(m.rows.some(([p]) => p === 'lib/passport/extra.mjs'));
  assert.notEqual(m.gateIdentitySha256, committed.GATE_IDENTITY_SHA256);
});

test('case 24: a computed dynamic reference in a gate file is refused, so no manifest is written for a hidden graph', () => {
  const root = scratchTree();
  appendFileSync(join(root, 'lib/passport/rules.mjs'), "\nconst hidden = 'render.mjs';\nawait import(hidden);\n");
  const r = generator('--root', root);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /REFUSE gate-manifest: lib\/passport\/rules\.mjs:\d+ dynamic import without a single string literal/);
});
