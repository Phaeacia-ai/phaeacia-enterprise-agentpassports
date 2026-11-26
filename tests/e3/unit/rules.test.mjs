/* Case 22, the refusal and control pairs of design 3.2 through the real gate, each also run through the pinned
   validate.py so the enterprise code and the Python FAIL number agree per case and per line. The corpus half
   of case 22 is rules-parity.test.mjs. Python runs as scripts/check-python.mjs runs it: an absolute
   interpreter with -I -B. If Python cannot run, these tests fail; a skipped parity check is not a pass. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { gate } from '../../../lib/passport/gate.mjs';
import { CHECK_NUMBERS, DELTA_PHRASES, formatChecks, PUBLIC_ROUTES } from '../../../lib/passport/rules.mjs';
import { validate } from '../../../vendor/passport/web/lib/_validate.mjs';
import { linesEqual, pythonFindings, REPO, SYNTHETIC, VALIDATED_AT, variant } from './helpers.mjs';

const dir = mkdtempSync(join(tmpdir(), 'e3-rules-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const ACCESS = '    access: open\n';
const CHECK = '  - check: Every supplied identifier appears once in ascending order\n';
const STATE = 'state:\n  keeps: the record count\n  granularity: per run\n  why: the change line needs it\n  confidence: low\n';
const ENTRY_END = '    confidence: high\nprocessing:\n';

/* [label, replacements, expected [code, exact line text, occurrence index]] */
const CASES = [
  ['check 12: access credentialed with no binding', [[ACCESS, '    access: credentialed\n']], [['E_BINDING', '    access: credentialed']]],
  ['check 12 control: the binding names a slot that exists', [[ACCESS, '    access: credentialed\n    binding: delivery_target\n']], []],
  ['check 12: binding none names no slot', [[ACCESS, '    access: credentialed\n    binding: none\n']], [['E_BINDING', '    binding: none']]],
  ['check 12: binding ~ names no slot', [[ACCESS, '    access: credentialed\n    binding: "~"\n']], [['E_BINDING', '    binding: "~"']]],
  ['check 12: binding names a slot that does not exist', [[ACCESS, '    access: credentialed\n    binding: missing_slot\n']], [['E_BINDING', '    binding: missing_slot']]],
  ['check 12: a binding on an open input still has to name a slot', [[ACCESS, `${ACCESS}    binding: nobody\n`]], [['E_BINDING', '    binding: nobody']]],
  ['check 15: access nonsense', [[ACCESS, '    access: nonsense\n']], [['E_ACCESS', '    access: nonsense']]],
  ['check 15: a dangling access with only a comment', [[ACCESS, '    access:  # open | credentialed\n']], [['E_ACCESS', '    access:  # open | credentialed']]],
  ['check 15: a dangling access with nothing', [[ACCESS, '    access:\n']], [['E_ACCESS', '    access:']]],
  [
    'checks 15 and 12: Credentialed is refused as a spelling and still demands its binding',
    [[ACCESS, '    access: Credentialed\n']],
    [['E_ACCESS', '    access: Credentialed'], ['E_BINDING', '    access: Credentialed']],
  ],
  ['check 15 control: a quoted credentialed with its binding is one value', [[ACCESS, "    access: 'credentialed'\n    binding: delivery_target\n"]], []],
  ['check 14: fidelity sortof', [[ACCESS, `${ACCESS}    fidelity: sortof\n`]], [['E_FIDELITY', '    fidelity: sortof']]],
  ['check 14 control: fidelity exact', [[ACCESS, `${ACCESS}    fidelity: exact\n`]], []],
  ['check 14 control: fidelity lossy', [[ACCESS, `${ACCESS}    fidelity: lossy\n`]], []],
  ['check 13: a previous-run comparison with no state block', [[CHECK, '  - check: The record count is down vs prev\n']], [['E_STATE_REQUIRED', '  - check: The record count is down vs prev']]],
  ['check 13: punctuation collapses before matching', [[CHECK, '  - check: Shows the week-over-week delta\n']], [['E_STATE_REQUIRED', '  - check: Shows the week-over-week delta']]],
  [
    'check 13 control: the same check with a state block carrying keeps',
    [
      [CHECK, '  - check: The record count is down vs prev\n'],
      ['processing:\n', `${STATE}processing:\n`],
    ],
    [],
  ],
  ['check 13 control: a phrase introduced by "headed" names a section, not a comparison', [[CHECK, '  - check: The section headed Week over week appears exactly once\n']], []],
  ['check 13 control: "since yesterday" is a date window, not a delta phrase', [[CHECK, '  - check: Every item is dated since yesterday\n']], []],
  ['block-scalar content is prose: a note quoting access: credentialed is not a field', [[ACCESS, `${ACCESS}    note: |\n      access: credentialed\n`]], []],
  [
    'two entries with identical fidelity lines report each line, which the kept-line recovery must get right',
    [[ENTRY_END, `    fidelity: sortof\n    confidence: high\n  - what: a second pasted list\n    access: open\n    fidelity: sortof\n    confidence: high\nprocessing:\n`]],
    [['E_FIDELITY', '    fidelity: sortof', 0], ['E_FIDELITY', '    fidelity: sortof', 1]],
  ],
  ['known hole, inherited: a flow-style credentialed entry escapes checks 12 and 15 on both sides', [[ACCESS, `${ACCESS}  - {what: a login, access: credentialed}\n`]], []],
];

let n = 0;
for (const [label, pairs, expected] of CASES) {
  test(`case 22: ${label}`, () => {
    const text = variant(pairs);
    const problems = expected.map(([code, line, i = 0]) => ({ code, line: linesEqual(text, line)[i] }));
    const g = gate(Buffer.from(text, 'utf8'), 'text/markdown', { validatedAt: VALIDATED_AT });
    if (problems.length === 0) assert.equal(g.ok, true, JSON.stringify(g.problems));
    else assert.deepEqual(JSON.parse(JSON.stringify(g.problems)), problems);

    const file = join(dir, `case-${n++}.md`);
    writeFileSync(file, text);
    const py = pythonFindings(file);
    assert.equal(py.fail1, false);
    const ours = problems.map((p) => `${CHECK_NUMBERS[p.code]}:${p.line}`).sort();
    assert.deepEqual(py.findings, ours, 'the pinned validate.py agrees per check and per line');
  });
}

test('case 22 control: the unchanged SYNTHETIC fixture has no finding on either side', () => {
  const v = validate(SYNTHETIC);
  assert.deepEqual(formatChecks(v.lines, v.inside), []);
  const file = join(dir, 'synthetic.md');
  writeFileSync(file, SYNTHETIC);
  assert.deepEqual(pythonFindings(file), { status: 0, fail1: false, findings: [] });
});

test('DELTA_PHRASES is the pinned Python list, entry for entry and in order', () => {
  const src = readFileSync(join(REPO, 'vendor/passport/tools/validate.py'), 'utf8');
  const start = src.indexOf('\nDELTA_PHRASES = [');
  const end = src.indexOf('\n]', start);
  assert.ok(start > 0 && end > start);
  const body = src
    .slice(start, end)
    .split('\n')
    .map((l) => l.replace(/#.*$/, ''))
    .join('\n');
  assert.deepEqual([...DELTA_PHRASES], [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]));
});

test('PUBLIC_ROUTES is the E0 local_policy.py tuple, entry for entry and in order', () => {
  const src = readFileSync(join(REPO, 'tests/native-transfer/passport/local_policy.py'), 'utf8');
  const start = src.indexOf('PUBLIC_ROUTES = (');
  const end = src.indexOf(')', start);
  assert.deepEqual([...PUBLIC_ROUTES], [...src.slice(start, end).matchAll(/'([^']*)'/g)].map((m) => m[1]));
});
