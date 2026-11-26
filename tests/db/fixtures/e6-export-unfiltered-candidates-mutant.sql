-- E6 export filter mutant (docs/e6/design.md 1.6, E6D-C-F1b and section 5 case 24). TEST ONLY.
--
-- api.export_company with the candidate filter removed: every candidate_versions row of the company is emitted,
-- including another author's unsubmitted draft, which E1 section 6's matrix row "Read another person's draft: no"
-- and app.candidate_visible_to (003) expressly deny for every role including company_admin. The design's first
-- version said the admin already sees every candidate, and that was false. With the filter gone the withheld object
-- loses its candidate_versions entry too, so the document then claims to be the whole tenant.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('api.export_company(uuid)',
  'where v.company_id = c.id and app.export_candidate_visible(v.id, me.id)',
  'where v.company_id = c.id');
