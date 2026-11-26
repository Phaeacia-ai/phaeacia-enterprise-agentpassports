/* The check-in mail (docs/e7/alerts-and-checkin-design.md 1.8), slice 1: the lines from "Period" to "Session keys"
   and no database line (design section 7).

     runCheckin({ now, deploy }, deps) -> Promise<{ outcome }>
     outcome: skipped | recorded | sent | duplicate | dropped

   ONE PER PERIOD. It runs daily at 06:00 UTC and sends only on even epoch days (lib/rules/mail-events.mjs
   checkinPeriod); an odd day writes `checkin_skipped` and sends nothing. Each send carries the period's idempotency
   key, `enterprise-checkin/<first day>`, so a second invocation on a send day (a retry, or "Run now" pressed twice)
   sends no second mail: the provider answers an identical body with the first request's answer and sends nothing,
   which this function cannot tell from a first send and logs `checkin_sent` again, and answers a changed body under
   the same key with 409, which is `checkin_duplicate` (ALD-R-F10: "no second mail" is the property; the log word
   follows whether a line changed between the two).

   EACH LINE'S FAILURE IS THAT LINE'S ATTENTION STATE, AND THE MAIL STILL GOES. The key-set load that throws, an
   invalid delivery mode and a closed access switch each turn their own line; nothing a line does can stop the mail.
   Only the transport's failure does, and that writes one `checkin_dropped` line with the provider's status and the
   transport's code and NEVER alerts, because the alert would go through the same transport (1.6's loop bound).

   WHEN THE SINK IS NOT `mail` (ENTERPRISE_ALERT_SINK other than `mail`, ENTERPRISE_ALERT_TO not an address, or the
   transport not ready) nothing is read and nothing is sent, and one `checkin_recorded` line carrying `event` and
   nothing else says the check-in ran (ALD-R-F12): the facts are not allowlisted alert fields, and a line that said
   them would be a second policy for log lines.

   WHAT IT READS, in sequence and each bounded inside Netlify's 30 seconds: the environment (the delivery mode through
   lib/services/invitations.mjs's own deliveryMode(), the webhook secret's form through lib/services/mail-events.mjs),
   the access switch and the key-set load through deps (lib/http/checkin.mjs passes lib/http/pipeline.mjs's
   accessState and lib/session.mjs's signingKeysReady, with its own 3 second bound, because lib/services/ may reach
   neither), and the send through the transport's 5 second bound. No database, no tenant, no address but the
   operator's. */

import { CHECKIN_HOUR_UTC, KINDS, checkinPeriod } from '../rules/mail-events.mjs';
import { deliveryMode } from './invitations.mjs';
import { mailEventsConfigured } from './mail-events.mjs';
import { checkinMail } from './mail-templates.mjs';
import { isAddress } from './mail.mjs';

function defaultLog(entry) {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

function deliveryWord() {
  try {
    return deliveryMode();
  } catch {
    return 'invalid';
  }
}

async function sessionKeys(deps) {
  try {
    const r = typeof deps.signingKeysReady === 'function' ? await deps.signingKeysReady() : null;
    return r?.ok === true ? { ok: true } : { ok: false, code: r?.code };
  } catch {
    return { ok: false, code: 'E_SESSION_UNAVAILABLE' };
  }
}

function accessWord(deps) {
  try {
    return typeof deps.accessState === 'function' ? deps.accessState() : 'closed';
  } catch {
    return 'closed';
  }
}

/**
 * runCheckin({ now, deploy }, deps) -> Promise<{ outcome }>
 * now is milliseconds since the epoch; deploy is Netlify's context.deploy. deps.mail is the transport,
 * deps.signingKeysReady and deps.accessState the two reads lib/services/ cannot make itself, deps.log the line seam
 * (default, stderr). Resolves for every outcome; a line never throws out of here.
 */
export async function runCheckin({ now, deploy }, deps = {}) {
  const log = deps.log ?? defaultLog;
  const period = checkinPeriod(now);
  if (!period.send) {
    log({ event: 'checkin_skipped' });
    return { outcome: 'skipped' };
  }
  const transport = deps.mail;
  const ready = typeof transport?.ready === 'function' && transport.ready() === true;
  const to = process.env.ENTERPRISE_ALERT_TO;
  if (process.env.ENTERPRISE_ALERT_SINK !== 'mail' || !isAddress(to) || !ready) {
    log({ event: 'checkin_recorded' });
    return { outcome: 'recorded' };
  }
  const delivery = deliveryWord();
  const { subject, text } = checkinMail({
    start: period.start,
    end: period.end,
    next: period.next,
    hourUtc: CHECKIN_HOUR_UTC,
    deploy,
    access: accessWord(deps),
    delivery,
    bounceRouting: delivery === 'mail' && ready && mailEventsConfigured(),
    sessionKeys: await sessionKeys(deps),
  });
  try {
    await transport.deliver({ to, subject, text, tags: { kind: KINDS.checkin }, idempotencyKey: period.key });
  } catch (e) {
    if (e?.name === 'MailError' && e.status === 409) {
      log({ event: 'checkin_duplicate' });
      return { outcome: 'duplicate' };
    }
    log({
      event: 'checkin_dropped',
      code: e?.name === 'MailError' ? e.code : undefined,
      status: e?.name === 'MailError' ? e.status : undefined,
    });
    return { outcome: 'dropped' };
  }
  log({ event: 'checkin_sent' });
  return { outcome: 'sent' };
}
