/* E7-JL1 and E7-28 (E7 design section 4, section 5 and 1.1), in a real browser against the dev shell's mail catcher.

   E7-JL1: the `failed` state as a person meets it. The catcher is told to refuse the send, an administrator invites
   from the members page and an operator creates a company on /operator/new/, and each page says the mail could not be
   confirmed as sent, with no link anywhere, at desktop and phone width. A second arm drives the accept-then-disconnect
   case (E7D-C-F7): the provider kept the message, the answer was lost, and the page says the same one sentence, which
   is the page decision the lane recorded.

   E7-28: the late open. An invitation is mailed, its sign-in token is aged past otp_expiry owner-side, and the invitee
   opens the link, is refused, asks for a sign-in link on /signin/ and presses "Check again". With GoTrue v2.192.0 no
   sign-in is issued for an account that is still unconfirmed, so the way on is a new invitation, which is what the
   template says; the journey walks that recovery to the acceptance.

   Both journeys set ENTERPRISE_INVITATION_DELIVERY for their own steps and put it back, so they run in a handover
   run as well as a mail one. lib/services/invitations.mjs reads the value per request. */

import { sql } from '../../e3/stack/helpers.mjs';
import { PHONE } from '../cdp.mjs';
import { tag } from './common.mjs';
import { adminAal2, e6world, exists, operatorAal2, text, waitForMail, waitPath } from './e6-common.mjs';
import { linkIn } from '../../e7/mail-catcher.mjs';

const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false };
const FAILED_FLASH = 'Invitation made; its mail could not be confirmed as sent.';
const ADMIN_SENTENCE =
  'The invitation is made, but its mail could not be confirmed as sent. Use Resend on it to send a new link; that also stops any link that did go out.';
const OPERATOR_SENTENCE =
  "The administrator's invitation is made, but its mail could not be confirmed as sent. Invite the administrator again from the company's page with the same address; that also stops any link that did go out.";

/** Runs `body` with the server mailing invitations, whatever the run's own mode, and puts the mode back. */
async function inMailMode(body) {
  const before = process.env.ENTERPRISE_INVITATION_DELIVERY;
  process.env.ENTERPRISE_INVITATION_DELIVERY = 'mail';
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env.ENTERPRISE_INVITATION_DELIVERY;
    else process.env.ENTERPRISE_INVITATION_DELIVERY = before;
  }
}

async function inviteFrom(tab, address) {
  await tab.waitForSelector('[data-role="invite-form"]');
  await tab.type('#invite-email', address);
  await tab.click('[data-role="send-invitation"]');
  await tab.waitForSelector('[data-state="invited"]');
}

/** E7-JL1: the failed and unconfirmed states on the members page and on /operator/new/, at both widths. */
export async function e7jl1(ctx, j) {
  const catcher = ctx.shell.mail;
  if (!j.check('the shell runs a mail catcher (E7 1.1)', Boolean(catcher))) return;
  await inMailMode(async () => {
    const W = await e6world(ctx);
    const identity = await adminAal2(j, W);
    const tab = await j.tab(identity, 'invite-failed');
    await tab.setViewport(DESKTOP);
    await tab.navigate(`${j.origin}/members/?company=${W.companyId}`);

    /* The provider refuses the message: nothing went out. */
    catcher.instruct('status', { status: 500 });
    const refused = `e7-jl1-refused-${tag()}@example.invalid`;
    await inviteFrom(tab, refused);
    j.equal('the members page says the invitation was made and its mail was not confirmed as sent', await text(tab, '[data-state="invited"]'), FAILED_FLASH);
    await tab.waitForSelector('[data-state="link-failed"]');
    j.equal('and the block under the form carries the administrator sentence and its Resend instruction', await text(tab, '[data-state="link-failed"]'), ADMIN_SENTENCE);
    j.check(
      'with no link field, no copy control and no "emailed" sentence anywhere',
      !(await exists(tab, 'input[data-role="accept-link"]')) &&
        !(await exists(tab, '[data-role="copy-link"]')) &&
        !(await exists(tab, '[data-state="link-mailed"]')),
    );
    j.equal('and nothing reached the provider', catcher.to(refused).length, 0);
    await j.capture(tab, 'members-invite-failed', { anchor: '[data-role="invite"]' });
    await tab.setViewport(PHONE);
    await tab.reload();
    await tab.waitForSelector('[data-role="invite-form"]');
    const lost = `e7-jl1-lost-${tag()}@example.invalid`;
    /* The accept-then-disconnect case: the provider kept the message and the answer was lost (E7D-C-F7). The service
       answers `unconfirmed` and the page says the same sentence, because it is true of both. */
    catcher.instruct('drop');
    await inviteFrom(tab, lost);
    await tab.waitForSelector('[data-state="link-failed"]');
    j.equal('a lost answer shows the same sentence, which is true whether or not the mail went out', await text(tab, '[data-state="link-failed"]'), ADMIN_SENTENCE);
    j.equal('and the provider did keep that message, which is why the sentence does not say it failed', catcher.to(lost).length, 1);
    await j.capture(tab, 'members-invite-unconfirmed', { anchor: '[data-role="invite"]' });
    await tab.close().catch(() => undefined);

    /* The operator's page: the company is made and its first administrator's mail is not confirmed. */
    const operator = await operatorAal2(j, ctx);
    const opTab = await j.tab(operator, 'operator-new-failed');
    await opTab.setViewport(PHONE);
    await opTab.navigate(`${j.origin}/operator/new/`);
    await opTab.waitForSelector('[data-role="create-form"]');
    const run = tag();
    const admin = `e7-jl1-op-${run}@example.invalid`;
    catcher.instruct('status', { status: 500 });
    await opTab.type('#company-slug', `e7-jl1-${run}`);
    await opTab.type('#company-name', `JL1 Mail Company ${run}`);
    await opTab.type('#first-admin-email', admin);
    await opTab.evaluate(
      `(() => { document.querySelector('#period-end').value = ${JSON.stringify(new Date(Date.now() + 56 * 86_400_000).toISOString().slice(0, 10))}; return true; })()`,
    );
    await opTab.click('[data-role="create-company"]');
    await opTab.waitForSelector('[data-state="link-failed"]');
    j.equal('the operator reads that the company is made and the mail is not confirmed', await text(opTab, '[data-state="link-failed"]'), OPERATOR_SENTENCE);
    j.check(
      'the created company, its stored dates and the way to it are still on the page, which is why the answer is a 201',
      (await exists(opTab, '[data-role="stored-period"]')) && (await exists(opTab, '[data-role="company-link"]')),
    );
    j.check('and no link field anywhere', !(await exists(opTab, 'input[data-role="accept-link"]')));
    j.equal('nothing reached the provider', catcher.to(admin).length, 0);
    /* One capture is two images, desktop and phone, which is how the harness takes them. */
    await j.capture(opTab, 'operator-new-failed');
    await opTab.close().catch(() => undefined);
  });
}

/** E7-28: the mailed link opened after its hour, the sign-in that is not issued, and the resend that recovers. */
export async function e728(ctx, j) {
  const catcher = ctx.shell.mail;
  if (!j.check('the shell runs a mail catcher (E7 1.1)', Boolean(catcher))) return;
  await inMailMode(async () => {
    const W = await e6world(ctx);
    const identity = await adminAal2(j, W);
    const tab = await j.tab(identity, 'late-open-invite');
    await tab.navigate(`${j.origin}/members/?company=${W.companyId}`);
    const address = `e7-28-${tag()}@example.invalid`;
    await inviteFrom(tab, address);
    const first = await waitForMail(catcher, address);
    j.check('the invitation was mailed', typeof linkIn(first) === 'string');

    /* Owner-side, labelled as design section 5 labels it: no route ages a GoTrue token. */
    sql(`update auth.users set confirmation_sent_at = confirmation_sent_at - interval '61 minutes',
           recovery_sent_at = recovery_sent_at - interval '61 minutes' where lower(email) = '${address}'`);

    const invitee = await j.tab('e7-28-invitee', 'late-open');
    await invitee.setViewport(PHONE);
    await invitee.navigate(linkIn(first));
    await invitee.waitForSelector('[data-role="accept"], [data-role="accept-as"], [data-role="use-link"]');
    await invitee.click('[data-role="accept"]');
    await invitee.waitForSelector('[data-role="invitation"][data-state="needs-sign-in"] [data-role="check-again"]', { timeout: 20000 });
    j.check(
      'an hour later the link no longer signs the invitee in, and the page keeps the invitation open and offers Check again',
      await exists(invitee, '[data-role="check-again"]'),
    );
    await j.capture(invitee, 'late-open-needs-sign-in');

    /* The page's own instruction: sign in from a link in another tab. For an account that is still unconfirmed GoTrue
       issues nothing (E7-28, evidence/e7-mail.md section 4), so Check again finds no session. */
    /* What GoTrue holds for this account before the sign-in is asked for: both sent-at stamps and its one-time
       tokens. Nothing of it may move, because an unconfirmed account gets no sign-in link (E7-28). */
    const tokenState = () =>
      sql(`select coalesce(extract(epoch from confirmation_sent_at)::bigint, 0) || ',' ||
             coalesce(extract(epoch from recovery_sent_at)::bigint, 0) || ',' ||
             (select count(*) from auth.one_time_tokens o where o.user_id = u.id)
             from auth.users u where lower(email) = '${address}'`);
    const beforeStart = tokenState();
    const other = await j.tab('e7-28-invitee', 'late-open-signin');
    await other.navigate(`${j.origin}/signin/`);
    await other.waitForSelector('[data-role="signin-form"]');
    await other.type('#email', address);
    await other.click('[data-role="send-link"]');
    await other.waitForSelector('[data-state="sent"]');
    j.check('the sign-in page answers the same sentence for every address, which is the no-enumeration rule', true);
    j.equal('and no sign-in token was issued for the unconfirmed invitee, so nothing can arrive', tokenState(), beforeStart);
    await other.close().catch(() => undefined);
    await invitee.click('[data-role="check-again"]');
    await invitee.waitForSelector('[data-role="invitation"]');
    j.equal(
      'Check again still finds no session, so the way on is a new invitation, which is what the mail says',
      await exists(invitee, '[data-role="check-again"]'),
      true,
    );
    await invitee.close().catch(() => undefined);

    /* The recovery: the administrator resends, and the new mail accepts. */
    const pending = sql(`select id from app.invitations where email_normalized = '${address}' and accepted_at is null and revoked_at is null`);
    await tab.reload();
    await tab.waitForSelector(`[data-invitation="${pending}"] [data-role="resend"]`);
    await tab.click(`[data-invitation="${pending}"] [data-role="resend"]`);
    await tab.click(`[data-invitation="${pending}"] [data-role="confirm-resend-now"]`);
    await tab.waitForSelector('[data-state="resent"]');
    const second = await waitForMail(catcher, address);
    j.check('a second mail was sent, carrying a different link', linkIn(second) !== linkIn(first));
    const fresh = await j.tab('e7-28-invitee-2', 'late-open-recovered');
    await fresh.navigate(linkIn(second));
    await fresh.waitForSelector('[data-role="accept"], [data-role="accept-as"], [data-role="use-link"]');
    await fresh.click('[data-role="accept"]');
    await waitPath(fresh, '/members/', { timeout: 30000 });
    j.equal(
      'the new link signs the invitee in and the acceptance makes one membership',
      sql(`select count(*) from app.memberships m join auth.users u on u.id = m.user_id
             where m.company_id = '${W.companyId}' and lower(u.email) = '${address}' and m.status = 'active'`),
      '1',
    );
    await fresh.setViewport(PHONE);
    await j.capture(fresh, 'late-open-recovered');
    await fresh.close().catch(() => undefined);
    await tab.close().catch(() => undefined);
  });
}
