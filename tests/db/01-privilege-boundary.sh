#!/usr/bin/env bash
# B1 probe: a member's own JWT can neither write app tables nor call any api function;
# anon gets nothing; the server principal can call functions but not touch tables.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"
ADMIN_JWT="$(user_jwt synthetic-alpha-admin1@example.invalid "$PW")"
MEMBER_JWT="$(user_jwt synthetic-alpha-member@example.invalid "$PW")"
SRV_ADMIN="$(server_jwt "$U_alpha_admin1" aal2)"

section "1a raw DML with a valid admin JWT (role authenticated) on exposed views"
r="$(rest POST "/memberships" "$ADMIN_JWT" "{\"company_id\":\"$ALPHA\",\"user_id\":\"$U_outsider\",\"roles\":[\"member\"]}")"; expect "insert membership via JWT refused" "$r" "HTTP 401\|HTTP 403\|42501"
r="$(rest PATCH "/memberships?user_id=eq.$U_alpha_member" "$ADMIN_JWT" '{"roles":["company_admin","member"]}')"; expect "update roles via JWT refused" "$r" "HTTP 401\|HTTP 403\|42501"
r="$(rest DELETE "/memberships?user_id=eq.$U_alpha_member" "$ADMIN_JWT")"; expect "delete membership via JWT refused" "$r" "HTTP 401\|HTTP 403\|42501"
r="$(rest POST "/invitations" "$ADMIN_JWT" "{\"company_id\":\"$ALPHA\",\"email_normalized\":\"x@example.invalid\",\"roles\":[\"member\"],\"expires_at\":\"2030-01-01\"}")"; expect "insert invitation via JWT refused" "$r" "HTTP 401\|HTTP 403\|42501"
r="$(rest POST "/audit_events" "$ADMIN_JWT" "{\"company_id\":\"$ALPHA\",\"actor_kind\":\"member\",\"action\":\"x.y\",\"entity_type\":\"t\"}")"; expect "insert audit via JWT refused" "$r" "HTTP 401\|HTTP 403\|42501"

section "1b RPC with a valid admin JWT (role authenticated): every api function refused"
for fn in invite_member revoke_invitation accept_invitation set_roles remove_member provision_company transfer_first_admin add_operator; do
  r="$(rest POST "/rpc/$fn" "$ADMIN_JWT" '{}')"; expect "rpc $fn via member JWT refused" "$r" "HTTP 401\|HTTP 403\|HTTP 404\|42501\|PGRST202"
done
r="$(rest POST "/rpc/invite_member" "$ADMIN_JWT" "{\"p_company\":\"$ALPHA\",\"p_email\":\"new@example.invalid\",\"p_roles\":[\"company_admin\"]}")"; expect "rpc invite_member with real args via admin JWT refused" "$r" "42501"

section "1c anon and service_role"
r="$(rest GET "/memberships?select=id" "$ANON_KEY")"; expect "anon select memberships: zero rows or refused" "$r" "HTTP 200 \[\]\|HTTP 401\|HTTP 403\|42501"
r="$(rest POST "/rpc/invite_member" "$ANON_KEY" "{\"p_company\":\"$ALPHA\",\"p_email\":\"new@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "anon rpc refused" "$r" "42501\|HTTP 401\|HTTP 403"
r="$(rest POST "/rpc/invite_member" "$SERVICE_ROLE_KEY" "{\"p_company\":\"$ALPHA\",\"p_email\":\"new@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "service_role rpc refused (no EXECUTE grant)" "$r" "42501"

section "1d server principal (role app_server, sub=admin1): functions callable, tables not"
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"probe1@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "server token invite_member ok" "$r" "HTTP 200.*invitation_id"
r="$(rest GET "/memberships?select=id" "$SRV_ADMIN")"; expect "server token select memberships refused (no table grant)" "$r" "42501\|HTTP 401\|HTTP 403"
r="$(rest POST "/memberships" "$SRV_ADMIN" "{\"company_id\":\"$ALPHA\",\"user_id\":\"$U_outsider\",\"roles\":[\"member\"]}")"; expect "server token insert memberships refused" "$r" "42501\|HTTP 401\|HTTP 403"

section "1e server token forged by a member: signature check"
FORGED="$(printf '%s' "$SRV_ADMIN" | cut -d. -f1-2).AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
r="$(rest POST "/rpc/invite_member" "$FORGED" "{\"p_company\":\"$ALPHA\",\"p_email\":\"forged@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "bad signature refused" "$r" "HTTP 401"
SRV_NOSUB="$(node -e 'const c=require("node:crypto");const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");const now=Math.floor(Date.now()/1000);const h=b({alg:"HS256",typ:"JWT"}),p=b({role:"app_server",iat:now,exp:now+60});console.log(h+"."+p+"."+c.createHmac("sha256",process.env.JWT_SECRET).update(h+"."+p).digest("base64url"))')"
r="$(rest POST "/rpc/invite_member" "$SRV_NOSUB" "{\"p_company\":\"$ALPHA\",\"p_email\":\"nosub@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "server token without sub refused E_NOT_SERVER" "$r" "E_NOT_SERVER"
SRV_MEMBER="$(server_jwt "$U_alpha_member")"
r="$(rest POST "/rpc/invite_member" "$SRV_MEMBER" "{\"p_company\":\"$ALPHA\",\"p_email\":\"esc@example.invalid\",\"p_roles\":[\"company_admin\"]}")"; expect "server token for a non-admin member: E_FORBIDDEN" "$r" "E_FORBIDDEN"
SRV_OUT="$(server_jwt "$U_outsider")"
r="$(rest POST "/rpc/invite_member" "$SRV_OUT" "{\"p_company\":\"$ALPHA\",\"p_email\":\"esc@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "server token for a non-member: E_NOT_FOUND" "$r" "E_NOT_FOUND"

section "1f grants and search_path as recorded in the catalog"
sql -c "select routine_name, grantee from information_schema.routine_privileges where specific_schema='api' and grantee not in ('postgres') order by 1,2"
sql -c "select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) from information_schema.table_privileges where table_schema='app' and grantee in ('anon','authenticated','app_server','service_role') group by 1,2 order by 2,1"
sql -c "select grantee, string_agg(column_name, ',' order by column_name) from information_schema.column_privileges where table_schema='app' and table_name='invitations' and grantee='authenticated' group by 1"
sql -c "select p.proname, p.prosecdef, p.proconfig from pg_proc p where p.pronamespace in ('api'::regnamespace,'app'::regnamespace) and p.prosecdef order by 1"

section "1g bound server tokens (E3 design 2.6 item 1): a token carrying an fn claim reaches no E2 function"
# lib/db/server.mjs binds an E3 bearer with fn, args_sha256 and jti. Each bound token here carries
# the same role, sub and aal as an unbound token that reaches the routine (1d for the admin; the
# unbound no-op controls below), so the binding claims are the only difference. fn naming the E2
# function itself, and fn null, are refused too: the refusal is the claim's presence, not a
# comparison. Every call here writes nothing, so later probes see the state they expect.
bound() { printf '{"fn":%s,"args_sha256":"%s","jti":"7d0c6b2e-4f1a-4c3b-9e8d-2a1b0c9d8e7f"}' "$1" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; }
MEMBER_MS="$(sql -c "select id from app.memberships where user_id='$U_alpha_member'")"
INV_BEFORE="$(sql -c "select count(*) from app.invitations")"
AUDIT_BEFORE="$(sql -c "select count(*) from app.audit_events")"
OPS_BEFORE="$(sql -c "select count(*) from app.operators")"
r="$(rest POST "/rpc/invite_member" "$(server_jwt "$U_alpha_admin1" aal2 "$(bound '"save_draft"')")" "{\"p_company\":\"$ALPHA\",\"p_email\":\"bound-save@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "admin aal2 token bound to save_draft, invite_member: E_NOT_SERVER" "$r" "E_NOT_SERVER"
r="$(rest POST "/rpc/invite_member" "$(server_jwt "$U_alpha_admin1" aal2 "$(bound '"invite_member"')")" "{\"p_company\":\"$ALPHA\",\"p_email\":\"bound-self@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "admin aal2 token bound to invite_member itself, invite_member: E_NOT_SERVER" "$r" "E_NOT_SERVER"
r="$(rest POST "/rpc/invite_member" "$(server_jwt "$U_alpha_admin1" aal2 "$(bound null)")" "{\"p_company\":\"$ALPHA\",\"p_email\":\"bound-null@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "admin aal2 token with fn null, invite_member: E_NOT_SERVER" "$r" "E_NOT_SERVER"
r="$(rest POST "/rpc/set_roles" "$(server_jwt "$U_alpha_admin1" aal2 "$(bound '"save_draft"')")" "{\"p_membership\":\"$MEMBER_MS\",\"p_roles\":[\"member\"]}")"; expect "admin aal2 token bound to save_draft, set_roles: E_NOT_SERVER" "$r" "E_NOT_SERVER"
r="$(rest POST "/rpc/set_roles" "$SRV_ADMIN" "{\"p_membership\":\"$MEMBER_MS\",\"p_roles\":[\"member\"]}")"; expect "control: the same admin aal2 token unbound, set_roles: HTTP 200 no-op" "$r" 'HTTP 200.*"changed":false'
r="$(rest POST "/rpc/add_operator" "$(server_jwt "$U_op" aal2 "$(bound '"save_draft"')")" "{\"p_user\":\"$U_op\"}")"; expect "operator aal2 token bound to save_draft, add_operator (through app.operator_actor): E_NOT_SERVER" "$r" "E_NOT_SERVER"
r="$(rest POST "/rpc/add_operator" "$(server_jwt "$U_op" aal2)" "{\"p_user\":\"$U_op\"}")"; expect "control: the same operator aal2 token unbound, add_operator: HTTP 200 no-op" "$r" 'HTTP 200.*"changed":false'
expect "no invitation written by the bound calls" "$(sql -c "select count(*) from app.invitations")" "^$INV_BEFORE\$"
expect "no audit row written by the bound calls or the no-op controls" "$(sql -c "select count(*) from app.audit_events")" "^$AUDIT_BEFORE\$"
expect "operator set unchanged" "$(sql -c "select count(*) from app.operators")" "^$OPS_BEFORE\$"
[ "$FAILED" = 0 ] && echo "01 PASS" || { echo "01 FAIL"; exit 1; }
