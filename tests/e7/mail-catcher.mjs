/* The local mail catcher (E7 design 1.1, "the local test doubles"): a node:http server on a free loopback port that
   accepts the provider's request shape, so the stack tests and the journeys run the REAL transport
   (lib/services/mail.mjs) and the real templates, pointed here by ENTERPRISE_MAIL_ENDPOINT. It is not a mail provider:
   nothing is delivered, and deliverability, the fragment in real clients, link scanners and retention are the hosted
   receipt's (H-M1 to H-M7).

   What it accepts. POST /emails with Authorization "Bearer <key>" equal to the key it was started with, a JSON body
   { from, to: [one address], subject, text, reply_to?, tags? } and nothing else, `tags` being the provider's list of
   { name, value } strings (the alerts design 1.9). Anything else answers 400 (shape) or 401 (key), and is not
   recorded as a message. A recorded message carries its tags as an object and the request's Idempotency-Key, and
   each request entry carries its User-Agent header, so a case reads what the transport sent.

   THE IDEMPOTENCY KEY, as the provider documents it (evidence/alerts-design-repro/resend-idempotency-keys.txt,
   resend-errors.txt), for accepted requests: a key seen in the last 24 hours with the same body answers the first
   request's 200 and id again and records nothing; with another body it answers 409 invalid_idempotent_request and
   records nothing. The clock is the catcher's own, settable through setNow(ms) so a case can cross the 24 hours.
   What the provider does with a key whose first request failed is unknown (design 1.8) and not emulated: a key is
   held only once its request was accepted.

   SIGNED EVENTS (the alerts design 1.4, section 9). signEvent() signs a body the way the provider's webhook sender,
   Svix, documents it (evidence/alerts-design-repro/svix-manual-verification.txt): HMAC-SHA256, keyed with the base64
   part of a `whsec_` secret, over `${id}.${timestamp}.${body}`, in base64, sent as `v1,<signature>`. It is written
   here separately from lib/services/mail-events.mjs's verifier and shares no code with it, so the two meet only in
   what the provider's page says. webhookSecret() makes a fresh secret at run time; none is ever written down.
   bounceEvent(), suppressedEvent() and failedEvent() build the provider's documented payloads (the three
   resend-webhook-*.txt excerpts), with the tags and the bounce type and subtype a case names.

   How it can be told to answer, for the next request or the next n (instruct(mode, { times })):
     accept        200 {"id": ...}; the message is recorded                                        (the default)
     status        the given status (500, 422, ...) with a body quoting the message, the recipient and a synthetic
                   secret, which the transport must never surface (E7-7); not recorded
     hang          reads the request, records the message, and never answers, holding the socket until the client
                   gives up (the transport's 5 s timeout) or the catcher closes
     drop          reads the request, records the message as ACCEPTED, then destroys the connection without an
                   answer: the provider took it and the answer was lost (E7D-C-F7's control, accept-then-disconnect)
     refuse-key    401 whatever key was sent; not recorded
   `hang` and `drop` record the message because the request left and a provider may have accepted it: the link in it
   is exactly what an `unconfirmed` answer says the invitee may hold.

   Every request is kept in `requests` with its mode and whether it was recorded, never with the key. Nothing here
   writes to stdout or stderr. The link inside a message is read by linkIn(message), from the one line of the text
   that is the accept URL, which is how a journey follows the link a person would have received. */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export const LOOPBACK = '127.0.0.1';
/* A synthetic key in the shape the check-secrets gate excludes; never a provider's. */
export const CATCHER_KEY = 'example-synthetic-catcher-provider-value';
export const UPSTREAM_SECRET = 'example-synthetic-upstream-secret-4242';

const MODES = new Set(['accept', 'status', 'hang', 'drop', 'refuse-key']);

function shapeOf(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body).sort();
  const allowed = ['from', 'reply_to', 'subject', 'tags', 'text', 'to'];
  if (!keys.every((k) => allowed.includes(k))) return null;
  const { from, to, subject, text, reply_to: replyTo, tags } = body;
  if (typeof from !== 'string' || typeof subject !== 'string' || typeof text !== 'string') return null;
  if (!Array.isArray(to) || to.length !== 1 || typeof to[0] !== 'string') return null;
  if (replyTo !== undefined && typeof replyTo !== 'string') return null;
  let tagged = null;
  if (tags !== undefined) {
    if (!Array.isArray(tags)) return null;
    tagged = {};
    for (const t of tags) {
      if (t === null || typeof t !== 'object' || typeof t.name !== 'string' || typeof t.value !== 'string') return null;
      if (Object.keys(t).length !== 2 || !/^[A-Za-z0-9_-]{1,256}$/.test(t.name) || !/^[A-Za-z0-9_-]{1,256}$/.test(t.value))
        return null;
      tagged[t.name] = t.value;
    }
  }
  return { from, to: to[0], subject, text, replyTo: replyTo ?? null, tags: tagged };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A fresh signing secret in the provider's form, made at run time: `whsec_` and the base64 of 24 random bytes. */
export function webhookSecret() {
  return `whsec_${randomBytes(24).toString('base64')}`;
}

/**
 * signEvent(body, { secret, timestamp, id }) -> { id, timestamp, signature, headers }
 * body is the exact text that is posted; timestamp is seconds since the epoch; headers are the three svix-* headers
 * and the content type, ready for a request.
 */
export function signEvent(body, { secret, timestamp = Math.floor(Date.now() / 1000), id = `msg_${randomBytes(12).toString('hex')}` }) {
  const key = Buffer.from(String(secret).split('_')[1] ?? '', 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    id,
    timestamp: String(timestamp),
    signature: `v1,${signature}`,
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': String(timestamp),
      'svix-signature': `v1,${signature}`,
    },
  };
}

const EVENT_DATA = (to, tags) => ({
  created_at: '2026-09-22T08:15:09.894Z',
  email_id: '56761188-7520-42d8-8898-ff6fc54ce618',
  message_id: '<111-222-333@email.example.invalid>',
  from: 'Phaeacia Local <no-reply@phaeacia.example.invalid>',
  to: Array.isArray(to) ? to : [to],
  subject: 'Your invitation to SYNTHETIC Acme AG on Phaeacia',
  ...(tags === undefined ? {} : { tags }),
});

/** The provider's email.bounced payload (resend-webhook-email-bounced.txt), with the named recipient, tags and bounce;
    subType null sends a bounce without a subtype. */
export function bounceEvent({ to = 'bounced@example.invalid', tags, type = 'Permanent', subType = 'General' } = {}) {
  const bounce = { message: 'synthetic bounce message quoting the recipient', type };
  if (subType !== null) bounce.subType = subType;
  return {
    type: 'email.bounced',
    created_at: '2026-09-22T08:15:10.020Z',
    data: { ...EVENT_DATA(to, tags), bounce: { diagnosticCode: ['smtp; 550 5.1.1 synthetic'], ...bounce } },
  };
}

/** The provider's email.suppressed payload (resend-webhook-email-suppressed.txt). */
export function suppressedEvent({ to = 'suppressed@example.invalid', tags } = {}) {
  return {
    type: 'email.suppressed',
    created_at: '2026-09-22T08:15:10.020Z',
    data: {
      ...EVENT_DATA(to, tags),
      suppressed: { message: 'synthetic suppression message', type: 'OnAccountSuppressionList' },
    },
  };
}

/** The provider's email.failed payload (resend-webhook-email-failed.txt). */
export function failedEvent({ to = 'failed@example.invalid', tags } = {}) {
  return {
    type: 'email.failed',
    created_at: '2026-09-22T08:15:10.020Z',
    data: { ...EVENT_DATA(to, tags), failed: { reason: 'reached_daily_quota' } },
  };
}

/** The accept URL a message carries: the one line of its text that is an absolute URL to /accept with a fragment. */
export function linkIn(message) {
  const lines = String(message?.text ?? '').split('\n').filter((l) => /^https?:\/\/[^\s]+\/accept#/.test(l));
  if (lines.length !== 1) throw new Error(`mail catcher: the message carries ${lines.length} accept links, not one`);
  return lines[0];
}

/**
 * startCatcher({ key }) -> { endpoint, port, env(), messages, requests, instruct(mode, opts), newestTo(address),
 *   setNow(ms), reset(), close() }
 */
export async function startCatcher({ key = CATCHER_KEY } = {}) {
  const messages = [];
  const requests = [];
  const plan = [];
  const sockets = new Set();
  /* Idempotency keys the catcher has accepted: key -> { digest of the body, the id answered, when }. */
  const keys = new Map();
  let clock = null;
  const now = () => clock ?? Date.now();
  const next = () => {
    const step = plan[0];
    if (!step) return { mode: 'accept' };
    step.times -= 1;
    if (step.times <= 0) plan.shift();
    return step;
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const step = next();
      const idempotencyKey = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null;
      const entry = {
        at: new Date(now()).toISOString(),
        method: req.method,
        path: req.url,
        mode: step.mode,
        recorded: false,
        status: null,
        userAgent: req.headers['user-agent'] ?? null,
        idempotencyKey,
      };
      requests.push(entry);
      const answer = (status, body) => {
        entry.status = status;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'POST' || req.url !== '/emails') return answer(404, { message: 'not here' });
      if (step.mode === 'refuse-key' || req.headers.authorization !== `Bearer ${key}`)
        return answer(401, { message: 'synthetic: the key was refused' });
      let parsed = null;
      try {
        parsed = shapeOf(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        parsed = null;
      }
      if (!parsed || !/^application\/json/.test(req.headers['content-type'] ?? '')) return answer(400, { message: 'not the provider shape' });
      const record = () => {
        messages.push({ ...parsed, idempotencyKey, id: randomBytes(8).toString('hex'), at: entry.at });
        entry.recorded = true;
      };
      if (step.mode === 'status')
        return answer(step.status, {
          message: `synthetic upstream refusal quoting ${parsed.to} ${parsed.subject} ${parsed.text.slice(0, 200)} ${UPSTREAM_SECRET}`,
        });
      if (step.mode === 'hang') {
        record();
        return undefined;
      }
      if (step.mode === 'drop') {
        record();
        entry.status = 'dropped';
        return req.socket.destroy();
      }
      if (idempotencyKey !== null) {
        const digest = createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
        const held = keys.get(idempotencyKey);
        if (held !== undefined && now() - held.at < DAY_MS) {
          if (held.digest !== digest)
            return answer(409, { name: 'invalid_idempotent_request', message: 'synthetic: same key, other body' });
          return answer(200, { id: held.id });
        }
        record();
        keys.set(idempotencyKey, { digest, id: messages.at(-1).id, at: now() });
        return answer(200, { id: messages.at(-1).id });
      }
      record();
      return answer(200, { id: messages.at(-1).id });
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, LOOPBACK, ok);
  });
  const { port } = server.address();
  const endpoint = `http://${LOOPBACK}:${port}/emails`;
  return {
    endpoint,
    port,
    messages,
    requests,
    /** The transport's environment, pointed here. The sender and key are synthetic. */
    env: () => ({
      ENTERPRISE_MAIL_PROVIDER: 'resend',
      ENTERPRISE_MAIL_API_KEY: key,
      ENTERPRISE_MAIL_FROM: 'Phaeacia Local <no-reply@phaeacia.example.invalid>',
      ENTERPRISE_MAIL_ENDPOINT: endpoint,
    }),
    /** The next `times` requests answer by `mode` ('status' takes { status }). */
    instruct(mode, { times = 1, status = 500 } = {}) {
      if (!MODES.has(mode)) throw new Error(`mail catcher: unknown mode ${mode}`);
      plan.push({ mode, times, status });
    },
    /** The newest recorded message to one address, or null. */
    newestTo: (address) => messages.filter((m) => m.to === address).at(-1) ?? null,
    /** Everything recorded to one address, oldest first. */
    to: (address) => messages.filter((m) => m.to === address),
    /** The catcher's clock for the idempotency window, in milliseconds; null returns it to the wall clock. */
    setNow(ms) {
      clock = ms;
    },
    reset() {
      messages.length = 0;
      requests.length = 0;
      plan.length = 0;
      keys.clear();
      clock = null;
    },
    close: () =>
      new Promise((ok) => {
        for (const s of sockets) s.destroy();
        server.close(() => ok());
      }),
  };
}
