/* E6 design 1.2, 1.4, 1.5, 1.7, 4.1 and 4.3, the browser half's own rules, run in Node with an injected fetch, location,
   history and document (the method of web-e5-modules.test.mjs, in a file of its own so its globals are not shared).

   What is checked here, and what it is worth. Most of these are pins between a presentation copy in
   web/assets/app/lifecycle-view.mjs and its authority under lib/rules, which a page may not reach (the import contract
   of pages design 4.5 admits web/ -> web/ and nothing else). A pin is the whole value of a copy: without it the two
   drift silently, which is the duplicated-rule defect the quality gates name.

     1. the company statuses, access states, deletion states and both reason vocabularies equal lib/rules/lifecycle.mjs;
     2. departureConsequences equals lib/rules/lifecycle.mjs's over every preview shape the service can send and several
        it cannot;
     3. the quota names, the per-subject three, their labels and the near rule equal lib/rules/quotas.mjs's;
     4. the label gate: no sentence the E6 pages can produce carries a word E5's truthful-label rule refuses, none is a
        server message, and none holds the module keyword the import gate refuses in web/ text; judged over
        labelTable(), a fixed table, and stated as that rather than as a content detector;
     5. the accept link is the value of a read-only input and never an a element or a URL attribute (design 4.3);
     6. api.mjs: the E6 callers send the rule 2 shape with no Idempotency-Key (design 3.3), the resend sends no body,
        the register sends its cursor as its one query value, and an operator at aal1 is routed to /mfa/. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CODES, messageFor } from '../../../lib/errors.mjs';
import { refusedLabelTokens } from '../../../lib/rules/installations.mjs';
import * as lifecycle from '../../../lib/rules/lifecycle.mjs';
import * as quotas from '../../../lib/rules/quotas.mjs';

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
define('location', { hash: '', pathname: '/operator/', search: '', assign: (target) => navigations.push(target) });
define('history', { replaceState: () => undefined });
define('document', {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => new FakeText(text),
  getElementById: (id) => new FakeElement(id),
});
define('addEventListener', () => undefined);

const APP = '../../../web/assets/app';
const REPO = new URL('../../../', import.meta.url);
let serial = 0;
const freshApi = () => import(`${APP}/api.mjs?e6=${++serial}`);
const view = await import(`${APP}/lifecycle-view.mjs`);

const COMPANY = '2a5d1b3c-4e6f-4a8b-9c0d-1e2f3a4b5c6d';
const MEMBER = '9c0e5b1f-2a3d-4c5e-8f60-7a8b9c0d1e2f';
const AGENT = '1a2b3c4d-5e6f-4a8b-9c0d-e1f2a3b4c5d6';

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

/* Every node of a fake tree, depth first. */
function* walk(node) {
  yield node;
  for (const c of node.childNodes ?? []) if (c instanceof FakeElement) yield* walk(c);
}

test('E6 pages: the lifecycle vocabularies are lib/rules/lifecycle.mjs’s, value for value and in order', () => {
  assert.deepEqual([...view.COMPANY_STATUSES], [...lifecycle.COMPANY_STATUSES]);
  assert.deepEqual([...view.ACCESS_STATES], [...lifecycle.ACCESS_STATES]);
  assert.deepEqual([...view.DELETION_STATES], [...lifecycle.DELETION_STATES]);
  assert.deepEqual([...view.STATUS_REASON_CODES], [...lifecycle.STATUS_REASON_CODES]);
  assert.deepEqual([...view.LIFECYCLE_REASON_CODES], [...lifecycle.LIFECYCLE_REASON_CODES]);
  /* The delete block offers two of the three (design 4.1 item 9), each one the rule admits. */
  for (const code of view.DELETE_REASON_CODES) assert.equal(lifecycle.isLifecycleReasonCode(code), true, code);
  assert.deepEqual([...view.DELETE_REASON_CODES], ['retention_deadline', 'customer_instruction']);
});

test('E6 pages: departureConsequences is the rule module’s over every preview shape, including ones it cannot send', () => {
  const agent = (n, r) => ({
    agentId: AGENT,
    name: 'weekly-brief',
    status: 'active',
    currentReleases: n,
    recipients: r,
  });
  const shapes = [
    {},
    null,
    undefined,
    'a string',
    { isLastAdmin: true },
    { isLastAdmin: false, drafts: 0, groups: [], ownedAgents: [] },
    {
      isLastAdmin: true,
      soleHolderOfRoles: ['it_reviewer', 'business_reviewer'],
      groups: [{ groupId: 'g', name: 'Finance' }],
      ownedAgents: [agent(2, 7), agent(1, 0), agent(0, 0)],
      drafts: 3,
      submittedAwaitingReview: 1,
      envelopesAwaitingARoleTheyHold: 2,
      authorizations: 12,
    },
    { ownedAgents: [{ currentReleases: 'two', recipients: null }], drafts: 1.5, authorizations: -1, groups: 'x' },
    { soleHolderOfRoles: [], envelopesAwaitingARoleTheyHold: 4, submittedAwaitingReview: 9 },
  ];
  for (const preview of shapes)
    assert.deepEqual(
      view.departureConsequences(preview),
      lifecycle.departureConsequences(preview),
      JSON.stringify(preview),
    );
});

test('E6 pages: the quota names, the per-subject three, their labels and the near rule are lib/rules/quotas.mjs’s', () => {
  assert.deepEqual([...view.QUOTA_NAMES], [...quotas.QUOTA_NAMES]);
  assert.deepEqual([...view.PER_SUBJECT_QUOTAS], [...quotas.PER_SUBJECT_QUOTAS]);
  assert.equal(view.NEAR_FRACTION, quotas.NEAR_FRACTION);
  for (const name of quotas.QUOTA_NAMES) {
    assert.equal(view.quotaLabel(name), quotas.quotaLabel(name), name);
    assert.equal(view.isPerSubject(name), quotas.isPerSubject(name), name);
  }
  /* A name the copy does not know is shown as itself and decides nothing. */
  assert.equal(view.quotaLabel('a_quota_added_later'), 'a_quota_added_later');
  for (const [used, value] of [
    [0, 25],
    [19, 25],
    [20, 25],
    [25, 25],
    [1, 1],
    [0, 1],
    [4, 5],
    [3, 5],
    [null, 25],
    [20, 0],
    [-1, 5],
    [2.5, 5],
    [5, '5'],
  ])
    assert.equal(view.isNear(used, value), quotas.isNear(used, value), `${used} of ${value}`);
});

test('E6 pages: the label gate, over labelTable()', () => {
  const rows = view.labelTable();
  assert.ok(rows.length > 120, `the table holds every sentence (${rows.length})`);
  const messages = new Set(Object.keys(CODES).map(messageFor));
  for (const row of rows) {
    assert.equal(typeof row.label, 'string', JSON.stringify(row));
    assert.ok(row.label.length > 0, JSON.stringify(row));
    assert.deepEqual(refusedLabelTokens(row.label), [], `a refused word in ${JSON.stringify(row)}`);
    assert.equal(messages.has(row.label), false, `a server message: ${row.label}`);
    for (const m of messages)
      if (m.length >= 16) assert.equal(row.label.includes(m), false, `${row.label} holds "${m}"`);
    /* The import gate (scripts/check-imports.mjs rule 7) refuses the lowercase module keywords anywhere in web/ text;
       a sentence holding one would fail that gate in the page that places it. The user-facing word is Export. */
    assert.equal(/\b(?:export|import)\b/.test(row.label), false, `the module keyword in ${row.label}`);
  }
  /* Every fixed sentence is reachable through the table, so nothing in LIFECYCLE_TEXT escapes the gate. */
  for (const key of Object.keys(view.LIFECYCLE_TEXT))
    assert.ok(
      rows.some((r) => r.kind === 'fixed' && r.key === key),
      key,
    );
  /* The design's closed-company sentence is a server message, so the page must never say it (pages rule 7, U8). */
  assert.equal(messages.has('This company is closed.'), true, 'the control: the design sentence is a server message');
  assert.equal(
    view.homeStateSentence({ companyStatus: 'closed', accessState: 'current' }),
    view.LIFECYCLE_TEXT.closedCompany,
  );
});

test('E6 pages: the home state of every status and access state, and the Export row of the design 4.1 table', () => {
  assert.equal(view.homeStateSentence({ companyStatus: 'active', accessState: 'current' }), null);
  assert.equal(view.homeStateSentence({ companyStatus: 'active', accessState: 'none' }), null);
  assert.equal(
    view.homeStateSentence({ companyStatus: 'suspended', accessState: 'current' }),
    view.LIFECYCLE_TEXT.homeSuspended,
  );
  assert.equal(
    view.homeStateSentence({ companyStatus: 'active', accessState: 'export_window' }),
    view.LIFECYCLE_TEXT.homeExportWindow,
  );
  assert.equal(
    view.homeStateSentence({ companyStatus: 'suspended', accessState: 'export_window' }),
    view.LIFECYCLE_TEXT.homeSuspended,
  );
  for (const companyStatus of ['active', 'suspended'])
    assert.equal(
      view.homeStateSentence({ companyStatus, accessState: 'expired' }),
      view.LIFECYCLE_TEXT.homeExpired,
      companyStatus,
    );
  assert.equal(
    view.homeStateSentence({ companyStatus: 'closed', accessState: 'expired' }),
    view.LIFECYCLE_TEXT.closedCompany,
  );
  const admin = { roles: ['company_admin', 'member'], companyStatus: 'suspended', accessState: 'current' };
  assert.equal(view.mayTakeCopy(admin, 'aal2'), true, 'a suspended company inside its window: design E6D-C-F16');
  assert.equal(view.mayTakeCopy(admin, 'aal1'), false, 'aal1');
  assert.equal(view.mayTakeCopy({ ...admin, roles: ['member'] }, 'aal2'), false, 'not an administrator');
  assert.equal(view.mayTakeCopy({ ...admin, accessState: 'expired' }, 'aal2'), false, 'past export_by');
  assert.equal(view.mayTakeCopy({ ...admin, companyStatus: 'closed' }, 'aal2'), false, 'closed');
  assert.equal(view.mayTakeCopy({ ...admin, companyStatus: 'active', accessState: 'export_window' }, 'aal2'), true);

  /* E6PW-R-F1 (design 1.5 over 4.1's table): an active company in its export window still serves its reads, so the
     home page keeps its read links on the row; a suspended company in the same window, an expired one and a closed one
     do not. The regression: the rule was absent and the home page carried no link at all. (The one-membership forward
     is NOT extended to the window: B3-R-F1.) */
  assert.equal(
    view.readsStillServed({ companyStatus: 'active', accessState: 'export_window' }),
    true,
    'active, in the window',
  );
  assert.equal(
    view.readsStillServed({ companyStatus: 'suspended', accessState: 'export_window' }),
    false,
    'suspended in the window',
  );
  assert.equal(view.readsStillServed({ companyStatus: 'active', accessState: 'expired' }), false, 'past export_by');
  assert.equal(view.readsStillServed({ companyStatus: 'closed', accessState: 'export_window' }), false, 'closed');
  assert.equal(
    view.readsStillServed({ companyStatus: 'active', accessState: 'current' }),
    false,
    'a working company is not a window',
  );
  assert.equal(view.readsStillServed(undefined), false, 'no membership');
  assert.equal(
    view.isInactiveMembership({ companyStatus: 'active', accessState: 'export_window' }),
    true,
    'still listed as inactive: the sentence shows',
  );
  /* E6P-F10: the suspended sentence no longer contradicts the Export control beneath it. */
  assert.match(view.LIFECYCLE_TEXT.homeSuspended, /an administrator can still take a copy with Export\.$/);
});

test('HB-F2: the failure view shows when an exhausted account may try again, and offers no Retry', async () => {
  const shell = await import(`${APP}/shell.mjs`);
  let retried = 0;
  const view = (retryAfter) =>
    shell.failureView(
      {
        ok: false,
        status: 429,
        code: 'E_MFA_ATTEMPTS_EXHAUSTED',
        message: messageFor('E_MFA_ATTEMPTS_EXHAUSTED'),
        action: 'message',
        retryAfter,
      },
      { retry: () => retried++ },
    );
  const box = view('2026-10-24T10:15:00.000Z');
  assert.ok(box.textContent.includes(`${shell.RETRY_AFTER_LABEL}2026-10-24 10:15 UTC.`), box.textContent);
  assert.equal(
    [...walk(box)].some((n) => n.getAttribute?.('data-role') === 'retry'),
    false,
    'no Retry button',
  );
  /* HBF2-R-F2: a window's end between whole minutes is shown as the NEXT minute, never the one before it, which
     would name a time that is still refused; across an hour and a day too. */
  for (const [at, shown] of [
    ['2026-10-24T10:15:42.517Z', '2026-10-24 10:16'],
    ['2026-10-24T10:15:00.001Z', '2026-10-24 10:16'],
    ['2026-10-24T23:59:30.000Z', '2026-10-25 00:00'],
  ])
    assert.ok(view(at).textContent.includes(`${shell.RETRY_AFTER_LABEL}${shown} UTC.`), at);
});

test('ENA-7: a code-only link says it signs nobody in, and never tells the operator they hold a first factor', () => {
  const acceptUrl = `http://127.0.0.1:1/accept#invite=${'b'.repeat(64)}`;
  for (const operator of [true, false]) {
    const block = view.acceptLinkBlock({ delivery: 'handover', acceptUrl, signsIn: false }, { id: 'code-1', operator });
    const text = block.textContent;
    assert.ok(text.includes(view.LIFECYCLE_TEXT.acceptCodeWhat), 'the code-only sentence');
    assert.equal(text.includes(view.LIFECYCLE_TEXT.acceptLinkWhat), false, 'not the signing-link sentence');
    assert.equal(text.includes(view.LIFECYCLE_TEXT.acceptLinkOperator), false, 'no first factor is held');
    assert.equal(block.getAttribute('data-signs-in'), 'false');
    assert.equal([...walk(block)].find((n) => n.tagName === 'INPUT').value, acceptUrl);
  }
  /* An answer without the field reads as a signing link: the cautious text, which is what every answer said before. */
  const legacy = view.acceptLinkBlock({ delivery: 'handover', acceptUrl }, { id: 'code-2' });
  assert.equal(legacy.getAttribute('data-signs-in'), 'true');
  assert.ok(legacy.textContent.includes(view.LIFECYCLE_TEXT.acceptLinkWhat));
});

test('ENA-7, CR-Q114-1: the invite form’s note is left out beside a code-only link, and the members page draws it from the view', () => {
  const acceptUrl = `http://127.0.0.1:1/accept#invite=${'b'.repeat(64)}`;
  assert.equal(
    view.inviteLinkNote({ delivery: 'handover', acceptUrl, signsIn: false }),
    null,
    'beside a code-only link',
  );
  for (const answer of [
    null,
    { delivery: 'handover', acceptUrl, signsIn: true },
    { delivery: 'handover', acceptUrl },
    { delivery: 'mail' },
  ]) {
    const note = view.inviteLinkNote(answer);
    assert.equal(note?.textContent, view.LIFECYCLE_TEXT.inviteLinkNote, JSON.stringify(answer));
    assert.equal(note.getAttribute('data-role'), 'invite-link-note');
  }
  /* "can": since ENA-7 a link signs in only for an unclaimed account, so the note may not say every link does. */
  assert.equal(view.LIFECYCLE_TEXT.inviteLinkNote.includes('signs its holder in'), false);
  /* Read as code, comments removed, and the call matched in its place under the section's heading (CR-F4): a call kept
     only in a comment, or a note drawn for another answer, fails here. */
  const page = readFileSync(new URL('web/assets/app/pages/members.mjs', REPO), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(page.includes('signs its holder in'), false, 'the page writes no sentence of its own about the link');
  assert.match(
    page,
    /el\('h2', \{\}, 'Invite someone'\),\s*inviteLinkNote\(handover\),/,
    'the note is chosen by the answer on the page',
  );
});

test('E6 pages: the accept link is a read-only input’s value and never an a element or a URL attribute (design 4.3)', () => {
  const acceptUrl = `http://127.0.0.1:1/accept#token_hash=${'a'.repeat(56)}&type=magiclink&invite=${'b'.repeat(64)}`;
  const block = view.acceptLinkBlock({ delivery: 'handover', acceptUrl }, { id: 'link-1', operator: true });
  const nodes = [...walk(block)];
  const inputs = nodes.filter((n) => n.tagName === 'INPUT');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].readOnly, true, 'read-only');
  assert.equal(inputs[0].value, acceptUrl, 'the value is the link, as property and not as attribute');
  assert.equal(inputs[0].getAttribute('value'), null, 'no value attribute carries it into markup');
  assert.equal(inputs[0].getAttribute('data-role'), 'accept-link');
  assert.equal(nodes.filter((n) => n.tagName === 'A').length, 0, 'no a element at all');
  for (const n of nodes) {
    for (const [name, value] of n.attributes ?? new Map())
      assert.equal(value.includes('token_hash'), false, `${n.tagName} ${name} carries the link`);
    assert.equal(n.href, undefined, `${n.tagName} has an href`);
  }
  const text = block.textContent;
  assert.equal(text.includes('token_hash'), false, 'the link is not in the text of the page either');
  assert.ok(text.includes(view.LIFECYCLE_TEXT.acceptLinkWhat) && text.includes(view.LIFECYCLE_TEXT.acceptLinkOperator));
  assert.ok(text.includes(view.LIFECYCLE_TEXT.acceptLinkOnceOperator));
  const admin = view.acceptLinkBlock({ delivery: 'handover', acceptUrl }, { id: 'link-2' });
  assert.ok(
    admin.textContent.includes(view.LIFECYCLE_TEXT.acceptLinkOnceAdmin),
    'an administrator is told about Resend',
  );
  assert.equal(
    admin.textContent.includes(view.LIFECYCLE_TEXT.acceptLinkOperator),
    false,
    'and not that Phaeacia holds it',
  );
  const mailed = view.acceptLinkBlock({ delivery: 'mail' }, { id: 'link-3' });
  assert.equal(mailed.textContent, view.LIFECYCLE_TEXT.acceptLinkMailed, 'mail mode: the one sentence and no field');
  assert.equal(
    [...walk(mailed)].some((n) => n.tagName === 'INPUT'),
    false,
  );
});

test('E6 pages: the departure sentences say what stops and what stays for the fullest and the emptiest preview', () => {
  const empty = view.departureSentences({});
  assert.deepEqual(
    empty.stops.map((s) => s.kind),
    ['access'],
  );
  assert.deepEqual(
    empty.stays.map((s) => s.kind),
    ['membership', 'history', 'account', 'reactivation'],
  );
  const full = view.departureSentences({
    isLastAdmin: true,
    soleHolderOfRoles: ['it_reviewer'],
    groups: [{ groupId: 'g', name: 'Finance' }],
    ownedAgents: [{ agentId: AGENT, name: 'weekly-brief', status: 'active', currentReleases: 2, recipients: 7 }],
    drafts: 3,
    submittedAwaitingReview: 1,
    envelopesAwaitingARoleTheyHold: 2,
    authorizations: 12,
    publishedReleases: 5,
  });
  assert.deepEqual(
    full.stops.map((s) => s.kind),
    [
      'access',
      'last_admin',
      'owned_agents',
      'agent_releases',
      'agent_recipients',
      'sole_reviewer_roles',
      'envelopes_waiting',
      'groups',
      'drafts',
    ],
  );
  assert.ok(full.stops.find((s) => s.kind === 'agent_releases').text.startsWith('2 current releases'));
  assert.ok(full.stops.find((s) => s.kind === 'sole_reviewer_roles').text.includes('IT reviewer'));
  assert.deepEqual(
    full.stays.map((s) => s.kind),
    ['membership', 'history', 'authorizations', 'submitted', 'published', 'account', 'reactivation'],
  );
});

test('E6 pages: the dates are read in UTC, and a sentence never goes silent on a state it does not know', () => {
  assert.equal(view.dayText('2026-12-10T00:00:00Z'), '10 December 2026');
  assert.equal(view.dayText('2026-12-09T23:30:00-01:00'), '10 December 2026', 'the UTC day, not the local one');
  assert.equal(view.dayText(null), null);
  assert.equal(view.dayText('not a date'), null);
  const period = { endsAt: '2026-11-26T00:00:00Z', exportBy: '2026-12-10T00:00:00Z', deleteBy: '2027-01-09T00:00:00Z' };
  assert.equal(
    view.accessSentence({ ...period, state: 'current' }),
    'The agreement runs until 26 November 2026. Reading and exporting stop on 10 December 2026.',
  );
  assert.equal(
    view.deletionSentence({ ...period, state: 'expired', deletionState: 'eligible' }),
    'Deletion has been possible since 10 December 2026 and is due by 9 January 2027.',
  );
  assert.equal(
    view.deletionSentence({ ...period, state: 'expired', deletionState: 'overdue' }),
    'Deletion was due on 9 January 2027.',
  );
  assert.equal(view.accessSentence({ state: 'none' }), view.LIFECYCLE_TEXT.noPeriod);
  assert.ok(view.accessSentence({ ...period, state: 'a_state_added_later' }).length > 0);
  assert.ok(view.deletionSentence({ ...period, state: 'current', deletionState: 'a_state_added_later' }).length > 0);
});

test('E6 pages: the saved copy is the answer without its ok flag, and its name is made only of safe parts', () => {
  const data = {
    ok: true,
    exportedAt: '2026-09-18T10:00:00Z',
    schemaVersion: 1,
    company: { slug: 'x' },
    sections: {},
    counts: {},
    withheld: {},
    omitted: [],
  };
  const text = view.takeoutText(data);
  assert.deepEqual(JSON.parse(text), {
    exportedAt: '2026-09-18T10:00:00Z',
    schemaVersion: 1,
    company: { slug: 'x' },
    sections: {},
    counts: {},
    withheld: {},
    omitted: [],
  });
  const safe = (v) =>
    String(v)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .slice(0, 40);
  assert.equal(view.takeoutFileName(safe, 'acme-gmbh', '2026-09-18T10:00:00Z'), 'acme-gmbh-records-2026-09-18.json');
  assert.equal(view.takeoutFileName(safe, '../../etc/passwd', '../x'), '-etc-passwd-records--x.json');
  assert.deepEqual(view.withheldSentences({}), [view.LIFECYCLE_TEXT.takeoutNothingWithheld]);
  assert.deepEqual(view.withheldSentences({ candidate_versions: { rows: 2, reason: 'another_author_draft' } }), [
    '2 rows of candidate_versions were left out: an unsubmitted draft is readable by its author alone.',
  ]);
});

test('E6 api: every E6 caller sends the rule 2 shape with no Idempotency-Key, and the resend sends no body', async () => {
  const api = await freshApi();
  const ok = () => json(200, { ok: true });
  const log = service({
    'GET /api/operator/companies': ok,
    [`GET /api/operator/companies?cursor=${COMPANY}`]: ok,
    'POST /api/operator/companies': ok,
    [`GET /api/operator/companies/${COMPANY}/takeout-manifest`]: ok,
    [`POST /api/operator/companies/${COMPANY}/status`]: ok,
    [`POST /api/operator/companies/${COMPANY}/access-period`]: ok,
    [`POST /api/operator/companies/${COMPANY}/quotas`]: ok,
    [`POST /api/operator/companies/${COMPANY}/admin-invitation`]: ok,
    [`POST /api/operator/companies/${COMPANY}/transfer-first-admin`]: ok,
    [`POST /api/operator/companies/${COMPANY}/close`]: ok,
    [`POST /api/operator/companies/${COMPANY}/delete`]: ok,
    'POST /api/operator/expiry-run': ok,
    [`POST /api/companies/${COMPANY}/invitations/${MEMBER}/resend`]: ok,
    [`GET /api/companies/${COMPANY}/members/${MEMBER}/departure`]: ok,
    [`POST /api/agents/${AGENT}/transfer`]: ok,
    [`GET /api/companies/${COMPANY}/quotas`]: ok,
    [`GET /api/companies/${COMPANY}/takeout`]: ok,
  });
  await api.operatorCompanies();
  await api.operatorCompanies(COMPANY);
  await api.createCompany({
    slug: 's',
    name: 'n',
    firstAdminEmail: 'e',
    expiresInDays: 7,
    startsAt: 'a',
    endsAt: 'b',
    invoiceRef: null,
  });
  await api.takeoutManifest(COMPANY);
  await api.setCompanyStatus(COMPANY, { status: 'suspended', reasonCode: 'customer_request' });
  await api.setAccessPeriod(COMPANY, { startsAt: 'a', endsAt: 'b', invoiceRef: 'i' });
  await api.setCompanyQuota(COMPANY, { name: 'members_per_company', value: 30 });
  await api.inviteAdministrator(COMPANY, { email: 'e', expiresInDays: 7 });
  await api.grantAdministrator(COMPANY, MEMBER);
  await api.closeCompany(COMPANY, { confirmSlug: 's', reasonCode: 'customer_instruction' });
  await api.deleteCompany(COMPANY, { confirmSlug: 's', reasonCode: 'retention_deadline' });
  await api.expiryRun();
  await api.resendInvitation(COMPANY, MEMBER);
  await api.departure(COMPANY, MEMBER);
  await api.transferAgent(AGENT, { toMembershipId: MEMBER, expectedOwnerMembershipId: COMPANY });
  await api.quotas(COMPANY);
  await api.takeout(COMPANY);
  assert.equal(log.length, 17);
  for (const { key, init } of log) {
    assert.equal(init.credentials, 'same-origin', key);
    assert.equal(init.cache, 'no-store', key);
    assert.equal(init.redirect, 'error', key);
    assert.equal(Object.hasOwn(init.headers, 'idempotency-key'), false, `${key}: no E6 route takes a key (design 3.3)`);
    const bodied = key.startsWith('POST') && !key.endsWith('/resend');
    assert.equal(typeof init.body === 'string', bodied, `${key}: a body only where the route reads one`);
    assert.equal(init.headers['content-type'] === 'application/json', bodied, key);
  }
  assert.deepEqual(JSON.parse(log.find((e) => e.key.endsWith('/transfer')).init.body), {
    toMembershipId: MEMBER,
    expectedOwnerMembershipId: COMPANY,
  });
  assert.deepEqual(JSON.parse(log.find((e) => e.key === 'POST /api/operator/expiry-run').init.body), {});
});

test('E6 api: an operator at aal1 is routed to /mfa/ by the answer, and E_NOT_OPERATOR shows its message', async () => {
  const api = await freshApi();
  assert.equal(api.actionFor('E_OPERATOR_MFA_REQUIRED'), 'mfa', 'design 4.1: the refusal routes the operator page');
  assert.equal(api.actionFor('E_NOT_OPERATOR'), 'message', 'the page renders it as its not-found state itself');
  const log = service({
    'GET /api/operator/companies': () =>
      json(403, { ok: false, code: 'E_OPERATOR_MFA_REQUIRED', message: messageFor('E_OPERATOR_MFA_REQUIRED') }),
  });
  const r = await api.operatorCompanies();
  assert.equal(r.ok, false);
  assert.equal(r.action, 'mfa');
  assert.equal(r.message, messageFor('E_OPERATOR_MFA_REQUIRED'), 'the server sentence, as sent');
  assert.equal(log.length, 1, 'no refresh and no repeat for a 403');
  assert.deepEqual(navigations, [], 'the page decides where to go; api.mjs does not navigate on a 403');
});

test('E6 pages: no web/ file assigns a handover link to an a element (a raw-text tripwire beside the journeys)', () => {
  /* design 4.3's gate line, which scripts/check-web.mjs does not carry: an acceptUrl may reach the DOM only through
     lifecycle-view.mjs's acceptLinkBlock. A second reader of acceptUrl anywhere under web/ fails here. */
  const files = [
    'web/assets/app/lifecycle-view.mjs',
    'web/assets/app/pages/members.mjs',
    'web/assets/app/pages/operator-new.mjs',
    'web/assets/app/pages/operator-company.mjs',
  ];
  for (const rel of files) {
    let text;
    try {
      text = readFileSync(new URL(rel, REPO), 'utf8');
    } catch {
      continue;
    }
    const readers = [...text.matchAll(/\bacceptUrl\b/g)].length;
    if (rel.endsWith('lifecycle-view.mjs')) assert.ok(readers > 0, 'the one reader');
    else assert.equal(readers, 0, `${rel} reads acceptUrl itself; it must hand the answer to acceptLinkBlock`);
  }
});

test('E4P-F8: a member is named for an audience only by a display name, or, for the viewer’s own row, their own name', () => {
  assert.equal(view.namedForAudience({ kind: 'display_name', value: 'Olga' }), true);
  assert.equal(view.namedForAudience({ kind: 'display_name', value: '' }), false);
  assert.equal(
    view.namedForAudience({ kind: 'invitation_email', value: 'a@example.invalid' }),
    false,
    'an address is not a name',
  );
  assert.equal(view.namedForAudience({ kind: 'none' }), false);
  assert.equal(view.namedForAudience(undefined), false, 'a membership the list does not carry');
  assert.equal(view.namedForAudience({ kind: 'self', value: 'me@example.invalid' }, 'Me'), true);
  assert.equal(
    view.namedForAudience({ kind: 'self', value: 'me@example.invalid' }, null),
    false,
    'self carries the address',
  );
  for (const key of ['audienceUnnamed', 'audienceUnnamedSelf'])
    assert.ok(
      view.labelTable().some((r) => r.kind === 'fixed' && r.key === key),
      key,
    );
});
