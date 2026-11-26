/* Runs the bash regression suite for the setup script under node:test so the existing
   check.sh node:test gate picks it up. The suite builds its own stub executables in a temp
   directory and touches no real checkout, the shared stack or any global setting. The
   bash output is attached to the assertion message on failure. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function runSuite(file) {
  const result = spawnSync('bash', [join(HERE, file)], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.status, 0, `${file} exited ${result.status}:\n${output}`);
  assert.match(output, /, 0 failed \(/, `${file} reported failures:\n${output}`);
}

test('setup-worktree.sh: Node gate, idempotent install, stack observed not changed (stub node, npm, supabase, docker)', () => {
  runSuite('setup-worktree.test.sh');
});
