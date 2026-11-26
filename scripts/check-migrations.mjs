#!/usr/bin/env node
/* Applied-migration integrity. Every file in supabase/migrations/ is pinned to the
   SHA-256 of its accepted bytes, and this refuses any change to one.

   Why this exists, because the rule it enforces is not obvious and cost a full
   build-and-review round on 2026-09-13. A migration that a database has already
   recorded is not a file you may edit. Supabase's ledger matches on the version
   prefix and never on the content: with 001's old bytes in a scratch project,
   `supabase migration list --local` answered `local:001, remote:001` against a
   database holding the new definition, so an edit reaches a fresh reset and never
   reaches an existing database (evidence/e3-prereq-critique.md, Finding 1). The lead
   had instructed exactly that edit, reasoning that `tests/db/00-seed.sh` resets and
   that no hosted database exists. Both were true and the conclusion was still wrong,
   because a pilot database is the case the reasoning assumed away.

   So: to change behaviour, add a numbered migration. To add one, add its file and its
   pin in the same commit, which is the deliberate act this check wants to see. To
   change an accepted file's bytes, you must edit the pin here, and that edit is the
   signal a reviewer needs and the thing that was missing.

   Exit 0 clean, 2 on findings. --root <dir> checks another tree (tests). */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* filename -> SHA-256 of the accepted bytes. Add a row when you add a migration. */
export const PINNED = Object.freeze({
  '001_identity.sql': '40208240f91c53ed35951cee85be81901b22baee585471b6a1ec9abe5273ac04',
  '002_bound_principal.sql': 'eb50bb5bac6dd22bb91b9f6cab258315328368dab2f39186ea639c8b5ed0c055',
  '003_content.sql': '9790b48abe9ee90c69d2275e39f0e2fc5ac4c16250002d0b49ca939e2f95f700',
  '004_content_rules_and_profiles.sql': 'c8d19ee82ea69a3f2444f34a1bc10d20cfb691ae2a74b3e97ab0c644bfbe44c3',
  '005_invitations_aal2.sql': 'c399d36e058995ef5b51bcb57a0197a1e4177ff04205720d5c10d75acb7d43b2',
  '006_reviews_releases.sql': '87c3474469bff34efd39d9c0c253518eee6849c5eb65e03ee2d5383b29cc1b50',
  '007_installations.sql': '7f7179e6ed3e71b007c185869ce33aab63bf1b7c5affb77a2c09709d570527d7',
  '008_lifecycle.sql': '1ab1790194a190e72c068bce917d611bc447a7dcf06cd55f0916bb8a4b145586',
  '009_recovery_hold.sql': 'd266e47fd435d9a1afea059fcf94ca5f885c400de77429af2f024c6d043fba85',
  '010_invitation_delivery.sql': 'd7049318af2112e38d184168ec340a882084082427679bca748a7169a65013bb',
  '011_invitation_standing.sql': '31833ad8911305183f081bf38fb00df5c604e3fc8636a2b8163c8fb8b78b8ad8',
  '012_mfa_route_bound.sql': 'ab612b7b6fe5b4a3b540dc0aecf451ffa1ff1c1115c1e78ad33a77de0ce3b46b',
});

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function checkMigrations(root, pinned = PINNED) {
  const problems = [];
  const dir = join(root, 'supabase', 'migrations');
  if (!existsSync(dir))
    return { problems: [{ rule: 'missing supabase/migrations', path: 'supabase/migrations' }], count: 0 };
  const present = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const name of present) {
    const expected = pinned[name];
    if (expected === undefined) {
      problems.push({ rule: 'migration is not pinned; add its SHA-256 to scripts/check-migrations.mjs', path: name });
      continue;
    }
    const actual = sha256(readFileSync(join(dir, name)));
    if (actual !== expected)
      problems.push({
        rule: `accepted migration changed: pinned ${expected.slice(0, 12)}, found ${actual.slice(0, 12)}. Add a numbered migration instead of editing this one`,
        path: name,
      });
  }
  for (const name of Object.keys(pinned))
    if (!present.includes(name)) problems.push({ rule: 'pinned migration is missing from the tree', path: name });
  return { problems, count: present.length };
}

function main() {
  const args = process.argv.slice(2);
  let root = REPO_ROOT;
  for (let i = 0; i < args.length; i++) if (args[i] === '--root') root = resolve(args[++i]);
  const { problems, count } = checkMigrations(root);
  for (const p of problems) process.stdout.write(`REFUSE ${p.rule}: ${p.path}\n`);
  process.stdout.write(`check-migrations: ${count} migration(s) pinned by content, ${problems.length} problem(s)\n`);
  return problems.length ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
