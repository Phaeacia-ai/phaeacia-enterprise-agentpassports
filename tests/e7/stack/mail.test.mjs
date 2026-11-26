/* E7 design 1.1, 3.4 and section 5: the four invitation routes in `mail` mode, through the REAL transport
   (lib/services/mail.mjs) and the real templates, against the local mail catcher (tests/e7/mail-catcher.mjs) and the
   running local stack. Cases E7-1, E7-2, E7-3 (the four paths, their kept ids, the timeout, the accept-then-disconnect
   control of E7D-C-F7, a refused connection, and the resend that recovers), E7-4's stack half, E7-5, E7-6's stack half,
   E7-7 and E7-28's stack arm. The link a case follows is always the one read from the catcher's recorded message, never
   from an answer: in mail mode no answer carries one.

   Routes are called as the Netlify adapter calls them, from one table built as the function files build theirs,
   makeRoutes({ mail: mailTransport(env) }), with an alert capture and a log capture added. The transport's environment
   is one object this file edits (a missing key, a malformed sender, a closed port), and the transport reads it at each
   call. The key is synthetic and never printed.

   Reseeds once through tests/db/00-seed.sh and builds its own users and companies. Run alone:
   node --test --test-concurrency=1 tests/e7/stack/ */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { caller } from '../../e3/stack/helpers.mjs';
import {
  callRaw,
  e4world,
  e6routes,
  freshEmail,
  futurePeriod,
  linkParts,
  operators,
  periodBody,
  reseed,
  reviewCompany,
  sql,
  submitted,
} from '../../e6/stack/helpers.mjs';
import { linkIn, startCatcher, UPSTREAM_SECRET } from '../mail-catcher.mjs';

process.env.ENTERPRISE_INVITATION_DELIVERY = 'mail';
const ids = reseed();
const catcher = await startCatcher();
after(() => catcher.close());

const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { mailTransport } = await import('../../../lib/services/mail.mjs');
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');

/* The transport's environment: one object, edited by the cases that need a broken configuration and put back. */
const mailEnv = catcher.env();
const logged = [];
const alerts = [];
const table = makeRoutes({ mail: mailTransport(mailEnv), alert: async (...a) => alerts.push(a), log: (e) => logged.push(e) });
const call = caller(table, COOKIES, makeRequest);

/* The world: company A built the E4 way (admin, author, reviewers, a member in an audience group), company B for the
   E7-2 accounts that already exist elsewhere. The E6 caller builds them; it carries no transport and is used for
   nothing that mails. */
const R = await e6routes(logged);
const W = e4world('e7-mail', ids);
const OP = operators(ids);
const A = await reviewCompany(W, R, 'a');
const B = await reviewCompany(W, R, 'b');
futurePeriod(A.id);
futurePeriod(B.id);
const A_NAME = sql(`select name from app.companies where id='${A.id}'`);

const invite = (user, companyId, body) => call('invitationsCreate', { user, params: { companyId }, body });
const resend = (user, companyId, invitationId) => call('invitationsResend', { user, params: { companyId, invitationId } });
const companyCreate = (user, body) => call('operatorCompanyCreate', { user, body });
const adminInvitation = (user, companyId, body) => call('operatorAdminInvitation', { user, params: { companyId }, body });

const ok = (r, status, label) => {
  assert.equal(r.status, status, `${label}: ${r.raw}`);
  return r.body;
};
const verify = (link) => callRaw(table, 'authVerify', { body: { tokenHash: link.tokenHash, type: link.type } });
/** Follows a mailed link as the accept page does: verify its hash, then accept its code with the session made. */
async function acceptFrom(url, label) {
  const link = linkParts(url);
  const verified = await verify(link);
  assert.equal(verified.status, 204, `${label}: the mailed link signs in: ${verified.raw}`);
  const access = /^enterprise_access=([^;]+);/.exec(verified.res.cookies[0])[1];
  return callRaw(table, 'invitationsAccept', { token: access, body: { inviteCode: link.inviteCode } });
}
const withMode = async (mode, run) => {
  process.env.ENTERPRISE_INVITATION_DELIVERY = mode;
  try {
    return await run();
  } finally {
    process.env.ENTERPRISE_INVITATION_DELIVERY = 'mail';
  }
};
const count = (from, where) => Number(sql(`select count(*) from ${from} where ${where}`));
const newCompany = (tag, over = {}) => ({
  slug: `e7m-${tag}-${W.run}`.slice(0, 60),
  name: `SYNTHETIC E7 ${tag}`,
  firstAdminEmail: freshEmail(`e7-${tag}`),
  ...periodBody(),
  ...over,
});

/* ---------------------------------------------------------------------------
   E7-1: created in mail mode, followed from the catcher
   --------------------------------------------------------------------------- */

test('E7-1: an invitation made in mail mode answers no link; the catcher holds one member message; its link accepts', async () => {
  const email = freshEmail('e7-1');
  const before = catcher.messages.length;
  const body = ok(await invite(A.adminHi, A.id, { email, roles: ['member'] }), 201, 'create');
  assert.deepEqual(Object.keys(body).sort(), ['delivery', 'expiresAt', 'invitationId', 'ok'], 'no acceptUrl key at all');
  assert.equal(body.delivery, 'mail');
  assert.equal(catcher.messages.length, before + 1, 'one message');
  const message = catcher.newestTo(email);
  assert.equal(message.subject, `Your invitation to ${A_NAME} on Phaeacia`);
  assert.ok(message.text.startsWith(`You have been invited to ${A_NAME}'s workspace on Phaeacia.\n`), 'kind member');
  assert.equal(message.from, mailEnv.ENTERPRISE_MAIL_FROM);
  const accepted = await acceptFrom(linkIn(message), 'E7-1');
  assert.equal(accepted.status, 200, accepted.raw);
  assert.equal(accepted.body.companyId, A.id);
  assert.equal(
    count('app.memberships m join auth.users u on u.id = m.user_id', `m.company_id='${A.id}' and lower(u.email)='${email}' and m.status='active'`),
    1,
    'the acceptance made one membership',
  );

  /* Control: the same call in handover mode answers the link and the catcher receives nothing. */
  const other = freshEmail('e7-1-handover');
  const handed = await withMode('handover', () => invite(A.adminHi, A.id, { email: other, roles: ['member'] }));
  assert.equal(handed.body.delivery, 'handover');
  assert.match(handed.body.acceptUrl, /^https:\/\/enterprise\.example\.invalid\/accept#/);
  assert.equal(catcher.to(other).length, 0, 'handover sends nothing');
});

/* ---------------------------------------------------------------------------
   E7-2: a resend in mail mode kills the earlier link's sign-in (E6P-F1-C-F1 through the mail path)
   --------------------------------------------------------------------------- */

test('E7-2: after a mailed resend the earlier mailed link signs nobody in and its code is refused; for a new, an unconfirmed and a confirmed address', async () => {
  const unconfirmed = freshEmail('e7-2-unconfirmed');
  ok(await invite(B.adminHi, B.id, { email: unconfirmed, roles: ['member'] }), 201, 'an account made elsewhere, never used');
  const confirmed = freshEmail('e7-2-confirmed');
  ok(await invite(B.adminHi, B.id, { email: confirmed, roles: ['member'] }), 201, 'elsewhere');
  assert.equal((await verify(linkParts(linkIn(catcher.newestTo(confirmed))))).status, 204, 'the first use confirms the account');
  for (const [label, email] of [
    ['new', freshEmail('e7-2-new')],
    ['unconfirmed', unconfirmed],
    ['confirmed', confirmed],
  ]) {
    const first = ok(await invite(A.adminHi, A.id, { email, roles: ['member'] }), 201, `${label}: create`);
    const link1 = linkParts(linkIn(catcher.newestTo(email)));
    const again = ok(await resend(A.adminHi, A.id, first.invitationId), 201, `${label}: resend`);
    assert.equal(again.delivery, 'mail');
    assert.equal(again.replacesInvitationId, first.invitationId);
    const link2 = linkParts(linkIn(catcher.newestTo(email)));
    assert.notEqual(link2.inviteCode, link1.inviteCode, `${label}: a new link was mailed`);
    /* The earlier link first, so a pass cannot come from the new link spending it. */
    assert.equal((await verify(link1)).status, 401, `${label}: the earlier mailed link no longer signs in`);
    const verified = await verify(link2);
    assert.equal(verified.status, 204, `${label}: the new one does`);
    const access = /^enterprise_access=([^;]+);/.exec(verified.res.cookies[0])[1];
    const stale = await callRaw(table, 'invitationsAccept', { token: access, body: { inviteCode: link1.inviteCode } });
    assert.deepEqual([stale.status, stale.body.code], [404, 'E_INVITATION_INVALID'], `${label}: the earlier code is refused`);
    const fresh = await callRaw(table, 'invitationsAccept', { token: access, body: { inviteCode: link2.inviteCode } });
    assert.equal(fresh.status, 200, `${label}: ${fresh.raw}`);
    assert.equal(
      count('app.memberships m join auth.users u on u.id = m.user_id', `m.company_id='${A.id}' and lower(u.email)='${email}'`),
      1,
      `${label}: one membership`,
    );
  }
});

/* ---------------------------------------------------------------------------
   E7-3: a failure after the row is written, on the four paths, and the recovery
   --------------------------------------------------------------------------- */

const pendingRow = (invitationId) =>
  sql(`select (accepted_at is null)::text || ',' || (revoked_at is null)::text from app.invitations where id='${invitationId}'`);

test('E7-3: the provider refusing (500) answers 201 failed on each of the four paths, keeps each path s ids, and raises one alert', async () => {
  /* The operator's succession path needs a company with no live operator invitation; the create-company case makes one. */
  const cases = [
    ['create', async () => invite(A.adminHi, A.id, { email: freshEmail('e7-3-create'), roles: ['member'] }), A.id],
    [
      'resend',
      async () => {
        const email = freshEmail('e7-3-resend');
        const first = ok(await invite(A.adminHi, A.id, { email, roles: ['member'] }), 201, 'resend: the row to resend');
        catcher.instruct('status', { status: 500 });
        return resend(A.adminHi, A.id, first.invitationId);
      },
      A.id,
    ],
    ['operator create-company', async () => companyCreate(OP.aal2, newCompany('e7-3-cc')), null],
    ['operator succession', async () => adminInvitation(OP.aal2, B.id, { email: freshEmail('e7-3-succ') }), B.id],
  ];
  for (const [label, run, companyId] of cases) {
    if (label !== 'resend') catcher.instruct('status', { status: 500 });
    alerts.length = 0;
    const r = await run();
    assert.equal(r.status, 201, `${label}: ${r.raw}`);
    assert.equal(r.body.delivery, 'failed', label);
    assert.equal(Object.hasOwn(r.body, 'acceptUrl'), false, `${label}: no link`);
    assert.equal(pendingRow(r.body.invitationId), 'true,true', `${label}: the invitation it names exists and is pending`);
    const expected = {
      create: ['delivery', 'expiresAt', 'invitationId', 'ok'],
      resend: ['delivery', 'expiresAt', 'invitationId', 'ok', 'replacesInvitationId'],
      'operator create-company': ['accessPeriod', 'companyId', 'delivery', 'expiresAt', 'invitationId', 'ok'],
      'operator succession': ['delivery', 'expiresAt', 'invitationId', 'ok'],
    }[label];
    assert.deepEqual(Object.keys(r.body).sort(), expected, `${label}: every id the path answers is kept`);
    if (label === 'resend')
      assert.equal(pendingRow(r.body.replacesInvitationId), 'true,false', 'resend: the replaced row is revoked');
    if (label === 'operator create-company') {
      assert.equal(count('app.companies', `id='${r.body.companyId}'`), 1, 'the company exists');
      assert.equal(count('app.access_periods', `company_id='${r.body.companyId}'`), 1, 'with its period');
    }
    assert.equal(alerts.length, 1, `${label}: one alert`);
    assert.equal(alerts[0][0], 'delivery_failed');
    assert.deepEqual(alerts[0][1], { errorName: 'MailError', companyId: companyId ?? r.body.companyId }, `${label}: allowlisted fields`);
  }
});

test('E7-3 and E7D-C-F7: a timeout and an accepted-then-disconnected send answer unconfirmed; a refused connection failed', async () => {
  /* The timeout: the catcher reads the request and never answers; the transport gives up at 5 s. */
  catcher.instruct('hang');
  alerts.length = 0;
  const hangEmail = freshEmail('e7-3-hang');
  const t0 = Date.now();
  const hung = ok(await invite(A.adminHi, A.id, { email: hangEmail, roles: ['member'] }), 201, 'hang');
  const waited = Date.now() - t0;
  assert.equal(hung.delivery, 'unconfirmed', 'a request that left and got no answer is not "failed"');
  assert.ok(waited >= 4900 && waited < 9000, `the 5 s bound held (${waited} ms)`);
  assert.deepEqual(alerts[0][1], { errorName: 'MailError', code: 'ETIMEDOUT', companyId: A.id });

  /* Accept-then-disconnect: the provider recorded the message, and the answer was lost. */
  catcher.instruct('drop');
  alerts.length = 0;
  const dropEmail = freshEmail('e7-3-drop');
  const dropped = ok(await invite(A.adminHi, A.id, { email: dropEmail, roles: ['member'] }), 201, 'drop');
  assert.equal(dropped.delivery, 'unconfirmed');
  assert.equal(catcher.to(dropEmail).length, 1, 'the provider holds the message: the invitee may hold the link');
  assert.equal(alerts.length, 1);
  assert.equal(pendingRow(dropped.invitationId), 'true,true', 'the committed id is kept and pending');

  /* The recovery is the Resend, and it kills the link that did go out. */
  const recovered = ok(await resend(A.adminHi, A.id, dropped.invitationId), 201, 'resend after the lost answer');
  assert.equal(recovered.delivery, 'mail');
  const lostLink = linkParts(linkIn(catcher.to(dropEmail)[0]));
  assert.equal((await verify(lostLink)).status, 401, 'the link the lost answer may have delivered is dead after the resend');
  const accepted = await acceptFrom(linkIn(catcher.newestTo(dropEmail)), 'recovered');
  assert.equal(accepted.status, 200, accepted.raw);
  assert.equal(pendingRow(dropped.invitationId), 'true,false', 'the unconfirmed row is revoked');
  assert.equal(
    sql(`select details->>'replaced_by_invitation_id' from app.audit_events
           where action='invitation.revoke' and entity_id='${dropped.invitationId}'`),
    recovered.invitationId,
    'by the resend, which its revocation row names',
  );
  /* No second write path: exactly the two invitations for the address and their audit rows, a create for each and
     the replacement's revocation of the first, which is what a handover resend writes too. */
  assert.equal(count('app.invitations', `email_normalized='${dropEmail}'`), 2);
  assert.equal(
    sql(`select string_agg(action, ',' order by id) from app.audit_events
           where entity_id in ('${dropped.invitationId}','${recovered.invitationId}')`),
    'invitation.create,invitation.revoke,invitation.create',
  );

  /* A refused connection: the request never left, so nothing went out and the answer is failed. */
  const closed = await startCatcher();
  const closedEndpoint = closed.endpoint;
  await closed.close();
  const saved = mailEnv.ENTERPRISE_MAIL_ENDPOINT;
  mailEnv.ENTERPRISE_MAIL_ENDPOINT = closedEndpoint;
  alerts.length = 0;
  try {
    const refused = ok(await invite(A.adminHi, A.id, { email: freshEmail('e7-3-refused'), roles: ['member'] }), 201, 'refused');
    assert.equal(refused.delivery, 'failed');
    assert.deepEqual(alerts[0][1], { errorName: 'MailError', code: 'ECONNREFUSED', companyId: A.id });
  } finally {
    mailEnv.ENTERPRISE_MAIL_ENDPOINT = saved;
  }
});

test('E7-3, the operator s recovery: a failed first-administrator mail is recovered by inviting the same address again', async () => {
  const body = newCompany('e7-3-op');
  catcher.instruct('status', { status: 500 });
  const failed = ok(await companyCreate(OP.aal2, body), 201, 'create-company');
  assert.equal(failed.delivery, 'failed');
  assert.equal(catcher.to(body.firstAdminEmail).length, 0, 'nothing reached the provider');
  const again = ok(await adminInvitation(OP.aal2, failed.companyId, { email: body.firstAdminEmail }), 201, 're-invite');
  assert.equal(again.delivery, 'mail');
  assert.equal(pendingRow(failed.invitationId), 'true,false', 'the failed invitation is revoked by the re-invitation');
  const accepted = await acceptFrom(linkIn(catcher.newestTo(body.firstAdminEmail)), 'operator recovery');
  assert.equal(accepted.status, 200, accepted.raw);
  assert.deepEqual([...accepted.body.roles].sort(), ['company_admin', 'member']);
});

/* ---------------------------------------------------------------------------
   E7-4, stack half: the tripwire over a company that holds content
   --------------------------------------------------------------------------- */

test('E7-4: a mail from a company holding agents, groups, candidates and named members carries none of it', async () => {
  const { agentId } = await submitted(R, A);
  ok(await R.call('meDisplayName', { user: A.admin, body: { displayName: `SYNTHETIC Inviter ${W.run}` } }), 204, 'the inviter s name');
  ok(await R.call('meDisplayName', { user: A.member, body: { displayName: `SYNTHETIC Colleague ${W.run}` } }), 204, 'a colleague s name');
  const email = freshEmail('e7-4');
  ok(await invite(A.adminHi, A.id, { email, roles: ['member', 'it_reviewer'] }), 201, 'invite');
  const message = catcher.newestTo(email);
  const whole = `${message.subject}\n${message.text}`;
  const strings = sql(
    `select string_agg(s, E'\\n') from (
       select name as s from app.agents where company_id='${A.id}'
       union all select name from app.groups where company_id='${A.id}'
       union all select p.display_name from app.profiles p join app.memberships m on m.user_id = p.user_id where m.company_id='${A.id}'
       union all select lower(u.email) from auth.users u join app.memberships m on m.user_id = u.id where m.company_id='${A.id}'
       union all select c.id::text from app.candidate_versions c where c.company_id='${A.id}'
       union all select '${agentId}'
     ) x`,
  ).split('\n');
  assert.ok(strings.length >= 8, `the company holds content to search for (${strings.length} strings)`);
  for (const s of strings) assert.ok(!whole.includes(s), `the mail carries a string of the company's content (${s.length} characters)`);
  assert.ok(!whole.includes('It runs when you paste records'), 'no passport sentence');
  assert.ok(!whole.includes('@'), 'no address at all in the subject or the text');

  /* A display name with a line break, a tab and 120 characters, typed by the operator at provisioning. */
  const long = `Line\nBreak\tTab ${'n'.repeat(120)}`;
  const body = newCompany('e7-4-name', { name: long });
  ok(await companyCreate(OP.aal2, body), 201, 'a company with that name');
  const named = catcher.newestTo(body.firstAdminEmail);
  assert.ok(!/[\r\n\t]/.test(named.subject), 'the subject is one line');
  const name = named.subject.slice('Your invitation to '.length, -' on Phaeacia'.length);
  assert.ok(name.startsWith('Line Break Tab n') && Array.from(name).length <= 80, 'sanitised and at most 80 characters');
});

/* ---------------------------------------------------------------------------
   E7-5: the operator's company in mail mode
   --------------------------------------------------------------------------- */

test('E7-5: an operator s company in mail mode: no link in the answer, a first_admin mail, a re-invitation that kills the first link', async () => {
  const body = newCompany('e7-5');
  const created = ok(await companyCreate(OP.aal2, body), 201, 'create');
  assert.deepEqual(Object.keys(created).sort(), ['accessPeriod', 'companyId', 'delivery', 'expiresAt', 'invitationId', 'ok']);
  assert.equal(created.delivery, 'mail');
  const first = catcher.newestTo(body.firstAdminEmail);
  assert.equal(first.subject, `Your invitation to ${body.name} on Phaeacia`);
  assert.ok(first.text.startsWith(`You have been invited to set up ${body.name}'s workspace on Phaeacia as its first administrator.`));
  assert.ok(first.text.includes('you will set up a second factor (an authenticator app) before you can administer the company'));
  const again = ok(await adminInvitation(OP.aal2, created.companyId, { email: body.firstAdminEmail }), 201, 're-invite');
  assert.equal(again.delivery, 'mail');
  const second = catcher.newestTo(body.firstAdminEmail);
  assert.ok(second.text.includes('The workspace already exists'), 'the re-invitation is the succession message');
  assert.equal((await verify(linkParts(linkIn(first)))).status, 401, 'the first link is dead');
  const accepted = await acceptFrom(linkIn(second), 'E7-5');
  assert.equal(accepted.status, 200, accepted.raw);
  assert.deepEqual([...accepted.body.roles].sort(), ['company_admin', 'member']);

  /* Control: in handover mode the same route answers the link. */
  const handed = await withMode('handover', () => companyCreate(OP.aal2, newCompany('e7-5-handover')));
  assert.equal(handed.body.delivery, 'handover');
  assert.equal(typeof handed.body.acceptUrl, 'string');
});

/* ---------------------------------------------------------------------------
   E7-6, stack half: a transport that is not ready refuses before any write, on the four paths
   --------------------------------------------------------------------------- */

test('E7-6: with no key, then a malformed sender, each of the four routes answers 503 and writes nothing at all', async () => {
  const pendingEmail = freshEmail('e7-6-pending');
  const pending = ok(await invite(A.adminHi, A.id, { email: pendingEmail, roles: ['member'] }), 201, 'a row to resend');
  for (const [config, edit] of [
    ['no key', (env) => delete env.ENTERPRISE_MAIL_API_KEY],
    ['a malformed sender', (env) => (env.ENTERPRISE_MAIL_FROM = 'Phaeacia <no-reply@>')],
  ]) {
    const saved = { ...mailEnv };
    edit(mailEnv);
    try {
      const emails = { create: freshEmail('e7-6-create'), cc: freshEmail('e7-6-cc'), succ: freshEmail('e7-6-succ') };
      const slug = `e7m-e7-6-${Math.random().toString(16).slice(2, 8)}`;
      const auditBefore = count('app.audit_events', 'true');
      const invitationsBefore = count('app.invitations', 'true');
      const requestsBefore = catcher.requests.length;
      for (const [label, run] of [
        ['create', () => invite(A.adminHi, A.id, { email: emails.create, roles: ['member'] })],
        ['resend', () => resend(A.adminHi, A.id, pending.invitationId)],
        ['operator create-company', () => companyCreate(OP.aal2, { ...newCompany('e7-6'), slug, firstAdminEmail: emails.cc })],
        ['operator succession', () => adminInvitation(OP.aal2, A.id, { email: emails.succ })],
      ]) {
        const r = await run();
        assert.deepEqual([r.status, r.body?.code], [503, 'E_MAIL_NOT_CONFIGURED'], `${label}, ${config}: ${r.raw}`);
      }
      assert.equal(count('app.audit_events', 'true'), auditBefore, `${config}: no audit row`);
      assert.equal(count('app.invitations', 'true'), invitationsBefore, `${config}: no invitation`);
      assert.equal(count('app.companies', `slug='${slug}'`), 0, `${config}: no company`);
      for (const e of Object.values(emails)) assert.equal(count('auth.users', `lower(email)='${e}'`), 0, `${config}: no account`);
      assert.equal(pendingRow(pending.invitationId), 'true,true', `${config}: the row a resend would replace is untouched`);
      assert.equal(catcher.requests.length, requestsBefore, `${config}: nothing was sent`);
    } finally {
      for (const k of Object.keys(mailEnv)) delete mailEnv[k];
      Object.assign(mailEnv, saved);
    }
  }
});

/* ---------------------------------------------------------------------------
   E7-7: an upstream error body never surfaces
   --------------------------------------------------------------------------- */

test('E7-7: a 422 quoting the message, the recipient and a secret leaves none of it in the answer, the log or the alert', async () => {
  const email = freshEmail('e7-7');
  catcher.instruct('status', { status: 422 });
  logged.length = 0;
  alerts.length = 0;
  const r = ok(await invite(A.adminHi, A.id, { email, roles: ['member'] }), 201, 'invite');
  assert.equal(r.delivery, 'failed');
  const surfaces = JSON.stringify({ answer: r, logged, alerts: alerts.map((a) => a.slice(0, 2)) });
  for (const piece of ['synthetic upstream refusal', UPSTREAM_SECRET, email, 'Your invitation to'])
    assert.ok(!surfaces.includes(piece), 'an upstream piece reached the answer, a log line or the alert');
  /* Control: the catcher did answer with the quote; a 200 has nothing to discard. */
  assert.equal(catcher.requests.at(-1).status, 422);
});

/* ---------------------------------------------------------------------------
   E7-28, stack arm: the late open, and which of design 1.1's two outcomes GoTrue gives
   --------------------------------------------------------------------------- */

test('E7-28: after the hour the mailed link is refused, and GoTrue issues no sign-in to the unconfirmed invitee; a resend recovers', async () => {
  const email = freshEmail('e7-28');
  const first = ok(await invite(A.adminHi, A.id, { email, roles: ['member'] }), 201, 'invite');
  const link = linkParts(linkIn(catcher.newestTo(email)));
  /* Owner-side, labelled: no route ages a GoTrue token. Both sent-at columns an hour and a minute back. */
  sql(`update auth.users set confirmation_sent_at = confirmation_sent_at - interval '61 minutes',
         recovery_sent_at = recovery_sent_at - interval '61 minutes' where lower(email) = '${email}'`);
  assert.equal((await verify(link)).status, 401, 'the aged link no longer signs in (otp_expiry, one hour)');
  const tokens = () =>
    sql(`select coalesce(extract(epoch from confirmation_sent_at)::bigint, 0) || ',' || coalesce(extract(epoch from recovery_sent_at)::bigint, 0)
           || ',' || (select count(*) from auth.one_time_tokens o where o.user_id = u.id) from auth.users u where lower(email) = '${email}'`);
  const beforeStart = tokens();
  const started = await callRaw(table, 'authStart', { body: { email } });
  assert.equal(started.status, 204, 'the sign-in start answers the same for every address');
  /* Outcome (b) of design 1.1, observed on GoTrue v2.192.0: the start is refused for an unconfirmed account (422
     signup_disabled, not surfaced) and nothing is issued, so the page's "Check again" path cannot complete for a
     first-time invitee and the template says so. If this fails, GoTrue now admits it and the wording must be re-read. */
  assert.equal(tokens(), beforeStart, 'no sign-in token was issued to the unconfirmed account');
  assert.equal(count('auth.users', `lower(email)='${email}' and email_confirmed_at is null`), 1, 'still unconfirmed');
  /* The way on is a new link. */
  ok(await resend(A.adminHi, A.id, first.invitationId), 201, 'resend');
  const accepted = await acceptFrom(linkIn(catcher.newestTo(email)), 'E7-28 recovery');
  assert.equal(accepted.status, 200, accepted.raw);
});
