#!/usr/bin/env bash
# Shared helpers for the E5 probes (tests/db/26 to 28), beside tests/db/e4-lib.sh, which this file's callers have
# already sourced through tests/db/e3-lib.sh. Source after tests/db/lib.sh and ids.env. Not a probe: scripts/check-db.sh
# runs only tests/db/[0-9][0-9]-*.sh. The two bound calls are built by tests/db/e4.mjs through lib/db/server.mjs, so
# every probe call is also a Node-to-SQL check of the binding and operation projections of E5 design 2.6 item 1.
export API_URL ANON_KEY JWT_SECRET

# The whole answer of one download, written to a file, and "HTTP <status>" on stdout. tests/db/lib.sh rest prints only
# the first 400 bytes of a body, and a download's body carries the assembled bytes before its authorization summary, so
# a probe that read the summary out of rest's output would be reading a truncated string and matching nothing.
download_body() { # user release out-file
  curl -sS -o "$3" -w 'HTTP %{http_code}' -X POST "$API_URL/rest/v1/rpc/authorize_download" \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $(server_jwt "$1")" -H 'Content-Type: application/json' \
    -d "$(jbody p_release="$2")"
}
# One field of a saved answer body, by dotted path, parsed in Node. A body that is not JSON, or a path that is absent,
# prints nothing and exits non-zero, so a probe cannot pass on an unparsed answer.
dl_field() { # file dotted-path
  node -e '
    const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const v = process.argv[2].split(".").reduce((o, k) => (o == null ? o : o[k]), j);
    if (v === undefined || v === null) process.exit(1);
    process.stdout.write(String(v));' "$1" "$2"
}
# SHA-256 of the assembled bytes a saved answer carried, and the hash that answer declared, as "<computed>|<declared>".
dl_assembly() { # file
  node -e '
    const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const h = require("node:crypto").createHash("sha256").update(Buffer.from(j.assembled_content, "utf8")).digest("hex");
    process.stdout.write(h + "|" + j.assembled_sha256);' "$1"
}

# The same call as SQL for an owner session, for a schedule that must hold a transaction open (probe 28). The claims
# are the ones a server bearer carries; app.server_actor() reads role and sub and refuses a token carrying `fn`. Only
# the authorization count is printed: the answer also carries the assembled bytes, which a session log has no use for.
download_sql() { # user release
  printf "select set_config('request.jwt.claims', '%s', true);\nselect 'DOWNLOAD|' || coalesce(api.authorize_download('%s') -> 'authorization' ->> 'authorizations', '?');\n" \
    "{\"role\":\"app_server\",\"sub\":\"$1\",\"iss\":\"phaeacia-server\"}" "$2"
}
# The two bound routines. E5MODE=sql prints the call as SQL for an owner session; trailing arguments pass through to
# tests/db/e4.mjs (--aal, --claims, --drop, --save).
report() { # sub release status losses|null assistance|null [key] ...
  E4 "${E5MODE:-call}" report_installation "$1" release_id="$2" status="$3" losses="$4" assistance="$5" \
    idempotency_key="${6:-@uuid}" "${@:7}"
}
witness() { # sub report status note [key] ...
  E4 "${E5MODE:-call}" witness_installation "$1" report_id="$2" status="$3" note="$4" \
    idempotency_key="${5:-@uuid}" "${@:6}"
}

# The user behind a membership, which the routines read from their bearer and never from a parameter.
user_of() { sql -c "select user_id from app.memberships where id = '$1'"; }
# A real GoTrue access token for a probe's synthetic user, by user id; every probe here creates its people with $E4_PW.
member_jwt() { user_jwt "$(sql -c "select email from auth.users where id = '$1'")" "$E4_PW"; }
# A view read under the caller's own token, through PostgREST, so row level security and the definer doors decide
# exactly as they do for the service. Prints "HTTP <status> <body>".
view_as() { # jwt view query
  rest GET "/$2?$3" "$1"
}
# Owner-side: move a membership's authorizations of one release back in time, so the derived check-in state can be read
# at an exact age without waiting fourteen days. Labelled as setup: no route moves a ledger row, and the append-only
# trigger refuses an UPDATE, so the row is deleted and rewritten inside one owner transaction with the trigger
# disabled, which is the one thing only the owner can do (E5 design 5, "owner-side").
age_ledger() { # release membership interval
  sql -c "begin;
    alter table app.release_downloads disable trigger release_downloads_append_only;
    update app.release_downloads set authorized_at = authorized_at - interval '$3'
     where release_id = '$1' and membership_id = '$2';
    alter table app.release_downloads enable trigger release_downloads_append_only;
    commit;" >/dev/null
}
# Owner-side ledger rows, for a quota that would otherwise need two hundred requests. INSERT is not refused by the
# append-only trigger; only UPDATE, DELETE and TRUNCATE are.
fill_ledger() { # release membership n
  sql -c "insert into app.release_downloads (company_id, release_id, membership_id)
          select r.company_id, r.id, '$2' from app.releases r, generate_series(1, $3) where r.id = '$1'" >/dev/null
}
ledger_count() { sql -c "select count(*) from app.release_downloads where release_id = '$1' and membership_id = '$2'"; }
reports_of() { sql -c "select count(*) from app.installation_reports where release_id = '$1'"; }
