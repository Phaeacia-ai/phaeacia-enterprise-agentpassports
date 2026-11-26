#!/usr/bin/env bash
# Probe 30: the export, the one deletion door and the deletion's dates (docs/e6/design.md 1.6, 2.4, 2.5, 3.5;
# section 5 cases 24, 25, 26, 28 and 40, with the fail-before of 24, 25, 26 and 40). Case 27, the deletion racing an
# admin mutation, is probe 31's, because it needs two connections.
#   30a setup: one company with rows in all twenty-one export sections, and a draft by a second author
#   30b case 24: the export is complete, and honest about what it is not; the isolation is read from inside the
#       real RPC through PostgREST, which is F9's code-review obligation
#   30c case 25: the export is bounded at both gates, with the fail-before that has only gate 1
#   30d case 26: the one door, table by table and role by role, with the fail-before that admits an UPDATE
#   30e case 28: the deletion's own record survives and accounts do not go with it
#   30f case 40: the deletion's dates and the closure's export-window rule, with both fail-befores
#   30i E6S-C-F3: the takeout of a SUSPENDED company inside its window, with the fail-before that is the one
#       predicate the integrated revision used
# Run: bash tests/db/30-deletion.sh (after tests/db/00-seed.sh and the probes before it).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
source "$ROOT/tests/db/e5-lib.sh"; source "$ROOT/tests/db/e6-lib.sh"; source "$ROOT/tests/db/e7-lib.sh"
RUN="$(run_id)"; E6_RUN="$RUN"; T="$E2_TMP/30"; mkdir -p "$T"
DL0="$(deadlocks)"
apply_fixture e6-mutate.sql

env_of() { field "$(envelope "$@")" envelope_id; }
publish_sub() { publish "$1" "$2" "$3" "$(expected_sha "$2" "$4")" @uuid --aal aal2; }

# ---------------------------------------------------------------------------
section "30a setup: a company with rows in all twenty-one export sections, and a draft by a second author"
# ---------------------------------------------------------------------------
e6_person a_admin; U_A="$U_a_admin"
W="$(company "e6-30w-$RUN" "$U_A")"
MS_A="$(membership_of "$W" "$U_A")"
e6_person author "$W" '{member}'; e6_person other "$W" '{member}'
e6_person it_rev "$W" '{it_reviewer,member}'; e6_person biz_rev "$W" '{business_reviewer,member}'
e6_person recip "$W" '{member}'
U_I="$U_it_rev"; U_B="$U_biz_rev"
sql -c "insert into app.profiles (user_id, display_name) values ('$U_author', 'SYNTHETIC Wilhelmina Quillfeather')
        on conflict (user_id) do update set display_name = excluded.display_name" >/dev/null
GR="$(group_of "$W" "$MS_A" "Audience-30-$RUN" "$MS_recip")"
AUD="$(audience "$GR")"
enable_target claude-ai
echo "note: owner-side setup, as design 1.3 labels it: claude-ai enabled for publication under the registry bypass"
CAND="$(submitted "$U_author" "$W" "synthetic-30-brief-$RUN" 30)"
AG="$(sql -c "select agent_id from app.candidate_versions where id = '$CAND'")"
ENV="$(env_of "$U_author" "$CAND" claude-ai "$AUD")"
expect "setup: IT approves" "$(review "$U_I" "$CAND" "$ENV" it approved "IT: fine.")" 'HTTP 200'
expect "setup: business approves" "$(review "$U_B" "$CAND" "$ENV" business approved "Business: fine.")" 'HTTP 200'
PR="$(publish_sub "$U_A" "$CAND" "$ENV" claude-ai)"
REL="$(field "$PR" release_id)"
expect "setup: a released candidate" "$REL" '^[0-9a-f-]\{36\}$'
expect "setup: the recipient downloads it" "$(download_as "$U_recip" "$REL")" '^HTTP 200'
expect "setup: and reports" "$(report "$U_recip" "$REL" pass null null)" 'HTTP 200'
RPT="$(field "$(report "$U_recip" "$REL" partial "The calendar read is unavailable on this plan." "The owner supplied the folder path by chat.")" report_id)"
expect "setup: and a witness confirms" "$(witness "$U_I" "$RPT" pass "IT confirms on her machine.")" 'HTTP 200'
# The second author's draft, which the admin may NOT read (E1 section 6, app.candidate_visible_to).
DRAFT="$(field "$(draft_by_name "$U_other" "$W" "synthetic-30-secret-$RUN" 30)" candidate_id)"
expect "setup: a draft by a second author exists" "$DRAFT" '^[0-9a-f-]\{36\}$'
expect "setup: and its contributor rows with it" "$(sql -c "select count(*) >= 1 from app.candidate_contributors where candidate_id = '$DRAFT'")" '^t$'
expect "setup: the calling admin may not read it, which is what app.candidate_visible_to says" "$(sql -c "select app.candidate_visible_to('$DRAFT', '$U_A')")" '^f$'
future_period "$W"
expect "setup: one quota override, so the company_quotas section is not empty" "$(op_call set_company_quota "$(jbody p_company="$W" p_name=groups_per_company p_value='#60')")" '"value":60'
expect "setup: one pending invitation, so the invitations section is not empty" "$(as_call invite_member "$(jbody p_company="$W" p_email="e6-30-pending-$RUN@example.invalid" p_roles='#["member"]')" "$U_A" aal2)" '"invite_code"'
op_body operator_export_manifest "$(jbody p_company="$W")" "$T/manifest.txt" >/dev/null
EMPTY="$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const s = j.export_manifest.sections;
  const empty = Object.keys(s).filter((k) => s[k] === 0);
  process.stdout.write(empty.length ? empty.join(",") : "NONE");' "$T/manifest.txt")"
expect "setup: every one of the twenty-one sections holds at least one row" "$EMPTY" '^NONE$'

# ---------------------------------------------------------------------------
section "30b case 24: the export is complete, and honest about what it is not"
# ---------------------------------------------------------------------------
# The audit count is taken BEFORE the export, because the export writes its own audit row in the same transaction:
# the document's snapshot precedes that insert and an owner-side count afterwards does not (E6DB-F15).
AUDIT_BEFORE="$(audit_count "$W")"
expect "case 24: the export answers" "$(export_body "$U_A" "$W" "$T/export.json")" '^HTTP 200$'
expect "case 24: twenty-one sections, exactly the list of design 1.6" "$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(Object.keys(j.sections).sort().join(","));' "$T/export.json")|$(sql -c "select string_agg(n, ',' order by n) from unnest(app.export_section_names()) n")" \
  "^$(sql -c "select string_agg(n, ',' order by n) from unnest(app.export_section_names()) n")|"
# Every count equals an owner-side count OF WHAT THAT ADMIN MAY READ.
for s in memberships invitations profiles groups group_members agents review_envelopes reviews releases \
         release_downloads installation_reports installation_witnesses audit_events company_quotas; do
  case "$s" in
    profiles) q="select count(*) from app.profiles f where exists (select 1 from app.memberships m where m.company_id = '$W' and m.user_id = f.user_id)" ;;
    audit_events) q="select $AUDIT_BEFORE" ;;
    *) q="select count(*) from app.$s where company_id = '$W'" ;;
  esac
  expect "case 24: the $s count equals an owner-side count" "$(jfield "$T/export.json" "counts.$s")" "^$(sql -c "$q")\$"
done
# The owner-side comparison writes the RULE out rather than calling the predicate the document was built with
# (app.export_candidate_visible since E6S-C-F3): a count taken with the routine's own predicate agrees with the
# routine by construction and would pass whatever either of them did. The rule for a company admin is the admin's
# own rows plus everything that is not still a draft.
expect "case 24: candidate_versions carries the admin's readable rows only" "$(jfield "$T/export.json" counts.candidate_versions)" "^$(sql -c "select count(*) from app.candidate_versions v where v.company_id = '$W' and (v.author_membership_id = '$MS_A' or v.state <> 'draft')")\$"
# The draft's ID does appear once in the document, inside an audit row, which is an admin-readable fact that E2's
# own policy already grants: what must be absent is the draft ROW and its content (E6DB-F16).
expect "case 24: the second author's draft ROW is absent from the candidate_versions section" "$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(j.sections.candidate_versions.some((v) => v.id === process.argv[2])));' "$T/export.json" "$DRAFT")" '^false$'
expect "case 24: and its contributor rows went with it" "$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(j.sections.candidate_contributors.some((r) => r.candidate_id === process.argv[2])));' "$T/export.json" "$DRAFT")" '^false$'
expect "case 24: withheld.candidate_versions.rows is one, with reason another_author_draft" "$(jfield "$T/export.json" withheld.candidate_versions.rows)|$(jfield "$T/export.json" withheld.candidate_versions.reason)" '^1|another_author_draft$'
expect "case 24: its contributor rows went with it and are counted too" "$(jfield "$T/export.json" withheld.candidate_contributors.reason)" '^another_author_draft$'
expect "case 24: access_periods is withheld entirely, with reason no_admin_read_predicate" "$(jfield "$T/export.json" withheld.access_periods.reason)" '^no_admin_read_predicate$'
expect "case 24: and its section is empty rather than absent, so counts and withheld can both name it" "$(jfield "$T/export.json" counts.access_periods)" '^0$'
expect "case 24: withheld is PRESENT even when a section withheld nothing, so a reader can tell that from an older export" "$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(typeof j.withheld === "object" && j.withheld !== null ? "present" : "absent");' "$T/export.json")" '^present$'
expect "case 24: no invitation row carries a token_hash key" "$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(j.sections.invitations.some((i) => "token_hash" in i)));' "$T/export.json")" '^false$'
expect "case 24: and the only place those words appear is the omitted array" "COUNT|$(grep -c 'token_hash' "$T/export.json" || true)" '^COUNT|1$'
expect "case 24: no auth.users row and no operators row appears" "COUNT|$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(["auth", "users", "operators", "operator_allowlist"].filter((k) => k in j.sections).length));' "$T/export.json")" '^COUNT|0$'
expect "case 24: the omitted array names each excluded thing" "$(jfield "$T/export.json" omitted)" 'invitations.token_hash'
expect "case 24: including idempotency_keys, auth.users and access_periods" "$(jfield "$T/export.json" omitted)" 'access_periods'
expect "case 24: a release's assembled_content in the export hashes to its assembled_sha256" "$(node -e '
  const c = require("node:crypto");
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const r = j.sections.releases[0];
  const h = c.createHash("sha256").update(Buffer.from(r.assembled_content, "utf8")).digest("hex");
  process.stdout.write(h === r.assembled_sha256 ? "equal" : h + " vs " + r.assembled_sha256);' "$T/export.json")" '^equal$'
expect "case 24: the export wrote one company.export audit row, with its section counts and its serialized bytes" "$(sql -c "select (details ? 'section_counts')::text || '|' || (details ? 'serialized_bytes')::text from app.audit_events where company_id = '$W' and action = 'company.export'")" '^true|true$'
expect "case 24: and its withheld_rows equals what the document's withheld object totals, so audit and document agree" "$(sql -c "select details ->> 'withheld_rows' from app.audit_events where company_id = '$W' and action = 'company.export'")" "^$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(Object.values(j.withheld).reduce((n, w) => n + w.rows, 0)));' "$T/export.json")\$"
expect "case 24: its actor_kind is member, always, because the operator is no longer a caller" "$(sql -c "select actor_kind from app.audit_events where company_id = '$W' and action = 'company.export'")" '^member$'
# F9's code-review obligation: the isolation is read from inside the REAL RPC through PostgREST.
expect "case 24: the export's own setting is repeatable read" "$(sql -c "select unnest(proconfig) from pg_proc where proname = 'export_company' and pronamespace = 'api'::regnamespace")" 'default_transaction_isolation=repeatable read'
save_routine 'api.export_company(uuid)' export_isolation
apply_fixture e6-export-reads-isolation.sql
r="$(export_body "$U_A" "$W" "$T/iso.json")"
expect "case 24 (F9's code-review obligation): current_setting('transaction_isolation') READ FROM INSIDE THE REAL RPC is repeatable read" "$(jfield "$T/iso.json" observed_isolation)" '^repeatable read$'
restore_routine export_isolation
expect "case 24: and the routine stays VOLATILE, because it writes the audit row" "$(sql -c "select provolatile from pg_proc where proname = 'export_company' and pronamespace = 'api'::regnamespace")" '^v$'
# fail-before (1): a mutant missing installation_witnesses fails the section list; one missing release_downloads
# fails E5 1.7 item 1.
save_routine 'api.export_company(uuid)' export_sections
apply_fixture e6-export-missing-witnesses-mutant.sql
export_body "$U_A" "$W" "$T/export-nowit.json" >/dev/null
expect "fail-before case 24: a routine missing installation_witnesses answers a document with twenty sections" "$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(Object.keys(j.sections).length));' "$T/export-nowit.json")" '^20$'
expect "fail-before case 24: and the section list no longer matches app.export_section_names()" "COUNT|$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String("installation_witnesses" in j.sections));' "$T/export-nowit.json")" '^COUNT|false$'
restore_routine export_sections
apply_fixture e6-export-missing-downloads-mutant.sql
export_body "$U_A" "$W" "$T/export-nodl.json" >/dev/null
expect "fail-before case 24: a routine missing release_downloads breaks E5 1.7 item 1" "COUNT|$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String("release_downloads" in j.sections));' "$T/export-nodl.json")" '^COUNT|false$'
restore_routine export_sections
# fail-before (2): the UNFILTERED candidate select emits the second author's draft, and the string search finds it.
save_routine 'api.export_company(uuid)' export_filter
apply_fixture e6-export-unfiltered-candidates-mutant.sql
export_body "$U_A" "$W" "$T/export-unfiltered.json" >/dev/null
expect "fail-before case 24: the unfiltered select emits the second author's draft ROW" "$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(j.sections.candidate_versions.some((v) => v.id === process.argv[2])));' "$T/export-unfiltered.json" "$DRAFT")" '^true$'
expect "fail-before case 24: and the row carries its CONTENT, which is the read E1 section 6 denies" "$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const v = j.sections.candidate_versions.find((x) => x.id === process.argv[2]);
  process.stdout.write(String(typeof v.content === "string" && v.content.length > 100));' "$T/export-unfiltered.json" "$DRAFT")" '^true$'
expect "fail-before case 24: and one more candidate row than the filtered document carried" "$(node -e '
  const a = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const b = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
  process.stdout.write(String(a.counts.candidate_versions - b.counts.candidate_versions));' "$T/export-unfiltered.json" "$T/export.json")" '^1$'
expect "fail-before case 24: and withheld.candidate_versions is then absent, so the file claims to be the whole tenant" "COUNT|$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String("candidate_versions" in j.withheld));' "$T/export-unfiltered.json")" '^COUNT|false$'
restore_routine export_filter
export_body "$U_A" "$W" "$T/export-again.json" >/dev/null
expect "fail-before case 24: restored, and the draft row is withheld again" "$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(j.sections.candidate_versions.some((v) => v.id === process.argv[2])));' "$T/export-again.json" "$DRAFT")" '^false$'
# fail-befores (3) and (4), which are ONE arm, because each needs the other's condition (E6DB-F17). PostgREST reads a
# function's default_transaction_isolation from its SCHEMA CACHE and sets the level on the transaction it opens, so
# resetting the function's setting does not reach the running service until the cache reloads. And PostgreSQL accepts
# `set transaction isolation level <the level already in force>` after a query and refuses only a level that would
# CHANGE: with the alter function still in place the inline statement is a silent no-op, so a reviewer testing it
# alone would see it pass. Both fail-befores therefore run with the setting reset and the cache reloaded.
save_routine 'api.export_company(uuid)' export_iso_both
apply_fixture e6-export-reads-isolation.sql
sql -c "alter function api.export_company(uuid) reset default_transaction_isolation" >/dev/null
pgrst_reload
expect "fail-before case 24: WITHOUT the function's own setting the same read answers read committed" "$(wait_isolation "$U_A" "$W" 'read committed' "$T/iso-none.json" && jfield "$T/iso-none.json" observed_isolation)" '^read committed$'
apply_fixture e6-export-inline-isolation-mutant.sql
expect "fail-before case 24: and SET TRANSACTION ISOLATION LEVEL inside the body then raises SQLSTATE 25001 on the real RPC" "$(export_as "$U_A" "$W")" '25001'
restore_routine export_iso_both
pgrst_reload
expect "fail-before case 24: restored, and the function's own setting is back" "$(sql -c "select unnest(proconfig) from pg_proc where proname = 'export_company' and pronamespace = 'api'::regnamespace")" 'repeatable read'
save_routine 'api.export_company(uuid)' export_iso_check
apply_fixture e6-export-reads-isolation.sql
expect "fail-before case 24: and the real RPC is at repeatable read again" "$(wait_isolation "$U_A" "$W" 'repeatable read' "$T/iso-back.json" && jfield "$T/iso-back.json" observed_isolation)" '^repeatable read$'
restore_routine export_iso_check

# ---------------------------------------------------------------------------
section "30i E6S-C-F3: the takeout during the suspension the fourteen-day window exists for"
# ---------------------------------------------------------------------------
# The window of design 1.5 IS the suspended case: api.operator_expiry_run suspends at export_by and the
# customer's own copy is what the fourteen days exist for. app.candidate_visible_to reaches app.membership_of,
# which joins app.companies ON status = 'active', so every candidate row fell out of the document and `withheld`
# called the loss another_author_draft. The company built in 30a is the critique's case exactly: one submitted,
# approved and released candidate, a second author's draft that must stay withheld, and contributor rows on both.
expect "30i: the company is active and inside its window" "$(sql -c "select status from app.companies where id = '$W'")|$(access_state "$W")" '^active|current$'
export_body "$U_A" "$W" "$T/f3-active.json" >/dev/null
F3_CAND="$(jfield "$T/f3-active.json" counts.candidate_versions)"
F3_CONTRIB="$(jfield "$T/f3-active.json" counts.candidate_contributors)"
F3_REL="$(jfield "$T/f3-active.json" counts.releases)"
expect "30i: the active company's copy carries its candidate, its contributors and its release" "$F3_CAND|$F3_CONTRIB|$F3_REL" '^[1-9][0-9]*|[1-9][0-9]*|[1-9][0-9]*$'
expect "30i: the operator suspends it, which is what the sweep does at export_by" "$(op_call set_company_status "$(jbody p_company="$W" p_status=suspended p_reason_code=non_payment)")" '"status":"suspended"'
export_body "$U_A" "$W" "$T/f3-suspended.json" >/dev/null
expect "30i: the suspended company's copy answers 200 for the same admin at aal2" "$(export_body "$U_A" "$W" "$T/f3-suspended.json")" '^HTTP 200$'
expect "30i: and carries the SAME candidate count" "$(jfield "$T/f3-suspended.json" counts.candidate_versions)" "^$F3_CAND\$"
expect "30i: the SAME contributor count" "$(jfield "$T/f3-suspended.json" counts.candidate_contributors)" "^$F3_CONTRIB\$"
expect "30i: and the SAME release count, which never moved and is what made the loss look like a filter" "$(jfield "$T/f3-suspended.json" counts.releases)" "^$F3_REL\$"
expect "30i: the released candidate's own row is in the document" "$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(j.sections.candidate_versions.some((v) => v.id === process.argv[2])));' "$T/f3-suspended.json" "$CAND")" '^true$'
expect "30i: with its content, which is what the customer is taking a copy OF" "$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const v = j.sections.candidate_versions.find((x) => x.id === process.argv[2]);
  process.stdout.write(String(typeof v.content === "string" && v.content.length > 20));' "$T/f3-suspended.json" "$CAND")" '^true$'
expect "30i: the second author's draft is STILL withheld, because the suspension changed nothing about that rule" "$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(j.sections.candidate_versions.some((v) => v.id === process.argv[2])));' "$T/f3-suspended.json" "$DRAFT")" '^false$'
expect "30i: and withheld names exactly that one row, with the reason that is now true of it" "$(jfield "$T/f3-suspended.json" withheld.candidate_versions.rows)|$(jfield "$T/f3-suspended.json" withheld.candidate_versions.reason)" '^1|another_author_draft$'
expect "30i: the withheld count equals an owner-side count of the rows that ARE another author's unsubmitted draft" "$(jfield "$T/f3-suspended.json" withheld.candidate_versions.rows)" "^$(sql -c "select count(*) from app.candidate_versions v where v.company_id = '$W' and v.state = 'draft' and v.author_membership_id <> '$MS_A'")\$"
# The two authorities the takeout predicate keeps, tested against the suspended company so the correction cannot
# be read as "suspension opens the door".
expect "30i: a plain MEMBER of the suspended company is still refused: the role test is unchanged" "$(export_as "$U_recip" "$W")" 'E_FORBIDDEN'
expect "30i: the same admin at aal1 is still 403 E_ADMIN_MFA_REQUIRED" "$(export_as "$U_A" "$W" aal1)" 'E_ADMIN_MFA_REQUIRED'
expect "30i: and an operator is still 404, because there is no operator arm" "$(op_call export_company "$(jbody p_company="$W")")" 'E_NOT_FOUND'
# fail-before: the ONE difference, app.candidate_visible_to in place of app.export_candidate_visible.
apply_fixture e6-mutate.sql   # tests.e6_mutate, so the mutant is this routine's own live definition
save_routine 'api.export_company(uuid)' f3_export
e6_mutate 'api.export_company(uuid)' 'app.export_candidate_visible(v.id, me.id)' \
  'app.candidate_visible_to(v.id, actor)'
export_body "$U_A" "$W" "$T/f3-mutant.json" >/dev/null
expect "fail-before 30i: with app.candidate_visible_to the suspended company's copy carries ZERO candidates" "$(jfield "$T/f3-mutant.json" counts.candidate_versions)" '^0$'
expect "fail-before 30i: and zero contributor rows" "$(jfield "$T/f3-mutant.json" counts.candidate_contributors)" '^0$'
expect "fail-before 30i: while the release count does not move, so the document contradicts itself" "$(jfield "$T/f3-mutant.json" counts.releases)" "^$F3_REL\$"
expect "fail-before 30i: and withheld MISLABELS every candidate of the company, the submitted one included, as another author's draft" "$(jfield "$T/f3-mutant.json" withheld.candidate_versions.rows)|$(jfield "$T/f3-mutant.json" withheld.candidate_versions.reason)" "^$(sql -c "select count(*) from app.candidate_versions where company_id = '$W'")|another_author_draft\$"
restore_routine f3_export
export_body "$U_A" "$W" "$T/f3-restored.json" >/dev/null
expect "fail-before 30i: restored, and the candidate is in the document again" "$(jfield "$T/f3-restored.json" counts.candidate_versions)" "^$F3_CAND\$"
# Closure still refuses, which is where the status test belongs and where it stayed.
expect "30i: the company is resumed for the sections below" "$(op_call set_company_status "$(jbody p_company="$W" p_status=active p_reason_code=customer_request)")" '"status":"active"'

# ---------------------------------------------------------------------------
section "30c case 25: the export is bounded at both gates"
# ---------------------------------------------------------------------------
# (c) FIRST, the company just below the ceiling, so the comparison of its two numbers is recorded before anything is
# seeded above it: this is the number that decides whether 4 MiB is right, and it is RECORDED, not asserted.
export_body "$U_A" "$W" "$T/export-small.json" >/dev/null
WIRE="$(wire_bytes "$T/export-small.json")"
ROUTINE="$(sql -c "select details ->> 'serialized_bytes' from app.audit_events where company_id = '$W' and action = 'company.export' order by id desc limit 1")"
echo "recorded, case 25c: octet_length(doc::text) inside the routine = $ROUTINE bytes; the body on the wire = $WIRE bytes; the ceiling is $(sql -c "select app.limit_export_bytes()")"
expect "case 25c: a company under the ceiling exports, and the two numbers are within one per cent of each other" "$(node -e '
  const [a, b] = process.argv.slice(1).map(Number);
  process.stdout.write(Math.abs(a - b) <= Math.max(a, b) * 0.01 ? "within" : a + " vs " + b);' "$ROUTINE" "$WIRE")" '^within$'
# (a) a company whose CONTENT alone is far above the ceiling: gate 1 refuses before anything is assembled.
# THE BUILDER MOVED to tests/db/e7-lib.sh on 2026-09-20 (E7 design 1.2): E7's case E7-12 raises the same fixture
# to run the owner-side copy script against it, closing E6 section 9's readiness dependency, and one body of code
# is what keeps the two from drifting into companies that are "oversized" in different ways. What it builds is
# unchanged, and THE CASE 25a PROBE BELOW DID NOT MOVE: its assertions and their order are what they were.
e6_person big_admin; U_BIG="$U_big_admin"
BIG="$(build_oversized_company "$RUN" "$U_BIG")"
assert_oversized "$BIG"
A_BIG="$(audit_count "$BIG")"
expect "case 25a: gate 1 refuses: E_EXPORT_TOO_LARGE" "$(export_as "$U_BIG" "$BIG")" 'E_EXPORT_TOO_LARGE'
expect "case 25a: and no audit row was written, so nothing was emitted" "$(audit_count "$BIG")" "^$A_BIG\$"
# (b) a company whose content is UNDER the ceiling but whose history carries the serialized document over it: gate 1
# passes and gate 2 refuses. The history is audit rows, which grow with time and people and not with agents.
e6_person mid_admin; U_MID="$U_mid_admin"
MID="$(company "e6-30mid-$RUN" "$U_MID")"
future_period "$MID"
MS_MID="$(membership_of "$MID" "$U_MID")"
sql -c "insert into app.audit_events (company_id, actor_user_id, actor_kind, action, entity_type, entity_id, details)
        select '$MID', '$U_MID', 'member', 'membership.set_roles', 'membership', '$MS_MID',
               jsonb_build_object('membership_id', '$MS_MID', 'roles_before', '{member}'::text[],
                                  'roles_after', '{it_reviewer,member}'::text[], 'reason_code', 'probe_history')
          from generate_series(1, 14000)" >/dev/null
expect "case 25b fixture: gate 1's estimate is UNDER the ceiling, because the company holds no content at all" "$(sql -c "select 2 * (app.company_content_bytes('$MID') + app.company_assembled_bytes('$MID')) <= app.limit_export_bytes()")" '^t$'
A_MID="$(audit_count "$MID")"
expect "case 25b: gate 2 refuses the same code, after the document was assembled and discarded" "$(export_as "$U_MID" "$MID")" 'E_EXPORT_TOO_LARGE'
expect "case 25b: and no audit row was written, so nothing was emitted" "$(audit_count "$MID")" "^$A_MID\$"
# fail-before: the routine with ONLY gate 1 answers 200 for company (b) and returns a body over the ceiling.
save_routine 'api.export_company(uuid)' export_gate2
apply_fixture e6-export-gate1-only-mutant.sql
r="$(export_body "$U_MID" "$MID" "$T/export-over.json")"
expect "fail-before case 25: with only gate 1 the same company exports" "$r" '^HTTP 200$'
expect "fail-before case 25: and the body on the wire is over the ceiling, which could never have left the function" "$(node -e '
  const [n, ceiling] = process.argv.slice(1).map(Number);
  process.stdout.write(n > ceiling ? "over" : n + " vs " + ceiling);' "$(wire_bytes "$T/export-over.json")" "$(sql -c "select app.limit_export_bytes()")")" '^over$'
echo "recorded, case 25 fail-before: the body gate 1 alone would have sent = $(wire_bytes "$T/export-over.json") bytes, against a ceiling of $(sql -c "select app.limit_export_bytes()")"
restore_routine export_gate2
expect "fail-before case 25: restored, and gate 2 refuses again" "$(export_as "$U_MID" "$MID")" 'E_EXPORT_TOO_LARGE'

# ---------------------------------------------------------------------------
section "30d case 26: the one door, table by table and role by role"
# ---------------------------------------------------------------------------
# No PostgREST role holds a DELETE grant on any of these tables, which is the privilege half of the bound: the flag
# is not the authorization, and a caller who could set it would be refused before the trigger ran.
for t in installation_witnesses installation_reports release_downloads releases reviews review_envelopes \
         candidate_contributors candidate_versions groups group_members audit_events memberships companies \
         invitations access_periods company_quotas idempotency_keys; do
  expect "case 26: no PostgREST role holds DELETE on app.$t" "$(sql -c "select coalesce(string_agg(grantee, ','), 'NONE') from information_schema.table_privileges where table_schema = 'app' and table_name = '$t' and privilege_type = 'DELETE' and grantee in ('anon', 'authenticated', 'service_role', 'app_server', 'app_maintenance')")" '^NONE$'
done
# The reachable setters are the definer routine, owned by postgres and granted to app_server alone, and the owner in
# a psql session: PostgREST sets a transaction's settings itself and exposes no SQL, so a request cannot issue a bare
# SET. What a probe can decide from the catalog is the first half: every api routine is SECURITY DEFINER.
expect "case 26: every api routine is SECURITY DEFINER, so the flag has no invoker-rights setter" "$(sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and not p.prosecdef")" '^0$'
expect "case 26: and each is owned by postgres" "$(sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and pg_get_userbyid(p.proowner) <> 'postgres'")" '^0$'
# The OWNER without the bypass meets each table's own code.
expect "case 26: the owner deleting a witness: E_WITNESS_APPEND_ONLY" "$(in_rollback "delete from app.installation_witnesses where company_id = '$W';")" 'E_WITNESS_APPEND_ONLY'
expect "case 26: a report: E_REPORT_APPEND_ONLY" "$(in_rollback "delete from app.installation_reports where company_id = '$W';")" 'E_REPORT_APPEND_ONLY'
expect "case 26: a ledger row: E_LEDGER_APPEND_ONLY" "$(in_rollback "delete from app.release_downloads where company_id = '$W';")" 'E_LEDGER_APPEND_ONLY'
expect "case 26: a release: E_RELEASE_DELETE" "$(in_rollback "delete from app.releases where company_id = '$W';")" 'E_RELEASE_DELETE'
expect "case 26: a review: E_IMMUTABLE" "$(in_rollback "delete from app.reviews where company_id = '$W';")" 'E_IMMUTABLE'
expect "case 26: an envelope: E_ENVELOPE_DELETE" "$(in_rollback "delete from app.review_envelopes where company_id = '$W';")" 'E_ENVELOPE_DELETE'
expect "case 26: a contributor row of a non-draft candidate: E_CONTRIBUTORS_FROZEN" "$(in_rollback "delete from app.candidate_contributors cc using app.candidate_versions v where v.id = cc.candidate_id and v.company_id = '$W' and v.state <> 'draft';")" 'E_CONTRIBUTORS_FROZEN'
expect "case 26: a candidate: E_CANDIDATE_DELETE" "$(in_rollback "delete from app.candidate_versions where company_id = '$W';")" 'E_CANDIDATE_DELETE'
expect "case 26: a group: E_GROUP_DELETE" "$(in_rollback "delete from app.groups where company_id = '$W';")" 'E_GROUP_DELETE'
expect "case 26: an audit row: E_AUDIT_APPEND_ONLY" "$(in_rollback "delete from app.audit_events where company_id = '$W';")" 'E_AUDIT_APPEND_ONLY'
expect "case 26: a membership: E_MEMBERSHIP_DELETE" "$(in_rollback "delete from app.memberships where company_id = '$W';")" 'E_MEMBERSHIP_DELETE'
expect "case 26: a company: E_COMPANY_DELETE" "$(in_rollback "delete from app.companies where id = '$W';")" 'E_COMPANY_DELETE'
# WITH the bypass set, the same DELETEs are admitted, and UPDATE and TRUNCATE are not.
expect "case 26: with the bypass, a witness delete is admitted" "$(in_rollback "set local app.tenant_deletion = 'on';" "with d as (delete from app.installation_witnesses where company_id = '$W' returning 1) select 'DELETED|' || count(*) from d;")" 'DELETED|1'
expect "case 26: the bypass opens DELETE ONLY: an UPDATE of a report is still refused under it" "$(in_rollback "set local app.tenant_deletion = 'on';" "update app.installation_reports set status = 'fail' where company_id = '$W';")" 'E_REPORT_APPEND_ONLY'
expect "case 26: and so is a TRUNCATE under it, whichever of the two statement triggers answers first" "$(in_rollback "set local app.tenant_deletion = 'on';" "truncate app.installation_reports cascade;")" 'APPEND_ONLY'
expect "case 26: an UPDATE of an audit row under the bypass: still refused" "$(in_rollback "set local app.tenant_deletion = 'on';" "update app.audit_events set action = 'x.y' where company_id = '$W';")" 'E_AUDIT_APPEND_ONLY'
expect "case 26: the registers are NOT among the twelve, so a deletion cannot touch them even with the bypass" "$(in_rollback "set local app.tenant_deletion = 'on';" "delete from app.release_targets;")" 'E_REGISTRY_FROZEN'
expect "case 26: nor the installer texts" "$(in_rollback "set local app.tenant_deletion = 'on';" "delete from app.installer_texts;")" 'E_REGISTRY_FROZEN'
expect "case 26: nor the gate identities" "$(in_rollback "set local app.tenant_deletion = 'on';" "delete from app.gate_identities;")" 'E_REGISTRY_FROZEN'
expect "case 26: and the bypass does not survive its transaction" "$(sql_try -c "begin; set local app.tenant_deletion = 'on'; select 'SET|' || current_setting('app.tenant_deletion', true); commit;" ; sql_try -c "select 'AFTER|' || coalesce(current_setting('app.tenant_deletion', true), 'unset');")" 'AFTER|unset'
expect "case 26: a DELETE after that committed transaction is refused again" "$(in_rollback "delete from app.audit_events where company_id = '$W';")" 'E_AUDIT_APPEND_ONLY'
# fail-before: a replacement written without the tg_op = 'DELETE' test admits an owner-side UPDATE under the bypass.
save_routine 'app.report_append_only()' report_append_only
apply_fixture e6-bypass-no-tgop-mutant.sql
# The update is a no-op on the row's own values, because a report carries CHECK constraints of its own (losses are
# required for a failed one) and the counterexample is about the TRIGGER admitting the statement, not about what the
# statement writes.
expect "fail-before case 26: without the tg_op test the bypass admits an UPDATE of an append-only report" "$(in_rollback "set local app.tenant_deletion = 'on';" "with u as (update app.installation_reports set source = source where company_id = '$W' returning 1) select 'UPDATED|' || count(*) from u;")" 'UPDATED|'
restore_routine report_append_only
expect "fail-before case 26: restored, and the same UPDATE is refused again" "$(in_rollback "set local app.tenant_deletion = 'on';" "update app.installation_reports set source = source where company_id = '$W';")" 'E_REPORT_APPEND_ONLY'

# ---------------------------------------------------------------------------
section "30e case 28: the deletion's own record survives, and accounts do not go with it"
# ---------------------------------------------------------------------------
# Company W, the one with rows in all twenty-one sections, is the one deleted, so the counts are a real company's.
# One of its members is also a member of another company, which is the control: they must not be orphaned.
e6_person shared_admin; U_SHARED="$U_shared_admin"
OTHERCO="$(company "e6-30other-$RUN" "$U_SHARED")"
sql -c "insert into app.memberships (company_id, user_id, roles) values ('$OTHERCO', '$U_recip', '{member}')" >/dev/null
expect "case 28 fixture: the recipient is a member of a second company too" "$(sql -c "select count(*) from app.memberships where user_id = '$U_recip'")" '^2$'
MEMBER_IDS="$(sql -c "select string_agg(user_id::text, ',' order by user_id::text) from app.memberships where company_id = '$W'")"
BEFORE="$(sql -c "select count(*) from app.audit_events where company_id = '$W'")"
W_ROWS="$(sql -c "select app.export_section_counts('$W')::text")"
expect "case 28 fixture: the company is suspended and then closed" "$(op_call set_company_status "$(jbody p_company="$W" p_status=suspended p_reason_code=non_payment)" >/dev/null; op_call close_company "$(jbody p_company="$W" p_confirm_slug="e6-30w-$RUN" p_reason_code=customer_instruction)")" '"status":"closed"'
op_body delete_company "$(jbody p_company="$W" p_confirm_slug="e6-30w-$RUN" p_reason_code=customer_instruction)" "$T/deleted.json" >/dev/null
expect "case 28: the company row is gone" "$(sql -c "select count(*) from app.companies where id = '$W'")" '^0$'
for t in installation_witnesses installation_reports release_downloads releases reviews review_envelopes \
         candidate_versions agents group_members groups invitations audit_events memberships access_periods \
         company_quotas; do
  expect "case 28: every app.$t row of that company is gone" "$(sql -c "select count(*) from app.$t where company_id = '$W'")" '^0$'
done
expect "case 28: and its candidate_contributors rows too, reached through the candidates" "$(sql -c "select count(*) from app.candidate_contributors cc where not exists (select 1 from app.candidate_versions v where v.id = cc.candidate_id)")" '^0$'
expect "case 28: exactly one company.delete audit row, with company_id NULL" "$(sql -c "select count(*) from app.audit_events where action = 'company.delete' and company_id is null and details ->> 'company_id' = '$W'")" '^1$'
expect "case 28: it carries the reason code, the total and the per-section counts" "$(sql -c "select (details ->> 'reason_code') || '|' || (details ? 'deleted_rows')::text || '|' || (details ? 'section_counts')::text from app.audit_events where action = 'company.delete' and details ->> 'company_id' = '$W'")" '^customer_instruction|true|true$'
expect "case 28: its section_counts name the EIGHTEEN deletion sections and no export-only one" "$(sql -c "select count(*) from jsonb_object_keys((select details -> 'section_counts' from app.audit_events where action = 'company.delete' and details ->> 'company_id' = '$W')) k where not (k = any (app.deletion_section_names()))")" '^0$'
expect "case 28: no other audit row of that company survives" "$(sql -c "select count(*) from app.audit_events where company_id = '$W'")" '^0$'
expect "case 28 control: and there were $BEFORE of them before" "COUNT|$(node -e 'process.stdout.write(String(Number(process.argv[1]) > 0))' "$BEFORE")" '^COUNT|true$'
expect "case 28: every account is still present" "$(sql -c "select count(*) from auth.users where id::text = any (string_to_array('$MEMBER_IDS', ','))")|$(node -e 'process.stdout.write(String(process.argv[1].split(",").length))' "$MEMBER_IDS")" \
  "^$(node -e 'process.stdout.write(String(process.argv[1].split(",").length))' "$MEMBER_IDS")|"
expect "case 28: and every app.profiles row too" "$(sql -c "select count(*) from app.profiles where user_id = '$U_author'")" '^1$'
expect "case 28: orphaned_user_ids equals the members who now hold no membership anywhere" "$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(j[0].deleted.orphaned_user_ids.slice().sort().join(","));' "$T/deleted.json")" \
  "^$(sql -c "select coalesce(string_agg(u, ',' order by u), 'NONE') from unnest(string_to_array('$MEMBER_IDS', ',')) u where not exists (select 1 from app.memberships m where m.user_id = u::uuid)")\$"
expect "case 28 control: the member of a second company is ABSENT from orphaned_user_ids" "COUNT|$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(j[0].deleted.orphaned_user_ids.includes(process.argv[2])));' "$T/deleted.json" "$U_recip")" '^COUNT|false$'
expect "case 28 control: and their other membership is untouched" "$(sql -c "select status from app.memberships where user_id = '$U_recip'")" '^active$'
expect "case 28: the registers are untouched: the release target is still there" "$(sql -c "select count(*) from app.release_targets where target = 'claude-ai'")" '^1$'
expect "case 28: and the gate identities too" "$(sql -c "select count(*) >= 1 from app.gate_identities")" '^t$'
expect "case 28: the answer's per-section counts equal what the manifest counted before the deletion" "$(node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const before = JSON.parse(process.argv[2]);
  const keys = ["memberships", "invitations", "agents", "candidate_versions", "candidate_contributors",
                "review_envelopes", "reviews", "releases", "release_downloads", "installation_reports",
                "installation_witnesses", "groups", "group_members", "access_periods", "company_quotas"];
  const bad = keys.filter((k) => j[0].deleted[k] !== before[k]);
  process.stdout.write(bad.length ? bad.join(",") : "EQUAL");' "$T/deleted.json" "$W_ROWS")" '^EQUAL$'
# Case 29's bound, which belongs beside this: a company over app.limit_delete_rows() refuses with nothing deleted.
save_routine 'app.limit_delete_rows()' limit_delete_rows
apply_fixture e6-delete-bound-mutant.sql
expect "case 29 (the bound): with the bound lowered below what the company holds: E_DELETE_TOO_LARGE" "$(op_call set_company_status "$(jbody p_company="$MID" p_status=suspended p_reason_code=non_payment)" >/dev/null; op_call close_company "$(jbody p_company="$MID" p_confirm_slug="e6-30mid-$RUN" p_reason_code=customer_instruction)" >/dev/null; op_call delete_company "$(jbody p_company="$MID" p_confirm_slug="e6-30mid-$RUN" p_reason_code=customer_instruction)")" 'E_DELETE_TOO_LARGE'
expect "case 29: NOTHING was deleted" "$(sql -c "select count(*) > 10000 from app.audit_events where company_id = '$MID'")" '^t$'
expect "case 29: no audit row for it" "$(sql -c "select count(*) from app.audit_events where action = 'company.delete' and details ->> 'company_id' = '$MID'")" '^0$'
expect "case 29: and the company is still closed" "$(sql -c "select status from app.companies where id = '$MID'")" '^closed$'
restore_routine limit_delete_rows
expect "case 29 control: under the bound, the same company deletes" "$(op_call delete_company "$(jbody p_company="$MID" p_confirm_slug="e6-30mid-$RUN" p_reason_code=customer_instruction)")" '"companies": 1'

# ---------------------------------------------------------------------------
section "30f case 40: the deletion's dates, and the closure's export-window rule"
# ---------------------------------------------------------------------------
# A suspended company whose period is aged to order. It prints "<company>|<its administrator>", because it runs
# inside a command substitution and a variable it sets there never reaches the caller (E6DB-F19).
closed_company() { # tag ends-ago export-ago delete-ago
  local u c
  e6_person "$1"
  eval "u=\$U_$1"
  c="$(company "e6-30$1-$RUN" "$u")"
  age_period "$c" "$2" "$3" "$4"
  op_call set_company_status "$(jbody p_company="$c" p_status=suspended p_reason_code=non_payment)" >/dev/null
  printf '%s|%s' "$c" "$u"
}
# Arm 1: export_by passed, delete_by has not. The deletion is ELIGIBLE and retention_deadline is the reason.
# delete_by is twenty days ahead, which is more than app.deletion_due_notice(), so the state is `eligible` and not
# `due`: the two words are different facts and the probe asserts the one it means.
CC="$(closed_company f40a '40 days' '26 days' '-20 days')"; C40A="${CC%%|*}"
expect "case 40a: app.deletion_state is eligible" "$(deletion_state "$C40A")" '^eligible$'
expect "case 40a: closed, past export_by, with retention_deadline" "$(op_call close_company "$(jbody p_company="$C40A" p_confirm_slug="e6-30f40a-$RUN" p_reason_code=retention_deadline)")" '"status":"closed"'
expect "case 40a: and it DELETES with retention_deadline, which the first version's precondition on delete_by refused" "$(op_call delete_company "$(jbody p_company="$C40A" p_confirm_slug="e6-30f40a-$RUN" p_reason_code=retention_deadline)")" '"companies": 1'
# Arm 2: before export_by. E_DELETION_NOT_DUE unless the reason is customer_instruction.
CC="$(closed_company f40b '1 hour' '-14 days' '-44 days')"; C40B="${CC%%|*}"
expect "case 40b: app.deletion_state is not_eligible" "$(deletion_state "$C40B")" '^not_eligible$'
expect "case 40b: the closure needs the customer instruction: E_EXPORT_WINDOW_OPEN without it" "$(op_call close_company "$(jbody p_company="$C40B" p_confirm_slug="e6-30f40b-$RUN" p_reason_code=retention_deadline)")" 'E_EXPORT_WINDOW_OPEN'
expect "case 40b: and it is still suspended, so nothing was cut short" "$(sql -c "select status from app.companies where id = '$C40B'")" '^suspended$'
expect "case 40b: with the customer instruction it closes" "$(op_call close_company "$(jbody p_company="$C40B" p_confirm_slug="e6-30f40b-$RUN" p_reason_code=customer_instruction)")" '"status":"closed"'
expect "case 40b: the reason code is in the audit row, so who asked and when is a row and not a memory" "$(sql -c "select details ->> 'reason_code' from app.audit_events where company_id = '$C40B' and action = 'company.close'")" '^customer_instruction$'
expect "case 40b: the deletion before export_by with retention_deadline: E_DELETION_NOT_DUE" "$(op_call delete_company "$(jbody p_company="$C40B" p_confirm_slug="e6-30f40b-$RUN" p_reason_code=retention_deadline)")" 'E_DELETION_NOT_DUE'
expect "case 40b: nothing was deleted by the refused call" "$(sql -c "select count(*) from app.companies where id = '$C40B'")" '^1$'
expect "case 40b: with customer_instruction it deletes, which is the plan's other admissible reason" "$(op_call delete_company "$(jbody p_company="$C40B" p_confirm_slug="e6-30f40b-$RUN" p_reason_code=customer_instruction)")" '"companies": 1'
# Arm 3: delete_by passed two weeks ago. The register showed it OVERDUE beforehand.
CC="$(closed_company f40c '150 days' '136 days' '14 days')"; C40C="${CC%%|*}"
expect "case 40c: app.deletion_state is overdue" "$(deletion_state "$C40C")" '^overdue$'
expect "case 40c: and the register sorts it first, whatever page the cursor is on" "$(op_body operator_register "$(jbody p_limit='#200')" "$T/reg40.txt" >/dev/null; node -e '
  const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(j.companies[0].access_period.deletion_state);' "$T/reg40.txt")" '^overdue$'
expect "case 40c: it closes and deletes" "$(op_call close_company "$(jbody p_company="$C40C" p_confirm_slug="e6-30f40c-$RUN" p_reason_code=retention_deadline)" >/dev/null; op_call delete_company "$(jbody p_company="$C40C" p_confirm_slug="e6-30f40c-$RUN" p_reason_code=retention_deadline)")" '"companies": 1'
# Arm 4: the refusal order, and the closure's other preconditions.
CC="$(closed_company f40d '40 days' '26 days' '-20 days')"; C40D="${CC%%|*}"
expect "case 40d: a wrong slug is told BEFORE the deletion is said not to be due" "$(op_call close_company "$(jbody p_company="$C40D" p_confirm_slug="e6-30f40d-$RUN" p_reason_code=retention_deadline)" >/dev/null; op_call delete_company "$(jbody p_company="$C40D" p_confirm_slug=wrong p_reason_code=retention_deadline)")" 'E_CONFIRMATION_MISMATCH'
expect "case 40d: a reason code outside the vocabulary: E_BODY_INVALID" "$(op_call delete_company "$(jbody p_company="$C40D" p_confirm_slug="e6-30f40d-$RUN" p_reason_code=because_i_said_so)")" 'E_BODY_INVALID'
expect "case 40d: a company that is not closed: E_COMPANY_NOT_CLOSED" "$(op_call delete_company "$(jbody p_company="$OTHERCO" p_confirm_slug="e6-30other-$RUN" p_reason_code=customer_instruction)")" 'E_COMPANY_NOT_CLOSED'
# fail-before (1): the precondition on delete_by refuses arm 1, which is a deletion the plan requires by then.
save_routine 'api.delete_company(uuid, text, text)' delete_company
apply_fixture e6-delete-on-delete-by-mutant.sql
expect "fail-before case 40: the precondition on DELETE_BY refuses a deletion inside the window the plan gives for it" "$(op_call delete_company "$(jbody p_company="$C40D" p_confirm_slug="e6-30f40d-$RUN" p_reason_code=retention_deadline)")" 'E_DELETION_NOT_DUE'
expect "fail-before case 40: which is a company whose deletion state is eligible" "$(deletion_state "$C40D")" '^eligible$'
restore_routine delete_company
expect "fail-before case 40: restored, and the same call deletes" "$(op_call delete_company "$(jbody p_company="$C40D" p_confirm_slug="e6-30f40d-$RUN" p_reason_code=retention_deadline)")" '"companies": 1'
# fail-before (2): api.close_company without the window rule closes a company whose export_by is still ahead.
CC="$(closed_company f40e '1 hour' '-14 days' '-44 days')"; C40E="${CC%%|*}"; U40E="${CC#*|}"
save_routine 'api.close_company(uuid, text, text)' close_company
apply_fixture e6-close-no-window-rule-mutant.sql
expect "fail-before case 40: without the window rule the closure takes away thirteen of the promised fourteen days, silently" "$(op_call close_company "$(jbody p_company="$C40E" p_confirm_slug="e6-30f40e-$RUN" p_reason_code=retention_deadline)")" '"status":"closed"'
expect "fail-before case 40: and the customer's export is then refused, inside their own window" "$(export_as "$U40E" "$C40E")" 'E_FORBIDDEN'
restore_routine close_company
CC="$(closed_company f40f '1 hour' '-14 days' '-44 days')"; C40F="${CC%%|*}"
expect "fail-before case 40: restored, and the same closure is refused" "$(op_call close_company "$(jbody p_company="$C40F" p_confirm_slug="e6-30f40f-$RUN" p_reason_code=retention_deadline)")" 'E_EXPORT_WINDOW_OPEN'

# ---------------------------------------------------------------------------
section "30h the flag is a tripwire and the GRANT is the boundary, for the company status guard too"
# ---------------------------------------------------------------------------
# The lead's condition on the accepted-probe grant (msg_9b3b419405bd), because probe 09's amended line has
# app_maintenance setting app.tenant_deletion itself: show for app.company_status_guard what 30d shows for the
# deletion door. app.tenant_deletion is a CUSTOM setting, so any role may set it; what stops a request role is that
# it holds no privilege on the row, and that is the boundary. The flag exists so that an OWNER-SIDE ACCIDENT does not
# silently erase or reopen a tenant, and its honest bound is the same as scripts/check-migrations.mjs's.
CLOSED30="$(sql -c "select id from app.companies where status = 'closed' order by created_at desc limit 1")"
expect "case 26 (the lead's condition): a closed company to try it on" "$CLOSED30" '^[0-9a-f-]\{36\}$'
# postgres may set role to anon, authenticated and service_role; app_server's membership carries no SET option, so it
# is granted for this section and restored to exactly the options it had, which are inherit false and set false.
OPTS_BEFORE="$(sql -c "select am.inherit_option::text || '|' || am.set_option::text from pg_auth_members am join pg_roles r on r.oid = am.roleid where r.rolname = 'app_server' and am.member = (select oid from pg_roles where rolname = current_user)")"
expect "case 26: app_server's membership of the owner carries neither option, which is why set role is refused" "$OPTS_BEFORE" '^false|false$'
sql -c "grant app_server to postgres" >/dev/null
for role in anon authenticated service_role app_server; do
  expect "case 26: $role sets the flag in its own transaction and still cannot move the company out of closed" \
    "$(sql_try -c "begin; set local role $role; set local app.tenant_deletion = 'on'; update app.companies set status = 'active' where id = '$CLOSED30'; rollback;")" 'permission denied'
  expect "case 26: $role sets the flag and still cannot delete the company row" \
    "$(sql_try -c "begin; set local role $role; set local app.tenant_deletion = 'on'; delete from app.companies where id = '$CLOSED30'; rollback;")" 'permission denied'
  expect "case 26: $role sets the flag and still cannot delete an audit row" \
    "$(sql_try -c "begin; set local role $role; set local app.tenant_deletion = 'on'; delete from app.audit_events where id = (select min(id) from app.audit_events); rollback;")" 'permission denied'
  expect "case 26: and the refusal is the PRIVILEGE and not the flag: the flag was set" \
    "$(sql_try -c "begin; set local role $role; set local app.tenant_deletion = 'on'; select 'FLAG|' || current_setting('app.tenant_deletion', true); rollback;")" 'FLAG|on'
done
sql -c "revoke app_server from postgres" >/dev/null
sql -c "grant app_server to postgres with inherit false, set false" >/dev/null
expect "case 26: app_server's membership is restored to exactly the options it had" "$(sql -c "select am.inherit_option::text || '|' || am.set_option::text from pg_auth_members am join pg_roles r on r.oid = am.roleid where r.rolname = 'app_server' and am.member = (select oid from pg_roles where rolname = current_user)")" "^$OPTS_BEFORE\$"
expect "case 26: and the company is still closed after all twelve attempts" "$(sql -c "select status from app.companies where id = '$CLOSED30'")" '^closed$'
# A request role cannot reach a bare SET at all: PostgREST exposes schema api only, every api routine is granted to
# app_server alone, and none of them executes caller-supplied SQL.
expect "case 26: authenticated holds EXECUTE on no api routine" "$(sql -c "select coalesce(string_agg(routine_name, ','), 'NONE') from information_schema.routine_privileges where specific_schema = 'api' and grantee = 'authenticated'")" '^NONE$'
expect "case 26: nor anon" "$(sql -c "select coalesce(string_agg(routine_name, ','), 'NONE') from information_schema.routine_privileges where specific_schema = 'api' and grantee = 'anon'")" '^NONE$'
expect "case 26: nor service_role" "$(sql -c "select coalesce(string_agg(routine_name, ','), 'NONE') from information_schema.routine_privileges where specific_schema = 'api' and grantee = 'service_role'")" '^NONE$'
expect "case 26: and schema api exposes no set_config of its own" "$(sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.proname like '%set_config%'")" '^0$'
# The flag does not survive its transaction on a pooled connection, which is what makes the deletion routine's own
# `set local` safe: the next request on the same backend does not inherit it.
expect "case 26: a committed transaction that set the flag leaves the next statement without it" "$(sql_try -c "begin; set local app.tenant_deletion = 'on'; select 1; commit;"; sql_try -c "select 'AFTER|' || coalesce(current_setting('app.tenant_deletion', true), 'unset');")" 'AFTER|unset'
expect "case 26: and that next statement cannot move the company out of closed" "$(sql_try -c "begin; set local app.tenant_deletion = 'on'; select 1; commit;"; sql_try -c "update app.companies set status = 'active' where id = '$CLOSED30';")" 'E_COMPANY_CLOSED'
expect "case 26: which the guard answers, from the same owner session, with no flag in force" "$(sql -c "select status from app.companies where id = '$CLOSED30'")" '^closed$'

# ---------------------------------------------------------------------------
section "30g the upgrade path (the critique's rule 10 outcome): 008 applied to a database at 007 that HOLDS ROWS"
# ---------------------------------------------------------------------------
# A `supabase db reset` applies 001 to 008 to an EMPTY database, which is the fresh install; what a pilot database
# meets is 008 applied over rows, and scripts/check-migrations.mjs proves 001 to 007's bytes rather than the
# semantics of a later replacement. So this section stands a scratch database up at the accepted 007 schema, seeds
# E1 to E5 data into it, applies 008, and compares every function body with the fresh install's.
# The limit, stated rather than glossed: PostgREST points at the project's own database, so what this establishes is
# the DATABASE half of the upgrade. No route runs against the scratch database and none could.
trap 'up_drop' EXIT
up_create "e6_upgrade_$RUN"
for f in 001_identity.sql 002_bound_principal.sql 003_content.sql 004_content_rules_and_profiles.sql \
         005_invitations_aal2.sql 006_reviews_releases.sql 007_installations.sql; do
  expect "upgrade: $f applies to the scratch database" "$(up_apply "$f")" '^ok$'
done
expect "upgrade: the scratch database stands at the accepted 007 schema" "$(up_sql -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('app', 'api')")" '^1[0-9][0-9]$'
expect "upgrade: and 008's tables are not there yet" "$(up_sql -c "select count(*) from pg_tables where schemaname = 'app' and tablename in ('access_periods', 'company_quotas')")" '^0$'
expect "upgrade: E1 to E5 data is seeded into it" "$(up_apply_fixture e6-upgrade-seed.sql)" '^ok$'
expect "upgrade: three companies, one of them closed, and four invitations in all four states" "$(up_sql -c "select (select count(*) from app.companies) || '|' || (select count(*) from app.invitations) || '|' || (select count(*) from app.operators)")" '^3|4|1$'
expect "upgrade: 008 APPLIES to that database" "$(up_apply 008_lifecycle.sql)" '^ok$'
# E7's 009 applies over the same rows, which is what makes the fingerprint comparison below a comparison of the
# CURRENT schema and not of a stale one, and which proves the recovery hold's migration works on an upgrade and
# not only on a fresh install: its first statement widens app.company_statuses() and its second re-validates
# app.companies' status check against existing rows (docs/e7/design.md 2.1). Added 2026-09-20 under the lead's
# grant, as the one line a new migration adds to this block.
expect "upgrade: 009 APPLIES to that database, over the rows 008 was applied over" "$(up_apply 009_recovery_hold.sql)" '^ok$'
expect "upgrade: and the status check is VALID there, not left NOT VALID" "$(up_sql -c "select convalidated from pg_constraint where conname = 'companies_status_check'")" '^t$'
expect "upgrade: its two tables are there now" "$(up_sql -c "select count(*) from pg_tables where schemaname = 'app' and tablename in ('access_periods', 'company_quotas')")" '^2$'
# K4's 010 (E6 design 1.2.1, 2026-09-28), the one line a new migration adds to this block, and the one property an
# upgrade has that a fresh install cannot show: rows that existed before it keep a NULL delivery, because nothing
# recorded their delivery, and are never backfilled with not_attempted, which the invitation list would read as
# unconfirmed for every mailed pilot invitation.
expect "upgrade: 010 APPLIES to that database, over the same rows" "$(up_apply 010_invitation_delivery.sql)" '^ok$'
expect "upgrade: the four invitations that existed before 010 all keep a null delivery" "$(up_sql -c "select count(*) || '|' || count(delivery) from app.invitations")" '^4|0$'
expect "upgrade: while a row inserted after 010 takes not_attempted" "$(up_rollback "insert into app.invitations (company_id, email_normalized, token_hash, roles, expires_at, created_by) select company_id, 'up-k4@example.invalid', extensions.digest('k4', 'sha256'), '{member}', now() + interval '1 day', created_by from app.invitations where created_by is not null limit 1 returning 'WORD|' || delivery;")" 'WORD|not_attempted'
# 011 and 012 (evidence/ena7-end1-hbf2.md; END1-CR-F1), each the one line its migration adds to this block. 011's
# upgrade property is its backfill: the claim's column is stamped on the rows pending when it runs, each with its own
# created_at, the expired one included because it was still pending, and on no accepted or revoked row. 012 adds two
# tables and changes no row, so its property is that they start empty: no account begins with a spent budget.
expect "upgrade: 011 APPLIES to that database, over the same rows" "$(up_apply 011_invitation_standing.sql)" '^ok$'
expect "upgrade: 011 stamps the pending and the expired row with their created_at, and leaves the accepted and the revoked unstamped" "$(up_sql -c "select string_agg(split_part(email_normalized, '@', 1) || '=' || case when handover_claimed_at is null then 'null' when handover_claimed_at = created_at then 'created' else 'other' end, ',' order by email_normalized) from app.invitations")" '^upgrade-accepted=null,upgrade-expired=created,upgrade-pending=created,upgrade-revoked=null$'
expect "upgrade: 012 APPLIES to that database, over the same rows" "$(up_apply 012_mfa_route_bound.sql)" '^ok$'
expect "upgrade: and its two tables start empty" "$(up_sql -c "select (select count(*) from app.mfa_route_attempts) || '|' || (select count(*) from app.mfa_route_reservations)")" '^0|0$'
expect "upgrade: and the six company_id indexes, over tables that already held rows" "$(up_sql -c "select count(*) from pg_indexes where schemaname = 'app' and indexname in ('release_downloads_company', 'installation_reports_company', 'installation_witnesses_company', 'group_members_company', 'reviews_company', 'review_envelopes_company')")" '^6$'
# The comparison the critique asked for, taken over EVERY function in app and api rather than only the ones 008 does
# not name: if a replacement differed between the two paths the diff would say which.
printf '%s\n' "$FUNC_FINGERPRINT" | up_sql > "$T/fp-upgrade.txt"
printf '%s\n' "$FUNC_FINGERPRINT" | sql > "$T/fp-fresh.txt"
expect "upgrade: both databases hold the same number of functions in app and api" "$(wc -l < "$T/fp-upgrade.txt" | tr -d ' ')|$(wc -l < "$T/fp-fresh.txt" | tr -d ' ')" \
  "^$(wc -l < "$T/fp-fresh.txt" | tr -d ' ')|$(wc -l < "$T/fp-fresh.txt" | tr -d ' ')\$"
expect "upgrade: and every function body is IDENTICAL to the fresh install's, byte for byte" "$(diff "$T/fp-fresh.txt" "$T/fp-upgrade.txt" >/dev/null && echo IDENTICAL || diff "$T/fp-fresh.txt" "$T/fp-upgrade.txt" | head -20)" '^IDENTICAL$'
echo "recorded, upgrade: $(wc -l < "$T/fp-fresh.txt" | tr -d ' ') functions in schemas app and api compared by md5 of pg_get_functiondef, all equal"
# The accepted refusals, re-run over rows that existed BEFORE 008 was applied.
expect "upgrade: an audit row still cannot be deleted" "$(up_rollback "delete from app.audit_events where company_id = '11111111-1111-4111-8111-111111111111';")" 'E_AUDIT_APPEND_ONLY'
expect "upgrade: a membership still cannot be deleted" "$(up_rollback "delete from app.memberships where id = 'bbbbbbbb-0000-4000-8000-000000000003';")" 'E_MEMBERSHIP_DELETE'
expect "upgrade: a group still cannot be deleted" "$(up_rollback "delete from app.groups where id = 'cccccccc-0000-4000-8000-000000000001';")" 'E_GROUP_DELETE'
expect "upgrade: app.lock_company still refuses a suspended company" "$(up_rollback "select app.lock_company('22222222-2222-4222-8222-222222222222');")" 'E_COMPANY_INACTIVE'
expect "upgrade: and now refuses a company past its access period, over a row seeded before 008" "$(up_rollback "insert into app.access_periods (company_id, starts_at, ends_at, export_by, delete_by) values ('11111111-1111-4111-8111-111111111111', clock_timestamp() - interval '60 days', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '14 days', clock_timestamp() + interval '44 days');" "select app.lock_company('11111111-1111-4111-8111-111111111111');")" 'E_ACCESS_PERIOD_ENDED'
expect "upgrade: 008's new company guard refuses a move out of closed" "$(up_rollback "update app.companies set status = 'active' where id = '33333333-3333-4333-8333-333333333333';")" 'E_COMPANY_CLOSED'
expect "upgrade: and a company DELETE" "$(up_rollback "delete from app.companies where id = '22222222-2222-4222-8222-222222222222';")" 'E_COMPANY_DELETE'
expect "upgrade: and a slug change" "$(up_rollback "update app.companies set slug = 'renamed' where id = '11111111-1111-4111-8111-111111111111';")" 'E_COMPANY_IDENTITY'
expect "upgrade: every pre-existing invitation satisfies the new one-creator CHECK" "$(up_sql -c "select count(*) from app.invitations where num_nonnulls(created_by, created_by_operator) = 1")" '^4$'
expect "upgrade: and an invitation naming NEITHER issuer is refused" "$(up_rollback "insert into app.invitations (company_id, email_normalized, token_hash, roles, expires_at) values ('11111111-1111-4111-8111-111111111111', 'up-neither@example.invalid', extensions.digest('up-neither', 'sha256'), '{member}', clock_timestamp() + interval '7 days');")" 'invitations_one_creator'
expect "upgrade: and one naming BOTH" "$(up_rollback "insert into app.invitations (company_id, email_normalized, token_hash, roles, expires_at, created_by, created_by_operator) values ('11111111-1111-4111-8111-111111111111', 'up-both@example.invalid', extensions.digest('up-both', 'sha256'), '{member}', clock_timestamp() + interval '7 days', 'bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000004');")" 'invitations_one_creator'
expect "upgrade: app.quota falls through to the accepted constant where no company row overrides it" "$(up_sql -c "select app.quota('11111111-1111-4111-8111-111111111111', 'agents_per_company') || '|' || app.limit_agents_per_company()")" '^50|50$'
expect "upgrade: and reads an override where one exists" "$(up_rollback "insert into app.company_quotas (company_id, name, value) values ('11111111-1111-4111-8111-111111111111', 'agents_per_company', 77);" "select 'QUOTA|' || app.quota('11111111-1111-4111-8111-111111111111', 'agents_per_company');")" 'QUOTA|77'
up_drop
# The one-time dual-principal check: a database at 007 that already holds a crossing must FAIL the migration.
up_create "e6_upgrade_dual_$RUN"
for f in 001_identity.sql 002_bound_principal.sql 003_content.sql 004_content_rules_and_profiles.sql \
         005_invitations_aal2.sql 006_reviews_releases.sql 007_installations.sql; do
  up_apply "$f" >/dev/null
done
expect "upgrade: the second scratch database is seeded and given a dual principal" "$(up_apply_fixture e6-upgrade-seed.sql; up_apply_fixture e6-upgrade-dual-principal.sql)" '^okok$'
expect "upgrade: one account now holds both an operator row and a membership" "$(up_sql -c "select count(*) from app.operators o join app.memberships m on m.user_id = o.user_id")" '^1$'
expect "upgrade: 008 REFUSES to apply, with E_DUAL_PRINCIPAL" "$(up_apply 008_lifecycle.sql)" 'E_DUAL_PRINCIPAL'
expect "upgrade: and the DETAIL names the count and no identity" "$(up_apply 008_lifecycle.sql)" '1 operator account(s) hold a membership'
expect "upgrade: and the refusal names no address and no id" "COUNT|$(printf '%s' "$(up_apply 008_lifecycle.sql)" | grep -c 'aaaaaaaa\|@example' || true)" '^COUNT|0$'
expect "upgrade: so the migration left 008's tables uncreated" "$(up_sql -c "select count(*) from pg_tables where schemaname = 'app' and tablename in ('access_periods', 'company_quotas')")" '^0$'
up_drop

expect "30: deadlocks unchanged across the whole probe" "$(deadlocks)" "^$DL0\$"
exit $FAILED
