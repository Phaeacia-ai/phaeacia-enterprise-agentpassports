/* The protected-route pipeline (architecture section 5 as amended, design 8.3).

   Order, per request, and only this order:
     1. maintenance switch: ENTERPRISE_ACCESS_STATE must be exactly 'open',
        else 503 E_MAINTENANCE before anything is read from the request
        (case 24; unset is closed);
     2. method, else 405;
     3. cross-site refusal for mutations: a Sec-Fetch-Site of cross-site, or
        an Origin that is not ENTERPRISE_ORIGIN, the literal 'null' included
        (ENA-5: until then 'null' was admitted whatever else the request said),
        is 403 (defense in depth next to SameSite=Strict cookies and the JSON
        content type, which already deny cross-site form posts). When that
        variable is unset or not a valid origin, every such Origin is refused
        (lane K1, XR-2: until then an unset variable admitted every Origin); a
        request that carries no Origin is admitted, because the Svix webhook
        sends none;
     4. verifySession from the cookie, else 401 with the generic code; the
        specific code is logged, not returned. When the signing keys cannot
        be loaded at all (E_SESSION_UNAVAILABLE) a required session answers
        503 E_SESSION_UNAVAILABLE and an optional one proceeds without a
        session, so sign-out still clears the cookies (critique M4);
     5. route parameters that must be uuids, else 404 (unknown and malformed
        ids answer alike);
     6. the body the route declares, else 415, 413 or 422. This is the first
        step that reads it: nothing before it calls request.readBody(), so a
        failing or oversized stream cannot pre-empt steps 1 to 5, and each
        reader checks the media type and a declared content-length before it
        pulls a byte (HTTP-D1, evidence/http-d1.md). For body: 'json' the
        parsed JSON object (readJsonBody); for body: 'submission' the same,
        read under MAX_PASSPORT_BYTES instead of MAX_BODY_BYTES, because the
        submit route's legal metadata exceeds the E2 bound and E3 design 4.5
        row 8 gives every E3 write 262,144 (E3b critique F1); for body:
        'passport' the raw
        Buffer (readPassportBody), which this pipeline never decodes,
        validates, trims or normalises, because the gate that reads it runs
        later (E3 design 2.6 item 3); for body: 'signed' the raw text,
        application/json under MAX_BODY_BYTES and never parsed, because a
        signature is over the body as sent and parsing and re-serialising
        breaks it (the alerts design 1.4 and 2.2: the mail event route
        verifies before it parses); for body: 'none' nothing is read;
     7. the route function, which calls one service; AppErrors map to their
        status and code, with the keys of the data one carries (a gate
        refusal's problem list) after ok, code and message, and each is
        logged once as a refused event with its code and status (E3b
        critique F4); anything else is 500 E_INTERNAL with the error name
        and, when it is a string, its code logged and nothing else. Both
        lines carry Netlify's request id (x-nf-request-id) through
        shapeFields, and an E_INTERNAL answer, thrown or refused, echoes it
        as `requestId` for the person to quote (lane K2, XR-12).
   Steps 4 to 7 run inside one failure boundary: nothing the verifier or the
   route throws leaves the handler as a rejection, and no exception text is
   logged. No result is cached; the session and the principal live for one
   request.

   E7 design 1.5: after its stderr line, and only after it, the boundary
   raises one content-free alert through lib/http/alerts.mjs. deps.alert is
   the test seam, exactly as deps.log is for the line; with none wired the
   module's own alert() runs, which resolves its sink from
   ENTERPRISE_ALERT_SINK, so every route alerts in production without a
   per-file wiring line. Which event: `internal` for anything that is not an
   AppError and for an AppError that answers 500 (E_INTERNAL from a database
   or invariant fault, E_ASSEMBLY_DIVERGED; not E_READ_OVER_BOUND, the
   expected 500 of a read past its ceiling), whose line and alert also carry
   the database's SQLSTATE or PGRST code when it has one (XR-12's remainder);
   `mail_not_configured` for that one 503 refusal; and nothing at all for
   every other refusal, because a refusal is the product working (1.5, case
   E7-22). `session_unavailable` is raised at its own log site in
   step 4, which returns rather than throwing, so the boundary never sees it;
   that second call is the lead's grant of 2026-09-20. An alert never changes
   the answer: alert() resolves for every outcome, and the call is wrapped
   besides, so even a capture that throws cannot turn a served request into an
   error.

   The declaration is checked when route() is called, so a wrong one fails
   when lib/http/routes.mjs is loaded and not at request time (pages design
   4.1): method, session and body from their fixed sets; a GET declaring
   body: 'none', since the adapter never reads a GET body; path a string
   starting /api/ whose segments are each a lower-case literal or :name,
   naming no parameter twice; every uuidParams entry a parameter of that
   path. The returned handler carries a non-writable
   `.route = { method, session, body, path }`: the Netlify adapter reads the
   body mode from it, and the wiring test compares its path and method with
   each function file's own config. makeRoutes() adds the route's name. */

import { AppError, errorBody } from '../errors.mjs';
import { alert, shapeFields } from './alerts.mjs';
import { acceptOrigin } from '../services/invitations.mjs';
import { verifySession } from '../session.mjs';
import { BodyReadError, MAX_BODY_BYTES, MAX_PASSPORT_BYTES, readJsonBody, readPassportBody } from './request.mjs';
import { error, json } from './response.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const METHODS = new Set(['GET', ...MUTATING]);
const SESSIONS = new Set(['required', 'optional', 'none']);
/* The one 500 that is a refusal and not a fault: a read that must be complete, refused past its ceiling rather than
   answered in part (lib/errors.mjs E_READ_OVER_BOUND). docs/e8/design.md 7.2 item 2 classifies it as an expected 500,
   and it holds for as long as a company stays over the ceiling, so alerting on it would fill the operator's channel
   from one tenant (review of the xr-residuals branch, XR12-R2). It keeps its refused line. The set is pinned on its own
   by tests/e7/unit/alerts.test.mjs (XR-12) and tests/e8/unit/stderr-shape.test.mjs (E8-6 pure), which name the code
   rather than reading this constant: a second entry here changes those two files too (RC-XR12-2). */
const EXPECTED_500 = new Set(['E_READ_OVER_BOUND']);
/**
 * readSignedBody(request) -> Promise<{ ok: true, value: string } | { ok: false, code }>
 * The alerts design 2.2's 'signed' mode, in readJsonBody's order and with its codes, less the parse: a media type
 * other than application/json is 415 before anything is read; a declared content-length over MAX_BODY_BYTES is 413,
 * still unread; a stream that fails is 422 E_BODY_INVALID, as is an absent, empty or non-text body; kept text over
 * the bound is 413. The value is the text exactly as the adapter decoded it, which is what the sender signed. It
 * lives here and not in request.mjs because this lane owns the pipeline and not the request module.
 */
async function readSignedBody(request) {
  const type = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return { ok: false, code: 'E_UNSUPPORTED_MEDIA_TYPE' };
  const declared = Number.parseInt(request.headers['content-length'] ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false, code: 'E_BODY_TOO_LARGE' };
  let body;
  try {
    body = await request.readBody();
  } catch (e) {
    if (e instanceof BodyReadError) return { ok: false, code: 'E_BODY_INVALID' };
    throw e;
  }
  if (typeof body !== 'string' || body.length === 0) return { ok: false, code: 'E_BODY_INVALID' };
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return { ok: false, code: 'E_BODY_TOO_LARGE' };
  return { ok: true, value: body };
}

/* netlify.mjs BODY_BOUNDS states the same bound per mode for the bytes the adapter keeps, and holds the same modes
   less 'none' (ALD-R-F2: a mode the adapter does not list resolves null there, so every real request of that mode
   would be refused while a test built on makeRequest({ body }) passed; tests/e7/unit/mail-events.test.mjs pins the
   two key sets equal). */
const BODY_READERS = new Map([
  ['json', readJsonBody],
  ['submission', (request) => readJsonBody(request, { maxBytes: MAX_PASSPORT_BYTES })],
  ['passport', readPassportBody],
  ['signed', readSignedBody],
  ['none', null],
]);

/** The body modes a route may declare, for the pin that holds the adapter's modes equal to these. */
export const BODY_MODES = Object.freeze([...BODY_READERS.keys()]);
const LITERAL_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const PARAM_SEGMENT = /^:[A-Za-z][A-Za-z0-9]*$/;

export function accessState() {
  return process.env.ENTERPRISE_ACCESS_STATE === 'open' ? 'open' : 'closed';
}

function defaultLog(entry) {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

/* Step 3. The configured origin is read through acceptOrigin(), the one reader of ENTERPRISE_ORIGIN's shape
   (lib/services/invitations.mjs), so the invitation link and this guard cannot disagree about what a valid value is;
   null there (unset, empty, a path, a trailing slash, not http or https) means no Origin can match (K1).
   The literal Origin 'null' is an Origin like any other and never equals a valid ENTERPRISE_ORIGIN, so it is refused
   (ENA-5). No request the site makes carries it: its mutations are cors-mode fetch() calls, which keep the page's
   origin under Referrer-Policy: no-referrer, and no form submits natively (form-action 'none'). A form post, and in
   Firefox a no-cors fetch or a beacon, is what a browser sends as 'null' there (evidence/xr-residuals.md 2.2). A
   sibling subdomain that sets no-referrer and posts a form carries 'null' and the SameSite=Strict cookies, and before
   ENA-5 it passed. */
function crossSite(request) {
  const site = request.headers['sec-fetch-site'];
  if (site === 'cross-site') return true;
  const origin = request.headers.origin;
  if (typeof origin !== 'string') return false;
  const expected = acceptOrigin();
  return expected === null || origin !== expected;
}

function refuseDeclaration(what) {
  throw new TypeError(`route(): ${what}`);
}

function checkDeclaration({ method, path, uuidParams, session, body, handle }) {
  const show = JSON.stringify;
  if (!METHODS.has(method)) refuseDeclaration(`method ${show(method)} is not one of ${[...METHODS].join(', ')}`);
  if (!SESSIONS.has(session)) refuseDeclaration(`session ${show(session)} is not one of ${[...SESSIONS].join(', ')}`);
  if (!BODY_READERS.has(body))
    refuseDeclaration(`body ${show(body)} is not one of ${[...BODY_READERS.keys()].join(', ')}`);
  if (method === 'GET' && body !== 'none') refuseDeclaration(`a GET route declares body 'none', not ${show(body)}`);
  if (typeof handle !== 'function') refuseDeclaration('handle is not a function');
  if (typeof path !== 'string' || !path.startsWith('/api/'))
    refuseDeclaration(`path ${show(path)} is not a string starting /api/`);
  const params = [];
  for (const segment of path.slice(1).split('/')) {
    if (PARAM_SEGMENT.test(segment)) params.push(segment.slice(1));
    else if (!LITERAL_SEGMENT.test(segment))
      refuseDeclaration(`path ${show(path)} has segment ${show(segment)}, which is neither a literal nor :name`);
  }
  if (new Set(params).size !== params.length) refuseDeclaration(`path ${show(path)} names a parameter twice`);
  if (!Array.isArray(uuidParams)) refuseDeclaration('uuidParams is not an array');
  for (const p of uuidParams)
    if (!params.includes(p)) refuseDeclaration(`uuidParams names ${show(p)}, which is not a parameter of ${path}`);
}

/**
 * route({ method, path, uuidParams, session, body, handle }, deps) -> async (request) => response
 *   path: mandatory, '/api/' then literal and :name segments
 *   session: 'required' (default) | 'optional' | 'none'
 *   body: 'json' (default) | 'submission' | 'passport' | 'signed' | 'none'
 *   handle({ request, session, params, body, deps }) -> response; body is the parsed object for
 *   'json' and 'submission', the request's Buffer for 'passport', the raw text for 'signed' and null for 'none'
 * Throws TypeError, when called, for a declaration it refuses.
 */
export function route({ method, path, uuidParams = [], session = 'required', body = 'json', handle }, deps = {}) {
  checkDeclaration({ method, path, uuidParams, session, body, handle });
  const bodyReader = BODY_READERS.get(body);
  const log = deps.log ?? defaultLog;
  /* One content-free alert, after the stderr line (E7 design 1.5). The fields are the route's own name, the code, the
     status answered, the company id ONLY once step 5 has accepted it as a uuid, Netlify's request id and the thrown
     value's class. shapeFields in alerts.mjs is the policy and alert() applies it again, but the boundary applies it
     HERE too, before the value crosses the call: E7-20 reads the capture at deps.alert, and a raw e.name or e.code
     handed to a capture would be a raw value out of this module even though the record built from it is clean.
     Shaping twice is idempotent (a shaped value passes its own pattern or is already the word `invalid`). */
  const raise = async (event, fields) => {
    try {
      await (deps.alert ?? alert)(event, shapeFields(fields), deps);
    } catch {
      /* an alert is a notification; the answer stands */
    }
  };
  const handler = async (request) => {
    /* Set at step 5 and read by raise(): before the uuid check a :companyId is whatever the caller sent. */
    let companyId;
    const requestId = request.headers['x-nf-request-id'];
    if (accessState() !== 'open') return error('E_MAINTENANCE');
    if (request.method !== method) return error('E_METHOD_NOT_ALLOWED');
    if (MUTATING.has(method) && crossSite(request)) return error('E_CROSS_SITE');
    try {
      let verified = null;
      if (session !== 'none') {
        const v = await verifySession(request);
        if (v.ok) verified = v.session;
        else if (v.code === 'E_SESSION_UNAVAILABLE') {
          log({ event: 'session_unavailable' });
          await raise('session_unavailable', { route: handler.routeName, code: v.code, status: 503, requestId });
          if (session === 'required') return error('E_SESSION_UNAVAILABLE');
        } else {
          log({ event: 'session_refused', ...shapeFields({ code: v.code }) });
          if (session === 'required') return error('E_UNAUTHENTICATED');
        }
      }
      const params = {};
      for (const [k, v] of Object.entries(request.params)) params[k] = typeof v === 'string' ? v.toLowerCase() : '';
      for (const p of uuidParams) if (!UUID.test(params[p] ?? '')) return error('E_NOT_FOUND');
      if (uuidParams.includes('companyId')) companyId = params.companyId;
      let parsed = null;
      if (bodyReader) {
        const b = await bodyReader(request);
        if (!b.ok) return error(b.code);
        parsed = b.value;
      }
      return await handle({ request, session: verified, params, body: parsed, deps });
    } catch (e) {
      if (e instanceof AppError) {
        /* XR-12's remainder: an AppError that answers 500 is a fault, not a refusal, EXPECTED_500 aside. Its line
           carries the database's code when the fault came from PostgREST, and it raises `internal` as a thrown fault
           does, which is the event design 1.5 names for 500 E_INTERNAL, E_ASSEMBLY_DIVERGED included. */
        const fault = e.status === 500 && !EXPECTED_500.has(e.code);
        const dbCode = fault ? e.cause?.dbCode : undefined;
        log({ event: 'refused', code: e.code, status: e.status, ...shapeFields({ requestId, dbCode }) });
        if (fault)
          await raise('internal', {
            route: handler.routeName,
            code: e.code,
            status: e.status,
            companyId,
            requestId,
            errorName: 'AppError',
            dbCode,
          });
        if (e.code === 'E_MAIL_NOT_CONFIGURED')
          await raise('mail_not_configured', {
            route: handler.routeName,
            code: e.code,
            status: e.status,
            companyId,
            requestId,
          });
        /* K2: an E_INTERNAL AppError answers the same fixed body as a thrown fault, request id included. */
        if (e.code === 'E_INTERNAL') return error('E_INTERNAL', { requestId });
        return json(e.status, errorBody(e.code, e.data));
      }
      /* E7D-C-F6: the thrown value's name and code pass through the alert allowlist, never raw (E7 design 1.5). */
      log({ event: 'internal', ...shapeFields({ errorName: e?.name ?? 'Error', code: e?.code, requestId }) });
      await raise('internal', {
        route: handler.routeName,
        code: e?.code,
        status: 500,
        companyId,
        requestId,
        errorName: e?.name ?? 'Error',
      });
      return error('E_INTERNAL', { requestId });
    }
  };
  Object.defineProperty(handler, 'route', {
    value: Object.freeze({ method, session, body, path }),
    enumerable: true,
  });
  return handler;
}
