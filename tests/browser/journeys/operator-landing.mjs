/* The operator landing and the capture prompt's page (HOSTED-F2, HOSTED-F3; evidence/operator-landing.md).

   OL-1  a member reaches Capture an agent (evidence/add-agent.md) from Your agents: a heading and three numbered steps,
         the capture prompt, the upload form and the draft that follows; the prompt on the page is capture/enterprise.md
         byte for byte, compared by SHA-256 with the repository's file; Copy puts exactly that text on the clipboard and
         sends nothing; when the browser refuses the copy the page says so and the prompt is selected in its box;
         nothing of the public page's publishing path is on the page and every link stays on this site; /capture/
         without a company shows the prompt and, in step 2, a sentence and the link home instead of the form. At phone
         width.

   OL-2  an operator's sign-in lands on the register (HOSTED-F2): a fresh operator account with no factor is taken from
         the home page to /mfa/, enrols, and is taken on to /operator/; a second browser of the same account, at aal1
         with a verified factor, is taken to the challenge and then to /operator/; at aal2 the home page moves it to
         /operator/. The home page decides by one register read, sent only when the identity holds no membership: a
         person with no membership who is not an operator reads "No company yet" after a 403 E_NOT_OPERATOR; a lost
         read, and a refusal the page does not know (PC-1), show Retry and never the empty state; a member with a company
         sends no register read and lands on the members page as before. Since UI updates U5 (evidence/ui-updates.md),
         no pass through the home page on the way draws the signed-in header, observed by watchDrawing (common.mjs).

   OL-3  the operator's navigation in the header (item 2): Companies, New company and Account on the register, the create
         page, a company's page, the account page and /mfa/, the page the browser is on shown and not linked, each link
         followed; at aal1 on /mfa/ too; and on no page of a member or of a person who is not an operator. At phone
         width. Since UI updates (evidence/ui-updates.md): the lockup stacked in four kinds of header (U1), the account
         icon with the address as its name and tooltip, followed to /account/ in place of the navigation's former
         Account entry (U2), and the computed corners of the register, the create form, the members page and the
         sign-in page (U4). OL-1 reads the corners of Your agents and the capture page (U4).

   OL-4  the glance at the top of the register (item 3) against the database: with every page of the register read, the
         status sentence is the companies' statuses counted; the soonest list is the five earliest end dates of the
         companies not closed, each with its word and whole UTC days (both computed here, again, from the stored rows);
         what needs the operator names a suspended company, an overdue deletion with its closed reading window, and a
         company whose administrator has not accepted yet with its one open invitation; the table is soonest ending
         first with undated companies last, and the order control gives the service's order back. At phone width.

   OL-2 to OL-4 use operator accounts of their own, registered owner-side as tests/db/00-seed.sh registers the seeded one, so its
   first sign-ins see an account with no factor whatever the E6 journeys did to the seeded operator earlier in a run.

   The starting states other than the ones a journey makes through the pages are made in this process, as the E6
   journeys make theirs (e6-common.mjs): that is the harness setting up, never a page's request. Nothing prints a token,
   a key or a link. */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { e3lib, sql } from '../../e3/stack/helpers.mjs';
import { PHONE } from '../cdp.mjs';
import { ROOT } from '../dev-shell.mjs';
import { currentCode } from '../totp.mjs';
import { apiRequests, BOX, cornerOf, drawnPerDocument, line, lockupShape, PILL, signIn, startSetup, tag, verifySetup, waitPath, watchDrawing } from './common.mjs';
import { loseNextAnswer, routes } from './e4-common.mjs';
import { agePeriod, exists, ok, operatorUser, smallCompany, text } from './e6-common.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/* The repository's prompt, read here and not from the build, so the journey does not inherit a defect of the build. */
const PROMPT = readFileSync(join(ROOT, 'capture', 'enterprise.md'));
const PROMPT_SHA256 = sha256(PROMPT);
const pageSha = async (tab, expression) => {
  const value = await tab.evaluate(expression);
  return typeof value === 'string' ? sha256(Buffer.from(value, 'utf8')) : null;
};

/** The run's capture company, made once: an administrator and a plain member, with agreement dates. */
async function captureWorld(ctx) {
  ctx.state.olCapture ??= await smallCompany(ctx, 'capture');
  return ctx.state.olCapture;
}

export async function ol1(ctx, j) {
  const C = await captureWorld(ctx);
  const member = C.users.member;
  const tab = await signIn(j, member.identity, member.email, { label: 'member' });
  await tab.setViewport(PHONE);
  await waitPath(tab, '/members/', { search: `?company=${C.companyId}` });
  await tab.click('[data-role="company-links"] [data-role="link-drafts"]');
  await waitPath(tab, '/drafts/', { search: `?company=${C.companyId}` });
  await tab.waitForSelector('[data-role="capture-agent"]');
  j.equal(
    "Your agents' toolbar holds one primary control, Capture an agent, for this company, and Reload; the upload and capture prompt links are gone, and the empty list names the control",
    await tab.evaluate(
      `(() => { const t = document.querySelector('main .toolbar'); return { controls: [...t.children].map((c) => [c.tagName, c.dataset.role, c.className, c.textContent, c.getAttribute('href')]), upload: Boolean(document.querySelector('[data-role="upload-link"]')), capture: Boolean(document.querySelector('[data-role="capture-link"]')), how: document.querySelector('[data-state="empty"] .meta')?.textContent ?? null }; })()`,
    ),
    {
      controls: [
        ['A', 'capture-agent', 'button', 'Capture an agent', `/capture/?company=${C.companyId}`],
        ['BUTTON', 'reload', 'secondary', 'Reload', null],
      ],
      upload: false,
      capture: false,
      how: 'Capture an agent, above, gives you the capture prompt for an assistant your company has approved and takes the passport file its interview produces. It stays a private draft until you submit it.',
    },
  );
  j.equal(
    "UI updates U4: Your agents' button-styled link and its button are pills",
    await cornerOf(tab, ['[data-role="capture-agent"]', '[data-role="reload"]']),
    { '[data-role="capture-agent"]': PILL, '[data-role="reload"]': PILL },
  );
  await j.capture(tab, 'drafts-with-capture-agent');

  const atCapture = tab.requests.length;
  await tab.click('[data-role="capture-agent"]');
  await waitPath(tab, '/capture/', { search: `?company=${C.companyId}` });
  await tab.waitForSelector('[data-role="capture-text"]');
  j.equal(
    "the prompt on the page is capture/enterprise.md byte for byte (the SHA-256 of the pane's text against the repository file's)",
    await pageSha(tab, `document.querySelector('[data-role="capture-text"]').value`),
    PROMPT_SHA256,
  );
  j.equal(
    'the prompt is the value of a read-only text area, so nothing of it is rendered and a person cannot change it',
    await tab.evaluate(`(() => { const p = document.querySelector('[data-role="capture-text"]'); return { tag: p.tagName, readOnly: p.readOnly, elements: p.children.length }; })()`),
    { tag: 'TEXTAREA', readOnly: true, elements: 0 },
  );
  j.equal(
    'Capture an agent: its heading and sentence, then three numbered steps in order, the prompt, the upload and the draft that follows',
    await tab.evaluate(
      `({ title: document.title, h1: document.querySelector('main h1').textContent, lead: document.querySelector('main .heading .lead').textContent, steps: [...document.querySelectorAll('[data-role="add-steps"] > li')].map((li) => [li.dataset.role, li.querySelector('.step-number').textContent, li.querySelector('h2').textContent]) })`,
    ),
    {
      title: 'Capture an agent · Phaeacia Enterprise',
      h1: 'Capture an agent',
      lead: 'An interview by your own assistant, one your company has approved, produces one passport file, which you upload here; it stays a private draft that only you can see until you submit it.',
      steps: [
        ['step-prompt', '1', 'Copy the capture prompt'],
        ['step-upload', '2', 'Upload the passport file'],
        ['step-next', '3', 'Check it and submit it for review'],
      ],
    },
  );
  j.equal(
    'step 1 says how to use the prompt, that a folder agent goes the same way for now, and, in the boundary box, that no secret goes into that chat',
    [
      await text(tab, '[data-role="capture-what"] p:nth-of-type(1)'),
      await text(tab, '[data-role="capture-folder"]'),
      await text(tab, '[data-role="step-prompt"] .boundary[data-role="capture-secret"]'),
    ],
    [
      'Paste it into a new chat with that assistant and answer its questions. At the end it gives you the passport as one Markdown file: save it on your computer.',
      'An agent that lives in a folder on your computer is captured the same way for now: paste its instructions into the chat when the interview asks for them.',
      'Never paste a password, key or other secret into that chat, even if the assistant asks for one.',
    ],
  );
  j.equal(
    "step 2 holds the upload form for this company, with the agent name, the text box, the file and Upload and check, and the company's links are drawn",
    await tab.evaluate(
      `(() => { const s = document.querySelector('[data-role="step-upload"]'); return { form: Boolean(s.querySelector('[data-role="upload-form"]')), name: Boolean(s.querySelector('#agent-name')), text: Boolean(s.querySelector('#passport-text')), file: Boolean(s.querySelector('#passport-file')), button: s.querySelector('[data-role="upload"]')?.textContent ?? null, companyLinks: Boolean(document.querySelector('main [data-role="company-links"]')) }; })()`,
    ),
    { form: true, name: true, text: true, file: true, button: 'Upload and check', companyLinks: true },
  );
  j.equal(
    'step 3 is one line on the draft that follows',
    await text(tab, '[data-role="step-next"] p'),
    "Upload and check opens your draft, which only you can see: read the service's preview, edit and save it if you need to, then submit it for review.",
  );
  j.equal(
    "nothing of the public page's publishing path is in the page's own text (the prompt's box aside), and every link stays on this site",
    await tab.evaluate(
      `(() => { const m = document.querySelector('main').cloneNode(true); m.querySelectorAll('textarea').forEach((t) => t.remove()); return { words: (m.textContent.match(/publish|public|gallery|skill|repositor|github|phaeacia\\.ai|copied|counter|installer/gi) ?? []), away: [...document.querySelectorAll('a[href]')].map((a) => new URL(a.href)).filter((u) => u.origin !== location.origin).map((u) => u.href) }; })()`,
    ),
    { words: [], away: [] },
  );
  /* UI updates U4 (evidence/ui-updates.md): the shapes of the public app. Every button and single-line field is a
     pill, the file input's own button included; every multi-line box (a step's panel, the boundary box, the prompt's
     box, the text area) has the 20-pixel corner; the account icon stays round. */
  j.equal(
    'UI updates U4: on the capture page every button and single-line field is a pill and every multi-line box has the 20-pixel corner',
    await cornerOf(tab, [
      '#site-header [data-role="account-link"]',
      '#site-header [data-role="sign-out"]',
      '[data-role="copy-prompt"]',
      '[data-role="upload"]',
      '#agent-name',
      '#passport-file::file-selector-button',
      '[data-role="step-prompt"]',
      '[data-role="capture-secret"]',
      '[data-role="capture-text"]',
      '#passport-text',
    ]),
    {
      '#site-header [data-role="account-link"]': '50%',
      '#site-header [data-role="sign-out"]': PILL,
      '[data-role="copy-prompt"]': PILL,
      '[data-role="upload"]': PILL,
      '#agent-name': PILL,
      '#passport-file::file-selector-button': PILL,
      '[data-role="step-prompt"]': BOX,
      '[data-role="capture-secret"]': BOX,
      '[data-role="capture-text"]': BOX,
      '#passport-text': BOX,
    },
  );
  await j.capture(tab, 'capture-page');
  await j.capture(tab, 'capture-agent-step-prompt', { anchor: '[data-role="step-prompt"]' });
  await j.capture(tab, 'capture-copy', { anchor: '[data-role="copy-prompt"]' });
  await j.capture(tab, 'capture-agent-step-upload', { anchor: '[data-role="step-upload"]' });
  await j.capture(tab, 'capture-agent-step-next', { anchor: '[data-role="step-next"]' });

  /* Copy, with the page's clipboard permission granted to the shell's origin, as a person's browser grants it on a
     click. The clipboard is read back and compared with the file's SHA-256; no request of any kind leaves on a copy
     (evidence/intake-compare.md Q1: the public page posts a counter). */
  await tab.browser.conn.send('Browser.grantPermissions', { origin: j.origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await tab.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  let from = tab.requests.length;
  await tab.click('[data-role="copy-prompt"]');
  await tab.waitForSelector('[data-role="copy-status"] [data-state]');
  j.equal('Copy answers with its sentence', await text(tab, '[data-role="copy-status"] [data-state="copied"]'), 'Copied. Paste it into your assistant.');
  j.equal('the clipboard holds capture/enterprise.md byte for byte', await pageSha(tab, 'navigator.clipboard.readText()'), PROMPT_SHA256);
  j.equal('a copy sends no request at all', tab.requests.slice(from).map((r) => r.url), []);

  /* The browser refuses the copy: the clipboard call is replaced in the page by one that rejects, as a browser that
     withholds the permission rejects it. The page says so and selects the prompt in its box for copying by hand. */
  await tab.evaluate(`navigator.clipboard.writeText = () => Promise.reject(new DOMException('refused', 'NotAllowedError')); true`);
  from = tab.requests.length;
  await tab.click('[data-role="copy-prompt"]');
  await tab.waitForSelector('[data-role="copy-status"] [data-state="copy-refused"]');
  j.equal(
    'a refused copy says so, and the text selected on the page is the prompt, byte for byte',
    {
      sentence: await text(tab, '[data-role="copy-status"] [data-state="copy-refused"]'),
      focused: await tab.evaluate(`document.activeElement === document.querySelector('[data-role="capture-text"]')`),
      selected: await pageSha(tab, `(() => { const p = document.querySelector('[data-role="capture-text"]'); return p.value.slice(p.selectionStart, p.selectionEnd); })()`),
    },
    { sentence: 'This browser did not let the page copy. The prompt is selected in the box above: copy it yourself.', focused: true, selected: PROMPT_SHA256 },
  );
  j.equal('a refused copy sends no request either', tab.requests.slice(from).map((r) => r.url), []);
  await j.capture(tab, 'capture-copy-refused', { anchor: '[data-role="copy-prompt"]' });

  j.equal(
    "the capture page's one call is the identity read; nothing about the prompt is read from the service",
    (await apiRequests(tab, j.origin, atCapture)).map((x) => `${x.method} ${x.path} ${x.status}`),
    ['GET /api/me 200'],
  );

  const bare = await j.tab(member.identity, 'bare');
  await bare.setViewport(PHONE);
  await bare.navigate(`${j.origin}/capture/`);
  await bare.waitForSelector('[data-role="capture-text"]');
  j.equal(
    '/capture/ without a company shows the same prompt, no company links, and in step 2 a sentence with the link home and no form',
    {
      sha: await pageSha(bare, `document.querySelector('[data-role="capture-text"]').value`),
      noCompany: await text(bare, '[data-role="step-upload"] [data-state="no-company"] p'),
      home: await bare.evaluate(`document.querySelector('[data-role="step-upload"] [data-role="home-link"]')?.getAttribute('href') ?? null`),
      form: await exists(bare, '[data-role="upload-form"]'),
      companyLinks: await exists(bare, 'main [data-role="company-links"]'),
    },
    {
      sha: PROMPT_SHA256,
      noCompany: 'The file is uploaded into one of your companies: open Capture an agent from Your agents in that company.',
      home: '/',
      form: false,
      companyLinks: false,
    },
  );
  await j.cookies(bare, 2, 'the member signed in');
}

/** An operator account of the journey's own: a confirmed account with no membership and no factor, registered in
    app.operators owner-side, as tests/db/00-seed.sh registers the seeded operator (no route adds the first operator). */
function freshOperator(name) {
  const email = `ol-${name}-${tag()}@example.invalid`;
  const id = e3lib('create_user "$1" "$PW"', email);
  sql(`insert into app.operators (user_id) values ('${id}')`);
  return { email, id, identity: `ol-${name}` };
}

/** A confirmed account with no membership that is not an operator. */
function nobody(name) {
  const email = `ol-${name}-${tag()}@example.invalid`;
  return { email, id: e3lib('create_user "$1" "$PW"', email), identity: `ol-${name}` };
}

const paths = (tab, from = 0) => tab.documents.slice(from).map((d) => new URL(d.url).pathname);
/* A read's error code comes from its body, which the harness can no longer read once the page that sent it has moved on
   (it records "unreadable"); so a read from a page that navigated away is compared by its status, and the code is
   compared where the page stayed. */
const registerReads = async (tab, origin, from = 0) =>
  (await apiRequests(tab, origin, from)).filter((x) => x.path === '/api/operator/companies').map(line);
const statusesOf = (reads) => reads.map((l) => l.split(' ').slice(0, 3).join(' '));

/** Answers the next request whose path ends with suffix with one scripted JSON answer, at the response stage, as a
    service that sent it would; every other request goes on untouched. The harness setting up a state no route gives. */
async function answerNextWith(tab, suffix, status, value) {
  let used = false;
  tab.on('Fetch.requestPaused', async (p) => {
    if (used || !new URL(p.request.url).pathname.endsWith(suffix)) {
      await tab.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => undefined);
      return;
    }
    used = true;
    await tab
      .send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: status,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(value)).toString('base64'),
      })
      .catch(() => undefined);
    await tab.send('Fetch.disable').catch(() => undefined);
  });
  await tab.send('Fetch.enable', { patterns: [{ urlPattern: `*${suffix}`, requestStage: 'Response' }] });
}

/** PEER-1's harness step: answers the first request whose path ends with suffix with one scripted JSON answer, and holds
    the second at the request stage until release(); `arrival` settles when the second is held. Every other request goes
    on untouched. The harness setting up a state and a moment to look, never a page's request. */
async function refuseThenHold(tab, suffix, status, value) {
  let seen = 0;
  let held = null;
  let arrived;
  const arrival = new Promise((resolve) => {
    arrived = resolve;
  });
  tab.on('Fetch.requestPaused', async (p) => {
    const mine = new URL(p.request.url).pathname.endsWith(suffix);
    seen += mine ? 1 : 0;
    if (mine && seen === 1) {
      await tab
        .send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: status,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }],
          body: Buffer.from(JSON.stringify(value)).toString('base64'),
        })
        .catch(() => undefined);
      return;
    }
    if (mine && seen === 2) {
      held = p.requestId;
      arrived();
      return;
    }
    await tab.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => undefined);
  });
  await tab.send('Fetch.enable', { patterns: [{ urlPattern: `*${suffix}`, requestStage: 'Request' }] });
  return {
    arrival,
    release: async () => {
      await tab.send('Fetch.continueRequest', { requestId: held });
      await tab.send('Fetch.disable');
    },
  };
}

/** A code for the period after the one a key was last used in, so a verification never repeats an accepted code. */
async function freshCode(key, usedAt) {
  const period = (t) => Math.floor(t / 30_000);
  while (period(Date.now()) === period(usedAt)) await new Promise((r) => setTimeout(r, 500));
  return currentCode(key);
}

export async function ol2(ctx, j) {
  const op = freshOperator('landing');
  const tab = await signIn(j, op.identity, op.email, { label: 'operator-first', watch: true });
  await tab.waitForSelector('[data-state="enrol"], [data-state="no-membership"]', { timeout: 20000 });
  /* Two reads: the home page's, which decides where the operator goes, and /mfa/'s own, for its header. */
  const firstReads = await registerReads(tab, j.origin);
  j.equal(
    'an operator with no factor goes from the sign-in to the home page and on to /mfa/, never shown the members\' empty state',
    { documents: paths(tab), reads: statusesOf(firstReads), mfaRead: firstReads.at(-1), empty: await exists(tab, '[data-state="no-membership"]') },
    {
      documents: ['/signin/', '/', '/mfa/'],
      reads: ['GET /api/operator/companies 403', 'GET /api/operator/companies 403'],
      mfaRead: 'GET /api/operator/companies 403 E_OPERATOR_MFA_REQUIRED',
      empty: false,
    },
  );
  await tab.setViewport(PHONE);
  await j.capture(tab, 'operator-enrol');
  const key = await startSetup(tab);
  const at = paths(tab).length;
  await verifySetup(tab, key);
  const enrolledAt = Date.now();
  await waitPath(tab, '/operator/');
  await tab.waitForSelector('[data-role="register"]');
  j.equal(
    'after enrolling, the operator is taken home and on to the register, which answers 200',
    { documents: paths(tab, at), reads: (await registerReads(tab, j.origin)).slice(firstReads.length) },
    { documents: ['/', '/operator/'], reads: ['GET /api/operator/companies 200', 'GET /api/operator/companies 200'] },
  );
  await j.cookies(tab, 2, 'the operator at aal2');

  /* At aal2 the home page itself moves the operator to the register. */
  const home = await j.tab(op.identity, 'operator-home');
  await watchDrawing(home);
  await home.navigate(`${j.origin}/`);
  await waitPath(home, '/operator/');
  await home.waitForSelector('[data-role="register"]');
  j.equal('at aal2 the home page moves the operator to /operator/', paths(home), ['/', '/operator/']);

  /* A second browser of the same account: aal1 with a verified factor. The sign-in page sends it to the challenge,
     and the verification goes home and on to the register. */
  const second = await signIn(j, `${op.identity}-2`, op.email, { label: 'operator-second', watch: true });
  await waitPath(second, '/mfa/');
  await second.waitForSelector('[data-state="challenge"]');
  await second.type('#code', await freshCode(key, enrolledAt));
  const beforeVerify = paths(second).length;
  await second.click('[data-role="verify"]');
  await waitPath(second, '/operator/');
  await second.waitForSelector('[data-role="register"]');
  j.equal(
    'an operator at aal1 with a factor is challenged on /mfa/ and then taken to /operator/',
    { first: paths(second).slice(0, beforeVerify), after: paths(second, beforeVerify) },
    { first: ['/signin/', '/mfa/'], after: ['/', '/operator/'] },
  );

  /* UI updates U5 (evidence/ui-updates.md): on each of those passes through the home page, on the way to /mfa/ or
     /operator/, the home page draws no signed-in header, so the operator never sees a member's home page. What every
     document drew is recorded beside the check. */
  const homeHeaders = (t) =>
    drawnPerDocument(t)
      .filter((d) => d.document === '/')
      .map((d) => d.drew.filter((what) => what.startsWith('header:')));
  for (const [name, t] of [
    ['no factor', tab],
    ['aal1 with a factor', second],
    ['aal2', home],
  ])
    j.record(`U5: what each document drew, ${name}`, drawnPerDocument(t));
  j.equal(
    'UI updates U5: no pass through the home page on the way to /mfa/ or /operator/ draws the signed-in header (account link, sign-out)',
    { 'no factor': homeHeaders(tab), 'aal1 with a factor': homeHeaders(second), aal2: homeHeaders(home) },
    { 'no factor': [[], []], 'aal1 with a factor': [[]], aal2: [[]] },
  );
  /* The positive control (PEER-3): the same observer saw the header on the page each arm ended on, so the empty lists
     above are what the home page drew and not an observer that reported nothing. */
  const endHeader = (t) => drawnPerDocument(t).at(-1)?.drew.filter((what) => what.startsWith('header:')) ?? null;
  const drawnHeader = ['header: account link', 'header: sign-out', 'header: operator navigation'];
  j.equal(
    'UI updates U5: the observer saw the signed-in header with the operator navigation on the register each arm ended on',
    { 'no factor': endHeader(tab), 'aal1 with a factor': endHeader(second), aal2: endHeader(home) },
    { 'no factor': drawnHeader, 'aal1 with a factor': drawnHeader, aal2: drawnHeader },
  );

  /* PEER-1: an operator whose first register read says nothing sees the failure with Retry under the signed-in header,
     so sign-out stays; Retry starts the page again from the plain header, so while its read is in flight no member's
     header is up, and the answer, 200, takes the operator to the register. The read is held by the harness to look. */
  const retry = await j.tab(op.identity, 'operator-retry');
  const gate = await refuseThenHold(retry, '/api/operator/companies', 403, { ok: false, code: 'E_SOMETHING_NEW', message: 'A refusal this page does not know.' });
  await retry.navigate(`${j.origin}/`);
  await retry.waitForSelector('[data-state="standing-unknown"]');
  const failed = { signOut: await exists(retry, 'header [data-role="sign-out"]'), retry: await exists(retry, 'main [data-role="retry"]') };
  await retry.click('main [data-role="retry"]');
  await gate.arrival;
  const during = {
    accountLink: await exists(retry, 'header [data-role="account-link"]'),
    signOut: await exists(retry, 'header [data-role="sign-out"]'),
    loading: await text(retry, 'main [data-state="loading"]'),
  };
  await gate.release();
  await waitPath(retry, '/operator/');
  await retry.waitForSelector('[data-role="register"]');
  j.equal(
    "UI updates U5 (PEER-1): after a register read that said nothing, Retry's read runs under the plain header, and its 200 takes the operator to the register",
    { failed, during, documents: paths(retry) },
    { failed: { signOut: true, retry: true }, during: { accountLink: false, signOut: false, loading: 'Loading your companies.' }, documents: ['/', '/operator/'] },
  );

  /* A person with no membership who is not an operator: the one register read answers E_NOT_OPERATOR and the page
     shows the members' empty state, as before. */
  const plain = nobody('plain');
  const none = await signIn(j, plain.identity, plain.email, { label: 'nobody' });
  await waitPath(none, '/');
  await none.waitForSelector('[data-state="no-membership"]');
  j.equal(
    'a person with no membership who is not an operator reads "No company yet" after one refused register read',
    { documents: paths(none), reads: await registerReads(none, j.origin), nav: await exists(none, '[data-role="operator-nav"]') },
    { documents: ['/signin/', '/'], reads: ['GET /api/operator/companies 403 E_NOT_OPERATOR'], nav: false },
  );

  /* The same person when the register read fails: the failure with Retry, never the empty state; Retry reads again. */
  const failing = await j.tab(plain.identity, 'nobody-failed-read');
  const lost = loseNextAnswer(failing, '/api/operator/companies');
  await failing.navigate(`${j.origin}/`);
  await lost;
  await failing.waitForSelector('[data-role="retry"], [data-state="no-membership"]');
  j.equal(
    'a failed register read shows the failure with Retry and not the empty state',
    { retry: await exists(failing, '[data-role="retry"]'), empty: await exists(failing, '[data-state="no-membership"]') },
    { retry: true, empty: false },
  );
  await failing.setViewport(PHONE);
  await j.capture(failing, 'nobody-failed-read');
  await failing.click('[data-role="retry"]');
  await failing.waitForSelector('[data-state="no-membership"]');
  j.check('Retry reads the register again and then shows the empty state', true);

  /* PC-1: the register answers a refusal this page does not know. The lead's rule is Retry for anything but
     E_NOT_OPERATOR, whatever action the code carries, under the signed-in header so sign-out stays. */
  const unknown = await j.tab(plain.identity, 'nobody-unknown-refusal');
  await answerNextWith(unknown, '/api/operator/companies', 403, { ok: false, code: 'E_SOMETHING_NEW', message: 'A refusal this page does not know.' });
  await unknown.navigate(`${j.origin}/`);
  await unknown.waitForSelector('[data-state="standing-unknown"], [data-state="no-membership"], main [role="alert"]');
  j.equal(
    'a refusal the page does not know shows its message with Retry under the signed-in header, not the empty state',
    {
      code: await unknown.evaluate(`document.querySelector('main [role="alert"]')?.dataset.code ?? null`),
      retry: await exists(unknown, 'main [data-role="retry"]'),
      signOut: await exists(unknown, 'header [data-role="sign-out"]'),
      empty: await exists(unknown, '[data-state="no-membership"]'),
    },
    { code: 'E_SOMETHING_NEW', retry: true, signOut: true, empty: false },
  );
  await unknown.click('main [data-role="retry"]');
  await unknown.waitForSelector('[data-state="no-membership"]');
  j.check('its Retry reads the register again, which now answers E_NOT_OPERATOR: the empty state', true);

  /* A member of one company: no register read, straight to the members page as before. */
  const C = await captureWorld(ctx);
  const member = await signIn(j, C.users.member.identity, C.users.member.email, { label: 'member-landing' });
  await waitPath(member, '/members/', { search: `?company=${C.companyId}` });
  j.equal(
    'a member with a company sends no register read and lands on the members page as before',
    { reads: await registerReads(member, j.origin), nav: await exists(member, '[data-role="operator-nav"]') },
    { reads: [], nav: false },
  );
}

/** An operator account of the run's own at aal2, enrolled through the pages and landed on the register; made once per
    run for the journeys after OL-2, which keeps its first sign-in to itself. */
async function olOperator(j, ctx) {
  if (ctx.state.olOperator) return ctx.state.olOperator;
  const op = freshOperator('nav');
  const tab = await signIn(j, op.identity, op.email, { label: 'operator-enrol' });
  await waitPath(tab, '/mfa/');
  await tab.waitForSelector('[data-state="enrol"]');
  await verifySetup(tab, await startSetup(tab));
  await waitPath(tab, '/operator/');
  await tab.close().catch(() => undefined);
  ctx.state.olOperator = op;
  return op;
}

/** The operator navigation as the page draws it: each entry's role, whether it is a link, and its target. */
const operatorNav = (tab) =>
  tab.evaluate(
    `(() => { const n = document.querySelector('header [data-role="operator-nav"]'); return n ? [...n.children].map((c) => [c.dataset.role, c.tagName === 'A' ? c.getAttribute('href') : 'current']) : null; })()`,
  );
const navWith = (current) =>
  [
    ['nav-companies', '/operator/'],
    ['nav-new-company', '/operator/new/'],
  ].map(([role, href]) => [role, role === current ? 'current' : href]);

export async function ol3(ctx, j) {
  const C = await captureWorld(ctx);
  const op = await olOperator(j, ctx);
  const tab = await j.tab(op.identity, 'nav');
  await tab.setViewport(PHONE);
  await tab.navigate(`${j.origin}/operator/`);
  await tab.waitForSelector('[data-role="register"]');
  j.equal('the register draws the operator navigation with Companies as the current page', await operatorNav(tab), navWith('nav-companies'));
  /* UI updates U2 (evidence/ui-updates.md): the account link is a person icon in a 44-pixel target; the address is its
     name and tooltip and no longer header text. */
  j.equal(
    'the header names the operator by the account icon alone: its name and tooltip carry the address, the header text does not, and the icon is drawn in a 44 by 44 target',
    await tab.evaluate(
      `(() => { const a = document.querySelector('header [data-role="account-link"]'); const r = a.getBoundingClientRect(); const icon = a.querySelector('.user-icon'); return { href: a.getAttribute('href'), name: a.getAttribute('aria-label'), title: a.title, children: [...a.children].map((c) => c.className), hidden: icon.getAttribute('aria-hidden'), glyph: [getComputedStyle(icon, '::before').width, getComputedStyle(icon, '::after').width], inText: document.querySelector('header').innerText.includes(${JSON.stringify(op.email)}), size: [Math.round(r.width), Math.round(r.height)] }; })()`,
    ),
    { href: '/account/', name: `Account, ${op.email}`, title: `Account, ${op.email}`, children: ['user-icon'], hidden: 'true', glyph: ['8px', '14px'], inText: false, size: [44, 44] },
  );
  j.equal(
    'UI updates U4: the register draws its button-styled link as a pill, and its panels and the order control with the 20-pixel corner',
    await cornerOf(tab, ['[data-role="new-company"]', '[data-role="glance"]', '[data-role="register-order"]']),
    { '[data-role="new-company"]': PILL, '[data-role="glance"]': BOX, '[data-role="register-order"]': BOX },
  );
  await j.capture(tab, 'operator-header');

  await tab.click('header [data-role="nav-new-company"]');
  await waitPath(tab, '/operator/new/');
  await tab.waitForSelector('[data-role="create-form"]');
  j.equal('New company leads to the create page, whose header marks it current', await operatorNav(tab), navWith('nav-new-company'));
  j.equal(
    'UI updates U4: the create form draws its text, address, number and date fields and its button as pills, and its fieldset with the 20-pixel corner',
    await cornerOf(tab, ['#company-slug', '#first-admin-email', '#invite-days', '#period-start', '[data-role="create-company"]', '[data-role="period"]']),
    {
      '#company-slug': PILL,
      '#first-admin-email': PILL,
      '#invite-days': PILL,
      '#period-start': PILL,
      '[data-role="create-company"]': PILL,
      '[data-role="period"]': BOX,
    },
  );
  await j.capture(tab, 'operator-create-form');

  await tab.click('header [data-role="account-link"]');
  await waitPath(tab, '/account/');
  await tab.waitForSelector('[data-role="address"]');
  j.equal(
    'the account icon leads to the account page, which marks the icon current and draws both operator links',
    { nav: await operatorNav(tab), current: await tab.evaluate(`document.querySelector('header [data-role="account-link"]').getAttribute('aria-current')`) },
    { nav: navWith(null), current: 'page' },
  );
  await j.capture(tab, 'operator-account-header');

  await tab.click('header [data-role="nav-companies"]');
  await waitPath(tab, '/operator/');
  await tab.waitForSelector('[data-role="register"]');
  j.check('Companies leads back to the register', true);

  await tab.navigate(`${j.origin}/operator/company/?company=${C.companyId}`);
  await tab.waitForSelector('[data-role="manifest"]');
  j.equal("a company's operator page draws all three as links", await operatorNav(tab), navWith(null));
  await tab.navigate(`${j.origin}/mfa/`);
  await tab.waitForSelector('[data-state="verified"]');
  j.equal('/mfa/ at aal2 draws them too', await operatorNav(tab), navWith(null));
  j.check('sign-out stays in the header beside them', await exists(tab, 'header [data-role="sign-out"]'));

  /* An operator at aal1, on the enrolment the sign-in took it to. */
  const fresh = freshOperator('nav-aal1');
  const aal1 = await signIn(j, fresh.identity, fresh.email, { label: 'operator-aal1' });
  await waitPath(aal1, '/mfa/');
  await aal1.waitForSelector('[data-state="enrol"]');
  j.equal('an operator at aal1 on /mfa/ has the navigation too', await operatorNav(aal1), navWith(null));

  /* Nobody else: a member on the members, account and capture pages; a person with no membership on home, account and
     /mfa/. */
  const member = await signIn(j, C.users.member.identity, C.users.member.email, { label: 'member-headers' });
  const plain = nobody('nav-plain');
  const none = await signIn(j, plain.identity, plain.email, { label: 'nobody-headers' });
  await none.waitForSelector('[data-state="no-membership"]');
  const seen = {};
  for (const [who, page, path, ready] of [
    ['member', member, `/members/?company=${C.companyId}`, '[data-role="company-links"]'],
    ['member', member, '/account/', '[data-role="address"]'],
    ['member', member, `/capture/?company=${C.companyId}`, '[data-role="capture-text"]'],
    ['nobody', none, '/', '[data-state="no-membership"]'],
    ['nobody', none, '/account/', '[data-role="address"]'],
    ['nobody', none, '/mfa/', '[data-state="enrol"]'],
  ]) {
    if (path !== '/' || who !== 'nobody') await page.navigate(`${j.origin}${path}`);
    await page.waitForSelector(ready);
    seen[`${who} ${path.split('?')[0]}`] = await operatorNav(page);
    if (path.startsWith('/members/'))
      j.equal(
        "UI updates U4: the members page draws a member's card with the 20-pixel corner and keeps the small chip a pill",
        await cornerOf(page, ['[data-role="members"] .card', '[data-role="members"] .tag']),
        { '[data-role="members"] .card': BOX, '[data-role="members"] .tag': PILL },
      );
  }
  j.equal('no page of a member or of a person who is not an operator draws the operator navigation', seen, {
    'member /members/': null,
    'member /account/': null,
    'member /capture/': null,
    'nobody /': null,
    'nobody /account/': null,
    'nobody /mfa/': null,
  });

  /* UI updates U1 (evidence/ui-updates.md): the lockup stacks, "Enterprise" beneath "Phaeacia" and left-aligned with
     it, in every kind of header: an operator's and a signed-out page's at phone width, a member's and a person's with
     no membership at desktop width. */
  const signedOut = await j.tab('ol-signed-out', 'signed-out');
  await signedOut.setViewport(PHONE);
  await signedOut.navigate(`${j.origin}/signin/?reason=signed-out`);
  await signedOut.waitForSelector('[data-role="signin-form"]');
  j.equal(
    'UI updates U4: the sign-in page draws its address field and button as pills and its notice with the 20-pixel corner',
    await cornerOf(signedOut, ['#email', '[data-role="send-link"]', '[data-state="reason-signed-out"]']),
    { '#email': PILL, '[data-role="send-link"]': PILL, '[data-state="reason-signed-out"]': BOX },
  );
  await j.capture(signedOut, 'signin-shapes');
  await tab.navigate(`${j.origin}/operator/`);
  await tab.waitForSelector('[data-role="register"]');
  const lockups = {};
  for (const [name, page] of [
    ['operator /operator/', tab],
    ['member /capture/', member],
    ['nobody /mfa/', none],
    ['signed out /signin/', signedOut],
  ])
    lockups[name] = await lockupShape(page);
  j.equal(
    'the lockup is stacked and left-aligned in the header of an operator, a member, a person with no membership and a signed-out page',
    lockups,
    Object.fromEntries(Object.keys(lockups).map((name) => [name, { stacked: true, leftAligned: true }])),
  );
}

/* OL-4's expectations, computed here from the stored rows and not with the page's module, so the journey does not
   inherit a defect of the thing it checks. */
const DAY_MS = 86_400_000;
const ENDED = new Set(['export_window', 'expired']);
function expectedDays(endsAt, state, now) {
  const days = Math.floor(Date.parse(endsAt) / DAY_MS) - Math.floor(now / DAY_MS);
  return ENDED.has(state) ? Math.min(days, 0) : Math.max(days, 0);
}
const expectedWord = (state, days) => (ENDED.has(state) ? 'Ended' : days <= 30 ? 'Ending soon' : 'none');
const STATUS_ORDER = ['active', 'suspended', 'closed', 'held'];
const STATUS_WORD = { active: 'active', suspended: 'suspended', closed: 'closed', held: 'held after a restore' };

/** Every company as the database holds it: id, status, end date, access state, sorted as the register's soonest order. */
function storedCompanies() {
  const lines = sql(
    `select c.id || '|' || c.status || '|' || coalesce(to_char(p.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '') || '|' || app.access_state(c.id)
       from app.companies c left join app.access_periods p on p.company_id = c.id`,
  );
  return lines
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [id, status, endsAt, state] = l.split('|');
      return { id, status, endsAt: endsAt || null, state };
    });
}

/** The register in the service's order, every page, through the route in this process under the seeded operator. */
async function serviceOrder(ctx) {
  const { call } = await routes(ctx);
  const ids = [];
  let cursor;
  for (;;) {
    const page = ok(await call('operatorRegister', { user: operatorUser(ctx), query: cursor ? { cursor, limit: '200' } : { limit: '200' } }), 'register');
    ids.push(...page.companies.map((c) => c.companyId));
    if (!page.nextCursor) return ids;
    cursor = page.nextCursor;
  }
}

export async function ol4(ctx, j) {
  const day = 86_400_000;
  const { call } = await routes(ctx);
  const op = operatorUser(ctx);
  /* Four companies of this run: one ending in ten days, one aged owner-side past its deletion date and still active
     (as E6-JLS ages one), one suspended, and one whose first administrator has not accepted. */
  const soon = await smallCompany(ctx, 'ol4-soon');
  ok(
    await call('operatorAccessPeriod', {
      user: op,
      params: { companyId: soon.companyId },
      body: { startsAt: new Date(Date.now() - day).toISOString(), endsAt: new Date(Date.now() + 10 * day).toISOString() },
    }),
    'ten days',
  );
  const overdue = await smallCompany(ctx, 'ol4-overdue');
  agePeriod(overdue.companyId, '60 days', '46 days', '16 days');
  const suspended = await smallCompany(ctx, 'ol4-suspended');
  ok(await call('operatorCompanyStatus', { user: op, params: { companyId: suspended.companyId }, body: { status: 'suspended', reasonCode: 'customer_request' } }), 'suspend');
  const run = tag();
  const unclaimed = ok(
    await call('operatorCompanyCreate', {
      user: op,
      body: {
        slug: `ol4-unclaimed-${run}`,
        name: `OL4 unclaimed ${run}`,
        firstAdminEmail: `ol4-unclaimed-${run}@example.invalid`,
        startsAt: new Date(Date.now() - day).toISOString(),
        endsAt: new Date(Date.now() + 200 * day).toISOString(),
      },
    }),
    'unclaimed company',
  );

  const identity = (await olOperator(j, ctx)).identity;
  const tab = await j.tab(identity, 'glance');
  await tab.setViewport(PHONE);
  const from = tab.requests.length;
  await tab.navigate(`${j.origin}/operator/`);
  await tab.waitForSelector('[data-role="glance"]');
  /* Every page of the register, so the glance speaks for all of it. */
  while (await exists(tab, '[data-role="show-more"]')) {
    const before = await tab.evaluate(`document.querySelectorAll('[data-role="register-table"] tbody tr').length`);
    await tab.click('[data-role="show-more"]');
    await tab.waitFor(`document.querySelectorAll('[data-role="register-table"] tbody tr').length > ${before}`);
  }
  const now = Date.now();
  const stored = storedCompanies();
  /* Equal end dates are common (the create form stores a date at midnight UTC), and the page breaks a tie by the
     service's order, as a stable sort of the rows it was sent; so the expectations below do too. */
  const service = await serviceOrder(ctx);
  const rank = new Map(service.map((id, i) => [id, i]));
  const soonestOf = (list) => [...list].sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt) || rank.get(a.id) - rank.get(b.id));
  j.equal(
    'the page reads only the identity and the register, pages of it, and nothing new',
    [...new Set((await apiRequests(tab, j.origin, from)).map((x) => `${x.method} ${x.path}`))].sort(),
    ['GET /api/me', 'GET /api/operator/companies'],
  );

  const tally = STATUS_ORDER.map((s) => [s, stored.filter((c) => c.status === s).length]).filter(([, n]) => n > 0);
  j.equal(
    'the status sentence counts every company by status',
    await text(tab, '[data-role="glance-status"]'),
    `${stored.length} ${stored.length === 1 ? 'company' : 'companies'}: ${tally.map(([s, n]) => `${n} ${STATUS_WORD[s]}`).join(', ')}.`,
  );

  const dated = soonestOf(stored.filter((c) => c.status !== 'closed' && c.endsAt));
  const shown = await tab.evaluate(
    `[...document.querySelectorAll('[data-role="glance-ending"] li')].map((li) => [li.dataset.glanceCompany, li.dataset.word, Number(li.dataset.days)])`,
  );
  j.equal(
    'the soonest list is the five earliest end dates of the companies not closed, soonest first, each with its word and whole UTC days',
    shown,
    dated.slice(0, 5).map((c) => {
      const days = expectedDays(c.endsAt, c.state, now);
      return [c.id, expectedWord(c.state, days), days];
    }),
  );
  j.equal(
    'the table says the ten-day company is ending soon, with its days',
    await text(tab, `[data-role="register-table"] tr:has([data-company="${soon.companyId}"]) [data-role="days-left"]`),
    `Ending soon: ${expectedDays(new Date(Date.now() + 10 * day).toISOString(), 'current', now)} days left`,
  );

  const needs = await tab.evaluate(
    `Object.fromEntries([...document.querySelectorAll('[data-role="glance-needs"] li')].map((li) => [li.dataset.glanceCompany, li.textContent.slice(li.querySelector('a').textContent.length + 2)]))`,
  );
  const deleteBy = sql(`select to_char(delete_by at time zone 'UTC', 'FMDD FMMonth YYYY') from app.access_periods where company_id = '${overdue.companyId}'`);
  j.equal(
    'what needs the operator: the overdue deletion with its closed window, the suspension, the administrator not yet there with the open invitation; the ten-day company is not listed',
    [needs[overdue.companyId], needs[suspended.companyId], needs[unclaimed.companyId], needs[soon.companyId] ?? null],
    [
      `Deletion overdue since ${deleteBy}; Reading window closed and not yet suspended by the sweep.`,
      'Suspended.',
      'No administrator yet; 1 open invitation.',
      null,
    ],
  );
  await j.capture(tab, 'register-glance', { anchor: '[data-role="glance"]' });

  const tableOrder = () => tab.evaluate(`[...document.querySelectorAll('[data-role="register-table"] tbody tr [data-company]')].map((n) => n.dataset.company)`);
  const soonestFirst = soonestOf(stored.filter((c) => c.endsAt)).map((c) => c.id);
  const order = await tableOrder();
  j.equal(
    'the table is soonest ending first by default, closed companies included, and the undated companies after them',
    { dated: order.slice(0, soonestFirst.length), undated: new Set(order.slice(soonestFirst.length)).size, total: order.length },
    { dated: soonestFirst, undated: stored.length - soonestFirst.length, total: stored.length },
  );
  j.equal('the order control starts on soonest ending first', await tab.evaluate(`document.querySelector('[data-role="register-order"] input:checked')?.value`), 'ending');
  await tab.click('[data-role="register-order"] input[value="service"]');
  await tab.waitFor(`document.querySelector('[data-role="register-order"] input:checked')?.value === 'service'`);
  j.equal("the other choice gives the service's own order back, row for row", await tableOrder(), service);
  await j.capture(tab, 'register-service-order', { anchor: '[data-role="register-order"]' });
}
