/* E6-JLR (E6 design 4.1's control table, 3.5 and 4.2): every write control the E6 pages hide, hand-built from the page's
   own api.mjs in each session the design names, and refused by the service with nothing written.

   The sessions: a plain member, an administrator at aal1, the operator at aal1, a removed member, another company's
   administrator at aal2, and the operator at aal2 for the company-facing controls. The page hides each of these
   controls for these sessions; this journey sends them anyway, so the server's refusal is what is observed
   (evidence/e4-pages-review.md, E4PW-R-F4's method). Nothing may change: the company's status, quotas, invitations,
   agent ownership, memberships and audit rows are read before and after. */

import { sql } from '../../e3/stack/helpers.mjs';
import { PHONE } from '../cdp.mjs';
import { signIn, waitPath } from './common.mjs';
import { routes } from './e4-common.mjs';
import { e6world, handBuilt, ok, OPERATOR_EMAIL, operatorAal2, signedIn } from './e6-common.mjs';

const snapshot = (W, agentId) =>
  sql(`select json_build_object(
         'status', (select status from app.companies where id = '${W.companyId}'),
         'companies', (select count(*) from app.companies),
         'quotas', (select count(*) from app.company_quotas where company_id = '${W.companyId}'),
         'period', (select ends_at from app.access_periods where company_id = '${W.companyId}'),
         'invitations', (select count(*) from app.invitations where company_id = '${W.companyId}'),
         'owner', (select owner_membership_id from app.agents where id = '${agentId}'),
         'memberships', (select count(*) from app.memberships where company_id = '${W.companyId}' and status = 'active'),
         'audit', (select count(*) from app.audit_events where company_id = '${W.companyId}'))::text`);

export async function e6jlr(ctx, j) {
  const W = await e6world(ctx);
  const agentId = ctx.state.e6jl3?.agentId;
  const other = ctx.state.e6jl2;
  if (!j.check('the journeys before this one made the agent and the other company it needs', Boolean(agentId && other))) return;
  const { call } = await routes(ctx);
  const invitation = ok(
    await call('invitationsCreate', { user: W.aal2(W.users.admin), params: { companyId: W.companyId }, body: { email: `e6p-jlr-${W.run}@example.invalid`, roles: [], expiresInDays: 7 } }),
    'an invitation to resend',
  ).invitationId;
  const id = JSON.stringify(W.companyId);
  const future = new Date(Date.now() + 90 * 86_400_000).toISOString();
  const OPERATOR = {
    register: 'api.operatorCompanies()',
    manifest: `api.takeoutManifest(${id})`,
    create: `api.createCompany({ slug: 'e6p-jlr-${W.run}', name: 'Refused', firstAdminEmail: 'e6p-jlr-first-${W.run}@example.invalid', expiresInDays: 7, startsAt: '2026-09-18T00:00:00Z', endsAt: ${JSON.stringify(future)}, invoiceRef: null })`,
    status: `api.setCompanyStatus(${id}, { status: 'suspended', reasonCode: 'operator_decision' })`,
    period: `api.setAccessPeriod(${id}, { startsAt: '2026-09-18T00:00:00Z', endsAt: ${JSON.stringify(future)}, invoiceRef: null })`,
    quota: `api.setCompanyQuota(${id}, { name: 'members_per_company', value: 30 })`,
    inviteAdmin: `api.inviteAdministrator(${id}, { email: 'e6p-jlr-heir-${W.run}@example.invalid', expiresInDays: 7 })`,
    grantAdmin: `api.grantAdministrator(${id}, ${JSON.stringify(W.users.plain.id)})`,
    close: `api.closeCompany(${id}, { confirmSlug: ${JSON.stringify(W.slug)}, reasonCode: 'customer_instruction' })`,
    delete: `api.deleteCompany(${id}, { confirmSlug: ${JSON.stringify(W.slug)}, reasonCode: 'customer_instruction' })`,
    sweep: 'api.expiryRun()',
  };
  const COMPANY = {
    resend: `api.resendInvitation(${id}, ${JSON.stringify(invitation)})`,
    departure: `api.departure(${id}, ${JSON.stringify(W.ms.plain)})`,
    transfer: `api.transferAgent(${JSON.stringify(agentId)}, { toMembershipId: ${JSON.stringify(W.ms.recipient)}, expectedOwnerMembershipId: ${JSON.stringify(W.ms.heir)} })`,
    quotas: `api.quotas(${id})`,
    takeout: `api.takeout(${id})`,
  };

  /* The sessions, each in a tab where api.mjs is loaded. */
  const tabs = {};
  const plain = await signedIn(j, W, 'plain');
  tabs.member = await j.tab(plain, 'member');
  await tabs.member.navigate(`${j.origin}/members/?company=${W.companyId}`);
  const adminAal1 = await signIn(j, 'e6-admin-aal1', W.users.admin.email, { label: 'admin-aal1' });
  await waitPath(adminAal1, '/mfa/');
  tabs.adminAal1 = adminAal1;
  const opAal1 = await signIn(j, 'e6-operator-aal1', OPERATOR_EMAIL, { label: 'operator-aal1' });
  await waitPath(opAal1, '/mfa/');
  tabs.operatorAal1 = opAal1;
  tabs.removed = await j.tab(W.users.owner.identity, 'removed');
  await tabs.removed.navigate(`${j.origin}/`);
  tabs.otherAdmin = await j.tab(other.users.admin.identity, 'other-company');
  await tabs.otherAdmin.navigate(`${j.origin}/`);
  tabs.operatorAal2 = await j.tab(await operatorAal2(j, ctx), 'operator-company-routes');
  await tabs.operatorAal2.navigate(`${j.origin}/operator/`);
  for (const t of Object.values(tabs)) await t.waitFor(`document.readyState === 'complete'`);

  /* Two page states of these sessions, captured before the hand-built requests: a member who is no operator opening
     /operator/ (design 4.2's not-an-operator state: the server's message, a link home, no form), and an administrator
     at aal1 on the members page (the quota line and Export each say they need the second factor). */
  await tabs.member.setViewport(PHONE);
  await tabs.member.navigate(`${j.origin}/operator/`);
  await tabs.member.waitForSelector('[data-state="not-operator"]');
  j.check(
    'a member opening /operator/ sees the not-an-operator state: the server’s message, a link home, and no form',
    (await tabs.member.evaluate(`document.querySelector('[data-state="not-operator"] p')?.textContent`)) === 'Not an operator.' &&
      (await tabs.member.evaluate(`Boolean(document.querySelector('[data-state="not-operator"] [data-role="home-link"]'))`)) &&
      (await tabs.member.evaluate(`!document.querySelector('form, [data-role="register-table"], [data-role="run-sweep"]')`)),
  );
  await j.capture(tabs.member, 'not-operator');
  const adminPage = await j.tab('e6-admin-aal1', 'admin-aal1-members');
  await adminPage.setViewport(PHONE);
  await adminPage.navigate(`${j.origin}/members/?company=${W.companyId}`);
  await adminPage.waitForSelector('[data-role="step-up-panel"]');
  j.check(
    'an administrator at aal1 is told the seat count and Export need the second factor, and gets neither control',
    (await adminPage.evaluate(`Boolean(document.querySelector('[data-role="quota-needs-factor"]')) && Boolean(document.querySelector('[data-role="takeout-mfa"]'))`)) &&
      (await adminPage.evaluate(`!document.querySelector('button[data-role="takeout"], [data-role="quota-lines"], [data-role="resend"], [data-role="left-behind"]')`)),
  );
  await j.capture(adminPage, 'admin-aal1-members', { anchor: '[data-role="quota-needs-factor"]' });
  await tabs.member.navigate(`${j.origin}/members/?company=${W.companyId}`);
  await tabs.member.waitFor(`document.readyState === 'complete'`);

  const before = snapshot(W, agentId);
  const answers = {};
  for (const [session, tab] of Object.entries(tabs)) {
    answers[session] = {};
    const controls = session === 'operatorAal2' ? COMPANY : { ...OPERATOR, ...COMPANY };
    for (const [name, expression] of Object.entries(controls)) answers[session][name] = await handBuilt(tab, expression);
  }
  j.record('every hand-built answer, by session and control', Object.fromEntries(Object.entries(answers).map(([s, a]) => [s, Object.fromEntries(Object.entries(a).map(([k, r]) => [k, `${r.status} ${r.code}`]))])));

  const refused = (r) => (r.status === 403 || r.status === 404) && typeof r.code === 'string' && r.code !== 'E_INTERNAL';
  for (const [session, a] of Object.entries(answers))
    j.check(`${session}: every hidden control, hand-built, is refused 403 or 404 with a code`, Object.values(a).every(refused), a);
  for (const session of ['member', 'adminAal1', 'removed', 'otherAdmin'])
    j.check(
      `${session}: every operator control answers 403 E_NOT_OPERATOR`,
      Object.keys(OPERATOR).every((k) => answers[session][k].status === 403 && answers[session][k].code === 'E_NOT_OPERATOR'),
      answers[session],
    );
  j.check(
    'the operator at aal1: every operator control answers 403 E_OPERATOR_MFA_REQUIRED (design 4.1)',
    Object.keys(OPERATOR).every((k) => answers.operatorAal1[k].status === 403 && answers.operatorAal1[k].code === 'E_OPERATOR_MFA_REQUIRED'),
    answers.operatorAal1,
  );
  for (const session of ['removed', 'otherAdmin', 'operatorAal1', 'operatorAal2'])
    j.check(
      `${session}: every company control answers 404 E_NOT_FOUND, the answer a stranger gets (design 3.5, E6S-C-F4)`,
      Object.keys(COMPANY).every((k) => answers[session][k].status === 404 && answers[session][k].code === 'E_NOT_FOUND'),
      answers[session],
    );
  j.equal('an administrator at aal1 is told nothing about an invitation it cannot read: resend is 404 (E6S-F2)', answers.adminAal1.resend, { status: 404, code: 'E_NOT_FOUND' });
  j.equal('and the quota read needs aal2 (E6S-C-F5)', answers.adminAal1.quotas, { status: 403, code: 'E_ADMIN_MFA_REQUIRED' });
  j.equal('nothing changed: status, companies, quotas, dates, invitations, the agent’s owner, memberships and audit rows', snapshot(W, agentId), before);
}
