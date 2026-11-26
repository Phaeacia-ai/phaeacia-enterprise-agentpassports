-- E5 download mutant (docs/e5/design.md 1.2, 2.7 and section 5 case 1). TEST ONLY, and a counterexample only.
--
-- It replaces tests/db/fixtures/e4-download-seam.sql, which stood in for E5's half of the release-lock protocol until
-- api.authorize_download existed. The production routine now performs that half, and probe 28 runs both B6 orders
-- against it with an open transaction rather than a barrier: a transaction holds its row locks until it commits, so
-- `begin; select api.authorize_download(...); <hold>; commit;` holds the FOR SHARE and an uncommitted ledger row while
-- a withdrawal waits, and a download that asks after a withdrawal's FOR UPDATE is granted waits and then re-evaluates
-- the predicate on the committed row version.
--
-- Two arms still need a pause inside the download half, and this file is those two counterexamples and nothing else.
-- Neither is a stand-in for the product: each takes a membership id rather than a server actor, raises nothing, writes
-- the ledger row the real routine would have refused, and is reachable by no request role.
--   tests.authorize_download_unlocked     case 1's fail-before: a read *without* FOR SHARE authorizes a release that a
--                                         concurrent withdrawal committed during its wait.
--   tests.authorize_download_unserialized E5D-C-F2's fail-before: the per-recipient quota counted without the advisory
--                                         lock api.authorize_download takes, so two sessions at 199 both count 199 and
--                                         both insert, leaving 201 authorizations where the ceiling is 200.
--
-- The four conditions of E3 design 1.4, all commitments:
--   1. Applied by the test harness as the database owner. No migration installs it, so it does not exist in a deployed
--      database; tests/e3/unit/migration-text.test.mjs refuses a migration that creates a tests schema.
--   2. It lives in a tests schema this file creates, with every privilege revoked from public.
--   3. Nothing is granted to app_server or authenticated.
--   4. tests/db/22-review-grants.sh (case 50) probes both roles reaching it, records the refusal, and asserts that
--      to_regproc('tests.authorize_download') is null, so the retirement is checked rather than assumed.
--
-- The barrier uses the single-key bigint advisory space (pg_advisory_xact_lock(bigint) through hashtext's implicit
-- widening). api.authorize_download's own quota lock uses the two-integer space, so the two cannot collide.
create schema if not exists tests;
revoke all on schema tests from public;

create or replace function tests.authorize_download_unlocked(p_release uuid, p_membership uuid,
  p_barrier text default null)
returns text
language plpgsql set search_path = '' as $$
declare
  rel_company uuid;
  rel_state text;
begin
  -- The mutation: the release is read with no row lock at all, so nothing makes a concurrent withdrawal wait and
  -- nothing re-evaluates the predicate after it commits.
  select r.company_id, r.state into rel_company, rel_state
    from app.releases r
   where r.id = p_release and r.state = 'published' and r.superseded_by_release_id is null;
  if not found then
    return 'E_RELEASE_WITHDRAWN';
  end if;
  if p_barrier is not null then
    perform pg_advisory_xact_lock(hashtext(p_barrier));
  end if;
  insert into app.release_downloads (company_id, release_id, membership_id)
  values (rel_company, p_release, p_membership);
  return 'authorized';
end $$;
revoke all on function tests.authorize_download_unlocked(uuid, uuid, text) from public;

create or replace function tests.authorize_download_unserialized(p_release uuid, p_membership uuid,
  p_barrier text default null)
returns text
language plpgsql set search_path = '' as $$
declare
  rel_company uuid;
  n integer;
begin
  select r.company_id into rel_company
    from app.releases r
   where r.id = p_release and r.state = 'published' and r.superseded_by_release_id is null
     for share;
  if not found then
    return 'E_RELEASE_WITHDRAWN';
  end if;
  -- The mutation: the count is read with no serialization of this (release, membership) pair, which is what the
  -- accepted routine's pg_advisory_xact_lock provides.
  select count(*) into n from app.release_downloads d
   where d.release_id = p_release and d.membership_id = p_membership;
  if p_barrier is not null then
    perform pg_advisory_xact_lock(hashtext(p_barrier));
  end if;
  if n >= app.limit_downloads_per_recipient() then
    return 'E_DOWNLOAD_LIMIT';
  end if;
  insert into app.release_downloads (company_id, release_id, membership_id)
  values (rel_company, p_release, p_membership);
  return 'authorized';
end $$;
revoke all on function tests.authorize_download_unserialized(uuid, uuid, text) from public;
