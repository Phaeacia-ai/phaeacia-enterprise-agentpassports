-- 001_identity.sql
-- E2 identity and tenancy. Design artifact proven against local Supabase
-- (Postgres 17.6, CLI 2.109.1); not production evidence. See
-- docs/e2/identity-tenancy-design.md for the contract this file implements.
--
-- Layout
--   schema app  private: tables, RLS policies, helper functions. Never exposed to PostgREST.
--   schema api  exposed: server-only mutation functions and security-invoker read views.
--   role app_server  the narrow server principal (B1). PostgREST switches to it when a
--                    server-minted JWT carries role=app_server. Holds EXECUTE on api.*
--                    functions and nothing else.
--   role authenticated  a member's own JWT. SELECT through api views under RLS. No DML,
--                    no EXECUTE on any api function.
--   role anon        nothing.
--   role service_role  documented RLS bypass, but no privilege on schema app: it cannot read
--                    or write any app table (design section 5). Used only by the operator
--                    client for GoTrue admin calls.
--   role app_maintenance  the reconciliation role for B7 (design section 5). NOLOGIN, not
--                    reachable through PostgREST; explicit table grants and explicit policies.
--
-- Corrections 2026-09-10 after the fresh Codex critique (evidence/e2-design-critique.md):
-- H2 admin MFA in app.require_admin; M1 locked-point expiry decision in accept_invitation;
-- M2 explicit replacement audit; M3 company status in every RLS predicate and the
-- app_maintenance role; M5 standing check before company state or foreign locks; L1 audit
-- value types and TRUNCATE guard; role vocabulary centralised in app.role_names().

-- ---------------------------------------------------------------------------
-- 0. Roles and schemas
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_server') then
    create role app_server nologin noinherit nobypassrls;
  end if;
end $$;

-- PostgREST runs as authenticator and SET ROLEs to the JWT role claim. Without this
-- grant a role=app_server token is refused by PostgREST as an unknown role.
grant app_server to authenticator;
-- statement_timeout for the server principal; lock waits inside the company lock protocol
-- fail fast instead of piling up (see design section 3).
alter role app_server set statement_timeout = '8s';
alter role app_server set lock_timeout = '5s';

create schema if not exists app;
create schema if not exists api;

revoke all on schema app from public;
revoke all on schema api from public;
grant usage on schema api to authenticated, app_server, service_role;
-- supabase_auth_admin runs the before-user-created hook, which lives in app.
grant usage on schema app to supabase_auth_admin;

-- No default privileges leak to future objects.
alter default privileges in schema app revoke execute on functions from public;
alter default privileges in schema api revoke execute on functions from public;

-- Restricted maintenance role for restore reconciliation (design section 5). NOLOGIN: a
-- login role is granted membership out of band at the recovery target, never in Git.
-- PostgREST cannot switch to it because authenticator is not a member of it.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_maintenance') then
    create role app_maintenance nologin noinherit nobypassrls;
  end if;
end $$;
grant usage on schema app to app_maintenance;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
-- The role vocabulary has one owner. CHECK constraints, validators and the audit guard all
-- read it here; adding a role is a change to this function and its fixtures, nowhere else.
create or replace function app.role_names() returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select array['member', 'it_reviewer', 'business_reviewer', 'company_admin']::text[]
$$;

-- Company lifecycle states. 'active' is the only state in which members read or write;
-- 'suspended' is reversible and 'closed' is terminal (E6 offboarding).
create or replace function app.company_statuses() returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select array['active', 'suspended', 'closed']::text[]
$$;

create table app.companies (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text not null check (length(name) between 1 and 200),
  status      text not null default 'active' check (status = any (app.company_statuses())),
  created_at  timestamptz not null default now()
);

create table app.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (length(display_name) between 1 and 120),
  updated_at   timestamptz not null default now()
);

create table app.operators (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table app.memberships (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references app.companies (id),
  user_id     uuid not null references auth.users (id),
  status      text not null default 'active' check (status in ('active', 'removed')),
  roles       text[] not null default '{member}',
  created_at  timestamptz not null default now(),
  removed_at  timestamptz,
  unique (company_id, user_id),
  constraint memberships_roles_valid check (
    roles <@ app.role_names()
    and array_ndims(roles) = 1
    and cardinality(roles) >= 1
    and 'member' = any (roles)
  ),
  constraint memberships_removed_at_matches_status check (
    (status = 'removed') = (removed_at is not null)
  )
);
create index memberships_user_active on app.memberships (user_id, company_id) where status = 'active';
create index memberships_company_admins on app.memberships (company_id) where status = 'active' and 'company_admin' = any (roles);

create table app.invitations (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references app.companies (id),
  email_normalized text not null check (email_normalized = lower(btrim(email_normalized)) and email_normalized ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  token_hash       bytea not null unique check (octet_length(token_hash) = 32),
  roles            text[] not null,
  expires_at       timestamptz not null,
  created_by       uuid not null references app.memberships (id),
  created_at       timestamptz not null default now(),
  accepted_membership_id uuid references app.memberships (id),
  accepted_at      timestamptz,
  revoked_at       timestamptz,
  constraint invitations_roles_valid check (
    roles <@ app.role_names()
    and array_ndims(roles) = 1
    and cardinality(roles) >= 1
    and 'member' = any (roles)
  ),
  constraint invitations_accept_pair check ((accepted_membership_id is null) = (accepted_at is null))
);
create index invitations_company_pending on app.invitations (company_id) where accepted_at is null and revoked_at is null;
create index invitations_email_pending on app.invitations (email_normalized) where accepted_at is null and revoked_at is null;
-- Invariant (M2): at most one pending invitation per email per company. invite_member
-- revokes the pending sibling and audits that revocation before inserting.
create unique index invitations_one_pending on app.invitations (company_id, email_normalized)
  where accepted_at is null and revoked_at is null;

create table app.audit_events (
  id            bigint generated always as identity primary key,
  company_id    uuid references app.companies (id),
  actor_user_id uuid,
  actor_kind    text not null check (actor_kind in ('member', 'operator', 'system')),
  action        text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  entity_type   text not null,
  entity_id     uuid,
  details       jsonb not null default '{}'::jsonb,
  at            timestamptz not null default now()
);
create index audit_events_company_at on app.audit_events (company_id, at desc);

-- details carries ids, states, roles and timestamps only. The trigger refuses keys outside
-- the allowlist and, for every allowed key, a value of the wrong shape (L1): ids must be
-- uuids, roles must be arrays drawn from app.role_names(), states must be known states,
-- reason codes must match ^[a-z_]{1,40}$. This is a shape guard, not a content detector:
-- a value that fits a shape is accepted whatever it means (the recheck inserted and rolled
-- back reason_code 'synthetic_passport_prose'). What keeps member-originated text out is
-- that the api routines build these values themselves from ids, states and their own
-- constant reason codes. The allowlist and the value rules are the contract (design
-- section 7).
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
           'previous_admin_membership_id', 'replaced_by_invitation_id', 'replaces_invitation_id' then
        ok := jsonb_typeof(v) = 'string'
              and (v #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
      when 'roles_before', 'roles_after', 'roles' then
        ok := jsonb_typeof(v) = 'array'
              and not exists (select 1 from jsonb_array_elements(v) x
                              where jsonb_typeof(x) <> 'string' or not ((x #>> '{}') = any (app.role_names())));
      when 'status_before', 'status_after' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') in ('active', 'removed', 'suspended', 'closed');
      when 'expires_at' then
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
create trigger audit_details_guard before insert on app.audit_events
  for each row execute function app.audit_details_guard();

-- Append-only for everyone but the table owner: no UPDATE/DELETE/TRUNCATE grants exist, and
-- the triggers below make even a mistaken owner-side UPDATE, DELETE or TRUNCATE fail. The
-- owner (postgres) can still drop the triggers; that is the disclosed infrastructure limit.
create or replace function app.audit_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'E_AUDIT_APPEND_ONLY' using errcode = '42501';
end $$;
create trigger audit_append_only before update or delete on app.audit_events
  for each row execute function app.audit_append_only();
create trigger audit_no_truncate before truncate on app.audit_events
  for each statement execute function app.audit_append_only();

-- Immutability of membership identity: a membership row is never deleted and never
-- changes company or user; reactivation keeps the id (design section 4).
create or replace function app.membership_identity_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'E_MEMBERSHIP_DELETE' using errcode = '42501';
  end if;
  if new.company_id <> old.company_id or new.user_id <> old.user_id or new.id <> old.id then
    raise exception 'E_MEMBERSHIP_IDENTITY' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger membership_identity_guard before update or delete on app.memberships
  for each row execute function app.membership_identity_guard();

-- ---------------------------------------------------------------------------
-- 2. Principal derivation (design section 1 and 6)
-- ---------------------------------------------------------------------------
-- The only trusted inputs are the JWT claims PostgREST sets after verifying the signature.
-- app.server_actor() refuses unless the token's role is app_server and carries a sub.
create or replace function app.jwt_claims() returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create or replace function app.server_actor() returns uuid
language plpgsql stable set search_path = '' as $$
declare
  c jsonb := app.jwt_claims();
  actor uuid;
begin
  if c->>'role' is distinct from 'app_server' then
    raise exception 'E_NOT_SERVER' using errcode = '42501';
  end if;
  begin
    actor := (c->>'sub')::uuid;
  exception when others then
    raise exception 'E_NOT_SERVER' using errcode = '42501';
  end;
  if actor is null then
    raise exception 'E_NOT_SERVER' using errcode = '42501';
  end if;
  return actor;
end $$;

-- MFA level. The aal claim in the server token is copied by lib/db/server.mjs from the
-- verified GoTrue session only (design section 1.4 and 6); tokens without it count as aal1.
-- Operator routines and every privileged company-admin mutation require aal2 (build plan
-- line 71: "Privileged operator and company-admin actions require configured MFA").
create or replace function app.require_mfa(p_error text) returns void
language plpgsql stable set search_path = '' as $$
begin
  if app.jwt_claims()->>'aal' is distinct from 'aal2' then
    raise exception '%', p_error using errcode = '42501';
  end if;
end $$;

-- Operator principal: an app_server token whose sub is a registered operator and whose
-- aal claim is aal2.
create or replace function app.operator_actor() returns uuid
language plpgsql stable set search_path = '' as $$
declare
  actor uuid := app.server_actor();
begin
  if not exists (select 1 from app.operators o where o.user_id = actor) then
    raise exception 'E_NOT_OPERATOR' using errcode = '42501';
  end if;
  perform app.require_mfa('E_OPERATOR_MFA_REQUIRED');
  return actor;
end $$;

-- Role validation with one vocabulary (app.role_names). Refuses null, a null element and a
-- nested array; accepts an empty array as "member only"; returns the sorted distinct set
-- with member always present. This is the only normaliser; the CHECK constraints are the
-- last line of defence, not a second policy.
create or replace function app.normalize_roles(p_roles text[]) returns text[]
language plpgsql immutable set search_path = '' as $$
begin
  if p_roles is null
     or (cardinality(p_roles) > 0 and array_ndims(p_roles) is distinct from 1)
     or exists (select 1 from unnest(p_roles) r where r is null)
     or not (p_roles <@ app.role_names()) then
    raise exception 'E_ROLES_INVALID' using errcode = '22023';
  end if;
  return (select array_agg(distinct r order by r) from unnest(array_cat(array['member'], p_roles)) r);
end $$;

-- RLS predicates. SECURITY DEFINER so the memberships policy can call them without
-- recursing into itself; they read current rows, never the JWT beyond auth.uid() (stale
-- membership rule). Company status is part of every predicate (M3): a suspended or closed
-- company is invisible to its members through every view, so quarantine by status is real.
create or replace function app.is_active_member(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.memberships m
    join app.companies c on c.id = m.company_id and c.status = 'active'
    where m.company_id = p_company
      and m.user_id = (select auth.uid())
      and m.status = 'active'
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
  )
$$;

revoke execute on function app.jwt_claims(), app.server_actor(), app.operator_actor(), app.require_mfa(text),
  app.normalize_roles(text[]), app.is_active_member(uuid), app.has_role(uuid, text) from public;
grant execute on function app.is_active_member(uuid), app.has_role(uuid, text) to authenticated;

-- Standing before state (M5). Every company-scoped mutation calls this first, before
-- app.lock_company: a caller with no active membership in the company gets E_NOT_FOUND
-- without waiting on that company's lock and without learning whether the company exists
-- or is active. It is an unlocked pre-check; app.require_admin repeats the decision under
-- the lock, which is the authoritative one.
create or replace function app.require_standing(p_company uuid, p_actor uuid) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not exists (select 1 from app.memberships m
                 where m.company_id = p_company and m.user_id = p_actor and m.status = 'active') then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
end $$;

-- Company mutex and state gate. Blocks on the company row (FOR NO KEY UPDATE) so admin
-- mutations of one company serialise; refuses a company that is not active. Called only
-- after app.require_standing for member paths, so E_COMPANY_INACTIVE reaches members only.
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
end $$;

-- Admin standing under the company lock, plus MFA (H2). Order of refusals: not an active
-- member E_NOT_FOUND (absent and stale look the same), not an admin E_FORBIDDEN, admin
-- without a verified second factor E_ADMIN_MFA_REQUIRED. Caller must hold the company lock.
create or replace function app.require_admin(p_company uuid, p_actor uuid)
returns app.memberships
language plpgsql set search_path = '' as $$
declare
  m app.memberships;
begin
  select * into m from app.memberships
  where company_id = p_company and user_id = p_actor and status = 'active';
  if m.id is null then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not ('company_admin' = any (m.roles)) then
    raise exception 'E_FORBIDDEN' using errcode = '42501';
  end if;
  perform app.require_mfa('E_ADMIN_MFA_REQUIRED');
  return m;
end $$;

create or replace function app.active_admin_count(p_company uuid, p_excluding uuid) returns integer
language sql stable set search_path = '' as $$
  select count(*)::int from app.memberships
  where company_id = p_company and status = 'active'
    and 'company_admin' = any (roles) and id is distinct from p_excluding
$$;

-- p_at lets a routine record the timestamp of its decision (M1: accept_invitation decides
-- validity at the locked point with clock_timestamp() and records that same instant).
create or replace function app.audit(p_company uuid, p_actor uuid, p_actor_kind text,
  p_action text, p_entity_type text, p_entity_id uuid, p_details jsonb,
  p_at timestamptz default now()) returns void
language sql set search_path = '' as $$
  insert into app.audit_events (company_id, actor_user_id, actor_kind, action, entity_type, entity_id, details, at)
  values (p_company, p_actor, p_actor_kind, p_action, p_entity_type, p_entity_id, p_details, p_at)
$$;

-- ---------------------------------------------------------------------------
-- 3. Row level security (design section 2)
-- ---------------------------------------------------------------------------
alter table app.companies enable row level security;
alter table app.profiles enable row level security;
alter table app.operators enable row level security;
alter table app.memberships enable row level security;
alter table app.invitations enable row level security;
alter table app.audit_events enable row level security;

-- Nothing for anon anywhere. Nothing for app_server on tables: its functions are
-- SECURITY DEFINER and carry their own checks.
create policy companies_member_read on app.companies for select to authenticated
  using (app.is_active_member(id));

create policy memberships_member_read on app.memberships for select to authenticated
  using (app.is_active_member(company_id));

create policy profiles_comember_read on app.profiles for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from app.memberships mine
      join app.memberships theirs on theirs.company_id = mine.company_id
      join app.companies c on c.id = mine.company_id and c.status = 'active'
      where mine.user_id = (select auth.uid()) and mine.status = 'active'
        and theirs.user_id = profiles.user_id and theirs.status = 'active'
    )
  );

create policy invitations_admin_read on app.invitations for select to authenticated
  using (app.has_role(company_id, 'company_admin'));

create policy audit_reviewer_read on app.audit_events for select to authenticated
  using (
    app.has_role(company_id, 'company_admin')
    or app.has_role(company_id, 'it_reviewer')
    or app.has_role(company_id, 'business_reviewer')
  );

-- Maintenance role (M3): explicit policies, explicit grants, no RLS bypass. Reconciliation
-- after a restore (design section 5) runs as this role over a direct database connection
-- at the closed recovery target. What the grants below actually allow (recheck R1, probe
-- 9d disclosure): read standing in every tenant; update companies.status, memberships
-- status/removed_at/roles and invitations.revoked_at in both directions across all tenants
-- (using (true)), with no rule check and no audit coupling; append audit rows. It cannot
-- delete anything, read invitation token hashes, rewrite membership identity or call api
-- functions. This is a trusted repair principal; the one-transaction-per-correction plus
-- audit contract belongs to the E7 reconciler, not to these grants. Narrowing them would
-- require checked maintenance routines and a matching change to probe 9d.
create policy maintenance_companies on app.companies for all to app_maintenance using (true) with check (true);
create policy maintenance_memberships on app.memberships for all to app_maintenance using (true) with check (true);
create policy maintenance_invitations on app.invitations for all to app_maintenance using (true) with check (true);
create policy maintenance_audit on app.audit_events for all to app_maintenance using (true) with check (true);
create policy maintenance_profiles on app.profiles for select to app_maintenance using (true);
create policy maintenance_operators on app.operators for select to app_maintenance using (true);
grant select on app.companies, app.memberships, app.profiles, app.operators, app.audit_events to app_maintenance;
grant select (id, company_id, email_normalized, roles, expires_at, created_by, created_at,
              accepted_membership_id, accepted_at, revoked_at) on app.invitations to app_maintenance;
grant update (status) on app.companies to app_maintenance;
grant update (status, removed_at, roles) on app.memberships to app_maintenance;
grant update (revoked_at) on app.invitations to app_maintenance;
grant insert on app.audit_events to app_maintenance;

-- ---------------------------------------------------------------------------
-- 4. Grants for authenticated: SELECT only, column-limited where a column is secret
-- ---------------------------------------------------------------------------
grant select on app.companies, app.memberships, app.profiles, app.audit_events to authenticated;
grant select (id, company_id, email_normalized, roles, expires_at, created_by, created_at,
              accepted_membership_id, accepted_at, revoked_at) on app.invitations to authenticated;
-- No INSERT, UPDATE or DELETE on any app table to authenticated, app_server or anon.
-- No grant on app.operators to anyone but the owner.

-- Exposed read views (security_invoker: RLS of the caller applies).
create view api.companies with (security_invoker = true) as
  select id, slug, name, status from app.companies;
create view api.memberships with (security_invoker = true) as
  select id, company_id, user_id, status, roles, created_at, removed_at from app.memberships;
create view api.profiles with (security_invoker = true) as
  select user_id, display_name from app.profiles;
create view api.invitations with (security_invoker = true) as
  select id, company_id, email_normalized, roles, expires_at, created_by, created_at,
         accepted_membership_id, accepted_at, revoked_at from app.invitations;
create view api.audit_events with (security_invoker = true) as
  select id, company_id, actor_user_id, actor_kind, action, entity_type, entity_id, details, at
  from app.audit_events;
grant select on api.companies, api.memberships, api.profiles, api.invitations, api.audit_events to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Server-only mutation functions (schema api, EXECUTE to app_server only)
-- ---------------------------------------------------------------------------
-- Every function: SECURITY DEFINER, search_path = '', principal from app.server_actor(),
-- company row lock first, explicit membership check, audit row in the same transaction.

-- 5.1 Invite. Returns the invitation id and the plaintext token once; only its SHA-256
-- is stored. The server emails the token and never stores it. Order: standing (M5), then
-- company lock and admin standing with MFA (H2), then input validation, then the change,
-- then audit rows for the implicit revocation of a pending sibling (M2) and the creation.
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

-- 5.2 Revoke. Explicit revocation by an admin; reason_code 'revoked' distinguishes it from
-- the implicit 'replaced' revocation written by invite_member.
create or replace function api.revoke_invitation(p_invitation uuid)
returns table (invitation_id uuid, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  inv app.invitations;
  admin app.memberships;
begin
  select * into inv from app.invitations where id = p_invitation;
  if inv.id is null then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_standing(inv.company_id, actor);
  perform app.lock_company(inv.company_id);
  admin := app.require_admin(inv.company_id, actor);
  select * into inv from app.invitations where id = p_invitation for update;
  if inv.accepted_at is not null then
    raise exception 'E_INVITATION_ACCEPTED' using errcode = 'P0001';
  end if;
  if inv.revoked_at is not null then
    return query select inv.id, false;
    return;
  end if;
  update app.invitations set revoked_at = now() where id = inv.id;
  perform app.audit(inv.company_id, actor, 'member', 'invitation.revoke', 'invitation', inv.id,
    jsonb_build_object('invitation_id', inv.id, 'membership_id', admin.id, 'reason_code', 'revoked'));
  return query select inv.id, true;
end $$;

-- 5.3 Accept. The actor is the signed-in user (server token sub). Binding: the auth.users
-- row's confirmed email equals the invitation's normalized email. Roles come from the
-- invitation row only. Reactivation keeps the membership id. Validity is decided at the
-- locked point with a fresh clock (M1): an invitation that expires while the caller waits
-- for the company lock is refused, and the recorded accepted_at is the decision instant.
-- Lock order: company, invitation, membership.
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
  decided_at timestamptz;
begin
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

-- 5.4 Change roles. Standing first (M5), company lock, admin with MFA, then the last-admin
-- rule (B5). Lock order: company, then the target membership.
create or replace function api.set_roles(p_membership uuid, p_roles text[])
returns table (membership_id uuid, roles text[], changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  target app.memberships;
  admin app.memberships;
  new_roles text[];
begin
  select * into target from app.memberships where id = p_membership;
  if target.id is null then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_standing(target.company_id, actor);
  perform app.lock_company(target.company_id);
  admin := app.require_admin(target.company_id, actor);
  select * into target from app.memberships where id = p_membership for update;
  if target.status <> 'active' then
    raise exception 'E_MEMBERSHIP_REMOVED' using errcode = 'P0001';
  end if;
  new_roles := app.normalize_roles(p_roles);
  if new_roles = target.roles then
    return query select target.id, target.roles, false;
    return;
  end if;
  if 'company_admin' = any (target.roles) and not ('company_admin' = any (new_roles))
     and app.active_admin_count(target.company_id, target.id) = 0 then
    raise exception 'E_LAST_ADMIN' using errcode = 'P0001';
  end if;
  update app.memberships set roles = new_roles where id = target.id;
  perform app.audit(target.company_id, actor, 'member', 'membership.set_roles', 'membership', target.id,
    jsonb_build_object('membership_id', target.id, 'roles_before', target.roles, 'roles_after', new_roles,
                       'previous_admin_membership_id', admin.id));
  return query select target.id, new_roles, true;
end $$;

-- 5.5 Remove. Same protocol. Idempotent: removing a removed member is a no-op.
create or replace function api.remove_member(p_membership uuid)
returns table (membership_id uuid, status text, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  target app.memberships;
  admin app.memberships;
begin
  select * into target from app.memberships where id = p_membership;
  if target.id is null then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_standing(target.company_id, actor);
  perform app.lock_company(target.company_id);
  admin := app.require_admin(target.company_id, actor);
  select * into target from app.memberships where id = p_membership for update;
  if target.status = 'removed' then
    return query select target.id, target.status, false;
    return;
  end if;
  if 'company_admin' = any (target.roles) and app.active_admin_count(target.company_id, target.id) = 0 then
    raise exception 'E_LAST_ADMIN' using errcode = 'P0001';
  end if;
  update app.memberships set status = 'removed', removed_at = now() where id = target.id;
  perform app.audit(target.company_id, actor, 'member', 'membership.remove', 'membership', target.id,
    jsonb_build_object('membership_id', target.id, 'status_before', 'active', 'status_after', 'removed',
                       'roles_before', target.roles, 'previous_admin_membership_id', admin.id));
  return query select target.id, 'removed'::text, true;
end $$;

-- 5.6 Operator: provision a company with its first admin (first named service-role place
-- in E1 architecture section 5, now carried by an operator app_server token with aal2).
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
  insert into app.companies (slug, name) values (p_slug, p_name) returning * into c;
  perform app.lock_company(c.id);
  insert into app.memberships (company_id, user_id, roles)
  values (c.id, p_first_admin_user, array['company_admin', 'member']) returning * into m;
  perform app.audit(c.id, op, 'operator', 'company.provision', 'company', c.id,
    jsonb_build_object('company_id', c.id, 'membership_id', m.id, 'operator_user_id', op));
  return query select c.id, m.id;
end $$;

-- 5.7 Operator: transfer first admin. Used when a company has lost its only admin
-- (the account, not the membership: the last-admin rule keeps the row). Grants
-- company_admin to an active member; does not demote anyone.
create or replace function api.transfer_first_admin(p_company uuid, p_target_user uuid)
returns table (membership_id uuid, roles text[], changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  op uuid := app.operator_actor();
  m app.memberships;
  new_roles text[];
begin
  perform app.lock_company(p_company);
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

-- 5.8 Register an operator. Only an existing operator with aal2 may add another; the very
-- first operator row is inserted by the migration owner out of band (design section 6).
create or replace function api.add_operator(p_user uuid)
returns table (user_id uuid, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  op uuid := app.operator_actor();
begin
  if exists (select 1 from app.operators o where o.user_id = p_user) then
    return query select p_user, false;
    return;
  end if;
  insert into app.operators (user_id) values (p_user);
  perform app.audit(null, op, 'operator', 'operator.add', 'operator', p_user,
    jsonb_build_object('user_id', p_user, 'operator_user_id', op));
  return query select p_user, true;
end $$;

-- Grants: app_server only. PUBLIC, anon and authenticated are explicitly revoked so the
-- privilege set is visible in the migration, not inferred from defaults.
revoke execute on all functions in schema api from public, anon, authenticated;
grant execute on function
  api.invite_member(uuid, text, text[], interval),
  api.revoke_invitation(uuid),
  api.accept_invitation(text),
  api.set_roles(uuid, text[]),
  api.remove_member(uuid),
  api.provision_company(text, text, uuid),
  api.transfer_first_admin(uuid, uuid),
  api.add_operator(uuid)
to app_server;

-- ---------------------------------------------------------------------------
-- 6. Auth hook: refuse account creation for anyone without a pending invitation
-- ---------------------------------------------------------------------------
-- Runs as supabase_auth_admin before GoTrue creates a user (magic link with
-- shouldCreateUser). Operators are created out of band; their emails are registered in
-- app.operator_allowlist by the migration owner.
create table app.operator_allowlist (
  email_normalized text primary key,
  added_at timestamptz not null default now()
);
alter table app.operator_allowlist enable row level security;
-- No policy and no grant: only the owner and the SECURITY DEFINER hook read it.

create or replace function app.hook_before_user_created(event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  email_n text := lower(btrim(event->'user'->>'email'));
begin
  if email_n is null or email_n = '' then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'Invitation required.'));
  end if;
  if exists (select 1 from app.invitations i where i.email_normalized = email_n
             and i.accepted_at is null and i.revoked_at is null and i.expires_at > now())
     or exists (select 1 from app.operator_allowlist a where a.email_normalized = email_n) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'Invitation required.'));
end $$;
revoke execute on function app.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function app.hook_before_user_created(jsonb) to supabase_auth_admin;
