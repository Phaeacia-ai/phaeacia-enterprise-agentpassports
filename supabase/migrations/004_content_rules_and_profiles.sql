-- 004_content_rules_and_profiles.sql
-- The first migration after 003 froze at the E3a acceptance. Lead-owned and additive: 001_identity.sql,
-- 002_bound_principal.sql and 003_content.sql are applied and accepted, and none of their bytes changes
-- (scripts/check-migrations.mjs refuses an edit). Every object this file replaces is replaced by create or
-- replace, which keeps its owner, its grants and the triggers that call it.
--
-- Part A pays three E3 debts (evidence/e1-lead.md, "E3a accepted at 5535cef"):
--   A1 E3A-R-D1  a declared offline contributor's name is trimmed, then 1 to 120 characters, at the routine;
--   A2 E3A-D1    the gate registry refuses an owner's UPDATE, DELETE and TRUNCATE outside a migration;
--   A3 E3A-D2    app.submission_fields no longer depends on the order PostgreSQL evaluates OR operands in.
-- No frozen history is backfilled: a name 003 accepted untrimmed stays as it was stored.

-- ---------------------------------------------------------------------------
-- A1. The declared-name trim class, owned in one place like app.role_names()
-- ---------------------------------------------------------------------------
-- The class is the service's, not a choice made here. lib/services/candidates.mjs submissionOf trims a declared
-- display name with ECMAScript String.prototype.trim() (evidence/e3b.md D14), which removes WhiteSpace and
-- LineTerminator: U+0009, U+000A, U+000B, U+000C, U+000D, U+0020, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029,
-- U+202F, U+205F, U+3000 and U+FEFF. The routine trims exactly that set so the two agree on every name; btrim's
-- default strips U+0020 alone and would disagree on a tab-only name. tests/e3/unit/migration-text.test.mjs derives
-- the set from Node's own trim() over every code point and compares it with the chr() list below.
--
-- A deliberate contrast, not an inconsistency: a profile display name (api.set_display_name, Part B) trims U+0020
-- only. That rule was designed for another field with another consumer (pages design 2.1), and each rule has its
-- own parity test. Neither is derived from the other.
create or replace function app.declared_name_trim_characters() returns text
language sql immutable parallel safe set search_path = '' as $$
  select chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760)
      || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199)
      || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288)
      || chr(65279)
$$;

-- The name as it is checked and stored. Characters inside the name, a double space included, are kept as sent.
create or replace function app.declared_name(p_name text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select btrim(p_name, app.declared_name_trim_characters())
$$;

-- ---------------------------------------------------------------------------
-- A1 and A3. app.submission_fields, 003's rules with two changes
-- ---------------------------------------------------------------------------
-- A1: a declared display name is judged after app.declared_name, so a name of whitespace alone is E_BODY_INVALID.
-- A3: every refusal whose test can raise on the wrong JSON type runs after the test that makes it safe. 003 wrote
-- the whole rule as one OR chain and relied on its operands running left to right, so a scalar contributor never
-- reached jsonb_object_keys and an object never reached jsonb_array_length. PostgreSQL promises no such order. A
-- planner that reordered them would still refuse and write nothing, but with that function's own message instead of
-- E_BODY_INVALID. Here the type tests are separate PL/pgSQL statements, which run in order, and the per-element test
-- is a CASE, whose conditions are evaluated in order and whose later branches are not evaluated once one is chosen.
-- The rules themselves are 003's: the closed key set, the three required fields and every per-item bound.
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
  if jsonb_typeof(s) is distinct from 'object' then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  -- s is an object from here. No operand below raises on any JSON value, so their order does not matter.
  if exists (select 1 from jsonb_object_keys(s) k
              where k not in ('source_platform', 'confidence', 'permitted_data', 'dependencies', 'declared_contributors'))
     or jsonb_typeof(s->'source_platform') is distinct from 'string'
     or length(s->>'source_platform') not between 1 and 80
     or (s->>'confidence') is distinct from 'high' and (s->>'confidence') is distinct from 'medium'
        and (s->>'confidence') is distinct from 'low'
     or jsonb_typeof(s->'confidence') is distinct from 'string'
     or jsonb_typeof(s->'permitted_data') is distinct from 'string'
     or length(s->>'permitted_data') not between 1 and 2000 then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  if s ? 'dependencies' then
    if jsonb_typeof(s->'dependencies') is distinct from 'array' then
      raise exception 'E_BODY_INVALID' using errcode = '22023';
    end if;
    if jsonb_array_length(s->'dependencies') > 40
       or exists (select 1 from jsonb_array_elements(s->'dependencies') d
                   where jsonb_typeof(d) <> 'string' or length(d #>> '{}') not between 1 and 200) then
      raise exception 'E_BODY_INVALID' using errcode = '22023';
    end if;
  end if;
  if s ? 'declared_contributors' then
    if jsonb_typeof(s->'declared_contributors') is distinct from 'array' then
      raise exception 'E_BODY_INVALID' using errcode = '22023';
    end if;
    -- declared_contributors items are {membership_id} or {display_name}, never both.
    if jsonb_array_length(s->'declared_contributors') > 50
       or exists (
         select 1 from jsonb_array_elements(s->'declared_contributors') e
          where case
                  -- A3: the object test decides first; jsonb_object_keys is reached only by an object.
                  when jsonb_typeof(e) <> 'object' then true
                  when (select count(*) from jsonb_object_keys(e)) <> 1 then true
                  -- IS NOT TRUE, because SQL booleans are three-valued (E3a critique F2): with one alternative's key
                  -- absent its test is NULL, and only an entry known to be one valid shape is kept out of the refusal.
                  else ((jsonb_typeof(e->'membership_id') = 'string'
                         and (e->>'membership_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
                        or (jsonb_typeof(e->'display_name') = 'string'
                            and char_length(app.declared_name(e->>'display_name')) between 1 and 120)) is not true
                end) then
      raise exception 'E_BODY_INVALID' using errcode = '22023';
    end if;
  end if;
  return s;
end $$;

-- ---------------------------------------------------------------------------
-- A1. api.submit_candidate stores the trimmed name
-- ---------------------------------------------------------------------------
-- 003's body, every step in its order and the binding and operation digests verbatim (bindingSql and operationSql of
-- lib/db/server.mjs; tests/e3/unit/migration-text.test.mjs requires the latest definition of each routine to hold
-- them). One expression changes, marked: the declared_offline insert stores app.declared_name(display_name), the
-- value app.submission_fields judged.
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
  -- 004, A1: the trimmed name, which is the name app.submission_fields judged.
  insert into app.candidate_contributors (candidate_id, kind, display_name, observed)
  select cand.id, 'declared_offline', app.declared_name(e->>'display_name'), false
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

-- ---------------------------------------------------------------------------
-- A2. The gate registry is written by migrations only (design 2.7, E3A-D1)
-- ---------------------------------------------------------------------------
-- Nothing refused an owner's UPDATE, DELETE or TRUNCATE on the registry, and one TRUNCATE of the files table broke
-- manifest reproduction for every candidate at once. A plain refusal would also refuse the migration that registers a
-- new identity, which is the owner too, so the refusal has one bypass: a transaction-local setting,
--
--   set local app.registry_migration = 'on';
--
-- which a future migration that registers a new identity and deactivates the old one sets at its top, and which dies
-- with that migration's transaction. INSERT is not refused: registering is an insert, and a row once written is what
-- this protects. The output of scripts/gate-manifest.mjs --sql deactivates with an UPDATE, so a migration that pastes
-- it must set the bypass first; 003's pasted block ran before this trigger existed.
--
-- WHAT THIS REFUSES AND WHAT IT DOES NOT. It refuses an accident: a maintenance command, a mistaken script, a TRUNCATE
-- typed at the wrong table. It does not refuse an owner who sets the bypass on purpose, nor one who drops or disables
-- the trigger, which is the same bound contributors_no_truncate (003) and audit_no_truncate (001) have. Any session may
-- set a custom setting, so the bypass is not a credential; only the owner holds a write grant on these tables, and
-- that grant is the boundary. A session-level SET instead of SET LOCAL would keep the bypass for the whole session;
-- the convention is SET LOCAL, and nothing here can tell the two apart.
--
-- IS DISTINCT FROM, because current_setting(..., true) is NULL when the setting was never defined in this session and
-- '' after a SET LOCAL ended: neither is 'on', and a NULL must refuse rather than fall through.
create or replace function app.registry_frozen() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_setting('app.registry_migration', true) is distinct from 'on' then
    raise exception 'E_REGISTRY_FROZEN' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;
create trigger gate_identities_frozen before update or delete on app.gate_identities
  for each row execute function app.registry_frozen();
-- Row triggers do not fire on TRUNCATE (E3a critique F1), so each table has a statement trigger for it as well.
create trigger gate_identities_no_truncate before truncate on app.gate_identities
  for each statement execute function app.registry_frozen();
create trigger gate_identity_files_frozen before update or delete on app.gate_identity_files
  for each row execute function app.registry_frozen();
create trigger gate_identity_files_no_truncate before truncate on app.gate_identity_files
  for each statement execute function app.registry_frozen();

-- ---------------------------------------------------------------------------
-- A. Grants. The new helpers are executable by nobody but the owner, as 003 revokes its own.
-- ---------------------------------------------------------------------------
revoke execute on function app.declared_name_trim_characters(), app.declared_name(text), app.registry_frozen()
  from public;

-- ===========================================================================
-- Part B. The pages prerequisites: the lead-owned database changes of docs/e2/pages-design.md revision 7 (accepted
-- at 59ae330), sections 2.1 and 2.8. Their shared contracts are lib/db/server.mjs FUNCTIONS, the uuid-list exception
-- in lib/db/user.mjs, the six codes of 2.6 and the import-map edges of 4.1; their configuration is 2.7's three blocks
-- in supabase/config.toml, which GoTrue reads only when the stack is restarted.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- B1. api.set_display_name (pages design 2.1, "Setting one's own display name"), taken as written
-- ---------------------------------------------------------------------------
-- 2.1 gives a paragraph for each part; in short, so a reviewer can hold the code against it:
--   principal     app.server_actor() as 002 replaced it, so the row written is the token subject's, the function takes
--                 no user id and a bound E3 bearer is refused. SECURITY DEFINER with an empty search_path, like every
--                 function of 001 section 5, because neither app_server nor authenticated may write app.profiles.
--   no lock, no aal   a profile belongs to the account, not to a company, and no admin decision depends on it.
--   the rule      trim U+0020 only, then 1 to 120 code points (char_length, what the table's own check counts), then
--                 no C0 or C1 control from U+0001 (text cannot hold U+0000) and no Bidi_Control character: U+061C,
--                 U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069. The trim is not Part A's declared-name class, on
--                 purpose: another field with another consumer, and each rule has its own parity test. The Node copy,
--                 normalizeDisplayName in lib/rules/profiles.mjs, is pages construction's.
--   not found     E_NOT_FOUND for an account deleted while its access token still verifies. A deletion between that
--                 check and the insert fails the foreign key with 23503, which answers 500: the race 2.1 discloses.
--   one write     insert ... on conflict do update ... where creates the row, changes it, or skips an unchanged name,
--                 with no read-then-write window; two concurrent different names both commit, the later one stays.
--   unchanged     the same trimmed name again writes nothing and no audit row and answers changed = false.
--   audit         profile.set_display_name on entity profile, company_id null, actor_kind member, details { user_id }
--                 only: no name, and no hash of it, because an unkeyed hash of a short name is the name.
--   grants        execute to app_server alone; no table, policy, view or grant on app.profiles changes.
create or replace function api.set_display_name(p_display_name text)
returns table (changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  v text := btrim(p_display_name, ' ');
  n integer;
begin
  if v is null or char_length(v) not between 1 and 120
     or exists (select 1 from string_to_table(v, null) ch
                where ascii(ch) between 1 and 31 or ascii(ch) between 127 and 159
                   or ascii(ch) in (1564, 8206, 8207)
                   or ascii(ch) between 8234 and 8238 or ascii(ch) between 8294 and 8297) then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = actor) then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into app.profiles as p (user_id, display_name, updated_at)
  values (actor, v, now())
  on conflict (user_id) do update
    set display_name = excluded.display_name, updated_at = excluded.updated_at
    where p.display_name is distinct from excluded.display_name;
  get diagnostics n = row_count;
  if n = 1 then
    perform app.audit(null, actor, 'member', 'profile.set_display_name', 'profile', actor,
      jsonb_build_object('user_id', actor));
  end if;
  return query select n = 1;
end $$;
revoke execute on function api.set_display_name(text) from public, anon, authenticated;
grant execute on function api.set_display_name(text) to app_server;

-- ---------------------------------------------------------------------------
-- B2. The per-account bound on failed second-factor verifications (pages design 2.8)
-- ---------------------------------------------------------------------------
create table app.mfa_attempt_windows (
  user_id            uuid primary key,
  window_started_at  timestamptz not null,
  failures           integer     not null default 0,
  updated_at         timestamptz not null default now()
);
alter table app.mfa_attempt_windows enable row level security;
-- No policy and no grant: only the owner and the SECURITY DEFINER hook read or write it. The application never reads
-- this table (2.8, "Why there is no application precheck"), and its grants are asserted empty (S11h).

-- GoTrue v2.192.0 calls this on every TOTP verification, after it has checked the code and before it acts on the
-- result, with user_id, factor_id, factor_type and valid, in a transaction of its own (pages design O16). 2.8 states
-- the rule in six parts and leaves the body to the migration; each part is at the statement that carries it.
--   1  one row per account, created or locked by the first statement that touches the table, before anything is
--      decided: a second verification for the account waits on that row lock instead of reading the same state, so
--      ten at once cannot all read four failures;
--   2  five failures inside fifteen minutes exhaust the budget; the window starts at the first failure after a reset
--      and runs fifteen minutes from there, not rolling, so a refusal has an end the page can show;
--   3  an exhausted budget inside its window refuses the attempt whatever valid says, or the sixth guess would still
--      win; otherwise a valid attempt resets the count, and any other attempt adds one and GoTrue answers as it would;
--   4  the refusal is the error shape, 429 with the time the window ends, and never {"decision": "reject"}, which
--      makes GoTrue sign the account out of every session and would let a link holder do that to an admin at will;
--   5  nothing here catches an error: a raise, or GoTrue's statement timeout, fails the verification (fail-closed);
--   6  the budget resets on the first valid attempt and when the window has passed; no operator action unlocks it.
-- The key is user_id alone, so every factor of an account shares one budget. The hook grants nothing on input it does
-- not recognise: a user_id that is not a uuid raises (part 5), and an attempt whose valid is anything but JSON true
-- counts as a failure. GoTrue sends a uuid and a boolean.
create or replace function app.hook_mfa_verification_attempt(event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  budget constant integer := 5;
  window_length constant interval := interval '15 minutes';
  account uuid;
  started timestamptz;
  failed integer;
begin
  -- 1. The row, created or locked, and the state the decision is computed from.
  insert into app.mfa_attempt_windows as w (user_id, window_started_at, failures)
  values ((event->>'user_id')::uuid, now(), 0)
  on conflict (user_id) do update set updated_at = now()
  returning w.user_id, w.window_started_at, w.failures into account, started, failed;
  -- 6. A window that has passed is a whole budget again.
  if failed > 0 and now() >= started + window_length then
    failed := 0;
  end if;
  -- 3 and 4. Exhausted inside the window: refused, valid or not, and the row keeps its count and its window.
  if failed >= budget then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 429,
      'message', format('Too many attempts. Try again after %s.',
                        to_char((started + window_length) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))));
  end if;
  -- 3 and 6. A valid attempt resets the budget. Any other adds a failure, and the first failure starts the window.
  if (event->'valid') = 'true'::jsonb then
    update app.mfa_attempt_windows set failures = 0, updated_at = now() where user_id = account;
  else
    update app.mfa_attempt_windows
       set failures = failed + 1,
           window_started_at = case when failed = 0 then now() else started end,
           updated_at = now()
     where user_id = account;
  end if;
  return jsonb_build_object('decision', 'continue');
end $$;
revoke execute on function app.hook_mfa_verification_attempt(jsonb) from public, anon, authenticated;
grant execute on function app.hook_mfa_verification_attempt(jsonb) to supabase_auth_admin;
