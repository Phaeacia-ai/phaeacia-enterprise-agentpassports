#!/usr/bin/env bash
# Regression tests for scripts/setup-worktree.sh (setup improvements Part B, 2026-09-11).
#
# The setup script under test is copied into a throwaway Git checkout in a temp directory
# and run with stub `node`, `npm`, `supabase` and `docker` executables first on PATH. The
# node stub answers `--version` from STUB_NODE_VERSION and delegates everything else to
# the real node, so the script's JSON reading works while the version is controlled. The
# npm stub records every invocation and, on exactly `ci --ignore-scripts`, writes the
# fixture's pinned package into node_modules; anything else is an error. The supabase stub
# answers `status` with STUB_STACK_STATUS and marks any other subcommand (start, stop, db
# reset) as a forbidden action that fails the run. No real stack, worktree or global
# setting is touched.
#
# Cases: Node too old fails; a Node version package.json's `>=26.8.1` accepts but the
# .nvmrc gate refuses fails; missing node_modules triggers exactly one
# `npm ci --ignore-scripts`; a present tree with a matching stamp and the pinned package
# at its version triggers none; a stale stamp with an intact tree triggers one; a matching
# stamp with the pinned package missing (and, as a control, at another version) triggers
# one; a stack that is not running is reported and does not fail; a running stack is
# reported (control); no start/stop/reset stub is ever invoked and npm is only ever
# called as `ci --ignore-scripts`.
#
# SETUP_SCRIPT=<path> runs another copy of the script (fail-before evidence against the
# base revision). Exit 0 when every case holds, 1 otherwise.
set -uo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(cd -- "$here/../.." && pwd -P)
script_under_test=${SETUP_SCRIPT:-$repo/scripts/setup-worktree.sh}
[[ -f "$script_under_test" ]] || { printf 'setup tests: script not found: %s\n' "$script_under_test" >&2; exit 1; }
real_node=$(command -v node) || { printf 'setup tests: a real node is required to run the fixture\n' >&2; exit 1; }
command -v git >/dev/null 2>&1 || { printf 'setup tests: git is required\n' >&2; exit 1; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/setup-test.XXXXXX")
tmp=$(cd -- "$tmp" && pwd -P)
trap 'rm -rf "$tmp"' EXIT
checkout="$tmp/checkout"
state="$tmp/state"
mkdir -p "$checkout/scripts" "$tmp/bin" "$state"
cp "$script_under_test" "$checkout/scripts/setup-worktree.sh"

# A throwaway checkout: a .nvmrc and a package.json pinning one fake dependency. Its lock
# content only needs to be hashable.
printf '26.8.1\n' > "$checkout/.nvmrc"
printf '{\n  "name": "fixture",\n  "private": true,\n  "engines": { "node": ">=26.8.1" },\n  "devDependencies": { "fake-pinned": "1.2.3" }\n}\n' > "$checkout/package.json"
printf '{\n  "name": "fixture",\n  "lockfileVersion": 3,\n  "packages": { "node_modules/fake-pinned": { "version": "1.2.3" } }\n}\n' > "$checkout/package-lock.json"
(
  cd -- "$checkout" &&
    git init -q &&
    git -c user.name=fixture -c user.email=fixture@example.invalid commit -q --allow-empty -m fixture
) || { printf 'setup tests: could not initialise the fixture checkout\n' >&2; exit 1; }

cat > "$tmp/bin/node" <<'EOF'
#!/usr/bin/env bash
printf 'node %s\n' "$*" >> "$SETUP_STATE/calls"
if [[ "${1:-}" == "--version" || "${1:-}" == "-v" ]]; then printf 'v%s\n' "$STUB_NODE_VERSION"; exit 0; fi
exec "$REAL_NODE" "$@"
EOF
cat > "$tmp/bin/npm" <<'EOF'
#!/usr/bin/env bash
printf 'npm %s\n' "$*" >> "$SETUP_STATE/calls"
if [[ "$*" == "ci --ignore-scripts" ]]; then
  mkdir -p node_modules/fake-pinned
  printf '{ "name": "fake-pinned", "version": "%s" }\n' "${STUB_INSTALL_VERSION:-1.2.3}" > node_modules/fake-pinned/package.json
  exit 0
fi
printf 'stub npm: unexpected invocation: %s\n' "$*" >&2
: > "$SETUP_STATE/UNEXPECTED_NPM"
exit 1
EOF
cat > "$tmp/bin/supabase" <<'EOF'
#!/usr/bin/env bash
printf 'supabase %s\n' "$*" >> "$SETUP_STATE/calls"
case "$*" in
  status) printf 'fixture status output, discarded by setup\n'; exit "${STUB_STACK_STATUS:-1}" ;;
  *) : > "$SETUP_STATE/FORBIDDEN_STACK_ACTION"; printf 'stub supabase: forbidden action: %s\n' "$*" >&2; exit 1 ;;
esac
EOF
cat > "$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$SETUP_STATE/calls"
exit 0
EOF
chmod +x "$tmp/bin/node" "$tmp/bin/npm" "$tmp/bin/supabase" "$tmp/bin/docker"

pass=0
fail=0
node_version=26.8.1
stack_status=1
install_version=1.2.3
# run_case NAME EXPECTED_EXIT EXPECTED_NPM_CI_COUNT OUTPUT_SUBSTRING
run_case() {
  local name=$1 expect_exit=$2 expect_ci=$3 needle=$4 out status ci_count
  : > "$state/calls"
  out=$(cd -- "$checkout" && PATH="$tmp/bin:$PATH" SETUP_STATE="$state" REAL_NODE="$real_node" \
    STUB_NODE_VERSION="$node_version" STUB_STACK_STATUS="$stack_status" STUB_INSTALL_VERSION="$install_version" \
    bash "$checkout/scripts/setup-worktree.sh" 2>&1)
  status=$?
  ci_count=$(grep -c '^npm ci --ignore-scripts$' "$state/calls" || true)
  if [[ $status -eq $expect_exit && "$ci_count" == "$expect_ci" && "$out" == *"$needle"* ]]; then
    printf 'ok   %-44s exit %s, npm ci x%s\n' "$name" "$status" "$ci_count"
    pass=$((pass + 1))
  else
    printf 'FAIL %-44s expected exit %s, npm ci x%s, output containing "%s"; got exit %s, npm ci x%s:\n%s\n' \
      "$name" "$expect_exit" "$expect_ci" "$needle" "$status" "$ci_count" "$out"
    fail=$((fail + 1))
  fi
}

node_version=24.0.0
run_case 'Node too old fails'                          1 0 '.nvmrc wants 26.8.1'
node_version=26.9.0
run_case 'Node accepted by package.json, refused by gate' 1 0 '.nvmrc wants 26.8.1'
node_version=26.8.1
rm -rf "$checkout/node_modules"
run_case 'missing node_modules installs once'          0 1 'npm ci --ignore-scripts'
run_case 'matching stamp and package installs nothing' 0 0 'stamp matched'
printf 'not-the-lock-hash\n' > "$checkout/node_modules/.enterprise-lock.sha256"
run_case 'stale stamp with intact tree installs once'  0 1 'stale stamp'
rm -rf "$checkout/node_modules/fake-pinned"
run_case 'matching stamp, package missing installs once' 0 1 'pinned package not in place'
printf '{ "name": "fake-pinned", "version": "1.2.2" }\n' > "$checkout/node_modules/fake-pinned/package.json"
run_case 'matching stamp, package at other version (control)' 0 1 'pinned package not in place'
stack_status=1
run_case 'stack not running is reported, no failure'   0 0 'local stack not running'
stack_status=0
run_case 'stack running is reported (control)'         0 0 'local stack running'

if [[ -e "$state/FORBIDDEN_STACK_ACTION" ]]; then
  printf 'FAIL a stack start/stop/reset stub was invoked\n'
  fail=$((fail + 1))
else
  printf 'ok   %-44s no start, stop or reset stub was invoked\n' 'never touches the stack'
  pass=$((pass + 1))
fi
if [[ -e "$state/UNEXPECTED_NPM" ]]; then
  printf 'FAIL npm was invoked with something other than ci --ignore-scripts\n'
  fail=$((fail + 1))
else
  printf 'ok   %-44s npm only ever ran ci --ignore-scripts\n' 'npm invocation shape'
  pass=$((pass + 1))
fi

printf '\nsetup-worktree tests: %s passed, %s failed (%s)\n' "$pass" "$fail" "$script_under_test"
[[ $fail -eq 0 ]]
