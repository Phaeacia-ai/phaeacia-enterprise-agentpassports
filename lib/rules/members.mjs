/* Member-list rules (pages design 2.2 and 8.1 scenario A), pure.

   canReadInvitations(roles) is the read predicate for invitation rows and the addresses they carry. It mirrors the
   role part of the database policy invitations_admin_read, which decides. lib/services/directory.mjs asks it once per
   request: to refuse the invitation list early, to skip the member-label read the database would answer empty, and to
   report the answer as viewer.mayReadLabels. It is deliberately not requireAdminPrincipal, the mutation predicate
   (critique M5): a new role that may read invitations is one entry in INVITATION_READER_ROLES and one policy change,
   and nothing that governs a mutation moves.

   memberLabel labels only the rows it is handed and never looks at the viewer's roles (revision 3, R-M5). Withholding
   addresses is the caller's job, done once, by handing it an empty invitation list. */

import { ADMIN_ROLE } from './roles.mjs';

export const INVITATION_READER_ROLES = Object.freeze([ADMIN_ROLE]);

export function canReadInvitations(roles) {
  return Array.isArray(roles) && roles.some((role) => INVITATION_READER_ROLES.includes(role));
}

/**
 * memberLabel(membership, profiles, acceptedInvitations, viewerMembershipId, viewerEmail)
 *   -> { kind: 'self', value } | { kind: 'display_name', value } | { kind: 'invitation_email', value } | { kind: 'none' }
 *
 * Rows in the shape the user client reads them: membership { id, user_id }, profiles [{ user_id, display_name }],
 * acceptedInvitations [{ accepted_membership_id, email_normalized }] newest first, the order the service asks the
 * database for (accepted_at.desc, id.desc), so the first match is the most recently accepted invitation.
 *
 * Precedence (revision 6, Q9): the viewer's own row is self with the session's address, whatever the lists hold; then
 * a profile whose user_id is the row's user; then an accepted invitation whose membership is the row's; otherwise
 * none.
 */
export function memberLabel(membership, profiles, acceptedInvitations, viewerMembershipId, viewerEmail) {
  if (typeof viewerMembershipId === 'string' && membership.id === viewerMembershipId)
    return { kind: 'self', value: viewerEmail };
  const profile = profiles.find((p) => p.user_id === membership.user_id && typeof p.display_name === 'string');
  if (profile) return { kind: 'display_name', value: profile.display_name };
  const invitation = acceptedInvitations.find(
    (i) => i.accepted_membership_id === membership.id && typeof i.email_normalized === 'string',
  );
  if (invitation) return { kind: 'invitation_email', value: invitation.email_normalized };
  return { kind: 'none' };
}
