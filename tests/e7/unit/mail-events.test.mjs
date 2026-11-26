/* The mail event route and its rules, stack-free (docs/e7/alerts-and-checkin-design.md 1.3, 1.4, 1.6, 2.2; section 7,
   slice 1). Cases AC-16 (the signature), AC-28 (what is ignored), AC-30 (the unset secret, ALD-R-F1), AC-31's unit half
   (the provider's own bounce example, ALD-R-F3), AC-9 and AC-11 in their operator halves, the modes pin of ALD-R-F2,
   and the alert about a failed mail that never alerts on its own failure.

   EVERY REQUEST GOES THROUGH toNetlify WITH A WEB Request (ALD-R-F2), not makeRequest({ body }), which bypasses the
   adapter: an adapter without the 'signed' mode resolves the body as null and refuses every real event while every
   makeRequest-built case passes. The route is the one makeRoutes() declares, handed a log capture and an alert
   capture that runs the REAL alert() with its three test seams (alertWrite, alertNow, alertSink), so the record the
   operator would receive is the thing asserted.

   The signing secret is made at run time (tests/e7/mail-catcher.mjs webhookSecret()) and the events are signed by the
   catcher's own signer, which shares no code with the verifier. No provider is called.

   FAIL-BEFORE: ALERTS_SLICE1_LIB names a mutant copy of lib/ (evidence/alerts-slice1-repro/mutate.mjs builds each
   under .scratch/), loaded in place of lib/ for every module this file reads; each case names the mutant it fails on.
   The variable exists for that demonstration only; no gate sets it. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bounceEvent, failedEvent, signEvent, suppressedEvent, webhookSecret } from '../mail-catcher.mjs';

process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = 'example-unit-secret-with-at-least-32-characters-long';
process.env.ENTERPRISE_ACCESS_STATE = 'open';
process.env.ENTERPRISE_ORIGIN = 'https://enterprise.example.invalid';
delete process.env.ENTERPRISE_ALERT_SINK;

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const LIB = process.env.ALERTS_SLICE1_LIB
  ? `${pathToFileURL(resolve(process.env.ALERTS_SLICE1_LIB)).href}/`
  : new URL('../../../lib/', import.meta.url).href;
const lib = (path) => import(new URL(path, LIB).href);

const { makeRoutes } = await lib('http/routes.mjs');
const { toNetlify, ADAPTER_BODY_MODES } = await lib('http/netlify.mjs');
const { BODY_MODES } = await lib('http/pipeline.mjs');
const { alert, resetAlertWindow, WINDOW_MS } = await lib('http/alerts.mjs');
const { CAUSES, classify, decide, isWebhookSecret } = await lib('rules/mail-events.mjs');
const { TOLERANCE_SECONDS, mailEventsConfigured, verifyMailEvent } = await lib('services/mail-events.mjs');

const A = 'aaaaaaaa-1111-4222-8333-444444444444';
const B = 'bbbbbbbb-2222-4333-8444-555555555555';
const INV_A = 'cccccccc-3333-4444-8555-666666666666';
const INV_B = 'dddddddd-4444-4555-8666-777777777777';
const INV_B2 = 'eeeeeeee-5555-4666-8777-888888888888';
const T0 = 1_790_064_000; /* seconds; any fixed time: the route's clock is the seam below */
const SECRET = webhookSecret();
const invitation = (company, inv) => ({ kind: 'enterprise-invitation', company, invitation: inv });

/* The route as the function file builds it, with captures; `clock` is seconds and drives both the verifier's clock
   and the alert window, so a case can cross the tolerance or the window without waiting. */
function harness({ sink } = {}) {
  /* One harness is one fresh function instance: the alert window is per instance (lib/http/alerts.mjs). */
  resetAlertWindow();
  const lines = [];
  const records = [];
  const sent = [];
  const h = { lines, records, sent, clock: T0 };
  const deps = {
    log: (entry) => lines.push(entry),
    alert: (event, fields, d) =>
      alert(event, fields, {
        ...d,
        alertWrite: (r) => records.push(r),
        alertNow: () => h.clock * 1000,
        alertSink: sink ?? (async (r) => void sent.push(r)),
      }),
    nowSeconds: () => h.clock,
  };
  const handler = toNetlify(makeRoutes(deps).mailEvents);
  h.post = async (body, headers) => {
    const res = await handler(
      new Request('https://enterprise.example.invalid/api/mail/events', { method: 'POST', headers, body }),
      { params: {} },
    );
    const text = await res.text();
    return { status: res.status, body: text.length ? JSON.parse(text) : null };
  };
  /* A signed post of an event object (or of raw text), signed now unless told otherwise. */
  h.event = async (event, { secret = SECRET, timestamp = h.clock, raw } = {}) => {
    const body = raw ?? JSON.stringify(event);
    return h.post(body, signEvent(body, { secret, timestamp }).headers);
  };
  h.alerts = () => records.filter((r) => r.event !== 'alert_dropped');
  return h;
}

const REFUSED_LINE = { event: 'refused', code: 'E_WEBHOOK_INVALID', status: 401 };
const refusedNothingElse = (h, label) => {
  assert.deepEqual(h.lines, [REFUSED_LINE], `${label}: the refused line and nothing else`);
  assert.deepEqual(h.records, [], `${label}: no alert record`);
  assert.deepEqual(h.sent, [], `${label}: nothing sent`);
};

beforeEach(() => {
  resetAlertWindow();
  process.env.ENTERPRISE_MAIL_WEBHOOK_SECRET = SECRET;
});

/* ---------- the modes pin (ALD-R-F2) ---------- */

test('ALD-R-F2: the adapter reads exactly the pipeline body modes other than none (fails on the adapter without signed)', () => {
  assert.deepEqual([...ADAPTER_BODY_MODES].sort(), BODY_MODES.filter((m) => m !== 'none').sort());
  assert.ok(BODY_MODES.includes('signed'));
  assert.equal(makeRoutes().mailEvents.route.body, 'signed');
});

/* ---------- AC-16: the signature ---------- */

test('AC-16: a valid signed event answers 200 and raises its alert; the same event through the adapter is read as text', async () => {
  const h = harness();
  const r = await h.event(bounceEvent({ tags: invitation(A, INV_A) }));
  assert.deepEqual(r, { status: 200, body: { ok: true } });
  assert.deepEqual(h.lines, []);
  assert.equal(h.alerts().length, 1);
  assert.deepEqual(h.alerts()[0], {
    event: 'delivery_undeliverable',
    route: 'mailEvents',
    companyId: A,
    cause: 'recipient_permanent',
    routedTo: 'operator',
    v: 1,
    at: new Date(T0 * 1000).toISOString(),
    count: 0,
  });
  assert.deepEqual(h.sent, h.alerts(), 'the sink received that record');
  /* Spacing and key order the sender chose are kept: the text is verified as received, never re-serialised. */
  const spaced = `{ "type" : "email.bounced",\n  "data": ${JSON.stringify(bounceEvent({ tags: invitation(B, INV_B) }).data, null, 2)} }`;
  const s = harness();
  assert.equal((await s.event(null, { raw: spaced })).status, 200);
  assert.equal(s.alerts()[0].companyId, B);
});

test('AC-16: every refusal answers 401 E_WEBHOOK_INVALID with only the refused line; no alert, no send', async () => {
  const valid = JSON.stringify(bounceEvent({ tags: invitation(A, INV_A) }));
  const signed = signEvent(valid, { secret: SECRET, timestamp: T0 });
  const without = (name) => Object.fromEntries(Object.entries(signed.headers).filter(([k]) => k !== name));
  const cases = [
    ['no svix headers at all', valid, { 'content-type': 'application/json' }],
    ['no svix-id', valid, without('svix-id')],
    ['no svix-timestamp', valid, without('svix-timestamp')],
    ['no svix-signature', valid, without('svix-signature')],
    ['a wrong signature (another secret)', valid, signEvent(valid, { secret: webhookSecret(), timestamp: T0 }).headers],
    ['the timestamp 301 s in the past', valid, signEvent(valid, { secret: SECRET, timestamp: T0 - 301 }).headers],
    ['the timestamp 301 s in the future', valid, signEvent(valid, { secret: SECRET, timestamp: T0 + 301 }).headers],
    ['the body changed by one byte', valid.replace('Permanent', 'Permanenu'), signed.headers],
    ['only a v2 entry', valid, { ...signed.headers, 'svix-signature': signed.signature.replace(/^v1,/, 'v2,') }],
    ['the signature over timestamp, id, body (reordered)', valid, { ...signed.headers, 'svix-signature': reordered(valid) }],
    ['the valid event re-serialised', JSON.stringify(JSON.parse(valid), null, 1), signed.headers],
    ['a truncated v1 entry', valid, { ...signed.headers, 'svix-signature': signed.signature.slice(0, 20) }],
    ['a malformed timestamp', valid, { ...signed.headers, 'svix-timestamp': `${T0}.5` }],
    ['an id holding the separator', valid, { ...signed.headers, 'svix-id': 'msg.x' }],
    ['a signature header of spaces', valid, { ...signed.headers, 'svix-signature': '   ' }],
    ['nine signature entries', valid, { ...signed.headers, 'svix-signature': Array(9).fill(signed.signature).join(' ') }],
  ];
  for (const [label, body, headers] of cases) {
    const h = harness();
    const r = await h.post(body, headers);
    assert.equal(r.status, 401, label);
    assert.equal(r.body.code, 'E_WEBHOOK_INVALID', label);
    assert.equal(r.body.message, 'The event could not be verified.', label);
    refusedNothingElse(h, label);
  }
});

/* The reordered content: HMAC over `${timestamp}.${id}.${body}`, the two fields swapped. */
function reordered(body) {
  const ok = signEvent(body, { secret: SECRET, timestamp: T0, id: 'msg_reordered' });
  const swapped = signEvent(body, { secret: SECRET, timestamp: 'msg_reordered', id: String(T0) });
  assert.notEqual(ok.signature, swapped.signature);
  return swapped.signature;
}

test('AC-16: a captured valid event replayed ten minutes later is refused; at exactly 300 s it is still admitted', async () => {
  const body = JSON.stringify(bounceEvent({ tags: invitation(A, INV_A) }));
  const { headers } = signEvent(body, { secret: SECRET, timestamp: T0 });
  const h = harness();
  assert.equal((await h.post(body, headers)).status, 200);
  h.clock = T0 + 600;
  const replay = await h.post(body, headers);
  assert.equal(replay.status, 401);
  assert.deepEqual(h.lines, [REFUSED_LINE]);
  assert.equal(h.alerts().length, 1, 'only the original raised an alert');
  const edge = harness();
  edge.clock = T0 + TOLERANCE_SECONDS;
  assert.equal((await edge.post(body, headers)).status, 200, 'the tolerance is 300 s inclusive');
  assert.equal(TOLERANCE_SECONDS, 300);
});

test('AC-16: during a secret rotation the provider sends two v1 entries; either one matching is enough', async () => {
  const body = JSON.stringify(bounceEvent({ tags: invitation(A, INV_A) }));
  const right = signEvent(body, { secret: SECRET, timestamp: T0, id: 'msg_rotate' });
  const wrong = signEvent(body, { secret: webhookSecret(), timestamp: T0, id: 'msg_rotate' });
  const h = harness();
  const r = await h.post(body, { ...right.headers, 'svix-signature': `${wrong.signature} ${right.signature}` });
  assert.equal(r.status, 200);
});

test('AC-16: an oversized or non-JSON-typed body is refused by the pipeline before the signature is read, and raises nothing', async () => {
  const big = JSON.stringify({ ...bounceEvent({ tags: invitation(A, INV_A) }), padding: 'x'.repeat(16_400) });
  const h = harness();
  const r = await h.post(big, signEvent(big, { secret: SECRET, timestamp: T0 }).headers);
  assert.equal(r.status, 413);
  assert.equal(r.body.code, 'E_BODY_TOO_LARGE');
  assert.deepEqual([h.lines, h.records, h.sent], [[], [], []], 'nothing logged, nothing raised');
  const body = JSON.stringify(bounceEvent({ tags: invitation(A, INV_A) }));
  const t = harness();
  const typed = await t.post(body, { ...signEvent(body, { secret: SECRET, timestamp: T0 }).headers, 'content-type': 'text/plain' });
  assert.equal(typed.status, 415);
  assert.deepEqual([t.lines, t.records, t.sent], [[], [], []]);
});

/* ---------- AC-30: the unset secret (ALD-R-F1) ---------- */

test('AC-30: with the secret unset, then malformed, a hundred anonymous posts answer 401 each and raise nothing', async () => {
  /* Labels, never values: a case message must not print even a generated secret into a log. */
  for (const [label, secret] of [
    ['unset', undefined],
    ['empty', ''],
    ['too short', 'whsec_c2hvcnQ='],
    ['no prefix, not base64', 'not-a-signing-secret'],
    ['the bare base64', SECRET.slice('whsec_'.length)],
    ['a trailing space', `${SECRET} `],
  ]) {
    if (secret === undefined) delete process.env.ENTERPRISE_MAIL_WEBHOOK_SECRET;
    else process.env.ENTERPRISE_MAIL_WEBHOOK_SECRET = secret;
    resetAlertWindow();
    const h = harness();
    const answers = [];
    for (let i = 0; i < 100; i++) answers.push(await h.post(`{"n":${i}}`, { 'content-type': 'application/json' }));
    /* A correctly signed event is refused too: nothing verifies against a secret that is not configured. */
    const body = JSON.stringify(bounceEvent({ tags: invitation(A, INV_A) }));
    answers.push(await h.post(body, signEvent(body, { secret: SECRET, timestamp: T0 }).headers));
    /* The property first: an anonymous post fires nothing on the operator's channel (ALD-R-F1). */
    assert.deepEqual(h.records, [], `${label}: no alert, not even mail_not_configured`);
    assert.deepEqual(
      [...new Set(answers.map((r) => `${r.status} ${r.body.code}`))],
      ['401 E_WEBHOOK_INVALID'],
      `${label}: every answer`,
    );
    assert.deepEqual(h.sent, []);
    assert.equal(h.lines.length, 101);
    assert.ok(h.lines.every((l) => JSON.stringify(l) === JSON.stringify(REFUSED_LINE)));
    assert.equal(mailEventsConfigured(), false);
  }
});

/* ---------- AC-28: what is ignored ---------- */

test('AC-28: a delay, a delivery, an unknown kind, kind enterprise-contact, no tags, no kind, an array, a string, not JSON: 200 and one ignored line each', async () => {
  const cases = [
    ['email.delivery_delayed', { ...bounceEvent({ tags: invitation(A, INV_A) }), type: 'email.delivery_delayed' }],
    ['email.delivered', { ...bounceEvent({ tags: invitation(A, INV_A) }), type: 'email.delivered' }],
    ['a kind outside the four', bounceEvent({ tags: { kind: 'newsletter', company: A } })],
    ['kind enterprise-contact, which nothing sends until slice 2', bounceEvent({ tags: { kind: 'enterprise-contact', company: A } })],
    ['no tags', bounceEvent({})],
    ['tags without a kind', bounceEvent({ tags: { company: A, invitation: INV_A } })],
    ['the provider example tags', bounceEvent({ tags: { category: 'confirm_email' } })],
    ['a body that is an array', [bounceEvent({ tags: invitation(A, INV_A) })]],
    ['a body that is a string', 'email.bounced'],
    ['no type', { data: bounceEvent({ tags: invitation(A, INV_A) }).data }],
  ];
  for (const [label, event] of cases) {
    const h = harness();
    const r = await h.event(event);
    assert.deepEqual(r, { status: 200, body: { ok: true } }, label);
    assert.deepEqual(h.lines, [{ event: 'mail_event_ignored' }], label);
    assert.deepEqual([h.records, h.sent], [[], []], `${label}: no alert, no send`);
  }
  const h = harness();
  assert.equal((await h.event(null, { raw: 'not json at all' })).status, 200);
  assert.deepEqual(h.lines, [{ event: 'mail_event_ignored' }]);
  assert.deepEqual(h.records, []);
});

/* ---------- the shared Resend team (ALD-R-F15's fallback, Raffael's decision of 2026-09-21) ----------

   The team is shared with Raffael's other senders, so the webhook delivers their events too, correctly signed. Only a
   kind carrying the `enterprise-` prefix is this product's; anything else is answered 200 with one ignored line and
   never an alert. Fail-before: the code at b4a3758, which classified the unprefixed kinds, raises an alert for another
   sender's `kind: invitation` bounce (evidence/alerts-slice1-repro/unprefixed-kind-fail-before.log). */

test('ALD-R-F15: another sender in the same team, whose kind lacks the enterprise- prefix, never raises an enterprise alert', async () => {
  const kinds = [
    'invitation',
    'alert',
    'checkin',
    'contact',
    'Enterprise-invitation',
    'enterprise-invitations',
    'enterprise_invitation',
    'xenterprise-invitation',
    'enterprise-',
  ];
  for (const kind of kinds) {
    for (const event of [
      bounceEvent({ tags: { kind, company: A, invitation: INV_A } }),
      suppressedEvent({ tags: { kind, company: A } }),
      failedEvent({ tags: { kind, company: A } }),
    ]) {
      const h = harness();
      const r = await h.event(event);
      assert.deepEqual(r, { status: 200, body: { ok: true } }, kind);
      /* The property first: nothing on the operator's channel. */
      assert.deepEqual(h.records, [], `${kind}: no alert for another sender's mail`);
      assert.deepEqual(h.sent, []);
      assert.deepEqual(h.lines, [{ event: 'mail_event_ignored' }], `${kind}: one shaped line`);
    }
  }
  /* And the control: this product's own kind, the same event, is its alert. */
  const own = harness();
  await own.event(bounceEvent({ tags: invitation(A, INV_A) }));
  assert.equal(own.records.length, 1);
});

/* ---------- AC-31 (unit): the classification, with the provider's own example ---------- */

/* The provider's documented event shapes, with its own enumerated values and synthetic values elsewhere
   (tests/e7/fixtures/resend-webhook-examples.json, each with its source page). */
const PROVIDER_EXAMPLES = JSON.parse(readFileSync(join(REPO, 'tests', 'e7', 'fixtures', 'resend-webhook-examples.json'), 'utf8'));
function providerExample(file) {
  return PROVIDER_EXAMPLES[file.replace(/^resend-webhook-/, '').replace(/\.txt$/, '')].example;
}

test('AC-31: the provider example (Permanent, Suppressed) is suppressed; General is recipient_permanent; NoEmail, none and Temporary are undetermined', async () => {
  const example = providerExample('resend-webhook-email-bounced.txt');
  assert.equal(example.type, 'email.bounced');
  assert.deepEqual(example.data.bounce.type, 'Permanent');
  assert.deepEqual(example.data.bounce.subType, 'Suppressed');
  assert.equal(classify(example), 'suppressed');
  /* As the provider sends it (its own tags), it names no invitation and is ignored; with an invitation's tags it is
     the operator's alert, cause suppressed. */
  assert.deepEqual(decide(example), { outcome: 'ignored' });
  const tagged = { ...example, data: { ...example.data, tags: invitation(A, INV_A) } };
  assert.deepEqual(decide(tagged), { outcome: 'delivery_undeliverable', cause: 'suppressed', companyId: A });
  const table = [
    [{ type: 'Permanent', subType: 'General' }, 'recipient_permanent'],
    [{ type: 'Permanent', subType: 'Suppressed' }, 'suppressed'],
    [{ type: 'Permanent', subType: 'NoEmail' }, 'undetermined'],
    [{ type: 'Permanent', subType: 'MessageRejected' }, 'undetermined'],
    [{ type: 'Permanent', subType: null }, 'undetermined'],
    [{ type: 'Transient', subType: 'MailboxFull' }, 'recipient_temporary'],
    [{ type: 'Temporary', subType: 'General' }, 'undetermined'],
    [{ type: 'Undetermined', subType: 'Undetermined' }, 'undetermined'],
    [{ type: 'permanent', subType: 'General' }, 'undetermined'],
  ];
  for (const [bounce, cause] of table) {
    assert.equal(classify(bounceEvent({ ...bounce })), cause, JSON.stringify(bounce));
    const h = harness();
    assert.equal((await h.event(bounceEvent({ ...bounce, tags: invitation(A, INV_A) }))).status, 200);
    assert.equal(h.alerts().length, 1, JSON.stringify(bounce));
    assert.equal(h.alerts()[0].cause, cause, JSON.stringify(bounce));
    assert.equal(h.alerts()[0].routedTo, 'operator');
  }
  assert.equal(classify(providerExample('resend-webhook-email-suppressed.txt')), 'suppressed');
  assert.equal(classify(providerExample('resend-webhook-email-failed.txt')), 'undetermined');
  assert.equal(classify(suppressedEvent({ tags: invitation(A, INV_A) })), 'suppressed');
  assert.equal(classify(failedEvent({ tags: invitation(A, INV_A) })), 'undetermined');
  for (const cause of ['recipient_permanent', 'recipient_temporary', 'suppressed', 'undetermined'])
    assert.ok(CAUSES.includes(cause), cause);
});

test('AC-31: the company id comes from the tag only when it is a lowercase uuid; otherwise the alert names none', async () => {
  for (const [company, expected] of [
    [A, A],
    [A.toUpperCase(), undefined],
    ['not-a-uuid', undefined],
    [undefined, undefined],
    ['someone@customer.example.invalid', undefined],
  ]) {
    const h = harness();
    await h.event(bounceEvent({ tags: { kind: 'enterprise-invitation', ...(company === undefined ? {} : { company }) } }));
    assert.equal(h.alerts().length, 1, String(company));
    assert.equal(h.alerts()[0].companyId, expected, String(company));
    assert.equal(JSON.stringify(h.records).includes('@'), false);
  }
});

/* ---------- AC-9 (operator half): a bounce in B never folds into A's alert ---------- */

test('AC-9 operator half: one address bounces for A and for B inside one window; each company gets its own alert', async () => {
  const same = 'shared.person@example.invalid';
  const h = harness();
  await h.event(bounceEvent({ to: same, tags: invitation(A, INV_A) }));
  await h.event(bounceEvent({ to: same, tags: invitation(B, INV_B) }));
  await h.event(bounceEvent({ to: 'other.person@example.invalid', tags: invitation(B, INV_B2) }));
  assert.deepEqual(
    h.alerts().map((a) => [a.companyId, a.cause, a.routedTo, a.count]),
    [
      [A, 'recipient_permanent', 'operator', 0],
      [B, 'recipient_permanent', 'operator', 0],
    ],
    "B's second bounce folds into B's own key, never into A's",
  );
  /* After the window, B's next alert carries the one occurrence that was folded, and A's carries none. */
  h.clock += WINDOW_MS / 1000;
  await h.event(bounceEvent({ tags: invitation(B, INV_B2) }), { timestamp: h.clock });
  await h.event(bounceEvent({ tags: invitation(A, INV_A) }), { timestamp: h.clock });
  assert.deepEqual(
    h.alerts().slice(2).map((a) => [a.companyId, a.count]),
    [
      [B, 1],
      [A, 0],
    ],
  );
  assert.equal(JSON.stringify(h.records).includes('person@'), false, 'no address in any record');
});

test('ALD-R-F5, the key only: routedTo is in the fold key of delivery_undeliverable, and a different cause is its own alert', async () => {
  const h = harness();
  const deps = { alertWrite: (r) => h.records.push(r), alertNow: () => h.clock * 1000, alertSink: async () => {} };
  await alert('delivery_undeliverable', { route: 'mailEvents', companyId: A, cause: 'recipient_permanent', routedTo: 'operator_and_contact' }, deps);
  await alert('delivery_undeliverable', { route: 'mailEvents', companyId: A, cause: 'recipient_permanent', routedTo: 'operator_contact_failed' }, deps);
  await alert('delivery_undeliverable', { route: 'mailEvents', companyId: A, cause: 'suppressed', routedTo: 'operator_contact_failed' }, deps);
  await alert('delivery_undeliverable', { route: 'mailEvents', companyId: A, cause: 'suppressed', routedTo: 'operator_contact_failed' }, deps);
  assert.deepEqual(
    h.alerts().map((a) => [a.cause, a.routedTo, a.count]),
    [
      ['recipient_permanent', 'operator_and_contact', 0],
      ['recipient_permanent', 'operator_contact_failed', 0],
      ['suppressed', 'operator_contact_failed', 0],
    ],
  );
});

/* ---------- AC-11 (operator half) and the alert about a failed mail ---------- */

test('AC-11 operator half: the bounce of an operator alert and of a check-in give one line each and never a mail or an alert', async () => {
  const h = harness();
  for (const kind of ['enterprise-alert', 'enterprise-checkin']) {
    for (const event of [
      bounceEvent({ to: 'status@phaeacia.example.invalid', tags: { kind } }),
      suppressedEvent({ to: 'status@phaeacia.example.invalid', tags: { kind } }),
    ])
      assert.equal((await h.event(event)).status, 200);
  }
  assert.deepEqual(h.lines, [
    { event: 'operator_mail_undeliverable', cause: 'recipient_permanent' },
    { event: 'operator_mail_undeliverable', cause: 'suppressed' },
    { event: 'operator_mail_undeliverable', cause: 'recipient_permanent' },
    { event: 'operator_mail_undeliverable', cause: 'suppressed' },
  ]);
  assert.deepEqual([h.records, h.sent], [[], []], 'no alert and no send: a mail about a failed operator mail would go the same way');
});

test('the alert about a failed mail never alerts on its own failure: a sink that throws leaves one alert_dropped line', async () => {
  const h = harness({
    sink: async () => {
      throw new Error('synthetic provider refusal quoting someone@customer.example.invalid');
    },
  });
  const r = await h.event(bounceEvent({ tags: invitation(A, INV_A) }));
  assert.deepEqual(r, { status: 200, body: { ok: true } }, 'the provider still gets its acknowledgement');
  assert.deepEqual(
    h.records.map((x) => x.event),
    ['delivery_undeliverable', 'alert_dropped'],
  );
  assert.deepEqual(h.records[1], { event: 'alert_dropped' });
  assert.equal(JSON.stringify(h.records).includes('someone@'), false);
  /* And the next bounce inside the window is folded, not re-sent through the failing sink. */
  await h.event(bounceEvent({ tags: invitation(A, INV_A) }));
  assert.equal(h.records.length, 2);
});

/* ---------- the rules, pure ---------- */

test('isWebhookSecret: whsec_ and base64 of 24 to 64 bytes, nothing else', () => {
  const b64 = (n) => Buffer.alloc(n, 7).toString('base64');
  for (const n of [24, 32, 48, 64]) assert.equal(isWebhookSecret(`whsec_${b64(n)}`), true, String(n));
  for (const v of [
    `whsec_${b64(23)}`,
    `whsec_${b64(65)}`,
    b64(32),
    `WHSEC_${b64(32)}`,
    `whsec_${b64(32)} `,
    ` whsec_${b64(32)}`,
    `whsec_${b64(32).slice(0, -1)}`,
    `whsec_${b64(32).replace(/[A-Za-z]/, '-')}`,
    'whsec_',
    '',
    undefined,
    null,
    42,
  ])
    assert.equal(isWebhookSecret(v), false, JSON.stringify(v));
  assert.equal(isWebhookSecret(SECRET), true);
});

test('verifyMailEvent names its reason for the unit cases; the route answers the same 401 for every one', () => {
  const body = '{"type":"email.bounced"}';
  const { headers } = signEvent(body, { secret: SECRET, timestamp: T0 });
  assert.deepEqual(verifyMailEvent({ headers, rawBody: body, secret: SECRET, nowSeconds: T0 }), { ok: true });
  assert.deepEqual(verifyMailEvent({ headers, rawBody: body, secret: undefined, nowSeconds: T0 }), { ok: false, reason: 'secret' });
  assert.deepEqual(verifyMailEvent({ headers: {}, rawBody: body, secret: SECRET, nowSeconds: T0 }), { ok: false, reason: 'headers' });
  assert.deepEqual(verifyMailEvent({ headers, rawBody: body, secret: SECRET, nowSeconds: T0 + 301 }), { ok: false, reason: 'timestamp' });
  assert.deepEqual(verifyMailEvent({ headers, rawBody: `${body} `, secret: SECRET, nowSeconds: T0 }), { ok: false, reason: 'signature' });
  assert.deepEqual(verifyMailEvent({ headers, rawBody: null, secret: SECRET, nowSeconds: T0 }), { ok: false, reason: 'headers' });
});
