/* U10 (pages design 7.1 and 4.5): scripts/check-imports.mjs registers web/ as its third restricted tree. Refused: a web/
   module importing lib/, one importing node:fs, one importing a bare package, a lib/ module importing web/, a
   symbolic link and a .js file under web/, and rules 3 and 7 read under web/ as under lib/. Accepted:
   web/assets/app/pages/home.mjs importing ../api.mjs, with pages, styles and images named by rule 1. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkImports } from '../../../scripts/check-imports.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const BASE = {
  'lib/errors.mjs': 'export const x = 1;\n',
  'web/index.html': '<!doctype html>\n',
  'web/assets/enterprise.css': 'body {\n  margin: 0;\n}\n',
  'web/assets/app/api.mjs': 'export function call() {\n  return 1;\n}\n',
  'web/assets/app/pages/home.mjs': "import { call } from '../api.mjs';\n\nexport const started = call();\n",
};

function tree(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'web-imports-'));
  for (const [rel, text] of Object.entries({ ...BASE, ...extra })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const findings = (root) => checkImports(root).problems.map((p) => `${p.rule}: ${p.path}`);

function withTree(extra, check, prepare) {
  const root = tree(extra);
  try {
    prepare?.(root);
    check(findings(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('U10 control: pages/home.mjs importing ../api.mjs is accepted, with .html, .css and .svg named under web/', () => {
  withTree({ 'web/assets/mark.svg': '<svg></svg>\n' }, (f) => assert.deepEqual(f, []));
});

test('U10: a web/ module importing lib/ is refused by the edge', () => {
  withTree(
    { 'web/assets/app/pages/home.mjs': "import { x } from '../../../../lib/errors.mjs';\n\nexport const y = x;\n" },
    (f) =>
      assert.ok(
        f.includes('edge not in the module map (web/ -> lib/errors.mjs): web/assets/app/pages/home.mjs'),
        f.join('\n'),
      ),
  );
});

test('U10: a web/ module importing node:fs is refused', () => {
  withTree(
    { 'web/assets/app/pages/home.mjs': "import { readFileSync } from 'node:fs';\n\nexport const r = readFileSync;\n" },
    (f) => {
      assert.ok(
        f.includes('node: specifier refused under web/: web/assets/app/pages/home.mjs -> node:fs'),
        f.join('\n'),
      );
      assert.ok(
        f.includes(
          'specifier outside the web/ grammar (relative .mjs only): web/assets/app/pages/home.mjs:1 -> node:fs',
        ),
        f.join('\n'),
      );
    },
  );
});

test('U10: a bare package name under web/ is refused', () => {
  withTree({ 'web/assets/app/pages/home.mjs': "import x from 'left-pad';\n\nexport const y = x;\n" }, (f) => {
    assert.ok(
      f.includes('package import outside scripts/tests: web/assets/app/pages/home.mjs -> left-pad'),
      f.join('\n'),
    );
    assert.ok(
      f.some((l) => l.startsWith('specifier outside the web/ grammar')),
      f.join('\n'),
    );
  });
});

test('U10: a lib/ module importing web/ is refused by its own edge', () => {
  withTree(
    { 'lib/rules/page.mjs': "import { call } from '../../web/assets/app/api.mjs';\n\nexport const c = call;\n" },
    (f) =>
      assert.ok(
        f.includes('edge not in the module map (lib/rules/ -> web/assets/app/api.mjs): lib/rules/page.mjs'),
        f.join('\n'),
      ),
  );
});

test('U10: a symbolic link under web/ is refused', () => {
  withTree(
    {},
    (f) => assert.ok(f.includes('symbolic link refused under web/: web/assets/app/link.mjs'), f.join('\n')),
    (root) => symlinkSync(join(root, 'web/assets/app/api.mjs'), join(root, 'web/assets/app/link.mjs')),
  );
});

test('U10: a .js file under web/ is refused by name and still read', () => {
  withTree({ 'web/assets/app/extra.js': "import { x } from '../../../lib/errors.mjs';\n" }, (f) => {
    assert.ok(f.includes('file name outside the web/ grammar: web/assets/app/extra.js'), f.join('\n'));
    assert.ok(
      f.some((l) => l.startsWith('edge not in the module map (web/ -> lib/errors.mjs)')),
      f.join('\n'),
    );
  });
});

test('U10: rules 3, 5 and 7 read under web/ as under lib/, comments and strings included', () => {
  withTree(
    {
      'web/assets/app/pages/home.mjs': [
        "import { call } from '../api.mjs';",
        '',
        '// this comment says import, and that is refused',
        "export const loaded = import('../api.mjs');",
        "export const escaped = 'a\\u0041';",
        'export const started = call();',
        '',
      ].join('\n'),
    },
    (f) => {
      assert.ok(
        f.includes('import outside an accepted module-reference line: web/assets/app/pages/home.mjs:3'),
        f.join('\n'),
      );
      assert.ok(f.includes('dynamic import( refused under web/: web/assets/app/pages/home.mjs:4'), f.join('\n'));
      assert.ok(
        f.includes('unicode or hex escape sequence refused under web/: web/assets/app/pages/home.mjs:5'),
        f.join('\n'),
      );
    },
  );
});

test('U10: a relative specifier must name a walked web/ file exactly', () => {
  withTree({ 'web/assets/app/pages/home.mjs': "import { call } from '../API.mjs';\n\nexport const c = call;\n" }, (f) =>
    assert.ok(
      f.some((l) => l.startsWith('specifier outside the web/ grammar')),
      f.join('\n'),
    ),
  );
  withTree(
    { 'web/assets/app/pages/home.mjs': "import { call } from '../missing.mjs';\n\nexport const c = call;\n" },
    (f) =>
      assert.ok(
        f.includes(
          'relative specifier does not name an examined file exactly: web/assets/app/pages/home.mjs:1 -> ../missing.mjs',
        ),
        f.join('\n'),
      ),
  );
});

test('U10 control: the repository, web/ included, is clean', () => {
  assert.deepEqual(findings(REPO), []);
});
