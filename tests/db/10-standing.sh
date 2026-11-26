#!/usr/bin/env bash
# M5 probe: caller standing is checked before company state is read or a foreign lock is
# waited on. With beta closed and its company row locked by another connection for 4 s, an
# alpha admin's calls against a closed foreign company, an unknown company, a foreign
# membership and an unknown membership all return E_NOT_FOUND (SQLSTATE P0002), each
# without waiting on the lock and without an audit row. A standing member of the closed
# company still learns E_COMPANY_INACTIVE (its own company).
# At 6de3c1a: the closed foreign company answers E_COMPANY_INACTIVE and the foreign
# membership call waits about 4 s for beta's lock, so 10a fails.
# Recheck R2 (2026-09-10): the sixth timed case (revoke a foreign invitation) used to run
# only if a beta invitation happened to exist, and in the fresh suite none did. The probe
# now creates its own pending beta invitation before closing beta and fails if the fixture
# is missing, so all six cases run every time.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"
LOG="$ROOT/.scratch/e2"; mkdir -p "$LOG"
SRV_ADMIN="$(server_jwt "$U_alpha_admin1" aal2)"
SRV_BETA="$(server_jwt "$U_beta_member" aal2)"
now_ms() { node -e 'console.log(Date.now())'; }
MB="$(sql -c "select id from app.memberships where user_id='$U_beta_member' and company_id='$BETA'")"
UNKNOWN='00000000-0000-0000-0000-000000000000'
field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"; }

section "10 fixture: a pending beta invitation, created by beta's admin while beta is active"
r="$(rest POST "/rpc/invite_member" "$SRV_BETA" "{\"p_company\":\"$BETA\",\"p_email\":\"standing-foreign@example.invalid\",\"p_roles\":[\"member\"]}")"
INVB="$(field "$r" invitation_id)"
expect "fixture: pending beta invitation exists" "$INVB" '^[0-9a-f-]\{36\}$'
[ -n "$INVB" ] || { echo "10 FAIL: the pending beta invitation fixture is missing; the sixth foreign case cannot run"; exit 1; }
AUDIT_BEFORE="$(sql -c "select count(*) from app.audit_events")"

section "10a beta closed and locked for 4 s: alpha admin gets the same E_NOT_FOUND everywhere, without waiting"
sql -c "update app.companies set status='closed' where id='$BETA'" >/dev/null
sql -c "begin; select id from app.companies where id='$BETA' for no key update; select pg_sleep(4); commit;" > "$LOG/standing-lock.log" 2>&1 &
LP=$!
sleep 0.3
timed() { # label method path body
  local t0 t1 r
  t0="$(now_ms)"; r="$(rest POST "$1" "$SRV_ADMIN" "$2")"; t1="$(now_ms)"
  printf '%s %s ms\n' "$r" "$(( t1 - t0 ))"
}
r="$(timed "/rpc/invite_member" "{\"p_company\":\"$BETA\",\"p_email\":\"leak@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "invite into closed foreign company: E_NOT_FOUND, P0002" "$r" 'P0002.*E_NOT_FOUND'
expect "  ... returned without the lock wait (under 1000 ms)" "$(printf '%s' "$r" | sed -n 's/.* \([0-9]*\) ms$/\1/p')" '^[0-9]\{1,3\}$'
r="$(timed "/rpc/invite_member" "{\"p_company\":\"$UNKNOWN\",\"p_email\":\"leak@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "invite into unknown company: E_NOT_FOUND, P0002" "$r" 'P0002.*E_NOT_FOUND'
expect "  ... under 1000 ms" "$(printf '%s' "$r" | sed -n 's/.* \([0-9]*\) ms$/\1/p')" '^[0-9]\{1,3\}$'
r="$(timed "/rpc/set_roles" "{\"p_membership\":\"$MB\",\"p_roles\":[\"member\"]}")"; expect "set_roles on a foreign membership: E_NOT_FOUND, P0002" "$r" 'P0002.*E_NOT_FOUND'
expect "  ... under 1000 ms (no wait on beta's lock)" "$(printf '%s' "$r" | sed -n 's/.* \([0-9]*\) ms$/\1/p')" '^[0-9]\{1,3\}$'
r="$(timed "/rpc/set_roles" "{\"p_membership\":\"$UNKNOWN\",\"p_roles\":[\"member\"]}")"; expect "set_roles on an unknown membership: E_NOT_FOUND, P0002" "$r" 'P0002.*E_NOT_FOUND'
expect "  ... under 1000 ms" "$(printf '%s' "$r" | sed -n 's/.* \([0-9]*\) ms$/\1/p')" '^[0-9]\{1,3\}$'
r="$(timed "/rpc/remove_member" "{\"p_membership\":\"$MB\"}")"; expect "remove_member on a foreign membership: E_NOT_FOUND, P0002" "$r" 'P0002.*E_NOT_FOUND'
expect "  ... under 1000 ms" "$(printf '%s' "$r" | sed -n 's/.* \([0-9]*\) ms$/\1/p')" '^[0-9]\{1,3\}$'
r="$(timed "/rpc/revoke_invitation" "{\"p_invitation\":\"$INVB\"}")"; expect "revoke a foreign invitation: E_NOT_FOUND, P0002" "$r" 'P0002.*E_NOT_FOUND'
expect "  ... under 1000 ms" "$(printf '%s' "$r" | sed -n 's/.* \([0-9]*\) ms$/\1/p')" '^[0-9]\{1,3\}$'
wait $LP || true
expect "no audit row from any refusal" "$(sql -c "select count(*) from app.audit_events")" "^$AUDIT_BEFORE$"
expect "beta membership unchanged" "$(sql -c "select status, roles from app.memberships where id='$MB'")" '^active|{company_admin,member}$'
expect "beta invitation still pending" "$(sql -c "select revoked_at is null from app.invitations where id='$INVB'")" '^t$'

section "10b a standing member of the closed company learns its own company state"
r="$(rest POST "/rpc/invite_member" "$SRV_BETA" "{\"p_company\":\"$BETA\",\"p_email\":\"leak@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "beta admin inviting into closed beta: E_COMPANY_INACTIVE" "$r" 'E_COMPANY_INACTIVE'
sql -c "begin; set local app.tenant_deletion = 'on'; update app.companies set status='active' where id='$BETA'; commit;" >/dev/null

section "10c the locked decision is still authoritative: standing lost while waiting is refused under the lock"
# Session 1 removes alpha-admin2 and holds the transaction; admin2's invite waits on the
# company lock and must be refused after the wait although the unlocked pre-check passed.
M2="$(sql -c "select id from app.memberships where user_id='$U_alpha_admin2'")"
claims() { printf '{"role":"app_server","sub":"%s","aal":"aal2"}' "$1"; }
sql_try -c "begin; select set_config('request.jwt.claims', '$(claims "$U_alpha_admin1")', true); select * from api.remove_member('$M2'); select pg_sleep(3); commit;" > "$LOG/standing-s1.log" 2>&1 &
P1=$!
sleep 1
r="$(rest POST "/rpc/invite_member" "$(server_jwt "$U_alpha_admin2" aal2)" "{\"p_company\":\"$ALPHA\",\"p_email\":\"late@example.invalid\",\"p_roles\":[\"member\"]}")"
wait $P1 || true
expect "admin2 passed the pre-check, waited, then was refused under the lock: E_NOT_FOUND" "$r" 'E_NOT_FOUND'
expect "no invitation created" "$(sql -c "select count(*) from app.invitations where email_normalized='late@example.invalid'")" '^0$'
sql -c "update app.memberships set status='active', removed_at=null, roles='{company_admin,member}' where id='$M2'" >/dev/null
[ "$FAILED" = 0 ] && echo "10 PASS" || { echo "10 FAIL"; exit 1; }
