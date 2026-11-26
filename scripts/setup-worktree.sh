#!/usr/bin/env bash
# Checkout setup. Run it by hand in a fresh clone; it is safe to rerun at any time.
#
# Establishes, and fails otherwise:
#   - git, python3 (the controlled launcher in scripts/check-python.mjs), npm;
#   - node at exactly the .nvmrc version. scripts/check.sh's mandatory first gate refuses
#     any other version, so setup never declares a checkout ready on a version the gate
#     refuses. package.json's `>=` engine range is weaker and is not the rule here;
#   - the pinned dependencies from package.json, installed with `npm ci --ignore-scripts`
#     only when needed. Need is decided from content, never from directory mtimes: a
#     stamp under node_modules/ holding the SHA-256 of package-lock.json at the last
#     successful install, together with a check that every pinned package is present at
#     its pinned version. A missing tree, a missing or stale stamp, or a missing or
#     mismatched package triggers exactly one install; a matching stamp with every
#     package in place triggers none.
#
# Observes and reports, never changes: whether the supabase and docker CLIs are on PATH
# and whether a local Supabase stack is running (`supabase status`, read-only, output
# discarded because it prints keys). tests/db/00-seed.sh resets the stack. This script never starts, stops or resets the stack,
# never changes global settings, never provisions anything, and establishes nothing
# about native-app support. Quiet on success: a short readiness summary, nothing else.
set -euo pipefail

fail() {
  printf 'Enterprise setup failed: %s\n' "$1" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail 'Git is required.'
command -v python3 >/dev/null 2>&1 || fail 'Python 3 is required (scripts/check-python.mjs launches it).'
command -v node >/dev/null 2>&1 || fail 'Node is required (see .nvmrc).'
command -v npm >/dev/null 2>&1 || fail 'npm is required to install the pinned dependencies.'

enterprise_checkout=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$enterprise_checkout"
enterprise_git_root=$(git rev-parse --show-toplevel) || fail 'This script must belong to a Git checkout.'
[[ "$(cd -- "$enterprise_git_root" && pwd -P)" == "$enterprise_checkout" ]] || fail 'The script is outside the checkout root.'

for required_file in .nvmrc package.json package-lock.json; do
  [[ -s "$required_file" ]] || fail "Missing required file: $required_file"
done
python3 -c 'import sys; assert sys.version_info.major == 3' || fail 'Python 3 could not run.'

# Node: the exact .nvmrc version, the same comparison scripts/check.sh makes.
want_node=$(tr -d '[:space:]' < .nvmrc)
have_node=$(node --version 2>/dev/null) || fail 'node --version failed.'
have_node=${have_node#v}
[[ "$have_node" == "$want_node" ]] || fail "node $have_node, .nvmrc wants $want_node; scripts/check.sh refuses this version, so setup does not declare the checkout ready (package.json's engine range is not the gate)."

# Dependencies. The stamp records which lock content the tree was installed from.
lock_sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 package-lock.json | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum package-lock.json | awk '{print $1}'
  else fail 'Neither shasum nor sha256sum is available to stamp the lock.'
  fi
}
stamp_file=node_modules/.enterprise-lock.sha256
lock_hash=$(lock_sha256)

# pinned_packages prints "name version" for every dependency package.json declares.
pinned_packages() {
  node -e '
    const pkg = JSON.parse(require("node:fs").readFileSync("package.json", "utf8"));
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
    for (const [name, version] of Object.entries(all)) console.log(name, version);
  '
}
# missing_packages prints one line per pinned package that is absent or at another version.
missing_packages() {
  local name version installed
  while read -r name version; do
    [[ -n "$name" ]] || continue
    installed=$(node -e '
      try { console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version ?? ""); }
      catch { console.log(""); }
    ' "node_modules/$name/package.json")
    if [[ -z "$installed" ]]; then printf '%s absent (want %s)\n' "$name" "$version"
    elif [[ "$installed" != "$version" ]]; then printf '%s at %s (want %s)\n' "$name" "$installed" "$version"
    fi
  done < <(pinned_packages)
}

install_reason=""
if [[ ! -d node_modules ]]; then
  install_reason='node_modules is missing'
elif [[ ! -f "$stamp_file" ]]; then
  install_reason='no lock stamp under node_modules'
elif [[ "$(tr -d '[:space:]' < "$stamp_file")" != "$lock_hash" ]]; then
  install_reason='package-lock.json changed since the last install (stale stamp)'
else
  gap=$(missing_packages)
  [[ -z "$gap" ]] || install_reason="pinned package not in place: $(printf '%s' "$gap" | head -1)"
fi

dependency_state='dependencies present per package-lock.json (stamp matched, pinned packages verified)'
if [[ -n "$install_reason" ]]; then
  printf 'Installing dependencies: %s\n' "$install_reason"
  npm ci --ignore-scripts >/dev/null || fail 'npm ci --ignore-scripts failed.'
  gap=$(missing_packages)
  [[ -z "$gap" ]] || fail "after npm ci a pinned package is still not in place: $(printf '%s' "$gap" | head -1)"
  printf '%s\n' "$lock_hash" > "$stamp_file"
  dependency_state="dependencies installed with npm ci --ignore-scripts ($install_reason), pinned packages verified, stamp written"
fi

# Stack tooling: observed only.
supabase_state='supabase CLI not on PATH'
stack_state='local stack state unknown (no supabase CLI)'
if command -v supabase >/dev/null 2>&1; then
  supabase_state='supabase CLI on PATH'
  # `supabase status` prints the local keys; the output is discarded, only the exit code is read.
  if supabase status >/dev/null 2>&1; then stack_state='local stack running'; else stack_state='local stack not running'; fi
fi
docker_state='docker not on PATH'
command -v docker >/dev/null 2>&1 && docker_state='docker on PATH'

printf 'Enterprise checkout ready: %s at %s\n' "$enterprise_checkout" "$(git rev-parse --short HEAD)"
printf 'Established: git, python3, npm, node %s (= .nvmrc, the version scripts/check.sh requires); %s.\n' "$have_node" "$dependency_state"
printf 'Observed, not changed: %s; %s; %s.\n' "$supabase_state" "$docker_state" "$stack_state"
printf '%s\n' 'tests/db/00-seed.sh resets the local stack; this setup never starts, stops or resets it, changes no global settings, provisions nothing and establishes nothing about native-app support.'
