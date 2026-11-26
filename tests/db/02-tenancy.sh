#!/usr/bin/env bash
# Tenancy probe: RLS keyed by active membership. Company A cannot read B; a removed member
# with a valid JWT gets zero rows and its server-token RPCs are refused by the database.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"
A_JWT="$(user_jwt synthetic-alpha-member@example.invalid "$PW")"
A_ADMIN_JWT="$(user_jwt synthetic-alpha-admin1@example.invalid "$PW")"
B_JWT="$(user_jwt synthetic-beta-member@example.invalid "$PW")"
REMOVED_JWT="$(user_jwt synthetic-alpha-removed@example.invalid "$PW")"
OUT_JWT="$(user_jwt synthetic-outsider@example.invalid "$PW")"

section "2a company A member reads companies and memberships: only alpha"
r="$(rest GET "/companies?select=slug&order=slug" "$A_JWT")"; expect "A sees only alpha" "$r" 'HTTP 200 \[{"slug":"synthetic-alpha"}\]'
r="$(rest GET "/companies?select=slug&id=eq.$BETA" "$A_JWT")"; expect "A reading B by guessed id: empty" "$r" 'HTTP 200 \[\]'
r="$(rest GET "/memberships?select=company_id&company_id=eq.$BETA" "$A_JWT")"; expect "A reading B memberships: empty" "$r" 'HTTP 200 \[\]'
r="$(rest GET "/memberships?select=user_id&company_id=eq.$ALPHA" "$A_JWT")"; expect "A reads alpha memberships (4 rows incl. removed)" "$r" "$U_alpha_removed"
r="$(rest GET "/profiles?select=user_id&user_id=eq.$U_beta_member" "$A_JWT")"; expect "A reading B profile: empty" "$r" 'HTTP 200 \[\]'
r="$(rest GET "/companies?select=slug" "$B_JWT")"; expect "B sees only beta" "$r" 'HTTP 200 \[{"slug":"synthetic-beta"}\]'

section "2b role-gated reads"
r="$(rest GET "/invitations?select=id" "$A_JWT")"; expect "plain member reads no invitations" "$r" 'HTTP 200 \[\]'
A_ADMIN_AAL2="$(node -e 'const c=require("node:crypto");const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");const now=Math.floor(Date.now()/1000);const h=b({alg:"HS256",typ:"JWT"}),p=b({sub:process.argv[1],role:"authenticated",aud:"authenticated",aal:"aal2",iat:now,exp:now+300});console.log(h+"."+p+"."+c.createHmac("sha256",process.env.JWT_SECRET).update(h+"."+p).digest("base64url"))' "$U_alpha_admin1")"; r="$(rest GET "/invitations?select=id,email_normalized" "$A_ADMIN_AAL2")"; expect "admin at aal2 reads alpha invitations (migration 005, Q2)" "$r" 'probe1@example.invalid'
r="$(rest GET "/invitations?select=id,email_normalized" "$A_ADMIN_JWT")"; expect "Q2 control: the same admin at aal1 reads no invitations" "$r" 'HTTP 200 \[\]'
# PM-C-F2 (evidence/pages-milestone-critique.md): the plain-member arm above reads at aal1, where Q2 refuses before the
# admin predicate is reached, so a policy that dropped company_admin and kept aal2 passed this probe. The same member at
# aal2, while the admin at aal2 reads alpha's invitation, is the arm that only the admin predicate can refuse.
A_MEMBER_AAL2="$(node -e 'const c=require("node:crypto");const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");const now=Math.floor(Date.now()/1000);const h=b({alg:"HS256",typ:"JWT"}),p=b({sub:process.argv[1],role:"authenticated",aud:"authenticated",aal:"aal2",iat:now,exp:now+300});console.log(h+"."+p+"."+c.createHmac("sha256",process.env.JWT_SECRET).update(h+"."+p).digest("base64url"))' "$U_alpha_member")"; r="$(rest GET "/invitations?select=id,email_normalized" "$A_MEMBER_AAL2")"; expect "PM-C-F2: an ordinary alpha member at aal2 reads no invitations (the admin predicate, not aal)" "$r" 'HTTP 200 \[\]'
r="$(rest GET "/invitations?select=token_hash" "$A_ADMIN_JWT")"; expect "token_hash not selectable even by admin" "$r" '42703\|42501\|HTTP 400'
r="$(rest GET "/audit_events?select=action" "$A_JWT")"; expect "plain member reads no audit rows" "$r" 'HTTP 200 \[\]'
r="$(rest GET "/audit_events?select=action&order=id" "$A_ADMIN_JWT")"; expect "admin reads alpha audit" "$r" 'company.provision'
r="$(rest GET "/audit_events?select=company_id&company_id=eq.$BETA" "$A_ADMIN_JWT")"; expect "alpha admin reads no beta audit" "$r" 'HTTP 200 \[\]'

section "2c stale membership: valid GoTrue JWT, membership row removed"
r="$(rest GET "/companies?select=slug" "$REMOVED_JWT")"; expect "removed member: zero companies" "$r" 'HTTP 200 \[\]'
r="$(rest GET "/memberships?select=id" "$REMOVED_JWT")"; expect "removed member: zero memberships (not even own row)" "$r" 'HTTP 200 \[\]'
r="$(rest GET "/profiles?select=user_id" "$REMOVED_JWT")"; expect "removed member: only own profile visible (none exists yet)" "$r" 'HTTP 200 \[\]'
SRV_REMOVED="$(server_jwt "$U_alpha_removed")"
r="$(rest POST "/rpc/invite_member" "$SRV_REMOVED" "{\"p_company\":\"$ALPHA\",\"p_email\":\"stale@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "removed member via server path: E_NOT_FOUND (same as absent)" "$r" 'E_NOT_FOUND'

section "2d live removal: access ends at the next statement, token untouched"
SRV_ADMIN="$(server_jwt "$U_alpha_admin1" aal2)"
MID="$(sql -c "select id from app.memberships where user_id='$U_alpha_member'")"
r="$(rest GET "/companies?select=slug" "$A_JWT")"; expect "before removal: alpha visible" "$r" 'synthetic-alpha'
r="$(rest POST "/rpc/remove_member" "$SRV_ADMIN" "{\"p_membership\":\"$MID\"}")"; expect "admin removes member" "$r" '"changed":true'
r="$(rest GET "/companies?select=slug" "$A_JWT")"; expect "same JWT after removal: zero rows" "$r" 'HTTP 200 \[\]'
r="$(rest POST "/rpc/remove_member" "$SRV_ADMIN" "{\"p_membership\":\"$MID\"}")"; expect "retry remove: idempotent no-op" "$r" '"changed":false'
n="$(sql -c "select count(*) from app.audit_events where entity_id='$MID' and action='membership.remove'")"; expect "exactly one audit row for the removal" "$n" '^1$'

section "2e outsider with an account and no membership"
r="$(rest GET "/companies?select=slug" "$OUT_JWT")"; expect "outsider: zero companies" "$r" 'HTTP 200 \[\]'

section "2f RLS state in the catalog"
sql -c "select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace='app'::regnamespace and relkind='r' order by 1"
sql -c "select tablename, policyname, cmd, roles from pg_policies where schemaname='app' order by 1,2"
[ "$FAILED" = 0 ] && echo "02 PASS" || { echo "02 FAIL"; exit 1; }
