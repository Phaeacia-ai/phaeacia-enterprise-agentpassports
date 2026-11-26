#!/usr/bin/env bash
# Shared helpers for the E4 probes (tests/db/22 onward), and, since the E4 review seam is retired (design 2.6 item 8),
# request_changes for tests/db/e3-lib.sh, which sources this file. Source after tests/db/lib.sh and ids.env. Not a probe:
# scripts/check-db.sh runs only tests/db/[0-9][0-9]-*.sh. Calls are built by tests/db/e4.mjs through lib/db/server.mjs.
export API_URL ANON_KEY JWT_SECRET
E4() { node "$ROOT/tests/db/e4.mjs" "$@"; }
# A JSON object from name=value pairs, built in Node: no shell literal holds a brace and a comma (evidence/m004.md,
# lesson 1). The word null is JSON null; a value starting with # is a JSON literal (a number, an array).
jbody() {
  node -e '
    const out = {};
    for (const pair of process.argv.slice(1)) {
      const i = pair.indexOf("=");
      const v = pair.slice(i + 1);
      out[pair.slice(0, i)] = v === "null" ? null : v.startsWith("#") ? JSON.parse(v.slice(1)) : v;
    }
    process.stdout.write(JSON.stringify(out));' "$@"
}
E4_PW='Synthetic-Pass-1234'
E4_REASON='Probe reason: the declared write stays inactive.'

# The independent reviewer a probe's change requests use: one account per company, holding both reviewer roles and
# contributing to nothing, created on first use and reused. Prints its user id.
reviewer_for() { # company
  local email uid
  email="e4-reviewer-$1@example.invalid"
  uid="$(sql -c "select id from auth.users where email = '$email'")"
  [ -n "$uid" ] || uid="$(create_user "$email" "$E4_PW")"
  if [ -z "$(sql -c "select id from app.memberships where company_id = '$1' and user_id = '$uid'")" ]; then
    sql -c "insert into app.memberships (company_id, user_id, roles) values ('$1', '$uid', '{business_reviewer,it_reviewer,member}')" >/dev/null
  fi
  printf '%s' "$uid"
}

# A candidate-level change request on a submitted candidate through api.record_review, by that reviewer, which is what
# the retired tests.request_changes stood in for. E4MODE=sql prints the call as SQL for an owner session instead of
# posting it; trailing arguments pass through to tests/db/e4.mjs (--gate). A refused call fails, loudly.
request_changes() { # candidate [e4.mjs options]
  local c="$1" company sub r
  shift
  company="$(sql -c "select company_id from app.candidate_versions where id = '$c'")"
  sub="$(reviewer_for "$company")"
  r="$(E4 "${E4MODE:-call}" record_review "$sub" candidate_id="$c" envelope_id=null role=it decision=changes_requested \
    reason="$E4_REASON" gate_identity=@gate idempotency_key=@uuid "$@")"
  if [ "${E4MODE:-call}" = sql ]; then printf '%s\n' "$r"; return 0; fi
  if printf '%s' "$r" | grep -q '^HTTP 200 .*"candidate_state": *"changes_requested"'; then return 0; fi
  printf 'request_changes %s was refused: %s\n' "$c" "$(printf '%s' "$r" | head -c 300)" >&2
  return 1
}

# The four E4 routines. E4MODE=sql prints the call as SQL for an owner session. Trailing arguments pass through to
# tests/db/e4.mjs (--aal, --gate, --save, --claims, --drop).
active_policy() { sql -c "select id from app.release_policies where active"; }
audience() { E4 audience "$@"; }
envelope() { # sub candidate target audience-text [key] ...
  E4 "${E4MODE:-call}" create_envelope "$1" candidate_id="$2" target="$3" audience_canonical="$4" \
    policy_id="$(active_policy)" gate_identity=@gate idempotency_key="${5:-@uuid}" "${@:6}"
}
review() { # sub candidate envelope|null role decision reason [key] ...
  E4 "${E4MODE:-call}" record_review "$1" candidate_id="$2" envelope_id="$3" role="$4" decision="$5" reason="$6" \
    gate_identity=@gate idempotency_key="${7:-@uuid}" "${@:8}"
}
publish() { # sub candidate envelope expected-hex [key] ...
  E4 "${E4MODE:-call}" publish_release "$1" candidate_id="$2" envelope_id="$3" expected_assembled_sha256="$4" \
    gate_identity=@gate idempotency_key="${5:-@uuid}" "${@:6}"
}
withdraw() { # sub release reason [key] ...
  E4 "${E4MODE:-call}" withdraw_release "$1" release_id="$2" reason="$3" idempotency_key="${4:-@uuid}" "${@:5}"
}

# Node's expected assembled hash (lib/passport/packet.mjs) over the candidate's stored content and the target's text.
expected_sha() { # candidate target
  sql -c "select json_build_object('content', content) from app.candidate_versions where id = '$1'" > "$E2_TMP/e4-content.json"
  E4 assembled-sha "$E2_TMP/e4-content.json" "$2"
}
# Owner-side setup, labelled as design 1.8 labels it: a target enabled for publication under the registry bypass.
enable_target() { # target
  sql -c "begin; set local app.registry_migration = 'on'; update app.release_targets set publishable = true where target = '$1'; commit;" >/dev/null
}
# A submitted candidate through the E3 routines (tests/db/e3-lib.sh). Prints its id.
submitted() { # sub company agent-name revision
  local r c
  r="$(draft_by_name "$1" "$2" "$3" "$4")"; c="$(field "$r" candidate_id)"
  [ -n "$c" ] || { printf 'submitted: draft refused: %s\n' "$(printf '%s' "$r" | head -c 300)" >&2; return 1; }
  r="$(submit "$1" "$c" 1 "$4")"
  printf '%s' "$r" | grep -q '"state": *"submitted"' || { printf 'submitted: submit refused: %s\n' "$(printf '%s' "$r" | head -c 300)" >&2; return 1; }
  printf '%s' "$c"
}
# A group of the company with the given memberships, owner-side (probe 21 exercises the routines). Prints the group id.
group_of() { # company creator-membership name membership...
  local g c="$1" by="$2" name="$3"
  shift 3
  g="$(first "$(sql -c "insert into app.groups (company_id, name, created_by_membership_id) values ('$c', '$name', '$by') returning id")")"
  for m in "$@"; do
    sql -c "insert into app.group_members (group_id, company_id, membership_id, added_by_membership_id) values ('$g', '$c', '$m', '$by')" >/dev/null
  done
  printf '%s' "$g"
}
# api.authorize_download under a user's own unbound server bearer. Prints one line, "HTTP <status> <body cut to 400
# bytes, newlines folded>". It does not go through tests/db/lib.sh rest, which writes every body to one file per
# process: two downloads started in the background are subshells of the same process, so they would overwrite each
# other's answer and a probe would read one refusal twice (observed while writing probe 28). Each call here writes to
# its own temporary file and removes it. The `authorize_download release membership` helper of tests/db/e4-lib.sh is
# the short form that prints a code, and download_body above is the form that keeps the whole answer.
download_as() { # user release [aal]
  local body code
  body="$(mktemp "${TMPDIR:-/tmp}/e5dl.XXXXXX")"
  code="$(curl -sS -o "$body" -w '%{http_code}' -X POST "$API_URL/rest/v1/rpc/authorize_download" \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $(server_jwt "$1" "${3:-}")" \
    -H 'Content-Type: application/json' -d "$(jbody p_release="$2")")"
  printf 'HTTP %s %s\n' "$code" "$(head -c 400 "$body" | tr '\n' ' ')"
  rm -f "$body"
}
# E5 design 2.7 and E5D-C-F7: the download seam is retired and this helper calls the real routine. Its call sites name
# a membership, as the owner-side seam took one; api.authorize_download reads its actor from app.server_actor() and
# never from a parameter, so the helper resolves that membership's user and mints the server bearer for it. It prints
# `authorized` or the refusal code, which is the shape the seam printed, so a call site reads the same way. A failure
# that carries no E_ token prints the whole answer, so an unexpected status is visible rather than silently empty.
authorize_download() { # release membership
  local uid r code
  uid="$(sql -c "select user_id from app.memberships where id = '$2'")"
  [ -n "$uid" ] || { printf 'authorize_download: no membership %s\n' "$2" >&2; return 1; }
  r="$(download_as "$uid" "$1")"
  if printf '%s' "$r" | grep -q '^HTTP 200 '; then printf 'authorized\n'; return 0; fi
  code="$(printf '%s' "$r" | sed -n 's/.*"message":"\(E_[A-Z_]*\).*/\1/p' | head -1)"
  if [ -n "$code" ]; then printf '%s\n' "$code"; else printf '%s\n' "$r"; fi
}
# The owner-only counterexample of design 1.2, applied for probe 28's fail-before arm only.
download_mutant() { sql < "$ROOT/tests/db/fixtures/e5-download-mutant.sql" >/dev/null; }
count_where() { sql -c "select count(*) from $1 where $2"; }

# Mutants and advisory barriers, shared by tests/db/25 and tests/db/28 (moved here from probe 25 when E5 design 2.7 gave
# probe 28 the download schedules, so one copy serves both). A probe sets MUTANT_DIR to a directory it owns.
# install_mutant name regprocedure from to [from to ...]: the live definition with each replacement, committed, the
# original saved for restore_mutant and for the exit trap.
install_mutant() {
  local name="$1" proc="$2" def
  shift 2
  def="$(sql -c "select pg_get_functiondef('$proc'::regprocedure)")"
  printf '%s;\n' "$def" > "${MUTANT_DIR:?MUTANT_DIR is unset}/$name.sql"
  while [ $# -ge 2 ]; do
    def="$(printf '%s' "$def" | E3_FROM="$1" E3_TO="$2" E3 mutate)" || { echo "install_mutant $name: anchor not found"; FAILED=1; return 1; }
    shift 2
  done
  printf '%s;\n' "$def" | sql >/dev/null
}
restore_mutant() { sql < "${MUTANT_DIR:?}/$1.sql" >/dev/null && rm -f "${MUTANT_DIR:?}/$1.sql"; }
restore_all() { for f in "${MUTANT_DIR:-/nonexistent}"/*.sql; do [ -e "$f" ] && sql < "$f" >/dev/null 2>&1; done; return 0; }
# A connection holding a session advisory lock until the probe releases it, so a schedule is ordered by a lock the probe
# owns rather than by a sleep.
hold_barrier() { # fd name key
  session_open "$2" "$1"
  session_send "$1" "select 'BARRIER|' || pg_advisory_lock(hashtext('$3'));"
  session_wait "$2" 'BARRIER|'
}
release_barrier() { session_send "$1" "select pg_advisory_unlock_all();"; session_close "$1"; } # fd
# The two-integer advisory lock api.authorize_download takes for one (release, membership) pair (E5 design 1.2,
# E5D-C-F2). A probe holds it to make two downloads of that pair queue at exactly the point the quota is decided.
hold_quota_lock() { # fd name release membership
  session_open "$2" "$1"
  session_send "$1" "select 'QUOTA|' || pg_advisory_lock(hashtext('app.release_downloads'), hashtext('$3:$4'));"
  session_wait "$2" 'QUOTA|'
}

# A psql session held open on a named pipe, so a probe can take a lock or an advisory barrier and release it when it
# chooses rather than after a fixed sleep. Each session uses a fixed file descriptor (bash 3.2 has no {var}> form).
session_open() { # name fd
  local d="$E2_TMP/session-$1"
  mkdir -p "$d"; rm -f "$d/in"; mkfifo "$d/in"
  docker exec -i "$DB_CONTAINER" psql -U postgres -X -At < "$d/in" > "$d/out" 2>&1 &
  printf '%s\n' "$!" > "$d/pid"
  eval "exec $2>\"$d/in\""
  # The session names itself so that session_kill can find its backend (B3-R-F2, evidence/batch-3-review.md).
  printf "set application_name = 'probe-session-%s';\n" "$1" >&"$2"
}
session_send() { printf '%s\n' "$2" >&"$1"; } # fd sql
session_close() { eval "exec $1>&-"; } # fd
session_out() { cat "$E2_TMP/session-$1/out"; } # name
# End a session that did not answer: terminate its backend by the name it set at open, then its psql client. Without
# this a session left in a long statement or a lock cycle is a child the probe's next bare `wait` waits for, for as
# long as the statement runs (B3-R-F2: a guarded wait that timed out turned into a hang of check-db.sh).
session_kill() { # name
  local d="$E2_TMP/session-$1"
  sql -c "select count(pg_terminate_backend(pid)) from pg_stat_activity where application_name = 'probe-session-$1' and pid <> pg_backend_pid()" >/dev/null 2>&1 || true
  if [ -s "$d/pid" ]; then kill "$(cat "$d/pid")" 2>/dev/null || true; fi
}
# Wait until the session's output holds a line matching the pattern, up to N tenths of a second.
session_wait() { # name pattern [tenths]
  local i
  for i in $(seq 1 "${3:-100}"); do
    grep -q -- "$2" "$E2_TMP/session-$1/out" 2>/dev/null && return 0
    sleep 0.1
  done
  printf 'session_wait %s: no line matching %s\n' "$1" "$2" >&2
  return 1
}
# Wait until N backends whose query matches the pattern wait on a heavyweight lock (pg_stat_activity), up to M tenths.
lock_waiters() { # pattern [n] [tenths]
  local i
  for i in $(seq 1 "${3:-100}"); do
    [ "$(sql -c "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query like '%$1%' and pid <> pg_backend_pid()")" -ge "${2:-1}" ] && return 0
    sleep 0.1
  done
  return 1
}
