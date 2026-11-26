#!/usr/bin/env bash
# Probe 24: publication and withdrawal at the routine level (docs/e4/design.md 1.3, 1.4, 3.2, 3.3 and 3.5; section 5
# cases 25, 34, 37, 38, 39, 40 and 51, and case 20's routine half, whose service half is tests/e4/stack).
#   24a case 25 B1: no bytes and no hash of the caller's choosing; the honest round trip to the four golden hashes;
#       fail-before without the pre-insert hash comparison
#   24b case 20, routine half: an envelope under a retired identity; fail-before without the envelope-gate check
#   24c case 34: two admins publish one envelope with different keys at once
#   24d cases 37 and 38: withdrawal retries, and who may withdraw
#   24e case 39: what a withdrawal leaves untouched, and a republication
#   24f case 40: supersession across versions and targets; fail-before without the one-current index and supersession
#   24g case 51: a withdrawal held longer than app_server's lock_timeout by a share lock on the release row
# Every E4 call goes through PostgREST with a bearer and body built by lib/db/server.mjs (tests/db/e4.mjs). Run:
# bash tests/db/24-release-routines.sh (after tests/db/00-seed.sh and the probes before it).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
RUN="$(run_id)"; T="$E2_TMP/24"; mkdir -p "$T"
DL0="$(deadlocks)"
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
person() {
  local uid ms
  uid="$(create_user "e4-24-$RUN-$(printf '%s' "$1" | tr 'A-Z_' 'a-z-')@example.invalid" "$E4_PW")"
  ms="$(member "$2" "$uid" "$3")"
  eval "U_$1=$uid; MS_$1=$ms"
}
snap() { sql -c "select (select count(*) from app.review_envelopes) || '|' || (select count(*) from app.reviews) || '|' || (select count(*) from app.releases) || '|' || (select count(*) from app.audit_events) || '|' || (select count(*) from app.idempotency_keys) || '|' || (select count(*) from app.release_downloads)"; }
refused() { # label pattern command...
  local before r
  before="$(snap)"
  r="$("${@:3}")"
  expect "$1" "$r" "$2"
  expect "$1: no row, no audit row, no claim" "$(snap)" "^$before\$"
}
env_of() { field "$(envelope "$@")" envelope_id; }
approve_both() {
  expect "IT approves $2" "$(review "$U_I" "$1" "$2" it approved "IT: fine.")" 'HTTP 200'
  expect "business approves $2" "$(review "$U_B" "$1" "$2" business approved "Business: fine.")" 'HTTP 200'
}
publish_sub() { publish "$1" "$2" "$3" "$(expected_sha "$2" "$4")" @uuid --aal aal2; } # sub candidate envelope target
# released author name revision target: a submitted, approved and published candidate; prints candidate|envelope|release.
released() {
  local c e r
  c="$(submitted "$1" "$G" "$2" "$3")"
  e="$(env_of "$1" "$c" "$4" "$AUD")"
  approve_both "$c" "$e" >/dev/null
  r="$(field "$(publish_sub "$U_A" "$c" "$e" "$4")" release_id)"
  printf '%s|%s|%s' "$c" "$e" "$r"
}

section "24 setup: company G (admins A and A2, author M, IT I, business B, members O and Q), company H; the audience group; all four targets enabled"
U_A="$(create_user "e4-24-$RUN-a@example.invalid" "$E4_PW")"; G="$(company "e4-24g-$RUN" "$U_A")"; MS_A="$(membership_of "$G" "$U_A")"
U_HA="$(create_user "e4-24-$RUN-ha@example.invalid" "$E4_PW")"; H="$(company "e4-24h-$RUN" "$U_HA")"
person A2 "$G" '{company_admin,member}'
person M "$G" '{member}'
person I "$G" '{it_reviewer,member}'
person B "$G" '{business_reviewer,member}'
person O "$G" '{member}'
person Q "$G" '{member}'
GR="$(group_of "$G" "$MS_A" "Audience-$RUN" "$MS_M" "$MS_Q")"; GR2="$(group_of "$G" "$MS_A" "Wider-$RUN" "$MS_O")"
AUD="$(audience "$GR")"; AUDW="$(audience "$GR" "$GR2")"
for t in chatgpt claude-ai claude-code generic; do enable_target "$t"; done
echo "note: owner-side setup: every target enabled under the registry bypass"
echo "note: E5 design 2.7: every download below is api.authorize_download under that member own server bearer"

section "24a case 25 B1: arbitrary bytes with a matching hash"
node --input-type=module -e "
  const [root, company, membership, run] = process.argv.slice(1);
  const { readText } = await import(root + '/lib/passport/assemble.mjs');
  const { gate } = await import(root + '/lib/passport/gate.mjs');
  const fixture = readText(root + '/tests/native-transfer/passport/fixtures/SYNTHETIC-passport.md');
  const g = gate(Buffer.from(fixture, 'utf8'), 'text/markdown', { validatedAt: new Date().toISOString() });
  if (!g.ok || g.text !== fixture) throw new Error('the fixture does not pass the gate unchanged');
  const tag = (name, s) => { const t = String.fromCharCode(36) + name + String.fromCharCode(36); if (s.includes(t)) throw new Error('tag'); return t + s + t; };
  process.stdout.write(\"with a as (insert into app.agents (company_id, name, creator_membership_id, owner_membership_id) values ('\" + company + \"', 'synthetic-\" + run + \"', '\" + membership + \"', '\" + membership + \"') returning id) insert into app.candidate_versions (company_id, agent_id, sequence, author_membership_id, content, derived_canonical, gate_id, attested_by) select '\" + company + \"', a.id, 1, '\" + membership + \"', \" + tag('e4c', g.text) + ', ' + tag('e4d', g.derivedCanonical) + \", (select id from app.gate_identities where active), '\" + membership + \"' from a returning id;\n\");
" "$ROOT" "$G" "$MS_M" "$RUN" > "$T/synthetic.sql"
SYN="$(first "$(sql < "$T/synthetic.sql")")"
sql -c "insert into app.candidate_contributors (candidate_id, membership_id, kind, observed) values ('$SYN', '$MS_M', 'author', true); update app.candidate_versions set state = 'submitted', submitted_at = clock_timestamp(), submitted_by_membership_id = '$MS_M' where id = '$SYN';" >/dev/null
echo "note: owner-side, the SYNTHETIC fixture stored byte for byte as M's submitted candidate, gated unchanged"
ESYN="$(env_of "$U_M" "$SYN" claude-ai "$AUD")"
approve_both "$SYN" "$ESYN"
r="$(rest POST /rpc/publish_release "$(server_jwt "$U_A" aal2)" "$(jbody p_candidate="$SYN" p_envelope="$ESYN" p_assembled_content=arbitrary p_expected_assembled_sha256=x p_gate_identity=x p_idempotency_key="$(uuid)")")"
expect "case 25: a call carrying p_assembled_content matches no signature: PGRST202" "$r" 'PGRST202'
WRONG="$(printf 'ab%.0s' $(seq 32))"
r="$(publish "$U_A" "$SYN" "$ESYN" "$WRONG" @uuid --aal aal2)"
expect "case 25: a correct envelope with a wrong expected hash: E_ASSEMBLY_DIVERGED under P0004" "$r" '"code":"P0004".*E_ASSEMBLY_DIVERGED\|E_ASSEMBLY_DIVERGED.*"code":"P0004"'
MAPPED="$(printf '%s' "$r" | node --input-type=module -e "
  import { fromPostgrest, errorBody } from '$ROOT/lib/errors.mjs';
  let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => {
    const e = fromPostgrest({ status: Number(s.split(' ')[1]), body: JSON.parse(s.slice(s.indexOf(' ', 5) + 1)) });
    console.log('MAPPED', e.status, JSON.stringify(errorBody(e.code)));
  });")"
expect "mapped by the real lib/errors.mjs to 500, the code kept, no database text" "$MAPPED" 'MAPPED 500 {"ok":false,"code":"E_ASSEMBLY_DIVERGED","message":"Internal error."}'
S25="$(snap)"
refused "case 25: and nothing is written" 'E_ASSEMBLY_DIVERGED' publish "$U_A" "$SYN" "$ESYN" "$WRONG" @uuid --aal aal2
MUT25="$(mutant 'api.publish_release(uuid,uuid,bytea,bytea,uuid)' "if assembled_hash is distinct from p_expected_assembled_sha256 then" "if false then")"
expect "case 25 fail-before: without the pre-insert comparison the wrong expected hash publishes" "$(in_rollback "$MUT25;" "$(E4MODE=sql publish "$U_A" "$SYN" "$ESYN" "$WRONG" @uuid --aal aal2)")" '"release_id"'
for target in chatgpt claude-ai claude-code generic; do
  [ "$target" = claude-ai ] && e="$ESYN" || { e="$(env_of "$U_M" "$SYN" "$target" "$AUD")"; approve_both "$SYN" "$e" >/dev/null; }
  node_sha="$(expected_sha "$SYN" "$target")"
  r="$(publish "$U_A" "$SYN" "$e" "$node_sha" @uuid --aal aal2)"
  eval "GOLDEN_$(printf '%s' "$target" | tr '-' '_')=\"\$(field \"\$r\" assembled_sha256)|$node_sha\""
done
expect "case 25 honest round trip: chatgpt's release hash is the golden hash and Node's" "$GOLDEN_chatgpt" '^11070a1ffbdc39030b661cddc332b8b5594bb78d6ab3c137000739609743ad7a|11070a1ffbdc39030b661cddc332b8b5594bb78d6ab3c137000739609743ad7a$'
expect "claude-ai" "$GOLDEN_claude_ai" '^8e686b27e554e35af47af16a20cc24b48ae40323b4f5bcf37d64192f8b30e761|8e686b27e554e35af47af16a20cc24b48ae40323b4f5bcf37d64192f8b30e761$'
expect "claude-code" "$GOLDEN_claude_code" '^5cdaf5c50d37c355c086f9f05aec2b810de10f109d0d1464682d4f13c85a3dff|5cdaf5c50d37c355c086f9f05aec2b810de10f109d0d1464682d4f13c85a3dff$'
expect "generic" "$GOLDEN_generic" '^d558746392a835f3da4c4a779616761a8e0dba9157962d7da22d772e5d28546d|d558746392a835f3da4c4a779616761a8e0dba9157962d7da22d772e5d28546d$'
expect "four current releases of one candidate, one per target (1.3 rule 3)" "$(sql -c "select count(*) from app.releases where candidate_id = '$SYN' and state = 'published' and superseded_by_release_id is null")" '^4$'
expect "each row's assembled_sha256 is its own content's, by trigger" "$(sql -c "select bool_and(assembled_sha256 = sha256(convert_to(assembled_content, 'UTF8')) and assembled_bytes = octet_length(assembled_content)) from app.releases where candidate_id = '$SYN'")" '^t$'

section "24b case 20, routine half: an envelope approved under a retired identity cannot publish"
C20="$(submitted "$U_M" "$G" "c20-$RUN" 20)"; E20="$(env_of "$U_M" "$C20" claude-ai "$AUD")"
approve_both "$C20" "$E20"
NEW="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update("e4-24 probe identity").digest("hex"))')"
ROT="set local app.registry_migration = 'on'; update app.gate_identities set active = false where active; insert into app.gate_identities (identity_sha256, adapter_lock_sha256, validator_version, manifest_sha256, upstream_commit, active) values (decode('$NEW', 'hex'), sha256('lock'), '0.1.0', sha256('manifest'), repeat('c', 40), true);"
X20="$(expected_sha "$C20" claude-ai)"
expect "case 20: the server on the new identity publishes an envelope under the old one: E_ADAPTER_CHANGED" "$(in_rollback "$ROT" "$(E4MODE=sql publish "$U_A" "$C20" "$E20" "$X20" @uuid --aal aal2 --gate "$NEW")")" 'E_ADAPTER_CHANGED'
expect "case 20: the server still on the old identity after the rotation: E_GATE_UNREGISTERED" "$(in_rollback "$ROT" "$(E4MODE=sql publish "$U_A" "$C20" "$E20" "$X20" @uuid --aal aal2)")" 'E_GATE_UNREGISTERED'
MUT20="$(mutant 'api.publish_release(uuid,uuid,bytea,bytea,uuid)' "if env.gate_id is distinct from gate then" "if false then")"
expect "case 20 fail-before: without the envelope-gate check the old envelope publishes under the new identity" "$(in_rollback "$ROT" "$MUT20;" "$(E4MODE=sql publish "$U_A" "$C20" "$E20" "$X20" @uuid --aal aal2 --gate "$NEW")")" '"release_id"'
echo "note: case 20's control, a new envelope under the new identity through the service replay, is tests/e4/stack"

section "24c case 34: two admins publish one envelope with different keys at once"
C34="$(submitted "$U_M" "$G" "c34-$RUN" 34)"; E34="$(env_of "$U_M" "$C34" claude-ai "$AUD")"
approve_both "$C34" "$E34"; X34="$(expected_sha "$C34" claude-ai)"
DL34="$(deadlocks)"; AUD34="$(sql -c "select count(*) from app.audit_events where action = 'release.publish'")"
hold_company "$G" 2; sleep 0.3
publish "$U_A" "$C34" "$E34" "$X34" @uuid --aal aal2 > "$T/pub34a" &
publish "$U_A2" "$C34" "$E34" "$X34" @uuid --aal aal2 > "$T/pub34b" &
wait
expect "case 34: one 201 and one 200 with existing true" "$(grep -c '"existing": *false' "$T/pub34a" "$T/pub34b" | awk -F: '{s+=$2} END {print s}')|$(grep -c '"existing": *true' "$T/pub34a" "$T/pub34b" | awk -F: '{s+=$2} END {print s}')" '^1|1$'
expect "case 34: one release row and one release.publish audit row" "$(sql -c "select count(*) from app.releases where envelope_id = '$E34'")|$(( $(sql -c "select count(*) from app.audit_events where action = 'release.publish'") - AUD34 ))" '^1|1$'
expect "case 34: both answers name the same release" "$(field "$(cat "$T/pub34a")" release_id)" "^$(field "$(cat "$T/pub34b")" release_id)\$"
expect "case 34: deadlocks unchanged" "$(deadlocks)" "^$DL34\$"
INS34="insert into app.releases (company_id, agent_id, candidate_id, envelope_id, target, gate_id, content_sha256, derived_sha256, installer_text_sha256, core_sha256, branch_sha256, judge_sha256, policy_id, policy_sha256, audience_group_ids, envelope_sha256, assembled_content, published_by_membership_id) select e.company_id, e.agent_id, e.candidate_id, e.id, e.target, e.gate_id, e.content_sha256, e.derived_sha256, e.installer_text_sha256, e.core_sha256, e.branch_sha256, e.judge_sha256, e.policy_id, e.policy_sha256, e.audience_group_ids, e.envelope_sha256, replace(v.content, app.installer_placeholder(), i.text), '$MS_A' from app.review_envelopes e join app.candidate_versions v on v.id = e.candidate_id join app.installer_texts i on i.gate_id = e.gate_id and i.target = e.target where e.id = '$E34';"
expect "case 34 control: an owner-side second current row for the agent and target, identity checks passing, is refused by the partial unique index" "$(in_rollback "$INS34")" 'releases_one_current'

section "24d case 37: withdrawal retries"
REL="$(released "$U_M" "c37-$RUN" 37 claude-ai)"; IFS='|' read -r C37 E37 R37 <<< "$REL"
expect "a released candidate" "$R37" '^[0-9a-f-]\{36\}$'
AUDW37="$(sql -c "select count(*) from app.audit_events where action = 'release.withdraw' and entity_id = '$R37'")"
r="$(E4 call withdraw_release "$U_A" release_id="$R37" reason="Totals are misread." idempotency_key=@uuid --aal aal2 --save "$T/w37")"
expect "the withdrawal" "$r" '"state": *"withdrawn"'
expect "case 37: the same key replayed: the stored answer with idempotent_replay" "$(E4 replay "$T/w37")" '"idempotent_replay": *true'
expect "and no second audit row" "$(sql -c "select count(*) from app.audit_events where action = 'release.withdraw' and entity_id = '$R37'")" "^$((AUDW37 + 1))\$"
refused "case 37: a different key after withdrawal: E_ALREADY_WITHDRAWN" 'E_ALREADY_WITHDRAWN' withdraw "$U_A" "$R37" "Again." @uuid --aal aal2
REL="$(released "$U_M" "c37b-$RUN" 38 claude-ai)"; IFS='|' read -r C37B E37B R37B <<< "$REL"
DL37="$(deadlocks)"
hold_company "$G" 2; sleep 0.3
withdraw "$U_A" "$R37B" "First key." @uuid --aal aal2 > "$T/w37a" &
withdraw "$U_A2" "$R37B" "Second key." @uuid --aal aal2 > "$T/w37b" &
wait
expect "case 37: two concurrent withdrawals with different keys: one withdraws, the other E_ALREADY_WITHDRAWN" "$(cat "$T/w37a" "$T/w37b" | grep -c '"state": *"withdrawn"')|$(cat "$T/w37a" "$T/w37b" | grep -c 'E_ALREADY_WITHDRAWN')" '^1|1$'
expect "one state change, one audit row" "$(sql -c "select count(*) from app.audit_events where action = 'release.withdraw' and entity_id = '$R37B'")" '^1$'
expect "deadlocks unchanged" "$(deadlocks)" "^$DL37\$"

section "24d case 38: who may withdraw"
REL="$(released "$U_M" "c38a-$RUN" 40 claude-ai)"; IFS='|' read -r C38A E38A R38A <<< "$REL"
expect "case 38: an admin at aal2" "$(withdraw "$U_A" "$R38A" "Admin." @uuid --aal aal2)" '"state": *"withdrawn"'
REL="$(released "$U_M" "c38b-$RUN" 41 claude-ai)"; IFS='|' read -r C38B E38B R38B <<< "$REL"
refused "case 38: an admin at aal1 who is not the owner: E_ADMIN_MFA_REQUIRED" 'E_ADMIN_MFA_REQUIRED' withdraw "$U_A2" "$R38B" "Admin aal1." @uuid --aal aal1
refused "case 38: a reviewer who is neither admin nor owner: E_FORBIDDEN" 'E_FORBIDDEN' withdraw "$U_I" "$R38B" "Reviewer." @uuid --aal aal2
# E5 design 1.1 and 1.8 widened app.release_visible_to with the audience arm, so Q, a member of this release's audience,
# now reads it and meets the role refusal rather than the absence refusal. A member outside the audience still reads
# nothing and still meets E_NOT_FOUND, which is what this case is about; O is in the wider group only.
refused "case 38: a recipient who is not an admin and does not own the agent: E_FORBIDDEN" 'E_FORBIDDEN' withdraw "$U_Q" "$R38B" "Recipient." @uuid --aal aal2
refused "case 38: a member who cannot read the release: E_NOT_FOUND" 'E_NOT_FOUND' withdraw "$U_O" "$R38B" "Member." @uuid --aal aal2
refused "case 38: another company's admin: E_NOT_FOUND" 'E_NOT_FOUND' withdraw "$U_HA" "$R38B" "Outsider." @uuid --aal aal2
expect "case 38: the owner, an ordinary member, at aal1" "$(withdraw "$U_M" "$R38B" "Owner." @uuid --aal aal1)" '"state": *"withdrawn"'
REL="$(released "$U_A2" "c38c-$RUN" 42 claude-ai)"; IFS='|' read -r C38C E38C R38C <<< "$REL"
expect "case 38, section 4: an admin who owns the agent withdraws at aal1 by the owner branch" "$(withdraw "$U_A2" "$R38C" "Admin and owner." @uuid --aal aal1)" '"state": *"withdrawn"'
person OWN "$G" '{member}'
REL="$(released "$U_OWN" "c38d-$RUN" 43 claude-ai)"; IFS='|' read -r C38D E38D R38D <<< "$REL"
sql -c "update app.agents set owner_membership_id = '$MS_O' where id = (select agent_id from app.candidate_versions where id = '$C38D')" >/dev/null
echo "note: owner-side, the agent's owner moves from its author OWN to O (E6's transfer is the route)"
expect "the former owner removed" "$(rest POST /rpc/remove_member "$(server_jwt "$U_A" aal2)" "$(jbody p_membership="$MS_OWN")")" '"changed":true'
refused "case 38: the former owner after removal: E_NOT_FOUND" 'E_NOT_FOUND' withdraw "$U_OWN" "$R38D" "Former owner." @uuid --aal aal1

section "24e case 39: what a withdrawal leaves untouched; the same envelope published again"
REL="$(released "$U_M" "c39-$RUN" 44 claude-ai)"; IFS='|' read -r C39 E39 R39 <<< "$REL"
expect "an authorized download of the release before withdrawal" "$(authorize_download "$R39" "$MS_Q")" '^authorized$'
BEFORE="$(sql -c "select md5((select row_to_json(v)::text from app.candidate_versions v where v.id = '$C39') || (select json_agg(e order by e.id)::text from app.review_envelopes e where e.candidate_id = '$C39') || (select json_agg(r order by r.id)::text from app.reviews r where r.candidate_id = '$C39'))")"
r="$(withdraw "$U_A" "$R39" "Report format changed." @uuid --aal aal2)"
expect "case 39: revokesCopies false; the recipient listed with its count" "$r" "\"revokes_copies\": *false.*\"recipient_count\": *1\|\"recipient_count\": *1.*\"revokes_copies\": *false"
expect "and Q is the recipient" "$r" "\"membership_id\": *\"$MS_Q\""
expect "case 39: the candidate, its envelopes and its reviews are byte-identical" "$(sql -c "select md5((select row_to_json(v)::text from app.candidate_versions v where v.id = '$C39') || (select json_agg(e order by e.id)::text from app.review_envelopes e where e.candidate_id = '$C39') || (select json_agg(r order by r.id)::text from app.reviews r where r.candidate_id = '$C39'))")" "^$BEFORE\$"
r="$(publish_sub "$U_A" "$C39" "$E39" claude-ai)"; R39B="$(field "$r" release_id)"
expect "case 39: the same envelope published again: 201 with a new release id" "$r|$([ "$R39B" != "$R39" ] && echo new)" '"existing": *false.*|new$'
expect "case 39: the old release stays withdrawn and is not superseded (only current releases are)" "$(sql -c "select state || '|' || coalesce(superseded_by_release_id::text, 'none') from app.releases where id = '$R39'")" '^withdrawn|none$'
expect "case 39: the routine refuses the withdrawn release to a member of its audience: E_RELEASE_WITHDRAWN" "$(authorize_download "$R39" "$MS_Q")" '^E_RELEASE_WITHDRAWN$'
expect "and the new one: authorized" "$(authorize_download "$R39B" "$MS_Q")" '^authorized$'

section "24f case 40: supersession"
C40_0="$(submitted "$U_M" "$G" "c40-$RUN" 50)"; AG40="$(sql -c "select agent_id from app.candidate_versions where id = '$C40_0'")"
E40_0="$(env_of "$U_M" "$C40_0" claude-ai "$AUD")"; approve_both "$C40_0" "$E40_0"
r="$(draft_by_id "$U_M" "$G" "$AG40" 51)"; C40_1="$(field "$r" candidate_id)"; submit "$U_M" "$C40_1" 1 51 >/dev/null
E40_1A="$(env_of "$U_M" "$C40_1" claude-ai "$AUD")"; approve_both "$C40_1" "$E40_1A"
E40_1C="$(env_of "$U_M" "$C40_1" chatgpt "$AUD")"; approve_both "$C40_1" "$E40_1C"
r="$(publish_sub "$U_A" "$C40_1" "$E40_1A" claude-ai)"; R40_1A="$(field "$r" release_id)"
expect "case 40: C1's first release moves the older approved C0, which never had a release, to superseded and names it (rule 4)" "$r" "\"superseded_candidate_ids\": *\[\"$C40_0\"\]"
R40_1C="$(field "$(publish_sub "$U_A" "$C40_1" "$E40_1C" chatgpt)" release_id)"
r="$(draft_by_id "$U_M" "$G" "$AG40" 52)"; C40_2="$(field "$r" candidate_id)"; submit "$U_M" "$C40_2" 1 52 >/dev/null
E40_2A="$(env_of "$U_M" "$C40_2" claude-ai "$AUD")"; approve_both "$C40_2" "$E40_2A"
E40_2C="$(env_of "$U_M" "$C40_2" chatgpt "$AUD")"; approve_both "$C40_2" "$E40_2C"
X40="$(expected_sha "$C40_2" claude-ai)"
MUT40="$(mutant 'api.publish_release(uuid,uuid,bytea,bytea,uuid)' "and ((select v.sequence from app.candidate_versions v where v.id = r.candidate_id) < cand_sequence" "and false and ((select v.sequence from app.candidate_versions v where v.id = r.candidate_id) < cand_sequence")"
expect "case 40 fail-before: without supersession and without the one-current index, two current claude-ai releases of the agent" "$(in_rollback "$MUT40;" "drop index app.releases_one_current;" "$(E4MODE=sql publish "$U_A" "$C40_2" "$E40_2A" "$X40" @uuid --aal aal2)" "select 'CURRENT|' || count(*) from app.releases where agent_id = '$AG40' and target = 'claude-ai' and state = 'published' and superseded_by_release_id is null;")" 'CURRENT|2'
expect "case 40: with the index in place the same mutant is refused by it" "$(in_rollback "$MUT40;" "$(E4MODE=sql publish "$U_A" "$C40_2" "$E40_2A" "$X40" @uuid --aal aal2)")" 'releases_one_current'
r="$(publish "$U_A" "$C40_2" "$E40_2A" "$X40" @uuid --aal aal2)"; R40_2A="$(field "$r" release_id)"
expect "case 40: C2 for claude-ai supersedes both of C1's releases, for any target (rule 1)" "$(sql -c "select string_agg(coalesce(superseded_by_release_id::text, 'current'), ',' order by target) from app.releases where id in ('$R40_1A', '$R40_1C')")" "^$R40_2A,$R40_2A\$"
expect "and the answer names both of C1's releases and C1, the one approved candidate still older than C2 (rules 1 and 4)" "$(printf '%s' "$r" | node -e 'const s=require("fs").readFileSync(0,"utf8"); const j=JSON.parse(s.slice(s.indexOf(" ",5)+1)); process.stdout.write([...j.superseded_release_ids].sort().join(",")+"|"+[...j.superseded_candidate_ids].sort().join(","))')" "^$(printf '%s\n%s' "$R40_1A" "$R40_1C" | sort | tr '\n' ',' | sed 's/,$//')|$C40_1\$"
expect "C0 and C1 are superseded" "$(sql -c "select string_agg(state, ',') from app.candidate_versions where id in ('$C40_0', '$C40_1')")" '^superseded,superseded$'
expect "one release.supersede row per release and one candidate.supersede row per candidate" "$(sql -c "select (select count(*) from app.audit_events where action = 'release.supersede' and details->>'superseded_by_release_id' = '$R40_2A') || '|' || (select count(*) from app.audit_events where action = 'candidate.supersede' and entity_id in ('$C40_0', '$C40_1'))")" '^2|2$'
refused "case 40: publish C1 again: E_CANDIDATE_SUPERSEDED" 'E_CANDIDATE_SUPERSEDED' publish_sub "$U_A" "$C40_1" "$E40_1A" claude-ai
E40_2W="$(env_of "$U_M" "$C40_2" claude-ai "$AUDW")"; approve_both "$C40_2" "$E40_2W"
R40_2C="$(field "$(publish_sub "$U_A" "$C40_2" "$E40_2C" chatgpt)" release_id)"
r="$(publish_sub "$U_A" "$C40_2" "$E40_2W" claude-ai)"; R40_2W="$(field "$r" release_id)"
expect "case 40: republishing C2 for claude-ai under a wider audience supersedes only C2's claude-ai release (rule 2)" "$(sql -c "select string_agg(target || ':' || coalesce(superseded_by_release_id::text, 'current'), ',' order by target) from app.releases where id in ('$R40_2A', '$R40_2C', '$R40_2W')")" "^chatgpt:current,claude-ai:$R40_2W,claude-ai:current\$"
expect "case 40 control: C2's other-target envelope and release are unaffected" "$(sql -c "select app.envelope_status('$E40_2C') || '|' || state from app.releases where id = '$R40_2C'")" '^approved|published$'

section "24g case 51: a download's share lock held past app_server's lock_timeout"
REL="$(released "$U_M" "c51-$RUN" 60 claude-ai)"; IFS='|' read -r C51 E51 R51 <<< "$REL"
KEYS51="$(sql -c "select count(*) from app.idempotency_keys")"; STATE51="$(sql -c "select state from app.releases where id = '$R51'")"
sql -c "begin; select id from app.releases where id = '$R51' for share; select pg_sleep(6); commit;" >/dev/null 2>&1 &
sleep 0.5
T0="$(now_ms)"; r="$(withdraw "$U_A" "$R51" "Held." @uuid --aal aal2)"; T1="$(now_ms)"
expect "case 51: the withdrawal answers 55P03, which lib/errors.mjs answers as E_BUSY" "$r" '55P03'
expect "case 51: within six seconds" "$([ $((T1 - T0)) -lt 6000 ] && echo within || echo "after $((T1 - T0)) ms")" '^within$'
expect "case 51: the release unchanged and no claim row" "$(sql -c "select state from app.releases where id = '$R51'")|$(sql -c "select count(*) from app.idempotency_keys")" "^$STATE51|$KEYS51\$"
wait
expect "case 51 control: a retry after the hold succeeds" "$(withdraw "$U_A" "$R51" "Held, then retried." @uuid --aal aal2)" '"state": *"withdrawn"'

expect "deadlocks unchanged" "$(deadlocks)" "^$DL0\$"
[ "$FAILED" = 0 ] && echo "24 PASS" || { echo "24 FAIL"; exit 1; }
