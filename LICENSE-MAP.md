# Which licence covers which file

Anything not named below is covered by the Apache License 2.0 in `LICENSE`, with the attribution notice in `NOTICE`.
Copyright 2026 Phaeacia, a project by Raffael Hüberli, for everything below that is not third-party.

## Apache License 2.0

| path | what it is |
|---|---|
| `lib/`, `netlify/`, `web/`, `scripts/`, `tests/` (except where listed below) | the application, its owner-side tools and its tests |
| `supabase/` (except the embedded installer texts below) | the database configuration, migrations and mail template |
| `docs/`, `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, root configuration files | documentation and configuration |
| `lib/passport/render.mjs`, `lib/passport/assemble.mjs` | ports of Agent Passport code (`vendor/passport/web/lib/_render.mjs`, `vendor/passport/scripts/assemble.py`), which is Apache 2.0 under the same copyright |

## Agent Passport, vendored under `vendor/passport/`

A byte-exact copy of 193 files of Agent Passport at the revision pinned in `upstream.lock.json`. The files are never
edited here (`node scripts/import-passport.mjs --verify` fails on any change), so they keep upstream's own notices:

| path | licence | notice |
|---|---|---|
| `vendor/passport/tools/`, `vendor/passport/scripts/`, `vendor/passport/web/lib/`, `vendor/passport/web/tools/`, `vendor/passport/web/assets/*.css`, `vendor/passport/verification/judge-prompt.md` | Apache 2.0 | `vendor/passport/LICENSE`, `vendor/passport/NOTICE` |
| `vendor/passport/spec/` | CC BY 4.0 | `vendor/passport/spec/LICENSE.md` |
| `vendor/passport/installer/` | CC BY 4.0 | `vendor/passport/installer/LICENSE.md` |
| `vendor/passport/examples/daily-brief-passport.md` | CC BY 4.0 | the format's licence, `vendor/passport/spec/LICENSE.md` |
| `vendor/passport/publish/LICENSE-MAP.md` | CC BY 4.0 | upstream's map for its skill export, kept because the import copies it; it describes files that are not in this tree |
| `vendor/passport/web/assets/fonts/*.woff2` (Schibsted Grotesk, DM Mono) | SIL Open Font License 1.1, third party | `vendor/passport/web/assets/fonts/OFL.txt` |
| `vendor/passport/web/assets/fonts/og/*.ttf` (Schibsted Grotesk and DM Mono re-saved, Noto Sans subset) | SIL Open Font License 1.1, third party | `vendor/passport/web/assets/fonts/og/NOTICE.txt`, text in `../OFL.txt` |
| `vendor/passport/web/assets/mark/` | the Phaeacia mark; see "Names and marks" | |

CC BY 4.0 legal code: https://creativecommons.org/licenses/by/4.0/legalcode

`scripts/build-site.mjs` copies the vendored tokens, the font stylesheet, three font files and `OFL.txt` into the
published site under `assets/vendor/`, so a deployed instance serves the OFL fonts with their licence beside them.

## Embedded copies of Agent Passport text

| path | what is embedded | licence of the embedded text |
|---|---|---|
| `supabase/migrations/006_reviews_releases.sql`, section A6 | the four installer texts (installer core, one branch per target, and the judge prompt) registered for the gate identity, inserted verbatim | installer core and branches CC BY 4.0; judge prompt Apache 2.0 |
| a release's assembled install block, at run time | the same installer texts inside the passport's section 5 | as above |

## CC BY 4.0: the capture prompt

`capture/enterprise.md` (the capture prompt the product serves on its capture page) and
`tests/native-transfer/passport/private-capture-prompt.txt` (the text it was derived from) are modified copies of
Agent Passport's browser capture prompt, `capture/path-w-prompt.md`. Agent Passport relicensed that prompt from all
rights reserved to CC BY 4.0 when both projects were archived, and these two derived files are CC BY 4.0 with it.

The vendored copy under `vendor/passport/` is byte-exact at the pinned revision, so its notices
(`vendor/passport/NOTICE`, `vendor/passport/spec/LICENSE.md`, `vendor/passport/installer/LICENSE.md`) name the holder
as it stood then, and the two licence files still describe the capture prompt as proprietary. For the prompt's current
terms, the published Agent Passport repository's `capture/LICENSE.md` is the authority:
https://github.com/Phaeacia-ai/phaeacia-agent-passport/blob/main/capture/LICENSE.md

## Names and marks

Neither licence grants rights to the name "Phaeacia" or the Phaeacia mark (Apache 2.0 section 6; CC BY 4.0 section
2(b)(2)). The mark files are in `vendor/passport/web/assets/mark/` (copied by the import, not served by this
application), and the name "Phaeacia" is in every page's header and title under `web/`, in the mail templates and in
the product's own text. A fork that runs or redistributes the application should replace them with its own.
