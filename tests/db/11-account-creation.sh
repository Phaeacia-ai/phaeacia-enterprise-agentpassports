#!/usr/bin/env bash
# H1 probe: account pre-hijack. Design after the correction (docs/e2 section 4): no public
# route creates an account (GoTrue signup disabled), confirmations are required, and the
# server creates the invitee's account through the GoTrue admin API at invitation time with
# no password and no confirmation; the invitation email carries the server-generated
# single-use link, which confirms the mailbox. The before-user-created hook stays as defense
# in depth on the creation paths that run it.
# Schedule from the critique: invited email, attacker signup, recipient acceptance, attacker
# token must read nothing. Here the attacker never obtains a token: it cannot create the
# account, cannot seed a password, and cannot sign in before or after the recipient confirms.
# Locally GoTrue has no SMTP host, so its mailer is a no-op: nothing is delivered, the
# "recipient" is simulated by using the link the admin API returned to the server.
# At 6de3c1a (signup enabled, confirmations off): 11a's attacker signup returns a session
# for an already-confirmed account, so this probe fails there.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"
SRV_ADMIN="$(server_jwt "$U_alpha_admin1" aal2)"
field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"; }
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j={};try{j=JSON.parse(s)}catch(e){};const v=j[process.argv[1]];process.stdout.write(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):String(v))})' "$1"; }
auth() { # path json [service]  -> body
  if [ "${3:-}" = service ]; then
    curl -sS "$API_URL/auth/v1$1" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H 'Content-Type: application/json' -d "$2"
  else
    curl -sS "$API_URL/auth/v1$1" -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' -d "$2"
  fi
}
VICTIM='synthetic-victim@example.invalid'
ATTACKER_PW='SYNTHETIC-attacker-12345'
users() { sql -c "select count(*) from auth.users where email='$VICTIM'"; }

section "11a invitation issued; the attacker's public account-creation attempts fail and create nothing"
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"$VICTIM\",\"p_roles\":[\"company_admin\"]}")"; expect "admin invites the victim address as company_admin" "$r" 'HTTP 200'
CODE="$(field "$r" invite_code)"
r="$(auth /signup "{\"email\":\"$VICTIM\",\"password\":\"$ATTACKER_PW\"}")"
expect "attacker POST /signup with the invited email: refused (signup_disabled), no session" "$(printf 'code=%s session=%s' "$(printf '%s' "$r" | jget error_code)" "$([ -n "$(printf '%s' "$r" | jget access_token)" ] && echo yes || echo no)")" '^code=signup_disabled session=no$'
r="$(auth /otp "{\"email\":\"$VICTIM\",\"create_user\":true}")"; expect "attacker POST /otp create_user: refused (signup_disabled)" "$(printf '%s' "$r" | jget error_code)" '^signup_disabled$'
expect "no auth.users row exists for the invited email" "$(users)" '^0$'
r="$(auth /token?grant_type=password "{\"email\":\"$VICTIM\",\"password\":\"$ATTACKER_PW\"}")"; expect "attacker password grant on a non-existent account: invalid_credentials" "$(printf '%s' "$r" | jget error_code)" '^invalid_credentials$'

section "11b the server creates the account through the admin API (generate_link, hook-gated), unconfirmed, no password"
r="$(auth /admin/generate_link '{"type":"magiclink","email":"synthetic-uninvited@example.invalid"}' service)"; expect "generate_link for an uninvited email: the hook refuses (real GoTrue path, supabase_auth_admin grant)" "$r" 'Invitation required'
expect "no account for the uninvited email" "$(sql -c "select count(*) from auth.users where email='synthetic-uninvited@example.invalid'")" '^0$'
g="$(auth /admin/generate_link "{\"type\":\"magiclink\",\"email\":\"$VICTIM\"}" service)"
VT="$(printf '%s' "$g" | jget verification_type)"; HT="$(printf '%s' "$g" | jget hashed_token)"; UID_V="$(printf '%s' "$g" | jget id)"
expect "generate_link for the invited email returns a signup-type link and creates the account" "type=$VT id=${UID_V:0:8} token=${#HT}" '^type=signup id=[0-9a-f]\{8\} token=[0-9]\{2,\}$'
expect "the returned body carries no session" "$([ -z "$(printf '%s' "$g" | jget access_token)" ] && echo none || echo present)" '^none$'
expect "account unconfirmed, no password known to anyone (GoTrue stores a hash of the empty password for passwordless accounts)" "$(sql -c "select email_confirmed_at is null, coalesce(encrypted_password,'') <> '' from auth.users where id='$UID_V'")" '^t|t$'
expect "exactly one account for the email" "$(users)" '^1$'
r="$(auth /token?grant_type=password "{\"email\":\"$VICTIM\",\"password\":\"$ATTACKER_PW\"}")"; expect "attacker password grant before confirmation: invalid_credentials" "$(printf '%s' "$r" | jget error_code)" '^invalid_credentials$'
r="$(auth /token?grant_type=password "{\"email\":\"$VICTIM\",\"password\":\"\"}")"; expect "empty password grant before confirmation: refused" "$(printf '%s' "$r" | jget error_code)" '^invalid_credentials\|^validation_failed'
r="$(auth /signup "{\"email\":\"$VICTIM\",\"password\":\"$ATTACKER_PW\"}")"; expect "attacker /signup against the existing unconfirmed account: still signup_disabled" "$(printf '%s' "$r" | jget error_code)" '^signup_disabled$'
r="$(auth /otp "{\"email\":\"$VICTIM\",\"create_user\":false}")"; expect "public /otp for the unconfirmed account: refused (GoTrue treats it as a signup)" "$(printf '%s' "$r" | jget error_code)" '^signup_disabled$'

section "11c an unconfirmed account cannot accept, even with the right code"
r="$(rest POST "/rpc/accept_invitation" "$(server_jwt "$UID_V")" "{\"p_invite_code\":\"$CODE\"}")"; expect "accept_invitation for the unconfirmed account: E_EMAIL_MISMATCH" "$r" 'E_EMAIL_MISMATCH'
expect "no membership was created" "$(sql -c "select count(*) from app.memberships where user_id='$UID_V'")" '^0$'

section "11d the recipient opens the server-generated link (simulated: the link the admin API returned); the attacker still gets nothing"
printf '{"type":"%s","token_hash":"%s"}' "$VT" "$HT" > "$E2_TMP/verify.json"
v="$(curl -sS "$API_URL/auth/v1/verify" -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' -d @"$E2_TMP/verify.json")"
VICTIM_JWT="$(printf '%s' "$v" | jget access_token)"
expect "verify yields the recipient's session and confirms the email" "$(printf 'session=%s confirmed=%s' "$([ -n "$VICTIM_JWT" ] && echo yes || echo no)" "$(sql -c "select email_confirmed_at is not null from auth.users where id='$UID_V'")")" '^session=yes confirmed=t$'
expect "the session was established by the link, not a password (amr)" "$(printf '%s' "$VICTIM_JWT" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | jget amr)" 'otp'
r="$(curl -sS "$API_URL/auth/v1/verify" -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' -d @"$E2_TMP/verify.json")"; expect "the link is single use" "$(printf '%s' "$r" | jget error_code)" '^otp_expired$'
r="$(auth /token?grant_type=password "{\"email\":\"$VICTIM\",\"password\":\"$ATTACKER_PW\"}")"; expect "attacker password grant after confirmation: invalid_credentials (no password was ever set)" "$(printf '%s' "$r" | jget error_code)" '^invalid_credentials$'
r="$(auth /signup "{\"email\":\"$VICTIM\",\"password\":\"$ATTACKER_PW\"}")"; expect "attacker /signup after confirmation: signup_disabled" "$(printf '%s' "$r" | jget error_code)" '^signup_disabled$'
r="$(auth /recover "{\"email\":\"$VICTIM\"}")"; expect "password recovery returns nothing usable to the caller (the link goes to the mailbox only)" "$r" 'over_email_send_rate_limit\|^[{][}]$'

section "11e the recipient accepts; the only session for the account is the recipient's"
r="$(rest POST "/rpc/accept_invitation" "$(server_jwt "$UID_V")" "{\"p_invite_code\":\"$CODE\"}")"; expect "recipient accepts as company_admin" "$r" '"roles":\["company_admin","member"\]'
r="$(rest GET "/companies?select=slug" "$VICTIM_JWT")"; expect "recipient's link session reads alpha (control)" "$r" 'synthetic-alpha'
expect "exactly one auth session exists for the account (the recipient's); the attacker holds none" "$(sql -c "select count(*) from auth.sessions where user_id='$UID_V'")" '^1$'
r="$(auth /token?grant_type=password "{\"email\":\"$VICTIM\",\"password\":\"$ATTACKER_PW\"}")"; expect "attacker password grant after acceptance: invalid_credentials" "$(printf '%s' "$r" | jget error_code)" '^invalid_credentials$'
sleep 1.1   # [auth.email] max_frequency = 1s between mails to one address
r="$(auth /otp "{\"email\":\"$VICTIM\",\"create_user\":false}")"; expect "returning sign-in: public /otp is accepted for the confirmed account (magic link to the mailbox, nothing returned)" "$r" 'over_email_send_rate_limit\|^[{][}]$'

section "11f observed limits of the hook (recorded, not relied on)"
r="$(auth /admin/users '{"email":"synthetic-hookless@example.invalid"}' service)"
echo "admin POST /admin/users for an uninvited email: $( [ -n "$(printf '%s' "$r" | jget id)" ] && echo 'created (the hook does not run on this admin route; the server must not use it)' || echo "refused: $(printf '%s' "$r" | jget msg)")"
sql -c "delete from auth.users where email='synthetic-hookless@example.invalid'" >/dev/null
[ "$FAILED" = 0 ] && echo "11 PASS" || { echo "11 FAIL"; exit 1; }
