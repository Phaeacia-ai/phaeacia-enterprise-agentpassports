#!/usr/bin/env bash
# Probe 27: the two evidence routines at the routine level (docs/e5/design.md 1.4, 1.5, 1.6, 1.7, 3.3, 3.5; section 5
# cases 14, 15, 16, 17, 18, 21, 27, 28 and 29).
#   27a case 14: a recipient reports twice, both rows kept; the twenty-first report is refused
#   27b case 15: a report without a download, and by a member outside the audience
#   27c case 18 and E5D-C-F9: losses required for partial and fail; whitespace-only losses is E_BODY_INVALID from the
#       reused validator, not E_LOSSES_REQUIRED
#   27d case 16: a witness by each caller class, the second report, the repeat, the eleventh
#   27e case 17: the witness role is frozen at the moment of witnessing
#   27f case 21: the derived check-in state at thirteen days twenty-three hours, at fourteen days, cleared by a report,
#       and unmoved by a later download; fail-before with the rule computed from the last authorization
#   27g case 27: a founder_run report is the migration's alone
#   27h case 28: a withdrawal leaves every report and witness byte-identical
#   27i case 29: offboarding leaves the rows and closes the reads; app_maintenance reads and writes neither
#   27j the claim protocol on both routines: a replay is the stored answer, another operation is a conflict
# Every bound call is built by lib/db/server.mjs (tests/db/e4.mjs). Run: bash tests/db/27-installation-evidence.sh
# (after tests/db/00-seed.sh and the probes before it).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
source "$ROOT/tests/db/e5-lib.sh"
RUN="$(run_id)"; T="$E2_TMP/27"; mkdir -p "$T"
DL0="$(deadlocks)"
person() {
  local uid ms
  uid="$(create_user "e5-27-$RUN-$(printf '%s' "$1" | tr 'A-Z_' 'a-z-')@example.invalid" "$E4_PW")"
  ms="$(member "$2" "$uid" "$3")"
  eval "U_$1=$uid; MS_$1=$ms"
}
env_of() { field "$(envelope "$@")" envelope_id; }
publish_sub() { publish "$1" "$2" "$3" "$(expected_sha "$2" "$4")" @uuid --aal aal2; }
approve_both() {
  expect "IT approves $2" "$(review "$U_I" "$1" "$2" it approved "IT: fine.")" 'HTTP 200'
  expect "business approves $2" "$(review "$U_B" "$1" "$2" business approved "Business: fine.")" 'HTTP 200'
}
released() { # author name revision target: prints candidate|agent|release
  local c e r a pr
  c="$(submitted "$1" "$G" "$2" "$3")"
  a="$(sql -c "select agent_id from app.candidate_versions where id = '$c'")"
  e="$(env_of "$1" "$c" "$4" "$AUD")"
  approve_both "$c" "$e" >&2
  pr="$(publish_sub "$U_A" "$c" "$e" "$4")"
  r="$(field "$pr" release_id)"
  [ -n "$r" ] || printf 'released: publish refused: %s\n' "$(printf '%s' "$pr" | head -c 300)" >&2
  printf '%s|%s|%s' "$c" "$a" "$r"
}
snap() { sql -c "select (select count(*) from app.installation_reports) || '|' || (select count(*) from app.installation_witnesses) || '|' || (select count(*) from app.audit_events)"; }
refused() { # label pattern command...
  local before r
  before="$(snap)"
  r="$("${@:3}")"
  expect "$1" "$r" "$2"
  expect "$1: nothing written" "$(snap)" "^$before\$"
}
code_of() {
  if printf '%s' "$1" | grep -q '^HTTP 2'; then printf 'ok'; return 0; fi
  printf '%s' "$1" | sed -n 's/.*"message":"\(E_[A-Z_]*\).*/\1/p' | head -1
}
report_id_of() { field "$1" report_id; }
# The check-in state as lib/rules/installations.mjs computes it, over the ledger and the reports this database holds.
check_in_state() { # release membership
  sql -c "select case
            when (select min(d.authorized_at) from app.release_downloads d
                   where d.release_id = '$1' and d.membership_id = '$2') is null then 'no-authorization'
            when exists (select 1 from app.installation_reports p
                          where p.release_id = '$1' and p.membership_id = '$2') then 'cleared'
            when (select min(d.authorized_at) from app.release_downloads d
                   where d.release_id = '$1' and d.membership_id = '$2') + app.check_in_interval()
                 <= clock_timestamp() then 'due'
            else 'not-due' end"
}

section "27 setup: company G (admin A, author M, IT I, business B, owner O, recipients P and Q, outsider S), company H"
U_A="$(create_user "e5-27-$RUN-a@example.invalid" "$E4_PW")"; G="$(company "e5-27g-$RUN" "$U_A")"; MS_A="$(membership_of "$G" "$U_A")"
U_HA="$(create_user "e5-27-$RUN-ha@example.invalid" "$E4_PW")"; H="$(company "e5-27h-$RUN" "$U_HA")"
person M "$G" '{member}'
person I "$G" '{it_reviewer,member}'
person B "$G" '{business_reviewer,member}'
person O "$G" '{member}'
person P "$G" '{member}'
person Q "$G" '{member}'
person S "$G" '{member}'
person R "$G" '{member}'
GR="$(group_of "$G" "$MS_A" "Audience-$RUN" "$MS_P" "$MS_Q" "$MS_R")"
AUD="$(audience "$GR")"
enable_target claude-ai
echo "note: owner-side setup, as design 1.3 labels it: claude-ai enabled for publication under the registry bypass"
REL="$(released "$U_M" "c27-$RUN" 27 claude-ai)"; IFS='|' read -r C27 AG27 R27 <<< "$REL"
expect "setup: a released candidate" "$R27" '^[0-9a-f-]\{36\}$'
sql -c "update app.agents set owner_membership_id = '$MS_O' where id = '$AG27'" >/dev/null
echo "note: owner-side, the agent's owner becomes O, who is neither author, reviewer nor admin (E6's transfer is the route)"
expect "P downloads it" "$(code_of "$(download_as "$U_P" "$R27")")" '^ok$'

section "27a case 14: a recipient reports twice, and the twenty-first is refused"
r="$(report "$U_P" "$R27" partial "The calendar read is unavailable on this plan." "The owner supplied the folder path by chat.")"
expect "case 14: the first report, partial with losses" "$r" '"status": *"partial"'
RPT1="$(report_id_of "$r")"
expect "case 14: it carries the server-set source, and the caller chose no source" "$(sql -c "select source from app.installation_reports where id = '$RPT1'")" '^recipient_app$'
r="$(report "$U_P" "$R27" pass null null)"
expect "case 14: a second report a day later, pass, with no losses" "$r" '"status": *"pass"'
RPT2="$(report_id_of "$r")"
expect "case 14: both rows are kept and both are readable" "$(sql -c "select count(*) from app.installation_reports where release_id = '$R27' and membership_id = '$MS_P'")|$(view_as "$(member_jwt "$U_P")" installation_reports "release_id=eq.$R27&select=id" | grep -c "$RPT1")" '^2|1$'
for i in $(seq 3 20); do report "$U_P" "$R27" pass null null >/dev/null; done
expect "case 14: twenty reports" "$(sql -c "select count(*) from app.installation_reports where release_id = '$R27' and membership_id = '$MS_P'")" '^20$'
refused "case 14: the twenty-first: 409 E_REPORT_LIMIT" 'E_REPORT_LIMIT' report "$U_P" "$R27" pass null null

section "27b case 15: a report needs a download of its own"
refused "case 15: Q, in the audience but with no download: 409 E_NOT_DOWNLOADED" 'E_NOT_DOWNLOADED' report "$U_Q" "$R27" pass null null
refused "case 15: S, outside the audience and with no download: 404 E_NOT_FOUND" 'E_NOT_FOUND' report "$U_S" "$R27" pass null null
expect "case 15 control: after one download, Q reports" "$(code_of "$(download_as "$U_Q" "$R27")")|$(report "$U_Q" "$R27" pass null null | cut -c1-8)" '^ok|HTTP 200$'
expect "case 15: no route reports for anybody else, so a report's membership is always its bearer's" "$(sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.proname = 'report_installation' and pg_get_function_arguments(p.oid) like '%membership%'")" '^0$'

section "27c case 18 and E5D-C-F9: losses required, and the whitespace rule"
REL="$(released "$U_M" "c18-$RUN" 18 claude-ai)"; IFS='|' read -r C18 AG18 R18 <<< "$REL"
expect "P downloads it" "$(code_of "$(download_as "$U_P" "$R18")")" '^ok$'
refused "case 18: partial with losses null: 422 E_LOSSES_REQUIRED" 'E_LOSSES_REQUIRED' report "$U_P" "$R18" partial null null
refused "case 18: fail with losses null: 422 E_LOSSES_REQUIRED" 'E_LOSSES_REQUIRED' report "$U_P" "$R18" fail null null
refused "case 18 and E5D-C-F9: partial with whitespace-only losses: 422 E_BODY_INVALID from the reused validator" 'E_BODY_INVALID' report "$U_P" "$R18" partial "   " null
expect "case 18: pass and removed with losses null are accepted" "$(report "$U_P" "$R18" pass null null | cut -c1-8)|$(report "$U_P" "$R18" removed null null | cut -c1-8)" '^HTTP 200|HTTP 200$'
expect "case 18 control: partial with one code point of losses" "$(report "$U_P" "$R18" partial "x" null | cut -c1-8)" '^HTTP 200$'
refused "case 18: a status outside the vocabulary: 422 E_BODY_INVALID" 'E_BODY_INVALID' report "$U_P" "$R18" verified null null
refused "case 18: losses of 2,001 code points: 422 E_BODY_INVALID" 'E_BODY_INVALID' report "$U_P" "$R18" partial "$(node -e 'process.stdout.write("x".repeat(2001))')" null
expect "case 18 control: losses of exactly 2,000 code points" "$(report "$U_P" "$R18" partial "$(node -e 'process.stdout.write("x".repeat(2000))')" null | cut -c1-8)" '^HTTP 200$'

section "27d case 16: who may witness"
# Design 3.5 puts the role test (row 19) above the recipient test (row 20), and both below the visibility test
# (row 18), so the three refusals reach three different callers: a plain member who cannot read the report meets 404; a
# plain member who is its recipient meets E_ROLE_REQUIRED; and E_WITNESS_IS_RECIPIENT is reachable only by a caller who
# holds a reviewer or admin role and is the recipient. The design's case 16 reads the second and third the other way
# round; evidence/e5-server.md proposes that correction.
RPT16="$(report_id_of "$(report "$U_P" "$R18" partial "A second statement to witness." null)")"
expect "a report by P, a plain member, to witness" "$RPT16" '^[0-9a-f-]\{36\}$'
RPT16B="$(report_id_of "$(report "$U_Q" "$R27" partial "A second recipient statement." null)")"
expect "a report by Q on the other release, whose agent O owns" "$RPT16B" '^[0-9a-f-]\{36\}$'
refused "case 16: a plain member who cannot read the report: 404 E_NOT_FOUND before any role test" 'E_NOT_FOUND' witness "$U_S" "$RPT16" pass "Not mine to see."
refused "case 16: a plain member who is its recipient: 403 E_ROLE_REQUIRED (the role test is row 19, above row 20)" 'E_ROLE_REQUIRED' witness "$U_P" "$RPT16" pass "My own."
refused "case 16: the agent owner, who reads the report and holds no reviewer or admin role: 403 E_ROLE_REQUIRED" 'E_ROLE_REQUIRED' witness "$U_O" "$RPT16B" pass "Owner."
refused "case 16: another company admin: 404 E_NOT_FOUND" 'E_NOT_FOUND' witness "$U_HA" "$RPT16" pass "Outsider."
expect "case 16: an it_reviewer, at aal1 (no aal claim)" "$(witness "$U_I" "$RPT16" partial "Confirmed on her machine; the calendar tool is off for the plan." | cut -c1-8)" '^HTTP 200$'
expect "case 16: a business_reviewer at aal1" "$(witness "$U_B" "$RPT16" partial "Business confirms the same." | cut -c1-8)" '^HTTP 200$'
expect "case 16: an admin at aal1" "$(witness "$U_A" "$RPT16" partial "Admin confirms." @uuid --aal aal1 | cut -c1-8)" '^HTTP 200$'
refused "case 16: the same reviewer again on the same report: 409 E_ALREADY_WITNESSED" 'E_ALREADY_WITNESSED' witness "$U_I" "$RPT16" pass "Second thoughts."
expect "case 16: three witnesses, each naming the role it held" "$(sql -c "select string_agg(witness_role, ',' order by witness_role) from app.installation_witnesses where report_id = '$RPT16'")" '^business_reviewer,company_admin,it_reviewer$'
expect "case 16 control: the same reviewer on a second report, at aal2" "$(witness "$U_I" "$RPT16B" pass "Also fine." @uuid --aal aal2 | cut -c1-8)" '^HTTP 200$'
# A reviewer who is the recipient of the report they try to witness: the one caller class that reaches row 20. The
# reviewer joins the audience through the route first, because a reviewer role does not put anybody in an audience.
rest POST /rpc/add_group_member "$(server_jwt "$U_A" aal2)" "$(jbody p_group="$GR" p_membership="$MS_I")" >/dev/null
expect "an it_reviewer downloads and reports on their own account" "$(code_of "$(download_as "$U_I" "$R18")")|$(report "$U_I" "$R18" pass null null | cut -c1-8)" '^ok|HTTP 200$'
RPT16C="$(sql -c "select id from app.installation_reports where release_id = '$R18' and membership_id = '$MS_I' limit 1")"
refused "case 16: a reviewer witnessing their own report: 403 E_WITNESS_IS_RECIPIENT" 'E_WITNESS_IS_RECIPIENT' witness "$U_I" "$RPT16C" pass "My own statement."
expect "case 16 control: another reviewer may witness that same report" "$(witness "$U_B" "$RPT16C" pass "Confirmed for the reviewer." | cut -c1-8)" '^HTTP 200$'
for i in 4 5 6 7 8 9 10; do
  U="$(create_user "e5-27-$RUN-w$i@example.invalid" "$E4_PW")"
  member "$G" "$U" '{it_reviewer,member}' >/dev/null
  witness "$U" "$RPT16" pass "Witness $i." >/dev/null
done
expect "case 16: ten witnesses of one report" "$(sql -c "select count(*) from app.installation_witnesses where report_id = '$RPT16'")" '^10$'
U11="$(create_user "e5-27-$RUN-w11@example.invalid" "$E4_PW")"; member "$G" "$U11" '{it_reviewer,member}' >/dev/null
refused "case 16: an eleventh: 409 E_WITNESS_LIMIT" 'E_WITNESS_LIMIT' witness "$U11" "$RPT16" pass "One too many."

section "27e case 17: the witness role is frozen at the moment"
RPT17="$(report_id_of "$(report "$U_P" "$R18" pass null null)")"
U17="$(create_user "e5-27-$RUN-r17@example.invalid" "$E4_PW")"; MS_17="$(member "$G" "$U17" '{it_reviewer,member}')"
rest POST /rpc/add_group_member "$(server_jwt "$U_A" aal2)" "$(jbody p_group="$GR" p_membership="$MS_17")" >/dev/null
expect "R17 downloads and makes a report of their own, which they keep reading after any role change" "$(code_of "$(download_as "$U17" "$R18")")|$(report "$U17" "$R18" pass null null | cut -c1-8)" '^ok|HTTP 200$'
RPT17B="$(sql -c "select id from app.installation_reports where release_id = '$R18' and membership_id = '$MS_17' limit 1")"
expect "R17 witnesses P's report as an it_reviewer" "$(witness "$U17" "$RPT17" pass "Confirmed." | cut -c1-8)" '^HTTP 200$'
expect "the admin removes R17 it_reviewer role" "$(rest POST /rpc/set_roles "$(server_jwt "$U_A" aal2)" "$(jbody p_membership="$MS_17" p_roles='#["member"]')")" '"changed":true'
expect "case 17: the stored witness_role is still it_reviewer" "$(sql -c "select witness_role from app.installation_witnesses where report_id = '$RPT17' and witness_membership_id = '$MS_17'")" '^it_reviewer$'
# The control reads a report R17 can still see after the role is gone, which is their own, so the refusal is the role
# test (row 19) and not the visibility test (row 18).
refused "case 17 control: R17 witnessing after the removal, on a report they still read: 403 E_ROLE_REQUIRED" 'E_ROLE_REQUIRED' witness "$U17" "$RPT17B" pass "After the removal."

section "27f case 21: the check-in at day fourteen exactly"
REL="$(released "$U_M" "c21-$RUN" 21 claude-ai)"; IFS='|' read -r C21 AG21 R21 <<< "$REL"
expect "P downloads it" "$(code_of "$(download_as "$U_P" "$R21")")" '^ok$'
age_ledger "$R21" "$MS_P" "13 days 23 hours"
expect "case 21: at thirteen days and twenty-three hours: not due" "$(check_in_state "$R21" "$MS_P")" '^not-due$'
age_ledger "$R21" "$MS_P" "1 hour"
expect "case 21: at fourteen days exactly: due" "$(check_in_state "$R21" "$MS_P")" '^due$'
expect "case 21: and the due moment is the first authorization plus app.check_in_interval()" "$(sql -c "select (min(authorized_at) + app.check_in_interval()) <= clock_timestamp() from app.release_downloads where release_id = '$R21' and membership_id = '$MS_P'")" '^t$'
expect "case 21: a report clears it, whatever its status" "$(report "$U_P" "$R21" fail "Nothing came across." null | cut -c1-8)|$(check_in_state "$R21" "$MS_P")" '^HTTP 200|cleared$'
expect "case 21: a later download does not reopen it, and the first authorization is still the old one" "$(code_of "$(download_as "$U_P" "$R21")")|$(check_in_state "$R21" "$MS_P")|$(sql -c "select (min(authorized_at) + app.check_in_interval()) <= clock_timestamp() from app.release_downloads where release_id = '$R21' and membership_id = '$MS_P'")" '^ok|cleared|t$'
expect "case 21 fail-before: the rule computed from the LAST authorization is not due after the re-download, so the pair could never come due again" "$(sql -c "select case when (select max(d.authorized_at) from app.release_downloads d where d.release_id = '$R21' and d.membership_id = '$MS_P') + app.check_in_interval() <= clock_timestamp() then 'due' else 'not-due' end")" '^not-due$'

section "27g case 27: a founder_run report is the migration's alone"
r="$(rest POST /rpc/report_installation "$(server_jwt "$U_P")" "$(jbody p_release="$R21" p_status=pass p_losses=null p_assistance=null p_source=founder_run p_idempotency_key="$(uuid)")")"
expect "case 27: a call carrying p_source matches no signature: PGRST202" "$r" 'PGRST202'
expect "case 27: an insert with source founder_run outside the bypass is refused by app.report_identity" "$(in_rollback "insert into app.installation_reports (company_id, release_id, membership_id, status, source) values ('$G', '$R21', '$MS_P', 'pass', 'founder_run');")" 'E_FORBIDDEN'
expect "case 27: the same insert under the registry bypass is accepted, and its source is founder_run" "$(in_rollback "set local app.registry_migration = 'on';" "insert into app.installation_reports (company_id, release_id, membership_id, status, source) values ('$G', '$R21', '$MS_P', 'pass', 'founder_run') returning 'FOUNDER|' || source;")" 'FOUNDER|founder_run'
expect "case 27 control: a report through the route carries recipient_app" "$(sql -c "select distinct source from app.installation_reports where release_id = '$R21'")" '^recipient_app$'

section "27h case 28: a withdrawal leaves the evidence alone"
BEFORE28="$(sql -c "select md5((select coalesce(json_agg(p order by p.id)::text, '') from app.installation_reports p where p.release_id = '$R18') || (select coalesce(json_agg(w order by w.id)::text, '') from app.installation_witnesses w where w.release_id = '$R18'))")"
r="$(withdraw "$U_A" "$R18" "Probe 27 withdrawal." @uuid --aal aal2)"
expect "case 28: the withdrawal answers revokesCopies false with its recipients" "$r" '"revokes_copies": *false'
expect "case 28: every report and witness of that release is byte-identical" "$(sql -c "select md5((select coalesce(json_agg(p order by p.id)::text, '') from app.installation_reports p where p.release_id = '$R18') || (select coalesce(json_agg(w order by w.id)::text, '') from app.installation_witnesses w where w.release_id = '$R18'))")" "^$BEFORE28\$"
expect "case 28: a removed report after the withdrawal, which is what the removal checklist asks for" "$(report "$U_P" "$R18" removed null null | cut -c1-8)" '^HTTP 200$'
expect "case 28: and the withdrawal answer's shape is E4's, with no new key" "$(printf '%s' "$r" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf(" ",5)+1));process.stdout.write(Object.keys(j).sort().join(","))})')" '^assembled_bytes,assembled_sha256,agent_id\|agent_id,assembled_bytes'

section "27i case 29: offboarding"
expect "R downloads and reports" "$(code_of "$(download_as "$U_R" "$R27")")|$(report "$U_R" "$R27" pass null null | cut -c1-8)" '^ok|HTTP 200$'
BEFORE29="$(sql -c "select count(*) from app.installation_reports where membership_id = '$MS_R'")|$(sql -c "select count(*) from app.release_downloads where membership_id = '$MS_R'")"
expect "the admin removes R" "$(rest POST /rpc/remove_member "$(server_jwt "$U_A" aal2)" "$(jbody p_membership="$MS_R")")" '"changed":true'
expect "case 29: the counts are unchanged" "$(sql -c "select count(*) from app.installation_reports where membership_id = '$MS_R'")|$(sql -c "select count(*) from app.release_downloads where membership_id = '$MS_R'")" "^$BEFORE29\$"
refused "case 29: and the removed member reports nothing more" 'E_NOT_FOUND' report "$U_R" "$R27" pass null null
expect "case 29: their own reads are closed" "$(view_as "$(member_jwt "$U_R")" installation_reports "select=id")" 'HTTP 200 \[\]'

section "27j the claim protocol on both routines"
KEY="$(uuid)"
r="$(report "$U_Q" "$R27" pass null null "$KEY" --save "$T/rep")"
expect "a first report with a fixed key" "$r" '"status": *"pass"'
expect "case 3.3: the same key replayed is the stored answer with idempotentReplay" "$(E4 replay "$T/rep")" '"idempotent_replay": *true'
expect "and no second row: Q's two earlier reports plus this one, and no fourth" "$(sql -c "select count(*) from app.installation_reports where release_id = '$R27' and membership_id = '$MS_Q'")" '^3$'
refused "case 3.3: the same key with another operation: 409 E_IDEMPOTENCY_CONFLICT" 'E_IDEMPOTENCY_CONFLICT' report "$U_Q" "$R27" fail "Different words." null "$KEY"
KEYW="$(uuid)"
r="$(witness "$U_B" "$RPT16B" pass "A witness with a fixed key." "$KEYW" --save "$T/wit")"
expect "a first witness with a fixed key" "$r" '"witness_id"'
expect "case 3.3: replayed" "$(E4 replay "$T/wit")" '"idempotent_replay": *true'
refused "case 3.3: the same key with another note: 409 E_IDEMPOTENCY_CONFLICT" 'E_IDEMPOTENCY_CONFLICT' witness "$U_B" "$RPT16B" pass "Other words." "$KEYW"

expect "deadlocks unchanged" "$(deadlocks)" "^$DL0\$"
[ "$FAILED" = 0 ] && echo "27 PASS" || { echo "27 FAIL"; exit 1; }
