-- E6 export inline-isolation mutant (docs/e6/design.md 2.5, E6D-C-F9 and section 5 case 24). TEST ONLY.
--
-- api.export_company with `set transaction isolation level repeatable read` as its first statement, which is the
-- design's first version. PostgreSQL chooses a transaction's isolation BEFORE its first query, and an RPC is already
-- executing its SELECT when the function body begins, so the statement is refused with SQLSTATE 25001,
-- "SET TRANSACTION ISOLATION LEVEL must be called before any query". Nothing else about the routine changes, and the
-- function's own setting is left in place, so this arm shows the inline statement failing rather than the snapshot
-- being absent.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('api.export_company(uuid)',
  '  select * into c from app.companies where id = p_company;',
  '  set transaction isolation level repeatable read;
  select * into c from app.companies where id = p_company;');
