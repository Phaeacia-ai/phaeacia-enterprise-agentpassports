/* The TOTP helper for the journeys (pages design section 6, J5 and J6). The code is computed from the setup key the
   page shows, as a person's authenticator would: RFC 6238 with the parameters GoTrue v2.192.0 uses (SHA-1, 30 seconds,
   six digits). The computation is the one tests/e2/helpers/pages.mjs already holds for the stack cases, reused rather
   than written a second time. The key read from the page lives in the harness's memory only; nothing logs it. */

import { totp, wrongCode } from '../e2/helpers/pages.mjs';

/** The setup key as the page groups it, with its spacing removed. */
export const keyFromPage = (shown) => String(shown).replace(/\s+/g, '');

/** A code that verifies now. When the current period ends within two seconds, waits for the next one first, so the
    code is not already stale when the page sends it. */
export async function currentCode(key) {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 2000) await new Promise((r) => setTimeout(r, left + 250));
  return totp(key);
}

/** A six-digit code no period from one before to two after accepts. */
export const refusedCode = (key) => wrongCode(key);
