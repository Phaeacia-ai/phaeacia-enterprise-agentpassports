/* The pure half of lib/http/alerts.mjs (E7 design 1.5, 2.6 item 9; E7D-C-F6): an allowlist of shapes, and the two
   log sites written through it. The regression: at 1036b40 the pipeline's `internal` line carried a thrown value's
   name and code raw (the critique's probe, existing_pipeline_logs_unshaped_error_name=true), so a synthetic tenant
   string in either reached stderr. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { hs256, userClaims } from '../../e2/helpers/jwt.mjs';

const SECRET = 'example-unit-secret-with-at-least-32-characters-long';
const BASE = 'http://127.0.0.1:54321';
process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = SECRET;
process.env.ENTERPRISE_ACCESS_STATE = 'open';
process.env.ENTERPRISE_ORIGIN = 'https://enterprise.example.invalid';
const { COOKIES } = await import('../../../lib/session.mjs');
const { ALERT_FIELDS, SYSTEM_CODES, shapeFields } = await import('../../../lib/http/alerts.mjs');
const { route } = await import('../../../lib/http/pipeline.mjs');
const { AppError, CODES } = await import('../../../lib/errors.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const SUB = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11';
const cookie = `${COOKIES.access}=${hs256(userClaims({ sub: SUB, email: 's@example.invalid', issuer: `${BASE}/auth/v1` }), SECRET)}`;

const PRIVATE = 'synthetic-tenant-private-sentence';
const UUID = 'aaaaaaaa-1111-4222-8333-444444444444';

test('shapeFields keeps only the named fields, each its own value or the word invalid; absent values are dropped', () => {
  /* The alerts design 1.2 adds `cause` and `routedTo`, each a fixed vocabulary, at the end so the order of the six
     before them is unchanged. */
  assert.deepEqual(Object.keys(ALERT_FIELDS), [
    'route',
    'code',
    'status',
    'companyId',
    'requestId',
    'errorName',
    'cause',
    'routedTo',
    'dbCode',
  ]);
  /* XR-12's remainder: the database's code, a SQLSTATE or a PGRST code, and nothing else of that shape. */
  for (const dbCode of ['57014', '42P01', 'P0001', 'PGRST116', 'PGRST301'])
    assert.deepEqual(shapeFields({ dbCode }), { dbCode }, dbCode);
  for (const v of [PRIVATE, '5701', '570144', 'pgrst116', 'PGRST1166', '57014 ', 'E_INTERNAL', 57014, {}])
    assert.deepEqual(shapeFields({ dbCode: v }), { dbCode: 'invalid' }, String(v));
  for (const cause of ['recipient_permanent', 'recipient_temporary', 'suppressed', 'undetermined', 'contact_address'])
    assert.deepEqual(shapeFields({ cause }), { cause }, cause);
  for (const routedTo of ['operator', 'operator_no_contact', 'operator_and_contact', 'operator_contact_failed'])
    assert.deepEqual(shapeFields({ routedTo }), { routedTo }, routedTo);
  for (const v of [PRIVATE, 'Permanent', 'someone@example.invalid', 3, {}])
    assert.deepEqual(shapeFields({ cause: v, routedTo: v }), { cause: 'invalid', routedTo: 'invalid' }, String(v));
  assert.deepEqual(
    shapeFields({ route: 'invitationsCreate', code: 'E_NOT_FOUND', status: 404, companyId: UUID, requestId: 'abc-123', errorName: 'TypeError' }),
    { route: 'invitationsCreate', code: 'E_NOT_FOUND', status: 404, companyId: UUID, requestId: 'abc-123', errorName: 'TypeError' },
  );
  /* Every value that fails its shape becomes `invalid`, and an unknown key never passes. */
  const shaped = shapeFields({
    route: PRIVATE,
    code: PRIVATE,
    status: 200,
    companyId: PRIVATE,
    requestId: `${PRIVATE} ${PRIVATE}`,
    message: PRIVATE,
    details: PRIVATE,
    stack: PRIVATE,
    hint: PRIVATE,
  });
  assert.deepEqual(shaped, { route: 'invalid', code: 'invalid', status: 'invalid', companyId: 'invalid', requestId: 'invalid' });
  assert.equal(JSON.stringify(shaped).includes(PRIVATE), false);
  /* errorName outside the fixed list says Error, not invalid: a class name a reader wants, a value nobody trusts. */
  assert.deepEqual(shapeFields({ errorName: PRIVATE }), { errorName: 'Error' });
  assert.deepEqual(shapeFields({ errorName: 'RangeError' }), { errorName: 'RangeError' });
  /* Absent values are dropped, not written as invalid; a non-object is nothing. */
  assert.deepEqual(shapeFields({ code: undefined, status: null, errorName: 'Error' }), { errorName: 'Error' });
  assert.deepEqual(shapeFields(null), {});
  assert.deepEqual(shapeFields('x'), {});
  /* The session verifier's own tokens and the network errnos are codes; a number is not. */
  for (const c of SYSTEM_CODES) assert.deepEqual(shapeFields({ code: c }), { code: c }, c);
  assert.deepEqual(shapeFields({ code: 503 }), { code: 'invalid' });
});

test('the pipeline internal line carries no thrown name or code raw (E7D-C-F6; fails on the 1036b40 pipeline)', async () => {
  const seen = [];
  const r = route(
    {
      method: 'POST',
      path: '/api/probe',
      handle: async () => {
        const e = new Error(`database said: ${PRIVATE}`);
        e.name = `${PRIVATE}-name`;
        e.code = `${PRIVATE}-code`;
        throw e;
      },
    },
    { log: (entry) => seen.push(entry) },
  );
  const res = await r(
    makeRequest({
      method: 'POST',
      path: '/api/probe',
      headers: { cookie, 'content-type': 'application/json', origin: 'https://enterprise.example.invalid', 'sec-fetch-site': 'same-origin' },
      body: '{}',
    }),
  );
  assert.equal(res.status, 500);
  assert.equal(JSON.stringify(seen).includes(PRIVATE), false, JSON.stringify(seen));
  assert.deepEqual(seen, [{ event: 'internal', errorName: 'Error', code: 'invalid' }]);
});

/* ---------- the send half (E7 design 1.5, day 6): cases E7-20's second arm, E7-21, E7-22 ----------

   Fail-before: E7_ALERTS_MODULE names a mutant of the module (evidence/e7-checks-repro/mutants/), loaded in place of
   it for the send half, and these cases fail against it: M-A2 spreads the field set raw instead of through
   shapeFields, so E7-20's second arm finds the synthetic strings; M-A1 awaits the sink with no bound and writes no
   line when it throws, so the two E7M-C-F1 cases fail at the bound and at the missing line. The variable exists for
   that demonstration only; scripts/check.sh never sets it. The pure half above stays on the real module, because the
   pipeline pin is about the code that ships. */

const {
  ALERT_EVENTS,
  ALERT_VERSION,
  INSTANCE_CAP,
  SEND_BOUND_MS,
  WINDOW_MS,
  alert,
  resetAlertWindow,
} = await import(
  process.env.E7_ALERTS_MODULE
    ? pathToFileURL(process.env.E7_ALERTS_MODULE).href
    : new URL('../../../lib/http/alerts.mjs', import.meta.url).href
);
const { alertMail } = await import('../../../lib/services/mail-templates.mjs');

/* A clock the window reads and a capture of the module's own JSON lines and of its sink, so no case depends on
   wall-clock time or on reading the child's stderr. All three are deps seams the product never sets. */
function capture({ at = 1_700_000_000_000, sink } = {}) {
  const lines = [];
  const sent = [];
  let now = at;
  return {
    lines,
    sent,
    tick: (ms) => {
      now += ms;
    },
    deps: {
      alertWrite: (entry) => lines.push(entry),
      alertNow: () => now,
      alertSink: sink ?? ((record) => void sent.push(record)),
    },
  };
}
const alerts = (c) => c.lines.filter((l) => l.event !== 'alert_dropped');

test('E7-20 second arm: alert() fed adversarial field values carries the allowlist and nothing else', async () => {
  resetAlertWindow();
  const c = capture();
  await alert(
    'internal',
    {
      route: `${PRIVATE}-route`,
      code: `select * from passports -- ${PRIVATE}`,
      status: 200,
      companyId: `${UUID} ${PRIVATE}`,
      requestId: `${PRIVATE}\n${PRIVATE}`,
      errorName: PRIVATE,
      cause: `${PRIVATE} the recipient's mail server said no`,
      routedTo: 'someone@example.invalid',
      dbCode: `57014\n${PRIVATE}`,
      message: `database said: ${PRIVATE}`,
      details: PRIVATE,
      hint: PRIVATE,
      stack: `Error: ${PRIVATE}\n    at handler`,
      email: 'someone@example.invalid',
      body: { passport: PRIVATE },
    },
    c.deps,
  );
  assert.equal(alerts(c).length, 1);
  const [record] = alerts(c);
  /* The key set is EXACTLY the event, the nine allowlisted fields and the three the module adds (the alerts design
     1.2 moved it once, adding `cause` and `routedTo`; XR-12's remainder added `dbCode`). */
  assert.deepEqual(Object.keys(record).sort(), [
    'at',
    'cause',
    'code',
    'companyId',
    'count',
    'dbCode',
    'errorName',
    'event',
    'requestId',
    'route',
    'routedTo',
    'status',
    'v',
  ]);
  assert.deepEqual(record, {
    event: 'internal',
    route: 'invalid',
    code: 'invalid',
    status: 'invalid',
    companyId: 'invalid',
    requestId: 'invalid',
    errorName: 'Error',
    cause: 'invalid',
    routedTo: 'invalid',
    dbCode: 'invalid',
    v: ALERT_VERSION,
    at: new Date(1_700_000_000_000).toISOString(),
    count: 0,
  });
  /* Neither the record nor the mail rendered from it carries any of the strings. */
  const { subject, text } = alertMail(record);
  for (const haystack of [JSON.stringify(record), subject, text])
    assert.equal(haystack.includes(PRIVATE), false, haystack);
  assert.equal(`${subject}${text}`.includes('example.invalid'), false);
  /* `at` matches alertMail's own pattern, so the renderer never prints the word invalid for the module's own field. */
  assert.match(record.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
  assert.equal(text.includes('At: invalid'), false);
  assert.match(text, /^Database code: invalid$/m);
});

test('XR-12: the alert mail prints a database code of DB_CODE shape and the word invalid for anything else', () => {
  const base = { event: 'internal', route: 'reviewRead', code: 'E_INTERNAL', status: 500, v: 1, count: 0 };
  for (const dbCode of ['57014', 'PGRST116'])
    assert.match(alertMail({ ...base, dbCode }).text, new RegExp(`^Database code: ${dbCode}$`, 'm'), dbCode);
  /* A multiline value that would forge a second line, a code one digit too long, fullwidth digits and a number. */
  const fullwidth = String.fromCodePoint(0xff15, 0xff17, 0xff10, 0xff11, 0xff14);
  for (const dbCode of [PRIVATE, '57014\nCode: E_FAKE', 'PGRST1166', fullwidth, 57014]) {
    const { subject, text } = alertMail({ ...base, dbCode });
    assert.match(text, /^Database code: invalid$/m, JSON.stringify(dbCode));
    assert.equal(`${subject}${text}`.includes(PRIVATE), false);
    assert.equal(text.includes('E_FAKE'), false);
  }
  assert.equal(alertMail(base).text.includes('Database code'), false, 'no line without the field');
});

test('E7-20 second arm: a well-formed field set passes through unchanged and the sink receives that record', async () => {
  resetAlertWindow();
  const c = capture();
  const fields = {
    route: 'invitationsCreate',
    code: 'E_NOT_FOUND',
    status: 404,
    companyId: UUID,
    requestId: '01JA-nf-request-id',
    errorName: 'TypeError',
  };
  await alert('internal', fields, c.deps);
  assert.deepEqual(c.sent, alerts(c));
  assert.deepEqual(c.sent[0], { event: 'internal', ...fields, v: ALERT_VERSION, at: c.sent[0].at, count: 0 });
});

test('E7-21 the flood: one alert for a key inside the window, then one carrying count 99 after it', async () => {
  resetAlertWindow();
  const c = capture();
  const fields = { route: 'invitationsCreate', code: 'E_INTERNAL', status: 500 };
  for (let i = 0; i < 99; i++) await alert('internal', fields, c.deps);
  assert.equal(alerts(c).length, 1, 'ninety-nine occurrences inside the window are one alert');
  assert.equal(alerts(c)[0].count, 0, 'the first alert folded nothing');
  /* Still inside the window a minute later: the hundredth occurrence sends nothing either. */
  c.tick(60_000);
  await alert('internal', fields, c.deps);
  assert.equal(alerts(c).length, 1, 'one hundred occurrences inside the window are one alert');
  c.tick(WINDOW_MS);
  await alert('internal', fields, c.deps);
  assert.equal(alerts(c).length, 2);
  assert.equal(alerts(c)[1].count, 99, 'the 99 occurrences folded after the first alert ride on the next one');
  /* A different key inside the same window alerts once on its own account. */
  c.tick(1000);
  await alert('internal', { ...fields, code: 'E_MAIL_NOT_CONFIGURED' }, c.deps);
  await alert('internal', { ...fields, code: 'E_MAIL_NOT_CONFIGURED' }, c.deps);
  assert.equal(alerts(c).length, 3);
  assert.equal(alerts(c)[2].code, 'E_MAIL_NOT_CONFIGURED');
});

test('E7-21 the cap: an instance sends at most ten alerts in the window whatever the keys, and folds the rest', async () => {
  resetAlertWindow();
  const c = capture();
  /* Twenty distinct route names, letters only so every one of them PASSES the allowlist's route shape and the keys
     really are twenty; a name carrying a digit would shape to `invalid` and the twenty would be one key. */
  const names = Array.from({ length: 20 }, (_, i) => `routeName${String.fromCharCode(97 + i)}`);
  for (const route of names) {
    assert.deepEqual(shapeFields({ route }), { route }, route);
    await alert('internal', { route, status: 500 }, c.deps);
  }
  assert.equal(alerts(c).length, INSTANCE_CAP, 'twenty keys, ten alerts');
  assert.deepEqual(
    alerts(c).map((a) => a.route),
    names.slice(0, INSTANCE_CAP),
  );
  /* The ten that were capped are folded, not lost: once the window has passed, each alerts carrying its fold. */
  c.tick(WINDOW_MS + 1);
  await alert('internal', { route: names[19], status: 500 }, c.deps);
  const last = alerts(c).at(-1);
  assert.equal(last.route, names[19]);
  assert.equal(last.count, 1, 'the occurrence the cap suppressed rode on the next alert for its key');
});

test('E7-21, E7M-C-F1: a sink that never answers returns inside the bound and writes one alert_dropped line', { timeout: 10_000 }, async () => {
  resetAlertWindow();
  let settle;
  const c = capture({ sink: () => new Promise((resolve) => void (settle = resolve)) });
  const started = Date.now();
  await alert('internal', { route: 'me', status: 500 }, c.deps);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= SEND_BOUND_MS - 100, `returned after ${elapsed} ms, which is not the 1.5 s bound`);
  assert.ok(elapsed < SEND_BOUND_MS * 3, `returned after ${elapsed} ms, which is past the bound by too much`);
  assert.deepEqual(
    c.lines.map((l) => l.event),
    ['internal', 'alert_dropped'],
    'the record first, then the dropped line',
  );
  assert.deepEqual(c.lines[1], { event: 'alert_dropped' }, 'the dropped line carries nothing else');
  settle();
});

test('E7M-C-F1: a sink that throws leaves the alert_dropped line and never changes the caller', { timeout: 10_000 }, async () => {
  resetAlertWindow();
  const c = capture({
    sink: () => {
      const e = new Error(`provider said: ${PRIVATE}`);
      e.name = `${PRIVATE}-name`;
      throw e;
    },
  });
  await assert.doesNotReject(() => alert('internal', { route: 'me', status: 500 }, c.deps));
  assert.deepEqual(
    c.lines.map((l) => l.event),
    ['internal', 'alert_dropped'],
  );
  assert.equal(JSON.stringify(c.lines).includes(PRIVATE), false);
  /* And a sink that rejects rather than throwing synchronously. */
  resetAlertWindow();
  const r = capture({ sink: () => Promise.reject(new Error(PRIVATE)) });
  await assert.doesNotReject(() => alert('internal', { route: 'me', status: 500 }, r.deps));
  assert.deepEqual(
    r.lines.map((l) => l.event),
    ['internal', 'alert_dropped'],
  );
  assert.equal(JSON.stringify(r.lines).includes(PRIVATE), false);
});

test('E7-22: each of the seven events raises one alert, and anything else raises nothing at all', async () => {
  /* The five of E7 1.5, the alerts design's delivery_undeliverable (1.2) and lane K3's signin_limited
     (evidence/hardening-k.md). The stderr lines of that design (mail_event_ignored, operator_mail_undeliverable and
     the check-in's five) are lines, never events. */
  assert.deepEqual(ALERT_EVENTS, [
    'internal',
    'session_unavailable',
    'delivery_failed',
    'mail_not_configured',
    'escaped',
    'delivery_undeliverable',
    'signin_limited',
  ]);
  for (const event of ALERT_EVENTS) {
    resetAlertWindow();
    const c = capture();
    await alert(event, { route: 'me', status: 500 }, c.deps);
    assert.equal(alerts(c).length, 1, event);
    assert.equal(alerts(c)[0].event, event, event);
    assert.deepEqual(c.sent, alerts(c), event);
  }
  for (const event of [
    'refused',
    'alert_dropped',
    'session_refused',
    'E_MAINTENANCE',
    'contact_undeliverable',
    'mail_event_ignored',
    'operator_mail_undeliverable',
    'checkin_dropped',
    '',
    null,
    undefined,
    42,
    {},
  ]) {
    resetAlertWindow();
    const c = capture();
    await alert(event, { route: 'me', status: 500 }, c.deps);
    assert.deepEqual(c.lines, [], `an event outside the list raises nothing: ${JSON.stringify(event)}`);
    assert.deepEqual(c.sent, []);
  }
});

/* ---------- E7-20's first and third arms, through the real pipeline and the real adapter ----------

   The tripwire that matters (design 1.5). A route whose handler throws an error carrying a synthetic tenant string in
   its message, name, code, details and stack, called with the same strings in the body, the query and the headers,
   with a capture as the sink AND a capture as deps.log. The assertion is over the serialised alert and over every
   captured log line at once. The third arm drives the adapter's catch, which takes no deps, so it runs in a child
   process and the child's stderr is what is read. */

const STRINGS = Object.freeze([
  'the candidate declines meetings before ten',
  'someone@customer.example.invalid',
  'sbp_0123456789abcdef0123456789abcdef01234567',
  'Acme Onboarding Agent',
]);

function loadedError() {
  const e = new Error(`database said: ${STRINGS[0]} for ${STRINGS[1]}`);
  e.name = `${STRINGS[2]}-name`;
  e.code = `${STRINGS[3]}-code`;
  e.details = `row: ${STRINGS[0]}`;
  e.hint = STRINGS[1];
  e.stack = `Error: ${STRINGS[0]}\n    at handler (${STRINGS[3]})`;
  return e;
}

const COMPANY = 'bbbbbbbb-2222-4333-8444-555555555555';

test('E7-20 first arm: a handler throwing loaded strings, through the real pipeline, leaks none of them', async () => {
  resetAlertWindow();
  const seen = [];
  const sent = [];
  const r = route(
    {
      method: 'POST',
      path: '/api/companies/:companyId/probe',
      uuidParams: ['companyId'],
      session: 'none',
      handle: async () => {
        throw loadedError();
      },
    },
    {
      log: (entry) => seen.push(entry),
      alert: async (event, fields, deps) => {
        sent.push({ event, fields });
        /* The capture also runs the real module over the same fields, so the record a sink would receive is under
           the same assertion as the raw field set the boundary handed over. */
        await alert(event, fields, { ...deps, alertWrite: (e) => sent.push(e), alertSink: undefined });
      },
    },
  );
  const res = await r(
    makeRequest({
      method: 'POST',
      path: `/api/companies/${COMPANY}/probe`,
      params: { companyId: COMPANY },
      query: { note: STRINGS[0], agent: STRINGS[3] },
      headers: {
        'content-type': 'application/json',
        origin: 'https://enterprise.example.invalid',
        'sec-fetch-site': 'same-origin',
        'x-nf-request-id': '01JA-9f2c-4d1e',
        'x-synthetic-header': STRINGS[1],
      },
      body: JSON.stringify({ passport: STRINGS[0], email: STRINGS[1], token: STRINGS[2] }),
    }),
  );
  assert.equal(res.status, 500);
  assert.equal(JSON.parse(res.body).code, 'E_INTERNAL');
  /* Neither the captured alert nor any captured log line holds any of the strings. */
  const haystack = JSON.stringify({ seen, sent, body: res.body, headers: res.headers });
  for (const s of STRINGS) assert.equal(haystack.includes(s), false, `${s} in ${haystack}`);
  /* K2 (evidence/hardening-k.md): the line carries the request's shaped request id as the alert does. */
  assert.deepEqual(seen, [{ event: 'internal', errorName: 'Error', code: 'invalid', requestId: '01JA-9f2c-4d1e' }]);
  /* One alert, its key set exactly the allowlist, and the company id and request id the pipeline itself knows. */
  assert.equal(sent.length, 2, JSON.stringify(sent));
  /* The capture at deps.alert already receives SHAPED fields: the boundary applies the allowlist before the value
     crosses the call, so no raw e.name or e.code leaves lib/http/pipeline.mjs even to a capture. `route` is absent
     because a bare route() carries no routeName; makeRoutes() is what sets it, and the stack arm reads it there. */
  assert.deepEqual(sent[0], {
    event: 'internal',
    fields: {
      code: 'invalid',
      status: 500,
      companyId: COMPANY,
      requestId: '01JA-9f2c-4d1e',
      errorName: 'Error',
    },
  });
  assert.deepEqual(Object.keys(sent[1]).sort(), ['at', 'code', 'companyId', 'count', 'errorName', 'event', 'requestId', 'status', 'v']);
  assert.deepEqual(sent[1], {
    event: 'internal',
    code: 'invalid',
    status: 500,
    companyId: COMPANY,
    requestId: '01JA-9f2c-4d1e',
    errorName: 'Error',
    v: ALERT_VERSION,
    at: sent[1].at,
    count: 0,
  });
});

test('E7-22: every refusal of the pipeline, and the closed switch, raise nothing at all', async () => {
  resetAlertWindow();
  const sent = [];
  const deps = { log: () => {}, alert: async (event, fields) => void sent.push({ event, fields }) };
  const refusing = (code) =>
    route(
      {
        method: 'POST',
        path: '/api/companies/:companyId/probe',
        uuidParams: ['companyId'],
        session: 'none',
        handle: async () => {
          throw new AppError(code);
        },
      },
      deps,
    );
  const call = (handler, over = {}) =>
    handler(
      makeRequest({
        method: 'POST',
        path: `/api/companies/${COMPANY}/probe`,
        params: { companyId: COMPANY },
        headers: {
          'content-type': 'application/json',
          origin: 'https://enterprise.example.invalid',
          'sec-fetch-site': 'same-origin',
        },
        body: '{}',
        ...over,
      }),
    );
  /* Every 4xx of the E6 matrix's own vocabulary, each raised as the AppError a service raises. */
  const FOUR_XX = Object.keys(CODES).filter((c) => CODES[c] >= 400 && CODES[c] <= 499);
  assert.ok(FOUR_XX.length >= 30, `${FOUR_XX.length} 4xx codes`);
  for (const code of FOUR_XX) {
    const res = await call(refusing(code));
    assert.equal(res.status, CODES[code], code);
    assert.deepEqual(sent, [], `E7-22: ${code} is a refusal and alerts nothing`);
  }
  /* The switch, which answers before anything is read. */
  const before = process.env.ENTERPRISE_ACCESS_STATE;
  delete process.env.ENTERPRISE_ACCESS_STATE;
  try {
    const res = await call(refusing('E_NOT_FOUND'));
    assert.equal(res.status, 503);
    assert.equal(JSON.parse(res.body).code, 'E_MAINTENANCE');
    assert.deepEqual(sent, [], 'E7-22: E_MAINTENANCE alerts nothing');
  } finally {
    process.env.ENTERPRISE_ACCESS_STATE = before;
  }
  /* The one 503 refusal that DOES alert, so the rule is "no 4xx refusal" and not "no refusal". */
  const res = await call(refusing('E_MAIL_NOT_CONFIGURED'));
  assert.equal(res.status, 503);
  assert.deepEqual(sent, [
    {
      event: 'mail_not_configured',
      fields: { code: 'E_MAIL_NOT_CONFIGURED', status: 503, companyId: COMPANY },
    },
  ]);
});

test('XR-12: an AppError that answers 500 raises internal, and a database fault carries its code on the line and the alert', async () => {
  resetAlertWindow();
  const sent = [];
  const lines = [];
  const deps = { log: (entry) => void lines.push(entry), alert: async (event, fields) => void sent.push({ event, fields }) };
  const faulting = (thrown) =>
    route(
      {
        method: 'POST',
        path: '/api/companies/:companyId/probe',
        uuidParams: ['companyId'],
        session: 'none',
        handle: async () => {
          throw thrown;
        },
      },
      deps,
    );
  const call = (handler) =>
    handler(
      makeRequest({
        method: 'POST',
        path: `/api/companies/${COMPANY}/probe`,
        params: { companyId: COMPANY },
        headers: {
          'content-type': 'application/json',
          origin: 'https://enterprise.example.invalid',
          'sec-fetch-site': 'same-origin',
          'x-nf-request-id': '01JA-9f2c-4d1e',
        },
        body: '{}',
      }),
    );
  const { fromPostgrest } = await import('../../../lib/errors.mjs');
  /* A statement timeout as PostgREST reports it: the message, details and hint carry the private sentence and none of
     it may leave; the SQLSTATE does. */
  const timeout = fromPostgrest({
    status: 500,
    body: { code: '57014', message: `canceling statement: ${PRIVATE}`, details: PRIVATE, hint: PRIVATE },
  });
  let res = await call(faulting(timeout));
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body), {
    ok: false,
    code: 'E_INTERNAL',
    message: 'Internal error.',
    requestId: '01JA-9f2c-4d1e',
  });
  assert.deepEqual(lines, [
    { event: 'refused', code: 'E_INTERNAL', status: 500, requestId: '01JA-9f2c-4d1e', dbCode: '57014' },
  ]);
  assert.deepEqual(sent, [
    {
      event: 'internal',
      fields: {
        code: 'E_INTERNAL',
        status: 500,
        companyId: COMPANY,
        requestId: '01JA-9f2c-4d1e',
        errorName: 'AppError',
        dbCode: '57014',
      },
    },
  ]);
  /* An internal AppError without a database code (an invariant a service checks) still alerts, with no dbCode. */
  sent.length = 0;
  lines.length = 0;
  res = await call(faulting(new AppError('E_INTERNAL')));
  assert.equal(res.status, 500);
  assert.deepEqual(lines, [{ event: 'refused', code: 'E_INTERNAL', status: 500, requestId: '01JA-9f2c-4d1e' }]);
  assert.deepEqual(sent.map((s) => [s.event, s.fields.code, Object.hasOwn(s.fields, 'dbCode')]), [
    ['internal', 'E_INTERNAL', false],
  ]);
  /* Every code CODES answers with 500 alerts once as internal, except E_READ_OVER_BOUND, the expected 500 of a read
     past its ceiling (docs/e8/design.md 7.2 item 2), which keeps its refused line and alerts nothing (XR12-R2). */
  const fiveHundreds = Object.keys(CODES).filter((c) => CODES[c] === 500);
  assert.ok(fiveHundreds.includes('E_READ_OVER_BOUND') && fiveHundreds.includes('E_ASSEMBLY_DIVERGED'));
  for (const code of fiveHundreds) {
    sent.length = 0;
    lines.length = 0;
    res = await call(faulting(new AppError(code)));
    assert.equal(res.status, 500, code);
    const want = code === 'E_READ_OVER_BOUND' ? [] : ['internal'];
    assert.deepEqual(sent.map((s) => s.event), want, `${code} alerts ${want.join('') || 'nothing'}`);
    assert.deepEqual(lines.map((l) => [l.event, l.code]), [['refused', code]], code);
  }
  sent.length = 0;
  lines.length = 0;
  await call(faulting(fromPostgrest({ status: 500, body: { code: PRIVATE, message: PRIVATE } })));
  assert.equal(JSON.stringify([lines, sent]).includes(PRIVATE), false);
  assert.equal(Object.hasOwn(lines[0], 'dbCode'), false);
});

test('E7-20 third arm: the adapter\'s catch, in a child process, writes a shaped line and a shaped alert and nothing else', async () => {
  const child = spawnSync(
    process.execPath,
    [new URL('../fixtures/adapter-escaped.mjs', import.meta.url).pathname],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        E7_STRINGS: JSON.stringify(STRINGS),
        ENTERPRISE_ACCESS_STATE: 'open',
        ENTERPRISE_ALERT_SINK: 'none',
        SUPABASE_URL: BASE,
        SUPABASE_ANON_KEY: 'unit-anon-key',
        SUPABASE_JWT_SECRET: SECRET,
      },
    },
  );
  assert.equal(child.status, 0, `${child.stdout}${child.stderr}`);
  const answer = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.equal(answer.status, 500);
  assert.equal(JSON.parse(answer.body).code, 'E_INTERNAL');
  /* Every line the child wrote to stderr is the product's own, and none of them holds any of the strings. */
  for (const s of STRINGS) assert.equal(child.stderr.includes(s), false, `${s} on the adapter's stderr:\n${child.stderr}`);
  const lines = child.stderr
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => l.event),
    ['internal', 'escaped'],
    `the stderr line first, then the alert:\n${child.stderr}`,
  );
  /* K2: the adapter's line carries the shaped request id too. */
  assert.deepEqual(lines[0], { event: 'internal', errorName: 'Error', code: 'invalid', requestId: '01JA-child-arm' });
  assert.deepEqual(lines[1], {
    event: 'escaped',
    route: 'membersList',
    code: 'invalid',
    status: 500,
    companyId: 'bbbbbbbb-2222-4333-8444-555555555555',
    requestId: '01JA-child-arm',
    errorName: 'Error',
    v: ALERT_VERSION,
    at: lines[1].at,
    count: 0,
  });
});
