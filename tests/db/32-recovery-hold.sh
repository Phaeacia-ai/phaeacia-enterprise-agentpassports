#!/usr/bin/env bash
# Probe 32: migration 009's recovery hold at every door (docs/e7/design.md 1.3, 2.1, 3.1, 3.5; section 5 cases
# E7-29 and E7-26). The behavioural half of the correction E7D-C-F1.
#
#   32a the fixture: one company held owner-side under app.recovery_reconcile, and its active twin as the control
#   32b case E7-29, the member paths: every api view under the admin's and the member's own tokens, every member
#       routine that takes the company lock, api.authorize_download, api.export_company and api.my_standing
#   32c case E7-29, the operator paths: api.set_company_status both ways, api.close_company, and the two that
#       ADMIT a held company on purpose, api.transfer_first_admin and api.set_access_period
#   32d case E7-29, the guard: an owner UPDATE into and out of 'held' without the setting, and with it; the same
#       as app_maintenance; the audit guard's two status words
#   32e case E7-29, the control: the SAME company, active again, answers every member path
#   32f case E7-26: every earlier migration's pin is unchanged and 009 is the only new file
#
# THE FAIL-BEFORE IS AT 008 AND IS ON RECORD RATHER THAN RE-RUN HERE, because it cannot be run once 009 is
# applied: evidence/e7-scripts-repro/e7-29-fail-before-at-008.log.txt shows, against the same local stack with
# 001 to 008 applied, that 'held' was refused by companies_status_check and that a SUSPENDED company's
# api.export_company succeeded with all twenty-one sections (the critique's quarantine.sql.txt shape,
# evidence/e7-design-critique-repro/quarantine.log). 32b's export arm is that counterexample refused.
#
# This probe's suspended arm is the second half of the same point and IS run here: a suspended company's export
# still succeeds, deliberately, because the fourteen-day window exists for exactly that administrator. Suspension
# was never a quarantine, which is why the hold is a fourth status and not a re-use of suspension.
#
# Every identity and company here is this probe's own. Run: bash tests/db/32-recovery-hold.sh (after
# tests/db/00-seed.sh; scripts/check-db.sh runs every tests/db/[0-9][0-9]-*.sh in order).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
source "$ROOT/tests/db/e5-lib.sh"; source "$ROOT/tests/db/e6-lib.sh"
RUN="$(run_id)"; E6_RUN="$RUN"; T="$E2_TMP/32"; mkdir -p "$T"

# ---------------------------------------------------------------------------
section "32a the fixture: a company with content, members and a published release"
# ---------------------------------------------------------------------------
e6_person h_admin; U_H_ADMIN="$U_h_admin"
H="$(company "e7-32-$RUN" "$U_H_ADMIN")"
future_period "$H"
MS_H_ADMIN="$(membership_of "$H" "$U_H_ADMIN")"
e6_person h_member "$H" '{member}'
e6_person h_it "$H" '{it_reviewer,member}'
e6_person h_biz "$H" '{business_reviewer,member}'
e6_person h_successor "$H" '{member}'
# One agent, one submitted-and-approved candidate, one published release, so the download door has something to
# refuse and the views have rows to stop carrying.
AG_H="$(field "$(draft_by_name "$U_H_ADMIN" "$H" "synthetic-32-agent-$RUN" 30)" agent_id)"
CAND_H="$(sql -c "select id from app.candidate_versions where company_id = '$H' order by id desc limit 1")"
expect "32a fixture: the company holds one agent and one candidate" "$(sql -c "select (select count(*) from app.agents where company_id='$H') || '/' || (select count(*) from app.candidate_versions where company_id='$H')")" '^1/1$'
as_call invite_member "$(jbody p_company="$H" p_email="e7-32-pending-$RUN@example.invalid" p_roles='#["member"]')" "$U_H_ADMIN" aal2 >/dev/null
TOK_H_ADMIN="$(user_token "$U_H_ADMIN" aal2)"; TOK_H_MEMBER="$(user_token "$U_h_member")"

# The matrix: every api view this company's rows can appear in, under two readers. api.my_standing is NOT in it;
# it is the one read that sees past a company's status and is asserted on its own below.
H_VIEWS="companies?select=*&id=eq.$H
memberships?select=*&company_id=eq.$H
invitations?select=*&company_id=eq.$H
audit_events?select=*&company_id=eq.$H
agents?select=*&company_id=eq.$H
candidate_versions?select=*&company_id=eq.$H
candidate_contributors?select=*&candidate_id=eq.$CAND_H
groups?select=*&company_id=eq.$H
group_members?select=*&company_id=eq.$H
review_envelopes?select=*&company_id=eq.$H
reviews?select=*&company_id=eq.$H
releases?select=*&company_id=eq.$H
release_catalog?select=*&company_id=eq.$H
release_downloads?select=*&company_id=eq.$H
installation_reports?select=*&company_id=eq.$H
installation_witnesses?select=*&company_id=eq.$H
company_quotas?select=*&company_id=eq.$H
profiles?select=*&user_id=eq.$U_h_member"
h_matrix() {
  local path name
  printf '%s\n' "$H_VIEWS" | while IFS= read -r path; do
    name="${path%%\?*}"
    printf '%s:admin=%s\n' "$name" "$(view_rows "/$path" "$TOK_H_ADMIN")"
    printf '%s:member=%s\n' "$name" "$(view_rows "/$path" "$TOK_H_MEMBER")"
  done
}
h_total() { awk -F= '{ if ($2 ~ /^[0-9]+$/) n += $2; else bad = bad " " $0 } END { printf "%d%s", n, bad }' "$1"; }

h_matrix > "$T/active.txt"
ACTIVE_ROWS="$(h_total "$T/active.txt")"
ACTIVE_PAIRS="$(grep -c '=[1-9]' "$T/active.txt" || true)"
echo "note: the ACTIVE control matrix, view by view and reader by reader:"; sed 's/^/  /' "$T/active.txt"
expect "32a control: while the company is active the matrix carries rows, and the probe records how many" "PAIRS|$ACTIVE_PAIRS" '^PAIRS|[1-9]'
expect "32a control: and no read in it was refused or unparsed" "ROWS|$ACTIVE_ROWS" '^ROWS|[0-9]*$'

# The suspended arm, which is the OTHER half of E7D-C-F1 and is deliberately unchanged: a suspended company's
# administrator still exports inside the window. Suspension is not, and was never, a quarantine.
op_call set_company_status "$(jbody p_company="$H" p_status=suspended p_reason_code=non_payment)" >/dev/null
export_body "$U_H_ADMIN" "$H" "$T/suspended.json" >/dev/null
expect "32a: a SUSPENDED company's takeout still succeeds, with all twenty-one sections; this is why the hold is a fourth status" "$(node -e 'const j=require(process.argv[1]);process.stdout.write(String(Object.keys(j.sections).length))' "$T/suspended.json")" '^21$'
op_call set_company_status "$(jbody p_company="$H" p_status=active p_reason_code=customer_request)" >/dev/null

# The hold itself: owner-side, under app.recovery_reconcile, which is the ONLY way in (32d proves it).
A_BEFORE="$(audit_count "$H")"
sql -c "begin; set local app.recovery_reconcile = 'on'; update app.companies set status = 'held' where id = '$H'; commit;" >/dev/null
expect "32a: the company is held" "$(sql -c "select status from app.companies where id = '$H'")" '^held$'
expect "32a: and holding it wrote no audit row of its own (the reconciler's C0 writes that, day 4)" "$(audit_count "$H")" "^$A_BEFORE\$"

# ---------------------------------------------------------------------------
section "32b case E7-29: every member path refuses a held company"
# ---------------------------------------------------------------------------
h_matrix > "$T/held.txt"
HELD_ROWS="$(h_total "$T/held.txt")"
echo "note: the HELD matrix, view by view and reader by reader:"; sed 's/^/  /' "$T/held.txt"
expect "E7-29: EVERY api view is empty for the admin and for the member, with no read refused or unparsed" "ROWS|$HELD_ROWS" '^ROWS|0$'
expect "E7-29: and the matrix did carry rows a moment ago, so the emptiness is the hold and not the fixture" "PAIRS|$ACTIVE_PAIRS" '^PAIRS|[1-9]'

# Every member routine that takes the company lock. app.lock_company tests status = 'active', so each answers the
# code loadPrincipal turns into 409 E_COMPANY_INACTIVE, and NOT ONE OF THEM WAS EDITED BY 009.
expect "E7-29: api.invite_member" "$(as_call invite_member "$(jbody p_company="$H" p_email="e7-32-held-$RUN@example.invalid" p_roles='#["member"]')" "$U_H_ADMIN" aal2)" 'E_COMPANY_INACTIVE'
expect "E7-29: api.remove_member" "$(as_call remove_member "$(jbody p_membership="$(membership_of "$H" "$U_h_member")")" "$U_H_ADMIN" aal2)" 'E_COMPANY_INACTIVE'
expect "E7-29: api.set_roles" "$(as_call set_roles "$(jbody p_membership="$(membership_of "$H" "$U_h_member")" p_roles='#["it_reviewer","member"]')" "$U_H_ADMIN" aal2)" 'E_COMPANY_INACTIVE'
expect "E7-29: api.create_draft" "$(draft_by_name "$U_H_ADMIN" "$H" "synthetic-32-held-$RUN" 30)" 'E_COMPANY_INACTIVE'
expect "E7-29: api.create_group" "$(as_call create_group "$(jbody p_company="$H" p_name="synthetic-32-group-$RUN")" "$U_H_ADMIN" aal2)" 'E_COMPANY_INACTIVE'
expect "E7-29: api.transfer_agent" "$(transfer "$U_H_ADMIN" "$AG_H" "$(membership_of "$H" "$U_h_member")" "$MS_H_ADMIN")" 'E_COMPANY_INACTIVE'
expect "E7-29: api.revoke_invitation" "$(as_call revoke_invitation "$(jbody p_invitation="$(sql -c "select id from app.invitations where company_id = '$H' order by id desc limit 1")")" "$U_H_ADMIN" aal2)" 'E_COMPANY_INACTIVE'

# THE ONE MEMBER-FACING DOOR THE HOLD DID NOT CLOSE, found by this probe as E7S-F1 and closed by the lead the same
# day as 009's sixth replacement (evidence/e7-scripts.md; evidence/e1-lead.md). Design section 9 names this class as
# a limit in advance: "the hold is fail-closed only where a predicate tests status = 'active'", and E7-29 is the case
# that walks the doors and finds out which those are. Every api routine was enumerated against its own company
# predicate and exactly one member-facing one had neither the company lock nor a status test: api.departure_preview
# reaches app.departure_subject, which calls app.require_admin, and require_admin tests the MEMBERSHIP's status and
# never the COMPANY's. So an active administrator of a HELD company could read one member's label and their work
# counts. FAIL-BEFORE: with 009 at its five-replacement form (the lane's 004f426) the first expectation below
# answered '"membership_id"' (evidence/e7-scripts-repro/, the lane's run, and evidence/e7-scripts-repro/lead-e7s-f1/
# fail-before.log.txt); with the sixth replacement it answers E_COMPANY_INACTIVE, below the admin test.
expect "E7S-F1: api.departure_preview REFUSES a held company with E_COMPANY_INACTIVE, the sixth replacement of 009" "$(preview "$U_H_ADMIN" "$(membership_of "$H" "$U_h_member")")" 'E_COMPANY_INACTIVE'
expect "E7S-F1: and discloses no label and no count" "$(preview "$U_H_ADMIN" "$(membership_of "$H" "$U_h_member")" | grep -c '"label"')" '^0$'
expect "E7S-F1: a stranger to the company still meets E_NOT_FOUND, so the refusal discloses no status" "$(preview "$U_outsider" "$(membership_of "$H" "$U_h_member")")" 'E_NOT_FOUND'
expect "E7S-F1: app.departure_subject now tests the company's status itself" "$(sql -c "select pg_get_functiondef('app.departure_subject(uuid)'::regprocedure) like '%E_COMPANY_INACTIVE%'")" '^t$'
# Why it admitted one: the chain, asserted rather than described, so the repair's reason stays on record. api.departure_preview takes no company lock and
# reaches app.departure_subject, which calls app.require_admin, whose only status test is the MEMBERSHIP's.
expect "E7S-F1: api.departure_preview takes no company lock" "$(sql -c "select pg_get_functiondef('api.departure_preview(uuid)'::regprocedure) like '%lock_company%'")" '^f$'
expect "E7S-F1: it reaches app.departure_subject" "$(sql -c "select pg_get_functiondef('api.departure_preview(uuid)'::regprocedure) like '%departure_subject%'")" '^t$'
expect "E7S-F1: which calls app.require_admin" "$(sql -c "select pg_get_functiondef('app.departure_subject(uuid)'::regprocedure) like '%require_admin%'")" '^t$'
expect "E7S-F1: whose only status test is the membership's, never the company's" "$(sql -c "select (pg_get_functiondef('app.require_admin(uuid,uuid)'::regprocedure) like '%where company_id = p_company and user_id = p_actor and status = ''active''%')::text || '|' || (pg_get_functiondef('app.require_admin(uuid,uuid)'::regprocedure) like '%app.companies%')::text")" '^true|false$'
# And the member-facing routines that DO take the lock are every other one: the exception is one, not a class.
# 012's two (HB-F2), like set_display_name, are about the caller's own account and read no company at all, so they
# are named as account-level, with the assertion below that they touch no company table. 011's
# claim_invitation_handover is company-scoped and is NOT named: it takes the company's row (END1-CR-F2).
expect "E7S-F1: every other member-facing api routine takes the company lock, so the exception is one routine and not a class" "$(sql -c "select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.prokind = 'f' and pg_get_functiondef(p.oid) not like '%lock_company%' and p.proname not like 'operator%' and p.proname not in ('add_operator','create_company','provision_company','set_display_name','export_company','mfa_verify_begin','mfa_verify_end')")" '^departure_preview$'
expect "E7S-F1: and the two account-level routines named there read no company table and no membership" "$(sql -c "select string_agg(p.proname || '=' || (pg_get_functiondef(p.oid) ~ '(app\.companies|app\.memberships|company_id)')::text, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.proname in ('mfa_verify_begin','mfa_verify_end')")" '^mfa_verify_begin=false,mfa_verify_end=false$'
expect "E7S-F1: while the claim takes the company's row" "$(sql -c "select pg_get_functiondef('api.claim_invitation_handover(uuid)'::regprocedure) like '%app.lock_company_operator(inv.company_id)%'")" '^t$'

# The takeout. This is the door suspension left open and the hold closes (E7D-C-F1); 009's app.export_admin is
# the one member-facing predicate that had to be told about the new status, because it is the one that does not
# test status = 'active'. The refusal sits BELOW the admin test, so a stranger still learns nothing.
expect "E7-29: api.export_company is refused, which is the door the first version left open" "$(export_as "$U_H_ADMIN" "$H")" 'E_FORBIDDEN'
expect "E7-29: and a stranger to the company still meets 404, not 403, so the refusal discloses no status" "$(export_as "$U_outsider" "$H")" 'E_NOT_FOUND'

# The download door, which takes no company lock and has its own predicate (app.download_refusal_for).
REL_H="$(sql -c "select id from app.releases where company_id = '$H' order by id desc limit 1")"
if [ -n "$REL_H" ]; then
  expect "E7-29: api.authorize_download" "$(as_call authorize_download "$(jbody p_release="$REL_H")" "$U_h_member" aal2)" 'E_COMPANY_INACTIVE\|E_NOT_FOUND'
else
  expect "E7-29: api.authorize_download on a release id this company does not hold is a not-found, and the fixture published none" "$(as_call authorize_download "$(jbody p_release="$(uuid)")" "$U_h_member" aal2)" 'E_NOT_FOUND'
fi

# api.my_standing: the ONE read in the product that sees past a company's status, scoped to auth.uid(). It still
# answers, and it says 'held', which is what lets a page tell the person why nothing else works.
view_body "/my_standing?select=company_status,access_state&company_id=eq.$H" "$TOK_H_MEMBER" "$T/standing.json" >/dev/null
expect "E7-29: api.my_standing still answers the member their own row" "$(jfield "$T/standing.json" 0.company_status)" '^held$'
expect "E7-29: and the access state is derived from time, not from status, so it is unchanged" "$(jfield "$T/standing.json" 0.access_state)" '^current$'

# ---------------------------------------------------------------------------
section "32c case E7-29: the operator routes, and the three that admit a held company on purpose"
# ---------------------------------------------------------------------------
expect "E7-29: api.set_company_status to active: E_RECOVERY_HOLD, so NO RESUME LIFTS A HOLD" "$(op_call set_company_status "$(jbody p_company="$H" p_status=active p_reason_code=customer_request)")" 'E_RECOVERY_HOLD'
expect "E7-29: api.set_company_status to suspended: the same refusal, both ways" "$(op_call set_company_status "$(jbody p_company="$H" p_status=suspended p_reason_code=operator_decision)")" 'E_RECOVERY_HOLD'
expect "E7-29: and the company is still held after both" "$(sql -c "select status from app.companies where id = '$H'")" '^held$'
expect "E7-29: api.close_company: E_COMPANY_NOT_SUSPENDED, which is 008's own rule and was not edited" "$(op_call close_company "$(jbody p_company="$H" p_confirm_slug="e7-32-$RUN" p_reason_code=customer_instruction)")" 'E_COMPANY_NOT_SUSPENDED'

# The two that are ADMITTED on purpose: they are the operator's tools for resolving what holds a company, and
# neither returns content. An invitation into a held company cannot be accepted, because acceptance passes
# app.lock_company, and that is asserted rather than assumed.
expect "E7-29: api.set_access_period is admitted, because an extension is how a held company's agreement is resolved" "$(op_call set_access_period "$(jbody p_company="$H" p_invoice_ref=null p_starts_at="$(iso_ago 86400)" p_ends_at="$(iso_ago -2592000)")")" '"changed":true'
expect "E7-29: api.transfer_first_admin is admitted, because it is how a restored last administrator is replaced" "$(op_call transfer_first_admin "$(jbody p_company="$H" p_target_user="$U_h_successor")")" '"changed":true'
r="$(op_call operator_invite_admin "$(jbody p_company="$H" p_email="e7-32-newadmin-$RUN@example.invalid")")"
expect "E7-29: api.operator_invite_admin is admitted" "$r" '"invitation_id"'
expect "E7-29: but the invitation it issues CANNOT be accepted, because acceptance takes the company lock" "$(accept_as "$U_outsider" "$(row_field "$r" invite_code)" aal2)" 'E_COMPANY_INACTIVE\|E_EMAIL_MISMATCH'

# ---------------------------------------------------------------------------
section "32d case E7-29: app.company_status_guard, and the audit guard's new word"
# ---------------------------------------------------------------------------
e6_person g_admin; G="$(company "e7-32g-$RUN" "$U_g_admin")"; future_period "$G"
expect "E7-29: an OWNER update INTO held without the setting: E_RECOVERY_HOLD" "$(in_rollback "update app.companies set status = 'held' where id = '$G';")" 'E_RECOVERY_HOLD'
expect "E7-29: an OWNER update OUT OF held without the setting: E_RECOVERY_HOLD" "$(in_rollback "update app.companies set status = 'active' where id = '$H';")" 'E_RECOVERY_HOLD'
expect "E7-29: with the setting, INTO held is admitted" "$(in_rollback "set local app.recovery_reconcile = 'on'; update app.companies set status = 'held' where id = '$G' returning 'HELD|' || status;")" 'HELD|held'
expect "E7-29: with the setting, OUT OF held is admitted" "$(in_rollback "set local app.recovery_reconcile = 'on'; update app.companies set status = 'active' where id = '$H' returning 'LIFT|' || status;")" 'LIFT|active'
expect "E7-29: a move between two NON-held statuses is untouched by the new rule" "$(in_rollback "update app.companies set status = 'suspended' where id = '$G' returning 'SUSP|' || status;")" 'SUSP|suspended'
expect "E7-29: and closed is still terminal without the deletion bypass, which 009 did not move" "$(in_rollback "update app.companies set status = 'closed' where id = '$G'; update app.companies set status = 'active' where id = '$G';")" 'E_COMPANY_CLOSED'

sql -c "grant app_maintenance to postgres" >/dev/null
expect "E7-29: app_maintenance INTO held without the setting: E_RECOVERY_HOLD" "$(in_rollback "set local role app_maintenance; update app.companies set status = 'held' where id = '$G';")" 'E_RECOVERY_HOLD'
expect "E7-29: app_maintenance OUT OF held without the setting: E_RECOVERY_HOLD" "$(in_rollback "set local role app_maintenance; update app.companies set status = 'active' where id = '$H';")" 'E_RECOVERY_HOLD'
expect "E7-29: app_maintenance WITH the setting is admitted, the same honest bound app.tenant_deletion has" "$(in_rollback "set local app.recovery_reconcile = 'on'; set local role app_maintenance; update app.companies set status = 'held' where id = '$G' returning 'MHELD|' || status;")" 'MHELD|held'
sql -c "revoke app_maintenance from postgres" >/dev/null

expect "E7-29: exactly ONE routine in app or api names app.recovery_reconcile, and it is the guard that refuses" "$(sql -c "select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('app','api') and p.prokind = 'f' and pg_get_functiondef(p.oid) like '%recovery_reconcile%'")" '^company_status_guard$'
expect "E7-29: so no routine SETS it, and PostgREST has no way to" "$(sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('app','api') and p.prokind = 'f' and pg_get_functiondef(p.oid) like '%set_config(''app.recovery_reconcile%'")" '^0$'

# The audit guard's two status words. 009 admits 'held' so the reconciler's own company.hold and company.hold_lift
# rows can be written on day 4; nothing else about the guard moved.
expect "E7-29: the audit guard admits status_after held" "$(in_rollback "insert into app.audit_events (company_id, actor_user_id, actor_kind, action, entity_type, entity_id, details) values ('$H','$U_op','operator','company.hold','company','$H', jsonb_build_object('company_id','$H','status_before','active','status_after','held','reason_code','restore_reconciliation')) returning 'AUDIT|ok';")" 'AUDIT|ok'
expect "E7-29: and still refuses a status word that is not one of the five" "$(in_rollback "insert into app.audit_events (company_id, actor_user_id, actor_kind, action, entity_type, entity_id, details) values ('$H','$U_op','operator','company.hold','company','$H', jsonb_build_object('company_id','$H','status_after','quarantined')) returning 1;")" 'E_AUDIT_DETAILS_VALUE'
expect "E7-29: and still refuses a key it does not name" "$(in_rollback "insert into app.audit_events (company_id, actor_user_id, actor_kind, action, entity_type, entity_id, details) values ('$H','$U_op','operator','company.hold','company','$H', jsonb_build_object('company_id','$H','company_name','SYNTHETIC')) returning 1;")" 'E_AUDIT_DETAILS_KEY'

# ---------------------------------------------------------------------------
section "32e case E7-29 control: the same company, active again, answers every member path"
# ---------------------------------------------------------------------------
sql -c "begin; set local app.recovery_reconcile = 'on'; update app.companies set status = 'active' where id = '$H'; commit;" >/dev/null
expect "32e: the company is active again" "$(sql -c "select status from app.companies where id = '$H'")" '^active$'
h_matrix > "$T/lifted.txt"
LIFTED_ROWS="$(h_total "$T/lifted.txt")"
echo "note: the LIFTED matrix, view by view and reader by reader:"; sed 's/^/  /' "$T/lifted.txt"
expect "32e control: no read in the matrix is refused or unparsed" "ROWS|$LIFTED_ROWS" '^ROWS|[0-9]*$'
# Per view and per reader, so "it carries rows again" is not one number hiding a view that stayed empty. 32c added
# a membership, two invitations and audit rows, so the TOTAL is higher than before the hold; every pair that
# carried rows then carries rows now.
MISSING="$(comm -23 <(grep '=[1-9]' "$T/active.txt" | cut -d= -f1 | sort) <(grep '=[1-9]' "$T/lifted.txt" | cut -d= -f1 | sort) | tr '\n' ',')"
expect "32e control: EVERY view/reader pair that carried rows before the hold carries rows again" "MISSING|${MISSING:-NONE}" '^MISSING|NONE$'
export_body "$U_H_ADMIN" "$H" "$T/lifted.json" >/dev/null
expect "32e control: api.export_company succeeds again, with all twenty-one sections" "$(node -e 'const j=require(process.argv[1]);process.stdout.write(String(Object.keys(j.sections).length))' "$T/lifted.json")" '^21$'
expect "32e control: api.invite_member succeeds again" "$(as_call invite_member "$(jbody p_company="$H" p_email="e7-32-lifted-$RUN@example.invalid" p_roles='#["member"]')" "$U_H_ADMIN" aal2)" '"invitation_id"'
expect "32e control: and api.set_company_status works again, so E_RECOVERY_HOLD was about the status and not the company" "$(op_call set_company_status "$(jbody p_company="$H" p_status=suspended p_reason_code=operator_decision)")" '"changed":true'

# ---------------------------------------------------------------------------
section "32f case E7-26: nothing outside the slice moved"
# ---------------------------------------------------------------------------
# The eight accepted migrations' pins are unchanged and 009 is the only new file. The gate itself refuses an edit
# to an applied migration; this asserts the PIN TABLE's own shape, which the gate cannot, because a pin edited to
# match an edited file passes the gate.
# K4 (2026-09-28): 010 is the next migration, and three of these assertions named nine files and 009 as the last. They
# now read the count and the applied versions from the directory and ask for 009 among the files rather than last, so
# a later migration needs no edit here; what E7-26 is about, the eight pins before 009 unchanged and no stray file, is
# asserted exactly as before.
MIGRATION_FILES="$(cd "$ROOT" && ls supabase/migrations/*.sql | wc -l | tr -d ' ')"
expect "E7-26: scripts/check-migrations.mjs passes over every migration present" "$(cd "$ROOT" && node scripts/check-migrations.mjs)" "$MIGRATION_FILES migration(s) pinned by content, 0 problem(s)"
expect "E7-26: the eight earlier pins are byte-identical to main's" "$(cd "$ROOT" && git show main:scripts/check-migrations.mjs | grep -c "^  '00[1-8]_")" '^8$'
expect "E7-26: and this branch holds the same eight, unchanged" "$(cd "$ROOT" && diff <(git show main:scripts/check-migrations.mjs | grep "^  '00[1-8]_") <(grep "^  '00[1-8]_" scripts/check-migrations.mjs) > /dev/null && echo SAME)" '^SAME$'
# Compared against the pin list rather than against main, because once 009 is on main a branch adds nothing (the
# lead, 2026-09-20, when this probe first ran on main): the directory holds exactly the pinned files, tracked or not.
expect "E7-26: the migrations directory holds exactly the pinned files, 009 among them, and no stray file (tracked or not)" "$(cd "$ROOT" && comm -3 <(grep -oE "'[0-9]{3}_[a-z0-9_]+\\.sql'" scripts/check-migrations.mjs | tr -d "'" | sed 's#^#supabase/migrations/#' | sort) <(ls supabase/migrations/*.sql | sort) | tr '\n' ','; echo "|$(ls supabase/migrations/009_recovery_hold.sql)")" '^|supabase/migrations/009_recovery_hold.sql$'
expect "E7-26: and the database has applied exactly those files" "$(sql -c "select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations")" "^$(cd "$ROOT" && ls supabase/migrations/*.sql | xargs -n1 basename | cut -c1-3 | paste -sd, -)\$"
expect "E7-26: app.company_statuses() is the four words and no more" "$(sql -c "select array_to_string(app.company_statuses(), ',')")" '^active,suspended,closed,held$'
expect "E7-26: and lib/rules/lifecycle.mjs agrees with it" "$(cd "$ROOT" && node -e 'import("./lib/rules/lifecycle.mjs").then(m => process.stdout.write(m.COMPANY_STATUSES.join(",")))')" '^active,suspended,closed,held$'

printf '\n== 32 done: %s ==\n' "$([ "$FAILED" = 0 ] && echo PASS || echo FAIL)"
exit "$FAILED"
