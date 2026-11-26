/* E6-JL1, E6-JL7 and E6-JL8 (E6 design 4.1, 4.2 and 4.3): the operator's three pages.

   E6-JL1 is the plan's exit evidence, "Second company created through settings without code changes": an operator
   creates a company at phone width, the accept link is copied from its read-only field, and the new administrator
   accepts it in a second browser and lands on the members page as an administrator, with no SQL anywhere in the
   path. The only SQL in the journey reads afterwards what the pages made. E6-JL7 is the end of a company: suspended,
   its manifest read as counts, closed with a recorded reason and deleted, the delete block's count table read from the
   page, and no export control anywhere on the operator's pages, with the design's retired operator export path
   answering no route. E6-JL8 is design 4.3's one new rule: the accept link is the value of a read-only field and no a
   element's href, the address never carries it, and no capture holds it (the harness masks the field and checks). */

import { sql } from '../../e3/stack/helpers.mjs';
import { PHONE } from '../cdp.mjs';
import { signIn, startSetup, tag, verifySetup } from './common.mjs';
import {
  acceptIn,
  acceptLinkFor,
  acceptLinkOnPage,
  agePeriod,
  count,
  exists,
  linkInAnchors,
  linkInLocation,
  mailMode,
  OPERATOR_EMAIL,
  operatorAal2,
  smallCompany,
  text,
  waitPath,
} from './e6-common.mjs';

const isoDay = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const setValue = (tab, selector, value) =>
  tab.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)}; return true; })()`);

/** Fills /operator/new/ and presses Create; the tab shows the answer. */
async function createThroughPage(tab, { slug, name, email, endsInDays = 56, invoice = '' }) {
  await tab.waitForSelector('[data-role="create-form"]');
  await tab.type('#company-slug', slug);
  await tab.type('#company-name', name);
  await tab.type('#first-admin-email', email);
  await setValue(tab, '#period-end', isoDay(endsInDays));
  if (invoice) await tab.type('#invoice-ref', invoice);
  await tab.click('[data-role="create-company"]');
}

/** E6-JL1: the exit evidence, at phone width, with no SQL in the path. */
export async function e6jl1(ctx, j) {
  const run = tag();
  const identity = await operatorAal2(j, ctx, {
    onAal1: async (tab) => {
      j.check(
        'an operator at aal1 asking for the register is answered by the server and shown the link to /mfa/ (design 4.1)',
        (await exists(tab, '[data-state="mfa"][data-code="E_OPERATOR_MFA_REQUIRED"] [data-role="mfa-link"]')) &&
          !(await exists(tab, '[data-role="register-table"]')) &&
          !(await exists(tab, '[data-role="new-company"]')) &&
          !(await exists(tab, '[data-role="run-sweep"]')),
      );
      await j.capture(tab, 'operator-aal1');
    },
  });
  const tab = await j.tab(identity, 'create');
  await tab.setViewport(PHONE);
  await tab.navigate(`${j.origin}/operator/new/`);
  await tab.waitForSelector('[data-role="create-form"]');
  j.check(
    'the form carries the access period fields, the dates the service computes are not computed by the page',
    (await exists(tab, '#period-start')) && (await exists(tab, '#period-end')) && (await exists(tab, '[data-role="period-computed"]')),
  );
  await j.capture(tab, 'new-company-form');

  const slug = `e6p-jl1-${run}`;
  const email = `e6p-jl1-admin-${run}@example.invalid`;
  const companiesBefore = count('app.companies', `slug = '${slug}'`);
  await createThroughPage(tab, { slug, name: `JL1 Company ${run}`, email, invoice: `INV-JL1-${run}` });
  /* E7 design 1.1 and section 4: in `mail` mode the same answer carries no link, so the block says one sentence and
     the field, the copy control and the operator's "you are holding it" line are gone with no page change. */
  await tab.waitForSelector(mailMode() ? '[data-state="link-mailed"]' : '[data-role="handover"]');
  j.equal('one company was made by the page, where there was none', [companiesBefore, count('app.companies', `slug = '${slug}'`)], [0, 1]);
  const companyId = (await tab.evaluate(`document.querySelector('[data-role="company-link"]')?.getAttribute('href') ?? ''`)).split('company=')[1];
  j.check(
    'the answer shows the stored period, with the three dates the service stored',
    /agreement ends on \d{1,2} \w+ \d{4}, reading and exporting stop on \d{1,2} \w+ \d{4}, and deletion is due by \d{1,2} \w+ \d{4}\./.test(
      (await text(tab, '[data-role="stored-period"]')) ?? '',
    ),
  );
  if (mailMode()) {
    j.check(
      'in mail mode the answer says the link was emailed and offers no field, no copy control and no holding line (E7 section 4)',
      (await text(tab, '[data-state="link-mailed"]')) === 'The link was emailed.' &&
        !(await exists(tab, 'input[data-role="accept-link"]')) &&
        !(await exists(tab, '[data-role="copy-link"]')) &&
        !(await exists(tab, '[data-role="link-held"]')),
    );
  } else {
    j.check(
      'and the accept link once, under design 1.2 rule 3 and rule 5 and the operator’s recovery line',
      (await exists(tab, '[data-role="handover"] [data-role="link-what"]')) &&
        (await exists(tab, '[data-role="handover"] [data-role="link-held"]')) &&
        ((await text(tab, '[data-role="link-once"]')) ?? '').includes('open the company and invite the administrator again'),
    );
  }
  /* In handover the link is the page's one read-only value; in mail it is the one the catcher recorded for that
     address, which is the link the person would have received (E7 1.1, acceptLinkFor). */
  const acceptUrl = await acceptLinkFor(j, tab, '', email);
  j.check(
    'the link names this origin’s /accept with its values in the fragment, and in handover mode is a read-only field',
    typeof acceptUrl === 'string' &&
      acceptUrl.startsWith(`${j.origin}/accept#`) &&
      /token_hash=/.test(acceptUrl) &&
      (mailMode() || (await tab.evaluate(`document.querySelector('input[data-role="accept-link"]').readOnly === true`))),
  );
  j.equal('no a element carries it, and the address does not (design 4.3)', [await linkInAnchors(tab), await linkInLocation(tab)], [false, false]);
  if (!mailMode()) {
    await tab.click('[data-role="copy-link"]');
    await tab.waitFor(`document.querySelector('[data-role="copy-status"]')?.textContent.length > 0`);
    j.check('the copy control answers with a sentence either way', ['Copied.', 'Select the link and copy it.'].includes(await text(tab, '[data-role="copy-status"]')));
  }
  await j.capture(tab, 'company-created');

  /* The new administrator, in a browser of their own, from nothing but the link. */
  const admin = await acceptIn(j, `e6-jl1-admin`, acceptUrl, 'first-admin');
  await waitPath(admin, '/mfa/', { timeout: 30000 });
  await admin.waitForSelector('[data-state="enrol"]');
  j.check('an administrator arriving without a factor is sent to enrol first (pages section 1, forced enrolment)', true);
  const key = await startSetup(admin);
  await verifySetup(admin, key);
  await waitPath(admin, '/members/', { timeout: 30000 });
  await admin.waitForSelector('[data-role="own-roles"]');
  j.check(
    'and lands on the members page of the new company as an administrator',
    ((await text(admin, '[data-role="own-roles"]')) ?? '').includes('Administrator') &&
      (await admin.location()).search === `?company=${companyId}`,
  );
  j.equal(
    'the database holds exactly one active administrator membership for that address, made by the acceptance',
    count(
      'app.memberships m join auth.users u on u.id = m.user_id',
      `m.company_id = '${companyId}' and lower(u.email) = '${email}' and m.status = 'active' and 'company_admin' = any (m.roles)`,
    ),
    1,
  );
  await admin.setViewport(PHONE);
  await j.capture(admin, 'first-admin-members');

  /* The register lists it; the company page opens from it. */
  await tab.navigate(`${j.origin}/operator/`);
  await tab.waitForSelector(`[data-company="${companyId}"]`);
  j.check('the register lists the new company with its status and access state', ((await text(tab, `[data-company="${companyId}"]`)) ?? '').includes(slug));
  await j.capture(tab, 'register', { anchor: '[data-role="register"]' });
  await tab.click(`[data-company="${companyId}"] [data-role="company-link"]`);
  await waitPath(tab, '/operator/company/');
  await tab.waitForSelector('[data-role="manifest"]');
  j.check('its page opens from the register, with every block', (await exists(tab, '[data-role="quotas"]')) && (await exists(tab, '[data-role="succession"]')));
  await j.capture(tab, 'company-page-active');
  ctx.state.e6jl1 = { companyId, slug };
}

/* The operator's pages carry no control that takes a customer's records: no button or link naming Export. */
const exportControls = (tab) =>
  tab.evaluate(`[...document.querySelectorAll('button, a, input[type="submit"]')].filter((n) => /export/i.test(n.textContent + ' ' + (n.value ?? ''))).length`);

/** E6-JL7: suspend, read the manifest, close with a recorded reason, delete; the register no longer lists it. */
export async function e6jl7(ctx, j) {
  const C = await smallCompany(ctx, 'jl7');
  /* Its member is signed in first, so the closed company's home state is read by somebody who belongs to it. */
  const member = await signIn(j, C.users.member.identity, C.users.member.email, { label: 'jl7-member-sign-in' });
  await waitPath(member, '/members/');
  await member.setViewport(PHONE);
  const identity = await operatorAal2(j, ctx);
  const tab = await j.tab(identity, 'end-of-company');
  await tab.setViewport(PHONE);
  for (const path of ['/operator/', '/operator/new/', `/operator/company/?company=${C.companyId}`]) {
    await tab.navigate(`${j.origin}${path}`);
    await tab.waitForSelector('[data-role="register"], [data-role="create-form"], [data-role="manifest"]');
    j.equal(`no export control on ${path.split('?')[0]} (E6D-C-F1a)`, await exportControls(tab), 0);
  }
  const retired = await fetch(`${j.origin}/api/operator/companies/${C.companyId}/export`, { method: 'GET', redirect: 'manual' });
  j.equal('the design’s retired operator export path is no route: the shell answers 404', retired.status, 404);

  await tab.click('[data-role="suspend"]');
  await tab.waitForSelector('[data-role="confirm-status"] [data-role="status-reason-choice"]');
  j.equal(
    'suspending asks for the reason the audit row records, from the closed list of three',
    await tab.evaluate(`[...document.querySelectorAll('[data-role="status-reason-choice"] input')].map((i) => i.value)`),
    ['customer_request', 'non_payment', 'operator_decision'],
  );
  await j.capture(tab, 'confirm-suspend', { anchor: '[data-role="status"]' });
  await tab.click('[data-role="confirm-status-change"]');
  await tab.waitFor(`document.querySelector('[data-role="status-word"]')?.textContent === 'Suspended'`, { timeout: 15000 });
  j.equal('the company is suspended, with the reason recorded', sql(`select details->>'reason_code' from app.audit_events where company_id = '${C.companyId}' and action = 'company.suspend' order by id desc limit 1`), 'customer_request');

  j.check(
    'the manifest is counts by section with the two byte sums and the sentence for a company under the route ceiling',
    (await tab.evaluate(`document.querySelectorAll('[data-role="manifest-table"] tbody tr').length`)) === 21 &&
      (await text(tab, '[data-role="manifest-sentence"]')) === "This company's administrator can take a copy with Export on the company's own pages." &&
      (await text(tab, '[data-role="manifest-no-copy"]')) === "Phaeacia takes no copy of a customer's records from here. These are counts, not contents.",
  );
  await j.capture(tab, 'manifest', { anchor: '[data-role="manifest"]' });

  await tab.waitForSelector('[data-role="close"][data-window-open="yes"]');
  j.check(
    'the close block, with the window still open, says closing cuts it short and offers only the customer’s instruction',
    ((await text(tab, '[data-role="cut-short"]')) ?? '').includes('Closing now ends that early.') &&
      JSON.stringify(await tab.evaluate(`[...document.querySelectorAll('[data-role="close-reason-choice"] input')].map((i) => i.value)`)) ===
        JSON.stringify(['customer_instruction']),
  );
  j.check('and no delete block while the company is not closed', !(await exists(tab, '[data-role="delete"]')));
  await tab.type('#close-slug', `${C.slug}-not`);
  await tab.click('[data-role="close-company"]');
  await tab.waitForSelector('[data-role="close"] [data-code="E_CONFIRMATION_MISMATCH"]');
  j.check('a slug typed wrong is refused beside the control, and nothing closed', sql(`select status from app.companies where id = '${C.companyId}'`) === 'suspended');
  await j.capture(tab, 'close-mismatch', { anchor: '[data-role="close"]' });
  await tab.type('#close-slug', C.slug);
  await tab.click('[data-role="close-company"]');
  await tab.waitForSelector('[data-role="delete"]', { timeout: 15000 });
  j.check(
    'closed: the status block says so in the page’s own sentence and the delete block appears',
    (await text(tab, '[data-role="closed-sentence"]')) === 'Phaeacia has closed this company.' && !(await exists(tab, '[data-role="suspend"], [data-role="resume"]')),
  );
  j.equal('closed with the recorded instruction', sql(`select details->>'reason_code' from app.audit_events where company_id = '${C.companyId}' and action = 'company.close' order by id desc limit 1`), 'customer_instruction');

  await member.navigate(`${j.origin}/`);
  await member.waitForSelector(`[data-company="${C.companyId}"][data-company-status="closed"]`);
  j.equal('the member’s home page shows the closed company with the page’s sentence', await text(member, `[data-company="${C.companyId}"] [data-role="inactive-sentence"]`), 'Phaeacia has closed this company.');
  await j.capture(member, 'closed-home');

  j.check(
    'the delete block names what goes and offers the two admissible reasons',
    ((await text(tab, '[data-role="delete"]')) ?? '').includes('Accounts are not deleted here.') &&
      JSON.stringify(await tab.evaluate(`[...document.querySelectorAll('[data-role="delete-reason-choice"] input')].map((i) => i.value)`)) ===
        JSON.stringify(['retention_deadline', 'customer_instruction']),
  );
  await j.capture(tab, 'delete-block', { anchor: '[data-role="delete"]' });
  await tab.evaluate(`document.querySelector('[data-role="delete-reason-choice"] input[value="customer_instruction"]').click()`);
  await tab.type('#delete-slug', C.slug);
  await tab.click('[data-role="delete-company"]');
  await tab.waitForSelector('[data-role="deleted-table"]', { timeout: 20000 });
  const rows = await tab.evaluate(`[...document.querySelectorAll('[data-role="deleted-table"] tbody tr')].map((r) => [r.cells[0].textContent, Number(r.cells[1].textContent.replace(/,/g, ''))])`);
  j.check(
    'the delete block’s count table is read from the page: every section with its count, members among them',
    rows.length >= 10 && rows.some(([k, n]) => k === 'memberships' && n === 2),
    rows,
  );
  j.record('the deletion as the page shows it', rows);
  await j.capture(tab, 'deleted');
  j.equal('the company is gone', count('app.companies', `id = '${C.companyId}'`), 0);
  await tab.navigate(`${j.origin}/operator/`);
  await tab.waitForSelector('[data-role="register"]');
  j.equal('and the register no longer lists it', await exists(tab, `[data-company="${C.companyId}"]`), false);
}

/** E6-JL8: the accept link is a read-only field's value, in no a element, never in the address, and in no capture. */
export async function e6jl8(ctx, j) {
  const target = ctx.state.e6jl1?.companyId;
  if (!j.check('E6-JL1 made a company to invite into', Boolean(target))) return;
  const identity = await operatorAal2(j, ctx);
  const tab = await j.tab(identity, 'succession-link');
  await tab.setViewport(PHONE);
  await tab.navigate(`${j.origin}/operator/company/?company=${target}`);
  await tab.waitForSelector('[data-role="admin-invite-form"]');
  const heir = `e6p-jl8-${tag()}@example.invalid`;
  await tab.type('#admin-email', heir);
  await tab.click('[data-role="invite-admin"]');
  await tab.waitForSelector(mailMode() ? '[data-role="succession"] [data-state="link-mailed"]' : '[data-role="succession"] [data-role="handover"]', { timeout: 15000 });
  const value = await acceptLinkFor(j, tab, '[data-role="succession"]', heir);
  j.check(
    mailMode()
      ? 'the succession answer puts no link on the page and the mail carries one'
      : 'the succession answer puts the link in the one read-only field',
    typeof value === 'string' && value.includes('token_hash=') && value.includes('invite='),
  );
  if (mailMode())
    j.check('and the page holds no field at all in mail mode', !(await exists(tab, '[data-role="succession"] input[data-role="accept-link"]')));
  j.equal('no a element has it as href', await linkInAnchors(tab), false);
  j.equal('the address never carries it', await linkInLocation(tab), false);
  j.equal(
    'no document this tab ever loaded carried token_hash or invite',
    tab.documents.filter((d) => /token_hash|invite/.test(String(d.url))).length,
    0,
  );
  j.check(
    mailMode()
      ? 'and nothing says Phaeacia is holding a first factor, because it is not (E6 4.1 in mail mode)'
      : 'Phaeacia holding the first factor is said beside it (design 1.2 rule 5)',
    (await exists(tab, '[data-role="succession"] [data-role="link-held"]')) === !mailMode(),
  );
  await j.capture(tab, 'succession-link', { anchor: '[data-role="succession"]' });
  await tab.reload();
  await tab.waitForSelector('[data-role="admin-invite-form"]');
  j.equal('a reload does not show it again (design 1.2 rule 1)', await acceptLinkOnPage(tab), null);
  /* A second succession invitation for another address while one is open is refused beside its control. */
  await tab.type('#admin-email', `e6p-jl8-second-${tag()}@example.invalid`);
  await tab.click('[data-role="invite-admin"]');
  await tab.waitForSelector('[data-role="succession"] [data-code]');
  j.equal(
    'a second open succession invitation is refused E_SUCCESSION_PENDING, beside the control',
    await tab.evaluate(`document.querySelector('[data-role="succession"] [data-code]').dataset.code`),
    'E_SUCCESSION_PENDING',
  );
  await j.capture(tab, 'succession-pending', { anchor: '[data-role="succession"]' });
}

/** E6-JLS: the register's order and the sweep, the create form's two refusals, a company with no agreement dates, and
    the close block once the reading window has closed (design 4.2's operator states the other journeys do not reach). */
export async function e6jls(ctx, j) {
  const identity = await operatorAal2(j, ctx);
  const tab = await j.tab(identity, 'register-states');
  await tab.setViewport(PHONE);

  /* A company the seed made with no access period: the line above every other block (design 4.1 item 3). */
  await tab.navigate(`${j.origin}/operator/company/?company=${ctx.ids.ALPHA}`);
  await tab.waitForSelector('[data-role="manifest"]');
  j.check(
    'a company with no agreement dates says so above everything, and its access block says it again',
    (await text(tab, '[data-state="no-period"]')) === 'This company has no agreement dates. Set them.' &&
      (await exists(tab, '[data-role="access-period"][data-access="none"]')),
  );
  await j.capture(tab, 'no-period');

  /* An overdue company, aged owner-side and still active: the register sorts it first; the sweep suspends it and lists
     it for deletion, and deletes nothing. */
  const C = await smallCompany(ctx, 'jls');
  agePeriod(C.companyId, '60 days', '46 days', '16 days');
  await tab.navigate(`${j.origin}/operator/`);
  await tab.waitForSelector('[data-role="register-table"]');
  /* HOSTED-F2 (evidence/operator-landing.md, OPL-F5): the table is soonest ending first by default; the routine's order is
     the other choice of the order control, chosen here so this step asserts what its label says. */
  await tab.click('[data-role="register-order"] input[value="service"]');
  await tab.waitFor(`document.querySelector('[data-role="register-order"] input:checked')?.value === 'service'`);
  j.equal(
    'the register lists the overdue company first, as the routine sorts it',
    await tab.evaluate(`document.querySelector('[data-role="register-table"] tbody tr [data-company]')?.dataset.company ?? null`),
    C.companyId,
  );
  j.check('its deletion cell says overdue', ((await text(tab, `[data-company="${C.companyId}"]`)) ?? '').length > 0 && (await exists(tab, `[data-company="${C.companyId}"][data-deletion="overdue"]`)));
  j.check('and the sweep counts it as waiting for suspension', ((await text(tab, '[data-role="sweep-counts"]')) ?? '').includes('Waiting for suspension: 1.'));
  await j.capture(tab, 'register-overdue-first', { anchor: '[data-role="register"]' });
  const companies = count('app.companies', 'true');
  await tab.click('[data-role="run-sweep"]');
  await tab.waitForSelector('[data-state="swept"]', { timeout: 15000 });
  j.check(
    'the sweep’s answer lists what it suspended and what is due for deletion',
    (await exists(tab, '[data-role="swept-suspended"]')) && (await exists(tab, '[data-role="swept-due"]')),
  );
  j.equal('it suspended the company and deleted nothing', [sql(`select status from app.companies where id = '${C.companyId}'`), count('app.companies', 'true')], ['suspended', companies]);
  await j.capture(tab, 'sweep-result', { anchor: '[data-role="sweep"]' });

  /* The close block once export_by has passed: no cut-short sentence, and the three reasons. */
  await tab.navigate(`${j.origin}/operator/company/?company=${C.companyId}`);
  await tab.waitForSelector('[data-role="close"][data-window-open="no"]');
  j.check(
    'with the window closed the close block has no cut-short sentence and offers the three reasons',
    !(await exists(tab, '[data-role="cut-short"]')) &&
      JSON.stringify(await tab.evaluate(`[...document.querySelectorAll('[data-role="close-reason-choice"] input')].map((i) => i.value)`)) ===
        JSON.stringify(['retention_deadline', 'customer_instruction', 'operator_request']),
  );
  await j.capture(tab, 'close-window-closed', { anchor: '[data-role="close"]' });

  /* The create form's refusals, each beside the field it concerns. */
  await tab.navigate(`${j.origin}/operator/new/`);
  await tab.waitForSelector('[data-role="create-form"]');
  await createThroughPage(tab, { slug: C.slug, name: 'Taken', email: `e6p-jls-${tag()}@example.invalid` });
  await tab.waitForSelector('[data-role="slug-status"] [data-code]');
  j.equal('a taken slug is refused at the slug field', await tab.evaluate(`document.querySelector('[data-role="slug-status"] [data-code]').dataset.code`), 'E_CONFLICT');
  await j.capture(tab, 'slug-taken', { anchor: '[data-role="create-form"]' });
  await createThroughPage(tab, { slug: `e6p-jls-${tag()}`, name: 'Bad address', email: 'not an address' });
  await tab.waitForSelector('[data-role="email-status"] [data-code]');
  j.equal('an address the service refuses is refused at the address field', await tab.evaluate(`document.querySelector('[data-role="email-status"] [data-code]').dataset.code`), 'E_EMAIL_INVALID');
  await j.capture(tab, 'address-invalid', { anchor: '[data-role="create-form"]' });
  await createThroughPage(tab, { slug: `e6p-jls-${tag()}`, name: 'Operator address', email: OPERATOR_EMAIL });
  await tab.waitForSelector('[data-role="email-status"] [data-code]');
  j.equal(
    'a Phaeacia account’s address is refused at the address field (E_OPERATOR_ACCOUNT)',
    await tab.evaluate(`document.querySelector('[data-role="email-status"] [data-code]').dataset.code`),
    'E_OPERATOR_ACCOUNT',
  );
}
