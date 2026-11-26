/* Invitation state for display (pages design 2.3 and 4.4), pure.

   The database decides validity at acceptance, with clock_timestamp() under the company lock. This derives what the
   invitation list shows from one read at the server clock of that read, so a row shown pending one second before its
   expiry can still be refused, and the page does not claim otherwise. accepted, revoked and expired are terminal for
   the row. */

/**
 * invitationState({ acceptedAt, revokedAt, expiresAt }, now) -> 'accepted' | 'revoked' | 'expired' | 'pending'
 *   now: milliseconds since the epoch, the stateDerivedAt of the answer.
 * Precedence: accepted when acceptedAt is set; else revoked when revokedAt is set; else expired when expiresAt is at or
 * before now, and also when it does not parse, so a malformed row is never offered for revocation; else pending.
 */
export function invitationState({ acceptedAt, revokedAt, expiresAt }, now) {
  if (acceptedAt !== null && acceptedAt !== undefined) return 'accepted';
  if (revokedAt !== null && revokedAt !== undefined) return 'revoked';
  if (!(Date.parse(expiresAt) > now)) return 'expired';
  return 'pending';
}

/* The delivery the row records (E6 design 1.2.1, lane K4), pure. The stored word is the answer's own: `handover`,
   `mail`, `failed` or `unconfirmed` once the attempt recorded itself, `not_attempted` before that, and null for a row
   older than the column. A row still `not_attempted` DELIVERY_GRACE_MS after it was written was never recorded: no
   live attempt lasts that long (the transport gives up at 5 s, app_server's statements at 8 s, a synchronous Netlify
   function at 60 s), so either the attempt never ran or its record was lost, and either way nothing confirms the
   invitation reached anyone. Younger than that, it may still be running. */

/** Two minutes: twice the longest a synchronous function can run, so a row this old has no attempt still going. */
export const DELIVERY_GRACE_MS = 120_000;
export const DELIVERY_WORDS = Object.freeze(['handover', 'mail', 'failed', 'unconfirmed']);

/**
 * deliveryView({ delivery, createdAt }, now)
 *   -> 'handover' | 'mail' | 'failed' | 'unconfirmed' | 'not_recorded' | 'in_progress' | null
 *   now: milliseconds since the epoch, the stateDerivedAt of the answer.
 * A recorded word passes through. `not_attempted` is `not_recorded` when createdAt is at or before now minus the grace,
 * and also when createdAt does not parse, so a malformed row is never shown as fine; otherwise `in_progress`. Null, and
 * any word outside the vocabulary, is null: nothing is known, so nothing is said.
 */
export function deliveryView({ delivery, createdAt }, now) {
  if (DELIVERY_WORDS.includes(delivery)) return delivery;
  if (delivery !== 'not_attempted') return null;
  if (!(Date.parse(createdAt) + DELIVERY_GRACE_MS > now)) return 'not_recorded';
  return 'in_progress';
}
