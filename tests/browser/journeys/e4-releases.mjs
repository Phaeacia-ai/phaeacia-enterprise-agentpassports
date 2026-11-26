/* JE3 and JE4 (E4 design 4.3), the groups page, and the list and not-found states of the five pages: an administrator at
   aal1 sees the second-factor link, steps up and publishes; an administrator at aal1 who does not own the agent is
   refused a withdrawal with the second-factor link, and the owner withdraws and sees the recipients and the fixed text,
   with the reason edited while the confirmation is open withdrawn with and held in flight (INF-N6);
   groups read by a member, read-only for an administrator at aal1, changed by an administrator at aal2, with the group
   list read once per load; the queue, the release list and the groups of an empty company; each page's not-found state
   for a foreign company, an unknown id and a malformed id. */

import { randomUUID } from 'node:crypto';

import { e3lib, sql } from '../../e3/stack/helpers.mjs';
import { apiRequests, signIn, waitPath } from './common.mjs';
import {
  adminAal2,
  approveBoth,
  authorizeDownload,
  companyUrl,
  count,
  e4world,
  envelope,
  exists,
  freshCode,
  GROUP_NAME,
  holdNext,
  keysSent,
  published,
  releaseUrl,
  reviewUrl,
  routes,
  signedIn,
  submitted,
  textOf,
  UUID_V4,
} from './e4-common.mjs';

const WITHDRAWAL =
  "Withdrawal stops new downloads through Phaeacia. It cannot remove copies already downloaded, vendor account grants, or configurations already installed in a recipient's assistant.";

export async function je3(ctx, j) {
  const W = await e4world(ctx);
  const C = await submitted(ctx, W, { author: W.users.owner });
  const e = await envelope(ctx, W, C.candidateId);
  await approveBoth(ctx, W, C.candidateId, e);
  await adminAal2(j, W);

  const landed = await signIn(j, 'e4-admin-aal1', W.users.admin.email, { label: 'sign-in-aal1' });
  await waitPath(landed, '/mfa/');
  const tab = await j.tab('e4-admin-aal1', 'publish');
  await tab.navigate(reviewUrl(j, C.candidateId));
  await tab.waitForSelector('[data-role="publish-step-up"]');
  j.check('at aal1 there is no publish control, and the second-factor link is shown', !(await exists(tab, '[data-role="publish"]')) && (await exists(tab, '[data-role="publish-step-up"] [data-role="mfa-link"]')));
  await j.cookies(tab, 2, 'an administrator at aal1');
  await j.capture(tab, 'admin-aal1', { anchor: '[data-role="actions"]' });

  await tab.click('[data-role="publish-step-up"] [data-role="mfa-link"]');
  await waitPath(tab, '/mfa/');
  await tab.waitForSelector('[data-state="challenge"]');
  await tab.type('#code', await freshCode(W));
  await tab.click('[data-role="verify"]');
  await waitPath(tab, '/members/');
  await tab.navigate(reviewUrl(j, C.candidateId));
  await tab.waitForSelector('[data-role="publish"]');
  await tab.click('[data-role="publish"]');
  await tab.waitForSelector('[data-role="confirm-publish"]');
  const confirm = await textOf(tab, '[data-role="confirm-publish"] p');
  j.check('the in-page confirmation names the target and the audience', confirm.includes('for claude.ai to') && confirm.includes(GROUP_NAME), confirm);
  await j.capture(tab, 'publish-confirm', { anchor: '[data-role="publish-section"]' });
  const keys = keysSent(tab, '/releases');
  const from = tab.requests.length;
  await tab.click('[data-role="confirm-publication"]');
  await tab.waitForSelector('[data-state="published"]');
  j.equal('at aal2 publication answers 201', (await apiRequests(tab, j.origin, from)).filter((x) => x.path.endsWith('/releases')).map((x) => x.status), [201]);
  j.check('with an Idempotency-Key made as a random uuid', keys.length === 1 && UUID_V4.test(keys[0] ?? ''), keys.length);
  j.equal('one current release of the candidate', count('app.releases', `candidate_id = '${C.candidateId}' and state = 'published'`), 1);
  await j.capture(tab, 'published');

  await tab.click('[data-role="release-link"]');
  await waitPath(tab, '/release/');
  await tab.waitForSelector('[data-role="release-approvals"] [data-approval="business"]');
  j.check('the release page shows each approval with its reason', (await tab.text('[data-role="release-approvals"]')).includes('The audience is the finance team that owns the report.'));
  j.check('and the assembled size beside its bound', (await tab.text('[data-role="release-facts"]')).includes('of the 393,216-byte bound'));
  await j.capture(tab, 'release-current');
  ctx.state.e4.releaseC = { releaseId: new URLSearchParams((await tab.location()).search).get('release'), candidateId: C.candidateId };
}

export async function je4(ctx, j) {
  const W = await e4world(ctx);
  let rel = ctx.state.e4.releaseC;
  if (!rel) {
    const C = await submitted(ctx, W, { author: W.users.owner });
    const e = await envelope(ctx, W, C.candidateId);
    await approveBoth(ctx, W, C.candidateId, e);
    rel = { releaseId: await published(ctx, W, C.candidateId, e), candidateId: C.candidateId };
  }
  authorizeDownload(rel.releaseId, W.ms.member);

  /* An administrator with a verified factor, so the aal1 profile below meets the challenge and not forced enrolment. */
  await adminAal2(j, W);
  const landed = await signIn(j, 'e4-admin-aal1b', W.users.admin.email, { label: 'sign-in-aal1' });
  await waitPath(landed, '/mfa/');
  const admin = await j.tab('e4-admin-aal1b', 'withdraw-at-aal1');
  await admin.navigate(releaseUrl(j, rel.releaseId));
  await admin.waitForSelector('[data-role="withdraw-step-up"]');
  await admin.type('#withdraw-reason', 'An administrator at aal1 tries.');
  await admin.click('[data-role="withdraw"]');
  await admin.click('[data-role="confirm-withdrawal"]');
  await admin.waitForSelector('[data-role="withdraw-status"] [data-code="E_ADMIN_MFA_REQUIRED"]');
  j.check('an administrator at aal1 who does not own the agent is refused, with the second-factor link', await exists(admin, '[data-role="withdraw-status"] [data-role="mfa-link"]'));
  j.equal('the release is still published', count('app.releases', `id = '${rel.releaseId}' and state = 'published'`), 1);
  await j.capture(admin, 'admin-aal1-refused', { anchor: '[data-role="withdraw-section"]' });

  await signedIn(j, W, 'owner');
  const tab = await j.tab(W.users.owner.identity, 'owner-withdraws');
  await tab.navigate(releaseUrl(j, rel.releaseId));
  await tab.waitForSelector('[data-role="withdraw-section"]');
  j.equal('the fixed withdrawal text', await textOf(tab, '[data-role="withdraw-section"] [data-role="withdrawal-text"]'), WITHDRAWAL);
  j.equal(
    'the manual removal checklist, its last line as E5 design 1.6 replaces it',
    await tab.evaluate(`[...document.querySelectorAll('[data-role="withdraw-section"] [data-role="removal-checklist"] li')].map((li) => li.textContent)`),
    [
      'Ask each recipient listed to remove the installed instructions from their assistant.',
      'Ask the native administrator to remove any connector or account grant the configuration asked for.',
      'A recipient who confirms can record it here as a removal report, and a reviewer or administrator can witness it. Both are statements by people, not checks by Phaeacia.',
    ],
  );
  j.equal('the owner sees the recipient the download seam authorized', await tab.evaluate(`document.querySelectorAll('[data-role="recipients"] [data-membership]').length`), 1);
  await j.cookies(tab, 2, 'the owner, not an administrator, at aal1');
  await j.capture(tab, 'owner-published', { anchor: '[data-role="recipients"]' });
  await tab.type('#withdraw-reason', 'The source report format changed; totals are misread.');
  await tab.click('[data-role="withdraw"]');
  await tab.waitForSelector('[data-role="confirm-withdraw"]');
  await j.capture(tab, 'withdraw-confirm', { anchor: '[data-role="withdraw-section"]' });
  /* INF-N6: a withdrawal is one-way, so it is sent with the reason on screen at Confirm withdrawal, the press that
     sends, not the one read when the confirmation opened; and the reason is held from that press to the answer. */
  const reason = 'The source report format changed; totals are misread. Edited with the confirmation open.';
  await tab.type('#withdraw-reason', reason);
  const keys = keysSent(tab, '/withdraw');
  const from = tab.requests.length;
  const withdrawing = await holdNext(tab, 'POST', '/withdraw');
  await tab.click('[data-role="confirm-withdrawal"]');
  await withdrawing.held;
  await tab.type('#withdraw-reason', `${reason} A line typed while the withdrawal was in flight.`);
  j.equal(
    'INF-N6: while the withdrawal is in flight the reason is read-only and unchanged, and Confirm withdrawal and Cancel are held, so no second withdrawal starts inside it',
    await tab.evaluate(
      `({ readOnly: document.querySelector('#withdraw-reason').readOnly, unchanged: document.querySelector('#withdraw-reason').value === ${JSON.stringify(reason)}, buttons: document.querySelector('[data-role="confirm-withdrawal"]').disabled && document.querySelector('[data-role="confirm-withdraw"] [data-role="cancel"]').disabled })`,
    ),
    { readOnly: true, unchanged: true, buttons: true },
  );
  await withdrawing.release();
  await tab.waitForSelector('[data-state="withdrawn-now"]');
  j.equal(
    'INF-N6: the release is withdrawn with the reason edited while the confirmation was open, and the page shows it',
    [sql(`select withdrawal_reason from app.releases where id = '${rel.releaseId}'`).trim(), await textOf(tab, '[data-role="withdrawal-reason"]')],
    [reason, reason],
  );
  j.equal('withdrawal answers 200', (await apiRequests(tab, j.origin, from)).filter((x) => x.path.endsWith('/withdraw')).map((x) => x.status), [200]);
  j.check('with an Idempotency-Key made as a random uuid', keys.length === 1 && UUID_V4.test(keys[0] ?? ''), keys.length);
  j.check('the answer is shown: one recipient, and copies already downloaded are not revoked', (await textOf(tab, '[data-state="withdrawn-now"]')).includes('1 recipient had a download authorized.') && (await exists(tab, '[data-role="copies-not-revoked"]')));
  j.check('the withdrawn release shows the recipients and the fixed removal text', (await exists(tab, '[data-role="release-head"][data-state="withdrawn"]')) && (await exists(tab, '[data-role="recipients"] [data-membership]')) && (await textOf(tab, 'main > [data-role="removal-text"] [data-role="withdrawal-text"]')) === WITHDRAWAL);
  j.equal('the release is withdrawn', count('app.releases', `id = '${rel.releaseId}' and state = 'withdrawn'`), 1);
  await j.capture(tab, 'withdrawn');
}

export async function jg1(ctx, j) {
  const W = await e4world(ctx);
  await signedIn(j, W, 'member');
  const member = await j.tab(W.users.member.identity, 'member-view');
  await member.navigate(companyUrl(j, '/groups/', W.companyId));
  await member.waitForSelector('[data-role="groups"]');
  j.check('a member reads the groups with no control to change them', !(await exists(member, '[data-role="create-form"], [data-role="remove-from-group"], [data-role="add-to-group"], [data-role="step-up-panel"]')));
  j.check("and finds itself in the audience group", (await member.text('[data-role="groups"]')).includes(W.users.member.email));
  await j.capture(member, 'member-view');

  const identity = await adminAal2(j, W);
  const landed = await signIn(j, 'e4-admin-aal1c', W.users.admin.email, { label: 'sign-in-aal1' });
  await waitPath(landed, '/mfa/');
  const aal1 = await j.tab('e4-admin-aal1c', 'admin-aal1');
  await aal1.navigate(companyUrl(j, '/groups/', W.companyId));
  await aal1.waitForSelector('[data-role="step-up-panel"]');
  j.check('an administrator at aal1 sees the groups read-only, with the second-factor link', !(await exists(aal1, '[data-role="create-form"], [data-role="remove-from-group"]')));
  await j.capture(aal1, 'admin-aal1');

  const tab = await j.tab(identity, 'admin-manage');
  const loads = () => tab.requests.filter((r) => r.method === 'GET' && new URL(r.url).pathname === `/api/companies/${W.companyId}/groups`).length;
  await tab.navigate(companyUrl(j, '/groups/', W.companyId));
  await tab.waitForSelector('[data-role="create-form"]');
  await tab.type('#group-name', 'Operations');
  await tab.click('[data-role="create-group"]');
  await tab.waitForSelector('[data-state="group-created"]');
  const operations = await tab.evaluate(
    `[...document.querySelectorAll('[data-group-id]')].find((li) => li.querySelector('[data-role="group-name"]')?.textContent === 'Operations')?.dataset.groupId ?? null`,
  );
  j.check('the new group is listed after its creation', typeof operations === 'string', operations);
  const from = tab.requests.length;
  await tab.type('#group-name', GROUP_NAME);
  await tab.click('[data-role="create-group"]');
  await tab.waitForSelector('[data-role="create-status"] [data-code="E_GROUP_NAME_TAKEN"]');
  j.equal('a taken name answers 409 E_GROUP_NAME_TAKEN', (await apiRequests(tab, j.origin, from)).filter((x) => x.path.endsWith('/groups') && x.method === 'POST').map((x) => [x.status, x.code]), [[409, 'E_GROUP_NAME_TAKEN']]);
  await j.capture(tab, 'name-taken');
  /* E4P-F8, changed by the E6 pages lane: this arm used to add the owner, who has no display name, and the page added
     them. A display name is now required before a member joins an audience group, so the first press is refused by the
     page with the sentence that says what to do, and nothing is sent; the owner then sets a name (in-process, through
     PUT /api/me/display-name as the owner, which is the owner's own act), the administrator presses Reload, and the add
     succeeds. The server refuses nothing new: the rule is the page's. */
  const beforeAdd = tab.requests.length;
  await tab.click(`#add-${operations}-${W.ms.owner}`);
  await tab.click(`[data-group-id="${operations}"] [data-role="add-to-group"]`);
  await tab.waitForSelector(`[data-group-id="${operations}"] [data-state="unnamed-member"]`);
  j.check(
    'an unnamed member is refused by the page with the sentence that says what to do, and nothing is sent (E4P-F8)',
    (await textOf(tab, `[data-group-id="${operations}"] [data-state="unnamed-member"]`)).includes('Ask them to set one on their account page') &&
      tab.requests.slice(beforeAdd).filter((r) => r.method === 'PUT').length === 0 &&
      count('app.group_members', `group_id = '${operations}'`) === 0,
  );
  await j.capture(tab, 'unnamed-refused', { anchor: `[data-group-id="${operations}"]` });
  const { call } = await routes(ctx);
  const named = await call('meDisplayName', { user: W.users.owner, body: { displayName: 'Olga Owner' } });
  j.equal('the owner sets their own display name (setup, the owner’s own route)', named.status, 204);
  await tab.click('[data-role="reload"]');
  await tab.waitForSelector(`#add-${operations}-${W.ms.owner}`);
  await tab.click(`#add-${operations}-${W.ms.owner}`);
  await tab.click(`[data-group-id="${operations}"] [data-role="add-to-group"]`);
  await tab.waitFor(`document.querySelector('[data-group-id="${operations}"] [data-role="group-members"] [data-membership="${W.ms.owner}"]')`);
  j.check('named, the same member is added', count('app.group_members', `group_id = '${operations}'`) === 1);
  await j.capture(tab, 'admin-manage');
  await tab.click(`[data-group-id="${operations}"] [data-membership="${W.ms.owner}"] [data-role="remove-from-group"]`);
  /* The row also vanishes while the page shows its loading state, before the reload has read anything; so the wait is for
     the card rendered again without the row, and every answer is in before the reads are counted. */
  await tab.waitFor(
    `document.querySelector('[data-group-id="${operations}"]') && !document.querySelector('[data-group-id="${operations}"] [data-membership="${W.ms.owner}"]')`,
  );
  await apiRequests(tab, j.origin);
  j.equal('Operations holds nobody again', count('app.group_members', `group_id = '${operations}'`), 0);
  /* Before E4P-F8 this was 4: the first load and one after each of the three changes. The page's own refusal sends
     nothing and reads nothing; the Reload after the owner named themselves is the fifth read. */
  j.equal('the group list was read once per load: the first, the Reload, and after each of the three changes, not after either refusal', loads(), 5);
}

export async function jl1(ctx, j) {
  const W = await e4world(ctx);
  await signedIn(j, W, 'it');
  const queue = await j.tab(W.users.it.identity, 'queue');
  await queue.navigate(companyUrl(j, '/reviews/', W.companyId));
  await queue.waitForSelector('[data-role="awaiting"] [data-candidate]');
  j.check('the queue lists submitted candidates and approved envelopes waiting for publication', await exists(queue, '[data-role="open-envelopes"] [data-envelope]'));
  await j.capture(queue, 'queue');

  await signedIn(j, W, 'owner');
  const list = await j.tab(W.users.owner.identity, 'releases');
  await list.navigate(companyUrl(j, '/releases/', W.companyId));
  await list.waitForSelector('[data-role="releases"] [data-release]');
  j.check('the release list shows a withdrawn release', await exists(list, '[data-release][data-state="withdrawn"]'));
  await j.capture(list, 'releases');

  /* A second company holding nothing, where the IT reviewer is also a member: its empty lists, and home's company links. */
  const soloAdmin = e3lib('create_user "$1" "$PW"', `e4p-${W.run}-solo@example.invalid`);
  const empty = e3lib('company "$1" "$2"', `e4p-${W.run}-empty`, soloAdmin);
  e3lib('member "$1" "$2" "$3"', empty, W.users.it.id, '{it_reviewer,member}');
  for (const [path, ready, state] of [
    ['/reviews/', '[data-role="awaiting"] [data-state="empty"]', 'queue-empty'],
    ['/releases/', '[data-role="releases"] [data-state="empty"]', 'releases-empty'],
    ['/groups/', '[data-role="groups"] [data-state="empty"]', 'groups-empty'],
  ]) {
    const tab = await j.tab(W.users.it.identity, state);
    await tab.navigate(companyUrl(j, path, empty));
    await tab.waitForSelector(ready);
    await j.capture(tab, state);
  }
  const home = await j.tab(W.users.it.identity, 'home');
  await home.navigate(`${j.origin}/`);
  await home.waitForSelector('[data-role="companies"] [data-role="company-links"]');
  j.equal('home links each company to its reviews, releases and groups', await home.evaluate(`document.querySelectorAll('[data-role="companies"] [data-role="link-reviews"]').length`), 2);
  await j.capture(home, 'home-links');

  const foreign = ctx.ids.ALPHA;
  for (const [path, state] of [
    [companyUrl(j, '/reviews/', foreign), 'queue-foreign'],
    [companyUrl(j, '/releases/', foreign), 'releases-foreign'],
    [companyUrl(j, '/groups/', foreign), 'groups-foreign'],
    [reviewUrl(j, randomUUID()), 'review-unknown'],
    [releaseUrl(j, randomUUID()), 'release-unknown'],
  ]) {
    const tab = await j.tab(W.users.it.identity, state);
    await tab.navigate(path);
    await tab.waitForSelector('[data-state="not-found"]');
    const refused = (await apiRequests(tab, j.origin)).filter((x) => x.status === 404);
    j.check(`${state}: the not-found state, from a 404 E_NOT_FOUND`, refused.length > 0 && refused.every((x) => x.code === 'E_NOT_FOUND'), refused.map((x) => `${x.method} ${x.status} ${x.code}`));
    await j.capture(tab, state);
  }
  for (const [path, state] of [
    [`${j.origin}/review/?candidate=not-a-uuid`, 'review-malformed'],
    [`${j.origin}/release/?release=not-a-uuid`, 'release-malformed'],
  ]) {
    const tab = await j.tab(W.users.it.identity, state, { landingOutsideSet: true });
    await tab.navigate(path);
    await tab.waitForSelector('[data-state="not-found"]');
    j.check(`${state}: a malformed id reaches the same not-found state`, true);
  }
}
