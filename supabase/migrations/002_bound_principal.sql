-- 002_bound_principal.sql
-- E3 design section 2.6 item 1: a bound server bearer reaches no E2 function. Lead-owned and
-- additive: it adds app.app_server_subject(), replaces app.server_actor(), and edits nothing in
-- 001_identity.sql. 001 is applied, and the migration ledger records a version, not the file's
-- bytes, so a refusal written into 001 would reach only a database built from scratch and never
-- one that had already recorded 001. As its own number it reaches every database on its next
-- migration.
--
-- app.app_server_subject() refuses unless the token's role is app_server and carries a uuid sub.
-- app.server_actor() is that rule plus the refusal of a token carrying an fn claim:
-- lib/db/server.mjs binds an E3 content bearer with fn, args_sha256 and jti, and a bound bearer
-- must reach no function that calls app.server_actor(), which is every E2 api function, directly
-- or through app.operator_actor(). The refusal is the claim's presence, not its value, so fn
-- naming an E2 function, or fn null, is refused too. E3's app.bound_actor() is the same subject
-- rule plus its binding checks: one body, two doors, so the role and subject rules cannot drift
-- between them.
--
-- create or replace keeps app.server_actor()'s owner and the execute revoke 001 already applied,
-- so the one revoke below is for the new helper, matching what 001 revokes for its siblings.

create or replace function app.app_server_subject() returns uuid
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

create or replace function app.server_actor() returns uuid
language plpgsql stable set search_path = '' as $$
declare
  actor uuid := app.app_server_subject();
begin
  if app.jwt_claims() ? 'fn' then
    raise exception 'E_NOT_SERVER' using errcode = '42501';
  end if;
  return actor;
end $$;

revoke execute on function app.app_server_subject() from public;
