/* Golden assembly, live Python twin comparison, adversarial folding cases and
   the mutation regressions of docs/e1/passport-adapter.md sections 6 and 8
   (rows 4 and 4b). */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BRANCHES,
  PLACEHOLDER,
  assemble,
  check,
  decodeText,
  encodeText,
  normalizeForbidden,
  pyRstrip,
  readText,
} from '../../lib/passport/assemble.mjs';
import { REPO, VENDOR, freshDir, makeLauncher, resolveInterpreter, sha256 } from './helpers.mjs';

const FIXTURE = join(REPO, 'tests/native-transfer/passport/fixtures/SYNTHETIC-passport.md');

/* Contract section 6: recorded identities of the pinned Python assembly. */
const GOLDEN = {
  chatgpt: { bytes: 70752, sha256: '11070a1ffbdc39030b661cddc332b8b5594bb78d6ab3c137000739609743ad7a' },
  'claude-ai': { bytes: 64621, sha256: '8e686b27e554e35af47af16a20cc24b48ae40323b4f5bcf37d64192f8b30e761' },
  'claude-code': { bytes: 73409, sha256: '5cdaf5c50d37c355c086f9f05aec2b810de10f109d0d1464682d4f13c85a3dff' },
  generic: { bytes: 54957, sha256: 'd558746392a835f3da4c4a779616761a8e0dba9157962d7da22d772e5d28546d' },
};

function assembleFixture(root, branch, fixture = FIXTURE) {
  return encodeText(assemble(readText(fixture), { root, branch }));
}

test('golden: the Node port reproduces all four recorded assemblies (row 4 control)', () => {
  for (const branch of BRANCHES) {
    const out = assembleFixture(VENDOR, branch);
    assert.equal(out.length, GOLDEN[branch].bytes, `${branch} byte count`);
    assert.equal(sha256(out), GOLDEN[branch].sha256, `${branch} sha256`);
  }
});

test('row 4: one byte changed in installer/core.md in a scratch copy fails all four goldens', () => {
  const root = freshDir('assemble-mutant');
  cpSync(VENDOR, root, { recursive: true });
  const core = join(root, 'installer/core.md');
  writeFileSync(core, readFileSync(core, 'utf8').replace('# ', '#  '));
  let failures = 0;
  for (const branch of BRANCHES) {
    const out = assembleFixture(root, branch);
    if (sha256(out) !== GOLDEN[branch].sha256) failures++;
  }
  assert.equal(failures, 4, 'every branch must differ from its golden after the mutation');
  /* Restored control: the unmodified vendor tree still matches (asserted above). */
  assert.equal(sha256(assembleFixture(VENDOR, 'generic')), GOLDEN.generic.sha256);
});

test('live twin: Node output equals vendor assemble.py run through the controlled launcher', () => {
  const interp = resolveInterpreter();
  const dir = freshDir('assemble-twin');
  const launcher = makeLauncher(dir, interp.path);
  for (const branch of BRANCHES) {
    const outPath = join(dir, `${branch}.md`);
    const r = spawnSync('python3', [join(VENDOR, 'scripts/assemble.py'), FIXTURE, outPath, `--branch=${branch}`], {
      env: { ...process.env, PATH: launcher.path },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `assemble.py ${branch}: ${r.stderr}`);
    const py = readFileSync(outPath);
    const node = assembleFixture(VENDOR, branch);
    assert.ok(py.equals(node), `${branch}: Python and Node bytes differ`);
  }
  /* The launcher resolved the interpreter the test records, not an arbitrary one. */
  const which = spawnSync('sh', ['-c', 'command -v python3'], {
    env: { ...process.env, PATH: launcher.path },
    encoding: 'utf8',
  });
  assert.equal(which.stdout.trim(), launcher.shim);
});

/* Adversarial folding cases with the verdict of the pinned Python check(),
   recorded in the contract (section 6, E1a executed 2026-09-10 with a
   pyenv Python 3.11.9 run as python3 -I -B). */
const FOLDING = [
  { name: 'long s in secrets/ (U+017F)', text: 'see ſecrets/ here', python: 'refused' },
  { name: 'sharp s before .pem (U+00DF)', text: 'file ß.pem here', python: 'accepted' },
  { name: 'soft hyphen inside credentials/ (U+00AD)', text: 'cred­entials/', python: 'refused' },
  { name: 'zero-width space inside credentials/ (U+200B)', text: 'cred​entials/', python: 'refused' },
  { name: 'line break inside secrets/', text: 'sec\nrets/', python: 'refused' },
  { name: 'cert.pem (anchor control)', text: 'cert.pem', python: 'refused' },
  { name: 'ellipsis before Pemberton (anchor control)', text: 'done…Pemberton', python: 'accepted' },
  { name: 'comparison_mode: strict', text: 'comparison_mode: strict', python: 'refused' },
  { name: 'comparison_mode: with no value', text: 'comparison_mode:', python: 'accepted' },
  { name: 'plain credentials/', text: 'credentials/', python: 'refused' },
  { name: 'clean text', text: 'nothing here', python: 'accepted' },
];

test('folding: the NFKC plus toLowerCase port agrees with every recorded Python verdict', () => {
  for (const c of FOLDING) {
    const verdict = check(c.text).length ? 'refused' : 'accepted';
    assert.equal(verdict, c.python, c.name);
  }
});

test('folding: the recorded normalisations match the pinned Python normalize_forbidden', () => {
  assert.equal(normalizeForbidden('see ſecrets/ here'), 'see secrets/ here');
  assert.equal(normalizeForbidden('file ß.pem here'), 'file ß.pem here');
  assert.equal(normalizeForbidden('cred­entials/'), 'credentials/');
  assert.equal(normalizeForbidden('sec\nrets/'), 'secrets/');
  assert.equal(normalizeForbidden('done…Pemberton'), 'done...pemberton');
  assert.equal(normalizeForbidden('comparison_mode: strict'), 'comparisonmode: strict');
});

test('row 4b: a port omitting NFKC accepts the long-s case Python refuses', () => {
  const mutant = check('see ſecrets/ here', { nfkc: false });
  assert.equal(mutant.length, 0, 'the mutant must accept (wrongly)');
  assert.ok(check('see ſecrets/ here').length > 0, 'the port must refuse');
});

test('row 4b: a casefold port refuses ß.pem that Python accepts', () => {
  const mutant = check('file ß.pem here', { casefold: true });
  assert.ok(mutant.length > 0, 'the casefold mutant must refuse (wrongly)');
  assert.equal(check('file ß.pem here').length, 0, 'the port must accept');
  /* And the same casefold mutant does not distinguish the long-s case, which is
     why long s tests NFKC, not casefold (recheck answer 3). */
  assert.ok(check('see ſecrets/ here', { casefold: true }).length > 0);
});

test('row 4b: ports without noise deletion or the line join accept cases Python refuses', () => {
  assert.equal(check('cred­entials/', { noise: false }).length, 0);
  assert.equal(check('cred​entials/', { noise: false }).length, 0);
  assert.equal(check('sec\nrets/', { join: false }).length, 0);
});

test('placeholder: a fenced placeholder assembles and an absent placeholder is refused', () => {
  const fenced = `---\nname: x\n---\n\n## 5. Install\n\n\`\`\`\n${PLACEHOLDER}\n\`\`\`\n`;
  const out = assemble(fenced, { root: VENDOR, branch: 'generic' });
  assert.ok(!out.includes(PLACEHOLDER));
  assert.ok(out.includes('## Appendix: the verification judge'));
  assert.throws(
    () => assemble('---\nname: x\n---\nno placeholder\n', { root: VENDOR, branch: 'generic' }),
    /E_NO_PLACEHOLDER|no installer placeholder/,
  );
  assert.throws(() => assemble(fenced, { root: VENDOR, branch: 'nope' }), /unknown branch/);
});

test('placeholder: pinned Python main() gives the same two exit codes through the launcher', () => {
  const interp = resolveInterpreter();
  const dir = freshDir('assemble-placeholder');
  const launcher = makeLauncher(dir, interp.path);
  const fenced = join(dir, 'fenced.md');
  writeFileSync(fenced, `---\nname: x\n---\n\n## 5. Install\n\n\`\`\`\n${PLACEHOLDER}\n\`\`\`\n`);
  const absent = join(dir, 'absent.md');
  writeFileSync(absent, '---\nname: x\n---\nno placeholder\n');
  const env = { ...process.env, PATH: launcher.path };
  const ok = spawnSync('python3', [join(VENDOR, 'scripts/assemble.py'), fenced, '--branch=generic'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, assemble(readText(fenced), { root: VENDOR, branch: 'generic' }));
  const bad = spawnSync('python3', [join(VENDOR, 'scripts/assemble.py'), absent, '--branch=generic'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(bad.status, 1);
});

test('Python text semantics: universal newlines, strict UTF-8, Python whitespace set', () => {
  assert.equal(decodeText(Buffer.from('a\r\nb\rc\n')), 'a\nb\nc\n');
  assert.throws(() => decodeText(Buffer.from([0xff, 0xfe, 0x41])), TypeError);
  assert.equal(decodeText(Buffer.from('﻿x')), '﻿x', 'a leading BOM is kept, as Python utf-8 does');
  assert.equal(pyRstrip('x'), 'x', 'Python strips U+001F');
  assert.equal(pyRstrip('x﻿'), 'x﻿', 'Python does not strip U+FEFF');
  assert.throws(() => encodeText('\uD800'), /lone surrogate/);
});

test('branch layout: a missing judge prompt yields a warning and no appendix, as in Python', () => {
  const root = freshDir('assemble-nojudge');
  mkdirSync(join(root, 'installer/branches'), { recursive: true });
  writeFileSync(join(root, 'installer/core.md'), 'core  \n\n');
  writeFileSync(join(root, 'installer/branches/generic.md'), 'generic\n');
  const warnings = [];
  const out = assemble(`x ${PLACEHOLDER} y`, { root, branch: 'generic', warn: (w) => warnings.push(w) });
  assert.equal(out, 'x core\n\ngeneric\n y');
  assert.deepEqual(warnings, ['warning: no judge prompt, section 5 will have no verification step']);
});

/* L1 (evidence/e1-adapter-critique.md, 2026-09-10): Python slices the
   70-character diagnostic by code point; a UTF-16 slice keeps 26 emoji and a
   lone high surrogate where Python keeps 53 whole emoji. The Python script
   resolves its root from its own location, so a scratch copy of the pinned
   script runs against a scratch installer tree. */
test('L1: the comparison_mode diagnostic equals the pinned Python text for a 60-emoji line', () => {
  const interp = resolveInterpreter();
  const dir = freshDir('assemble-emoji');
  const launcher = makeLauncher(dir, interp.path);
  const root = join(dir, 'tree');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'installer/branches'), { recursive: true });
  cpSync(join(VENDOR, 'scripts/assemble.py'), join(root, 'scripts/assemble.py'));
  const core = `comparison_mode: ${'😀'.repeat(60)}\n`;
  writeFileSync(join(root, 'installer/core.md'), core);
  writeFileSync(join(root, 'installer/branches/generic.md'), 'generic\n');
  const passport = join(dir, 'passport.md');
  writeFileSync(passport, `x\n${PLACEHOLDER}\n`);
  const py = spawnSync('python3', [join(root, 'scripts/assemble.py'), passport, '--branch=generic'], {
    env: { ...process.env, PATH: launcher.path },
    encoding: 'utf8',
  });
  assert.equal(py.status, 1);
  const pyFail = py.stderr.split('\n').filter((l) => l.startsWith('FAIL: '));
  assert.equal(pyFail.length, 1, py.stderr);
  let nodeFail = null;
  try {
    assemble(readText(passport), { root, branch: 'generic' });
  } catch (e) {
    assert.equal(e.code, 'E_INSTALLER_HAZARD');
    nodeFail = e.message.split('\n').filter((l) => l.startsWith('FAIL: '));
  }
  assert.deepEqual(nodeFail, pyFail, 'diagnostic text must equal the Python text');
  const tail = pyFail[0].slice(pyFail[0].lastIndexOf('colon: ') + 'colon: '.length);
  assert.equal(Array.from(tail).length, 70, '17-character prefix plus 53 whole emoji');
  assert.equal(tail.length, 17 + 53 * 2, 'no lone surrogate');
});
