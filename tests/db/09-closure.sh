#!/usr/bin/env bash
# M3 probe: company status is part of every company-scoped RLS predicate (a closed or
# suspended company is invisible to its own members through every view, co-member profiles
# included), the service role alone cannot read any app table, and the restricted
# app_maintenance role can read standing, mark memberships removed, revoke invitations and
# append audit rows but not delete, read token hashes, or be reached through PostgREST.
# At 6de3c1a: a closed company is still readable by its members (9b fails) and the
# app_maintenance role does not exist (9d fails).
# Recheck R1 and R2 (2026-09-10): 9a seeds a pending beta invitation so every one of the
# five views is populated before the status change; 9b repeats all five views for
# `suspended`; 9d asserts that the maintenance revocation changed exactly one row and adds
# the rolled-back disclosure probe from the recheck: the role can write both directions on
# invitations, memberships (roles included) and companies without any audit coupling.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"
B_JWT="$(user_jwt synthetic-beta-member@example.invalid "$PW")"
SRV_BETA="$(server_jwt "$U_beta_member" aal2)"
field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"; }

section "9a fixture: a second beta member, profiles and a pending beta invitation, visible while beta is active (control)"
sql -c "insert into app.memberships (company_id, user_id, roles) values ('$BETA','$U_alpha_member','{member}') on conflict do nothing;
        insert into app.profiles (user_id, display_name) values ('$U_beta_member','SYNTHETIC Beta Admin'), ('$U_alpha_member','SYNTHETIC Second') on conflict do nothing;" >/dev/null
r="$(rest POST "/rpc/invite_member" "$SRV_BETA" "{\"p_company\":\"$BETA\",\"p_email\":\"beta-pending@example.invalid\",\"p_roles\":[\"member\"]}")"
INVB="$(field "$r" invitation_id)"
expect "fixture: pending beta invitation created through invite_member" "$INVB" '^[0-9a-f-]\{36\}$'
[ -n "$INVB" ] || { echo "09 FAIL: the pending beta invitation fixture is missing; the populated view and revocation cases cannot run"; exit 1; }
r="$(rest GET "/companies?select=slug" "$B_JWT")"; expect "beta admin sees beta" "$r" 'synthetic-beta'
r="$(rest GET "/memberships?select=id&company_id=eq.$BETA" "$B_JWT")"; expect "beta admin sees beta memberships" "$r" 'HTTP 200 \[{"id"'
B_AAL2="$(node -e 'const c=require("node:crypto");const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");const now=Math.floor(Date.now()/1000);const h=b({alg:"HS256",typ:"JWT"}),p=b({sub:process.argv[1],role:"authenticated",aud:"authenticated",aal:"aal2",iat:now,exp:now+300});console.log(h+"."+p+"."+c.createHmac("sha256",process.env.JWT_SECRET).update(h+"."+p).digest("base64url"))' "$U_beta_member")"; r="$(rest GET "/invitations?select=id" "$B_AAL2")"; expect "beta admin at aal2 sees the pending beta invitation (migration 005, Q2)" "$r" "$INVB"
r="$(rest GET "/profiles?select=user_id&user_id=eq.$U_alpha_member" "$B_JWT")"; expect "beta admin sees the co-member profile" "$r" "$U_alpha_member"
r="$(rest GET "/audit_events?select=action&company_id=eq.$BETA" "$B_JWT")"; expect "beta admin sees beta audit" "$r" 'company.provision'

section "9b quarantine by status: beta closed, memberships untouched, every view empty for its members"
sql -c "update app.companies set status='closed' where id='$BETA'" >/dev/null
r="$(rest GET "/companies?select=slug" "$B_JWT")"; expect "closed company: companies empty" "$r" 'HTTP 200 \[\]'
r="$(rest GET "/memberships?select=id" "$B_JWT")"; expect "closed company: memberships empty" "$r" 'HTTP 200 \[\]'
# PM-C-F2 (evidence/pages-milestone-critique.md): the two quarantine arms for invitations read with the beta admin's aal2
# token, which 9a shows reading the pending invitation while beta is active. At aal1, Q2 refuses first, so a policy that
# ignored company status passed this probe.
r="$(rest GET "/invitations?select=id" "$B_AAL2")"; expect "closed company: invitations empty (pending invitation hidden, admin at aal2)" "$r" 'HTTP 200 \[\]'
r="$(rest GET "/audit_events?select=id" "$B_JWT")"; expect "closed company: audit empty" "$r" 'HTTP 200 \[\]'
r="$(rest GET "/profiles?select=user_id&user_id=eq.$U_alpha_member" "$B_JWT")"; expect "closed company: co-member profile empty" "$r" 'HTTP 200 \[\]'
r="$(rest GET "/profiles?select=user_id" "$B_JWT")"; expect "closed company: own profile still visible (self rule)" "$r" "^HTTP 200 \[{\"user_id\":\"$U_beta_member\"}\]"
r="$(rest POST "/rpc/invite_member" "$SRV_BETA" "{\"p_company\":\"$BETA\",\"p_email\":\"closed@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "standing admin of the closed company: E_COMPANY_INACTIVE on the server path" "$r" 'E_COMPANY_INACTIVE'
sql -c "begin; set local app.tenant_deletion = 'on'; update app.companies set status='suspended' where id='$BETA'; commit;" >/dev/null
r="$(rest GET "/companies?select=slug" "$B_JWT")"; expect "suspended company: companies empty too" "$r" 'HTTP 200 \[\]'
r="$(rest GET "/memberships?select=id" "$B_JWT")"; expect "suspended company: memberships empty" "$r" 'HTTP 200 \[\]'
r="$(rest GET "/invitations?select=id" "$B_AAL2")"; expect "suspended company: invitations empty (admin at aal2)" "$r" 'HTTP 200 \[\]'
r="$(rest GET "/audit_events?select=id" "$B_JWT")"; expect "suspended company: audit empty" "$r" 'HTTP 200 \[\]'
r="$(rest GET "/profiles?select=user_id&user_id=eq.$U_alpha_member" "$B_JWT")"; expect "suspended company: co-member profile empty" "$r" 'HTTP 200 \[\]'
r="$(rest GET "/profiles?select=user_id" "$B_JWT")"; expect "suspended company: own profile still visible (self rule)" "$r" "^HTTP 200 \[{\"user_id\":\"$U_beta_member\"}\]"
r="$(rest POST "/rpc/invite_member" "$SRV_BETA" "{\"p_company\":\"$BETA\",\"p_email\":\"suspended@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "standing admin of the suspended company: E_COMPANY_INACTIVE on the server path" "$r" 'E_COMPANY_INACTIVE'
sql -c "update app.companies set status='active' where id='$BETA'" >/dev/null
r="$(rest GET "/companies?select=slug" "$B_JWT")"; expect "reactivated: beta visible again with the same token" "$r" 'synthetic-beta'
B_AAL2="$(node -e 'const c=require("node:crypto");const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");const now=Math.floor(Date.now()/1000);const h=b({alg:"HS256",typ:"JWT"}),p=b({sub:process.argv[1],role:"authenticated",aud:"authenticated",aal:"aal2",iat:now,exp:now+300});console.log(h+"."+p+"."+c.createHmac("sha256",process.env.JWT_SECRET).update(h+"."+p).digest("base64url"))' "$U_beta_member")"; r="$(rest GET "/invitations?select=id" "$B_AAL2")"; expect "reactivated: the pending invitation is visible again (admin at aal2, migration 005, Q2)" "$r" "$INVB"

section "9c the service role alone reads nothing in app (RLS bypass is not a privilege)"
r="$(rest GET "/companies?select=id" "$SERVICE_ROLE_KEY")"; expect "service key on api.companies refused" "$r" '42501'
r="$(sql_try -c "set role service_role; select count(*) from app.memberships;")"; expect "service_role SQL on app.memberships refused" "$r" 'permission denied'
r="$(sql_try -c "set role service_role; select count(*) from api.memberships;")"; expect "service_role SQL on api.memberships refused (security invoker)" "$r" 'permission denied'

section "9d app_maintenance: explicit grants and policies, direct connection only"
expect "role exists, nologin, no bypassrls" "$(sql -c "select rolcanlogin, rolbypassrls from pg_roles where rolname='app_maintenance'")" '^f|f$'
expect "authenticator is not a member (PostgREST cannot switch to it)" "$(sql -c "select pg_has_role('authenticator','app_maintenance','MEMBER')")" '^f$'
MAINT_JWT="$(node -e 'const c=require("node:crypto");const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");const now=Math.floor(Date.now()/1000);const h=b({alg:"HS256",typ:"JWT"}),p=b({role:"app_maintenance",iat:now,exp:now+60});console.log(h+"."+p+"."+c.createHmac("sha256",process.env.JWT_SECRET).update(h+"."+p).digest("base64url"))')"
r="$(rest GET "/memberships?select=id" "$MAINT_JWT")"; expect "a JWT with role app_maintenance is refused by PostgREST" "$r" 'HTTP 401\|HTTP 403\|42501\|PGRST'
MID="$(sql -c "select id from app.memberships where user_id='$U_alpha_member' and company_id='$BETA'")"
MADMIN="$(sql -c "select id from app.memberships where user_id='$U_beta_member' and company_id='$BETA'")"
# Local stand-in for the out-of-band login grant at the recovery target: the migration owner
# grants itself membership for the probe and revokes it at the end. The grant is not in the
# migration, so a fresh reset leaves postgres without the role.
sql -c "grant app_maintenance to postgres" >/dev/null
r="$(sql_try -c "set role app_maintenance; select count(*) from app.memberships;")"; expect "maintenance reads memberships" "$r" '^[0-9][0-9]*$'
r="$(sql_try -c "set role app_maintenance; select count(*) from app.companies where status='active';")"; expect "maintenance reads companies" "$r" '^[0-9][0-9]*$'
r="$(sql_try -c "set role app_maintenance; select count(*) from app.invitations;")"; expect "maintenance reads invitations (granted columns)" "$r" '^[0-9][0-9]*$'
r="$(sql_try -c "set role app_maintenance; select token_hash from app.invitations limit 1;")"; expect "maintenance cannot read token hashes" "$r" 'permission denied'
r="$(sql_try -c "set role app_maintenance; update app.memberships set status='removed', removed_at=now() where id='$MID' returning status;")"; expect "maintenance marks a membership removed" "$r" '^removed'
r="$(sql_try -c "set role app_maintenance; insert into app.audit_events (company_id, actor_kind, action, entity_type, entity_id, details) values ('$BETA','operator','membership.remove','membership','$MID','{\"membership_id\":\"$MID\",\"status_before\":\"active\",\"status_after\":\"removed\",\"reason_code\":\"restore_reconciliation\"}') returning id;")"; expect "maintenance appends an audit row" "$r" '^[0-9][0-9]*'

# Disclosure probe (recheck R1). Inside one transaction, as app_maintenance, every listed
# update must succeed and affect exactly one row, in both directions, and the audit count
# must not move: the grants give a trusted repair principal, not a removal-only capability,
# and nothing couples a maintenance write to an audit insert. The transaction is rolled
# back; the state checks afterwards show that nothing persisted. If the grants are ever
# narrowed behind checked maintenance routines, this probe must change with them.
r="$(sql_try -c "begin; set local role app_maintenance;
  select 'audit_before', count(*) from app.audit_events;
  with u as (update app.invitations set revoked_at = clock_timestamp() where id = '$INVB' returning 1) select 'inv_revoke', count(*) from u;
  with u as (update app.invitations set revoked_at = null where id = '$INVB' returning 1) select 'inv_unrevoke', count(*) from u;
  with u as (update app.memberships set status = 'removed', removed_at = clock_timestamp() where id = '$MADMIN' returning 1) select 'mem_remove', count(*) from u;
  with u as (update app.memberships set status = 'active', removed_at = null, roles = '{member}' where id = '$MADMIN' returning 1) select 'mem_restore_demote', count(*) from u;
  with u as (update app.memberships set roles = '{company_admin,member}' where id = '$MADMIN' returning 1) select 'mem_roles_back', count(*) from u;
  with u as (update app.companies set status = 'closed' where id = '$BETA' returning 1) select 'co_close', count(*) from u;
  set local app.tenant_deletion = 'on';
  with u as (update app.companies set status = 'active' where id = '$BETA' returning 1) select 'co_reopen', count(*) from u;
  set local app.tenant_deletion = 'off';
  select 'audit_after', count(*) from app.audit_events;
  rollback;")"
for k in inv_revoke inv_unrevoke mem_remove mem_restore_demote mem_roles_back co_close co_reopen; do
  expect "disclosure: maintenance $k affects exactly one row" "$r" "^$k|1\$"
done
AB="$(printf '%s\n' "$r" | sed -n 's/^audit_before|//p')"; AA="$(printf '%s\n' "$r" | sed -n 's/^audit_after|//p')"
expect "disclosure: audit count unchanged by seven maintenance updates (no coupling)" "$AB/$AA" "^[0-9][0-9]*/$AB\$"
expect "disclosure: transaction rolled back, invitation still pending" "$(sql -c "select revoked_at is null from app.invitations where id='$INVB'")" '^t$'
expect "disclosure: beta admin membership unchanged" "$(sql -c "select status, roles from app.memberships where id='$MADMIN'")" '^active|{company_admin,member}$'
expect "disclosure: beta still active" "$(sql -c "select status from app.companies where id='$BETA'")" '^active$'

r="$(sql_try -c "set role app_maintenance; with u as (update app.invitations set revoked_at=now() where company_id='$BETA' and revoked_at is null and accepted_at is null returning id) select count(*) from u;")"; expect "maintenance revokes pending invitations: exactly one row (the 9a fixture)" "$r" '^1$'
expect "the revoked row is the fixture" "$(sql -c "select revoked_at is not null from app.invitations where id='$INVB'")" '^t$'
r="$(sql_try -c "set role app_maintenance; delete from app.memberships where id='$MID';")"; expect "maintenance cannot delete memberships" "$r" 'permission denied'
r="$(sql_try -c "set role app_maintenance; delete from app.audit_events;")"; expect "maintenance cannot delete audit rows" "$r" 'permission denied'
r="$(sql_try -c "set role app_maintenance; update app.memberships set user_id='$U_outsider' where id='$MID';")"; expect "maintenance cannot rewrite membership identity (column grant)" "$r" 'permission denied'
r="$(sql_try -c "set role app_maintenance; select api.invite_member('$BETA','x@example.invalid','{member}');")"; expect "maintenance cannot call api functions" "$r" 'permission denied'
sql -c "update app.memberships set status='active', removed_at=null where id='$MID'" >/dev/null
sql -c "revoke app_maintenance from postgres" >/dev/null
r="$(sql_try -c "set role app_maintenance; select 1;")"; expect "after the revoke the owner can no longer assume the role" "$r" 'permission denied'
[ "$FAILED" = 0 ] && echo "09 PASS" || { echo "09 FAIL"; exit 1; }
