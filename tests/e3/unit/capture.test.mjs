/* Case 32: the capture prompt scan (E3 design 5). The fail-before pair the design names, a scratch copy with
   app.phaea<U+200B>cia.ai in step 10 failing by name while the real file passes, and the other refusals of
   scripts/check-capture.mjs, each against a scratch copy of the real prompt. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { PUBLIC_ROUTES, publicRoutes } from '../../../lib/passport/rules.mjs';
import { parts, scan, specShape } from '../../../scripts/check-capture.mjs';
import { cp, REPO } from './helpers.mjs';

const SCRIPT = join(REPO, 'scripts/check-capture.mjs');
const REAL = readFileSync(join(REPO, 'capture/enterprise.md'), 'utf8');
const SPEC = readFileSync(join(REPO, 'vendor/passport/spec/passport-0.1.md'), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'e3-capture-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function runOn(text) {
  const file = join(dir, `copy-${n++}.md`);
  writeFileSync(file, text);
  return spawnSync(process.execPath, [SCRIPT, '--file', file], { encoding: 'utf8' });
}
function edited(from, to) {
  assert.ok(REAL.includes(from), `anchor ${JSON.stringify(from)}`);
  return REAL.replace(from, to);
}
const STEP10_SITE = "to their company's enterprise Phaeacia site";

test('case 32 control: the real capture/enterprise.md exits 0 and prints its SHA-256', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /check-capture: capture\/enterprise\.md sha256 [0-9a-f]{64}, 0 problem\(s\)/);
  assert.deepEqual(scan(REAL, SPEC), []);
});

test('case 32: a folded publisher route in step 10, app.phaea<U+200B>cia.ai, exits 2 naming the literal', () => {
  const r = runOn(edited(STEP10_SITE, `${STEP10_SITE} at app.phaea${cp(0x200b)}cia.ai`));
  assert.equal(r.status, 2);
  assert.match(r.stdout, /REFUSE publisher literal: app\.phaeacia\.ai at line \d+/);
});

/* E3a critique F5: the scan folded one line or two adjacent lines while the intake gate folds the whole document,
   so app.ph / aea / cia.ai over three lines passed here and was refused at upload. The fixture is the critic's
   file: the shipped prompt with that literal inserted before the rules heading. */
test('F5: a publisher literal folded across three lines is refused, at the line the intake gate names', () => {
  const text = readFileSync(join(REPO, 'tests/e3/unit/fixtures/capture-three-lines.md'), 'utf8');
  const gateLines = publicRoutes(text.split('\n')).map((p) => p.line);
  assert.equal(gateLines.length, 1, 'the intake gate refuses the same bytes');
  const r = runOn(text);
  assert.equal(r.status, 2);
  assert.match(r.stdout, new RegExp(`REFUSE publisher literal: app\\.phaeacia\\.ai at line ${gateLines[0]}\\n`));
  assert.deepEqual(scan(REAL, SPEC), [], 'control: the shipped prompt');
});

test('F5: for the intake routes, the scan and the gate agree on presence and line, however the literal is split', () => {
  const variants = [
    REAL,
    readFileSync(join(REPO, 'tests/e3/unit/fixtures/capture-three-lines.md'), 'utf8'),
    edited(STEP10_SITE, `${STEP10_SITE} at app.phaeacia.ai`),
    edited(STEP10_SITE, `${STEP10_SITE} at app.phae\ncia.ai`),
    edited(STEP10_SITE, `${STEP10_SITE} at app\n.\nph\nae\nac\nia.\nai`),
    edited('STEP 5. Personal slots\n', 'STEP 5. Personal slots\n\nSee scr\nipts/pub\nlish\n.py and phaeacia\n.ai/api\n'),
  ];
  for (const [index, text] of variants.entries()) {
    const fromGate = publicRoutes(text.split('\n')).map((p) => p.line);
    const fromScan = scan(text, SPEC)
      .filter((p) => p.rule === 'publisher literal')
      .map((p) => /^(.*) at line (\d+)$/.exec(p.detail))
      .filter((m) => PUBLIC_ROUTES.includes(m[1]))
      .map((m) => Number(m[2]));
    assert.deepEqual([...new Set(fromScan)].sort((a, b) => a - b), fromGate, `variant ${index}`);
  }
});

test('case 32: a last step that omits the local file exits 2 naming the missing step', () => {
  const r = runOn(edited('file named captured-passport.md and save it locally, on their own computer', 'message'));
  assert.equal(r.status, 2);
  assert.match(r.stdout, /REFUSE final step: step 10 does not name the local file name/);
  assert.match(r.stdout, /REFUSE final step: step 10 does not name saving the file locally/);
});

test('case 32: the upstream share command and the E0 publisher literals are refused in any folded form', () => {
  for (const [label, text] of [
    ['/share in the preamble', `Run /share when done.\n${REAL}`],
    ['Scripts/Publish.PY', `Use Scripts/Publish.PY.\n${REAL}`],
    ['a line break inside scripts/publish.py', `Use scripts/pub\nlish.py.\n${REAL}`],
    ['the upload box', `Paste it into the upload box.\n${REAL}`],
  ]) {
    const r = runOn(text);
    assert.equal(r.status, 2, label);
    assert.match(r.stdout, /REFUSE publisher literal: /, label);
  }
});

test('case 32: publish or share in a step that has no business with them is refused by word and part', () => {
  const r = runOn(edited('STEP 5. Personal slots\n', 'STEP 5. Personal slots\n\nThen publish the list and share it.\n'));
  assert.equal(r.status, 2);
  assert.match(r.stdout, /REFUSE restricted word outside its allowed parts: publish in step 5 at line \d+/);
  assert.match(r.stdout, /REFUSE restricted word outside its allowed parts: share in step 5 at line \d+/);
  const upload = runOn(edited('STEP 8. The check-in\n', 'STEP 8. The check-in\n\nUpload a draft first.\n'));
  assert.match(upload.stdout, /upload in step 8/);
});

test('case 32: a template or checklist that drifts from the pinned spec fails the build, not the upload', () => {
  const key = runOn(edited('envelope: read-notify\n---\n', '---\n'));
  assert.equal(key.status, 2);
  assert.match(key.stdout, /REFUSE frontmatter template: step 9 template keys .* differ from the spec's/);
  const heading = runOn(edited('## 6. Losses\n', '## 6. Loss\n'));
  assert.match(heading.stdout, /REFUSE section list: step 9 template headings differ/);
  const count = runOn(edited('all nine keys present', 'all eight keys present'));
  assert.match(count.stdout, /REFUSE step 9 checklist: it counts 8 keys, the spec has 9/);
});

test('case 32: the enterprise disclosure in step 1 and the intake refusal in R7 are required', () => {
  const r = runOn(edited(', where named reviewers read it,', ','));
  assert.match(r.stdout, /REFUSE enterprise disclosure/);
  const s = runOn(edited('refuses the uploaded file, it lists the refused rules by line number', 'refuses the file'));
  assert.match(s.stdout, /REFUSE stop condition/);
});

test('the scanner reads the pinned spec shape and the prompt parts it relies on', () => {
  const { headings, keys } = specShape(SPEC);
  assert.equal(headings.length, 6);
  assert.deepEqual(keys, ['passport', 'name', 'title', 'created', 'capture_path', 'source_stack', 'owner_confirmed', 'scrub', 'envelope']);
  assert.deepEqual(
    parts(REAL).map((p) => p.part),
    ['preamble', 'rules', 'evidence', ...Array.from({ length: 10 }, (_, i) => `step ${i + 1}`)],
  );
});

test('capture/enterprise.md is the reviewed private prompt with the edits evidence/e3a.md lists, and no other body change', () => {
  const base = readFileSync(join(REPO, 'tests/native-transfer/passport/private-capture-prompt.txt'), 'utf8');
  const from = (text, heading) => text.slice(text.indexOf(heading));
  const baseBody = from(base, 'You are running an Agent Passport capture');
  const realBody = from(REAL, 'You are running an Agent Passport capture');
  const stripEdits = (text) =>
    text
      .replace(/ Stopping is a valid outcome\.[^R]*?blind\.\n/s, ' Stopping is a valid outcome.\n')
      .replace(/; the finished file is uploaded by the owner[^.]*?yourself\./, '.')
      .replace(/STEP 10\.[\s\S]*$/, '');
  assert.equal(stripEdits(realBody), stripEdits(baseBody));
});
