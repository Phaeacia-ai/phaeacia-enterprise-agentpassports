-- E6 disjointness mutant (docs/e6/design.md 1.1, E6D-C-F1c and section 5 case 39). TEST ONLY, a counterexample only.
--
-- api.accept_invitation WITHOUT its E_OPERATOR_ACCOUNT refusal and nothing else changed, so an operator's account
-- can be given a membership: the dual principal that defeats the whole operator boundary, because the same person
-- then reads tenant content as a member and the register as an operator and no predicate anywhere notices.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
--
-- TWO substitutions since E6S-C-F1, because the rule now lives in two places in this routine: once under the
-- account lock before the invitation is located, and once again after the company-lock wait. The counterexample
-- this fixture is for is the SEQUENTIAL crossing of case 39, where an operator account simply accepts an
-- invitation, so both copies have to go; the concurrent crossing and the account lock itself are probe 31's
-- section 31f. The first substitution takes the lock line with it, which is what makes its anchor unique: the
-- second copy has no app.lock_account line before it.
select tests.e6_mutate('api.accept_invitation(text)',
  '  perform app.lock_account(actor);
  perform app.require_disjoint_principal(actor, ''member'');',
  '');
select tests.e6_mutate('api.accept_invitation(text)',
  '  perform app.require_disjoint_principal(actor, ''member'');',
  '');
