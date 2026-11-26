-- E6 export isolation reader (docs/e6/design.md 1.6, 2.5, E6D-C-F9 and section 5 case 24). TEST ONLY.
--
-- api.export_company with ONE key added to its answer, observed_isolation, read with
-- current_setting('transaction_isolation') from inside the routine's own body. This is how F9's code-review
-- obligation is met: proving that PostgREST applies the function's own default_transaction_isolation to the
-- transaction it opens is a fact about the REAL RPC and not about the migration text, so it is read from inside the
-- real call rather than asserted from pg_proc.proconfig alone (which probe 30b asserts as well).
-- With the setting in force the read answers `repeatable read`; with it reset it answers `read committed`, which is
-- the second fail-before of case 24. Nothing else about the routine changes.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('api.export_company(uuid)',
  '    ''omitted'', to_jsonb(array[''invitations.token_hash''',
  '    ''observed_isolation'', current_setting(''transaction_isolation''),
    ''omitted'', to_jsonb(array[''invitations.token_hash''');
