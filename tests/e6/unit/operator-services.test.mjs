/* The operator surface, the three company-facing services and the account sweep, without a stack (E6 design 1.1,
   1.3, 1.4, 1.5, 1.6, 1.7, 3.4 and 3.5). What each service sends, the snake_case to camelCase mapping named key
   for key against design 3.4's own lists, the refusals made before any call, the lead's two decisions on the
   database lane's questions, and the two tripwires design 1.1 asks for by name.

   The key-set assertions are the substance, not decoration: camelKeys maps by rule, so a key the database adds
   later would arrive in an answer unnoticed, and these lists are what notices it. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { hs256, userClaims } from '../../e2/helpers/jwt.mjs';
import { AGENT, COMPANY, MEMBERSHIP, OTHER_MEMBERSHIP, fakeDb, refusal, session } from '../../e3/unit/fake-postgrest.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.ENTERPRISE_ORIGIN = 'https://enterprise.example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'example-service-role-key-never-logged';

const operator = await import('../../../lib/services/operator.mjs');
const agents = await import('../../../lib/services/agents.mjs');
const quotas = await import('../../../lib/services/quotas.mjs');
const lifecycle = await import('../../../lib/services/lifecycle.mjs');
const takeout = await import('../../../lib/services/takeout.mjs');
const { sweepAccounts, RECORD_BATCH } = await import('../../../lib/operator/accounts.mjs');
const { QUOTA_NAMES } = await import('../../../lib/rules/quotas.mjs');

const M = readFileSync(join(REPO, 'supabase/migrations/008_lifecycle.sql'), 'utf8');
const OTHER_COMPANY = 'bbbbbbbb-1111-4222-8333-444444444444';
/* E6S-C-F5: the quota read tests the assurance level itself, after standing and the role, so its cases need a
   session at aal2. The shared `session` of the double carries no aal claim, which lib/session.mjs reads as aal1,
   and that is exactly the caller the refusal case below uses. Built the way tests/e2/unit/pages-services.test.mjs
   builds one, from the same helpers and the same secret. */
const aal2Session = await (async () => {
  const { BASE, COOKIES, SUB } = await import('../../e3/unit/fake-postgrest.mjs');
  const { verifySession } = await import('../../../lib/session.mjs');
  /* The double sets the secret lib/session.mjs reads when it is imported, which every test file here does first;
     it is read back from the environment rather than copied, so the two cannot drift. */
  const token = hs256(
    userClaims({ sub: SUB, email: 's@example.invalid', issuer: `${BASE}/auth/v1`, aal: 'aal2' }),
    process.env.SUPABASE_JWT_SECRET,
  );
  const s = (await verifySession({ headers: { cookie: `${COOKIES.access}=${token}` } })).session;
  if (!s) throw new Error('the aal2 unit session did not verify');
  return s;
})();
const USER = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11';
const PERIOD = { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-11-26T00:00:00.000Z' };

/* One company row exactly as app.operator_company_row builds it: identity, dates, quota values and COUNTS. */
const COUNT_KEYS = Object.freeze([
  'memberships_active',
  'memberships_removed',
  'admins',
  'invitations_pending',
  'invitations_accepted',
  'groups',
  'agents_active',
  'agents_orphaned',
  'agents_archived',
  'candidates_draft',
  'candidates_submitted',
  'candidates_approved',
  'candidates_changes_requested',
  'candidates_superseded',
  'envelopes',
  'reviews',
  'releases_published',
  'releases_withdrawn',
  'downloads',
  'reports',
  'witnesses',
  'audit_rows',
  'content_bytes',
  'assembled_bytes',
]);
const companyRow = (over = {}) => ({
  company_id: COMPANY,
  slug: 'acme',
  name: 'Acme AG',
  status: 'active',
  created_at: '2026-10-01T08:00:00.000000+00:00',
  access_period: {
    invoice_ref: 'INV-2026-014',
    starts_at: PERIOD.startsAt,
    ends_at: PERIOD.endsAt,
    export_by: '2026-12-10T00:00:00.000Z',
    delete_by: '2027-01-09T00:00:00.000Z',
    state: 'current',
    deletion_state: 'not_eligible',
  },
  quotas: QUOTA_NAMES.map((name) => ({ name, value: 25, used: 3, source: 'default' })),
  counts: Object.fromEntries(COUNT_KEYS.map((k, i) => [k, i])),
  ...over,
});

/** A double whose rpc answers per routine name, plus the standing read every company-scoped service makes. */
function db({ rpc, tables = {}, roles = ['company_admin', 'member'] } = {}) {
  return fakeDb({
    tables: { memberships: [{ id: MEMBERSHIP, roles, status: 'active' }], ...tables },
    rpc: (name, body, claims) => rpc(name, body, claims),
  });
}

/* A double whose RPC answers a POSTGREST REFUSAL rather than a row, so the service meets the AppError
   lib/errors.mjs's fromPostgrest builds and not a thrown fixture. `decide` returns a code or null per call. */
function refusingDb({ decide, ok, tables = {}, roles = ['company_admin', 'member'] }) {
  const inner = fakeDb({ tables: { memberships: [{ id: MEMBERSHIP, roles, status: 'active' }], ...tables } });
  const calls = inner.calls;
  const fetchImpl = async (url, init) => {
    if (init?.method !== 'POST') return inner.fetchImpl(url, init);
    const name = String(url).split('/').pop();
    const body = JSON.parse(init.body);
    calls.push({ rpc: name, body });
    const code = decide(name, body);
    if (code === null) return { status: 200, json: async () => ok(name, body) };
    const sqlstate = code === 'E_NOT_FOUND' ? 'P0002' : 'P0001';
    const status = code === 'E_NOT_FOUND' ? 404 : 409;
    return { status, json: async () => ({ code: sqlstate, details: null, hint: null, message: code }) };
  };
  return { calls, options: { fetchImpl } };
}

/* ---------------------------------------------------------------------------
   design 1.1 and 3.4: the register
   --------------------------------------------------------------------------- */

test('design 3.4: the register answers camelCase, key for key, and every count name is design 3.4 s own', async () => {
  const d = db({
    rpc: () => ({ companies: [companyRow()], sweepable_accounts: 3, next_cursor: null }),
  });
  const r = await operator.readRegister(session, {}, d.options);
  assert.deepEqual(Object.keys(r).sort(), ['companies', 'cursorReset', 'nextCursor', 'sweepableAccounts']);
  assert.deepEqual(r.companies[0].accessPeriod, {
    invoiceRef: 'INV-2026-014',
    startsAt: PERIOD.startsAt,
    endsAt: PERIOD.endsAt,
    exportBy: '2026-12-10T00:00:00.000Z',
    deleteBy: '2027-01-09T00:00:00.000Z',
    state: 'current',
    deletionState: 'not_eligible',
  });
  assert.deepEqual(Object.keys(r.companies[0]).sort(), [
    'accessPeriod',
    'companyId',
    'counts',
    'createdAt',
    'name',
    'quotas',
    'slug',
    'status',
  ]);
  assert.deepEqual(Object.keys(r.companies[0].counts), [
    'membershipsActive',
    'membershipsRemoved',
    'admins',
    'invitationsPending',
    'invitationsAccepted',
    'groups',
    'agentsActive',
    'agentsOrphaned',
    'agentsArchived',
    'candidatesDraft',
    'candidatesSubmitted',
    'candidatesApproved',
    'candidatesChangesRequested',
    'candidatesSuperseded',
    'envelopes',
    'reviews',
    'releasesPublished',
    'releasesWithdrawn',
    'downloads',
    'reports',
    'witnesses',
    'auditRows',
    'contentBytes',
    'assembledBytes',
  ]);
  assert.deepEqual(Object.keys(r.companies[0].quotas[0]).sort(), ['name', 'source', 'used', 'value']);
  assert.equal(r.sweepableAccounts, 3);
  assert.equal(r.cursorReset, false);
  assert.deepEqual(d.calls.find((c) => c.rpc).body, { p_cursor: null, p_limit: 50 });
});

test("the lead's decision (b): an unknown cursor drops the cursor, re-reads the first page ONCE and says so", async () => {
  const d = refusingDb({
    decide: (_name, body) => (body.p_cursor === null ? null : 'E_NOT_FOUND'),
    ok: () => ({ companies: [companyRow()], sweepable_accounts: 0, next_cursor: null }),
  });
  const r = await operator.readRegister(session, { cursor: OTHER_COMPANY }, d.options);
  assert.equal(r.cursorReset, true, 'the page is told the list moved rather than shown a not-found');
  assert.equal(r.companies.length, 1);
  assert.deepEqual(
    d.calls.filter((c) => c.rpc).map((c) => c.body.p_cursor),
    [OTHER_COMPANY, null],
    'once with the cursor, once without it',
  );
});

test("the lead's decision (b): a SECOND failure is surfaced and never retried again", async () => {
  const d = refusingDb({ decide: () => 'E_NOT_FOUND', ok: () => ({}) });
  await assert.rejects(operator.readRegister(session, { cursor: OTHER_COMPANY }, d.options), refusal('E_NOT_FOUND'));
  assert.equal(d.calls.filter((c) => c.rpc).length, 2, 'exactly two attempts, never a third');
  /* Without a cursor there is nothing to drop, so a not-found is the answer at once. */
  const bare = refusingDb({ decide: () => 'E_NOT_FOUND', ok: () => ({}) });
  await assert.rejects(operator.readRegister(session, {}, bare.options), refusal('E_NOT_FOUND'));
  assert.equal(bare.calls.filter((c) => c.rpc).length, 1);
});

test("the lead's decision (b): a refusal that is NOT the cursor's is surfaced at once, with no retry", async () => {
  const d = refusingDb({ decide: () => 'E_OPERATOR_MFA_REQUIRED', ok: () => ({}) });
  await assert.rejects(
    operator.readRegister(session, { cursor: OTHER_COMPANY }, d.options),
    (e) => e.code === 'E_INTERNAL' || e.code === 'E_OPERATOR_MFA_REQUIRED',
  );
  assert.equal(d.calls.filter((c) => c.rpc).length, 1, 'only a not-found is a cursor that moved');
});

test('the register refuses a malformed cursor or limit before any call', async () => {
  for (const args of [{ cursor: 'not-a-uuid' }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }]) {
    const d = db({ rpc: () => ({}) });
    await assert.rejects(operator.readRegister(session, args, d.options), refusal('E_BODY_INVALID'));
    assert.deepEqual(d.calls, []);
  }
});

/* ---------------------------------------------------------------------------
   design 1.1: the operator never receives tenant content
   --------------------------------------------------------------------------- */

const CONTENT_FIELDS = Object.freeze([
  'agentName',
  'groupName',
  'candidateTitle',
  'content',
  'derivedCanonical',
  'email',
  'emailNormalized',
  'displayName',
  'reason',
  'losses',
  'assistance',
  'note',
  'assembledContent',
  'envelopeCanonical',
  'text',
]);

const deepKeys = (value, out = new Set()) => {
  if (Array.isArray(value)) for (const v of value) deepKeys(v, out);
  else if (value !== null && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      deepKeys(v, out);
    }
  return out;
};

test('TRIPWIRE, design 1.1: no operator answer of this lane carries a content field, and the manifest is counts only', async () => {
  const manifestSections = [
    'access_periods',
    'company_quotas',
    'memberships',
    'invitations',
    'profiles',
    'groups',
    'group_members',
    'agents',
    'candidate_versions',
    'candidate_contributors',
    'review_envelopes',
    'reviews',
    'releases',
    'release_downloads',
    'installation_reports',
    'installation_witnesses',
    'audit_events',
    'release_targets',
    'installer_texts',
    'release_policies',
    'gate_identities',
  ];
  const manifestRow = companyRow({
    export_manifest: {
      sections: Object.fromEntries(manifestSections.map((s, i) => [s, i])),
      content_bytes: 4194304,
      assembled_bytes: 3670016,
      estimated_serialized_bytes: 16121856,
      route_ceiling_bytes: 4194304,
      over_route_ceiling: true,
    },
  });
  const answers = [
    await operator.readRegister(
      session,
      {},
      db({ rpc: () => ({ companies: [companyRow()], sweepable_accounts: 0, next_cursor: null }) }).options,
    ),
    await operator.readExportManifest(session, { companyId: COMPANY }, db({ rpc: () => manifestRow }).options),
    await operator.runExpiry(
      session,
      {},
      db({
        rpc: () => ({
          suspended: [{ company_id: COMPANY, slug: 'acme', export_by: PERIOD.endsAt }],
          due_for_deletion: [
            { company_id: COMPANY, slug: 'acme', delete_by: PERIOD.endsAt, deletion_state: 'overdue' },
          ],
          remaining: 0,
          remaining_due: 0,
          counts: { eligible: 4, due: 1, overdue: 2 },
        }),
      }).options,
    ),
    await operator.deleteCompany(
      session,
      { companyId: COMPANY, confirmSlug: 'acme', reasonCode: 'customer_instruction' },
      db({
        rpc: () => [
          {
            company_id: COMPANY,
            deleted: { memberships: 27, audit_events: 640, companies: 1, orphaned_user_ids: [USER] },
          },
        ],
      }).options,
    ),
  ];
  for (const answer of answers) {
    const keys = deepKeys(answer);
    for (const field of CONTENT_FIELDS) assert.equal(keys.has(field), false, `${field} in an operator answer`);
  }
  const manifest = answers[1].exportManifest;
  assert.equal(Object.values(manifest.sections).every((n) => Number.isInteger(n)), true, 'counts only, no rows');
  assert.equal(manifest.overRouteCeiling, true);
  assert.deepEqual(Object.keys(manifest).sort(), [
    'assembledBytes',
    'contentBytes',
    'estimatedSerializedBytes',
    'overRouteCeiling',
    'routeCeilingBytes',
    'sections',
  ]);
  assert.deepEqual(Object.keys(answers[2]).sort(), [
    'counts',
    'dueForDeletion',
    'remaining',
    'remainingDue',
    'suspended',
  ]);
  /* design 3.4 puts the accounts BESIDE the section counts and not inside them: an account is not a section of
     the company, and a page renders the two in different places. */
  assert.deepEqual(Object.keys(answers[3]).sort(), ['companyId', 'deleted', 'orphanedUserIds']);
  assert.deepEqual(answers[3].orphanedUserIds, [USER]);
  assert.equal('orphanedUserIds' in answers[3].deleted, false);
});

test('TRIPWIRE, design 1.1: the operator service names no tenant content column in its own source', () => {
  const src = readFileSync(join(REPO, 'lib/services/operator.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  for (const view of ['candidate_versions', 'release_downloads', 'installation_reports', 'agents', 'groups'])
    assert.equal(code.includes(view), false, `the operator service reads ${view}`);
  /* It holds the server client and calls routines; it makes no user-client read at all, which is why no RLS
     predicate has to be trusted for the boundary. */
  assert.equal(/from '\.\.\/db\/user\.mjs'/.test(code), false, 'no user client');
});

/* ---------------------------------------------------------------------------
   design 1.1, 1.5 and 1.6: the operator writes
   --------------------------------------------------------------------------- */

test('design 3.4: createCompany sends the period and answers the derived dates with the link once', async () => {
  const d = db({
    rpc: () => [
      {
        company_id: COMPANY,
        invitation_id: MEMBERSHIP,
        invite_code: 'a'.repeat(64),
        expires_at: '2026-10-08T09:00:00.000Z',
        ends_at: PERIOD.endsAt,
        export_by: '2026-12-10T00:00:00.000Z',
        delete_by: '2027-01-09T00:00:00.000Z',
      },
    ],
  });
  const inner = d.fetchImpl;
  const fetchImpl = async (url, init) =>
    String(url).includes('/auth/v1/admin/generate_link')
      ? { status: 200, json: async () => ({ hashed_token: 'e'.repeat(48), verification_type: 'signup' }) }
      : inner(url, init);
  const r = await operator.createCompany(
    session,
    { slug: 'acme', name: ' Acme AG ', firstAdminEmail: 'Ada@example.com', ...PERIOD, invoiceRef: 'INV-2026-014' },
    {},
    { fetchImpl },
  );
  assert.deepEqual(d.calls.find((c) => c.rpc).body, {
    p_slug: 'acme',
    p_name: 'Acme AG',
    p_first_admin_email: 'ada@example.com',
    p_expires_in: '7 days',
    p_starts_at: PERIOD.startsAt,
    p_ends_at: PERIOD.endsAt,
    p_invoice_ref: 'INV-2026-014',
  });
  assert.deepEqual(r.accessPeriod, {
    endsAt: PERIOD.endsAt,
    exportBy: '2026-12-10T00:00:00.000Z',
    deleteBy: '2027-01-09T00:00:00.000Z',
  });
  assert.equal(r.delivery, 'handover');
  assert.match(r.acceptUrl, /^https:\/\/enterprise\.example\.invalid\/accept#token_hash=/);
  assert.deepEqual(Object.keys(r).sort(), [
    'acceptUrl',
    'accessPeriod',
    'companyId',
    'delivery',
    'expiresAt',
    'invitationId',
    'signsIn',
  ]);
  assert.equal(r.signsIn, true, 'the claim granted and GoTrue agreeing: a signing link (ENA-7)');
});

test('design 1.5: createCompany refuses a missing or out-of-order period before any row exists', async () => {
  for (const period of [
    {},
    { startsAt: PERIOD.startsAt },
    { endsAt: PERIOD.endsAt },
    { startsAt: PERIOD.endsAt, endsAt: PERIOD.startsAt },
    { startsAt: PERIOD.startsAt, endsAt: PERIOD.startsAt },
    { ...PERIOD, invoiceRef: 'x'.repeat(81) },
    { startsAt: 'yesterday', endsAt: PERIOD.endsAt },
  ]) {
    const d = db({ rpc: () => [{}] });
    await assert.rejects(
      operator.createCompany(
        session,
        { slug: 'acme', name: 'Acme AG', firstAdminEmail: 'ada@example.com', ...period },
        {},
        d.options,
      ),
      refusal('E_BODY_INVALID'),
      JSON.stringify(period),
    );
    assert.deepEqual(d.calls, [], 'nothing ran');
  }
});

test('design 3.5 row 10: every operator write refuses its own malformed body before any call', async () => {
  const cases = [
    [() => operator.createCompany(session, { slug: 'A!', name: 'x', firstAdminEmail: 'a@b.co', ...PERIOD }, {}), 'E_SLUG_INVALID'],
    [() => operator.createCompany(session, { slug: 'acme', name: '', firstAdminEmail: 'a@b.co', ...PERIOD }, {}), 'E_NAME_INVALID'],
    [() => operator.createCompany(session, { slug: 'acme', name: 'x', firstAdminEmail: 'nope', ...PERIOD }, {}), 'E_EMAIL_INVALID'],
    [
      () =>
        operator.createCompany(
          session,
          { slug: 'acme', name: 'x', firstAdminEmail: 'a@b.co', expiresInDays: 31, ...PERIOD },
          {},
        ),
      'E_EXPIRY_INVALID',
    ],
    [() => operator.setCompanyStatus(session, { companyId: COMPANY, status: 'closed', reasonCode: 'non_payment' }), 'E_BODY_INVALID'],
    [() => operator.setCompanyStatus(session, { companyId: COMPANY, status: 'suspended', reasonCode: 'because' }), 'E_BODY_INVALID'],
    [() => operator.setCompanyStatus(session, { companyId: COMPANY, status: 'suspended' }), 'E_BODY_INVALID'],
    [() => operator.setQuota(session, { companyId: COMPANY, name: 'seats', value: 40 }), 'E_BODY_INVALID'],
    [() => operator.setQuota(session, { companyId: COMPANY, name: 'members_per_company', value: 4.5 }), 'E_BODY_INVALID'],
    [() => operator.closeCompany(session, { companyId: COMPANY, confirmSlug: 'acme', reasonCode: 'nope' }), 'E_BODY_INVALID'],
    [() => operator.closeCompany(session, { companyId: COMPANY, confirmSlug: 7, reasonCode: 'operator_request' }), 'E_BODY_INVALID'],
    [() => operator.deleteCompany(session, { companyId: 'x', confirmSlug: 'acme', reasonCode: 'operator_request' }), 'E_NOT_FOUND'],
    [() => operator.runExpiry(session, { limit: 501 }), 'E_BODY_INVALID'],
    [() => operator.inviteAdmin(session, { companyId: COMPANY, email: 'nope' }, {}), 'E_EMAIL_INVALID'],
    [() => operator.transferFirstAdmin(session, { companyId: COMPANY, userId: 'x' }), 'E_ID_INVALID'],
  ];
  for (const [run, code] of cases) await assert.rejects(run(), refusal(code), code);
});

test("the lead's decision (a): setCompanyStatus sends the operator's reason code and the routine records it", async () => {
  const d = db({ rpc: () => [{ company_id: COMPANY, status: 'suspended', changed: true }] });
  const r = await operator.setCompanyStatus(
    session,
    { companyId: COMPANY, status: 'suspended', reasonCode: 'non_payment' },
    d.options,
  );
  assert.deepEqual(d.calls.find((c) => c.rpc).body, {
    p_company: COMPANY,
    p_status: 'suspended',
    p_reason_code: 'non_payment',
  });
  assert.deepEqual(r, { companyId: COMPANY, status: 'suspended', changed: true });
});

test('design 3.5 rows 16 and 17: a wrong slug goes to the ROUTINE, so the status refusal still comes first', async () => {
  const d = refusingDb({ decide: () => 'E_COMPANY_NOT_SUSPENDED', ok: () => [{}] });
  await assert.rejects(
    operator.closeCompany(session, { companyId: COMPANY, confirmSlug: 'wrong', reasonCode: 'operator_request' }, d.options),
    refusal('E_COMPANY_NOT_SUSPENDED'),
  );
  assert.ok(d.calls.some((c) => c.rpc === 'close_company'), 'the service compared nothing itself');
});

/* ---------------------------------------------------------------------------
   design 1.3: the agent transfer
   --------------------------------------------------------------------------- */

test('design 1.3 and 3.5 row 11: the agent is located under the caller s own token before the routine runs', async () => {
  const d = db({
    tables: { agents: [{ id: AGENT, company_id: COMPANY, name: 'weekly-brief', status: 'orphaned', owner_membership_id: OTHER_MEMBERSHIP, creator_membership_id: MEMBERSHIP }] },
    rpc: () => [{ agent_id: AGENT, owner_membership_id: MEMBERSHIP, agent_status: 'active', changed: true }],
  });
  const r = await agents.transferAgent(
    session,
    { agentId: AGENT, toMembershipId: MEMBERSHIP, expectedOwnerMembershipId: OTHER_MEMBERSHIP },
    d.options,
  );
  assert.deepEqual(r, {
    agentId: AGENT,
    ownerMembershipId: MEMBERSHIP,
    agentStatus: 'active',
    changed: true,
  });
  assert.deepEqual(
    d.calls.map((c) => c.read ?? c.rpc),
    ['agents', 'transfer_agent'],
  );
  assert.deepEqual(d.calls[1].body, {
    p_agent: AGENT,
    p_to_membership: MEMBERSHIP,
    p_expected_owner: OTHER_MEMBERSHIP,
  });
  assert.equal(d.calls[1].claims.fn, undefined, 'unbound: no binding claim, no idempotency key');
});

test('design 3.5: an agent the caller cannot read is 404 before the routine, and a null parameter is 422', async () => {
  const invisible = db({ tables: { agents: [] }, rpc: () => [{}] });
  await assert.rejects(
    agents.transferAgent(
      session,
      { agentId: AGENT, toMembershipId: MEMBERSHIP, expectedOwnerMembershipId: OTHER_MEMBERSHIP },
      invisible.options,
    ),
    refusal('E_NOT_FOUND'),
  );
  assert.equal(invisible.calls.some((c) => c.rpc), false, 'no routine ran');
  for (const body of [
    { agentId: AGENT, toMembershipId: null, expectedOwnerMembershipId: OTHER_MEMBERSHIP },
    { agentId: AGENT, toMembershipId: MEMBERSHIP, expectedOwnerMembershipId: 'x' },
  ]) {
    const d = db({ rpc: () => [{}] });
    await assert.rejects(agents.transferAgent(session, body, d.options), refusal('E_BODY_INVALID'));
    assert.deepEqual(d.calls, []);
  }
});

/* ---------------------------------------------------------------------------
   design 1.4: the departure preview
   --------------------------------------------------------------------------- */

const previewAnswer = {
  membership_id: OTHER_MEMBERSHIP,
  roles: ['it_reviewer', 'member'],
  status: 'active',
  label: { kind: 'display_name', value: 'Ada Lovelace' },
  is_last_admin: false,
  sole_holder_of_roles: ['it_reviewer'],
  groups: [{ group_id: COMPANY, name: 'Finance' }],
  owned_agents: [{ agent_id: AGENT, name: 'weekly-brief', status: 'active', current_releases: 2, recipients: 7 }],
  drafts: 3,
  submitted_awaiting_review: 1,
  envelopes_awaiting_a_role_they_hold: 2,
  authorizations: 12,
  reports: 4,
  witnesses: 2,
  published_releases: 5,
};

test('design 3.4: the departure preview answers every field of its example, camelCased, with the company it was asked about', async () => {
  const d = db({
    tables: {
      /* Two reads of one view: the standing (no id filter, derived into api.my_standing by the double) and the
         target's own row. The double does not apply filters, so the fixture answers by what was asked. */
      memberships: (params) =>
        params.id === `eq.${OTHER_MEMBERSHIP}`
          ? [{ id: OTHER_MEMBERSHIP }]
          : [{ id: MEMBERSHIP, roles: ['company_admin', 'member'], status: 'active' }],
    },
    rpc: () => previewAnswer,
  });
  const r = await lifecycle.departurePreview(session, { companyId: COMPANY, membershipId: OTHER_MEMBERSHIP }, d.options);
  assert.deepEqual(Object.keys(r).sort(), [
    'authorizations',
    'companyId',
    'drafts',
    'envelopesAwaitingARoleTheyHold',
    'groups',
    'isLastAdmin',
    'label',
    'membershipId',
    'ownedAgents',
    'publishedReleases',
    'reports',
    'roles',
    'soleHolderOfRoles',
    'status',
    'submittedAwaitingReview',
    'witnesses',
  ]);
  assert.deepEqual(r.ownedAgents, [
    { agentId: AGENT, name: 'weekly-brief', status: 'active', currentReleases: 2, recipients: 7 },
  ]);
  assert.deepEqual(r.groups, [{ groupId: COMPANY, name: 'Finance' }]);
  assert.equal(r.companyId, COMPANY);
  assert.deepEqual(
    d.calls.map((c) => c.read ?? c.rpc),
    ['my_standing', 'memberships', 'departure_preview'],
    'the principal, then the target is in this company, then the one definer read',
  );
});

test('design 1.4: a membership of another company is 404 before the routine, and a member is E_FORBIDDEN', async () => {
  const foreign = db({ tables: { memberships: [] }, rpc: () => previewAnswer });
  /* The standing read and the target read share one fixture here: an empty memberships table means the target is
     not in this company. The standing read is api.my_standing, which the double derives separately. */
  await assert.rejects(
    lifecycle.departurePreview(session, { companyId: COMPANY, membershipId: OTHER_MEMBERSHIP }, foreign.options),
    refusal('E_NOT_FOUND'),
  );
  assert.equal(foreign.calls.some((c) => c.rpc), false);

  const member = db({ roles: ['member'], rpc: () => previewAnswer });
  await assert.rejects(
    lifecycle.departurePreview(session, { companyId: COMPANY, membershipId: OTHER_MEMBERSHIP }, member.options),
    refusal('E_FORBIDDEN'),
  );
  assert.equal(member.calls.some((c) => c.rpc), false, 'the admin test comes before the read');
});

/* ---------------------------------------------------------------------------
   design 1.6: the company document
   --------------------------------------------------------------------------- */

test('design 1.6: the document keeps its section names and gets the camelCase envelope, and withheld is always present', async () => {
  const doc = {
    exported_at: '2026-10-01T08:00:00.000Z',
    schema_version: 1,
    company: { id: COMPANY, slug: 'acme', name: 'Acme AG', status: 'active', created_at: '2026-10-01T08:00:00Z' },
    sections: { candidate_versions: [], memberships: [{ id: MEMBERSHIP }] },
    counts: { candidate_versions: 0, memberships: 1 },
    withheld: { candidate_versions: { rows: 3, reason: 'another_author_draft' } },
    omitted: ['invitations.token_hash', 'idempotency_keys'],
  };
  const d = db({ rpc: () => doc });
  const r = await takeout.takeCompanyCopy(session, { companyId: COMPANY }, d.options);
  assert.deepEqual(Object.keys(r), ['exportedAt', 'schemaVersion', 'company', 'sections', 'counts', 'withheld', 'omitted']);
  assert.deepEqual(Object.keys(r.sections), ['candidate_versions', 'memberships'], 'a section is a table, so it keeps the table s name');
  assert.deepEqual(r.withheld, { candidate_versions: { rows: 3, reason: 'another_author_draft' } });
  assert.deepEqual(
    d.calls.map((c) => c.read ?? c.rpc),
    ['export_company'],
    'NO principal is loaded: this route has to work for a suspended company s admin',
  );
});

test('design 1.6: a document without its withheld object or its envelope is E_INTERNAL, never half an answer', async () => {
  for (const doc of [
    { schema_version: 1, withheld: {} },
    { exported_at: 'x', withheld: {} },
    { exported_at: 'x', schema_version: 1 },
    [],
  ]) {
    const d = db({ rpc: () => doc });
    await assert.rejects(takeout.takeCompanyCopy(session, { companyId: COMPANY }, d.options), refusal('E_INTERNAL'));
  }
});

/* ---------------------------------------------------------------------------
   design 1.7: the admin's quota read
   --------------------------------------------------------------------------- */

test('design 1.7: the admin reads seven quotas, four with a usage count and three per-subject with none', async () => {
  const d = db({
    tables: {
      company_quotas: [{ name: 'members_per_company', value: 40 }],
      memberships: (params) =>
        params.select === 'id'
          ? Array.from({ length: 33 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }))
          : [{ id: MEMBERSHIP, roles: ['company_admin', 'member'], status: 'active' }],
      invitations: [
        { id: '00000000-0000-4000-8001-000000000001', expires_at: '2099-01-01T00:00:00Z' },
        { id: '00000000-0000-4000-8001-000000000002', expires_at: '2020-01-01T00:00:00Z' },
      ],
      agents: [{ id: AGENT }],
      groups: [],
    },
    rpc: () => [{}],
  });
  const r = await quotas.readQuotas(aal2Session, { companyId: COMPANY }, d.options);
  const by = Object.fromEntries(r.quotas.map((q) => [q.name, q]));
  assert.deepEqual(r.quotas.map((q) => q.name), [...QUOTA_NAMES]);
  assert.deepEqual(by.members_per_company, {
    name: 'members_per_company',
    value: 40,
    used: 33,
    source: 'company',
    near: true,
    perSubject: false,
  });
  assert.deepEqual(by.pending_invitations_per_company, {
    name: 'pending_invitations_per_company',
    value: 50,
    used: 1,
    source: 'default',
    near: false,
    perSubject: false,
  });
  assert.equal(by.agents_per_company.used, 1);
  assert.equal(by.groups_per_company.used, 0);
  for (const name of ['versions_per_agent', 'downloads_per_recipient', 'reports_per_recipient']) {
    assert.equal(by[name].used, null, `${name}: the count is one subject s, not the company s`);
    assert.equal(by[name].perSubject, true);
    assert.equal(by[name].near, false);
  }
});

test('design 1.7: this module s seven defaults are migration 008 s own app.limit_*() numbers', () => {
  const value = (fn) => {
    const m = new RegExp(`function app\\.${fn}\\(\\)[\\s\\S]{0,240}?select (\\d+)`).exec(M);
    assert.ok(m, `app.${fn} is in 008 or in an earlier migration this test can read`);
    return Number(m[1]);
  };
  /* The constant may be defined in any earlier migration; the directory is read rather than listed, so a
     renamed file cannot make this test pass by finding nothing. */
  const earlier = (fn) => {
    for (const file of readdirSync(join(REPO, 'supabase/migrations')).sort()) {
      const text = readFileSync(join(REPO, 'supabase/migrations', file), 'utf8');
      const m = new RegExp(`function app\\.${fn}\\(\\)[\\s\\S]{0,240}?select (\\d+)`).exec(text);
      if (m) return Number(m[1]);
    }
    throw new Error(`app.${fn} is in no migration`);
  };
  assert.equal(quotas.QUOTA_DEFAULTS.members_per_company, value('limit_members_per_company'));
  assert.equal(quotas.QUOTA_DEFAULTS.pending_invitations_per_company, value('limit_pending_invitations'));
  assert.equal(quotas.QUOTA_DEFAULTS.agents_per_company, earlier('limit_agents_per_company'));
  assert.equal(quotas.QUOTA_DEFAULTS.groups_per_company, earlier('limit_groups_per_company'));
  assert.equal(quotas.QUOTA_DEFAULTS.versions_per_agent, earlier('limit_versions_per_agent'));
  assert.equal(quotas.QUOTA_DEFAULTS.downloads_per_recipient, earlier('limit_downloads_per_recipient'));
  assert.equal(quotas.QUOTA_DEFAULTS.reports_per_recipient, earlier('limit_reports_per_recipient'));
  assert.deepEqual(Object.keys(quotas.QUOTA_DEFAULTS).sort(), [...QUOTA_NAMES].sort());
});

/* ---------------------------------------------------------------------------
   design 1.5: the account sweep, E6D-C-F13
   --------------------------------------------------------------------------- */

const ids = (n) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`);

function sweepDb({ candidates, used = new Set(), remaining = 0 }) {
  const asked = [];
  return {
    asked,
    db: {
      candidates: async () => ({ userIds: candidates, remaining }),
      stillCandidate: async (id) => {
        asked.push(id);
        return !used.has(id);
      },
      recorded: async (_op, batch) => ({ recorded: batch.length }),
    },
  };
}

test('design 1.5: a dry run is the default, reads the candidates and deletes nothing at all', async () => {
  const { db: d, asked } = sweepDb({ candidates: ids(3), remaining: 7 });
  let deletes = 0;
  const r = await sweepAccounts(
    { db: d, operatorId: USER },
    {
      fetchImpl: async () => {
        deletes += 1;
        return { status: 200, json: async () => ({}) };
      },
    },
  );
  assert.deepEqual(r, {
    candidates: 3,
    remaining: 7,
    deleted: 0,
    gone: 0,
    refused: 0,
    skipped: 0,
    recorded: 0,
    deletedIds: [],
  });
  assert.equal(deletes, 0);
  assert.deepEqual(asked, [], 'nothing is even re-checked, because nothing is deleted');
});

test('E6D-C-F13: an account that stops being a candidate between selection and delete is SKIPPED, not deleted', async () => {
  const list = ids(4);
  const { db: d, asked } = sweepDb({ candidates: list, used: new Set([list[1], list[3]]) });
  const deleted = [];
  const r = await sweepAccounts(
    { db: d, dryRun: false, operatorId: USER },
    {
      fetchImpl: async (url) => {
        deleted.push(String(url).split('/').pop());
        return { status: 200, json: async () => ({}) };
      },
    },
  );
  assert.deepEqual(asked, list, 'every candidate is re-checked, one at a time, immediately before its own delete');
  assert.deepEqual(deleted, [list[0], list[2]]);
  assert.equal(r.skipped, 2);
  assert.equal(r.deleted, 2);
  assert.equal(r.recorded, 2, 'the audit names exactly what was deleted');
});

test('E6D-C-F13: a delete GoTrue refuses is never recorded, and one already gone is neither refused nor recorded', async () => {
  const list = ids(3);
  const { db: d } = sweepDb({ candidates: list });
  const status = { [list[0]]: 200, [list[1]]: 409, [list[2]]: 404 };
  const r = await sweepAccounts(
    { db: d, dryRun: false, operatorId: USER },
    { fetchImpl: async (url) => ({ status: status[String(url).split('/').pop()], json: async () => ({}) }) },
  );
  assert.deepEqual(
    { deleted: r.deleted, refused: r.refused, gone: r.gone, recorded: r.recorded },
    { deleted: 1, refused: 1, gone: 1, recorded: 1 },
  );
  assert.deepEqual(r.deletedIds, [list[0]]);
});

test('E6D-C-F13: the audit is written in batches, so an interruption loses at most one batch', async () => {
  const list = ids(RECORD_BATCH * 2 + 3);
  const batches = [];
  const d = {
    candidates: async () => ({ userIds: list, remaining: 0 }),
    stillCandidate: async () => true,
    recorded: async (_op, batch) => {
      batches.push(batch.length);
      return { recorded: batch.length };
    },
  };
  const r = await sweepAccounts(
    { db: d, dryRun: false, operatorId: USER },
    { fetchImpl: async () => ({ status: 200, json: async () => ({}) }) },
  );
  assert.deepEqual(batches, [RECORD_BATCH, RECORD_BATCH, 3]);
  assert.equal(r.recorded, list.length);
});

test('design 1.5: an apply run without an operator id, and a db without its three calls, are refused before anything', async () => {
  const { db: d } = sweepDb({ candidates: ids(1) });
  await assert.rejects(sweepAccounts({ db: d, dryRun: false }), /operator id/);
  await assert.rejects(sweepAccounts({ db: { candidates: () => ({}) } }), /candidates, stillCandidate and recorded/);
  await assert.rejects(sweepAccounts({ db: d, limit: 0 }), /limit/);
});

test('design 1.5: the sweep is reachable from scripts/ and from no route', () => {
  const routes = readFileSync(join(REPO, 'lib/http/routes.mjs'), 'utf8');
  assert.equal(/lib\/operator\//.test(routes), false);
  assert.equal(/accounts\.mjs/.test(routes), false);
  const script = readFileSync(join(REPO, 'scripts/sweep-accounts.mjs'), 'utf8');
  assert.match(script, /from '\.\.\/lib\/operator\/accounts\.mjs'/);
  assert.match(script, /--apply/, 'it deletes nothing without --apply');
});
