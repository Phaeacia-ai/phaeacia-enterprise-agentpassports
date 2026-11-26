#!/usr/bin/env bash
# Probe 28: api.authorize_download under concurrency (docs/e5/design.md 1.2, 2.5; section 5 cases 1, 2, 19 and 20, and
# E5D-C-F2's race at the ceiling). Each schedule is ordered by locks the probe holds and releases itself, observed in
# pg_stat_activity, never by a sleep; every schedule asserts pg_stat_database.deadlocks unchanged.
#   28a case 1 (E4 case 36 order A): a download that already holds its share lock, and a withdrawal that waits for it;
#       fail-before against tests.authorize_download_unlocked and against E4's withdrawal mutant
#   28b case 2 (E4 case 36 order B): a download that asks after the withdrawal's FOR UPDATE is granted
#   28c E5D-C-F2: two downloads of one pair at 199 authorizations, queued on the quota lock the routine itself takes;
#       fail-before against tests.authorize_download_unserialized, which counts without it and leaves 201
#   28d case 19: a report racing a withdrawal, both orders
#   28e case 20: two downloads by different memberships and a withdrawal, three connections
# Run: bash tests/db/28-download-concurrency.sh (after tests/db/00-seed.sh and the probes before it).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
source "$ROOT/tests/db/e5-lib.sh"
RUN="$(run_id)"; T="$E2_TMP/28"; mkdir -p "$T/saved"
MUTANT_DIR="$T/saved"
trap 'restore_all; rm -rf "$E2_TMP"' EXIT
DL0="$(deadlocks)"
person() {
  local uid ms
  uid="$(create_user "e5-28-$RUN-$(printf '%s' "$1" | tr 'A-Z_' 'a-z-')@example.invalid" "$E4_PW")"
  ms="$(member "$2" "$uid" "$3")"
  eval "U_$1=$uid; MS_$1=$ms"
}
env_of() { field "$(envelope "$@")" envelope_id; }
publish_sub() { publish "$1" "$2" "$3" "$(expected_sha "$2" "$4")" @uuid --aal aal2; }
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
# A released candidate whose audience holds P and Q. Prints the release id.
released() { # revision
  local c e
  c="$(submitted "$U_M" "$G" "c28-$1-$RUN" "$1")"; e="$(env_of "$U_M" "$c" claude-ai "$AUD")"
  review "$U_I" "$c" "$e" it approved "IT." >/dev/null; review "$U_B" "$c" "$e" business approved "Business." >/dev/null
  field "$(publish_sub "$U_A" "$c" "$e" claude-ai)" release_id
}

section "28 setup: company G (admin A, author M, IT I, business B, recipients P and Q); the audience group; claude-ai enabled; the download counterexamples"
U_A="$(create_user "e5-28-$RUN-a@example.invalid" "$E4_PW")"; G="$(company "e5-28g-$RUN" "$U_A")"; MS_A="$(membership_of "$G" "$U_A")"
person M "$G" '{member}'
person I "$G" '{it_reviewer,member}'
person B "$G" '{business_reviewer,member}'
person P "$G" '{member}'
person Q "$G" '{member}'
GR="$(group_of "$G" "$MS_A" "Audience-$RUN" "$MS_P" "$MS_Q" "$MS_M")"; AUD="$(audience "$GR")"
enable_target claude-ai
download_mutant
echo "note: owner-side, tests/db/fixtures/e5-download-mutant.sql applied: the two counterexamples of design 1.2, reachable by no request role"

section "28a case 1 (E4 case 36 order A): the download holds its share lock and the withdrawal waits"
R1="$(released 81)"
expect "a released candidate" "$R1" '^[0-9a-f-]\{36\}$'
DL="$(deadlocks)"
session_open dlA 9
session_send 9 "begin;"
printf '%s\n' "$(download_sql "$U_P" "$R1")" >&9
session_wait dlA 'DOWNLOAD|'
expect "case 1: the download authorized inside an open transaction, holding FOR SHARE and an uncommitted ledger row" "$(session_out dlA | tr '\n' ' ')" 'DOWNLOAD|1'
withdraw "$U_A" "$R1" "Withdrawn during a download." @uuid --aal aal2 > "$T/w1" &
WAITED="$(lock_waiters 'withdraw_release' 1 && echo waiting || echo 'not waiting')"
session_send 9 "commit;"; session_close 9
wait
expect "case 1: the withdrawal was observed waiting on the download's share lock" "$WAITED" '^waiting$'
expect "case 1: and after the commit it lists that recipient, recipientCount 1" "$(cat "$T/w1")" "\"recipient_count\": *1"
expect "case 1: and the recipient is P" "$(cat "$T/w1")" "\"membership_id\": *\"$MS_P\""
expect "case 1: deadlocks unchanged" "$(deadlocks)" "^$DL\$"

R1M="$(released 82)"
DL="$(deadlocks)"
hold_barrier 8 b1m "e5-28-m1"
session_open m1 9
session_send 9 "begin;"
session_send 9 "select 'DOWNLOAD|' || tests.authorize_download_unlocked('$R1M', '$MS_P', 'e5-28-m1');"
lock_waiters 'authorize_download_unlocked' 1 || true
expect "case 1 fail-before: with no FOR SHARE nothing makes the withdrawal wait, and it lists nobody" "$(withdraw "$U_A" "$R1M" "Withdrawn during the mutant download." @uuid --aal aal2)" '"recipient_count": *0'
release_barrier 8
session_wait m1 'DOWNLOAD|'
session_send 9 "commit;"; session_close 9
expect "case 1 fail-before observed failing its control: the withdrawn release was authorized and the recipient is missing from the list" "$(session_out m1 | tr '\n' ' ')|$(sql -c "select count(*) from app.release_downloads where release_id = '$R1M'")" 'DOWNLOAD|authorized.*|1$'
expect "case 1 fail-before: deadlocks unchanged" "$(deadlocks)" "^$DL\$"

R1W="$(released 83)"
DL="$(deadlocks)"
install_mutant w2 'api.withdraw_release(uuid,text,uuid)' \
  "select r.agent_id, r.state into rel_agent, rel_state from app.releases r where r.id = p_release for update;" "recipients := app.release_recipients(p_release);
  select r.agent_id, r.state into rel_agent, rel_state from app.releases r where r.id = p_release for update;" \
  "-- The ledger, read by a later statement with a snapshot of its own (design 1.4, B6).
  recipients := app.release_recipients(p_release);" "-- E4's withdrawal mutant: the ledger was read before the release lock."
echo "note: E4's withdrawal mutant installed: api.withdraw_release reads the ledger before its FOR UPDATE"
session_open dlW 9
session_send 9 "begin;"
printf '%s\n' "$(download_sql "$U_P" "$R1W")" >&9
session_wait dlW 'DOWNLOAD|'
withdraw "$U_A" "$R1W" "Withdrawn during a download." @uuid --aal aal2 > "$T/w1w" &
WAITED="$(lock_waiters 'withdraw_release' 1 && echo waiting || echo 'not waiting')"
session_send 9 "commit;"; session_close 9
wait
restore_mutant w2
expect "case 1 fail-before, E4's withdrawal mutant: it waited, yet lists nobody while the ledger holds the recipient" "$WAITED|$(cat "$T/w1w")|$(sql -c "select count(*) from app.release_downloads where release_id = '$R1W'")" '^waiting|.*"recipient_count": *0.*|1$'
expect "the accepted api.withdraw_release is back" "$(sql -c "select position('recipients := app.release_recipients(p_release);' in prosrc) > position('for update' in prosrc) from pg_proc where oid = 'api.withdraw_release(uuid,text,uuid)'::regprocedure")" '^t$'
expect "case 1 fail-before: deadlocks unchanged" "$(deadlocks)" "^$DL\$"

section "28b case 2 (E4 case 36 order B): the download asks after the withdrawal's lock is granted"
R2="$(released 84)"
DL="$(deadlocks)"
WSQL="$(E4MODE=sql withdraw "$U_A" "$R2" "Withdrawn first." @uuid --aal aal2)"
session_open w2s 7
session_send 7 "begin;"
printf '%s\n' "$WSQL" >&7
session_send 7 "select 'WITHDRAWN|' || count(*) from app.releases where id = '$R2' and state = 'withdrawn';"
session_wait w2s 'WITHDRAWN|1'
authorize_download "$R2" "$MS_P" > "$T/dl2" &
expect "case 2: the download is observed waiting on the withdrawal's release lock" "$(lock_waiters 'authorize_download' 1 && echo waiting)" '^waiting$'
session_send 7 "commit;"; session_close 7
wait
expect "case 2: the download is refused E_RELEASE_WITHDRAWN" "$(cat "$T/dl2")" '^E_RELEASE_WITHDRAWN$'
expect "case 2: no ledger row, and the withdrawal listed nobody" "$(sql -c "select count(*) from app.release_downloads where release_id = '$R2'")|$(session_out w2s | tr '\n' ' ')" '^0|.*"recipient_count": *0'
expect "case 2: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
R2C="$(released 85)"
WSQL="$(E4MODE=sql withdraw "$U_A" "$R2C" "Rolled back." @uuid --aal aal2)"
session_open w2r 7
session_send 7 "begin;"
printf '%s\n' "$WSQL" >&7
session_send 7 "select 'WITHDRAWN|' || count(*) from app.releases where id = '$R2C' and state = 'withdrawn';"
session_wait w2r 'WITHDRAWN|1'
authorize_download "$R2C" "$MS_P" > "$T/dl2c" &
lock_waiters 'authorize_download' 1 || true
session_send 7 "rollback;"; session_close 7
wait
expect "case 2 control: the same schedule with the withdrawal rolled back: the download authorizes" "$(cat "$T/dl2c")|$(sql -c "select count(*) from app.release_downloads where release_id = '$R2C'")" '^authorized|1$'

section "28c E5D-C-F2: two downloads of one pair at 199 authorizations"
R3="$(released 86)"
fill_ledger "$R3" "$MS_P" 199
echo "note: owner-side, 199 ledger rows for P, so the next authorization is the two-hundredth"
DL="$(deadlocks)"
# The probe holds the very lock api.authorize_download takes for this (release, membership) pair, so both downloads
# reach the quota decision and queue there rather than racing to it.
hold_quota_lock 8 quota "$R3" "$MS_P"
download_as "$U_P" "$R3" > "$T/f2a" &
download_as "$U_P" "$R3" > "$T/f2b" &
expect "E5D-C-F2: both downloads are observed waiting on the quota lock" "$(lock_waiters 'authorize_download' 2 && echo waiting)" '^waiting$'
release_barrier 8
wait
expect "E5D-C-F2: one authorizes and one is refused E_DOWNLOAD_LIMIT" "$(cat "$T/f2a" "$T/f2b" | grep -c '^HTTP 200')|$(cat "$T/f2a" "$T/f2b" | grep -c 'E_DOWNLOAD_LIMIT')" '^1|1$'
expect "E5D-C-F2: exactly two hundred authorizations, never two hundred and one" "$(ledger_count "$R3" "$MS_P")" '^200$'
expect "E5D-C-F2: deadlocks unchanged" "$(deadlocks)" "^$DL\$"

R3M="$(released 87)"
fill_ledger "$R3M" "$MS_P" 199
DL="$(deadlocks)"
hold_barrier 8 f2m "e5-28-f2"
session_open f2m1 9
session_send 9 "begin;"
session_send 9 "select 'ONE|' || tests.authorize_download_unserialized('$R3M', '$MS_P', 'e5-28-f2');"
# ONE is observed waiting on the barrier before TWO is started, so the lock queue orders them (E5S-C-F3's first remedy);
# the commit order below still follows whichever answers, so a scheduler that orders them otherwise fails nothing.
lock_waiters 'authorize_download_unserialized' 1 || true
session_open f2m2 6
session_send 6 "begin;"
session_send 6 "select 'TWO|' || tests.authorize_download_unserialized('$R3M', '$MS_P', 'e5-28-f2');"
lock_waiters 'authorize_download_unserialized' 2 || true
release_barrier 8
# Each mutant session takes the barrier as a transaction lock, so the second cannot finish until the first commits.
# That is not what the counterexample is about: both have already read the count, before the barrier, and the second
# inserts on that stale reading even after the first has committed the two-hundredth row.
# Whichever mutant session is granted the barrier's transaction lock first answers and then sits idle in its open
# transaction, still holding that lock, so the other cannot answer until the first commits. Which one that is, is the
# scheduler's choice. E5S-C-F3 (evidence/e5-server-critique.md): this arm waited for ONE by name, so when TWO won it
# waited on a session that could not answer, and no timeout was long enough (31,712 ms observed; the thirty seconds of
# 44ae3b9 treated a schedule as load). The probe commits whichever answered first, then waits for the other.
F2M_FIRST=""
for _ in $(seq 1 300); do
  if session_wait f2m1 'ONE|' 1 2>/dev/null; then F2M_FIRST=one; break; fi
  if session_wait f2m2 'TWO|' 1 2>/dev/null; then F2M_FIRST=two; break; fi
done
expect "E5D-C-F2 fail-before: one mutant session answers once the barrier is released" "${F2M_FIRST:+answered}" '^answered$'
# The second wait is guarded like the first: under set -e an unguarded session_wait that times out aborts the script,
# and the arm's control below would never be read (TOOL2-R-F6, evidence/batch-2-review.md). A session that never
# answers is recorded as a named FAIL and the arm still reaches its 201-row control.
F2M_SECOND=answered
# A session that never answers is ended by session_kill after its failed wait, and so is the other mutant session,
# which is the one it may be waiting behind (B3-R-F2, evidence/batch-3-review.md): otherwise a backend keeps its locks
# or its statement and its client stays a child of this script, and a later bare `wait` waits for it as long as the
# statement runs. Nothing is sent to a killed session (a write to its fifo would end this script with SIGPIPE); both
# sessions' outputs are files and stay readable for the expectations below.
if [ "$F2M_FIRST" = two ]; then
  session_send 6 "commit;"; session_close 6
  if session_wait f2m1 'ONE|' 300; then session_send 9 "commit;"; session_close 9; else F2M_SECOND=""; session_kill f2m1; session_kill f2m2; fi
else
  session_send 9 "commit;"; session_close 9
  if session_wait f2m2 'TWO|' 300; then session_send 6 "commit;"; session_close 6; else F2M_SECOND=""; session_kill f2m2; session_kill f2m1; fi
fi
expect "E5D-C-F2 fail-before: the other mutant session answers after the first commits" "$F2M_SECOND" '^answered$'
echo "note: the mutant session that answered first was $F2M_FIRST"
expect "E5D-C-F2 fail-before: counted without the quota lock, both sessions see 199 and both insert" "$(session_out f2m1 | tr '\n' ' ')|$(session_out f2m2 | tr '\n' ' ')" 'ONE|authorized.*|.*TWO|authorized'
expect "E5D-C-F2 fail-before observed failing its control: 201 authorizations where the ceiling is 200" "$(ledger_count "$R3M" "$MS_P")" '^201$'
expect "E5D-C-F2 fail-before: deadlocks unchanged" "$(deadlocks)" "^$DL\$"

section "28d case 19: a report racing a withdrawal, both orders"
race19() { # label release order
  local DL
  DL="$(deadlocks)"
  expect "case 19 $1: P has a download to report against" "$(code_of "$(download_as "$U_P" "$2")")" '^ok$'
  # Both calls take the company lock first (design 2.5), so the probe holds that lock, starts them in the order the
  # arm names, observes each one waiting on it, and releases. The observation budget is short on purpose: app_server
  # carries lock_timeout = 5s, so a schedule that held the lock longer would answer E_BUSY rather than order anything.
  hold_lock 5 "c19-$1" "$G"
  local RP WP
  if [ "$3" = reportfirst ]; then
    report "$U_P" "$2" pass null null > "$T/r19-$1" &
    RP=$!
    lock_waiters 'report_installation' 1 15 || true
    withdraw "$U_A" "$2" "Withdrawn beside a report." @uuid --aal aal2 > "$T/w19-$1" &
    WP=$!
    lock_waiters 'withdraw_release' 1 15 || true
  else
    withdraw "$U_A" "$2" "Withdrawn beside a report." @uuid --aal aal2 > "$T/w19-$1" &
    WP=$!
    lock_waiters 'withdraw_release' 1 15 || true
    report "$U_P" "$2" pass null null > "$T/r19-$1" &
    RP=$!
    lock_waiters 'report_installation' 1 15 || true
  fi
  release 5
  # Wait for the two calls this arm started, not for every child of the script (B3-R-F2).
  wait "$RP" "$WP"
  expect "case 19 $1: both succeed, and both are correct" "$(cat "$T/r19-$1" | cut -c1-8)|$(printf '%s' "$(cat "$T/w19-$1")" | grep -c '"state": *"withdrawn"')" '^HTTP 200|1$'
  expect "case 19 $1: the report is readable afterwards and names the withdrawn release" "$(sql -c "select count(*) from app.installation_reports p join app.releases r on r.id = p.release_id where p.release_id = '$2' and r.state = 'withdrawn'")" '^[1-9]'
  expect "case 19 $1: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
}
race19 reportfirst "$(released 88)" reportfirst
race19 withdrawfirst "$(released 89)" withdrawfirst

section "28e case 20: two downloads and a withdrawal, three connections"
R20="$(released 90)"
DL="$(deadlocks)"
download_as "$U_P" "$R20" > "$T/d20p" &
download_as "$U_Q" "$R20" > "$T/d20q" &
withdraw "$U_A" "$R20" "Withdrawn amid downloads." @uuid --aal aal2 > "$T/w20" &
wait
AUTH20="$(sql -c "select count(distinct membership_id) from app.release_downloads where release_id = '$R20'")"
LISTED20="$(printf '%s' "$(cat "$T/w20")" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=s.indexOf(" ",5);let n=0;try{n=(JSON.parse(s.slice(i+1)).recipients??[]).length}catch{}process.stdout.write(String(n))})')"
expect "case 20: every download either authorized and is in the withdrawal's list, or refused with no row" "$AUTH20" "^$LISTED20\$"
expect "case 20: each answer is a 200 or a refusal with a code, never a 500 without one" "$(cat "$T/d20p" "$T/d20q" | grep -c 'HTTP 200\|E_RELEASE_WITHDRAWN\|E_BUSY')" '^2$'
expect "case 20: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
R20C="$(released 91)"
download_as "$U_P" "$R20C" > "$T/d20cp" &
download_as "$U_Q" "$R20C" > "$T/d20cq" &
wait
expect "case 20 control: with no withdrawal, both downloads authorize" "$(cat "$T/d20cp" "$T/d20cq" | grep -c 'HTTP 200')|$(sql -c "select count(*) from app.release_downloads where release_id = '$R20C'")" '^2|2$'

expect "deadlocks unchanged over the whole probe" "$(deadlocks)" "^$DL0\$"
[ "$FAILED" = 0 ] && echo "28 PASS" || { echo "28 FAIL"; exit 1; }
