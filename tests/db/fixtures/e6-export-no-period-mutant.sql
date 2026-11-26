-- E6 export access-period mutant (docs/e6/design.md 1.5, 1.6 and section 5 cases 23 and 38). TEST ONLY.
--
-- api.export_company WITHOUT its own access-period test and nothing else changed. It is the one company-scoped route
-- that loads no principal, so the read boundary of 1.5 lives in the routine itself: remove it and a company years
-- past its export_by is still exported by its administrator, which is the fourteen-day window never closing
-- (E6D-C-F3). Probe 29j and probe 29m each observe it.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('api.export_company(uuid)',
  '  if exists (select 1 from app.access_periods p
              where p.company_id = c.id and p.export_by <= clock_timestamp()) then
    raise exception ''E_ACCESS_PERIOD_ENDED'' using errcode = ''P0001'';
  end if;',
  '');
