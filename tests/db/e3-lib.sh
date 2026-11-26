#!/usr/bin/env bash
# Shared helpers for the E3 probes (tests/db/14 onward). Source after tests/db/lib.sh and ids.env. Not a probe:
# scripts/check-db.sh runs only tests/db/[0-9][0-9]-*.sh.
export API_URL ANON_KEY JWT_SECRET
E3() { node "$ROOT/tests/db/e3.mjs" "$@"; }
J() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }
run_id() { node -e 'process.stdout.write(require("node:crypto").randomBytes(3).toString("hex"))'; }
uuid() { node -e 'process.stdout.write(require("node:crypto").randomUUID())'; }
first() { printf '%s\n' "$1" | head -1; }
field() { printf '%s' "$1" | E3 field "$2"; }
iso_ago() { node -e "process.stdout.write(new Date(Date.now() - $1 * 1000).toISOString())"; }
count() { sql -c "select count(*) from $1"; }
deadlocks() { sql -c "select deadlocks from pg_stat_database where datname = current_database()"; }
SUBMISSION='{"confidence":"high","permitted_data":"synthetic records only","source_platform":"synthetic probe"}'

# A company provisioned by the seeded operator, with its first admin; prints the company id.
company() { # slug first-admin-user
  rest POST /rpc/provision_company "$(server_jwt "$U_op" aal2)" "{\"p_slug\":\"$1\",\"p_name\":\"SYNTHETIC $1\",\"p_first_admin_user\":\"$2\"}" \
    | sed -n 's/.*"company_id":"\([^"]*\)".*/\1/p'
}
member() { first "$(sql -c "insert into app.memberships (company_id, user_id, roles) values ('$1','$2','$3') returning id")"; }
membership_of() { sql -c "select id from app.memberships where company_id='$1' and user_id='$2'"; }
# The E4 review seam is retired (E4 design 2.6 item 8): request_changes is a change request through api.record_review by
# an independent reviewer, defined with the other E4 calls in tests/db/e4-lib.sh.
source "$ROOT/tests/db/e4-lib.sh"

# The four routines. E3MODE=sql prints the call as SQL for an owner session instead of posting it. Trailing
# arguments pass through to tests/db/e3.mjs (--gate, --save, --claims, --drop, --bind-revision).
draft_by_name() { # sub company name revision [key] ...
  E3 "${E3MODE:-call}" create_draft "$1" "{\"company_id\":\"$2\",\"agent_name\":\"$3\",\"content\":\"@content\",\"derived_canonical\":\"@derived\",\"gate_identity\":\"@gate\",\"idempotency_key\":\"${5:-@uuid}\"}" --revision "$4" "${@:6}"
}
draft_by_id() { # sub company agent revision [key] ...
  E3 "${E3MODE:-call}" create_draft "$1" "{\"company_id\":\"$2\",\"agent_id\":\"$3\",\"content\":\"@content\",\"derived_canonical\":\"@derived\",\"gate_identity\":\"@gate\",\"idempotency_key\":\"${5:-@uuid}\"}" --revision "$4" "${@:6}"
}
save() { # sub candidate expected-version revision [key] ...
  E3 "${E3MODE:-call}" save_draft "$1" "{\"candidate_id\":\"$2\",\"expected_version\":$3,\"content\":\"@content\",\"derived_canonical\":\"@derived\",\"gate_identity\":\"@gate\",\"idempotency_key\":\"${5:-@uuid}\"}" --revision "$4" "${@:6}"
}
submit() { # sub candidate expected-version revision [key] ...; the metadata is $SUBMISSION
  E3 "${E3MODE:-call}" submit_candidate "$1" "{\"candidate_id\":\"$2\",\"expected_version\":$3,\"content_sha256\":\"@content_sha256\",\"derived_canonical\":\"@derived\",\"submission_canonical\":$(J "$SUBMISSION"),\"gate_identity\":\"@gate\",\"idempotency_key\":\"${5:-@uuid}\"}" --revision "$4" "${@:6}"
}
successor() { # sub parent revision [key] ...
  E3 "${E3MODE:-call}" create_successor "$1" "{\"candidate_id\":\"$2\",\"content_sha256\":\"@content_sha256\",\"derived_canonical\":\"@derived\",\"gate_identity\":\"@gate\",\"idempotency_key\":\"${4:-@uuid}\"}" --revision "$3" "${@:5}"
}

# Hold one company's lock from another connection for N seconds, in the background.
hold_company() { sql -c "begin; select id from app.companies where id='$1' for no key update; select pg_sleep($2); commit;" >/dev/null 2>&1 & }

# The live definition of a routine with one replacement; the anchor must exist.
mutant() { # regprocedure from to
  local def
  def="$(sql -c "select pg_get_functiondef('$1'::regprocedure)")"
  printf '%s' "$def" | E3_FROM="$2" E3_TO="$3" E3 mutate
}
# Run SQL statements in one owner transaction that is always rolled back; errors are printed, not fatal.
in_rollback() { printf 'begin;\n%s\nrollback;\n' "$*" | sql_try; }
