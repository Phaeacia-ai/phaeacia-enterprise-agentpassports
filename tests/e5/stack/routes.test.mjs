/* The five E5 routes against the running local stack (E5 design 3.1, 3.4, 3.5 and section 5): every caller class of the
   permission matrix, the visibility-first refusal of E5D-C-F1, the history of E5D-C-F4, malformed and oversized input,
   the claim protocol, the derived check-in at the fourteenth day exactly, and case 24's fail-before, the one predicate
   door written security invoker. Reseeds once through tests/db/00-seed.sh and builds its own users and companies.
   Run one file at a time: node --test --test-concurrency=1 tests/e5/stack/ */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ageLedger,
  e5routes,
  e4world,
  enableTargets,
  envelopeFor,
  key,
  ledgerCount,
  published,
  reportCount,
  reseed,
  reviewCompany,
  sql,
  submitted,
  witnessCount,
} from './helpers.mjs';

const ids = reseed();
enableTargets();
const R = await e5routes();
const W = e4world('e5-routes', ids);
const A = await reviewCompany(W, R, 'a');
const B = await reviewCompany(W, R, 'b');
/* A plain member of A who is in no bound group, authored nothing and owns no agent: the one caller class that can see
   no release of this company at all. The author cannot stand in for it, because app.candidate_visible_to admits an
   author to their own release and app.agents makes them its owner, so an author reads the release and its reports. */
const OUTSIDER = W.user('a-outsider');
W.member(A.id, OUTSIDER);

const ok = (r, status, label) => {
  assert.equal(r.status, status, `${label}: ${r.raw}`);
  return r.body;
};
const refusedWith = (r, status, code, label) => {
  assert.deepEqual([r.status, r.body?.code], [status, code], `${label}: ${r.raw}`);
  assert.deepEqual(Object.keys(r.body).sort(), ['code', 'message', 'ok'], `${label}: no database details forwarded`);
};
const membershipOf = (companyId, user) =>
  sql(`select id from app.memberships where company_id='${companyId}' and user_id='${user.id}'`);

/* One published release of company A, addressed to A's audience group, whose one member is A.member. */
const releaseFor = async (target = 'claude-ai') => published(R, A, target);

test('3.1: the catalog for every caller class of company A', async () => {
  const { releaseId } = await releaseFor();
  const recipient = ok(await R.catalog(A.member, A.id), 200, 'recipient');
  assert.equal(recipient.available.some((row) => row.releaseId === releaseId), true, 'the recipient sees it');
  assert.equal(recipient.available.find((row) => row.releaseId === releaseId).downloadable, true);
  assert.equal(recipient.empty, null);
  for (const [who, user] of [
    ['the author', A.author],
    ['an IT reviewer', A.it],
    ['an admin at aal1', A.admin],
    ['an admin at aal2', A.adminHi],
  ]) {
    const body = ok(await R.catalog(user, A.id), 200, who);
    assert.equal(body.available.some((row) => row.releaseId === releaseId), false, `${who}: not addressed to them`);
    assert.equal(body.earlier.length, 0, who);
  }
  refusedWith(await R.catalog(B.member, A.id), 404, 'E_NOT_FOUND', 'a member of company B');
  refusedWith(await R.catalog(A.member, 'not-a-uuid'), 404, 'E_NOT_FOUND', 'a malformed company id');
  refusedWith(await R.catalog(A.member, A.id, { state: 'published' }), 422, 'E_BODY_INVALID', 'an unknown query key');
  refusedWith(await R.catalog(A.member, A.id, { cursor: 'nope' }), 422, 'E_BODY_INVALID', 'a malformed cursor');
});

test('3.1: the download for every caller class, and its answer', async () => {
  const { releaseId } = await releaseFor();
  const body = ok(await R.download(A.member, releaseId), 200, 'the recipient');
  assert.equal(body.release.releaseId, releaseId);
  assert.equal(typeof body.assembledContent, 'string');
  assert.match(body.assembledSha256, /^[0-9a-f]{64}$/);
  assert.equal(body.authorization.authorizations, 1);
  assert.ok(['declared', 'pending'].includes(body.losses.state));
  assert.equal(
    body.assembledSha256,
    sql(`select encode(assembled_sha256, 'hex') from app.releases where id='${releaseId}'`),
    'the answer declares the row s own hash',
  );
  for (const [who, user] of [
    ['the author', A.author],
    ['an IT reviewer', A.it],
    ['an admin at aal2', A.adminHi],
    ['a plain member of no bound group', OUTSIDER],
  ]) {
    refusedWith(await R.download(user, releaseId), 404, 'E_NOT_FOUND', `${who}, who is in no bound group`);
  }
  refusedWith(await R.download(B.member, releaseId), 404, 'E_NOT_FOUND', 'a member of company B');
  refusedWith(await R.download(A.member, 'not-a-uuid'), 404, 'E_NOT_FOUND', 'a malformed release id');
  const second = ok(await R.download(A.member, releaseId), 200, 'a repeat');
  assert.equal(second.authorization.authorizations, 2, 'a repeat is a true second authorization, not a replay');
});

test('E5D-C-F1: a caller who could never see a withdrawn release is told E_NOT_FOUND, not the state code', async () => {
  const { releaseId } = await releaseFor();
  ok(await R.download(A.member, releaseId), 200, 'the recipient downloads first');
  ok(await R.withdraw(A.adminHi, releaseId, 'Probe withdrawal.'), 200, 'the withdrawal');
  refusedWith(await R.download(A.member, releaseId), 409, 'E_RELEASE_WITHDRAWN', 'the recipient, who can see it');
  refusedWith(
    await R.download(A.author, releaseId),
    409,
    'E_RELEASE_WITHDRAWN',
    'the author, who reads their own release through E4 s own predicate and is told the state',
  );
  refusedWith(
    await R.download(OUTSIDER, releaseId),
    404,
    'E_NOT_FOUND',
    'a plain member who could never see it: the state code would tell them a release exists',
  );
  refusedWith(await R.download(B.member, releaseId), 404, 'E_NOT_FOUND', 'a member of another company');
});

test('E5D-C-F4: a recipient removed from the audience keeps the release in their own history', async () => {
  const { releaseId } = await releaseFor();
  ok(await R.download(A.member, releaseId), 200, 'the download');
  const membershipId = membershipOf(A.id, A.member);
  ok(await R.memberRemove(A.adminHi, A.id, A.groupId, membershipId), 200, 'removed from the bound group');
  refusedWith(await R.download(A.member, releaseId), 404, 'E_NOT_FOUND', 'the next download');
  const body = ok(await R.catalog(A.member, A.id), 200, 'the catalog after the removal');
  assert.equal(body.available.some((r) => r.releaseId === releaseId), false, 'no longer available');
  const row = body.earlier.find((r) => r.releaseId === releaseId);
  assert.ok(row, 'and still in their history');
  assert.equal(row.blockedReason, 'E_NOT_FOUND');
  assert.equal(row.my.authorizations, 1);
  assert.equal(row.current, true, 'the release itself is still the current one');
  ok(await R.memberAdd(A.adminHi, A.id, A.groupId, membershipId), 200, 'added back');
  const after = ok(await R.catalog(A.member, A.id), 200, 'the catalog again');
  assert.equal(after.available.some((r) => r.releaseId === releaseId), true, 'and it returns to available');
});

test('3.1 and 1.4a: who may report, and what the report answers', async () => {
  const { releaseId } = await releaseFor();
  refusedWith(
    await R.report(A.member, releaseId, { status: 'pass' }),
    409,
    'E_NOT_DOWNLOADED',
    'a recipient who has not downloaded',
  );
  ok(await R.download(A.member, releaseId), 200, 'the download');
  const body = ok(
    await R.report(A.member, releaseId, { status: 'partial', losses: 'The calendar read is unavailable.' }),
    201,
    'the report',
  );
  assert.equal(body.report.status, 'partial');
  assert.equal(body.report.source, 'recipient_app');
  assert.equal(body.report.label, 'Recipient-reported');
  assert.deepEqual(body.report.witnesses, []);
  refusedWith(
    await R.report(OUTSIDER, releaseId, { status: 'pass' }),
    404,
    'E_NOT_FOUND',
    'a member who cannot read the release',
  );
  refusedWith(
    await R.report(A.author, releaseId, { status: 'pass' }),
    409,
    'E_NOT_DOWNLOADED',
    'the author, who reads the release and has no authorization of their own',
  );
  refusedWith(await R.report(B.member, releaseId, { status: 'pass' }), 404, 'E_NOT_FOUND', 'another company');
  refusedWith(
    await R.report(A.member, releaseId, { status: 'partial' }),
    422,
    'E_LOSSES_REQUIRED',
    'partial with no losses',
  );
  refusedWith(
    await R.report(A.member, releaseId, { status: 'partial', losses: '   ' }),
    422,
    'E_BODY_INVALID',
    'E5D-C-F9: whitespace-only losses',
  );
});

test('3.1 and 1.4b: who may witness, and what the witness answers', async () => {
  const { releaseId } = await releaseFor();
  ok(await R.download(A.member, releaseId), 200, 'the download');
  const report = ok(await R.report(A.member, releaseId, { status: 'pass' }), 201, 'the report').report;
  refusedWith(
    await R.witness(A.member, report.reportId, { status: 'pass', note: 'My own.' }),
    403,
    'E_ROLE_REQUIRED',
    'the recipient, a plain member: the role test is row 19, above row 20',
  );
  refusedWith(
    await R.witness(OUTSIDER, report.reportId, { status: 'pass', note: 'Not mine to see.' }),
    404,
    'E_NOT_FOUND',
    'a plain member who cannot read the report: row 18 answers before any role test',
  );
  refusedWith(
    await R.witness(A.author, report.reportId, { status: 'pass', note: 'Owner.' }),
    403,
    'E_ROLE_REQUIRED',
    'the agent owner, who reads the report and holds no reviewer or admin role',
  );
  refusedWith(
    await R.witness(B.it, report.reportId, { status: 'pass', note: 'Outsider.' }),
    404,
    'E_NOT_FOUND',
    'another company s reviewer',
  );
  const body = ok(
    await R.witness(A.it, report.reportId, { status: 'pass', note: 'Confirmed on her machine.' }),
    201,
    'an IT reviewer at aal1',
  );
  assert.equal(body.witness.witnessRole, 'it_reviewer');
  assert.equal(body.witness.label, 'Witnessed by an IT reviewer');
  assert.equal(body.report.witnesses.length, 1, 'and the report comes back with it');
  refusedWith(
    await R.witness(A.it, report.reportId, { status: 'fail', note: 'Second thoughts.' }),
    409,
    'E_ALREADY_WITNESSED',
    'the same reviewer again',
  );
  ok(await R.witness(A.business, report.reportId, { status: 'pass', note: 'Business confirms.' }), 201, 'a second role');
  ok(await R.witness(A.admin, report.reportId, { status: 'pass', note: 'The admin at aal1.' }), 201, 'an admin at aal1');
  assert.equal(witnessCount(report.reportId), 3);
});

test('E5D-C-F3: which fields each scope of the installations read carries', async () => {
  const { releaseId } = await releaseFor();
  ok(await R.download(A.member, releaseId), 200, 'the download');
  const report = ok(await R.report(A.member, releaseId, { status: 'pass' }), 201, 'the report').report;
  ok(await R.witness(A.it, report.reportId, { status: 'pass', note: 'Confirmed.' }), 201, 'the witness');
  const memberMembership = membershipOf(A.id, A.member);

  const own = ok(await R.installations(A.member, releaseId), 200, 'the recipient');
  assert.equal(own.scope, 'own');
  assert.equal(own.recipients.length, 1);
  assert.equal(own.recipients[0].membershipId, memberMembership);
  assert.equal(own.recipients[0].authorizations, 1);

  const company = ok(await R.installations(A.adminHi, releaseId), 200, 'the admin');
  assert.equal(company.scope, 'company');
  assert.equal(company.recipients[0].authorizations, 1);
  assert.equal(company.recipients[0].reports[0].witnesses.length, 1);

  const reviewer = ok(await R.installations(A.it, releaseId), 200, 'the reviewer');
  assert.equal(reviewer.scope, 'company-reports');
  assert.equal(reviewer.recipients.length, 1);
  assert.deepEqual(Object.keys(reviewer.recipients[0]).sort(), ['membershipId', 'reports']);
  for (const field of ['authorizations', 'firstAuthorizedAt', 'lastAuthorizedAt', 'checkInDue', 'checkInDueAt']) {
    assert.equal(Object.hasOwn(reviewer.recipients[0], field), false, `a reviewer is given no ${field}`);
  }
  refusedWith(await R.installations(B.member, releaseId), 404, 'E_NOT_FOUND', 'another company');
});

test('case 21: the check-in at day fourteen exactly, through the routes, cleared by a report', async () => {
  const { releaseId } = await releaseFor();
  ok(await R.download(A.member, releaseId), 200, 'the download');
  const membershipId = membershipOf(A.id, A.member);
  const rowOf = async () => {
    const body = ok(await R.catalog(A.member, A.id), 200, 'the catalog');
    return body.available.find((r) => r.releaseId === releaseId);
  };
  ageLedger(releaseId, membershipId, '13 days 23 hours');
  assert.equal((await rowOf()).my.checkInDue, false, 'thirteen days and twenty-three hours');
  ageLedger(releaseId, membershipId, '1 hour');
  const due = await rowOf();
  assert.equal(due.my.checkInDue, true, 'fourteen days exactly');
  assert.match(due.my.checkInDueAt, /^\d{4}-\d\d-\d\dT/);
  const release = ok(await R.releaseRead(A.member, releaseId), 200, 'the release read');
  assert.equal(release.my.checkInDue, true, 'E5D-C-F6: the same state on direct navigation');
  assert.deepEqual(release.download, { downloadable: true, blockedReason: null });
  ok(await R.report(A.member, releaseId, { status: 'pass' }), 201, 'the report');
  assert.equal((await rowOf()).my.checkInDue, false, 'a report clears it');
  ok(await R.download(A.member, releaseId), 200, 'a later download');
  assert.equal((await rowOf()).my.checkInDue, false, 'and a later download does not reopen it');
});

test('case 22: malformed and oversized input on the three writes, with no row written', async () => {
  const { releaseId } = await releaseFor();
  ok(await R.download(A.member, releaseId), 200, 'the download');
  const before = reportCount(releaseId);
  const big = 'x'.repeat(17000);
  const bodies = [
    [{ status: 'verified' }, 422, 'E_BODY_INVALID'],
    [{ status: 'pass', extra: 1 }, 422, 'E_BODY_INVALID'],
    [{ status: null }, 422, 'E_BODY_INVALID'],
    [{ status: 'pass', losses: 42 }, 422, 'E_BODY_INVALID'],
    [{ status: 'partial', losses: 'x'.repeat(2001) }, 422, 'E_BODY_INVALID'],
    [{ status: 'partial', losses: big }, 413, 'E_BODY_TOO_LARGE'],
  ];
  for (const [body, status, code] of bodies) {
    refusedWith(await R.report(A.member, releaseId, body), status, code, JSON.stringify(body).slice(0, 60));
  }
  refusedWith(
    await R.call('installationsCreate', {
      user: A.member,
      params: { releaseId },
      headers: { 'idempotency-key': 'not-a-uuid' },
      body: { status: 'pass' },
    }),
    422,
    'E_IDEMPOTENCY_KEY_INVALID',
    'a malformed key',
  );
  assert.equal(reportCount(releaseId), before, 'no row was written by any refusal');
  const bound = ok(
    await R.report(A.member, releaseId, { status: 'partial', losses: 'x'.repeat(2000), assistance: 'y'.repeat(2000) }),
    201,
    'valid input at both text bounds',
  );
  assert.equal(bound.report.losses.length, 2000);
});

test('3.3: a replayed report and witness answer the stored answer; another operation on the same key conflicts', async () => {
  const { releaseId } = await releaseFor();
  ok(await R.download(A.member, releaseId), 200, 'the download');
  const k = key();
  const first = ok(await R.report(A.member, releaseId, { status: 'pass' }, k), 201, 'the first report');
  const replay = await R.report(A.member, releaseId, { status: 'pass' }, k);
  assert.equal(replay.status, 201, replay.raw);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.report.reportId, first.report.reportId, 'the stored answer, not a second row');
  assert.equal(reportCount(releaseId), 1);
  refusedWith(
    await R.report(A.member, releaseId, { status: 'fail', losses: 'Different words.' }, k),
    409,
    'E_IDEMPOTENCY_CONFLICT',
    'another operation on the same key',
  );
  const kw = key();
  const w = ok(await R.witness(A.it, first.report.reportId, { status: 'pass', note: 'Confirmed.' }, kw), 201, 'witness');
  const wReplay = await R.witness(A.it, first.report.reportId, { status: 'pass', note: 'Confirmed.' }, kw);
  assert.equal(wReplay.body.idempotentReplay, true);
  assert.equal(wReplay.body.witness.witnessId, w.witness.witnessId);
  assert.equal(witnessCount(first.report.reportId), 1);
});

test('case 11: the two-hundredth authorization, and the catalog agreeing about the exhaustion (E5D-C-F2)', async () => {
  const { releaseId } = await releaseFor();
  const membershipId = membershipOf(A.id, A.member);
  const { fillLedger } = await import('./helpers.mjs');
  fillLedger(releaseId, membershipId, 199);
  const last = ok(await R.download(A.member, releaseId), 200, 'the two-hundredth');
  assert.equal(last.authorization.authorizations, 200);
  refusedWith(await R.download(A.member, releaseId), 409, 'E_DOWNLOAD_LIMIT', 'the two hundred and first');
  assert.equal(ledgerCount(releaseId, membershipId), 200);
  const body = ok(await R.catalog(A.member, A.id), 200, 'the catalog');
  const row = body.available.find((r) => r.releaseId === releaseId);
  assert.equal(row.blockedReason, 'E_DOWNLOAD_LIMIT', 'the list and the routine agree about exhaustion');
  assert.equal(row.downloadable, false);
});

/* E5S-C-F1, the critic's fixture built against the real routes (evidence/e5-server-critique-repro/adversarial.mjs.txt).
   The two reports are inserted owner-side, which is how a deliberate uuid order is produced at all: api.report_installation
   sets the id itself and a second report a millisecond later would order by chance. The older report carries the greater
   uuid, so any reader that takes a position out of api.installation_reports' uuid order picks the report that was
   overtaken. INSERT is not refused by the append-only trigger, and both rows are rows the routine itself could have
   written: same company, same release, same membership, a status and a source from the vocabularies. */
test('E5S-C-F1: the release read and the catalog name the same newest report, against the uuid order', async () => {
  const { releaseId } = await releaseFor();
  ok(await R.download(A.member, releaseId), 200, 'the recipient downloads');
  sql(`insert into app.installation_reports (id, company_id, release_id, membership_id, status, source, reported_at) values
    ('f0000000-0000-4000-8000-000000000001','${A.id}','${releaseId}','${A.ms.member}','pass','recipient_app','2026-09-01T10:00:00Z'),
    ('10000000-0000-4000-8000-000000000001','${A.id}','${releaseId}','${A.ms.member}','removed','recipient_app','2026-09-02T10:00:00Z')`);
  assert.equal(reportCount(releaseId), 2, 'both rows are the routine\'s own shape and were written');
  assert.equal(
    sql(`select string_agg(status, ',' order by id) from app.installation_reports where release_id='${releaseId}'`),
    'removed,pass',
    'and in the id order the read uses, the older pass is the last row',
  );

  const detail = ok(await R.releaseRead(A.member, releaseId), 200, 'the release read');
  const row = ok(await R.catalog(A.member, A.id), 200, 'the catalog').available.find((x) => x.releaseId === releaseId);
  assert.equal(detail.my.lastReport.status, 'removed', 'the release read names the report with the greatest reported_at');
  assert.equal(row.my.lastReport.status, 'removed', 'and so does the catalog');
  assert.equal(detail.my.lastReport.reportId, row.my.lastReport.reportId, 'the same report, not two readings of one list');
  assert.equal(detail.my.lastReport.reportedAt, '2026-09-02T10:00:00.000Z');
  /* And the check-in, which any report clears whatever its order, still agrees with both. */
  assert.equal(detail.my.checkInDue, false);
  assert.equal(row.my.checkInDue, false);
});

test('case 24 fail-before: the one predicate door written security invoker makes the catalog fail closed', async () => {
  const { releaseId } = await releaseFor();
  ok(await R.catalog(A.member, A.id), 200, 'the control, with the accepted definer door');
  sql('alter function app.download_refusal(uuid) security invoker');
  try {
    const r = await R.catalog(A.member, A.id);
    assert.deepEqual([r.status, r.body?.code], [500, 'E_INTERNAL'], `the mutant: ${r.raw}`);
    const read = await R.releaseRead(A.member, releaseId);
    assert.deepEqual([read.status, read.body?.code], [500, 'E_INTERNAL'], `and the release read: ${read.raw}`);
  } finally {
    sql('alter function app.download_refusal(uuid) security definer');
  }
  ok(await R.catalog(A.member, A.id), 200, 'and the accepted door restored, the catalog answers again');
});

test('1.3: a member of no group reads an empty catalog with its reason, and one of a group with no release reads another', async () => {
  const C = await reviewCompany(W, R, 'c');
  const lonely = W.user('c-lonely');
  W.member(C.id, lonely);
  const noGroups = ok(await R.catalog(lonely, C.id), 200, 'a member of no group');
  assert.deepEqual([noGroups.available.length, noGroups.earlier.length], [0, 0]);
  assert.equal(noGroups.empty, 'no_groups');
  const inGroup = ok(await R.catalog(C.member, C.id), 200, 'a member of a group with no release');
  assert.equal(inGroup.empty, 'none_for_my_groups');
  await published(R, C);
  const withRelease = ok(await R.catalog(C.member, C.id), 200, 'and once a release exists');
  assert.equal(withRelease.empty, null);
  assert.equal(withRelease.available.length, 1);
});
