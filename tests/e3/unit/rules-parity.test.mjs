/* Case 22, the corpus half (E3 design 3.6): the pinned validate.py and lib/passport/rules.mjs over every
   upstream fixture passport, compared per fixture as the multiset of (check number, line) for checks 12 to
   15. The divergence table must be empty.

   Both sides read the file the way the pinned Python does: strict UTF-8 and universal newlines, a leading
   byte-order mark kept (assemble.mjs decodeText is that reader's twin). A fixture on which Python stops at
   FAIL 1, before checks 12 to 15 exist for it, is not comparable and is listed, not counted: the JavaScript
   validate() continues past a frontmatter failure, the Python returns. Results, the interpreter and its flags
   are written to .scratch/e3/rules-parity.json. */
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { decodeText } from '../../../lib/passport/assemble.mjs';
import { CHECK_NUMBERS, formatChecks } from '../../../lib/passport/rules.mjs';
import { validate } from '../../../vendor/passport/web/lib/_validate.mjs';
import { python, pythonFindings, REPO } from './helpers.mjs';

const CORPUS = ['vendor/passport/tools/fixtures/passports', 'vendor/passport/tools/fixtures/validator'];

test('case 22: checks 12 to 15 agree with the pinned validate.py on every corpus fixture', () => {
  const rows = [];
  for (const dir of CORPUS) {
    for (const name of readdirSync(join(REPO, dir)).sort()) {
      if (!name.endsWith('.md') || name === 'README.md') continue;
      const rel = `${dir}/${name}`;
      const file = join(REPO, rel);
      const v = validate(decodeText(readFileSync(file)));
      const ours = formatChecks(v.lines, v.inside)
        .map((p) => `${CHECK_NUMBERS[p.code]}:${p.line}`)
        .sort();
      const py = pythonFindings(file);
      rows.push({ fixture: rel, python: py.findings, enterprise: ours, fail1: py.fail1 });
    }
  }
  const comparable = rows.filter((r) => !r.fail1);
  const divergences = comparable.filter((r) => JSON.stringify(r.python) !== JSON.stringify(r.enterprise));
  const excluded = rows.filter((r) => r.fail1).map((r) => r.fixture);
  const findingsByCheck = {};
  for (const r of comparable) for (const f of r.python) findingsByCheck[f.split(':')[0]] = (findingsByCheck[f.split(':')[0]] ?? 0) + 1;

  mkdirSync(join(REPO, '.scratch/e3'), { recursive: true });
  writeFileSync(
    join(REPO, '.scratch/e3/rules-parity.json'),
    `${JSON.stringify({ interpreter: python(), fixtures: rows.length, comparable: comparable.length, excluded, findingsByCheck, divergences, rows }, null, 2)}\n`,
  );

  assert.ok(rows.length >= 127, `corpus has ${rows.length} fixtures`);
  assert.deepEqual(divergences, [], 'divergence table');
  for (const check of ['12', '13', '14', '15']) assert.ok(findingsByCheck[check] > 0, `the corpus exercises check ${check}`);
  assert.ok(excluded.length < rows.length / 4, `excluded ${excluded.length}`);
});
