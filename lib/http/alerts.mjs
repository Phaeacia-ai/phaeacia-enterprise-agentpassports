/* Content-free alerts and log lines (E7 design 1.5). This is the PURE HALF, landed by the lead before the E7 build
   (design 2.6 item 9, E7D-C-F6): the allowlist of shapes and shapeFields(). The E7 lane adds alert() (the events,
   the sink, the per-instance window) beside it. It sits in lib/http/ because the two places that see every
   function's failure, the pipeline's boundary and the adapter's catch, are here, and lib/http/ may reach lib/http/
   without a new edge in scripts/check-imports.mjs.

   The rule is an allowlist of shapes, never a list of forbidden words: a field not named below is dropped, a
   named field whose value is absent is dropped, and a named field whose value fails its pattern becomes the word
   `invalid`, so no value of a shape nobody anticipated can pass. That excludes by construction an error's message
   and stack, PostgREST's details, hint and message, a request body, a query string, any header but the request
   id, a user id, an address, a name, a token, a cookie and an upstream provider's answer. */

import { CODES, DB_CODE } from '../errors.mjs';
import { CAUSES, KINDS, ROUTED_TO } from '../rules/mail-events.mjs';

/* Codes that are not keys of CODES but are this repository's own fixed tokens or Node's network errnos, so they
   name a cause without naming content: the session verifier's four (pipeline.mjs logs them on session_refused)
   and the undici and socket errors a transport can raise. */
export const SYSTEM_CODES = Object.freeze([
  'E_NO_SESSION',
  'E_SESSION_INVALID',
  'E_SESSION_EXPIRED',
  'E_SESSION_UNAVAILABLE',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const ERROR_NAMES = Object.freeze([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'AbortError',
  'TimeoutError',
  'AppError',
  'BodyReadError',
  'MailError',
]);

const ROUTE = /^[a-z][A-Za-z]{1,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

const isCode = (v) => typeof v === 'string' && (Object.hasOwn(CODES, v) || SYSTEM_CODES.includes(v));

/** field name -> a predicate over the value, or a fixed list the value must belong to. */
export const ALERT_FIELDS = Object.freeze({
  route: (v) => typeof v === 'string' && ROUTE.test(v),
  code: isCode,
  status: (v) => Number.isInteger(v) && v >= 400 && v <= 599,
  companyId: (v) => typeof v === 'string' && UUID.test(v),
  requestId: (v) => typeof v === 'string' && REQUEST_ID.test(v),
  errorName: (v) => typeof v === 'string' && ERROR_NAMES.includes(v),
  /* The alerts design 1.2, both with their full vocabularies from the start (section 7, slice 1's day 0), so E7-20's
     key set moves once; slice 1 writes `routedTo: operator` only and never `cause: contact_address`. The words are
     lib/rules/mail-events.mjs's, where classify() produces the cause, so the allowlist cannot drift from it. */
  cause: (v) => typeof v === 'string' && CAUSES.includes(v),
  routedTo: (v) => typeof v === 'string' && ROUTED_TO.includes(v),
  /* XR-12's remainder: the database's SQLSTATE or PGRST code on an internal answer (lib/errors.mjs dbErrorCode). A
     class of failure such as 57014 (a statement timeout) or PGRST116, never a message, detail or hint. */
  dbCode: (v) => typeof v === 'string' && DB_CODE.test(v),
});

/**
 * shapeFields(fields) -> an object holding only the named fields, each either its own value (when it matches its
 * shape) or the word `invalid`; absent (undefined or null) values are dropped; unknown keys are dropped. errorName
 * outside the fixed list becomes 'Error' rather than 'invalid', because every thrown value has a class and the
 * class name is what a reader wants; a name that is not on the list says nothing safe, so it says 'Error'.
 */
export function shapeFields(fields) {
  const out = {};
  if (fields === null || typeof fields !== 'object') return out;
  for (const [key, test] of Object.entries(ALERT_FIELDS)) {
    if (!Object.hasOwn(fields, key)) continue;
    const value = fields[key];
    if (value === undefined || value === null) continue;
    if (test(value)) out[key] = value;
    else out[key] = key === 'errorName' ? 'Error' : 'invalid';
  }
  return out;
}

/* ---------- the send half (E7 design 1.5, day 6) ----------

   alert(event, fields, deps) -> Promise<void>, the only way an alert is built. The caller's answer never changes:
   this function resolves for every outcome, including a sink that throws, times out or is misconfigured, because an
   alert is a notification and a notification that fails must not turn a served request into an error (E7M-C-F1).

   WHAT IT DOES, in order:
     1. an event outside ALERT_EVENTS raises nothing at all: no record, no send, no line;
     2. the per-instance window decides whether this occurrence is an alert or a fold (below);
     3. the record is { event, ...shapeFields(fields), v: 1, at, count }, and shapeFields is the whole policy;
     4. the record is written as one JSON line to stderr, ALWAYS and FIRST. With ENTERPRISE_ALERT_SINK unset or
        `none` that line IS the alert, which is what 1.5 calls "stderr only"; with `mail` it is the function log's
        own copy, which is what lib/services/mail-templates.mjs's alertMail promises its reader in as many words;
     5. in `mail` mode the message is sent through the SAME transport as the invitations, awaited under a 1.5 s
        bound, and a send that times out or throws writes { event: 'alert_dropped' } and nothing else.

   THE WINDOW, per function instance (1.5). A map from `event + route + code + cause` to the time of the last alert
   for that key and the occurrences folded since (the alerts design 1.2 and 1.6: for `delivery_undeliverable` the key
   also holds `companyId` and `routedTo`, so a bounce in company B never folds into company A's alert and a failed
   contact mail never folds into an alert that says the contact was reached, ALD-R-F5; the five events of E7 1.5 carry
   no cause, so their key is unchanged); inside WINDOW_MS of an alert for a key, an occurrence only increments that
   count, and the count rides on the next alert for the key. `count` is the number of occurrences FOLDED INTO this
   alert, so a lone alert carries 0 and the alert after 99 folded ones carries 99 (case E7-21). Beside it, an
   instance sends at most INSTANCE_CAP alerts in any WINDOW_MS whatever the keys; a capped occurrence folds into its
   key like any other, so nothing is lost and the cap is the literal truth about how many alerts an instance sends.
   THE LIMIT, said plainly: the state lives in ONE instance, so a flood across N warm instances is at most N alerts
   per key per window, and a cold start forgets the window. A global window needs shared state (design section 7
   scenario 3). The key is built from the SHAPED route and code, not the raw ones, so an adversarial value cannot
   grow the map past the shapes the allowlist admits; entries older than the window are dropped on each call.

   WHY THE LINES DO NOT GO THROUGH deps.log. deps.log is the ROUTE's logger, and the pipeline's and the adapter's own
   stderr lines are written through it before this function is called and stay exactly as they are (1.5). This
   module's lines are its own record, so they go to stderr directly and a test reads them through deps.alertWrite.
   Routing them through deps.log instead would put a second entry into every accepted capture that asserts a route's
   log exactly (tests/e2/unit/http.test.mjs, tests/e7/unit/alerts.test.mjs), which is an accepted pin this lane may
   not move.

   THE SEAMS, all three for tests only and never set in production:
     deps.alertWrite(entry)   where the JSON lines go; default, one line to stderr
     deps.alertSink(record)   the send half; default, the mail sink when ENTERPRISE_ALERT_SINK is `mail`, else none
     deps.alertNow()          the clock the window reads; default, Date.now
   deps itself is the route's deps object, which is what lib/services/invitations.mjs already passes on. */

import { alertMail } from '../services/mail-templates.mjs';
import { mailTransport } from '../services/mail.mjs';

/** The five events of design 1.5, the alerts design's `delivery_undeliverable` (1.2: a mail event says the
    provider accepted an invitation and could not deliver it), and lane K3's `signin_limited` (XR-3: GoTrue answered
    429 to a sign-in link request, which the person never sees). Anything else raises nothing. */
export const ALERT_EVENTS = Object.freeze([
  'internal',
  'session_unavailable',
  'delivery_failed',
  'mail_not_configured',
  'escaped',
  'delivery_undeliverable',
  'signin_limited',
]);

/* The events whose fold key also holds the company and the routing (the alerts design 1.2, ALD-R-F5). Slice 2 adds
   `contact_undeliverable`. */
const KEYED_BY_COMPANY = new Set(['delivery_undeliverable']);

/** The record's version, the fold window in milliseconds, the per-instance cap in that window, and the send's bound. */
export const ALERT_VERSION = 1;
export const WINDOW_MS = 15 * 60 * 1000;
export const INSTANCE_CAP = 10;
export const SEND_BOUND_MS = 1500;

/* Per instance, and deliberately module state: a Netlify function instance is the unit the window is about. Keys are
   `event route code cause`, and for KEYED_BY_COMPANY also `companyId routedTo`, one space between, over SHAPED values
   (no shape the allowlist admits holds a space); sends is the times of this instance's last alerts. */
const folded = new Map();
let sends = [];

/** resetAlertWindow(): forget this instance's window. For tests; nothing in the product calls it. */
export function resetAlertWindow() {
  folded.clear();
  sends = [];
}

function writeLine(deps, entry) {
  const write = typeof deps?.alertWrite === 'function' ? deps.alertWrite : null;
  if (write) {
    write(entry);
    return;
  }
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

/**
 * alertSink(env) -> ((record) => Promise<void>) | null
 * The mail sink: one message to ENTERPRISE_ALERT_TO through the invitations' own transport, subject and text from
 * alertMail, tagged `kind: enterprise-alert` (the alerts design 1.9, namespaced by ALD-R-F15's fallback), so a mail
 * event about an alert's own failure is recognised and never answered with a mail (1.6's loop bound). Null when the sink is not `mail`, when no recipient is configured or when the transport is not ready,
 * because a sink that cannot send is the same as no sink and the stderr line is already written. The deploy check's
 * D16 is what refuses that configuration at deploy time rather than at the first fault.
 * Exported so scripts/alert-test.mjs sends through THIS sink and not through a copy of it, which is the whole of
 * what "the sink proven alone" means (design 1.5, H-L1).
 */
export function alertSink(env) {
  if (env?.ENTERPRISE_ALERT_SINK !== 'mail') return null;
  const to = env.ENTERPRISE_ALERT_TO;
  if (typeof to !== 'string' || to.length === 0) return null;
  const transport = mailTransport(env);
  if (!transport.ready()) return null;
  return async (record) => {
    const { subject, text } = alertMail(record);
    await transport.deliver({ to, subject, text, tags: { kind: KINDS.alert } });
  };
}

/* The send under its bound. Resolves `true` when the sink answered inside SEND_BOUND_MS, `false` when it timed out or
   threw. The sink's own promise may settle later (the transport's fetch bound is 5 s, above this one), so its
   rejection is swallowed here rather than left to become an unhandled rejection in a function that has answered. */
async function bounded(promise) {
  let timer;
  const settled = promise.then(
    () => true,
    () => false,
  );
  const bound = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), SEND_BOUND_MS);
  });
  try {
    return await Promise.race([settled, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/* The window's decision for one occurrence: { alert: true, count } or { alert: false }. Called once per occurrence,
   and it is the only writer of the module's state. An entry is dropped only when its window has closed AND it holds
   no folded occurrence, so a fold is never lost to pruning; `at: -Infinity` is an entry that has never alerted, which
   is what a capped first occurrence leaves behind. */
function windowDecision(key, now) {
  for (const [k, e] of folded) if (now - e.at >= WINDOW_MS && e.count === 0) folded.delete(k);
  sends = sends.filter((t) => now - t < WINDOW_MS);
  const entry = folded.get(key);
  if (entry !== undefined && now - entry.at < WINDOW_MS) {
    entry.count += 1;
    return { alert: false };
  }
  if (sends.length >= INSTANCE_CAP) {
    /* Capped: fold it so the next alert for this key carries it, and send nothing. The route's own stderr line is
       already in the function log, so the occurrence is recorded even though no alert is. */
    if (entry === undefined) folded.set(key, { at: -Infinity, count: 1 });
    else entry.count += 1;
    return { alert: false };
  }
  const count = entry?.count ?? 0;
  folded.set(key, { at: now, count: 0 });
  sends.push(now);
  return { alert: true, count };
}

/**
 * alert(event, fields, deps) -> Promise<void>
 * One content-free alert. Resolves whatever happens; throws nothing, ever.
 */
export async function alert(event, fields = {}, deps = {}) {
  if (typeof event !== 'string' || !ALERT_EVENTS.includes(event)) return;
  try {
    const shaped = shapeFields(fields);
    const now = typeof deps.alertNow === 'function' ? deps.alertNow() : Date.now();
    const key = KEYED_BY_COMPANY.has(event)
      ? `${event} ${shaped.route ?? ''} ${shaped.code ?? ''} ${shaped.cause ?? ''} ${shaped.companyId ?? ''} ${shaped.routedTo ?? ''}`
      : `${event} ${shaped.route ?? ''} ${shaped.code ?? ''} ${shaped.cause ?? ''}`;
    const decision = windowDecision(key, Number.isFinite(now) ? now : Date.now());
    if (!decision.alert) return;
    const record = {
      event,
      ...shaped,
      v: ALERT_VERSION,
      at: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
      count: decision.count,
    };
    writeLine(deps, record);
    const sink = typeof deps.alertSink === 'function' ? deps.alertSink : alertSink(process.env);
    if (sink === null) return;
    let sent;
    try {
      sent = await bounded(Promise.resolve(sink(record)));
    } catch {
      sent = false;
    }
    if (!sent) writeLine(deps, { event: 'alert_dropped' });
  } catch {
    /* Nothing a sink, a clock or a renderer does changes the caller's answer. The route's own stderr line is already
       written, so the fault is still in the function log even when this function records nothing. */
  }
}

/* ---------- work after the answer (HKC-F1) ----------

   Most alerts ride on an answer that already says what happened (a 500, a 503), and the pipeline awaits them. An
   alert raised on a path that must answer exactly like its neighbours cannot be awaited: authStart answers every
   address with the same 204, and awaiting its `signin_limited` send made the first 429 of a window answer about
   SEND_BOUND_MS late while every other GoTrue answer came at once, which told the caller what GoTrue had said (the Codex
   critique of lane K, HKC-F1). Such a route calls alert() without awaiting it, which still writes the fold record
   before it returns (steps 1 to 4 above run before its first await), and answers afterAnswer(answer, sending).

   afterAnswer returns a frozen copy of the answer carrying the send, settled so that it never rejects, under a symbol
   that is not enumerable: toWebResponse reads status, headers, cookies and body only, and a comparison of two answers
   sees nothing of it, so the caller receives exactly what it did before. lib/http/netlify.mjs reads it with workAfter()
   and hands it to Netlify's context.waitUntil, which keeps the function running after the answer is sent until the
   promise settles ("extend the function's execution until the given Promise is completed, without blocking the
   response to the client from being sent", docs.netlify.com/build/functions/api/, Context object, `waitUntil`; for
   functions deployed on or after 2025-03-20). The send is bounded by SEND_BOUND_MS as before, so that is how long it
   holds the function. Without the adapter or without waitUntil (the dev shell, a direct call of the route) the send
   runs on detached, and its delivery after the answer is best effort: a platform may freeze the function first.

   Why the answer carries it rather than the request: waitUntil is per invocation, the route sees only the frozen
   request makeRequest builds, and a store shared across calls (node:async_hooks, a built-in scripts/check-imports.mjs
   refuses under lib/, or a module variable, which concurrent requests would overwrite) would be state nobody sees. */
const AFTER = Symbol('work after the answer');

/**
 * afterAnswer(answer, work) -> the same answer, carrying `work` for the adapter to hand to the platform.
 * `work` is a promise or a value; what is carried resolves undefined when it settles, whichever way.
 */
export function afterAnswer(answer, work) {
  const settled = Promise.resolve(work).then(
    () => undefined,
    () => undefined,
  );
  return Object.freeze(Object.defineProperty({ ...answer }, AFTER, { value: settled }));
}

/** workAfter(answer) -> the promise afterAnswer attached, or undefined. For lib/http/netlify.mjs. */
export function workAfter(answer) {
  const work = answer?.[AFTER];
  return work instanceof Promise ? work : undefined;
}
