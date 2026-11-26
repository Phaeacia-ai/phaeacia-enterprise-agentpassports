#!/usr/bin/env node
/* Section 6 C9 and C10: what the transport and the alert sink add to a request.
 *
 *   node tests/e7/measure/c9-c10-latency.mjs --label <label>
 *
 * C9  25 invitations in a row, the shape of one onboarding, against the local mail catcher, and the same 25 in
 *     `handover` mode. What is recorded is the per-invitation latency of each mode and the difference, which is
 *     what the transport costs. It is NOT a statement about the provider: the catcher answers on loopback in
 *     under a millisecond, and the plan's onboarding burst against a real provider's rate limit is H-A10's.
 * C10 a failing route with a sink that never answers, so `alert()` meets its 1.5 s bound. The design's figure is
 *     "the response's added latency is at most the 1.5 s timeout"; it is RECORDED here against a run with the
 *     sink at `none`, and the `alert_dropped` line is read from the same run.
 *
 * Nothing here is a gate. Run alone on a reseeded stack.
 */
import { seed as seedStack } from '../../e2/helpers/stack.mjs';
import { caller } from '../../e3/stack/helpers.mjs';
import { e4world, e6routes, freshEmail, futurePeriod, operators, reviewCompany } from '../../e6/stack/helpers.mjs';
import { startCatcher } from '../mail-catcher.mjs';
import { record } from './helpers.mjs';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const label = arg('--label');
if (label === null || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(label)) {
  process.stderr.write('usage: node tests/e7/measure/c9-c10-latency.mjs --label LABEL\n');
  process.exit(2);
}
const COUNT = Number.parseInt(arg('--invitations', '25'), 10);

const ids = seedStack();
const SEED = { label, commands: ['bash tests/db/00-seed.sh'] };

const catcher = await startCatcher();
const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { mailTransport } = await import('../../../lib/services/mail.mjs');
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const alerts = [];
const logged = [];
const mailEnv = catcher.env();
const table = makeRoutes({
  mail: mailTransport(mailEnv),
  alert: async (...a) => alerts.push(a),
  log: (e) => logged.push(e),
});
const call = caller(table, COOKIES, makeRequest);

/* The world: TWO companies, one per mode. Both modes in one company would put fifty pending invitations against
   app.limit_pending_invitations(), which is fifty, and a refusal at the last one would be measured as a latency. */
const R = await e6routes(logged);
const OP = operators(ids);
const W = e4world(`e7-measure-${label}`, ids);
const A = await reviewCompany(W, R, 'a');
const B = await reviewCompany(W, R, 'b');
futurePeriod(A.id);
futurePeriod(B.id);
/* Twenty-five invitations is the design's number, "one onboarding", and reviewCompany has already used five of
   the twenty-five seats app.limit_members_per_company() allows, so the twenty-first invitation is refused
   E_SEATS_EXHAUSTED: a pending invitation holds a seat. The seat quota is raised through the operator's own
   route, which is what an operator would do for a larger customer, rather than owner-side. */
for (const C of [A, B]) {
  const q = await R.companyQuota(OP.aal2, C.id, { name: 'members_per_company', value: 60 });
  if (q.status !== 200) throw new Error(`raising the seat quota: ${q.status} ${JSON.stringify(q.body).slice(0, 200)}`);
  const p = await R.companyQuota(OP.aal2, C.id, { name: 'pending_invitations_per_company', value: 60 });
  if (p.status !== 200) throw new Error(`raising the invitation quota: ${p.status} ${JSON.stringify(p.body).slice(0, 200)}`);
}

const percentile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const summarise = (xs) => ({
  n: xs.length,
  minMs: Number(Math.min(...xs).toFixed(1)),
  medianMs: Number(percentile(xs, 50).toFixed(1)),
  p95Ms: Number(percentile(xs, 95).toFixed(1)),
  maxMs: Number(Math.max(...xs).toFixed(1)),
  meanMs: Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)),
});

/** One invitation through the members route, timed. Returns the latency and the answer's delivery value. */
async function invite(mode, C) {
  process.env.ENTERPRISE_INVITATION_DELIVERY = mode;
  const email = freshEmail(`e7m-${label}`);
  const t0 = process.hrtime.bigint();
  const res = await call('invitationsCreate', {
    user: C.adminHi,
    params: { companyId: C.id },
    body: { email, roles: ['member'] },
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (res.status !== 201) throw new Error(`invitation answered ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  return { ms, status: res.status, delivery: res.body?.delivery ?? null };
}

/* -------------------------------------------------------------- C9 */
const handover = [];
for (let i = 0; i < COUNT; i++) handover.push(await invite('handover', A));
const mail = [];
for (let i = 0; i < COUNT; i++) mail.push(await invite('mail', B));
process.env.ENTERPRISE_INVITATION_DELIVERY = 'handover';

const handoverMs = handover.map((r) => r.ms);
const mailMs = mail.map((r) => r.ms);
record('C9-transport-latency', {
  condition: `${COUNT} invitations in a row in mail mode against the local catcher, and the same number in handover mode, one company each`,
  numbers: {
    handover: summarise(handoverMs),
    mail: summarise(mailMs),
    addedPerInvitationMedianMs: Number((percentile(mailMs, 50) - percentile(handoverMs, 50)).toFixed(1)),
    addedPerInvitationMeanMs: Number(
      (mailMs.reduce((a, b) => a + b, 0) / mailMs.length - handoverMs.reduce((a, b) => a + b, 0) / handoverMs.length).toFixed(1),
    ),
    catcherMessages: catcher.messages.length,
    seatQuotaRaisedTo: 60,
    deliveryValues: [...new Set(mail.map((r) => r.delivery))],
    statuses: [...new Set([...mail, ...handover].map((r) => r.status))],
  },
  seed: SEED,
  command: 'POST /api/companies/:companyId/invitations through lib/http/routes.mjs, with ENTERPRISE_INVITATION_DELIVERY set per call',
  notes: [
    'The catcher answers on loopback in well under a millisecond. This number is the transport, the templates and GoTrue’s link issuance; it says NOTHING about a real provider.',
    "The plan's onboarding burst against the provider's documented rate limit is a hosted observation (H-A10).",
    'Both modes write the same row; only the answer and the send differ.',
    'The seat and pending-invitation quotas were raised to 60 through the operator route first: a pending invitation holds a seat, and reviewCompany had already used five of the twenty-five the plan\u2019s envelope allows.',
  ],
});

/* -------------------------------------------------------------- C10 */
/* A route that fails, with the sink at its bound. The pipeline builds the alert through lib/http/alerts.mjs, whose
   send is awaited under SEND_BOUND_MS; a sink that never answers is what makes the bound the thing measured. */
const { alert, resetAlertWindow, SEND_BOUND_MS } = await import('../../../lib/http/alerts.mjs');

const never = () => new Promise(() => {});
const lines = [];
const deps = { alertWrite: (s) => lines.push(s) };
/* The no-sink arm has to be the module's own `none`, not an absent dependency: alert() falls back to
   alertSink(process.env) whenever deps.alertSink is not a function, so an unset value would make the arm depend
   on whatever the shell happened to carry. */
process.env.ENTERPRISE_ALERT_SINK = 'none';

const fastMs = [];
const slowMs = [];
for (let i = 0; i < 5; i++) {
  resetAlertWindow();
  const t0 = process.hrtime.bigint();
  await alert('internal', { route: 'catalogRead', code: 'E_INTERNAL', status: 500 }, { ...deps, alertSink: null });
  fastMs.push(Number(process.hrtime.bigint() - t0) / 1e6);

  resetAlertWindow();
  const t1 = process.hrtime.bigint();
  await alert('internal', { route: 'catalogRead', code: 'E_INTERNAL', status: 500 }, { ...deps, alertSink: never });
  slowMs.push(Number(process.hrtime.bigint() - t1) / 1e6);
}
/* writeLine hands deps.alertWrite the OBJECT, not a string, so the capture matches on the event and not on
   text: the first version of this probe stringified it, read "[object Object]" and counted zero. */
const dropped = lines.filter((l) => l?.event === 'alert_dropped').length;
const records = lines.filter((l) => l?.event === 'internal').length;
record('C10-alert-path-latency', {
  condition: 'one failing route’s alert with a sink that never answers, against the same alert with no sink at all',
  numbers: {
    sendBoundMs: SEND_BOUND_MS,
    noSink: summarise(fastMs),
    sinkThatNeverAnswers: summarise(slowMs),
    addedMedianMs: Number((percentile(slowMs, 50) - percentile(fastMs, 50)).toFixed(1)),
    alertDroppedLines: dropped,
    alertRecordLines: records,
    capturedLines: lines.length,
    alertsRaised: 5 + 5,
  },
  seed: SEED,
  command: "alert('internal', { route, code, status }, { alertSink }) from lib/http/alerts.mjs, five runs of each",
  notes: [
    'The design’s figure is that the response’s added latency is at most the 1.5 s timeout. RECORDED against sendBoundMs, asserted nowhere.',
    'alertDroppedLines is the count of {"event":"alert_dropped"} records the bounded sends left (E7M-C-F1): one per run whose sink did not answer, and none for the runs with no sink at all.',
    'alertRecordLines is the alert record itself, which alert() writes ALWAYS and FIRST, so the function log holds the fault even when the sink fails.',
    'This measures alert() itself, which is where the bound lives, so the number is the same whichever of the 57 routes raises it.',
  ],
});

catcher.close();
process.stdout.write('c9-c10: done.\n');
