/* The twelve E4 routes against the running local stack (E4 design 3.4, 3.5 and section 5): each route's answer for its
   reader, then case 42 (malformed input on every route, and valid input at each bound), case 43 (a member of another
   company on every route, with both companies' rows locked by another connection) and case 44 (a member removed between
   the service's read and its call on each write, then the reads). Reseeds once through tests/db/00-seed.sh and builds its
   own users and companies. Run one file at a time: node --test --test-concurrency=1 tests/e4/stack/ */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activePolicyId,
  approveBoth,
  auditsOf,
  count,
  e3lib,
  e4routes,
  e4world,
  enableTargets,
  envelopeFor,
  key,
  psqlSession,
  published,
  reseed,
  reviewCompany,
  sql,
  submitted,
  waitFor,
  withFetch,
} from './helpers.mjs';

const ids = reseed();
enableTargets();
const R = await e4routes();
const W = e4world('routes', ids);
const A = await reviewCompany(W, R, 'a');
const B = await reviewCompany(W, R, 'b');

const refusedWith = (r, status, code, label) => {
  assert.deepEqual([r.status, r.body?.code], [status, code], `${label}: ${r.raw}`);
  assert.deepEqual(Object.keys(r.body).sort(), ['code', 'message', 'ok'], `${label}: no database details forwarded`);
};
const CR = String.fromCharCode(13);
const NUL = String.fromCharCode(0);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const RLO = String.fromCharCode(0x202e);

test('the twelve routes: each answers its reader in its own shape', async () => {
  const { candidateId } = await submitted(R, A);
  const queue = await R.queue(A.it, A.id);
  assert.equal(queue.status, 200, queue.raw);
  assert.equal(queue.body.awaitingDecision.find((c) => c.candidateId === candidateId)?.viewerExcluded, false);

  const policyId = activePolicyId();
  const created = await R.envelope(A.author, candidateId, { target: 'claude-ai', audienceGroupIds: [A.groupId], policyId });
  assert.deepEqual([created.status, created.body.existing, created.body.envelope.status], [201, false, 'open'], created.raw);
  const envelopeId = created.body.envelope.envelopeId;
  assert.ok(created.body.envelope.assembledBytes > 0, 'the envelope carries its projected assembly size');
  const same = await R.envelope(A.author, candidateId, {
    target: 'claude-ai',
    audienceGroupIds: [A.groupId.toUpperCase()],
    policyId,
  });
  assert.deepEqual(
    [same.status, same.body.existing, same.body.envelope.envelopeId],
    [200, true, envelopeId],
    'the same binding under a fresh key and an upper-case id: the existing envelope',
  );

  const read = await R.reviewRead(A.it, candidateId);
  assert.equal(read.status, 200, read.raw);
  assert.deepEqual(read.body.viewer.mayApproveAs, ['it']);
  assert.deepEqual(
    read.body.envelopes.map((e) => e.envelopeId),
    [envelopeId],
  );
  assert.ok(Array.isArray(read.body.losses.rows), 'the losses table renders');

  const it = await R.review(A.it, candidateId, { envelopeId, role: 'it', decision: 'approved', reason: 'IT checked it.' });
  assert.deepEqual([it.status, it.body.candidateState, it.body.envelopeStatus, it.body.review.role], [201, 'submitted', 'open', 'it'], it.raw);
  const business = await R.review(A.business, candidateId, {
    envelopeId,
    role: 'business',
    decision: 'approved',
    reason: 'Business checked it.',
  });
  assert.deepEqual([business.status, business.body.candidateState, business.body.envelopeStatus], [201, 'approved', 'approved'], business.raw);

  refusedWith(await R.publish(A.admin, candidateId, envelopeId), 403, 'E_ADMIN_MFA_REQUIRED', 'publication at aal1');
  const pub = await R.publish(A.adminHi, candidateId, envelopeId);
  assert.deepEqual([pub.status, pub.body.existing, pub.body.release.current, pub.body.release.target], [201, false, true, 'claude-ai'], pub.raw);
  assert.deepEqual(pub.body.superseded, { releaseIds: [], candidateIds: [] });
  const releaseId = pub.body.release.releaseId;
  const again = await R.publish(A.adminHi, candidateId, envelopeId);
  assert.deepEqual([again.status, again.body.existing, again.body.release.releaseId], [200, true, releaseId], 'a fresh key: the current release');

  const byAdmin = await R.releaseRead(A.admin, releaseId);
  assert.equal(byAdmin.status, 200, byAdmin.raw);
  assert.deepEqual([byAdmin.body.envelope.envelopeId, byAdmin.body.reviews.length, byAdmin.body.recipientCount], [envelopeId, 2, 0]);
  assert.equal(byAdmin.raw.includes('assembledContent'), false, 'no route answers assembled content');
  /* E5 design 1.1 and 1.8: migration 007 widened app.release_visible_to with the audience arm E4 3.6 reserved for it,
     so E4 3.1's cell "Read releases (no assembled content): member 404" is now "releases addressed to my groups". The
     member still reads no envelope, no review reason and no ledger; tests/e5/stack holds the new fields. */
  const byMember = await R.releaseRead(A.member, releaseId);
  assert.equal(byMember.status, 200, byMember.raw);
  assert.deepEqual(
    [byMember.body.envelope, byMember.body.reviews, byMember.body.recipients, byMember.body.recipientCount],
    [null, null, null, null],
    'an audience member reads the release and none of its review evidence',
  );
  assert.equal(byMember.raw.includes('assembledContent'), false, 'and no route answers assembled content');
  const listed = await R.releasesList(A.it, A.id, { state: 'published' });
  assert.equal(listed.status, 200, listed.raw);
  assert.ok(listed.body.releases.some((r) => r.releaseId === releaseId));
  refusedWith(await R.releasesList(A.it, A.id, { state: 'revoked' }), 422, 'E_BODY_INVALID', 'a state outside the vocabulary');

  const withdrawn = await R.withdraw(A.adminHi, releaseId, 'The report format changed.');
  assert.deepEqual(
    [withdrawn.status, withdrawn.body.release.state, withdrawn.body.recipientCount, withdrawn.body.revokesCopies],
    [200, 'withdrawn', 0, false],
    withdrawn.raw,
  );

  const groups = await R.groupsList(A.member, A.id);
  assert.equal(groups.status, 200, groups.raw);
  assert.deepEqual(groups.body.groups.find((g) => g.groupId === A.groupId)?.memberIds, [A.ms.member]);
  const made = await R.groupsCreate(A.adminHi, A.id, `Second ${W.run}`);
  assert.deepEqual([made.status, made.body.changed], [201, true], made.raw);
  const added = [await R.memberAdd(A.adminHi, A.id, made.body.groupId, A.ms.it), await R.memberAdd(A.adminHi, A.id, made.body.groupId, A.ms.it)];
  assert.deepEqual(
    added.map((r) => [r.status, r.body.changed]),
    [
      [200, true],
      [200, false],
    ],
  );
  const removed = [
    await R.memberRemove(A.adminHi, A.id, made.body.groupId, A.ms.it),
    await R.memberRemove(A.adminHi, A.id, made.body.groupId, A.ms.it),
  ];
  assert.deepEqual(
    removed.map((r) => [r.status, r.body.changed]),
    [
      [200, true],
      [200, false],
    ],
  );
});

test('case 42: malformed input on every E4 route answers the status and code of 3.5, writes nothing and forwards no database details; valid input at each bound succeeds', async () => {
  const { candidateId } = await submitted(R, A);
  const envelopeId = await envelopeFor(R, A, candidateId);
  const release = await published(R, A);
  const policyId = activePolicyId();
  const groups21 = [];
  for (let i = 0; i < 21; i++) {
    const g = await R.groupsCreate(A.adminHi, A.id, `Bound ${i} ${W.run}`);
    assert.equal(g.status, 201, g.raw);
    groups21.push(g.body.groupId);
  }
  const snapshot = () => [
    auditsOf(A.id),
    count('app.idempotency_keys'),
    count(`app.review_envelopes where candidate_id='${candidateId}'`),
    count(`app.reviews where candidate_id='${candidateId}'`),
    sql(`select state from app.releases where id='${release.releaseId}'`),
    count(`app.groups where company_id='${A.id}'`),
  ];
  const before = snapshot();

  const bad = 'not-a-uuid';
  const nonUuid = [
    ['reviewQueue', { companyId: bad }],
    ['reviewRead', { candidateId: bad }],
    ['envelopesCreate', { candidateId: bad }],
    ['reviewsCreate', { candidateId: bad }],
    ['releasesPublish', { candidateId: bad }],
    ['releasesWithdraw', { releaseId: bad }],
    ['releasesRead', { releaseId: bad }],
    ['releasesList', { companyId: bad }],
    ['groupsList', { companyId: bad }],
    ['groupsCreate', { companyId: bad }],
    ['groupMembersAdd', { companyId: A.id, groupId: bad, membershipId: A.ms.it }],
    ['groupMembersRemove', { companyId: A.id, groupId: A.groupId, membershipId: bad }],
  ];
  const bodyRoutes = new Set(['envelopesCreate', 'reviewsCreate', 'releasesPublish', 'releasesWithdraw', 'groupsCreate']);
  for (const [name, params] of nonUuid) {
    const r = await R.call(name, {
      user: A.adminHi,
      params,
      headers: { 'idempotency-key': key() },
      ...(bodyRoutes.has(name) ? { body: {} } : {}),
    });
    refusedWith(r, 404, 'E_NOT_FOUND', `${name}: a route id that is not a uuid`);
  }

  const bodies = [
    ['envelopesCreate', { candidateId }, { target: 'claude-ai', audienceGroupIds: [A.groupId], policyId }, A.author, true],
    ['reviewsCreate', { candidateId }, { envelopeId, role: 'it', decision: 'approved', reason: 'Fine.' }, A.it, true],
    ['releasesPublish', { candidateId }, { envelopeId }, A.adminHi, true],
    ['releasesWithdraw', { releaseId: release.releaseId }, { reason: 'Fine.' }, A.adminHi, true],
    ['groupsCreate', { companyId: A.id }, { name: `Refused ${W.run}` }, A.adminHi, false],
  ];
  for (const [name, params, body, user, keyed] of bodies) {
    const headers = { 'idempotency-key': key() };
    if (keyed) {
      refusedWith(await R.call(name, { user, params, body }), 422, 'E_IDEMPOTENCY_KEY_INVALID', `${name}: no Idempotency-Key`);
      refusedWith(
        await R.call(name, { user, params, headers: { 'idempotency-key': 'abc' }, body }),
        422,
        'E_IDEMPOTENCY_KEY_INVALID',
        `${name}: a key that is not a uuid`,
      );
    }
    refusedWith(await R.call(name, { user, params, headers, body: { ...body, extra: true } }), 422, 'E_BODY_INVALID', `${name}: an extra key`);
    const mistyped = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? 7 : 'x']));
    refusedWith(await R.call(name, { user, params, headers, body: mistyped }), 422, 'E_BODY_INVALID', `${name}: mistyped values`);
    refusedWith(
      await R.call(name, { user, params, headers, body: JSON.stringify(body), contentType: 'text/markdown' }),
      415,
      'E_UNSUPPORTED_MEDIA_TYPE',
      `${name}: text/markdown on a JSON route`,
    );
    const shell = JSON.stringify({ ...body, pad: '' });
    const padded = JSON.stringify({ ...body, pad: 'x'.repeat(16385 - Buffer.byteLength(shell)) });
    assert.equal(Buffer.byteLength(padded), 16385);
    refusedWith(await R.call(name, { user, params, headers, body: padded }), 413, 'E_BODY_TOO_LARGE', `${name}: 16,385 bytes`);
  }

  const reasons = [
    ['2,001 code points', 'é'.repeat(2001)],
    ['white space only', '  \t  '],
    ['a carriage return', `Line one.${CR}Line two.`],
    ['a NUL', `Before${NUL}after.`],
    ['a lone surrogate', `Broken ${LONE_SURROGATE} text.`],
  ];
  for (const [label, reason] of reasons) {
    refusedWith(
      await R.review(A.it, candidateId, { envelopeId, role: 'it', decision: 'approved', reason }),
      422,
      'E_BODY_INVALID',
      `a review reason of ${label}`,
    );
    refusedWith(await R.withdraw(A.adminHi, release.releaseId, reason), 422, 'E_BODY_INVALID', `a withdrawal reason of ${label}`);
  }
  refusedWith(
    await R.envelope(A.author, candidateId, { target: 'chatgpt', audienceGroupIds: groups21, policyId }),
    422,
    'E_BODY_INVALID',
    '21 audience groups',
  );
  refusedWith(
    await R.envelope(A.author, candidateId, { target: 'chatgpt', audienceGroupIds: [A.groupId, A.groupId.toUpperCase()], policyId }),
    422,
    'E_BODY_INVALID',
    'a duplicated group',
  );
  refusedWith(await R.groupsCreate(A.adminHi, A.id, 'n'.repeat(81)), 422, 'E_BODY_INVALID', 'a group name of 81 code points');
  refusedWith(await R.groupsCreate(A.adminHi, A.id, `Right${RLO}left`), 422, 'E_BODY_INVALID', 'a group name holding U+202E');
  const direct = e3lib('envelope "$1" "$2" chatgpt "$3"', A.author.id, candidateId, `{"group_ids": ["${A.groupId}"]}`);
  assert.match(direct, /22023/, 'an audience text not in canonical form, straight to the routine under a bound bearer');
  assert.match(direct, /E_BODY_INVALID/);
  assert.deepEqual(snapshot(), before, 'no audit row, claim, envelope, review, release change or group from any refusal');

  const bound = await R.envelope(A.author, candidateId, { target: 'chatgpt', audienceGroupIds: groups21.slice(0, 20), policyId });
  assert.equal(bound.status, 201, `control: 20 audience groups: ${bound.raw}`);
  const reason = 'é'.repeat(2000);
  const signed = await R.review(A.it, candidateId, {
    envelopeId: bound.body.envelope.envelopeId,
    role: 'it',
    decision: 'approved',
    reason,
  });
  assert.deepEqual([signed.status, signed.body.review?.reason], [201, reason], `control: a reason of 2,000 code points: ${signed.raw}`);
  const named = await R.groupsCreate(A.adminHi, A.id, 'n'.repeat(80));
  assert.equal(named.status, 201, `control: a group name of 80 code points: ${named.raw}`);
});

test('case 43: a member of another company on every E4 route answers 404 E_NOT_FOUND, writes nothing and waits on no lock, each under one second', async (t) => {
  const { candidateId } = await submitted(R, A);
  const envelopeId = await envelopeFor(R, A, candidateId);
  const release = await published(R, A, 'chatgpt');
  const policyId = activePolicyId();
  const calls = [
    ['reviewQueue', { params: { companyId: A.id } }],
    ['reviewRead', { params: { candidateId } }],
    ['envelopesCreate', { params: { candidateId }, body: { target: 'generic', audienceGroupIds: [A.groupId], policyId } }],
    ['reviewsCreate', { params: { candidateId }, body: { envelopeId, role: 'it', decision: 'approved', reason: 'Outsider.' } }],
    ['releasesPublish', { params: { candidateId }, body: { envelopeId } }],
    ['releasesWithdraw', { params: { releaseId: release.releaseId }, body: { reason: 'Outsider.' } }],
    ['releasesRead', { params: { releaseId: release.releaseId } }],
    ['releasesList', { params: { companyId: A.id } }],
    ['groupsList', { params: { companyId: A.id } }],
    ['groupsCreate', { params: { companyId: A.id }, body: { name: `Outsider ${W.run}` } }],
    ['groupMembersAdd', { params: { companyId: A.id, groupId: A.groupId, membershipId: A.ms.it } }],
    ['groupMembersRemove', { params: { companyId: A.id, groupId: A.groupId, membershipId: A.ms.member } }],
  ];
  const snapshot = () => [auditsOf(A.id), auditsOf(B.id), count('app.idempotency_keys'), count(`app.group_members where group_id='${A.groupId}'`)];
  /* An ordinary user's token is a real password sign-in, made lazily on first use (tests/e3/stack/helpers.mjs), and an
     aal2 token is minted locally. So the first timed call by B.it carried a GoTrue sign-in inside its one second, and
     the bound held only on a quiet machine: 1,952 ms inside the full suite on 443a4ec and 1,045 ms alone, both
     "reviewQueue by b-it", the identity's first call. Every session is made before the first timed call (E5P-F6's
     lesson, which the E5 capacity sample already follows); the sign-in's own time is recorded, not bounded. */
  for (const outsider of [B.adminHi, B.it]) {
    const t0 = performance.now();
    outsider.token();
    t.diagnostic(`case 43 session for ${outsider.who} made in ${(performance.now() - t0).toFixed(0)} ms, outside every timed call`);
  }
  const run = async (label) => {
    const before = snapshot();
    for (const [name, args] of calls) {
      for (const outsider of [B.adminHi, B.it]) {
        const t0 = performance.now();
        const r = await R.call(name, { user: outsider, headers: { 'idempotency-key': key() }, ...args });
        const ms = performance.now() - t0;
        refusedWith(r, 404, 'E_NOT_FOUND', `${label}: ${name} by ${outsider.who}`);
        assert.ok(ms < 1000, `${label}: ${name} by ${outsider.who} answered in ${ms.toFixed(0)} ms`);
      }
    }
    assert.deepEqual(snapshot(), before, `${label}: no audit row, no claim, no group change`);
  };
  await run('no lock held');
  const holder = psqlSession();
  holder.write('begin;');
  holder.write(`select 'HELD|' || count(*) from (select id from app.companies where id in ('${A.id}', '${B.id}') for no key update) x;`);
  try {
    await waitFor(() => holder.output().includes('HELD|2'), 'both company rows locked');
    await run('both company rows locked by another connection');
  } finally {
    holder.write('commit;');
    await holder.end();
  }
  const own = await R.memberAdd(A.adminHi, A.id, A.groupId, A.ms.it);
  assert.deepEqual([own.status, own.body.changed], [200, true], 'control: the own company succeeds');
  assert.equal((await R.reviewRead(A.it, candidateId)).status, 200, 'control: the own company reads');
});

test('case 44: a member removed between the service read and its call: the routine answers 404 on each write and nothing is written; then every read 404', async () => {
  const { candidateId } = await submitted(R, A);
  const openEnvelope = await envelopeFor(R, A, candidateId, 'claude-ai');
  const approvedEnvelope = await envelopeFor(R, A, candidateId, 'chatgpt');
  await approveBoth(R, A, candidateId, approvedEnvelope);
  const release = await published(R, A, 'claude-code');
  const policyId = activePolicyId();
  const writes = [
    ['create_envelope', '{it_reviewer,member}', (u) => R.envelope(u, candidateId, { target: 'generic', audienceGroupIds: [A.groupId], policyId })],
    ['record_review', '{it_reviewer,member}', (u) => R.review(u, candidateId, { envelopeId: openEnvelope, role: 'it', decision: 'approved', reason: 'Removed.' })],
    ['publish_release', '{company_admin,member}', (u) => R.publish(u, candidateId, approvedEnvelope)],
    ['withdraw_release', '{company_admin,member}', (u) => R.withdraw(u, release.releaseId, 'Removed.')],
    ['create_group', '{company_admin,member}', (u) => R.groupsCreate(u, A.id, `Removed ${W.run}`)],
    ['add_group_member', '{company_admin,member}', (u) => R.memberAdd(u, A.id, A.groupId, A.ms.business)],
    ['remove_group_member', '{company_admin,member}', (u) => R.memberRemove(u, A.id, A.groupId, A.ms.member)],
  ];
  const snapshot = () => [
    auditsOf(A.id),
    count('app.idempotency_keys'),
    count(`app.review_envelopes where candidate_id='${candidateId}'`),
    count(`app.reviews where candidate_id='${candidateId}'`),
    count(`app.releases where candidate_id='${candidateId}'`),
    sql(`select state from app.releases where id='${release.releaseId}'`),
    count(`app.groups where company_id='${A.id}'`),
    count(`app.group_members where group_id='${A.groupId}'`),
  ];
  for (const [fn, roles, write] of writes) {
    const person = W.user(`removed-${fn.replaceAll('_', '-')}`);
    const membership = W.member(A.id, person, roles);
    const user = roles.includes('company_admin') ? W.aal2(person) : person;
    assert.equal((await R.groupsList(user, A.id)).status, 200, `${fn}: control, the same user reads before removal`);
    const before = snapshot();
    let removedAtCall = false;
    const r = await withFetch((url, init, original) => {
      if (String(url).endsWith(`/rest/v1/rpc/${fn}`)) {
        sql(`update app.memberships set status='removed', removed_at=now() where id='${membership}'`);
        removedAtCall = true;
      }
      return original(url, init);
    }, () => write(user));
    assert.equal(removedAtCall, true, `${fn}: the service read passed and the removal landed before its call`);
    refusedWith(r, 404, 'E_NOT_FOUND', `${fn}: removed between the read and the call`);
    assert.deepEqual(snapshot(), before, `${fn}: nothing written`);
    const reads = [
      ['reviewQueue', () => R.queue(user, A.id)],
      ['reviewRead', () => R.reviewRead(user, candidateId)],
      ['releasesRead', () => R.releaseRead(user, release.releaseId)],
      ['releasesList', () => R.releasesList(user, A.id)],
      ['groupsList', () => R.groupsList(user, A.id)],
    ];
    for (const [name, read] of reads) refusedWith(await read(), 404, 'E_NOT_FOUND', `${fn}: ${name} after removal`);
  }
});
