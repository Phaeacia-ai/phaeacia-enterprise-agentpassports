#!/usr/bin/env bash
# Build gate (architecture section 11): copy the vendored stylesheets and fonts
# byte-exact into .scratch/build/assets/, render every synthetic fixture page
# with the derived private renderer (lib/passport/render.mjs) and scan the
# rendered HTML for the public shell strings and for a no-loss outcome on a
# page rendered without an installation record. Contract and the string list:
# docs/e1/passport-adapter.md section 5; the scan and the page list live in
# scripts/check-render.mjs. No server, no network, nothing is served: the
# pages are files under .scratch/build/ for inspection and screenshots.
# Usage: bash scripts/build.sh [--out <dir>]
set -u

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$repo" || exit 2
exec node scripts/check-render.mjs "$@"
