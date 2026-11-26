/* ENA7-JL1 (evidence/ena7-end1-hbf2.md section 5, ENA7-C4; owed in section 9), in a real browser against the dev
   shell.

   ENA-7's code-only link as a person meets it. In handover mode an administrator invites an address whose account is
   already confirmed. The claim (migration 011, api.claim_invitation_handover) refuses a confirmed account, so the
   answer's link carries the invitation code and no sign-in token, no GoTrue call is made for it (ENA7-C3), and the
   members page says so: data-signs-in false, the code-only sentence, and no line of the invite section saying the link
   signs in or calling it a first factor (CR-Q114-1: the form's note is left out beside a code-only link).
   Opened signed out, in the invited person's own browser, the accept page verifies nothing and asks for a sign-in in
   another tab (accept.mjs, needs-sign-in). The person signs in with their own link, as every journey signs a person
   in, presses Check again and accepts as themselves. The control is a brand-new address, whose claim is granted and
   whose link still signs in. The harness takes every capture at desktop and phone width, and each link block and
   landing is read again at phone width for horizontal overflow.

   The journey sets ENTERPRISE_INVITATION_DELIVERY to handover for its own invitations and puts it back, as K4-JL1
   does, so it runs in a mail run as well. Every identity and the company are its own. A link is held in memory for
   the navigation that uses it; the checks read its shape (origin, path, query and fragment keys) and never a value. */

import { DESKTOP, PHONE } from '../cdp.mjs';
import { apiRequests, line, newAccount, scrubbedFirst, signIn, sleep, sql, tag, waitPath } from './common.mjs';
import { acceptLinkOnPage, exists, linkInAnchors, linkInLocation, smallAdminAal2, smallCompany, text } from './e6-common.mjs';

/* LIFECYCLE_TEXT.acceptCodeWhat and acceptLinkWhat (web/assets/app/lifecycle-view.mjs), written here a second time on
   purpose, as harness.mjs writes the fixed navigation set, so the check does not inherit a defect of the module it
   checks. A change to either sentence changes this journey with it. */
const CODE_WHAT =
  'This link does not sign anyone in. A person who already has an account signs in with their own email address first, then opens it and accepts. A person who has never signed in cannot use it yet, because another company invited this address within the last hour: issue this invitation again after that hour for a link that signs them in. It gives these roles only to the address it was made for.';
const SIGNING_WHAT =
  'This link signs its holder in and gives them these roles. It is the whole of their first factor. Hand it over the way you would hand over a password, and only to the person whose address is on it.';

const BLOCK = '[data-role="invite"] [data-role="handover"]';
const LANDING = '[data-role="invitation"]';

async function inHandover(body) {
  const before = process.env.ENTERPRISE_INVITATION_DELIVERY;
  process.env.ENTERPRISE_INVITATION_DELIVERY = 'handover';
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env.ENTERPRISE_INVITATION_DELIVERY;
    else process.env.ENTERPRISE_INVITATION_DELIVERY = before;
  }
}

const pendingId = (companyId, address) =>
  sql(`select id from app.invitations where company_id = '${companyId}' and email_normalized = '${address}' and accepted_at is null and revoked_at is null`);
/** The row's delivery word, and whether a signing link was claimed for it (011's handover_claimed_at). */
const rowState = (id) =>
  sql(`select coalesce(delivery::text, 'NULL') || '|' || case when handover_claimed_at is null then 'no claim' else 'claimed' end from app.invitations where id = '${id}'`);
/** What a GoTrue link call moves on an account, as E7-28 reads it: both sent-at stamps and its one-time tokens. */
const gotrueState = (userId) =>
  sql(`select coalesce(extract(epoch from confirmation_sent_at)::bigint, 0) || ',' ||
         coalesce(extract(epoch from recovery_sent_at)::bigint, 0) || ',' ||
         (select count(*) from auth.one_time_tokens o where o.user_id = u.id)
         from auth.users u where u.id = '${userId}'`);

/** What a link is made of, never what it holds: whether it is this origin's, its path and query, its fragment's keys in
    order, and whether its invite value has the code's shape. No value leaves this function. */
function linkShape(link, origin) {
  let u;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  const params = new URLSearchParams(u.hash.slice(1));
  return { origin: u.origin === origin, path: u.pathname, query: u.search, keys: [...params.keys()], code: /^[0-9a-f]{64}$/.test(params.get('invite') ?? '') };
}

/** Invites an address from the members page; the new pending row's id, once the page shows the answer and the row. */
async function inviteFrom(tab, companyId, address) {
  await tab.waitForSelector('[data-role="invite-form"]');
  await tab.type('#invite-email', address);
  await tab.click('[data-role="send-invitation"]');
  await tab.waitForSelector('[data-state="invited"]');
  const id = pendingId(companyId, address);
  await tab.waitForSelector(`[data-group="pending"] [data-invitation="${id}"]`);
  await tab.waitForSelector(BLOCK);
  return id;
}

/** At the harness's phone width: the document scrolls no wider than the viewport (the readings J15 and E8-5 take), and
    no element `parts` names runs past its right edge (K4-JL1's element check). The tab's viewport is put back. */
async function fitsPhone(j, tab, label, parts) {
  const viewport = tab.viewport;
  await tab.setViewport(PHONE);
  await sleep(350);
  const w = await tab.widths();
  j.equal(`${label}: the layout holds at 390 CSS pixels (innerWidth, clientWidth, scrollWidth)`, [w.innerWidth, w.clientWidth, w.scrollWidth], [390, 390, 390]);
  j.check(
    `${label}: no part of it runs past the viewport`,
    await tab.evaluate(
      `(() => { const n = [...document.querySelectorAll(${JSON.stringify(parts)})]; return n.length > 0 && n.every((e) => e.getBoundingClientRect().right <= document.documentElement.clientWidth); })()`,
    ),
  );
  await tab.setViewport(viewport);
}

/** ENA7-JL1: a confirmed account's code-only link, its landing, the acceptance after the person's own sign-in, and a
    new address's signing link as the control, at both widths. */
export async function ena7jl1(ctx, j) {
  const C = await smallCompany(ctx, 'ena7');
  const admin = await j.tab(await smallAdminAal2(j, C), 'ena7-invite');
  await admin.setViewport(DESKTOP);
  await admin.navigate(`${j.origin}/members/?company=${C.companyId}`);

  /* 1. An address whose account is confirmed, so it counts as claimed: the claim refuses it, the answer is code-only,
        and GoTrue is not called for it. */
  const account = newAccount('ena7-jl1');
  const gotrueBefore = gotrueState(account.id);
  const codeOnly = await inHandover(() => inviteFrom(admin, C.companyId, account.email));
  j.equal('code-only: the block says its link signs nobody in', await admin.evaluate(`document.querySelector(${JSON.stringify(BLOCK)})?.dataset.signsIn ?? null`), 'false');
  j.equal('code-only: it carries LIFECYCLE_TEXT.acceptCodeWhat', await text(admin, `${BLOCK} [data-role="link-what"]`), CODE_WHAT);
  /* CR-Q114-1: the whole invite section is read, not the block alone, because the note above the form
     (lifecycle-view.mjs inviteLinkNote) says a link can sign its holder in and is then as sensitive as a password.
     Before the fix it said so whatever the answer, over the code-only block, and this check would fail with
     ['signs its holder in', 'as sensitive as a password'] (a simulation of the section's text; the journey has not run
     on a pre-fix build); now the note is left out beside a code-only answer. The
     operator's link-held line is not looked for by its role: the members page never renders it, and its text would be
     caught by "first factor" if it did. */
  const inviteText = (await text(admin, '[data-role="invite"]')) ?? '';
  j.equal(
    'code-only: no line of the invite section says the link signs in, is a first factor or is like a password',
    ['signs its holder in', 'first factor', 'as sensitive as a password'].filter((claim) => inviteText.includes(claim)),
    [],
  );
  const codeLink = await acceptLinkOnPage(admin, '[data-role="invite"]');
  j.equal(
    'code-only: the link is this origin’s /accept#invite=<code>, with no token_hash and no query',
    linkShape(codeLink, j.origin),
    { origin: true, path: '/accept', query: '', keys: ['invite'], code: true },
  );
  j.equal('code-only: no a element carries it, and the address does not (design 4.3)', [await linkInAnchors(admin), await linkInLocation(admin)], [false, false]);
  j.equal('code-only: the row records handover and holds no claim', rowState(codeOnly), 'handover|no claim');
  j.equal('code-only: nothing moved at GoTrue for the confirmed account, no token and no resend timer (ENA7-C3)', gotrueState(account.id), gotrueBefore);
  await j.capture(admin, 'code-only-link', { anchor: '[data-role="invite"]' });
  await fitsPhone(j, admin, 'the code-only link', `${BLOCK}, ${BLOCK} p, ${BLOCK} input`);

  /* 2. The link opened signed out, in the invited person's own browser: nothing in it signs in, so the page verifies
        nothing and asks for a sign-in in another tab. */
  const invitee = 'ena7-jl1-invitee';
  const landing = await j.tab(invitee, 'code-only-landing');
  await j.cookies(landing, 0, 'a new profile with no cookies');
  await landing.navigate(codeLink);
  await landing.waitForSelector(`${LANDING}[data-state="needs-sign-in"] [data-role="check-again"]`);
  await sleep(1000);
  j.equal(
    'the landing: one GET /api/me 401, one refresh 401, no verification and no acceptance',
    (await apiRequests(landing, j.origin)).map(line),
    ['GET /api/me 401 E_UNAUTHENTICATED', 'POST /api/auth/refresh 401 E_AUTH_INVALID'],
  );
  const where = await landing.location();
  j.equal('the document is still /accept and location.hash is empty', [where.pathname, where.hash], ['/accept', '']);
  j.check('the fragment left the address bar before the first request', scrubbedFirst(landing));
  j.check(
    'no control here signs in or accepts: no Accept invitation, no Use this link instead, no Accept as',
    !(await exists(landing, '[data-role="accept"], [data-role="use-link"], [data-role="accept-as"]')),
  );
  j.check(
    'the page asks for a sign-in in another tab of this browser, and offers Check again',
    ((await text(landing, LANDING)) ?? '').includes('Sign in with a link from your email in another tab of this browser'),
  );
  await j.cookies(landing, 0, 'still signed out: the link signed nobody in');
  await j.capture(landing, 'code-only-needs-sign-in');
  await fitsPhone(j, landing, 'the needs-sign-in landing', `${LANDING}, ${LANDING} p, ${LANDING} button`);

  /* 3. The person signs in with a link to their own address, in another tab of the same browser, as the page asks;
        Check again finds the session, and they accept as themselves. */
  const own = await signIn(j, invitee, account.email, { label: 'invitee-own-sign-in' });
  await own.waitForSelector('[data-state="no-membership"]');
  await own.close().catch(() => undefined);
  await landing.click('[data-role="check-again"]');
  await landing.waitForSelector(`${LANDING}[data-state="signed-in-choice"] [data-role="accept-as"]`);
  j.check(
    'Check again finds the session: the page names the address, offers Accept as it, and no link to use instead',
    ((await text(landing, LANDING)) ?? '').includes(account.email) && !(await exists(landing, '[data-role="use-link"]')),
  );
  await j.capture(landing, 'code-only-signed-in');
  await fitsPhone(j, landing, 'the signed-in choice', `${LANDING}, ${LANDING} p, ${LANDING} button`);
  const at = landing.requests.length;
  await landing.click('[data-role="accept-as"]');
  await waitPath(landing, '/members/', { search: `?company=${C.companyId}`, timeout: 30000 });
  await landing.waitForSelector('[data-role="own-roles"]');
  j.equal(
    'the press accepts and verifies nothing',
    (await apiRequests(landing, j.origin, at)).filter((x) => x.method === 'POST').map(line),
    ['POST /api/invitations/accept 200'],
  );
  j.equal('no request of this tab verified a link', landing.requests.filter((r) => r.url.includes('/api/auth/verify')).length, 0);
  j.check('it lands on the members page as a member', ((await text(landing, '[data-role="own-roles"]')) ?? '').includes('Your roles: Member'));
  j.equal(
    'the database: the invitation accepted, and one active membership for that account in the company, a member only',
    sql(`select (select (accepted_at is not null)::text from app.invitations where id = '${codeOnly}') || '|' ||
           (select count(*) from app.memberships where company_id = '${C.companyId}' and user_id = '${account.id}'
              and status = 'active' and roles = '{member}')`),
    'true|1',
  );
  await j.cookies(landing, 2, 'the invitee signed in by their own link');
  await j.capture(landing, 'code-only-accepted');

  /* 4. The control: a brand-new address. The claim grants it, GoTrue creates the account, and the link signs in. */
  const fresh = `ena7-jl1-new-${tag()}@example.invalid`;
  const signing = await inHandover(() => inviteFrom(admin, C.companyId, fresh));
  j.equal('control: the block says its link signs in', await admin.evaluate(`document.querySelector(${JSON.stringify(BLOCK)})?.dataset.signsIn ?? null`), 'true');
  j.equal('control: it carries LIFECYCLE_TEXT.acceptLinkWhat', await text(admin, `${BLOCK} [data-role="link-what"]`), SIGNING_WHAT);
  j.equal(
    'control: the link is this origin’s /accept carrying token_hash, its type and the code',
    linkShape(await acceptLinkOnPage(admin, '[data-role="invite"]'), j.origin),
    { origin: true, path: '/accept', query: '', keys: ['token_hash', 'type', 'invite'], code: true },
  );
  j.equal('control: the row records handover and the claim', rowState(signing), 'handover|claimed');
  j.equal('control: the form’s note is back beside a signing link', await exists(admin, '[data-role="invite"] [data-role="invite-link-note"]'), true);
  await j.capture(admin, 'signing-link-control', { anchor: '[data-role="invite"]' });
  await fitsPhone(j, admin, 'the signing link', `${BLOCK}, ${BLOCK} p, ${BLOCK} input`);
}
