#!/usr/bin/env node
/* The published tree (pages design 4.6, revision 7). Assembles web/ and, byte-exact, the vendored brand tokens and
   fonts into a fresh output directory, then proves the output is what it claims to be. In this order:

     1. The source. Every entry under web/ is examined with lstat before anything is written: a symbolic link, a
        directory name outside ^[a-z0-9][a-z0-9-]*$, a file name outside ^[a-z0-9][a-z0-9-]*\.(mjs|html|css|svg)$ and
        any other kind of entry are refused, and so is web/assets/vendor/, the place the vendored copies are published.
     2. Freshness. A non-empty --out is refused unless --clean is given, and --clean removes the directory before
        anything is written. --out may not be the repository or one of its ancestors, or lie inside web/ or vendor/,
        and the manifest may not lie inside --out.
     3. The copies. Every file of web/ is copied to the same relative path, and the six files of VENDORED are copied
        from vendor/passport/web/assets/ to assets/vendor/. Each copy is hashed after it is written and compared with
        its source; each vendored copy is also compared with the SHA-256 that upstream.lock.json registers for it under
        imported, so a vendored file changed by one byte fails here as well as at the adapter gate.
     4. The scan. Every published .html file goes through scanPage from scripts/check-render.mjs, the E1b build scan,
        and every other published text file (.mjs, .css, .svg, .txt) is searched for the same FORBIDDEN_STRINGS,
        case-folded. The three woff2 files are binary and are held by their hashes alone. One exemption, and only one
        (E6 pages lane, granted by the lead 2026-09-18): the list's '/delete' exists to keep the public app's Delete
        link out of an enterprise render, and the enterprise's own operator route POST
        /api/operator/companies/{companyId}/delete is not that link. So '/delete' is admitted in assets/app/api.mjs
        inside that route's exact template literal, matched whole, and nowhere else: the same string anywhere else
        in api.mjs, in any other file, or the same literal in any other file still fails (tests/e2/unit/
        site-build.test.mjs). The design named a route this gate refuses; the lead records the amendment.
     4a. The capture prompt (HOSTED-F3, evidence/operator-landing.md). web/assets/app/capture-text.mjs is a stub in
        the source, because capture/enterprise.md holds a word scripts/check-web.mjs refuses under web/. It is not
        copied: the build writes in its place the file's text as one JSON string literal and the file's SHA-256, then
        reads what it wrote back, decodes the literal and refuses unless the decoded text is the file's exact bytes and
        the hash is the file's. A carriage return in the file is refused, because the page's text area would show and
        select it as a line feed. The two go together: capture/enterprise.md without the stub, or the stub without the
        file, is refused before anything is written, so the real tree always publishes the prompt and a tree with
        neither (the unit fixtures) publishes none. The published module passes the forbidden-string scan like any
        other.
     5. The manifest. Every published path with its SHA-256, written outside the published tree (default
        .scratch/site-manifest.json), so the manifest is never itself served. When the prompt is published the
        manifest also names it: { capture: { source, module, sha256 } }.
     6. The comparison. The output is walked again with lstat after writing, and the files on disk must equal the
        manifest in both directions with equal hashes, so neither a stale file nor a missing one passes.
        verifyOutput(out, manifest) is this comparison alone: the dev shell runs it before it serves anything, and
        --verify runs it from the command line against a tree someone may have changed since it was built.

   Nothing is deployed. Options: --out <dir> (default .scratch/site), --clean, --manifest <file> (default
   .scratch/site-manifest.json), --root <dir> (tests), --verify. Exit 0 clean, 2 on findings. */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FORBIDDEN_STRINGS, scanPage } from './check-render.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* Rule 1 of the web/ import contract (4.5), which scripts/check-imports.mjs applies with the same expressions. */
export const WEB_DIRECTORY = /^[a-z0-9][a-z0-9-]*$/;
export const WEB_FILE = /^[a-z0-9][a-z0-9-]*\.(?:mjs|html|css|svg)$/;

/* The vendored files the pages use, relative to vendor/passport/web/assets/ and to <out>/assets/vendor/. base.css and
   recipient.css are not published: they carry public-site selectors and comments naming public routes (4.6). */
export const VENDORED = Object.freeze([
  'tokens.css',
  'fonts/fonts.css',
  'fonts/dm-mono-latin-400-normal.woff2',
  'fonts/dm-mono-latin-500-normal.woff2',
  'fonts/schibsted-grotesk-latin-wght-normal.woff2',
  'fonts/OFL.txt',
]);
export const VENDOR_TARGET = 'assets/vendor';
const VENDOR_SOURCE = 'vendor/passport/web/assets';
const SCANNED_TEXT = /\.(?:mjs|css|svg|txt)$/;
/* Step 4a: the prompt's source, the stub's published path, and the exact shape the build writes there. */
export const CAPTURE_SOURCE = 'capture/enterprise.md';
export const CAPTURE_MODULE = 'assets/app/capture-text.mjs';
const CAPTURE_HEAD =
  '/* Written by scripts/build-site.mjs from capture/enterprise.md (step 4a). */\nexport const CAPTURE_TEXT = ';
const captureModule = (literal, hash) => `${CAPTURE_HEAD}${literal};\nexport const CAPTURE_SHA256 = '${hash}';\n`;
/** The text and hash a published capture module carries, read back by its exact shape; null for any other shape. A
    JSON string holds no raw line break, so the tail can only be the module's last line. */
export function readCaptureModule(source) {
  const tail = /;\nexport const CAPTURE_SHA256 = '([0-9a-f]{64})';\n$/.exec(source);
  if (!source.startsWith(CAPTURE_HEAD) || !tail) return null;
  try {
    const text = JSON.parse(source.slice(CAPTURE_HEAD.length, tail.index));
    return typeof text === 'string' ? { text, sha256: tail[1] } : null;
  } catch {
    return null;
  }
}
/* The one exemption of step 4, whole: [published file, forbidden string, the exact literal in which it is admitted]. */
const ROUTE_LITERAL_EXEMPTION = Object.freeze([
  'assets/app/api.mjs',
  '/delete',
  '`/api/operator/companies/${segment(companyId)}/delete`',
]);
/** The text of a published file as the forbidden-string scan reads it for one string: case-folded, with the exempted
    literal removed when, and only when, this is the exempted file and the exempted string. */
function scannedFor(rel, text, forbidden) {
  const [file, string, literal] = ROUTE_LITERAL_EXEMPTION;
  if (rel !== file || forbidden !== string) return text;
  return text.split(literal.toLowerCase()).join('');
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/* The files of web/, relative to it, after rule 1; refusals go to problems and nothing is copied from a refused
   directory. */
function sourceFiles(root, problems) {
  const web = join(root, 'web');
  if (!existsSync(web) || !lstatSync(web).isDirectory()) {
    problems.push({ rule: 'web/ is missing or is not a directory', path: 'web/' });
    return [];
  }
  const files = [];
  const visit = (rel) => {
    for (const name of readdirSync(join(web, rel)).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      const shown = `web/${childRel}`;
      const st = lstatSync(join(web, childRel));
      if (st.isSymbolicLink()) problems.push({ rule: 'symbolic link refused under web/', path: shown });
      else if (st.isDirectory()) {
        if (!WEB_DIRECTORY.test(name))
          problems.push({ rule: 'directory name outside the web/ contract', path: `${shown}/` });
        else if (childRel === VENDOR_TARGET)
          problems.push({ rule: 'web/assets/vendor/ is where the vendored copies are published', path: `${shown}/` });
        else visit(childRel);
      } else if (st.isFile()) {
        if (WEB_FILE.test(name)) files.push(childRel);
        else problems.push({ rule: 'file name or type outside the web/ contract', path: shown });
      } else problems.push({ rule: 'entry neither a file nor a directory refused under web/', path: shown });
    }
  };
  visit('');
  return files;
}

/* Every regular file under a directory, relative to it, walked with lstat; anything else is a problem. */
function outputFiles(out, problems) {
  const files = [];
  if (!existsSync(out)) return files;
  const visit = (rel) => {
    for (const name of readdirSync(rel ? join(out, rel) : out).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(out, childRel));
      if (st.isSymbolicLink()) problems.push({ rule: 'symbolic link in the output', path: childRel });
      else if (st.isDirectory()) visit(childRel);
      else if (st.isFile()) files.push(childRel);
      else problems.push({ rule: 'entry neither a file nor a directory in the output', path: childRel });
    }
  };
  visit('');
  return files;
}

/** verifyOutput(out, manifestPath) -> { files: Map(path -> sha256), problems }: the output against the manifest, both
    directions, hashes included. */
export function verifyOutput(out, manifestPath) {
  const problems = [];
  let listed;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest?.files !== 'object' || manifest.files === null || Array.isArray(manifest.files))
      throw new Error('files');
    listed = new Map(Object.entries(manifest.files));
  } catch {
    return { files: new Map(), problems: [{ rule: 'manifest missing or unreadable', path: manifestPath }] };
  }
  const onDisk = outputFiles(out, problems);
  for (const rel of onDisk) {
    if (!listed.has(rel)) problems.push({ rule: 'file in the output that the manifest does not name', path: rel });
    else if (sha256(readFileSync(join(out, rel))) !== listed.get(rel))
      problems.push({ rule: 'file in the output differs from its manifest hash', path: rel });
  }
  const disk = new Set(onDisk);
  for (const rel of listed.keys())
    if (!disk.has(rel)) problems.push({ rule: 'manifest entry missing from the output', path: rel });
  return { files: listed, problems };
}

/** buildSite({ root, out, clean, manifest }) -> { out, manifest, files: Map(path -> sha256), problems }. Writes
    nothing when a placement, source or vendored-file refusal is found. */
export function buildSite({ root = REPO_ROOT, out, clean = false, manifest } = {}) {
  const base = resolve(root);
  const target = resolve(out ?? join(base, '.scratch', 'site'));
  const manifestPath = resolve(manifest ?? join(base, '.scratch', 'site-manifest.json'));
  const problems = [];
  const refuse = (rule, path) => problems.push({ rule, path });

  if (within(base, target)) refuse('--out is the repository or one of its ancestors', target);
  for (const tree of ['web', 'vendor'])
    if (within(target, join(base, tree))) refuse(`--out lies inside ${tree}/`, target);
  if (within(manifestPath, target)) refuse('--manifest lies inside the published tree', manifestPath);
  if (existsSync(target)) {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || !st.isDirectory()) refuse('--out exists and is not a directory', target);
    else if (readdirSync(target).length > 0 && !clean) refuse('--out is not empty; pass --clean to replace it', target);
  }
  const sources = sourceFiles(base, problems);
  let imported = {};
  try {
    imported = JSON.parse(readFileSync(join(base, 'upstream.lock.json'), 'utf8')).imported ?? {};
  } catch {
    refuse('upstream.lock.json missing or unreadable', 'upstream.lock.json');
  }
  for (const file of VENDORED) {
    const src = join(base, VENDOR_SOURCE, file);
    if (!existsSync(src) || !lstatSync(src).isFile()) refuse('vendored file missing', `${VENDOR_SOURCE}/${file}`);
    if (typeof imported[`web/assets/${file}`] !== 'string')
      refuse('vendored file not registered in upstream.lock.json', `web/assets/${file}`);
  }
  const captureSource = join(base, CAPTURE_SOURCE);
  const hasCapture = existsSync(captureSource) && lstatSync(captureSource).isFile();
  const hasStub = sources.includes(CAPTURE_MODULE);
  if (hasCapture && !hasStub)
    refuse(`${CAPTURE_SOURCE} exists and web/${CAPTURE_MODULE} does not`, `web/${CAPTURE_MODULE}`);
  if (hasStub && !hasCapture) refuse(`web/${CAPTURE_MODULE} exists and ${CAPTURE_SOURCE} does not`, CAPTURE_SOURCE);
  if (problems.length) return { out: target, manifest: manifestPath, files: new Map(), problems };

  if (clean) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const published = new Map();
  const copy = (src, rel) => {
    const dst = join(target, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    const copied = sha256(readFileSync(dst));
    if (copied !== sha256(readFileSync(src))) refuse('copy differs from its source', rel);
    published.set(rel, copied);
    return copied;
  };
  for (const rel of sources) if (rel !== CAPTURE_MODULE) copy(join(base, 'web', rel), rel);
  let capture = null;
  if (hasStub) {
    const bytes = readFileSync(captureSource);
    const hash = sha256(bytes);
    /* The page shows the text as a text area's value, which turns a carriage return into a line feed: a prompt holding
       one would be shown and copied by hand as other bytes than the file's (PC-3, evidence/operator-landing.md). */
    if (bytes.includes(0x0d))
      refuse(`${CAPTURE_SOURCE} holds a carriage return, which the page's text area would change`, CAPTURE_SOURCE);
    const dst = join(target, CAPTURE_MODULE);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, captureModule(JSON.stringify(bytes.toString('utf8')), hash));
    const written = readFileSync(dst);
    const read = readCaptureModule(written.toString('utf8'));
    if (!read || !Buffer.from(read.text, 'utf8').equals(bytes) || read.sha256 !== hash)
      refuse(`the published capture text is not ${CAPTURE_SOURCE} byte for byte`, CAPTURE_MODULE);
    published.set(CAPTURE_MODULE, sha256(written));
    capture = { source: CAPTURE_SOURCE, module: CAPTURE_MODULE, sha256: hash };
  }
  for (const file of VENDORED) {
    const rel = `${VENDOR_TARGET}/${file}`;
    if (copy(join(base, VENDOR_SOURCE, file), rel) !== imported[`web/assets/${file}`])
      refuse('vendored copy differs from the SHA-256 upstream.lock.json registers', rel);
  }

  for (const rel of published.keys()) {
    if (rel.endsWith('.html')) {
      for (const p of scanPage(readFileSync(join(target, rel), 'utf8'), { installation: false }))
        refuse(`build scan: ${p}`, rel);
    } else if (SCANNED_TEXT.test(rel)) {
      const text = readFileSync(join(target, rel), 'utf8').toLowerCase();
      for (const s of FORBIDDEN_STRINGS)
        if (scannedFor(rel, text, s).includes(s.toLowerCase())) refuse(`build scan: forbidden string "${s}"`, rel);
    }
  }

  const files = Object.fromEntries([...published.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(capture ? { files, capture } : { files }, null, 2)}\n`);
  problems.push(...verifyOutput(target, manifestPath).problems);
  return { out: target, manifest: manifestPath, files: published, problems };
}

function parseArgs(argv) {
  const opts = { root: REPO_ROOT, clean: false, verify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} needs a value`);
      return argv[i];
    };
    if (a === '--out') opts.out = resolve(next());
    else if (a === '--manifest') opts.manifest = resolve(next());
    else if (a === '--root') opts.root = resolve(next());
    else if (a === '--clean') opts.clean = true;
    else if (a === '--verify') opts.verify = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stdout.write(`build-site: ${e.message}\n`);
    return 2;
  }
  const out = opts.out ?? join(opts.root, '.scratch', 'site');
  const manifest = opts.manifest ?? join(opts.root, '.scratch', 'site-manifest.json');
  const r = opts.verify ? verifyOutput(out, manifest) : buildSite({ ...opts, out, manifest });
  for (const p of r.problems) process.stdout.write(`REFUSE ${p.rule}: ${p.path}\n`);
  process.stdout.write(
    `build-site: ${r.files.size} files ${opts.verify ? 'verified in' : 'published to'} ${out}, manifest ${manifest}, ${r.problems.length} problem(s)\n`,
  );
  return r.problems.length ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
