-- ---------------------------------------------------------------------------
-- 008_lifecycle.sql: onboarding and lifecycle (E6). Design docs/e6/design.md 2.3.
-- ---------------------------------------------------------------------------
-- Additive, one owner, in the style of 003, 004, 006 and 007. Files 001 to 007 are not edited
-- (scripts/check-migrations.mjs pins them by content); every accepted routine this slice changes is
-- replaced here with `create or replace`, carrying its whole accepted body so the one intended
-- difference is what a reviewer reads.
--
-- What this migration installs, in the order of design 2.3:
--   B0  the one-time dual-principal check of 1.1 (E6D-C-F1c)
--   B1  vocabulary, windows and quota defaults
--   B2  app.access_periods (1.5), the operator invitation column (1.1), six company_id indexes
--   B3  app.company_quotas and its one reader app.quota (1.7)
--   B3b the read cutoff at the database read boundary: five predicates and one policy (1.5, E6S-C-F2)
--   B4  the five quota call sites in 003, 006 and 007
--   B5  app.lock_company_operator, app.lock_company, app.lock_account with app.require_disjoint_principal
--       (E6S-C-F1), and the six accepted routines of 1.1 to 1.7
--   B6  the operator surface (1.1)
--   B7  api.transfer_agent (1.3)
--   B8  api.departure_preview (1.4)
--   B9  the company status guard and the one deletion door (1.6)
--   B10 closure, deletion and the export (1.6)
--   B11 app.my_standing and its view (1.1, 1.5)
--   B12 the account sweep's owner-side functions (1.5)
--   B13 app.audit_details_guard with the keys of 2.4
--   B14 grants
--
-- The number. The Copilot slice's re-pin may take 008 first; the number is the only difference.
-- This migration registers no gate identity, no installer text and no target, never calls
-- app.release_target_names(), and does not replace app.registry_frozen, so applying the two in
-- either order gives the same schema (design 2.3, "The number").

-- ---------------------------------------------------------------------------
-- B0. Operators and members are disjoint from here onwards (1.1, E6D-C-F1c). The rule is enforced
--     at the three creation points in B5 and B6. This is the one-time check that 008 is not
--     installing that promise over data nobody has looked at: it names the count and no identity,
--     and it fails the migration rather than repairing anything.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  select count(*) into n from app.operators o
   where exists (select 1 from app.memberships m where m.user_id = o.user_id);
  if n > 0 then
    -- The count is in DETAIL and no identity is named anywhere. The message is one token, so
    -- tests/e3/unit/migration-text.test.mjs can hold it in the same owner-side set as every other refusal no
    -- PostgREST role can reach: this one is reachable by nobody at all, because it aborts a migration.
    raise exception 'E_DUAL_PRINCIPAL' using errcode = 'P0001',
      detail = format('%s operator account(s) hold a membership; reconcile before applying 008', n);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- B1. Vocabulary, windows and quota defaults, one place each (1.5, 1.6, 1.7)
-- ---------------------------------------------------------------------------
create or replace function app.quota_names() returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select array['members_per_company', 'pending_invitations_per_company', 'agents_per_company',
               'groups_per_company', 'versions_per_agent', 'downloads_per_recipient',
               'reports_per_recipient']::text[] $$;

-- The two bounds that do not exist anywhere today (1.2, 1.7).
create or replace function app.limit_members_per_company() returns integer
language sql immutable parallel safe set search_path = '' as $$ select 25 $$;      -- the plan's envelope
create or replace function app.limit_pending_invitations() returns integer
language sql immutable parallel safe set search_path = '' as $$ select 50 $$;      -- twice the whole company

-- The plan's section 8 schedule, one constant each, quoted at the function.
-- "a 14-day read/export window, then delete tenant content within the next 30 days".
create or replace function app.export_window() returns interval
language sql immutable parallel safe set search_path = '' as $$ select interval '14 days' $$;
create or replace function app.deletion_window() returns interval
language sql immutable parallel safe set search_path = '' as $$ select interval '30 days' $$;
create or replace function app.account_sweep_grace() returns interval
language sql immutable parallel safe set search_path = '' as $$ select interval '14 days' $$;
-- The notice E7's weekly operator check needs before delete_by, so a company entering 'due' is seen at
-- least once before its deadline (1.5, E6D-C-F3).
create or replace function app.deletion_due_notice() returns interval
language sql immutable parallel safe set search_path = '' as $$ select interval '7 days' $$;

-- Transport and transaction bounds of this service, not of a customer (1.6, 1.7).
-- 4 MiB, measured on the SERIALIZED document: Netlify documents 6 MB buffered, the answer is buffered
-- twice in the function (lib/db/server.mjs:338 parses the whole RPC answer), and 30 per cent is held
-- back because the routine measures octet_length(doc::text) and the wire carries Node's
-- JSON.stringify. Design 1.6 has the table.
create or replace function app.limit_export_bytes() returns integer
language sql immutable parallel safe set search_path = '' as $$ select 4194304 $$;    -- 4 MiB
-- A transaction-duration bound and not a storage bound: a single transaction deleting half a million
-- rows holds locks long enough that a bound is worth having (1.6).
create or replace function app.limit_delete_rows() returns integer
language sql immutable parallel safe set search_path = '' as $$ select 500000 $$;

-- E4's download-ledger read ceiling, the one arithmetic E6 inherits and has to restate (design section 6).
-- lib/services/evidence-reads.mjs holds LEDGER_CEILING = 10000 and refuses E_READ_OVER_BOUND above it; E5
-- section 6 derived it from "200 downloads x 25 members" with the condition written out, and E6 makes both
-- numbers operator-settable, so api.set_company_quota compares the product against this constant. The two
-- copies of the number are pinned equal by tests/e6/unit/migration-text.test.mjs, as 007's lane pinned its
-- limits against lib/rules/installations.mjs.
create or replace function app.limit_ledger_rows() returns integer
language sql immutable parallel safe set search_path = '' as $$ select 10000 $$;

-- The default of a quota IS the existing constant; the constant keeps its arithmetic and its comment.
create or replace function app.quota_default(p_name text) returns integer
language sql stable set search_path = '' as $$
  select case p_name
    when 'members_per_company'             then app.limit_members_per_company()
    when 'pending_invitations_per_company' then app.limit_pending_invitations()
    when 'agents_per_company'              then app.limit_agents_per_company()
    when 'groups_per_company'              then app.limit_groups_per_company()
    when 'versions_per_agent'              then app.limit_versions_per_agent()
    when 'downloads_per_recipient'         then app.limit_downloads_per_recipient()
    when 'reports_per_recipient'           then app.limit_reports_per_recipient()
  end $$;

-- A floor and a ceiling per name, so an operator's extra zero is refused rather than sold (1.7).
-- The ceilings are not arbitrary: each is the point past which an arithmetic recorded elsewhere stops
-- holding. members_per_company at 500 is far past E5 section 6's ledger derivation, which holds while a
-- company's lifetime memberships stay at or below 50, which is why the register shows lifetime
-- memberships. versions_per_agent at 1,000 is 250 MiB of content for one agent at the content bound,
-- five times 003's own arithmetic. downloads_per_recipient at 2,000 times 500 members is 1,000,000,
-- which exceeds E4's 10,000-row LEDGER_CEILING, so this pair is where the two limits meet.
create or replace function app.quota_bounds(p_name text) returns int4range
language sql immutable parallel safe set search_path = '' as $$
  select case p_name
    when 'members_per_company'             then int4range(1, 500, '[]')
    when 'pending_invitations_per_company' then int4range(1, 500, '[]')
    when 'agents_per_company'              then int4range(1, 500, '[]')
    when 'groups_per_company'              then int4range(1, 200, '[]')
    when 'versions_per_agent'              then int4range(10, 1000, '[]')
    when 'downloads_per_recipient'         then int4range(1, 2000, '[]')
    when 'reports_per_recipient'           then int4range(1, 200, '[]')
  end $$;

-- Explicit, as 001 section 5, 003, 006 and 007 do: the privilege set is visible in the migration and
-- not inferred from the PUBLIC default. Nothing in schema app is reachable through PostgREST, which
-- exposes api alone; these are the doors' own helpers.
revoke execute on function app.quota_names(), app.limit_members_per_company(),
  app.limit_pending_invitations(), app.export_window(), app.deletion_window(),
  app.account_sweep_grace(), app.deletion_due_notice(), app.limit_export_bytes(),
  app.limit_delete_rows(), app.limit_ledger_rows(), app.quota_default(text), app.quota_bounds(text)
  from public;

-- ---------------------------------------------------------------------------
-- B2. Access periods (1.5) and the operator invitation column (1.1)
-- ---------------------------------------------------------------------------
create table app.access_periods (
  company_id  uuid primary key references app.companies (id),
  invoice_ref text check (invoice_ref is null or char_length(invoice_ref) between 1 and 80),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  export_by   timestamptz not null,
  delete_by   timestamptz not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint access_period_order check (starts_at < ends_at and ends_at <= export_by and export_by <= delete_by)
);
create index access_periods_export_by on app.access_periods (export_by);
create index access_periods_delete_by on app.access_periods (delete_by);

alter table app.access_periods enable row level security;
-- Policy: none for authenticated in this migration. A member does not read their company's agreement
-- dates; design 3.1 says so and section 8 question 3 puts it to Raffael, whose other answer is one
-- select policy. app_maintenance reads it, as it reads E3's, E4's and E5's tables.
grant select on app.access_periods to app_maintenance;
create policy maintenance_access_periods on app.access_periods for select to app_maintenance using (true);

alter table app.invitations alter column created_by drop not null;
alter table app.invitations add column created_by_operator uuid references app.operators (user_id);
alter table app.invitations add constraint invitations_one_creator
  check (num_nonnulls(created_by, created_by_operator) = 1);
-- The column grant to authenticated is NOT widened: an admin reading api.invitations sees the same
-- columns as before, and an operator-issued invitation shows created_by null, which the page renders
-- as "Phaeacia".

-- The access period's derived state, read by app.my_standing, app.download_refusal_for,
-- api.export_company and the register, so the four cannot disagree (1.5). Time, never companies.status.
create or replace function app.access_state(p_company uuid) returns text
language sql stable set search_path = '' as $$
  select coalesce((select case
           when p.export_by <= clock_timestamp() then 'expired'
           when p.ends_at   <= clock_timestamp() then 'export_window'
           else 'current' end
         from app.access_periods p where p.company_id = p_company), 'none') $$;

-- The deletion's three words (1.5): eligible from export_by, due within the notice, overdue past
-- delete_by.
create or replace function app.deletion_state(p_company uuid) returns text
language sql stable set search_path = '' as $$
  select coalesce((select case
           when clock_timestamp() >= p.delete_by                              then 'overdue'
           when clock_timestamp() >= p.delete_by - app.deletion_due_notice()  then 'due'
           when clock_timestamp() >= p.export_by                              then 'eligible'
           else 'not_eligible' end
         from app.access_periods p where p.company_id = p_company), 'not_eligible') $$;
revoke execute on function app.access_state(uuid), app.deletion_state(uuid) from public;

-- The six company_id indexes the export and the deletion need (1.6, design section 6). Justified by
-- the per-company statement, NOT by the register, whose grouped aggregates are sequential scans with
-- or without them; a later reader dropping one of these should measure the deletion, not the register.
create index release_downloads_company on app.release_downloads (company_id);
create index installation_reports_company on app.installation_reports (company_id);
create index installation_witnesses_company on app.installation_witnesses (company_id);
create index group_members_company on app.group_members (company_id);
create index reviews_company on app.reviews (company_id);
create index review_envelopes_company on app.review_envelopes (company_id);
-- app.candidate_contributors carries no company_id at all; the export and the deletion reach it
-- through app.candidate_versions, whose candidate_versions_company_state leads with company_id.

-- ---------------------------------------------------------------------------
-- B3. Quotas (1.7)
-- ---------------------------------------------------------------------------
create table app.company_quotas (
  company_id uuid not null references app.companies (id),
  name       text not null check (name = any (app.quota_names())),
  value      integer not null,
  updated_at timestamptz not null default now(),
  primary key (company_id, name)
);
alter table app.company_quotas enable row level security;
-- The aal2 predicate belongs at the policy, not only at the service (E6D-C-F12): without it an admin
-- at aal1 reads the overrides directly through api.company_quotas, bypassing the route's assurance
-- test. 005's accepted invitation policy is the exact precedent and this copies its shape.
create policy company_quotas_member_read on app.company_quotas for select to authenticated
  using (app.has_role(company_id, 'company_admin') and (select auth.jwt()->>'aal') = 'aal2');
grant select on app.company_quotas to app_maintenance;
create policy maintenance_company_quotas on app.company_quotas for select to app_maintenance using (true);
grant select on app.company_quotas to authenticated;
create view api.company_quotas with (security_invoker = true) as select * from app.company_quotas;
grant select on api.company_quotas to authenticated;

-- The one reader. A company row overrides; its absence falls through to the one constant, so there is
-- no second source of truth (1.7).
create or replace function app.quota(p_company uuid, p_name text) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce((select q.value from app.company_quotas q
                    where q.company_id = p_company and q.name = p_name),
                  app.quota_default(p_name)) $$;
revoke all on function app.quota(uuid, text) from public;
-- Granted to nobody: every caller is a SECURITY DEFINER routine owned by postgres.

-- ---------------------------------------------------------------------------
-- B3b. The read cutoff AT THE DATABASE READ BOUNDARY (design 1.5; E6S-C-F2)
--
-- The defect. 1.5's cutoff was written into app.lock_company (writes), app.download_refusal_for (downloads),
-- api.export_company (the copy), app.my_standing and lib/services (the routes), and NOT into the predicates row
-- level security actually decides with. Past export_by, with the sweep never run so companies.status is still
-- active, an authenticated member of that company read its candidate_versions content straight through
-- PostgREST: api.export_company refused 409 and `GET /rest/v1/candidate_versions?select=content` answered 200
-- with the row (evidence/e6-server-critique.md E6S-C-F2). RLS is the authoritative boundary in this product and
-- the services are defense in depth, so the boundary belongs here.
--
-- THE RULE, once: a membership of a company whose access state is `expired` is not an active membership for
-- tenant content reads. It tests EXPORT_BY and not ends_at, because between ends_at and export_by reads continue
-- and that window is the whole point of 1.5 (probe 29i, case 19).
--
-- THE EXCEPTION, narrowly and in one place. Two reads survive the cutoff and nothing else does:
--   * app.my_standing() and api.my_standing, which is the one read in the product that sees past a company's
--     state by design, is scoped to auth.uid(), and carries access_state itself. It is what lets the home page
--     say the true sentence, "your company's access period ended on the 3rd", instead of the false one. It
--     reads a membership row, a company's slug, name and status, and the derived state: no tenant content.
--   * a person's OWN app.profiles row, through the `user_id = auth.uid()` arm of profiles_comember_read. That is
--     the caller's own display name, not the customer's records. A CO-MEMBER'S profile row is tenant content and
--     goes with everything else, which is the half of that policy this block rewrites.
-- Anything else that must survive the cutoff later is a decision for Raffael and a change here, not a second
-- predicate somewhere else.
--
-- HOW IT REACHES EVERY POLICY. Every `to authenticated` policy in 001 to 008 rests, directly or through one
-- wrapper, on five predicates that read auth.uid(). This block replaces those five and rewrites the one policy
-- that inlined the company join instead of calling any of them. Nothing else in 001 to 008 decides an
-- authenticated read. evidence/e6-server-corrections.md section 4 is the table, policy by policy and view by view.
--   app.is_active_member(company)            companies, memberships, agents, groups, group_members, and
--                                            app.is_active_member_anywhere for the four global registries
--   app.has_role(company, role)              invitations (005, with aal2), audit_events, company_quotas,
--                                            app.ledger_visible and app.installation_visible
--   app.my_membership(company)               app.ledger_visible, app.installation_visible, app.witness_visible
--   app.candidate_visible(candidate)         candidate_versions, candidate_contributors, review_envelopes, reviews
--   app.release_visible(release)             releases, and api.release_catalog over them
--
-- WHY THE FIVE auth.uid() FORMS AND NOT app.membership_of ITSELF. app.membership_of has two doors (003 section
-- 10): the policies ask the auth.uid() form, and SECURITY DEFINER ROUTINES ask the explicit form with the
-- bearer's subject. Two of those routines carry the boundary themselves and answer a DIFFERENT and better code
-- than a missing membership would: api.authorize_download reaches app.download_refusal_for, which answers 409
-- E_ACCESS_PERIOD_ENDED (design 1.5, 3.1; tests/e6/stack case 38), and api.export_company tests export_by in its
-- own body. Putting the cutoff inside app.membership_of would turn both of those refusals into 404 E_NOT_FOUND,
-- which is a worse answer to the customer and a change to accepted behaviour nobody asked for. So the cutoff is
-- on the READ boundary, which is what E6S-C-F2 is about, and the routines keep their own.
--
-- PER-ROW COST. app.read_window_open is `language sql stable` and NOT security definer, so the planner inlines
-- it and app.access_state into the calling predicate: what each predicate gains is one primary-key probe of
-- app.access_periods inside the same plan, not a second function call and not a scan. It is revoked from public
-- and granted to nobody, which is a fail-CLOSED guard rather than a comment: a policy that called it directly
-- would run as `authenticated`, meet "permission denied for function read_window_open" and admit no row, rather
-- than reading app.access_periods under RLS, finding nothing, and concluding the window is open. Only a SECURITY
-- DEFINER predicate owned by postgres may call it. The before-and-after capacity rows are in section 4 of
-- evidence/e6-server-corrections.md.
-- ---------------------------------------------------------------------------
create or replace function app.read_window_open(p_company uuid) returns boolean
language sql stable set search_path = '' as $$
  select app.access_state(p_company) <> 'expired'
$$;
revoke all on function app.read_window_open(uuid) from public;

-- 001's two granted predicates, their accepted bodies unchanged but for the cutoff. The comment 001 carries
-- about company status ("a suspended or closed company is invisible to its members through every view") still
-- holds; this adds the time half of the same sentence.
create or replace function app.is_active_member(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.memberships m
    join app.companies c on c.id = m.company_id and c.status = 'active'
    where m.company_id = p_company
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and app.read_window_open(m.company_id)
  )
$$;

create or replace function app.has_role(p_company uuid, p_role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.memberships m
    join app.companies c on c.id = m.company_id and c.status = 'active'
    where m.company_id = p_company
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and p_role = any (m.roles)
      and app.read_window_open(m.company_id)
  )
$$;

-- 003's three auth.uid() wrappers. Each keeps its accepted body and adds the one test; app.membership_of,
-- app.candidate_visible_to and app.release_visible_to, the explicit-user forms the routines call, are NOT
-- replaced, for the reason in the block comment above.
create or replace function app.my_membership(p_company uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select case when app.read_window_open(p_company)
              then app.membership_of(p_company, (select auth.uid())) end
$$;

create or replace function app.candidate_visible(p_candidate uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.candidate_versions v
                  where v.id = p_candidate and app.read_window_open(v.company_id))
     and app.candidate_visible_to(p_candidate, (select auth.uid()))
$$;

create or replace function app.release_visible(p_release uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.releases r
                  where r.id = p_release and app.read_window_open(r.company_id))
     and app.release_visible_to(p_release, (select auth.uid()))
$$;

-- The one policy that inlined the company join instead of calling a shared predicate, which is why the cutoff
-- could not reach it (001 line 444). It is rewritten to rest on app.is_active_member, which is the same rule it
-- spelled out: "their active membership in a company where I am an active member of an active company". The
-- caller's OWN row is the named exception above and is unchanged. 005_invitations_aal2.sql is the precedent for
-- correcting an accepted policy from a later migration; 001's bytes are untouched.
drop policy profiles_comember_read on app.profiles;
create policy profiles_comember_read on app.profiles for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from app.memberships theirs
       where theirs.user_id = profiles.user_id and theirs.status = 'active'
         and app.is_active_member(theirs.company_id)
    )
  );

-- ---------------------------------------------------------------------------
-- B4/B5. The five quota call sites and the accepted routines this slice changes (1.1 to 1.7).
--        Each carries its whole accepted body: the marked block or the named expression is the only
--        difference, and tests/e3/unit/migration-text.test.mjs holds the pairs that must stay equal.
--
--   api.create_draft        app.limit_agents_per_company()  -> app.quota(p_company, 'agents_per_company')
--                           app.limit_versions_per_agent()  -> app.quota(p_company, 'versions_per_agent')
--   api.create_successor    app.limit_versions_per_agent()  -> app.quota(company, 'versions_per_agent')
--   api.create_group        app.limit_groups_per_company()  -> app.quota(p_company, 'groups_per_company')
--   api.report_installation app.limit_reports_per_recipient() -> app.quota(company, 'reports_per_recipient')
--   app.download_refusal_for  app.limit_downloads_per_recipient()
--                               -> app.quota(r.company_id, 'downloads_per_recipient'), with F3's row.
--     NOT api.authorize_download, which delegates the comparison and holds no such expression: the
--     first version of the design named the wrong routine (E6D-C-F4) and a quota raised there would
--     change nothing while the catalog and the refusal drifted apart.
--   api.invite_member       two NEW bounds
--   api.accept_invitation   one NEW bound, plus the disjointness refusal
--   api.provision_company, api.add_operator   the disjointness refusals
--   app.lock_company        the access-period test; api.transfer_first_admin the operator lock
--
-- Untouched, with their reasons at 1.7: limit_witnesses_per_report, limit_envelopes_per_candidate,
-- limit_audience_groups, limit_assembled_bytes, limit_idempotency_rows, the idempotency intervals,
-- check_in_interval, every content bound.
-- ---------------------------------------------------------------------------

-- app.lock_company_operator: the row lock without the status or period test, for the EIGHT operator
-- routines only (1.5). api.set_company_status, api.set_access_period, api.set_company_quota,
-- api.close_company, api.delete_company, api.operator_expiry_run, api.operator_invite_admin and
-- api.transfer_first_admin take it; every member-facing routine keeps app.lock_company,
-- api.accept_invitation included. It takes the same row lock in the same place in the order (2.5) and
-- tests NEITHER the status NOR the access period: each of the eight applies its own rule to the row
-- it gets back, which is what lets an operator extend an expired agreement, resume a suspended
-- company, and close or delete one.
create or replace function app.lock_company_operator(p_company uuid) returns app.companies
language plpgsql set search_path = '' as $$
declare
  c app.companies;
begin
  select * into c from app.companies where id = p_company for no key update;
  if c.id is null then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  return c;
end $$;
revoke all on function app.lock_company_operator(uuid) from public;

-- app.lock_account and app.require_disjoint_principal: the two halves of E6S-C-F1's correction.
--
-- The defect. 1.1's disjointness was enforced at the three creation doors as an unlocked read of the OTHER
-- table, and nothing serialized the doors on the account they are about. The critique's schedule: a member's
-- acceptance reaches its disjointness test, finds no operator row, and then WAITS on the company lock; while it
-- waits the same account is made an operator through api.add_operator, which takes no company lock at all and
-- therefore never queues behind anything; the acceptance is then granted the company lock and inserts the
-- membership. One account, both principals (evidence/e6-server-critique.md E6S-C-F1).
--
-- app.lock_account is a transaction-scoped advisory lock keyed by the ACCOUNT, in the two-integer space
-- api.authorize_download already uses for (release, membership) pairs, under its own first key so the two
-- cannot collide. All three doors take it, and each re-reads BOTH identities under it after any wait, because a
-- lock without a re-read only moves the stale read later.
--
-- ITS PLACE IN THE LOCK ORDER IS LEVEL 0, BEFORE THE COMPANY LOCK (design 2.5, whose order is company,
-- membership, group, agent, candidate, release, claim). It cannot deadlock against the other two doors, and the
-- reason is the order itself rather than a schedule that happened to pass:
--   * each of the three doors takes it as the FIRST lock of any kind it takes, before app.lock_company,
--     app.lock_company_operator and app.new_company's own lock, so no transaction in the product ever holds a
--     company row and then waits for an account;
--   * no routine takes two account locks, so two account locks cannot cross;
--   * api.add_operator takes this lock and NOTHING else, so it can only ever be the waiting end.
-- A cycle needs some transaction waiting for an account lock while holding a company lock. There is none, which
-- is why the account lock extends design 2.5's order at the top instead of inverting it. tests/db/31 runs both
-- orders with pg_stat_database.deadlocks asserted unchanged.
--
-- api.create_company is NOT one of the three doors and does not take it: it creates an invitation and no
-- principal. Its operator-address refusal is an early answer whose authoritative copy is api.accept_invitation's,
-- and the worst a race there produces is an invitation that the acceptance below refuses.
create or replace function app.lock_account(p_user uuid) returns void
language plpgsql set search_path = '' as $$
begin
  if p_user is null then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('app.principal_of_account'), hashtext(p_user::text));
end $$;
revoke all on function app.lock_account(uuid) from public;

-- BOTH identities, read from current rows, in one place, so no door tests only the half it happens to be
-- creating. p_becoming names which principal the caller is about to create; the other table is the refusal.
-- The membership test carries api.add_operator's accepted rule unchanged: ANY status, because a removed
-- membership is still a person who read that company's content.
create or replace function app.require_disjoint_principal(p_user uuid, p_becoming text) returns void
language plpgsql stable set search_path = '' as $$
declare
  is_operator boolean;
  is_member   boolean;
begin
  select exists (select 1 from app.operators o where o.user_id = p_user),
         exists (select 1 from app.memberships m where m.user_id = p_user)
    into is_operator, is_member;
  if p_becoming = 'member' and is_operator then
    raise exception 'E_OPERATOR_ACCOUNT' using errcode = 'P0001';
  end if;
  if p_becoming = 'operator' and is_member then
    raise exception 'E_MEMBER_ACCOUNT' using errcode = 'P0001';
  end if;
end $$;
revoke all on function app.require_disjoint_principal(uuid, text) from public;

create or replace function app.lock_company(p_company uuid) returns void
language plpgsql set search_path = '' as $$
declare
  st text;
begin
  select status into st from app.companies where id = p_company for no key update;
  if st is null then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  if st <> 'active' then
    raise exception 'E_COMPANY_INACTIVE' using errcode = 'P0001';
  end if;
  -- E6 1.5: writes stop at ends_at. Every company-scoped mutation in the product calls this as its
  -- second step, so one test covers invitations, roles, removal, groups, drafts, submissions,
  -- successors, envelopes, reviews, publication, withdrawal, reports and witnesses. Reads are
  -- untouched: they go through app.is_active_member and app.has_role, neither of which calls this.
  -- api.authorize_download takes no company lock by design (E5 1.2), so a download during the export
  -- window continues, which is what "read and export window" means; app.download_refusal_for carries
  -- the export_by boundary instead (E6D-C-F3).
  if exists (select 1 from app.access_periods p
              where p.company_id = p_company and p.ends_at <= clock_timestamp()) then
    raise exception 'E_ACCESS_PERIOD_ENDED' using errcode = 'P0001';
  end if;
end $$;

create or replace function api.invite_member(p_company uuid, p_email text, p_roles text[],
  p_expires_in interval default interval '7 days')
returns table (invitation_id uuid, invite_code text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  admin app.memberships;
  email_n text := lower(btrim(p_email));
  roles_n text[];
  tok bytea;
  inv app.invitations;
  replaced uuid;
begin
  perform app.require_standing(p_company, actor);
  perform app.lock_company(p_company);
  admin := app.require_admin(p_company, actor);
  roles_n := app.normalize_roles(p_roles);
  if p_expires_in is null or p_expires_in <= interval '0' or p_expires_in > interval '30 days' then
    raise exception 'E_EXPIRY_INVALID' using errcode = '22023';
  end if;
  if exists (select 1 from app.memberships m where m.company_id = p_company and m.status = 'active'
             and m.user_id = (select u.id from auth.users u where lower(u.email) = email_n)) then
    raise exception 'E_ALREADY_MEMBER' using errcode = 'P0001';
  end if;
  -- E6 1.7, the two new bounds. Both counts are taken NET of the pending sibling this call is about
  -- to revoke below (E6D-C-F7 settled here): replacing an invitation adds no reservation, so a resend
  -- at either ceiling was refused although the company's totals do not move. The sibling is excluded
  -- by the same address predicate the revocation uses, and the unique index invitations_one_pending
  -- means there is at most one. Both counts run under the company lock this routine already holds.
  if (select count(*) from app.invitations i
       where i.company_id = p_company and i.accepted_at is null and i.revoked_at is null
         and i.expires_at > clock_timestamp()
         and i.email_normalized <> email_n)
     >= app.quota(p_company, 'pending_invitations_per_company') then
    raise exception 'E_INVITATION_LIMIT' using errcode = 'P0001';
  end if;
  -- Seats: active memberships plus live pending invitations, DEFENSE IN DEPTH (design 3.1 labels it
  -- so). The authoritative check is in api.accept_invitation under the company lock, which is where a
  -- membership is actually created. The E_ALREADY_MEMBER test above means the target holds no active
  -- membership here. app.operator_invitation (B6) is the operator's issuing path and carries neither
  -- bound: its succession invitation's one seat of headroom is granted authoritatively at acceptance
  -- (1.3, E6D-C-F5).
  if (select count(*) from app.memberships m
       where m.company_id = p_company and m.status = 'active')
     + (select count(*) from app.invitations i
         where i.company_id = p_company and i.accepted_at is null and i.revoked_at is null
           and i.expires_at > clock_timestamp()
           and i.email_normalized <> email_n)
     >= app.quota(p_company, 'members_per_company') then
    raise exception 'E_SEATS_EXHAUSTED' using errcode = 'P0001';
  end if;
  -- One pending invitation per email per company (unique index invitations_one_pending):
  -- revoke the pending sibling first; its audit row is written below with the new id.
  update app.invitations set revoked_at = now()
  where company_id = p_company and email_normalized = email_n
    and accepted_at is null and revoked_at is null
  returning id into replaced;
  tok := extensions.gen_random_bytes(32);
  insert into app.invitations (company_id, email_normalized, token_hash, roles, expires_at, created_by)
  values (p_company, email_n, extensions.digest(tok, 'sha256'), roles_n, now() + p_expires_in, admin.id)
  returning * into inv;
  if replaced is not null then
    perform app.audit(p_company, actor, 'member', 'invitation.revoke', 'invitation', replaced,
      jsonb_build_object('invitation_id', replaced, 'membership_id', admin.id,
                         'reason_code', 'replaced', 'replaced_by_invitation_id', inv.id));
  end if;
  perform app.audit(p_company, actor, 'member', 'invitation.create', 'invitation', inv.id,
    jsonb_build_object('invitation_id', inv.id, 'roles', inv.roles, 'expires_at', inv.expires_at,
                       'membership_id', admin.id)
    || case when replaced is null then '{}'::jsonb
            else jsonb_build_object('replaces_invitation_id', replaced) end);
  return query select inv.id, encode(tok, 'hex'), inv.expires_at;
end $$;

create or replace function api.accept_invitation(p_invite_code text)
returns table (membership_id uuid, company_id uuid, roles text[], reactivated boolean)
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  tok bytea;
  inv app.invitations;
  u_email text;
  u_confirmed timestamptz;
  m app.memberships;
  was_removed boolean := false;
  seat_bonus integer;
  decided_at timestamptz;
begin
  -- E6 1.1 (E6D-C-F1c) and E6S-C-F1: operators and members are disjoint, and the rule lives where a membership
  -- is created. The ACCOUNT LOCK comes first, above every other test, so an operator's account learns nothing
  -- about a token's validity and so api.add_operator cannot make this same account an operator while this
  -- transaction waits for the company lock below. Level 0 of design 2.5's order; the argument that it cannot
  -- deadlock is at app.lock_account.
  perform app.lock_account(actor);
  perform app.require_disjoint_principal(actor, 'member');
  begin
    tok := decode(p_invite_code, 'hex');
  exception when others then
    raise exception 'E_INVITATION_INVALID' using errcode = 'P0002';
  end;
  if octet_length(tok) <> 32 then
    raise exception 'E_INVITATION_INVALID' using errcode = 'P0002';
  end if;
  -- Locate without locking, then lock the company, then re-read the invitation under lock.
  select * into inv from app.invitations where token_hash = extensions.digest(tok, 'sha256');
  if inv.id is null then
    raise exception 'E_INVITATION_INVALID' using errcode = 'P0002';
  end if;
  perform app.lock_company(inv.company_id);
  -- E6S-C-F1: the lock above is the one wait in this routine, and BOTH identities are re-read under the account
  -- lock after it. The account lock makes the second read redundant against the three doors themselves; it is
  -- here because a lock whose only proof is that nothing else takes it is a lock nobody can check, and this read
  -- is one index probe on a primary key.
  perform app.require_disjoint_principal(actor, 'member');
  select * into inv from app.invitations where id = inv.id for update;
  decided_at := clock_timestamp();
  if inv.accepted_at is not null or inv.revoked_at is not null or inv.expires_at <= decided_at then
    raise exception 'E_INVITATION_INVALID' using errcode = 'P0002';
  end if;
  select lower(u.email), u.email_confirmed_at into u_email, u_confirmed from auth.users u where u.id = actor;
  if u_email is null or u_confirmed is null or u_email <> inv.email_normalized then
    raise exception 'E_EMAIL_MISMATCH' using errcode = '42501';
  end if;
  select * into m from app.memberships where memberships.company_id = inv.company_id and user_id = actor for update;
  -- E6 1.7, the AUTHORITATIVE seat check (design 3.1), only when this acceptance would ADD an active
  -- membership: a reactivation counts, an active member's role replacement does not. Two invitations
  -- accepted at once serialize on the company lock this routine already holds, so the second sees the
  -- first one's membership.
  -- The one named exception is the operator's succession invitation and it is worth EXACTLY ONE seat
  -- (1.3, E6D-C-F5): a company that has used it sits at quota + 1, so the next succession acceptance
  -- compares quota + 1 >= quota + 1 and is refused. Without this the rescue of 1.3 issues an
  -- invitation nobody can accept. The exception's authority is the operator's recorded act and not a
  -- derived state: the database cannot see whether an admin can reach aal2.
  -- The bonus is computed into a variable rather than inlined in the IF condition, which is what
  -- design 2.3 B5 wrote: PL/pgSQL ends an IF condition at the first THEN token, so a CASE expression
  -- inside one is a syntax error at end of input (E6DB-F1, reproduced at
  -- evidence/e6-db-repro/f1-accept-invitation-case-in-if.log).
  if m.id is null or m.status = 'removed' then
    seat_bonus := case when inv.created_by_operator is not null
                            and 'company_admin' = any (inv.roles) then 1 else 0 end;
    if (select count(*) from app.memberships m2
         where m2.company_id = inv.company_id and m2.status = 'active')
       >= app.quota(inv.company_id, 'members_per_company') + seat_bonus then
      raise exception 'E_SEATS_EXHAUSTED' using errcode = 'P0001';
    end if;
  end if;
  if m.id is null then
    insert into app.memberships (company_id, user_id, status, roles)
    values (inv.company_id, actor, 'active', inv.roles) returning * into m;
  elsif m.status = 'removed' then
    was_removed := true;
    update app.memberships set status = 'active', removed_at = null, roles = inv.roles
    where id = m.id returning * into m;
  else
    -- Already active: accepting a second invitation replaces roles (admin-issued), and
    -- may not demote the last admin.
    if 'company_admin' = any (m.roles) and not ('company_admin' = any (inv.roles))
       and app.active_admin_count(inv.company_id, m.id) = 0 then
      raise exception 'E_LAST_ADMIN' using errcode = 'P0001';
    end if;
    update app.memberships set roles = inv.roles where id = m.id returning * into m;
  end if;
  update app.invitations set accepted_at = decided_at, accepted_membership_id = m.id where id = inv.id;
  perform app.audit(inv.company_id, actor, 'member', 'invitation.accept', 'membership', m.id,
    jsonb_build_object('invitation_id', inv.id, 'membership_id', m.id, 'roles_after', m.roles,
                       'reactivated', was_removed), decided_at);
  return query select m.id, m.company_id, m.roles, was_removed;
end $$;

create or replace function api.add_operator(p_user uuid)
returns table (user_id uuid, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  op uuid := app.operator_actor();
begin
  -- E6 1.1 (E6D-C-F1c) and E6S-C-F1: any status. A removed membership is still a person who read that company's
  -- content, and reactivation is one accepted invitation away, so admitting a removed member as an operator would
  -- mean a Phaeacia account that can be made a customer's member again unnoticed.
  -- The ACCOUNT LOCK is taken first and is the only lock this routine takes, so it can only ever be the waiting
  -- end of the three doors (app.lock_account). BOTH identities are then read under it: this routine used to test
  -- the membership table alone and to test it without holding anything, which is how the critique's schedule put
  -- an operator row and a membership row on one account.
  -- Above the idempotent branch, so an account that should never have been an operator is refused rather than
  -- answered changed: false.
  perform app.lock_account(p_user);
  perform app.require_disjoint_principal(p_user, 'operator');
  if exists (select 1 from app.operators o where o.user_id = p_user) then
    return query select p_user, false;
    return;
  end if;
  insert into app.operators (user_id) values (p_user);
  perform app.audit(null, op, 'operator', 'operator.add', 'operator', p_user,
    jsonb_build_object('user_id', p_user, 'operator_user_id', op));
  return query select p_user, true;
end $$;

create or replace function api.transfer_first_admin(p_company uuid, p_target_user uuid)
returns table (membership_id uuid, roles text[], changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  op uuid := app.operator_actor();
  c app.companies;
  m app.memberships;
  new_roles text[];
begin
  -- E6 1.3 and 1.5 (E6D-C-F5): on app.lock_company this routine could not grant an administrator to a
  -- suspended company or to one past its access period, which is exactly when a customer asks for one.
  -- It takes the operator lock and applies its own status rule: active and suspended are admitted,
  -- closed is refused. Accepting the resulting invitation still passes app.lock_company, so the
  -- operator's sequence for a suspended or expired company is to extend the period with
  -- api.set_access_period or resume with api.set_company_status FIRST, then the invitee accepts.
  c := app.lock_company_operator(p_company);
  if c.status = 'closed' then
    raise exception 'E_COMPANY_CLOSED' using errcode = 'P0001';
  end if;
  select * into m from app.memberships where memberships.company_id = p_company and user_id = p_target_user for update;
  if m.id is null or m.status <> 'active' then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  if 'company_admin' = any (m.roles) then
    return query select m.id, m.roles, false;
    return;
  end if;
  new_roles := (select array_agg(distinct r order by r) from unnest(array_append(m.roles, 'company_admin')) r);
  update app.memberships set roles = new_roles where id = m.id;
  perform app.audit(p_company, op, 'operator', 'membership.transfer_first_admin', 'membership', m.id,
    jsonb_build_object('membership_id', m.id, 'roles_before', m.roles, 'roles_after', new_roles, 'operator_user_id', op));
  return query select m.id, new_roles, true;
end $$;

create or replace function app.download_refusal_for(r app.releases, p_membership uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when r.state <> 'published' then 'E_RELEASE_WITHDRAWN'
    when r.superseded_by_release_id is not null then 'E_RELEASE_SUPERSEDED'
    when not exists (select 1 from app.memberships m join app.companies c on c.id = m.company_id
                      where m.id = p_membership and m.company_id = r.company_id
                        and m.status = 'active' and c.status = 'active') then 'E_NOT_FOUND'
    -- E6 1.5 (E6D-C-F3): api.authorize_download takes no company lock (E5 1.2), so app.lock_company's
    -- write test never reaches it, which is correct between ends_at and export_by and wrong after it.
    -- Tested from TIME and not from companies.status, so the window closes whether or not
    -- api.operator_expiry_run has been pressed. Below the membership row on purpose: the caller's
    -- standing in the company is established first, so the company's window is not a fact a stranger
    -- learns. The catalog's blockedReason and api.authorize_download's refusal stay one rule.
    when exists (select 1 from app.access_periods p
                  where p.company_id = r.company_id and p.export_by <= clock_timestamp())
      then 'E_ACCESS_PERIOD_ENDED'
    when exists (select 1 from app.agents a where a.id = r.agent_id and a.status = 'orphaned')
      then 'E_AGENT_ORPHANED'
    when not exists (select 1 from app.agents a where a.id = r.agent_id and a.status = 'active')
      then 'E_AGENT_ARCHIVED'
    when not exists (select 1 from app.release_targets t where t.target = r.target and t.publishable)
      then 'E_TARGET_NOT_PUBLISHABLE'
    when not exists (select 1 from app.group_members gm
                      where gm.membership_id = p_membership and gm.group_id = any (r.audience_group_ids))
      then 'E_NOT_FOUND'
    when (select count(*) from app.release_downloads d
           where d.release_id = r.id and d.membership_id = p_membership)
         >= app.quota(r.company_id, 'downloads_per_recipient') then 'E_DOWNLOAD_LIMIT'
    else null end
$$;

-- What a company row IS, in one place, so a change to it cannot land in api.create_company (B6, the product
-- path) and not in api.provision_company (the seed's path) or the other way round (design 1.1, 2.3 B6). It
-- inserts the row and takes the company lock; it creates no membership and writes NO audit row, because the
-- two callers' company.provision rows differ: api.provision_company's carries membership_id and
-- api.create_company creates no membership at all. Putting the audit here would have silently dropped
-- membership_id from an accepted audit row, which is a change nobody asked for (E6DB-F2). It takes
-- app.lock_company_operator rather than 001's app.lock_company: the row was inserted by this transaction, so
-- it is active and has no access period, and both helpers behave identically on it, but the operator one
-- cannot meet a refusal that is about a company an operator is correcting (design 2.3 B5).
-- Design 2.3 B6 lists this helper under the operator surface; it is written here because api.provision_company
-- in B5 is its first caller and a reader follows the file downwards.
create or replace function app.new_company(p_slug text, p_name text, p_operator uuid) returns app.companies
language plpgsql set search_path = '' as $$
declare
  c app.companies;
begin
  insert into app.companies (slug, name) values (p_slug, p_name) returning * into c;
  perform app.lock_company_operator(c.id);
  return c;
end $$;
revoke all on function app.new_company(text, text, uuid) from public;

create or replace function api.provision_company(p_slug text, p_name text, p_first_admin_user uuid)
returns table (company_id uuid, membership_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  op uuid := app.operator_actor();
  c app.companies;
  m app.memberships;
begin
  if not exists (select 1 from auth.users u where u.id = p_first_admin_user and u.email_confirmed_at is not null) then
    raise exception 'E_USER_NOT_FOUND' using errcode = 'P0002';
  end if;
  -- E6 1.1 (E6D-C-F1c) and E6S-C-F1: an operator's account may not become the first admin of a company. The
  -- ACCOUNT LOCK is taken before the company row is inserted and locked, which is level 0 of design 2.5's order
  -- (app.lock_account), and BOTH identities are read under it. This routine has no wait of its own, because
  -- app.new_company locks a company row no other transaction can see, so the read under the lock is the only one
  -- it needs.
  perform app.lock_account(p_first_admin_user);
  perform app.require_disjoint_principal(p_first_admin_user, 'member');
  -- E6 1.1: the company row and its lock come from app.new_company, which api.create_company also calls, so
  -- the two entry points differ only in how the first admin arrives. The insert, the lock, the membership and
  -- the audit row are otherwise 001's, unchanged.
  c := app.new_company(p_slug, p_name, op);
  insert into app.memberships (company_id, user_id, roles)
  values (c.id, p_first_admin_user, array['company_admin', 'member']) returning * into m;
  perform app.audit(c.id, op, 'operator', 'company.provision', 'company', c.id,
    jsonb_build_object('company_id', c.id, 'membership_id', m.id, 'operator_user_id', op));
  return query select c.id, m.id;
end $$;

create or replace function api.create_draft(p_company uuid, p_agent uuid, p_agent_name text, p_content text,
  p_derived_canonical text, p_gate_identity bytea, p_idempotency_key uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.bound_actor('create_draft', sha256(convert_to(concat_ws(E'\n', 'create_draft', coalesce(p_company::text, '-'), coalesce(p_agent::text, '-'), coalesce(encode(sha256(convert_to(p_agent_name, 'UTF8')), 'hex'), '-'), coalesce(encode(sha256(convert_to(p_content, 'UTF8')), 'hex'), '-'), coalesce(encode(sha256(convert_to(p_derived_canonical, 'UTF8')), 'hex'), '-'), coalesce(encode(p_gate_identity, 'hex'), '-'), coalesce(p_idempotency_key::text, '-')), 'UTF8')));
  operation bytea := sha256(convert_to(concat_ws(E'\n', 'create_draft', coalesce(p_company::text, '-'), coalesce(p_agent::text, '-'), coalesce(encode(sha256(convert_to(p_agent_name, 'UTF8')), 'hex'), '-'), coalesce(encode(sha256(convert_to(p_content, 'UTF8')), 'hex'), '-')), 'UTF8'));
  member_id uuid;
  ag app.agents;
  gate uuid;
  replay jsonb;
  cand app.candidate_versions;
  result jsonb;
begin
  -- Exactly one of p_agent and p_agent_name (design 4.4), a defensive repeat of the handler's rule.
  if p_company is null or p_content is null or p_derived_canonical is null or p_gate_identity is null
     or p_idempotency_key is null or (p_agent is null) = (p_agent_name is null)
     or (p_agent_name is not null and p_agent_name !~ '^[a-z0-9][a-z0-9.-]{0,63}$') then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  perform app.require_standing(p_company, actor);
  perform app.lock_company(p_company);
  perform app.require_standing(p_company, actor);
  member_id := app.membership_of(p_company, actor);
  if p_agent is not null then
    select * into ag from app.agents g where g.id = p_agent for update;
    -- Ownership (H2): a named agent belongs to the route's company, or it is not found.
    if ag.id is null or ag.company_id <> p_company then
      raise exception 'E_NOT_FOUND' using errcode = 'P0002';
    end if;
  else
    select * into ag from app.agents g where g.company_id = p_company and g.name = p_agent_name for update;
  end if;
  replay := app.idempotency_lookup(member_id, p_idempotency_key, 'create_draft', operation);
  if replay is not null then
    return replay;
  end if;
  perform app.idempotency_ceiling(member_id);
  if p_agent is null then
    -- A name that exists is taken, whoever owns it: adding to an existing agent names its id.
    if ag.id is not null then
      raise exception 'E_AGENT_NAME_TAKEN' using errcode = 'P0001';
    end if;
    if (select count(*) from app.agents g where g.company_id = p_company) >= app.quota(p_company, 'agents_per_company') then
      raise exception 'E_AGENT_LIMIT' using errcode = 'P0001';
    end if;
  else
    if ag.status = 'archived' then
      raise exception 'E_AGENT_ARCHIVED' using errcode = 'P0001';
    end if;
    if (select count(*) from app.candidate_versions v where v.agent_id = ag.id) >= app.quota(p_company, 'versions_per_agent') then
      raise exception 'E_VERSION_LIMIT' using errcode = 'P0001';
    end if;
  end if;
  gate := app.active_gate(p_gate_identity);
  if ag.id is null then
    insert into app.agents (company_id, name, creator_membership_id, owner_membership_id)
    values (p_company, p_agent_name, member_id, member_id)
    returning * into ag;
    perform app.audit(p_company, actor, 'member', 'agent.create', 'agent', ag.id,
      jsonb_build_object('agent_id', ag.id, 'membership_id', member_id, 'agent_status_after', ag.status));
  end if;
  -- The agent's next sequence, read under the agent lock (design 1.4).
  insert into app.candidate_versions (company_id, agent_id, sequence, author_membership_id, content,
                                      derived_canonical, gate_id, attested_by)
  values (p_company, ag.id,
          (select coalesce(max(v.sequence), 0) + 1 from app.candidate_versions v where v.agent_id = ag.id),
          member_id, p_content, p_derived_canonical, gate, member_id)
  returning * into cand;
  insert into app.candidate_contributors (candidate_id, membership_id, kind, observed)
  values (cand.id, member_id, 'author', true);
  perform app.audit(p_company, actor, 'member', 'candidate.create', 'candidate', cand.id,
    app.candidate_audit_details(cand));
  result := app.candidate_response(cand);
  perform app.idempotency_claim(member_id, p_idempotency_key, 'create_draft', operation, result);
  return result;
end $$;

create or replace function api.create_successor(p_candidate uuid, p_content_sha256 bytea, p_derived_canonical text,
  p_gate_identity bytea, p_idempotency_key uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.bound_actor('create_successor', sha256(convert_to(concat_ws(E'\n', 'create_successor', coalesce(p_candidate::text, '-'), coalesce(encode(p_content_sha256, 'hex'), '-'), coalesce(encode(sha256(convert_to(p_derived_canonical, 'UTF8')), 'hex'), '-'), coalesce(encode(p_gate_identity, 'hex'), '-'), coalesce(p_idempotency_key::text, '-')), 'UTF8')));
  operation bytea := sha256(convert_to(concat_ws(E'\n', 'create_successor', coalesce(p_candidate::text, '-')), 'UTF8'));
  company uuid;
  member_id uuid;
  ag app.agents;
  parent app.candidate_versions;
  succ app.candidate_versions;
  gate uuid;
  replay jsonb;
  inherited integer;
  result jsonb;
begin
  if p_candidate is null or p_content_sha256 is null or p_derived_canonical is null or p_gate_identity is null
     or p_idempotency_key is null then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  select v.company_id into company from app.candidate_versions v where v.id = p_candidate;
  if company is null then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_standing(company, actor);
  perform app.lock_company(company);
  perform app.require_standing(company, actor);
  member_id := app.membership_of(company, actor);
  select * into ag from app.agents g
   where g.id = (select v.agent_id from app.candidate_versions v where v.id = p_candidate) for update;
  select * into parent from app.candidate_versions v where v.id = p_candidate for update;
  -- Ownership (H3): the same permission as reading the parent's content, one predicate.
  if not app.candidate_visible_to(p_candidate, actor) then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  replay := app.idempotency_lookup(member_id, p_idempotency_key, 'create_successor', operation);
  if replay is not null then
    return replay;
  end if;
  perform app.idempotency_ceiling(member_id);
  -- Not in 4.5's table: a parent that is not changes_requested has no successor edge, so it is
  -- refused as a transition the lifecycle does not contain.
  if parent.state <> 'changes_requested' then
    raise exception 'E_STATE_TRANSITION' using errcode = 'P0001';
  end if;
  if ag.status = 'archived' then
    raise exception 'E_AGENT_ARCHIVED' using errcode = 'P0001';
  end if;
  if (select count(*) from app.candidate_versions v where v.agent_id = ag.id) >= app.quota(company, 'versions_per_agent') then
    raise exception 'E_VERSION_LIMIT' using errcode = 'P0001';
  end if;
  gate := app.active_gate(p_gate_identity);
  -- The service gated the bytes whose hash it passed; the copy below is taken only if those are the
  -- locked parent's bytes, so the gated bytes are the stored bytes.
  if parent.content_sha256 <> p_content_sha256 then
    raise exception 'E_CONTENT_CHANGED' using errcode = 'P0001';
  end if;
  if exists (select 1 from app.candidate_versions v where v.supersedes_candidate_id = parent.id) then
    raise exception 'E_SUCCESSOR_EXISTS' using errcode = 'P0001';
  end if;
  insert into app.candidate_versions (company_id, agent_id, sequence, author_membership_id, supersedes_candidate_id,
                                      content, derived_canonical, gate_id, attested_by)
  values (company, ag.id,
          (select coalesce(max(v.sequence), 0) + 1 from app.candidate_versions v where v.agent_id = ag.id),
          member_id, parent.id, parent.content, p_derived_canonical, gate, member_id)
  returning * into succ;
  -- B4: every contributor of the parent, kind and observation kept, marked as inherited from it.
  insert into app.candidate_contributors (candidate_id, membership_id, kind, display_name,
                                          inherited_from_candidate_id, observed)
  select succ.id, k.membership_id, k.kind, k.display_name, parent.id, k.observed
    from app.candidate_contributors k where k.candidate_id = parent.id;
  get diagnostics inherited = row_count;
  insert into app.candidate_contributors (candidate_id, membership_id, kind, observed)
  values (succ.id, member_id, 'author', true)
  on conflict do nothing;
  perform app.audit(company, actor, 'member', 'candidate.successor', 'candidate', succ.id,
    app.candidate_audit_details(succ));
  result := app.candidate_response(succ) || jsonb_build_object('inherited_contributors', inherited);
  perform app.idempotency_claim(member_id, p_idempotency_key, 'create_successor', operation, result);
  return result;
end $$;

create or replace function api.create_group(p_company uuid, p_name text)
returns table (group_id uuid, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  admin app.memberships;
  v text := btrim(p_name, ' ');
  g app.groups;
begin
  if v is null or char_length(v) not between 1 and 80
     or exists (select 1 from string_to_table(v, null) ch
                where ascii(ch) between 1 and 31 or ascii(ch) between 127 and 159
                   or ascii(ch) in (1564, 8206, 8207)
                   or ascii(ch) between 8234 and 8238 or ascii(ch) between 8294 and 8297) then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  perform app.require_standing(p_company, actor);
  perform app.lock_company(p_company);
  admin := app.require_admin(p_company, actor);
  if exists (select 1 from app.groups x where x.company_id = p_company and x.name = v) then
    raise exception 'E_GROUP_NAME_TAKEN' using errcode = 'P0001';
  end if;
  if (select count(*) from app.groups x where x.company_id = p_company) >= app.quota(p_company, 'groups_per_company') then
    raise exception 'E_GROUP_LIMIT' using errcode = 'P0001';
  end if;
  insert into app.groups (company_id, name, created_by_membership_id)
  values (p_company, v, admin.id)
  returning * into g;
  perform app.audit(p_company, actor, 'member', 'group.create', 'group', g.id,
    jsonb_build_object('group_id', g.id, 'membership_id', admin.id));
  return query select g.id, true;
end $$;

create or replace function api.report_installation(p_release uuid, p_status text, p_losses text, p_assistance text,
  p_idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.bound_actor('report_installation', sha256(convert_to(concat_ws(E'\n', 'report_installation', coalesce(p_release::text, '-'), coalesce(encode(sha256(convert_to(p_status, 'UTF8')), 'hex'), '-'), coalesce(encode(sha256(convert_to(p_losses, 'UTF8')), 'hex'), '-'), coalesce(encode(sha256(convert_to(p_assistance, 'UTF8')), 'hex'), '-'), coalesce(p_idempotency_key::text, '-')), 'UTF8')));
  operation bytea := sha256(convert_to(concat_ws(E'\n', 'report_installation', coalesce(p_release::text, '-'), coalesce(encode(sha256(convert_to(p_status, 'UTF8')), 'hex'), '-'), coalesce(encode(sha256(convert_to(p_losses, 'UTF8')), 'hex'), '-'), coalesce(encode(sha256(convert_to(p_assistance, 'UTF8')), 'hex'), '-')), 'UTF8'));
  v_losses text;
  v_assistance text;
  company uuid;
  member_id uuid;
  replay jsonb;
  rpt app.installation_reports;
  result jsonb;
begin
  -- row 14. The text rule is E3's and E4's one rule, app.review_reason, reused rather than written a second time; a
  -- whitespace-only losses trims to nothing and is E_BODY_INVALID here, not E_LOSSES_REQUIRED below (E5D-C-F9).
  if p_release is null or p_status is null or p_idempotency_key is null then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  if not (p_status = any (app.installation_statuses())) then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  if p_losses is not null then
    v_losses := app.review_reason(p_losses);
  end if;
  if p_assistance is not null then
    v_assistance := app.review_reason(p_assistance);
  end if;
  -- row 15
  select r.company_id into company from app.releases r where r.id = p_release;
  if company is null then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_standing(company, actor);
  -- rows 16 and 17
  perform app.lock_company(company);
  perform app.require_standing(company, actor);
  member_id := app.membership_of(company, actor);
  perform 1 from app.memberships m where m.id = member_id for update;
  perform 1 from app.releases r where r.id = p_release for share;
  -- row 18. A recipient removed from the audience still reads the release through the own-ledger arm of B4, so they can
  -- still report on what they installed (E5D-C-F4).
  if not app.release_visible_to(p_release, actor) then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  -- rows 19 to 21
  replay := app.idempotency_lookup(member_id, p_idempotency_key, 'report_installation', operation);
  if replay is not null then
    return replay;
  end if;
  -- row 22
  perform app.idempotency_ceiling(member_id);
  -- row 23: a report needs a download. The architecture's "Report own installation outcome: yes (own downloads)".
  if not exists (select 1 from app.release_downloads d
                  where d.release_id = p_release and d.membership_id = member_id) then
    raise exception 'E_NOT_DOWNLOADED' using errcode = 'P0001';
  end if;
  -- row 24: a partial or failed installation with no statement of what did not come across is not evidence.
  if v_losses is null and p_status in ('partial', 'fail') then
    raise exception 'E_LOSSES_REQUIRED' using errcode = '22023';
  end if;
  -- row 25
  if (select count(*) from app.installation_reports p
       where p.release_id = p_release and p.membership_id = member_id)
     >= app.quota(company, 'reports_per_recipient') then
    raise exception 'E_REPORT_LIMIT' using errcode = 'P0001';
  end if;
  -- The caller chooses status, losses and assistance and nothing else: the company, the release, the membership, the
  -- time and the source are the routine's (design 1.4a). p_source is not a parameter, so a member cannot label their
  -- own statement as a founder-run transfer (design 1.5).
  insert into app.installation_reports (company_id, release_id, membership_id, status, losses, assistance, source)
  values (company, p_release, member_id, p_status, v_losses, v_assistance, 'recipient_app')
  returning * into rpt;
  perform app.audit(company, actor, 'member', 'installation.report', 'release', p_release,
    jsonb_build_object('report_id', rpt.id, 'release_id', p_release, 'membership_id', member_id,
                       'installation_status', rpt.status, 'installation_source', rpt.source));
  result := app.installation_response(rpt);
  perform app.idempotency_claim(member_id, p_idempotency_key, 'report_installation', operation, result);
  return result;
end $$;

-- ---------------------------------------------------------------------------
-- B6. The operator surface (design 1.1). One helper per rule. app.operator_company_row is the ONLY
--     function that turns a company into something an operator reads: that is 1.1's named boundary, and a
--     later routine that wants a wider field adds it HERE, under the comment that says what the line is,
--     and nowhere else. tests/e6/unit/operator-surface.test.mjs reads this migration's text and fails when
--     an operator-facing routine selects a tenant content column outside this helper.
--
--     Every jsonb key below is snake_case, which is the accepted database convention (007's
--     app.installation_response, app.release_response); the services lane maps to the camelCase of design
--     3.4. evidence/e6-db.md section 5 carries the mapping.
-- ---------------------------------------------------------------------------

-- The two byte sums, in one place, because gate 1 of the export (design 1.6), the register and the manifest
-- must use the same arithmetic.
create or replace function app.company_content_bytes(p_company uuid) returns bigint
language sql stable set search_path = '' as $$
  select coalesce((select sum(octet_length(v.content)) from app.candidate_versions v
                    where v.company_id = p_company), 0)::bigint
$$;
create or replace function app.company_assembled_bytes(p_company uuid) returns bigint
language sql stable set search_path = '' as $$
  select coalesce((select sum(octet_length(r.assembled_content)) from app.releases r
                    where r.company_id = p_company), 0)::bigint
$$;
revoke all on function app.company_content_bytes(uuid), app.company_assembled_bytes(uuid) from public;

-- The twenty-one section names of design 1.6, in one place, counted UNFILTERED: the manifest counts the whole
-- company because a count is not content, which is how Phaeacia can tell a customer their own export is three
-- rows short and why, without reading one of them (design 1.6).
create or replace function app.export_section_counts(p_company uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'access_periods', (select count(*) from app.access_periods p where p.company_id = p_company),
    'company_quotas', (select count(*) from app.company_quotas q where q.company_id = p_company),
    'memberships', (select count(*) from app.memberships m where m.company_id = p_company),
    'invitations', (select count(*) from app.invitations i where i.company_id = p_company),
    'profiles', (select count(*) from app.profiles f
                  where exists (select 1 from app.memberships m
                                 where m.company_id = p_company and m.user_id = f.user_id)),
    'groups', (select count(*) from app.groups g where g.company_id = p_company),
    'group_members', (select count(*) from app.group_members gm where gm.company_id = p_company),
    'agents', (select count(*) from app.agents a where a.company_id = p_company),
    'candidate_versions', (select count(*) from app.candidate_versions v where v.company_id = p_company),
    'candidate_contributors', (select count(*) from app.candidate_contributors cc
                                where exists (select 1 from app.candidate_versions v
                                               where v.id = cc.candidate_id and v.company_id = p_company)),
    'review_envelopes', (select count(*) from app.review_envelopes e where e.company_id = p_company),
    'reviews', (select count(*) from app.reviews r where r.company_id = p_company),
    'releases', (select count(*) from app.releases r where r.company_id = p_company),
    'release_downloads', (select count(*) from app.release_downloads d where d.company_id = p_company),
    'installation_reports', (select count(*) from app.installation_reports p where p.company_id = p_company),
    'installation_witnesses', (select count(*) from app.installation_witnesses w where w.company_id = p_company),
    'audit_events', (select count(*) from app.audit_events a where a.company_id = p_company),
    'release_targets', (select count(*) from app.release_targets t
                         where t.target in (select r.target from app.releases r where r.company_id = p_company
                                            union select e.target from app.review_envelopes e
                                                   where e.company_id = p_company)),
    'installer_texts', (select count(*) from app.installer_texts it
                         where (it.gate_id, it.target) in
                           (select r.gate_id, r.target from app.releases r where r.company_id = p_company
                            union select e.gate_id, e.target from app.review_envelopes e
                                   where e.company_id = p_company)),
    'release_policies', (select count(*) from app.release_policies pol
                          where pol.id in (select r.policy_id from app.releases r where r.company_id = p_company
                                           union select e.policy_id from app.review_envelopes e
                                                  where e.company_id = p_company)),
    'gate_identities', (select count(*) from app.gate_identities gi
                         where gi.id in (select v.gate_id from app.candidate_versions v
                                          where v.company_id = p_company
                                         union select r.gate_id from app.releases r where r.company_id = p_company
                                         union select e.gate_id from app.review_envelopes e
                                                where e.company_id = p_company)))
$$;
revoke all on function app.export_section_counts(uuid) from public;

-- The manifest arm: the row count of each of the export's twenty-one sections, the two byte sums, gate 1's
-- estimate of the serialized size and whether that is over the route's ceiling. Counts only, cut by the
-- export's section list instead of the register's (design 1.1, E6D-C-F1a). It exists because the operator is
-- NOT a caller of api.export_company, and a support call still has to be able to say whether the customer's
-- own admin can take the export through HTTP or whether it needs E7's owner-side script.
-- The estimate is gate 1's, doubled for JSON escaping, and is labelled an estimate wherever it is rendered.
create or replace function app.export_manifest_row(p_company uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'sections', app.export_section_counts(p_company),
    'content_bytes', app.company_content_bytes(p_company),
    'assembled_bytes', app.company_assembled_bytes(p_company),
    'estimated_serialized_bytes',
      2 * (app.company_content_bytes(p_company) + app.company_assembled_bytes(p_company)),
    'route_ceiling_bytes', app.limit_export_bytes(),
    'over_route_ceiling',
      2 * (app.company_content_bytes(p_company) + app.company_assembled_bytes(p_company))
        > app.limit_export_bytes())
$$;
revoke all on function app.export_manifest_row(uuid) from public;

-- The count the refusing routine takes, per quota name, so the register's `used` cannot disagree with the
-- refusal a caller meets. For the three per-agent and per-recipient quotas the refusal compares ONE agent's
-- or ONE recipient's count, so `used` is the largest such count in the company: the number that says how
-- close this company is to meeting the refusal. evidence/e6-db.md section 5 states that for the services lane.
create or replace function app.quota_used(p_company uuid, p_name text) returns integer
language sql stable set search_path = '' as $$
  select case p_name
    when 'members_per_company' then
      (select count(*)::int from app.memberships m where m.company_id = p_company and m.status = 'active')
    when 'pending_invitations_per_company' then
      (select count(*)::int from app.invitations i
        where i.company_id = p_company and i.accepted_at is null and i.revoked_at is null
          and i.expires_at > clock_timestamp())
    when 'agents_per_company' then
      (select count(*)::int from app.agents a where a.company_id = p_company)
    when 'groups_per_company' then
      (select count(*)::int from app.groups g where g.company_id = p_company)
    when 'versions_per_agent' then
      coalesce((select max(n)::int from (select count(*) as n from app.candidate_versions v
                                          where v.company_id = p_company group by v.agent_id) x), 0)
    when 'downloads_per_recipient' then
      coalesce((select max(n)::int from (select count(*) as n from app.release_downloads d
                                          where d.company_id = p_company
                                          group by d.release_id, d.membership_id) x), 0)
    when 'reports_per_recipient' then
      coalesce((select max(n)::int from (select count(*) as n from app.installation_reports p
                                          where p.company_id = p_company
                                          group by p.release_id, p.membership_id) x), 0)
  end
$$;
revoke all on function app.quota_used(uuid, text) from public;

-- The register's per-company object, and the export manifest's when p_manifest is true. COUNTS ONLY: no
-- agent name, no group name, no candidate title, no member address, no display name, no review reason, no
-- report text, no passport byte. slug and name are the company's identity, chosen by the operator at
-- provisioning, so they are not tenant content (design 1.1).
create or replace function app.operator_company_row(c app.companies, p_manifest boolean default false)
returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'company_id', c.id,
    'slug', c.slug,
    'name', c.name,
    'status', c.status,
    'created_at', c.created_at,
    'access_period', coalesce(
      (select jsonb_build_object('invoice_ref', p.invoice_ref, 'starts_at', p.starts_at,
                                 'ends_at', p.ends_at, 'export_by', p.export_by, 'delete_by', p.delete_by,
                                 'state', app.access_state(c.id), 'deletion_state', app.deletion_state(c.id))
         from app.access_periods p where p.company_id = c.id),
      jsonb_build_object('invoice_ref', null, 'starts_at', null, 'ends_at', null, 'export_by', null,
                         'delete_by', null, 'state', 'none', 'deletion_state', 'not_eligible')),
    'quotas', (select jsonb_agg(jsonb_build_object(
                        'name', q.name,
                        'value', app.quota(c.id, q.name),
                        'used', app.quota_used(c.id, q.name),
                        'source', case when exists (select 1 from app.company_quotas x
                                                     where x.company_id = c.id and x.name = q.name)
                                       then 'company' else 'default' end)
                      order by q.name)
                 from unnest(app.quota_names()) q(name)),
    'counts', jsonb_build_object(
      'memberships_active', (select count(*) from app.memberships m
                              where m.company_id = c.id and m.status = 'active'),
      'memberships_removed', (select count(*) from app.memberships m
                               where m.company_id = c.id and m.status = 'removed'),
      'admins', (select count(*) from app.memberships m
                  where m.company_id = c.id and m.status = 'active' and 'company_admin' = any (m.roles)),
      'invitations_pending', (select count(*) from app.invitations i
                               where i.company_id = c.id and i.accepted_at is null and i.revoked_at is null
                                 and i.expires_at > clock_timestamp()),
      'invitations_accepted', (select count(*) from app.invitations i
                                where i.company_id = c.id and i.accepted_at is not null),
      'groups', (select count(*) from app.groups g where g.company_id = c.id),
      'agents_active', (select count(*) from app.agents a where a.company_id = c.id and a.status = 'active'),
      'agents_orphaned', (select count(*) from app.agents a where a.company_id = c.id and a.status = 'orphaned'),
      'agents_archived', (select count(*) from app.agents a where a.company_id = c.id and a.status = 'archived'),
      'candidates_draft', (select count(*) from app.candidate_versions v
                            where v.company_id = c.id and v.state = 'draft'),
      'candidates_submitted', (select count(*) from app.candidate_versions v
                                where v.company_id = c.id and v.state = 'submitted'),
      'candidates_approved', (select count(*) from app.candidate_versions v
                               where v.company_id = c.id and v.state = 'approved'),
      'candidates_changes_requested', (select count(*) from app.candidate_versions v
                                        where v.company_id = c.id and v.state = 'changes_requested'),
      'candidates_superseded', (select count(*) from app.candidate_versions v
                                 where v.company_id = c.id and v.state = 'superseded'),
      'envelopes', (select count(*) from app.review_envelopes e where e.company_id = c.id),
      'reviews', (select count(*) from app.reviews r where r.company_id = c.id),
      'releases_published', (select count(*) from app.releases r
                              where r.company_id = c.id and r.state = 'published'),
      'releases_withdrawn', (select count(*) from app.releases r
                              where r.company_id = c.id and r.state = 'withdrawn'),
      'downloads', (select count(*) from app.release_downloads d where d.company_id = c.id),
      'reports', (select count(*) from app.installation_reports p where p.company_id = c.id),
      'witnesses', (select count(*) from app.installation_witnesses w where w.company_id = c.id),
      'audit_rows', (select count(*) from app.audit_events a where a.company_id = c.id),
      'content_bytes', app.company_content_bytes(c.id),
      'assembled_bytes', app.company_assembled_bytes(c.id)))
  || case when p_manifest then jsonb_build_object('export_manifest', app.export_manifest_row(c.id))
          else '{}'::jsonb end
$$;
revoke all on function app.operator_company_row(app.companies, boolean) from public;

-- The operator's invitation: the same token protocol, the same one-pending index and the same replacement path
-- as 001's api.invite_member, with created_by_operator in place of created_by and actor_kind 'operator' on the
-- audit row (design 1.1, 2.3 B6). It carries NEITHER new bound of 1.2: the seat and pending-invitation ceilings
-- belong to the admin's path, and the succession invitation's one seat of headroom is granted authoritatively
-- at acceptance (design 1.3, E6D-C-F5). It deliberately does NOT test whether the invited address belongs to
-- an operator: an operator who types their own address gets an invitation they cannot accept, which is a
-- refusal at the right moment and not a second copy of the rule (design 1.1).
-- Design 2.3 B6 wrote `returns app.invitations`. It returns the three fields its two callers answer with
-- instead, because the plaintext token is one of them and app.invitations has no column for it: the only
-- candidate is token_hash, which exists precisely so that the token is NOT stored in a readable form, and
-- assigning the token to it on the way out would put a live credential in the shape of a hash for every later
-- reader to mistake (E6DB-F3).
create or replace function app.operator_invitation(p_company uuid, p_email text, p_roles text[],
  p_expires_in interval, p_operator uuid, p_reason_code text)
returns table (invitation_id uuid, invite_code text, expires_at timestamptz)
language plpgsql set search_path = '' as $$
declare
  email_n text := lower(btrim(p_email));
  roles_n text[] := app.normalize_roles(p_roles);
  tok bytea;
  inv app.invitations;
  replaced uuid;
begin
  if p_expires_in is null or p_expires_in <= interval '0' or p_expires_in > interval '30 days' then
    raise exception 'E_EXPIRY_INVALID' using errcode = '22023';
  end if;
  update app.invitations set revoked_at = now()
  where company_id = p_company and email_normalized = email_n
    and accepted_at is null and revoked_at is null
  returning id into replaced;
  tok := extensions.gen_random_bytes(32);
  insert into app.invitations (company_id, email_normalized, token_hash, roles, expires_at, created_by_operator)
  values (p_company, email_n, extensions.digest(tok, 'sha256'), roles_n, now() + p_expires_in, p_operator)
  returning * into inv;
  if replaced is not null then
    perform app.audit(p_company, p_operator, 'operator', 'invitation.revoke', 'invitation', replaced,
      jsonb_build_object('invitation_id', replaced, 'operator_user_id', p_operator,
                         'reason_code', 'replaced', 'replaced_by_invitation_id', inv.id));
  end if;
  perform app.audit(p_company, p_operator, 'operator', 'invitation.create', 'invitation', inv.id,
    jsonb_build_object('invitation_id', inv.id, 'roles', inv.roles, 'expires_at', inv.expires_at,
                       'operator_user_id', p_operator, 'reason_code', p_reason_code)
    || case when replaced is null then '{}'::jsonb
            else jsonb_build_object('replaces_invitation_id', replaced) end);
  -- The token is returned once, as 001's api.invite_member returns it, and nothing stores it (design 1.2).
  return query select inv.id, encode(tok, 'hex'), inv.expires_at;
end $$;
revoke all on function app.operator_invitation(uuid, text, text[], interval, uuid, text) from public;

-- api.create_company: the company, its access period and its first admin's invitation in ONE transaction
-- (design 1.1, 1.5). The period is written here and not in a second call, because a company with no period
-- row is not time-bounded at all: no write boundary, no read boundary, no deletion eligibility ever, which is
-- the plan's section 8 requirement quietly not implemented (E6D-C-F3). Absent or out-of-order dates are
-- E_BODY_INVALID before the company row exists. Audit: company.provision, invitation.create and
-- company.set_access_period, all three or none.
create or replace function api.create_company(p_slug text, p_name text, p_first_admin_email text,
  p_expires_in interval default interval '7 days', p_starts_at timestamptz default null,
  p_ends_at timestamptz default null, p_invoice_ref text default null)
returns table (company_id uuid, invitation_id uuid, invite_code text, expires_at timestamptz,
               ends_at timestamptz, export_by timestamptz, delete_by timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  op uuid := app.operator_actor();
  email_n text := lower(btrim(p_first_admin_email));
  c app.companies;
  p app.access_periods;
  inv_id uuid;
  inv_code text;
  inv_expires timestamptz;
begin
  if p_starts_at is null or p_ends_at is null or p_starts_at >= p_ends_at then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  -- E6 1.1 (E6D-C-F1c): an address that already belongs to an operator account gets an invitation nobody can
  -- accept, so it is refused here rather than at an acceptance weeks later. api.accept_invitation carries the
  -- authoritative rule; this is the early answer, and design 3.4 names it.
  if exists (select 1 from app.operators o join auth.users u on u.id = o.user_id
              where lower(u.email) = email_n) then
    raise exception 'E_OPERATOR_ACCOUNT' using errcode = 'P0001';
  end if;
  c := app.new_company(p_slug, p_name, op);
  perform app.audit(c.id, op, 'operator', 'company.provision', 'company', c.id,
    jsonb_build_object('company_id', c.id, 'operator_user_id', op));
  insert into app.access_periods (company_id, invoice_ref, starts_at, ends_at, export_by, delete_by)
  values (c.id, p_invoice_ref, p_starts_at, p_ends_at,
          p_ends_at + app.export_window(), p_ends_at + app.export_window() + app.deletion_window())
  returning * into p;
  perform app.audit(c.id, op, 'operator', 'company.set_access_period', 'company', c.id,
    jsonb_build_object('company_id', c.id, 'ends_at', p.ends_at, 'export_by', p.export_by,
                       'delete_by', p.delete_by, 'reason_code', 'operator_request'));
  -- The first admin becomes a member by ACCEPTING, through api.accept_invitation unchanged, which is the same
  -- path every other member takes (design 1.1). This routine creates no membership.
  select i.invitation_id, i.invite_code, i.expires_at into inv_id, inv_code, inv_expires
    from app.operator_invitation(c.id, p_first_admin_email, array['company_admin', 'member'],
                                 p_expires_in, op, 'operator_request') i;
  return query select c.id, inv_id, inv_code, inv_expires, p.ends_at, p.export_by, p.delete_by;
end $$;

-- api.operator_invite_admin: the succession invitation for a company that has no candidate for
-- api.transfer_first_admin (design 1.3). One seat of headroom, granted authoritatively at acceptance (B5);
-- this routine refuses a SECOND live operator-issued admin invitation, which is defense in depth over the same
-- bound and not a second rule (E6D-C-F5).
create or replace function api.operator_invite_admin(p_company uuid, p_email text,
  p_expires_in interval default interval '7 days')
returns table (invitation_id uuid, invite_code text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  op uuid := app.operator_actor();
  c app.companies;
  email_n text := lower(btrim(p_email));
begin
  c := app.lock_company_operator(p_company);
  -- Admits active and suspended, refuses closed: a succession is asked for exactly when a company is
  -- suspended or its period has ended (design 1.3, 1.5). The ACCEPTANCE still passes app.lock_company, so the
  -- operator resumes the company or extends the period first; E7's operator guide carries that step.
  if c.status = 'closed' then
    raise exception 'E_COMPANY_CLOSED' using errcode = 'P0001';
  end if;
  -- E6S-C-F6. The count is taken NET OF THE PENDING SIBLING FOR THIS SAME ADDRESS, which is api.invite_member's
  -- own idiom for the same reason (E6D-C-F7) and which this routine did not copy.
  -- What was broken. api.create_company answers once and never again, so an operator who loses the answer has no
  -- way to read the link back: nothing stores it. The documented recovery is to re-enter the SAME address here,
  -- which revokes the old invitation and issues a new one through app.operator_invitation. The global check
  -- above ran before that helper and refused 409 E_SUCCESSION_PENDING, so the one recovery the contract names
  -- was the one call the routine would not accept (evidence/e6-server-critique.md E6S-C-F6, and E6D-C-F10's
  -- second half, which the services module records as settled and was not).
  -- What it still refuses is a SECOND live operator-issued admin invitation to a DIFFERENT address, which is the
  -- defense in depth over the one-seat headroom this routine was written for (E6D-C-F5). Replacing the sibling
  -- adds no seat and no live invitation: app.operator_invitation revokes it in the same transaction and the
  -- unique index invitations_one_pending means there is at most one, so the company still holds exactly one live
  -- operator-issued admin invitation afterwards.
  -- The old secret is NEVER replayed. app.operator_invitation generates 32 fresh bytes, stores only their
  -- digest, revokes the row whose digest was the old one, and returns the new token once. There is no path in
  -- this routine or that helper that reads a token_hash back, and nothing anywhere can turn one into a token.
  if exists (select 1 from app.invitations i
              where i.company_id = p_company and i.created_by_operator is not null
                and 'company_admin' = any (i.roles)
                and i.accepted_at is null and i.revoked_at is null
                and i.expires_at > clock_timestamp()
                and i.email_normalized <> email_n) then
    raise exception 'E_SUCCESSION_PENDING' using errcode = 'P0001';
  end if;
  return query select i.invitation_id, i.invite_code, i.expires_at
    from app.operator_invitation(p_company, p_email, array['company_admin', 'member'],
                                 p_expires_in, op, 'operator_admin_succession') i;
end $$;

-- api.set_company_status: suspend and resume (design 1.1). closed is terminal, so a closed company is
-- E_COMPANY_CLOSED whatever is asked. A no-op answers changed: false and writes no audit row, which is E2's
-- idiom for every admin routine.
-- p_reason_code is the lead's decision on the database lane's question 1 (E6DB-F4, evidence/e6-db.md section
-- 5): the routine used to record the fixed 'operator_request', so a suspension over an unpaid invoice and one
-- at the customer's own request were the same row and nobody could tell them apart a year later. The closed
-- list is three words, because a free-text reason in an audit row is a field nobody can aggregate and a place
-- for a name to leak: customer_request, non_payment, operator_decision. Outside the list, and null, is 422
-- E_BODY_INVALID beside the status vocabulary, so the two body refusals are one answer. A resume takes one
-- too, and customer_request is the ordinary one there.
create or replace function api.set_company_status(p_company uuid, p_status text, p_reason_code text)
returns table (company_id uuid, status text, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  op uuid := app.operator_actor();
  c app.companies;
begin
  if p_status is null or p_status not in ('active', 'suspended') then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  if p_reason_code is null
     or p_reason_code not in ('customer_request', 'non_payment', 'operator_decision') then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  c := app.lock_company_operator(p_company);
  if c.status = 'closed' then
    raise exception 'E_COMPANY_CLOSED' using errcode = 'P0001';
  end if;
  if c.status = p_status then
    return query select c.id, c.status, false;
    return;
  end if;
  update app.companies set status = p_status where id = c.id;
  perform app.audit(c.id, op, 'operator',
    case when p_status = 'suspended' then 'company.suspend' else 'company.resume' end, 'company', c.id,
    jsonb_build_object('company_id', c.id, 'status_before', c.status, 'status_after', p_status,
                       'reason_code', p_reason_code));
  return query select c.id, p_status, true;
end $$;

-- api.set_access_period: one row per company, upserted (design 1.5). export_by and delete_by are DERIVED from
-- two constants and then STORED, because they are the promise made to a customer at a moment in time: moving
-- app.export_window() later must not silently move the deletion date of an agreement already signed.
-- No status rule: an operator extends the agreement of a suspended company and of one whose period has
-- already ended, which is exactly the trap app.lock_company_operator exists for (design 1.5, case 35).
create or replace function api.set_access_period(p_company uuid, p_invoice_ref text,
  p_starts_at timestamptz, p_ends_at timestamptz)
returns table (company_id uuid, ends_at timestamptz, export_by timestamptz, delete_by timestamptz,
               changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  op uuid := app.operator_actor();
  c app.companies;
  before app.access_periods;
  p app.access_periods;
  v_export_by timestamptz;
  v_delete_by timestamptz;
  v_changed boolean;
begin
  if p_starts_at is null or p_ends_at is null or p_starts_at >= p_ends_at then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  if p_invoice_ref is not null and char_length(p_invoice_ref) not between 1 and 80 then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  c := app.lock_company_operator(p_company);
  v_export_by := p_ends_at + app.export_window();
  v_delete_by := v_export_by + app.deletion_window();
  select * into before from app.access_periods where access_periods.company_id = c.id for update;
  v_changed := before.company_id is null
               or before.starts_at <> p_starts_at or before.ends_at <> p_ends_at
               or before.invoice_ref is distinct from p_invoice_ref;
  if not v_changed then
    return query select c.id, before.ends_at, before.export_by, before.delete_by, false;
    return;
  end if;
  insert into app.access_periods (company_id, invoice_ref, starts_at, ends_at, export_by, delete_by)
  values (c.id, p_invoice_ref, p_starts_at, p_ends_at, v_export_by, v_delete_by)
  -- on constraint and not on (company_id): this routine's OUT column is also called company_id, and the
  -- index-inference list is one of the two places PL/pgSQL cannot tell a variable from a column (E6DB-F7).
  on conflict on constraint access_periods_pkey do update
    set invoice_ref = excluded.invoice_ref, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
        export_by = excluded.export_by, delete_by = excluded.delete_by, updated_at = now()
  returning * into p;
  perform app.audit(c.id, op, 'operator', 'company.set_access_period', 'company', c.id,
    jsonb_build_object('company_id', c.id, 'ends_at', p.ends_at, 'export_by', p.export_by,
                       'delete_by', p.delete_by, 'reason_code', 'operator_request'));
  return query select c.id, p.ends_at, p.export_by, p.delete_by, true;
end $$;

-- api.set_company_quota (design 1.7). An admin cannot change a quota: a quota is the commercial agreement.
-- Setting the value already in force answers changed: false; setting a value equal to the DEFAULT still
-- writes the row, so "explicitly set to 25" and "defaulted to 25" stay distinguishable in the register, which
-- matters when the default later moves.
create or replace function api.set_company_quota(p_company uuid, p_name text, p_value integer)
returns table (company_id uuid, name text, value integer, previous integer, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  op uuid := app.operator_actor();
  c app.companies;
  existing integer;
  effective integer;
  lifetime integer;
  downloads_after integer;
begin
  if p_name is null or not (p_name = any (app.quota_names())) then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  if p_value is null or not (p_value <@ app.quota_bounds(p_name)) then
    raise exception 'E_QUOTA_OUT_OF_RANGE' using errcode = '22023';
  end if;
  c := app.lock_company_operator(p_company);
  -- The one arithmetic E6 inherits and turns into a refusal (design section 6). E5 section 6 derived the
  -- ledger's 10,000-row LEDGER_CEILING from "200 downloads x 25 members" and wrote its condition out: it
  -- holds while a company's lifetime memberships stay at or below 50. E6 makes BOTH numbers operator-settable,
  -- so the condition became something an operator could break with two clicks, and the bounds alone do not
  -- protect it: app.quota_bounds tops out at 2,000 downloads and 500 members, whose product is 1,000,000.
  -- So the product of this company's LIFETIME memberships (active plus removed, because a replaced member
  -- keeps their ledger rows) and its downloads_per_recipient quota is compared with app.limit_ledger_rows()
  -- here, whichever of the two the operator is raising.
  -- The download quota computed into a variable and not inlined in the IF: PL/pgSQL ends an IF condition at
  -- the first THEN token, so a CASE expression inside one is a syntax error at end of input (E6DB-F1).
  select count(*)::int into lifetime from app.memberships m where m.company_id = c.id;
  downloads_after := case when p_name = 'downloads_per_recipient' then p_value
                          else app.quota(c.id, 'downloads_per_recipient') end;
  if lifetime * downloads_after > app.limit_ledger_rows() then
    raise exception 'E_QUOTA_OUT_OF_RANGE' using errcode = '22023';
  end if;
  select q.value into existing from app.company_quotas q
   where q.company_id = c.id and q.name = p_name for update;
  effective := app.quota(c.id, p_name);
  if existing is not null and existing = p_value then
    return query select c.id, p_name, p_value, effective, false;
    return;
  end if;
  insert into app.company_quotas (company_id, name, value) values (c.id, p_name, p_value)
  -- on constraint and not on (company_id, name): both of this routine's OUT columns share those names and
  -- the index-inference list cannot tell a variable from a column (E6DB-F7).
  on conflict on constraint company_quotas_pkey do update set value = excluded.value, updated_at = now();
  perform app.audit(c.id, op, 'operator', 'company.set_quota', 'company', c.id,
    jsonb_build_object('company_id', c.id, 'quota_name', p_name, 'quota_value', p_value,
                       'quota_value_before', effective));
  return query select c.id, p_name, p_value, effective, true;
end $$;

-- api.operator_register (design 1.1, 1.5). Ordered OVERDUE, DUE, ELIGIBLE and then the keyset on company id,
-- whatever page the cursor is on, so the first thing an operator sees on opening the register is every
-- company whose deletion is outstanding: that ordering is one of the three things that make a deletion happen
-- on time, and the design says plainly that this is an operational control and not an automatic one.
-- The cursor is one company id and the order is a pair, so the keyset compares the PAIR against the cursor
-- company's own rank and id. A cursor naming a company that no longer exists is E_NOT_FOUND rather than a
-- silent first page (E6DB-F5: a deleted company is exactly the cursor an operator holds after a deletion).
create or replace function api.operator_register(p_cursor uuid default null, p_limit integer default 50)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  op uuid := app.operator_actor();
  rows_out jsonb;
  last_id uuid;
  n integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  if p_cursor is not null and not exists (select 1 from app.companies c where c.id = p_cursor) then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  with ranked as (
    select c.*, case app.deletion_state(c.id)
                  when 'overdue' then 0 when 'due' then 1 when 'eligible' then 2 else 3 end as rank
      from app.companies c
  ), page as (
    select r.*, row_number() over (order by r.rank, r.id) as rn
      from ranked r
     where p_cursor is null
        or (r.rank, r.id) > (select k.rank, k.id from ranked k where k.id = p_cursor)
     order by r.rank, r.id
     limit p_limit
  )
  select jsonb_agg(app.operator_company_row(
                     row(p.id, p.slug, p.name, p.status, p.created_at)::app.companies) order by p.rn),
         count(*)::int,
         (select q.id from page q order by q.rn desc limit 1)
    into rows_out, n, last_id
    from page p;
  return jsonb_build_object(
    'companies', coalesce(rows_out, '[]'::jsonb),
    'sweepable_accounts', app.sweep_candidate_count(),
    'next_cursor', case when coalesce(n, 0) < p_limit then null else last_id end);
end $$;

-- api.operator_export_manifest (design 1.1, 1.6, E6D-C-F1a). One company's counts, through the same
-- app.operator_company_row with its manifest arm, so the named boundary stays ONE function. It exists because
-- the operator is not a caller of api.export_company and a support call still has to answer two questions:
-- what would a customer's export contain, and can the customer take it through the route.
create or replace function api.operator_export_manifest(p_company uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  op uuid := app.operator_actor();
  c app.companies;
begin
  select * into c from app.companies where id = p_company;
  if c.id is null then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  return app.operator_company_row(c, true);
end $$;

-- api.operator_expiry_run (design 1.5). One transaction, idempotent, bounded per call, audited per company
-- changed. It is the TIDY-UP and not the control: every read boundary tests time, not this routine's
-- suspension, because a window whose end is a status a person sets is not a window (E6D-C-F3, case 38).
-- Companies are selected by the export_by predicate and LOCKED IN ASCENDING COMPANY ID (design 2.5), which
-- are two different things, so two concurrent runs cannot deadlock against each other.
-- BOTH lists are bounded by p_limit and both say what is left (E6D-C-F14): the first version bounded the
-- suspensions and returned every due company, so a run against 400 of them answered with 400 rows and every
-- later run repeated them instead of the promised empty list.
create or replace function api.operator_expiry_run(p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  op uuid := app.operator_actor();
  rec record;
  c app.companies;
  suspended jsonb := '[]'::jsonb;
  due_list jsonb := '[]'::jsonb;
  n_due integer;
  period_end timestamptz;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  for rec in
    select c2.id from app.companies c2 join app.access_periods p on p.company_id = c2.id
     where c2.status = 'active' and p.export_by <= clock_timestamp()
     order by c2.id
     limit p_limit
  loop
    -- The lock is taken per row, in the ascending order of the selection, and the status is re-read from the
    -- locked row: another run or an operator may have suspended this company while this one waited.
    c := app.lock_company_operator(rec.id);
    if c.status <> 'active' then
      continue;
    end if;
    -- E6S-C-F7: and so is the PERIOD, which the first version did not re-read. The cursor's snapshot is taken
    -- before the loop and is stale the moment this iteration waits: api.set_access_period takes the same
    -- operator company lock, so an operator extending an agreement while this run queues behind them commits a
    -- period whose export_by is in the future, and the run then suspended a company that had just been paid for.
    -- Re-reading the status alone cannot see it, because an extension does not change the status. The row is
    -- read under the lock this iteration now holds, so nothing can move it between this test and the update
    -- below, and export_by for the answer is read from the same row rather than from the cursor.
    select p.export_by into period_end from app.access_periods p where p.company_id = c.id;
    if period_end is null or period_end > clock_timestamp() then
      continue;
    end if;
    update app.companies set status = 'suspended' where id = c.id;
    perform app.audit(c.id, op, 'operator', 'company.suspend', 'company', c.id,
      jsonb_build_object('company_id', c.id, 'status_before', c.status, 'status_after', 'suspended',
                         'reason_code', 'access_period_expired'));
    suspended := suspended || jsonb_build_array(
      jsonb_build_object('company_id', c.id, 'slug', c.slug, 'export_by', period_end));
  end loop;
  -- The report: no locks, no writes, no act. Ordered overdue, due, eligible and then by delete_by, which is
  -- the operator's order and NOT the ascending-id lock order of design 2.5. That is harmless while the list
  -- takes no locks and is the open half of E6D-C-F14: the moment anything makes this list act it acquires in
  -- ascending id like the loop above. evidence/e6-db.md carries it as a debt with that consequence.
  select coalesce(jsonb_agg(jsonb_build_object('company_id', x.id, 'slug', x.slug,
                                               'delete_by', x.delete_by, 'deletion_state', x.st)
                            order by x.rank, x.delete_by, x.id), '[]'::jsonb)
    into due_list
    from (select c2.id, c2.slug, p.delete_by, app.deletion_state(c2.id) as st,
                 case app.deletion_state(c2.id)
                   when 'overdue' then 0 when 'due' then 1 else 2 end as rank
            from app.companies c2 join app.access_periods p on p.company_id = c2.id
           where app.deletion_state(c2.id) in ('overdue', 'due', 'eligible')
           order by rank, p.delete_by, c2.id
           limit p_limit) x;
  select count(*)::int into n_due from app.companies c2
   where app.deletion_state(c2.id) in ('overdue', 'due', 'eligible');
  return jsonb_build_object(
    'suspended', suspended,
    'due_for_deletion', due_list,
    'remaining', (select count(*)::int from app.companies c2 join app.access_periods p on p.company_id = c2.id
                   where c2.status = 'active' and p.export_by <= clock_timestamp()),
    'remaining_due', greatest(n_due - jsonb_array_length(due_list), 0),
    'counts', jsonb_build_object(
      'eligible', (select count(*)::int from app.companies c2 where app.deletion_state(c2.id) = 'eligible'),
      'due', (select count(*)::int from app.companies c2 where app.deletion_state(c2.id) = 'due'),
      'overdue', (select count(*)::int from app.companies c2 where app.deletion_state(c2.id) = 'overdue')));
end $$;

-- ---------------------------------------------------------------------------
-- B7. api.transfer_agent (design 1.3, 2.3 B7, 3.5). Unbound: no idempotency key, no operation digest.
--     The order below IS the whole routine and it is the order the critique corrected (E6D-C-F2).
-- ---------------------------------------------------------------------------
create or replace function api.transfer_agent(p_agent uuid, p_to_membership uuid, p_expected_owner uuid)
returns table (agent_id uuid, owner_membership_id uuid, agent_status text, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  a app.agents;
  me app.memberships;
  target app.memberships;
begin
  if p_agent is null or p_to_membership is null or p_expected_owner is null then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  select * into a from app.agents g where g.id = p_agent;               -- unlocked locate, E2's idiom
  if a.id is null then raise exception 'E_NOT_FOUND' using errcode = 'P0002'; end if;
  perform app.require_standing(a.company_id, actor);   -- pre-check only: E2 says it is explicitly unlocked
  perform app.lock_company(a.company_id);                               -- level 1
  -- Standing AGAIN, under the lock, and its absence is a refusal and never a branch that falls through
  -- (E6D-C-F2). A remover can commit between the pre-check and the lock; the first version of this routine
  -- then compared NULL = a.owner_membership_id, which is NULL, so `if not (NULL)` never ran and the departed
  -- caller passed straight to the transfer. No row lock is needed here: every writer of a membership of this
  -- company holds the company lock first (design 2.5), so this read cannot change under us.
  select * into me from app.memberships m
   where m.company_id = a.company_id and m.user_id = actor and m.status = 'active';
  if me.id is null then raise exception 'E_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into target from app.memberships m
   where m.id = p_to_membership and m.company_id = a.company_id for update;    -- level 2
  if target.id is null then raise exception 'E_NOT_FOUND' using errcode = 'P0002'; end if;
  if target.status <> 'active' then raise exception 'E_MEMBERSHIP_REMOVED' using errcode = 'P0001'; end if;
  select * into a from app.agents g where g.id = p_agent for update;           -- level 4
  if a.id is null then raise exception 'E_NOT_FOUND' using errcode = 'P0002'; end if;
  -- Authorize from the LOCKED row, never from the pre-lock copy (E6D-C-F2). The first version read the owner
  -- before waiting for the company lock, so a former owner whose agent had since been transferred still
  -- passed the owner arm. p_expected_owner is a stale-retry guard below and is never authority: it is the
  -- caller's own input. The owner arm needs no aal; the admin arm needs aal2 (design 1.3, E4 1.4's shape).
  if not (me.id = a.owner_membership_id and a.status = 'active') then
    perform app.require_admin(a.company_id, actor);
  end if;
  if a.status = 'archived' then raise exception 'E_AGENT_ARCHIVED' using errcode = 'P0001'; end if;
  if a.owner_membership_id = p_to_membership and a.status = 'active' then      -- the honest retry, FIRST
    return query select a.id, a.owner_membership_id, a.status, false; return;
  end if;
  if a.owner_membership_id <> p_expected_owner then                            -- the stale retry
    raise exception 'E_OWNER_CHANGED' using errcode = 'P0001';
  end if;
  -- An ORPHANED agent whose owner column already names the target is still un-orphaned rather than answered
  -- changed: false, because the retry branch above also requires status = 'active' (design 2.3 B7's note).
  update app.agents set owner_membership_id = p_to_membership,
                        status = case when status = 'orphaned' then 'active' else status end
   where id = a.id returning * into a;
  perform app.audit(a.company_id, actor, 'member', 'agent.transfer', 'agent', a.id,
    jsonb_build_object('agent_id', a.id, 'membership_id', p_to_membership,
                       'previous_owner_membership_id', p_expected_owner, 'agent_status_after', a.status));
  return query select a.id, a.owner_membership_id, a.status, true;
end $$;

-- ---------------------------------------------------------------------------
-- B8. The departure preview (design 1.4). A read: no lock, no write, no audit row.
-- ---------------------------------------------------------------------------
-- Existence and authority, raised from inside the one statement below. app.require_admin is the accepted
-- shape and gives the accepted order: no active membership E_NOT_FOUND, not an admin E_FORBIDDEN, an admin
-- without a second factor E_ADMIN_MFA_REQUIRED. Design case 18's control expects 404 for a plain member of
-- the same company rather than 403; that is recorded as E6DB-F6 in evidence/e6-db.md, because every other
-- admin-only routine in the product answers E_FORBIDDEN there and a second rule for one read would be the
-- inconsistency OPERATING.md asks to avoid.
create or replace function app.departure_subject(p_membership uuid) returns app.memberships
language plpgsql stable security definer set search_path = '' as $$
declare
  s app.memberships;
begin
  if p_membership is null then raise exception 'E_BODY_INVALID' using errcode = '22023'; end if;
  select * into s from app.memberships where id = p_membership;
  if s.id is null then raise exception 'E_NOT_FOUND' using errcode = 'P0002'; end if;
  perform app.require_admin(s.company_id, app.server_actor());
  return s;
end $$;
revoke all on function app.departure_subject(uuid) from public;

-- LANGUAGE SQL STABLE, ONE STATEMENT, and that is the contract rather than "one function" (E6D-C-F9): a
-- VOLATILE plpgsql body taking eight separate SELECTs under read committed takes a NEW SNAPSHOT PER
-- STATEMENT, so two of its numbers can come from two different moments. A STABLE function is evaluated
-- within the snapshot of the calling statement, and one statement has one snapshot whatever the volatility
-- says. The volatility is pinned by tests/e6/unit/migration-text.test.mjs.
-- It is still a preview and not a promise: a transfer, a role change or a removal can commit between this
-- read and the admin pressing Remove.
-- groups and owned_agents carry NAMES because the caller is an admin of that company who may already read
-- both; the operator never calls this routine.
create or replace function api.departure_preview(p_membership uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'membership_id', s.id,
    'roles', to_jsonb(s.roles),
    'status', s.status,
    'label', coalesce(
      (select jsonb_build_object('kind', 'display_name', 'value', f.display_name)
         from app.profiles f where f.user_id = s.user_id),
      (select jsonb_build_object('kind', 'email', 'value', lower(u.email))
         from auth.users u where u.id = s.user_id)),
    'is_last_admin', 'company_admin' = any (s.roles)
                     and app.active_admin_count(s.company_id, s.id) = 0,
    'sole_holder_of_roles', coalesce((
      select jsonb_agg(r order by r) from unnest(s.roles) r
       where r <> 'member'
         and not exists (select 1 from app.memberships o
                          where o.company_id = s.company_id and o.status = 'active'
                            and o.id <> s.id and r = any (o.roles))), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('group_id', g.id, 'name', g.name) order by g.name)
                          from app.group_members gm join app.groups g on g.id = gm.group_id
                         where gm.membership_id = s.id), '[]'::jsonb),
    'owned_agents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'agent_id', a.id, 'name', a.name, 'status', a.status,
               'current_releases', (select count(*) from app.releases r
                                     where r.agent_id = a.id and r.state = 'published'
                                       and r.superseded_by_release_id is null),
               'recipients', (select count(distinct gm.membership_id)
                                from app.releases r
                                join app.group_members gm on gm.group_id = any (r.audience_group_ids)
                               where r.agent_id = a.id and r.state = 'published'
                                 and r.superseded_by_release_id is null))
             order by a.name)
        from app.agents a where a.owner_membership_id = s.id), '[]'::jsonb),
    'drafts', (select count(*) from app.candidate_versions v
                where v.author_membership_id = s.id and v.state = 'draft'),
    'submitted_awaiting_review', (select count(*) from app.candidate_versions v
                                   where v.author_membership_id = s.id and v.state = 'submitted'),
    -- An envelope of this company whose candidate is still submitted and which has no review yet in a review
    -- role this membership holds: the work that stops the moment they leave (design 1.4).
    'envelopes_awaiting_a_role_they_hold', (
      select count(*) from app.review_envelopes e
       join app.candidate_versions v on v.id = e.candidate_id
       where e.company_id = s.company_id and v.state = 'submitted'
         and exists (
           select 1 from unnest(array['it', 'business']) rr
            where (rr = 'it' and 'it_reviewer' = any (s.roles)
                   or rr = 'business' and 'business_reviewer' = any (s.roles))
              and not exists (select 1 from app.reviews rv
                               where rv.envelope_id = e.id and rv.role = rr))),
    'authorizations', (select count(*) from app.release_downloads d where d.membership_id = s.id),
    'reports', (select count(*) from app.installation_reports p where p.membership_id = s.id),
    'witnesses', (select count(*) from app.installation_witnesses w where w.witness_membership_id = s.id),
    'published_releases', (select count(*) from app.releases r where r.published_by_membership_id = s.id))
    from app.departure_subject(p_membership) s
$$;

-- ---------------------------------------------------------------------------
-- B9. The company status guard and the one deletion door (design 1.6).
--
--     What the bypass is worth, stated in the E3a style. The flag is NOT the authorization. No PostgREST role
--     holds a DELETE grant on any of these tables: authenticated and app_maintenance hold SELECT alone,
--     app_maintenance holds INSERT on audit_events and nothing else, and only postgres holds DELETE. A
--     PostgREST caller cannot execute a bare SET LOCAL at all, because PostgREST sets the transaction's
--     settings itself and exposes no SQL. The reachable setters are the definer routine, owned by postgres
--     and granted to app_server alone, and the owner in a psql session. The flag exists so that an
--     OWNER-SIDE ACCIDENT, a migration or a maintenance command with a careless DELETE, does not silently
--     erase a tenant: it is a review tripwire, exactly as scripts/check-migrations.mjs is for a migration
--     edit, and its honest bound is the same, that an owner who sets the flag on purpose or drops the trigger
--     gets past it.
--     The bypass opens DELETE ONLY. UPDATE and TRUNCATE keep their refusals under it, which is narrower than
--     app.registry_migration's.
--     app.registry_frozen is NOT among the twelve: the gate identities, installer texts, targets and policies
--     are Phaeacia's registers, not a company's rows, and deleting a company must not be able to touch them.
-- ---------------------------------------------------------------------------
create or replace function app.company_status_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    if tg_op = 'DELETE' and current_setting('app.tenant_deletion', true) = 'on' then return old; end if;
    raise exception 'E_COMPANY_DELETE' using errcode = '42501';
  end if;
  if new.id <> old.id or new.slug <> old.slug then
    raise exception 'E_COMPANY_IDENTITY' using errcode = '42501';
  end if;
  -- closed is terminal, and the same bypass the deletion door uses admits a move out of it, so E7's
  -- reconciler keeps the bidirectional power E2 section 5 disclosed rather than having it quietly narrowed
  -- by a later slice (design 1.6, 1.8).
  if old.status = 'closed' and new.status <> 'closed'
     and current_setting('app.tenant_deletion', true) is distinct from 'on' then
    raise exception 'E_COMPANY_CLOSED' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger companies_status_guard before update or delete on app.companies
  for each row execute function app.company_status_guard();
create trigger companies_no_truncate before truncate on app.companies
  for each statement execute function app.company_status_guard();

-- The eleven accepted trigger functions. Each is its accepted body with ONE line in front and nothing else
-- changed; every error name and every 42501 is unchanged, so every refusal message a reader has ever seen is
-- the same.
create or replace function app.audit_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_setting('app.tenant_deletion', true) = 'on' then return old; end if;
  raise exception 'E_AUDIT_APPEND_ONLY' using errcode = '42501';
end $$;

create or replace function app.membership_identity_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_setting('app.tenant_deletion', true) = 'on' then return old; end if;
  if tg_op = 'DELETE' then
    raise exception 'E_MEMBERSHIP_DELETE' using errcode = '42501';
  end if;
  if new.company_id <> old.company_id or new.user_id <> old.user_id or new.id <> old.id then
    raise exception 'E_MEMBERSHIP_IDENTITY' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function app.candidate_no_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_setting('app.tenant_deletion', true) = 'on' then return old; end if;
  raise exception 'E_CANDIDATE_DELETE' using errcode = '42501';
end $$;

create or replace function app.contributors_frozen() returns trigger
language plpgsql set search_path = '' as $$
declare
  st text;
begin
  if tg_op = 'DELETE' and current_setting('app.tenant_deletion', true) = 'on' then return old; end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select v.state into st from app.candidate_versions v where v.id = old.candidate_id for share;
    if st is distinct from 'draft' then
      raise exception 'E_CONTRIBUTORS_FROZEN' using errcode = 'P0001';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select v.state into st from app.candidate_versions v where v.id = new.candidate_id for share;
    if st is distinct from 'draft' then
      raise exception 'E_CONTRIBUTORS_FROZEN' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

create or replace function app.group_no_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_setting('app.tenant_deletion', true) = 'on' then return old; end if;
  raise exception 'E_GROUP_DELETE' using errcode = '42501';
end $$;

create or replace function app.envelope_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_setting('app.tenant_deletion', true) = 'on' then return old; end if;
  if tg_op = 'UPDATE' then
    raise exception 'E_IMMUTABLE' using errcode = 'P0001';
  end if;
  raise exception 'E_ENVELOPE_DELETE' using errcode = '42501';
end $$;

create or replace function app.review_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_setting('app.tenant_deletion', true) = 'on' then return old; end if;
  raise exception 'E_IMMUTABLE' using errcode = 'P0001';
end $$;

create or replace function app.release_immutable() returns trigger
language plpgsql set search_path = '' as $$
declare
  withdrawal boolean;
  supersession boolean;
begin
  if tg_op = 'DELETE' and current_setting('app.tenant_deletion', true) = 'on' then return old; end if;
  if tg_op <> 'UPDATE' then
    raise exception 'E_RELEASE_DELETE' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id
     or new.agent_id is distinct from old.agent_id or new.candidate_id is distinct from old.candidate_id
     or new.envelope_id is distinct from old.envelope_id or new.target is distinct from old.target
     or new.gate_id is distinct from old.gate_id
     or new.content_sha256 is distinct from old.content_sha256 or new.derived_sha256 is distinct from old.derived_sha256
     or new.installer_text_sha256 is distinct from old.installer_text_sha256 or new.core_sha256 is distinct from old.core_sha256
     or new.branch_sha256 is distinct from old.branch_sha256 or new.judge_sha256 is distinct from old.judge_sha256
     or new.policy_id is distinct from old.policy_id or new.policy_sha256 is distinct from old.policy_sha256
     or new.audience_group_ids is distinct from old.audience_group_ids
     or new.envelope_sha256 is distinct from old.envelope_sha256
     or new.assembled_content is distinct from old.assembled_content
     or new.assembled_sha256 is distinct from old.assembled_sha256 or new.assembled_bytes is distinct from old.assembled_bytes
     or new.published_by_membership_id is distinct from old.published_by_membership_id
     or new.published_at is distinct from old.published_at then
    raise exception 'E_IMMUTABLE' using errcode = 'P0001';
  end if;
  withdrawal := old.state = 'published' and new.state = 'withdrawn'
    and old.withdrawn_at is null and old.withdrawn_by_membership_id is null and old.withdrawal_reason is null
    and new.withdrawn_at is not null and new.withdrawn_by_membership_id is not null and new.withdrawal_reason is not null
    and new.superseded_by_release_id is not distinct from old.superseded_by_release_id
    and new.superseded_at is not distinct from old.superseded_at;
  supersession := old.state = 'published' and new.state = 'published'
    and old.superseded_by_release_id is null and old.superseded_at is null
    and new.superseded_by_release_id is not null and new.superseded_at is not null
    and new.withdrawn_at is null and new.withdrawn_by_membership_id is null and new.withdrawal_reason is null;
  if not coalesce(withdrawal, false) and not coalesce(supersession, false) then
    raise exception 'E_IMMUTABLE' using errcode = 'P0001';
  end if;
  if withdrawal and new.withdrawal_reason is distinct from app.review_reason(new.withdrawal_reason) then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  return new;
end $$;

create or replace function app.ledger_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_setting('app.tenant_deletion', true) = 'on' then return old; end if;
  raise exception 'E_LEDGER_APPEND_ONLY' using errcode = '42501';
end $$;

create or replace function app.report_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_setting('app.tenant_deletion', true) = 'on' then return old; end if;
  raise exception 'E_REPORT_APPEND_ONLY' using errcode = '42501';
end $$;

create or replace function app.witness_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_setting('app.tenant_deletion', true) = 'on' then return old; end if;
  raise exception 'E_WITNESS_APPEND_ONLY' using errcode = '42501';
end $$;

-- ---------------------------------------------------------------------------
-- B10. Closure, deletion and the export (design 1.6)
-- ---------------------------------------------------------------------------
-- The eighteen deletion sections of design 1.6, children before parents, in one place so the routine's
-- counts, its row-total bound and the audit row's section_counts cannot name different sets.
create or replace function app.deletion_section_names() returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select array['installation_witnesses', 'installation_reports', 'release_downloads', 'releases', 'reviews',
               'review_envelopes', 'candidate_contributors', 'candidate_versions', 'agents', 'group_members',
               'groups', 'idempotency_keys', 'invitations', 'audit_events', 'memberships', 'access_periods',
               'company_quotas', 'companies']::text[] $$;
-- The twenty-one export sections of design 1.6, in the document's order.
create or replace function app.export_section_names() returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select array['access_periods', 'company_quotas', 'memberships', 'invitations', 'profiles', 'groups',
               'group_members', 'agents', 'candidate_versions', 'candidate_contributors', 'review_envelopes',
               'reviews', 'releases', 'release_downloads', 'installation_reports', 'installation_witnesses',
               'audit_events', 'release_targets', 'installer_texts', 'release_policies',
               'gate_identities']::text[] $$;
revoke execute on function app.deletion_section_names(), app.export_section_names() from public;

-- api.close_company (design 1.6). Closure is never the first thing that happens to a working company: it is
-- always preceded by a quarantine somebody could undo. One typed slug because closure is the entry to the
-- only terminal state and the next act after it deletes rows no trigger will let anybody put back; it is not
-- an authorization, the operator's aal2 is.
-- p_reason_code is REQUIRED with the export-window rule attached to it (E6D-C-F3): closing while export_by is
-- still ahead takes away days the agreement promises, so it needs a recorded customer instruction. The slug
-- confirmation answers "did you mean this company"; nothing answered "on whose authority is the promise being
-- shortened", and a code the audit row carries is the cheapest thing that makes that answerable a year later.
create or replace function api.close_company(p_company uuid, p_confirm_slug text, p_reason_code text)
returns table (company_id uuid, status text, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  op uuid := app.operator_actor();
  c app.companies;
  window_open boolean;
begin
  if p_reason_code is null or p_reason_code !~ '^[a-z_]{1,40}$'
     or p_reason_code not in ('retention_deadline', 'customer_instruction', 'operator_request') then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  c := app.lock_company_operator(p_company);
  if c.status = 'closed' then
    if p_confirm_slug is distinct from c.slug then
      raise exception 'E_CONFIRMATION_MISMATCH' using errcode = '22023';
    end if;
    return query select c.id, c.status, false;
    return;
  end if;
  if c.status <> 'suspended' then
    raise exception 'E_COMPANY_NOT_SUSPENDED' using errcode = 'P0001';
  end if;
  if p_confirm_slug is distinct from c.slug then
    raise exception 'E_CONFIRMATION_MISMATCH' using errcode = '22023';
  end if;
  select exists (select 1 from app.access_periods p
                  where p.company_id = c.id and p.export_by > clock_timestamp()) into window_open;
  if window_open and p_reason_code <> 'customer_instruction' then
    raise exception 'E_EXPORT_WINDOW_OPEN' using errcode = 'P0001';
  end if;
  update app.companies set status = 'closed' where id = c.id;
  perform app.audit(c.id, op, 'operator', 'company.close', 'company', c.id,
    jsonb_build_object('company_id', c.id, 'status_before', c.status, 'status_after', 'closed',
                       'reason_code', p_reason_code));
  return query select c.id, 'closed'::text, true;
end $$;

-- api.delete_company (design 1.6). THE ONE DOOR through the append-only and immutability triggers.
-- Eligible from EXPORT_BY and not from delete_by (E6D-C-F3): the plan requires the content deleted BETWEEN
-- export_by and delete_by, so a routine that refuses until delete_by makes every legal deletion either
-- impossible or late. delete_by is the date by which the act must be FINISHED, which is the register's word
-- `due` and E7's weekly check, not a precondition.
-- The two admissible reasons are the plan's two, word for word: "Purge only on confirmed deletion
-- instructions or an applicable recorded retention deadline."
-- The deletion's own record cannot live in the company's audit rows, because it deletes them: it is written
-- AFTER that delete, with company_id null, which app.audit_events.company_id already allows and operator.add
-- already uses that way.
-- No auth.users row and no app.profiles row is touched: an account may be a member of another company, an
-- operator, or simply a person with a display name, and a company's deletion has no authority over any of
-- that. The answer carries orphaned_user_ids instead, and those go through the account sweep (B12), which is
-- the one place an account is deleted. One door for companies, one door for accounts, neither reaching into
-- the other.
create or replace function api.delete_company(p_company uuid, p_confirm_slug text, p_reason_code text)
returns table (company_id uuid, deleted jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  op uuid := app.operator_actor();
  c app.companies;
  members uuid[];
  orphans uuid[];
  counts jsonb;
  total bigint;
  d jsonb := '{}'::jsonb;
  n bigint;
begin
  if p_reason_code is null or p_reason_code !~ '^[a-z_]{1,40}$'
     or p_reason_code not in ('retention_deadline', 'customer_instruction', 'operator_request') then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  c := app.lock_company_operator(p_company);
  if c.status <> 'closed' then
    raise exception 'E_COMPANY_NOT_CLOSED' using errcode = 'P0001';
  end if;
  -- Row 17 above row 18 on purpose (design 3.5): a mistyped slug should be told before the operator is told
  -- the deletion is not due, because the first is a typing error and the second is a policy answer.
  if p_confirm_slug is distinct from c.slug then
    raise exception 'E_CONFIRMATION_MISMATCH' using errcode = '22023';
  end if;
  if not exists (select 1 from app.access_periods p
                  where p.company_id = c.id and p.export_by <= clock_timestamp())
     and p_reason_code <> 'customer_instruction' then
    raise exception 'E_DELETION_NOT_DUE' using errcode = 'P0001';
  end if;
  -- The bound, counted BEFORE anything is deleted. It is not a storage bound, it is a transaction-duration
  -- bound: a single transaction deleting half a million rows holds locks for long enough that a bound is
  -- worth having. Above it the deletion runs from E7's scripts/delete-company.mjs over a direct connection.
  counts := app.export_section_counts(c.id);
  select sum((counts ->> k)::bigint) into total
    from unnest(app.deletion_section_names()) k
   where counts ? k;
  total := coalesce(total, 0)
           + (select count(*) from app.idempotency_keys i
               where i.membership_id in (select m.id from app.memberships m where m.company_id = c.id))
           + 1;                                                  -- the company row itself
  if total > app.limit_delete_rows() then
    raise exception 'E_DELETE_TOO_LARGE' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(m.user_id), '{}') into members
    from app.memberships m where m.company_id = c.id;
  perform set_config('app.tenant_deletion', 'on', true);
  delete from app.installation_witnesses where installation_witnesses.company_id = c.id;
  get diagnostics n = row_count; d := d || jsonb_build_object('installation_witnesses', n);
  delete from app.installation_reports where installation_reports.company_id = c.id;
  get diagnostics n = row_count; d := d || jsonb_build_object('installation_reports', n);
  delete from app.release_downloads where release_downloads.company_id = c.id;
  get diagnostics n = row_count; d := d || jsonb_build_object('release_downloads', n);
  delete from app.releases where releases.company_id = c.id;
  get diagnostics n = row_count; d := d || jsonb_build_object('releases', n);
  delete from app.reviews where reviews.company_id = c.id;
  get diagnostics n = row_count; d := d || jsonb_build_object('reviews', n);
  delete from app.review_envelopes where review_envelopes.company_id = c.id;
  get diagnostics n = row_count; d := d || jsonb_build_object('review_envelopes', n);
  -- app.candidate_contributors carries no company_id: the deletion reaches it through app.candidate_versions,
  -- whose candidate_versions_company_state index leads with company_id.
  delete from app.candidate_contributors cc
   where exists (select 1 from app.candidate_versions v
                  where v.id = cc.candidate_id and v.company_id = c.id);
  get diagnostics n = row_count; d := d || jsonb_build_object('candidate_contributors', n);
  delete from app.candidate_versions where candidate_versions.company_id = c.id;
  get diagnostics n = row_count; d := d || jsonb_build_object('candidate_versions', n);
  delete from app.agents where agents.company_id = c.id;
  get diagnostics n = row_count; d := d || jsonb_build_object('agents', n);
  delete from app.group_members where group_members.company_id = c.id;
  get diagnostics n = row_count; d := d || jsonb_build_object('group_members', n);
  delete from app.groups where groups.company_id = c.id;
  get diagnostics n = row_count; d := d || jsonb_build_object('groups', n);
  delete from app.idempotency_keys
   where membership_id in (select m.id from app.memberships m where m.company_id = c.id);
  get diagnostics n = row_count; d := d || jsonb_build_object('idempotency_keys', n);
  delete from app.invitations where invitations.company_id = c.id;
  get diagnostics n = row_count; d := d || jsonb_build_object('invitations', n);
  delete from app.audit_events where audit_events.company_id = c.id;
  get diagnostics n = row_count; d := d || jsonb_build_object('audit_events', n);
  delete from app.memberships where memberships.company_id = c.id;
  get diagnostics n = row_count; d := d || jsonb_build_object('memberships', n);
  delete from app.access_periods where access_periods.company_id = c.id;
  get diagnostics n = row_count; d := d || jsonb_build_object('access_periods', n);
  delete from app.company_quotas where company_quotas.company_id = c.id;
  get diagnostics n = row_count; d := d || jsonb_build_object('company_quotas', n);
  delete from app.companies where id = c.id;
  get diagnostics n = row_count; d := d || jsonb_build_object('companies', n);
  select coalesce(array_agg(u), '{}') into orphans
    from unnest(members) u
   where not exists (select 1 from app.memberships m where m.user_id = u);
  -- LAST, after the company's own audit rows are gone, with company_id null (design 1.6, 2.4).
  perform app.audit(null, op, 'operator', 'company.delete', 'company', c.id,
    jsonb_build_object('company_id', c.id, 'reason_code', p_reason_code,
                       'deleted_rows', (select sum(v::bigint) from jsonb_each_text(d) x(k, v)),
                       'section_counts', d));
  return query select c.id, d || jsonb_build_object('orphaned_user_ids', to_jsonb(orphans));
end $$;

-- The export's whole authorization, written once (design 1.6). It is the ONE EXCEPTION to app.has_role, which
-- requires an active company: the export has to work for the admin of a SUSPENDED company during the 14-day
-- window, which is exactly the person the accepted predicate would refuse. lib/services/export.mjs therefore
-- does not call loadPrincipal either, which is the shape lib/services/operator.mjs already has.
-- app.export_candidate_visible (E6S-C-F3). The takeout's own row predicate, and the reason it cannot be
-- app.candidate_visible_to.
--
-- The defect. app.candidate_visible_to reaches app.membership_of, which joins app.companies ON status = 'active'.
-- A SUSPENDED company therefore has no visible membership and every candidate row fell out of the document,
-- while `withheld` labelled the loss `another_author_draft`. The fourteen-day window of 1.5 is EXACTLY the
-- suspended case: the expiry sweep suspends at export_by and the customer's own copy is what the window exists
-- for, so the one state the takeout has to serve is the one state that predicate refuses. The critique exported
-- a company with one submitted, approved and released candidate: the candidate count fell from one to zero, the
-- release count stayed one, and the document said the missing rows were somebody's draft
-- (evidence/e6-server-critique.md E6S-C-F3).
--
-- THE THREE THINGS IT KEEPS, all three in this one body so no caller can hold only two of them:
--   1. the caller's ACTIVE MEMBERSHIP ROW, in the company the candidate belongs to;
--   2. ADMIN AUTHORITY AT AAL2, the role from that membership row and the assurance level from the request's own
--      claims, which is the same pair app.export_admin tests before any section is assembled;
--   3. the exclusion of ANOTHER AUTHOR'S UNSUBMITTED DRAFT, which is E1 section 6's rule and the only thing a
--      company admin may not read of their own company.
-- What it does NOT test is the company's status, which is the whole correction: a suspended company inside its
-- window is admitted, and a CLOSED one is refused by app.export_admin above, where closure has always been.
--
-- THE ORDER OF THE TWO DATES, because the takeout's window and E6S-C-F2's read cutoff are the same date
-- (export_by). api.export_company tests export_by ITSELF, in its own body, BEFORE it assembles any section, so
-- this predicate only ever runs strictly inside the window and never needs app.read_window_open. Writing the
-- cutoff in here as well would be a second copy of one date in two places, which is what 1.5 exists to prevent.
-- The order inside api.export_company after E6S-C-F4 is: the admin predicate first (404/403), then export_by
-- (409), then the sections. So: authority, then time, then rows.
create or replace function app.export_candidate_visible(p_candidate uuid, p_membership uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.candidate_versions v
      join app.memberships m on m.id = p_membership and m.company_id = v.company_id
     where v.id = p_candidate
       and m.status = 'active'
       and 'company_admin' = any (m.roles)
       and app.jwt_claims() ->> 'aal' = 'aal2'
       and (v.author_membership_id = m.id or v.state <> 'draft'))
$$;
revoke all on function app.export_candidate_visible(uuid, uuid) from public;

create or replace function app.export_admin(p_company uuid) returns app.memberships
language plpgsql stable security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  c app.companies;
  m app.memberships;
begin
  select * into c from app.companies where id = p_company;
  if c.id is null then raise exception 'E_NOT_FOUND' using errcode = 'P0002'; end if;
  select * into m from app.memberships
   where memberships.company_id = p_company and user_id = actor and status = 'active';
  if m.id is null then raise exception 'E_NOT_FOUND' using errcode = 'P0002'; end if;
  if not ('company_admin' = any (m.roles)) then
    raise exception 'E_FORBIDDEN' using errcode = '42501';
  end if;
  perform app.require_mfa('E_ADMIN_MFA_REQUIRED');
  -- Closure makes every read refuse, the export included (design 3.1 note 3). It sits BELOW the admin test,
  -- so a stranger guessing a company id learns nothing about its status.
  if c.status = 'closed' then
    raise exception 'E_FORBIDDEN' using errcode = '42501';
  end if;
  return m;
end $$;
revoke all on function app.export_admin(uuid) from public;

-- api.export_company (design 1.6). A COMPANY ADMIN at aal2 of that company, and NOBODY ELSE: the first
-- version of the design gave the same routine to an operator and emitted the same rows either way, which is
-- the exact opposite of the operator's no-content boundary through a door that counts cannot constrain
-- (E6D-C-F1a). There is no operator arm. The operator reads api.operator_export_manifest and, for a complete
-- export, E7's owner-side scripts/export-company.mjs.
--
-- Every section carries what THAT ADMIN CAN ALREADY READ and nothing more (E6D-C-F1b). candidate_versions is
-- filtered by app.export_candidate_visible, the takeout's own predicate above, which keeps E1 section 6's rule
-- that a draft row is visible to its author's membership alone, so ANOTHER AUTHOR'S DRAFT IS WITHHELD, and its
-- contributor rows go with it, and which admits a SUSPENDED company inside its window where
-- app.candidate_visible_to silently emptied the document (E6S-C-F3). The
-- document says what it withheld, so the file is honest about not being the whole tenant; `withheld` is
-- always present even when empty, so a reader can tell "nothing was withheld" from "this export predates the
-- rule".
-- Two exceptions are named rather than smuggled. releases.assembled_content IS emitted although
-- authenticated holds no column privilege on it: that grant is a ROUTING rule, so release bytes leave through
-- api.authorize_download and write a ledger row, not a confidentiality rule against the company's own
-- administrator. The consequence, which belongs in the open questions and not in a footnote: an admin can
-- obtain the bytes of every published release of their company without an authorization ledger row. What
-- records it is this routine's own audit row. And access_periods is WITHHELD entirely, because no policy
-- admits authenticated to it and including it would answer design question 3 by the back door.
--
-- It is NOT streamed and no streaming contract exists anywhere in the accepted adapter (E6D-C-F8):
-- lib/db/server.mjs's callAs parses the whole RPC answer, so the document is buffered twice inside the
-- function, and the ceiling is set so that buffering it is affordable. Two gates: the cheap estimate from the
-- two byte sums, so a 200 MiB company is never assembled, and the exact octet_length of the serialized
-- document, which is the one that is true rather than estimated.
--
-- The snapshot is established BEFORE invocation by the alter function below and never by a SET inside the
-- body, which PostgreSQL refuses with SQLSTATE 25001 once the invoking statement has begun (E6D-C-F9). The
-- routine stays VOLATILE because it writes the audit row; declaring it STABLE would be a false promise and
-- would not give a snapshot anyway.
create or replace function api.export_company(p_company uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me app.memberships;
  actor uuid := app.server_actor();
  c app.companies;
  doc jsonb;
  sections jsonb;
  counts jsonb;
  withheld jsonb := '{}'::jsonb;
  all_counts jsonb;
  n_bytes integer;
  withheld_rows integer := 0;
begin
  -- AUTHORITY FIRST, THEN TIME (E6S-C-F4), and the design comment that said the opposite was wrong. The claim
  -- was that a stranger meets 404 at the admin test either way. It does not: with the time test above the admin
  -- test, another company's admin and an operator at both assurance levels received 409 E_ACCESS_PERIOD_ENDED
  -- for a company that exists and 404 for a random id, which tells anyone holding a company id whether that
  -- company exists and that its agreement has ended. app.export_admin answers 404 without an active membership,
  -- so establishing the caller's standing first makes the two answers identical; an operator, who is never a
  -- member, stays 404. The window's end IS a fact about the company, and that is precisely why it may only be
  -- told to somebody who belongs to it.
  me := app.export_admin(p_company);
  select * into c from app.companies where id = p_company;
  if c.id is null then raise exception 'E_NOT_FOUND' using errcode = 'P0002'; end if;
  -- This routine loads no principal, so it carries the read boundary of design 1.5 itself, and it is the ONE
  -- test of export_by in this transaction: app.export_candidate_visible below deliberately does not repeat it.
  if exists (select 1 from app.access_periods p
              where p.company_id = c.id and p.export_by <= clock_timestamp()) then
    raise exception 'E_ACCESS_PERIOD_ENDED' using errcode = 'P0001';
  end if;
  -- Gate 1, before anything is assembled.
  if 2 * (app.company_content_bytes(c.id) + app.company_assembled_bytes(c.id))
     > app.limit_export_bytes() then
    raise exception 'E_EXPORT_TOO_LARGE' using errcode = 'P0001';
  end if;
  all_counts := app.export_section_counts(c.id);
  select jsonb_build_object(
    'access_periods', '[]'::jsonb,
    'company_quotas', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select company_id, name, value, updated_at from app.company_quotas
        where company_id = c.id order by name) x),
    'memberships', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select id, company_id, user_id, status, roles, created_at, removed_at from app.memberships
        where company_id = c.id order by created_at, id) x),
    'invitations', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select id, company_id, email_normalized, roles, expires_at, created_by, created_by_operator,
              created_at, accepted_membership_id, accepted_at, revoked_at
         from app.invitations where company_id = c.id order by created_at, id) x),
    'profiles', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select f.user_id, f.display_name, f.updated_at from app.profiles f
        where exists (select 1 from app.memberships m
                       where m.company_id = c.id and m.user_id = f.user_id)
        order by f.user_id) x),
    'groups', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select id, company_id, name, created_by_membership_id, created_at from app.groups
        where company_id = c.id order by name) x),
    'group_members', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select group_id, company_id, membership_id, added_by_membership_id, added_at from app.group_members
        where company_id = c.id order by group_id, membership_id) x),
    'agents', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select id, company_id, name, creator_membership_id, owner_membership_id, status, created_at
         from app.agents where company_id = c.id order by name) x),
    'candidate_versions', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select id, company_id, agent_id, sequence, state, version, author_membership_id,
              supersedes_candidate_id, content, encode(content_sha256, 'hex') as content_sha256,
              derived_canonical, encode(derived_sha256, 'hex') as derived_sha256, derived, gate_id,
              validated_at, attested_by, attested_at, submitted_at, submitted_by_membership_id,
              source_platform, confidence, permitted_data, dependencies
         from app.candidate_versions v
        where v.company_id = c.id and app.export_candidate_visible(v.id, me.id)
        order by agent_id, sequence, version) x),
    'candidate_contributors', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select cc.id, cc.candidate_id, cc.membership_id, cc.kind, cc.display_name,
              cc.inherited_from_candidate_id, cc.observed, cc.created_at
         from app.candidate_contributors cc
         join app.candidate_versions v on v.id = cc.candidate_id
        where v.company_id = c.id and app.export_candidate_visible(v.id, me.id)
        order by cc.candidate_id, cc.id) x),
    'review_envelopes', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select id, company_id, agent_id, candidate_id, revision,
              encode(content_sha256, 'hex') as content_sha256,
              encode(derived_sha256, 'hex') as derived_sha256, gate_id,
              encode(gate_identity_sha256, 'hex') as gate_identity_sha256, target,
              encode(installer_text_sha256, 'hex') as installer_text_sha256,
              encode(core_sha256, 'hex') as core_sha256, encode(branch_sha256, 'hex') as branch_sha256,
              encode(judge_sha256, 'hex') as judge_sha256, policy_id,
              encode(policy_sha256, 'hex') as policy_sha256, assembled_bytes, audience_group_ids,
              envelope_canonical, encode(envelope_sha256, 'hex') as envelope_sha256,
              created_by_membership_id, created_at
         from app.review_envelopes where company_id = c.id order by candidate_id, revision) x),
    'reviews', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select id, company_id, candidate_id, envelope_id, role, decision, reviewer_membership_id, reason,
              created_at from app.reviews where company_id = c.id order by created_at, id) x),
    'releases', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select id, company_id, agent_id, candidate_id, envelope_id, target, gate_id,
              encode(content_sha256, 'hex') as content_sha256,
              encode(derived_sha256, 'hex') as derived_sha256,
              encode(installer_text_sha256, 'hex') as installer_text_sha256,
              encode(core_sha256, 'hex') as core_sha256, encode(branch_sha256, 'hex') as branch_sha256,
              encode(judge_sha256, 'hex') as judge_sha256, policy_id,
              encode(policy_sha256, 'hex') as policy_sha256, audience_group_ids,
              encode(envelope_sha256, 'hex') as envelope_sha256, assembled_content,
              encode(assembled_sha256, 'hex') as assembled_sha256, assembled_bytes, state,
              published_by_membership_id, published_at, superseded_by_release_id, superseded_at,
              withdrawn_by_membership_id, withdrawn_at, withdrawal_reason
         from app.releases where company_id = c.id order by published_at, id) x),
    'release_downloads', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select id, company_id, release_id, membership_id, authorized_at from app.release_downloads
        where company_id = c.id order by authorized_at, id) x),
    'installation_reports', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select id, company_id, release_id, membership_id, status, losses, assistance, source, reported_at
         from app.installation_reports where company_id = c.id order by reported_at, id) x),
    'installation_witnesses', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select id, company_id, report_id, release_id, witness_membership_id, witness_role, status, note,
              witnessed_at from app.installation_witnesses where company_id = c.id
        order by witnessed_at, id) x),
    'audit_events', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select id, company_id, actor_user_id, actor_kind, action, entity_type, entity_id, details, at
         from app.audit_events where company_id = c.id order by at, id) x),
    -- The last four are not the company's rows, and they are in the export because without them nobody can
    -- tell later what was approved and what was distributed: an envelope names an installer text by hash and
    -- a release carries the assembled bytes, and the registers are what turn those hashes back into what was
    -- actually shipped (design 1.6).
    'release_targets', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select t.target, t.publishable, t.registered_at from app.release_targets t
        where t.target in (select r.target from app.releases r where r.company_id = c.id
                           union select e.target from app.review_envelopes e where e.company_id = c.id)
        order by t.target) x),
    'installer_texts', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select it.gate_id, it.target, it.text, encode(it.text_sha256, 'hex') as text_sha256,
              encode(it.core_sha256, 'hex') as core_sha256, encode(it.branch_sha256, 'hex') as branch_sha256,
              encode(it.judge_sha256, 'hex') as judge_sha256
         from app.installer_texts it
        where (it.gate_id, it.target) in
          (select r.gate_id, r.target from app.releases r where r.company_id = c.id
           union select e.gate_id, e.target from app.review_envelopes e where e.company_id = c.id)
        order by it.gate_id, it.target) x),
    'release_policies', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select pol.id, pol.version, pol.canonical, encode(pol.sha256, 'hex') as sha256, pol.active,
              pol.registered_at from app.release_policies pol
        where pol.id in (select r.policy_id from app.releases r where r.company_id = c.id
                         union select e.policy_id from app.review_envelopes e where e.company_id = c.id)
        order by pol.version) x),
    'gate_identities', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from
      (select gi.id, encode(gi.identity_sha256, 'hex') as identity_sha256,
              encode(gi.adapter_lock_sha256, 'hex') as adapter_lock_sha256, gi.validator_version,
              encode(gi.manifest_sha256, 'hex') as manifest_sha256, gi.upstream_commit, gi.registered_at,
              gi.active from app.gate_identities gi
        where gi.id in (select v.gate_id from app.candidate_versions v where v.company_id = c.id
                        union select r.gate_id from app.releases r where r.company_id = c.id
                        union select e.gate_id from app.review_envelopes e where e.company_id = c.id)
        order by gi.registered_at, gi.id) x))
  into sections;
  select jsonb_object_agg(k, jsonb_array_length(v)) into counts from jsonb_each(sections) s(k, v);
  -- What was NOT emitted, per section, with its reason. A section with nothing withheld is absent.
  if (all_counts ->> 'access_periods')::int > 0 then
    withheld := withheld || jsonb_build_object('access_periods',
      jsonb_build_object('rows', (all_counts ->> 'access_periods')::int,
                         'reason', 'no_admin_read_predicate'));
    withheld_rows := withheld_rows + (all_counts ->> 'access_periods')::int;
  end if;
  if (all_counts ->> 'candidate_versions')::int > (counts ->> 'candidate_versions')::int then
    withheld := withheld || jsonb_build_object('candidate_versions',
      jsonb_build_object('rows', (all_counts ->> 'candidate_versions')::int
                                 - (counts ->> 'candidate_versions')::int,
                         'reason', 'another_author_draft'));
    withheld_rows := withheld_rows + (all_counts ->> 'candidate_versions')::int
                     - (counts ->> 'candidate_versions')::int;
  end if;
  if (all_counts ->> 'candidate_contributors')::int > (counts ->> 'candidate_contributors')::int then
    withheld := withheld || jsonb_build_object('candidate_contributors',
      jsonb_build_object('rows', (all_counts ->> 'candidate_contributors')::int
                                 - (counts ->> 'candidate_contributors')::int,
                         'reason', 'another_author_draft'));
    withheld_rows := withheld_rows + (all_counts ->> 'candidate_contributors')::int
                     - (counts ->> 'candidate_contributors')::int;
  end if;
  doc := jsonb_build_object(
    'exported_at', clock_timestamp(),
    'schema_version', 1,
    'company', jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name, 'status', c.status,
                                  'created_at', c.created_at),
    'sections', sections,
    'counts', counts,
    'withheld', withheld,
    'omitted', to_jsonb(array['invitations.token_hash', 'idempotency_keys', 'auth.users', 'operators',
                              'operator_allowlist', 'mfa_attempt_windows', 'gate_identity_files',
                              'access_periods']::text[]));
  -- Gate 2, the exact check, on the serialized document and before it is returned.
  n_bytes := octet_length(doc::text);
  if n_bytes > app.limit_export_bytes() then
    raise exception 'E_EXPORT_TOO_LARGE' using errcode = 'P0001';
  end if;
  -- Why an export writes an audit row: it is the one read in the product that hands a whole company's
  -- content to one caller in one act. The row records WHO exported and HOW MUCH, never what. withheld_rows is
  -- in the row so that the audit and the document agree about the export not being the whole tenant.
  perform app.audit(c.id, actor, 'member', 'company.export', 'company', c.id,
    jsonb_build_object('company_id', c.id, 'membership_id', me.id, 'section_counts', counts,
                       'withheld_rows', withheld_rows, 'serialized_bytes', n_bytes));
  return doc;
end $$;
-- The snapshot, established before invocation: PostgREST applies a function's own setting to the transaction
-- it opens for that call (design 1.6, 2.5, E6D-C-F9). The local stack runs PostgREST v14.14; the hosted
-- version and its configuration are a named hosted check, and proving the real RPC runs at this isolation is
-- a code-review obligation, met by tests/db/30-deletion.sh section "isolation through PostgREST".
alter function api.export_company(uuid) set default_transaction_isolation = 'repeatable read';

-- ---------------------------------------------------------------------------
-- B11. app.my_standing and its view (design 1.1, 1.5). The ONLY read in the product that sees past a
--      company's status, and it is scoped to auth.uid().
--      Today a member of a suspended company meets two different answers: 409 E_COMPANY_INACTIVE on a write,
--      because lock_company says so, and 404 E_NOT_FOUND on a read, because the membership read came back
--      empty and loadPrincipal cannot tell a suspension from a foreign id. GET /api/me is worse: the company
--      disappears from the person's list entirely and the home page says the account has no active company
--      membership, which is false and unexplained. One definer door and one view, and both loaders use it.
--      access_state is derived from TIME, never from c.status, so the read boundary at export_by does not
--      wait for a sweep (E6D-C-F3). loadPrincipal's order: 404, then closed, then expired, then not active.
--      E6D-C-F6 IS SETTLED HERE, not carried: the predicate filters active memberships inside the door, so a
--      REMOVED member no longer reads their old company's current name, slug and status through this view.
--      loadPrincipal already answers 404 for a removed membership, and GET /api/me listing a company the
--      person has left would be a disclosure with no reader. The membership_status column stays in the
--      signature, always 'active', because the two loaders' branches are written against it and a column
--      removed from an accepted shared read is a change the services lane did not ask for.
--      security_invoker on the view and a definer function behind it: the view runs as the caller, the
--      function reads auth.uid() from the caller's own claims, and no row of another account is reachable.
-- ---------------------------------------------------------------------------
create or replace function app.my_standing() returns table (
  membership_id uuid, company_id uuid, roles text[], membership_status text,
  company_slug text, company_name text, company_status text, access_state text)
language sql stable security definer set search_path = '' as $$
  select m.id, m.company_id, m.roles, m.status, c.slug, c.name, c.status,
         app.access_state(c.id)
    from app.memberships m join app.companies c on c.id = m.company_id
   where m.user_id = (select auth.uid()) and m.status = 'active'
$$;
grant execute on function app.my_standing() to authenticated;
create view api.my_standing with (security_invoker = true) as select * from app.my_standing();
grant select on api.my_standing to authenticated;

-- ---------------------------------------------------------------------------
-- B12. The account sweep's owner-side functions (design 1.5). Granted to NOBODY: scripts/sweep-accounts.mjs
--      runs them as the owner over a direct connection, and the service key therefore never enters the
--      request path, which is the strongest form of E1's rule that lib/operator/ must not be reachable from
--      a public route without operator MFA.
--      A candidate is conservative on purpose: each clause alone would be enough for the ordinary case, and
--      together they mean that anything a person has ever done with the account keeps it.
--      app.memberships.user_id references auth.users with ON DELETE NO ACTION, so an account holding any
--      membership cannot be deleted at all; app.operators.user_id and app.profiles.user_id both CASCADE, so
--      deleting a user would silently delete their operator row and their display name, which is why the
--      predicate excludes both and why the exclusion is not decoration.
-- ---------------------------------------------------------------------------
create or replace function app.sweep_candidate_ids(p_limit integer default 100) returns uuid[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(u.id order by u.created_at), '{}'::uuid[]) from (
    select u2.id, u2.created_at from auth.users u2
     where u2.email_confirmed_at is null
       and u2.created_at <= clock_timestamp() - app.account_sweep_grace()
       and not exists (select 1 from app.memberships m where m.user_id = u2.id)
       and not exists (select 1 from app.operators o where o.user_id = u2.id)
       and not exists (select 1 from app.profiles f where f.user_id = u2.id)
       and not exists (select 1 from auth.sessions s where s.user_id = u2.id)
       and not exists (select 1 from app.invitations i
                        where i.email_normalized = lower(u2.email)
                          and i.accepted_at is null and i.revoked_at is null
                          and i.expires_at + app.account_sweep_grace() > clock_timestamp())
     order by u2.created_at
     limit p_limit) u
$$;
-- The count the register reports, so the operator page shows when the sweep is worth running. It offers no
-- button, because the browser cannot run the script (design 1.5). Unbounded on purpose: it is a count.
create or replace function app.sweep_candidate_count() returns integer
language sql stable set search_path = '' as $$
  select coalesce(cardinality(app.sweep_candidate_ids(2147483647)), 0)
$$;
-- A read. Writes nothing, so an interrupted run leaves fewer candidates and no false record.
create or replace function app.sweep_candidates(p_limit integer default 100) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('user_ids', to_jsonb(app.sweep_candidate_ids(p_limit)),
                            'remaining', app.sweep_candidate_count())
$$;
-- One account.delete audit row per id that ACTUALLY returned a success from GoTrue, reported back by
-- lib/operator/accounts.mjs after the deletes. The audit therefore never claims a deletion that did not
-- happen, which is the failure a single combined call would have.
create or replace function app.sweep_recorded(p_operator uuid, p_user_ids uuid[]) returns jsonb
language plpgsql set search_path = '' as $$
declare
  u uuid;
  n integer := 0;
begin
  if p_operator is null or not exists (select 1 from app.operators o where o.user_id = p_operator) then
    raise exception 'E_NOT_OPERATOR' using errcode = '42501';
  end if;
  foreach u in array coalesce(p_user_ids, '{}'::uuid[]) loop
    perform app.audit(null, p_operator, 'operator', 'account.delete', 'account', u,
      jsonb_build_object('user_id', u, 'reason_code', 'unclaimed_invitation'));
    n := n + 1;
  end loop;
  return jsonb_build_object('recorded', n);
end $$;
revoke all on function app.sweep_candidate_ids(integer), app.sweep_candidate_count(),
  app.sweep_candidates(integer), app.sweep_recorded(uuid, uuid[]) from public;

-- ---------------------------------------------------------------------------
-- B13. app.audit_details_guard: 007's body, every rule kept, plus the keys of design 2.4. It grows by id,
--      integer, enumerated and short-code keys only. No free text and no address.
-- ---------------------------------------------------------------------------
create or replace function app.audit_details_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  k text;
  v jsonb;
  ok boolean;
  e text;
begin
  for k, v in select * from jsonb_each(new.details) loop
    ok := false;
    case k
      when 'membership_id', 'user_id', 'invitation_id', 'company_id', 'operator_user_id',
           'previous_admin_membership_id', 'replaced_by_invitation_id', 'replaces_invitation_id',
           -- E3
           'candidate_id', 'agent_id', 'contributor_membership_id', 'supersedes_candidate_id',
           -- E4
           'group_id', 'envelope_id', 'review_id', 'release_id', 'superseded_by_release_id',
           -- E5
           'report_id', 'witness_id',
           -- E6 (design 2.4)
           'previous_owner_membership_id' then
        ok := jsonb_typeof(v) = 'string'
              and (v #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
      when 'roles_before', 'roles_after', 'roles' then
        ok := jsonb_typeof(v) = 'array'
              and not exists (select 1 from jsonb_array_elements(v) x
                              where jsonb_typeof(x) <> 'string' or not ((x #>> '{}') = any (app.role_names())));
      when 'status_before', 'status_after' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') in ('active', 'removed', 'suspended', 'closed');
      -- E6: the three access-period dates take the shape expires_at already has.
      when 'expires_at', 'ends_at', 'export_by', 'delete_by' then
        if jsonb_typeof(v) = 'string' then
          begin
            perform (v #>> '{}')::timestamptz;
            ok := true;
          exception when others then
            ok := false;
          end;
        end if;
      when 'reason_code' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^[a-z_]{1,40}$';
      when 'changed', 'reactivated' then
        ok := jsonb_typeof(v) = 'boolean';
      -- E3
      when 'content_sha256', 'derived_sha256', 'gate_identity_sha256',
           -- E4
           'envelope_sha256', 'assembled_sha256', 'policy_sha256', 'installer_text_sha256' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^[0-9a-f]{64}$';
      when 'sequence', 'version',
           -- E4
           'envelope_revision', 'recipient_count',
           -- E5
           'authorizations',
           -- E6 (design 2.4)
           'quota_value', 'quota_value_before', 'deleted_rows', 'withheld_rows', 'serialized_bytes' then
        ok := jsonb_typeof(v) = 'number' and (v #>> '{}') ~ '^-?[0-9]+$';
      when 'candidate_state_after' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') = any (app.candidate_states());
      when 'agent_status_after' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') = any (app.agent_statuses());
      when 'contributor_kind' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') = any (app.contributor_kinds());
      -- E4
      when 'release_target' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') = any (app.release_target_names());
      when 'review_role' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') = any (app.review_roles());
      when 'review_decision' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') = any (app.review_decisions());
      when 'release_state_after' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') = any (app.release_states());
      -- E5
      when 'installation_status' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') = any (app.installation_statuses());
      when 'installation_source' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') = any (app.installation_sources());
      when 'witness_role' then
        ok := jsonb_typeof(v) = 'string'
              and (v #>> '{}') in ('it_reviewer', 'business_reviewer', 'company_admin');
      -- E6 (design 2.4)
      when 'quota_name' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') = any (app.quota_names());
      -- THE ONE NESTED VALUE THIS GUARD HAS EVER ADMITTED, and it is admitted because a per-section count is
      -- the only place the evidence is a number per table. Every key is checked against THE ACTING ACTION'S
      -- fixed list and every value as an integer, so it is a shape rule like the others and not an escape
      -- hatch: the eighteen deletion sections for company.delete, the twenty-one export sections for
      -- company.export. E6D-C-F15 was one shared eighteen-name list, which refused the export's insert
      -- outright because profiles, release_targets, installer_texts, release_policies and gate_identities are
      -- export sections and not deletion sections.
      when 'section_counts' then
        ok := jsonb_typeof(v) = 'object'
              and new.action in ('company.delete', 'company.export')
              and not exists (
                select 1 from jsonb_each(v) sc(sk, sv)
                 where jsonb_typeof(sv) <> 'number'
                    or (sv #>> '{}') !~ '^-?[0-9]+$'
                    or not (sk = any (case when new.action = 'company.delete'
                                           then app.deletion_section_names()
                                           else app.export_section_names() end)));
      else
        raise exception 'E_AUDIT_DETAILS_KEY %', k using errcode = '23514';
    end case;
    if not ok then
      raise exception 'E_AUDIT_DETAILS_VALUE %', k using errcode = '23514';
    end if;
  end loop;
  if octet_length(new.details::text) > 2048 then
    raise exception 'E_AUDIT_DETAILS_SIZE' using errcode = '23514';
  end if;
  return new;
end $$;


-- ---------------------------------------------------------------------------
-- B15. api.authorize_download, 007's body with exactly ONE more arm (E6S-F1).
--
--      B4/B5 replaced app.download_refusal_for and gave it a new answer, E_ACCESS_PERIOD_ENDED, which is design
--      1.5's read boundary for the one mutation that takes no company lock. api.authorize_download is 007's and
--      switches over that answer by name; a code the list does not name falls to its else, which raises a message
--      carrying no E_ token, so lib/errors.mjs answers 500 E_INTERNAL. A member of a company past its export_by
--      therefore met 500 on a download where design 1.5 and 3.1 say 409. Found through the route by
--      tests/e6/stack/routes.test.mjs case 38 and granted by the lead, 2026-09-17.
--
--      THE BODY BELOW IS 007'S, CHARACTER FOR CHARACTER, PLUS THE ONE `when` ARM, and nothing else:
--      tests/e6/unit/migration-text.test.mjs lifts both definitions from the two migration files and asserts
--      exactly that, so a reviewer does not diff a hundred lines by eye. The grants of 007 line 831 are unchanged
--      and not repeated: CREATE OR REPLACE keeps a function's privileges, its owner and its settings, and the
--      signature is identical, so no grant is lost. SECURITY DEFINER, set search_path = '' and the lock order
--      (the release row FOR SHARE, no company lock, then the predicate, the advisory lock, the quota and the
--      insert) are all 007's, unchanged.
-- ---------------------------------------------------------------------------
create or replace function api.authorize_download(p_release uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  company uuid;
  company_status text;
  member_id uuid;
  rel app.releases;
  rel_state text;
  rel_superseded uuid;
  refusal text;
  authorized timestamptz;
  n integer;
begin
  -- row 12
  if p_release is null then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  -- row 13
  select r.company_id into company from app.releases r where r.id = p_release;
  if company is null then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_standing(company, actor);
  -- row 14. E4 1.4 forbids the company lock here, so the company's state is read without taking it; app.lock_company,
  -- which is where every other routine learns this, is exactly what this routine may not call.
  select c.status into company_status from app.companies c where c.id = company;
  if company_status is distinct from 'active' then
    raise exception 'E_COMPANY_INACTIVE' using errcode = 'P0001';
  end if;
  member_id := app.membership_of(company, actor);
  if member_id is null then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  -- rows 15 to 18: the first row lock, E4 1.4's predicate. A withdrawal holding FOR UPDATE makes this wait, then
  -- PostgreSQL re-evaluates the WHERE on the committed row version and returns nothing; the wait is bounded by
  -- app_server's lock_timeout, which lib/errors.mjs answers as E_BUSY (E4 case 51).
  select r.* into rel from app.releases r
   where r.id = p_release and r.state = 'published' and r.superseded_by_release_id is null
     for share;
  if not found then
    -- rows 15 to 17, and E5D-C-F1. Visibility decides first, through app.release_visible_to with the server actor:
    -- reporting E_RELEASE_WITHDRAWN unconditionally would tell a member who was never in the audience that a release
    -- they cannot see exists and has been withdrawn. The second read takes no lock and writes nothing, so the
    -- linearization point does not move.
    if not app.release_visible_to(p_release, actor) then
      raise exception 'E_NOT_FOUND' using errcode = 'P0002';
    end if;
    select r.state, r.superseded_by_release_id into rel_state, rel_superseded
      from app.releases r where r.id = p_release;
    if rel_state <> 'published' then
      raise exception 'E_RELEASE_WITHDRAWN' using errcode = 'P0001';
    end if;
    if rel_superseded is not null then
      raise exception 'E_RELEASE_SUPERSEDED' using errcode = 'P0001';
    end if;
    -- Neither: the row moved back inside the predicate between the two reads, which no accepted transition allows.
    raise exception 'E_BUSY' using errcode = 'P0001';
  end if;
  -- E5D-C-F2. Two downloads at count 199 both hold compatible share locks and would both pass a count of 199, so the
  -- quota needs its own serialization. A transaction-scoped advisory lock on this (release, membership) pair is taken
  -- after the release share lock and released at commit. It does not invert design 2.5's order: it is not a row lock,
  -- nothing else in the product takes it, and the only transactions that wait on it are other downloads by the same
  -- membership of the same release, which hold nothing this one needs. The company lock and a stronger release lock are
  -- both forbidden here (E4 1.4), which is why neither is used. The two-integer advisory space is a different space
  -- from the single-bigint one tests/db/fixtures/e5-download-mutant.sql uses for its barrier, so the two cannot
  -- collide. The count below runs in a later statement, which under READ COMMITTED takes its own snapshot and therefore
  -- sees the row a download that held this lock before it committed.
  perform pg_advisory_xact_lock(hashtext('app.release_downloads'),
                                hashtext(p_release::text || ':' || member_id::text));
  -- rows 19 to 23, in design 3.5's order, from the one predicate (design 1.1)
  refusal := app.download_refusal_for(rel, member_id);
  if refusal is not null then
    case refusal
      when 'E_NOT_FOUND' then
        raise exception 'E_NOT_FOUND' using errcode = 'P0002';
      when 'E_RELEASE_WITHDRAWN' then
        raise exception 'E_RELEASE_WITHDRAWN' using errcode = 'P0001';
      when 'E_RELEASE_SUPERSEDED' then
        raise exception 'E_RELEASE_SUPERSEDED' using errcode = 'P0001';
      when 'E_AGENT_ORPHANED' then
        raise exception 'E_AGENT_ORPHANED' using errcode = 'P0001';
      when 'E_AGENT_ARCHIVED' then
        raise exception 'E_AGENT_ARCHIVED' using errcode = 'P0001';
      when 'E_TARGET_NOT_PUBLISHABLE' then
        raise exception 'E_TARGET_NOT_PUBLISHABLE' using errcode = 'P0001';
      when 'E_DOWNLOAD_LIMIT' then
        raise exception 'E_DOWNLOAD_LIMIT' using errcode = 'P0001';
      when 'E_ACCESS_PERIOD_ENDED' then
        raise exception 'E_ACCESS_PERIOD_ENDED' using errcode = 'P0001';
      else
        -- A code the predicate answers that this list does not name is a defect, and it fails closed as an internal
        -- condition rather than authorizing a download nobody decided. The message carries no E_ token, so it can only
        -- reach a client as 500 E_INTERNAL (lib/errors.mjs fromPostgrest).
        raise exception 'download refusal % has no mapped status', refusal;
    end case;
  end if;
  insert into app.release_downloads (company_id, release_id, membership_id)
  values (rel.company_id, rel.id, member_id)
  returning authorized_at into authorized;
  select count(*) into n from app.release_downloads d
   where d.release_id = rel.id and d.membership_id = member_id;
  perform app.audit(company, actor, 'member', 'release.download', 'release', rel.id,
    jsonb_build_object('release_id', rel.id, 'membership_id', member_id, 'release_target', rel.target,
                       'authorizations', n));
  return jsonb_build_object('release', app.release_response(rel.id),
                            'assembled_content', rel.assembled_content,
                            'assembled_sha256', encode(rel.assembled_sha256, 'hex'),
                            'authorization', jsonb_build_object('authorized_at', authorized, 'authorizations', n));
end $$;
-- ---------------------------------------------------------------------------
-- B14. Grants. The thirteen api routines to app_server alone, by full signature; PUBLIC, anon, authenticated
--      and service_role explicitly revoked, as 001 section 5 does, so the privilege set is visible here.
--      api.export_company's grant is the one to read twice: app_server alone, and the routine's own predicate
--      admits a company admin at aal2 of that company and nobody else (design 1.6). There is no operator arm.
-- ---------------------------------------------------------------------------
revoke execute on function
  api.create_company(text, text, text, interval, timestamptz, timestamptz, text),
  api.operator_invite_admin(uuid, text, interval),
  api.set_company_status(uuid, text, text),
  api.set_access_period(uuid, text, timestamptz, timestamptz),
  api.set_company_quota(uuid, text, integer),
  api.operator_register(uuid, integer),
  api.operator_export_manifest(uuid),
  api.operator_expiry_run(integer),
  api.close_company(uuid, text, text),
  api.delete_company(uuid, text, text),
  api.export_company(uuid),
  api.transfer_agent(uuid, uuid, uuid),
  api.departure_preview(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  api.create_company(text, text, text, interval, timestamptz, timestamptz, text),
  api.operator_invite_admin(uuid, text, interval),
  api.set_company_status(uuid, text, text),
  api.set_access_period(uuid, text, timestamptz, timestamptz),
  api.set_company_quota(uuid, text, integer),
  api.operator_register(uuid, integer),
  api.operator_export_manifest(uuid),
  api.operator_expiry_run(integer),
  api.close_company(uuid, text, text),
  api.delete_company(uuid, text, text),
  api.export_company(uuid),
  api.transfer_agent(uuid, uuid, uuid),
  api.departure_preview(uuid)
to app_server;
