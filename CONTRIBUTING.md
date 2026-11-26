# Contributing

This repository is archived. Pull requests and issues are not reviewed, and nothing will be merged or released. To
change the code, fork it.

## Running the checks in a fork

Work from a git clone, not a downloaded ZIP: the secret scan lists tracked files with `git ls-files`.

```sh
npm ci --ignore-scripts
bash scripts/setup-worktree.sh        # checks Node 26.8.1, Python 3 and the pinned dependency; reports Docker and Supabase
E2_DB=skip bash scripts/check.sh      # every gate that needs no database
```

With Docker and the Supabase CLI:

```sh
supabase start
bash scripts/check.sh                 # every gate, the database probes and route suites included (one to several hours)
node tests/browser/run-journeys.mjs --label my-run      # needs Chrome; CHROME_PATH if not at the macOS default
```

A gate that did not run reports SKIP, never PASS. Nothing else may use the local stack while the full suite or the
journeys run, because each stack file reseeds the database. `docs/self-hosting.md` section 1 lists the host tools the
stack suites need on Linux, what fails when they run as root, and the gates known to fail intermittently.

## Rules the checks enforce

- **Applied migrations are never edited.** `scripts/check-migrations.mjs` pins each file in `supabase/migrations/` by
  content. A change is a new numbered migration that replaces a routine with `create or replace`.
- **`vendor/passport/` is never edited.** `node scripts/import-passport.mjs --verify` compares it with
  `upstream.lock.json`. Moving the pin means importing a new Agent Passport revision with the script's default mode
  and regenerating `lib/passport/gate-manifest.mjs` (`node scripts/gate-manifest.mjs`) and
  `lib/passport/installer-manifest.mjs` (`node scripts/installer-texts.mjs`); a new gate identity also needs its
  installer texts registered by a new migration.
- **The import graph is checked.** `scripts/check-imports.mjs` refuses, among other things, a database client
  imported from a function wiring, any IO in `lib/rules/`, and an edge from `lib/http/` to `lib/operator/`.
- **No secret in the tree.** `scripts/check-secrets.mjs` runs the vendored validator's secret rules over every tracked
  text file.
- **Text pins.** Many unit tests read source and migration text and compare it with what the code does. A change to a
  line of `lib/` or `netlify/` should be followed by `grep -rn` for that line's text under `tests/`, and every file
  that quotes it run, stack files included.
- **Journeys read service answers.** `scripts/check.sh` runs no browser journey, so a change to a service answer or a
  default that a page reads needs the journeys that read it.

## Forks

Use your own name and mark: the licence does not cover the Phaeacia name or mark (see `NOTICE`). Read `SECURITY.md`
before you deploy anything.
