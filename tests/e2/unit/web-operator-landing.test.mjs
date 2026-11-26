/* The operator landing and header (HOSTED-F2, evidence/operator-landing.md), run in Node with an injected fetch,
   location, history and document (the method of web-e6-modules.test.mjs, in a file of its own so its globals are not
   shared).

   1. shell.mjs operatorStanding reads api.mjs's answer to the register read three ways and no more: 200 is an operator at
      aal2, 403 E_OPERATOR_MFA_REQUIRED an operator at aal1, 403 E_NOT_OPERATOR anyone else. Any other answer, a
      maintenance answer, a network failure, a 404, another 403 or a code this page does not know, is null: no operator
      link, and the home page shows the failure with Retry rather than the members' empty state. isOperator and
      operatorLanding follow it; the landing is /operator/ at aal2 and /mfa/ at aal1, both in the fixed navigation set. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { messageFor } from '../../../lib/errors.mjs';

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
  addEventListener() {}
  get children() {
    return this.childNodes.filter((c) => c instanceof FakeElement);
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this.childNodes = [new FakeText(value)];
  }
}

const navigations = [];
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define('location', { hash: '', pathname: '/', search: '', assign: (target) => navigations.push(target) });
define('history', { replaceState: () => undefined });
define('document', {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => new FakeText(text),
  getElementById: (id) => new FakeElement(id),
});
define('addEventListener', () => undefined);

/* Every node of a fake tree, depth first. */
function* walkTree(node) {
  yield node;
  for (const c of node.childNodes ?? []) if (c instanceof FakeElement) yield* walkTree(c);
}

const APP = '../../../web/assets/app';
let serial = 0;
const freshApi = () => import(`${APP}/api.mjs?ol=${++serial}`);
const shell = await import(`${APP}/shell.mjs`);

const json = (status, value) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const refusal = (status, code) => () => json(status, { ok: false, code, message: messageFor(code) ?? 'A message.' });

/** The register read under one scripted answer, through api.mjs as a page sends it. */
async function registerAnswer(answer) {
  const api = await freshApi();
  globalThis.fetch = async (path, init) => {
    if (`${init.method} ${path}` !== 'GET /api/operator/companies')
      throw new Error(`unscripted ${init.method} ${path}`);
    return answer();
  };
  return api.operatorCompanies();
}

test('landing: the register answer is read three ways, and every other answer says nothing (OPL-F1)', async () => {
  const cases = [
    [
      '200',
      () => json(200, { companies: [], sweepableAccounts: 0, nextCursor: null, cursorReset: false }),
      'aal2',
      true,
      '/operator/',
    ],
    ['403 E_OPERATOR_MFA_REQUIRED', refusal(403, 'E_OPERATOR_MFA_REQUIRED'), 'aal1', true, '/mfa/'],
    ['403 E_NOT_OPERATOR', refusal(403, 'E_NOT_OPERATOR'), 'none', false, null],
    ['503 E_MAINTENANCE', refusal(503, 'E_MAINTENANCE'), null, false, null],
    ['404 E_NOT_FOUND', refusal(404, 'E_NOT_FOUND'), null, false, null],
    ['403 E_FORBIDDEN', refusal(403, 'E_FORBIDDEN'), null, false, null],
    [
      '403 with a code this page does not know',
      () => json(403, { ok: false, code: 'E_SOMETHING_NEW', message: 'New.' }),
      null,
      false,
      null,
    ],
    ['500 that is not the service JSON', () => new Response('<html>', { status: 500 }), null, false, null],
    ['a network failure', () => Promise.reject(new TypeError('network')), null, false, null],
  ];
  for (const [label, answer, standing, operator, landing] of cases) {
    const r = await registerAnswer(answer);
    assert.equal(shell.operatorStanding(r), standing, label);
    assert.equal(shell.isOperator(r), operator, label);
    assert.equal(shell.operatorLanding(r), landing, label);
    if (landing) assert.equal(shell.isAllowedTarget(landing), true, `${label}: the landing is in the fixed set`);
  }
  for (const nothing of [null, undefined, {}, { ok: 'true' }, { code: 'e_not_operator' }])
    assert.equal(shell.operatorStanding(nothing), null, JSON.stringify(nothing));
  assert.deepEqual(navigations, [], 'reading an answer never navigates');
});

test('landing: an answer that says nothing about the caller is offered again with Retry, whatever its action (PC-1)', async () => {
  const controls = (node) => [...walkTree(node)].map((n) => n.getAttribute?.('data-role')).filter(Boolean);
  const cases = [
    ['503 E_MAINTENANCE', refusal(503, 'E_MAINTENANCE'), 'maintenance'],
    ['404 E_NOT_FOUND', refusal(404, 'E_NOT_FOUND'), 'retry'],
    ['403 E_FORBIDDEN', refusal(403, 'E_FORBIDDEN'), 'retry'],
    ['403 E_COMPANY_INACTIVE', refusal(403, 'E_COMPANY_INACTIVE'), 'retry'],
    [
      '403 with a code this page does not know',
      () => json(403, { ok: false, code: 'E_SOMETHING_NEW', message: 'New.' }),
      'retry',
    ],
    ['500 that is not the service JSON', () => new Response('<html>', { status: 500 }), 'retry'],
    ['a network failure', () => Promise.reject(new TypeError('network')), 'retry'],
  ];
  for (const [label, answer, action] of cases) {
    const r = await registerAnswer(answer);
    assert.equal(shell.operatorStanding(r), null, label);
    const shown = shell.standingUnknown(r);
    assert.equal(shown.action, action, label);
    assert.equal(shown.code, r.code, `${label}: the code and message are the answer's`);
    const view = shell.failureView(shown, { retry: () => undefined });
    assert.ok(controls(view).includes('retry'), `${label}: Retry is offered`);
  }
});

/* 2. The header (item 2). renderHeader draws the operator's navigation only when `operator` is exactly true, which only
   isOperator gives; every other value, and its absence, draws the header a member has always had: the lockup, the
   company when named, and the address with sign-out, in that order, with nothing between them. */
const tree = (node) =>
  node instanceof FakeElement
    ? {
        tag: node.tagName,
        attributes: Object.fromEntries(node.attributes),
        ...(node.href === undefined ? {} : { href: node.href }),
        children: node.childNodes.map(tree),
      }
    : node.textContent;
const header = (options) => {
  const h = new FakeElement('header');
  shell.renderHeader(h, { email: 'person@example.invalid', onSignOut: () => undefined, ...options });
  return h;
};
const bar = (h) => h.children[0];
const roleOf = (n) => n.getAttribute('data-role') ?? n.getAttribute('class');

test('header: a member header is drawn as before, and nothing but true draws the operator navigation', () => {
  for (const companyName of [null, 'Acme']) {
    const plain = tree(header({ companyName }));
    for (const operator of [undefined, false, 'yes', 1, {}, null])
      assert.deepEqual(tree(header({ companyName, operator })), plain, `operator: ${JSON.stringify(operator)}`);
    assert.deepEqual(
      bar(header({ companyName })).children.map(roleOf),
      companyName ? ['lockup', 'company-name', 'who'] : ['lockup', 'who'],
      'the lockup, the company when named, and the address with sign-out',
    );
  }
});

test('header: the operator navigation holds Companies and New company, the current page shown and not linked', () => {
  for (const [path, current] of [
    ['/operator/', 'nav-companies'],
    ['/operator/new/', 'nav-new-company'],
    ['/account/', null],
    ['/mfa/', null],
    ['/operator/company/', null],
  ]) {
    location.pathname = path;
    const b = bar(header({ operator: true }));
    assert.deepEqual(b.children.map(roleOf), ['lockup', 'operator-nav', 'who'], path);
    const nav = b.children[1];
    assert.equal(nav.tagName, 'NAV');
    assert.equal(nav.getAttribute('aria-label'), 'Operator pages');
    assert.deepEqual(
      nav.children.map((n) => [
        n.getAttribute('data-role'),
        n.tagName,
        n.href ?? null,
        n.getAttribute('aria-current'),
        n.textContent,
      ]),
      [
        ['nav-companies', '/operator/', 'Companies'],
        ['nav-new-company', '/operator/new/', 'New company'],
      ].map(([role, href, label]) =>
        role === current ? [role, 'SPAN', null, 'page', label] : [role, 'A', href, null, label],
      ),
      path,
    );
  }
  location.pathname = '/';
});

/* 3. The glance (item 3), web/assets/app/operator-glance.mjs: pure functions over register rows. */
const glance = await import(`${APP}/operator-glance.mjs`);
const lifecycleView = await import(`${APP}/lifecycle-view.mjs`);
const at = (iso) => Date.parse(iso);
const period = (endsAt, state = 'current', extra = {}) => ({ endsAt, state, deletionState: 'not_eligible', ...extra });
const row = (name, status, accessPeriod, counts = { admins: 1, invitationsPending: 0 }) => ({
  companyId: name,
  name,
  slug: name,
  status,
  accessPeriod,
  counts,
});

test('glance: days are whole UTC calendar days, held to the service word on either side of the end', () => {
  const now = at('2026-09-22T23:30:00Z');
  assert.equal(glance.daysLeft(period('2026-09-23T00:30:00Z'), now), 1, 'an hour away across midnight UTC is one day');
  assert.equal(glance.daysLeft(period('2026-09-22T23:59:00Z'), now), 0, 'later the same UTC day is today');
  assert.equal(glance.daysLeft(period('2026-10-22T12:00:00Z'), now), 30);
  assert.equal(glance.daysLeft(period('2026-07-24T00:00:00Z', 'export_window'), now), -60);
  assert.equal(
    glance.daysLeft(period('2026-09-21T00:00:00Z', 'current'), now),
    0,
    'the service says current: never past',
  );
  assert.equal(
    glance.daysLeft(period('2026-09-25T00:00:00Z', 'expired'), now),
    0,
    'the service says ended: never ahead',
  );
  for (const p of [null, {}, period(null), period('not a date')])
    assert.equal(glance.daysLeft(p, now), null, JSON.stringify(p));
  assert.equal(glance.daysLeft(period('2026-10-01T00:00:00Z'), Number.NaN), null);
});

test('glance: the warning word is text, Ending soon at 30 days or fewer, Ended on the service word', () => {
  assert.equal(glance.ENDING_SOON_DAYS, 30);
  assert.equal(glance.agreementWord(period('x'), 30), 'Ending soon');
  assert.equal(glance.agreementWord(period('x'), 0), 'Ending soon');
  assert.equal(glance.agreementWord(period('x'), 31), null);
  assert.equal(glance.agreementWord(period('x'), null), null);
  assert.equal(glance.agreementWord(period('x', 'export_window'), 0), 'Ended');
  assert.equal(glance.agreementWord(period('x', 'expired'), -40), 'Ended');
  /* The two ended states are the lifecycle vocabulary's, which web-e6-modules pins to lib/rules/lifecycle.mjs. */
  for (const s of ['export_window', 'expired', 'current', 'none'])
    assert.ok(lifecycleView.ACCESS_STATES.includes(s), s);
  assert.deepEqual(
    [
      glance.daysText(period('x'), 56),
      glance.daysText(period('x'), 1),
      glance.daysText(period('x'), 0),
      glance.daysText(period('x', 'expired'), -1),
      glance.daysText(period('x', 'expired'), -60),
      glance.daysText(period('x', 'export_window'), 0),
      glance.daysText(period(null), null),
    ],
    ['56 days left', '1 day left', 'Ends today', 'Ended 1 day ago', 'Ended 60 days ago', 'Ended today', 'No end date'],
  );
  assert.deepEqual(
    [
      glance.endingSentence(period('2026-11-17T10:00:00Z'), 56),
      glance.endingSentence(period('2026-09-22T10:00:00Z'), 0),
      glance.endingSentence(period('2026-07-24T10:00:00Z', 'export_window'), -60),
    ],
    ['Ends 17 November 2026: 56 days left.', 'Ends today, 22 September 2026.', 'Ended 24 July 2026: 60 days ago.'],
  );
});

test('glance: companies by status, in the vocabulary order, an unknown status named as sent', () => {
  const rows = [
    row('a', 'closed'),
    row('b', 'active'),
    row('c', 'suspended'),
    row('d', 'active'),
    row('e', 'held'),
    row('f', 'paused'),
  ];
  const summary = glance.statusSummary(rows);
  assert.deepEqual(summary, {
    total: 6,
    counts: [
      ['active', 2],
      ['suspended', 1],
      ['closed', 1],
      ['held', 1],
      ['paused', 1],
    ],
  });
  assert.equal(
    glance.statusSentence(summary),
    '6 companies: 2 active, 1 suspended, 1 closed, 1 held after a restore, 1 paused.',
  );
  assert.equal(glance.statusSentence(glance.statusSummary([row('a', 'active')])), '1 company: 1 active.');
  assert.equal(glance.statusSentence(glance.statusSummary([])), 'No companies yet.');
});

test('glance: the soonest list is soonest end first, closed and undated companies left out, the rest counted', () => {
  const now = at('2026-09-22T12:00:00Z');
  const rows = [
    row('later', 'active', period('2026-12-01T00:00:00Z')),
    row('closed', 'closed', period('2026-01-01T00:00:00Z', 'expired')),
    row('undated', 'active', period(null, 'none')),
    row('ended', 'suspended', period('2026-07-24T00:00:00Z', 'export_window')),
    row('soon', 'active', period('2026-10-10T00:00:00Z')),
    row('next', 'active', period('2026-11-01T00:00:00Z')),
  ];
  const all = glance.endingSoonest(rows, now);
  assert.deepEqual(
    all.items.map((i) => [i.row.name, i.days, i.word]),
    [
      ['ended', -60, 'Ended'],
      ['soon', 18, 'Ending soon'],
      ['next', 40, null],
      ['later', 70, null],
    ],
  );
  assert.equal(all.later, 0);
  const two = glance.endingSoonest(rows, now, 2);
  assert.deepEqual(
    two.items.map((i) => i.row.name),
    ['ended', 'soon'],
  );
  assert.equal(two.later, 2, 'two dated companies not shown');
  assert.equal(glance.SOONEST_SHOWN, 5);
});

test('glance: what needs the operator, as far as the rows show it, and nothing the rows cannot show', () => {
  const needs = (r) => glance.needsOf(r);
  assert.deepEqual(needs(row('fine', 'active', period('2027-01-01T00:00:00Z'))), []);
  assert.deepEqual(needs(row('s', 'suspended', period('2027-01-01T00:00:00Z'))), ['Suspended']);
  assert.deepEqual(needs(row('h', 'held', period('2027-01-01T00:00:00Z'))), ['Held after a restore']);
  assert.deepEqual(needs(row('u', 'active', period(null, 'none'))), ['No agreement dates']);
  assert.deepEqual(needs(row('n', 'active', undefined)), ['No agreement dates']);
  assert.deepEqual(
    needs(
      row(
        'w',
        'active',
        period('2026-07-01T00:00:00Z', 'expired', { deletionState: 'overdue', deleteBy: '2026-09-06T00:00:00Z' }),
      ),
    ),
    ['Deletion overdue since 6 September 2026', 'Reading window closed and not yet suspended by the sweep'],
  );
  assert.deepEqual(
    needs(
      row(
        'c',
        'closed',
        period('2026-07-01T00:00:00Z', 'expired', { deletionState: 'due', deleteBy: '2026-10-01T00:00:00Z' }),
        { admins: 0, invitationsPending: 0 },
      ),
    ),
    ['Deletion due by 1 October 2026'],
    'a closed company needs only its deletion, whatever its counts',
  );
  assert.deepEqual(
    needs(row('c2', 'closed', period(null, 'none'), { admins: 0 })),
    [],
    'a closed company with nothing due',
  );
  assert.deepEqual(needs(row('a0', 'active', period('2027-01-01T00:00:00Z'), { admins: 0, invitationsPending: 0 })), [
    'No administrator yet and no open invitation',
  ]);
  assert.deepEqual(needs(row('a1', 'active', period('2027-01-01T00:00:00Z'), { admins: 0, invitationsPending: 1 })), [
    'No administrator yet; 1 open invitation',
  ]);
  assert.deepEqual(needs(row('a3', 'active', period('2027-01-01T00:00:00Z'), { admins: 0, invitationsPending: 3 })), [
    'No administrator yet; 3 open invitations',
  ]);
  assert.deepEqual(needs(row('ax', 'active', period('2027-01-01T00:00:00Z'), {})), [], 'no admin count, no claim');
  const list = glance.needsYou([
    row('fine', 'active', period('2027-01-01T00:00:00Z')),
    row('s', 'suspended', period('2027-01-01T00:00:00Z')),
  ]);
  assert.deepEqual(
    list.map((x) => [x.row.name, x.reasons]),
    [['s', ['Suspended']]],
  );
});

test('glance: the table orders, soonest end first by default with undated companies last, or as the service sent them', () => {
  const rows = [
    row('overdue', 'active', period('2026-07-24T00:00:00Z', 'expired', { deletionState: 'overdue' })),
    row('undated-1', 'active', period(null, 'none')),
    row('later', 'active', period('2026-12-01T00:00:00Z')),
    row('tie-a', 'active', period('2026-10-10T00:00:00Z')),
    row('undated-2', 'active', undefined),
    row('tie-b', 'active', period('2026-10-10T00:00:00Z')),
  ];
  const before = rows.map((r) => r.name);
  assert.deepEqual(glance.ORDERS, ['ending', 'service']);
  assert.deepEqual(
    glance.orderRows(rows, 'ending').map((r) => r.name),
    ['overdue', 'tie-a', 'tie-b', 'later', 'undated-1', 'undated-2'],
  );
  assert.deepEqual(
    glance.orderRows(rows, 'service').map((r) => r.name),
    before,
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    before,
    'the rows the page holds are not reordered',
  );
});
