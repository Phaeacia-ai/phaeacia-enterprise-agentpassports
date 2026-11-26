-- E6 export authority mutant, arm 2 (docs/e6/design.md 1.6, E6D-C-F1a and section 5 case 23). TEST ONLY.
--
-- app.export_admin with the design's FIRST VERSION restored: an operator arm above the admin test, so an operator at
-- aal2 receives the whole company. That is every candidate's content, every member's address and display name, every
-- review reason and every installation report: the exact opposite of the operator boundary, through a second door
-- that app.operator_company_row's counts-only line cannot constrain because it is not in the path.
-- An operator holds no membership, and api.export_company's audit row names one, so the mutant's operator arm hands
-- back the company's own first administrator: that is what the first version's shape amounted to, and it keeps the
-- counterexample about the DOOR rather than about an audit key. Nothing else about the routine changes.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('app.export_admin(uuid)',
  '  select * into m from app.memberships
   where memberships.company_id = p_company and user_id = actor and status = ''active'';',
  '  if exists (select 1 from app.operators o where o.user_id = actor) then
    select * into m from app.memberships
     where memberships.company_id = p_company and status = ''active''
       and ''company_admin'' = any (roles) limit 1;
    return m;
  end if;
  select * into m from app.memberships
   where memberships.company_id = p_company and user_id = actor and status = ''active'';');
