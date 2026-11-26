-- E6 deletion-bypass mutant (docs/e6/design.md 1.6 and section 5 case 26). TEST ONLY.
--
-- app.report_append_only with the bypass line written WITHOUT its tg_op = 'DELETE' test, which is the mistake the
-- twelve replacements exist to avoid: `if current_setting(...) = 'on' then return old; end if;` admits an owner-side
-- UPDATE and a TRUNCATE under the flag as well as a DELETE, so a careless maintenance command inside a deletion
-- transaction could rewrite evidence rather than remove them. The bypass must open DELETE only, which is narrower
-- than app.registry_migration's. Nothing else about the function changes.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('app.report_append_only()',
  'if tg_op = ''DELETE'' and current_setting(''app.tenant_deletion'', true) = ''on'' then return old; end if;',
  'if current_setting(''app.tenant_deletion'', true) = ''on'' then return coalesce(new, old); end if;');
