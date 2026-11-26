-- E6 my_standing mutant (docs/e6/design.md 1.1, 2.3 B11 and section 5 case 4). TEST ONLY, a counterexample only.
--
-- app.my_standing WITHOUT its auth.uid() predicate, and nothing else changed. The view above it is
-- security_invoker, so it runs as the caller and the function behind it is SECURITY DEFINER: every predicate that
-- scopes the read lives inside the function, so dropping this one makes every authenticated caller read every active
-- membership of every company. That is the counterexample case 4's control has to see fail.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('app.my_standing()',
  'where m.user_id = (select auth.uid()) and m.status = ''active''',
  'where m.status = ''active''');
