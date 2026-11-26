#!/usr/bin/env node
/* Where C8's sync actually spends its time (docs/e7/design.md section 6 C8).
 *
 *   node tests/e7/measure/c8-append-cost.mjs --label <label>
 *
 * C8 measures "the sync's full read of the epoch's lifecycle acts, timed, with its query plan, because it scans
 * the audit table by action above the floor". Measured, the READ is 37.6 ms over 100,205 rows and the whole
 * `register.mjs sync` is 46,111 ms, so the read is not where the time goes. This probe is what says where.
 *
 * `appendMany` calls `append` once per line, and `append` reads the whole register file and verifies the whole
 * chain before every single line. Writing n lines therefore hashes on the order of n²/2 lines. That is a shape,
 * not an opinion, so it is measured at three sizes and the growth is recorded beside the times.
 *
 * Nothing here touches the stack or the database: it is the module against a file under os.tmpdir().
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { append, fileStore, init as initRegister } from '../../../lib/operator/register.mjs';
import { record } from './helpers.mjs';

const i = process.argv.indexOf('--label');
const label = i > 0 ? process.argv[i + 1] : null;
if (label === null || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(label)) {
  process.stderr.write('usage: node tests/e7/measure/c8-append-cost.mjs --label LABEL\n');
  process.exit(2);
}

const OPERATOR = '00000000-0000-4000-8000-0000000000aa';
const SIZES = [500, 1000, 2000, 4000];
const scratch = mkdtempSync(join(tmpdir(), 'e7-append-'));
const rows = [];

for (const n of SIZES) {
  const path = join(scratch, `r-${n}.jsonl`);
  const store = fileStore(path);
  initRegister(store);
  const t0 = process.hrtime.bigint();
  for (let k = 1; k <= n; k++) {
    append(store, 'factor.delete', {
      userId: `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`,
      factorId: `00000000-0000-4000-9000-${String(k).padStart(12, '0')}`,
      actor: OPERATOR,
      ref: `measure:${label}/${k}`,
    });
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  rows.push({ lines: n, totalMs: Number(ms.toFixed(1)), perLineMs: Number((ms / n).toFixed(3)) });
  process.stdout.write(`${n} lines through append(): ${ms.toFixed(1)} ms, ${(ms / n).toFixed(3)} ms per line\n`);
}

/* The growth, stated as the ratio the shape predicts. Doubling n doubles the work per line under a linear
   append and doubles the TOTAL under a quadratic one, so it is the per-line time that tells them apart. */
const growth = rows.slice(1).map((r, k) => ({
  from: rows[k].lines,
  to: r.lines,
  totalRatio: Number((r.totalMs / rows[k].totalMs).toFixed(2)),
  perLineRatio: Number((r.perLineMs / rows[k].perLineMs).toFixed(2)),
}));

record('C8-append-cost', {
  condition:
    "lines written one at a time through lib/operator/register.mjs's own append(), which is what appendMany and therefore the sync does, against a register under os.tmpdir()",
  numbers: {
    perSize: rows,
    growth,
    readMsFromC8: 37.6,
    syncMsFromC8: 46111,
    syncLinesFromC8: 5201,
  },
  seed: { label, commands: ['none: this probe touches no database'] },
  command: 'node tests/e7/measure/c8-append-cost.mjs',
  notes: [
    'append() reads the whole file and verifies the whole chain before each line, so n lines cost about n squared over two line-hashes. A per-line time that DOUBLES when n doubles is that shape; a flat per-line time would be linear.',
    'What it costs in practice: a weekly sync writes a handful of lines and this is nothing. A catch-up sync, and the sync at a recovery, write thousands, and that is where the 46 s of C8 went: its read was 37.6 ms.',
  ],
});
rmSync(scratch, { recursive: true, force: true });
