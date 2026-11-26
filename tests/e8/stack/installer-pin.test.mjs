/* E8-7's live half (docs/e8/design.md 2.2's installer row, 2.3 row E8-7, 7.1 day 3), in the corrected form
   E8D-R-F12 gave it, against the running local stack.

   THE SCHEDULE. Publish a release under the registered installer text A, which is the text the compiled manifest
   `lib/passport/installer-manifest.mjs` names. Download it and keep the bytes. Then MOVE THE PIN: change the
   registered text for the active gate and that target to B, owner-side under `app.registry_migration`, which is
   the documented bypass of the registry freeze (`installer_texts_1_frozen`, 006:346) that tests/db/e4-lib.sh's
   `enable_target` already uses, "as a later numbered migration would". Then:
     P1  a publish of a successor is refused, 500 E_ASSEMBLY_DIVERGED, with the `assembly_diverged` log line and
         nothing written. This arm is ALREADY BUILT in `lib/services/releases.mjs:117-128` and pinned in four unit
         files; the case RE-RUNS it at the moved pin rather than re-implementing it, which is what E8D-R-F12 asked
         for. It is not this case's subject.
     P2  the ALREADY-PUBLISHED release is read. Its `installer.textSha256` is still the sha it was published
         under, and the answer compares it with nothing at all. The test makes BOTH comparisons the answer does
         not: against the compiled manifest, where it agrees, and against what is registered NOW, where it does
         not. That second divergence is the one a reader of the release page cannot see, and section 9's limit is
         exactly this: what is proven is that the BYTES are unchanged and that a divergence is detectable, not
         that anybody is told.
     P3  the release is downloaded again. The assembly is byte for byte what left before the pin moved, and its
         sha is the same, so no path re-assembled it from the text that is registered now.
     P4  the catalog row is read, and carries no installer divergence either.
   Then the pin is put back, and the last case asserts it went back.

   THE FAIL-BEFORE, AND THE DEVIATION IT CARRIES. Row E8-7 names "an assembler that reads the current manifest
   rather than the stored text, built as a mutant". It is built in two halves, and the split is recorded in
   docs/e8/design.md's day-3 amendment block:
     - the STRUCTURAL half is in tests/e8/unit/installer-pin.test.mjs U3: exactly one module under `lib/` imports
       an assembler and it is the publish path, with a counterexample that adds the import to the download service
       and fails the scan;
     - the OBSERVATIONAL half is F1 below: the bytes a re-assembling download WOULD have returned are computed
       here, from the same candidate content and the text that is registered now, and shown to differ from the
       bytes the download did return. The byte-for-byte assertion is therefore not vacuous.
   Why not a mutant of `lib/services/catalog.mjs` through tests/e8/helpers/mutant-lib.mjs, which is what day 2
   built that helper for: `authorizeDownload` returns the routine's frozen `assembled_content`, and a mutant that
   re-assembled instead would have to read `app.candidate_versions`, which RLS does not admit to a recipient. The
   mutant would have failed on the read rather than on the assembly, and a fail-before that fails for the wrong
   reason establishes nothing.

   E8-9. `no-write.mjs` wraps P1, the refused publish under the moved pin. The publications, the downloads and the
   pin moves write or change registry state by design and are asserted instead of wrapped.

   THE STACK. Held by this lane. Reseeds through tests/db/00-seed.sh, runs under --test-concurrency=1. The pin is
   moved and put back inside this file; the last case fails loudly if it did not go back. Run alone:
   node --test --test-concurrency=1 tests/e8/stack/installer-pin.test.mjs */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';

import { PLACEHOLDER } from '../../../lib/passport/assemble.mjs';
import { INSTALLER_TEXTS } from '../../../lib/passport/installer-manifest.mjs';
import {
  approveBoth,
  e4world,
  e6routes,
  enableTargets,
  envelopeFor,
  published,
  reseed,
  reviewCompany,
  sql,
  submitted,
} from '../../e6/stack/helpers.mjs';
import { noWrite } from '../helpers/no-write.mjs';

const TARGET = 'claude-ai';
const MANIFEST = INSTALLER_TEXTS.find((t) => t.target === TARGET);
const sha256hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const logged = [];
const ids = reseed();
enableTargets();
const R = await e6routes(logged);
const W = e4world('e8p', ids);
const A = await reviewCompany(W, R, 'installer-pin');

const ok = (label, answer, ...statuses) => {
  assert.ok(statuses.includes(answer.status), `${label}: ${answer.status} ${answer.raw}`);
  return answer.body;
};

const activeGate = () => sql(`select id from app.gate_identities where active`);
/* BASE64 AND NOT THE TEXT ITSELF. tests/e2/helpers/stack.mjs's sql() trims its answer, and the pin move below is
   exactly one TRAILING SPACE: read as text it comes back identical to the text before the move, and every
   comparison here would be off by the one character the case turns on. Reading the bytes through base64 and
   decoding in Node keeps them. */
const b64 = (statement) => Buffer.from(sql(statement), 'base64').toString('utf8');
const registeredText = () =>
  b64(`select encode(convert_to(text, 'UTF8'), 'base64') from app.installer_texts
        where gate_id = '${activeGate()}' and target = '${TARGET}'`);
const registeredSha = () =>
  sql(`select encode(sha256(convert_to(text, 'UTF8')), 'hex') from app.installer_texts
        where gate_id = '${activeGate()}' and target = '${TARGET}'`);

/* THE PIN MOVE. `app.installer_texts` is frozen by `installer_texts_1_frozen` (006:346) and the one documented
   way past it is `set local app.registry_migration = 'on'`, which tests/db/e4-lib.sh's `enable_target` uses for
   `app.release_targets`. One trailing space is enough to change the sha and small enough to keep the projected
   assembly inside ASSEMBLED_BYTES_MAX, which is the same alteration tests/e4/unit/services.test.mjs row 14 uses. */
const SUFFIX = ' ';
function movePin(to) {
  const statement =
    to === 'B'
      ? `update app.installer_texts set text = text || '${SUFFIX}'`
      : `update app.installer_texts set text = left(text, length(text) - ${SUFFIX.length})`;
  sql(`begin; set local app.registry_migration = 'on';
       ${statement} where gate_id = '${activeGate()}' and target = '${TARGET}';
       commit;`);
}

let pinMoved = false;
after(() => {
  if (pinMoved) movePin('A');
  pinMoved = false;
});

/* ---------- The world, published before the pin moves ---------- */

const P = await published(R, A, TARGET);
const releaseBefore = ok('the release read before the pin moves', await R.releaseRead(A.adminHi, P.releaseId), 200);
const downloadBefore = ok('the download before the pin moves', await R.download(A.member, P.releaseId), 200);
const BYTES_THAT_LEFT = downloadBefore.assembledContent;
const SHA_THAT_LEFT = downloadBefore.assembledSha256;
const TEXT_A = registeredText();
const CANDIDATE_CONTENT = b64(
  `select encode(convert_to(content, 'UTF8'), 'base64') from app.candidate_versions where id = '${P.candidateId}'`,
);

test('E8-7 P0: before the pin moves, the registered text, the manifest and the release agree', () => {
  assert.equal(registeredSha(), MANIFEST.textSha256, 'the registered installer text is not the manifest s');
  assert.equal(releaseBefore.release.installer.textSha256, MANIFEST.textSha256);
  assert.equal(typeof BYTES_THAT_LEFT, 'string');
  assert.ok(BYTES_THAT_LEFT.length > 0);
  assert.equal(sha256hex(BYTES_THAT_LEFT), SHA_THAT_LEFT, 'the download s own sha does not match its bytes');
});

test('E8-7: the pin moves, and the registry says so', () => {
  movePin('B');
  pinMoved = true;
  assert.notEqual(registeredSha(), MANIFEST.textSha256, 'the pin did not move');
  assert.equal(registeredText(), `${TEXT_A}${SUFFIX}`, 'the pin moved to something other than B');
  console.log(`E8-7: the pin moved, registered ${registeredSha().slice(0, 12)} vs manifest ${MANIFEST.textSha256.slice(0, 12)}`);
});

test('E8-7 P1: a publish under the moved pin is refused with E_ASSEMBLY_DIVERGED, logged, and writes nothing', async () => {
  const successor = await submitted(R, A, { agentId: P.agentId });
  const envelopeId = await envelopeFor(R, A, successor.candidateId, TARGET);
  await approveBoth(R, A, successor.candidateId, envelopeId);
  const before = logged.length;

  /* With the content digest (B12-R-F1): a publish that got far enough to rewrite a candidate's state or a
     release row before refusing would move no count. */
  const refused = await noWrite(
    'E8-7 P1 the publish under the moved pin',
    async () => R.publish(A.adminHi, successor.candidateId, envelopeId),
    { content: ['releases', 'candidate_versions', 'agents', 'idempotency_keys', 'audit_events'] },
  );
  assert.deepEqual([refused.status, refused.body?.code], [500, 'E_ASSEMBLY_DIVERGED'], refused.raw);
  assert.deepEqual(Object.keys(refused.body).sort(), ['code', 'message', 'ok'], 'the refusal forwarded database detail');

  const line = logged.slice(before).find((entry) => entry.event === 'assembly_diverged');
  assert.ok(line, `no assembly_diverged line was logged: ${JSON.stringify(logged.slice(before))}`);
  assert.deepEqual(
    { stage: line.stage, target: line.target, registered: line.registeredTextSha256, manifest: line.manifestTextSha256 },
    { stage: 'installer_text', target: TARGET, registered: registeredSha(), manifest: MANIFEST.textSha256 },
  );
  /* And the release the case is actually about is untouched by the refusal. */
  assert.equal(sql(`select state from app.releases where id = '${P.releaseId}'`), 'published');
});

test('E8-7 P2: the already-published release still answers the sha it was published under, compared with nothing', async () => {
  const read = ok('the release read under the moved pin', await R.releaseRead(A.adminHi, P.releaseId), 200);
  assert.deepEqual(read.release.installer, releaseBefore.release.installer, 'the moved pin changed the answer');
  assert.equal(read.release.installer.textSha256, MANIFEST.textSha256);

  /* THE TWO COMPARISONS THE ANSWER DOES NOT MAKE, made here. `lib/services/evidence-reads.mjs:271-276` returns
     four stored hashes and nothing compares them with anything. */
  const stored = read.release.installer.textSha256;
  assert.equal(stored === MANIFEST.textSha256, true, 'against the compiled manifest: they agree, because it was published under it');
  assert.equal(stored === registeredSha(), false, 'against what is registered NOW: they differ, and that is the divergence');

  /* And the answer carries no field that says so: no key of the release object holds either verdict. */
  const leaves = JSON.stringify(read.release);
  for (const word of ['diverged', 'divergence', 'stale', 'pinMoved', 'installerStale'])
    assert.equal(leaves.includes(word), false, `the answer carries ${word}, so a reader IS told after all`);
  console.log(`E8-7 P2: stored ${stored.slice(0, 12)} = manifest, registered now ${registeredSha().slice(0, 12)}; the answer reports neither`);
});

test('E8-7 P3: the download under the moved pin returns byte for byte what left, and no path re-assembled it', async () => {
  const again = ok('the download under the moved pin', await R.download(A.member, P.releaseId), 200);
  assert.equal(again.assembledContent, BYTES_THAT_LEFT, 'the downloaded assembly changed when the pin moved');
  assert.equal(again.assembledSha256, SHA_THAT_LEFT, 'the downloaded sha changed when the pin moved');
  assert.equal(again.release.installer.textSha256, MANIFEST.textSha256);
  /* The stored column itself, owner-side: the frozen assembly, not just the answer built from it. */
  assert.equal(
    sql(`select encode(sha256(convert_to(assembled_content, 'UTF8')), 'hex') from app.releases where id = '${P.releaseId}'`),
    SHA_THAT_LEFT,
    'the stored assembly changed when the pin moved',
  );
});

test('E8-7 P4: the catalog row under the moved pin says nothing about it either', async () => {
  const catalog = ok('the catalog read', await R.catalog(A.member, A.id), 200);
  /* The catalogue answers `available` and `earlier` (E5 design 3.4), not one list. */
  const rows = [...(catalog.available ?? []), ...(catalog.earlier ?? [])];
  const row = rows.find((r) => r.releaseId === P.releaseId);
  assert.ok(row, `the release is not in the catalog: ${JSON.stringify(Object.keys(catalog))} / ${rows.length} rows`);
  const text = JSON.stringify(row);
  for (const word of ['diverged', 'divergence', 'installerStale'])
    assert.equal(text.includes(word), false, `the catalog row carries ${word}`);
});

test('E8-7 F1 fail-before: a re-assembling download would have returned different bytes, and here they are', () => {
  /* The assembly a path that read the CURRENT registered text would produce, from the same candidate content the
     publication used. This is what row E8-7's mutant would have returned; the assertion in P3 is what refuses it. */
  const reassembled = CANDIDATE_CONTENT.split(PLACEHOLDER).join(registeredText());
  assert.notEqual(reassembled, BYTES_THAT_LEFT, 'the re-assembly is identical, so P3 could not tell the two apart');
  assert.notEqual(sha256hex(reassembled), SHA_THAT_LEFT);
  /* And the assembly from the text it WAS published under is the bytes that left, so the difference is the pin
     and nothing else about the way this comparison is built. */
  assert.equal(CANDIDATE_CONTENT.split(PLACEHOLDER).join(TEXT_A), BYTES_THAT_LEFT, 'the re-assembly recipe is not the publication s');
  console.log(
    `E8-7 F1 fail-before at the intended check: a re-assembly under the moved pin hashes to ${sha256hex(reassembled).slice(0, 12)}, where the download returned ${SHA_THAT_LEFT.slice(0, 12)}`,
  );
});

test('E8-7 P5: the pin goes back, and the registry is what it was', () => {
  movePin('A');
  pinMoved = false;
  assert.equal(registeredText(), TEXT_A, 'the registered installer text did not go back');
  assert.equal(registeredSha(), MANIFEST.textSha256, 'the registered installer text no longer matches the manifest');
});
