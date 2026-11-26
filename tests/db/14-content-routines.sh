#!/usr/bin/env bash
# E3 probe 14: the four content routines at the routine level (docs/e3/design.md 1.3, 1.4, 2.5, 4.3, 4.4, 4.5;
# section 6 cases 3, 4, 5 as far as the E4 stub allows, 10 database half, 17, 25, 28, 28a, 31, 33, and the
# routine-level parts of 19, whose route half is E3b). Calls go through PostgREST with bearers and bodies built by
# lib/db/server.mjs; fail-before mutants run the live definition with one replacement, in a rolled-back owner
# transaction. Builds its own companies. Run: bash tests/db/14-content-routines.sh (after tests/db/00-seed.sh).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
RUN="$(run_id)"; T="$E2_TMP/14"; mkdir -p "$T"; PW14='Synthetic-Pass-1234'

section "14 setup: G1 (admin, author, member, it_reviewer, a removed member), G2 (admin, member); the author is in both"
U_A="$(create_user "e3-14-$RUN-admin@example.invalid" "$PW14")"
U_M="$(create_user "e3-14-$RUN-author@example.invalid" "$PW14")"
U_M2="$(create_user "e3-14-$RUN-member@example.invalid" "$PW14")"
U_R="$(create_user "e3-14-$RUN-reviewer@example.invalid" "$PW14")"
U_X="$(create_user "e3-14-$RUN-removed@example.invalid" "$PW14")"
U_B="$(create_user "e3-14-$RUN-beta-admin@example.invalid" "$PW14")"
U_N="$(create_user "e3-14-$RUN-beta-member@example.invalid" "$PW14")"
G1="$(company "e3-14-$RUN-g1" "$U_A")"; G2="$(company "e3-14-$RUN-g2" "$U_B")"
A_MS="$(membership_of "$G1" "$U_A")"
M_MS="$(member "$G1" "$U_M" '{member}')"; M2_MS="$(member "$G1" "$U_M2" '{member}')"
R_MS="$(member "$G1" "$U_R" '{it_reviewer,member}')"; X_MS="$(member "$G1" "$U_X" '{member}')"
sql -c "update app.memberships set status='removed', removed_at=now() where id='$X_MS'" >/dev/null
MB_MS="$(member "$G2" "$U_M" '{member}')"; N_MS="$(member "$G2" "$U_N" '{member}')"
M2_JWT="$(user_jwt "e3-14-$RUN-member@example.invalid" "$PW14")"
expect "setup" "$G1|$G2|$M_MS|$N_MS" '^[0-9a-f-]\{36\}|[0-9a-f-]\{36\}|[0-9a-f-]\{36\}|[0-9a-f-]\{36\}$'

section "14a H2 and the agent rules at the routine level (case 19's routine half; its route half is E3b)"
r="$(draft_by_name "$U_M" "$G1" "shared-$RUN" 1)"; expect "the author creates an agent by name in G1" "$r" 'HTTP 200'
AG1="$(field "$r" agent_id)"; D1="$(field "$r" candidate_id)"
r="$(draft_by_name "$U_M" "$G2" "shared-$RUN" 1)"; expect "the same user, the same name, in G2: accepted" "$r" 'HTTP 200'
AG2="$(field "$r" agent_id)"
expect "two distinct agents, one per company, because company_id is bound (H2)" "$(sql -c "select count(distinct id)||'|'||count(distinct company_id) from app.agents where name='shared-$RUN'")" '^2|2$'
AUD="$(count app.audit_events)"
r="$(draft_by_name "$U_M" "$G1" "shared-$RUN" 2)"; expect "the same name twice in one company: E_AGENT_NAME_TAKEN" "$r" 'E_AGENT_NAME_TAKEN'
r="$(draft_by_id "$U_M" "$G1" "$AG2" 2)"; expect "G1 as the company, G2's agent id: E_NOT_FOUND" "$r" 'E_NOT_FOUND'
r="$(draft_by_id "$U_N" "$G1" "$AG1" 2)"; expect "a member of G2 only, creating in G1: E_NOT_FOUND" "$r" 'E_NOT_FOUND'
r="$(E3 call create_draft "$U_M" "{\"company_id\":\"$G1\",\"agent_id\":\"$AG1\",\"agent_name\":\"x-$RUN\",\"content\":\"@content\",\"derived_canonical\":\"@derived\",\"gate_identity\":\"@gate\",\"idempotency_key\":\"@uuid\"}" --revision 2)"
expect "both an agent id and a name: E_BODY_INVALID" "$r" 'E_BODY_INVALID'
r="$(draft_by_name "$U_M" "$G1" "Bad_Name" 2)"; expect "a name outside the slug grammar: E_BODY_INVALID" "$r" 'E_BODY_INVALID'
expect "no audit row from any of those refusals" "$(count app.audit_events)" "^$AUD\$"
sql -c "update app.agents set status='archived' where id='$AG2'" >/dev/null
r="$(draft_by_id "$U_M" "$G2" "$AG2" 3)"; expect "an archived agent: E_AGENT_ARCHIVED" "$r" 'E_AGENT_ARCHIVED'
expect "create_draft wrote the author as an observed contributor" "$(sql -c "select string_agg(kind||'|'||observed, ',') from app.candidate_contributors where candidate_id='$D1'")" '^author|true$'

section "14b case 25, B3 author: nobody but the author changes a draft"
r="$(save "$U_M2" "$D1" 1 3)"; expect "another member saves the author's draft: E_NOT_AUTHOR" "$r" 'E_NOT_AUTHOR'
r="$(save "$U_R" "$D1" 1 3)"; expect "a reviewer: E_NOT_AUTHOR" "$r" 'E_NOT_AUTHOR'
r="$(save "$U_A" "$D1" 1 3)"; expect "the company admin: E_NOT_AUTHOR" "$r" 'E_NOT_AUTHOR'
r="$(submit "$U_M2" "$D1" 1 1)"; expect "another member submits it: E_NOT_AUTHOR" "$r" 'E_NOT_AUTHOR'
E3 call save_draft "$U_M" "{\"candidate_id\":\"$D1\",\"expected_version\":1,\"content\":\"@content\",\"derived_canonical\":\"@derived\",\"gate_identity\":\"@gate\",\"idempotency_key\":\"@uuid\"}" --revision 4 --save "$T/spoof" --drop jti >/dev/null
SPOOF="$(node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).body; b.p_author_membership_id=process.argv[2]; process.stdout.write(JSON.stringify(b))' "$T/spoof" "$M2_MS")"
r="$(rest POST /rpc/save_draft "$(server_jwt "$U_M2")" "$SPOOF")"
expect "a body naming its own author matches no routine signature; the author is never a parameter" "$r" 'PGRST202\|HTTP 404'
expect "D1's author and version are unchanged" "$(sql -c "select author_membership_id||'|'||version from app.candidate_versions where id='$D1'")" "^$M_MS|1\$"
r="$(rest GET "/candidate_versions?select=id&id=eq.$D1" "$M2_JWT")"; expect "and the other member cannot read it (the route's 404 is E3b)" "$r" '^HTTP 200 \[\]'
MUT="$(mutant 'api.save_draft(uuid,integer,text,text,bytea,uuid)' "if cand.author_membership_id is distinct from member_id then" "if false then")"
r="$(in_rollback "$MUT;" "$(E3MODE=sql save "$U_M2" "$D1" 1 5)")"; expect "fail-before: without the author check another member's save writes" "$r" '"version": *2'
r="$(in_rollback "$(E3MODE=sql save "$U_M2" "$D1" 1 5)")"; expect "real: the same call is E_NOT_AUTHOR" "$r" 'E_NOT_AUTHOR'

section "14c case 17 at the routine level: a save commits between the service's re-gate and submit_candidate"
r="$(draft_by_id "$U_M" "$G1" "$AG1" 17)"; D17="$(field "$r" candidate_id)"
r="$(save "$U_M" "$D17" 1 18)"; expect "the save that wins the race, version 2" "$r" '"version": *2'
AUD="$(count app.audit_events)"
r="$(submit "$U_M" "$D17" 2 17)"; expect "the submit bound to the bytes gated before the save: E_CONTENT_CHANGED" "$r" 'E_CONTENT_CHANGED'
expect "nothing frozen: still a draft, no submitter row, no audit row" "$(sql -c "select state||'|'||(select count(*) from app.candidate_contributors where candidate_id='$D17' and kind='submitter') from app.candidate_versions where id='$D17'")|$(count app.audit_events)" "^draft|0|$AUD\$"
MUT="$(mutant 'api.submit_candidate(uuid,integer,bytea,text,text,bytea,uuid)' "if cand.content_sha256 <> p_content_sha256 then" "if false then")"
r="$(in_rollback "$MUT;" "$(E3MODE=sql submit "$U_M" "$D17" 2 17)")"; expect "fail-before: without the comparison the stale submit freezes other bytes" "$r" '"state": *"submitted"'
r="$(submit "$U_M" "$D17" 2 18)"; expect "control: the sequential submit with the stored bytes' hash" "$r" '"state": *"submitted"'
expect "the submit wrote its submitter row and one candidate.submit audit row" "$(sql -c "select (select count(*) from app.candidate_contributors where candidate_id='$D17' and kind='submitter')||'|'||(select count(*) from app.audit_events where action='candidate.submit' and entity_id='$D17')")" '^1|1$'
r="$(submit "$U_M" "$D17" 3 18)"; expect "a fresh submit of a submitted candidate: E_NOT_DRAFT" "$r" 'E_NOT_DRAFT'
r="$(save "$U_M" "$D17" 3 19)"; expect "a fresh save of a submitted candidate: E_NOT_DRAFT" "$r" 'E_NOT_DRAFT'
r="$(save "$U_M" "$D1" 7 19)"; expect "a save at a version the row does not have: E_VERSION_CONFLICT" "$r" 'E_VERSION_CONFLICT'

section "14d case 3: two connections save one draft at the same expected version"
r="$(draft_by_id "$U_M" "$G1" "$AG1" 30)"; D3="$(field "$r" candidate_id)"
DL0="$(deadlocks)"
hold_company "$G1" 2; sleep 0.3
save "$U_M" "$D3" 1 31 > "$T/save31" & P1=$!
save "$U_M" "$D3" 1 32 > "$T/save32" & P2=$!
wait "$P1"; wait "$P2"; wait
WINS="$(cat "$T/save31" "$T/save32" | grep -c 'HTTP 200')"; LOSES="$(cat "$T/save31" "$T/save32" | grep -c 'E_VERSION_CONFLICT')"
expect "exactly one wins and the other is E_VERSION_CONFLICT" "$WINS|$LOSES" '^1|1$'
WIN_REV="$(grep -l 'HTTP 200' "$T/save31" "$T/save32" | sed 's/.*save//')"
expect "the row holds the winner's bytes, at version 2, and its attestation is of those bytes" "$(sql -c "select (content like '%Revision $WIN_REV.%')||'|'||version||'|'||(content_sha256 = sha256(convert_to(content,'UTF8')) and derived_sha256 = sha256(convert_to(derived_canonical,'UTF8')))||'|'||(derived_canonical::jsonb->>'validated_at' is not null) from app.candidate_versions where id='$D3'")" '^true|2|true|true$'
expect "deadlocks unchanged" "$(deadlocks)" "^$DL0\$"
r="$(save "$U_M" "$D3" 2 33)"; expect "control: the sequential save with the incremented version" "$r" '"version": *3'

section "14e case 28, B4 provenance over a chain of three successors"
X_DECL="{\"confidence\":\"high\",\"declared_contributors\":[{\"membership_id\":\"$R_MS\"},{\"membership_id\":\"$X_MS\"},{\"display_name\":\"Jane Doe (former intern)\"}],\"permitted_data\":\"synthetic records only\",\"source_platform\":\"synthetic probe\"}"
r="$(draft_by_name "$U_M" "$G1" "chain-$RUN" 50)"; P0="$(field "$r" candidate_id)"; AGC="$(field "$r" agent_id)"
r="$(draft_by_id "$U_M" "$G1" "$AGC" 51)"; DF="$(field "$r" candidate_id)"
AUD="$(count app.audit_events)"
r="$(SUBMISSION="{\"confidence\":\"high\",\"declared_contributors\":[{\"membership_id\":\"$N_MS\"}],\"permitted_data\":\"x\",\"source_platform\":\"x\"}" submit "$U_M" "$DF" 1 51)"
expect "a declared member of another company: E_NOT_FOUND, no audit row" "$r|$(count app.audit_events)" "E_NOT_FOUND.*|$AUD\$"
r="$(SUBMISSION='{"confidence":"certain","permitted_data":"x","source_platform":"x"}' submit "$U_M" "$DF" 1 51)"; expect "a confidence outside the vocabulary: E_BODY_INVALID" "$r" 'E_BODY_INVALID'
r="$(SUBMISSION="{\"confidence\":\"high\",\"declared_contributors\":[{\"membership_id\":\"$R_MS\",\"display_name\":\"both\"}],\"permitted_data\":\"x\",\"source_platform\":\"x\"}" submit "$U_M" "$DF" 1 51)"; expect "a declaration holding both keys: E_BODY_INVALID" "$r" 'E_BODY_INVALID'
r="$(SUBMISSION="{\"confidence\":\"high\",\"dependencies\":[$(for i in $(seq 41); do printf '"d%s",' "$i"; done | sed 's/,$//')],\"permitted_data\":\"x\",\"source_platform\":\"x\"}" submit "$U_M" "$DF" 1 51)"; expect "41 dependencies: E_BODY_INVALID" "$r" 'E_BODY_INVALID'
r="$(SUBMISSION="$X_DECL" submit "$U_M" "$P0" 1 50)"; expect "P0 submitted, declaring a reviewer, a removed member and an external name" "$r" '"state": *"submitted"'
expect "P0: author, submitter, two declared members, one offline name with no identity" "$(sql -c "select string_agg(kind||'|'||coalesce(membership_id::text,'none'), ',' order by kind, membership_id) from app.candidate_contributors where candidate_id='$P0'")" "author|$M_MS,declared_member|.*,declared_member|.*,declared_offline|none,submitter|$M_MS"
expect "the removed colleague is still a contributor" "$(sql -c "select count(*) from app.candidate_contributors where candidate_id='$P0' and membership_id='$X_MS' and kind='declared_member'")" '^1$'
expect "the offline name is audited by kind only, never by name" "$(sql -c "select count(*) from app.audit_events where entity_type='candidate_contributor' and details->>'candidate_id'='$P0' and details::text like '%Jane%'")|$(sql -c "select count(*) from app.audit_events where entity_type='candidate_contributor' and details->>'candidate_id'='$P0' and details->>'contributor_kind'='declared_offline'")" '^0|1$'
inherits() { # child parent: parent rows the child lacks as inherited copies
  sql -c "select count(*) from app.candidate_contributors p where p.candidate_id = '$2' and not exists (
    select 1 from app.candidate_contributors c where c.candidate_id = '$1' and c.inherited_from_candidate_id = '$2'
      and c.kind = p.kind and c.membership_id is not distinct from p.membership_id and c.display_name is not distinct from p.display_name and c.observed = p.observed)"
}
request_changes "$P0"
r="$(successor "$U_R" "$P0" 50)"; expect "S1 by the reviewer" "$r" '"supersedes_candidate_id": *"'"$P0"'"'; S1="$(field "$r" candidate_id)"
expect "S1 carries every contributor of P0, marked inherited from P0" "$(inherits "$S1" "$P0")" '^0$'
expect "and adds the reviewer as its own observed author" "$(sql -c "select count(*) from app.candidate_contributors where candidate_id='$S1' and membership_id='$R_MS' and kind='author' and inherited_from_candidate_id is null")" '^1$'
sql -c "update app.agents set owner_membership_id='$A_MS' where id='$AGC'" >/dev/null
echo "note: ownership moved owner-side; E3 has no transfer routine, and provenance does not read the owner"
r="$(SUBMISSION='{"confidence":"medium","permitted_data":"synthetic records only","source_platform":"synthetic probe"}' submit "$U_R" "$S1" 1 50)"; expect "S1 submitted by its author" "$r" '"state": *"submitted"'
request_changes "$S1"
r="$(successor "$U_A" "$S1" 50)"; expect "S2 by the admin, after the ownership change" "$r" '"state": *"draft"'; S2="$(field "$r" candidate_id)"
expect "S2 carries every contributor of S1, inherited rows included, marked inherited from S1" "$(inherits "$S2" "$S1")" '^0$'
r="$(rest POST /rpc/remove_member "$(server_jwt "$U_A" aal2)" "{\"p_membership\":\"$M_MS\"}")"; expect "the original author's membership is removed" "$r" '"changed":true'
sql -c "update app.memberships set status='active', removed_at=null where id='$M_MS'" >/dev/null
expect "and reactivated with the same id; its contributor rows on the chain are unchanged" "$(sql -c "select count(*) from app.candidate_contributors where membership_id='$M_MS' and candidate_id in ('$P0','$S1','$S2')")" '^6$'
r="$(SUBMISSION='{"confidence":"low","permitted_data":"synthetic records only","source_platform":"synthetic probe"}' submit "$U_A" "$S2" 1 50)"; expect "S2 submitted" "$r" '"state": *"submitted"'
request_changes "$S2"
r="$(successor "$U_R" "$S2" 50)"; expect "S3 by the reviewer again" "$r" '"state": *"draft"'; S3="$(field "$r" candidate_id)"
expect "S3 carries every contributor of S2" "$(inherits "$S3" "$S2")" '^0$'
expect "the external name never resolves to anyone along the chain" "$(sql -c "select count(*) from app.candidate_contributors where display_name is not null and membership_id is not null")" '^0$'
r="$(draft_by_id "$U_M" "$G1" "$AGC" 52)"; FRESH="$(field "$r" candidate_id)"
expect "control: create_draft for the same agent starts a fresh lineage with only its author" "$(sql -c "select count(*)||'|'||coalesce(max(inherited_from_candidate_id::text),'none') from app.candidate_contributors where candidate_id='$FRESH'")|$(sql -c "select coalesce(supersedes_candidate_id::text,'none') from app.candidate_versions where id='$FRESH'")" '^1|none|none$'

section "14e-F2 E3a critique F2: a malformed contributor declaration is refused before any write (case 30's database half)"
# SQL booleans are three-valued. With one alternative's key absent its test was NULL, not (NULL or false) is NULL, and
# a WHERE drops a NULL row, so the malformed entry never reached the refusal: {display_name:123} was frozen as a
# contributor named 123 and {typo:...} vanished. Each shape is sent alone, on its own fresh draft, through PostgREST
# with a bearer bound by lib/db/server.mjs, so no refusal can hide behind another.
f2_snapshot() { sql -c "select v.state||'|'||v.version||'|'||(select count(*) from app.candidate_contributors k where k.candidate_id = v.id)||'|'||(select count(*) from app.audit_events)||'|'||(select count(*) from app.idempotency_keys where membership_id = '$M_MS') from app.candidate_versions v where v.id = '$1'"; }
f2_submission() { printf '{"confidence":"high","declared_contributors":[%s],"permitted_data":"synthetic records only","source_platform":"synthetic probe"}' "$1"; }
# Called as X="$(f2_draft)", a subshell: the caller advances F2_REV first, so the submit binds the draft's own bytes.
f2_draft() { field "$(draft_by_id "$U_M" "$G1" "$AG1" "$F2_REV")" candidate_id; }
F2_REV=110
R_UPPER="$(printf '%s' "$R_MS" | tr 'a-f' 'A-F')"
for decl in '{"display_name":123}' '{"typo":"x"}' '{"membership_id":null}' '{"display_name":null}' '{"membership_id":"not-uuid"}' \
            '{"display_name":""}' '{"membership_id":123}' "{\"membership_id\":\"$R_UPPER\"}"; do
  F2_REV=$((F2_REV + 1)); DD="$(f2_draft)"; B="$(f2_snapshot "$DD")"
  expect "fresh draft for $decl" "$B" '^draft|1|1|'
  r="$(SUBMISSION="$(f2_submission "$decl")" submit "$U_M" "$DD" 1 "$F2_REV")"
  expect "the declaration $decl alone: E_BODY_INVALID" "$r" 'E_BODY_INVALID'
  expect "and nothing written for $decl: state, version, contributors, audit rows and claim rows unchanged" "$(f2_snapshot "$DD")" "^$B\$"
done
F2_REV=$((F2_REV + 1)); DN="$(f2_draft)"
r="$(SUBMISSION="$(f2_submission '{"display_name":"SYNTHETIC Offline Colleague"}')" submit "$U_M" "$DN" 1 "$F2_REV")"
expect "control: a valid name alone is accepted" "$r" '"state": *"submitted"'
expect "and recorded as one declared_offline contributor with that name" "$(sql -c "select string_agg(kind||'|'||coalesce(display_name,'-')||'|'||coalesce(membership_id::text,'-'), ',') from app.candidate_contributors where candidate_id='$DN' and kind like 'declared%'")" '^declared_offline|SYNTHETIC Offline Colleague|-$'
F2_REV=$((F2_REV + 1)); DMB="$(f2_draft)"
r="$(SUBMISSION="$(f2_submission "{\"membership_id\":\"$R_MS\"}")" submit "$U_M" "$DMB" 1 "$F2_REV")"
expect "control: a valid member alone is accepted" "$r" '"state": *"submitted"'
expect "and recorded as one declared_member contributor" "$(sql -c "select string_agg(kind||'|'||coalesce(display_name,'-')||'|'||coalesce(membership_id::text,'-'), ',') from app.candidate_contributors where candidate_id='$DMB' and kind like 'declared%'")" "^declared_member|-|$R_MS\$"
F2_REV=$((F2_REV + 1)); DMU="$(f2_draft)"
MUT="$(mutant 'app.submission_fields(text)' "between 1 and 120)) is not true" "between 1 and 120)) = false" 2>/dev/null)" || MUT=""
expect "the total predicate is in the live definition (the mutant's anchor exists)" "${MUT:+found}" '^found$'
if [ -n "$MUT" ]; then
  CALL="$(SUBMISSION="$(f2_submission '{"display_name":123}')" E3MODE=sql submit "$U_M" "$DMU" 1 "$F2_REV")"
  r="$(in_rollback "$MUT;" "$CALL" "select 'MUTANT|'||string_agg(kind||'|'||coalesce(display_name,'-'), ',') from app.candidate_contributors where candidate_id='$DMU' and kind like 'declared%';")"
  expect "fail-before (F2): with the predicate NULL-able again, {display_name:123} is frozen as a contributor named 123 (then rolled back)" "$r" 'MUTANT|declared_offline|123$'
  r="$(in_rollback "$CALL")"; expect "real: the same call is E_BODY_INVALID" "$r" 'E_BODY_INVALID'
fi

section "14f case 28a, H3: the successor's attestation is its own; who may create one; the conflicts"
expect "S1 against P0: same content_sha256; different derived bytes, derived_sha256 and validated_at; the same active gate" \
  "$(sql -c "select (s.content_sha256 = p.content_sha256)||'|'||(s.derived_canonical <> p.derived_canonical)||'|'||(s.derived_sha256 <> p.derived_sha256)||'|'||(s.validated_at <> p.validated_at)||'|'||(s.gate_id = p.gate_id) from app.candidate_versions s, app.candidate_versions p where s.id='$S1' and p.id='$P0'")" '^true|true|true|true|true$'
r="$(draft_by_id "$U_M" "$G1" "$AG1" 60)"; P28="$(field "$r" candidate_id)"
r="$(submit "$U_M" "$P28" 1 60)"; request_changes "$P28"
MUT="$(mutant 'api.create_successor(uuid,bytea,text,bytea,uuid)' "member_id, parent.id, parent.content, p_derived_canonical, gate, member_id)" "member_id, parent.id, parent.content, parent.derived_canonical, parent.gate_id, member_id)")"
r="$(in_rollback "$MUT;" "$(E3MODE=sql successor "$U_R" "$P28" 60)" "select 'COPIED|'||(s.derived_canonical = p.derived_canonical)||'|'||(s.validated_at = p.validated_at)||'|'||(s.gate_id = p.gate_id)||'|'||(s.content_sha256 = p.content_sha256) from app.candidate_versions s join app.candidate_versions p on p.id = s.supersedes_candidate_id where p.id='$P28';")"
expect "fail-before: a successor that copies the parent's attestation carries all four of the parent's values" "$r" 'COPIED|true|true|true|true'
r="$(successor "$U_M2" "$P28" 60)"; expect "an ordinary member who may not read the parent: E_NOT_FOUND" "$r" 'E_NOT_FOUND'
r="$(successor "$U_R" "$P28" 60)"; expect "the reviewer who may: accepted" "$r" '"state": *"draft"'
r="$(successor "$U_A" "$P28" 60)"; expect "a second successor of the same parent: E_SUCCESSOR_EXISTS" "$r" 'E_SUCCESSOR_EXISTS'
MUT="$(mutant 'api.create_successor(uuid,bytea,text,bytea,uuid)' "if exists (select 1 from app.candidate_versions v where v.supersedes_candidate_id = parent.id) then" "if false then")"
r="$(in_rollback "$MUT;" "$(E3MODE=sql successor "$U_A" "$P28" 60)")"; expect "with that check removed, the partial unique index refuses it" "$r" 'candidate_versions_one_successor'
r="$(draft_by_id "$U_M" "$G1" "$AG1" 61)"; P28B="$(field "$r" candidate_id)"; submit "$U_M" "$P28B" 1 61 >/dev/null; request_changes "$P28B"
r="$(successor "$U_R" "$P28B" 999)"; expect "p_content_sha256 that is not the locked parent's: E_CONTENT_CHANGED" "$r" 'E_CONTENT_CHANGED'
r="$(successor "$U_M" "$D17" 18)"; expect "a submitted parent, not changes_requested: E_STATE_TRANSITION" "$r" 'E_STATE_TRANSITION'
r="$(successor "$U_M" "$D1" 1)"; expect "the author's own draft as a parent: E_STATE_TRANSITION" "$r" 'E_STATE_TRANSITION'
echo "note: a parent whose stored bytes the active gate now refuses is 422 E_GATE_FAILS_NOW in the service before any RPC (design 4.5 row 18), which is E3b"

section "14g case 31: the agent limit is enforced, ten retained is not a refusal, the version ceiling counts superseded rows"
U_Q="$(create_user "e3-14-$RUN-quota@example.invalid" "$PW14")"; G3="$(company "e3-14-$RUN-g3" "$U_Q")"; Q_MS="$(membership_of "$G3" "$U_Q")"
GATE_ID="$(sql -c "select id from app.gate_identities where active")"
sql -c "insert into app.agents (company_id, name, creator_membership_id, owner_membership_id) select '$G3', 'bulk-'||g, '$Q_MS', '$Q_MS' from generate_series(1, 49) g" >/dev/null
r="$(draft_by_name "$U_Q" "$G3" "fiftieth-$RUN" 70)"; expect "the 50th agent" "$r" 'HTTP 200'; AGV="$(field "$r" agent_id)"
r="$(draft_by_name "$U_Q" "$G3" "fifty-first-$RUN" 70)"; expect "the 51st agent: E_AGENT_LIMIT" "$r" 'E_AGENT_LIMIT'
CONTENT="$(E3 literal content --revision 71)"; DERIVED="$(E3 literal derived --revision 71)"
sql -c "insert into app.candidate_versions (company_id, agent_id, sequence, author_membership_id, content, derived_canonical, gate_id, attested_by)
  select '$G3', '$AGV', g, '$Q_MS', $CONTENT, $DERIVED, '$GATE_ID', '$Q_MS' from generate_series(2, 10) g" >/dev/null
r="$(draft_by_id "$U_Q" "$G3" "$AGV" 72)"; expect "the 11th version succeeds: ten retained is an E4 target, not a refusal" "$r" '"sequence": *11'
MUT="create or replace function app.limit_versions_per_agent() returns integer language sql immutable parallel safe set search_path = '' as \$m\$ select 10 \$m\$;"
r="$(in_rollback "$MUT" "$(E3MODE=sql draft_by_id "$U_Q" "$G3" "$AGV" 73)")"; expect "fail-before (Q3): with the ceiling at ten the 12th version is refused" "$r" 'E_VERSION_LIMIT'
sql -c "insert into app.candidate_versions (company_id, agent_id, sequence, author_membership_id, content, derived_canonical, gate_id, attested_by)
  select '$G3', '$AGV', g, '$Q_MS', $CONTENT, $DERIVED, '$GATE_ID', '$Q_MS' from generate_series(12, 199) g;
  update app.candidate_versions set state='submitted', submitted_at=now(), submitted_by_membership_id='$Q_MS' where agent_id='$AGV' and sequence between 12 and 111;
  update app.candidate_versions set state='approved' where agent_id='$AGV' and sequence between 12 and 111;
  update app.candidate_versions set state='superseded' where agent_id='$AGV' and sequence between 12 and 111;" >/dev/null
expect "199 rows, 100 of them superseded" "$(sql -c "select count(*)||'|'||count(*) filter (where state='superseded') from app.candidate_versions where agent_id='$AGV'")" '^199|100$'
r="$(draft_by_id "$U_Q" "$G3" "$AGV" 74)"; expect "version 200, at the ceiling of 200, succeeds" "$r" '"sequence": *200'
r="$(draft_by_id "$U_Q" "$G3" "$AGV" 75)"; expect "version 201: E_VERSION_LIMIT, superseded rows counted" "$r" 'E_VERSION_LIMIT'

section "14h cases 4 and 24 (database half): the server's gate identity must be the active registered one"
ORIG="$(sql -c "select encode(identity_sha256,'hex') from app.gate_identities where active")"
SCR="$T/tree"; mkdir -p "$SCR/lib" "$SCR/vendor/passport/web"
cp -R "$ROOT/lib/passport" "$SCR/lib/"; cp "$ROOT/upstream.lock.json" "$SCR/"; cp -R "$ROOT/vendor/passport/web/lib" "$SCR/vendor/passport/web/"
printf ' ' >> "$SCR/lib/passport/rules.mjs"
MOVED="$(node --input-type=module -e "import { manifest } from '$ROOT/scripts/gate-manifest.mjs'; const m = await manifest('$SCR'); process.stdout.write(m.gateIdentitySha256)")"
expect "one changed byte of rules.mjs gives another identity" "$([ "$MOVED" != "$ORIG" ] && [ ${#MOVED} = 64 ] && echo moved)" '^moved$'
AUD="$(count app.audit_events)"; ROWS="$(count app.candidate_versions)"
r="$(draft_by_id "$U_M" "$G1" "$AG1" 80 '@uuid' --gate "$MOVED")"; expect "(b) code ahead of the migration: E_GATE_UNREGISTERED" "$r" 'E_GATE_UNREGISTERED'
r="$(save "$U_M" "$D1" 1 80 '@uuid' --gate "$MOVED")"; expect "(b) and on save" "$r" 'E_GATE_UNREGISTERED'
expect "no row and no audit row" "$(count app.candidate_versions)|$(count app.audit_events)" "^$ROWS|$AUD\$"
NEW="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update("e3-14 probe identity").digest("hex"))')"
ROT="set local app.registry_migration = 'on'; update app.gate_identities set active = false where active; insert into app.gate_identities (identity_sha256, adapter_lock_sha256, validator_version, manifest_sha256, upstream_commit, active) values (decode('$NEW','hex'), sha256('lock'), '0.1.0', sha256('manifest'), repeat('b', 40), true);"
r="$(in_rollback "$ROT" "savepoint s;" "$(E3MODE=sql draft_by_id "$U_M" "$G1" "$AG1" 81)" "rollback to savepoint s;" "select 'COUNTS|'||(select count(*) from app.candidate_versions)||'|'||(select count(*) from app.audit_events);")"
expect "(a) migration ahead of the code, the code's identity: E_GATE_UNREGISTERED" "$r" 'E_GATE_UNREGISTERED'
expect "(a) no row and no audit row" "$r" "COUNTS|$ROWS|$AUD"
expect "control: identities agree, the same call succeeds" "$(draft_by_id "$U_M" "$G1" "$AG1" 81)" 'HTTP 200'

section "14i case 5, as far as the E4 stub allows: a successor of a stale submitted candidate attests under the active identity"
r="$(draft_by_id "$U_M" "$G1" "$AG1" 82)"; P5="$(field "$r" candidate_id)"; submit "$U_M" "$P5" 1 82 >/dev/null
r="$(draft_by_id "$U_M" "$G1" "$AG1" 83)"; D5="$(field "$r" candidate_id)"
r="$(in_rollback "$ROT" "$(E4MODE=sql request_changes "$P5" --gate "$NEW")" "$(E3MODE=sql successor "$U_M" "$P5" 82 '@uuid' --gate "$NEW")" \
  "select 'GATES|'||(select encode(g.identity_sha256,'hex') from app.candidate_versions v join app.gate_identities g on g.id = v.gate_id where v.supersedes_candidate_id = '$P5')||'|'||(select encode(g.identity_sha256,'hex') from app.candidate_versions v join app.gate_identities g on g.id = v.gate_id where v.id = '$P5');" \
  "savepoint s;" "$(E3MODE=sql save "$U_M" "$D5" 1 84)" "rollback to savepoint s;")"
expect "after the rotation the successor carries the new identity and the frozen parent keeps its own" "$r" "GATES|$NEW|$ORIG"
expect "a save under the retired identity: E_GATE_UNREGISTERED" "$r" 'E_GATE_UNREGISTERED'
echo "note: case 5's publish refusal (E_ADAPTER_CHANGED) and the review route's re-gate are E4; nothing here stands in for them"

section "14j case 10, database half: five rows the routines wrote across two companies replay; tampered rows do not"
r="$(draft_by_id "$U_N" "$G2" "$AG2" 90)"; expect "archived agent refuses the G2 member too" "$r" 'E_AGENT_ARCHIVED'
r="$(draft_by_name "$U_N" "$G2" "g2-$RUN" 90)"; GA="$(field "$r" candidate_id)"; GAG="$(field "$r" agent_id)"
r="$(draft_by_id "$U_N" "$G2" "$GAG" 91)"; GB="$(field "$r" candidate_id)"
sql -c "select json_agg(json_build_object('content', v.content, 'derived_canonical', v.derived_canonical,
    'content_sha256', encode(v.content_sha256,'hex'), 'derived_sha256', encode(v.derived_sha256,'hex'),
    'gate', json_build_object('identity_sha256', encode(g.identity_sha256,'hex'), 'adapter_lock_sha256', encode(g.adapter_lock_sha256,'hex'),
      'validator_version', g.validator_version, 'manifest_sha256', encode(g.manifest_sha256,'hex'), 'upstream_commit', g.upstream_commit)) order by v.id)
  from app.candidate_versions v join app.gate_identities g on g.id = v.gate_id where v.id in ('$D1','$P0','$D17','$GA','$GB')" > "$T/rows.json"
expect "five rows from two companies exported" "$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.length)' "$T/rows.json")" '^5$'
r="$(node "$ROOT/scripts/verify-attestation.mjs" --rows "$T/rows.json"; echo "exit=$?")"
expect "verify-attestation passes every check on all five" "$r" 'verify-attestation: 5 row(s), 0 failed check(s)'
node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));r[0].derived_canonical=r[0].derived_canonical.replace("Record Sorter","Record Sortes");r[1].content=r[1].content.replace("amber","ambeR");fs.writeFileSync(process.argv[2],JSON.stringify(r))' "$T/rows.json" "$T/tampered.json"
r="$(node "$ROOT/scripts/verify-attestation.mjs" --rows "$T/tampered.json"; echo "exit=$?")"
expect "one tampered derived byte: hash and replay mismatch" "$r" 'FAIL row 0: derived_sha256 matches derived_canonical'
expect "one tampered content byte: hash mismatch" "$r" 'FAIL row 1: content_sha256 matches content'
expect "the three untampered rows still pass, and the run exits 2" "$(printf '%s\n' "$r" | grep -c '^FAIL row [234]')|$(printf '%s\n' "$r" | tail -1)" '^0|exit=2$'

section "14k case 33: a removal, a save and a successor creation interleaved on one company by three connections"
r="$(draft_by_name "$U_M2" "$G1" "owned-$RUN" 100)"; DM2="$(field "$r" candidate_id)"; AGM2="$(field "$r" agent_id)"
r="$(draft_by_id "$U_M" "$G1" "$AG1" 101)"; D33="$(field "$r" candidate_id)"
r="$(draft_by_id "$U_M" "$G1" "$AG1" 102)"; P33="$(field "$r" candidate_id)"; submit "$U_M" "$P33" 1 102 >/dev/null; request_changes "$P33"
DL0="$(deadlocks)"
hold_company "$G1" 3; sleep 0.3
rest POST /rpc/remove_member "$(server_jwt "$U_A" aal2)" "{\"p_membership\":\"$M2_MS\"}" > "$T/remove33" &
save "$U_M" "$D33" 1 103 > "$T/save33" &
successor "$U_R" "$P33" 102 > "$T/succ33" &
wait
expect "the removal completes" "$(cat "$T/remove33")" '"changed":true'
expect "the save completes" "$(cat "$T/save33")" '"version": *2'
expect "the successor completes" "$(cat "$T/succ33")" '"state": *"draft"'
expect "no deadlock: pg_stat_database.deadlocks unchanged" "$(deadlocks)" "^$DL0\$"
expect "the removed member's agent is orphaned by the same removal" "$(sql -c "select status from app.agents where id='$AGM2'")" '^orphaned$'
r="$(save "$U_M2" "$DM2" 1 104)"; expect "the removed member's save afterwards: E_NOT_FOUND (standing)" "$r" 'E_NOT_FOUND'
hold_company "$G1" 2; sleep 0.3
save "$U_M" "$D33" 2 105 > "$T/save33b" &
rest POST /rpc/set_roles "$(server_jwt "$U_A" aal2)" "{\"p_membership\":\"$R_MS\",\"p_roles\":[\"member\"]}" > "$T/demote" &
successor "$U_R" "$P28B" 61 > "$T/succ33b" &
wait
expect "reverse arrival: the save still completes" "$(cat "$T/save33b")" '"version": *3'
expect "no deadlock in the reverse arrival either" "$(deadlocks)" "^$DL0\$"
expect "the successor meets the refusal 4.5 names for whichever order it got: success before the demotion, E_NOT_FOUND after" "$(cat "$T/succ33b")" '"state": *"draft"\|E_NOT_FOUND'

[ "$FAILED" = 0 ] && echo "14 PASS" || { echo "14 FAIL"; exit 1; }
