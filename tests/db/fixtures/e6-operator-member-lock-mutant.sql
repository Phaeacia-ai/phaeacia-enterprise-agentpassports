-- E6 operator lock mutant (docs/e6/design.md 1.5 and section 5 case 35). TEST ONLY.
--
-- api.set_access_period back on app.lock_company, which is the trap app.lock_company_operator exists for: on the
-- member-facing lock an operator cannot EXTEND an agreement that has already expired, because the routine meets its
-- own new refusal on the way in. The same mutation applied to the other seven operator routines makes a suspended
-- company unable to gain an administrator and a closed one unable to be deleted; this fixture takes the one arm case
-- 35 observes, and tests/e6/unit pins which routine calls which helper for all eight. Nothing else changes.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('api.set_access_period(uuid, text, timestamptz, timestamptz)',
  '  c := app.lock_company_operator(p_company);',
  '  perform app.lock_company(p_company);
  select * into c from app.companies where id = p_company;');
