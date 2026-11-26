/* JE1, JE2, JE5 and JE6 (E4 design 4.3): a reviewer approves at phone width, with a lost answer retried under the same
   key, and on a second version the sign-off held in flight and its Retry refused after an edit (INF-N3); an author
   holding it_reviewer sees the exclusion and no sign-off control, and a request hand-built from the page's own api.mjs
   is refused; a reviewer removed while the review screen is open reaches the not-found state at the next action; the
   boundary sentence and the losses table on the review screen for a passport with an empty section 6. The universal
   assertions of every journey (initiator, cookie state, document URLs) run on every tab. */

import { sql } from '../../e3/stack/helpers.mjs';
import { PHONE } from '../cdp.mjs';
import { apiRequests, line, sleep } from './common.mjs';
import {
  count,
  e4world,
  envelope,
  exists,
  fixture,
  holdNext,
  keysSent,
  loseNextAnswer,
  removeMembership,
  reviewed,
  reviewUrl,
  companyUrl,
  signedIn,
  submitted,
  textOf,
  UUID_V4,
} from './e4-common.mjs';

const sqlOne = (query) => sql(query).trim();

/* Design 4.1 item 2, copied here so the journey does not read the page's own constant. */
export const BOUNDARY =
  "Approval governs the distributed configuration and its evidence. Phaeacia does not enforce read-only execution inside the recipient's assistant. Tools the recipient enables natively may still write even when this configuration is unchanged; the recipient's native permissions govern them.";

const reviewsOf = (candidateId) => count('app.reviews', `candidate_id = '${candidateId}'`);

export async function je1(ctx, j) {
  const W = await e4world(ctx);
  const A = await submitted(ctx, W);
  await signedIn(j, W, 'it');
  const tab = await j.tab(W.users.it.identity, 'review-phone');
  await tab.setViewport(PHONE);
  await tab.navigate(reviewUrl(j, A.candidateId));
  await tab.waitForSelector('[data-role="propose-form"]');
  j.equal('the viewport is the phone', await tab.evaluate('innerWidth'), 390);
  j.equal('the verdict for an IT reviewer who contributed nothing', await textOf(tab, '[data-role="verdict"]'), 'You may sign off as IT reviewer');
  await j.cookies(tab, 2, 'a reviewer signed in');
  await j.capture(tab, 'submitted-no-envelope');

  const envelopeKeys = keysSent(tab, '/envelopes');
  let from = tab.requests.length;
  await tab.click(`#audience-${W.groupId}`);
  await tab.click('[data-role="propose"]');
  await tab.waitForSelector('[data-state="proposed"]');
  j.equal('proposing sends one POST envelopes, answered 201', (await apiRequests(tab, j.origin, from)).filter((x) => x.path.endsWith('/envelopes')).map((x) => x.status), [201]);
  j.check('that request carried an Idempotency-Key made as a random uuid', envelopeKeys.length === 1 && UUID_V4.test(envelopeKeys[0] ?? ''), envelopeKeys.length);
  await tab.waitForSelector('[data-role="envelopes"] [data-status="open"]');
  j.check('the envelope shows its assembled size beside the 393,216-byte bound', (await tab.text('[data-role="envelopes"]')).includes('of the 393,216-byte bound'));
  await j.capture(tab, 'envelope-open', { anchor: '[data-role="envelopes"]' });

  const reviewKeys = keysSent(tab, '/reviews');
  const lost = loseNextAnswer(tab, '/reviews');
  await tab.type('#review-reason', 'Reads the weekly report only; nothing is written.');
  from = tab.requests.length;
  await tab.click('[data-role="approve"]');
  const cut = await lost;
  j.equal('the first approval reached the service, which answered 201, and its answer was lost on the way back', cut.status, 201);
  await tab.waitForSelector('[data-role="sign-off-status"] [data-role="retry"]');
  j.check('the page shows the lost answer as a retry state, not as a refusal', await exists(tab, '[data-role="sign-off-status"] [data-state="retry"]'));
  j.equal('the approval is already stored', reviewsOf(A.candidateId), 1);
  await j.capture(tab, 'approval-answer-lost', { anchor: '[data-role="sign-off"]' });
  await tab.click('[data-role="sign-off-status"] [data-role="retry"]');
  await tab.waitForSelector('[data-state="signed"]');
  j.check('the retry renders as success, marked as the stored answer', (await tab.evaluate(`document.querySelector('[data-state="signed"]').getAttribute('data-replay')`)) === 'true');
  j.check('the retry sent the Idempotency-Key of the lost attempt', reviewKeys.length === 2 && reviewKeys[0] === reviewKeys[1] && UUID_V4.test(reviewKeys[0] ?? ''), reviewKeys.length);
  j.equal('one IT approval exists, not two', reviewsOf(A.candidateId), 1);
  await tab.waitForSelector('[data-approval="it"][data-state="approved"]');
  await j.capture(tab, 'approved-by-it', { anchor: '[data-role="envelopes"]' });

  await signedIn(j, W, 'business');
  const second = await j.tab(W.users.business.identity, 'review-business');
  await second.setViewport(PHONE);
  await second.navigate(reviewUrl(j, A.candidateId));
  await second.waitForSelector('[data-role="approve"]');
  await second.type('#review-reason', 'The audience is the finance team that owns the report.');
  from = second.requests.length;
  await second.click('[data-role="approve"]');
  await second.waitForSelector('[data-role="candidate-head"][data-state="approved"]');
  j.equal('the business approval answers 201', (await apiRequests(second, j.origin, from)).filter((x) => x.path.endsWith('/reviews')).map((x) => x.status), [201]);
  j.check('both roles approved one envelope: the envelope reads approved and the candidate is approved', await exists(second, '[data-role="envelopes"] [data-status="approved"]'));
  await j.cookies(second, 2, 'the business reviewer signed in');
  await j.capture(second, 'approved');

  /* INF-N3 on a second version: the sign-off is read at the press and held until its answer, and its Retry resends that
     press only while the form is unchanged, so a reason edited after a lost answer is never replaced by the pressed one
     without a word, and nothing typed in flight is lost when the answer redraws the page. */
  const B = await submitted(ctx, W);
  await envelope(ctx, W, B.candidateId);
  await tab.navigate(reviewUrl(j, B.candidateId));
  await tab.waitForSelector('[data-role="approve"]');
  const pressed = 'Reads the weekly report only; the reason as pressed.';
  const edited = 'Reads the weekly report only; the reason as edited after the answer was lost.';
  const bKeys = keysSent(tab, '/reviews');
  const lostB = loseNextAnswer(tab, '/reviews');
  await tab.type('#review-reason', pressed);
  await tab.click('[data-role="approve"]');
  j.equal('the approval of version 2 reached the service, which answered 201, and its answer was lost', (await lostB).status, 201);
  await tab.waitForSelector('[data-role="sign-off-status"] [data-role="retry"]');
  await tab.type('#review-reason', edited);
  from = tab.requests.length;
  await tab.click('[data-role="sign-off-status"] [data-role="retry"]');
  const changedSaid = '[data-role="sign-off-status"] [data-state="sign-off-changed"]';
  await tab.until(async () => (await exists(tab, changedSaid)) || (await exists(tab, '[data-state="signed"]')), { what: 'the answer to Retry' });
  j.equal(
    'INF-N3: Retry after the reason changed sends nothing and says why, and draws no signed notice; the box keeps the edit, the store the pressed reason',
    [
      (await apiRequests(tab, j.origin, from)).filter((x) => x.path.endsWith('/reviews')).length,
      await exists(tab, changedSaid),
      await exists(tab, '[data-state="signed"]'),
      await tab.evaluate(`document.querySelector('#review-reason')?.value ?? null`),
      sqlOne(`select reason from app.reviews where candidate_id = '${B.candidateId}'`),
    ],
    [0, true, false, edited, pressed],
  );
  await j.capture(tab, 'sign-off-retry-after-edit', { anchor: '[data-role="sign-off"]' });
  from = tab.requests.length;
  await tab.click('[data-role="approve"]');
  await tab.waitForSelector('[data-code="E_ALREADY_SIGNED"]');
  j.equal(
    'Approve composes a new attempt with a new key; the lost approval was stored, so the service answers E_ALREADY_SIGNED and the page reads again, one IT approval kept with the pressed reason',
    [
      (await apiRequests(tab, j.origin, from)).filter((x) => x.path.endsWith('/reviews')).map((x) => `${x.status} ${x.code}`),
      bKeys.length,
      bKeys[1] !== bKeys[0],
      reviewsOf(B.candidateId),
      sqlOne(`select reason from app.reviews where candidate_id = '${B.candidateId}'`),
    ],
    [['409 E_ALREADY_SIGNED'], 2, true, 1, pressed],
  );

  await second.navigate(reviewUrl(j, B.candidateId));
  await second.waitForSelector('[data-role="approve"]');
  const businessReason = 'The audience is the finance team that owns the report.';
  await second.type('#review-reason', businessReason);
  const signing = await holdNext(second, 'POST', '/reviews');
  await second.click('[data-role="approve"]');
  await signing.held;
  await second.type('#review-reason', `${businessReason} A line typed while the sign-off was in flight.`);
  j.equal(
    'INF-N3: while the sign-off is in flight the reason is read-only and unchanged, and the role and envelope choices and both buttons are held',
    await second.evaluate(
      `({ readOnly: document.querySelector('#review-reason').readOnly, unchanged: document.querySelector('#review-reason').value === ${JSON.stringify(businessReason)}, choices: [...document.querySelectorAll('[data-role="sign-off"] input[type="radio"]')].every((c) => c.disabled), buttons: document.querySelector('[data-role="approve"]').disabled && document.querySelector('[data-role="request-changes"]').disabled })`,
    ),
    { readOnly: true, unchanged: true, choices: true, buttons: true },
  );
  await signing.release();
  await second.waitForSelector('[data-role="candidate-head"][data-state="approved"]');
  j.equal('the held approval answered and was stored with the reason as pressed', sqlOne(`select reason from app.reviews where candidate_id = '${B.candidateId}' and role = 'business'`), businessReason);
}

export async function je2(ctx, j) {
  const W = await e4world(ctx);
  const B = await submitted(ctx, W, { author: W.users.author });
  const envelopeId = await envelope(ctx, W, B.candidateId, { by: W.users.it });
  await signedIn(j, W, 'author');
  const queue = await j.tab(W.users.author.identity, 'queue');
  await queue.navigate(companyUrl(j, '/reviews/', W.companyId));
  await queue.waitForSelector(`[data-candidate="${B.candidateId}"]`);
  j.equal(
    "the queue marks the author's own candidate",
    await textOf(queue, `[data-candidate="${B.candidateId}"] [data-role="viewer-excluded"]`),
    'You cannot sign off: you are listed as a contributor',
  );
  await j.capture(queue, 'queue-excluded');

  const tab = await j.tab(W.users.author.identity, 'review-excluded');
  await tab.navigate(reviewUrl(j, B.candidateId));
  await tab.waitForSelector('[data-role="verdict"]');
  /* The author who submitted is recorded twice, as author and as submitter (E3 1.4), and the verdict names both kinds. */
  j.equal('the verdict names the exclusion', await textOf(tab, '[data-role="verdict"]'), 'You cannot sign off: you are listed as author and submitter');
  j.check('no sign-off control is in the DOM', !(await exists(tab, '[data-role="sign-off"], [data-role="approve"], [data-role="request-changes"]')));
  await j.cookies(tab, 2, 'the author signed in');
  await j.capture(tab, 'review-excluded', { anchor: '[data-role="contributors"]' });

  const from = tab.requests.length;
  const answer = await tab.evaluate(
    `import('/assets/app/api.mjs').then(async (api) => { const r = await api.writeAttempt((key) => api.recordReview(${JSON.stringify(B.candidateId)}, { envelopeId: ${JSON.stringify(envelopeId)}, role: 'it', decision: 'approved', reason: 'Hand-built from the page.' }, key))(); return { status: r.status, code: r.code }; })`,
  );
  j.equal("a request hand-built from the page's own api.mjs is refused 403 E_REVIEWER_IS_CONTRIBUTOR", answer, { status: 403, code: 'E_REVIEWER_IS_CONTRIBUTOR' });
  j.equal(
    'it went out once, and the initiator assertion holds it to api.mjs',
    (await apiRequests(tab, j.origin, from)).filter((x) => x.path.endsWith('/reviews')).map(line),
    [`POST /api/candidates/${B.candidateId}/reviews 403 E_REVIEWER_IS_CONTRIBUTOR`],
  );
  j.equal('no review row was written', count('app.reviews', `candidate_id = '${B.candidateId}'`), 0);
}

/* JE7 (Q5 as answered 2026-09-15; design 1.2, 4.1 items 4 and 5, case 54): the author of version 1, who holds
   it_reviewer, opens the review screen of a fresh version 2 of the same agent that someone else wrote. Her attribution
   stays in the history panel under version 1, the verdict is computed over version 2's own contributors, the queue marks
   nothing for her, and her sign-off answers 201. JE2 stays the control: the author of the candidate itself is excluded. */
export async function je7(ctx, j) {
  const W = await e4world(ctx);
  const first = await submitted(ctx, W, { author: W.users.author });
  await reviewed(ctx, first.candidateId, W.users.it, { envelopeId: null, role: 'it', decision: 'changes_requested', reason: 'Send it back for a new version.' });
  const second = await submitted(ctx, W, { author: W.users.owner, agentId: first.agentId });
  await envelope(ctx, W, second.candidateId, { by: W.users.it });
  j.equal(
    'setup: version 2 is a fresh draft of the same agent holding no row of the version 1 author',
    [sqlOne(`select agent_id from app.candidate_versions where id = '${second.candidateId}'`), count('app.candidate_contributors', `candidate_id = '${second.candidateId}' and membership_id = '${W.ms.author}'`)],
    [first.agentId, 0],
  );
  await signedIn(j, W, 'author');

  const queue = await j.tab(W.users.author.identity, 'queue-earlier-author');
  await queue.navigate(companyUrl(j, '/reviews/', W.companyId));
  await queue.waitForSelector(`[data-candidate="${second.candidateId}"]`);
  j.check('the queue does not mark version 2 as closed to her', !(await exists(queue, `[data-candidate="${second.candidateId}"] [data-role="viewer-excluded"]`)));

  const tab = await j.tab(W.users.author.identity, 'review-earlier-author');
  await tab.setViewport(PHONE);
  await tab.navigate(reviewUrl(j, second.candidateId));
  await tab.waitForSelector('[data-role="history"]');
  j.equal('the viewport is the phone', await tab.evaluate('innerWidth'), 390);
  j.equal('the history panel s label', await textOf(tab, '[data-role="history"] > p'), 'Earlier versions of this agent and who contributed to them.');
  const v1 = `[data-role="history"] li[data-candidate="${first.candidateId}"]`;
  j.equal('version 1 is listed with its author, who is herself', [await textOf(tab, `${v1} a`), await tab.evaluate(`document.querySelector(${JSON.stringify(`${v1} [data-label]`)})?.getAttribute('data-label') ?? null`)], ['Version 1', 'self']);
  j.check('and the panel names her among the agent s contributors', await exists(tab, '[data-role="history-contributors"] [data-label="self"]'));
  await j.capture(tab, 'earlier-author-history', { anchor: '[data-role="history"]' });

  j.equal('the verdict is computed over version 2 s own contributors', await textOf(tab, '[data-role="verdict"]'), 'You may sign off as IT reviewer');
  j.equal('and marks no exclusion', await tab.evaluate(`document.querySelector('[data-role="verdict"]')?.getAttribute('data-excluded') ?? null`), 'no');
  await j.cookies(tab, 2, 'the version 1 author signed in');
  await j.capture(tab, 'earlier-author-verdict', { anchor: '[data-role="verdict"]' });

  const control = await exists(tab, '[data-role="approve"]');
  j.check('a sign-off control is in the DOM', control);
  if (!control) return;
  await tab.type('#review-reason', 'I wrote version 1 and did not touch this one.');
  const from = tab.requests.length;
  await tab.click('[data-role="approve"]');
  await tab.waitForSelector('[data-state="signed"]');
  j.equal(
    'her approval answers 201',
    (await apiRequests(tab, j.origin, from)).filter((x) => x.path.endsWith('/reviews')).map((x) => [x.status, x.code ?? null]),
    [[201, null]],
  );
  j.equal(
    'one IT approval, hers, is stored on version 2',
    count('app.reviews', `candidate_id = '${second.candidateId}' and role = 'it' and decision = 'approved' and reviewer_membership_id = '${W.ms.author}'`),
    1,
  );
}

export async function je5(ctx, j) {
  const W = await e4world(ctx);
  const D = await submitted(ctx, W);
  await envelope(ctx, W, D.candidateId);
  await signedIn(j, W, 'leaver');
  const tab = await j.tab(W.users.leaver.identity, 'review-open');
  await tab.navigate(reviewUrl(j, D.candidateId));
  await tab.waitForSelector('[data-role="approve"]');
  await tab.type('#review-reason', 'Approving after the membership is gone.');
  await removeMembership(ctx, W, 'leaver');
  const from = tab.requests.length;
  await tab.click('[data-role="approve"]');
  await tab.waitForSelector('[data-state="not-found"]');
  j.equal(
    'the next action answers 404 E_NOT_FOUND',
    (await apiRequests(tab, j.origin, from)).filter((x) => x.path.endsWith('/reviews')).map((x) => [x.status, x.code]),
    [[404, 'E_NOT_FOUND']],
  );
  j.check('the review is discarded: no passport, envelope or action is left on the page', !(await exists(tab, '[data-role="passport"], [data-role="envelopes"], [data-role="actions"]')));
  j.equal('no review row was written', count('app.reviews', `candidate_id = '${D.candidateId}'`), 0);
  await j.capture(tab, 'removed-at-next-action');
}

const SHAPE = `(() => {
  const b = document.querySelector('[data-role="boundary"]');
  const controls = [...document.querySelectorAll('[data-role="actions"] button, [data-role="actions"] input, [data-role="actions"] textarea, [data-role="actions"] a')];
  const style = b ? getComputedStyle(b) : null;
  const pane = document.querySelector('[data-role="content"]');
  const single = document.querySelector('[data-role="losses-table"] td[data-role="single-row"]');
  return {
    text: b ? b.textContent : null,
    boundaries: document.querySelectorAll('[data-role="boundary"]').length,
    controls: controls.length,
    allAfter: Boolean(b) && controls.every((c) => b.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING),
    folds: document.querySelectorAll('details, summary').length,
    shown: Boolean(style) && style.display !== 'none' && style.visibility !== 'hidden' && b.getBoundingClientRect().height > 0,
    losses: document.querySelector('[data-role="losses"]')?.dataset.losses ?? null,
    pendingRow: single ? single.textContent : null,
    colSpan: single ? single.colSpan : null,
    noLoss: /no loss|nothing was lost/i.test(document.body.innerText),
    paneTag: pane ? pane.tagName : null,
    paneElements: pane ? pane.children.length : null,
    paneHasSectionSix: Boolean(pane) && pane.textContent.includes('## 6. Losses'),
    paneHasPlaceholder: Boolean(pane) && pane.textContent.includes('<!-- installer core and branches inserted on upload -->'),
    renderedSectionHeadings: [...document.querySelectorAll('main h1, main h2, main h3, main h4')].filter((h) => /^[1-6][.] /.test(h.textContent)).length,
  };
})()`;

/* Every word in a data table whose text sits on more than one line box: a word broken mid-way. Width readings cannot see
   this (evidence/pages-web.md lesson 1), so it is read from the ranges of the words themselves. */
const BROKEN_WORDS = `(() => {
  const broken = [];
  for (const cell of document.querySelectorAll('table.data th, table.data td')) {
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const words = /[^\\s-]+/g;
      for (let m = words.exec(node.textContent); m; m = words.exec(node.textContent)) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        if (new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size > 1) broken.push(m[0]);
      }
    }
  }
  return broken;
})()`;

async function unbrokenAtPhone(j, tab, label) {
  const viewport = tab.viewport;
  await tab.setViewport(PHONE);
  await sleep(300);
  j.equal(`${label}: at 390 pixels no word in a table is broken across lines`, await tab.evaluate(BROKEN_WORDS), []);
  await tab.setViewport(viewport);
}

export async function je6(ctx, j) {
  const W = await e4world(ctx);
  const empty = await submitted(ctx, W);
  const declaredOnly = await submitted(ctx, W, { text: fixture('synthetic-money-declared.md') });
  const declared = await submitted(ctx, W, { text: fixture('synthetic-declared-losses.md') });
  await signedIn(j, W, 'it');

  const tab = await j.tab(W.users.it.identity, 'empty-losses');
  await tab.navigate(reviewUrl(j, empty.candidateId));
  await tab.waitForSelector('[data-role="actions"]');
  const shape = await tab.evaluate(SHAPE);
  j.record('the review screen for a passport with an empty section 6', shape);
  j.equal('the boundary sentence is the fixed text, once', [shape.text, shape.boundaries], [BOUNDARY, 1]);
  j.check('it stands above every action control', shape.controls > 0 && shape.allAfter, shape);
  j.check('it is never collapsible: no details or summary on the page, and it is displayed', shape.folds === 0 && shape.shown, shape);
  j.equal('the losses table renders the one pending row across its three columns', [shape.losses, shape.pendingRow, shape.colSpan], ['pending', 'Not installed yet; losses not assessed', 3]);
  j.check('and no statement that nothing was lost', !shape.noLoss);
  j.equal('the passport is plain text in a pre with no element inside', [shape.paneTag, shape.paneElements, shape.paneHasSectionSix, shape.paneHasPlaceholder], ['PRE', 0, true, true]);
  j.equal('no passport section is rendered as a heading', shape.renderedSectionHeadings, 0);
  await unbrokenAtPhone(j, tab, 'an empty section 6');
  await j.capture(tab, 'empty-losses');

  const money = await j.tab(W.users.it.identity, 'declared-only');
  await money.navigate(reviewUrl(j, declaredOnly.candidateId));
  await money.waitForSelector('[data-role="needs-table"]');
  const cells = (selector) => money.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((tr) => [...tr.children].map((td) => td.textContent))`);
  j.equal(
    'a capability version 0.1 does not install reads "declared, not installed"; the other reads installable',
    await cells('[data-role="needs-table"] tbody tr'),
    [
      ['Reply in this conversation', 'Required', 'installable'],
      ['Pay the sorting fee (money.transfer)', 'Optional', 'declared, not installed'],
    ],
  );
  const needs = await money.text('[data-role="needs-table"]');
  j.check('the needs table names capabilities and shows none of their other values', !needs.includes('per-batch fee') && !needs.includes('You pay nothing'), needs);
  j.equal('its losses are still the pending row', await cells('[data-role="losses-table"] tbody tr'), [['Not installed yet; losses not assessed']]);
  await unbrokenAtPhone(j, money, 'a declared-only capability');
  await j.capture(money, 'declared-only-capability', { anchor: '[data-role="needs"]' });

  const rows = await j.tab(W.users.it.identity, 'declared-losses');
  await rows.navigate(reviewUrl(j, declared.candidateId));
  await rows.waitForSelector('[data-role="losses"][data-losses="declared"]');
  j.equal('declared losses carry the declared label', await textOf(rows, '[data-role="losses-label"]'), 'Declared by the owner, not inferred');
  j.equal(
    'and every declared row, in order',
    await rows.evaluate(`[...document.querySelectorAll('[data-role="losses-table"] tbody tr')].map((tr) => tr.children[0].textContent)`),
    ['Label colour hints', 'Twenty-record ceiling'],
  );
  await unbrokenAtPhone(j, rows, 'declared losses');
  await j.capture(rows, 'declared-losses', { anchor: '[data-role="losses"]' });
}
