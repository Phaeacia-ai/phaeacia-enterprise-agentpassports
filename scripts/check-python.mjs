#!/usr/bin/env node
/* Controlled Python launcher and the checks that need it (adapter contract
   section 8; architecture section 11 "Python parity").

   Python is a local-check tool only, never production. This script:

     1. resolves one absolute interpreter (PASSPORT_PYTHON, else python3 on
        PATH, resolved through sys.executable) and records its path/version;
     2. writes a scratch bin/python3 that execs that interpreter with -I -B, and
        runs every Node-spawned Python child with PATH prefixed by that bin;
     3. regression 3: with PYTHONPATH pointing at a marker-writing datetime.py,
        launcher on leaves no marker, a launcher without -I leaves the marker;
     4. runs the unchanged pinned parity harness from the vendored subset
        through the launcher (expect exit 0);
     5. regression 3b: parity from a scratch copy of the runtime allowlist only
        (without the two test-only files) must fail;
     6. regression 7 on the real pin: re-import into a scratch workspace that
        holds a copy of the committed lock and of every registered derived
        file, and compare lock bytes and tree content with the repository
        (skipped with a recorded reason when the pinned source is unavailable).

   Runtime observations go to the result file, never into the lock.
   Exit 0 when every check passes, 2 otherwise. */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(REPO_ROOT, 'vendor/passport');
const LOCK = join(REPO_ROOT, 'upstream.lock.json');
const FIXTURE = join(REPO_ROOT, 'tests/native-transfer/passport/fixtures/SYNTHETIC-passport.md');
const CHILD_FLAGS = ['-I', '-B'];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function resolveInterpreter() {
  const probe = process.env.PASSPORT_PYTHON ?? 'python3';
  const path = execFileSync(probe, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  const version = execFileSync(path, ['-c', 'import sys; print(".".join(map(str, sys.version_info[:3])))'], {
    encoding: 'utf8',
  }).trim();
  return { path, version, resolved_from: process.env.PASSPORT_PYTHON ? 'PASSPORT_PYTHON' : 'python3 on PATH' };
}

function makeLauncher(dir, interpreter, flags) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, 'python3');
  writeFileSync(shim, `#!/bin/sh\nexec "${interpreter}" ${flags.join(' ')} "$@"\n`);
  chmodSync(shim, 0o755);
  return { bin, shim, PATH: `${bin}:${process.env.PATH ?? ''}` };
}

function snapshotTree(root) {
  const lines = [];
  const walk = (rel) => {
    const abs = rel ? join(root, rel) : root;
    for (const name of readdirSync(abs).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      const st = statSync(join(abs, name));
      if (st.isDirectory()) walk(childRel);
      else lines.push(`${childRel} ${sha256(readFileSync(join(abs, name)))}`);
    }
  };
  walk('');
  return lines.join('\n');
}

function run(cmd, args, env, cwd) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env, cwd, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function tail(s, n = 12) {
  return s.trim().split('\n').slice(-n);
}

function main() {
  const scratch = join(REPO_ROOT, '.scratch/check/python');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const results = { node_version: process.version, child_flags: CHILD_FLAGS, checks: {} };
  const failures = [];
  const record = (name, ok, detail) => {
    results.checks[name] = { ok, ...detail };
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
    if (!ok) failures.push(name);
  };

  const interp = resolveInterpreter();
  results.child_interpreter = interp;
  process.stdout.write(
    `interpreter ${interp.path} (${interp.version}, ${interp.resolved_from}); node ${process.version}\n`,
  );
  const launcher = makeLauncher(join(scratch, 'launcher-on'), interp.path, CHILD_FLAGS);
  const launcherOff = makeLauncher(join(scratch, 'launcher-off'), interp.path, ['-B']);
  results.launcher = { shim: launcher.shim, off_shim: launcherOff.shim, off_flags: ['-B'] };
  const which = run('sh', ['-c', 'command -v python3'], { ...process.env, PATH: launcher.PATH });
  record('launcher resolves python3 to the shim', which.stdout.trim() === launcher.shim, {
    resolved: which.stdout.trim(),
  });
  const childIdentity = run(
    'python3',
    ['-c', 'import sys; print(sys.executable); print(sys.flags.isolated, sys.flags.dont_write_bytecode)'],
    {
      ...process.env,
      PATH: launcher.PATH,
    },
  );
  const [childExe, childFlags] = childIdentity.stdout.trim().split('\n');
  record('child reports the recorded interpreter with -I -B', childExe === interp.path && childFlags === '1 1', {
    child_executable: childExe,
    isolated_and_no_bytecode_flags: childFlags,
  });

  /* Regression 3: PYTHONPATH marker on/off. */
  const markerDir = join(scratch, 'pythonpath');
  mkdirSync(markerDir, { recursive: true });
  const marker = join(scratch, 'marker.txt');
  writeFileSync(
    join(markerDir, 'datetime.py'),
    `open(${JSON.stringify(marker)}, "w").write("shadowed datetime imported\\n")\nraise SystemExit(99)\n`,
  );
  const validatePy = join(VENDOR, 'tools/validate.py');
  const spawnViaNode = (PATH, fixture = FIXTURE) =>
    run(
      process.execPath,
      [
        '-e',
        /* Propagate the child's status: without this the outer Node exit was
           recorded as the child's (critique, 2026-09-10). A signal death
           (status null) is recorded as 1. */
        `const r = require('child_process').spawnSync('python3', [${JSON.stringify(validatePy)}, ${JSON.stringify(fixture)}], { stdio: 'inherit' }); process.exitCode = r.status === null ? 1 : r.status;`,
      ],
      {
        ...process.env,
        PATH,
        PYTHONPATH: markerDir,
      },
    );
  rmSync(marker, { force: true });
  spawnViaNode(launcherOff.PATH);
  const markerOff = existsSync(marker);
  rmSync(marker, { force: true });
  const onRun = spawnViaNode(launcher.PATH);
  const markerOn = existsSync(marker);
  record('regression 3: launcher without -I lets the PYTHONPATH datetime.py execute (faulty case)', markerOff, {
    marker_present: markerOff,
  });
  record('regression 3: launcher with -I ignores PYTHONPATH (valid control)', !markerOn && onRun.code === 0, {
    marker_present: markerOn,
    validate_exit: onRun.code,
  });
  /* The recorded exit must be the Python child's, not the outer Node's: a
     child that fails without touching the marker must record a nonzero exit
     (critique, reasoned check-report defect, 2026-09-10). */
  rmSync(marker, { force: true });
  const failing = spawnViaNode(launcher.PATH, join(scratch, 'no-such-fixture.md'));
  record('regression 3: a failing Python child through the launcher records a nonzero exit', failing.code !== 0, {
    validate_exit: failing.code,
    marker_present: existsSync(marker),
  });

  /* Parity from the vendored subset through the launcher, with the marker still on PYTHONPATH. */
  rmSync(marker, { force: true });
  const parity = run(
    process.execPath,
    [join(VENDOR, 'web/tools/parity.mjs')],
    { ...process.env, PATH: launcher.PATH, PYTHONPATH: markerDir },
    REPO_ROOT,
  );
  writeFileSync(join(scratch, 'parity.log'), `${parity.stdout}\n${parity.stderr}`);
  record(
    'parity from the vendored subset through the launcher exits 0 with no marker',
    parity.code === 0 && !existsSync(marker),
    {
      exit: parity.code,
      marker_present: existsSync(marker),
      last_lines: tail(parity.stdout),
      log: join(scratch, 'parity.log'),
    },
  );

  /* Regression 3b: runtime allowlist only. */
  const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
  const runtimeOnly = join(scratch, 'runtime-only/passport');
  cpSync(VENDOR, runtimeOnly, { recursive: true });
  for (const p of lock.test_only_paths) rmSync(join(runtimeOnly, p));
  const partial = run(
    process.execPath,
    [join(runtimeOnly, 'web/tools/parity.mjs')],
    { ...process.env, PATH: launcher.PATH },
    REPO_ROOT,
  );
  writeFileSync(join(scratch, 'partial-parity.log'), `${partial.stdout}\n${partial.stderr}`);
  record('regression 3b: parity from the runtime allowlist alone fails (faulty case)', partial.code !== 0, {
    exit: partial.code,
    removed: lock.test_only_paths,
    last_lines: tail(`${partial.stdout}\n${partial.stderr}`, 6),
    log: join(scratch, 'partial-parity.log'),
  });

  /* Regression 7 on the real pin. */
  const source = process.env.PASSPORT_SOURCE ?? join(REPO_ROOT, '..', 'agent-passport');
  const archive = process.env.PASSPORT_ARCHIVE ?? null;
  const haveGit =
    !archive &&
    existsSync(source) &&
    run('git', ['-C', source, 'cat-file', '-e', `${lock.commit}^{commit}`], process.env).code === 0;
  if (haveGit || archive) {
    const ws = join(scratch, 'reimport-ws');
    mkdirSync(join(ws, 'vendor'), { recursive: true });
    writeFileSync(join(ws, 'upstream.lock.json'), readFileSync(LOCK));
    /* Every registered derived file is verified as bytes after the install
       (R3), so the scratch workspace carries a copy of each; at a003e51 the
       workspace held only the lock and the check would have refused the first
       real register entry (E1b, 2026-09-10). The copy is taken only when the
       repository path is a safe relative path whose ancestors are real
       directories and whose entry is a regular file, checked without
       following links (directory entries, not stat); the E1b critique noted
       that the earlier text claimed this while readFileSync alone follows a
       link. The importer's own derived checks on the workspace are unchanged. */
    const entryKind = (abs) => {
      const parent = dirname(abs);
      if (!existsSync(parent)) return 'missing';
      const ent = readdirSync(parent, { withFileTypes: true }).find((e) => e.name === abs.slice(parent.length + 1));
      if (!ent) return 'missing';
      if (ent.isSymbolicLink()) return 'symlink';
      if (ent.isDirectory()) return 'directory';
      return ent.isFile() ? 'file' : 'other';
    };
    for (const d of lock.derived ?? []) {
      const rel = String(d.path);
      const parts = rel.split('/');
      if (rel.startsWith('/') || rel === '' || parts.some((x) => x === '' || x === '.' || x === '..'))
        throw new Error(`unsafe derived path in lock: ${rel}`);
      for (let i = 1; i < parts.length; i++) {
        const kind = entryKind(join(REPO_ROOT, ...parts.slice(0, i)));
        if (kind !== 'directory') throw new Error(`derived path ancestor is a ${kind}, not a directory: ${rel}`);
      }
      const kind = entryKind(join(REPO_ROOT, rel));
      if (kind !== 'file') throw new Error(`derived path is a ${kind}, not a regular file: ${rel}`);
      mkdirSync(dirname(join(ws, rel)), { recursive: true });
      writeFileSync(join(ws, rel), readFileSync(join(REPO_ROOT, rel)));
    }
    const args = [join(REPO_ROOT, 'scripts/import-passport.mjs'), '--workspace', ws, '--commit', lock.commit];
    args.push(...(archive ? ['--archive', archive] : ['--source', source]));
    const re = run(process.execPath, args, process.env, REPO_ROOT);
    const sameLock = re.code === 0 && readFileSync(join(ws, 'upstream.lock.json')).equals(readFileSync(LOCK));
    const sameTree = re.code === 0 && snapshotTree(join(ws, 'vendor/passport')) === snapshotTree(VENDOR);
    record(
      'regression 7: same-pin re-import reproduces the committed lock bytes and vendor tree',
      sameLock && sameTree,
      {
        exit: re.code,
        source: archive ?? source,
        lock_sha256: sha256(readFileSync(LOCK)),
        last_lines: tail(`${re.stdout}\n${re.stderr}`, 3),
      },
    );
  } else {
    results.checks['regression 7: same-pin re-import'] = {
      ok: null,
      skipped: 'pinned source unavailable; set PASSPORT_SOURCE or PASSPORT_ARCHIVE',
    };
    process.stdout.write('SKIP regression 7: pinned source unavailable\n');
  }

  writeFileSync(join(scratch, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`check-python: results in ${join(scratch, 'results.json')}, ${failures.length} failure(s)\n`);
  return failures.length ? 2 : 0;
}

process.exitCode = main();
