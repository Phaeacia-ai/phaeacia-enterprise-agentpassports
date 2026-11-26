#!/usr/bin/env bash
# E3 probe 12: the content boundary (docs/e3/design.md 1.2, 2.3, 4.1; section 6 cases 2, 11, 14, 37, 38, 41).
# Grants, policies and roles; the bound bearer; the P0003 round trip through PostgREST and lib/errors.mjs;
# the binding and operation projections at the routine level and over case 14's typed vectors. Builds its own
# synthetic company and users, so it does not depend on what probes 01 to 11 left, and leaves them behind.
# Run: bash tests/db/12-content-grants.sh (after tests/db/00-seed.sh).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"
export API_URL ANON_KEY JWT_SECRET
E3() { node "$ROOT/tests/db/e3.mjs" "$@"; }
# request_changes, through api.record_review since the E4 review seam retired (E4 design 2.6 item 8).
source "$ROOT/tests/db/e4-lib.sh"
RUN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(3).toString("hex"))')"
TMP12="$E2_TMP/12"; mkdir -p "$TMP12"
PW12='Synthetic-Pass-1234'
OPJWT="$(server_jwt "$U_op" aal2)"

section "12 setup: company G1 with an admin, two members, an it_reviewer and a removed member; company G2"
U_A="$(create_user "e3-12-$RUN-admin@example.invalid" "$PW12")"
U_M="$(create_user "e3-12-$RUN-member@example.invalid" "$PW12")"
U_M2="$(create_user "e3-12-$RUN-member2@example.invalid" "$PW12")"
U_R="$(create_user "e3-12-$RUN-reviewer@example.invalid" "$PW12")"
U_X="$(create_user "e3-12-$RUN-removed@example.invalid" "$PW12")"
U_B="$(create_user "e3-12-$RUN-beta@example.invalid" "$PW12")"
G1="$(rest POST /rpc/provision_company "$OPJWT" "{\"p_slug\":\"e3-12-$RUN-g1\",\"p_name\":\"SYNTHETIC E3 G1\",\"p_first_admin_user\":\"$U_A\"}" | sed -n 's/.*"company_id":"\([^"]*\)".*/\1/p')"
G2="$(rest POST /rpc/provision_company "$OPJWT" "{\"p_slug\":\"e3-12-$RUN-g2\",\"p_name\":\"SYNTHETIC E3 G2\",\"p_first_admin_user\":\"$U_B\"}" | sed -n 's/.*"company_id":"\([^"]*\)".*/\1/p')"
sql -c "insert into app.memberships (company_id, user_id, roles) values
  ('$G1','$U_M','{member}'), ('$G1','$U_M2','{member}'), ('$G1','$U_R','{it_reviewer,member}'), ('$G1','$U_X','{member}');" >/dev/null
X_JWT="$(user_jwt "e3-12-$RUN-removed@example.invalid" "$PW12")"   # a valid JWT, issued before the removal
sql -c "update app.memberships set status='removed', removed_at=now() where company_id='$G1' and user_id='$U_X'" >/dev/null
M_JWT="$(user_jwt "e3-12-$RUN-member@example.invalid" "$PW12")"
M2_JWT="$(user_jwt "e3-12-$RUN-member2@example.invalid" "$PW12")"
R_JWT="$(user_jwt "e3-12-$RUN-reviewer@example.invalid" "$PW12")"
A_JWT="$(user_jwt "e3-12-$RUN-admin@example.invalid" "$PW12")"
expect "G1 and G2 provisioned" "$G1 $G2" '^[0-9a-f-]\{36\} [0-9a-f-]\{36\}$'
AGENT_NAME="p12-$RUN"
SUBMISSION='{"confidence":"high","permitted_data":"synthetic records only","source_platform":"synthetic probe"}'

section "12a case 14 at the routine level: all four routines accept bodies and bearers built by lib/db/server.mjs bindCall()"
r="$(E3 call create_draft "$U_M" "{\"company_id\":\"$G1\",\"agent_name\":\"$AGENT_NAME\",\"content\":\"@content\",\"derived_canonical\":\"@derived\",\"gate_identity\":\"@gate\",\"idempotency_key\":\"@uuid\"}" --revision 1 --save "$TMP12/create1")"
expect "create_draft by name, bound by Node, accepted by SQL" "$r" 'HTTP 200 .*"state": *"draft"'
D1="$(printf '%s' "$r" | E3 field candidate_id)"; AGENT="$(printf '%s' "$r" | E3 field agent_id)"
r="$(E3 call create_draft "$U_M" "{\"company_id\":\"$G1\",\"agent_id\":\"$AGENT\",\"content\":\"@content\",\"derived_canonical\":\"@derived\",\"gate_identity\":\"@gate\",\"idempotency_key\":\"@uuid\"}" --revision 2)"
expect "create_draft for an existing agent id, sequence 2" "$r" 'HTTP 200 .*"sequence": *2'
S1="$(printf '%s' "$r" | E3 field candidate_id)"
r="$(E3 call save_draft "$U_M" "{\"candidate_id\":\"$D1\",\"expected_version\":1,\"content\":\"@content\",\"derived_canonical\":\"@derived\",\"gate_identity\":\"@gate\",\"idempotency_key\":\"@uuid\"}" --revision 3)"
expect "save_draft, bound by Node, accepted by SQL, version 2" "$r" 'HTTP 200 .*"version": *2'
r="$(E3 call submit_candidate "$U_M" "{\"candidate_id\":\"$S1\",\"expected_version\":1,\"content_sha256\":\"@content_sha256\",\"derived_canonical\":\"@derived\",\"submission_canonical\":$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$SUBMISSION"),\"gate_identity\":\"@gate\",\"idempotency_key\":\"@uuid\"}" --revision 2)"
expect "submit_candidate, bound by Node, accepted by SQL" "$r" 'HTTP 200 .*"state": *"submitted"'
r="$(E3 call create_draft "$U_M" "{\"company_id\":\"$G1\",\"agent_id\":\"$AGENT\",\"content\":\"@content\",\"derived_canonical\":\"@derived\",\"gate_identity\":\"@gate\",\"idempotency_key\":\"@uuid\"}" --revision 4)"
S2="$(printf '%s' "$r" | E3 field candidate_id)"
r="$(E3 call submit_candidate "$U_M" "{\"candidate_id\":\"$S2\",\"expected_version\":1,\"content_sha256\":\"@content_sha256\",\"derived_canonical\":\"@derived\",\"submission_canonical\":$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$SUBMISSION"),\"gate_identity\":\"@gate\",\"idempotency_key\":\"@uuid\"}" --revision 4)"
expect "a second submitted candidate for the seam" "$r" 'HTTP 200 .*"state": *"submitted"'

section "12b case 14 over the ten typed vectors: bindingSql and operationSql in SQL equal Node's digests; the uncoalesced SQL differs"
out="$(E3 vectors-sql | sql 2>&1)"
expect "ten vectors match in both projections" "$(printf '%s\n' "$out" | grep -c '^VECTOR_.*|t|t$')" '^10$'
expect "no vector mismatches" "$(printf '%s\n' "$out" | grep -c '^VECTOR_.*|f')" '^0$'
expect "the SQL written without coalesce differs, and the probe says so" "$out" 'UNCOALESCED_DIFFERS|t'

section "12c case 11: a bearer bound to one call reaches no other"
AUDIT0="$(sql -c "select count(*) from app.audit_events")"; V0="$(sql -c "select version from app.candidate_versions where id='$D1'")"
SAVE="{\"candidate_id\":\"$D1\",\"expected_version\":2,\"content\":\"@content\",\"derived_canonical\":\"@derived\",\"gate_identity\":\"@gate\",\"idempotency_key\":\"@uuid\"}"
r="$(E3 call save_draft "$U_M" "$SAVE" --revision 5 --bind-revision 6)"; expect "bound to content A, sent with content B: E_NOT_BOUND" "$r" 'HTTP 403 .*E_NOT_BOUND'
r="$(E3 call save_draft "$U_M" "$SAVE" --revision 5 --claims '{"fn":"create_draft"}')"; expect "a wrong fn claim: E_NOT_BOUND" "$r" 'HTTP 403 .*E_NOT_BOUND'
r="$(E3 call save_draft "$U_M" "$SAVE" --revision 5 --drop jti)"; expect "no jti: E_NOT_BOUND" "$r" 'HTTP 403 .*E_NOT_BOUND'
r="$(E3 call save_draft "$U_M" "$SAVE" --revision 5 --claims '{"jti":"not-a-uuid"}')"; expect "a jti that is not a uuid: E_NOT_BOUND" "$r" 'HTTP 403 .*E_NOT_BOUND'
r="$(E3 call save_draft "$U_M" "$SAVE" --revision 5 --drop fn,args_sha256,jti)"; expect "an unbound server bearer on an E3 routine: E_NOT_BOUND" "$r" 'HTTP 403 .*E_NOT_BOUND'
BOUND_CLAIMS='{"fn":"save_draft","args_sha256":"'"$(printf 'a%.0s' $(seq 64))"'","jti":"7d0c6b2e-4f1a-4c3b-9e8d-2a1b0c9d8e7f"}'
r="$(rest POST /rpc/invite_member "$(server_jwt "$U_A" aal2 "$BOUND_CLAIMS")" "{\"p_company\":\"$G1\",\"p_email\":\"e3-12-$RUN-bound@example.invalid\",\"p_roles\":[\"member\"]}")"
expect "a bearer bound to save_draft, against invite_member: E_NOT_SERVER" "$r" 'E_NOT_SERVER'
expect "no audit row and no version change from the refused calls" "$(sql -c "select count(*) from app.audit_events")|$(sql -c "select version from app.candidate_versions where id='$D1'")" "^$AUDIT0|$V0\$"
r="$(E3 call save_draft "$U_M" "$SAVE" --revision 5 --save "$TMP12/save5")"; expect "control: the correctly bound bearer succeeds" "$r" 'HTTP 200 .*"version": *3'
M_MS="$(sql -c "select id from app.memberships where company_id='$G1' and user_id='$U_M'")"
r="$(rest POST /rpc/set_roles "$(server_jwt "$U_A" aal2)" "{\"p_membership\":\"$M_MS\",\"p_roles\":[\"member\"]}")"
expect "control: an unbound bearer still runs an E2 function (set_roles no-op)" "$r" 'HTTP 200.*"changed":false'
section "12c fail-before: app.bound_actor without its args_sha256 comparison accepts content B under a bearer bound to A"
MUT="create or replace function app.bound_actor(p_fn text, p_args_sha256 bytea) returns uuid language plpgsql stable set search_path = '' as \$m\$ declare c jsonb := app.jwt_claims(); actor uuid := app.app_server_subject(); begin if c->>'fn' is distinct from p_fn or c->>'jti' is null then raise exception 'E_NOT_BOUND' using errcode = '42501'; end if; return actor; end \$m\$;"
CALL="$(E3 sql save_draft "$U_M" "{\"candidate_id\":\"$D1\",\"expected_version\":3,\"content\":\"@content\",\"derived_canonical\":\"@derived\",\"gate_identity\":\"@gate\",\"idempotency_key\":\"@uuid\"}" --revision 7 --bind-revision 8)"
r="$(printf 'begin;\n%s\n%s\nrollback;\n' "$MUT" "$CALL" | sql_try)"; expect "mutant: the mismatched bearer writes (then rolled back)" "$r" '"version": *4'
r="$(printf 'begin;\n%s\nrollback;\n' "$CALL" | sql_try)"; expect "real: the same call is E_NOT_BOUND" "$r" 'E_NOT_BOUND'

section "12d case 2: no PostgREST role writes content directly; app_maintenance reads and cannot write"
# Each UPDATE names a column the view really has, so PostgREST reaches the privilege check rather than refusing an
# unknown column first (PGRST204), which would pass nothing about privileges. Found on this probe's first run.
for view in candidate_versions agents candidate_contributors; do
  case "$view" in candidate_versions) PATCH='{"confidence":"low"}';; agents) PATCH='{"status":"archived"}';; candidate_contributors) PATCH='{"observed":true}';; esac
  for who in member anon service; do
    case "$who" in member) J="$M_JWT";; anon) J="$ANON_KEY";; service) J="$SERVICE_ROLE_KEY";; esac
    r="$(rest POST "/$view" "$J" "{\"id\":\"$D1\"}")"; expect "$who INSERT api.$view refused" "$r" 'HTTP 401\|HTTP 403\|42501'
    r="$(rest PATCH "/$view?id=eq.$D1" "$J" "$PATCH")"; expect "$who UPDATE api.$view refused" "$r" 'HTTP 401\|HTTP 403\|42501'
    r="$(rest DELETE "/$view?id=eq.$D1" "$J")"; expect "$who DELETE api.$view refused" "$r" 'HTTP 401\|HTTP 403\|42501'
  done
done
r="$(rest GET "/candidate_versions?select=id" "$(server_jwt "$U_M")")"; expect "app_server reads no content table" "$r" '42501\|HTTP 401\|HTTP 403'
r="$(rest POST /rpc/save_draft "$M_JWT" "$(E3 body "$TMP12/save5")")"; expect "a member JWT calling save_draft with a real body: permission denied for the function" "$r" 'permission denied for function save_draft'
r="$(rest POST /rpc/save_draft "$SERVICE_ROLE_KEY" "$(E3 body "$TMP12/save5")")"; expect "the service key calling save_draft with a real body: permission denied for the function" "$r" 'permission denied for function save_draft'
r="$(rest POST /rpc/create_draft "$ANON_KEY" "$(E3 body "$TMP12/create1")")"; expect "anon calling create_draft with a real body is refused" "$r" 'permission denied'
sql -c "grant app_maintenance to postgres" >/dev/null
r="$(sql_try -c "begin; set local role app_maintenance; select 'MAINT_READ|'||count(*) from app.candidate_versions where company_id='$G1'; rollback;")"; expect "app_maintenance selects content" "$r" 'MAINT_READ|3'
r="$(sql_try -c "begin; set local role app_maintenance; update app.candidate_versions set confidence='low' where id='$D1'; rollback;")"; expect "app_maintenance update refused" "$r" 'permission denied'
r="$(sql_try -c "begin; set local role app_maintenance; delete from app.candidate_versions where id='$D1'; rollback;")"; expect "app_maintenance delete refused" "$r" 'permission denied'
r="$(sql_try -c "begin; set local role app_maintenance; select count(*) from app.idempotency_keys; rollback;")"; expect "app_maintenance reads no claim rows" "$r" 'permission denied'
expect "no non-SELECT policy for app_maintenance on any E3 table" "$(sql -c "select count(*) from pg_policies where schemaname='app' and tablename in ('agents','candidate_versions','candidate_contributors','gate_identities','gate_identity_files','idempotency_keys') and cmd <> 'SELECT'")" '^0$'
expect "no policy at all on app.idempotency_keys" "$(sql -c "select count(*) from pg_policies where schemaname='app' and tablename='idempotency_keys'")" '^0$'
sql -c "revoke app_maintenance from postgres" >/dev/null

section "12e case 37: reads through the views follow design 4.1 exactly"
# grep finds nothing for a reader who correctly sees nothing; under lib.sh's pipefail that must not end the probe.
count_ids() { { printf '%s' "$1" | grep -o '"id":"[0-9a-f-]*"' || true; } | sort -u | wc -l | tr -d ' '; }
for pair in "member-author:$M_JWT:2:3" "other-member:$M2_JWT:0:0" "it_reviewer:$R_JWT:2:3" "company_admin:$A_JWT:2:3" "removed-member:$X_JWT:0:0"; do
  IFS=: read -r who jwt want_c want_k <<<"$pair"
  r="$(rest GET "/candidate_versions?select=id&id=in.($D1,$S1,$S2)" "$jwt")"
  n="$(count_ids "$r")"
  case "$who" in member-author) want=3;; it_reviewer|company_admin) want=2;; *) want=0;; esac
  expect "$who sees $want of the three candidates (draft D1, submitted S1, S2)" "$n" "^$want\$"
done
r="$(rest GET "/candidate_versions?select=id,state&id=eq.$D1" "$R_JWT")"; expect "the reviewer does not see the author's draft" "$r" '^HTTP 200 \[\]'
r="$(rest GET "/candidate_contributors?select=candidate_id&candidate_id=eq.$S1" "$M2_JWT")"; expect "another member reads no contributors of S1" "$r" '^HTTP 200 \[\]'
r="$(rest GET "/candidate_contributors?select=kind&candidate_id=eq.$S1" "$R_JWT" | tr '\n' ' ')"; expect "the reviewer reads S1's contributors (author, submitter)" "$r" '"author".*"submitter"\|"submitter".*"author"'
r="$(rest GET "/agents?select=id&id=eq.$AGENT" "$M2_JWT")"; expect "every active member reads the agent" "$r" "\"id\":\"$AGENT\""
r="$(rest GET "/agents?select=id&id=eq.$AGENT" "$X_JWT")"; expect "the removed member reads no agent" "$r" '^HTTP 200 \[\]'
r="$(rest GET "/gate_identities?select=validator_version,active" "$M2_JWT")"; expect "an active member reads the gate identity" "$r" '"validator_version":"0.1.0","active":true'
READERS="$U_M $U_M2 $U_R $U_A $U_X"
# The separator comes from a variable: bash 4.3 and later remove quotes written literally in a ${var//x/y}
# replacement, so '${READERS// /','}' gave one string a,b,c there and three uuids only on bash 3.2.
SEP="','"
IDS="array['$D1','$S1','$S2']::uuid[]"
DOORS=""
for u in $READERS; do
  DOORS="$DOORS$(sql -c "begin; select set_config('request.jwt.claims', '{\"sub\":\"$u\",\"role\":\"authenticated\"}', true);
    select 'D|$u|'||id||'|'||app.candidate_visible(id) from unnest($IDS) id order by id;
    select 'H|$u|'||(app.has_role('$G1','it_reviewer') or app.has_role('$G1','business_reviewer') or app.has_role('$G1','company_admin'));
    rollback;" | grep '^[DH]|')"$'\n'
done
EXPLICIT="$(sql -c "select 'D|'||u||'|'||id||'|'||app.candidate_visible_to(id, u) from unnest(array['${READERS// /$SEP}']::uuid[]) u, unnest($IDS) id order by u, id;
  select 'H|'||u||'|'||exists (select 1 from app.memberships m where m.id = app.membership_of('$G1', u) and m.roles && array['it_reviewer','business_reviewer','company_admin']::text[]) from unnest(array['${READERS// /$SEP}']::uuid[]) u;")"
sorted() { printf '%s\n' "$1" | grep -v '^$' | sort; }
expect "(a) the two doors agree for every reader and row" "$(diff <(sorted "$(printf '%s' "$DOORS" | grep '^D|')") <(sorted "$(printf '%s' "$EXPLICIT" | grep '^D|')") >/dev/null && echo same || echo differ)" '^same$'
expect "(b) the inline role component agrees with OR(app.has_role) for every reader" "$(diff <(sorted "$(printf '%s' "$DOORS" | grep '^H|')") <(sorted "$(printf '%s' "$EXPLICIT" | grep '^H|')") >/dev/null && echo same || echo differ)" '^same$'
WHOLE="$(sql -c "select 'D|'||u||'|'||v.id||'|'||((v.author_membership_id is not distinct from app.membership_of(v.company_id, u)) or (v.state <> 'draft' and exists (select 1 from app.memberships m where m.id = app.membership_of(v.company_id, u) and m.roles && array['it_reviewer','business_reviewer','company_admin']::text[])))
  from unnest(array['${READERS// /$SEP}']::uuid[]) u, app.candidate_versions v where v.id = any ($IDS) order by u, v.id;")"
expect "(c) authorship plus (b)'s role verdict reproduces the matrix for every reader and row" "$(diff <(sorted "$WHOLE") <(sorted "$(printf '%s' "$DOORS" | grep '^D|')") >/dev/null && echo same || echo differ)" '^same$'
# A boolean concatenated with || renders as true or false, not t or f.
expect "the two old counterexamples hold on correct code: author visible without a reviewer role" "$(printf '%s' "$DOORS" | grep -c "^D|$U_M|$D1|true\|^H|$U_M|false")" '^2$'
expect "and a reviewer with the role does not see another author's draft" "$(printf '%s' "$DOORS" | grep -c "^D|$U_R|$D1|false\|^H|$U_R|true")" '^2$'
r="$(sql_try -c "begin; create policy probe_open on app.candidate_versions for select to authenticated using (true);
  select set_config('request.jwt.claims', '{\"sub\":\"$U_M2\",\"role\":\"authenticated\"}', true); set local role authenticated;
  select 'OPEN|'||count(*) from api.candidate_versions where id = any ($IDS); rollback;")"
expect "control: a permissive policy added in a rolled-back transaction returns MORE rows to the other member" "$r" 'OPEN|3'
r="$(sql_try -c "begin; select set_config('request.jwt.claims', '{\"sub\":\"$U_M2\",\"role\":\"authenticated\"}', true); set local role authenticated;
  select 'REAL|'||count(*) from api.candidate_versions where id = any ($IDS); rollback;")"
expect "and under the real policy the same member reads none" "$r" 'REAL|0'
echo "note: the doors above are evaluated with each reader's claims as the owner: authenticated has no USAGE on schema app, so it reaches app.candidate_visible only through the policy, which the view reads above exercise"
expect "the grants: authenticated may execute the two RLS doors and neither explicit body" "$(sql -c "select has_function_privilege('authenticated','app.candidate_visible(uuid)','execute')||'|'||has_function_privilege('authenticated','app.my_membership(uuid)','execute')||'|'||has_function_privilege('authenticated','app.candidate_visible_to(uuid,uuid)','execute')||'|'||has_function_privilege('authenticated','app.membership_of(uuid,uuid)','execute')")" '^true|true|false|false$'
r="$(sql_try -c "begin; revoke execute on function app.candidate_visible(uuid) from authenticated; select set_config('request.jwt.claims', '{\"sub\":\"$U_M\",\"role\":\"authenticated\"}', true); set local role authenticated; select 'M1|'||count(*) from api.candidate_versions where id = any ($IDS); rollback;")"
expect "fail-before (M1): without the EXECUTE grant the author's own read fails inside the policy" "$r" 'permission denied for function candidate_visible'
r="$(sql_try -c "begin; select set_config('request.jwt.claims', '{\"sub\":\"$U_M\",\"role\":\"authenticated\"}', true); set local role authenticated; select 'M1|'||count(*) from api.candidate_versions where id = any ($IDS); rollback;")"
expect "real (M1): with the grant the author reads all three" "$r" 'M1|3'
expect "RLS is not forced on app.candidate_versions (forcing it would make the helper recurse)" "$(sql -c "select relforcerowsecurity from pg_class where oid='app.candidate_versions'::regclass")" '^f$'

section "12f case 38: E_GATE_UNREGISTERED with P0003 through PostgREST, mapped by the real lib/errors.mjs"
AUDIT1="$(sql -c "select count(*) from app.audit_events")"; ROWS1="$(sql -c "select count(*) from app.candidate_versions")"
r="$(E3 call create_draft "$U_M" "{\"company_id\":\"$G1\",\"agent_id\":\"$AGENT\",\"content\":\"@content\",\"derived_canonical\":\"@derived\",\"gate_identity\":\"@gate\",\"idempotency_key\":\"@uuid\"}" --revision 9 --gate "$(printf 'b%.0s' $(seq 64))")"
expect "PostgREST carries SQLSTATE P0003 and the E_GATE_UNREGISTERED token" "$r" '"code":"P0003".*E_GATE_UNREGISTERED\|E_GATE_UNREGISTERED.*"code":"P0003"'
mapped="$(printf '%s' "$r" | node --input-type=module -e "
  import { fromPostgrest, errorBody } from '$ROOT/lib/errors.mjs';
  let s=''; process.stdin.on('data', d => s += d).on('end', () => {
    const status = Number(s.split(' ')[1]); const body = JSON.parse(s.slice(s.indexOf(' ', 5) + 1));
    const e = fromPostgrest({ status, body });
    console.log('MAPPED', e.status, JSON.stringify(errorBody(e.code)), 'postgrest', status);
  });")"
expect "mapped to 503 E_GATE_UNREGISTERED, no PostgREST details in the body" "$mapped" 'MAPPED 503 {"ok":false,"code":"E_GATE_UNREGISTERED","message":"Content checks are being updated. Retry shortly."}'
expect "no row and no audit row from the refused call" "$(sql -c "select count(*) from app.candidate_versions")|$(sql -c "select count(*) from app.audit_events")" "^$ROWS1|$AUDIT1\$"
echo "note: the P0001 control of case 38 is tests/e3/unit/errors.test.mjs; no migration raises E_GATE_UNREGISTERED under another SQLSTATE to call"

section "12g the E4 review seam is retired: S2's change request is api.record_review's (E4 design 2.6 item 8; case 41's refusal probe moved to the download seam, tests/db/22-review-grants.sh)"
expect "S2 is submitted" "$(sql -c "select state from app.candidate_versions where id='$S2'")" '^submitted$'
request_changes "$S2"
expect "api.record_review, by an independent reviewer through a bound bearer, moves S2 to changes_requested" "$(sql -c "select state from app.candidate_versions where id='$S2'")" '^changes_requested$'
r="$(E3 call create_successor "$U_M" "{\"candidate_id\":\"$S2\",\"content_sha256\":\"@content_sha256\",\"derived_canonical\":\"@derived\",\"gate_identity\":\"@gate\",\"idempotency_key\":\"@uuid\"}" --revision 4)"
expect "case 14: create_successor, bound by Node, accepted by SQL, now that it has a parent" "$r" 'HTTP 200 .*"supersedes_candidate_id": *"'"$S2"'"'

section "12h E3a critique F3, design 4.1: registry rows only for a reader holding an active membership in an active company"
# The 2.3 sketch's using (true) let a stale reader read the registry; 4.1's stale column is 404 and the lead settled
# that 4.1 wins. Each reader is evaluated under SET LOCAL ROLE authenticated with that reader's own claims.
U_O="$(create_user "e3-12-$RUN-nobody@example.invalid" "$PW12")"
U_S="$(create_user "e3-12-$RUN-suspended@example.invalid" "$PW12")"
G3="$(rest POST /rpc/provision_company "$OPJWT" "{\"p_slug\":\"e3-12-$RUN-g3\",\"p_name\":\"SYNTHETIC E3 G3\",\"p_first_admin_user\":\"$U_A\"}" | sed -n 's/.*"company_id":"\([^"]*\)".*/\1/p')"
sql -c "insert into app.memberships (company_id, user_id, roles) values ('$G3','$U_S','{member}'), ('$G1','$U_B','{member}');
  update app.companies set status='suspended' where id='$G3';
  update app.memberships set status='removed', removed_at=now() where company_id='$G1' and user_id='$U_B';" >/dev/null
S_JWT="$(user_jwt "e3-12-$RUN-suspended@example.invalid" "$PW12")"
standing() { sql -c "select count(*) from app.memberships m join app.companies c on c.id = m.company_id and c.status = 'active' where m.user_id = '$1' and m.status = 'active'"; }
expect "fixtures: removed U_X, absent U_O (no membership row at all) and suspended-only U_S hold no active membership in an active company; U_B (removed in G1, active in G2) and U_M2 hold one" \
  "$(standing "$U_X")|$(standing "$U_O")|$(sql -c "select count(*) from app.memberships where user_id='$U_O'")|$(standing "$U_S")|$(sql -c "select count(*) from app.memberships where user_id='$U_S' and status='active'")|$(standing "$U_B")|$(standing "$U_M2")" '^0|0|0|0|1|1|1$'
NREG="$(sql -c "select count(*) from app.gate_identities")"; NFILES="$(sql -c "select count(*) from app.gate_identity_files")"
expect "the registry the owner sees has rows to hide" "$NREG|$NFILES" '^[1-9][0-9]*|[1-9][0-9]*$'
registry_as() { sql_try -c "begin; select set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\"}', true); set local role authenticated; select 'REG|'||(select count(*) from api.gate_identities)||'|'||(select count(*) from api.gate_identity_files); rollback;"; }
expect "a removed reader with no active membership reads zero identity rows and zero file rows" "$(registry_as "$U_X")" 'REG|0|0$'
expect "a reader with no membership at all reads zero and zero" "$(registry_as "$U_O")" 'REG|0|0$'
expect "a member of only a suspended company reads zero and zero" "$(registry_as "$U_S")" 'REG|0|0$'
expect "an active member reads every identity row and every file row" "$(registry_as "$U_M2")" "REG|$NREG|$NFILES\$"
expect "control: removed in one company and active in another still reads them (at least one active membership)" "$(registry_as "$U_B")" "REG|$NREG|$NFILES\$"
r="$(rest GET "/gate_identities?select=id" "$X_JWT")"; expect "through PostgREST, the removed member's own JWT: no identity" "$r" '^HTTP 200 \[\]'
r="$(rest GET "/gate_identity_files?select=path" "$X_JWT")"; expect "through PostgREST, the removed member's own JWT: no file list" "$r" '^HTTP 200 \[\]'
r="$(rest GET "/gate_identity_files?select=path" "$S_JWT")"; expect "through PostgREST, the suspended-only member's JWT: no file list" "$r" '^HTTP 200 \[\]'
r="$(rest GET "/gate_identity_files?select=path" "$M2_JWT")"; expect "through PostgREST, an active member reads the file list" "$r" '"path":"lib/passport/gate.mjs"'
expect "no registry policy for authenticated reads using (true)" "$(sql -c "select count(*) from pg_policies where schemaname='app' and tablename in ('gate_identities','gate_identity_files') and 'authenticated' = any (roles) and qual = 'true'")" '^0$'
sql -c "grant app_maintenance to postgres" >/dev/null
r="$(sql_try -c "begin; set local role app_maintenance; select 'MAINT_REG|'||(select count(*) from app.gate_identities)||'|'||(select count(*) from app.gate_identity_files); rollback;")"
expect "app_maintenance keeps its select on both" "$r" "MAINT_REG|$NREG|$NFILES\$"
sql -c "revoke app_maintenance from postgres" >/dev/null
expect "the grant: authenticated may execute app.is_active_member_anywhere()" "$(sql_try -c "select has_function_privilege('authenticated','app.is_active_member_anywhere()','execute')")" '^t$'
r="$(sql_try -c "begin; revoke execute on function app.is_active_member_anywhere() from authenticated; select set_config('request.jwt.claims', '{\"sub\":\"$U_M2\",\"role\":\"authenticated\"}', true); set local role authenticated; select 'M1|'||count(*) from api.gate_identities; rollback;")"
expect "fail-before (M1): without that grant an active member's registry read fails inside the policy" "$r" 'permission denied for function is_active_member_anywhere'
r="$(sql_try -c "begin; drop policy gate_identities_read on app.gate_identities; drop policy gate_identity_files_read on app.gate_identity_files;
  create policy gate_identities_read on app.gate_identities for select to authenticated using (true);
  create policy gate_identity_files_read on app.gate_identity_files for select to authenticated using (true);
  select set_config('request.jwt.claims', '{\"sub\":\"$U_X\",\"role\":\"authenticated\"}', true); set local role authenticated;
  select 'OPEN|'||(select count(*) from api.gate_identities)||'|'||(select count(*) from api.gate_identity_files); rollback;")"
expect "fail-before (F3): under the sketch's using (true) the same removed reader reads every row (then rolled back)" "$r" "OPEN|$NREG|$NFILES\$"
expect "real, after that rollback: the removed reader reads zero and zero again" "$(registry_as "$U_X")" 'REG|0|0$'

printf '%s\n' "G1=$G1" "G2=$G2" "U_M=$U_M" "U_R=$U_R" "U_A=$U_A" "D1=$D1" "S1=$S1" "S2=$S2" "AGENT=$AGENT" > "$ROOT/.scratch/e2/e3-12.env"
[ "$FAILED" = 0 ] && echo "12 PASS" || { echo "12 FAIL"; exit 1; }
