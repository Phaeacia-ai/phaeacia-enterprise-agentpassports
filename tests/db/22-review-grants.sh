#!/usr/bin/env bash
# Probe 22: migration 006 part B's grants, row level security, audit and registers, and the retirement of the download
# seam (docs/e4/design.md 2.3 B6 and B7, 2.4, 3.1, 1.8, 2.6 item 9; section 5 cases 26, 47, 49 and 50, as E5 design 2.7
# and E5D-C-F7 move case 50 to tests/db/fixtures/e5-download-mutant.sql).
#   22a case 26: raw DML on every E4 view through PostgREST by a member's token, the anon key and the service key, and by
#       role in the catalog; EXECUTE on every E4 and group routine by the same three; app_maintenance reads and cannot
#       write; an unbound server bearer on the four bound routines; a bound E4 bearer on invite_member and create_group
#   22b design 3.1: what each reader class reads through the five E4 views; no role but the owner reads assembled_content
#   22c case 47: every E4 transition's audit row carries exactly 2.4's keys; a reason key is refused; no reason and no
#       group name in any audit row; fail-before with the guard accepting any key
#   22d case 49: the SQL splice reads app.installer_texts and reproduces the four golden hashes; the manifest gate fails
#       on one changed vendored branch byte in a mirror of HEAD and passes on the unchanged mirror
#   22e case 50, as E5 design 2.7 moves it: nothing but E5's download mutant lives in a tests schema; the retired seam
#       tests.authorize_download exists nowhere (to_regproc is null) and no code path names it; app_server and
#       authenticated cannot reach tests.authorize_download_unlocked and PostgREST refuses the schema; the real
#       api.authorize_download refuses a withdrawn, a superseded, a removed and an outside-the-audience caller; the
#       migration-text assertion that no migration creates a tests schema passes
# Every E4 call is built by tests/db/e4.mjs through lib/db/server.mjs. Run: bash tests/db/22-review-grants.sh (after
# tests/db/00-seed.sh and the probes before it).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
RUN="$(run_id)"; T="$E2_TMP/22"; mkdir -p "$T"
DL0="$(deadlocks)"

section "22e (before the harness applies the mutant) case 50: no migration has put anything in a tests schema"
expect "no function in a tests schema other than E5's two download counterexamples" "$(sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tests' and p.proname not in ('authorize_download_unlocked', 'authorize_download_unserialized')")" '^0$'
expect "the retired review seam's function exists nowhere" "$(sql -c "select count(*) from pg_proc where proname = 'request_' || 'changes'")" '^0$'
expect "the retired download seam's function exists nowhere (E5 design 2.7)" "$(sql -c "select coalesce(to_regproc('tests.' || 'authorize_download')::text, 'null')")" '^null$'

section "22 setup: company G (admin A, author M, IT I, business B, owner O, audience member P, removed R), company H (admin HA)"
U_A="$(create_user "e4-22-$RUN-a@example.invalid" "$E4_PW")"; G="$(company "e4-22g-$RUN" "$U_A")"; MS_A="$(membership_of "$G" "$U_A")"
U_HA="$(create_user "e4-22-$RUN-ha@example.invalid" "$E4_PW")"; H="$(company "e4-22h-$RUN" "$U_HA")"
U_M="$(create_user "e4-22-$RUN-m@example.invalid" "$E4_PW")"; MS_M="$(member "$G" "$U_M" '{member}')"
U_I="$(create_user "e4-22-$RUN-i@example.invalid" "$E4_PW")"; MS_I="$(member "$G" "$U_I" '{it_reviewer,member}')"
U_B="$(create_user "e4-22-$RUN-b@example.invalid" "$E4_PW")"; MS_B="$(member "$G" "$U_B" '{business_reviewer,member}')"
U_O="$(create_user "e4-22-$RUN-o@example.invalid" "$E4_PW")"; MS_O="$(member "$G" "$U_O" '{member}')"
U_P="$(create_user "e4-22-$RUN-p@example.invalid" "$E4_PW")"; MS_P="$(member "$G" "$U_P" '{member}')"
U_R="$(create_user "e4-22-$RUN-r@example.invalid" "$E4_PW")"; MS_R="$(member "$G" "$U_R" '{member}')"
M_JWT="$(user_jwt "e4-22-$RUN-m@example.invalid" "$E4_PW")"
C="$(submitted "$U_M" "$G" "grants-$RUN" 1)"
AGENT="$(sql -c "select agent_id from app.candidate_versions where id = '$C'")"
GR="$(group_of "$G" "$MS_A" "Audience-$RUN" "$MS_P" "$MS_M")"
AUD="$(audience "$GR")"
E="$(field "$(envelope "$U_M" "$C" claude-ai "$AUD")" envelope_id)"
expect "IT approves" "$(review "$U_I" "$C" "$E" it approved "MARKER-REASON-$RUN it")" 'HTTP 200'
expect "business approves" "$(review "$U_B" "$C" "$E" business approved "MARKER-REASON-$RUN business")" '"candidate_state": *"approved"'
enable_target claude-ai
echo "note: owner-side setup, labelled as design 1.8 labels it: claude-ai enabled for publication under the registry bypass"
REL="$(field "$(publish "$U_A" "$C" "$E" "$(expected_sha "$C" claude-ai)" @uuid --aal aal2)" release_id)"
download_mutant
echo "note: owner-side, tests/db/fixtures/e5-download-mutant.sql applied: case 50's grant target and probe 28's fail-before only"
expect "api.authorize_download authorizes P, an active member of the audience group" "$(authorize_download "$REL" "$MS_P")" '^authorized$'
sql -c "update app.agents set owner_membership_id = '$MS_O' where id = '$AGENT'" >/dev/null
echo "note: owner-side, the agent's owner becomes O, who is neither author nor reviewer (E6's transfer is the route)"
sql -c "update app.memberships set status = 'removed', removed_at = now() where id = '$MS_R'" >/dev/null
for v in G H C AGENT GR E REL; do eval "expect \"setup: $v is a uuid\" \"\$$v\" '^[0-9a-f-]\{36\}\$'"; done

section "22a case 26: raw DML on every E4 view through PostgREST, by a member's token, the anon key and the service key"
snap() { sql -c "select (select count(*) from app.review_envelopes) || '|' || (select count(*) from app.reviews) || '|' || (select count(*) from app.releases) || '|' || (select count(*) from app.release_downloads) || '|' || (select count(*) from app.audit_events) || '|' || (select count(*) from app.idempotency_keys)"; }
S0="$(snap)"
# api.agent_reviewer_exclusions joins a set-returning function, so it is not auto-updatable: a role that may use the
# schema is refused by the rewriter (55000, "cannot insert into view") before any privilege is consulted, and it holds
# no write privilege either (the catalog check below). Either refusal writes nothing, which the snapshot asserts.
for spec in "review_envelopes|id=eq.$E|target=generic|42501" "reviews|candidate_id=eq.$C|role=business|42501" "releases|id=eq.$REL|target=generic|42501" "release_downloads|release_id=eq.$REL|membership_id=$MS_M|42501" "agent_reviewer_exclusions|agent_id=eq.$AGENT|kind=editor|42501\|55000"; do
  view="${spec%%|*}"; rest_of="${spec#*|}"; filter="${rest_of%%|*}"; rest_of="${rest_of#*|}"; assign="${rest_of%%|*}"; want="${rest_of#*|}"
  b="$(jbody "$assign")"
  for who in member anon service; do
    case "$who" in member) tok="$M_JWT";; anon) tok="$ANON_KEY";; service) tok="$SERVICE_ROLE_KEY";; esac
    expect "$who INSERT api.$view: refused ($want)" "$(rest POST "/$view" "$tok" "$b")" "$want"
    expect "$who UPDATE api.$view: refused ($want)" "$(rest PATCH "/$view?$filter" "$tok" "$b")" "$want"
    expect "$who DELETE api.$view: refused ($want)" "$(rest DELETE "/$view?$filter" "$tok")" "$want"
  done
done
expect "by role in the catalog: anon, authenticated, app_server, service_role and app_maintenance hold no insert, update, delete or truncate on the four E4 tables or the five E4 views" "$(sql -c "select count(*) from unnest(array['anon','authenticated','app_server','service_role','app_maintenance']) r, unnest(array['app.review_envelopes','app.reviews','app.releases','app.release_downloads','api.review_envelopes','api.reviews','api.releases','api.release_downloads','api.agent_reviewer_exclusions']) t, unnest(array['insert','update','delete','truncate']) p where has_table_privilege(r, t, p)")" '^0$'
expect "authenticated selects the five views and app_maintenance the four tables" "$(sql -c "select bool_and(has_table_privilege('authenticated', t, 'select')) from unnest(array['api.review_envelopes','api.reviews','api.releases','api.release_downloads','api.agent_reviewer_exclusions']) t")|$(sql -c "select bool_and(has_table_privilege('app_maintenance', t, 'select')) from unnest(array['app.review_envelopes','app.reviews','app.releases','app.release_downloads']) t")" '^t|t$'
expect "EXECUTE on the four routines is app_server's alone" "$(sql -c "select string_agg(r || ':' || has_function_privilege(r, f, 'execute'), ',' order by r, f) from unnest(array['anon','authenticated','service_role','app_maintenance','app_server']) r, unnest(array['api.create_envelope(uuid,text,text,uuid,bytea,uuid)','api.record_review(uuid,uuid,text,text,text,bytea,uuid)','api.publish_release(uuid,uuid,bytea,bytea,uuid)','api.withdraw_release(uuid,text,uuid)']) f")" '^anon:false,anon:false,anon:false,anon:false,app_maintenance:false,app_maintenance:false,app_maintenance:false,app_maintenance:false,app_server:true,app_server:true,app_server:true,app_server:true,authenticated:false,authenticated:false,authenticated:false,authenticated:false,service_role:false,service_role:false,service_role:false,service_role:false$'
expect "each routine is SECURITY DEFINER with an empty search_path" "$(sql -c "select count(*) from pg_proc p where p.pronamespace = 'api'::regnamespace and p.proname in ('create_envelope','record_review','publish_release','withdraw_release') and p.prosecdef and p.proconfig = array['search_path=\"\"']")" '^4$'

section "22a case 26: EXECUTE by a member's token, the anon key and the service key; an unbound server bearer; a bound bearer on E2 and group routines"
b_envelope="$(E4 body create_envelope candidate_id="$C" target=claude-ai audience_canonical="$AUD" policy_id="$(active_policy)" gate_identity=@gate idempotency_key=@uuid)"
b_review="$(E4 body record_review candidate_id="$C" envelope_id="$E" role=it decision=approved reason=Again gate_identity=@gate idempotency_key=@uuid)"
b_publish="$(E4 body publish_release candidate_id="$C" envelope_id="$E" expected_assembled_sha256=@gate gate_identity=@gate idempotency_key=@uuid)"
b_withdraw="$(E4 body withdraw_release release_id="$REL" reason=Stop idempotency_key=@uuid)"
for pair in "create_envelope|$b_envelope" "record_review|$b_review" "publish_release|$b_publish" "withdraw_release|$b_withdraw"; do
  fn="${pair%%|*}"; b="${pair#*|}"
  expect "the body for api.$fn names its parameters" "$(printf '%s' "$b" | node -e 'process.stdout.write(Object.keys(JSON.parse(require("fs").readFileSync(0,"utf8"))).join(","))')" '^p_'
  expect "a member's own token on api.$fn: 42501" "$(rest POST "/rpc/$fn" "$M_JWT" "$b")" '42501'
  expect "the anon key on api.$fn: 42501" "$(rest POST "/rpc/$fn" "$ANON_KEY" "$b")" '42501'
  expect "the service key on api.$fn: 42501" "$(rest POST "/rpc/$fn" "$SERVICE_ROLE_KEY" "$b")" '42501'
  expect "an unbound server bearer on api.$fn: E_NOT_BOUND" "$(rest POST "/rpc/$fn" "$(server_jwt "$U_A" aal2)" "$b")" 'E_NOT_BOUND'
done
for pair in "create_group|$(jbody p_company="$G" p_name="Refused-$RUN")" "add_group_member|$(jbody p_group="$GR" p_membership="$MS_B")" "remove_group_member|$(jbody p_group="$GR" p_membership="$MS_P")"; do
  fn="${pair%%|*}"; b="${pair#*|}"
  expect "a member's own token on api.$fn: 42501" "$(rest POST "/rpc/$fn" "$M_JWT" "$b")" '42501'
  expect "the anon key on api.$fn: 42501" "$(rest POST "/rpc/$fn" "$ANON_KEY" "$b")" '42501'
  expect "the service key on api.$fn: 42501" "$(rest POST "/rpc/$fn" "$SERVICE_ROLE_KEY" "$b")" '42501'
done
BOUND_CLAIMS="$(node -e 'process.stdout.write(JSON.stringify({ fn: "record_review", args_sha256: "a".repeat(64), jti: require("node:crypto").randomUUID() }))')"
expect "a bearer bound to an E4 routine on api.create_group: E_NOT_SERVER" "$(rest POST /rpc/create_group "$(server_jwt "$U_A" aal2 "$BOUND_CLAIMS")" "$(jbody p_company="$G" p_name="Bound-$RUN")")" 'E_NOT_SERVER'
expect "a bearer bound to an E4 routine on api.invite_member: E_NOT_SERVER" "$(rest POST /rpc/invite_member "$(server_jwt "$U_A" aal2 "$BOUND_CLAIMS")" "$(jbody p_company="$G" p_email="bound-$RUN@example.invalid" 'p_roles=#["member"]')")" 'E_NOT_SERVER'
# As in probe 09: the migration owner is granted the maintenance role for the probe, here inside the rolled-back
# transaction, so the grant never outlives it.
r="$(sql_try -c "begin; grant app_maintenance to postgres; set local role app_maintenance; select 'MAINT|' || (select count(*) from app.releases where id = '$REL') || '|' || (select count(*) from app.release_downloads where release_id = '$REL'); update app.releases set state = 'withdrawn' where id = '$REL'; rollback;")"
expect "app_maintenance reads the release and its ledger row" "$r" 'MAINT|1|1'
expect "and its update is refused" "$r" 'permission denied for table releases'
r="$(sql_try -c "begin; grant app_maintenance to postgres; set local role app_maintenance; insert into app.release_downloads (company_id, release_id, membership_id) values ('$G', '$REL', '$MS_M'); rollback;")"
expect "app_maintenance cannot write the ledger" "$r" 'permission denied for table release_downloads'
expect "no row, no audit row and no claim from any refusal of 22a" "$(snap)" "^$S0\$"
expect "control: a correctly bound bearer succeeds (the proposal already exists, so existing is true)" "$(envelope "$U_M" "$C" claude-ai "$AUD")" '"existing": *true'

section "22b design 3.1: what each reader class reads through the E4 views (envelopes|reviews|releases|ledger|exclusion rows)"
reads_as() { sql_try -c "begin; select set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\"}', true); set local role authenticated; select 'READ|' || (select count(*) from api.review_envelopes where candidate_id = '$C') || '|' || (select count(*) from api.reviews where candidate_id = '$C') || '|' || (select count(*) from api.releases where id = '$REL') || '|' || (select count(*) from api.release_downloads where release_id = '$REL') || '|' || (select count(*) from api.agent_reviewer_exclusions where agent_id = '$AGENT'); rollback;"; }
expect "the author reads the envelope, both reviews and the release of their candidate, not the ledger" "$(reads_as "$U_M")" 'READ|1|2|1|0|2$'
expect "an IT reviewer reads all of the company's review evidence and releases, not the ledger" "$(reads_as "$U_I")" 'READ|1|2|1|0|2$'
expect "the company admin reads everything, the ledger included" "$(reads_as "$U_A")" 'READ|1|2|1|1|2$'
expect "the owner who is neither author nor reviewer reads the release and its ledger, not the envelope or the reasons (E4D-C-F4 at the database)" "$(reads_as "$U_O")" 'READ|0|0|1|1|2$'
# E5 design 1.1 and 1.8: app.release_visible_to gains the audience and own-ledger arms in migration 007, so E4 3.1's
# cell "Read releases (no assembled content): member 404" becomes "releases addressed to my groups, and releases I have
# downloaded", which is the plan's own sentence. The review evidence and the ledger are unchanged: a recipient still
# reads no envelope, no review reason and no ledger row, and their own summary comes from app.my_authorizations.
expect "an audience member without a role reads the release addressed to their group, and still no review evidence and no ledger" "$(reads_as "$U_P")" 'READ|0|0|1|0|2$'
expect "a removed member reads nothing" "$(reads_as "$U_R")" 'READ|0|0|0|0|0$'
expect "another company's admin reads nothing" "$(reads_as "$U_HA")" 'READ|0|0|0|0|0$'
# The status column, which count(*) above never evaluates: selected as each reader class, as PostgREST selects it. DOOR is
# the definer door asked directly under the same claims before the role changes, so its own guard is what answers.
status_as() { sql_try -c "begin; select set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\"}', true); ${2:-} select 'DOOR|' || coalesce(app.reader_envelope_status('$E'), 'null'); set local role authenticated; select 'STATUS|' || coalesce(string_agg(status, ','), 'none') from api.review_envelopes where candidate_id = '$C'; rollback;"; }
for pair in "$U_M:approved:approved" "$U_I:approved:approved" "$U_A:approved:approved" "$U_O:null:none" "$U_P:null:none" "$U_HA:null:none"; do
  IFS=: read -r who door status <<< "$pair"
  r="$(status_as "$who")"
  expect "the status column read through api.review_envelopes by $who: $status" "$r" "STATUS|$status\$"
  expect "the definer door under $who's claims: $door" "$r" "DOOR|$door\$"
done
expect "mutant (the door security invoker, the sketch's shape): the author's read of the status column is refused for schema app, which the author's line above refuses" "$(status_as "$U_M" "alter function app.reader_envelope_status(uuid) security invoker;")" 'permission denied for schema app'
as_admin() { printf "begin; select set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\"}', true); set local role authenticated;" "$U_A"; }
expect "the exclusion rows are membership ids and kinds only: the author and the submitter, M, read by the admin" "$(sql_try -c "$(as_admin) select 'EXCL|' || string_agg(membership_id || ':' || kind, ',' order by kind) from api.agent_reviewer_exclusions where agent_id = '$AGENT'; rollback;")" "EXCL|$MS_M:author,$MS_M:submitter\$"
expect "and a session with no request identity reads none (the door asks the membership question)" "$(sql -c "select count(*) from api.agent_reviewer_exclusions where agent_id = '$AGENT'")" '^0$'
expect "the view's columns are agent_id, membership_id and kind" "$(sql -c "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'api' and table_name = 'agent_reviewer_exclusions'")" '^agent_id,membership_id,kind$'
expect "by column in the catalog: authenticated selects assembled_sha256 and assembled_bytes of app.releases, never assembled_content" "$(sql -c "select has_column_privilege('authenticated', 'app.releases', 'assembled_content', 'select') || '|' || has_column_privilege('authenticated', 'app.releases', 'assembled_sha256', 'select') || '|' || has_column_privilege('authenticated', 'app.releases', 'assembled_bytes', 'select')")" '^false|true|true$'
expect "a request role asking api.releases for assembled_content: no such column" "$(sql_try -c "$(as_admin) select assembled_content from api.releases where id = '$REL'; rollback;")" 'column "assembled_content" does not exist'
# A view reads its table as the invoker, so a probe view over the column shows the column grant is what refuses. The
# views live only inside the rolled-back transaction.
PROBE_VIEWS="create view api.e4_probe_sha with (security_invoker = true) as select id, assembled_sha256 from app.releases; create view api.e4_probe_content with (security_invoker = true) as select id, assembled_content from app.releases; grant select on api.e4_probe_sha, api.e4_probe_content to authenticated;"
r="$(sql_try -c "begin; $PROBE_VIEWS $(as_admin | sed 's/^begin; //') select 'SHA|' || count(*) from api.e4_probe_sha where id = '$REL'; select octet_length(assembled_content) from api.e4_probe_content where id = '$REL'; rollback;")"
expect "control: through an invoker view the company admin reads assembled_sha256 of the release" "$r" 'SHA|1'
expect "no request role reads assembled_content, the company admin included: the column grant refuses" "$r" 'permission denied for table releases'
r="$(sql_try -c "begin; grant select (assembled_content) on app.releases to authenticated; $PROBE_VIEWS $(as_admin | sed 's/^begin; //') select 'CONTENT|' || count(octet_length(assembled_content)) from api.e4_probe_content where id = '$REL'; rollback;")"
expect "mutant (assembled_content granted to authenticated): the admin reads the bytes, which the line above refuses" "$r" 'CONTENT|1'
expect "and api.releases carries assembled_bytes and no assembled_content column" "$(sql -c "select string_agg(column_name, ',' order by column_name) filter (where column_name like 'assembled%') from information_schema.columns where table_schema = 'api' and table_name = 'releases'")" '^assembled_bytes,assembled_sha256$'

section "22c case 47: a second version supersedes the first, a candidate-level change request, a withdrawal by the owner; then the audit rows"
r="$(draft_by_id "$U_M" "$G" "$AGENT" 2)"; C2="$(field "$r" candidate_id)"
expect "C2 submitted" "$(submit "$U_M" "$C2" 1 2)" '"state": *"submitted"'
E2="$(field "$(envelope "$U_M" "$C2" claude-ai "$AUD")" envelope_id)"
expect "C2 IT" "$(review "$U_I" "$C2" "$E2" it approved "MARKER-REASON-$RUN c2 it")" 'HTTP 200'
expect "C2 business" "$(review "$U_B" "$C2" "$E2" business approved "MARKER-REASON-$RUN c2 business")" '"candidate_state": *"approved"'
r="$(publish "$U_A" "$C2" "$E2" "$(expected_sha "$C2" claude-ai)" @uuid --aal aal2)"; REL2="$(field "$r" release_id)"
expect "C2's release supersedes C1's and C1" "$r" "\"superseded_release_ids\": *\[\"$REL\"\].*\"superseded_candidate_ids\": *\[\"$C\"\]"
C3="$(submitted "$U_M" "$G" "grants3-$RUN" 3)"
expect "a candidate-level change request" "$(review "$U_I" "$C3" null it changes_requested "MARKER-REASON-$RUN c3")" '"candidate_state": *"changes_requested"'
expect "the owner withdraws C2's release at aal1" "$(withdraw "$U_O" "$REL2" "MARKER-REASON-$RUN withdrawn" @uuid --aal aal1)" '"revokes_copies": *false'
expect "a group created through the routine, its name a marker" "$(rest POST /rpc/create_group "$(server_jwt "$U_A" aal2)" "$(jbody p_company="$G" p_name="MARKER-GROUP-$RUN")")" '"changed":true'
KEYS="$(sql -c "select a.action || ':' || string_agg(k, ',' order by k) from app.audit_events a cross join lateral jsonb_object_keys(a.details) k where a.company_id = '$G' and a.action in ('envelope.create','review.record','release.publish','release.supersede','candidate.supersede','release.withdraw') group by a.id, a.action" | sort -u | tr '\n' ';')"
expect "each E4 action's audit rows carry exactly design 2.4's keys" "$KEYS" '^candidate.supersede:candidate_id,candidate_state_after;envelope.create:candidate_id,envelope_id,envelope_revision,envelope_sha256,gate_identity_sha256,policy_sha256,release_target;release.publish:agent_id,assembled_sha256,candidate_id,content_sha256,envelope_id,release_id,release_target;release.supersede:release_id,superseded_by_release_id;release.withdraw:recipient_count,release_id,release_state_after;review.record:candidate_id,candidate_state_after,envelope_id,review_decision,review_id,review_role;review.record:candidate_id,candidate_state_after,review_decision,review_id,review_role;$'
expect "one row per transition: 2 envelopes, 5 reviews, 2 publications, 1 supersession of a release and of a candidate, 1 withdrawal" "$(sql -c "select string_agg(action || '=' || n, ',' order by action) from (select action, count(*) n from app.audit_events where company_id = '$G' and action in ('envelope.create','review.record','release.publish','release.supersede','candidate.supersede','release.withdraw') group by action) x")" '^candidate.supersede=1,envelope.create=2,release.publish=2,release.supersede=1,release.withdraw=1,review.record=5$'
expect "the markers are stored where they belong: on the reviews, the release and the group" "$(sql -c "select (select count(*) from app.reviews where reason like 'MARKER-REASON-$RUN%') || '|' || (select count(*) from app.releases where withdrawal_reason like 'MARKER-REASON-$RUN%') || '|' || (select count(*) from app.groups where name = 'MARKER-GROUP-$RUN')")" '^5|1|1$'
expect "and in no audit row" "$(sql -c "select count(*) from app.audit_events where details::text like '%MARKER-%'")" '^0$'
AUDIT_INSERT="insert into app.audit_events (company_id, actor_kind, action, entity_type, details) values ('$G', 'system', 'probe.audit', 'probe', '{\"reason\":\"MARKER\"}'::jsonb); select 'AUDIT|accepted';"
expect "an owner-side audit row with a reason key: E_AUDIT_DETAILS_KEY" "$(in_rollback "$AUDIT_INSERT")" 'E_AUDIT_DETAILS_KEY reason'
MUT="$(mutant 'app.audit_details_guard()' "raise exception 'E_AUDIT_DETAILS_KEY %', k using errcode = '23514';" "ok := true;")"
expect "fail-before (case 47): with the guard accepting any key, the reason key is written" "$(in_rollback "$MUT;" "$AUDIT_INSERT")" 'AUDIT|accepted'

section "22d case 49: the SQL splice reads app.installer_texts; the manifest gate on a mirror"
node --input-type=module -e "
  const [root, company, agent, membership] = process.argv.slice(1);
  const { readText } = await import(root + '/lib/passport/assemble.mjs');
  const { gate } = await import(root + '/lib/passport/gate.mjs');
  const fixture = readText(root + '/tests/native-transfer/passport/fixtures/SYNTHETIC-passport.md');
  const g = gate(Buffer.from(fixture, 'utf8'), 'text/markdown', { validatedAt: new Date().toISOString() });
  if (!g.ok || g.text !== fixture) throw new Error('the fixture does not pass the gate unchanged');
  const tag = (name, s) => { const t = String.fromCharCode(36) + name + String.fromCharCode(36); if (s.includes(t)) throw new Error('tag'); return t + s + t; };
  process.stdout.write(\"insert into app.candidate_versions (company_id, agent_id, sequence, author_membership_id, content, derived_canonical, gate_id, attested_by) select '\" + company + \"', '\" + agent + \"', 90, '\" + membership + \"', \" + tag('e4c', g.text) + ', ' + tag('e4d', g.derivedCanonical) + \", g.id, '\" + membership + \"' from app.gate_identities g where g.active returning id;\n\");
" "$ROOT" "$G" "$AGENT" "$MS_M" > "$T/synthetic.sql"
SYN="$(first "$(sql < "$T/synthetic.sql")")"
SPLICE="$(sql -c "select string_agg(i.target || '=' || encode(sha256(convert_to(replace(v.content, app.installer_placeholder(), i.text), 'UTF8')), 'hex'), ',' order by i.target) from app.candidate_versions v cross join app.installer_texts i join app.gate_identities g on g.id = i.gate_id and g.active where v.id = '$SYN'")"
expect "the four golden assembled hashes of adapter section 6, spliced in SQL from the registered texts" "$SPLICE" '^chatgpt=11070a1ffbdc39030b661cddc332b8b5594bb78d6ab3c137000739609743ad7a,claude-ai=8e686b27e554e35af47af16a20cc24b48ae40323b4f5bcf37d64192f8b30e761,claude-code=5cdaf5c50d37c355c086f9f05aec2b810de10f109d0d1464682d4f13c85a3dff,generic=d558746392a835f3da4c4a779616761a8e0dba9157962d7da22d772e5d28546d$'
mkdir -p "$T/mirror"; MIRROR="$(cd "$T/mirror" && pwd -P)"
git -C "$ROOT" archive HEAD | tar -x -C "$MIRROR"; ln -s "$ROOT/node_modules" "$MIRROR/node_modules"
set +e
(cd "$MIRROR" && node scripts/installer-texts.mjs --check >/dev/null 2>&1); UNCHANGED=$?
printf 'x' >> "$MIRROR/vendor/passport/installer/branches/generic.md"
(cd "$MIRROR" && node scripts/installer-texts.mjs --check >/dev/null 2>&1); CHANGED=$?
set -e
expect "the manifest gate passes on a mirror of HEAD and fails with one vendored branch byte changed" "$UNCHANGED|$CHANGED" '^0|2$'

section "22e case 50: the retired seam is gone and the mutant's conditions hold"
# A reference is a call of the retired function or a read of its file; a comment recording the retirement is not one.
# A reference is a call of a retired function or a read of its file; a comment recording the retirement is not one, and
# migration 006's own comments name the file it created. The patterns are split so this line is not its own match.
expect "no code path calls either retired seam or reads its file" "$(cd "$ROOT" && { grep -rn "tests\.request_""changes(\|tests\.authorize_""download(\|e4-review""-seam\.sql['\"]\|e4-download""-seam\.sql['\"]\|< \"\$ROOT/tests/db/fixtures/e4-" lib tests scripts supabase netlify 2>/dev/null || true; } | wc -l | tr -d ' ')" '^0$'
expect "and to_regproc of the retired download seam is still null (E5 design 2.7, case 50)" "$(sql -c "select coalesce(to_regproc('tests.' || 'authorize_download')::text, 'null')")" '^null$'
r="$(sql_try -c "begin; set local role app_server; select tests.authorize_download_unlocked('$REL', '$MS_P'); rollback;")"; expect "app_server: permission denied for schema tests" "$r" 'permission denied for schema tests'
r="$(sql_try -c "begin; set local role authenticated; select tests.authorize_download_unlocked('$REL', '$MS_P'); rollback;")"; expect "authenticated: permission denied for schema tests" "$r" 'permission denied for schema tests'
code="$(curl -sS -o "$T/profile" -w '%{http_code}' -X POST "$API_URL/rest/v1/rpc/authorize_download_unlocked" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $(server_jwt "$U_A" aal2)" -H 'Content-Profile: tests' -H 'Content-Type: application/json' -d "$(jbody p_release="$REL" p_membership="$MS_P")")"
expect "PostgREST refuses the tests schema as a profile" "HTTP $code $(head -c 200 "$T/profile")" 'HTTP 406\|PGRST106'
expect "and no probe loads it with a bare seam call (probe 15 still did until this lane's final check-db run)" "none$(cd "$ROOT" && grep -rlx '[[:space:]]*seam[[:space:]]*' tests/db | tr '\n' ' ')" '^none$'
expect "the routine refuses a withdrawn release to a member of its audience: E_RELEASE_WITHDRAWN, no ledger row" "$(authorize_download "$REL2" "$MS_P")|$(sql -c "select count(*) from app.release_downloads where release_id = '$REL2'")" '^E_RELEASE_WITHDRAWN|0$'
expect "and a superseded one with its own code (E5 design 1.6; E4 reserved only E_RELEASE_WITHDRAWN)" "$(authorize_download "$REL" "$MS_P")" '^E_RELEASE_SUPERSEDED$'
C4="$(submitted "$U_M" "$G" "grants4-$RUN" 4)"; E4X="$(field "$(envelope "$U_M" "$C4" claude-ai "$AUD")" envelope_id)"
review "$U_I" "$C4" "$E4X" it approved "IT." >/dev/null; review "$U_B" "$C4" "$E4X" business approved "Business." >/dev/null
REL4="$(field "$(publish "$U_A" "$C4" "$E4X" "$(expected_sha "$C4" claude-ai)" @uuid --aal aal2)" release_id)"
expect "the routine refuses a removed membership and a member outside the audience: E_NOT_FOUND twice, no ledger row" "$(authorize_download "$REL4" "$MS_R")|$(authorize_download "$REL4" "$MS_B")|$(sql -c "select count(*) from app.release_downloads where release_id = '$REL4'")" '^E_NOT_FOUND|E_NOT_FOUND|0$'
expect "control: an audience member is authorized on the current release" "$(authorize_download "$REL4" "$MS_M")" '^authorized$'
r="$(cd "$ROOT" && node --test --test-name-pattern 'case 41' tests/e3/unit/migration-text.test.mjs 2>&1 | grep -E '^ℹ (pass|fail) ' | tr '\n' ' ')"
expect "the migration-text assertion that no migration creates a tests schema, and its control, pass" "$r" 'pass 2 ℹ fail 0'

expect "deadlocks unchanged" "$(deadlocks)" "^$DL0\$"
[ "$FAILED" = 0 ] && echo "22 PASS" || { echo "22 FAIL"; exit 1; }
