#!/usr/bin/env node
/* Dependency check (architecture section 11): every dependency in
   package.json is pinned to an exact version, every one appears in
   package-lock.json with a resolved URL and integrity, and an installed copy,
   when present, has that exact version. No network. Exit 0 clean, 2 on
   findings. --root <dir> checks another tree (tests). */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXACT = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function checkDeps(root) {
  const problems = [];
  const pkgPath = join(root, 'package.json');
  const lockPath = join(root, 'package-lock.json');
  if (!existsSync(pkgPath)) return { problems: [{ rule: 'missing package.json', path: 'package.json' }], count: 0 };
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
  const names = Object.keys(declared);
  if (!existsSync(lockPath)) {
    if (names.length) problems.push({ rule: 'missing package-lock.json', path: 'package-lock.json' });
    return { problems, count: names.length };
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (lock.lockfileVersion !== 3) problems.push({ rule: 'lockfileVersion is not 3', path: 'package-lock.json' });
  const packages = lock.packages ?? {};
  for (const name of names) {
    const range = declared[name];
    if (!EXACT.test(range)) problems.push({ rule: `unpinned range ${range}`, path: name });
    const entry = packages[`node_modules/${name}`];
    if (!entry) {
      problems.push({ rule: 'dependency missing from the lockfile', path: name });
      continue;
    }
    if (entry.version !== range)
      problems.push({ rule: `lockfile version ${entry.version} differs from ${range}`, path: name });
    if (!entry.resolved || !entry.integrity)
      problems.push({ rule: 'lockfile entry lacks resolved or integrity', path: name });
    const installed = join(root, 'node_modules', name, 'package.json');
    if (existsSync(installed)) {
      const v = JSON.parse(readFileSync(installed, 'utf8')).version;
      if (v !== range) problems.push({ rule: `installed version ${v} differs from ${range}`, path: name });
    }
  }
  for (const [key, entry] of Object.entries(packages)) {
    if (!key) continue;
    if (entry.link) continue;
    if (!entry.integrity && !entry.optional) problems.push({ rule: 'lockfile entry without integrity', path: key });
  }
  return { problems, count: names.length };
}

function main() {
  const args = process.argv.slice(2);
  let root = REPO_ROOT;
  for (let i = 0; i < args.length; i++) if (args[i] === '--root') root = resolve(args[++i]);
  const { problems, count } = checkDeps(root);
  for (const p of problems) process.stdout.write(`REFUSE ${p.rule}: ${p.path}\n`);
  process.stdout.write(`check-deps: ${count} declared dependencies, ${problems.length} problem(s)\n`);
  return problems.length ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
