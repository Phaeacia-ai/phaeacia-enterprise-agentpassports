#!/usr/bin/env bash
# E3 probe 17: query plans on an envelope-sized data set (docs/e3/design.md 2.3 indexes, 7.2; section 6 case 34), and
# the storage measurements 7.2 asks for that a local stack can give: TOAST size of a passport, audit rows per save.
# Seed: the plan's envelope, ten companies of 25 memberships, 50 agents each, ten candidate versions per agent,
# 5,000 rows holding the SYNTHETIC passport, built owner-side with the triggers bypassed and every hash computed.
# Plans are recorded in .scratch/e2/e3-17-plans.txt. A local plan is not production evidence: the planner, the
# data distribution, the cache and the hardware all differ there. Run: bash tests/db/17-content-plans.sh.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
RUN="$(run_id)"; PW17='Synthetic-Pass-1234'
PLANS="$ROOT/.scratch/e2/e3-17-plans.txt"; : > "$PLANS"

section "17 seed: 25 users, 10 companies, 250 memberships, 500 agents, 5,000 candidate versions"
USERS=""
for i in $(seq 1 25); do USERS="$USERS $(create_user "e3-17-$RUN-u$i@example.invalid" "$PW17")"; done
set -- $USERS; FIRST_USER="$1"
COMPANIES=""
for c in $(seq 1 10); do COMPANIES="$COMPANIES $(company "e3-17-$RUN-c$c" "$FIRST_USER")"; done
USER_ARRAY="array['$(printf '%s' "$USERS" | sed "s/^ //; s/ /','/g")']::uuid[]"
COMPANY_ARRAY="array['$(printf '%s' "$COMPANIES" | sed "s/^ //; s/ /','/g")']::uuid[]"
GATE_ID="$(sql -c "select id from app.gate_identities where active")"
CONTENT="$(E3 literal content --revision 17)"; DERIVED="$(E3 literal derived --revision 17)"
START="$(node -e 'process.stdout.write(String(Date.now()))')"
sql <<SQL >/dev/null
insert into app.memberships (company_id, user_id, roles)
  select c, u, '{member}' from unnest($COMPANY_ARRAY) c, unnest($USER_ARRAY) u
  on conflict (company_id, user_id) do nothing;
insert into app.agents (company_id, name, creator_membership_id, owner_membership_id)
  select m.company_id, 'env-' || a, m.id, m.id
    from generate_series(1, 50) a
    cross join (select distinct on (company_id) id, company_id from app.memberships
                 where company_id = any ($COMPANY_ARRAY) order by company_id, id) m;
SQL
expect "ten companies of 25 memberships" "$(sql -c "select count(*) from app.memberships where company_id = any ($COMPANY_ARRAY)")" '^250$'
expect "500 agents, 50 a company" "$(sql -c "select count(*)||'|'||count(distinct company_id) from app.agents where company_id = any ($COMPANY_ARRAY)")" '^500|10$'
sql <<SQL >/dev/null
begin;
alter table app.candidate_versions disable trigger candidate_2_identity;
insert into app.candidate_versions (company_id, agent_id, sequence, state, author_membership_id, content, content_sha256,
    derived_canonical, derived_sha256, gate_id, validated_at, attested_by, submitted_at, submitted_by_membership_id)
  select ag.company_id, ag.id, s, st.state, m.id, c.content, sha256(convert_to(c.content, 'UTF8')), c.derived,
         sha256(convert_to(c.derived, 'UTF8')), '$GATE_ID', (c.derived::jsonb->>'validated_at')::timestamptz, m.id,
         case when st.state = 'draft' then null else now() end, case when st.state = 'draft' then null else m.id end
    from app.agents ag
    cross join generate_series(1, 10) s
    cross join (select $CONTENT::text as content, $DERIVED::text as derived) c
    join lateral (select case when s = 10 then 'draft' when s = 9 then 'submitted' when s = 8 then 'approved' else 'superseded' end as state) st on true
    join lateral (select mm.id from app.memberships mm where mm.company_id = ag.company_id order by md5(mm.id::text || ag.id::text || s) limit 1) m on true
   where ag.company_id = any ($COMPANY_ARRAY);
alter table app.candidate_versions enable trigger candidate_2_identity;
commit;
analyze app.candidate_versions;
analyze app.agents;
analyze app.memberships;
SQL
SEED_MS="$(( $(node -e 'process.stdout.write(String(Date.now()))') - START ))"
expect "5,000 candidate rows across the ten companies" "$(sql -c "select count(*) from app.candidate_versions where company_id = any ($COMPANY_ARRAY)")" '^5000$'
expect "every seeded row's hashes are of its own bytes" "$(sql -c "select bool_and(content_sha256 = sha256(convert_to(content,'UTF8')) and derived_sha256 = sha256(convert_to(derived_canonical,'UTF8'))) from app.candidate_versions where company_id = any ($COMPANY_ARRAY)")" '^t$'
printf 'seed: 25 users, 10 companies, 250 memberships, 500 agents, 5000 candidate versions (states by sequence: 10 draft, 9 submitted, 8 approved, 1-7 superseded), %s ms\n' "$SEED_MS" >> "$PLANS"

C1="$(sql -c "select (${COMPANY_ARRAY})[1]")"
AUTHOR="$(sql -c "select author_membership_id from app.candidate_versions where company_id='$C1' and state='draft' group by author_membership_id order by count(*) desc limit 1")"
AGENT="$(sql -c "select id from app.agents where company_id='$C1' order by id limit 1")"
plan() { # label statement
  local out; out="$(sql -c "explain (analyze, buffers, costs off) $2")"
  printf '\n== %s\n%s\n%s\n' "$1" "$2" "$out" >> "$PLANS"
  printf '%s' "$out"
}

section "17a case 34: each hot query uses its index and no sequential scan reads app.candidate_versions"
out="$(plan "author draft list" "select id, agent_id, sequence, version from app.candidate_versions where author_membership_id = '$AUTHOR' and state = 'draft'")"
expect "author draft list: candidate_versions_author_drafts" "$out" 'candidate_versions_author_drafts'
expect "author draft list: no Seq Scan on candidate_versions" "$(printf '%s' "$out" | grep -c 'Seq Scan on candidate_versions')" '^0$'
out="$(plan "company submitted list" "select id, agent_id, sequence, submitted_at from app.candidate_versions where company_id = '$C1' and state = 'submitted' order by sequence desc limit 50")"
expect "company submitted list: candidate_versions_company_state" "$out" 'candidate_versions_company_state'
expect "company submitted list: no Seq Scan on candidate_versions" "$(printf '%s' "$out" | grep -c 'Seq Scan on candidate_versions')" '^0$'
out="$(plan "agent next sequence (create_draft, create_successor)" "select coalesce(max(v.sequence), 0) + 1 from app.candidate_versions v where v.agent_id = '$AGENT'")"
expect "agent sequence lookup: the (agent_id, sequence) unique index" "$out" 'candidate_versions_agent_id_sequence_key'
expect "agent sequence lookup: no Seq Scan on candidate_versions" "$(printf '%s' "$out" | grep -c 'Seq Scan on candidate_versions')" '^0$'
out="$(plan "agent version count (the version ceiling)" "select count(*) from app.candidate_versions v where v.agent_id = '$AGENT'")"
expect "version ceiling count: no Seq Scan on candidate_versions" "$(printf '%s' "$out" | grep -c 'Seq Scan on candidate_versions')" '^0$'
out="$(plan "successor exists (create_successor)" "select exists (select 1 from app.candidate_versions v where v.supersedes_candidate_id = '$AGENT')")"
expect "successor lookup: candidate_versions_one_successor" "$out" 'candidate_versions_one_successor'
M_USER="$(sql -c "select user_id from app.memberships where id='$AUTHOR'")"
out="$(sql -c "begin; select set_config('request.jwt.claims', '{\"sub\":\"$M_USER\",\"role\":\"authenticated\"}', true); set local role authenticated;
  explain (analyze, buffers, costs off) select id, sequence from api.candidate_versions where company_id = '$C1' and state = 'submitted' order by sequence desc limit 50; rollback;")"
printf '\n== company submitted list through api.candidate_versions under RLS, as an ordinary member (recorded, not asserted)\n%s\n' "$out" >> "$PLANS"
echo "recorded: the RLS path's plan, where app.candidate_visible runs per candidate row the index returns"

section "17b design 7.2: TOAST and audit growth"
TOAST="$(sql -c "select round(avg(octet_length(content)))||'|'||round(avg(pg_column_size(content)))||'|'||round(avg(pg_column_size(derived)))||'|'||pg_size_pretty(pg_total_relation_size('app.candidate_versions')) from app.candidate_versions where company_id = any ($COMPANY_ARRAY)")"
printf '\nTOAST: avg content bytes | avg stored content size | avg stored derived jsonb | total relation size: %s\n' "$TOAST" >> "$PLANS"
echo "TOAST (avg content bytes | stored | derived jsonb | relation): $TOAST"
U1="$(sql -c "select user_id from app.memberships where company_id='$C1' order by id limit 1")"
# Under an existing agent: every seeded company already holds its 50 agents, so a new name is E_AGENT_LIMIT.
r="$(draft_by_id "$U1" "$C1" "$AGENT" 1)"; expect "a draft for the growth measurement" "$r" 'HTTP 200'; GD="$(field "$r" candidate_id)"
AUD="$(count app.audit_events)"
r="$(save "$U1" "$GD" 1 2)"; expect "a save" "$r" '"version": *2'
GROWTH="$(( $(count app.audit_events) - AUD ))"
expect "one audit row per save" "$GROWTH" '^1$'
printf 'audit rows per save: %s\n' "$GROWTH" >> "$PLANS"
echo "plans and measurements: $PLANS"

[ "$FAILED" = 0 ] && echo "17 PASS" || { echo "17 FAIL"; exit 1; }
