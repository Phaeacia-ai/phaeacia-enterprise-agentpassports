#!/usr/bin/env bash
# E3 probe 15: the idempotency claim (docs/e3/design.md 4.3, 4.5 rows 23 to 26; section 6 cases 12, 39, 42, 43, and
# the routine-level half of case 35's retry matrix, whose HTTP half is E3b). Real minted bearers through PostgREST
# for everything a bearer's life decides (cases 12, 42); owner-side SQL only to age claim rows, which is the one
# clock these cases move, and to build backlogs. Measurements design 7.2 asks for are printed with their seeds and
# written to .scratch/e2/e3-15-measurements.txt. Run: bash tests/db/15-idempotency.sh (after tests/db/00-seed.sh).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
RUN="$(run_id)"; T="$E2_TMP/15"; mkdir -p "$T"; PW15='Synthetic-Pass-1234'
MEAS="$ROOT/.scratch/e2/e3-15-measurements.txt"; : > "$MEAS"
measure() { printf '%s\n' "$*" | tee -a "$MEAS"; }

section "15 setup: one company, an author and five members for the retention and ceiling cases"
U_A="$(create_user "e3-15-$RUN-admin@example.invalid" "$PW15")"; G="$(company "e3-15-$RUN" "$U_A")"
for who in M M3 M4 M5 M6 M7; do
  eval "U_$who=\"\$(create_user \"e3-15-$RUN-$who@example.invalid\" \"$PW15\")\""
  eval "${who}_MS=\"\$(member \"$G\" \"\$U_$who\" '{member}')\""
done
r="$(draft_by_name "$U_M" "$G" "idem-$RUN" 1)"; AG="$(field "$r" agent_id)"; D="$(field "$r" candidate_id)"
expect "setup" "$G|$AG|$D" '^[0-9a-f-]\{36\}|[0-9a-f-]\{36\}|[0-9a-f-]\{36\}$'
version_of() { sql -c "select version from app.candidate_versions where id='$1'"; }
creates() { sql -c "select count(*) from app.audit_events where company_id='$G' and action='candidate.create'"; }

section "15a case 12, sequential: the same bearer replayed, and an honest retry with new derived bytes (H1)"
K="$(uuid)"
r="$(draft_by_id "$U_M" "$G" "$AG" 2 "$K" --save "$T/k1")"; expect "the first attempt writes" "$r" '"idempotent_replay": *false'
C1="$(field "$r" candidate_id)"; V1="$(field "$r" validated_at)"
r="$(E3 replay "$T/k1")"; expect "the identical bearer and body inside its sixty seconds: the stored answer" "$r" "\"idempotent_replay\": *true"
expect "and it names the first candidate" "$(field "$r" candidate_id)" "^$C1\$"
sleep 1.2
r="$(draft_by_id "$U_M" "$G" "$AG" 2 "$K")"; expect "a retry a second later with a newly minted bearer and new validated_at: the stored answer" "$r" '"idempotent_replay": *true'
expect "carrying the first attempt's validated_at, not the retry's" "$(field "$r" validated_at)" "^$V1\$"
expect "one candidate row, one candidate.create audit row, one claim row" "$(sql -c "select (select count(*) from app.candidate_versions where id='$C1')||'|'||(select count(*) from app.audit_events where action='candidate.create' and entity_id='$C1')||'|'||(select count(*) from app.idempotency_keys where membership_id='$M_MS' and key='$K')")" '^1|1|1$'
r="$(draft_by_id "$U_M" "$G" "$AG" 3 "$K")"; expect "the same key with different content: E_IDEMPOTENCY_CONFLICT" "$r" 'E_IDEMPOTENCY_CONFLICT'
r="$(save "$U_M" "$D" 1 3 "$K")"; expect "the same key under another function: E_IDEMPOTENCY_CONFLICT" "$r" 'E_IDEMPOTENCY_CONFLICT'
OP="$(E3 operation-sql create_draft)"; BIND="$(E3 binding-sql create_draft)"
MUT="$(mutant 'api.create_draft(uuid,uuid,text,text,text,bytea,uuid)' "operation bytea := $OP;" "operation bytea := $BIND;")"
K9="$(uuid)"; FIRST="$(E3MODE=sql draft_by_id "$U_M" "$G" "$AG" 9 "$K9")"; sleep 1.2; RETRY="$(E3MODE=sql draft_by_id "$U_M" "$G" "$AG" 9 "$K9")"
r="$(in_rollback "$MUT;" "$FIRST" "$RETRY")"; expect "fail-before (H1): with the bearer digest as the operation identity the honest retry is E_IDEMPOTENCY_CONFLICT" "$r" 'E_IDEMPOTENCY_CONFLICT'
r="$(in_rollback "$FIRST" "$RETRY")"; expect "real: the same two calls, the retry answered from the claim" "$r" '"idempotent_replay": *true'
r="$(draft_by_id "$U_M" "$G" "$AG" 2)"; expect "control: a fresh key with the same content makes a second candidate" "$r" '"idempotent_replay": *false'

section "15b case 12, concurrent: two connections present one key at once"
K2="$(uuid)"; C0="$(creates)"
hold_company "$G" 2; sleep 0.3
draft_by_id "$U_M" "$G" "$AG" 20 "$K2" > "$T/c1" &
draft_by_id "$U_M" "$G" "$AG" 20 "$K2" > "$T/c2" &
wait
expect "both answered 200" "$(cat "$T/c1" "$T/c2" | grep -c 'HTTP 200')" '^2$'
expect "with the same candidate" "$(field "$(cat "$T/c1")" candidate_id)" "^$(field "$(cat "$T/c2")" candidate_id)\$"
expect "one of them the stored answer" "$(cat "$T/c1" "$T/c2" | grep -c '"idempotent_replay": *true')" '^1$'
expect "one claim row and one candidate.create audit row" "$(sql -c "select count(*) from app.idempotency_keys where key='$K2'")|$(( $(creates) - C0 ))" '^1|1$'

section "15c case 35's routine-level half: every replay returns its stored answer before any fresh-only precondition"
KS="$(uuid)"; r="$(save "$U_M" "$D" 1 10 "$KS")"; expect "a save moves the version to 2" "$r" '"version": *2'
r="$(save "$U_M" "$D" 1 10 "$KS")"; expect "the save replayed after the version moved: stored, not E_VERSION_CONFLICT" "$r" '"idempotent_replay": *true'
KB="$(uuid)"; r="$(submit "$U_M" "$D" 2 10 "$KB")"; expect "a submit" "$r" '"state": *"submitted"'
r="$(submit "$U_M" "$D" 2 10 "$KB")"; expect "the submit replayed after the state moved: stored, not E_NOT_DRAFT" "$r" '"idempotent_replay": *true'
KN="$(uuid)"; r="$(draft_by_name "$U_M" "$G" "late-$RUN" 11 "$KN")"; expect "a create by name" "$r" '"idempotent_replay": *false'
r="$(draft_by_name "$U_M" "$G" "late-$RUN" 11 "$KN")"; expect "the create replayed when the agent it names now exists: stored, not E_AGENT_NAME_TAKEN" "$r" '"idempotent_replay": *true'
KC="$(uuid)"; draft_by_id "$U_M" "$G" "$AG" 12 "$KC" >/dev/null
CEIL="create or replace function app.limit_versions_per_agent() returns integer language sql immutable parallel safe set search_path = '' as \$m\$ select 1 \$m\$;"
r="$(in_rollback "$CEIL" "$(E3MODE=sql draft_by_id "$U_M" "$G" "$AG" 12 "$KC")")"; expect "the create replayed with the agent at its version ceiling: stored, not E_VERSION_LIMIT" "$r" '"idempotent_replay": *true'
KG="$(uuid)"; draft_by_id "$U_M" "$G" "$AG" 13 "$KG" >/dev/null
NEW="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update("e3-15 rotated").digest("hex"))')"
ROT="set local app.registry_migration = 'on'; update app.gate_identities set active = false where active; insert into app.gate_identities (identity_sha256, adapter_lock_sha256, validator_version, manifest_sha256, upstream_commit, active) values (decode('$NEW','hex'), sha256('l'), '0.1.0', sha256('m'), repeat('c', 40), true);"
r="$(in_rollback "$ROT" "$(E3MODE=sql draft_by_id "$U_M" "$G" "$AG" 13 "$KG" --gate "$NEW")")"; expect "the create retried across a gate rotation with the new identity: stored, not E_GATE_UNREGISTERED" "$r" '"idempotent_replay": *true'
r="$(in_rollback "$ROT" "$(E3MODE=sql draft_by_id "$U_M" "$G" "$AG" 13 "$(uuid)")")"; expect "control: a fresh key with the retired identity does reach E_GATE_UNREGISTERED" "$r" 'E_GATE_UNREGISTERED'
r="$(save "$U_M" "$D" 1 10)"; expect "control: a fresh key on the moved save reaches E_NOT_DRAFT" "$r" 'E_NOT_DRAFT'
echo "note: the retry after a rule change the stored bytes no longer pass is 422 E_GATE_FAILS_NOW from the service, before the claim (4.5 row 18); E3b"

section "15d case 43: the found-claim branch tests expiry before it compares the operation and before it answers"
r="$(draft_by_name "$U_M" "$G" "b43-$RUN" 30)"; AG43="$(field "$r" agent_id)"
K43="$(uuid)"; r="$(draft_by_id "$U_M" "$G" "$AG43" 30 "$K43")"; expect "a claim for K43" "$r" 'HTTP 200'
sql -c "update app.idempotency_keys set created_at = clock_timestamp() - app.idempotency_window() + interval '30 seconds' where membership_id='$M_MS' and key='$K43'" >/dev/null
r="$(draft_by_id "$U_M" "$G" "$AG43" 31 "$K43")"; expect "control, inside the window, changed bytes: E_IDEMPOTENCY_CONFLICT" "$r" 'E_IDEMPOTENCY_CONFLICT'
r="$(draft_by_id "$U_M" "$G" "$AG43" 30 "$K43")"; expect "control, inside the window, identical bytes: the stored answer" "$r" '"idempotent_replay": *true'
sql -c "update app.idempotency_keys set created_at = clock_timestamp() - app.idempotency_window() - interval '2 seconds' where membership_id='$M_MS' and key='$K43'" >/dev/null
r="$(draft_by_id "$U_M" "$G" "$AG43" 31 "$K43")"; expect "two seconds past the window, changed bytes: E_IDEMPOTENCY_EXPIRED, not the conflict" "$r" 'E_IDEMPOTENCY_EXPIRED'
r="$(draft_by_id "$U_M" "$G" "$AG43" 30 "$K43")"; expect "two seconds past the window, identical bytes: E_IDEMPOTENCY_EXPIRED, not the stored answer" "$r" 'E_IDEMPOTENCY_EXPIRED'
MUT="$(mutant 'app.idempotency_lookup(uuid,uuid,text,bytea)' "if prior.created_at < clock_timestamp() - app.idempotency_window() then" "if false then")"
r="$(in_rollback "$MUT;" "$(E3MODE=sql draft_by_id "$U_M" "$G" "$AG43" 30 "$K43")")"; expect "fail-before: a success-first branch answers the expired identical key from storage" "$r" '"idempotent_replay": *true'
r="$(in_rollback "$MUT;" "$(E3MODE=sql draft_by_id "$U_M" "$G" "$AG43" 31 "$K43")")"; expect "fail-before: and answers the expired changed key with the conflict" "$r" 'E_IDEMPOTENCY_CONFLICT'

section "15e case 42: retention outlives every bearer the claim answered (routine level, real bearers)"
TTL="$(sed -n 's/^const TOKEN_TTL_SECONDS = \([0-9]*\);/\1/p' "$ROOT/lib/db/server.mjs")"
MARGIN="$(sql -c "select extract(epoch from app.idempotency_retention() - app.idempotency_window())::int")"
expect "retention exceeds the window by more than lib/db/server.mjs TOKEN_TTL_SECONDS ($TTL)" "$([ -n "$TTL" ] && [ "$MARGIN" -gt "$TTL" ] && echo "margin $MARGIN > ttl $TTL")" '^margin [0-9]* > ttl [0-9]*$'
r="$(draft_by_name "$U_M" "$G" "r42-$RUN" 40)"; AG42="$(field "$r" agent_id)"
K42="$(uuid)"; r="$(draft_by_id "$U_M" "$G" "$AG42" 40 "$K42")"; C42="$(field "$r" candidate_id)"
sql -c "update app.idempotency_keys set created_at = clock_timestamp() - app.idempotency_window() + interval '20 seconds' where membership_id='$M_MS' and key='$K42'" >/dev/null
r="$(draft_by_id "$U_M" "$G" "$AG42" 40 "$K42" --save "$T/b42")"; expect "a retry twenty seconds inside the window mints a bearer and is answered from the claim" "$r" '"idempotent_replay": *true'
ROWS42="$(sql -c "select count(*) from app.candidate_versions where agent_id='$AG42'")"; C_BEFORE="$(creates)"
sql -c "update app.idempotency_keys set created_at = clock_timestamp() - app.idempotency_window() - interval '1 second' where membership_id='$M_MS' and key='$K42'" >/dev/null
r="$(draft_by_name "$U_M" "$G" "sweep42-$RUN" 41)"; expect "an ordinary successful call for the same membership, one second past the window: its sweep runs" "$r" '"idempotent_replay": *false'
expect "the sweep leaves the claim row, past the window but not past retention" "$(sql -c "select count(*) from app.idempotency_keys where membership_id='$M_MS' and key='$K42'")" '^1$'
r="$(E3 replay "$T/b42")"; expect "the same bearer, same arguments, seconds later and inside its own life: E_IDEMPOTENCY_EXPIRED" "$r" 'E_IDEMPOTENCY_EXPIRED'
expect "no second candidate row and no second candidate.create audit row for that agent" "$(sql -c "select count(*) from app.candidate_versions where agent_id='$AG42'")|$(( $(creates) - C_BEFORE ))" "^$ROWS42|1\$"
echo "note: the one candidate.create counted above is the ordinary call's own new agent draft; the bearer wrote nothing"

section "15f case 42's control: the accepted residual, run and asserted, a bearer refused in the tombstone band writes after the sweep"
K42B="$(uuid)"; r="$(draft_by_id "$U_M" "$G" "$AG42" 42 "$K42B")"; expect "a claim for K42B" "$r" 'HTTP 200'
sql -c "update app.idempotency_keys set created_at = clock_timestamp() - app.idempotency_retention() + interval '20 seconds' where membership_id='$M_MS' and key='$K42B'" >/dev/null
ROWS0="$(sql -c "select count(*) from app.candidate_versions where agent_id='$AG42'")"; AUD0="$(sql -c "select count(*) from app.audit_events where action='candidate.create' and details->>'agent_id'='$AG42'")"
r="$(draft_by_id "$U_M" "$G" "$AG42" 42 "$K42B" --save "$T/b42b")"; expect "RESIDUAL_FIRST: the bearer minted twenty seconds before retention expires is refused" "$r" 'E_IDEMPOTENCY_EXPIRED'
sql -c "update app.idempotency_keys set created_at = clock_timestamp() - app.idempotency_retention() - interval '1 second' where membership_id='$M_MS' and key='$K42B'" >/dev/null
r="$(draft_by_name "$U_M" "$G" "sweep42b-$RUN" 43)"; expect "an ordinary successful call one second past retention" "$r" 'HTTP 200'
expect "its sweep removed the tombstone" "$(sql -c "select count(*) from app.idempotency_keys where membership_id='$M_MS' and key='$K42B'")" '^0$'
r="$(E3 replay "$T/b42b")"; expect "RESIDUAL_SECOND: the same bearer, still inside its sixty seconds, finds no claim and creates a new candidate" "$r" '"idempotent_replay": *false'
r="$(E3 replay "$T/b42b")"; expect "RESIDUAL_REPEAT: replayed once more, the new claim answers it" "$r" '"idempotent_replay": *true'
expect "RESIDUAL_TOTAL_NEW_WRITES: exactly one new candidate row and one new candidate.create row for that agent" "$(( $(sql -c "select count(*) from app.candidate_versions where agent_id='$AG42'") - ROWS0 ))|$(( $(sql -c "select count(*) from app.audit_events where action='candidate.create' and details->>'agent_id'='$AG42'") - AUD0 ))" '^1|1$'

section "15g case 39: bounded retention, the drain, the ceiling"
r="$(draft_by_name "$U_M6" "$G" "drain-$RUN" 50)"; D6="$(field "$r" candidate_id)"
sql -c "insert into app.idempotency_keys (membership_id, key, fn, operation_sha256, response, created_at)
  select '$M6_MS', gen_random_uuid(), 'save_draft', sha256(convert_to(g::text, 'UTF8')), '{}'::jsonb,
         clock_timestamp() - app.idempotency_retention() - interval '1 hour' - make_interval(secs => g)
    from generate_series(1, 10001) g" >/dev/null
past() { sql -c "select count(*) from app.idempotency_keys where membership_id='$1' and created_at < clock_timestamp() - app.idempotency_retention()"; }
all_rows() { sql -c "select count(*) from app.idempotency_keys where membership_id='$1'"; }
expect "seed: 10,001 claim rows past retention for one membership" "$(past "$M6_MS")" '^10001$'
TOTAL0="$(all_rows "$M6_MS")"
r="$(save "$U_M6" "$D6" 1 51)"; expect "one ordinary call" "$r" '"version": *2'
expect "deleted at most the batch of 20: the backlog falls by 20, the total by 19" "$(past "$M6_MS")|$(( TOTAL0 - $(all_rows "$M6_MS") ))" '^9981|19$'
GATEHEX="$(E3 literal hex gate_identity)"; SBIND="$(E3 binding-sql save_draft)"
CONTENT="$(E3 literal content --revision 52)"; DERIVED="$(E3 literal derived --revision 52)"
out="$(sql <<SQL
create function pg_temp.bind(p_candidate uuid, p_expected_version integer, p_content text, p_derived_canonical text, p_gate_identity bytea, p_idempotency_key uuid)
  returns bytea language sql as \$f\$ select $SBIND \$f\$;
create function pg_temp.drain(p_member uuid, p_user uuid, p_candidate uuid, p_content text, p_derived text, p_gate bytea) returns text
language plpgsql as \$d\$
declare
  calls int := 0; max_deleted int := 0; last_deleted int := 0; before_n int; after_n int; v int; k uuid;
  t0 timestamptz := clock_timestamp();
begin
  loop
    exit when (select count(*) from app.idempotency_keys where membership_id = p_member
                 and created_at < clock_timestamp() - app.idempotency_retention()) = 0;
    select count(*) into before_n from app.idempotency_keys where membership_id = p_member;
    select version into v from app.candidate_versions where id = p_candidate;
    k := gen_random_uuid();
    perform set_config('request.jwt.claims', json_build_object('role', 'app_server', 'sub', p_user, 'fn', 'save_draft',
      'args_sha256', encode(pg_temp.bind(p_candidate, v, p_content, p_derived, p_gate, k), 'hex'), 'jti', gen_random_uuid())::text, true);
    perform api.save_draft(p_candidate, v, p_content, p_derived, p_gate, k);
    select count(*) into after_n from app.idempotency_keys where membership_id = p_member;
    calls := calls + 1;
    last_deleted := before_n + 1 - after_n;
    max_deleted := greatest(max_deleted, last_deleted);
  end loop;
  return format('DRAIN calls=%s max-deleted=%s final-delete=%s final-net-change=%s remaining=%s ms=%s', calls, max_deleted, last_deleted,
    1 - last_deleted, (select count(*) from app.idempotency_keys where membership_id = p_member),
    round(extract(epoch from clock_timestamp() - t0) * 1000));
end \$d\$;
select pg_temp.drain('$M6_MS', '$U_M6', '$D6', $CONTENT, $DERIVED, decode('$GATEHEX', 'hex'));
SQL
)"
DRAIN="$(printf '%s\n' "$out" | grep '^DRAIN')"; measure "case 39 drain after the first call (seed: 10,001 rows past retention, one membership, SQL loop of real api.save_draft calls): $DRAIN"
expect "500 more calls drain the 9,981 left, 501 with the first; each deletes at most 20; the last deletes 1 for a net change of 0" "$DRAIN" '^DRAIN calls=500 max-deleted=20 final-delete=1 final-net-change=0 remaining=502 '
echo "note: remaining=502 is the 501 claim rows those 501 calls created plus the create_draft that made the draft"
r="$(draft_by_name "$U_M3" "$G" "c3-$RUN" 60)"; D3="$(field "$r" candidate_id)"
sql -c "insert into app.idempotency_keys (membership_id, key, fn, operation_sha256, response) select '$M3_MS', gen_random_uuid(), 'save_draft', sha256(convert_to(g::text,'UTF8')), '{}'::jsonb from generate_series(1, 3998) g" >/dev/null
UNEXP() { sql -c "select count(*) from app.idempotency_keys where membership_id='$1' and created_at >= clock_timestamp() - app.idempotency_window()"; }
expect "a membership one row below the ceiling" "$(UNEXP "$M3_MS")" '^3999$'
r="$(save "$U_M3" "$D3" 1 61)"; expect "succeeds" "$r" '"version": *2'
expect "and lands exactly on the ceiling" "$(UNEXP "$M3_MS")" '^4000$'
r="$(draft_by_name "$U_M4" "$G" "c4-$RUN" 62)"; D4="$(field "$r" candidate_id)"
sql -c "insert into app.idempotency_keys (membership_id, key, fn, operation_sha256, response) select '$M4_MS', gen_random_uuid(), 'save_draft', sha256(convert_to(g::text,'UTF8')), '{}'::jsonb from generate_series(1, 3999) g" >/dev/null
r="$(save "$U_M4" "$D4" 1 63)"; expect "a membership at the ceiling: E_IDEMPOTENCY_LIMIT" "$r" 'E_IDEMPOTENCY_LIMIT'
expect "its unexpired count never passes the ceiling" "$(UNEXP "$M4_MS")" '^4000$'
MUT="$(mutant 'app.idempotency_ceiling(uuid)' ") >= app.limit_idempotency_rows() then" ") > app.limit_idempotency_rows() then")"
r="$(in_rollback "$MUT;" "$(E3MODE=sql save "$U_M4" "$D4" 1 63)" "select 'STORED|'||count(*) from app.idempotency_keys where membership_id='$M4_MS' and created_at >= clock_timestamp() - app.idempotency_window();")"
expect "fail-before (M3_CEILING_LITERAL): the literal > rule stores row 4,001" "$r" 'STORED|4001'
TOT="$(all_rows "$M_MS")"; r="$(draft_by_name "$U_M" "$G" "nopast-$RUN" 64)"
expect "control: a membership with nothing past retention loses no row to its sweep" "$(( $(all_rows "$M_MS") - TOT ))" '^1$'
r="$(draft_by_name "$U_M5" "$G" "honest-$RUN" 70)"; D5="$(field "$r" candidate_id)"; AG5="$(field "$r" agent_id)"
CONTENT5="$(E3 literal content --revision 71)"; DERIVED5="$(E3 literal derived --revision 71)"
out="$(sql <<SQL
begin;
create function pg_temp.bind(p_candidate uuid, p_expected_version integer, p_content text, p_derived_canonical text, p_gate_identity bytea, p_idempotency_key uuid)
  returns bytea language sql as \$f\$ select $SBIND \$f\$;
create function pg_temp.saves(n int) returns text language plpgsql as \$h\$
declare v int; k uuid; attempted int := 0; refused text := 'none';
begin
  for i in 1..n loop
    attempted := i;
    select version into v from app.candidate_versions where id = '$D5';
    k := gen_random_uuid();
    perform set_config('request.jwt.claims', json_build_object('role','app_server','sub','$U_M5','fn','save_draft',
      'args_sha256', encode(pg_temp.bind('$D5', v, $CONTENT5, $DERIVED5, decode('$GATEHEX','hex'), k),'hex'),'jti', gen_random_uuid())::text, true);
    begin
      perform api.save_draft('$D5', v, $CONTENT5, $DERIVED5, decode('$GATEHEX','hex'), k);
    exception when others then
      refused := sqlerrm || ' at save ' || i;
      exit;
    end;
  end loop;
  return format('HONEST saves-attempted=%s refused=%s claim-rows=%s candidate-rows-for-agent=%s', attempted, refused,
    (select count(*) from app.idempotency_keys where membership_id = '$M5_MS'),
    (select count(*) from app.candidate_versions where agent_id = '$AG5'));
end \$h\$;
select pg_temp.saves(4000);
rollback;
SQL
)"
HONEST="$(printf '%s\n' "$out" | grep '^HONEST')"; measure "case 39 honest reach (one member, one draft, repeated saves, rolled back): $HONEST"
expect "repeated honest saves on one draft reach the ceiling without a single new candidate version" "$HONEST" 'refused=E_IDEMPOTENCY_LIMIT at save 4000 claim-rows=4000 candidate-rows-for-agent=1$'

section "15h design 7.2 measurements: the sweep against backlogs, and beside another session's row locks"
SWEEP() { printf "explain (analyze, buffers, costs off, summary on) with past_retention as (select k.membership_id, k.key from app.idempotency_keys k where k.membership_id = '%s' and k.created_at < clock_timestamp() - app.idempotency_retention() order by k.created_at limit app.idempotency_sweep_batch() for update skip locked) delete from app.idempotency_keys d using past_retention e where d.membership_id = e.membership_id and d.key = e.key;" "$1"; }
for backlog in 0 10001 100001; do
  out="$(in_rollback "insert into app.idempotency_keys (membership_id, key, fn, operation_sha256, response, created_at) select '$M7_MS', gen_random_uuid(), 'save_draft', sha256(convert_to(g::text,'UTF8')), '{}'::jsonb, clock_timestamp() - app.idempotency_retention() - interval '1 hour' - make_interval(secs => g) from generate_series(1, $backlog) g;" "analyze app.idempotency_keys;" "$(SWEEP "$M7_MS")")"
  measure "sweep, backlog $backlog rows past retention for one membership: $(printf '%s\n' "$out" | grep -E 'Delete on|Index Scan|Index Only|Seq Scan|Execution Time|rows=' | tr -s ' ' | tr '\n' ';' | cut -c1-600)"
  # With nothing past retention a planner may reasonably read a small table directly; that plan is recorded above.
  if [ "$backlog" != 0 ]; then
    expect "backlog $backlog: the sweep reads the expiry index, not the table" "$(printf '%s\n' "$out" | grep -c 'Seq Scan on idempotency_keys')" '^0$'
  fi
done
sql -c "insert into app.idempotency_keys (membership_id, key, fn, operation_sha256, response, created_at) select '$M7_MS', gen_random_uuid(), 'save_draft', sha256(convert_to(g::text,'UTF8')), '{}'::jsonb, clock_timestamp() - app.idempotency_retention() - interval '1 hour' - make_interval(secs => g) from generate_series(1, 10001) g" >/dev/null
sql -c "begin; select key from app.idempotency_keys where membership_id='$M7_MS' order by created_at limit 20 for update; select pg_sleep(4); commit;" >/dev/null 2>&1 &
sleep 0.5
START="$(node -e 'process.stdout.write(String(Date.now()))')"
out="$(in_rollback "$(SWEEP "$M7_MS")")"
ELAPSED="$(( $(node -e 'process.stdout.write(String(Date.now()))') - START ))"
wait
measure "sweep beside another session holding row locks on the 20 oldest rows (seed 10,001 past retention): wall ${ELAPSED} ms; $(printf '%s\n' "$out" | grep -E 'Delete on|rows=|Execution Time' | tr -s ' ' | tr '\n' ';' | cut -c1-400)"
expect "it did not wait for the locked rows (well under the other session's 4 s)" "$([ "$ELAPSED" -lt 2500 ] && echo "no wait")" '^no wait$'
expect "and still removed a batch, skipping the locked ones" "$out" 'Delete on idempotency_keys.*\|rows=20'
measure "observed claim rows for the probe's heaviest honest member: $(printf '%s' "$HONEST" | sed 's/.*claim-rows=\([0-9]*\).*/\1/') at the ceiling of 4000, reached only by 4,000 consecutive saves in one run; a week of envelope usage was not simulated"

[ "$FAILED" = 0 ] && echo "15 PASS" || { echo "15 FAIL"; exit 1; }
