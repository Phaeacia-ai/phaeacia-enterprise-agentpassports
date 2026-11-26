-- E6 transfer branch-order mutant (docs/e6/design.md 2.3 B7 and section 5 case 13). TEST ONLY, a counterexample only.
--
-- api.transfer_agent with its two retry branches in the OTHER ORDER: the stale-retry guard above the honest retry.
-- With that order an honest retry, the same call twice, meets E_OWNER_CHANGED (because the owner is now the target
-- and p_expected_owner still names the previous one), and an orphaned agent whose owner column already names the
-- target is answered changed: false and left orphaned, which is the un-orphaning E4 3.2 promised E6's transfer would
-- do. Nothing else about the routine changes.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('api.transfer_agent(uuid, uuid, uuid)',
  '  if a.owner_membership_id = p_to_membership and a.status = ''active'' then      -- the honest retry, FIRST
    return query select a.id, a.owner_membership_id, a.status, false; return;
  end if;
  if a.owner_membership_id <> p_expected_owner then                            -- the stale retry
    raise exception ''E_OWNER_CHANGED'' using errcode = ''P0001'';
  end if;',
  '  if a.owner_membership_id <> p_expected_owner then
    raise exception ''E_OWNER_CHANGED'' using errcode = ''P0001'';
  end if;
  if a.owner_membership_id = p_to_membership then
    return query select a.id, a.owner_membership_id, a.status, false; return;
  end if;');
