-- E6 export completeness mutant, arm 2 (docs/e6/design.md 1.6, E5 1.7 item 1 and section 5 case 24). TEST ONLY.
--
-- api.export_company with the release_downloads section removed. E5 1.7 item 1 is the accepted handoff that the
-- export must carry release_downloads, installation_reports and installation_witnesses; this arm is the one that
-- breaks it, and the count comparison of case 24 is what notices.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('api.export_company(uuid)',
  '    ''release_downloads'', (select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from
      (select id, company_id, release_id, membership_id, authorized_at from app.release_downloads
        where company_id = c.id order by authorized_at, id) x),',
  '');
