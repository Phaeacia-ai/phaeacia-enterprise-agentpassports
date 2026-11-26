# Phaeacia Enterprise

**Archived.** Phaeacia Enterprise is a multi-company workspace for reviewing and distributing AI agent configurations
written as Agent Passports. Phaeacia built it in 2026 and ran one internal instance for its own use; it was never
offered to customers. There is no hosted instance: the internal one is shut down with this archive. To use it, you
host your own, on Supabase and Netlify with Resend for mail; [docs/self-hosting.md](docs/self-hosting.md) says how. The code is
published as-is under the Apache License 2.0 (the capture prompt under CC BY 4.0) so the work stays available to study,
run and fork. There is no support, no roadmap and no security fixes. Read [SECURITY.md](SECURITY.md) before running it
with anything but synthetic data: the independent security review its own rules required was never done.

## What it is

A shared workspace where a company collects the useful AI agents its people have built for themselves, has each one
reviewed, and hands approved ones to colleagues. An agent comes in as an [Agent Passport](https://github.com/Phaeacia-ai/phaeacia-agent-passport):
one Markdown file that describes an agent's configuration so that someone else can set it up again in their own
assistant, with a losses table that says what does not carry over.

Inside one company:

- a member uploads a passport, which passes an intake gate (format, secret scan, refusal of public publishing routes)
  and becomes a private draft, then submits it as a frozen version;
- an IT reviewer and a business reviewer who did not contribute to it approve it or ask for changes;
- an administrator publishes it to named groups, for one target assistant;
- a recipient downloads the assembled install block, pastes it into their own assistant, and can report whether it
  worked; reviewers can witness that report; every download is recorded;
- administrators invite and remove people, transfer agents, withdraw releases and export the company's records.

A separate operator account creates companies, sets their agreement dates and quotas, and suspends, closes, deletes and
restores them.

It does not run agents and does not reach into anyone's assistant. Approval governs the configuration a recipient
receives, not what their assistant does with it. As shipped, **all four release targets are closed** (ChatGPT,
claude.ai, Claude Code and a generic one): reviews work, but nothing can be published or downloaded until a migration
opens a target, because no native transfer into those assistants was ever tested.

## How it works

```
 browser ── web/ static pages, no framework; strict CSP with Trusted Types; HttpOnly session cookies
    ▼
 netlify/functions/ ── one five-line wiring per route
    ▼
 lib/http/ ── request pipeline ── lib/services/ ── lib/rules/ (pure) and lib/passport/ (over vendor/passport/)
    ▼
 lib/db/ ── three clients, one database role each
    ▼
 Supabase: Postgres with row-level security and SECURITY DEFINER functions; GoTrue for sign-in and TOTP
```

The database is the enforcement layer. Every table is in a private schema; callers read through `security_invoker`
views under row-level security and write only through functions that lock the company, check the caller's standing and
roles, write, and audit in one transaction. Node refuses early for clearer errors and the SQL decides again. Sign-in is
by emailed link only; administrators and the operator need a TOTP second factor. The server calls the database with a
60-second token minted from the caller's verified session, optionally bound to one function and one exact argument
set.

[docs/architecture.md](docs/architecture.md) has the module map, data ownership, the tenancy and RLS model, sessions
and second factors, the approval and release lifecycle, the permission matrix and what the Passport adapter does.

## Repository map

| Path | What is there |
|---|---|
| `web/` | the pages and their modules (`web/assets/app/`) |
| `netlify/functions/` | 58 route wirings and the scheduled check-in |
| `lib/http/` | the Netlify adapter, the request pipeline, the route table, responses and alerts |
| `lib/session.mjs`, `lib/auth/` | session verification and cookies; second factors |
| `lib/services/` | one module per feature |
| `lib/rules/` | pure rules that mirror the database's vocabularies |
| `lib/db/` | the three database clients |
| `lib/passport/` | the intake gate, assembly, rendering and the generated gate and installer manifests |
| `lib/operator/`, `scripts/` | owner-side tools (register, export, deletion, account sweep, recovery) and the local checks |
| `supabase/` | local configuration, the twelve migrations and the sign-in mail template |
| `capture/enterprise.md` | the capture prompt a member pastes into their assistant to produce a passport |
| `vendor/passport/` | a byte-exact copy of Agent Passport at the revision pinned in `upstream.lock.json` |
| `tests/` | unit tests per slice (`tests/e2/` to `tests/e8/`), database probes (`tests/db/`), route tests against a local stack, browser journeys (`tests/browser/`), load and measurement harnesses |
| `docs/` | [architecture](docs/architecture.md), [self-hosting](docs/self-hosting.md), the [environment contract](docs/environment.md) and the [administrator guide](docs/admin-guide.md) |

## Quick start

You need Node 26.8.1 exactly (`.nvmrc`), npm, Python 3, Docker, the Supabase CLI and, for the browser journeys, Chrome.

```sh
npm ci --ignore-scripts
E2_DB=skip bash scripts/check.sh      # every check that needs no database
supabase start                        # local Postgres, GoTrue and PostgREST; applies supabase/migrations/
bash tests/db/00-seed.sh              # two synthetic companies and seven synthetic accounts
node tests/browser/dev-shell.mjs      # serves the site and the real routes against the local stack
```

Signing in locally needs a link minted through GoTrue's admin API, because the local stack sends no mail;
[docs/self-hosting.md](docs/self-hosting.md) section 1 has the command and the seeded accounts.

## Tests

| Command | Needs | What it runs |
|---|---|---|
| `E2_DB=skip bash scripts/check.sh` | Node, npm, Python 3, a git clone (the secret scan lists tracked files with `git ls-files`, so a downloaded ZIP fails it) | formatting and lint (Biome), syntax, pinned dependencies, the secret scan, import boundaries, the web tripwire, the site build, migration pins, vendor verification, the Passport goldens, Python parity, the generated manifests, and every unit suite; the stack gates report SKIP |
| `node --test tests/e2/unit/ tests/e3/unit/ tests/e4/unit/ tests/e5/unit/ tests/e6/unit/ tests/e7/unit/ tests/e8/unit/` | Node, Python 3 | the stack-free unit suites alone |
| `bash scripts/check.sh` | a running local stack | everything above plus the database probes, the local deploy check and every route suite; each stack file reseeds the database |
| `node tests/browser/run-journeys.mjs --label <name>` | a running local stack and Chrome | the browser journeys at desktop and phone width |

`scripts/check.sh` exits 2 if any gate fails and prints SKIP, never PASS, for a gate it did not run.

## Self-hosting

[docs/self-hosting.md](docs/self-hosting.md) describes standing up an instance on Supabase and Netlify with Resend for
mail, creating the first operator, the register that survives a restore, and operating it. It is generalised from the
procedure used for the one internal instance; parts of it were never run against a hosted project, and it says which.

## Security status

No independent security review was done, the last revision was merged without its required critique and never ran
on a hosted instance, and there will be no fixes. [SECURITY.md](SECURITY.md) lists what was and was not verified and
the known limitations.

## Licence

Apache License 2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). The vendored Agent Passport keeps its own notices: its
format specification and installer text are CC BY 4.0, and its fonts are under the SIL Open Font License.
The capture prompt this application serves (`capture/enterprise.md`, modified from Agent Passport's) is CC BY 4.0
too. [LICENSE-MAP.md](LICENSE-MAP.md) lists which licence covers which path. The licence does not grant rights to the Phaeacia name or mark; a fork should use its own.

## History

Phaeacia Enterprise was built between September and October 2026 as the company-facing side of Agent Passport. Almost
all of its code, tests and documents were written by AI coding sessions working under a written process: Claude
sessions as lead and builders, fresh sessions of a different provider as critics for code where a defect would expose
data or grant access, and the owner deciding scope and release. One internal instance was deployed for Phaeacia's own
use from late September 2026; no other company's data entered it. Work stopped in October 2026 with the security
fixes of the last change merged without the review the project's own rules required, and in November 2026 Phaeacia
decided to end agent sharing as a business and publish the code.

Code comments cite internal tracker ids (such as `E6S-C-F1`), design sections and review records from the project's
private history, which is not public.

## Credits

Krunal Rathod contributed to the design and code of Phaeacia Enterprise.
