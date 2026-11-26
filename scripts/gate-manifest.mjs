#!/usr/bin/env node
/* Gate manifest generator (E3 design 2.7, lead correction C1).

   Walks the module graph from lib/passport/gate.mjs with the exported specifiers() of
   scripts/check-imports.mjs, the same reader the boundary gate uses, so the manifest and the boundary check
   cannot disagree about what an edge is. Every reachable file outside vendor/ is hashed. A reachable file
   under vendor/ is recorded as reached and not hashed, because upstream.lock.json maps every imported vendor
   path to its SHA-256 and the lock's own bytes are the adapter identity. The output module is excluded from
   its own list: it is derived from the list, so it cannot carry its own hash.

   The walk is exact only because the boundary gate refuses dynamic references under lib/ (rule 3). This
   generator refuses them as well, through moduleReferences(), so a manifest is never written for a graph
   that hides a file.

   Output, lib/passport/gate-manifest.mjs:
     MANIFEST             [path, sha256] rows sorted by path (UTF-16 code units; paths are ASCII)
     MANIFEST_SHA256      sha256 over "path\nsha256\n" per row, in that order
     ADAPTER_LOCK_SHA256  sha256 of the committed upstream.lock.json bytes
     VALIDATOR_VERSION    RULES_VERSION of the vendored _validate.mjs
     UPSTREAM_COMMIT      the lock's commit
     GATE_IDENTITY_SHA256 sha256 over "ADAPTER_LOCK_SHA256\nVALIDATOR_VERSION\nMANIFEST_SHA256", hex digests,
                          UTF-8, no trailing newline
   The design names the first three and the identity; the three components are written beside them because
   the migration that registers an identity stores each one, and a reader verifying an attestation needs them.

   Modes:
     (none)        write lib/passport/gate-manifest.mjs
     --out <path>  write the module to another path
     --check       regenerate into .scratch/check/gate-manifest/ and exit 2 on any byte difference from the
                   committed module; this is the scripts/check.sh gate, as import-passport.mjs --verify is
                   for the lock
     --sql         print the SQL that registers this identity and its files, deactivating the previous one
   Exit 0 clean, 2 on a difference or a refused graph. --root <dir> reads another tree (tests). */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { moduleReferences, specifiers } from './check-imports.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY = 'lib/passport/gate.mjs';
export const OUTPUT = 'lib/passport/gate-manifest.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The files reachable from the entry: { files: sorted non-vendor paths without the output, vendor: sorted
    vendor paths reached }. Throws on a dynamic reference, a package, or a path outside the tree. */
export function walk(root, entry = ENTRY) {
  const seen = new Set();
  const vendor = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const abs = join(root, rel);
    if (!existsSync(abs)) throw new Error(`gate-manifest: ${rel} does not exist`);
    const source = readFileSync(abs, 'utf8');
    const { problems } = moduleReferences(source);
    if (problems.length > 0) throw new Error(`gate-manifest: ${rel}:${problems[0].line} ${problems[0].kind}`);
    seen.add(rel);
    for (const spec of specifiers(source)) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) throw new Error(`gate-manifest: ${rel} names the package ${spec}`);
      const target = posix.normalize(posix.join(posix.dirname(rel), spec));
      if (target.startsWith('../')) throw new Error(`gate-manifest: ${rel} reaches outside the tree: ${spec}`);
      if (target.startsWith('vendor/')) vendor.add(target);
      else if (target !== OUTPUT) queue.push(target);
    }
  }
  seen.delete(OUTPUT);
  return { files: [...seen].sort(), vendor: [...vendor].sort() };
}

/** Every value the generated module holds, computed from the tree at root. */
export async function manifest(root = REPO_ROOT) {
  const { files, vendor } = walk(root);
  const rows = files.map((path) => [path, sha256(readFileSync(join(root, path)))]);
  const manifestSha256 = sha256(Buffer.from(rows.map(([path, hash]) => `${path}\n${hash}\n`).join(''), 'utf8'));
  const lockBytes = readFileSync(join(root, 'upstream.lock.json'));
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const { RULES_VERSION } = await import(pathToFileURL(join(root, 'vendor/passport/web/lib/_validate.mjs')).href);
  const adapterLockSha256 = sha256(lockBytes);
  const identity = sha256(Buffer.from(`${adapterLockSha256}\n${RULES_VERSION}\n${manifestSha256}`, 'utf8'));
  return {
    rows,
    vendor,
    manifestSha256,
    adapterLockSha256,
    validatorVersion: RULES_VERSION,
    upstreamCommit: lock.commit,
    gateIdentitySha256: identity,
  };
}

/** The generated module's exact bytes, formatted as Biome formats them. */
export function render(m) {
  const rows = m.rows.map(([path, hash]) => `  Object.freeze(['${path}', '${hash}']),`).join('\n');
  return `/* GENERATED by scripts/gate-manifest.mjs from the module graph of lib/passport/gate.mjs. Do not edit by hand:
   scripts/check.sh regenerates it and fails on any byte difference (E3 design 2.7). This file is not in its own
   list. Vendor files reached, identified by upstream.lock.json rather than here: ${m.vendor.join(', ')}. */

export const MANIFEST = Object.freeze([
${rows}
]);
export const MANIFEST_SHA256 = '${m.manifestSha256}';
export const ADAPTER_LOCK_SHA256 = '${m.adapterLockSha256}';
export const VALIDATOR_VERSION = '${m.validatorVersion}';
export const UPSTREAM_COMMIT = '${m.upstreamCommit}';
export const GATE_IDENTITY_SHA256 = '${m.gateIdentitySha256}';
`;
}

/** The SQL that registers this identity: the previous active row deactivated, the identity row, one file row
    per manifest entry and one gate.register audit row, in one statement block. */
export function registrationSql(m) {
  const files = m.rows.map(([path, hash]) => `    ('${path}', '${hash}')`).join(',\n');
  return `update app.gate_identities set active = false where active;
with g as (
  insert into app.gate_identities
    (identity_sha256, adapter_lock_sha256, validator_version, manifest_sha256, upstream_commit, active)
  values (decode('${m.gateIdentitySha256}', 'hex'), decode('${m.adapterLockSha256}', 'hex'), '${m.validatorVersion}',
          decode('${m.manifestSha256}', 'hex'), '${m.upstreamCommit}', true)
  returning id, identity_sha256
), f as (
  insert into app.gate_identity_files (gate_id, path, sha256)
  select g.id, v.path, decode(v.sha256, 'hex')
    from g, (values
${files}
    ) as v (path, sha256)
  returning gate_id
)
select app.audit(null, null, 'system', 'gate.register', 'gate_identity', g.id,
                 jsonb_build_object('gate_identity_sha256', encode(g.identity_sha256, 'hex')))
  from g;
`;
}

async function main() {
  const args = process.argv.slice(2);
  let root = REPO_ROOT;
  let out = null;
  let mode = 'write';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') root = resolve(args[++i]);
    else if (args[i] === '--out') out = resolve(args[++i]);
    else if (args[i] === '--check') mode = 'check';
    else if (args[i] === '--sql') mode = 'sql';
    else {
      process.stderr.write(`gate-manifest: unknown argument ${args[i]}\n`);
      return 2;
    }
  }
  let m;
  try {
    m = await manifest(root);
  } catch (e) {
    process.stdout.write(`REFUSE ${e.message}\n`);
    return 2;
  }
  if (mode === 'sql') {
    process.stdout.write(registrationSql(m));
    return 0;
  }
  const bytes = render(m);
  if (mode === 'check') {
    const dir = join(root, '.scratch', 'check', 'gate-manifest');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'gate-manifest.mjs'), bytes);
    const committedPath = join(root, OUTPUT);
    const committed = existsSync(committedPath) ? readFileSync(committedPath, 'utf8') : null;
    if (committed !== bytes) {
      process.stdout.write(
        `REFUSE ${OUTPUT} is stale: regenerated identity ${m.gateIdentitySha256}; run node scripts/gate-manifest.mjs\n`,
      );
      return 2;
    }
    process.stdout.write(
      `gate-manifest: ${m.rows.length} files, identity ${m.gateIdentitySha256}, committed module matches\n`,
    );
    return 0;
  }
  const target = out ?? join(root, OUTPUT);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  process.stdout.write(`gate-manifest: wrote ${target}, ${m.rows.length} files, identity ${m.gateIdentitySha256}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
