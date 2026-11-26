-- E6 lock_company mutant (docs/e6/design.md 1.5 and section 5 case 19). TEST ONLY, a counterexample only.
--
-- app.lock_company WITHOUT its access-period test and nothing else changed: the state before this slice, in which
-- every company-scoped mutation into a company whose agreement ended last week is accepted. One test in one place
-- covers invitations, roles, removal, groups, drafts, submissions, successors, envelopes, reviews, publication,
-- withdrawal, reports and witnesses, so removing it admits all of them, and probe 29i observes one.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('app.lock_company(uuid)',
  '  if exists (select 1 from app.access_periods p
              where p.company_id = p_company and p.ends_at <= clock_timestamp()) then
    raise exception ''E_ACCESS_PERIOD_ENDED'' using errcode = ''P0001'';
  end if;',
  '');
