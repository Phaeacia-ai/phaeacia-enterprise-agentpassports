/* E4 prerequisites, no stack: the vocabulary migration 006 part A owns, against the code it must agree with.
   - app.release_target_names() is lib/passport/assemble.mjs BRANCHES, in order (design 1.8: one vocabulary, no mapping
     table), the target registration reads that function, and the installer manifest has one row per target;
   - policy version 1 is lib/passport/canonical.mjs canonical() of the object design 1.8 gives;
   - the group limit is 50 (design 1.7). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BRANCHES } from '../../../lib/passport/assemble.mjs';
import { canonical } from '../../../lib/passport/canonical.mjs';
import { INSTALLER_TEXTS } from '../../../lib/passport/installer-manifest.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MIGRATION = readFileSync(join(REPO, 'supabase/migrations/006_reviews_releases.sql'), 'utf8');

/* The body of a parameterless app function 006 defines, between its $$ quotes. */
const body = (name) =>
  new RegExp(`create or replace function app\\.${name}\\(\\)[^$]*\\$\\$([\\s\\S]*?)\\$\\$;`).exec(MIGRATION)?.[1];
const namesIn = (text) => [...text.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);

test('design 1.8: app.release_target_names() is assemble.mjs BRANCHES, the same four names in the same order', () => {
  const b = body('release_target_names');
  assert.ok(b, 'the function is defined in 006');
  assert.match(b, /^\s*select array\[[^\]]*\]::text\[\]\s*$/, 'one array literal and nothing else');
  assert.deepEqual(namesIn(b), [...BRANCHES]);
  assert.equal(BRANCHES.length, 4);
});

test('control: the comparison refuses a vocabulary that differs by one name or by order', () => {
  assert.notDeepEqual(namesIn("select array['chatgpt', 'claude-ai', 'claude-code']::text[]"), [...BRANCHES]);
  assert.notDeepEqual(namesIn("select array['claude-ai', 'chatgpt', 'claude-code', 'generic']::text[]"), [...BRANCHES]);
  assert.notDeepEqual(namesIn("select array['chatgpt', 'claude-ai', 'claude-code', 'copilot']::text[]"), [...BRANCHES]);
});

test('the four targets are registered from that function, not publishable, and the installer manifest has one row each', () => {
  assert.match(
    MIGRATION,
    /\ninsert into app\.release_targets \(target, publishable\)\nselect t\.target, false from unnest\(app\.release_target_names\(\)\) as t \(target\);\n/,
  );
  assert.match(MIGRATION, /target text primary key check \(target = any \(app\.release_target_names\(\)\)\)/);
  assert.deepEqual(
    INSTALLER_TEXTS.map((r) => r.target),
    [...BRANCHES],
  );
});

test('design 1.8: policy version 1 is canonical() of the fixed object, registered active', () => {
  const policy = {
    approval_scope: 'configuration_and_evidence',
    declared_writes: 'not_installable',
    policy_version: 1,
    recipient_overrides: 'personal_bindings_only',
  };
  const registered = /insert into app\.release_policies \(version, canonical, active\)\n\s*values \(1, '([^']+)', true\)/.exec(
    MIGRATION,
  );
  assert.ok(registered, 'version 1 is inserted active');
  assert.equal(registered[1], canonical(policy));
  assert.equal(JSON.parse(registered[1]).policy_version, 1);
});

test('design 1.7: at most 50 groups per company', () => {
  assert.equal(body('limit_groups_per_company')?.trim(), 'select 50');
  assert.match(MIGRATION, /\) >= app\.limit_groups_per_company\(\) then\n\s*raise exception 'E_GROUP_LIMIT'/);
});
