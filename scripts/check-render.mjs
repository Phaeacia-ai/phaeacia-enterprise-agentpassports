#!/usr/bin/env node
/* Build gate (architecture section 11, adapter section 5): render every
   synthetic fixture page with the derived private renderer to a scratch
   directory, then scan the rendered HTML.

   The scan fails on any of the public shell strings in FORBIDDEN_STRINGS, and
   on a no-loss outcome ("nothing was lost", "no loss", case-insensitive) in a
   page rendered without an installation record, because an empty losses
   template is a pending state and not a clean result (critique A5, adapter
   section 5). The same list is the regression fixture for the derived
   renderer: injecting one of those strings into render.mjs must fail this
   gate (section 8 rows 5 and 5b, tests/passport/render.test.mjs).

   Rows are built from the fixture Markdown through the vendored gate:
   transport(), validate() and derive() at the pin, exactly as the intake path
   will call them, so a fixture the pinned gate refuses is not rendered. The
   release page's frozen body is produced once here by lib/passport/assemble.mjs
   and passed to the renderer as a string; the renderer reads nothing.

   The scan reads three views of each page (critique M1, 2026-09-10): the raw
   HTML; its decoded text content (comments and tags removed, character
   references decoded, whitespace collapsed, case-folded), in two joins so
   that a host split across inline tags and a phrase split across cells are
   both seen; and every decoded URL or metadata attribute value (href, src,
   content, action and their data- and formaction variants, character
   references and percent-escapes decoded, case-folded), each also in the
   view the URL parser takes of it (critique M1b, 2026-09-10): format
   characters (Unicode category Cf: zero-width space and joiners, word
   joiner, byte-order mark, soft hyphen and the rest) removed, NFKC applied,
   case folded, and, where the value parses as a URL, its parsed hostname.
   Limits, stated in adapter section 5: one decoding pass, so a doubly
   encoded value is not decoded twice; named references beyond the common
   set are left as written; no CSS, no script text (there is none), no
   semantic reading, and no host normalization of the text views. It is a
   build tripwire on synthetic pages, not access control.

   The scan covers the rendered .html files only. The copied vendor CSS is
   byte-exact upstream content and is not scanned: base.css mentions /gallery
   and /manage inside comments, not as links.

   Completeness (critique M2): the build declares the fixture set it
   requires (REQUIRED_FIXTURES), refuses a duplicate output name before
   writing anything, removes the previous build's pages and assets first,
   and fails unless the number of distinct files written equals the number
   of pages reported.

   Options: --out <dir> (default .scratch/build), --renderer <path> (a scratch
   copy of the renderer, tests only), --root <dir> (fixture root, tests only).
   Exit 0 clean, 2 on findings. No network, no server; nothing is served. */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assemble } from '../lib/passport/assemble.mjs';
import { derive } from '../vendor/passport/web/lib/_derive.mjs';
import { transport, validate } from '../vendor/passport/web/lib/_validate.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(REPO_ROOT, 'vendor/passport');
const DEFAULT_RENDERER = join(REPO_ROOT, 'lib/passport/render.mjs');
const COMPANIES = ['alpha', 'beta'];
/* A fixed validation time so the rendered pages and their screenshots are
   reproducible; the real intake path records the actual time. */
const VALIDATED_AT = '2026-09-10T08:00:00.000Z';

export const FORBIDDEN_STRINGS = Object.freeze([
  'app.phaeacia.ai',
  'phaeacia.ai/api',
  'og:',
  'twitter:',
  '/api/copied',
  '/api/vote',
  '/gallery',
  '/manage',
  '/delete',
  'window.__BODY',
]);
export const NO_LOSS_PATTERNS = Object.freeze(['nothing was lost', 'no loss']);

/* Attributes whose value is a URL or metadata that could name a public host
   or route. */
const URL_ATTRIBUTES = new Set(['href', 'src', 'content', 'action', 'formaction', 'data', 'poster', 'srcset']);
const NAMED_REFERENCES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', sol: '/', period: '.' };

/* One pass over character references: numeric (decimal and hex) and the
   common named ones. A reference this does not know stays as written. */
export function decodeReferences(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, ref) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return Object.hasOwn(NAMED_REFERENCES, ref.toLowerCase()) ? NAMED_REFERENCES[ref.toLowerCase()] : m;
  });
}

/* One pass over percent-escapes, byte-wise, so an invalid sequence does not
   throw and ASCII hosts and routes decode. */
function decodePercent(s) {
  return s.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)));
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/* The text views of a page: comments and tags removed, references decoded,
   whitespace collapsed, case-folded. Two joins: tags removed outright, so
   `app.<b>phaeacia</b>.ai` reads as the host, and tags replaced by a space,
   so `<td>No</td><td>loss</td>` reads as the phrase. */
export function textViews(html) {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  return [
    collapse(decodeReferences(noComments.replace(/<[^>]*>/g, ''))),
    collapse(decodeReferences(noComments.replace(/<[^>]*>/g, ' '))),
  ];
}

/* The view the URL parser takes of a host before it is used (critique M1b):
   format characters removed, NFKC applied, case folded. Applied to the whole
   attribute value, which is stricter than the parser and never looser. */
const FORMAT_CHARACTERS = /\p{Cf}/gu;
export function normalizeHostView(s) {
  return s.replace(FORMAT_CHARACTERS, '').normalize('NFKC').toLowerCase();
}

/* The hostname the URL parser derives from a value, or null when the value
   is not an absolute URL (a local asset path, a fragment, an empty value). */
export function parsedHostname(value) {
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

/* Every URL/metadata attribute value on the page as [view, text] pairs:
   decoded and case-folded (the whole value, not only its host, which is
   stricter than needed and never looser); the same value in the URL
   parser's host view; and the parsed hostname where the value is a URL. */
export function attributeValues(html) {
  const out = [];
  for (const tag of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    for (const m of tag[0].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      const name = m[1].toLowerCase();
      const base = name.startsWith('data-') ? name.slice(5) : name;
      if (!URL_ATTRIBUTES.has(base)) continue;
      const raw = m[2] ?? m[3] ?? m[4] ?? '';
      const decoded = decodePercent(decodeReferences(raw));
      out.push(['decoded attribute', collapse(decoded)]);
      out.push(['normalized attribute', collapse(normalizeHostView(decoded))]);
      const host = parsedHostname(decodeReferences(raw).trim());
      if (host) out.push(['parsed attribute host', normalizeHostView(host)]);
    }
  }
  return out;
}

/* Problems in one rendered page. `installation` says whether the page was
   rendered with an installation record; only such a page may carry a
   no-loss outcome. Each finding is reported once, naming the views that
   carried it. */
export function scanPage(html, { installation }) {
  const problems = [];
  const views = [
    ['raw HTML', html],
    ...textViews(html).map((t, i) => [i === 0 ? 'decoded text' : 'decoded text, tags as spaces', t]),
    ...attributeValues(html),
  ];
  /* Case-folded on every view, the raw HTML included. */
  const seen = (needle) => {
    const where = [];
    const n = needle.toLowerCase();
    for (const [name, text] of views) {
      if (text.toLowerCase().includes(n) && !where.includes(name)) where.push(name);
    }
    return where;
  };
  for (const s of FORBIDDEN_STRINGS) {
    const where = seen(s);
    if (where.length) problems.push(`forbidden string "${s}" (${where.join(', ')})`);
  }
  if (!installation) {
    for (const p of NO_LOSS_PATTERNS) {
      const where = seen(p);
      if (where.length) problems.push(`no-loss outcome without an installation record: "${p}" (${where.join(', ')})`);
    }
  }
  return problems;
}

/* The pinned gate in the order the intake path will call it. Throws with the
   first error code; a refused fixture is a build failure, not a page. */
export function rowFromMarkdown(text, validatedAt = VALIDATED_AT) {
  const t = transport(Buffer.from(text, 'utf8'));
  if (t.error) throw new Error(`transport refused the fixture: ${t.error.code}`);
  const v = validate(t.text);
  if (v.errors.length) throw new Error(`validate refused the fixture: ${v.errors.map((e) => e.code).join(', ')}`);
  const d = derive(v.front, v.lines, { validatedAt });
  if (d.error) throw new Error(`derive refused the fixture: ${d.error.code}`);
  return { ...d.record, body: t.text };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/* The fixture set the build requires (critique M2). A fixture root that
   declares less than this is a build failure, not a smaller build. */
export const REQUIRED_FIXTURES = Object.freeze({
  companies: COMPANIES,
  passportsPerCompany: 1,
  releases: 1,
});

/* Reads the company shells and refuses an incomplete or ambiguous fixture
   set before any page is rendered: each required company file, at least one
   passport per company with an id and a file, at least one release over the
   set, and no two pages with the same output name. Returns the plan. */
export function planPages(root = REPO_ROOT) {
  const plan = [];
  const names = new Set();
  const claim = (file) => {
    if (names.has(file)) throw new Error(`duplicate output name ${file}`);
    names.add(file);
    return file;
  };
  let releases = 0;
  for (const name of REQUIRED_FIXTURES.companies) {
    const path = join(root, 'tests/fixtures/companies', `${name}.json`);
    if (!existsSync(path)) throw new Error(`required company fixture missing: ${name}.json`);
    const company = readJson(path);
    const passports = Array.isArray(company.passports) ? company.passports : [];
    if (passports.length < REQUIRED_FIXTURES.passportsPerCompany)
      throw new Error(`company ${name} declares no passports; the build requires at least one per company`);
    for (const p of passports) {
      if (typeof p?.id !== 'string' || !p.id || typeof p.file !== 'string' || !p.file)
        throw new Error(`company ${name}: every passport needs an id and a file`);
      if (!existsSync(join(root, p.file))) throw new Error(`company ${name}: passport file missing: ${p.file}`);
      if (p.installation && !existsSync(join(root, p.installation)))
        throw new Error(`company ${name}: installation record missing: ${p.installation}`);
      if (p.release) {
        if (typeof p.release.id !== 'string' || !p.release.id)
          throw new Error(`company ${name}: a release needs an id`);
        claim(`release-${p.release.id}.html`);
        releases += 1;
      }
      claim(`passport-${p.id}.html`);
    }
    claim(`catalog-${name}.html`);
    plan.push({ name, company, passports });
  }
  if (releases < REQUIRED_FIXTURES.releases)
    throw new Error(`the fixture set declares no release; the build requires at least ${REQUIRED_FIXTURES.releases}`);
  return { plan, expected: names.size };
}

/* Removes the previous build's pages and assets from `out`, and nothing
   else, so a leftover page from an earlier run is never reported as current. */
function cleanOut(out) {
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(out)) {
    if (f.endsWith('.html')) rmSync(join(out, f));
    else if (f === 'assets') rmSync(join(out, f), { recursive: true, force: true });
  }
}

/* Renders every fixture page into `out` and returns [{ file, installation }].
   `renderer` is a path to a renderer module (default the derived one). */
export async function buildPages({ out, renderer = DEFAULT_RENDERER, root = REPO_ROOT }) {
  const r = await import(pathToFileURL(renderer).href);
  const { plan, expected } = planPages(root);
  cleanOut(out);
  const pages = [];
  const written = new Set();
  const write = (file, html, installation) => {
    if (written.has(file)) throw new Error(`duplicate output name ${file}`);
    writeFileSync(join(out, file), html);
    written.add(file);
    pages.push({ file, installation: Boolean(installation) });
  };
  for (const { name, company, passports } of plan) {
    const entries = [];
    for (const p of passports) {
      const text = readFileSync(join(root, p.file), 'utf8');
      const row = rowFromMarkdown(text);
      const installation = p.installation ? readJson(join(root, p.installation)) : null;
      let release = null;
      if (p.release) {
        const assembled_content = assemble(text, { root: VENDOR, branch: p.release.branch });
        release = { ...p.release, assembled_content };
        write(
          `release-${p.release.id}.html`,
          r.renderReleasePage({ row, release, installation, company: company.name, assetBase: 'assets' }),
          installation,
        );
      }
      write(
        `passport-${p.id}.html`,
        r.renderPassportPage({ row, installation, company: company.name, assetBase: 'assets' }),
        installation,
      );
      entries.push({ id: p.id, row, release, installation, state: p.state, audience: p.audience });
    }
    write(`catalog-${name}.html`, r.renderCatalogPage({ company, entries, assetBase: 'assets' }), false);
  }
  const onDisk = readdirSync(out).filter((f) => f.endsWith('.html')).length;
  if (written.size !== pages.length || onDisk !== pages.length || pages.length !== expected) {
    throw new Error(
      `page count mismatch: ${pages.length} reported, ${written.size} distinct names, ${onDisk} files on disk, ${expected} planned`,
    );
  }
  return pages;
}

/* The vendored stylesheets and fonts the pages reference, copied byte-exact
   so a rendered file opens from disk. The marks are not referenced. */
export function copyAssets(out) {
  const assets = join(out, 'assets');
  mkdirSync(join(assets, 'fonts'), { recursive: true });
  for (const f of ['tokens.css', 'base.css', 'recipient.css']) cpSync(join(VENDOR, 'web/assets', f), join(assets, f));
  cpSync(join(VENDOR, 'web/assets/fonts'), join(assets, 'fonts'), { recursive: true });
}

function parseArgs(argv) {
  const opts = { out: join(REPO_ROOT, '.scratch/build'), renderer: DEFAULT_RENDERER, root: REPO_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} needs a value`);
      return argv[i];
    };
    if (a === '--out') opts.out = resolve(next());
    else if (a === '--renderer') opts.renderer = resolve(next());
    else if (a === '--root') opts.root = resolve(next());
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pages = await buildPages(opts);
  copyAssets(opts.out);
  let problems = 0;
  for (const p of pages) {
    const html = readFileSync(join(opts.out, p.file), 'utf8');
    for (const problem of scanPage(html, { installation: p.installation })) {
      problems += 1;
      process.stdout.write(`REFUSE ${p.file}: ${problem}\n`);
    }
  }
  process.stdout.write(`check-render: ${pages.length} pages, ${problems} problem(s), rendered to ${opts.out}\n`);
  return problems ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`check-render: ${e.message}\n`);
      process.exitCode = 2;
    },
  );
}
