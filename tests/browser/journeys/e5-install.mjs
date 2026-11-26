/* JI2 and JI3 (E5 design 1.2, 1.3, 1.4a, 4.1 and 4.3): the download and what it hands over, the read-only pane, the
   hash, the file the save control writes, the losses table in the third of its three states, and the report form in
   each of the four statuses with the losses rule said by the page before the server and then by the server itself; and
   the report held in flight and its Retry refused after an edit (INF-N4, evidence/capture-once.md).

   The save control is the one control of this product that is not a navigation, so it is checked as its own thing
   (pages design section 3's new rule): the bytes the browser wrote to disk are compared with the bytes in the pane and
   with the bytes the database stores, and the tab's documents are read for a blob URL that must never be among them. */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, sql } from '../../e3/stack/helpers.mjs';
import { apiRequests, sleep } from './common.mjs';
import { exists, holdNext, keysSent, loseNextAnswer, releaseUrl, signedIn, textOf, UUID_V4 } from './e4-common.mjs';
import { callAs, countWhere, declaredLossesPassport, e5release, e5world, emptyLossesPassport, storedAssembly } from './e5-common.mjs';

const paneText = (tab) => tab.evaluate(`document.querySelector('[data-role="assembled"]')?.textContent ?? null`);
const blobDocuments = (tab) => tab.documents.filter((d) => String(d.url).startsWith('blob:')).map((d) => String(d.url).slice(0, 12));

/** JI2: the download, the pane, the hash, the losses table after the answer, and the file the save control writes. */
export async function ji2(ctx, j) {
  const W = await e5world(ctx);
  const R = ctx.state.e5r1 ?? (await e5release(ctx, W, { text: declaredLossesPassport() }));
  ctx.state.e5r1 = R;
  const stored = JSON.parse(storedAssembly(R.releaseId));
  await signedIn(j, W, 'member');
  const tab = await j.tab(W.users.member.identity, 'download');
  await tab.navigate(releaseUrl(j, R.releaseId));
  await tab.waitForSelector('[data-role="download"]');

  const downloads = join(ROOT, '.scratch', 'browser', 'downloads', `${j.id}-${Date.now().toString(36)}`);
  rmSync(downloads, { recursive: true, force: true });
  mkdirSync(downloads, { recursive: true });
  let downloadsAllowed = null;
  for (const method of ['Browser.setDownloadBehavior', 'Page.setDownloadBehavior']) {
    if (downloadsAllowed) break;
    try {
      await tab.send(method, { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
      downloadsAllowed = method;
    } catch {
      downloadsAllowed = null;
    }
  }
  j.check('the browser was told where to write a saved file', downloadsAllowed !== null, downloadsAllowed);

  const before = countWhere('app.release_downloads', `release_id = '${R.releaseId}' and membership_id = '${W.ms.member}'`);
  const from = tab.requests.length;
  await tab.click('[data-role="download"]');
  await tab.waitForSelector('[data-role="assembled"]');
  const answers = (await apiRequests(tab, j.origin, from)).filter((x) => x.path.endsWith('/download'));
  j.equal('the download answers 200, once', answers.map((x) => x.status), [200]);
  j.equal('and carries no Idempotency-Key, by the decision of design 1.2', keysSent(tab, '/download').length, 0);
  j.equal(
    'one ledger row was written',
    countWhere('app.release_downloads', `release_id = '${R.releaseId}' and membership_id = '${W.ms.member}'`),
    before + 1,
  );
  j.equal('the pane holds the bytes the database stores, byte for byte', await paneText(tab), stored.content);
  j.check('the hash beside them is the stored assembled_sha256', (await textOf(tab, '[data-role="assembled-hash"]')).includes(stored.sha), stored.sha.slice(0, 12));
  j.check('with the sentence that says what to compare it with', (await textOf(tab, '[data-role="assembled-hash"]')).includes('Compare this with what you paste.'));
  j.check(
    'the losses table now renders the passport’s declared rows under their label (E5D-C-F8, state 3 of 3)',
    (await exists(tab, '[data-role="install-section"] [data-role="losses"][data-losses="declared"]')) &&
      (await textOf(tab, '[data-role="install-section"] [data-role="losses"]')).includes('Declared by the owner, not inferred'),
  );
  const lossesText = await textOf(tab, '[data-role="install-section"] [data-role="losses-table"]');
  j.check('with both declared rows', lossesText.includes('Label colour hints') && lossesText.includes('Twenty-record ceiling'), lossesText.slice(0, 120));
  await j.capture(tab, 'downloaded', { anchor: '[data-role="install-section"]' });

  /* The save control: the file the browser wrote, compared with the pane and with the stored bytes. */
  await tab.click('[data-role="save-file"]');
  let written = null;
  for (let i = 0; i < 60 && written === null; i++) {
    const files = existsSync(downloads) ? readdirSync(downloads).filter((f) => !f.endsWith('.crdownload')) : [];
    if (files.length) written = files[0];
    else await sleep(100);
  }
  j.check('the save control wrote one file, named from the agent, the target and the first eight of the hash', written !== null && written.endsWith('.md'), written);
  if (written) {
    const bytes = readFileSync(join(downloads, written), 'utf8');
    j.equal('whose bytes are the pane’s and the database’s', bytes, stored.content);
    j.check('and whose name carries the target and the first eight of the hash', written.includes('claude-ai') && written.includes(stored.sha.slice(0, 8)), written);
  }
  j.equal('no blob URL ever became a document of this tab', blobDocuments(tab), []);
  const here = await tab.location();
  j.equal('and the address is still the release page', here.pathname, '/release/');

  /* A second download is a second authorization, answered as one, and the label counts it rather than pretending the
     second request did not happen (design 3.3). */
  const from2 = tab.requests.length;
  await tab.click('[data-role="download"]');
  await tab.waitFor(`document.querySelector('[data-state="download-authorized"]')?.textContent.includes('2 times')`);
  j.equal(
    'a repeat download authorizes again and the page says how often, never that anything was installed',
    (await apiRequests(tab, j.origin, from2)).filter((x) => x.path.endsWith('/download')).map((x) => x.status),
    [200],
  );
  j.equal(
    'two ledger rows',
    countWhere('app.release_downloads', `release_id = '${R.releaseId}' and membership_id = '${W.ms.member}'`),
    before + 2,
  );
  rmSync(downloads, { recursive: true, force: true });
}

/** JI3: the report in each of the four statuses, and the losses rule refused by the page and then by the server. */
export async function ji3(ctx, j) {
  const W = await e5world(ctx);
  const R = ctx.state.e5r1 ?? (await e5release(ctx, W, { text: declaredLossesPassport() }));
  ctx.state.e5r1 = R;
  if (countWhere('app.release_downloads', `release_id = '${R.releaseId}' and membership_id = '${W.ms.member}'`) === 0)
    await callAs(ctx, 'releasesDownload', { user: W.users.member, params: { releaseId: R.releaseId } });
  await signedIn(j, W, 'member');
  const tab = await j.tab(W.users.member.identity, 'report');
  await tab.navigate(releaseUrl(j, R.releaseId));
  await tab.waitForSelector('[data-role="report-form"]');
  j.check('a member with an authorization is offered the report form', await exists(tab, '[data-role="report"]'));
  j.check(
    'the four statuses are the plain names of design 4.1 item 3',
    await tab.evaluate(
      `['pass','partial','fail','removed'].map((s) => document.querySelector('label[for="install-status-' + s + '"]')?.textContent).join('|') === 'It works|It partly works|It does not work|I have removed it'`,
    ),
  );
  await j.capture(tab, 'report-form', { anchor: '[data-role="report-section"]' });

  /* The page says the losses rule before the server does: partial with nothing typed sends no request at all. */
  const from = tab.requests.length;
  await tab.click('#install-status-partial');
  await tab.click('[data-role="report"]');
  await tab.waitForSelector('[data-role="losses-required"]');
  const attempted = (await apiRequests(tab, j.origin, from)).filter((x) => x.method === 'POST' && x.path.endsWith('/installations'));
  j.equal('the page refuses a partial report with no losses and sends nothing', attempted.length, 0);
  j.check(
    'and says why, in the page’s own words',
    (await textOf(tab, '[data-role="losses-required"]')).includes('This is required for a partial or a failed installation.'),
  );
  await j.capture(tab, 'losses-required', { anchor: '[data-role="report-section"]' });

  /* And the server says it again for the request the page would not send, built here instead of by the page. */
  const beforeRows = countWhere('app.installation_reports', `release_id = '${R.releaseId}'`);
  const refused = await callAs(ctx, 'installationsCreate', {
    user: W.users.member,
    params: { releaseId: R.releaseId },
    body: { status: 'partial', losses: null, assistance: null },
  });
  j.equal('the same report built by hand is refused by the server', [refused.status, refused.body?.code], [422, 'E_LOSSES_REQUIRED']);
  const blank = await callAs(ctx, 'installationsCreate', {
    user: W.users.member,
    params: { releaseId: R.releaseId },
    body: { status: 'fail', losses: '   ', assistance: null },
  });
  j.equal('and a losses field of white space alone is E_BODY_INVALID from the shared text rule (E5D-C-F9)', [blank.status, blank.body?.code], [422, 'E_BODY_INVALID']);
  j.equal('neither wrote a row', countWhere('app.installation_reports', `release_id = '${R.releaseId}'`), beforeRows);

  /* Then the four statuses in turn, each through the page. */
  /* The read and the write share this path (design 3.4, O10), so only the requests that carried a key are the
     attempts; a read carries none and is recorded as null. */
  const sent = keysSent(tab, '/installations');
  for (const [status, losses, assistance] of [
    ['partial', 'The calendar read is unavailable on this plan.', 'The owner supplied the report folder path by chat.'],
    ['pass', '', ''],
    ['fail', 'The source report format changed; totals are misread.', ''],
    ['removed', '', ''],
  ]) {
    const mark = tab.requests.length;
    await tab.waitForSelector('[data-role="report-form"]');
    await tab.click(`#install-status-${status}`);
    if (losses) await tab.type('#report-losses', losses);
    if (assistance) await tab.type('#report-assistance', assistance);
    await tab.click('[data-role="report"]');
    await tab.waitForSelector('[data-state="reported"]');
    const answers = (await apiRequests(tab, j.origin, mark)).filter((x) => x.method === 'POST' && x.path.endsWith('/installations'));
    j.equal(`a ${status} report answers 201`, answers.map((x) => x.status), [201]);
  }
  j.equal('four reports were written', countWhere('app.installation_reports', `release_id = '${R.releaseId}'`), beforeRows + 4);
  const keys = sent.filter((k) => k !== null);
  j.check(
    'each with an Idempotency-Key made once per attempt as a random uuid, and the reads with none',
    keys.length === 4 && keys.every((k) => UUID_V4.test(k)) && new Set(keys).size === 4 && sent.length > keys.length,
    { keys: keys.length, requests: sent.length },
  );
  j.equal(
    'and every row carries the source the server set, never one the caller chose',
    countWhere('app.installation_reports', `release_id = '${R.releaseId}' and source = 'recipient_app'`),
    beforeRows + 4,
  );

  await tab.waitForSelector('[data-role="installation-evidence"] [data-role="reports"]');
  const evidence = await textOf(tab, '[data-role="installation-evidence"]');
  j.check(
    'the page shows every report with its plain status name and the provenance label the service composed',
    ['It works', 'It partly works', 'It does not work', 'I have removed it'].every((name) => evidence.includes(name)) &&
      evidence.includes('Recipient-reported'),
    evidence.slice(0, 200),
  );
  j.check(
    'newest first, so the derived state and the first row agree',
    (await tab.evaluate(
      `document.querySelector('[data-role="installation-evidence"] [data-role="reports"] [data-report]')?.dataset.status ?? null`,
    )) === 'removed',
  );
  j.check(
    'and no installation label carries a refused word (the label gate of design 1.5, over the rendered page)',
    !/verified|validated|confirmed working|certified/i.test(evidence),
    evidence.slice(0, 200),
  );
  await j.capture(tab, 'reports-recorded', { anchor: '[data-role="installation-evidence"]' });

  /* A signed-in member reading their own catalog now sees the report beside the authorization, not instead of it. */
  await tab.navigate(`${j.origin}/catalog/?company=${W.companyId}`);
  await tab.waitForSelector(`[data-release="${R.releaseId}"]`);
  j.check(
    'the catalog row carries the authorization label and the newest report',
    (await textOf(tab, `[data-release="${R.releaseId}"] [data-role="authorization"]`)).startsWith('Download authorized') &&
      (await textOf(tab, `[data-release="${R.releaseId}"] [data-role="last-report"]`)).includes('I have removed it'),
  );
  await j.capture(tab, 'catalog-after-report');

  /* E5PW-R-F1. The declared rows live in the download answer alone, and this page lifetime made no download, so after a
     reload the losses table is pending whatever the member has reported. The pending row may not then say "not
     installed yet" to a member whose own newest report, four inches below on the same page, says otherwise. It says
     what the table will hold instead, and claims nothing about this member's installation. The table still renders. */
  await tab.navigate(releaseUrl(j, R.releaseId));
  await tab.waitForSelector('[data-role="install-section"] [data-role="losses"]');
  const pending = await textOf(tab, '[data-role="install-section"] [data-role="losses"]');
  j.check('after a reload the losses table still renders, in its pending state', pending.includes('Pending an installation'), pending.slice(0, 120));
  j.check(
    'and its row no longer tells a member who has reported that nothing is installed yet (E5PW-R-F1)',
    !pending.includes('Not installed yet; losses not assessed'),
    pending.slice(0, 200),
  );
  j.check(
    'it says what the table will hold, and claims no installation',
    pending.includes('The losses declared for this release are shown here when the service hands the block over.') &&
      !/\binstalled\b/.test(pending),
    pending.slice(0, 200),
  );
  j.check(
    'while the member s own newest report on the same page still says they removed it',
    (await textOf(tab, '[data-role="installation-evidence"] [data-role="reports"] [data-report]')).includes('I have removed it'),
  );
  await j.capture(tab, 'losses-pending-after-report', { anchor: '[data-role="install-section"]' });

  /* E5C-R-F3, added by the E6 pages lane (evidence/batch-2-review.md): a block whose owner declared nothing, handed
     over in this page lifetime to a member who has reported. The table stays pending, because nothing was declared,
     and its row must not promise that the losses appear once the block is handed over: it has been. */
  const E = await e5release(ctx, W, { text: emptyLossesPassport() });
  await tab.navigate(releaseUrl(j, E.releaseId));
  await tab.waitForSelector('[data-role="download"]');
  await tab.click('[data-role="download"]');
  await tab.waitForSelector('[data-role="assembled"]');
  /* The member reports on the same page; the answer stays in hand for the page's life, so the row now sees both. */
  await tab.click('[data-role="report"]');
  await tab.waitForSelector('[data-state="reported"]');
  await tab.waitForSelector('[data-role="installation-evidence"] [data-role="reports"] [data-report]');
  j.check('the block is still in hand after the report, on the same page', await exists(tab, '[data-role="assembled"]'));
  const inHand = await textOf(tab, '[data-role="install-section"] [data-role="losses"]');
  j.check(
    'a block in hand that declared nothing: the table still renders, pending, and says the owner declared nothing (E5C-R-F3)',
    (await exists(tab, '[data-role="install-section"] [data-role="losses"][data-losses="pending"]')) &&
      inHand.includes('The owner declared nothing in this section of the block you were given. Nothing has been assessed.') &&
      !inHand.includes('shown here when the service hands the block over') &&
      !/nothing was lost|no loss/i.test(inHand),
    inHand.slice(0, 200),
  );
  await j.capture(tab, 'losses-nothing-declared-in-hand', { anchor: '[data-role="install-section"]' });

  /* INF-N4, on the same release: the report is read at the press and held until its answer, and its Retry resends that
     press only while the form is unchanged, so losses edited after a lost answer are never replaced by the pressed ones
     without a word. Every earlier notice is marked first, so a wait sees only the notice this step draws. */
  const reportsOn = (releaseId) => countWhere('app.installation_reports', `release_id = '${releaseId}'`);
  const newestLosses = (releaseId) =>
    sql(`select coalesce(losses, '') from app.installation_reports where release_id = '${releaseId}' order by reported_at desc, id desc limit 1`).trim();
  const markEarlier = () => tab.evaluate(`(document.querySelectorAll('[data-state="reported"]').forEach((n) => n.setAttribute('data-earlier', 'yes')), true)`);
  const reportedNow = '[data-state="reported"]:not([data-earlier])';
  const heldLosses = 'The calendar read is off; the losses as pressed while held.';
  await tab.click('#install-status-partial');
  await tab.type('#report-losses', heldLosses);
  await markEarlier();
  const reporting = await holdNext(tab, 'POST', '/installations');
  await tab.click('[data-role="report"]');
  await reporting.held;
  await tab.type('#report-losses', `${heldLosses} A line typed while the report was in flight.`);
  j.equal(
    'INF-N4: while the report is in flight the statuses, the losses and the help fields and the button are held, and the losses are unchanged',
    await tab.evaluate(
      `({ statuses: [...document.querySelectorAll('input[name="install-status"]')].every((c) => c.disabled), losses: document.querySelector('#report-losses').readOnly, assistance: document.querySelector('#report-assistance').readOnly, button: document.querySelector('[data-role="report"]').disabled, unchanged: document.querySelector('#report-losses').value === ${JSON.stringify(heldLosses)} })`,
    ),
    { statuses: true, losses: true, assistance: true, button: true, unchanged: true },
  );
  await reporting.release();
  await tab.waitForSelector(reportedNow);
  j.equal('the held report answered and was stored with the losses as pressed', newestLosses(E.releaseId), heldLosses);

  const pressedLosses = 'The calendar read is off; the losses as pressed before the answer was lost.';
  const editedLosses = 'The calendar and the mail reads are off; the losses as edited after the answer was lost.';
  await tab.waitForSelector('[data-role="report-form"]');
  await tab.click('#install-status-partial');
  await tab.type('#report-losses', pressedLosses);
  const rows = reportsOn(E.releaseId);
  const reportKeys = keysSent(tab, '/installations');
  const lostReport = loseNextAnswer(tab, '/installations');
  await tab.click('[data-role="report"]');
  j.equal('the report reached the service, which answered 201, and its answer was lost', (await lostReport).status, 201);
  await tab.waitForSelector('[data-role="report-status"] [data-role="retry"]');
  await tab.type('#report-losses', editedLosses);
  await markEarlier();
  let mark = tab.requests.length;
  await tab.click('[data-role="report-status"] [data-role="retry"]');
  const reportChanged = '[data-role="report-status"] [data-state="report-changed"]';
  await tab.until(async () => (await exists(tab, reportChanged)) || (await exists(tab, reportedNow)), { what: 'the answer to Retry' });
  j.equal(
    'INF-N4: Retry after the losses changed sends nothing and says why, and draws no recorded notice; the box keeps the edit, the store the pressed losses',
    [
      (await apiRequests(tab, j.origin, mark)).filter((x) => x.method === 'POST' && x.path.endsWith('/installations')).length,
      await exists(tab, reportChanged),
      await exists(tab, reportedNow),
      await tab.evaluate(`document.querySelector('#report-losses')?.value ?? null`),
      [reportsOn(E.releaseId), newestLosses(E.releaseId)],
    ],
    [0, true, false, editedLosses, [rows + 1, pressedLosses]],
  );
  await j.capture(tab, 'report-retry-after-edit', { anchor: '[data-role="report-section"]' });
  mark = tab.requests.length;
  await tab.click('[data-role="report"]');
  await tab.waitForSelector(reportedNow);
  const attempts = reportKeys.filter((k) => k !== null);
  j.equal(
    'Record what happened composes a new attempt with a new key, answered 201: a second, newer report holding the edited losses',
    [
      (await apiRequests(tab, j.origin, mark)).filter((x) => x.method === 'POST' && x.path.endsWith('/installations')).map((x) => x.status),
      attempts.length,
      attempts[1] !== attempts[0],
      [reportsOn(E.releaseId), newestLosses(E.releaseId)],
    ],
    [[201], 2, true, [rows + 2, editedLosses]],
  );
}
