/* E1b private rendering: the derived renderer, the three-state losses table,
   the removed public shell, escaping, the declared-only label, the build scan
   (adapter section 8 rows 5 and 5b) and the derived register entry.

   Every fail/pass pair is retained here: the faulty case is a scratch copy of
   the renderer with one defect injected (a public route string, a "nothing was
   lost" row, an escaper that returns its input), or a scratch workspace with a
   one-byte change to the registered derived file; the repository is the passing
   control. Fixtures are synthetic; nothing here touches a native product. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { assemble } from '../../lib/passport/assemble.mjs';
import {
  DECLARED_NOT_INSTALLED,
  LOSSES_DECLARED_LABEL,
  LOSSES_PENDING,
  OWNERS_WORDS_LABEL,
  SOURCE_SHA256,
  esc,
  inline,
  lossesState,
  renderCatalogPage,
  renderLosses,
  renderPassportPage,
  renderReleasePage,
} from '../../lib/passport/render.mjs';
import {
  FORBIDDEN_STRINGS,
  NO_LOSS_PATTERNS,
  buildPages,
  rowFromMarkdown,
  scanPage,
} from '../../scripts/check-render.mjs';
import { IMPORTER, REPO, VENDOR, freshDir, sha256, snapshot } from './helpers.mjs';

const FIXTURES = join(REPO, 'tests/passport/fixtures');
const RENDERER = join(REPO, 'lib/passport/render.mjs');
const VALIDATED_AT = '2026-09-10T08:00:00.000Z';

const fixtureText = (name) => readFileSync(join(FIXTURES, name), 'utf8');
const rowOf = (name) => rowFromMarkdown(fixtureText(name), VALIDATED_AT);
const installationReported = () => JSON.parse(fixtureText('installation-reported.json'));

/* A scratch copy of the renderer with `edit` applied to its source, importable
   as its own module. The copy sits two directories deep so its relative import
   of vendor/passport/web/lib/_sections.mjs resolves to the real vendored file. */
function mutantRenderer(name, edit) {
  const dir = freshDir(`render-${name}`);
  const src = readFileSync(RENDERER, 'utf8');
  const out = edit(src);
  assert.notEqual(out, src, `mutant ${name} must differ from the renderer`);
  mkdirSync(join(dir, 'lib/passport'), { recursive: true });
  mkdirSync(join(dir, 'vendor'), { recursive: true });
  cpSync(join(VENDOR, 'web/lib'), join(dir, 'vendor/passport/web/lib'), { recursive: true });
  const path = join(dir, 'lib/passport/render.mjs');
  writeFileSync(path, out);
  return path;
}

function runCheckRender(args) {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts/check-render.mjs'), ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const NO_LOSS_RE = /nothing was lost|no loss/i;

/* ---------- fixtures ---------- */

test('the empty-losses fixture is byte-identical to the E0 SYNTHETIC passport', () => {
  const e0 = readFileSync(join(REPO, 'tests/native-transfer/passport/fixtures/SYNTHETIC-passport.md'));
  assert.ok(e0.equals(readFileSync(join(FIXTURES, 'synthetic-empty.md'))));
});

test('the three passport fixtures pass the pinned JavaScript gate and derive the expected rows', () => {
  const empty = rowOf('synthetic-empty.md');
  const declared = rowOf('synthetic-declared-losses.md');
  const money = rowOf('synthetic-money-declared.md');
  for (const row of [empty, declared, money]) {
    assert.match(row.title, /SYNTHETIC/);
    assert.equal(row.validated_at, VALIDATED_AT);
    assert.ok(row.body.includes('## 6. Losses'));
  }
  assert.equal(empty.needs.length, 1);
  assert.equal(money.needs.length, 2);
  /* installable: false comes from the vendored derive(), never from the renderer. */
  assert.equal(money.needs[1].installable, false);
  assert.equal(money.needs[1].capability, 'Pay the sorting fee (money.transfer)');
  assert.equal(money.needs[1].required_label, 'declared only');
});

test('a fixture the pinned gate refuses is refused by rowFromMarkdown, not rendered', () => {
  assert.throws(
    () => rowFromMarkdown(fixtureText('synthetic-empty.md').replace('## 6. Losses', '## 6. Loss'), VALIDATED_AT),
    /E_/,
  );
});

/* ---------- provenance and the removed shell ---------- */

test('the renderer names the pinned source hash and imports only the vendored sections module', () => {
  const src = readFileSync(RENDERER, 'utf8');
  const lock = JSON.parse(readFileSync(join(REPO, 'upstream.lock.json'), 'utf8'));
  assert.equal(SOURCE_SHA256, lock.imported['web/lib/_render.mjs']);
  assert.equal(SOURCE_SHA256, sha256(readFileSync(join(VENDOR, 'web/lib/_render.mjs'))));
  assert.ok(src.includes(SOURCE_SHA256), 'the provenance header names the source hash');
  /* Static imports, single- or multi-line (the formatter wraps a long import
     list); this test, not the import-boundary gate, is what asserts the
     single import (adapter section 5). */
  const imports = [...src.matchAll(/^import\s[^;]*?\sfrom\s'([^']+)';$/gms)].map((m) => m[1]);
  assert.deepEqual(imports, ['../../vendor/passport/web/lib/_sections.mjs']);
  assert.equal((src.match(/^import\s/gm) || []).length, 1);
  assert.ok(!/node:|fetch\(|child_process/.test(src));
  /* Code forms, not names: the provenance header may name what was removed. */
  for (const removed of [
    'const TOPBAR',
    'function footer(',
    'function voteControl(',
    'function ogInputs(',
    'listingOf(',
    '{ CANONICAL }',
    'const jsonScript',
    'window.__',
    'site.js"',
    'passport.js"',
    'property="og:',
    'name="twitter:',
  ]) {
    assert.ok(!src.includes(removed), `${removed} must be removed, not switched off`);
  }
});

function allPages() {
  const empty = rowOf('synthetic-empty.md');
  const money = rowOf('synthetic-money-declared.md');
  const declared = rowOf('synthetic-declared-losses.md');
  const assembled = assemble(fixtureText('synthetic-empty.md'), { root: VENDOR, branch: 'generic' });
  const release = { id: 'r-1', branch: 'generic', assembled_content: assembled, published_at: '2026-09-10T09:00:00Z' };
  const company = JSON.parse(readFileSync(join(REPO, 'tests/fixtures/companies/alpha.json'), 'utf8'));
  return {
    passport: renderPassportPage({ row: empty, assetBase: 'assets' }),
    money: renderPassportPage({ row: money, assetBase: 'assets' }),
    declared: renderPassportPage({ row: declared, assetBase: 'assets' }),
    reported: renderPassportPage({ row: empty, installation: installationReported(), assetBase: 'assets' }),
    release: renderReleasePage({ row: empty, release, assetBase: 'assets' }),
    catalog: renderCatalogPage({
      company,
      entries: [
        { id: 'p-1', row: empty, release: null, installation: null },
        { id: 'p-2', row: money, release: null, installation: null },
      ],
      assetBase: 'assets',
    }),
  };
}

test('every page carries the robots meta, no script, no form and none of the public shell strings', () => {
  for (const [name, html] of Object.entries(allPages())) {
    assert.ok(html.includes('<meta name="robots" content="noindex, nofollow">'), name);
    assert.ok(!/<script/i.test(html), `${name}: no script element`);
    assert.ok(!/<form|<button|<input/i.test(html), `${name}: no install or vote control`);
    for (const s of FORBIDDEN_STRINGS) assert.ok(!html.includes(s), `${name}: ${s}`);
    assert.deepEqual(scanPage(html, { installation: name === 'reported' }), [], name);
    assert.ok(html.includes('SYNTHETIC'), name);
  }
});

/* ---------- losses: pending is not none (row 5b) ---------- */

test('row 5b: the empty fixture renders the pending row inside a table and never a no-loss outcome', () => {
  const row = rowOf('synthetic-empty.md');
  const html = renderPassportPage({ row, assetBase: 'assets' });
  assert.equal(lossesState(row.body, null), 'pending');
  const decl = html.slice(html.indexOf('id="pg-decl"'), html.indexOf('</aside>'));
  assert.ok(decl.includes('<table'), 'the losses table renders');
  assert.ok(decl.includes(esc(LOSSES_PENDING)));
  assert.ok(!NO_LOSS_RE.test(html));
  assert.ok(!html.includes('Nothing declared yet'), 'the upstream empty-state signature is replaced');
  /* The owner's own section 6 prose still renders, unchanged, as the owner's words. */
  assert.ok(html.includes('SYNTHETIC preparation only. To be filled during an actual install and always shown.'));
  assert.deepEqual(scanPage(html, { installation: false }), []);
});

test('row 5b: a renderer that prints "nothing was lost" for the empty fixture fails the scan; the pending row passes', async () => {
  const mutant = mutantRenderer('no-loss', (s) =>
    s.replace(`'${LOSSES_PENDING}'`, "'Nothing was lost during this install'"),
  );
  const m = await import(pathToFileURL(mutant));
  const row = rowOf('synthetic-empty.md');
  const bad = m.renderPassportPage({ row, assetBase: 'assets' });
  assert.match(bad, /nothing was lost/i);
  const problems = scanPage(bad, { installation: false });
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(problems[0], /no-loss outcome without an installation record/);
  assert.deepEqual(scanPage(renderPassportPage({ row, assetBase: 'assets' }), { installation: false }), []);
  /* Through the CLI, against every fixture page. */
  const out = freshDir('build-no-loss');
  const r = runCheckRender(['--out', out, '--renderer', mutant]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /no-loss outcome without an installation record/);
});

test('declared rows render unchanged with the "declared by the owner" label', () => {
  const row = rowOf('synthetic-declared-losses.md');
  assert.equal(lossesState(row.body, null), 'declared');
  const html = renderPassportPage({ row, assetBase: 'assets' });
  const decl = html.slice(html.indexOf('id="pg-decl"'), html.indexOf('</aside>'));
  assert.ok(decl.includes(esc(LOSSES_DECLARED_LABEL)));
  assert.ok(decl.includes('<td>Label colour hints</td>'));
  assert.ok(decl.includes('<td class="dim">substituted</td>'));
  assert.ok(decl.includes('The original sorted any number of records; the copy stops at twenty'));
  assert.ok(decl.includes('2 entries'));
  assert.ok(!decl.includes(esc(LOSSES_PENDING)));
  assert.ok(!NO_LOSS_RE.test(html));
});

test('a reported installation record renders the recipient text with actor and time, never the passport template', () => {
  const row = rowOf('synthetic-empty.md');
  const rec = installationReported();
  assert.equal(lossesState(row.body, rec), 'reported');
  const html = renderPassportPage({ row, installation: rec, assetBase: 'assets' });
  const decl = html.slice(html.indexOf('id="pg-decl"'), html.indexOf('</aside>'));
  assert.ok(decl.includes(esc(rec.actor)));
  assert.ok(decl.includes(esc(rec.at)));
  assert.ok(decl.includes('<td>Label colour hints</td>'));
  assert.ok(decl.includes('Shown in this conversation only, as the recipient chose at install'));
  assert.ok(decl.includes('Reported by the recipient'));
  assert.ok(!decl.includes(esc(LOSSES_PENDING)));
  assert.ok(!NO_LOSS_RE.test(html), 'a record with loss rows says nothing about no loss');
  /* The explicit no-loss line renders only when the record says so, and only a
     page rendered with a record may carry it. */
  const clean = { ...rec, losses: [], no_loss_reported: true };
  const cleanHtml = renderPassportPage({ row, installation: clean, assetBase: 'assets' });
  assert.match(cleanHtml, /No loss reported by/);
  assert.deepEqual(scanPage(cleanHtml, { installation: true }), []);
  assert.equal(scanPage(cleanHtml, { installation: false }).length, 1);
  /* A record without loss rows that does not say no loss is a report of nothing: the pending row stays. */
  const silent = { ...rec, losses: [], no_loss_reported: false };
  assert.ok(renderPassportPage({ row, installation: silent, assetBase: 'assets' }).includes(esc(LOSSES_PENDING)));
  /* A record whose status is not reported or witnessed is not a report. */
  for (const status of ['pending', 'started', '', undefined]) {
    assert.equal(lossesState(row.body, { ...rec, status }), 'pending', String(status));
  }
  assert.equal(lossesState(row.body, { ...rec, status: 'witnessed' }), 'reported');
  assert.match(renderLosses({ body: row.body, installation: { ...rec, status: 'witnessed' } }), /Witnessed by/);
});

/* ---------- writes render as declared, never installable ---------- */

test('a money.* declared capability renders "declared" and never an install control', () => {
  const row = rowOf('synthetic-money-declared.md');
  const html = renderPassportPage({ row, assetBase: 'assets' });
  assert.ok(html.includes('<span class="s1">Not granted</span>'));
  assert.ok(html.includes('<span class="s1">Granted</span>'));
  assert.ok(html.includes('declared only'));
  assert.ok(html.includes('money.transfer'));
  assert.ok(!/<form|<button|<input/i.test(html));
  const company = JSON.parse(readFileSync(join(REPO, 'tests/fixtures/companies/alpha.json'), 'utf8'));
  const catalog = renderCatalogPage({
    company,
    entries: [
      { id: 'p-1', row: rowOf('synthetic-empty.md'), release: null, installation: null },
      { id: 'p-2', row, release: null, installation: null },
    ],
    assetBase: 'assets',
  });
  const cards = catalog.split('<li class="entry"').slice(1);
  assert.equal(cards.length, 2);
  assert.ok(!cards[0].includes(DECLARED_NOT_INSTALLED), 'the empty fixture has no declared-only row');
  assert.ok(cards[1].includes(DECLARED_NOT_INSTALLED));
  assert.ok(cards[1].includes(esc('Pay the sorting fee (money.transfer)')));
  assert.ok(catalog.includes(esc(company.name)));
});

/* ---------- section 5: placeholder note, frozen release ---------- */

test('a stored passport renders section 5 as the placeholder note; a release renders the frozen body passed in', () => {
  const row = rowOf('synthetic-empty.md');
  const page = renderPassportPage({ row, assetBase: 'assets' });
  assert.ok(page.includes('No release yet'));
  assert.ok(page.includes(esc('<!-- installer core and branches inserted on upload -->')));
  const core = readFileSync(join(VENDOR, 'installer/core.md'), 'utf8').split('\n')[0];
  assert.ok(!page.includes(esc(core)), 'the passport page carries no installer text');

  const assembled = assemble(fixtureText('synthetic-empty.md'), { root: VENDOR, branch: 'generic' });
  const release = { id: 'r-1', branch: 'generic', assembled_content: assembled, published_at: '2026-09-10T09:00:00Z' };
  const html = renderReleasePage({ row, release, assetBase: 'assets' });
  assert.ok(html.includes(esc(core)), 'the frozen body renders');
  assert.ok(html.includes(esc(assembled)), 'the whole frozen body, escaped, is on the page');
  assert.ok(html.includes('Other assistant'));
  assert.ok(html.includes('CC BY 4.0'));
  assert.ok(html.includes('r-1'));
  assert.ok(!html.includes('<!-- installer core'), 'the placeholder is gone from the release');
  assert.throws(
    () => renderReleasePage({ row, release: { ...release, assembled_content: undefined } }),
    /assembled_content/,
  );
  assert.throws(() => renderReleasePage({ row, release: { ...release, branch: 'other' } }), /branch/);
});

/* ---------- escaping ---------- */

const hostile = () => {
  const row = rowOf('synthetic-empty.md');
  return {
    ...row,
    title: 'SYNTHETIC <script>alert(1)</script> title',
    summary: 'See [here](javascript:alert(1)) and <img src=x onerror=alert(1)> then "quotes" & \'apostrophes\'.',
    name: 'synthetic"><b>x</b>',
    needs: [{ ...row.needs[0], capability: '<script>x</script>', why: 'javascript:void(0)', if_skipped: '<b>' }],
  };
};

test('escaping: <script> and javascript: in fields render escaped, never raw', () => {
  const html = renderPassportPage({ row: hostile(), assetBase: 'assets' });
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<img/i.test(html));
  assert.ok(!/href="javascript:/i.test(html));
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&quot;quotes&quot; &amp; &#39;apostrophes&#39;'));
  /* The link syntax is left as text: inline() turns only http(s) and mailto links into label plus visible URL. */
  assert.ok(html.includes('[here](javascript:alert(1))'));
  const catalog = renderCatalogPage({
    company: { id: 'x', name: 'SYNTHETIC <script>co</script>', memberships: [], groups: [] },
    entries: [{ id: 'p-"1', row: hostile(), release: null, installation: null }],
    assetBase: 'assets',
  });
  assert.ok(!/<script/i.test(catalog));
  assert.ok(catalog.includes('&lt;script&gt;co&lt;/script&gt;'));
});

test('escaping: a renderer whose esc() returns its input renders the script raw (faulty case)', async () => {
  const mutant = mutantRenderer('no-esc', (s) =>
    s.replace(/^export const esc = .*$/m, 'export const esc = (s) => String(s == null ? "" : s);'),
  );
  const m = await import(pathToFileURL(mutant));
  const bad = m.renderPassportPage({ row: hostile(), assetBase: 'assets' });
  assert.match(bad, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(renderPassportPage({ row: hostile(), assetBase: 'assets' }), /<script>alert\(1\)/);
});

/* ---------- row 5: the build scan ---------- */

test('row 5: each forbidden string is refused by the scan; a clean page passes', () => {
  const clean = renderPassportPage({ row: rowOf('synthetic-empty.md'), assetBase: 'assets' });
  assert.deepEqual(scanPage(clean, { installation: false }), []);
  for (const s of FORBIDDEN_STRINGS) {
    const problems = scanPage(clean.replace('</main>', `<p>${s}</p></main>`), { installation: false });
    assert.equal(problems.length, 1, s);
    assert.ok(problems[0].includes(s), problems[0]);
  }
  for (const p of NO_LOSS_PATTERNS) {
    const html = clean.replace('</main>', `<p>${p}</p></main>`);
    assert.equal(scanPage(html, { installation: false }).length, 1, p);
    assert.equal(scanPage(html, { installation: true }).length, 0, p);
  }
  assert.equal(scanPage(clean.replace('</main>', '<p>NOTHING WAS LOST</p></main>'), { installation: false }).length, 1);
});

test('row 5: app.phaeacia.ai injected into a scratch copy of the renderer fails the build scan; restored passes', () => {
  const mutant = mutantRenderer('route', (s) =>
    s.replace(
      '<meta name="robots" content="noindex, nofollow">\n<title>',
      '<meta name="robots" content="noindex, nofollow">\n<link rel="canonical" href="https://app.phaeacia.ai/p/x">\n<title>',
    ),
  );
  const out = freshDir('build-route');
  const bad = runCheckRender(['--out', out, '--renderer', mutant]);
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.out, /forbidden string "app\.phaeacia\.ai"/);
  const good = runCheckRender(['--out', freshDir('build-clean')]);
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /check-render: \d+ pages, 0 problem\(s\)/);
});

test('the build renders every fixture page and marks which pages carry an installation record', async () => {
  const out = freshDir('build-pages');
  const pages = await buildPages({ out });
  const files = pages.map((p) => p.file).sort();
  assert.deepEqual(files, [
    'catalog-alpha.html',
    'catalog-beta.html',
    'passport-p-alpha-1.html',
    'passport-p-alpha-2.html',
    'passport-p-beta-1.html',
    'passport-p-beta-2.html',
    'release-r-beta-2-generic.html',
  ]);
  const withRecord = pages
    .filter((p) => p.installation)
    .map((p) => p.file)
    .sort();
  assert.deepEqual(withRecord, ['passport-p-beta-2.html', 'release-r-beta-2-generic.html']);
  for (const p of pages) {
    const html = readFileSync(join(out, p.file), 'utf8');
    assert.deepEqual(scanPage(html, { installation: p.installation }), [], p.file);
    assert.ok(html.includes('SYNTHETIC'), p.file);
  }
  /* The release page's frozen body is the golden generic assembly of the SYNTHETIC fixture. */
  const release = readFileSync(join(out, 'release-r-beta-2-generic.html'), 'utf8');
  const golden = assemble(fixtureText('synthetic-empty.md'), { root: VENDOR, branch: 'generic' });
  assert.ok(release.includes(esc(golden)));
  assert.equal(sha256(Buffer.from(golden, 'utf8')), 'd558746392a835f3da4c4a779616761a8e0dba9157962d7da22d772e5d28546d');
});

/* ---------- the derived register (R3 on the real renderer) ---------- */

test('the derived register carries render.mjs; verify fails on a one-byte change and passes restored', () => {
  const lock = JSON.parse(readFileSync(join(REPO, 'upstream.lock.json'), 'utf8'));
  const entry = lock.derived.find((d) => d.path === 'lib/passport/render.mjs');
  assert.ok(entry, 'render.mjs is registered');
  assert.equal(entry.from, 'web/lib/_render.mjs');
  assert.equal(entry.from_sha256, lock.imported['web/lib/_render.mjs']);
  assert.equal(entry.derived_sha256, sha256(readFileSync(RENDERER)));
  assert.ok(entry.reviewed_by.length && /^\d{4}-\d{2}-\d{2}$/.test(entry.on));

  const ws = freshDir('derived-ws');
  cpSync(join(REPO, 'upstream.lock.json'), join(ws, 'upstream.lock.json'));
  cpSync(VENDOR, join(ws, 'vendor/passport'), { recursive: true });
  mkdirSync(join(ws, 'lib/passport'), { recursive: true });
  cpSync(RENDERER, join(ws, 'lib/passport/render.mjs'));
  const verify = () => {
    const r = spawnSync(process.execPath, [IMPORTER, '--verify', '--workspace', ws], { encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const ok = verify();
  assert.equal(ok.code, 0, ok.out);
  const before = snapshot(ws);
  writeFileSync(join(ws, 'lib/passport/render.mjs'), `${readFileSync(RENDERER, 'utf8')}\n`);
  const bad = verify();
  assert.equal(bad.code, 2);
  assert.match(bad.out, /derived file changed: lib\/passport\/render\.mjs/);
  cpSync(RENDERER, join(ws, 'lib/passport/render.mjs'));
  assert.equal(snapshot(ws), before);
  assert.equal(verify().code, 0);
  rmSync(join(ws, 'lib/passport/render.mjs'));
  assert.match(verify().out, /missing derived file: lib\/passport\/render\.mjs/);
});

/* ---------- corrections after the fresh Codex critique (evidence/e1-render-critique.md) ---------- */

/* H1: one fence-aware reading of the section 6 table decides state, count and
   the rendered rows. A quoted example inside a fence is not a declaration; an
   escaped pipe is cell content; a code span stays literal. */

const FENCED_EXAMPLE = [
  '',
  '```text',
  '| What | Status | What that means in practice |',
  '|---|---|---|',
  '| Quoted example, not a declaration | lost | Example only |',
  '```',
  '',
].join('\n');

const declarationOf = (html) => html.slice(html.indexOf('id="pg-decl"'), html.indexOf('</aside>'));

test('H1: a fenced example table after the empty section 6 stays pending and renders no quoted row', () => {
  const text = fixtureText('synthetic-empty.md').replace(/\n(?=$)/, `\n${FENCED_EXAMPLE}`);
  assert.ok(text.includes('Quoted example, not a declaration'));
  const row = rowFromMarkdown(text, VALIDATED_AT);
  assert.equal(lossesState(row.body, null), 'pending');
  const html = renderPassportPage({ row, assetBase: 'assets' });
  const decl = declarationOf(html);
  assert.ok(decl.includes(esc(LOSSES_PENDING)), 'the pending row renders');
  assert.ok(!decl.includes('Quoted example, not a declaration'), 'the quoted example is not a declared row');
  assert.ok(!decl.includes('3 entries'));
  assert.equal(html.match(/data-losses="pending"/g)?.length, 1);
  /* The catalog count uses the same reading. */
  const catalog = renderCatalogPage({
    company: { id: 'x', name: 'SYNTHETIC co', memberships: [], groups: [] },
    entries: [{ id: 'p-1', row, release: null, installation: null }],
    assetBase: 'assets',
  });
  assert.ok(catalog.includes(esc(LOSSES_PENDING)));
  assert.ok(!/loss rows? declared by the owner/.test(catalog));
  assert.ok(catalog.includes('0 losses declared') || !catalog.includes('losses declared'));
  assert.deepEqual(scanPage(html, { installation: false }), []);
});

test('H1: a declared table followed by a fenced example counts and renders only the real rows', () => {
  const text = fixtureText('synthetic-declared-losses.md').replace(/\n(?=$)/, `\n${FENCED_EXAMPLE}`);
  const row = rowFromMarkdown(text, VALIDATED_AT);
  assert.equal(lossesState(row.body, null), 'declared');
  const decl = declarationOf(renderPassportPage({ row, assetBase: 'assets' }));
  assert.ok(decl.includes('2 entries'));
  assert.ok(!decl.includes('Quoted example'));
  assert.equal((decl.match(/<tr>/g) || []).length, 3, 'header plus the two declared rows');
});

test('H1: an escaped pipe is cell content; the three cells keep their columns', () => {
  const text = fixtureText('synthetic-declared-losses.md').replace('Label colour hints', 'Left \\| right');
  const row = rowFromMarkdown(text, VALIDATED_AT);
  const decl = declarationOf(renderPassportPage({ row, assetBase: 'assets' }));
  const first = decl.slice(decl.indexOf('<tbody>'), decl.indexOf('</tr>', decl.indexOf('<tbody>')));
  assert.equal((first.match(/<td/g) || []).length, 3, first);
  assert.ok(first.includes('<td>Left | right</td>'), first);
  assert.ok(first.includes('<td class="dim">lost</td>'), first);
  assert.ok(
    first.includes('<td class="dim">The original showed each label in a colour; the copy prints plain text</td>'),
    first,
  );
  assert.ok(decl.includes('2 entries'));
});

test('H1: a code span keeps its literal asterisks', () => {
  const text = fixtureText('synthetic-declared-losses.md').replace('Label colour hints', '`**literal**`');
  const row = rowFromMarkdown(text, VALIDATED_AT);
  const decl = declarationOf(renderPassportPage({ row, assetBase: 'assets' }));
  assert.ok(
    decl.includes('<td><code>**literal**</code></td>'),
    decl.slice(decl.indexOf('<tbody>'), decl.indexOf('<tbody>') + 400),
  );
  assert.ok(!decl.includes('<code><strong>'));
  /* Bold outside a code span still formats. */
  assert.ok(inline('a **b** `**c**`').includes('<strong>b</strong>'));
  assert.ok(inline('a **b** `**c**`').includes('<code>**c**</code>'));
});

/* L1 (critique 2026-09-10): the mandatory byte comparison of the build. The
   SHA-256 of each of the seven rendered pages is committed in
   fixtures/build-page-hashes.json; a fresh build must match it exactly. Any
   change to the rendered output, intended or not, therefore changes that
   fixture in the same commit, which makes the change visible in review.
   To regenerate after an intended change: build with
   `node scripts/check-render.mjs --out <dir>` and hash the seven .html files.
   The fixture is required: a missing fixture fails this test, it does not
   skip it. */
const PAGE_HASHES = join(FIXTURES, 'build-page-hashes.json');
const pageHashes = (dir) =>
  Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.html'))
      .sort()
      .map((f) => [f, sha256(readFileSync(join(dir, f)))]),
  );

test('L1: a fresh build matches the committed page hashes; the fixture is required, and a one-byte change fails', () => {
  assert.ok(existsSync(PAGE_HASHES), `required baseline fixture missing: ${PAGE_HASHES}`);
  const expected = JSON.parse(readFileSync(PAGE_HASHES, 'utf8')).pages;
  assert.equal(Object.keys(expected).length, 7, 'the fixture names the seven built pages');
  for (const h of Object.values(expected)) assert.match(h, /^[0-9a-f]{64}$/);
  /* Control: a fresh build of the committed renderer matches. */
  const out = freshDir('build-hashes');
  const r = runCheckRender(['--out', out]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(pageHashes(out), expected);
  /* Faulty case 1: one byte flipped in one rendered page is reported for that page only. */
  const flipped = Buffer.from(readFileSync(join(out, 'catalog-alpha.html')));
  flipped[flipped.length - 2] ^= 0x01;
  writeFileSync(join(out, 'catalog-alpha.html'), flipped);
  const after = pageHashes(out);
  assert.notEqual(after['catalog-alpha.html'], expected['catalog-alpha.html']);
  assert.deepEqual(
    Object.keys(after).filter((f) => after[f] !== expected[f]),
    ['catalog-alpha.html'],
  );
  /* Faulty case 2: a one-byte change to the renderer changes every page. */
  const mutant = mutantRenderer('one-byte', (s) =>
    s.replace('<meta name="robots" content="noindex, nofollow">', '<meta name="robots" content="noindex,  nofollow">'),
  );
  const mutantOut = freshDir('build-hashes-mutant');
  assert.equal(runCheckRender(['--out', mutantOut, '--renderer', mutant]).code, 0);
  const mutantHashes = pageHashes(mutantOut);
  assert.deepEqual(Object.keys(mutantHashes), Object.keys(expected));
  for (const f of Object.keys(expected)) assert.notEqual(mutantHashes[f], expected[f], f);
});

test('H1 control (optional): the pending and declared fixtures render as the f145f5e build output, except the intended label change', (t) => {
  /* The intended differences (adapter section 5, double-label decision): the
     label over the owner's prose reads OWNERS_WORDS_LABEL on both pages, and
     the state line of the pending page reads "Pending an install". Nothing
     else changes. The base output is the build at f145f5e, kept under
     .scratch/e1b-corr/ by the correction worker and not committed, so this
     historical comparison is optional: when the base is absent the test is
     reported as skipped (L1), never as passed. The mandatory byte comparison
     of the current output is the committed-hash test above. */
  const base = join(REPO, '.scratch/e1b-corr/base-build');
  if (!existsSync(base)) {
    t.skip('H1 control: untracked f145f5e base build not present; optional historical comparison');
    return;
  }
  const out = freshDir('build-h1-control');
  const r = runCheckRender(['--out', out]);
  assert.equal(r.code, 0, r.out);
  const label = /<span class="lbl">[^<]*<\/span>/g;
  const signature = /<p class="signature">[\s\S]*?<\/p>/;
  const pair = (f) => [readFileSync(join(base, f), 'utf8'), readFileSync(join(out, f), 'utf8')];
  const [declaredBefore, declaredAfter] = pair('passport-p-beta-1.html');
  assert.notEqual(declaredBefore, declaredAfter);
  assert.equal(
    declaredBefore.replace(label, ''),
    declaredAfter.replace(label, ''),
    'declared: only the prose label differs',
  );
  assert.ok(declaredAfter.includes(`<span class="lbl">${esc(OWNERS_WORDS_LABEL)}</span>`));
  const [pendingBefore, pendingAfter] = pair('passport-p-alpha-1.html');
  assert.equal(
    pendingBefore.replace(label, '').replace(signature, ''),
    pendingAfter.replace(label, '').replace(signature, ''),
    'pending: only the prose label and the state line differ',
  );
  assert.ok(pendingAfter.includes('<span>Pending an install</span>'));
  assert.ok(pendingBefore.includes(`<span>${esc(LOSSES_DECLARED_LABEL)}</span>`));
  /* The two catalog pages are byte-identical; the other passport and release
     pages differ only in the same prose label (and, for the pending money
     page, the same state line). */
  for (const f of ['catalog-alpha.html', 'catalog-beta.html']) {
    const [b, a] = pair(f);
    assert.equal(b, a, f);
  }
  for (const f of ['passport-p-alpha-2.html', 'passport-p-beta-2.html', 'release-r-beta-2-generic.html']) {
    const [b, a] = pair(f);
    assert.equal(b.replace(label, '').replace(signature, ''), a.replace(label, '').replace(signature, ''), f);
  }
});

/* The lead-noted double label: one state line per case; the owner's prose,
   when present with an empty table, carries the declared label itself. */
test('labels: one state line per case; the declared label attaches to the owner prose, not to every page', () => {
  const empty = rowOf('synthetic-empty.md');
  const pending = declarationOf(renderPassportPage({ row: empty, assetBase: 'assets' }));
  const signature = (d) =>
    d.slice(d.indexOf('<p class="signature">'), d.indexOf('</p>', d.indexOf('<p class="signature">')));
  assert.ok(signature(pending).includes('Pending an install'), signature(pending));
  assert.ok(signature(pending).includes(esc(LOSSES_PENDING)));
  assert.ok(!signature(pending).includes(esc(LOSSES_DECLARED_LABEL)));
  assert.ok(pending.includes('<span class="lbl">'), 'the owner prose renders');
  assert.match(pending, /<span class="lbl">In the owner’s words[^<]*declared by the owner, not inferred<\/span>/);
  /* No prose, no table rows: no declared label anywhere. */
  const noProse = rowFromMarkdown(
    fixtureText('synthetic-empty.md').replace(
      'SYNTHETIC preparation only. To be filled during an actual install and always shown.\n',
      '',
    ),
    VALIDATED_AT,
  );
  const bare = declarationOf(renderPassportPage({ row: noProse, assetBase: 'assets' }));
  assert.ok(!bare.toLowerCase().includes('declared by the owner'), bare);
  assert.ok(bare.includes(esc(LOSSES_PENDING)));
  /* Declared and reported keep their own single state line. */
  const declared = declarationOf(
    renderPassportPage({ row: rowOf('synthetic-declared-losses.md'), assetBase: 'assets' }),
  );
  assert.ok(signature(declared).includes(esc(LOSSES_DECLARED_LABEL)));
  assert.ok(!signature(declared).includes('Pending an install'));
  const reported = declarationOf(
    renderPassportPage({ row: empty, installation: installationReported(), assetBase: 'assets' }),
  );
  assert.ok(signature(reported).includes('Recorded at install, not inferred'));
});

/* M1: the build scan reads decoded text and decoded URL/metadata attributes,
   not only the raw HTML. */

const SCAN_CASES = [
  ['<a href="https://APP.PHAEACIA.AI/GALLERY">x</a>', 'app.phaeacia.ai'],
  ['<a href="https://app&#46;phaeacia&#46;ai/gal&#108;ery">x</a>', 'app.phaeacia.ai'],
  ['<a href="https://%61pp.phaeacia%2Eai/%67allery">x</a>', 'app.phaeacia.ai'],
  ['<p>app.<b>phaeacia</b>.ai</p>', 'app.phaeacia.ai'],
  ['<link rel="stylesheet" href="https://APP.PHAEACIA.AI/assets/base.css">', 'app.phaeacia.ai'],
  ['<meta name="x" content="https://App.Phaeacia.ai/manage">', 'app.phaeacia.ai'],
];
const NO_LOSS_CASES = [
  '<p>No&#32;loss</p>',
  '<p>No <b>loss</b></p>',
  '<p>Nothing\n  was\tlost</p>',
  '<td>No</td><td>loss</td>',
];

test('M1: encoded, upcased, percent-encoded and tag-split public hosts are refused by the scan', () => {
  const clean = renderPassportPage({ row: rowOf('synthetic-empty.md'), assetBase: 'assets' });
  for (const [snippet, expect] of SCAN_CASES) {
    const problems = scanPage(clean.replace('</main>', `${snippet}</main>`), { installation: false });
    assert.ok(
      problems.some((p) => p.includes(`forbidden string "${expect}"`)),
      `${snippet}: ${JSON.stringify(problems)}`,
    );
  }
  for (const snippet of NO_LOSS_CASES) {
    const html = clean.replace('</main>', `${snippet}</main>`);
    const problems = scanPage(html, { installation: false });
    assert.equal(problems.length, 1, `${snippet}: ${JSON.stringify(problems)}`);
    assert.match(problems[0], /no-loss outcome without an installation record/);
    assert.deepEqual(scanPage(html, { installation: true }), [], snippet);
  }
  assert.deepEqual(scanPage(clean, { installation: false }), []);
});

/* M1b (critique 2026-09-10): the URL parser strips format characters and
   applies NFKC and case folding to a host before use, so a stylesheet link
   whose host carries a zero-width space, or full-width letters, loads from
   app.phaeacia.ai while the scan saw a different string. The attribute scan
   now matches the normalized value and the parsed hostname as well. */

const ZWSP_HOST_URL = 'https://app.phae​acia.ai/assets/base.css';
const FULLWIDTH_HOST_URL = 'https://ａｐｐ.phaeacia.ai/assets/base.css';
const NORMALIZED_HOST_CASES = [
  [`<link rel="stylesheet" href="${ZWSP_HOST_URL}">`, 'app.phaeacia.ai'],
  [`<link rel="stylesheet" href="${FULLWIDTH_HOST_URL}">`, 'app.phaeacia.ai'],
  ['<link rel="stylesheet" href="https://app.phae⁠acia.ai/assets/base.css">', 'app.phaeacia.ai'],
  ['<a href="https://app.phaeacia.ai﻿/gallery">x</a>', 'app.phaeacia.ai'],
  ['<a href="https://app.phaeacia‌.ai/g‍allery">x</a>', '/gallery'],
];

test('M1b: a zero-width or full-width host in a stylesheet link is refused by the scan; a local stylesheet passes', () => {
  /* The URL parser reads both variants as the public host. */
  assert.equal(new URL(ZWSP_HOST_URL).hostname, 'app.phaeacia.ai');
  assert.equal(new URL(FULLWIDTH_HOST_URL).hostname, 'app.phaeacia.ai');
  const clean = renderPassportPage({ row: rowOf('synthetic-empty.md'), assetBase: 'assets' });
  for (const [snippet, expect] of NORMALIZED_HOST_CASES) {
    const problems = scanPage(clean.replace('</main>', `${snippet}</main>`), { installation: false });
    assert.ok(
      problems.some((p) => p.includes(`forbidden string "${expect}"`)),
      `${JSON.stringify(snippet)}: ${JSON.stringify(problems)}`,
    );
  }
  /* The critic's exact probe: the bare link, outside any page. */
  assert.notDeepEqual(scanPage(`<link rel="stylesheet" href="${ZWSP_HOST_URL}">`, { installation: false }), []);
  /* Control: the local stylesheet link the renderer emits, and the clean page. */
  assert.deepEqual(scanPage('<link rel="stylesheet" href="/assets/base.css">', { installation: false }), []);
  assert.deepEqual(scanPage('<link rel="stylesheet" href="assets/base.css">', { installation: false }), []);
  assert.deepEqual(scanPage(clean, { installation: false }), []);
});

test('M1b: the zero-width stylesheet host in a scratch copy of the renderer fails the build on all seven pages; restored passes', () => {
  const mutant = mutantRenderer('zwsp-host', (s) =>
    s.replace(
      '<meta name="robots" content="noindex, nofollow">\n<title>',
      `<meta name="robots" content="noindex, nofollow">\n<link rel="stylesheet" href="${ZWSP_HOST_URL}">\n<title>`,
    ),
  );
  const out = freshDir('build-zwsp-host');
  const bad = runCheckRender(['--out', out, '--renderer', mutant]);
  assert.equal(bad.code, 2, bad.out);
  const refused = bad.out.match(/^REFUSE .*forbidden string "app\.phaeacia\.ai"/gm) ?? [];
  assert.equal(refused.length, 7, bad.out);
  assert.match(bad.out, /check-render: 7 pages, 7 problem\(s\)/);
  const good = runCheckRender(['--out', freshDir('build-zwsp-clean')]);
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /check-render: 7 pages, 0 problem\(s\)/);
});

test('M1: owner prose "Nothing **was** lost." and a declared "**No** loss" row are refused through the renderer and the CLI', () => {
  const root = freshDir('scan-root');
  cpSync(join(REPO, 'tests/fixtures'), join(root, 'tests/fixtures'), { recursive: true });
  cpSync(FIXTURES, join(root, 'tests/passport/fixtures'), { recursive: true });
  const emptyPath = join(root, 'tests/passport/fixtures/synthetic-empty.md');
  writeFileSync(
    emptyPath,
    readFileSync(emptyPath, 'utf8').replace(
      'SYNTHETIC preparation only. To be filled during an actual install and always shown.',
      'Nothing **was** lost.',
    ),
  );
  const declaredPath = join(root, 'tests/passport/fixtures/synthetic-declared-losses.md');
  writeFileSync(
    declaredPath,
    readFileSync(declaredPath, 'utf8').replace(
      'The original showed each label in a colour; the copy prints plain text',
      '**No** loss',
    ),
  );
  /* The pinned gate accepts both; the renderer emits tag-split text. */
  const prose = rowFromMarkdown(readFileSync(emptyPath, 'utf8'), VALIDATED_AT);
  const proseHtml = renderPassportPage({ row: prose, assetBase: 'assets' });
  assert.ok(proseHtml.includes('Nothing <strong>was</strong> lost.'));
  assert.equal(
    scanPage(proseHtml, { installation: false }).length,
    1,
    JSON.stringify(scanPage(proseHtml, { installation: false })),
  );
  const declared = rowFromMarkdown(readFileSync(declaredPath, 'utf8'), VALIDATED_AT);
  const declaredHtml = renderPassportPage({ row: declared, assetBase: 'assets' });
  assert.ok(declaredHtml.includes('<strong>No</strong> loss'));
  assert.equal(scanPage(declaredHtml, { installation: false }).length, 1);
  const r = runCheckRender(['--root', root, '--out', freshDir('scan-build')]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /REFUSE passport-p-alpha-1\.html: no-loss outcome/);
  assert.match(r.out, /REFUSE passport-p-beta-1\.html: no-loss outcome/);
  /* Controls: the pending page passes; the release page rendered with the
     reported record, whose text says "no loss reported", passes. */
  const good = runCheckRender(['--out', freshDir('scan-control')]);
  assert.equal(good.code, 0, good.out);
  const clean = { ...installationReported(), losses: [], no_loss_reported: true };
  const empty = rowOf('synthetic-empty.md');
  const assembled = assemble(fixtureText('synthetic-empty.md'), { root: VENDOR, branch: 'generic' });
  const release = renderReleasePage({
    row: empty,
    release: { id: 'r-1', branch: 'generic', assembled_content: assembled, published_at: '2026-09-10T09:00:00Z' },
    installation: clean,
    assetBase: 'assets',
  });
  assert.match(release, /No loss reported by/);
  assert.deepEqual(scanPage(release, { installation: true }), []);
});

/* M2: the build declares its required fixture set, refuses duplicate output
   names before writing, cleans the output directory and counts distinct files. */

function fixtureRoot(name, edit) {
  const root = freshDir(name);
  cpSync(join(REPO, 'tests/fixtures'), join(root, 'tests/fixtures'), { recursive: true });
  cpSync(FIXTURES, join(root, 'tests/passport/fixtures'), { recursive: true });
  for (const c of ['alpha', 'beta']) {
    const p = join(root, 'tests/fixtures/companies', `${c}.json`);
    const json = JSON.parse(readFileSync(p, 'utf8'));
    writeFileSync(p, JSON.stringify(edit(c, json), null, 2));
  }
  return root;
}

const htmlFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.html'));

test('M2: a company fixture without passports fails the build', () => {
  const root = fixtureRoot('m2-missing', (_, json) => ({ ...json, passports: [] }));
  const out = freshDir('m2-missing-build');
  const r = runCheckRender(['--root', root, '--out', out]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /passports/);
  assert.doesNotMatch(r.out, /check-render: \d+ pages, 0 problem/);
});

test('M2: a duplicated passport id is refused before any page is overwritten', () => {
  const root = fixtureRoot('m2-duplicate', (c, json) => {
    if (c !== 'alpha') return json;
    const [a, b] = json.passports;
    return { ...json, passports: [a, { ...b, id: a.id }] };
  });
  const out = freshDir('m2-duplicate-build');
  const r = runCheckRender(['--root', root, '--out', out]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /duplicate output name passport-p-alpha-1\.html/);
  assert.doesNotMatch(r.out, /7 pages/);
});

test('M2: a fixture set without any release fails the build', () => {
  const root = fixtureRoot('m2-no-release', (_, json) => ({
    ...json,
    passports: json.passports.map((p) => ({ ...p, release: null })),
  }));
  const r = runCheckRender(['--root', root, '--out', freshDir('m2-no-release-build')]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /release/);
});

test('M2 control: the ordinary fixtures write seven distinct files, and a stale page is removed first', async () => {
  const out = freshDir('m2-control');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'stale-from-a-previous-build.html'), '<p>app.phaeacia.ai</p>');
  const r = runCheckRender(['--out', out]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /check-render: 7 pages, 0 problem\(s\)/);
  assert.deepEqual(htmlFiles(out).sort(), [
    'catalog-alpha.html',
    'catalog-beta.html',
    'passport-p-alpha-1.html',
    'passport-p-alpha-2.html',
    'passport-p-beta-1.html',
    'passport-p-beta-2.html',
    'release-r-beta-2-generic.html',
  ]);
  const pages = await buildPages({ out: freshDir('m2-control-2') });
  assert.equal(new Set(pages.map((p) => p.file)).size, 7);
});

/* M3: a release branch is one of the four own keys, never an inherited property. */

test('M3: branch "toString" and "constructor" are refused; "generic" passes', () => {
  const row = rowOf('synthetic-empty.md');
  const assembled = assemble(fixtureText('synthetic-empty.md'), { root: VENDOR, branch: 'generic' });
  const release = (branch) => ({
    id: 'r-1',
    branch,
    assembled_content: assembled,
    published_at: '2026-09-10T09:00:00Z',
  });
  for (const branch of ['toString', 'constructor', '__proto__', 'hasOwnProperty', '', undefined]) {
    assert.throws(() => renderReleasePage({ row, release: release(branch) }), /branch/, String(branch));
  }
  const ok = renderReleasePage({ row, release: release('generic'), assetBase: 'assets' });
  assert.ok(ok.includes('The install block for Other assistant, frozen at publication'));
  assert.ok(!ok.includes('native code'));
  /* The catalog never prints an inherited property either. */
  const catalog = renderCatalogPage({
    company: { id: 'x', name: 'SYNTHETIC co', memberships: [], groups: [] },
    entries: [
      { id: 'p-1', row, release: { id: 'r-1', branch: 'toString', published_at: '2026-09-10' }, installation: null },
    ],
    assetBase: 'assets',
  });
  assert.ok(
    !catalog.includes('native code'),
    catalog.slice(catalog.indexOf('Released for'), catalog.indexOf('Released for') + 120),
  );
  assert.ok(catalog.includes('Released for toString'));
});
