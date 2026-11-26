/* E8-7's stack-free half (docs/e8/design.md 2.2's installer row, 2.3 row E8-7, 7.1 day 3), in the corrected form
   E8D-R-F12 gave it.

   WHAT THIS CASE IS NOT. It is not the publish refusal. `lib/services/releases.mjs:117-128` already refuses a
   publish whose envelope carries this build's gate identity while the registered installer text's sha differs from
   `INSTALLER_TEXTS`, with `E_ASSEMBLY_DIVERGED` and an `assembly_diverged` log line, and that arm is pinned in four
   unit files (tests/e2/unit/errors.test.mjs, tests/e3/unit/errors.test.mjs, tests/e4/unit/services.test.mjs rows 13
   and 14, tests/e4/unit/errors-and-vectors.test.mjs) and in probes 23 and 24. The stack half re-runs it at the
   moved pin rather than re-implementing it. Nothing here duplicates those pins.

   WHAT THIS CASE IS. The residue: the ALREADY-PUBLISHED release, read after the pin moves. Three claims, each
   asserted here against the real read code rather than described:

     1. `releaseObject` returns the sha that was STORED at publication and never the manifest's. A release published
        under installer text A keeps A's sha in its answer after the pin moves to B.
     2. THE ANSWER COMPARES IT WITH NOTHING. `lib/services/evidence-reads.mjs:271-276` builds `installer` out of four
        stored columns; no field of the answer says whether the pin has moved, and no code path in `lib/` compares a
        stored sha with `INSTALLER_TEXTS`. So the comparison is made HERE, by the test, and the divergence is
        VISIBLE TO A TEST AND NOT TO A READER of the release page. That sentence is design section 9's limit and it
        is what this file establishes, not more.
     3. NO PATH RE-ASSEMBLES. `assembledSha256`, the one function that computes an assembly's hash from a content
        and an installer text, is imported by exactly one module under `lib/`, and it is the publish path. The read
        and download paths carry `assembled_sha256` and `assembled_content` out of the database. Asserted by a scan
        over `lib/`, with a counterexample that adds the import to the download service and fails the scan.

   THE COMPARISON IS WRITTEN OUT IN BOTH HALVES OF E8-7, here and in tests/e8/stack/installer-pin.test.mjs, rather
   than shared through a helper. It is one expression, and a helper under tests/e8/helpers/ that made the comparison
   would be the very thing the case reports as missing from the product, one directory over.

   NO STACK, NO NETWORK, NO CHILD PROCESS. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { INSTALLER_TEXTS } from '../../../lib/passport/installer-manifest.mjs';
import { releaseObject } from '../../../lib/services/evidence-reads.mjs';
import { scratchCopy } from '../../e2/helpers/pages.mjs';
import { REPO } from '../../e3/unit/helpers.mjs';
import { caught } from '../helpers/mutant-lib.mjs';

const TARGET = 'claude-ai';
const MANIFEST = INSTALLER_TEXTS.find((t) => t.target === TARGET);
/* The sha a moved pin leaves behind: what the release was published under, differing from the manifest in one
   character. Built from the manifest row so it cannot drift away from it. */
const PUBLISHED_SHA = `${MANIFEST.textSha256.slice(0, 63)}${MANIFEST.textSha256.endsWith('0') ? '1' : '0'}`;

/* PostgREST writes a bytea as the two characters of its prefix and 64 hex; hexOf() reads exactly that. Built from
   code points, as lib/services/evidence-reads.mjs builds the same prefix, so no escape sequence is typed. */
const bytea = (hex) => `${String.fromCharCode(92, 120)}${hex}`;
const GATE_ID = '11111111-1111-4111-8111-111111111111';
const POLICY_ID = '22222222-2222-4222-8222-222222222222';
const GATE_IDENTITY = 'a'.repeat(64);

const registers = {
  activeGateId: GATE_ID,
  gateIdentityOf: new Map([[GATE_ID, GATE_IDENTITY]]),
  policies: new Map([[POLICY_ID, { policyId: POLICY_ID, version: 1, sha256: 'b'.repeat(64), active: true }]]),
  activePolicy: null,
};

/** A published release row as RELEASE_COLUMNS selects it, carrying the sha it was published under. */
const releaseRow = (installerTextSha) => ({
  id: '33333333-3333-4333-8333-333333333333',
  company_id: '44444444-4444-4444-8444-444444444444',
  agent_id: '55555555-5555-4555-8555-555555555555',
  candidate_id: '66666666-6666-4666-8666-666666666666',
  envelope_id: '77777777-7777-4777-8777-777777777777',
  target: TARGET,
  gate_id: GATE_ID,
  content_sha256: bytea('c'.repeat(64)),
  derived_sha256: bytea('d'.repeat(64)),
  installer_text_sha256: bytea(installerTextSha),
  core_sha256: bytea(MANIFEST.coreSha256),
  branch_sha256: bytea(MANIFEST.branchSha256),
  judge_sha256: bytea(MANIFEST.judgeSha256),
  policy_id: POLICY_ID,
  policy_sha256: bytea('b'.repeat(64)),
  audience_group_ids: [],
  envelope_sha256: bytea('e'.repeat(64)),
  assembled_sha256: bytea('f'.repeat(64)),
  assembled_bytes: 70000,
  state: 'published',
  published_by_membership_id: '88888888-8888-4888-8888-888888888888',
  published_at: '2026-09-20T09:00:00.000Z',
  superseded_by_release_id: null,
  superseded_at: null,
  withdrawn_by_membership_id: null,
  withdrawn_at: null,
  withdrawal_reason: null,
});

/* THE COMPARISON THE PRODUCT DOES NOT MAKE. One expression, written out rather than imported. */
const divergedFromManifest = (answer) =>
  INSTALLER_TEXTS.find((t) => t.target === answer.target)?.textSha256 !== answer.installer.textSha256;

test('E8-7 U1: the release answer carries the sha it was published under, not the manifest s', () => {
  const answer = releaseObject(releaseRow(PUBLISHED_SHA), registers);
  assert.equal(answer.installer.textSha256, PUBLISHED_SHA, 'the stored sha reached the answer unchanged');
  assert.notEqual(
    answer.installer.textSha256,
    MANIFEST.textSha256,
    'the fixture stopped being a moved pin, so this case tests nothing',
  );
  /* And the three companion hashes are the stored ones too, so a moved pin is not partly repaired. */
  assert.deepEqual(answer.installer, {
    textSha256: PUBLISHED_SHA,
    coreSha256: MANIFEST.coreSha256,
    branchSha256: MANIFEST.branchSha256,
    judgeSha256: MANIFEST.judgeSha256,
  });
});

test('E8-7 U2: no field of the answer says the pin has moved, and the test is what notices', () => {
  const diverged = releaseObject(releaseRow(PUBLISHED_SHA), registers);
  const agreeing = releaseObject(releaseRow(MANIFEST.textSha256), registers);

  /* The two answers differ in exactly one leaf: the stored sha. Nothing else in the release object reacts to a
     moved pin, which is the claim, stated as a comparison of the two whole answers rather than as prose. */
  const leaves = (v, path = '', out = []) => {
    if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) leaves(x, `${path}.${k}`, out);
    else out.push(`${path}=${JSON.stringify(v)}`);
    return out;
  };
  const differing = leaves(diverged).filter((l, i) => l !== leaves(agreeing)[i]);
  assert.deepEqual(
    differing,
    [`.installer.textSha256=${JSON.stringify(PUBLISHED_SHA)}`],
    'a second field moved with the pin, so the answer does react to it after all and this case must be rewritten',
  );

  /* The comparison, made by the test. This is the whole of E8-7's "visible to a test and not to a reader". */
  assert.equal(divergedFromManifest(diverged), true, 'the test sees the divergence the answer does not report');
  assert.equal(divergedFromManifest(agreeing), false, 'and sees none when the pin has not moved');
});

test('E8-7 U1 fail-before: a read that answers the manifest sha instead of the stored one hides the moved pin', async () => {
  const mutant = await scratchCopy('lib/services/evidence-reads.mjs', [
    /* Anchored on the line above the block, because `installer: { textSha256: hexOf(...)` occurs twice in this
       module: once in envelopeObject and once in releaseObject. `gateIdentitySha256: identity,` is releaseObject's
       alone, and scratchCopy refuses a `from` that does not occur exactly once, which is how that was caught. */
    [
      '    gateIdentitySha256: identity,\n    installer: {\n      textSha256: hexOf(row.installer_text_sha256),',
      '    gateIdentitySha256: identity,\n    installer: {\n      textSha256: MANIFEST_TEXTS.find((t) => t.target === row.target)?.textSha256 ?? hexOf(row.installer_text_sha256),',
    ],
    [
      "import { AppError } from '../errors.mjs';",
      "import { AppError } from '../errors.mjs';\nimport { INSTALLER_TEXTS as MANIFEST_TEXTS } from '../passport/installer-manifest.mjs';",
    ],
  ]);
  const answer = mutant.releaseObject(releaseRow(PUBLISHED_SHA), registers);
  const e = caught('E8-7 U1', () =>
    assert.equal(answer.installer.textSha256, PUBLISHED_SHA, 'the stored sha reached the answer unchanged'),
  );
  assert.equal(answer.installer.textSha256, MANIFEST.textSha256, 'the mutant answered the manifest');
  assert.equal(divergedFromManifest(answer), false, 'and the comparison U2 makes now finds nothing, which is the hazard');
  console.log(`E8-7 U1 fail-before at the intended check: ${e.message.split('\n')[0]}`);
});

/* ---------- U3: no read or download path re-assembles ---------- */

/** Every .mjs under lib/, as [repo-relative path, text]. */
function libModules(root = join(REPO, 'lib'), prefix = 'lib') {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) out.push(...libModules(join(root, entry.name), `${prefix}/${entry.name}`));
    else if (entry.name.endsWith('.mjs')) out.push([`${prefix}/${entry.name}`, readFileSync(join(root, entry.name), 'utf8')]);
  }
  return out;
}

/* `assembledSha256` computes an assembly's hash from a content and an installer text; `assemble` and
   `assembleBytes` build the assembly itself. A module that imports one of the three can re-assemble. The scan is
   over the import statement, because a name can only be reached that way inside lib/ (scripts/check-imports.mjs
   refuses a dynamic import there). */
const ASSEMBLERS = /import\s*\{([^}]*)\}\s*from\s*'[^']*passport\/(?:packet|assemble)\.mjs'/g;
const ASSEMBLING_NAMES = ['assembledSha256', 'assemble', 'assembleBytes'];

function assemblerImporters(modules) {
  const out = [];
  for (const [path, text] of modules) {
    if (path === 'lib/passport/packet.mjs' || path === 'lib/passport/assemble.mjs') continue;
    for (const m of text.matchAll(ASSEMBLERS)) {
      const named = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]);
      for (const name of named) if (ASSEMBLING_NAMES.includes(name)) out.push(`${path}: ${name}`);
    }
  }
  return out.sort();
}

test('E8-7 U3: exactly one module under lib/ can re-assemble, and it is the publish path', () => {
  const modules = libModules();
  assert.ok(modules.length > 20, `the scan read ${modules.length} modules`);
  assert.deepEqual(
    assemblerImporters(modules),
    ['lib/services/releases.mjs: assembledSha256'],
    'a second module under lib/ imports an assembler. The read and download paths must carry the stored bytes, not rebuild them',
  );
});

test('E8-7 U3 fail-before: the download service importing the assembler fails the scan, naming it', () => {
  const modules = libModules().map(([path, text]) =>
    path === 'lib/services/catalog.mjs'
      ? [path, text.replace("import { lossRows } from '../passport/packet.mjs';", "import { assembledSha256, lossRows } from '../passport/packet.mjs';")]
      : [path, text],
  );
  const found = assemblerImporters(modules);
  const e = caught('E8-7 U3', () => assert.deepEqual(found, ['lib/services/releases.mjs: assembledSha256'], 'the assembler importers'));
  assert.deepEqual(found, ['lib/services/catalog.mjs: assembledSha256', 'lib/services/releases.mjs: assembledSha256']);
  assert.match(e.message, /catalog\.mjs/);
  console.log(`E8-7 U3 fail-before at the intended check: the scan named lib/services/catalog.mjs`);
});
