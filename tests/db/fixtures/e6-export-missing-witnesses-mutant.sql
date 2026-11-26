-- E6 export completeness mutant, arm 1 (docs/e6/design.md 1.6 and section 5 case 24). TEST ONLY.
--
-- api.export_company with the installation_witnesses section removed. An export that is short one section is the
-- failure case 24's count comparison exists for, and it is the one a reviewer would not see by reading the routine,
-- because twenty sections look like twenty-one.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('api.export_company(uuid)',
  '    ''installation_witnesses'', (select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from
      (select id, company_id, report_id, release_id, witness_membership_id, witness_role, status, note,
              witnessed_at from app.installation_witnesses where company_id = c.id
        order by witnessed_at, id) x),',
  '');
