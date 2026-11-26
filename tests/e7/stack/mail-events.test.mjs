/* The alerts design's slice 1 on the running local stack (docs/e7/alerts-and-checkin-design.md 1.4, 1.9, section 7):
   the tags the four REAL invitation paths hand the provider, read from the catcher's recorded requests, come back in a
   signed delivery event, through the adapter with a web Request, as the operator's alert for exactly that company.
   Cases AC-9 and AC-11 in their operator halves on the stack, AC-16's stack arm, and AC-31's operator half in the
   provider's own example's shape (Permanent, subtype Suppressed; the unit file reads the example verbatim, because no
   stack test may name the evidence directory, tests/e5/unit/capacity-evidence.test.mjs); every mail event writes
   nothing (no row, no audit row) and sends no mail.

   The invitation routes are built as their function files build them, makeRoutes({ alert, mail: mailTransport() }),
   pointed at tests/e7/mail-catcher.mjs, so the tags asserted are the ones the transport sent. The mail event route is
   built the same way and called through toNetlify with a web Request (ALD-R-F2), the alert capture running the REAL
   alert() with its test seams. The webhook secret is made at run time and never printed.

   Reseeds once through tests/db/00-seed.sh and builds its own users and companies. Run alone:
   node --test --test-concurrency=1 tests/e7/stack/mail-events.test.mjs */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { caller } from '../../e3/stack/helpers.mjs';
import {
  e4world,
  e6routes,
  freshEmail,
  futurePeriod,
  operators,
  periodBody,
  reseed,
  reviewCompany,
  sql,
} from '../../e6/stack/helpers.mjs';
import { bounceEvent, signEvent, startCatcher, suppressedEvent, webhookSecret } from '../mail-catcher.mjs';

process.env.ENTERPRISE_INVITATION_DELIVERY = 'mail';
delete process.env.ENTERPRISE_ALERT_SINK;
const ids = reseed();
const catcher = await startCatcher();
after(() => catcher.close());
const SECRET = webhookSecret();
process.env.ENTERPRISE_MAIL_WEBHOOK_SECRET = SECRET;

const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { toNetlify } = await import('../../../lib/http/netlify.mjs');
const { alert, resetAlertWindow } = await import('../../../lib/http/alerts.mjs');
const { mailTransport } = await import('../../../lib/services/mail.mjs');
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');

const mailEnv = catcher.env();
const logged = [];
const records = [];
const sent = [];
const deps = {
  mail: mailTransport(mailEnv),
  log: (e) => logged.push(e),
  alert: (event, fields, d) =>
    alert(event, fields, { ...d, alertWrite: (r) => records.push(r), alertSink: async (r) => void sent.push(r) }),
};
const table = makeRoutes(deps);
const call = caller(table, COOKIES, makeRequest);
const events = toNetlify(table.mailEvents);

const R = await e6routes(logged);
const W = e4world('alerts-s1', ids);
const OP = operators(ids);
const A = await reviewCompany(W, R, 'a');
const B = await reviewCompany(W, R, 'b');
futurePeriod(A.id);
futurePeriod(B.id);

const ok = (r, status, label) => {
  assert.equal(r.status, status, `${label}: ${r.raw}`);
  return r.body;
};
const count = (from, where = 'true') => Number(sql(`select count(*) from ${from} where ${where}`));
/** Everything a mail event could write: every table the product owns that a route writes, counted. */
const footprint = () => ({
  audit: count('app.audit_events'),
  invitations: count('app.invitations'),
  companies: count('app.companies'),
  memberships: count('app.memberships'),
  messages: catcher.messages.length,
});

/* A signed post of the event through the adapter, as the provider would send it now. */
async function post(event, { secret = SECRET, headers = {} } = {}) {
  const body = JSON.stringify(event);
  const res = await events(
    new Request('http://127.0.0.1/api/mail/events', {
      method: 'POST',
      headers: { ...signEvent(body, { secret }).headers, ...headers },
      body,
    }),
    { params: {} },
  );
  return { status: res.status, body: JSON.parse(await res.text()) };
}

/* ---------------------------------------------------------------------------
   The tags on the four paths, from the requests the transport made
   --------------------------------------------------------------------------- */

const tagged = {};

test('the tags: each of the four invitation paths sends kind enterprise-invitation, its company id and its own invitation id', async () => {
  const email = freshEmail('as1-shared');
  const created = ok(await call('invitationsCreate', { user: A.adminHi, params: { companyId: A.id }, body: { email, roles: ['member'] } }), 201, 'create A');
  assert.deepEqual(catcher.newestTo(email).tags, { kind: 'enterprise-invitation', company: A.id, invitation: created.invitationId });
  tagged.a = catcher.newestTo(email);
  const inB = ok(await call('invitationsCreate', { user: B.adminHi, params: { companyId: B.id }, body: { email, roles: ['member'] } }), 201, 'create B');
  assert.deepEqual(catcher.newestTo(email).tags, { kind: 'enterprise-invitation', company: B.id, invitation: inB.invitationId });
  tagged.b = catcher.newestTo(email);
  /* A resend carries the NEW row's id, not the one it replaced. */
  const resent = ok(await call('invitationsResend', { user: B.adminHi, params: { companyId: B.id, invitationId: inB.invitationId } }), 201, 'resend B');
  assert.notEqual(resent.invitationId, inB.invitationId);
  assert.deepEqual(catcher.newestTo(email).tags, { kind: 'enterprise-invitation', company: B.id, invitation: resent.invitationId });
  tagged.b2 = catcher.newestTo(email);
  /* The two operator-issued paths: the first administrator of a new company, and a succession invitation. */
  const first = freshEmail('as1-first');
  const made = ok(
    await call('operatorCompanyCreate', {
      user: OP.aal2,
      body: { slug: `as1-${W.run}`.slice(0, 60), name: 'SYNTHETIC Alerts S1', firstAdminEmail: first, ...periodBody() },
    }),
    201,
    'operator create-company',
  );
  assert.deepEqual(catcher.newestTo(first).tags, { kind: 'enterprise-invitation', company: made.companyId, invitation: made.invitationId });
  assert.equal(sql(`select company_id from app.invitations where id='${made.invitationId}'`), made.companyId);
  const successor = freshEmail('as1-succ');
  const succ = ok(await call('operatorAdminInvitation', { user: OP.aal2, params: { companyId: B.id }, body: { email: successor } }), 201, 'succession');
  assert.deepEqual(catcher.newestTo(successor).tags, { kind: 'enterprise-invitation', company: B.id, invitation: succ.invitationId });
  /* Every request the transport made in this file carried the explicit user-agent and no idempotency key. */
  assert.ok(catcher.requests.length >= 5);
  for (const q of catcher.requests) {
    assert.equal(q.userAgent, 'phaeacia-enterprise/1');
    assert.equal(q.idempotencyKey, null);
  }
});

/* ---------------------------------------------------------------------------
   The tags come back: AC-9's operator half on the stack
   --------------------------------------------------------------------------- */

test('AC-9 operator half (stack): the same address bounces for A and B; each company gets its own alert, and nothing is written or sent', async () => {
  resetAlertWindow();
  records.length = 0;
  sent.length = 0;
  const before = footprint();
  for (const message of [tagged.a, tagged.b, tagged.b2]) {
    const r = await post(bounceEvent({ to: message.to, tags: message.tags }));
    assert.deepEqual(r, { status: 200, body: { ok: true } });
  }
  assert.deepEqual(
    records.map((a) => [a.event, a.companyId, a.cause, a.routedTo, a.count]),
    [
      ['delivery_undeliverable', A.id, 'recipient_permanent', 'operator', 0],
      ['delivery_undeliverable', B.id, 'recipient_permanent', 'operator', 0],
    ],
    "B's second bounce is folded into B's alert, never into A's",
  );
  assert.deepEqual(sent, records, 'the sink received exactly those records');
  assert.deepEqual(footprint(), before, 'no row, no audit row, no mail');
  assert.equal(JSON.stringify(records).includes('@'), false, 'no address in any alert');
});

test('AC-31 operator half (stack): the provider example shape, tagged as an invitation, is suppressed and operator only; NoEmail is undetermined', async () => {
  resetAlertWindow();
  records.length = 0;
  const before = footprint();
  assert.equal((await post(bounceEvent({ to: tagged.a.to, tags: tagged.a.tags, subType: 'Suppressed' }))).status, 200);
  assert.equal((await post(bounceEvent({ to: tagged.a.to, tags: tagged.a.tags, subType: 'NoEmail' }))).status, 200);
  assert.equal((await post(suppressedEvent({ to: tagged.a.to, tags: tagged.a.tags }))).status, 200);
  assert.deepEqual(
    records.map((a) => [a.companyId, a.cause, a.routedTo]),
    [
      [A.id, 'suppressed', 'operator'],
      [A.id, 'undetermined', 'operator'],
    ],
    'the email.suppressed event folds into the suppressed key of the same company',
  );
  assert.deepEqual(footprint(), before, 'no row, no audit row, no mail');
});

/* ---------------------------------------------------------------------------
   AC-11 and AC-16 on the stack
   --------------------------------------------------------------------------- */

test('AC-11 operator half (stack): the bounces of an operator alert and of a check-in are lines, never a mail', async () => {
  resetAlertWindow();
  records.length = 0;
  logged.length = 0;
  const before = footprint();
  for (const kind of ['enterprise-alert', 'enterprise-checkin'])
    assert.equal((await post(bounceEvent({ to: 'status@phaeacia.example.invalid', tags: { kind } }))).status, 200);
  assert.deepEqual(logged, [
    { event: 'operator_mail_undeliverable', cause: 'recipient_permanent' },
    { event: 'operator_mail_undeliverable', cause: 'recipient_permanent' },
  ]);
  assert.deepEqual(records, []);
  assert.deepEqual(footprint(), before);
});

test('AC-16 stack arm: a forged event (another secret) and an unsigned one are 401 with the refused line only; nothing written, nothing raised', async () => {
  resetAlertWindow();
  records.length = 0;
  logged.length = 0;
  const before = footprint();
  const forged = await post(bounceEvent({ to: tagged.a.to, tags: tagged.a.tags }), { secret: webhookSecret() });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.code, 'E_WEBHOOK_INVALID');
  const unsigned = await events(
    new Request('http://127.0.0.1/api/mail/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bounceEvent({ tags: tagged.a.tags })),
    }),
    { params: {} },
  );
  assert.equal(unsigned.status, 401);
  assert.deepEqual(logged, [
    { event: 'refused', code: 'E_WEBHOOK_INVALID', status: 401 },
    { event: 'refused', code: 'E_WEBHOOK_INVALID', status: 401 },
  ]);
  assert.deepEqual(records, []);
  assert.deepEqual(footprint(), before);
});
