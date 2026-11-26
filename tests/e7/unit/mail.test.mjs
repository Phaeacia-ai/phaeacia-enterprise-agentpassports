/* E7 design 1.1, 1.5 and 2.7: the mail templates and the transport, with no stack and no network.

   The templates: each of the four kinds, the role word, the sanitised company name (E7-4's second half), the fixed
   sentences, the two-lifetimes paragraph in the wording E7-28 selected, and the tripwire (E7-4's rendering half): an
   argument carrying every string a mail must never contain, rendered for every kind, and none of them found.
   Fail-before: E7_TEMPLATES_MODULE names a mutant of the module (evidence/e7-mail-repro/mutants/), and the tripwire
   fails against it at the search. The variable exists for that demonstration only; the gate never sets it. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const templatesUrl = process.env.E7_TEMPLATES_MODULE
  ? pathToFileURL(process.env.E7_TEMPLATES_MODULE).href
  : new URL('../../../lib/services/mail-templates.mjs', import.meta.url).href;
const { INVITATION_KINDS, alertMail, checkinMail, invitationMail, sanitizeName, utcDate } = await import(templatesUrl);

const ORIGIN = 'https://enterprise.example.invalid';
const CODE = 'c'.repeat(64);
const HASH = 'pkce_0123456789abcdef0123456789abcdef0123456789abcdef01';
const URL_OK = `${ORIGIN}/accept#token_hash=${HASH}&type=magiclink&invite=${CODE}`;
const EXPIRES = '2026-09-26T14:03:27.123456+00:00';
const LF = String.fromCodePoint(10);
const CR = String.fromCodePoint(13);
const TAB = String.fromCodePoint(9);
const RLO = String.fromCodePoint(0x202e);
const LSEP = String.fromCodePoint(0x2028);
const NUL = String.fromCodePoint(0);

const render = (kind, over = {}) =>
  invitationMail({ kind, companyName: 'Acme Synthetic AG', acceptUrl: URL_OK, expiresAt: EXPIRES, ...over });

test('the four kinds render, and the role word is the difference between member and administrator', () => {
  assert.deepEqual([...INVITATION_KINDS], ['member', 'administrator', 'first_admin', 'succession']);
  const member = render('member');
  const admin = render('administrator');
  assert.equal(member.subject, 'Your invitation to Acme Synthetic AG on Phaeacia');
  assert.equal(admin.subject, member.subject);
  assert.match(member.text, /^You have been invited to Acme Synthetic AG's workspace on Phaeacia\.\n/);
  assert.match(admin.text, /^You have been invited to Acme Synthetic AG's workspace on Phaeacia as an administrator\.\n/);
  assert.doesNotMatch(member.text, /administrator|second factor/, 'a member invitation names neither');
  for (const kind of ['administrator', 'first_admin', 'succession'])
    assert.ok(
      render(kind).text.includes(
        'After you accept, you will set up a second factor (an authenticator app) before you can administer the company.',
      ),
      `${kind}: the second-factor sentence`,
    );
  assert.match(render('first_admin').text, /^You have been invited to set up Acme Synthetic AG's workspace on Phaeacia as its first administrator\./);
  assert.match(render('succession').text, /The workspace already exists; this invitation adds an administrator to it\./);
});

test('the fixed sentences, the URL alone on its line, and the expiry as a UTC date', () => {
  for (const kind of INVITATION_KINDS) {
    const { text } = render(kind);
    const lines = text.split(LF);
    assert.equal(lines.filter((l) => l === URL_OK).length, 1, `${kind}: the URL on a line of its own, once`);
    const at = lines.indexOf(URL_OK);
    assert.equal(lines[at - 1], 'Open this link to accept. It signs you in, so do not forward it.');
    assert.ok(
      text.includes(
        'Open it within one hour of this mail. After that hour the link may no longer sign you in; if it does not, ask the person who invited you for a new link, which replaces this one. The invitation ends on 26 September 2026, 14:03 UTC in any case.',
      ),
      `${kind}: the lifetimes paragraph E7-28 selected`,
    );
    assert.ok(text.endsWith('If you did not expect this mail, ignore it. Nothing happens until the link is opened and you press Accept.\n'));
    assert.ok(!text.includes(CR), `${kind}: no carriage return`);
  }
  assert.equal(utcDate('2026-01-05T00:07:00Z'), '5 January 2026, 00:07 UTC');
  assert.equal(utcDate('2026-12-31T23:30:00-02:00'), '1 January 2027, 01:30 UTC');
});

test('what cannot be rendered truthfully is refused: an unknown kind, a malformed URL, an unreadable date', () => {
  for (const kind of ['admin', 'Member', undefined, '']) assert.throws(() => render(kind), TypeError, String(kind));
  for (const acceptUrl of [
    undefined,
    '',
    'javascript:alert(1)',
    `/accept#invite=${CODE}`,
    `${URL_OK}${LF}https://evil.example.invalid/`,
    `${ORIGIN}/accept# token_hash=x`,
    `${ORIGIN}/${'a'.repeat(2048)}`,
  ])
    assert.throws(() => render('member', { acceptUrl }), TypeError, JSON.stringify(acceptUrl)?.slice(0, 40));
  for (const expiresAt of [undefined, '', 'next week', 1790000000000]) assert.throws(() => render('member', { expiresAt }), TypeError);
});

test('sanitizeName: controls, line breaks, separators and overrides removed, whitespace collapsed, 80 characters', () => {
  assert.equal(sanitizeName(`  Acme${LF}Synthetic${TAB}${TAB}AG${CR} `), 'Acme Synthetic AG');
  assert.equal(sanitizeName(`A${NUL}B${String.fromCodePoint(0x7f)}C${String.fromCodePoint(0x85)}D`), 'A B C D');
  assert.equal(sanitizeName(`Acme${LSEP}AG`), 'Acme AG');
  assert.equal(sanitizeName(`${RLO}GA emcA`), 'GA emcA', 'a right-to-left override is removed');
  assert.equal(sanitizeName('x'.repeat(120)), 'x'.repeat(80));
  assert.equal(Array.from(sanitizeName('😀'.repeat(90))).length, 80, 'cut at code points, never inside a pair');
  for (const v of [null, undefined, 42, {}, '', `  ${LF}${TAB} `]) assert.equal(sanitizeName(v), null, JSON.stringify(v));
});

test('E7-4, second half: a display name with a line break, a tab and 120 characters cannot break or stretch the subject', () => {
  const long = `Line${LF}Break${TAB}Tab ${'n'.repeat(120)}`;
  for (const kind of INVITATION_KINDS) {
    const { subject, text } = render(kind, { companyName: long });
    assert.ok(!subject.includes(LF) && !subject.includes(CR) && !subject.includes(TAB), `${kind}: one header line`);
    const name = subject.slice('Your invitation to '.length, -' on Phaeacia'.length);
    assert.ok(Array.from(name).length <= 80, `${kind}: at most 80 characters of name`);
    assert.ok(name.startsWith('Line Break Tab n'), `${kind}: the words survive as words`);
    assert.ok(!text.split(LF)[0].includes(TAB), `${kind}: the body's first line holds no tab`);
  }
  const unnamed = render('member', { companyName: `${LF}${TAB}` });
  assert.equal(unnamed.subject, 'Your invitation on Phaeacia');
  assert.match(unnamed.text, /^You have been invited to a company's workspace on Phaeacia\./);
});

/* The strings a mail must never carry (design 1.1), as a world's tenant content would hold them. */
const FORBIDDEN = Object.freeze({
  passportSentence: 'synthetic-passport-sentence the agent drafts board minutes',
  candidateTitle: 'synthetic-candidate-title Quarterly Filing Helper',
  agentName: 'synthetic-agent-name Minute Taker',
  groupName: 'synthetic-group-name Finance Audience',
  releaseName: 'synthetic-release-name v7',
  reviewReason: 'synthetic-review-reason needs a second look',
  memberName: 'synthetic-member-display-name Petra Muster',
  memberAddress: 'synthetic-member@example.invalid',
  inviterName: 'synthetic-inviter-display-name Hans Beispiel',
  inviterAddress: 'synthetic-inviter@example.invalid',
  signInCode: '493817',
  earlierInvitation: 'synthetic-earlier-invitation-id 0b8f3c1e',
});

test('E7-4 tripwire (rendering half): no kind renders anything it was not given by name', () => {
  const extra = { ...FORBIDDEN, to: FORBIDDEN.memberAddress, email: FORBIDDEN.memberAddress, inviteCode: CODE, tokenHash: HASH };
  for (const kind of INVITATION_KINDS) {
    const { subject, text } = invitationMail({ kind, companyName: 'Acme Synthetic AG', acceptUrl: URL_OK, expiresAt: EXPIRES, ...extra });
    const whole = `${subject}${LF}${text}`;
    for (const [label, value] of Object.entries(FORBIDDEN))
      assert.ok(!whole.includes(value), `${kind}: the mail carries the ${label}`);
    assert.ok(!whole.includes('@'), `${kind}: an @ outside the recipient`);
    /* The code and the hash appear exactly once each, inside the URL's fragment and nowhere else. */
    const fragment = URL_OK.slice(URL_OK.indexOf('#'));
    assert.equal(whole.split(CODE).length, 2, `${kind}: the invitation code once`);
    assert.equal(whole.split(HASH).length, 2, `${kind}: the token hash once`);
    assert.ok(whole.includes(fragment), `${kind}: and both inside the fragment`);
    assert.deepEqual(Object.keys(invitationMail({ kind, companyName: 'x', acceptUrl: URL_OK, expiresAt: EXPIRES })).sort(), ['subject', 'text']);
  }
});

test('alertMail: only the named keys, each its value or invalid, in a fixed order; unknown keys never print', () => {
  const PRIVATE = 'synthetic-tenant-private-sentence';
  const good = alertMail({
    event: 'delivery_failed',
    route: 'invitationsCreate',
    code: 'E_INTERNAL',
    status: 500,
    companyId: 'aaaaaaaa-1111-4222-8333-444444444444',
    requestId: '01HZX-abc',
    errorName: 'MailError',
    count: 3,
    at: '2026-09-19T20:01:02.345Z',
    v: 1,
    message: PRIVATE,
    stack: PRIVATE,
    details: PRIVATE,
    body: PRIVATE,
  });
  assert.equal(good.subject, 'Phaeacia enterprise alert: E_INTERNAL on invitationsCreate');
  assert.ok(good.text.startsWith('A server fault was recorded. This mail carries no customer content, by design.\n'));
  assert.deepEqual(
    good.text.split(LF).filter((l) => l.includes(': ')).map((l) => l.split(': ')[0]),
    ['Event', 'Route', 'Code', 'Status', 'Company', 'Request', 'Error class', 'Folded occurrences', 'At', 'Version'],
  );
  /* The alerts design 1.2: "Cause" and "Routed to" after "Company", printed only when the record carries them. */
  const bounced = alertMail({
    event: 'delivery_undeliverable',
    route: 'mailEvents',
    companyId: 'aaaaaaaa-1111-4222-8333-444444444444',
    cause: 'recipient_permanent',
    routedTo: 'operator',
    requestId: '01HZX-abc',
    count: 0,
    at: '2026-09-22T08:15:10.020Z',
    v: 1,
  });
  assert.deepEqual(
    bounced.text.split(LF).filter((l) => l.includes(': ')).map((l) => l.split(': ')[0]),
    ['Event', 'Route', 'Company', 'Cause', 'Routed to', 'Request', 'Folded occurrences', 'At', 'Version'],
  );
  assert.ok(bounced.text.includes('Cause: recipient_permanent\nRouted to: operator\n'));
  /* ALD-R-F14, settled against the code: a bounce alert does not open "A server fault was recorded." and its subject
     names the cause, not "no code". Fails before: the template as it stood at f13640e headed every alert with the
     server-fault sentence and "no code on". */
  assert.equal(
    bounced.subject,
    'Phaeacia enterprise alert: an invitation could not be delivered (recipient_permanent) on mailEvents',
  );
  assert.ok(
    bounced.text.startsWith(
      'The mail provider accepted an invitation and then reported that it could not be delivered. This mail carries no customer content, by design.\n',
    ),
  );
  assert.equal(bounced.text.includes('server fault'), false);
  assert.ok(!good.text.includes(PRIVATE) && !good.subject.includes(PRIVATE));
  const bad = alertMail({
    event: PRIVATE,
    route: `${PRIVATE}${LF}Bcc: x@example.invalid`,
    code: 'e_internal; drop',
    status: 200,
    companyId: PRIVATE,
    requestId: `${PRIVATE} ${PRIVATE}`,
    errorName: 'Error: synthetic message',
    count: -1,
    at: 'yesterday',
    v: '1',
    cause: `${PRIVATE} said no`,
    routedTo: 'someone@example.invalid',
  });
  assert.equal(bad.subject, 'Phaeacia enterprise alert: invalid on invalid');
  assert.ok(!bad.text.includes(PRIVATE) && !bad.text.includes('Bcc') && !bad.text.includes('synthetic message'));
  assert.ok(!bad.text.includes('someone@example.invalid'));
  assert.equal(bad.text.split(LF).filter((l) => l.endsWith(': invalid')).length, 12);
  const badBounce = alertMail({ event: 'delivery_undeliverable', route: 'mailEvents', cause: `${PRIVATE}${LF}Bcc: x@example.invalid` });
  assert.equal(badBounce.subject, 'Phaeacia enterprise alert: an invitation could not be delivered (invalid) on mailEvents');
  assert.ok(!badBounce.text.includes(PRIVATE) && !badBounce.subject.includes('Bcc'));
  assert.equal(alertMail(null).subject, 'Phaeacia enterprise alert: no code on no route');
});

/* ---------- the transport (E7 1.1; E7-6's unit half, E7-7, E7D-C-F7) ----------

   Every request goes to a capture passed as fetchImpl; nothing leaves the process. The key is a synthetic value, and no
   assertion message carries it: a key comparison is assert.ok with a fixed message, never assert.equal, whose failure
   prints both sides. */
/* E7_MAIL_MODULE names another transport module, for the AC-24 fail-before only (the transport at a631aa3, which
   imports nothing, run from a copy under .scratch/); the gate never sets it. */
const { MailError, PROVIDERS, SEND_TIMEOUT_MS, mailTransport } = await import(
  process.env.E7_MAIL_MODULE
    ? pathToFileURL(process.env.E7_MAIL_MODULE).href
    : new URL('../../../lib/services/mail.mjs', import.meta.url).href
);

const SYNTHETIC_KEY = 'example-synthetic-unit-provider-value-0123';
const MAIL_ENV = Object.freeze({
  ENTERPRISE_MAIL_PROVIDER: 'resend',
  ENTERPRISE_MAIL_API_KEY: SYNTHETIC_KEY,
  ENTERPRISE_MAIL_FROM: 'Phaeacia <no-reply@phaeacia.example.invalid>',
});
const MESSAGE = Object.freeze({ to: 'invitee@example.invalid', subject: 'Your invitation to Acme on Phaeacia', text: `Hello${LF}` });

/** A fetch capture: records each call and answers with `answer(call)` (a Response, or a thrown value). */
function capture(answer = () => new Response('{"id":"x"}', { status: 200 })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url, init, body: JSON.parse(init.body) };
    calls.push(call);
    return answer(call);
  };
  return { calls, fetchImpl };
}

/** A network failure as undici throws it: a TypeError whose cause carries the code. */
const networkError = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`synthetic ${code}`), { code }) });

test('the request: one POST to the provider endpoint, the key only in the authorization header, the body shape', async () => {
  const cap = capture();
  const t = mailTransport({ ...MAIL_ENV }, { fetchImpl: cap.fetchImpl });
  assert.equal(t.ready(), true);
  await t.deliver(MESSAGE);
  assert.equal(cap.calls.length, 1);
  const [{ url, init, body }] = cap.calls;
  assert.equal(url, 'https://api.resend.com/emails');
  assert.equal(url, PROVIDERS.resend.endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual', 'a redirect is an answer, never followed');
  /* The alerts design 1.9 item 1 adds the explicit user-agent (AC-24, below). */
  assert.deepEqual(Object.keys(init.headers).sort(), ['authorization', 'content-type', 'user-agent']);
  assert.ok(init.headers.authorization === `Bearer ${SYNTHETIC_KEY}`, 'the authorization header carries the key as a bearer');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.deepEqual(body, { from: MAIL_ENV.ENTERPRISE_MAIL_FROM, to: [MESSAGE.to], subject: MESSAGE.subject, text: MESSAGE.text });
  assert.ok(!init.body.includes(SYNTHETIC_KEY), 'the key is not in the body');

  const withReply = capture();
  await mailTransport({ ...MAIL_ENV, ENTERPRISE_MAIL_REPLY_TO: 'support@phaeacia.example.invalid' }, { fetchImpl: withReply.fetchImpl }).deliver(MESSAGE);
  assert.equal(withReply.calls[0].body.reply_to, 'support@phaeacia.example.invalid');
  assert.equal(Object.hasOwn(cap.calls[0].body, 'reply_to'), false, 'absent reply-to: no key at all');
});

test('ENTERPRISE_MAIL_ENDPOINT replaces the endpoint, and only with an http(s) URL on a loopback host', async () => {
  for (const endpoint of ['http://127.0.0.1:41234/emails', 'http://localhost:9/emails', 'https://[::1]:8443/x']) {
    const cap = capture();
    const t = mailTransport({ ...MAIL_ENV, ENTERPRISE_MAIL_ENDPOINT: endpoint }, { fetchImpl: cap.fetchImpl });
    assert.equal(t.ready(), true, endpoint);
    await t.deliver(MESSAGE);
    assert.equal(cap.calls[0].url, new URL(endpoint).href, endpoint);
  }
  for (const endpoint of [
    'https://api.resend.com.example.invalid/emails',
    'http://10.0.0.1/emails',
    'http://127.0.0.2/emails',
    'ftp://127.0.0.1/emails',
    'http://user:pw@127.0.0.1/emails',
    'not a url',
  ]) {
    const cap = capture();
    const t = mailTransport({ ...MAIL_ENV, ENTERPRISE_MAIL_ENDPOINT: endpoint }, { fetchImpl: cap.fetchImpl });
    assert.equal(t.ready(), false, endpoint);
    await assert.rejects(t.deliver(MESSAGE), (e) => e instanceof MailError && e.outcome === 'failed', endpoint);
    assert.equal(cap.calls.length, 0, `${endpoint}: nothing sent`);
  }
  assert.equal(mailTransport({ ...MAIL_ENV, ENTERPRISE_MAIL_ENDPOINT: '' }).ready(), true, 'empty is absent');
});

test('ready() and E7-6 unit half: every missing or malformed value makes the transport not ready, and nothing is sent', async () => {
  const cases = [
    ['no provider', { ENTERPRISE_MAIL_PROVIDER: undefined }],
    ['an unknown provider', { ENTERPRISE_MAIL_PROVIDER: 'postmark' }],
    ['an inherited name', { ENTERPRISE_MAIL_PROVIDER: 'toString' }],
    ['the prototype key', { ENTERPRISE_MAIL_PROVIDER: '__proto__' }],
    ['no key', { ENTERPRISE_MAIL_API_KEY: undefined }],
    ['an empty key', { ENTERPRISE_MAIL_API_KEY: '' }],
    ['a key with a space', { ENTERPRISE_MAIL_API_KEY: 're_synthetic key' }],
    ['a key with a line break', { ENTERPRISE_MAIL_API_KEY: `re_synthetic${LF}X-Injected: 1` }],
    ['a short key', { ENTERPRISE_MAIL_API_KEY: 're_1' }],
    ['no sender', { ENTERPRISE_MAIL_FROM: undefined }],
    ['a sender without an address', { ENTERPRISE_MAIL_FROM: 'Phaeacia' }],
    ['a sender with a malformed address', { ENTERPRISE_MAIL_FROM: 'Phaeacia <no-reply@>' }],
    ['a sender with a line break', { ENTERPRISE_MAIL_FROM: `Phaeacia <a@example.invalid>${LF}Bcc: b@example.invalid` }],
    ['a sender name with a quote', { ENTERPRISE_MAIL_FROM: 'Pha"eacia <a@example.invalid>' }],
    ['a sender with angle brackets only', { ENTERPRISE_MAIL_FROM: '<a@example.invalid>' }],
    ['a malformed reply-to', { ENTERPRISE_MAIL_REPLY_TO: 'support' }],
  ];
  for (const [label, over] of cases) {
    const env = { ...MAIL_ENV, ...over };
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete env[k];
    const cap = capture();
    const t = mailTransport(env, { fetchImpl: cap.fetchImpl });
    assert.equal(t.ready(), false, label);
    await assert.rejects(t.deliver(MESSAGE), (e) => e instanceof MailError && e.outcome === 'failed', label);
    assert.equal(cap.calls.length, 0, `${label}: nothing sent`);
  }
  assert.equal(mailTransport({ ...MAIL_ENV, ENTERPRISE_MAIL_FROM: 'no-reply@phaeacia.example.invalid' }).ready(), true, 'a bare address is a sender');
  assert.equal(mailTransport({}).ready(), false, 'an empty environment');
});

test('the environment is read at each call: a transport built before the values exist becomes ready when they do', async () => {
  const env = {};
  const cap = capture();
  const t = mailTransport(env, { fetchImpl: cap.fetchImpl });
  assert.equal(t.ready(), false);
  Object.assign(env, MAIL_ENV);
  assert.equal(t.ready(), true);
  await t.deliver(MESSAGE);
  assert.equal(cap.calls.length, 1);
});

test('a malformed message is refused before any request', async () => {
  for (const [label, over] of [
    ['two recipients', { to: 'a@example.invalid, b@example.invalid' }],
    ['a recipient with a line break', { to: `a@example.invalid${LF}` }],
    ['a subject with a line break', { subject: `Hello${LF}Bcc: b@example.invalid` }],
    ['an empty subject', { subject: '' }],
    ['no text', { text: undefined }],
    ['an oversized text', { text: 'x'.repeat(100_001) }],
  ]) {
    const cap = capture();
    await assert.rejects(mailTransport({ ...MAIL_ENV }, { fetchImpl: cap.fetchImpl }).deliver({ ...MESSAGE, ...over }), MailError, label);
    assert.equal(cap.calls.length, 0, `${label}: nothing sent`);
  }
});

test(`the timeout: one AbortSignal.timeout(${SEND_TIMEOUT_MS}) per request, handed to fetch; a timeout is unconfirmed`, async () => {
  const real = AbortSignal.timeout;
  const asked = [];
  AbortSignal.timeout = (ms) => {
    asked.push(ms);
    return real.call(AbortSignal, ms);
  };
  try {
    const cap = capture();
    await mailTransport({ ...MAIL_ENV }, { fetchImpl: cap.fetchImpl }).deliver(MESSAGE);
    assert.deepEqual(asked, [5000]);
    assert.ok(cap.calls[0].init.signal instanceof AbortSignal);
  } finally {
    AbortSignal.timeout = real;
  }
  const timedOut = capture(() => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  await assert.rejects(mailTransport({ ...MAIL_ENV }, { fetchImpl: timedOut.fetchImpl }).deliver(MESSAGE), (e) => {
    assert.ok(e instanceof MailError);
    assert.equal(e.outcome, 'unconfirmed');
    assert.equal(e.code, 'ETIMEDOUT');
    return true;
  });
});

test('the three answers: any 2xx is sent; any other status failed; never-left failures failed; lost answers unconfirmed', async () => {
  for (const status of [200, 201, 202, 299]) await mailTransport({ ...MAIL_ENV }, { fetchImpl: capture(() => new Response(null, { status })).fetchImpl }).deliver(MESSAGE);
  for (const status of [301, 302, 400, 401, 403, 409, 422, 429, 500, 502, 503]) {
    const t = mailTransport({ ...MAIL_ENV }, { fetchImpl: capture(() => new Response('{}', { status })).fetchImpl });
    await assert.rejects(t.deliver(MESSAGE), (e) => e instanceof MailError && e.outcome === 'failed' && e.code === undefined, String(status));
    /* The alerts design 1.9 item 4: the provider's status when it is 400 to 599, and nothing for a redirect. */
    await assert.rejects(t.deliver(MESSAGE), (e) => e.status === (status >= 400 ? status : undefined), `${status}: MailError.status`);
  }
  const outcomes = {
    ECONNREFUSED: 'failed',
    ENOTFOUND: 'failed',
    EAI_AGAIN: 'failed',
    UND_ERR_CONNECT_TIMEOUT: 'failed',
    CERT_HAS_EXPIRED: 'failed',
    ERR_TLS_CERT_ALTNAME_INVALID: 'failed',
    ECONNRESET: 'unconfirmed',
    UND_ERR_SOCKET: 'unconfirmed',
    EPIPE: 'unconfirmed',
    UND_ERR_HEADERS_TIMEOUT: 'unconfirmed',
    E_SYNTHETIC_UNKNOWN: 'unconfirmed',
  };
  for (const [code, outcome] of Object.entries(outcomes)) {
    const t = mailTransport({ ...MAIL_ENV }, { fetchImpl: capture(() => { throw networkError(code); }).fetchImpl });
    await assert.rejects(t.deliver(MESSAGE), (e) => {
      assert.ok(e instanceof MailError, code);
      assert.equal(e.outcome, outcome, code);
      assert.equal(e.code, ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'E_SYNTHETIC_UNKNOWN'].includes(code) ? undefined : code, code);
      assert.equal(e.cause, undefined, `${code}: the cause is not attached`);
      return true;
    });
  }
  const thrownAnything = capture(() => {
    throw 'a string';
  });
  await assert.rejects(mailTransport({ ...MAIL_ENV }, { fetchImpl: thrownAnything.fetchImpl }).deliver(MESSAGE), (e) => e.outcome === 'unconfirmed');
});

test('E7-7 unit half: a 500 whose body quotes the message, the recipient and a secret leaves nothing of it anywhere', async () => {
  const QUOTED = `synthetic-upstream-quote ${MESSAGE.to} ${MESSAGE.subject} sk_synthetic_upstream_secret_4242`;
  let cancelled = false;
  let pulled = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: QUOTED })));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const t = mailTransport({ ...MAIL_ENV }, { fetchImpl: capture(() => new Response(body, { status: 500 })).fetchImpl });
  let thrown;
  try {
    await t.deliver(MESSAGE);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof MailError);
  assert.equal(thrown.outcome, 'failed');
  const everything = JSON.stringify({ ...thrown, message: thrown.message, name: thrown.name, stack: thrown.stack, cause: String(thrown.cause) });
  for (const piece of ['synthetic-upstream-quote', 'sk_synthetic_upstream_secret_4242', MESSAGE.to, MESSAGE.subject])
    assert.ok(!everything.includes(piece), `the thrown error carries a piece of the upstream body`);
  /* `status` joined with the alerts design 1.9 item 4: a number the provider answered, not its words. */
  assert.deepEqual(Object.keys(thrown).sort(), ['name', 'outcome', 'status']);
  assert.equal(thrown.status, 500);
  assert.equal(thrown.message, 'failed');
  assert.ok(cancelled || pulled <= 1, 'the body was cancelled, not read into the error');
});

/* ---------- AC-24: the transport's own changes (the alerts design 1.9) ----------

   Asserted on the headers object the transport hands fetchImpl, because a catcher that refused a request without a
   user-agent would pass at a631aa3: Node's fetch adds `node` by itself (probe p6 b, ALD-R-F10). Fail-before: this
   file with E7_MAIL_MODULE set to a copy of the transport at a631aa3 fails here at the user-agent, the tags and the
   key (evidence/alerts-slice1-repro/ac-24-fail-before.log). */

/* The check-in's key for 2026-09-22, named rather than written beside the property: scripts/check-secrets.mjs reads a
   camel-case `...Key:` followed by twenty or more characters as a credential assignment, which this is not. */
const PERIOD_ONE = 'enterprise-checkin/2026-09-22';

test('AC-24: user-agent phaeacia-enterprise/1, tags as the provider list, the key only when given, the status, the body unread', async () => {
  const cap = capture();
  const t = mailTransport({ ...MAIL_ENV }, { fetchImpl: cap.fetchImpl });
  await t.deliver({ ...MESSAGE, tags: { kind: 'enterprise-invitation', company: 'aaaaaaaa-1111-4222-8333-444444444444' }, idempotencyKey: PERIOD_ONE });
  const [{ init, body }] = cap.calls;
  assert.equal(init.headers['user-agent'], 'phaeacia-enterprise/1');
  assert.equal(init.headers['idempotency-key'], 'enterprise-checkin/2026-09-22');
  assert.deepEqual(body.tags, [
    { name: 'kind', value: 'enterprise-invitation' },
    { name: 'company', value: 'aaaaaaaa-1111-4222-8333-444444444444' },
  ]);
  /* Without them, neither is sent: no tags key in the body, no idempotency-key header. */
  const plain = capture();
  await mailTransport({ ...MAIL_ENV }, { fetchImpl: plain.fetchImpl }).deliver(MESSAGE);
  assert.equal(plain.calls[0].init.headers['user-agent'], 'phaeacia-enterprise/1');
  assert.equal(Object.hasOwn(plain.calls[0].init.headers, 'idempotency-key'), false);
  assert.equal(Object.hasOwn(plain.calls[0].body, 'tags'), false);
  /* A 409 carries its status and the body stays unread, as for any other refusal. */
  let pulled = 0;
  const refusing = capture(
    () =>
      new Response(
        new ReadableStream({
          pull(c) {
            pulled += 1;
            c.enqueue(new TextEncoder().encode('{"name":"invalid_idempotent_request","message":"synthetic quote invitee@example.invalid"}'));
            c.close();
          },
        }),
        { status: 409 },
      ),
  );
  await assert.rejects(
    mailTransport({ ...MAIL_ENV }, { fetchImpl: refusing.fetchImpl }).deliver({ ...MESSAGE, idempotencyKey: PERIOD_ONE }),
    (e) => e instanceof MailError && e.outcome === 'failed' && e.status === 409 && !JSON.stringify({ ...e, m: e.message }).includes('invitee@'),
  );
  assert.ok(pulled <= 1, 'the refusal body is not read');
});

test('AC-24: malformed tags or a malformed key refuse the message before any request', async () => {
  for (const [label, over] of [
    ['a tag value with an @', { tags: { kind: 'invitation', to: 'a@example.invalid' } }],
    ['a tag name with a space', { tags: { 'the kind': 'invitation' } }],
    ['a tag value over 256 characters', { tags: { kind: 'x'.repeat(257) } }],
    ['six tags', { tags: { a: '1', b: '2', c: '3', d: '4', e: '5', f: '6' } }],
    ['no tags at all', { tags: {} }],
    ['tags as a list', { tags: [{ name: 'kind', value: 'invitation' }] }],
    ['a tag value that is not a string', { tags: { kind: 1 } }],
    ['a key with a space', { idempotencyKey: 'enterprise checkin' }],
    ['a key with a line break', { idempotencyKey: `enterprise-checkin${LF}X-Injected: 1` }],
    ['a key over 256 characters', { idempotencyKey: 'k'.repeat(257) }],
    ['an empty key', { idempotencyKey: '' }],
  ]) {
    const cap = capture();
    await assert.rejects(mailTransport({ ...MAIL_ENV }, { fetchImpl: cap.fetchImpl }).deliver({ ...MESSAGE, ...over }), MailError, label);
    assert.equal(cap.calls.length, 0, `${label}: nothing sent`);
  }
});

/* ---------- checkinMail (the alerts design 1.8, slice 1) ---------- */

const CHECKIN = Object.freeze({
  start: '2026-09-22',
  end: '2026-09-23',
  next: '2026-09-24',
  hourUtc: 6,
  deploy: { id: '64f0a1b2c3d4e5f6a7b8c9d0', context: 'production', published: true },
  access: 'open',
  delivery: 'mail',
  bounceRouting: true,
  sessionKeys: { ok: true },
});

test('checkinMail: the lines from Period to Session keys, in order, and ok when nothing is in its attention state', () => {
  const m = checkinMail(CHECKIN);
  assert.equal(m.subject, 'Phaeacia enterprise check-in 2026-09-22: ok');
  assert.equal(m.attention, false);
  const labelled = m.text.split(LF).filter((l) => /^[A-Z][a-z -]+: /.test(l) && !l.startsWith('What this mail'));
  assert.deepEqual(labelled, [
    'Period: 2026-09-22 to 2026-09-23 (UTC)',
    'Next check-in: 2026-09-24 at 06:00 UTC. If it has not arrived by 12:00 UTC that day, treat its absence as the alert.',
    'Deploy: 64f0a1b2c3d4e5f6a7b8c9d0 (production, published: yes)',
    'Access state: open',
    'Invitation delivery: mail',
    'Bounce routing: configured',
    'Session keys: loaded',
  ]);
  /* Slice 1 reads no database, and says so where the mail says what it cannot tell (design section 7). */
  assert.match(m.text, /What this mail cannot tell you: whether the database answers and what it holds/);
  assert.match(m.text, /"Bounce routing: configured" says only that they could\./);
  assert.equal(/Database:|Companies:|Deletion:|Migrations:/.test(m.text), false);
  assert.ok(!m.text.includes(CR));
});

test('checkinMail: each attention state turns its own line and the subject; unknown values say unknown', () => {
  const cases = [
    [{ access: 'closed' }, 'Access state: closed'],
    [{ delivery: 'invalid' }, 'Invitation delivery: invalid'],
    [{ sessionKeys: { ok: false, code: 'ETIMEDOUT' } }, 'Session keys: failed (ETIMEDOUT)'],
    [{ sessionKeys: { ok: false, code: 'not a code' } }, 'Session keys: failed (unknown)'],
    [{ access: 'ajar' }, 'Access state: unknown'],
  ];
  for (const [over, line] of cases) {
    const m = checkinMail({ ...CHECKIN, ...over });
    assert.equal(m.subject, 'Phaeacia enterprise check-in 2026-09-22: attention', JSON.stringify(over));
    assert.equal(m.attention, true);
    assert.ok(m.text.split(LF).includes(line), `${line} in:\n${m.text}`);
  }
  assert.ok(checkinMail({ ...CHECKIN, bounceRouting: false }).text.includes('Bounce routing: not configured\n'));
  assert.equal(checkinMail({ ...CHECKIN, bounceRouting: false }).attention, false, 'not configured is not an attention state');
  assert.ok(checkinMail({ ...CHECKIN, deploy: undefined }).text.includes('Deploy: unknown\n'));
  assert.ok(checkinMail({ ...CHECKIN, deploy: { id: 'abc123', context: 'deploy-preview', published: false } }).text.includes('Deploy: abc123 (deploy-preview, published: no)\n'));
  for (const bad of [{ start: '22.09.2026' }, { next: undefined }, { hourUtc: 18 }, { hourUtc: '6' }])
    assert.throws(() => checkinMail({ ...CHECKIN, ...bad }), TypeError, JSON.stringify(bad));
});

test('AC-15 (the check-in, rendering half): hostile values in every slot reach neither subject nor text, and no uuid does', () => {
  const HOSTILE_VALUES = [
    'SYNTHETIC Acme AG',
    'someone@customer.example.invalid',
    'aaaaaaaa-1111-4222-8333-444444444444',
    `x${LF}Bcc: y@example.invalid`,
    `${RLO}GA emcA`,
    'sbp_0123456789abcdef0123456789abcdef01234567',
  ];
  for (const h of HOSTILE_VALUES) {
    const m = checkinMail({
      ...CHECKIN,
      deploy: { id: h, context: h, published: h },
      access: h,
      delivery: h,
      bounceRouting: h,
      sessionKeys: { ok: h, code: h },
    });
    const whole = `${m.subject}${LF}${m.text}`;
    assert.equal(whole.includes(h), false, JSON.stringify(h));
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(whole), false, 'no uuid');
    assert.equal(whole.includes('@'), false, 'no address');
  }
});
