/* Request abstraction (E2 assignment: handlers are pure functions of a request
   object). A request is a frozen plain object:
     { method, path, params, query, headers, readBody }
   headers: lower-cased keys, string values; params: route parameters as strings.

   readBody() -> Promise<string | Buffer | null> is the one way to the body, and
   the pipeline's step 6 is the first thing that calls it (HTTP-D1,
   evidence/http-d1.md): a body the adapter supplies is not pulled from the
   stream until then. It is memoised, so the first call reads and every later
   call returns the same promise: a body is read at most once, and a second call
   cannot meet a stream already consumed. There is deliberately no `body`
   property. Behind the adapter nothing is read when the request is built, so a
   property holding the value for tests would hold nothing in production, and a
   handler reading it would pass its tests and fail deployed. Handlers take the
   body the pipeline hands them, `handle({ body })`.

   makeRequest({ body }) wraps a value already in hand, which is what tests pass,
   in a reader resolving to it; makeRequest({ readBody }) takes the reader the
   Netlify adapter supplies. Both meet one contract, and passing both is a
   TypeError. Either way the value is string | Buffer | null. A JSON route's body
   is raw text, of which the Netlify adapter keeps at most MAX_BODY_BYTES + 1
   bytes, or MAX_PASSPORT_BYTES + 1 for a route declared body: 'submission'
   (E3b critique F1); a passport route's body is the Buffer of bytes the client sent, never
   decoded, of which it keeps at most MAX_PASSPORT_BYTES + 1. A Uint8Array that is
   not a Buffer is viewed as one without copying, because String() would turn its
   bytes into a list of decimal numbers. Freezing the request does not freeze a
   Buffer's bytes (a typed array holding elements cannot be frozen): nothing in
   lib/http/ writes to them, and the one Buffer is handed on as it arrived.

   A reader rejects with BodyReadError when the transport fails mid-read.
   readJsonBody and readPassportBody answer that as E_BODY_INVALID and let any
   other rejection through, so a defect in a reader is 500 E_INTERNAL at the
   pipeline rather than a 422 that hides it. */

export const MAX_BODY_BYTES = 16 * 1024;

/* The raw passport bound (E3 design 2.6 item 3). The pinned upstream fixes the same number in
   vendor/passport/tools/preflight.py (MAX_BYTES = 262144) and vendor/passport/tools/scrub.py
   (MAX_INPUT_BYTES = 262144), and its validator vendor/passport/web/lib/_validate.mjs refuses above its own
   MAX_BYTES of the same value. tests/e2/unit/passport-body.test.mjs reads all three and fails when any of
   them differs from this constant, so they cannot drift apart silently. */
export const MAX_PASSPORT_BYTES = 262144;

/* The media types a passport body may declare. The pinned transport() also lets an absent or empty
   Content-Type through; the route does not, because E3 design 4.5 row 7 admits exactly these three. */
export const PASSPORT_MEDIA_TYPES = Object.freeze(['text/markdown', 'text/plain', 'application/octet-stream']);

/* The one rejection a body reader uses for a stream that failed while being read. */
export class BodyReadError extends Error {}

function bodyValue(body) {
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return body === null || body === undefined ? null : String(body);
}

/* The reader a request carries: `read` runs on the first call only, a synchronous throw becomes a rejection, and
   every call returns that first promise. */
function memoised(read) {
  let pending = null;
  return () => {
    pending ??= Promise.resolve()
      .then(() => read())
      .then(bodyValue);
    return pending;
  };
}

function mediaType(request) {
  return (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
}

function declaredLength(request) {
  return Number.parseInt(request.headers['content-length'] ?? '', 10);
}

export function makeRequest({
  method = 'GET',
  path = '/',
  params = {},
  query = {},
  headers = {},
  body = null,
  readBody,
} = {}) {
  if (readBody !== undefined) {
    if (typeof readBody !== 'function') throw new TypeError('makeRequest(): readBody is not a function');
    if (body !== null) throw new TypeError('makeRequest(): pass body or readBody, not both');
  }
  const h = {};
  for (const [k, v] of Object.entries(headers)) if (typeof v === 'string') h[k.toLowerCase()] = v;
  return Object.freeze({
    method: String(method).toUpperCase(),
    path: String(path),
    params: Object.freeze({ ...params }),
    query: Object.freeze({ ...query }),
    headers: Object.freeze(h),
    readBody: memoised(readBody ?? (() => body)),
  });
}

/* The body through the request's reader: { ok: true, value }, or E_BODY_INVALID for a stream that failed. Any other
   rejection is a defect and propagates to the pipeline's failure boundary. */
async function bodyOf(request) {
  try {
    return { ok: true, value: await request.readBody() };
  } catch (e) {
    if (e instanceof BodyReadError) return { ok: false, code: 'E_BODY_INVALID' };
    throw e;
  }
}

/**
 * readJsonBody(request) -> Promise<{ ok: true, value } | { ok: false, code }>
 * codes: E_UNSUPPORTED_MEDIA_TYPE (415), E_BODY_TOO_LARGE (413), E_BODY_INVALID (422).
 * The media type and a declared content-length are checked before the body is read; a stream that fails while
 * being read is E_BODY_INVALID. The value is always a plain JSON object; arrays, scalars and null are
 * E_BODY_INVALID.
 */
export async function readJsonBody(request, { maxBytes = MAX_BODY_BYTES } = {}) {
  if (mediaType(request) !== 'application/json') return { ok: false, code: 'E_UNSUPPORTED_MEDIA_TYPE' };
  const declared = declaredLength(request);
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, code: 'E_BODY_TOO_LARGE' };
  const read = await bodyOf(request);
  if (!read.ok) return read;
  const body = read.value;
  if (typeof body !== 'string' || body.length === 0) return { ok: false, code: 'E_BODY_INVALID' };
  if (Buffer.byteLength(body, 'utf8') > maxBytes) return { ok: false, code: 'E_BODY_TOO_LARGE' };
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, code: 'E_BODY_INVALID' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, code: 'E_BODY_INVALID' };
  return { ok: true, value };
}

/**
 * readPassportBody(request) -> Promise<{ ok: true, value: Buffer } | { ok: false, code }>
 * In this order: a media type outside PASSPORT_MEDIA_TYPES is E_UNSUPPORTED_MEDIA_TYPE (415), before anything
 * looks at the bytes; a declared content-length over MAX_PASSPORT_BYTES is E_BODY_TOO_LARGE (413), still before the
 * body is read; then the body is read, and a stream that fails is E_BODY_INVALID (422); an absent or empty body, or
 * one that is not a Buffer, is E_BODY_INVALID (422); a kept body over MAX_PASSPORT_BYTES is E_BODY_TOO_LARGE (413).
 * The value is the request's own Buffer, not decoded, validated, trimmed, normalised or copied: the gate that reads
 * it runs later and is not this module's.
 */
export async function readPassportBody(request) {
  if (!PASSPORT_MEDIA_TYPES.includes(mediaType(request))) return { ok: false, code: 'E_UNSUPPORTED_MEDIA_TYPE' };
  const declared = declaredLength(request);
  if (Number.isFinite(declared) && declared > MAX_PASSPORT_BYTES) return { ok: false, code: 'E_BODY_TOO_LARGE' };
  const read = await bodyOf(request);
  if (!read.ok) return read;
  const body = read.value;
  if (!Buffer.isBuffer(body) || body.byteLength === 0) return { ok: false, code: 'E_BODY_INVALID' };
  if (body.byteLength > MAX_PASSPORT_BYTES) return { ok: false, code: 'E_BODY_TOO_LARGE' };
  return { ok: true, value: body };
}
