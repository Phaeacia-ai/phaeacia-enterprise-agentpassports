-- E6 export gate mutant (docs/e6/design.md 1.6, E6D-C-F8 and section 5 case 25). TEST ONLY.
--
-- api.export_company with GATE 2 removed, so only the cheap estimate from the two byte sums bounds the answer. The
-- estimate is over the STORED content, and a company's history sections (audit rows, downloads, reports,
-- memberships) grow with time and with people and not with agents, so a company holding no content at all can carry
-- a serialized document far over the ceiling while gate 1 passes. That is the escaping and the history the first
-- version's 64 MiB arithmetic did not count, and the body it answers could never have left the function.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('api.export_company(uuid)',
  '  n_bytes := octet_length(doc::text);
  if n_bytes > app.limit_export_bytes() then
    raise exception ''E_EXPORT_TOO_LARGE'' using errcode = ''P0001'';
  end if;',
  '  n_bytes := octet_length(doc::text);');
