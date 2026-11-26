#!/usr/bin/env bash
# B5 probe: two remaining admins demote/remove each other concurrently on two connections.
# First the counterexample (a copy of set_roles without the company lock) to show the
# failure the lock prevents, then the real protocol. Barrier: session 1 holds its
# transaction open with pg_sleep after the call; session 2 starts one second later and
# must block on the company row; pg_stat_activity is sampled while it waits.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"
LOG="$ROOT/.scratch/e2"; mkdir -p "$LOG"
M1="$(sql -c "select id from app.memberships where user_id='$U_alpha_admin1'")"
M2="$(sql -c "select id from app.memberships where user_id='$U_alpha_admin2'")"
claims() { printf '{"role":"app_server","sub":"%s","aal":"aal2"}' "$1"; }
admins() { sql -c "select count(*) from app.memberships where company_id='$ALPHA' and status='active' and 'company_admin'=any(roles)"; }
restore_admins() { sql -c "update app.memberships set roles='{company_admin,member}', status='active', removed_at=null where id in ('$M1','$M2')" >/dev/null; }

run_pair() { # label sql1 sql2 -> writes $LOG/s1.log $LOG/s2.log, prints lock sample
  rm -f "$LOG/s1.log" "$LOG/s2.log"
  printf '%s' "$2" | (sql_try > "$LOG/s1.log") &
  P1=$!
  sleep 1
  printf '%s' "$3" | (sql_try > "$LOG/s2.log") &
  P2=$!
  sleep 1.5
  echo "-- pg_stat_activity while session 2 waits:"
  sql -c "select pid, state, wait_event_type, wait_event, left(query, 60) from pg_stat_activity where datname='postgres' and query like '%api.set_roles%' or query like '%api.remove_member%' or query like '%probe_set_roles_nolock%' order by pid" | sed 's/^/   /'
  wait $P1 $P2 || true
  echo "-- session 1:"; sed 's/^/   /' "$LOG/s1.log"
  echo "-- session 2:"; sed 's/^/   /' "$LOG/s2.log"
}

section "3a counterexample: the same routine without app.lock_company"
sql <<SQL
create or replace function app.probe_set_roles_nolock(p_membership uuid, p_roles text[]) returns text
language plpgsql security definer set search_path = '' as \$\$
declare actor uuid := app.server_actor(); target app.memberships;
begin
  select * into target from app.memberships where id = p_membership for update;
  perform app.require_admin(target.company_id, actor);
  if 'company_admin' = any (target.roles) and not ('company_admin' = any (p_roles))
     and app.active_admin_count(target.company_id, target.id) = 0 then
    raise exception 'E_LAST_ADMIN' using errcode = 'P0001';
  end if;
  update app.memberships set roles = p_roles where id = target.id;
  return 'demoted ' || target.id;
end \$\$;
SQL
echo "admins before: $(admins)"
run_pair nolock \
"begin; select set_config('request.jwt.claims', '$(claims "$U_alpha_admin1")', true); select app.probe_set_roles_nolock('$M2', '{member}'); select pg_sleep(3); commit;" \
"begin; select set_config('request.jwt.claims', '$(claims "$U_alpha_admin2")', true); select app.probe_set_roles_nolock('$M1', '{member}'); commit;"
n="$(admins)"; echo "admins after: $n"; expect "counterexample leaves ZERO admins (the defect B5 names)" "$n" '^0$'
sql -c "drop function app.probe_set_roles_nolock(uuid, text[])" >/dev/null; restore_admins

section "3b real protocol: concurrent mutual demotion through api.set_roles"
echo "admins before: $(admins)"; T0="$(sql -c "select clock_timestamp()")"
run_pair lock \
"begin; select set_config('request.jwt.claims', '$(claims "$U_alpha_admin1")', true); select * from api.set_roles('$M2', '{member}'); select pg_sleep(3); commit;" \
"begin; select set_config('request.jwt.claims', '$(claims "$U_alpha_admin2")', true); select clock_timestamp(); select * from api.set_roles('$M1', '{member}'); select clock_timestamp(); commit;"
expect "session 2 refused after the wait (winner's commit removed its admin standing)" "$(cat "$LOG/s2.log")" 'E_FORBIDDEN\|E_LAST_ADMIN'
n="$(admins)"; echo "admins after: $n"; expect "exactly one admin remains" "$n" '^1$'
expect "session 1 succeeded" "$(cat "$LOG/s1.log")" 'member}|t'

section "3c idempotent retry of both callers after the race"
r="$(printf "begin; select set_config('request.jwt.claims', '%s', true); select * from api.set_roles('%s', '{member}'); commit;" "$(claims "$U_alpha_admin1")" "$M2" | sql_try)"; expect "winner retry: no-op changed=f" "$r" 'member}|f'
r="$(printf "begin; select set_config('request.jwt.claims', '%s', true); select * from api.set_roles('%s', '{member}'); commit;" "$(claims "$U_alpha_admin2")" "$M1" | sql_try)"; expect "loser retry: admin2 is no longer admin, E_FORBIDDEN" "$r" 'E_FORBIDDEN'
n="$(sql -c "select count(*) from app.audit_events where action='membership.set_roles' and at > '$T0'")"; expect "exactly one set_roles audit row since 3b started (winner only; retries wrote none)" "$n" '^1$'
restore_admins

section "3d real protocol: concurrent mutual removal through api.remove_member"
run_pair lock \
"begin; select set_config('request.jwt.claims', '$(claims "$U_alpha_admin1")', true); select * from api.remove_member('$M2'); select pg_sleep(3); commit;" \
"begin; select set_config('request.jwt.claims', '$(claims "$U_alpha_admin2")', true); select * from api.remove_member('$M1'); commit;"
n="$(admins)"; echo "admins after: $n"; expect "exactly one admin remains after mutual removal" "$n" '^1$'
expect "loser refused after the wait (it is no longer a member)" "$(cat "$LOG/s2.log")" 'E_NOT_FOUND\|E_LAST_ADMIN'
restore_admins

section "3e mixed order: session 1 removes, session 2 demotes; and reversed roles"
run_pair lock \
"begin; select set_config('request.jwt.claims', '$(claims "$U_alpha_admin2")', true); select * from api.set_roles('$M1', '{member,it_reviewer}'); select pg_sleep(3); commit;" \
"begin; select set_config('request.jwt.claims', '$(claims "$U_alpha_admin1")', true); select * from api.remove_member('$M2'); commit;"
n="$(admins)"; echo "admins after: $n"; expect "exactly one admin remains (mixed)" "$n" '^1$'
expect "loser refused after the wait (mixed)" "$(cat "$LOG/s2.log")" 'E_FORBIDDEN\|E_LAST_ADMIN'
restore_admins

section "3g concurrent self-demotion: both admins step down at once; the count refuses the second"
run_pair lock \
"begin; select set_config('request.jwt.claims', '$(claims "$U_alpha_admin1")', true); select * from api.set_roles('$M1', '{member}'); select pg_sleep(3); commit;" \
"begin; select set_config('request.jwt.claims', '$(claims "$U_alpha_admin2")', true); select * from api.set_roles('$M2', '{member}'); commit;"
n="$(admins)"; echo "admins after: $n"; expect "exactly one admin remains (self-demotion race)" "$n" '^1$'
expect "loser refused by the admin count: E_LAST_ADMIN" "$(cat "$LOG/s2.log")" 'E_LAST_ADMIN'
restore_admins

section "3f single admin cannot demote or remove itself"
r="$(printf "begin; select set_config('request.jwt.claims', '%s', true); select * from api.set_roles('%s', '{member}'); commit;" "$(claims "$U_beta_member")" "$(sql -c "select id from app.memberships where user_id='$U_beta_member'")" | sql_try)"; expect "sole beta admin self-demotion refused" "$r" 'E_LAST_ADMIN'
r="$(printf "begin; select set_config('request.jwt.claims', '%s', true); select * from api.remove_member('%s'); commit;" "$(claims "$U_beta_member")" "$(sql -c "select id from app.memberships where user_id='$U_beta_member'")" | sql_try)"; expect "sole beta admin self-removal refused" "$r" 'E_LAST_ADMIN'
sql -c "select 'deadlocks: ' || deadlocks from pg_stat_database where datname='postgres'"
[ "$FAILED" = 0 ] && echo "03 PASS" || { echo "03 FAIL"; exit 1; }
