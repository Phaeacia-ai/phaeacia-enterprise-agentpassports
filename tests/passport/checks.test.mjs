/* Fail/pass pairs for the scoped local checks (architecture section 11):
   import boundaries, dependency pinning, the secret scan and the format gate.
   Each faulty case is built in an isolated scratch tree; the repository itself
   is the passing control. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { FORBIDDEN_NOISE, LONE_SURROGATE, PY_SPACE, pyStrip } from '../../lib/passport/assemble.mjs';
import { ownedPaths } from '../../scripts/check-format.mjs';
import { checkImports, moduleReferences } from '../../scripts/check-imports.mjs';
import { DISPOSITIONS } from '../../scripts/check-secrets.mjs';
import { REPO, freshDir, sha256 } from './helpers.mjs';

function runCheck(script, args) {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', script), ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/* The number of source files the scanner sees under lib/, so a count
   assertion proves the files a test writes were scanned without coupling to
   the size of lib/ (at a003e51 the counts were literals written for a lib/
   holding one file; E1b's render.mjs broke both, 2026-09-10). */
function libSourceFiles() {
  return readdirSync(join(REPO, 'lib'), { recursive: true }).filter((f) => /\.(mjs|js|cjs)$/.test(String(f))).length;
}

/* A minimal tree with the real lock and a copy of lib/passport, so the
   allowlist and test-only rules read real data. Since the import contract
   (2026-09-11) resolves relative specifiers by exact name, the vendor stubs
   include _sections.mjs, which the copied lib/passport/render.mjs imports. */
function boundaryTree() {
  const root = freshDir('check-imports');
  cpSync(join(REPO, 'upstream.lock.json'), join(root, 'upstream.lock.json'));
  cpSync(join(REPO, 'lib'), join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, 'vendor/passport/web/lib'), { recursive: true });
  writeFileSync(join(root, 'vendor/passport/web/lib/_metrics.mjs'), 'export {};\n');
  writeFileSync(join(root, 'vendor/passport/web/lib/_validate.mjs'), 'export {};\n');
  writeFileSync(join(root, 'vendor/passport/web/lib/_sections.mjs'), 'export {};\n');
  writeFileSync(join(root, 'vendor/passport/web/lib/_derive.mjs'), 'export {};\n');
  return root;
}

test('check-imports: the repository passes (control)', () => {
  const r = runCheck('check-imports.mjs', []);
  assert.equal(r.code, 0, r.out);
});

test('check-imports: an importer of a test_only path under lib/ fails', () => {
  const root = boundaryTree();
  writeFileSync(join(root, 'lib/passport/bad.mjs'), "import '../../vendor/passport/web/lib/_metrics.mjs';\n");
  const r = runCheck('check-imports.mjs', ['--root', root]);
  assert.equal(r.code, 2);
  assert.match(
    r.out,
    /importer of a test_only path outside vendor\/ and tests\/: lib\/passport\/bad\.mjs -> vendor\/passport\/web\/lib\/_metrics\.mjs/,
  );
  assert.match(r.out, /lib\/ imports vendor outside allowlist\.runtime/);
});

test('check-imports: a runtime-allowlisted vendor import under lib/passport passes', () => {
  const root = boundaryTree();
  writeFileSync(
    join(root, 'lib/passport/gate.mjs'),
    "export { validate } from '../../vendor/passport/web/lib/_validate.mjs';\n",
  );
  const r = runCheck('check-imports.mjs', ['--root', root]);
  assert.equal(r.code, 0, r.out);
});

test('check-imports: fetch( and child_process under lib/passport fail', () => {
  const root = boundaryTree();
  writeFileSync(join(root, 'lib/passport/net.mjs'), "export const f = () => fetch('https://example.invalid');\n");
  writeFileSync(
    join(root, 'lib/passport/exec.mjs'),
    "import { execFileSync } from 'node:child_process';\nexport { execFileSync };\n",
  );
  const r = runCheck('check-imports.mjs', ['--root', root]);
  assert.equal(r.code, 2);
  assert.match(r.out, /no fetch under lib\/passport: lib\/passport\/net\.mjs/);
  assert.match(r.out, /no child_process under lib\/passport: lib\/passport\/exec\.mjs/);
});

test('check-imports: a forbidden module-map edge and a cycle fail', () => {
  const root = boundaryTree();
  mkdirSync(join(root, 'lib/rules'), { recursive: true });
  mkdirSync(join(root, 'lib/db'), { recursive: true });
  writeFileSync(join(root, 'lib/db/client.mjs'), "import '../rules/x.mjs';\nexport {};\n");
  writeFileSync(
    join(root, 'lib/rules/x.mjs'),
    "import '../db/client.mjs';\nimport { readFileSync } from 'node:fs';\nexport { readFileSync };\n",
  );
  const r = runCheck('check-imports.mjs', ['--root', root]);
  assert.equal(r.code, 2);
  assert.match(r.out, /edge not in the module map \(lib\/rules\/ -> lib\/db\/client\.mjs\)/);
  assert.match(r.out, /edge not in the module map \(lib\/db\/ -> lib\/rules\/x\.mjs\)/);
  assert.match(r.out, /lib\/rules imports nothing with IO: lib\/rules\/x\.mjs -> node:fs/);
  assert.match(r.out, /import cycle: lib\/db\/client\.mjs -> lib\/rules\/x\.mjs -> lib\/db\/client\.mjs/);
});

test('check-deps: the repository passes (control); a caret range and a missing lock entry fail', () => {
  assert.equal(runCheck('check-deps.mjs', []).code, 0);
  const root = freshDir('check-deps');
  cpSync(join(REPO, 'package-lock.json'), join(root, 'package-lock.json'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ devDependencies: { '@biomejs/biome': '^2.5.12', 'left-pad': '1.3.0' } }),
  );
  const r = runCheck('check-deps.mjs', ['--root', root]);
  assert.equal(r.code, 2);
  assert.match(r.out, /unpinned range \^2\.5\.12: @biomejs\/biome/);
  assert.match(r.out, /dependency missing from the lockfile: left-pad/);
});

test('check-secrets: a second positional path is refused, not silently dropped (e4-prereqs lesson 2)', () => {
  const dir = freshDir('check-secrets-args');
  const a = join(dir, 'a.txt');
  const b = join(dir, 'b.txt');
  writeFileSync(a, 'nothing here\n');
  writeFileSync(b, 'nothing here either\n');
  const r = runCheck('check-secrets.mjs', ['--paths', a, b]);
  assert.equal(r.code, 1);
  assert.match(r.out, /unexpected argument/);
  assert.doesNotMatch(r.out, /0 problem\(s\)/);
  assert.equal(runCheck('check-secrets.mjs', ['--paths', `${a},${b}`]).code, 0);
});

test('check-secrets: the tracked tree passes (control); a planted key in a fixture fails by rule and line only', () => {
  assert.equal(runCheck('check-secrets.mjs', []).code, 0);
  const dir = freshDir('check-secrets');
  const planted = join(dir, 'planted.md');
  const token = `sk-ant-${'a'.repeat(24)}`;
  writeFileSync(planted, `# fixture named to trip the scan\n\nkey: ${token}\n`);
  const clean = join(dir, 'clean.md');
  writeFileSync(clean, '# nothing here\n');
  const r = runCheck('check-secrets.mjs', ['--paths', `${planted},${clean}`]);
  assert.equal(r.code, 2);
  assert.match(r.out, new RegExp(`REFUSE an Anthropic key: ${planted.replace(/[.]/g, '\\.')}:3`));
  assert.ok(!r.out.includes(token), 'the matched text must not be printed');
  const ok = runCheck('check-secrets.mjs', ['--paths', clean]);
  assert.equal(ok.code, 0);
});

test('check-format: owned paths derive from biome.json includes; other wildcards are refused', () => {
  assert.deepEqual(ownedPaths({ files: { includes: ['lib/**', 'tests/passport/**', 'package.json'] } }), [
    'lib',
    'tests/passport',
    'package.json',
  ]);
  assert.throws(() => ownedPaths({ files: { includes: ['scripts/*.mjs'] } }), /unsupported include pattern/);
  assert.throws(() => ownedPaths({ files: {} }), /missing or empty/);
});

test('check-format: the repository passes (control); a stray biome.json under .scratch/ breaks a root run but not the gate', () => {
  assert.equal(runCheck('check-format.mjs', []).code, 0);
  const stray = join(freshDir('check-format'), 'biome.json');
  cpSync(join(REPO, 'biome.json'), stray);
  try {
    /* Counterexample: the gate at 5580fc4 ran `biome ci .`, which scans the
       whole checkout for configuration files and refuses the stray one. */
    const root = spawnSync(join(REPO, 'node_modules', '.bin', 'biome'), ['ci', '--colors=off', '.'], {
      cwd: REPO,
      encoding: 'utf8',
    });
    assert.notEqual(root.status, 0);
    assert.match(`${root.stdout}${root.stderr}`, /nested root configuration/);
    const r = runCheck('check-format.mjs', []);
    assert.equal(r.code, 0, r.out);
    /* The gate must cover exactly the configured includes, derived here from biome.json through
       the gate's own ownedPaths() rather than a hard-coded list (E2, 2026-09-10: the earlier
       literal broke when tests/e2 and netlify were added, the third E1 instance of a test
       coupled to repository shape). */
    const configured = ownedPaths(JSON.parse(readFileSync(join(REPO, 'biome.json'), 'utf8'))).join(' ');
    assert.ok(
      r.out.includes(`check-format: biome ci over ${configured}; lock and vendor ignored`),
      `${configured}\n${r.out}`,
    );
  } finally {
    rmSync(stray);
  }
});

/* ---------- H2 corrections (evidence/e1-adapter-critique.md, 2026-09-10) ---------- */

/* The critic executed both forms against a scratch vendor copy and reached
   highEntropyHits from lib/passport/: the regex scanner at c874c79 saw no
   specifier in either. */
test('H2: a template-literal dynamic import and an `export * as` re-export of a test-only module fail', () => {
  const rootA = boundaryTree();
  writeFileSync(
    join(rootA, 'lib/passport/probe.mjs'),
    'export const probe = () => import(`../../vendor/passport/web/lib/_metrics.mjs`);\n',
  );
  const a = runCheck('check-imports.mjs', ['--root', rootA]);
  assert.equal(a.code, 2, `case A: ${a.out}`);
  assert.match(a.out, /dynamic import without a single string literal: lib\/passport\/probe\.mjs/);
  const rootB = boundaryTree();
  writeFileSync(
    join(rootB, 'lib/passport/probe.mjs'),
    "export * as metrics from '../../vendor/passport/web/lib/_metrics.mjs';\n",
  );
  const b = runCheck('check-imports.mjs', ['--root', rootB]);
  assert.equal(b.code, 2, `case B: ${b.out}`);
  assert.match(
    b.out,
    /importer of a test_only path outside vendor\/ and tests\/: lib\/passport\/probe\.mjs -> vendor\/passport\/web\/lib\/_metrics\.mjs/,
  );
});

test('H2: every non-literal module form is refused as unsupported, and under the import contract the literal form too', () => {
  const root = boundaryTree();
  writeFileSync(
    join(root, 'lib/passport/forms.mjs'),
    [
      "const name = '../../vendor/passport/web/lib/_validate.mjs';",
      'export const a = () => import(name);',
      "export const b = () => import('../../vendor/passport/web/lib/' + name);",
      "export const c = () => import('../../vendor/passport/web/lib/_validate.mjs', { with: {} });",
      '',
    ].join('\n'),
  );
  const r = runCheck('check-imports.mjs', ['--root', root]);
  assert.equal(r.code, 2, r.out);
  assert.equal((r.out.match(/dynamic import without a single string literal/g) ?? []).length, 3, r.out);
  /* Reversed by the import contract (rule 3, E2 corrections 2, 2026-09-11). Until 5b2c4b4 this literal form
     was the passing control (exit 0). Under lib/ every import( is now refused, literal or not; the literal
     form is still not reported as unresolvable. */
  const literal = boundaryTree();
  writeFileSync(
    join(literal, 'lib/passport/literal.mjs'),
    "export const a = () => import('../../vendor/passport/web/lib/_validate.mjs');\n",
  );
  const c = runCheck('check-imports.mjs', ['--root', literal]);
  assert.equal(c.code, 2, c.out);
  assert.match(c.out, /REFUSE dynamic import\( refused under lib\/ and netlify\/: lib\/passport\/literal\.mjs:1\n/);
  assert.ok(!c.out.includes('without a single string literal'), c.out);
});

test('H2: .js and .cjs files under lib/ are scanned, including require() and static re-exports', () => {
  const root = boundaryTree();
  writeFileSync(
    join(root, 'lib/passport/legacy.js'),
    "export { highEntropyHits } from '../../vendor/passport/web/lib/_metrics.mjs';\n",
  );
  writeFileSync(
    join(root, 'lib/passport/legacy.cjs'),
    "module.exports = require('../../vendor/passport/web/lib/_metrics.mjs');\n",
  );
  writeFileSync(join(root, 'lib/passport/dyn.cjs'), 'module.exports = (p) => require(p);\n');
  const r = runCheck('check-imports.mjs', ['--root', root]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, new RegExp(`check-imports: ${libSourceFiles() + 3} files`));
  assert.match(r.out, /test_only path outside vendor\/ and tests\/: lib\/passport\/legacy\.js -> /);
  assert.match(r.out, /test_only path outside vendor\/ and tests\/: lib\/passport\/legacy\.cjs -> /);
  assert.match(r.out, /dynamic require without a single string literal: lib\/passport\/dyn\.cjs/);
});

test('H2: an unmapped directory under lib/ is production and restricted, not unrestricted', () => {
  const root = boundaryTree();
  mkdirSync(join(root, 'lib/extra'), { recursive: true });
  mkdirSync(join(root, 'lib/db'), { recursive: true });
  writeFileSync(join(root, 'lib/db/client.mjs'), 'export const client = 1;\n');
  writeFileSync(join(root, 'lib/extra/probe.mjs'), "export * from '../db/client.mjs';\n");
  const r = runCheck('check-imports.mjs', ['--root', root]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /directory under lib\/ not in the module map: lib\/extra\//);
  assert.match(r.out, /edge not in the module map \(lib\/extra\/ -> lib\/db\/client\.mjs\)/);
});

test('H2: a query or hash suffix on a specifier does not evade the test-only lookup', () => {
  const root = boundaryTree();
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/probe.mjs'), "import '../vendor/passport/web/lib/_metrics.mjs?x=1';\n");
  const r = runCheck('check-imports.mjs', ['--root', root]);
  assert.equal(r.code, 2, r.out);
  assert.match(
    r.out,
    /test_only path outside vendor\/ and tests\/: scripts\/probe\.mjs -> vendor\/passport\/web\/lib\/_metrics\.mjs/,
  );
});

test('H2: a path in a string, a comment or a regular expression is not an edge; the words import and export there are refused', () => {
  /* Zero-finding control kept from H2: a test-only and a sensitive path in a comment, a string, a template
     and a regular expression, without the words import, export or require, produce no finding. */
  const quiet = boundaryTree();
  writeFileSync(
    join(quiet, 'lib/passport/quiet.mjs'),
    [
      '// ../../vendor/passport/web/lib/_metrics.mjs and ../db/operator.mjs',
      '/* ../../vendor/passport/web/lib/_metrics.mjs */',
      "export const s = '../../vendor/passport/web/lib/_metrics.mjs';",
      'export const t = `../db/operator.mjs`;',
      'export const re = /_metrics\\.mjs|operator\\.mjs/;',
      '',
    ].join('\n'),
  );
  const q = runCheck('check-imports.mjs', ['--root', quiet]);
  assert.equal(q.code, 0, q.out);
  assert.match(q.out, new RegExp(`check-imports: ${libSourceFiles() + 1} files, 0 problem\\(s\\)`));
  /* Reversed by the import contract (rules 3 and 7, E2 corrections 2, 2026-09-11). Until 5b2c4b4 these five
     lines were the zero-finding control (exit 0), because the tokenizer kept comments, strings and regular
     expressions opaque. Under lib/ the words import and export there are now refused line by line, and the
     template's import( is refused and read as an edge. */
  const loud = boundaryTree();
  writeFileSync(
    join(loud, 'lib/passport/quiet.mjs'),
    [
      "// import '../../vendor/passport/web/lib/_metrics.mjs'",
      "/* export * from '../../vendor/passport/web/lib/_metrics.mjs' */",
      'export const s = "import \'../../vendor/passport/web/lib/_metrics.mjs\'";',
      ["export const t = `import('../../vendor/passport/web/lib/_metrics.mjs') $", '{s}`;'].join(''),
      'export const re = /import\\(["\']x["\']\\)/;',
      '',
    ].join('\n'),
  );
  const r = runCheck('check-imports.mjs', ['--root', loud]);
  assert.equal(r.code, 2, r.out);
  for (const expected of [
    'import outside an accepted module-reference line: lib/passport/quiet.mjs:1',
    'export outside an accepted export line: lib/passport/quiet.mjs:2',
    'import outside an accepted module-reference line: lib/passport/quiet.mjs:3',
    'dynamic import( refused under lib/ and netlify/: lib/passport/quiet.mjs:4',
    'import outside an accepted module-reference line: lib/passport/quiet.mjs:5',
  ]) {
    assert.ok(r.out.includes(`REFUSE ${expected}\n`), `${expected}\n${r.out}`);
  }
});

/* ---------- H3 correction (evidence/e1-adapter-critique.md, 2026-09-10) ---------- */

/* The pinned rule `a password assignment` uses \s, which spans a newline, so
   the credential below is one match over the body and none on either line.
   The gate at c874c79 split lines first and reported 0 problems; the pinned
   validator's own history (vendor _validate.mjs, secret scan) records the same
   defect and the whole-body-then-map-offsets correction reused here. */
test('H3: a multi-line password assignment is refused at the line where the match starts', () => {
  const dir = freshDir('check-secrets-multiline');
  const multi = join(dir, 'multi.md');
  /* Assembled at runtime so that this test file does not itself match. */
  const key = ['pass', 'word'].join('');
  const value = 'synthetic-not-a-real-value';
  writeFileSync(multi, `# synthetic\n\nsettings:\n  ${key}:\n    ${value}\n`);
  const one = join(dir, 'one.md');
  writeFileSync(one, `# synthetic\n\n${key}: ${value}\n`);
  const clean = join(dir, 'clean.md');
  writeFileSync(clean, `# synthetic\n\n${key} policy: rotate quarterly\n`);
  const r = runCheck('check-secrets.mjs', ['--paths', `${multi},${one},${clean}`]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, new RegExp(`REFUSE a password assignment: ${multi.replace(/[.]/g, '\\.')}:4\\n`));
  assert.match(r.out, new RegExp(`REFUSE a password assignment: ${one.replace(/[.]/g, '\\.')}:3\\n`));
  assert.ok(!r.out.includes(value), 'the matched text must not be printed');
  assert.ok(!r.out.includes(clean), 'the clean control has no finding');
  assert.equal(runCheck('check-secrets.mjs', ['--paths', clean]).code, 0);
  /* The tracked tree passes. Its one disposition names a record that is not part of the published tree, so nothing
     is dispositioned here; M2 below exercises that disposition in a scratch tree that holds the file. */
  const tracked = runCheck('check-secrets.mjs', []);
  assert.equal(tracked.code, 0, tracked.out);
  assert.match(tracked.out, /, 0 dispositioned\n/);
  assert.deepEqual(
    DISPOSITIONS.map((d) => `${d.rule} ${d.path}`),
    ['a password assignment evidence/e1-adapter-critique.md:136'],
  );
});

/* ---------- H2-R1 correction (evidence/e1-adapter-critique-2.md, 2026-09-10) ---------- */

/* The tokenizer at 036dac9 built a token list for every template substitution
   and discarded it, so an executable import() inside a template was invisible.
   The critic executed the nested case below against the real vendor tree and
   reached highEntropyHits from lib/passport/ with the boundary reporting
   0 problems. Literal template text and comments stay opaque. Probe sources
   are assembled through sub() so that this file carries no placeholder text
   for the lint rule to flag. */
const METRICS = '../../vendor/passport/web/lib/_metrics.mjs';
const sub = (inner) => ['$', '{', inner, '}'].join('');

test('H2-R1: an executable import() inside a nested template substitution is refused', () => {
  /* The critic's exact probe: `${`${typeof (await import('<metrics>')).highEntropyHits}`}` */
  const nested = boundaryTree();
  const nestedSource = `export const probe = async () => \`${sub(`\`${sub(`typeof (await import('${METRICS}')).highEntropyHits`)}\``)}\`;\n`;
  assert.equal(
    nestedSource,
    'export const probe = async () => `$' +
      '{`$' +
      "{typeof (await import('../../vendor/passport/web/lib/_metrics.mjs')).highEntropyHits}`}`;\n",
  );
  writeFileSync(join(nested, 'lib/passport/probe.mjs'), nestedSource);
  const a = runCheck('check-imports.mjs', ['--root', nested]);
  assert.equal(a.code, 2, `nested case: ${a.out}`);
  assert.match(
    a.out,
    /importer of a test_only path outside vendor\/ and tests\/: lib\/passport\/probe\.mjs -> vendor\/passport\/web\/lib\/_metrics\.mjs/,
  );
  assert.match(a.out, /lib\/ imports vendor outside allowlist\.runtime: lib\/passport\/probe\.mjs -> /);
  /* The same route with the literal wrapped in a template is the unsupported form. */
  const wrapped = boundaryTree();
  writeFileSync(
    join(wrapped, 'lib/passport/probe.mjs'),
    `export const w = () => \`${sub(`\`${sub(`import(\`${METRICS}\`)`)}\``)}\`;\n`,
  );
  const b = runCheck('check-imports.mjs', ['--root', wrapped]);
  assert.equal(b.code, 2, `wrapped case: ${b.out}`);
  assert.match(b.out, /dynamic import without a single string literal: lib\/passport\/probe\.mjs:1/);
  /* A require() two substitutions deep in a .cjs file is found on its own line. */
  const deep = boundaryTree();
  writeFileSync(
    join(deep, 'lib/passport/deep.cjs'),
    `const s = 1;\nmodule.exports = \`a${sub('s')}b${sub(`\`c${sub(`\n  require('${METRICS}')\n`)}\``)}\`;\n`,
  );
  const c = runCheck('check-imports.mjs', ['--root', deep]);
  assert.equal(c.code, 2, `deep case: ${c.out}`);
  assert.match(
    c.out,
    /importer of a test_only path outside vendor\/ and tests\/: lib\/passport\/deep\.cjs -> vendor\/passport\/web\/lib\/_metrics\.mjs:?/,
  );
  assert.match(c.out, /lib\/passport\/deep\.cjs -> vendor\/passport\/web\/lib\/_metrics\.mjs/);
});

test('H2-R1: harmless substitutions, nested templates and division produce no finding; import, export and require in template text and comments are refused', () => {
  const root = boundaryTree();
  writeFileSync(
    join(root, 'lib/passport/quiet.mjs'),
    [
      "const s = 'x';",
      `export const harmless = \`value ${sub('s')} and ${sub(`\`nested ${sub('s')}\``)} and ${sub('s.length / 2')}\`;`,
      '',
    ].join('\n'),
  );
  const r = runCheck('check-imports.mjs', ['--root', root]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`check-imports: ${libSourceFiles() + 1} files, 0 problem\\(s\\)`));
  /* Reversed by the import contract (rules 3 and 7, E2 corrections 2, 2026-09-11). Until 5b2c4b4 these lines
     belonged to the zero-finding control (exit 0), because the tokenizer kept template text and comments
     opaque. Under lib/ each carries a refused word and is now refused on its line; the template newline in the
     line comment case moves the last entry to line 9. */
  const loud = boundaryTree();
  writeFileSync(
    join(loud, 'lib/passport/loud.mjs'),
    [
      "const s = 'x';",
      `export const literalOnly = \`import('${METRICS}') ${sub('s')} export * from '${METRICS}'\`;`,
      `export const nestedLiteralOnly = \`${sub(`\`require('${METRICS}')\``)}\`;`,
      `// await import('${METRICS}')`,
      `/* export * as m from '${METRICS}' */`,
      `export const commentInSubstitution = \`${sub(`/* import('${METRICS}') */ s`)}\`;`,
      `export const lineCommentInSubstitution = \`${sub(`s // import('${METRICS}')\n`)}\`;`,
      `export const stringInSubstitution = \`${sub(`"import('${METRICS}')"`)}\`;`,
      '',
    ].join('\n'),
  );
  const l = runCheck('check-imports.mjs', ['--root', loud]);
  assert.equal(l.code, 2, l.out);
  for (const expected of [
    'dynamic import( refused under lib/ and netlify/: lib/passport/loud.mjs:2',
    'export outside an accepted export line: lib/passport/loud.mjs:2',
    'require refused under lib/ and netlify/: lib/passport/loud.mjs:3',
    'dynamic import( refused under lib/ and netlify/: lib/passport/loud.mjs:4',
    'export outside an accepted export line: lib/passport/loud.mjs:5',
    'dynamic import( refused under lib/ and netlify/: lib/passport/loud.mjs:6',
    'dynamic import( refused under lib/ and netlify/: lib/passport/loud.mjs:7',
    'dynamic import( refused under lib/ and netlify/: lib/passport/loud.mjs:9',
  ]) {
    assert.ok(l.out.includes(`REFUSE ${expected}\n`), `${expected}\n${l.out}`);
  }
});

/* ---------- M2 correction (evidence/e1-adapter-critique-2.md, 2026-09-10) ---------- */

/* A scratch root with the real pinned validator and its one import, so the
   disposition is exercised against the exact pinned rule at the exact
   dispositioned path. The synthetic key is assembled at runtime so that this
   test file does not match itself. */
function dispositionTree() {
  const root = freshDir('check-secrets-disposition');
  mkdirSync(join(root, 'vendor/passport/web/lib'), { recursive: true });
  for (const f of ['_validate.mjs', '_sections.mjs']) {
    cpSync(join(REPO, 'vendor/passport/web/lib', f), join(root, 'vendor/passport/web/lib', f));
  }
  mkdirSync(join(root, 'evidence'), { recursive: true });
  return root;
}
const DISPOSITION_FILE = 'evidence/e1-adapter-critique.md';
const SYNTHETIC_KEY = ['pass', 'word'].join('');
const SYNTHETIC_VALUE = `synthetic-not-a-real-${SYNTHETIC_KEY}`;
const dispositionBody = (leadingNewlines, key, value) => `${'\n'.repeat(leadingNewlines)}${key}:\n${value}\n`;

test('M2: the disposition is bound to the hash of the matched text and reports itself when stale', () => {
  const [d] = DISPOSITIONS;
  assert.equal(d.path, `${DISPOSITION_FILE}:136`);
  assert.match(d.match_sha256, /^[0-9a-f]{64}$/);
  /* The reviewed synthetic match is the key, its colon, a newline and the value. */
  assert.equal(d.match_sha256, sha256(Buffer.from(`${SYNTHETIC_KEY}:\n${SYNTHETIC_VALUE}`, 'utf8')));
  const escaped = DISPOSITION_FILE.replace(/[.]/g, '\\.');
  const run = (root) => runCheck('check-secrets.mjs', ['--root', root, '--paths', DISPOSITION_FILE]);

  /* Original value at line 136: dispositioned. */
  const original = dispositionTree();
  writeFileSync(join(original, DISPOSITION_FILE), dispositionBody(135, SYNTHETIC_KEY, SYNTHETIC_VALUE));
  const o = run(original);
  assert.equal(o.code, 0, o.out);
  assert.match(o.out, /0 problem\(s\), 1 dispositioned\n/);

  /* Changed value at the same line: refused, and the disposition is stale. */
  const changed = dispositionTree();
  writeFileSync(join(changed, DISPOSITION_FILE), dispositionBody(135, SYNTHETIC_KEY, 'different-synthetic-value-98'));
  const c = run(changed);
  assert.equal(c.code, 2, c.out);
  assert.match(c.out, new RegExp(`REFUSE a password assignment: ${escaped}:136\\n`));
  assert.match(c.out, new RegExp(`REFUSE stale disposition, no matching finding: ${escaped}:136\\n`));
  assert.ok(!c.out.includes('different-synthetic-value-98'), 'the matched text must not be printed');
  assert.match(c.out, /, 0 dispositioned\n/);

  /* Match moved by one line: refused at the new line. */
  const moved = dispositionTree();
  writeFileSync(join(moved, DISPOSITION_FILE), dispositionBody(136, SYNTHETIC_KEY, SYNTHETIC_VALUE));
  const m = run(moved);
  assert.equal(m.code, 2, m.out);
  assert.match(m.out, new RegExp(`REFUSE a password assignment: ${escaped}:137\\n`));
  assert.match(m.out, new RegExp(`REFUSE stale disposition, no matching finding: ${escaped}:136\\n`));

  /* Match removed: the file scans clean but the disposition is stale. */
  const removed = dispositionTree();
  writeFileSync(join(removed, DISPOSITION_FILE), `${'\n'.repeat(135)}${SYNTHETIC_KEY} policy: rotate quarterly\n`);
  const s = run(removed);
  assert.equal(s.code, 2, s.out);
  assert.match(s.out, new RegExp(`^REFUSE stale disposition, no matching finding: ${escaped}:136\\n`, 'm'));
  assert.match(s.out, /1 problem\(s\), 0 dispositioned\n/);

  /* Same rule and line in another file: refused; the dispositioned file was not scanned, so nothing is stale. */
  const other = dispositionTree();
  writeFileSync(join(other, 'evidence/other.md'), dispositionBody(135, SYNTHETIC_KEY, SYNTHETIC_VALUE));
  const t = runCheck('check-secrets.mjs', ['--root', other, '--paths', 'evidence/other.md']);
  assert.equal(t.code, 2, t.out);
  assert.match(t.out, /REFUSE a password assignment: evidence\/other\.md:136\n/);
  assert.ok(!t.out.includes('stale disposition'), t.out);
  assert.match(t.out, /1 problem\(s\), 0 dispositioned\n/);

  /* A different rule at the same location: refused under its own rule. */
  const otherRule = dispositionTree();
  writeFileSync(join(otherRule, DISPOSITION_FILE), `${'\n'.repeat(135)}key: sk-ant-${'a'.repeat(24)}\n`);
  const u = run(otherRule);
  assert.equal(u.code, 2, u.out);
  assert.match(u.out, new RegExp(`REFUSE an Anthropic key: ${escaped}:136\\n`));
  assert.match(u.out, new RegExp(`REFUSE stale disposition, no matching finding: ${escaped}:136\\n`));
  assert.match(u.out, /, 0 dispositioned\n/);
});

/* ---------- Import-check contract (E2 corrections 2, 2026-09-11) ---------- */

/* scripts/check-imports.mjs implements the contract of docs/setup/import-check-reassessment.md, option B with
   rule 7. Each case is the permitted E2 graph plus one attempt, written to a scratch directory and passed to
   the exported checkImports(). P1 to P8 are the probes of the reassessment's section 2; P1b is a walker escape
   found while implementing (the old walker skipped a directory named vendor at any depth); the M2-R1 and M2-R2
   cases are the fixtures of evidence/e2-implementation-critique-2.md; R7 are section 4a's fixtures; R1 and R5
   are contract rules 1 and 5. Cases marked `control` behave alike before and after; every other case fails at
   5b2c4b4, and evidence/e2-corrections-2.md records each fail-before text. Where `runs` is given, the fixture is
   imported first, so each refusal is shown to be of a module through which Node reaches the forbidden value. */
const CONTRACT_GRAPH = {
  'lib/errors.mjs': 'export const x = 1;\n',
  'lib/session.mjs': "import { createHmac } from 'node:crypto';\nexport const y = createHmac;\n",
  'lib/db/operator.mjs': 'export const o = 7;\n',
  'lib/db/server.mjs': "import { x } from '../errors.mjs';\nexport const s = x;\n",
  'lib/services/invitations.mjs':
    "import { o } from '../db/operator.mjs';\nimport { s } from '../db/server.mjs';\nexport const i = [o, s];\n",
  'lib/services/members.mjs': "import { s } from '../db/server.mjs';\nexport const m = s;\n",
  'lib/services/source.mjs': 'export const value = 1;\n',
  'lib/http/routes.mjs': "import { m } from '../services/members.mjs';\nexport const r = m;\n",
  'lib/rules/roles.mjs': 'export const ROLES = [];\n',
  'netlify/functions/members.mjs': "import { r } from '../../lib/http/routes.mjs';\nexport default r;\n",
};
const OPERATOR_IMPORT = 'operator client imported outside lib/operator, scripts, tests, lib/services/invitations.mjs';
const SPECIFIER_TEXT = 'percent-encoded, escaped or control-character specifier refused';
const EXACT_NAME = 'relative specifier does not name an examined file exactly';
const ESCAPE = 'unicode or hex escape sequence refused under lib/ and netlify/';
const DYNAMIC = 'dynamic import( refused under lib/ and netlify/';
const IMPORT_LINE = 'import outside an accepted module-reference line';
const EXPORT_LINE = 'export outside an accepted export line';
const NAME = 'file name outside the contract grammar';
const LOADER = 'module loader refused under lib/ and netlify/';
const BUILTIN = 'node: built-in outside the lib/ and netlify/ allowlist';
const OPERATOR_REEXPORT =
  'operator client re-exported to an importer outside lib/operator, scripts, tests, lib/services/invitations.mjs';

const CONTRACT_CASES = [
  {
    id: 'P1',
    title: 'a symlink that names the operator client differently is refused',
    files: { 'lib/services/members.mjs': "import { o } from '../db/op-link.mjs';\nexport const m = o;\n" },
    symlinks: { 'lib/db/op-link.mjs': 'operator.mjs' },
    runs: ['lib/services/members.mjs', 'm', 7],
    refuse: [
      'symbolic link refused under lib/ and netlify/: lib/db/op-link.mjs',
      `${EXACT_NAME}: lib/services/members.mjs:1 -> ../db/op-link.mjs`,
    ],
  },
  {
    id: 'P1b',
    title: 'a directory named vendor inside lib/ is examined rather than skipped',
    files: {
      'lib/services/vendor/steal.mjs': "export { o } from '../../db/operator.mjs';\n",
      'lib/http/routes.mjs': "import { o } from '../services/vendor/steal.mjs';\nexport const r = o;\n",
    },
    runs: ['lib/http/routes.mjs', 'r', 7],
    refuse: [`${OPERATOR_IMPORT}: lib/services/vendor/steal.mjs -> lib/db/operator.mjs`],
  },
  {
    id: 'P2',
    title: 'a re-export by the one permitted importer does not pass the operator client on',
    files: {
      'lib/services/invitations.mjs':
        "import { s } from '../db/server.mjs';\nexport const i = s;\nexport { o } from '../db/operator.mjs';\n",
      'lib/http/routes.mjs': "import { o } from '../services/invitations.mjs';\nexport const r = o;\n",
    },
    runs: ['lib/http/routes.mjs', 'r', 7],
    refuse: [
      'operator client re-exported to an importer outside lib/operator, scripts, tests, lib/services/invitations.mjs: lib/http/routes.mjs -> lib/services/invitations.mjs',
    ],
  },
  {
    id: 'P3',
    title: 'a TypeScript module under lib/ is refused by name, and so is the import that names it',
    files: {
      'lib/http/evil.mts': "import { o } from '../db/operator.mjs';\nexport const e = o;\n",
      'lib/http/routes.mjs': "import { e } from './evil.mts';\nexport const r = e;\n",
    },
    refuse: [
      `${NAME}: lib/http/evil.mts`,
      `${IMPORT_LINE}: lib/http/routes.mjs:1`,
      `${EXACT_NAME}: lib/http/routes.mjs:1 -> ./evil.mts`,
    ],
  },
  {
    id: 'P4',
    title: 'an import() where the old tokenizer guessed a regular expression is refused',
    files: {
      'lib/http/sneak.mjs': "let n = 0;\nexport const p = n++ / [import('../db/operator.mjs').then((m) => m.o)] / 1;\n",
    },
    refuse: [`${DYNAMIC}: lib/http/sneak.mjs:2`, `${OPERATOR_IMPORT}: lib/http/sneak.mjs -> lib/db/operator.mjs`],
  },
  {
    id: 'P5',
    title: 'an escaped identifier spelling process under lib/rules is refused',
    files: { 'lib/rules/esc.mjs': 'export const secret = () => \\u0070rocess.env.HOME;\n' },
    refuse: [`${ESCAPE}: lib/rules/esc.mjs:1`],
  },
  {
    id: 'P6',
    title: 'process where the old tokenizer guessed a regular expression is refused under lib/rules',
    files: { 'lib/rules/hide.mjs': 'let n = 0;\nexport const h = () => n++ / [process.env] / 1;\n' },
    refuse: ['no process access under lib/rules: lib/rules/hide.mjs'],
  },
  {
    id: 'P7',
    title: 'indirect eval and the async function constructor under lib/rules are refused by name',
    files: {
      'lib/rules/ev.mjs': "export const e = () => (0, eval)('typeof pro' + 'cess.env');\n",
      'lib/rules/ctor.mjs':
        "export const c = () => Object.getPrototypeOf(async function () {}).constructor('return process')();\n",
    },
    refuse: [
      'eval refused under lib/ and netlify/: lib/rules/ev.mjs:1',
      'no constructor under lib/rules: lib/rules/ctor.mjs',
    ],
  },
  {
    id: 'P8',
    title: 'a case variant of the operator client path is refused on every filesystem',
    files: { 'lib/services/members.mjs': "import { o } from '../db/Operator.mjs';\nexport const m = o;\n" },
    refuse: [
      `${IMPORT_LINE}: lib/services/members.mjs:1`,
      `${EXACT_NAME}: lib/services/members.mjs:1 -> ../db/Operator.mjs`,
    ],
  },
  {
    id: 'R1',
    title: 'file and directory names outside the grammar under lib/ and netlify/ are refused',
    files: {
      'lib/http/Upper.mjs': 'export const u = 1;\n',
      'lib/http/under_score.mjs': 'export const u = 1;\n',
      'lib/http/data.json': '{}\n',
      'netlify/functions/legacy.js': 'export default 1;\n',
      'lib/Http2/x.mjs': 'export const x = 1;\n',
    },
    refuse: [
      `${NAME}: lib/http/Upper.mjs`,
      `${NAME}: lib/http/under_score.mjs`,
      `${NAME}: lib/http/data.json`,
      `${NAME}: netlify/functions/legacy.js`,
      'directory name outside the contract grammar: lib/Http2/',
    ],
  },
  {
    id: 'M2-R1 escaped tab',
    title: 'a re-export whose specifier holds an escaped tab is refused',
    files: { 'lib/services/members.mjs': "export { o } from '../db/oper\\tator.mjs';\n" },
    runs: ['lib/services/members.mjs', 'o', 7],
    refuse: [
      `${SPECIFIER_TEXT}: lib/services/members.mjs:1 -> ../db/oper\\tator.mjs`,
      `${EXPORT_LINE}: lib/services/members.mjs:1`,
    ],
  },
  {
    id: 'M2-R1 escaped newline',
    title: 'a re-export whose specifier holds an escaped newline is refused',
    files: { 'lib/services/members.mjs': "export { o } from '../db/oper\\nator.mjs';\n" },
    runs: ['lib/services/members.mjs', 'o', 7],
    refuse: [
      `${SPECIFIER_TEXT}: lib/services/members.mjs:1 -> ../db/oper\\nator.mjs`,
      `${EXPORT_LINE}: lib/services/members.mjs:1`,
    ],
  },
  {
    id: 'M2-R1 literal tab',
    title: 'a re-export whose specifier holds a literal tab is refused',
    files: { 'lib/services/members.mjs': "export { o } from '../db/oper\tator.mjs';\n" },
    runs: ['lib/services/members.mjs', 'o', 7],
    refuse: [
      `${SPECIFIER_TEXT}: lib/services/members.mjs:1 -> ../db/oper\tator.mjs`,
      `${EXPORT_LINE}: lib/services/members.mjs:1`,
    ],
  },
  {
    id: 'M2-R1 dynamic escaped tab',
    title: 'a dynamic import whose specifier holds an escaped tab is refused',
    files: { 'lib/services/members.mjs': "export const o = (await import('../db/oper\\tator.mjs')).o;\n" },
    runs: ['lib/services/members.mjs', 'o', 7],
    refuse: [
      `${DYNAMIC}: lib/services/members.mjs:1`,
      `${SPECIFIER_TEXT}: lib/services/members.mjs:1 -> ../db/oper\\tator.mjs`,
    ],
  },
  {
    id: 'M2-R2 escaped process',
    title: 'an escaped identifier for process under lib/rules is refused',
    files: { 'lib/rules/roles.mjs': 'export const o = pr\\u006fcess.env.ENTERPRISE_ACCESS_STATE;\n' },
    runs: ['lib/rules/roles.mjs', 'o', process.env.ENTERPRISE_ACCESS_STATE],
    refuse: [`${ESCAPE}: lib/rules/roles.mjs:1`],
  },
  {
    id: 'M2-R2 escaped fetch',
    title: 'an escaped identifier for fetch under lib/rules is refused',
    files: { 'lib/rules/roles.mjs': 'export const o = typeof f\\u0065tch;\n' },
    runs: ['lib/rules/roles.mjs', 'o', 'function'],
    refuse: [`${ESCAPE}: lib/rules/roles.mjs:1`],
  },
  {
    id: 'R7 one-line re-export',
    control: true,
    title: 'a one-line re-export at column 0 is accepted',
    files: { 'lib/services/members.mjs': "export { value } from './source.mjs';\n" },
    accept: true,
  },
  {
    id: 'R7 multi-line re-export',
    title: 'a re-export whose braces span lines is refused',
    files: { 'lib/services/members.mjs': "export {\n  value\n} from './source.mjs';\n" },
    refuse: [`${EXPORT_LINE}: lib/services/members.mjs:1`],
  },
  {
    id: 'R7 indented re-export',
    title: 'an indented re-export is refused',
    files: { 'lib/services/members.mjs': "  export { value } from './source.mjs';\n" },
    refuse: [`${EXPORT_LINE}: lib/services/members.mjs:1`],
  },
  {
    id: 'R7 re-export with attributes',
    title: 'a re-export with an attributes clause is refused',
    files: { 'lib/services/members.mjs': "export { value } from './source.mjs' with { type: 'json' };\n" },
    refuse: [`${EXPORT_LINE}: lib/services/members.mjs:1`],
  },
  {
    id: 'R7 export default from + 1',
    control: true,
    title: 'a local default export whose from is not followed by a string is accepted',
    files: { 'lib/services/members.mjs': 'const from = 1;\nexport default from + 1;\n' },
    accept: true,
  },
  {
    id: 'R7 export default from a string',
    title: 'a default export followed by from and a string literal is refused',
    files: { 'lib/services/members.mjs': "export default from './source.mjs';\n" },
    refuse: [`${EXPORT_LINE}: lib/services/members.mjs:1`],
  },
  {
    id: 'R5',
    title: 'the service-key name is refused outside lib/db/operator.mjs and accepted inside it',
    files: {
      'lib/db/operator.mjs': "export const o = 7;\nexport const name = 'SUPABASE_SERVICE_ROLE_KEY';\n",
      'lib/services/copy.mjs': 'export const key = () => process.env.SUPABASE_SERVICE_ROLE_KEY;\n',
      'netlify/functions/key.mjs': 'export default () => process.env.SUPABASE_SERVICE_ROLE_KEY;\n',
    },
    refuse: [
      'service-key name outside lib/db/operator.mjs: lib/services/copy.mjs:1',
      'service-key name outside lib/db/operator.mjs: netlify/functions/key.mjs:1',
    ],
    absent: [': lib/db/operator.mjs:'],
  },
  {
    id: 'C1',
    control: true,
    title: 'a dynamic import of a template literal stays refused',
    files: { 'lib/http/dyn.mjs': 'export const d = () => import(`../db/operator.mjs`);\n' },
    refuse: ['dynamic import without a single string literal: lib/http/dyn.mjs:1'],
  },
  {
    id: 'C2',
    control: true,
    title: 'a percent-encoded specifier stays refused',
    files: { 'lib/services/members.mjs': "import { o } from '../db/%6fperator.mjs';\nexport const m = o;\n" },
    refuse: [/^percent-encoded.* specifier refused: lib\/services\/members\.mjs:1 -> \.\.\/db\/%6fperator\.mjs$/],
  },
  {
    id: 'C3',
    control: true,
    title: 'process reached through globalThis brackets stays refused under lib/rules',
    files: { 'lib/rules/roles.mjs': "export const s = () => globalThis['process'];\n" },
    refuse: [
      'no globalThis under lib/rules: lib/rules/roles.mjs',
      'no process access under lib/rules: lib/rules/roles.mjs',
    ],
  },
  /* Rule 4 as extended by the lead's answer to Q4: a binding taken from a client by an accepted import line and
     re-exported through export { name };, export { name as alias }; or export default name; carries the
     client, as does a chain of such modules. A value flow stays outside the contract (control below). */
  {
    id: 'Q4 named',
    title: 'an imported operator binding re-exported through export { name }; carries the client',
    files: {
      'lib/services/invitations.mjs': "import { o } from '../db/operator.mjs';\nexport { o };\n",
      'lib/http/routes.mjs': "import { o } from '../services/invitations.mjs';\nexport const r = o;\n",
    },
    runs: ['lib/http/routes.mjs', 'r', 7],
    refuse: [`${OPERATOR_REEXPORT}: lib/http/routes.mjs -> lib/services/invitations.mjs`],
  },
  {
    id: 'Q4 aliased',
    title: 'an aliased operator binding re-exported under another alias carries the client',
    files: {
      'lib/services/invitations.mjs': "import { o as client } from '../db/operator.mjs';\nexport { client as c };\n",
      'lib/http/routes.mjs': "import { c } from '../services/invitations.mjs';\nexport const r = c;\n",
    },
    runs: ['lib/http/routes.mjs', 'r', 7],
    refuse: [`${OPERATOR_REEXPORT}: lib/http/routes.mjs -> lib/services/invitations.mjs`],
  },
  {
    id: 'Q4 namespace',
    title: 'an operator namespace binding re-exported through export { name }; carries the client',
    files: {
      'lib/services/invitations.mjs': "import * as operator from '../db/operator.mjs';\nexport { operator };\n",
      'lib/http/routes.mjs': "import { operator } from '../services/invitations.mjs';\nexport const r = operator.o;\n",
    },
    runs: ['lib/http/routes.mjs', 'r', 7],
    refuse: [`${OPERATOR_REEXPORT}: lib/http/routes.mjs -> lib/services/invitations.mjs`],
  },
  {
    id: 'Q4 default chain',
    title: 'a default binding re-exported through export default name; and then export { name }; carries the client',
    files: {
      'lib/db/operator.mjs': 'export const o = 7;\nexport default o;\n',
      'lib/services/invitations.mjs': "import client from '../db/operator.mjs';\nexport default client;\n",
      'lib/services/relay.mjs': "import client from './invitations.mjs';\nexport { client };\n",
      'lib/http/routes.mjs': "import { client } from '../services/relay.mjs';\nexport const r = client;\n",
    },
    runs: ['lib/http/routes.mjs', 'r', 7],
    refuse: [
      `${OPERATOR_REEXPORT}: lib/services/relay.mjs -> lib/services/invitations.mjs`,
      `${OPERATOR_REEXPORT}: lib/http/routes.mjs -> lib/services/relay.mjs`,
    ],
  },
  {
    id: 'Q4 server',
    title: 'a server client binding re-exported by a service is refused to lib/http',
    files: {
      'lib/services/members.mjs': "import { s } from '../db/server.mjs';\nexport { s };\n",
      'lib/http/routes.mjs': "import { s } from '../services/members.mjs';\nexport const r = s;\n",
    },
    refuse: [
      'server client re-exported to an importer outside lib/services, lib/operator: lib/http/routes.mjs -> lib/services/members.mjs',
    ],
  },
  {
    id: 'Q4 value flow',
    control: true,
    title:
      'a value flow such as export const t = o is outside rule 4 (the rule 4 guard in boundaries.test.mjs pins it)',
    files: {
      'lib/services/invitations.mjs': "import { o } from '../db/operator.mjs';\nexport const t = o;\n",
      'lib/http/routes.mjs': "import { t } from '../services/invitations.mjs';\nexport const r = t;\n",
    },
    runs: ['lib/http/routes.mjs', 'r', 7],
    accept: true,
  },
  /* L1 to L3: module loaders and built-ins outside the allowlist, found by the lead while reproducing E2
     corrections 2 (evidence/e1-lead.md, 2026-09-11); they pass the gate at 6898c45 as well. L4 is their control. */
  {
    id: 'L1',
    title: 'createRequire from node:module loads the operator client from lib/http by a literal path',
    files: {
      'lib/http/loader.mjs': [
        "import { createRequire } from 'node:module';",
        '',
        'const load = createRequire(import.meta.url);',
        "export const r = load('../db/operator.mjs').o;",
        '',
      ].join('\n'),
    },
    runs: ['lib/http/loader.mjs', 'r', 7],
    refuse: [
      `${BUILTIN}: lib/http/loader.mjs -> node:module`,
      `${LOADER}: lib/http/loader.mjs:1`,
      `${LOADER}: lib/http/loader.mjs:3`,
    ],
  },
  {
    id: 'L2',
    title: 'process.getBuiltinModule reaches node:module and the operator client without an import line',
    files: {
      'lib/http/loader.mjs': [
        "const loader = process.getBuiltinModule('node:module');",
        "export const r = loader.createRequire(import.meta.url)('../db/operator.mjs').o;",
        '',
      ].join('\n'),
    },
    runs: ['lib/http/loader.mjs', 'r', 7],
    refuse: [`${LOADER}: lib/http/loader.mjs:1`, `${LOADER}: lib/http/loader.mjs:2`],
  },
  {
    id: 'L3',
    title: 'a node: built-in outside the allowlist is refused in every reference form under lib/ and netlify/',
    files: {
      'lib/http/vm.mjs': "import { runInThisContext } from 'node:vm';\nexport const v = runInThisContext;\n",
      'lib/services/threads.mjs': "export * from 'node:worker_threads';\n",
      'netlify/functions/spawn.mjs': "import 'node:child_process';\n",
    },
    refuse: [
      `${BUILTIN}: lib/http/vm.mjs -> node:vm`,
      `${BUILTIN}: lib/services/threads.mjs -> node:worker_threads`,
      `${BUILTIN}: netlify/functions/spawn.mjs -> node:child_process`,
    ],
  },
  {
    id: 'L4',
    control: true,
    title: 'the allowlisted built-ins node:crypto, node:fs and node:path stay accepted',
    files: {
      'lib/services/digest.mjs': [
        "import { createHash } from 'node:crypto';",
        "import { readFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'export const d = [createHash, readFileSync, join];',
        '',
      ].join('\n'),
    },
    accept: true,
  },
  /* M2-R3 and M2-R4: the Codex recheck of 99e0e79 (evidence/e2-corrections-2-recheck.md). M2-R3 reaches
     the operator client through process.mainModule from a CommonJS entry; M2-R4 adds a second exported
     name in one declaration that the holder guard undercounts. Both pass the gate at 99e0e79. */
  {
    id: 'M2-R3',
    title: 'process.mainModule reaches the module class and the operator client from lib/http',
    files: {
      'lib/http/loader.mjs': [
        "export const value = process.mainModule.constructor._load(new URL('../db/operator.mjs', import.meta.url).pathname).o;",
        '',
      ].join('\n'),
    },
    refuse: [`${LOADER}: lib/http/loader.mjs:1`],
  },
  /* M2-R4 (Codex recheck 3): a second declarator that binds a client to a new export, `export const a = x,
     leaked = client`, is a value flow, which lead decision Q4 leaves outside the gate; the gate accepts it with
     no finding, and its compensating control is the holder export-name guard in tests/e2/unit/boundaries.test.mjs,
     which enumerates each holder's real exports through Node. The first fix here tried to refuse the form in the
     gate with a text scan; recheck 3 defeated the scan with comments, a regular expression, a nested template
     and a continuation line, and it wrongly refused a legitimate nested-template initializer. That scan is
     reverted; the regression for M2-R4 lives with the guard it protects. */
  {
    id: 'M2-R4 value flow (control)',
    control: true,
    title: 'a second declarator binding a client to a new export is a value flow the gate does not police (Q4)',
    files: {
      'lib/services/invitations.mjs': [
        "import { o } from '../db/operator.mjs';",
        'export const value = o, leaked = o;',
        '',
      ].join('\n'),
    },
    runs: ['lib/services/invitations.mjs', 'leaked', 7],
    accept: true,
  },
];

function contractTree(files, symlinks = {}) {
  const root = freshDir('import-contract');
  for (const [rel, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), source);
  }
  for (const [rel, target] of Object.entries(symlinks)) symlinkSync(target, join(root, rel));
  return root;
}

for (const c of CONTRACT_CASES) {
  test(`import contract ${c.id}${c.control ? ' (control)' : ''}: ${c.title}`, async () => {
    const root = contractTree({ ...CONTRACT_GRAPH, ...c.files }, c.symlinks);
    if (c.runs) {
      const [rel, name, value] = c.runs;
      const mod = await import(pathToFileURL(join(root, rel)).href);
      assert.equal(mod[name], value, `Node did not reach the forbidden value through ${rel}`);
    }
    const found = checkImports(root).problems.map((p) => `${p.rule}: ${p.path}`);
    const shown = found.length ? found.join('\n') : '(no finding)';
    if (c.accept) assert.deepEqual(found, [], shown);
    for (const expected of c.refuse ?? []) {
      const hit = expected instanceof RegExp ? found.some((f) => expected.test(f)) : found.includes(expected);
      assert.ok(hit, `expected: ${expected}\nfound:\n${shown}`);
    }
    for (const text of c.absent ?? []) assert.ok(!found.some((f) => f.includes(text)), `unexpected ${text}\n${shown}`);
  });
}

/* ---------- the named exception for lib/passport/render.mjs (lead decision Q1, 2026-09-11) ---------- */

const PINNED = 'lib/passport/render.mjs';
/* A stand-in for the pinned file: each form the exception admits (lines 1 to 6) and one of each it does not
   (lines 7 to 12). */
const PINNED_SOURCE = [
  '/* A comment naming the import and a re-export, and an escape: \\u0041. */',
  'import {',
  '  FENCE,',
  '  sectionLines as sliceSection,',
  "} from '../../vendor/passport/web/lib/_sections.mjs';",
  "export const nul = '\\u0000';",
  "export const later = () => import('../../vendor/passport/web/lib/_sections.mjs');",
  "export const legacy = () => require('node:fs');",
  '  import { FENCE as F } from "../../vendor/passport/web/lib/_sections.mjs";',
  'import {',
  '  Upper,',
  "} from '../../vendor/passport/web/lib/Sections.mjs';",
  '',
].join('\n');

/* The derived entry for the pinned path sits second in the list, so a match by index would miss it. */
function pinnedTree(entryPath, entryHash) {
  const root = contractTree({
    [PINNED]: PINNED_SOURCE,
    'vendor/passport/web/lib/_sections.mjs': 'export {};\n',
  });
  const lock = {
    test_only_paths: [],
    allowlist: { runtime: ['web/lib/_sections.mjs'] },
    derived: [
      { path: 'lib/passport/other.mjs', derived_sha256: '0'.repeat(64) },
      { path: entryPath, derived_sha256: entryHash },
    ],
  };
  writeFileSync(join(root, 'upstream.lock.json'), JSON.stringify(lock));
  return root;
}
const findingsOf = (root) => checkImports(root).problems.map((p) => `${p.rule}: ${p.path}`);

test('named exception: at its registered hash render.mjs is exempt from the split import, stray words and escapes only', () => {
  const found = findingsOf(pinnedTree(PINNED, sha256(PINNED_SOURCE)));
  assert.deepEqual(
    found.sort(),
    [
      'dynamic import( refused under lib/ and netlify/: lib/passport/render.mjs:7',
      'require refused under lib/ and netlify/: lib/passport/render.mjs:8',
      'import outside an accepted module-reference line: lib/passport/render.mjs:9',
      'import outside an accepted module-reference line: lib/passport/render.mjs:10',
      'specifier outside the contract grammar: lib/passport/render.mjs:10 -> ../../vendor/passport/web/lib/Sections.mjs',
      'relative specifier does not name an examined file exactly: lib/passport/render.mjs:10 -> ../../vendor/passport/web/lib/Sections.mjs',
      'lib/ imports vendor outside allowlist.runtime: lib/passport/render.mjs -> vendor/passport/web/lib/Sections.mjs',
    ].sort(),
  );
});

test('named exception: a different hash or an entry under another path withdraws it and applies the full contract', () => {
  const underFullContract = [
    'import outside an accepted module-reference line: lib/passport/render.mjs:1',
    'export outside an accepted export line: lib/passport/render.mjs:1',
    'unicode or hex escape sequence refused under lib/ and netlify/: lib/passport/render.mjs:1',
    'import outside an accepted module-reference line: lib/passport/render.mjs:2',
    'unicode or hex escape sequence refused under lib/ and netlify/: lib/passport/render.mjs:6',
  ];
  const changed = findingsOf(pinnedTree(PINNED, '1'.repeat(64)));
  for (const expected of [
    'pinned derived exception withdrawn, bytes differ from derived_sha256: lib/passport/render.mjs',
    ...underFullContract,
  ]) {
    assert.ok(changed.includes(expected), `${expected}\n${changed.join('\n')}`);
  }
  const elsewhere = findingsOf(pinnedTree('lib/passport/renderer.mjs', sha256(PINNED_SOURCE)));
  for (const expected of [
    'pinned derived exception withdrawn, no upstream.lock.json derived entry: lib/passport/render.mjs',
    ...underFullContract,
  ]) {
    assert.ok(elsewhere.includes(expected), `${expected}\n${elsewhere.join('\n')}`);
  }
});

test('named exception: the references read from the real render.mjs at its registered hash are pinned', () => {
  const lock = JSON.parse(readFileSync(join(REPO, 'upstream.lock.json'), 'utf8'));
  const entry = lock.derived.find((d) => d.path === PINNED);
  const bytes = readFileSync(join(REPO, PINNED));
  assert.equal(sha256(bytes), entry.derived_sha256, 'render.mjs differs from its derived entry: review this pin');
  assert.deepEqual(moduleReferences(bytes.toString('utf8')), {
    specifiers: [{ spec: '../../vendor/passport/web/lib/_sections.mjs', line: 75, form: 'import' }],
    problems: [],
  });
});

/* ---------- lib/passport/assemble.mjs built from code points (lead condition on Q1, 2026-09-11) ---------- */

/* The three expressions exactly as lib/passport/assemble.mjs held them at 5b2c4b4 (lines 44, 53 and 86); tests/
   is outside the contract, so the escapes stay here as the reference. */
const ORIGINAL_FORBIDDEN_NOISE = /\\|`|\*|_|\u00ad|\u200b|\u200c|\u200d|\u2060|\ufeff/g;
const ORIGINAL_PY_SPACE =
  '\\t\\n\\x0b\\x0c\\r\\x1c\\x1d\\x1e\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const ORIGINAL_LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('assemble.mjs: the code-point expressions equal the original escaped ones for every UTF-16 code unit, surrogate pair and lone surrogate in context', () => {
  const originalClass = new RegExp(`[${ORIGINAL_PY_SPACE}]`);
  const rewrittenClass = new RegExp(`[${PY_SPACE}]`);
  const originalLstrip = new RegExp(`^[${ORIGINAL_PY_SPACE}]+`);
  const originalRstrip = new RegExp(`[${ORIGINAL_PY_SPACE}]+$`);
  let compared = 0;
  let different = 0;
  const shown = [];
  const note = (text) => {
    compared++;
    /* replace() on a /g expression starts at 0 and leaves lastIndex at 0, so no state carries over. */
    const which =
      text.replace(ORIGINAL_FORBIDDEN_NOISE, '') !== text.replace(FORBIDDEN_NOISE, '')
        ? 'FORBIDDEN_NOISE'
        : originalClass.test(text) !== rewrittenClass.test(text)
          ? 'PY_SPACE'
          : text.replace(originalLstrip, '').replace(originalRstrip, '') !== pyStrip(text)
            ? 'pyStrip'
            : ORIGINAL_LONE_SURROGATE.test(text) !== LONE_SURROGATE.test(text)
              ? 'LONE_SURROGATE'
              : null;
    if (!which) return;
    different++;
    if (shown.length < 20) {
      const units = Array.from({ length: text.length }, (_, i) => text.charCodeAt(i).toString(16));
      shown.push(`${which}: ${units.join(' ')}`);
    }
  };
  for (let unit = 0; unit <= 0xffff; unit++) {
    const c = String.fromCharCode(unit);
    note(c);
    note(`a${c}b`);
    note(`${c}a${c}`);
  }
  for (let high = 0xd800; high <= 0xdbff; high++) {
    for (let low = 0xdc00; low <= 0xdfff; low++) note(`a${String.fromCharCode(high, low)}b`);
  }
  for (let unit = 0xd800; unit <= 0xdfff; unit++) {
    const lone = String.fromCharCode(unit);
    const partner = String.fromCharCode(unit < 0xdc00 ? unit + 0x400 : unit - 0x400);
    for (const text of [`${lone}a`, `a${lone}`, `${lone}${lone}`, `a${lone}${lone}b`]) note(text);
    /* A high after its low, or a low before its high: two lone surrogates, not a pair. */
    note(unit < 0xdc00 ? `${partner}${lone}` : `${lone}${partner}`);
  }
  assert.equal(compared, 0x10000 * 3 + 0x400 * 0x400 + 0x800 * 5);
  assert.equal(different, 0, shown.join('\n'));
});
