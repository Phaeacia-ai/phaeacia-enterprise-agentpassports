/* The E6 codes, landed by the lead before construction (docs/e6/design.md 3.5 as corrected; evidence/e6-design-
   corrections.md section 4 item 3). Each of the sixteen is in lib/errors.mjs CODES with 3.5's status and has a fixed
   sentence of its own, so a lifecycle refusal never becomes 500 E_INTERNAL and never shows the fallback message. The E6
   server lane extends this file with the source tripwire E5's has (every E_ code a lifecycle module or migration can
   answer is in CODES), once those sources exist. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CODES, messageFor } from '../../../lib/errors.mjs';

const E6 = Object.freeze({
  E_ACCESS_PERIOD_ENDED: 409,
  E_SEATS_EXHAUSTED: 409,
  E_INVITATION_LIMIT: 409,
  E_OWNER_CHANGED: 409,
  E_COMPANY_CLOSED: 409,
  E_COMPANY_NOT_SUSPENDED: 409,
  E_COMPANY_NOT_CLOSED: 409,
  E_DELETION_NOT_DUE: 409,
  E_DELETE_TOO_LARGE: 409,
  E_EXPORT_TOO_LARGE: 409,
  E_OPERATOR_ACCOUNT: 409,
  E_MEMBER_ACCOUNT: 409,
  E_EXPORT_WINDOW_OPEN: 409,
  E_SUCCESSION_PENDING: 409,
  E_CONFIRMATION_MISMATCH: 422,
  E_QUOTA_OUT_OF_RANGE: 422,
});

test('the sixteen E6 codes carry design 3.5 statuses and a sentence of their own', () => {
  const fallback = messageFor('E_A_CODE_NOBODY_DECLARED');
  const sentences = new Set();
  for (const [code, status] of Object.entries(E6)) {
    assert.equal(CODES[code], status, code);
    const sentence = messageFor(code);
    assert.equal(typeof sentence, 'string', code);
    assert.notEqual(sentence, fallback, `${code} has its own sentence`);
    assert.equal(sentences.has(sentence), false, `${code} shares no sentence with another E6 code`);
    sentences.add(sentence);
  }
  assert.equal(sentences.size, 16);
});

test('the access-period sentence promises neither reading nor exporting, since the code answers a read after export_by', () => {
  assert.equal(/read|export/i.test(messageFor('E_ACCESS_PERIOD_ENDED')), false);
});
