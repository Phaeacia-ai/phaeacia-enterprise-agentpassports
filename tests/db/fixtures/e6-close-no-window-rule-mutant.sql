-- E6 closure window mutant (docs/e6/design.md 1.6, E6D-C-F3 and section 5 case 40). TEST ONLY.
--
-- api.close_company WITHOUT its export-window rule. Closure makes every read refuse, the export included, so an
-- operator who suspends and closes on day 57 has taken away thirteen of the fourteen days the agreement promises, and
-- nothing in the first version of this routine noticed. With the rule, a closure while export_by is still ahead needs
-- p_reason_code = 'customer_instruction'; without it, any admissible code closes the company silently.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('api.close_company(uuid, text, text)',
  '  if window_open and p_reason_code <> ''customer_instruction'' then
    raise exception ''E_EXPORT_WINDOW_OPEN'' using errcode = ''P0001'';
  end if;',
  '');
