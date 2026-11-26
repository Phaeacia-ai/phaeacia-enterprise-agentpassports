#!/usr/bin/env bash
# M1 probe: invitation validity is decided at the locked point with a fresh clock. The
# critic's barrier case: a 2 s invitation, the company lock held 4 s by another connection,
# acceptance requested at 0.3 s. The request starts before expiry, waits, and must be refused
# after expiry with membership, invitation and audit unchanged. Then the equality boundary
# and a near-boundary positive control, and the contract that accepted_at is the decision
# instant (equal to the audit row's timestamp).
# At 6de3c1a: the waiting acceptance succeeds (now() is the transaction start), so 7a fails.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"
LOG="$ROOT/.scratch/e2"; mkdir -p "$LOG"
SRV_ADMIN="$(server_jwt "$U_alpha_admin1" aal2)"
SRV_REMOVED="$(server_jwt "$U_alpha_removed")"
claims() { printf '{"role":"app_server","sub":"%s"}' "$1"; }
field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"; }
now_ms() { node -e 'console.log(Date.now())'; }

section "7a barrier: 2 s invitation, company lock held 4 s, acceptance requested at 0.3 s"
sql -c "update app.memberships set status='removed', removed_at=now() where user_id='$U_alpha_removed' and status='active'" >/dev/null
MID="$(sql -c "select id from app.memberships where user_id='$U_alpha_removed'")"
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"synthetic-alpha-removed@example.invalid\",\"p_roles\":[\"member\"],\"p_expires_in\":\"2 seconds\"}")"
TOK="$(field "$r" invite_code)"; INV="$(field "$r" invitation_id)"; expect "2 s invitation created" "$r" 'HTTP 200'
AUDIT_BEFORE="$(sql -c "select count(*) from app.audit_events")"
sql -c "begin; select id from app.companies where id='$ALPHA' for no key update; select pg_sleep(4); commit;" > "$LOG/expiry-lock.log" 2>&1 &
LP=$!
sleep 0.3
T0="$(now_ms)"
r="$(rest POST "/rpc/accept_invitation" "$SRV_REMOVED" "{\"p_invite_code\":\"$TOK\"}")"
T1="$(now_ms)"
wait $LP || true
echo "acceptance request started at +0.3 s, returned after $(( (T1 - T0) )) ms (lock was held 4 s, expiry at 2 s)"
expect "acceptance that waited past expiry is refused: E_INVITATION_INVALID" "$r" 'E_INVITATION_INVALID'
expect "the request did wait on the lock (returned after more than 3 s)" "$(( T1 - T0 > 3000 ))" '^1$'
expect "membership still removed" "$(sql -c "select status from app.memberships where id='$MID'")" '^removed$'
expect "invitation not accepted" "$(sql -c "select accepted_at is null and accepted_membership_id is null from app.invitations where id='$INV'")" '^t$'
expect "no audit row written" "$(sql -c "select count(*) from app.audit_events")" "^$AUDIT_BEFORE$"
sql -c "select 'expires_at ' || expires_at || ' observed_after ' || clock_timestamp() from app.invitations where id='$INV'"

section "7b equality boundary and near-boundary control (single transaction, rolled back)"
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"synthetic-alpha-removed@example.invalid\",\"p_roles\":[\"member\"]}")"
TOK2="$(field "$r" invite_code)"; INV2="$(field "$r" invitation_id)"
r="$(sql_try -c "begin; update app.invitations set expires_at = clock_timestamp() where id='$INV2'; select set_config('request.jwt.claims', '$(claims "$U_alpha_removed")', true); select * from api.accept_invitation('$TOK2'); rollback;")"; expect "expires_at equal to the clock at the update: refused" "$r" 'E_INVITATION_INVALID'
r="$(sql_try -c "begin; update app.invitations set expires_at = clock_timestamp() + interval '2 seconds' where id='$INV2'; select set_config('request.jwt.claims', '$(claims "$U_alpha_removed")', true); select * from api.accept_invitation('$TOK2'); rollback;")"; expect "expires_at two seconds ahead: accepted (control, rolled back)" "$r" "$MID|.*|t"

section "7c accepted_at is the decision instant and equals the audit timestamp"
r="$(rest POST "/rpc/accept_invitation" "$SRV_REMOVED" "{\"p_invite_code\":\"$TOK2\"}")"; expect "normal acceptance succeeds" "$r" '"reactivated":true'
expect "accepted_at equals the invitation.accept audit row's at" "$(sql -c "select i.accepted_at = a.at from app.invitations i join app.audit_events a on a.action='invitation.accept' and a.details->>'invitation_id' = i.id::text where i.id='$INV2'")" '^t$'
expect "accepted_at is not earlier than created_at" "$(sql -c "select accepted_at >= created_at from app.invitations where id='$INV2'")" '^t$'
[ "$FAILED" = 0 ] && echo "07 PASS" || { echo "07 FAIL"; exit 1; }
