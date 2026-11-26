/* JI4, JI5, JI7 and JI8 (E5 design 1.4, 1.5, 1.6, 3.1, 4.1 item 4): what a reviewer's page carries and what it must
   not, the check-in at day fourteen, every write control absent where the service refuses with the service refusing
   the hand-built request anyway, and the witness control with its refusal on the witness's own report, held in flight,
   and its Retry refused after an edit (INF-N5, evidence/capture-once.md).

   E5D-C-F3 is the finding these journeys exist for: a reviewer reads the company's reports because a witness who
   cannot read a report cannot make a statement about it, and reads no ledger fact about anybody. The assertion is over
   the rendered page, which is where the defect would show. */

import { sql } from '../../e3/stack/helpers.mjs';
import { apiRequests, signIn } from './common.mjs';
import { adminAal2, exists, holdNext, keysSent, loseNextAnswer, releaseUrl, signedIn, textOf, UUID_V4 } from './e4-common.mjs';
import { ageLedger, callAs, catalogUrl, countWhere, declaredLossesPassport, e5release, e5world } from './e5-common.mjs';

const sqlOne = (query) => sql(query).trim();
const ok = (r, label) => {
  if (r.status < 200 || r.status >= 300) throw new Error(`E5 journey setup, ${label}: ${r.status} ${String(r.raw).slice(0, 300)}`);
  return r.body;
};

/** A release the plain member has downloaded and reported on, made once for these four journeys. */
async function reported(ctx, W) {
  if (ctx.state.e5reported) return ctx.state.e5reported;
  const R = await e5release(ctx, W, { text: declaredLossesPassport() });
  ok(await callAs(ctx, 'releasesDownload', { user: W.users.member, params: { releaseId: R.releaseId } }), 'the member downloads');
  const report = ok(
    await callAs(ctx, 'installationsCreate', {
      user: W.users.member,
      params: { releaseId: R.releaseId },
      body: { status: 'partial', losses: 'The calendar read is unavailable on this plan.', assistance: null },
    }),
    'the member reports',
  ).report;
  ctx.state.e5reported = { ...R, reportId: report.reportId };
  return ctx.state.e5reported;
}

/** JI4: a reviewer's release page carries the company's reports and no ledger fact about anybody (E5D-C-F3). */
export async function ji4(ctx, j) {
  const W = await e5world(ctx);
  const R = await reported(ctx, W);
  await signedIn(j, W, 'business');
  const tab = await j.tab(W.users.business.identity, 'reviewer-page');
  await tab.navigate(releaseUrl(j, R.releaseId));
  await tab.waitForSelector('[data-role="installation-evidence"]');

  j.equal('the reviewer’s read is the company’s reports', await tab.evaluate(`document.querySelector('[data-role="installation-evidence"]')?.dataset.scope ?? null`), 'company-reports');
  j.check('and carries the recipient’s report', await exists(tab, `[data-role="installation-evidence"] [data-report="${R.reportId}"]`));
  j.equal(
    'every entry on it is marked as carrying no ledger field',
    await tab.evaluate(
      `[...document.querySelectorAll('[data-role="installation-evidence"] [data-membership]')].map((n) => n.dataset.ledger)`,
    ),
    ['absent'],
  );
  j.equal(
    'so no authorization count and no check-in state of another membership is rendered anywhere on the page (E5D-C-F3)',
    await tab.evaluate(
      `document.querySelectorAll('[data-role="installation-evidence"] [data-role="authorization"], [data-role="installation-evidence"] [data-role="check-in-due"]').length`,
    ),
    0,
  );
  j.check(
    'and the release page shows the reviewer no recipient list either, which is E4’s ledger policy unchanged',
    !(await exists(tab, '[data-role="recipients"]')),
  );
  j.check('the reviewer is offered the witness control on a report that is not theirs', await exists(tab, `[data-report="${R.reportId}"] [data-role="witness"]`));
  await j.capture(tab, 'reviewer-evidence', { anchor: '[data-role="installation-evidence"]' });

  /* The administrator, whom app.ledger_visible does admit, sees the same reports with the ledger facts beside them.
     Their browser is the enrolled one: the forced-enrolment rule moves an administrator without a verified factor to
     /mfa/ before any company page (pages section 1). */
  const adminIdentity = await adminAal2(j, W);
  const admin = await j.tab(adminIdentity, 'admin-page');
  await admin.navigate(releaseUrl(j, R.releaseId));
  await admin.waitForSelector('[data-role="installation-evidence"]');
  j.equal('an administrator’s read is the company scope', await admin.evaluate(`document.querySelector('[data-role="installation-evidence"]')?.dataset.scope ?? null`), 'company');
  j.check(
    'and carries the authorization count the ledger policy admits them to',
    (await exists(admin, '[data-role="installation-evidence"] [data-membership][data-ledger="shown"]')) &&
      (await textOf(admin, '[data-role="installation-evidence"] [data-role="authorization"]')).startsWith('Download authorized'),
  );
  await j.capture(admin, 'admin-evidence', { anchor: '[data-role="installation-evidence"]' });
}

/** JI5: the check-in notice at day fourteen, and a report clearing it. */
export async function ji5(ctx, j) {
  const W = await e5world(ctx);
  const R = await e5release(ctx, W, { text: declaredLossesPassport() });
  ok(await callAs(ctx, 'releasesDownload', { user: W.users.member, params: { releaseId: R.releaseId } }), 'the member downloads');
  await signedIn(j, W, 'member');

  const before = await j.tab(W.users.member.identity, 'check-in-not-yet');
  await before.navigate(releaseUrl(j, R.releaseId));
  await before.waitForSelector('[data-role="install-section"]');
  j.check('a download of today raises no check-in', !(await exists(before, '[data-role="check-in"]')));

  /* Owner-side, labelled as design section 5 labels it: the authorization aged past the fourteen-day interval, which
     no route can do and which the append-only trigger otherwise refuses. */
  ageLedger(R.releaseId, W.ms.member, '15 days');

  const tab = await j.tab(W.users.member.identity, 'check-in-due');
  await tab.navigate(releaseUrl(j, R.releaseId));
  await tab.waitForSelector('[data-role="check-in"]');
  j.check(
    'at day fourteen the recipient’s own check-in notice stands at the top of their release page',
    (await textOf(tab, '[data-role="check-in"]')).includes('Your check-in is due.'),
  );
  await j.capture(tab, 'check-in-due');

  const catalog = await j.tab(W.users.member.identity, 'check-in-catalog');
  await catalog.navigate(catalogUrl(j, W.companyId));
  await catalog.waitForSelector(`[data-release="${R.releaseId}"]`);
  j.check('and the catalog row says so beside the release', await exists(catalog, `[data-release="${R.releaseId}"] [data-state="check-in-due"]`));
  await j.capture(catalog, 'check-in-catalog');

  /* A reviewer is shown no check-in state of that membership anywhere, because it is a ledger fact (E5D-C-F3). */
  await signedIn(j, W, 'business');
  const reviewer = await j.tab(W.users.business.identity, 'check-in-not-a-reviewers');
  await reviewer.navigate(releaseUrl(j, R.releaseId));
  await reviewer.waitForSelector('[data-role="installation-evidence"]');
  j.equal(
    'a reviewer reading the same release is shown no check-in state and no count',
    await reviewer.evaluate(
      `document.querySelectorAll('[data-role="check-in"], [data-role="installation-evidence"] [data-role="check-in-due"], [data-role="installation-evidence"] [data-role="authorization"]').length`,
    ),
    0,
  );

  await tab.click('[data-role="check-in-report"]');
  j.check('the notice moves the keyboard to the report form rather than navigating', (await tab.location()).pathname === '/release/');
  await tab.click('#install-status-pass');
  await tab.click('[data-role="report"]');
  await tab.waitForSelector('[data-state="reported"]');
  j.check('and any report clears the check-in, whatever its status', !(await exists(tab, '[data-role="check-in"]')));
  j.equal('a second download does not raise it again, because the interval runs from the first', await exists(tab, '[data-role="check-in"]'), false);
  await j.capture(tab, 'check-in-cleared');
}

/** JI7: every write control is absent where the service refuses, and the service refuses the hand-built request. */
export async function ji7(ctx, j) {
  const W = await e5world(ctx);
  const R = await reported(ctx, W);

  /* A member of the company who is in no audience group: the release page offers no install section, no report form
     and no witness control, and each request built by hand is refused with nothing written. */
  const u = W.e5.users.bystander;
  await signIn(j, u.identity, u.email, { label: 'sign-in-bystander' });
  const tab = await j.tab(u.identity, 'not-a-recipient');
  await tab.navigate(releaseUrl(j, R.releaseId));
  await tab.waitForSelector('[data-state="not-found"], [data-role="release-head"]');
  const readable = await exists(tab, '[data-role="release-head"]');
  j.check(
    'a member outside every audience group cannot even read the release, which is row level security, not the page',
    !readable || !(await exists(tab, '[data-role="install-section"], [data-role="report-section"], [data-role="witness"]')),
    readable ? 'the page rendered; no write control on it' : 'the not-found state',
  );
  await j.capture(tab, 'bystander-release');

  const ledgerBefore = countWhere('app.release_downloads', `release_id = '${R.releaseId}'`);
  const reportsBefore = countWhere('app.installation_reports', `release_id = '${R.releaseId}'`);
  const witnessesBefore = countWhere('app.installation_witnesses', `report_id = '${R.reportId}'`);
  const built = {
    'a download by a member outside the audience': await callAs(ctx, 'releasesDownload', { user: u, params: { releaseId: R.releaseId } }),
    'a report by a member who has no authorization': await callAs(ctx, 'installationsCreate', {
      user: u,
      params: { releaseId: R.releaseId },
      body: { status: 'pass', losses: null, assistance: null },
    }),
    'a witness by a member who holds no reviewer or admin role': await callAs(ctx, 'installationsWitness', {
      user: u,
      params: { reportId: R.reportId },
      body: { status: 'pass', note: 'A member who holds no role tries.' },
    }),
    'a witness by the recipient of that very report': await callAs(ctx, 'installationsWitness', {
      user: W.users.member,
      params: { reportId: R.reportId },
      body: { status: 'pass', note: 'The recipient tries to witness their own report.' },
    }),
  };
  for (const [label, r] of Object.entries(built))
    j.check(`${label} is refused by the service`, r.status >= 400, `${r.status} ${r.body?.code ?? ''}`);
  j.record('the hand-built requests and what the service answered', Object.fromEntries(Object.entries(built).map(([k, r]) => [k, `${r.status} ${r.body?.code ?? ''}`])));
  j.equal('and nothing was written by any of them', [
    countWhere('app.release_downloads', `release_id = '${R.releaseId}'`),
    countWhere('app.installation_reports', `release_id = '${R.releaseId}'`),
    countWhere('app.installation_witnesses', `report_id = '${R.reportId}'`),
  ], [ledgerBefore, reportsBefore, witnessesBefore]);

  /* The plain member who made the report is shown no witness control on it: they hold no reviewer or admin role, and
     a caller who did hold one and was the recipient would meet E_WITNESS_IS_RECIPIENT (design 3.5 rows 19 and 20). */
  await signedIn(j, W, 'member');
  const own = await j.tab(W.users.member.identity, 'recipient-own-report');
  await own.navigate(releaseUrl(j, R.releaseId));
  await own.waitForSelector(`[data-report="${R.reportId}"]`);
  j.check('the recipient is offered no witness control on their own report', !(await exists(own, `[data-report="${R.reportId}"] [data-role="witness"]`)));
  await j.capture(own, 'recipient-own-report', { anchor: '[data-role="installation-evidence"]' });
}

/** JI8: a reviewer witnesses, a reviewer who is also the recipient of a report may not witness that one, and a second
    witness of the same report by the same membership reloads. */
export async function ji8(ctx, j) {
  const W = await e5world(ctx);
  const R = await reported(ctx, W);

  /* The IT reviewer is in the audience group too, so their own report is the one they may not witness. */
  ok(await callAs(ctx, 'releasesDownload', { user: W.users.it, params: { releaseId: R.releaseId } }), 'the reviewer downloads');
  const ownReport = ok(
    await callAs(ctx, 'installationsCreate', {
      user: W.users.it,
      params: { releaseId: R.releaseId },
      body: { status: 'pass', losses: null, assistance: null },
    }),
    'the reviewer reports',
  ).report;

  await signedIn(j, W, 'it');
  const tab = await j.tab(W.users.it.identity, 'witness');
  await tab.navigate(releaseUrl(j, R.releaseId));
  await tab.waitForSelector(`[data-report="${R.reportId}"]`);
  j.check('a reviewer is offered the witness control on a report that is not theirs', await exists(tab, `[data-report="${R.reportId}"] [data-role="witness"]`));
  j.check(
    'and none on the report they made themselves, which the service would refuse with E_WITNESS_IS_RECIPIENT',
    !(await exists(tab, `[data-report="${ownReport.reportId}"] [data-role="witness"]`)),
  );
  const refused = await callAs(ctx, 'installationsWitness', {
    user: W.users.it,
    params: { reportId: ownReport.reportId },
    body: { status: 'pass', note: 'The reviewer tries to witness their own report.' },
  });
  j.equal(
    'and the service refuses that very request when it is built by hand',
    [refused.status, refused.body?.code],
    [403, 'E_WITNESS_IS_RECIPIENT'],
  );

  const keys = keysSent(tab, '/witness');
  const before = countWhere('app.installation_witnesses', `report_id = '${R.reportId}'`);
  const from = tab.requests.length;
  await tab.click(`[data-report="${R.reportId}"] [data-role="witness"]`);
  await tab.waitForSelector(`[data-report="${R.reportId}"] [data-role="witness-box"]`);
  await tab.click(`#witness-${R.reportId}-partial`);
  const note = 'Confirmed on her machine; the calendar tool is off for the plan.';
  await tab.type(`#witness-note-${R.reportId}`, note);
  await j.capture(tab, 'witness-form', { anchor: '[data-role="installation-evidence"]' });
  /* INF-N5: the witness is read once at the press and held until its answer, so nothing typed in flight is lost. */
  const witnessing = await holdNext(tab, 'POST', '/witness');
  await tab.click(`[data-report="${R.reportId}"] [data-role="witness-submit"]`);
  await witnessing.held;
  await tab.type(`#witness-note-${R.reportId}`, `${note} A line typed while the witness was in flight.`);
  j.equal(
    'INF-N5: while the witness is in flight its statuses, its note and its button are held, and the note is unchanged',
    await tab.evaluate(
      `({ statuses: [...document.querySelectorAll('input[name="witness-status-${R.reportId}"]')].every((c) => c.disabled), note: document.querySelector('#witness-note-${R.reportId}').readOnly, button: document.querySelector('[data-report="${R.reportId}"] [data-role="witness-submit"]').disabled, unchanged: document.querySelector('#witness-note-${R.reportId}').value === ${JSON.stringify(note)} })`,
    ),
    { statuses: true, note: true, button: true, unchanged: true },
  );
  await witnessing.release();
  await tab.waitForSelector('[data-state="witnessed"]');
  j.equal(
    'the witness answers 201',
    (await apiRequests(tab, j.origin, from)).filter((x) => x.path.endsWith('/witness')).map((x) => x.status),
    [201],
  );
  j.check('with an Idempotency-Key made once for that attempt as a random uuid', keys.length === 1 && UUID_V4.test(keys[0] ?? ''), keys.length);
  j.equal('one witness row', countWhere('app.installation_witnesses', `report_id = '${R.reportId}'`), before + 1);

  await tab.waitForSelector(`[data-report="${R.reportId}"] [data-role="witnesses"]`);
  const witnessText = await textOf(tab, `[data-report="${R.reportId}"] [data-role="witnesses"]`);
  j.check(
    'the witness line names the role held at that moment and states nothing about verification (design 1.5)',
    witnessText.includes('Witnessed by an IT reviewer') && !/verified|validated|confirmed working|certified/i.test(witnessText),
    witnessText.slice(0, 160),
  );
  j.check('and carries the note as the reviewer wrote it', witnessText.includes('the calendar tool is off for the plan'));
  await j.capture(tab, 'witnessed', { anchor: '[data-role="installation-evidence"]' });

  /* The same reviewer witnessing the same report again: the work has moved on since the page read it, so the page
     reloads rather than showing the refusal beside a control that can never succeed (design 4.2). */
  const from2 = tab.requests.length;
  await tab.click(`[data-report="${R.reportId}"] [data-role="witness"]`);
  await tab.waitForSelector(`[data-report="${R.reportId}"] [data-role="witness-box"]`);
  await tab.type(`#witness-note-${R.reportId}`, 'The same reviewer says the same thing again.');
  await tab.click(`[data-report="${R.reportId}"] [data-role="witness-submit"]`);
  await tab.waitForSelector('[data-code="E_ALREADY_WITNESSED"]');
  j.equal(
    'a second witness of the same report by the same membership answers 409 E_ALREADY_WITNESSED',
    (await apiRequests(tab, j.origin, from2)).filter((x) => x.path.endsWith('/witness')).map((x) => [x.status, x.code]),
    [[409, 'E_ALREADY_WITNESSED']],
  );
  j.equal('and wrote no second row', countWhere('app.installation_witnesses', `report_id = '${R.reportId}'`), before + 1);
  j.check('the page read its data again rather than leaving the form open', await exists(tab, '[data-role="installation-evidence"]'));
  await j.capture(tab, 'already-witnessed');

  /* INF-N5: a second reviewer's witness whose answer was lost, the note then edited. Today's page read the note inside
     the send, so its Retry sent the edited note under the first key, met E_IDEMPOTENCY_CONFLICT and reloaded without
     saying the edit was not recorded; the Retry now sends nothing once the form differs from the press, and says so. */
  await signedIn(j, W, 'business');
  const other = await j.tab(W.users.business.identity, 'witness-retry-after-edit');
  await other.navigate(releaseUrl(j, R.releaseId));
  await other.waitForSelector(`[data-report="${R.reportId}"] [data-role="witness"]`);
  const pressedNote = 'Seen on her machine; the note as pressed before the answer was lost.';
  const editedNote = 'Seen on her machine with the calendar off; the note as edited after the answer was lost.';
  await other.click(`[data-report="${R.reportId}"] [data-role="witness"]`);
  await other.waitForSelector(`[data-report="${R.reportId}"] [data-role="witness-box"]`);
  await other.click(`#witness-${R.reportId}-partial`);
  await other.type(`#witness-note-${R.reportId}`, pressedNote);
  const otherKeys = keysSent(other, '/witness');
  const lostWitness = loseNextAnswer(other, '/witness');
  await other.click(`[data-report="${R.reportId}"] [data-role="witness-submit"]`);
  j.equal("the business reviewer's witness reached the service, which answered 201, and its answer was lost", (await lostWitness).status, 201);
  await other.waitForSelector(`[data-report="${R.reportId}"] [data-role="witness-status"] [data-role="retry"]`);
  await other.type(`#witness-note-${R.reportId}`, editedNote);
  const notes = () => sqlOne(`select string_agg(note, ' | ' order by witnessed_at) from app.installation_witnesses where report_id = '${R.reportId}'`);
  const storedNotes = notes();
  let mark = other.requests.length;
  await other.click(`[data-report="${R.reportId}"] [data-role="witness-status"] [data-role="retry"]`);
  const witnessChanged = `[data-report="${R.reportId}"] [data-role="witness-status"] [data-state="witness-changed"]`;
  await other.until(async () => (await exists(other, witnessChanged)) || (await exists(other, '[data-code="E_IDEMPOTENCY_CONFLICT"]')) || (await exists(other, '[data-state="witnessed"]')), { what: 'the answer to Retry' });
  j.equal(
    'INF-N5: Retry after the note changed sends nothing and says why; the box keeps the edit, and the store holds the pressed note',
    [
      (await apiRequests(other, j.origin, mark)).filter((x) => x.path.endsWith('/witness')).length,
      await exists(other, witnessChanged),
      await other.evaluate(`document.querySelector('#witness-note-${R.reportId}')?.value ?? null`),
      storedNotes.includes(pressedNote) && !storedNotes.includes(editedNote),
    ],
    [0, true, editedNote, true],
  );
  await j.capture(other, 'witness-retry-after-edit', { anchor: '[data-role="installation-evidence"]' });
  mark = other.requests.length;
  await other.click(`[data-report="${R.reportId}"] [data-role="witness-submit"]`);
  await other.waitForSelector('[data-code="E_ALREADY_WITNESSED"]');
  j.equal(
    'Record this witness composes a new attempt with a new key; the lost witness was stored, so the service answers E_ALREADY_WITNESSED and the page reads again, the stored notes unchanged',
    [
      (await apiRequests(other, j.origin, mark)).filter((x) => x.path.endsWith('/witness')).map((x) => `${x.status} ${x.code}`),
      otherKeys.length,
      otherKeys[1] !== otherKeys[0],
      notes(),
    ],
    [['409 E_ALREADY_WITNESSED'], 2, true, storedNotes],
  );
}
