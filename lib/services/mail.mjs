/* The mail transport (E7 design 1.1): the one module that hands a finished message to the mail provider.

     mailTransport(env = process.env, { fetchImpl = fetch })
       -> { ready(): boolean, deliver({ to, subject, text, tags?, idempotencyKey? }) }

   One recipient, plain text, nothing else crosses in but two things the provider holds beside the message (the
   alerts design 1.9): `tags`, at most five name and value pairs of letters, digits, underscores and dashes, which the
   provider hands back in its delivery events so an event names its kind, company and invitation without anything
   stored here; and `idempotencyKey`, sent as the Idempotency-Key header, with which the provider answers a repeat of
   the same key inside 24 hours without sending again. HTTP and not SMTP because `fetch` is a global and an SMTP
   client needs node:net and node:tls, which scripts/check-imports.mjs refuses under lib/ (design 1.1, 2.4); this
   module reaches nothing but the global. The environment is read at each call, not at construction, so the four
   function files can build their transport when they load and a value corrected later is read on the next request.

   CONFIGURATION (docs/ops/environment.md). ENTERPRISE_MAIL_PROVIDER names one entry of PROVIDERS; the key, the sender
   and the optional reply-to fill it; ENTERPRISE_MAIL_ENDPOINT replaces the provider's endpoint for the local catcher
   (tests/e7/mail-catcher.mjs) only, and is admitted only as an http(s) URL on a loopback host, so a mistyped value can
   never send a customer's link somewhere else. ready() is true only when every required value is present and well
   formed; lib/services/invitations.mjs's requireDelivery asks it before any write, so a server set to `mail` with a
   missing or malformed value refuses with E_MAIL_NOT_CONFIGURED and creates nothing (E7-6).

   THE ANSWER, three ways, and never the provider's words (E7-7, E7D-C-F7):
     any 2xx                                           sent; deliver resolves
     any other status (the provider answered, and not
       with acceptance)                                 MailError('failed'), carrying `status` when it is 400 to 599
     no answer, and the request cannot have left
       (refused connection, no such host, TLS failed)   MailError('failed')
     no answer after the request may have left (the
       5 s timeout, a reset or closed connection, or
       anything this module cannot classify)            MailError('unconfirmed')
   `unconfirmed` exists because the provider may have accepted a message whose answer was lost, so the invitee may hold
   the link: the product must not say it did not go out. The recovery is the same Resend either way, which kills
   whatever link went out. An unknown failure is `unconfirmed` and not `failed`, because only a failure known to have
   happened before the request left proves nothing was sent.
   The answer body is cancelled unread, whatever the status: an upstream error body can quote the message it refused,
   so none of it is read into memory, logged, rethrown or attached. A MailError carries a fixed message, its outcome,
   at most a Node or undici error code from a fixed list (for the alert's `code`), and, when the provider answered
   400 to 599, that status (the alerts design 1.9 item 4: a status is not content, ALD-F4; the check-in reads a 409 as
   its idempotency key's duplicate), never the cause itself. No retry
   is made here: a retry after a timeout can send a second copy of the same live link (design 1.1). */

/* Each provider is one entry: its endpoint, its request headers from the key and the idempotency key, and its request
   body. Adding a provider is one entry here and nothing else in the product (design section 7, scenario 1).
   The User-Agent is explicit (the alerts design 1.9 item 1, ALD-F3): Resend refuses a request without one with a 403,
   Node's fetch happens to add its own, and the hosted runtime's default is unobserved (H-L9), so the product does not
   depend on it. Tags travel as the provider's `[{ name, value }]` list, in the order given. */
export const USER_AGENT = 'phaeacia-enterprise/1';
export const PROVIDERS = Object.freeze({
  resend: Object.freeze({
    endpoint: 'https://api.resend.com/emails',
    headers: (key, idempotencyKey) => {
      const h = { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': USER_AGENT };
      if (idempotencyKey !== undefined) h['idempotency-key'] = idempotencyKey;
      return h;
    },
    body: (from, replyTo, { to, subject, text, tags }) => {
      const b = { from, to: [to], subject, text };
      if (replyTo !== null) b.reply_to = replyTo;
      if (tags !== undefined) b.tags = Object.entries(tags).map(([name, value]) => ({ name, value }));
      return b;
    },
  }),
});

/** The send's time bound, in milliseconds (design 1.1). */
export const SEND_TIMEOUT_MS = 5000;

/** The outcome of a send that did not end in a 2xx. `outcome` is `failed` or `unconfirmed`; the message is fixed;
    `status` is the provider's HTTP status when it answered 400 to 599, and absent otherwise. */
export class MailError extends Error {
  constructor(outcome, code, status) {
    super(outcome === 'unconfirmed' ? 'unconfirmed' : 'failed');
    this.name = 'MailError';
    this.outcome = outcome === 'unconfirmed' ? 'unconfirmed' : 'failed';
    if (typeof code === 'string') this.code = code;
    if (Number.isInteger(status) && status >= 400 && status <= 599) this.status = status;
  }
}

const ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/* `Name <address>`, the display name printable and free of the characters that would end or split it. */
const NAMED_SENDER = /^([^<>"\p{Cc}\p{Zl}\p{Zp}]{1,64}) <([^<>\s]+)>$/u;
/* A provider key: printable ASCII with no whitespace, which is every shape a provider issues, and never a header
   break. Its value is checked for shape only and never compared, printed or logged. */
const KEY = /^[!-~]{8,512}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** One plain address, as the transport accepts a recipient; the check-in reads its operator address with it. */
export const isAddress = (v) => typeof v === 'string' && v.length <= 254 && ADDRESS.test(v);
const present = (v) => typeof v === 'string' && v.length > 0;

function isSender(v) {
  if (!present(v) || v.length > 320) return false;
  if (isAddress(v)) return true;
  const m = NAMED_SENDER.exec(v);
  return Boolean(m) && m[1].trim() === m[1] && isAddress(m[2]);
}

function loopbackEndpoint(v) {
  let url;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || !LOOPBACK_HOSTS.has(url.hostname)) return null;
  return url.href;
}

/** The configuration read from env, or null when any required value is missing or malformed. */
function configOf(env) {
  const name = env?.ENTERPRISE_MAIL_PROVIDER;
  if (typeof name !== 'string' || !Object.hasOwn(PROVIDERS, name)) return null;
  const key = env.ENTERPRISE_MAIL_API_KEY;
  if (typeof key !== 'string' || !KEY.test(key)) return null;
  const from = env.ENTERPRISE_MAIL_FROM;
  if (!isSender(from)) return null;
  const replyTo = present(env.ENTERPRISE_MAIL_REPLY_TO) ? env.ENTERPRISE_MAIL_REPLY_TO : null;
  if (replyTo !== null && !isAddress(replyTo)) return null;
  const override = present(env.ENTERPRISE_MAIL_ENDPOINT) ? loopbackEndpoint(env.ENTERPRISE_MAIL_ENDPOINT) : undefined;
  if (override === null) return null;
  const provider = PROVIDERS[name];
  return { provider, key, from, replyTo, endpoint: override ?? provider.endpoint };
}

/* Failures that happen before a byte of the request can have reached the provider. */
const NEVER_LEFT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);
const NEVER_LEFT_PREFIX = /^(?:CERT_|ERR_TLS_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;
/* The codes an alert may carry for a transport failure (lib/http/alerts.mjs SYSTEM_CODES). */
const REPORTED = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** A thrown fetch failure as a MailError: never-left codes are `failed`, the timeout and everything else `unconfirmed`. */
function mailErrorOf(e) {
  if (e?.name === 'TimeoutError') return new MailError('unconfirmed', 'ETIMEDOUT');
  const code = typeof e?.cause?.code === 'string' ? e.cause.code : typeof e?.code === 'string' ? e.code : null;
  const reported = code !== null && REPORTED.has(code) ? code : undefined;
  if (code !== null && (NEVER_LEFT.has(code) || NEVER_LEFT_PREFIX.test(code))) return new MailError('failed', reported);
  return new MailError('unconfirmed', reported);
}

/* The provider's tag rule ("ASCII letters, numbers, underscores, or dashes", at most 256 characters; the alerts design
   1.9 item 2) and the idempotency key's (at most 256 characters; the characters design 1.9 item 3 admits, which cover
   `enterprise-checkin/<date>` and `contact-bounce/<uuid>`). */
const TAG = /^[A-Za-z0-9_-]{1,256}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9/_.:-]{1,256}$/;
const MAX_TAGS = 5;

function tagsWellFormed(tags) {
  if (tags === undefined) return true;
  if (
    tags === null ||
    typeof tags !== 'object' ||
    Array.isArray(tags) ||
    Object.getPrototypeOf(tags) !== Object.prototype
  )
    return false;
  const entries = Object.entries(tags);
  return (
    entries.length >= 1 &&
    entries.length <= MAX_TAGS &&
    entries.every(([name, value]) => TAG.test(name) && typeof value === 'string' && TAG.test(value))
  );
}

/* A message is one address, a one-line subject, a text, and optionally well-formed tags and an idempotency key;
   anything else is refused before a request is made. */
function wellFormed(message) {
  const { to, subject, text, tags, idempotencyKey } = message ?? {};
  return (
    isAddress(to) &&
    typeof subject === 'string' &&
    subject.length > 0 &&
    subject.length <= 998 &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(subject) &&
    typeof text === 'string' &&
    text.length > 0 &&
    text.length <= 100_000 &&
    tagsWellFormed(tags) &&
    (idempotencyKey === undefined || (typeof idempotencyKey === 'string' && IDEMPOTENCY_KEY.test(idempotencyKey)))
  );
}

/**
 * mailTransport(env = process.env, { fetchImpl = fetch })
 *   -> { ready(), deliver({ to, subject, text, tags?, idempotencyKey? }) }
 * deliver resolves when the provider answered 2xx and throws a MailError otherwise; it makes exactly one request, and
 * none at all when the transport is not ready or the message is malformed.
 */
export function mailTransport(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  return Object.freeze({
    ready: () => configOf(env) !== null,
    deliver: async (message) => {
      const config = configOf(env);
      if (config === null || !wellFormed(message)) throw new MailError('failed');
      const { to, subject, text, tags, idempotencyKey } = message;
      let res;
      try {
        res = await fetchImpl(config.endpoint, {
          method: 'POST',
          headers: config.provider.headers(config.key, idempotencyKey),
          body: JSON.stringify(config.provider.body(config.from, config.replyTo, { to, subject, text, tags })),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          redirect: 'manual',
        });
      } catch (e) {
        throw mailErrorOf(e);
      }
      try {
        await res.body?.cancel();
      } catch {
        /* nothing of the answer is kept, whether or not the cancel itself succeeded */
      }
      if (!(res.status >= 200 && res.status < 300)) throw new MailError('failed', undefined, res.status);
    },
  });
}
