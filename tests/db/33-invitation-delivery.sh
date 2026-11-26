#!/usr/bin/env bash
# Probe 33: migration 010's delivery state on the invitation (docs/e6/design.md 1.2.1, lane K4; XR-7 of
# evidence/external-review-2026-09-28.md).
#
#   33a the fixture: two companies, each with an administrator; in the first a second administrator and a plain
#       member; one invitation by each administrator and one succession invitation by the operator
#   33b the default: a new row is not_attempted, from both issuing routines, untouched
#   33c the writer's refusals: a word that is not an outcome, and every caller but the row's own creator, each leaving
#       the row as it was; the bearers that may not call it at all
#   33d the writer: the creator records once, a repeat answers changed false and writes nothing, the operator records
#       its own row, a removed creator is refused, no audit row, no other column moved
#   33e the read, under each caller's own token through RLS: the admin at aal2 reads the word; the same admin at aal1,
#       a plain member at aal2, and the other company's admin at aal2 read no row; nobody writes the column
#   33f the catalog: the column grant, the routine's grant, definer and search_path, the view's option, the check
#   33g the company lock: a held company and an ended access period refuse the creator's record and leave the row as
#       it was, a stranger meets E_NOT_FOUND on a held company's row, and the record lands once the company is active
#
# 33g's fail-before is the first version of the routine, which took the row lock alone: re-created over this one, it
# records onto a held company's row (evidence/invite-delivery-repro/33g-fail-before-first-routine.log), and
# tests/db/32-recovery-hold.sh's E7S-F1 class check names it beside api.departure_preview
# (evidence/invite-delivery-repro/check-db-at-0e276c9.log).
#
# The fail-before is this probe against a database with 001 to 009 applied: 33b's first read fails there, because
# the column does not exist (evidence/invite-delivery-repro/33-fail-before-at-009.log). Rows older than 010 keeping
# null is tests/db/30-deletion.sh's upgrade arm, which applies 010 over seeded rows.
#
# Every identity and company here is this probe's own. Run: bash tests/db/33-invitation-delivery.sh (after
# tests/db/00-seed.sh; scripts/check-db.sh runs every tests/db/[0-9][0-9]-*.sh in order).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
source "$ROOT/tests/db/e6-lib.sh"
RUN="$(run_id)"; E6_RUN="$RUN"; T="$E2_TMP/33"; mkdir -p "$T"

delivery_of() { sql -c "select coalesce(delivery, 'NULL') from app.invitations where id = '$1'"; }
row_but_delivery() { sql -c "select md5((to_jsonb(i) - 'delivery')::text) from app.invitations i where id = '$1'"; }
record_as() { # user invitation word [aal=aal2] [extra-claims-json]
  rest POST /rpc/record_invitation_delivery "$(server_jwt "$1" "${4-aal2}" "${5-}")" "$(jbody p_invitation="$2" p_delivery="$3")"
}
invite_as() { # user company email
  row_field "$(as_call invite_member "$(jbody p_company="$2" p_email="$3" p_roles="#[\"member\"]")" "$1" aal2)" invitation_id
}

# ---------------------------------------------------------------------------
section "33a the fixture"
# ---------------------------------------------------------------------------
e6_person a1; e6_person b1
A="$(company "k4-33a-$RUN" "$U_a1")"; B="$(company "k4-33b-$RUN" "$U_b1")"
future_period "$A"; future_period "$B"
e6_person a2 "$A" '{company_admin,member}'
e6_person am "$A" '{member}'
e6_person a3 "$A" '{company_admin,member}'
I_A="$(invite_as "$U_a1" "$A" "k4-33-$RUN-x@example.invalid")"
I_A3="$(invite_as "$U_a3" "$A" "k4-33-$RUN-y@example.invalid")"
I_B="$(invite_as "$U_b1" "$B" "k4-33-$RUN-z@example.invalid")"
I_OP="$(row_field "$(op_call operator_invite_admin "$(jbody p_company="$A" p_email="k4-33-$RUN-heir@example.invalid")")" invitation_id)"
expect "33a four invitations were made" "$(sql -c "select count(*) from app.invitations where id in ('$I_A', '$I_A3', '$I_B', '$I_OP')")" '^4$'

# ---------------------------------------------------------------------------
section "33b the default: a new row is not_attempted, from both issuing routines"
# ---------------------------------------------------------------------------
expect "33b api.invite_member's row" "$(delivery_of "$I_A")" '^not_attempted$'
expect "33b the other company's row" "$(delivery_of "$I_B")" '^not_attempted$'
expect "33b app.operator_invitation's row (api.operator_invite_admin)" "$(delivery_of "$I_OP")" '^not_attempted$'

# ---------------------------------------------------------------------------
section "33c the writer's refusals, each leaving the row as it was"
# ---------------------------------------------------------------------------
BEFORE="$(row_but_delivery "$I_A")"
for word in not_attempted sent Mail '' 'mail ' 'https://enterprise.example.invalid/accept#token_hash=x'; do
  expect "33c the word '$word' is refused 22023" "$(record_as "$U_a1" "$I_A" "$word")" 'E_BODY_INVALID'
done
expect "33c a null word is refused 22023" "$(rest POST /rpc/record_invitation_delivery "$(server_jwt "$U_a1" aal2)" "$(jbody p_invitation="$I_A" p_delivery=null)")" 'E_BODY_INVALID'
expect "33c the row is still not_attempted after the refused words" "$(delivery_of "$I_A")" '^not_attempted$'
expect "33c the co-administrator of the same company: E_NOT_FOUND" "$(record_as "$U_a2" "$I_A" mail)" 'E_NOT_FOUND'
expect "33c a plain member of the same company: E_NOT_FOUND" "$(record_as "$U_am" "$I_A" mail)" 'E_NOT_FOUND'
expect "33c the other company's administrator: E_NOT_FOUND" "$(record_as "$U_b1" "$I_A" mail)" 'E_NOT_FOUND'
expect "33c an outsider: E_NOT_FOUND" "$(record_as "$U_outsider" "$I_A" mail)" 'E_NOT_FOUND'
expect "33c the operator on an administrator's row: E_NOT_FOUND" "$(record_as "$U_op" "$I_A" mail)" 'E_NOT_FOUND'
expect "33c the administrator on the operator's row: E_NOT_FOUND" "$(record_as "$U_a1" "$I_OP" mail)" 'E_NOT_FOUND'
expect "33c an unknown id: E_NOT_FOUND" "$(record_as "$U_a1" "$(uuid)" mail)" 'E_NOT_FOUND'
expect "33c a bound bearer (an fn claim) reaches nothing: E_NOT_SERVER" \
  "$(record_as "$U_a1" "$I_A" mail aal2 '{"fn":"record_invitation_delivery","args_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","jti":"7d0c6b2e-4f1a-4c3b-9e8d-2a1b0c9d8e7f"}')" 'E_NOT_SERVER'
expect "33c the creator's own authenticated token: no execute" "$(rest POST /rpc/record_invitation_delivery "$(user_token "$U_a1" aal2)" "$(jbody p_invitation="$I_A" p_delivery=mail)")" 'permission denied for function record_invitation_delivery'
expect "33c anon: no execute" "$(rest POST /rpc/record_invitation_delivery "$ANON_KEY" "$(jbody p_invitation="$I_A" p_delivery=mail)")" '42501'
expect "33c service_role: no execute" "$(rest POST /rpc/record_invitation_delivery "$SERVICE_ROLE_KEY" "$(jbody p_invitation="$I_A" p_delivery=mail)")" '42501'
expect "33c after every refusal the row is still not_attempted" "$(delivery_of "$I_A")" '^not_attempted$'
expect "33c and no other column moved" "$(row_but_delivery "$I_A")" "^$BEFORE$"

# ---------------------------------------------------------------------------
section "33d the writer: once, by the creator, and nothing else"
# ---------------------------------------------------------------------------
AUDIT_A="$(audit_count "$A")"
r="$(record_as "$U_a1" "$I_A" mail)"
expect "33d the creator records mail: changed true" "$r" '"changed":true'
expect "33d the answer names the row and the word" "$r" "\"invitation_id\":\"$I_A\",\"delivery\":\"mail\""
expect "33d the row holds mail" "$(delivery_of "$I_A")" '^mail$'
expect "33d a repeat with another word answers the stored one, changed false" "$(record_as "$U_a1" "$I_A" failed)" '"delivery":"mail","changed":false'
expect "33d and writes nothing" "$(delivery_of "$I_A")" '^mail$'
expect "33d no other column moved" "$(row_but_delivery "$I_A")" "^$BEFORE$"
expect "33d the creator at aal1 records its own row too (no aal test: the request that made it held aal2)" "$(record_as "$U_b1" "$I_B" unconfirmed aal1)" '"changed":true'
expect "33d the operator records its own succession row" "$(record_as "$U_op" "$I_OP" handover)" '"changed":true'
expect "33d the operator's row holds handover" "$(delivery_of "$I_OP")" '^handover$'
sql -c "update app.memberships set status = 'removed', removed_at = now() where id = '$MS_a3'" >/dev/null
expect "33d a creator removed since: E_NOT_FOUND" "$(record_as "$U_a3" "$I_A3" mail)" 'E_NOT_FOUND'
expect "33d and that row keeps not_attempted" "$(delivery_of "$I_A3")" '^not_attempted$'
expect "33d no audit row was written by any record" "$(audit_count "$A")" "^$AUDIT_A$"
sql -c "update app.invitations set delivery = null where id = '$I_A3'" >/dev/null
sql -c "update app.memberships set status = 'active', removed_at = null where id = '$MS_a3'" >/dev/null
expect "33d a null row (older than 010) is never written: changed false" "$(record_as "$U_a3" "$I_A3" mail)" '"changed":false'
expect "33d and stays null" "$(delivery_of "$I_A3")" '^NULL$'

# ---------------------------------------------------------------------------
section "33e the read, under each caller's own token through RLS"
# ---------------------------------------------------------------------------
expect "33e the administrator at aal2 reads the word" "$(rest GET "/invitations?select=id,delivery&id=eq.$I_A" "$(user_token "$U_a1" aal2)")" "\"delivery\":\"mail\""
expect "33e and the operator's row in the same company" "$(rest GET "/invitations?select=delivery&id=eq.$I_OP" "$(user_token "$U_a1" aal2)")" '"delivery":"handover"'
expect "33e the co-administrator at aal2 reads it too (the policy is the company's admins)" "$(view_rows "/invitations?select=delivery&id=eq.$I_A" "$(user_token "$U_a2" aal2)")" '^1$'
expect "33e the same administrator at aal1: no row" "$(view_rows "/invitations?select=delivery&id=eq.$I_A" "$(user_token "$U_a1" aal1)")" '^0$'
expect "33e a plain member at aal2: no row" "$(view_rows "/invitations?select=delivery&company_id=eq.$A" "$(user_token "$U_am" aal2)")" '^0$'
expect "33e the other company's administrator at aal2, by id: no row" "$(view_rows "/invitations?select=delivery&id=eq.$I_A" "$(user_token "$U_b1" aal2)")" '^0$'
expect "33e the other company's administrator at aal2, by company: no row" "$(view_rows "/invitations?select=delivery&company_id=eq.$A" "$(user_token "$U_b1" aal2)")" '^0$'
expect "33e control: that administrator reads its own company's row" "$(rest GET "/invitations?select=delivery&id=eq.$I_B" "$(user_token "$U_b1" aal2)")" '"delivery":"unconfirmed"'
expect "33e an outsider at aal2: no row" "$(view_rows "/invitations?select=delivery" "$(user_token "$U_outsider" aal2)")" '^0$'
expect "33e the administrator cannot write the column through the view" "$(rest PATCH "/invitations?id=eq.$I_A" "$(user_token "$U_a1" aal2)" '{"delivery":"failed"}')" 'permission denied for view invitations'
expect "33e the server bearer reads no table" "$(rest GET "/invitations?select=delivery" "$(server_jwt "$U_a1" aal2)")" '42501'
expect "33e after both attempts the row still holds mail" "$(delivery_of "$I_A")" '^mail$'

# ---------------------------------------------------------------------------
section "33f the catalog"
# ---------------------------------------------------------------------------
expect "33f authenticated's column grant on app.invitations: the ten of 001 plus delivery, token_hash still out" \
  "$(sql -c "select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges where table_schema = 'app' and table_name = 'invitations' and grantee = 'authenticated' and privilege_type = 'SELECT'")" \
  '^accepted_at,accepted_membership_id,company_id,created_at,created_by,delivery,email_normalized,expires_at,id,revoked_at,roles$'
expect "33f nobody but the owner may update, insert or delete the column" \
  "$(sql -c "select coalesce(string_agg(grantee || ':' || privilege_type, ','), 'NONE') from information_schema.column_privileges where table_schema = 'app' and table_name = 'invitations' and column_name = 'delivery' and privilege_type <> 'SELECT' and grantee <> 'postgres'")" '^NONE$'
expect "33f app_maintenance holds no grant on the column" \
  "$(sql -c "select count(*) from information_schema.column_privileges where table_schema = 'app' and table_name = 'invitations' and column_name = 'delivery' and grantee = 'app_maintenance'")" '^0$'
expect "33f the routine is executable by app_server alone" \
  "$(sql -c "select string_agg(grantee, ',' order by grantee) from information_schema.routine_privileges where specific_schema = 'api' and routine_name = 'record_invitation_delivery' and grantee <> 'postgres'")" '^app_server$'
expect "33f the routine is SECURITY DEFINER with an empty search_path" \
  "$(sql -c "select p.prosecdef || '|' || array_to_string(p.proconfig, ',') from pg_proc p where p.oid = 'api.record_invitation_delivery(uuid, text)'::regprocedure")" '^true|search_path=""$'
expect "33f api.invitations keeps security_invoker and ends with delivery" \
  "$(sql -c "select array_to_string(c.reloptions, ',') || '|' || (select attname from pg_attribute where attrelid = c.oid and attnum > 0 and not attisdropped order by attnum desc limit 1) from pg_class c where c.oid = 'api.invitations'::regclass")" '^security_invoker=true|delivery$'
expect "33f the check admits the five words and null, nothing else" \
  "$(sql_try -c "update app.invitations set delivery = 'sent' where id = '$I_A'")" 'invitations_delivery_word'
expect "33f the default is not_attempted" \
  "$(sql -c "select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = 'app.invitations'::regclass and a.attname = 'delivery'")" "^'not_attempted'::text$"

# ---------------------------------------------------------------------------
section "33g the company lock: the record is a company-scoped write, refused where every other one is"
# ---------------------------------------------------------------------------
# The other company's administrator makes a second row, and the company is then held as the reconciler holds one
# (tests/db/32-recovery-hold.sh 32a), between the row's commit and its record.
I_B2="$(invite_as "$U_b1" "$B" "k4-33-$RUN-w@example.invalid")"
expect "33g the new row is not_attempted" "$(delivery_of "$I_B2")" '^not_attempted$'
sql -c "begin; set local app.recovery_reconcile = 'on'; update app.companies set status = 'held' where id = '$B'; commit;" >/dev/null
expect "33g the company is held" "$(sql -c "select status from app.companies where id = '$B'")" '^held$'
expect "33g the creator's record on a held company: E_COMPANY_INACTIVE" "$(record_as "$U_b1" "$I_B2" mail)" 'E_COMPANY_INACTIVE'
expect "33g a stranger on the held company's row still meets E_NOT_FOUND, so no status is disclosed" "$(record_as "$U_a1" "$I_B2" mail)" 'E_NOT_FOUND'
expect "33g and the row keeps not_attempted" "$(delivery_of "$I_B2")" '^not_attempted$'
sql -c "begin; set local app.recovery_reconcile = 'on'; update app.companies set status = 'active' where id = '$B'; commit;" >/dev/null
sql -c "update app.access_periods set starts_at = clock_timestamp() - interval '1 day', ends_at = clock_timestamp() - interval '1 minute' where company_id = '$B'" >/dev/null
expect "33g the creator's record past the company's ends_at: E_ACCESS_PERIOD_ENDED" "$(record_as "$U_b1" "$I_B2" mail)" 'E_ACCESS_PERIOD_ENDED'
expect "33g and the row keeps not_attempted" "$(delivery_of "$I_B2")" '^not_attempted$'
future_period "$B"
expect "33g control: the company active and inside its period, the same record lands" "$(record_as "$U_b1" "$I_B2" mail)" '"changed":true'
expect "33g the routine's text takes app.lock_company (the E7S-F1 class check of tests/db/32)" "$(sql -c "select pg_get_functiondef('api.record_invitation_delivery(uuid, text)'::regprocedure) like '%app.lock_company(inv.company_id)%'")" '^t$'

printf '\n== 33 done: %s ==\n' "$([ "$FAILED" = 0 ] && echo PASS || echo FAIL)"
exit "$FAILED"
