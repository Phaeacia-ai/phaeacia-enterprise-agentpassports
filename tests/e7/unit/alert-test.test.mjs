/* scripts/alert-test.mjs (E7 design 1.5; H-L1's first half): the sink proven alone, locally through
   tests/e7/mail-catcher.mjs. No stack and no network beyond loopback: the catcher is the only endpoint this lane
   ever sends to, and it is not a mail provider, so a green run here proves that the CONFIGURED SINK CAN DELIVER and
   nothing about the channel. The env file is written into a directory outside every Git work tree, because the
   script refuses an in-tree file with no exception. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'alert-test.mjs');
const { startCatcher } = await import('../mail-catcher.mjs');
const { TEST_EVENT, parseArgs, testRecord } = await import('../../../scripts/alert-test.mjs');
const { ALERT_EVENTS, ALERT_VERSION } = await import('../../../lib/http/alerts.mjs');

const dirs = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), 'e7-alert-test-'));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const OPERATOR = 'operator@phaeacia.example.invalid';
function envFile(dir, over = {}) {
  const file = join(dir, 'operator.env');
  const values = { ENTERPRISE_ALERT_SINK: 'mail', ENTERPRISE_ALERT_TO: OPERATOR, ...over };
  writeFileSync(
    file,
    `${Object.entries(values)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`,
  );
  return file;
}
/* The script as a command, ASYNCHRONOUSLY. spawnSync would deadlock every case that needs an answer: the catcher
   runs on this process's event loop, and a synchronous child blocks it, so the child's connect would hang until the
   transport's own five-second timeout and the catcher would record nothing. */
const run = (args) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env } });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      out += c;
    });
    child.on('close', (status) => done({ status, out }));
  });

test('the test event is NOT one of the module\'s five, so a test alert is never mistaken for a real one', () => {
  assert.equal(TEST_EVENT, 'alert_test');
  assert.equal(ALERT_EVENTS.includes(TEST_EVENT), false);
  const record = testRecord(new Date(1_700_000_000_000));
  assert.deepEqual(record, {
    event: 'alert_test',
    route: 'alertTest',
    code: 'E_INTERNAL',
    status: 500,
    errorName: 'Error',
    v: ALERT_VERSION,
    at: '2023-11-14T22:13:20.000Z',
    count: 0,
  });
  /* The same key set a real alert carries, so the two look alike in a mailbox. */
  assert.deepEqual(Object.keys(record).sort(), ['at', 'code', 'count', 'errorName', 'event', 'route', 'status', 'v']);
});

test('H-L1 first half: one alert_test message reaches the catcher through the product\'s own sink', { timeout: 30_000 }, async () => {
  const catcher = await startCatcher();
  try {
    const dir = scratch();
    const file = envFile(dir, catcher.env());
    const r = await run(['--env', file]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /one alert_test alert was accepted by the sink/);
    assert.match(r.out, /a sink that accepts is not a channel that delivers/);
    /* Exactly one message, to the operator's address, rendered by alertMail from the record the script printed. */
    assert.equal(catcher.messages.length, 1, JSON.stringify(catcher.messages));
    const message = catcher.messages[0];
    assert.equal(message.to, OPERATOR);
    assert.match(message.subject, /^Phaeacia enterprise alert: E_INTERNAL on alertTest$/);
    assert.match(message.text, /^A server fault was recorded\. This mail carries no customer content, by design\./);
    assert.match(message.text, /Event: alert_test/);
    assert.match(message.text, /Folded occurrences: 0/);
    /* The alerts design 1.9: the sink tags every alert `kind: enterprise-alert` (namespaced by ALD-R-F15's fallback),
       so a delivery report about an alert's own failure is recognised and never answered with a mail (1.6's loop
       bound); the test alert inherits it. */
    assert.deepEqual(message.tags, { kind: 'enterprise-alert' });
    assert.equal(message.idempotencyKey, null, 'an alert carries no idempotency key');
    assert.equal(catcher.requests[0].userAgent, 'phaeacia-enterprise/1');
    /* The record the script printed is the record the mail was rendered from, field for field. */
    const printed = JSON.parse(r.out.split('\n')[0]);
    for (const [key, label] of [['event', 'Event'], ['route', 'Route'], ['code', 'Code'], ['status', 'Status']])
      assert.ok(message.text.includes(`${label}: ${printed[key]}`), `${label} in the mail`);
    /* The key never leaves the transport: it is not in the script's output and the catcher records no key. */
    assert.equal(r.out.includes(catcher.env().ENTERPRISE_MAIL_API_KEY), false);
    assert.equal(JSON.stringify(catcher.requests).includes(catcher.env().ENTERPRISE_MAIL_API_KEY), false);
  } finally {
    await catcher.close();
  }
});

test('H-L1 first half: a provider that refuses is reported as an outcome and a code, and never in its own words', { timeout: 30_000 }, async () => {
  const catcher = await startCatcher();
  try {
    const dir = scratch();
    const file = envFile(dir, catcher.env());
    catcher.instruct('status', { status: 422 });
    const r = await run(['--env', file]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /the send did not succeed: outcome failed, code none/);
    /* The catcher's refusal body quotes the recipient and a synthetic secret; neither reaches the output (E7-7). */
    const { UPSTREAM_SECRET } = await import('../mail-catcher.mjs');
    for (const secret of [UPSTREAM_SECRET, OPERATOR])
      assert.equal(r.out.includes(secret), false, `${secret} in:\n${r.out}`);
    /* A refused key is the same shape of report: an outcome and a code, nothing else. */
    catcher.instruct('refuse-key');
    const again = await run(['--env', file]);
    assert.equal(again.status, 2, again.out);
    assert.match(again.out, /outcome failed, code none/);
  } finally {
    await catcher.close();
  }
});

test('H-L1 first half: a sink that cannot send says which kind of value is missing, and sends nothing', { timeout: 30_000 }, async () => {
  const catcher = await startCatcher();
  try {
    const dir = scratch();
    /* `none`, the default: the printed line IS the alert and nothing is sent. */
    const off = await run(['--env', envFile(join(scratch()), { ENTERPRISE_ALERT_SINK: 'none', ...catcher.env() })]);
    assert.equal(off.status, 0, off.out);
    assert.match(off.out, /the sink is stderr and the line above IS the alert. Nothing was sent/);
    assert.equal(catcher.messages.length, 0);
    /* `mail` with no recipient, and `mail` with a recipient and no transport: both refuse and send nothing. */
    const noRecipient = await run(['--env', envFile(join(scratch()), { ...catcher.env(), ENTERPRISE_ALERT_TO: null })]);
    assert.equal(noRecipient.status, 2, noRecipient.out);
    assert.match(noRecipient.out, /ENTERPRISE_ALERT_TO is missing or malformed, or the transport is not ready/);
    assert.match(noRecipient.out, /scripts\/check-deploy\.mjs D16/);
    const noTransport = await run(['--env', envFile(join(scratch()))]);
    assert.equal(noTransport.status, 2, noTransport.out);
    assert.match(noTransport.out, /the transport is not ready/);
    assert.equal(catcher.messages.length, 0, 'not one message from any of the three');
    /* --dry-run builds the sink and sends nothing, which is how an operator checks the file before using it. */
    const dry = await run(['--env', envFile(join(scratch()), catcher.env()), '--dry-run']);
    assert.equal(dry.status, 0, dry.out);
    assert.match(dry.out, /--dry-run, so the sink was built and nothing was sent/);
    assert.equal(catcher.messages.length, 0);
    void dir;
  } finally {
    await catcher.close();
  }
});

test('E7-23: malformed arguments and an in-tree env file are refused, with no exception for this script', async () => {
  for (const [args, rule] of [
    [[], /--env is required/],
    [['--env'], /--env needs a value/],
    [['--env', 'x', '--send'], /unknown argument --send/],
  ]) {
    assert.throws(() => parseArgs(args), rule, args.join(' '));
    const r = await run(args);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, rule);
  }
  /* The deploy check's own fixture is admitted THERE and refused HERE: the exception is that target's alone. */
  const fixture = await run(['--env', join('tests', 'e7', 'fixtures', 'local.env')]);
  assert.equal(fixture.status, 2, fixture.out);
  assert.match(fixture.out, /inside a Git work tree is refused/);
  const missing = await run(['--env', join(scratch(), 'no-such-file.env')]);
  assert.equal(missing.status, 2, missing.out);
  assert.match(missing.out, /does not exist/);
});

test('the script\'s header names the isolated fault, and names the revoked key as the fault NOT to use', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  const header = text.slice(0, text.indexOf('import {'));
  /* E7D-C-F10, in as many words, so the procedure cannot be read from the script without meeting it. */
  assert.match(header, /REVOKING THE MAIL KEY\. Do not use that fault/);
  assert.match(header, /suppression\s+ \*\s+list/s);
  assert.match(header, /PROVIDER-DOWN IS A SEPARATE OBSERVATION/);
  assert.match(header, /THE OUT-OF-BAND ESCALATION, named rather than assumed/);
  assert.match(header, /alert_dropped/);
  /* And the structural reason: one transport, one environment, both the invitation's and the alert's. */
  assert.match(header, /SAME transport built from the SAME environment values/);
});
