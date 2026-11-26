/* The read services behind the member list and the invitation list (pages design 2.2, 2.3 and 4.1).

   No database client but the user one (lead change D3). Every row returned here is one RLS returned to the caller's
   own token, and this module holds no capability a pinned holder guards, so neither lib/services/members.mjs nor
   lib/services/invitations.mjs widens its surface for a read. readerStanding composes loadPrincipal, which holds no
   client, with canReadInvitations, which has no IO (critique M5); it never calls requireAdminPrincipal.

   Authorization is RLS, and Node adds no visibility rule. Where Node refuses before asking (E_NOT_FOUND without
   standing; E_FORBIDDEN and E_MFA_STEP_UP_REQUIRED on the invitation list) the refusal must stay a tested subset of
   what the database returns to the same caller (S2b, S3), and where it skips the member-label invitation read, the
   database would have answered that caller empty (S2). Each read is its own statement with its own RLS snapshot;
   2.2 and 2.3 state what a change between two of them can and cannot produce, and no row the database refused is
   ever returned.

   Bounds (pages design 2, "Bounds"). Every list read asks for its bound plus one, keeps the bound's rows and sets
   truncated when the extra row came back, the hidden member-label reads included, so the page never presents a partial
   list as a whole one. LIST_BOUNDS is the one statement of those bounds, and U2b holds each one under the Data API's
   max_rows, above which the extra row could never arrive. Every order ends with the id, so equal timestamps cannot move
   the boundary row between two identical requests. */

import { select } from '../db/user.mjs';
import { AppError } from '../errors.mjs';
import { deliveryView, invitationState } from '../rules/invitations.mjs';
import { canReadInvitations, memberLabel } from '../rules/members.mjs';
import { ROLE_NAMES } from '../rules/roles.mjs';
import { isUuid, loadPrincipal } from './principal.mjs';

export const LIST_BOUNDS = Object.freeze({
  /* GET /api/me (2.1): the caller's own active memberships. Since E6 that is ONE read of api.my_standing, which
     carries the company's slug, name, status and access state on the membership row, so the second read this pair
     was written for is gone and personCompanies has no caller left (E6 design 1.1). It stays in the table rather
     than being removed, because the bound itself is still the accepted one and a key removed from a frozen shared
     contract is a change no lane asked for; tests/e6/unit/services.test.mjs records that it is unused. */
  personMemberships: 50,
  personCompanies: 50,
  /* The member list (2.2): one company's memberships, then the two label reads, each at most the listed users. */
  companyMemberships: 150,
  labelProfiles: 150,
  labelInvitations: 150,
  /* The invitation list (2.3). */
  companyInvitations: 150,
  /* The group list (E4 design 3.4): a company's groups, then each group's member ids, one read per group, because
     group_members has no id to page on and its rows are keyed by the group. */
  companyGroups: 50,
  groupMembers: 150,
});

/** readList(session, view, params, bound) -> { rows, truncated }: one user-client read with limit bound + 1. */
export async function readList(session, view, params, bound) {
  const rows = await select(session, view, { ...params, limit: String(bound + 1) });
  return { rows: rows.slice(0, bound), truncated: rows.length > bound };
}

const NONE = Object.freeze({ rows: Object.freeze([]), truncated: false });

/**
 * readerStanding(session, companyId) -> { membershipId, roles, aal, mayReadInvitations }
 * The caller's own active membership in the company, read through RLS by loadPrincipal, with the read predicate's
 * answer for its roles. Without standing: E_NOT_FOUND, the answer the mutation routes give for an unknown, foreign or
 * inactive company and for a removed member (design section 6). This is not a second visibility rule: the database
 * would answer the next read with an empty list.
 */
export async function readerStanding(session, companyId) {
  const principal = await loadPrincipal(session, companyId);
  if (!principal.ok) throw new AppError(principal.code);
  return {
    membershipId: principal.membershipId,
    roles: principal.roles,
    aal: session.aal,
    mayReadInvitations: canReadInvitations(principal.roles),
  };
}

/** listMembers(session, companyId): the answer of GET /api/companies/{companyId}/members without its ok. */
export async function listMembers(session, companyId) {
  const standing = await readerStanding(session, companyId);
  const memberships = await readList(
    session,
    'memberships',
    {
      select: 'id,user_id,status,roles,created_at,removed_at',
      company_id: `eq.${companyId}`,
      order: 'status.asc,created_at.asc,id.asc',
    },
    LIST_BOUNDS.companyMemberships,
  );
  /* Step 2a: display names, for every caller with standing and with no role or aal branch. The list holds the users of
     the rows kept, so a truncated company sends at most the bound and never its sentinel row's user. */
  const userIds = [...new Set(memberships.rows.map((m) => m.user_id).filter(isUuid))].sort();
  const profiles =
    userIds.length === 0
      ? NONE
      : await readList(
          session,
          'profiles',
          { select: 'user_id,display_name', user_id: `in.(${userIds.join(',')})`, order: 'user_id.asc' },
          LIST_BOUNDS.labelProfiles,
        );
  /* Step 3: invitation addresses, read only when the predicate admits the caller and the session is aal2. The branch
     saves a query and is not the control: invitations_admin_read answers other callers with no row. */
  const invitations =
    standing.mayReadInvitations && session.aal === 'aal2'
      ? await readList(
          session,
          'invitations',
          {
            select: 'accepted_membership_id,email_normalized,accepted_at',
            company_id: `eq.${companyId}`,
            accepted_at: 'not.is.null',
            order: 'accepted_at.desc,id.desc',
          },
          LIST_BOUNDS.labelInvitations,
        )
      : NONE;
  return {
    companyId,
    viewer: {
      membershipId: standing.membershipId,
      roles: standing.roles,
      aal: session.aal,
      mayReadLabels: standing.mayReadInvitations,
    },
    assignableRoles: [...ROLE_NAMES],
    members: memberships.rows.map((m) => ({
      membershipId: m.id,
      userId: m.user_id,
      status: m.status,
      roles: m.roles,
      createdAt: m.created_at,
      removedAt: m.removed_at,
      label: memberLabel(m, profiles.rows, invitations.rows, standing.membershipId, session.email),
    })),
    truncated: memberships.truncated || profiles.truncated || invitations.truncated,
  };
}

/** listGroups(session, companyId): the answer of GET /api/companies/{companyId}/groups without its ok (E4 design 3.4).
    Every active member of the company reads its groups and their members (design 1.7); the lists are what row level
    security returns. Groups by name, then id; member ids in id order; truncated when a bound was reached. */
export async function listGroups(session, companyId) {
  await readerStanding(session, companyId);
  const groups = await readList(
    session,
    'groups',
    { select: 'id,name,created_at', company_id: `eq.${companyId}`, order: 'name.asc,id.asc' },
    LIST_BOUNDS.companyGroups,
  );
  const members = await Promise.all(
    groups.rows.map((g) =>
      readList(
        session,
        'group_members',
        { select: 'membership_id', group_id: `eq.${g.id}`, company_id: `eq.${companyId}`, order: 'membership_id.asc' },
        LIST_BOUNDS.groupMembers,
      ),
    ),
  );
  return {
    companyId,
    groups: groups.rows.map((g, i) => ({
      groupId: g.id,
      name: g.name,
      createdAt: g.created_at,
      memberIds: members[i].rows.map((m) => m.membership_id),
    })),
    truncated: groups.truncated || members.some((m) => m.truncated),
  };
}

/** listInvitations(session, companyId): the answer of GET /api/companies/{companyId}/invitations without its ok. */
export async function listInvitations(session, companyId) {
  const standing = await readerStanding(session, companyId);
  /* Defense in depth in front of invitations_admin_read: each refusal turns an empty answer into an explicit one. */
  if (!standing.mayReadInvitations) throw new AppError('E_FORBIDDEN');
  if (session.aal !== 'aal2') throw new AppError('E_MFA_STEP_UP_REQUIRED');
  const invitations = await readList(
    session,
    'invitations',
    {
      select:
        'id,roles,email_normalized,expires_at,created_by,created_at,accepted_membership_id,accepted_at,revoked_at,delivery',
      company_id: `eq.${companyId}`,
      order: 'created_at.desc,id.desc',
    },
    LIST_BOUNDS.companyInvitations,
  );
  const derivedAt = Date.now();
  return {
    companyId,
    stateDerivedAt: new Date(derivedAt).toISOString(),
    invitations: invitations.rows.map((i) => ({
      invitationId: i.id,
      email: i.email_normalized,
      roles: i.roles,
      state: invitationState(
        { acceptedAt: i.accepted_at, revokedAt: i.revoked_at, expiresAt: i.expires_at },
        derivedAt,
      ),
      expiresAt: i.expires_at,
      createdAt: i.created_at,
      createdByMembershipId: i.created_by,
      acceptedAt: i.accepted_at,
      acceptedMembershipId: i.accepted_membership_id,
      revokedAt: i.revoked_at,
      /* E6 design 1.2.1 (lane K4): what the row records about its delivery, read against the same clock as state. */
      delivery: deliveryView({ delivery: i.delivery, createdAt: i.created_at }, derivedAt),
    })),
    truncated: invitations.truncated,
  };
}
