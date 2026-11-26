-- E6 mutant installer (the assignment's rule: mutants are owner-only fixtures under tests/db/fixtures/ and never a
-- line of the migration). TEST ONLY.
--
-- app.e6_mutate takes a routine, an anchor and its replacement, reads the routine's LIVE definition with
-- pg_get_functiondef and executes it with exactly that substitution. Two reasons it works this way rather than each
-- fixture carrying a hand-copied body: a copied body drifts from the migration silently, so a fail-before could be
-- failing for a reason the real routine no longer has (evidence/m004.md lesson 6 is the same lesson for the E4
-- mutants); and an anchor that no longer exists RAISES, so a mutation the migration has moved is a loud failure and
-- not a probe that passes on nothing. tests/db/e4-lib.sh's mutant() is the same idea in bash.
--
-- It lives in a tests schema this file creates, with every privilege revoked from public and nothing granted to
-- app_server or authenticated, which is the shape tests/db/fixtures/e5-download-mutant.sql established. Each probe
-- installs a mutant inside its own step and restores the committed definition it saved first (tests/db/e6-lib.sh
-- save_routine).
create schema if not exists tests;
revoke all on schema tests from public;

create or replace function tests.e6_mutate(p_routine text, p_from text, p_to text) returns void
language plpgsql set search_path = '' as $$
declare
  def text;
begin
  def := pg_get_functiondef(p_routine::regprocedure);
  if position(p_from in def) = 0 then
    raise exception 'e6_mutate: anchor not found in %: %', p_routine, left(p_from, 60);
  end if;
  execute replace(def, p_from, p_to);
end $$;
revoke all on function tests.e6_mutate(text, text, text) from public;
