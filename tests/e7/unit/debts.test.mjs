/* The lead's payments of the E7 mail milestone's debts that have no harness of their own (evidence/e7-mail-critique.md;
   evidence/e1-lead.md "The E7 mail milestone accepted at 7e68c6d"). E7M-C-F2 is in tests/e6/unit/services.test.mjs,
   beside the four-path harness; E7M-C-F5 is in tests/e2/unit/pages-factors.test.mjs, beside the GoTrue double.

   Each check names the mutant that fails it: F4 fails on lib/rules/lifecycle.mjs at 7e68c6d, whose NEXT table has no
   `held` row; F6 fails on web/assets/app/pages/members.mjs at 7e68c6d, which labels `createdAt` "Sent". */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { COMPANY_STATUSES, isCompanyStatus, nextStatuses } from '../../../lib/rules/lifecycle.mjs';

const MEMBERS_PAGE = new URL('../../../web/assets/app/pages/members.mjs', import.meta.url);

test('E7M-C-F4: every company status answers nextStatuses with a frozen array, held with an empty one', () => {
  assert.equal(isCompanyStatus('held'), true);
  assert.deepEqual(nextStatuses('held'), []);
  for (const status of COMPANY_STATUSES) {
    const next = nextStatuses(status);
    assert.ok(Array.isArray(next), `${status}: an array, never undefined`);
    assert.ok(Object.isFrozen(next), `${status}: frozen`);
    for (const to of next) assert.ok(isCompanyStatus(to), `${status} -> ${to} is in the vocabulary`);
  }
  assert.deepEqual(nextStatuses('closed'), [], 'closed stays terminal');
  assert.deepEqual(nextStatuses('junk'), []);
});

test('E7M-C-F6: the invitation card labels createdAt Created, and nothing on the members page says Sent', () => {
  const source = readFileSync(MEMBERS_PAGE, 'utf8');
  assert.match(source, /dateLine\(' · Created ', invitation\.createdAt\)/, 'the stored timestamp is when the row was written');
  assert.doesNotMatch(source, /['"] · Sent |>Sent</, 'no stored delivery receipt backs a Sent label');
});
