#!/usr/bin/env bash
# Invitation probe: hashed at rest, single use, expiry, revocation, replay, binding to the
# signed-in user's confirmed email, escalation refused, reactivation keeps the membership id,
# and the before-user-created hook.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"
SRV_ADMIN="$(server_jwt "$U_alpha_admin1" aal2)"
SRV_MEMBER="$(server_jwt "$U_alpha_member")"
SRV_OUT="$(server_jwt "$U_outsider")"
SRV_REMOVED="$(server_jwt "$U_alpha_removed")"
SRV_BETA="$(server_jwt "$U_beta_member" aal2)"
field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"; }

section "4a create: code returned once, only its SHA-256 stored"
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"  Synthetic-Outsider@Example.Invalid \",\"p_roles\":[\"it_reviewer\"]}")"; expect "invite created (email normalized)" "$r" 'HTTP 200'
TOK="$(field "$r" invite_code)"; INV="$(field "$r" invitation_id)"
stored="$(sql -c "select encode(token_hash,'hex'), email_normalized, roles from app.invitations where id='$INV'")"
expect "stored hash equals sha256(code) and roles include member" "$stored" "$(printf '%s' "$TOK" | xxd -r -p | shasum -a 256 | cut -c1-64)|synthetic-outsider@example.invalid|{it_reviewer,member}"
expect "code itself not stored anywhere" "$(sql -c "select count(*) from app.invitations where encode(token_hash,'hex')='$TOK'")" '^0$'
expect "audit details carry the invitation id, no email" "$(sql -c "select details from app.audit_events where entity_id='$INV'")" 'invitation_id'
expect "audit details contain no email" "$(sql -c "select details::text like '%@%' from app.audit_events where entity_id='$INV'")" '^f$'

section "4b binding: wrong signed-in user, unknown token, malformed token"
r="$(rest POST "/rpc/accept_invitation" "$SRV_MEMBER" "{\"p_invite_code\":\"$TOK\"}")"; expect "another signed-in user: E_EMAIL_MISMATCH" "$r" 'E_EMAIL_MISMATCH'
r="$(rest POST "/rpc/accept_invitation" "$SRV_OUT" "{\"p_invite_code\":\"$(printf '%064d' 0)\"}")"; expect "unknown code: E_INVITATION_INVALID" "$r" 'E_INVITATION_INVALID'
r="$(rest POST "/rpc/accept_invitation" "$SRV_OUT" "{\"p_invite_code\":\"zz\"}")"; expect "malformed code: E_INVITATION_INVALID" "$r" 'E_INVITATION_INVALID'
r="$(rest POST "/rpc/accept_invitation" "$SRV_OUT" "{\"p_invite_code\":\"$INV\"}")"; expect "invitation id used as code: E_INVITATION_INVALID" "$r" 'E_INVITATION_INVALID'

section "4c accept by the right user; roles come from the row, not the caller"
r="$(rest POST "/rpc/accept_invitation" "$SRV_OUT" "{\"p_invite_code\":\"$TOK\"}")"; expect "accepted with it_reviewer,member" "$r" '"roles":\["it_reviewer","member"\],"reactivated":false'
MOUT="$(field "$r" membership_id)"
r="$(rest POST "/rpc/accept_invitation" "$SRV_OUT" "{\"p_invite_code\":\"$TOK\"}")"; expect "replay of the used code: E_INVITATION_INVALID" "$r" 'E_INVITATION_INVALID'
expect "invitation marked accepted with the membership id" "$(sql -c "select accepted_membership_id from app.invitations where id='$INV'")" "$MOUT"
OUT_JWT="$(user_jwt synthetic-outsider@example.invalid "$PW")"
r="$(rest GET "/companies?select=slug" "$OUT_JWT")"; expect "new member now reads alpha with its own JWT" "$r" 'synthetic-alpha'

section "4d escalation: a forged or altered invitation cannot grant company_admin"
r="$(rest POST "/rpc/accept_invitation" "$SRV_OUT" "{\"p_invite_code\":\"$TOK\",\"p_roles\":[\"company_admin\"]}")"; expect "extra p_roles argument: no such function signature" "$r" 'PGRST202\|HTTP 404'
r="$(rest POST "/rpc/invite_member" "$SRV_OUT" "{\"p_company\":\"$ALPHA\",\"p_email\":\"friend@example.invalid\",\"p_roles\":[\"company_admin\"]}")"; expect "non-admin (the new it_reviewer) cannot issue an invitation" "$r" 'E_FORBIDDEN'
r="$(rest POST "/rpc/invite_member" "$SRV_MEMBER" "{\"p_company\":\"$ALPHA\",\"p_email\":\"friend@example.invalid\",\"p_roles\":[\"company_admin\"]}")"; expect "removed member (probe 2d) cannot issue an invitation: E_NOT_FOUND" "$r" 'E_NOT_FOUND'
r="$(rest POST "/rpc/invite_member" "$SRV_BETA" "{\"p_company\":\"$ALPHA\",\"p_email\":\"friend@example.invalid\",\"p_roles\":[\"company_admin\"]}")"; expect "beta admin cannot invite into alpha (E_NOT_FOUND)" "$r" 'E_NOT_FOUND'
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"friend@example.invalid\",\"p_roles\":[\"owner\"]}")"; expect "unknown role refused E_ROLES_INVALID" "$r" 'E_ROLES_INVALID'
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"not-an-email\",\"p_roles\":[\"member\"]}")"; expect "malformed email refused by CHECK" "$r" '23514'
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"synthetic-alpha-admin2@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "active member cannot be re-invited (E_ALREADY_MEMBER)" "$r" 'E_ALREADY_MEMBER'

section "4e expiry and revocation"
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"synthetic-alpha-removed@example.invalid\",\"p_roles\":[\"member\"],\"p_expires_in\":\"1 second\"}")"; TOK2="$(field "$r" invite_code)"; INV2="$(field "$r" invitation_id)"
sleep 2
r="$(rest POST "/rpc/accept_invitation" "$SRV_REMOVED" "{\"p_invite_code\":\"$TOK2\"}")"; expect "expired code: E_INVITATION_INVALID" "$r" 'E_INVITATION_INVALID'
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"synthetic-alpha-removed@example.invalid\",\"p_roles\":[\"member\"]}")"; TOK3="$(field "$r" invite_code)"; INV3="$(field "$r" invitation_id)"
r="$(rest POST "/rpc/revoke_invitation" "$SRV_OUT" "{\"p_invitation\":\"$INV3\"}")"; expect "non-admin cannot revoke" "$r" 'E_FORBIDDEN'
r="$(rest POST "/rpc/revoke_invitation" "$SRV_ADMIN" "{\"p_invitation\":\"$INV3\"}")"; expect "admin revokes" "$r" '"changed":true'
r="$(rest POST "/rpc/revoke_invitation" "$SRV_ADMIN" "{\"p_invitation\":\"$INV3\"}")"; expect "revoke again: idempotent" "$r" '"changed":false'
r="$(rest POST "/rpc/accept_invitation" "$SRV_REMOVED" "{\"p_invite_code\":\"$TOK3\"}")"; expect "revoked code: E_INVITATION_INVALID" "$r" 'E_INVITATION_INVALID'
r="$(rest POST "/rpc/revoke_invitation" "$SRV_ADMIN" "{\"p_invitation\":\"$INV\"}")"; expect "revoking an accepted invitation: E_INVITATION_ACCEPTED" "$r" 'E_INVITATION_ACCEPTED'
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"x@example.invalid\",\"p_roles\":[\"member\"],\"p_expires_in\":\"90 days\"}")"; expect "expiry above 30 days refused" "$r" 'E_EXPIRY_INVALID'

section "4f reactivation of a removed member keeps the membership id"
OLD_MID="$(sql -c "select id from app.memberships where user_id='$U_alpha_removed'")"
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"synthetic-alpha-removed@example.invalid\",\"p_roles\":[\"business_reviewer\"]}")"; TOK4="$(field "$r" invite_code)"
r="$(rest POST "/rpc/accept_invitation" "$SRV_REMOVED" "{\"p_invite_code\":\"$TOK4\"}")"; expect "reactivated with the same membership id" "$r" "\"membership_id\":\"$OLD_MID\".*\"reactivated\":true"
expect "row count for that user is still one" "$(sql -c "select count(*) from app.memberships where user_id='$U_alpha_removed'")" '^1$'
expect "status active, removed_at null, roles replaced" "$(sql -c "select status, removed_at is null, roles from app.memberships where id='$OLD_MID'")" 'active|t|{business_reviewer,member}'
REM_JWT="$(user_jwt synthetic-alpha-removed@example.invalid "$PW")"
r="$(rest GET "/companies?select=slug" "$REM_JWT")"; expect "reactivated member reads alpha again" "$r" 'synthetic-alpha'

section "4g two invitations for one email: the older one is revoked on creation"
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"dup@example.invalid\",\"p_roles\":[\"member\"]}")"; I1="$(field "$r" invitation_id)"
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"dup@example.invalid\",\"p_roles\":[\"member\"]}")"; I2="$(field "$r" invitation_id)"
expect "first invitation revoked" "$(sql -c "select revoked_at is not null from app.invitations where id='$I1'")" '^t$'
expect "second pending" "$(sql -c "select revoked_at is null from app.invitations where id='$I2'")" '^t$'

section "4h before-user-created hook: body called directly as the owner, then the real GoTrue path (which proves the supabase_auth_admin grant)"
hooksql() { sql_try -c "$1"; }
r="$(hooksql "select app.hook_before_user_created('{\"user\":{\"email\":\"Dup@Example.invalid\"}}'::jsonb);")"; expect "invited email: hook returns {}" "$r" '^{}$'
r="$(hooksql "select app.hook_before_user_created('{\"user\":{\"email\":\"nobody@example.invalid\"}}'::jsonb);")"; expect "uninvited email: 403" "$r" '"http_code": 403'
r="$(hooksql "select app.hook_before_user_created('{\"user\":{}}'::jsonb);")"; expect "no email: 403" "$r" '"http_code": 403'
r="$(hooksql "select app.hook_before_user_created('{\"user\":{\"email\":\"synthetic-op@example.invalid\"}}'::jsonb);")"; expect "operator allowlist: {}" "$r" '^{}$'
r="$(sql_try -c "set role authenticated; select app.hook_before_user_created('{\"user\":{\"email\":\"dup@example.invalid\"}}'::jsonb);")"; expect "authenticated cannot call the hook" "$r" 'permission denied'
# H1 correction: GoTrue signup is disabled, so the public /otp route creates no account for
# anyone, invited or not; the real GoTrue execution of the hook (and the supabase_auth_admin
# grant) is proven in 11b through admin generate_link, the server's creation path.
r="$(curl -sS "$API_URL/auth/v1/otp" -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' -d '{"email":"nobody@example.invalid","create_user":true}')"; expect "GoTrue /otp for an uninvited email: refused (signup disabled)" "$r" 'signup_disabled'
expect "no auth user was created for the uninvited email" "$(sql -c "select count(*) from auth.users where email='nobody@example.invalid'")" '^0$'
r="$(curl -sS "$API_URL/auth/v1/otp" -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' -d '{"email":"dup@example.invalid","create_user":true}')"; expect "GoTrue /otp for an INVITED email: refused too (no public route creates accounts)" "$r" 'signup_disabled'
expect "no auth user was created for the invited email through the public route" "$(sql -c "select count(*) from auth.users where email='dup@example.invalid'")" '^0$'
[ "$FAILED" = 0 ] && echo "04 PASS" || { echo "04 FAIL"; exit 1; }
