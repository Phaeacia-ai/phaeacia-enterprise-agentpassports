#!/usr/bin/env node
/* Pinned Passport import and verification for the enterprise adapter.

   Contract: docs/e1/passport-adapter.md sections 3, 3a, 3b and 4.

   Two modes that share no write path:

     --verify   reads upstream.lock.json and the live vendor/passport/ tree and
                writes nothing anywhere. Exit 0 when the tree matches the lock,
                2 on any difference or residual state, listing each.

     (default)  imports the pinned upstream archive into vendor/passport/ and
                writes upstream.lock.json, journaled so an interrupted run is
                recoverable by the next run. Exit 0 on a verified result, 2 on
                refusal, 70 on a test-injected interruption.

   Node standard library only. Nothing from the imported tree is ever executed. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PIN = Object.freeze({
  commit: 'd42a1722c7d0d458b2693879f6a50e582786a1ae',
  tree: 'a3c10e3ee5e67c51c843a516fb5c962fba3f23f5',
  archive_sha256: '1fd58c548e10f09629e23e88c0ef3c82ce1b37093db12a5d35af4906b280fb4a',
});

/* A local Agent Passport checkout that contains the pinned commit: PASSPORT_SOURCE, else a sibling directory named
   agent-passport beside this repository. */
export const DEFAULT_SOURCE =
  process.env.PASSPORT_SOURCE ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent-passport');

/* Allowlist (contract section 4). A pattern ending in "/**" matches every
   regular file below that directory; any other pattern is an exact path. The
   imported map is derived from the files actually staged, never from these
   patterns. */
export const ALLOWLIST = Object.freeze({
  runtime: Object.freeze(
    [
      'LICENSE',
      'NOTICE',
      'publish/LICENSE-MAP.md',
      'spec/**',
      'installer/**',
      'verification/judge-prompt.md',
      'examples/daily-brief-passport.md',
      'tools/validate.py',
      'tools/preflight.py',
      'tools/scrub.py',
      'tools/run_tests.sh',
      'tools/fixtures/**',
      'scripts/assemble.py',
      'web/lib/_validate.mjs',
      'web/lib/_derive.mjs',
      'web/lib/_sections.mjs',
      'web/lib/_render.mjs',
      'web/tools/parity.mjs',
      'web/assets/tokens.css',
      'web/assets/base.css',
      'web/assets/app.css',
      'web/assets/recipient.css',
      'web/assets/fonts/**',
      'web/assets/mark/**',
    ].sort(),
  ),
  test_only: Object.freeze(['scripts/passport-to-page.py', 'web/lib/_metrics.mjs'].sort()),
});

const UPSTREAM = 'github.com/Phaeacia-ai/agent-passport (private); local read-only checkout';
const NOTES = 'Files under vendor/ are byte-exact upstream content and are never edited.';

export const OWNED = Object.freeze({
  lock: 'upstream.lock.json',
  live: 'vendor/passport',
  staging: 'vendor/.passport.staging',
  stagedLock: 'vendor/.passport.staging.lock.json',
  previous: 'vendor/.passport.previous',
  savedLock: 'vendor/.passport.previous.lock.json',
  journal: 'vendor/.passport.journal.json',
});

export const FAIL_POINTS = Object.freeze([
  'journal',
  'saved-lock',
  'staging',
  'staged-lock',
  'previous-rename',
  'live-rename',
  'lock-rename',
  'verify',
  'previous-cleanup',
  'saved-lock-cleanup',
  'recovery-live-to-staging',
  'recovery-previous-restore',
  'recovery-lock-restore',
]);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

class Refusal extends Error {
  constructor(problems) {
    super(problems.map((p) => `${p.kind}: ${p.path}`).join('\n'));
    this.problems = problems;
  }
}

class Interrupted extends Error {
  constructor(point) {
    super(`test interruption after ${point}`);
    this.point = point;
  }
}

/* ---------- small helpers ---------- */

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}

function kindOf(st) {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  if (st.isFile()) return 'file';
  if (st.isFIFO()) return 'fifo';
  if (st.isSocket()) return 'socket';
  if (st.isCharacterDevice()) return 'character device';
  if (st.isBlockDevice()) return 'block device';
  return 'unknown';
}

/* A relative path is safe when it is non-empty, relative, uses forward
   slashes, and has no empty, "." or ".." segment. */
export function isSafeRelative(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  const parts = p.split('/');
  return parts.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

export function properAncestors(p) {
  const out = [];
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

export function matchesAllowlist(path, patterns) {
  for (const pat of patterns) {
    if (pat.endsWith('/**')) {
      if (path.startsWith(pat.slice(0, -2))) return true;
    } else if (path === pat) return true;
  }
  return false;
}

/* ---------- deterministic lock serialization (contract section 4) ---------- */

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

export function serializeLock(lock) {
  const ordered = sortDeep(lock);
  if (Array.isArray(ordered.derived)) {
    ordered.derived = [...ordered.derived].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  if (ordered.allowlist) {
    for (const k of Object.keys(ordered.allowlist)) ordered.allowlist[k] = [...ordered.allowlist[k]].sort();
  }
  if (Array.isArray(ordered.test_only_paths)) ordered.test_only_paths = [...ordered.test_only_paths].sort();
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/* ---------- tar parsing at the extraction boundary (contract section 3 step 2) ---------- */

function octal(buf) {
  if (buf[0] & 0x80) {
    let n = 0;
    for (let i = 1; i < buf.length; i++) n = n * 256 + buf[i];
    return n;
  }
  const s = buf.toString('ascii').replace(/\0.*$/s, '').trim();
  return s.length ? Number.parseInt(s, 8) : 0;
}

function cstr(buf) {
  const end = buf.indexOf(0);
  return (end === -1 ? buf : buf.subarray(0, end)).toString('utf8');
}

function parsePax(buf) {
  const out = {};
  let pos = 0;
  while (pos < buf.length) {
    const sp = buf.indexOf(0x20, pos);
    if (sp === -1) break;
    const len = Number.parseInt(buf.subarray(pos, sp).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = buf.subarray(sp + 1, pos + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

const TAR_KIND = {
  0: 'file',
  '\0': 'file',
  1: 'hard link',
  2: 'symlink',
  3: 'character device',
  4: 'block device',
  5: 'directory',
  6: 'fifo',
  7: 'contiguous file',
};

/* Returns { files: Map<path, {sha256, bytes}>, directories: Set<path> } or
   throws Refusal naming every entry that is not a regular file or directory,
   before anything is written. */
export function inventoryArchive(tar) {
  const files = new Map();
  const directories = new Set();
  const problems = [];
  let pos = 0;
  let pending = {};
  while (pos + 512 <= tar.length) {
    const header = tar.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) break;
    const type = String.fromCharCode(header[156]);
    const size = octal(header.subarray(124, 136));
    const dataStart = pos + 512;
    const dataEnd = dataStart + size;
    const padded = dataStart + Math.ceil(size / 512) * 512;
    if (dataEnd > tar.length)
      throw new Refusal([{ kind: 'truncated archive entry', path: cstr(header.subarray(0, 100)) }]);
    const data = tar.subarray(dataStart, dataEnd);
    if (type === 'x') {
      pending = { ...pending, ...parsePax(data) };
      pos = padded;
      continue;
    }
    if (type === 'g') {
      pos = padded;
      continue;
    }
    if (type === 'L') {
      pending.path = cstr(data);
      pos = padded;
      continue;
    }
    if (type === 'K') {
      pending.linkpath = cstr(data);
      pos = padded;
      continue;
    }
    let name = cstr(header.subarray(0, 100));
    const magic = header.subarray(257, 263).toString('ascii');
    const prefix = magic.startsWith('ustar') ? cstr(header.subarray(345, 500)) : '';
    if (prefix) name = `${prefix}/${name}`;
    if (pending.path !== undefined) name = pending.path;
    pending = {};
    const kind = TAR_KIND[type] ?? `unknown type ${JSON.stringify(type)}`;
    if (kind === 'directory') {
      const dir = name.replace(/\/+$/, '');
      if (dir.length && !isSafeRelative(dir)) problems.push({ kind: 'unsafe archive path', path: name });
      else if (dir.length) directories.add(dir);
    } else if (kind === 'file') {
      if (!isSafeRelative(name)) problems.push({ kind: 'unsafe archive path', path: name });
      else if (files.has(name)) problems.push({ kind: 'duplicate archive entry', path: name });
      else files.set(name, { sha256: sha256(data), bytes: Buffer.from(data) });
    } else {
      problems.push({ kind: `refused archive entry kind ${kind}`, path: name });
    }
    pos = padded;
  }
  if (problems.length) throw new Refusal(problems);
  return { files, directories };
}

/* ---------- verification (R1, R3, lock consistency) ---------- */

export function verifyTree(root, imported) {
  const problems = [];
  const rootStat = lstatOrNull(root);
  if (!rootStat) return [{ kind: 'missing root', path: root }];
  if (rootStat.isSymbolicLink()) return [{ kind: 'symlink at root', path: root }];
  if (!rootStat.isDirectory()) return [{ kind: `root is a ${kindOf(rootStat)}`, path: root }];
  const allowedDirs = new Set();
  for (const p of Object.keys(imported)) for (const a of properAncestors(p)) allowedDirs.add(a);
  const seen = new Set();
  const walk = (rel) => {
    const abs = rel ? join(root, rel) : root;
    for (const name of readdirSync(abs).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(abs, name));
      if (st.isSymbolicLink()) problems.push({ kind: 'symlink', path: childRel });
      else if (st.isDirectory()) {
        if (allowedDirs.has(childRel)) walk(childRel);
        else problems.push({ kind: 'unexpected directory', path: childRel });
      } else if (st.isFile()) {
        /* A regular file with more than one link is an alias of an inode
           outside the importer's control: identical bytes now, any bytes
           later (critique R1 limit, 2026-09-10). */
        if (st.nlink > 1) problems.push({ kind: `hard link (${st.nlink} links)`, path: childRel });
        else if (Object.hasOwn(imported, childRel)) {
          seen.add(childRel);
          const actual = sha256File(join(abs, name));
          if (actual !== imported[childRel]) problems.push({ kind: 'changed file', path: childRel });
        } else problems.push({ kind: 'unexpected file', path: childRel });
      } else problems.push({ kind: `unexpected ${kindOf(st)}`, path: childRel });
    }
  };
  walk('');
  for (const p of Object.keys(imported).sort()) if (!seen.has(p)) problems.push({ kind: 'missing file', path: p });
  return problems;
}

function confinedRegularFile(workspace, rel) {
  if (!isSafeRelative(rel)) return { ok: false, kind: 'unsafe derived path' };
  for (const a of properAncestors(rel)) {
    const st = lstatOrNull(join(workspace, a));
    if (!st) return { ok: false, kind: 'missing derived path ancestor' };
    if (st.isSymbolicLink()) return { ok: false, kind: 'symlink in derived path' };
    if (!st.isDirectory()) return { ok: false, kind: 'derived path ancestor is not a directory' };
  }
  const st = lstatOrNull(join(workspace, rel));
  if (!st) return { ok: false, kind: 'missing derived file' };
  if (st.isSymbolicLink()) return { ok: false, kind: 'symlink at derived path' };
  if (!st.isFile()) return { ok: false, kind: `derived path is a ${kindOf(st)}` };
  return { ok: true };
}

export function lockProblems(lock) {
  const problems = [];
  const bad = (kind, path) => problems.push({ kind, path });
  if (!lock || typeof lock !== 'object') return [{ kind: 'lock is not an object', path: OWNED.lock }];
  if (lock.status !== 'COMPLETE') bad('lock status is not COMPLETE', OWNED.lock);
  for (const key of [
    'commit',
    'archive_sha256',
    'imported',
    'source_inventory',
    'test_only_paths',
    'derived',
    'allowlist',
  ]) {
    if (!(key in lock)) bad(`lock missing field ${key}`, OWNED.lock);
  }
  const imported = lock.imported ?? {};
  for (const p of Object.keys(imported)) {
    if (!isSafeRelative(p)) bad('unsafe imported path', p);
    if (!/^[0-9a-f]{64}$/.test(String(imported[p]))) bad('imported hash is not a SHA-256', p);
  }
  if (lock.imported_count !== Object.keys(imported).length) bad('imported_count disagrees with imported', OWNED.lock);
  const inv = lock.source_inventory ?? {};
  if (lock.source_inventory_count !== Object.keys(inv).length)
    bad('source_inventory_count disagrees with source_inventory', OWNED.lock);
  for (const p of lock.test_only_paths ?? []) if (!Object.hasOwn(imported, p)) bad('test_only path not imported', p);
  for (const d of lock.derived ?? []) {
    if (!d || typeof d !== 'object') bad('derived entry is not an object', OWNED.lock);
    else {
      if (!isSafeRelative(String(d.path))) bad('unsafe derived path', String(d.path));
      if (!Object.hasOwn(imported, d.from)) bad('derived source not imported', String(d.from));
      else if (imported[d.from] !== d.from_sha256) bad('derived source hash changed', String(d.path));
      if (!/^[0-9a-f]{64}$/.test(String(d.derived_sha256))) bad('derived_sha256 is not a SHA-256', String(d.path));
    }
  }
  return problems;
}

export function verifyDerived(workspace, lock) {
  const problems = [];
  for (const d of lock.derived ?? []) {
    const c = confinedRegularFile(workspace, String(d.path));
    if (!c.ok) {
      problems.push({ kind: c.kind, path: String(d.path) });
      continue;
    }
    if (sha256File(join(workspace, d.path)) !== d.derived_sha256)
      problems.push({ kind: 'derived file changed', path: String(d.path) });
  }
  return problems;
}

export function residuals(workspace) {
  return ['journal', 'staging', 'stagedLock', 'previous', 'savedLock']
    .filter((k) => lstatOrNull(join(workspace, OWNED[k])) !== null)
    .map((k) => ({ kind: 'residual import state', path: OWNED[k] }));
}

function readLock(workspace) {
  const path = join(workspace, OWNED.lock);
  const st = lstatOrNull(path);
  if (!st) return { lock: null, problems: [{ kind: 'missing lock', path: OWNED.lock }] };
  if (!st.isFile()) return { lock: null, problems: [{ kind: `lock is a ${kindOf(st)}`, path: OWNED.lock }] };
  try {
    return { lock: JSON.parse(readFileSync(path, 'utf8')), problems: [] };
  } catch (e) {
    return { lock: null, problems: [{ kind: `lock is not valid JSON (${e.message})`, path: OWNED.lock }] };
  }
}

/* The complete verify-mode check. Reads only. */
export function verifyWorkspace(workspace) {
  const problems = [...residuals(workspace), ...liveAncestorProblems(workspace)];
  const { lock, problems: lp } = readLock(workspace);
  problems.push(...lp);
  if (!lock) return problems;
  problems.push(...lockProblems(lock));
  problems.push(...verifyTree(join(workspace, OWNED.live), lock.imported ?? {}));
  problems.push(...verifyDerived(workspace, lock));
  return problems;
}

/* The proper ancestors of the live tree inside the workspace (vendor/) must be
   real directories: a symlink there relocates the whole tree while every
   descendant check still passes (critique R1 limit, 2026-09-10). */
function liveAncestorProblems(workspace) {
  const problems = [];
  for (const a of properAncestors(OWNED.live)) {
    const st = lstatOrNull(join(workspace, a));
    if (!st) continue;
    if (st.isSymbolicLink()) problems.push({ kind: 'symlink at an ancestor of the live tree', path: a });
    else if (!st.isDirectory()) problems.push({ kind: `ancestor of the live tree is a ${kindOf(st)}`, path: a });
  }
  return problems;
}

/* Verify a live pair while owned residuals may still exist (used during
   install and recovery, where residuals are expected). */
function verifyPairIgnoringResiduals(workspace) {
  const { lock, problems } = readLock(workspace);
  if (!lock) return problems;
  return [
    ...liveAncestorProblems(workspace),
    ...lockProblems(lock),
    ...verifyTree(join(workspace, OWNED.live), lock.imported ?? {}),
    ...verifyDerived(workspace, lock),
  ];
}

/* ---------- import ---------- */

function obtainArchive(opts) {
  if (opts.archive) return readFileSync(opts.archive);
  const commit = opts.commit;
  execFileSync('git', ['-C', opts.source, 'cat-file', '-e', `${commit}^{commit}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return execFileSync('git', ['-C', opts.source, 'archive', '--format=tar', commit], { maxBuffer: 256 * 1024 * 1024 });
}

function gitTree(opts) {
  if (opts.archive) return null;
  return execFileSync('git', ['-C', opts.source, 'rev-parse', `${opts.commit}^{tree}`], { encoding: 'utf8' }).trim();
}

function writeAtomic(path, bytes) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

function readJournal(workspace) {
  const p = join(workspace, OWNED.journal);
  if (!lstatOrNull(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeJournal(workspace, journal) {
  writeAtomic(join(workspace, OWNED.journal), `${JSON.stringify(sortDeep(journal), null, 2)}\n`);
}

function failPoint(opts, point) {
  if (opts.failAfter === point) throw new Interrupted(point);
}

function hashIfExists(path) {
  return lstatOrNull(path) ? sha256File(path) : null;
}

/* Journal phases, in the order the importer writes them. Each phase names the
   step that is about to run (or is running), so that after an interruption the
   next run knows which single rename may or may not have happened and inspects
   the owned paths only for that step. Renames are atomic, so each step is
   either done or not done; the lock restore uses an atomic write for the same
   reason. */
export const PHASES = Object.freeze([
  'init', // journal written; the saved-lock copy has not started
  'saved-lock', // the accepted lock is being copied to the saved-lock path
  'staging', // staging tree being written
  'staged', // staged lock written; staged tree being verified
  'previous-rename', // live -> previous
  'live-rename', // staging -> live
  'lock-rename', // staged lock -> lock
  'verify', // new pair live; verifying
  'cleanup', // new pair verified; removing previous and saved lock
  'rollback-live-to-staging', // new pair failed; live -> staging
  'rollback-previous-restore', // previous -> live
  'rollback-lock-restore', // saved lock -> lock (or remove the new lock on a first import)
  'rollback-discard', // accepted pair back in place; discarding the owned stage
]);

const ROLLBACK_STEPS = ['live-to-staging', 'previous-restore', 'lock-restore', 'discard'];

/* Restore the accepted pair after the new pair failed verification, or resume
   that restore after an interruption. `from` names the first step that may
   still be pending; earlier steps are known complete from the journal phase.
   Every rename is journaled before it happens and is guarded by the observed
   state, so running this again from the recorded phase converges. Throws
   Refusal, deleting nothing, when the observed state contradicts the phase. */
function rollback(workspace, journal, opts, log, from, refuse) {
  const P = (k) => join(workspace, OWNED[k]);
  const has = (k) => lstatOrNull(P(k)) !== null;
  const old = journal.old_lock_sha256 ?? null;
  const fresh = journal.new_lock_sha256 ?? null;
  const start = ROLLBACK_STEPS.indexOf(from);
  const pending = (step) => ROLLBACK_STEPS.indexOf(step) >= start;

  if (pending('live-to-staging')) {
    journal.phase = 'rollback-live-to-staging';
    writeJournal(workspace, journal);
    if (has('live')) {
      if (has('staging')) refuse('both a live tree and a staging tree exist while the new tree is being moved aside');
      log('rollback: moving the failed new tree aside');
      renameSync(P('live'), P('staging'));
    }
    failPoint(opts, 'recovery-live-to-staging');
  }
  if (pending('previous-restore') && journal.old_tree_present) {
    journal.phase = 'rollback-previous-restore';
    writeJournal(workspace, journal);
    if (has('previous')) {
      if (has('live')) refuse('both a previous tree and a live tree exist while the accepted tree is being restored');
      log('rollback: restoring the accepted tree');
      renameSync(P('previous'), P('live'));
    } else if (!has('live')) refuse('the accepted tree is missing and no previous tree exists');
    failPoint(opts, 'recovery-previous-restore');
  }
  if (pending('lock-restore')) {
    journal.phase = 'rollback-lock-restore';
    writeJournal(workspace, journal);
    const lockHash = hashIfExists(P('lock'));
    if (old === null) {
      if (lockHash !== null) {
        if (lockHash !== fresh) refuse('the live lock matches neither the accepted nor the new identity');
        log('rollback: removing the new lock of a failed first import');
        rmSync(P('lock'), { force: true });
      }
    } else if (lockHash !== old) {
      if (hashIfExists(P('savedLock')) !== old)
        refuse('the saved lock does not match the accepted lock identity recorded at start');
      log('rollback: restoring the accepted lock');
      writeAtomic(P('lock'), readFileSync(P('savedLock')));
    }
    failPoint(opts, 'recovery-lock-restore');
  }
  journal.phase = 'rollback-discard';
  writeJournal(workspace, journal);
  /* The accepted pair is back in place by identity (lock hash, renamed tree),
     so the owned stage is discarded whether or not that pair verifies; a
     failing accepted pair is a pre-existing workspace problem that the caller
     reports and verify mode keeps visible. */
  const problems = old === null ? [] : verifyPairIgnoringResiduals(workspace);
  log(
    problems.length
      ? `rollback: accepted pair restored but does not verify (${problems.length} problems)`
      : 'rollback: accepted pair verified',
  );
  discardOwnedStage(workspace, log);
  return problems;
}

/* Recovery by the table in contract section 3b, driven by the journal's
   recorded phase. Ends in the clean state (no journal, no residual) or throws
   Refusal without deleting anything. */
function recover(workspace, opts, log) {
  const journal = readJournal(workspace);
  const res = residuals(workspace).filter((r) => r.path !== OWNED.journal);
  if (!journal) {
    if (res.length)
      throw new Refusal([
        { kind: 'residual state without a journal; identity cannot be established', path: OWNED.live },
        ...res,
      ]);
    return;
  }
  const P = (k) => join(workspace, OWNED[k]);
  const has = (k) => lstatOrNull(P(k)) !== null;
  const old = journal.old_lock_sha256 ?? null;
  const fresh = journal.new_lock_sha256 ?? null;
  const phase = String(journal.phase);
  const lockHash = hashIfExists(P('lock'));
  const savedHash = hashIfExists(P('savedLock'));
  const refuse = (why) => {
    throw new Refusal([{ kind: `recovery refused: ${why}`, path: OWNED.journal }, ...res]);
  };

  /* Identity checks that hold in every phase. */
  if (!PHASES.includes(phase)) refuse(`unknown journal phase ${JSON.stringify(journal.phase)}`);
  const lockIsOld = (old === null && lockHash === null) || (old !== null && lockHash === old);
  const lockIsNew = fresh !== null && lockHash === fresh;
  if (!lockIsOld && !lockIsNew) refuse('the live lock matches neither the accepted nor the new identity');
  if (savedHash !== null && savedHash !== old) {
    if (old === null) refuse('a saved lock exists but no accepted pair was recorded at start');
    refuse('the saved lock does not match the accepted lock identity recorded at start');
  }
  log(`recovery: journal phase ${phase}`);

  const restoredButFailing = (problems) => {
    if (!problems.length) return;
    throw new Refusal([
      { kind: 'recovery: accepted pair restored but does not verify', path: OWNED.live },
      ...problems,
    ]);
  };
  const acceptedInPlace = () => {
    const problems = old === null ? [] : verifyPairIgnoringResiduals(workspace);
    discardOwnedStage(workspace, log);
    restoredButFailing(problems);
  };
  const resume = (from) => restoredButFailing(rollback(workspace, journal, opts, log, from, refuse));
  const newPairLive = () => {
    if (!lockIsNew) refuse(`phase ${phase} recorded but the live lock is not the new identity`);
    log('recovery: live lock has the new identity; verifying the installed pair');
    const problems = verifyPairIgnoringResiduals(workspace);
    if (!problems.length) {
      journal.phase = 'cleanup';
      writeJournal(workspace, journal);
      finishCleanup(workspace, opts, log);
      return;
    }
    log(`recovery: installed pair does not verify (${problems.length} problems); restoring the accepted pair`);
    resume('live-to-staging');
  };

  switch (phase) {
    case 'init':
    case 'saved-lock':
    case 'staging':
    case 'staged':
      if (!lockIsOld) refuse(`phase ${phase} recorded but the live lock is not the accepted identity`);
      if (has('previous')) refuse(`phase ${phase} recorded but a previous tree exists`);
      if (journal.old_tree_present ? !has('live') : has('live'))
        refuse(`phase ${phase} recorded but the live tree does not match the recorded start state`);
      acceptedInPlace();
      return;
    case 'previous-rename':
      if (!lockIsOld) refuse('phase previous-rename recorded but the live lock is not the accepted identity');
      if (has('staging') && has('live') && has('previous')) refuse('previous, live and staging trees all exist');
      if (has('previous')) {
        /* The rename happened; the new tree is still in staging. */
        resume('previous-restore');
      } else {
        if (!has('live')) refuse('the accepted tree is missing and no previous tree exists');
        acceptedInPlace();
      }
      return;
    case 'live-rename':
      if (!lockIsOld) refuse('phase live-rename recorded but the live lock is not the accepted identity');
      if (has('live') && has('staging')) refuse('both a live tree and a staging tree exist after the live rename');
      if (has('live')) {
        /* The rename happened; live holds the new tree. */
        log('recovery: swap interrupted before the lock rename; moving the incomplete live tree aside');
        resume('live-to-staging');
      } else resume('previous-restore');
      return;
    case 'lock-rename':
      if (lockIsNew) {
        newPairLive();
        return;
      }
      /* The lock rename did not happen; the trees are already swapped. */
      log('recovery: swap interrupted before the lock rename; moving the incomplete live tree aside');
      resume('live-to-staging');
      return;
    case 'verify':
    case 'cleanup':
      newPairLive();
      return;
    case 'rollback-live-to-staging':
      resume('live-to-staging');
      return;
    case 'rollback-previous-restore':
      resume('previous-restore');
      return;
    case 'rollback-lock-restore':
      resume('lock-restore');
      return;
    case 'rollback-discard':
      resume('discard');
      return;
    default:
      refuse(`unknown journal phase ${JSON.stringify(journal.phase)}`);
  }
}

function discardOwnedStage(workspace, log) {
  const P = (k) => join(workspace, OWNED[k]);
  if (lstatOrNull(P('staging'))) {
    log('recovery: discarding the owned incomplete staging tree');
    rmSync(P('staging'), { recursive: true, force: true });
  }
  rmSync(P('stagedLock'), { force: true });
  rmSync(P('savedLock'), { force: true });
  rmSync(P('journal'), { force: true });
}

function finishCleanup(workspace, opts, log) {
  const P = (k) => join(workspace, OWNED[k]);
  log('cleanup: removing the previous tree and saved lock');
  rmSync(P('previous'), { recursive: true, force: true });
  failPoint(opts, 'previous-cleanup');
  rmSync(P('savedLock'), { force: true });
  failPoint(opts, 'saved-lock-cleanup');
  rmSync(P('stagedLock'), { force: true });
  rmSync(P('journal'), { force: true });
}

function stageFiles(stagingRoot, files, allowed) {
  const imported = {};
  const families = {};
  for (const [path, entry] of files) {
    if (!allowed(path)) continue;
    const abs = join(stagingRoot, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, entry.bytes, { mode: 0o644 });
    imported[path] = sha256File(abs);
    const family = path.includes('/') ? path.split('/').slice(0, 2).join('/') : path;
    families[family] = (families[family] ?? 0) + 1;
  }
  return { imported, families };
}

/* The reviewed re-derivation input (contract section 9, critique M1). A JSON
   array of complete derived entries; each replaces the register entry with
   the same path or is added. Every field is checked against the new archive
   before anything is written; the derived bytes themselves are checked by the
   post-install verification, which restores the accepted pair on mismatch.
   The accepted lock is never hand-edited. */
const DERIVED_FIELDS = ['path', 'from', 'from_sha256', 'derived_sha256', 'reviewed_by', 'on'];

function applyProposedDerivations(register, opts, files) {
  if (!opts.acceptDerived) return register;
  let proposed;
  try {
    proposed = JSON.parse(readFileSync(opts.acceptDerived, 'utf8'));
  } catch (e) {
    throw new Refusal([{ kind: `proposed derivations are not valid JSON (${e.message})`, path: opts.acceptDerived }]);
  }
  if (!Array.isArray(proposed) || !proposed.length)
    throw new Refusal([{ kind: 'proposed derivations must be a non-empty array', path: opts.acceptDerived }]);
  const problems = [];
  const out = [...register];
  for (const entry of proposed) {
    const path = String(entry?.path ?? '');
    for (const f of DERIVED_FIELDS) {
      if (typeof entry?.[f] !== 'string' || !entry[f].length)
        problems.push({ kind: `proposed derivation missing field ${f}`, path });
    }
    if (problems.length) continue;
    if (!isSafeRelative(path)) problems.push({ kind: 'proposed derivation path is not a safe relative path', path });
    if (!/^[0-9a-f]{64}$/.test(entry.derived_sha256))
      problems.push({ kind: 'proposed derived_sha256 is not a SHA-256', path });
    const allowed =
      matchesAllowlist(entry.from, ALLOWLIST.runtime) || matchesAllowlist(entry.from, ALLOWLIST.test_only);
    if (!files.has(entry.from) || !allowed)
      problems.push({ kind: 'proposed derivation source is not an imported path of the new pin', path });
    else if (files.get(entry.from).sha256 !== entry.from_sha256)
      problems.push({ kind: 'proposed derivation source hash does not match the new pin', path });
    if (problems.length) continue;
    const clean = {};
    for (const f of DERIVED_FIELDS) clean[f] = entry[f];
    const at = out.findIndex((d) => d.path === path);
    if (at === -1) out.push(clean);
    else out[at] = clean;
  }
  if (problems.length) throw new Refusal(problems);
  return out;
}

export function importPassport(opts, log = () => {}) {
  const workspace = opts.workspace;
  const P = (k) => join(workspace, OWNED[k]);
  recover(workspace, opts, log);

  const { lock: oldLock, problems: oldLockProblems } = readLock(workspace);
  const oldLockExists = lstatOrNull(P('lock')) !== null;
  if (oldLockExists && !oldLock) throw new Refusal(oldLockProblems);
  if (!oldLock && lstatOrNull(P('live'))) {
    throw new Refusal([
      { kind: 'vendor tree exists without a lock; identity cannot be established', path: OWNED.live },
    ]);
  }
  if (!oldLock && !opts.update)
    throw new Refusal([{ kind: 'no lock; first import requires --update --commit', path: OWNED.lock }]);
  if (oldLock && !opts.update && oldLock.commit !== opts.commit) {
    throw new Refusal([
      {
        kind: `commit ${opts.commit} differs from the lock's ${oldLock.commit}; use --update to move the pin`,
        path: OWNED.lock,
      },
    ]);
  }

  const tar = obtainArchive(opts);
  const archiveHash = sha256(tar);
  log(`archive ${archiveHash} (${tar.length} bytes)`);
  if (!opts.update && archiveHash !== oldLock.archive_sha256) {
    throw new Refusal([
      { kind: `archive SHA-256 ${archiveHash} does not equal the lock's ${oldLock.archive_sha256}`, path: OWNED.lock },
    ]);
  }
  const tree = gitTree(opts);
  if (!opts.update && tree && oldLock.tree && tree !== oldLock.tree) {
    throw new Refusal([{ kind: `tree ${tree} does not equal the lock's ${oldLock.tree}`, path: OWNED.lock }]);
  }

  const { files } = inventoryArchive(tar);
  const sourceInventory = {};
  for (const p of [...files.keys()].sort()) sourceInventory[p] = files.get(p).sha256;
  log(`source inventory: ${files.size} regular files`);
  if (!opts.update) {
    const problems = [];
    const expected = oldLock.source_inventory ?? {};
    for (const p of Object.keys(expected)) {
      if (!files.has(p)) problems.push({ kind: 'missing from archive', path: p });
      else if (files.get(p).sha256 !== expected[p]) problems.push({ kind: 'changed in archive', path: p });
    }
    for (const p of files.keys()) if (!Object.hasOwn(expected, p)) problems.push({ kind: 'added in archive', path: p });
    if (problems.length) throw new Refusal(problems);
  }

  const derived = applyProposedDerivations(oldLock?.derived ? structuredClone(oldLock.derived) : [], opts, files);
  for (const d of derived) {
    if (!files.has(d.from) || files.get(d.from).sha256 !== d.from_sha256) {
      throw new Refusal([
        {
          kind:
            'derived source changed in the new pin; re-derivation is an explicit reviewed change: ' +
            'supply the reviewed entry through --accept-derived <json file> (contract section 9)',
          path: String(d.path),
        },
      ]);
    }
  }

  /* Journal before the first fallible step that a check reads, including the
     saved-lock copy: at c0ed5a2 the copy preceded the journal, so an
     interruption between them left a residual the next run could only refuse
     (critique H1). The journal is now the first owned write. */
  const oldTreePresent = lstatOrNull(P('live')) !== null;
  mkdirSync(dirname(P('live')), { recursive: true });
  const journal = {
    archive_sha256: archiveHash,
    commit: opts.commit,
    new_lock_sha256: null,
    old_lock_sha256: oldLock ? sha256File(P('lock')) : null,
    old_tree_present: oldTreePresent,
    phase: 'init',
  };
  writeJournal(workspace, journal);
  failPoint(opts, 'journal');
  if (oldLock) {
    journal.phase = 'saved-lock';
    writeJournal(workspace, journal);
    writeAtomic(P('savedLock'), readFileSync(P('lock')));
  }
  failPoint(opts, 'saved-lock');
  journal.phase = 'staging';
  writeJournal(workspace, journal);

  const allowed = (p) => matchesAllowlist(p, ALLOWLIST.runtime) || matchesAllowlist(p, ALLOWLIST.test_only);
  const { imported, families } = stageFiles(P('staging'), files, allowed);
  failPoint(opts, 'staging');
  const missingTestOnly = ALLOWLIST.test_only.filter((p) => !Object.hasOwn(imported, p));
  if (missingTestOnly.length) {
    rmSync(P('staging'), { recursive: true, force: true });
    discardOwnedStage(workspace, log);
    throw new Refusal(missingTestOnly.map((p) => ({ kind: 'test-only path absent from the archive', path: p })));
  }

  const newLock = {
    allowlist: { runtime: [...ALLOWLIST.runtime], test_only: [...ALLOWLIST.test_only] },
    archive_sha256: archiveHash,
    commit: opts.commit,
    derived,
    imported,
    imported_count: Object.keys(imported).length,
    notes: oldLock?.notes ?? NOTES,
    source_inventory: sourceInventory,
    source_inventory_count: Object.keys(sourceInventory).length,
    status: 'COMPLETE',
    test_only_paths: [...ALLOWLIST.test_only],
    tree: tree ?? (opts.update ? null : (oldLock.tree ?? null)),
    upstream: oldLock?.upstream ?? UPSTREAM,
  };
  const lockBytes = Buffer.from(serializeLock(newLock), 'utf8');
  writeAtomic(P('stagedLock'), lockBytes);
  journal.new_lock_sha256 = sha256(lockBytes);
  journal.phase = 'staged';
  writeJournal(workspace, journal);
  failPoint(opts, 'staged-lock');

  const stagedProblems = [...lockProblems(newLock), ...verifyTree(P('staging'), imported)];
  if (stagedProblems.length) {
    discardOwnedStage(workspace, log);
    throw new Refusal([
      { kind: 'staged tree does not verify against the new lock', path: OWNED.staging },
      ...stagedProblems,
    ]);
  }
  log(`staged ${newLock.imported_count} files`);
  for (const f of Object.keys(families).sort()) log(`  ${f}: ${families[f]}`);

  if (oldTreePresent) {
    journal.phase = 'previous-rename';
    writeJournal(workspace, journal);
    renameSync(P('live'), P('previous'));
    failPoint(opts, 'previous-rename');
  }
  journal.phase = 'live-rename';
  writeJournal(workspace, journal);
  mkdirSync(dirname(P('live')), { recursive: true });
  renameSync(P('staging'), P('live'));
  failPoint(opts, 'live-rename');
  journal.phase = 'lock-rename';
  writeJournal(workspace, journal);
  renameSync(P('stagedLock'), P('lock'));
  failPoint(opts, 'lock-rename');

  if (opts.testCorruptAfterInstall) {
    writeFileSync(join(P('live'), opts.testCorruptAfterInstall), Buffer.from([0x0a]), { flag: 'a' });
  }
  journal.phase = 'verify';
  writeJournal(workspace, journal);
  const problems = verifyPairIgnoringResiduals(workspace);
  failPoint(opts, 'verify');
  if (problems.length) {
    log(`installed pair does not verify (${problems.length} problems); restoring the accepted pair`);
    /* The same journaled, resumable rollback that recovery uses (critique H1). */
    const refuse = (why) => {
      throw new Refusal([{ kind: `rollback refused: ${why}`, path: OWNED.journal }, ...problems]);
    };
    const restored = rollback(workspace, journal, opts, log, 'live-to-staging', refuse);
    throw new Refusal([
      { kind: 'new pair failed verification; accepted pair restored', path: OWNED.live },
      ...problems,
      ...(restored.length ? [{ kind: 'restored accepted pair does not verify', path: OWNED.live }, ...restored] : []),
    ]);
  }
  journal.phase = 'cleanup';
  writeJournal(workspace, journal);
  finishCleanup(workspace, opts, log);
  return {
    imported_count: newLock.imported_count,
    families,
    lock_sha256: sha256(lockBytes),
    archive_sha256: archiveHash,
  };
}

/* ---------- CLI ---------- */

function usage() {
  return [
    'usage: node scripts/import-passport.mjs [--verify] [--source <git checkout>] [--archive <tar>]',
    '         [--commit <sha>] [--update] [--workspace <dir>]',
    '',
    '  --verify     compare vendor/passport and upstream.lock.json; write nothing',
    '  --source     git checkout to read by commit id (default: the public read-only checkout)',
    '  --archive    a tar file used instead of --source (tests and fixtures)',
    "  --commit     upstream commit id (default: the committed lock's commit, else the bootstrap PIN)",
    '  --update     accept a different archive/inventory and record it in the lock',
    '  --accept-derived <json>  reviewed derived entries (path, from, from_sha256, derived_sha256,',
    '               reviewed_by, on) that replace or extend the derived register; contract section 9',
    '  --workspace  workspace root (default: this repository); test hooks need a non-default workspace',
  ].join('\n');
}

/* The default commit is the committed lock's, so that after a pin move later
   runs need no --commit; the hardcoded PIN is only the bootstrap for a
   workspace without a readable lock (critique M1). */
export function defaultCommit(workspace) {
  const { lock } = readLock(workspace);
  const c = lock?.commit;
  return typeof c === 'string' && /^[0-9a-f]{40}$/.test(c) ? c : PIN.commit;
}

export function parseArgs(argv) {
  const opts = {
    verify: false,
    update: false,
    source: DEFAULT_SOURCE,
    archive: null,
    commit: null,
    workspace: REPO_ROOT,
    failAfter: null,
    testCorruptAfterInstall: null,
    acceptDerived: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--verify') opts.verify = true;
    else if (a === '--update') opts.update = true;
    else if (a === '--source') opts.source = resolve(next());
    else if (a === '--archive') opts.archive = resolve(next());
    else if (a === '--commit') opts.commit = next();
    else if (a === '--workspace') opts.workspace = resolve(next());
    else if (a === '--fail-after') opts.failAfter = next();
    else if (a === '--test-corrupt-after-install') opts.testCorruptAfterInstall = next();
    else if (a === '--accept-derived') opts.acceptDerived = resolve(next());
    else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (opts.commit === null) opts.commit = defaultCommit(opts.workspace);
  if (!/^[0-9a-f]{40}$/.test(opts.commit)) throw new Error('--commit must be a 40-character hex commit id');
  if (opts.failAfter && !FAIL_POINTS.includes(opts.failAfter))
    throw new Error(`--fail-after must be one of ${FAIL_POINTS.join(', ')}`);
  if ((opts.failAfter || opts.testCorruptAfterInstall) && opts.workspace === REPO_ROOT) {
    throw new Error('test hooks are refused in the repository workspace');
  }
  if (opts.testCorruptAfterInstall && !isSafeRelative(opts.testCorruptAfterInstall))
    throw new Error('--test-corrupt-after-install needs a safe relative path');
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n${usage()}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const log = (line) => process.stdout.write(`${line}\n`);
  if (opts.verify) {
    const problems = verifyWorkspace(opts.workspace);
    if (problems.length) {
      for (const p of problems) process.stdout.write(`REFUSE ${p.kind}: ${p.path}\n`);
      process.stdout.write(`verify: ${problems.length} problem(s)\n`);
      return 2;
    }
    const { lock } = readLock(opts.workspace);
    process.stdout.write(
      `verify: OK, ${lock.imported_count} imported files at ${lock.commit}, lock ${sha256File(join(opts.workspace, OWNED.lock))}\n`,
    );
    return 0;
  }
  try {
    const result = importPassport(opts, log);
    process.stdout.write(`import: OK, ${result.imported_count} imported files, lock ${result.lock_sha256}\n`);
    return 0;
  } catch (e) {
    if (e instanceof Interrupted) {
      process.stdout.write(`INTERRUPTED after ${e.point}\n`);
      return 70;
    }
    if (e instanceof Refusal) {
      for (const p of e.problems) process.stdout.write(`REFUSE ${p.kind}: ${p.path}\n`);
      process.stdout.write(`import: refused, ${e.problems.length} problem(s)\n`);
      return 2;
    }
    process.stderr.write(`import: error: ${e.stack ?? e.message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
