/* IN-1 to IN-6 (docs/e3/intake-pages-design.md section 10): the author's intake pages in a browser.

   IN-1  an author reaches Your agents from the members page, opens Capture an agent and, in its step 2, pastes a
         synthetic passport declaring one capability version 0.1 does not install, sees the server's preview, saves an
         edit, submits with named colleagues and an outside name after the confirmation, and opens the submitted version
         with its losses table; a reviewer then finds it in the review queue that already exists. At phone width. On the way, the fixes of evidence/intake-fixes.md: an edit
         or a chosen file with the confirmation open closes it and nothing is submitted (INTR-F1); Submit for review and
         the text box are held while the submit is in flight (INTR-F14); and, on a second draft, the text box is held
         while a save is in flight, and the Retry of a save whose answer was lost sends nothing once the box has changed
         (INTR-F2). And the fixes of evidence/intake-fixes-2.md: the upload form holds the text box, the file input and
         the name while the upload is in flight (on Capture an agent), and the Retry of an upload whose answer was lost
         sends nothing once the text and the name have changed (on the upload page) (INF-N2); declarations typed before a save are in the form the save draws
         (INF-N1); and they are held while the submit is in flight (INF-N8). And evidence/capture-once.md's: a save of
         the unchanged text pressed with the confirmation open closes it and holds Submit for review (INTRR-F1).
   IN-2  the E3 case 8 passport (a carriage return inside section 1's prose), chosen as a file, is refused by the
         content gate: the server's message and the problem's line and code show, and nothing is stored, on upload and
         on a draft's save; a file over 262,144 bytes is refused on the page and no request is sent.
   IN-3  a second member cannot open the first author's draft: the draft, submitted and new-version pages all show the
         not-available state, and nothing of the draft reaches the page.
   IN-4  a member removed while their draft is open: the next save answers 404 and the page, text box included, is
         replaced by the not-available state; the draft is unchanged.
   IN-5  a suspended company: Your agents shows the server's refusal with the link home, the upload page shows the home
         page's sentence and no form, and the member's own draft is not available.
   IN-6  changes requested on a submitted version: the author sees the reason, starts a new version from it, and lands on
         a draft holding the same text with the contributors carried over.

   The starting states other than the ones a journey makes through the pages are made in this process through the route
   functions under minted sessions, as the E4 journeys make theirs (e4-common.mjs): that is the harness setting up, never
   a page's request, and the universal assertions read only what the pages send. The passports are the E3 stack tests'
   own (tests/e3/stack/helpers.mjs passportText, largePassport, and case 8's carriage return) and IN-1's, the E4
   journeys' declared-only fixture (tests/passport/fixtures/synthetic-money-declared.md) with the same revision marker;
   no passport is written here. Nothing prints a token or a key. */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { messageFor } from '../../../lib/errors.mjs';
import { mintUserToken } from '../../e2/helpers/stack.mjs';
import { CR, e3lib, largePassport, PROSE, passportText, sql } from '../../e3/stack/helpers.mjs';
import { PHONE } from '../cdp.mjs';
import { SCRATCH } from '../harness.mjs';
import { apiRequests, signIn, tag, waitPath } from './common.mjs';
import { companyUrl, envelope, exists, fixture, holdNext, loseNextAnswer, removeMembership, reviewed, routes, signedIn, submitted, textOf, UUID_V4 } from './e4-common.mjs';
import { operatorUser, smallCompany } from './e6-common.mjs';

const ROLES = Object.freeze({
  admin: null,
  author: '{member}',
  second: '{member}',
  it: '{it_reviewer,member}',
  business: '{business_reviewer,member}',
  leaver: '{member}',
});
const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const one = (query) => sql(query).trim();

function ok(r, label) {
  if (r.status < 200 || r.status >= 300) throw new Error(`intake setup, ${label}: ${r.status} ${String(r.raw).slice(0, 200)}`);
  return r.body;
}

/** The run's intake company, made once: its accounts, one audience group holding the second member, claude-ai
    publishable (owner-side, as e4world does), so a reviewer can propose an envelope and request changes. */
export async function intakeWorld(ctx) {
  if (ctx.state.intake) return ctx.state.intake;
  const run = tag();
  const users = {};
  for (const who of Object.keys(ROLES)) {
    const email = `intake-${run}-${who}@example.invalid`;
    const id = e3lib('create_user "$1" "$PW"', email);
    users[who] = { who, id, email, identity: `in-${who}`, token: () => mintUserToken({ sub: id, email, aal: 'aal1', ttl: 3600 }) };
  }
  const companyId = e3lib('company "$1" "$2"', `intake-${run}`, users.admin.id);
  const ms = { admin: e3lib('membership_of "$1" "$2"', companyId, users.admin.id) };
  for (const [who, roles] of Object.entries(ROLES)) if (roles) ms[who] = e3lib('member "$1" "$2" "$3"', companyId, users[who].id, roles);
  const aal2 = (u) => ({ ...u, token: () => mintUserToken({ sub: u.id, email: u.email, aal: 'aal2', ttl: 3600 }) });
  const { call } = await routes(ctx);
  const group = ok(await call('groupsCreate', { user: aal2(users.admin), params: { companyId }, body: { name: 'Intake readers' } }), 'group');
  ok(await call('groupMembersAdd', { user: aal2(users.admin), params: { companyId, groupId: group.groupId, membershipId: ms.second } }), 'group member');
  e3lib('enable_target "$1"', 'claude-ai');
  ctx.state.intake = { run, users, ms, companyId, groupId: group.groupId, aal2 };
  return ctx.state.intake;
}

/** A draft of a new agent by one of the world's accounts, through the create route in this process. */
async function draftBy(ctx, W, who, { companyId = W.companyId, user = W.users[who] } = {}) {
  const { call } = await routes(ctx);
  const text = passportText(`${who}-${tag()}`);
  const body = ok(
    await call('candidatesCreate', {
      user,
      params: { companyId },
      headers: { 'idempotency-key': randomUUID(), 'x-agent-name': `${who}-agent-${tag()}` },
      body: Buffer.from(text, 'utf8'),
    }),
    'draft',
  );
  return { candidateId: body.candidateId, agentId: body.agentId, text };
}

/** A file in the run's scratch record, for the file input. */
function scratchFile(ctx, name, bytes) {
  const dir = join(SCRATCH, ctx.run, 'intake-files');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

/** Sets the file input to one file through DevTools, which fires its input and change events as a person's choice does. */
async function chooseFile(tab, selector, path) {
  await tab.waitForSelector(selector);
  const { result } = await tab.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})`, returnByValue: false });
  await tab.send('DOM.setFileInputFiles', { files: [path], objectId: result.objectId });
}

/** The content type and key of each request a tab sends to a path ending with suffix and a method, as Chrome sent it. */
function requestsSent(tab, method, suffix) {
  const seen = [];
  tab.on('Network.requestWillBeSent', (p) => {
    let path;
    try {
      path = new URL(p.request.url).pathname;
    } catch {
      return;
    }
    if (p.request.method !== method || !path.endsWith(suffix)) return;
    const headers = Object.fromEntries(Object.entries(p.request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    seen.push({ type: headers['content-type'] ?? null, key: headers['idempotency-key'] ?? null, agent: headers['x-agent-name'] ?? null, ifMatch: headers['if-match'] ?? null });
  });
  return seen;
}

/** The E4 declared-only passport with IN-1's revision marker: one capability, money.transfer, version 0.1 does not install. */
const declaredOnly = (revision) => fixture('synthetic-money-declared.md').replace(PROSE, `${PROSE} Revision ${revision}.`);
const boxValue = (tab) => tab.evaluate(`document.querySelector('#draft-text')?.value ?? null`);
const candidateOf = async (tab) => new URLSearchParams((await tab.location()).search).get('candidate');
const paneText = (tab) => tab.evaluate(`document.querySelector('[data-role="stored"] [data-role="content"]')?.textContent ?? null`);
const draftUrl = (j, id) => `${j.origin}/draft/?candidate=${id}`;
const submittedUrl = (j, id) => `${j.origin}/submitted/?candidate=${id}`;
const inCompany = (companyId) => ({
  versions: Number(one(`select count(*) from app.candidate_versions where company_id = '${companyId}'`)),
  audits: Number(one(`select count(*) from app.audit_events where company_id = '${companyId}'`)),
});

/** IN-1: paste, preview, save, submit, and the reviewer's queue. */
export async function in1(ctx, j) {
  const W = await intakeWorld(ctx);
  await signedIn(j, W, 'author');
  const tab = await j.tab(W.users.author.identity, 'author-phone');
  await tab.setViewport(PHONE);
  await tab.navigate(`${j.origin}/`);
  await waitPath(tab, '/members/');
  await tab.click('[data-role="company-links"] [data-role="link-drafts"]');
  await waitPath(tab, '/drafts/', { search: `?company=${W.companyId}` });
  await tab.waitForSelector('[data-state="empty"]');
  j.equal(
    'Your agents is reached from the members page header, and a member with nothing uploaded sees the empty state and no agent',
    await tab.evaluate(`({ at: location.pathname + location.search, empty: document.querySelectorAll('main [data-state="empty"]').length, agents: document.querySelectorAll('main [data-agent]').length })`),
    { at: `/drafts/?company=${W.companyId}`, empty: 1, agents: 0 },
  );
  await j.cookies(tab, 2, 'the author signed in');
  await j.capture(tab, 'list-empty');

  /* evidence/add-agent.md: Your agents' one control, Capture an agent, opens the capture page, whose step 2 is the upload
     form the upload page draws; the upload below is made there. /drafts/new/ keeps its address and is used by the
     upload Retry step below and by IN-2. */
  await tab.click('[data-role="capture-agent"]');
  await waitPath(tab, '/capture/', { search: `?company=${W.companyId}` });
  await tab.waitForSelector('[data-role="step-upload"] [data-role="upload-form"]');
  const name = `weekly-brief-${W.run}`;
  const text = declaredOnly(`in1-${W.run}`);
  await tab.type('#agent-name', name);
  await tab.type('#passport-text', text);
  await j.capture(tab, 'upload-form');
  const creates = requestsSent(tab, 'POST', '/candidates');
  let from = tab.requests.length;
  /* INF-N2: while the upload is in flight the text box, the file input, the name and the button are held, so nothing
     typed then is left behind when the page moves to the draft of what was pressed. */
  const uploading = await holdNext(tab, 'POST', '/candidates');
  await tab.click('[data-role="upload"]');
  await uploading.held;
  await tab.type('#passport-text', `${text}\nA line typed while the upload was in flight.`);
  await tab.type('#agent-name', `${name}-typed-in-flight`);
  j.equal(
    'while the upload is in flight the text box, the file input, the name and the button are held, and the text and name are unchanged',
    await tab.evaluate(
      `({ readOnly: document.querySelector('#passport-text').readOnly, file: document.querySelector('#passport-file').disabled, name: document.querySelector('#agent-name').readOnly, button: document.querySelector('[data-role="upload"]').disabled, unchanged: document.querySelector('#passport-text').value === ${JSON.stringify(text)} && document.querySelector('#agent-name').value === ${JSON.stringify(name)} })`,
    ),
    { readOnly: true, file: true, name: true, button: true, unchanged: true },
  );
  await j.capture(tab, 'upload-in-flight', { anchor: '[data-role="upload-form"]' });
  await uploading.release();
  await waitPath(tab, '/draft/');
  j.equal('one upload, answered 201', (await apiRequests(tab, j.origin, from)).filter((x) => x.method === 'POST').map((x) => x.status), [201]);
  j.check(
    'the upload was text/markdown, carried the agent name and a random uuid as its Idempotency-Key',
    creates.length === 1 && creates[0].type === 'text/markdown' && creates[0].agent === name && UUID_V4.test(creates[0].key ?? ''),
    creates,
  );
  const cid = await candidateOf(tab);
  /* The stored bytes are compared by the row's own content_sha256: psql's output is trimmed, so the text itself is not. */
  const storedSha = (id) => one(`select encode(content_sha256,'hex') from app.candidate_versions where id = '${id}'`);
  j.equal('the stored text is the pasted text, byte for byte', storedSha(cid), sha256(text));
  await tab.waitForSelector('[data-role="stored"] [data-role="content"]');
  j.equal('the preview pane shows the stored text', sha256((await paneText(tab)) ?? ''), sha256(text));
  j.equal(
    "the preview's title is the server's derived record's",
    await textOf(tab, '[data-role="stored"] [data-role="passport-title"]'),
    one(`select derived->>'title' from app.candidate_versions where id = '${cid}'`),
  );
  const notInstalled = Number(one(`select count(*) from app.candidate_versions, jsonb_array_elements(derived->'needs') n where id = '${cid}' and (n->>'installable')::boolean is not true`));
  j.equal('the server marks the one capability version 0.1 does not install, so the next check compares a real row', notInstalled, 1);
  j.equal(
    'every capability the server marks not installable reads "declared, not installed"',
    await tab.evaluate(`[...document.querySelectorAll('[data-role="needs-table"] tr[data-installable="no"]')].filter((r) => r.textContent.includes('declared, not installed')).length`),
    notInstalled,
  );
  j.check('the losses table renders', await exists(tab, '[data-role="stored"] [data-role="losses"] [data-role="losses-table"]'));
  j.check(
    'the stored draft may be submitted: no unsaved notice, Submit enabled',
    await tab.evaluate(`document.querySelector('[data-state="unsaved"]').hidden === true && document.querySelector('[data-role="submit"]').disabled === false`),
  );
  await j.capture(tab, 'draft-preview', { anchor: '[data-role="stored"]' });

  const revised = declaredOnly(`in1-${W.run}-revised`);
  await tab.type('#draft-text', revised);
  j.check(
    'an unsaved edit holds Submit and says why',
    await tab.evaluate(`document.querySelector('[data-state="unsaved"]').hidden === false && document.querySelector('[data-role="submit"]').disabled === true`),
  );
  const saves = requestsSent(tab, 'PUT', `/candidates/${cid}`);
  await tab.click('[data-role="save"]');
  await tab.waitForSelector('[data-state="saved"]');
  j.equal('the save stored version 2 with the edited text', one(`select version||':'||encode(content_sha256,'hex') from app.candidate_versions where id = '${cid}'`), `2:${sha256(revised)}`);
  j.check('the save carried If-Match 1, text/markdown and a key', saves.length === 1 && saves[0].ifMatch === '1' && saves[0].type === 'text/markdown' && UUID_V4.test(saves[0].key ?? ''), saves);
  await tab.waitForSelector('[data-role="stored"] [data-role="content"]');
  j.equal('the preview now shows the stored edit', sha256((await paneText(tab)) ?? ''), sha256(revised));

  await tab.type('#source-platform', 'Claude Code');
  await tab.click('#confidence-high');
  await tab.type('#permitted-data', 'Internal weekly reports, no client names');
  await tab.type('#dependencies', 'files.read');
  j.check(
    'INT-F10: each colleague shows their roles, and the form says that some have no display name',
    (await textOf(tab, `label[for="colleague-${W.ms.it}"] [data-role="colleague-roles"]`)) === '· IT reviewer, Member' &&
      (await exists(tab, '[data-role="unnamed-colleagues"]')),
  );
  await tab.click(`#colleague-${W.ms.second}`);
  await tab.type('#outside-names', 'Jane Doe (former intern)');
  /* INTR-F1: submitting sends the stored draft, so an edit or a chosen file with the confirmation open closes it, says
     why and holds Submit for review; nothing is submitted until the form matches the stored draft again. */
  const submitsFrom = tab.requests.length;
  const heldState = `({ submitNow: Boolean(document.querySelector('[data-role="confirm-submit-now"]')), closed: Boolean(document.querySelector('[data-role="submit-status"] [data-state="confirm-closed"]')), unsaved: document.querySelector('[data-state="unsaved"]').hidden === false, submitHeld: document.querySelector('[data-role="submit"]').disabled })`;
  const closedHeld = { submitNow: false, closed: true, unsaved: true, submitHeld: true };
  await tab.click('[data-role="submit"]');
  await tab.waitForSelector('[data-role="confirm-submit-now"]');
  await tab.type('#draft-text', `${revised}\nA line typed with the confirmation open.`);
  j.equal('an edit with the confirmation open closes it and says why, and Submit for review is held', await tab.evaluate(heldState), closedHeld);
  await j.capture(tab, 'confirm-closed', { anchor: '[data-role="submit-section"]' });
  await tab.type('#draft-text', revised);
  j.equal('the box back to the stored text releases Submit for review', await tab.evaluate(`document.querySelector('[data-role="submit"]').disabled`), false);
  await tab.click('[data-role="submit"]');
  await tab.waitForSelector('[data-role="confirm-submit-now"]');
  await chooseFile(tab, '#draft-file', scratchFile(ctx, 'in1-chosen.md', Buffer.from(revised, 'utf8')));
  await tab.waitForSelector('[data-role="chosen-file"] [data-role="clear-file"]');
  j.equal('a chosen file counts as unsaved: with the confirmation open it closes it the same way, and holds Submit for review', await tab.evaluate(heldState), closedHeld);
  await tab.click('[data-role="clear-file"]');
  j.equal('clearing the file releases Submit for review', await tab.evaluate(`document.querySelector('[data-role="submit"]').disabled`), false);
  j.equal(
    'nothing was submitted while the form held changes: no submit request, the version still a draft',
    [(await apiRequests(tab, j.origin, submitsFrom)).filter((x) => x.path.endsWith('/submit')).length, one(`select state from app.candidate_versions where id = '${cid}'`)],
    [0, 'draft'],
  );

  await tab.click('[data-role="submit"]');
  await tab.waitForSelector('[data-role="confirm-submit"]');
  j.equal('nothing is submitted before the confirmation', one(`select state from app.candidate_versions where id = '${cid}'`), 'draft');
  await j.capture(tab, 'submit-confirm', { anchor: '[data-role="submit-section"]' });
  from = tab.requests.length;
  /* INTR-F14 and INTR-F2: while the submit is in flight Submit for review and the text box are held, so a second
     confirmation cannot be opened and nothing typed then is lost when the submitted page is drawn. */
  const submitting = await holdNext(tab, 'POST', `/candidates/${cid}/submit`);
  await tab.click('[data-role="confirm-submit-now"]');
  await submitting.held;
  await tab.type('#draft-text', `${revised}\nA line typed while the submit was in flight.`);
  await tab.click('[data-role="submit"]');
  j.equal(
    'while the submit is in flight: Submit for review held, no second confirmation, the text box read-only and unchanged, the reason shown',
    await tab.evaluate(
      `({ submitHeld: document.querySelector('[data-role="submit"]').disabled, confirmations: document.querySelectorAll('[data-role="confirm-submit"]').length, readOnly: document.querySelector('#draft-text').readOnly, unchanged: document.querySelector('#draft-text').value === ${JSON.stringify(revised)}, submitting: Boolean(document.querySelector('[data-role="submit-status"] [data-state="submitting"]')) })`,
    ),
    { submitHeld: true, confirmations: 0, readOnly: true, unchanged: true, submitting: true },
  );
  j.equal(
    'INF-N8: while the submit is in flight the declarations are held too',
    await tab.evaluate(
      `({ typed: ['#source-platform', '#permitted-data', '#dependencies', '#outside-names'].every((s) => document.querySelector(s).readOnly), chosen: [...document.querySelectorAll('[data-role="submit-form"] input[type="radio"], [data-role="submit-form"] input[type="checkbox"]')].every((c) => c.disabled) })`,
    ),
    { typed: true, chosen: true },
  );
  await submitting.release();
  await tab.waitForSelector('[data-role="not-draft-link"]');
  j.equal('one submit, answered 200', (await apiRequests(tab, j.origin, from)).filter((x) => x.path.endsWith('/submit')).map((x) => x.status), [200]);
  j.equal('the version is submitted', one(`select state from app.candidate_versions where id = '${cid}'`), 'submitted');
  j.equal(
    'the contributors are the author, the submitter, the named colleague and the named outsider',
    one(`select string_agg(kind||':'||coalesce(membership_id::text, display_name), ',' order by kind) from app.candidate_contributors where candidate_id = '${cid}'`),
    [`author:${W.ms.author}`, `declared_member:${W.ms.second}`, 'declared_offline:Jane Doe (former intern)', `submitter:${W.ms.author}`].join(','),
  );
  j.check('the draft page shows it submitted, with no editor', (await exists(tab, '[data-state="submitted"]')) && !(await exists(tab, '#draft-text')));

  await tab.click('[data-role="not-draft-link"]');
  await waitPath(tab, '/submitted/');
  await tab.waitForSelector('[data-role="contributors"]');
  j.check(
    'the submitted page says it waits for review, shows the frozen attestation with its submitter, and marks the outside name unverified',
    (await exists(tab, '[data-role="candidate-head"][data-state="submitted"]')) &&
      (await exists(tab, '[data-role="attestation"]')) &&
      (await tab.text('[data-role="attestation"]')).includes('Submitted by') &&
      (await exists(tab, '[data-role="contributors"] [data-kind="declared_offline"] [data-role="unverified"]')),
  );
  j.equal('the submitted page shows the stored text', sha256((await tab.evaluate(`document.querySelector('[data-role="passport"] [data-role="content"]')?.textContent ?? ''`)) ?? ''), sha256(revised));
  j.equal(
    'the submitted page shows the losses table with its pending row, beside the capability declared and not installed (product rules 2 and 3)',
    await tab.evaluate(
      `({ losses: [...document.querySelectorAll('[data-role="passport"] [data-role="losses-table"] tbody tr')].map((r) => [...r.children].map((c) => c.textContent)), declaredOnly: document.querySelectorAll('[data-role="passport"] [data-role="needs-table"] tr[data-installable="no"]').length })`,
    ),
    { losses: [['Not installed yet; losses not assessed']], declaredOnly: notInstalled },
  );
  await j.capture(tab, 'submitted');

  await signedIn(j, W, 'it');
  const reviewer = await j.tab(W.users.it.identity, 'reviewer-queue');
  await reviewer.navigate(companyUrl(j, '/reviews/', W.companyId));
  await reviewer.waitForSelector(`[data-role="awaiting"] [data-candidate="${cid}"]`);
  j.check('a reviewer finds it in the existing review queue, under its agent name', (await reviewer.text(`[data-candidate="${cid}"]`)).includes(name));
  await j.capture(reviewer, 'reviewer-queue');

  await tab.navigate(`${j.origin}/drafts/?company=${W.companyId}`);
  await tab.waitForSelector(`[data-candidate="${cid}"]`);
  j.equal('Your agents lists the version, submitted, linking to its page', await tab.evaluate(`document.querySelector('[data-candidate="${cid}"] [data-role="version-link"]').getAttribute('href')`), `/submitted/?candidate=${cid}`);
  await j.capture(tab, 'list-one');

  /* INTR-F2 on a second draft: a save in flight holds the text box and the file input, so a line typed then cannot be
     replaced by the page the answer draws; and the Retry of a save whose answer was lost resends that press's bytes, so
     once the box has changed it sends nothing, says so, and Save composes a new attempt from the box. */
  const D = await draftBy(ctx, W, 'author');
  const stored = (id) => one(`select version||':'||encode(content_sha256,'hex') from app.candidate_versions where id = '${id}'`);
  const edit = await j.tab(W.users.author.identity, 'author-save-in-flight');
  await edit.setViewport(PHONE);
  await edit.navigate(draftUrl(j, D.candidateId));
  await edit.waitForSelector('#draft-text');
  const pressed = passportText(`in1-${W.run}-pressed`);
  await edit.type('#draft-text', pressed);
  /* INF-N1: declarations typed before a save are not stored, so the page the save draws carries them over. */
  const declared = { source: 'Claude Code', confidence: 'low', permitted: 'Synthetic test data only', colleague: true, names: 'Jane Doe' };
  await edit.type('#source-platform', declared.source);
  await edit.click('#confidence-low');
  await edit.type('#permitted-data', declared.permitted);
  await edit.click(`#colleague-${W.ms.it}`);
  await edit.type('#outside-names', declared.names);
  const declarationsOn = (t) =>
    t.evaluate(
      `({ source: document.querySelector('#source-platform').value, confidence: document.querySelector('input[name="confidence"]:checked')?.value ?? null, permitted: document.querySelector('#permitted-data').value, colleague: document.querySelector('#colleague-${W.ms.it}').checked, names: document.querySelector('#outside-names').value })`,
    );
  const saving = await holdNext(edit, 'PUT', `/candidates/${D.candidateId}`);
  await edit.click('[data-role="save"]');
  await saving.held;
  await edit.type('#draft-text', `${pressed}\nA line typed while the save was in flight.`);
  j.equal(
    'while the save is in flight the text box is read-only and unchanged, and the file input is held',
    await edit.evaluate(`({ readOnly: document.querySelector('#draft-text').readOnly, file: document.querySelector('#draft-file').disabled, unchanged: document.querySelector('#draft-text').value === ${JSON.stringify(pressed)} })`),
    { readOnly: true, file: true, unchanged: true },
  );
  await saving.release();
  await edit.waitForSelector('[data-state="saved"]');
  await edit.waitForSelector('#draft-text');
  j.equal('the save stored version 2 as pressed, and the box shows it', [stored(D.candidateId), sha256((await boxValue(edit)) ?? '')], [`2:${sha256(pressed)}`, sha256(pressed)]);
  j.equal('the declarations typed before the save are in the form the save drew (INF-N1)', await declarationsOn(edit), declared);

  const first = passportText(`in1-${W.run}-first`);
  const later = passportText(`in1-${W.run}-later`);
  await edit.type('#draft-text', first);
  const keys = requestsSent(edit, 'PUT', `/candidates/${D.candidateId}`);
  const lost = loseNextAnswer(edit, `/candidates/${D.candidateId}`);
  await edit.click('[data-role="save"]');
  j.equal('the save reached the service, which answered 200, and its answer was lost on the way back', (await lost).status, 200);
  await edit.waitForSelector('[data-role="save-status"] [data-role="retry"]');
  j.equal('the service stored the first text as version 3', stored(D.candidateId), `3:${sha256(first)}`);
  await edit.type('#draft-text', later);
  /* The first save's notice is still at the top of the page: mark it, so a notice drawn by the Retry is told apart. */
  await edit.evaluate(`(document.querySelectorAll('[data-state="saved"]').forEach((n) => n.setAttribute('data-earlier', 'yes')), true)`);
  let sent = edit.requests.length;
  await edit.click('[data-role="save-status"] [data-role="retry"]');
  const changedSaid = '[data-role="save-status"] [data-state="save-changed"]';
  const savedAgain = '[data-state="saved"]:not([data-earlier])';
  await edit.until(async () => (await exists(edit, changedSaid)) || (await exists(edit, savedAgain)), { what: 'the answer to Retry' });
  j.equal(
    'Retry after an edit sends nothing and says why, and draws no saved notice; the box keeps the later text, the store its version 3',
    [(await apiRequests(edit, j.origin, sent)).filter((x) => x.method === 'PUT').length, await exists(edit, changedSaid), await exists(edit, savedAgain), sha256((await boxValue(edit)) ?? ''), stored(D.candidateId)],
    [0, true, false, sha256(later), `3:${sha256(first)}`],
  );
  await j.capture(edit, 'retry-after-edit', { anchor: '[data-role="edit"]' });
  sent = edit.requests.length;
  await edit.click('[data-role="save"]');
  await edit.waitForSelector('[data-role="save-status"] [data-role="load-stored"]');
  j.equal(
    'Save composes a new attempt from the box, with a new key and the version the page read; the lost save was stored, so the service answers that the draft changed',
    [(await apiRequests(edit, j.origin, sent)).filter((x) => x.method === 'PUT').map((x) => `${x.status} ${x.code}`), keys.length, keys[1]?.key !== keys[0]?.key, keys[1]?.ifMatch],
    [['409 E_VERSION_CONFLICT'], 2, true, '2'],
  );
  j.equal('and the later text is still in the box, not in the store', [sha256((await boxValue(edit)) ?? ''), stored(D.candidateId)], [sha256(later), `3:${sha256(first)}`]);

  /* INF-N2 on the upload page: the Retry of an upload whose answer was lost resends that press's bytes and name under
     its key, and a stored upload moves the page to the draft of what was pressed, so once the text or the name has
     changed Retry sends nothing, says so and keeps the page; Upload and check composes a new attempt from the form. */
  const up = await j.tab(W.users.author.identity, 'author-upload-retry');
  await up.setViewport(PHONE);
  await up.navigate(`${j.origin}/drafts/new/?company=${W.companyId}`);
  await up.waitForSelector('[data-role="upload-form"]');
  const agentsNamed = (agentName) => Number(one(`select count(*) from app.agents where name = '${agentName}'`));
  const firstUpload = { name: `retry-first-${W.run}`, text: passportText(`in1-${W.run}-upload-first`) };
  const laterUpload = { name: `retry-later-${W.run}`, text: passportText(`in1-${W.run}-upload-later`) };
  await up.type('#agent-name', firstUpload.name);
  await up.type('#passport-text', firstUpload.text);
  const uploads = requestsSent(up, 'POST', '/candidates');
  const lostUpload = loseNextAnswer(up, '/candidates');
  await up.click('[data-role="upload"]');
  j.equal('the upload reached the service, which answered 201, and its answer was lost on the way back', (await lostUpload).status, 201);
  await up.waitForSelector('[data-role="upload-status"] [data-role="retry"]');
  j.equal('the service stored the first upload as a new agent', agentsNamed(firstUpload.name), 1);
  await up.type('#passport-text', laterUpload.text);
  await up.type('#agent-name', laterUpload.name);
  sent = up.requests.length;
  await up.click('[data-role="upload-status"] [data-role="retry"]');
  const uploadChanged = '[data-role="upload-status"] [data-state="upload-changed"]';
  await up.until(async () => (await exists(up, uploadChanged)) || (await up.location()).pathname === '/draft/', { what: 'the answer to Retry' });
  j.equal(
    'Retry after the text and the name changed sends nothing and says why; the page stays on the upload with the later text and name, and no agent has the later name',
    [
      (await apiRequests(up, j.origin, sent)).filter((x) => x.method === 'POST').length,
      await exists(up, uploadChanged),
      (await up.location()).pathname,
      sha256((await up.evaluate(`document.querySelector('#passport-text')?.value ?? ''`)) ?? ''),
      await up.evaluate(`document.querySelector('#agent-name')?.value ?? null`),
      agentsNamed(laterUpload.name),
    ],
    [0, true, '/drafts/new/', sha256(laterUpload.text), laterUpload.name, 0],
  );
  await j.capture(up, 'upload-retry-after-edit', { anchor: '[data-role="upload-form"]' });
  sent = up.requests.length;
  await up.click('[data-role="upload"]');
  await waitPath(up, '/draft/');
  j.equal(
    'Upload and check composes a new attempt from the form: a new key and the later name, answered 201, and the new draft holds the later text',
    [(await apiRequests(up, j.origin, sent)).filter((x) => x.method === 'POST').map((x) => x.status), uploads.length, uploads[1]?.key !== uploads[0]?.key, uploads[1]?.agent, storedSha(await candidateOf(up))],
    [[201], 2, true, laterUpload.name, sha256(laterUpload.text)],
  );

  /* INTRR-F1: one write at a time. A save of the unchanged text, pressed with the confirmation open, closes it and holds
     Submit for review, so no submit can start inside the save and give the text box back before the save redraws the
     page (evidence/intake-recheck.md RR-8). A fresh tab, so no earlier notice answers the wait for this save's. */
  const S = await draftBy(ctx, W, 'author');
  const one1 = await j.tab(W.users.author.identity, 'author-one-write');
  await one1.setViewport(PHONE);
  await one1.navigate(draftUrl(j, S.candidateId));
  await one1.waitForSelector('#draft-text');
  await one1.click('[data-role="submit"]');
  await one1.waitForSelector('[data-role="confirm-submit-now"]');
  const pressedS = await boxValue(one1);
  sent = one1.requests.length;
  const savingS = await holdNext(one1, 'PUT', `/candidates/${S.candidateId}`);
  await one1.click('[data-role="save"]');
  await savingS.held;
  await one1.click('[data-role="submit"]');
  await one1.type('#draft-text', `${pressedS}\nA line typed while the save was in flight.`);
  j.equal(
    'INTRR-F1: while a save of the unchanged text is in flight the open confirmation is closed, Submit for review is held and opens none, and the text box is read-only and unchanged',
    await one1.evaluate(
      `({ confirmations: document.querySelectorAll('[data-role="confirm-submit"]').length, submitHeld: document.querySelector('[data-role="submit"]').disabled, readOnly: document.querySelector('#draft-text').readOnly, unchanged: document.querySelector('#draft-text').value === ${JSON.stringify(pressedS)} })`,
    ),
    { confirmations: 0, submitHeld: true, readOnly: true, unchanged: true },
  );
  await j.capture(one1, 'save-holds-submit', { anchor: '[data-role="submit-section"]' });
  await savingS.release();
  await one1.waitForSelector('[data-state="saved"]');
  j.equal(
    'the save answered, no submit request was sent, and the version is still a draft',
    [(await apiRequests(one1, j.origin, sent)).filter((x) => x.path.endsWith('/submit')).length, one(`select state from app.candidate_versions where id = '${S.candidateId}'`)],
    [0, 'draft'],
  );
}

/** IN-2: the content gate refuses; the page shows the server's reasons and nothing is stored. */
export async function in2(ctx, j) {
  const W = await intakeWorld(ctx);
  await signedIn(j, W, 'author');
  const tab = await j.tab(W.users.author.identity, 'refused');
  await tab.navigate(`${j.origin}/drafts/new/?company=${W.companyId}`);
  await tab.waitForSelector('[data-role="upload-form"]');
  const name = `refused-${W.run}`;
  await tab.type('#agent-name', name);
  /* tests/e3/stack/routes.test.mjs case 8: a lone carriage return after section 1's prose, and the line it is on. */
  const text = passportText(`in2-${W.run}`).replace(PROSE, `${PROSE}${CR}More prose.`);
  const line = text.slice(0, text.indexOf(PROSE)).split('\n').length;
  await chooseFile(tab, '#passport-file', scratchFile(ctx, 'case8-carriage-return.md', Buffer.from(text, 'utf8')));
  await tab.waitForSelector('[data-role="chosen-file"] [data-role="clear-file"]');
  const before = inCompany(W.companyId);
  let from = tab.requests.length;
  await tab.click('[data-role="upload"]');
  await tab.waitForSelector('[data-role="problems-table"]');
  /* The status from the network and the code from the page's reading of the answer: Chrome does not hand the harness the
     body of an answer to a request whose body was a chosen file (the harness records 'unreadable'). */
  j.equal('the upload answered 422', (await apiRequests(tab, j.origin, from)).filter((x) => x.method === 'POST').map((x) => x.status), [422]);
  j.equal('the refusal the page read is E_CANONICAL', await tab.evaluate(`document.querySelector('[data-state="refused"]')?.getAttribute('data-code') ?? null`), 'E_CANONICAL');
  j.equal("the server's message is shown as sent", await textOf(tab, '[data-role="server-message"]'), messageFor('E_CANONICAL'));
  j.equal(
    'the problem table lists the carriage return on its line, by its code',
    await tab.evaluate(`[...document.querySelectorAll('[data-role="problems-table"] tbody tr')].map((r) => [...r.children].map((c) => c.textContent))`),
    [[`line ${line}`, 'E_CANONICAL', '']],
  );
  j.check(
    'nothing was stored: no agent of that name, no version, no audit row',
    one(`select count(*) from app.agents where name = '${name}'`) === '0' && JSON.stringify(inCompany(W.companyId)) === JSON.stringify(before),
  );
  j.check('the page stays on the upload with the chosen file, and shows no text of the passport', (await tab.location()).pathname === '/drafts/new/' && (await exists(tab, '[data-role="clear-file"]')) && !(await tab.text('main')).includes('More prose'));
  await j.capture(tab, 'refused-upload', { anchor: '[data-role="upload-status"]' });

  /* The page's own bound: the E3 F1 fixture, the largest accepted passport plus one byte. */
  const big = Buffer.concat([largePassport(`in2-${W.run}`), Buffer.from(' ')]);
  await chooseFile(tab, '#passport-file', scratchFile(ctx, 'over-the-bound.md', big));
  from = tab.requests.length;
  await tab.click('[data-role="upload"]');
  await tab.waitForSelector('[data-state="not-sent"]');
  j.equal('a passport of 262,145 bytes is refused on the page and no request is sent', (await apiRequests(tab, j.origin, from)).filter((x) => x.method === 'POST').length, 0);
  j.check('the page names both sizes', (await textOf(tab, '[data-state="not-sent"]')).includes('262,145 bytes') && (await textOf(tab, '[data-state="not-sent"]')).includes('262,144 bytes'));

  const D = await draftBy(ctx, W, 'author');
  const draft = await j.tab(W.users.author.identity, 'refused-save');
  await draft.navigate(draftUrl(j, D.candidateId));
  await draft.waitForSelector('#draft-file');
  await chooseFile(draft, '#draft-file', scratchFile(ctx, 'case8-save.md', Buffer.from(text, 'utf8')));
  const stored = one(`select version||':'||encode(content_sha256,'hex') from app.candidate_versions where id = '${D.candidateId}'`);
  await draft.click('[data-role="save"]');
  await draft.waitForSelector('[data-role="save-status"] [data-role="problems-table"]');
  j.check('the save refusal says nothing was saved', (await textOf(draft, '[data-role="save-status"] [data-role="nothing-stored"]')).startsWith('The content checks refused this text, so nothing was saved.'));
  j.equal('the draft is unchanged', one(`select version||':'||encode(content_sha256,'hex') from app.candidate_versions where id = '${D.candidateId}'`), stored);
  j.equal('the preview still shows the stored draft', sha256((await paneText(draft)) ?? ''), sha256(D.text));
  await j.capture(draft, 'refused-save', { anchor: '[data-role="edit"]' });
}

/** IN-3: another member's draft is not available on any intake page. */
export async function in3(ctx, j) {
  const W = await intakeWorld(ctx);
  const D = await draftBy(ctx, W, 'author');
  await signedIn(j, W, 'second');
  const tab = await j.tab(W.users.second.identity, 'other-draft');
  const marker = D.text.slice(D.text.indexOf(PROSE), D.text.indexOf(PROSE) + PROSE.length + 20);
  for (const [label, url] of [
    ['draft', draftUrl(j, D.candidateId)],
    ['submitted', submittedUrl(j, D.candidateId)],
    ['new version', `${j.origin}/drafts/new/?candidate=${D.candidateId}`],
  ]) {
    const from = tab.requests.length;
    await tab.navigate(url);
    await tab.waitForSelector('[data-state="not-found"]');
    j.equal(`${label}: the read answered 404`, (await apiRequests(tab, j.origin, from)).filter((x) => x.path.endsWith('/review')).map((x) => x.status), [404]);
    j.check(`${label}: no editor, no stored text, nothing of the draft on the page`, !(await exists(tab, 'textarea')) && !(await exists(tab, '[data-role="content"]')) && !(await tab.text('main')).includes(marker));
    if (label === 'draft') await j.capture(tab, 'other-member-draft');
  }
  await tab.navigate(`${j.origin}/drafts/?company=${W.companyId}`);
  await tab.waitForSelector('[data-role="others"]');
  j.check("the second member's own list does not carry it", !(await exists(tab, `[data-candidate="${D.candidateId}"]`)));
  await j.cookies(tab, 2, 'the second member signed in');
}

/** IN-4: removed while the draft is open. */
export async function in4(ctx, j) {
  const W = await intakeWorld(ctx);
  const D = await draftBy(ctx, W, 'leaver');
  await signedIn(j, W, 'leaver');
  const tab = await j.tab(W.users.leaver.identity, 'removed');
  await tab.navigate(draftUrl(j, D.candidateId));
  await tab.waitForSelector('#draft-text');
  await tab.type('#draft-text', passportText(`in4-unsaved-${W.run}`));
  await removeMembership(ctx, W, 'leaver');
  const from = tab.requests.length;
  await tab.click('[data-role="save"]');
  await tab.waitForSelector('[data-state="not-found"]');
  j.equal('the save after the removal answered 404', (await apiRequests(tab, j.origin, from)).filter((x) => x.method === 'PUT').map((x) => x.status), [404]);
  j.check('the page, text box included, is replaced by the not-available state', !(await exists(tab, '#draft-text')) && !(await exists(tab, '[data-role="content"]')));
  j.equal('the draft is unchanged: version 1 with its first text', one(`select version||':'||encode(content_sha256,'hex') from app.candidate_versions where id = '${D.candidateId}'`), `1:${sha256(D.text)}`);
  await j.capture(tab, 'removed-member');
  await tab.navigate(`${j.origin}/drafts/?company=${W.companyId}`);
  await tab.waitForSelector('[data-state="not-found"]');
  j.check('Your agents of that company is the not-found state', await exists(tab, '[data-state="not-found"] [data-role="home-link"]'));
}

/** IN-5: a suspended company. */
export async function in5(ctx, j) {
  const C = await smallCompany(ctx, 'in5');
  const D = await draftBy(ctx, C, 'member', { companyId: C.companyId, user: C.users.member });
  const { call } = await routes(ctx);
  const signin = await signIn(j, C.users.member.identity, C.users.member.email, { label: 'in5-sign-in' });
  await waitPath(signin, '/members/');
  ok(await call('operatorCompanyStatus', { user: operatorUser(ctx), params: { companyId: C.companyId }, body: { status: 'suspended', reasonCode: 'customer_request' } }), 'suspend');
  const tab = await j.tab(C.users.member.identity, 'suspended');
  await tab.setViewport(PHONE);
  let from = tab.requests.length;
  await tab.navigate(`${j.origin}/drafts/?company=${C.companyId}`);
  await tab.waitForSelector('[role="alert"][data-code]');
  j.equal('Your agents shows the list read refused with E_COMPANY_INACTIVE', (await apiRequests(tab, j.origin, from)).filter((x) => x.path.endsWith('/candidates')).map((x) => `${x.status} ${x.code}`), ['409 E_COMPANY_INACTIVE']);
  j.check("the server's message with the link home", (await textOf(tab, '[role="alert"][data-code="E_COMPANY_INACTIVE"] p')) === messageFor('E_COMPANY_INACTIVE') && (await exists(tab, '[data-code="E_COMPANY_INACTIVE"] [data-role="home-link"]')));
  await j.capture(tab, 'suspended-list');
  from = tab.requests.length;
  await tab.navigate(`${j.origin}/drafts/new/?company=${C.companyId}`);
  await tab.waitForSelector('[data-state="inactive"]');
  j.check('the upload page shows the suspended sentence and no form', !(await exists(tab, '[data-role="upload-form"]')) && (await textOf(tab, '[data-state="inactive"] p')).startsWith('This company is suspended.'));
  j.equal('and sends no upload', (await apiRequests(tab, j.origin, from)).filter((x) => x.method === 'POST').length, 0);
  await j.capture(tab, 'suspended-upload');
  await tab.navigate(draftUrl(j, D.candidateId));
  await tab.waitForSelector('[data-state="not-found"]');
  j.check("the member's own draft is not available while the company is suspended", !(await exists(tab, '#draft-text')));
}

/** IN-6: changes requested, and the successor draft. */
export async function in6(ctx, j) {
  const W = await intakeWorld(ctx);
  const S = await submitted(ctx, W, { author: W.users.author });
  const envelopeId = await envelope(ctx, W, S.candidateId, { by: W.users.it });
  const reason = 'Name the shared folder it reads before this goes further.';
  await reviewed(ctx, S.candidateId, W.users.it, { envelopeId, role: 'it', decision: 'changes_requested', reason });
  await signedIn(j, W, 'author');
  const tab = await j.tab(W.users.author.identity, 'successor');
  await tab.navigate(`${j.origin}/drafts/?company=${W.companyId}`);
  await tab.waitForSelector(`[data-candidate="${S.candidateId}"][data-state="changes_requested"]`);
  await tab.click(`[data-candidate="${S.candidateId}"] [data-role="version-link"]`);
  await waitPath(tab, '/submitted/');
  await tab.waitForSelector('[data-state="changes-requested"]');
  j.check("the author sees the reviewer's reason", (await tab.text('[data-role="change-reasons"]')).includes(reason));
  await j.capture(tab, 'changes-requested');
  const from = tab.requests.length;
  await tab.click('[data-role="start-successor"]');
  await waitPath(tab, '/draft/');
  j.equal('one successor, answered 201', (await apiRequests(tab, j.origin, from)).filter((x) => x.path.endsWith('/successor')).map((x) => x.status), [201]);
  const next = await candidateOf(tab);
  j.equal('the new draft continues the version, by its author', one(`select state||':'||supersedes_candidate_id||':'||author_membership_id from app.candidate_versions where id = '${next}'`), `draft:${S.candidateId}:${W.ms.author}`);
  await tab.waitForSelector('[data-state="successor"]');
  j.equal('the text box holds the same text', sha256(await tab.evaluate(`document.querySelector('#draft-text').value`)), one(`select encode(content_sha256,'hex') from app.candidate_versions where id = '${S.candidateId}'`));
  j.check('its contributors carried over, marked as from an earlier version', await exists(tab, '[data-role="contributors"] [data-inherited="yes"]'));
  await j.capture(tab, 'successor-draft');
}
