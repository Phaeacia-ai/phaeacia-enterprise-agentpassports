-- 003_content.sql
-- E3 content persistence and attestation (docs/e3/design.md 2.2 to 2.7, 4.2 and 4.3; the
-- attestation contract as that design amends it). Agents, candidate versions and their
-- contributors, the gate registry, the idempotency claim, the bound principal, the four content
-- routines, and 2.6 item 4, the orphaning of agents in api.remove_member.
--
-- Additive. 001_identity.sql and 002_bound_principal.sql are applied and not edited. Two objects
-- they created are replaced here by create or replace, which keeps each one's owner, grants and
-- triggers: app.audit_details_guard (new key shapes only, every existing rule kept) and
-- api.remove_member (the orphaning added, every existing step kept in its order).
--
-- The SQL of design 2.3 is a sketch and this file is the migration. Where it fills a gap the
-- sketch leaves or departs from it, the comment at that object says so, and evidence/e3a.md
-- lists each one.
--
-- Disclosed, as design 2.3 requires. A CHECK violation makes PostgreSQL report "Failing row
-- contains (...)", which for app.candidate_versions would put passport text into the database
-- server log. The BEFORE trigger app.candidate_identity refuses every condition those CHECK
-- constraints repeat, first, with a code and no row echo; the CHECKs fire only if it is dropped.

-- ---------------------------------------------------------------------------
-- 1. Vocabulary and limits, each owned in one place like app.role_names()
-- ---------------------------------------------------------------------------
create or replace function app.candidate_states() returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select array['draft', 'submitted', 'changes_requested', 'approved', 'superseded']::text[]
$$;
create or replace function app.agent_statuses() returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select array['active', 'orphaned', 'archived']::text[]
$$;
create or replace function app.contributor_kinds() returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select array['author', 'editor', 'submitter', 'declared_member', 'declared_offline']::text[]
$$;

-- The plan's envelope, enforced: a 51st agent in one company is refused (the lead's Q3).
create or replace function app.limit_agents_per_company() returns integer
language sql immutable parallel safe set search_path = '' as $$ select 50 $$;
-- A DATABASE CEILING, NOT THE PLAN'S ENVELOPE. Counted over every candidate row of one agent,
-- superseded ones included, because storage is what it protects. Ten retained versions is an E4
-- retention target and not a refusal (Q3). The lead's decision, 2026-09-13: 200. At 256 KiB a
-- version that is 50 MiB per agent, 2.5 GiB per company at 50 agents, 25 GiB over ten
-- companies if every agent sits at its ceiling; the envelope's expected figure is 1.25 GiB. A
-- row is a candidate lifecycle, not a save: save_draft updates in place. Arithmetic in full at
-- design 2.3.
create or replace function app.limit_versions_per_agent() returns integer
language sql immutable parallel safe set search_path = '' as $$ select 200 $$;
-- Idempotency bounds (design 4.3). The WINDOW is how long a key returns its first answer.
create or replace function app.idempotency_window() returns interval
language sql immutable parallel safe set search_path = '' as $$ select interval '7 days' $$;
-- RETENTION is how long the row is kept, and it is a different promise. Deleting at the window
-- let one live bearer be answered from a claim and then, after the sweep, create a second
-- candidate (evidence/e3-design-recheck.md M3). The row is kept past the window by more than a
-- bearer can live: lib/db/server.mjs TOKEN_TTL_SECONDS (60) plus clock skew. The lead's decision,
-- 2026-09-13: one hour. BELOW the TTL plus skew a bearer outlives its claim; ABOVE the window the
-- two-band storage bound of 4.3 fails. What is load-bearing is the inequality, so it is written
-- as the window plus a margin. tests/db/15-idempotency.sh asserts it against the TTL. It bounds
-- bearers the row ANSWERED; a bearer the row REFUSED in the tombstone band can write after the
-- sweep, which is the accepted residual of 4.3 and that probe's control.
create or replace function app.idempotency_retention() returns interval
language sql immutable parallel safe set search_path = ''
as $$ select app.idempotency_window() + interval '1 hour' $$;
-- Rows past retention one successful call may delete.
create or replace function app.idempotency_sweep_batch() returns integer
language sql immutable parallel safe set search_path = '' as $$ select 20 $$;
-- A PRE-INSERT >= RULE: refuse when this membership ALREADY holds this many unexpired rows, so
-- the stored maximum is the ceiling itself (recheck M3_CEILING_LITERAL). The lead's decision,
-- 2026-09-13: 4,000, which an honest member can reach, because every save takes a claim row and
-- consumes no version. One save a minute for eight hours a day over the window is 3,360. The
-- storage bound is twice the ceiling plus one, 8,001 rows a membership; 7.2 asks for the
-- observed steady state before this number is trusted.
create or replace function app.limit_idempotency_rows() returns integer
language sql immutable parallel safe set search_path = '' as $$ select 4000 $$;

-- ---------------------------------------------------------------------------
-- 2. The gate registry (C1, design 2.7). Written by migrations only, never by a request.
-- ---------------------------------------------------------------------------
create table app.gate_identities (
  id                    uuid primary key default gen_random_uuid(),
  identity_sha256       bytea not null unique check (octet_length(identity_sha256) = 32),
  adapter_lock_sha256   bytea not null check (octet_length(adapter_lock_sha256) = 32),
  validator_version     text  not null check (length(validator_version) between 1 and 40),
  manifest_sha256       bytea not null check (octet_length(manifest_sha256) = 32),
  upstream_commit       text  not null check (upstream_commit ~ '^[0-9a-f]{40}$'),
  registered_at         timestamptz not null default now(),
  active                boolean not null default false
);
-- Exactly one active identity at most.
create unique index gate_identities_one_active on app.gate_identities (active) where active;

create table app.gate_identity_files (
  gate_id  uuid not null references app.gate_identities (id),
  path     text not null check (path ~ '^[a-z0-9][a-z0-9/_.-]{0,200}$' and path not like 'vendor/%'),
  sha256   bytea not null check (octet_length(sha256) = 32),
  primary key (gate_id, path)
);

-- ---------------------------------------------------------------------------
-- 3. Agents
-- ---------------------------------------------------------------------------
create table app.agents (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references app.companies (id),
  name                  text not null check (name ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  creator_membership_id uuid not null references app.memberships (id),
  owner_membership_id   uuid not null references app.memberships (id),
  status                text not null default 'active' check (status = any (app.agent_statuses())),
  created_at            timestamptz not null default now(),
  unique (company_id, name),
  unique (id, company_id)
);
-- The orphaning in api.remove_member reads a membership's owned agents.
create index agents_owner on app.agents (owner_membership_id) where status = 'active';

-- ---------------------------------------------------------------------------
-- 4. Candidate versions
-- ---------------------------------------------------------------------------
create table app.candidate_versions (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references app.companies (id),
  agent_id              uuid not null references app.agents (id),
  sequence              integer not null check (sequence >= 1),
  state                 text not null default 'draft' check (state = any (app.candidate_states())),
  version               integer not null default 1 check (version >= 1),
  author_membership_id  uuid not null references app.memberships (id),
  supersedes_candidate_id uuid references app.candidate_versions (id),
  content               text not null
                        check (octet_length(content) between 512 and 262144)
                        check (position('<!-- installer core and branches inserted on upload -->' in content) > 0)
                        check (content !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]')
                        check (content !~ '\r'),
  content_sha256        bytea not null,                  -- trigger only
  derived_canonical     text  not null,
  derived_sha256        bytea not null,                  -- trigger only
  derived               jsonb generated always as (derived_canonical::jsonb) stored,
  gate_id               uuid not null references app.gate_identities (id),
  validated_at          timestamptz not null,            -- trigger only, read out of derived_canonical
  attested_by           uuid not null references app.memberships (id),
  attested_at           timestamptz not null default clock_timestamp(),
  submitted_at          timestamptz,
  submitted_by_membership_id uuid references app.memberships (id),
  source_platform       text check (source_platform is null or length(source_platform) between 1 and 80),
  confidence            text check (confidence is null or confidence in ('high', 'medium', 'low')),
  permitted_data        text check (permitted_data is null or length(permitted_data) between 1 and 2000),
  dependencies          text[] check (dependencies is null or (array_ndims(dependencies) = 1 and cardinality(dependencies) <= 40)),
  foreign key (agent_id, company_id) references app.agents (id, company_id),
  unique (agent_id, sequence),
  constraint candidate_submitted_pair check ((submitted_at is null) = (submitted_by_membership_id is null)),
  constraint candidate_submitted_state check ((state = 'draft') = (submitted_at is null))
);
-- The sketch's class was [\x00-...]: PostgreSQL text cannot hold U+0000, so \x01 is the same set.
create index candidate_versions_author_drafts on app.candidate_versions (author_membership_id) where state = 'draft';
create index candidate_versions_company_state on app.candidate_versions (company_id, state, sequence desc);
-- One successor per parent (design 1.4). The routine refuses E_SUCCESSOR_EXISTS under the
-- parent's lock first, so this index is the last resort rather than what a member sees.
create unique index candidate_versions_one_successor on app.candidate_versions (supersedes_candidate_id)
  where supersedes_candidate_id is not null;

-- ---------------------------------------------------------------------------
-- 5. Contributors
-- ---------------------------------------------------------------------------
create table app.candidate_contributors (
  id            uuid primary key default gen_random_uuid(),
  candidate_id  uuid not null references app.candidate_versions (id),
  membership_id uuid references app.memberships (id),
  kind          text not null check (kind = any (app.contributor_kinds())),
  display_name  text check (length(display_name) between 1 and 120),
  inherited_from_candidate_id uuid references app.candidate_versions (id),
  observed      boolean not null,
  created_at    timestamptz not null default now(),
  constraint contributor_identity check (
    (kind = 'declared_offline' and membership_id is null and display_name is not null)
    or (kind <> 'declared_offline' and membership_id is not null and display_name is null)),
  constraint contributor_observed check ((kind in ('author', 'editor', 'submitter')) = observed),
  unique (candidate_id, kind, membership_id)
);

-- ---------------------------------------------------------------------------
-- 6. The bound principal (contract 5.3, design 2.3). app.app_server_subject() and the fn refusal
--    in app.server_actor() belong to 002; this file calls the former and edits neither. One body,
--    two doors: server_actor is the subject rule plus the refusal of fn, bound_actor is the
--    subject rule plus the three binding checks.
-- ---------------------------------------------------------------------------
create or replace function app.bound_actor(p_fn text, p_args_sha256 bytea) returns uuid
language plpgsql stable set search_path = '' as $$
declare
  c jsonb := app.jwt_claims();
  actor uuid := app.app_server_subject();
begin
  -- Compared as strings, never parsed for meaning.
  if c->>'fn' is distinct from p_fn
     or c->>'args_sha256' is distinct from encode(p_args_sha256, 'hex')
     or c->>'jti' is null
     or c->>'jti' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'E_NOT_BOUND' using errcode = '42501';
  end if;
  return actor;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Idempotency claims (C2, corrected under H1 and M3). operation_sha256 is the caller's
--    operation, identical on an honest retry; the bearer's args_sha256 is never stored.
--    No policy and no grant for any PostgREST role, ever.
-- ---------------------------------------------------------------------------
create table app.idempotency_keys (
  membership_id     uuid not null references app.memberships (id),
  key               uuid not null,
  fn                text not null check (fn in ('create_draft', 'save_draft', 'submit_candidate', 'create_successor')),
  operation_sha256  bytea not null check (octet_length(operation_sha256) = 32),
  response          jsonb not null,
  created_at        timestamptz not null default clock_timestamp(),
  primary key (membership_id, key)
);
-- Serves the window test on one row by primary key, the ceiling count and the sweep's ordered,
-- bounded read past retention.
create index idempotency_keys_expiry on app.idempotency_keys (membership_id, created_at);

-- ---------------------------------------------------------------------------
-- 8. Triggers. Each exists where a CHECK cannot do the job, and says why.
-- ---------------------------------------------------------------------------
-- app.candidate_identity, BEFORE INSERT OR UPDATE: the row computes its own identity (C3). A
-- generated column cannot, because convert_to is STABLE and a generation expression must be
-- IMMUTABLE. Supplied hashes and a supplied validated_at are overwritten, never trusted.
create or replace function app.candidate_identity() returns trigger
language plpgsql set search_path = '' as $$
declare
  claimed text;
  parsed jsonb;
begin
  -- The refusals the CHECK constraints repeat, first, so no row is echoed into a log.
  if position(chr(13) in new.content) > 0 then
    raise exception 'E_CANONICAL' using errcode = '22023';
  end if;
  if octet_length(new.content) not between 512 and 262144
     or position('<!-- installer core and branches inserted on upload -->' in new.content) = 0
     or new.content ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  new.content_sha256 := sha256(convert_to(new.content, 'UTF8'));
  new.derived_sha256 := sha256(convert_to(new.derived_canonical, 'UTF8'));
  -- validated_at is read out of the derived record and nowhere else. The shape is the one
  -- derive() stamps, milliseconds and Z, so a word PostgreSQL would also parse ('now',
  -- 'epoch') is refused rather than trusted.
  begin
    parsed := new.derived_canonical::jsonb;
  exception when others then
    raise exception 'E_DERIVED_INVALID' using errcode = '22023';
  end;
  if jsonb_typeof(parsed) is distinct from 'object' then
    raise exception 'E_DERIVED_INVALID' using errcode = '22023';
  end if;
  claimed := parsed->>'validated_at';
  if claimed is null or jsonb_typeof(parsed->'validated_at') <> 'string'
     or claimed !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then
    raise exception 'E_DERIVED_INVALID' using errcode = '22023';
  end if;
  begin
    new.validated_at := claimed::timestamptz;
  exception when others then
    raise exception 'E_DERIVED_INVALID' using errcode = '22023';
  end;
  -- FRESHNESS IS EVALUATED ONLY WHEN A NEW ATTESTATION IS ACCEPTED (H4): an insert, or a changed
  -- derived_canonical. A state-only update of a frozen row never meets the clock.
  if tg_op = 'INSERT' or new.derived_canonical is distinct from old.derived_canonical then
    if new.validated_at < clock_timestamp() - interval '5 minutes'
       or new.validated_at > clock_timestamp() + interval '1 minute' then
      raise exception 'E_CLOCK' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;

-- app.candidate_immutable, BEFORE UPDATE: identity never moves; the evidence envelope freezes at
-- submission; state moves only along design 4.2.
create or replace function app.candidate_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.id <> old.id or new.company_id <> old.company_id or new.agent_id <> old.agent_id
     or new.sequence <> old.sequence or new.author_membership_id <> old.author_membership_id
     or new.supersedes_candidate_id is distinct from old.supersedes_candidate_id then
    raise exception 'E_IMMUTABLE' using errcode = 'P0001';
  end if;
  if old.state <> 'draft' and (
       new.content is distinct from old.content
       or new.content_sha256 is distinct from old.content_sha256
       or new.derived_canonical is distinct from old.derived_canonical
       or new.derived_sha256 is distinct from old.derived_sha256
       or new.gate_id is distinct from old.gate_id
       or new.validated_at is distinct from old.validated_at
       or new.attested_by is distinct from old.attested_by
       or new.attested_at is distinct from old.attested_at
       or new.submitted_at is distinct from old.submitted_at
       or new.submitted_by_membership_id is distinct from old.submitted_by_membership_id
       or new.source_platform is distinct from old.source_platform
       or new.confidence is distinct from old.confidence
       or new.permitted_data is distinct from old.permitted_data
       or new.dependencies is distinct from old.dependencies) then
    raise exception 'E_IMMUTABLE' using errcode = 'P0001';
  end if;
  if new.state is distinct from old.state then
    if new.state = 'draft' then
      raise exception 'E_STATE_RESET' using errcode = 'P0001';
    end if;
    if not ((old.state = 'draft' and new.state = 'submitted')
            or (old.state = 'submitted' and new.state in ('changes_requested', 'approved'))
            or (old.state = 'approved' and new.state = 'superseded')) then
      raise exception 'E_STATE_TRANSITION' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

-- app.candidate_no_delete: a candidate row is history; nobody deletes it, the owner included.
create or replace function app.candidate_no_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'E_CANDIDATE_DELETE' using errcode = '42501';
end $$;

-- Firing order is part of the contract. PostgreSQL fires BEFORE ROW triggers of one event in name
-- order, so the names are numbered: immutability first, so an owner-side write of a stale
-- attestation onto a frozen row answers E_IMMUTABLE and never E_CLOCK (design 2.3, H4 note).
create trigger candidate_1_immutable before update on app.candidate_versions
  for each row execute function app.candidate_immutable();
create trigger candidate_2_identity before insert or update on app.candidate_versions
  for each row execute function app.candidate_identity();
create trigger candidate_no_delete before delete on app.candidate_versions
  for each row execute function app.candidate_no_delete();
create trigger candidate_no_truncate before truncate on app.candidate_versions
  for each statement execute function app.candidate_no_delete();

-- app.contributors_frozen: a contributor row changes only while its candidate is a draft. The
-- parent is read FOR SHARE so a concurrent submission cannot commit between this check and the
-- write. Both parents are checked when an update moves a row.
create or replace function app.contributors_frozen() returns trigger
language plpgsql set search_path = '' as $$
declare
  st text;
begin
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
create trigger contributors_frozen before insert or update or delete on app.candidate_contributors
  for each row execute function app.contributors_frozen();
-- Row triggers do not fire on TRUNCATE, which erased every contributor of every frozen candidate in one owner
-- command (E3a critique F1). Refused by the same function, as a TRUNCATE of the candidate rows is.
create trigger contributors_no_truncate before truncate on app.candidate_contributors
  for each statement execute function app.candidate_no_delete();

-- ---------------------------------------------------------------------------
-- 9. The audit allowlist grows by id, hash, integer and enumerated keys only (design 2.4). The
--    body is 001's, every rule kept; the new branches are marked.
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
           'candidate_id', 'agent_id', 'contributor_membership_id', 'supersedes_candidate_id' then
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
      -- E3
      when 'content_sha256', 'derived_sha256', 'gate_identity_sha256' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^[0-9a-f]{64}$';
      when 'sequence', 'version' then
        ok := jsonb_typeof(v) = 'number' and (v #>> '{}') ~ '^-?[0-9]+$';
      when 'candidate_state_after' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') = any (app.candidate_states());
      when 'agent_status_after' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') = any (app.agent_statuses());
      when 'contributor_kind' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') = any (app.contributor_kinds());
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
-- 10. The two RLS helpers and their explicit-user bodies (M1). Both doors SECURITY DEFINER with a
--     fixed empty search_path and the whole tenant and standing decision in the body. One body,
--     two doors: the routines ask the explicit form with the bearer's subject, the policies ask the
--     auth.uid() form, and neither can drift from the other.
-- ---------------------------------------------------------------------------
create or replace function app.membership_of(p_company uuid, p_user uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select m.id from app.memberships m
    join app.companies c on c.id = m.company_id and c.status = 'active'
   where m.company_id = p_company and m.user_id = p_user and m.status = 'active'
$$;
-- The role test reads m.roles from the membership membership_of resolved rather than calling E2's
-- app.has_role, which takes its user from auth.uid() and cannot answer for an explicit one. The
-- duplication is deliberate and contained: tests/db/12-content-grants.sh (case 37 b) compares the
-- role component with OR(app.has_role) reader by reader.
create or replace function app.candidate_visible_to(p_candidate uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.candidate_versions v
     where v.id = p_candidate
       and (v.author_membership_id = app.membership_of(v.company_id, p_user)
            or (v.state <> 'draft'
                and app.membership_of(v.company_id, p_user) is not null
                and exists (select 1 from app.memberships m
                             where m.id = app.membership_of(v.company_id, p_user)
                               and m.roles && array['it_reviewer', 'business_reviewer', 'company_admin']::text[]))))
$$;
create or replace function app.my_membership(p_company uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select app.membership_of(p_company, (select auth.uid()))
$$;
create or replace function app.candidate_visible(p_candidate uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.candidate_visible_to(p_candidate, (select auth.uid()))
$$;
-- The gate registry's door (design 4.1, E3a critique F3). The registry belongs to no company, so the rule is
-- E2's own app.is_active_member asked of each of the reader's memberships: at least one active membership in an
-- active company. "Active member of an active company" stays written once, in 001; this adds only "of any".
create or replace function app.is_active_member_anywhere() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.memberships m
                  where m.user_id = (select auth.uid()) and app.is_active_member(m.company_id))
$$;

-- ---------------------------------------------------------------------------
-- 11. Row level security, grants and views
-- ---------------------------------------------------------------------------
alter table app.agents enable row level security;
alter table app.candidate_versions enable row level security;
alter table app.candidate_contributors enable row level security;
alter table app.gate_identities enable row level security;
alter table app.gate_identity_files enable row level security;
alter table app.idempotency_keys enable row level security;   -- no policy, no grant, ever

create policy agents_member_read on app.agents for select to authenticated
  using (app.is_active_member(company_id));
-- One predicate for "may I see this candidate", used by both content policies and by the successor
-- precondition. app.candidate_visible_to reads app.candidate_versions, which carries this policy;
-- that is not recursion, because the function is SECURITY DEFINER and its definer owns the table.
-- DO NOT put `force row level security` on app.candidate_versions: it would make it recursion.
create policy candidates_read on app.candidate_versions for select to authenticated
  using (app.candidate_visible(id));
create policy contributors_read on app.candidate_contributors for select to authenticated
  using (app.candidate_visible(candidate_id));
-- Design 4.1 gives a stale reader 404 for gate identities and their file lists. The 2.3 sketch's using (true)
-- contradicted that row and was wrong: that the rows carry no secret says they may be shown, not to whom. The
-- lead settled it for 4.1 (E3a critique F3). app_maintenance keeps its own select policies below.
create policy gate_identities_read on app.gate_identities for select to authenticated
  using (app.is_active_member_anywhere());
create policy gate_identity_files_read on app.gate_identity_files for select to authenticated
  using (app.is_active_member_anywhere());

grant select on app.agents, app.candidate_versions, app.candidate_contributors,
                app.gate_identities, app.gate_identity_files to authenticated;

-- app_maintenance reads content for reconciliation and never writes it: SELECT grants and SELECT
-- policies only, and no UPDATE policy anywhere, deliberately narrower than the using (true)
-- policies 001 keeps for standing tables (R1). The gate registry rows are this file's addition to
-- the sketch, which listed only the content tables here while design 4.1 gives maintenance select on
-- gate identities and their file lists.
grant select on app.agents, app.candidate_versions, app.candidate_contributors,
                app.gate_identities, app.gate_identity_files to app_maintenance;
create policy maintenance_agents on app.agents for select to app_maintenance using (true);
create policy maintenance_candidates on app.candidate_versions for select to app_maintenance using (true);
create policy maintenance_contributors on app.candidate_contributors for select to app_maintenance using (true);
create policy maintenance_gate_identities on app.gate_identities for select to app_maintenance using (true);
create policy maintenance_gate_identity_files on app.gate_identity_files for select to app_maintenance using (true);

create view api.agents with (security_invoker = true) as
  select id, company_id, name, creator_membership_id, owner_membership_id, status, created_at
  from app.agents;
create view api.candidate_versions with (security_invoker = true) as
  select id, company_id, agent_id, sequence, state, version, author_membership_id, supersedes_candidate_id,
         content, content_sha256, derived_canonical, derived_sha256, derived, gate_id, validated_at,
         attested_by, attested_at, submitted_at, submitted_by_membership_id, source_platform, confidence,
         permitted_data, dependencies
  from app.candidate_versions;
create view api.candidate_contributors with (security_invoker = true) as
  select id, candidate_id, membership_id, kind, display_name, inherited_from_candidate_id, observed, created_at
  from app.candidate_contributors;
create view api.gate_identities with (security_invoker = true) as
  select id, identity_sha256, adapter_lock_sha256, validator_version, manifest_sha256, upstream_commit,
         registered_at, active
  from app.gate_identities;
-- Not in the sketch's view list, which grants the table and its policy but gives GET /api/gate's
-- file list (design 4.4) no exposed view to read.
create view api.gate_identity_files with (security_invoker = true) as
  select gate_id, path, sha256 from app.gate_identity_files;
grant select on api.agents, api.candidate_versions, api.candidate_contributors, api.gate_identities,
                api.gate_identity_files to authenticated;

-- ---------------------------------------------------------------------------
-- 12. Shared routine steps. Each is one decision written once, called by the four routines in the
--     order design 4.3 fixes; the order itself stays visible in each routine.
-- ---------------------------------------------------------------------------
-- 4.3 step 5, the found-claim branch, in its order: expiry, then conflict, then the stored answer.
-- Returns null when there is no claim. Reads no lock and writes nothing.
create or replace function app.idempotency_lookup(p_membership uuid, p_key uuid, p_fn text, p_operation bytea)
returns jsonb
language plpgsql set search_path = '' as $$
declare
  prior app.idempotency_keys;
begin
  select * into prior from app.idempotency_keys k where k.membership_id = p_membership and k.key = p_key;
  if not found then
    return null;
  end if;
  if prior.created_at < clock_timestamp() - app.idempotency_window() then
    raise exception 'E_IDEMPOTENCY_EXPIRED' using errcode = 'P0001';
  end if;
  if prior.fn <> p_fn or prior.operation_sha256 <> p_operation then
    raise exception 'E_IDEMPOTENCY_CONFLICT' using errcode = 'P0001';
  end if;
  return prior.response || jsonb_build_object('idempotent_replay', true);
end $$;

-- 4.3 step 6, the claim-row ceiling: >= over this membership's unexpired rows, before the insert.
create or replace function app.idempotency_ceiling(p_membership uuid) returns void
language plpgsql set search_path = '' as $$
begin
  if (select count(*) from app.idempotency_keys k
       where k.membership_id = p_membership
         and k.created_at >= clock_timestamp() - app.idempotency_window()) >= app.limit_idempotency_rows() then
    raise exception 'E_IDEMPOTENCY_LIMIT' using errcode = 'P0001';
  end if;
end $$;

-- 4.3 step 8, the bounded sweep past RETENTION, not past the window. skip locked skips rows another
-- session has row-locked; it waives no table lock the DELETE takes. Returns the rows deleted.
create or replace function app.idempotency_sweep(p_membership uuid) returns integer
language plpgsql set search_path = '' as $$
declare
  deleted integer;
begin
  with past_retention as (
    select k.membership_id, k.key from app.idempotency_keys k
     where k.membership_id = p_membership
       and k.created_at < clock_timestamp() - app.idempotency_retention()
     order by k.created_at
     limit app.idempotency_sweep_batch()
     for update skip locked)
  delete from app.idempotency_keys d using past_retention e
   where d.membership_id = e.membership_id and d.key = e.key;
  get diagnostics deleted = row_count;
  return deleted;
end $$;

-- 4.3 steps 7 and 8: the claim with its response in one insert, then the sweep. A conflict here
-- means a duplicate committed between the lookup and this insert, which the company lock should
-- make unreachable and which nothing here assumes: raising rolls back this transaction's work
-- rather than committing it beside someone else's answer.
create or replace function app.idempotency_claim(p_membership uuid, p_key uuid, p_fn text, p_operation bytea,
  p_response jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  claimed integer;
begin
  insert into app.idempotency_keys (membership_id, key, fn, operation_sha256, response)
  values (p_membership, p_key, p_fn, p_operation, p_response)
  on conflict (membership_id, key) do nothing
  returning 1 into claimed;
  if claimed is null then
    raise exception 'E_BUSY' using errcode = 'P0001';
  end if;
  perform app.idempotency_sweep(p_membership);
end $$;

-- 4.5 row 31: the server's gate identity must be the active registered one. The only raise of
-- SQLSTATE P0003 in any migration, so lib/errors.mjs can answer 503 (2.6 item 5, M2).
create or replace function app.active_gate(p_identity bytea) returns uuid
language plpgsql stable set search_path = '' as $$
declare
  gate uuid;
begin
  select g.id into gate from app.gate_identities g where g.identity_sha256 = p_identity and g.active;
  if gate is null then
    raise exception 'E_GATE_UNREGISTERED' using errcode = 'P0003';
  end if;
  return gate;
end $$;

-- The audit details of a candidate write: ids, hashes, integers and the state, nothing else.
create or replace function app.candidate_audit_details(c app.candidate_versions) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
           'candidate_id', c.id, 'agent_id', c.agent_id,
           'content_sha256', encode(c.content_sha256, 'hex'), 'derived_sha256', encode(c.derived_sha256, 'hex'),
           'gate_identity_sha256', (select encode(g.identity_sha256, 'hex') from app.gate_identities g where g.id = c.gate_id),
           'sequence', c.sequence, 'version', c.version, 'candidate_state_after', c.state)
         || case when c.supersedes_candidate_id is null then '{}'::jsonb
                 else jsonb_build_object('supersedes_candidate_id', c.supersedes_candidate_id) end
$$;

-- The response a routine returns and a claim stores. The service maps it to the API's names.
create or replace function app.candidate_response(c app.candidate_versions) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'candidate_id', c.id, 'agent_id', c.agent_id, 'company_id', c.company_id,
    'sequence', c.sequence, 'version', c.version, 'state', c.state,
    'content_sha256', encode(c.content_sha256, 'hex'), 'derived_sha256', encode(c.derived_sha256, 'hex'),
    'gate_identity_sha256', (select encode(g.identity_sha256, 'hex') from app.gate_identities g where g.id = c.gate_id),
    'validated_at', to_char(c.validated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'supersedes_candidate_id', c.supersedes_candidate_id,
    'submitted_at', c.submitted_at,
    'idempotent_replay', false)
$$;

-- The submission metadata, parsed and shape-checked, or E_BODY_INVALID. The design names the fields
-- (4.4) and the column checks; the closed key set, the required three and the per-item bounds are this
-- file's reading of them. declared_contributors items are {membership_id} or {display_name}, never both.
create or replace function app.submission_fields(p_submission text) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  s jsonb;
begin
  begin
    s := p_submission::jsonb;
  exception when others then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end;
  if jsonb_typeof(s) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(s) k
                 where k not in ('source_platform', 'confidence', 'permitted_data', 'dependencies', 'declared_contributors'))
     or jsonb_typeof(s->'source_platform') is distinct from 'string'
     or length(s->>'source_platform') not between 1 and 80
     or (s->>'confidence') is distinct from 'high' and (s->>'confidence') is distinct from 'medium'
        and (s->>'confidence') is distinct from 'low'
     or jsonb_typeof(s->'confidence') is distinct from 'string'
     or jsonb_typeof(s->'permitted_data') is distinct from 'string'
     or length(s->>'permitted_data') not between 1 and 2000
     or (s ? 'dependencies' and (jsonb_typeof(s->'dependencies') <> 'array'
                                 or jsonb_array_length(s->'dependencies') > 40
                                 or exists (select 1 from jsonb_array_elements(s->'dependencies') d
                                             where jsonb_typeof(d) <> 'string' or length(d #>> '{}') not between 1 and 200)))
     or (s ? 'declared_contributors' and (jsonb_typeof(s->'declared_contributors') <> 'array'
                                          or jsonb_array_length(s->'declared_contributors') > 50
                                          or exists (
      select 1 from jsonb_array_elements(s->'declared_contributors') e
       where jsonb_typeof(e) <> 'object'
          or (select count(*) from jsonb_object_keys(e)) <> 1
          -- IS NOT TRUE, because SQL booleans are three-valued (E3a critique F2). With one alternative's key absent
          -- its test is NULL, not (NULL or false) is NULL, and this WHERE drops a NULL row, so {display_name: 123}
          -- and {typo: ...} used to pass. Only an entry known to be one valid shape is kept out of the refusal.
          or ((jsonb_typeof(e->'membership_id') = 'string'
               and (e->>'membership_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
              or (jsonb_typeof(e->'display_name') = 'string' and length(e->>'display_name') between 1 and 120)) is not true))) then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  return s;
end $$;

-- ---------------------------------------------------------------------------
-- 13. The four content routines. SECURITY DEFINER, search_path = '', EXECUTE to app_server alone.
--     Every one follows design 4.3 in this order: 1 app.bound_actor; 2 standing; 3 the company lock,
--     standing again, then the agent row and the candidate row FOR UPDATE; 4 ownership; 5 the claim
--     lookup; 6 the fresh-only preconditions in the order of 4.5 rows 26 to 33; 7 the change, the
--     audit rows and the claim with its response; 8 the sweep. Malformed input is refused before
--     step 2, because a call that cannot be a real operation has nothing to look up.
--
--     The first argument of app.bound_actor, and the operation digest, are bindingSql(fn) and
--     operationSql(fn) of lib/db/server.mjs pasted verbatim; tests/e3/unit/migration-text.test.mjs
--     requires this file to contain that exact text (case 14), which is the only check that
--     catches the Node and SQL projections drifting apart.
-- ---------------------------------------------------------------------------
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
    if (select count(*) from app.agents g where g.company_id = p_company) >= app.limit_agents_per_company() then
      raise exception 'E_AGENT_LIMIT' using errcode = 'P0001';
    end if;
  else
    if ag.status = 'archived' then
      raise exception 'E_AGENT_ARCHIVED' using errcode = 'P0001';
    end if;
    if (select count(*) from app.candidate_versions v where v.agent_id = ag.id) >= app.limit_versions_per_agent() then
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

create or replace function api.save_draft(p_candidate uuid, p_expected_version integer, p_content text,
  p_derived_canonical text, p_gate_identity bytea, p_idempotency_key uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.bound_actor('save_draft', sha256(convert_to(concat_ws(E'\n', 'save_draft', coalesce(p_candidate::text, '-'), coalesce(p_expected_version::text, '-'), coalesce(encode(sha256(convert_to(p_content, 'UTF8')), 'hex'), '-'), coalesce(encode(sha256(convert_to(p_derived_canonical, 'UTF8')), 'hex'), '-'), coalesce(encode(p_gate_identity, 'hex'), '-'), coalesce(p_idempotency_key::text, '-')), 'UTF8')));
  operation bytea := sha256(convert_to(concat_ws(E'\n', 'save_draft', coalesce(p_candidate::text, '-'), coalesce(p_expected_version::text, '-'), coalesce(encode(sha256(convert_to(p_content, 'UTF8')), 'hex'), '-')), 'UTF8'));
  company uuid;
  member_id uuid;
  cand app.candidate_versions;
  gate uuid;
  replay jsonb;
  result jsonb;
begin
  if p_candidate is null or p_expected_version is null or p_content is null or p_derived_canonical is null
     or p_gate_identity is null or p_idempotency_key is null then
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
  perform 1 from app.agents g
   where g.id = (select v.agent_id from app.candidate_versions v where v.id = p_candidate) for update;
  select * into cand from app.candidate_versions v where v.id = p_candidate for update;
  if cand.author_membership_id is distinct from member_id then
    raise exception 'E_NOT_AUTHOR' using errcode = '42501';
  end if;
  replay := app.idempotency_lookup(member_id, p_idempotency_key, 'save_draft', operation);
  if replay is not null then
    return replay;
  end if;
  perform app.idempotency_ceiling(member_id);
  if cand.state <> 'draft' then
    raise exception 'E_NOT_DRAFT' using errcode = 'P0001';
  end if;
  if cand.version <> p_expected_version then
    raise exception 'E_VERSION_CONFLICT' using errcode = 'P0001';
  end if;
  gate := app.active_gate(p_gate_identity);
  -- Content, derived bytes and attestation in one statement; the trigger recomputes both hashes and
  -- validated_at in the same statement, so a draft never holds an attestation for other bytes.
  update app.candidate_versions v
     set content = p_content, derived_canonical = p_derived_canonical, gate_id = gate,
         attested_by = member_id, attested_at = clock_timestamp(), version = cand.version + 1
   where v.id = cand.id
  returning * into cand;
  perform app.audit(company, actor, 'member', 'candidate.save', 'candidate', cand.id,
    app.candidate_audit_details(cand));
  result := app.candidate_response(cand);
  perform app.idempotency_claim(member_id, p_idempotency_key, 'save_draft', operation, result);
  return result;
end $$;

create or replace function api.submit_candidate(p_candidate uuid, p_expected_version integer, p_content_sha256 bytea,
  p_derived_canonical text, p_submission_canonical text, p_gate_identity bytea, p_idempotency_key uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.bound_actor('submit_candidate', sha256(convert_to(concat_ws(E'\n', 'submit_candidate', coalesce(p_candidate::text, '-'), coalesce(p_expected_version::text, '-'), coalesce(encode(p_content_sha256, 'hex'), '-'), coalesce(encode(sha256(convert_to(p_derived_canonical, 'UTF8')), 'hex'), '-'), coalesce(encode(sha256(convert_to(p_submission_canonical, 'UTF8')), 'hex'), '-'), coalesce(encode(p_gate_identity, 'hex'), '-'), coalesce(p_idempotency_key::text, '-')), 'UTF8')));
  operation bytea := sha256(convert_to(concat_ws(E'\n', 'submit_candidate', coalesce(p_candidate::text, '-'), coalesce(p_expected_version::text, '-'), coalesce(encode(sha256(convert_to(p_submission_canonical, 'UTF8')), 'hex'), '-')), 'UTF8'));
  company uuid;
  member_id uuid;
  meta jsonb;
  cand app.candidate_versions;
  gate uuid;
  replay jsonb;
  result jsonb;
  contributor record;
begin
  if p_candidate is null or p_expected_version is null or p_content_sha256 is null or p_derived_canonical is null
     or p_submission_canonical is null or p_gate_identity is null or p_idempotency_key is null then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  meta := app.submission_fields(p_submission_canonical);
  select v.company_id into company from app.candidate_versions v where v.id = p_candidate;
  if company is null then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_standing(company, actor);
  -- A declared member must be a membership of this company, in any status, because a removed
  -- colleague is still a contributor (design 1.4). Another company's membership is not found, before
  -- any lock: memberships never change company, so this is a fact about the call.
  if exists (select 1 from jsonb_array_elements(coalesce(meta->'declared_contributors', '[]'::jsonb)) e
              where e ? 'membership_id'
                and not exists (select 1 from app.memberships m
                                 where m.id = (e->>'membership_id')::uuid and m.company_id = company)) then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.lock_company(company);
  perform app.require_standing(company, actor);
  member_id := app.membership_of(company, actor);
  perform 1 from app.agents g
   where g.id = (select v.agent_id from app.candidate_versions v where v.id = p_candidate) for update;
  select * into cand from app.candidate_versions v where v.id = p_candidate for update;
  if cand.author_membership_id is distinct from member_id then
    raise exception 'E_NOT_AUTHOR' using errcode = '42501';
  end if;
  replay := app.idempotency_lookup(member_id, p_idempotency_key, 'submit_candidate', operation);
  if replay is not null then
    return replay;
  end if;
  perform app.idempotency_ceiling(member_id);
  if cand.state <> 'draft' then
    raise exception 'E_NOT_DRAFT' using errcode = 'P0001';
  end if;
  if cand.version <> p_expected_version then
    raise exception 'E_VERSION_CONFLICT' using errcode = 'P0001';
  end if;
  gate := app.active_gate(p_gate_identity);
  -- The service re-gated these exact stored bytes; a save that won the race since is refused here,
  -- under the lock, and nothing is frozen (case 17).
  if cand.content_sha256 <> p_content_sha256 then
    raise exception 'E_CONTENT_CHANGED' using errcode = 'P0001';
  end if;
  -- Contributors first, while the parent is still a draft; the freeze applies to everything after.
  insert into app.candidate_contributors (candidate_id, membership_id, kind, observed)
  values (cand.id, member_id, 'submitter', true)
  on conflict do nothing;
  insert into app.candidate_contributors (candidate_id, membership_id, kind, observed)
  select distinct cand.id, (e->>'membership_id')::uuid, 'declared_member', false
    from jsonb_array_elements(coalesce(meta->'declared_contributors', '[]'::jsonb)) e
   where e ? 'membership_id'
  on conflict do nothing;
  insert into app.candidate_contributors (candidate_id, kind, display_name, observed)
  select cand.id, 'declared_offline', e->>'display_name', false
    from jsonb_array_elements(coalesce(meta->'declared_contributors', '[]'::jsonb)) e
   where e ? 'display_name';
  update app.candidate_versions v
     set state = 'submitted', submitted_at = clock_timestamp(), submitted_by_membership_id = member_id,
         source_platform = meta->>'source_platform', confidence = meta->>'confidence',
         permitted_data = meta->>'permitted_data',
         dependencies = coalesce((select array_agg(d.value order by d.ordinality)
                                    from jsonb_array_elements_text(coalesce(meta->'dependencies', '[]'::jsonb))
                                         with ordinality as d(value, ordinality)), '{}'::text[]),
         derived_canonical = p_derived_canonical, gate_id = gate,
         attested_by = member_id, attested_at = clock_timestamp(), version = cand.version + 1
   where v.id = cand.id
  returning * into cand;
  perform app.audit(company, actor, 'member', 'candidate.submit', 'candidate', cand.id,
    app.candidate_audit_details(cand));
  -- One row per contributor recorded at submission, by kind and membership id only: a declared
  -- offline name never enters an audit row (design 2.4).
  for contributor in
    select k.id, k.kind, k.membership_id from app.candidate_contributors k
     where k.candidate_id = cand.id and k.kind in ('submitter', 'declared_member', 'declared_offline')
     order by k.kind, k.id
  loop
    perform app.audit(company, actor, 'member', 'candidate.submit', 'candidate_contributor', contributor.id,
      jsonb_build_object('candidate_id', cand.id, 'contributor_kind', contributor.kind)
      || case when contributor.membership_id is null then '{}'::jsonb
              else jsonb_build_object('contributor_membership_id', contributor.membership_id) end);
  end loop;
  result := app.candidate_response(cand);
  perform app.idempotency_claim(member_id, p_idempotency_key, 'submit_candidate', operation, result);
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
  if (select count(*) from app.candidate_versions v where v.agent_id = ag.id) >= app.limit_versions_per_agent() then
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

-- ---------------------------------------------------------------------------
-- 14. api.remove_member with agent orphaning (design 2.6 item 4, the lead's Q1). 001's body, every
--     step in its order; the added block is marked. The E2 last-admin probes are re-run by reseeding
--     and running tests/db/01 to 06 in order (case 40).
-- ---------------------------------------------------------------------------
create or replace function api.remove_member(p_membership uuid)
returns table (membership_id uuid, status text, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  target app.memberships;
  admin app.memberships;
  orphans uuid[];
  ag uuid;
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
  -- E3: every active agent this membership owns becomes orphaned in the same transaction, under the
  -- company lock held above. Agent rows are locked by id ascending after the membership row, which
  -- is design 2.5's order; one UPDATE changes them, and each gets one agent.orphan audit row. An
  -- archived agent stays archived. Reactivating the membership later restores nothing.
  perform 1 from app.agents g
   where g.company_id = target.company_id and g.owner_membership_id = target.id and g.status = 'active'
   order by g.id
   for update;
  with orphaned as (
    update app.agents g set status = 'orphaned'
     where g.company_id = target.company_id and g.owner_membership_id = target.id and g.status = 'active'
    returning g.id)
  select coalesce(array_agg(o.id order by o.id), '{}'::uuid[]) into orphans from orphaned o;
  foreach ag in array orphans loop
    perform app.audit(target.company_id, actor, 'member', 'agent.orphan', 'agent', ag,
      jsonb_build_object('agent_id', ag, 'membership_id', target.id, 'agent_status_after', 'orphaned'));
  end loop;
  return query select target.id, 'removed'::text, true;
end $$;

-- ---------------------------------------------------------------------------
-- 15. Grants. EXECUTE on the four routines to app_server alone, by full signature, as 001 grants.
--     The helpers keep the default revoke 001 set for schema app, and the two RLS doors are granted
--     to authenticated explicitly (M1), as is the registry's door; membership_of and candidate_visible_to are
--     granted to nobody.
-- ---------------------------------------------------------------------------
revoke execute on function app.candidate_states(), app.agent_statuses(), app.contributor_kinds(),
  app.limit_agents_per_company(), app.limit_versions_per_agent(), app.idempotency_window(),
  app.idempotency_retention(), app.idempotency_sweep_batch(), app.limit_idempotency_rows(),
  app.bound_actor(text, bytea), app.candidate_identity(), app.candidate_immutable(), app.candidate_no_delete(),
  app.contributors_frozen(), app.membership_of(uuid, uuid), app.candidate_visible_to(uuid, uuid),
  app.my_membership(uuid), app.candidate_visible(uuid), app.is_active_member_anywhere(),
  app.idempotency_lookup(uuid, uuid, text, bytea),
  app.idempotency_ceiling(uuid), app.idempotency_sweep(uuid), app.idempotency_claim(uuid, uuid, text, bytea, jsonb),
  app.active_gate(bytea), app.candidate_audit_details(app.candidate_versions),
  app.candidate_response(app.candidate_versions), app.submission_fields(text) from public;
grant execute on function app.my_membership(uuid), app.candidate_visible(uuid), app.is_active_member_anywhere()
  to authenticated;

revoke execute on all functions in schema api from public, anon, authenticated;
grant execute on function
  api.create_draft(uuid, uuid, text, text, text, bytea, uuid),
  api.save_draft(uuid, integer, text, text, bytea, uuid),
  api.submit_candidate(uuid, integer, bytea, text, text, bytea, uuid),
  api.create_successor(uuid, bytea, text, bytea, uuid)
to app_server;

-- ---------------------------------------------------------------------------
-- 16. The first gate identity (design 2.7): the output of `node scripts/gate-manifest.mjs --sql` for
--     lib/passport/gate-manifest.mjs at this migration's revision, pasted. No hash is typed by hand;
--     tests/e3/unit/migration-text.test.mjs requires this block to equal the generator's output for
--     the committed manifest, and a later pin is a later numbered migration.
-- ---------------------------------------------------------------------------
update app.gate_identities set active = false where active;
with g as (
  insert into app.gate_identities
    (identity_sha256, adapter_lock_sha256, validator_version, manifest_sha256, upstream_commit, active)
  values (decode('40d71509c4df39afe89b74ede70fcad348cf91ced0381ab23d164f31e250b1b3', 'hex'), decode('e857a46505a7b5cbbd17028d88448f82d12f222be1f3119770d9dabb5b7ab7f7', 'hex'), '0.1.0',
          decode('72fa28214ba8e5792c94e42f6b9267d4e871604b14e664e643632a26efe3ab55', 'hex'), 'd42a1722c7d0d458b2693879f6a50e582786a1ae', true)
  returning id, identity_sha256
), f as (
  insert into app.gate_identity_files (gate_id, path, sha256)
  select g.id, v.path, decode(v.sha256, 'hex')
    from g, (values
    ('lib/passport/assemble.mjs', '41fa96d5cfc7dc12e5c9658e2f1afe342f6dd3c10350a826009e62f8cfa55490'),
    ('lib/passport/canonical.mjs', '6660bf26ad86db1bc0278b2a5bc06b782a89b2a9a20ff3d62dd7c639e05ab538'),
    ('lib/passport/gate.mjs', '5e4abfda43d483737490458ec2d30f8a618bcd5f7ddbf1e8c334d7fb8f08c57e'),
    ('lib/passport/rules.mjs', '60b73bd1b4102400582d052b36625963bc772654b4969306cf53d7ac7fb14f30')
    ) as v (path, sha256)
  returning gate_id
)
select app.audit(null, null, 'system', 'gate.register', 'gate_identity', g.id,
                 jsonb_build_object('gate_identity_sha256', encode(g.identity_sha256, 'hex')))
  from g;
