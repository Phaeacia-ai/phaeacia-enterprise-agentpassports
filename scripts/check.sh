#!/usr/bin/env bash
# Scoped local checks for the enterprise repository (architecture section 11).
# Reproducible on a clean clone: npm ci && bash scripts/check.sh
# Every gate prints its own findings; this runner records pass/fail per gate,
# writes .scratch/check/summary.txt and exits 2 if any gate failed.
# Python is used only through the controlled launcher in scripts/check-python.mjs.
# Since E2 the runner also gates the database probes and the E2 stack tests (see e2_stack).
set -u

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$repo" || exit 2
mkdir -p .scratch/check
summary=.scratch/check/summary.txt
: > "$summary"
failed=0

skipped=0

# A gate that exits 3 was skipped by an explicit opt-out; it is reported as SKIP, never as PASS.
gate() {
  local name=$1 status
  shift
  printf '\n== %s\n' "$name"
  "$@"
  status=$?
  if [[ $status -eq 0 ]]; then
    printf 'PASS %s\n' "$name" | tee -a "$summary"
  elif [[ $status -eq 3 ]]; then
    printf 'SKIP %s (E2_DB=skip)\n' "$name" | tee -a "$summary"
    skipped=1
  else
    printf 'FAIL %s (exit %s)\n' "$name" "$status" | tee -a "$summary"
    failed=1
  fi
}

node_ok() {
  local want have
  want=$(tr -d '[:space:]' < .nvmrc)
  have=${1#v}
  [[ "$have" == "$want" ]] || { printf 'node %s, .nvmrc wants %s\n' "$have" "$want"; return 1; }
  printf 'node %s\n' "$have"
}

syntax() {
  local status=0 f
  while IFS= read -r -d '' f; do
    node --check "$f" || { printf 'syntax: %s\n' "$f"; status=1; }
  done < <(find . -type f -name '*.mjs' -not -path './vendor/*' -not -path './node_modules/*' -not -path './.scratch/*' -print0)
  bash -n scripts/check.sh || status=1
  bash -n scripts/build.sh || status=1
  return $status
}

format_lint() {
  # Biome runs over the explicit owned paths from biome.json, never over ".":
  # a root run scans the whole checkout and a stray biome.json under the
  # ignored .scratch/ tree fails it with "nested root configuration"
  # (evidence/e1-adapter-implementation.md, lesson 3). The script also asserts
  # that the lock and the vendor tree are outside the formatter's reach.
  node scripts/check-format.mjs
}

vendor_no_mode_drift() {
  # The vendor tree is byte-exact upstream content; verify mode is the gate.
  node scripts/import-passport.mjs --verify
}

# E2 gates (identity and tenancy). The unit tests need no stack. The database probes and the
# handler tests need the local Supabase stack (supabase start) and reseed it through
# tests/db/00-seed.sh; without the stack they FAIL loudly (scripts/check-db.sh exits 2 with
# "skipping is not a pass"). E2_DB=skip is the documented opt-out for a machine without Docker:
# both stack gates then report SKIP in the summary and the final line says so; a skipped gate
# is never a pass and the acceptance record must say which gates ran.
e2_unit() {
  node --test tests/e2/unit/
}
db_probes() {
  [[ "${E2_DB:-}" == "skip" ]] && return 3
  bash scripts/check-db.sh
}
e2_stack() {
  [[ "${E2_DB:-}" == "skip" ]] && return 3
  if ! supabase status >/dev/null 2>&1; then
    printf 'e2 stack tests: local Supabase is not running (supabase start); skipping is not a pass\n' >&2
    return 2
  fi
  # One file at a time: each file reseeds the shared local database.
  node --test --test-concurrency=1 tests/e2/stack/
}
# E3 (E3b): the route-level tests need the same stack and reseed it per file; the E3 unit gate above runs
# tests/e3/unit/ only, so the stack files are never run in parallel with it (evidence/e3b.md, G4).
e3_stack() {
  [[ "${E2_DB:-}" == "skip" ]] && return 3
  if ! supabase status >/dev/null 2>&1; then
    printf 'e3 stack tests: local Supabase is not running (supabase start); skipping is not a pass\n' >&2
    return 2
  fi
  node --test --test-concurrency=1 tests/e3/stack/
}
# E4 (the server half): the route, replay, matrix and capacity files reseed the same stack per file, one file at a time;
# the database probes 22 to 25 run inside db_probes above, after probe 21 (evidence/e4-server.md).
e4_stack() {
  [[ "${E2_DB:-}" == "skip" ]] && return 3
  if ! supabase status >/dev/null 2>&1; then
    printf 'e4 stack tests: local Supabase is not running (supabase start); skipping is not a pass\n' >&2
    return 2
  fi
  node --test --test-concurrency=1 tests/e4/stack/
}
# E5 (the server half): the route file reseeds the same stack per file, one file at a time; the database probes 26 to 28
# run inside db_probes above, after probe 25 (evidence/e5-server.md).
e5_stack() {
  [[ "${E2_DB:-}" == "skip" ]] && return 3
  if ! supabase status >/dev/null 2>&1; then
    printf 'e5 stack tests: local Supabase is not running (supabase start); skipping is not a pass\n' >&2
    return 2
  fi
  node --test --test-concurrency=1 tests/e5/stack/
}

# E6 (the services and routes half): the route file and the section 6 capacity sample reseed the same stack per
# file, one file at a time; the database probes 29 to 31 run inside db_probes above, after probe 28
# (evidence/e6-services.md).
e6_stack() {
  [[ "${E2_DB:-}" == "skip" ]] && return 3
  if ! supabase status >/dev/null 2>&1; then
    printf 'e6 stack tests: local Supabase is not running (supabase start); skipping is not a pass\n' >&2
    return 2
  fi
  node --test --test-concurrency=1 tests/e6/stack/
}
# E7 (design 2.6 item 7): the unit gate holds the code pins, the alert module whole and the key-replacement control
# (E7-31); the LOCAL DEPLOY CHECK is its own gate below, not part of this one, because two of its facts need the
# owner connection (see deploy_check_local); the stack gate holds the mail paths through the catcher, the scripts,
# the reconciler and THE RESTORE REHEARSAL, which lands with day 5.
# Until the first E7 stack file exists the stack gate says so and runs nothing, which is printed, not hidden.
# tests/e7/stack/restore.test.mjs IS AN UNCONDITIONAL GATE FROM 2026-09-20, and its duration was recorded BEFORE it
# became one, which is the condition E7D-C-F13 put on it: the C7 line the file prints and evidence/e7-restore.md
# section 4 carry the measurement, with the seed that produced it. What it costs this gate is that one measured
# rehearsal and nothing more: its fail-before arm is a second whole restore cycle and runs only under
# E7_16_FAIL_BEFORE=1, which nothing here sets, so the gate never pays for it.
# It DUMPS AND TRUNCATES schemas app and auth and loads them back, under the lead's explicit grant (design 1.3), so
# it reseeds at its start and again in its `after`, and it must not run beside another stack file: that is what
# --test-concurrency=1 below is for, here as in every other stack gate.
e7_stack() {
  [[ "${E2_DB:-}" == "skip" ]] && return 3
  if ! ls tests/e7/stack/*.test.mjs >/dev/null 2>&1; then
    printf 'e7 stack tests: no test file yet under tests/e7/stack (the E7 lanes add them); nothing ran\n'
    return 0
  fi
  if ! supabase status >/dev/null 2>&1; then
    printf 'e7 stack tests: local Supabase is not running (supabase start); skipping is not a pass\n' >&2
    return 2
  fi
  node --test --test-concurrency=1 tests/e7/stack/
}

# E8 (design 2.4, 7.1): the adversarial estate. tests/e8/ was created on day 1 with its directories and its README
# and NO test file; days 2 to 5 fill it. DAY 2 filled tests/e8/stack/ with the tenancy sweep and the session case.
# DAY 3 FILLED tests/e8/unit/ with E8-7's stack-free half and the validator adversarial fixtures, so the unit gate
# now runs too, and added three more stack files; day 5 adds the rest. Both gates keep the "nothing ran" branch,
# because it is what made the day each one started running visible in the run output, and because a later reader
# deleting the last file in either directory should see that said out loud rather than a silent pass.
# THE UNIT GATE RUNS PYTHON. tests/e8/unit/validator-fixtures.test.mjs launches the pinned
# vendor/passport/tools/validate.py through the same absolute-interpreter resolver tests/e3/unit/ uses, so this
# gate needs an interpreter exactly as the E3 unit gate above already does; it reaches no stack and no network.
# tests/e8/load/ is NOT a gate and is not named here, following tests/e7/measure/ (design 2.4).
# The stack gate runs --test-concurrency=1 like every other stack directory: each file reseeds the database through
# tests/db/00-seed.sh, so two of them at once would reseed under each other.
e8_unit() {
  if ! ls tests/e8/unit/*.test.mjs >/dev/null 2>&1; then
    printf 'e8 unit tests: no test file yet under tests/e8/unit (E8 day 5 adds the stderr shape); nothing ran\n'
    return 0
  fi
  node --test tests/e8/unit/
}
e8_stack() {
  [[ "${E2_DB:-}" == "skip" ]] && return 3
  if ! ls tests/e8/stack/*.test.mjs >/dev/null 2>&1; then
    printf 'e8 stack tests: no test file yet under tests/e8/stack (days 2 and 3 landed five; day 5 adds the rest); nothing ran\n'
    return 0
  fi
  if ! supabase status >/dev/null 2>&1; then
    printf 'e8 stack tests: local Supabase is not running (supabase start); skipping is not a pass\n' >&2
    return 2
  fi
  node --test --test-concurrency=1 tests/e8/stack/
}

# E7 (design 1.4, day 6): the LOCAL deploy check, as its own gate against the committed synthetic fixture
# tests/e7/fixtures/local.env, which is the one env file the script's in-tree refusal admits. It is its own gate and
# not part of the E7 unit gate because two of its sixteen facts need the OWNER CONNECTION (D8's registry half and
# D14), so it needs the stack like every gate below and unlike every gate above. ENTERPRISE_DB_PSQL is built here
# from supabase/config.toml's own project_id, the way tests/e2/helpers/stack.mjs derives the container name, so the
# gate reads those two facts instead of reporting them unread; without the stack it FAILS loudly, as the stack gates
# do, because skipping is not a pass. What it does NOT prove: nothing hosted. D3, D6, D7, D11 and D12 read
# supabase/config.toml here, which is what the local GoTrue and PostgREST read at start, and D5, D13 and D15 print
# NOT APPLICABLE. A green run of this gate says nothing about the hosted project (design section 9).
deploy_check_local() {
  [[ "${E2_DB:-}" == "skip" ]] && return 3
  if ! supabase status >/dev/null 2>&1; then
    printf 'local deploy check: local Supabase is not running (supabase start); skipping is not a pass\n' >&2
    return 2
  fi
  local project
  project=$(sed -n 's/^project_id *= *"\(.*\)"/\1/p' supabase/config.toml)
  if [[ -z "$project" ]]; then
    printf 'local deploy check: supabase/config.toml names no project_id\n' >&2
    return 2
  fi
  ENTERPRISE_DB_PSQL="docker exec -i supabase_db_${project} psql -U postgres -X -At" \
    node scripts/check-deploy.mjs --target local --env tests/e7/fixtures/local.env
}

gate "node version" node_ok "$(node --version)"
gate "syntax" syntax
gate "format and lint (Biome over owned paths, lock and vendor ignored)" format_lint
gate "dependencies pinned and locked" node scripts/check-deps.mjs
gate "secrets (pinned SECRETS rules over tracked files)" node scripts/check-secrets.mjs
gate "adapter integrity (verify mode)" vendor_no_mode_drift
gate "import boundaries" node scripts/check-imports.mjs
gate "browser code rules (scripts/check-web.mjs: the raw-text tripwire over web/; the journeys are the run-time check)" node scripts/check-web.mjs
gate "published site (scripts/build-site.mjs: web/ and the vendored tokens and fonts, hashed, scanned, manifest compared both ways)" node scripts/build-site.mjs --clean --out .scratch/check/site --manifest .scratch/check/site-manifest.json
gate "applied migrations unchanged (pinned by content)" node scripts/check-migrations.mjs
gate "build (render the synthetic fixture pages and scan them)" bash scripts/build.sh
gate "assembly goldens, importer, check and setup-script regressions (node:test)" node --test tests/passport/ tests/setup/
gate "controlled Python launcher, parity, regressions 3, 3b and 7" node scripts/check-python.mjs
gate "E2 unit tests (session, server token, errors, http, boundaries; no stack)" e2_unit
# E3 (E3a): the generated gate manifest is regenerated into .scratch/check/gate-manifest/ and must equal the
# committed lib/passport/gate-manifest.mjs byte for byte, as the lock's verify mode is asserted above; then the
# E3 unit tests, which need no stack and run the pinned validate.py through the controlled flags (-I -B).
gate "E3 gate manifest regenerated and byte-identical (lib/passport/gate-manifest.mjs)" node scripts/gate-manifest.mjs --check
# E4 prerequisites: the installer manifest is regenerated into .scratch/check/installer-manifest/ and must equal the
# committed lib/passport/installer-manifest.mjs byte for byte, beside E3's gate manifest (E4 design 2.6 item 4).
gate "E4 installer manifest regenerated and byte-identical (lib/passport/installer-manifest.mjs)" node scripts/installer-texts.mjs --check
gate "E3 unit tests (gate, rules and Python parity, canonical JSON, manifest, migration text, errors, verify-attestation, capture scan, candidate services and routes; no stack)" node --test tests/e3/unit/
gate "E4 unit tests (tests/e4/unit; no stack)" node --test tests/e4/unit/
# E5 (the server half): the rules, the two services against the PostgREST double, the code tripwire, and the label gate
# of E5 design 1.5, which is a string check over the rule module's own table and over the E5 sources; the same gate over
# the built pages is the pages lane's (evidence/e5-server.md, section 6).
gate "E5 unit tests (tests/e5/unit: the rules, the services, the code tripwire and the truthful-label gate; no stack)" node --test tests/e5/unit/
gate "E6 unit tests (tests/e6/unit: the code pin, and the lifecycle rules and services as they land; no stack)" node --test tests/e6/unit/
gate "E7 unit tests (tests/e7/unit: the code pins, the alert module and the deploy check's pure half and its two-way environment pin; no stack)" node --test tests/e7/unit/
gate "E8 unit tests (tests/e8/unit: the adversarial estate's stack-free half, E8-7's moved-pin reads and the validator adversarial fixtures E8-V1 to E8-V5 against the pinned validate.py; no stack, day 5 adds the stderr shape)" e8_unit
gate "E3 capture prompt scan (capture/enterprise.md against the publisher literals and the pinned spec)" node scripts/check-capture.mjs
gate "local deploy check (scripts/check-deploy.mjs --target local against tests/e7/fixtures/local.env; the hosted target is a written procedure and is never run here)" deploy_check_local
gate "E2 database probes (tests/db against the local stack, reseeded)" db_probes
gate "E2 handler and service tests (tests/e2/stack against the local stack, reseeded)" e2_stack
gate "E3 route tests (tests/e3/stack against the local stack, reseeded; includes the case 20 capacity sample)" e3_stack
gate "E4 route tests (tests/e4/stack against the local stack, reseeded; the service replay, the matrix and the section 6 capacity sample)" e4_stack
gate "E5 route tests (tests/e5/stack against the local stack, reseeded; every caller class of 3.1, the derived check-in and case 24's fail-before)" e5_stack
gate "E6 route tests (tests/e6/stack against the local stack, reseeded; the fifteen routes, the matrix of 3.1, the exit evidence end to end and the section 6 capacity sample)" e6_stack
gate "E7 stack tests (tests/e7/stack against the local stack, reseeded; the mail paths through the catcher, the scripts, the restore rehearsal)" e7_stack
gate "E8 stack tests (tests/e8/stack against the local stack, reseeded; day 2's whole-surface tenancy sweep over the 42 company-bearing routes with its completeness assertion, the guessed-id classes and the demoted administrator's held cookie, and day 3's approval integrity: downloaded content outside a revocation, the concurrent publication schedules, the maintenance credential's grant boundary and the moved installer pin; day 5 adds the stderr sweep)" e8_stack

printf '\n== summary (%s)\n' "$summary"
cat "$summary"
if [[ $failed -ne 0 ]]; then
  printf 'check.sh: FAILED\n'
  exit 2
fi
if [[ $skipped -ne 0 ]]; then
  printf 'check.sh: passed gates only; the E2 stack gates were SKIPPED (E2_DB=skip) and a skip is not a pass\n'
  exit 0
fi
printf 'check.sh: all gates passed\n'
