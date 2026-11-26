/* The E4 services without a stack (E4 design 3.5, the S rows of each table): request order, the no-call guarantee of
   every service refusal, what each call binds, and the answers. tests/e3/unit/fake-postgrest.mjs is the PostgREST double
   and the verified session; the stack files are where the routines answer. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  AGENT,
  CANDIDATE,
  COMPANY,
  fakeDb,
  GATE_ID,
  gateRow,
  KEY,
  MEMBERSHIP,
  manifest,
  OTHER_IDENTITY,
  OTHER_MEMBERSHIP,
  refusal,
  STORED_AT,
  session,
  X,
} from '../../e3/unit/fake-postgrest.mjs';
import { REPO } from '../../e3/unit/helpers.mjs';

const { installerText, PLACEHOLDER, readText } = await import('../../../lib/passport/assemble.mjs');
const { gate } = await import('../../../lib/passport/gate.mjs');
const { assembledSha256 } = await import('../../../lib/passport/packet.mjs');
const { EXCLUDING_KINDS, REVIEW_ROLES } = await import('../../../lib/rules/reviews.mjs');
const { VERDICT_CORPUS } = await import('../fixtures/status-and-verdict-corpus.mjs');
const reviews = await import('../../../lib/services/reviews.mjs');
const releases = await import('../../../lib/services/releases.mjs');
const groups = await import('../../../lib/services/groups.mjs');

const VENDOR = join(REPO, 'vendor/passport');
const SYNTHETIC = readText(join(REPO, 'tests/native-transfer/passport/fixtures/SYNTHETIC-passport.md'));
const EMPTY = readFileSync(join(REPO, 'tests/passport/fixtures/synthetic-empty.md'), 'utf8');
const ENVELOPE = '11111111-2222-4333-8444-555555555555';
const RELEASE = '22222222-3333-4444-8555-666666666666';
const POLICY = '33333333-4444-4555-8666-777777777777';
const GROUP_A = 'a0000000-0000-4000-8000-000000000001';
const GROUP_B = 'b0000000-0000-4000-8000-000000000002';
const REVIEW = '44444444-5555-4666-8777-888888888888';
const sha = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const hex = (h) => `${X}${h}`;

const stored = (text) => {
  const g = gate(Buffer.from(text, 'utf8'), 'text/markdown', { validatedAt: STORED_AT });
  assert.equal(g.ok, true);
  return { content: g.text, derived_canonical: g.derivedCanonical };
};
const candidateRow = (over = {}) => ({ id: CANDIDATE, state: 'submitted', ...stored(SYNTHETIC), ...over });
const policyRow = { id: POLICY, version: 1, sha256: hex('d'.repeat(64)), active: true };
const envelopeRow = (over = {}) => ({
  id: ENVELOPE,
  candidate_id: CANDIDATE,
  revision: 1,
  target: 'claude-ai',
  audience_group_ids: [GROUP_A],
  policy_id: POLICY,
  policy_sha256: hex('d'.repeat(64)),
  gate_id: GATE_ID,
  gate_identity_sha256: hex(manifest.GATE_IDENTITY_SHA256),
  installer_text_sha256: hex('1'.repeat(64)),
  core_sha256: hex('2'.repeat(64)),
  branch_sha256: hex('3'.repeat(64)),
  judge_sha256: hex('4'.repeat(64)),
  content_sha256: hex('a'.repeat(64)),
  derived_sha256: hex('b'.repeat(64)),
  envelope_sha256: hex('e'.repeat(64)),
  assembled_bytes: 64621,
  status: 'open',
  created_by_membership_id: MEMBERSHIP,
  created_at: '2026-09-15T09:12:03.114+00:00',
  ...over,
});
const releaseRow = (over = {}) => ({
  id: RELEASE,
  company_id: COMPANY,
  agent_id: AGENT,
  candidate_id: CANDIDATE,
  envelope_id: ENVELOPE,
  target: 'claude-ai',
  gate_id: GATE_ID,
  content_sha256: hex('a'.repeat(64)),
  derived_sha256: hex('b'.repeat(64)),
  installer_text_sha256: hex('1'.repeat(64)),
  core_sha256: hex('2'.repeat(64)),
  branch_sha256: hex('3'.repeat(64)),
  judge_sha256: hex('4'.repeat(64)),
  policy_id: POLICY,
  policy_sha256: hex('d'.repeat(64)),
  audience_group_ids: [GROUP_A],
  envelope_sha256: hex('e'.repeat(64)),
  assembled_sha256: hex('f'.repeat(64)),
  assembled_bytes: 64621,
  state: 'published',
  published_by_membership_id: MEMBERSHIP,
  published_at: '2026-09-15T10:00:00.000+00:00',
  superseded_by_release_id: null,
  superseded_at: null,
  withdrawn_by_membership_id: null,
  withdrawn_at: null,
  withdrawal_reason: null,
  ...over,
});
const text = (target) => installerText(VENDOR, `${target}.md`);
const rpcs = (calls) => calls.filter((c) => c.rpc);

/* ---------- createEnvelope ---------- */

const envelopeBody = (over = {}) => ({ target: 'claude-ai', audienceGroupIds: [GROUP_B, GROUP_A], policyId: POLICY, ...over });
const envelopeDb = (over = {}) =>
  fakeDb({
    tables: {
      candidate_versions: [candidateRow()],
      installer_texts: [{ text: text('claude-ai') }],
      review_envelopes: [envelopeRow()],
      reviews: [],
      release_policies: [policyRow],
      ...over.tables,
    },
    rpc: over.rpc ?? (() => ({ envelope_id: ENVELOPE, existing: false, idempotent_replay: false })),
  });

test('createEnvelope row 10: a missing or malformed Idempotency-Key, before anything is read', async () => {
  for (const idempotencyKey of [undefined, '', 'nope', `${KEY}x`]) {
    const db = envelopeDb();
    await assert.rejects(
      reviews.createEnvelope(session, { candidateId: CANDIDATE, idempotencyKey, body: envelopeBody() }, db.options),
      refusal('E_IDEMPOTENCY_KEY_INVALID'),
    );
    assert.equal(db.calls.length, 0);
  }
});

test('createEnvelope row 11: every malformed body is E_BODY_INVALID with nothing read', async () => {
  const bodies = [
    null,
    [],
    envelopeBody({ extra: 1 }),
    envelopeBody({ target: 'copilot' }),
    envelopeBody({ target: null }),
    envelopeBody({ audienceGroupIds: [] }),
    envelopeBody({ audienceGroupIds: GROUP_A }),
    envelopeBody({ audienceGroupIds: Array.from({ length: 21 }, (_, i) => `a0000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }),
    envelopeBody({ audienceGroupIds: [GROUP_A, GROUP_A.toUpperCase()] }),
    envelopeBody({ audienceGroupIds: ['not-a-uuid'] }),
    envelopeBody({ policyId: 'nope' }),
    { target: 'claude-ai', audienceGroupIds: [GROUP_A] },
  ];
  for (const body of bodies) {
    const db = envelopeDb();
    await assert.rejects(
      reviews.createEnvelope(session, { candidateId: CANDIDATE, idempotencyKey: KEY, body }, db.options),
      refusal('E_BODY_INVALID'),
      JSON.stringify(body),
    );
    assert.equal(db.calls.length, 0, JSON.stringify(body));
  }
});

test('createEnvelope rows 12 and 12a: an unreadable candidate is E_NOT_FOUND and a draft E_NOT_REVIEWABLE (E4D-C-F2), neither replayed nor called', async () => {
  let db = envelopeDb({ tables: { candidate_versions: [] } });
  await assert.rejects(
    reviews.createEnvelope(session, { candidateId: CANDIDATE, idempotencyKey: KEY, body: envelopeBody() }, db.options),
    refusal('E_NOT_FOUND'),
  );
  assert.deepEqual(db.calls.map((c) => c.read ?? c.rpc), ['candidate_versions']);
  db = envelopeDb({ tables: { candidate_versions: [candidateRow({ state: 'draft' })] } });
  await assert.rejects(
    reviews.createEnvelope(session, { candidateId: CANDIDATE, idempotencyKey: KEY, body: envelopeBody() }, db.options),
    refusal('E_NOT_REVIEWABLE'),
  );
  assert.deepEqual(db.calls.map((c) => c.read ?? c.rpc), ['candidate_versions']);
});

test('createEnvelope rows 13 and 14: stored bytes the gate refuses, or whose derived bytes changed, are refused before any call', async () => {
  const good = stored(SYNTHETIC);
  let db = envelopeDb({ tables: { candidate_versions: [candidateRow({ content: 'not a passport' })] } });
  await assert.rejects(
    reviews.createEnvelope(session, { candidateId: CANDIDATE, idempotencyKey: KEY, body: envelopeBody() }, db.options),
    refusal('E_GATE_FAILS_NOW'),
  );
  assert.equal(rpcs(db.calls).length, 0);
  const other = SYNTHETIC.replace('It runs when you paste records and ask it to run.', 'It runs on request.');
  db = envelopeDb({
    tables: { candidate_versions: [candidateRow({ content: other, derived_canonical: good.derived_canonical })] },
  });
  await assert.rejects(
    reviews.createEnvelope(session, { candidateId: CANDIDATE, idempotencyKey: KEY, body: envelopeBody() }, db.options),
    refusal('E_DERIVED_CHANGED'),
  );
  assert.equal(rpcs(db.calls).length, 0);
});

test('createEnvelope row 14a (E4D-C-F3): eight placeholders for claude-code are E_ASSEMBLY_TOO_LARGE before any call', async () => {
  const eight = `${EMPTY}\n${Array(7).fill(PLACEHOLDER).join('\n')}\n`;
  const db = envelopeDb({
    tables: { candidate_versions: [candidateRow(stored(eight))], installer_texts: [{ text: text('claude-code') }] },
  });
  await assert.rejects(
    reviews.createEnvelope(
      session,
      { candidateId: CANDIDATE, idempotencyKey: KEY, body: envelopeBody({ target: 'claude-code' }) },
      db.options,
    ),
    refusal('E_ASSEMBLY_TOO_LARGE'),
  );
  assert.equal(rpcs(db.calls).length, 0);
  const installerRead = db.calls.find((c) => c.read === 'installer_texts');
  assert.deepEqual(installerRead.params, { select: 'text', gate_id: `eq.${GATE_ID}`, target: 'eq.claude-code' });
});

test('createEnvelope binds the canonical audience, sorted and lowercased, the three choices and this build s identity; answers the envelope object', async () => {
  const db = envelopeDb();
  const r = await reviews.createEnvelope(
    session,
    {
      candidateId: CANDIDATE,
      idempotencyKey: KEY.toUpperCase(),
      body: envelopeBody({ audienceGroupIds: [GROUP_B.toUpperCase(), GROUP_A] }),
    },
    db.options,
  );
  const [call] = rpcs(db.calls);
  assert.equal(call.rpc, 'create_envelope');
  assert.equal(call.claims.fn, 'create_envelope');
  assert.deepEqual(call.body, {
    p_candidate: CANDIDATE,
    p_target: 'claude-ai',
    p_audience_canonical: `{"group_ids":["${GROUP_A}","${GROUP_B}"]}`,
    p_policy: POLICY,
    p_gate_identity: hex(manifest.GATE_IDENTITY_SHA256),
    p_idempotency_key: KEY,
  });
  assert.deepEqual(
    db.calls.map((c) => c.read ?? c.rpc).slice(0, 4),
    ['candidate_versions', 'gate_identities', 'installer_texts', 'create_envelope'],
  );
  assert.equal(r.existing, false);
  assert.equal(r.idempotentReplay, undefined);
  assert.deepEqual(Object.keys(r.envelope).sort(), [
    'approvals',
    'assembledBytes',
    'audience',
    'candidateId',
    'changeRequest',
    'contentSha256',
    'createdAt',
    'createdByMembershipId',
    'derivedSha256',
    'envelopeId',
    'envelopeSha256',
    'gate',
    'installer',
    'policy',
    'revision',
    'status',
    'target',
  ]);
  assert.deepEqual(r.envelope.policy, { policyId: POLICY, version: 1, sha256: 'd'.repeat(64), policyStatus: 'current' });
  assert.deepEqual(r.envelope.gate, { gateIdentitySha256: manifest.GATE_IDENTITY_SHA256, gateStatus: 'current' });
  assert.equal(r.envelope.createdAt, '2026-09-15T09:12:03.114Z');
});

test('createEnvelope: under an identity not this build s no installer text is read and the routine decides; a replay says so', async () => {
  const db = envelopeDb({
    tables: { gate_identities: [gateRow({ identity_sha256: hex(OTHER_IDENTITY) })] },
    rpc: () => ({ envelope_id: ENVELOPE, existing: true, idempotent_replay: true }),
  });
  const r = await reviews.createEnvelope(session, { candidateId: CANDIDATE, idempotencyKey: KEY, body: envelopeBody() }, db.options);
  assert.equal(db.calls.some((c) => c.read === 'installer_texts'), false);
  assert.equal(rpcs(db.calls).length, 1);
  assert.equal(r.existing, true);
  assert.equal(r.idempotentReplay, true);
});

/* ---------- recordReview ---------- */

const reviewBody = (over = {}) => ({
  envelopeId: ENVELOPE,
  role: 'it',
  decision: 'approved',
  reason: '  Reads internal weekly reports only.  ',
  ...over,
});
const reviewDb = (over = {}) =>
  fakeDb({
    tables: {
      candidate_versions: [candidateRow()],
      review_envelopes: [{ id: ENVELOPE }],
      reviews: [
        {
          id: REVIEW,
          candidate_id: CANDIDATE,
          envelope_id: ENVELOPE,
          role: 'it',
          decision: 'approved',
          reviewer_membership_id: MEMBERSHIP,
          reason: 'Reads internal weekly reports only.',
          created_at: '2026-09-15T09:30:00.000+00:00',
        },
      ],
      ...over.tables,
    },
    rpc: () => ({ review_id: REVIEW, candidate_state: 'submitted', envelope_status: 'open', idempotent_replay: false }),
  });

test('recordReview row 11: malformed bodies, an approval without an envelope and a reason failing the rule, with nothing read', async () => {
  const bodies = [
    reviewBody({ extra: true }),
    reviewBody({ role: 'legal' }),
    reviewBody({ decision: 'rejected' }),
    reviewBody({ envelopeId: null }),
    reviewBody({ envelopeId: 'nope' }),
    reviewBody({ reason: ' '.repeat(3) }),
    reviewBody({ reason: `a${String.fromCharCode(13)}b` }),
    reviewBody({ reason: 'x'.repeat(2001) }),
    reviewBody({ reason: 7 }),
  ];
  for (const body of bodies) {
    const db = reviewDb();
    await assert.rejects(
      reviews.recordReview(session, { candidateId: CANDIDATE, idempotencyKey: KEY, body }, db.options),
      refusal('E_BODY_INVALID'),
      JSON.stringify(body),
    );
    assert.equal(db.calls.length, 0);
  }
});

test('recordReview row 12: an envelope of another candidate is E_NOT_FOUND before any call', async () => {
  const db = reviewDb({ tables: { review_envelopes: [] } });
  await assert.rejects(
    reviews.recordReview(session, { candidateId: CANDIDATE, idempotencyKey: KEY, body: reviewBody() }, db.options),
    refusal('E_NOT_FOUND'),
  );
  assert.equal(rpcs(db.calls).length, 0);
  assert.deepEqual(db.calls[1].params, { select: 'id', id: `eq.${ENVELOPE}`, candidate_id: `eq.${CANDIDATE}` });
});

test('recordReview rows 13 and 14: an approval replays the stored bytes; a change request does not (design 1.2)', async () => {
  let db = reviewDb({ tables: { candidate_versions: [candidateRow({ content: 'not a passport' })] } });
  await assert.rejects(
    reviews.recordReview(session, { candidateId: CANDIDATE, idempotencyKey: KEY, body: reviewBody() }, db.options),
    refusal('E_GATE_FAILS_NOW'),
  );
  assert.equal(rpcs(db.calls).length, 0);
  db = reviewDb({ tables: { candidate_versions: [candidateRow({ content: 'not a passport' })] } });
  await reviews.recordReview(
    session,
    { candidateId: CANDIDATE, idempotencyKey: KEY, body: reviewBody({ decision: 'changes_requested', envelopeId: null }) },
    db.options,
  );
  assert.equal(rpcs(db.calls).length, 1, 'the change request reaches the routine');
  assert.equal(db.calls[0].params.select, 'id', 'and never read the content');
});

test('recordReview binds the trimmed reason and the lowercased envelope, and answers the review object with the routine s states', async () => {
  const db = reviewDb();
  const r = await reviews.recordReview(
    session,
    { candidateId: CANDIDATE, idempotencyKey: KEY, body: reviewBody({ envelopeId: ENVELOPE.toUpperCase() }) },
    db.options,
  );
  const [call] = rpcs(db.calls);
  assert.deepEqual(call.body, {
    p_candidate: CANDIDATE,
    p_envelope: ENVELOPE,
    p_role: 'it',
    p_decision: 'approved',
    p_reason: 'Reads internal weekly reports only.',
    p_gate_identity: hex(manifest.GATE_IDENTITY_SHA256),
    p_idempotency_key: KEY,
  });
  assert.equal(call.claims.fn, 'record_review');
  assert.deepEqual(r, {
    ok: true,
    review: {
      reviewId: REVIEW,
      candidateId: CANDIDATE,
      envelopeId: ENVELOPE,
      role: 'it',
      decision: 'approved',
      reviewerMembershipId: MEMBERSHIP,
      reason: 'Reads internal weekly reports only.',
      createdAt: '2026-09-15T09:30:00.000Z',
    },
    candidateState: 'submitted',
    envelopeStatus: 'open',
  });
});

/* ---------- publishRelease ---------- */

const publishDb = (over = {}) => {
  const log = [];
  const db = fakeDb({
    tables: {
      candidate_versions: [{ id: CANDIDATE, content: SYNTHETIC }],
      review_envelopes: [{ id: ENVELOPE, gate_id: GATE_ID, gate_identity_sha256: hex(manifest.GATE_IDENTITY_SHA256), target: 'claude-ai' }],
      installer_texts: [{ text: text('claude-ai') }],
      releases: [releaseRow()],
      release_policies: [policyRow],
      ...over.tables,
    },
    rpc: () => ({
      release_id: RELEASE,
      existing: false,
      superseded_release_ids: [],
      superseded_candidate_ids: [],
      idempotent_replay: false,
    }),
  });
  return { ...db, log, options: { ...db.options, log: (e) => log.push(e) } };
};

test('publishRelease rows 10 to 12: the key, the body and the envelope of this candidate, each before any call', async () => {
  let db = publishDb();
  await assert.rejects(
    releases.publishRelease(session, { candidateId: CANDIDATE, idempotencyKey: KEY, body: { envelopeId: ENVELOPE, x: 1 } }, db.options),
    refusal('E_BODY_INVALID'),
  );
  assert.equal(db.calls.length, 0);
  db = publishDb({ tables: { review_envelopes: [] } });
  await assert.rejects(
    releases.publishRelease(session, { candidateId: CANDIDATE, idempotencyKey: KEY, body: { envelopeId: ENVELOPE } }, db.options),
    refusal('E_NOT_FOUND'),
  );
  assert.equal(rpcs(db.calls).length, 0);
});

test('publishRelease row 13: no readable installer text is 503 E_INSTALLER_UNREGISTERED with no call', async () => {
  const db = publishDb({ tables: { installer_texts: [] } });
  await assert.rejects(
    releases.publishRelease(session, { candidateId: CANDIDATE, idempotencyKey: KEY, body: { envelopeId: ENVELOPE } }, db.options),
    refusal('E_INSTALLER_UNREGISTERED'),
  );
  assert.equal(rpcs(db.calls).length, 0);
});

test('publishRelease: the arithmetic comes first, so an over-bound content under a diverging text is E_ASSEMBLY_TOO_LARGE, never hashed', async () => {
  const eight = `${EMPTY}\n${Array(7).fill(PLACEHOLDER).join('\n')}\n`;
  const db = publishDb({
    tables: {
      candidate_versions: [{ id: CANDIDATE, content: eight }],
      review_envelopes: [{ id: ENVELOPE, gate_id: GATE_ID, gate_identity_sha256: hex(manifest.GATE_IDENTITY_SHA256), target: 'claude-code' }],
      installer_texts: [{ text: `${text('claude-code')} ` }],
    },
  });
  await assert.rejects(
    releases.publishRelease(session, { candidateId: CANDIDATE, idempotencyKey: KEY, body: { envelopeId: ENVELOPE } }, db.options),
    refusal('E_ASSEMBLY_TOO_LARGE'),
  );
  assert.equal(rpcs(db.calls).length, 0);
  assert.deepEqual(db.log, [], 'the manifest comparison never ran');
});

test('publishRelease row 14: this build s gate with a registered text other than the manifest s is 500 E_ASSEMBLY_DIVERGED, logged with both hashes, no call', async () => {
  const altered = `${text('claude-ai')} `;
  const db = publishDb({ tables: { installer_texts: [{ text: altered }] } });
  await assert.rejects(
    releases.publishRelease(session, { candidateId: CANDIDATE, idempotencyKey: KEY, body: { envelopeId: ENVELOPE } }, db.options),
    refusal('E_ASSEMBLY_DIVERGED'),
  );
  assert.equal(rpcs(db.calls).length, 0);
  const manifestRow = (await import('../../../lib/passport/installer-manifest.mjs')).INSTALLER_TEXTS.find((t) => t.target === 'claude-ai');
  assert.deepEqual(db.log, [
    {
      event: 'assembly_diverged',
      stage: 'installer_text',
      target: 'claude-ai',
      registeredTextSha256: sha(altered),
      manifestTextSha256: manifestRow.textSha256,
    },
  ]);
});

test('publishRelease binds the expected hash of the rows it read; under another build s gate it compares no manifest', async () => {
  let db = publishDb();
  const r = await releases.publishRelease(
    session,
    { candidateId: CANDIDATE, idempotencyKey: KEY, body: { envelopeId: ENVELOPE.toUpperCase() } },
    db.options,
  );
  const [call] = rpcs(db.calls);
  assert.deepEqual(call.body, {
    p_candidate: CANDIDATE,
    p_envelope: ENVELOPE,
    p_expected_assembled_sha256: hex(assembledSha256(SYNTHETIC, text('claude-ai'))),
    p_gate_identity: hex(manifest.GATE_IDENTITY_SHA256),
    p_idempotency_key: KEY,
  });
  assert.equal(r.release.releaseId, RELEASE);
  assert.equal(r.release.current, true);
  assert.equal(r.release.gateIdentitySha256, manifest.GATE_IDENTITY_SHA256);
  assert.equal('assembledContent' in r.release, false);
  assert.deepEqual(r.superseded, { releaseIds: [], candidateIds: [] });
  const altered = `${text('claude-ai')} `;
  db = publishDb({
    tables: {
      review_envelopes: [{ id: ENVELOPE, gate_id: GATE_ID, gate_identity_sha256: hex(OTHER_IDENTITY), target: 'claude-ai' }],
      installer_texts: [{ text: altered }],
    },
  });
  await releases.publishRelease(session, { candidateId: CANDIDATE, idempotencyKey: KEY, body: { envelopeId: ENVELOPE } }, db.options);
  assert.equal(rpcs(db.calls)[0].body.p_expected_assembled_sha256, hex(sha(SYNTHETIC.split(PLACEHOLDER).join(altered))));
  assert.deepEqual(db.log, []);
});

/* ---------- withdrawRelease ---------- */

test('withdrawRelease: the reason rule and a readable release before the call; the trimmed reason bound; never a revocation', async () => {
  for (const body of [{ reason: ' ' }, { reason: 'ok', x: 1 }, {}]) {
    const db = fakeDb();
    await assert.rejects(
      releases.withdrawRelease(session, { releaseId: RELEASE, idempotencyKey: KEY, body }, db.options),
      refusal('E_BODY_INVALID'),
    );
    assert.equal(db.calls.length, 0);
  }
  let db = fakeDb({ tables: { releases: [] } });
  await assert.rejects(
    releases.withdrawRelease(session, { releaseId: RELEASE, idempotencyKey: KEY, body: { reason: 'Stop.' } }, db.options),
    refusal('E_NOT_FOUND'),
  );
  assert.equal(rpcs(db.calls).length, 0);
  db = fakeDb({
    tables: { releases: [releaseRow({ state: 'withdrawn', withdrawn_by_membership_id: MEMBERSHIP, withdrawn_at: '2026-09-15T11:00:00+00:00', withdrawal_reason: 'Stop.' })], release_policies: [policyRow] },
    rpc: () => ({
      release_id: RELEASE,
      recipients: [
        { membership_id: MEMBERSHIP, first_authorized_at: '2026-09-15T10:30:00.5+00:00', last_authorized_at: '2026-09-15T10:45:00+00:00', authorizations: 2 },
      ],
      recipient_count: 1,
      revokes_copies: false,
      idempotent_replay: false,
    }),
  });
  const r = await releases.withdrawRelease(session, { releaseId: RELEASE, idempotencyKey: KEY, body: { reason: '  Stop.  ' } }, db.options);
  assert.deepEqual(rpcs(db.calls)[0].body, { p_release: RELEASE, p_reason: 'Stop.', p_idempotency_key: KEY });
  assert.equal(r.revokesCopies, false);
  assert.equal(r.recipientCount, 1);
  assert.deepEqual(r.recipients, [
    { membershipId: MEMBERSHIP, firstAuthorizedAt: '2026-09-15T10:30:00.500Z', lastAuthorizedAt: '2026-09-15T10:45:00.000Z', authorizations: 2 },
  ]);
  assert.deepEqual(r.release.withdrawal, { withdrawnByMembershipId: MEMBERSHIP, withdrawnAt: '2026-09-15T11:00:00.000Z', reason: 'Stop.' });
  assert.equal(r.release.current, false);
});

/* ---------- groups ---------- */

const admin = [{ id: MEMBERSHIP, roles: ['company_admin', 'member'], status: 'active' }];

test('createGroup: the name rule before standing, standing before the role, then create_group through the unbound bearer', async () => {
  let db = fakeDb({ tables: { memberships: admin } });
  await assert.rejects(groups.createGroup(session, { companyId: COMPANY, body: { name: ' ' } }, db.options), refusal('E_BODY_INVALID'));
  await assert.rejects(groups.createGroup(session, { companyId: COMPANY, body: { name: 'Ops', x: 1 } }, db.options), refusal('E_BODY_INVALID'));
  assert.equal(db.calls.length, 0);
  db = fakeDb({ tables: { memberships: [] } });
  await assert.rejects(groups.createGroup(session, { companyId: COMPANY, body: { name: 'Ops' } }, db.options), refusal('E_NOT_FOUND'));
  db = fakeDb();
  await assert.rejects(groups.createGroup(session, { companyId: COMPANY, body: { name: 'Ops' } }, db.options), refusal('E_FORBIDDEN'));
  assert.equal(rpcs(db.calls).length, 0);
  db = fakeDb({ tables: { memberships: admin }, rpc: () => [{ group_id: GROUP_A, changed: true }] });
  const r = await groups.createGroup(session, { companyId: COMPANY, body: { name: '  Finance  ' } }, db.options);
  const [call] = rpcs(db.calls);
  assert.deepEqual([call.rpc, call.body, call.claims.fn], ['create_group', { p_company: COMPANY, p_name: 'Finance' }, undefined]);
  assert.deepEqual(r, { groupId: GROUP_A, changed: true });
});

test('addGroupMember and removeGroupMember: a group or membership outside the route s company is E_NOT_FOUND before the role, then the routine', async () => {
  const other = '5e5e5e5e-0000-4000-8000-000000000005';
  let db = fakeDb({ tables: { memberships: admin, groups: [] } });
  await assert.rejects(
    groups.addGroupMember(session, { companyId: COMPANY, groupId: GROUP_A, membershipId: other }, db.options),
    refusal('E_NOT_FOUND'),
  );
  assert.equal(rpcs(db.calls).length, 0);
  db = fakeDb({ tables: { groups: [{ id: GROUP_A }] } });
  await assert.rejects(
    groups.addGroupMember(session, { companyId: COMPANY, groupId: GROUP_A, membershipId: MEMBERSHIP }, db.options),
    refusal('E_FORBIDDEN'),
  );
  assert.equal(rpcs(db.calls).length, 0);
  for (const [fn, name] of [
    [groups.addGroupMember, 'add_group_member'],
    [groups.removeGroupMember, 'remove_group_member'],
  ]) {
    db = fakeDb({
      tables: { memberships: admin, groups: [{ id: GROUP_A }] },
      rpc: () => [{ group_id: GROUP_A, membership_id: MEMBERSHIP, changed: false }],
    });
    const r = await fn(session, { companyId: COMPANY, groupId: GROUP_A, membershipId: MEMBERSHIP }, db.options);
    assert.deepEqual(rpcs(db.calls).map((c) => [c.rpc, c.body]), [[name, { p_group: GROUP_A, p_membership: MEMBERSHIP }]]);
    assert.deepEqual(r, { groupId: GROUP_A, membershipId: MEMBERSHIP, changed: false });
  }
});

/* ---------- readReviewQueue ---------- */

test('readReviewQueue: a stranger is E_NOT_FOUND; the viewer s exclusion, the approved roles and the open-or-unpublished envelopes', async () => {
  let db = fakeDb({ tables: { memberships: [] } });
  await assert.rejects(reviews.readReviewQueue(session, { companyId: COMPANY }, db.options), refusal('E_NOT_FOUND'));
  const approved = '66666666-0000-4000-8000-000000000006';
  const envOpen = '77777777-0000-4000-8000-000000000007';
  const envPublished = '88888888-0000-4000-8000-000000000008';
  db = fakeDb({
    tables: {
      memberships: [{ id: MEMBERSHIP, roles: ['it_reviewer', 'member'], status: 'active' }],
      candidate_versions: (p) =>
        p.state === 'eq.submitted'
          ? [{ id: CANDIDATE, agent_id: AGENT, sequence: 3, state: 'submitted', submitted_at: '2026-09-15T08:00:00+00:00', author_membership_id: MEMBERSHIP, gate_id: GATE_ID }]
          : [{ id: approved, agent_id: AGENT, sequence: 2 }],
      review_envelopes: [
        { id: ENVELOPE, candidate_id: CANDIDATE, revision: 1, target: 'claude-ai', status: 'open', gate_id: GATE_ID, policy_id: POLICY },
        { id: envOpen, candidate_id: approved, revision: 2, target: 'chatgpt', status: 'open', gate_id: GATE_ID, policy_id: POLICY },
        { id: envPublished, candidate_id: approved, revision: 1, target: 'claude-ai', status: 'approved', gate_id: GATE_ID, policy_id: POLICY },
      ],
      reviews: [
        { id: REVIEW, envelope_id: ENVELOPE, role: 'it', decision: 'approved' },
        { id: '99999999-0000-4000-8000-000000000009', envelope_id: envPublished, role: 'business', decision: 'approved' },
        { id: '99999999-0000-4000-8000-00000000000a', envelope_id: envPublished, role: 'it', decision: 'approved' },
      ],
      agents: [{ id: AGENT, name: 'weekly-brief' }],
      candidate_contributors: [
        { id: 'c0000000-0000-4000-8000-000000000001', candidate_id: CANDIDATE, kind: 'author', membership_id: MEMBERSHIP },
        { id: 'c0000000-0000-4000-8000-000000000002', candidate_id: CANDIDATE, kind: 'submitter', membership_id: MEMBERSHIP },
      ],
      releases: [{ id: RELEASE, envelope_id: envPublished }],
      release_policies: [policyRow],
    },
  });
  const q = await reviews.readReviewQueue(session, { companyId: COMPANY }, db.options);
  assert.equal(q.awaitingDecision.length, 1);
  assert.equal(q.awaitingDecision[0].viewerExcluded, true);
  assert.equal(q.awaitingDecision[0].agentName, 'weekly-brief');
  assert.deepEqual(q.awaitingDecision[0].envelopes[0].approvedRoles, ['it']);
  assert.deepEqual(q.openEnvelopes.map((e) => e.envelopeId), [envOpen], 'the approved envelope with a current release is not open work');
  assert.equal(q.truncated, false);
  const own = db.calls.find((c) => c.read === 'candidate_contributors');
  assert.deepEqual(
    [own.params.candidate_id, own.params.membership_id],
    [`in.(${CANDIDATE})`, `eq.${MEMBERSHIP}`],
    'only the viewer s own rows on the candidates awaiting decision are asked for',
  );
  assert.ok(!db.calls.some((c) => c.read === 'agent_reviewer_exclusions'), 'the agent-wide history decides nothing here');
});

test('readReviewQueue (Q5 as answered 2026-09-15): a contributor of an earlier version only is not marked excluded', async () => {
  const earlier = 'e0000000-0000-4000-8000-0000000000e1';
  const db = fakeDb({
    tables: {
      memberships: [{ id: MEMBERSHIP, roles: ['it_reviewer', 'member'], status: 'active' }],
      candidate_versions: (p) =>
        p.state === 'eq.submitted'
          ? [{ id: CANDIDATE, agent_id: AGENT, sequence: 2, state: 'submitted', submitted_at: '2026-09-15T08:00:00+00:00', author_membership_id: OTHER_MEMBERSHIP, gate_id: GATE_ID }]
          : [],
      review_envelopes: [],
      reviews: [],
      agents: [{ id: AGENT, name: 'weekly-brief' }],
      /* The viewer authored version 1 (earlier): the history holds her, the awaiting candidate holds none of her rows. */
      agent_reviewer_exclusions: [{ agent_id: AGENT, membership_id: MEMBERSHIP, kind: 'author' }],
      candidate_contributors: (p) =>
        [
          { id: 'c0000000-0000-4000-8000-000000000003', candidate_id: earlier, kind: 'author', membership_id: MEMBERSHIP },
          { id: 'c0000000-0000-4000-8000-000000000004', candidate_id: CANDIDATE, kind: 'author', membership_id: OTHER_MEMBERSHIP },
        ].filter((r) => p.candidate_id.includes(r.candidate_id) && p.membership_id === `eq.${r.membership_id}`),
      release_policies: [policyRow],
    },
  });
  const q = await reviews.readReviewQueue(session, { companyId: COMPANY }, db.options);
  assert.deepEqual(q.awaitingDecision.map((c) => [c.candidateId, c.viewerExcluded]), [[CANDIDATE, false]]);
});

/* ---------- readReview ---------- */

/* Version 2 of the agent, by someone else; version 1 sorts after it in id order, as readAll requires ascending ids. */
const VERSION_ONE = 'e0000000-0000-4000-8000-0000000000e1';
const reviewCandidateRow = (() => {
  const { content } = stored(SYNTHETIC);
  return {
    id: CANDIDATE,
    company_id: COMPANY,
    agent_id: AGENT,
    sequence: 2,
    state: 'submitted',
    version: 1,
    author_membership_id: OTHER_MEMBERSHIP,
    supersedes_candidate_id: null,
    content,
    content_sha256: hex(sha(content)),
    derived: { title: 'SYNTHETIC Record Sorter' },
    derived_sha256: hex('d'.repeat(64)),
    gate_id: GATE_ID,
    validated_at: '2026-09-15T08:00:00.000+00:00',
    attested_by: OTHER_MEMBERSHIP,
    attested_at: '2026-09-15T08:00:01+00:00',
    submitted_at: '2026-09-15T08:00:01+00:00',
    submitted_by_membership_id: OTHER_MEMBERSHIP,
    source_platform: 'claude_code',
    confidence: 'high',
    permitted_data: 'x',
    dependencies: ['a'],
  };
})();
/* own: the candidate's contributor rows; history: api.agent_reviewer_exclusions for the agent. */
const reviewReadDb = ({ roles, own, history }) =>
  fakeDb({
    tables: {
      memberships: [{ id: MEMBERSHIP, roles, status: 'active' }],
      candidate_versions: (p) =>
        p.id
          ? [reviewCandidateRow]
          : [
              { id: CANDIDATE, sequence: 2, state: 'submitted', author_membership_id: OTHER_MEMBERSHIP },
              { id: VERSION_ONE, sequence: 1, state: 'changes_requested', author_membership_id: MEMBERSHIP },
            ],
      candidate_contributors: own.map((r, i) => ({
        id: `c0000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
        membership_id: null,
        display_name: null,
        inherited_from_candidate_id: null,
        ...r,
      })),
      /* The view as PostgREST serves it: membership_id order, `membership_id=gt.` after a cursor, at most `limit` rows
         and never more than max_rows (200). */
      agent_reviewer_exclusions: (p) =>
        [...history]
          .sort((a, b) => (a.membership_id < b.membership_id ? -1 : a.membership_id > b.membership_id ? 1 : 0))
          .filter((r) => !p.membership_id?.startsWith('gt.') || r.membership_id > p.membership_id.slice(3))
          .slice(0, Math.min(Number(p.limit ?? 200), 200)),
      agents: [{ id: AGENT, name: 'weekly-brief' }],
      release_policies: [policyRow],
    },
  });
/* listGroups reads through the global fetch (lib/services/directory.mjs takes no options), so it is lent the double. */
async function readReviewWith(db) {
  const original = globalThis.fetch;
  globalThis.fetch = db.fetchImpl;
  try {
    return await reviews.readReview(session, { candidateId: CANDIDATE }, db.options);
  } finally {
    globalThis.fetch = original;
  }
}

test('readReview, the verdict corpus through the review read: row 22 s set is the candidate s own rows; earlier versions are history (Q5)', async () => {
  for (const row of VERDICT_CORPUS) {
    const own = [
      { kind: 'author', membership_id: OTHER_MEMBERSHIP },
      ...row.kinds.map((kind) => (kind === 'declared_offline' ? { kind, display_name: 'Jane Doe' } : { kind, membership_id: MEMBERSHIP })),
    ];
    const history = [
      { membership_id: OTHER_MEMBERSHIP, kind: 'author' },
      ...[...row.kinds, ...(row.earlierKinds ?? [])].filter((k) => k !== 'declared_offline').map((kind) => ({ membership_id: MEMBERSHIP, kind })),
    ];
    const r = await readReviewWith(reviewReadDb({ roles: row.roles, own, history }));
    const eligible = REVIEW_ROLES.filter((role) => row.refusals[role] === null);
    assert.deepEqual(r.viewer.mayApproveAs, eligible, row.label);
    assert.deepEqual(r.viewer.mayRequestChangesAs, eligible, row.label);
    assert.equal(r.viewer.excluded, row.kinds.some((k) => EXCLUDING_KINDS.includes(k)), row.label);
    if (row.earlierKinds?.length > 0)
      assert.ok(r.agentHistory.contributorMembershipIds.includes(MEMBERSHIP), `${row.label}: the history still names the viewer`);
  }
});

test('readReview: agentHistory carries contributorMembershipIds; HISTORY_ROWS stays the history read s ceiling (E4S-F11)', async () => {
  const people = (n) => Array.from({ length: n }, (_, i) => ({ membership_id: `d0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, kind: 'author' }));
  const own = [{ kind: 'author', membership_id: OTHER_MEMBERSHIP }];
  let db = reviewReadDb({ roles: ['it_reviewer', 'member'], own, history: people(200) });
  const r = await readReviewWith(db);
  assert.equal(Object.hasOwn(r.agentHistory, 'excludedMembershipIds'), false);
  assert.equal(r.agentHistory.contributorMembershipIds.length, 200);
  assert.deepEqual(r.agentHistory.candidates.map((v) => [v.sequence, v.authorMembershipId]), [[2, OTHER_MEMBERSHIP], [1, MEMBERSHIP]]);
  /* Paged on membership_id at 200 a page, never a limit above max_rows (E4S-C-F1): a full first page, its trailing
     membership set aside, then a short second page from `gt.` the last complete one. */
  const reads = db.calls.filter((c) => c.read === 'agent_reviewer_exclusions');
  assert.deepEqual(
    reads.map((c) => [c.params.agent_id, c.params.order, c.params.limit, c.params.membership_id ?? null]),
    [
      [`eq.${AGENT}`, 'membership_id.asc', '200', null],
      [`eq.${AGENT}`, 'membership_id.asc', '200', `gt.${people(199)[198].membership_id}`],
    ],
  );
  db = reviewReadDb({ roles: ['it_reviewer', 'member'], own, history: people(201) });
  await assert.rejects(readReviewWith(db), refusal('E_READ_OVER_BOUND'));
});

test('readAllByKey: pages on a repeating key under max_rows, re-reads the trailing key, counts the ceiling across pages, refuses what cannot progress (E4S-C-F1)', async () => {
  const { readAllByKey } = await import('../../../lib/services/evidence-reads.mjs');
  const id = (i) => `d0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const kinds = ['author', 'editor', 'submitter'];
  /* 150 memberships with three kinds each: 450 rows, key 49 straddles the first page boundary. */
  const rows = Array.from({ length: 150 }, (_, i) => kinds.map((kind) => ({ membership_id: id(i), kind }))).flat();
  const serve = (table, cap = 200) =>
    fakeDb({
      tables: {
        agent_reviewer_exclusions: (p) =>
          table.filter((r) => !p.membership_id?.startsWith('gt.') || r.membership_id > p.membership_id.slice(3)).slice(0, Math.min(Number(p.limit), cap)),
      },
    });
  const params = { select: 'membership_id,kind', agent_id: `eq.${AGENT}` };
  let db = serve(rows);
  const all = await readAllByKey(session, 'agent_reviewer_exclusions', params, 'membership_id', 1000, db.options);
  assert.equal(all.length, 450, 'every row once');
  assert.deepEqual([...new Set(all.map((r) => r.membership_id))].length, 150);
  assert.deepEqual(
    db.calls.map((c) => c.params.membership_id ?? null),
    [null, `gt.${id(65)}`, `gt.${id(131)}`, `gt.${id(149)}`].slice(0, db.calls.length),
  );
  assert.ok(db.calls.length >= 3 && db.calls.every((c) => c.params.limit === '200' && c.params.order === 'membership_id.asc'));
  /* The ceiling counts across pages: 450 rows against 449 refuses; against 450 passes. */
  await assert.rejects(readAllByKey(session, 'agent_reviewer_exclusions', params, 'membership_id', 449, serve(rows).options), refusal('E_READ_OVER_BOUND'));
  assert.equal((await readAllByKey(session, 'agent_reviewer_exclusions', params, 'membership_id', 450, serve(rows).options)).length, 450);
  /* A full page of one key only cannot progress. */
  const oneKey = Array.from({ length: 200 }, (_, i) => ({ membership_id: id(0), kind: `k${i}` }));
  await assert.rejects(readAllByKey(session, 'agent_reviewer_exclusions', params, 'membership_id', 1000, serve(oneKey).options), refusal('E_INTERNAL'));
  /* A key that does not ascend past the cursor is refused. */
  const descending = fakeDb({ tables: { agent_reviewer_exclusions: (p) => (p.membership_id ? [{ membership_id: id(0), kind: 'author' }] : rows.slice(0, 200)) } });
  await assert.rejects(readAllByKey(session, 'agent_reviewer_exclusions', params, 'membership_id', 1000, descending.options), refusal('E_INTERNAL'));
});
