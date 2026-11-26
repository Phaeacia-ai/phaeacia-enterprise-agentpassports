#!/usr/bin/env bash
# Probe 34: migration 011's invitation standing, END-1 and the database half of ENA-7 (design and record
# evidence/ena7-end1-hbf2.md sections 2 and 5 as section 10 corrects them; review END1-CR-F3 and F2, debt XRR2-D5). It
# ports the PGlite cases of evidence/ena7-end1-hbf2-repro/pglite/end1-ena7.test.mjs.txt and claim.test.mjs.txt to the
# stack, calling through PostgREST under app_server bearers at aal2 and reading rows owner-side, and adds the race that
# one PGlite connection cannot run.
#
#   34a the fixture: company A with nine administrators and its invitees; company E and an operator account of this
#       probe's own; companies FA and FB for the claim, with a confirmed account and five unconfirmed ones (one an
#       operator, two with a factor, one holding a membership in E); one company each for suspended, held and closed;
#       companies G1 and G2 for the race
#   34b END-1 at removal (END1-1, END1-6): api.remove_member revokes the issuer's pending invitations, with one
#       invitation.revoke row each naming the issuer as membership_id and the acting administrator, reason
#       issuer_removed, written last, after membership.remove and the issuer's group.remove_member and agent.orphan
#       rows (D4's placement); the issuer's accepted and already revoked rows are left as they were; acceptance then
#       refuses E_INVITATION_INVALID; an invitation whose issuer still stands is accepted
#   34c END-1 at demotion (END1-2, END1-2b, END1-3, END1-3b): api.set_roles dropping company_admin revokes, reason
#       issuer_demoted; a role change that keeps company_admin revokes nothing; an administrator who accepts a
#       member-only invitation revokes their other pending invitations, audited as their own act with no
#       previous_admin_membership_id, and never the one being accepted (END1-CR-F6: accepted_at set, revoked_at null,
#       no invitation.revoke row for it, the revocation audited after the acceptance)
#   34d D5 at acceptance (END1-4, END1-5): an issuer removed or demoted owner-side, a path that revoked nothing, leaves
#       the row pending and acceptance refuses it, and the removed issuer may no longer claim a pending invitation's
#       handover; an operator-issued invitation is untouched by an administrator's removal and still accepted
#   34e ENA-7 D3 (ENA7-6, ENA7-6b): an administrator inviting an operator's address, in any case and spacing, meets
#       E_OPERATOR_ACCOUNT with no invitation row and no audit row written; inviting another company's member is still
#       allowed, and that confirmed account is not claimed
#   34f the claim, api.claim_invitation_handover (C-1 to C-10, C-12, C-13): a brand-new address is claimed and stamped;
#       a confirmed account never; an unconfirmed account with nothing attached is, and so is the same company's
#       resend; an operator row, a membership or a factor, verified or not, refuses; only the issuing membership's
#       account or the issuing operator may claim; revoked, expired and unknown invitations are refused; only
#       app_server executes it, and the new column is granted to nobody; another company's claim holds a second
#       company back for 65 minutes whatever that row's state (pending, revoked, expired), and not after, aged
#       owner-side; the company's status decides by who issued the invitation; the lock order, read from the routine's
#       text, and the per-address advisory lock, seen held in pg_locks by a claim in a rolled-back transaction
#   34g the claim under concurrency: G1's claim inside one owner transaction held open under pg_sleep, G2's claim for
#       the same unclaimed address through PostgREST started during the sleep, observed waiting on the per-address
#       advisory lock, answering false after the commit; exactly one row stamped. Then the fail-before inside the
#       probe: the routine re-created from its live definition without the advisory lock, a claim under it holding no
#       lock, the same schedule, both claims true and both rows stamped; restored, its md5 is the committed one and a
#       claim holds the per-address lock again
#
# C-11, the stamp 011 writes on rows pending when it runs, is tests/db/30-deletion.sh's 30g, which applies 011 over
# seeded rows, and is not repeated here. 34g's schedule is ordered by what the probe observes in pg_stat_activity; the
# only timed wait is the holder's own pg_sleep, three seconds, under app_server's lock_timeout of five (001), which
# bounds the waiting claim's wait on the advisory lock.
#
# The fail-before is this probe against a database with 001 to 010 applied. 34b's first revocation assertion fails
# there, because api.remove_member revokes nothing and the invitee is then accepted; 34c and 34d fail the same way and
# 34e's operator address is invited; 34f's routine and column do not exist, so every claim, 34d's included, answers 404
# PGRST202 and the probe stops at its first owner-side write of handover_claimed_at, C-9's age_claim. Both arms have
# run only on the PGlite stand-in (evidence/ena7-end1-hbf2-repro/probes/34-invitation-standing-standin*.log). With
# every migration, every line outside 34g passed there. In 34g the seven lines that need two sessions at once failed,
# because the stand-in runs one session at a time, so no claim ever waits on another; its two timed lines time only
# bash and node start-up there, so either passes or fails with the machine's load. At 010 it failed and stopped as
# described above. The first run on the machine of record is owed with both arms (evidence/ena7-end1-hbf2.md
# section 9).
#
# Every identity and company here is this probe's own, except the seeded operator, who provisions the companies,
# issues the operator's invitations and calls the claim (34f C-7 and C-13), on this probe's own rows only. Run:
# bash tests/db/34-invitation-standing.sh (after tests/db/00-seed.sh; scripts/check-db.sh runs every
# tests/db/[0-9][0-9]-*.sh in order).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
source "$ROOT/tests/db/e6-lib.sh"
RUN="$(run_id)"; E6_RUN="$RUN"; T="$E2_TMP/34"; mkdir -p "$T"
apply_fixture e6-mutate.sql
# 34g's mutant is restored on any exit, before lib.sh's scratch directory, which holds the saved definition, goes.
MUTATED=0
trap 'if [ "$MUTATED" = 1 ]; then restore_routine claim_34 || echo "34: api.claim_invitation_handover was NOT restored; reapply 011" >&2; fi; rm -rf "$E2_TMP"' EXIT

CLAIM_SIG='api.claim_invitation_handover(uuid)'
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
# The address e6_person gives a tag, for an invitee with an account and for one who has none.
addr() { printf 'e6-%s-%s@example.invalid' "$RUN" "$1"; }
# Sets I_<tag> and K_<tag>, the invitation's id and its code, from a table routine's answer. Loudly when it holds none:
# a case that went on with an empty id would meet a refusal it did not mean to test (E6DB-F13).
take() { # tag "HTTP <status> <json>"
  local id code
  id="$(row_field "$2" invitation_id 2>/dev/null || true)"; code="$(row_field "$2" invite_code 2>/dev/null || true)"
  if [ -z "$id" ]; then printf 'take %s: no invitation in %s\n' "$1" "$(printf '%s' "$2" | head -c 200)" >&2; return 1; fi
  eval "I_$1=$id"; eval "K_$1=$code"
}
invite_to() { # tag user company address [roles-json, default ["member"]]
  local roles="${5-}"
  if [ -z "$roles" ]; then roles='["member"]'; fi
  take "$1" "$(as_call invite_member "$(jbody p_company="$3" p_email="$4" p_roles="#$roles")" "$2" aal2)"
}
op_invite_to() { take "$1" "$(op_call operator_invite_admin "$(jbody p_company="$2" p_email="$3")")"; } # tag company address
claim_as() { as_call claim_invitation_handover "$(jbody p_invitation="$2")" "$1" "${3-aal2}"; } # user invitation [aal]
remove_as() { as_call remove_member "$(jbody p_membership="$2")" "$1" aal2; } # user membership
roles_as() { as_call set_roles "$(jbody p_membership="$2" p_roles="#$3")" "$1" aal2; } # user membership roles-json
revoke_as() { as_call revoke_invitation "$(jbody p_invitation="$2")" "$1" aal2; } # user invitation

state_of() { # invitation
  sql -c "select case when accepted_at is not null and revoked_at is not null then 'accepted_and_revoked'
                      when accepted_at is not null then 'accepted' when revoked_at is not null then 'revoked'
                      else 'pending' end from app.invitations where id = '$1'"
}
stamp_of() { sql -c "select case when handover_claimed_at is null then 'unstamped' else 'stamped' end from app.invitations where id = '$1'"; }
# Every invitation.revoke row for one invitation, oldest first, as actor|membership_id|previous_admin_membership_id|reason.
# previous_admin_membership_id reads none only when the key is absent, as 011's helper leaves it out, and null when it
# is present with a JSON null, which ->> alone cannot tell apart.
revokes_of() {
  sql -c "select coalesce(string_agg(coalesce(actor_user_id::text, 'null') || '|' || coalesce(details->>'membership_id', 'none')
            || '|' || case when details ? 'previous_admin_membership_id'
                           then coalesce(details->>'previous_admin_membership_id', 'null') else 'none' end
            || '|' || coalesce(details->>'reason_code', 'none'),
            ',' order by id), 'NONE') from app.audit_events where action = 'invitation.revoke' and entity_id = '$1'"
}
audit_max() { sql -c "select coalesce(max(id), 0) from app.audit_events"; }
audit_since() { sql -c "select coalesce(string_agg(action, ',' order by id), 'NONE') from app.audit_events where company_id = '$1' and id > $2"; } # company audit-id
members_in() { sql -c "select count(*) from app.memberships where company_id = '$1' and user_id = '$2'"; } # company user
# Which of two invitations carry a stamp: first, second, both in that order, or none.
stamped_pair() {
  sql -c "select coalesce(string_agg(case when id = '$1' then 'first' else 'second' end, ',' order by (id <> '$1')), 'none')
            from app.invitations where id in ('$1', '$2') and handover_claimed_at is not null"
}
claim_md5() { sql -c "select md5(pg_get_functiondef('$CLAIM_SIG'::regprocedure))"; }
# A claim inside one owner transaction that is rolled back, so it stamps nothing: its answer, and whether the backend
# then holds the advisory lock keyed by the invitation's address, as answer|locked or answer|unlocked. The lock is the
# claim's first act once it finds the row, so a claim refused by any later test takes it as well. A failed call
# prints an empty answer.
claim_lock() { # user invitation
  local r
  r="$({
    printf 'begin;\n'
    as_claims_sql "$1" aal2
    printf "select 'CLAIM|' || api.claim_invitation_handover('%s');\n" "$2"
    printf "select 'LOCK|' || case when exists (select 1 from pg_locks l
              where l.pid = pg_backend_pid() and l.locktype = 'advisory' and l.objsubid = 2
                and l.classid::bigint = (hashtext('app.invitation_handover')::bigint & 4294967295)
                and l.objid::bigint = (select hashtext(i.email_normalized)::bigint & 4294967295
                                         from app.invitations i where i.id = '%s'))
            then 'locked' else 'unlocked' end;\nrollback;\n" "$2"
  } | sql_try)"
  printf '%s|%s' "$(printf '%s\n' "$r" | sed -n 's/^CLAIM|//p')" "$(printf '%s\n' "$r" | sed -n 's/^LOCK|//p')"
}

# Owner-side setup, labelled as tests/db/e6-lib.sh labels it: no route makes these states.
# An account a handover link made and nobody has used: unconfirmed, nothing attached. create_user makes confirmed
# accounts only, so the confirmation is cleared afterwards, as tests/e7/stack/lift-gates.test.mjs clears one. With a
# company it also holds a membership there, which no route gives an unconfirmed account (api.provision_company and
# api.accept_invitation require a confirmed one): the claim's membership clause stands for one written outside them.
unconfirmed_person() { # tag [company] [roles]
  local uid
  e6_person "$@"; eval "uid=\$U_$1"
  sql -c "update auth.users set email_confirmed_at = null where id = '$uid'" >/dev/null
}
make_operator() { sql -c "insert into app.operators (user_id) values ('$1')" >/dev/null; } # user
# A second-factor row with the columns GoTrue has written at enrolment since MFA came in.
add_factor() { # user status
  sql -c "insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
          values (gen_random_uuid(), '$1', 'probe-34', 'totp', '$2', now(), now())" >/dev/null
}
# Another company's claim moved back in time, standing in for the hour a signing link lives (the claim's
# SIGNING_LIFE is 65 minutes): no route ages a claim.
age_claim() { sql -c "update app.invitations set handover_claimed_at = clock_timestamp() - interval '$2' where id = '$1'" >/dev/null; } # invitation interval
# A company's status, 'held' under app.recovery_reconcile as the reconciler holds one (tests/db/32-recovery-hold.sh 32a).
put_status() { # company status
  if [ "$2" = held ]; then
    sql -c "begin; set local app.recovery_reconcile = 'on'; update app.companies set status = 'held' where id = '$1'; commit;" >/dev/null
  else
    sql -c "update app.companies set status = '$2' where id = '$1'" >/dev/null
  fi
}

# 34g's two sessions. Session 1 is the first company's claim inside one owner transaction, held open under pg_sleep, so
# the per-address advisory lock is held for that long; it names itself so pg_stat_activity shows when it sleeps, which
# is after its claim returned. Session 2 is the second company's claim through PostgREST under its own server bearer,
# started once session 1 is seen sleeping, and timed. Both run in the background; the caller observes, then waits.
wait_sleeping() { # application-name [tenths]
  local i
  for i in $(seq 1 "${2:-30}"); do
    if [ "$(sql -c "select count(*) from pg_stat_activity where application_name = '$1' and state = 'active' and query like 'select pg_sleep%'")" -ge 1 ]; then return 0; fi
    sleep 0.1
  done
  return 1
}
# A backend waiting on an advisory lock inside the claim. The two companies' rows and their invitations are disjoint,
# so the per-address lock is the only advisory lock it can be waiting for.
wait_advisory() { # [tenths]
  local i
  for i in $(seq 1 "${1:-25}"); do
    if [ "$(sql -c "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and wait_event = 'advisory' and query like '%claim_invitation_handover%' and pid <> pg_backend_pid()")" -ge 1 ]; then
      printf 'waiting'; return 0
    fi
    sleep 0.1
  done
  printf 'not waiting'
}
race() { # name first-user first-invitation hold-seconds second-user second-invitation
  local jwt body
  jwt="$(server_jwt "$5" aal2)"; body="$(jbody p_invitation="$6")"
  {
    printf "set application_name = 'probe-34-%s';\nbegin;\n" "$1"
    as_claims_sql "$2" aal2
    printf "select 'S1|' || api.claim_invitation_handover('%s');\n" "$3"
    printf 'select pg_sleep(%s);\ncommit;\n' "$4"
  } | sql_try > "$T/$1.s1" &
  S1_PID=$!
  if wait_sleeping "probe-34-$1"; then SLEEPING=sleeping; else SLEEPING='not sleeping'; fi
  {
    t0="$(now_ms)"; r="$(rest POST /rpc/claim_invitation_handover "$jwt" "$body")"; t1="$(now_ms)"
    printf '%s\nELAPSED|%s\n' "$r" "$((t1 - t0))" > "$T/$1.s2"
  } &
  S2_PID=$!
}
# Session 2's recorded time against a bound: over|<ms>, under|<ms>, or none when nothing was recorded.
took() { # file ms
  local v
  v="$(sed -n 's/^ELAPSED|\([0-9][0-9]*\)$/\1/p' "$1" 2>/dev/null | head -1 || true)"
  if [ -z "$v" ]; then printf 'none'; elif [ "$v" -gt "$2" ]; then printf 'over|%s' "$v"; else printf 'under|%s' "$v"; fi
}

# ---------------------------------------------------------------------------
section "34a the fixture"
# ---------------------------------------------------------------------------
e6_person a1
A="$(company "e6-34a-$RUN" "$U_a1")"; future_period "$A"; MS_a1="$(membership_of "$A" "$U_a1")"
for t in x1 x2 x3 x4 x5 x6 x7 x8; do e6_person "$t" "$A" '{company_admin,member}'; done
for t in b1 b3 b4 c1 c3 c4 d1 d2 d3; do e6_person "$t"; done
e6_person e1; E="$(company "e6-34e-$RUN" "$U_e1")"; future_period "$E"
e6_person op34; make_operator "$U_op34"
e6_person fa; e6_person fb
FA="$(company "e6-34fa-$RUN" "$U_fa")"; FB="$(company "e6-34fb-$RUN" "$U_fb")"; future_period "$FA"; future_period "$FB"
MS_fa="$(membership_of "$FA" "$U_fa")"
e6_person fa2 "$FA" '{company_admin,member}'
e6_person conf
unconfirmed_person unconf
unconfirmed_person unop; make_operator "$U_unop"
unconfirmed_person unf; add_factor "$U_unf" verified
unconfirmed_person unfu; add_factor "$U_unfu" unverified
unconfirmed_person unmem "$E"
for st in suspended held closed; do
  e6_person "s_$st"; eval "su=\$U_s_$st"
  sc="$(company "e6-34$st-$RUN" "$su")"; future_period "$sc"; eval "S_$st=$sc"
done
e6_person g1; e6_person g2
G1="$(company "e6-34g1-$RUN" "$U_g1")"; G2="$(company "e6-34g2-$RUN" "$U_g2")"; future_period "$G1"; future_period "$G2"
expect "34a nine companies, all active" "$(sql -c "select count(*) filter (where status = 'active') from app.companies where id in ('$A', '$E', '$FA', '$FB', '$S_suspended', '$S_held', '$S_closed', '$G1', '$G2')")" '^9$'
expect "34a nine active administrators in A" "$(sql -c "select count(*) from app.memberships where company_id = '$A' and status = 'active' and 'company_admin' = any (roles)")" '^9$'
expect "34a the four unconfirmed accounts are unconfirmed and hold no membership" \
  "$(sql -c "select count(*) filter (where u.email_confirmed_at is null) || '|' || (select count(*) from app.memberships m where m.user_id in ('$U_unconf', '$U_unop', '$U_unf', '$U_unfu')) from auth.users u where u.id in ('$U_unconf', '$U_unop', '$U_unf', '$U_unfu')")" '^4|0$'
expect "34a the fifth unconfirmed account holds one membership, in E, and no operator row or factor" \
  "$(sql -c "select (email_confirmed_at is null)::text || '|' || (select count(*) from app.memberships m where m.user_id = '$U_unmem' and m.company_id = '$E')
                    || '|' || (select count(*) from app.memberships m where m.user_id = '$U_unmem') || '|' || (select count(*) from app.operators o where o.user_id = '$U_unmem')
                    || '|' || (select count(*) from auth.mfa_factors f where f.user_id = '$U_unmem') from auth.users where id = '$U_unmem'")" '^true|1|1|0|0$'
expect "34a two of them carry a factor, one verified and one not" "$(sql -c "select string_agg(status::text, ',' order by status::text) from auth.mfa_factors where user_id in ('$U_unf', '$U_unfu')")" '^unverified,verified$'
expect "34a two operator rows of this probe's own, one on an unconfirmed account" "$(sql -c "select count(*) from app.operators where user_id in ('$U_op34', '$U_unop')")" '^2$'
expect "34a the confirmed account is confirmed and holds nothing" "$(sql -c "select (email_confirmed_at is not null)::text || '|' || (select count(*) from app.memberships m where m.user_id = '$U_conf') from auth.users where id = '$U_conf'")" '^true|0$'

# ---------------------------------------------------------------------------
section "34b END-1 at removal: api.remove_member revokes the issuer's pending invitations"
# ---------------------------------------------------------------------------
invite_to b1 "$U_x1" "$A" "$(addr b1)" '["company_admin","member"]'
invite_to b2 "$U_x1" "$A" "$(addr b2)"
invite_to b3 "$U_a1" "$A" "$(addr b3)"
invite_to b4 "$U_x1" "$A" "$(addr b4)"
invite_to b5 "$U_x1" "$A" "$(addr b5)"
# The issuer also sits in one group and owns one active agent, owner-side, so the removal writes D4's whole order.
GX1="$(group_of "$A" "$MS_a1" "probe 34b $RUN" "$MS_x1")"
sql -c "insert into app.agents (company_id, name, creator_membership_id, owner_membership_id) values ('$A', 'p34b-$RUN', '$MS_x1', '$MS_x1')" >/dev/null
expect "34b fixture: the issuer is in one group and owns one active agent" \
  "$(sql -c "select (select count(*) from app.group_members where group_id = '$GX1' and membership_id = '$MS_x1') || '|' || (select count(*) from app.agents where owner_membership_id = '$MS_x1' and status = 'active')")" '^1|1$'
expect "34b fixture: one of the issuer's invitations is accepted before the removal" "$(accept_as "$U_b4" "$K_b4")" '"membership_id"'
expect "34b fixture: and one is revoked before it" "$(revoke_as "$U_a1" "$I_b5")" '"changed":true'
R5="$(sql -c "select revoked_at from app.invitations where id = '$I_b5'")"
AM="$(audit_max)"
expect "34b the first administrator removes the issuer" "$(remove_as "$U_a1" "$MS_x1")" '"changed":true'
expect "34b the issuer's pending administrator invitation is revoked" "$(state_of "$I_b1")" '^revoked$'
expect "34b and their pending member invitation" "$(state_of "$I_b2")" '^revoked$'
expect "34b one invitation.revoke row for the first: the acting administrator, the issuer as membership_id, reason issuer_removed" \
  "$(revokes_of "$I_b1")" "^$U_a1|$MS_x1|$MS_a1|issuer_removed\$"
expect "34b and one for the second" "$(revokes_of "$I_b2")" "^$U_a1|$MS_x1|$MS_a1|issuer_removed\$"
expect "34b in D4's order: the removal, the group row, the agent, then one revocation per pending row and no more" \
  "$(audit_since "$A" "$AM")" '^membership.remove,group.remove_member,agent.orphan,invitation.revoke,invitation.revoke$'
expect "34b the issuer's accepted row stays accepted, with no revocation" "$(state_of "$I_b4")|$(revokes_of "$I_b4")" '^accepted|NONE$'
expect "34b the row revoked before keeps its own time and its one audit row" \
  "$(sql -c "select revoked_at = '$R5'::timestamptz from app.invitations where id = '$I_b5'")|$(revokes_of "$I_b5")" "^t|$U_a1|$MS_a1|none|revoked\$"
expect "34b acceptance of the revoked administrator invitation: E_INVITATION_INVALID" "$(accept_as "$U_b1" "$K_b1")" 'E_INVITATION_INVALID'
expect "34b and no membership was made" "$(members_in "$A" "$U_b1")" '^0$'
expect "34b control (END1-6): the invitation of an administrator who still stands is accepted" "$(accept_as "$U_b3" "$K_b3")" '"membership_id"'
expect "34b and that row was never revoked" "$(state_of "$I_b3")|$(revokes_of "$I_b3")" '^accepted|NONE$'

# ---------------------------------------------------------------------------
section "34c END-1 at demotion: api.set_roles, and an acceptance that demotes"
# ---------------------------------------------------------------------------
invite_to c1 "$U_x2" "$A" "$(addr c1)"
invite_to c2 "$U_x2" "$A" "$(addr c2)"
AM="$(audit_max)"
expect "34c END1-2: the first administrator drops company_admin from the issuer" "$(roles_as "$U_a1" "$MS_x2" '["member"]')" '"changed":true'
expect "34c END1-2: the issuer's first pending invitation is revoked" "$(state_of "$I_c1")" '^revoked$'
expect "34c END1-2: and the second" "$(state_of "$I_c2")" '^revoked$'
expect "34c END1-2: the audit row names the acting administrator and the issuer, reason issuer_demoted" "$(revokes_of "$I_c1")" "^$U_a1|$MS_x2|$MS_a1|issuer_demoted\$"
expect "34c END1-2: the role change, then one revocation per pending row" "$(audit_since "$A" "$AM")" '^membership.set_roles,invitation.revoke,invitation.revoke$'
expect "34c END1-2: acceptance then refuses: E_INVITATION_INVALID" "$(accept_as "$U_c1" "$K_c1")" 'E_INVITATION_INVALID'

invite_to c3 "$U_x3" "$A" "$(addr c3)"
AM="$(audit_max)"
expect "34c END1-2b: a role change that keeps company_admin" "$(roles_as "$U_a1" "$MS_x3" '["company_admin","it_reviewer","member"]')" '"changed":true'
expect "34c END1-2b: revokes nothing and audits only the role change" "$(state_of "$I_c3")|$(audit_since "$A" "$AM")" '^pending|membership.set_roles$'
expect "34c END1-2b: and that invitation is accepted" "$(accept_as "$U_c3" "$K_c3")" '"membership_id"'

# END1-3. api.invite_member refuses an active member's address (E_ALREADY_MEMBER), so a member-only invitation for an
# administrator comes from an older or edge path: written owner-side, issued by the first administrator.
invite_to c4 "$U_x4" "$A" "$(addr c4)"
SELF="$(seeded_invitation "$A" "$(addr x4)" '{member}' "$MS_a1")"
AM="$(audit_max)"
expect "34c END1-3: an administrator accepts a member-only invitation" "$(accept_as "$U_x4" "${SELF#*|}")" '"roles":\["member"\]'
expect "34c END1-3: their pending invitation goes with the role" "$(state_of "$I_c4")" '^revoked$'
expect "34c END1-3: audited as their own act, with no previous_admin_membership_id" "$(revokes_of "$I_c4")" "^$U_x4|$MS_x4|none|issuer_demoted\$"
expect "34c END1-3: the acceptance, then the revocation" "$(audit_since "$A" "$AM")" '^invitation.accept,invitation.revoke$'
expect "34c END1-3: and its invitee is refused: E_INVITATION_INVALID" "$(accept_as "$U_c4" "$K_c4")" 'E_INVITATION_INVALID'

# END1-3b (END1-CR-F6). The administrator accepts, as a member only, an invitation they issued themselves: their
# account's address is moved owner-side to the invited one, which no route does, and moved back afterwards.
invite_to own "$U_x5" "$A" "$(addr own_x5)"
invite_to c5 "$U_x5" "$A" "$(addr c5)"
sql -c "update auth.users set email = '$(addr own_x5)' where id = '$U_x5'" >/dev/null
AM="$(audit_max)"
expect "34c END1-3b: the administrator accepts their own member-only invitation" "$(accept_as "$U_x5" "$K_own")" '"roles":\["member"\]'
expect "34c END1-3b: that invitation is accepted and not revoked" "$(state_of "$I_own")" '^accepted$'
expect "34c END1-3b: with no invitation.revoke row for it" "$(revokes_of "$I_own")" '^NONE$'
expect "34c END1-3b: their other pending invitation still goes" "$(state_of "$I_c5")|$(revokes_of "$I_c5")" "^revoked|$U_x5|$MS_x5|none|issuer_demoted\$"
expect "34c END1-3b: the acceptance is audited first, then the one revocation" "$(audit_since "$A" "$AM")" '^invitation.accept,invitation.revoke$'
sql -c "update auth.users set email = '$(addr x5)' where id = '$U_x5'" >/dev/null

# ---------------------------------------------------------------------------
section "34d D5: acceptance refuses an invitation whose issuer no longer stands, whatever path moved them"
# ---------------------------------------------------------------------------
invite_to d1 "$U_x6" "$A" "$(addr d1)"
invite_to d1n "$U_x6" "$A" "$(addr d1n)"
invite_to d2 "$U_x7" "$A" "$(addr d2)"
# The state the D4 callers cannot leave: the issuer removed, or demoted, by owner-side SQL that revoked nothing, as an
# invitation issued before 011 by an administrator who has since left is, or one changed through app_maintenance.
sql -c "update app.memberships set status = 'removed', removed_at = now() where id = '$MS_x6'" >/dev/null
sql -c "update app.memberships set roles = '{member}' where id = '$MS_x7'" >/dev/null
expect "34d END1-4: the removed issuer's row is still pending" "$(state_of "$I_d1")" '^pending$'
expect "34d END1-4: acceptance refuses it: E_INVITATION_INVALID" "$(accept_as "$U_d1" "$K_d1")" 'E_INVITATION_INVALID'
expect "34d END1-4: refused and not revoked (END1-CR-F4): the row stays pending and no membership is made" "$(state_of "$I_d1")|$(members_in "$A" "$U_d1")" '^pending|0$'
# The claim's own issuer test: the removed issuer's other pending invitation is for an address with no account, so
# nothing but the issuer's standing refuses it. No route reaches this, because api.remove_member revokes the row.
expect "34d END1-4: the removed issuer may not claim that invitation's handover" "$(claim_as "$U_x6" "$I_d1n")" '^HTTP 200 false$'
expect "34d END1-4: which stays pending and unstamped" "$(state_of "$I_d1n")|$(stamp_of "$I_d1n")" '^pending|unstamped$'
expect "34d END1-4: the demoted issuer's row is still pending" "$(state_of "$I_d2")" '^pending$'
expect "34d END1-4: acceptance refuses it too: E_INVITATION_INVALID" "$(accept_as "$U_d2" "$K_d2")" 'E_INVITATION_INVALID'

op_invite_to opi "$A" "$(addr d3)"
invite_to d4 "$U_x8" "$A" "$(addr d4)"
expect "34d END1-5: an administrator is removed" "$(remove_as "$U_a1" "$MS_x8")" '"changed":true'
expect "34d END1-5: which revokes that administrator's invitation" "$(state_of "$I_d4")" '^revoked$'
expect "34d END1-5: and leaves the operator's pending, with no revocation" "$(state_of "$I_opi")|$(revokes_of "$I_opi")" '^pending|NONE$'
expect "34d END1-5: the operator's invitation is accepted, as administrator" "$(accept_as "$U_d3" "$K_opi")" '"company_admin"'

# ---------------------------------------------------------------------------
section "34e ENA-7 D3: an operator's address is refused at invite time"
# ---------------------------------------------------------------------------
OPADDR="$(addr op34)"
AE="$(audit_count "$E")"
expect "34e ENA7-6: an administrator inviting an operator's address: E_OPERATOR_ACCOUNT" \
  "$(as_call invite_member "$(jbody p_company="$E" p_email="$OPADDR" p_roles='#["member"]')" "$U_e1" aal2)" 'E_OPERATOR_ACCOUNT'
expect "34e ENA7-6: the same address in capitals and between spaces: E_OPERATOR_ACCOUNT" \
  "$(as_call invite_member "$(jbody p_company="$E" p_email=" $(printf '%s' "$OPADDR" | tr '[:lower:]' '[:upper:]') " p_roles='#["member"]')" "$U_e1" aal2)" 'E_OPERATOR_ACCOUNT'
expect "34e ENA7-6: no invitation row was written for the address" "$(sql -c "select count(*) from app.invitations where email_normalized = '$OPADDR'")" '^0$'
expect "34e ENA7-6: and no audit row" "$(audit_count "$E")" "^$AE\$"
r="$(as_call invite_member "$(jbody p_company="$E" p_email="$(addr a1)" p_roles='#["member"]')" "$U_e1" aal2)"
expect "34e ENA7-6b control: inviting a member of another company is still allowed" "$r" '"invitation_id"'
take e "$r"
expect "34e ENA7-6b: and that confirmed account is not claimed, so its handover link is code-only" "$(claim_as "$U_e1" "$I_e")" '^HTTP 200 false$'

# ---------------------------------------------------------------------------
section "34f the claim: api.claim_invitation_handover"
# ---------------------------------------------------------------------------
invite_to f1 "$U_fa" "$FA" "$(addr new1)"
expect "34f C-1: a brand-new address is claimed by its issuer" "$(claim_as "$U_fa" "$I_f1")" '^HTTP 200 true$'
expect "34f C-1: and the row is stamped, now" "$(sql -c "select handover_claimed_at > clock_timestamp() - interval '1 minute' from app.invitations where id = '$I_f1'")" '^t$'

invite_to f2 "$U_fa" "$FA" "$(addr conf)"
expect "34f C-2: a confirmed account is never claimed" "$(claim_as "$U_fa" "$I_f2")" '^HTTP 200 false$'
expect "34f C-2: and the row is not stamped" "$(stamp_of "$I_f2")" '^unstamped$'

invite_to f3 "$U_fa" "$FA" "$(addr unconf)"
expect "34f C-3: an unconfirmed account with nothing attached is claimed" "$(claim_as "$U_fa" "$I_f3")" '^HTTP 200 true$'
invite_to f3r "$U_fa" "$FA" "$(addr unconf)"
expect "34f C-3: the same company's resend replaces the first" "$(state_of "$I_f3")" '^revoked$'
expect "34f C-3: and is claimed again, so a resend still signs in" "$(claim_as "$U_fa" "$I_f3r")" '^HTTP 200 true$'

# api.invite_member refuses an operator's address outright (D3), so this row is written owner-side to reach the claim.
F4="$(seeded_invitation "$FA" "$(addr unop)" '{member}' "$MS_fa")"
expect "34f C-4: an unconfirmed account that is an operator is not claimed" "$(claim_as "$U_fa" "${F4%%|*}")" '^HTTP 200 false$'
invite_to f4m "$U_fa" "$FA" "$(addr unmem)"
expect "34f C-4: nor an unconfirmed account whose only attachment is a membership, here in another company" "$(claim_as "$U_fa" "$I_f4m")" '^HTTP 200 false$'
invite_to f5 "$U_fa" "$FA" "$(addr unf)"
expect "34f C-5: nor an unconfirmed account with a verified factor" "$(claim_as "$U_fa" "$I_f5")" '^HTTP 200 false$'
invite_to f5u "$U_fa" "$FA" "$(addr unfu)"
expect "34f C-5: nor one whose factor is still unverified" "$(claim_as "$U_fa" "$I_f5u")" '^HTTP 200 false$'
expect "34f C-4 and C-5: none of the four rows is stamped" "$(stamp_of "${F4%%|*}"),$(stamp_of "$I_f4m"),$(stamp_of "$I_f5"),$(stamp_of "$I_f5u")" '^unstamped,unstamped,unstamped,unstamped$'

invite_to f7 "$U_fa" "$FA" "$(addr who)"
expect "34f C-7: another administrator of the same company may not claim" "$(claim_as "$U_fa2" "$I_f7")" '^HTTP 200 false$'
expect "34f C-7: nor the other company's administrator" "$(claim_as "$U_fb" "$I_f7")" '^HTTP 200 false$'
expect "34f C-7: nor an operator, on an administrator's invitation" "$(claim_as "$U_op" "$I_f7")" '^HTTP 200 false$'
expect "34f C-7: none of the three stamped it" "$(stamp_of "$I_f7")" '^unstamped$'
expect "34f C-7: the issuer may" "$(claim_as "$U_fa" "$I_f7")" '^HTTP 200 true$'
op_invite_to fop "$FA" "$(addr heir)"
expect "34f C-7: the operator claims its own invitation" "$(claim_as "$U_op" "$I_fop")" '^HTTP 200 true$'
expect "34f C-7: the company's administrator may not claim the operator's" "$(claim_as "$U_fa" "$I_fop")" '^HTTP 200 false$'
expect "34f C-7: nor another operator" "$(claim_as "$U_op34" "$I_fop")" '^HTTP 200 false$'

invite_to f8a "$U_fa" "$FA" "$(addr rev)"
expect "34f C-8 fixture: the issuer revokes it" "$(revoke_as "$U_fa" "$I_f8a")" '"changed":true'
expect "34f C-8: a revoked invitation is never claimed" "$(claim_as "$U_fa" "$I_f8a")" '^HTTP 200 false$'
invite_to f8b "$U_fa" "$FA" "$(addr exp)"
sql -c "update app.invitations set expires_at = clock_timestamp() - interval '1 second' where id = '$I_f8b'" >/dev/null
expect "34f C-8: nor an expired one" "$(claim_as "$U_fa" "$I_f8b")" '^HTTP 200 false$'
expect "34f C-8: nor an unknown id" "$(claim_as "$U_fa" "$(uuid)")" '^HTTP 200 false$'
expect "34f C-8: and neither row is stamped" "$(stamp_of "$I_f8a"),$(stamp_of "$I_f8b")" '^unstamped,unstamped$'

invite_to f10 "$U_fa" "$FA" "$(addr grant)"
B10="$(jbody p_invitation="$I_f10")"
expect "34f C-10: the issuer's own authenticated token: no execute" "$(rest POST /rpc/claim_invitation_handover "$(user_token "$U_fa" aal2)" "$B10")" 'permission denied for function claim_invitation_handover'
# anon holds no usage on schema api (001), so its call is refused there and never reaches the routine's grant, which
# the grant list below holds. Each refusal is matched by its message: E_NOT_SERVER is 42501 as well, so the code alone
# would pass a routine that ran and then refused.
expect "34f C-10: anon: refused at schema api, before the routine" "$(rest POST /rpc/claim_invitation_handover "$ANON_KEY" "$B10")" 'permission denied for schema api'
expect "34f C-10: service_role: no execute" "$(rest POST /rpc/claim_invitation_handover "$SERVICE_ROLE_KEY" "$B10")" 'permission denied for function claim_invitation_handover'
expect "34f C-10: a bound bearer (an fn claim) reaches nothing: E_NOT_SERVER" \
  "$(rest POST /rpc/claim_invitation_handover "$(server_jwt "$U_fa" aal2 '{"fn":"claim_invitation_handover","args_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","jti":"7d0c6b2e-4f1a-4c3b-9e8d-2a1b0c9d8e7f"}')" "$B10")" 'E_NOT_SERVER'
expect "34f C-10: none of them stamped the row" "$(stamp_of "$I_f10")" '^unstamped$'
expect "34f C-10: the routine is executable by app_server alone" \
  "$(sql -c "select string_agg(grantee, ',' order by grantee) from information_schema.routine_privileges where specific_schema = 'api' and routine_name = 'claim_invitation_handover' and grantee <> 'postgres'")" '^app_server$'
expect "34f C-10: SECURITY DEFINER with an empty search_path" \
  "$(sql -c "select p.prosecdef || '|' || array_to_string(p.proconfig, ',') from pg_proc p where p.oid = '$CLAIM_SIG'::regprocedure")" '^true|search_path=""$'
expect "34f C-10 control: the issuer's server bearer claims it" "$(claim_as "$U_fa" "$I_f10")" '^HTTP 200 true$'
expect "34f the new column exists and is granted to nobody, so no application read sees a claim" \
  "$(sql -c "select (select count(*) from information_schema.columns where table_schema = 'app' and table_name = 'invitations' and column_name = 'handover_claimed_at') || '|' || coalesce(string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type), 'NONE') from information_schema.column_privileges where table_schema = 'app' and table_name = 'invitations' and column_name = 'handover_claimed_at' and grantee <> 'postgres'")" '^1|NONE$'
expect "34f and api.invitations does not carry it" \
  "$(sql -c "select count(*) from information_schema.columns where table_schema = 'api' and table_name = 'invitations' and column_name = 'handover_claimed_at'")" '^0$'

# CR-ENA7-1: another company's stamp counts while the link it was handed can still sign in, 65 minutes, whatever that
# row's state now, and then no longer.
invite_to f6a "$U_fa" "$FA" "$(addr s6)"
expect "34f C-6: the first company claims a new address" "$(claim_as "$U_fa" "$I_f6a")" '^HTTP 200 true$'
unconfirmed_person s6
expect "34f C-6: the account its link made is unconfirmed and holds nothing" \
  "$(sql -c "select (email_confirmed_at is null)::text || '|' || (select count(*) from app.memberships m where m.user_id = '$U_s6') from auth.users where id = '$U_s6'")" '^true|0$'
invite_to f6b "$U_fb" "$FB" "$(addr s6)"
expect "34f C-6: a second company is refused while the first company's claim is live" "$(claim_as "$U_fb" "$I_f6b")" '^HTTP 200 false$'
expect "34f C-6: and its row is not stamped" "$(stamp_of "$I_f6b")" '^unstamped$'
invite_to f6c "$U_fa" "$FA" "$(addr s6)"
expect "34f C-6: the first company resends and claims again" "$(claim_as "$U_fa" "$I_f6c")" '^HTTP 200 true$'

invite_to f9a "$U_fa" "$FA" "$(addr s9)"
expect "34f C-9: the first company claims" "$(claim_as "$U_fa" "$I_f9a")" '^HTTP 200 true$'
expect "34f C-9: and revokes its invitation" "$(revoke_as "$U_fa" "$I_f9a")" '"changed":true'
invite_to f9b "$U_fb" "$FB" "$(addr s9)"
expect "34f C-9: the revoked row still holds the second company back, because its handed link still signs in" "$(claim_as "$U_fb" "$I_f9b")" '^HTTP 200 false$'
age_claim "$I_f9a" '66 minutes'
expect "34f C-9: once that link has expired, the second company may claim" "$(claim_as "$U_fb" "$I_f9b")" '^HTTP 200 true$'

invite_to f9x "$U_fa" "$FA" "$(addr s9x)"
expect "34f C-9, expired: the first company claims" "$(claim_as "$U_fa" "$I_f9x")" '^HTTP 200 true$'
sql -c "update app.invitations set expires_at = clock_timestamp() - interval '1 second' where id = '$I_f9x'" >/dev/null
invite_to f9y "$U_fb" "$FB" "$(addr s9x)"
expect "34f C-9, expired: its invitation expired, its stamp still holds the second company back" "$(claim_as "$U_fb" "$I_f9y")" '^HTTP 200 false$'
age_claim "$I_f9x" '66 minutes'
expect "34f C-9, expired: and not after the link's life" "$(claim_as "$U_fb" "$I_f9y")" '^HTTP 200 true$'

invite_to f12a "$U_fa" "$FA" "$(addr s12)"
expect "34f C-12: the first company claims" "$(claim_as "$U_fa" "$I_f12a")" '^HTTP 200 true$'
unconfirmed_person s12
invite_to f12b "$U_fb" "$FB" "$(addr s12)"
age_claim "$I_f12a" '64 minutes'
expect "34f C-12: 64 minutes on, inside the link's life: the second company is refused" "$(claim_as "$U_fb" "$I_f12b")" '^HTTP 200 false$'
age_claim "$I_f12a" '66 minutes'
expect "34f C-12: 66 minutes on: granted" "$(claim_as "$U_fb" "$I_f12b")" '^HTTP 200 true$'
expect "34f C-12: though the first company's invitation is still pending, so it does not keep the address" "$(state_of "$I_f12a")" '^pending$'
invite_to f12c "$U_fa" "$FA" "$(addr s12)"
expect "34f C-12: and now the first company waits for the second's link, as the second waited for its own" "$(claim_as "$U_fa" "$I_f12c")" '^HTTP 200 false$'

# C-13 (END1-CR-F2). Both invitations are made while the company is active, then its status is moved owner-side.
for st in suspended held closed; do
  eval "sc=\$S_$st; su=\$U_s_$st"
  invite_to "sa_$st" "$su" "$sc" "$(addr "sa_$st")"
  op_invite_to "so_$st" "$sc" "$(addr "so_$st")"
  put_status "$sc" "$st"
  eval "ia=\$I_sa_$st; io=\$I_so_$st"
  if [ "$st" = closed ]; then want=false; else want=true; fi
  expect "34f C-13 $st: an administrator's invitation is refused (its door, api.invite_member, admits active only)" "$(claim_as "$su" "$ia")" '^HTTP 200 false$'
  expect "34f C-13 $st: the operator's invitation answers $want (the operator's doors refuse closed only)" "$(claim_as "$U_op" "$io")" "^HTTP 200 $want\$"
done
expect "34f C-13: the three companies are in their three states" "$(sql -c "select string_agg(status, ',' order by status) from app.companies where id in ('$S_suspended', '$S_held', '$S_closed')")" '^closed,held,suspended$'
expect "34f C-13: the lock order in the routine's text: the per-address advisory lock, the company's row, the invitation's row" \
  "$(sql -c "select case when a > 0 and a < c and c < r then 'ordered' else 'a=' || a || ' c=' || c || ' r=' || r end
               from (select position('pg_advisory_xact_lock(' in d) a, position('app.lock_company_operator(inv.company_id)' in d) c,
                            position('for no key update' in d) r
                       from (select pg_get_functiondef('$CLAIM_SIG'::regprocedure) d) f) p")" '^ordered$'
expect "34f C-13: and no other routine takes the claim's advisory key, so it cannot be part of a cycle" \
  "$(sql -c "select string_agg(n.nspname || '.' || p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('app', 'api') and p.prokind = 'f' and position('app.invitation_handover' in pg_get_functiondef(p.oid)) > 0")" '^api.claim_invitation_handover$'
# The text above shows where the lock is taken; this shows what it is keyed by. Two companies' invitations for one
# address meet on it only when it is keyed by the address, which 34g's race shows on a stack and one connection cannot.
invite_to f13 "$U_fa" "$FA" "$(addr lock13)"
expect "34f C-13: after the claim returns, its open transaction holds the advisory lock keyed by the invitation's address" "$(claim_lock "$U_fa" "$I_f13")" '^true|locked$'
expect "34f C-13: that claim was rolled back, so the row is not stamped" "$(stamp_of "$I_f13")" '^unstamped$'

# ---------------------------------------------------------------------------
section "34g two companies claim one unclaimed address at once"
# ---------------------------------------------------------------------------
invite_to ga1 "$U_g1" "$G1" "$(addr r1)"; invite_to gb1 "$U_g2" "$G2" "$(addr r1)"
invite_to ga2 "$U_g1" "$G1" "$(addr r2)"; invite_to gb2 "$U_g2" "$G2" "$(addr r2)"
DL="$(deadlocks)"
race real "$U_g1" "$I_ga1" 3 "$U_g2" "$I_gb1"
expect "34g session 1 claimed and holds its transaction open under pg_sleep" "$SLEEPING" '^sleeping$'
expect "34g session 2 is observed waiting on the per-address advisory lock" "$(wait_advisory)" '^waiting$'
expect "34g while session 1's stamp is still uncommitted" "$(stamp_of "$I_ga1")" '^unstamped$'
wait "$S1_PID" "$S2_PID" || true
expect "34g session 1's claim answered true" "$(cat "$T/real.s1")" 'S1|true'
expect "34g and it committed" "$(cat "$T/real.s1")" 'COMMIT'
expect "34g session 2's claim answered false" "$(head -1 "$T/real.s2")" '^HTTP 200 false$'
expect "34g after waiting for that commit (over 1000 ms)" "$(took "$T/real.s2" 1000)" '^over|'
expect "34g exactly one row is stamped, the first company's" "$(stamped_pair "$I_ga1" "$I_gb1")" '^first$'
expect "34g deadlocks unchanged" "$(deadlocks)" "^$DL\$"

# The fail-before, inside the probe: the routine re-created from its live definition without its advisory lock
# (tests.e6_mutate raises if the anchor has moved), the same schedule, and the counterexample the lock exists to prevent.
CLAIM_MD5="$(claim_md5)"
save_routine "$CLAIM_SIG" claim_34
MUTATED=1
e6_mutate "$CLAIM_SIG" "perform pg_advisory_xact_lock(hashtext('app.invitation_handover'), hashtext(inv.email_normalized));" "null; -- probe 34g mutant: no advisory lock"
expect "34g fail-before: the mutant is installed and takes no advisory lock" \
  "$(sql -c "select md5(pg_get_functiondef('$CLAIM_SIG'::regprocedure)) <> '$CLAIM_MD5' and pg_get_functiondef('$CLAIM_SIG'::regprocedure) not like '%pg_advisory_xact_lock%'")" '^t$'
expect "34g fail-before: a claim under it, rolled back, holds no advisory lock" "$(claim_lock "$U_g1" "$I_ga2")" '^true|unlocked$'
DL="$(deadlocks)"
race mutant "$U_g1" "$I_ga2" 3 "$U_g2" "$I_gb2"
expect "34g fail-before: session 1 claimed and holds its transaction open" "$SLEEPING" '^sleeping$'
wait "$S2_PID" || true
expect "34g fail-before: session 2's claim answered true as well: the counterexample" "$(head -1 "$T/mutant.s2")" '^HTTP 200 true$'
expect "34g fail-before: without waiting (under 1000 ms)" "$(took "$T/mutant.s2" 1000)" '^under|'
expect "34g fail-before: while session 1's transaction was still open" "$(stamp_of "$I_ga2")" '^unstamped$'
wait "$S1_PID" || true
expect "34g fail-before: session 1's claim answered true" "$(cat "$T/mutant.s1")" 'S1|true'
expect "34g fail-before: both rows are stamped, two companies handed signing links for one account" "$(stamped_pair "$I_ga2" "$I_gb2")" '^first,second$'
expect "34g fail-before: deadlocks unchanged" "$(deadlocks)" "^$DL\$"
restore_routine claim_34
MUTATED=0
expect "34g restored: the routine's md5 is the committed one again" "$(claim_md5)" "^$CLAIM_MD5\$"
# A sequential claim cannot tell the restored routine from the mutant, which differs only by the lock: both refuse the
# second company while the first company's stamp is live. The lock itself can, as the fail-before line above shows.
expect "34g restored: a claim holds the per-address advisory lock again, and still refuses the second company" "$(claim_lock "$U_g2" "$I_gb2")" '^false|locked$'

printf '\n== 34 done: %s ==\n' "$([ "$FAILED" = 0 ] && echo PASS || echo FAIL)"
exit "$FAILED"
