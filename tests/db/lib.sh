#!/usr/bin/env bash
# Shared helpers for the E2 database probes. Local Supabase only. Keys are read from
# `supabase status` at run time and never written to disk or Git.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATUS_ENV="$(cd "$ROOT" && supabase status -o env 2>/dev/null)"
getv() { printf '%s\n' "$STATUS_ENV" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" | head -1; }
API_URL="$(getv API_URL)"
ANON_KEY="$(getv ANON_KEY)"
SERVICE_ROLE_KEY="$(getv SERVICE_ROLE_KEY)"
JWT_SECRET="$(getv JWT_SECRET)"
# The SQL target is derived from this checkout's project id, never from "the first
# supabase_db_* container" (L2): another local stack must not become the target.
PROJECT_ID="$(sed -n 's/^project_id *= *"\([^"]*\)".*/\1/p' "$ROOT/supabase/config.toml" | head -1)"
DB_CONTAINER="supabase_db_$PROJECT_ID"
if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "lib.sh: database container $DB_CONTAINER is not running" >&2; exit 2
fi
# Per-process scratch for HTTP bodies (L2): parallel probes never read each other's output.
E2_TMP="$(mktemp -d "${TMPDIR:-/tmp}/e2rest.XXXXXX")"
trap 'rm -rf "$E2_TMP"' EXIT

# SQL as the migration owner (postgres). Prefer a host psql if present.
sql() {
  if command -v psql >/dev/null 2>&1; then
    psql "$(getv DB_URL)" -X -v ON_ERROR_STOP=1 -At "$@"
  else
    docker exec -i "$DB_CONTAINER" psql -U postgres -X -v ON_ERROR_STOP=1 -At "$@"
  fi
}
# Same, but errors are printed rather than fatal (for refusal probes).
sql_try() {
  if command -v psql >/dev/null 2>&1; then
    psql "$(getv DB_URL)" -X -At "$@" 2>&1 || true
  else
    docker exec -i "$DB_CONTAINER" psql -U postgres -X -At "$@" 2>&1 || true
  fi
}

# Create a confirmed synthetic user through the local GoTrue admin API. Prints the user id.
create_user() { # email password
  curl -sS "$API_URL/auth/v1/admin/users" \
    -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\",\"email_confirm\":true}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.id){console.error(s);process.exit(1)}console.log(j.id)})'
}

# Real GoTrue-issued access token for a user (password grant). Prints the JWT.
user_jwt() { # email password
  curl -sS "$API_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.access_token){console.error(s);process.exit(1)}console.log(j.access_token)})'
}

# Server-minted token: role=app_server, sub=user, optional aal. This is the design's
# lib/db/server.mjs serverToken(); HS256 with the local secret, 60 s lifetime. Admin and
# operator mutations need aal2 (H2), so probes pass it explicitly where the design says the
# server copies it from a verified session; the aal1/absent cases are the negative probes.
# The optional third argument is a JSON object merged into the claims last; the bound-bearer
# probe (01, section 1g) passes fn, args_sha256 and jti this way.
server_jwt() { # user_id [aal] [extra-claims-json]
  node -e '
    const c=require("node:crypto"); const [sub,aal,extra]=process.argv.slice(1);
    const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
    const now=Math.floor(Date.now()/1000);
    const claims={role:"app_server",sub,iss:"phaeacia-server",iat:now,exp:now+60};
    if(aal) claims.aal=aal;
    if(extra) Object.assign(claims, JSON.parse(extra));
    const h=b({alg:"HS256",typ:"JWT"}), p=b(claims);
    const sig=c.createHmac("sha256",process.env.JWT_SECRET).update(h+"."+p).digest("base64url");
    console.log(h+"."+p+"."+sig);' "$@"
}
export JWT_SECRET

# PostgREST call. Prints "HTTP <status>" then the body. Each call writes its answer to its own temporary file, so two
# calls started in the background cannot read each other's body (E5S-F12, evidence/e5-server.md: two concurrent
# downloads both printed E_DOWNLOAD_LIMIT while the ledger showed one had authorized). "$E2_TMP/body" still receives a
# copy of the last finished call's whole body for the one probe that reads it after a sequential call (probe 19);
# never read it after concurrent calls.
rest() { # method path jwt [json-body]
  local m="$1" p="$2" j="$3" body="${4:-}" out code
  out="$(mktemp "$E2_TMP/rest.XXXXXX")"
  if [ -n "$body" ]; then
    code="$(curl -sS -o "$out" -w '%{http_code}' -X "$m" "$API_URL/rest/v1$p" \
      -H "apikey: $ANON_KEY" -H "Authorization: Bearer $j" -H 'Content-Type: application/json' \
      -H 'Prefer: return=representation' -d "$body")"
  else
    code="$(curl -sS -o "$out" -w '%{http_code}' -X "$m" "$API_URL/rest/v1$p" \
      -H "apikey: $ANON_KEY" -H "Authorization: Bearer $j")"
  fi
  cp "$out" "$E2_TMP/body"
  printf 'HTTP %s %s\n' "$code" "$(head -c 400 "$out")"
  rm -f "$out"
}

section() { printf '\n== %s ==\n' "$*"; }
expect() { # label actual expected-substring
  if printf '%s' "$2" | grep -q -- "$3"; then printf 'PASS %s: %s\n' "$1" "$(printf '%s' "$2" | head -c 160 | tr '\n' ' ')";
  else printf 'FAIL %s: expected "%s" got: %s\n' "$1" "$3" "$(printf '%s' "$2" | head -c 300 | tr '\n' ' ')"; FAILED=1; fi
}
FAILED=0

# After `supabase db reset` PostgREST rebuilds its schema cache; wait until it answers.
wait_rest() {
  local i
  for i in $(seq 1 60); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' "$API_URL/rest/v1/companies?select=id" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" || true)"
    case "$code" in 200|401|403|404) return 0;; esac
    sleep 1
  done
  echo "PostgREST not ready after 60 s (last HTTP $code)"; return 1
}
