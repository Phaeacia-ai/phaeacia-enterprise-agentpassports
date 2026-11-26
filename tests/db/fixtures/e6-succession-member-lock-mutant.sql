-- E6 succession lock mutant (docs/e6/design.md 1.3, 1.5, E6D-C-F5 and section 5 cases 31 and 35). TEST ONLY.
--
-- api.transfer_first_admin back on app.lock_company, which is where 001 had it and where E6D-C-F5 found it. On the
-- member-facing lock the routine cannot grant an administrator to a SUSPENDED company (E_COMPANY_INACTIVE) or to one
-- past its access period (E_ACCESS_PERIOD_ENDED), and those are exactly the two states in which a customer asks for
-- one, so succession becomes impossible precisely when it is needed. Nothing else about the routine changes.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('api.transfer_first_admin(uuid, uuid)',
  '  c := app.lock_company_operator(p_company);
  if c.status = ''closed'' then
    raise exception ''E_COMPANY_CLOSED'' using errcode = ''P0001'';
  end if;',
  '  perform app.lock_company(p_company);
  select * into c from app.companies where id = p_company;');
