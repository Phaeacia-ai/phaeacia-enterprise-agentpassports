-- 011_invitation_standing.sql. ENA-7 and END-1 of the security review of 2026-09-30
-- (evidence/security-review-2026-09-30.md; design and record evidence/ena7-end1-hbf2.md, sections 1, 2 and 5).
--
-- ENA-7. In handover mode the server handed the inviting administrator a link carrying a GoTrue sign-in token for the
-- invited address, whatever account that address already had: any company administrator could sign in as any
-- existing account, the operator's included. This file adds the database's half of the fix: the CLAIM, which decides
-- under a per-address lock whether this invitation's caller may be handed a signing link at all (an unclaimed account,
-- and no other company's live invitation already claimed for the address), and the operator's address refused at
-- invite time. lib/services/invitations.mjs makes no GoTrue call unless the claim is granted.
--
-- END-1. A removed or demoted administrator kept the invitations they had issued, up to 30 days, and could come back
-- as administrator with one. Here: the issuer's pending invitations are revoked when they are removed or lose
-- company_admin (api.remove_member, api.set_roles, and api.accept_invitation's self-demotion), and acceptance refuses
-- an administrator's invitation whose issuer no longer stands.
--
-- WHAT IS REPLACED: four routines, each copied forward from its latest definition (008 for api.invite_member and
-- api.accept_invitation, 001 for api.set_roles, 006 for api.remove_member) and changed only where a comment names
-- 011. create or replace keeps each routine's grants. WHAT IS NEW: one column, one helper, one api routine with its
-- grants. No policy changes: invitations_admin_read decides who reads app.invitations, and the new column is granted
-- to nobody, so no application read can see it.
--
-- THE RECONCILER. lib/operator/reconcile.mjs's C3 and C7 mirror api.remove_member's and api.set_roles's writes and do
-- not mirror the revocation: C5 revokes every pending invitation at a restore, whatever the register says, so a
-- restored company holds no invitation a removed issuer could use (tests/e7/unit/reconcile-text.test.mjs names this
-- as C3's second named difference).

-- ---------------------------------------------------------------------------
-- 1. The claim's column. Null until a signing link is claimed for the invitation. Every invitation pending when this
--    file runs is stamped with its created_at, the moment its link was made: whether that link was a signing one
--    cannot be known here, so it is treated as one. The claim (3) counts another company's stamp only while a link
--    made then could still sign in, so a backfilled row holds another company back for at most that long after its
--    creation and gives no lasting precedence (CR-ENA7-4).
-- ---------------------------------------------------------------------------
alter table app.invitations add column handover_claimed_at timestamptz;
update app.invitations set handover_claimed_at = created_at
 where accepted_at is null and revoked_at is null;

-- ---------------------------------------------------------------------------
-- 2. END-1's helper. The issuer's pending invitations, revoked in one statement, with one audit row each naming the
--    issuer as membership_id and the acting administrator as previous_admin_membership_id (absent when the issuer
--    demoted themselves). Callers hold app.lock_company and the issuer's membership row already; the invitation rows
--    are locked by the update, last, which is design 2.5's order.
-- ---------------------------------------------------------------------------
create or replace function app.revoke_issued_invitations(p_company uuid, p_issuer uuid, p_actor uuid,
  p_actor_membership uuid, p_reason text) returns integer
language plpgsql set search_path = '' as $$
declare
  revoked uuid[];
  i uuid;
begin
  with gone as (
    update app.invitations iv set revoked_at = now()
     where iv.company_id = p_company and iv.created_by = p_issuer
       and iv.accepted_at is null and iv.revoked_at is null
    returning iv.id)
  select coalesce(array_agg(g.id order by g.id), '{}'::uuid[]) into revoked from gone g;
  foreach i in array revoked loop
    perform app.audit(p_company, p_actor, 'member', 'invitation.revoke', 'invitation', i,
      jsonb_build_object('invitation_id', i, 'membership_id', p_issuer, 'reason_code', p_reason)
      || case when p_actor_membership is null then '{}'::jsonb
              else jsonb_build_object('previous_admin_membership_id', p_actor_membership) end);
  end loop;
  return cardinality(revoked);
end $$;
revoke all on function app.revoke_issued_invitations(uuid, uuid, uuid, uuid, text) from public;

-- ---------------------------------------------------------------------------
-- 3. ENA-7's claim. True, and the invitation stamped, only when all of these hold:
--      the caller issued the invitation (the issuing membership's account, or the issuing operator);
--      it is pending and unexpired;
--      the address has no account, or one that is unconfirmed with no membership, no operator row and no factor;
--      the company is active, or, for an invitation the operator issued, not closed (the doors that made it:
--      api.invite_member, which a resend also calls, takes app.lock_company, which admits active only, and the
--      operator's two admit a held or suspended company on purpose);
--      no other company claimed a signing link for the same address within the last SIGNING_LIFE.
--    False in every other case, including an unknown id, so the service's answer for a refusal is the code-only link
--    and never an error that loses the caller the invitation's ids.
--    SIGNING_LIFE (CR-ENA7-1). A signing link lives for GoTrue's otp_expiry, 3600 seconds (supabase/config.toml, and
--    the first-deploy table), counted from its minting, which follows the claim within the same request. The five
--    minutes on top cover that request, which runs far shorter. Past that, the other company's link is dead, so a new
--    claim replaces no live credential, and an address cannot be held for the length of an invitation. The other
--    company's row counts whatever its state now: a link handed before a revocation, a removal of its issuer or the
--    company's closure still signs in until it expires (CR-ENA7-7), and two live links for one unclaimed account is
--    what this test exists to prevent. tests/e6/unit/migration-text.test.mjs pins the interval against config.toml.
--    THE LOCKS. A per-address advisory lock, taken first and by this routine alone, serializes two companies claiming
--    one address, so at most one wins. Then the company's row, status-free (app.lock_company_operator, so the status
--    test above can tell the operator's invitations from an administrator's), then this invitation's row, which is
--    design 2.5's company-then-invitation order. No routine takes the advisory lock while holding any other, so it
--    cannot be part of a cycle. The company lock also keeps E7S-F1 true: every member-facing api routine that writes
--    company rows takes it (tests/db/32-recovery-hold.sh, END1-CR-F2).
-- ---------------------------------------------------------------------------
create or replace function api.claim_invitation_handover(p_invitation uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  inv app.invitations;
  co app.companies;
  acct uuid;
  acct_confirmed timestamptz;
  signing_life constant interval := interval '65 minutes';
begin
  select * into inv from app.invitations i where i.id = p_invitation;
  if inv.id is null then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtext('app.invitation_handover'), hashtext(inv.email_normalized));
  co := app.lock_company_operator(inv.company_id);
  select * into inv from app.invitations i where i.id = p_invitation for no key update;
  if co.status = 'closed' or (inv.created_by is not null and co.status <> 'active') then
    return false;
  end if;
  if not (
       exists (select 1 from app.memberships m
                where m.id = inv.created_by and m.user_id = actor and m.status = 'active')
       or (inv.created_by_operator is not null and inv.created_by_operator = actor)) then
    return false;
  end if;
  if inv.accepted_at is not null or inv.revoked_at is not null or inv.expires_at <= clock_timestamp() then
    return false;
  end if;
  select u.id, u.email_confirmed_at into acct, acct_confirmed
    from auth.users u where lower(u.email) = inv.email_normalized;
  if acct is not null and (
       acct_confirmed is not null
       or exists (select 1 from app.memberships m where m.user_id = acct)
       or exists (select 1 from app.operators o where o.user_id = acct)
       or exists (select 1 from auth.mfa_factors f where f.user_id = acct)) then
    return false;
  end if;
  if exists (select 1 from app.invitations o
              where o.email_normalized = inv.email_normalized and o.company_id <> inv.company_id
                and o.handover_claimed_at > clock_timestamp() - signing_life) then
    return false;
  end if;
  update app.invitations i set handover_claimed_at = clock_timestamp() where i.id = inv.id;
  return true;
end $$;
revoke execute on function api.claim_invitation_handover(uuid) from public, anon, authenticated, service_role;
grant execute on function api.claim_invitation_handover(uuid) to app_server;

-- ---------------------------------------------------------------------------
-- 4. The four routines, copied forward. Each changes only where a comment names 011.
-- ---------------------------------------------------------------------------

create or replace function api.invite_member(p_company uuid, p_email text, p_roles text[],
  p_expires_in interval default interval '7 days')
returns table (invitation_id uuid, invite_code text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  admin app.memberships;
  email_n text := lower(btrim(p_email));
  roles_n text[];
  tok bytea;
  inv app.invitations;
  replaced uuid;
begin
  perform app.require_standing(p_company, actor);
  perform app.lock_company(p_company);
  admin := app.require_admin(p_company, actor);
  roles_n := app.normalize_roles(p_roles);
  if p_expires_in is null or p_expires_in <= interval '0' or p_expires_in > interval '30 days' then
    raise exception 'E_EXPIRY_INVALID' using errcode = '22023';
  end if;
  if exists (select 1 from app.memberships m where m.company_id = p_company and m.status = 'active'
             and m.user_id = (select u.id from auth.users u where lower(u.email) = email_n)) then
    raise exception 'E_ALREADY_MEMBER' using errcode = 'P0001';
  end if;
  -- ENA-7 (011, D3): an address that belongs to an operator account is refused HERE, as api.create_company refuses
  -- it for the operator's own path, and not only at acceptance. Until 011 the invitation was made and its link,
  -- handed in handover mode, signed the administrator in as the operator before acceptance could refuse.
  if exists (select 1 from app.operators o join auth.users u on u.id = o.user_id where lower(u.email) = email_n) then
    raise exception 'E_OPERATOR_ACCOUNT' using errcode = 'P0001';
  end if;
  -- E6 1.7, the two new bounds. Both counts are taken NET of the pending sibling this call is about
  -- to revoke below (E6D-C-F7 settled here): replacing an invitation adds no reservation, so a resend
  -- at either ceiling was refused although the company's totals do not move. The sibling is excluded
  -- by the same address predicate the revocation uses, and the unique index invitations_one_pending
  -- means there is at most one. Both counts run under the company lock this routine already holds.
  if (select count(*) from app.invitations i
       where i.company_id = p_company and i.accepted_at is null and i.revoked_at is null
         and i.expires_at > clock_timestamp()
         and i.email_normalized <> email_n)
     >= app.quota(p_company, 'pending_invitations_per_company') then
    raise exception 'E_INVITATION_LIMIT' using errcode = 'P0001';
  end if;
  -- Seats: active memberships plus live pending invitations, DEFENSE IN DEPTH (design 3.1 labels it
  -- so). The authoritative check is in api.accept_invitation under the company lock, which is where a
  -- membership is actually created. The E_ALREADY_MEMBER test above means the target holds no active
  -- membership here. app.operator_invitation (B6) is the operator's issuing path and carries neither
  -- bound: its succession invitation's one seat of headroom is granted authoritatively at acceptance
  -- (1.3, E6D-C-F5).
  if (select count(*) from app.memberships m
       where m.company_id = p_company and m.status = 'active')
     + (select count(*) from app.invitations i
         where i.company_id = p_company and i.accepted_at is null and i.revoked_at is null
           and i.expires_at > clock_timestamp()
           and i.email_normalized <> email_n)
     >= app.quota(p_company, 'members_per_company') then
    raise exception 'E_SEATS_EXHAUSTED' using errcode = 'P0001';
  end if;
  -- One pending invitation per email per company (unique index invitations_one_pending):
  -- revoke the pending sibling first; its audit row is written below with the new id.
  update app.invitations set revoked_at = now()
  where company_id = p_company and email_normalized = email_n
    and accepted_at is null and revoked_at is null
  returning id into replaced;
  tok := extensions.gen_random_bytes(32);
  insert into app.invitations (company_id, email_normalized, token_hash, roles, expires_at, created_by)
  values (p_company, email_n, extensions.digest(tok, 'sha256'), roles_n, now() + p_expires_in, admin.id)
  returning * into inv;
  if replaced is not null then
    perform app.audit(p_company, actor, 'member', 'invitation.revoke', 'invitation', replaced,
      jsonb_build_object('invitation_id', replaced, 'membership_id', admin.id,
                         'reason_code', 'replaced', 'replaced_by_invitation_id', inv.id));
  end if;
  perform app.audit(p_company, actor, 'member', 'invitation.create', 'invitation', inv.id,
    jsonb_build_object('invitation_id', inv.id, 'roles', inv.roles, 'expires_at', inv.expires_at,
                       'membership_id', admin.id)
    || case when replaced is null then '{}'::jsonb
            else jsonb_build_object('replaces_invitation_id', replaced) end);
  return query select inv.id, encode(tok, 'hex'), inv.expires_at;
end $$;

create or replace function api.accept_invitation(p_invite_code text)
returns table (membership_id uuid, company_id uuid, roles text[], reactivated boolean)
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  tok bytea;
  inv app.invitations;
  u_email text;
  u_confirmed timestamptz;
  m app.memberships;
  was_removed boolean := false;
  seat_bonus integer;
  decided_at timestamptz;
  was_roles text[];
begin
  -- E6 1.1 (E6D-C-F1c) and E6S-C-F1: operators and members are disjoint, and the rule lives where a membership
  -- is created. The ACCOUNT LOCK comes first, above every other test, so an operator's account learns nothing
  -- about a token's validity and so api.add_operator cannot make this same account an operator while this
  -- transaction waits for the company lock below. Level 0 of design 2.5's order; the argument that it cannot
  -- deadlock is at app.lock_account.
  perform app.lock_account(actor);
  perform app.require_disjoint_principal(actor, 'member');
  begin
    tok := decode(p_invite_code, 'hex');
  exception when others then
    raise exception 'E_INVITATION_INVALID' using errcode = 'P0002';
  end;
  if octet_length(tok) <> 32 then
    raise exception 'E_INVITATION_INVALID' using errcode = 'P0002';
  end if;
  -- Locate without locking, then lock the company, then re-read the invitation under lock.
  select * into inv from app.invitations where token_hash = extensions.digest(tok, 'sha256');
  if inv.id is null then
    raise exception 'E_INVITATION_INVALID' using errcode = 'P0002';
  end if;
  perform app.lock_company(inv.company_id);
  -- E6S-C-F1: the lock above is the one wait in this routine, and BOTH identities are re-read under the account
  -- lock after it. The account lock makes the second read redundant against the three doors themselves; it is
  -- here because a lock whose only proof is that nothing else takes it is a lock nobody can check, and this read
  -- is one index probe on a primary key.
  perform app.require_disjoint_principal(actor, 'member');
  select * into inv from app.invitations where id = inv.id for update;
  decided_at := clock_timestamp();
  if inv.accepted_at is not null or inv.revoked_at is not null or inv.expires_at <= decided_at then
    raise exception 'E_INVITATION_INVALID' using errcode = 'P0002';
  end if;
  -- END-1 (011, D5): an administrator's invitation stands only while its issuer does. Read on the row re-read after
  -- the company lock, so a concurrent removal or demotion of the issuer cannot slip between the two. Invitations an
  -- operator issued (created_by null) are not an administrator's and are untouched. This also refuses the rows D4
  -- cannot reach: those issued before 011 by administrators who have since left, and an issuer changed by the
  -- app_maintenance grants or by the reconciler's C3 and C7. Those rows are refused, not revoked: an issuer who is
  -- made administrator again keeps the same membership id, so such a row stands again, as it would have had the
  -- issuer never left (END1-CR-F4; evidence/ena7-end1-hbf2.md, XRR2-D4).
  if inv.created_by is not null
     and not exists (select 1 from app.memberships im
                      where im.id = inv.created_by and im.status = 'active'
                        and 'company_admin' = any (im.roles)) then
    raise exception 'E_INVITATION_INVALID' using errcode = 'P0002';
  end if;
  select lower(u.email), u.email_confirmed_at into u_email, u_confirmed from auth.users u where u.id = actor;
  if u_email is null or u_confirmed is null or u_email <> inv.email_normalized then
    raise exception 'E_EMAIL_MISMATCH' using errcode = '42501';
  end if;
  select * into m from app.memberships where memberships.company_id = inv.company_id and user_id = actor for update;
  -- E6 1.7, the AUTHORITATIVE seat check (design 3.1), only when this acceptance would ADD an active
  -- membership: a reactivation counts, an active member's role replacement does not. Two invitations
  -- accepted at once serialize on the company lock this routine already holds, so the second sees the
  -- first one's membership.
  -- The one named exception is the operator's succession invitation and it is worth EXACTLY ONE seat
  -- (1.3, E6D-C-F5): a company that has used it sits at quota + 1, so the next succession acceptance
  -- compares quota + 1 >= quota + 1 and is refused. Without this the rescue of 1.3 issues an
  -- invitation nobody can accept. The exception's authority is the operator's recorded act and not a
  -- derived state: the database cannot see whether an admin can reach aal2.
  -- The bonus is computed into a variable rather than inlined in the IF condition, which is what
  -- design 2.3 B5 wrote: PL/pgSQL ends an IF condition at the first THEN token, so a CASE expression
  -- inside one is a syntax error at end of input (E6DB-F1, reproduced at
  -- evidence/e6-db-repro/f1-accept-invitation-case-in-if.log).
  if m.id is null or m.status = 'removed' then
    seat_bonus := case when inv.created_by_operator is not null
                            and 'company_admin' = any (inv.roles) then 1 else 0 end;
    if (select count(*) from app.memberships m2
         where m2.company_id = inv.company_id and m2.status = 'active')
       >= app.quota(inv.company_id, 'members_per_company') + seat_bonus then
      raise exception 'E_SEATS_EXHAUSTED' using errcode = 'P0001';
    end if;
  end if;
  was_roles := m.roles;
  if m.id is null then
    insert into app.memberships (company_id, user_id, status, roles)
    values (inv.company_id, actor, 'active', inv.roles) returning * into m;
  elsif m.status = 'removed' then
    was_removed := true;
    update app.memberships set status = 'active', removed_at = null, roles = inv.roles
    where id = m.id returning * into m;
  else
    -- Already active: accepting a second invitation replaces roles (admin-issued), and
    -- may not demote the last admin.
    if 'company_admin' = any (m.roles) and not ('company_admin' = any (inv.roles))
       and app.active_admin_count(inv.company_id, m.id) = 0 then
      raise exception 'E_LAST_ADMIN' using errcode = 'P0001';
    end if;
    update app.memberships set roles = inv.roles where id = m.id returning * into m;
  end if;
  update app.invitations set accepted_at = decided_at, accepted_membership_id = m.id where id = inv.id;
  perform app.audit(inv.company_id, actor, 'member', 'invitation.accept', 'membership', m.id,
    jsonb_build_object('invitation_id', inv.id, 'membership_id', m.id, 'roles_after', m.roles,
                       'reactivated', was_removed), decided_at);
  -- END-1 (011, D4): an administrator who accepts an invitation without company_admin has demoted themselves,
  -- and the invitations they issued go with the role, as in api.set_roles. After the acceptance above, so the
  -- invitation being accepted, no longer pending, is never revoked with them (END1-CR-F6). Only the branch that
  -- found the membership active can demote: was_roles is null for a new membership, and a reactivation is not one.
  if 'company_admin' = any (was_roles) and not ('company_admin' = any (m.roles)) and not was_removed then
    perform app.revoke_issued_invitations(inv.company_id, m.id, actor, null, 'issuer_demoted');
  end if;
  return query select m.id, m.company_id, m.roles, was_removed;
end $$;

create or replace function api.set_roles(p_membership uuid, p_roles text[])
returns table (membership_id uuid, roles text[], changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  target app.memberships;
  admin app.memberships;
  new_roles text[];
begin
  select * into target from app.memberships where id = p_membership;
  if target.id is null then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_standing(target.company_id, actor);
  perform app.lock_company(target.company_id);
  admin := app.require_admin(target.company_id, actor);
  select * into target from app.memberships where id = p_membership for update;
  if target.status <> 'active' then
    raise exception 'E_MEMBERSHIP_REMOVED' using errcode = 'P0001';
  end if;
  new_roles := app.normalize_roles(p_roles);
  if new_roles = target.roles then
    return query select target.id, target.roles, false;
    return;
  end if;
  if 'company_admin' = any (target.roles) and not ('company_admin' = any (new_roles))
     and app.active_admin_count(target.company_id, target.id) = 0 then
    raise exception 'E_LAST_ADMIN' using errcode = 'P0001';
  end if;
  update app.memberships set roles = new_roles where id = target.id;
  perform app.audit(target.company_id, actor, 'member', 'membership.set_roles', 'membership', target.id,
    jsonb_build_object('membership_id', target.id, 'roles_before', target.roles, 'roles_after', new_roles,
                       'previous_admin_membership_id', admin.id));
  -- END-1 (011, D4): the invitations a demoted administrator issued go with the role, in this transaction.
  if 'company_admin' = any (target.roles) and not ('company_admin' = any (new_roles)) then
    perform app.revoke_issued_invitations(target.company_id, target.id, actor, admin.id, 'issuer_demoted');
  end if;
  return query select target.id, new_roles, true;
end $$;

create or replace function api.remove_member(p_membership uuid)
returns table (membership_id uuid, status text, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  target app.memberships;
  admin app.memberships;
  orphans uuid[];
  ag uuid;
  cleared uuid[];
  gr uuid;
begin
  select * into target from app.memberships where id = p_membership;
  if target.id is null then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform app.require_standing(target.company_id, actor);
  perform app.lock_company(target.company_id);
  admin := app.require_admin(target.company_id, actor);
  select * into target from app.memberships where id = p_membership for update;
  if target.status = 'removed' then
    return query select target.id, target.status, false;
    return;
  end if;
  if 'company_admin' = any (target.roles) and app.active_admin_count(target.company_id, target.id) = 0 then
    raise exception 'E_LAST_ADMIN' using errcode = 'P0001';
  end if;
  update app.memberships set status = 'removed', removed_at = now() where id = target.id;
  perform app.audit(target.company_id, actor, 'member', 'membership.remove', 'membership', target.id,
    jsonb_build_object('membership_id', target.id, 'status_before', 'active', 'status_after', 'removed',
                       'roles_before', target.roles, 'previous_admin_membership_id', admin.id));
  -- E4 (006 A5): the membership's group rows are locked by group id after the membership row (design 2.5, level 3) and
  -- deleted in one statement, each with one group.remove_member audit row carrying reason_code membership_removed.
  -- Reactivating the membership later restores no group.
  perform 1 from app.group_members gm
   where gm.company_id = target.company_id and gm.membership_id = target.id
   order by gm.group_id
   for update;
  with removed as (
    delete from app.group_members gm
     where gm.company_id = target.company_id and gm.membership_id = target.id
    returning gm.group_id)
  select coalesce(array_agg(r.group_id order by r.group_id), '{}'::uuid[]) into cleared from removed r;
  foreach gr in array cleared loop
    perform app.audit(target.company_id, actor, 'member', 'group.remove_member', 'group', gr,
      jsonb_build_object('group_id', gr, 'membership_id', target.id, 'previous_admin_membership_id', admin.id,
                         'reason_code', 'membership_removed'));
  end loop;
  -- E3: every active agent this membership owns becomes orphaned in the same transaction, under the
  -- company lock held above. Agent rows are locked by id ascending after the membership row, which
  -- is design 2.5's order; one UPDATE changes them, and each gets one agent.orphan audit row. An
  -- archived agent stays archived. Reactivating the membership later restores nothing.
  perform 1 from app.agents g
   where g.company_id = target.company_id and g.owner_membership_id = target.id and g.status = 'active'
   order by g.id
   for update;
  with orphaned as (
    update app.agents g set status = 'orphaned'
     where g.company_id = target.company_id and g.owner_membership_id = target.id and g.status = 'active'
    returning g.id)
  select coalesce(array_agg(o.id order by o.id), '{}'::uuid[]) into orphans from orphaned o;
  foreach ag in array orphans loop
    perform app.audit(target.company_id, actor, 'member', 'agent.orphan', 'agent', ag,
      jsonb_build_object('agent_id', ag, 'membership_id', target.id, 'agent_status_after', 'orphaned'));
  end loop;
  -- END-1 (011, D4): every pending invitation the removed member issued is revoked in this transaction, after the
  -- agent rows (design 2.5's order, invitations last), with one invitation.revoke audit row each.
  perform app.revoke_issued_invitations(target.company_id, target.id, actor, admin.id, 'issuer_removed');
  return query select target.id, 'removed'::text, true;
end $$;
