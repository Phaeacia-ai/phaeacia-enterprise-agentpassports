/* Response abstraction. A response is a frozen plain object:
     { status, headers, cookies, body }
   headers always carry Cache-Control: private, no-store (design section 8.3),
   nosniff, no-referrer and a Content-Security-Policy of default-src 'none'
   with frame-ancestors 'none' (lane K5, XR-4: an API answer is data, never a
   document, so nothing it could be rendered as may load or frame anything;
   the pages keep their own policy from netlify.toml); cookies is a list of
   Set-Cookie values; body is a string or null. Error bodies are
   { ok: false, code, message } from lib/errors.mjs, followed only by the keys
   of the data an AppError carries when the pipeline's boundary answers it:
   `problems` for a gate refusal (E3 design 3.5, E3b critique F4), and by one
   key error() below may add: `requestId`, Netlify's request id, on an
   E_INTERNAL answer only and only when it has the shape lib/http/alerts.mjs
   ALERT_FIELDS admits, so that a person shown the failure can quote it and the
   operator can find the function log's line for it (lane K2, XR-12). The
   message stays the fixed sentence. Nothing else, and error() adds no other
   key. */

import { CODES, errorBody } from '../errors.mjs';
import { ALERT_FIELDS } from './alerts.mjs';

const PRIVATE_HEADERS = Object.freeze({
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
});

function build(status, { headers = {}, cookies = [], body = null } = {}) {
  return Object.freeze({
    status,
    headers: Object.freeze({ ...PRIVATE_HEADERS, ...headers }),
    cookies: Object.freeze([...cookies]),
    body,
  });
}

export function json(status, value, { cookies } = {}) {
  return build(status, {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    cookies,
    body: JSON.stringify(value),
  });
}

export function noContent({ cookies } = {}) {
  return build(204, { cookies });
}

/** error(code, { cookies, requestId }): the fixed body for a code. requestId is the request's x-nf-request-id; it
    joins the body only when the code answered is E_INTERNAL and the value has the request id's shape. */
export function error(code, { cookies, requestId } = {}) {
  const body = errorBody(code);
  if (body.code === 'E_INTERNAL' && ALERT_FIELDS.requestId(requestId)) body.requestId = requestId;
  return json(CODES[body.code], body, { cookies });
}
