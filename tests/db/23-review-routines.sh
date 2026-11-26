#!/usr/bin/env bash
# Probe 23: the envelope and review routines, and publication's refusals that a review decides (docs/e4/design.md 1.1,
# 1.2, 1.3, 1.6, 3.2 and 3.5; section 5 cases 1 to 18, 23, 24, 27, 30, 41, 48's routine half, 53 and 54), and the SQL
# column of the four shared corpora under tests/e4/fixtures (reason, group name, envelope status, viewer verdict).
# Every E4 call goes through PostgREST with a bearer and body built by lib/db/server.mjs (tests/db/e4.mjs); every refused
# call is checked to write no row, no audit row and no claim; fail-before mutants run the live definition with one
# replacement in an owner transaction that is always rolled back. Owner-side setup is labelled as such.
# Run: bash tests/db/23-review-routines.sh (after tests/db/00-seed.sh and the probes before it).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
RUN="$(run_id)"; T="$E2_TMP/23"; mkdir -p "$T"
DL0="$(deadlocks)"
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

# person VAR company roles: a synthetic user with a membership; sets U_VAR and MS_VAR.
person() {
  local uid ms
  uid="$(create_user "e4-23-$RUN-$(printf '%s' "$1" | tr 'A-Z_' 'a-z-')@example.invalid" "$E4_PW")"
  ms="$(member "$2" "$uid" "$3")"
  eval "U_$1=$uid; MS_$1=$ms"
}
env_of() { field "$(envelope "$@")" envelope_id; }
publish_sub() { publish "$1" "$2" "$3" "$(expected_sha "$2" "$4")" @uuid --aal aal2; } # sub candidate envelope target
snap() { sql -c "select (select count(*) from app.review_envelopes) || '|' || (select count(*) from app.reviews) || '|' || (select count(*) from app.releases) || '|' || (select count(*) from app.audit_events) || '|' || (select count(*) from app.idempotency_keys) || '|' || (select count(*) from app.candidate_versions where state <> 'draft')"; }
refused() { # label pattern command...
  local before r
  before="$(snap)"
  r="$("${@:3}")"
  expect "$1" "$r" "$2"
  expect "$1: no row, no audit row, no claim" "$(snap)" "^$before\$"
}
agent_of() { sql -c "select agent_id from app.candidate_versions where id = '$1'"; }
approve_both() { # candidate envelope
  expect "IT approves $2" "$(review "$U_I" "$1" "$2" it approved "IT: reads the weekly report only.")" 'HTTP 200'
  expect "business approves $2" "$(review "$U_B" "$1" "$2" business approved "Business: the audience owns the report.")" 'HTTP 200'
}
RECORD_REVIEW='api.record_review(uuid,uuid,text,text,text,bytea,uuid)'

section "23 setup: company G (admin A, author M, IT I, business B, both-roles X), company H (admin HA); groups; three targets enabled"
U_A="$(create_user "e4-23-$RUN-a@example.invalid" "$E4_PW")"; G="$(company "e4-23g-$RUN" "$U_A")"; MS_A="$(membership_of "$G" "$U_A")"
U_HA="$(create_user "e4-23-$RUN-ha@example.invalid" "$E4_PW")"; H="$(company "e4-23h-$RUN" "$U_HA")"; MS_HA="$(membership_of "$H" "$U_HA")"
person M "$G" '{member}'
person I "$G" '{it_reviewer,member}'
person B "$G" '{business_reviewer,member}'
person X "$G" '{business_reviewer,it_reviewer,member}'
GR1="$(group_of "$G" "$MS_A" "One-$RUN" "$MS_M" "$MS_I")"
GR2="$(group_of "$G" "$MS_A" "Two-$RUN" "$MS_B")"
HG="$(group_of "$H" "$MS_HA" "Foreign-$RUN" "$MS_HA")"
AUD1="$(audience "$GR1")"; AUD12="$(audience "$GR1" "$GR2")"
for t in chatgpt claude-ai claude-code; do enable_target "$t"; done
echo "note: owner-side setup: chatgpt, claude-ai and claude-code enabled under the registry bypass; generic stays not publishable (case 24)"
for v in G H MS_M MS_I MS_B MS_X GR1 GR2 HG; do eval "expect \"setup: $v is a uuid\" \"\$$v\" '^[0-9a-f-]\{36\}\$'"; done

section "23 case 1: self-approval by the author, who holds it_reviewer"
person MI "$G" '{it_reviewer,member}'
C1="$(submitted "$U_MI" "$G" "c1-$RUN" 1)"; E1="$(env_of "$U_MI" "$C1" claude-ai "$AUD1")"
refused "case 1: the author holding it_reviewer approves their own candidate: E_REVIEWER_IS_CONTRIBUTOR" 'E_REVIEWER_IS_CONTRIBUTOR' review "$U_MI" "$C1" "$E1" it approved "Self review."
ROW22="if exists (select 1 from app.candidate_contributors k where k.candidate_id = p_candidate and k.membership_id is not null and k.membership_id = reviewer.id) then"
MUT="$(mutant "$RECORD_REVIEW" "$ROW22" "if false then")"
expect "case 1 fail-before: without the independence query the author's own approval is written" "$(in_rollback "$MUT;" "$(E4MODE=sql review "$U_MI" "$C1" "$E1" it approved "Self review.")")" '"review_id"'
expect "case 1 control: an independent it_reviewer records" "$(review "$U_I" "$C1" "$E1" it approved "Independent.")" 'HTTP 200 .*"decision": *"approved"'

section "23 case 2: by the submitter (owner-side submitter row while a draft)"
person S "$G" '{it_reviewer,member}'
r="$(draft_by_name "$U_M" "$G" "c2-$RUN" 2)"; C2="$(field "$r" candidate_id)"
sql -c "insert into app.candidate_contributors (candidate_id, membership_id, kind, observed) values ('$C2', '$MS_S', 'submitter', true)" >/dev/null
echo "note: owner-side, while C2 is a draft: a submitter row for S (no route writes another member's submitter row)"
expect "C2 submitted" "$(submit "$U_M" "$C2" 1 2)" '"state": *"submitted"'
E2="$(env_of "$U_M" "$C2" claude-ai "$AUD1")"
refused "case 2: S, a submitter, approves: E_REVIEWER_IS_CONTRIBUTOR" 'E_REVIEWER_IS_CONTRIBUTOR' review "$U_S" "$C2" "$E2" it approved "Submitter."
expect "case 2 control: a reviewer with no row records" "$(review "$U_I" "$C2" "$E2" it approved "Independent.")" 'HTTP 200'

section "23 case 3: by a substantive editor (owner-side editor row while a draft; no route writes editor at launch, E3 1.5)"
person ED "$G" '{it_reviewer,member}'
r="$(draft_by_name "$U_M" "$G" "c3-$RUN" 3)"; C3="$(field "$r" candidate_id)"
sql -c "insert into app.candidate_contributors (candidate_id, membership_id, kind, observed) values ('$C3', '$MS_ED', 'editor', true)" >/dev/null
expect "C3 submitted" "$(submit "$U_M" "$C3" 1 3)" '"state": *"submitted"'
E3="$(env_of "$U_M" "$C3" claude-ai "$AUD1")"
refused "case 3: the editor approves: E_REVIEWER_IS_CONTRIBUTOR" 'E_REVIEWER_IS_CONTRIBUTOR' review "$U_ED" "$C3" "$E3" it approved "Editor."
expect "case 3 control" "$(review "$U_I" "$C3" "$E3" it approved "Independent.")" 'HTTP 200'

section "23 case 4: by a declared member; a declaration by display name excludes nobody (B4)"
person D "$G" '{it_reviewer,member}'
person DN "$G" '{it_reviewer,member}'
sql -c "insert into app.profiles (user_id, display_name) values ('$U_DN', 'Dana Probe $RUN')" >/dev/null
r="$(draft_by_name "$U_M" "$G" "c4-$RUN" 4)"; C4="$(field "$r" candidate_id)"
DECL4="{\"confidence\":\"high\",\"declared_contributors\":[{\"membership_id\":\"$MS_D\"},{\"display_name\":\"Dana Probe $RUN\"}],\"permitted_data\":\"synthetic records only\",\"source_platform\":\"synthetic probe\"}"
expect "C4 submitted with D declared by membership and DN's display name declared by name" "$(SUBMISSION="$DECL4" submit "$U_M" "$C4" 1 4)" '"state": *"submitted"'
E4ID="$(env_of "$U_M" "$C4" claude-ai "$AUD1")"
refused "case 4: D, declared by membership, approves: E_REVIEWER_IS_CONTRIBUTOR" 'E_REVIEWER_IS_CONTRIBUTOR' review "$U_D" "$C4" "$E4ID" it approved "Declared."
expect "case 4 control: DN, declared only by a name equal to DN's display name, records (no identity from a name)" "$(review "$U_DN" "$C4" "$E4ID" it approved "Named only.")" 'HTTP 200'
expect "and the name is an unverified declaration with no membership" "$(sql -c "select count(*) from app.candidate_contributors where candidate_id = '$C4' and kind = 'declared_offline' and membership_id is null and display_name = 'Dana Probe $RUN'")" '^1$'

section "23 case 5: B4 inherited provenance: A1 authors P5, changes requested, B1's successor S5; A1 with business_reviewer approves S5"
person A1 "$G" '{member}'
person B1 "$G" '{it_reviewer,member}'
P5="$(submitted "$U_A1" "$G" "c5-$RUN" 5)"
request_changes "$P5"
r="$(successor "$U_B1" "$P5" 5)"; S5="$(field "$r" candidate_id)"
expect "S5 submitted by B1" "$(submit "$U_B1" "$S5" 1 5)" '"state": *"submitted"'
E5="$(env_of "$U_B1" "$S5" claude-ai "$AUD1")"
sql -c "update app.memberships set roles = '{business_reviewer,member}' where id = '$MS_A1'" >/dev/null
echo "note: owner-side, A1 is given business_reviewer after authoring (E2's set_roles is the route)"
refused "case 5: A1, S5's inherited author and submitter, approves: E_REVIEWER_IS_CONTRIBUTOR" 'E_REVIEWER_IS_CONTRIBUTOR' review "$U_A1" "$S5" "$E5" business approved "Inherited."
expect "case 5 control: a reviewer who is neither A1 nor B1 records on S5" "$(review "$U_B" "$S5" "$E5" business approved "Neither.")" 'HTTP 200'

section "23 case 6: B4 chain: three successors; the first parent's editor approves the third"
person E6 "$G" '{it_reviewer,member}'
r="$(draft_by_name "$U_M" "$G" "c6-$RUN" 6)"; P6="$(field "$r" candidate_id)"
sql -c "insert into app.candidate_contributors (candidate_id, membership_id, kind, observed) values ('$P6', '$MS_E6', 'editor', true)" >/dev/null
expect "P6 submitted" "$(submit "$U_M" "$P6" 1 6)" '"state": *"submitted"'
PARENT="$P6"
for n in 1 2 3; do
  request_changes "$PARENT"
  r="$(successor "$U_I" "$PARENT" 6)"; NEXT="$(field "$r" candidate_id)"
  expect "successor $n submitted" "$(submit "$U_I" "$NEXT" 1 6)" '"state": *"submitted"'
  PARENT="$NEXT"
done
E6X="$(env_of "$U_I" "$PARENT" claude-ai "$AUD1")"
refused "case 6: the first parent's editor approves the third successor: E_REVIEWER_IS_CONTRIBUTOR" 'E_REVIEWER_IS_CONTRIBUTOR' review "$U_E6" "$PARENT" "$E6X" it approved "Editor of the first."

section "23 case 7: ownership transfer (architecture 8.3): Carol owns without contributing; Alice authored"
person ALICE "$G" '{member}'
person CAROL "$G" '{it_reviewer,member}'
C7="$(submitted "$U_ALICE" "$G" "c7-$RUN" 7)"
sql -c "update app.agents set owner_membership_id = '$MS_CAROL' where id = '$(agent_of "$C7")'" >/dev/null
echo "note: owner-side, the agent's owner becomes Carol (E6's transfer is the route)"
E7="$(env_of "$U_ALICE" "$C7" claude-ai "$AUD1")"
expect "case 7: Carol, the owner with no contributor row, approves" "$(review "$U_CAROL" "$C7" "$E7" it approved "Owner, not a contributor.")" 'HTTP 200'
sql -c "update app.memberships set roles = '{it_reviewer,member}' where id = '$MS_ALICE'" >/dev/null
refused "case 7: Alice, given it_reviewer, approves: E_REVIEWER_IS_CONTRIBUTOR (before E_ALREADY_SIGNED)" 'E_REVIEWER_IS_CONTRIBUTOR' review "$U_ALICE" "$C7" "$E7" it approved "Author."

section "23 case 8: reactivation: a contributor removed and reactivated with the same membership id"
person R8 "$G" '{member}'
C8="$(submitted "$U_R8" "$G" "c8-$RUN" 8)"
expect "R8 removed through api.remove_member" "$(rest POST /rpc/remove_member "$(server_jwt "$U_A" aal2)" "$(jbody p_membership="$MS_R8")")" '"changed":true'
sql -c "update app.memberships set status = 'active', removed_at = null, roles = '{it_reviewer,member}' where id = '$MS_R8'" >/dev/null
echo "note: owner-side reactivation with it_reviewer, the same membership id (E2's acceptance reuses it)"
E8="$(env_of "$U_I" "$C8" claude-ai "$AUD1")"
refused "case 8: the reactivated contributor approves: E_REVIEWER_IS_CONTRIBUTOR" 'E_REVIEWER_IS_CONTRIBUTOR' review "$U_R8" "$C8" "$E8" it approved "Back again."
person NEW8 "$G" '{it_reviewer,member}'
expect "case 8 control: a new member with the same roles records" "$(review "$U_NEW8" "$C8" "$E8" it approved "New.")" 'HTTP 200'

section "23 case 9: the role is required"
C9="$(submitted "$U_M" "$G" "c9-$RUN" 9)"; E9="$(env_of "$U_M" "$C9" claude-ai "$AUD1")"
refused "case 9: a business_reviewer signs as it: E_ROLE_REQUIRED" 'E_ROLE_REQUIRED' review "$U_B" "$C9" "$E9" it approved "Wrong role."
refused "case 9: a company_admin without a reviewer role signs: E_ROLE_REQUIRED" 'E_ROLE_REQUIRED' review "$U_A" "$C9" "$E9" business approved "Admin."
refused "case 9: the author without a reviewer role signs: E_ROLE_REQUIRED (the role before independence)" 'E_ROLE_REQUIRED' review "$U_M" "$C9" "$E9" it approved "Author."
approve_both "$C9" "$E9"

section "23 case 10: a role lost after signing; the approval stands"
person X10 "$G" '{it_reviewer,member}'
C10="$(submitted "$U_M" "$G" "c10-$RUN" 10)"; E10="$(env_of "$U_M" "$C10" claude-ai "$AUD1")"; E10B="$(env_of "$U_M" "$C10" chatgpt "$AUD1")"
expect "X10 approves as IT" "$(review "$U_X10" "$C10" "$E10" it approved "Before the change.")" '"envelope_status": *"open"'
sql -c "update app.memberships set roles = '{business_reviewer,member}' where id = '$MS_X10'" >/dev/null
echo "note: owner-side, X10's it_reviewer is removed after signing; business_reviewer is kept so X10 still reads the candidate"
expect "case 10: business approves the same envelope: candidate and envelope approved" "$(review "$U_B" "$C10" "$E10" business approved "After the change.")" '"candidate_state": *"approved".*"envelope_status": *"approved"\|"envelope_status": *"approved".*"candidate_state": *"approved"'
expect "X10's approval stands" "$(sql -c "select count(*) from app.reviews where envelope_id = '$E10' and reviewer_membership_id = '$MS_X10'")" '^1$'
refused "case 10 control: X10 signing again after the removal: E_ROLE_REQUIRED" 'E_ROLE_REQUIRED' review "$U_X10" "$C10" "$E10B" it approved "Again."
sql -c "update app.memberships set roles = '{member}' where id = '$MS_X10'" >/dev/null
refused "case 10: with no reviewer or admin role left, X10 no longer reads the submitted candidate: E_NOT_FOUND, which row order puts before the role" 'E_NOT_FOUND' review "$U_X10" "$C10" "$E10B" it approved "Again."

section "23 case 11: one reviewer holding both roles"
C11="$(submitted "$U_M" "$G" "c11-$RUN" 11)"; E11="$(env_of "$U_M" "$C11" claude-ai "$AUD1")"
expect "X records IT: submitted" "$(review "$U_X" "$C11" "$E11" it approved "Both roles, IT.")" '"candidate_state": *"submitted"'
expect "case 11: X records business on the same envelope: approved" "$(review "$U_X" "$C11" "$E11" business approved "Both roles, business.")" '"candidate_state": *"approved"'
E11B="$(env_of "$U_M" "$C11" chatgpt "$AUD1")"
expect "X records IT on a second envelope" "$(review "$U_X" "$C11" "$E11B" it approved "Second envelope.")" 'HTTP 200'
refused "case 11 control: X records IT twice on it: E_ALREADY_SIGNED" 'E_ALREADY_SIGNED' review "$U_X" "$C11" "$E11B" it approved "Twice."

section "23 case 12: approvals on two envelope revisions never combine"
C12="$(submitted "$U_M" "$G" "c12-$RUN" 12)"; E12A="$(env_of "$U_M" "$C12" claude-ai "$AUD1")"; E12B="$(env_of "$U_M" "$C12" claude-ai "$AUD12")"
expect "revision 2 of the same candidate" "$(sql -c "select revision from app.review_envelopes where id = '$E12B'")" '^2$'
expect "IT approves revision 1" "$(review "$U_I" "$C12" "$E12A" it approved "Revision 1.")" 'HTTP 200'
MUT12="create or replace function app.envelope_status(p_envelope uuid) returns text language sql stable set search_path = '' as \$m\$ select case when exists (select 1 from app.reviews r where r.candidate_id = (select e.candidate_id from app.review_envelopes e where e.id = p_envelope) and r.decision = 'changes_requested') then 'changes_requested' when (select count(distinct r.role) from app.reviews r where r.candidate_id = (select e.candidate_id from app.review_envelopes e where e.id = p_envelope) and r.decision = 'approved') = 2 then 'approved' else 'open' end \$m\$;"
expect "cases 12 and 13 fail-before: with the status counted across the candidate, business on revision 2 approves the candidate" "$(in_rollback "$MUT12" "$(E4MODE=sql review "$U_B" "$C12" "$E12B" business approved "Revision 2.")")" '"candidate_state": *"approved"'
expect "case 12: business approves revision 2: both envelopes open, the candidate submitted" "$(review "$U_B" "$C12" "$E12B" business approved "Revision 2.")" '"candidate_state": *"submitted"'
expect "both envelopes are open" "$(sql -c "select app.envelope_status('$E12A') || '|' || app.envelope_status('$E12B')")" '^open|open$'
refused "case 12: publish revision 1: E_NOT_APPROVED" 'E_NOT_APPROVED' publish_sub "$U_A" "$C12" "$E12A" claude-ai
refused "case 12: publish revision 2: E_NOT_APPROVED" 'E_NOT_APPROVED' publish_sub "$U_A" "$C12" "$E12B" claude-ai
expect "case 12 control: both roles on revision 2 approve the candidate" "$(review "$U_X" "$C12" "$E12B" it approved "Revision 2, IT.")" '"candidate_state": *"approved"'

section "23 case 13: the audience widened after one approval"
C13="$(submitted "$U_M" "$G" "c13-$RUN" 13)"; E13A="$(env_of "$U_M" "$C13" claude-ai "$AUD1")"
expect "IT approves revision 1, audience {G1}" "$(review "$U_I" "$C13" "$E13A" it approved "G1.")" 'HTTP 200'
E13B="$(env_of "$U_M" "$C13" claude-ai "$AUD12")"
expect "business approves revision 2, audience {G1, G2}" "$(review "$U_B" "$C13" "$E13B" business approved "G1 and G2.")" '"candidate_state": *"submitted"'
refused "case 13: publish revision 2: E_NOT_APPROVED" 'E_NOT_APPROVED' publish_sub "$U_A" "$C13" "$E13B" claude-ai
refused "case 13: publish revision 1: E_NOT_APPROVED" 'E_NOT_APPROVED' publish_sub "$U_A" "$C13" "$E13A" claude-ai
expect "case 13 control: IT approves revision 2" "$(review "$U_X" "$C13" "$E13B" it approved "G1 and G2, IT.")" '"candidate_state": *"approved"'
r="$(publish_sub "$U_A" "$C13" "$E13B" claude-ai)"; R13="$(field "$r" release_id)"
expect "case 13 control: revision 2 publishes 201" "$r" 'HTTP 200 .*"existing": *false'
expect "with the audience {G1, G2}, copied from the envelope" "$(sql -c "select cardinality(audience_group_ids) || '|' || (audience_group_ids = (select audience_group_ids from app.review_envelopes where id = '$E13B')) from app.releases where id = '$R13'")" '^2|true$'

section "23 case 14: no audience at publication but the envelope's"
r="$(rest POST /rpc/publish_release "$(server_jwt "$U_A" aal2)" "$(jbody p_candidate="$C13" p_envelope="$E13B" p_expected_assembled_sha256=x p_gate_identity=x p_idempotency_key="$(uuid)" "p_audience_group_ids=#[\"$HG\"]")")"
expect "case 14: a direct call with an extra p_audience_group_ids matches no signature: PGRST202" "$r" 'PGRST202'
INS14="insert into app.releases (company_id, agent_id, candidate_id, envelope_id, target, gate_id, content_sha256, derived_sha256, installer_text_sha256, core_sha256, branch_sha256, judge_sha256, policy_id, policy_sha256, audience_group_ids, envelope_sha256, assembled_content, published_by_membership_id) select e.company_id, e.agent_id, e.candidate_id, e.id, e.target, e.gate_id, e.content_sha256, e.derived_sha256, e.installer_text_sha256, e.core_sha256, e.branch_sha256, e.judge_sha256, e.policy_id, e.policy_sha256, array['$GR2']::uuid[], e.envelope_sha256, 'x', '$MS_A' from app.review_envelopes e where e.id = '$E13B';"
expect "case 14 control: an owner-side release insert with another audience: E_ASSEMBLY_DIVERGED" "$(in_rollback "$INS14")" 'E_ASSEMBLY_DIVERGED'

section "23 case 15: a group of another company, refused before the company lock"
C15="$(submitted "$U_M" "$G" "c15-$RUN" 15)"; AUDH="$(audience "$HG")"; S15="$(snap)"
hold_company "$G" 3; sleep 0.3
T0="$(now_ms)"; r="$(envelope "$U_M" "$C15" claude-ai "$AUDH")"; T1="$(now_ms)"
wait
expect "case 15: E_NOT_FOUND" "$r" 'E_NOT_FOUND'
expect "case 15: under G's held company lock, in under one second" "$([ $((T1 - T0)) -lt 1000 ] && echo fast || echo "slow $((T1 - T0)) ms")" '^fast$'
expect "case 15: nothing written" "$(snap)" "^$S15\$"
expect "case 15 control: G's own group" "$(envelope "$U_M" "$C15" claude-ai "$AUD1")" '"existing": *false'

section "23 case 16: a policy changed after approval"
C16="$(submitted "$U_M" "$G" "c16-$RUN" 16)"; E16="$(env_of "$U_M" "$C16" claude-ai "$AUD1")"; E16X="$(env_of "$U_M" "$C16" chatgpt "$AUD1")"
approve_both "$C16" "$E16"
V16="$(sql -c "select max(version) + 1 from app.release_policies")"
sql -c "begin; set local app.registry_migration = 'on'; update app.release_policies set active = false where active; insert into app.release_policies (version, canonical, active) values ($V16, '{\"approval_scope\":\"configuration_and_evidence\",\"declared_writes\":\"not_installable\",\"policy_version\":$V16,\"recipient_overrides\":\"personal_bindings_only\"}', true); commit;" >/dev/null
echo "note: owner-side, under the registry bypass: policy version $V16 (2 after a reseed) registered and activated, as a later numbered migration would"
refused "case 16: publish the envelope approved under v1: E_POLICY_CHANGED" 'E_POLICY_CHANGED' publish_sub "$U_A" "$C16" "$E16" claude-ai
refused "case 16, 3.5 review row 34 (kept, section 4): an approval of an open v1 envelope: E_POLICY_CHANGED" 'E_POLICY_CHANGED' review "$U_I" "$C16" "$E16X" it approved "Under v1."
E16B="$(env_of "$U_M" "$C16" claude-ai "$AUD12")"
expect "the new envelope binds v2" "$(sql -c "select p.version from app.review_envelopes e join app.release_policies p on p.id = e.policy_id where e.id = '$E16B'")" "^$V16\$"
approve_both "$C16" "$E16B"
expect "case 16 control: a new envelope under v2 with both approvals publishes 201" "$(publish_sub "$U_A" "$C16" "$E16B" claude-ai)" '"existing": *false'
sql -c "begin; set local app.registry_migration = 'on'; update app.release_policies set active = false where version = $V16; update app.release_policies set active = true where version = 1; commit;" >/dev/null
echo "note: owner-side, under the bypass: version 1 active again for the probes after this one"

section "23 case 17: a second target"
C17="$(submitted "$U_M" "$G" "c17-$RUN" 17)"; E17C="$(env_of "$U_M" "$C17" chatgpt "$AUD1")"
approve_both "$C17" "$E17C"
expect "the chatgpt envelope publishes" "$(publish_sub "$U_A" "$C17" "$E17C" chatgpt)" '"existing": *false'
E17A="$(env_of "$U_M" "$C17" claude-ai "$AUD1")"
refused "case 17: publish the open claude-ai envelope: E_ENVELOPE_NOT_APPROVED" 'E_ENVELOPE_NOT_APPROVED' publish_sub "$U_A" "$C17" "$E17A" claude-ai
approve_both "$C17" "$E17A"
expect "case 17 control: both approvals on the claude-ai envelope, publish 201" "$(publish_sub "$U_A" "$C17" "$E17A" claude-ai)" '"existing": *false'
expect "two current releases, one per target" "$(sql -c "select string_agg(target, ',' order by target) from app.releases where candidate_id = '$C17' and state = 'published' and superseded_by_release_id is null")" '^chatgpt,claude-ai$'

section "23 case 18: mixed and null targets"
C18="$(submitted "$U_M" "$G" "c18-$RUN" 18)"; E18C="$(env_of "$U_M" "$C18" chatgpt "$AUD1")"; E18A="$(env_of "$U_M" "$C18" claude-ai "$AUD1")"
expect "IT on the chatgpt envelope" "$(review "$U_I" "$C18" "$E18C" it approved "chatgpt.")" 'HTTP 200'
expect "case 18: business on the claude-ai envelope: neither approved, the candidate submitted" "$(review "$U_B" "$C18" "$E18A" business approved "claude-ai.")" '"candidate_state": *"submitted".*"envelope_status": *"open"\|"envelope_status": *"open".*"candidate_state": *"submitted"'
refused "case 18: a direct call with a null target: E_BODY_INVALID" 'E_BODY_INVALID' E4 call create_envelope "$U_M" candidate_id="$C18" target=null audience_canonical="$AUD1" policy_id="$(active_policy)" gate_identity=@gate idempotency_key=@uuid
refused "case 18: a direct call with target copilot: E_BODY_INVALID" 'E_BODY_INVALID' E4 call create_envelope "$U_M" candidate_id="$C18" target=copilot audience_canonical="$AUD1" policy_id="$(active_policy)" gate_identity=@gate idempotency_key=@uuid

section "23 case 23: an orphaned agent at publication; an archived one"
person OW "$G" '{member}'
C23="$(submitted "$U_OW" "$G" "c23-$RUN" 23)"; AG23="$(agent_of "$C23")"
E23="$(env_of "$U_OW" "$C23" claude-ai "$AUD1")"; E23B="$(env_of "$U_OW" "$C23" chatgpt "$AUD1")"
approve_both "$C23" "$E23"
expect "the owner is removed after approval" "$(rest POST /rpc/remove_member "$(server_jwt "$U_A" aal2)" "$(jbody p_membership="$MS_OW")")" '"changed":true'
expect "and the agent is orphaned" "$(sql -c "select status from app.agents where id = '$AG23'")" '^orphaned$'
refused "case 23: publish: E_AGENT_ORPHANED" 'E_AGENT_ORPHANED' publish_sub "$U_A" "$C23" "$E23" claude-ai
expect "case 23: sign-offs are still accepted" "$(review "$U_I" "$C23" "$E23B" it approved "Still reviewable.")" 'HTTP 200'
sql -c "update app.agents set status = 'active', owner_membership_id = '$MS_M' where id = '$AG23'" >/dev/null
echo "note: owner-side, the agent is active again under M (E6's transfer is the route)"
expect "case 23 control: publish 201" "$(publish_sub "$U_A" "$C23" "$E23" claude-ai)" '"existing": *false'
C23X="$(submitted "$U_M" "$G" "c23x-$RUN" 24)"; E23X="$(env_of "$U_M" "$C23X" claude-ai "$AUD1")"
approve_both "$C23X" "$E23X"
sql -c "update app.agents set status = 'archived' where id = '$(agent_of "$C23X")'" >/dev/null
refused "case 23: an archived agent: E_AGENT_ARCHIVED" 'E_AGENT_ARCHIVED' publish_sub "$U_A" "$C23X" "$E23X" claude-ai

section "23 case 24: a target not publishable (006's default)"
C24="$(submitted "$U_M" "$G" "c24-$RUN" 25)"; E24="$(env_of "$U_M" "$C24" generic "$AUD1")"
approve_both "$C24" "$E24"
refused "case 24: publish for generic: E_TARGET_NOT_PUBLISHABLE" 'E_TARGET_NOT_PUBLISHABLE' publish_sub "$U_A" "$C24" "$E24" generic
enable_target generic
echo "note: owner-side, generic enabled under the bypass"
expect "case 24 control: 201" "$(publish_sub "$U_A" "$C24" "$E24" generic)" '"existing": *false'

section "23 case 27: an edit after approval, at every boundary"
R12="$(field "$(publish_sub "$U_A" "$C12" "$E12B" claude-ai)" release_id)"
refused "case 27: a save of an approved candidate: E_NOT_DRAFT" 'E_NOT_DRAFT' save "$U_M" "$C12" 2 12
expect "case 27: an owner-side update of its content: E_IMMUTABLE" "$(in_rollback "update app.candidate_versions set content = content || ' ' where id = '$C12';")" 'E_IMMUTABLE'
expect "case 27: an owner-side update of an envelope: E_IMMUTABLE" "$(in_rollback "update app.review_envelopes set target = 'generic' where id = '$E12B';")" 'E_IMMUTABLE'
expect "case 27: an owner-side delete of an envelope: E_ENVELOPE_DELETE" "$(in_rollback "delete from app.review_envelopes where id = '$E12A';")" 'E_ENVELOPE_DELETE'
expect "case 27: a truncate of the envelopes: refused by an E4 trigger" "$(in_rollback "truncate app.review_envelopes cascade;")" 'E_ENVELOPE_DELETE\|E_IMMUTABLE\|E_RELEASE_DELETE\|E_LEDGER_APPEND_ONLY'
expect "case 27: an owner-side update, delete and truncate of a review: E_IMMUTABLE each" "$(in_rollback "savepoint s; update app.reviews set reason = 'Rewritten.' where envelope_id = '$E12B'; rollback to savepoint s; savepoint t; delete from app.reviews where envelope_id = '$E12B'; rollback to savepoint t; truncate app.reviews;" | grep -c 'E_IMMUTABLE')" '^3$'
expect "case 27: a release's content, target and audience: E_IMMUTABLE each" "$(in_rollback "savepoint s; update app.releases set assembled_content = 'x' where id = '$R12'; rollback to savepoint s; savepoint t; update app.releases set target = 'generic' where id = '$R12'; rollback to savepoint t; update app.releases set audience_group_ids = array['$GR2']::uuid[] where id = '$R12';" | grep -c 'E_IMMUTABLE')" '^3$'
expect "case 27: a release delete and truncate: E_RELEASE_DELETE" "$(in_rollback "savepoint s; delete from app.releases where id = '$R12'; rollback to savepoint s; truncate app.releases cascade;" | grep -c 'E_RELEASE_DELETE\|E_LEDGER_APPEND_ONLY')" '^2$'
# E5 design 2.7: the ledger row comes from api.authorize_download under M's own server bearer, which is stronger
# evidence than the retired owner-side seam was.
expect "a ledger row for M, a member of the audience" "$(authorize_download "$R12" "$MS_M")" '^authorized$'
expect "case 27: the ledger's update, delete and truncate: E_LEDGER_APPEND_ONLY each" "$(in_rollback "savepoint s; update app.release_downloads set membership_id = membership_id where release_id = '$R12'; rollback to savepoint s; savepoint t; delete from app.release_downloads where release_id = '$R12'; rollback to savepoint t; truncate app.release_downloads;" | grep -c 'E_LEDGER_APPEND_ONLY')" '^3$'
expect "case 27 fail-before: with app.release_immutable's trigger dropped, the owner changes the target" "$(in_rollback "drop trigger releases_1_immutable on app.releases;" "update app.releases set target = 'generic' where id = '$R12';" "select 'MUTANT|' || target from app.releases where id = '$R12';")" 'MUTANT|generic'
INS27="insert into app.releases (company_id, agent_id, candidate_id, envelope_id, target, gate_id, content_sha256, derived_sha256, installer_text_sha256, core_sha256, branch_sha256, judge_sha256, policy_id, policy_sha256, audience_group_ids, envelope_sha256, assembled_content, assembled_sha256, assembled_bytes, published_by_membership_id) select e.company_id, e.agent_id, e.candidate_id, e.id, e.target, e.gate_id, e.content_sha256, e.derived_sha256, e.installer_text_sha256, e.core_sha256, e.branch_sha256, e.judge_sha256, e.policy_id, e.policy_sha256, array['$GR2']::uuid[], e.envelope_sha256, 'arbitrary bytes', sha256('arbitrary bytes'), 15, '$MS_A' from app.review_envelopes e where e.id = '$E13B';"
expect "case 27 fail-before: with app.release_identity's trigger dropped, an owner insert carries other bytes and another audience" "$(in_rollback "drop trigger releases_2_identity on app.releases;" "update app.releases set superseded_by_release_id = id, superseded_at = now() where id = '$R13';" "$INS27" "select 'MUTANT|' || count(*) from app.releases where envelope_id = '$E13B';")" 'MUTANT|2'
expect "case 27: the same insert with the trigger in place: E_ASSEMBLY_DIVERGED" "$(in_rollback "update app.releases set superseded_by_release_id = id, superseded_at = now() where id = '$R13';" "$INS27")" 'E_ASSEMBLY_DIVERGED'
expect "case 27 control: the routine's withdrawal, one of the two permitted transitions, succeeds" "$(withdraw "$U_A" "$R12" "Withdrawn after the edit probe." @uuid --aal aal2)" '"state": *"withdrawn"'

section "23 case 30: changes requested"
C30="$(submitted "$U_M" "$G" "c30-$RUN" 30)"; AG30="$(agent_of "$C30")"; E30="$(env_of "$U_M" "$C30" claude-ai "$AUD1")"
expect "case 30: a candidate-level change request on a submitted candidate: changes_requested, envelope status null" "$(review "$U_I" "$C30" null it changes_requested "Please fix the totals.")" '"candidate_state": *"changes_requested"'
expect "and no new candidate row" "$(sql -c "select count(*) from app.candidate_versions where agent_id = '$AG30'")" '^1$'
refused "case 30: then an approval on its envelope: E_NOT_REVIEWABLE" 'E_NOT_REVIEWABLE' review "$U_B" "$C30" "$E30" business approved "Too late."
refused "case 30: a second candidate-level request: E_NOT_REVIEWABLE" 'E_NOT_REVIEWABLE' review "$U_B" "$C30" null business changes_requested "Again."
C30B="$(submitted "$U_M" "$G" "c30b-$RUN" 31)"; E30B="$(env_of "$U_M" "$C30B" claude-ai "$AUD1")"
approve_both "$C30B" "$E30B"
E30C="$(env_of "$U_M" "$C30B" chatgpt "$AUD1")"
refused "case 30: a change request on an approved envelope: E_ENVELOPE_APPROVED" 'E_ENVELOPE_APPROVED' review "$U_I" "$C30B" "$E30B" it changes_requested "After approval."
refused "case 30: a candidate-level change request on an approved candidate: E_ENVELOPE_REQUIRED" 'E_ENVELOPE_REQUIRED' review "$U_I" "$C30B" null it changes_requested "Whole candidate."
expect "a change request on the approved candidate's open envelope closes that envelope only" "$(review "$U_I" "$C30B" "$E30C" it changes_requested "chatgpt only.")" '"candidate_state": *"approved".*"envelope_status": *"changes_requested"\|"envelope_status": *"changes_requested".*"candidate_state": *"approved"'
refused "an approval of the closed envelope: E_ENVELOPE_CLOSED" 'E_ENVELOPE_CLOSED' review "$U_B" "$C30B" "$E30C" business approved "Closed."
expect "case 30 control: E3's successor succeeds against the parent the real routine produced" "$(successor "$U_I" "$C30" 30)" '"state": *"draft"'

section "23 case 41, routine half: history is kept; nothing of it can be deleted"
C41="$(submitted "$U_M" "$G" "c41-$RUN" 41)"; AG41="$(agent_of "$C41")"
CONTENT41="$(E3 literal content --revision 41)"; DERIVED41="$(E3 literal derived --revision 41)"; GATE_ID="$(sql -c "select id from app.gate_identities where active")"
sql -c "insert into app.candidate_versions (company_id, agent_id, sequence, author_membership_id, content, derived_canonical, gate_id, attested_by) select '$G', '$AG41', g, '$MS_M', $CONTENT41, $DERIVED41, '$GATE_ID', '$MS_M' from generate_series(2, 10) g" >/dev/null
echo "note: owner-side, nine more drafts of the agent (sequences 2 to 10)"
r="$(draft_by_id "$U_M" "$G" "$AG41" 42)"; C41K="$(field "$r" candidate_id)"; submit "$U_M" "$C41K" 1 42 >/dev/null
r="$(draft_by_id "$U_M" "$G" "$AG41" 43)"; C41L="$(field "$r" candidate_id)"; submit "$U_M" "$C41L" 1 43 >/dev/null
E41K="$(env_of "$U_M" "$C41K" claude-ai "$AUD1")"; approve_both "$C41K" "$E41K"
E41L="$(env_of "$U_M" "$C41L" claude-ai "$AUD1")"; approve_both "$C41L" "$E41L"
R41K="$(field "$(publish_sub "$U_A" "$C41K" "$E41K" claude-ai)" release_id)"
expect "the twelfth version publishes and supersedes the eleventh" "$(publish_sub "$U_A" "$C41L" "$E41L" claude-ai)" "\"superseded_release_ids\": *\[\"$R41K\"\]"
expect "case 41: all twelve rows are present; the eleventh is superseded" "$(sql -c "select count(*) || '|' || (select state from app.candidate_versions where id = '$C41K') from app.candidate_versions where agent_id = '$AG41'")" '^12|superseded$'
expect "case 41: an owner-side delete of the superseded candidate: E_CANDIDATE_DELETE" "$(in_rollback "delete from app.candidate_versions where id = '$C41K';")" 'E_CANDIDATE_DELETE'
expect "case 41: an owner-side delete of its release: E_RELEASE_DELETE" "$(in_rollback "delete from app.releases where id = '$R41K';")" 'E_RELEASE_DELETE'
echo "note: the 201st version is E3's E_VERSION_LIMIT, probe 14 section 14g; agentHistory's ten newest is the review read's (tests/e4/stack)"

section "23 case 48, routine half: the group rules at the routines (probe 21 holds each arm with its fail-before)"
person TWO "$G" '{member}'
expect "a member creates a group: E_FORBIDDEN" "$(rest POST /rpc/create_group "$(server_jwt "$U_M" aal2)" "$(jbody p_company="$G" p_name="Member-$RUN")")" 'E_FORBIDDEN'
expect "an admin at aal1 adds a member: E_ADMIN_MFA_REQUIRED" "$(rest POST /rpc/add_group_member "$(server_jwt "$U_A" aal1)" "$(jbody p_group="$GR1" p_membership="$MS_TWO")")" 'E_ADMIN_MFA_REQUIRED'
expect "an admin adds a membership of company H: E_NOT_FOUND" "$(rest POST /rpc/add_group_member "$(server_jwt "$U_A" aal2)" "$(jbody p_group="$GR1" p_membership="$MS_HA")")" 'E_NOT_FOUND'
expect "an admin adds a removed membership: E_MEMBERSHIP_REMOVED" "$(rest POST /rpc/add_group_member "$(server_jwt "$U_A" aal2)" "$(jbody p_group="$GR1" p_membership="$MS_OW")")" 'E_MEMBERSHIP_REMOVED'
AUD48="$(sql -c "select count(*) from app.audit_events where company_id = '$G'")"
expect "the same membership twice: changed false" "$(rest POST /rpc/add_group_member "$(server_jwt "$U_A" aal2)" "$(jbody p_group="$GR1" p_membership="$MS_M")")" '"changed":false'
expect "and no audit row" "$(sql -c "select count(*) from app.audit_events where company_id = '$G'")" "^$AUD48\$"
for gr in "$GR1" "$GR2"; do rest POST /rpc/add_group_member "$(server_jwt "$U_A" aal2)" "$(jbody p_group="$gr" p_membership="$MS_TWO")" >/dev/null; done
expect "api.remove_member on a membership in two groups" "$(rest POST /rpc/remove_member "$(server_jwt "$U_A" aal2)" "$(jbody p_membership="$MS_TWO")")" '"changed":true'
expect "deletes both rows, with two group.remove_member rows reason_code membership_removed" "$(sql -c "select (select count(*) from app.group_members where membership_id = '$MS_TWO') || '|' || (select count(*) from app.audit_events where action = 'group.remove_member' and details->>'membership_id' = '$MS_TWO' and details->>'reason_code' = 'membership_removed')")" '^0|2$'
sql -c "update app.memberships set status = 'active', removed_at = null where id = '$MS_TWO'" >/dev/null
expect "reactivation restores no group" "$(sql -c "select count(*) from app.group_members where membership_id = '$MS_TWO'")" '^0$'

section "23 case 53, routine half (E4D-C-F3): assembly expansion"
node --input-type=module -e "
  const [root, company, membership, run] = process.argv.slice(1);
  const { readFileSync } = await import('node:fs');
  const { PLACEHOLDER } = await import(root + '/lib/passport/assemble.mjs');
  const { gate } = await import(root + '/lib/passport/gate.mjs');
  const empty = readFileSync(root + '/tests/passport/fixtures/synthetic-empty.md', 'utf8');
  const eight = empty + '\n' + Array(7).fill(PLACEHOLDER).join('\n') + '\n';
  const at = new Date().toISOString();
  const tag = (name, s) => { const t = String.fromCharCode(36) + name + String.fromCharCode(36); if (s.includes(t)) throw new Error('tag'); return t + s + t; };
  const sql = [];
  for (const [label, text] of [['one', empty], ['eight', eight]]) {
    const g = gate(Buffer.from(text, 'utf8'), 'text/markdown', { validatedAt: at });
    if (!g.ok || g.text !== text) throw new Error(label + ' does not pass the gate unchanged');
    sql.push(\"with a as (insert into app.agents (company_id, name, creator_membership_id, owner_membership_id) values ('\" + company + \"', 'expansion-\" + label + '-' + run + \"', '\" + membership + \"', '\" + membership + \"') returning id), v as (insert into app.candidate_versions (company_id, agent_id, sequence, author_membership_id, content, derived_canonical, gate_id, attested_by) select '\" + company + \"', a.id, 1, '\" + membership + \"', \" + tag('e4c', g.text) + ', ' + tag('e4d', g.derivedCanonical) + \", (select id from app.gate_identities where active), '\" + membership + \"' from a returning id) select '\" + label.toUpperCase() + \"|' || id from v;\");
  }
  process.stdout.write(sql.join('\n') + '\n');
" "$ROOT" "$G" "$MS_M" "$RUN" > "$T/expansion.sql"
OUT53="$(sql < "$T/expansion.sql")"
ONE="$(printf '%s\n' "$OUT53" | sed -n 's/^ONE|//p')"; EIGHT="$(printf '%s\n' "$OUT53" | sed -n 's/^EIGHT|//p')"
sql -c "insert into app.candidate_contributors (candidate_id, membership_id, kind, observed) select id, '$MS_M', 'author', true from app.candidate_versions where id in ('$ONE', '$EIGHT'); update app.candidate_versions set state = 'submitted', submitted_at = clock_timestamp(), submitted_by_membership_id = '$MS_M' where id in ('$ONE', '$EIGHT');" >/dev/null
echo "note: owner-side, two submitted candidates of synthetic-empty.md: with its one placeholder, and with seven more (3,129 bytes), each gated unchanged"
expect "the eight-placeholder content is 3,129 bytes with eight occurrences" "$(sql -c "select octet_length(content) || '|' || (octet_length(content) - octet_length(replace(content, app.installer_placeholder(), ''))) / octet_length(app.installer_placeholder()) from app.candidate_versions where id = '$EIGHT'")" '^3129|8$'
refused "case 53: an envelope for claude-code over eight placeholders: E_ASSEMBLY_TOO_LARGE at the routine (row 29a)" 'E_ASSEMBLY_TOO_LARGE' envelope "$U_M" "$EIGHT" claude-code "$AUD1"
r="$(envelope "$U_M" "$ONE" claude-code "$AUD1")"; E53="$(field "$r" envelope_id)"
expect "case 53 control: one placeholder: the envelope, assembled_bytes 73,409" "$r" '"assembled_bytes": *73409'
INS53="insert into app.review_envelopes (company_id, agent_id, candidate_id, revision, content_sha256, derived_sha256, gate_id, gate_identity_sha256, target, installer_text_sha256, core_sha256, branch_sha256, judge_sha256, policy_id, policy_sha256, assembled_bytes, audience_group_ids, envelope_canonical, envelope_sha256, created_by_membership_id) select v.company_id, v.agent_id, v.id, 9, v.content_sha256, v.derived_sha256, i.gate_id, g.identity_sha256, i.target, i.text_sha256, i.core_sha256, i.branch_sha256, i.judge_sha256, p.id, p.sha256, 1, array['$GR2']::uuid[], 'supplied', sha256('supplied'), '$MS_M' from app.candidate_versions v, app.installer_texts i join app.gate_identities g on g.id = i.gate_id and g.active, app.release_policies p where p.active and i.target = 'claude-code' and v.id ="
expect "case 53: an owner-side envelope with a false assembled_bytes: the trigger overwrites it and the canonical text" "$(in_rollback "$INS53 '$ONE' returning 'ROW|' || assembled_bytes || '|' || (envelope_canonical <> 'supplied');")" 'ROW|73409|true'
expect "case 53: the same insert over the eight-placeholder content: the trigger refuses E_ASSEMBLY_TOO_LARGE" "$(in_rollback "$INS53 '$EIGHT' returning 'ROW|' || assembled_bytes;")" 'E_ASSEMBLY_TOO_LARGE'
approve_both "$ONE" "$E53"
T0="$(now_ms)"
r="$(in_rollback "alter table app.candidate_versions disable trigger user;" "update app.candidate_versions set content = content || repeat(chr(10) || app.installer_placeholder(), 4632) where id = '$ONE';" "select 'SWAPPED|' || octet_length(content) || '|' || (octet_length(content) - octet_length(replace(content, app.installer_placeholder(), ''))) / octet_length(app.installer_placeholder()) from app.candidate_versions where id = '$ONE';" "$(E4MODE=sql publish "$U_A" "$ONE" "$E53" "$(printf 'a%.0s' $(seq 64))" @uuid --aal aal2)")"
T1="$(now_ms)"
expect "case 53: the stored content swapped owner-side (triggers disabled, in a rolled-back transaction) holds 4,633 occurrences" "$r" 'SWAPPED|2621[0-9][0-9]|4633'
expect "case 53: publication refuses E_ASSEMBLY_TOO_LARGE under the locks, before replace" "$r" 'E_ASSEMBLY_TOO_LARGE'
expect "case 53: and answers in under two seconds (nothing near 327,690,138 bytes was built)" "$([ $((T1 - T0)) -lt 2000 ] && echo fast || echo "slow $((T1 - T0)) ms")" '^fast$'
r="$(publish_sub "$U_A" "$ONE" "$E53" claude-code)"
expect "case 53 control: the unswapped candidate publishes" "$r" '"existing": *false'
expect "with 73,409 assembled bytes" "$(sql -c "select assembled_bytes || '|' || octet_length(assembled_content) from app.releases where id = '$(field "$r" release_id)'")" '^73409|73409$'

section "23 case 54 (Q5 as answered 2026-09-15): a contributor of an earlier version of the agent is not excluded"
person A54 "$G" '{member}'
person B54 "$G" '{member}'
C54A="$(submitted "$U_A54" "$G" "c54-$RUN" 54)"; AG54="$(agent_of "$C54A")"
request_changes "$C54A"
r="$(draft_by_id "$U_B54" "$G" "$AG54" 55)"; C54B="$(field "$r" candidate_id)"
expect "B54's fresh draft of the agent, submitted" "$(submit "$U_B54" "$C54B" 1 55)" '"state": *"submitted"'
sql -c "update app.memberships set roles = '{business_reviewer,it_reviewer,member}' where id = '$MS_A54'" >/dev/null
echo "note: owner-side, A54 is given both reviewer roles"
E54="$(env_of "$U_B54" "$C54B" claude-ai "$AUD1")"
expect "A54 holds no contributor row on the fresh draft" "$(sql -c "select count(*) from app.candidate_contributors where candidate_id = '$C54B' and membership_id = '$MS_A54'")" '^0$'
expect "and the agent-wide history lists A54 as C54A's author (owner-side read of the set the history panel shows)" "$(sql -c "select string_agg(kind, ',' order by kind) from app.agent_contributor_memberships('$AG54') where membership_id = '$MS_A54'")" '^author,submitter$'
MUT54="$(mutant "$RECORD_REVIEW" "$ROW22" "if exists (select 1 from app.agent_contributor_memberships(cand_agent) x where x.membership_id = reviewer.id) then")"
expect "case 54 fail-before: with row 22 read over every candidate of the agent (the reading of 2026-09-14), A54 is refused" "$(in_rollback "$MUT54;" "$(E4MODE=sql review "$U_A54" "$C54B" "$E54" it approved "Earlier version's author.")")" 'E_REVIEWER_IS_CONTRIBUTOR'
expect "case 54: A54 approves an envelope of the fresh draft as IT reviewer (PostgREST 200; the route answers 201, JE7)" "$(review "$U_A54" "$C54B" "$E54" it approved "Earlier version's author, not a contributor of this one.")" 'HTTP 200 .*"decision": *"approved"'
expect "case 54: and as business reviewer, the second role on the same envelope" "$(review "$U_A54" "$C54B" "$E54" business approved "Earlier version's author, second role.")" 'HTTP 200 .*"decision": *"approved"'
expect "case 54: the fresh draft is approved when the second role signs" "$(sql -c "select state from app.candidate_versions where id = '$C54B'")" '^approved$'
echo "note: case 54's control is case 5 above: A1 is refused on the successor S5, which inherits her rows"

section "23 the shared corpora, SQL column"
r="$(diff <(E4 reason-sql | sql 2>&1 | grep '^REASON|') <(E4 reason-expected) > "$T/reason.diff" && echo same || true)"
expect "the reason corpus: app.review_reason answers every representable row as reviewReasonOf does" "$r|$(head -c 300 "$T/reason.diff")" '^same|$'
U_GC="$(create_user "e4-23-$RUN-gc@example.invalid" "$E4_PW")"; GC="$(company "e4-23gc-$RUN" "$U_GC")"
r="$(diff <(E4 group-name-sql "$GC" "$U_GC" | sql 2>&1 | grep '^GROUP|') <(E4 group-name-expected) > "$T/group.diff" && echo same || true)"
expect "the group-name corpus: api.create_group answers every representable row as groupNameOf does (each call rolled back)" "$r|$(head -c 300 "$T/group.diff")" '^same|$'
CST="$(submitted "$U_M" "$G" "status-$RUN" 70)"; EST="$(env_of "$U_M" "$CST" claude-ai "$AUD1")"
r="$(diff <(E4 status-sql "$EST" "$CST" "$G" "$MS_I" | sql 2>&1 | grep '^STATUS|') <(E4 status-expected) > "$T/status.diff" && echo same || true)"
expect "the status corpus: app.envelope_status over the representable rows answers as envelopeStatus does" "$r|$(head -c 300 "$T/status.diff")" '^same|$'
expect "and those rows were rolled back" "$(sql -c "select count(*) from app.reviews where envelope_id = '$EST'")" '^0$'
# contribute candidate membership kinds row: owner-side contributor rows of one corpus row on a draft.
contribute() {
  local kind observed
  for kind in $(printf '%s' "$3" | tr ',' ' '); do
    if [ "$kind" = declared_offline ]; then
      sql -c "insert into app.candidate_contributors (candidate_id, kind, display_name, observed) values ('$1', 'declared_offline', 'Verdict $4 offline', false)" >/dev/null
    else
      observed=false; case "$kind" in author|editor|submitter) observed=true;; esac
      sql -c "insert into app.candidate_contributors (candidate_id, membership_id, kind, observed) values ('$1', '$2', '$kind', $observed)" >/dev/null
    fi
  done
}
# The rows are read from fd 3: sql runs docker exec -i, which would read the loop's standard input.
while IFS='|' read -r i roles kinds it business earlier <&3; do
  person "V$i" "$G" "$roles"
  eval "UV=\$U_V$i; MSV=\$MS_V$i"
  rev=$((80 + i))
  if [ -n "$earlier" ]; then
    # earlierKinds (Q5 as answered 2026-09-15): the viewer's rows sit on an earlier candidate of the same agent only,
    # submitted and sent back; the review runs on a fresh draft of that agent by M, which inherits none of them.
    r="$(draft_by_name "$U_M" "$G" "verdict-$i-$RUN" "$rev")"; DE="$(field "$r" candidate_id)"
    contribute "$DE" "$MSV" "$earlier" "$i"
    submit "$U_M" "$DE" 1 "$rev" >/dev/null
    request_changes "$DE"
    rev=$((100 + i))
    r="$(draft_by_id "$U_M" "$G" "$(agent_of "$DE")" "$rev")"; DV="$(field "$r" candidate_id)"
    expect "the verdict corpus row $i: the viewer's rows are on the earlier candidate only (earlier|fresh)" "$(sql -c "select (select count(*) from app.candidate_contributors where candidate_id = '$DE' and membership_id = '$MSV') || '|' || (select count(*) from app.candidate_contributors where candidate_id = '$DV' and membership_id = '$MSV')")" "^$(printf '%s' "$earlier" | awk -F, '{print NF}')|0\$"
  else
    r="$(draft_by_name "$U_M" "$G" "verdict-$i-$RUN" "$rev")"; DV="$(field "$r" candidate_id)"
  fi
  contribute "$DV" "$MSV" "$kinds" "$i"
  submit "$U_M" "$DV" 1 "$rev" >/dev/null
  EV="$(env_of "$U_M" "$DV" claude-ai "$AUD1")"
  for pair in "it:$it" "business:$business"; do
    role="${pair%%:*}"; want="${pair#*:}"
    got="$(in_rollback "$(E4MODE=sql review "$UV" "$DV" "$EV" "$role" approved "Verdict row $i.")")"
    if [ "$want" = accepted ]; then pattern='"review_id"'; else pattern="$want"; fi
    case "$roles" in
      *reviewer*|*company_admin*)
        expect "the verdict corpus row $i ($roles; kinds ${kinds:-none}), $role: api.record_review answers as viewerVerdict does ($want)" "$got" "$pattern" ;;
      *)
        # A member with no reviewer or admin role who is not the author cannot read a submitted candidate (003's
        # app.candidate_visible_to), so the review page that shows viewerVerdict answers 404 and the routine refuses first.
        expect "the verdict corpus row $i ($roles; kinds ${kinds:-none}), $role: viewerVerdict says $want, but the viewer cannot read the candidate: E_NOT_FOUND first in row order" "$got" 'E_NOT_FOUND' ;;
    esac
  done
done 3< <(E4 verdict-rows)

expect "deadlocks unchanged" "$(deadlocks)" "^$DL0\$"
[ "$FAILED" = 0 ] && echo "23 PASS" || { echo "23 FAIL"; exit 1; }
