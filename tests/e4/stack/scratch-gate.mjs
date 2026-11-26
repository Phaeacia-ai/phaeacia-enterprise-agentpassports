/* Case 22's scratch gate (E4 design section 5): lib/passport/gate.mjs unchanged, except that while
   globalThis.E4_SCRATCH_DERIVE is true a passing verdict's derived record carries one more field, as a gate whose
   derive() adds a field would produce. tests/e4/stack/replay.test.mjs substitutes it for lib/passport/gate.mjs through a
   module resolution hook; this file's own import of the real gate is the one import the hook leaves alone. */
import { createHash } from 'node:crypto';

import { canonical } from '../../../lib/passport/canonical.mjs';
import { gate as buildGate } from '../../../lib/passport/gate.mjs';

export function gate(bytes, contentType, options) {
  const verdict = buildGate(bytes, contentType, options);
  if (globalThis.E4_SCRATCH_DERIVE !== true || !verdict.ok) return verdict;
  const derivedCanonical = canonical({ ...JSON.parse(verdict.derivedCanonical), scratch_field: true });
  return {
    ...verdict,
    derivedCanonical,
    derivedSha256: createHash('sha256').update(derivedCanonical, 'utf8').digest('hex'),
  };
}
