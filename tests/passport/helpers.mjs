/* Shared helpers for the E1a tests: a minimal ustar writer for fixture
   archives, workspace hashing, and the controlled Python launcher. */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const IMPORTER = join(REPO, 'scripts', 'import-passport.mjs');
export const VENDOR = join(REPO, 'vendor', 'passport');
export const SCRATCH = join(REPO, '.scratch', 'tests');

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function freshDir(name) {
  const dir = join(SCRATCH, `${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* ---------- ustar writer ---------- */

function header(fields) {
  const h = Buffer.alloc(512, 0);
  const put = (off, len, s) => h.write(s, off, len, 'utf8');
  const oct = (off, len, n) => put(off, len, `${n.toString(8).padStart(len - 1, '0')}\0`);
  put(0, 100, fields.name);
  oct(100, 8, fields.mode ?? 0o644);
  oct(108, 8, 0);
  oct(116, 8, 0);
  oct(124, 12, fields.size ?? 0);
  oct(136, 12, 0);
  h.fill(' ', 148, 156);
  h.write(fields.type, 156, 1, 'ascii');
  if (fields.linkname) put(157, 100, fields.linkname);
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

/* entries: [{ path, type: 'file'|'dir'|'symlink'|'hardlink'|'fifo', content, target }] */
export function makeTar(entries) {
  const blocks = [];
  for (const e of entries) {
    if (e.type === 'dir') blocks.push(header({ name: `${e.path}/`, type: '5', mode: 0o755 }));
    else if (e.type === 'file') {
      const data = Buffer.from(e.content ?? '', 'utf8');
      blocks.push(header({ name: e.path, type: '0', size: data.length }));
      blocks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad, 0));
    } else if (e.type === 'symlink') blocks.push(header({ name: e.path, type: '2', linkname: e.target }));
    else if (e.type === 'hardlink') blocks.push(header({ name: e.path, type: '1', linkname: e.target }));
    else if (e.type === 'fifo') blocks.push(header({ name: e.path, type: '6' }));
    else throw new Error(`unknown entry type ${e.type}`);
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

/* A small synthetic upstream tree with the layout the allowlist expects. */
export function fixtureEntries(overrides = {}) {
  const files = {
    'README.md': '# not imported\n',
    LICENSE: 'Apache-2.0\n',
    NOTICE: 'notice\n',
    'publish/LICENSE-MAP.md': 'map\n',
    'spec/passport-0.1.md': 'spec\n',
    'spec/resolution.d/generic.yaml': 'generic: {}\n',
    'installer/core.md': 'core\n',
    'installer/branches/chatgpt.md': 'chatgpt\n',
    'installer/branches/generic.md': 'generic\n',
    'verification/judge-prompt.md': '````\njudge\n````\n',
    'examples/daily-brief-passport.md': 'example\n',
    'tools/validate.py': 'print(1)\n',
    'tools/fixtures/passports/valid_a.md': 'a\n',
    'scripts/assemble.py': 'pass\n',
    'scripts/passport-to-page.py': 'pass\n',
    'web/lib/_validate.mjs': 'export const SECRETS = [];\n',
    'web/lib/_metrics.mjs': 'export {};\n',
    'web/lib/_store.mjs': 'not imported\n',
    'web/tools/parity.mjs': 'export {};\n',
    'web/assets/tokens.css': ':root{}\n',
    'web/assets/fonts/OFL.txt': 'OFL\n',
    ...overrides,
  };
  const dirs = new Set();
  for (const p of Object.keys(files)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const entries = [...dirs].sort().map((d) => ({ path: d, type: 'dir' }));
  for (const p of Object.keys(files).sort()) entries.push({ path: p, type: 'file', content: files[p] });
  return entries;
}

export function runImporter(args, opts = {}) {
  const r = spawnSync(process.execPath, [IMPORTER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

export function importFixture(workspace, tarPath, extra = []) {
  return runImporter(['--workspace', workspace, '--archive', tarPath, '--commit', 'f'.repeat(40), ...extra]);
}

/* Every entry under a directory as "path kind sha256|target", sorted. */
export function snapshot(root) {
  const lines = [];
  const walk = (rel) => {
    const abs = rel ? join(root, rel) : root;
    for (const name of readdirSync(abs).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(abs, name));
      if (st.isSymbolicLink()) lines.push(`${childRel} symlink ${readlinkSync(join(abs, name))}`);
      else if (st.isDirectory()) {
        lines.push(`${childRel} dir`);
        walk(childRel);
      } else if (st.isFile()) lines.push(`${childRel} file ${sha256(readFileSync(join(abs, name)))}`);
      else lines.push(`${childRel} other`);
    }
  };
  walk('');
  return lines.join('\n');
}

/* ---------- controlled Python launcher (contract section 8) ---------- */

export function resolveInterpreter() {
  const override = process.env.PASSPORT_PYTHON;
  const probe = override ?? 'python3';
  const path = execFileSync(probe, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  const version = execFileSync(path, ['-c', 'import sys; print(".".join(map(str, sys.version_info[:3])))'], {
    encoding: 'utf8',
  }).trim();
  return { path, version };
}

/* Creates <dir>/bin/python3 that execs the absolute interpreter with the given
   flags, and returns the PATH prefix to use for Node-spawned children. */
export function makeLauncher(dir, interpreterPath, flags = ['-I', '-B']) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, 'python3');
  writeFileSync(shim, `#!/bin/sh\nexec "${interpreterPath}" ${flags.join(' ')} "$@"\n`);
  chmodSync(shim, 0o755);
  return { bin, shim, path: `${bin}:${process.env.PATH ?? ''}` };
}
