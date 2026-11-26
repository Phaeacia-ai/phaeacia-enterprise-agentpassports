/* The E5 services without a stack (E5 design 3.4 and 3.5, the S rows of each table): the catalog's partition and its
   empty reasons, which fields each scope of the installations read carries, what each write binds, the no-call
   guarantee of every service refusal, and the download's answer. tests/e3/unit/fake-postgrest.mjs is the PostgREST
   double and the verified session; tests/e5/stack is where the routines answer. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { AGENT, CANDIDATE, COMPANY, fakeDb, KEY, MEMBERSHIP, OTHER_MEMBERSHIP, refusal, session, X } from '../../e3/unit/fake-postgrest.mjs';
import { REPO } from '../../e3/unit/helpers.mjs';

const { readText } = await import('../../../lib/passport/assemble.mjs');
const catalog = await import('../../../lib/services/catalog.mjs');
const installations = await import('../../../lib/services/installations.mjs');
const releases = await import('../../../lib/services/releases.mjs');

const SYNTHETIC = readText(join(REPO, 'tests/native-transfer/passport/fixtures/SYNTHETIC-passport.md'));
const RELEASE = '22222222-3333-4444-8555-666666666666';
const RELEASE_B = '22222222-3333-4444-8555-666666666667';
const RELEASE_C = '22222222-3333-4444-8555-666666666668';
const ENVELOPE = '11111111-2222-4333-8444-555555555555';
const POLICY = '33333333-4444-4555-8666-777777777777';
const GATE = '7fa06a81-93b4-4fd0-8b5c-6d7e8f9a0b12';
const REPORT = '55555555-6666-4777-8888-999999999999';
const WITNESS = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const NOW = '2026-10-01T08:00:00.000Z';
const hex = (h) => `${X}${h}`;
const SHA = 'a'.repeat(64);

const catalogRow = (over = {}) => ({
  id: RELEASE,
  company_id: COMPANY,
  agent_id: AGENT,
  candidate_id: CANDIDATE,
  envelope_id: ENVELOPE,
  target: 'claude-ai',
  state: 'published',
  assembled_sha256: hex(SHA),
  assembled_bytes: 64621,
  published_at: '2026-09-01T08:00:00.000000+00:00',
  superseded_by_release_id: null,
  superseded_at: null,
  withdrawn_at: null,
  blocked_reason: null,
  my_authorizations: { authorizations: 0, first_authorized_at: null, last_authorized_at: null },
  headline: { title: 'Weekly brief', summary: 'Reads the reports.', needs: [] },
  ...over,
});
const reportRow = (over = {}) => ({
  id: REPORT,
  company_id: COMPANY,
  release_id: RELEASE,
  membership_id: MEMBERSHIP,
  status: 'partial',
  losses: 'The calendar read is unavailable on this plan.',
  assistance: null,
  source: 'recipient_app',
  reported_at: '2026-09-10T08:00:00.000000+00:00',
  ...over,
});
const witnessRow = (over = {}) => ({
  id: WITNESS,
  company_id: COMPANY,
  report_id: REPORT,
  release_id: RELEASE,
  witness_membership_id: OTHER_MEMBERSHIP,
  witness_role: 'it_reviewer',
  status: 'partial',
  note: 'Confirmed on her machine.',
  witnessed_at: '2026-09-11T08:00:00.000000+00:00',
  ...over,
});
const member = (roles = ['member']) => [{ id: MEMBERSHIP, roles, status: 'active' }];

/* ---------- readCatalog ---------- */

test('3.4: the catalog answers one row per release the reads returned, with the predicate s own blockedReason', async () => {
  const db = fakeDb({
    tables: {
      release_catalog: [catalogRow()],
      agents: [{ id: AGENT, name: 'weekly-brief' }],
      installation_reports: [],
    },
  });
  const r = await catalog.readCatalog(session, { companyId: COMPANY }, { ...db.options, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.available.length, 1);
  assert.equal(r.earlier.length, 0);
  assert.equal(r.empty, null);
  assert.equal(r.nextCursor, null);
  const row = r.available[0];
  assert.equal(row.releaseId, RELEASE);
  assert.equal(row.agentName, 'weekly-brief');
  assert.equal(row.downloadable, true);
  assert.equal(row.blockedReason, null);
  assert.equal(row.assembledSha256, SHA);
  assert.deepEqual(row.my, {
    authorizations: 0,
    firstAuthorizedAt: null,
    lastAuthorizedAt: null,
    checkInDue: false,
    checkInDueAt: null,
    lastReport: null,
  });
});

test('1.3 and case 8: a row blocked only by its target stays in available, with its reason', async () => {
  const db = fakeDb({
    tables: {
      release_catalog: [catalogRow({ blocked_reason: 'E_TARGET_NOT_PUBLISHABLE' })],
      agents: [{ id: AGENT, name: 'weekly-brief' }],
      installation_reports: [],
    },
  });
  const r = await catalog.readCatalog(session, { companyId: COMPANY }, { ...db.options, now: NOW });
  assert.equal(r.available.length, 1);
  assert.equal(r.available[0].downloadable, false);
  assert.equal(r.available[0].blockedReason, 'E_TARGET_NOT_PUBLISHABLE');
});

test('case 9: an orphaned or archived agent keeps its row in available with the code, not hidden', async () => {
  for (const code of ['E_AGENT_ORPHANED', 'E_AGENT_ARCHIVED', 'E_DOWNLOAD_LIMIT']) {
    const db = fakeDb({
      tables: { release_catalog: [catalogRow({ blocked_reason: code })], agents: [], installation_reports: [] },
    });
    const r = await catalog.readCatalog(session, { companyId: COMPANY }, { ...db.options, now: NOW });
    assert.equal(r.available.length, 1, code);
    assert.equal(r.available[0].blockedReason, code, code);
  }
});

test('E5D-C-F4: a still-current release the caller downloaded moves to earlier when they leave its audience', async () => {
  const mineNow = { authorizations: 2, first_authorized_at: '2026-09-01T08:00:00+00:00', last_authorized_at: '2026-09-02T08:00:00+00:00' };
  const db = fakeDb({
    tables: {
      release_catalog: (params) =>
        params.state === 'eq.published' && params.superseded_by_release_id === 'is.null'
          ? [{ id: RELEASE, agent_id: AGENT, target: 'claude-ai', blocked_reason: 'E_NOT_FOUND' }]
          : [catalogRow({ blocked_reason: 'E_NOT_FOUND', my_authorizations: mineNow })],
      agents: [{ id: AGENT, name: 'weekly-brief' }],
      installation_reports: [],
    },
  });
  const r = await catalog.readCatalog(session, { companyId: COMPANY }, { ...db.options, now: NOW });
  assert.equal(r.available.length, 0, 'not addressed to them any more');
  assert.equal(r.earlier.length, 1, 'and still in their history');
  assert.equal(r.earlier[0].blockedReason, 'E_NOT_FOUND');
  assert.equal(r.earlier[0].my.authorizations, 2);
  assert.equal(r.earlier[0].current, true, 'the release itself is still the current one');
  assert.equal(r.earlier[0].my.checkInDue, true, 'so their outstanding check-in is still reachable');
});

test('1.6: a superseded release names what replaced it only when that is addressed to the caller', async () => {
  const mine = { authorizations: 1, first_authorized_at: '2026-09-01T08:00:00+00:00', last_authorized_at: '2026-09-01T08:00:00+00:00' };
  const earlier = catalogRow({
    blocked_reason: 'E_RELEASE_SUPERSEDED',
    superseded_by_release_id: RELEASE_B,
    my_authorizations: mine,
  });
  const cases = [
    ['addressed', [{ id: RELEASE_B, agent_id: AGENT, target: 'claude-ai', blocked_reason: null }], RELEASE_B],
    ['not_addressed', [{ id: RELEASE_B, agent_id: AGENT, target: 'claude-ai', blocked_reason: 'E_NOT_FOUND' }], null],
    ['none', [], null],
  ];
  for (const [state, currents, expectedId] of cases) {
    const db = fakeDb({
      tables: {
        release_catalog: (params) => (params.state === 'eq.published' ? currents : [earlier]),
        agents: [],
        installation_reports: [],
      },
    });
    const r = await catalog.readCatalog(session, { companyId: COMPANY }, { ...db.options, now: NOW });
    assert.equal(r.earlier.length, 1, state);
    assert.equal(r.earlier[0].replacedByReleaseId, expectedId, state);
    assert.deepEqual(r.earlier[0].replacement, { state }, state);
  }
});

test('1.3: the empty reasons, in the order the design gives them', async () => {
  const cases = [
    ['no_target_enabled', [], []],
    ['no_groups', [{ target: 'claude-ai' }], []],
    ['none_for_my_groups', [{ target: 'claude-ai' }], [{ group_id: 'g' }]],
  ];
  for (const [expected, targets, groups] of cases) {
    const db = fakeDb({
      tables: { release_catalog: [], agents: [], installation_reports: [], release_targets: targets, group_members: groups },
    });
    const r = await catalog.readCatalog(session, { companyId: COMPANY }, { ...db.options, now: NOW });
    assert.equal(r.empty, expected, expected);
  }
});

test('rule 11: an empty page with a cursor after it is a continuation, not an empty catalog', async () => {
  const rows = [];
  for (let i = 0; i < 51; i++) {
    rows.push(catalogRow({ id: `2222222${(i % 10).toString(16)}-3333-4444-8555-66666666666${(i % 16).toString(16)}`, blocked_reason: 'E_NOT_FOUND' }));
  }
  const db = fakeDb({ tables: { release_catalog: (p) => (p.state === 'eq.published' ? [] : rows), agents: [], installation_reports: [] } });
  const r = await catalog.readCatalog(session, { companyId: COMPANY }, { ...db.options, now: NOW });
  assert.equal(r.available.length, 0);
  assert.equal(r.earlier.length, 0);
  assert.notEqual(r.nextCursor, null, 'a page follows');
  assert.equal(r.empty, null, 'so no terminal empty sentence');
  const reads = db.calls.filter((c) => c.read === 'release_targets');
  assert.equal(reads.length, 0, 'and the empty-reason reads never ran');
});

test('the catalog refuses a malformed cursor and an unknown query key before any read', async () => {
  for (const query of [{ cursor: 'nope' }, { state: 'published' }]) {
    const db = fakeDb({});
    await assert.rejects(
      catalog.readCatalog(session, { companyId: COMPANY, query }, db.options),
      refusal('E_BODY_INVALID'),
      JSON.stringify(query),
    );
    assert.equal(db.calls.length, 0, 'nothing was read');
  }
});

/* ---------- authorizeDownload ---------- */

test('1.2 and 3.4: the download returns the bytes, their hash, the count after this row and the declared losses', async () => {
  const db = fakeDb({
    tables: {
      releases: [
        {
          id: RELEASE,
          company_id: COMPANY,
          agent_id: AGENT,
          candidate_id: CANDIDATE,
          envelope_id: ENVELOPE,
          target: 'claude-ai',
          gate_id: GATE,
          content_sha256: hex(SHA),
          derived_sha256: hex(SHA),
          installer_text_sha256: hex(SHA),
          core_sha256: hex(SHA),
          branch_sha256: hex(SHA),
          judge_sha256: hex(SHA),
          policy_id: POLICY,
          policy_sha256: hex(SHA),
          audience_group_ids: [],
          envelope_sha256: hex(SHA),
          assembled_sha256: hex(SHA),
          assembled_bytes: 64621,
          state: 'published',
          published_by_membership_id: MEMBERSHIP,
          published_at: '2026-09-01T08:00:00+00:00',
          superseded_by_release_id: null,
          superseded_at: null,
          withdrawn_by_membership_id: null,
          withdrawn_at: null,
          withdrawal_reason: null,
        },
      ],
      release_policies: [{ id: POLICY, version: 1, sha256: hex(SHA), active: true }],
    },
    rpc: () => ({
      release: { release_id: RELEASE },
      assembled_content: SYNTHETIC,
      assembled_sha256: SHA,
      authorization: { authorized_at: '2026-10-01T08:00:00+00:00', authorizations: 3 },
    }),
  });
  const r = await catalog.authorizeDownload(session, { releaseId: RELEASE }, db.options);
  assert.equal(r.ok, true);
  assert.equal(r.assembledContent, SYNTHETIC);
  assert.equal(r.assembledSha256, SHA);
  assert.deepEqual(r.authorization, { authorizedAt: '2026-10-01T08:00:00.000Z', authorizations: 3 });
  assert.equal(r.release.releaseId, RELEASE);
  assert.ok(['declared', 'pending'].includes(r.losses.state));
  assert.ok(Array.isArray(r.losses.rows));
  const call = db.calls.find((c) => c.rpc);
  assert.equal(call.rpc, 'authorize_download');
  assert.deepEqual(call.body, { p_release: RELEASE });
  assert.equal(call.claims.fn, undefined, 'unbound: the bearer carries no fn, so app.server_actor admits it');
});

/* Amended under the lead's grant of 2026-09-18 (E6S-C-F2). Until then this service read app.releases under the
   caller's own token before calling api.authorize_download and answered E_NOT_FOUND whenever that read was empty,
   and this test held it to making no call at all. E6's read cutoff closes that read for a company past export_by,
   so the pre-read began answering 404 to a member whose company's agreement had ended, which is the one case
   app.download_refusal_for exists to answer with 409 E_ACCESS_PERIOD_ENDED. The pre-read is gone and the routine
   is the deciding boundary: it makes the same decision in the right order, with app.release_visible_to and the
   server actor raising E_NOT_FOUND before any state code (E5D-C-F1). So the CALL IS NOW MADE for an unreadable
   release and the answer is still 404 E_NOT_FOUND, which is what this test asserts instead.
   The same rule through the real routine: tests/e6/unit/services.test.mjs (E6S-C-F2, both refusals reaching the
   caller as their own codes and never 500) and tests/e5/stack/routes.test.mjs "E5D-C-F1: a caller who could never
   see a withdrawn release is told E_NOT_FOUND, not the state code" for the outsider and the other company's
   member. The MALFORMED id is unchanged and still makes no call at all. */
test('3.5 row 10: a release the caller cannot read is E_NOT_FOUND from the routine, and a malformed id makes no call', async () => {
  /* The double's `rpc` hook can only answer 200, and what the routine does here is RAISE, so this one case
     supplies its own fetchImpl: the answer is the one the local stack gives for `raise ... using errcode =
     'P0002'`, which PostgREST sends as HTTP 500 with the token in `message` and lib/errors.mjs maps to 404. */
  const seen = [];
  const fetchImpl = async (url, init) => {
    const name = new URL(String(url)).pathname.split('/').pop();
    seen.push({ method: init.method, name });
    return { status: 500, json: async () => ({ code: 'P0002', details: null, hint: null, message: 'E_NOT_FOUND' }) };
  };
  await assert.rejects(catalog.authorizeDownload(session, { releaseId: RELEASE }, { fetchImpl }), refusal('E_NOT_FOUND'));
  assert.deepEqual(seen, [{ method: 'POST', name: 'authorize_download' }],
    'the routine decides, so the call is made and no read stands in front of it');
  const bad = fakeDb({});
  await assert.rejects(catalog.authorizeDownload(session, { releaseId: 'nope' }, bad.options), refusal('E_NOT_FOUND'));
  assert.equal(bad.calls.length, 0);
});

/* ---------- reportInstallation and witnessInstallation ---------- */

test('3.5 report rows 10, 11 and 12: every service refusal, and no call for any of them', async () => {
  const bodies = [
    [{ status: 'pass' }, 'E_IDEMPOTENCY_KEY_INVALID', 'not-a-uuid'],
    [{ status: 'verified' }, 'E_BODY_INVALID', KEY],
    [{ status: 'pass', extra: 1 }, 'E_BODY_INVALID', KEY],
    [{ status: null }, 'E_BODY_INVALID', KEY],
    [{ status: 'partial', losses: '   ' }, 'E_BODY_INVALID', KEY],
    [{ status: 'partial', losses: 'x'.repeat(2001) }, 'E_BODY_INVALID', KEY],
    [{ status: 'pass', assistance: 42 }, 'E_BODY_INVALID', KEY],
    [{ status: 'partial' }, 'E_LOSSES_REQUIRED', KEY],
    [{ status: 'fail', losses: null }, 'E_LOSSES_REQUIRED', KEY],
  ];
  for (const [body, code, key] of bodies) {
    const db = fakeDb({});
    await assert.rejects(
      installations.reportInstallation(session, { releaseId: RELEASE, idempotencyKey: key, body }, db.options),
      refusal(code),
      JSON.stringify(body),
    );
    assert.equal(db.calls.length, 0, `${JSON.stringify(body)}: nothing was read or sent`);
  }
  const unreadable = fakeDb({ tables: { releases: [] } });
  await assert.rejects(
    installations.reportInstallation(
      session,
      { releaseId: RELEASE, idempotencyKey: KEY, body: { status: 'pass' } },
      unreadable.options,
    ),
    refusal('E_NOT_FOUND'),
  );
  assert.equal(unreadable.calls.filter((c) => c.rpc).length, 0);
});

test('E5D-C-F9: whitespace-only losses is E_BODY_INVALID, and one code point of losses is accepted', async () => {
  const db = fakeDb({
    tables: {
      releases: [{ id: RELEASE }],
      installation_reports: [reportRow({ status: 'partial', losses: 'x' })],
      installation_witnesses: [],
    },
    rpc: () => ({ report_id: REPORT, status: 'partial', idempotent_replay: false }),
  });
  const r = await installations.reportInstallation(
    session,
    { releaseId: RELEASE, idempotencyKey: KEY, body: { status: 'partial', losses: 'x' } },
    db.options,
  );
  assert.equal(r.report.status, 'partial');
  const call = db.calls.find((c) => c.rpc);
  assert.equal(call.rpc, 'report_installation');
  assert.deepEqual(call.body, {
    p_release: RELEASE,
    p_status: 'partial',
    p_losses: 'x',
    p_assistance: null,
    p_idempotency_key: KEY,
  });
  assert.equal(call.claims.fn, 'report_installation', 'a bound bearer');
});

test('1.4a: an absent optional text is an explicit null in the body, never a skipped argument', async () => {
  const db = fakeDb({
    tables: { releases: [{ id: RELEASE }], installation_reports: [reportRow({ status: 'pass', losses: null })], installation_witnesses: [] },
    rpc: () => ({ report_id: REPORT, idempotent_replay: false }),
  });
  await installations.reportInstallation(
    session,
    { releaseId: RELEASE, idempotencyKey: KEY, body: { status: 'pass' } },
    db.options,
  );
  const body = db.calls.find((c) => c.rpc).body;
  assert.equal(body.p_losses, null);
  assert.equal(body.p_assistance, null);
  assert.equal(Object.keys(body).length, 5, 'five parameters, in signature order');
});

test('3.5 witness rows 10 to 12: the service refusals, and the bound body', async () => {
  for (const [body, code] of [
    [{ status: 'pass' }, 'E_BODY_INVALID'],
    [{ status: 'pass', note: '   ' }, 'E_BODY_INVALID'],
    [{ status: 'pass', note: 'x', extra: 1 }, 'E_BODY_INVALID'],
    [{ status: 'made-up', note: 'x' }, 'E_BODY_INVALID'],
  ]) {
    const db = fakeDb({});
    await assert.rejects(
      installations.witnessInstallation(session, { reportId: REPORT, idempotencyKey: KEY, body }, db.options),
      refusal(code),
      JSON.stringify(body),
    );
    assert.equal(db.calls.length, 0);
  }
  const db = fakeDb({
    tables: {
      installation_reports: [reportRow()],
      installation_witnesses: [witnessRow()],
    },
    rpc: () => ({ witness_id: WITNESS, idempotent_replay: false }),
  });
  const r = await installations.witnessInstallation(
    session,
    { reportId: REPORT, idempotencyKey: KEY, body: { status: 'partial', note: 'Confirmed on her machine.' } },
    db.options,
  );
  assert.equal(r.witness.witnessRole, 'it_reviewer');
  assert.equal(r.witness.label, 'Witnessed by an IT reviewer');
  assert.equal(r.report.reportId, REPORT);
  assert.equal(r.report.label, 'Recipient-reported');
  assert.deepEqual(db.calls.find((c) => c.rpc).body, {
    p_report: REPORT,
    p_status: 'partial',
    p_note: 'Confirmed on her machine.',
    p_idempotency_key: KEY,
  });
});

/* ---------- readInstallations: E5D-C-F3 ---------- */

const installationsDb = (roles, over = {}) =>
  fakeDb({
    tables: {
      memberships: member(roles),
      releases: [{ id: RELEASE, company_id: COMPANY, agent_id: AGENT }],
      agents: [{ id: AGENT, owner_membership_id: OTHER_MEMBERSHIP }],
      installation_reports: [reportRow({ membership_id: OTHER_MEMBERSHIP })],
      installation_witnesses: [witnessRow()],
      release_downloads: [
        { id: 1, membership_id: OTHER_MEMBERSHIP, authorized_at: '2026-09-01T08:00:00+00:00' },
        { id: 2, membership_id: OTHER_MEMBERSHIP, authorized_at: '2026-09-02T08:00:00+00:00' },
      ],
      release_catalog: [{ id: RELEASE, my_authorizations: { authorizations: 0, first_authorized_at: null, last_authorized_at: null } }],
      ...over,
    },
  });

test('E5D-C-F3: an admin reads scope company with the five ledger fields', async () => {
  const db = installationsDb(['company_admin', 'member']);
  const r = await installations.readInstallations(session, { releaseId: RELEASE }, { ...db.options, now: NOW });
  assert.equal(r.scope, 'company');
  assert.equal(r.recipients.length, 1);
  const entry = r.recipients[0];
  assert.equal(entry.membershipId, OTHER_MEMBERSHIP);
  assert.equal(entry.authorizations, 2);
  assert.equal(entry.firstAuthorizedAt, '2026-09-01T08:00:00.000Z');
  assert.equal(entry.checkInDue, false, 'a report clears it');
  assert.equal(entry.reports.length, 1);
  assert.equal(entry.reports[0].witnesses.length, 1);
});

test('E5D-C-F3: a reviewer reads scope company-reports, and the five ledger fields are absent, not null', async () => {
  const db = installationsDb(['it_reviewer', 'member']);
  const r = await installations.readInstallations(session, { releaseId: RELEASE }, { ...db.options, now: NOW });
  assert.equal(r.scope, 'company-reports');
  assert.equal(r.recipients.length, 1);
  assert.deepEqual(Object.keys(r.recipients[0]).sort(), ['membershipId', 'reports']);
  for (const field of ['authorizations', 'firstAuthorizedAt', 'lastAuthorizedAt', 'checkInDue', 'checkInDueAt']) {
    assert.equal(Object.hasOwn(r.recipients[0], field), false, `${field} is absent`);
  }
  assert.equal(r.recipients[0].reports[0].membershipId, OTHER_MEMBERSHIP);
  assert.equal(db.calls.some((c) => c.read === 'release_downloads'), false, 'and the ledger was never read');
});

test('E5D-C-F3 fail-before: the same read that carried a ledger field to a reviewer is the defect this shape refuses', async () => {
  const db = installationsDb(['it_reviewer', 'member']);
  const r = await installations.readInstallations(session, { releaseId: RELEASE }, { ...db.options, now: NOW });
  /* The counterexample, written as the mutant would answer it: an entry carrying another membership's count. A reader
     of this test can see the two shapes side by side, and the assertion above is what refuses the left-hand one. */
  const mutant = { membershipId: OTHER_MEMBERSHIP, authorizations: 2, reports: r.recipients[0].reports };
  assert.notDeepEqual(Object.keys(r.recipients[0]).sort(), Object.keys(mutant).sort());
});

test('E5D-C-F3: a recipient reads scope own, one entry, their own summary only', async () => {
  const db = installationsDb(['member'], {
    installation_reports: [reportRow({ membership_id: MEMBERSHIP })],
    release_catalog: [
      {
        id: RELEASE,
        my_authorizations: {
          authorizations: 1,
          first_authorized_at: '2026-09-01T08:00:00+00:00',
          last_authorized_at: '2026-09-01T08:00:00+00:00',
        },
      },
    ],
  });
  const r = await installations.readInstallations(session, { releaseId: RELEASE }, { ...db.options, now: NOW });
  assert.equal(r.scope, 'own');
  assert.equal(r.recipients.length, 1);
  assert.equal(r.recipients[0].membershipId, MEMBERSHIP);
  assert.equal(r.recipients[0].authorizations, 1);
  assert.equal(db.calls.some((c) => c.read === 'release_downloads'), false, 'the ledger is never read for scope own');
});

test('a member with neither an authorization nor a report reads an empty list, not an entry of zeros', async () => {
  const db = installationsDb(['member'], { installation_reports: [] });
  const r = await installations.readInstallations(session, { releaseId: RELEASE }, { ...db.options, now: NOW });
  assert.equal(r.scope, 'own');
  assert.deepEqual(r.recipients, []);
  assert.equal(r.truncated, false);
});

/* ---------- E5D-C-F6: the single-release read ---------- */

test('E5D-C-F6: the release read carries the download decision and the caller s own summary', async () => {
  const db = fakeDb({
    tables: {
      releases: [
        {
          id: RELEASE,
          company_id: COMPANY,
          agent_id: AGENT,
          candidate_id: CANDIDATE,
          envelope_id: ENVELOPE,
          target: 'claude-ai',
          gate_id: GATE,
          content_sha256: hex(SHA),
          derived_sha256: hex(SHA),
          installer_text_sha256: hex(SHA),
          core_sha256: hex(SHA),
          branch_sha256: hex(SHA),
          judge_sha256: hex(SHA),
          policy_id: POLICY,
          policy_sha256: hex(SHA),
          audience_group_ids: [],
          envelope_sha256: hex(SHA),
          assembled_sha256: hex(SHA),
          assembled_bytes: 64621,
          state: 'published',
          published_by_membership_id: MEMBERSHIP,
          published_at: '2026-09-01T08:00:00+00:00',
          superseded_by_release_id: null,
          superseded_at: null,
          withdrawn_by_membership_id: null,
          withdrawn_at: null,
          withdrawal_reason: null,
        },
      ],
      review_envelopes: [],
      reviews: [],
      agents: [{ id: AGENT, owner_membership_id: OTHER_MEMBERSHIP }],
      release_policies: [{ id: POLICY, version: 1, sha256: hex(SHA), active: true }],
      release_catalog: [
        {
          id: RELEASE,
          blocked_reason: null,
          my_authorizations: {
            authorizations: 1,
            first_authorized_at: '2026-09-01T08:00:00+00:00',
            last_authorized_at: '2026-09-01T08:00:00+00:00',
          },
        },
      ],
      installation_reports: [],
    },
  });
  const r = await releases.readRelease(session, { releaseId: RELEASE }, { ...db.options, now: NOW });
  assert.deepEqual(r.download, { downloadable: true, blockedReason: null });
  assert.equal(r.my.authorizations, 1);
  assert.equal(r.my.checkInDue, true, 'thirty days after the first authorization and no report');
  assert.equal(r.my.lastReport, null);
  assert.equal(r.recipients, null, 'a plain member still reads no ledger');
});
