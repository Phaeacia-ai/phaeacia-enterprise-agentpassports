-- 012_mfa_route_bound.sql. HB-F2 (docs/e8/debts.md 7.1; evidence/hosted-blockers.md section 4 Q1 and 5.1; design
-- and record evidence/ena7-end1-hbf2.md, sections 3 and 5).
--
-- THE GAP. 004's app.hook_mfa_verification_attempt bounds wrong second-factor codes per account, but GoTrue calls it
-- only where the MFA verification hook is installed, which needs the Team plan; the hosted project runs without it, so
-- nothing bounded wrong codes there. This file bounds them THROUGH THE PRODUCT'S ROUTE (POST
-- /api/auth/factors/{id}/verify): five wrong codes in fifteen minutes per account, then refusal until the window ends.
-- GoTrue's own challenge and verify endpoints stay reachable directly by a holder of the person's access token and the
-- publishable key, and nothing here can bound them (residual R3, Raffael's decision with the plan); the deploy check's
-- D11 keeps refusing while the hook is off, which stays true.
--
-- WHAT THIS FILE CONTAINS, and nothing else: two tables and two api routines with their grants. No routine is
-- replaced, and 004's hook and its table are untouched, so a later Team plan turns the hook on beside this bound.
-- Locally, where the hook is on, both budgets apply (evidence/ena7-end1-hbf2.md section 7, S11).
--
-- THE RULE, the hook's rule with one difference that the route needs and the hook does not:
--   1  one row per account, created or locked by the first statement that touches it, so concurrent attempts for one
--      account serialize on that row and ten at once cannot all read four failures;
--   2  five failures inside fifteen minutes exhaust the budget; the window starts at the first failure after a reset
--      and is not rolling, so a refusal has an end the page can show;
--   3  an exhausted budget refuses the attempt before GoTrue sees the code; otherwise the attempt is COUNTED AS A
--      FAILURE BEFORE GoTrue sees it, which is the difference: a function that dies between the two calls, or an end
--      that never arrives, leaves the attempt counted (fail-closed), where the hook is called after GoTrue decided;
--   4  the end settles that attempt's RESERVATION exactly once: a valid code resets the count to the attempts of the
--      current window still in flight, an attempt GoTrue judged nothing about refunds the one count begin took if the
--      reservation is from the current window, and a wrong code keeps it. An unknown, foreign or settled reservation is a no-op, so no refund can undo a counted guess
--      (HB-C2: a reset between begin and end, a double end, an end after a refused begin).
-- The budget and the window are the hook's, five and fifteen minutes, and tests/e2/unit/factor-bound.test.mjs holds
-- the two copies equal (HB-C8).

-- ---------------------------------------------------------------------------
-- 1. The two tables. RLS on and no policy and no grant: only the owner and the two SECURITY DEFINER routines below
--    read or write them, and no application path names them except through those routines.
-- ---------------------------------------------------------------------------
create table app.mfa_route_attempts (
  user_id            uuid primary key,
  window_started_at  timestamptz not null,
  failures           integer     not null default 0 check (failures >= 0),
  updated_at         timestamptz not null default now()
);
alter table app.mfa_route_attempts enable row level security;

create table app.mfa_route_reservations (
  attempt_id         uuid primary key default gen_random_uuid(),
  user_id            uuid not null,
  window_started_at  timestamptz not null,
  created_at         timestamptz not null default now()
);
create index mfa_route_reservations_user on app.mfa_route_reservations (user_id, created_at);
alter table app.mfa_route_reservations enable row level security;

-- ---------------------------------------------------------------------------
-- 2. api.mfa_verify_begin(): before the route sends the code to GoTrue. The actor from the server token, no user
--    argument. Allowed: the attempt is counted and one reservation written, whose id the end names. Refused: nothing
--    written, and the window's end. Reservations older than the window are pruned here, after the row lock.
-- ---------------------------------------------------------------------------
create or replace function api.mfa_verify_begin()
returns table (allowed boolean, retry_after timestamptz, attempt_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  budget constant integer := 5;
  window_length constant interval := interval '15 minutes';
  actor uuid := app.server_actor();
  started timestamptz;
  failed integer;
  att uuid;
begin
  -- 1. The row, created or locked, before anything is decided.
  insert into app.mfa_route_attempts as w (user_id, window_started_at, failures)
  values (actor, now(), 0)
  on conflict (user_id) do update set updated_at = now()
  returning w.window_started_at, w.failures into started, failed;
  -- 2. A window that has passed is a whole budget again.
  if failed > 0 and now() >= started + window_length then
    failed := 0;
  end if;
  delete from app.mfa_route_reservations r where r.user_id = actor and r.created_at < now() - window_length;
  -- 3. Exhausted inside the window: refused, before GoTrue sees the code, and nothing changes.
  if failed >= budget then
    return query select false, started + window_length, null::uuid;
    return;
  end if;
  -- 3. Otherwise counted now; the first failure after a reset starts the window.
  if failed = 0 then
    started := now();
  end if;
  update app.mfa_route_attempts
     set failures = failed + 1, window_started_at = started, updated_at = now()
   where user_id = actor;
  insert into app.mfa_route_reservations (user_id, window_started_at)
  values (actor, started)
  returning mfa_route_reservations.attempt_id into att;
  return query select true, null::timestamptz, att;
end $$;

-- ---------------------------------------------------------------------------
-- 3. api.mfa_verify_end(p_attempt, p_outcome): after GoTrue answered. The account's row is locked first, then the
--    caller's own reservation is consumed, so begin and end take the two tables in one order.
-- ---------------------------------------------------------------------------
create or replace function api.mfa_verify_end(p_attempt uuid, p_outcome text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  started timestamptz;
  failed integer;
  reserved_window timestamptz;
begin
  if p_outcome is null or p_outcome not in ('valid', 'invalid', 'undecided') then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  select w.window_started_at, w.failures into started, failed
    from app.mfa_route_attempts w where w.user_id = actor for update;
  if started is null then
    return;
  end if;
  delete from app.mfa_route_reservations r
   where r.attempt_id = p_attempt and r.user_id = actor
  returning r.window_started_at into reserved_window;
  if reserved_window is null then
    return;
  end if;
  -- 4. A valid code resets the count, but not below the attempts of this window still in flight: each was counted
  --    once, at its begin, so a reset to 0 would let their wrong codes, judged after it, count for nothing (the hook
  --    counts at judgment and has no such gap; HBF2-R-F1). Their ends settle them as any other. An undecided attempt
  --    refunds its own count, in its own window only.
  if p_outcome = 'valid' then
    update app.mfa_route_attempts
       set failures = (select count(*) from app.mfa_route_reservations r
                        where r.user_id = actor and r.window_started_at = started),
           updated_at = now()
     where user_id = actor;
  elsif p_outcome = 'undecided' and reserved_window = started and failed > 0 then
    update app.mfa_route_attempts set failures = failed - 1, updated_at = now() where user_id = actor;
  end if;
end $$;

-- Grants: app_server alone, by full signature; PUBLIC, anon, authenticated and service_role explicitly revoked, as 010
-- does, so the privilege set is visible here.
revoke execute on function api.mfa_verify_begin() from public, anon, authenticated, service_role;
revoke execute on function api.mfa_verify_end(uuid, text) from public, anon, authenticated, service_role;
grant execute on function api.mfa_verify_begin() to app_server;
grant execute on function api.mfa_verify_end(uuid, text) to app_server;
