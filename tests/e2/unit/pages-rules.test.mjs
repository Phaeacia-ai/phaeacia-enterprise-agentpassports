/* Pages construction, the pure rules (pages design 7.1): U3 invitationState, U4 memberLabel and canReadInvitations,
   and the rule half of U13, normalizeDisplayName over the shared corpus's Node column. The route half of U13 is in
   tests/e2/unit/pages-routes.test.mjs. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORPUS } from '../fixtures/display-name-corpus.mjs';

const { DELIVERY_GRACE_MS, DELIVERY_WORDS, deliveryView, invitationState } = await import(
  '../../../lib/rules/invitations.mjs'
);
const { canReadInvitations, INVITATION_READER_ROLES, memberLabel } = await import('../../../lib/rules/members.mjs');
const { DISPLAY_NAME_MAX_CODE_POINTS, normalizeDisplayName } = await import('../../../lib/rules/profiles.mjs');

const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

test('U3 invitationState: accepted beats revoked beats expired; expiresAt equal to now is expired; one second ahead is pending', () => {
  const ahead = iso(NOW + 1000);
  const past = iso(NOW - 1000);
  assert.equal(invitationState({ acceptedAt: past, revokedAt: past, expiresAt: past }, NOW), 'accepted');
  assert.equal(invitationState({ acceptedAt: past, revokedAt: null, expiresAt: ahead }, NOW), 'accepted');
  assert.equal(invitationState({ acceptedAt: null, revokedAt: past, expiresAt: past }, NOW), 'revoked');
  assert.equal(invitationState({ acceptedAt: null, revokedAt: past, expiresAt: ahead }, NOW), 'revoked');
  assert.equal(invitationState({ acceptedAt: null, revokedAt: null, expiresAt: past }, NOW), 'expired');
  assert.equal(
    invitationState({ acceptedAt: null, revokedAt: null, expiresAt: iso(NOW) }, NOW),
    'expired',
    'equal is expired',
  );
  assert.equal(
    invitationState({ acceptedAt: null, revokedAt: null, expiresAt: ahead }, NOW),
    'pending',
    'one second ahead',
  );
  /* PostgREST's own timestamp form, microseconds and an offset. */
  assert.equal(
    invitationState({ acceptedAt: null, revokedAt: null, expiresAt: '2026-09-14T12:00:01.000001+00:00' }, NOW),
    'pending',
  );
  assert.equal(
    invitationState({ acceptedAt: null, revokedAt: null, expiresAt: '2026-09-14T14:00:00+02:00' }, NOW),
    'expired',
    'an offset naming the same instant as now',
  );
  for (const bad of [undefined, null, '', 'not a time'])
    assert.equal(invitationState({ acceptedAt: null, revokedAt: null, expiresAt: bad }, NOW), 'expired', String(bad));
});

/* K4 (E6 design 1.2.1): the delivery the list shows. The grace is two minutes, measured from createdAt against the
   answer's own stateDerivedAt; at the boundary the row is unrecorded, as expiry's equality is expired above. */
test('K4 deliveryView: a recorded word passes through; not_attempted is in_progress inside two minutes and not_recorded at and after', () => {
  assert.equal(DELIVERY_GRACE_MS, 120_000);
  assert.deepEqual(DELIVERY_WORDS, ['handover', 'mail', 'failed', 'unconfirmed']);
  for (const word of DELIVERY_WORDS) {
    assert.equal(deliveryView({ delivery: word, createdAt: iso(NOW - 86_400_000) }, NOW), word, `${word}, a day old`);
    assert.equal(deliveryView({ delivery: word, createdAt: iso(NOW) }, NOW), word, `${word}, this instant`);
  }
  assert.equal(
    deliveryView({ delivery: 'not_attempted', createdAt: iso(NOW) }, NOW),
    'in_progress',
    'written this instant',
  );
  assert.equal(
    deliveryView({ delivery: 'not_attempted', createdAt: iso(NOW - DELIVERY_GRACE_MS + 1000) }, NOW),
    'in_progress',
    'one second inside',
  );
  assert.equal(
    deliveryView({ delivery: 'not_attempted', createdAt: iso(NOW - DELIVERY_GRACE_MS) }, NOW),
    'not_recorded',
    'equal is unrecorded',
  );
  assert.equal(
    deliveryView({ delivery: 'not_attempted', createdAt: iso(NOW - DELIVERY_GRACE_MS - 1000) }, NOW),
    'not_recorded',
    'one second past',
  );
  /* PostgREST's own timestamp form, microseconds and an offset. */
  assert.equal(
    deliveryView({ delivery: 'not_attempted', createdAt: '2026-09-14T13:58:00.500000+02:00' }, NOW),
    'in_progress',
    'half a second inside, in microseconds',
  );
  assert.equal(
    deliveryView({ delivery: 'not_attempted', createdAt: '2026-09-14T13:58:00+02:00' }, NOW),
    'not_recorded',
  );
  for (const bad of [undefined, null, '', 'not a time'])
    assert.equal(
      deliveryView({ delivery: 'not_attempted', createdAt: bad }, NOW),
      'not_recorded',
      `createdAt ${String(bad)}: never shown as fine`,
    );
  for (const unknown of [null, undefined, '', 'sent', 'Mail', 'not_recorded', 'in_progress', 42])
    assert.equal(
      deliveryView({ delivery: unknown, createdAt: iso(NOW - 86_400_000) }, NOW),
      null,
      `${String(unknown)}: nothing is said`,
    );
});

/* U4. Ids are uuids so a profile whose user_id equals a membership id is constructible. */
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VIEWER = { id: U(101), user_id: U(1) };
const NAMED = { id: U(102), user_id: U(2) };
const INVITED = { id: U(103), user_id: U(3) };
const FIRST_ADMIN = { id: U(104), user_id: U(4) };
const EMAIL = 'viewer@example.invalid';
const accepted = [
  { accepted_membership_id: INVITED.id, email_normalized: 'invited-again@example.invalid', accepted_at: iso(NOW) },
  { accepted_membership_id: NAMED.id, email_normalized: 'named@example.invalid', accepted_at: iso(NOW - 5000) },
  {
    accepted_membership_id: INVITED.id,
    email_normalized: 'invited-first@example.invalid',
    accepted_at: iso(NOW - 9000),
  },
  { accepted_membership_id: VIEWER.id, email_normalized: 'viewer-old@example.invalid', accepted_at: iso(NOW - 9500) },
];
const viewerOwnProfile = { user_id: VIEWER.user_id, display_name: 'Viewer Name' };
const namedProfile = { user_id: NAMED.user_id, display_name: 'Named Person' };

test('U4 memberLabel, empty profile list: self first and independent of the invitation list; latest accepted invitation; none otherwise', () => {
  assert.deepEqual(memberLabel(VIEWER, [], accepted, VIEWER.id, EMAIL), { kind: 'self', value: EMAIL });
  assert.deepEqual(
    memberLabel(INVITED, [], accepted, VIEWER.id, EMAIL),
    { kind: 'invitation_email', value: 'invited-again@example.invalid' },
    'the most recently accepted invitation of that membership, the first in the newest-first list',
  );
  assert.deepEqual(
    memberLabel(FIRST_ADMIN, [], accepted, VIEWER.id, EMAIL),
    { kind: 'none' },
    'provisioned, no invitation',
  );
  for (const row of [NAMED, INVITED, FIRST_ADMIN])
    assert.deepEqual(memberLabel(row, [], [], VIEWER.id, EMAIL), { kind: 'none' }, `${row.id} with an empty list`);
});

test('U4 control: self-and-empty-list, an ordinary member with an empty invitation list gets self for their own row', () => {
  assert.deepEqual(memberLabel(VIEWER, [], [], VIEWER.id, EMAIL), { kind: 'self', value: EMAIL });
});

test('U4 control: the it_auditor case, a viewer without company_admin handed a non-empty list receives invitation labels', () => {
  /* memberLabel takes no roles: the viewer here is a member without the admin role, and the rule must label the rows
     it is handed rather than re-deciding visibility. */
  const auditorMembership = { id: U(105), user_id: U(5) };
  assert.deepEqual(memberLabel(INVITED, [], accepted, auditorMembership.id, 'auditor@example.invalid'), {
    kind: 'invitation_email',
    value: 'invited-again@example.invalid',
  });
});

test('U4, revision 6: display_name beats the address with a non-empty and an empty list; self beats a name; a profile labels only its own user', () => {
  const profiles = [viewerOwnProfile, namedProfile];
  assert.deepEqual(memberLabel(NAMED, profiles, accepted, VIEWER.id, EMAIL), {
    kind: 'display_name',
    value: 'Named Person',
  });
  assert.deepEqual(memberLabel(NAMED, profiles, [], VIEWER.id, EMAIL), { kind: 'display_name', value: 'Named Person' });
  assert.deepEqual(memberLabel(VIEWER, profiles, accepted, VIEWER.id, EMAIL), { kind: 'self', value: EMAIL });
  /* A profile whose user_id is another row's user, and one whose user_id happens to equal this row's membership id,
     label nothing here. */
  const misleading = [
    { user_id: INVITED.id, display_name: 'Membership Id Match' },
    { user_id: NAMED.user_id, display_name: 'Named Person' },
  ];
  assert.deepEqual(memberLabel(INVITED, misleading, accepted, VIEWER.id, EMAIL), {
    kind: 'invitation_email',
    value: 'invited-again@example.invalid',
  });
  assert.deepEqual(memberLabel(INVITED, misleading, [], VIEWER.id, EMAIL), { kind: 'none' });
  assert.deepEqual(
    memberLabel(FIRST_ADMIN, [{ user_id: FIRST_ADMIN.user_id, display_name: null }], [], VIEWER.id, EMAIL),
    {
      kind: 'none',
    },
  );
  /* No viewer membership (never in the service, which has standing first): nothing is self. */
  assert.deepEqual(memberLabel(VIEWER, [], [], undefined, EMAIL), { kind: 'none' });
});

test('canReadInvitations is the read predicate: company_admin reads, every other role and shape does not', () => {
  assert.deepEqual([...INVITATION_READER_ROLES], ['company_admin']);
  assert.equal(canReadInvitations(['company_admin', 'member']), true);
  assert.equal(canReadInvitations(['member', 'company_admin']), true);
  for (const roles of [
    ['member'],
    ['it_reviewer', 'member'],
    ['business_reviewer', 'it_reviewer', 'member'],
    [],
    null,
    'company_admin',
  ])
    assert.equal(canReadInvitations(roles), false, JSON.stringify(roles));
});

test("U13, the rule: normalizeDisplayName answers the corpus's Node column for every row", () => {
  assert.equal(DISPLAY_NAME_MAX_CODE_POINTS, 120);
  const kinds = new Set();
  for (const row of CORPUS) {
    kinds.add(row.kind);
    const got = normalizeDisplayName(row.value);
    if (row.node === null) assert.deepEqual(got, { ok: false, code: 'E_BODY_INVALID' }, row.label);
    else assert.deepEqual(got, { ok: true, value: row.node }, row.label);
  }
  assert.deepEqual([...kinds].sort(), ['conversion', 'same', 'shape']);
  /* The named counterexamples each sit on a row: a .length count, a trim(), a check of the C0 and C1 controls alone. */
  const row = (label) => CORPUS.find((r) => r.label === label);
  assert.equal(row('120 code points of one astral character (240 UTF-16 code units)').value.length, 240);
  assert.equal(row('a tab before Ada, refused and not trimmed').node, null);
  assert.equal(row('U+202E').node, null);
});
