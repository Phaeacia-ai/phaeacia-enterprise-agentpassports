/* scripts/smoke.mjs's pure half (E7 design 1.4, S1 to S9) and E7-23's arms for it: no stack, no network, no shell.
   The nine requests against the real dev shell and the local Supabase are E7-19, in tests/e7/stack/smoke.test.mjs;
   here each expectation is fed the answer that satisfies it and then, one at a time, an answer that does not, so
   every rule is shown to fire on its own account and the stack file's green run means something. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../../scripts/smoke.mjs', import.meta.url));
const { PAGE_HEADERS, checkSmoke, parseArgs, report, sequence } = await import('../../../scripts/smoke.mjs');

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'";
const page = {
  status: 200,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  },
  body: null,
};
/** An answer set every rule accepts, so a case is one deliberate change away from clean. */
const clean = () => ({
  S1: structuredClone(page),
  S2: { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' }, body: null },
  S3: structuredClone(page),
  S3b: structuredClone(page),
  S4: { status: 401, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' }, body: { ok: false, code: 'E_UNAUTHENTICATED' } },
  S5: { status: 403, headers: { 'content-type': 'application/json; charset=utf-8' }, body: { ok: false, code: 'E_CROSS_SITE' } },
  S6: { status: 401, headers: { 'content-type': 'application/json; charset=utf-8' }, body: { ok: false, code: 'E_UNAUTHENTICATED' } },
  S7: { status: 401, headers: {}, body: null },
  S8: { status: 404, headers: {}, body: null },
  S9: { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: { disable_signup: true, external: { email: true, google: false } } },
});
const ids = (r) => r.findings.map((f) => f.id);

test('the clean answer set passes, and all ten requests are checked', () => {
  const r = checkSmoke(clean());
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
  assert.deepEqual(r.checked, ['S1', 'S2', 'S3', 'S3b', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']);
  /* The sequence is read only but for S5, which is the one refused before a session and before a body is read. */
  const KEY = 'placeholder-publishable-key-for-this-case';
  const steps = sequence({ origin: 'https://o.example.invalid', supabase: 'https://s.example.invalid', anonKey: KEY });
  assert.deepEqual(
    steps.filter((s) => s.init.method !== 'GET').map((s) => `${s.init.method} ${s.id}`),
    ['POST S5'],
  );
  assert.equal(steps.length, 10);
  /* The publishable key rides in a header and never in a URL, so it cannot land in a proxy or CDN log. */
  for (const s of steps) assert.equal(s.url.includes(KEY), false, s.url);
  assert.deepEqual(
    steps.filter((s) => JSON.stringify(s.init.headers ?? {}).includes(KEY)).map((s) => s.id),
    ['S7', 'S8'],
    'exactly the two Data API requests carry it',
  );
});

test('every rule fires on its own account, one deliberate change at a time', () => {
  const rows = [
    ['S1', (a) => void (a.S1.status = 500)],
    ['S1', (a) => void (a.S1.headers['content-type'] = 'text/plain')],
    ...PAGE_HEADERS.map(([name]) => ['S1', (a) => void (a.S1.headers[name] = null)]),
    ...PAGE_HEADERS.map(([name]) => ['S1', (a) => void (a.S1.headers[name] = 'something else')]),
    ['S2', (a) => void (a.S2.status = 404)],
    ['S2', (a) => void (a.S2.headers['content-type'] = 'text/plain')],
    ['S2', (a) => void (a.S2.headers['x-content-type-options'] = null)],
    ['S3', (a) => void (a.S3.status = 301)],
    ['S3b', (a) => void (a.S3b.status = 308)],
    ['S3', (a) => void (a.S3.headers['content-type'] = 'application/json')],
    ['S4', (a) => void (a.S4.status = 200)],
    ['S4', (a) => void (a.S4.body = { ok: false, code: 'E_MAINTENANCE' })],
    ['S4', (a) => void (a.S4.headers['cache-control'] = 'public, max-age=60')],
    ['S5', (a) => void (a.S5.body = { ok: false, code: 'E_UNAUTHENTICATED' })],
    ['S6', (a) => void (a.S6.status = 404)],
    ['S7', (a) => void (a.S7.status = 200)],
    ['S8', (a) => void (a.S8.status = 200)],
    ['S9', (a) => void (a.S9.body = { disable_signup: false, external: {} })],
    ['S9', (a) => void (a.S9.body = { disable_signup: true, external: { google: true } })],
    ['S9', (a) => void (a.S9.status = 500)],
  ];
  for (const [id, change] of rows) {
    const answers = clean();
    change(answers);
    const r = checkSmoke(answers);
    assert.deepEqual(ids(r), [id], `${id}: ${JSON.stringify(r.findings)}`);
  }
  /* S4's two states are each other's counterexample: a closed site expected open fails, and expected closed passes. */
  const closed = clean();
  closed.S4 = { status: 503, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' }, body: { ok: false, code: 'E_MAINTENANCE' } };
  assert.deepEqual(ids(checkSmoke(closed, { expectSwitch: 'closed' })), []);
  assert.deepEqual(ids(checkSmoke(closed, { expectSwitch: 'open' })), ['S4']);
});

test('a request that could not be made at all is a finding, never a pass', () => {
  for (const id of ['S1', 'S4', 'S7', 'S9']) {
    const answers = clean();
    answers[id] = null;
    const r = checkSmoke(answers);
    assert.deepEqual(ids(r), [id]);
    assert.match(r.findings[0].rule, /could not be made at all/);
  }
  /* Every one of them missing: ten findings and no pass anywhere. */
  const none = checkSmoke({});
  assert.equal(none.findings.length, 10);
  assert.equal(none.checked.length, 10);
});

test('E7-23: malformed arguments exit 2 with a usage line naming the rule', () => {
  const rows = [
    [[], /--origin is required/],
    [['--origin'], /--origin needs a value/],
    [['--origin', 'https://o.example.invalid'], /--supabase is required/],
    [['--origin', 'not-a-url', '--supabase', 'https://s.example.invalid'], /--origin is not an absolute URL/],
    [['--origin', 'ftp://o.example.invalid', '--supabase', 'https://s.example.invalid'], /--origin is not an http or https URL/],
    [['--origin', 'https://o.example.invalid/', '--supabase', 'https://s.example.invalid'], /--origin carries a path/],
    [['--origin', 'https://o.example.invalid', '--supabase', 'https://s.example.invalid/rest/v1'], /--supabase carries a path/],
    [['--origin', 'https://o.example.invalid', '--supabase', 'https://s.example.invalid', '--expect-switch', 'maybe'], /--expect-switch is open or closed/],
    [['--origin', 'https://o.example.invalid', '--supabase', 'https://s.example.invalid', '--verbose'], /unknown argument --verbose/],
  ];
  for (const [args, rule] of rows) {
    assert.throws(() => parseArgs(args), rule, args.join(' '));
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, SUPABASE_ANON_KEY: 'placeholder-publishable-key' } });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, rule, args.join(' '));
  }
  /* A valid argument list parses, and an absent publishable key stops the run rather than letting S7 and S8 pass. */
  assert.deepEqual(parseArgs(['--origin', 'https://o.example.invalid', '--supabase', 'https://s.example.invalid']), {
    origin: 'https://o.example.invalid',
    supabase: 'https://s.example.invalid',
    expectSwitch: 'open',
  });
  const keyless = spawnSync(
    process.execPath,
    [SCRIPT, '--origin', 'https://o.example.invalid', '--supabase', 'https://s.example.invalid'],
    { encoding: 'utf8', env: { ...process.env, SUPABASE_ANON_KEY: '' } },
  );
  assert.equal(keyless.status, 2);
  assert.match(keyless.stdout, /SUPABASE_ANON_KEY is not in the environment/);
});

test('the report prints a rule and a status, and no body, header contents or key', () => {
  const answers = clean();
  answers.S1.headers['content-security-policy'] = "default-src 'none'; report-uri https://collector.example.invalid/synthetic-tenant-path";
  answers.S4.body = { ok: false, code: 'E_MAINTENANCE', message: 'synthetic-tenant-private-sentence' };
  let out = '';
  report(checkSmoke(answers), (s) => {
    out += s;
  });
  for (const secret of ['synthetic-tenant-private-sentence', 'collector.example.invalid', 'synthetic-tenant-path'])
    assert.equal(out.includes(secret), false, out);
  assert.match(out, /REFUSE S1: the page header content-security-policy is absent or not the value netlify\.toml sets/);
  assert.match(out, /smoke: 10 requests, 2 problem\(s\)/);
});
