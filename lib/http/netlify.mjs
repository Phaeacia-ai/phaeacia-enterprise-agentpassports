/* Netlify Functions adapter: web Request in, web Response out, one route
   function in between. netlify/functions/<route>.mjs files are one line of
   wiring each. Tested through toNetlify in tests/e2/unit/netlify.test.mjs,
   tests/e2/unit/passport-body.test.mjs and tests/e2/unit/route-identity.test.mjs.

   toNetlify accepts only a named route from makeRoutes(). A handler without a
   `.route` declaration or a `.routeName` is a wiring error: a TypeError when
   the function file is loaded, never a request read under an assumed
   declaration. The wrapper it returns carries the handler's own `route` and
   `routeName`, non-writable, so the object each function file hands Netlify
   states which declaration and which name it serves (pages design 4.1, O19).

   Order at the wrapper (critique M3, 2026-09-11; HTTP-D1, 2026-09-13):
     1. the maintenance switch, before anything is read from the request
        (the route repeats the check for callers that skip the adapter);
     2. the conversion, which reads nothing. fromWebRequest hands makeRequest a
        reader over the web body, and the pipeline's step 6 is the first thing
        that calls it: after the method, cross-site, session and route-id
        refusals, and after step 6's own media-type and declared-length checks.
        Until HTTP-D1 the body was read here, before the pipeline ran, so a
        failing stream answered 422 ahead of 401 and 415 and a caller with no
        session could make the function read the whole budget
        (evidence/http-bundle.md, appendix D);
     3. when called, the reader reads only for routes declared body: 'json',
        body: 'submission', body: 'passport' or body: 'signed' and only for
        non-GET/HEAD methods. Each mode has a bound, MAX_BODY_BYTES for JSON
        and for a signed body (the alerts design 2.2, ALD-R-F2) and
        MAX_PASSPORT_BYTES for a submission (JSON on the E3 write budget, E3b
        critique F1) and for a passport. A
        body declared larger than the bound by content-length is not read at
        all, and an unsized or undersized declaration is read from the stream
        until the bound plus one byte is kept, the rest cancelled, so the
        pipeline answers 413 from what was kept. The chunk that crosses that
        budget is cut to the remaining budget before it is kept, so the kept
        bytes and the one copy made of them never exceed it whatever the
        transport's chunk size (critique M3-R1, 2026-09-11: one 8 MiB chunk was
        kept and copied whole). A JSON, submission or signed body is then
        decoded as UTF-8 text, which for a signed body is the text the sender
        signed and the pipeline verifies unparsed. A
        passport body stays the Buffer and is never decoded, because decoding
        replaces invalid bytes with U+FFFD and the pinned E_NOT_UTF8 refusal
        could then never run (E3 design 2.6 item 3);
     4. a stream that fails while being read rejects the reader with
        BodyReadError, which the pipeline's body reader answers as a controlled
        422 E_BODY_INVALID with the private headers; anything that escapes the
        handler is E_INTERNAL with the error name and Netlify's shaped
        request id on stderr, the same id echoed as `requestId` in the answer
        (lane K2), and, after that line, one content-free `escaped` alert (E7
        design 1.5). The alert is
        the module's own alert(), which resolves its sink from
        ENTERPRISE_ALERT_SINK; toNetlify takes no deps, so the adapter has no
        capture seam and E7-20's third arm reads the child's stderr instead.
        Nothing the alert does changes the answer;
     5. work the route's answer carries for after it (lib/http/alerts.mjs
        afterAnswer, HKC-F1: authStart's signin_limited send) is handed to
        Netlify's context.waitUntil before the answer is returned. */

import { alert, shapeFields, workAfter } from './alerts.mjs';
import { accessState } from './pipeline.mjs';
import { BodyReadError, MAX_BODY_BYTES, MAX_PASSPORT_BYTES, makeRequest } from './request.mjs';
import { error } from './response.mjs';

/* The body modes the adapter reads, each with its bound; body: 'none' is absent and never read. pipeline.mjs
   BODY_READERS applies the same bound per mode to what is kept, and its modes less 'none' are exactly these
   (ALD-R-F2, pinned by tests/e7/unit/mail-events.test.mjs): without the 'signed' row the reader resolves null for the
   mail event route and every real event is refused. */
const BODY_BOUNDS = new Map([
  ['json', MAX_BODY_BYTES],
  ['submission', MAX_PASSPORT_BYTES],
  ['passport', MAX_PASSPORT_BYTES],
  ['signed', MAX_BODY_BYTES],
]);

/** The body modes the adapter reads, for the pin that holds them equal to the pipeline's. */
export const ADAPTER_BODY_MODES = Object.freeze([...BODY_BOUNDS.keys()]);

/* At most `budget` bytes of the stream, as one Buffer; the remainder is cancelled. A chunk is cut to the
   remaining budget before it is kept (subarray is a view, not a copy), so the kept list and the one
   Buffer.concat copy never exceed the budget, however large the transport's chunk. */
async function readBounded(req, budget) {
  if (req.body === null) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks = [];
  let kept = 0;
  try {
    while (kept < budget) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.byteLength > budget - kept ? value.subarray(0, budget - kept) : value;
      chunks.push(part);
      kept += part.byteLength;
    }
  } catch {
    throw new BodyReadError('body read failed');
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, kept);
}

/* The reader fromWebRequest hands makeRequest. Building it pulls nothing. When called it resolves null, still
   pulling nothing, for a mode the adapter does not read, for GET and HEAD, and for a declared content-length over the
   mode's bound; otherwise it resolves the kept bytes, a Buffer for a passport and UTF-8 text for JSON, a submission
   and a signed body. */
function webBodyReader(req, headers, bodyMode) {
  const bound = BODY_BOUNDS.get(bodyMode);
  return async () => {
    if (bound === undefined || req.method === 'GET' || req.method === 'HEAD') return null;
    const declared = Number.parseInt(headers['content-length'] ?? '', 10);
    if (Number.isFinite(declared) && declared > bound) return null;
    const kept = await readBounded(req, bound + 1);
    return bodyMode === 'passport' ? kept : kept.toString('utf8');
  };
}

/* bodyMode is the route's declared body; toNetlify always passes it. The 'json' default serves direct callers of
   this converter, which read JSON routes. Nothing is read here: the request's readBody() reads when it is called. */
export function fromWebRequest(req, context = {}, bodyMode = 'json') {
  const url = new URL(req.url);
  const headers = {};
  for (const [k, v] of req.headers) headers[k] = v;
  /* HTTP-D5: a plain object inherits constructor, toString and the rest, and an `in` test dropped a query name
     that collides with one. Own names only, on a null prototype so __proto__ is an ordinary name too; makeRequest
     copies them onto an ordinary frozen object. The first value of a repeated name is kept. */
  const query = Object.create(null);
  for (const [k, v] of url.searchParams) if (!Object.hasOwn(query, k)) query[k] = v;
  return makeRequest({
    method: req.method,
    path: url.pathname,
    params: context.params ?? {},
    query,
    headers,
    readBody: webBodyReader(req, headers, bodyMode),
  });
}

export function toWebResponse(res) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) headers.set(k, v);
  for (const c of res.cookies) headers.append('set-cookie', c);
  return new Response(res.body, { status: res.status, headers });
}

export function toNetlify(handler) {
  const declared = typeof handler === 'function' ? handler.route : undefined;
  if (typeof declared !== 'object' || declared === null || typeof handler.routeName !== 'string')
    throw new TypeError('toNetlify(): expected a named route from makeRoutes(), carrying route and routeName');
  const wrapper = async (req, context) => {
    if (accessState() !== 'open') return toWebResponse(error('E_MAINTENANCE'));
    try {
      const answer = await handler(fromWebRequest(req, context, declared.body));
      /* HKC-F1: work a route set to run after its answer (alerts.mjs afterAnswer) goes to Netlify's
         context.waitUntil, which keeps the function alive until it settles without holding the answer. With no
         waitUntil, or one that throws, the work runs on detached and the answer is the same. */
      const work = workAfter(answer);
      if (work !== undefined) {
        /* The property is read once and inside the guard (the peer check H5's PC-1: a getter that throws gave the
           limited answer alone a 500), and whatever it returns is settled (PC-2: a rejection was left unhandled;
           Netlify's documented waitUntil returns nothing). */
        try {
          const waitUntil = context?.waitUntil;
          if (typeof waitUntil === 'function') Promise.resolve(waitUntil.call(context, work)).catch(() => {});
        } catch {
          /* delivery after the answer is then best effort; the answer stands */
        }
      }
      return toWebResponse(answer);
    } catch (e) {
      const requestId = req?.headers?.get?.('x-nf-request-id') ?? undefined;
      process.stderr.write(
        `${JSON.stringify({ event: 'internal', ...shapeFields({ errorName: e?.name ?? 'Error', code: e?.code, requestId }) })}\n`,
      );
      try {
        await alert(
          'escaped',
          shapeFields({
            route: handler.routeName,
            code: e?.code,
            status: 500,
            companyId: context?.params?.companyId,
            requestId,
            errorName: e?.name ?? 'Error',
          }),
        );
      } catch {
        /* an alert is a notification; the answer stands */
      }
      return toWebResponse(error('E_INTERNAL', { requestId }));
    }
  };
  Object.defineProperty(wrapper, 'route', { value: declared, enumerable: true });
  Object.defineProperty(wrapper, 'routeName', { value: handler.routeName, enumerable: true });
  return wrapper;
}
