/* The E6 services without a stack (design 1.2, 1.4, 1.5, 1.6, 1.7, 3.4 and 3.5, the S rows of each table):
   what each service sends, what it answers, which refusals it makes before any call at all, and the two
   tripwires design 1.1 and 1.2 ask for by name. tests/e3/unit/fake-postgrest.mjs is the PostgREST double and the
   verified session; tests/e6/stack is where the routines answer.

   Two of the tests here are tripwires and are labelled as such, because neither can prove what it is about: the
   no-content-to-operator one reads what this lane's operator service RETURNS, which is the last place a tenant
   name could reach a Phaeacia person through a route, and the database half is probe 29c's; the accept-link one
   reads the source of every E6 module for a second place that touches the URL. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../../lib/errors.mjs';
import { COMPANY, MEMBERSHIP, SUB, fakeDb, refusal, session } from '../../e3/unit/fake-postgrest.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.ENTERPRISE_ORIGIN = 'https://enterprise.example.invalid';
/* The double answers GoTrue, so the key is never used; lib/db/operator.mjs reads it before it builds a request
   and a value has to be there for the path guard to run at all. Nothing here prints it. */
process.env.SUPABASE_SERVICE_ROLE_KEY = 'example-service-role-key-never-logged';

const invitations = await import('../../../lib/services/invitations.mjs');

const INVITATION = 'aaaaaaaa-1111-4222-8333-444444444444';
const OTHER_INVITATION = 'aaaaaaaa-1111-4222-8333-444444444445';
const OTHER_COMPANY = 'bbbbbbbb-1111-4222-8333-444444444444';
const CODE = 'c'.repeat(64);
const NEW_CODE = 'd'.repeat(64);
const HASHED = 'e'.repeat(48);
const EXPIRES = '2026-10-08T09:00:00.000Z';

/* The mode is process-wide, so every test that changes it puts it back; a leaked `mail` would make a later test
   refuse E_MAIL_NOT_CONFIGURED for a reason that is not its own. */
async function withMode(mode, run) {
  const before = process.env.ENTERPRISE_INVITATION_DELIVERY;
  if (mode === undefined) delete process.env.ENTERPRISE_INVITATION_DELIVERY;
  else process.env.ENTERPRISE_INVITATION_DELIVERY = mode;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.ENTERPRISE_INVITATION_DELIVERY;
    else process.env.ENTERPRISE_INVITATION_DELIVERY = before;
  }
}

/* The double answers GoTrue's admin generate_link as well as PostgREST, because handover delivery still creates
   the invitee's account: the mode decides who receives the link, not whether the account is made. Each issuance
   refreshes both token columns (signup then magiclink, E6P-F1-C-F1), so it makes two generate_link calls; the
   handed link is the magiclink one, and the fake answers each with the type it was asked for. */
function inviteDb({
  rows = [],
  invite = NEW_CODE,
  tables = {},
  claim = true,
  signupStatus = 200,
  magiclinkConfirmedAt = null,
} = {}) {
  const db = fakeDb({
    claim,
    tables: {
      memberships: [{ id: MEMBERSHIP, roles: ['company_admin', 'member'], status: 'active' }],
      invitations: rows,
      ...tables,
    },
    rpc: (name) =>
      name === 'invite_member' ? [{ invitation_id: INVITATION, invite_code: invite, expires_at: EXPIRES }] : [{}],
  });
  const inner = db.fetchImpl;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/auth/v1/admin/generate_link')) {
      const body = JSON.parse(init.body);
      db.calls.push({ gotrue: 'generate_link', body });
      if (body.type === 'signup' && signupStatus !== 200)
        return { status: signupStatus, json: async () => ({ code: signupStatus, msg: 'synthetic gotrue text' }) };
      const confirmed = body.type === 'magiclink' && magiclinkConfirmedAt !== null;
      return {
        status: 200,
        json: async () => ({
          hashed_token: HASHED,
          verification_type: body.type,
          ...(confirmed ? { email_confirmed_at: magiclinkConfirmedAt } : {}),
        }),
      };
    }
    return inner(url, init);
  };
  return { calls: db.calls, options: { fetchImpl } };
}

const pending = (over = {}) => ({
  id: INVITATION,
  company_id: COMPANY,
  email_normalized: 'new.person@example.invalid',
  roles: ['it_reviewer', 'member'],
  accepted_at: null,
  ...over,
});

/* ---------------------------------------------------------------------------
   design 1.2: handover delivery
   --------------------------------------------------------------------------- */

test('design 1.2: handover is the default, and the answer carries the link once with the mode that produced it', async () => {
  for (const mode of [undefined, '', 'handover']) {
    const db = inviteDb();
    const r = await withMode(mode, () =>
      invitations.createInvitation(
        session,
        { companyId: COMPANY, email: 'New.Person@Example.invalid', roles: ['member'] },
        {},
        db.options,
      ),
    );
    assert.deepEqual(r, {
      invitationId: INVITATION,
      expiresAt: EXPIRES,
      delivery: 'handover',
      acceptUrl: `https://enterprise.example.invalid/accept#token_hash=${HASHED}&type=magiclink&invite=${NEW_CODE}`,
      signsIn: true,
    });
    const gl = db.calls.filter((c) => c.gotrue === 'generate_link');
    assert.deepEqual(
      gl.map((c) => c.body.type),
      ['signup', 'magiclink'],
      'the account is still created and both token columns refreshed: the mode decides the last hop only',
    );
    assert.equal(gl[0].body.email, 'new.person@example.invalid', 'normalized');
  }
});

/* ENA-7 (security review of 2026-09-30; evidence/ena7-end1-hbf2.md section 5, D1 and D2). FAIL-BEFORE on main's
   invitations.mjs: no claim was asked, both GoTrue calls ran for every address, and the answer carried the token. */
test('ENA-7: a refused claim makes no GoTrue call at all and answers a code-only link', async () => {
  for (const [label, run] of [
    ['create', (db) => invitations.createInvitation(session, { companyId: COMPANY, email: 'used@example.invalid', roles: ['member'] }, {}, db.options)],
    ['resend', (db) => invitations.resendInvitation(session, { companyId: COMPANY, invitationId: INVITATION }, {}, db.options)],
  ]) {
    const db = inviteDb({ rows: [pending()], claim: false });
    const r = await withMode('handover', () => run(db));
    assert.equal(r.delivery, 'handover', label);
    assert.equal(r.signsIn, false, label);
    assert.equal(r.acceptUrl, `https://enterprise.example.invalid/accept#invite=${NEW_CODE}`, `${label}: the code only`);
    assert.deepEqual(db.calls.filter((c) => c.gotrue), [], `${label}: GoTrue never called, so no token exists to leak`);
    const claim = db.calls.find((c) => c.rpc === 'claim_invitation_handover');
    assert.deepEqual(claim.body, { p_invitation: INVITATION }, `${label}: the claim names the new invitation only`);
  }
});

test('ENA-7: a granted claim on an account GoTrue reports confirmed still answers no token, after one call', async () => {
  const db = inviteDb({ signupStatus: 422 });
  const r = await withMode('handover', () =>
    invitations.createInvitation(session, { companyId: COMPANY, email: 'used@example.invalid', roles: ['member'] }, {}, db.options),
  );
  assert.equal(r.signsIn, false);
  assert.equal(r.acceptUrl.includes('token_hash'), false);
  assert.deepEqual(db.calls.filter((c) => c.gotrue).map((c) => c.body.type), ['signup'], 'no magiclink is minted');
});

/* CR-ENA7-2: a claim call that fails is not a refusal. Read as one, an outage or an app deployed before 011 answered a
   code-only link with no account behind it for a new address, recorded as handed over, with no alert. FAIL-BEFORE at
   717815d: delivery 'handover', signsIn false, no alert. */
test('ENA-7: a claim call that fails answers failed with the ids and the alert, and makes no GoTrue call', async () => {
  const failures = [
    ['the routine unknown to PostgREST (an app ahead of 011)', () => ({ status: 404, json: async () => ({ code: 'PGRST202', message: 'x' }) })],
    ['a 503', () => ({ status: 503, json: async () => ({ message: 'x' }) })],
    [
      'a lost connection',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ];
  const paths = [
    ['create', (db, deps) => invitations.createInvitation(session, { companyId: COMPANY, email: 'x@example.invalid', roles: ['member'] }, deps, db.options)],
    ['resend', (db, deps) => invitations.resendInvitation(session, { companyId: COMPANY, invitationId: INVITATION }, deps, db.options)],
  ];
  for (const [how, fail, path, run] of failures.flatMap(([h, f]) => paths.map(([p, r]) => [h, f, p, r]))) {
    const label = `${path}, ${how}`;
    const alerts = [];
    const db = inviteDb({ rows: [pending()] });
    const through = db.options.fetchImpl;
    db.options.fetchImpl = async (url, init) => {
      if (String(url).endsWith('/rpc/claim_invitation_handover')) return fail();
      return through(url, init);
    };
    const r = await withMode('handover', () => run(db, { alert: (kind, fields) => alerts.push([kind, fields]) }));
    assert.equal(r.invitationId, INVITATION, `${label}: the ids are owed`);
    assert.equal(r.delivery, 'failed', label);
    assert.equal(Object.hasOwn(r, 'acceptUrl'), false, `${label}: no link of either kind`);
    assert.deepEqual(db.calls.filter((c) => c.gotrue), [], `${label}: GoTrue never called`);
    assert.deepEqual(alerts, [['delivery_failed', { errorName: 'Error', companyId: COMPANY }]], label);
    const recorded = db.calls.find((c) => c.rpc === 'record_invitation_delivery');
    assert.equal(recorded.body.p_delivery, 'failed', `${label}: the row says failed, not handover`);
  }
});

/* F7 and CR-ENA7-3: handOver hands a token only when createInviteeAccount says the account is unclaimed, and not merely
   when a token came back. Each pair here returns a token that must not be handed. */
test('ENA-7: a token GoTrue minted for an account it does not report unclaimed is never handed', async () => {
  for (const [label, over] of [
    ['signup 400 then a magiclink of type magiclink (another call made the account)', { signupStatus: 400 }],
    ['signup 200 then a magiclink whose account is confirmed', { magiclinkConfirmedAt: '2026-10-24T10:00:00Z' }],
  ]) {
    const db = inviteDb(over);
    const r = await withMode('handover', () =>
      invitations.createInvitation(session, { companyId: COMPANY, email: 'x@example.invalid', roles: ['member'] }, {}, db.options),
    );
    assert.equal(r.delivery, 'handover', label);
    assert.equal(r.signsIn, false, label);
    assert.equal(r.acceptUrl, `https://enterprise.example.invalid/accept#invite=${NEW_CODE}`, `${label}: the code only`);
    assert.deepEqual(db.calls.filter((c) => c.gotrue).map((c) => c.body.type), ['signup', 'magiclink'], label);
  }
});

test('ENA-7: mail mode asks no claim and mails the signing link as before', async () => {
  const sent = [];
  const db = inviteDb({ claim: false });
  await withMode('mail', () =>
    invitations.createInvitation(session, { companyId: COMPANY, email: 'x@example.invalid', roles: ['member'] }, { deliver: (m) => sent.push(m) }, db.options),
  );
  assert.equal(db.calls.some((c) => c.rpc === 'claim_invitation_handover'), false);
  assert.match(sent[0].acceptUrl, /token_hash=/, 'the address receives the signing link; holding the mailbox is the factor');
});

test('design 1.2: mail mode mails and answers no link at all, and an absent transport refuses before any read or write', async () => {
  const sent = [];
  const db = inviteDb();
  const r = await withMode('mail', () =>
    invitations.createInvitation(
      session,
      { companyId: COMPANY, email: 'new.person@example.invalid', roles: ['member'] },
      { deliver: (mail) => sent.push(mail) },
      db.options,
    ),
  );
  assert.deepEqual(r, { invitationId: INVITATION, expiresAt: EXPIRES, delivery: 'mail' });
  assert.equal('acceptUrl' in r, false, 'absent, not null: a page renders what it was given');
  assert.equal(sent.length, 1);
  assert.match(sent[0].acceptUrl, /^https:\/\/enterprise\.example\.invalid\/accept#/);
  /* E7 2.6 item 3: the two fields the template needs, and nothing else crosses. */
  assert.deepEqual(Object.keys(sent[0]).sort(), ['acceptUrl', 'companyName', 'expiresAt', 'kind', 'to']);
  assert.equal(sent[0].kind, 'member');
  assert.equal(sent[0].to, 'new.person@example.invalid');

  const none = inviteDb();
  await withMode('mail', () =>
    assert.rejects(
      invitations.createInvitation(session, { companyId: COMPANY, email: 'x@example.invalid', roles: [] }, {}, none.options),
      refusal('E_MAIL_NOT_CONFIGURED'),
    ),
  );
  assert.deepEqual(none.calls, [], 'nothing was read and nothing was written');
});

test('E7 design 1.1: a delivery failure after the written row answers 201 delivery failed, with no link and no transport text', async () => {
  const db = inviteDb();
  const r = await withMode('mail', () =>
    invitations.createInvitation(
      session,
      { companyId: COMPANY, email: 'new.person@example.invalid', roles: [] },
      {
        deliver: () => {
          throw new Error(`transport said no for ${HASHED}`);
        },
      },
      db.options,
    ),
  );
  /* The row is written (the routine ran), the ids come back, and nothing of the transport's error or the link does.
     Fail-before: the code at 0ba9465 threw 502 E_DELIVERY_FAILED here, after the write (E7D-1). */
  assert.deepEqual(r, { invitationId: INVITATION, expiresAt: EXPIRES, delivery: 'failed' });
  assert.equal(JSON.stringify(r).includes(HASHED), false);
  assert.equal(JSON.stringify(r).includes('accept#'), false);
  assert.equal(Object.hasOwn(CODES, 'E_DELIVERY_FAILED'), false, 'the code is retired');
});

test('E7 design 2.6 item 3: in mail mode a wired transport that is not ready refuses before any read or write', async () => {
  const none = inviteDb();
  await withMode('mail', () =>
    assert.rejects(
      invitations.createInvitation(
        session,
        { companyId: COMPANY, email: 'x@example.invalid', roles: [] },
        { deliver: () => undefined, ready: () => false },
        none.options,
      ),
      refusal('E_MAIL_NOT_CONFIGURED'),
    ),
  );
  assert.deepEqual(none.calls, [], 'nothing was read and nothing was written');
});

test('design 1.2: a mode the environment does not define is a configuration error, never a silent handover', async () => {
  const db = inviteDb();
  await withMode('post', () =>
    assert.rejects(
      invitations.createInvitation(session, { companyId: COMPANY, email: 'x@example.invalid', roles: [] }, {}, db.options),
      /E_CONFIG ENTERPRISE_INVITATION_DELIVERY/,
    ),
  );
  assert.deepEqual(db.calls, [], 'nothing ran');
  assert.deepEqual(invitations.DELIVERY_MODES, ['handover', 'mail']);
});

/* ---------------------------------------------------------------------------
   design 1.2: the resend
   --------------------------------------------------------------------------- */

test('design 1.2: a resend calls api.invite_member again with the ROW s own address and roles, and answers the replaced id', async () => {
  const db = inviteDb({ rows: [pending()] });
  const r = await withMode('handover', () =>
    invitations.resendInvitation(session, { companyId: COMPANY, invitationId: INVITATION }, {}, db.options),
  );
  assert.deepEqual(r, {
    invitationId: INVITATION,
    expiresAt: EXPIRES,
    replacesInvitationId: INVITATION,
    delivery: 'handover',
    acceptUrl: `https://enterprise.example.invalid/accept#token_hash=${HASHED}&type=magiclink&invite=${NEW_CODE}`,
    signsIn: true,
  });
  const call = db.calls.find((c) => c.rpc === 'invite_member');
  assert.deepEqual(call.body, {
    p_company: COMPANY,
    p_email: 'new.person@example.invalid',
    p_roles: ['it_reviewer', 'member'],
    p_expires_in: '7 days',
  });
  assert.deepEqual(
    db.calls.map((c) => c.read ?? c.rpc ?? c.gotrue),
    [
      'my_standing',
      'invitations',
      'invite_member',
      'claim_invitation_handover',
      'generate_link',
      'generate_link',
      'record_invitation_delivery',
    ],
    'standing, the row, the routine, the claim (ENA-7), the account, the delivery recorded on the new row (E6 design 1.2.1)',
  );
});

test('design 3.5 rows 10 to 12: the resend s three refusals, each before api.invite_member', async () => {
  for (const [label, rows, invitationId, code] of [
    ['not readable under the caller s token', [], INVITATION, 'E_NOT_FOUND'],
    ['a row of another company', [pending({ company_id: OTHER_COMPANY })], INVITATION, 'E_NOT_FOUND'],
    ['an accepted row', [pending({ accepted_at: '2026-09-20T10:00:00+00:00' })], INVITATION, 'E_INVITATION_ACCEPTED'],
    ['a malformed id', [], 'not-a-uuid', 'E_NOT_FOUND'],
  ]) {
    const db = inviteDb({ rows });
    await withMode('handover', () =>
      assert.rejects(
        invitations.resendInvitation(session, { companyId: COMPANY, invitationId }, {}, db.options),
        refusal(code),
        label,
      ),
    );
    assert.equal(
      db.calls.some((c) => c.rpc === 'invite_member' || c.gotrue),
      false,
      `${label}: no routine and no account`,
    );
  }
});

test('design 1.2: a resend of a revoked or expired row is admitted and is simply a fresh invitation', async () => {
  for (const over of [{ revoked_at: '2026-09-20T10:00:00+00:00' }, { expires_at: '2026-09-01T10:00:00+00:00' }]) {
    const db = inviteDb({ rows: [pending(over)] });
    const r = await withMode('handover', () =>
      invitations.resendInvitation(session, { companyId: COMPANY, invitationId: INVITATION }, {}, db.options),
    );
    assert.equal(r.invitationId, INVITATION);
    assert.ok(db.calls.some((c) => c.rpc === 'invite_member'));
  }
});

test('design 3.3: nothing returns a link a second time, because no invitation routine is bound and a repeat is a fresh one', async () => {
  const first = inviteDb({ rows: [pending()], invite: CODE });
  const a = await withMode('handover', () =>
    invitations.resendInvitation(session, { companyId: COMPANY, invitationId: INVITATION }, {}, first.options),
  );
  const second = inviteDb({ rows: [pending({ id: OTHER_INVITATION })], invite: NEW_CODE });
  const b = await withMode('handover', () =>
    invitations.resendInvitation(session, { companyId: COMPANY, invitationId: OTHER_INVITATION }, {}, second.options),
  );
  assert.notEqual(a.acceptUrl, b.acceptUrl, 'a repeat issues a new link; it never answers the earlier one');
  for (const db of [first, second]) {
    const calls = db.calls.filter((c) => c.rpc);
    assert.deepEqual(
      calls.map((c) => c.rpc),
      ['invite_member', 'claim_invitation_handover', 'record_invitation_delivery'],
      'one routine, the handover claim (ENA-7) and the delivery record (E6 design 1.2.1), all unbound',
    );
    assert.equal(calls[1].claims.fn, undefined, 'the claim takes the unbound bearer too');
    assert.equal(calls[2].claims.fn, undefined, 'the record takes the unbound bearer too');
    assert.equal('idempotency_key' in calls[0].body, false, 'no claim row is spent on an invitation');
    assert.equal(calls[0].claims.fn, undefined, 'the bearer is the unbound one');
  }
});

/* ---------------------------------------------------------------------------
   design 1.2 rules 1 and 2: the accept link, and the places it may not reach
   --------------------------------------------------------------------------- */

const E6_SOURCES = [
  'lib/services/invitations.mjs',
  'lib/services/operator.mjs',
  'lib/services/agents.mjs',
  'lib/services/quotas.mjs',
  'lib/services/lifecycle.mjs',
  'lib/services/takeout.mjs',
  'lib/services/principal.mjs',
  'lib/services/identity.mjs',
  'lib/operator/accounts.mjs',
  'lib/http/routes.mjs',
];
const sourceOf = (rel) => readFileSync(join(REPO, rel), 'utf8');
/* Comments name the URL freely and are not code. */
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

test('TRIPWIRE, design 1.2 rule 2: one module assembles the accept URL and no E6 module logs, stores or re-answers it', () => {
  const builders = E6_SOURCES.filter((rel) => /accept#/.test(withoutComments(sourceOf(rel))));
  assert.deepEqual(builders, ['lib/services/invitations.mjs'], 'exactly one place builds the link');
  for (const rel of E6_SOURCES) {
    const code = withoutComments(sourceOf(rel));
    for (const forbidden of [/console\./, /acceptUrl[^\n]*(?:log|audit|stderr|write)/i, /process\.stdout/]) {
      assert.equal(forbidden.test(code), false, `${rel} against ${forbidden}`);
    }
  }
  /* The one line that names acceptUrl outside the builder is the mail transport's own argument, which is what
     `mail` mode exists to hand it. */
  const routes = withoutComments(sourceOf('lib/http/routes.mjs'));
  assert.equal(/acceptUrl/.test(routes), false, 'a route passes the service s answer through and names no field');
});

test('design 1.2 rule 2: the audit guard has no key that could hold a URL', () => {
  const sql = readFileSync(join(REPO, 'supabase/migrations/008_lifecycle.sql'), 'utf8');
  const guard = sql.slice(sql.indexOf('create or replace function app.audit_details_guard'));
  const body = guard.slice(0, guard.indexOf('$$;'));
  for (const bad of ['accept_url', 'acceptUrl', 'invite_code', 'token', 'url']) {
    assert.equal(new RegExp(`'${bad}'`).test(body), false, `${bad} is not an audit key`);
  }
});

/* ---------------------------------------------------------------------------
   design 2.6 item 8: the environment contract
   --------------------------------------------------------------------------- */

test('design 2.6 item 8: ENTERPRISE_INVITATION_DELIVERY is documented where lib/ reads it, with both values and the default', () => {
  const src = sourceOf('lib/services/invitations.mjs');
  assert.match(src, /ENTERPRISE_INVITATION_DELIVERY = handover \| mail/);
  assert.match(src, /unset, empty or absent is handover/);
  /* One reader, so a second module cannot answer a different mode. */
  const readers = E6_SOURCES.filter((rel) => /ENTERPRISE_INVITATION_DELIVERY/.test(sourceOf(rel)));
  assert.deepEqual(readers, ['lib/services/invitations.mjs']);
});

/* ---------------------------------------------------------------------------
   The directory of E6 services, so a module added later without a test here is noticed
   --------------------------------------------------------------------------- */

test('every E6 service named by design 2.1 exists and is reachable from this test file s list', () => {
  const services = readdirSync(join(REPO, 'lib/services')).filter((f) => f.endsWith('.mjs'));
  for (const name of ['invitations.mjs', 'operator.mjs', 'agents.mjs', 'quotas.mjs', 'lifecycle.mjs', 'takeout.mjs'])
    assert.ok(services.includes(name), `lib/services/${name}`);
  assert.ok(statSync(join(REPO, 'lib/operator/accounts.mjs')).isFile());
  assert.ok(statSync(join(REPO, 'scripts/sweep-accounts.mjs')).isFile());
});

/* ---------------------------------------------------------------------------
   E6S-C-F2, the lead's grant of 2026-09-18: api.authorize_download is the deciding boundary for a download, so
   lib/services/catalog.mjs no longer reads app.releases under the caller's token before calling it. The two
   refusals that read must not swallow have to reach the caller as themselves, which is what this proves without
   a stack: the PostgREST double answers exactly what the local stack answered in probe 29 and in tests/e5/stack,
   and lib/errors.mjs fromPostgrest is the only thing between it and the caller.
   --------------------------------------------------------------------------- */

test("E6S-C-F2: the download's two routine refusals reach the caller as their own codes and statuses, never 500", async () => {
  const catalog = await import('../../../lib/services/catalog.mjs');
  const RELEASE = 'ccccbbbb-1111-4222-8333-444444444444';
  /* The two answers the real PostgREST gave for this routine on the local stack, copied from the probe logs:
     a P0002 raise arrives as HTTP 500 with the token in `message`, a P0001 raise as HTTP 400. */
  const answers = {
    E_NOT_FOUND: { status: 500, body: { code: 'P0002', details: null, hint: null, message: 'E_NOT_FOUND' } },
    E_ACCESS_PERIOD_ENDED: {
      status: 400,
      body: { code: 'P0001', details: null, hint: null, message: 'E_ACCESS_PERIOD_ENDED' },
    },
  };
  for (const [code, answer] of Object.entries(answers)) {
    const reads = [];
    const fetchImpl = async (url, init) => {
      const u = new URL(String(url));
      if (init.method === 'GET') {
        reads.push(u.pathname.split('/').pop());
        return { status: 200, json: async () => [] };
      }
      return { status: answer.status, json: async () => answer.body };
    };
    const error = await catalog
      .authorizeDownload(session, { releaseId: RELEASE }, { fetchImpl })
      .then(() => null, (e) => e);
    assert.ok(error, `${code}: the call refuses`);
    assert.equal(error.code, code, `${code}: the routine's own code, not E_INTERNAL`);
    assert.equal(CODES[error.code], code === 'E_NOT_FOUND' ? 404 : 409, `${code}: design 3.1's status`);
    assert.notEqual(CODES[error.code], 500, `${code}: never 500`);
    /* And the refusal came from the ROUTINE, not from a read in front of it: no GET preceded the call. */
    assert.deepEqual(reads, [], `${code}: no visibility pre-read runs before the routine`);
  }
});

test('E6S-C-F2: the malformed id is still refused before any request, so it never reaches the database', async () => {
  const catalog = await import('../../../lib/services/catalog.mjs');
  const db = fakeDb({});
  await assert.rejects(
    () => catalog.authorizeDownload(session, { releaseId: 'not-a-uuid' }, db.options),
    refusal('E_NOT_FOUND'),
  );
  assert.deepEqual(db.calls, [], 'nothing was sent');
});

/* ---------------------------------------------------------------------------
   E7 design 1.1, 3.4 and E7D-C-F7 (the E7 mail lane): the transport on the four invitation paths.
   The transport is the real lib/services/mail.mjs against a fetch capture, or a spy with its shape; the database and
   GoTrue are the doubles above. Nothing leaves the process.
   --------------------------------------------------------------------------- */

const { mailTransport } = await import('../../../lib/services/mail.mjs');
const operatorService = await import('../../../lib/services/operator.mjs');

const MAIL_ENV = Object.freeze({
  ENTERPRISE_MAIL_PROVIDER: 'resend',
  ENTERPRISE_MAIL_API_KEY: 'example-synthetic-unit-provider-value-0123',
  ENTERPRISE_MAIL_FROM: 'Phaeacia <no-reply@phaeacia.example.invalid>',
});
const OPERATOR_COMPANY_NAME = 'SYNTHETIC Operator Co';

/** A fetch capture for the transport: records each provider request's parsed body and answers with `answer()`. */
function provider(answer = () => new Response(null, { status: 200 })) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return answer();
  };
  return { sent, fetchImpl };
}

/* The database and GoTrue double for all four paths: invite_member for the admin's two, create_company and
   operator_invite_admin for the operator's, and operator_export_manifest for the succession mail's company name. */
function pathsDb({ generateStatus = 200, manifest = () => ({ company_id: COMPANY, slug: 'synthetic-op', name: OPERATOR_COMPANY_NAME }) } = {}) {
  const db = fakeDb({
    tables: {
      memberships: [{ id: MEMBERSHIP, roles: ['company_admin', 'member'], status: 'active' }],
      invitations: [pending()],
    },
    rpc: (name) => {
      if (name === 'invite_member' || name === 'operator_invite_admin')
        return [{ invitation_id: OTHER_INVITATION, invite_code: NEW_CODE, expires_at: EXPIRES }];
      if (name === 'create_company')
        return [
          {
            company_id: OTHER_COMPANY,
            invitation_id: OTHER_INVITATION,
            invite_code: NEW_CODE,
            expires_at: EXPIRES,
            ends_at: '2026-11-26T00:00:00Z',
            export_by: '2026-12-10T00:00:00Z',
            delete_by: '2027-01-09T00:00:00Z',
          },
        ];
      if (name === 'operator_export_manifest') return manifest();
      return [{}];
    },
  });
  const inner = db.fetchImpl;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/auth/v1/admin/generate_link')) {
      const body = JSON.parse(init.body);
      db.calls.push({ gotrue: 'generate_link', body });
      if (generateStatus !== 200) return { status: generateStatus, json: async () => ({ msg: `synthetic gotrue text for ${body.email}` }) };
      return { status: 200, json: async () => ({ hashed_token: HASHED, verification_type: body.type }) };
    }
    return inner(url, init);
  };
  return { calls: db.calls, options: { fetchImpl } };
}

const COMPANY_BODY = {
  slug: 'synthetic-e7',
  name: 'SYNTHETIC E7 Co',
  firstAdminEmail: 'first.admin@example.invalid',
  startsAt: '2026-09-18T00:00:00Z',
  endsAt: '2026-11-26T00:00:00Z',
};

/** The four paths as [label, kind, the company the answer names, run(deps, options)]. */
const FOUR_PATHS = [
  ['create', 'member', COMPANY, (deps, o) => invitations.createInvitation(session, { companyId: COMPANY, email: 'new.person@example.invalid', roles: ['member'] }, deps, o)],
  ['resend', 'member', COMPANY, (deps, o) => invitations.resendInvitation(session, { companyId: COMPANY, invitationId: INVITATION }, deps, o)],
  ['operator create-company', 'first_admin', OTHER_COMPANY, (deps, o) => operatorService.createCompany(session, COMPANY_BODY, deps, o)],
  ['operator succession', 'succession', COMPANY, (deps, o) => operatorService.inviteAdmin(session, { companyId: COMPANY, email: 'heir@example.invalid' }, deps, o)],
];

test('E7-6 unit half: a transport with no key, then a malformed sender, refuses on each of the four paths before any read or write', async () => {
  const withoutKey = { ...MAIL_ENV };
  delete withoutKey.ENTERPRISE_MAIL_API_KEY;
  for (const [config, env] of [
    ['no key', withoutKey],
    ['a malformed sender', { ...MAIL_ENV, ENTERPRISE_MAIL_FROM: 'Phaeacia <no-reply@>' }],
  ]) {
    for (const [label, , , run] of FOUR_PATHS) {
      const db = pathsDb();
      const out = provider();
      await withMode('mail', () =>
        assert.rejects(run({ mail: mailTransport(env, { fetchImpl: out.fetchImpl }) }, db.options), refusal('E_MAIL_NOT_CONFIGURED'), `${label}, ${config}`),
      );
      assert.deepEqual(db.calls, [], `${label}, ${config}: nothing was read and nothing was written`);
      assert.equal(out.sent.length, 0, `${label}, ${config}: nothing was sent`);
    }
  }
  assert.equal(CODES.E_MAIL_NOT_CONFIGURED, 503);
});

/* The alerts design 1.9 moved this pin once, granted by the lead 2026-09-21: the message gains exactly one key, `tags`
   (the kind, namespaced `enterprise-invitation`, the company and the invitation's own id),
   so the provider hands them back in its delivery events. Nothing else crosses. */
test('E7 1.1: with a ready transport each path renders its own kind and company, and only { to, subject, text, tags } crosses', async () => {
  for (const [label, kind, companyId, run] of FOUR_PATHS) {
    const db = pathsDb();
    const handed = [];
    const mail = { ready: () => true, deliver: async (m) => handed.push(m) };
    const r = await withMode('mail', () => run({ mail }, db.options));
    assert.equal(r.delivery, 'mail', label);
    assert.equal(Object.hasOwn(r, 'acceptUrl'), false, `${label}: no link in the answer`);
    assert.equal(r.invitationId, OTHER_INVITATION, `${label}: the ids come back`);
    assert.equal(handed.length, 1, label);
    assert.deepEqual(Object.keys(handed[0]).sort(), ['subject', 'tags', 'text', 'to'], `${label}: nothing else crosses into the transport`);
    assert.deepEqual(
      handed[0].tags,
      { kind: 'enterprise-invitation', company: companyId, invitation: OTHER_INVITATION },
      `${label}: the tags name the kind, this path's company and the invitation the routine answered`,
    );
    const url = `https://enterprise.example.invalid/accept#token_hash=${HASHED}&type=magiclink&invite=${NEW_CODE}`;
    assert.ok(handed[0].text.split('\n').includes(url), `${label}: the accept URL on its own line`);
    const company = { member: 'SYNTHETIC Unit AG', first_admin: 'SYNTHETIC E7 Co', succession: OPERATOR_COMPANY_NAME }[kind];
    assert.equal(handed[0].subject, `Your invitation to ${company} on Phaeacia`, `${label}: the company named`);
    const opening = {
      member: `You have been invited to ${company}'s workspace on Phaeacia.`,
      first_admin: `You have been invited to set up ${company}'s workspace on Phaeacia as its first administrator.`,
      succession: `You have been invited to ${company}'s workspace on Phaeacia as an administrator.`,
    }[kind];
    assert.ok(handed[0].text.startsWith(opening), `${label}: kind ${kind}`);
  }
  /* The role word: an admin's invitation carrying company_admin renders the administrator kind. */
  const db = pathsDb();
  const handed = [];
  await withMode('mail', () =>
    invitations.createInvitation(
      session,
      { companyId: COMPANY, email: 'new.admin@example.invalid', roles: ['company_admin'] },
      { mail: { ready: () => true, deliver: async (m) => handed.push(m) } },
      db.options,
    ),
  );
  assert.ok(handed[0].text.startsWith("You have been invited to SYNTHETIC Unit AG's workspace on Phaeacia as an administrator."));
  /* And the real transport builds the provider's request from exactly that message. */
  const out = provider();
  const real = pathsDb();
  await withMode('mail', () => FOUR_PATHS[0][3]({ mail: mailTransport({ ...MAIL_ENV }, { fetchImpl: out.fetchImpl }) }, real.options));
  assert.equal(out.sent.length, 1);
  assert.deepEqual(Object.keys(out.sent[0].body).sort(), ['from', 'subject', 'tags', 'text', 'to']);
  assert.deepEqual(out.sent[0].body.to, ['new.person@example.invalid']);
  assert.deepEqual(out.sent[0].body.tags, [
    { name: 'kind', value: 'enterprise-invitation' },
    { name: 'company', value: COMPANY },
    { name: 'invitation', value: OTHER_INVITATION },
  ]);
});

test('E7D-C-F7: a refused send answers failed, a lost answer unconfirmed; both keep the ids and raise one allowlisted alert', async () => {
  const lost = () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' }) });
  };
  for (const [label, answer, delivery, fields] of [
    ['a 500', () => new Response(`{"message":"synthetic quote for new.person@example.invalid"}`, { status: 500 }), 'failed', { errorName: 'MailError' }],
    ['a reset after the request left', lost, 'unconfirmed', { errorName: 'MailError', code: 'ECONNRESET' }],
  ]) {
    for (const [path, , companyId, run] of FOUR_PATHS) {
      const db = pathsDb();
      const alerts = [];
      const out = provider(answer);
      const r = await withMode('mail', () =>
        run({ mail: mailTransport({ ...MAIL_ENV }, { fetchImpl: out.fetchImpl }), alert: async (...a) => alerts.push(a) }, db.options),
      );
      assert.equal(r.delivery, delivery, `${path}, ${label}`);
      assert.equal(r.invitationId, OTHER_INVITATION, `${path}, ${label}: the committed id is kept`);
      assert.equal(Object.hasOwn(r, 'acceptUrl'), false, `${path}, ${label}: no link`);
      assert.equal(JSON.stringify(r).includes('synthetic'), false, `${path}, ${label}: nothing of the provider's words`);
      assert.equal(alerts.length, 1, `${path}, ${label}: one alert`);
      assert.equal(alerts[0][0], 'delivery_failed');
      assert.deepEqual(alerts[0][1], { ...fields, companyId }, `${path}, ${label}: the allowlisted fields only`);
    }
  }
  /* No sink wired: nothing is raised and the answer is the same. A sink that throws does not change the answer. */
  for (const alert of [undefined, async () => { throw new Error('synthetic sink failure'); }]) {
    const db = pathsDb();
    const out = provider(() => new Response(null, { status: 503 }));
    const r = await withMode('mail', () => FOUR_PATHS[0][3]({ mail: mailTransport({ ...MAIL_ENV }, { fetchImpl: out.fetchImpl }), alert }, db.options));
    assert.equal(r.delivery, 'failed');
  }
  /* The seam answers the same way: a throw whose outcome is unconfirmed is unconfirmed, any other throw failed. */
  for (const [thrown, delivery] of [[Object.assign(new Error('x'), { outcome: 'unconfirmed' }), 'unconfirmed'], [new Error('x'), 'failed']]) {
    const db = pathsDb();
    const r = await withMode('mail', () => FOUR_PATHS[0][3]({ deliver: () => { throw thrown; } }, db.options));
    assert.equal(r.delivery, delivery);
  }
});

test('E7-8: GoTrue failing after the row is written answers failed on each path; the row was written; one alert; nothing sent', async () => {
  for (const [label, , companyId, run] of FOUR_PATHS) {
    const db = pathsDb({ generateStatus: 500 });
    const alerts = [];
    const out = provider();
    const r = await withMode('mail', () =>
      run({ mail: mailTransport({ ...MAIL_ENV }, { fetchImpl: out.fetchImpl }), alert: async (...a) => alerts.push(a) }, db.options),
    );
    assert.equal(r.delivery, 'failed', label);
    assert.equal(r.invitationId, OTHER_INVITATION, `${label}: the ids of the written row`);
    const writes = db.calls.filter((c) => ['invite_member', 'create_company', 'operator_invite_admin'].includes(c.rpc));
    assert.equal(writes.length, 1, `${label}: the routine ran once, so the row exists`);
    assert.equal(out.sent.length, 0, `${label}: nothing was sent`);
    assert.deepEqual(alerts, [['delivery_failed', { errorName: 'Error', companyId }, alerts[0]?.[2]]], `${label}: one alert, no GoTrue text`);
    assert.equal(JSON.stringify(r).includes('synthetic gotrue text'), false);
  }
  /* The control: GoTrue answering 200 sends the mail. */
  const db = pathsDb();
  const out = provider();
  const r = await withMode('mail', () => FOUR_PATHS[0][3]({ mail: mailTransport({ ...MAIL_ENV }, { fetchImpl: out.fetchImpl }) }, db.options));
  assert.equal(r.delivery, 'mail');
  assert.equal(out.sent.length, 1);
});

test('E7 1.1: the succession mail reads its company name after the write in mail mode only; a failed read names no company', async () => {
  const order = (calls) => calls.filter((c) => c.rpc).map((c) => c.rpc);
  const db = pathsDb();
  await withMode('mail', () => FOUR_PATHS[3][3]({ mail: { ready: () => true, deliver: async () => undefined } }, db.options));
  assert.deepEqual(
    order(db.calls),
    ['operator_invite_admin', 'operator_export_manifest', 'record_invitation_delivery'],
    'the name is read after the routine committed; the delivery is recorded last (E6 design 1.2.1)',
  );

  const handover = pathsDb();
  await withMode('handover', () => FOUR_PATHS[3][3]({}, handover.options));
  assert.deepEqual(
    order(handover.calls),
    ['operator_invite_admin', 'claim_invitation_handover', 'record_invitation_delivery'],
    'handover makes no extra read; its one extra call is the handover claim (ENA-7)',
  );

  const failing = pathsDb({
    manifest: () => {
      throw new Error('synthetic read failure');
    },
  });
  const handed = [];
  const r = await withMode('mail', () => FOUR_PATHS[3][3]({ mail: { ready: () => true, deliver: async (m) => handed.push(m) } }, failing.options));
  assert.equal(r.delivery, 'mail', 'a failed name read never fails a written invitation');
  assert.equal(handed[0].subject, 'Your invitation on Phaeacia');
});

/* ---------------------------------------------------------------------------
   E7M-C-F2 (evidence/e7-mail-critique.md): the accept link's origin is a precondition of every invitation, in both
   modes, checked before the write; and a link-assembly failure after the write is `failed` with the ids, never 500.
   Fail-before, both halves, on lib/services/invitations.mjs at 7e68c6d: the first half writes the row and then throws
   E_CONFIG (the critique's 500 with no ids on all four paths); the second half throws the same from outside the
   post-write boundary.
   --------------------------------------------------------------------------- */
async function withOrigin(value, run) {
  const before = process.env.ENTERPRISE_ORIGIN;
  if (value === undefined) delete process.env.ENTERPRISE_ORIGIN;
  else process.env.ENTERPRISE_ORIGIN = value;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.ENTERPRISE_ORIGIN;
    else process.env.ENTERPRISE_ORIGIN = before;
  }
}

const BAD_ORIGINS = [
  ['unset', undefined],
  ['empty', ''],
  ['no scheme', 'enterprise.example.invalid'],
  ['a trailing slash', 'https://enterprise.example.invalid/'],
  ['a path', 'https://enterprise.example.invalid/app'],
  ['a query', 'https://enterprise.example.invalid/?x=1'],
  ['a fragment', 'https://enterprise.example.invalid/#f'],
  ['not http', 'ftp://enterprise.example.invalid'],
  ['credentials', 'https://user:pw@enterprise.example.invalid'],
];

test('E7M-C-F2 (before the write): a missing or malformed ENTERPRISE_ORIGIN refuses every path in both modes with nothing read or written', async () => {
  assert.equal(invitations.acceptOrigin(), 'https://enterprise.example.invalid');
  assert.equal(await withOrigin('http://127.0.0.1:4173', () => invitations.acceptOrigin()), 'http://127.0.0.1:4173', 'the dev shell origin');
  for (const [what, value] of BAD_ORIGINS) {
    assert.equal(await withOrigin(value, () => invitations.acceptOrigin()), null, what);
    for (const mode of ['handover', 'mail']) {
      for (const [label, , , run] of FOUR_PATHS) {
        const db = pathsDb();
        const out = provider();
        const deps = mode === 'mail' ? { mail: mailTransport({ ...MAIL_ENV }, { fetchImpl: out.fetchImpl }) } : {};
        await withMode(mode, () =>
          withOrigin(value, () => assert.rejects(run(deps, db.options), refusal('E_MAIL_NOT_CONFIGURED'), `${label}, ${mode}, ${what}`)),
        );
        assert.deepEqual(db.calls, [], `${label}, ${mode}, ${what}: nothing was read and nothing was written`);
        assert.equal(out.sent.length, 0, `${label}, ${mode}, ${what}: nothing was sent`);
      }
    }
  }
});

test('E7M-C-F2 (after the write): the origin lost between the check and the link answers failed with the ids on every path in both modes', async () => {
  for (const mode of ['handover', 'mail']) {
    for (const [label, , companyId, run] of FOUR_PATHS) {
      const db = pathsDb();
      const out = provider();
      const alerts = [];
      /* The write is the first PostgREST call; the origin disappears as it runs, so the check passed and the assembly fails. */
      const options = {
        fetchImpl: async (url, init) => {
          if (String(url).includes('/rpc/')) delete process.env.ENTERPRISE_ORIGIN;
          return db.options.fetchImpl(url, init);
        },
      };
      const deps = { alert: async (...a) => alerts.push(a) };
      if (mode === 'mail') deps.mail = mailTransport({ ...MAIL_ENV }, { fetchImpl: out.fetchImpl });
      const r = await withMode(mode, () => withOrigin('https://enterprise.example.invalid', () => run(deps, options)));
      assert.equal(r.delivery, 'failed', `${label}, ${mode}`);
      assert.equal(r.invitationId, OTHER_INVITATION, `${label}, ${mode}: the ids of the written row`);
      assert.equal('acceptUrl' in r, false, `${label}, ${mode}: no link`);
      const writes = db.calls.filter((c) => ['invite_member', 'create_company', 'operator_invite_admin'].includes(c.rpc));
      assert.equal(writes.length, 1, `${label}, ${mode}: the routine ran once`);
      assert.equal(out.sent.length, 0, `${label}, ${mode}: nothing was sent`);
      assert.deepEqual(alerts, [['delivery_failed', { errorName: 'Error', companyId }, alerts[0]?.[2]]], `${label}, ${mode}: one alert`);
      assert.equal(JSON.stringify(r).includes('E_CONFIG'), false, `${label}, ${mode}: no configuration text in the answer`);
    }
  }
});

/* ---------------------------------------------------------------------------
   E6 design 1.2.1 (lane K4, XR-7): the row records what the attempt came to. Every path writes its answer's own word
   through api.record_invitation_delivery, once, under the caller's own unbound server token, after the attempt and
   before the answer; a record that fails changes nothing in the answer and raises nothing. The routine's own rules
   (creator only, write once, the four words) are the database's and tests/db/33-invitation-delivery.sh's.
   --------------------------------------------------------------------------- */

const recorded = (calls) => calls.filter((c) => c.rpc === 'record_invitation_delivery');

test('K4: every path records its own answer on the row it wrote, once, unbound, after the attempt and before the answer', async () => {
  for (const [mode, word, seam] of [
    ['handover', 'handover', null],
    ['mail', 'mail', async () => undefined],
    ['mail', 'failed', async () => { throw new Error('synthetic refusal'); }],
    ['mail', 'unconfirmed', async () => { throw Object.assign(new Error('synthetic lost answer'), { outcome: 'unconfirmed' }); }],
  ]) {
    for (const [label, , , run] of FOUR_PATHS) {
      const db = pathsDb();
      let recordsAtAttempt = null;
      const deps = seam === null ? {} : { deliver: async (m) => { recordsAtAttempt = recorded(db.calls).length; return seam(m); } };
      const r = await withMode(mode, () => run(deps, db.options));
      assert.equal(r.delivery, word, `${label}, ${word}: the answer`);
      const rec = recorded(db.calls);
      assert.equal(rec.length, 1, `${label}, ${word}: one record`);
      assert.deepEqual(rec[0].body, { p_invitation: OTHER_INVITATION, p_delivery: word }, `${label}, ${word}: the row's id and the word, nothing else`);
      assert.equal(rec[0].claims.sub, SUB, `${label}, ${word}: under the caller's own server token`);
      assert.equal(rec[0].claims.fn, undefined, `${label}, ${word}: the unbound bearer`);
      assert.equal(db.calls.at(-1), rec[0], `${label}, ${word}: the last call the path makes`);
      if (seam !== null) assert.equal(recordsAtAttempt, 0, `${label}, ${word}: nothing was recorded before the attempt`);
    }
  }
});

test('K4: GoTrue failing records failed on each path, and so does the origin lost after the write', async () => {
  for (const [label, , , run] of FOUR_PATHS) {
    const db = pathsDb({ generateStatus: 500 });
    const r = await withMode('handover', () => run({}, db.options));
    assert.equal(r.delivery, 'failed', label);
    assert.deepEqual(recorded(db.calls).map((c) => c.body.p_delivery), ['failed'], `${label}: GoTrue`);
  }
  const db = pathsDb();
  const options = {
    fetchImpl: async (url, init) => {
      if (String(url).includes('/rpc/invite_member')) delete process.env.ENTERPRISE_ORIGIN;
      return db.options.fetchImpl(url, init);
    },
  };
  const r = await withMode('handover', () => withOrigin('https://enterprise.example.invalid', () => FOUR_PATHS[0][3]({}, options)));
  assert.equal(r.delivery, 'failed');
  assert.deepEqual(recorded(db.calls).map((c) => c.body.p_delivery), ['failed'], 'the origin lost after the write');
});

test('K4: a record that fails changes nothing in the answer and raises nothing; the row keeps not_attempted for the list to report', async () => {
  for (const [how, answer] of [
    ['a refusal', () => ({ status: 404, json: async () => ({ code: 'P0002', message: 'E_NOT_FOUND' }) })],
    ['a 500', () => ({ status: 500, json: async () => ({ message: 'synthetic' }) })],
    ['a throw', () => { throw new TypeError('fetch failed'); }],
  ]) {
    for (const [label, , , run] of FOUR_PATHS) {
      const db = pathsDb();
      const control = pathsDb();
      const options = {
        fetchImpl: async (url, init) => {
          if (String(url).includes('/rpc/record_invitation_delivery')) {
            db.calls.push({ rpc: 'record_invitation_delivery', failed: how });
            return answer();
          }
          return db.options.fetchImpl(url, init);
        },
      };
      const alerts = [];
      const r = await withMode('handover', () => run({ alert: async (...a) => alerts.push(a) }, options));
      const expected = await withMode('handover', () => run({}, control.options));
      assert.deepEqual(r, expected, `${label}, ${how}: the same answer as a record that landed`);
      assert.equal(r.delivery, 'handover', `${label}, ${how}`);
      assert.deepEqual(alerts, [], `${label}, ${how}: no alert, because the invitation was delivered`);
      assert.equal(recorded(db.calls).length, 1, `${label}, ${how}: tried once, never retried`);
    }
  }
});

test('K4: deliverInvitation records nothing without a session or a uuid to name, and answers the same', async () => {
  const args = { email: 'new.person@example.invalid', inviteCode: NEW_CODE, expiresAt: EXPIRES, companyId: COMPANY };
  for (const [what, extra] of [
    ['no session', { invitationId: OTHER_INVITATION }],
    ['a null session', { session: null, invitationId: OTHER_INVITATION }],
    ['no invitation id', { session }],
    ['an id that is not a uuid', { session, invitationId: 'not-a-uuid' }],
  ]) {
    const db = pathsDb();
    const r = await withMode('handover', () => invitations.deliverInvitation({ ...args, ...extra }, {}, db.options));
    assert.equal(r.delivery, 'handover', what);
    assert.equal(recorded(db.calls).length, 0, `${what}: nothing recorded`);
  }
  const db = pathsDb();
  await withMode('handover', () => invitations.deliverInvitation({ ...args, session, invitationId: OTHER_INVITATION }, {}, db.options));
  assert.equal(recorded(db.calls).length, 1, 'the control: a session and a uuid record once');
});

test('K4: the record carries no link, code, address or provider text, and the answer carries no stored word', async () => {
  for (const [label, , , run] of FOUR_PATHS) {
    const db = pathsDb();
    const r = await withMode('handover', () => run({}, db.options));
    const sent = JSON.stringify(recorded(db.calls)[0].body);
    for (const secret of [NEW_CODE, HASHED, '@', 'accept', 'token']) assert.equal(sent.includes(secret), false, `${label}: ${secret} is not in the record`);
    assert.equal(Object.hasOwn(r, 'not_attempted'), false);
  }
});
