/* The mail provider's delivery events (docs/e7/alerts-and-checkin-design.md 1.3, 1.4 and 1.6), slice 1: operator only
   (design section 7). POST /api/mail/events hands this module the request's headers and its body as raw text, never
   parsed (the pipeline's body mode 'signed').

     verifyMailEvent({ headers, rawBody, secret, nowSeconds }) -> { ok: true } | { ok: false, reason }
     handleMailEvent({ headers, rawBody, route, requestId }, deps) -> { outcome }
     mailEventsConfigured(env = process.env) -> boolean

   WHAT AUTHENTICATES A CALLER, and nothing else does. Resend signs with Svix (evidence/alerts-design-repro/
   svix-manual-verification.txt): the signed content is `${svix-id}.${svix-timestamp}.${raw body}`, the key is the
   base64 part of the `whsec_` secret, decoded, and the signature is HMAC-SHA256 over the content in base64;
   `svix-signature` is a space-delimited list of `v1,<signature>` entries. A caller is admitted only when the secret is
   configured and well formed, all three headers are present and well formed, the timestamp is within
   TOLERANCE_SECONDS of this function's clock either way, and one v1 entry equals the expected signature under
   timingSafeEqual over equal-length bytes. Every other case is the one answer 401 E_WEBHOOK_INVALID, so a caller
   learns nothing about which test failed, and an unconfigured route looks exactly like a forged event (ALD-R-F1:
   with the secret unset the route used to answer 503 E_MAIL_NOT_CONFIGURED, which the pipeline turns into an alert
   for any stranger's post). A 4xx raises no alert (E7 1.5, case E7-22), so a forger's flood costs a `refused` line
   each and nothing else.

   ONLY AFTER VERIFICATION is the body parsed, and then lib/rules/mail-events.mjs decide() says what it is for:
     ignored                        one `mail_event_ignored` line: not a JSON object, a type the webhook is not
                                    registered for, no kind, a kind without the `enterprise-` prefix (another sender's
                                    mail in the shared Resend team, ALD-R-F15's fallback), or `enterprise-contact`
                                    (nothing sends a contact mail until slice 2)
     operator_mail_undeliverable    one `operator_mail_undeliverable` line with its cause, and never a mail: the mail
                                    that failed was an operator alert or a check-in (`enterprise-alert`,
                                    `enterprise-checkin`), and a mail about it would go to the same address through the
                                    same provider (1.6's loop bound)
     delivery_undeliverable         one operator alert through deps.alert with the cause, `routedTo: operator`, the
                                    company id from the tag when it is a uuid, and Netlify's request id
   Each answers 200. Nothing is stored about an event, no routine is called and no database client is held: slice 1
   reads no tenant row and no address. The handler reads the type, the bounce type and subtype and the two tags
   `kind` and `company`, and never the recipient, the subject, the sender or any provider text.

   THE ALERT ABOUT A FAILED MAIL NEVER ALERTS ON ITS OWN FAILURE. deps.alert is lib/http/alerts.mjs's alert(), wired
   by the function file (this module may not reach lib/http/, E7 2.4); its own send failure is one `alert_dropped`
   line and nothing else, and that alert mail carries the tag `kind: enterprise-alert`, so its own bounce comes back as
   `operator_mail_undeliverable` here, a line and never a mail.

   REPLAYS. A captured event resent inside the tolerance verifies again and raises its alert again, which the
   alert window folds for fifteen minutes per instance; a replay older than the tolerance is refused. Storing each
   svix-id to drop duplicates is the design's rejected alternative (1.4): a table and a write for a case the fold and,
   in slice 2, the contact mail's idempotency key already cover. */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { AppError } from '../errors.mjs';
import { decide, isWebhookSecret } from '../rules/mail-events.mjs';

/** The timestamp tolerance, in seconds, either way (design 1.4: the page leaves it to the receiver). */
export const TOLERANCE_SECONDS = 300;
/* At most this many entries in svix-signature: the provider sends one, two while a secret is rotated. */
const MAX_SIGNATURES = 8;
/* An id is printable ASCII without a space or a full stop, the separator of the signed content, so no two
   (id, timestamp) pairs can produce the same content. */
const SVIX_ID = /^[!-\-/-~]{1,256}$/;
const SVIX_TIMESTAMP = /^[0-9]{1,12}$/;
const SIGNATURE_ENTRY = /^v1,([A-Za-z0-9+/]{1,128}={0,2})$/;
const VERSION_ENTRY = /^v[0-9]{1,3},\S{1,256}$/;

function defaultLog(entry) {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

/** mailEventsConfigured(env) -> true when ENTERPRISE_MAIL_WEBHOOK_SECRET has the signing secret's form. The one
    reading of the value's presence the check-in's "Bounce routing" line and slice 2's routing.bounces share. */
export function mailEventsConfigured(env = process.env) {
  return isWebhookSecret(env?.ENTERPRISE_MAIL_WEBHOOK_SECRET);
}

/**
 * verifyMailEvent({ headers, rawBody, secret, nowSeconds }) -> { ok: true } | { ok: false, reason }
 * Pure but for the HMAC: headers are the request's lower-cased header object, rawBody the text as received, secret
 * the configured value, nowSeconds this function's clock. `reason` is one of secret, headers, timestamp, signature
 * and exists for the unit cases; the route answers the same 401 whatever it is.
 */
export function verifyMailEvent({ headers, rawBody, secret, nowSeconds }) {
  if (!isWebhookSecret(secret)) return { ok: false, reason: 'secret' };
  const id = headers?.['svix-id'];
  const timestamp = headers?.['svix-timestamp'];
  const signatures = headers?.['svix-signature'];
  if (typeof id !== 'string' || !SVIX_ID.test(id)) return { ok: false, reason: 'headers' };
  if (typeof timestamp !== 'string' || !SVIX_TIMESTAMP.test(timestamp)) return { ok: false, reason: 'headers' };
  if (typeof signatures !== 'string' || typeof rawBody !== 'string') return { ok: false, reason: 'headers' };
  const entries = signatures.split(' ').filter((e) => e.length > 0);
  if (entries.length === 0 || entries.length > MAX_SIGNATURES || !entries.every((e) => VERSION_ENTRY.test(e)))
    return { ok: false, reason: 'headers' };
  if (!Number.isFinite(nowSeconds) || Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS)
    return { ok: false, reason: 'timestamp' };
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`, 'utf8').digest();
  let matched = false;
  for (const entry of entries) {
    const m = SIGNATURE_ENTRY.exec(entry);
    if (m === null) continue;
    const given = Buffer.from(m[1], 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: 'signature' };
}

/**
 * handleMailEvent({ headers, rawBody, route, requestId }, deps) -> Promise<{ outcome }>
 * Throws AppError E_WEBHOOK_INVALID for anything that does not verify, before the body is parsed. deps.log receives
 * the module's lines (default, stderr); deps.alert raises the operator alert (with none wired, nothing is raised);
 * deps.nowSeconds is the clock seam for tests. The secret is read from the environment at each call.
 */
export async function handleMailEvent({ headers, rawBody, route, requestId }, deps = {}) {
  const nowSeconds = typeof deps.nowSeconds === 'function' ? deps.nowSeconds() : Math.floor(Date.now() / 1000);
  const verified = verifyMailEvent({
    headers,
    rawBody,
    secret: process.env.ENTERPRISE_MAIL_WEBHOOK_SECRET,
    nowSeconds,
  });
  if (!verified.ok) throw new AppError('E_WEBHOOK_INVALID');
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    event = undefined;
  }
  const decision = decide(event);
  const log = deps.log ?? defaultLog;
  if (decision.outcome === 'ignored') {
    log({ event: 'mail_event_ignored' });
    return { outcome: 'ignored' };
  }
  if (decision.outcome === 'operator_mail_undeliverable') {
    log({ event: 'operator_mail_undeliverable', cause: decision.cause });
    return { outcome: 'operator_mail_undeliverable' };
  }
  if (typeof deps.alert === 'function') {
    try {
      await deps.alert(
        'delivery_undeliverable',
        { route, cause: decision.cause, routedTo: 'operator', companyId: decision.companyId, requestId },
        deps,
      );
    } catch {
      /* an alert is a notification; the provider's acknowledgement stands */
    }
  }
  return { outcome: 'delivery_undeliverable' };
}
