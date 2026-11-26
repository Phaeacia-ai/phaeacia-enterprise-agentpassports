/* Shared helpers for the E7 section 6 measurements (docs/e7/design.md section 6, day 7).
 *
 * WHAT THIS DIRECTORY IS, AND WHAT IT IS NOT. These are measurement scripts, not gates.
 * `scripts/check.sh` does not run them and nothing here asserts a target: design section 6 says
 * "none a claim until measured", and every number is RECORDED with the seed that produced it, the
 * machine's load average at the time and the exact command. A measurement that asserted a bound
 * would turn a number into a promise, which is the one thing section 6 refuses to do.
 *
 * Each script writes one JSON record and one human-readable line per measurement under
 * evidence/e7-docs-repro/measurements/. The seed is recorded in two parts, because a number is
 * only reproducible with both: the reseed (`bash tests/db/00-seed.sh`) and the fixture command with
 * its --label, which is what makes the fixture's content deterministic.
 *
 * THE STACK. Every script here reseeds through tests/db/00-seed.sh and nothing else, runs alone, and
 * reseeds after any fixture that leaves large companies behind. None of them calls `supabase stop`,
 * `start` or `db reset`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';

import { ROOT, stackEnv } from '../../e2/helpers/stack.mjs';

export { ROOT };
export const OUT_DIR = join(ROOT, 'evidence', 'e7-docs-repro', 'measurements');

/** The owner connection, exactly as an operator's own command would be (design 1.2). Never printed. */
export function ownerPsql() {
  const { dbContainer } = stackEnv();
  return `docker exec -i ${dbContainer} psql -U postgres -X -At`;
}

/** One statement over the owner connection; returns trimmed stdout. Throws with psql's exit status only. */
export function owner(sqlText, { timeoutMs = 600_000 } = {}) {
  const { dbContainer } = stackEnv();
  const r = spawnSync('docker', ['exec', '-i', dbContainer, 'psql', '-U', 'postgres', '-X', '-At', '-v', 'ON_ERROR_STOP=1'], {
    input: sqlText,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (r.status !== 0) throw new Error(`owner psql exited ${r.status}: ${(r.stderr ?? '').slice(0, 400)}`);
  return (r.stdout ?? '').trim();
}

/* psql under -At prints a command tag for a data-modifying statement ("INSERT 0 1") as well as its RETURNING
   row, so a read that expects one value takes the first line that is not a tag. */
const TAG = /^(INSERT|UPDATE|DELETE|MERGE|COPY|CREATE|ALTER|DROP|TRUNCATE|BEGIN|COMMIT|ROLLBACK|SET|DO|NOTIFY|GRANT|REVOKE|ANALYZE|VACUUM)\b/;
export function ownerValue(sqlText, opts) {
  const lines = owner(sqlText, opts)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !TAG.test(l));
  return lines[0] ?? '';
}

/** The same, timed: returns { rows, ms }. */
export function ownerTimed(sqlText, opts) {
  const t0 = process.hrtime.bigint();
  const rows = owner(sqlText, opts);
  return { rows, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

/** Run a command and sample the child's RSS while it runs: the peak is measured, not reported by the child. */
export function runSampled(cmd, args, { env = {}, cwd = ROOT, sampleMs = 100, timeoutMs = 1_800_000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    let peakRssBytes = 0;
    let samples = 0;
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setInterval(() => {
      const r = spawnSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' });
      const kib = Number.parseInt((r.stdout ?? '').trim(), 10);
      if (Number.isFinite(kib)) {
        peakRssBytes = Math.max(peakRssBytes, kib * 1024);
        samples += 1;
      }
    }, sampleMs);
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearInterval(timer);
      clearTimeout(kill);
      reject(e);
    });
    child.on('close', (status) => {
      clearInterval(timer);
      clearTimeout(kill);
      /* A process that exits inside one sample interval is never sampled, and 0 bytes would be a false
         number: an unsampled peak is null and the record says so. */
      resolve({
        status,
        stdout,
        stderr,
        peakRssBytes: samples === 0 ? null : peakRssBytes,
        samples,
        durationMs: Date.now() - started,
      });
    });
  });
}

/** The JSON lines a script printed, by event name. */
export function events(stdout, name) {
  return stdout
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e !== null && (name === undefined || e.event === name));
}

/** One measurement record. `seed` is the fixture label AND the commands that produced it. */
export function record(id, { condition, numbers, seed, command, notes = [] }) {
  mkdirSync(OUT_DIR, { recursive: true });
  const row = {
    id,
    at: new Date().toISOString(),
    condition,
    numbers,
    seed,
    command,
    loadAverage: loadavg().map((n) => Number(n.toFixed(2))),
    notes,
  };
  writeFileSync(join(OUT_DIR, `${id}.json`), `${JSON.stringify(row, null, 2)}\n`);
  const line = `${row.at}  ${id}  ${condition}  ${JSON.stringify(numbers)}  seed=${seed.label}  load=${row.loadAverage.join(',')}\n`;
  appendFileSync(join(OUT_DIR, 'index.txt'), line);
  process.stdout.write(line);
  return row;
}

/** Reseed through the one permitted path. Nothing here ever runs `supabase db reset`. */
export function reseedStack() {
  const r = spawnSync('bash', ['tests/db/00-seed.sh'], { cwd: ROOT, encoding: 'utf8', env: process.env });
  if (r.status !== 0) throw new Error(`00-seed.sh exited ${r.status}: ${(r.stderr ?? '').slice(0, 400)}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
