-- E6 transfer NULL-standing mutant (docs/e6/design.md 2.3 B7, 2.5, E6D-C-F2 and section 5 case 36). TEST ONLY.
--
-- api.transfer_agent with the `me.id is null` refusal REMOVED, which is the design's first version. In SQL and in
-- PL/pgSQL `NULL = x` is NULL, `not (NULL)` is NULL, and `if NULL then ... end if` DOES NOT RUN, so a caller whose
-- membership was removed while the company lock was waited on produces `not (NULL = a.owner_membership_id and ...)`,
-- which is NULL, app.require_admin is never called, and the transfer succeeds for a person who is no longer a member
-- of the company. That is the whole of the finding, and it is why every E6 routine that reads a principal into a
-- record refuses `... is null` on its own line before any comparison uses it.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('api.transfer_agent(uuid, uuid, uuid)',
  '  if me.id is null then raise exception ''E_NOT_FOUND'' using errcode = ''P0002''; end if;',
  '');
