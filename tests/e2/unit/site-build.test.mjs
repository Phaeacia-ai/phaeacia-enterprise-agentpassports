/* U11 (pages design 7.1 and 4.6): scripts/build-site.mjs publishes exactly web/ and the vendored allowlist; a one-byte
   change to a vendored file fails its hash check; a forbidden string in a page or a module fails the scan; a stray
   file type under web/ is refused before anything is written; two builds into one target with a page deleted between
   them leave no file at the old path and no manifest entry for it; a non-empty --out without --clean is refused; and a
   file added to the output behind the build's back, or removed or changed, fails the manifest comparison. Each
   fixture root is a temporary tree with the real upstream.lock.json and copies of the six vendored files.

   The capture prompt (HOSTED-F3, evidence/operator-landing.md; step 4a of the build): the stub is not copied, the
   published module carries capture/enterprise.md's exact text and SHA-256 and the manifest names them; a prompt file
   whose bytes do not survive the round trip is refused; the file and the stub go together; and the published prompt
   passes the forbidden-string scan like any module. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildSite,
  CAPTURE_MODULE,
  CAPTURE_SOURCE,
  readCaptureModule,
  VENDOR_TARGET,
  VENDORED,
  verifyOutput,
} from '../../../scripts/build-site.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const PAGE = (module) =>
  `<!doctype html>\n<html lang="en">\n<head>\n<script type="module" src="/assets/app/pages/${module}.mjs"></script>\n</head>\n<body><main></main></body>\n</html>\n`;
const WEB = {
  'index.html': PAGE('home'),
  'signin/index.html': PAGE('signin'),
  'assets/enterprise.css': 'body {\n  margin: 0;\n}\n',
  'assets/app/pages/home.mjs': 'export const home = 1;\n',
  'assets/app/pages/signin.mjs': 'export const signin = 1;\n',
};

const made = [];
function fixture(web = WEB) {
  const root = mkdtempSync(join(tmpdir(), 'site-build-'));
  made.push(root);
  cpSync(join(REPO, 'upstream.lock.json'), join(root, 'upstream.lock.json'));
  for (const file of VENDORED) {
    const to = join(root, 'vendor/passport/web/assets', file);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(REPO, 'vendor/passport/web/assets', file), to);
  }
  for (const [rel, text] of Object.entries(web)) {
    mkdirSync(dirname(join(root, 'web', rel)), { recursive: true });
    writeFileSync(join(root, 'web', rel), text);
  }
  return { root, out: join(root, 'out', 'site'), manifest: join(root, 'out', 'site-manifest.json') };
}
test.after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function walk(dir, rel = '') {
  const out = [];
  for (const name of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${name.name}` : name.name;
    if (name.isDirectory()) out.push(...walk(dir, childRel));
    else out.push(childRel);
  }
  return out.sort();
}
const rules = (r) => r.problems.map((p) => `${p.rule}: ${p.path}`);

test('U11 control: a clean build publishes exactly web/ and the vendored allowlist, hashed, with the manifest outside', () => {
  const f = fixture();
  const r = buildSite({ root: f.root, out: f.out, manifest: f.manifest });
  assert.deepEqual(rules(r), []);
  const expected = [...Object.keys(WEB), ...VENDORED.map((v) => `${VENDOR_TARGET}/${v}`)].sort();
  assert.deepEqual(walk(f.out), expected, 'the output holds exactly the allowlist');
  assert.ok(!walk(f.out).some((p) => /base\.css|recipient\.css|app\.css|\/og\//.test(p)), 'nothing else from vendor');
  const manifest = JSON.parse(readFileSync(f.manifest, 'utf8'));
  assert.deepEqual(Object.keys(manifest.files).sort(), expected);
  for (const rel of Object.keys(WEB)) assert.equal(manifest.files[rel], sha256(readFileSync(join(f.root, 'web', rel))));
  const lock = JSON.parse(readFileSync(join(REPO, 'upstream.lock.json'), 'utf8'));
  for (const v of VENDORED) assert.equal(manifest.files[`${VENDOR_TARGET}/${v}`], lock.imported[`web/assets/${v}`]);
  assert.ok(!f.manifest.startsWith(`${f.out}/`), 'the manifest is not in the published tree');
});

test('U11: a one-byte change to a vendored file fails the hash check', () => {
  const f = fixture();
  appendFileSync(join(f.root, 'vendor/passport/web/assets/tokens.css'), ' ');
  const r = buildSite({ root: f.root, out: f.out, manifest: f.manifest });
  assert.deepEqual(rules(r), [
    `vendored copy differs from the SHA-256 upstream.lock.json registers: ${VENDOR_TARGET}/tokens.css`,
  ]);
});

test('U11: a forbidden string in a page, a module or a stylesheet fails the scan', () => {
  const f = fixture({
    ...WEB,
    'index.html': PAGE('home').replace('<main></main>', '<main><a href="/gallery">x</a></main>'),
    'assets/app/pages/home.mjs': "export const host = 'app.phaeacia.ai';\n",
  });
  const found = rules(buildSite({ root: f.root, out: f.out, manifest: f.manifest }));
  assert.ok(
    found.some((l) => l.startsWith('build scan: forbidden string "/gallery"') && l.endsWith(': index.html')),
    found,
  );
  assert.ok(found.includes('build scan: forbidden string "app.phaeacia.ai": assets/app/pages/home.mjs'), found);
});

/* The one exemption of the scan (E6 pages lane, lead grant 2026-09-18): '/delete' is admitted in assets/app/api.mjs
   inside the exact template literal of POST /api/operator/companies/{companyId}/delete, and nowhere else. */
const DELETE_LITERAL = '`/api/operator/companies/${segment(companyId)}/delete`';
const API_CALLER = `export const deleteCompany = (companyId) =>\n  call('POST', ${DELETE_LITERAL});\n`;

test('U11 E6: the operator delete route literal in api.mjs is admitted, and only that literal in only that file', () => {
  const found = (web) => {
    const f = fixture({ ...WEB, ...web });
    return rules(buildSite({ root: f.root, out: f.out, manifest: f.manifest })).filter((l) => l.includes('"/delete"'));
  };
  assert.deepEqual(found({ 'assets/app/api.mjs': API_CALLER }), [], '(i) the exempted literal passes');
  assert.deepEqual(
    found({ 'assets/app/api.mjs': `${API_CALLER}export const gallery = '/delete';\n` }),
    ['build scan: forbidden string "/delete": assets/app/api.mjs'],
    '(ii) the string anywhere else in api.mjs still fails',
  );
  assert.deepEqual(
    found({ 'assets/app/api.mjs': API_CALLER, 'assets/app/pages/home.mjs': "export const d = '/api/x/delete';\n" }),
    ['build scan: forbidden string "/delete": assets/app/pages/home.mjs'],
    '(iii) the string in any other published file still fails',
  );
  assert.deepEqual(
    found({ 'assets/app/pages/home.mjs': `const call = () => 0;\n${API_CALLER}` }),
    ['build scan: forbidden string "/delete": assets/app/pages/home.mjs'],
    '(iv) the exempted literal in another file still fails',
  );
  assert.deepEqual(
    found({ 'assets/app/api.mjs': API_CALLER.replace('${segment(companyId)}', '${companyId}') }),
    ['build scan: forbidden string "/delete": assets/app/api.mjs'],
    'a literal that is not the exact one is not exempted',
  );
});

test('U11: a stray file type or a symbolic link under web/ is refused and nothing is written', () => {
  const f = fixture({ ...WEB, 'assets/app/extra.js': 'export const x = 1;\n' });
  symlinkSync(join(f.root, 'web/index.html'), join(f.root, 'web/assets/link.html'));
  const r = buildSite({ root: f.root, out: f.out, manifest: f.manifest });
  assert.deepEqual(rules(r).sort(), [
    'file name or type outside the web/ contract: web/assets/app/extra.js',
    'symbolic link refused under web/: web/assets/link.html',
  ]);
  assert.equal(existsSync(f.out), false, 'no output');
  assert.equal(existsSync(f.manifest), false, 'no manifest');
});

test('U11: two builds into one target with a page deleted between them leave no trace of the old page', () => {
  const f = fixture();
  assert.deepEqual(rules(buildSite({ root: f.root, out: f.out, manifest: f.manifest })), []);
  assert.ok(existsSync(join(f.out, 'signin/index.html')));
  rmSync(join(f.root, 'web/signin'), { recursive: true });
  rmSync(join(f.root, 'web/assets/app/pages/signin.mjs'));
  assert.deepEqual(rules(buildSite({ root: f.root, out: f.out, manifest: f.manifest, clean: true })), []);
  assert.equal(existsSync(join(f.out, 'signin/index.html')), false, 'the old URL has no file');
  const manifest = JSON.parse(readFileSync(f.manifest, 'utf8'));
  assert.equal(Object.hasOwn(manifest.files, 'signin/index.html'), false, 'the manifest does not name it');
});

test('U11: a non-empty --out without --clean is refused and left as it was', () => {
  const f = fixture();
  mkdirSync(f.out, { recursive: true });
  writeFileSync(join(f.out, 'leftover.html'), 'old');
  const r = buildSite({ root: f.root, out: f.out, manifest: f.manifest });
  assert.deepEqual(rules(r), [`--out is not empty; pass --clean to replace it: ${f.out}`]);
  assert.deepEqual(walk(f.out), ['leftover.html']);
  assert.deepEqual(rules(buildSite({ root: f.root, out: f.out, manifest: f.manifest, clean: true })), []);
  assert.equal(existsSync(join(f.out, 'leftover.html')), false, '--clean removed it');
});

test('U11: a file added behind the build, a published file removed or changed, each fails the manifest comparison', () => {
  const f = fixture();
  assert.deepEqual(rules(buildSite({ root: f.root, out: f.out, manifest: f.manifest })), []);
  assert.deepEqual(rules(verifyOutput(f.out, f.manifest)), [], 'control: the untouched output verifies');
  writeFileSync(join(f.out, 'stale.html'), 'stale');
  rmSync(join(f.out, 'signin/index.html'));
  appendFileSync(join(f.out, 'assets/enterprise.css'), '\n');
  assert.deepEqual(rules(verifyOutput(f.out, f.manifest)).sort(), [
    'file in the output differs from its manifest hash: assets/enterprise.css',
    'file in the output that the manifest does not name: stale.html',
    'manifest entry missing from the output: signin/index.html',
  ]);
});

test('U11: the output may not be the repository, lie inside web/, or hold its own manifest', () => {
  const f = fixture();
  assert.ok(
    rules(buildSite({ root: f.root, out: f.root, manifest: f.manifest, clean: true }))[0].startsWith(
      '--out is the repository',
    ),
  );
  assert.ok(
    rules(buildSite({ root: f.root, out: join(f.root, 'web', 'site'), manifest: f.manifest }))[0].startsWith(
      '--out lies inside web/',
    ),
  );
  assert.ok(
    rules(buildSite({ root: f.root, out: f.out, manifest: join(f.out, 'manifest.json') }))[0].startsWith(
      '--manifest lies inside the published tree',
    ),
  );
  assert.ok(existsSync(join(f.root, 'web', 'index.html')), 'the refused --clean removed nothing');
});

test('U11: the command line exits 0 on a clean build and 2 when --verify finds a stale file', () => {
  const f = fixture();
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [join(REPO, 'scripts/build-site.mjs'), '--root', f.root, '--out', f.out, '--manifest', f.manifest, ...args],
      {
        encoding: 'utf8',
      },
    );
  const built = run('--clean');
  assert.equal(built.status, 0, built.stdout);
  assert.match(built.stdout, /build-site: 11 files published to .*, 0 problem\(s\)/);
  assert.equal(run('--verify').status, 0);
  writeFileSync(join(f.out, 'stale.html'), 'stale');
  const verified = run('--verify');
  assert.equal(verified.status, 2);
  assert.match(verified.stdout, /REFUSE file in the output that the manifest does not name: stale\.html/);
});

test('U11 control: the real web/ builds clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'site-build-real-'));
  made.push(dir);
  const r = buildSite({ out: join(dir, 'site'), manifest: join(dir, 'site-manifest.json') });
  assert.deepEqual(rules(r), []);
  assert.ok(r.files.has('index.html') && r.files.has('assets/app/api.mjs'));
  /* HOSTED-F3: the real tree always publishes the prompt, byte for byte, and the manifest names its hash. */
  const bytes = readFileSync(join(REPO, CAPTURE_SOURCE));
  const read = readCaptureModule(readFileSync(join(dir, 'site', CAPTURE_MODULE), 'utf8'));
  assert.ok(
    read && Buffer.from(read.text, 'utf8').equals(bytes),
    'the published prompt is capture/enterprise.md byte for byte',
  );
  assert.equal(read.sha256, sha256(bytes));
  const manifest = JSON.parse(readFileSync(join(dir, 'site-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.capture, { source: CAPTURE_SOURCE, module: CAPTURE_MODULE, sha256: sha256(bytes) });
  assert.equal(manifest.files[CAPTURE_MODULE], sha256(readFileSync(join(dir, 'site', CAPTURE_MODULE))));
});

/* The capture prompt, step 4a. A fixture with the stub and a prompt file of its own. */
const STUB = { [CAPTURE_MODULE]: 'export const CAPTURE_TEXT = null;\nexport const CAPTURE_SHA256 = null;\n' };
function withPrompt(bytes, web = { ...WEB, ...STUB }) {
  const f = fixture(web);
  if (bytes !== null) {
    mkdirSync(join(f.root, 'capture'), { recursive: true });
    writeFileSync(join(f.root, CAPTURE_SOURCE), bytes);
  }
  return f;
}

test('U11 capture: the stub is replaced by the prompt file as one string with its hash, and the manifest names both', () => {
  /* Quotes, a backslash, a tab, a non-ASCII letter, an emoji, a line separator and no final line break: each is a way a
     hand-made literal would differ from the file. */
  const text = 'Line "one" with a \\ and a\ttab.\nZürich 🙂 \u2028 end';
  const f = withPrompt(Buffer.from(text, 'utf8'));
  const r = buildSite({ root: f.root, out: f.out, manifest: f.manifest });
  assert.deepEqual(rules(r), []);
  const published = readFileSync(join(f.out, CAPTURE_MODULE), 'utf8');
  assert.notEqual(published, STUB[CAPTURE_MODULE], 'the stub is not what is published');
  const read = readCaptureModule(published);
  assert.equal(read.text, text);
  assert.equal(read.sha256, sha256(Buffer.from(text, 'utf8')));
  const manifest = JSON.parse(readFileSync(f.manifest, 'utf8'));
  assert.deepEqual(manifest.capture, {
    source: CAPTURE_SOURCE,
    module: CAPTURE_MODULE,
    sha256: sha256(Buffer.from(text, 'utf8')),
  });
  assert.equal(manifest.files[CAPTURE_MODULE], sha256(Buffer.from(published, 'utf8')));
  assert.deepEqual(verifyOutput(f.out, f.manifest).problems, [], 'the output still equals its manifest');
});

test('U11 capture: a prompt file whose bytes are not UTF-8 is refused (a stray byte, an overlong form, an encoded surrogate)', () => {
  for (const bytes of [
    Buffer.from([0x61, 0xff, 0x62, 0x0a]),
    Buffer.from([0x61, 0xc0, 0xaf, 0x0a]),
    Buffer.from([0x61, 0xed, 0xa0, 0x80, 0x0a]),
  ]) {
    const f = withPrompt(bytes);
    assert.deepEqual(rules(buildSite({ root: f.root, out: f.out, manifest: f.manifest })), [
      `the published capture text is not ${CAPTURE_SOURCE} byte for byte: ${CAPTURE_MODULE}`,
    ]);
  }
});

test('U11 capture: a carriage return in the prompt is refused, because the page shows it in a text area (PC-3)', () => {
  for (const bytes of [Buffer.from('one\r\ntwo\n'), Buffer.from('one\rtwo\n')]) {
    const f = withPrompt(bytes);
    const r = buildSite({ root: f.root, out: f.out, manifest: f.manifest });
    assert.deepEqual(rules(r), [
      `${CAPTURE_SOURCE} holds a carriage return, which the page's text area would change: ${CAPTURE_SOURCE}`,
    ]);
  }
});

test('U11 capture: the prompt file without the stub, or the stub without the file, is refused and nothing is written', () => {
  const noStub = withPrompt(Buffer.from('text\n'), WEB);
  const r1 = buildSite({ root: noStub.root, out: noStub.out, manifest: noStub.manifest });
  assert.deepEqual(rules(r1), [`${CAPTURE_SOURCE} exists and web/${CAPTURE_MODULE} does not: web/${CAPTURE_MODULE}`]);
  assert.equal(existsSync(noStub.out), false, 'no output');
  const noFile = withPrompt(null);
  const r2 = buildSite({ root: noFile.root, out: noFile.out, manifest: noFile.manifest });
  assert.deepEqual(rules(r2), [`web/${CAPTURE_MODULE} exists and ${CAPTURE_SOURCE} does not: ${CAPTURE_SOURCE}`]);
  assert.equal(existsSync(noFile.out), false, 'no output');
});

test('U11 capture: the published prompt passes the forbidden-string scan like any module', () => {
  const f = withPrompt(Buffer.from('Paste the file at app.phaeacia.ai when done.\n'));
  assert.deepEqual(rules(buildSite({ root: f.root, out: f.out, manifest: f.manifest })), [
    `build scan: forbidden string "app.phaeacia.ai": ${CAPTURE_MODULE}`,
  ]);
});

test('U11 capture: readCaptureModule reads only the exact shape the build writes', () => {
  const f = withPrompt(Buffer.from('x\n'));
  assert.deepEqual(rules(buildSite({ root: f.root, out: f.out, manifest: f.manifest })), []);
  const good = readFileSync(join(f.out, CAPTURE_MODULE), 'utf8');
  assert.deepEqual(readCaptureModule(good), { text: 'x\n', sha256: sha256(Buffer.from('x\n')) });
  for (const bad of [
    good.replace('"x\\n"', '"x\\n" + "y"'),
    good.replace('/* Written', '/*  Written'),
    good.replace(/'[0-9a-f]{64}'/, "'abc'"),
    `${good}\n`,
    STUB[CAPTURE_MODULE],
  ])
    assert.equal(readCaptureModule(bad), null, bad.slice(0, 120));
});
