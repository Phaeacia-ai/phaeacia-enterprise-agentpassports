# `tests/e8/`

The cross-slice adversarial tests: checks that cut across features, such as a sweep of every route with another
company's ids, rather than belonging to one of them.

| Path | What it holds |
|---|---|
| `unit/installer-pin.test.mjs` | A release keeps the installer text it was published with: the release answer carries the stored hash, and only the publish path imports an assembler. |
| `unit/validator-fixtures.test.mjs` | The adversarial passports in `fixtures/`, each run through the enterprise intake gate and through the pinned `validate.py`, with the expected verdict of each side. |
| `unit/stderr-shape.test.mjs` | Every log site in `lib/http/` and `lib/services/` checked against the allowlist of content-free fields, statically and through the real pipeline against fakes. |
| `unit/completeness.test.mjs` | The owner-side export's completeness check names any section the database counted that the document does not carry. |
| `stack/tenancy-sweep.test.mjs` | Every company-bearing route called with another company's ids for four caller classes, guessed ids, and a completeness assertion over the route table, so a route that is neither swept nor explicitly excluded fails. |
| `stack/sessions.test.mjs` | An administrator's second-factor cookie held across a demotion, against every route a plain member is refused. |
| `stack/revocation.test.mjs` | A withdrawn release refuses the next download and leaves the ledger untouched; publication and withdrawal racing under the agent row's lock. |
| `stack/maintenance.test.mjs` | The `app_maintenance` role's grant boundary, read from the catalogue, against what `docs/architecture.md` section 5 discloses. |
| `stack/installer-pin.test.mjs` | A release published under one installer text, the registered text moved, and the stored release downloaded unchanged. |
| `stack/stderr-sweep.test.mjs` | Every declared route called with hostile strings in the body, the path and the headers, and with the providers failing; no log line or alert may carry them, and nothing may be written. |
| `stack/export-withholdings.test.mjs` | The administrator's export and the owner-side export of one company compared row by row; their differences must equal the documented withholdings. |
| `fixtures/` | The adversarial passports (`v1-*` to `v4-*`) and `hostile-strings.mjs`. |
| `helpers/no-write.mjs` | Row counts, and optionally a content digest, of every `app` table, `auth.users` and the register, taken around a block that must write nothing. |
| `helpers/mutant-lib.mjs` | Builds a "fail-before" mutant as a copy of `lib/` under `.scratch/`, reachable through a real route table. |
| `load/` | The load harness at the capacity envelope. Not a gate; see `load/README.md`. |

`scripts/check.sh` runs `unit/` in its E8 unit gate (`node --test tests/e8/unit/`, which launches Python for the
validator fixtures) and `stack/` in its E8 stack gate (`node --test --test-concurrency=1 tests/e8/stack/`, one file at
a time because each reseeds the local stack). Both gates print that nothing ran if their directory holds no test file.

Case ids (E8-1, E8-V1 and the like) and finding ids in the files' headers refer to the project's private design and
review history, which is not published.
