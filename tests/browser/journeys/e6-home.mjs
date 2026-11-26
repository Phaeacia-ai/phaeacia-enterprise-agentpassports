/* E6-JL2 and E6-JL9 (E6 design 1.5, 1.6, 4.1's home table, 4.2 and E6D-C-F3, E6D-C-F16): companies that stop.

   E6-JL2: a member of a suspended company opens the home page and sees the company with its state and no page links,
   and every company page answers the one code; the administrator of the same company, at aal2, is offered Export on
   the home page and saves the company's own copy, which is the entry design 4.1 left missing (E6D-C-F16); a person with
   one active and one suspended company sees both; and a company in its reading window (past its end, before export_by)
   is shown with its sentence and, for its administrator, Export.
   E6-JL9: a company aged past export_by owner-side with the sweep never run: its administrator's every company page
   answers E_ACCESS_PERIOD_ENDED, a recipient's catalog and release page answer it, a hand-built download and a
   hand-built Export from the pages' own api.mjs are refused with it, and home shows the closed window with no Export;
   then the operator sets new dates on the company page and all of it works again. The first version of the design would
   have passed this journey's first half while every read still worked. */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { e3lib, ROOT, sql } from '../../e3/stack/helpers.mjs';
import { PHONE } from '../cdp.mjs';
import { signIn, sleep } from './common.mjs';
import { routes } from './e4-common.mjs';
import { adminAal2, agePeriod, count, e6world, exists, handBuilt, ok, operatorAal2, operatorUser, ownedRelease, signedIn, smallAdminAal2, smallCompany, text, waitPath } from './e6-common.mjs';

const COMPANY_PAGES = ['/members/', '/groups/', '/catalog/', '/reviews/', '/releases/'];

/** Every company page of a company, opened in turn; the code each one shows. */
async function codesOfCompanyPages(j, tab, companyId) {
  const codes = {};
  for (const path of COMPANY_PAGES) {
    await tab.navigate(`${j.origin}${path}?company=${companyId}`);
    await tab.waitForSelector('[role="alert"][data-code]', { timeout: 15000 });
    codes[path] = await tab.evaluate(`document.querySelector('[role="alert"][data-code]').dataset.code`);
  }
  return codes;
}

/** Tells the browser where a saved file goes, as JI2 does; the directory. */
async function allowDownloads(j, tab) {
  const dir = join(ROOT, '.scratch', 'browser', 'downloads', `${j.id}-${Date.now().toString(36)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const method of ['Browser.setDownloadBehavior', 'Page.setDownloadBehavior']) {
    try {
      await tab.send(method, { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
      return dir;
    } catch {
      /* the other method */
    }
  }
  return dir;
}

async function savedFile(dir) {
  for (let i = 0; i < 80; i++) {
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => !f.endsWith('.crdownload')) : [];
    if (files.length) return join(dir, files[0]);
    await sleep(100);
  }
  return null;
}

/** E6-JL2: the suspended company, from its member's and its administrator's home page; one active and one suspended;
    and the reading window. */
export async function e6jl2(ctx, j) {
  const C = await smallCompany(ctx, 'jl2');
  const { call } = await routes(ctx);
  const memberIdentity = await signIn(j, C.users.member.identity, C.users.member.email, { label: 'jl2-member-sign-in' }).then(async (t) => {
    await waitPath(t, '/members/');
    await t.close().catch(() => undefined);
    return C.users.member.identity;
  });
  ok(
    await call('operatorCompanyStatus', { user: operatorUser(ctx), params: { companyId: C.companyId }, body: { status: 'suspended', reasonCode: 'customer_request' } }),
    'suspend',
  );
  const home = await j.tab(memberIdentity, 'suspended-home');
  await home.setViewport(PHONE);
  await home.navigate(`${j.origin}/`);
  await home.waitForSelector(`[data-company="${C.companyId}"]`);
  j.check(
    'a person whose one company is suspended stays on the home page, which lists it with its state and sentence',
    (await home.location()).pathname === '/' &&
      (await exists(home, `[data-company="${C.companyId}"][data-state="inactive"][data-company-status="suspended"]`)) &&
      (await text(home, `[data-company="${C.companyId}"] [data-role="inactive-sentence"]`)) ===
        'This company is suspended. Nobody can read or change anything in it until Phaeacia resumes it; an administrator can still take a copy with Export.',
  );
  j.check(
    'with no link to the company’s pages and, for a plain member, no Export',
    !(await exists(home, `[data-company="${C.companyId}"] a`)) && !(await exists(home, `[data-company="${C.companyId}"] [data-role="takeout"]`)),
  );
  await j.capture(home, 'suspended-member-home');
  const codes = await codesOfCompanyPages(j, home, C.companyId);
  j.equal('every company page answers the one code, E_COMPANY_INACTIVE', Object.values(codes), COMPANY_PAGES.map(() => 'E_COMPANY_INACTIVE'));
  j.check(
    'the refusal carries a link home (E6P-F8)',
    await exists(home, '[role="alert"][data-code="E_COMPANY_INACTIVE"] [data-role="home-link"][href="/"]'),
  );
  await j.capture(home, 'suspended-releases-page');

  /* The administrator at aal2: Export from the home page of a suspended company inside its window (E6D-C-F16). */
  const adminIdentity = await smallAdminAal2(j, C);
  const admin = await j.tab(adminIdentity, 'suspended-admin');
  await admin.setViewport(PHONE);
  const dir = await allowDownloads(j, admin);
  await admin.navigate(`${j.origin}/`);
  await admin.waitForSelector(`[data-company="${C.companyId}"] [data-role="takeout"]`);
  await j.capture(admin, 'suspended-admin-home');
  const audits = count('app.audit_events', `action = 'company.export' and company_id = '${C.companyId}'`);
  await admin.click(`[data-company="${C.companyId}"] [data-role="takeout"]`);
  await admin.waitForSelector(`[data-company="${C.companyId}"] [data-state="takeout-saved"]`, { timeout: 20000 });
  const file = await savedFile(dir);
  j.check('Export wrote one JSON file named from the slug', file !== null && file.endsWith('.json') && file.includes(C.slug), file);
  if (file) {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    j.check(
      'whose document is the company’s own: its id, its sections and counts, and what it withheld, and no ok flag',
      doc.company?.id === C.companyId && typeof doc.sections === 'object' && typeof doc.counts === 'object' && typeof doc.withheld === 'object' && !('ok' in doc),
    );
  }
  j.equal('the service recorded one company.export audit row', count('app.audit_events', `action = 'company.export' and company_id = '${C.companyId}'`) - audits, 1);
  j.equal('no blob URL ever became a document of this tab', admin.documents.filter((d) => String(d.url).startsWith('blob:')).length, 0);
  await j.capture(admin, 'suspended-admin-exported');
  rmSync(dir, { recursive: true, force: true });

  /* One active and one suspended: the member of the suspended company joins the run's E6 company. */
  const W = await e6world(ctx);
  e3lib('member "$1" "$2" "$3"', W.companyId, C.users.member.id, '{member}');
  await home.navigate(`${j.origin}/`);
  await home.waitForSelector(`[data-company="${W.companyId}"][data-state="active"]`);
  j.check(
    'a person with one active and one suspended company sees both: the active one with its links, the suspended one without',
    (await exists(home, `[data-company="${W.companyId}"] [data-role="company-link"]`)) &&
      (await exists(home, `[data-company="${C.companyId}"][data-state="inactive"]`)) &&
      !(await exists(home, `[data-company="${C.companyId}"] a`)),
  );
  await j.capture(home, 'one-active-one-suspended');

  /* The reading window: the agreement ended an hour ago and export_by is thirteen days ahead (owner-side dates). */
  ok(await call('operatorCompanyStatus', { user: operatorUser(ctx), params: { companyId: C.companyId }, body: { status: 'active', reasonCode: 'customer_request' } }), 'resume');
  agePeriod(C.companyId, '1 hour', '-13 days', '-43 days');
  /* E6PW-R-F1 with B3-R-F1: reads are still served in the window (design 1.5), and a person whose one company is in it
     STAYS on the home page, where the row says so and carries the three read links and, for an administrator at aal2,
     Export; a forward would hide the sentence and turn the refusal's link home into a loop. */
  await admin.navigate(`${j.origin}/`);
  await admin.waitForSelector(`[data-company="${C.companyId}"][data-access="export_window"]`, { timeout: 15000 });
  const adminPath = (await admin.location().catch(() => ({}))).pathname;
  j.check(
    'a person whose one company is in its reading window stays on the home page, which says changes have stopped and offers the administrator Export',
    adminPath === '/' &&
      ((await text(admin, `[data-company="${C.companyId}"] [data-role="inactive-sentence"]`)) ?? '').startsWith("This company's agreement has ended. Changes have stopped;") &&
      (await exists(admin, `[data-company="${C.companyId}"] [data-role="window-links"] [data-role="link-members"]`)) &&
      (await exists(admin, `[data-company="${C.companyId}"] [data-role="takeout"]`)),
  );
  await j.capture(admin, 'export-window-admin-home');
  /* The member with one working company and this one sees the window company's row: the sentence, the three read
     links and no link to a page whose point is a write; as a plain member, no Export. */
  await home.navigate(`${j.origin}/`);
  await home.waitForSelector(`[data-company="${C.companyId}"][data-access="export_window"]`);
  j.check(
    'a company in its reading window says changes have stopped and its records can be read, and keeps links to its catalog, members and releases, none to reviews or groups, and no Export for a plain member',
    ((await text(home, `[data-company="${C.companyId}"] [data-role="inactive-sentence"]`)) ?? '').startsWith("This company's agreement has ended. Changes have stopped;") &&
      (await exists(home, `[data-company="${C.companyId}"] [data-role="window-links"] [data-role="link-catalog"]`)) &&
      (await exists(home, `[data-company="${C.companyId}"] [data-role="window-links"] [data-role="link-members"]`)) &&
      (await exists(home, `[data-company="${C.companyId}"] [data-role="window-links"] [data-role="link-releases"]`)) &&
      !(await exists(home, `[data-company="${C.companyId}"] [data-role="link-reviews"]`)) &&
      !(await exists(home, `[data-company="${C.companyId}"] [data-role="link-groups"]`)) &&
      !(await exists(home, `[data-company="${C.companyId}"] [data-role="takeout"]`)),
  );
  await j.capture(home, 'export-window-home');
  await home.click(`[data-company="${C.companyId}"] [data-role="link-members"]`);
  await waitPath(home, '/members/', { timeout: 30000 });
  await home.waitForSelector('[data-role="members"], [role="alert"][data-code]', { timeout: 15000 });
  j.check(
    'the members page of a company in its reading window answers a plain member with no refusal',
    !(await exists(home, '[role="alert"][data-code="E_ACCESS_PERIOD_ENDED"]')) && !(await exists(home, '[role="alert"][data-code="E_COMPANY_INACTIVE"]')),
  );
  await j.capture(home, 'export-window-member-members');
  ctx.state.e6jl2 = C;
}

/** E6-JL9: past export_by with the sweep never run; then the operator extends the dates. */
export async function e6jl9(ctx, j) {
  const W = await e6world(ctx);
  const R = await ownedRelease(ctx, W, W.users.heir);
  const recipient = await signedIn(j, W, 'recipient');
  const adminIdentity = await adminAal2(j, W);
  /* Owner-side, labelled: the agreement ended twenty days ago and export_by an hour ago; the sweep is never run. */
  agePeriod(W.companyId, '20 days', '1 hour', '-29 days');
  j.equal('the company is still active: nothing set its status, only time moved', sql(`select status from app.companies where id = '${W.companyId}'`), 'active');

  const admin = await j.tab(adminIdentity, 'expired-admin');
  await admin.setViewport(PHONE);
  const codes = await codesOfCompanyPages(j, admin, W.companyId);
  j.equal('the administrator’s every company page answers E_ACCESS_PERIOD_ENDED', Object.values(codes), COMPANY_PAGES.map(() => 'E_ACCESS_PERIOD_ENDED'));
  await admin.navigate(`${j.origin}/members/?company=${W.companyId}`);
  await admin.waitForSelector('[role="alert"][data-code="E_ACCESS_PERIOD_ENDED"]');
  j.check(
    'the refusal carries a link home (E6P-F8)',
    await exists(admin, '[role="alert"][data-code="E_ACCESS_PERIOD_ENDED"] [data-role="home-link"][href="/"]'),
  );
  await j.capture(admin, 'expired-members-page');
  const takeoutRefused = await handBuilt(admin, `api.takeout(${JSON.stringify(W.companyId)})`);
  j.equal('a hand-built Export from the page’s own api.mjs is refused with the same code', takeoutRefused, { status: 409, code: 'E_ACCESS_PERIOD_ENDED' });
  await admin.navigate(`${j.origin}/`);
  await admin.waitForSelector(`[data-company="${W.companyId}"][data-access="expired"]`);
  j.check(
    'home shows the closed window and offers no Export',
    (await text(admin, `[data-company="${W.companyId}"] [data-role="inactive-sentence"]`)) ===
      "This company's agreement ended and its window for reading and exporting its records has closed." &&
      !(await exists(admin, `[data-company="${W.companyId}"] [data-role="takeout"]`)),
  );
  await j.capture(admin, 'expired-home');

  const rec = await j.tab(recipient, 'expired-recipient');
  await rec.setViewport(PHONE);
  await rec.navigate(`${j.origin}/catalog/?company=${W.companyId}`);
  await rec.waitForSelector('[role="alert"][data-code="E_ACCESS_PERIOD_ENDED"]');
  j.check('the recipient’s catalog answers the same code', true);
  /* The release read is not company-scoped by its address: it reads the release first, under row level security, and
     since E6S-C-F2 the read cutoff is in the policies, so past export_by the row is not there and the page is the
     release's not-found state rather than the period sentence (E6P-F5 in evidence/e6-pages.md). */
  await rec.navigate(`${j.origin}/release/?release=${R.releaseId}`);
  await rec.waitForSelector('[data-state="not-found"]');
  j.check('the recipient’s release page is the not-found state, with no install control', !(await exists(rec, '[data-role="download"]')));
  const downloadRefused = await handBuilt(rec, `api.download(${JSON.stringify(R.releaseId)})`);
  j.equal('and a hand-built download is refused with it', downloadRefused, { status: 409, code: 'E_ACCESS_PERIOD_ENDED' });
  await j.capture(rec, 'expired-release');
  const ledger = count('app.release_downloads', `release_id = '${R.releaseId}'`);

  /* The operator extends the dates on the company page, which says where the company stands first. */
  const opIdentity = await operatorAal2(j, ctx);
  const op = await j.tab(opIdentity, 'extend');
  await op.setViewport(PHONE);
  await op.navigate(`${j.origin}/operator/company/?company=${W.companyId}`);
  await op.waitForSelector('[data-role="access-period"][data-access="expired"]');
  j.check(
    'the operator’s page says reading and exporting stopped, and deletion has been possible since',
    ((await text(op, '[data-role="access-sentence"]')) ?? '').startsWith('Reading and exporting stopped on') &&
      ((await text(op, '[data-role="deletion-sentence"]')) ?? '').startsWith('Deletion has been possible since'),
  );
  await j.capture(op, 'operator-expired', { anchor: '[data-role="access-period"]' });
  const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await op.evaluate(`(() => { const e = document.querySelector('#period-end'); e.value = ${JSON.stringify(future)}; return true; })()`);
  await op.click('[data-role="set-period"]');
  await op.waitForSelector('[data-role="access-period"][data-access="current"]', { timeout: 15000 });
  j.check('the operator sets new dates, and the company is current again', true);
  await j.capture(op, 'operator-extended', { anchor: '[data-role="access-period"]' });

  await admin.navigate(`${j.origin}/members/?company=${W.companyId}`);
  await admin.waitForSelector('[data-role="takeout"] [data-role="takeout"]');
  j.check('the administrator’s members page works again, with Export', true);
  const dir = await allowDownloads(j, admin);
  await admin.click('[data-role="takeout"] button[data-role="takeout"]');
  await admin.waitForSelector('[data-state="takeout-saved"]', { timeout: 20000 });
  j.check('and Export saves the file again', (await savedFile(dir)) !== null);
  await j.capture(admin, 'extended-members-export', { anchor: '[data-role="takeout"]' });
  rmSync(dir, { recursive: true, force: true });
  await rec.navigate(`${j.origin}/catalog/?company=${W.companyId}`);
  await rec.waitForSelector(`[data-release="${R.releaseId}"][data-blocked="none"]`);
  const downloaded = await handBuilt(rec, `api.download(${JSON.stringify(R.releaseId)})`);
  j.equal('the recipient’s catalog and download work again', [downloaded.status, count('app.release_downloads', `release_id = '${R.releaseId}'`) - ledger], [200, 1]);
}
