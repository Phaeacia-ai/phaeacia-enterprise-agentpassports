-- E6 succession seat mutant (docs/e6/design.md 1.3, 1.7, E6D-C-F5 and section 5 case 31d). TEST ONLY.
--
-- api.accept_invitation's authoritative seat check WITHOUT its one named exception. The exception is the operator's
-- succession invitation and it is worth exactly one seat: without it, the rescue of a company whose sole member is a
-- locked-out administrator issues a link nobody can accept, which is what case 31 promised and the design's first
-- version did not deliver. Nothing else about the routine changes.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('api.accept_invitation(text)',
  '    seat_bonus := case when inv.created_by_operator is not null
                            and ''company_admin'' = any (inv.roles) then 1 else 0 end;',
  '    seat_bonus := 0;');
