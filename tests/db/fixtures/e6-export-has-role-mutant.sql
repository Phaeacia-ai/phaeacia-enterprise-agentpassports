-- E6 export authority mutant, arm 1 (docs/e6/design.md 1.6, 3.1 note 2 and section 5 case 23). TEST ONLY.
--
-- app.export_admin written on app.has_role instead of on its own membership read. app.has_role joins
-- app.companies with c.status = 'active' (001), so it is FALSE for the administrator of a suspended company, which
-- is exactly the person the fourteen-day export window exists for. The refusal is E_NOT_FOUND, so the window is
-- taken away silently rather than explained. Nothing else about the routine changes.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('app.export_admin(uuid)',
  '  select * into m from app.memberships
   where memberships.company_id = p_company and user_id = actor and status = ''active'';
  if m.id is null then raise exception ''E_NOT_FOUND'' using errcode = ''P0002''; end if;',
  '  if not app.has_role(p_company, ''company_admin'') then
    raise exception ''E_NOT_FOUND'' using errcode = ''P0002'';
  end if;
  select * into m from app.memberships
   where memberships.company_id = p_company and user_id = actor and status = ''active'';
  if m.id is null then raise exception ''E_NOT_FOUND'' using errcode = ''P0002''; end if;');
