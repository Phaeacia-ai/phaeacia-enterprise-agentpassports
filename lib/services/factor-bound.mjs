/* HB-F2: the per-account bound on wrong second-factor codes through the product's route (migration 012; design
   evidence/ena7-end1-hbf2.md sections 3 and 5; evidence/hosted-blockers.md 5.1).

   The route POST /api/auth/factors/{id}/verify calls beginVerification before it sends the code to GoTrue and
   endVerification after GoTrue answered. The database holds the rule: five wrong codes in fifteen minutes per account,
   each attempt counted BEFORE GoTrue sees it, settled by its own reservation exactly once. This module only carries the
   two calls under the caller's own server token, because lib/http/ may not reach lib/db/ (scripts/check-imports.mjs).

   What it answers, and why:
     beginVerification   { attemptId } when the attempt may go on. Refused: AppError E_MFA_ATTEMPTS_EXHAUSTED (429)
                         with retryAfter, the window's end as an ISO time, for the page to show. The database not
                         answering: AppError E_MFA_UNAVAILABLE (503), and the route then makes no GoTrue call, which
                         fails closed.
     endVerification     { ok } and never a throw: the answer the person is owed is already decided, and a lost end
                         leaves the attempt counted, which fails closed. Bounded by END_BOUND_MS, so a slow database
                         cannot hold back the 204 that carries the aal2 cookies (HB-C7).

   GoTrue's own challenge and verify endpoints are not bounded here: a holder of the person's access token and the
   publishable key reaches them directly (residual R3, Raffael's decision with the Team plan). */

import { callAs } from '../db/server.mjs';
import { AppError } from '../errors.mjs';

/** How long the route waits for the end before it answers anyway. */
export const END_BOUND_MS = 1500;

/** The three outcomes the end records, from lib/auth/factors.mjs verifyTotp's `judged`. */
export const OUTCOMES = Object.freeze(['valid', 'invalid', 'undecided']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * beginVerification(session, options) -> { attemptId }
 * Throws AppError E_MFA_ATTEMPTS_EXHAUSTED (with { retryAfter }) or E_MFA_UNAVAILABLE.
 */
export async function beginVerification(session, options) {
  let row;
  try {
    [row] = await callAs(session, 'mfa_verify_begin', {}, options);
  } catch {
    throw new AppError('E_MFA_UNAVAILABLE');
  }
  if (row?.allowed === true && typeof row.attempt_id === 'string' && UUID.test(row.attempt_id))
    return { attemptId: row.attempt_id };
  if (row?.allowed === false) {
    const at = new Date(row.retry_after ?? Number.NaN);
    throw new AppError(
      'E_MFA_ATTEMPTS_EXHAUSTED',
      undefined,
      Number.isFinite(at.getTime()) ? { retryAfter: at.toISOString() } : undefined,
    );
  }
  throw new AppError('E_MFA_UNAVAILABLE');
}

/**
 * endVerification(session, attemptId, outcome, options) -> Promise<{ ok: boolean }>
 * Never throws. An outcome outside OUTCOMES is not sent: the database would refuse it, and the attempt stays counted.
 */
export async function endVerification(session, attemptId, outcome, options) {
  if (!OUTCOMES.includes(outcome) || typeof attemptId !== 'string') return { ok: false };
  /* Inside a then, so a throw before callAs's first await (its token is minted synchronously) is an answer too and
     never escapes this function (HBF2-R-I1). The timer is armed after. */
  const sent = Promise.resolve()
    .then(() => callAs(session, 'mfa_verify_end', { p_attempt: attemptId, p_outcome: outcome }, options))
    .then(
      () => ({ ok: true }),
      () => ({ ok: false }),
    );
  let timer;
  const bound = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), END_BOUND_MS);
  });
  try {
    return await Promise.race([sent, bound]);
  } finally {
    clearTimeout(timer);
  }
}
