/* The check-in, stack-free (docs/e7/alerts-and-checkin-design.md 1.8; section 7, slice 1). Cases AC-14 (one check-in
   per period, with the catcher emulating the provider's documented key semantics), AC-34 in its slice 1 lines (each
   line's failure is its own attention state and the mail still goes; only the transport stops it), AC-15's check-in
   half (hostile values reach no mail), the `checkin_recorded` line (ALD-R-F12), the period rule, and the scheduled
   adapter lib/http/checkin.mjs.

   The mail goes through the REAL transport to tests/e7/mail-catcher.mjs on a loopback port, so the request the
   provider would receive (the key, the tags, the user-agent, the body) is the thing asserted. The key and the sender
   are the catcher's synthetic ones.

   FAIL-BEFORE: ALERTS_SLICE1_LIB names a mutant copy of lib/ (evidence/alerts-slice1-repro/mutate.mjs), loaded in
   place of lib/ for every module this file reads. The variable exists for that demonstration only. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { startCatcher } from '../mail-catcher.mjs';

process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = 'example-unit-secret-with-at-least-32-characters-long';
process.env.ENTERPRISE_ORIGIN = 'https://enterprise.example.invalid';

const LIB = process.env.ALERTS_SLICE1_LIB
  ? `${pathToFileURL(resolve(process.env.ALERTS_SLICE1_LIB)).href}/`
  : new URL('../../../lib/', import.meta.url).href;
const lib = (path) => import(new URL(path, LIB).href);

const { runCheckin } = await lib('services/checkin.mjs');
const { checkinHandler } = await lib('http/checkin.mjs');
const { mailTransport } = await lib('services/mail.mjs');
const { resetAlertWindow } = await lib('http/alerts.mjs');
const { checkinPeriod } = await lib('rules/mail-events.mjs');

const DAY = 86_400_000;
/* 2026-09-22 is epoch day 20,718 (the design's own example), a send day; 06:00 UTC, the scheduled hour. */
const SEND_DAY = 20_718 * DAY + 6 * 3_600_000;
const ODD_DAY = SEND_DAY + DAY;
const OPERATOR = 'status@phaeacia.example.invalid';
const DEPLOY = Object.freeze({ id: '64f0a1b2c3d4e5f6a7b8c9d0', context: 'production', published: true });

let catcher;
before(async () => {
  catcher = await startCatcher();
});
after(() => catcher.close());

const ENV_KEYS = [
  'ENTERPRISE_ALERT_SINK',
  'ENTERPRISE_ALERT_TO',
  'ENTERPRISE_INVITATION_DELIVERY',
  'ENTERPRISE_MAIL_WEBHOOK_SECRET',
  'ENTERPRISE_MAIL_PROVIDER',
  'ENTERPRISE_MAIL_API_KEY',
  'ENTERPRISE_MAIL_FROM',
  'ENTERPRISE_MAIL_ENDPOINT',
];
beforeEach(() => {
  catcher.reset();
  resetAlertWindow();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, catcher.env(), {
    ENTERPRISE_ALERT_SINK: 'mail',
    ENTERPRISE_ALERT_TO: OPERATOR,
    ENTERPRISE_INVITATION_DELIVERY: 'mail',
  });
});

/* One run with the seams a case wants; `lines` is the log capture. */
async function run(now, over = {}) {
  const lines = [];
  const outcome = await runCheckin(
    { now, deploy: over.deploy ?? DEPLOY },
    {
      mail: over.mail ?? mailTransport(),
      signingKeysReady: over.signingKeysReady ?? (async () => ({ ok: true })),
      accessState: over.accessState ?? (() => 'open'),
      log: (e) => lines.push(e),
    },
  );
  return { ...outcome, lines };
}

/* ---------- the period ---------- */

test('the period: even epoch days send, odd days do not; the period is that day and the next; the key names its first day', () => {
  assert.deepEqual(checkinPeriod(SEND_DAY), {
    epochDay: 20_718,
    send: true,
    start: '2026-09-22',
    end: '2026-09-23',
    next: '2026-09-24',
    key: 'enterprise-checkin/2026-09-22',
  });
  assert.deepEqual(checkinPeriod(ODD_DAY), { ...checkinPeriod(SEND_DAY), epochDay: 20_719, send: false });
  /* Across a month's end and midnight: the 30th of September is epoch day 20,726, the 1st of October 20,727. */
  assert.equal(checkinPeriod(Date.UTC(2026, 8, 30, 23, 59, 59)).start, '2026-09-30');
  assert.equal(checkinPeriod(Date.UTC(2026, 9, 1, 0, 0, 0)).send, false);
  assert.equal(checkinPeriod(Date.UTC(2026, 9, 1, 0, 0, 0)).start, '2026-09-30');
  assert.equal(checkinPeriod(Date.UTC(2026, 9, 2, 6)).next, '2026-10-04');
  for (const bad of [Number.NaN, Infinity, '1790064000000', undefined]) assert.throws(() => checkinPeriod(bad), RangeError);
});

/* ---------- AC-14 ---------- */

test('AC-14: an odd epoch day makes no request and logs checkin_skipped (fails on a check-in without the parity test)', async () => {
  const r = await run(ODD_DAY);
  assert.equal(r.outcome, 'skipped');
  assert.deepEqual(r.lines, [{ event: 'checkin_skipped' }]);
  assert.equal(catcher.requests.length, 0, 'no request');
  assert.equal(catcher.messages.length, 0, 'no mail on an odd day');
});

test('AC-14: two invocations on one send day make one mail; unchanged, the second logs checkin_sent; changed, checkin_duplicate', async () => {
  const first = await run(SEND_DAY);
  assert.equal(first.outcome, 'sent');
  assert.deepEqual(first.lines, [{ event: 'checkin_sent' }]);
  assert.equal(catcher.messages.length, 1);
  const [message] = catcher.messages;
  assert.equal(message.to, OPERATOR);
  assert.equal(message.idempotencyKey, 'enterprise-checkin/2026-09-22');
  assert.deepEqual(message.tags, { kind: 'enterprise-checkin' });
  assert.equal(message.subject, 'Phaeacia enterprise check-in 2026-09-22: ok');
  assert.equal(catcher.requests[0].userAgent, 'phaeacia-enterprise/1');
  /* A retry an hour later with nothing changed: the provider answers the first request's 200 and sends nothing. */
  const second = await run(SEND_DAY + 3_600_000);
  assert.equal(second.outcome, 'sent');
  assert.deepEqual(second.lines, [{ event: 'checkin_sent' }]);
  assert.equal(catcher.messages.length, 1, 'no second mail');
  /* "Run now" pressed after a line changed: the same key with another body is 409, which is a duplicate. */
  const third = await run(SEND_DAY + 7_200_000, { accessState: () => 'closed' });
  assert.equal(third.outcome, 'duplicate');
  assert.deepEqual(third.lines, [{ event: 'checkin_duplicate' }]);
  assert.equal(catcher.messages.length, 1, 'still one mail');
  assert.deepEqual(
    catcher.requests.map((q) => [q.idempotencyKey, q.status]),
    [
      ['enterprise-checkin/2026-09-22', 200],
      ['enterprise-checkin/2026-09-22', 200],
      ['enterprise-checkin/2026-09-22', 409],
    ],
  );
  /* The next send day is a new period and a new key: a new mail. */
  const next = await run(SEND_DAY + 2 * DAY);
  assert.equal(next.outcome, 'sent');
  assert.equal(catcher.messages.length, 2);
  assert.equal(catcher.messages[1].idempotencyKey, 'enterprise-checkin/2026-09-24');
});

/* ---------- AC-34 (slice 1's lines) ---------- */

test('AC-34: the key-set load failing, access closed and delivery invalid each turn their own line and the subject; the mail still goes', async () => {
  const cases = [
    ['the key-set load answers failed', { signingKeysReady: async () => ({ ok: false, code: 'ETIMEDOUT' }) }, 'Session keys: failed (ETIMEDOUT)'],
    [
      'the key-set load throws',
      {
        signingKeysReady: async () => {
          throw new Error('synthetic key-set failure quoting someone@customer.example.invalid');
        },
      },
      'Session keys: failed (E_SESSION_UNAVAILABLE)',
    ],
    ['access closed', { accessState: () => 'closed' }, 'Access state: closed'],
    [
      'the access switch throws',
      {
        accessState: () => {
          throw new Error('synthetic');
        },
      },
      'Access state: closed',
    ],
    ['delivery invalid', { env: { ENTERPRISE_INVITATION_DELIVERY: 'post-office' } }, 'Invitation delivery: invalid'],
  ];
  for (const [label, over, line] of cases) {
    catcher.reset();
    Object.assign(process.env, over.env ?? {});
    let r;
    try {
      r = await run(SEND_DAY, over);
    } catch {
      r = { outcome: 'threw', lines: [] };
    }
    process.env.ENTERPRISE_INVITATION_DELIVERY = 'mail';
    /* The property first: whatever a line does, the mail goes (1.8). */
    assert.equal(catcher.messages.length, 1, `${label}: the mail still went`);
    assert.equal(r.outcome, 'sent', label);
    assert.deepEqual(r.lines, [{ event: 'checkin_sent' }], label);
    const [m] = catcher.messages;
    assert.equal(m.subject, 'Phaeacia enterprise check-in 2026-09-22: attention', label);
    assert.ok(m.text.split('\n').includes(line), `${label}: ${line}`);
    assert.equal(m.text.includes('someone@'), false, `${label}: nothing of the failure's own text`);
  }
});

test('AC-34: bounce routing is configured only with mail mode, a ready transport and a well-formed secret', async () => {
  const good = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
  for (const [label, env, word] of [
    ['all three', { ENTERPRISE_MAIL_WEBHOOK_SECRET: good }, 'configured'],
    ['no secret', {}, 'not configured'],
    ['a malformed secret', { ENTERPRISE_MAIL_WEBHOOK_SECRET: 'whsec_short' }, 'not configured'],
    ['handover mode', { ENTERPRISE_MAIL_WEBHOOK_SECRET: good, ENTERPRISE_INVITATION_DELIVERY: 'handover' }, 'not configured'],
  ]) {
    catcher.reset();
    delete process.env.ENTERPRISE_MAIL_WEBHOOK_SECRET;
    Object.assign(process.env, env);
    await run(SEND_DAY);
    process.env.ENTERPRISE_INVITATION_DELIVERY = 'mail';
    assert.ok(catcher.messages[0].text.includes(`Bounce routing: ${word}\n`), label);
    assert.equal(catcher.messages[0].text.includes(good), false, `${label}: the secret never appears`);
  }
});

test('AC-34: only the transport stops the mail, with one checkin_dropped line carrying the status or the code, and never an alert', async () => {
  catcher.instruct('status', { status: 500 });
  const refused = await run(SEND_DAY);
  assert.equal(refused.outcome, 'dropped');
  assert.deepEqual(refused.lines, [{ event: 'checkin_dropped', code: undefined, status: 500 }]);
  assert.equal(JSON.stringify(refused.lines), '[{"event":"checkin_dropped","status":500}]');
  catcher.reset();
  catcher.instruct('drop');
  const lost = await run(SEND_DAY);
  assert.equal(lost.outcome, 'dropped');
  assert.equal(lost.lines.length, 1);
  assert.equal(lost.lines[0].event, 'checkin_dropped');
  assert.equal(lost.lines[0].status, undefined, 'no status: the provider never answered');
  /* A closed port: the request never left. A port this process opened and closed again, because fetch refuses the
     well-known low ports ("bad port") before it tries to connect. */
  const { createServer } = await import('node:net');
  const port = await new Promise((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => ok(p));
    });
  });
  process.env.ENTERPRISE_MAIL_ENDPOINT = `http://127.0.0.1:${port}/emails`;
  const closed = await run(SEND_DAY);
  assert.deepEqual(JSON.parse(JSON.stringify(closed.lines)), [{ event: 'checkin_dropped', code: 'ECONNREFUSED' }]);
});

/* ---------- the recorded line (ALD-R-F12) ---------- */

test('ALD-R-F12: when the sink is not mail, nothing is read or sent and checkin_recorded carries event and nothing else', async () => {
  for (const [label, env, mail] of [
    ['sink unset', { ENTERPRISE_ALERT_SINK: undefined }],
    ['sink none', { ENTERPRISE_ALERT_SINK: 'none' }],
    ['no recipient', { ENTERPRISE_ALERT_TO: undefined }],
    ['a recipient that is not an address', { ENTERPRISE_ALERT_TO: 'status at phaeacia' }],
    ['the transport not ready', {}, { ready: () => false, deliver: async () => assert.fail('no send') }],
  ]) {
    catcher.reset();
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    let keysRead = false;
    const r = await run(SEND_DAY, {
      mail,
      signingKeysReady: async () => {
        keysRead = true;
        return { ok: true };
      },
    });
    Object.assign(process.env, { ENTERPRISE_ALERT_SINK: 'mail', ENTERPRISE_ALERT_TO: OPERATOR });
    assert.equal(r.outcome, 'recorded', label);
    assert.deepEqual(r.lines, [{ event: 'checkin_recorded' }], label);
    assert.equal(catcher.requests.length, 0, `${label}: no request`);
    assert.equal(keysRead, false, `${label}: nothing read`);
  }
});

/* ---------- AC-15 (the check-in): hostile values reach no mail ---------- */

test('AC-15 (the check-in): hostile strings in the deploy facts and a failing line reach neither the mail nor the lines', async () => {
  const { STRINGS } = await import('../../e8/fixtures/hostile-strings.mjs');
  for (const s of STRINGS) {
    catcher.reset();
    const r = await run(SEND_DAY, {
      deploy: { id: s, context: s, published: s },
      signingKeysReady: async () => ({ ok: false, code: s }),
    });
    assert.equal(r.outcome, 'sent');
    const [m] = catcher.messages;
    const whole = `${m.subject}\n${m.text}\n${JSON.stringify(r.lines)}`;
    assert.equal(whole.includes(s), false, JSON.stringify(s));
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(whole), false, 'no uuid');
    assert.ok(m.text.includes('Deploy: unknown\n'));
  }
});

/* ---------- the scheduled adapter ---------- */

test('the scheduled adapter reads context.deploy and the clock, sends through the transport, and returns nothing', async () => {
  const lines = [];
  const handler = checkinHandler({
    now: () => SEND_DAY,
    mail: mailTransport(),
    signingKeysReady: async () => ({ ok: true }),
    accessState: () => 'open',
    log: (e) => lines.push(e),
  });
  const answer = await handler(new Request('https://enterprise.example.invalid/.netlify/functions/checkin', { method: 'POST', body: '{"next_run":"2026-09-23T06:00:00.000Z"}' }), {
    deploy: { id: 'abc123def456', context: 'production', published: true },
  });
  assert.equal(answer, undefined);
  assert.deepEqual(lines, [{ event: 'checkin_sent' }]);
  assert.ok(catcher.messages[0].text.includes('Deploy: abc123def456 (production, published: yes)\n'));
});

test('the scheduled adapter: a defect escaping runCheckin writes one shaped internal line and one escaped alert, and nothing else', async () => {
  const written = [];
  const real = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    const done = rest.at(-1);
    if (typeof done === 'function') done();
    return true;
  };
  const records = [];
  try {
    const handler = checkinHandler({
      now: () => SEND_DAY,
      mail: {
        ready: () => {
          const e = new TypeError('synthetic defect quoting someone@customer.example.invalid');
          e.code = 'synthetic-code someone@customer.example.invalid';
          throw e;
        },
        deliver: async () => assert.fail('no send'),
      },
      alertWrite: (r) => records.push(r),
      alertSink: async () => {},
    });
    await handler(new Request('https://enterprise.example.invalid/x', { method: 'POST' }), { deploy: DEPLOY });
  } finally {
    process.stderr.write = real;
  }
  assert.deepEqual(
    written.map((w) => JSON.parse(w)),
    [{ event: 'internal', errorName: 'TypeError', code: 'invalid' }],
  );
  assert.equal(records.length, 1);
  assert.deepEqual({ ...records[0], at: undefined }, { event: 'escaped', route: 'checkin', code: 'invalid', errorName: 'TypeError', v: 1, at: undefined, count: 0 });
  assert.equal(JSON.stringify({ written, records }).includes('someone@'), false);
});

/* ---------- signingKeysReady (lib/session.mjs), the "Session keys" line's read ---------- */

test('signingKeysReady: a keys array is loaded; anything else is failed with a fixed code; the default fetch is bounded at 3 s', async () => {
  const { KEY_SET_TIMEOUT_MS, signingKeysReady } = await lib('session.mjs');
  assert.deepEqual(await signingKeysReady({ fetchJwks: async () => ({ keys: [] }) }), { ok: true });
  assert.deepEqual(await signingKeysReady({ fetchJwks: async () => ({ keys: 'x' }) }), { ok: false, code: 'E_SESSION_UNAVAILABLE' });
  assert.deepEqual(await signingKeysReady({ fetchJwks: async () => null }), { ok: false, code: 'E_SESSION_UNAVAILABLE' });
  const timeout = async () => {
    throw new DOMException('synthetic', 'TimeoutError');
  };
  assert.deepEqual(await signingKeysReady({ fetchJwks: timeout }), { ok: false, code: 'ETIMEDOUT' });
  const refused = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
  };
  assert.deepEqual(await signingKeysReady({ fetchJwks: refused }), { ok: false, code: 'ECONNREFUSED' });
  const odd = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'someone@customer.example.invalid' }) });
  };
  assert.deepEqual(await signingKeysReady({ fetchJwks: odd }), { ok: false, code: 'E_SESSION_UNAVAILABLE' });
  /* The default: one AbortSignal.timeout(3000) handed to the key-set fetch, against a server that never answers. */
  assert.equal(KEY_SET_TIMEOUT_MS, 3000);
  const { createServer } = await import('node:http');
  const held = [];
  const silent = createServer((req) => held.push(req));
  await new Promise((ok) => silent.listen(0, '127.0.0.1', ok));
  const before = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = `http://127.0.0.1:${silent.address().port}`;
  const real = AbortSignal.timeout;
  const asked = [];
  AbortSignal.timeout = (ms) => {
    asked.push(ms);
    return real.call(AbortSignal, 50);
  };
  try {
    assert.deepEqual(await signingKeysReady(), { ok: false, code: 'ETIMEDOUT' });
    assert.deepEqual(asked, [3000]);
  } finally {
    AbortSignal.timeout = real;
    process.env.SUPABASE_URL = before;
    silent.closeAllConnections();
    await new Promise((ok) => silent.close(ok));
  }
});
