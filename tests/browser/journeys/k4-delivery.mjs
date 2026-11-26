/* K4-JL1 (docs/e6/design.md 1.2.1, lane K4; XR-7 of evidence/external-review-2026-09-28.md), in a real browser against
   the dev shell and its mail catcher.

   What the invitation list says about a pending row's delivery, for each word the row can hold: handed over, sent by
   mail, a refused send, a send whose answer was lost, and a row whose attempt never recorded itself (the function
   killed between the commit and the delivery, or the page closed before the answer). The last is made owner-side,
   labelled as such: a row written as api.invite_member writes it and nothing after, aged past the list's two minutes,
   beside one written now, which the list must not yet call unconfirmed. Resend on the unrecorded row replaces it, and
   the new row says what its own attempt came to. A plain member of the same company is shown no invitation and no
   delivery line. The harness takes every capture at desktop and phone width.

   The journey sets ENTERPRISE_INVITATION_DELIVERY for its own steps and puts it back, as E7-JL1 does, so it runs in a
   handover run as well as a mail one. Every identity and the company are its own. */

import { sql } from '../../e3/stack/helpers.mjs';
import { PHONE } from '../cdp.mjs';
import { signIn, tag } from './common.mjs';
import { exists, smallAdminAal2, smallCompany, text, waitForMail } from './e6-common.mjs';

const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false };
const NOTHING_CONFIRMS = 'Nothing confirms this invitation reached anyone. Resend makes a new link and stops any earlier one.';
const LINES = Object.freeze({
  handover: 'Its link was handed to whoever made it.',
  mail: 'Sent by mail.',
  failed: NOTHING_CONFIRMS,
  unconfirmed: NOTHING_CONFIRMS,
  not_recorded: NOTHING_CONFIRMS,
});

async function inMode(mode, body) {
  const before = process.env.ENTERPRISE_INVITATION_DELIVERY;
  process.env.ENTERPRISE_INVITATION_DELIVERY = mode;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env.ENTERPRISE_INVITATION_DELIVERY;
    else process.env.ENTERPRISE_INVITATION_DELIVERY = before;
  }
}

/** The pending row for an address in a company, by the database; one id or nothing. */
const pendingId = (companyId, address) =>
  sql(`select id from app.invitations where company_id = '${companyId}' and email_normalized = '${address}' and accepted_at is null and revoked_at is null`);
const storedWord = (id) => sql(`select coalesce(delivery, 'NULL') from app.invitations where id = '${id}'`);
const card = (id) => `[data-group="pending"] [data-invitation="${id}"]`;

async function inviteFrom(tab, address) {
  await tab.waitForSelector('[data-role="invite-form"]');
  await tab.type('#invite-email', address);
  await tab.click('[data-role="send-invitation"]');
  await tab.waitForSelector('[data-state="invited"]');
}

/** Checks one pending card's delivery line against the stored word and the sentence the design gives it. */
async function checkLine(j, tab, label, id, word) {
  await tab.waitForSelector(`${card(id)} [data-role="delivery"][data-delivery="${word}"]`);
  j.equal(`${label}: the line says what the design gives ${word}`, await text(tab, `${card(id)} [data-role="delivery"]`), LINES[word]);
}

/** K4-JL1: every delivery line on the members page, the unrecorded row resent, and nothing for a plain member. */
export async function k4jl1(ctx, j) {
  const catcher = ctx.shell.mail;
  if (!j.check('the shell runs a mail catcher (E7 1.1)', Boolean(catcher))) return;
  const C = await smallCompany(ctx, 'k4');
  const identity = await smallAdminAal2(j, C);
  const tab = await j.tab(identity, 'k4-delivery');
  await tab.setViewport(DESKTOP);
  await tab.navigate(`${j.origin}/members/?company=${C.companyId}`);
  const run = tag();
  const address = (what) => `k4-jl1-${what}-${run}@example.invalid`;

  /* Handover: the link came back in the answer, and the row says so. */
  await inMode('handover', () => inviteFrom(tab, address('handover')));
  const handed = pendingId(C.companyId, address('handover'));
  await checkLine(j, tab, 'handover', handed, 'handover');
  j.equal('handover: the row holds the answer’s own word', storedWord(handed), 'handover');

  /* Mail, accepted by the provider. */
  await inMode('mail', async () => {
    await inviteFrom(tab, address('mail'));
    await waitForMail(catcher, address('mail'));
  });
  const mailed = pendingId(C.companyId, address('mail'));
  await checkLine(j, tab, 'mail', mailed, 'mail');
  j.equal('mail: the row holds mail', storedWord(mailed), 'mail');

  /* Mail, refused by the provider: nothing went out. */
  catcher.instruct('status', { status: 500 });
  await inMode('mail', () => inviteFrom(tab, address('refused')));
  const refused = pendingId(C.companyId, address('refused'));
  await checkLine(j, tab, 'a refused send', refused, 'failed');
  j.equal('a refused send: nothing reached the provider', catcher.to(address('refused')).length, 0);

  /* Mail, kept by the provider with its answer lost (E7D-C-F7): the same sentence, because it is true of both. */
  catcher.instruct('drop');
  await inMode('mail', () => inviteFrom(tab, address('lost')));
  const lost = pendingId(C.companyId, address('lost'));
  await checkLine(j, tab, 'a lost answer', lost, 'unconfirmed');
  j.equal('a lost answer: the provider did keep that message', catcher.to(address('lost')).length, 1);

  /* OWNER-SIDE: a row written as api.invite_member writes it and nothing after, which is what a function killed between
     the commit and the delivery leaves. One aged past the list's two minutes, one written now. */
  const insert = (what, age) =>
    /* Through a CTE: a bare INSERT ... RETURNING prints psql's `INSERT 0 1` after the id, and the id came back with it
       (the first run of this journey, k4-77f9771). */
    sql(`with ins as (insert into app.invitations (company_id, email_normalized, token_hash, roles, expires_at, created_by, created_at)
         values ('${C.companyId}', '${address(what)}', extensions.digest(extensions.gen_random_bytes(32), 'sha256'), '{member}',
                 now() + interval '7 days', '${C.ms.admin}', now() - interval '${age}') returning id) select id from ins`);
  const killed = insert('killed', '3 minutes');
  const fresh = insert('fresh', '0 seconds');
  j.equal('owner-side: both rows took the column default', `${storedWord(killed)}|${storedWord(fresh)}`, 'not_attempted|not_attempted');
  await tab.reload();
  await checkLine(j, tab, 'a row no attempt recorded itself on', killed, 'not_recorded');
  j.check('a row written this minute says nothing yet: its attempt may still be running', !(await exists(tab, `${card(fresh)} [data-role="delivery"]`)));
  j.check('the date label is still Created, never Sent (E7M-C-F6)', (await text(tab, `${card(killed)} .meta`))?.includes('Created') === true);
  await j.capture(tab, 'members-delivery-lines', { anchor: '[data-role="invitations"]' });

  /* Resend on the unrecorded row: a new link, and the new row says what its own attempt came to. */
  await inMode('handover', async () => {
    await tab.click(`${card(killed)} [data-role="resend"]`);
    await tab.waitForSelector(`${card(killed)} [data-role="confirm-resend-now"]`);
    await tab.click(`${card(killed)} [data-role="confirm-resend-now"]`);
    await tab.waitForSelector('[data-state="resent"]');
  });
  const replaced = pendingId(C.companyId, address('killed'));
  j.check('the resend made a new row', replaced !== '' && replaced !== killed);
  await checkLine(j, tab, 'the resent row', replaced, 'handover');
  j.check(
    'the replaced row is in the revoked group, with no delivery line',
    (await exists(tab, `[data-group="revoked"] [data-invitation="${killed}"]`)) &&
      !(await exists(tab, `[data-invitation="${killed}"] [data-role="delivery"]`)),
  );

  /* The phone width, read after a reload so the list is the server's. */
  await tab.setViewport(PHONE);
  await tab.reload();
  await checkLine(j, tab, 'phone: the lost answer', lost, 'unconfirmed');
  j.check(
    'phone: no delivery line runs past the viewport',
    await tab.evaluate(`[...document.querySelectorAll('[data-role="delivery"]')].every((n) => n.getBoundingClientRect().right <= document.documentElement.clientWidth)`),
  );
  await j.capture(tab, 'members-delivery-lines-after-resend', { anchor: '[data-role="invitations"]' });
  await tab.close().catch(() => undefined);

  /* A plain member of the same company: no invitation list and so no delivery line (invitations_admin_read). */
  const member = await signIn(j, C.users.member.identity, C.users.member.email, { label: 'k4-member' });
  await member.navigate(`${j.origin}/members/?company=${C.companyId}`);
  await member.waitForSelector('[data-role="members"], [data-group]');
  j.check('a plain member sees no invitation and no delivery line', !(await exists(member, '[data-invitation]')) && !(await exists(member, '[data-role="delivery"]')));
  await member.close().catch(() => undefined);
}
