#!/usr/bin/env node
/* Format and lint gate (architecture section 11). Runs Biome over the
   explicit owned paths derived from files.includes in biome.json, never over
   the repository root: a root run scans the whole checkout for configuration
   files, and a stray biome.json under the ignored .scratch/ tree (a scratch
   export, a lint demonstration) fails it with "nested root configuration".
   Also asserts that the upstream lock and the vendor tree are outside the
   formatter's reach. Exit 0 clean, 2 on findings. */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIOME = join(REPO_ROOT, 'node_modules', '.bin', 'biome');
const MUST_BE_IGNORED = ['upstream.lock.json', 'vendor/passport/web/lib/_validate.mjs'];

/* "lib/**" -> "lib"; a plain file entry stays as is. Globs with other
   wildcards are refused so the gate never silently narrows. */
export function ownedPaths(config) {
  const includes = config?.files?.includes;
  if (!Array.isArray(includes) || includes.length === 0)
    throw new Error('biome.json files.includes is missing or empty');
  return includes.map((glob) => {
    const path = glob.endsWith('/**') ? glob.slice(0, -3) : glob;
    if (/[*?[\]{}!]/.test(path)) throw new Error(`unsupported include pattern in biome.json: ${glob}`);
    return path;
  });
}

function biome(command, args) {
  const r = spawnSync(BIOME, [command, '--colors=off', ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

function main() {
  if (!existsSync(BIOME)) {
    process.stdout.write('biome is not installed; run npm ci\n');
    return 2;
  }
  const paths = ownedPaths(JSON.parse(readFileSync(join(REPO_ROOT, 'biome.json'), 'utf8')));
  const ignored = biome('format', MUST_BE_IGNORED);
  const reported =
    MUST_BE_IGNORED.every((p) => ignored.out.includes(p.split('/').pop())) && /ignored/.test(ignored.out);
  if (!reported) {
    process.stdout.write(`REFUSE biome would process ${MUST_BE_IGNORED.join(' or ')}\n${ignored.out}`);
    return 2;
  }
  const ci = biome('ci', paths);
  process.stdout.write(ci.out);
  process.stdout.write(`check-format: biome ci over ${paths.join(' ')}; lock and vendor ignored\n`);
  return ci.code === 0 ? 0 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
