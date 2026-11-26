#!/usr/bin/env bash
# E3 probe 13: the triggers and the audit allowlist (docs/e3/design.md 1.3, 2.3, 2.4, 4.2; section 6 cases 6, 7,
# 9, 15, 26, 27, 36), and the registry the first pin wrote (design 2.7). Owner-side statements, each refusal in a
# transaction that is rolled back unless the probe needs its row; every control's fail-before is shown against a
# mutant made from the live definition (pg_get_functiondef) or with the trigger disabled, inside a rolled-back
# transaction. Builds its own company. Run: bash tests/db/13-content-triggers.sh (after tests/db/00-seed.sh).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"
export API_URL ANON_KEY JWT_SECRET
E3() { node "$ROOT/tests/db/e3.mjs" "$@"; }
RUN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(3).toString("hex"))')"
PW13='Synthetic-Pass-1234'
OPJWT="$(server_jwt "$U_op" aal2)"
iso_ago() { node -e "process.stdout.write(new Date(Date.now() - $1 * 1000).toISOString())"; }
first() { printf '%s\n' "$1" | head -1; }

section "13 setup: one company, its admin and a member, an agent, the active gate row"
U_A="$(create_user "e3-13-$RUN-admin@example.invalid" "$PW13")"
U_M="$(create_user "e3-13-$RUN-member@example.invalid" "$PW13")"
G="$(rest POST /rpc/provision_company "$OPJWT" "{\"p_slug\":\"e3-13-$RUN\",\"p_name\":\"SYNTHETIC E3 13\",\"p_first_admin_user\":\"$U_A\"}" | sed -n 's/.*"company_id":"\([^"]*\)".*/\1/p')"
sql -c "insert into app.memberships (company_id, user_id, roles) values ('$G','$U_M','{member}')" >/dev/null
M_MS="$(sql -c "select id from app.memberships where company_id='$G' and user_id='$U_M'")"
A_MS="$(sql -c "select id from app.memberships where company_id='$G' and user_id='$U_A'")"
GATE_ID="$(sql -c "select id from app.gate_identities where active")"
AGENT="$(first "$(sql -c "insert into app.agents (company_id, name, creator_membership_id, owner_membership_id) values ('$G','p13-$RUN','$M_MS','$M_MS') returning id")")"
expect "setup ids" "$G|$M_MS|$GATE_ID|$AGENT" '^[0-9a-f-]\{36\}|[0-9a-f-]\{36\}|[0-9a-f-]\{36\}|[0-9a-f-]\{36\}$'
COLS="company_id, agent_id, sequence, author_membership_id, content, derived_canonical, gate_id, attested_by"
vals() { printf "'%s','%s',%s,'%s',%s,%s,'%s','%s'" "$G" "$AGENT" "$1" "$M_MS" "$(E3 literal content --revision "$2")" "$(E3 literal derived --revision "$2" ${3:+--validated-at "$3"})" "$GATE_ID" "$M_MS"; }
insert_draft() { first "$(sql -c "insert into app.candidate_versions ($COLS) values ($(vals "$1" "$2")) returning id")"; }

section "13a the registry the first pin wrote is self-consistent and is the committed manifest"
CODE_ID="$(node --input-type=module -e "import { GATE_IDENTITY_SHA256 } from '$ROOT/lib/passport/gate-manifest.mjs'; process.stdout.write(GATE_IDENTITY_SHA256)")"
expect "exactly one active identity, and it is lib/passport/gate-manifest.mjs GATE_IDENTITY_SHA256" "$(sql -c "select count(*)||'|'||string_agg(encode(identity_sha256,'hex'),',') from app.gate_identities where active")" "^1|$CODE_ID\$"
expect "identity_sha256 reproduces from its three components in SQL" "$(sql -c "select sha256(convert_to(encode(adapter_lock_sha256,'hex')||E'\n'||validator_version||E'\n'||encode(manifest_sha256,'hex'),'UTF8')) = identity_sha256 from app.gate_identities where active")" '^t$'
expect "manifest_sha256 reproduces from the registered file rows, ordered by path in C collation" "$(sql -c "select sha256(convert_to(string_agg(f.path||E'\n'||encode(f.sha256,'hex')||E'\n', '' order by f.path collate \"C\"),'UTF8')) = g.manifest_sha256 from app.gate_identities g join app.gate_identity_files f on f.gate_id = g.id where g.active group by g.manifest_sha256")" '^t$'
expect "one gate.register audit row names it" "$(sql -c "select count(*) from app.audit_events where action='gate.register' and details->>'gate_identity_sha256' = '$CODE_ID'")" '^1$'
r="$(sql_try -c "begin; insert into app.gate_identities (identity_sha256, adapter_lock_sha256, validator_version, manifest_sha256, upstream_commit, active) values (sha256('x'), sha256('y'), '0.1.0', sha256('z'), repeat('a', 40), true); rollback;")"
expect "a second active identity is refused by the partial unique index" "$r" 'gate_identities_one_active'

section "13b case 7: the trigger overwrites supplied hashes and a supplied validated_at from the row's own bytes"
NODE_SHA="$(E3 literal hex content_sha256 --revision 7)"
r="$(sql -c "insert into app.candidate_versions ($COLS, content_sha256, derived_sha256, validated_at) values ($(vals 1 7), '\\xdeadbeef', '\\xdeadbeef', '2000-01-01T00:00:00Z')
  returning encode(content_sha256,'hex')||'|'||(derived_sha256 = sha256(convert_to(derived_canonical,'UTF8')))||'|'||(validated_at = (derived_canonical::jsonb->>'validated_at')::timestamptz)||'|'||id")"
expect "content_sha256 is Node's hash of the same bytes, derived_sha256 and validated_at are the row's own" "$(first "$r")" "^$NODE_SHA|true|true|"
C7="$(first "$r" | cut -d'|' -f4)"
r="$(sql -c "update app.candidate_versions set content_sha256 = '\\xdeadbeef', derived_sha256 = '\\x00', validated_at = now() where id='$C7' returning encode(content_sha256,'hex')")"
expect "an owner-side UPDATE of a draft's hashes is recomputed too" "$(first "$r")" "^$NODE_SHA\$"
r="$(sql_try -c "begin; alter table app.candidate_versions disable trigger candidate_2_identity;
  insert into app.candidate_versions ($COLS, content_sha256, derived_sha256, validated_at) values ($(vals 2 7), '\\xdeadbeef', '\\xdeadbeef', '2000-01-01T00:00:00Z')
  returning 'MUTANT|'||encode(content_sha256,'hex')||'|'||validated_at; rollback;")"
expect "fail-before: with the identity trigger disabled the supplied hash and time are stored as given" "$r" 'MUTANT|deadbeef|2000-01-01'

section "13c case 9: owner-side content the trigger refuses, with a code and no row echo"
CONTENT7="$(E3 literal content --revision 7)"
try_content() { sql_try -c "begin; insert into app.candidate_versions ($COLS) values ('$G','$AGENT',50,'$M_MS',$1,$(E3 literal derived --revision 9),'$GATE_ID','$M_MS'); rollback;"; }
r="$(try_content "replace($CONTENT7, 'It runs', 'It'||chr(13)||'runs')")"; expect "a carriage return: E_CANONICAL" "$r" 'E_CANONICAL'
expect "and no row is echoed" "$(printf '%s' "$r" | grep -c 'Failing row')" '^0$'
r="$(try_content "replace($CONTENT7, '<!-- installer core and branches inserted on upload -->', 'no placeholder')")"; expect "no installer placeholder: E_BODY_INVALID" "$r" 'E_BODY_INVALID'
r="$(try_content "$CONTENT7 || repeat('x', 262145 - octet_length($CONTENT7))")"; expect "262,145 bytes: E_BODY_INVALID" "$r" 'E_BODY_INVALID'
r="$(try_content "left($CONTENT7, 511)")"; expect "511 bytes: E_BODY_INVALID" "$r" 'E_BODY_INVALID'
r="$(try_content "replace($CONTENT7, 'It runs', 'It'||chr(1)||'runs')")"; expect "a C0 control: E_BODY_INVALID" "$r" 'E_BODY_INVALID'
r="$(try_content "$CONTENT7 || repeat('x', 262144 - octet_length($CONTENT7))")"; expect "control: exactly 262,144 bytes inserts" "$r" 'INSERT 0 1'
r="$(sql_try -c "begin; alter table app.candidate_versions disable trigger candidate_2_identity; insert into app.candidate_versions ($COLS, content_sha256, derived_sha256, validated_at) values ('$G','$AGENT',51,'$M_MS',replace($CONTENT7, 'It runs', 'It'||chr(13)||'runs'),$(E3 literal derived --revision 9),'$GATE_ID','$M_MS', sha256('a'), sha256('b'), now()); rollback;")"
expect "defense in depth, with the trigger disabled the CHECK still refuses the carriage return" "$r" 'candidate_versions_content_check'
expect "and that last resort echoes the row, which is why the trigger refuses first" "$r" 'Failing row contains'

section "13d case 36 fixtures: two submitted candidates attested a day ago (built with triggers off, hashes computed)"
DAY="$(iso_ago 86400)"
frozen() { # sequence revision
  first "$(sql -c "begin; alter table app.candidate_versions disable trigger candidate_2_identity;
    insert into app.candidate_versions ($COLS, content_sha256, derived_sha256, validated_at, attested_at, state, submitted_at, submitted_by_membership_id, source_platform, confidence, permitted_data, dependencies)
    select c.company_id, c.agent_id, c.sequence, c.author_membership_id, c.content, c.derived_canonical, c.gate_id, c.attested_by,
           sha256(convert_to(c.content,'UTF8')), sha256(convert_to(c.derived_canonical,'UTF8')), (c.derived_canonical::jsonb->>'validated_at')::timestamptz,
           now() - interval '1 day', 'submitted', now() - interval '1 day', c.author_membership_id, 'synthetic', 'high', 'synthetic only', '{}'
      from (select '$G'::uuid company_id, '$AGENT'::uuid agent_id, $1 sequence, '$M_MS'::uuid author_membership_id,
                   $(E3 literal content --revision "$2") content, $(E3 literal derived --revision "$2" --validated-at "$DAY") derived_canonical,
                   '$GATE_ID'::uuid gate_id, '$M_MS'::uuid attested_by) c
    returning id; alter table app.candidate_versions enable trigger candidate_2_identity; commit;" | grep -E '^[0-9a-f-]{36}$')"
}
F1="$(frozen 10 10)"; F2="$(frozen 11 11)"
expect "two day-old submitted fixtures" "$(sql -c "select count(*) from app.candidate_versions where id in ('$F1','$F2') and state='submitted' and validated_at < now() - interval '23 hours'")" '^2$'
snap() { sql -c "select md5(validated_at::text||encode(content_sha256,'hex')||encode(derived_sha256,'hex')||derived_canonical) from app.candidate_versions where id='$1'"; }

section "13e case 36 fail-before (H4): a freshness window on every update refuses a state-only update of a frozen row"
DEF="$(sql -c "select pg_get_functiondef('app.candidate_identity()'::regprocedure)")"
MUT_IDENTITY="${DEF/if tg_op = \'INSERT\' or new.derived_canonical is distinct from old.derived_canonical then/if true then}"
expect "the mutant differs from the live definition only by the condition" "$( [ "$MUT_IDENTITY" != "$DEF" ] && echo changed || echo same)" '^changed$'
r="$(printf 'begin;\n%s;\nupdate app.candidate_versions set state = %s where id = %s;\nrollback;\n' "$MUT_IDENTITY" "'changes_requested'" "'$F1'" | sql_try)"
expect "mutant: E_CLOCK on the state-only review a day later" "$r" 'E_CLOCK'

section "13f case 36: over sequences design 4.2 permits, state-only updates of frozen rows keep the attestation byte-identical"
B1="$(snap "$F1")"; B2="$(snap "$F2")"
r="$(sql_try -c "update app.candidate_versions set state='changes_requested' where id='$F1'")"; expect "F1 submitted to changes_requested, a day after attestation" "$r" 'UPDATE 1'
r="$(sql_try -c "update app.candidate_versions set state='approved' where id='$F2'")"; expect "F2 submitted to approved" "$r" 'UPDATE 1'
r="$(sql_try -c "update app.candidate_versions set state='superseded' where id='$F2'")"; expect "F2 approved to superseded" "$r" 'UPDATE 1'
expect "F1 validated_at, both hashes and derived_canonical unchanged" "$(snap "$F1")" "^$B1\$"
expect "F2 validated_at, both hashes and derived_canonical unchanged" "$(snap "$F2")" "^$B2\$"
r="$(sql_try -c "update app.candidate_versions set state='approved' where id='$F1'")"; expect "the forbidden changes_requested to approved edge is still refused" "$r" 'E_STATE_TRANSITION'
D36="$(insert_draft 12 12)"
HOUR="$(iso_ago 3600)"
r="$(sql_try -c "update app.candidate_versions set derived_canonical = $(E3 literal derived --revision 12 --validated-at "$HOUR") where id='$D36'")"; expect "a draft given a new attestation an hour old: E_CLOCK" "$r" 'E_CLOCK'
r="$(sql_try -c "update app.candidate_versions set derived_canonical = $(E3 literal derived --revision 12) where id='$D36'")"; expect "control: the same draft with a current attestation updates" "$r" 'UPDATE 1'
r="$(sql_try -c "begin; update app.candidate_versions set derived_canonical = '{\"validated_at\":\"now\"}' where id='$D36'; rollback;")"; expect "validated_at in a shape derive() never stamps: E_DERIVED_INVALID" "$r" 'E_DERIVED_INVALID'
r="$(sql_try -c "begin; update app.candidate_versions set derived_canonical = 'not json' where id='$D36'; rollback;")"; expect "derived_canonical that is not JSON: E_DERIVED_INVALID" "$r" 'E_DERIVED_INVALID'

section "13g case 6: the immutable envelope, the reset, the delete, and the author of a draft"
S6="$(insert_draft 13 13)"
sql -c "insert into app.candidate_contributors (candidate_id, membership_id, kind, observed) values ('$S6','$M_MS','author',true)" >/dev/null
sql -c "update app.candidate_versions set state='submitted', submitted_at=now(), submitted_by_membership_id='$M_MS', source_platform='synthetic', confidence='high', permitted_data='synthetic only', dependencies='{}' where id='$S6'" >/dev/null
expect "S6 submitted through the permitted draft to submitted edge" "$(sql -c "select state from app.candidate_versions where id='$S6'")" '^submitted$'
r="$(sql_try -c "begin; update app.candidate_versions set content = content || ' ' where id='$S6'; rollback;")"; expect "content of a submitted row: E_IMMUTABLE" "$r" 'E_IMMUTABLE'
r="$(sql_try -c "begin; update app.candidate_versions set state = 'draft' where id='$S6'; rollback;")"; expect "back to draft: E_STATE_RESET" "$r" 'E_STATE_RESET'
r="$(sql_try -c "begin; delete from app.candidate_versions where id='$S6'; rollback;")"; expect "DELETE: E_CANDIDATE_DELETE" "$r" 'E_CANDIDATE_DELETE'
r="$(sql_try -c "begin; truncate app.candidate_versions cascade; rollback;")"; expect "TRUNCATE: E_CANDIDATE_DELETE" "$r" 'E_CANDIDATE_DELETE'
r="$(sql_try -c "begin; update app.candidate_versions set author_membership_id = '$A_MS' where id='$D36'; rollback;")"; expect "author_membership_id of a draft: E_IMMUTABLE" "$r" 'E_IMMUTABLE'
r="$(sql_try -c "begin; update app.candidate_versions set supersedes_candidate_id = '$S6' where id='$D36'; rollback;")"; expect "supersedes_candidate_id of a draft: E_IMMUTABLE" "$r" 'E_IMMUTABLE'
r="$(sql_try -c "begin; alter table app.candidate_versions disable trigger candidate_1_immutable; update app.candidate_versions set content = replace(content, 'Revision 13.', 'Revision 99.') where id='$S6' returning 'MUTANT|'||state; rollback;")"
expect "fail-before: with the immutability trigger disabled a submitted row's content changes" "$r" 'MUTANT|submitted'
r="$(E3 call save_draft "$U_M" "{\"candidate_id\":\"$D36\",\"expected_version\":1,\"content\":\"@content\",\"derived_canonical\":\"@derived\",\"gate_identity\":\"@gate\",\"idempotency_key\":\"@uuid\"}" --revision 14)"
expect "control: an ordinary draft save through the routine" "$r" 'HTTP 200 .*"version": *2'

section "13h case 26: every envelope column, one at a time, after submission; the same on a draft"
NEW_DERIVED="$(E3 literal derived --revision 13)"
for set in "content = content || ' '" "content_sha256 = '\\x00'" "derived_canonical = $NEW_DERIVED" "derived_sha256 = '\\x00'" \
           "gate_id = gen_random_uuid()" "validated_at = now()" "attested_by = '$A_MS'" "attested_at = now()" \
           "submitted_at = now() + interval '1 second'" "submitted_by_membership_id = '$A_MS'" "source_platform = 'other'" \
           "confidence = 'low'" "permitted_data = 'other'" "dependencies = '{files.read}'"; do
  col="${set%% =*}"
  r="$(sql_try -c "begin; update app.candidate_versions set $set where id='$S6'; rollback;")"; expect "submitted: $col refused E_IMMUTABLE" "$r" 'E_IMMUTABLE'
done
for set in "content = content || ' '" "content_sha256 = '\\x00'" "derived_canonical = $NEW_DERIVED" "derived_sha256 = '\\x00'" \
           "validated_at = now()" "attested_by = '$A_MS'" "attested_at = now()" "source_platform = 'other'" \
           "confidence = 'low'" "permitted_data = 'other'" "dependencies = '{files.read}'"; do
  col="${set%% =*}"
  r="$(sql_try -c "begin; update app.candidate_versions set $set where id='$D36'; rollback;")"; expect "control, draft: $col updates" "$r" 'UPDATE 1'
done
echo "note: gate_id, submitted_at and submitted_by_membership_id have no draft control: a draft cannot carry a submission (candidate_submitted_state), and gate_id must name a registered identity"

section "13i case 27: contributors freeze with their candidate"
r="$(sql_try -c "begin; insert into app.candidate_contributors (candidate_id, kind, display_name, observed) values ('$S6','declared_offline','Late Name',false); rollback;")"; expect "INSERT on a submitted candidate: E_CONTRIBUTORS_FROZEN" "$r" 'E_CONTRIBUTORS_FROZEN'
r="$(sql_try -c "begin; update app.candidate_contributors set observed = true where candidate_id='$S6'; rollback;")"; expect "UPDATE on a submitted candidate: E_CONTRIBUTORS_FROZEN" "$r" 'E_CONTRIBUTORS_FROZEN'
r="$(sql_try -c "begin; delete from app.candidate_contributors where candidate_id='$S6'; rollback;")"; expect "DELETE on a submitted candidate: E_CONTRIBUTORS_FROZEN" "$r" 'E_CONTRIBUTORS_FROZEN'
r="$(sql_try -c "begin; update app.candidate_contributors set candidate_id='$D36' where candidate_id='$S6'; rollback;")"; expect "moving a frozen row onto a draft: E_CONTRIBUTORS_FROZEN" "$r" 'E_CONTRIBUTORS_FROZEN'
r="$(sql_try -c "begin; insert into app.candidate_contributors (candidate_id, kind, display_name, observed) values ('$D36','declared_offline','Draft Name',false); rollback;")"; expect "control: the same INSERT while draft" "$r" 'INSERT 0 1'
r="$(sql_try -c "begin; alter table app.candidate_contributors disable trigger contributors_frozen; insert into app.candidate_contributors (candidate_id, kind, display_name, observed) values ('$S6','declared_offline','Late Name',false); rollback;")"
expect "fail-before: with the freeze disabled the late contributor lands on the submitted candidate" "$r" 'INSERT 0 1'
echo "note: the routine path cannot reach a contributor write on a non-draft: submit_candidate refuses E_NOT_DRAFT before its inserts (tests/db/14)"

section "13i-F1 E3a critique F1: TRUNCATE cannot erase the contributors of frozen candidates"
# Row triggers do not fire on TRUNCATE. Before the statement trigger, one owner command erased every contributor of
# every submitted candidate while the candidates themselves stayed.
frozen_contributors() { sql -c "select count(*) from app.candidate_contributors k join app.candidate_versions v on v.id = k.candidate_id where v.state <> 'draft'"; }
FROZEN_K="$(frozen_contributors)"
expect "fixture: contributor rows exist on frozen candidates" "$FROZEN_K" '^[1-9][0-9]*$'
r="$(sql_try -c "begin; truncate app.candidate_contributors; select 'AFTER|'||count(*) from app.candidate_contributors; rollback;")"
expect "owner TRUNCATE of app.candidate_contributors: E_CANDIDATE_DELETE, as for candidate rows" "$r" 'E_CANDIDATE_DELETE'
expect "every contributor row on a frozen candidate is still there" "$(frozen_contributors)" "^$FROZEN_K\$"
r="$(sql_try -c "begin; alter table app.candidate_contributors disable trigger contributors_no_truncate; truncate app.candidate_contributors; select 'MUTANT|'||count(*) from app.candidate_contributors; rollback;")"
expect "fail-before (F1): with the TRUNCATE trigger disabled the owner's TRUNCATE erases them all (then rolled back)" "$r" 'MUTANT|0$'
expect "and the rollback restored them" "$(frozen_contributors)" "^$FROZEN_K\$"

section "13i-M E3a critique M-SQL: a contributor cannot move from a draft onto a submitted candidate"
# The frozen-to-draft direction is tested above; this is the other direction, which is the only thing that kills an
# INSERT-only NEW-parent check.
MOVE_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
MOVE="insert into app.candidate_contributors (id, candidate_id, kind, display_name, observed) values ('$MOVE_ID','$D36','declared_offline','SYNTHETIC moved name',false); update app.candidate_contributors set candidate_id='$S6' where id='$MOVE_ID';"
r="$(sql_try -c "begin; $MOVE rollback;")"; expect "moving a draft's contributor onto a submitted candidate: E_CONTRIBUTORS_FROZEN" "$r" 'E_CONTRIBUTORS_FROZEN'
FROZEN_MD5="$(sql -c "select md5(pg_get_functiondef('app.contributors_frozen()'::regprocedure))")"
DEF_FROZEN="$(sql -c "select pg_get_functiondef('app.contributors_frozen()'::regprocedure)")"
MUT_FROZEN="$(printf '%s' "$DEF_FROZEN" | E3_FROM="if tg_op in ('INSERT', 'UPDATE') then" E3_TO="if tg_op = 'INSERT' then" E3 mutate)"
expect "the mutant differs from the live definition by the NEW-parent condition" "$([ -n "$MUT_FROZEN" ] && [ "$MUT_FROZEN" != "$DEF_FROZEN" ] && echo changed)" '^changed$'
r="$(printf 'begin;\n%s;\n%s\nselect %s||count(*) from app.candidate_contributors where id = %s and candidate_id = %s;\nrollback;\n' "$MUT_FROZEN" "$MOVE" "'MUTANT|'" "'$MOVE_ID'" "'$S6'" | sql_try)"
expect "fail-before (M-SQL): with the NEW-parent check on INSERT only, the move lands on the submitted candidate (then rolled back)" "$r" 'MUTANT|1$'
r="$(sql_try -c "begin; $MOVE rollback;")"; expect "real, after that rollback: the same move is E_CONTRIBUTORS_FROZEN again" "$r" 'E_CONTRIBUTORS_FROZEN'
expect "the live trigger function is the one read before the mutant" "$(sql -c "select md5(pg_get_functiondef('app.contributors_frozen()'::regprocedure))")" "^$FROZEN_MD5\$"

section "13j case 15: the audit allowlist grows by shape only"
aud() { sql_try -c "begin; insert into app.audit_events (company_id, actor_kind, action, entity_type, details) values ('$G','system','probe.test','probe', '$1'::jsonb); rollback;"; }
r="$(aud '{"content":"SYNTHETIC passport prose"}')"; expect "a passport-text key: E_AUDIT_DETAILS_KEY" "$r" 'E_AUDIT_DETAILS_KEY content'
r="$(aud '{"display_name":"Jane Doe"}')"; expect "an offline contributor name: E_AUDIT_DETAILS_KEY" "$r" 'E_AUDIT_DETAILS_KEY display_name'
r="$(aud "{\"content_sha256\":\"$(printf 'a%.0s' $(seq 63))\"}")"; expect "a 63-hex hash: E_AUDIT_DETAILS_VALUE" "$r" 'E_AUDIT_DETAILS_VALUE content_sha256'
r="$(aud "{\"gate_identity_sha256\":\"$(printf 'A%.0s' $(seq 64))\"}")"; expect "an uppercase hash: E_AUDIT_DETAILS_VALUE" "$r" 'E_AUDIT_DETAILS_VALUE gate_identity_sha256'
r="$(aud '{"sequence":1.5}')"; expect "a non-integer sequence: E_AUDIT_DETAILS_VALUE" "$r" 'E_AUDIT_DETAILS_VALUE sequence'
r="$(aud '{"version":"3"}')"; expect "a version as a string: E_AUDIT_DETAILS_VALUE" "$r" 'E_AUDIT_DETAILS_VALUE version'
r="$(aud '{"status_after":"submitted"}')"; expect "a candidate state in status_after: E_AUDIT_DETAILS_VALUE" "$r" 'E_AUDIT_DETAILS_VALUE status_after'
r="$(aud '{"candidate_state_after":"published"}')"; expect "an unknown candidate state: E_AUDIT_DETAILS_VALUE" "$r" 'E_AUDIT_DETAILS_VALUE candidate_state_after'
r="$(aud '{"agent_status_after":"removed"}')"; expect "a membership status as an agent status: E_AUDIT_DETAILS_VALUE" "$r" 'E_AUDIT_DETAILS_VALUE agent_status_after'
r="$(aud '{"contributor_kind":"reviewer"}')"; expect "an unknown contributor kind: E_AUDIT_DETAILS_VALUE" "$r" 'E_AUDIT_DETAILS_VALUE contributor_kind'
r="$(aud "{\"candidate_id\":\"$S6\",\"agent_id\":\"$AGENT\",\"contributor_membership_id\":\"$M_MS\",\"supersedes_candidate_id\":\"$D36\",\"content_sha256\":\"$NODE_SHA\",\"derived_sha256\":\"$NODE_SHA\",\"gate_identity_sha256\":\"$CODE_ID\",\"sequence\":13,\"version\":2,\"candidate_state_after\":\"submitted\",\"agent_status_after\":\"orphaned\",\"contributor_kind\":\"declared_member\"}")"
expect "control: every E3 key with a well-shaped value" "$r" 'INSERT 0 1'
r="$(aud '{"reason_code":"replaced","roles":["member"],"changed":true}')"; expect "control: E2 keys keep their rules" "$r" 'INSERT 0 1'

[ "$FAILED" = 0 ] && echo "13 PASS" || { echo "13 FAIL"; exit 1; }
