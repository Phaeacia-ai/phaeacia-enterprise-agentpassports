/* E4 design 4.1's three product rules as web/assets/app/passport-view.mjs builds them, run in Node with a minimal
   document that records elements, attributes and text (U8's method). The losses table renders in every state and a
   state it does not know renders as pending; the needs table carries capability names and never the row's other
   values, with "declared, not installed" for a capability version 0.1 does not install; the content pane holds every
   stored byte as one text node; the boundary sentence is design 4.1's text byte for byte; the envelope card shows each
   approval's reviewer and reason, the policy when it went stale and the assembled size beside its bound. The wording
   the renderer owns is compared with lib/passport/render.mjs, so the two cannot drift apart. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DECLARED_NOT_INSTALLED, LOSSES_DECLARED_LABEL, LOSSES_PENDING } from '../../../lib/passport/render.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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

const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define('document', {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => new FakeText(text),
  getElementById: (id) => new FakeElement(id),
});
define('location', { hash: '', pathname: '/review/', search: '', assign: () => undefined });
define('history', { replaceState: () => undefined });
define('addEventListener', () => undefined);

const view = await import('../../../web/assets/app/passport-view.mjs');

const all = (node, predicate, out = []) => {
  for (const child of node.children) {
    if (predicate(child)) out.push(child);
    all(child, predicate, out);
  }
  return out;
};
const byRole = (node, role) => all(node, (c) => c.getAttribute('data-role') === role);
const byTag = (node, tag) => all(node, (c) => c.tagName === tag.toUpperCase());

test('packet view: the wording the renderer owns is the renderer’s, and the boundary is the documented sentence byte for byte', () => {
  assert.equal(view.DECLARED_NOT_INSTALLED, DECLARED_NOT_INSTALLED);
  assert.equal(view.LOSSES_PENDING, LOSSES_PENDING);
  assert.equal(view.LOSSES_DECLARED_LABEL, LOSSES_DECLARED_LABEL);
  const design = readFileSync(join(REPO, 'docs', 'architecture.md'), 'utf8');
  const quoted = /never collapsible:\*\* "([^"]+)"/.exec(design.replace(/\s+/g, ' '));
  assert.ok(quoted, 'docs/architecture.md states the boundary sentence');
  assert.equal(view.BOUNDARY, quoted[1]);
});

test('packet view: the losses table renders in every state; a pending or unknown state is the one pending row', () => {
  for (const losses of [
    { state: 'pending', rows: [] },
    { state: 'declared', rows: [] },
    { state: 'reported', rows: [{ what: 'a', status: 'lost', meaning: 'b' }] },
    { state: 'anything else' },
    undefined,
    null,
  ]) {
    const node = view.lossesTable(losses);
    const label = JSON.stringify(losses);
    assert.equal(node.getAttribute('data-losses'), 'pending', label);
    const tables = byRole(node, 'losses-table');
    assert.equal(tables.length, 1, `${label}: a table`);
    const cells = byTag(tables[0], 'td');
    assert.equal(cells.length, 1, `${label}: one row`);
    assert.equal(cells[0].textContent, LOSSES_PENDING, label);
    assert.equal(cells[0].colSpan, 3, `${label}: across the three columns`);
    assert.doesNotMatch(node.textContent.toLowerCase(), /no loss|nothing was lost/, label);
  }
});

test('packet view: declared losses render every row in order under the declared label', () => {
  const rows = [
    { what: 'Label colour hints', status: 'lost', meaning: 'The copy prints plain text' },
    { what: 'Twenty-record ceiling', status: 'substituted', meaning: 'The copy stops at twenty' },
  ];
  const node = view.lossesTable({ state: 'declared', rows });
  assert.equal(node.getAttribute('data-losses'), 'declared');
  assert.equal(byRole(node, 'losses-label')[0].textContent, LOSSES_DECLARED_LABEL);
  const bodyRows = byTag(byTag(node, 'tbody')[0], 'tr');
  assert.deepEqual(
    bodyRows.map((tr) => byTag(tr, 'td').map((td) => td.textContent)),
    rows.map((r) => [r.what, r.status, r.meaning]),
  );
  assert.ok(
    byTag(node, 'td').every((td) => byTag(td, 'bdi').length === 1),
    'each owner-written cell is isolated',
  );
});

test('packet view: the needs table shows capability names, required and installation, and no other value of the row', () => {
  const needs = [
    {
      capability: 'Reply in this conversation',
      why: 'Show the sorted records',
      required: true,
      required_label: 'Required',
      if_skipped: 'No result is displayed',
      installable: true,
      installable_label: 'yes',
    },
    {
      capability: 'Pay the sorting fee (money.transfer)',
      why: 'The original paid a per-batch fee itself',
      required: false,
      required_label: 'declared only',
      if_skipped: 'You pay nothing',
      installable: false,
      installable_label: 'no, declared only',
      ref: 'money.transfer',
    },
  ];
  const node = view.needsTable(needs);
  const rows = byTag(byTag(node, 'tbody')[0], 'tr');
  assert.deepEqual(
    rows.map((tr) => [tr.getAttribute('data-installable'), ...byTag(tr, 'td').map((td) => td.textContent)]),
    [
      ['yes', 'Reply in this conversation', 'Required', 'installable'],
      ['no', 'Pay the sorting fee (money.transfer)', 'Optional', DECLARED_NOT_INSTALLED],
    ],
  );
  for (const value of [
    'Show the sorted records',
    'No result is displayed',
    'per-batch fee',
    'You pay nothing',
    'no, declared only',
  ])
    assert.equal(node.textContent.includes(value), false, `${value} is not shown in the needs table`);
});

test('packet view: the content pane is a pre holding every stored byte as one text node, markup included as text', () => {
  const content =
    '---\ntitle: <b>x</b>\n---\n\n## 5. Installer\n\n<!-- installer core and branches inserted on upload -->\n\n## 6. Losses\n';
  const node = view.contentPane(content);
  const pane = byRole(node, 'content')[0];
  assert.equal(pane.tagName, 'PRE');
  assert.equal(pane.children.length, 0, 'no element inside the pane');
  assert.equal(pane.childNodes.length, 1);
  assert.equal(pane.textContent, content);
  assert.equal(pane.getAttribute('tabindex'), '0');
});

test('packet view: the envelope card names reviewers with their reasons, a stale policy, and the size beside its bound', () => {
  const labels = new Map([
    ['m-it', { kind: 'display_name', value: 'Ada' }],
    ['m-self', { kind: 'self', value: 'me@example.invalid' }],
  ]);
  const envelope = {
    envelopeId: 'e1',
    revision: 2,
    target: 'claude-ai',
    status: 'open',
    audience: { groupIds: ['g1', 'g-unknown'] },
    policy: { version: 1, policyStatus: 'stale' },
    gate: { gateStatus: 'current' },
    assembledBytes: 64621,
    approvals: {
      it: { reviewId: 'r1', reviewerMembershipId: 'm-it', createdAt: '2026-09-15T09:12:03.114Z' },
      business: null,
    },
    changeRequest: null,
    createdByMembershipId: 'm-self',
    createdAt: '2026-09-15T09:00:00.000Z',
  };
  const node = view.envelopeCard(envelope, {
    labels,
    groupsById: new Map([['g1', { name: 'Finance', memberCount: 7 }]]),
    reviewsById: new Map([['r1', { reason: 'Reads internal reports only.' }]]),
    releases: [],
  });
  const text = node.textContent;
  assert.ok(text.includes('claude.ai, revision 2'));
  assert.ok(text.includes('Finance (7 members), a group this page cannot list'));
  assert.equal(byRole(node, 'policy-stale').length, 1);
  assert.equal(byRole(node, 'gate-stale').length, 0);
  assert.ok(text.includes('64,621 bytes of the 393,216-byte bound'));
  const approvals = byRole(node, 'approvals')[0].children;
  assert.equal(approvals[0].getAttribute('data-state'), 'approved');
  assert.ok(approvals[0].textContent.startsWith('IT: approved by Ada on 2026-09-15'));
  assert.equal(byRole(approvals[0], 'reason')[0].textContent, 'Reads internal reports only.');
  assert.equal(approvals[1].textContent, 'Business: not approved yet');
  assert.ok(text.includes('me@example.invalid (you)'));
});

test('packet view: member labels say what the list carried and nothing more', () => {
  const labels = new Map([
    ['a', { kind: 'display_name', value: 'Ada' }],
    ['b', { kind: 'none' }],
    ['c', { kind: 'invitation_email', value: 'c@example.invalid' }],
  ]);
  assert.equal(view.memberLabel(labels, 'a').textContent, 'Ada');
  assert.equal(view.memberLabel(labels, 'b').textContent, 'a member with no name set');
  assert.equal(view.memberLabel(labels, 'c').textContent, 'c@example.invalid');
  assert.equal(view.memberLabel(labels, 'z').textContent, 'a member this page cannot name');
});
