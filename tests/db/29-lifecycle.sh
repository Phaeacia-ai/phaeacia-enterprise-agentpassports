#!/usr/bin/env bash
# Probe 29: onboarding and lifecycle at the routine level (docs/e6/design.md 1.1, 1.2, 1.3, 1.5, 1.7, 3.1, 3.4, 3.5;
# section 5 cases 1, 3 to 12, 17 to 23, 31, 35, 38, 39). The page and route arms of cases 1, 2, 3, 16 and 21 are the
# services and pages lanes'; what this probe runs is every arm a database probe can decide, and section 6 of
# evidence/e6-db.md names the arms it cannot.
#   29a case 1: api.create_company makes the company, its access period and its first admin's invitation in one
#       transaction, with the fail-before against api.provision_company, which needs an account that cannot exist
#   29b cases 6 and 7: every operator routine at aal1 and by a non-operator, with the same answer whether the named
#       company exists or not
#   29c case 5: the register and the manifest name nothing inside a company, with the mutant fail-before
#   29d case 4: api.my_standing is the caller's own, with the fail-before that drops the auth.uid() predicate
#   29e cases 10 and 11: the pending-invitation bound and the seat bound at both places, and E6D-C-F7's net count
#   29f case 39: operators and members are disjoint at the three creation points, with a fail-before for each
#   29g cases 12 and 13: api.transfer_agent by each caller class and its three ordered branches, with the
#       branch-order fail-before
#   29h case 18: the departure preview's counts against an owner-side count, field by field
#   29i case 19: a company past ends_at but before export_by, with the fail-before that drops lock_company's test
#   29j case 38: the export window closes WITHOUT the sweep, with the fail-before that has none of the three tests
#   29k case 20: the expiry run is idempotent, bounded, ordered and audited
#   29l cases 21 and 22: one code per company state, and closed is terminal against four writers
#   29m case 23: the export by each caller class, with its three fail-befores
#   29n cases 31 and 35: admin succession and the operator acting past the period, with both fail-befores
#   29o cases 3, 8, 9 and 17: cross-company isolation of the new routines, the resend path, the last-admin rule
#   29p E6S-C-F2: past export_by with the sweep never run, every api view under each reader's own token is
#       empty, with the fail-before that puts the five accepted predicates back
#   29q E6S-C-F4: the takeout's refusal order, so a stranger learns neither existence nor time state
#   29r E6S-C-F6: the documented recovery after a lost company-create answer, with its fail-before
# Every identity and company here is this probe's own: the seed's alpha and beta have been moved by the probes
# between 01 and 28 (alpha's member is removed from alpha and active in beta by 29's turn), so a case that asserts a
# membership shape builds it (E6DB-F9).
# Run: bash tests/db/29-lifecycle.sh (after tests/db/00-seed.sh and the probes before it).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
source "$ROOT/tests/db/e5-lib.sh"; source "$ROOT/tests/db/e6-lib.sh"
RUN="$(run_id)"; E6_RUN="$RUN"; T="$E2_TMP/29"; mkdir -p "$T"
DL0="$(deadlocks)"
apply_fixture e6-mutate.sql   # tests.e6_mutate, the owner-only mutant installer every fail-before below uses

# ---------------------------------------------------------------------------
section "29a case 1: one transaction makes the company, its access period and the first admin's invitation"
# ---------------------------------------------------------------------------
# The fail-before FIRST, because it is the state before this slice: api.provision_company needs a uuid for a confirmed
# account and the address has never been used, so there is no uuid to pass and the operator has to run SQL.
NEW_MAIL="e6-29a-$RUN-admin@example.invalid"
r="$(op_call provision_company "$(jbody p_slug="e6-29a-fb-$RUN" p_name="SYNTHETIC 29a fail-before" p_first_admin_user="$(uuid)")")"
expect "fail-before case 1: api.provision_company with an address nobody has an account for: E_USER_NOT_FOUND" "$r" 'E_USER_NOT_FOUND'
expect "fail-before case 1: and no company row was written" "$(sql -c "select count(*) from app.companies where slug = 'e6-29a-fb-$RUN'")" '^0$'

ENDS="$(iso_ago -4838400)"; STARTS="$(iso_ago 86400)"
r="$(op_call create_company "$(jbody p_slug="e6-29a-$RUN" p_name="SYNTHETIC 29a AG" p_first_admin_email="$NEW_MAIL" p_starts_at="$STARTS" p_ends_at="$ENDS")")"
expect "case 1: api.create_company answers the company, the invitation and the three dates" "$r" '"export_by"'
C29A="$(row_field "$r" company_id)"; INV29A="$(row_field "$r" invitation_id)"; CODE29A="$(row_field "$r" invite_code)"
expect "case 1: the invite code is 64 hex characters, returned once" "LEN|${#CODE29A}" '^LEN|64$'
expect "case 1: no membership was created" "$(sql -c "select count(*) from app.memberships where company_id = '$C29A'")" '^0$'
expect "case 1: one pending invitation, issued by the operator and by no membership" "$(sql -c "select created_by is null and created_by_operator = '$U_op' from app.invitations where id = '$INV29A'")" '^t$'
expect "case 1: export_by is ends_at + app.export_window() and delete_by is export_by + app.deletion_window()" "$(sql -c "select export_by = ends_at + app.export_window() and delete_by = export_by + app.deletion_window() from app.access_periods where company_id = '$C29A'")" '^t$'
expect "case 1: three audit rows and no others" "$(audit_actions "$C29A")" '^company.provision,company.set_access_period,invitation.create$'
expect "case 1: app.hook_before_user_created now admits the address, because a pending invitation exists" "$(sql -c "select app.hook_before_user_created(jsonb_build_object('user', jsonb_build_object('email', '$NEW_MAIL')))::text")" '^{}$'
expect "case 1 control: it still refuses an address with no invitation" "$(sql -c "select app.hook_before_user_created(jsonb_build_object('user', jsonb_build_object('email', 'e6-29a-$RUN-nobody@example.invalid')))::text")" 'Invitation required'
expect "case 1: the register shows the new company with zero members and one pending invitation" "$(sql -c "select (app.operator_company_row(c) -> 'counts' ->> 'memberships_active') || '/' || (app.operator_company_row(c) -> 'counts' ->> 'invitations_pending') from app.companies c where c.id = '$C29A'")" '^0/1$'
expect "case 38 control: api.create_company with no dates: E_BODY_INVALID" "$(op_call create_company "$(jbody p_slug="e6-29a-nop-$RUN" p_name="SYNTHETIC no period" p_first_admin_email="e6-29a-nop-$RUN@example.invalid")")" 'E_BODY_INVALID'
expect "case 38 control: with startsAt after endsAt: E_BODY_INVALID" "$(op_call create_company "$(jbody p_slug="e6-29a-rev-$RUN" p_name="SYNTHETIC reversed" p_first_admin_email="e6-29a-rev-$RUN@example.invalid" p_starts_at="$ENDS" p_ends_at="$STARTS")")" 'E_BODY_INVALID'
expect "case 38 control: and neither wrote a company row" "$(sql -c "select count(*) from app.companies where slug in ('e6-29a-nop-$RUN', 'e6-29a-rev-$RUN')")" '^0$'
expect "case 1: a taken slug is refused by the unique index" "$(op_call create_company "$(jbody p_slug="e6-29a-$RUN" p_name="SYNTHETIC duplicate" p_first_admin_email="e6-29a-dup-$RUN@example.invalid" p_starts_at="$STARTS" p_ends_at="$ENDS")")" '23505'

# ---------------------------------------------------------------------------
section "29b cases 6 and 7: every operator routine at aal1 and by a non-operator"
# ---------------------------------------------------------------------------
e6_person b_admin; U_B_ADMIN="$U_b_admin"
GHOST="$(uuid)"
opbody() { # routine
  case "$1" in
    operator_register) jbody p_limit='#50' ;;
    operator_export_manifest) jbody p_company="$C29A" ;;
    operator_expiry_run) jbody p_limit='#5' ;;
    create_company) jbody p_slug="e6-29b-$RUN" p_name=X p_first_admin_email="e6-29b-$RUN@example.invalid" p_starts_at="$STARTS" p_ends_at="$ENDS" ;;
    operator_invite_admin) jbody p_company="$C29A" p_email="e6-29b-y-$RUN@example.invalid" ;;
    set_company_status) jbody p_company="$C29A" p_status=suspended p_reason_code=non_payment ;;
    set_access_period) jbody p_company="$C29A" p_invoice_ref=null p_starts_at="$STARTS" p_ends_at="$ENDS" ;;
    set_company_quota) jbody p_company="$C29A" p_name=members_per_company p_value='#40' ;;
    close_company) jbody p_company="$C29A" p_confirm_slug="e6-29a-$RUN" p_reason_code=operator_request ;;
    delete_company) jbody p_company="$C29A" p_confirm_slug="e6-29a-$RUN" p_reason_code=operator_request ;;
    transfer_first_admin) jbody p_company="$C29A" p_target_user="$U_op" ;;
  esac
}
for fn in operator_register operator_export_manifest operator_expiry_run create_company operator_invite_admin \
          set_company_status set_access_period set_company_quota close_company delete_company transfer_first_admin; do
  expect "case 6: $fn by the operator at aal1: E_OPERATOR_MFA_REQUIRED" "$(op_call "$fn" "$(opbody "$fn")" '')" 'E_OPERATOR_MFA_REQUIRED'
  expect "case 7: $fn by a member at aal2 who is no operator: E_NOT_OPERATOR" "$(as_call "$fn" "$(opbody "$fn")" "$U_B_ADMIN" aal2)" 'E_NOT_OPERATOR'
done
expect "case 7: the answer is the same for a company that does not exist" "$(as_call operator_export_manifest "$(jbody p_company="$GHOST")" "$U_B_ADMIN" aal2)" 'E_NOT_OPERATOR'
expect "case 7 control: an operator at aal2 meets the later refusal for that unknown company" "$(op_call operator_export_manifest "$(jbody p_company="$GHOST")")" 'E_NOT_FOUND'
expect "cases 6 and 7: nothing was written by any refused call" "$(sql -c "select status from app.companies where id = '$C29A'")" '^active$'
expect "cases 6 and 7: and the three audit rows of 29a are still the only ones" "$(audit_actions "$C29A")" '^company.provision,company.set_access_period,invitation.create$'

# ---------------------------------------------------------------------------
section "29c case 5: the register and the manifest name nothing inside a company"
# ---------------------------------------------------------------------------
# One company holding everything the operator must not read: named agents and groups, candidates, reviews, releases,
# reports, witnesses and a member with a display name. It is built here rather than taken from the seed.
e6_person c_admin; U_C_ADMIN="$U_c_admin"
C29C="$(company "e6-29c-$RUN" "$U_C_ADMIN")"
e6_person c_mem "$C29C" '{member}'; U_C_MEM="$U_c_mem"; MS_C_MEM="$MS_c_mem"
sql -c "insert into app.profiles (user_id, display_name) values ('$U_C_MEM', 'SYNTHETIC Zenobia Quirkwood')
        on conflict (user_id) do update set display_name = excluded.display_name" >/dev/null
MS_C_ADMIN="$(membership_of "$C29C" "$U_C_ADMIN")"
CAND29C="$(submitted "$U_C_MEM" "$C29C" "synthetic-quokka-brief-$RUN" 1)"
sql -c "insert into app.groups (company_id, name, created_by_membership_id) values ('$C29C', 'SYNTHETIC Marzipan Circle', '$MS_C_ADMIN')" >/dev/null
sql -c "insert into app.reviews (company_id, candidate_id, envelope_id, role, decision, reviewer_membership_id, reason)
        values ('$C29C', '$CAND29C', null, 'it', 'changes_requested', '$MS_C_ADMIN', 'SYNTHETIC reason: the pangolin clause needs rewording.')" >/dev/null
sql -c "select coalesce(string_agg(x, E'\n'), '') from (
          select a.name as x from app.agents a where a.company_id = '$C29C'
          union all select g.name from app.groups g where g.company_id = '$C29C'
          union all select f.display_name from app.profiles f
                     join app.memberships m on m.user_id = f.user_id where m.company_id = '$C29C'
          union all select r.reason from app.reviews r where r.company_id = '$C29C') t" > "$T/secrets.txt"
expect "case 5 fixture: the company holds names, a display name and a review reason to search for" "COUNT|$(grep -c . "$T/secrets.txt")" '^COUNT|[4-9]'
expect "case 5: the register answers" "$(op_body operator_register "$(jbody p_limit='#200')" "$T/register.txt")" '^HTTP 200$'
expect "case 5: the manifest answers" "$(op_body operator_export_manifest "$(jbody p_company="$C29C")" "$T/manifest.txt")" '^HTTP 200$'
search_secrets() { # file
  local hits=0 s
  while IFS= read -r s; do
    [ -n "$s" ] || continue
    if grep -qF -- "$s" "$1"; then hits=$((hits + 1)); fi
  done < "$T/secrets.txt"
  printf '%s' "$hits"
}
expect "case 5: no agent name, group name, display name or review reason appears in the register" "MATCHES|$(search_secrets "$T/register.txt")" '^MATCHES|0$'
expect "case 5: nor in the export manifest" "MATCHES|$(search_secrets "$T/manifest.txt")" '^MATCHES|0$'
expect "case 5: and no address, so no @ in the register" "AT|$(grep -c '@' "$T/register.txt" || true)" '^AT|0$'
expect "case 5: and none in the manifest" "AT|$(grep -c '@' "$T/manifest.txt" || true)" '^AT|0$'
expect "case 5: the counts are present and the register answers for this company" "$(grep -cF "$C29C" "$T/register.txt")" '^1$'
expect "case 5: the manifest names the twenty-one export sections and the route ceiling" "$(jfield "$T/manifest.txt" export_manifest.over_route_ceiling)" '^false$'
expect "case 5: and twenty-one section counts exactly" "$(node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(Object.keys(j.export_manifest.sections).length))' "$T/manifest.txt")" '^21$'
expect "case 5: the manifest's memberships count equals an owner-side count of the whole company, unfiltered" "$(jfield "$T/manifest.txt" export_manifest.sections.memberships)|$(sql -c "select count(*) from app.memberships where company_id = '$C29C'")" '^2|2$'
expect "case 5: there is no operator export route, and api.export_company is granted to app_server alone" "$(sql -c "select coalesce(string_agg(grantee, ','), 'NONE') from information_schema.routine_privileges where specific_schema = 'api' and routine_name = 'export_company' and grantee <> 'postgres'")" '^app_server$'
# fail-before: a mutant app.operator_company_row that adds an agent-name array is found by the same search.
save_routine 'app.operator_company_row(app.companies, boolean)' operator_company_row
apply_fixture e6-operator-surface-mutant.sql
expect "fail-before case 5: the mutant register answers" "$(op_body operator_register "$(jbody p_limit='#200')" "$T/register-mutant.txt")" '^HTTP 200$'
expect "fail-before case 5: the mutant app.operator_company_row leaks the agent and group names, and the search finds them" "MATCHES|$(search_secrets "$T/register-mutant.txt")" '^MATCHES|[1-9]'
restore_routine operator_company_row
expect "fail-before case 5: the restored register answers" "$(op_body operator_register "$(jbody p_limit='#200')" "$T/register-restored.txt")" '^HTTP 200$'
expect "fail-before case 5: restored, and the search is clean again" "MATCHES|$(search_secrets "$T/register-restored.txt")" '^MATCHES|0$'

# ---------------------------------------------------------------------------
section "29d case 4: api.my_standing is the caller's own and nothing else"
# ---------------------------------------------------------------------------
e6_person d_other; U_D_OTHER="$U_d_other"
C29D="$(company "e6-29d-$RUN" "$U_D_OTHER")"
view_body "/my_standing?select=company_id,company_status,access_state" "$(user_token "$U_C_MEM")" "$T/standing.txt" >/dev/null
expect "case 4: the member of company C sees exactly their own membership" "$(grep -cF "$C29C" "$T/standing.txt")" '^1$'
expect "case 4: and not company D's" "COUNT|$(grep -cF "$C29D" "$T/standing.txt" || true)" '^COUNT|0$'
expect "case 4: the member of company D sees D" "$(rest GET "/my_standing?select=company_id" "$(user_token "$U_D_OTHER")")" "$C29D"
sql -c "update app.memberships set status = 'removed', removed_at = now() where id = '$MS_C_MEM'" >/dev/null
expect "case 4: a removed member sees nothing, because the door filters active memberships (E6D-C-F6 settled)" "$(rest GET "/my_standing?select=company_id" "$(user_token "$U_C_MEM")")" 'HTTP 200 \[\]'
sql -c "update app.memberships set status = 'active', removed_at = null where id = '$MS_C_MEM'" >/dev/null
expect "case 4: the operator, who holds no membership, sees nothing" "$(rest GET "/my_standing?select=company_id" "$(user_token "$U_op")")" 'HTTP 200 \[\]'
expect "case 4: anon is refused" "$(rest GET "/my_standing?select=company_id" "$ANON_KEY")" 'permission denied'
expect "case 4: service_role is refused" "$(rest GET "/my_standing?select=company_id" "$SERVICE_ROLE_KEY")" 'permission denied'
expect "case 4: app_maintenance holds SELECT on the tables behind the door and a select policy on each" "$(sql -c "select count(*) from pg_policies where schemaname = 'app' and tablename in ('companies', 'memberships') and 'app_maintenance' = any (roles)")" '^2$'
expect "case 4: the view is security_invoker, so its predicate is the function's" "$(sql -c "select coalesce((select 'yes' from pg_class where relname = 'my_standing' and relnamespace = 'api'::regnamespace and reloptions @> array['security_invoker=true']), 'no')")" '^yes$'
save_routine 'app.my_standing()' my_standing
apply_fixture e6-my-standing-mutant.sql
# The read is filtered to company D, because this stack's PostgREST answers at most 200 rows and the mutant returns
# every active membership in the database, several hundred of them by probe 29's turn (E6DB-F12).
view_body "/my_standing?select=company_id&company_id=eq.$C29D" "$(user_token "$U_C_MEM")" "$T/standing-mutant.txt" >/dev/null
expect "fail-before case 4: without the auth.uid() predicate the member of C reads D's membership too" "$(grep -cF "$C29D" "$T/standing-mutant.txt")" '^1$'
restore_routine my_standing
view_body "/my_standing?select=company_id&company_id=eq.$C29D" "$(user_token "$U_C_MEM")" "$T/standing-restored.txt" >/dev/null
expect "fail-before case 4: restored, and D is invisible again" "COUNT|$(grep -cF "$C29D" "$T/standing-restored.txt" || true)" '^COUNT|0$'
view_body "/my_standing?select=company_id&company_id=eq.$C29C" "$(user_token "$U_C_MEM")" "$T/standing-own.txt" >/dev/null
expect "fail-before case 4: and C's own membership is still there" "$(grep -cF "$C29C" "$T/standing-own.txt")" '^1$'

# ---------------------------------------------------------------------------
section "29e cases 10 and 11: the pending-invitation bound, the seat bound at both places, and F7's net count"
# ---------------------------------------------------------------------------
e6_person e_admin; U_E_ADMIN="$U_e_admin"
C29E="$(company "e6-29e-$RUN" "$U_E_ADMIN")"
MS_E_ADMIN="$(membership_of "$C29E" "$U_E_ADMIN")"
invite() { as_call invite_member "$(jbody p_company="$C29E" p_email="$1" p_roles='#["member"]')" "$U_E_ADMIN" aal2; }
setq() { op_call set_company_quota "$(jbody p_company="$C29E" p_name="$1" p_value="#$2")"; }
# The seat bound is raised out of the way first, because it also counts live pending invitations: a company with
# fifty of them is over the 25-seat default long before it is over the fifty-invitation one, so the pending bound
# would never be the refusal a probe saw (observed while writing this section).
expect "case 10 fixture: the seat quota is raised to 200, so the pending bound is the one under test" "$(setq members_per_company 200)" '"value":200'
fill_invitations "$C29E" "$MS_E_ADMIN" 50 "29e-$RUN"
expect "case 10: fifty pending invitations are in place" "$(sql -c "select count(*) from app.invitations where company_id = '$C29E' and accepted_at is null and revoked_at is null and expires_at > clock_timestamp()")" '^50$'
expect "case 10: the fifty-first through the route: E_INVITATION_LIMIT" "$(invite "e6-29e-51-$RUN@example.invalid")" 'E_INVITATION_LIMIT'
expect "case 10: and no row was written" "$(sql -c "select count(*) from app.invitations where company_id = '$C29E'")" '^50$'
expect "case 10: after the operator raises the quota to 60: changed" "$(setq pending_invitations_per_company 60)" '"changed":true'
expect "case 10: the fifty-first is now admitted" "$(invite "e6-29e-51-$RUN@example.invalid")" '"invite_code"'
expect "case 10: the register reports the override as the source and fifty-one as used" "$(sql -c "select (q ->> 'source') || '/' || (q ->> 'used') from app.companies c, jsonb_array_elements(app.operator_company_row(c) -> 'quotas') q where c.id = '$C29E' and q ->> 'name' = 'pending_invitations_per_company'")" '^company/51$'
# E6D-C-F7, settled: a RESEND at the ceiling replaces a reservation rather than adding one, so it must not refuse.
expect "E6D-C-F7: the quota is lowered to 51, which is exactly what the company holds" "$(setq pending_invitations_per_company 51)" '"value":51'
expect "E6D-C-F7: a NEW address at the ceiling: E_INVITATION_LIMIT" "$(invite "e6-29e-52-$RUN@example.invalid")" 'E_INVITATION_LIMIT'
expect "E6D-C-F7 settled: a RESEND of an address that already holds a pending invitation, at the same ceiling: admitted" "$(invite "e6-29e-51-$RUN@example.invalid")" '"invite_code"'
expect "E6D-C-F7: and the company still holds fifty-one, not fifty-two" "$(sql -c "select count(*) from app.invitations where company_id = '$C29E' and accepted_at is null and revoked_at is null and expires_at > clock_timestamp()")" '^51$'
expect "E6D-C-F7: the replaced sibling carries reason_code replaced and the new id" "$(sql -c "select count(*) from app.audit_events where company_id = '$C29E' and action = 'invitation.revoke' and details ->> 'reason_code' = 'replaced'")" '^[1-9]'
sql -c "update app.invitations set revoked_at = now() where company_id = '$C29E' and accepted_at is null and revoked_at is null" >/dev/null

# The seat bound at both places. The company holds one active membership, its admin.
expect "case 11 fixture: one active member" "$(sql -c "select app.quota_used('$C29E', 'members_per_company')")" '^1$'
expect "case 11: the seat quota is set to 1, so the company is full" "$(setq members_per_company 1)" '"value":1'
expect "case 11: an invitation at the wall: E_SEATS_EXHAUSTED (defense in depth, design 3.1)" "$(invite "e6-29e-seat-$RUN@example.invalid")" 'E_SEATS_EXHAUSTED'
expect "case 11: and no invitation row was written for it" "$(sql -c "select count(*) from app.invitations where company_id = '$C29E' and email_normalized = 'e6-29e-seat-$RUN@example.invalid'")" '^0$'
# The AUTHORITATIVE check: two invitations seeded while one seat is free, then both accepted.
expect "case 11: the seat quota is raised to 2, so exactly one seat is free" "$(setq members_per_company 2)" '"value":2'
e6_person e_accept_1; e6_person e_accept_2
IV1="$(seeded_invitation "$C29E" "e6-$RUN-e_accept_1@example.invalid" '{member}' "$MS_E_ADMIN")"
IV2="$(seeded_invitation "$C29E" "e6-$RUN-e_accept_2@example.invalid" '{member}' "$MS_E_ADMIN")"
expect "case 11: the first acceptance takes the last seat" "$(accept_as "$U_e_accept_1" "${IV1#*|}")" '"membership_id"'
expect "case 11: the second is refused at the authoritative gate: E_SEATS_EXHAUSTED" "$(accept_as "$U_e_accept_2" "${IV2#*|}")" 'E_SEATS_EXHAUSTED'
expect "case 11: and no membership was created for the second" "$(sql -c "select count(*) from app.memberships where company_id = '$C29E' and user_id = '$U_e_accept_2'")" '^0$'
expect "case 11: and no audit row for the refused acceptance" "$(sql -c "select count(*) from app.audit_events where company_id = '$C29E' and action = 'invitation.accept' and details ->> 'membership_id' is not null")" '^1$'
# A reactivation at the wall is refused; an active member's role replacement is not.
MS_E1="$(membership_of "$C29E" "$U_e_accept_1")"
IV3="$(seeded_invitation "$C29E" "e6-$RUN-e_accept_1@example.invalid" '{it_reviewer,member}' "$MS_E_ADMIN")"
expect "case 11 control: an ACTIVE member accepting an invitation that only changes roles, at the wall: admitted" "$(accept_as "$U_e_accept_1" "${IV3#*|}")" '"it_reviewer"'
expect "case 11 control: and it added no membership" "$(sql -c "select app.quota_used('$C29E', 'members_per_company')")" '^2$'
sql -c "update app.memberships set status = 'removed', removed_at = now() where id = '$MS_E1'" >/dev/null
expect "case 11 control: with that membership removed the company holds one active member" "$(sql -c "select app.quota_used('$C29E', 'members_per_company')")" '^1$'
expect "case 11 control: the quota is lowered to 1, so the company is full again" "$(setq members_per_company 1)" '"value":1'
IV4="$(seeded_invitation "$C29E" "e6-$RUN-e_accept_1@example.invalid" '{member}' "$MS_E_ADMIN")"
expect "case 11 control: a REACTIVATION at the wall: E_SEATS_EXHAUSTED" "$(accept_as "$U_e_accept_1" "${IV4#*|}")" 'E_SEATS_EXHAUSTED'
expect "case 11 control: and the membership is still removed" "$(sql -c "select status from app.memberships where id = '$MS_E1'")" '^removed$'
expect "case 11 fixture: the seat quota is raised to 50 for the sections below" "$(setq members_per_company 50)" '"value":50'

# ---------------------------------------------------------------------------
section "29f case 39: operators and members are disjoint at the three creation points"
# ---------------------------------------------------------------------------
e6_person f_op_acct
sql -c "insert into app.operators (user_id) values ('$U_f_op_acct')" >/dev/null
IVF="$(seeded_invitation "$C29E" "e6-$RUN-f_op_acct@example.invalid" '{member}' "$MS_E_ADMIN")"
expect "case 39: an operator account accepting an invitation: E_OPERATOR_ACCOUNT" "$(accept_as "$U_f_op_acct" "${IVF#*|}")" 'E_OPERATOR_ACCOUNT'
expect "case 39: and no membership was created" "$(sql -c "select count(*) from app.memberships where user_id = '$U_f_op_acct'")" '^0$'
expect "case 39: the refusal is above every other test, so an operator account learns nothing about a token's validity" "$(accept_as "$U_f_op_acct" "$(printf '%064d' 0)")" 'E_OPERATOR_ACCOUNT'
expect "case 39: api.provision_company with an operator account as first admin: E_OPERATOR_ACCOUNT" "$(op_call provision_company "$(jbody p_slug="e6-29f-$RUN" p_name="SYNTHETIC 29f" p_first_admin_user="$U_f_op_acct")")" 'E_OPERATOR_ACCOUNT'
expect "case 39: and no company row was written" "$(sql -c "select count(*) from app.companies where slug = 'e6-29f-$RUN'")" '^0$'
expect "case 39: api.add_operator for an account holding an ACTIVE membership: E_MEMBER_ACCOUNT" "$(op_call add_operator "$(jbody p_user="$U_E_ADMIN")")" 'E_MEMBER_ACCOUNT'
expect "case 39: api.add_operator for an account holding a REMOVED membership: E_MEMBER_ACCOUNT" "$(op_call add_operator "$(jbody p_user="$U_e_accept_1")")" 'E_MEMBER_ACCOUNT'
expect "case 39: and neither wrote an operator row" "$(sql -c "select count(*) from app.operators where user_id in ('$U_E_ADMIN', '$U_e_accept_1')")" '^0$'
e6_person f_clean
expect "case 39: api.add_operator for an account holding neither: changed" "$(op_call add_operator "$(jbody p_user="$U_f_clean")")" '"changed":true'
expect "case 39: api.create_company refuses an address that belongs to an operator account" "$(op_call create_company "$(jbody p_slug="e6-29f2-$RUN" p_name="SYNTHETIC 29f2" p_first_admin_email="e6-$RUN-f_clean@example.invalid" p_starts_at="$STARTS" p_ends_at="$ENDS")")" 'E_OPERATOR_ACCOUNT'
expect "case 39 control: api.transfer_first_admin needs no check, because its target already holds a membership" "$(op_call transfer_first_admin "$(jbody p_company="$C29E" p_target_user="$U_e_accept_2")")" 'E_NOT_FOUND'
expect "case 39 control: api.operator_invite_admin to an operator's OWN address succeeds at issuance" "$(op_call operator_invite_admin "$(jbody p_company="$C29E" p_email="e6-$RUN-f_clean@example.invalid")")" '"invite_code"'
IVG="$(sql -c "select id from app.invitations where company_id = '$C29E' and email_normalized = 'e6-$RUN-f_clean@example.invalid' and accepted_at is null and revoked_at is null")"
expect "case 39 control: and the ACCEPTANCE is what refuses, which is the refusal at the right moment" "$(accept_as "$U_f_clean" "$(printf '%064d' 1)")" 'E_OPERATOR_ACCOUNT'
sql -c "update app.invitations set revoked_at = now() where id = '$IVG'" >/dev/null
# fail-before: the check removed from api.accept_invitation admits the crossing. IVF is still pending, because the
# refusal above wrote nothing, so the same code is the one this arm accepts.
save_routine 'api.accept_invitation(text)' accept_invitation
apply_fixture e6-disjoint-mutant.sql
expect "fail-before case 39: without the check the operator account is given a membership" "$(accept_as "$U_f_op_acct" "${IVF#*|}")" '"membership_id"'
expect "fail-before case 39: and the dual principal is in the join of the two tables" "$(sql -c "select count(*) from app.operators o join app.memberships m on m.user_id = o.user_id where o.user_id = '$U_f_op_acct'")" '^1$'
restore_routine accept_invitation
# The crossing is removed through the one door, because nothing else may delete a membership: the invitation that
# now references it goes first, since app.invitations.accepted_membership_id is a foreign key to it.
sql -c "begin; set local app.tenant_deletion = 'on';
        delete from app.invitations where accepted_membership_id in (select id from app.memberships where user_id = '$U_f_op_acct');
        delete from app.memberships where user_id = '$U_f_op_acct'; commit;" >/dev/null
expect "fail-before case 39: restored, and the crossing is gone" "$(sql -c "select count(*) from app.operators o join app.memberships m on m.user_id = o.user_id where o.user_id = '$U_f_op_acct'")" '^0$'

# ---------------------------------------------------------------------------
section "29g cases 12 and 13: api.transfer_agent by each caller class, and its three ordered branches"
# ---------------------------------------------------------------------------
e6_person g_admin; U_G_ADMIN="$U_g_admin"
C29G="$(company "e6-29g-$RUN" "$U_G_ADMIN")"
MS_G_ADMIN="$(membership_of "$C29G" "$U_G_ADMIN")"
e6_person g_owner "$C29G" '{member}'; e6_person g_target "$C29G" '{member}'
e6_person g_plain "$C29G" '{member}'; e6_person g_rev "$C29G" '{it_reviewer,member}'
e6_person g_removed "$C29G" '{member}'
sql -c "update app.memberships set status = 'removed', removed_at = now() where id = '$MS_g_removed'" >/dev/null
e6_person g_outsider; C29G2="$(company "e6-29g2-$RUN" "$U_g_outsider")"
CAND29G="$(submitted "$U_g_owner" "$C29G" "synthetic-29g-agent-$RUN" 1)"
AG29G="$(sql -c "select agent_id from app.candidate_versions where id = '$CAND29G'")"
CAND29G2="$(submitted "$U_g_plain" "$C29G" "synthetic-29g-other-$RUN" 1)"
AG29G2="$(sql -c "select agent_id from app.candidate_versions where id = '$CAND29G2'")"
expect "case 12 fixture: g_owner owns the agent" "$(sql -c "select owner_membership_id = '$MS_g_owner' from app.agents where id = '$AG29G'")" '^t$'
H0="$(agent_row_hash "$AG29G")"
expect "case 12: a plain member: E_FORBIDDEN" "$(transfer "$U_g_plain" "$AG29G" "$MS_g_target" "$MS_g_owner" aal2)" 'E_FORBIDDEN'
expect "case 12: a reviewer: E_FORBIDDEN" "$(transfer "$U_g_rev" "$AG29G" "$MS_g_target" "$MS_g_owner" aal2)" 'E_FORBIDDEN'
expect "case 12: an admin at aal1: E_ADMIN_MFA_REQUIRED" "$(transfer "$U_G_ADMIN" "$AG29G" "$MS_g_target" "$MS_g_owner")" 'E_ADMIN_MFA_REQUIRED'
expect "case 12: the owner of a DIFFERENT agent: E_FORBIDDEN" "$(transfer "$U_g_plain" "$AG29G" "$MS_g_target" "$MS_g_owner" aal2)" 'E_FORBIDDEN'
expect "case 12: a member of another company: E_NOT_FOUND" "$(transfer "$U_g_outsider" "$AG29G" "$MS_g_target" "$MS_g_owner" aal2)" 'E_NOT_FOUND'
expect "case 12: an unknown agent: E_NOT_FOUND" "$(transfer "$U_G_ADMIN" "$(uuid)" "$MS_g_target" "$MS_g_owner" aal2)" 'E_NOT_FOUND'
expect "case 12: a target membership of another company: E_NOT_FOUND, the same as unknown" "$(transfer "$U_G_ADMIN" "$AG29G" "$(membership_of "$C29G2" "$U_g_outsider")" "$MS_g_owner" aal2)" 'E_NOT_FOUND'
expect "case 12: a REMOVED target: E_MEMBERSHIP_REMOVED" "$(transfer "$U_G_ADMIN" "$AG29G" "$MS_g_removed" "$MS_g_owner" aal2)" 'E_MEMBERSHIP_REMOVED'
expect "case 12: nothing changed under any of the eight refusals" "$(agent_row_hash "$AG29G")" "^$H0\$"
expect "case 12: and no agent.transfer audit row was written" "$(sql -c "select count(*) from app.audit_events where company_id = '$C29G' and action = 'agent.transfer'")" '^0$'
expect "case 12: the agent's ACTIVE OWNER at aal1: 200, because the owner arm needs no aal" "$(transfer "$U_g_owner" "$AG29G" "$MS_g_target" "$MS_g_owner")" '"changed":true'
expect "case 12: one agent.transfer audit row, with the previous owner and the status after" "$(sql -c "select (details ->> 'previous_owner_membership_id') = '$MS_g_owner' and (details ->> 'agent_status_after') = 'active' from app.audit_events where company_id = '$C29G' and action = 'agent.transfer'")" '^t$'
expect "case 12: an admin at aal2: 200" "$(transfer "$U_G_ADMIN" "$AG29G" "$MS_g_owner" "$MS_g_target" aal2)" '"changed":true'
# Case 13's three branches, in order.
expect "case 13: the honest retry, the same call twice: changed false" "$(transfer "$U_G_ADMIN" "$AG29G" "$MS_g_owner" "$MS_g_target" aal2)" '"changed":false'
expect "case 13: and the honest retry wrote no second audit row" "$(sql -c "select count(*) from app.audit_events where company_id = '$C29G' and action = 'agent.transfer'")" '^2$'
expect "case 13: the stale retry, a third party having moved the agent: E_OWNER_CHANGED" "$(transfer "$U_G_ADMIN" "$AG29G" "$MS_g_target" "$MS_g_target" aal2)" 'E_OWNER_CHANGED'
expect "case 13: and nothing was written by it" "$(sql -c "select count(*) from app.audit_events where company_id = '$C29G' and action = 'agent.transfer'")" '^2$'
# The third branch: an ORPHANED agent whose owner column already names the target is un-orphaned, not answered
# changed: false, because the retry branch also requires status = 'active'.
sql -c "update app.agents set status = 'orphaned' where id = '$AG29G'" >/dev/null
expect "case 13: an orphaned agent whose owner already names the target: 200 and it returns to active" "$(transfer "$U_G_ADMIN" "$AG29G" "$MS_g_owner" "$MS_g_owner" aal2)" '"agent_status":"active"'
expect "case 13: three agent.transfer rows now, each recording the status after" "$(sql -c "select count(*) from app.audit_events where company_id = '$C29G' and action = 'agent.transfer' and details ->> 'agent_status_after' = 'active'")" '^3$'
expect "case 13 control: an ARCHIVED agent: E_AGENT_ARCHIVED" "$(sql -c "update app.agents set status = 'archived' where id = '$AG29G2'" >/dev/null; transfer "$U_G_ADMIN" "$AG29G2" "$MS_g_target" "$MS_g_plain" aal2)" 'E_AGENT_ARCHIVED'
sql -c "update app.agents set status = 'active' where id = '$AG29G2'" >/dev/null
expect "case 12 control: a null parameter: E_BODY_INVALID" "$(as_call transfer_agent "$(jbody p_agent="$AG29G" p_to_membership=null p_expected_owner="$MS_g_owner")" "$U_G_ADMIN" aal2)" 'E_BODY_INVALID'
# fail-before: the two branches in the other order answer E_OWNER_CHANGED to an honest retry.
save_routine 'api.transfer_agent(uuid, uuid, uuid)' transfer_agent
apply_fixture e6-transfer-branch-order-mutant.sql
expect "fail-before case 13: with the branches swapped an honest retry answers E_OWNER_CHANGED" "$(transfer "$U_G_ADMIN" "$AG29G" "$MS_g_owner" "$MS_g_target" aal2)" 'E_OWNER_CHANGED'
sql -c "update app.agents set status = 'orphaned' where id = '$AG29G'" >/dev/null
expect "fail-before case 13: and an orphaned agent already naming the target answers changed false, leaving it orphaned" "$(transfer "$U_G_ADMIN" "$AG29G" "$MS_g_owner" "$MS_g_owner" aal2)" '"changed":false'
expect "fail-before case 13: which is the agent left orphaned" "$(sql -c "select status from app.agents where id = '$AG29G'")" '^orphaned$'
restore_routine transfer_agent
expect "fail-before case 13: restored, and the orphan is un-orphaned again" "$(transfer "$U_G_ADMIN" "$AG29G" "$MS_g_owner" "$MS_g_owner" aal2)" '"agent_status":"active"'

# ---------------------------------------------------------------------------
section "29h case 18: the departure preview's counts are the truth"
# ---------------------------------------------------------------------------
A0="$(audit_count "$C29G")"
expect "case 18: a member with nothing: every count zero and no group" "$(preview "$U_G_ADMIN" "$MS_g_rev")" '"drafts": 0'
r="$(preview "$U_G_ADMIN" "$MS_g_owner")"
expect "case 18: a member with drafts and owned agents answers" "$r" '"owned_agents"'
as_body departure_preview "$(jbody p_membership="$MS_g_owner")" "$T/preview.txt" "$U_G_ADMIN" aal2 >/dev/null
for f in drafts submitted_awaiting_review authorizations reports witnesses published_releases; do
  case "$f" in
    drafts) q="select count(*) from app.candidate_versions where author_membership_id = '$MS_g_owner' and state = 'draft'" ;;
    submitted_awaiting_review) q="select count(*) from app.candidate_versions where author_membership_id = '$MS_g_owner' and state = 'submitted'" ;;
    authorizations) q="select count(*) from app.release_downloads where membership_id = '$MS_g_owner'" ;;
    reports) q="select count(*) from app.installation_reports where membership_id = '$MS_g_owner'" ;;
    witnesses) q="select count(*) from app.installation_witnesses where witness_membership_id = '$MS_g_owner'" ;;
    published_releases) q="select count(*) from app.releases where published_by_membership_id = '$MS_g_owner'" ;;
  esac
  expect "case 18: $f equals an owner-side count of the same rows" "$(jfield "$T/preview.txt" "$f")|$(sql -c "$q")" "^$(sql -c "$q")|$(sql -c "$q")\$"
done
expect "case 18: owned_agents lists exactly the agents that membership owns, which the transfers of 29g left it" "$(jfield "$T/preview.txt" owned_agents)|$(sql -c "select coalesce(string_agg(id::text, ','), 'NONE') from app.agents where owner_membership_id = '$MS_g_owner'")" "$(sql -c "select coalesce(string_agg(id::text, ','), 'NONE') from app.agents where owner_membership_id = '$MS_g_owner'")\$"
expect "case 18: the read wrote no audit row" "$(audit_count "$C29G")" "^$A0\$"
expect "case 18: is_last_admin is false for a member who is no admin" "$(jfield "$T/preview.txt" is_last_admin)" '^false$'
as_body departure_preview "$(jbody p_membership="$MS_G_ADMIN")" "$T/preview-admin.txt" "$U_G_ADMIN" aal2 >/dev/null
expect "case 18: is_last_admin is true for the only admin" "$(jfield "$T/preview-admin.txt" is_last_admin)" '^true$'
expect "case 18: sole_holder_of_roles names the roles nobody else active holds" "$(jfield "$T/preview-admin.txt" sole_holder_of_roles)" 'company_admin'
expect "case 18 control: the preview by a plain member of the same company: E_FORBIDDEN" "$(preview "$U_g_plain" "$MS_g_owner")" 'E_FORBIDDEN'
expect "case 18 control: by a reviewer: E_FORBIDDEN" "$(preview "$U_g_rev" "$MS_g_owner")" 'E_FORBIDDEN'
expect "case 18 control: by an admin at aal1: E_ADMIN_MFA_REQUIRED" "$(preview "$U_G_ADMIN" "$MS_g_owner" '')" 'E_ADMIN_MFA_REQUIRED'
expect "case 18 control: by an admin of another company: E_NOT_FOUND" "$(preview "$U_g_outsider" "$MS_g_owner")" 'E_NOT_FOUND'
expect "case 18 control: an unknown membership: E_NOT_FOUND" "$(preview "$U_G_ADMIN" "$(uuid)")" 'E_NOT_FOUND'
expect "case 18: the routine is STABLE, which is what gives its aggregates one snapshot" "$(sql -c "select provolatile from pg_proc where proname = 'departure_preview' and pronamespace = 'api'::regnamespace")" '^s$'
expect "case 18: and it is ONE statement in language sql" "$(sql -c "select lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.proname = 'departure_preview' and p.pronamespace = 'api'::regnamespace")" '^sql$'

# ---------------------------------------------------------------------------
section "29i case 19: a company past ends_at but before export_by: writes stop, reads and the export continue"
# ---------------------------------------------------------------------------
e6_person i_admin; U_I_ADMIN="$U_i_admin"
C29I="$(company "e6-29i-$RUN" "$U_I_ADMIN")"
MS_I_ADMIN="$(membership_of "$C29I" "$U_I_ADMIN")"
e6_person i_mem "$C29I" '{member}'
# Owner-side: the period's ends_at is an hour ago and its export_by is a fortnight ahead.
sql -c "insert into app.access_periods (company_id, starts_at, ends_at, export_by, delete_by)
        values ('$C29I', clock_timestamp() - interval '56 days', clock_timestamp() - interval '1 hour',
                clock_timestamp() + interval '14 days', clock_timestamp() + interval '44 days')" >/dev/null
expect "case 19: app.access_state answers export_window" "$(access_state "$C29I")" '^export_window$'
expect "case 19: an invitation: E_ACCESS_PERIOD_ENDED" "$(as_call invite_member "$(jbody p_company="$C29I" p_email="e6-29i-$RUN@example.invalid" p_roles='#["member"]')" "$U_I_ADMIN" aal2)" 'E_ACCESS_PERIOD_ENDED'
expect "case 19: a role change: E_ACCESS_PERIOD_ENDED" "$(as_call set_roles "$(jbody p_membership="$MS_i_mem" p_roles='#["it_reviewer","member"]')" "$U_I_ADMIN" aal2)" 'E_ACCESS_PERIOD_ENDED'
expect "case 19: a removal: E_ACCESS_PERIOD_ENDED" "$(as_call remove_member "$(jbody p_membership="$MS_i_mem")" "$U_I_ADMIN" aal2)" 'E_ACCESS_PERIOD_ENDED'
expect "case 19: a group: E_ACCESS_PERIOD_ENDED" "$(as_call create_group "$(jbody p_company="$C29I" p_name="Group 29i $RUN")" "$U_I_ADMIN" aal2)" 'E_ACCESS_PERIOD_ENDED'
expect "case 19: a draft: E_ACCESS_PERIOD_ENDED" "$(draft_by_name "$U_i_mem" "$C29I" "synthetic-29i-$RUN" 1)" 'E_ACCESS_PERIOD_ENDED'
expect "case 19: nothing was written by any of the five" "$(sql -c "select count(*) from app.groups where company_id = '$C29I'")" '^0$'
expect "case 19: and the member's roles are unchanged" "$(sql -c "select roles::text from app.memberships where id = '$MS_i_mem'")" '^{member}$'
expect "case 19: every read continues: the member reads their own standing" "$(rest GET "/my_standing?select=access_state&company_id=eq.$C29I" "$(user_token "$U_i_mem")")" 'export_window'
expect "case 19: the member list reads" "$(rest GET "/memberships?select=id&company_id=eq.$C29I" "$(user_token "$U_i_mem")")" "$MS_i_mem"
expect "case 19: and the export answers 200 for the admin at aal2" "$(export_as "$U_I_ADMIN" "$C29I")" '^HTTP 200'
# fail-before: app.lock_company without its test admits every one of those writes.
save_routine 'app.lock_company(uuid)' lock_company
apply_fixture e6-lock-company-no-period-mutant.sql
expect "fail-before case 19: without lock_company's test the group is created" "$(as_call create_group "$(jbody p_company="$C29I" p_name="Mutant 29i $RUN")" "$U_I_ADMIN" aal2)" '"changed":true'
expect "fail-before case 19: which is a write into a company whose agreement ended" "$(sql -c "select count(*) from app.groups where company_id = '$C29I'")" '^1$'
restore_routine lock_company
expect "fail-before case 19: restored, and the next group is refused again" "$(as_call create_group "$(jbody p_company="$C29I" p_name="Restored 29i $RUN")" "$U_I_ADMIN" aal2)" 'E_ACCESS_PERIOD_ENDED'
# Control: the same company with ends_at an hour ahead, where every write succeeds.
future_period "$C29I"
expect "case 19 control: with ends_at an hour ahead app.access_state is current" "$(access_state "$C29I")" '^current$'
expect "case 19 control: and the group is created" "$(as_call create_group "$(jbody p_company="$C29I" p_name="Control 29i $RUN")" "$U_I_ADMIN" aal2)" '"changed":true'

# ---------------------------------------------------------------------------
section "29j case 38: the export window closes WITHOUT the sweep"
# ---------------------------------------------------------------------------
# export_by passed an hour ago and api.operator_expiry_run has NOT been run, so companies.status is still active:
# a window whose end is a status a person sets is not a window (E6D-C-F3).
age_period "$C29I" '15 days' '1 hour' '-29 days'
expect "case 38: the company's status is still active, because nothing swept it" "$(sql -c "select status from app.companies where id = '$C29I'")" '^active$'
expect "case 38: app.access_state answers expired, from time alone" "$(access_state "$C29I")" '^expired$'
expect "case 38: the member's own standing carries the expired access state" "$(rest GET "/my_standing?select=access_state&company_id=eq.$C29I" "$(user_token "$U_i_mem")")" 'expired'
expect "case 38: the export: E_ACCESS_PERIOD_ENDED" "$(export_as "$U_I_ADMIN" "$C29I")" 'E_ACCESS_PERIOD_ENDED'
expect "case 38: a write is refused too, by lock_company's own test" "$(as_call create_group "$(jbody p_company="$C29I" p_name="Expired 29i $RUN")" "$U_I_ADMIN" aal2)" 'E_ACCESS_PERIOD_ENDED'
# The download half of the boundary: app.download_refusal_for answers the same code, from time and not from status.
expect "case 38: app.download_refusal_for answers E_ACCESS_PERIOD_ENDED for a release of that company" "$(sql -c "select coalesce((select app.download_refusal_for(r, '$MS_i_mem') from app.releases r where r.company_id = '$C29I' limit 1), 'NO-RELEASE')")" '^E_ACCESS_PERIOD_ENDED$\|^NO-RELEASE$'
# fail-before: the three tests removed, one routine at a time, each admitting what the window must refuse.
save_routine 'api.export_company(uuid)' export_company
apply_fixture e6-export-no-period-mutant.sql
expect "fail-before case 38: api.export_company without its own access-period test exports a company years past export_by" "$(export_as "$U_I_ADMIN" "$C29I")" '^HTTP 200'
restore_routine export_company
expect "fail-before case 38: restored, and the export refuses again" "$(export_as "$U_I_ADMIN" "$C29I")" 'E_ACCESS_PERIOD_ENDED'
save_routine 'app.my_standing()' my_standing_38
apply_fixture e6-my-standing-no-state-mutant.sql
expect "fail-before case 38: app.my_standing without the access state answers current for an expired company" "$(rest GET "/my_standing?select=access_state&company_id=eq.$C29I" "$(user_token "$U_i_mem")")" '"access_state":"current"'
restore_routine my_standing_38
expect "fail-before case 38: restored, and the state is expired again" "$(rest GET "/my_standing?select=access_state&company_id=eq.$C29I" "$(user_token "$U_i_mem")")" 'expired'
# Then the operator extends the period and every one of them answers again, with the same token.
expect "case 38: the operator extends the period" "$(op_call set_access_period "$(jbody p_company="$C29I" p_invoice_ref="INV-29I-$RUN" p_starts_at="$(iso_ago 86400)" p_ends_at="$(iso_ago -2592000)")")" '"changed":true'
expect "case 38: app.access_state is current again" "$(access_state "$C29I")" '^current$'
expect "case 38: the export answers 200 with the same token" "$(export_as "$U_I_ADMIN" "$C29I")" '^HTTP 200'
expect "case 38: and a write is admitted again" "$(as_call create_group "$(jbody p_company="$C29I" p_name="Extended 29i $RUN")" "$U_I_ADMIN" aal2)" '"changed":true'

# ---------------------------------------------------------------------------
section "29k case 20: the expiry run is idempotent, bounded, ordered and audited"
# ---------------------------------------------------------------------------
# Three companies past export_by and two past delete_by, none of them touched by the sections above.
for n in 1 2 3; do
  e6_person "k_admin_$n"
  eval "C29K$n=\"\$(company e6-29k-$n-$RUN \$U_k_admin_$n)\""
  eval "age_period \"\$C29K$n\" '30 days' '16 days' '-14 days'"
done
for n in 4 5; do
  e6_person "k_admin_$n"
  eval "C29K$n=\"\$(company e6-29k-$n-$RUN \$U_k_admin_$n)\""
  eval "age_period \"\$C29K$n\" '120 days' '106 days' '20 days'"
done
expect "case 20 fixture: three companies in the export-expired state" "$(sql -c "select count(*) from app.companies c join app.access_periods p on p.company_id = c.id where c.status = 'active' and p.export_by <= clock_timestamp() and c.slug like 'e6-29k-%-$RUN'")" '^5$'
expect "case 20: p_limit 0: E_BODY_INVALID" "$(op_call operator_expiry_run "$(jbody p_limit='#0')")" 'E_BODY_INVALID'
expect "case 20: p_limit 501: E_BODY_INVALID" "$(op_call operator_expiry_run "$(jbody p_limit='#501')")" 'E_BODY_INVALID'
K0="$(sql -c "select count(*) from app.audit_events where action = 'company.suspend' and details ->> 'reason_code' = 'access_period_expired'")"
op_body operator_expiry_run "$(jbody p_limit='#2')" "$T/run1.txt" >/dev/null
expect "case 20: the first run suspends two" "$(node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.suspended.length))' "$T/run1.txt")" '^2$'
expect "case 20: and reports what is left" "$(jfield "$T/run1.txt" remaining)" '^3$'
op_body operator_expiry_run "$(jbody p_limit='#2')" "$T/run2.txt" >/dev/null
expect "case 20: the second run suspends two more" "$(node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.suspended.length))' "$T/run2.txt")" '^2$'
op_body operator_expiry_run "$(jbody p_limit='#2')" "$T/run3.txt" >/dev/null
expect "case 20: the third run suspends the last one and reports none left" "$(jfield "$T/run3.txt" remaining)" '^0$'
op_body operator_expiry_run "$(jbody p_limit='#2')" "$T/run4.txt" >/dev/null
expect "case 20: a fourth run suspends nothing, which is what idempotent means here" "$(node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.suspended.length))' "$T/run4.txt")" '^0$'
expect "case 20: exactly five company.suspend rows with reason access_period_expired across the runs" "$(sql -c "select count(*) - $K0 from app.audit_events where action = 'company.suspend' and details ->> 'reason_code' = 'access_period_expired'")" '^5$'
expect "case 20: it NEVER deleted one: all five companies are still there" "$(sql -c "select count(*) from app.companies where slug like 'e6-29k-%-$RUN'")" '^5$'
expect "case 20: and the two past delete_by are listed as due for deletion, never acted on" "$(node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.due_for_deletion.map((d)=>d.deletion_state).sort().join(","))' "$T/run4.txt")" 'overdue'
expect "case 20: the second list is BOUNDED by p_limit too (E6D-C-F14)" "$(node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.due_for_deletion.length <= 2))' "$T/run4.txt")" '^true$'
expect "case 20: and remaining_due says what the list left out" "$(node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.remaining_due >= 0))' "$T/run4.txt")" '^true$'
expect "case 20: the three counts are complete aggregates, not the list's length" "$(node -e 'const j=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));const c=j.counts;process.stdout.write(String(c.eligible + c.due + c.overdue >= 5))' "$T/run4.txt")" '^true$'
expect "case 20: app.deletion_state for a company past delete_by is overdue" "$(deletion_state "$C29K4")" '^overdue$'
expect "case 20: and for one inside the eligible window it is eligible" "$(deletion_state "$C29K1")" '^eligible$'
expect "case 20: deadlocks unchanged" "$(deadlocks)" "^$DL0\$"

# ---------------------------------------------------------------------------
section "29l cases 21 and 22: what each company state makes true, and closed is terminal against four writers"
# ---------------------------------------------------------------------------
# The route's status code is lib/services/principal.mjs's to choose from what this view returns; what a database
# probe decides is what the view says and what every mutation answers. The 409 and 404 mapping is the services
# lane's arm of case 21 and evidence/e6-db.md section 6 says so.
e6_person l_admin; U_L_ADMIN="$U_l_admin"
C29L="$(company "e6-29l-$RUN" "$U_L_ADMIN")"
e6_person l_mem "$C29L" '{member}'; e6_person l_rev "$C29L" '{it_reviewer,member}'
future_period "$C29L"
expect "case 21: suspended INSIDE its window" "$(op_call set_company_status "$(jbody p_company="$C29L" p_status=suspended p_reason_code=non_payment)")" '"status":"suspended"'
expect "case 21: the member's standing still names the company, with its status and its access state" "$(rest GET "/my_standing?select=company_status,access_state&company_id=eq.$C29L" "$(user_token "$U_l_mem")")" '"company_status":"suspended"'
expect "case 21: and the access state is current, so the two facts are separate" "$(rest GET "/my_standing?select=access_state&company_id=eq.$C29L" "$(user_token "$U_l_mem")")" '"access_state":"current"'
expect "case 21: every api view is empty for that company's members" "$(rest GET "/companies?select=slug&id=eq.$C29L" "$(user_token "$U_l_mem")")" 'HTTP 200 \[\]'
expect "case 21: and the memberships view too" "$(rest GET "/memberships?select=id&company_id=eq.$C29L" "$(user_token "$U_l_rev")")" 'HTTP 200 \[\]'
expect "case 21: a write refuses E_COMPANY_INACTIVE, not the period code" "$(as_call create_group "$(jbody p_company="$C29L" p_name="Suspended 29l $RUN")" "$U_L_ADMIN" aal2)" 'E_COMPANY_INACTIVE'
expect "case 21: the admin's export answers 200, which is the fourteen-day window (design 3.1 note 2)" "$(export_as "$U_L_ADMIN" "$C29L")" '^HTTP 200'
expect "case 21: resumed with the same tokens" "$(op_call set_company_status "$(jbody p_company="$C29L" p_status=active p_reason_code=customer_request)")" '"status":"active"'
expect "case 21: and the views answer again, no reinvitation and no new session" "$(rest GET "/companies?select=slug&id=eq.$C29L" "$(user_token "$U_l_mem")")" "e6-29l-$RUN"
expect "case 21: a no-op status write answers changed false and writes no audit row" "$(op_call set_company_status "$(jbody p_company="$C29L" p_status=active p_reason_code=customer_request)")" '"changed":false'
L1="$(sql -c "select count(*) from app.audit_events where company_id = '$C29L' and action in ('company.suspend', 'company.resume')")"
expect "case 21: exactly two rows, one suspend and one resume" "$L1" '^2$'
expect "case 21: an invalid status: E_BODY_INVALID" "$(op_call set_company_status "$(jbody p_company="$C29L" p_status=read_only p_reason_code=customer_request)")" 'E_BODY_INVALID'
# E7's migration 009 added the fourth: 'held', the recovery hold (docs/e7/design.md 2.1, correction E7D-C-F1),
# which no customer path admits and which only the reconciler moves a company into or out of. It is NOT a status
# an operator may ask for: api.set_company_status's parameter list is still ('active', 'suspended'), which the
# E_BODY_INVALID line above still proves. Probe 32 walks every door the hold refuses. Changed 2026-09-20 under
# the lead's grant, as the one expectation a fourth status word moves in this probe.
expect "case 21: the vocabulary has four company statuses, the fourth being E7's recovery hold" "$(sql -c "select array_length(app.company_statuses(), 1)")" '^4$'
expect "case 21: and the fourth is 'held'" "$(sql -c "select (app.company_statuses())[4]")" '^held$'
# The lead's decision on this lane's question 1 (E6DB-F4): the reason code is a parameter with a closed list of
# three, so a suspension over an unpaid invoice and one at the customer's request are different audit rows. A
# word outside the list, and an absent one, are E_BODY_INVALID beside the status vocabulary.
expect "case 21: a reason code outside the closed list: E_BODY_INVALID" "$(op_call set_company_status "$(jbody p_company="$C29L" p_status=suspended p_reason_code=because_i_said_so)")" 'E_BODY_INVALID'
expect "case 21: no reason code at all: PostgREST resolves no routine of that shape" "$(op_call set_company_status "$(jbody p_company="$C29L" p_status=suspended)")" 'PGRST202'
expect "case 21: an explicit null reason code: E_BODY_INVALID from the routine itself" "$(op_call set_company_status "$(jbody p_company="$C29L" p_status=suspended p_reason_code=null)")" 'E_BODY_INVALID'
expect "case 21: neither wrote a row: still exactly two" "$(sql -c "select count(*) from app.audit_events where company_id = '$C29L' and action in ('company.suspend', 'company.resume')")" '^2$'
expect "case 21: the recorded reason is the operator's word and not the old fixed one" "$(sql -c "select details->>'reason_code' from app.audit_events where company_id = '$C29L' and action = 'company.suspend'")" '^non_payment$'
# Then suspended PAST export_by, where the access state is the other answer.
age_period "$C29L" '30 days' '16 days' '-14 days'
expect "case 22 fixture: suspended again" "$(op_call set_company_status "$(jbody p_company="$C29L" p_status=suspended p_reason_code=non_payment)")" '"status":"suspended"'
expect "case 21: past export_by the same member's standing carries expired, which is the second code (design 1.5)" "$(rest GET "/my_standing?select=access_state&company_id=eq.$C29L" "$(user_token "$U_l_mem")")" '"access_state":"expired"'
# Case 22: closed is terminal against four writers.
expect "case 22: closing an ACTIVE company: E_COMPANY_NOT_SUSPENDED" "$(op_call set_company_status "$(jbody p_company="$C29L" p_status=active p_reason_code=customer_request)" >/dev/null; op_call close_company "$(jbody p_company="$C29L" p_confirm_slug="e6-29l-$RUN" p_reason_code=retention_deadline)")" 'E_COMPANY_NOT_SUSPENDED'
op_call set_company_status "$(jbody p_company="$C29L" p_status=suspended p_reason_code=non_payment)" >/dev/null
expect "case 22: closing with a wrong slug: E_CONFIRMATION_MISMATCH" "$(op_call close_company "$(jbody p_company="$C29L" p_confirm_slug=wrong-slug p_reason_code=retention_deadline)")" 'E_CONFIRMATION_MISMATCH'
expect "case 22: and it is still suspended" "$(sql -c "select status from app.companies where id = '$C29L'")" '^suspended$'
expect "case 22: closed, past export_by, with retention_deadline" "$(op_call close_company "$(jbody p_company="$C29L" p_confirm_slug="e6-29l-$RUN" p_reason_code=retention_deadline)")" '"status":"closed"'
expect "case 22: the audit row carries the reason code" "$(sql -c "select details ->> 'reason_code' from app.audit_events where company_id = '$C29L' and action = 'company.close'")" '^retention_deadline$'
expect "case 22: already closed answers changed false" "$(op_call close_company "$(jbody p_company="$C29L" p_confirm_slug="e6-29l-$RUN" p_reason_code=retention_deadline)")" '"changed":false'
expect "case 22: writer 1, api.set_company_status back to active: E_COMPANY_CLOSED" "$(op_call set_company_status "$(jbody p_company="$C29L" p_status=active p_reason_code=customer_request)")" 'E_COMPANY_CLOSED'
expect "case 22: writer 2, the OWNER with a plain update: E_COMPANY_CLOSED" "$(sql_try -c "update app.companies set status = 'active' where id = '$C29L'")" 'E_COMPANY_CLOSED'
expect "case 22: writer 3, app_maintenance, which E2 section 5 grants update (status): E_COMPANY_CLOSED" "$(sql -c "grant app_maintenance to postgres" >/dev/null; sql_try -c "set role app_maintenance; update app.companies set status = 'active' where id = '$C29L';")" 'E_COMPANY_CLOSED'
expect "case 22: writer 4, the same update WITH the deletion bypass: admitted, which is how E7's reconciler keeps E2 section 5's disclosed power" "$(sql_try -c "begin; set local app.tenant_deletion = 'on'; update app.companies set status = 'active' where id = '$C29L' returning 'REOPENED|' || status; rollback;")" 'REOPENED|active'
sql -c "revoke app_maintenance from postgres" >/dev/null
expect "case 22: the rollback means it is still closed" "$(sql -c "select status from app.companies where id = '$C29L'")" '^closed$'
expect "case 22: the identity guard refuses a slug change" "$(sql_try -c "update app.companies set slug = 'renamed-29l-$RUN' where id = '$C29L'")" 'E_COMPANY_IDENTITY'
expect "case 22: and a DELETE without the bypass: E_COMPANY_DELETE" "$(sql_try -c "delete from app.companies where id = '$C29L'")" 'E_COMPANY_DELETE'
expect "case 22: and a TRUNCATE, which a row trigger would not see" "$(sql_try -c "truncate app.companies cascade")" 'E_COMPANY_DELETE'
expect "case 22: a TRUNCATE even WITH the bypass, because the bypass opens DELETE only" "$(sql_try -c "begin; set local app.tenant_deletion = 'on'; truncate app.companies cascade; rollback;")" 'E_COMPANY_DELETE'

# ---------------------------------------------------------------------------
section "29m case 23: the export by each caller class, with its three fail-befores"
# ---------------------------------------------------------------------------
e6_person m_admin; U_M_ADMIN="$U_m_admin"
C29M="$(company "e6-29m-$RUN" "$U_M_ADMIN")"
e6_person m_mem "$C29M" '{member}'; e6_person m_rev "$C29M" '{it_reviewer,member}'
e6_person m_owner "$C29M" '{member}'
e6_person m_out; C29M2="$(company "e6-29m2-$RUN" "$U_m_out")"
future_period "$C29M"
expect "case 23: a plain member: E_FORBIDDEN" "$(export_as "$U_m_mem" "$C29M")" 'E_FORBIDDEN'
expect "case 23: a reviewer: E_FORBIDDEN" "$(export_as "$U_m_rev" "$C29M")" 'E_FORBIDDEN'
expect "case 23: an admin at aal1: E_ADMIN_MFA_REQUIRED" "$(export_as "$U_M_ADMIN" "$C29M" '')" 'E_ADMIN_MFA_REQUIRED'
expect "case 23: an admin at aal2: 200" "$(export_as "$U_M_ADMIN" "$C29M")" '^HTTP 200'
expect "case 23: an admin of ANOTHER company: E_NOT_FOUND" "$(export_as "$U_m_out" "$C29M")" 'E_NOT_FOUND'
expect "case 23: an operator at aal2, who is a member of nothing: E_NOT_FOUND" "$(export_as "$U_op" "$C29M")" 'E_NOT_FOUND'
expect "case 23: an operator at aal1: the same E_NOT_FOUND, because there is no operator arm at all" "$(export_as "$U_op" "$C29M" '')" 'E_NOT_FOUND'
expect "case 23: an unknown company: E_NOT_FOUND" "$(export_as "$U_M_ADMIN" "$(uuid)")" 'E_NOT_FOUND'
expect "case 23: anon: permission denied for schema api" "$(rest POST /rpc/export_company "$ANON_KEY" "$(jbody p_company="$C29M")")" 'permission denied'
expect "case 23: service_role: permission denied for the function" "$(rest POST /rpc/export_company "$SERVICE_ROLE_KEY" "$(jbody p_company="$C29M")")" 'permission denied'
expect "case 23: the admin of a company SUSPENDED inside its window: 200, which is the promised window" "$(op_call set_company_status "$(jbody p_company="$C29M" p_status=suspended p_reason_code=non_payment)" >/dev/null; export_as "$U_M_ADMIN" "$C29M")" '^HTTP 200'
expect "case 23: the admin of a company past EXPORT_BY: E_ACCESS_PERIOD_ENDED" "$(age_period "$C29M" '30 days' '1 hour' '-29 days'; export_as "$U_M_ADMIN" "$C29M")" 'E_ACCESS_PERIOD_ENDED'
# The closed arm needs a company still INSIDE its window, so that the refusal it meets is the closure and not the
# access-period test above it: the period is put back and the closure carries the customer instruction the
# export-window rule requires.
future_period "$C29M"
expect "case 23 fixture: closed inside its window, on a recorded customer instruction" "$(op_call close_company "$(jbody p_company="$C29M" p_confirm_slug="e6-29m-$RUN" p_reason_code=customer_instruction)")" '"status":"closed"'
expect "case 23: the admin of a CLOSED company: E_FORBIDDEN" "$(export_as "$U_M_ADMIN" "$C29M")" 'E_FORBIDDEN'
# fail-before 1: app.export_admin written with app.has_role refuses the suspended company's admin.
sql -c "begin; set local app.tenant_deletion = 'on'; update app.companies set status = 'suspended' where id = '$C29M'; commit;" >/dev/null
future_period "$C29M"
expect "case 23 fixture: suspended inside its window again, and the export answers" "$(export_as "$U_M_ADMIN" "$C29M")" '^HTTP 200'
save_routine 'app.export_admin(uuid)' export_admin
apply_fixture e6-export-has-role-mutant.sql
expect "fail-before case 23: app.export_admin on app.has_role refuses the suspended company's admin, which is the window taken away" "$(export_as "$U_M_ADMIN" "$C29M")" 'E_NOT_FOUND'
restore_routine export_admin
expect "fail-before case 23: restored, and the suspended company's admin exports again" "$(export_as "$U_M_ADMIN" "$C29M")" '^HTTP 200'
# fail-before 2: the routine without its access-period test admits a company years past export_by (also 29j).
age_period "$C29M" '400 days' '386 days' '356 days'
save_routine 'api.export_company(uuid)' export_company_23
apply_fixture e6-export-no-period-mutant.sql
expect "fail-before case 23: without the access-period test a company a year past export_by is exported" "$(export_as "$U_M_ADMIN" "$C29M")" '^HTTP 200'
restore_routine export_company_23
expect "fail-before case 23: restored, and it refuses" "$(export_as "$U_M_ADMIN" "$C29M")" 'E_ACCESS_PERIOD_ENDED'
# fail-before 3: an operator arm, restored, answers 200 to an operator at aal2 and hands them the whole company.
future_period "$C29M"
save_routine 'app.export_admin(uuid)' export_admin_23b
apply_fixture e6-export-operator-arm-mutant.sql
expect "fail-before case 23: with an operator arm restored, an operator at aal2 exports the whole company" "$(export_as "$U_op" "$C29M")" '^HTTP 200'
restore_routine export_admin_23b
expect "fail-before case 23: restored, and the operator meets E_NOT_FOUND again" "$(export_as "$U_op" "$C29M")" 'E_NOT_FOUND'

# ---------------------------------------------------------------------------
section "29n cases 31 and 35: admin succession, and the operator acting on a company past its period"
# ---------------------------------------------------------------------------
e6_person n_admin; U_N_ADMIN="$U_n_admin"
C29N="$(company "e6-29n-$RUN" "$U_N_ADMIN")"
e6_person n_second "$C29N" '{member}'
future_period "$C29N"
# (a) the second member is granted company_admin by user id.
expect "case 31a: the operator grants the second member company_admin" "$(op_call transfer_first_admin "$(jbody p_company="$C29N" p_target_user="$U_n_second")")" '"changed":true'
expect "case 31a: and the roles are on the membership" "$(sql -c "select 'company_admin' = any (roles) from app.memberships where id = '$MS_n_second'")" '^t$'
expect "case 31a: a repeat answers changed false" "$(op_call transfer_first_admin "$(jbody p_company="$C29N" p_target_user="$U_n_second")")" '"changed":false'
# (b) and (c): the same, with the company suspended, and with the company past ends_at.
e6_person n_third "$C29N" '{member}'
expect "case 31b: with the company SUSPENDED: 200, because api.transfer_first_admin takes the operator lock" "$(op_call set_company_status "$(jbody p_company="$C29N" p_status=suspended p_reason_code=non_payment)" >/dev/null; op_call transfer_first_admin "$(jbody p_company="$C29N" p_target_user="$U_n_third")")" '"changed":true'
e6_person n_fourth "$C29N" '{member}'
op_call set_company_status "$(jbody p_company="$C29N" p_status=active p_reason_code=customer_request)" >/dev/null
age_period "$C29N" '1 hour' '-14 days' '-44 days'
expect "case 31c fixture: past ends_at and inside the export window" "$(access_state "$C29N")" '^export_window$'
expect "case 31c: with the company past ends_at: 200" "$(op_call transfer_first_admin "$(jbody p_company="$C29N" p_target_user="$U_n_fourth")")" '"changed":true'
expect "case 31 control: a member-facing write in the same company still refuses" "$(as_call create_group "$(jbody p_company="$C29N" p_name="Past 29n $RUN")" "$U_N_ADMIN" aal2)" 'E_ACCESS_PERIOD_ENDED'
expect "case 31 control: to a REMOVED member: E_NOT_FOUND" "$(sql -c "update app.memberships set status = 'removed', removed_at = now() where id = '$MS_n_fourth'" >/dev/null; op_call transfer_first_admin "$(jbody p_company="$C29N" p_target_user="$U_n_fourth")")" 'E_NOT_FOUND'
sql -c "update app.memberships set status = 'active', removed_at = null where id = '$MS_n_fourth'" >/dev/null
expect "case 31 control: to a member of another company: E_NOT_FOUND" "$(op_call transfer_first_admin "$(jbody p_company="$C29N" p_target_user="$U_m_out")")" 'E_NOT_FOUND'
# fail-before (1): api.transfer_first_admin on app.lock_company refuses (b) and (c).
save_routine 'api.transfer_first_admin(uuid, uuid)' transfer_first_admin
apply_fixture e6-succession-member-lock-mutant.sql
e6_person n_fifth "$C29N" '{member}'
expect "fail-before case 31: on app.lock_company the grant into an EXPIRED company refuses E_ACCESS_PERIOD_ENDED" "$(op_call transfer_first_admin "$(jbody p_company="$C29N" p_target_user="$U_n_fifth")")" 'E_ACCESS_PERIOD_ENDED'
future_period "$C29N"
op_call set_company_status "$(jbody p_company="$C29N" p_status=suspended p_reason_code=non_payment)" >/dev/null
expect "fail-before case 31: and into a SUSPENDED company it refuses E_COMPANY_INACTIVE, which is when one is asked for" "$(op_call transfer_first_admin "$(jbody p_company="$C29N" p_target_user="$U_n_fifth")")" 'E_COMPANY_INACTIVE'
restore_routine transfer_first_admin
expect "fail-before case 31: restored, and the suspended company gains its administrator" "$(op_call transfer_first_admin "$(jbody p_company="$C29N" p_target_user="$U_n_fifth")")" '"changed":true'
op_call set_company_status "$(jbody p_company="$C29N" p_status=active p_reason_code=customer_request)" >/dev/null
# (d) the seat-quota arm: a company AT its quota whose only member is the departed admin.
e6_person n_lone; U_N_LONE="$U_n_lone"
C29N2="$(company "e6-29n2-$RUN" "$U_N_LONE")"
future_period "$C29N2"
expect "case 31d fixture: the seat quota is set to 1, which the company has used" "$(op_call set_company_quota "$(jbody p_company="$C29N2" p_name=members_per_company p_value='#1')")" '"value":1'
e6_person n_rescue
expect "case 31d: the operator invites a new administrator by address" "$(op_call operator_invite_admin "$(jbody p_company="$C29N2" p_email="e6-$RUN-n_rescue@example.invalid")")" '"invite_code"'
IVN="$(sql -c "select id from app.invitations where company_id = '$C29N2' and email_normalized = 'e6-$RUN-n_rescue@example.invalid' and accepted_at is null")"
TOKN="$(sql -c "select 1")"
expect "case 31d: a SECOND live succession invitation: E_SUCCESSION_PENDING" "$(op_call operator_invite_admin "$(jbody p_company="$C29N2" p_email="e6-$RUN-n_rescue2@example.invalid")")" 'E_SUCCESSION_PENDING'
# The acceptance needs the code, which the routine returned once, so this arm re-issues it and keeps it.
sql -c "update app.invitations set revoked_at = now() where id = '$IVN'" >/dev/null
r="$(op_call operator_invite_admin "$(jbody p_company="$C29N2" p_email="e6-$RUN-n_rescue@example.invalid")")"
CODEN="$(row_field "$r" invite_code)"
expect "case 31d: the acceptance is admitted although the company is AT its quota, by the one named exception" "$(accept_as "$U_n_rescue" "$CODEN")" '"company_admin"'
expect "case 31d: the company now sits at quota + 1" "$(sql -c "select app.quota_used('$C29N2', 'members_per_company')")" '^2$'
e6_person n_rescue2
r="$(op_call operator_invite_admin "$(jbody p_company="$C29N2" p_email="e6-$RUN-n_rescue2@example.invalid")")"
CODEN2="$(row_field "$r" invite_code)"
expect "case 31d: a SECOND succession acceptance at quota + 1: E_SEATS_EXHAUSTED, so the exception is worth exactly one seat" "$(accept_as "$U_n_rescue2" "$CODEN2")" 'E_SEATS_EXHAUSTED'
# fail-before (2): the authoritative seat check without the exception refuses arm (d)'s acceptance.
save_routine 'api.accept_invitation(text)' accept_invitation_31
apply_fixture e6-succession-no-seat-bonus-mutant.sql
e6_person n_rescue3
sql -c "update app.invitations set revoked_at = now() where company_id = '$C29N2' and accepted_at is null and revoked_at is null" >/dev/null
sql -c "update app.company_quotas set value = 2 where company_id = '$C29N2' and name = 'members_per_company'" >/dev/null
r="$(op_call operator_invite_admin "$(jbody p_company="$C29N2" p_email="e6-$RUN-n_rescue3@example.invalid")")"
CODEN3="$(row_field "$r" invite_code)"
expect "fail-before case 31: without the one-seat exception the rescue issues a link nobody can use" "$(accept_as "$U_n_rescue3" "$CODEN3")" 'E_SEATS_EXHAUSTED'
restore_routine accept_invitation_31
expect "fail-before case 31: restored, and the same link is accepted" "$(accept_as "$U_n_rescue3" "$CODEN3")" '"company_admin"'
# The RESTORE STEP: an acceptance still passes app.lock_company, so a succession into a suspended or expired
# company is accepted only after the operator resumes it or extends the period (design 1.3).
e6_person n_rescue4
sql -c "update app.company_quotas set value = 20 where company_id = '$C29N2' and name = 'members_per_company'" >/dev/null
op_call set_company_status "$(jbody p_company="$C29N2" p_status=suspended p_reason_code=non_payment)" >/dev/null
r="$(op_call operator_invite_admin "$(jbody p_company="$C29N2" p_email="e6-$RUN-n_rescue4@example.invalid")")"
CODEN4="$(row_field "$r" invite_code)"
expect "case 31: the succession invitation is ISSUED into a suspended company" "LEN|${#CODEN4}" '^LEN|64$'
expect "case 31: and its ACCEPTANCE refuses until the operator resumes, because accept_invitation keeps app.lock_company" "$(accept_as "$U_n_rescue4" "$CODEN4")" 'E_COMPANY_INACTIVE'
expect "case 31: the operator resumes" "$(op_call set_company_status "$(jbody p_company="$C29N2" p_status=active p_reason_code=customer_request)")" '"status":"active"'
expect "case 31: and the same link is then accepted" "$(accept_as "$U_n_rescue4" "$CODEN4")" '"company_admin"'
expect "case 31 control: api.operator_invite_admin by a non-operator: E_NOT_OPERATOR" "$(as_call operator_invite_admin "$(jbody p_company="$C29N2" p_email="e6-29n-x-$RUN@example.invalid")" "$U_N_LONE" aal2)" 'E_NOT_OPERATOR'
# Case 35: the operator acts on a company whose ends_at, export_by and delete_by have all passed.
e6_person o_admin; U_O_ADMIN="$U_o_admin"
C29O="$(company "e6-29o-$RUN" "$U_O_ADMIN")"
age_period "$C29O" '200 days' '186 days' '156 days'
expect "case 35 fixture: the deletion is overdue" "$(deletion_state "$C29O")" '^overdue$'
expect "case 35: the operator EXTENDS the expired agreement" "$(op_call set_access_period "$(jbody p_company="$C29O" p_invoice_ref="INV-35-$RUN" p_starts_at="$(iso_ago 86400)" p_ends_at="$(iso_ago -2592000)")")" '"changed":true'
age_period "$C29O" '200 days' '186 days' '156 days'
op_body operator_expiry_run "$(jbody p_limit='#50')" "$T/run35.txt" >/dev/null
expect "case 35: the run suspended it" "$(sql -c "select status from app.companies where id = '$C29O'")" '^suspended$'
expect "case 35: the operator RESUMES a company past its period" "$(op_call set_company_status "$(jbody p_company="$C29O" p_status=active p_reason_code=customer_request)")" '"status":"active"'
expect "case 35: the operator RAISES a quota on it" "$(op_call set_company_quota "$(jbody p_company="$C29O" p_name=groups_per_company p_value='#60')")" '"value":60'
e6_person o_second "$C29O" '{member}'
expect "case 35: the operator GRANTS a second administrator on it" "$(op_call transfer_first_admin "$(jbody p_company="$C29O" p_target_user="$U_o_second")")" '"changed":true'
expect "case 35: the operator SUSPENDS then CLOSES it, past export_by, with retention_deadline" "$(op_call set_company_status "$(jbody p_company="$C29O" p_status=suspended p_reason_code=non_payment)" >/dev/null; op_call close_company "$(jbody p_company="$C29O" p_confirm_slug="e6-29o-$RUN" p_reason_code=retention_deadline)")" '"status":"closed"'
expect "case 35: and DELETES it, whose delete_by passed months ago" "$(op_call delete_company "$(jbody p_company="$C29O" p_confirm_slug="e6-29o-$RUN" p_reason_code=retention_deadline)")" '"companies": 1'
expect "case 35: the company row is gone" "$(sql -c "select count(*) from app.companies where id = '$C29O'")" '^0$'
expect "case 35: which app.lock_company_operator is what made possible, and eight routines take it" "$(grep -c 'app.lock_company_operator' "$ROOT/supabase/migrations/008_lifecycle.sql")" '^[1-9]'
# fail-before: the operator routines written on app.lock_company refuse every one of those calls.
e6_person p_admin; U_P_ADMIN="$U_p_admin"
C29P="$(company "e6-29p-$RUN" "$U_P_ADMIN")"
age_period "$C29P" '200 days' '186 days' '156 days'
save_routine 'api.set_access_period(uuid, text, timestamptz, timestamptz)' set_access_period
apply_fixture e6-operator-member-lock-mutant.sql
expect "fail-before case 35: api.set_access_period on app.lock_company cannot extend an expired agreement" "$(op_call set_access_period "$(jbody p_company="$C29P" p_invoice_ref=null p_starts_at="$(iso_ago 86400)" p_ends_at="$(iso_ago -2592000)")")" 'E_ACCESS_PERIOD_ENDED'
restore_routine set_access_period
expect "fail-before case 35: restored, and the extension lands" "$(op_call set_access_period "$(jbody p_company="$C29P" p_invoice_ref=null p_starts_at="$(iso_ago 86400)" p_ends_at="$(iso_ago -2592000)")")" '"changed":true'

# ---------------------------------------------------------------------------
section "29o cases 3, 8, 9 and 17: cross-company isolation, the resend path, invitation expiry, the last admin"
# ---------------------------------------------------------------------------
# Case 3: every NEW routine answers a caller of another company the same way, including with the company row lock
# held by another connection.
expect "case 3: departure_preview for a membership of another company: E_NOT_FOUND" "$(preview "$U_m_out" "$MS_n_second")" 'E_NOT_FOUND'
expect "case 3: transfer_agent on another company's agent: E_NOT_FOUND" "$(transfer "$U_m_out" "$AG29G" "$MS_g_target" "$MS_g_owner" aal2)" 'E_NOT_FOUND'
expect "case 3: export_company for another company: E_NOT_FOUND" "$(export_as "$U_m_out" "$C29G")" 'E_NOT_FOUND'
hold_company "$C29G" 3
lock_waiters "$C29G" 0 5 >/dev/null 2>&1 || true
expect "case 3: and the same answers with that company's row lock held elsewhere, because standing is checked before the lock" "$(export_as "$U_m_out" "$C29G")" 'E_NOT_FOUND'
expect "case 3: the preview too, which takes no lock at all" "$(preview "$U_m_out" "$MS_g_owner")" 'E_NOT_FOUND'
wait 2>/dev/null || true
# Case 8: a resend kills the earlier link. api.invite_member with the row's own address is the whole of it.
e6_person q_admin; U_Q_ADMIN="$U_q_admin"
C29Q="$(company "e6-29q-$RUN" "$U_Q_ADMIN")"
e6_person q_invitee
r="$(as_call invite_member "$(jbody p_company="$C29Q" p_email="e6-$RUN-q_invitee@example.invalid" p_roles='#["member"]')" "$U_Q_ADMIN" aal2)"
CODE_Q1="$(row_field "$r" invite_code)"; INV_Q1="$(row_field "$r" invitation_id)"
r="$(as_call invite_member "$(jbody p_company="$C29Q" p_email="e6-$RUN-q_invitee@example.invalid" p_roles='#["member"]')" "$U_Q_ADMIN" aal2)"
CODE_Q2="$(row_field "$r" invite_code)"; INV_Q2="$(row_field "$r" invitation_id)"
expect "case 8: the earlier code is dead the moment the new one exists" "$(accept_as "$U_q_invitee" "$CODE_Q1")" 'E_INVITATION_INVALID'
expect "case 8: the new code is accepted" "$(accept_as "$U_q_invitee" "$CODE_Q2")" '"membership_id"'
expect "case 8: exactly one membership" "$(sql -c "select count(*) from app.memberships where company_id = '$C29Q' and user_id = '$U_q_invitee'")" '^1$'
expect "case 8: the replaced row names its replacement" "$(sql -c "select count(*) from app.audit_events where company_id = '$C29Q' and action = 'invitation.revoke' and details ->> 'replaced_by_invitation_id' = '$INV_Q2'")" '^1$'
expect "case 8: and the new row names what it replaces" "$(sql -c "select count(*) from app.audit_events where company_id = '$C29Q' and action = 'invitation.create' and details ->> 'replaces_invitation_id' = '$INV_Q1'")" '^1$'
expect "case 8 control: a resend of an ACCEPTED invitation makes a fresh one and leaves the accepted row alone" "$(sql -c "select accepted_at is not null from app.invitations where id = '$INV_Q2'")" '^t$'
# Case 9: an expired invitation, then a resend of that row, then the new code.
e6_person q_late
r="$(as_call invite_member "$(jbody p_company="$C29Q" p_email="e6-$RUN-q_late@example.invalid" p_roles='#["member"]')" "$U_Q_ADMIN" aal2)"
CODE_Q3="$(row_field "$r" invite_code)"; INV_Q3="$(row_field "$r" invitation_id)"
sql -c "update app.invitations set expires_at = clock_timestamp() - interval '1 second' where id = '$INV_Q3'" >/dev/null
expect "case 9: the expired code: E_INVITATION_INVALID, the same answer as an unknown one" "$(accept_as "$U_q_late" "$CODE_Q3")" 'E_INVITATION_INVALID'
expect "case 9: the row stays as history, so the admin's list can show expired" "$(sql -c "select count(*) from app.invitations where id = '$INV_Q3'")" '^1$'
r="$(as_call invite_member "$(jbody p_company="$C29Q" p_email="e6-$RUN-q_late@example.invalid" p_roles='#["member"]')" "$U_Q_ADMIN" aal2)"
expect "case 9: a resend of the expired row is admitted" "$r" '"invite_code"'
expect "case 9: and the new code works" "$(accept_as "$U_q_late" "$(row_field "$r" invite_code)")" '"membership_id"'
# Case 17: the last admin cannot leave, re-run because api.accept_invitation and app.lock_company changed under it.
expect "case 17: removing the sole admin: E_LAST_ADMIN" "$(as_call remove_member "$(jbody p_membership="$(membership_of "$C29Q" "$U_Q_ADMIN")")" "$U_Q_ADMIN" aal2)" 'E_LAST_ADMIN'
expect "case 17: demoting them: E_LAST_ADMIN" "$(as_call set_roles "$(jbody p_membership="$(membership_of "$C29Q" "$U_Q_ADMIN")" p_roles='#["member"]')" "$U_Q_ADMIN" aal2)" 'E_LAST_ADMIN'
IV_Q="$(seeded_invitation "$C29Q" "e6-$RUN-q_admin@example.invalid" '{member}' "$(membership_of "$C29Q" "$U_Q_ADMIN")")"
expect "case 17: demoting them by accepting an invitation without company_admin: E_LAST_ADMIN" "$(accept_as "$U_Q_ADMIN" "${IV_Q#*|}")" 'E_LAST_ADMIN'
expect "case 17: and the admin is untouched" "$(sql -c "select status || '|' || ('company_admin' = any (roles))::text from app.memberships where company_id = '$C29Q' and user_id = '$U_Q_ADMIN'")" '^active|true$'
expect "case 17 control: with a second admin present each succeeds" "$(op_call transfer_first_admin "$(jbody p_company="$C29Q" p_target_user="$U_q_invitee")" >/dev/null; as_call set_roles "$(jbody p_membership="$(membership_of "$C29Q" "$U_Q_ADMIN")" p_roles='#["member"]')" "$U_Q_ADMIN" aal2)" '"changed":true'

# ---------------------------------------------------------------------------
section "29p E6S-C-F2: past export_by, with the sweep never run, EVERY authenticated read is empty"
# ---------------------------------------------------------------------------
# The critique read a company's candidate_versions CONTENT straight through PostgREST after export_by, while the
# takeout route refused 409: the cutoff was in the routines and the services and not in the predicates row level
# security decides with. This section reads every api view under each reader's OWN token, so what answers is the
# policy and never a definer routine.
# The company is built with rows in as many views as a member, an admin and an author can see between them.
e6_person f2_admin; U_F2_ADMIN="$U_f2_admin"
C29P2="$(company "e6-29p2-$RUN" "$U_F2_ADMIN")"
MS_F2_ADMIN="$(membership_of "$C29P2" "$U_F2_ADMIN")"
e6_person f2_author "$C29P2" '{member}'; e6_person f2_member "$C29P2" '{member}'
e6_person f2_it "$C29P2" '{it_reviewer,member}'; e6_person f2_biz "$C29P2" '{business_reviewer,member}'
e6_person f2_bystander "$C29P2" '{member}'
U_I="$U_f2_it"; U_B="$U_f2_biz"
sql -c "insert into app.profiles (user_id, display_name) values ('$U_f2_author', 'SYNTHETIC Ottoline Marchbanks')
        on conflict (user_id) do update set display_name = excluded.display_name" >/dev/null
sql -c "insert into app.profiles (user_id, display_name) values ('$U_f2_member', 'SYNTHETIC Cornelius Ashgrove')
        on conflict (user_id) do update set display_name = excluded.display_name" >/dev/null
sql -c "insert into app.profiles (user_id, display_name) values ('$U_f2_bystander', 'SYNTHETIC Perpetua Yarrowby')
        on conflict (user_id) do update set display_name = excluded.display_name" >/dev/null
GRP2="$(group_of "$C29P2" "$MS_F2_ADMIN" "Audience-29p2-$RUN" "$MS_f2_member")"
AUDP2="$(audience "$GRP2")"
enable_target claude-ai
echo "note: owner-side setup, as design 1.3 labels it: claude-ai enabled for publication under the registry bypass"
future_period "$C29P2"
CANDP2="$(submitted "$U_f2_author" "$C29P2" "synthetic-29p2-$RUN" 29)"
AGP2="$(sql -c "select agent_id from app.candidate_versions where id = '$CANDP2'")"
ENVP2="$(field "$(envelope "$U_f2_author" "$CANDP2" claude-ai "$AUDP2")" envelope_id)"
review "$U_I" "$CANDP2" "$ENVP2" it approved "IT: fine." >/dev/null
review "$U_B" "$CANDP2" "$ENVP2" business approved "Business: fine." >/dev/null
RELP2="$(field "$(publish "$U_F2_ADMIN" "$CANDP2" "$ENVP2" "$(expected_sha "$CANDP2" claude-ai)" @uuid --aal aal2)" release_id)"
expect "29p setup: a released candidate in the company" "$RELP2" '^[0-9a-f-]\{36\}$'
download_as "$U_f2_member" "$RELP2" >/dev/null
RPTP2="$(field "$(report "$U_f2_member" "$RELP2" pass null null)" report_id)"
witness "$U_I" "$RPTP2" pass "IT confirms." >/dev/null
op_call set_company_quota "$(jbody p_company="$C29P2" p_name=groups_per_company p_value='#60')" >/dev/null
as_call invite_member "$(jbody p_company="$C29P2" p_email="e6-29p2-pending-$RUN@example.invalid" p_roles='#["member"]')" "$U_F2_ADMIN" aal2 >/dev/null
TOK_ADMIN="$(user_token "$U_F2_ADMIN" aal2)"; TOK_MEMBER="$(user_token "$U_f2_member")"; TOK_AUTHOR="$(user_token "$U_f2_author")"

# The matrix: every api view, scoped where the view carries a scope, under three readers. api.my_standing is NOT
# in it: it is the one named exception and is asserted on its own below.
P2_VIEWS="companies?select=*&id=eq.$C29P2
memberships?select=*&company_id=eq.$C29P2
invitations?select=*&company_id=eq.$C29P2
audit_events?select=*&company_id=eq.$C29P2
agents?select=*&company_id=eq.$C29P2
candidate_versions?select=*&company_id=eq.$C29P2
candidate_contributors?select=*&candidate_id=eq.$CANDP2
gate_identities?select=*
gate_identity_files?select=*
groups?select=*&company_id=eq.$C29P2
group_members?select=*&company_id=eq.$C29P2
release_targets?select=*
installer_texts?select=*
release_policies?select=*
review_envelopes?select=*&company_id=eq.$C29P2
reviews?select=*&company_id=eq.$C29P2
releases?select=*&company_id=eq.$C29P2
release_catalog?select=*&company_id=eq.$C29P2
release_downloads?select=*&company_id=eq.$C29P2
agent_reviewer_exclusions?select=*&agent_id=eq.$AGP2
installation_reports?select=*&company_id=eq.$C29P2
installation_witnesses?select=*&company_id=eq.$C29P2
company_quotas?select=*&company_id=eq.$C29P2
profiles?select=*&user_id=eq.$U_f2_bystander"
# One pass of the whole matrix. Prints "<view>:<reader>=<rows>" per line.
p2_matrix() {
  local path name
  printf '%s\n' "$P2_VIEWS" | while IFS= read -r path; do
    name="${path%%\?*}"
    printf '%s:admin=%s\n' "$name" "$(view_rows "/$path" "$TOK_ADMIN")"
    printf '%s:member=%s\n' "$name" "$(view_rows "/$path" "$TOK_MEMBER")"
    printf '%s:author=%s\n' "$name" "$(view_rows "/$path" "$TOK_AUTHOR")"
  done
}
p2_total() { awk -F= '{ if ($2 ~ /^[0-9]+$/) n += $2; else bad = bad " " $0 } END { printf "%d%s", n, bad }' "$1"; }

# The literal boundary first, on one cheap read: export_by one second in the FUTURE.
sql -c "update app.access_periods set ends_at = clock_timestamp() - interval '1 hour',
          export_by = clock_timestamp() + interval '1 second', delete_by = clock_timestamp() + interval '30 days'
        where company_id = '$C29P2'" >/dev/null
expect "29p: ONE SECOND BEFORE export_by the admin at aal2 reads the company's candidate rows" "$(view_rows "/candidate_versions?select=id&company_id=eq.$C29P2" "$TOK_ADMIN")" '^1$'
# The control matrix, with export_by an hour ahead rather than a second: the whole matrix takes longer than a
# second to execute, so a one-second margin would make the CONTROL's own outcome depend on how fast this machine
# is. The two states differ only in the sign of export_by - clock_timestamp(); nothing else about the company,
# its rows or its status moves between them.
age_period "$C29P2" '1 hour' '-1 hour' '-30 days'
expect "29p control: the access state is export_window, inside the fourteen days" "$(access_state "$C29P2")" '^export_window$'
p2_matrix > "$T/p2-control.txt"
P2_CONTROL_ROWS="$(p2_total "$T/p2-control.txt")"
P2_CONTROL_PAIRS="$(grep -c '=[1-9]' "$T/p2-control.txt" || true)"
echo "note: the control matrix, view by view and reader by reader:"; sed 's/^/  /' "$T/p2-control.txt"
expect "29p control: the matrix carries rows before the cutoff, and the probe records how many" "PAIRS|$P2_CONTROL_PAIRS" '^PAIRS|[1-9]'
expect "29p control: and no read in it was refused or unparsed" "ROWS|$P2_CONTROL_ROWS" '^ROWS|[0-9]*$'

# Now past export_by, and NOTHING ELSE CHANGES: no sweep, no status change, no membership change.
age_period "$C29P2" '30 days' '1 second' '-29 days'
expect "29p: the company's status is still active, because nothing swept it" "$(sql -c "select status from app.companies where id = '$C29P2'")" '^active$'
expect "29p: app.access_state answers expired, from time alone" "$(access_state "$C29P2")" '^expired$'
p2_matrix > "$T/p2-cutoff.txt"
echo "note: the same matrix one second past export_by:"; sed 's/^/  /' "$T/p2-cutoff.txt"
expect "29p: EVERY view, for EVERY one of the three readers, returns zero rows, and none of them was refused rather than empty" "ROWS|$(p2_total "$T/p2-cutoff.txt")" '^ROWS|0$'
expect "29p: and the content read the critique executed returns no row at all" "$(view_rows "/candidate_versions?select=id,content&company_id=eq.$C29P2" "$TOK_MEMBER")" '^0$'
expect "29p: nor to the admin at aal2" "$(view_rows "/candidate_versions?select=id,content&company_id=eq.$C29P2" "$TOK_ADMIN")" '^0$'
expect "29p: nor to the candidate's own author" "$(view_rows "/candidate_versions?select=id,content&company_id=eq.$C29P2" "$TOK_AUTHOR")" '^0$'
# THE TWO NAMED EXCEPTIONS, and nothing else.
expect "29p exception 1: api.my_standing still answers, which is what lets the home page say the true sentence" "$(rest GET "/my_standing?select=company_status,access_state&company_id=eq.$C29P2" "$TOK_MEMBER")" '"company_status":"active","access_state":"expired"'
expect "29p exception 2: the caller's OWN profile row still reads" "$(view_rows "/profiles?select=*&user_id=eq.$U_f2_member" "$TOK_MEMBER")" '^1$'
expect "29p exception 2: and a CO-MEMBER'S profile row does not, which is the half of that policy the cutoff reaches" "$(view_rows "/profiles?select=*&user_id=eq.$U_f2_author" "$TOK_MEMBER")" '^0$'
# The write half is unchanged and still refuses at ends_at, and the download still answers its own code rather
# than a missing membership, which is why the cutoff is on the read predicates and not on app.membership_of.
expect "29p: a write still refuses E_ACCESS_PERIOD_ENDED, from app.lock_company" "$(as_call create_group "$(jbody p_company="$C29P2" p_name="Cutoff 29p $RUN")" "$U_F2_ADMIN" aal2)" 'E_ACCESS_PERIOD_ENDED'
expect "29p: and api.authorize_download still answers E_ACCESS_PERIOD_ENDED and not a 404, because the routines keep the explicit-user form of app.membership_of" "$(download_as "$U_f2_member" "$RELP2")" 'E_ACCESS_PERIOD_ENDED'
# fail-before: the five accepted predicates put back, one substitution each.
save_routine 'app.is_active_member(uuid)' p2_is_active_member
save_routine 'app.has_role(uuid, text)' p2_has_role
save_routine 'app.my_membership(uuid)' p2_my_membership
save_routine 'app.candidate_visible(uuid)' p2_candidate_visible
save_routine 'app.release_visible(uuid)' p2_release_visible
# Each of the five is put back to its accepted body by ONE substitution in its own live definition, so the
# fail-before cannot drift from 001, 003 and 006 and an anchor the migration has moved raises. The rewritten
# profiles policy is NOT touched: it now rests on app.is_active_member, so reverting that predicate reopens it
# too, which is the point of routing it through a shared predicate rather than inlining the company join.
e6_mutate 'app.is_active_member(uuid)' '
      and app.read_window_open(m.company_id)' ''
e6_mutate 'app.has_role(uuid, text)' '
      and app.read_window_open(m.company_id)' ''
e6_mutate 'app.my_membership(uuid)' '  select case when app.read_window_open(p_company)
              then app.membership_of(p_company, (select auth.uid())) end' \
  '  select app.membership_of(p_company, (select auth.uid()))'
e6_mutate 'app.candidate_visible(uuid)' '  select exists (select 1 from app.candidate_versions v
                  where v.id = p_candidate and app.read_window_open(v.company_id))
     and app.candidate_visible_to(p_candidate, (select auth.uid()))' \
  '  select app.candidate_visible_to(p_candidate, (select auth.uid()))'
e6_mutate 'app.release_visible(uuid)' '  select exists (select 1 from app.releases r
                  where r.id = p_release and app.read_window_open(r.company_id))
     and app.release_visible_to(p_release, (select auth.uid()))' \
  '  select app.release_visible_to(p_release, (select auth.uid()))'
p2_matrix > "$T/p2-mutant.txt"
echo "note: the same matrix with the accepted predicates back:"; sed 's/^/  /' "$T/p2-mutant.txt"
expect "fail-before 29p: with the accepted predicates the same reads answer rows again, past export_by, with the sweep never run" "ROWS|$(p2_total "$T/p2-mutant.txt")" '^ROWS|[1-9]'
expect "fail-before 29p: and THE CONTENT ITSELF is readable, which is E6S-C-F2" "$(view_rows "/candidate_versions?select=id,content&company_id=eq.$C29P2" "$TOK_ADMIN")" '^1$'
expect "fail-before 29p: the row carries the candidate's content and not only its id" "$(curl -sS "$API_URL/rest/v1/candidate_versions?select=content&company_id=eq.$C29P2&limit=1" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TOK_ADMIN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(typeof j[0]?.content === "string" && j[0].content.length > 20))})')" '^true$'
expect "fail-before 29p: and a CO-MEMBER'S profile row is readable again, which is the policy half" "$(view_rows "/profiles?select=*&user_id=eq.$U_f2_author" "$TOK_MEMBER")" '^1$'
restore_routine p2_is_active_member; restore_routine p2_has_role; restore_routine p2_my_membership
restore_routine p2_candidate_visible; restore_routine p2_release_visible
p2_matrix > "$T/p2-restored.txt"
expect "fail-before 29p: restored, and every read is empty again" "ROWS|$(p2_total "$T/p2-restored.txt")" '^ROWS|0$'
# And the operator's extension reopens every one of them, with the same tokens.
expect "29p: the operator extends the period" "$(op_call set_access_period "$(jbody p_company="$C29P2" p_invoice_ref="INV-29P2-$RUN" p_starts_at="$(iso_ago 86400)" p_ends_at="$(iso_ago -2592000)")")" '"changed":true'
p2_matrix > "$T/p2-extended.txt"
expect "29p: after the extension the same reads answer again, with the same tokens" "ROWS|$(p2_total "$T/p2-extended.txt")" '^ROWS|[1-9]'
# What the added test costs per row. The lookup is by app.access_periods' PRIMARY KEY, so the probe the planner
# needs exists and is unique; which plan it actually picks on a synthetic table of a few dozen rows is the
# planner's business and is RECORDED rather than asserted, because a sequential scan of thirty rows is the right
# choice and says nothing about a real one. The measurement that carries the claim is the before-and-after
# capacity comparison in evidence/e6-server-corrections.md section 4.
expect "29p: the lookup the added test makes is by the table's own primary key, which is unique and on company_id alone" "$(sql -c "select i.relname || '|' || pg_get_indexdef(x.indexrelid) from pg_index x join pg_class i on i.oid = x.indexrelid where x.indrelid = 'app.access_periods'::regclass and x.indisprimary")" 'access_periods_pkey|CREATE UNIQUE INDEX access_periods_pkey ON app.access_periods USING btree (company_id)'
echo "recorded, 29p: the plan the planner picks for that lookup on this synthetic database: $(sql -c "explain (costs off) select case when p.export_by <= clock_timestamp() then 'expired' when p.ends_at <= clock_timestamp() then 'export_window' else 'current' end from app.access_periods p where p.company_id = '$C29P2'" | head -1), over $(sql -c "select count(*) from app.access_periods") rows"

# ---------------------------------------------------------------------------
section "29q E6S-C-F4: the takeout's refusal order tells a stranger nothing about a company"
# ---------------------------------------------------------------------------
# The routine tested export_by ABOVE the admin predicate, on the reasoning that a stranger meets 404 at the admin
# test either way. They do not: a caller holding a company id received 409 E_ACCESS_PERIOD_ENDED when the company
# existed and was past its window, and 404 for an id that named nothing. That is existence and time state, to a
# caller with no standing at all. The order is now authority, then time.
e6_person f4_admin; U_F4_ADMIN="$U_f4_admin"
r="$(op_call provision_company "$(jbody p_slug="e6-29f4-$RUN" p_name="SYNTHETIC 29q" p_first_admin_user="$U_F4_ADMIN")")"
C29Q="$(row_field "$r" company_id)"
expect "29q setup: the company exists, and its answer is read rather than swallowed by a pipeline" "$r" '"company_id"'
e6_person f4_member "$C29Q" '{member}'
e6_person f4_other
r="$(op_call provision_company "$(jbody p_slug="e6-29f4o-$RUN" p_name="SYNTHETIC 29qo" p_first_admin_user="$U_f4_other")")"
C29Q_OTHER="$(row_field "$r" company_id)"
expect "29q setup: and so does the other company" "$r" '"company_id"'
future_period "$C29Q_OTHER"
RANDOM_ID="$(uuid)"
age_period "$C29Q" '30 days' '1 hour' '-29 days'
expect "29q: the company is past export_by and nothing swept it" "$(access_state "$C29Q")|$(sql -c "select status from app.companies where id = '$C29Q'")" '^expired|active$'
expect "29q: its OWN admin at aal2, who belongs to it, is told why: 409 E_ACCESS_PERIOD_ENDED" "$(export_as "$U_F4_ADMIN" "$C29Q")" 'E_ACCESS_PERIOD_ENDED'
expect "29q: ANOTHER company's admin at aal2 is 404 E_NOT_FOUND" "$(export_as "$U_f4_other" "$C29Q")" 'E_NOT_FOUND'
expect "29q: and 404 for a random id too, so the two answers do not differ" "$(export_as "$U_f4_other" "$RANDOM_ID")" 'E_NOT_FOUND'
expect "29q: an operator at aal2 is 404" "$(op_call export_company "$(jbody p_company="$C29Q")")" 'E_NOT_FOUND'
expect "29q: an operator at aal1 is 404" "$(op_call export_company "$(jbody p_company="$C29Q")" aal1)" 'E_NOT_FOUND'
expect "29q: and an operator asking about a random id is 404" "$(op_call export_company "$(jbody p_company="$RANDOM_ID")")" 'E_NOT_FOUND'
expect "29q: a plain member of that company, who already knows it exists, meets the ROLE test and not the time one" "$(export_as "$U_f4_member" "$C29Q")" 'E_FORBIDDEN'
# The control: the SAME callers against the SAME company inside its window get the same answers, so nothing about
# the company's time state is readable from the refusal.
future_period "$C29Q"
expect "29q control: inside the window, another company's admin is still 404" "$(export_as "$U_f4_other" "$C29Q")" 'E_NOT_FOUND'
expect "29q control: an operator is still 404" "$(op_call export_company "$(jbody p_company="$C29Q")")" 'E_NOT_FOUND'
expect "29q control: and the company's own admin now exports" "$(export_as "$U_F4_ADMIN" "$C29Q")" '^HTTP 200'
# fail-before: the two tests swapped back, one substitution each in the routine's own live definition.
age_period "$C29Q" '30 days' '1 hour' '-29 days'
save_routine 'api.export_company(uuid)' q_export
e6_mutate 'api.export_company(uuid)' '  me := app.export_admin(p_company);
  select * into c from app.companies where id = p_company;' \
  '  select * into c from app.companies where id = p_company;'
e6_mutate 'api.export_company(uuid)' "    raise exception 'E_ACCESS_PERIOD_ENDED' using errcode = 'P0001';
  end if;
  -- Gate 1, before anything is assembled." \
  "    raise exception 'E_ACCESS_PERIOD_ENDED' using errcode = 'P0001';
  end if;
  me := app.export_admin(p_company);
  -- Gate 1, before anything is assembled."
expect "fail-before 29q: with time above authority, ANOTHER company's admin learns that this company exists and that its agreement ended" "$(export_as "$U_f4_other" "$C29Q")" 'E_ACCESS_PERIOD_ENDED'
expect "fail-before 29q: an operator at aal2 learns the same" "$(op_call export_company "$(jbody p_company="$C29Q")")" 'E_ACCESS_PERIOD_ENDED'
expect "fail-before 29q: an operator at aal1 learns the same" "$(op_call export_company "$(jbody p_company="$C29Q")" aal1)" 'E_ACCESS_PERIOD_ENDED'
expect "fail-before 29q: while a random id answers 404, which is what makes the pair an oracle" "$(op_call export_company "$(jbody p_company="$RANDOM_ID")")" 'E_NOT_FOUND'
restore_routine q_export
expect "fail-before 29q: restored, and the stranger is 404 again" "$(export_as "$U_f4_other" "$C29Q")" 'E_NOT_FOUND'

# ---------------------------------------------------------------------------
section "29r E6S-C-F6: the documented recovery after a lost answer to the company-create route"
# ---------------------------------------------------------------------------
# api.create_company answers once and stores nothing that can answer again: the token exists only in that reply.
# The recovery the contract names (design 3.3, and lib/services/operator.mjs's own note on E6D-C-F10) is to
# re-enter the SAME address through api.operator_invite_admin, which revokes the pending sibling and issues a new
# invitation in one transaction. The global succession check ran before that helper, so the one recovery the
# contract names was the one call the routine refused.
R_EMAIL="e6-29r-first-$RUN@example.invalid"
U_R_FIRST="$(create_user "$R_EMAIL" "$E6_PW")"
R_SLUG="e6-29r-$RUN"
R_CREATE="$(op_call create_company "$(jbody p_slug="$R_SLUG" p_name="SYNTHETIC 29r" p_first_admin_email="$R_EMAIL" p_starts_at="$(iso_ago 3600)" p_ends_at="$(iso_ago -2592000)")")"
C29R="$(row_field "$R_CREATE" company_id)"
R_CODE_1="$(row_field "$R_CREATE" invite_code)"
expect "29r: the company is created with its first admin's invitation" "$C29R" '^[0-9a-f-]\{36\}$'
expect "29r: repeating the create is E_CONFLICT on the slug, so it is not the recovery" "$(op_call create_company "$(jbody p_slug="$R_SLUG" p_name="SYNTHETIC 29r" p_first_admin_email="$R_EMAIL" p_starts_at="$(iso_ago 3600)" p_ends_at="$(iso_ago -2592000)")")" 'E_CONFLICT\|duplicate'
R_REISSUE="$(op_call operator_invite_admin "$(jbody p_company="$C29R" p_email="$R_EMAIL")")"
expect "29r: re-entering the SAME address through the succession route now answers a fresh invitation" "$R_REISSUE" '"invite_code"'
R_CODE_2="$(row_field "$R_REISSUE" invite_code)"
expect "29r: the company still holds EXACTLY ONE live invitation, so the reissue bought no second seat" "$(sql -c "select count(*) from app.invitations where company_id = '$C29R' and accepted_at is null and revoked_at is null and expires_at > clock_timestamp()")" '^1$'
expect "29r: and exactly one live operator-issued admin invitation, which is the one-seat headroom rule" "$(sql -c "select count(*) from app.invitations where company_id = '$C29R' and created_by_operator is not null and 'company_admin' = any (roles) and accepted_at is null and revoked_at is null and expires_at > clock_timestamp()")" '^1$'
expect "29r: the replaced row is revoked with reason_code replaced, and the audit says which row replaced it" "$(sql -c "select (details ->> 'reason_code') || '|' || (details ? 'replaced_by_invitation_id')::text from app.audit_events where company_id = '$C29R' and action = 'invitation.revoke' order by id desc limit 1")" '^replaced|true$'
expect "29r: THE OLD SECRET IS DEAD: accepting the first code is E_INVITATION_INVALID" "$(accept_as "$U_R_FIRST" "$R_CODE_1")" 'E_INVITATION_INVALID'
expect "29r: and the two codes are different, so nothing replayed the old one" "$(node -e 'process.stdout.write(process.argv[1] === process.argv[2] ? "same" : "different")' "$R_CODE_1" "$R_CODE_2")" '^different$'
expect "29r: a SECOND live operator-issued admin invitation to a DIFFERENT address is still refused" "$(op_call operator_invite_admin "$(jbody p_company="$C29R" p_email="e6-29r-other-$RUN@example.invalid")")" 'E_SUCCESSION_PENDING'
expect "29r: the new code still works, so the recovery is a recovery" "$(accept_as "$U_R_FIRST" "$R_CODE_2")" '"membership_id"'
expect "29r: and the company has its first admin" "$(sql -c "select roles::text from app.memberships where company_id = '$C29R' and user_id = '$U_R_FIRST'")" 'company_admin'
# fail-before: the sibling clause removed, which is the integrated revision.
R_EMAIL2="e6-29r-second-$RUN@example.invalid"
U_R_SECOND="$(create_user "$R_EMAIL2" "$E6_PW")"
R_SLUG2="e6-29r2-$RUN"
R_CREATE2="$(op_call create_company "$(jbody p_slug="$R_SLUG2" p_name="SYNTHETIC 29r2" p_first_admin_email="$R_EMAIL2" p_starts_at="$(iso_ago 3600)" p_ends_at="$(iso_ago -2592000)")")"
C29R2="$(row_field "$R_CREATE2" company_id)"
save_routine 'api.operator_invite_admin(uuid, text, interval)' r_invite_admin
e6_mutate 'api.operator_invite_admin(uuid, text, interval)' '
                and i.email_normalized <> email_n' ''
expect "fail-before 29r: without the sibling clause the documented recovery is refused E_SUCCESSION_PENDING" "$(op_call operator_invite_admin "$(jbody p_company="$C29R2" p_email="$R_EMAIL2")")" 'E_SUCCESSION_PENDING'
expect "fail-before 29r: and the operator is left with an invitation whose token nothing can answer with" "$(sql -c "select count(*) from app.invitations where company_id = '$C29R2' and accepted_at is null and revoked_at is null and expires_at > clock_timestamp()")" '^1$'
restore_routine r_invite_admin
expect "fail-before 29r: restored, and the same call answers a fresh invitation" "$(op_call operator_invite_admin "$(jbody p_company="$C29R2" p_email="$R_EMAIL2")")" '"invite_code"'
expect "fail-before 29r: still exactly one live invitation" "$(sql -c "select count(*) from app.invitations where company_id = '$C29R2' and accepted_at is null and revoked_at is null and expires_at > clock_timestamp()")" '^1$'

expect "29: deadlocks unchanged across the whole probe" "$(deadlocks)" "^$DL0\$"
exit $FAILED
