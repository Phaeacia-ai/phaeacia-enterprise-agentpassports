/* The shared page chrome of UI updates (board EP-14, evidence/ui-updates.md), run in Node with an injected document and
   location (the method of web-operator-landing.test.mjs, in a file of its own so its globals are not shared). The
   layout rules (U1, U4) and the operator landing (U5) are observed in a browser by journeys OL-1 to OL-3; what is
   decided in shell.mjs is pinned here.

   U2. The header's account link is a person icon: an a element to /account/ whose one child is an empty, hidden span
       the stylesheet draws; the signed-in address is its accessible name and its tooltip, as attribute text, and
       appears nowhere in the header's text; on /account/ the link is marked current. The operator navigation holds
       Companies and New company, and no Account entry.

   U3. The header's Sign out is the button alone, with no note beside it; pressing it opens a modal dialog and sends
       nothing, with focus on Cancel (PEER-5). The dialog's Sign out runs the page's onSignOut once and closes; Cancel, and a close without a choice
       (what Escape does), send nothing; every close returns focus to the header's button. The failure view's own
       sign-out stays a direct action with no dialog.

   U6. The account page's own "Sign out of this device" asks through the same dialog: shell.mjs askingSignOut, which
       the header also calls, names a caller's dialog, buttons and question by the caller's role, so the account page's
       pair and the header's are each their own on one page (the account page itself is observed by JF3). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

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
    this.listeners = new Map();
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
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  /* A click runs the element's click listeners to their end, as the button helper's awaited handler needs. */
  async click() {
    for (const listener of this.listeners.get('click') ?? []) await listener({ type: 'click' });
  }
  /* The dialog's part of the element API, recording what the page asked of it. */
  showModal() {
    if (this.open) throw new Error('showModal on an open dialog');
    this.open = true;
    events.push('showModal');
  }
  close() {
    if (!this.open) return;
    this.open = false;
    events.push('close');
    for (const listener of this.listeners.get('close') ?? []) listener({ type: 'close' });
  }
  focus() {
    events.push(`focus ${this.getAttribute('data-role')}`);
  }
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

const events = [];
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define('location', { hash: '', pathname: '/', search: '', assign: () => undefined });
define('history', { replaceState: () => undefined });
define('document', {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => new FakeText(text),
  getElementById: (id) => new FakeElement(id),
});
define('addEventListener', () => undefined);

const shell = await import('../../../web/assets/app/shell.mjs');

function* walk(node) {
  yield node;
  for (const c of node.childNodes ?? []) if (c instanceof FakeElement) yield* walk(c);
}
const byRole = (root, role) => [...walk(root)].filter((n) => n.getAttribute('data-role') === role);
const EMAIL = 'person@example.invalid';
const header = (options = {}) => {
  const h = new FakeElement('header');
  shell.renderHeader(h, { email: EMAIL, onSignOut: () => undefined, ...options });
  return h;
};

test('U2: the account link is a person icon to /account/, named by the address as attribute text only', () => {
  for (const email of [EMAIL, '<b>x</b>‮@example.invalid']) {
    for (const operator of [false, true]) {
      const h = header({ email, operator });
      const links = byRole(h, 'account-link');
      assert.equal(links.length, 1, 'one account link');
      const a = links[0];
      assert.equal(a.tagName, 'A');
      assert.equal(a.href, '/account/');
      assert.equal(a.getAttribute('class'), 'account');
      assert.equal(a.getAttribute('aria-label'), `Account, ${email}`);
      assert.equal(a.title, `Account, ${email}`, 'the tooltip names the address');
      assert.deepEqual(
        a.childNodes.map((c) => [
          c.tagName,
          c.getAttribute('class'),
          c.getAttribute('aria-hidden'),
          c.childNodes.length,
        ]),
        [['SPAN', 'user-icon', 'true', 0]],
        'the link holds the empty icon span and nothing else',
      );
      assert.equal(h.textContent.includes(email), false, 'the address is not in the header text');
      assert.equal(a.getAttribute('aria-current'), null, 'not current away from /account/');
    }
  }
  location.pathname = '/account/';
  assert.equal(byRole(header(), 'account-link')[0].getAttribute('aria-current'), 'page', 'current on /account/');
  location.pathname = '/';
});

test('U2: the operator navigation holds Companies and New company, and no Account entry', () => {
  for (const path of ['/operator/', '/operator/new/', '/account/', '/mfa/']) {
    location.pathname = path;
    const nav = byRole(header({ operator: true }), 'operator-nav')[0];
    assert.deepEqual(
      nav.children.map((n) => n.getAttribute('data-role')),
      ['nav-companies', 'nav-new-company'],
      path,
    );
  }
  location.pathname = '/';
});

const signOutHeader = () => {
  const calls = [];
  const h = header({
    onSignOut: async () => {
      calls.push('onSignOut');
    },
  });
  const one = (role) => {
    const found = byRole(h, role);
    assert.equal(found.length, 1, role);
    return found[0];
  };
  return { h, calls, one };
};

test('U3: the header shows Sign out alone, and its dialog asks once with Sign out and Cancel', () => {
  const { h, one } = signOutHeader();
  const opener = one('sign-out');
  const dialog = one('sign-out-dialog');
  assert.equal(opener.tagName, 'BUTTON');
  assert.equal(opener.textContent, 'Sign out');
  assert.equal(h.textContent.includes('Signs out this device only.'), false, 'the note left the header');
  assert.deepEqual(
    [...walk(h)].find((n) => n.children.includes(opener)).children.map((n) => n.tagName),
    ['BUTTON', 'DIALOG'],
    'the sign-out control is the button and its dialog',
  );
  assert.equal(dialog.getAttribute('aria-labelledby'), 'sign-out-question');
  assert.deepEqual(
    [...walk(dialog)].filter((n) => n.tagName === 'P').map((n) => [n.getAttribute('id'), n.textContent]),
    [['sign-out-question', 'Sign out of this device? Other devices stay signed in.']],
  );
  assert.deepEqual(
    [...walk(dialog)].filter((n) => n.tagName === 'BUTTON').map((n) => [n.getAttribute('data-role'), n.textContent]),
    [
      ['sign-out-confirm', 'Sign out'],
      ['sign-out-cancel', 'Cancel'],
    ],
  );
  assert.deepEqual(
    [one('sign-out-confirm').autofocus ?? false, one('sign-out-cancel').autofocus],
    [false, true],
    'the dialog opens with focus on Cancel (PEER-5)',
  );
});

test('U3: opening, Cancel and a close without a choice send nothing and return focus; the dialog Sign out signs out once', async () => {
  const { calls, one } = signOutHeader();
  const [opener, dialog] = [one('sign-out'), one('sign-out-dialog')];
  events.length = 0;
  await opener.click();
  assert.deepEqual([events.splice(0), calls], [['showModal'], []], 'the header button only opens the dialog');
  await one('sign-out-cancel').click();
  assert.deepEqual(
    [events.splice(0), calls],
    [['close', 'focus sign-out'], []],
    'Cancel closes, sends nothing, returns focus',
  );
  await opener.click();
  dialog.close();
  assert.deepEqual(
    [events.splice(0), calls],
    [['showModal', 'close', 'focus sign-out'], []],
    'Escape (a close) sends nothing',
  );
  await opener.click();
  await one('sign-out-confirm').click();
  assert.deepEqual(
    [events.splice(0), calls],
    [['showModal', 'close', 'focus sign-out'], ['onSignOut']],
    'confirm signs out once',
  );
  assert.equal(dialog.open, false);
});

test("U3: the failure view's sign-out (E_EMAIL_MISMATCH's recovery) stays a direct action with no dialog", async () => {
  const calls = [];
  const view = shell.failureView(
    { action: 'sign-out', code: 'E_EMAIL_MISMATCH', message: 'A message.' },
    {
      signOut: async () => {
        calls.push('signOut');
      },
    },
  );
  assert.equal(byRole(view, 'sign-out-dialog').length, 0);
  events.length = 0;
  await byRole(view, 'mismatch-sign-out')[0].click();
  assert.deepEqual([events, calls], [[], ['signOut']]);
});

test("U6: askingSignOut gives the account page's button its own dialog, asking as the header's does", async () => {
  const calls = [];
  const [opener, dialog] = shell.askingSignOut(
    async () => {
      calls.push('onSignOut');
    },
    'Sign out of this device',
    { role: 'sign-out-account', className: 'secondary' },
  );
  const roleIn = (role) => byRole(dialog, role)[0];
  assert.deepEqual(
    [opener.tagName, opener.textContent, opener.getAttribute('class'), opener.getAttribute('data-role')],
    ['BUTTON', 'Sign out of this device', 'secondary', 'sign-out-account'],
  );
  assert.deepEqual(
    [dialog.tagName, dialog.getAttribute('data-role'), dialog.getAttribute('aria-labelledby')],
    ['DIALOG', 'sign-out-account-dialog', 'sign-out-account-question'],
  );
  assert.deepEqual(
    [...walk(dialog)].filter((n) => n.tagName === 'P').map((n) => [n.getAttribute('id'), n.textContent]),
    [['sign-out-account-question', 'Sign out of this device? Other devices stay signed in.']],
  );
  assert.equal(roleIn('sign-out-account-cancel').autofocus, true, 'opens on Cancel');
  const headerIds = [...walk(header())].map((n) => n.getAttribute('id')).filter(Boolean);
  assert.deepEqual(headerIds, ['sign-out-question'], "the header's question id is not the account page's");
  events.length = 0;
  await opener.click();
  await roleIn('sign-out-account-cancel').click();
  await opener.click();
  await roleIn('sign-out-account-confirm').click();
  assert.deepEqual(
    [events, calls],
    [['showModal', 'close', 'focus sign-out-account', 'showModal', 'close', 'focus sign-out-account'], ['onSignOut']],
    'opening and Cancel send nothing; the dialog Sign out signs out once; focus returns to the button',
  );
});

/* K2 (evidence/hardening-k.md; XR-12): an E_INTERNAL failure shows its request id under the message as text, after the
   page's own label, for the person to quote; no other code shows one, and an E_INTERNAL answer without one shows none. */
test("K2: the failure view shows an E_INTERNAL answer's request id as text, and nothing for any other answer", () => {
  const ID = '01JAB2CD3EF4GH5JK6MN7PQ8RS';
  const view = shell.failureView(
    { action: 'retry', code: 'E_INTERNAL', message: 'A message.', requestId: ID },
    { retry: () => undefined },
  );
  const shown = byRole(view, 'request-id');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].tagName, 'P');
  assert.equal(shown[0].textContent, `${shell.REFERENCE_LABEL}${ID}`);
  assert.equal(
    shown[0].childNodes.every((c) => c instanceof FakeText),
    true,
    'text nodes only',
  );
  assert.deepEqual(
    [...walk(view)].filter((n) => n.tagName === 'P').map((n) => n.textContent),
    ['A message.', `${shell.REFERENCE_LABEL}${ID}`],
    'the message first, unchanged',
  );
  for (const other of [
    { action: 'retry', code: 'E_INTERNAL', message: 'A message.' },
    { action: 'retry', code: 'E_BUSY', message: 'A message.', requestId: ID },
    { action: 'message', code: 'E_FORBIDDEN', message: 'A message.', requestId: ID },
    { action: 'retry', code: null, message: null, network: true, requestId: ID },
  ])
    assert.equal(
      byRole(shell.failureView(other, { retry: () => undefined }), 'request-id').length,
      0,
      JSON.stringify(other),
    );
});
