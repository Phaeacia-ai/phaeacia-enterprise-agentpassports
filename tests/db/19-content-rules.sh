#!/usr/bin/env bash
# Probe 19: migration 004 Part A, the three E3 debts it pays (evidence/e1-lead.md, "E3a accepted at 5535cef").
#   19a E3A-R-D1  a declared offline name is trimmed with the service's class, then 1 to 120, at the routine
#   19b           that class against the service's own submissionOf, one name per code point
#   19c E3A-D2    a contributor that is not an object, and every other type test 004 put in order, is E_BODY_INVALID
#   19d E3A-D1    the gate registry refuses an owner's UPDATE, DELETE and TRUNCATE outside a migration
# Submits go through PostgREST with bearers and bodies built by lib/db/server.mjs (tests/db/e3-lib.sh), each refusal on
# its own fresh draft so no refusal hides behind another. Fail-before runs install 003's definitions, or a mutant of
# 004's, in an owner transaction that is always rolled back. Run: bash tests/db/19-content-rules.sh (after
# tests/db/00-seed.sh).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
RUN="$(run_id)"; PW19='Synthetic-Pass-1234'

section "19 setup: one company, an author and a colleague, one agent"
U_A="$(create_user "e3-19-$RUN-admin@example.invalid" "$PW19")"; G="$(company "e3-19-$RUN" "$U_A")"
U_M="$(create_user "e3-19-$RUN-author@example.invalid" "$PW19")"; M_MS="$(member "$G" "$U_M" '{member}')"
U_C="$(create_user "e3-19-$RUN-colleague@example.invalid" "$PW19")"; C_MS="$(member "$G" "$U_C" '{member}')"
REV=1; r="$(draft_by_name "$U_M" "$G" "rules-$RUN" "$REV")"; AG="$(field "$r" agent_id)"
expect "setup" "$G|$M_MS|$C_MS|$AG" '^[0-9a-f-]\{36\}|[0-9a-f-]\{36\}|[0-9a-f-]\{36\}|[0-9a-f-]\{36\}$'

# The submission text, built in Node so no control or format character passes through a shell literal and every JSON
# escape is JSON.stringify's. $1 is a JavaScript expression over cp (String.fromCodePoint) for declared_contributors;
# with $2 = whole it is the whole submission instead.
submission() { node -e '
  const cp = (...p) => String.fromCodePoint(...p);
  const value = eval(`(${process.argv[1]})`);
  const base = { confidence: "high", permitted_data: "synthetic records only", source_platform: "synthetic probe" };
  process.stdout.write(JSON.stringify(process.argv[2] === "whole" ? value : { ...base, declared_contributors: value }));' "$@"; }
named() { submission "[{ display_name: $1 }]"; }
# The three required fields and a dependencies value given as JSON text: a literal with braces and commas inside a
# nested command substitution is brace-expanded by this shell, which split the first run's two cases into four
# fragments that never parsed (the guard in refused() now fails such a case instead of passing it).
with_dependencies() { node -e 'process.stdout.write(JSON.stringify({ confidence: "high", permitted_data: "x", source_platform: "x", dependencies: JSON.parse(process.argv[1]) }))' "$1"; }
# A refusal proves nothing if the text was never a submission: every case first shows its text is the JSON it names.
is_json() { printf '%s' "$1" | node -e 'try { JSON.parse(require("node:fs").readFileSync(0, "utf8")); process.stdout.write("json"); } catch { process.stdout.write("not json"); }'; }
hex_of() { node -e 'const cp = (...p) => String.fromCodePoint(...p); process.stdout.write(Buffer.from(eval(`(${process.argv[1]})`), "utf8").toString("hex"))' "$1"; }
# Called as D="$(fresh)", a subshell: the caller advances REV first, so the submit binds the draft's own bytes.
fresh() { field "$(draft_by_id "$U_M" "$G" "$AG" "$REV")" candidate_id; }
snap() { sql -c "select v.state||'|'||v.version||'|'||(select count(*) from app.candidate_contributors k where k.candidate_id = v.id)||'|'||(select count(*) from app.audit_events)||'|'||(select count(*) from app.idempotency_keys where membership_id = '$M_MS') from app.candidate_versions v where v.id = '$1'"; }
offline_sql() { printf "(select coalesce(string_agg(encode(convert_to(display_name, 'UTF8'), 'hex'), ',' order by display_name), '-') from app.candidate_contributors where candidate_id = '%s' and kind = 'declared_offline')" "$1"; }
offline() { sql -c "select $(offline_sql "$1")"; }
refused() { # label submission-text
  REV=$((REV + 1)); local d b r
  expect "$1: the submission text is JSON" "$(is_json "$2")" '^json$'
  d="$(fresh)"; b="$(snap "$d")"
  expect "fresh draft for $1" "$b" '^draft|1|1|'
  r="$(SUBMISSION="$2" submit "$U_M" "$d" 1 "$REV")"
  expect "$1: E_BODY_INVALID" "$r" 'E_BODY_INVALID'
  expect "$1: nothing written (state, version, contributors, audit rows, claim rows)" "$(snap "$d")" "^$b\$"
}
stored() { # label submission-text expected-utf8-hex
  REV=$((REV + 1)); local d r
  expect "$1: the submission text is JSON" "$(is_json "$2")" '^json$'
  d="$(fresh)"
  r="$(SUBMISSION="$2" submit "$U_M" "$d" 1 "$REV")"
  expect "$1: submitted" "$r" '"state": *"submitted"'
  expect "$1: the declared_offline row holds exactly that UTF-8" "$(offline "$d")" "^$3\$"
}
# 003's definition of one routine, from the accepted file, for a fail-before installed inside a rolled-back transaction.
def003() { sed -n '/^create or replace function '"$1"'(/,/^end \$\$;/p' "$ROOT/supabase/migrations/003_content.sql"; }

section "19a E3A-R-D1: the routine trims a declared offline name with the service's class, then 1 to 120, and stores the trimmed name"
N120="'n'.repeat(120)"
stored "two spaces each side of 120 characters: accepted, stored as the 120" "$(named "cp(32, 32) + $N120 + cp(32, 32)")" "$(hex_of "$N120")"
refused "121 characters, none of them a space" "$(named "'n'.repeat(121)")"
refused "a tab alone" "$(named "cp(9)")"
refused "U+00A0 alone" "$(named "cp(0xa0)")"
refused "U+FEFF alone" "$(named "cp(0xfeff)")"
refused "U+2028 alone" "$(named "cp(0x2028)")"
refused "three spaces" "$(named "'   '")"
stored "an inner double space: kept as sent" "$(named "'Ada  Lovelace'")" "$(hex_of "'Ada  Lovelace'")"
stored "U+3000 and a tab before, U+2029 and U+FEFF after: the name alone" "$(named "cp(0x3000, 9) + 'Ada' + cp(0x2029, 0xfeff)")" "$(hex_of "'Ada'")"
stored "120 astral code points inside U+00A0: stored as the 120" "$(named "cp(0xa0) + cp(0x1f600).repeat(120) + cp(0xa0)")" "$(hex_of "cp(0x1f600).repeat(120)")"

section "19a fail-before: 003's app.submission_fields and api.submit_candidate, installed and rolled back, freeze what 004 refuses"
OLD003="$(def003 app.submission_fields);
$(def003 api.submit_candidate);"
# Counted into a plain variable first: bash 3.2 mangles the backslashes of a pattern nested in "$(...)" inside quotes.
ENDS003=$(printf '%s\n' "$OLD003" | grep -c -F 'end $$;')
expect "003's two definitions were read from the accepted file" "$ENDS003" '^2$'
REV=$((REV + 1)); DS="$(fresh)"; DS_REV="$REV"
CALL="$(SUBMISSION="$(named "'   '")" E3MODE=sql submit "$U_M" "$DS" 1 "$DS_REV")"
r="$(in_rollback "$OLD003" "$CALL" "select 'OLD|'||$(offline_sql "$DS");")"
expect "fail-before (003): three spaces are frozen as a declared_offline name" "$r" 'OLD|202020$'
CALL="$(SUBMISSION="$(named "cp(32, 32) + $N120 + cp(32, 32)")" E3MODE=sql submit "$U_M" "$DS" 1 "$DS_REV")"
r="$(in_rollback "$OLD003" "$CALL")"; expect "fail-before (003): 120 characters inside two spaces each side are refused" "$r" 'E_BODY_INVALID'
CALL="$(SUBMISSION="$(named "'   '")" E3MODE=sql submit "$U_M" "$DS" 1 "$DS_REV")"
r="$(in_rollback "$CALL")"; expect "real (004): the same three spaces are E_BODY_INVALID" "$r" 'E_BODY_INVALID'
MUT="$(mutant 'app.declared_name_trim_characters()' ' || chr(65279)' '' 2>/dev/null)" || MUT=""
expect "U+FEFF is in the live class (mutant A1's anchor exists)" "${MUT:+found}" '^found$'
if [ -n "$MUT" ]; then
  CALL="$(SUBMISSION="$(named "cp(0xfeff)")" E3MODE=sql submit "$U_M" "$DS" 1 "$DS_REV")"
  r="$(in_rollback "$MUT;" "$CALL" "select 'MUTANT|'||$(offline_sql "$DS");")"
  expect "mutant A1 (the class without U+FEFF): a U+FEFF-only name is frozen, which 19a 'U+FEFF alone: E_BODY_INVALID' refuses" "$r" 'MUTANT|efbbbf$'
fi

section "19b the routine's class against the service's own submissionOf, one name of one code point each"
# The 25 members of the class, then near misses Unicode does not count as white space: U+001F, U+0085, U+180E, U+200B,
# U+200C, U+2060, U+3164, U+FFA0, and x.
POINTS="9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279,31,133,6158,8203,8204,8288,12644,65440,120"
SERVICE="$(cd "$ROOT" && POINTS="$POINTS" node --input-type=module -e '
  process.env.SUPABASE_URL ??= "http://127.0.0.1:1";
  process.env.SUPABASE_ANON_KEY ??= "unit";
  const { submissionOf } = await import("./lib/services/candidates.mjs");
  const verdict = (c) => {
    try {
      submissionOf({ sourcePlatform: "x", confidence: "high", permittedData: "x", declaredContributors: [{ displayName: String.fromCodePoint(c) }] });
      return "t";
    } catch (e) {
      if (e.code !== "E_BODY_INVALID") throw e;
      return "f";
    }
  };
  process.stdout.write(process.env.POINTS.split(",").map((c) => `${c}:${verdict(Number(c))}`).join(","));')"
ROUTINE="$(sql_try -c "begin;
  create function pg_temp.accepts(t text) returns boolean language plpgsql as \$f\$
  begin
    perform app.submission_fields(t);
    return true;
  exception when sqlstate '22023' then
    if sqlerrm <> 'E_BODY_INVALID' then raise; end if;
    return false;
  end \$f\$;
  select string_agg(u.c || ':' || case when pg_temp.accepts(jsonb_build_object('source_platform', 'x', 'confidence', 'high',
           'permitted_data', 'x', 'declared_contributors', jsonb_build_array(jsonb_build_object('display_name', chr(u.c))))::text)
         then 't' else 'f' end, ',' order by u.o)
    from unnest('{$POINTS}'::int[]) with ordinality as u(c, o);
  rollback;" | grep ':')"
expect "the service and the routine give the same verdict on every one of the 34 names" "$ROUTINE" "^$SERVICE\$"
expect "and exactly the 25 class members are refused" "$(printf '%s' "$ROUTINE" | tr ',' '\n' | grep -c ':f$')" '^25$'

section "19c E3A-D2: a contributor that is not an object, and each other type test 004 put in order, is E_BODY_INVALID with nothing written"
for decl in '[1]' '["x"]' '[null]' '[[]]' '[true]'; do refused "declared_contributors $decl" "$(submission "$decl")"; done
for v in '1' '"x"' '{}' 'null'; do refused "declared_contributors $v, not a list" "$(submission "$v")"; done
for v in '{}' '1' '"x"'; do refused "dependencies $v, not a list" "$(with_dependencies "$v")"; done
for v in '[]' '1' '"x"' 'null'; do refused "the submission $v, not an object" "$(submission "$v" whole)"; done
refused "F2's shape {display_name: 123}" "$(submission "[{ display_name: 123 }]")"
refused "F2's shape {typo: 'x'}" "$(submission "[{ typo: 'x' }]")"
stored "control: a valid name alone" "$(named "'SYNTHETIC Offline Colleague'")" "$(hex_of "'SYNTHETIC Offline Colleague'")"
REV=$((REV + 1)); D="$(fresh)"
r="$(SUBMISSION="$(submission "[{ membership_id: '$C_MS' }]")" submit "$U_M" "$D" 1 "$REV")"
expect "control: a valid member alone is accepted" "$r" '"state": *"submitted"'
expect "and recorded as one declared_member" "$(sql -c "select string_agg(kind||'|'||coalesce(membership_id::text, '-'), ',') from app.candidate_contributors where candidate_id = '$D' and kind like 'declared%'")" "^declared_member|$C_MS\$"
# Mutant A3 reverts the CASE to 003's OR chain. PostgreSQL promises no operand order, but its executor evaluates one OR
# expression's operands left to right, so under this server the mutant answers as the real function does: a behaviour
# probe cannot kill it, and tests/e3/unit/migration-text.test.mjs does, on the text. Recorded here, not asserted.
MUTOR="$(sql -c "select pg_get_functiondef('app.submission_fields(text)'::regprocedure)" | node -e '
  const def = require("node:fs").readFileSync(0, "utf8");
  const re = /case\s*\n(?:\s*--[^\n]*\n)*\s*when jsonb_typeof\(e\) <> .object. then true\s*\n\s*when (\(select count\(\*\) from jsonb_object_keys\(e\)\) <> 1) then true\s*\n(?:\s*--[^\n]*\n)*\s*else ([\s\S]*?) is not true\s*\n\s*end/;
  if (!re.test(def)) { process.stderr.write("mutant A3: anchor not found\n"); process.exit(2); }
  process.stdout.write(def.replace(re, (_, keys, shapes) => `jsonb_typeof(e) <> \x27object\x27 or ${keys} or ${shapes} is not true`));' 2>/dev/null)" || MUTOR=""
expect "the CASE is in the live definition (mutant A3's anchor exists)" "${MUTOR:+found}" '^found$'
if [ -n "$MUTOR" ]; then
  CALL="$(SUBMISSION="$(submission '[1]')" E3MODE=sql submit "$U_M" "$DS" 1 "$DS_REV")"
  r="$(in_rollback "$MUTOR;" "$CALL")"
  echo "observation, mutant A3 (the CASE reverted to OR): declared_contributors [1] answers $(printf '%s' "$r" | grep -o -m1 'E_[A-Z_]*\|ERROR: .*' | head -1)"
fi

section "19d E3A-D1: the gate registry refuses an owner's UPDATE, DELETE and TRUNCATE outside a migration"
reg() { sql -c "select (select count(*) from app.gate_identities)||'|'||(select count(*) from app.gate_identities where active)||'|'||(select count(*) from app.gate_identity_files)"; }
REG0="$(reg)"; expect "fixture: the registry holds 003's identity, active, and its files" "$REG0" '^[1-9][0-9]*|1|[1-9][0-9]*$'
for stmt in "update app.gate_identities set active = false where active" \
            "delete from app.gate_identities where active" \
            "truncate app.gate_identities cascade" \
            "update app.gate_identity_files set sha256 = sha256('x')" \
            "delete from app.gate_identity_files" \
            "truncate app.gate_identity_files"; do
  r="$(sql_try -c "begin; $stmt; rollback;")"; expect "owner: $stmt: E_REGISTRY_FROZEN" "$r" 'E_REGISTRY_FROZEN'
  expect "and the registry is unchanged after: $stmt" "$(reg)" "^$REG0\$"
done
r="$(sql_try -c "begin; truncate app.gate_identities; rollback;")"
expect "owner: truncate app.gate_identities without cascade stops at PostgreSQL's foreign key check, before any trigger" "$r" 'cannot truncate a table referenced in a foreign key constraint'
r="$(sql_try -c "begin; set local app.registry_migration = 'on'; commit; begin; update app.gate_identities set active = false where active; rollback;")"
expect "the bypass dies with its transaction: the next transaction in the same session is refused" "$r" 'E_REGISTRY_FROZEN'
r="$(sql_try -c "begin; set local app.registry_migration = 'yes'; update app.gate_identities set active = false where active; rollback;")"
expect "a value other than on is no bypass" "$r" 'E_REGISTRY_FROZEN'

section "19d with the migration-time bypass, inside a transaction rolled back: the owner's writes succeed"
r="$(sql_try -c "begin; set local app.registry_migration = 'on';
  update app.gate_identities set active = false where active;
  select 'UPDATE|'||count(*) from app.gate_identities where active;
  insert into app.gate_identities (identity_sha256, adapter_lock_sha256, validator_version, manifest_sha256, upstream_commit, active)
    values (sha256('e3-19 bypass'), sha256('l'), '0.1.0', sha256('m'), repeat('f', 40), false);
  insert into app.gate_identity_files (gate_id, path, sha256)
    select id, 'lib/probe.mjs', sha256('f') from app.gate_identities where identity_sha256 = sha256('e3-19 bypass');
  update app.gate_identity_files set sha256 = sha256('g') where path = 'lib/probe.mjs';
  delete from app.gate_identity_files where path = 'lib/probe.mjs';
  delete from app.gate_identities where identity_sha256 = sha256('e3-19 bypass');
  select 'DELETE|'||count(*) from app.gate_identities where identity_sha256 = sha256('e3-19 bypass');
  truncate app.gate_identity_files;
  select 'TRUNCATE|'||count(*) from app.gate_identity_files;
  rollback;")"
expect "UPDATE deactivates the active identity" "$r" 'UPDATE|0'
expect "UPDATE and DELETE of a file row and DELETE of an identity row succeed" "$r" 'DELETE|0'
expect "TRUNCATE of the files succeeds" "$r" 'TRUNCATE|0'
r="$(sql_try -c "begin; set local app.registry_migration = 'on'; truncate app.gate_identities cascade; rollback;")"
expect "with the bypass, TRUNCATE ... CASCADE of the identities still stops, at the candidate history's own guard" "$r" 'E_CANDIDATE_DELETE'
r="$(sql_try -c "set app.registry_migration = 'on'; begin; update app.gate_identities set active = false where active; select 'SESSION|'||count(*) from app.gate_identities where active; rollback;")"
expect "disclosed limit, observed: a session-level SET, not SET LOCAL, also bypasses for that session" "$r" 'SESSION|0'
expect "every rolled-back write left the registry as it was" "$(reg)" "^$REG0\$"

section "19d after the refusals: an active member still reads the active identity and all its files through the api views"
MJWT="$(user_jwt "e3-19-$RUN-author@example.invalid" "$PW19")"
GID="$(sql -c "select id from app.gate_identities where active")"
FILES="$(sql -c "select count(*) from app.gate_identity_files where gate_id = '$GID'")"
r="$(rest GET "/gate_identities?select=id&active=eq.true" "$MJWT")"; expect "api.gate_identities: the active identity" "$r" "^HTTP 200 \\[{\"id\":\"$GID\"}\\]"
rest GET "/gate_identity_files?select=path&gate_id=eq.$GID" "$MJWT" >/dev/null
expect "api.gate_identity_files: the same file count as the owner reads ($FILES)" "$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).length))' "$E2_TMP/body")" "^$FILES\$"

section "19d fail-before: 003 alone (the four triggers dropped, rolled back), and mutant A2 (no TRUNCATE branch)"
DROP_ROW="drop trigger gate_identities_frozen on app.gate_identities; drop trigger gate_identity_files_frozen on app.gate_identity_files;"
DROP_TRUNCATE="drop trigger gate_identities_no_truncate on app.gate_identities; drop trigger gate_identity_files_no_truncate on app.gate_identity_files;"
r="$(sql_try -c "begin; $DROP_ROW $DROP_TRUNCATE update app.gate_identities set active = false where active; truncate app.gate_identity_files; select 'BEFORE|'||(select count(*) from app.gate_identities where active)||'|'||(select count(*) from app.gate_identity_files); rollback;")"
expect "fail-before (003 alone): the owner deactivates the identity and truncates every file row" "$r" 'BEFORE|0|0$'
r="$(sql_try -c "begin; $DROP_TRUNCATE truncate app.gate_identity_files; select 'MUTANT|'||count(*) from app.gate_identity_files; rollback;")"
expect "mutant A2 (no TRUNCATE branch): the files are erased, which 19d 'owner: truncate app.gate_identity_files: E_REGISTRY_FROZEN' refuses" "$r" 'MUTANT|0$'
r="$(sql_try -c "begin; $DROP_TRUNCATE update app.gate_identities set active = false where active; rollback;")"
expect "under mutant A2 the row refusals still hold, so only the TRUNCATE probes kill it" "$r" 'E_REGISTRY_FROZEN'
expect "and the rollbacks restored the registry and its triggers" "$(reg)|$(sql -c "select count(*) from pg_trigger where tgrelid in ('app.gate_identities'::regclass, 'app.gate_identity_files'::regclass) and not tgisinternal")" "^$REG0|4\$"

[ "$FAILED" = 0 ] && echo "19 PASS" || { echo "19 FAIL"; exit 1; }
