#!/usr/bin/env bash
# Probe 25: the E4 routines under concurrency (docs/e4/design.md 1.2, 1.3, 1.4, 2.5 and 3.2; section 5 cases 31, 32, 33,
# 35 and 36, with the corrections of evidence/e4-design-critique.md F7). Each schedule is ordered by locks the probe holds
# and releases itself, observed in pg_stat_activity, never by a sleep; every schedule asserts pg_stat_database.deadlocks
# unchanged. Mutants that other connections must see are installed with a commit, their original definition saved and
# restored when the section ends and again on exit.
#   25a case 31: two approvals of the two roles on one envelope queued behind a held company lock; the failing control
#       removes both serializations around the count (the company lock and the candidate row lock) and adds a shared
#       advisory barrier between each review insert and its status count, and is observed losing the approval
#   25b case 32: an approval racing a change request on one envelope, both orders, for a first approval and for the second
#       role's approval (F7); sequential calls give the same outcomes
#   25c case 33: publication racing the second approval, both orders
#   25d case 35: publication of a newer version racing the withdrawal of the current release, both orders
#   25e case 36 (B6): moved to tests/db/28-download-concurrency.sh with the download seam's retirement (E5 design 2.7)
# Run: bash tests/db/25-review-concurrency.sh (after tests/db/00-seed.sh and the probes before it).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
RUN="$(run_id)"; T="$E2_TMP/25"; mkdir -p "$T/saved"
DL0="$(deadlocks)"
person() {
  local uid ms
  uid="$(create_user "e4-25-$RUN-$(printf '%s' "$1" | tr 'A-Z_' 'a-z-')@example.invalid" "$E4_PW")"
  ms="$(member "$2" "$uid" "$3")"
  eval "U_$1=$uid; MS_$1=$ms"
}
env_of() { field "$(envelope "$@")" envelope_id; }
publish_sub() { publish "$1" "$2" "$3" "$(expected_sha "$2" "$4")" @uuid --aal aal2; }

MUTANT_DIR="$T/saved"
trap 'restore_all; rm -rf "$E2_TMP"' EXIT

# The controlling connection: holds the company lock until the probe releases it. The advisory-barrier pair it uses
# beside this one (hold_barrier, release_barrier) is in tests/db/e4-lib.sh, because probe 28 holds the same kind of
# barrier and one copy of a lock helper is better than two (E5 design 2.7).
hold_lock() { # fd name company
  session_open "$2" "$1"
  session_send "$1" "begin;"
  session_send "$1" "select 'HELD|' || id from app.companies where id = '$3' for no key update;"
  session_wait "$2" 'HELD|'
}
release() { session_send "$1" "commit;"; session_close "$1"; } # fd

section "25 setup: company G (admin A, author M, IT I, business B, both X, member P); the audience group; claude-ai enabled"
U_A="$(create_user "e4-25-$RUN-a@example.invalid" "$E4_PW")"; G="$(company "e4-25g-$RUN" "$U_A")"; MS_A="$(membership_of "$G" "$U_A")"
person M "$G" '{member}'
person I "$G" '{it_reviewer,member}'
person B "$G" '{business_reviewer,member}'
person X "$G" '{business_reviewer,it_reviewer,member}'
person P "$G" '{member}'
GR="$(group_of "$G" "$MS_A" "Audience-$RUN" "$MS_P" "$MS_M")"; AUD="$(audience "$GR")"
enable_target claude-ai

section "25a case 31: concurrent approvals of the two roles on one envelope"
C31="$(submitted "$U_M" "$G" "c31-$RUN" 31)"; E31="$(env_of "$U_M" "$C31" claude-ai "$AUD")"
DL="$(deadlocks)"
hold_lock 7 c31 "$G"
review "$U_I" "$C31" "$E31" it approved "IT, concurrent." > "$T/c31-it" &
review "$U_B" "$C31" "$E31" business approved "Business, concurrent." > "$T/c31-business" &
expect "both approvals are observed waiting on the company lock" "$(lock_waiters 'record_review' 2 && echo waiting)" '^waiting$'
release 7; wait
expect "case 31: both answer 200" "$(cat "$T/c31-it" "$T/c31-business" | grep -c '^HTTP 200')" '^2$'
expect "case 31: exactly one review.record carries candidate_state_after approved" "$(sql -c "select count(*) from app.audit_events where action = 'review.record' and details->>'envelope_id' = '$E31' and details->>'candidate_state_after' = 'approved'")" '^1$'
expect "case 31: the candidate is approved, once" "$(sql -c "select state from app.candidate_versions where id = '$C31'")|$(sql -c "select count(*) from app.reviews where envelope_id = '$E31'")" '^approved|2$'
expect "case 31: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
C31M="$(submitted "$U_M" "$G" "c31m-$RUN" 32)"; E31M="$(env_of "$U_M" "$C31M" claude-ai "$AUD")"
install_mutant c31 'api.record_review(uuid,uuid,text,text,text,bytea,uuid)' \
  "perform app.lock_company(company);" "perform 1;" \
  "from app.candidate_versions v where v.id = p_candidate for update;" "from app.candidate_versions v where v.id = p_candidate;" \
  "returning id into new_review;" "returning id into new_review; perform pg_advisory_xact_lock_shared(hashtext('e4-25-c31'));"
echo "note: mutant M31 installed: api.record_review without app.lock_company and without the candidate row's FOR UPDATE (the two serializations around the status count), with a shared advisory barrier between the review insert and the count"
hold_barrier 8 c31m e4-25-c31
review "$U_I" "$C31M" "$E31M" it approved "IT, mutant." > "$T/c31m-it" &
review "$U_B" "$C31M" "$E31M" business approved "Business, mutant." > "$T/c31m-business" &
expect "under M31 both approvals have inserted and wait at the barrier" "$(lock_waiters 'record_review' 2 && echo waiting)" '^waiting$'
release_barrier 8; wait
restore_mutant c31
expect "case 31 failing control: under M31 both approvals answer 200" "$(cat "$T/c31m-it" "$T/c31m-business" | grep -c '^HTTP 200')" '^2$'
expect "case 31 failing control: the envelope holds both approvals and is approved, yet the candidate stayed submitted and no review.record says approved" "$(sql -c "select app.envelope_status('$E31M') || '|' || (select state from app.candidate_versions where id = '$C31M') || '|' || (select count(*) from app.audit_events where action = 'review.record' and details->>'envelope_id' = '$E31M' and details->>'candidate_state_after' = 'approved')")" '^approved|submitted|0$'
expect "the original api.record_review is back" "$(sql -c "select position('perform app.lock_company(company);' in prosrc) > 0 from pg_proc where oid = 'api.record_review(uuid,uuid,text,text,text,bytea,uuid)'::regprocedure")" '^t$'

section "25b case 32: an approval racing a change request on one envelope, both orders, first approval and second role's approval"
race32() { # label first-command second-command: queued behind the company lock in that order
  local label="$1"
  DL="$(deadlocks)"
  hold_lock 7 "c32-$label" "$G"
  eval "$2" > "$T/c32-$label-1" &
  lock_waiters 'record_review' 1 || true
  eval "$3" > "$T/c32-$label-2" &
  expect "case 32 $label: both are observed waiting in arrival order" "$(lock_waiters 'record_review' 2 && echo waiting)" '^waiting$'
  release 7; wait
  expect "case 32 $label: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
}
C32A="$(submitted "$U_M" "$G" "c32a-$RUN" 33)"; E32A="$(env_of "$U_M" "$C32A" claude-ai "$AUD")"
race32 first-approval-first "review \"$U_I\" \"$C32A\" \"$E32A\" it approved 'IT first.'" "review \"$U_B\" \"$C32A\" \"$E32A\" business changes_requested 'Changes.'"
expect "a first approval first: 200, then the change request: 200" "$(grep -c '^HTTP 200' "$T/c32-first-approval-first-1" "$T/c32-first-approval-first-2" | awk -F: '{s+=$2} END {print s}')" '^2$'
expect "the candidate and the envelope are changes_requested" "$(sql -c "select state from app.candidate_versions where id = '$C32A'")|$(sql -c "select app.envelope_status('$E32A')")" '^changes_requested|changes_requested$'
C32B="$(submitted "$U_M" "$G" "c32b-$RUN" 34)"; E32B="$(env_of "$U_M" "$C32B" claude-ai "$AUD")"
race32 first-request-first "review \"$U_B\" \"$C32B\" \"$E32B\" business changes_requested 'Changes first.'" "review \"$U_I\" \"$C32B\" \"$E32B\" it approved 'IT second.'"
expect "the change request first: then the approval is E_NOT_REVIEWABLE" "$(cat "$T/c32-first-request-first-2")" 'E_NOT_REVIEWABLE'
C32C="$(submitted "$U_M" "$G" "c32c-$RUN" 35)"; E32C="$(env_of "$U_M" "$C32C" claude-ai "$AUD")"
expect "the IT approval is already on the envelope" "$(review "$U_I" "$C32C" "$E32C" it approved "IT before the race.")" 'HTTP 200'
race32 second-approval-first "review \"$U_B\" \"$C32C\" \"$E32C\" business approved 'Business, the second role.'" "review \"$U_X\" \"$C32C\" \"$E32C\" it changes_requested 'Changes after.'"
expect "F7: the second role's approval first: approved, and the change request is E_ENVELOPE_APPROVED, not accepted" "$(cat "$T/c32-second-approval-first-1")|$(cat "$T/c32-second-approval-first-2")" '"candidate_state": *"approved".*|.*E_ENVELOPE_APPROVED'
C32D="$(submitted "$U_M" "$G" "c32d-$RUN" 36)"; E32D="$(env_of "$U_M" "$C32D" claude-ai "$AUD")"
expect "the IT approval is already on the envelope" "$(review "$U_I" "$C32D" "$E32D" it approved "IT before the race.")" 'HTTP 200'
race32 second-request-first "review \"$U_X\" \"$C32D\" \"$E32D\" it changes_requested 'Changes first.'" "review \"$U_B\" \"$C32D\" \"$E32D\" business approved 'Business, too late.'"
expect "F7: the change request first: changes_requested, and the second role's approval is E_NOT_REVIEWABLE" "$(sql -c "select state from app.candidate_versions where id = '$C32D'")|$(cat "$T/c32-second-request-first-2")" '^changes_requested|.*E_NOT_REVIEWABLE'
expect "case 32: never an approved candidate carrying a change request on the envelope that approved it" "$(sql -c "select count(*) from app.review_envelopes e join app.candidate_versions v on v.id = e.candidate_id where e.id in ('$E32A','$E32B','$E32C','$E32D') and v.state = 'approved' and exists (select 1 from app.reviews r where r.envelope_id = e.id and r.decision = 'changes_requested') and (select count(distinct role) from app.reviews r where r.envelope_id = e.id and r.decision = 'approved') = 2")" '^0$'
C32S="$(submitted "$U_M" "$G" "c32s-$RUN" 37)"; E32S="$(env_of "$U_M" "$C32S" claude-ai "$AUD")"
review "$U_I" "$C32S" "$E32S" it approved "IT." >/dev/null
expect "case 32 control, sequential: the second role's approval then the change request give the same outcomes" "$(review "$U_B" "$C32S" "$E32S" business approved "Business.")|$(review "$U_X" "$C32S" "$E32S" it changes_requested "Changes.")" '"candidate_state": *"approved".*|.*E_ENVELOPE_APPROVED'

section "25c case 33: publication racing the second approval, both orders"
C33A="$(submitted "$U_M" "$G" "c33a-$RUN" 38)"; E33A="$(env_of "$U_M" "$C33A" claude-ai "$AUD")"
review "$U_I" "$C33A" "$E33A" it approved "IT." >/dev/null; X33A="$(expected_sha "$C33A" claude-ai)"
DL="$(deadlocks)"
hold_lock 7 c33a "$G"
publish "$U_A" "$C33A" "$E33A" "$X33A" @uuid --aal aal2 > "$T/c33a-publish" &
lock_waiters 'publish_release' 1 || true
review "$U_B" "$C33A" "$E33A" business approved "Business." > "$T/c33a-approve" &
expect "both observed waiting" "$(lock_waiters '_re' 2 && echo waiting)" '^waiting$'
release 7; wait
expect "case 33 publication first: E_NOT_APPROVED, then the approval 200" "$(cat "$T/c33a-publish")|$(cat "$T/c33a-approve")" 'E_NOT_APPROVED.*|HTTP 200'
expect "no release of that envelope" "$(sql -c "select count(*) from app.releases where envelope_id = '$E33A'")" '^0$'
C33B="$(submitted "$U_M" "$G" "c33b-$RUN" 39)"; E33B="$(env_of "$U_M" "$C33B" claude-ai "$AUD")"
review "$U_I" "$C33B" "$E33B" it approved "IT." >/dev/null; X33B="$(expected_sha "$C33B" claude-ai)"
hold_lock 7 c33b "$G"
review "$U_B" "$C33B" "$E33B" business approved "Business." > "$T/c33b-approve" &
lock_waiters 'record_review' 1 || true
publish "$U_A" "$C33B" "$E33B" "$X33B" @uuid --aal aal2 > "$T/c33b-publish" &
expect "both observed waiting" "$(lock_waiters '_re' 2 && echo waiting)" '^waiting$'
release 7; wait
expect "case 33 approval first: 200, then the publication 201" "$(cat "$T/c33b-approve")|$(cat "$T/c33b-publish")" 'HTTP 200.*|.*"existing": *false'
expect "case 33: no release references an envelope that was not approved when it committed" "$(sql -c "select count(*) from app.releases r where r.envelope_id in ('$E33A', '$E33B') and exists (select 1 from app.reviews v where v.envelope_id = r.envelope_id and v.decision = 'approved' and v.created_at > r.published_at)")" '^0$'
expect "case 33: deadlocks unchanged" "$(deadlocks)" "^$DL\$"

section "25d case 35: publication of C2 racing the withdrawal of C1's current release, both orders"
race35() { # label publish-first(yes|no)
  local label="$1" c1 e1 r1 c2 e2 ag x
  c1="$(submitted "$U_M" "$G" "c35$label-$RUN" "$((40 + ${#label}))")"; ag="$(sql -c "select agent_id from app.candidate_versions where id = '$c1'")"
  e1="$(env_of "$U_M" "$c1" claude-ai "$AUD")"; review "$U_I" "$c1" "$e1" it approved "IT." >/dev/null; review "$U_B" "$c1" "$e1" business approved "Business." >/dev/null
  r1="$(field "$(publish_sub "$U_A" "$c1" "$e1" claude-ai)" release_id)"
  c2="$(field "$(draft_by_id "$U_M" "$G" "$ag" "$((50 + ${#label}))")" candidate_id)"; submit "$U_M" "$c2" 1 "$((50 + ${#label}))" >/dev/null
  e2="$(env_of "$U_M" "$c2" claude-ai "$AUD")"; review "$U_I" "$c2" "$e2" it approved "IT." >/dev/null; review "$U_B" "$c2" "$e2" business approved "Business." >/dev/null
  x="$(expected_sha "$c2" claude-ai)"
  DL="$(deadlocks)"
  hold_lock 7 "c35-$label" "$G"
  if [ "$2" = yes ]; then
    publish "$U_A" "$c2" "$e2" "$x" @uuid --aal aal2 > "$T/c35-$label-publish" &
    lock_waiters 'publish_release' 1 || true
    withdraw "$U_A" "$r1" "Withdrawn in the race." @uuid --aal aal2 > "$T/c35-$label-withdraw" &
  else
    withdraw "$U_A" "$r1" "Withdrawn in the race." @uuid --aal aal2 > "$T/c35-$label-withdraw" &
    lock_waiters 'withdraw_release' 1 || true
    publish "$U_A" "$c2" "$e2" "$x" @uuid --aal aal2 > "$T/c35-$label-publish" &
  fi
  expect "case 35 $label: both observed waiting" "$(lock_waiters '_release' 2 && echo waiting)" '^waiting$'
  release 7; wait
  expect "case 35 $label: both succeed" "$(cat "$T/c35-$label-publish" "$T/c35-$label-withdraw" | grep -c '^HTTP 200')" '^2$'
  R35_1="$r1"; R35_2="$(field "$(cat "$T/c35-$label-publish")" release_id)"; C35_1="$c1"
  expect "case 35 $label: C2's release is current" "$(sql -c "select state || '|' || coalesce(superseded_by_release_id::text, 'current') from app.releases where id = '$R35_2'")" '^published|current$'
  expect "case 35 $label: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
}
race35 pubfirst yes
expect "case 35 publication first: R1 superseded by R2, then withdrawn" "$(sql -c "select state || '|' || coalesce(superseded_by_release_id::text, 'none') from app.releases where id = '$R35_1'")" "^withdrawn|$R35_2\$"
expect "one release.supersede and one release.withdraw row for R1, one candidate.supersede for C1" "$(sql -c "select (select count(*) from app.audit_events where action = 'release.supersede' and entity_id = '$R35_1') || '|' || (select count(*) from app.audit_events where action = 'release.withdraw' and entity_id = '$R35_1') || '|' || (select count(*) from app.audit_events where action = 'candidate.supersede' and entity_id = '$C35_1')")" '^1|1|1$'
race35 withdrawfirst no
expect "case 35 withdrawal first: R1 withdrawn and not superseded" "$(sql -c "select state || '|' || coalesce(superseded_by_release_id::text, 'none') from app.releases where id = '$R35_1'")" '^withdrawn|none$'
expect "no release.supersede row for R1 (it was no longer current), one release.withdraw, one candidate.supersede for C1" "$(sql -c "select (select count(*) from app.audit_events where action = 'release.supersede' and entity_id = '$R35_1') || '|' || (select count(*) from app.audit_events where action = 'release.withdraw' and entity_id = '$R35_1') || '|' || (select count(*) from app.audit_events where action = 'candidate.supersede' and entity_id = '$C35_1')")" '^0|1|1$'

section "25e case 36 (B6): moved to tests/db/28-download-concurrency.sh"
# E5 design 2.7 and E5D-C-F7. Case 36's two orders ran here against tests/db/fixtures/e4-download-seam.sql, which
# performed E5's half of the release-lock protocol because no routine existed. The routine exists, the seam is retired,
# and both orders now run against api.authorize_download with an open-transaction hold in probe 28, beside E5's own
# concurrency cases. One copy of a schedule, in the probe that owns the routine it exercises; this line records where
# it went so a reader of E4's design finds it.
expect "case 36 runs in probe 28, which exists and names both B6 orders" "$( [ -f "$ROOT/tests/db/28-download-concurrency.sh" ] && grep -c 'case 36 order [AB]' "$ROOT/tests/db/28-download-concurrency.sh" )" '^[1-9]'

expect "deadlocks unchanged over the whole probe" "$(deadlocks)" "^$DL0\$"
[ "$FAILED" = 0 ] && echo "25 PASS" || { echo "25 FAIL"; exit 1; }
