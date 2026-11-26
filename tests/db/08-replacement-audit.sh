#!/usr/bin/env bash
# M2 probe: replacing a pending invitation records the implicit revocation as an explicit
# audit event in the same transaction (reason_code replaced, with both ids), distinct from an
# explicit revocation (reason_code revoked), and the revocation rolls back when the
# replacement fails after it. The unique index invitations_one_pending holds the invariant.
# At 6de3c1a: no invitation.revoke row exists for the replaced invitation, so 8a fails.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"
SRV_ADMIN="$(server_jwt "$U_alpha_admin1" aal2)"
field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"; }

section "8a replacement: the older invitation's revocation is an audit event with reason replaced"
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"replace@example.invalid\",\"p_roles\":[\"member\"]}")"; I1="$(field "$r" invitation_id)"
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"replace@example.invalid\",\"p_roles\":[\"company_admin\"]}")"; I2="$(field "$r" invitation_id)"
expect "older invitation revoked" "$(sql -c "select revoked_at is not null from app.invitations where id='$I1'")" '^t$'
row="$(sql -c "select action, actor_kind, details->>'reason_code', details->>'replaced_by_invitation_id' from app.audit_events where action='invitation.revoke' and entity_id='$I1'")"
expect "invitation.revoke event for the replaced id names reason replaced and the replacing id" "$row" "^invitation.revoke|member|replaced|$I2$"
expect "the create event names what it replaced" "$(sql -c "select details->>'replaces_invitation_id' from app.audit_events where action='invitation.create' and entity_id='$I2'")" "^$I1$"
expect "exactly three audit rows for the pair (create, revoke, create)" "$(sql -c "select count(*) from app.audit_events where entity_id in ('$I1','$I2')")" '^3$'
expect "revoke and create committed in one transaction (same xmin)" "$(sql -c "select count(distinct xmin::text) from app.audit_events where (entity_id='$I1' and action='invitation.revoke') or (entity_id='$I2' and action='invitation.create')")" '^1$'

section "8b explicit revocation is distinguishable: reason revoked"
r="$(rest POST "/rpc/revoke_invitation" "$SRV_ADMIN" "{\"p_invitation\":\"$I2\"}")"; expect "admin revokes the replacement" "$r" '"changed":true'
expect "explicit revoke event carries reason revoked" "$(sql -c "select details->>'reason_code' from app.audit_events where action='invitation.revoke' and entity_id='$I2'")" '^revoked$'
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"replace@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "a create for the same email now replaces nothing (no pending sibling)" "$r" 'HTTP 200.*invitation_id'
I3="$(field "$r" invitation_id)"
expect "no replaces_invitation_id on a create without a sibling" "$(sql -c "select details ? 'replaces_invitation_id' from app.audit_events where action='invitation.create' and entity_id='$I3'")" '^f$'

section "8c atomicity: a failure after the sibling revocation rolls the revocation back"
sql <<SQL >/dev/null
create or replace function app.probe_fault() returns trigger language plpgsql set search_path = '' as \$\$
begin
  if new.email_normalized = 'replace@example.invalid' then raise exception 'E_PROBE_FAULT'; end if;
  return new;
end \$\$;
create trigger probe_fault before insert on app.invitations for each row execute function app.probe_fault();
SQL
AUDIT_BEFORE="$(sql -c "select count(*) from app.audit_events")"
r="$(rest POST "/rpc/invite_member" "$SRV_ADMIN" "{\"p_company\":\"$ALPHA\",\"p_email\":\"replace@example.invalid\",\"p_roles\":[\"member\"]}")"; expect "replacement insert fails (injected fault)" "$r" 'E_PROBE_FAULT'
expect "the pending sibling is still pending (revocation rolled back)" "$(sql -c "select revoked_at is null from app.invitations where id='$I3'")" '^t$'
expect "no audit row from the failed replacement" "$(sql -c "select count(*) from app.audit_events")" "^$AUDIT_BEFORE$"
sql -c "drop trigger probe_fault on app.invitations; drop function app.probe_fault();" >/dev/null

section "8d invariant: a second pending invitation for one email and company cannot be inserted directly"
r="$(sql_try -c "insert into app.invitations (company_id, email_normalized, token_hash, roles, expires_at, created_by) select company_id, email_normalized, extensions.gen_random_bytes(32), roles, expires_at, created_by from app.invitations where id='$I3'")"; expect "unique index invitations_one_pending refuses" "$r" 'invitations_one_pending'
[ "$FAILED" = 0 ] && echo "08 PASS" || { echo "08 FAIL"; exit 1; }
