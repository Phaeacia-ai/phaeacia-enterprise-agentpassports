-- 007_installations.sql
-- E5 gallery, install and evidence (docs/e5/design.md, amended 2026-09-16 after its Codex critique). Additive: 001 to
-- 006 are applied and accepted and none of their bytes changes (scripts/check-migrations.mjs). An object that exists is
-- replaced with create or replace, which keeps its owner, grants and triggers.
--
-- One owner, the E5 server lane. It writes the recipient ledger E4 created and left without a production writer (E4
-- design 1.4), adds the two evidence tables the E1 architecture sketched as one, and widens exactly one accepted
-- predicate, app.release_visible_to, with the two recipient arms E4 3.6 reserved for this migration.
--
-- The number. The Copilot slice reserves 007_copilot_target.sql (docs/copilot/design.md B5); this file lands first, so
-- Copilot becomes 008. Applying the two in either order gives the same schema: this file never restates
-- app.release_target_names(), enumerates no target anywhere, binds no gate identity, and its audit additions are key
-- names and never target values (design 2.3).
--
-- Where this file fills a gap the 2.3 sketch leaves or departs from it, the comment at that object says so, and
-- evidence/e5-server.md lists each one. Four of the design critique's tracked debts are settled here and marked at
-- their object: E5D-C-F1 (the zero-row branch decides visibility before the state code), E5D-C-F2 (the per-recipient
-- quota is serialized after the release lock, and the one predicate answers exhaustion), E5D-C-F4 (the own-ledger
-- visibility arm that keeps a still-current downloaded release readable after the audience moves) and E5D-C-F9
-- (whitespace-only losses is E_BODY_INVALID from the reused validator).
--
-- Disclosed, as 003 and 006 disclose: a CHECK violation makes PostgreSQL report "Failing row contains (...)". The
-- BEFORE INSERT triggers below refuse, first and with a code, every condition a CHECK on member-supplied text or on the
-- losses rule repeats, so no losses, assistance or note text is echoed into the server log; those CHECKs fire only if a
-- trigger is dropped.

-- ---------------------------------------------------------------------------
-- B1. Vocabulary and limits, each owned in one place like app.role_names()
-- ---------------------------------------------------------------------------
-- The statuses a recipient and a witness may choose (design 1.4a). `removed` is what makes E4's withdrawal checklist
-- actionable: "I have taken this configuration out of my assistant".
create or replace function app.installation_statuses() returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select array['pass', 'partial', 'fail', 'removed']::text[] $$;

-- Who produced a row (design 1.5). The server sets it; no routine takes it as a parameter.
create or replace function app.installation_sources() returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select array['recipient_app', 'recipient_mail', 'founder_run']::text[] $$;

-- Authorizations of one release by one membership (design 1.2, derived): at the plan's envelope of 25 users an
-- audience is at most the company, so one release's ledger is at most 200 x 25 = 5,000 rows, inside the 10,000-row
-- ceiling lib/services/evidence-reads.mjs readLedger fails closed at (E4D-C-F5). The condition, stated because
-- E5D-C-F2 is right that it is not discharged by concurrent seats: the ledger counts *lifetime* memberships, so a
-- company that replaces members accumulates recipients while 25 remain active. The arithmetic holds while a company's
-- lifetime memberships stay at or below 50; above that the ceiling or this limit has to move (design 6).
create or replace function app.limit_downloads_per_recipient() returns integer
language sql immutable parallel safe set search_path = '' as $$ select 200 $$;

-- Reports of one release by one membership (design 1.4a): a recipient who reports fail, gets help and reports pass is
-- telling the truth twice, and both rows are kept.
create or replace function app.limit_reports_per_recipient() returns integer
language sql immutable parallel safe set search_path = '' as $$ select 20 $$;

-- Witnesses of one report (design 1.4b): several reviewers may each witness one report, one row each.
create or replace function app.limit_witnesses_per_report() returns integer
language sql immutable parallel safe set search_path = '' as $$ select 10 $$;

-- The check-in interval (design 1.4c). Never stored on a row: the due state is derived from the first authorization
-- and the absence of a report, so it cannot go stale and needs no sweep. lib/rules/installations.mjs holds the Node
-- copy and tests/e3/unit/migration-text.test.mjs pins it against this text.
create or replace function app.check_in_interval() returns interval
language sql immutable parallel safe set search_path = '' as $$ select interval '14 days' $$;

-- ---------------------------------------------------------------------------
-- B2. The one index E5 adds to E4's ledger (design 1.1)
-- ---------------------------------------------------------------------------
-- E4's only ledger index leads with the release, so "which releases has this membership authorized, and when first" is
-- a sequential scan. The "you installed earlier" section and the check-in state both ask it. Measured in design 10.2 on
-- 25,000 synthetic ledger rows: an index-only scan, 4 buffers, 0.041 ms with this index; a sequential scan removing
-- 24,900 rows, 288 buffers, 0.926 ms without it. An index changes no contract on an E4 table.
create index release_downloads_membership on app.release_downloads (membership_id, release_id)
  include (authorized_at);

-- ---------------------------------------------------------------------------
-- B3. THE ONE PREDICATE (design 1.1), and the three doors a reader's view calls
-- ---------------------------------------------------------------------------
-- app.download_refusal_for answers null when a download by that membership would be authorized, and otherwise the code
-- of the first condition that fails, in a fixed order. It takes the release row, not its id, so api.authorize_download
-- passes the row it has already locked and reads it no second time. Granted to nobody: the routine and the door below
-- are its only callers, so no member can ask whether a colleague may download something.
--
-- Rows 1 and 2 come first because E4 1.4 fixes them there: they are the predicate of the download's first row lock and
-- therefore the linearization point. Rows 3 to 6 are the standing, owner, target and audience checks E4 3.6 left to
-- E5. Row 7 is E5D-C-F2: exhaustion is part of the one predicate, so the catalog and the routine cannot disagree about
-- a membership that has reached its limit. It is last because design 3.5 puts E_DOWNLOAD_LIMIT after the audience.
create or replace function app.download_refusal_for(r app.releases, p_membership uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when r.state <> 'published' then 'E_RELEASE_WITHDRAWN'
    when r.superseded_by_release_id is not null then 'E_RELEASE_SUPERSEDED'
    when not exists (select 1 from app.memberships m join app.companies c on c.id = m.company_id
                      where m.id = p_membership and m.company_id = r.company_id
                        and m.status = 'active' and c.status = 'active') then 'E_NOT_FOUND'
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
         >= app.limit_downloads_per_recipient() then 'E_DOWNLOAD_LIMIT'
    else null end
$$;

-- The reader's door (E4S-F1's lesson: a security invoker function in schema app cannot be called from an api view,
-- because no request role holds USAGE on that schema, and every read selecting the column answers 42501). It reads the
-- row itself, answers E_NOT_FOUND for a release the caller cannot read, and otherwise calls the two-argument form with
-- the caller's own membership.
create or replace function app.download_refusal(p_release uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when app.release_visible(p_release)
    then (select app.download_refusal_for(r, app.my_membership(r.company_id))
            from app.releases r where r.id = p_release)
    else 'E_NOT_FOUND' end
$$;

-- The recipient's own ledger summary, without widening E4's ledger policy (design 1.7 and E5D-C-F3). It answers about
-- the caller's own membership and nothing else, so no read composed from it can hand a reviewer another membership's
-- authorization count or times.
create or replace function app.my_authorizations(p_release uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('authorizations', count(*),
                                             'first_authorized_at', min(d.authorized_at),
                                             'last_authorized_at', max(d.authorized_at))
                     from app.release_downloads d
                    where d.release_id = p_release
                      and d.membership_id = app.my_membership(
                            (select r.company_id from app.releases r where r.id = p_release))
                   having count(*) > 0),
                  jsonb_build_object('authorizations', 0, 'first_authorized_at', null,
                                     'last_authorized_at', null))
$$;

-- The headline a recipient may read without reading the candidate (design 1.1). A plain member may not read a
-- candidate (E3 4.1), so the release's title and summary are not reachable through api.candidate_versions; this door
-- answers the three derived fields for a release the caller may read, and null otherwise. Beyond the sketch: it is
-- null-safe when the join finds nothing, which cannot happen for a published release and is a defect if it does.
create or replace function app.release_headline(p_release uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when app.release_visible(p_release)
    then (select jsonb_build_object('title', c.derived -> 'title', 'summary', c.derived -> 'summary',
                                    'needs', c.derived -> 'needs')
            from app.releases r join app.candidate_versions c on c.id = r.candidate_id
           where r.id = p_release)
    else null end
$$;

-- ---------------------------------------------------------------------------
-- B4. app.release_visible_to gains the two recipient arms (design 1.1). create or replace keeps grants.
-- ---------------------------------------------------------------------------
-- E4's body, unchanged, plus: a release addressed to a group I am in now (the dynamic audience of E4 Q1), and a
-- release I have an authorization for. The second arm is E5D-C-F4: it keeps a recipient's own history readable after
-- the release is superseded or withdrawn, and after their group membership ends, so the report they made still names a
-- release the page can read. Both arms require an active membership, because app.membership_of returns null for a
-- removed membership and for a company that is not active, and `= null` is never true.
create or replace function app.release_visible_to(p_release uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.releases r join app.agents a on a.id = r.agent_id
    where r.id = p_release
      and (app.candidate_visible_to(r.candidate_id, p_user)
           or a.owner_membership_id = app.membership_of(r.company_id, p_user)
           or exists (select 1 from app.group_members gm
                       where gm.membership_id = app.membership_of(r.company_id, p_user)
                         and gm.group_id = any (r.audience_group_ids))
           or exists (select 1 from app.release_downloads d
                       where d.release_id = r.id
                         and d.membership_id = app.membership_of(r.company_id, p_user))))
$$;

-- ---------------------------------------------------------------------------
-- B5. The two evidence tables (design 1.4), append-only, one statement per person
-- ---------------------------------------------------------------------------
-- The E1 architecture sketched one `installations` row carrying the recipient's status and the witness columns. Two
-- tables, for the reason the architecture itself states: "A witnessed row never overwrites a reported row; both are
-- kept." One row with witness columns means the recipient's row is updated by somebody else, which destroys both
-- append-only and the rule that a statement belongs to the person who made it, and admits exactly one witness.
--
-- Beyond the sketch: unique (id, release_id) and unique (id, company_id), so a witness carries its report's release and
-- company and is held to both by composite foreign keys; the release and the membership are each named with the company
-- in one key, so "no cross-company evidence row" is a database invariant and not only a routine's refusal.
create table app.installation_reports (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references app.companies (id),
  release_id    uuid not null,
  membership_id uuid not null,
  status        text not null check (status = any (app.installation_statuses())),
  losses        text check (losses is null or char_length(losses) between 1 and 2000),
  assistance    text check (assistance is null or char_length(assistance) between 1 and 2000),
  source        text not null check (source = any (app.installation_sources())),
  reported_at   timestamptz not null default clock_timestamp(),
  foreign key (release_id, company_id) references app.releases (id, company_id),
  foreign key (membership_id, company_id) references app.memberships (id, company_id),
  constraint report_losses_required check (status in ('pass', 'removed') or losses is not null),
  unique (id, release_id),
  unique (id, company_id)
);
-- A release's reports, newest last, per membership; and a membership's reports across releases (design 7 scenario 5).
create index installation_reports_release on app.installation_reports (release_id, membership_id, reported_at);
create index installation_reports_membership on app.installation_reports (membership_id, release_id);

create table app.installation_witnesses (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references app.companies (id),
  report_id             uuid not null,
  release_id            uuid not null,
  witness_membership_id uuid not null,
  witness_role          text not null check (witness_role in ('it_reviewer', 'business_reviewer', 'company_admin')),
  status                text not null check (status = any (app.installation_statuses())),
  note                  text not null check (char_length(note) between 1 and 2000),
  witnessed_at          timestamptz not null default clock_timestamp(),
  foreign key (report_id, release_id) references app.installation_reports (id, release_id),
  foreign key (report_id, company_id) references app.installation_reports (id, company_id),
  foreign key (witness_membership_id, company_id) references app.memberships (id, company_id),
  unique (report_id, witness_membership_id)
);
-- A release's witnesses are one paged read rather than one read per report (design 1.4b).
create index installation_witnesses_release on app.installation_witnesses (release_id, report_id);

-- app.report_identity, BEFORE INSERT. Beyond the sketch, for the disclosure reason above: the text rules run first and
-- with a code, so an owner-side insert of a 2,001-code-point or control-carrying losses is refused before the CHECK
-- could echo the row, and the same for the losses-required rule. Then the row's own consistency (the company is the
-- release's and the membership's; the composite keys say the same thing and this says it with a code), and
-- E5D-C-F9's rule: a whitespace-only losses trims to nothing and is E_BODY_INVALID from the reused validator, not
-- E_LOSSES_REQUIRED. Finally design 1.5: a `founder_run` row is refused unless the migration bypass is set, the same
-- construction app.registry_frozen() uses for the three registers, so no route and no member can label a statement as
-- a founder-run transfer.
create or replace function app.report_identity() returns trigger
language plpgsql set search_path = '' as $$
declare
  rel_company uuid;
begin
  if new.losses is not null then
    new.losses := app.review_reason(new.losses);
  end if;
  if new.assistance is not null then
    new.assistance := app.review_reason(new.assistance);
  end if;
  if new.status is null or not (new.status = any (app.installation_statuses())) then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  if new.losses is null and new.status in ('partial', 'fail') then
    raise exception 'E_LOSSES_REQUIRED' using errcode = '22023';
  end if;
  select r.company_id into rel_company from app.releases r where r.id = new.release_id;
  if rel_company is null or rel_company is distinct from new.company_id then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (select 1 from app.memberships m
                  where m.id = new.membership_id and m.company_id = new.company_id) then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  if new.source = 'founder_run'
     and coalesce(current_setting('app.registry_migration', true), 'off') <> 'on' then
    raise exception 'E_FORBIDDEN' using errcode = '42501';
  end if;
  return new;
end $$;

-- Append-only for every role, the owner included (design 1.4a and 1.7). Row triggers do not fire on TRUNCATE (E3a
-- critique F1), so each table carries a statement trigger for it as well.
create or replace function app.report_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'E_REPORT_APPEND_ONLY' using errcode = '42501';
end $$;
create or replace function app.witness_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'E_WITNESS_APPEND_ONLY' using errcode = '42501';
end $$;

-- app.witness_identity, BEFORE INSERT: the note rule first and with a code, then the release and company copied from
-- the report the row names, never from the caller, so the composite foreign keys can only agree.
create or replace function app.witness_identity() returns trigger
language plpgsql set search_path = '' as $$
declare
  rpt app.installation_reports;
begin
  new.note := app.review_reason(new.note);
  if new.status is null or not (new.status = any (app.installation_statuses())) then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  select * into rpt from app.installation_reports p where p.id = new.report_id;
  if rpt.id is null then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  new.company_id := rpt.company_id;
  new.release_id := rpt.release_id;
  if new.witness_membership_id = rpt.membership_id then
    raise exception 'E_WITNESS_IS_RECIPIENT' using errcode = '42501';
  end if;
  return new;
end $$;

-- Firing order is part of the contract: BEFORE ROW triggers of one event fire in name order, so on an UPDATE the
-- append-only refusal (_1_) runs before anything else could read the row.
create trigger installation_reports_1_append_only before update or delete on app.installation_reports
  for each row execute function app.report_append_only();
create trigger installation_reports_2_identity before insert on app.installation_reports
  for each row execute function app.report_identity();
create trigger installation_reports_no_truncate before truncate on app.installation_reports
  for each statement execute function app.report_append_only();
create trigger installation_witnesses_1_append_only before update or delete on app.installation_witnesses
  for each row execute function app.witness_append_only();
create trigger installation_witnesses_2_identity before insert on app.installation_witnesses
  for each row execute function app.witness_identity();
create trigger installation_witnesses_no_truncate before truncate on app.installation_witnesses
  for each statement execute function app.witness_append_only();

-- ---------------------------------------------------------------------------
-- B6. Visibility (design 1.7), E4's two-door idiom
-- ---------------------------------------------------------------------------
-- Who may read one installation report: the reporting membership while active, a company admin, an it_reviewer or a
-- business_reviewer of the company, and the agent's current owner. Reviewers must read a report in order to witness it;
-- design 8 question 2 puts that in front of Raffael and design 7 scenario 6 is the one-predicate change if he says no.
create or replace function app.installation_visible(p_company uuid, p_membership uuid, p_release uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_membership = app.my_membership(p_company)
      or app.has_role(p_company, 'company_admin')
      or app.has_role(p_company, 'it_reviewer')
      or app.has_role(p_company, 'business_reviewer')
      or exists (select 1 from app.releases r join app.agents a on a.id = r.agent_id
                  where r.id = p_release and a.owner_membership_id = app.my_membership(p_company))
$$;

-- A witness is visible exactly where its report is. Beyond the sketch, which wrote the policy as an EXISTS over
-- app.installation_reports: that would evaluate the reports policy inside the witnesses policy, nesting row level
-- security in a way neither table's predicate states. A definer door asks the question once, as E4's doors do.
create or replace function app.witness_visible(p_report uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.installation_reports p
                  where p.id = p_report
                    and app.installation_visible(p.company_id, p.membership_id, p.release_id))
$$;

-- ---------------------------------------------------------------------------
-- B7. Row level security, grants and views (design 1.7, 2.3 B7 and 3.1)
-- ---------------------------------------------------------------------------
alter table app.installation_reports enable row level security;
alter table app.installation_witnesses enable row level security;

create policy installation_reports_read on app.installation_reports for select to authenticated
  using (app.installation_visible(company_id, membership_id, release_id));
create policy installation_witnesses_read on app.installation_witnesses for select to authenticated
  using (app.witness_visible(report_id));
grant select on app.installation_reports, app.installation_witnesses to authenticated;

-- app_maintenance reads both tables for reconciliation and writes neither, as 003 grants it the content tables and 006
-- the review and release tables: SELECT grants and SELECT policies, no UPDATE policy anywhere, and the append-only
-- triggers above refuse it as they refuse the owner (design 1.7, E6's handoff item 2).
grant select on app.installation_reports, app.installation_witnesses to app_maintenance;
create policy maintenance_installation_reports on app.installation_reports for select to app_maintenance using (true);
create policy maintenance_installation_witnesses on app.installation_witnesses for select to app_maintenance
  using (true);

create view api.installation_reports with (security_invoker = true) as
  select id, company_id, release_id, membership_id, status, losses, assistance, source, reported_at
  from app.installation_reports;
create view api.installation_witnesses with (security_invoker = true) as
  select id, company_id, report_id, release_id, witness_membership_id, witness_role, status, note, witnessed_at
  from app.installation_witnesses;

-- api.release_catalog is api.releases' columns plus the three computed ones a recipient's page needs, over
-- app.releases, so row level security (B4) decides the rows and the view never repeats the predicate (design 1.1).
-- assembled_content is not a column of this view, as it is not a column of api.releases: api.authorize_download stays
-- its only reader (E4 3.1, unchanged).
create view api.release_catalog with (security_invoker = true) as
  select r.id, r.company_id, r.agent_id, r.candidate_id, r.envelope_id, r.target, r.gate_id, r.content_sha256,
         r.derived_sha256, r.installer_text_sha256, r.core_sha256, r.branch_sha256, r.judge_sha256, r.policy_id,
         r.policy_sha256, r.audience_group_ids, r.envelope_sha256, r.assembled_sha256, r.assembled_bytes, r.state,
         r.published_by_membership_id, r.published_at, r.superseded_by_release_id, r.superseded_at,
         r.withdrawn_by_membership_id, r.withdrawn_at, r.withdrawal_reason,
         app.download_refusal(r.id) as blocked_reason,
         app.my_authorizations(r.id) as my_authorizations,
         app.release_headline(r.id) as headline
  from app.releases r;

grant select on api.installation_reports, api.installation_witnesses, api.release_catalog to authenticated;

-- ---------------------------------------------------------------------------
-- B8. The claim table admits E5's two bound routines (design 2.3 B8). The constraint name is the one PostgreSQL gave
--     003's column check, kept by 006 part A.
-- ---------------------------------------------------------------------------
alter table app.idempotency_keys drop constraint idempotency_keys_fn_check;
alter table app.idempotency_keys add constraint idempotency_keys_fn_check check (fn in (
  'create_draft', 'save_draft', 'submit_candidate', 'create_successor',
  'create_envelope', 'record_review', 'publish_release', 'withdraw_release',
  'report_installation', 'witness_installation'));

-- ---------------------------------------------------------------------------
-- B9. The audit allowlist grows by id, integer and enumerated keys only (design 2.4). The body is 006 part A's, every
--     rule kept; the new branches are marked E5.
-- ---------------------------------------------------------------------------
-- No losses, assistance or note text ever enters details: they are member-supplied text, and this is a shape check,
-- not a content detector, which is E4's own argument about review reasons.
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
           'report_id', 'witness_id' then
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
      when 'content_sha256', 'derived_sha256', 'gate_identity_sha256',
           -- E4
           'envelope_sha256', 'assembled_sha256', 'policy_sha256', 'installer_text_sha256' then
        ok := jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^[0-9a-f]{64}$';
      when 'sequence', 'version',
           -- E4
           'envelope_revision', 'recipient_count',
           -- E5
           'authorizations' then
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
-- B10. The response helpers and the three routines (design 1.2, 1.4, 2.5, 3.3 and 3.5)
-- ---------------------------------------------------------------------------
-- The responses the routines return and their claims store; the services map them to the API's names and read the
-- objects of design 3.4 through the views. Neither holds a release's bytes.
create or replace function app.installation_response(p app.installation_reports) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('report_id', p.id, 'release_id', p.release_id, 'membership_id', p.membership_id,
                            'status', p.status, 'source', p.source, 'idempotent_replay', false)
$$;
create or replace function app.witness_response(w app.installation_witnesses) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('witness_id', w.id, 'report_id', w.report_id, 'release_id', w.release_id,
                            'witness_membership_id', w.witness_membership_id, 'witness_role', w.witness_role,
                            'status', w.status, 'idempotent_replay', false)
$$;

-- The witness's role at the moment of witnessing (design 1.4b), read from the membership row under the company lock, so
-- the label "Witnessed by an IT reviewer" stays true after the role is removed, exactly as E4's sign-offs do not decay.
-- Beyond the sketch, which does not say which role a membership holding several contributes: the first this membership
-- holds of it_reviewer, business_reviewer, company_admin, in that order, because the reviewer roles are the ones the
-- statement is about and the admin role is the fallback that lets an administrator witness at all. Null when the
-- membership holds none of the three; the routine's row 19 refuses that before this is read.
create or replace function app.witness_role_of(p_membership uuid) returns text
language sql stable security definer set search_path = '' as $$
  select r from unnest(array['it_reviewer', 'business_reviewer', 'company_admin']::text[]) r
   where exists (select 1 from app.memberships m where m.id = p_membership and r = any (m.roles))
   limit 1
$$;

-- api.authorize_download (design 1.2; 3.5 download rows 11 to 23). Unbound by decision (design 1.2 and 3.3): no
-- Idempotency-Key, no claim row, and a repeat is a true second authorization answered 200 with one more ledger row.
-- E4 1.4's download half, in its order: app.server_actor() and app.require_standing before the lock, no company lock,
-- no FOR UPDATE, no REPEATABLE READ, no SERIALIZABLE; the FOR SHARE with E4's predicate is the first row lock and the
-- linearization point; then the predicate, then the quota, then the insert; the bytes are returned after, and PostgREST
-- produces the HTTP answer once the transaction has committed, which is the property E4's "the bytes may be delivered
-- after commit" protects.
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

-- api.report_installation (design 1.4a; 3.5 report rows 13 to 25). Bound, unlike the download, and the difference is the
-- point: a report is authored text, and a retry after a lost answer must not become a second statement that reads as a
-- change of mind. E3 4.3's order throughout: app.bound_actor with bindingSql('report_installation') of
-- lib/db/server.mjs pasted and the operation digest operationSql('report_installation') pasted
-- (tests/e3/unit/migration-text.test.mjs holds both verbatim); malformed input; standing; the company lock and standing
-- again; row locks in design 2.5's order (membership at level 2, the release at level 6 and FOR SHARE, not FOR UPDATE,
-- so a report never blocks a withdrawal); the authorization facts; the claim lookup; then the ceiling and every
-- fresh-only precondition in 3.5's row order; the insert, its audit row and the claim with the response.
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
     >= app.limit_reports_per_recipient() then
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

-- api.witness_installation (design 1.4b; 3.5 witness rows 13 to 25). Rows 19 and 20, the role and the recipient
-- exclusion, sit above the claim lookup with standing, exactly as E4 puts role and independence there: a caller who lost
-- the role since the first attempt is refused rather than handed a stored answer.
create or replace function api.witness_installation(p_report uuid, p_status text, p_note text,
  p_idempotency_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.bound_actor('witness_installation', sha256(convert_to(concat_ws(E'\n', 'witness_installation', coalesce(p_report::text, '-'), coalesce(encode(sha256(convert_to(p_status, 'UTF8')), 'hex'), '-'), coalesce(encode(sha256(convert_to(p_note, 'UTF8')), 'hex'), '-'), coalesce(p_idempotency_key::text, '-')), 'UTF8')));
  operation bytea := sha256(convert_to(concat_ws(E'\n', 'witness_installation', coalesce(p_report::text, '-'), coalesce(encode(sha256(convert_to(p_status, 'UTF8')), 'hex'), '-'), coalesce(encode(sha256(convert_to(p_note, 'UTF8')), 'hex'), '-')), 'UTF8'));
  v_note text;
  company uuid;
  rel_id uuid;
  reporter uuid;
  member_id uuid;
  v_role text;
  replay jsonb;
  wit app.installation_witnesses;
  result jsonb;
begin
  -- row 14. A witness with no statement is not evidence, so the note is required and judged by the same rule.
  if p_report is null or p_status is null or p_note is null or p_idempotency_key is null then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  if not (p_status = any (app.installation_statuses())) then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  v_note := app.review_reason(p_note);
  -- row 15
  select p.company_id, p.release_id, p.membership_id into company, rel_id, reporter
    from app.installation_reports p where p.id = p_report;
  if company is null then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_standing(company, actor);
  -- rows 16 and 17
  perform app.lock_company(company);
  perform app.require_standing(company, actor);
  member_id := app.membership_of(company, actor);
  perform 1 from app.memberships m where m.id = member_id for update;
  perform 1 from app.releases r where r.id = rel_id for share;
  -- row 18: a caller who cannot read the report is told nothing about it, so a plain member who is not its recipient
  -- meets 404 here and never the role refusal below (design 3.1's member cell reads 403; the truthful answer is 404,
  -- and evidence/e5-server.md proposes that amendment).
  if not app.installation_visible(company, reporter, rel_id) then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  -- row 19: an active member holding it_reviewer, business_reviewer or company_admin, at any aal. Witnessing neither
  -- grants nor contracts access, and requiring aal2 would close the admin path while the reviewer path stays open at
  -- aal1 (design 1.4b).
  v_role := app.witness_role_of(member_id);
  if v_role is null then
    raise exception 'E_ROLE_REQUIRED' using errcode = '42501';
  end if;
  -- row 20: a second person's statement is the whole content of the row.
  if member_id = reporter then
    raise exception 'E_WITNESS_IS_RECIPIENT' using errcode = '42501';
  end if;
  -- rows 21 to 23
  replay := app.idempotency_lookup(member_id, p_idempotency_key, 'witness_installation', operation);
  if replay is not null then
    return replay;
  end if;
  perform app.idempotency_ceiling(member_id);
  -- row 24: the same reviewer contradicting themselves about the same moment is not new evidence; the honest path is a
  -- fresh report by the recipient with a fresh witness.
  if exists (select 1 from app.installation_witnesses w
              where w.report_id = p_report and w.witness_membership_id = member_id) then
    raise exception 'E_ALREADY_WITNESSED' using errcode = 'P0001';
  end if;
  -- row 25
  if (select count(*) from app.installation_witnesses w where w.report_id = p_report)
     >= app.limit_witnesses_per_report() then
    raise exception 'E_WITNESS_LIMIT' using errcode = 'P0001';
  end if;
  -- witness_role is copied under the company lock, so the label stays true after the role is removed. company_id and
  -- release_id are the trigger's, from the report.
  insert into app.installation_witnesses (company_id, report_id, release_id, witness_membership_id, witness_role,
                                          status, note)
  values (company, p_report, rel_id, member_id, v_role, p_status, v_note)
  returning * into wit;
  perform app.audit(company, actor, 'member', 'installation.witness', 'release', rel_id,
    jsonb_build_object('witness_id', wit.id, 'report_id', p_report, 'release_id', rel_id,
                       'membership_id', member_id, 'installation_status', wit.status,
                       'witness_role', wit.witness_role));
  result := app.witness_response(wit);
  perform app.idempotency_claim(member_id, p_idempotency_key, 'witness_installation', operation, result);
  return result;
end $$;

-- ---------------------------------------------------------------------------
-- B. Grants. The new helpers and trigger functions are executable by nobody but the owner, as 003, 004 and 006 revoke
--    their own; the four reader doors are granted to authenticated; EXECUTE on the three routines to app_server alone,
--    by full signature. app.download_refusal_for is granted to nobody: no member may ask whether a colleague may
--    download something (design 1.1).
-- ---------------------------------------------------------------------------
revoke execute on function app.installation_statuses(), app.installation_sources(),
  app.limit_downloads_per_recipient(), app.limit_reports_per_recipient(), app.limit_witnesses_per_report(),
  app.check_in_interval(), app.download_refusal_for(app.releases, uuid), app.download_refusal(uuid),
  app.my_authorizations(uuid), app.release_headline(uuid), app.release_visible_to(uuid, uuid),
  app.report_identity(), app.witness_identity(), app.report_append_only(), app.witness_append_only(),
  app.installation_visible(uuid, uuid, uuid), app.witness_visible(uuid), app.witness_role_of(uuid),
  app.installation_response(app.installation_reports), app.witness_response(app.installation_witnesses)
  from public;
grant execute on function app.download_refusal(uuid), app.my_authorizations(uuid), app.release_headline(uuid),
  app.installation_visible(uuid, uuid, uuid), app.witness_visible(uuid) to authenticated;
revoke execute on function api.authorize_download(uuid),
  api.report_installation(uuid, text, text, text, uuid),
  api.witness_installation(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function api.authorize_download(uuid),
  api.report_installation(uuid, text, text, text, uuid),
  api.witness_installation(uuid, text, text, uuid) to app_server;
