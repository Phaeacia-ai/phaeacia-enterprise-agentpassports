# Security

This project is archived. **There will be no security fixes, no advisories and no response to reports.** If you find a
vulnerability, fix it in your own fork. The rest of this page says plainly what was and was not checked, so that you
can decide what a deployment of this code would need first.

## The required review was never done

The project's own rules required **one full independent review of the tenancy, session and approval code**, on the
integrated revision, before the data of any company other than Phaeacia's own entered a hosted database. That review
was never commissioned and never happened. No human security reviewer has read this code.

What did happen, and what it does not amount to:

- Every slice in the risk classes (tenancy and row-level security, sessions, authentication and second factors,
  migrations, release and approval transitions) was critiqued by a fresh AI coding session from a different provider
  than the one that wrote it, with executed reproducers, and its critical and high findings were fixed and rechecked.
  Those critiques found real defects that the builders' own green test suites had missed. They are not an independent
  human review, and they only attacked the boundaries someone thought to name.
- Several read-only security reviews and assessments by AI sessions read the whole tree in September and October 2026.
  Their open findings are below.

**Do not put real customer data, or the data of any organisation other than your own, into an instance of this code
without such a review.**

## What was never verified

- **The final revision.** The last changes (migrations 011 and 012 with their service code: the handover-link fix,
  the revocation of a departed administrator's invitations, and the route bound on wrong second-factor codes) were
  merged without the cross-provider critique their risk class required. Their database probes
  (`tests/db/34-invitation-standing.sh`, `tests/db/35-mfa-route-bound.sh`) ran only against an in-process PostgreSQL
  stand-in, never against the Supabase stack, and their two-session concurrency cases have never run anywhere. The full
  local suite and the browser journeys were not run on the final revision.
- **A hosted instance at the final revision.** The one internal instance ran an earlier revision (before migrations
  011 and 012). The hosted deploy check (`scripts/check-deploy.mjs --target hosted`) was never run against it, the
  hosted readiness checklist (an internal document, not published) was never filled, and its signed-in behaviour after the last deploys was observed only by
  its owner's own use.
- **Recovery.** The restore procedure was rehearsed against the local stack only. No hosted backup was ever restored.
- **Capacity.** Measured locally with synthetic data only; never against a hosted project.

## Known limitations

Open when work stopped, in rough order of consequence. File and line references are to this tree.

1. **Second-factor guessing directly at GoTrue.** Migration 012 bounds wrong codes through the product's own route
   (five per account in fifteen minutes). It cannot bound a caller who holds a person's first-factor access token and
   sends codes straight to GoTrue's challenge and verify endpoints with the publishable key; there only GoTrue's own
   per-address rate limit applies. Closing that needs Supabase's MFA verification-attempt hook (migration 004
   installs the function), which Supabase offers only on some paid plans. The internal instance ran without it.
2. **Handover-mode invitations hand out a first factor.** In `handover` mode (the default) the answer to an invitation
   for a new address carries a link that signs that new account in, and the inviting administrator holds it until it
   is used. An administrator who keeps such a session for an invitee could later reach another company's data if a
   second company invites the same person and they accept. `mail` mode removes the handed link. Use `mail` mode.
3. **Sessions are not revocable before they expire.** An access token stays valid at the product's routes for up to
   one hour after sign-out, factor removal or a factor reset. Membership and roles are re-read on every request, so a
   removal or demotion takes effect at the next request, but a first-factor (`aal1`) session can still enrol a factor
   on an account that has none, and a token issued before a step-up keeps working until it expires. Refresh sessions
   do not expire on their own.
4. **A member without a second factor may be able to set a GoTrue password** through GoTrue's own user endpoint with a
   stolen session, turning it into a lasting credential. Inferred from the configuration, never tested.
5. **Rate limits see one address.** GoTrue applies its per-address limits to the functions' egress address, not to the
   person's, so one client can exhaust sign-in for every user of an instance. The product alerts on GoTrue's 429; it
   has no request limiting of its own on the anonymous auth routes.
6. **The refresh route signs a person out on a GoTrue 429 or 5xx** (`lib/session.mjs`, `refreshSession`), treating a
   provider failure as an invalid token.
7. **The vendored Passport validator admits invisible and direction-reversing characters** in a passport body, which
   weakens what a human reviewer can see. The pin in `upstream.lock.json` was never moved to a fixed upstream revision.
8. **Legacy Supabase API keys.** The invitation path and the owner-side scripts call GoTrue's admin API with the legacy
   JWT-format `service_role` key in both the `apikey` and `Authorization` headers (`lib/db/operator.mjs`), and every
   request carries the legacy `anon` key. Supabase has announced the deprecation of the legacy keys. A project without
   them needs `lib/db/operator.mjs` changed to send a new-style secret key in the `apikey` header only, and every other
   reader of `SUPABASE_ANON_KEY` checked.
9. **The maintenance role is wide by design.** `app_maintenance` can update company status, membership status and roles,
   and invitation revocation in every tenant with no rule check and no audit coupling (`001_identity.sql`). No login
   role is a member of it, and none must be.
10. **The owner connection is everything.** Whoever holds `ENTERPRISE_DB_PSQL` can act as any operator and bypasses
    every second factor. Its custody is the only control.
11. **Five membership references are not constrained to the row's own company** at the schema level; the routines that
    write them check it. A tenancy-shaped constraint that a review should look at.
12. **Capacity limits.** The data model is sized for companies of about 25 members. The member list reads at most 150
    rows and the ledger read refuses past 10,000. An administrator's release page over a release with 5,000 download
    rows took 4.9 seconds at the 95th percentile locally.
13. **Release targets are closed.** All four targets are registered not publishable (migration 006), because no native
    transfer into those assistants was ever tested. Opening one is a new migration and a claim nobody has verified.

The internal findings register held further medium and low findings, mostly about maintainability, test portability
and wording. It is not part of this repository.

## What is strong, and where to look

The database is the enforcement layer: every `api` function checks its actor, every `SECURITY DEFINER` function pins
its `search_path`, every view is `security_invoker`, and there is no dynamic SQL. Node refuses early and SQL decides
again under the company lock. The web client has no framework and no runtime dependency, and its CSP with
`trusted-types 'none'` makes string-to-DOM sinks fail outright. `docs/architecture.md` sections 5 and 6 describe the
tenancy and session model; `tests/db/01-privilege-boundary.sh`, `tests/db/02-tenancy.sh` and
`tests/e8/stack/tenancy-sweep.test.mjs` are where a reviewer should start.

## If you run it anyway

- Synthetic data only, unless you commission an independent review of the tenancy, session and approval code first.
- Use `mail` invitation delivery, a Supabase plan with the MFA verification-attempt hook enabled, and ES256 server
  signing (`docs/self-hosting.md`).
- Keep deploy access to the Netlify site to the people who hold the database owner connection: anyone who can deploy
  can ship code that runs with the service key and the signing key.
- Run the full local suite (`bash scripts/check.sh`) and the browser journeys on the exact revision you deploy, then
  `scripts/smoke.mjs` and `scripts/check-deploy.mjs --target hosted` against the deployment, and read every `UNREAD`
  line as a failure.
- Never commit a secret. `scripts/check-secrets.mjs` scans tracked files, and nothing in this repository should hold a
  real credential.
