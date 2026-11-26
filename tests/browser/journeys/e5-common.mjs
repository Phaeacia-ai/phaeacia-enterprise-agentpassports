/* What the E5 journeys share (E5 design sections 4 and 5), built on the E4 world so the accounts, the company and the
   enabled target are made once per run. Everything here is the harness setting up, never a page's request: the
   starting states are made in this process through the route functions under sessions minted with the local secret, as
   tests/e5/stack/ makes them, and the owner-side steps are labelled where they are used, exactly as design section 5
   labels them ("owner-side marks test setup done as the database owner because no route does it").

   The E5 world adds to E4's: one audience group holding the plain member and the IT reviewer, so the reviewer can be a
   recipient of their own and the witness rules have both sides; one group no release is addressed to; and two fresh
   plain members, one in no group at all and one in that empty group, so the catalog's two empty reasons are read by
   people whose other journeys do not move. Nothing here prints a token or a key. */

import { randomUUID } from 'node:crypto';

import { e3lib, sql } from '../../e3/stack/helpers.mjs';
import { mintUserToken } from '../../e2/helpers/stack.mjs';
import { tag } from './common.mjs';
import { approveBoth, e4world, envelope, fixture, published, routes, submitted } from './e4-common.mjs';

export const E5_GROUP = 'E5 recipients';
export const E5_EMPTY_GROUP = 'E5 addressed to nobody';

function ok(r, label) {
  if (r.status < 200 || r.status >= 300) throw new Error(`E5 setup, ${label}: ${r.status} ${String(r.raw).slice(0, 300)}`);
  return r.body;
}

/** The run's E5 world, made once, on top of the E4 world. */
export async function e5world(ctx) {
  const W = await e4world(ctx);
  if (W.e5) return W;
  const { call } = await routes(ctx);
  const admin = W.aal2(W.users.admin);
  const group = ok(await call('groupsCreate', { user: admin, params: { companyId: W.companyId }, body: { name: E5_GROUP } }), 'E5 group').groupId;
  const emptyGroup = ok(
    await call('groupsCreate', { user: admin, params: { companyId: W.companyId }, body: { name: E5_EMPTY_GROUP } }),
    'E5 empty group',
  ).groupId;
  for (const who of ['member', 'it'])
    ok(await call('groupMembersAdd', { user: admin, params: { companyId: W.companyId, groupId: group, membershipId: W.ms[who] } }), `E5 audience ${who}`);

  /* Two fresh plain members, so the catalog's empty reasons are read by people no other journey moves. */
  const users = {};
  const ms = {};
  for (const who of ['bystander', 'elsewhere']) {
    const email = `e5p-${W.run}-${who}@example.invalid`;
    const id = e3lib('create_user "$1" "$PW"', email);
    users[who] = { who, id, email, identity: `e5-${who}`, token: () => mintUserToken({ sub: id, email, aal: 'aal1', ttl: 3600 }) };
    ms[who] = e3lib('member "$1" "$2" "$3"', W.companyId, id, '{member}');
  }
  ok(
    await call('groupMembersAdd', { user: admin, params: { companyId: W.companyId, groupId: emptyGroup, membershipId: ms.elsewhere } }),
    'the empty group holds one member',
  );
  W.e5 = { group, emptyGroup, users, ms };
  W.users = { ...W.users, ...users };
  return W;
}

/** A fresh agent published to the E5 audience group; its ids. `text` picks the passport, so a journey chooses whether
    its section 6 declares losses. */
export async function e5release(ctx, W, { text, groups, target = 'claude-ai', author = W.users.author } = {}) {
  const C = await submitted(ctx, W, { author, text });
  const e = await envelope(ctx, W, C.candidateId, { groups: groups ?? [W.e5.group], target });
  await approveBoth(ctx, W, C.candidateId, e);
  const releaseId = await published(ctx, W, C.candidateId, e);
  return { ...C, envelopeId: e, releaseId };
}

export const declaredLossesPassport = () => fixture('synthetic-declared-losses.md');
export const emptyLossesPassport = () => fixture('synthetic-empty.md');

export const catalogUrl = (j, companyId) => `${j.origin}/catalog/?company=${companyId}`;

/** A route call this process makes as a named user, for the hand-built requests a page never sends: the control the
    page hides, sent anyway, so the server's own refusal is observed rather than the page's (evidence/e4-pages-review.md,
    E4PW-R-F4's method). */
export async function callAs(ctx, name, params) {
  const { call } = await routes(ctx);
  return call(name, { headers: { 'idempotency-key': randomUUID() }, ...params });
}

/* Owner-side, labelled as E5 design section 5 labels it: a membership's authorizations of one release moved back in
   time, so the derived check-in state can be read at an exact age without waiting fourteen days. No route moves a
   ledger row and the append-only trigger refuses an UPDATE, so the trigger is disabled inside one owner transaction,
   which is the one thing only the migration owner can do. */
export function ageLedger(releaseId, membershipId, interval) {
  sql(`begin;
    alter table app.release_downloads disable trigger release_downloads_append_only;
    update app.release_downloads set authorized_at = authorized_at - interval '${interval}'
     where release_id = '${releaseId}' and membership_id = '${membershipId}';
    alter table app.release_downloads enable trigger release_downloads_append_only;
    commit;`);
}

/* Owner-side, labelled: n further releases of one release's agent and target, each superseding the one before, so a
   company holds more releases than one catalog page carries. Publishing them through the route would need n candidates
   and n envelopes for a state that is only about paging. Every row is inserted published and current, as
   app.release_identity requires, and the row before it is superseded in the statement before, so app.release_immutable
   sees only the supersession it admits and releases_one_current never holds two. The source release ends superseded. */
export function cloneReleases(releaseId, n) {
  sql(`do $clone$
declare src app.releases%rowtype; prev uuid; fresh uuid; i int;
begin
  set constraints all deferred;
  select * into src from app.releases where id = '${releaseId}';
  prev := src.id;
  for i in 1..${n} loop
    fresh := gen_random_uuid();
    update app.releases set superseded_by_release_id = fresh, superseded_at = clock_timestamp() where id = prev;
    insert into app.releases (id, company_id, agent_id, candidate_id, envelope_id, target, gate_id, content_sha256,
      derived_sha256, installer_text_sha256, core_sha256, branch_sha256, judge_sha256, policy_id, policy_sha256,
      audience_group_ids, envelope_sha256, assembled_content, published_by_membership_id)
    values (fresh, src.company_id, src.agent_id, src.candidate_id, src.envelope_id, src.target, src.gate_id,
      src.content_sha256, src.derived_sha256, src.installer_text_sha256, src.core_sha256, src.branch_sha256,
      src.judge_sha256, src.policy_id, src.policy_sha256, src.audience_group_ids, src.envelope_sha256,
      src.assembled_content, src.published_by_membership_id);
    prev := fresh;
  end loop;
end $clone$;`);
}

/* Owner-side, labelled: every target's publishable flag, read and written under the registry bypass, so the launch
   state of design 1.3 (no target enabled, so no release can exist) can be read and then put back. Only a migration
   flips this register in the product; a test does it under the same bypass tests/db/e4-lib.sh enable_target uses. */
export const publishableTargets = () => sql(`select coalesce(string_agg(target, ',' order by target), '') from app.release_targets where publishable`).split(',').filter(Boolean);
export function setPublishable(targets, value) {
  if (targets.length === 0) return;
  const list = targets.map((t) => `'${t}'`).join(',');
  sql(`begin; set local app.registry_migration = 'on'; update app.release_targets set publishable = ${value ? 'true' : 'false'} where target in (${list}); commit;`);
}

export const countWhere = (from, where) => Number(sql(`select count(*) from ${from} where ${where}`));
export const storedAssembly = (releaseId) =>
  sql(`select json_build_object('content', assembled_content, 'sha', encode(assembled_sha256, 'hex')) from app.releases where id = '${releaseId}'`);

/** A fresh company whose one member is in one group, for the launch-state reading; its ids. */
export function emptyCompany(W, slug) {
  const adminId = e3lib('create_user "$1" "$PW"', `e5p-${W.run}-${slug}-admin@example.invalid`);
  const companyId = e3lib('company "$1" "$2"', `e5p-${W.run}-${slug}`, adminId);
  const email = `e5p-${W.run}-${slug}-member@example.invalid`;
  const userId = e3lib('create_user "$1" "$PW"', email);
  const membershipId = e3lib('member "$1" "$2" "$3"', companyId, userId, '{member}');
  const adminMembership = e3lib('membership_of "$1" "$2"', companyId, adminId);
  const groupId = e3lib('group_of "$1" "$2" "$3" "$4"', companyId, adminMembership, `${slug} group`, membershipId);
  return { companyId, groupId, user: { who: slug, id: userId, email, identity: `e5-${slug}` } };
}

export const runTag = () => tag();
