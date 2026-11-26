-- E6 my_standing access-state mutant (docs/e6/design.md 1.5, 2.3 B11 and section 5 case 38). TEST ONLY.
--
-- app.my_standing with its access_state column computed from the COMPANY'S STATUS instead of from time, which is the
-- design's first version: a company past export_by that no sweep has touched is still `active`, so the read boundary
-- never closes and loadPrincipal has nothing to refuse on. A window whose end is a status a person sets is not a
-- window. Nothing else about the function changes.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('app.my_standing()',
  'app.access_state(c.id)',
  'case when c.status = ''active'' then ''current'' else ''expired'' end');
