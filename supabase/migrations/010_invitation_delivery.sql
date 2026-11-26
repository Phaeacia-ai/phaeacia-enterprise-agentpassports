-- 010_invitation_delivery.sql. E6 design 1.2.1 (lane K4, 2026-09-28), from the external review's XR-7
-- (evidence/external-review-2026-09-28.md).
--
-- THE GAP. api.invite_member and app.operator_invitation commit the invitation row; the account, the link and the
-- mail come after it, in the same request, and until this file only the answer said what happened. A function killed
-- between the two, or a page closed before the answer, left a pending row nothing sent and no page could tell apart
-- from one that was sent. Reevaluated (XR-7): the review's outbox and worker. An outbox would have to store the link,
-- the invitee's first factor, which nothing stores (E6 1.2 rule 1), and a worker needs the machine identity E7 1.6
-- declined for the pilot, so neither is here.
--
-- WHAT THIS FILE CONTAINS, and nothing else: one column on app.invitations with its default and its check; the
-- column's select grant to authenticated; api.invitations re-created with the column appended; one routine,
-- api.record_invitation_delivery, with its grants. No policy changes: invitations_admin_read (005) decides who reads
-- the column, as it decides every other one, so only an active admin of that company at aal2 does. No routine is
-- replaced: api.invite_member and app.operator_invitation name the columns they insert and this one is not among
-- them, so every new row takes the default. app_maintenance gets nothing: the reconciler does not read the column,
-- and the export and the takeout do not carry it.
--
-- WHAT THE COLUMN HOLDS: one word. `not_attempted` from the default, then the answer's own outcome, `handover`,
-- `mail`, `failed` or `unconfirmed` (lib/services/invitations.mjs; E6 1.2 as E7 amended it), so no second vocabulary
-- exists to drift from the first. Never a link, a token, an invitation code, an address, a provider id, a provider's
-- answer or error text, or a time: the routine takes the id and the word and nothing else, and the check below admits
-- five words.
--
-- ROWS OLDER THAN THIS FILE KEEP NULL. Nothing recorded their delivery. The column is added with no default, which
-- leaves every existing row null, and the default is set by a second statement, which reaches only rows inserted
-- after it. A one-statement `add column ... default 'not_attempted'` would give every existing row that word, and the
-- invitation list would then say of every mailed pilot invitation that nothing confirms it reached anyone.
alter table app.invitations add column delivery text;
alter table app.invitations alter column delivery set default 'not_attempted';
alter table app.invitations add constraint invitations_delivery_word
  check (delivery is null or delivery in ('not_attempted', 'handover', 'mail', 'failed', 'unconfirmed'));

-- The read. 001's column grant is widened by this one column and by nothing else (token_hash stays ungranted), and the
-- view gains it at the end, which is the only change CREATE OR REPLACE VIEW admits and which keeps the view's
-- privileges, its owner and its security_invoker option, restated here so the file says what the view is.
grant select (delivery) on app.invitations to authenticated;
create or replace view api.invitations with (security_invoker = true) as
  select id, company_id, email_normalized, roles, expires_at, created_by, created_at,
         accepted_membership_id, accepted_at, revoked_at, delivery from app.invitations;

-- The writer. Unbound (lib/db/server.mjs FUNCTIONS; no BOUND or FIELDS row): the write is idempotent by its
-- postcondition, one word written once, so an Idempotency-Key and an app.idempotency_keys row would buy nothing, the
-- test E6 3.3 applies to its thirteen routines. app.server_actor() refuses a bound bearer and every token that is not
-- the server's.
--
--   Refusals, in order. A word other than the four outcomes is 22023 E_BODY_INVALID, the generic refusal
--   lib/errors.mjs already maps to 422, so `not_attempted` can never be written back and a null is refused rather
--   than stored; no route surfaces it, because the one caller passes its own answer's word and swallows every
--   failure, and a code of its own would be a code no page could ever meet. Then E_NOT_FOUND unless the caller
--   CREATED the row and still stands, that is created_by is the caller's own active membership, or
--   created_by_operator is the caller and a registered operator. An unknown id, another company's row, a co-admin's
--   row and a removed creator all answer the same, so the routine tells nobody which rows exist. Then, to the creator
--   only, app.lock_company's own refusals: E_COMPANY_INACTIVE when the company is no longer active (a held one
--   included) and E_ACCESS_PERIOD_ENDED past its ends_at. No admin role and no aal test: the routine records what the
--   request that made the row did, under that request's own token, a few milliseconds later, and it changes nobody's
--   standing, access or content.
--
--   Write once. Only a row still `not_attempted` is written; any other row, a null one included, answers its own
--   word with changed false and writes nothing, so a repeat cannot overwrite an outcome and a row older than this
--   file is never written.
--
--   Locks. Design 2.5's order, the company and then the row. app.lock_company takes the company row FOR NO KEY
--   UPDATE and refuses a company that is not active or past its ends_at, as every other company-scoped mutation
--   does, so the hold of 009 closes this door too (tests/db/32-recovery-hold.sh, E7S-F1: the one exception to the
--   company lock is api.departure_preview, and this routine is not a second); then the invitation row, FOR NO KEY
--   UPDATE. The creator test runs first on the row read without a lock, so a caller who did not create it meets
--   E_NOT_FOUND before the company lock could tell it the company's status; it runs again under both locks, and
--   that run decides, because a removal takes the company lock too and so lies wholly before it or wholly after. A
--   concurrent api.revoke_invitation, api.accept_invitation or sibling replacement waits for it or it waits for
--   them, and the word is written whatever they decided, because it says what the attempt came to and not what the
--   row is now.
--
--   No audit row. invitation.create already records the act; the word is not a change of anyone's standing or
--   access; and a detail key for it would widen app.audit_details_guard (009) for a value the row already holds.
create or replace function api.record_invitation_delivery(p_invitation uuid, p_delivery text)
returns table (invitation_id uuid, delivery text, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := app.server_actor();
  inv app.invitations;
begin
  if p_delivery is null or p_delivery not in ('handover', 'mail', 'failed', 'unconfirmed') then
    raise exception 'E_BODY_INVALID' using errcode = '22023';
  end if;
  -- The creator test before any lock: a caller who did not create the row learns nothing, the company's status
  -- included.
  select * into inv from app.invitations i where i.id = p_invitation;
  if inv.id is null
     or not (
       exists (select 1 from app.memberships m
               where m.id = inv.created_by and m.user_id = actor and m.status = 'active')
       or exists (select 1 from app.operators o
                  where o.user_id = inv.created_by_operator and o.user_id = actor)) then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  -- Design 2.5's order: the company, then the row. The same creator test again under both locks decides.
  perform app.lock_company(inv.company_id);
  select * into inv from app.invitations i where i.id = p_invitation for no key update;
  if inv.id is null
     or not (
       exists (select 1 from app.memberships m
               where m.id = inv.created_by and m.user_id = actor and m.status = 'active')
       or exists (select 1 from app.operators o
                  where o.user_id = inv.created_by_operator and o.user_id = actor)) then
    raise exception 'E_NOT_FOUND' using errcode = 'P0002';
  end if;
  if inv.delivery is distinct from 'not_attempted' then
    return query select inv.id, inv.delivery, false;
    return;
  end if;
  update app.invitations i set delivery = p_delivery where i.id = inv.id;
  return query select inv.id, p_delivery, true;
end $$;

-- Grants: app_server alone, by full signature; PUBLIC, anon, authenticated and service_role explicitly revoked, as
-- 001 section 5 and 008 B14 do, so the privilege set is visible here and not inferred from defaults.
revoke execute on function api.record_invitation_delivery(uuid, text) from public, anon, authenticated, service_role;
grant execute on function api.record_invitation_delivery(uuid, text) to app_server;
