/* E6-JL3, E6-JL4, E6-JL5 and E6-JL6 (E6 design 1.2, 1.3, 1.4, 1.7 and 4.1 to 4.3): what E6 changes on the members and
   groups pages.

   E6-JL3: an administrator opens a member's Remove, reads the departure preview, transfers the member's agent to
   another member from inside it, and removes them; the removed person's catalog is the not-found state at their next
   request. The preview of a member with nothing to lose and the last administrator's preview are read too.
   E6-JL4: an orphaned agent's release is blocked in a recipient's catalog with E_AGENT_ORPHANED; the administrator
   transfers the agent from the former member's card; the same release is downloadable at the next read, with no new
   review, envelope or release. E6-JL5: an administrator invites and then resends; the earlier link is refused in a
   second browser and the new one works in a third. E6-JL6: the operator sets the seat quota on the company page, and
   the administrator's members page shows the new value and usage with the warning at 80%, and the groups page its
   own line. */

import { sql } from '../../e3/stack/helpers.mjs';
import { PHONE } from '../cdp.mjs';
import { tag } from './common.mjs';
import {
  acceptIn,
  acceptLinkFor,
  acceptLinkOnPage,
  adminAal2,
  count,
  e6world,
  exists,
  linkInAnchors,
  mailMode,
  ok,
  operatorAal2,
  ownedRelease,
  signedIn,
  text,
  waitPath,
} from './e6-common.mjs';
import { routes } from './e4-common.mjs';

const card = (id) => `[data-membership="${id}"]`;
const membersUrl = (j, W) => `${j.origin}/members/?company=${W.companyId}`;

async function adminMembers(j, W, label) {
  const identity = await adminAal2(j, W);
  const tab = await j.tab(identity, label);
  await tab.setViewport(PHONE);
  await tab.navigate(membersUrl(j, W));
  await tab.waitForSelector('[data-role="invite-form"]');
  return tab;
}

/** E6-JL3: the departure preview, the transfer from inside it, the removal, and the removed person's next request. */
export async function e6jl3(ctx, j) {
  const W = await e6world(ctx);
  const { call } = await routes(ctx);
  ok(await call('groupMembersAdd', { user: W.aal2(W.users.admin), params: { companyId: W.companyId, groupId: W.groupId, membershipId: W.ms.owner } }), 'owner in group');
  const R = await ownedRelease(ctx, W, W.users.owner);
  /* The owner is signed in before the removal, so "at their next request" is the same browser and the same session. */
  const ownerIdentity = await signedIn(j, W, 'owner');
  const ownerTab = await j.tab(ownerIdentity, 'owner-catalog');
  await ownerTab.navigate(`${j.origin}/catalog/?company=${W.companyId}`);
  await ownerTab.waitForSelector(`[data-release="${R.releaseId}"]`);
  j.check('before the removal the owner reads the catalog and their own release in it', true);

  const tab = await adminMembers(j, W, 'departure');
  /* The emptiest preview: a member with no group, no agent, no draft. */
  await tab.click(`${card(W.ms.plain)} [data-role="remove"]`);
  await tab.waitForSelector(`${card(W.ms.plain)} [data-role="departure"]`);
  j.equal(
    'a member with nothing to lose: what stops is access alone, and what stays is the four fixed sentences',
    [
      await tab.evaluate(`[...document.querySelectorAll('${card(W.ms.plain)} [data-role="what-stops"] li')].map((l) => l.dataset.kind)`),
      await tab.evaluate(`[...document.querySelectorAll('${card(W.ms.plain)} [data-role="what-stays"] li')].map((l) => l.dataset.kind)`),
    ],
    [['access'], ['membership', 'history', 'account', 'reactivation']],
  );
  await j.capture(tab, 'preview-nothing', { anchor: card(W.ms.plain) });
  await tab.click(`${card(W.ms.plain)} [data-role="cancel"]`);

  /* The last administrator: the reason, and no Remove. */
  await tab.click(`${card(W.ms.admin)} [data-role="remove"]`);
  await tab.waitForSelector(`${card(W.ms.admin)} [data-role="departure"][data-last-admin="yes"]`);
  j.check(
    'the last administrator’s preview names the reason and offers no Remove (design 4.1 item 1)',
    !(await exists(tab, `${card(W.ms.admin)} [data-role="confirm-removal"]`)) &&
      ((await text(tab, `${card(W.ms.admin)} [data-role="what-stops"]`)) ?? '').includes("This is the company's last administrator."),
  );
  await j.capture(tab, 'preview-last-admin', { anchor: card(W.ms.admin) });
  await tab.click(`${card(W.ms.admin)} [data-role="cancel"]`);

  /* The owner's preview: everything they own and everything that stops with them. */
  await tab.click(`${card(W.ms.owner)} [data-role="remove"]`);
  await tab.waitForSelector(`${card(W.ms.owner)} [data-role="owned-agents"] [data-agent="${R.agentId}"]`);
  const stops = (await text(tab, `${card(W.ms.owner)} [data-role="what-stops"]`)) ?? '';
  j.check(
    'the preview says what stops: their access, the agent they own, its current release for everybody, the audience and their group',
    stops.includes('They lose all access') &&
      stops.includes('They own 1 agent.') &&
      stops.includes('1 current release of those agents stops being downloadable') &&
      stops.includes('in the audience of those releases') &&
      stops.includes('They leave 1 audience group'),
    stops.slice(0, 400),
  );
  j.check(
    'and what stays, and it says to transfer first',
    ((await text(tab, `${card(W.ms.owner)} [data-role="what-stays"]`)) ?? '').includes('The membership stays') &&
      ((await text(tab, `${card(W.ms.owner)} [data-role="owned-agents"]`)) ?? '').includes('Transfer these first and they keep working.'),
  );
  await j.capture(tab, 'departure-preview', { anchor: card(W.ms.owner) });
  await tab.click(`${card(W.ms.owner)} [data-agent="${R.agentId}"] [data-role="transfer"]`);
  await tab.waitForSelector(`${card(W.ms.owner)} [data-agent="${R.agentId}"] [data-role="transfer-choice"]`);
  j.check(
    'the chooser offers the other active members and not the owner',
    (await exists(tab, `${card(W.ms.owner)} [data-agent="${R.agentId}"] input[value="${W.ms.heir}"]`)) &&
      !(await exists(tab, `${card(W.ms.owner)} [data-agent="${R.agentId}"] input[value="${W.ms.owner}"]`)),
  );
  await j.capture(tab, 'transfer-chooser', { anchor: `${card(W.ms.owner)} [data-agent="${R.agentId}"]` });
  await tab.evaluate(`document.querySelector('${card(W.ms.owner)} [data-agent="${R.agentId}"] input[value="${W.ms.heir}"]').click()`);
  const transfers = count('app.audit_events', `action = 'agent.transfer' and entity_id = '${R.agentId}'`);
  await tab.click(`${card(W.ms.owner)} [data-agent="${R.agentId}"] [data-role="confirm-transfer"]`);
  await tab.waitForSelector(`${card(W.ms.owner)} [data-role="departure"]:not(:has([data-role="owned-agents"]))`, { timeout: 15000 });
  j.equal(
    'the agent now belongs to the member chosen, one transfer audited, and the preview read again shows none left',
    [
      count('app.agents', `id = '${R.agentId}' and owner_membership_id = '${W.ms.heir}' and status = 'active'`),
      count('app.audit_events', `action = 'agent.transfer' and entity_id = '${R.agentId}'`) - transfers,
    ],
    [1, 1],
  );
  await j.capture(tab, 'preview-after-transfer', { anchor: card(W.ms.owner) });
  await tab.click(`${card(W.ms.owner)} [data-role="confirm-removal"]`);
  await tab.waitForSelector(`[data-role="former-members"] ${card(W.ms.owner)}`);
  j.check('the removed member moves to former members', true);
  j.equal('the agent they had was transferred first, so it is not orphaned', count('app.agents', `id = '${R.agentId}' and status = 'orphaned'`), 0);

  await ownerTab.navigate(`${j.origin}/catalog/?company=${W.companyId}`);
  await ownerTab.waitForSelector('[data-state="not-found"]');
  j.check('the removed person’s catalog is the not-found state at their next request, with the same session', !(await exists(ownerTab, '[data-release]')));
  await ownerTab.setViewport(PHONE);
  await j.capture(ownerTab, 'removed-catalog');
  ctx.state.e6jl3 = { releaseId: R.releaseId, agentId: R.agentId };
}

/** E6-JL4: an orphan blocked in the catalog, transferred by the administrator, downloadable again with no new review. */
export async function e6jl4(ctx, j) {
  const W = await e6world(ctx);
  const { call } = await routes(ctx);
  const R = await ownedRelease(ctx, W, W.users.leaver);
  ok(await call('membersRemove', { user: W.aal2(W.users.admin), params: { companyId: W.companyId, membershipId: W.ms.leaver } }), 'the owner leaves');
  j.equal('the departure orphaned the agent (setup through the route)', count('app.agents', `id = '${R.agentId}' and status = 'orphaned'`), 1);
  const before = {
    reviews: count('app.reviews', `company_id = '${W.companyId}'`),
    envelopes: count('app.review_envelopes', `company_id = '${W.companyId}'`),
    releases: count('app.releases', `company_id = '${W.companyId}'`),
  };

  const recipient = await signedIn(j, W, 'recipient');
  const cat = await j.tab(recipient, 'orphan-catalog');
  await cat.setViewport(PHONE);
  await cat.navigate(`${j.origin}/catalog/?company=${W.companyId}`);
  await cat.waitForSelector(`[data-release="${R.releaseId}"]`);
  j.check(
    'the recipient’s catalog blocks the release with E_AGENT_ORPHANED and its sentence',
    (await exists(cat, `[data-release="${R.releaseId}"][data-blocked="E_AGENT_ORPHANED"]`)) &&
      ((await text(cat, `[data-release="${R.releaseId}"] [data-state="blocked"]`)) ?? '').includes('This agent has no owner at the moment'),
  );
  await j.capture(cat, 'orphan-blocked', { anchor: `[data-release="${R.releaseId}"]` });

  const tab = await adminMembers(j, W, 'left-behind');
  await tab.click(`${card(W.ms.leaver)} [data-role="left-behind"]`);
  await tab.waitForSelector(`${card(W.ms.leaver)} [data-agent="${R.agentId}"][data-agent-status="orphaned"]`);
  j.check('the former member’s card lists the orphaned agent with Transfer', await exists(tab, `${card(W.ms.leaver)} [data-agent="${R.agentId}"] [data-role="transfer"]`));
  await j.capture(tab, 'left-behind', { anchor: card(W.ms.leaver) });
  await tab.click(`${card(W.ms.leaver)} [data-agent="${R.agentId}"] [data-role="transfer"]`);
  await tab.waitForSelector(`${card(W.ms.leaver)} input[value="${W.ms.heir}"]`);
  await tab.evaluate(`document.querySelector('${card(W.ms.leaver)} input[value="${W.ms.heir}"]').click()`);
  await tab.click(`${card(W.ms.leaver)} [data-role="confirm-transfer"]`);
  await tab.waitForSelector(`${card(W.ms.leaver)} [data-role="left-behind-box"]:not(:has([data-agent]))`, { timeout: 15000 });
  j.check('the box read again says they own nothing now, and the page says the agent works again', ((await text(tab, '[data-state="transferred"]')) ?? '').includes('works again'));
  j.equal('the agent is active under the member chosen', count('app.agents', `id = '${R.agentId}' and status = 'active' and owner_membership_id = '${W.ms.heir}'`), 1);

  await cat.reload();
  await cat.waitForSelector(`[data-release="${R.releaseId}"]`);
  j.check(
    'the same release is downloadable at the next read (E6 design 1.3: a join, not a new release)',
    await exists(cat, `[data-release="${R.releaseId}"][data-blocked="none"]`),
  );
  j.equal(
    'with no new review, envelope or release',
    {
      reviews: count('app.reviews', `company_id = '${W.companyId}'`),
      envelopes: count('app.review_envelopes', `company_id = '${W.companyId}'`),
      releases: count('app.releases', `company_id = '${W.companyId}'`),
    },
    before,
  );
  await j.capture(cat, 'orphan-downloadable', { anchor: `[data-release="${R.releaseId}"]` });
}

/** E6-JL5: resend kills the earlier link; the new one works. */
export async function e6jl5(ctx, j) {
  const W = await e6world(ctx);
  const tab = await adminMembers(j, W, 'resend');
  const address = `e6p-jl5-${tag()}@example.invalid`;
  await tab.type('#invite-email', address);
  await tab.click('[data-role="send-invitation"]');
  await tab.waitForSelector('[data-state="invited"]');
  /* E7 design 1.1 and section 4: in `mail` mode the same page says the link was emailed, the flash says "sent", and
     the link is read from the catcher instead of the page (acceptLinkFor). */
  await tab.waitForSelector(mailMode() ? '[data-role="invite"] [data-state="link-mailed"]' : '[data-role="invite"] [data-role="handover"]');
  const first = await acceptLinkFor(j, tab, '[data-role="invite"]', address);
  j.check(
    mailMode()
      ? 'the invite form shows no link at all, the mail carries it, and no a element carries one'
      : 'the invite form shows the accept link once, in its read-only field, and no a element carries it',
    typeof first === 'string' && !(await linkInAnchors(tab)) && (await acceptLinkOnPage(tab, '[data-role="invite"]')) === (mailMode() ? null : first),
  );
  j.equal(
    'the flash says what happened: sent in mail mode, created in handover',
    await text(tab, '[data-state="invited"]'),
    mailMode() ? 'Invitation sent.' : 'Invitation created.',
  );
  if (!mailMode())
    j.check(
      'the administrator is told the link is shown once and how Resend replaces it',
      ((await text(tab, '[data-role="invite"] [data-role="link-once"]')) ?? '').includes('use Resend on the invitation'),
    );
  await j.capture(tab, 'invite-handover', { anchor: '[data-role="invite"]' });
  const pending = sql(`select id from app.invitations where email_normalized = '${address}' and accepted_at is null and revoked_at is null`);
  await tab.click(`[data-invitation="${pending}"] [data-role="resend"]`);
  await tab.waitForSelector(`[data-invitation="${pending}"] [data-role="confirm-resend"]`);
  j.equal(
    'Resend first says what it does to the earlier link (design 1.2)',
    await text(tab, `[data-invitation="${pending}"] [data-role="confirm-resend"] p`),
    'This replaces the earlier link. The earlier link stops working.',
  );
  await j.capture(tab, 'confirm-resend', { anchor: `[data-invitation="${pending}"]` });
  await tab.click(`[data-invitation="${pending}"] [data-role="confirm-resend-now"]`);
  await tab.waitForSelector('[data-state="resent"]');
  const second = await acceptLinkFor(j, tab, '[data-role="invite"]', address);
  j.check('a new link is shown, and it is not the earlier one', typeof second === 'string' && second !== first);
  j.equal(
    'the earlier invitation is revoked and one pending invitation holds the address',
    [count('app.invitations', `id = '${pending}' and revoked_at is not null`), count('app.invitations', `email_normalized = '${address}' and accepted_at is null and revoked_at is null`)],
    [1, 1],
  );
  await j.capture(tab, 'resent', { anchor: '[data-role="invite"]' });

  /* The new link first, in a browser of its own: it works. Then the earlier link, in another: refused. This order was
     chosen while E6P-F1 was live (evidence/e6-pages.md, evidence/e6-pages-repro/resend-probe.log): a resend then left
     the earlier link's sign-in half live, so whichever link was verified first spent the other. E6P-F1 is fixed
     (`73b2e83`, `449cf3d`: a resend refreshes both of GoTrue's token columns, and the stack tests assert both orders;
     evidence/e6p-f1-recheck.md), and the earlier link is now refused E_AUTH_INVALID. This journey still runs the
     new-first order only and accepts either refusal code below, so it would not notice E6P-F1 returning; adding the
     old-first order and pinning E_AUTH_INVALID is the rest of E6P-F1-RC-F3, still open (docs/e8/debts.md 7.3). */
  const fresh = await acceptIn(j, 'e6-jl5-new', second, 'new-link');
  await waitPath(fresh, '/members/', { timeout: 30000 });
  await fresh.waitForSelector('[data-role="own-roles"]');
  j.equal(
    'the new link works in a second browser: one active membership for the address',
    count('app.memberships m join auth.users u on u.id = m.user_id', `m.company_id = '${W.companyId}' and lower(u.email) = '${address}' and m.status = 'active'`),
    1,
  );
  const old = await acceptIn(j, 'e6-jl5-old', first, 'old-link');
  await old.waitForSelector('[data-role="invitation"] [role="alert"][data-code]', { timeout: 20000 });
  const refusedWith = await old.evaluate(`document.querySelector('[data-role="invitation"] [role="alert"][data-code]').dataset.code`);
  j.check(
    'the earlier link is refused in a third browser, by the provider or by the invitation, and accepts nothing',
    ['E_AUTH_INVALID', 'E_INVITATION_INVALID'].includes(refusedWith),
    refusedWith,
  );
  j.record('the earlier link, used after the new one, was refused with', refusedWith);
  j.equal(
    'the address still holds exactly one membership, the one the new link made',
    count('app.memberships m join auth.users u on u.id = m.user_id', `m.company_id = '${W.companyId}' and lower(u.email) = '${address}'`),
    1,
  );
  await old.setViewport(PHONE);
  await j.capture(old, 'old-link-refused');
  await tab.reload();
  await tab.waitForSelector('[data-role="invite-form"]');
  j.check('a reload of the administrator’s page does not show the link again (design 1.2 rule 1)', (await acceptLinkOnPage(tab)) === null);
}

/** E6-JL6: the operator sets the seat quota; the administrator sees the value, the usage and the warning at 80%. */
export async function e6jl6(ctx, j) {
  const W = await e6world(ctx);
  const used = count('app.memberships', `company_id = '${W.companyId}' and status = 'active'`);
  const value = used + 1;
  const opIdentity = await operatorAal2(j, ctx);
  const op = await j.tab(opIdentity, 'quota');
  await op.setViewport(PHONE);
  await op.navigate(`${j.origin}/operator/company/?company=${W.companyId}`);
  await op.waitForSelector('[data-quota="members_per_company"] [data-role="quota-value"]');
  await op.type('[data-quota="members_per_company"] [data-role="quota-value"]', String(value));
  await op.click('[data-quota="members_per_company"] [data-role="set-quota"]');
  await op.waitFor(`document.querySelector('[data-quota="members_per_company"]')?.dataset.source === 'company'`, { timeout: 15000 });
  j.check(
    'the operator’s page shows the value set for this company with its usage',
    ((await text(op, '[data-quota="members_per_company"] [data-role="quota-usage"]')) ?? '') === `${used} of ${value}`,
  );
  await j.capture(op, 'operator-quota-set', { anchor: '[data-role="quotas"]' });

  /* A value the server refuses shows its message beside the control that caused it. */
  await op.type('[data-quota="members_per_company"] [data-role="quota-value"]', '0');
  await op.click('[data-quota="members_per_company"] [data-role="set-quota"]');
  await op.waitForSelector('[data-quota="members_per_company"] [data-code]');
  j.equal(
    'a value outside the allowed range is refused beside its control',
    await op.evaluate(`document.querySelector('[data-quota="members_per_company"] [data-code]').dataset.code`),
    'E_QUOTA_OUT_OF_RANGE',
  );

  const tab = await adminMembers(j, W, 'seat-line');
  await tab.waitForSelector('[data-role="quota-lines"] [data-quota="members_per_company"]');
  j.check(
    'the members page shows the new value and usage',
    ((await text(tab, '[data-quota="members_per_company"] [data-role="quota-usage"]')) ?? '') === `${used} of ${value}`,
  );
  j.check(
    'and the seat line appears at 80%, from the server’s own near',
    (await exists(tab, '[data-quota="members_per_company"][data-near="yes"] [data-state="quota-near"]')) &&
      ((await text(tab, '[data-quota="members_per_company"] [data-state="quota-near"]')) ?? '').startsWith('This company is close to the number of people'),
  );
  await j.capture(tab, 'seat-line-near', { anchor: '[data-role="quota-lines"]' });
  const groups = await j.tab(W.users.admin.identity, 'groups-line');
  await groups.setViewport(PHONE);
  await groups.navigate(`${j.origin}/groups/?company=${W.companyId}`);
  await groups.waitForSelector('[data-role="quota-lines"][data-quota="groups_per_company"]');
  j.check('the groups page carries its own line', /^\d+ of \d+$/.test((await text(groups, '[data-role="quota-lines"] [data-role="quota-usage"]')) ?? ''));
  await j.capture(groups, 'groups-quota-line', { anchor: '[data-role="quota-lines"]' });

  /* Put the seats back to the default's value, so the journeys after this one can still invite. */
  await op.type('[data-quota="members_per_company"] [data-role="quota-value"]', '25');
  await op.click('[data-quota="members_per_company"] [data-role="set-quota"]');
  await op.waitFor(`document.querySelector('[data-quota="members_per_company"] [data-role="quota-usage"]')?.textContent === '${used} of 25'`, { timeout: 15000 });
}
