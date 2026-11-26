#!/usr/bin/env bash
# Audit probe: append-only, details allowlist, and same-transaction semantics (a refused
# mutation leaves no audit row; an accepted one leaves exactly one).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"
SRV_ADMIN="$(server_jwt "$U_alpha_admin1" aal2)"
claims() { printf '{"role":"app_server","sub":"%s","aal":"aal2"}' "$1"; }

section "5a append-only even for the migration owner"
r="$(sql_try -c "update app.audit_events set action='x.y' where id=(select min(id) from app.audit_events)")"; expect "owner UPDATE refused by trigger" "$r" 'E_AUDIT_APPEND_ONLY'
r="$(sql_try -c "delete from app.audit_events where id=(select min(id) from app.audit_events)")"; expect "owner DELETE refused by trigger" "$r" 'E_AUDIT_APPEND_ONLY'
r="$(sql_try -c "delete from app.memberships where user_id='$U_alpha_admin2'")"; expect "membership DELETE refused by trigger" "$r" 'E_MEMBERSHIP_DELETE'
r="$(sql_try -c "update app.memberships set company_id='$BETA' where user_id='$U_alpha_admin2'")"; expect "membership company change refused by trigger" "$r" 'E_MEMBERSHIP_IDENTITY'

section "5b details allowlist: content-like keys refused"
r="$(sql_try -c "insert into app.audit_events (company_id, actor_kind, action, entity_type, details) values ('$ALPHA','system','probe.test','probe','{\"content\":\"secret text\"}')")"; expect "key content refused" "$r" 'E_AUDIT_DETAILS_KEY content'
r="$(sql_try -c "insert into app.audit_events (company_id, actor_kind, action, entity_type, details) values ('$ALPHA','system','probe.test','probe','{\"email\":\"a@b.c\"}')")"; expect "key email refused" "$r" 'E_AUDIT_DETAILS_KEY email'
r="$(sql_try -c "insert into app.audit_events (company_id, actor_kind, action, entity_type, details) values ('$ALPHA','system','probe.test','probe', jsonb_build_object('roles', array_fill('member'::text, array[300])))")"; expect "oversized details refused (typed values, 300 roles)" "$r" 'E_AUDIT_DETAILS_SIZE'
r="$(sql_try -c "insert into app.audit_events (company_id, actor_kind, action, entity_type, details) values ('$ALPHA','system','probe.test','probe','{\"roles\":[\"member\"]}') returning id")"; expect "allowed key accepted (control)" "$r" '^[0-9]*$'

section "5e (L1) allowed keys refuse values of the wrong shape: no free text through an allowed key"
ins() { sql_try -c "insert into app.audit_events (company_id, actor_kind, action, entity_type, details) values ('$ALPHA','system','probe.test','probe', '$1'::jsonb)"; }
r="$(ins '{"reason_code":"SYNTHETIC passport prose user@example.invalid"}')"; expect "reason_code with prose refused (the critic's L1 case)" "$r" 'E_AUDIT_DETAILS_VALUE reason_code'
r="$(ins '{"membership_id":"not a uuid but a sentence"}')"; expect "id key with non-uuid refused" "$r" 'E_AUDIT_DETAILS_VALUE membership_id'
r="$(ins '{"roles":["member","owner of the passport"]}')"; expect "roles outside the vocabulary refused" "$r" 'E_AUDIT_DETAILS_VALUE roles'
r="$(ins '{"roles":"member"}')"; expect "roles as a string refused" "$r" 'E_AUDIT_DETAILS_VALUE roles'
r="$(ins '{"status_after":"whatever text"}')"; expect "status outside the vocabulary refused" "$r" 'E_AUDIT_DETAILS_VALUE status_after'
r="$(ins '{"expires_at":"next tuesday, said the user"}')"; expect "expires_at that is not a timestamp refused" "$r" 'E_AUDIT_DETAILS_VALUE expires_at'
r="$(ins '{"changed":"yes"}')"; expect "boolean key with a string refused" "$r" 'E_AUDIT_DETAILS_VALUE changed'
r="$(ins '{"reason_code":"replaced","membership_id":"00000000-0000-0000-0000-000000000000","roles":["member"],"status_before":"active","expires_at":"2026-09-17T11:06:52.289176+00:00","changed":true}')"; expect "well-typed values on every kind of key accepted (control)" "$r" 'INSERT 0 1'
r="$(sql_try -c "begin; truncate app.audit_events; rollback;")"; expect "owner TRUNCATE refused by trigger" "$r" 'E_AUDIT_APPEND_ONLY'

section "5c same transaction: refused mutation writes nothing, accepted one writes one row"
BEFORE="$(sql -c "select count(*) from app.audit_events")"
M2="$(sql -c "select id from app.memberships where user_id='$U_alpha_admin2'")"
sql -c "update app.memberships set roles='{member}' where id='$M2'" >/dev/null   # leave admin1 as sole admin
M1="$(sql -c "select id from app.memberships where user_id='$U_alpha_admin1'")"
r="$(rest POST "/rpc/set_roles" "$SRV_ADMIN" "{\"p_membership\":\"$M1\",\"p_roles\":[\"member\"]}")"; expect "self-demotion of the sole admin refused" "$r" 'E_LAST_ADMIN'
expect "no audit row written by the refused call" "$(sql -c "select count(*) from app.audit_events")" "^$BEFORE$"
r="$(rest POST "/rpc/set_roles" "$SRV_ADMIN" "{\"p_membership\":\"$M2\",\"p_roles\":[\"company_admin\"]}")"; expect "re-promote admin2" "$r" '"changed":true'
expect "exactly one audit row written by the accepted call" "$(sql -c "select count(*) from app.audit_events")" "^$((BEFORE+1))$"
sql -c "select action, actor_kind, details from app.audit_events order by id desc limit 1"

section "5d authenticated may only SELECT audit rows (no INSERT grant)"
ADMIN_JWT="$(user_jwt synthetic-alpha-admin1@example.invalid "$PW")"
r="$(rest POST "/audit_events" "$ADMIN_JWT" "{\"company_id\":\"$ALPHA\",\"actor_kind\":\"member\",\"action\":\"x.y\",\"entity_type\":\"t\"}")"; expect "admin JWT cannot insert audit" "$r" '42501'
r="$(rest PATCH "/audit_events?id=gt.0" "$ADMIN_JWT" '{"action":"x.y"}')"; expect "admin JWT cannot update audit" "$r" '42501'
[ "$FAILED" = 0 ] && echo "05 PASS" || { echo "05 FAIL"; exit 1; }
