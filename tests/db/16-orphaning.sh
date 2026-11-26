#!/usr/bin/env bash
# E3 probe 16: agent orphaning in api.remove_member (docs/e3/design.md 2.6 item 4, 4.2; section 6 case 40). Removing
# a membership orphans every active agent it owns in the same transaction, inside the company lock, with one
# agent.orphan audit row each and no candidate row touched. The E2 last-admin probes this changes are re-run by
# reseeding and running tests/db/01 to 06 in order, which evidence/e3a.md records; this probe does not reseed.
# Run: bash tests/db/16-orphaning.sh (after tests/db/00-seed.sh).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
RUN="$(run_id)"; T="$E2_TMP/16"; mkdir -p "$T"; PW16='Synthetic-Pass-1234'

section "16 setup: an admin, an owner of three active agents and one archived agent, a member who owns none"
U_A="$(create_user "e3-16-$RUN-admin@example.invalid" "$PW16")"; G="$(company "e3-16-$RUN" "$U_A")"
U_O="$(create_user "e3-16-$RUN-owner@example.invalid" "$PW16")"; O_MS="$(member "$G" "$U_O" '{member}')"
U_P="$(create_user "e3-16-$RUN-plain@example.invalid" "$PW16")"; P_MS="$(member "$G" "$U_P" '{member}')"
SRV_A="$(server_jwt "$U_A" aal2)"
for i in 1 2 3 4; do
  r="$(draft_by_name "$U_O" "$G" "owned$i-$RUN" "$i")"; eval "AG$i=\"$(field "$r" agent_id)\""; eval "C$i=\"$(field "$r" candidate_id)\""
done
r="$(submit "$U_O" "$C1" 1 1)"; expect "one of the owner's agents holds a submitted candidate" "$r" '"state": *"submitted"'
sql -c "update app.agents set status='archived' where id='$AG4'" >/dev/null
AGENTS="'$AG1','$AG2','$AG3'"
snapshot() { sql -c "select md5(string_agg(v::text, '' order by v.id)) from app.candidate_versions v where v.agent_id in ($AGENTS,'$AG4')"; }
BEFORE="$(snapshot)"

section "16a fail-before: 001's remove_member body, without the orphaning block, leaves the agents active"
MUT="$(mutant 'api.remove_member(uuid)' "  perform 1 from app.agents g" "  return query select target.id, 'removed'::text, true;
  return;
  perform 1 from app.agents g")"
CALL="select set_config('request.jwt.claims', '{\"role\":\"app_server\",\"sub\":\"$U_A\",\"aal\":\"aal2\"}', true); select * from api.remove_member('$O_MS');"
r="$(in_rollback "$MUT;" "$CALL" "select 'MUTANT|'||string_agg(status, ',' order by id) from app.agents where id in ($AGENTS);")"
expect "mutant: the membership is removed and its three agents stay active" "$r" 'MUTANT|active,active,active'

section "16b case 40: the removal waits for the company lock, then orphans all three in its own transaction"
AUD0="$(sql -c "select coalesce(max(id), 0) from app.audit_events")"
hold_company "$G" 2; sleep 0.3
START="$(node -e 'process.stdout.write(String(Date.now()))')"
r="$(rest POST /rpc/remove_member "$SRV_A" "{\"p_membership\":\"$O_MS\"}")"
ELAPSED="$(( $(node -e 'process.stdout.write(String(Date.now()))') - START ))"
wait
expect "the removal succeeds" "$r" '"changed":true'
expect "and it waited behind the other connection's company lock (${ELAPSED} ms)" "$([ "$ELAPSED" -ge 1200 ] && echo waited)" '^waited$'
expect "all three active agents are orphaned" "$(sql -c "select string_agg(status, ',' order by id) from app.agents where id in ($AGENTS)")" '^orphaned,orphaned,orphaned$'
expect "the archived agent stays archived" "$(sql -c "select status from app.agents where id='$AG4'")" '^archived$'
expect "one agent.orphan audit row per orphaned agent, naming the removed membership" "$(sql -c "select count(*)||'|'||count(distinct entity_id)||'|'||bool_and(details->>'membership_id' = '$O_MS' and details->>'agent_status_after' = 'orphaned') from app.audit_events where id > $AUD0 and action='agent.orphan'")" '^3|3|true$'
expect "written in the same transaction as membership.remove (one transaction timestamp)" "$(sql -c "select count(distinct at) from app.audit_events where id > $AUD0 and action in ('agent.orphan','membership.remove')")" '^1$'
expect "no candidate row changed" "$(snapshot)" "^$BEFORE\$"
r="$(rest POST /rpc/remove_member "$SRV_A" "{\"p_membership\":\"$O_MS\"}")"; expect "removing the removed membership again is the E2 no-op, with no second orphan row" "$r|$(sql -c "select count(*) from app.audit_events where id > $AUD0 and action='agent.orphan'")" '"changed":false.*|3$'
sql -c "update app.memberships set status='active', removed_at=null where id='$O_MS'" >/dev/null
expect "reactivating the membership restores nothing" "$(sql -c "select string_agg(status, ',' order by id) from app.agents where id in ($AGENTS)")" '^orphaned,orphaned,orphaned$'

section "16c case 40 control: removing a membership that owns no agent writes no agent.orphan row"
AUD1="$(sql -c "select coalesce(max(id), 0) from app.audit_events")"
r="$(rest POST /rpc/remove_member "$SRV_A" "{\"p_membership\":\"$P_MS\"}")"; expect "the removal succeeds" "$r" '"changed":true'
expect "and writes membership.remove only" "$(sql -c "select string_agg(action, ',') from app.audit_events where id > $AUD1")" '^membership.remove$'
r="$(rest POST /rpc/remove_member "$SRV_A" "{\"p_membership\":\"$(membership_of "$G" "$U_A")\"}")"; expect "the last-admin rule still refuses the sole admin's removal" "$r" 'E_LAST_ADMIN'

[ "$FAILED" = 0 ] && echo "16 PASS" || { echo "16 FAIL"; exit 1; }
