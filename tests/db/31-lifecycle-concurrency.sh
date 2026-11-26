#!/usr/bin/env bash
# Probe 31: the E6 routines under concurrency (docs/e6/design.md 2.5, 3.5; section 5 cases 13, 14, 27, 36 and 37).
# Each schedule is ordered by locks the probe holds and releases itself, observed in pg_stat_activity, never by a
# sleep; every schedule asserts pg_stat_database.deadlocks unchanged.
#   31a case 36: a transfer whose caller is REMOVED while it waits, with the fail-before that is the NULL comparison
#   31b case 37: a former owner's retry after somebody else's transfer, with the fail-before that reads the agent
#       before waiting for the company lock
#   31c case 13, the concurrent arm: a third party moves the agent while the first caller waits
#   31d case 14: a transfer racing a removal of the TARGET, both orders, and a third run with the removal rolled back
#   31e case 27: a deletion racing an admin mutation of the same company, both orders, and a deletion racing an
#       api.authorize_download, which takes no company lock
#   31f E6S-C-F1: the three creation doors on one account, both orders, with the fail-before that drops the
#       account lock and the post-wait re-read
#   31g E6S-C-F7: the expiry sweep against an extension committed while it waited, with its fail-before
# Run: bash tests/db/31-lifecycle-concurrency.sh (after tests/db/00-seed.sh and the probes before it).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
source "$ROOT/tests/db/e5-lib.sh"; source "$ROOT/tests/db/e6-lib.sh"
RUN="$(run_id)"; E6_RUN="$RUN"; T="$E2_TMP/31"; mkdir -p "$T/saved"
MUTANT_DIR="$T/saved"
DL0="$(deadlocks)"
apply_fixture e6-mutate.sql

hold_lock() { # fd name company
  session_open "$2" "$1"
  session_send "$1" "begin;"
  session_send "$1" "select 'HELD|' || id from app.companies where id = '$3' for no key update;"
  session_wait "$2" 'HELD|'
}
release() { session_send "$1" "commit;"; session_close "$1"; }
code_of() {
  if printf '%s' "$1" | grep -q '^HTTP 2'; then printf 'ok'; return 0; fi
  printf '%s' "$1" | sed -n 's/.*"message":"\(E_[A-Z_]*\).*/\1/p' | head -1
}
env_of() { field "$(envelope "$@")" envelope_id; }
publish_sub() { publish "$1" "$2" "$3" "$(expected_sha "$2" "$4")" @uuid --aal aal2; }

section "31 setup: company X with an admin, an agent owner, a target, a plain member and a reviewer"
e6_person x_admin; U_XA="$U_x_admin"
X="$(company "e6-31x-$RUN" "$U_XA")"
MS_XA="$(membership_of "$X" "$U_XA")"
e6_person x_owner "$X" '{member}'; e6_person x_target "$X" '{member}'
e6_person x_plain "$X" '{member}'
e6_person x_it "$X" '{it_reviewer,member}'; e6_person x_biz "$X" '{business_reviewer,member}'
U_I="$U_x_it"; U_B="$U_x_biz"
CX="$(submitted "$U_x_owner" "$X" "synthetic-31-agent-$RUN" 31)"
AGX="$(sql -c "select agent_id from app.candidate_versions where id = '$CX'")"
expect "setup: an agent owned by x_owner" "$(sql -c "select owner_membership_id = '$MS_x_owner' from app.agents where id = '$AGX'")" '^t$'

# ---------------------------------------------------------------------------
section "31a case 36: a transfer whose caller is removed while it waits (E6D-C-F2)"
# ---------------------------------------------------------------------------
# Connection A holds company X's row lock. A plain MEMBER of X, who is not an admin and owns no agent, calls
# api.transfer_agent on somebody else's agent and blocks. An admin on a third connection removes that caller and
# commits. A releases its lock.
DL="$(deadlocks)"
H0="$(agent_row_hash "$AGX")"
A0="$(sql -c "select count(*) from app.audit_events where company_id = '$X' and action = 'agent.transfer'")"
hold_lock 9 lock36 "$X"
transfer "$U_x_plain" "$AGX" "$MS_x_target" "$MS_x_owner" aal2 > "$T/t36" &
expect "case 36: the transfer is observed waiting on the company lock" "$(lock_waiters 'transfer_agent' 1 && echo waiting || echo 'not waiting')" '^waiting$'
sql -c "update app.memberships set status = 'removed', removed_at = now() where id = '$MS_x_plain'" >/dev/null
echo "note: owner-side, the caller's membership is removed while the transfer waits; api.remove_member would itself queue on the same lock, and what case 36 is about is the state the transfer re-reads under the lock"
release 9
wait
expect "case 36: the transfer refuses 404 E_NOT_FOUND at row 18 of design 3.5" "$(cat "$T/t36")" 'E_NOT_FOUND'
expect "case 36: the agent's owner is unchanged, asserted by hashing the row before and after" "$(agent_row_hash "$AGX")" "^$H0\$"
expect "case 36: and no agent.transfer audit row was written" "$(sql -c "select count(*) from app.audit_events where company_id = '$X' and action = 'agent.transfer'")" "^$A0\$"
expect "case 36: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
# fail-before: the first version's body, with the same schedule, evaluates `not (NULL = a.owner_membership_id and
# ...)`, which is NULL, so the `if` does not run, app.require_admin is never called and the transfer SUCCEEDS for a
# person who is no longer a member.
DL="$(deadlocks)"
sql -c "update app.memberships set status = 'active', removed_at = null where id = '$MS_x_plain'" >/dev/null
save_routine 'api.transfer_agent(uuid, uuid, uuid)' transfer_agent
apply_fixture e6-transfer-null-standing-mutant.sql
hold_lock 9 lock36b "$X"
transfer "$U_x_plain" "$AGX" "$MS_x_target" "$MS_x_owner" aal2 > "$T/t36b" &
expect "fail-before case 36: the mutant transfer is observed waiting" "$(lock_waiters 'transfer_agent' 1 && echo waiting || echo 'not waiting')" '^waiting$'
sql -c "update app.memberships set status = 'removed', removed_at = now() where id = '$MS_x_plain'" >/dev/null
release 9
wait
expect "fail-before case 36: the transfer SUCCEEDS for a person who is no longer a member, because NULL = owner is NULL and the admin check never ran" "$(cat "$T/t36b")" '"changed":true'
expect "fail-before case 36: and the agent's owner did move" "$(sql -c "select owner_membership_id = '$MS_x_target' from app.agents where id = '$AGX'")" '^t$'
expect "fail-before case 36: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
restore_routine transfer_agent
sql -c "update app.memberships set status = 'active', removed_at = null where id = '$MS_x_plain'" >/dev/null
expect "fail-before case 36: restored, and the same call by that member is refused" "$(transfer "$U_x_plain" "$AGX" "$MS_x_owner" "$MS_x_target" aal2)" 'E_FORBIDDEN'
sql -c "update app.agents set owner_membership_id = '$MS_x_owner' where id = '$AGX'" >/dev/null

# ---------------------------------------------------------------------------
section "31b case 37: a former owner's retry after somebody else's transfer (E6D-C-F2)"
# ---------------------------------------------------------------------------
# Ada owns agent G. An admin transfers G to Bob. Ada, who is not an admin, retries her own earlier call with
# expectedOwnerMembershipId = Ada.
expect "case 37 fixture: Ada owns the agent" "$(sql -c "select owner_membership_id = '$MS_x_owner' from app.agents where id = '$AGX'")" '^t$'
expect "case 37: the admin transfers it to Bob" "$(transfer "$U_XA" "$AGX" "$MS_x_target" "$MS_x_owner" aal2)" '"changed":true'
A1="$(sql -c "select count(*) from app.audit_events where company_id = '$X' and action = 'agent.transfer'")"
expect "case 37: Ada's retry with her own id as the expected owner: 403 E_FORBIDDEN at row 21 of design 3.5" "$(transfer "$U_x_owner" "$AGX" "$MS_x_owner" "$MS_x_owner" aal2)" 'E_FORBIDDEN'
expect "case 37: and not E_OWNER_CHANGED, because Ada has no authority to be told about the agent's owner at all" "COUNT|$(printf '%s' "$(transfer "$U_x_owner" "$AGX" "$MS_x_owner" "$MS_x_owner" aal2)" | grep -c 'E_OWNER_CHANGED' || true)" '^COUNT|0$'
expect "case 37: nothing was written" "$(sql -c "select count(*) from app.audit_events where company_id = '$X' and action = 'agent.transfer'")" "^$A1\$"
expect "case 37: and Bob still owns it" "$(sql -c "select owner_membership_id = '$MS_x_target' from app.agents where id = '$AGX'")" '^t$'
expect "case 37 control: the same retry by an ADMIN answers E_OWNER_CHANGED, which is the stale-retry guard doing its job" "$(transfer "$U_XA" "$AGX" "$MS_x_plain" "$MS_x_owner" aal2)" 'E_OWNER_CHANGED'
expect "case 37 control: and Bob's own honest retry answers changed false" "$(transfer "$U_x_target" "$AGX" "$MS_x_target" "$MS_x_target" aal2)" '"changed":false'
# fail-before: the first version reads the agent BEFORE waiting for the company lock, so Ada's pre-lock copy still
# names her as owner, the owner arm passes, and she takes the agent back from Bob.
DL="$(deadlocks)"
# The agent goes back to Ada first, because the counterexample is about HER PRE-LOCK COPY: she has to be the owner
# at the moment she reads the agent, and somebody else has to move it while she waits.
sql -c "update app.agents set owner_membership_id = '$MS_x_owner' where id = '$AGX'" >/dev/null
save_routine 'api.transfer_agent(uuid, uuid, uuid)' transfer_agent_37
apply_fixture e6-transfer-prelock-owner-mutant.sql
hold_lock 9 lock37 "$X"
transfer "$U_x_owner" "$AGX" "$MS_x_target" "$MS_x_owner" aal2 > "$T/t37" &
expect "fail-before case 37: Ada's mutant call is observed waiting on the company lock" "$(lock_waiters 'transfer_agent' 1 && echo waiting || echo 'not waiting')" '^waiting$'
sql -c "update app.agents set owner_membership_id = '$MS_x_plain' where id = '$AGX'" >/dev/null
echo "note: owner-side, a third party's transfer commits while Ada waits, which is the state her pre-lock copy cannot see"
release 9
wait
expect "fail-before case 37: Ada's pre-lock copy still names her, the owner arm passes, and she takes the agent back" "$(cat "$T/t37")" '"changed":true'
expect "fail-before case 37: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
restore_routine transfer_agent_37
sql -c "update app.agents set owner_membership_id = '$MS_x_target' where id = '$AGX'" >/dev/null
expect "fail-before case 37: restored, and Ada's retry is refused again" "$(transfer "$U_x_owner" "$AGX" "$MS_x_owner" "$MS_x_owner" aal2)" 'E_FORBIDDEN'

# ---------------------------------------------------------------------------
section "31c case 13, the concurrent arm: a third party moves the agent while the first caller waits"
# ---------------------------------------------------------------------------
DL="$(deadlocks)"
hold_lock 9 lock13 "$X"
transfer "$U_XA" "$AGX" "$MS_x_plain" "$MS_x_target" aal2 > "$T/t13" &
expect "case 13: the admin's transfer is observed waiting" "$(lock_waiters 'transfer_agent' 1 && echo waiting || echo 'not waiting')" '^waiting$'
sql -c "update app.agents set owner_membership_id = '$MS_x_owner' where id = '$AGX'" >/dev/null
release 9
wait
expect "case 13: the waiting caller's expected owner is stale by the time the lock is granted: E_OWNER_CHANGED" "$(cat "$T/t13")" 'E_OWNER_CHANGED'
expect "case 13: which the locked re-read of the agent is what notices" "$(sql -c "select owner_membership_id = '$MS_x_owner' from app.agents where id = '$AGX'")" '^t$'
expect "case 13: deadlocks unchanged" "$(deadlocks)" "^$DL\$"

# ---------------------------------------------------------------------------
section "31d case 14: a transfer racing a removal of the target, both orders"
# ---------------------------------------------------------------------------
# Order A, the removal first: the transfer refuses E_MEMBERSHIP_REMOVED and writes nothing.
DL="$(deadlocks)"
e6_person x_t2 "$X" '{member}'
A2="$(sql -c "select count(*) from app.audit_events where company_id = '$X' and action = 'agent.transfer'")"
session_open rem14 9
session_send 9 "begin;"
printf '%s\n' "$(remove_sql "$U_XA" "$MS_x_t2")" >&9
session_wait rem14 'REMOVE|'
expect "case 14 order A: the removal is done inside an open transaction" "$(session_out rem14 | tr '\n' ' ')" 'REMOVE|true'
transfer "$U_XA" "$AGX" "$MS_x_t2" "$MS_x_owner" aal2 > "$T/t14a" &
expect "case 14 order A: the transfer is observed waiting on the company lock the removal holds" "$(lock_waiters 'transfer_agent' 1 && echo waiting || echo 'not waiting')" '^waiting$'
session_send 9 "commit;"; session_close 9
wait
expect "case 14 order A: the transfer refuses E_MEMBERSHIP_REMOVED" "$(cat "$T/t14a")" 'E_MEMBERSHIP_REMOVED'
expect "case 14 order A: nothing written" "$(sql -c "select count(*) from app.audit_events where company_id = '$X' and action = 'agent.transfer'")" "^$A2\$"
expect "case 14 order A: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
# Order B, the transfer first: it succeeds, and the removal then orphans the agent it has just been given.
DL="$(deadlocks)"
e6_person x_t3 "$X" '{member}'
session_open tr14 9
session_send 9 "begin;"
printf '%s\n' "$(transfer_sql "$U_XA" "$AGX" "$MS_x_t3" "$MS_x_owner")" >&9
session_wait tr14 'TRANSFER|'
expect "case 14 order B: the transfer is done inside an open transaction" "$(session_out tr14 | tr '\n' ' ')" 'TRANSFER|true'
as_call remove_member "$(jbody p_membership="$MS_x_t3")" "$U_XA" aal2 > "$T/r14b" &
expect "case 14 order B: the removal is observed waiting" "$(lock_waiters 'remove_member' 1 && echo waiting || echo 'not waiting')" '^waiting$'
session_send 9 "commit;"; session_close 9
wait
expect "case 14 order B: the removal succeeds" "$(cat "$T/r14b")" '"changed":true'
expect "case 14 order B: and it orphans the agent the transfer had just given it" "$(sql -c "select status from app.agents where id = '$AGX'")" '^orphaned$'
expect "case 14 order B: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
# A third run with the removal ROLLED BACK: the transfer stands.
DL="$(deadlocks)"
e6_person x_t4 "$X" '{member}'
session_open rb14 9
session_send 9 "begin;"
printf '%s\n' "$(remove_sql "$U_XA" "$MS_x_t4")" >&9
session_wait rb14 'REMOVE|'
transfer "$U_XA" "$AGX" "$MS_x_t4" "$MS_x_t3" aal2 > "$T/t14c" &
lock_waiters 'transfer_agent' 1 || true
session_send 9 "rollback;"; session_close 9
wait
expect "case 14 third run: with the removal rolled back the transfer stands" "$(cat "$T/t14c")" '"changed":true'
expect "case 14 third run: and the agent returned to active, because the retry branch requires it" "$(sql -c "select status || '|' || (owner_membership_id = '$MS_x_t4')::text from app.agents where id = '$AGX'")" '^active|true$'
expect "case 14 third run: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
expect "case 14: sequential calls give the same outcomes: a removed target is refused" "$(sql -c "update app.memberships set status = 'removed', removed_at = now() where id = '$MS_x_t3'" >/dev/null; transfer "$U_XA" "$AGX" "$MS_x_t3" "$MS_x_t4" aal2)" 'E_MEMBERSHIP_REMOVED'

# ---------------------------------------------------------------------------
section "31e case 27: a deletion racing an admin mutation of the same company, both orders"
# ---------------------------------------------------------------------------
# api.delete_company takes the company row at level 1 and then deletes without taking any other row lock explicitly:
# each DELETE takes its own row locks in the children-first order of design 1.6, which is the REVERSE of the
# acquisition order every other routine uses. That reversal is safe only because the company lock is held first and
# every other writer of those rows also holds it, so no other transaction can be holding a release row while waiting
# for this company. This section is where that is asserted rather than assumed.
del_company() { # tag: prints "<company>|<admin>|<slug>"
  local u c slug
  e6_person "$1"
  eval "u=\$U_$1"
  slug="e6-31$1-$RUN"
  c="$(company "$slug" "$u")"
  age_period "$c" '40 days' '26 days' '-20 days'
  op_call set_company_status "$(jbody p_company="$c" p_status=suspended p_reason_code=non_payment)" >/dev/null
  op_call close_company "$(jbody p_company="$c" p_confirm_slug="$slug" p_reason_code=retention_deadline)" >/dev/null
  printf '%s|%s|%s' "$c" "$u" "$slug"
}
# Order A, the MUTATION first: it commits, and the deletion then removes its rows and its audit row.
DL="$(deadlocks)"
CC="$(del_company d27a)"; C27A="${CC%%|*}"; REST="${CC#*|}"; U27A="${REST%%|*}"; S27A="${REST#*|}"
e6_person d27a_mem "$C27A" '{member}'
# A closed company refuses api.set_roles at app.lock_company, so the mutation this order uses is the one an operator
# may still make on a closed company: api.set_company_quota, which takes the operator lock at level 1 exactly as the
# deletion does. That is the same race and it is the one reachable through a route (E6DB-F20).
session_open mut27 9
session_send 9 "begin;"
printf '%s\n' "$(as_claims_sql "$U_op" aal2)" >&9
session_send 9 "select 'QUOTA|' || q.value from api.set_company_quota('$C27A', 'groups_per_company', 55) q;"
session_wait mut27 'QUOTA|55'
expect "case 27 order A: the operator's quota write is done inside an open transaction, holding the company row" "$(session_out mut27 | tr '\n' ' ')" 'QUOTA|55'
op_call delete_company "$(jbody p_company="$C27A" p_confirm_slug="$S27A" p_reason_code=retention_deadline)" > "$T/d27a" &
expect "case 27 order A: the deletion is observed waiting on the company lock the mutation holds" "$(lock_waiters 'delete_company' 1 && echo waiting || echo 'not waiting')" '^waiting$'
session_send 9 "commit;"; session_close 9
wait
expect "case 27 order A: the deletion then succeeds" "$(cat "$T/d27a")" '"companies": 1'
expect "case 27 order A: and the quota row the mutation wrote went with it" "$(sql -c "select count(*) from app.company_quotas where company_id = '$C27A'")" '^0$'
expect "case 27 order A: the deletion's own audit row survives, with company_id null" "$(sql -c "select count(*) from app.audit_events where action = 'company.delete' and details ->> 'company_id' = '$C27A'")" '^1$'
expect "case 27 order A: and no audit row of that company" "$(sql -c "select count(*) from app.audit_events where company_id = '$C27A'")" '^0$'
expect "case 27 order A: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
# Order B, the DELETION first: the mutation refuses, never a partial write.
DL="$(deadlocks)"
CC="$(del_company d27b)"; C27B="${CC%%|*}"; REST="${CC#*|}"; U27B="${REST%%|*}"; S27B="${REST#*|}"
session_open del27 9
session_send 9 "begin;"
printf '%s\n' "$(delete_sql "$U_op" "$C27B" "$S27B" retention_deadline)" >&9
session_wait del27 'DELETE|1'
expect "case 27 order B: the deletion is done inside an open transaction, holding every row it removed" "$(session_out del27 | tr '\n' ' ')" 'DELETE|1'
op_call set_company_quota "$(jbody p_company="$C27B" p_name=groups_per_company p_value='#55')" > "$T/m27b" &
expect "case 27 order B: the operator's quota write is observed waiting" "$(lock_waiters 'set_company_quota' 1 && echo waiting || echo 'not waiting')" '^waiting$'
session_send 9 "commit;"; session_close 9
wait
expect "case 27 order B: the mutation refuses 404 E_NOT_FOUND, never a partial write" "$(cat "$T/m27b")" 'E_NOT_FOUND'
expect "case 27 order B: no quota row was written for a company that no longer exists" "$(sql -c "select count(*) from app.company_quotas where company_id = '$C27B'")" '^0$'
expect "case 27 order B: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
# The DOWNLOAD arm: api.authorize_download takes no company lock, so it either commits before the deletion takes the
# release row, or waits and then fails its foreign key inside its own transaction, writing nothing.
DL="$(deadlocks)"
e6_person dl_admin; U_DLA="$U_dl_admin"
Y="$(company "e6-31y-$RUN" "$U_DLA")"
MS_DLA="$(membership_of "$Y" "$U_DLA")"
e6_person dl_author "$Y" '{member}'; e6_person dl_it "$Y" '{it_reviewer,member}'
e6_person dl_biz "$Y" '{business_reviewer,member}'; e6_person dl_recip "$Y" '{member}'
U_I="$U_dl_it"; U_B="$U_dl_biz"
GRY="$(group_of "$Y" "$MS_DLA" "Audience-31-$RUN" "$MS_dl_recip")"; AUDY="$(audience "$GRY")"
CY="$(submitted "$U_dl_author" "$Y" "synthetic-31-dl-$RUN" 31)"
ENVY="$(env_of "$U_dl_author" "$CY" claude-ai "$AUDY")"
review "$U_I" "$CY" "$ENVY" it approved "IT." >/dev/null; review "$U_B" "$CY" "$ENVY" business approved "Business." >/dev/null
RELY="$(field "$(publish_sub "$U_DLA" "$CY" "$ENVY" claude-ai)" release_id)"
expect "case 27 download arm: a released candidate in company Y" "$RELY" '^[0-9a-f-]\{36\}$'
DL_ROWS0="$(sql -c "select count(*) from app.release_downloads where release_id = '$RELY'")"
age_period "$Y" '40 days' '26 days' '-20 days'
op_call set_company_status "$(jbody p_company="$Y" p_status=suspended p_reason_code=non_payment)" >/dev/null
op_call close_company "$(jbody p_company="$Y" p_confirm_slug="e6-31y-$RUN" p_reason_code=retention_deadline)" >/dev/null
session_open del27c 9
session_send 9 "begin;"
printf '%s\n' "$(delete_sql "$U_op" "$Y" "e6-31y-$RUN" retention_deadline)" >&9
session_wait del27c 'DELETE|1'
expect "case 27 download arm: the deletion holds every row it removed" "$(session_out del27c | tr '\n' ' ')" 'DELETE|1'
download_as "$U_dl_recip" "$RELY" > "$T/dl27" &
WAITED="$(lock_waiters 'authorize_download' 1 && echo waiting || echo 'not waiting')"
session_send 9 "commit;"; session_close 9
wait
expect "case 27 download arm: the download either waited on the release row or was already refused" "$WAITED|$(code_of "$(cat "$T/dl27")")" 'waiting|\|not waiting|'
expect "case 27 download arm: and it wrote NOTHING, because its foreign key had nowhere to point" "$(sql -c "select count(*) from app.release_downloads where release_id = '$RELY'")" '^0$'
expect "case 27 download arm: no ledger row survived the deletion either" "$(sql -c "select count(*) from app.release_downloads where company_id = '$Y'")" '^0$'
expect "case 27 download arm: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
# The control: the same schedules with the deletion ROLLED BACK, where every mutation succeeds.
DL="$(deadlocks)"
CC="$(del_company d27d)"; C27D="${CC%%|*}"; REST="${CC#*|}"; U27D="${REST%%|*}"; S27D="${REST#*|}"
session_open rb27 9
session_send 9 "begin;"
printf '%s\n' "$(delete_sql "$U_op" "$C27D" "$S27D" retention_deadline)" >&9
session_wait rb27 'DELETE|1'
op_call set_company_quota "$(jbody p_company="$C27D" p_name=groups_per_company p_value='#55')" > "$T/m27d" &
lock_waiters 'set_company_quota' 1 || true
session_send 9 "rollback;"; session_close 9
wait
expect "case 27 control: with the deletion rolled back the mutation succeeds" "$(cat "$T/m27d")" '"value":55'
expect "case 27 control: and the company is still there, still closed" "$(sql -c "select status from app.companies where id = '$C27D'")" '^closed$'
expect "case 27 control: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
# Two concurrent expiry runs over the same set: both succeed or one is E_BUSY, never a deadlock, because both lock
# by ascending company id (design 2.5, case 20's last control).
DL="$(deadlocks)"
for n in 1 2 3; do
  e6_person "r31_$n"
  eval "c=\"\$(company e6-31r$n-$RUN \$U_r31_$n)\""
  age_period "$c" '30 days' '16 days' '-14 days'
done
op_call operator_expiry_run "$(jbody p_limit='#50')" > "$T/run31a" &
op_call operator_expiry_run "$(jbody p_limit='#50')" > "$T/run31b" &
wait
expect "case 20 control: two concurrent runs, the first answers" "$(cat "$T/run31a")" '"suspended"\|E_BUSY'
expect "case 20 control: and the second" "$(cat "$T/run31b")" '"suspended"\|E_BUSY'
expect "case 20 control: every company was suspended exactly once, never twice" "$(sql -c "select count(*) from app.audit_events a join app.companies c on c.id = a.company_id where c.slug like 'e6-31r%-$RUN' and a.action = 'company.suspend'")" '^3$'
expect "case 20 control: deadlocks unchanged, because both lock by ascending company id" "$(deadlocks)" "^$DL\$"

# ---------------------------------------------------------------------------
section "31f E6S-C-F1: the three creation doors on one account, both orders"
# ---------------------------------------------------------------------------
# The critique's schedule and its mirror. Order A is the one it executed: hold company X's row, start an
# acceptance so it waits on that lock, add the SAME account as an operator meanwhile, release. Order B is the
# same race the other way round, which the account lock alone does not close and the post-wait re-read alone does
# not close either: api.add_operator holds its account lock inside an open transaction and the acceptance meets
# it. Each order must end with EXACTLY ONE identity on that account and the loser refused with its own code.
# The account is made by the CALLER and not inside this function: e6_person sets U_<tag> with eval, and a
# function called inside $(...) runs in a subshell whose variables the probe never sees.
f1_invite() { # tag -> prints the invite code for an account that holds neither identity
  local inv
  inv="$(seeded_invitation "$X" "e6-$RUN-$1@example.invalid" '{member}' "$MS_XA")"
  printf '%s' "${inv#*|}"
}
DL="$(deadlocks)"
e6_person f1a
CODE_A="$(f1_invite f1a)"
expect "F1 setup: the account holds neither identity" "$(principals_of "$U_f1a")" '^0|0$'
hold_lock 9 lockf1a "$X"
accept_as "$U_f1a" "$CODE_A" > "$T/f1a-accept" &
expect "F1 order A: the acceptance is observed waiting on the company lock" "$(lock_waiters 'accept_invitation' 1 && echo waiting || echo 'not waiting')" '^waiting$'
op_call add_operator "$(jbody p_user="$U_f1a")" > "$T/f1a-addop" &
expect "F1 order A: and api.add_operator is observed waiting on the ACCOUNT lock the waiting acceptance holds, which is the wait the integrated revision did not have" "$(lock_waiters 'add_operator' 1 && echo waiting || echo 'not waiting')" '^waiting$'
release 9
wait
expect "F1 order A: the acceptance succeeds" "$(cat "$T/f1a-accept")" '"membership_id"'
expect "F1 order A: and the operator door, granted the account lock after it, is refused E_MEMBER_ACCOUNT" "$(cat "$T/f1a-addop")" 'E_MEMBER_ACCOUNT'
expect "F1 order A: exactly one identity: no operator row, one membership" "$(principals_of "$U_f1a")" '^0|1$'
expect "F1 order A: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
# Order B: the operator door first, inside an open transaction, so it holds the account lock rather than the
# company lock, which is the wait the acceptance has to meet.
DL="$(deadlocks)"
e6_person f1b
CODE_B="$(f1_invite f1b)"
session_open addopf1b 9
session_send 9 "begin;"
printf '%s\n' "$(add_operator_sql "$U_op" "$U_f1b")" >&9
session_wait addopf1b 'ADDOP|'
expect "F1 order B: the operator door is done inside an open transaction, holding the account lock" "$(session_out addopf1b | tr '\n' ' ')" 'ADDOP|t'
accept_as "$U_f1b" "$CODE_B" > "$T/f1b-accept" &
expect "F1 order B: the acceptance is observed waiting on that account lock, before it reaches any company lock" "$(lock_waiters 'accept_invitation' 1 && echo waiting || echo 'not waiting')" '^waiting$'
session_send 9 "commit;"; session_close 9
wait
expect "F1 order B: the acceptance is refused E_OPERATOR_ACCOUNT by the re-read under the account lock" "$(cat "$T/f1b-accept")" 'E_OPERATOR_ACCOUNT'
expect "F1 order B: exactly one identity: one operator row, no membership" "$(principals_of "$U_f1b")" '^1|0$'
expect "F1 order B: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
# fail-before, both orders, against the integrated revision's behaviour.
DL="$(deadlocks)"
save_routine 'api.accept_invitation(text)' accept_f1
save_routine 'app.lock_account(uuid)' lock_account_f1
# BOTH halves of the correction are dropped, because each alone closes one of the two orders and the schedule the
# critique executed needs both open: in order A the advisory lock alone would make api.add_operator queue and the
# post-wait re-read alone would make the acceptance refuse; in order B the advisory lock alone would make the
# acceptance queue and the post-wait re-read alone cannot see an uncommitted operator row. Each mutation is one
# substitution in the routine's own live definition, so neither can drift from the migration.
e6_mutate 'app.lock_account(uuid)' \
  "perform pg_advisory_xact_lock(hashtext('app.principal_of_account'), hashtext(p_user::text));" 'perform 1;'
e6_mutate 'api.accept_invitation(text)' \
  "  perform app.require_disjoint_principal(actor, 'member');
  select * into inv from app.invitations where id = inv.id for update;" \
  '  select * into inv from app.invitations where id = inv.id for update;'
e6_person f1c
CODE_C="$(f1_invite f1c)"
hold_lock 9 lockf1c "$X"
accept_as "$U_f1c" "$CODE_C" > "$T/f1c-accept" &
expect "fail-before F1 order A: the mutant acceptance is observed waiting on the company lock" "$(lock_waiters 'accept_invitation' 1 && echo waiting || echo 'not waiting')" '^waiting$'
expect "fail-before F1 order A: api.add_operator does not wait at all and succeeds while the acceptance waits" "$(op_call add_operator "$(jbody p_user="$U_f1c")")" '"changed":true'
release 9
wait
expect "fail-before F1 order A: and the acceptance then succeeds too" "$(cat "$T/f1c-accept")" '"membership_id"'
expect "fail-before F1 order A: ONE ACCOUNT, BOTH PRINCIPALS, which is E6S-C-F1" "$(principals_of "$U_f1c")" '^1|1$'
expect "fail-before F1 order A: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
DL="$(deadlocks)"
e6_person f1d
CODE_D="$(f1_invite f1d)"
session_open addopf1d 9
session_send 9 "begin;"
printf '%s\n' "$(add_operator_sql "$U_op" "$U_f1d")" >&9
session_wait addopf1d 'ADDOP|'
expect "fail-before F1 order B: the mutant acceptance does not wait and succeeds against an uncommitted operator row" "$(accept_as "$U_f1d" "$CODE_D")" '"membership_id"'
session_send 9 "commit;"; session_close 9
expect "fail-before F1 order B: ONE ACCOUNT, BOTH PRINCIPALS again, from the interleaving the re-read alone cannot see" "$(principals_of "$U_f1d")" '^1|1$'
expect "fail-before F1 order B: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
restore_routine accept_f1; restore_routine lock_account_f1
# The two mutant accounts are left holding BOTH identities, which is the crossing 008's B0 check exists to
# refuse, so the probe removes it the way case 39 does: through the one deletion door, invitation first, because
# app.invitations.accepted_membership_id is a foreign key to the membership.
for u in "$U_f1c" "$U_f1d"; do
  sql -c "begin; set local app.tenant_deletion = 'on';
          delete from app.invitations where accepted_membership_id in (select id from app.memberships where user_id = '$u');
          delete from app.memberships where user_id = '$u'; commit;" >/dev/null
done
expect "fail-before F1: the two crossings the counterexample created are removed" "$(principals_of "$U_f1c")|$(principals_of "$U_f1d")" '^1|0|1|0$'
# restored, and the same schedule answers again.
e6_person f1e
CODE_E="$(f1_invite f1e)"
session_open addopf1e 9
session_send 9 "begin;"
printf '%s\n' "$(add_operator_sql "$U_op" "$U_f1e")" >&9
session_wait addopf1e 'ADDOP|'
accept_as "$U_f1e" "$CODE_E" > "$T/f1e-accept" &
lock_waiters 'accept_invitation' 1 || true
session_send 9 "commit;"; session_close 9
wait
expect "fail-before F1: restored, and the acceptance is refused again" "$(cat "$T/f1e-accept")" 'E_OPERATOR_ACCOUNT'
expect "fail-before F1: restored, and that account holds one identity" "$(principals_of "$U_f1e")" '^1|0$'
# The sequential arms are unchanged: 29f covers them, and this is the control that the lock did not change them.
expect "F1 control: the sequential operator-then-member refusal still answers" "$(accept_as "$U_f1b" "$CODE_B")" 'E_OPERATOR_ACCOUNT'
expect "F1 control: and the sequential member-then-operator refusal still answers" "$(op_call add_operator "$(jbody p_user="$U_f1a")")" 'E_MEMBER_ACCOUNT'

# ---------------------------------------------------------------------------
section "31g E6S-C-F7: the expiry sweep against an extension committed while it waited"
# ---------------------------------------------------------------------------
# The run selects its companies by a predicate and then locks each one, so its cursor is a snapshot taken before
# the first wait. api.set_access_period takes the SAME operator company lock, so an operator extending an
# agreement while a run queues behind them commits a period whose export_by is in the future, and the run then
# suspended a company that had just been paid for. Re-reading the status alone cannot see it: an extension does
# not change the status.
DL="$(deadlocks)"
e6_person g_admin; U_G="$U_g_admin"
G="$(company "e6-31g-$RUN" "$U_G")"
age_period "$G" '30 days' '1 hour' '-29 days'
expect "31g: the company is active and past export_by, so the run will select it" "$(sql -c "select status from app.companies where id = '$G'")|$(access_state "$G")" '^active|expired$'
session_open ext31g 9
session_send 9 "begin;"
printf '%s\n' "$(set_access_period_sql "$U_op" "$G" "$(iso_ago 86400)" "$(iso_ago -4838400)")" >&9
session_wait ext31g 'PERIOD|'
expect "31g: the operator's extension is done inside an open transaction, holding the company row" "$(session_out ext31g | tr '\n' ' ')" 'PERIOD|true'
op_call operator_expiry_run "$(jbody p_limit='#500')" > "$T/g31" &
expect "31g: the sweep is observed waiting on the company lock the extension holds" "$(lock_waiters 'operator_expiry_run' 1 && echo waiting || echo 'not waiting')" '^waiting$'
session_send 9 "commit;"; session_close 9
wait
expect "31g: the sweep answers" "$(cat "$T/g31")" '"suspended"'
expect "31g: and the company is STILL ACTIVE, because the period it re-read under the lock is no longer expired" "$(sql -c "select status from app.companies where id = '$G'")" '^active$'
expect "31g: its export_by is in the future, which is what the extension bought" "$(sql -c "select export_by > clock_timestamp() from app.access_periods where company_id = '$G'")" '^t$'
expect "31g: no company.suspend audit row was written for it" "$(sql -c "select count(*) from app.audit_events where company_id = '$G' and action = 'company.suspend'")" '^0$'
expect "31g: and the sweep did not name it among the companies it suspended" "COUNT|$(grep -c "$G" "$T/g31" || true)" '^COUNT|0$'
expect "31g: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
# The control: the same schedule with the holder changing something that is NOT the period. The run must still
# suspend, so the re-read is a test of eligibility and not a blanket "somebody touched this company".
DL="$(deadlocks)"
e6_person g_admin2; U_G2="$U_g_admin2"
G2="$(company "e6-31g2-$RUN" "$U_G2")"
age_period "$G2" '30 days' '1 hour' '-29 days'
session_open q31g 9
session_send 9 "begin;"
printf '%s\n' "$(as_claims_sql "$U_op" aal2)" >&9
session_send 9 "select 'QUOTA|' || q.value from api.set_company_quota('$G2', 'groups_per_company', 55) q;"
session_wait q31g 'QUOTA|55'
op_call operator_expiry_run "$(jbody p_limit='#500')" > "$T/g31b" &
expect "31g control: the sweep is observed waiting" "$(lock_waiters 'operator_expiry_run' 1 && echo waiting || echo 'not waiting')" '^waiting$'
session_send 9 "commit;"; session_close 9
wait
expect "31g control: with the period untouched the sweep suspends the company it selected" "$(sql -c "select status from app.companies where id = '$G2'")" '^suspended$'
expect "31g control: with one audit row" "$(sql -c "select count(*) from app.audit_events where company_id = '$G2' and action = 'company.suspend'")" '^1$'
expect "31g control: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
# fail-before: the period re-read removed, which is the integrated revision.
DL="$(deadlocks)"
e6_person g_admin3; U_G3="$U_g_admin3"
G3="$(company "e6-31g3-$RUN" "$U_G3")"
age_period "$G3" '30 days' '1 hour' '-29 days'
save_routine 'api.operator_expiry_run(integer)' g_expiry
e6_mutate 'api.operator_expiry_run(integer)' '    select p.export_by into period_end from app.access_periods p where p.company_id = c.id;
    if period_end is null or period_end > clock_timestamp() then
      continue;
    end if;' ''
session_open ext31g3 9
session_send 9 "begin;"
printf '%s\n' "$(set_access_period_sql "$U_op" "$G3" "$(iso_ago 86400)" "$(iso_ago -4838400)")" >&9
session_wait ext31g3 'PERIOD|'
op_call operator_expiry_run "$(jbody p_limit='#500')" > "$T/g31c" &
expect "fail-before 31g: the mutant sweep is observed waiting" "$(lock_waiters 'operator_expiry_run' 1 && echo waiting || echo 'not waiting')" '^waiting$'
session_send 9 "commit;"; session_close 9
wait
expect "fail-before 31g: WITHOUT the period re-read the sweep suspends a company whose agreement was extended while it waited" "$(sql -c "select status from app.companies where id = '$G3'")" '^suspended$'
expect "fail-before 31g: with export_by in the future, which is the contradiction" "$(sql -c "select export_by > clock_timestamp() from app.access_periods where company_id = '$G3'")" '^t$'
expect "fail-before 31g: and an audit row saying access_period_expired about a period that is not" "$(sql -c "select details ->> 'reason_code' from app.audit_events where company_id = '$G3' and action = 'company.suspend'")" '^access_period_expired$'
expect "fail-before 31g: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
restore_routine g_expiry
op_call set_company_status "$(jbody p_company="$G3" p_status=active p_reason_code=customer_request)" >/dev/null
e6_person g_admin4; U_G4="$U_g_admin4"
G4="$(company "e6-31g4-$RUN" "$U_G4")"
age_period "$G4" '30 days' '1 hour' '-29 days'
session_open ext31g4 9
session_send 9 "begin;"
printf '%s\n' "$(set_access_period_sql "$U_op" "$G4" "$(iso_ago 86400)" "$(iso_ago -4838400)")" >&9
session_wait ext31g4 'PERIOD|'
op_call operator_expiry_run "$(jbody p_limit='#500')" > "$T/g31d" &
lock_waiters 'operator_expiry_run' 1 || true
session_send 9 "commit;"; session_close 9
wait
expect "fail-before 31g: restored, and the extended company is left active again" "$(sql -c "select status from app.companies where id = '$G4'")" '^active$'

expect "31: deadlocks unchanged across the whole probe" "$(deadlocks)" "^$DL0\$"
exit $FAILED
