-- E6 deletion date mutant (docs/e6/design.md 1.6, E6D-C-F3 and section 5 case 40). TEST ONLY.
--
-- api.delete_company with its precondition back on DELETE_BY, which is the design's first version. The plan requires
-- tenant content deleted BETWEEN export_by and delete_by, so a routine that refuses until delete_by makes every legal
-- deletion either impossible (before that instant) or late (after it): on the plan's example numbers a deletion on
-- day 99 was refused and only day 100 onwards was admitted, with no completion deadline after that at all.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('api.delete_company(uuid, text, text)',
  'where p.company_id = c.id and p.export_by <= clock_timestamp())',
  'where p.company_id = c.id and p.delete_by <= clock_timestamp())');
