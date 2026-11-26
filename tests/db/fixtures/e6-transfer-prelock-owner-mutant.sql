-- E6 transfer pre-lock owner mutant (docs/e6/design.md 2.3 B7, 3.5, E6D-C-F2 and section 5 case 37). TEST ONLY.
--
-- api.transfer_agent authorizing from the agent row it read BEFORE waiting for the company lock, which is the
-- design's first version. The owner arm then passes for a FORMER owner whose agent somebody else has since
-- transferred: her pre-lock copy still names her, so she takes the agent back and E_OWNER_CHANGED is never reached.
-- The mutant keeps the locked re-read in place and only moves which row the decision is made from, so the
-- counterexample is about the moment the authority is read and nothing else. p_expected_owner is not authority in
-- either version: it is the caller's own input and only a stale-retry guard.
-- Applied through tests/db/fixtures/e6-mutate.sql, so the body is the LIVE one and a moved anchor raises.
select tests.e6_mutate('api.transfer_agent(uuid, uuid, uuid)',
  '  select * into a from app.agents g where g.id = p_agent for update;           -- level 4
  if a.id is null then raise exception ''E_NOT_FOUND'' using errcode = ''P0002''; end if;',
  '  declare pre_owner uuid := a.owner_membership_id; pre_status text := a.status;
  begin
    select * into a from app.agents g where g.id = p_agent for update;
    if a.id is null then raise exception ''E_NOT_FOUND'' using errcode = ''P0002''; end if;
    a.owner_membership_id := pre_owner;
    a.status := pre_status;
  end;');
