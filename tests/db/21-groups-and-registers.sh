#!/usr/bin/env bash
# Probe 21: migration 006 part A, the lead-owned E4 prerequisites (docs/e4/design.md 1.7, 1.8, 2.3 part A, 2.4, 2.5 and
# the group routes of 3.5), through PostgREST with server tokens and as the migration owner.
#   21a api.create_group by caller class (admin at aal2, admin at aal1 and without aal, a member, another company's admin,
#       a removed member, an outsider, a bound bearer, a user's own token, anon), the name rule's corpus, a taken name,
#       an inactive company, the company lock's wait and its lock_timeout
#   21b api.add_group_member and api.remove_group_member by the same classes, unknown and foreign ids, a removed
#       membership, changed = false without an audit row on a no-op
#   21c the 50-group limit
#   21d api.remove_member clearing group rows: one group.remove_member audit row per group, between membership.remove and
#       agent.orphan; reactivation restores no group; fail-before against the body without the block
#   21e the registers: the rows 006 registered against lib/passport/installer-manifest.mjs and canonical(), their audit
#       rows, reads by class, frozen for the owner and for every role, the bypass and the hash triggers; groups never
#       deleted
#   21f the claim table admits exactly the eight bound names
#   21g the audit allowlist's E4 keys: each shape accepted and refused, part B's vocabulary keys accepted inside it
#   21h composite keys, grants, definer rights, security_invoker views, row level security, lib/db/user.mjs VIEWS
#   21i one mutant per change, each installed in an owner transaction that is always rolled back
# The condition E3 2.6 item 4 set for a change to api.remove_member (reseed, then tests/db/01 to 06 in order) is met by
# scripts/check-db.sh, which runs them before this probe. Run: bash tests/db/21-groups-and-registers.sh (after
# tests/db/00-seed.sh).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
RUN="$(run_id)"; PW21='Synthetic-Pass-1234'
DL0="$(deadlocks)"

# RPC bodies are built in Node from name=value pairs. A value that starts with = is a JavaScript expression over cp
# (String.fromCodePoint), so no control or bidirectional character passes through a shell literal; the word null is JSON
# null; anything else is a string. No shell literal holds a brace and a comma (bash 3.2 brace-expands one inside a nested
# command substitution, evidence/m004.md lesson 1), and every refusal first checks that its body names the parameters it
# means to send (lesson 2).
body() { node -e '
  const cp = (...p) => String.fromCodePoint(...p);
  const out = {};
  for (const pair of process.argv.slice(1)) {
    const i = pair.indexOf("=");
    const v = pair.slice(i + 1);
    out[pair.slice(0, i)] = v === "null" ? null : v.startsWith("=") ? eval(`(${v.slice(1)})`) : v;
  }
  process.stdout.write(JSON.stringify(out));' "$@"; }
names() { printf '%s' "$1" | node -e 'try { process.stdout.write(Object.keys(JSON.parse(require("node:fs").readFileSync(0, "utf8"))).join(",")); } catch { process.stdout.write("not json"); }'; }
hex_of() { node -e 'const cp = (...p) => String.fromCodePoint(...p); process.stdout.write(Buffer.from(eval(`(${process.argv[1]})`), "utf8").toString("hex"))' "$1"; }
sha_hex() { node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1], "utf8").digest("hex"))' "$1"; }
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
bound_claims() { node -e 'process.stdout.write(JSON.stringify({ fn: "create_envelope", args_sha256: "a".repeat(64), jti: require("node:crypto").randomUUID() }))'; }
gid() { printf '%s' "$1" | sed -n 's/.*"group_id":"\([^"]*\)".*/\1/p'; }
maxaud() { sql -c "select coalesce(max(id), 0) from app.audit_events"; }
snap() { sql -c "select (select count(*) from app.groups) || '|' || (select count(*) from app.group_members) || '|' || (select count(*) from app.audit_events)"; }
mb() { body "p_group=$1" "p_membership=$2"; }
as_claims() { printf "select set_config('request.jwt.claims', '{\"role\":\"app_server\",\"sub\":\"%s\",\"aal\":\"aal2\"}', true);" "$1"; }

section "21 setup: company G (admin A, member M, removed member R), company H (admin B), company K (admin C, members X, Y, Z), an outsider O"
U_A="$(create_user "e4-21-$RUN-a@example.invalid" "$PW21")"; G="$(company "e4-21g-$RUN" "$U_A")"; A_MS="$(membership_of "$G" "$U_A")"
U_M="$(create_user "e4-21-$RUN-m@example.invalid" "$PW21")"; M_MS="$(member "$G" "$U_M" '{member}')"
U_R="$(create_user "e4-21-$RUN-r@example.invalid" "$PW21")"; R_MS="$(member "$G" "$U_R" '{member}')"
U_B="$(create_user "e4-21-$RUN-b@example.invalid" "$PW21")"; H="$(company "e4-21h-$RUN" "$U_B")"; B_MS="$(membership_of "$H" "$U_B")"
U_C="$(create_user "e4-21-$RUN-c@example.invalid" "$PW21")"; K="$(company "e4-21k-$RUN" "$U_C")"; C_MS="$(membership_of "$K" "$U_C")"
U_X="$(create_user "e4-21-$RUN-x@example.invalid" "$PW21")"; X_MS="$(member "$K" "$U_X" '{member}')"
U_Y="$(create_user "e4-21-$RUN-y@example.invalid" "$PW21")"; Y_MS="$(member "$K" "$U_Y" '{member}')"
U_Z="$(create_user "e4-21-$RUN-z@example.invalid" "$PW21")"; Z_MS="$(member "$K" "$U_Z" '{member}')"
U_O="$(create_user "e4-21-$RUN-o@example.invalid" "$PW21")"
sql -c "update app.memberships set status = 'removed', removed_at = now() where id = '$R_MS'" >/dev/null
for v in G H K A_MS M_MS R_MS B_MS C_MS X_MS Y_MS Z_MS U_O; do eval "expect \"setup: $v is a uuid\" \"\$$v\" '^[0-9a-f-]\{36\}\$'"; done
A_JWT="$(user_jwt "e4-21-$RUN-a@example.invalid" "$PW21")"
admin2() { server_jwt "$U_A" aal2; }
cadmin() { server_jwt "$U_C" aal2; }

refuse_create() { # label bearer company name-value expected
  local b before r
  b="$(body "p_company=$3" "p_name=$4")"
  expect "$1: the body names p_company and p_name" "$(names "$b")" '^p_company,p_name$'
  before="$(snap)"; r="$(rest POST /rpc/create_group "$2" "$b")"
  expect "$1: $5" "$r" "$5"
  expect "$1: no group, member row or audit row written" "$(snap)" "^$before\$"
}
refuse_member() { # label routine bearer group membership expected
  local b before r
  b="$(mb "$4" "$5")"
  expect "$1: the body names p_group and p_membership" "$(names "$b")" '^p_group,p_membership$'
  before="$(snap)"; r="$(rest POST "/rpc/$2" "$3" "$b")"
  expect "$1: $6" "$r" "$6"
  expect "$1: nothing written" "$(snap)" "^$before\$"
}

section "21a api.create_group by caller class (design 1.7; 3.5 group routes)"
refuse_create "admin at aal1" "$(server_jwt "$U_A" aal1)" "$G" Operations '"code":"42501".*"message":"E_ADMIN_MFA_REQUIRED"'
refuse_create "admin with no aal claim" "$(server_jwt "$U_A")" "$G" Operations '"code":"42501".*"message":"E_ADMIN_MFA_REQUIRED"'
refuse_create "a member at aal2" "$(server_jwt "$U_M" aal2)" "$G" Operations '"code":"42501".*"message":"E_FORBIDDEN"'
refuse_create "another company's admin at aal2" "$(server_jwt "$U_B" aal2)" "$G" Operations '"code":"P0002".*"message":"E_NOT_FOUND"'
refuse_create "a removed member at aal2" "$(server_jwt "$U_R" aal2)" "$G" Operations '"code":"P0002".*"message":"E_NOT_FOUND"'
refuse_create "an outsider at aal2" "$(server_jwt "$U_O" aal2)" "$G" Operations '"code":"P0002".*"message":"E_NOT_FOUND"'
refuse_create "a bearer bound to an E4 routine" "$(server_jwt "$U_A" aal2 "$(bound_claims)")" "$G" Operations '"code":"42501".*"message":"E_NOT_SERVER"'
refuse_create "the admin's own GoTrue token" "$A_JWT" "$G" Operations '"code":"42501".*permission denied for function create_group'
refuse_create "the anon key" "$ANON_KEY" "$G" Operations 'HTTP 401'
refuse_create "an unknown company" "$(admin2)" "$(uuid)" Operations '"code":"P0002".*"message":"E_NOT_FOUND"'
refuse_create "a null company" "$(admin2)" null Operations '"code":"P0002".*"message":"E_NOT_FOUND"'

AUD="$(maxaud)"
r="$(rest POST /rpc/create_group "$(admin2)" "$(body "p_company=$G" "p_name=Operations")")"
expect "admin at aal2 creates the group: changed true" "$r" '^HTTP 200 \[{"group_id":"[0-9a-f-]\{36\}","changed":true}\]$'
G1="$(gid "$r")"
expect "the row: company G, the name, created by A's membership" "$(sql -c "select company_id || '|' || name || '|' || created_by_membership_id from app.groups where id = '$G1'")" "^$G|Operations|$A_MS\$"
expect "one group.create audit row: entity the group, actor A as member, details exactly group_id and A's membership_id" "$(sql -c "select count(*) || '|' || bool_and(action = 'group.create' and company_id = '$G' and actor_user_id = '$U_A' and actor_kind = 'member' and entity_type = 'group' and entity_id = '$G1' and details = jsonb_build_object('group_id', '$G1', 'membership_id', '$A_MS')) from app.audit_events where id > $AUD")" '^1|true$'
refuse_create "the same name again" "$(admin2)" "$G" Operations '"code":"P0001".*"message":"E_GROUP_NAME_TAKEN"'
refuse_create "the same name inside spaces, trimmed before the test" "$(admin2)" "$G" "  Operations  " '"code":"P0001".*"message":"E_GROUP_NAME_TAKEN"'
r="$(rest POST /rpc/create_group "$(server_jwt "$U_B" aal2)" "$(body "p_company=$H" "p_name=Operations")")"
expect "the same name in company H is H's own group" "$r" '"changed":true'
H1="$(gid "$r")"
r="$(rest POST /rpc/create_group "$(admin2)" "$(body "p_company=$G" "p_name=operations")")"
expect "a name that differs only in case is another name" "$r" '"changed":true'

section "21a the group name rule (design 1.7): migration 004's display-name rule with an 80-code-point bound, at the routine"
named() { # label name-value stored-expression
  local b r id
  b="$(body "p_company=$K" "p_name=$2")"
  expect "$1: the body names p_company and p_name" "$(names "$b")" '^p_company,p_name$'
  r="$(rest POST /rpc/create_group "$(cadmin)" "$b")"
  expect "$1: created" "$r" '"changed":true'
  id="$(gid "$r")"
  expect "$1: the row holds exactly the trimmed name" "$(sql -c "select coalesce((select encode(convert_to(name, 'UTF8'), 'hex') from app.groups where id = '$id'), 'none')")" "^$(hex_of "$3")\$"
}
named "two spaces each side, trimmed" "  Field team  " "'Field team'"
named "an inner double space, kept" "Field  team" "'Field  team'"
named "80 code points" "='x'.repeat(80)" "'x'.repeat(80)"
named "80 astral code points" "=cp(0x1F600).repeat(80)" "cp(0x1F600).repeat(80)"
named "80 characters inside one space each side" "=' ' + 'y'.repeat(80) + ' '" "'y'.repeat(80)"
named "U+00A0 inside and at both ends, kept" "=cp(0xA0) + 'No' + cp(0xA0) + 'break' + cp(0xA0)" "cp(0xA0) + 'No' + cp(0xA0) + 'break' + cp(0xA0)"
named "a right-to-left name" "=cp(0x5E6, 0x5D5, 0x5D5, 0x5EA)" "cp(0x5E6, 0x5D5, 0x5D5, 0x5EA)"
kbad() { refuse_create "$1" "$(cadmin)" "$K" "$2" '"code":"22023".*"message":"E_BODY_INVALID"'; }
kbad "empty" ""
kbad "three spaces" "   "
kbad "81 code points" "='x'.repeat(81)"
kbad "81 characters inside spaces" "=' ' + 'x'.repeat(81) + ' '"
kbad "a tab before the name, refused and not trimmed" "=cp(9) + 'Ops'"
kbad "U+0001" "='Ops' + cp(1)"
kbad "U+001F" "='Ops' + cp(0x1F)"
kbad "U+007F" "='Ops' + cp(0x7F)"
kbad "U+009F" "='Ops' + cp(0x9F)"
kbad "U+061C" "='Ops' + cp(0x61C)"
kbad "U+200E" "='Ops' + cp(0x200E)"
kbad "U+202E" "='Ops' + cp(0x202E)"
kbad "U+2066" "='Ops' + cp(0x2066)"
kbad "a null name" null
refuse_create "an outsider with an invalid name: the name is judged before standing" "$(server_jwt "$U_O" aal2)" "$K" "" '"code":"22023".*"message":"E_BODY_INVALID"'

sql -c "update app.companies set status = 'suspended' where id = '$K'" >/dev/null
refuse_create "company K suspended: its admin at aal2" "$(cadmin)" "$K" "Suspended team" '"code":"P0001".*"message":"E_COMPANY_INACTIVE"'
sql -c "update app.companies set status = 'active' where id = '$K'" >/dev/null

section "21a the company lock: a create waits for it, and a hold longer than app_server's lock_timeout is refused with nothing written"
hold_company "$K" 2; sleep 0.3
START="$(now_ms)"; r="$(rest POST /rpc/create_group "$(cadmin)" "$(body "p_company=$K" "p_name=Waited")")"; ELAPSED="$(( $(now_ms) - START ))"; wait
expect "the create succeeds" "$r" '"changed":true'
expect "and it waited behind the held company lock (${ELAPSED} ms)" "$([ "$ELAPSED" -ge 1200 ] && echo waited)" '^waited$'
before="$(snap)"; hold_company "$K" 7; sleep 0.3
START="$(now_ms)"; r="$(rest POST /rpc/create_group "$(cadmin)" "$(body "p_company=$K" "p_name=Too late")")"; ELAPSED="$(( $(now_ms) - START ))"; wait
expect "a 7 s hold: 55P03 after the 5 s lock_timeout, which lib/errors.mjs answers E_BUSY (${ELAPSED} ms)" "$r" '"code":"55P03"'
expect "nothing written" "$(snap)" "^$before\$"

section "21b api.add_group_member and api.remove_group_member by caller class, unknown and foreign ids"
for fn in add_group_member remove_group_member; do
  refuse_member "$fn: admin at aal1" $fn "$(server_jwt "$U_A" aal1)" "$G1" "$M_MS" '"code":"42501".*"message":"E_ADMIN_MFA_REQUIRED"'
  refuse_member "$fn: a member at aal2" $fn "$(server_jwt "$U_M" aal2)" "$G1" "$M_MS" '"code":"42501".*"message":"E_FORBIDDEN"'
  refuse_member "$fn: another company's admin" $fn "$(server_jwt "$U_B" aal2)" "$G1" "$M_MS" '"code":"P0002".*"message":"E_NOT_FOUND"'
  refuse_member "$fn: a removed member" $fn "$(server_jwt "$U_R" aal2)" "$G1" "$M_MS" '"code":"P0002".*"message":"E_NOT_FOUND"'
  refuse_member "$fn: an outsider" $fn "$(server_jwt "$U_O" aal2)" "$G1" "$M_MS" '"code":"P0002".*"message":"E_NOT_FOUND"'
  refuse_member "$fn: a bearer bound to an E4 routine" $fn "$(server_jwt "$U_A" aal2 "$(bound_claims)")" "$G1" "$M_MS" '"code":"42501".*"message":"E_NOT_SERVER"'
  refuse_member "$fn: the admin's own GoTrue token" $fn "$A_JWT" "$G1" "$M_MS" "\"code\":\"42501\".*permission denied for function $fn"
  refuse_member "$fn: the anon key" $fn "$ANON_KEY" "$G1" "$M_MS" 'HTTP 401'
  refuse_member "$fn: an unknown group" $fn "$(admin2)" "$(uuid)" "$M_MS" '"code":"P0002".*"message":"E_NOT_FOUND"'
  refuse_member "$fn: company H's group" $fn "$(admin2)" "$H1" "$M_MS" '"code":"P0002".*"message":"E_NOT_FOUND"'
  refuse_member "$fn: a membership of company H" $fn "$(admin2)" "$G1" "$B_MS" '"code":"P0002".*"message":"E_NOT_FOUND"'
  refuse_member "$fn: an unknown membership" $fn "$(admin2)" "$G1" "$(uuid)" '"code":"P0002".*"message":"E_NOT_FOUND"'
  refuse_member "$fn: a null membership" $fn "$(admin2)" "$G1" null '"code":"P0002".*"message":"E_NOT_FOUND"'
done
refuse_member "add_group_member: a removed membership of company G" add_group_member "$(admin2)" "$G1" "$R_MS" '"code":"P0001".*"message":"E_MEMBERSHIP_REMOVED"'

section "21b adding and removing, each once with its audit row, and each no-op without one"
AUD="$(maxaud)"
r="$(rest POST /rpc/add_group_member "$(admin2)" "$(mb "$G1" "$M_MS")")"
expect "admin at aal2 adds M: changed true" "$r" "^HTTP 200 \[{\"group_id\":\"$G1\",\"membership_id\":\"$M_MS\",\"changed\":true}\]\$"
expect "the row: company G, added by A" "$(sql -c "select company_id || '|' || added_by_membership_id from app.group_members where group_id = '$G1' and membership_id = '$M_MS'")" "^$G|$A_MS\$"
expect "one group.add_member row, details exactly group_id, membership_id and previous_admin_membership_id" "$(sql -c "select count(*) || '|' || bool_and(action = 'group.add_member' and company_id = '$G' and actor_kind = 'member' and entity_type = 'group' and entity_id = '$G1' and details = jsonb_build_object('group_id', '$G1', 'membership_id', '$M_MS', 'previous_admin_membership_id', '$A_MS')) from app.audit_events where id > $AUD")" '^1|true$'
before="$(snap)"; r="$(rest POST /rpc/add_group_member "$(admin2)" "$(mb "$G1" "$M_MS")")"
expect "adding M again: changed false" "$r" '"changed":false'
expect "adding M again: no second row and no audit row" "$(snap)" "^$before\$"
AUD="$(maxaud)"
r="$(rest POST /rpc/remove_group_member "$(admin2)" "$(mb "$G1" "$M_MS")")"
expect "admin at aal2 removes M: changed true" "$r" "^HTTP 200 \[{\"group_id\":\"$G1\",\"membership_id\":\"$M_MS\",\"changed\":true}\]\$"
expect "the row is gone" "$(sql -c "select count(*) from app.group_members where group_id = '$G1' and membership_id = '$M_MS'")" '^0$'
expect "one group.remove_member row, details exactly group_id, membership_id and previous_admin_membership_id" "$(sql -c "select count(*) || '|' || bool_and(action = 'group.remove_member' and company_id = '$G' and entity_id = '$G1' and details = jsonb_build_object('group_id', '$G1', 'membership_id', '$M_MS', 'previous_admin_membership_id', '$A_MS')) from app.audit_events where id > $AUD")" '^1|true$'
before="$(snap)"; r="$(rest POST /rpc/remove_group_member "$(admin2)" "$(mb "$G1" "$M_MS")")"
expect "removing M again: changed false" "$r" '"changed":false'
expect "removing M again: no audit row" "$(snap)" "^$before\$"
sql -c "insert into app.group_members (group_id, company_id, membership_id, added_by_membership_id) values ('$G1', '$G', '$R_MS', '$A_MS')" >/dev/null
r="$(rest POST /rpc/remove_group_member "$(admin2)" "$(mb "$G1" "$R_MS")")"
expect "owner-side fixture, a row for the removed membership R: removing it is allowed (only adding refuses R)" "$r" '"changed":true'
r="$(rest POST /rpc/add_group_member "$(admin2)" "$(mb "$G1" "$M_MS")")"
expect "M added back for the reads below" "$r" '"changed":true'

section "21c at most 50 groups in one company (app.limit_groups_per_company)"
N="$(sql -c "select count(*) from app.groups where company_id = '$G'")"
# Fixture, owner-side for speed and labelled as such: company G is filled to 49 groups, which writes no audit row.
sql -c "insert into app.groups (company_id, name, created_by_membership_id) select '$G', 'fixture ' || n, '$A_MS' from generate_series(1, 49 - $N) n" >/dev/null
expect "fixture: company G holds 49 groups" "$(sql -c "select count(*) from app.groups where company_id = '$G'")" '^49$'
r="$(rest POST /rpc/create_group "$(admin2)" "$(body "p_company=$G" "p_name=Fiftieth")")"
expect "the 50th, through the routine: changed true" "$r" '"changed":true'
refuse_create "the 51st" "$(admin2)" "$G" "Fifty-first" '"code":"P0001".*"message":"E_GROUP_LIMIT"'
refuse_create "at the limit, a taken name is still E_GROUP_NAME_TAKEN (the name test runs before the count)" "$(admin2)" "$G" Operations '"message":"E_GROUP_NAME_TAKEN"'
expect "company G holds exactly 50" "$(sql -c "select count(*) from app.groups where company_id = '$G'")" '^50$'
r="$(rest POST /rpc/create_group "$(server_jwt "$U_B" aal2)" "$(body "p_company=$H" "p_name=Second")")"
expect "company H is not held to G's count" "$r" '"changed":true'

section "21d api.remove_member clears the removed membership's group rows (design 1.7, 2.3 A5, 2.5)"
KA="$(gid "$(rest POST /rpc/create_group "$(cadmin)" "$(body "p_company=$K" "p_name=Removal A")")")"
KB="$(gid "$(rest POST /rpc/create_group "$(cadmin)" "$(body "p_company=$K" "p_name=Removal B")")")"
for g in "$KA" "$KB"; do for ms in "$X_MS" "$Y_MS"; do
  r="$(rest POST /rpc/add_group_member "$(cadmin)" "$(mb "$g" "$ms")")"; expect "fixture through the routine: $ms joins $g" "$r" '"changed":true'
done; done
r="$(draft_by_name "$U_X" "$K" "e4-21-agent-$RUN" 1)"; XAG="$(field "$r" agent_id)"
expect "X owns an active agent (an E3 draft)" "$XAG" '^[0-9a-f-]\{36\}$'
FIRST="$(sql -c "select least('$KA'::uuid, '$KB'::uuid)")"; SECOND="$(sql -c "select greatest('$KA'::uuid, '$KB'::uuid)")"

MUT="$(mutant 'api.remove_member(uuid)' "    delete from app.group_members gm
     where gm.company_id = target.company_id and gm.membership_id = target.id
    returning gm.group_id)" "    select gm.group_id from app.group_members gm where false)")"
r="$(in_rollback "$MUT;" "$(as_claims "$U_C")" "select * from api.remove_member('$X_MS');" "select 'MUTANT|' || (select count(*) from app.group_members where membership_id = '$X_MS') || '|' || (select count(*) from app.audit_events where action = 'group.remove_member' and details->>'membership_id' = '$X_MS');")"
expect "fail-before (mutant A5): the body without the block removes X and leaves both of X's group rows and no group.remove_member row" "$r" 'MUTANT|2|0'
expect "the rollback left X active and in both groups" "$(sql -c "select status || '|' || (select count(*) from app.group_members where membership_id = '$X_MS') from app.memberships where id = '$X_MS'")" '^active|2$'

AUD="$(maxaud)"
hold_company "$K" 2; sleep 0.3
r="$(rest POST /rpc/remove_member "$(cadmin)" "$(body "p_membership=$X_MS")")"; wait
expect "the removal of X succeeds after the held company lock" "$r" '"changed":true'
expect "X is in no group" "$(sql -c "select count(*) from app.group_members where membership_id = '$X_MS'")" '^0$'
expect "Y's rows in the same two groups stay" "$(sql -c "select count(*) from app.group_members where membership_id = '$Y_MS'")" '^2$'
expect "the audit rows in id order: membership.remove, group.remove_member by group id, then agent.orphan" "$(sql -c "select string_agg(action || coalesce(':' || (details->>'group_id'), ''), ',' order by id) from app.audit_events where id > $AUD")" "^membership.remove,group.remove_member:$FIRST,group.remove_member:$SECOND,agent.orphan\$"
expect "each group.remove_member row: group_id, X's membership_id, C's membership_id, reason_code membership_removed" "$(sql -c "select count(*) || '|' || bool_and(company_id = '$K' and actor_user_id = '$U_C' and entity_type = 'group' and details = jsonb_build_object('group_id', entity_id, 'membership_id', '$X_MS', 'previous_admin_membership_id', '$C_MS', 'reason_code', 'membership_removed')) from app.audit_events where id > $AUD and action = 'group.remove_member'")" '^2|true$'
expect "written in one transaction (one timestamp)" "$(sql -c "select count(distinct at) from app.audit_events where id > $AUD")" '^1$'
AUD2="$(maxaud)"; r="$(rest POST /rpc/remove_member "$(cadmin)" "$(body "p_membership=$X_MS")")"
expect "removing X again: the E2 no-op, with no new audit row" "$r|$(sql -c "select count(*) from app.audit_events where id > $AUD2")" '"changed":false.*|0$'
sql -c "update app.memberships set status = 'active', removed_at = null where id = '$X_MS'" >/dev/null
expect "reactivating X (owner-side) restores no group" "$(sql -c "select count(*) from app.group_members where membership_id = '$X_MS'")" '^0$'
AUD="$(maxaud)"; r="$(rest POST /rpc/remove_member "$(cadmin)" "$(body "p_membership=$Z_MS")")"
expect "control: removing Z, in no group and owning no agent, writes membership.remove alone" "$r|$(sql -c "select string_agg(action, ',' order by id) from app.audit_events where id > $AUD")" '"changed":true.*|membership.remove$'

section "21e the registers 006 wrote, against the committed installer manifest and canonical() (design 1.8)"
manifest_rows() { node --input-type=module -e '
  const m = await import(`${process.argv[1]}/lib/passport/installer-manifest.mjs`);
  const rows = [...m.INSTALLER_TEXTS].sort((a, b) => (a.target < b.target ? -1 : 1));
  process.stdout.write([m.GATE_IDENTITY_SHA256, ...rows.map((r) => [r.target, r.bytes, r.textSha256, r.coreSha256, r.branchSha256, r.judgeSha256].join(":"))].join(","));' "$ROOT"; }
canon_policy() { node --input-type=module -e '
  const { canonical } = await import(`${process.argv[1]}/lib/passport/canonical.mjs`);
  process.stdout.write(canonical({ approval_scope: "configuration_and_evidence", declared_writes: "not_installable", policy_version: 1, recipient_overrides: "personal_bindings_only" }));' "$ROOT"; }
MANIFEST="$(manifest_rows)"; GATE_HEX="$(sql -c "select encode(identity_sha256, 'hex') from app.gate_identities where active")"
expect "the manifest's gate is the active identity" "$MANIFEST" "^$GATE_HEX,"
expect "the four installer rows of the active gate equal lib/passport/installer-manifest.mjs: target, bytes, text, core, branch and judge hashes" "$(sql -c "select (select encode(identity_sha256, 'hex') from app.gate_identities where active) || ',' || string_agg(i.target || ':' || octet_length(i.text) || ':' || encode(i.text_sha256, 'hex') || ':' || encode(i.core_sha256, 'hex') || ':' || encode(i.branch_sha256, 'hex') || ':' || encode(i.judge_sha256, 'hex'), ',' order by i.target collate \"C\") from app.installer_texts i join app.gate_identities g on g.id = i.gate_id and g.active")" "^$MANIFEST\$"
expect "each stored text hash is the table's recomputation from the stored text" "$(sql -c "select count(*) || '|' || bool_and(text_sha256 = sha256(convert_to(text, 'UTF8'))) from app.installer_texts")" '^4|true$'
expect "the four targets, none publishable" "$(sql -c "select string_agg(target || ':' || publishable, ',' order by target collate \"C\") from app.release_targets")" '^chatgpt:false,claude-ai:false,claude-code:false,generic:false$'
CANON="$(canon_policy)"; POLICY_HASH="$(sha_hex "$CANON")"
expect "policy version 1: canonical() of design 1.8's object, active, its hash the trigger's" "$(sql -c "select count(*) || '|' || min(version) || '|' || bool_and(active) || '|' || bool_and(canonical = '$CANON') || '|' || min(encode(sha256, 'hex')) from app.release_policies")" "^1|1|true|true|$POLICY_HASH\$"
expect "four installer.register rows (system, no company), each naming its target, the gate and the stored text hash" "$(sql -c "select count(*) from app.audit_events a join app.installer_texts i on i.gate_id = a.entity_id and i.target = a.details->>'release_target' where a.action = 'installer.register' and a.actor_kind = 'system' and a.company_id is null and a.entity_type = 'installer_text' and a.details = jsonb_build_object('gate_identity_sha256', '$GATE_HEX', 'release_target', i.target, 'installer_text_sha256', encode(i.text_sha256, 'hex'))")|$(sql -c "select count(*) from app.audit_events where action = 'installer.register'")" '^4|4$'
expect "one policy.register row, details exactly policy_sha256" "$(sql -c "select count(*) || '|' || bool_and(a.actor_kind = 'system' and a.company_id is null and a.entity_type = 'release_policy' and a.entity_id = p.id and a.details = jsonb_build_object('policy_sha256', encode(p.sha256, 'hex'))) from app.audit_events a, app.release_policies p where a.action = 'policy.register'")" '^1|true$'

section "21e reads: an active member of an active company reads the registers and its company's groups; a removed member, an outsider and a suspended company's member read nothing"
M_JWT="$(user_jwt "e4-21-$RUN-m@example.invalid" "$PW21")"; R_JWT="$(user_jwt "e4-21-$RUN-r@example.invalid" "$PW21")"
O_JWT="$(user_jwt "e4-21-$RUN-o@example.invalid" "$PW21")"; Y_JWT="$(user_jwt "e4-21-$RUN-y@example.invalid" "$PW21")"
# PostgREST writes a newline and spaces between array elements; the comparison is on the rows, so those are removed.
compact() { printf '%s' "$1" | tr -d '\n' | sed 's/}, *{/},{/g'; }
r="$(rest GET "/release_targets?select=target,publishable&order=target" "$M_JWT")"
expect "member M: the four targets" "$(compact "$r")" '^HTTP 200 \[{"target":"chatgpt","publishable":false},{"target":"claude-ai","publishable":false},{"target":"claude-code","publishable":false},{"target":"generic","publishable":false}\]$'
expect "member M: the four installer texts" "$(compact "$(rest GET "/installer_texts?select=target&order=target" "$M_JWT")")" '^HTTP 200 \[{"target":"chatgpt"},{"target":"claude-ai"},{"target":"claude-code"},{"target":"generic"}\]$'
expect "member M: policy version 1" "$(rest GET "/release_policies?select=version,active" "$M_JWT")" '^HTTP 200 \[{"version":1,"active":true}\]$'
expect "member M: its company's group G1" "$(rest GET "/groups?select=id&id=eq.$G1" "$M_JWT")" "^HTTP 200 \[{\"id\":\"$G1\"}\]\$"
expect "member M: G1's member rows" "$(rest GET "/group_members?select=membership_id&group_id=eq.$G1" "$M_JWT")" "$M_MS"
expect "member M: company H's group, by id: empty" "$(rest GET "/groups?select=id&id=eq.$H1" "$M_JWT")" '^HTTP 200 \[\]$'
for who in R_JWT O_JWT; do
  eval "tok=\"\$$who\""
  for path in "/release_targets?select=target" "/installer_texts?select=target" "/release_policies?select=id" "/groups?select=id" "/group_members?select=group_id"; do
    expect "$who (no active membership): $path empty" "$(rest GET "$path" "$tok")" '^HTTP 200 \[\]$'
  done
done
sql -c "update app.companies set status = 'suspended' where id = '$K'" >/dev/null
for path in "/release_targets?select=target" "/groups?select=id" "/group_members?select=group_id"; do
  expect "Y, whose only company K is suspended: $path empty" "$(rest GET "$path" "$Y_JWT")" '^HTTP 200 \[\]$'
done
sql -c "update app.companies set status = 'active' where id = '$K'" >/dev/null
expect "control: Y reads K's groups again once K is active" "$(rest GET "/groups?select=id&id=eq.$KA" "$Y_JWT")" "$KA"

section "21e the registers refuse the owner's UPDATE, DELETE and TRUNCATE without the bypass (app.registry_frozen)"
reg_snap() { sql -c "select md5((select string_agg(target || publishable, ',' order by target) from app.release_targets) || (select string_agg(target || encode(text_sha256, 'hex'), ',' order by target) from app.installer_texts) || (select string_agg(version || encode(sha256, 'hex') || active, ',') from app.release_policies))"; }
RS="$(reg_snap)"
frozen() { local r; r="$(sql_try -c "$2")"; expect "owner: $1: E_REGISTRY_FROZEN" "$r" 'E_REGISTRY_FROZEN'; expect "owner: $1: the registers unchanged" "$(reg_snap)" "^$RS\$"; }
frozen "update release_targets" "update app.release_targets set publishable = true where target = 'generic'"
frozen "delete release_targets" "delete from app.release_targets where target = 'generic'"
r="$(sql_try -c "truncate app.release_targets")"
expect "owner: truncate release_targets without cascade stops at the installer texts' foreign key before any trigger (recorded)" "$r" 'cannot truncate a table referenced in a foreign key constraint'
frozen "truncate release_targets cascade" "truncate app.release_targets cascade"
frozen "update installer_texts" "update app.installer_texts set text = text where target = 'generic'"
frozen "delete installer_texts" "delete from app.installer_texts where target = 'generic'"
r="$(sql_try -c "truncate app.installer_texts")"
expect "owner: truncate installer_texts without cascade stops at part B's envelope foreign key before any trigger (recorded)" "$r" 'cannot truncate a table referenced in a foreign key constraint'
frozen "truncate installer_texts cascade" "truncate app.installer_texts cascade"
frozen "update release_policies" "update app.release_policies set active = false"
frozen "delete release_policies" "delete from app.release_policies"
r="$(sql_try -c "truncate app.release_policies")"
expect "owner: truncate release_policies without cascade stops at part B's envelope and release foreign keys before any trigger (recorded)" "$r" 'cannot truncate a table referenced in a foreign key constraint'
frozen "truncate release_policies cascade" "truncate app.release_policies cascade"
# The convention is SET LOCAL (004 A2): set in one transaction and committed, it does not reach the next statement of the
# same session. A session-level SET does reach it; 004 discloses that, probe 19d observes it, and it is not repeated here
# (this probe's first run did repeat it by mistake and committed the update, evidence/e4-prereqs.md).
r="$(sql_try -c "begin; set local app.registry_migration = 'on'; commit; update app.release_targets set publishable = true where target = 'generic';")"
expect "owner: the bypass set local in a committed transaction does not reach the next statement of the same session" "$r" 'E_REGISTRY_FROZEN'
expect "owner: and the registers are unchanged" "$(reg_snap)" "^$RS\$"
r="$(sql_try -c "begin; set local app.registry_migration = 'yes'; update app.release_targets set publishable = true where target = 'generic'; rollback;")"
expect "owner: a bypass value other than on is no bypass" "$r" 'E_REGISTRY_FROZEN'

section "21e no request role, and not app_maintenance, writes a register or a group table, even with the bypass set"
for role in anon authenticated app_server service_role app_maintenance; do
  grant=""; [ "$role" = app_maintenance ] && grant="grant app_maintenance to postgres;"
  for stmt in "insert into app.release_targets (target) values ('generic')" "update app.release_targets set publishable = true" "delete from app.installer_texts" "truncate app.installer_texts" "update app.release_policies set active = true" "insert into app.groups (company_id, name, created_by_membership_id) values ('$K', 'role write', '$C_MS')" "update app.groups set name = 'renamed'" "delete from app.group_members" "truncate app.group_members"; do
    r="$(sql_try -c "begin; $grant set local role $role; set local app.registry_migration = 'on'; $stmt; rollback;")"
    expect "$role: $stmt: permission denied" "$r" 'permission denied'
  done
done
r="$(sql_try -c "begin; grant app_maintenance to postgres; set local role app_maintenance; select 'MAINT|' || (select count(*) from app.installer_texts) || '|' || (select count(*) from app.release_policies) || '|' || (select count(*) from app.groups where company_id = '$G'); rollback;")"
expect "app_maintenance reads the registers and groups (its select policies), inside a rolled-back grant" "$r" 'MAINT|4|1|50'
# Not pg_has_role(..., 'MEMBER'): it answered true on this stack after the rolled-back grant (evidence/e4-prereqs.md). The
# rollback is shown the way probe 09 shows its revoke: the owner cannot assume the role afterwards.
expect "the grant was rolled back: the owner cannot assume app_maintenance afterwards" "$(sql_try -c "set role app_maintenance; select 1;")" 'permission denied'
expect "member JWT: PATCH api.release_targets refused" "$(rest PATCH "/release_targets?target=eq.generic" "$M_JWT" '{"publishable":true}')" '42501'
expect "member JWT: DELETE api.installer_texts refused" "$(rest DELETE "/installer_texts?target=eq.generic" "$M_JWT")" '42501'
expect "member JWT: POST api.release_policies refused" "$(rest POST "/release_policies" "$M_JWT" '{"version":2}')" '42501'
expect "member JWT: POST api.groups refused" "$(rest POST "/groups" "$M_JWT" '{"name":"direct"}')" '42501'
expect "member JWT: DELETE api.group_members refused" "$(rest DELETE "/group_members?group_id=eq.$G1" "$M_JWT")" '42501'
expect "the registers unchanged after every role" "$(reg_snap)" "^$RS\$"

section "21e under the migration bypass, in a rolled-back owner transaction: a later migration's writes work, and the hash triggers overwrite supplied values"
POLICY2_HASH="$(sha_hex '{"policy_version":2}')"
r="$(in_rollback "set local app.registry_migration = 'on';" \
  "update app.release_targets set publishable = true where target = 'generic';" \
  "select 'PUBLISHABLE|' || publishable from app.release_targets where target = 'generic';" \
  "update app.installer_texts set text = text || 'x', text_sha256 = decode(repeat('00', 32), 'hex') where target = 'generic';" \
  "select 'TEXT|' || (text_sha256 = sha256(convert_to(text, 'UTF8'))) || '|' || (text_sha256 <> decode(repeat('00', 32), 'hex')) from app.installer_texts where target = 'generic';" \
  "insert into app.release_policies (version, canonical, sha256) values (2, '{\"policy_version\":2}', decode(repeat('00', 32), 'hex'));" \
  "select 'POLICY|' || encode(sha256, 'hex') || '|' || active from app.release_policies where version = 2;")"
expect "bypass: a target becomes publishable" "$r" 'PUBLISHABLE|true'
expect "bypass: a supplied text hash is overwritten with the hash of the new text" "$r" 'TEXT|true|true'
expect "a policy inserted with a wrong hash stores the trigger's hash, inactive by default" "$r" "POLICY|$POLICY2_HASH|false"
expect "rolled back: the registers unchanged" "$(reg_snap)" "^$RS\$"
expect "a second active policy is refused by the one-active index" "$(in_rollback "insert into app.release_policies (version, canonical, active) values (2, 'x', true);")" 'release_policies_one_active'
expect "a target outside app.release_target_names() is refused by its check" "$(in_rollback "insert into app.release_targets (target) values ('copilot');")" 'release_targets_target_check'

section "21e a group is never deleted, and group membership rows are never truncated, the owner included (E_GROUP_DELETE)"
GS="$(sql -c "select (select count(*) from app.groups) || '|' || (select count(*) from app.group_members)")"
expect "owner: delete a group: E_GROUP_DELETE" "$(sql_try -c "delete from app.groups where id = '$KA'")" 'E_GROUP_DELETE'
expect "owner: truncate groups cascade: E_GROUP_DELETE" "$(sql_try -c "truncate app.groups cascade")" 'E_GROUP_DELETE'
expect "owner: truncate group_members: E_GROUP_DELETE" "$(sql_try -c "truncate app.group_members")" 'E_GROUP_DELETE'
expect "owner: truncate groups without cascade stops at the foreign key before any trigger (recorded)" "$(sql_try -c "truncate app.groups")" 'cannot truncate a table referenced in a foreign key constraint'
expect "groups and member rows unchanged" "$(sql -c "select (select count(*) from app.groups) || '|' || (select count(*) from app.group_members)")" "^$GS\$"
expect "recorded: an owner DELETE of one member row is not refused, since it is the routines' own operation (rolled back)" "$(in_rollback "delete from app.group_members where group_id = '$KA' and membership_id = '$Y_MS';" "select 'LEFT|' || count(*) from app.group_members where group_id = '$KA' and membership_id = '$Y_MS';")" 'LEFT|0'

section "21f the claim table admits exactly the eight bound function names (006 A7)"
claim() { in_rollback "insert into app.idempotency_keys (membership_id, key, fn, operation_sha256, response) values ('$M_MS', gen_random_uuid(), '$1', decode(repeat('ab', 32), 'hex'), '{}'::jsonb);" "select 'CLAIM|$1|' || count(*) from app.idempotency_keys where membership_id = '$M_MS' and fn = '$1';"; }
for fn in create_draft save_draft submit_candidate create_successor create_envelope record_review publish_release withdraw_release; do
  expect "owner claim row for $fn: accepted" "$(claim "$fn")" "CLAIM|$fn|1"
done
for fn in create_group remove_member drop_everything; do
  expect "owner claim row for $fn: refused by the check" "$(claim "$fn")" 'idempotency_keys_fn_check'
done
expect "no claim row was left behind" "$(sql -c "select count(*) from app.idempotency_keys where membership_id = '$M_MS'")" '^0$'

section "21g the audit allowlist's E4 keys (006 A8, design 2.4): each shape accepted, a wrong shape refused, part B's vocabulary accepted inside and refused outside"
aud() { in_rollback "insert into app.audit_events (company_id, actor_kind, action, entity_type, details) values ('$K', 'system', 'probe.audit', 'probe', '$1'::jsonb);" "select 'AUDIT|accepted';"; }
HEX64="$(node -e 'process.stdout.write("ab".repeat(32))')"; HEX64U="$(node -e 'process.stdout.write("AB".repeat(32))')"
for key in group_id envelope_id review_id release_id superseded_by_release_id; do
  expect "$key: a uuid string accepted" "$(aud "{\"$key\":\"$KA\"}")" 'AUDIT|accepted'
  expect "$key: not a uuid refused" "$(aud "{\"$key\":\"not-a-uuid\"}")" "E_AUDIT_DETAILS_VALUE $key"
done
for key in envelope_sha256 assembled_sha256 policy_sha256 installer_text_sha256; do
  expect "$key: 64 lowercase hex accepted" "$(aud "{\"$key\":\"$HEX64\"}")" 'AUDIT|accepted'
  expect "$key: uppercase hex refused" "$(aud "{\"$key\":\"$HEX64U\"}")" "E_AUDIT_DETAILS_VALUE $key"
done
for key in envelope_revision recipient_count; do
  expect "$key: an integer accepted" "$(aud "{\"$key\":3}")" 'AUDIT|accepted'
  expect "$key: a numeric string refused" "$(aud "{\"$key\":\"3\"}")" "E_AUDIT_DETAILS_VALUE $key"
done
expect "release_target: a registered target accepted" "$(aud '{"release_target":"claude-code"}')" 'AUDIT|accepted'
expect "release_target: another name refused" "$(aud '{"release_target":"copilot"}')" 'E_AUDIT_DETAILS_VALUE release_target'
for pair in review_role:business review_decision:changes_requested release_state_after:withdrawn; do
  key="${pair%%:*}"; value="${pair#*:}"
  # E4P-F4 closes with 006 part B's B1 (lent to the E4 server lane by the lead, 2026-09-15): the vocabulary exists, so
  # the key is judged like every other enumerated key.
  expect "$key: $value, inside its vocabulary, accepted" "$(aud "{\"$key\":\"$value\"}")" 'AUDIT|accepted'
  expect "$key: a value outside its vocabulary refused" "$(aud "{\"$key\":\"copilot\"}")" "E_AUDIT_DETAILS_VALUE $key"
done
expect "an unlisted key is still E_AUDIT_DETAILS_KEY" "$(aud '{"group_name":"Operations"}')" 'E_AUDIT_DETAILS_KEY group_name'
expect "a reason key is still E_AUDIT_DETAILS_KEY" "$(aud '{"reason":"because"}')" 'E_AUDIT_DETAILS_KEY reason'
expect "003's keys are kept" "$(aud "{\"candidate_id\":\"$KA\"}")" 'AUDIT|accepted'

section "21h composite keys: a member row names one company, and its group and its membership both belong to it (006 A2, A3)"
fk() { in_rollback "insert into app.group_members (group_id, company_id, membership_id, added_by_membership_id) values ('$1', '$2', '$3', '$C_MS');" "select 'INSERTED|1';"; }
expect "K's group, company K, H's membership: refused by the membership key" "$(fk "$KA" "$K" "$B_MS")" 'group_members_membership_id_company_id_fkey'
expect "K's group, company H, H's membership: refused by the group key" "$(fk "$KA" "$H" "$B_MS")" 'group_members_group_id_company_id_fkey'
expect "control: K's group, company K, K's membership Z: accepted" "$(fk "$KA" "$K" "$Z_MS")" 'INSERTED|1'
expect "memberships carries the composite unique key" "$(sql -c "select pg_get_constraintdef(oid) from pg_constraint where conname = 'memberships_id_company'")" '^UNIQUE (id, company_id)$'

section "21h grants, definer rights, views and row level security"
for f in "api.create_group(uuid,text)" "api.add_group_member(uuid,uuid)" "api.remove_group_member(uuid,uuid)" "api.remove_member(uuid)"; do
  expect "$f: app_server executes it; anon, authenticated and service_role do not" "$(sql -c "select has_function_privilege('app_server', '$f', 'execute') || '|' || has_function_privilege('anon', '$f', 'execute') || '|' || has_function_privilege('authenticated', '$f', 'execute') || '|' || has_function_privilege('service_role', '$f', 'execute')")" '^true|false|false|false$'
  expect "$f: SECURITY DEFINER with an empty search_path" "$(sql -c "select prosecdef || '|' || array_to_string(proconfig, ',') from pg_proc where oid = '$f'::regprocedure")" '^true|search_path=""$'
done
for f in "app.release_target_names()" "app.limit_groups_per_company()" "app.group_no_delete()" "app.installer_text_identity()" "app.release_policy_identity()"; do
  expect "$f: executable by neither authenticated nor app_server" "$(sql -c "select has_function_privilege('authenticated', '$f', 'execute') || '|' || has_function_privilege('app_server', '$f', 'execute')")" '^false|false$'
done
expect "the five views are security_invoker" "$(sql -c "select string_agg(relname || ':' || array_to_string(reloptions, ','), ',' order by relname) from pg_class where relnamespace = 'api'::regnamespace and relname in ('groups', 'group_members', 'release_targets', 'installer_texts', 'release_policies')")" '^group_members:security_invoker=true,groups:security_invoker=true,installer_texts:security_invoker=true,release_policies:security_invoker=true,release_targets:security_invoker=true$'
expect "authenticated selects the five views and inserts into none" "$(sql -c "select bool_and(has_table_privilege('authenticated', 'api.' || v, 'select')) || '|' || bool_or(has_table_privilege('authenticated', 'api.' || v, 'insert') or has_table_privilege('authenticated', 'api.' || v, 'update') or has_table_privilege('authenticated', 'api.' || v, 'delete')) from unnest(array['groups', 'group_members', 'release_targets', 'installer_texts', 'release_policies']) v")" '^true|false$'
expect "row level security on the five tables" "$(sql -c "select string_agg(relname || ':' || relrowsecurity, ',' order by relname) from pg_class where oid in ('app.groups'::regclass, 'app.group_members'::regclass, 'app.release_targets'::regclass, 'app.installer_texts'::regclass, 'app.release_policies'::regclass)")" '^group_members:true,groups:true,installer_texts:true,release_policies:true,release_targets:true$'

section "21h lib/db/user.mjs VIEWS (design 2.6 item 2): part A's five views read through the user client with a real token; part B's four are listed and answer E_INTERNAL until part B creates them; an unlisted name is refused before any request"
user_client() { node --input-type=module -e '
  const [root, access] = process.argv.slice(1);
  const { stackEnv } = await import(`${root}/tests/e2/helpers/stack.mjs`);
  stackEnv();
  const { sessionOf } = await import(`${root}/tests/e2/helpers/pages.mjs`);
  const { select } = await import(`${root}/lib/db/user.mjs`);
  const session = await sessionOf(access);
  const out = [];
  for (const [view, column] of [["groups", "id"], ["group_members", "group_id"], ["release_targets", "target"], ["installer_texts", "target"], ["release_policies", "id"]])
    out.push(`${view}:${(await select(session, view, { select: column })).length}`);
  for (const view of ["review_envelopes", "reviews", "releases", "release_downloads", "group_names"]) {
    try {
      await select(session, view, { select: "id" });
      out.push(`${view}:read`);
    } catch (e) {
      out.push(`${view}:${e.code ?? e.name}`);
    }
  }
  process.stdout.write(out.join(","));' "$ROOT" "$1"; }
expect "user client as member M of G (50 groups, one member row visible)" "$(user_client "$M_JWT")" '^groups:50,group_members:1,release_targets:4,installer_texts:4,release_policies:1,review_envelopes:read,reviews:read,releases:read,release_downloads:read,group_names:TypeError$'

section "21i one mutant per change, each installed in an owner transaction that is always rolled back (evidence/m004.md lesson 6); each shows the counterexample a named arm above refuses"
MUT="$(mutant 'api.create_group(uuid,text)' "  admin := app.require_admin(p_company, actor);" "  select * into admin from app.memberships m where m.company_id = p_company and m.user_id = actor;")"
r="$(in_rollback "$MUT;" "$(as_claims "$U_Y")" "select 'MUTANT|' || g.changed from api.create_group('$K', 'Mutant member $RUN') g;")"
expect "mutant A4 (create_group without app.require_admin): member Y creates a group, which 21a's \"a member at aal2: E_FORBIDDEN\" refuses" "$r" 'MUTANT|true'
MUT="$(mutant 'api.create_group(uuid,text)' ") >= app.quota(p_company, 'groups_per_company') then" ") > app.quota(p_company, 'groups_per_company') then")"
r="$(in_rollback "$MUT;" "$(as_claims "$U_A")" "select 'MUTANT|' || g.changed from api.create_group('$G', 'Mutant limit $RUN') g;" "select 'COUNT|' || count(*) from app.groups where company_id = '$G';")"
expect "mutant A1 limit (> for >=): company G's 51st group is created, which 21c's \"the 51st: E_GROUP_LIMIT\" refuses" "$r" 'MUTANT|true'
expect "mutant A1 limit: and G would hold 51" "$r" 'COUNT|51'
MUT="$(mutant 'api.add_group_member(uuid,uuid)' "  if target.status <> 'active' then" "  if false then")"
r="$(in_rollback "$MUT;" "$(as_claims "$U_A")" "select 'MUTANT|' || x.changed from api.add_group_member('$G1', '$R_MS') x;")"
expect "mutant A4 add (no removed-membership test): removed R joins G1, which 21b's \"a removed membership of company G: E_MEMBERSHIP_REMOVED\" refuses" "$r" 'MUTANT|true'
r="$(in_rollback "alter table app.group_members drop constraint group_members_membership_id_company_id_fkey;" "alter table app.group_members add foreign key (membership_id) references app.memberships (id);" "insert into app.group_members (group_id, company_id, membership_id, added_by_membership_id) values ('$KA', '$K', '$B_MS', '$C_MS');" "select 'MUTANT|' || count(*) from app.group_members where membership_id = '$B_MS';")"
expect "mutant A3 (the membership key on id alone): H's membership sits in K's group, which 21h's \"H's membership: refused by the membership key\" refuses" "$r" 'MUTANT|1'
r="$(in_rollback "drop trigger release_policies_no_truncate on app.release_policies;" "alter table app.review_envelopes drop constraint review_envelopes_policy_id_fkey;" "alter table app.releases drop constraint releases_policy_id_fkey;" "truncate app.release_policies;" "select 'MUTANT|' || count(*) from app.release_policies;")"
expect "mutant A6 (release_policies without its TRUNCATE trigger, and without part B's two foreign keys to it, which refuse a plain truncate on their own): the owner erases policy v1, which 21e's \"owner: truncate release_policies cascade: E_REGISTRY_FROZEN\" refuses" "$r" 'MUTANT|0'
r="$(in_rollback "alter table app.idempotency_keys drop constraint idempotency_keys_fn_check;" "alter table app.idempotency_keys add constraint idempotency_keys_fn_check check (fn in ('create_draft', 'save_draft', 'submit_candidate', 'create_successor'));" "insert into app.idempotency_keys (membership_id, key, fn, operation_sha256, response) values ('$M_MS', gen_random_uuid(), 'withdraw_release', decode(repeat('ab', 32), 'hex'), '{}'::jsonb);")"
expect "mutant A7 (003's four names): a withdraw_release claim row is refused, which 21f's \"owner claim row for withdraw_release: accepted\" refuses" "$r" 'idempotency_keys_fn_check'
MUT="$(mutant 'app.audit_details_guard()' "'group_id', 'envelope_id'" "'envelope_id'")"
r="$(in_rollback "$MUT;" "$(as_claims "$U_C")" "select 'MUTANT|' || g.changed from api.create_group('$K', 'Guard mutant $RUN') g;")"
expect "mutant A8 (the allowlist without group_id): an admin's create fails E_AUDIT_DETAILS_KEY group_id, which 21a's \"admin at aal2 creates the group: changed true\" refuses" "$r" 'E_AUDIT_DETAILS_KEY group_id'
expect "every mutant rolled back: company G holds 50 groups, R is in no group, the policy and the check stand" "$(sql -c "select (select count(*) from app.groups where company_id = '$G') || '|' || (select count(*) from app.group_members where membership_id = '$R_MS') || '|' || (select count(*) from app.release_policies) || '|' || (select count(*) from pg_constraint where conname = 'idempotency_keys_fn_check' and pg_get_constraintdef(oid) like '%withdraw_release%')")" '^50|0|1|1$'

section "21 no deadlock during the probe"
expect "pg_stat_database.deadlocks unchanged" "$(deadlocks)" "^$DL0\$"
[ "$FAILED" = 0 ] && echo "21 PASS" || { echo "21 FAIL"; exit 1; }
