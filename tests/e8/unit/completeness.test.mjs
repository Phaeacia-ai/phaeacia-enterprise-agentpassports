/* E8W-F1 (evidence/e8-export-withholdings.md): completeness() walked lib/operator/takeout.mjs's own SECTION_NAMES and
   never read the snapshot's keys, so a section dropped from the module's list (E7-10's mutant) was never asked about
   and scripts/export-company.mjs exited 0 with a register line and an audit row claiming a complete copy. The check
   now names any section the snapshot counted that the document does not carry. Fail-before: on the module at 77fd5e0
   the first case below answers ok. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { completeness, SECTION_NAMES } from '../../../lib/operator/takeout.mjs';

const counts = (over = {}) => Object.fromEntries(SECTION_NAMES.map((n) => [n, over[n] ?? 3]));

test('E8W-F1: a section the snapshot counted and the document did not write is a problem named by section', () => {
  const snapshot = { ...counts(), installation_witnesses: 2, dropped_by_a_mutant: 5 };
  const written = counts();
  const r = completeness(written, snapshot);
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.problems.filter((p) => p.section === 'dropped_by_a_mutant'),
    [{ section: 'dropped_by_a_mutant', rule: 'the snapshot counted a section this document does not carry' }],
  );
  /* The same shape as the mutant: the document's list lacks a real section, the snapshot has it. */
  const missing = { ...written };
  delete missing.installation_witnesses;
  const r2 = completeness(missing, counts({ installation_witnesses: 2 }));
  assert.equal(r2.ok, false);
  assert.ok(r2.problems.some((p) => p.section === 'installation_witnesses'), JSON.stringify(r2.problems));
});

test('control: a complete document against its own snapshot is ok, and a count difference is named', () => {
  assert.deepEqual(completeness(counts(), counts()), { ok: true, problems: [] });
  const r = completeness(counts({ agents: 4 }), counts({ agents: 5 }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, [{ section: 'agents', rule: 'the written count is not the snapshot’s', wrote: 4, expected: 5 }]);
});
