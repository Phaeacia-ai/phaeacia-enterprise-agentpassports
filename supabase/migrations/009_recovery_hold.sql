-- 009_recovery_hold.sql. E7 design 2.1, correction E7D-C-F1.
--
-- THE ONE MIGRATION E7 ADDS, and the design said in its first version that it would need none. That promise did
-- not survive its critique and does not protect this file: the first version put a company whose correction the
-- reconciler could not apply into SUSPENSION and trusted suspension to hide it. Suspension does not hide it.
-- app.export_admin (008) admits an administrator of a suspended company at aal2 before export_by ON PURPOSE,
-- because the fourteen-day window of E6 1.5 exists to serve exactly that person, so a restored tenant that was
-- only suspended is exportable, every one of its twenty-one sections, the moment the Data API reopens. The
-- critique observed it (evidence/e7-design-critique-repro/quarantine.log:
-- suspended_export_succeeded=t; section_count=21) and it was re-observed at 008 before this file was written
-- (evidence/e7-scripts-repro/e7-29-fail-before-at-008.log.txt, which also shows the status check refusing 'held').
--
-- A QUARANTINE NEEDS A STATE NO CUSTOMER PATH ADMITS. This file adds one: a fourth company status, 'held'.
--
-- WHY A STATUS VALUE AND NOT A COLUMN OR A ROW. Every member-facing path in five slices already tests
-- status = 'active': app.is_active_member, app.has_role, app.membership_of, the profiles policy, app.lock_company,
-- app.download_refusal_for, 007's installation routines and api.authorize_download. A status value is therefore
-- FAIL-CLOSED at every one of them WITHOUT AN EDIT TO ANY OF THEM, and loadPrincipal's existing branch answers a
-- held company 409 E_COMPANY_INACTIVE. A separate flag would be fail-open: every predicate that forgot it would
-- admit a held company, and there are more than a dozen across 001 to 008, several of them (app.membership_of,
-- app.download_refusal_for) outside the one read chokepoint app.read_window_open. E6 1.5 rejected a fourth status,
-- 'read_only', because a read-only company needed its own DECISION at every predicate; a held company needs the
-- same answer at every one, refusal, which is the answer each already gives.
--
-- THE COST, written down rather than discovered later: a held company's pre-hold status is no longer in its row.
-- It is in the reconciler's C0 audit row (status_before), and the lift restores the narrower of that and the
-- status the register's fold expects; a wider one only on the operator's explicit --status, given on the
-- customer's confirmation.
--
-- WHAT THIS FILE CONTAINS: exactly six replaced functions and one re-validated check constraint, and NOTHING
-- ELSE. The sixth (app.departure_subject) was added by the lead on 2026-09-20 after the builder's probe found the
-- one member-facing routine that takes neither the company lock nor a status test (E7S-F1, evidence/e7-scripts.md). Every predicate that tests status = 'active', both lock helpers, api.transfer_first_admin,
-- api.set_access_period, api.operator_invite_admin, api.close_company, api.delete_company and every grant stay
-- as 008 left them, which is the point of choosing a status value. Each replacement below is its accepted body
-- with the named change and nothing else; CREATE OR REPLACE keeps each function's privileges, its owner, its
-- settings and its triggers, and every signature here is identical to 008's, so no grant and no trigger is lost.
--
-- THREE PATHS ADMIT A HELD COMPANY ON PURPOSE and are not touched: api.transfer_first_admin,
-- api.set_access_period and api.operator_invite_admin. They are the operator's tools for resolving what holds a
-- company, they return no content, and an invitation issued into a held company cannot be accepted, because
-- acceptance passes app.lock_company. api.close_company requires 'suspended' and so refuses a held company
-- already.
--
-- After this file is applied, PostgREST's schema cache is reloaded (notify pgrst, 'reload schema'), locally and
-- hosted (the hosted checklist's H-P5). The probe is tests/db/32-recovery-hold.sh, case E7-29.

-- ---------------------------------------------------------------------------
-- 1. The fourth status, and the check constraint re-validated against it.
--    A replaced function is NOT re-checked against existing rows on its own, and the constraint's expression is
--    inlined at creation, so the constraint is dropped and re-added. `not valid` then `validate` takes the weaker
--    lock for the scan rather than holding ACCESS EXCLUSIVE over it; there is nothing to find, because widening a
--    value set cannot invalidate a row, and the validate is here so that the constraint is not left NOT VALID.
-- ---------------------------------------------------------------------------
create or replace function app.company_statuses() returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select array['active', 'suspended', 'closed', 'held']::text[]
$$;

alter table app.companies drop constraint companies_status_check;
alter table app.companies add constraint companies_status_check
  check (status = any (app.company_statuses())) not valid;
alter table app.companies validate constraint companies_status_check;

-- ---------------------------------------------------------------------------
-- 2. app.company_status_guard(): 008's body with one rule added below the closed-terminal rule.
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
  -- E7 design 2.1 item 2, correction E7D-C-F1, AND THE ONLY LINE ADDED TO THIS BODY. A move INTO or OUT OF
  -- 'held' is the reconciler's alone: no routine sets app.recovery_reconcile and PostgREST cannot, so only an
  -- owner session reaches past it. It is the tripwire shape of app.tenant_deletion with the same honest bound,
  -- that an owner who sets the setting on purpose is past it. It sits BELOW the closed-terminal rule, so every
  -- refusal 008 already gave is the refusal a caller still meets and nothing accepted moves.
  if (new.status = 'held') is distinct from (old.status = 'held')
     and current_setting('app.recovery_reconcile', true) is distinct from 'on' then
    raise exception 'E_RECOVERY_HOLD' using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 3. app.export_admin(): 008's body with 'held' beside 'closed', in the same place.
-- ---------------------------------------------------------------------------
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
  -- E7 design 2.1 item 3, correction E7D-C-F1, AND THE ONLY CHANGE TO THIS BODY: 'held' joins 'closed' here.
  -- Suspension is NOT a quarantine and was never meant to be: this predicate admits an administrator of a
  -- SUSPENDED company at aal2 before export_by on purpose, because the fourteen-day window exists to serve
  -- exactly that person. A restored tenant that was only suspended is therefore exportable, every section of it,
  -- the moment the Data API reopens (evidence/e7-design-critique-repro/quarantine.log:
  -- suspended_export_succeeded=t; section_count=21, re-observed at 008 in
  -- evidence/e7-scripts-repro/e7-29-fail-before-at-008.log.txt). A recovery hold is the state no customer path
  -- admits, and this is the one member-facing predicate that does not test status = 'active' and so had to be
  -- told about it.
  if c.status in ('closed', 'held') then
    raise exception 'E_FORBIDDEN' using errcode = '42501';
  end if;
  return m;
end $$;

-- ---------------------------------------------------------------------------
-- 4. api.set_company_status(): 008's body with one test after the lock and above the closed test.
-- ---------------------------------------------------------------------------
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
  -- E7 design 2.1 item 4, correction E7D-C-F1, AND THE ONLY LINES ADDED TO THIS BODY. NO OPERATOR ROUTE AND NO
  -- RESUME LIFTS A HOLD. A held company is one the reconciler has not finished with, and the only way out is
  -- reconcile.mjs lift, after that company's customer has confirmed its current members and roles. It is above
  -- the closed test because a held company is not closed and would otherwise fall through to the status compare.
  if c.status = 'held' then
    raise exception 'E_RECOVERY_HOLD' using errcode = 'P0001';
  end if;
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

-- ---------------------------------------------------------------------------
-- 5. app.audit_details_guard(): 008's body with 'held' admitted as a status word.
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
      -- E7 design 2.1 item 5, correction E7D-C-F1, AND THE ONLY CHANGE TO THIS BODY: 'held' joins the words, so
      -- the reconciler's own company.hold and company.hold_lift rows can be written. 'removed' is a MEMBERSHIP
      -- status and stays; the four company statuses are now active, suspended, closed and held.
      when 'status_before', 'status_after' then
        ok := jsonb_typeof(v) = 'string'
              and (v #>> '{}') in ('active', 'removed', 'suspended', 'closed', 'held');
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
-- 6. app.departure_subject(): 008's body with one test after the admin test (E7S-F1, the lead, 2026-09-20).
-- api.departure_preview is STABLE and takes no company lock (E6D-C-F9: one statement, one snapshot), so the
-- hold's fail-closed argument above did not reach it: app.require_admin tests the MEMBERSHIP's status and
-- never the company's, and an active administrator of a held company could still read one colleague's label
-- and work counts. The company's status is tested here, BELOW the admin test as closure is in app.export_admin,
-- so a stranger still meets E_NOT_FOUND and learns nothing; an administrator of a company that is not active
-- meets E_COMPANY_INACTIVE, the same answer app.lock_company gives every other member routine. Suspended and
-- closed companies are refused with it as well: a preview exists to precede a removal, and no removal can run in
-- a company whose lock refuses. Probe 32 flips E7S-F1's admitted case to this refusal.
-- ---------------------------------------------------------------------------
create or replace function app.departure_subject(p_membership uuid) returns app.memberships
language plpgsql stable security definer set search_path = '' as $$
declare
  s app.memberships;
  st text;
begin
  if p_membership is null then raise exception 'E_BODY_INVALID' using errcode = '22023'; end if;
  select * into s from app.memberships where id = p_membership;
  if s.id is null then raise exception 'E_NOT_FOUND' using errcode = 'P0002'; end if;
  perform app.require_admin(s.company_id, app.server_actor());
  select status into st from app.companies where id = s.company_id;
  if st is distinct from 'active' then
    raise exception 'E_COMPANY_INACTIVE' using errcode = 'P0001';
  end if;
  return s;
end $$;
revoke all on function app.departure_subject(uuid) from public;
