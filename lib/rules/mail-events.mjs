/* Mail event and check-in rules, pure (docs/e7/alerts-and-checkin-design.md 1.3, 1.4, 1.8 and 2.2). No IO, no client,
   no environment, no clock of its own: every function here is a function of its arguments, so a service, a unit case
   and slice 2's contact routing all read the same words.

   WHAT IS HERE.
     CAUSES, ROUTED_TO        the two alert vocabularies of design 1.2, whole; lib/http/alerts.mjs's allowlist reads
                              them from here, so a cause classify() can produce is always one the allowlist admits.
     classify(event)          design 1.3's table: the event's type, its bounce type and (ALD-R-F3) its bounce subtype
                              to a cause, or null for a type this product does not subscribe to.
     decide(event)            what a verified event is for, in slice 1 (design section 7): an operator alert with its
                              cause and the company id from the tag, a stderr line about an operator mail, or nothing.
     isWebhookSecret(value)   the signing secret's form (design 2.4), the ONE predicate the route, the check-in's
                              "Bounce routing" line and slice 2's routing.bounces all read.
     checkinPeriod(nowMs)     the parity rule, the period and the idempotency key of design 1.8.

   THE SUBTYPE RULE (ALD-R-F3). Only a Permanent bounce whose subtype is General is `recipient_permanent`, the one cause
   that says "the address is wrong". The provider's own example of email.bounced is Permanent with subtype Suppressed
   (evidence/alerts-design-repro/resend-webhook-email-bounced.txt), which is the team's suppression list and may hold a
   right address, so it is `suppressed`, as email.suppressed is. NoEmail, "It was not possible to retrieve the
   recipient email address from the bounce message" (resend-bounce-types.txt), any other subtype and none at all are
   `undetermined`. The bounced page's field list says Temporary where the bounce-types page says Transient; only
   Transient is `recipient_temporary`, and Temporary falls to `undetermined`, operator only either way.

   THE KIND IS NAMESPACED (ALD-R-F15's fallback, Raffael's decision of 2026-09-21 relayed by the lead): the enterprise
   product shares a Resend team with his other senders, so every kind this product sets carries the prefix
   `enterprise-` (KINDS below), and decide() classifies only events whose kind is one of those. An event of another
   sender in the same team, whose kind is `invitation` or anything else without the prefix, is verified (the webhook's
   secret is the team's endpoint's) and then ignored: it must never raise an enterprise alert.

   SLICE 1 (design section 7). Kind `enterprise-contact` is an unknown kind here, because nothing sends a contact mail
   until slice 2, so decide() ignores it; a mail of kind `enterprise-alert` or `enterprise-checkin` is never answered
   with a mail (1.6's loop bound). Nothing here reads data.to, the subject, the sender or any provider text: decide()
   reads the type, the bounce type and subtype, and the two tags `kind` and `company`, and returns only fixed words and
   a uuid. */

export const CAUSES = Object.freeze([
  'recipient_permanent',
  'recipient_temporary',
  'suppressed',
  'undetermined',
  'contact_address',
]);

export const ROUTED_TO = Object.freeze([
  'operator',
  'operator_no_contact',
  'operator_and_contact',
  'operator_contact_failed',
]);

/** The event types the webhook is registered for (design 1.3, H-L6). Every other type is ignored. */
export const SUBSCRIBED_TYPES = Object.freeze(['email.bounced', 'email.suppressed', 'email.failed']);

/** The kind tag every mail this product sends carries (design 1.4 and 1.9), namespaced `enterprise-` because the
    Resend team is shared with other senders (ALD-R-F15's fallback). The one place the values are written. */
export const KINDS = Object.freeze({
  invitation: 'enterprise-invitation',
  contact: 'enterprise-contact',
  alert: 'enterprise-alert',
  checkin: 'enterprise-checkin',
});
export const MAIL_KINDS = Object.freeze(Object.values(KINDS));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * classify(event) -> a cause from CAUSES, or null
 * null for anything that is not an object with a subscribed type. `contact_address` is never produced here: it is
 * the cause of a contact mail's own failure, which slice 2 names by the kind tag.
 */
export function classify(event) {
  if (!isObject(event)) return null;
  const data = isObject(event.data) ? event.data : {};
  if (event.type === 'email.bounced') {
    const bounce = isObject(data.bounce) ? data.bounce : {};
    if (bounce.type === 'Permanent') {
      if (bounce.subType === 'General') return 'recipient_permanent';
      if (bounce.subType === 'Suppressed') return 'suppressed';
      return 'undetermined';
    }
    if (bounce.type === 'Transient') return 'recipient_temporary';
    return 'undetermined';
  }
  if (event.type === 'email.suppressed') return 'suppressed';
  if (event.type === 'email.failed') return 'undetermined';
  return null;
}

/**
 * decide(event) -> one of
 *   { outcome: 'ignored' }                                            not an object, an unsubscribed type, no kind,
 *                                                                     a kind without the `enterprise-` prefix (another
 *                                                                     sender's), or `enterprise-contact` (slice 1)
 *   { outcome: 'operator_mail_undeliverable', cause }                 `enterprise-alert` or `enterprise-checkin`: a
 *                                                                     line, never a mail
 *   { outcome: 'delivery_undeliverable', cause, companyId }           `enterprise-invitation`: the operator alert, the
 *                                                                     company id from the tag when it is a lowercase
 *                                                                     uuid and null otherwise
 */
export function decide(event) {
  const cause = classify(event);
  if (cause === null) return { outcome: 'ignored' };
  const data = isObject(event.data) ? event.data : {};
  const tags = isObject(data.tags) ? data.tags : {};
  if (tags.kind === KINDS.invitation) {
    const company = typeof tags.company === 'string' && UUID.test(tags.company) ? tags.company : null;
    return { outcome: 'delivery_undeliverable', cause, companyId: company };
  }
  if (tags.kind === KINDS.alert || tags.kind === KINDS.checkin)
    return { outcome: 'operator_mail_undeliverable', cause };
  return { outcome: 'ignored' };
}

/* The secret's form (design 2.4): `whsec_` followed by standard base64 that decodes to 24 to 64 bytes. The length is
   counted from the text, so nothing is decoded here. */
const SECRET = /^whsec_([A-Za-z0-9+/]+)(={0,2})$/;

/** isWebhookSecret(value) -> true when the value has the signing secret's form, and false for anything else. */
export function isWebhookSecret(value) {
  if (typeof value !== 'string') return false;
  const m = SECRET.exec(value);
  if (m === null) return false;
  const chars = m[1].length + m[2].length;
  if (chars % 4 !== 0) return false;
  const bytes = (chars / 4) * 3 - m[2].length;
  return bytes >= 24 && bytes <= 64;
}

/** The check-in's schedule, daily at 06:00 UTC (design 1.8); netlify/functions/checkin.mjs carries it as a literal. */
export const CHECKIN_HOUR_UTC = 6;
export const CHECKIN_SCHEDULE = `0 ${CHECKIN_HOUR_UTC} * * *`;

const DAY_MS = 86_400_000;
const isoDay = (epochDay) => new Date(epochDay * DAY_MS).toISOString().slice(0, 10);

/**
 * checkinPeriod(nowMs) -> { epochDay, send, start, end, next, key }
 * The period is two UTC days and a check-in is sent on even epoch days only (design 1.8: 2026-09-22 is epoch day
 * 20,718, a send day). On an odd day `send` is false and the period is the one that began the day before. `start`,
 * `end` and `next` are YYYY-MM-DD; `key` is the per-period idempotency key, `enterprise-checkin/<start>`. Throws a
 * RangeError for a time that is not a finite number.
 */
export function checkinPeriod(nowMs) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) throw new RangeError('checkinPeriod(): not a time');
  const epochDay = Math.floor(nowMs / DAY_MS);
  const send = epochDay % 2 === 0;
  const first = send ? epochDay : epochDay - 1;
  const start = isoDay(first);
  return { epochDay, send, start, end: isoDay(first + 1), next: isoDay(first + 2), key: `enterprise-checkin/${start}` };
}
