/* Shared fixtures for the E3 unit tests. No stack. Every invisible or control character is built from its
   code point, never typed (evidence/e3-prereq-2-6.md, lesson 3). */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const VALIDATED_AT = '2026-09-12T08:00:00.000Z';
export const SYNTHETIC_PATH = join(REPO, 'tests/native-transfer/passport/fixtures/SYNTHETIC-passport.md');
export const SYNTHETIC = readFileSync(SYNTHETIC_PATH, 'utf8');
export const VALIDATE_PY = join(REPO, 'vendor/passport/tools/validate.py');

export const cp = (...points) => String.fromCodePoint(...points);
export const CR = cp(0x0d);

/** The synthetic fixture with each [from, to] replaced once; a `from` the fixture lacks is a test defect. */
export function variant(pairs, base = SYNTHETIC) {
  let text = base;
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(`variant: ${JSON.stringify(from)} is not in the text`);
    text = text.replace(from, to);
  }
  return text;
}

/** 1-based numbers of the lines exactly equal to `line`. */
export function linesEqual(text, line) {
  const out = [];
  text.split('\n').forEach((l, i) => {
    if (l === line) out.push(i + 1);
  });
  if (out.length === 0) throw new Error(`linesEqual: no line ${JSON.stringify(line)}`);
  return out;
}

/** 1-based number of the line holding the first occurrence of `needle`. */
export function lineOf(text, needle) {
  const at = text.indexOf(needle);
  if (at === -1) throw new Error(`lineOf: ${JSON.stringify(needle)} is not in the text`);
  return text.slice(0, at).split('\n').length;
}

/* The interpreter and flags of the controlled launcher (scripts/check-python.mjs): an absolute interpreter,
   run with -I -B. Resolved once through sys.executable, as that script resolves it. */
let interpreter = null;
export function python() {
  if (interpreter) return interpreter;
  const name = process.env.PASSPORT_PYTHON ?? 'python3';
  const r = spawnSync(name, ['-I', '-B', '-c', 'import sys; print(sys.executable); print(sys.version.split()[0])'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`python: ${name} did not run (a skipped parity check is not a pass)`);
  const [path, version] = r.stdout.trim().split('\n');
  interpreter = { path, version, flags: ['-I', '-B'] };
  return interpreter;
}

/** The pinned validate.py over one file: { status, fail1, findings } where findings are "12:35" strings for
    FAIL 12 to 15, sorted, and fail1 says Python stopped at check 1 before checks 12 to 15 could run. */
export function pythonFindings(file) {
  const py = python();
  const r = spawnSync(py.path, [...py.flags, VALIDATE_PY, file], { encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) throw new Error(`validate.py exited ${r.status}: ${r.stderr}`);
  const lines = r.stdout.split('\n');
  const findings = [];
  for (const l of lines) {
    const m = /^FAIL (1[2-5]): line (\d+):/.exec(l);
    if (m) findings.push(`${m[1]}:${m[2]}`);
  }
  return { status: r.status, fail1: lines.some((l) => l.startsWith('FAIL 1:')), findings: findings.sort() };
}
