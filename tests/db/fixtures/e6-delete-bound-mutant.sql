-- E6 deletion bound mutant (docs/e6/design.md 1.6 and section 5 case 29). TEST ONLY.
--
-- app.limit_delete_rows() lowered to 100, so a company a probe can build in seconds is over it. The real number is
-- 500,000 and it is a TRANSACTION-DURATION bound rather than a storage one, so seeding half a million rows to see
-- the refusal would cost minutes and prove the same thing: what is under test is that the routine counts BEFORE it
-- deletes and that a refusal leaves every row in place.
-- This is the one fixture that replaces a constant rather than a routine, so it is written out instead of
-- substituted.
create or replace function app.limit_delete_rows() returns integer
language sql immutable parallel safe set search_path = '' as $$ select 100 $$;
