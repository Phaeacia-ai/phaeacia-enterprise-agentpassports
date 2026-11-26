/* Pages construction, the read services with a stubbed Data API (pages design 7.1): U2, the exact PostgREST reads and
   the truncation flag, and U2b, the bounds against max_rows and the dropped membership. The stub replaces the global
   fetch the user client calls, and answers by view. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { hs256, userClaims } from '../helpers/jwt.mjs';

const SECRET = 'example-unit-secret-with-at-least-32-characters-long';
const BASE = 'http://127.0.0.1:54321';
process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = SECRET;

const { COOKIES, verifySession } = await import('../../../lib/session.mjs');
const { LIST_BOUNDS, listInvitations, listMembers, readerStanding } = await import(
  '../../../lib/services/directory.mjs'
);
const { loadIdentity } = await import('../../../lib/services/identity.mjs');
const { ROLE_NAMES } = await import('../../../lib/rules/roles.mjs');

const SUB = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11';
const COMPANY = '2a5d1b3c-4e6f-4a8b-9c0d-1e2f3a4b5c6d';
const EMAIL = 'viewer@example.invalid';
const hex = (n, width = 12) => n.toString(16).padStart(width, '0');
const uuid = (prefix, n) => `${prefix}-0000-4000-8000-${hex(n)}`;

async function session(aal) {
  const token = hs256(userClaims({ sub: SUB, email: EMAIL, issuer: `${BASE}/auth/v1`, aal }), SECRET);
  return (await verifySession({ headers: { cookie: `${COOKIES.access}=${token}` } })).session;
}

/* answers: view -> rows, or a function (params) -> rows. principal answers the standing read. */
async function withDataApi(answers, run) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    const view = u.pathname.replace('/rest/v1/', '');
    const params = [...u.searchParams];
    calls.push({ view, params, method: init?.method, auth: init?.headers?.authorization });
    /* Since E6 the standing read is api.my_standing and not api.memberships (design 1.1): the view that sees past a
       company's status, scoped to auth.uid(). loadPrincipal names one company and loadIdentity names none, which is
       what tells the two reads of the same view apart here. */
    const principal = view === 'my_standing' && u.searchParams.has('company_id');
    const answer = principal ? answers.principal : answers[view];
    const rows = typeof answer === 'function' ? answer(Object.fromEntries(params)) : (answer ?? []);
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    return { result: await run(), calls };
  } catch (error) {
    return { error, calls };
  } finally {
    globalThis.fetch = original;
  }
}

const standingRow = (roles, over = {}) => [
  {
    membership_id: uuid('aaaaaaaa', 1),
    roles,
    membership_status: 'active',
    company_status: 'active',
    access_state: 'current',
    ...over,
  },
];
const membershipRows = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: uuid('bbbbbbbb', i + 1),
    user_id: uuid('cccccccc', n - i),
    status: 'active',
    roles: ['member'],
    created_at: '2026-09-14T10:00:00+00:00',
    removed_at: null,
  }));
const rowsOf = (n, make) => Array.from({ length: n }, (_, i) => make(i));
const nonProfileCalls = (calls) => calls.filter((c) => c.view !== 'profiles');

function assertOrders(calls) {
  for (const { view, params } of calls) {
    for (const [k, v] of params) {
      if (k !== 'order') continue;
      if (view === 'profiles') assert.equal(v, 'user_id.asc', 'the profile read orders on its key');
      /* api.my_standing has no bare id column: its rows are keyed by membership_id, which is the same tie-breaker
         under the name the view gives it (E6 design 1.1). */ else if (view === 'my_standing')
        assert.match(v, /,membership_id\.(asc|desc)$/, `my_standing order ${v}`);
      else assert.match(v, /,id\.(asc|desc)$/, `${view} order ${v} ends with the id tie-breaker`);
    }
  }
}

/* E6 design 1.1 and 3.4 moved this read: loadIdentity now takes TWO reads and not three, because api.my_standing
   carries the company's slug, name and status and the access state on the membership row, and a suspended or closed
   company therefore stays in the person's list with its state instead of vanishing. */
test('U2 loadIdentity: two reads with exactly the filters of 2.1 as E6 moved them, every order ending in the id, limits of bound plus one', async () => {
  const s = await session('aal1');
  const { result, calls } = await withDataApi(
    {
      my_standing: [
        {
          membership_id: uuid('bbbbbbbb', 1),
          company_id: COMPANY,
          company_slug: 'synthetic-alpha',
          company_name: 'SYNTHETIC Alpha AG',
          company_status: 'suspended',
          access_state: 'export_window',
          roles: ['company_admin', 'member'],
        },
      ],
      profiles: [{ display_name: 'Ada Example' }],
    },
    () => loadIdentity(s),
  );
  assert.deepEqual(
    calls.map((c) => [c.view, c.params, c.method]),
    [
      [
        'my_standing',
        [
          ['select', 'membership_id,company_id,company_slug,company_name,company_status,access_state,roles'],
          ['order', 'company_name.asc,membership_id.asc'],
          ['limit', '51'],
        ],
        'GET',
      ],
      [
        'profiles',
        [
          ['select', 'display_name'],
          ['user_id', `eq.${SUB}`],
          ['limit', '1'],
        ],
        'GET',
      ],
    ],
  );
  assert.ok(
    calls.every((c) => /^Bearer eyJ/.test(c.auth)),
    'the user client, with the caller token',
  );
  assertOrders(calls);
  assert.deepEqual(result, {
    user: { id: SUB, email: EMAIL, aal: 'aal1', displayName: 'Ada Example' },
    memberships: [
      {
        membershipId: uuid('bbbbbbbb', 1),
        companyId: COMPANY,
        companySlug: 'synthetic-alpha',
        companyName: 'SYNTHETIC Alpha AG',
        companyStatus: 'suspended',
        accessState: 'export_window',
        roles: ['company_admin', 'member'],
      },
    ],
    truncated: false,
  });
});

test('U2 loadIdentity truncation: 51 standing rows set the flag and keep 50; 50 do not; no profile is null', async () => {
  const s = await session('aal2');
  const standing = (n) =>
    rowsOf(n, (i) => ({
      membership_id: uuid('bbbbbbbb', i),
      company_id: uuid('dddddddd', i),
      company_slug: `c-${i}`,
      company_name: `C ${hex(i, 3)}`,
      company_status: 'active',
      access_state: 'current',
      roles: ['member'],
    }));
  const bound = await withDataApi({ my_standing: standing(50), profiles: [] }, () => loadIdentity(s));
  assert.equal(bound.result.truncated, false);
  assert.equal(bound.result.memberships.length, 50);
  assert.equal(bound.result.user.displayName, null);
  const more = await withDataApi({ my_standing: standing(51) }, () => loadIdentity(s));
  assert.equal(more.result.truncated, true);
  assert.equal(more.result.memberships.length, 50, 'the sentinel row is not returned');
});

test('U2b: every bound in LIST_BOUNDS asks for at most max_rows of supabase/config.toml; one standing read cannot disagree with itself', async () => {
  const toml = readFileSync(new URL('../../../supabase/config.toml', import.meta.url), 'utf8');
  const api = /^\[api\]$([\s\S]*?)^\[/m.exec(toml)?.[1] ?? '';
  const maxRows = Number(/^max_rows\s*=\s*(\d+)\s*$/m.exec(api)?.[1]);
  assert.ok(Number.isInteger(maxRows) && maxRows > 0, 'max_rows parsed from the [api] block');
  assert.deepEqual(Object.keys(LIST_BOUNDS).sort(), [
    'companyGroups',
    'companyInvitations',
    'companyMemberships',
    'groupMembers',
    'labelInvitations',
    'labelProfiles',
    'personCompanies',
    'personMemberships',
  ]);
  for (const [name, bound] of Object.entries(LIST_BOUNDS)) {
    assert.ok(Number.isInteger(bound) && bound > 0, name);
    assert.ok(bound + 1 <= maxRows, `${name}: limit ${bound + 1} is above max_rows ${maxRows}`);
  }
  assert.ok(Object.isFrozen(LIST_BOUNDS));
  /* The drop-and-truncate step this test used to assert is GONE, and its absence is the assertion now (E6 design
     1.1). It existed because two statements could disagree: a membership whose company was missing from the second
     read had to be dropped and the answer called partial. api.my_standing joins the two inside one definer
     function, so every row carries its own company's name and status and no row can be dropped; personCompanies
     therefore has no caller left. */
  const s = await session('aal1');
  const other = '9e9e9e9e-0000-4000-8000-000000000001';
  const { result, calls } = await withDataApi(
    {
      my_standing: [
        {
          membership_id: uuid('bbbbbbbb', 1),
          company_id: COMPANY,
          company_slug: 'synthetic-alpha',
          company_name: 'SYNTHETIC Alpha AG',
          company_status: 'active',
          access_state: 'current',
          roles: ['member'],
        },
        {
          membership_id: uuid('bbbbbbbb', 2),
          company_id: other,
          company_slug: 'synthetic-beta',
          company_name: 'SYNTHETIC Beta GmbH',
          company_status: 'closed',
          access_state: 'expired',
          roles: ['member'],
        },
      ],
    },
    () => loadIdentity(s),
  );
  assert.deepEqual(
    result.memberships.map((m) => m.companyId),
    [COMPANY, other],
    'a company that is not active is listed with its state, not dropped',
  );
  assert.deepEqual(
    result.memberships.map((m) => [m.companyStatus, m.accessState]),
    [
      ['active', 'current'],
      ['closed', 'expired'],
    ],
  );
  assert.equal(result.truncated, false, 'nothing was dropped, so nothing is partial');
  assert.deepEqual(
    calls.map((c) => c.view),
    ['my_standing', 'profiles'],
    'no companies read remains',
  );
});

test('U2 listMembers for an admin at aal2: standing, memberships, profiles of exactly the listed users, accepted invitations; flags and labels', async () => {
  const s = await session('aal2');
  const members = membershipRows(3);
  const { result, calls } = await withDataApi(
    {
      principal: standingRow(['company_admin', 'member']),
      memberships: members,
      profiles: [{ user_id: members[1].user_id, display_name: 'Named' }],
      invitations: [{ accepted_membership_id: members[2].id, email_normalized: 'x@example.invalid', accepted_at: 't' }],
    },
    () => listMembers(s, COMPANY),
  );
  const userIds = members.map((m) => m.user_id).sort();
  assert.deepEqual(
    calls.map((c) => [c.view, c.params]),
    [
      [
        'my_standing',
        [
          ['select', 'membership_id,roles,membership_status,company_status,access_state,company_name'],
          ['company_id', `eq.${COMPANY}`],
        ],
      ],
      [
        'memberships',
        [
          ['select', 'id,user_id,status,roles,created_at,removed_at'],
          ['company_id', `eq.${COMPANY}`],
          ['order', 'status.asc,created_at.asc,id.asc'],
          ['limit', '151'],
        ],
      ],
      [
        'profiles',
        [
          ['select', 'user_id,display_name'],
          ['user_id', `in.(${userIds.join(',')})`],
          ['order', 'user_id.asc'],
          ['limit', '151'],
        ],
      ],
      [
        'invitations',
        [
          ['select', 'accepted_membership_id,email_normalized,accepted_at'],
          ['company_id', `eq.${COMPANY}`],
          ['accepted_at', 'not.is.null'],
          ['order', 'accepted_at.desc,id.desc'],
          ['limit', '151'],
        ],
      ],
    ],
  );
  assertOrders(calls);
  assert.deepEqual(result.viewer, {
    membershipId: uuid('aaaaaaaa', 1),
    roles: ['company_admin', 'member'],
    aal: 'aal2',
    mayReadLabels: true,
  });
  assert.deepEqual(result.assignableRoles, [...ROLE_NAMES]);
  assert.equal(result.companyId, COMPANY);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.members.map((m) => m.label),
    [
      { kind: 'none' },
      { kind: 'display_name', value: 'Named' },
      { kind: 'invitation_email', value: 'x@example.invalid' },
    ],
  );
  assert.deepEqual(Object.keys(result.members[0]), [
    'membershipId',
    'userId',
    'status',
    'roles',
    'createdAt',
    'removedAt',
    'label',
  ]);
});

test('U2 listMembers: the profile read goes to every caller class with no role or aal branch; the address read only to an admin at aal2', async () => {
  const cases = [
    ['member at aal1', ['member'], 'aal1', false],
    ['member at aal2', ['it_reviewer', 'member'], 'aal2', false],
    ['admin at aal1', ['company_admin', 'member'], 'aal1', true],
    ['admin at aal2', ['company_admin', 'member'], 'aal2', true],
  ];
  for (const [label, roles, aal, mayRead] of cases) {
    const s = await session(aal);
    const { result, calls } = await withDataApi(
      { principal: standingRow(roles), memberships: membershipRows(2), invitations: [] },
      () => listMembers(s, COMPANY),
    );
    assert.equal(calls.filter((c) => c.view === 'profiles').length, 1, `${label}: one profile read`);
    assert.equal(calls.filter((c) => c.view === 'invitations').length, mayRead && aal === 'aal2' ? 1 : 0, label);
    assert.equal(result.viewer.mayReadLabels, mayRead, `${label}: mayReadLabels is the read predicate's answer`);
    assert.equal(result.viewer.aal, aal);
  }
});

test('U2 listMembers bounds: 151 memberships send the first 150 users and set truncated; no rows skip the profile read; each hidden read alone sets the flag', async () => {
  const s = await session('aal2');
  const admin = standingRow(['company_admin', 'member']);
  const full = membershipRows(151);
  const over = await withDataApi({ principal: admin, memberships: full }, () => listMembers(s, COMPANY));
  assert.equal(over.result.truncated, true);
  assert.equal(over.result.members.length, 150);
  const sent = new URL(
    `${BASE}/x?${new URLSearchParams(over.calls.find((c) => c.view === 'profiles').params)}`,
  ).searchParams
    .get('user_id')
    .slice(4, -1)
    .split(',');
  assert.equal(sent.length, 150, 'the in. list holds 150 users, not 151');
  assert.deepEqual(
    sent,
    full
      .slice(0, 150)
      .map((m) => m.user_id)
      .sort(),
  );
  assert.ok(!sent.includes(full[150].user_id), 'the sentinel row user is not sent');

  const empty = await withDataApi({ principal: admin, memberships: [] }, () => listMembers(s, COMPANY));
  assert.deepEqual(empty.result.members, []);
  assert.equal(empty.calls.filter((c) => c.view === 'profiles').length, 0, 'no rows, no profile read');

  const exact = await withDataApi({ principal: admin, memberships: membershipRows(150) }, () =>
    listMembers(s, COMPANY),
  );
  assert.equal(exact.result.truncated, false, '150 rows are complete');

  const labelOver = await withDataApi(
    {
      principal: admin,
      memberships: membershipRows(3),
      invitations: rowsOf(151, (i) => ({
        accepted_membership_id: uuid('eeeeeeee', i),
        email_normalized: `i${i}@example.invalid`,
        accepted_at: 't',
      })),
    },
    () => listMembers(s, COMPANY),
  );
  assert.equal(labelOver.result.members.length, 3);
  assert.equal(labelOver.result.truncated, true, 'only the hidden address read reached its bound');

  const profileOver = await withDataApi(
    {
      principal: admin,
      memberships: membershipRows(3),
      profiles: rowsOf(151, (i) => ({ user_id: uuid('ffffffff', i), display_name: `n${i}` })),
    },
    () => listMembers(s, COMPANY),
  );
  assert.equal(profileOver.result.truncated, true, 'only the hidden profile read reached its bound');
});

test('U2 readerStanding and the early refusals: no standing is E_NOT_FOUND before any list read; the invitation list refuses E_FORBIDDEN, then E_MFA_STEP_UP_REQUIRED, before reading', async () => {
  const aal2 = await session('aal2');
  const aal1 = await session('aal1');
  /* E6 design 1.5 and 3.5: the standing read now carries the company's own state, so a member of a company that is
     not active meets its code and not the not-found an outsider gets, and the expired test sits above the
     suspension test on purpose. Every one of these refuses before any list read, which is what the call count
     asserts. */
  for (const [label, principal, code] of [
    ['no row', [], 'E_NOT_FOUND'],
    ['removed', standingRow(['company_admin', 'member'], { membership_status: 'removed' }), 'E_NOT_FOUND'],
    ['closed', standingRow(['company_admin', 'member'], { company_status: 'closed' }), 'E_COMPANY_INACTIVE'],
    [
      'past export_by, the sweep never run',
      standingRow(['company_admin', 'member'], { access_state: 'expired' }),
      'E_ACCESS_PERIOD_ENDED',
    ],
    [
      'suspended inside its window',
      standingRow(['company_admin', 'member'], { company_status: 'suspended' }),
      'E_COMPANY_INACTIVE',
    ],
    [
      'suspended AND expired: the period is the reason, because the sweep is what suspended it',
      standingRow(['company_admin', 'member'], { company_status: 'suspended', access_state: 'expired' }),
      'E_ACCESS_PERIOD_ENDED',
    ],
  ]) {
    for (const fn of [listMembers, listInvitations]) {
      const { error, calls } = await withDataApi({ principal }, () => fn(aal2, COMPANY));
      assert.equal(error?.code, code, `${fn.name} ${label}`);
      assert.equal(calls.length, 1, `${fn.name} ${label}: the standing read only`);
    }
  }
  const malformed = await withDataApi({}, () => listMembers(aal2, 'not-a-uuid'));
  assert.equal(malformed.error?.code, 'E_NOT_FOUND');
  assert.equal(malformed.calls.length, 0);

  const member = await withDataApi({ principal: standingRow(['it_reviewer', 'member']) }, () =>
    listInvitations(aal2, COMPANY),
  );
  assert.equal(member.error?.code, 'E_FORBIDDEN');
  assert.deepEqual(
    nonProfileCalls(member.calls).map((c) => c.view),
    ['my_standing'],
  );
  const memberAal1 = await withDataApi({ principal: standingRow(['member']) }, () => listInvitations(aal1, COMPANY));
  assert.equal(memberAal1.error?.code, 'E_FORBIDDEN', 'the role refusal comes before the aal refusal');
  const adminAal1 = await withDataApi({ principal: standingRow(['company_admin', 'member']) }, () =>
    listInvitations(aal1, COMPANY),
  );
  assert.equal(adminAal1.error?.code, 'E_MFA_STEP_UP_REQUIRED');
  assert.equal(adminAal1.calls.length, 1);

  const standing = await withDataApi({ principal: standingRow(['company_admin', 'member']) }, () =>
    readerStanding(aal1, COMPANY),
  );
  assert.deepEqual(standing.result, {
    membershipId: uuid('aaaaaaaa', 1),
    roles: ['company_admin', 'member'],
    aal: 'aal1',
    mayReadInvitations: true,
  });
});

test('U2 listInvitations for an admin at aal2: the exact read of 2.3, the mapped fields and states, truncation at 151', async () => {
  const s = await session('aal2');
  const now = Date.now();
  const row = (over) => ({
    id: uuid('12121212', 1),
    roles: ['member'],
    email_normalized: 'new.person@example.invalid',
    expires_at: new Date(now + 86_400_000).toISOString(),
    created_by: uuid('aaaaaaaa', 1),
    created_at: '2026-09-14T09:00:00+00:00',
    accepted_membership_id: null,
    accepted_at: null,
    revoked_at: null,
    delivery: 'mail',
    ...over,
  });
  const { result, calls } = await withDataApi(
    {
      principal: standingRow(['company_admin', 'member']),
      invitations: [
        /* K4 (E6 design 1.2.1): a row written hours ago whose attempt never recorded itself. */
        row({ delivery: 'not_attempted' }),
        row({ id: uuid('12121212', 2), revoked_at: '2026-09-14T09:30:00+00:00' }),
        row({
          id: uuid('12121212', 3),
          accepted_at: '2026-09-14T09:40:00+00:00',
          accepted_membership_id: uuid('bbbbbbbb', 9),
        }),
        /* K4: a row older than migration 010, which recorded nothing. */
        row({ id: uuid('12121212', 4), expires_at: new Date(now - 1000).toISOString(), delivery: null }),
      ],
    },
    () => listInvitations(s, COMPANY),
  );
  assert.deepEqual(calls[1].params, [
    [
      'select',
      'id,roles,email_normalized,expires_at,created_by,created_at,accepted_membership_id,accepted_at,revoked_at,delivery',
    ],
    ['company_id', `eq.${COMPANY}`],
    ['order', 'created_at.desc,id.desc'],
    ['limit', '151'],
  ]);
  assertOrders(calls);
  assert.deepEqual(
    result.invitations.map((i) => i.state),
    ['pending', 'revoked', 'accepted', 'expired'],
  );
  assert.deepEqual(result.invitations[2], {
    invitationId: uuid('12121212', 3),
    email: 'new.person@example.invalid',
    roles: ['member'],
    state: 'accepted',
    expiresAt: result.invitations[2].expiresAt,
    createdAt: '2026-09-14T09:00:00+00:00',
    createdByMembershipId: uuid('aaaaaaaa', 1),
    acceptedAt: '2026-09-14T09:40:00+00:00',
    acceptedMembershipId: uuid('bbbbbbbb', 9),
    revokedAt: null,
    delivery: 'mail',
  });
  assert.deepEqual(
    result.invitations.map((i) => i.delivery),
    ['not_recorded', 'mail', 'mail', null],
    'K4: the stored word through deliveryView, against the answer own clock',
  );
  assert.ok(Math.abs(Date.parse(result.stateDerivedAt) - now) < 5000, 'stateDerivedAt is the server clock at the read');
  assert.equal(result.truncated, false);
  const over = await withDataApi(
    {
      principal: standingRow(['company_admin', 'member']),
      invitations: rowsOf(151, (i) => row({ id: uuid('34343434', i) })),
    },
    () => listInvitations(s, COMPANY),
  );
  assert.equal(over.result.invitations.length, 150);
  assert.equal(over.result.truncated, true);
  const at = await withDataApi(
    {
      principal: standingRow(['company_admin', 'member']),
      invitations: rowsOf(150, (i) => row({ id: uuid('34343434', i) })),
    },
    () => listInvitations(s, COMPANY),
  );
  assert.equal(at.result.truncated, false);
});
