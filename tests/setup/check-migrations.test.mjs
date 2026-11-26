/* scripts/check-migrations.mjs: it must refuse the exact thing that happened on
   2026-09-13, an edit to an already-accepted migration, and it must not refuse an
   added one that brings its own pin. */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkMigrations, PINNED } from '../../scripts/check-migrations.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA_OF_A = '87428fc522803d31065e7bce3cf03fe475096631e5e07bbd7a0fde60c4cf25c7';

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'mig-'));
  mkdirSync(join(root, 'supabase', 'migrations'), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, 'supabase', 'migrations', name), body);
  return root;
}

test('the real tree passes its own pins', () => {
  const { problems } = checkMigrations(process.cwd());
  assert.deepEqual(problems, []);
});

test('editing an accepted migration is refused, which is the 2026-09-13 counterexample', () => {
  const root = tree({ '001_identity.sql': 'a\n' });
  const pins = { '001_identity.sql': SHA_OF_A };
  assert.deepEqual(checkMigrations(root, pins).problems, [], 'control: the unedited file passes');

  writeFileSync(join(root, 'supabase', 'migrations', '001_identity.sql'), 'a\n-- one added line\n');
  const { problems } = checkMigrations(root, pins);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].path, '001_identity.sql');
  assert.match(problems[0].rule, /accepted migration changed/);
  assert.match(problems[0].rule, /Add a numbered migration instead/);
  rmSync(root, { recursive: true, force: true });
});

test('an added migration must bring its own pin, and passes once it has one', () => {
  const root = tree({ '001_identity.sql': 'a\n', '002_bound_principal.sql': 'a\n' });
  const unpinned = checkMigrations(root, { '001_identity.sql': SHA_OF_A });
  assert.equal(unpinned.problems.length, 1);
  assert.equal(unpinned.problems[0].path, '002_bound_principal.sql');
  assert.match(unpinned.problems[0].rule, /not pinned/);

  const pinned = checkMigrations(root, { '001_identity.sql': SHA_OF_A, '002_bound_principal.sql': SHA_OF_A });
  assert.deepEqual(pinned.problems, []);
  rmSync(root, { recursive: true, force: true });
});

test('a pin whose file has gone is refused', () => {
  const root = tree({ '001_identity.sql': 'a\n' });
  const { problems } = checkMigrations(root, { '001_identity.sql': SHA_OF_A, '002_bound_principal.sql': SHA_OF_A });
  assert.equal(problems.length, 1);
  assert.match(problems[0].rule, /missing from the tree/);
  rmSync(root, { recursive: true, force: true });
});

test('the shipped pins name the migrations actually present', () => {
  /* Twice a lane added a migration with its pin and this test failed the full suite, because it compared the pins with a
     literal list that nobody had been told to extend (007 at 3c2275d, 008 on 4cbcbd1). It now does what its title says:
     the pins equal the files in supabase/migrations, numbered from 001 without a gap. The literal list stays as a
     floor and not as an equality, so a new migration needs no third edit while an accepted one that disappears together
     with its pin still fails here. */
  const present = readdirSync(join(REPO, 'supabase', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.deepEqual(Object.keys(PINNED).sort(), present);
  for (const [i, name] of present.entries()) assert.equal(name.slice(0, 4), `${String(i + 1).padStart(3, '0')}_`, name);
  for (const accepted of [
    '001_identity.sql',
    '002_bound_principal.sql',
    '003_content.sql',
    '004_content_rules_and_profiles.sql',
    '005_invitations_aal2.sql',
    '006_reviews_releases.sql',
    '007_installations.sql',
  ])
    assert.ok(present.includes(accepted), `${accepted} is an accepted migration and is present`);
});
