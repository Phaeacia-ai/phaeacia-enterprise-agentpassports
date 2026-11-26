#!/usr/bin/env bash
# E2 database check: apply supabase/migrations against the local Supabase stack and run
# the tests/db probes in order. Requires a running local stack (`supabase start`) and
# Docker; never touches a hosted project. Not wired into scripts/check.sh yet (E2 design
# pass); the E2 implementation assignment decides the wiring.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! supabase status >/dev/null 2>&1; then
  echo "check-db: local Supabase is not running (supabase start); skipping is not a pass" >&2
  exit 2
fi
# Stop at the first failed probe (L2): later probes assume the state the earlier ones left,
# and a failed seed must never be followed by probes against an unknown database.
for probe in tests/db/[0-9][0-9]-*.sh; do
  echo "### $probe"
  if ! bash "$probe"; then echo "### $probe FAILED"; echo "check-db: FAILED at $probe"; exit 1; fi
done
echo "check-db: all probes passed"
