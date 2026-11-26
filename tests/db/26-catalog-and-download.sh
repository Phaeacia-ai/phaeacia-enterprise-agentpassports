#!/usr/bin/env bash
# Probe 26: the catalog predicate and api.authorize_download at the routine level (docs/e5/design.md 1.1, 1.2, 1.3, 1.6,
# 2.3, 3.5; section 5 cases 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 23 and 24's database arms).
#   26a cases 3 and 4: the dynamic audience, added after publication, removed, re-added
#   26b case 7 supersession, case 8 the target register, case 9 an orphaned and an archived agent
#   26c case 10 and E5D-C-F1: a caller who could never see the release is told E_NOT_FOUND, not the state code
#   26d case 11 and E5D-C-F2: repeat authorizations, the two-hundredth, and the catalog agreeing about exhaustion
#   26e case 12: frozen assembly, no bytes and no hash of the caller's choosing
#   26f case 13: every catalog row's blockedReason is what the download answers, both directions; fail-before against a
#       view whose blocked_reason is a second hand-written copy of the predicate missing the target check
#   26g case 23: the two evidence tables and the ledger are append-only for every role
#   26h case 24's fail-before: app.download_refusal_for written security invoker makes every catalog row 42501, which is
#       the shape of E4S-F1, and the control is the same read with the accepted definer body
#   26i case 5: a removed membership reads nothing and authorizes nothing, and its rows are untouched
# Every bound call is built by lib/db/server.mjs (tests/db/e4.mjs); every download goes through PostgREST under that
# member's own unbound server bearer. Run: bash tests/db/26-catalog-and-download.sh (after tests/db/00-seed.sh and the
# probes before it).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
source "$ROOT/tests/db/e5-lib.sh"
RUN="$(run_id)"; T="$E2_TMP/26"; mkdir -p "$T"
DL0="$(deadlocks)"
person() {
  local uid ms
  uid="$(create_user "e5-26-$RUN-$(printf '%s' "$1" | tr 'A-Z_' 'a-z-')@example.invalid" "$E4_PW")"
  ms="$(member "$2" "$uid" "$3")"
  eval "U_$1=$uid; MS_$1=$ms"
}
env_of() { field "$(envelope "$@")" envelope_id; }
publish_sub() { publish "$1" "$2" "$3" "$(expected_sha "$2" "$4")" @uuid --aal aal2; }
approve_both() {
  expect "IT approves $2" "$(review "$U_I" "$1" "$2" it approved "IT: fine.")" 'HTTP 200'
  expect "business approves $2" "$(review "$U_B" "$1" "$2" business approved "Business: fine.")" 'HTTP 200'
}
# released author name revision target [audience]: prints candidate|agent|release.
released() {
  local c e r a
  c="$(submitted "$1" "$G" "$2" "$3")"
  a="$(sql -c "select agent_id from app.candidate_versions where id = '$c'")"
  e="$(env_of "$1" "$c" "$4" "${5:-$AUD}")"
  approve_both "$c" "$e" >&2
  local pr
  pr="$(publish_sub "$U_A" "$c" "$e" "$4")"
  r="$(field "$pr" release_id)"
  [ -n "$r" ] || printf 'released: publish refused: %s\n' "$(printf '%s' "$pr" | head -c 300)" >&2
  printf '%s|%s|%s' "$c" "$a" "$r"
}
snap() { sql -c "select (select count(*) from app.release_downloads) || '|' || (select count(*) from app.installation_reports) || '|' || (select count(*) from app.installation_witnesses) || '|' || (select count(*) from app.audit_events)"; }
# refused label pattern command...: the answer matches, and no ledger, report, witness or audit row was written.
refused() {
  local before r
  before="$(snap)"
  r="$("${@:3}")"
  expect "$1" "$r" "$2"
  expect "$1: nothing written" "$(snap)" "^$before\$"
}
# The E_ code of a refused answer, or `ok` for a 2xx. The marker is a word rather than the empty string because
# grep cannot match an empty subject, so an empty expectation would pass on any failure (E5S lesson, probe 26).
code_of() {
  if printf '%s' "$1" | grep -q '^HTTP 2'; then printf 'ok'; return 0; fi
  printf '%s' "$1" | sed -n 's/.*"message":"\(E_[A-Z_]*\).*/\1/p' | head -1
}

section "26 setup: company G (admin A, author M, IT I, business B, recipients P and Q, outsider S), company H; groups; claude-ai enabled"
U_A="$(create_user "e5-26-$RUN-a@example.invalid" "$E4_PW")"; G="$(company "e5-26g-$RUN" "$U_A")"; MS_A="$(membership_of "$G" "$U_A")"
U_HA="$(create_user "e5-26-$RUN-ha@example.invalid" "$E4_PW")"; H="$(company "e5-26h-$RUN" "$U_HA")"
person M "$G" '{member}'
person I "$G" '{it_reviewer,member}'
person B "$G" '{business_reviewer,member}'
person P "$G" '{member}'
person Q "$G" '{member}'
person S "$G" '{member}'
person R "$G" '{member}'
GR="$(group_of "$G" "$MS_A" "Audience-$RUN" "$MS_P")"; GR2="$(group_of "$G" "$MS_A" "Later-$RUN")"
AUD="$(audience "$GR")"
enable_target claude-ai
echo "note: owner-side setup, as design 1.3 labels it: claude-ai enabled for publication under the registry bypass"
JWT_P="$(member_jwt "$U_P")"; JWT_Q="$(member_jwt "$U_Q")"; JWT_S="$(member_jwt "$U_S")"; JWT_A="$(member_jwt "$U_A")"

section "26a cases 3 and 4: the dynamic audience"
REL="$(released "$U_M" "c3-$RUN" 3 claude-ai)"; IFS='|' read -r C3 AG3 R3 <<< "$REL"
expect "case 3: before the group add, a member of no bound group: 404 E_NOT_FOUND" "$(code_of "$(download_as "$U_Q" "$R3")")" '^E_NOT_FOUND$'
expect "case 3: and the release is not in Q's catalog at all" "$(view_as "$JWT_Q" release_catalog "id=eq.$R3&select=id")" 'HTTP 200 \[\]'
expect "the admin adds Q to the bound group through the route" "$(rest POST /rpc/add_group_member "$(server_jwt "$U_A" aal2)" "$(jbody p_group="$GR" p_membership="$MS_Q")")" '"changed":true'
expect "case 3: Q, now a member of the bound group, downloads" "$(download_as "$U_Q" "$R3" | head -c 12)" '^HTTP 200'
expect "case 3: one ledger row for Q, and no new envelope and no new review" "$(ledger_count "$R3" "$MS_Q")|$(sql -c "select count(*) from app.review_envelopes where candidate_id = '$C3'")|$(sql -c "select count(*) from app.reviews where candidate_id = '$C3'")" '^1|1|2$'
expect "case 4: the row is in Q's catalog, downloadable, with Q's own summary" "$(view_as "$JWT_Q" release_catalog "id=eq.$R3&select=id,blocked_reason,my_authorizations" | tr -d ' ')" '"blocked_reason":null.*"authorizations":1'
expect "the admin removes Q from the group" "$(rest POST /rpc/remove_group_member "$(server_jwt "$U_A" aal2)" "$(jbody p_group="$GR" p_membership="$MS_Q")")" '"changed":true'
refused "case 4: the next download is 404 E_NOT_FOUND" 'E_NOT_FOUND' download_as "$U_Q" "$R3"
expect "case 4 and E5D-C-F4: the release stays in Q's catalog through the own-ledger arm, blocked E_NOT_FOUND" "$(view_as "$JWT_Q" release_catalog "id=eq.$R3&select=id,blocked_reason")" '"blocked_reason":"E_NOT_FOUND"'
rest POST /rpc/add_group_member "$(server_jwt "$U_A" aal2)" "$(jbody p_group="$GR" p_membership="$MS_Q")" >/dev/null
expect "case 4 control: re-added to the group, Q downloads again and the row is downloadable" "$(code_of "$(download_as "$U_Q" "$R3")")|$(view_as "$JWT_Q" release_catalog "id=eq.$R3&select=blocked_reason")" '^ok|.*"blocked_reason":null'
rest POST /rpc/remove_group_member "$(server_jwt "$U_A" aal2)" "$(jbody p_group="$GR" p_membership="$MS_Q")" >/dev/null

section "26b cases 7, 8 and 9: supersession, the target register, the agent's owner"
REL="$(released "$U_M" "c7-$RUN" 7 claude-ai)"; IFS='|' read -r C7 AG7 R7 <<< "$REL"
expect "a first download of the current release" "$(code_of "$(download_as "$U_P" "$R7")")" '^ok$'
r="$(draft_by_id "$U_M" "$G" "$AG7" 71)"; C7B="$(field "$r" candidate_id)"; submit "$U_M" "$C7B" 1 71 >/dev/null
E7B="$(env_of "$U_M" "$C7B" claude-ai "$AUD")"; approve_both "$C7B" "$E7B"
R7B="$(field "$(publish_sub "$U_A" "$C7B" "$E7B" claude-ai)" release_id)"
refused "case 7: the superseded release: 409 E_RELEASE_SUPERSEDED" 'E_RELEASE_SUPERSEDED' download_as "$U_P" "$R7"
expect "case 7 control: the current release authorizes" "$(code_of "$(download_as "$U_P" "$R7B")")" '^ok$'
expect "case 7: the catalog agrees about both rows" "$(view_as "$JWT_P" release_catalog "id=in.($R7,$R7B)&select=id,blocked_reason&order=id.asc" | grep -o '"blocked_reason":"\{0,1\}[A-Z_a-z]*"\{0,1\}' | sort | tr '\n' ' ')" 'E_RELEASE_SUPERSEDED.*blocked_reason":null\|blocked_reason":null.*E_RELEASE_SUPERSEDED'
sql -c "begin; set local app.registry_migration = 'on'; update app.release_targets set publishable = false where target = 'claude-ai'; commit;" >/dev/null
echo "note: owner-side, claude-ai disabled after publication, which is design 1.3's second case"
refused "case 8: the release exists and the target is disabled: 409 E_TARGET_NOT_PUBLISHABLE" 'E_TARGET_NOT_PUBLISHABLE' download_as "$U_P" "$R7B"
expect "case 8: the catalog still lists the row with that reason, not hidden" "$(view_as "$JWT_P" release_catalog "id=eq.$R7B&select=id,blocked_reason")" '"blocked_reason":"E_TARGET_NOT_PUBLISHABLE"'
enable_target claude-ai
expect "case 8 control: enabled again, the download authorizes and the reason is null" "$(code_of "$(download_as "$U_P" "$R7B")")|$(view_as "$JWT_P" release_catalog "id=eq.$R7B&select=blocked_reason")" '^ok|.*"blocked_reason":null'
sql -c "update app.agents set status = 'orphaned' where id = '$AG7'" >/dev/null
echo "note: owner-side, the agent is orphaned (api.remove_member is the route that reaches this state)"
refused "case 9: an orphaned agent: 409 E_AGENT_ORPHANED" 'E_AGENT_ORPHANED' download_as "$U_P" "$R7B"
expect "case 9: and the catalog carries the same code" "$(view_as "$JWT_P" release_catalog "id=eq.$R7B&select=blocked_reason")" '"blocked_reason":"E_AGENT_ORPHANED"'
sql -c "update app.agents set status = 'archived' where id = '$AG7'" >/dev/null
refused "case 9: an archived agent: 409 E_AGENT_ARCHIVED" 'E_AGENT_ARCHIVED' download_as "$U_P" "$R7B"
sql -c "update app.agents set status = 'active' where id = '$AG7'" >/dev/null
expect "case 9 control: the agent restored to active, the download authorizes" "$(code_of "$(download_as "$U_P" "$R7B")")" '^ok$'

section "26c case 10 and E5D-C-F1: visibility decides before the state code"
REL="$(released "$U_M" "c10-$RUN" 10 claude-ai)"; IFS='|' read -r C10 AG10 R10 <<< "$REL"
expect "P, a member of the audience, downloads once so the release stays readable to P afterwards" "$(code_of "$(download_as "$U_P" "$R10")")" '^ok$'
expect "the admin withdraws it" "$(withdraw "$U_A" "$R10" "Probe 26 withdrawal." @uuid --aal aal2)" '"state": *"withdrawn"'
refused "case 10: S, who was never in the audience, is told 404 E_NOT_FOUND, not that a withdrawn release exists" 'E_NOT_FOUND' download_as "$U_S" "$R10"
expect "case 10 control: P, in the audience, is told 409 E_RELEASE_WITHDRAWN" "$(code_of "$(download_as "$U_P" "$R10")")" '^E_RELEASE_WITHDRAWN$'
REL="$(released "$U_M" "c10b-$RUN" 101 claude-ai)"; IFS='|' read -r C10B AG10B R10B <<< "$REL"
expect "P downloads the first release of a second agent" "$(code_of "$(download_as "$U_P" "$R10B")")" '^ok$'
r="$(draft_by_id "$U_M" "$G" "$AG10B" 102)"; C10C="$(field "$r" candidate_id)"; submit "$U_M" "$C10C" 1 102 >/dev/null
E10C="$(env_of "$U_M" "$C10C" claude-ai "$AUD")"; approve_both "$C10C" "$E10C"
publish_sub "$U_A" "$C10C" "$E10C" claude-ai >/dev/null
refused "case 10: S on the superseded release: 404 E_NOT_FOUND, not E_RELEASE_SUPERSEDED" 'E_NOT_FOUND' download_as "$U_S" "$R10B"
expect "case 10 control: P on the same superseded release: 409 E_RELEASE_SUPERSEDED" "$(code_of "$(download_as "$U_P" "$R10B")")" '^E_RELEASE_SUPERSEDED$'
MUT10="$(mutant 'api.authorize_download(uuid)' "    if not app.release_visible_to(p_release, actor) then
      raise exception 'E_NOT_FOUND' using errcode = 'P0002';
    end if;" "    -- E5D-C-F1 mutant: the state code is chosen before visibility is decided.")"
expect "case 10 fail-before: without the visibility test the zero-row branch tells S the release was withdrawn" "$(in_rollback "$MUT10;" "select set_config('request.jwt.claims', '{\"role\":\"app_server\",\"sub\":\"$U_S\"}', true);" "select api.authorize_download('$R10');")" 'E_RELEASE_WITHDRAWN'

section "26d case 11 and E5D-C-F2: the per-recipient ceiling"
REL="$(released "$U_M" "c11-$RUN" 11 claude-ai)"; IFS='|' read -r C11 AG11 R11 <<< "$REL"
for i in 1 2 3; do
  download_body "$U_P" "$R11" "$T/a$i" >/dev/null
  expect "case 11: authorization $i" "$(dl_field "$T/a$i" authorization.authorizations)" "^$i\$"
done
expect "case 11: three ledger rows" "$(ledger_count "$R11" "$MS_P")" '^3$'
fill_ledger "$R11" "$MS_P" 196
echo "note: owner-side, 196 further ledger rows so the two-hundredth is one request away"
download_body "$U_P" "$R11" "$T/a200" >/dev/null
expect "case 11: the two-hundredth authorization" "$(dl_field "$T/a200" authorization.authorizations)" '^200$'
refused "case 11: the two hundred and first: 409 E_DOWNLOAD_LIMIT" 'E_DOWNLOAD_LIMIT' download_as "$U_P" "$R11"
expect "case 11 and E5D-C-F2: the catalog answers the same exhaustion, so the list and the routine agree" "$(view_as "$JWT_P" release_catalog "id=eq.$R11&select=blocked_reason")" '"blocked_reason":"E_DOWNLOAD_LIMIT"'
rest POST /rpc/add_group_member "$(server_jwt "$U_A" aal2)" "$(jbody p_group="$GR" p_membership="$MS_Q")" >/dev/null
expect "case 11 control: a second member's first download of the same release, unaffected by P's ceiling" "$(code_of "$(download_as "$U_Q" "$R11")")|$(ledger_count "$R11" "$MS_Q")" '^ok|1$'

section "26e case 12: frozen assembly"
REL="$(released "$U_M" "c12-$RUN" 12 claude-ai)"; IFS='|' read -r C12 AG12 R12 <<< "$REL"
for i in 1 2 3; do download_body "$U_P" "$R12" "$T/dl$i" >/dev/null; done
H1="$(dl_assembly "$T/dl1")"; H2="$(dl_assembly "$T/dl2")"; H3="$(dl_assembly "$T/dl3")"
expect "case 12: three downloads return byte-identical bytes" "$H1|$H2" "^$H3|$H3\$"
expect "case 12: the bytes hash to the declared hash, which is the stored row's" "$H1" "^$(sql -c "select encode(assembled_sha256, 'hex') from app.releases where id = '$R12'")|$(sql -c "select encode(assembled_sha256, 'hex') from app.releases where id = '$R12'")\$"
expect "case 12: and the stored row's hash is its own bytes', by E4's trigger" "$(sql -c "select assembled_sha256 = sha256(convert_to(assembled_content, 'UTF8')) from app.releases where id = '$R12'")" '^t$'
r="$(rest POST /rpc/authorize_download "$(server_jwt "$U_P")" "$(jbody p_release="$R12" p_assembled_content=arbitrary)")"
expect "case 12: a call carrying p_assembled_content matches no signature: PGRST202" "$r" 'PGRST202'
expect "case 12: an owner-side update of the stored bytes: E_IMMUTABLE" "$(in_rollback "update app.releases set assembled_content = assembled_content || ' ' where id = '$R12';")" 'E_IMMUTABLE'

section "26f case 13: the catalog and the download agree, both directions"
DISAGREE=0
for rel in $(sql -c "select id from app.releases where company_id = '$G' order by id"); do
  say="$(view_as "$JWT_P" release_catalog "id=eq.$rel&select=blocked_reason" | sed -n 's/.*"blocked_reason":"\{0,1\}\([A-Za-z_]*\)"\{0,1\}.*/\1/p')"
  [ -n "$say" ] || continue
  did="$(code_of "$(download_as "$U_P" "$rel")")"
  [ "$say" = null ] && did_expect=ok || did_expect="$say"
  [ "$did" = "$did_expect" ] || { DISAGREE=$((DISAGREE + 1)); printf 'disagreement on %s: catalog %s, download %s\n' "$rel" "$say" "$did"; }
done
expect "case 13: every visible catalog row's blockedReason is exactly what the download answers" "$DISAGREE" '^0$'
MUTVIEW="create or replace view api.release_catalog with (security_invoker = true) as
  select r.id, r.company_id, r.agent_id, r.candidate_id, r.envelope_id, r.target, r.gate_id, r.content_sha256,
         r.derived_sha256, r.installer_text_sha256, r.core_sha256, r.branch_sha256, r.judge_sha256, r.policy_id,
         r.policy_sha256, r.audience_group_ids, r.envelope_sha256, r.assembled_sha256, r.assembled_bytes, r.state,
         r.published_by_membership_id, r.published_at, r.superseded_by_release_id, r.superseded_at,
         r.withdrawn_by_membership_id, r.withdrawn_at, r.withdrawal_reason,
         case when r.state <> 'published' then 'E_RELEASE_WITHDRAWN'
              when r.superseded_by_release_id is not null then 'E_RELEASE_SUPERSEDED'
              else null end as blocked_reason,
         app.my_authorizations(r.id) as my_authorizations,
         app.release_headline(r.id) as headline
  from app.releases r;"
VIEWDEF="$(sql -c "select pg_get_viewdef('api.release_catalog'::regclass, true)")"
sql -c "$MUTVIEW" >/dev/null
sql -c "begin; set local app.registry_migration = 'on'; update app.release_targets set publishable = false where target = 'claude-ai'; commit;" >/dev/null
echo "note: case 13's mutant view installed: blocked_reason is a second hand-written copy of the predicate missing the target check"
expect "case 13 fail-before: the mutant view calls a blocked release downloadable while the routine refuses it" "$(view_as "$JWT_P" release_catalog "id=eq.$R12&select=blocked_reason")|$(code_of "$(download_as "$U_P" "$R12")")" '"blocked_reason":null.*|E_TARGET_NOT_PUBLISHABLE'
sql -c "create or replace view api.release_catalog with (security_invoker = true) as $VIEWDEF" >/dev/null
enable_target claude-ai
expect "case 13: the accepted view is back and agrees again" "$(view_as "$JWT_P" release_catalog "id=eq.$R12&select=blocked_reason")|$(code_of "$(download_as "$U_P" "$R12")")|$(sql -c "select position('download_refusal' in pg_get_viewdef('api.release_catalog'::regclass, true)) > 0")" '"blocked_reason":null.*|ok|t$'

section "26g case 23: the ledger and the two evidence tables are append-only for every role"
expect "a report exists to try to change" "$(report "$U_P" "$R12" pass null null | cut -c1-8)" '^HTTP 200$'
RPT23="$(sql -c "select id from app.installation_reports where release_id = '$R12' and membership_id = '$MS_P' limit 1")"
expect "case 23: an owner-side update, delete and truncate of a report: E_REPORT_APPEND_ONLY each" "$(in_rollback "savepoint s; update app.installation_reports set status = 'fail' where id = '$RPT23'; rollback to savepoint s; savepoint t; delete from app.installation_reports where id = '$RPT23'; rollback to savepoint t; truncate app.installation_reports cascade;" | grep -c 'E_REPORT_APPEND_ONLY')" '^3$'
expect "case 23: a witness exists, and its update, delete and truncate: E_WITNESS_APPEND_ONLY each" "$(witness "$U_I" "$RPT23" pass "IT confirms on her machine." | cut -c1-8)|$(in_rollback "savepoint s; update app.installation_witnesses set note = 'Rewritten.' where report_id = '$RPT23'; rollback to savepoint s; savepoint t; delete from app.installation_witnesses where report_id = '$RPT23'; rollback to savepoint t; truncate app.installation_witnesses;" | grep -c 'E_WITNESS_APPEND_ONLY')" '^HTTP 200|3$'
expect "case 23: the ledger's update, delete and truncate: E_LEDGER_APPEND_ONLY each" "$(in_rollback "savepoint s; update app.release_downloads set membership_id = membership_id where release_id = '$R12'; rollback to savepoint s; savepoint t; delete from app.release_downloads where release_id = '$R12'; rollback to savepoint t; truncate app.release_downloads;" | grep -c 'E_LEDGER_APPEND_ONLY')" '^3$'
for role in anon authenticated app_server app_maintenance; do
  expect "case 23: $role cannot write either evidence table" "$(sql_try -c "begin; set local role $role; insert into app.installation_reports (company_id, release_id, membership_id, status, source) values ('$G', '$R12', '$MS_P', 'pass', 'recipient_app'); rollback;")" 'permission denied'
done
# The owner holds the role but is not a member of it in this stack, so the probe grants it inside the transaction it
# rolls back, exactly as probe 22 does for the E4 tables.
r="$(sql_try -c "begin; grant app_maintenance to postgres; set local role app_maintenance; select 'MAINT|' || (select count(*) from app.installation_reports) || '|' || (select count(*) from app.installation_witnesses); rollback;")"
expect "case 23: app_maintenance reads both evidence tables" "$r" 'MAINT|[1-9]'
r="$(sql_try -c "begin; grant app_maintenance to postgres; set local role app_maintenance; update app.installation_reports set status = 'fail' where id = '$RPT23'; rollback;")"
r2="$(sql_try -c "begin; grant app_maintenance to postgres; set local role app_maintenance; insert into app.installation_witnesses (company_id, report_id, release_id, witness_membership_id, witness_role, status, note) values ('$G', '$RPT23', '$R12', '$MS_I', 'it_reviewer', 'pass', 'x'); rollback;")"
expect "case 23: and cannot write either" "$(printf '%s\n%s\n' "$r" "$r2" | grep -c 'permission denied for table installation_')" '^2$'

section "26h case 24's fail-before: the predicate written security invoker"
expect "case 24 control: the accepted definer predicate answers P's catalog read" "$(view_as "$JWT_P" release_catalog "id=eq.$R12&select=id,blocked_reason" | head -c 12)" '^HTTP 200'
# The door is the object E4S-F1 was about: api.release_catalog is security_invoker, so it calls app.download_refusal as
# the reader, and a reader holds no USAGE on schema app. The inner two-argument predicate is reached only from inside
# the door, so making *it* invoker changes nothing a reader can see; the mutant that reproduces E4S-F1 is the door's.
expect "case 24 fail-before (E4S-F1's shape): with app.download_refusal security invoker every catalog row is refused for schema app" "$(sql -c "alter function app.download_refusal(uuid) security invoker" >/dev/null; view_as "$JWT_P" release_catalog "id=eq.$R12&select=id,blocked_reason")" 'permission denied for schema app'
sql -c "alter function app.download_refusal(uuid) security definer" >/dev/null
expect "and the accepted body restored, the same read answers again" "$(view_as "$JWT_P" release_catalog "id=eq.$R12&select=id,blocked_reason" | head -c 12)" '^HTTP 200'

section "26i case 5: a removed membership"
REL="$(released "$U_M" "c5-$RUN" 5 claude-ai)"; IFS='|' read -r C5 AG5 R5 <<< "$REL"
rest POST /rpc/add_group_member "$(server_jwt "$U_A" aal2)" "$(jbody p_group="$GR" p_membership="$MS_R")" >/dev/null
expect "R, a member of the audience, downloads and reports" "$(code_of "$(download_as "$U_R" "$R5")")|$(report "$U_R" "$R5" pass null null | cut -c1-8)" '^ok|HTTP 200$'
BEFORE5="$(sql -c "select count(*) from app.release_downloads where membership_id = '$MS_R'")|$(sql -c "select count(*) from app.installation_reports where membership_id = '$MS_R'")"
expect "the admin removes R" "$(rest POST /rpc/remove_member "$(server_jwt "$U_A" aal2)" "$(jbody p_membership="$MS_R")")" '"changed":true'
refused "case 5: the removed member's download: 404 E_NOT_FOUND" 'E_NOT_FOUND' download_as "$U_R" "$R5"
expect "case 5: and the catalog and the release are empty for them" "$(view_as "$(member_jwt "$U_R")" release_catalog "id=eq.$R5&select=id")|$(view_as "$(member_jwt "$U_R")" installation_reports "release_id=eq.$R5&select=id")" '^HTTP 200 \[\]|HTTP 200 \[\]$'
expect "case 5: every row R wrote is still there, owner-side" "$(sql -c "select count(*) from app.release_downloads where membership_id = '$MS_R'")|$(sql -c "select count(*) from app.installation_reports where membership_id = '$MS_R'")" "^$BEFORE5\$"

expect "deadlocks unchanged" "$(deadlocks)" "^$DL0\$"
[ "$FAILED" = 0 ] && echo "26 PASS" || { echo "26 FAIL"; exit 1; }
