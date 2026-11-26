#!/usr/bin/env bash
# Probe 20: migration 004 Part B, the lead-owned database prerequisites of pages construction (docs/e2/pages-design.md
# revision 7, sections 2.1 and 2.8).
#   20a api.set_display_name through PostgREST with server tokens: the same rows of 2.1's shared corpus (S13d), the
#       shape and conversion rows recorded (S13p), the changed flag and its one audit row (S13 a, b), another user's row
#       (S13f), a missing account, a bound bearer (S13h), and who may execute it (S13g)
#   20b app.hook_mfa_verification_attempt, called directly by the owner with the event 2.8 and O16 describe: the budget
#       and its refusal shape, a valid sixth, a valid fifth, two accounts, two factors, the window, ten at once, the
#       grants (the database half of S11h)
# The GoTrue-driven cases, S4 and S11a to S11h, need TOTP and the hook block of 2.7 in force, which only a stack restart
# gives: they belong to pages construction and the lead's phases. Mutants B1 and B2 run in owner transactions that are
# always rolled back. Run: bash tests/db/20-profiles-and-mfa-bound.sh (after tests/db/00-seed.sh).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
RUN="$(run_id)"; PW20='Synthetic-Pass-1234'
ANSWERS="$E2_TMP/20-answers"; : > "$ANSWERS"

# One RPC body, {"p_display_name": <value>}, built in Node from a JavaScript expression over cp (String.fromCodePoint)
# and lone (String.fromCharCode, for a lone surrogate), so no control, format or bidirectional character passes through
# a shell literal, and JSON.stringify writes U+0000 and a lone surrogate as the escapes S13p names. Expressions here
# never hold a brace with a comma: bash 3.2 brace-expands that inside a nested command substitution (tests/db/19).
dn_body() { node -e 'const cp = (...p) => String.fromCodePoint(...p); const lone = (u) => String.fromCharCode(u);
  process.stdout.write(JSON.stringify({ p_display_name: eval(`(${process.argv[1]})`) }))' "$1"; }
hex_of() { node -e 'const cp = (...p) => String.fromCodePoint(...p); process.stdout.write(Buffer.from(eval(`(${process.argv[1]})`), "utf8").toString("hex"))' "$1"; }
is_body() { printf '%s' "$1" | node -e 'try { const b = JSON.parse(require("node:fs").readFileSync(0, "utf8")); process.stdout.write(Object.hasOwn(b, "p_display_name") ? "body" : "no key"); } catch { process.stdout.write("not json"); }'; }
setname() { rest POST /rpc/set_display_name "$(server_jwt "$1")" "$2"; }
stored_hex() { sql -c "select coalesce((select encode(convert_to(display_name, 'UTF8'), 'hex') from app.profiles where user_id = '$1'), 'none')"; }
psnap() { sql -c "select coalesce((select encode(convert_to(display_name, 'UTF8'), 'hex')||'|'||updated_at from app.profiles where user_id = '$1'), 'none')||'|'||(select count(*) from app.audit_events where action = 'profile.set_display_name')"; }
same_stored() { # label user value-expression stored-expression
  local body r
  body="$(dn_body "$3")"; expect "S13d $1: the body names p_display_name" "$(is_body "$body")" '^body$'
  r="$(setname "$2" "$body")"
  expect "S13d $1: 200" "$r" '^HTTP 200 \[{"changed":'
  expect "S13d $1: the row holds exactly the normalized value" "$(stored_hex "$2")" "^$(hex_of "$4")\$"
}
same_refused() { # label user value-expression
  local body b r
  body="$(dn_body "$3")"; expect "S13d $1: the body names p_display_name" "$(is_body "$body")" '^body$'
  b="$(psnap "$2")"
  r="$(setname "$2" "$body")"
  expect "S13d $1: 22023 E_BODY_INVALID" "$r" '"code":"22023".*"message":"E_BODY_INVALID"'
  expect "S13d $1: no write and no audit row" "$(psnap "$2")" "^$b\$"
}

section "20 setup: users with no membership (a profile belongs to the account, pages design 2.1)"
U_S="$(create_user "e2-20-$RUN-corpus@example.invalid" "$PW20")"
U_P="$(create_user "e2-20-$RUN-shapes@example.invalid" "$PW20")"
U_B="$(create_user "e2-20-$RUN-ada@example.invalid" "$PW20")"
U_C="$(create_user "e2-20-$RUN-grace@example.invalid" "$PW20")"
expect "setup" "$U_S|$U_P|$U_B|$U_C" '^[0-9a-f-]\{36\}|[0-9a-f-]\{36\}|[0-9a-f-]\{36\}|[0-9a-f-]\{36\}$'

section "20a S13d: the same rows of the shared corpus, sent directly, in corpus order against one account"
same_stored "Ada" "$U_S" "'Ada'" "'Ada'"
same_stored "two spaces each side of Ada" "$U_S" "'  Ada  '" "'Ada'"
same_stored "120 code points of one astral character" "$U_S" "cp(0x1f600).repeat(120)" "cp(0x1f600).repeat(120)"
same_stored "120 characters inside one space each side" "$U_S" "' ' + 'x'.repeat(120) + ' '" "'x'.repeat(120)"
same_stored "Zo and U+00EB" "$U_S" "'Zo' + cp(0xeb)" "'Zo' + cp(0xeb)"
same_stored "a right-to-left name" "$U_S" "cp(0x5e2, 0x5d3, 0x5d4)" "cp(0x5e2, 0x5d3, 0x5d4)"
same_stored "an emoji ZWJ sequence" "$U_S" "cp(0x1f469, 0x200d, 0x1f4bb)" "cp(0x1f469, 0x200d, 0x1f4bb)"
same_stored "U+00A0 inside the name and at both ends, kept" "$U_S" "cp(0xa0) + 'Ada' + cp(0xa0) + 'Lovelace' + cp(0xa0)" "cp(0xa0) + 'Ada' + cp(0xa0) + 'Lovelace' + cp(0xa0)"
# The contrast with Part A, observed: the declared-name class trims these; the profile rule trims U+0020 only.
same_stored "U+3000 before, kept" "$U_S" "cp(0x3000) + 'Ada'" "cp(0x3000) + 'Ada'"
same_stored "U+FEFF before, kept" "$U_S" "cp(0xfeff) + 'Ada'" "cp(0xfeff) + 'Ada'"
same_stored "U+2028 after, kept" "$U_S" "'Ada' + cp(0x2028)" "'Ada' + cp(0x2028)"
same_refused "the empty string" "$U_S" "''"
same_refused "three spaces" "$U_S" "'   '"
same_refused "121 code points" "$U_S" "cp(0x1f600).repeat(121)"
same_refused "U+0001" "$U_S" "'A' + cp(1) + 'da'"
same_refused "a tab before Ada, refused and not trimmed" "$U_S" "cp(9) + 'Ada'"
same_refused "U+001F" "$U_S" "'Ada' + cp(0x1f)"
same_refused "U+007F" "$U_S" "'Ada' + cp(0x7f)"
same_refused "U+009F" "$U_S" "'Ada' + cp(0x9f)"
same_refused "U+061C" "$U_S" "'Ada' + cp(0x61c)"
same_refused "U+200E" "$U_S" "'Ada' + cp(0x200e)"
same_refused "U+202E" "$U_S" "'Ada' + cp(0x202e)"
same_refused "U+2066" "$U_S" "'Ada' + cp(0x2066)"

section "20a S13p: inputs that are not strings or cannot become text, sent directly; PostgREST's answers are recorded"
observe() { printf 'observation S13p %s: %s\n' "$1" "$(printf '%s' "$2" | head -c 240)" | tee -a "$ANSWERS"; }
r="$(setname "$U_P" '{"p_display_name":123}')"; observe "a JSON number, 123" "$r"
expect "S13p 123: stored as the text 123" "$(stored_hex "$U_P")" "^$(hex_of "'123'")\$"
r="$(setname "$U_P" '{"p_display_name":[]}')"; observe "a JSON array, []" "$r"
expect "S13p []: stored as the text []" "$(stored_hex "$U_P")" "^$(hex_of "'[]'")\$"
B="$(psnap "$U_P")"
r="$(setname "$U_P" '{"p_display_name":null}')"; observe "null" "$r"
expect "S13p null: 22023 E_BODY_INVALID from the function's v is null clause" "$r" '"code":"22023".*"message":"E_BODY_INVALID"'
expect "S13p null: no write and no audit row" "$(psnap "$U_P")" "^$B\$"
r="$(setname "$U_P" '{}')"; observe "an absent key, {}" "$r"
expect "S13p {}: no write and no audit row" "$(psnap "$U_P")" "^$B\$"
r="$(setname "$U_P" "$(dn_body 'cp(0)')")"; observe "U+0000 as the JSON escape" "$r"
expect "S13p U+0000: no write and no audit row" "$(psnap "$U_P")" "^$B\$"
r="$(setname "$U_P" "$(dn_body 'lone(0xd800)')")"; observe "a lone surrogate as the JSON escape" "$r"
expect "S13p lone surrogate: no write and no audit row" "$(psnap "$U_P")" "^$B\$"

section "20a S13 (a), (b), (f): the changed flag, one audit row with the user's id and nothing else, another user's row"
r="$(setname "$U_C" "$(dn_body "'Grace'")")"; expect "fixture: another user names themself" "$r" '^HTTP 200 \[{"changed":true}\]'
C_ROW="$(psnap "$U_C" | cut -d'|' -f1-2)"
r="$(setname "$U_B" "$(dn_body "'  Ada Example  '")")"; expect "(a) a new name: changed true" "$r" '^HTTP 200 \[{"changed":true}\]'
expect "(a) the row holds the trimmed name" "$(stored_hex "$U_B")" "^$(hex_of "'Ada Example'")\$"
AUDIT_B="select count(*)||'|'||bool_and(company_id is null)||'|'||string_agg(actor_kind, ',')||'|'||string_agg(entity_type, ',')||'|'||string_agg(actor_user_id::text, ',')||'|'||string_agg(details::text, ',') from app.audit_events where action = 'profile.set_display_name' and entity_id = '$U_B'"
expect "(a) one audit row: company_id null, actor_kind member, entity profile, the user as actor, details exactly the user id" "$(sql -c "$AUDIT_B")" "^1|true|member|profile|$U_B|{\"user_id\": \"$U_B\"}\$"
UPDATED="$(sql -c "select updated_at from app.profiles where user_id = '$U_B'")"
r="$(setname "$U_B" "$(dn_body "'Ada Example'")")"; expect "(b) the same trimmed name again: changed false" "$r" '^HTTP 200 \[{"changed":false}\]'
expect "(b) still one audit row in total for that user" "$(sql -c "$AUDIT_B" | cut -d'|' -f1)" '^1$'
expect "(b) updated_at unchanged" "$(sql -c "select updated_at from app.profiles where user_id = '$U_B'")" "^$UPDATED\$"
expect "no audit row carries the name" "$(sql -c "select count(*) from app.audit_events where details::text like '%Ada Example%' or entity_type like '%Ada%'")" '^0$'
r="$(setname "$U_B" "$(dn_body "'Ada Other'")")"; expect "(f) the user renames themself: changed true" "$r" '^HTTP 200 \[{"changed":true}\]'
expect "(f) the other user's row is untouched" "$(psnap "$U_C" | cut -d'|' -f1-2)" "^$C_ROW\$"

section "20a a missing account, a bound bearer (S13h), and who may execute the function (S13g)"
GHOST="$(uuid)"; B="$(psnap "$U_B")"
r="$(rest POST /rpc/set_display_name "$(server_jwt "$GHOST")" "$(dn_body "'Ghost'")")"
expect "a server token for an account that does not exist: P0002 E_NOT_FOUND" "$r" '"code":"P0002".*"message":"E_NOT_FOUND"'
expect "and no profile row for it" "$(stored_hex "$GHOST")" '^none$'
BOUND_CLAIMS="$(node -e 'process.stdout.write(JSON.stringify({ fn: "save_draft", args_sha256: "a".repeat(64), jti: require("node:crypto").randomUUID() }))')"
r="$(rest POST /rpc/set_display_name "$(server_jwt "$U_B" aal1 "$BOUND_CLAIMS")" "$(dn_body "'Bound'")")"
expect "(h) a server token carrying fn: 42501 E_NOT_SERVER" "$r" '"code":"42501".*"message":"E_NOT_SERVER"'
r="$(rest POST /rpc/set_display_name "$ANON_KEY" "$(dn_body "'Anon'")")"
expect "(g) anon through PostgREST: permission denied" "$r" '"code":"42501"'
observe "anon's answer" "$r"
B_JWT="$(user_jwt "e2-20-$RUN-ada@example.invalid" "$PW20")"
r="$(rest POST /rpc/set_display_name "$B_JWT" "$(dn_body "'Self'")")"
expect "(g) the user's own GoTrue token through PostgREST: permission denied" "$r" '"code":"42501"'
observe "authenticated's answer" "$r"
expect "and none of the refused calls wrote" "$(psnap "$U_B")" "^$B\$"
expect "(g) execute: app_server yes; anon, authenticated, service_role no" "$(sql -c "select has_function_privilege('app_server', 'api.set_display_name(text)', 'execute')||'|'||has_function_privilege('anon', 'api.set_display_name(text)', 'execute')||'|'||has_function_privilege('authenticated', 'api.set_display_name(text)', 'execute')||'|'||has_function_privilege('service_role', 'api.set_display_name(text)', 'execute')")" '^true|false|false|false$'
expect "(g) neither anon nor authenticated may insert or update app.profiles" "$(sql -c "select has_table_privilege('anon', 'app.profiles', 'insert')||'|'||has_table_privilege('anon', 'app.profiles', 'update')||'|'||has_table_privilege('authenticated', 'app.profiles', 'insert')||'|'||has_table_privilege('authenticated', 'app.profiles', 'update')")" '^false|false|false|false$'
expect "SECURITY DEFINER with an empty search_path" "$(sql -c "select prosecdef||'|'||array_to_string(proconfig, ',') from pg_proc where oid = 'api.set_display_name(text)'::regprocedure")" '^true|search_path=""$'
expect "app.profiles keeps its two policies" "$(sql -c "select string_agg(policyname||':'||cmd||':'||array_to_string(roles, ','), ';' order by policyname) from pg_policies where schemaname = 'app' and tablename = 'profiles'")" '^maintenance_profiles:SELECT:app_maintenance;profiles_comember_read:SELECT:authenticated$'
PROFILE_GRANTS="$(sql -c "select string_agg(grantee||':'||privilege_type, ',' order by grantee, privilege_type) from information_schema.table_privileges where table_schema = 'app' and table_name = 'profiles' and grantee <> 'postgres'")"
expect "app.profiles grants: SELECT to app_maintenance and authenticated, nothing else" "$PROFILE_GRANTS" '^app_maintenance:SELECT,authenticated:SELECT$'

section "20a mutant B1: the bidirectional class dropped, installed and rolled back"
MUTB1="$(sql -c "select pg_get_functiondef('api.set_display_name(text)'::regprocedure)" \
  | E3_FROM='or ascii(ch) in (1564, 8206, 8207)' E3_TO='' E3 mutate \
  | E3_FROM='or ascii(ch) between 8234 and 8238 or ascii(ch) between 8294 and 8297' E3_TO='' E3 mutate 2>/dev/null)" || MUTB1=""
expect "both bidirectional clauses are in the live definition (mutant B1's anchors exist)" "${MUTB1:+found}" '^found$'
AS_B="select set_config('request.jwt.claims', '{\"role\":\"app_server\",\"sub\":\"$U_B\"}', true);"
CALL_B="select * from api.set_display_name('Ada' || chr(8238) || 'x');"
READ_B="select 'ROW|'||encode(convert_to(display_name, 'UTF8'), 'hex') from app.profiles where user_id = '$U_B';"
if [ -n "$MUTB1" ]; then
  r="$(in_rollback "$MUTB1;" "$AS_B" "$CALL_B" "$READ_B")"
  expect "mutant B1: a name with U+202E is stored, which 20a 'S13d U+202E: 22023 E_BODY_INVALID' refuses" "$r" "ROW|$(hex_of "'Ada' + cp(0x202e) + 'x'")\$"
fi
r="$(in_rollback "$AS_B" "$CALL_B" "$READ_B")"; expect "real: the same call is E_BODY_INVALID" "$r" 'E_BODY_INVALID'

section "20b the hook, called directly by the owner: five failures, then refused whatever valid says"
hook() { # user factor valid-json
  sql_try -c "select app.hook_mfa_verification_attempt('{\"factor_id\":\"$2\",\"factor_type\":\"totp\",\"user_id\":\"$1\",\"valid\":$3}'::jsonb)" | tee -a "$ANSWERS"; }
wrow() { sql -c "select coalesce((select failures||'|'||(window_started_at > now() - interval '1 minute') from app.mfa_attempt_windows where user_id = '$1'), 'none')"; }
CONTINUE='^{"decision": "continue"}$'
REFUSED='^{"error": {"message": "Too many attempts. Try again after [0-9-]*T[0-9:]*Z\.", "http_code": 429}}$'
UA="$(uuid)"; FA="$(uuid)"
for i in 1 2 3 4 5; do expect "account A, invalid attempt $i: continue" "$(hook "$UA" "$FA" false)" "$CONTINUE"; done
expect "account A holds five failures in a window that started now" "$(wrow "$UA")" '^5|true$'
r="$(hook "$UA" "$FA" false)"; expect "an invalid sixth: the error shape, 429" "$r" "$REFUSED"
ENDS="$(sql -c "select to_char((window_started_at + interval '15 minutes') at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') from app.mfa_attempt_windows where user_id = '$UA'")"
expect "and the time it names is the window's end, fifteen minutes after the first failure" "$r" "after $ENDS\\."
expect "a valid sixth: refused all the same" "$(hook "$UA" "$FA" true)" "$REFUSED"
expect "the refusals changed neither the count nor the window" "$(wrow "$UA")" '^5|true$'

section "20b a valid fifth resets; two accounts are independent; two factors of one account share"
UB="$(uuid)"; FB="$(uuid)"
for i in 1 2 3 4; do hook "$UB" "$FB" false >/dev/null; done
expect "account B after four failures" "$(wrow "$UB")" '^4|true$'
expect "a valid fifth: continue" "$(hook "$UB" "$FB" true)" "$CONTINUE"
expect "and the budget is whole again" "$(wrow "$UB")" '^0|true$'
expect "the next failure counts from one" "$(hook "$UB" "$FB" false)|$(wrow "$UB")" '^{"decision": "continue"}|1|true$'
UC="$(uuid)"
expect "account C, fresh, while A is exhausted: continue" "$(hook "$UC" "$(uuid)" false)" "$CONTINUE"
expect "and A is still refused" "$(hook "$UA" "$FA" false)" "$REFUSED"
UD="$(uuid)"; F1="$(uuid)"; F2="$(uuid)"
for i in 1 2 3; do hook "$UD" "$F1" false >/dev/null; done
for i in 1 2; do hook "$UD" "$F2" false >/dev/null; done
expect "account D: three failures on one factor and two on another make five" "$(wrow "$UD")" '^5|true$'
expect "a sixth on the first factor: refused" "$(hook "$UD" "$F1" false)" "$REFUSED"
expect "a sixth on the second factor, valid: refused" "$(hook "$UD" "$F2" true)" "$REFUSED"
expect "a third factor of the same account: refused" "$(hook "$UD" "$(uuid)" false)" "$REFUSED"

section "20b the window: refused one second before it ends, re-admitted after the owner moves it into the past"
sql -c "update app.mfa_attempt_windows set window_started_at = now() - interval '14 minutes 59 seconds' where user_id = '$UA'" >/dev/null
expect "one second inside the window: refused" "$(hook "$UA" "$FA" false)" "$REFUSED"
sql -c "update app.mfa_attempt_windows set window_started_at = now() - interval '15 minutes 1 second' where user_id = '$UA'" >/dev/null
expect "one second past it: an invalid attempt continues" "$(hook "$UA" "$FA" false)" "$CONTINUE"
expect "and starts a new window at one failure" "$(wrow "$UA")" '^1|true$'
sql -c "update app.mfa_attempt_windows set window_started_at = now() - interval '16 minutes' where user_id = '$UD'" >/dev/null
expect "account D, window passed: a valid attempt continues" "$(hook "$UD" "$F1" true)" "$CONTINUE"
expect "and resets it" "$(wrow "$UD")" '^0|false$'

section "20b ten attempts at once through ten connections against a fresh account (S11c's shape, at the function)"
UG="$(uuid)"; FG="$(uuid)"
for i in 1 2 3 4 5 6 7 8 9 10; do
  sql_try -c "select app.hook_mfa_verification_attempt('{\"factor_id\":\"$FG\",\"factor_type\":\"totp\",\"user_id\":\"$UG\",\"valid\":false}'::jsonb)" > "$E2_TMP/g$i" &
done
wait
cat "$E2_TMP"/g* >> "$ANSWERS"
expect "exactly five continued" "$(cat "$E2_TMP"/g* | grep -c '"decision": "continue"')" '^5$'
expect "exactly five were refused with the error shape" "$(cat "$E2_TMP"/g* | grep -c '"http_code": 429')" '^5$'
expect "and the account holds five failures" "$(wrow "$UG")" '^5|true$'

section "20b what the hook does with an event it does not recognise, and what it never answers"
r="$(sql_try -c "select app.hook_mfa_verification_attempt('{\"factor_id\":\"$(uuid)\",\"user_id\":\"not-a-uuid\",\"valid\":true}'::jsonb)")"
expect "a user_id that is not a uuid raises, which GoTrue turns into a failed verification (part 5)" "$r" 'ERROR:.*invalid input syntax for type uuid'
UF="$(uuid)"
r="$(sql_try -c "select app.hook_mfa_verification_attempt('{\"factor_id\":\"$(uuid)\",\"user_id\":\"$UF\"}'::jsonb)")"
expect "an event without valid continues and counts as a failure" "$r|$(wrow "$UF")" '^{"decision": "continue"}|1|true$'
expect "valid as the string true counts as a failure" "$(hook "$UF" "$(uuid)" '"true"')|$(wrow "$UF")" '^{"decision": "continue"}|2|true$'
expect "no answer in this probe was a reject decision" "$(grep -c -i 'reject' "$ANSWERS")" '^0$'

section "20b grants and policies: only supabase_auth_admin executes the hook; nobody but the owner reads its table (S11h, database half)"
HOOK="app.hook_mfa_verification_attempt(jsonb)"
expect "execute: supabase_auth_admin yes; anon, authenticated, app_server, service_role no" "$(sql -c "select has_function_privilege('supabase_auth_admin', '$HOOK', 'execute')||'|'||has_function_privilege('anon', '$HOOK', 'execute')||'|'||has_function_privilege('authenticated', '$HOOK', 'execute')||'|'||has_function_privilege('app_server', '$HOOK', 'execute')||'|'||has_function_privilege('service_role', '$HOOK', 'execute')")" '^true|false|false|false|false$'
expect "SECURITY DEFINER with an empty search_path" "$(sql -c "select prosecdef||'|'||array_to_string(proconfig, ',') from pg_proc where oid = '$HOOK'::regprocedure")" '^true|search_path=""$'
expect "app.mfa_attempt_windows: RLS enabled, no policy" "$(sql -c "select relrowsecurity||'|'||(select count(*) from pg_policies where schemaname = 'app' and tablename = 'mfa_attempt_windows') from pg_class where oid = 'app.mfa_attempt_windows'::regclass")" '^true|0$'
expect "no grant on it to anyone but the owner" "$(sql -c "select count(*) from information_schema.table_privileges where table_schema = 'app' and table_name = 'mfa_attempt_windows' and grantee <> 'postgres'")" '^0$'
expect "and no role the application or GoTrue uses may read or write it directly" "$(sql -c "select bool_or(has_table_privilege(r, 'app.mfa_attempt_windows', p)) from unnest(array['anon', 'authenticated', 'app_server', 'service_role', 'supabase_auth_admin']) r, unnest(array['select', 'insert', 'update', 'delete']) p")" '^f$'

section "20b mutant B2: the decision reads valid before the budget, installed and rolled back"
MUTB2="$(mutant "$HOOK" 'if failed >= budget then' "if failed >= budget and (event->'valid') is distinct from 'true'::jsonb then" 2>/dev/null)" || MUTB2=""
expect "the budget test is in the live definition (mutant B2's anchor exists)" "${MUTB2:+found}" '^found$'
UM="$(uuid)"
EXHAUST="insert into app.mfa_attempt_windows (user_id, window_started_at, failures) values ('$UM', now(), 5);"
# Both sides cast to text: an untyped literal beside jsonb would be read as JSON (the first run's probe defect).
VALID_SIXTH="select 'ANSWER|'::text || app.hook_mfa_verification_attempt('{\"factor_id\":\"$(uuid)\",\"factor_type\":\"totp\",\"user_id\":\"$UM\",\"valid\":true}'::jsonb)::text;"
if [ -n "$MUTB2" ]; then
  r="$(in_rollback "$MUTB2;" "$EXHAUST" "$VALID_SIXTH")"
  expect "mutant B2: a valid sixth continues, which 20b 'a valid sixth: refused all the same' refuses" "$r" 'ANSWER|{"decision": "continue"}'
fi
r="$(in_rollback "$EXHAUST" "$VALID_SIXTH")"; expect "real: the same valid sixth is refused" "$r" 'ANSWER|{"error": {"message": "Too many attempts'
expect "nothing of either rolled-back run remains" "$(wrow "$UM")" '^none$'

[ "$FAILED" = 0 ] && echo "20 PASS" || { echo "20 FAIL"; exit 1; }
