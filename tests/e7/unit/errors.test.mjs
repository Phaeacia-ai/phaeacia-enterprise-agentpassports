/* The E7 codes, landed by the lead before construction (docs/e7/design.md 2.6 item 1; evidence/e7-design-corrections.md
   section 3 item 1): E_RECOVERY_HOLD exists with a sentence of its own, and E_DELIVERY_FAILED is retired, because a
   delivery failure after the written row answers 201 delivery "failed" (E7 1.1, E7D-1) and no path may answer the
   old 502 any more. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CODES, messageFor } from '../../../lib/errors.mjs';

test('E_RECOVERY_HOLD is a 409 with its own sentence, and E_DELIVERY_FAILED is retired', () => {
  assert.equal(CODES.E_RECOVERY_HOLD, 409);
  assert.equal(messageFor('E_RECOVERY_HOLD'), 'This company is held after a restore until Phaeacia has confirmed it with you.');
  assert.equal(Object.hasOwn(CODES, 'E_DELIVERY_FAILED'), false, 'retired: no path answers it after E7 1.1');
  assert.equal(CODES.E_MAIL_NOT_CONFIGURED, 503, 'kept with its meaning');
});

/* The alerts design 2.5 (slice 1): the mail event route's one refusal. A 401, so it raises no alert (E7-22 walks every
   4xx), and one sentence that says nothing about which test failed, because an unconfigured route and a forged event
   must look the same (ALD-R-F1). */
test('E_WEBHOOK_INVALID is a 401 with its own sentence', () => {
  assert.equal(CODES.E_WEBHOOK_INVALID, 401);
  assert.equal(messageFor('E_WEBHOOK_INVALID'), 'The event could not be verified.');
});
