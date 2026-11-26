/* JI1, JI6 and JI9 (E5 design 4.1, 4.2 and 4.3): the catalog as a recipient, as a member of the company who is not
   one, as an administrator, at the launch state where no target is enabled, and the continuation control a filtered
   page that is empty above a cursor has to offer (rule 11 of evidence/e5-design-critique.md). Every claim below is
   read from the rendered page; the captures beside them are the images those readings were taken from. */

import { e3lib } from '../../e3/stack/helpers.mjs';
import { apiRequests, signIn, waitPath } from './common.mjs';
import { adminAal2, companyUrl, exists, releaseUrl, signedIn, textOf } from './e4-common.mjs';
import {
  callAs,
  catalogUrl,
  cloneReleases,
  countWhere,
  declaredLossesPassport,
  e5release,
  e5world,
  emptyCompany,
  publishableTargets,
  setPublishable,
} from './e5-common.mjs';

const BOUNDARY =
  "Approval governs the distributed configuration and its evidence. Phaeacia does not enforce read-only execution inside the recipient's assistant. Tools the recipient enables natively may still write even when this configuration is unchanged; the recipient's native permissions govern them.";

const rowsIn = (tab, section) =>
  tab.evaluate(`document.querySelectorAll('[data-role="${section}"] [data-release]').length`);

/** JI1: a recipient's catalog, and the release page before any download. */
export async function ji1(ctx, j) {
  const W = await e5world(ctx);
  const R = ctx.state.e5r1 ?? (await e5release(ctx, W, { text: declaredLossesPassport() }));
  ctx.state.e5r1 = R;
  await signedIn(j, W, 'member');
  const tab = await j.tab(W.users.member.identity, 'recipient-catalog');
  await tab.navigate(catalogUrl(j, W.companyId));
  await tab.waitForSelector('[data-role="available"] [data-release]');

  j.equal('the boundary sentence stands above everything, as fixed page text', await textOf(tab, '[data-role="boundary"]'), BOUNDARY);
  j.check(
    'the recipient sees the release addressed to their group in "Available to you", downloadable and not blocked',
    await exists(tab, `[data-role="available"] [data-release="${R.releaseId}"][data-downloadable="yes"][data-blocked="none"]`),
  );
  /* "Earlier downloads" holds whatever this member was authorized and cannot download now, which in a full run is the
     release JE4 withdrew under them. The invariant is the partition, not an empty section: this release is current and
     addressed to them, so it is not there, and every row that is there is one they hold an authorization for. */
  j.check(
    'the release they can download now is not in "Earlier downloads"',
    !(await exists(tab, `[data-role="earlier"] [data-release="${R.releaseId}"]`)),
  );
  j.equal(
    'and every row that is there is one this member was authorized',
    await tab.evaluate(
      `[...document.querySelectorAll('[data-role="earlier"] [data-role="mine"]')].every((n) => Number(n.dataset.authorizations) > 0)`,
    ),
    true,
  );
  j.record('rows in "Earlier downloads" at this point of the run', await rowsIn(tab, 'earlier'));
  j.equal('the card names the agent', await textOf(tab, `[data-release="${R.releaseId}"] [data-role="agent-name"]`), R.agentName);
  j.check(
    'and carries the headline and the assembled size beside its bound',
    (await textOf(tab, `[data-release="${R.releaseId}"] [data-role="headline-title"]`))?.length > 0 &&
      (await textOf(tab, `[data-release="${R.releaseId}"] [data-role="assembled-size"]`)).includes('of the 393,216-byte bound'),
  );
  j.check(
    'before any download the row says so and claims no installation (E5D-C-F5)',
    (await exists(tab, `[data-release="${R.releaseId}"] [data-role="no-authorization"]`)) &&
      !(await exists(tab, `[data-release="${R.releaseId}"] [data-role="authorization"]`)) &&
      !(await exists(tab, `[data-release="${R.releaseId}"] [data-role="last-report"]`)),
  );
  await j.cookies(tab, 2, 'a recipient reading the catalog');
  await j.capture(tab, 'recipient-catalog');

  await tab.click(`[data-release="${R.releaseId}"] [data-role="release-link"]`);
  await waitPath(tab, '/release/');
  await tab.waitForSelector('[data-role="install-section"]');
  j.check('the release page offers the download control the service allowed', await exists(tab, '[data-role="download"]'));
  j.check(
    'the losses table renders before any download, as its one pending row and never a no-loss statement (E5D-C-F8, state 1 of 3)',
    (await exists(tab, '[data-role="install-section"] [data-role="losses"][data-losses="pending"]')) &&
      (await textOf(tab, '[data-role="install-section"] [data-role="losses-table"]')).includes('Not installed yet; losses not assessed'),
  );
  j.equal('the boundary sentence stands again inside the install section', await textOf(tab, '[data-role="install-boundary"]'), BOUNDARY);
  j.check(
    'no report form before an authorization exists, and no block is shown yet',
    !(await exists(tab, '[data-role="report-section"]')) && (await exists(tab, '[data-role="no-block-yet"]')),
  );
  j.check('and no witness control, because a plain member holds no role', !(await exists(tab, '[data-role="witness"]')));
  await j.capture(tab, 'before-download', { anchor: '[data-role="install-section"]' });
}

/** JI6: the catalog of a member of the company who is in no group, of a member in a group nothing is addressed to, of
    an administrator, and of a company read at the launch state where no target is enabled. */
export async function ji6(ctx, j) {
  const W = await e5world(ctx);
  ctx.state.e5r1 ??= await e5release(ctx, W, { text: declaredLossesPassport() });
  /* The blocked arm below needs a recipient who already holds an authorization, which a full run has and a selection
     of this journey alone does not. */
  if (countWhere('app.release_downloads', `release_id = '${ctx.state.e5r1.releaseId}' and membership_id = '${W.ms.member}'`) === 0)
    await callAs(ctx, 'releasesDownload', { user: W.users.member, params: { releaseId: ctx.state.e5r1.releaseId } });

  for (const [who, state, sentence] of [
    ['bystander', 'no_groups', 'You are in no group yet.'],
    ['elsewhere', 'none_for_my_groups', 'No agent has been published to your groups.'],
  ]) {
    const u = W.e5.users[who];
    await signIn(j, u.identity, u.email, { label: `sign-in-${who}` });
    const tab = await j.tab(u.identity, `catalog-${state}`);
    await tab.navigate(catalogUrl(j, W.companyId));
    await tab.waitForSelector('[data-role="catalog-empty"]');
    j.check(
      `a member ${who === 'bystander' ? 'in no group' : 'in a group nothing is addressed to'} sees the empty state ${state} and no card`,
      (await exists(tab, `[data-role="catalog-empty"][data-state="${state}"]`)) &&
        (await tab.evaluate(`document.querySelectorAll('main [data-release]').length`)) === 0,
    );
    j.check(`with its own fixed sentence`, (await textOf(tab, '[data-role="empty-sentence"]')).includes(sentence));
    j.check('and no continuation control, because the catalog has ended', !(await exists(tab, '[data-role="show-more"]')));
    await j.capture(tab, `catalog-${state}`);
  }

  /* The administrator's catalog is their own gallery and not the company's list: they are in no audience group. Their
     browser is the enrolled one, because the forced-enrolment rule moves an administrator without a verified factor to
     /mfa/ before any company page (pages section 1). */
  const admin = await j.tab(await adminAal2(j, W), 'catalog-admin');
  await admin.navigate(catalogUrl(j, W.companyId));
  await admin.waitForSelector('[data-role="catalog-empty"]');
  j.check(
    'an administrator sees their own gallery, which is empty: the catalog is not the company list',
    (await exists(admin, '[data-role="catalog-empty"][data-state="no_groups"]')) &&
      (await admin.evaluate(`document.querySelectorAll('main [data-release]').length`)) === 0,
  );
  await j.capture(admin, 'catalog-admin');

  /* The launch state of design 1.3: a fresh company whose member is in a group, read while no target is publishable,
     which is the state a first customer meets. Owner-side, under the registry bypass, and put back. */
  const E = emptyCompany(W, `launch-${Date.now().toString(36).slice(-4)}`);
  const enabled = publishableTargets();
  j.check('a target was enabled before the launch-state reading', enabled.length > 0, enabled);
  try {
    setPublishable(enabled, false);
    await signIn(j, E.user.identity, E.user.email, { label: 'sign-in-launch' });
    const tab = await j.tab(E.user.identity, 'catalog-launch');
    await tab.navigate(catalogUrl(j, E.companyId));
    await tab.waitForSelector('[data-role="catalog-empty"]');
    j.check(
      'at the launch state, where no target is enabled and so no release can exist, the catalog is empty with its reason and no blank',
      await exists(tab, '[data-role="catalog-empty"][data-state="no_target_enabled"]'),
    );
    j.check(
      'and the sentence says why',
      (await textOf(tab, '[data-role="empty-sentence"]')).includes(
        'Phaeacia enables installation for a platform only after a run in that product is recorded, and none is enabled yet.',
      ),
    );
    await j.capture(tab, 'catalog-launch');

    /* The second of E5D-C-F8's three states, which needs a target that was enabled and then was not: a recipient who
       already holds an authorization opens the release, is told why the download has stopped, and the losses table
       still renders, as its pending row. */
    await signedIn(j, W, 'member');
    const blocked = await j.tab(W.users.member.identity, 'blocked-by-target');
    await blocked.navigate(releaseUrl(j, ctx.state.e5r1.releaseId));
    await blocked.waitForSelector('[data-role="install-section"]');
    j.check(
      'a recipient whose target was disabled after the fact is told why, and is offered no download control',
      (await exists(blocked, '[data-role="install-section"][data-blocked="E_TARGET_NOT_PUBLISHABLE"]')) &&
        !(await exists(blocked, '[data-role="download"]')),
    );
    j.check(
      'with the fixed sentence of design 1.3, which names the target',
      (await textOf(blocked, '[data-role="install-section"] [data-state="blocked"]')) ===
        'Installation for claude.ai is not enabled. Copies already installed are unchanged.',
    );
    /* The table renders in every state, which is the rule, and since E5PW-R-F1 its pending row follows this member's
       own newest report. Which of the two rows it is depends on the run: in a full run JI3 has left four reports on
       this release by this member, and a selection of this journey alone leaves none. Both are read from the page
       rather than assumed, and neither may be the sentence the member's own report contradicts.
       Changed by the E6 pages lane for E5C-R-F3 (evidence/batch-2-review.md): with a report of their own, this arm
       used to assert "The losses declared for this release are shown here when the service hands the block over.",
       a hand-over the block's own sentence four inches above says will not happen. It now asserts the blocked
       sentence; without a report, E5D-C-F8's sentence is unchanged. */
    const lossesRow = await textOf(blocked, '[data-role="install-section"] [data-role="losses-table"]');
    const ownReport = await exists(blocked, '[data-role="installation-evidence"] [data-role="reports"] [data-report]');
    j.check(
      'and the losses table still renders, as its one pending row (E5D-C-F8, state 2 of 3)',
      (await exists(blocked, '[data-role="install-section"] [data-role="losses"][data-losses="pending"]')) &&
        lossesRow.includes(
          ownReport
            ? 'Downloads of this release have stopped, so the losses declared for it are not shown here.'
            : 'Not installed yet; losses not assessed',
        ),
      { ownReport, row: lossesRow.slice(0, 140) },
    );
    j.check(
      'and it never promises a hand-over the blocked release will not make (E5C-R-F3)',
      !lossesRow.includes('shown here when the service hands the block over'),
      lossesRow.slice(0, 140),
    );
    j.check(
      'and where this member has reported, the row is not the sentence their own report contradicts (E5PW-R-F1)',
      !ownReport || !lossesRow.includes('Not installed yet; losses not assessed'),
      { ownReport, row: lossesRow.slice(0, 140) },
    );
    j.check('the report form is still there, because the authorization is what it rests on', await exists(blocked, '[data-role="report-form"]'));
    j.check(
      'and the pane placeholder does not promise a hand-over either (E6P-F11, E5C-R-F3 s class)',
      (await exists(blocked, '[data-role="no-block-blocked"]')) && !(await exists(blocked, '[data-role="no-block-yet"]')),
    );
    await j.capture(blocked, 'blocked-by-target', { anchor: '[data-role="install-section"]' });
  } finally {
    setPublishable(enabled, true);
  }
  j.equal('the target register is back as it was', publishableTargets(), enabled);
}

/** JI9: a filtered page that is empty above a cursor offers the continuation, not the sentence for an empty catalog
    (rule 11). The business reviewer reads every release of the company and is addressed by none. */
export async function ji9(ctx, j) {
  const W = await e5world(ctx);
  const R = await e5release(ctx, W, { text: declaredLossesPassport(), groups: [W.e5.emptyGroup] });
  cloneReleases(R.releaseId, 51);
  const total = countWhere('app.releases', `company_id = '${W.companyId}'`);
  j.check('the company now holds more releases than one catalog page carries', total > 50, total);

  await signedIn(j, W, 'business');
  const tab = await j.tab(W.users.business.identity, 'continuation');
  await tab.navigate(catalogUrl(j, W.companyId));
  await tab.waitForSelector('[data-role="catalog-empty"]');
  j.check(
    'a page whose rows are all filtered out, above a cursor, offers the continuation rather than a terminal empty sentence',
    (await exists(tab, '[data-role="catalog-empty"][data-state="more-pages"]')) && (await exists(tab, '[data-role="show-more"]')),
  );
  j.check(
    'and says that the catalog has not ended',
    (await textOf(tab, '[data-role="empty-sentence"]')).includes('more releases follow'),
  );
  await j.capture(tab, 'continuation');

  const from = tab.requests.length;
  await tab.click('[data-role="show-more"]');
  await tab.waitFor(`!document.querySelector('[data-role="catalog-empty"][data-state="more-pages"]')`);
  const reads = (await apiRequests(tab, j.origin, from)).filter((x) => x.path.endsWith('/catalog'));
  j.check('the continuation reads the next page with the answer’s cursor', reads.length >= 1 && reads.every((x) => x.status === 200), reads.map((x) => `${x.status}`));
  j.check(
    'and the last page, with no cursor after it, is where the fixed sentence for an empty catalog finally appears',
    await exists(tab, '[data-role="catalog-empty"][data-state="no_groups"], [data-role="catalog-empty"][data-state="none_for_my_groups"]'),
  );
  await j.capture(tab, 'continuation-ended');

  /* The release page of a release this reviewer may read but is not addressed: no install section at all, not a
     disabled one (design 4.2), and no report form. */
  const page = await j.tab(W.users.business.identity, 'not-a-recipient');
  await page.navigate(releaseUrl(j, R.releaseId));
  await page.waitForSelector('[data-role="release-head"]');
  j.check(
    'a reader who is not a recipient is offered no install section and no report form, not disabled ones',
    !(await exists(page, '[data-role="install-section"]')) && !(await exists(page, '[data-role="report-section"]')),
  );
  await j.capture(page, 'not-a-recipient');

  /* And the home page and every company page link to the catalog, which is how a member reaches it. Home shows the
     list only for somebody who belongs to more than one company, so the member is given a second one first. */
  const second = emptyCompany(W, `second-${Date.now().toString(36).slice(-4)}`);
  e3lib('member "$1" "$2" "$3"', second.companyId, W.users.member.id, '{member}');
  await signedIn(j, W, 'member');
  const home = await j.tab(W.users.member.identity, 'home-catalog-link');
  await home.navigate(`${j.origin}/`);
  await home.waitForSelector('[data-role="companies"] [data-role="link-catalog"]');
  j.equal('home links each of the member\u2019s companies to its catalog', await home.evaluate(`document.querySelectorAll('[data-role="companies"] [data-role="link-catalog"]').length`), 2);
  await j.capture(home, 'home-catalog-links');
  const members = await j.tab(W.users.member.identity, 'members-catalog-link');
  await members.navigate(companyUrl(j, '/members/', W.companyId));
  await members.waitForSelector('[data-role="company-links"]');
  j.check('and the members page carries the same link', await exists(members, '[data-role="company-links"] [data-role="link-catalog"]'));
}
