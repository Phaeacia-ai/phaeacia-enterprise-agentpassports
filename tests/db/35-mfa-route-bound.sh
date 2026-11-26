#!/usr/bin/env bash
# Probe 35: migration 012, the database half of HB-F2's route bound on wrong second-factor codes (design and record
# evidence/ena7-end1-hbf2.md sections 3, 5 and 10; review F2, debt XRR2-D5): api.mfa_verify_begin, api.mfa_verify_end
# and their two tables, app.mfa_route_attempts and app.mfa_route_reservations. It ports the PGlite cases of
# evidence/ena7-end1-hbf2-repro/pglite/hbf2.test.mjs.txt to the stack, calling through PostgREST under app_server
# bearers and reading the counters and reservations owner-side, and adds the concurrency one PGlite connection cannot.
#
#   35a Q1-1: five begins are allowed and counted; the sixth to eighth are refused, each with retry_after the window's
#       start plus fifteen minutes and no attempt id, moving neither the count nor the window; every reservation of
#       the five is settled and the refusals wrote none
#   35b Q1-3: a valid fifth resets the count; after five failures a sixth is refused before any code is judged
#   35c Q1-4: one budget per account, and another account is untouched
#   35d Q1-5: one microsecond short of the window's end is refused, and the window's end itself, the retry_after a
#       refusal names, is a whole budget again, each moved and tried in one owner transaction so both read one now();
#       the fresh window counts the attempt as its first
#   35e Q1-6: eight attempts ended undecided are each allowed and each refunds its own count
#   35f Q1-6b: begin counts before GoTrue, so five attempts whose end never comes stay counted and the sixth is refused
#       (fail-closed); once the window has passed, the next begin prunes their reservations
#   35g Q1-6c: an outcome outside valid, invalid and undecided raises E_BODY_INVALID and settles nothing
#   35h HB-C2: no refund without the caller's own reservation: a double end, an unknown id, a null id and another
#       account's attempt each refund nothing; the foreign attempt's reservation survives, and its own end refunds it
#       (F6)
#   35i HB-C2: a refund from a window that has since reset does not reach the new window
#   35j P10: a valid end resets the count to the attempts of the current window still in flight, not to 0 (HBF2-R-F1)
#   35k Q1-8: only app_server executes the two routines, by the catalog and through PostgREST; their identity arguments
#       name no user; both tables have RLS on, no policy, and no grant, on the table or on a column, to anon,
#       authenticated, app_server, app_maintenance or service_role
#   35l Q1-8b: a bound server token (an fn claim) is refused E_NOT_SERVER at both routines and writes nothing
#   35m Q1-2, the database half: ten begins for one fresh account, released together from an advisory barrier, allow
#       exactly five, leave the counter at five with five reservations, and deadlock nothing; ten at once through
#       PostgREST, which no barrier can order, give the same outcome
#   35n Q1-2's fail-before: begin re-created from its live definition to read the count without the locking upsert and
#       sleep before it writes; the same schedule then allows more than five. Restored, the definition's md5 is the
#       committed one and the schedule allows five again
#   35o D6: begin and end lock the account's counter row first. A refused begin and an end that finds no reservation
#       each hold the row in their own transaction, and an end sent behind an uncommitted begin waits for it and
#       refunds one of its two counts. Fail-befores: end without its row lock writes over the begin's count, and
#       35n's begin refuses without holding the row
#
# 35m's and 35o's schedules are ordered by locks the probe holds and observes in pg_stat_activity (tests/db/31's
# rule). The one sleep is inside 35n's mutant, where it holds open the race the mutant makes. The mutants are also
# restored by the exit trap. 35o's in-transaction reads need no second session, so they hold on one PGlite connection
# too. HB-C8, the budget and window equal to 004's hook, is tests/e2/unit/factor-bound.test.mjs's and not repeated.
# The GoTrue half of Q1-2 (S11c-route) is the stack suite's.
#
# The fail-before is this probe against a database with 001 to 011 applied: the routines and the tables do not exist,
# so 35a's first owner-side read fails, its begins answer 404 PGRST202, and the probe stops in 35a (on PGlite,
# UP_TO=11 shows the same absence).
#
# Every identity here is this probe's own, and none belongs to a company: the bound is per account. Run:
# bash tests/db/35-mfa-route-bound.sh (after tests/db/00-seed.sh; scripts/check-db.sh runs every
# tests/db/[0-9][0-9]-*.sh in order).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
source "$ROOT/tests/db/e6-lib.sh"
RUN="$(run_id)"; E6_RUN="$RUN"; T="$E2_TMP/35"; mkdir -p "$T"
DL0="$(deadlocks)"
# 35n's and 35o's mutants are restored on any exit, before lib.sh's scratch directory, which holds the saved
# definitions, goes. MUTATED names the saved definition of the one routine a mutant currently replaces.
MUTATED=""
trap 'if [ -n "$MUTATED" ]; then restore_routine "$MUTATED" || echo "35: the routine saved as $MUTATED was NOT restored; reapply 012" >&2; fi; rm -rf "$E2_TMP"' EXIT

BEGIN_SIG='api.mfa_verify_begin()'; END_SIG='api.mfa_verify_end(uuid, text)'
begin_as() { # user [aal=aal1] [extra-claims-json]
  rest POST /rpc/mfa_verify_begin "$(server_jwt "$1" "${2-aal1}" "${3-}")" '{}'
}
end_as() { # user attempt|null outcome|null [aal=aal1] [extra-claims-json]
  rest POST /rpc/mfa_verify_end "$(server_jwt "$1" "${4-aal1}" "${5-}")" "$(jbody p_attempt="$2" p_outcome="$3")"
}
attempt_of() { row_field "$(begin_as "$1")" attempt_id; } # user; empty when refused
# n begins for one account, each ended with the outcome (- ends none). Prints each begin's allowed, "true;" per attempt,
# or the status and code of an answer that has none, such as a 404 PGRST202 before 012.
attempts() { # user n outcome|-
  local i b a out
  i=1; out=""
  while [ "$i" -le "$2" ]; do
    b="$(begin_as "$1")"
    a="$(row_field "$b" allowed)"
    [ -n "$a" ] || a="${b:0:8} $(row_field "$b" code 2>/dev/null)"
    out="$out$a;"
    if [ "$3" != - ]; then end_as "$1" "$(row_field "$b" attempt_id)" "$3" >/dev/null; fi
    i=$((i + 1))
  done
  printf '%s' "$out"
}
failures_of() { sql -c "select coalesce((select failures::text from app.mfa_route_attempts where user_id = '$1'), 'none')"; }
window_of() { sql -c "select coalesce((select window_started_at::text from app.mfa_route_attempts where user_id = '$1'), 'none')"; }
reservations_of() { sql -c "select count(*) from app.mfa_route_reservations where user_id = '$1'"; }
# Whether a refusal's retry_after is the account's window start plus fifteen minutes, compared as timestamps.
is_window_end() { # user retry-after
  sql -c "select coalesce((select (nullif('$2', '')::timestamptz = w.window_started_at + interval '15 minutes')::text from app.mfa_route_attempts w where w.user_id = '$1'), 'none')"
}

# ---------------------------------------------------------------------------
section "35a Q1-1: five attempts are allowed and counted, then refused until the window ends"
# ---------------------------------------------------------------------------
e6_person q1
expect "Q1-1 a fresh account holds no counter row" "$(failures_of "$U_q1")" '^none$'
expect "Q1-1 five begins are allowed, each ended invalid" "$(attempts "$U_q1" 5 invalid)" '^true;true;true;true;true;$'
expect "Q1-1 and each was counted" "$(failures_of "$U_q1")" '^5$'
W="$(window_of "$U_q1")"
for i in 6 7 8; do
  b="$(begin_as "$U_q1")"
  expect "Q1-1 attempt $i is refused" "$b" '"allowed":false'
  expect "Q1-1 attempt $i names the window's start plus fifteen minutes as retry_after" "$(is_window_end "$U_q1" "$(row_field "$b" retry_after)")" '^true$'
  expect "Q1-1 attempt $i reserves nothing: no attempt id" "ATTEMPT|$(row_field "$b" attempt_id)" '^ATTEMPT|$'
done
expect "Q1-1 the refusals moved neither the count" "$(failures_of "$U_q1")" '^5$'
expect "Q1-1 nor the window" "$(window_of "$U_q1")" "^$W\$"
expect "Q1-1 every reservation is settled, and the refused begins wrote none" "$(reservations_of "$U_q1")" '^0$'

# ---------------------------------------------------------------------------
section "35b Q1-3: a valid fifth resets the count; a sixth after five failures is refused whatever its code"
# ---------------------------------------------------------------------------
e6_person q3; e6_person q3x
expect "Q1-3 four wrong codes" "$(attempts "$U_q3" 4 invalid)" '^true;true;true;true;$'
A="$(attempt_of "$U_q3")"
expect "Q1-3 the fifth is allowed" "ATTEMPT|$A" '^ATTEMPT|[0-9a-f-]\{36\}$'
expect "Q1-3 its valid end answers" "$(end_as "$U_q3" "$A" valid)" '^HTTP 20[04]'
expect "Q1-3 and resets the count" "$(failures_of "$U_q3")|$(reservations_of "$U_q3")" '^0|0$'
expect "Q1-3 another account: five wrong codes" "$(attempts "$U_q3x" 5 invalid)" '^true;true;true;true;true;$'
expect "Q1-3 its sixth is refused at begin, so a correct sixth code never reaches GoTrue" "$(begin_as "$U_q3x")" '"allowed":false'

# ---------------------------------------------------------------------------
section "35c Q1-4: one budget per account"
# ---------------------------------------------------------------------------
e6_person q4; e6_person q4x
expect "Q1-4 five wrong codes on one account" "$(attempts "$U_q4" 5 invalid)" '^true;true;true;true;true;$'
expect "Q1-4 that account is refused" "$(begin_as "$U_q4")" '"allowed":false'
expect "Q1-4 another account is allowed meanwhile" "$(begin_as "$U_q4x")" '"allowed":true'
expect "Q1-4 and counted on its own row" "$(failures_of "$U_q4x")" '^1$'
expect "Q1-4 the first account is still refused, its count unmoved" "$(begin_as "$U_q4")|$(failures_of "$U_q4")" '"allowed":false.*|5$'

# ---------------------------------------------------------------------------
section "35d Q1-5: the window, refused a microsecond before it ends, a whole budget at its end"
# ---------------------------------------------------------------------------
# The owner moves the window and the begin runs in the same transaction, so both read one now() and the boundary is
# exact, with no wall-clock margin for psql, node and PostgREST start-up to eat (CR35-2).
aged_begin() { # user offset rollback|commit: the window started fifteen minutes before now() plus the offset
  { printf 'begin;\n'; as_claims_sql "$1" aal1
    printf "update app.mfa_route_attempts set window_started_at = now() - interval '15 minutes' + interval '%s' where user_id = '%s';\n" "$2" "$1"
    printf "select 'ALLOWED|' || b.allowed from api.mfa_verify_begin() b;\n%s;\n" "$3"; } | sql_try
}
e6_person q5
expect "Q1-5 five wrong codes" "$(attempts "$U_q5" 5 invalid)" '^true;true;true;true;true;$'
expect "Q1-5 one microsecond short of the window's end: refused" "$(aged_begin "$U_q5" '1 microsecond' rollback)" '^ALLOWED|false$'
expect "Q1-5 at the window's end, the retry_after a refusal names: a whole budget again, this attempt allowed" "$(aged_begin "$U_q5" '0 seconds' commit)" '^ALLOWED|true$'
expect "Q1-5 and the fresh window counts it as its first failure, started now" "$(sql -c "select failures || '|' || (window_started_at > now() - interval '1 minute') from app.mfa_route_attempts where user_id = '$U_q5'")" '^1|true$'

# ---------------------------------------------------------------------------
section "35e Q1-6: undecided refunds what its own begin counted, so outages do not lock the account"
# ---------------------------------------------------------------------------
e6_person q6
expect "Q1-6 eight attempts GoTrue judged nothing about are each allowed" "$(attempts "$U_q6" 8 undecided)" '^true;true;true;true;true;true;true;true;$'
expect "Q1-6 each refunded its own count, and every reservation is settled" "$(failures_of "$U_q6")|$(reservations_of "$U_q6")" '^0|0$'

# ---------------------------------------------------------------------------
section "35f Q1-6b: begin counts before GoTrue, so an attempt whose end never comes is a failure"
# ---------------------------------------------------------------------------
e6_person q6b
expect "Q1-6b five begins whose end never comes are allowed" "$(attempts "$U_q6b" 5 -)" '^true;true;true;true;true;$'
expect "Q1-6b each was counted at its begin" "$(failures_of "$U_q6b")" '^5$'
expect "Q1-6b so the sixth is refused (fail-closed)" "$(begin_as "$U_q6b")" '"allowed":false'
expect "Q1-6b and the five reservations are still open" "$(reservations_of "$U_q6b")" '^5$'
sql -c "update app.mfa_route_attempts set window_started_at = now() - interval '16 minutes' where user_id = '$U_q6b';
        update app.mfa_route_reservations set window_started_at = now() - interval '16 minutes', created_at = now() - interval '16 minutes' where user_id = '$U_q6b'" >/dev/null
expect "Q1-6b once the window has passed, the next begin is allowed" "$(begin_as "$U_q6b")" '"allowed":true'
expect "Q1-6b and it pruned the five stale reservations, keeping its own" "$(reservations_of "$U_q6b")" '^1$'

# ---------------------------------------------------------------------------
section "35g Q1-6c: an outcome outside the three words raises and settles nothing"
# ---------------------------------------------------------------------------
e6_person q6c
A="$(attempt_of "$U_q6c")"
for word in maybe Valid '' 'invalid '; do
  expect "Q1-6c the outcome '$word' raises E_BODY_INVALID" "$(end_as "$U_q6c" "$A" "$word")" 'E_BODY_INVALID'
done
expect "Q1-6c a null outcome raises E_BODY_INVALID" "$(end_as "$U_q6c" "$A" null)" 'E_BODY_INVALID'
expect "Q1-6c the refused ends settled nothing: the count and the reservation stand" "$(failures_of "$U_q6c")|$(reservations_of "$U_q6c")" '^1|1$'
expect "Q1-6c control: the same attempt's undecided end refunds it" "$(end_as "$U_q6c" "$A" undecided >/dev/null; failures_of "$U_q6c")|$(reservations_of "$U_q6c")" '^0|0$'

# ---------------------------------------------------------------------------
section "35h HB-C2: no refund without the caller's own reservation"
# ---------------------------------------------------------------------------
e6_person c2; e6_person c2x
expect "HB-C2 four wrong codes" "$(attempts "$U_c2" 4 invalid)" '^true;true;true;true;$'
A="$(attempt_of "$U_c2")"
expect "HB-C2 the fifth is counted" "$(failures_of "$U_c2")" '^5$'
expect "HB-C2 its undecided end answers" "$(end_as "$U_c2" "$A" undecided)" '^HTTP 20[04]'
expect "HB-C2 and refunds its one count" "$(failures_of "$U_c2")" '^4$'
expect "HB-C2 a second end of the same attempt refunds nothing" "$(end_as "$U_c2" "$A" undecided >/dev/null; failures_of "$U_c2")" '^4$'
expect "HB-C2 an unknown attempt id refunds nothing" "$(end_as "$U_c2" "$(uuid)" undecided >/dev/null; failures_of "$U_c2")" '^4$'
expect "HB-C2 an end naming no attempt, as after a refused begin, refunds nothing" "$(end_as "$U_c2" null undecided >/dev/null; failures_of "$U_c2")" '^4$'
THEIRS="$(attempt_of "$U_c2x")"
expect "HB-C2 another account's attempt is counted and reserved for it" "$(failures_of "$U_c2x")|$(reservations_of "$U_c2x")" '^1|1$'
expect "HB-C2 that attempt's undecided end, sent under this account, refunds nothing here" "$(end_as "$U_c2" "$THEIRS" undecided >/dev/null; failures_of "$U_c2")" '^4$'
expect "HB-C2 nor does its valid end reset this account" "$(end_as "$U_c2" "$THEIRS" valid >/dev/null; failures_of "$U_c2")" '^4$'
expect "HB-C2 and the other account is still counted" "$(failures_of "$U_c2x")" '^1$'
expect "HB-C2 F6: its reservation is not consumed by another account's end" "$(reservations_of "$U_c2x")" '^1$'
expect "HB-C2 F6: and its own end still refunds it" "$(end_as "$U_c2x" "$THEIRS" undecided >/dev/null; failures_of "$U_c2x")|$(reservations_of "$U_c2x")" '^0|0$'

# ---------------------------------------------------------------------------
section "35i HB-C2: a refund from a window that has since reset does not reach the new window"
# ---------------------------------------------------------------------------
e6_person c2w
expect "HB-C2 window: four wrong codes in window 1" "$(attempts "$U_c2w" 4 invalid)" '^true;true;true;true;$'
STALE="$(attempt_of "$U_c2w")"
expect "HB-C2 window: the fifth is still in flight, reserved in window 1" "ATTEMPT|$STALE" '^ATTEMPT|[0-9a-f-]\{36\}$'
sql -c "update app.mfa_route_attempts set window_started_at = now() - interval '16 minutes' where user_id = '$U_c2w';
        update app.mfa_route_reservations set window_started_at = now() - interval '16 minutes' where attempt_id = '$STALE'" >/dev/null
expect "HB-C2 window: window 1 has passed, so a guess opens window 2" "$(begin_as "$U_c2w")" '"allowed":true'
expect "HB-C2 window: window 2 holds that one failure" "$(failures_of "$U_c2w")" '^1$'
expect "HB-C2 window: the stale attempt's undecided end answers" "$(end_as "$U_c2w" "$STALE" undecided)" '^HTTP 20[04]'
expect "HB-C2 window: and leaves window 2 alone" "$(failures_of "$U_c2w")" '^1$'
expect "HB-C2 window: the stale reservation is settled, the guess's still open" "$(sql -c "select count(*) from app.mfa_route_reservations where attempt_id = '$STALE'")|$(reservations_of "$U_c2w")" '^0|1$'

# ---------------------------------------------------------------------------
section "35j P10: a valid code resets to the attempts still in flight, so their wrong codes still count"
# ---------------------------------------------------------------------------
e6_person p10; e6_person p10x
INFLIGHT=""
i=1
while [ "$i" -le 4 ]; do INFLIGHT="$INFLIGHT $(attempt_of "$U_p10")"; i=$((i + 1)); done
MINE="$(attempt_of "$U_p10")"
expect "P10 five begins in flight, all counted and reserved" "$(failures_of "$U_p10")|$(reservations_of "$U_p10")" '^5|5$'
expect "P10 the fifth's valid end answers" "$(end_as "$U_p10" "$MINE" valid)" '^HTTP 20[04]'
expect "P10 and resets the count to the four still in flight, not to 0" "$(failures_of "$U_p10")" '^4$'
for a in $INFLIGHT; do end_as "$U_p10" "$a" invalid >/dev/null; done
expect "P10 their wrong codes, judged after the reset, were already counted" "$(failures_of "$U_p10")|$(reservations_of "$U_p10")" '^4|0$'
expect "P10 one more guess is allowed" "$(begin_as "$U_p10")" '"allowed":true'
expect "P10 and the budget is spent: five judged in the window, not nine" "$(begin_as "$U_p10")" '"allowed":false'
LONE="$(attempt_of "$U_p10x")"
expect "P10 control: with nothing in flight, a valid end resets to 0" "$(end_as "$U_p10x" "$LONE" valid >/dev/null; failures_of "$U_p10x")" '^0$'

# ---------------------------------------------------------------------------
section "35k Q1-8: only app_server executes the two routines; neither takes a user; the tables are granted to nobody"
# ---------------------------------------------------------------------------
routine_catalog() { # name signature
  expect "Q1-8 $2: executable by app_server alone, with no PUBLIC grant" "$(sql -c "select string_agg(grantee, ',' order by grantee) from information_schema.routine_privileges where specific_schema = 'api' and routine_name = '$1' and grantee <> 'postgres'")" '^app_server$'
  expect "Q1-8 $2: execute for app_server, and not for anon, authenticated, service_role or app_maintenance" \
    "$(sql -c "select has_function_privilege('app_server', '$2', 'execute') || '|' || has_function_privilege('anon', '$2', 'execute') || '|' || has_function_privilege('authenticated', '$2', 'execute') || '|' || has_function_privilege('service_role', '$2', 'execute') || '|' || has_function_privilege('app_maintenance', '$2', 'execute')")" \
    '^true|false|false|false|false$'
  expect "Q1-8 $2: SECURITY DEFINER with an empty search_path" "$(sql -c "select p.prosecdef || '|' || array_to_string(p.proconfig, ',') from pg_proc p where p.oid = '$2'::regprocedure")" '^true|search_path=""$'
}
routine_catalog mfa_verify_begin "$BEGIN_SIG"
routine_catalog mfa_verify_end "$END_SIG"
expect "Q1-8 their identity arguments: begin takes none and end the attempt and the outcome, so neither takes a user" \
  "$(sql -c "select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ';' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.proname in ('mfa_verify_begin', 'mfa_verify_end')")" \
  '^mfa_verify_begin();mfa_verify_end(p_attempt uuid, p_outcome text)$'
expect "Q1-8 their results: begin's three columns, which the route reads, and end's void" \
  "$(sql -c "select pg_get_function_result('$BEGIN_SIG'::regprocedure) || '|' || pg_get_function_result('$END_SIG'::regprocedure)")" \
  '^TABLE(allowed boolean, retry_after timestamp with time zone, attempt_id uuid)|void$'
e6_person q8
expect "Q1-8 the account's own authenticated token: no execute on begin" "$(rest POST /rpc/mfa_verify_begin "$(user_token "$U_q8" aal1)" '{}')" 'permission denied for function mfa_verify_begin'
expect "Q1-8 nor on end" "$(rest POST /rpc/mfa_verify_end "$(user_token "$U_q8" aal1)" "$(jbody p_attempt="$(uuid)" p_outcome=undecided)")" 'permission denied for function mfa_verify_end'
# anon has no USAGE on schema api (001), so its calls stop at the schema before any function grant is read; the
# catalog lines above hold the grant itself (CR35-3).
expect "Q1-8 anon: begin is refused at schema api" "$(rest POST /rpc/mfa_verify_begin "$ANON_KEY" '{}')" 'permission denied for schema api'
expect "Q1-8 anon: and so is end" "$(rest POST /rpc/mfa_verify_end "$ANON_KEY" "$(jbody p_attempt="$(uuid)" p_outcome=undecided)")" 'permission denied for schema api'
expect "Q1-8 service_role: no execute on begin" "$(rest POST /rpc/mfa_verify_begin "$SERVICE_ROLE_KEY" '{}')" '42501'
expect "Q1-8 service_role: nor on end" "$(rest POST /rpc/mfa_verify_end "$SERVICE_ROLE_KEY" "$(jbody p_attempt="$(uuid)" p_outcome=undecided)")" '42501'
expect "Q1-8 and the refused calls wrote no counter row for the account" "$(failures_of "$U_q8")" '^none$'
for t in mfa_route_attempts mfa_route_reservations; do
  expect "Q1-8 app.$t: RLS enabled, no policy" "$(sql -c "select c.relrowsecurity || '|' || (select count(*) from pg_policies where schemaname = 'app' and tablename = '$t') from pg_class c where c.oid = 'app.$t'::regclass")" '^true|0$'
  expect "Q1-8 app.$t: no grant to anyone but the owner, on the table or on any column" "$(sql -c "select (select count(*) from information_schema.table_privileges where table_schema = 'app' and table_name = '$t' and grantee <> 'postgres') + (select count(*) from information_schema.column_privileges where table_schema = 'app' and table_name = '$t' and grantee <> 'postgres')")" '^0$'
  expect "Q1-8 app.$t: anon, authenticated, app_server, app_maintenance and service_role may neither read nor write it, by table or by column" \
    "$(sql -c "select (select bool_or(has_table_privilege(r, 'app.$t', p)) from unnest(array['anon', 'authenticated', 'app_server', 'app_maintenance', 'service_role']) r, unnest(array['select', 'insert', 'update', 'delete', 'truncate']) p) or (select bool_or(has_any_column_privilege(r, 'app.$t', p)) from unnest(array['anon', 'authenticated', 'app_server', 'app_maintenance', 'service_role']) r, unnest(array['select', 'insert', 'update']) p)")" '^f$'
done

# ---------------------------------------------------------------------------
section "35l Q1-8b: a bound server token (an fn claim) reaches neither routine"
# ---------------------------------------------------------------------------
e6_person q8b
BOUND='{"fn":"submit_candidate","args_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","jti":"3c9e1f2a-6b7d-4e8f-a1b2-c3d4e5f60718"}'
expect "Q1-8b a bound token's begin: E_NOT_SERVER" "$(begin_as "$U_q8b" aal1 "$BOUND")" 'E_NOT_SERVER'
expect "Q1-8b and it wrote nothing" "$(failures_of "$U_q8b")|$(reservations_of "$U_q8b")" '^none|0$'
A="$(attempt_of "$U_q8b")"
expect "Q1-8b a bound token's end of the account's own attempt: E_NOT_SERVER" "$(end_as "$U_q8b" "$A" undecided aal1 "$BOUND")" 'E_NOT_SERVER'
expect "Q1-8b and it settled nothing" "$(failures_of "$U_q8b")|$(reservations_of "$U_q8b")" '^1|1$'

# ---------------------------------------------------------------------------
section "35m Q1-2, the database half: ten begins for one fresh account at once"
# ---------------------------------------------------------------------------
# One begin as SQL for an owner session: the claims a server bearer carries, the shared side of the barrier's
# advisory lock, then the call. The owner runs the definer routine as PostgREST's app_server would; 35k holds the grant.
begin_sql() { # user barrier-key
  printf 'begin;\n'
  as_claims_sql "$1" aal1
  printf "select pg_advisory_xact_lock_shared(hashtext('%s'));\n" "$2"
  printf "select 'ATTEMPT|' || b.allowed || '|' || coalesce(b.attempt_id::text, 'none') from api.mfa_verify_begin() b;\n"
  printf 'commit;\n'
}
# Ten begins for one account, each its own psql session, held behind a barrier until all ten are observed waiting on
# it, then released together. Each writes $T/<tag>-1 to -10; $T/<tag>-waited says whether all ten were seen waiting.
# A barrier that never answers is ended, and written there too, so the line reading it fails and the probe goes on to
# the restore and the lines after it, where a bare hold_barrier would stop it under set -e with no FAIL line.
ten_at_once() { # user tag
  local i key="mfa35-$RUN-$2-barrier" held=held
  if ! hold_barrier 9 "$2" "$key"; then held='barrier not held'; session_kill "$2"; session_close 9; fi
  i=1
  while [ "$i" -le 10 ]; do
    begin_sql "$1" "$key" | sql_try > "$T/$2-$i" &
    i=$((i + 1))
  done
  if [ "$held" != held ]; then printf '%s' "$held" > "$T/$2-waited"
  elif lock_waiters "$key" 10 300; then printf 'waiting' > "$T/$2-waited"; else printf 'not waiting' > "$T/$2-waited"; fi
  if [ "$held" = held ]; then release_barrier 9; fi
  wait
}
answers_of() { cat "$T/$1"-[0-9]* | grep -c "^ATTEMPT|$2|" || true; } # tag true|false
# How many of the attempt ids the tag's allowed sessions printed are reservations of the account.
reserved_of() { # user tag
  local ids
  ids="$(cat "$T/$2"-[0-9]* | sed -n "s/^ATTEMPT|true|\([0-9a-f-]*\)$/'\1'/p" | tr '\n' ',' | sed 's/,$//')"
  sql -c "select count(*) from app.mfa_route_reservations where user_id = '$1' and attempt_id::text in (${ids:-''})"
}
DL="$(deadlocks)"
e6_person cc
expect "Q1-2 the account is fresh: no counter row" "$(failures_of "$U_cc")" '^none$'
ten_at_once "$U_cc" q2
expect "Q1-2 the ten sessions were observed waiting on the barrier together, so they were released at once" "$(cat "$T/q2-waited")" '^waiting$'
expect "Q1-2 exactly five were allowed" "$(answers_of q2 true)" '^5$'
expect "Q1-2 and exactly five refused, with no attempt id" "$(cat "$T"/q2-[0-9]* | grep -c '^ATTEMPT|false|none$' || true)" '^5$'
expect "Q1-2 the counter stands at five" "$(failures_of "$U_cc")" '^5$'
expect "Q1-2 five reservations exist, and they are the five allowed attempts" "$(reservations_of "$U_cc")|$(reserved_of "$U_cc" q2)" '^5|5$'
expect "Q1-2 deadlocks unchanged" "$(deadlocks)" "^$DL\$"
# Through PostgREST: each request is its own transaction, so no barrier orders them; any order must give five.
e6_person ccr
J="$(server_jwt "$U_ccr" aal1)"
i=1
while [ "$i" -le 10 ]; do
  rest POST /rpc/mfa_verify_begin "$J" '{}' > "$T/q2r-$i" &
  i=$((i + 1))
done
wait
expect "Q1-2 through PostgREST: all ten answered 200" "$(cat "$T"/q2r-* | grep -c '^HTTP 200 ' || true)" '^10$'
expect "Q1-2 through PostgREST: exactly five allowed" "$(cat "$T"/q2r-* | grep -c '"allowed":true' || true)" '^5$'
expect "Q1-2 through PostgREST: the counter at five, with five reservations" "$(failures_of "$U_ccr")|$(reservations_of "$U_ccr")" '^5|5$'

# ---------------------------------------------------------------------------
section "35n Q1-2's fail-before: a begin that reads the count without the locking upsert"
# ---------------------------------------------------------------------------
# The mutant is one substitution in the live definition (tests/db/fixtures/e6-mutate.sql), so it cannot drift from
# 012, and an anchor 012 no longer holds raises. It reads the row without locking it, sleeps, then writes the count it
# read plus one. Released together for a fresh account, the first session creates the row, and the nine queued behind
# its insert each read the count it committed while none of them has yet written its own.
DL="$(deadlocks)"
apply_fixture e6-mutate.sql
md5_of() { sql -c "select md5(pg_get_functiondef('$1'::regprocedure))"; } # signature
MD5_0="$(md5_of "$BEGIN_SIG")"
save_routine "$BEGIN_SIG" mfa_begin_35; MUTATED=mfa_begin_35
UPSERT='  insert into app.mfa_route_attempts as w (user_id, window_started_at, failures)
  values (actor, now(), 0)
  on conflict (user_id) do update set updated_at = now()
  returning w.window_started_at, w.failures into started, failed;'
RACY='  insert into app.mfa_route_attempts (user_id, window_started_at, failures)
  values (actor, now(), 0)
  on conflict (user_id) do nothing;
  select w.window_started_at, w.failures into started, failed
    from app.mfa_route_attempts w where w.user_id = actor;
  perform pg_sleep(0.3);'
expect "fail-before Q1-2: the mutant is installed from the live definition (the upsert anchor exists)" "$(e6_mutate "$BEGIN_SIG" "$UPSERT" "$RACY" 2>&1 && echo installed || echo 'not installed')" '^installed$'
expect "fail-before Q1-2: the live definition is no longer the committed one" "$([ "$(md5_of "$BEGIN_SIG")" != "$MD5_0" ] && echo changed || echo same)" '^changed$'
e6_person ccm
ten_at_once "$U_ccm" q2m
expect "fail-before Q1-2: the ten mutant sessions were observed waiting on the barrier together" "$(cat "$T/q2m-waited")" '^waiting$'
N="$(answers_of q2m true)"
expect "fail-before Q1-2: MORE THAN FIVE are allowed, because the nine behind the first each read a count another had not yet written" "$([ "${N:-0}" -gt 5 ] && echo "MORE|$N" || echo "NOT MORE|$N")" '^MORE|'
expect "fail-before Q1-2: and the counter fell behind the attempts it let through" "$(sql -c "select coalesce((select (failures < ${N:-0})::text from app.mfa_route_attempts where user_id = '$U_ccm'), 'none')")" '^true$'
expect "fail-before Q1-2: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
restore_routine mfa_begin_35; MUTATED=""
expect "fail-before Q1-2: restored, the definition's md5 is the committed one" "$(md5_of "$BEGIN_SIG")" "^$MD5_0\$"
e6_person ccx
ten_at_once "$U_ccx" q2x
expect "fail-before Q1-2: restored, the same schedule allows five, counted, with five reservations" "$(answers_of q2x true)|$(failures_of "$U_ccx")|$(reservations_of "$U_ccx")" '^5|5|5$'

# ---------------------------------------------------------------------------
section "35o D6: begin and end lock the account's counter row first, so an end behind an uncommitted begin reads its count"
# ---------------------------------------------------------------------------
# Whether the calling transaction holds the account's counter row: the version it sees was written by it (xmin) or is
# locked by it (xmax). It is read inside the transaction under test: one owner transaction under a server's claims,
# rolled back.
holds_row() { # user call-sql
  { printf 'begin;\n'; as_claims_sql "$1" aal1; printf '%s\n' "$2"
    printf "select 'LOCKED|' || coalesce((select ((txid_current() %% 4294967296)::text in (w.xmin::text, w.xmax::text))::text from app.mfa_route_attempts w where w.user_id = '%s'), 'none');\n" "$1"
    printf 'rollback;\n'; } | sql_try
}
REFUSED="select 'ALLOWED|' || b.allowed from api.mfa_verify_begin() b;"
NO_RESERVATION="select 'ENDED|' || api.mfa_verify_end('$(uuid)', 'invalid');"
e6_person lk
expect "D6 five wrong codes exhaust the account" "$(attempts "$U_lk" 5 invalid)" '^true;true;true;true;true;$'
R="$(holds_row "$U_lk" "$REFUSED")"
expect "D6 a sixth begin is refused" "$R" '^ALLOWED|false$'
expect "D6 and its transaction holds the account's row although it counted nothing" "$R" '^LOCKED|true$'
expect "D6 an end holds the row before it looks for its reservation, even one it does not find" "$(holds_row "$U_lk" "$NO_RESERVATION")" '^LOCKED|true$'
expect "D6 control: a transaction that calls neither holds nothing" "$(holds_row "$U_lk" "select 'NOTHING|';")" '^LOCKED|false$'
MUTATED=mfa_begin_35
expect "fail-before D6: 35n's begin is installed again" "$(e6_mutate "$BEGIN_SIG" "$UPSERT" "$RACY" 2>&1 && echo installed || echo 'not installed')" '^installed$'
expect "fail-before D6: its refusal holds no row lock" "$(holds_row "$U_lk" "$REFUSED")" '^LOCKED|false$'
restore_routine mfa_begin_35; MUTATED=""
expect "fail-before D6: restored, begin's md5 is the committed one" "$(md5_of "$BEGIN_SIG")" "^$MD5_0\$"

# An undecided end of the account's first attempt, sent while a second begin for the account is held open in its own
# session, so the end reaches the counter row before that begin commits. Under 012 the end waits at its row lock, then
# reads the begin's two and refunds its own one (CR35-1). $T/<tag>-waited says whether the end was observed waiting on
# a lock, and $T/<tag>-end holds its answer. A begin that never answers is ended and the end is not sent, so the lines
# reading them fail rather than pass on a schedule that did not run.
end_behind_begin() { # user attempt tag
  local held=held
  session_open "$3" 8
  session_send 8 "begin;
$(as_claims_sql "$1" aal1)
select 'BEGUN|' || b.allowed from api.mfa_verify_begin() b;"
  if ! session_wait "$3" 'BEGUN|true'; then held='begin not held'; session_kill "$3"; session_close 8; fi
  if [ "$held" != held ]; then printf '%s' "$held" > "$T/$3-waited"; printf 'not sent' > "$T/$3-end"; wait; return 0; fi
  { printf 'begin;\n'; as_claims_sql "$1" aal1
    printf "select 'ENDED|' || api.mfa_verify_end('%s', 'undecided');\ncommit;\n" "$2"; } | sql_try > "$T/$3-end" &
  if lock_waiters 'ENDED|' 1 300; then printf 'waiting' > "$T/$3-waited"; else printf 'not waiting' > "$T/$3-waited"; fi
  session_send 8 'commit;'; session_close 8
  wait
}
# The end's answer, the count, the first attempt's reservation and all the account's reservations.
behind_outcome() { # user attempt tag
  printf '%s|%s|%s|%s' "$(grep -c '^ENDED|$' "$T/$3-end" || true)" "$(failures_of "$1")" \
    "$(sql -c "select count(*) from app.mfa_route_reservations where attempt_id = '$2'")" "$(reservations_of "$1")"
}
DL="$(deadlocks)"
e6_person e7
A="$(attempt_of "$U_e7")"
expect "D6 the first attempt is counted and reserved" "$(failures_of "$U_e7")|$(reservations_of "$U_e7")" '^1|1$'
end_behind_begin "$U_e7" "$A" o
expect "D6 the end was observed waiting on a lock while the second begin was uncommitted" "$(cat "$T/o-waited")" '^waiting$'
expect "D6 then it read the begin's count: it answered, left one of two, and settled its own reservation, not the begin's" "$(behind_outcome "$U_e7" "$A" o)" '^1|1|0|1$'
save_routine "$END_SIG" mfa_end_35; MD5_END="$(md5_of "$END_SIG")"; MUTATED=mfa_end_35
expect "fail-before D6: end without its row lock is installed from the live definition" "$(e6_mutate "$END_SIG" 'w.user_id = actor for update;' 'w.user_id = actor;' 2>&1 && echo installed || echo 'not installed')" '^installed$'
expect "fail-before D6: its transaction no longer holds the row" "$(holds_row "$U_lk" "$NO_RESERVATION")" '^LOCKED|false$'
e6_person e7m
A="$(attempt_of "$U_e7m")"
end_behind_begin "$U_e7m" "$A" om
expect "fail-before D6: the mutant end was observed waiting too, at its write" "$(cat "$T/om-waited")" '^waiting$'
expect "fail-before D6: it wrote the count it read before the begin committed, so the begin's counted guess is lost" "$(behind_outcome "$U_e7m" "$A" om)" '^1|0|0|1$'
restore_routine mfa_end_35; MUTATED=""
expect "fail-before D6: restored, end's md5 is the committed one" "$(md5_of "$END_SIG")" "^$MD5_END\$"
expect "D6 deadlocks unchanged" "$(deadlocks)" "^$DL\$"

expect "35: deadlocks unchanged across the whole probe" "$(deadlocks)" "^$DL0\$"
printf '\n== 35 done: %s ==\n' "$([ "$FAILED" = 0 ] && echo PASS || echo FAIL)"
exit "$FAILED"
