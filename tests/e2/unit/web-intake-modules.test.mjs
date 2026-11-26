/* The E3 intake pages' shared modules (docs/e3/intake-pages-design.md sections 2, 4, 6, 7 and 10), run in Node with an
   injected fetch, location, history and document (the method of web-e4-modules.test.mjs, in a file of its own so its
   globals are not shared).

   The api.mjs half: the five intake calls send the rule 2 request shape; a passport goes as the author's bytes, a string
   or the chosen Blob, never JSON, with content-type text/markdown and the closed set of four headers; a bound write's
   key is made once per attempt and sent again on its retry and on rule 6's one repeat; a content gate refusal's list
   comes back as `problems` holding each problem's code, line and kind and nothing else, and an answer without one gains
   no key. The intake-view half: the size bound is the server's number (a pin to lib/http/request.mjs); a chosen file is
   sent in place of the text box, never copied into it; the submission body the form builds is one the server's own
   shape check accepts; the list keeps the caller's rows only; the four targets are in the fixed navigation set; and the
   passport input's hold. The draft page half (evidence/intake-fixes.md), the page module loaded against scripted
   answers and driven through its own listeners: a press that still reaches Submit now while the form holds unsaved
   changes sends nothing (INTR-F1, the guard a browser cannot reach once the confirmation closes); a submit Retry sends
   the first press's submission under its key and nothing once the form has changed (INTC-F2); a save Retry sends
   nothing once the box has changed (INTR-F2); and a write in flight holds the passport input, Save and Submit for
   review. Round 2 (evidence/intake-fixes-2.md): declarations typed before a save are in the form it draws (INF-N1) and
   held while a submit is in flight (INF-N8); on the upload page, loaded the same way, an upload Retry sends the press
   again only while the text, the file and the name are unchanged, and an upload in flight holds them (INF-N2). The
   capture-once lane (evidence/capture-once.md): one write at a time on the draft page, so a save of unchanged text in
   flight holds Submit for review, closes the confirmation and lets no submit start, and neither write's Retry starts
   inside the other (INTRR-F1). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { MAX_PASSPORT_BYTES as SERVER_MAX } from '../../../lib/http/request.mjs';
import { submissionOf } from '../../../lib/services/candidates.mjs';

class FakeText {
  constructor(data) {
    this.data = String(data);
  }
  get textContent() {
    return this.data;
  }
}
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.listeners = {};
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  append(...nodes) {
    for (const n of nodes) this.childNodes.push(typeof n === 'string' ? new FakeText(n) : n);
  }
  replaceChildren(...nodes) {
    this.childNodes = [];
    this.append(...nodes);
  }
  addEventListener(type, listener) {
    this.listeners[type] = [...(this.listeners[type] ?? []), listener];
  }
  /** Runs the element's listeners of one event type in order, as a person's action would. */
  async fire(type) {
    for (const listener of this.listeners[type] ?? []) await listener({ preventDefault: () => undefined });
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this.childNodes = [new FakeText(value)];
  }
}

const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
/* The page's two roots while a draft page test runs; any other id answers a bare object, as before. */
let roots = {};
define('location', { hash: '', pathname: '/draft/', search: '', assign: () => undefined });
define('history', { replaceState: () => undefined });
define('document', {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => new FakeText(text),
  getElementById: (id) => roots[id] ?? { id },
});
define('addEventListener', () => undefined);

const APP = '../../../web/assets/app';
let serial = 0;
const freshApi = () => import(`${APP}/api.mjs?intake=${++serial}`);
const view = await import(`${APP}/intake-view.mjs`);
const shell = await import(`${APP}/shell.mjs`);

const COMPANY = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const CANDIDATE = '9c0e5b1f-2a3d-4c5e-8f60-7a8b9c0d1e2f';
const AGENT = '5b1f9c0e-3d2a-4e5c-9f60-8a7b0c9d2e1f';
const MEMBER = '1a2b3c4d-5e6f-4a8b-9c0d-e1f2a3b4c5d6';
const OTHER = '6f5e4d3c-2b1a-4b8a-9c0d-e1f2a3b4c5d7';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const json = (status, value) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** routes['METHOD /path']: a list of answers used in order, the last repeating. Every request is logged. */
function service(routes) {
  const log = [];
  const counts = new Map();
  globalThis.fetch = async (path, init) => {
    const key = `${init.method} ${path}`;
    log.push({ key, init });
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    const list = routes[key];
    if (!list) throw new Error(`unscripted ${key}`);
    return list[Math.min(n, list.length - 1)]();
  };
  return log;
}
const thrown = () => () => {
  throw new TypeError('network');
};
const RULE_2 = { credentials: 'same-origin', cache: 'no-store', redirect: 'error' };

/* ---------- api.mjs ---------- */

test('intake api: a new agent is created with the passport text as the body, text/markdown, the key and the name header, and nothing else', async () => {
  const api = await freshApi();
  const log = service({
    [`POST /api/companies/${COMPANY}/candidates`]: [() => json(201, { ok: true, candidateId: CANDIDATE })],
  });
  const text = '---\npassport: 0.1\n---\n# A passport\r\nwith a carriage return kept\n';
  const r = await api.createDraft(COMPANY, { agentName: 'weekly-brief' }, text, 'k-1');
  assert.equal(r.ok, true);
  assert.deepEqual(log[0].init, {
    method: 'POST',
    ...RULE_2,
    headers: {
      accept: 'application/json',
      'idempotency-key': 'k-1',
      'x-agent-name': 'weekly-brief',
      'content-type': 'text/markdown',
    },
    body: text,
  });
  assert.equal(log[0].init.body, text, 'the author’s text is sent as it is: not JSON, not normalized');
});

test('intake api: a new version names the agent by id alone, and a chosen file goes as its Blob, the same object', async () => {
  const api = await freshApi();
  const log = service({
    [`POST /api/companies/${COMPANY}/candidates`]: [() => json(201, { ok: true, candidateId: CANDIDATE })],
  });
  const file = new Blob(['# bytes as saved\r\n'], { type: '' });
  await api.createDraft(COMPANY, { agentId: AGENT }, file, 'k-2');
  assert.deepEqual(log[0].init.headers, {
    accept: 'application/json',
    'idempotency-key': 'k-2',
    'x-agent-id': AGENT,
    'content-type': 'text/markdown',
  });
  assert.equal(log[0].init.body, file, 'the Blob itself, so the browser sends its bytes unchanged');
});

test('intake api: save sends PUT with the version as If-Match; submit sends the JSON body with If-Match; the successor sends {}', async () => {
  const api = await freshApi();
  const log = service({
    [`PUT /api/candidates/${CANDIDATE}`]: [() => json(200, { ok: true })],
    [`POST /api/candidates/${CANDIDATE}/submit`]: [() => json(200, { ok: true })],
    [`POST /api/candidates/${CANDIDATE}/successor`]: [() => json(201, { ok: true })],
  });
  await api.saveDraft(CANDIDATE, 3, 'text', 'k-3');
  assert.deepEqual(log[0].init, {
    method: 'PUT',
    ...RULE_2,
    headers: { accept: 'application/json', 'idempotency-key': 'k-3', 'if-match': '3', 'content-type': 'text/markdown' },
    body: 'text',
  });
  const submission = {
    sourcePlatform: 'Claude Code',
    confidence: 'high',
    permittedData: 'p',
    dependencies: [],
    declaredContributors: [],
  };
  await api.submitDraft(CANDIDATE, 4, submission, 'k-4');
  assert.deepEqual(log[1].init, {
    method: 'POST',
    ...RULE_2,
    headers: {
      accept: 'application/json',
      'idempotency-key': 'k-4',
      'if-match': '4',
      'content-type': 'application/json',
    },
    body: JSON.stringify(submission),
  });
  await api.createSuccessor(CANDIDATE, 'k-5');
  assert.deepEqual(log[2].init, {
    method: 'POST',
    ...RULE_2,
    headers: { accept: 'application/json', 'idempotency-key': 'k-5', 'content-type': 'application/json' },
    body: '{}',
  });
});

test('intake api: the list sends its cursor as its one query value and carries no body', async () => {
  const api = await freshApi();
  const log = service({
    [`GET /api/companies/${COMPANY}/candidates`]: [
      () => json(200, { ok: true, candidates: [], nextCursor: CANDIDATE }),
    ],
    [`GET /api/companies/${COMPANY}/candidates?cursor=${CANDIDATE}`]: [
      () => json(200, { ok: true, candidates: [], nextCursor: null }),
    ],
  });
  await api.candidates(COMPANY);
  await api.candidates(COMPANY, CANDIDATE);
  assert.deepEqual(
    log.map((x) => x.key),
    [`GET /api/companies/${COMPANY}/candidates`, `GET /api/companies/${COMPANY}/candidates?cursor=${CANDIDATE}`],
  );
  assert.deepEqual(log[0].init, { method: 'GET', ...RULE_2, headers: { accept: 'application/json' } });
});

test('intake api: passportInit admits the four headers alone and a string or a Blob alone', async () => {
  const api = await freshApi();
  for (const headers of [
    { authorization: 'x' },
    { 'content-type': 'text/html' },
    { 'X-Agent-Name': 'a' },
    { 'if-match': 3 },
  ])
    assert.throws(() => api.passportInit('PUT', 'text', headers), TypeError, JSON.stringify(headers));
  for (const passport of [{ text: 'x' }, null, undefined, 7, new Uint8Array([1])])
    assert.throws(() => api.passportInit('PUT', passport, {}), TypeError, String(passport));
  assert.equal(api.passportInit('PUT', '', {}).headers['content-type'], 'text/markdown');
});

test('intake api: a lost upload answer is retried with the same key, and the stored answer comes back as success', async () => {
  const api = await freshApi();
  const log = service({
    [`POST /api/companies/${COMPANY}/candidates`]: [
      thrown(),
      () => json(201, { ok: true, candidateId: CANDIDATE, idempotentReplay: true }),
    ],
  });
  const run = api.writeAttempt((key) => api.createDraft(COMPANY, { agentName: 'weekly-brief' }, 'text', key));
  const lost = await run();
  assert.equal(lost.network, true);
  assert.equal(lost.action, 'retry');
  const replay = await run();
  assert.equal(replay.ok, true);
  assert.equal(replay.data.idempotentReplay, true);
  assert.match(log[0].init.headers['idempotency-key'], UUID_V4);
  assert.equal(log[1].init.headers['idempotency-key'], log[0].init.headers['idempotency-key']);
  assert.equal(log[1].init.body, 'text');
});

test("intake api: rule 6's one repeat after a refresh resends the same passport, headers and key", async () => {
  const api = await freshApi();
  const log = service({
    [`PUT /api/candidates/${CANDIDATE}`]: [
      () => json(401, { ok: false, code: 'E_UNAUTHENTICATED', message: 'x' }),
      () => json(200, { ok: true }),
    ],
    'POST /api/auth/refresh': [() => new Response(null, { status: 204 })],
  });
  const r = await api.saveDraft(CANDIDATE, 2, 'the text', 'k-6');
  assert.equal(r.ok, true);
  assert.deepEqual(
    log.map((x) => x.key),
    [`PUT /api/candidates/${CANDIDATE}`, 'POST /api/auth/refresh', `PUT /api/candidates/${CANDIDATE}`],
  );
  assert.deepEqual(log[2].init, log[0].init);
});

test('intake api: a gate refusal carries its problems as code, line and kind only; any other answer gains no problems key', async () => {
  const api = await freshApi();
  service({
    [`POST /api/companies/${COMPANY}/candidates`]: [
      () =>
        json(422, {
          ok: false,
          code: 'E_SECRET_FOUND',
          message: 'm',
          problems: [
            { code: 'E_SECRET_FOUND', line: 12, kind: 'api_key', text: 'sk-never-shown' },
            { code: 'E_CANONICAL', line: '4' },
            { line: 9 },
            'E_HTML',
          ],
        }),
      () => json(409, { ok: false, code: 'E_AGENT_NAME_TAKEN', message: 'm' }),
    ],
  });
  const refused = await api.createDraft(COMPANY, { agentName: 'a' }, 'x', 'k');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'E_SECRET_FOUND');
  assert.deepEqual(refused.problems, [
    { code: 'E_SECRET_FOUND', line: 12, kind: 'api_key' },
    { code: 'E_CANONICAL', line: null },
  ]);
  const other = await api.createDraft(COMPANY, { agentName: 'a' }, 'x', 'k');
  assert.equal(Object.hasOwn(other, 'problems'), false);
  assert.equal(other.action, 'message');
});

/* ---------- intake-view.mjs ---------- */

test('intake view: the size bound is the server’s, and it is counted in UTF-8 bytes', () => {
  assert.equal(view.MAX_PASSPORT_BYTES, SERVER_MAX);
  assert.equal(view.byteLength('é'), 2);
  const exact = 'a'.repeat(SERVER_MAX);
  assert.deepEqual(view.choosePassport({ text: exact }), {
    ok: true,
    passport: exact,
    bytes: SERVER_MAX,
    from: 'text',
  });
  const over = `${'a'.repeat(SERVER_MAX - 1)}é`;
  assert.deepEqual(view.choosePassport({ text: over }), { ok: false, reason: 'too-large', bytes: SERVER_MAX + 1 });
  assert.deepEqual(view.choosePassport({ text: '' }), { ok: false, reason: 'empty', bytes: 0 });
  assert.equal(view.choosePassport({ text: '   ' }).ok, true, 'whitespace goes to the server, which decides');
});

test('intake view: a chosen file is sent in place of the text box, as its own object, and is bounded by its size', () => {
  const file = { name: 'passport.md', size: 120 };
  const choice = view.choosePassport({ text: 'the text box', file });
  assert.equal(choice.passport, file, 'the file itself, never its text copied through the text box');
  assert.equal(choice.from, 'file');
  assert.deepEqual(view.choosePassport({ text: 'the text box', file: { name: 'big.md', size: SERVER_MAX + 1 } }), {
    ok: false,
    reason: 'too-large',
    bytes: SERVER_MAX + 1,
  });
  assert.equal(view.choosePassport({ text: 'the text box', file: { name: 'empty.md', size: 0 } }).reason, 'empty');
  assert.match(
    view.refusedBeforeSending({ reason: 'too-large', bytes: SERVER_MAX + 1 }),
    /262,145 bytes.*262,144 bytes.*Nothing was sent/,
  );
});

test('intake view: the submission body the form builds is one the server’s shape check accepts, names trimmed and blank lines dropped', () => {
  const body = view.submissionFromForm({
    sourcePlatform: 'Claude Code',
    confidence: 'medium',
    permittedData: 'Internal weekly reports, no client names',
    dependencies: 'files.read\n\n  a shared folder  \n',
    colleagues: [MEMBER],
    names: '  Jane Doe (former intern)\n\n',
  });
  assert.deepEqual(body, {
    sourcePlatform: 'Claude Code',
    confidence: 'medium',
    permittedData: 'Internal weekly reports, no client names',
    dependencies: ['files.read', 'a shared folder'],
    declaredContributors: [{ membershipId: MEMBER }, { displayName: 'Jane Doe (former intern)' }],
  });
  assert.doesNotThrow(() => submissionOf(body));
  for (const level of view.CONFIDENCE_LEVELS)
    assert.doesNotThrow(() => submissionOf({ ...body, confidence: level }), level);
  const unchosen = view.submissionFromForm({ sourcePlatform: 'x', permittedData: 'y' });
  assert.equal(Object.hasOwn(unchosen, 'confidence'), false, 'an unchosen confidence is left for the server to refuse');
  assert.throws(() => submissionOf(unchosen), /E_BODY_INVALID/);
});

test('intake view: the list keeps the caller’s own rows, grouped by agent, versions newest first, agents by newest activity', () => {
  const A2 = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
  const rows = [
    {
      candidateId: 'c1',
      agentId: AGENT,
      sequence: 1,
      state: 'changes_requested',
      authorMembershipId: MEMBER,
      validatedAt: '2026-09-01T00:00:00Z',
      submittedAt: '2026-09-02T00:00:00Z',
    },
    {
      candidateId: 'c2',
      agentId: AGENT,
      sequence: 2,
      state: 'draft',
      authorMembershipId: MEMBER,
      validatedAt: '2026-09-03T00:00:00Z',
      submittedAt: null,
    },
    {
      candidateId: 'c3',
      agentId: A2,
      sequence: 1,
      state: 'submitted',
      authorMembershipId: MEMBER,
      validatedAt: '2026-09-04T00:00:00Z',
      submittedAt: '2026-09-05T00:00:00Z',
    },
    {
      candidateId: 'c4',
      agentId: A2,
      sequence: 2,
      state: 'submitted',
      authorMembershipId: OTHER,
      validatedAt: '2026-09-06T00:00:00Z',
      submittedAt: '2026-09-07T00:00:00Z',
    },
  ];
  const groups = view.groupByAgent(rows, MEMBER);
  assert.deepEqual(
    groups.map((g) => [g.agentId, g.versions.map((v) => v.candidateId)]),
    [
      [A2, ['c3']],
      [AGENT, ['c2', 'c1']],
    ],
  );
  assert.deepEqual(view.groupByAgent(rows, null), [], 'no membership, no rows claimed as own');
});

test('intake view: a problem shows its line, code and kind and nothing else the answer might carry', () => {
  assert.deepEqual(
    view.problemsOf({
      problems: [
        { code: 'E_HTML', line: 3, text: 'never' },
        { code: 'E_SECRET_FOUND', line: 9, kind: 'password' },
      ],
    }),
    [
      { code: 'E_HTML', line: 3, kind: null },
      { code: 'E_SECRET_FOUND', line: 9, kind: 'password' },
    ],
  );
  const node = view.problemsView({
    code: 'E_HTML',
    message: 'The server sentence.',
    problems: [{ code: 'E_HTML', line: 3, text: 'never shown' }],
  });
  const text = node.textContent;
  assert.match(text, /The server sentence\./);
  assert.match(text, /line 3/);
  assert.match(text, /E_HTML/);
  assert.doesNotMatch(text, /never shown/);
});

test('intake view: the four targets are in the fixed navigation set with their one query form, and a draft opens on the draft page', () => {
  for (const target of [
    view.draftsTarget(COMPANY),
    view.newAgentTarget(COMPANY),
    view.newVersionTarget(CANDIDATE),
    view.draftTarget(CANDIDATE),
    view.submittedTarget(CANDIDATE),
  ])
    assert.equal(shell.isAllowedTarget(target), true, target);
  for (const target of [
    `/draft/?candidate=${CANDIDATE}&company=${COMPANY}`,
    '/draft/?candidate=not-a-uuid',
    '/drafts/new',
    '/submitted',
  ])
    assert.equal(shell.isAllowedTarget(target), false, target);
  assert.equal(view.pageFor({ candidateId: CANDIDATE, state: 'draft' }), `/draft/?candidate=${CANDIDATE}`);
  for (const state of ['submitted', 'changes_requested', 'approved', 'superseded'])
    assert.equal(view.pageFor({ candidateId: CANDIDATE, state }), `/submitted/?candidate=${CANDIDATE}`, state);
});

test('intake view: every company page reaches Your agents through the company links, first', () => {
  const nav = shell.companyLinks(COMPANY, null);
  const first = nav.childNodes[0];
  assert.equal(first.getAttribute('data-role'), 'link-drafts');
  assert.equal(first.href, `/drafts/?company=${COMPANY}`);
  const current = shell.companyLinks(COMPANY, '/drafts/').childNodes[0];
  assert.equal(current.tagName, 'SPAN', 'the current page is shown, not linked');
});

test('intake view: hold makes the text box read-only and the file input and its clear control unusable, and gives them back', async () => {
  const input = view.passportInput({ id: 'held', text: 'the stored draft' });
  const clearControl = () =>
    input.node.childNodes.find((n) => n.getAttribute?.('data-role') === 'chosen-file').childNodes[1] ?? null;
  input.file.files = [{ name: 'passport.md', size: 20 }];
  await input.file.fire('change');
  assert.equal(clearControl().getAttribute('data-role'), 'clear-file');
  input.hold(true);
  assert.deepEqual([input.area.readOnly, input.file.disabled, clearControl().disabled], [true, true, true]);
  input.hold(false);
  assert.deepEqual([input.area.readOnly, input.file.disabled, clearControl().disabled], [false, false, false]);
  input.hold(true);
  await input.file.fire('change');
  assert.equal(clearControl().disabled, true, 'a clear control drawn while held is drawn held');
});

/* ---------- the draft page ---------- */

const DRAFT = Object.freeze({
  candidateId: CANDIDATE,
  companyId: COMPANY,
  agentId: AGENT,
  sequence: 1,
  state: 'draft',
  version: 3,
  authorMembershipId: MEMBER,
  supersedesCandidateId: null,
  content: 'the stored draft',
  derived: { title: 'Title', summary: 'Summary', needs: [] },
  attestation: {},
  gateStatus: 'current',
});
const READ = {
  ok: true,
  candidate: DRAFT,
  contributors: [],
  losses: { state: 'pending', rows: [] },
  agentHistory: { agentName: 'weekly-brief', candidates: [] },
  envelopes: [],
  reviews: [],
  releases: [],
  options: {},
};
const ME = {
  ok: true,
  user: { email: 'author@example.invalid' },
  memberships: [{ companyId: COMPANY, membershipId: MEMBER, companyName: 'Company', roles: ['member'] }],
};
const MEMBERS = {
  ok: true,
  viewer: { membershipId: MEMBER },
  members: [{ membershipId: MEMBER, status: 'active', label: { kind: 'self', value: 'Me' }, roles: ['member'] }],
};
const SUBMIT = `POST /api/candidates/${CANDIDATE}/submit`;
const SAVE = `PUT /api/candidates/${CANDIDATE}`;
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise(setImmediate);
};
/** A promise the test settles, for a write held in flight. */
function gate() {
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  return { answer: () => opened, open };
}

/** A page module run against scripted answers: lookups by data-role, id or data-state, and the request log. */
async function pageModule(module, search, answers) {
  roots = { main: new FakeElement('main'), 'site-header': new FakeElement('header') };
  globalThis.location.search = search;
  const log = service(answers);
  await import(`${APP}/pages/${module}?intake=${++serial}`);
  await settle();
  const all = (node) => [node, ...(node.childNodes ?? []).flatMap(all)];
  const first = (name, value) => all(roots.main).find((n) => n.getAttribute?.(name) === value) ?? null;
  return {
    role: (value) => first('data-role', value),
    id: (value) => first('id', value),
    state: (value) => first('data-state', value),
    main: roots.main,
    keys: () => log.map((x) => x.key),
    sent: (key) =>
      log
        .filter((x) => x.key === key)
        .map((x) => ({
          key: x.init.headers['idempotency-key'],
          name: x.init.headers['x-agent-name'],
          body: x.init.body,
        })),
  };
}
const draftPage = (writes, { members = MEMBERS } = {}) =>
  pageModule('draft.mjs', `?candidate=${CANDIDATE}`, {
    'GET /api/me': [() => json(200, ME)],
    [`GET /api/candidates/${CANDIDATE}/review`]: [() => json(200, READ)],
    [`GET /api/companies/${COMPANY}/members`]: [() => json(200, members)],
    ...writes,
  });
const typeInto = async (node, value) => {
  node.value = value;
  await node.fire('input');
};
function declare(page, permittedData = 'Synthetic data only') {
  page.id('source-platform').value = 'Claude Code';
  page.id('permitted-data').value = permittedData;
  page.id('dependencies').value = '';
  page.id('outside-names').value = '';
}

test('draft page: an edit or a chosen file with the confirmation open closes it and says why, and a press that still reaches Submit now sends nothing (INTR-F1)', async () => {
  const page = await draftPage({ [SUBMIT]: [() => json(200, { ok: true })] });
  declare(page);
  await page.role('submit-form').fire('submit');
  const submitNow = page.role('confirm-submit-now');
  assert.ok(submitNow, 'the confirmation opened');
  await typeInto(page.role('passport-text'), 'an edit not yet saved');
  assert.equal(page.role('confirm-submit-now'), null, 'the edit closed the confirmation');
  assert.ok(page.state('confirm-closed'), 'and the page says why');
  assert.equal(page.role('submit').disabled, true, 'Submit for review is held');
  await submitNow.fire('click');
  assert.deepEqual(page.sent(SUBMIT), [], 'a press that still reaches Submit now submits nothing');
  assert.ok(page.state('not-submitted'), 'and says so');

  await typeInto(page.role('passport-text'), DRAFT.content);
  assert.equal(page.role('submit').disabled, false, 'the box back to the stored text releases Submit for review');
  await page.role('submit-form').fire('submit');
  const again = page.role('confirm-submit-now');
  const file = page.role('passport-file');
  file.files = [{ name: 'passport.md', size: 20 }];
  await file.fire('change');
  assert.deepEqual(
    [page.role('confirm-submit-now'), Boolean(page.state('confirm-closed')), page.role('submit').disabled],
    [null, true, true],
    'a chosen file does the same',
  );
  await again.fire('click');
  assert.deepEqual(page.sent(SUBMIT), [], 'nothing was submitted');
});

test('draft page: a submit Retry sends the first press’s submission under its key, nothing once the form has changed, and a new confirmed press makes a new key (INTC-F2)', async () => {
  const page = await draftPage({ [SUBMIT]: [thrown(), thrown(), () => json(200, { ok: true, state: 'submitted' })] });
  declare(page, 'first');
  await page.role('submit-form').fire('submit');
  await page.role('confirm-submit-now').fire('click');
  assert.ok(page.role('retry'), 'the lost answer offers Retry');
  page.id('permitted-data').value = 'second';
  await page.role('retry').fire('click');
  assert.equal(page.sent(SUBMIT).length, 1, 'Retry after a change sends nothing');
  assert.ok(page.state('submit-changed'), 'and says why');

  page.id('permitted-data').value = 'first';
  await page.role('submit-form').fire('submit');
  await page.role('confirm-submit-now').fire('click');
  const [one, two] = page.sent(SUBMIT);
  assert.notEqual(two.key, one.key, 'a new confirmed press is a new attempt with a new key');
  await page.role('retry').fire('click');
  const three = page.sent(SUBMIT)[2];
  assert.deepEqual(
    [three.key, three.body],
    [two.key, two.body],
    'an unchanged Retry sends the same key and the same submission',
  );
  assert.equal(JSON.parse(three.body).permittedData, 'first');
});

test('draft page: a save Retry sends the first press’s text only while the box is unchanged; after an edit it sends nothing and the box keeps the edit (INTR-F2)', async () => {
  const page = await draftPage({ [SAVE]: [thrown(), thrown()] });
  const area = page.role('passport-text');
  await typeInto(area, 'first');
  await page.role('edit-form').fire('submit');
  assert.ok(page.role('retry'), 'the lost answer offers Retry');
  await typeInto(area, 'later');
  await page.role('retry').fire('click');
  assert.equal(page.sent(SAVE).length, 1, 'Retry after an edit sends nothing');
  assert.ok(page.state('save-changed'), 'and says why');
  assert.equal(page.role('passport-text').value, 'later', 'the box keeps the edit');

  await typeInto(page.role('passport-text'), 'first');
  await page.role('edit-form').fire('submit');
  const [one, two] = page.sent(SAVE);
  assert.notEqual(two.key, one.key, 'Save composes a new attempt');
  await page.role('retry').fire('click');
  const three = page.sent(SAVE)[2];
  assert.deepEqual(
    [three.key, three.body],
    [two.key, 'first'],
    'an unchanged Retry sends the same key and the same text',
  );
});

test('draft page: a write in flight holds the text box, the file input, Save and Submit for review, and the answer gives them back', async () => {
  const saving = gate();
  const submitting = gate();
  const refused = () => json(422, { ok: false, code: 'E_BODY_INVALID', message: 'The request is not valid.' });
  const page = await draftPage({
    [SAVE]: [() => saving.answer().then(refused)],
    [SUBMIT]: [() => submitting.answer().then(refused)],
  });
  const held = () => [
    page.role('passport-text').readOnly,
    page.role('passport-file').disabled,
    page.role('save').disabled,
    page.role('submit').disabled,
  ];
  await typeInto(page.role('passport-text'), 'an edit');
  const save = page.role('edit-form').fire('submit');
  await settle();
  assert.deepEqual(held(), [true, true, true, true], 'while the save is in flight');
  saving.open();
  await save;
  assert.deepEqual(
    held(),
    [false, false, false, true],
    'after its answer; Submit for review stays held for the unsaved edit',
  );
  assert.equal(page.role('passport-text').value, 'an edit');

  await typeInto(page.role('passport-text'), DRAFT.content);
  declare(page);
  await page.role('submit-form').fire('submit');
  const submit = page.role('confirm-submit-now').fire('click');
  await settle();
  assert.deepEqual(held(), [true, true, true, true], 'while the submit is in flight');
  assert.ok(page.state('submitting'), 'the page says a submit is in flight');
  await page.role('submit-form').fire('submit');
  assert.equal(page.role('confirm-submit'), null, 'no second confirmation opens while it is in flight');
  submitting.open();
  await submit;
  assert.deepEqual(held(), [false, false, false, false], 'after its answer');
  globalThis.location.search = '';
});

test('draft page: declarations typed before a successful save survive its redraw, a colleague still offered keeping the tick (INF-N1)', async () => {
  const withColleague = {
    ...MEMBERS,
    members: [
      ...MEMBERS.members,
      { membershipId: OTHER, status: 'active', label: { kind: 'display_name', value: 'Colleague' }, roles: ['member'] },
    ],
  };
  const page = await draftPage({ [SAVE]: [() => json(200, { ok: true, version: 4 })] }, { members: withColleague });
  const before = page.id('source-platform');
  declare(page, 'Internal weekly reports only');
  page.id('dependencies').value = 'files.read';
  page.id('outside-names').value = 'Jane Doe';
  page.id('confidence-medium').checked = true;
  page.id(`colleague-${OTHER}`).checked = true;
  await typeInto(page.role('passport-text'), 'an edit');
  await page.role('edit-form').fire('submit');
  await settle();
  assert.ok(page.state('saved'), 'the save succeeded and the page was drawn again');
  assert.notEqual(page.id('source-platform'), before, 'the submit form is a new one');
  assert.deepEqual(
    {
      source: page.id('source-platform').value,
      confidence: ['high', 'medium', 'low'].filter((level) => page.id(`confidence-${level}`).checked),
      permitted: page.id('permitted-data').value,
      dependencies: page.id('dependencies').value,
      names: page.id('outside-names').value,
      colleague: page.id(`colleague-${OTHER}`).checked,
    },
    {
      source: 'Claude Code',
      confidence: ['medium'],
      permitted: 'Internal weekly reports only',
      dependencies: 'files.read',
      names: 'Jane Doe',
      colleague: true,
    },
    'the declarations typed before the save are in the new form',
  );
  globalThis.location.search = '';
});

test('draft page: while a submit is in flight the declarations are held, and its answer gives them back (INF-N8)', async () => {
  const submitting = gate();
  const withColleague = {
    ...MEMBERS,
    members: [
      ...MEMBERS.members,
      { membershipId: OTHER, status: 'active', label: { kind: 'display_name', value: 'Colleague' }, roles: ['member'] },
    ],
  };
  const page = await draftPage(
    {
      [SUBMIT]: [
        () =>
          submitting
            .answer()
            .then(() => json(422, { ok: false, code: 'E_BODY_INVALID', message: 'The request is not valid.' })),
      ],
    },
    { members: withColleague },
  );
  /* A property the page never set reads undefined in this fake, so each is compared with true. */
  const held = () =>
    [
      page.id('source-platform').readOnly,
      page.id('permitted-data').readOnly,
      page.id('dependencies').readOnly,
      page.id('outside-names').readOnly,
      page.id('confidence-high').disabled,
      page.id(`colleague-${OTHER}`).disabled,
    ].map((x) => x === true);
  declare(page);
  assert.deepEqual(held(), [false, false, false, false, false, false], 'before the press');
  await page.role('submit-form').fire('submit');
  const submit = page.role('confirm-submit-now').fire('click');
  await settle();
  assert.ok(page.state('submitting'), 'the submit is in flight');
  assert.deepEqual(held(), [true, true, true, true, true, true], 'while the submit is in flight');
  submitting.open();
  await submit;
  assert.deepEqual(held(), [false, false, false, false, false, false], 'after its answer');
  globalThis.location.search = '';
});

test('draft page: a save of the unchanged text in flight closes the confirmation, holds Submit for review and lets no submit start, so the box stays held until the save answers (INTRR-F1, RR-8)', async () => {
  const saving = gate();
  const page = await draftPage({
    [SAVE]: [() => saving.answer().then(() => json(200, { ok: true, version: 4 }))],
    [SUBMIT]: [() => json(422, { ok: false, code: 'E_BODY_INVALID', message: 'The request is not valid.' })],
  });
  await page.role('submit-form').fire('submit');
  const submitNow = page.role('confirm-submit-now');
  assert.ok(submitNow, 'the confirmation opened on the unchanged draft');
  const save = page.role('edit-form').fire('submit');
  await settle();
  assert.deepEqual(
    [page.role('confirm-submit-now'), page.role('submit').disabled, page.role('passport-text').readOnly],
    [null, true, true],
    'while the save is in flight the confirmation is closed, Submit for review held and the text box read-only',
  );
  await page.role('submit-form').fire('submit');
  assert.equal(page.role('confirm-submit'), null, 'no confirmation opens while the save is in flight');
  await submitNow.fire('click');
  assert.deepEqual(page.sent(SUBMIT), [], 'a press that still reaches Submit now submits nothing');
  assert.equal(page.role('passport-text').readOnly, true, 'and the text box stays held for the save');
  saving.open();
  await save;
  assert.ok(page.state('saved'), 'the save answers and the page is drawn again');
  /* The redrawn box is a new element whose readOnly the page never set, which this fake reads as undefined. */
  assert.deepEqual(
    [page.role('submit').disabled, page.role('passport-text').readOnly].map((x) => x === true),
    [false, false],
    'Submit for review and the box are given back',
  );
  globalThis.location.search = '';
});

test('draft page: a save Retry does nothing while a submit is in flight, and a submit Retry nothing while a save is (INTRR-F1)', async () => {
  const saving = gate();
  const submitting = gate();
  const page = await draftPage({
    [SAVE]: [thrown(), () => saving.answer().then(() => json(200, { ok: true, version: 4 }))],
    [SUBMIT]: [() => submitting.answer().then(thrown())],
  });
  await page.role('edit-form').fire('submit');
  const saveRetry = page.role('retry');
  assert.ok(saveRetry, 'the lost save offers Retry');
  declare(page);
  await page.role('submit-form').fire('submit');
  const submit = page.role('confirm-submit-now').fire('click');
  await settle();
  saveRetry.fire('click');
  await settle();
  assert.equal(page.sent(SAVE).length, 1, 'the save Retry sends nothing while the submit is in flight');
  assert.equal(page.role('passport-text').readOnly, true, 'and the text box stays held for the submit');
  submitting.open();
  await submit;
  assert.equal(page.role('passport-text').readOnly, false, "the submit's answer gives it back");

  const save = page.role('edit-form').fire('submit');
  await settle();
  const submitRetry = page.role('retry');
  assert.ok(submitRetry, "the lost submit's Retry is still offered");
  submitRetry.fire('click');
  await settle();
  assert.equal(page.sent(SUBMIT).length, 1, 'the submit Retry sends nothing while the save is in flight');
  assert.equal(page.role('passport-text').readOnly, true, 'and the text box stays held for the save');
  saving.open();
  await save;
  assert.ok(page.state('saved'), 'the save answers and the page is drawn again');
  globalThis.location.search = '';
});

/* ---------- the upload page ---------- */

const UPLOAD_ME = { ...ME, memberships: [{ ...ME.memberships[0], companyStatus: 'active' }] };
const CREATE = `POST /api/companies/${COMPANY}/candidates`;
const uploadPage = (module, writes) =>
  pageModule(module, `?company=${COMPANY}`, { 'GET /api/me': [() => json(200, UPLOAD_ME)], ...writes });
/* api.mjs stops its queue once a page moves (its leaving flag), and the unit harness shares api.mjs between the page
   modules it loads, so after one page moves to its draft every request of the next page would answer navigating.
   startPage's restore listener is the pages' own way to start the queue again (a page restored from the back-forward
   cache); it is taken here once, and run after a case that moves. */
let restoreListener = null;
define('addEventListener', (type, listener) => {
  if (type === 'pageshow') restoreListener = listener;
});
shell.startPage();
define('addEventListener', () => undefined);
const restartQueue = () => restoreListener({ persisted: true });
async function press(page, name, text) {
  page.id('agent-name').value = name;
  await typeInto(page.role('passport-text'), text);
  await page.role('upload-form').fire('submit');
}

/* evidence/add-agent.md: the upload form is upload-form.mjs, one implementation for every page that uploads a new
   agent, so a fix to it reaches them all and the cases below hold for each. A page that composed an upload of its own
   would escape them. */
const UPLOAD_PAGES = ['drafts-new.mjs', 'capture.mjs'];
test('upload form: every page that uploads draws upload-form.mjs and composes no upload of its own', () => {
  for (const module of UPLOAD_PAGES) {
    const source = readFileSync(new URL(`${APP}/pages/${module}`, import.meta.url), 'utf8');
    assert.match(
      source,
      /^import \{ uploadForm \} from '\.\.\/upload-form\.mjs';$/m,
      `${module} imports the shared form`,
    );
    assert.match(source, /\buploadForm\(/, `${module} draws it`);
    assert.doesNotMatch(
      source,
      /\b(?:createDraft|writeAttempt|passportInput|choosePassport)\b/,
      `${module} composes no upload of its own`,
    );
  }
});

for (const module of UPLOAD_PAGES)
  test(`${module}: a Retry resends the press under its key only while the text, the file and the name are unchanged; after any change it sends nothing and says so, and Upload composes a new attempt (INF-N2)`, async () => {
    const page = await uploadPage(module, { [CREATE]: [thrown()] });
    await press(page, 'first-name', 'the first text');
    assert.ok(page.role('retry'), 'the lost answer offers Retry');
    await typeInto(page.role('passport-text'), 'a later text');
    await page.role('retry').fire('click');
    assert.equal(page.sent(CREATE).length, 1, 'Retry after the text changed sends nothing');
    assert.ok(page.state('upload-changed'), 'and says why');
    assert.equal(page.role('passport-text').value, 'a later text', 'the box keeps the edit');

    await press(page, 'first-name', 'the first text');
    page.id('agent-name').value = 'later-name';
    await page.role('retry').fire('click');
    assert.equal(page.sent(CREATE).length, 2, 'Retry after the name changed sends nothing');
    assert.ok(page.state('upload-changed'), 'and says why');

    await press(page, 'first-name', 'the first text');
    const file = page.role('passport-file');
    file.files = [{ name: 'passport.md', size: 20 }];
    await file.fire('change');
    await page.role('retry').fire('click');
    assert.equal(page.sent(CREATE).length, 3, 'Retry after a file was chosen sends nothing');
    assert.ok(page.state('upload-changed'), 'and says why');
    file.files = [];
    await file.fire('change');

    await press(page, 'first-name', 'the first text');
    await page.role('retry').fire('click');
    const sent = page.sent(CREATE);
    assert.equal(
      new Set(sent.slice(0, 4).map((s) => s.key)).size,
      4,
      'each press composes a new attempt with its own key',
    );
    assert.deepEqual(
      [sent[4].key, sent[4].name, sent[4].body],
      [sent[3].key, 'first-name', 'the first text'],
      'an unchanged Retry sends the same key, name and text',
    );
    globalThis.location.search = '';
  });

for (const module of UPLOAD_PAGES)
  test(`${module}: an upload in flight holds the text box, the file input, the name and the button; a refusal gives them back, a success keeps them held while the page moves`, async () => {
    const refusing = gate();
    const storing = gate();
    const page = await uploadPage(module, {
      [CREATE]: [
        () =>
          refusing
            .answer()
            .then(() => json(409, { ok: false, code: 'E_AGENT_NAME_TAKEN', message: 'That name is taken.' })),
        () => storing.answer().then(() => json(201, { ok: true, candidateId: CANDIDATE })),
      ],
    });
    const held = () =>
      [
        page.role('passport-text').readOnly,
        page.role('passport-file').disabled,
        page.id('agent-name').readOnly,
        page.role('upload').disabled,
      ].map((x) => x === true);
    const refused = press(page, 'taken-name', 'a text');
    await settle();
    assert.deepEqual(held(), [true, true, true, true], 'while the upload is in flight');
    refusing.open();
    await refused;
    assert.deepEqual(held(), [false, false, false, false], 'after a refusal');

    const moves = [];
    const assign = globalThis.location.assign;
    globalThis.location.assign = (target) => moves.push(target);
    try {
      const stored = press(page, 'free-name', 'a text');
      await settle();
      storing.open();
      await stored;
    } finally {
      globalThis.location.assign = assign;
      restartQueue();
    }
    assert.deepEqual(moves, [`/draft/?candidate=${CANDIDATE}`], 'the page moves to the new draft');
    assert.deepEqual(held(), [true, true, true, true], 'and the form stays held while it goes');
    globalThis.location.search = '';
  });

/* ---------- Capture an agent, /capture/ (evidence/add-agent.md) ---------- */

const membershipAs = (fields) => ({ ...ME, memberships: [{ ...ME.memberships[0], ...fields }] });
const everyNode = (node) => [node, ...(node.childNodes ?? []).flatMap(everyNode)];
const CAPTURE_PAGE_CASES = [
  ['an active membership', `?company=${COMPANY}`, UPLOAD_ME, 'form'],
  ['a suspended company', `?company=${COMPANY}`, membershipAs({ companyStatus: 'suspended' }), 'inactive'],
  [
    'a company in its reading window',
    `?company=${COMPANY}`,
    membershipAs({ companyStatus: 'active', accessState: 'export_window' }),
    'inactive',
  ],
  ['a closed company', `?company=${COMPANY}`, membershipAs({ companyStatus: 'closed' }), 'inactive'],
  ['a held company', `?company=${COMPANY}`, membershipAs({ companyStatus: 'held' }), 'inactive'],
  [
    'a company whose access has ended',
    `?company=${COMPANY}`,
    membershipAs({ companyStatus: 'active', accessState: 'expired' }),
    'inactive',
  ],
  ['no company query', '', UPLOAD_ME, 'no-company'],
  ['a company the caller is no member of', `?company=${OTHER}`, UPLOAD_ME, 'no-company'],
];

/* The peer check's PC-1 and PC-2 (evidence/add-agent.md): the answers the upload form hands on, a content gate refusal
   to the form's own status and not found or maintenance to the page that drew it, asserted on every uploading page. */
for (const module of UPLOAD_PAGES)
  test(`${module}: a content gate refusal lists each problem beside the form and gives it back; not found and maintenance replace the page`, async () => {
    const refused = await uploadPage(module, {
      [CREATE]: [
        () =>
          json(422, {
            ok: false,
            code: 'E_HTML',
            message: 'The server sentence.',
            problems: [{ code: 'E_HTML', line: 3 }],
          }),
      ],
    });
    await press(refused, 'refused-name', 'a text');
    assert.equal(refused.state('refused')?.getAttribute('data-code'), 'E_HTML', 'the refusal is drawn');
    assert.ok(
      everyNode(refused.role('upload-status')).some((n) => n.getAttribute?.('data-problem') === 'E_HTML'),
      'its problem listed in the form status',
    );
    assert.deepEqual(
      [Boolean(refused.role('upload-form')), refused.role('upload').disabled],
      [true, false],
      'and the form is given back',
    );

    const gone = await uploadPage(module, {
      [CREATE]: [() => json(404, { ok: false, code: 'E_NOT_FOUND', message: 'Not found.' })],
    });
    await press(gone, 'gone-name', 'a text');
    assert.deepEqual(
      [Boolean(gone.state('not-found')), Boolean(gone.role('upload-form'))],
      [true, false],
      'not found replaces the page',
    );

    const paused = await uploadPage(module, {
      [CREATE]: [() => json(503, { ok: false, code: 'E_MAINTENANCE', message: 'Maintenance.' })],
    });
    await press(paused, 'paused-name', 'a text');
    assert.deepEqual(
      [Boolean(paused.state('maintenance')), Boolean(paused.role('upload-form'))],
      [true, false],
      'maintenance replaces the page',
    );
    globalThis.location.search = '';
  });

test('Capture an agent: a heading and three steps in order; step 2 holds the form for an active membership only, the home page sentence for one that is not active, and a sentence with the link home without one; its one request is the identity read', async () => {
  for (const [label, search, identity, expected] of CAPTURE_PAGE_CASES) {
    const page = await pageModule('capture.mjs', search, { 'GET /api/me': [() => json(200, identity)] });
    const h1 = everyNode(page.main).find((n) => n.tagName === 'H1');
    assert.equal(h1?.textContent, 'Capture an agent', label);
    assert.deepEqual(
      page.role('add-steps').childNodes.map((n) => n.getAttribute('data-role')),
      ['step-prompt', 'step-upload', 'step-next'],
      label,
    );
    const step2 = page.role('step-upload');
    const inStep2 = (name, value) => everyNode(step2).some((n) => n.getAttribute?.(name) === value);
    assert.deepEqual(
      {
        form: inStep2('data-role', 'upload-form'),
        inactive: inStep2('data-state', 'inactive'),
        noCompany: inStep2('data-state', 'no-company'),
        home: inStep2('data-role', 'home-link'),
        companyLinks: Boolean(page.role('company-links')),
      },
      {
        form: expected === 'form',
        inactive: expected === 'inactive',
        noCompany: expected === 'no-company',
        home: expected !== 'form',
        companyLinks: expected === 'form',
      },
      label,
    );
    assert.deepEqual(page.keys(), ['GET /api/me'], `${label}: the identity read is the one request`);
  }
  globalThis.location.search = '';
});

test('Capture an agent: nothing of the public page’s publishing path is on it, in its text or its links, and every link is one of the fixed set', async () => {
  for (const [label, search, identity] of CAPTURE_PAGE_CASES) {
    const page = await pageModule('capture.mjs', search, { 'GET /api/me': [() => json(200, identity)] });
    assert.doesNotMatch(
      page.main.textContent,
      /publish|public|gallery|skill|repositor|github|phaeacia\.ai|copied|counter|link exists|installer/i,
      label,
    );
    const links = everyNode(page.main).filter((n) => typeof n.href === 'string');
    assert.ok(links.length > 0, `${label}: the page has links to check`);
    for (const node of links) assert.equal(shell.isAllowedTarget(node.href), true, `${label}: ${node.href}`);
  }
  globalThis.location.search = '';
});

test('Your agents: one primary control, Capture an agent, opens /capture/ for this company beside Reload, and the empty list names it; no upload or capture prompt control of its own', async () => {
  const page = await pageModule('drafts.mjs', `?company=${COMPANY}`, {
    'GET /api/me': [() => json(200, ME)],
    [`GET /api/companies/${COMPANY}/candidates`]: [() => json(200, { ok: true, candidates: [], nextCursor: null })],
  });
  const toolbar = everyNode(page.main).find((n) => n.getAttribute?.('class') === 'toolbar');
  assert.deepEqual(
    toolbar.childNodes.map((n) => [
      n.tagName,
      n.getAttribute('data-role'),
      n.getAttribute('class'),
      n.textContent,
      n.href ?? null,
    ]),
    [
      ['A', 'capture-agent', 'button', 'Capture an agent', `/capture/?company=${COMPANY}`],
      ['BUTTON', 'reload', 'secondary', 'Reload', null],
    ],
  );
  assert.equal(page.role('upload-link'), null, 'no upload control of its own');
  assert.equal(page.role('capture-link'), null, 'no capture prompt control of its own');
  assert.equal(page.state('empty').childNodes[1].textContent, view.INTAKE_TEXT.listEmptyHow);
  assert.match(view.INTAKE_TEXT.listEmptyHow, /^Capture an agent, above,/);
  globalThis.location.search = '';
});
