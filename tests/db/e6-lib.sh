#!/usr/bin/env bash
# Shared helpers for the E6 probes (tests/db/29 to 31). Source after tests/db/lib.sh, ids.env and tests/db/e3-lib.sh
# (which sources e4-lib.sh); tests/db/e5-lib.sh too where a download is needed. Not a probe: scripts/check-db.sh runs
# only tests/db/[0-9][0-9]-*.sh.
#
# Two rules this file exists to keep, both from the accepted probes' own lessons:
#   - `expect` greps its third argument, so a literal answer never carries regex alternation, and a subject that can be
#     empty carries a marker rather than being matched against ^$ (E5's lesson, tests/db/lib.sh).
#   - a schedule is ordered by a lock the probe holds and observes in pg_stat_activity, never by a sleep
#     (tests/db/e4-lib.sh's hold_barrier and lock_waiters).
export API_URL ANON_KEY JWT_SECRET
E6_PW='Synthetic-Pass-1234'

# ---------------------------------------------------------------------------
# Calls. Every E6 routine is UNBOUND (design 2.6 item 1: BOUND gains nothing), so each is one PostgREST rpc under an
# app_server bearer, exactly as lib/db/server.mjs callAs builds it. aal2 is passed where the design says the server
# copies it from a verified session; the aal1 and absent cases are the negative arms.
# ---------------------------------------------------------------------------
op_call() { # routine json [aal=aal2] [operator-user=$U_op]
  rest POST "/rpc/$1" "$(server_jwt "${4:-$U_op}" "${3-aal2}")" "$2"
}
as_call() { # routine json user [aal]
  rest POST "/rpc/$1" "$(server_jwt "$3" "${4-}")" "$2"
}
# api.transfer_agent, api.departure_preview and api.export_company are the three member-facing E6 routines.
transfer() { # user agent to-membership expected-owner [aal]
  as_call transfer_agent "$(jbody p_agent="$2" p_to_membership="$3" p_expected_owner="$4")" "$1" "${5-}"
}
preview() { as_call departure_preview "$(jbody p_membership="$2")" "$1" "${3-aal2}"; }
export_as() { as_call export_company "$(jbody p_company="$2")" "$1" "${3-aal2}"; }

# The whole answer of any routine, written to a file, with "HTTP <status>" on stdout. tests/db/lib.sh rest prints only
# the FIRST 400 BYTES of a body, so a register of thirty companies, an export document or a mutant's leak past that
# point is invisible to a probe reading rest's output, and a string search over it passes on nothing (E6DB-F11).
# Every assertion over a whole answer in probes 29 to 31 reads a file written here.
op_body() { # routine json out-file [aal=aal2] [operator-user=$U_op]
  curl -sS -o "$3" -w 'HTTP %{http_code}' -X POST "$API_URL/rest/v1/rpc/$1" \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $(server_jwt "${5:-$U_op}" "${4-aal2}")" \
    -H 'Content-Type: application/json' -d "$2"
}
as_body() { # routine json out-file user [aal]
  curl -sS -o "$3" -w 'HTTP %{http_code}' -X POST "$API_URL/rest/v1/rpc/$1" \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $(server_jwt "$4" "${5-}")" \
    -H 'Content-Type: application/json' -d "$2"
}
# A view read whole, for the same reason.
view_body() { # path jwt out-file
  curl -sS -o "$3" -w 'HTTP %{http_code}' "$API_URL/rest/v1$1" \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $2"
}

# The whole answer of one export, written to a file, with "HTTP <status>" on stdout: tests/db/lib.sh rest prints only
# the first 400 bytes and an export document is far larger, so a probe reading a section out of rest's output would be
# matching against a truncated string (E5's download_body has the same reason).
export_body() { # user company out-file [aal]
  curl -sS -o "$3" -w 'HTTP %{http_code}' -X POST "$API_URL/rest/v1/rpc/export_company" \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $(server_jwt "$1" "${4-aal2}")" \
    -H 'Content-Type: application/json' -d "$(jbody p_company="$2")"
}
# One field of a table-returning routine's answer. PostgREST answers a `returns table` routine with an ARRAY of one
# row, so tests/db/e3-lib.sh's `field`, which indexes the parsed object directly, reads nothing from it: every E6
# routine but the four returning jsonb is a table routine (observed while writing probe 29, E6DB-F8).
row_field() { # "HTTP <status> <json>" name [row-index]
  printf '%s' "$1" | node -e '
    const input = require("node:fs").readFileSync(0, "utf8").trim();
    const json = input.startsWith("HTTP ") ? input.slice(input.indexOf(" ", 5) + 1) : input;
    const rows = JSON.parse(json);
    const row = Array.isArray(rows) ? rows[Number(process.argv[2] ?? 0)] : rows;
    const v = row?.[process.argv[1]];
    process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));' "$2" "${3-0}"
}
# An authenticated caller's own token, minted with the local secret as tests/db/09-closure.sh mints one, so a view is
# read under row level security rather than through a definer routine.
user_token() { # user-id [aal]
  node -e '
    const c = require("node:crypto"); const [sub, aal] = process.argv.slice(1);
    const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub, role: "authenticated", aud: "authenticated", iat: now, exp: now + 300 };
    if (aal) claims.aal = aal;
    const h = b({ alg: "HS256", typ: "JWT" }), p = b(claims);
    process.stdout.write(h + "." + p + "." + c.createHmac("sha256", process.env.JWT_SECRET).update(h + "." + p).digest("base64url"));' "$1" "${2-}"
}
# A confirmed synthetic account and, when a company is named, an active membership in it. Sets U_<tag> and MS_<tag>,
# so the tag has to be a shell-variable name: the run id goes into the ADDRESS, from $E6_RUN, which each probe sets
# once. A tag with a hyphen in it is a "command not found" and not a test failure (E6DB-F10).
e6_person() { # tag [company] [roles, default {member}]
  local uid ms roles
  uid="$(create_user "e6-${E6_RUN:?E6_RUN is unset}-$1@example.invalid" "$E6_PW")"
  eval "U_$1=$uid"
  if [ -n "${2-}" ]; then
    roles="${3-}"
    if [ -z "$roles" ]; then roles='{member}'; fi
    ms="$(member "$2" "$uid" "$roles")"
    eval "MS_$1=$ms"
  fi
}

# One field of a saved JSON answer, by dotted path, parsed in Node. An absent path prints nothing and exits non-zero,
# so a probe cannot pass on an unparsed answer. A numeric path element indexes an array.
jfield() { # file dotted-path
  node -e '
    const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const v = process.argv[2].split(".").reduce((o, k) => (o == null ? o : o[k]), j);
    if (v === undefined) process.exit(1);
    process.stdout.write(v === null ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v));' "$1" "$2"
}
# The byte length of a saved answer as the wire carried it, for case 25's recorded comparison.
wire_bytes() { wc -c < "$1" | tr -d ' '; }

# ---------------------------------------------------------------------------
# Owner-side setup, labelled as design section 5 labels it: no route ages a date or seeds a company at a quota.
# ---------------------------------------------------------------------------
# An access period at an exact age, written directly because api.set_access_period derives export_by and delete_by
# from two constants and refuses starts_at >= ends_at, so a period that has already ended cannot be typed in.
age_period() { # company ends-at-interval-ago export-by-interval-ago delete-by-interval-ago
  sql -c "insert into app.access_periods (company_id, starts_at, ends_at, export_by, delete_by)
          values ('$1', clock_timestamp() - interval '$2' - interval '1 day',
                  clock_timestamp() - interval '$2',
                  clock_timestamp() - interval '$3',
                  clock_timestamp() - interval '$4')
          on conflict on constraint access_periods_pkey do update
            set starts_at = excluded.starts_at, ends_at = excluded.ends_at,
                export_by = excluded.export_by, delete_by = excluded.delete_by" >/dev/null
}
# A period whose three boundaries are all ahead: the control every aged case compares against.
future_period() { # company
  sql -c "insert into app.access_periods (company_id, starts_at, ends_at, export_by, delete_by)
          values ('$1', clock_timestamp() - interval '1 day', clock_timestamp() + interval '1 hour',
                  clock_timestamp() + interval '15 days', clock_timestamp() + interval '45 days')
          on conflict on constraint access_periods_pkey do update
            set starts_at = excluded.starts_at, ends_at = excluded.ends_at,
                export_by = excluded.export_by, delete_by = excluded.delete_by" >/dev/null
}
drop_period() { sql -c "delete from app.access_periods where company_id = '$1'" >/dev/null; }
access_state() { sql -c "select app.access_state('$1')"; }
deletion_state() { sql -c "select app.deletion_state('$1')"; }
# A company's status, moved owner-side under the deletion bypass where the move is out of 'closed', which
# app.company_status_guard admits only that way (design 1.6).
set_status() { # company status
  sql -c "begin; set local app.tenant_deletion = 'on'; update app.companies set status = '$2' where id = '$1'; commit;" >/dev/null
}
# N pending invitations for one company, owner-side: fifty through the route would be fifty requests, and the
# one-pending unique index means each needs its own address.
fill_invitations() { # company created-by-membership n tag
  sql -c "insert into app.invitations (company_id, email_normalized, token_hash, roles, expires_at, created_by)
          select '$1', 'e6-$4-' || g || '@example.invalid',
                 extensions.digest(extensions.gen_random_bytes(32), 'sha256'), '{member}',
                 clock_timestamp() + interval '7 days', '$2'
            from generate_series(1, $3) g" >/dev/null
}
# N extra active memberships in one company, owner-side, each with its own account.
fill_members() { # company n tag
  local i uid
  i=1
  while [ "$i" -le "$2" ]; do
    uid="$(create_user "e6-$3-m$i@example.invalid" "$E6_PW")"
    sql -c "insert into app.memberships (company_id, user_id, roles) values ('$1', '$uid', '{member}')" >/dev/null
    i=$((i + 1))
  done
}
# An invitation created owner-side with a token the probe knows, so an acceptance can be driven without a route.
# Prints "<invitation id>|<code>".
seeded_invitation() { # company email roles created-by-membership|operator-user [operator]
  local tok col id
  tok="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  col=created_by
  if [ "${5:-}" = operator ]; then col=created_by_operator; fi
  id="$(first "$(sql -c "insert into app.invitations (company_id, email_normalized, token_hash, roles, expires_at, $col)
               values ('$1', '$2', extensions.digest(decode('$tok', 'hex'), 'sha256'), '$3',
                       clock_timestamp() + interval '7 days', '$4') returning id")")"
  # Loudly, because the one-pending unique index refuses a second live invitation for the same address and a caller
  # that read an empty id would then accept a token no row holds and see E_INVITATION_INVALID instead of the refusal
  # it meant to test (E6DB-F13).
  if [ -z "$id" ]; then printf 'seeded_invitation: no row for %s in %s\n' "$2" "$1" >&2; return 1; fi
  printf '%s|%s' "$id" "$tok"
}
accept_as() { as_call accept_invitation "$(jbody p_invite_code="$2")" "$1" "${3-}"; }
audit_count() { sql -c "select count(*) from app.audit_events where company_id = '$1'"; }
audit_actions() { sql -c "select coalesce(string_agg(action, ',' order by id), 'NONE') from app.audit_events where company_id = '$1'"; }
# Every audit row of one action anywhere, including the company_id null rows a deletion and the sweep write.
audit_of() { sql -c "select coalesce(string_agg(action || '|' || coalesce(company_id::text, 'null'), ',' order by id), 'NONE') from app.audit_events where action = '$1'"; }
agent_row_hash() { sql -c "select md5(a::text) from app.agents a where a.id = '$1'"; }
release_row_hash() { sql -c "select md5(r::text) from app.releases r where r.id = '$1'"; }

# A mutant of a live routine, installed from a fixture file so the counterexample is an owner-only artefact under
# tests/db/fixtures/ and never a line of the migration (design 2.7, the assignment's rule). Each fixture saves nothing:
# restore_e6_mutant reinstalls the routine's committed definition, which the probe captured first.
E6_SAVED="$E2_TMP/e6-saved"; mkdir -p "$E6_SAVED"
save_routine() { # regprocedure key
  sql -c "select pg_get_functiondef('$1'::regprocedure)" > "$E6_SAVED/$2.sql"
  printf ';\n' >> "$E6_SAVED/$2.sql"
}
restore_routine() { sql < "$E6_SAVED/$1.sql" >/dev/null; }
apply_fixture() { sql < "$ROOT/tests/db/fixtures/$1" >/dev/null; }

# One mutation of a LIVE routine through tests.e6_mutate (tests/db/fixtures/e6-mutate.sql): the routine's own
# pg_get_functiondef with one substitution, so a fail-before cannot drift from the migration and an anchor the
# migration has moved RAISES instead of passing on nothing. Dollar-quoted, so an anchor may carry single quotes
# and newlines. The probe still saves the committed definition with save_routine and restores it afterwards.
e6_mutate() { # routine-signature anchor replacement
  sql -c "select tests.e6_mutate(\$m\$$1\$m\$, \$m\$$2\$m\$, \$m\$$3\$m\$)" >/dev/null
}
# The number of rows one authenticated view read returns, through PostgREST under the caller's OWN token, so the
# answer is row level security's and not a definer routine's. A refusal prints CODE:<token> and an unparsed body
# prints UNPARSED, because a read that is refused, a read that is empty and a read that did not parse are three
# different facts and E6S-C-F2's matrix has to say which one it saw.
view_rows() { # path token
  curl -sS "$API_URL/rest/v1$1" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $2" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let j; try { j = JSON.parse(s); } catch { process.stdout.write("UNPARSED"); return; }
      process.stdout.write(Array.isArray(j) ? String(j.length) : "CODE:" + (j.code ?? j.message ?? "?"));
    });'
}

# PostgREST reads a function's default_transaction_isolation from its SCHEMA CACHE and issues the isolation level for
# the transaction it opens, so a change to the function's own setting does not reach the running service until the
# cache reloads (E6DB-F14: without this, a probe that resets the setting still observes `repeatable read`). The wait
# polls the observable rather than sleeping a fixed time.
pgrst_reload() { sql -c "notify pgrst, 'reload schema'" >/dev/null; }
# Poll the isolation the real RPC reports until it is the expected one, up to N tenths of a second. It needs
# tests/db/fixtures/e6-export-reads-isolation.sql installed, which adds observed_isolation to the answer.
wait_isolation() { # user company expected out-file [tenths]
  local i
  for i in $(seq 1 "${5:-100}"); do
    export_body "$1" "$2" "$4" >/dev/null 2>&1 || true
    if [ "$(jfield "$4" observed_isolation 2>/dev/null || true)" = "$3" ]; then return 0; fi
    sleep 0.1
  done
  printf 'wait_isolation: never saw %s\n' "$3" >&2
  return 1
}

# Owner-side: widen one candidate's stored content past the content bound, so the export's gate 1 can be observed
# refusing. Labelled as design section 5 labels it: no route writes a candidate above the bound, and the identity
# guard recomputes the hash on every update, so the row is rewritten inside one owner transaction with that guard
# and the immutability guard disabled, which is the one thing only the owner can do (the shape of e5-lib.sh's
# age_ledger). The hash is kept consistent with the new bytes, so nothing downstream reads a row that lies.
# The target is the content bound itself, 262,144 bytes, which is the largest a candidate may be: 003's CHECK
# constraint is a table constraint and not a trigger, so nothing may exceed it and a company above the export's gate
# 1 is made of enough candidates at the bound rather than one candidate past it (E6DB-F18).
pad_candidate() { # candidate
  sql -c "begin;
    alter table app.candidate_versions disable trigger candidate_2_identity;
    alter table app.candidate_versions disable trigger candidate_1_immutable;
    update app.candidate_versions
       set content = content || repeat(' ', 262144 - octet_length(content)),
           content_sha256 = extensions.digest(
             convert_to(content || repeat(' ', 262144 - octet_length(content)), 'UTF8'), 'sha256')
     where id = '$1' and octet_length(content) < 262144;
    alter table app.candidate_versions enable trigger candidate_1_immutable;
    alter table app.candidate_versions enable trigger candidate_2_identity;
    commit;" >/dev/null
}

# One E6 call written as SQL for an owner session that must hold its transaction open (probes 28 and 31's shape). The
# claims are the ones a server bearer carries; app.server_actor() reads role and sub, and app.require_mfa reads aal.
claims_of() { # user [aal]
  if [ -n "${2-}" ]; then
    printf '{"role":"app_server","sub":"%s","iss":"phaeacia-server","aal":"%s"}' "$1" "$2"
  else
    printf '{"role":"app_server","sub":"%s","iss":"phaeacia-server"}' "$1"
  fi
}
as_claims_sql() { printf "select set_config('request.jwt.claims', '%s', true);\n" "$(claims_of "$1" "${2-}")"; }
transfer_sql() { # user agent to-membership expected-owner [aal]
  as_claims_sql "$1" "${5-aal2}"
  printf "select 'TRANSFER|' || t.changed from api.transfer_agent('%s', '%s', '%s') t;\n" "$2" "$3" "$4"
}
remove_sql() { # user membership [aal]
  as_claims_sql "$1" "${3-aal2}"
  printf "select 'REMOVE|' || r.changed from api.remove_member('%s') r;\n" "$2"
}
set_roles_sql() { # user membership roles [aal]
  as_claims_sql "$1" "${4-aal2}"
  printf "select 'ROLES|' || r.changed from api.set_roles('%s', '%s') r;\n" "$2" "$3"
}
delete_sql() { # user company slug reason
  as_claims_sql "$1" aal2
  printf "select 'DELETE|' || (d.deleted ->> 'companies') from api.delete_company('%s', '%s', '%s') d;\n" "$2" "$3" "$4"
}
# api.add_operator inside an open owner session, for E6S-C-F1's order B: the operator door holds the account lock
# it takes while the probe decides when to commit.
add_operator_sql() { # operator-user target-user
  as_claims_sql "$1" aal2
  printf "select 'ADDOP|' || o.changed from api.add_operator('%s') o;\n" "$2"
}
# How many principals one account holds: 'op|member' counts, so a dual principal reads 1|1 and a settled one 1|0
# or 0|1. Literal, because expect greps its third argument.
principals_of() { # user
  sql -c "select (select count(*) from app.operators o where o.user_id = '$1') || '|' ||
                 (select count(*) from app.memberships m where m.user_id = '$1')"
}
# api.set_access_period inside an open owner session, for E6S-C-F7's schedule: the extension holds the operator
# company lock the expiry run is queued behind.
set_access_period_sql() { # operator-user company starts-at ends-at
  as_claims_sql "$1" aal2
  printf "select 'PERIOD|' || p.changed from api.set_access_period('%s', null, '%s', '%s') p;\n" "$2" "$3" "$4"
}

# ---------------------------------------------------------------------------
# The upgrade path (evidence/e6-design-critique.md rule 10's outcome: "test an upgrade from the accepted 007 schema as
# well as fresh install and compare unaffected function bodies/refusals"). A `supabase db reset` applies 001 to 008 in
# order to an EMPTY database, so it is the fresh install; what a pilot database meets instead is 008 applied over rows,
# and the pin gate proves 001 to 007's bytes rather than the semantics of a later replacement.
#
# The scratch database is built in the same cluster and never through the CLI: a new database from template0, the
# extensions 001 needs, the auth schema's STRUCTURE copied with pg_dump (GoTrue owns those tables and 001 references
# them by foreign key), then 001 to 007 in file order, then the seed, then 008. It is dropped at the end.
# The honest limit, stated where it bites: PostgREST points at the project's own database, so this path establishes
# the DATABASE half of the upgrade, the function bodies and the owner-side refusals, and no route.
# ---------------------------------------------------------------------------
UPGRADE_DB=""
up_sql() { docker exec -i "$DB_CONTAINER" psql -U postgres -d "${UPGRADE_DB:?}" -X -v ON_ERROR_STOP=1 -At "$@"; }
up_try() { docker exec -i "$DB_CONTAINER" psql -U postgres -d "${UPGRADE_DB:?}" -X -At "$@" 2>&1 || true; }
# One statement in a transaction that is always rolled back, errors printed rather than fatal, for the accepted
# refusals over rows that existed before 008 was applied.
up_rollback() { printf 'begin;\n%s\nrollback;\n' "$*" | up_try; }
up_create() { # name
  UPGRADE_DB="$1"
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -X -At -c "drop database if exists $1 with (force)" >/dev/null 2>&1 || true
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -At -c "create database $1 template template0" >/dev/null
  up_sql <<'SQL' >/dev/null
create schema if not exists extensions;
create extension if not exists pgcrypto schema extensions;
create extension if not exists pgjwt schema extensions;
SQL
  # The auth schema's structure, as GoTrue built it in the project's own database. `alter default privileges` is
  # refused for a non-superuser owner and is the only statement that fails, which nothing here depends on.
  docker exec -i "$DB_CONTAINER" pg_dump -U postgres -d postgres --schema-only -n auth --no-owner \
    | docker exec -i "$DB_CONTAINER" psql -U postgres -d "$1" -X -At >/dev/null 2>&1 || true
}
up_drop() {
  [ -n "$UPGRADE_DB" ] || return 0
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -X -At -c "drop database if exists $UPGRADE_DB with (force)" >/dev/null 2>&1 || true
  UPGRADE_DB=""
}
up_apply() { # migration-file-name; prints "ok" or the failure's ERROR line and its DETAIL, which is where a
             # refusal that names a count rather than interpolating it into the message puts the count.
  if up_sql < "$ROOT/supabase/migrations/$1" >"$E2_TMP/up-$1.log" 2>&1; then printf 'ok'; else
    printf 'FAILED: %s' "$(grep -m2 '^ERROR\|^DETAIL\|^psql:' "$E2_TMP/up-$1.log" | tr '\n' ' ' | head -c 300)"; fi
}
up_apply_fixture() { # fixture-file-name
  if up_sql < "$ROOT/tests/db/fixtures/$1" >"$E2_TMP/up-fix-$1.log" 2>&1; then printf 'ok'; else
    printf 'FAILED: %s' "$(grep -m1 '^ERROR' "$E2_TMP/up-fix-$1.log" | head -c 200)"; fi
}
# md5 of pg_get_functiondef for every function in app and api, one line each, for the two databases to be compared.
FUNC_FINGERPRINT="select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('app', 'api') order by 1;"
