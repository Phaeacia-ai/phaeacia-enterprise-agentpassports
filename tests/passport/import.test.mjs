/* Importer regressions of docs/e1/passport-adapter.md section 8: rows 1, 1b,
   2, 2b, 6, 7 and the recheck invariants R1, R2 and R3 (section 3a, recovery
   table 3b). Every case runs the real script as a child process against an
   isolated scratch workspace built from a fixture archive; the repository's own
   vendor tree and lock are never touched. */

import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FAIL_POINTS, OWNED } from '../../scripts/import-passport.mjs';
import { fixtureEntries, freshDir, importFixture, makeTar, runImporter, sha256, snapshot } from './helpers.mjs';

const COMMIT = 'f'.repeat(40);

function writeTar(dir, entries, name = 'fixture.tar') {
  const path = join(dir, name);
  writeFileSync(path, makeTar(entries));
  return path;
}

/* A workspace with one completed import of the standard fixture. */
function importedWorkspace(name, overrides = {}) {
  const dir = freshDir(name);
  const tar = writeTar(dir, fixtureEntries(overrides));
  const ws = join(dir, 'ws');
  mkdirSync(ws);
  const r = importFixture(ws, tar, ['--update']);
  assert.equal(r.code, 0, r.out);
  return { dir, ws, tar };
}

function verify(ws) {
  return runImporter(['--verify', '--workspace', ws]);
}

function lock(ws) {
  return JSON.parse(readFileSync(join(ws, OWNED.lock), 'utf8'));
}

function lockBytes(ws) {
  return readFileSync(join(ws, OWNED.lock));
}

test('first import stages the allowlisted subset, verifies, and re-import is byte-stable (row 7)', () => {
  const { ws, tar } = importedWorkspace('import-basic');
  const l = lock(ws);
  assert.equal(l.status, 'COMPLETE');
  assert.ok(Object.hasOwn(l.imported, 'installer/core.md'));
  assert.ok(Object.hasOwn(l.imported, 'web/lib/_metrics.mjs'), 'test-only file staged');
  assert.ok(!Object.hasOwn(l.imported, 'README.md'), 'non-allowlisted file not staged');
  assert.ok(!Object.hasOwn(l.imported, 'web/lib/_store.mjs'));
  assert.ok(!existsSync(join(ws, 'vendor/passport/README.md')));
  assert.equal(l.imported_count, Object.keys(l.imported).length);
  assert.equal(l.source_inventory_count, 21);
  assert.equal(verify(ws).code, 0);
  const before = lockBytes(ws);
  const again = importFixture(ws, tar);
  assert.equal(again.code, 0, again.out);
  assert.ok(lockBytes(ws).equals(before), 'same-pin re-import must leave the lock byte-identical');
  assert.deepEqual(snapshot(join(ws, 'vendor')).includes('.passport'), false, 'no residual after a completed import');
  /* Deterministic form: sorted keys, two-space indent, trailing newline. */
  const text = before.toString('utf8');
  assert.ok(text.endsWith('}\n'));
  assert.ok(text.startsWith('{\n  "allowlist"'));
  assert.ok(!/started|timestamp|cwd|node_version|interpreter/.test(text));
});

test('import refuses a different archive without --update and names the difference', () => {
  const { dir, ws } = importedWorkspace('import-drift');
  const changed = writeTar(dir, fixtureEntries({ 'installer/core.md': 'changed core\n' }), 'changed.tar');
  const r = importFixture(ws, changed);
  assert.equal(r.code, 2);
  assert.match(r.out, /archive SHA-256 .* does not equal/);
  assert.equal(verify(ws).code, 0, 'accepted pair untouched');
  const other = importFixture(ws, changed, ['--commit', 'e'.repeat(40)]);
  assert.equal(other.code, 2);
  assert.match(other.out, /differs from the lock/);
});

test('row 2: an archive with a symlink or hard link is refused at the extraction boundary, before any write', () => {
  const dir = freshDir('import-archive-link');
  const ws = join(dir, 'ws');
  mkdirSync(ws);
  for (const [name, entry] of [
    ['symlink', { path: 'examples', type: 'symlink', target: '/etc' }],
    ['hardlink', { path: 'examples/daily-brief-passport.md', type: 'hardlink', target: 'LICENSE' }],
    ['fifo', { path: 'tools/pipe', type: 'fifo' }],
  ]) {
    const entries = fixtureEntries().filter((e) => !(name === 'symlink' && e.path.startsWith('examples')));
    entries.push(entry);
    const tar = writeTar(dir, entries, `${name}.tar`);
    const before = snapshot(ws);
    const r = importFixture(ws, tar, ['--update']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, new RegExp(`refused archive entry kind (symlink|hard link|fifo): ${entry.path}`));
    assert.equal(snapshot(ws), before, `${name}: nothing written to the workspace`);
    assert.equal(snapshot(ws), '', 'workspace stays empty');
  }
  /* Control: the same fixture with a regular directory proceeds to staging and completes. */
  const good = writeTar(dir, fixtureEntries(), 'good.tar');
  const ok = importFixture(ws, good, ['--update']);
  assert.equal(ok.code, 0, ok.out);
  assert.equal(verify(ws).code, 0);
});

test('archive inventory: an added, missing or changed source file is refused by name', () => {
  const { dir, ws } = importedWorkspace('import-inventory');
  const l = lock(ws);
  /* Same commit and same declared archive hash cannot be forged for a changed
     tar, so feed a lock whose archive hash matches a tar that differs from the
     recorded inventory: edit the lock's inventory instead. */
  const edited = { ...l, source_inventory: { ...l.source_inventory } };
  delete edited.source_inventory['tools/validate.py'];
  edited.source_inventory['tools/extra.py'] = sha256('x');
  edited.source_inventory.LICENSE = sha256('y');
  edited.source_inventory_count = Object.keys(edited.source_inventory).length;
  writeFileSync(join(ws, OWNED.lock), `${JSON.stringify(edited, null, 2)}\n`);
  const tar = join(dir, 'fixture.tar');
  const r = importFixture(ws, tar);
  assert.equal(r.code, 2);
  assert.match(r.out, /missing from archive: tools\/extra\.py/);
  assert.match(r.out, /added in archive: tools\/validate\.py/);
  assert.match(r.out, /changed in archive: LICENSE/);
  assert.ok(!existsSync(join(ws, OWNED.journal)), 'refused before the journal');
});

test('row 1 and R1: verify refuses each unexpected or missing entry with path and kind, and the valid tree passes', () => {
  const { ws } = importedWorkspace('verify-r1');
  const live = join(ws, OWNED.live);
  const cases = [
    {
      name: 'row 1: added file tools/datetime.py',
      apply: () => writeFileSync(join(live, 'tools/datetime.py'), 'x'),
      undo: () => rmSync(join(live, 'tools/datetime.py')),
      expect: /unexpected file: tools\/datetime\.py/,
    },
    {
      name: 'R1: extra empty directory',
      apply: () => mkdirSync(join(live, 'tools/empty')),
      undo: () => rmSync(join(live, 'tools/empty'), { recursive: true }),
      expect: /unexpected directory: tools\/empty/,
    },
    {
      name: 'R1: missing imported file',
      apply: () => renameSync(join(live, 'LICENSE'), join(ws, 'LICENSE.aside')),
      undo: () => renameSync(join(ws, 'LICENSE.aside'), join(live, 'LICENSE')),
      expect: /missing file: LICENSE/,
    },
    {
      name: 'R1: changed imported file',
      apply: () => writeFileSync(join(live, 'NOTICE'), 'notice!\n'),
      undo: () => writeFileSync(join(live, 'NOTICE'), 'notice\n'),
      expect: /changed file: NOTICE/,
    },
    {
      name: 'row 2b and R1: symlink at a file position',
      apply: () => symlinkSync('/etc/hosts', join(live, 'tools/link')),
      undo: () => rmSync(join(live, 'tools/link')),
      expect: /symlink: tools\/link/,
    },
    {
      name: 'R1: symlink at a directory position, with the same bytes behind it',
      apply: () => {
        renameSync(join(live, 'examples'), join(ws, 'examples.aside'));
        symlinkSync(join(ws, 'examples.aside'), join(live, 'examples'));
      },
      undo: () => {
        rmSync(join(live, 'examples'));
        renameSync(join(ws, 'examples.aside'), join(live, 'examples'));
      },
      expect: /symlink: examples\n/,
    },
    {
      name: 'R1: symlink at the root, with the same bytes behind it',
      apply: () => {
        renameSync(live, join(ws, 'passport.aside'));
        symlinkSync(join(ws, 'passport.aside'), live);
      },
      undo: () => {
        rmSync(live);
        renameSync(join(ws, 'passport.aside'), live);
      },
      expect: /symlink at root/,
    },
  ];
  for (const c of cases) {
    c.apply();
    const r = verify(ws);
    assert.equal(r.code, 2, `${c.name}: must fail`);
    assert.match(r.out, c.expect, c.name);
    c.undo();
    assert.equal(verify(ws).code, 0, `${c.name}: control must pass after undo`);
  }
});

test('row 1b: verify writes nothing on a passing and on a failing run', () => {
  const { ws } = importedWorkspace('verify-nowrite');
  const before = snapshot(ws);
  assert.equal(verify(ws).code, 0);
  assert.equal(snapshot(ws), before);
  writeFileSync(join(ws, OWNED.live, 'tools/datetime.py'), 'x');
  const beforeFail = snapshot(ws);
  assert.equal(verify(ws).code, 2);
  assert.equal(snapshot(ws), beforeFail);
});

test('verify refuses lock inconsistencies and residual state without writing', () => {
  const { ws } = importedWorkspace('verify-lock');
  const good = lockBytes(ws);
  const l = lock(ws);
  writeFileSync(join(ws, OWNED.lock), JSON.stringify({ ...l, imported_count: 1 }));
  let r = verify(ws);
  assert.equal(r.code, 2);
  assert.match(r.out, /imported_count disagrees/);
  writeFileSync(join(ws, OWNED.lock), JSON.stringify({ ...l, test_only_paths: ['nope.mjs'] }));
  assert.match(verify(ws).out, /test_only path not imported: nope\.mjs/);
  writeFileSync(join(ws, OWNED.lock), good);
  for (const k of ['staging', 'previous']) {
    mkdirSync(join(ws, OWNED[k]));
    r = verify(ws);
    assert.equal(r.code, 2);
    assert.match(r.out, new RegExp(`residual import state: ${OWNED[k].replace('.', '\\.')}`));
    rmSync(join(ws, OWNED[k]), { recursive: true });
  }
  assert.equal(verify(ws).code, 0);
});

/* ---------- R3 ---------- */

function addDerived(ws, content = 'derived renderer\n') {
  const l = lock(ws);
  mkdirSync(join(ws, 'lib/passport'), { recursive: true });
  writeFileSync(join(ws, 'lib/passport/render.mjs'), content);
  l.derived = [
    {
      path: 'lib/passport/render.mjs',
      from: 'web/lib/_validate.mjs',
      from_sha256: l.imported['web/lib/_validate.mjs'],
      derived_sha256: sha256(content),
      reviewed_by: 'test fixture',
      on: '2026-09-10',
    },
  ];
  writeFileSync(join(ws, OWNED.lock), `${JSON.stringify(l, null, 2)}\n`);
  return l;
}

test('R3: a one-byte derived change with vendor unchanged fails verify, and re-import does not bless it', () => {
  const { ws, tar } = importedWorkspace('derived-r3');
  addDerived(ws);
  assert.equal(verify(ws).code, 0, 'accepted derived file passes');
  /* Same-pin re-import preserves the provenance verbatim. */
  assert.equal(importFixture(ws, tar).code, 0);
  assert.equal(lock(ws).derived[0].reviewed_by, 'test fixture');
  assert.equal(verify(ws).code, 0);
  writeFileSync(join(ws, 'lib/passport/render.mjs'), 'derived renderer!\n');
  let r = verify(ws);
  assert.equal(r.code, 2);
  assert.match(r.out, /derived file changed: lib\/passport\/render\.mjs/);
  const storedBefore = lock(ws).derived[0].derived_sha256;
  r = importFixture(ws, tar);
  assert.equal(r.code, 2, 'the new pair does not verify; the import must refuse and restore');
  assert.match(r.out, /derived file changed/);
  assert.equal(lock(ws).derived[0].derived_sha256, storedBefore, 're-import must not refresh the stored hash');
  assert.equal(verify(ws).code, 2, 'drift stays visible');
  assert.equal(snapshot(join(ws, 'vendor')).includes('.passport'), false, 'restore left no residual');
  writeFileSync(join(ws, 'lib/passport/render.mjs'), 'derived renderer\n');
  assert.equal(verify(ws).code, 0, 'restored derived file passes');
});

test('R3: missing and symlinked derived paths and an unconfined path are refused', () => {
  const { ws } = importedWorkspace('derived-r3-kinds');
  addDerived(ws);
  renameSync(join(ws, 'lib/passport/render.mjs'), join(ws, 'render.aside'));
  assert.match(verify(ws).out, /missing derived file: lib\/passport\/render\.mjs/);
  symlinkSync(join(ws, 'render.aside'), join(ws, 'lib/passport/render.mjs'));
  assert.match(verify(ws).out, /symlink at derived path: lib\/passport\/render\.mjs/);
  rmSync(join(ws, 'lib/passport/render.mjs'));
  renameSync(join(ws, 'render.aside'), join(ws, 'lib/passport/render.mjs'));
  assert.equal(verify(ws).code, 0);
  const l = lock(ws);
  l.derived[0].path = '../outside.mjs';
  writeFileSync(join(ws, OWNED.lock), JSON.stringify(l));
  assert.match(verify(ws).out, /unsafe derived path: \.\.\/outside\.mjs/);
  l.derived[0].path = 'lib/passport/render.mjs';
  l.derived[0].from_sha256 = sha256('other');
  writeFileSync(join(ws, OWNED.lock), JSON.stringify(l));
  assert.match(verify(ws).out, /derived source hash changed: lib\/passport\/render\.mjs/);
});

test('R3: --update whose new source changes a derived entry is refused with the accepted pair restored', () => {
  const { dir, ws } = importedWorkspace('derived-update');
  addDerived(ws);
  const acceptedLock = lockBytes(ws);
  const changed = writeTar(
    dir,
    fixtureEntries({ 'web/lib/_validate.mjs': 'export const SECRETS = [1];\n' }),
    'changed.tar',
  );
  const r = importFixture(ws, changed, ['--update']);
  assert.equal(r.code, 2);
  assert.match(r.out, /derived source changed in the new pin/);
  assert.ok(lockBytes(ws).equals(acceptedLock));
  assert.equal(verify(ws).code, 0);
});

/* ---------- R2 ---------- */

function acceptedPairSurvives(ws, acceptedLockHash, acceptedTree) {
  /* Either the live pair or the previous pair must be the accepted one. */
  const liveLock = existsSync(join(ws, OWNED.lock)) ? sha256(readFileSync(join(ws, OWNED.lock))) : null;
  const savedLock = existsSync(join(ws, OWNED.savedLock)) ? sha256(readFileSync(join(ws, OWNED.savedLock))) : null;
  const liveTree = existsSync(join(ws, OWNED.live)) ? snapshot(join(ws, OWNED.live)) : null;
  const prevTree = existsSync(join(ws, OWNED.previous)) ? snapshot(join(ws, OWNED.previous)) : null;
  const liveIsAccepted = liveLock === acceptedLockHash && liveTree === acceptedTree;
  const prevIsAccepted = savedLock === acceptedLockHash && prevTree === acceptedTree;
  const liveTreeAcceptedSavedLock = savedLock === acceptedLockHash && liveTree === acceptedTree;
  return liveIsAccepted || prevIsAccepted || liveTreeAcceptedSavedLock;
}

test('row 6 and R2: interruption after every fallible step keeps the accepted pair, is visible, and the next run converges', () => {
  const { dir, ws } = importedWorkspace('r2-interrupt');
  /* Move the pin so the second import is a real replacement, not a no-op. */
  const nextTar = writeTar(
    dir,
    fixtureEntries({ 'installer/core.md': 'core v2\n', 'tools/fixtures/new.md': 'new\n' }),
    'next.tar',
  );
  const acceptedLockHash = sha256(lockBytes(ws));
  const acceptedTree = snapshot(join(ws, OWNED.live));
  const steps = FAIL_POINTS.filter((p) => !p.startsWith('recovery-'));
  for (const step of steps) {
    /* Reset to the accepted state. */
    const back = importFixture(ws, join(dir, 'fixture.tar'), ['--update']);
    assert.equal(back.code, 0, back.out);
    assert.equal(sha256(lockBytes(ws)), acceptedLockHash);
    const r = importFixture(ws, nextTar, ['--update', '--fail-after', step]);
    assert.equal(r.code, 70, `${step}: ${r.out}`);
    assert.ok(existsSync(join(ws, OWNED.journal)), `${step}: journal must exist after the interruption`);
    const v = verify(ws);
    assert.equal(v.code, 2, `${step}: verify must fail while the journal exists`);
    assert.match(v.out, /residual import state: vendor\/\.passport\.journal\.json/);
    const newPairInstalled = ['lock-rename', 'verify', 'previous-cleanup', 'saved-lock-cleanup'].includes(step);
    if (!newPairInstalled)
      assert.ok(acceptedPairSurvives(ws, acceptedLockHash, acceptedTree), `${step}: accepted pair must survive`);
    else
      assert.ok(
        step === 'previous-cleanup' || step === 'saved-lock-cleanup' || existsSync(join(ws, OWNED.previous)),
        `${step}: previous tree kept until verification`,
      );
    const again = importFixture(ws, nextTar, ['--update']);
    assert.equal(again.code, 0, `${step}: recovery run must converge: ${again.out}`);
    assert.equal(verify(ws).code, 0, `${step}: converged pair verifies`);
    assert.ok(Object.hasOwn(lock(ws).imported, 'tools/fixtures/new.md'), `${step}: converged to the new pin`);
    assert.equal(snapshot(join(ws, 'vendor')).includes('.passport'), false, `${step}: no residual`);
    const stable = lockBytes(ws);
    assert.equal(importFixture(ws, nextTar).code, 0);
    assert.ok(lockBytes(ws).equals(stable), `${step}: a further run is a byte-identical no-op`);
  }
});

test('R2: a failed post-install verification restores the accepted pair', () => {
  const { dir, ws } = importedWorkspace('r2-verify-fail');
  const nextTar = writeTar(dir, fixtureEntries({ 'installer/core.md': 'core v2\n' }), 'next.tar');
  const acceptedLock = lockBytes(ws);
  const acceptedTree = snapshot(join(ws, OWNED.live));
  const r = importFixture(ws, nextTar, ['--update', '--test-corrupt-after-install', 'installer/core.md']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /new pair failed verification; accepted pair restored/);
  assert.match(r.out, /changed file: installer\/core\.md/);
  assert.ok(lockBytes(ws).equals(acceptedLock));
  assert.equal(snapshot(join(ws, OWNED.live)), acceptedTree);
  assert.equal(verify(ws).code, 0);
});

test('R2: first import with no old tree interrupted after each step, then converging', () => {
  const dir = freshDir('r2-first');
  const tar = writeTar(dir, fixtureEntries());
  for (const step of [
    'journal',
    'staging',
    'staged-lock',
    'live-rename',
    'lock-rename',
    'verify',
    'saved-lock-cleanup',
  ]) {
    const ws = join(dir, `ws-${step}`);
    mkdirSync(ws);
    const r = importFixture(ws, tar, ['--update', '--fail-after', step]);
    assert.equal(r.code, 70, `${step}: ${r.out}`);
    assert.ok(!existsSync(join(ws, OWNED.previous)), `${step}: no previous tree on a first import`);
    assert.ok(!existsSync(join(ws, OWNED.savedLock)), `${step}: no saved lock on a first import`);
    assert.equal(verify(ws).code, 2);
    const again = importFixture(ws, tar, ['--update']);
    assert.equal(again.code, 0, `${step}: ${again.out}`);
    assert.equal(verify(ws).code, 0);
  }
});

test('R2: residual staging, previous, or both without a journal are refused without deletion', () => {
  const { ws, tar } = importedWorkspace('r2-residual');
  const marker = 'do not delete me\n';
  for (const dirs of [['staging'], ['previous'], ['staging', 'previous']]) {
    for (const d of dirs) {
      mkdirSync(join(ws, OWNED[d]));
      writeFileSync(join(ws, OWNED[d], 'marker.txt'), marker);
    }
    const before = snapshot(ws);
    const r = importFixture(ws, tar);
    assert.equal(r.code, 2, dirs.join('+'));
    assert.match(r.out, /residual state without a journal; identity cannot be established/);
    for (const d of dirs) assert.match(r.out, new RegExp(OWNED[d].replace(/\./g, '\\.')));
    assert.equal(snapshot(ws), before, `${dirs.join('+')}: nothing deleted or written`);
    for (const d of dirs) rmSync(join(ws, OWNED[d]), { recursive: true });
  }
  assert.equal(verify(ws).code, 0);
});

test('R2: a journal whose identities do not match the observed files is refused without deletion', () => {
  const { ws, tar } = importedWorkspace('r2-unknown');
  const l = lockBytes(ws);
  mkdirSync(join(ws, OWNED.previous));
  writeFileSync(join(ws, OWNED.previous, 'x'), 'x');
  writeFileSync(join(ws, OWNED.savedLock), l);
  writeFileSync(
    join(ws, OWNED.journal),
    JSON.stringify({
      commit: COMMIT,
      archive_sha256: 'x',
      old_lock_sha256: 'a'.repeat(64),
      new_lock_sha256: null,
      old_tree_present: true,
      phase: 'previous-rename',
    }),
  );
  const before = snapshot(ws);
  const r = importFixture(ws, tar);
  assert.equal(r.code, 2);
  assert.match(r.out, /recovery refused: the live lock matches neither the accepted nor the new identity/);
  assert.equal(snapshot(ws), before, 'nothing deleted');
  /* Live lock is the accepted one but the saved lock is not. */
  writeFileSync(join(ws, OWNED.savedLock), `${l.toString('utf8')}\n`);
  writeFileSync(
    join(ws, OWNED.journal),
    JSON.stringify({
      commit: COMMIT,
      archive_sha256: 'x',
      old_lock_sha256: sha256(l),
      new_lock_sha256: null,
      old_tree_present: true,
      phase: 'previous-rename',
    }),
  );
  const before2 = snapshot(ws);
  const r2 = importFixture(ws, tar);
  assert.equal(r2.code, 2);
  assert.match(r2.out, /recovery refused: the saved lock does not match the accepted lock identity/);
  assert.equal(snapshot(ws), before2, 'nothing deleted');
  /* Accepted tree recorded present, but neither live nor previous tree exists. */
  writeFileSync(join(ws, OWNED.savedLock), l);
  rmSync(join(ws, OWNED.previous), { recursive: true });
  renameSync(join(ws, OWNED.live), join(ws, 'live.aside'));
  const before3 = snapshot(ws);
  const r3 = importFixture(ws, tar);
  assert.equal(r3.code, 2);
  assert.match(r3.out, /the accepted tree is missing and no previous tree exists/);
  assert.equal(snapshot(ws), before3, 'nothing deleted');
});

test('R2: a second recovery run after an interrupted recovery converges', () => {
  const { dir, ws } = importedWorkspace('r2-recover-twice');
  const nextTar = writeTar(dir, fixtureEntries({ 'installer/core.md': 'core v2\n' }), 'next.tar');
  const acceptedLockHash = sha256(lockBytes(ws));
  const acceptedTree = snapshot(join(ws, OWNED.live));
  for (const recoveryStep of ['recovery-live-to-staging', 'recovery-previous-restore', 'recovery-lock-restore']) {
    importFixture(ws, join(dir, 'fixture.tar'), ['--update']);
    /* Interrupt the swap so that recovery has to move trees. */
    assert.equal(importFixture(ws, nextTar, ['--update', '--fail-after', 'live-rename']).code, 70);
    /* Interrupt the recovery itself. */
    const r = importFixture(ws, nextTar, ['--update', '--fail-after', recoveryStep]);
    assert.equal(r.code, 70, `${recoveryStep}: ${r.out}`);
    assert.ok(
      acceptedPairSurvives(ws, acceptedLockHash, acceptedTree),
      `${recoveryStep}: accepted pair survives the interrupted recovery`,
    );
    assert.equal(verify(ws).code, 2);
    const again = importFixture(ws, nextTar, ['--update']);
    assert.equal(again.code, 0, `${recoveryStep}: ${again.out}`);
    assert.equal(verify(ws).code, 0);
    assert.equal(snapshot(join(ws, 'vendor')).includes('.passport'), false);
  }
});

test('test hooks are refused in the repository workspace', () => {
  const r = runImporter(['--fail-after', 'journal']);
  assert.equal(r.code, 2);
  assert.match(r.out, /test hooks are refused in the repository workspace/);
});

test('a vendor tree without a lock is refused rather than adopted', () => {
  const dir = freshDir('nolock');
  const ws = join(dir, 'ws');
  mkdirSync(join(ws, OWNED.live), { recursive: true });
  writeFileSync(join(ws, OWNED.live, 'x'), 'x');
  const tar = writeTar(dir, fixtureEntries());
  const before = snapshot(ws);
  const r = importFixture(ws, tar, ['--update']);
  assert.equal(r.code, 2);
  assert.match(r.out, /vendor tree exists without a lock/);
  assert.equal(snapshot(ws), before);
});

/* ---------- H1 corrections (evidence/e1-adapter-critique.md, 2026-09-10) ---------- */

/* The critic's two executed states: a new pair is live (interrupted after the
   lock rename), the new tree is then corrupted so verification fails, and the
   rollback that the next run performs is itself interrupted after each of its
   renames. The following ordinary run must converge, first back to the
   accepted pair (same-pin run, byte-identical lock and tree), then forward to
   the new pin. Before the fix both retries exited 2. */
test('H1: an interrupted rollback of a corrupted new pair converges on the next ordinary run', () => {
  const { dir, ws } = importedWorkspace('h1-rollback');
  const nextTar = writeTar(dir, fixtureEntries({ 'installer/core.md': 'core v2\n' }), 'next.tar');
  const acceptedLock = lockBytes(ws);
  const acceptedTree = snapshot(join(ws, OWNED.live));
  for (const step of ['recovery-live-to-staging', 'recovery-previous-restore', 'recovery-lock-restore']) {
    const back = importFixture(ws, join(dir, 'fixture.tar'), ['--update']);
    assert.equal(back.code, 0, back.out);
    assert.ok(lockBytes(ws).equals(acceptedLock));
    assert.equal(importFixture(ws, nextTar, ['--update', '--fail-after', 'lock-rename']).code, 70);
    writeFileSync(join(ws, OWNED.live, 'installer/core.md'), 'corrupt\n', { flag: 'a' });
    const r = importFixture(ws, nextTar, ['--update', '--fail-after', step]);
    assert.equal(r.code, 70, `${step}: ${r.out}`);
    assert.ok(
      acceptedPairSurvives(ws, sha256(acceptedLock), acceptedTree),
      `${step}: accepted pair survives the interrupted rollback`,
    );
    assert.equal(verify(ws).code, 2, `${step}: residual state is visible`);
    /* Same-pin ordinary run: recovery restores the accepted pair, then the
       re-import is a byte-identical no-op. */
    const same = importFixture(ws, join(dir, 'fixture.tar'));
    assert.equal(same.code, 0, `${step}: same-pin run after the interrupted rollback: ${same.out}`);
    assert.ok(lockBytes(ws).equals(acceptedLock), `${step}: accepted lock byte-identical`);
    assert.equal(snapshot(join(ws, OWNED.live)), acceptedTree, `${step}: accepted tree byte-identical`);
    assert.equal(verify(ws).code, 0);
    assert.equal(snapshot(join(ws, 'vendor')).includes('.passport'), false, `${step}: no residual`);
    /* Forward run to the new pin converges too. */
    const fwd = importFixture(ws, nextTar, ['--update']);
    assert.equal(fwd.code, 0, `${step}: ${fwd.out}`);
    assert.equal(verify(ws).code, 0);
    assert.equal(lock(ws).imported['installer/core.md'], sha256('core v2\n'));
  }
});

test('H1: the immediate rollback at a failed verification is journaled and resumable at each rename', () => {
  const { dir, ws } = importedWorkspace('h1-immediate');
  const nextTar = writeTar(dir, fixtureEntries({ 'installer/core.md': 'core v2\n' }), 'next.tar');
  const acceptedLock = lockBytes(ws);
  const acceptedTree = snapshot(join(ws, OWNED.live));
  for (const step of ['recovery-live-to-staging', 'recovery-previous-restore', 'recovery-lock-restore']) {
    const back = importFixture(ws, join(dir, 'fixture.tar'), ['--update']);
    assert.equal(back.code, 0, back.out);
    const r = importFixture(ws, nextTar, [
      '--update',
      '--test-corrupt-after-install',
      'installer/core.md',
      '--fail-after',
      step,
    ]);
    assert.equal(r.code, 70, `${step}: ${r.out}`);
    assert.ok(existsSync(join(ws, OWNED.journal)), `${step}: journal exists during the immediate rollback`);
    assert.ok(acceptedPairSurvives(ws, sha256(acceptedLock), acceptedTree), `${step}: accepted pair survives`);
    const same = importFixture(ws, join(dir, 'fixture.tar'));
    assert.equal(same.code, 0, `${step}: ${same.out}`);
    assert.ok(lockBytes(ws).equals(acceptedLock), `${step}: accepted lock byte-identical`);
    assert.equal(snapshot(join(ws, OWNED.live)), acceptedTree, `${step}: accepted tree byte-identical`);
    assert.equal(snapshot(join(ws, 'vendor')).includes('.passport'), false, `${step}: no residual`);
  }
});

/* First import (no accepted pair) whose new pair fails verification and whose
   rollback is interrupted: there is no previous tree, so the rollback removes
   the new lock instead of restoring one. */
test('H1: an interrupted rollback on a first import converges to the empty workspace', () => {
  const dir = freshDir('h1-first-rollback');
  const tar = writeTar(dir, fixtureEntries());
  for (const step of ['recovery-live-to-staging', 'recovery-lock-restore']) {
    const ws = join(dir, `ws-${step}`);
    mkdirSync(ws);
    const r = importFixture(ws, tar, ['--update', '--test-corrupt-after-install', 'LICENSE', '--fail-after', step]);
    assert.equal(r.code, 70, `${step}: ${r.out}`);
    const again = importFixture(ws, tar, ['--update']);
    assert.equal(again.code, 0, `${step}: ${again.out}`);
    assert.equal(verify(ws).code, 0);
  }
});

/* The initialization window: at c0ed5a2 the accepted lock was copied to the
   saved-lock path before the journal existed, so an interruption between the
   two left residual state the next run refused. The journal now precedes the
   copy; both interruption points are fail points and must converge. */
test('H1: interruption between the journal and the saved-lock copy converges, and no saved lock ever exists without a journal', () => {
  const { dir, ws } = importedWorkspace('h1-init');
  const nextTar = writeTar(dir, fixtureEntries({ 'installer/core.md': 'core v2\n' }), 'next.tar');
  const acceptedLock = lockBytes(ws);
  for (const step of ['journal', 'saved-lock']) {
    const back = importFixture(ws, join(dir, 'fixture.tar'), ['--update']);
    assert.equal(back.code, 0, back.out);
    const r = importFixture(ws, nextTar, ['--update', '--fail-after', step]);
    assert.equal(r.code, 70, `${step}: ${r.out}`);
    assert.ok(existsSync(join(ws, OWNED.journal)), `${step}: the journal precedes the saved-lock copy`);
    assert.equal(existsSync(join(ws, OWNED.savedLock)), step === 'saved-lock', `${step}: saved lock presence`);
    const again = importFixture(ws, join(dir, 'fixture.tar'));
    assert.equal(again.code, 0, `${step}: ${again.out}`);
    assert.ok(lockBytes(ws).equals(acceptedLock));
    assert.equal(verify(ws).code, 0);
  }
  /* Every fail point: whenever a saved lock exists, the journal exists too. */
  for (const step of FAIL_POINTS.filter((p) => !p.startsWith('recovery-'))) {
    assert.equal(importFixture(ws, join(dir, 'fixture.tar'), ['--update']).code, 0);
    assert.equal(importFixture(ws, nextTar, ['--update', '--fail-after', step]).code, 70, step);
    if (existsSync(join(ws, OWNED.savedLock))) assert.ok(existsSync(join(ws, OWNED.journal)), step);
  }
  assert.equal(importFixture(ws, nextTar, ['--update']).code, 0);
});

test('H1: the pre-journal residual the c0ed5a2 ordering produced (saved lock, no journal) is still refused without deletion', () => {
  const { ws, tar } = importedWorkspace('h1-prejournal');
  writeFileSync(join(ws, OWNED.savedLock), lockBytes(ws));
  const before = snapshot(ws);
  const r = importFixture(ws, tar);
  assert.equal(r.code, 2);
  assert.match(r.out, /residual state without a journal/);
  assert.equal(snapshot(ws), before);
});

test('H1: recovery is driven by the journal phase; an unknown phase is refused without deletion', () => {
  const { ws, tar } = importedWorkspace('h1-phase');
  const l = lockBytes(ws);
  writeFileSync(join(ws, OWNED.savedLock), l);
  writeFileSync(
    join(ws, OWNED.journal),
    JSON.stringify({
      commit: COMMIT,
      archive_sha256: 'x',
      old_lock_sha256: sha256(l),
      new_lock_sha256: null,
      old_tree_present: true,
      phase: 'not-a-phase',
    }),
  );
  const before = snapshot(ws);
  const r = importFixture(ws, tar);
  assert.equal(r.code, 2);
  assert.match(r.out, /recovery refused: unknown journal phase/);
  assert.equal(snapshot(ws), before);
});

/* ---------- R1 confinement limits raised by the critique (hard link, vendor/ parent) ---------- */

test('R1: a hard-linked imported file and a symlink at the vendor/ parent are refused; the plain tree passes', () => {
  const { ws } = importedWorkspace('r1-links');
  const live = join(ws, OWNED.live);
  linkSync(join(live, 'LICENSE'), join(ws, 'LICENSE.alias'));
  let r = verify(ws);
  assert.equal(r.code, 2, 'hard link must fail');
  assert.match(r.out, /hard link \(2 links\): LICENSE/);
  rmSync(join(ws, 'LICENSE.alias'));
  assert.equal(verify(ws).code, 0, 'control after removing the alias');
  renameSync(join(ws, 'vendor'), join(ws, 'vendor.aside'));
  symlinkSync(join(ws, 'vendor.aside'), join(ws, 'vendor'));
  r = verify(ws);
  assert.equal(r.code, 2, 'symlink at the vendor/ parent must fail');
  assert.match(r.out, /symlink at an ancestor of the live tree: vendor/);
  rmSync(join(ws, 'vendor'));
  renameSync(join(ws, 'vendor.aside'), join(ws, 'vendor'));
  assert.equal(verify(ws).code, 0, 'control after restoring the directory');
});

/* ---------- M1 corrections (evidence/e1-adapter-critique.md, 2026-09-10) ---------- */

test('M1: without --commit the default is the committed lock, with the hardcoded PIN only as bootstrap', () => {
  const { ws, tar } = importedWorkspace('m1-default-commit');
  /* At c0ed5a2 the default was always PIN.commit, so a same-pin re-import of
     a lock at another commit refused unless --commit was passed. */
  const r = runImporter(['--workspace', ws, '--archive', tar]);
  assert.equal(r.code, 0, r.out);
  assert.equal(lock(ws).commit, COMMIT);
  /* With no lock the bootstrap default is the pinned commit: the run reaches
     the "first import requires --update --commit" refusal, not an argument error. */
  const empty = freshDir('m1-empty');
  const e = runImporter(['--workspace', empty, '--archive', tar]);
  assert.equal(e.code, 2);
  assert.match(e.out, /first import requires --update --commit/);
});

/* Moving the pin when a derived source changed: --update refuses as before;
   the owner supplies a reviewed proposed derivation through --accept-derived
   <json file>, so the old accepted lock is never hand-edited. */
test('M1: --accept-derived carries a reviewed re-derivation through --update; a wrong proposal restores the accepted pair', () => {
  const { dir, ws } = importedWorkspace('m1-accept');
  addDerived(ws);
  const acceptedLock = lockBytes(ws);
  const acceptedTree = snapshot(join(ws, OWNED.live));
  const newSource = 'export const SECRETS = [1];\n';
  const changed = writeTar(dir, fixtureEntries({ 'web/lib/_validate.mjs': newSource }), 'changed.tar');
  const refused = importFixture(ws, changed, ['--update']);
  assert.equal(refused.code, 2);
  assert.match(refused.out, /derived source changed in the new pin/);
  assert.match(refused.out, /--accept-derived/);
  assert.ok(lockBytes(ws).equals(acceptedLock));
  /* A proposal whose derived hash does not match the file on disk: the new
     pair fails verification and the accepted pair is restored byte-identical. */
  const proposal = (derivedSha) => {
    const p = join(dir, 'proposed.json');
    writeFileSync(
      p,
      `${JSON.stringify(
        [
          {
            path: 'lib/passport/render.mjs',
            from: 'web/lib/_validate.mjs',
            from_sha256: sha256(newSource),
            derived_sha256: derivedSha,
            reviewed_by: 'test fixture, re-derived',
            on: '2026-09-10',
          },
        ],
        null,
        2,
      )}\n`,
    );
    return p;
  };
  const wrong = importFixture(ws, changed, ['--update', '--accept-derived', proposal(sha256('not on disk'))]);
  assert.equal(wrong.code, 2, wrong.out);
  assert.match(wrong.out, /new pair failed verification; accepted pair restored/);
  assert.match(wrong.out, /derived file changed: lib\/passport\/render\.mjs/);
  assert.ok(lockBytes(ws).equals(acceptedLock), 'accepted lock byte-identical after the failed proposal');
  assert.equal(snapshot(join(ws, OWNED.live)), acceptedTree);
  assert.equal(verify(ws).code, 0);
  /* A proposal whose from_sha256 is not the new source's hash is refused before mutation. */
  const stale = join(dir, 'stale.json');
  writeFileSync(
    stale,
    JSON.stringify([
      {
        path: 'lib/passport/render.mjs',
        from: 'web/lib/_validate.mjs',
        from_sha256: sha256('something else'),
        derived_sha256: sha256('derived renderer v2\n'),
        reviewed_by: 'x',
        on: '2026-09-10',
      },
    ]),
  );
  const before = snapshot(ws);
  const staleRun = importFixture(ws, changed, ['--update', '--accept-derived', stale]);
  assert.equal(staleRun.code, 2, staleRun.out);
  assert.match(staleRun.out, /proposed derivation source hash does not match the new pin/);
  assert.equal(snapshot(ws), before, 'refused before any write');
  /* The reviewed re-derivation: file updated on disk, proposal names its hash. */
  writeFileSync(join(ws, 'lib/passport/render.mjs'), 'derived renderer v2\n');
  const ok = importFixture(ws, changed, ['--update', '--accept-derived', proposal(sha256('derived renderer v2\n'))]);
  assert.equal(ok.code, 0, ok.out);
  assert.equal(verify(ws).code, 0);
  const l = lock(ws);
  assert.equal(l.derived.length, 1);
  assert.equal(l.derived[0].from_sha256, sha256(newSource));
  assert.equal(l.derived[0].derived_sha256, sha256('derived renderer v2\n'));
  assert.equal(l.derived[0].reviewed_by, 'test fixture, re-derived');
  assert.equal(l.imported['web/lib/_validate.mjs'], sha256(newSource));
  assert.equal(snapshot(join(ws, 'vendor')).includes('.passport'), false);
  /* Same-pin re-import without the proposal keeps the new register verbatim. */
  const again = importFixture(ws, changed);
  assert.equal(again.code, 0, again.out);
  assert.equal(lock(ws).derived[0].reviewed_by, 'test fixture, re-derived');
});
