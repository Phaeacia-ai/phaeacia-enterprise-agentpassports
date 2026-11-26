# Architecture

How Phaeacia Enterprise is put together: the module map, who owns which data, how tenancy is enforced, how sessions
and second factors work, the approval and release lifecycle, the permission matrix, and what the Agent Passport
adapter does. Where this page and the code disagree, the code and its tests are right; every section names the files
to read.

## 1. What the system does

A company is a tenant. Its members put in agent configurations as **passports** (one Markdown file each, in the
Agent Passport 0.1 format). A passport passes an intake gate, becomes a private draft, is submitted as a frozen
version, is reviewed by an IT reviewer and a business reviewer who did not contribute to it, and is then published by
an administrator to named groups of members. A recipient downloads an assembled install block for one target
assistant, and can report whether the installation worked; reviewers and administrators can witness that report. Every
download is recorded in a ledger. Administrators invite and remove people, transfer agents between owners, withdraw
releases and export the company's records. A separate operator principal creates companies, sets their agreement
dates and quotas, suspends, closes and deletes them, and recovers them after a database restore.

What it does not do: it does not run agents, it does not reach into a recipient's assistant, and approval does not
grant an assistant any permission. The install block is text a person pastes into their own assistant.

**Release targets are all closed.** Migration 006 registers the four targets `chatgpt`, `claude-ai`, `claude-code` and
`generic` with `publishable = false` (`supabase/migrations/006_reviews_releases.sql`, section A6), because no native
transfer into those assistants was ever tested. Reviews and envelopes work for every target; publication refuses until
a later migration sets a target publishable. As shipped, nobody can publish, download or install anything.

## 2. The layers

```
 browser ── web/: static pages, no framework; one module may call the network (web/assets/app/api.mjs)
    │        HttpOnly, Secure, SameSite=Strict cookies; JSON bodies; CSP with Trusted Types
    ▼
 netlify/functions/*.mjs ── 59 files: 58 routes of five lines each, plus the scheduled check-in
    ▼
 lib/http/ ── Netlify adapter, the request pipeline, request and response helpers, the route table, alerts
    │   ├── lib/session.mjs       verifies the access cookie; the only holder of the browser's token
    │   └── lib/auth/factors.mjs  TOTP enrol and verify against GoTrue with the caller's own token
    ▼
 lib/services/ ── one module per feature: early refusals and orchestration
    │   ├── lib/rules/            pure functions, no IO
    │   └── lib/passport/         intake gate, assembly and rendering over vendor/passport/
    ▼
 lib/db/ ── user.mjs (role authenticated) · server.mjs (role app_server) · operator.mjs (service role, GoTrue admin only)
    ▼
 Supabase: Postgres 17 (schema app private, schema api exposed through PostgREST) and GoTrue for sign-in and factors
    ▲
 scripts/ + lib/operator/ ── owner-side tools, run on the operator's machine over the owner connection
```

**The database is the authoritative enforcement layer.** Row-level security and `SECURITY DEFINER` functions in
`supabase/migrations/` decide every read and write a request makes. Node refuses early so that a person gets a precise
error, and the SQL decides again after taking the company lock. A Node check that repeats a SQL check is defence in
depth, not a second policy: when they disagree, the SQL is right and a test that compares the two fails (for example
`ROLE_NAMES` in `lib/rules/roles.mjs` against `app.role_names()`).

### Module map

| Layer | Where | Boundary rule, and what enforces it |
|---|---|---|
| Static pages | `web/`, published as `.site/` by `scripts/build-site.mjs` | No inline script, no HTML parsing, no storage API, one network module. `netlify.toml` sets `script-src 'self'`, `require-trusted-types-for 'script'` and `trusted-types 'none'`, so no string-to-DOM sink works at all. `scripts/check-web.mjs` is a text tripwire over `web/`; the browser journeys assert at run time that no CSP or Trusted Types violation occurs. |
| Function wirings | `netlify/functions/` | Five lines each: import `makeRoutes()`, export one route and its `config.path` and `config.method`. `tests/e2/unit/route-identity.test.mjs` fails if a file's path differs from its handler's declaration. No function may import a database client (`scripts/check-imports.mjs`). |
| HTTP | `lib/http/` | `pipeline.mjs` fixes the order of every request (section 3). `routes.mjs` declares each route's method and path. Every answer is `private, no-store` (`response.mjs`). Log lines and alerts are an allowlist of content-free fields (`alerts.mjs`). |
| Sessions and factors | `lib/session.mjs`, `lib/auth/factors.mjs` | The session module is the only constructor of a verified session, recognised by identity through a module-private `WeakSet`; the access token lives in a `WeakMap` and is never a property a log line could print. Factors use the caller's own token and never the service key. |
| Services | `lib/services/` | May import `lib/rules/`, `lib/db/` and `lib/passport/`, never `lib/session.mjs` or `lib/http/`. `principal.mjs` loads the caller's membership once per request and never caches it. |
| Pure rules | `lib/rules/` | No IO of any kind: the import checker refuses `fetch`, `process`, `globalThis` and any `node:` import there. |
| Database clients | `lib/db/` | Three clients, one database role each (section 5). The service-role client refuses any path outside `/auth/v1/admin/` after URL normalisation. |
| Passport adapter | `lib/passport/`, `vendor/passport/` | `vendor/` is a byte-exact copy of Agent Passport at a pinned revision, verified on every check run. Section 11. |
| Owner-side tools | `lib/operator/` (pure), `scripts/` (credentials, child processes, disk) | Never reachable from a route: `lib/http/` has no import path to `lib/operator/`. Export, deletion, the account sweep, the register and the reconciler. |

`scripts/check-imports.mjs` enforces the import graph over `lib/`, `netlify/` and `scripts/`: which directory may
import which, that only `lib/operator/`, `scripts/`, `tests/` and `lib/services/invitations.mjs` may import the
service-role client, that only `lib/services/` and `lib/operator/` may import the server client, and that nothing
under `lib/` imports a test-only vendored file. It resolves real module specifiers, including dynamic imports with a
literal path, and fails on a cycle.

## 3. The request path

`lib/http/netlify.mjs` adapts Netlify's request to the route's handler and catches anything that escapes it.
`lib/http/pipeline.mjs` then runs, per request, in this order and no other:

1. **The maintenance switch.** `ENTERPRISE_ACCESS_STATE` must be exactly `open`, else 503 `E_MAINTENANCE` before
   anything is read from the request. Unset is closed.
2. **The method**, else 405.
3. **The cross-site refusal for mutations.** `Sec-Fetch-Site: cross-site`, or an `Origin` that is not
   `ENTERPRISE_ORIGIN` (the literal `null` included), is 403. A request with no `Origin` is admitted because the mail
   provider's webhook sends none; the `SameSite=Strict` cookies and the JSON content type already deny cross-site form
   posts.
4. **The session**, verified from the cookie (section 6), else 401 with a generic code; the specific reason is logged,
   not returned. When the signing keys cannot be loaded at all a required session answers 503.
5. **Route parameters that must be uuids**, else 404, so a malformed id and an unknown id answer alike.
6. **The body the route declares**, else 415, 413 or 422. Nothing reads the body before this step, so an oversized or
   failing stream cannot pre-empt steps 1 to 5. Ordinary JSON bodies are capped at 16 KiB
   (`MAX_BODY_BYTES`, `lib/http/request.mjs`); a passport submission at 256 KiB (`MAX_PASSPORT_BYTES`).
7. **The handler**, which calls one service. Errors come from a closed vocabulary (`lib/errors.mjs`, about 150 codes),
   pinned against every SQL `raise` site by the unit tests, so no PostgREST detail reaches a caller.

The content routes that write (upload, save, submit, successor, envelope, review, publish, withdraw, installation
report and witness) take an `Idempotency-Key` header. The key is bound into the server token's
argument hash (section 5) and stored per member in `app.idempotency_keys`, so a retried request with the same key and
the same arguments replays the first answer and a different body under the same key is refused.

## 4. Data ownership

Every table lives in schema `app`, which PostgREST does not expose. Callers read through `security_invoker` views in
schema `api` and write only through functions in schema `api`. The migrations, in order:

| Migration | What it owns |
|---|---|
| `001_identity.sql` | Schemas `app` and `api`, the database roles, `companies`, `memberships`, `invitations`, `profiles`, `operators`, `operator_allowlist`, the append-only `audit_events` with its shape guard, the RLS policies and the administrator MFA requirement. |
| `002_bound_principal.sql` | A server token bound to one content function (an `fn` claim) can reach no identity function. |
| `003_content.sql` | `agents`, `candidate_versions`, `candidate_contributors`, the gate registry (`gate_identities`, `gate_identity_files`), `idempotency_keys`, and the four content routines. |
| `004_content_rules_and_profiles.sql` | Display names, the content rule fixes, and the MFA verification-attempt hook (`mfa_attempt_windows`; it needs a Supabase plan that offers the hook). |
| `005_invitations_aal2.sql` | Invitation rows readable only at `aal2`. |
| `006_reviews_releases.sql` | `groups`, `group_members`, the registers (`release_targets`, `installer_texts`, `release_policies`), `review_envelopes`, `reviews`, `releases`, `release_downloads` and their routines. The largest file. |
| `007_installations.sql` | The download ledger's writer, `installation_reports`, `installation_witnesses`, and the widened release visibility predicate. |
| `008_lifecycle.sql` | The operator surface, `access_periods` and the read cutoff, `company_quotas`, agent transfer, departure, closure, deletion, export and the account sweep. |
| `009_recovery_hold.sql` | A fourth company status, `held`, that no member path admits, for quarantining a restored tenant. |
| `010_invitation_delivery.sql` | The delivery outcome written once on each invitation row. |
| `011_invitation_standing.sql` | The handover claim (section 7) and the revocation of a removed or demoted administrator's pending invitations. |
| `012_mfa_route_bound.sql` | `mfa_route_attempts` and `mfa_route_reservations`: the verify route's own bound on wrong second-factor codes. |

Applied migrations are never edited. `scripts/check-migrations.mjs` pins each file by content, so a change is a new
numbered file that replaces a routine with `create or replace`. Several routines were redefined this way more than
once; the last definition in number order is the live one.

Writes and their owners:

- **Every write a person makes** is one `api` function, called with a 60-second `app_server` token (section 5). The
  function locks the company row first (`app.lock_company`), checks standing and roles under the lock, writes, and
  writes its audit row in the same transaction.
- **Content hashes are the database's.** Triggers compute `content_sha256`, `derived_sha256`, `envelope_sha256` and
  the assembled bytes' hash; a supplied hash is overwritten, never trusted.
- **The audit trail is append-only.** `audit_events.details` admits only ids, roles, states, timestamps and
  `reason_code` values of a fixed shape; a trigger refuses any other key or a value of the wrong shape, so free text
  cannot enter it.
- **The register is outside the database.** `lib/operator/register.mjs` keeps a hash-chained JSON Lines file on the
  operator's machine recording what happened to each company (created, extended, suspended, closed, deleted, exported).
  After a restore from backup it is the record the reconciler corrects the database from (section 9).

## 5. Tenancy and the database roles

**Row-level security.** Every company-bearing table has RLS on. Member read policies go through
`app.is_active_member(company_id)` (redefined last in `008_lifecycle.sql`), which is true only when the caller
(`auth.uid()`) holds an `active` membership in a company whose status is `active` and whose read window is still open
(`app.read_window_open`, the agreement's read cutoff, computed from the clock at statement time rather than from a
stored status). Content policies add role and authorship tests on top: another author's draft is never visible, not
even to an administrator (`app.candidate_visible_to`, `003_content.sql`).

**Row-keyed routes answer 404, not 403.** A route such as `/api/releases/:id` resolves the row first under RLS with the
caller's own token. For a foreign company's row, or a suspended company's row, that read is already empty, so the
answer is 404 and nobody can learn that a guessed id exists. Routes that name a company in the path
(`/api/companies/:companyId/...`) can tell a member of a suspended company why they are refused (409), because
`lib/services/principal.mjs` reads the caller's own standing through `api.my_standing`, which discloses only the
caller's own memberships.

**The database roles.**

| Role | Reached through | What it may do |
|---|---|---|
| `authenticated` | the member's own GoTrue token, by `lib/db/user.mjs`, `GET` only | `SELECT` on `api` views under RLS. No DML and no `EXECUTE` on any `api` function. |
| `app_server` | a 60-second token minted by `lib/db/server.mjs` from a verified session, copying its `aal` | `EXECUTE` on `api` functions and nothing else. `NOLOGIN`, no table privileges, `statement_timeout` 8 s and `lock_timeout` 5 s (`001_identity.sql`). Every write a request makes is one of these functions. |
| `service_role` | `lib/db/operator.mjs` only | GoTrue's admin API, for creating an invitee's account and for the owner-side account deletions. No privilege on schema `app`. |
| `app_maintenance` | no route and no script | `NOLOGIN`, with narrow grants (`001_identity.sql`, with additions in 003, 007 and 008). |
| the owner | the owner-side scripts, through the psql command in `ENTERPRISE_DB_PSQL` (`scripts/owner-db.mjs`) | Everything. Deletion and the `held` status sit behind session settings (`app.tenant_deletion`, `app.recovery_reconcile`) that stop an accident, not an owner who sets them. |

**The maintenance role is disclosed, not hidden.** `app_maintenance` is a trusted repair principal, not a removal-only
role. It can read standing in every tenant and update company status, membership status and roles, and invitation
revocation in both directions across all tenants, with no rule check and no audit coupling. It cannot delete anything,
read `invitations.token_hash`, rewrite membership identity or call `api` functions. No login role may be a member of it
on a production project (`scripts/check-deploy.mjs` reads this locally as D14), and
`tests/e8/stack/maintenance.test.mjs` pins the boundary. The reconciler runs as the owner,
not as `app_maintenance`, because a recovery needs writes outside that role's grants.

**The server token.** `serverToken(session)` in `lib/db/server.mjs` mints
`{ role: 'app_server', sub, aal, iss, iat, exp: iat + 60 }` from a verified session and nothing else, so a handler cannot
assemble an `aal2` principal from parts. It is signed HS256 with `SUPABASE_JWT_SECRET` (the local stack) or ES256 with
`ENTERPRISE_SERVER_SIGNING_KEY` (a hosted project, where that key is imported and rotated in as the project's current
Auth signing key). In SQL, `app.server_actor()` accepts only `role = app_server` with a uuid `sub`.

**The bound principal.** For content functions the token also carries `fn`, `args_sha256` and a fresh `jti`, binding it
to one function and one exact argument set (`callBound`, `BOUND` in `lib/db/server.mjs`; `app.bound_actor` in
`003_content.sql`). The SQL side recomputes the argument hash from the arguments it received, so a token cannot be
replayed against other arguments. Migration 002 makes every identity function refuse a token that carries `fn`.

**Tenancy tests.** `tests/db/01-privilege-boundary.sh` and `tests/db/02-tenancy.sh` probe the grants and policies
directly with psql and PostgREST. `tests/e8/stack/tenancy-sweep.test.mjs` walks every company-bearing route with
another company's ids and four caller classes, with a completeness assertion over the route table, so a new route that
is neither swept nor explicitly excluded fails the suite. `tests/e8/stack/sessions.test.mjs` presents a demoted
administrator's earlier `aal2` cookie against every route a plain member is refused.

## 6. Sessions, sign-in and second factors

**Sign-in is by emailed link only.** Public sign-up is off; only an invitation or the operator creates an account
(`enable_signup = false` in `supabase/config.toml`, and `app.hook_before_user_created` with `operator_allowlist` in
`001_identity.sql` refuse other creation paths). `POST /api/auth/start` asks GoTrue to send a sign-in link and answers
204 for every well-formed address, so the answer does not say whether the address has an account. The link lands on
`/signin/`, whose page posts the token hash to `POST /api/auth/verify`; the link is never followed as a GET, so a mail
scanner that fetches it cannot spend the single-use token.

**Cookies.** `/api/auth/verify` sets `enterprise_access` and `enterprise_refresh`, both
`Path=/; HttpOnly; Secure; SameSite=Strict` (`lib/session.mjs`). The access cookie lives as long as the access token
(one hour with the shipped configuration); the refresh cookie 30 days. The browser never sees a token in script.
`POST /api/auth/refresh` rotates the pair; `POST /api/auth/signout` revokes the session at GoTrue and clears both
cookies even when verification fails.

**Verification.** `verifySession` reads only the access cookie, never an `Authorization` header. It checks the signature
(HS256 with `SUPABASE_JWT_SECRET`, or ES256 or RS256 against the project's published key set), then `exp`, `nbf`, `aud`,
`iss`, `role` and `sub`, and reads `email`, `aal`, `amr` and `session_id`. It never calls GoTrue per request, never
refreshes on its own and never reads user or app metadata. The key set is cached for at most 600 seconds and refetched
at most once a minute on an unknown `kid`; a refetch that fails while the cache is stale refuses the token rather than
trusting a key that may have been removed.

**Membership is read per request.** A verified token says who the caller is, not what they may do. Every route that
touches a company loads the caller's current membership through RLS (`lib/services/principal.mjs`), and every `api`
function re-reads it under the company lock, so a removal or demotion takes effect at the caller's next request even
though their access token stays valid until it expires.

**Second factors.** TOTP only, through GoTrue (`lib/auth/factors.mjs`). Enrolment and verification run with the caller's
own access token and the publishable key; the service key is never used for factors. Verification is a challenge and a
verify inside one request, because GoTrue refuses a verify from another address than the challenge's. A code that is
not exactly six digits is refused before any GoTrue call. No TOTP secret, QR code, challenge id or code is logged.

**Who needs `aal2`.** Every administrator routine (`app.require_admin` calls `app.require_mfa`) and every operator
routine (`app.operator_actor()`). Members do not need a second factor. The `aal` claim travels from the verified GoTrue
token into the server token unchanged, and the SQL reads it there.

**Bounding wrong codes.** Two mechanisms exist. Migration 004 adds the function for GoTrue's MFA verification-attempt
hook, which GoTrue calls on every verify, including direct calls to GoTrue, once the hook is enabled in the project's
Auth settings; Supabase offers that hook only on some paid plans.
Migration 012 adds the product's own bound on `POST /api/auth/factors/:id/verify`: five wrong codes per account in
fifteen minutes, each attempt counted before GoTrue sees the code and settled exactly once afterwards
(`lib/services/factor-bound.mjs`, `api.mfa_verify_begin`, `api.mfa_verify_end`). The route bound does not cover a
caller who sends codes directly to GoTrue with a stolen first-factor token; only the hook does. See `SECURITY.md`.

**Known weaknesses kept by decision:** a first-factor (`aal1`) session can enrol a factor on an account that has none,
and an access token issued before a factor change or a step-up stays valid until it expires (at most one hour). Both
are listed in `SECURITY.md`.

## 7. Invitations

An administrator at `aal2` invites an address with a set of roles (`api.invite_member`). At most one invitation per
address per company is pending; a new one revokes the earlier one. Acceptance (`api.accept_invitation`) requires the
signed-in account's address to equal the invitation's, refuses an operator account (operators and members are disjoint
principals, `app.require_disjoint_principal`, `008_lifecycle.sql`), and decides expiry at the locked point.

Delivery has two modes, chosen by `ENTERPRISE_INVITATION_DELIVERY` (see `docs/environment.md`):

- **`handover`** (the default): the answer to the inviting call carries the accept link once, and the administrator
  passes it on. For a brand-new address the link also signs the person in: it carries a GoTrue sign-in token for the
  account the invitation created. Migration 011 restricts this: a signing link is handed only for an account this call
  created, and only when no other company was handed one for the same address within the token's life. For an address
  that already has an account, the link carries the invitation code only and signs nobody in; the person signs in with
  their own address first. Before 011 an administrator could obtain a sign-in link for any existing account by
  inviting its address.
- **`mail`**: the link goes to the invited address through the configured mail provider (`lib/services/mail.mjs`), and
  the answer carries no link. Delivery that fails after the row is written answers 201 with the ids and
  `delivery: "failed"` or `"unconfirmed"`, raises one content-free alert, and the recovery is a resend.

Removing an administrator, or taking the administrator role away, revokes every invitation they issued that is still
pending, in the same transaction; acceptance also refuses an invitation whose issuer no longer holds the role (011).

## 8. Content, review and release

```
 agent:      active ──(owner removed)──▶ orphaned ──(transfer)──▶ active            archived
 version:    draft ──submit──▶ submitted ──▶ approved ──(newer version published)──▶ superseded
                                   └──▶ changes_requested ──"start a new version"──▶ (a new draft)
 envelope:   open ──both roles approve──▶ approved
               └──any change request──▶ changes_requested
 release:    published ──▶ withdrawn            (a new publication is a new release row)
 company:    active ◀──▶ suspended ──▶ closed ──▶ (deleted)       held: recovery quarantine, no member path
```

**Upload and draft.** `POST /api/companies/:companyId/candidates` runs the intake gate (section 11) on the uploaded
bytes, then `api.create_draft` stores the text, its derived record and the gate identity that judged it. Only the
author can read or save a draft. Saving reruns the gate and replaces the draft.

**Submit.** `api.submit_candidate` freezes the version: the stored text is gated again under the current gate, and the
author's declared facts are recorded (source platform, confidence, permitted data, dependencies, colleagues who worked
on it, outside helpers by name). Contributors are recorded per version and inherited by successors.

**Review envelope.** A member who can see the submitted version (its author, a reviewer or an administrator) proposes a
**review envelope** (`api.create_envelope`): the exact content, its derived record, the gate identity, one target, the
installer text for that target at this gate, the active release policy and one to twenty audience groups, all fixed by
hash. Before the envelope is written the service replays the gate over the stored content
(`replayStored`, `lib/passport/packet.mjs`) and refuses if the stored text no longer passes or derives differently. The
projected size of the assembled block is checked before anything is assembled (at most 393,216 bytes).

**Reviews.** `api.record_review` records one decision per role per envelope: `it` needs `it_reviewer`, `business`
needs `business_reviewer`. A reviewer who is a recorded contributor to that version is refused. Contributors to earlier
versions of the same agent do not exclude a reviewer. An approval names its envelope; approvals on two envelopes never
combine; any change request closes the envelope. The pure twin of these rules is `lib/rules/reviews.mjs`, and a shared
corpus under `tests/e4/fixtures/` runs against both the Node and the SQL version.

**Publish.** `api.publish_release` requires an administrator at `aal2`, an envelope approved by both roles, a
publishable target, an active agent owner, the active policy and the server's current gate identity. It assembles the
install block (the stored passport with the target's installer text inserted) and stores it with every input hash. A
publication supersedes every current release of an older version of the agent, for any target, and this version's
current release for the same target.

**Download.** `POST /api/releases/:id/download` (`api.authorize_download`) admits a member of one of the audience groups
while the release is published, the agent's owner is active and the company is readable, and writes one ledger row
per authorisation. Racing a withdrawal is decided under the release row's lock.

**Withdraw.** The agent's current owner (at any `aal`) or an administrator (at `aal2`) withdraws a release. Withdrawal
stops new downloads only. The release page states that limit and shows a removal checklist; it cannot retrieve copies
or remove grants already given in a recipient's assistant.

**Installation reports.** A recipient reports `pass`, `partial`, `fail` or `removed` for a release they downloaded,
with losses and assistance. An IT reviewer, business reviewer or administrator can witness a report. Both are
statements by people; the labels never say "verified" (`REFUSED_LABEL_TOKENS`, `lib/rules/installations.mjs`).

**The boundary sentence, shown above every packet and never collapsible:** "Approval governs the distributed
configuration and its evidence. Phaeacia does not enforce read-only execution inside the recipient's assistant. Tools
the recipient enables natively may still write even when this configuration is unchanged; the recipient's native
permissions govern them." (`BOUNDARY`, `web/assets/app/passport-view.mjs`; `tests/e2/unit/web-packet-view.test.mjs`
holds the two equal.) The losses table always renders, even when no loss is declared.

## 9. The company lifecycle

**Statuses.** `active`, `suspended`, `closed` and `held` (`app.company_statuses()`, last in `009_recovery_hold.sql`;
`lib/rules/lifecycle.mjs`). The operator moves a company between `active` and `suspended`, and from `suspended` to
`closed`, which is terminal. `held` is set and lifted only by the reconciler's owner session after a restore.

**Agreement dates.** Each company has an access period (`app.access_periods`, 008). Writes stop at its end date;
reading and the administrator's export continue for a fourteen-day export window; after that every read refuses,
because the read predicate tests the date itself; deletion becomes due within the following thirty days. Time is never
stored as a status: `app.access_state` and `app.deletion_state` derive it from the clock on every call.

**Quotas.** Per company, set by the operator: members (25 by default), pending invitations (50 by default), agents,
groups, versions per agent, downloads and reports per recipient (`app.company_quotas`, `lib/rules/quotas.mjs`). Every list read is bounded and refuses past its ceiling rather than
truncating silently.

**Departure.** Removing a member keeps the membership row as `removed`, keeps every record they made, orphans the
agents they own (which makes those agents' releases undownloadable until an administrator transfers them), and revokes
their pending issued invitations. The last administrator cannot be removed. `GET .../members/:id/departure` previews
the consequences.

**Export.** An administrator at `aal2` can download one JSON document of the company's records
(`GET /api/companies/:companyId/takeout`). It withholds other authors' unsubmitted drafts and the agreement dates.
`scripts/export-company.mjs` produces the complete owner-side copy for the cases the route cannot serve.

**Deletion.** Only from `closed`, only by the operator, through `api.delete_company` reached by
`scripts/delete-company.mjs` (dry run first, then `--apply`). It deletes every row of the company in the live database
and writes a register line. It does not reach provider backups, exported copies, installed configurations or members'
own accounts. `scripts/sweep-accounts.mjs` removes only accounts that were never confirmed and carry no display name.

**Recovery.** After a database restore, companies deleted or closed since the backup come back. The design quarantines
every company as `held`, then corrects the database from the register (`scripts/reconcile.mjs`, `lib/operator/reconcile.mjs`),
replaces the signing keys so no credential from before the restore works, and lifts each company only on its
administrator's confirmation. This was rehearsed against the local stack (`tests/e7/stack/restore.test.mjs` dumps,
truncates and reloads the `app` and `auth` schemas), never against a hosted backup.

**Monitoring.** `lib/http/alerts.mjs` sends a content-free alert for internal errors, mail delivery failures and an
unavailable key set, folding repeats within fifteen minutes. `netlify/functions/checkin.mjs` runs daily and sends the
operator a periodic check-in mail with the deploy, the access switch, the delivery mode and whether the keys load,
and no tenant data. `POST /api/mail/events` accepts signed bounce and suppression events from the mail provider and
turns them into operator alerts without storing anything.

## 10. Permission matrix

Roles are per membership and a person can hold several. The operator is a separate account that can never hold a
membership. "aal2" means the caller has passed their second factor in this session. A refusal for someone outside the
company, or a removed member, is 404 for row-keyed routes and 404 or 409 for company-keyed ones.

| Operation | member | it_reviewer | business_reviewer | company_admin | operator |
|---|---|---|---|---|---|
| Upload, save and submit own drafts; start a successor version | yes | yes | yes | yes | no |
| Read another member's draft | no | no | no | no | no |
| Read submitted versions of the company | own only | yes | yes | yes | no |
| Propose a review envelope | own versions | yes | yes | yes | no |
| Record the IT review | no | yes, unless a contributor | no | no | no |
| Record the business review | no | no | yes, unless a contributor | no | no |
| Publish an approved envelope | no | no | no | aal2 | no |
| Withdraw a release | the agent's owner | the agent's owner | the agent's owner | aal2 | no |
| See the catalog and download a release | if in an audience group | same | same | same | no |
| Report an installation of a release they downloaded | yes | yes | yes | yes | no |
| Witness an installation report | no | yes | yes | yes | no |
| Invite, resend, revoke; set roles; remove members; preview a departure | no | no | no | aal2; never the last admin | no |
| Create groups and change their members | no | no | no | aal2 | no |
| Transfer an agent | the agent's owner | the agent's owner | the agent's owner | aal2 | no |
| Export the company's records | no | no | no | aal2 | owner-side script |
| Read the company's audit trail | no | yes | yes | yes | no |
| Read the company's quotas | no | no | no | aal2 | no |
| Create a company; set dates, quotas and status; close; delete; invite a successor administrator | no | no | no | no | aal2 |

The authoritative version of each cell is the `api` function's own check under the company lock; the route tests in
`tests/e4/stack/matrix.test.mjs`, `tests/e5/stack/` and `tests/e6/stack/routes.test.mjs` walk the caller classes.

## 11. The Agent Passport adapter

`vendor/passport/` is a byte-exact copy of 193 files of Agent Passport at the commit recorded in `upstream.lock.json`
(`commit`, `tree`, `archive_sha256`, and the SHA-256 of every imported file). `node scripts/import-passport.mjs --verify`
checks the tree against the lock on every check run and writes nothing; the default mode re-imports from a local
Agent Passport checkout that contains that commit. Nothing under `vendor/` is ever edited. The pinned revision is from
the private history of Agent Passport and does not exist in the public repository, so a re-import needs a new pin.

`lib/passport/` adapts it:

| Module | What it does |
|---|---|
| `gate.mjs` | The intake gate. Transport checks first (content type, size, UTF-8, byte-order mark, CRLF, control characters), then the vendored JavaScript validator with its secret scan, the derivation of the structured record, and the enterprise rules below. Returns the text, the derived record in canonical JSON, their hashes and the gate identity, or a list of problems with line numbers and never the offending text. |
| `rules.mjs` | Four format checks ported from the normative Python validator (`vendor/passport/tools/validate.py`) that the JavaScript validator lacks: access vocabulary, binding presence, input fidelity and verification state; a refusal of the public publishing routes; and a fixed-point rule that the text survives the assembler's encoding unchanged. |
| `canonical.mjs` | Canonical JSON for the derived record: sorted keys, no insignificant whitespace, and a refusal of every value JSON would silently rewrite. |
| `assemble.mjs` | An exact Node port of `vendor/passport/scripts/assemble.py`: inserts the installer core, the target's branch and the judge prompt into the passport. Golden hashes in `tests/passport/assemble.test.mjs` hold the port to the Python output. |
| `render.mjs` | Server-side HTML rendering of a passport, derived from `vendor/passport/web/lib/_render.mjs` and registered in the lock's `derived` list, so a change on either side fails verification. Everything that reaches HTML is escaped. |
| `packet.mjs` | The review packet's readings: the replay check, the declared loss rows, and the projected assembled size. |
| `gate-manifest.mjs`, `installer-manifest.mjs` | Generated files. The first lists the files the gate is built from with their hashes, and its hash is the **gate identity** every stored version records; the second lists each target's installer text. `scripts/check.sh` regenerates both and fails on any byte difference. |

`scripts/check-python.mjs` runs the vendored Python validator through a controlled launcher (`python3 -I -B`, an
absolute interpreter path) and checks that the Node ports and the Python originals agree on the shared fixtures.

The capture prompt a member pastes into their assistant to produce a passport is `capture/enterprise.md`, derived from
Agent Passport's browser capture prompt. `scripts/build-site.mjs` publishes it byte-for-byte on the capture page and
`scripts/check-capture.mjs` scans it against the pinned specification.

## 12. The web client

`web/` holds one HTML file per page and the modules under `web/assets/app/`. There is no framework and no runtime
dependency. `web/assets/app/api.mjs` is the only module that calls the network; it sends JSON, never reads a token, and
retries a refresh at most once per failure (single flight). `dom.mjs` builds every node with `createElement` and
`textContent`; with `trusted-types 'none'` the browser refuses `innerHTML` and its relatives outright. Every page has
explicit loading, empty, error and maintenance states. `scripts/build-site.mjs` copies `web/` and the vendored tokens
and fonts into `.site/`, hashes every file into a manifest and scans the output; `tests/browser/dev-shell.mjs` serves the
same build locally with `netlify.toml`'s headers applied.

## 13. Checks and tests

| What | Where | Needs |
|---|---|---|
| Format and lint (Biome), syntax, pinned dependencies, secret scan, import boundaries, web tripwire, site build, migration pins, vendor verification | `scripts/check.sh`, the `scripts/check-*.mjs` it runs | Node, npm |
| Passport adapter goldens, importer, Python parity | `tests/passport/`, `scripts/check-python.mjs` | Node, Python 3 |
| Unit tests per slice, no database | `tests/e2/unit/` to `tests/e8/unit/` | Node, Python 3 |
| Database probes: grants, RLS, routines, concurrency | `tests/db/*.sh` (psql and curl against PostgREST) | a local Supabase stack |
| Route and service tests | `tests/e2/stack/` to `tests/e8/stack/` | a local Supabase stack |
| Browser journeys, desktop and 390-pixel phone width | `tests/browser/run-journeys.mjs` | a local stack and Chrome |
| Load and measurement harnesses (not gates) | `tests/e8/load/`, `tests/e7/measure/` | a local stack |

Every stack file reseeds the database through `tests/db/00-seed.sh`, so stack files run one at a time. Many tests
include a "fail-before": a mutant of the code under test, built in a scratch directory, that the test must reject.
