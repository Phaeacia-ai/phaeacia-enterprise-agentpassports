/* The mail templates (E7 design 1.1 and 1.5). Pure: no IO, no dependency, no clock. Each function takes named slots and
   returns { subject, text }, plain text only, and nothing it was not given by name can reach the message, because
   the functions destructure their four slots and read nothing else (the tripwire, case E7-4, feeds each one an
   argument carrying a passport sentence, agent, group and member names, the inviter's name and address and a token,
   and finds none of them in any rendered message).

   WHAT AN INVITATION MAY CONTAIN: the company's display name, the role word "administrator", the accept URL on a line
   of its own, and the invitation's expiry as a UTC date. WHAT IT MUST NEVER CONTAIN: passport or candidate content,
   an agent, group, release or review name, another member's name or address, the inviting person's name or address,
   the invitation code outside the URL's fragment, GoTrue's token hash as text, a sign-in or MFA code, or anything
   about an earlier invitation.

   THE COMPANY'S DISPLAY NAME IS A DISCLOSED METADATA EXCEPTION (E7D-C-F9), chosen over an opaque label. It is the
   company's identity as the operator typed it at provisioning (008's app.operator_company_row says so), it is not
   what the company holds, and it goes to the one person being invited into that company, who needs it to know the
   mail is genuine: an invitation that names no one it comes from is the shape of a phishing mail, and a generated
   label the invitee has never seen tells them nothing. The price is that the name leaves the product in the message
   body and subject, so the mail provider holds it for its retention period beside the address and the link; the
   inventory (docs/ops/inventory.md, E7 1.4) lists "company display name" on the provider's row for that reason. It is
   sanitised before it enters either part: control characters, line and paragraph separators and bidirectional
   overrides removed, whitespace collapsed, at most 80 characters, because a subject is a header and a name is
   operator-typed text. A missing or empty name renders fixed words instead ("a company"), never a guess.

   THE LINK'S TWO LIFETIMES, and the wording E7-28 selected. The invitation code lives until expires_at; the sign-in
   half is GoTrue's token, which lives otp_expiry (one hour). The design's longer paragraph promised that after the
   hour the page would ask the invitee to sign in with their address first. Observed on the local stack
   (GoTrue v2.192.0, evidence/e7-mail.md section 4, E7-28): the product's sign-in start for an account that is still
   unconfirmed, which every first-time invitee's is, answers 422 signup_disabled and issues nothing, so that path does
   not exist for them. The shorter wording is therefore the true one, for every kind: open it within the hour, and
   after that the link may no longer sign you in (it still does for an address that already has a confirmed account,
   which is why the sentence says "may"), in which case a new link is the way on. */

/** The four invitation messages of E7 design 1.1's table; `administrator` is `member` with the role word. */
export const INVITATION_KINDS = Object.freeze(['member', 'administrator', 'first_admin', 'succession']);

const ADMIN_KINDS = new Set(['administrator', 'first_admin', 'succession']);
const NAME_LIMIT = 80;
const MONTHS = Object.freeze([
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]);

/* C0 and C1 controls and DEL (\p{Cc}), the line and paragraph separators, and the bidirectional marks, embeddings,
   overrides and isolates (\p{Bidi_Control}), which can make a subject read differently from what it holds. Property
   escapes rather than code-point escapes, which scripts/check-imports.mjs refuses under lib/. */
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu;

/**
 * sanitizeName(name) -> string | null
 * Unsafe characters become spaces (so two words joined by a line break stay two words), whitespace runs collapse to
 * one space, the ends are trimmed, and the result is cut at 80 characters (code points, so a pair is never split).
 * Anything that is not a string, or nothing left, is null.
 */
export function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const clean = name.replace(UNSAFE, ' ').replace(/\s+/gu, ' ').trim();
  if (clean.length === 0) return null;
  const points = Array.from(clean);
  return points.length > NAME_LIMIT ? points.slice(0, NAME_LIMIT).join('').trimEnd() : clean;
}

/* A URL is rendered only when it is one absolute http(s) URL with nothing a line could be broken or a second value
   hidden with: a template that would print a malformed link throws, and the caller answers `failed`. */
function acceptLine(acceptUrl) {
  if (typeof acceptUrl !== 'string' || !/^https?:\/\/[^\s]+$/.test(acceptUrl) || acceptUrl.length > 2048)
    throw new TypeError('invitationMail(): acceptUrl is not one absolute URL');
  return acceptUrl;
}

/** "26 September 2026, 14:03 UTC" from an ISO timestamp; throws on anything Date cannot read. */
export function utcDate(expiresAt) {
  const t = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isNaN(t)) throw new TypeError('invitationMail(): expiresAt is not a timestamp');
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/**
 * invitationMail({ kind, companyName, acceptUrl, expiresAt }) -> { subject, text }
 * Throws a TypeError on an unknown kind, a malformed URL or an unreadable date: a message that cannot be rendered
 * truthfully is not sent.
 */
export function invitationMail({ kind, companyName, acceptUrl, expiresAt }) {
  if (!INVITATION_KINDS.includes(kind)) throw new TypeError('invitationMail(): unknown kind');
  const name = sanitizeName(companyName);
  const link = acceptLine(acceptUrl);
  const until = utcDate(expiresAt);
  const admin = ADMIN_KINDS.has(kind);
  const whose = name === null ? "a company's workspace" : `${name}'s workspace`;
  const opening = {
    member: `You have been invited to ${whose} on Phaeacia.`,
    administrator: `You have been invited to ${whose} on Phaeacia as an administrator.`,
    first_admin: `You have been invited to set up ${whose} on Phaeacia as its first administrator.`,
    succession: `You have been invited to ${whose} on Phaeacia as an administrator. The workspace already exists; this invitation adds an administrator to it.`,
  }[kind];
  const subject = name === null ? 'Your invitation on Phaeacia' : `Your invitation to ${name} on Phaeacia`;
  const lines = [
    opening,
    '',
    'Open this link to accept. It signs you in, so do not forward it.',
    link,
    '',
    `Open it within one hour of this mail. After that hour the link may no longer sign you in; if it does not, ask the person who invited you for a new link, which replaces this one. The invitation ends on ${until} in any case.`,
  ];
  if (admin)
    lines.push(
      '',
      'After you accept, you will set up a second factor (an authenticator app) before you can administer the company.',
    );
  lines.push(
    '',
    'If you did not expect this mail, ignore it. Nothing happens until the link is opened and you press Accept.',
  );
  return { subject, text: `${lines.join('\n')}\n` };
}

/* ---------- the alert mail (E7 1.5) ----------

   The alert's content is decided in lib/http/alerts.mjs, whose allowlist of shapes is the policy. This renderer is the
   last step before the provider and does not trust that it was handed a shaped alert: it prints only the keys named
   below, in a fixed order, each only when its value has the character class its shape allows, and the word `invalid`
   otherwise. That is defence in depth over the same rule, not a second rule: every pattern here admits at least what
   alerts.mjs admits, so the two cannot disagree on a value the policy passes.

   THE OPENING AND THE SUBJECT, per event (the alerts design 1.2; ALD-R-F14, settled against the code by the slice 1
   build lane). Every alert opened "A server fault was recorded." and its subject named the code, which a bounce alert
   has neither of: a mail event says the provider accepted an invitation and could not deliver it. So
   `delivery_undeliverable` opens with that sentence and its subject names the cause, and every other event keeps the
   opening and subject it had, which scripts/alert-test.mjs's receipt (H-L1) and its pins read. The two new lines,
   "Cause" and "Routed to", sit after "Company" and print only the words of the design's two vocabularies. */

const ALERT_LINES = Object.freeze([
  ['event', 'Event', (v) => typeof v === 'string' && /^[a-z_]{1,32}$/.test(v)],
  ['route', 'Route', (v) => typeof v === 'string' && /^[a-z][A-Za-z]{1,63}$/.test(v)],
  ['code', 'Code', (v) => typeof v === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(v)],
  ['status', 'Status', (v) => Number.isInteger(v) && v >= 400 && v <= 599],
  [
    'companyId',
    'Company',
    (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v),
  ],
  ['cause', 'Cause', (v) => typeof v === 'string' && /^[a-z_]{1,32}$/.test(v)],
  ['routedTo', 'Routed to', (v) => typeof v === 'string' && /^[a-z_]{1,32}$/.test(v)],
  ['requestId', 'Request', (v) => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v)],
  ['errorName', 'Error class', (v) => typeof v === 'string' && /^[A-Za-z]{1,40}$/.test(v)],
  ['dbCode', 'Database code', (v) => typeof v === 'string' && /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(v)],
  ['count', 'Folded occurrences', (v) => Number.isInteger(v) && v >= 0],
  ['at', 'At', (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v)],
  ['v', 'Version', (v) => Number.isInteger(v) && v >= 1 && v <= 99],
]);

/** alertMail(alert) -> { subject, text }: the fixed alert text, filled from the named keys only. */
export function alertMail(alert) {
  const a = alert !== null && typeof alert === 'object' ? alert : {};
  const shown = (key, test) =>
    Object.hasOwn(a, key) && a[key] !== undefined && a[key] !== null
      ? test(a[key])
        ? String(a[key])
        : 'invalid'
      : null;
  const [, , codeTest] = ALERT_LINES.find(([k]) => k === 'code');
  const [, , routeTest] = ALERT_LINES.find(([k]) => k === 'route');
  const [, , causeTest] = ALERT_LINES.find(([k]) => k === 'cause');
  const route = shown('route', routeTest) ?? 'no route';
  const undeliverable = a.event === 'delivery_undeliverable';
  const subject = undeliverable
    ? `Phaeacia enterprise alert: an invitation could not be delivered (${shown('cause', causeTest) ?? 'no cause'}) on ${route}`
    : `Phaeacia enterprise alert: ${shown('code', codeTest) ?? 'no code'} on ${route}`;
  const opening = undeliverable
    ? 'The mail provider accepted an invitation and then reported that it could not be delivered.'
    : 'A server fault was recorded.';
  const lines = [`${opening} This mail carries no customer content, by design.`, ''];
  for (const [key, label, test] of ALERT_LINES) {
    const value = shown(key, test);
    if (value !== null) lines.push(`${label}: ${value}`);
  }
  lines.push('', 'The function log holds the same fields, written before this mail was sent.');
  return { subject, text: `${lines.join('\n')}\n` };
}

/* ---------- the check-in mail (the alerts design 1.8, slice 1) ----------

   The operator's "alive" mail, every two days. Like alertMail it does not trust its caller: every value is a fixed
   word from a closed set, a date, or the deploy's own id and context, each printed only when it has its shape and as
   `unknown` otherwise, so no tenant name, slug, id, address or token can reach it however it is called. The deploy id
   admits letters and digits only, so not even a uuid can be printed there. Slice 1 has no database line; the
   paragraph on what the mail cannot tell names the database until slice 2 adds its lines.

   ATTENTION. The subject ends ": attention" instead of ": ok" when a line is in its attention state: access closed,
   delivery invalid, or the session keys failed. A line whose value is not recognised is also attention, because a
   check-in that cannot say a thing is fine has not said it. */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEPLOY_ID = /^[A-Za-z0-9]{1,64}$/;
const DEPLOY_CONTEXT = /^[a-z][a-z-]{0,31}$/;
const KEY_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * checkinMail({ start, end, next, hourUtc, deploy, access, delivery, bounceRouting, sessionKeys })
 *   -> { subject, text, attention }
 * start, end and next are YYYY-MM-DD (lib/rules/mail-events.mjs checkinPeriod); hourUtc the schedule's hour; deploy
 * Netlify's context.deploy or undefined; access `open` or `closed`; delivery `mail`, `handover` or `invalid`;
 * bounceRouting a boolean; sessionKeys `{ ok: true }` or `{ ok: false, code }`. Throws a TypeError when a date or the
 * hour cannot be rendered, because a check-in that cannot say which period it covers says nothing true.
 */
export function checkinMail({ start, end, next, hourUtc, deploy, access, delivery, bounceRouting, sessionKeys }) {
  for (const day of [start, end, next])
    if (typeof day !== 'string' || !DAY.test(day)) throw new TypeError('checkinMail(): a date is not YYYY-MM-DD');
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 17) throw new TypeError('checkinMail(): hourUtc');
  const hour = `${String(hourUtc).padStart(2, '0')}:00`;
  const late = `${String(hourUtc + 6).padStart(2, '0')}:00`;
  const d = deploy !== null && typeof deploy === 'object' ? deploy : {};
  const deployLine =
    typeof d.id === 'string' && DEPLOY_ID.test(d.id)
      ? `${d.id} (${typeof d.context === 'string' && DEPLOY_CONTEXT.test(d.context) ? d.context : 'unknown'}, published: ${d.published === true ? 'yes' : d.published === false ? 'no' : 'unknown'})`
      : 'unknown';
  const accessWord = access === 'open' || access === 'closed' ? access : 'unknown';
  const deliveryWord = delivery === 'mail' || delivery === 'handover' || delivery === 'invalid' ? delivery : 'invalid';
  const routingWord = bounceRouting === true ? 'configured' : 'not configured';
  const keysOk = sessionKeys?.ok === true;
  const keysWord = keysOk
    ? 'loaded'
    : `failed (${typeof sessionKeys?.code === 'string' && KEY_CODE.test(sessionKeys.code) ? sessionKeys.code : 'unknown'})`;
  const attention = accessWord !== 'open' || deliveryWord === 'invalid' || !keysOk;
  const subject = `Phaeacia enterprise check-in ${start}: ${attention ? 'attention' : 'ok'}`;
  const lines = [
    'This is the scheduled check-in of the Phaeacia enterprise service. It carries no customer content, by design.',
    '',
    `Period: ${start} to ${end} (UTC)`,
    `Next check-in: ${next} at ${hour} UTC. If it has not arrived by ${late} UTC that day, treat its absence as the alert.`,
    `Deploy: ${deployLine}`,
    `Access state: ${accessWord}`,
    `Invitation delivery: ${deliveryWord}`,
    `Bounce routing: ${routingWord}`,
    `Session keys: ${keysWord}`,
    '',
    "What this mail cannot tell you: whether the database answers and what it holds (this check-in does not read it yet), the register on your machine and its anchored head, the deploy check's last result, whether customers' mail reaches their inboxes, alerts dropped since the last check-in, and anything about a function other than this one. The weekly check covers those. Nor can it see whether the mail provider's delivery reports arrive at the service or verify there: \"Bounce routing: configured\" says only that they could.",
    '',
    'If the next check-in does not arrive, the silence is the alert. The system that failed cannot report its own silence: the scheduler, this function, its configuration, the database or the mail provider may be the cause. Run the smoke test (docs/ops/hosted-checklist.md H-S1) and read the function log for check-in lines.',
  ];
  return { subject, text: `${lines.join('\n')}\n`, attention };
}
