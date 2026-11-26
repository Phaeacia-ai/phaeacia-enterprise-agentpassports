-- 005: invitation rows are read at aal2 only (pages design revision 7, 2.3, question Q2).
--
-- Q2 is the lead's decision of 2026-09-11 (evidence/e1-lead.md, "Lead positions on the lead questions"): invitation
-- reads require aal2 at the database, through the caller's own token, because the rows carry invitee addresses and admin
-- access is meant to rest on the second factor. The pages design has relied on it since revision 2 (2.2 step 3, 2.3,
-- S2, S2b, S3), and no migration carried it: 001's invitations_admin_read admits an active company admin at any aal,
-- which pages construction observed on the local stack on 2026-09-14, an admin at aal1 reading an invitation row
-- through the user client. Written by the pages construction lane under the lead's lend (evidence/pages-server.md).
--
-- Why auth.jwt() and not app.jwt_claims(). A policy runs with the reader's privileges, and the reader is authenticated.
-- 001 revokes execute on app.jwt_claims() from public (lines 353 and 354) and grants authenticated only
-- app.is_active_member and app.has_role (line 355), so a policy calling app.jwt_claims() answers "permission denied for
-- function jwt_claims" to every reader, an admin at aal2 included; a rolled-back probe observed exactly that. Granting
-- it would widen the callers of the function app.server_actor and app.operator_actor read their principal from, so this
-- migration does not. auth.jwt() is Supabase's own reader of the same request claims and authenticated may execute it;
-- the select around it evaluates it once per statement rather than once per row.
--
-- A token that carries no aal claim reads nothing: the comparison is null and a policy admits only true, observed in the
-- same probe. That matches lib/session.mjs, which treats a missing claim as aal1.
--
-- Unchanged: app.has_role, every other policy, grant and view. Node's early refusals in lib/services/directory.mjs
-- stay defense in depth in front of this policy (2.3), and S2, S2b and S3 hold them to it with the branches removed.
drop policy invitations_admin_read on app.invitations;
create policy invitations_admin_read on app.invitations for select to authenticated
  using (app.has_role(company_id, 'company_admin') and (select auth.jwt()->>'aal') = 'aal2');
