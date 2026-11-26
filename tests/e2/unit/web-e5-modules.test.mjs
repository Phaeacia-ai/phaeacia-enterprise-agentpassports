/* E5 design 1.3, 1.5, 4.1 and 4.2, the browser half's own rules, run in Node with an injected fetch, location, history
   and document (the method of web-e4-modules.test.mjs, in a file of its own so its globals are not shared).

   What is checked here, and what it is worth. Four of these are pins between a presentation copy under web/ and the
   authoritative rule under lib/, which a page may not import (the import contract of pages design 4.5 admits web/ ->
   web/ and nothing else). A pin is the whole value of a copy: without it the two drift silently, which is the
   duplicated-rule defect the quality gates name. The fifth is the label gate of design 1.5 over the pages' own
   sentences: a string check over a fixed table, not a content detector, and it is stated as that.

     1. the status vocabulary and its plain names equal app.installation_statuses() through lib/rules/installations.mjs;
     2. the losses rule, which the page says before the server does, equals the rule module's lossesRequired;
     3. the authorization label equals authorizationLabelOf, so no surface can say "installed" from a ledger count;
     4. the page's five sentence functions answer a sentence for every value the service can send, including values
        they do not know, so a code or reason added later shows a sentence rather than nothing;
     5. the label gate: no sentence the pages can produce carries `verified`, `validated`, `confirmed working` or
        `certified`, judged by the server's own refusedLabelTokens over the page's own labelTable().

   The api.mjs half: the five E5 callers send the rule 2 request shape, the two bound writes carry one key per attempt
   and the download carries none, and the catalog sends its cursor as its one query value.

   The capture-once half (evidence/capture-once.md), the page modules loaded against scripted answers and driven through
   their own listeners, as tests/e2/unit/web-intake-modules.test.mjs drives the draft page: the review page's sign-off
   (INF-N3, an E4 page, here because this file's document already makes elements) and the release page's report
   (INF-N4), witness (INF-N5) and withdrawal (INF-N6). Each write is read once at its press and held until its answer,
   and its Retry sends that press again under its key only while the form is unchanged. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  authorizationLabelOf,
  INSTALLATION_STATUSES,
  lossesRequired,
  refusedLabelTokens,
  REFUSED_LABEL_TOKENS,
  statusName,
} from '../../../lib/rules/installations.mjs';

/* The two renderers checked here (E5PW-R-F1 and F2) need a document that makes elements, not only one that finds them.
   It records tag, attributes and text, which is all these two assertions read; web-packet-view.test.mjs has the same
   minimal document for the same reason, and neither file may import the other's, because each defines its own globals
   and a shared one under tests/e2/unit is not this lane's to add. The capture-once cases added its listeners and the
   page's two roots, as web-intake-modules.test.mjs has them. */
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
  get children() {
    return this.childNodes.filter((c) => c instanceof FakeElement);
  }
  /* An input's value and checkedness start from its attributes, as a browser's do; pickedOne reads both. */
  get value() {
    return this._value ?? this.getAttribute('value') ?? '';
  }
  set value(value) {
    this._value = String(value);
  }
  get checked() {
    return this._checked ?? this.attributes.has('checked');
  }
  set checked(value) {
    this._checked = Boolean(value);
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this.childNodes = [new FakeText(value)];
  }
}

const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
/* The page's two roots while a page test runs; any other id answers a new element, as before. */
let roots = {};
define('location', { hash: '', pathname: '/catalog/', search: '', assign: () => undefined });
define('history', { replaceState: () => undefined });
define('document', {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => new FakeText(text),
  getElementById: (id) => roots[id] ?? new FakeElement(id),
});
define('addEventListener', () => undefined);

const APP = '../../../web/assets/app';
let serial = 0;
const freshApi = () => import(`${APP}/api.mjs?e5=${++serial}`);
const view = await import(`${APP}/passport-view.mjs`);

const COMPANY = '2a5d1b3c-4e6f-4a8b-9c0d-1e2f3a4b5c6d';
const RELEASE = '1a2b3c4d-5e6f-4a8b-9c0d-e1f2a3b4c5d6';
const REPORT = '9c0e5b1f-2a3d-4c5e-8f60-7a8b9c0d1e2f';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const json = (status, value) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function service(routes) {
  const log = [];
  globalThis.fetch = async (path, init) => {
    const key = `${init.method} ${path}`;
    log.push({ key, init });
    const answer = routes[key];
    if (!answer) throw new Error(`unscripted ${key}`);
    return answer();
  };
  return log;
}

test('E5 pages: the status vocabulary and the plain names are the rule module’s, value for value', () => {
  assert.deepEqual([...view.INSTALLATION_STATUSES], [...INSTALLATION_STATUSES], 'the vocabulary and its order');
  for (const status of INSTALLATION_STATUSES)
    assert.equal(view.installationStatusName(status), statusName(status), status);
  /* A status this copy does not know is shown as itself and decides nothing, so a vocabulary the server widens first
     renders as a value rather than as an empty string. */
  assert.equal(view.installationStatusName('a_status_added_later'), 'a_status_added_later');
});

test('E5 pages: the losses rule the page says before the server is the rule module’s', () => {
  for (const status of [...INSTALLATION_STATUSES, 'a_status_added_later', null, undefined])
    assert.equal(view.lossesRequiredFor(status), lossesRequired(status), String(status));
  assert.deepEqual([...view.LOSSES_REQUIRED_STATUSES], ['partial', 'fail']);
});

test('E5 pages: the authorization label is the rule module’s and never an installation word (E5D-C-F5)', () => {
  for (const n of [1, 2, 3, 200])
    assert.equal(view.authorizationLabel(n), authorizationLabelOf({ authorizations: n }), String(n));
  assert.equal(view.authorizationLabel(0), null, 'no authorization has no label');
  /* The rule module throws for these; a page must not, because it renders whatever the answer carried. */
  for (const bad of [null, undefined, -1, 1.5, '2']) assert.equal(view.authorizationLabel(bad), null, String(bad));
  const installWords = /\binstall/i;
  for (const n of [1, 2, 200]) assert.equal(installWords.test(view.authorizationLabel(n)), false, String(n));
});

test('E5 pages: every empty reason and every refusal code answers a sentence, including ones this copy does not know', () => {
  for (const reason of ['no_target_enabled', 'no_groups', 'none_for_my_groups'])
    assert.notEqual(view.emptySentence(reason), view.INSTALLATION_TEXT.emptyUnknown, reason);
  for (const reason of ['a_reason_added_later', null, undefined])
    assert.equal(view.emptySentence(reason), view.INSTALLATION_TEXT.emptyUnknown, String(reason));
  assert.equal(view.blockedSentence(null, 'claude-ai'), null, 'a row that is not blocked has no sentence');
  assert.equal(view.blockedSentence(undefined, 'claude-ai'), null);
  const codes = [
    'E_TARGET_NOT_PUBLISHABLE',
    'E_AGENT_ORPHANED',
    'E_AGENT_ARCHIVED',
    'E_RELEASE_WITHDRAWN',
    'E_RELEASE_SUPERSEDED',
    'E_DOWNLOAD_LIMIT',
    'E_NOT_FOUND',
  ];
  const seen = new Set();
  for (const code of codes) {
    const sentence = view.blockedSentence(code, 'claude-ai');
    assert.equal(typeof sentence, 'string', code);
    assert.notEqual(sentence, view.INSTALLATION_TEXT.blockOther, `${code} has its own sentence`);
    assert.equal(seen.has(sentence), false, `${code} is not another code's sentence`);
    seen.add(sentence);
  }
  assert.equal(view.blockedSentence('E_A_CODE_ADDED_LATER', 'claude-ai'), view.INSTALLATION_TEXT.blockOther);
  /* The target-blocked sentence names the target, and a target this copy has no name for is shown as itself. */
  assert.match(
    view.blockedSentence('E_TARGET_NOT_PUBLISHABLE', 'claude-ai'),
    /Installation for claude\.ai is not enabled/,
  );
  assert.match(view.blockedSentence('E_TARGET_NOT_PUBLISHABLE', 'copilot'), /Installation for copilot is not enabled/);
});

test('E5 pages: the copies sentence claims an installation only from a report of this member’s (E5D-C-F5)', () => {
  assert.equal(view.copiesSentence(null), view.INSTALLATION_TEXT.copiesNoReport);
  assert.equal(view.copiesSentence(undefined), view.INSTALLATION_TEXT.copiesNoReport);
  assert.match(view.copiesSentence(null), /Any copy you downloaded/);
  assert.equal(/\binstalled\b/.test(view.copiesSentence(null)), false, 'no report claims no installation');
  assert.equal(view.copiesSentence({ status: 'removed' }), view.INSTALLATION_TEXT.copiesRemoved);
  for (const status of ['pass', 'partial', 'fail'])
    assert.equal(view.copiesSentence({ status }), view.INSTALLATION_TEXT.copiesInstalled, status);
});

/* E5PW-R-F2. The entry is design 3.4's "any membership with a report and no authorization" in scope `company`: the
   count is present and is zero, so the ledger is not leaked and the only question is who the sentence is about. The
   review produced this entry owner-side on the running stack and read the second-person sentence on an administrator's
   page; here it is the rendered line, for another membership and for the reader's own. */
const ENTRY = {
  membershipId: '7d6c5b4a-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
  authorizations: 0,
  firstAuthorizedAt: null,
  lastAuthorizedAt: null,
  reports: [],
};

test('E5PW-R-F2: a recipient entry with no authorization is second person only where it is the reader’s own', () => {
  const other = view.authorizationLine(ENTRY, { own: false });
  assert.equal(other.textContent, view.INSTALLATION_TEXT.noAuthorizationOther);
  assert.equal(other.getAttribute('data-role'), 'authorization', 'the same line a reviewer’s page must not carry');
  assert.equal(/\byou\b/i.test(other.textContent), false, 'an administrator is not the member the entry is about');
  const own = view.authorizationLine(ENTRY, { own: true });
  assert.equal(own.textContent, view.INSTALLATION_TEXT.noAuthorization);
  assert.match(own.textContent, /^You /, 'and the reader’s own entry keeps the second person');
  /* The default is the third person: a caller that forgets to say whose entry it is cannot address a stranger. */
  assert.equal(view.authorizationLine(ENTRY).textContent, view.INSTALLATION_TEXT.noAuthorizationOther);
  assert.equal(view.noAuthorizationSentence(true), view.INSTALLATION_TEXT.noAuthorization);
  for (const notOwn of [false, null, undefined, 'yes', 1])
    assert.equal(view.noAuthorizationSentence(notOwn), view.INSTALLATION_TEXT.noAuthorizationOther, String(notOwn));
  /* A count the ledger does have keeps its label whoever reads it, and the dates still render. */
  const counted = view.authorizationLine(
    { ...ENTRY, authorizations: 2, firstAuthorizedAt: '2026-09-17T08:00:00.000Z' },
    { own: false },
  );
  assert.match(counted.textContent, /^Download authorized 2 times, first 2026-09-17/);
});

/* E5PW-R-F1. The pending row is the one the losses table renders on every load not preceded by a download, which is
   every reload; it may not tell a member who has reported that nothing is installed yet. */
test('E5PW-R-F1: the pending losses row follows this member’s own newest report', () => {
  /* The rendered row, which is the thing the reader meets: the same table in both states, the contradicted sentence in
     neither of the states a report produces, and E5D-C-F8's sentence for a caller that hands over no report at all. */
  for (const lastReport of [
    { reportId: 'r', status: 'pass' },
    { reportId: 'r', status: 'removed' },
  ]) {
    const node = view.lossesTable({ state: 'pending', rows: [] }, { lastReport });
    assert.equal(node.getAttribute('data-losses'), 'pending', lastReport.status);
    assert.equal(
      node.textContent.includes(view.LOSSES_PENDING),
      false,
      `${lastReport.status}: the pending row still says "${view.LOSSES_PENDING}" to a member whose own report says otherwise`,
    );
    assert.equal(node.textContent.includes(view.INSTALLATION_TEXT.lossesPendingHanded), true, lastReport.status);
  }
  for (const node of [
    view.lossesTable(null),
    view.lossesTable(null, { lastReport: null }),
    view.lossesTable(undefined, {}),
  ]) {
    assert.equal(node.getAttribute('data-losses'), 'pending');
    assert.equal(node.textContent.includes(view.LOSSES_PENDING), true, 'the default is unchanged');
  }
  /* And the sentence on its own, which is where the choice is made and what the label gate reads. */
  assert.equal(view.pendingLossesSentence(null), view.LOSSES_PENDING);
  assert.equal(view.pendingLossesSentence(undefined), view.LOSSES_PENDING);
  for (const status of ['pass', 'partial', 'fail', 'removed']) {
    const sentence = view.pendingLossesSentence({ reportId: 'r', status });
    assert.equal(sentence, view.INSTALLATION_TEXT.lossesPendingHanded, status);
    assert.equal(/\binstalled\b/.test(sentence), false, `${status}: it claims no installation either`);
  }
});

test('E5 pages: the label gate, design 1.5 — no sentence these pages can produce carries a refused token', () => {
  const rows = view.labelTable();
  assert.ok(rows.length >= 40, `the table has ${rows.length} rows`);
  const found = [];
  for (const row of rows) {
    if (row.label === null) continue;
    assert.equal(typeof row.label, 'string', JSON.stringify(row));
    const tokens = refusedLabelTokens(row.label);
    if (tokens.length) found.push({ row, tokens });
  }
  assert.deepEqual(found, [], `refused tokens (${REFUSED_LABEL_TOKENS.join(', ')}) in a page sentence`);
  /* The gate can fail: a sentence carrying one of the four is found by the same check. */
  assert.deepEqual(refusedLabelTokens('Verified by an IT reviewer'), ['verified']);
  assert.deepEqual(refusedLabelTokens('Certified and validated'), ['validated', 'certified']);
  /* Every fixed sentence of the table is reachable from INSTALLATION_TEXT, so a sentence added to the object is
     judged here whether or not a function returns it yet. */
  const fixed = rows.filter((r) => r.kind === 'fixed').map((r) => r.key);
  assert.deepEqual(fixed.sort(), Object.keys(view.INSTALLATION_TEXT).sort());
});

test('E5 api: the catalog, the download and the installations read send the rule 2 shape and no key', async () => {
  const api = await freshApi();
  const log = service({
    [`GET /api/companies/${COMPANY}/catalog`]: () =>
      json(200, { ok: true, available: [], earlier: [], empty: null, nextCursor: null }),
    [`GET /api/companies/${COMPANY}/catalog?cursor=${RELEASE}`]: () =>
      json(200, { ok: true, available: [], earlier: [], empty: null, nextCursor: null }),
    [`POST /api/releases/${RELEASE}/download`]: () => json(200, { ok: true, assembledContent: 'x' }),
    [`GET /api/releases/${RELEASE}/installations`]: () => json(200, { ok: true, recipients: [], scope: 'own' }),
  });
  await api.catalog(COMPANY);
  await api.catalog(COMPANY, RELEASE);
  await api.download(RELEASE);
  await api.installations(RELEASE);
  assert.deepEqual(
    log.map((e) => e.key),
    [
      `GET /api/companies/${COMPANY}/catalog`,
      `GET /api/companies/${COMPANY}/catalog?cursor=${RELEASE}`,
      `POST /api/releases/${RELEASE}/download`,
      `GET /api/releases/${RELEASE}/installations`,
    ],
  );
  for (const entry of log) {
    assert.equal(entry.init.credentials, 'same-origin');
    assert.equal(entry.init.cache, 'no-store');
    assert.equal(entry.init.redirect, 'error');
    assert.equal(entry.init.headers['idempotency-key'], undefined, `${entry.key} carries no key`);
    assert.equal(entry.init.body, undefined, `${entry.key} carries no body`);
  }
});

test('E5 api: the report and the witness are bound writes, one key per attempt, reused on that attempt’s retry', async () => {
  const api = await freshApi();
  const log = service({
    [`POST /api/releases/${RELEASE}/installations`]: () => json(201, { ok: true, report: {} }),
    [`POST /api/installations/${REPORT}/witness`]: () => json(201, { ok: true, witness: {}, report: {} }),
  });
  const report = api.writeAttempt((key) =>
    api.reportInstallation(RELEASE, { status: 'partial', losses: 'The calendar read is off.', assistance: null }, key),
  );
  await report();
  await report();
  const witness = api.writeAttempt((key) => api.witnessInstallation(REPORT, { status: 'partial', note: 'Seen.' }, key));
  await witness();
  const keys = log.map((e) => e.init.headers['idempotency-key']);
  assert.match(keys[0], UUID_V4);
  assert.equal(keys[1], keys[0], 'the retry of an attempt sends its key again');
  assert.notEqual(keys[2], keys[0], 'a new attempt has its own key');
  assert.equal(
    log[0].init.body,
    JSON.stringify({ status: 'partial', losses: 'The calendar read is off.', assistance: null }),
  );
  assert.equal(log[2].init.body, JSON.stringify({ status: 'partial', note: 'Seen.' }));
  for (const entry of log) assert.equal(entry.init.headers['content-type'], 'application/json');
});

/* E5C-R-F3 (evidence/batch-2-review.md), paid by the E6 pages lane: the pending row's sentence must see whether an answer
   is in hand and whether the release is blocked. Two states made it false: a block whose packet declared nothing, in
   hand in this page lifetime, told a member who had reported that the losses "are shown here when the service hands
   the block over" (it had, and nothing would appear); and a release blocked by its target told a member with a report
   the same, on a page that says four inches above that the block will not be handed over. */
test('E5C-R-F3: the pending row with a block in hand, and with the release blocked', () => {
  const report = { reportId: 'r', status: 'pass' };
  const inHand = view.lossesTable({ state: 'pending', rows: [] }, { lastReport: report, handed: true });
  assert.equal(inHand.getAttribute('data-losses'), 'pending', 'still the pending table: the owner declared nothing');
  assert.equal(
    inHand.textContent.includes(view.INSTALLATION_TEXT.lossesPendingHanded),
    false,
    'in hand: not "shown when handed over"',
  );
  assert.equal(
    inHand.textContent.includes(view.INSTALLATION_TEXT.lossesNothingDeclared),
    true,
    'in hand: the owner declared nothing',
  );
  const noReport = view.lossesTable({ state: 'pending', rows: [] }, { lastReport: null, handed: true });
  assert.equal(
    noReport.textContent.includes(view.INSTALLATION_TEXT.lossesNothingDeclared),
    true,
    'in hand, before any report',
  );
  for (const blocked of ['E_TARGET_NOT_PUBLISHABLE', 'E_AGENT_ORPHANED', 'E_RELEASE_WITHDRAWN']) {
    const node = view.lossesTable(null, { lastReport: report, blocked });
    assert.equal(
      node.textContent.includes(view.INSTALLATION_TEXT.lossesPendingHanded),
      false,
      `${blocked}: not "when handed over"`,
    );
    assert.equal(node.textContent.includes(view.INSTALLATION_TEXT.lossesPendingBlocked), true, blocked);
  }
  /* The states E5PW-R-F1 and E5D-C-F8 settled keep their sentences. */
  assert.equal(
    view.pendingLossesSentence(report),
    view.INSTALLATION_TEXT.lossesPendingHanded,
    'a report, nothing in hand, not blocked',
  );
  assert.equal(
    view.pendingLossesSentence(null, { blocked: 'E_TARGET_NOT_PUBLISHABLE' }),
    view.LOSSES_PENDING,
    'blocked, no report',
  );
  assert.equal(view.pendingLossesSentence(null), view.LOSSES_PENDING);
  /* Neither new sentence is a no-loss statement or an installation claim, and both are in the label table. */
  for (const key of ['lossesNothingDeclared', 'lossesPendingBlocked']) {
    const sentence = view.INSTALLATION_TEXT[key];
    assert.equal(/nothing was lost|no loss|\binstalled\b/i.test(sentence), false, key);
    assert.ok(
      view.labelTable().some((row) => row.kind === 'losses-pending' && row.label === sentence),
      `${key} is reachable in labelTable()`,
    );
  }
});

/* ---------- capture-once: the forms of the review and release pages (evidence/capture-once.md) ---------- */

const CANDIDATE = '4d3c2b1a-6f5e-4b8a-9c0d-e1f2a3b4c5d8';
const ENVELOPE = '7e6d5c4b-3a2f-4e1d-8c0b-a9f8e7d6c5b4';
const VIEWER = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const RECIPIENT = '3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f';
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
const lost = () => () => {
  throw new TypeError('network');
};

/** routes['METHOD /path']: a list of answers used in order, the last repeating. Every request is logged. */
function scripted(routes) {
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

/** A page module run against scripted answers: lookups by data-role, id or data-state, and the bodies it sent. */
async function pageModule(module, pathname, search, answers) {
  roots = { main: new FakeElement('main'), 'site-header': new FakeElement('header') };
  Object.assign(globalThis.location, { pathname, search });
  const log = scripted(answers);
  await import(`../../../web/assets/app/pages/${module}?capture=${++serial}`);
  await settle();
  const all = (node) => [node, ...(node.childNodes ?? []).flatMap(all)];
  const first = (name, value) => all(roots.main).find((n) => n.getAttribute?.(name) === value) ?? null;
  return {
    role: (value) => first('data-role', value),
    id: (value) => first('id', value),
    state: (value) => first('data-state', value),
    /** A radio chosen as a person would: the others of its name are no longer checked. */
    choose: (id) => {
      const input = first('id', id);
      for (const n of all(roots.main)) if (n.getAttribute?.('name') === input.getAttribute('name')) n.checked = false;
      input.checked = true;
    },
    sent: (key) =>
      log
        .filter((x) => x.key === key)
        .map((x) => ({ key: x.init.headers['idempotency-key'], body: JSON.parse(x.init.body) })),
    done: () => Object.assign(globalThis.location, { pathname: '/catalog/', search: '' }),
  };
}
const typeInto = (node, value) => {
  node.value = value;
};

const PAGE_ME = {
  ok: true,
  user: { email: 'viewer@example.invalid', aal: 'aal1' },
  memberships: [{ companyId: COMPANY, membershipId: VIEWER, companyName: 'Company', roles: ['member', 'it_reviewer'] }],
};
const PAGE_MEMBERS = {
  ok: true,
  viewer: { membershipId: VIEWER },
  members: [
    { membershipId: VIEWER, status: 'active', label: { kind: 'self', value: 'Me' }, roles: ['member', 'it_reviewer'] },
    {
      membershipId: RECIPIENT,
      status: 'active',
      label: { kind: 'display_name', value: 'Recipient' },
      roles: ['member'],
    },
  ],
};

/* The release page: the viewer owns the agent (recipients and the withdrawal form), holds an authorization (the report
   form) and a reviewer role (a witness control on the recipient's report). */
const OTHER_REPORT = '8f7e6d5c-4b3a-4f2e-9d1c-0b9a8f7e6d5c';
const RELEASE_READ = {
  ok: true,
  release: {
    releaseId: RELEASE,
    companyId: COMPANY,
    candidateId: CANDIDATE,
    agentId: CANDIDATE,
    target: 'claude-ai',
    state: 'published',
    current: true,
    audience: { groupIds: [] },
    policy: { version: 1 },
  },
  download: { blockedReason: null },
  my: { authorizations: 1, lastReport: null, checkInDue: false },
  recipients: [{ membershipId: RECIPIENT, authorizations: 1 }],
};
const INSTALLATIONS = {
  ok: true,
  scope: 'company',
  recipients: [
    {
      membershipId: RECIPIENT,
      reports: [{ reportId: OTHER_REPORT, membershipId: RECIPIENT, status: 'partial', label: 'Self-reported' }],
    },
  ],
};
const REPORT_WRITE = `POST /api/releases/${RELEASE}/installations`;
const WITNESS_WRITE = `POST /api/installations/${OTHER_REPORT}/witness`;
const WITHDRAW_WRITE = `POST /api/releases/${RELEASE}/withdraw`;
const releasePage = (writes) =>
  pageModule('release.mjs', '/release/', `?release=${RELEASE}`, {
    'GET /api/me': [() => json(200, PAGE_ME)],
    [`GET /api/releases/${RELEASE}`]: [() => json(200, RELEASE_READ)],
    [`GET /api/companies/${COMPANY}/members`]: [() => json(200, PAGE_MEMBERS)],
    [`GET /api/companies/${COMPANY}/groups`]: [() => json(200, { ok: true, groups: [], truncated: false })],
    [`GET /api/releases/${RELEASE}/installations`]: [() => json(200, INSTALLATIONS)],
    ...writes,
  });

test('INF-N4: the report is read at the press and held until its answer; Retry sends that press only while the form is unchanged', async () => {
  const reporting = gate();
  const page = await releasePage({ [REPORT_WRITE]: [() => reporting.answer().then(lost()), lost(), lost()] });
  page.choose('install-status-partial');
  typeInto(page.id('report-losses'), 'first');
  const held = () => [
    page.id('install-status-pass').disabled,
    page.id('report-losses').readOnly,
    page.id('report-assistance').readOnly,
    page.role('report').disabled,
  ];
  const press = page.role('report-form').fire('submit');
  await settle();
  assert.deepEqual(held(), [true, true, true, true], 'while the report is in flight');
  reporting.open();
  await press;
  assert.deepEqual(held(), [false, false, false, false], 'after its answer');
  assert.ok(page.role('retry'), 'the lost answer offers Retry');
  typeInto(page.id('report-losses'), 'later');
  await page.role('retry').fire('click');
  assert.equal(page.sent(REPORT_WRITE).length, 1, 'Retry after an edit sends nothing');
  assert.ok(page.state('report-changed'), 'and says why');
  assert.equal(page.id('report-losses').value, 'later', 'the box keeps the edit');

  await page.role('report-form').fire('submit');
  const [one, two] = page.sent(REPORT_WRITE);
  assert.notEqual(two.key, one.key, 'a press composes a new attempt');
  await page.role('retry').fire('click');
  const three = page.sent(REPORT_WRITE)[2];
  assert.deepEqual(
    [three.key, three.body],
    [two.key, { status: 'partial', losses: 'later', assistance: null }],
    'an unchanged Retry sends the same key and body',
  );
  page.done();
});

test('INF-N5: the witness is read once at the press and held until its answer; a changed Retry sends nothing, never the changed form under the first key', async () => {
  const witnessing = gate();
  const page = await releasePage({ [WITNESS_WRITE]: [() => witnessing.answer().then(lost()), lost(), lost()] });
  await page.role('witness').fire('click');
  page.choose(`witness-${OTHER_REPORT}-partial`);
  typeInto(page.id(`witness-note-${OTHER_REPORT}`), 'first');
  const held = () => [
    page.id(`witness-${OTHER_REPORT}-pass`).disabled,
    page.id(`witness-note-${OTHER_REPORT}`).readOnly,
    page.role('witness-submit').disabled,
  ];
  const press = page.role('witness-form').fire('submit');
  await settle();
  assert.deepEqual(held(), [true, true, true], 'while the witness is in flight');
  witnessing.open();
  await press;
  assert.deepEqual(held(), [false, false, false], 'after its answer');
  typeInto(page.id(`witness-note-${OTHER_REPORT}`), 'later');
  await page.role('retry').fire('click');
  assert.deepEqual(
    page.sent(WITNESS_WRITE).map((x) => x.body.note),
    ['first'],
    'Retry after an edit sends nothing',
  );
  assert.ok(page.state('witness-changed'), 'and says why');
  assert.equal(page.id(`witness-note-${OTHER_REPORT}`).value, 'later', 'the box keeps the edit');

  await page.role('witness-form').fire('submit');
  const [one, two] = page.sent(WITNESS_WRITE);
  assert.notEqual(two.key, one.key, 'a press composes a new attempt');
  await page.role('retry').fire('click');
  const three = page.sent(WITNESS_WRITE)[2];
  assert.deepEqual(
    [three.key, three.body],
    [two.key, { status: 'partial', note: 'later' }],
    'an unchanged Retry sends the same key and body',
  );
  page.done();
});

test('INF-N6: the withdrawal reason is read at Confirm withdrawal, held with every control until the answer, and its Retry sends only the unchanged reason', async () => {
  const withdrawing = gate();
  const retrying = gate();
  const page = await releasePage({
    [WITHDRAW_WRITE]: [() => withdrawing.answer().then(lost()), lost(), () => retrying.answer().then(lost())],
  });
  typeInto(page.id('withdraw-reason'), 'first');
  await page.role('withdraw').fire('click');
  typeInto(page.id('withdraw-reason'), 'edited with the confirmation open');
  const held = () => [
    page.id('withdraw-reason').readOnly,
    page.role('confirm-withdrawal').disabled,
    page.role('cancel').disabled,
  ];
  const press = page.role('confirm-withdrawal').fire('click');
  await settle();
  assert.deepEqual(
    held(),
    [true, true, true],
    'while the withdrawal is in flight: the reason and both buttons, so Cancel cannot lead to a second withdrawal',
  );
  withdrawing.open();
  await press;
  assert.deepEqual(held(), [false, false, false], 'after its answer');
  assert.deepEqual(
    page.sent(WITHDRAW_WRITE).map((x) => x.body.reason),
    ['edited with the confirmation open'],
    'Confirm sends the reason on screen at its press, not the one typed before the confirmation opened',
  );
  typeInto(page.id('withdraw-reason'), 'later');
  await page.role('retry').fire('click');
  assert.equal(page.sent(WITHDRAW_WRITE).length, 1, 'Retry after an edit sends nothing');
  assert.ok(page.state('withdraw-changed'), 'and says why');
  await page.role('confirm-withdrawal').fire('click');
  const [one, two] = page.sent(WITHDRAW_WRITE);
  assert.notEqual(two.key, one.key, 'a press composes a new attempt');
  await page.role('cancel').fire('click');
  const retry = page.role('retry').fire('click');
  await settle();
  assert.equal(
    page.role('withdraw').disabled,
    true,
    'a Retry with the confirmation closed holds Withdraw this release',
  );
  retrying.open();
  await retry;
  assert.equal(page.role('withdraw').disabled, false, 'until its answer');
  const three = page.sent(WITHDRAW_WRITE)[2];
  assert.deepEqual(
    [three.key, three.body],
    [two.key, { reason: 'later' }],
    'an unchanged Retry sends the same key and reason',
  );
  page.done();
});

/* The review page: a submitted version with one open envelope, the viewer an IT reviewer who contributed nothing. */
const REVIEW_READ = {
  ok: true,
  candidate: {
    candidateId: CANDIDATE,
    companyId: COMPANY,
    agentId: CANDIDATE,
    sequence: 1,
    state: 'submitted',
    version: 2,
    authorMembershipId: RECIPIENT,
    content: 'the stored text',
    derived: { title: 'Title', summary: 'Summary', needs: [] },
    attestation: {},
    gateStatus: 'current',
  },
  viewer: {
    roles: ['member', 'it_reviewer'],
    excluded: false,
    exclusionKinds: [],
    mayApproveAs: ['it'],
    mayRequestChangesAs: ['it'],
  },
  contributors: [],
  losses: { state: 'pending', rows: [] },
  agentHistory: { agentName: 'weekly-brief', candidates: [], contributorMembershipIds: [], olderCount: 0 },
  envelopes: [
    {
      envelopeId: ENVELOPE,
      status: 'open',
      target: 'claude-ai',
      revision: 1,
      audience: { groupIds: [] },
      approvals: [],
    },
  ],
  reviews: [],
  releases: [],
  options: { targets: [], groups: [], policy: null },
};
const SIGN_OFF = `POST /api/candidates/${CANDIDATE}/reviews`;
const reviewPage = (writes) =>
  pageModule('review.mjs', '/review/', `?candidate=${CANDIDATE}`, {
    'GET /api/me': [() => json(200, PAGE_ME)],
    [`GET /api/candidates/${CANDIDATE}/review`]: [() => json(200, REVIEW_READ)],
    [`GET /api/companies/${COMPANY}/members`]: [() => json(200, PAGE_MEMBERS)],
    ...writes,
  });

test('INF-N3: the sign-off is read at the press and held until its answer; Retry sends that press only while the reason and choices are unchanged', async () => {
  const signing = gate();
  const page = await reviewPage({ [SIGN_OFF]: [() => signing.answer().then(lost()), lost(), lost()] });
  page.choose('role-it');
  page.choose(`envelope-${ENVELOPE}`);
  typeInto(page.id('review-reason'), 'first');
  const held = () => [
    page.id('review-reason').readOnly,
    page.id('role-it').disabled,
    page.id(`envelope-${ENVELOPE}`).disabled,
    page.role('approve').disabled,
    page.role('request-changes').disabled,
  ];
  const press = page.role('approve').fire('click');
  await settle();
  assert.deepEqual(held(), [true, true, true, true, true], 'while the sign-off is in flight');
  signing.open();
  await press;
  assert.deepEqual(held(), [false, false, false, false, false], 'after its answer');
  typeInto(page.id('review-reason'), 'later');
  await page.role('retry').fire('click');
  assert.equal(page.sent(SIGN_OFF).length, 1, 'Retry after an edit sends nothing');
  assert.ok(page.state('sign-off-changed'), 'and says why');
  assert.equal(page.id('review-reason').value, 'later', 'the box keeps the edit');

  await page.role('approve').fire('click');
  const [one, two] = page.sent(SIGN_OFF);
  assert.notEqual(two.key, one.key, 'a press composes a new attempt');
  await page.role('retry').fire('click');
  const three = page.sent(SIGN_OFF)[2];
  assert.deepEqual(
    [three.key, three.body],
    [two.key, { envelopeId: ENVELOPE, role: 'it', decision: 'approved', reason: 'later' }],
    'an unchanged Retry sends the same key and body',
  );
  page.done();
});
