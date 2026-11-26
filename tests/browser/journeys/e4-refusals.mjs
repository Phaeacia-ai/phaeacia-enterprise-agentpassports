/* One journey per E4 design 4.2 refusal a page can drive: JR1 E_GATE_FAILS_NOW on an approval, which shows the message
   and points to requesting changes; JR2 E_ASSEMBLY_TOO_LARGE at proposal, with the size and the bound; then the reload
   codes, each reached the way a person reaches it, from a page left open while the work moved on: JR3 E_ALREADY_SIGNED,
   JR4 E_ENVELOPE_CLOSED, JR5 E_NOT_REVIEWABLE, JR6 E_ENVELOPE_APPROVED, JR7 E_CANDIDATE_SUPERSEDED, JR8
   E_ALREADY_WITHDRAWN, and JR9 E_IDEMPOTENCY_EXPIRED, a retry after a lost answer presented past the claim window. Each
   reload journey asserts the page read its data again and shows where the work now is. Two codes of 4.2 no page drives:
   E_IDEMPOTENCY_CONFLICT (a page resends a key only with that attempt's own body) and E_DERIVED_CHANGED (it needs
   another gate in the serving process); evidence/e4-pages.md names both. */

import { PLACEHOLDER } from '../../../lib/passport/assemble.mjs';
import { apiRequests } from './common.mjs';
import {
  adminAal2,
  ageClaim,
  approveBoth,
  breakStoredContent,
  count,
  e4world,
  envelope,
  exists,
  fixture,
  keysSent,
  loseNextAnswer,
  published,
  releaseUrl,
  reviewed,
  reviewUrl,
  signedIn,
  submitted,
  textOf,
} from './e4-common.mjs';

const writesTo = async (tab, j, from, suffix) =>
  (await apiRequests(tab, j.origin, from)).filter((x) => x.path.endsWith(suffix)).map((x) => [x.status, x.code]);

/** A stale page's approval answered with a reload code: the answer, the message above the page read again. */
async function staleApproval(j, tab, code, { button = 'approve', envelopeId } = {}) {
  if (envelopeId) await tab.click(`#envelope-${envelopeId}`);
  await tab.type('#review-reason', 'Signed from a page left open.');
  const from = tab.requests.length;
  await tab.click(`[data-role="${button}"]`);
  await tab.waitForSelector(`[data-state="reload"][data-code="${code}"]`);
  j.equal(`the write answers ${code}`, (await writesTo(tab, j, from, '/reviews')).map((x) => x[1]), [code]);
  j.check('the page read its data again after the refusal', (await apiRequests(tab, j.origin, from)).some((x) => x.path.endsWith('/review') && x.status === 200));
}

export async function jr1(ctx, j) {
  const W = await e4world(ctx);
  const H = await submitted(ctx, W);
  await envelope(ctx, W, H.candidateId);
  breakStoredContent(H.candidateId);
  await signedIn(j, W, 'business');
  const tab = await j.tab(W.users.business.identity, 'gate-fails-now');
  await tab.navigate(reviewUrl(j, H.candidateId));
  await tab.waitForSelector('[data-role="approve"]');
  await tab.type('#review-reason', 'The stored bytes changed under the checks.');
  let from = tab.requests.length;
  await tab.click('[data-role="approve"]');
  await tab.waitForSelector('[data-role="sign-off-status"] [data-code="E_GATE_FAILS_NOW"]');
  j.equal('the approval answers 422 E_GATE_FAILS_NOW', await writesTo(tab, j, from, '/reviews'), [[422, 'E_GATE_FAILS_NOW']]);
  j.check("the server's message is shown as sent", (await tab.text('[data-role="sign-off-status"]')).includes('The stored passport no longer passes the current content checks.'));
  j.check('and the page points to requesting changes', await exists(tab, '[data-role="point-to-changes"] [data-role="request-changes-instead"]'));
  j.equal('no review row was written', count('app.reviews', `candidate_id = '${H.candidateId}'`), 0);
  await j.capture(tab, 'gate-fails-now', { anchor: '[data-role="sign-off"]' });
  from = tab.requests.length;
  await tab.click('[data-role="request-changes-instead"]');
  await tab.waitForSelector('[data-role="candidate-head"][data-state="changes_requested"]');
  j.equal('the change request records, 201', await writesTo(tab, j, from, '/reviews'), [[201, null]]);
  j.check('the changes-requested state shows the reason', (await textOf(tab, '[data-role="change-reasons"]')).includes('The stored bytes changed under the checks.'));
  await j.capture(tab, 'changes-requested');
}

export async function jr2(ctx, j) {
  const W = await e4world(ctx);
  const text = `${fixture('synthetic-empty.md')}\n${Array(7).fill(PLACEHOLDER).join('\n')}\n`;
  const I = await submitted(ctx, W, { text });
  await signedIn(j, W, 'it');
  const tab = await j.tab(W.users.it.identity, 'assembly-too-large');
  await tab.navigate(reviewUrl(j, I.candidateId));
  await tab.waitForSelector('[data-role="propose-form"]');
  await tab.click('#target-claude-code');
  await tab.click(`#audience-${W.groupId}`);
  const from = tab.requests.length;
  await tab.click('[data-role="propose"]');
  await tab.waitForSelector('[data-role="propose-status"] [data-code="E_ASSEMBLY_TOO_LARGE"]');
  j.equal('the proposal answers 422 E_ASSEMBLY_TOO_LARGE', await writesTo(tab, j, from, '/envelopes'), [[422, 'E_ASSEMBLY_TOO_LARGE']]);
  j.check("the server's message is shown as sent", (await tab.text('[data-role="propose-status"]')).includes('The installation for this platform would be larger than the service stores.'));
  const size = await textOf(tab, '[data-role="assembly-size"]');
  j.check('beside it the bound, the passport size and the placeholder count', size.includes('393,216 bytes') && size.includes('3,129 bytes') && size.includes('Claude Code') && size.includes('8 placeholders'), size);
  j.equal('no envelope row was written', count('app.review_envelopes', `candidate_id = '${I.candidateId}'`), 0);
  await j.capture(tab, 'assembly-too-large', { anchor: '[data-role="propose-section"]' });
}

export async function jr3(ctx, j) {
  const W = await e4world(ctx);
  const C = await submitted(ctx, W);
  const e = await envelope(ctx, W, C.candidateId);
  await signedIn(j, W, 'it');
  const first = await j.tab(W.users.it.identity, 'first-tab');
  const stale = await j.tab(W.users.it.identity, 'stale-tab');
  for (const tab of [first, stale]) {
    await tab.navigate(reviewUrl(j, C.candidateId));
    await tab.waitForSelector('[data-role="approve"]');
  }
  await first.type('#review-reason', 'Approved in the first tab.');
  await first.click('[data-role="approve"]');
  await first.waitForSelector('[data-state="signed"]');
  await staleApproval(j, stale, 'E_ALREADY_SIGNED');
  j.check('the page now shows the IT approval from the other tab', await exists(stale, `[data-envelope="${e}"] [data-approval="it"][data-state="approved"]`));
  j.equal('one IT approval', count('app.reviews', `candidate_id = '${C.candidateId}' and role = 'it'`), 1);
  await j.capture(stale, 'already-signed');
}

export async function jr4(ctx, j) {
  const W = await e4world(ctx);
  const C = await submitted(ctx, W);
  const approvedEnvelope = await envelope(ctx, W, C.candidateId);
  const other = await envelope(ctx, W, C.candidateId, { target: 'chatgpt' });
  await signedIn(j, W, 'business');
  const stale = await j.tab(W.users.business.identity, 'stale-tab');
  await stale.navigate(reviewUrl(j, C.candidateId));
  await stale.waitForSelector(`#envelope-${other}`);
  await approveBoth(ctx, W, C.candidateId, approvedEnvelope);
  await reviewed(ctx, C.candidateId, W.users.it, { envelopeId: other, role: 'it', decision: 'changes_requested', reason: 'Not for ChatGPT.' });
  await staleApproval(j, stale, 'E_ENVELOPE_CLOSED', { envelopeId: other });
  j.check('the page now shows that envelope closed with its change request', await exists(stale, `[data-envelope="${other}"][data-status="changes_requested"] [data-role="change-request"]`));
  await j.capture(stale, 'envelope-closed', { anchor: '[data-role="envelopes"]' });
}

export async function jr5(ctx, j) {
  const W = await e4world(ctx);
  const C = await submitted(ctx, W);
  await envelope(ctx, W, C.candidateId);
  await signedIn(j, W, 'business');
  const stale = await j.tab(W.users.business.identity, 'stale-tab');
  await stale.navigate(reviewUrl(j, C.candidateId));
  await stale.waitForSelector('[data-role="approve"]');
  await reviewed(ctx, C.candidateId, W.users.it, { envelopeId: null, role: 'it', decision: 'changes_requested', reason: 'The whole version needs a new source.' });
  await staleApproval(j, stale, 'E_NOT_REVIEWABLE');
  j.check('the page now shows the candidate with changes requested', await exists(stale, '[data-role="candidate-head"][data-state="changes_requested"]'));
  await j.capture(stale, 'not-reviewable');
}

export async function jr6(ctx, j) {
  const W = await e4world(ctx);
  const C = await submitted(ctx, W);
  const e = await envelope(ctx, W, C.candidateId);
  await signedIn(j, W, 'business');
  const stale = await j.tab(W.users.business.identity, 'stale-tab');
  await stale.navigate(reviewUrl(j, C.candidateId));
  await stale.waitForSelector('[data-role="request-changes"]');
  await approveBoth(ctx, W, C.candidateId, e);
  await staleApproval(j, stale, 'E_ENVELOPE_APPROVED', { button: 'request-changes' });
  j.check('the page now shows the approved envelope and candidate', await exists(stale, `[data-role="candidate-head"][data-state="approved"] ~ * [data-envelope="${e}"][data-status="approved"], [data-envelope="${e}"][data-status="approved"]`));
  await j.capture(stale, 'envelope-approved');
}

export async function jr7(ctx, j) {
  const W = await e4world(ctx);
  const older = await submitted(ctx, W);
  const olderEnvelope = await envelope(ctx, W, older.candidateId);
  await approveBoth(ctx, W, older.candidateId, olderEnvelope);
  const admin = await adminAal2(j, W);
  const stale = await j.tab(admin, 'stale-publish');
  await stale.navigate(reviewUrl(j, older.candidateId));
  await stale.waitForSelector('[data-role="publish"]');
  const newer = await submitted(ctx, W, { agentId: older.agentId });
  const newerEnvelope = await envelope(ctx, W, newer.candidateId);
  await approveBoth(ctx, W, newer.candidateId, newerEnvelope);
  await published(ctx, W, newer.candidateId, newerEnvelope);
  await stale.click('[data-role="publish"]');
  await stale.waitForSelector('[data-role="confirm-publication"]');
  const from = stale.requests.length;
  await stale.click('[data-role="confirm-publication"]');
  await stale.waitForSelector('[data-state="reload"][data-code="E_CANDIDATE_SUPERSEDED"]');
  j.equal('publication answers 409 E_CANDIDATE_SUPERSEDED', await writesTo(stale, j, from, '/releases'), [[409, 'E_CANDIDATE_SUPERSEDED']]);
  j.check('the page now shows the version superseded and the newer one published', (await exists(stale, '[data-role="candidate-head"][data-state="superseded"]')) && (await exists(stale, '[data-state="newer-published"]')));
  j.equal('no release of the older version', count('app.releases', `candidate_id = '${older.candidateId}'`), 0);
  await j.capture(stale, 'candidate-superseded');
}

export async function jr8(ctx, j) {
  const W = await e4world(ctx);
  const C = await submitted(ctx, W, { author: W.users.owner });
  const e = await envelope(ctx, W, C.candidateId);
  await approveBoth(ctx, W, C.candidateId, e);
  const releaseId = await published(ctx, W, C.candidateId, e);
  await signedIn(j, W, 'owner');
  const first = await j.tab(W.users.owner.identity, 'first-tab');
  const stale = await j.tab(W.users.owner.identity, 'stale-tab');
  for (const tab of [first, stale]) {
    await tab.navigate(releaseUrl(j, releaseId));
    await tab.waitForSelector('[data-role="withdraw"]');
  }
  await first.type('#withdraw-reason', 'Withdrawn from the first tab.');
  await first.click('[data-role="withdraw"]');
  await first.click('[data-role="confirm-withdrawal"]');
  await first.waitForSelector('[data-state="withdrawn-now"]');
  await stale.type('#withdraw-reason', 'Withdrawn from a page left open.');
  await stale.click('[data-role="withdraw"]');
  const from = stale.requests.length;
  await stale.click('[data-role="confirm-withdrawal"]');
  await stale.waitForSelector('[data-state="reload"][data-code="E_ALREADY_WITHDRAWN"]');
  j.equal('the stale withdrawal answers 409 E_ALREADY_WITHDRAWN', await writesTo(stale, j, from, '/withdraw'), [[409, 'E_ALREADY_WITHDRAWN']]);
  j.check('the page now shows the release withdrawn, with its removal text', (await exists(stale, '[data-role="release-head"][data-state="withdrawn"]')) && (await exists(stale, '[data-role="removal-text"]')));
  j.equal("the stored reason is the first tab's", await textOf(stale, '[data-role="withdrawal-reason"]'), 'Withdrawn from the first tab.');
  await j.capture(stale, 'already-withdrawn');
}

export async function jr9(ctx, j) {
  const W = await e4world(ctx);
  const C = await submitted(ctx, W);
  await envelope(ctx, W, C.candidateId);
  await signedIn(j, W, 'it');
  const tab = await j.tab(W.users.it.identity, 'expired-retry');
  await tab.navigate(reviewUrl(j, C.candidateId));
  await tab.waitForSelector('[data-role="approve"]');
  const keys = keysSent(tab, '/reviews');
  const lost = loseNextAnswer(tab, '/reviews');
  await tab.type('#review-reason', 'Approved before the window passed.');
  await tab.click('[data-role="approve"]');
  j.equal('the first attempt was answered 201 and its answer lost', (await lost).status, 201);
  await tab.waitForSelector('[data-role="sign-off-status"] [data-role="retry"]');
  ageClaim(W.ms.it, keys[0]);
  const from = tab.requests.length;
  await tab.click('[data-role="sign-off-status"] [data-role="retry"]');
  await tab.waitForSelector('[data-state="reload"][data-code="E_IDEMPOTENCY_EXPIRED"]');
  j.check('the retry sent the same key', keys.length === 2 && keys[0] === keys[1], keys.length);
  j.equal('and was answered 409 E_IDEMPOTENCY_EXPIRED', await writesTo(tab, j, from, '/reviews'), [[409, 'E_IDEMPOTENCY_EXPIRED']]);
  j.check('the page read again shows where the work is: the first attempt stored the approval', await exists(tab, '[data-approval="it"][data-state="approved"]'));
  await j.capture(tab, 'idempotency-expired');
}
