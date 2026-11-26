#!/usr/bin/env bash
# H2 probe: every privileged company-admin mutation requires aal2 in the server token
# (build plan line 71). An admin at aal1 or without the claim is refused with
# E_ADMIN_MFA_REQUIRED and nothing changes; aal2 succeeds; MFA does not substitute for
# admin standing; the operator paths keep their own refusals.
# At 6de3c1a: the aal1 and absent-aal admin calls succeed (HTTP 200), so this probe fails there.
# Recheck R2 (2026-09-10): the probe now holds the full matrix for all seven privileged
# functions (invite_member, revoke_invitation, set_roles, remove_member, provision_company,
# transfer_first_admin, add_operator) at aal1, with the claim absent and at aal2. aal2
# controls that would change lasting state (remove_member, provision_company) run as SQL
# under `set local role app_server` with the same claims and are rolled back, so later
# probes see the same fixtures; the other aal2 controls are HTTP calls.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"
SRV_AAL2="$(server_jwt "$U_alpha_admin1" aal2)"
SRV_AAL1="$(server_jwt "$U_alpha_admin1" aal1)"
SRV_NONE="$(server_jwt "$U_alpha_admin1")"
OP_AAL2="$(server_jwt "$U_op" aal2)"
OP_AAL1="$(server_jwt "$U_op" aal1)"
OP_NONE="$(server_jwt "$U_op")"
field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"; }
claims() { printf '{"role":"app_server","sub":"%s","aal":"aal2"}' "$1"; }
BEFORE="$(sql -c "select count(*) from app.audit_events")"
TARGET="$(sql -c "select id from app.memberships where user_id='$U_outsider'")"   # active it_reviewer in alpha since 04c
ROLES_BEFORE="$(sql -c "select roles from app.memberships where id='$TARGET'")"
ROLES_JSON="$(sql -c "select to_json(roles) from app.memberships where id='$TARGET'")"
OPERATORS_BEFORE="$(sql -c "select count(*) from app.operators")"

section "6a invite_member: admin at aal1 refused, admin without aal refused, aal2 control succeeds"
r="$(rest POST "/rpc/invite_member" "$SRV_AAL1" "{\"p_company\":\"$ALPHA\",\"p_email\":\"mfa-aal1@example.invalid\",\"p_roles\":[\"company_admin\"]}")"; expect "aal1 admin invite: E_ADMIN_MFA_REQUIRED" "$r" 'E_ADMIN_MFA_REQUIRED'
r="$(rest POST "/rpc/invite_member" "$SRV_NONE" "{\"p_company\":\"$ALPHA\",\"p_email\":\"mfa-none@example.invalid\",\"p_roles\":[\"company_admin\"]}")"; expect "admin without aal claim: E_ADMIN_MFA_REQUIRED" "$r" 'E_ADMIN_MFA_REQUIRED'
expect "no invitation was created by the refused calls" "$(sql -c "select count(*) from app.invitations where email_normalized like 'mfa-%'")" '^0$'
r="$(rest POST "/rpc/invite_member" "$SRV_AAL2" "{\"p_company\":\"$ALPHA\",\"p_email\":\"mfa-aal2@example.invalid\",\"p_roles\":[\"company_admin\"]}")"; expect "aal2 admin invite succeeds (control)" "$r" 'HTTP 200.*invitation_id'
INV="$(field "$r" invitation_id)"

section "6b revoke_invitation, set_roles, remove_member: aal1 and absent aal refused, state unchanged"
r="$(rest POST "/rpc/revoke_invitation" "$SRV_AAL1" "{\"p_invitation\":\"$INV\"}")"; expect "aal1 revoke: E_ADMIN_MFA_REQUIRED" "$r" 'E_ADMIN_MFA_REQUIRED'
r="$(rest POST "/rpc/revoke_invitation" "$SRV_NONE" "{\"p_invitation\":\"$INV\"}")"; expect "no-aal revoke: E_ADMIN_MFA_REQUIRED" "$r" 'E_ADMIN_MFA_REQUIRED'
expect "invitation still pending" "$(sql -c "select revoked_at is null from app.invitations where id='$INV'")" '^t$'
r="$(rest POST "/rpc/set_roles" "$SRV_AAL1" "{\"p_membership\":\"$TARGET\",\"p_roles\":[\"company_admin\"]}")"; expect "aal1 set_roles: E_ADMIN_MFA_REQUIRED" "$r" 'E_ADMIN_MFA_REQUIRED'
r="$(rest POST "/rpc/set_roles" "$SRV_NONE" "{\"p_membership\":\"$TARGET\",\"p_roles\":[\"company_admin\"]}")"; expect "no-aal set_roles: E_ADMIN_MFA_REQUIRED" "$r" 'E_ADMIN_MFA_REQUIRED'
expect "target roles unchanged" "$(sql -c "select roles from app.memberships where id='$TARGET'")" "^$ROLES_BEFORE\$"
r="$(rest POST "/rpc/remove_member" "$SRV_AAL1" "{\"p_membership\":\"$TARGET\"}")"; expect "aal1 remove_member: E_ADMIN_MFA_REQUIRED" "$r" 'E_ADMIN_MFA_REQUIRED'
r="$(rest POST "/rpc/remove_member" "$SRV_NONE" "{\"p_membership\":\"$TARGET\"}")"; expect "no-aal remove_member: E_ADMIN_MFA_REQUIRED" "$r" 'E_ADMIN_MFA_REQUIRED'
expect "target still active" "$(sql -c "select status from app.memberships where id='$TARGET'")" '^active$'
expect "refused calls wrote no audit rows (only the aal2 control's create row)" "$(sql -c "select count(*) from app.audit_events")" "^$((BEFORE+1))$"
r="$(rest POST "/rpc/revoke_invitation" "$SRV_AAL2" "{\"p_invitation\":\"$INV\"}")"; expect "aal2 revoke succeeds (control)" "$r" '"changed":true'
r="$(rest POST "/rpc/set_roles" "$SRV_AAL2" "{\"p_membership\":\"$TARGET\",\"p_roles\":$ROLES_JSON}")"; expect "aal2 set_roles reaches the routine: HTTP 200, no-op on identical roles (control)" "$r" 'HTTP 200.*"changed":false'
r="$(sql_try -c "begin; set local role app_server; select set_config('request.jwt.claims', '$(claims "$U_alpha_admin1")', true); select changed from api.remove_member('$TARGET'); rollback;")"; expect "aal2 remove_member as app_server in SQL: changed true, rolled back (control)" "$r" '^t$'
expect "target still active after the rolled-back control" "$(sql -c "select status from app.memberships where id='$TARGET'")" '^active$'

section "6c MFA does not replace standing: non-admin member at aal2, outsider at aal2"
r="$(rest POST "/rpc/invite_member" "$(server_jwt "$U_outsider" aal2)" "{\"p_company\":\"$ALPHA\",\"p_email\":\"mfa-x@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "non-admin at aal2: E_FORBIDDEN" "$r" 'E_FORBIDDEN'
r="$(rest POST "/rpc/invite_member" "$(server_jwt "$U_alpha_member" aal2)" "{\"p_company\":\"$ALPHA\",\"p_email\":\"mfa-x@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "removed member at aal2: E_NOT_FOUND" "$r" 'E_NOT_FOUND'

section "6d operator paths: transfer_first_admin, provision_company, add_operator at aal1 and without aal; non-operator at aal2; aal2 controls"
r="$(rest POST "/rpc/transfer_first_admin" "$OP_AAL1" "{\"p_company\":\"$ALPHA\",\"p_target_user\":\"$U_alpha_admin1\"}")"; expect "operator at aal1: E_OPERATOR_MFA_REQUIRED" "$r" 'E_OPERATOR_MFA_REQUIRED'
r="$(rest POST "/rpc/transfer_first_admin" "$OP_NONE" "{\"p_company\":\"$ALPHA\",\"p_target_user\":\"$U_alpha_admin1\"}")"; expect "operator without aal: E_OPERATOR_MFA_REQUIRED" "$r" 'E_OPERATOR_MFA_REQUIRED'
r="$(rest POST "/rpc/transfer_first_admin" "$SRV_AAL2" "{\"p_company\":\"$ALPHA\",\"p_target_user\":\"$U_alpha_admin1\"}")"; expect "company admin at aal2 is not an operator: E_NOT_OPERATOR" "$r" 'E_NOT_OPERATOR'
r="$(rest POST "/rpc/transfer_first_admin" "$OP_AAL2" "{\"p_company\":\"$ALPHA\",\"p_target_user\":\"$U_alpha_admin1\"}")"; expect "operator at aal2 succeeds (no-op on an existing admin, control)" "$r" '"changed":false'
r="$(rest POST "/rpc/provision_company" "$OP_AAL1" "{\"p_slug\":\"synthetic-mfa-control\",\"p_name\":\"SYNTHETIC MFA Control\",\"p_first_admin_user\":\"$U_outsider\"}")"; expect "provision_company at aal1: E_OPERATOR_MFA_REQUIRED" "$r" 'E_OPERATOR_MFA_REQUIRED'
r="$(rest POST "/rpc/provision_company" "$OP_NONE" "{\"p_slug\":\"synthetic-mfa-control\",\"p_name\":\"SYNTHETIC MFA Control\",\"p_first_admin_user\":\"$U_outsider\"}")"; expect "provision_company without aal: E_OPERATOR_MFA_REQUIRED" "$r" 'E_OPERATOR_MFA_REQUIRED'
expect "no company was provisioned by the refused calls" "$(sql -c "select count(*) from app.companies where slug='synthetic-mfa-control'")" '^0$'
r="$(sql_try -c "begin; set local role app_server; select set_config('request.jwt.claims', '$(claims "$U_op")', true); select company_id is not null from api.provision_company('synthetic-mfa-control','SYNTHETIC MFA Control','$U_outsider'); rollback;")"; expect "provision_company at aal2 as app_server in SQL: company returned, rolled back (control)" "$r" '^t$'
expect "no company persists after the rolled-back control" "$(sql -c "select count(*) from app.companies where slug='synthetic-mfa-control'")" '^0$'
r="$(rest POST "/rpc/add_operator" "$OP_AAL1" "{\"p_user\":\"$U_outsider\"}")"; expect "add_operator at aal1: E_OPERATOR_MFA_REQUIRED" "$r" 'E_OPERATOR_MFA_REQUIRED'
r="$(rest POST "/rpc/add_operator" "$OP_NONE" "{\"p_user\":\"$U_outsider\"}")"; expect "add_operator without aal: E_OPERATOR_MFA_REQUIRED" "$r" 'E_OPERATOR_MFA_REQUIRED'
expect "operator set unchanged by the refused calls" "$(sql -c "select count(*) from app.operators")" "^$OPERATORS_BEFORE\$"
r="$(rest POST "/rpc/add_operator" "$OP_AAL2" "{\"p_user\":\"$U_op\"}")"; expect "add_operator at aal2 reaches the routine: HTTP 200, no-op on an existing operator (control)" "$r" 'HTTP 200.*"changed":false'
expect "whole probe: exactly the two lasting aal2 controls (create, revoke) wrote audit rows" "$(sql -c "select count(*) from app.audit_events")" "^$((BEFORE+2))$"
[ "$FAILED" = 0 ] && echo "06 PASS" || { echo "06 FAIL"; exit 1; }
