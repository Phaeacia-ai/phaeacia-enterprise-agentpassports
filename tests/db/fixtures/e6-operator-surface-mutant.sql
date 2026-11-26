-- E6 operator-surface mutant (docs/e6/design.md 1.1 and section 5 case 5). TEST ONLY, a counterexample only.
--
-- app.operator_company_row with ONE extra field, an array of the company's agent and group names, and nothing else
-- changed. That is the smallest possible widening of the boundary 1.1 names, and it is exactly the widening the
-- boundary exists to refuse: a support field somebody added because a call would have been easier with it. Probe 29c
-- installs it, searches the register's whole answer for the literal names the company holds, finds them, and restores
-- the committed definition.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('app.operator_company_row(app.companies, boolean)',
  '    ''counts'', jsonb_build_object(',
  '    ''agent_names'', (select coalesce(jsonb_agg(a.name order by a.name), ''[]''::jsonb)
                      from app.agents a where a.company_id = c.id),
    ''group_names'', (select coalesce(jsonb_agg(g.name order by g.name), ''[]''::jsonb)
                      from app.groups g where g.company_id = c.id),
    ''counts'', jsonb_build_object(');
