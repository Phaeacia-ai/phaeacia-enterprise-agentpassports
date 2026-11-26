-- E6 upgrade seed (docs/e6/design.md 2.3; evidence/e6-design-critique.md rule 10's outcome: "test an upgrade from the
-- accepted 007 schema as well as fresh install and compare unaffected function bodies/refusals"). TEST ONLY.
--
-- E1 to E5 data, written owner-side into a scratch database standing at the accepted 007 schema, so that migration
-- 008 is applied to a database HOLDING ROWS rather than to an empty one. A fresh reset applies 008 to nothing, and
-- the pin gate proves 001 to 007's bytes and not the semantics of a later replacement, so the risk this seed exists
-- for is the one a pilot database would meet: a constraint, an index or a one-time check that 008 adds OVER EXISTING
-- ROWS. What it therefore covers is every row shape those touch:
--   app.invitations in all four states, each with created_by set, against the new num_nonnulls CHECK;
--   app.operators with no membership, against the one-time dual-principal check;
--   app.companies, app.memberships and app.audit_events, against app.company_status_guard and the new triggers;
--   rows in the six tables that gain a company_id index.
-- No route is involved and none could be: PostgREST points at the project's own database. That is the limit, and
-- probe 30g states it.
insert into app.companies (id, slug, name, status) values
  ('11111111-1111-4111-8111-111111111111', 'upgrade-alpha', 'SYNTHETIC Upgrade Alpha', 'active'),
  ('22222222-2222-4222-8222-222222222222', 'upgrade-beta', 'SYNTHETIC Upgrade Beta', 'suspended'),
  ('33333333-3333-4333-8333-333333333333', 'upgrade-gamma', 'SYNTHETIC Upgrade Gamma', 'closed');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'upgrade-admin@example.invalid', now(), now(), now()),
  ('aaaaaaaa-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'upgrade-member@example.invalid', now(), now(), now()),
  ('aaaaaaaa-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'upgrade-removed@example.invalid', now(), now(), now()),
  ('aaaaaaaa-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'upgrade-operator@example.invalid', now(), now(), now());

insert into app.memberships (id, company_id, user_id, status, roles, removed_at) values
  ('bbbbbbbb-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-0000-4000-8000-000000000001', 'active', '{company_admin,member}', null),
  ('bbbbbbbb-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-0000-4000-8000-000000000002', 'active', '{it_reviewer,member}', null),
  ('bbbbbbbb-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-0000-4000-8000-000000000003', 'removed', '{member}', now());

-- An operator that holds NO membership, which is what the one-time check of 008 admits.
insert into app.operators (user_id) values ('aaaaaaaa-0000-4000-8000-000000000004');
insert into app.operator_allowlist (email_normalized) values ('upgrade-operator@example.invalid');

-- Invitations in all four states, every one with created_by set and created_by_operator absent, which is the shape
-- the new CHECK has to admit for rows that already exist.
insert into app.invitations (company_id, email_normalized, token_hash, roles, expires_at, created_by,
                             accepted_membership_id, accepted_at, revoked_at) values
  ('11111111-1111-4111-8111-111111111111', 'upgrade-pending@example.invalid',
   extensions.digest('upgrade-pending', 'sha256'), '{member}', now() + interval '7 days',
   'bbbbbbbb-0000-4000-8000-000000000001', null, null, null),
  ('11111111-1111-4111-8111-111111111111', 'upgrade-accepted@example.invalid',
   extensions.digest('upgrade-accepted', 'sha256'), '{it_reviewer,member}', now() + interval '7 days',
   'bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', now(), null),
  ('11111111-1111-4111-8111-111111111111', 'upgrade-revoked@example.invalid',
   extensions.digest('upgrade-revoked', 'sha256'), '{member}', now() + interval '7 days',
   'bbbbbbbb-0000-4000-8000-000000000001', null, null, now()),
  ('11111111-1111-4111-8111-111111111111', 'upgrade-expired@example.invalid',
   extensions.digest('upgrade-expired', 'sha256'), '{member}', now() - interval '1 day',
   'bbbbbbbb-0000-4000-8000-000000000001', null, null, null);

insert into app.audit_events (company_id, actor_user_id, actor_kind, action, entity_type, entity_id, details) values
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000004', 'operator',
   'company.provision', 'company', '11111111-1111-4111-8111-111111111111',
   jsonb_build_object('company_id', '11111111-1111-4111-8111-111111111111',
                      'membership_id', 'bbbbbbbb-0000-4000-8000-000000000001',
                      'operator_user_id', 'aaaaaaaa-0000-4000-8000-000000000004')),
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 'member',
   'membership.remove', 'membership', 'bbbbbbbb-0000-4000-8000-000000000003',
   jsonb_build_object('membership_id', 'bbbbbbbb-0000-4000-8000-000000000003',
                      'status_before', 'active', 'status_after', 'removed', 'reason_code', 'upgrade_seed'));

-- Rows in the tables that gain a company_id index, and in the two the export and the deletion reach through a
-- candidate. The gate identity and the installer texts are 003's and 006's own registrations, already present.
insert into app.groups (id, company_id, name, created_by_membership_id) values
  ('cccccccc-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Upgrade Group',
   'bbbbbbbb-0000-4000-8000-000000000001');
insert into app.group_members (group_id, company_id, membership_id, added_by_membership_id) values
  ('cccccccc-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   'bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000001');
insert into app.agents (id, company_id, name, creator_membership_id, owner_membership_id, status) values
  ('dddddddd-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'upgrade-agent',
   'bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002', 'active');
