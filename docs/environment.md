# The environment contract

Every environment value the application and its owner-side scripts read: what reads it, its format, the contexts it
belongs in, whether it is a secret, and its default. The application and those scripts read no value that is not in
this table; the switches only the test suites read are listed under "Values the application does not read".
`scripts/check-deploy.mjs` checks a named environment file against this contract, and
`tests/e7/unit/check-deploy.test.mjs` pins this table and the script's own value list to each other in both
directions, so a value added to one and not the other fails the unit suite.

**Contexts.** *production* is the hosted site's function environment; *previews* are Netlify deploy previews and
branch deploys, which must hold no secret; *local* is the developer's stack and the test suites; *operator's machine*
is where the owner-side scripts run, never a function. A secret never enters a log line, an alert, a page or Git.

## Values

| Name | Read by | Format | Contexts | Secret | Default |
|---|---|---|---|---|---|
| `SUPABASE_URL` | `lib/session.mjs`, `lib/db/user.mjs`, `lib/db/server.mjs`, `lib/db/operator.mjs`, `lib/auth/factors.mjs`, `scripts/sweep-accounts.mjs`, `scripts/reconcile.mjs` (through `lib/db/operator.mjs`) | the project's API origin (`https://<ref>.supabase.co`; `http://127.0.0.1:54321` locally) | production, previews, local | no | none; required |
| `SUPABASE_ANON_KEY` | `lib/session.mjs`, `lib/db/user.mjs`, `lib/db/server.mjs`, `lib/auth/factors.mjs`, `scripts/smoke.mjs` (in a header, never in a URL) | the project's publishable key | production, previews, local | no (publishable) | none; required |
| `SUPABASE_SERVICE_ROLE_KEY` | `lib/db/operator.mjs` (the one holder in `lib/`), `scripts/sweep-accounts.mjs`, `scripts/reconcile.mjs` (its factor and account deletions, C8 and C9, through `lib/db/operator.mjs`) | the project's service key (the legacy `service_role` key) | production functions only; the operator's machine for the scripts; **never a preview** | **yes** | none |
| `SUPABASE_JWT_SECRET` | `lib/session.mjs`, `lib/db/server.mjs` (HS256 server tokens when no ES256 key is configured) | the project's legacy JWT secret | local; **unset in production under `ES256`**: nothing reads it there, and setting it would make `lib/session.mjs` accept HS256 sessions signed with a secret the dashboard can display | **yes** | none; HS256 needs it |
| `ENTERPRISE_SERVER_SIGNING_ALG` | `lib/db/server.mjs` | `HS256` or `ES256` | production, local | no | `HS256` |
| `ENTERPRISE_SERVER_SIGNING_KEY` | `lib/db/server.mjs` | PKCS#8 PEM of the ES256 server key, **with its line breaks**: `createPrivateKey` refuses the same text on one line. The key is also the project's **current Auth signing key**, rotated in, because Supabase trusts no standby key | production only; **never a preview** | **yes** | none; required for `ES256` |
| `ENTERPRISE_SERVER_SIGNING_KID` | `lib/db/server.mjs` | the key id of the project's current signing key, a uuid (`supabase gen signing-key` writes it into the key) | production | no | none; required for `ES256` |
| `ENTERPRISE_ORIGIN` | `lib/services/invitations.mjs` (the accept link's origin, checked before any invitation is written), `lib/http/pipeline.mjs` (the Origin header the cross-site guard accepts, compared as text) | the site origin, equal to GoTrue's Site URL, **written exactly as a browser sends an Origin header**: scheme and host in lower case, a port only when it is not the scheme's default, and nothing after the host (`https://app.example.com`, never `https://app.example.com/`). A value outside that shape makes all four invitation routes answer 503 `E_MAIL_NOT_CONFIGURED` before any write, and makes every mutating request fail the cross-site guard | production, previews (their own origin), local | no | none; required |
| `ENTERPRISE_ACCESS_STATE` | `lib/http/pipeline.mjs` (`accessState()`, read before every route) | `open`; anything else is closed | production (set `open` deliberately), local | no | unset: **closed** (every route 503 `E_MAINTENANCE`) |
| `ENTERPRISE_INVITATION_DELIVERY` | `lib/services/invitations.mjs`, per request | `handover` or `mail` | production, local | no | unset, empty or absent: `handover` |
| `ENTERPRISE_DB_PSQL` | `scripts/owner-db.mjs`, through which `scripts/sweep-accounts.mjs`, `register.mjs`, `export-company.mjs`, `delete-company.mjs`, `reconcile.mjs` and `check-deploy.mjs --target local` reach the database as its owner | the psql command the owner-side scripts run, with its connection arguments and no password | the operator's machine, local | no, but it names a connection the owner holds | none; the scripts refuse without it |
| `ENTERPRISE_MAIL_PROVIDER` | `lib/services/mail.mjs` | a key of `PROVIDERS`: `resend` | production | no | none; required when delivery is `mail` |
| `ENTERPRISE_MAIL_API_KEY` | `lib/services/mail.mjs`, which puts it in the request's authorization header and nowhere else | printable characters, no whitespace, 8 to 512 of them; the provider's sending-only key | production only; **never a preview** | **yes** | none |
| `ENTERPRISE_MAIL_FROM` | `lib/services/mail.mjs` | `Name <address>` or a bare address, on a verified domain; a line break or a quote in the name makes the transport not ready | production | no | none |
| `ENTERPRISE_MAIL_REPLY_TO` | `lib/services/mail.mjs` | an address; malformed makes the transport not ready | production | no | absent: no reply-to |
| `ENTERPRISE_MAIL_ENDPOINT` | `lib/services/mail.mjs` | an http(s) URL on a loopback host (`127.0.0.1`, `localhost`, `[::1]`) with no credentials; anything else makes the transport **not ready**, so nothing is sent and every invitation refuses before its write | **local and tests only**: `tests/e7/mail-catcher.mjs` and the dev shell set it; `check-deploy.mjs` D2 refuses it in a hosted file | no | the provider's own endpoint |
| `ENTERPRISE_MAIL_WEBHOOK_SECRET` | `lib/services/mail-events.mjs`: `POST /api/mail/events` verifies every delivery event's signature with it before reading anything, and the check-in reports whether it is configured | `whsec_` followed by standard base64 that decodes to 24 to 64 bytes, as the provider shows it; unset or malformed makes the route answer every post 401 `E_WEBHOOK_INVALID` and raise nothing | production only; **never a preview** (`check-deploy.mjs` D5) | **yes** | none: every event refused |
| `ENTERPRISE_ALERT_SINK` | `lib/http/alerts.mjs` (read at each alert), `lib/services/checkin.mjs` (the daily check-in mails only with `mail`) and `scripts/alert-test.mjs`, which sends through the same sink | `none` (the function log only) or `mail` (one message to the recipient below through the invitations' own transport); anything else is `none` | production; a local stack and the tests set it too | no | `none` |
| `ENTERPRISE_ALERT_TO` | same | an address; with `mail` and no valid recipient the sink cannot send, the alert's log line still stands, and `check-deploy.mjs` D16 refuses that configuration at deploy time | same | no | none; required for `mail` |
| `ENTERPRISE_REGISTER_PATH` | `scripts/register.mjs`, `scripts/export-company.mjs`, `scripts/delete-company.mjs`, `scripts/reconcile.mjs`, all through `lib/operator/register.mjs` | an absolute path outside every Git work tree; its head file is `<path>.head` and its lock `<path>.lock`, beside it, both created at mode 0600 | the operator's machine | no, but access-restricted | none; every one of the scripts refuses without it |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` | `scripts/check-deploy.mjs --target hosted`, read from the runner's environment and never from an env file; D2 refuses either of them in a deployed context's file | Supabase's Management API token and the project reference | the operator's machine only | the token **yes** | none |

The five `ENTERPRISE_MAIL_*` values of the transport (every one of them but the webhook secret) are read by
`lib/services/mail.mjs`, which the four invitation function files build as `makeRoutes({ mail: mailTransport() })`.
The environment is read at each call, not at construction, so a value corrected after a function instance started is
read on its next request, and `ready()` is false while any required value is missing or malformed, which makes an
invitation refuse **before** its write. `PASSPORT_PYTHON`, `PASSPORT_SOURCE` and `PASSPORT_ARCHIVE` are build-time
values of the pinned Passport import (`scripts/import-passport.mjs`, `scripts/check-python.mjs`), not the
application's.

## Values the application does not read

- **`AWS_LAMBDA_JS_RUNTIME=nodejs24.x`** on the Netlify site, every deploy context, not a secret. It pins the
  functions' Node version. Netlify requires it to be set in its UI, CLI or API and not in `netlify.toml`. The
  stack-free suites pass on Node 24. `check-deploy.mjs` D2 polices only `ENTERPRISE_` and `SUPABASE_` names, so it
  neither requires nor refuses this one.
- **The deploy check's env file** is a copy, on the operator's machine, of one context's values, which
  `scripts/check-deploy.mjs --env` and `scripts/alert-test.mjs --env` read. Its parser reads one `KEY=VALUE` per line,
  so the one multi-line value, `ENTERPRISE_SERVER_SIGNING_KEY`, is written there with its lines joined by single
  spaces: D1 checks only that the PEM envelope is present, and the functions never read this file. It holds every
  production secret while it exists.
- **Test switches.** Only the test suites read these: `E2_DB=skip` makes `scripts/check.sh` report its stack gates
  as SKIP; `CHROME_PATH` names the Chrome binary the browser journeys launch (`tests/browser/cdp.mjs`; the default is
  the macOS application path); `CAPACITY_EVIDENCE=1` makes the capacity samples also write a copy of their record
  under `evidence/`. Further variables in individual test files are internal hooks of those files.

## Invitation delivery, in full

`ENTERPRISE_INVITATION_DELIVERY` is `handover` or `mail`, and unset, empty or absent is `handover`. In `handover` the
server returns the accept link once, in the answer to the call that made the invitation; in `mail` it calls the
configured transport and the answer carries no link at all. A value that is neither is a configuration error and throws
before any write, so a server whose operator asked for mail never silently hands a credential back instead. The
answer's `delivery` is `handover`, `mail`, `failed` or `unconfirmed`; `acceptUrl` is present only for `handover`; and
in `mail` mode a transport that is wired but not ready refuses before any write with `E_MAIL_NOT_CONFIGURED`.

`failed` means nothing went out (the provider answered and did not accept the message, the message could not be
rendered, GoTrue could not issue the link, or the request never left). `unconfirmed` means the request left and its
answer was lost (the transport's five-second timeout, a reset or a closed connection), so the provider may have
accepted it and the invitee may hold the link. Both are 201 with the ids and no link, both raise one content-free
`delivery_failed` alert, and the recovery is the same in either case: a resend, which kills whatever link did go out.

In `handover` mode, the operator who creates a company holds that company's first administrator's whole first factor
until it is used, and an administrator holds each new invitee's. A link for an address that already has an account
signs nobody in (migration 011). Move to `mail` once the transport is configured and verified, and confirm afterwards
that no invitation answer carries `acceptUrl`.

## What a hosted deployment must hold

- Previews hold no `SUPABASE_SERVICE_ROLE_KEY`, no `SUPABASE_JWT_SECRET`, no `ENTERPRISE_SERVER_SIGNING_KEY`, no
  `ENTERPRISE_MAIL_API_KEY` and no `ENTERPRISE_MAIL_WEBHOOK_SECRET`. Those five are every value this table marks secret
  in a production context, and they are exactly what `check-deploy.mjs` D5 looks for in a `deploy-preview` or
  `branch-deploy` listing.
- `ENTERPRISE_ORIGIN` equals GoTrue's Site URL; `ENTERPRISE_ACCESS_STATE=open` is set explicitly and only on the
  production site.
- `scripts/check-deploy.mjs --target hosted` checks all of these in one run. A green local run says nothing about a
  hosted project.
