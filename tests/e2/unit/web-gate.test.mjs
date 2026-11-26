/* U9 (pages design 7.1): scripts/check-web.mjs refuses each form of section 3's lists in a fixture tree, exits 2 and
   names the rule; the control fixture and the real web/ pass. One fixture is the documented miss: a name assembled
   while the page runs, in a form the list does not contain, passes this gate, and journey J17 carries its failing
   side. That makes the gate's bound a test result rather than a claim. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkWeb } from '../../../scripts/check-web.mjs';
import { MISS } from '../../browser/fixtures/j17.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PAGE = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="referrer" content="no-referrer">',
  '<meta name="robots" content="noindex, nofollow">',
  '<link rel="stylesheet" href="/assets/enterprise.css">',
  '<script type="module" src="/assets/app/pages/home.mjs"></script>',
  '</head>',
  '<body><main></main></body>',
  '</html>',
  '',
].join('\n');

const VALID = {
  'web/index.html': PAGE,
  'web/assets/enterprise.css': 'body {\n  margin: 0;\n}\n',
  'web/assets/app/api.mjs': "export function call(path) {\n  return fetch(path, { credentials: 'same-origin' });\n}\n",
  'web/assets/app/shell.mjs': 'export function go(target) {\n  location.assign(target);\n}\n',
  'web/assets/app/pages/home.mjs':
    "import { call } from '../api.mjs';\nimport { go } from '../shell.mjs';\n\ncall('/api/me').then(() => go('/'));\n",
};

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'web-gate-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const cli = (root) => {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'check-web.mjs'), '--root', root], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

const append = (rel, text) => (files) => ({ ...files, [rel]: files[rel] + text });
const replace = (rel, from, to) => (files) => {
  assert.equal(files[rel].split(from).length, 2, `${from} occurs once in ${rel}`);
  return { ...files, [rel]: files[rel].replace(from, to) };
};
const HOME = 'web/assets/app/pages/home.mjs';

/* [label, mutation, the rule the finding must name]. The first sixteen are U9's list; the rest are the section 3 forms
   the list implies and this gate also refuses. */
const REFUSED = [
  ['innerHTML', append(HOME, "document.body.innerHTML = 'x';\n"), 'rule 9: innerHTML refused'],
  /* B3-R-F5 (evidence/batch-3-review.md): the property twin of an attribute the quoted-name rule refuses, and the
     attribute-node route; each passed the gate at 8624c6f. */
  [
    '.srcdoc =',
    append(HOME, 'frame.srcdoc = fromServer;\n'),
    'rule 9: a document or target property assignment (srcdoc, action, formAction, data) refused',
  ],
  [
    '.formAction =',
    append(HOME, 'button.formAction = fromServer;\n'),
    'rule 9: a document or target property assignment (srcdoc, action, formAction, data) refused',
  ],
  [
    'setAttributeNode',
    append(HOME, "const at = document.createAttribute('href'); at.value = fromServer; el.setAttributeNode(at);\n"),
    'rule 9: setAttributeNode and createAttribute refused',
  ],
  ['setHTML', append(HOME, "document.body.setHTML('x');\n"), 'rule 9: setHTML refused'],
  /* TOOL-R1-F1 (evidence/e5-pages-review.md): the reviewer's page that passed the widened gate and still injected. */
  [
    'setAttributeNS',
    append(HOME, "document.body.setAttributeNS(null, 'onclick', fromServer);\n"),
    'rule 9: setAttributeNS refused',
  ],
  [
    'a computed attribute name',
    append(HOME, "document.body.setAttribute(['on', 'click'].join(''), fromServer);\n"),
    'rule 9: setAttribute with a name that is not a string literal',
  ],
  ['.href = outside its owners', append(HOME, 'away.href = fromServer;\n'), 'rule 9: an assignment to .href or .src'],
  /* TOOL2-R-F3 (evidence/batch-2-review.md): the quoted-name route past the computed-name refusal. */
  [
    "setAttribute('href')",
    append(HOME, "away.setAttribute('href', fromServer);\n"),
    'rule 9: setAttribute of a target or document attribute',
  ],
  [
    "setAttribute('srcdoc')",
    append(HOME, "frame.setAttribute('srcdoc', fromServer);\n"),
    'rule 9: setAttribute of a target or document attribute',
  ],
  ['.src = outside its owners', append(HOME, 'frame.src = fromServer;\n'), 'rule 9: an assignment to .href or .src'],
  ['parseHTMLUnsafe', append(HOME, "Document.parseHTMLUnsafe('x');\n"), 'rule 9: parseHTMLUnsafe refused'],
  [
    'Reflect.set',
    append(HOME, "Reflect.set(document.body, k, 'x');\n"),
    'rule 9: Reflect.set and Reflect.defineProperty refused',
  ],
  [
    'Object.defineProperty',
    append(HOME, "Object.defineProperty(document.body, k, { value: 'x' });\n"),
    'rule 9: Object.defineProperty refused',
  ],
  [
    "'inner' + 'HTML'",
    append(HOME, "document.body['inner' + 'HTML'] = 'x';\n"),
    'rule 9: a string literal ending in HTML refused',
  ],
  ['localStorage', append(HOME, "localStorage.setItem('k', 'v');\n"), 'rule 1: localStorage refused'],
  ['document.cookie', append(HOME, 'const c = document.cookie;\n'), 'rule 1: cookie refused'],
  ['fetch( outside api.mjs', append(HOME, "fetch('/api/me');\n"), 'rule 2: fetch outside web/assets/app/api.mjs'],
  ['window.fetch', append(HOME, "window.fetch('/api/me');\n"), 'rule 2: fetch outside web/assets/app/api.mjs'],
  ['globalThis.fetch', append(HOME, "globalThis.fetch('/api/me');\n"), 'rule 2: fetch outside web/assets/app/api.mjs'],
  ['window[', append(HOME, "window['fet' + 'ch']('/api/me');\n"), 'rule 2: computed member access on window'],
  ['location.assign outside shell.mjs', append(HOME, "location.assign('/');\n"), 'rule 10: a location writer'],
  [
    'a page without the viewport meta',
    replace('web/index.html', '<meta name="viewport" content="width=device-width, initial-scale=1">\n', ''),
    'rule 4: the viewport meta is missing',
  ],
  [
    'an inline script',
    replace('web/index.html', '</head>', '<script>go()</script>\n</head>'),
    'rule 4: exactly one script element',
  ],
  ['onclick=', replace('web/index.html', '<body>', '<body onclick="go()">'), 'rule 4: an on<event>= attribute'],
  ['style=', replace('web/index.html', '<main>', '<main class="x" style="color: red">'), 'rule 4: a style= attribute'],
  [
    'https:// in a script',
    append(HOME, "const u = 'https://example.invalid/';\n"),
    'rule 2: an absolute http or https URL',
  ],
  ['<base>', replace('web/index.html', '</head>', '<base href="/">\n</head>'), 'rule 4: <base refused'],
  ['@import in CSS', append('web/assets/enterprise.css', "@import 'other.css';\n"), 'CSS: @import refused'],
  ['a plain alias of fetch', append(HOME, 'const send = fetch;\n'), 'rule 2: fetch outside web/assets/app/api.mjs'],
  ['globalThis[', append(HOME, "globalThis['x'];\n"), 'rule 2: computed member access on globalThis'],
  ['self[', append(HOME, "self['x'];\n"), 'rule 2: computed member access on self'],
  ['XMLHttpRequest', append(HOME, 'new XMLHttpRequest();\n'), 'rule 2: XMLHttpRequest refused'],
  ['sendBeacon', append(HOME, "navigator.sendBeacon('/api/me');\n"), 'rule 2: sendBeacon refused'],
  ['a string starting //', append(HOME, "const u = '//example.invalid/';\n"), 'rule 2: a string starting //'],
  ['sessionStorage', append(HOME, 'sessionStorage.clear();\n'), 'rule 1: sessionStorage refused'],
  ['indexedDB', append(HOME, "indexedDB.open('x');\n"), 'rule 1: indexedDB refused'],
  ['caches', append(HOME, "caches.open('x');\n"), 'rule 1: caches refused'],
  ['serviceWorker', append(HOME, "navigator.serviceWorker.register('/x.mjs');\n"), 'rule 1: serviceWorker refused'],
  ['outerHTML', append(HOME, "document.body.outerHTML = 'x';\n"), 'rule 9: outerHTML refused'],
  [
    'insertAdjacentHTML',
    append(HOME, "document.body.insertAdjacentHTML('beforeend', 'x');\n"),
    'rule 9: insertAdjacentHTML',
  ],
  ['document.write', append(HOME, "document.write('x');\n"), 'rule 9: document.write refused'],
  ['DOMParser', append(HOME, 'new DOMParser();\n'), 'rule 9: DOMParser refused'],
  ['eval', append(HOME, "eval('1');\n"), 'rule 9: eval refused'],
  ['new Function', append(HOME, "new Function('return 1');\n"), 'rule 9: new Function refused'],
  ['a string to setTimeout', append(HOME, "setTimeout('go()', 1);\n"), 'rule 9: a string first argument'],
  ['alert(', append(HOME, "alert('x');\n"), 'rule 9: alert( refused'],
  ['confirm(', append(HOME, "confirm('x');\n"), 'rule 9: confirm( refused'],
  ['postMessage', append(HOME, "parent.postMessage('x', '*');\n"), 'rule 9: postMessage refused'],
  ['an onclick property', append(HOME, 'document.body.onclick = () => go();\n'), 'rule 9: an on<event> property'],
  [
    'setAttribute of a handler',
    append(HOME, "document.body.setAttribute('onclick', 'go()');\n"),
    'rule 9: setAttribute',
  ],
  ['the style property', append(HOME, "document.body.style.color = 'red';\n"), 'rule 9: the style property'],
  ['location.href outside shell.mjs', append(HOME, 'const here = location.href;\n'), 'rule 10: a location writer'],
  ['location = outside shell.mjs', append(HOME, "location = '/';\n"), 'rule 10: location = outside'],
  ['window.open', append(HOME, "window.open('/');\n"), 'rule 10: window.open outside'],
  ['<style', replace('web/index.html', '</head>', '<style>main{}</style>\n</head>'), 'rule 4: <style refused'],
  ['<iframe', replace('web/index.html', '<main>', '<iframe></iframe><main>'), 'rule 4: <iframe refused'],
  ['javascript:', replace('web/index.html', '<main>', '<a href="javascript:go()">x</a><main>'), 'rule 4: javascript:'],
  [
    'the robots meta missing',
    replace('web/index.html', '<meta name="robots" content="noindex, nofollow">\n', ''),
    'rule 8: the robots meta is missing',
  ],
  [
    "a script naming another page's module",
    replace('web/index.html', '/assets/app/pages/home.mjs', '/assets/app/pages/signin.mjs'),
    'rule 4: exactly one script element',
  ],
  ['url( in CSS', append('web/assets/enterprise.css', 'main {\n  background: url(x.svg);\n}\n'), 'CSS: url( refused'],
  [
    'a .js file under web/',
    (files) => ({ ...files, 'web/assets/app/x.js': 'export const x = 1;\n' }),
    'file name or type',
  ],
  [
    'an HTML file that is not a page',
    (files) => ({ ...files, 'web/other.html': PAGE }),
    "rule 4: an HTML file that is not a page's index.html",
  ],
];

test('U9 control: the valid fixture tree passes, exit 0', () => {
  const root = tree(VALID);
  try {
    assert.deepEqual(checkWeb(root).problems, []);
    const r = cli(root);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /check-web: 5 files, 0 problem\(s\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('U9: each refused form fails the gate, exit 2, naming its rule', () => {
  for (const [label, mutate, rule] of REFUSED) {
    const root = tree(mutate(VALID));
    try {
      const { problems } = checkWeb(root);
      assert.ok(
        problems.some((p) => p.rule.startsWith(rule)),
        `${label}: expected a finding starting "${rule}", got ${JSON.stringify(problems)}`,
      );
      const r = cli(root);
      assert.equal(r.code, 2, `${label}: ${r.out}`);
      assert.ok(r.out.includes(`REFUSE ${rule}`), `${label}: the CLI names the rule: ${r.out}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('U9: fetch( and location.assign are admitted in the one module each rule names, and nowhere else', () => {
  const root = tree({
    ...VALID,
    'web/assets/app/shell.mjs': `${VALID['web/assets/app/shell.mjs']}fetch('/api/me');\n`,
    'web/assets/app/api.mjs': `${VALID['web/assets/app/api.mjs']}location.assign('/');\n`,
  });
  try {
    const rules = checkWeb(root).problems.map((p) => `${p.rule} ${p.path}`);
    assert.deepEqual(rules, [
      'rule 10: a location writer outside web/assets/app/shell.mjs web/assets/app/api.mjs:4',
      'rule 2: fetch outside web/assets/app/api.mjs web/assets/app/shell.mjs:4',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('U9: a symbolic link under web/ is refused', () => {
  const root = tree(VALID);
  try {
    symlinkSync(join(root, 'web', 'assets', 'app', 'api.mjs'), join(root, 'web', 'assets', 'app', 'link.mjs'));
    assert.ok(checkWeb(root).problems.some((p) => p.rule === 'symbolic link refused under web/'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('U9 documented miss: a name assembled at run time in a form the list lacks passes this gate (J17 fails it)', () => {
  /* Recorded as a miss, not as a pass of the rule: the same text is J17's MISS fixture, where the initiator
     assertion must fail on the request it sends. */
  const root = tree(append(HOME, MISS)(VALID));
  try {
    assert.deepEqual(checkWeb(root).problems, []);
    assert.equal(cli(root).code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('U9 control: the real web/ passes', () => {
  const { files, problems } = checkWeb(REPO);
  assert.ok(files > 0, 'web/ holds files');
  assert.deepEqual(problems, []);
});

/* E6 design 4.1 and 4.3, granted to the E6 pages lane by the lead (2026-09-18): the operator's two nested pages, and
   the save control's one owner moved from pages/release.mjs to save-file.mjs so the release, home and members pages
   share it. Each row below is a fixture tree, not the real web/, so it states the rule rather than today's files. */
const nestedPage = (src) => PAGE.replace('/assets/app/pages/home.mjs', src);

test('E6: a page one level deeper loads the module named by both levels, and passes', () => {
  const root = tree({
    ...VALID,
    'web/operator/company/index.html': nestedPage('/assets/app/pages/operator-company.mjs'),
    'web/assets/app/pages/operator-company.mjs':
      "import { call } from '../api.mjs';\n\ncall('/api/operator/companies');\n",
  });
  try {
    assert.deepEqual(checkWeb(root).problems, []);
    assert.equal(cli(root).code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E6: a nested page naming a one-level module, a page three levels deep, and a page under assets/ are refused', () => {
  const cases = [
    [
      'the nested page names the module of its last level only',
      {
        'web/operator/company/index.html': nestedPage('/assets/app/pages/company.mjs'),
        'web/assets/app/pages/company.mjs': 'const x = 1;\n',
      },
      'rule 4: exactly one script element',
    ],
    [
      'a nested page whose module does not exist',
      { 'web/operator/company/index.html': nestedPage('/assets/app/pages/operator-company.mjs') },
      'rule 4: the page module assets/app/pages/operator-company.mjs does not exist',
    ],
    [
      'three levels',
      {
        'web/operator/company/audit/index.html': nestedPage('/assets/app/pages/operator-company-audit.mjs'),
        'web/assets/app/pages/operator-company-audit.mjs': 'const x = 1;\n',
      },
      "rule 4: an HTML file that is not a page's index.html",
    ],
    [
      'a page under web/assets/',
      {
        'web/assets/app/index.html': nestedPage('/assets/app/pages/assets-app.mjs'),
        'web/assets/app/pages/assets-app.mjs': 'const x = 1;\n',
      },
      "rule 4: an HTML file that is not a page's index.html",
    ],
  ];
  for (const [label, extra, rule] of cases) {
    const root = tree({ ...VALID, ...extra });
    try {
      const { problems } = checkWeb(root);
      assert.ok(
        problems.some((p) => p.rule.startsWith(rule)),
        `${label}: ${JSON.stringify(problems)}`,
      );
      assert.equal(cli(root).code, 2, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('E6: save-file.mjs owns one .href assignment; a second there, and any in release.mjs, are refused', () => {
  const SAVE = 'web/assets/app/save-file.mjs';
  const RELEASE = 'web/assets/app/pages/release.mjs';
  const one = 'export function saveBytes(url) {\n  const a = {};\n  a.href = url;\n}\n';
  const admitted = tree({ ...VALID, [SAVE]: one });
  try {
    assert.deepEqual(checkWeb(admitted).problems, [], 'the one owner assignment passes');
  } finally {
    rmSync(admitted, { recursive: true, force: true });
  }
  for (const [label, extra, path] of [
    ['a second assignment in the owner', { [SAVE]: `${one}const b = {};\nb.href = 'x';\n` }, `${SAVE}:6`],
    [
      'an assignment in release.mjs, the owner before E6',
      { [RELEASE]: "const a = {};\na.href = 'x';\n" },
      `${RELEASE}:2`,
    ],
  ]) {
    const root = tree({ ...VALID, ...extra });
    try {
      const found = checkWeb(root).problems.filter((p) => p.rule.startsWith('rule 9: an assignment to .href or .src'));
      assert.deepEqual(
        found.map((p) => p.path),
        [path],
        `${label}: ${JSON.stringify(found)}`,
      );
      assert.equal(cli(root).code, 2, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
