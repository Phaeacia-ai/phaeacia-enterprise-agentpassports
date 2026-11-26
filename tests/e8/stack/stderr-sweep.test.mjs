/* E8-6's live half (docs/e8/design.md 2.3 row E8-6 and 2.4; evidence/e8-surface.md), against the running local
   stack: every route makeRoutes() declares, called through the real pipeline into the real services and the real
   database, with the hostile strings of tests/e8/fixtures/hostile-strings.mjs in the body, the query and the headers,
   by callers chosen to be refused; every line the route table's deps.log receives, every alert record the real
   alert() builds, and everything written to process.stderr meanwhile, searched for every string and every marker.

   WHERE THIS DEPARTS FROM THE MODULE MAP. Design 2.4 says this file takes its lines "through the dev shell's
   capture". The brief for day 5 says the real pipeline with deps.log captured, and that is what is built: the shell
   hands its own `log` to routeTable() and adds a static server, a catcher and a browser-shaped request path, none of
   which is between a route and its stderr line, and a shell here would be a second stack user for no line the
   route table does not already produce. Entered as D5-A3 in docs/e8/design.md's day-5 amendment block.

   THE ARMS, each a set of calls that must all be refused or be reads, so that the whole sweep writes nothing:
     A. no cookie, every route;
     B. a cookie made of the strings, every route (the verifier's refusal line);
     C. an entitled caller with the strings in the path's ids, every route that takes an id (404 before any read);
     D. a caller of another company, every route that carries a company-bearing id, with the strings in the body;
     E. the entitled administrator at aal2, every route that reads a body, with a body no route accepts: every key a
        route reads is present and holds all ten strings joined, which is no valid email, name, roles, date, code,
        number or reason, and the hostile strings are also KEYS of the body;
     F. the operator at aal2 on the operator routes, the same body;
     G. mail mode with no transport ready, the four delivery-bearing routes with a valid body (503
        E_MAIL_NOT_CONFIGURED before any write, and the one refusal that raises an alert);
     H. the entitled caller on every route while PostgREST and GoTrue fail at the transport with the strings in the
        thrown error's message, name and code (the `internal` line and its alert, which only a failure the service
        does not expect can reach; lib/db/user.mjs lets a thrown fetch through to the pipeline's boundary).
   Each arm runs inside tests/e8/helpers/no-write.mjs's noWrite(), with the content digest on the tables a hostile
   write would change in place (E8-9's contract; B12-R-F1's limit: counts alone cannot see an UPDATE).

   FAIL-BEFORE: arm H against the pipeline's `internal` line as it stood at 0ba9465, re-created in a copy of lib/ by
   tests/e8/helpers/mutant-lib.mjs, finds the strings in the lines. With ENTERPRISE_E8_MUTANT_UNCAUGHT=1 it fails
   for real, which is how evidence/e8-surface-repro/e8-6-stack-fail-before.log was made.

   THE STACK. This file reseeds once through tests/db/00-seed.sh and builds its own users and companies. Run alone:
   node --test --test-concurrency=1 tests/e8/stack/ */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { caller, passport } from '../../e3/stack/helpers.mjs';
import { e4world, e6routes, enableTargets, freshEmail, operators, published, reseed, reviewCompany } from '../../e6/stack/helpers.mjs';
import { HOSTILE, hostileIn, STRINGS } from '../fixtures/hostile-strings.mjs';
import { caughtAsync, mutantRoutes, removeMutants } from '../helpers/mutant-lib.mjs';
import { noWrite } from '../helpers/no-write.mjs';

after(() => removeMutants());

const ids = reseed();
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { ALERT_FIELDS, alert, resetAlertWindow, shapeFields } = await import('../../../lib/http/alerts.mjs');

assert.ok(
  process.env.ENTERPRISE_INVITATION_DELIVERY === undefined || process.env.ENTERPRISE_INVITATION_DELIVERY === '',
  'the sweep starts in handover mode; arm G sets mail mode for its own calls',
);
delete process.env.ENTERPRISE_ALERT_SINK;

/* ---------------------------------------------------------------------------------------------------
   The world: company A holds an object of every id class, company B is where the other company's caller lives.
   --------------------------------------------------------------------------------------------------- */
enableTargets();
const R = await e6routes([]);
const W = e4world('e8s', ids);
const OP = operators(ids);
const A = await reviewCompany(W, R, 'surface-a');
const B = await reviewCompany(W, R, 'surface-b');
const built = (label, answer, ...statuses) => {
  assert.ok(statuses.includes(answer.status), `${label}: ${answer.status} ${answer.raw}`);
  return answer.body;
};
const PUBLISHED = await published(R, A, 'claude-ai');
const DRAFT = built('A draft', await R.create(A.author, A.id, { name: `e8s-draft-${W.run}`, bytes: passport('draft') }), 201);
built('A download', await R.download(A.member, PUBLISHED.releaseId), 200, 201);
const REPORT = built('A report', await R.report(A.member, PUBLISHED.releaseId, { status: 'pass' }), 201).report;
const INVITATION = built('A invitation', await R.invite(A.adminHi, A.id, { email: freshEmail('surface'), roles: ['member'] }), 201);
const IDS = {
  companyId: A.id,
  membershipId: A.ms.member,
  invitationId: INVITATION.invitationId,
  groupId: A.groupId,
  candidateId: DRAFT.candidateId,
  releaseId: PUBLISHED.releaseId,
  reportId: REPORT.reportId,
  agentId: PUBLISHED.agentId,
  factorId: randomUUID(),
};

/* ---------------------------------------------------------------------------------------------------
   The sweep's own route table and its captures
   --------------------------------------------------------------------------------------------------- */
const lines = [];
const records = [];
const deps = {
  log: (entry) => lines.push(entry),
  alert: (event, fields, d) => alert(event, fields, { ...d, alertWrite: (r) => records.push(r), alertSink: undefined }),
};
const TABLE = makeRoutes(deps);
const NAMES = Object.keys(TABLE);
const call = caller(TABLE, COOKIES, makeRequest);

/* The strings where a request carries them: every one in the query, every one in a header (an in-process request
   takes a line break and an override, which a real one would refuse, so this is the harder case), and the request id
   a token-shaped one. */
const QUERY = Object.fromEntries(HOSTILE.map(([, s], i) => [`q${i}`, s]));
const HEADERS = {
  'x-synthetic-tenant': STRINGS.join(' | '),
  'user-agent': STRINGS[0],
  referer: `https://enterprise.example.invalid/members/?note=${STRINGS[1]}`,
  'x-nf-request-id': STRINGS[2],
};
const JOINED = STRINGS.join(' ');
/* Every key any route reads, each holding all ten strings joined, plus the strings as keys. */
const READ_KEYS = [
  'email', 'roles', 'expiresInDays', 'inviteCode', 'name', 'displayName', 'slug', 'firstAdminEmail', 'startsAt',
  'endsAt', 'invoiceRef', 'status', 'reason', 'reasonCode', 'confirmSlug', 'value', 'limit', 'toMembershipId',
  'membershipId', 'envelopeId', 'expectedVersion', 'target', 'targets', 'audience', 'groups', 'policyId', 'code',
  'tokenHash', 'token_hash', 'type', 'losses', 'note', 'decision', 'version', 'agentName', 'companyName', 'kind',
];
/* One string per key, rotating, so the whole body stays under MAX_BODY_BYTES and every route reaches its own
   validation instead of meeting 413 first; the oversized body is arm I's subject, on its own. The hostile strings
   are KEYS here too, so an unknown key cannot reach a line either.

   SEVEN KEYS ARE NOT LEFT TO THE ROTATION, because a rotation that handed a name or a display name a string the
   rule ADMITS would make that call a WRITE and not a refusal, which the first run of this sweep showed: the display
   name took the attribute payload, which lib/rules/profiles.mjs admits (it holds no control and no bidirectional
   character and is under 120 code points), and one profile row and one audit row were written inside noWrite. That
   is finding E8S-F3, and it belongs to E8-5: a display name a page must escape is a display name the service
   accepts. Here each of those keys takes a value its own rule refuses: the joined strings for the names, the slugs
   and the addresses (too long, and no address), the override for the display name, and the script element for
   every closed vocabulary. */
const REFUSED_VALUES = {
  displayName: STRINGS[8],
  name: JOINED,
  companyName: JOINED,
  email: JOINED,
  firstAdminEmail: JOINED,
  slug: JOINED,
  confirmSlug: JOINED,
  reason: STRINGS[4],
  reasonCode: STRINGS[4],
  status: STRINGS[4],
  type: STRINGS[4],
  kind: STRINGS[4],
  decision: STRINGS[4],
  target: STRINGS[4],
};
const HOSTILE_BODY = {
  ...Object.fromEntries(READ_KEYS.map((k, i) => [k, REFUSED_VALUES[k] ?? STRINGS[i % STRINGS.length]])),
  ...Object.fromEntries(STRINGS.map((s, i) => [s, STRINGS[(i + 1) % STRINGS.length]])),
  note: JOINED,
};
/* Over MAX_BODY_BYTES (16 KiB, lib/http/request.mjs), carrying the strings: the 413 arm. */
const OVERSIZED = { note: JOINED.repeat(60) };
const bodyFor = (name) => {
  const mode = TABLE[name].route.body;
  if (mode === 'none') return undefined;
  if (mode === 'passport') return Buffer.from(STRINGS.join('\n'), 'utf8');
  return HOSTILE_BODY;
};
const withIds = (name, pick) => {
  const params = {};
  for (const [, p] of TABLE[name].route.path.matchAll(/:([A-Za-z]+)/g)) params[p] = pick(p);
  return params;
};
const hasIds = (name) => /:[A-Za-z]+/.test(TABLE[name].route.path);
const COMPANY_BEARING = /:(companyId|candidateId|releaseId|agentId|reportId|invitationId|groupId|membershipId)\b/;
/* The self and sign-in routes a caller of another company is not "of another company" for: their subject is the
   caller. They get arms A, B, C and E, and not D (factorsEnroll by any signed-in caller would enrol a factor). */
const SELF = new Set(['authStart', 'authVerify', 'authRefresh', 'authSignout', 'me', 'meDisplayName', 'gateRead', 'invitationsAccept', 'factorsList', 'factorsEnroll', 'factorsVerify', 'factorsRemove']);
const OPERATOR = NAMES.filter((n) => n.startsWith('operator'));

/* Everything the process writes to stderr while an arm runs, kept rather than printed. */
async function stderrOf(block) {
  const written = [];
  const real = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    const done = rest.at(-1);
    if (typeof done === 'function') done();
    return true;
  };
  try {
    return { value: await block(), written };
  } finally {
    process.stderr.write = real;
  }
}

/* The tables a hostile write would change in place; counts cover every other table (no-write.mjs). */
const CONTENT = ['companies', 'profiles', 'memberships', 'invitations', 'groups', 'agents', 'releases', 'candidate_versions'];

const answered = [];
const called = new Map();
async function arm(label, calls) {
  const { written } = await stderrOf(() =>
    noWrite(
      `arm ${label}`,
      async () => {
        for (const [name, options] of calls) {
          resetAlertWindow();
          const r = await call(name, { query: QUERY, ...options, headers: { ...HEADERS, ...(options.headers ?? {}) } });
          answered.push({ arm: label, name, status: r.status, code: r.body?.code ?? null, raw: r.raw });
          called.set(label, (called.get(label) ?? new Set()).add(name));
        }
      },
      { content: CONTENT },
    ),
  );
  return written;
}

const stderrWritten = [];
const armCall = (name, user, extra = {}) => [name, { user, ...extra }];

test('E8-6 live, arms A to G: every route, refused with the strings in body, query and headers, writes nothing and logs none of them', async () => {
  const garbage = { cookie: `${COOKIES.access}=${STRINGS.join('.')}; ${COOKIES.refresh}=${STRINGS[2]}` };
  stderrWritten.push(...(await arm('A', NAMES.map((n) => [n, { params: withIds(n, (p) => IDS[p]), body: bodyFor(n) }]))));
  stderrWritten.push(...(await arm('B', NAMES.map((n) => [n, { params: withIds(n, (p) => IDS[p]), body: bodyFor(n), headers: garbage }]))));
  stderrWritten.push(
    ...(await arm(
      'C',
      NAMES.filter(hasIds).map((n) => armCall(n, A.adminHi, { params: withIds(n, (p) => HOSTILE[Object.keys(IDS).indexOf(p) % HOSTILE.length][1]), body: bodyFor(n) })),
    )),
  );
  stderrWritten.push(
    ...(await arm(
      'D',
      NAMES.filter((n) => COMPANY_BEARING.test(TABLE[n].route.path) && !SELF.has(n)).flatMap((n) => [
        armCall(n, B.member, { params: withIds(n, (p) => IDS[p]), body: bodyFor(n) }),
        armCall(n, B.adminHi, { params: withIds(n, (p) => IDS[p]), body: bodyFor(n) }),
      ]),
    )),
  );
  const idem = () => ({ 'idempotency-key': randomUUID() });
  stderrWritten.push(
    ...(await arm(
      'E',
      NAMES.filter((n) => TABLE[n].route.body !== 'none' && !OPERATOR.includes(n)).map((n) =>
        armCall(n, A.adminHi, { params: withIds(n, (p) => IDS[p]), body: bodyFor(n), headers: idem() }),
      ),
    )),
  );
  stderrWritten.push(
    ...(await arm('F', OPERATOR.map((n) => armCall(n, OP.aal2, { params: withIds(n, (p) => IDS[p]), body: bodyFor(n), headers: idem() })))),
  );
  /* Arm I: a body over the bound, carrying the strings, on every route that reads one. */
  stderrWritten.push(
    ...(await arm(
      'I',
      NAMES.filter((n) => TABLE[n].route.body === 'json').map((n) =>
        armCall(n, A.adminHi, { params: withIds(n, (p) => IDS[p]), body: OVERSIZED, headers: idem() }),
      ),
    )),
  );
  process.env.ENTERPRISE_INVITATION_DELIVERY = 'mail';
  try {
    const valid = { email: freshEmail('surface-mail'), roles: ['member'] };
    stderrWritten.push(
      ...(await arm('G', [
        armCall('invitationsCreate', A.adminHi, { params: { companyId: A.id }, body: valid }),
        armCall('invitationsResend', A.adminHi, { params: { companyId: A.id, invitationId: IDS.invitationId } }),
        armCall('operatorAdminInvitation', OP.aal2, { params: { companyId: A.id }, body: { email: freshEmail('surface-op'), expiresInDays: 7 } }),
        armCall('operatorCompanyCreate', OP.aal2, { body: { slug: `e8s-mail-${W.run}`, name: 'Surface Mail', firstAdminEmail: freshEmail('surface-new') } }),
      ])),
    );
  } finally {
    delete process.env.ENTERPRISE_INVITATION_DELIVERY;
  }

  /* Every route in arms A and B; every id-taking route in C; the arms that were meant to meet the delivery check did. */
  assert.deepEqual([...called.get('A')].sort(), [...NAMES].sort());
  assert.deepEqual([...called.get('B')].sort(), [...NAMES].sort());
  assert.deepEqual([...called.get('C')].sort(), NAMES.filter(hasIds).sort());
  for (const r of answered.filter((x) => x.arm === 'I'))
    assert.deepEqual([r.status, r.code], [413, 'E_BODY_TOO_LARGE'], `${r.name} with a body over the bound`);
  for (const r of answered.filter((x) => x.arm === 'G'))
    assert.deepEqual([r.status, r.code], [503, 'E_MAIL_NOT_CONFIGURED'], `${r.name} in mail mode with no transport`);
  /* Arms A and B: the session refusal, before anything else, for every route that requires one. */
  for (const r of answered.filter((x) => (x.arm === 'A' || x.arm === 'B') && TABLE[x.name].route.session === 'required'))
    assert.deepEqual([r.status, r.code], [401, 'E_UNAUTHENTICATED'], `${r.arm} ${r.name}`);
});

test('E8-6 live, arm H: every route with PostgREST and GoTrue failing at the transport writes shaped internal lines only', async () => {
  const realFetch = globalThis.fetch;
  const base = process.env.SUPABASE_URL;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith(base)) {
      const e = new Error(`connect failed: ${JOINED}`);
      e.name = STRINGS[2];
      e.code = STRINGS[3];
      e.details = STRINGS[0];
      e.hint = STRINGS[1];
      throw e;
    }
    return realFetch(input, init);
  };
  try {
    stderrWritten.push(
      ...(await arm(
        'H',
        NAMES.map((n) => armCall(n, SELF.has(n) || !OPERATOR.includes(n) ? A.adminHi : OP.aal2, { params: withIds(n, (p) => IDS[p]), body: undefined })),
      )),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual([...called.get('H')].sort(), [...NAMES].sort());
  const internals = answered.filter((r) => r.arm === 'H' && r.status === 500);
  assert.ok(internals.length >= 20, `${internals.length} routes reached the transport and answered 500`);
});

/** The problems with the sweep's lines, records and stderr, the same rule the unit half applies. */
function sweepProblems(allLines, allRecords, written) {
  const problems = [];
  const found = hostileIn(JSON.stringify({ allLines, allRecords, written }));
  if (found.length) problems.push(`hostile strings: ${found.join(', ')}`);
  const declared = { gotrue_refused: ['gotrueStatus', 'gotrueErrorCode'] };
  for (const line of allLines) {
    const { event, ...rest } = line;
    const own = Object.fromEntries(Object.entries(rest).filter(([k]) => !(declared[event] ?? []).includes(k)));
    for (const k of Object.keys(own)) if (!Object.hasOwn(ALERT_FIELDS, k)) problems.push(`${event}: ${k} is not allowlisted`);
    if (JSON.stringify(shapeFields(own)) !== JSON.stringify(own)) problems.push(`${event}: not its own shaped form ${JSON.stringify(own)}`);
  }
  for (const r of allRecords) {
    const { event, v, at, count, ...rest } = r;
    if (JSON.stringify(shapeFields(rest)) !== JSON.stringify(rest)) problems.push(`alert ${event}: not shaped ${JSON.stringify(rest)}`);
  }
  return problems;
}

test('E8-6 live: no line, no alert record and nothing written to stderr carries a string, and every line is shaped', (t) => {
  assert.deepEqual(sweepProblems(lines, records, stderrWritten), []);
  assert.deepEqual(stderrWritten, [], 'the sweep wrote nothing to stderr outside its captures');
  const events = {};
  for (const l of lines) events[l.event] = (events[l.event] ?? 0) + 1;
  const alertEvents = {};
  for (const r of records) alertEvents[r.event] = (alertEvents[r.event] ?? 0) + 1;
  const codes = {};
  for (const r of answered) codes[`${r.status} ${r.code}`] = (codes[`${r.status} ${r.code}`] ?? 0) + 1;
  for (const r of answered) assert.deepEqual(hostileIn(r.raw ?? ''), [], `${r.arm} ${r.name}: the answer echoes a string`);
  t.diagnostic(`calls ${answered.length}; routes ${NAMES.length}; lines ${lines.length} ${JSON.stringify(events)}; alerts ${records.length} ${JSON.stringify(alertEvents)}`);
  t.diagnostic(`answers ${JSON.stringify(Object.fromEntries(Object.entries(codes).sort()))}`);
  /* The sweep must have reached every line kind a route can write, or it proves less than it says. */
  for (const e of ['session_refused', 'refused', 'internal']) assert.ok(events[e] > 0, `no ${e} line was provoked`);
  for (const e of ['mail_not_configured', 'internal']) assert.ok(alertEvents[e] > 0, `no ${e} alert was provoked`);
});

test('E8-6 live fail-before: arm H against the internal line of 0ba9465, re-created, finds the strings', async () => {
  const mlines = [];
  const mrecords = [];
  const { table } = await mutantRoutes(
    'e8-6-live-0ba9465',
    [
      [
        'lib/http/pipeline.mjs',
        [
          [
            "log({ event: 'internal', ...shapeFields({ errorName: e?.name ?? 'Error', code: e?.code, requestId }) });",
            "log({ event: 'internal', name: e?.name ?? 'Error', code: typeof e?.code === 'string' ? e.code : undefined });",
          ],
        ],
      ],
    ],
    {
      log: (entry) => mlines.push(entry),
      alert: (event, fields, d) => alert(event, fields, { ...d, alertWrite: (r) => mrecords.push(r), alertSink: undefined }),
    },
  );
  const mcall = caller(table, COOKIES, makeRequest);
  const realFetch = globalThis.fetch;
  const base = process.env.SUPABASE_URL;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith(base)) {
      const e = new Error(`connect failed: ${JOINED}`);
      e.name = STRINGS[2];
      e.code = STRINGS[3];
      throw e;
    }
    return realFetch(input, init);
  };
  try {
    for (const n of ['membersList', 'releasesRead', 'catalogRead', 'reviewQueue'])
      await mcall(n, { user: A.adminHi, params: withIds(n, (p) => IDS[p]), query: QUERY, headers: HEADERS });
  } finally {
    globalThis.fetch = realFetch;
  }
  const failure = await caughtAsync('E8-6 live on the 0ba9465 line', async () => assert.deepEqual(sweepProblems(mlines, mrecords, []), []));
  assert.match(String(failure.message), /hostile strings: token-shaped, agent name/);
  assert.match(String(failure.message), /internal: name is not allowlisted/);
});
