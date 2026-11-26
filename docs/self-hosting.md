# Running and self-hosting

How to run Phaeacia Enterprise on your own machine, and what standing up a hosted instance involves. The code was
written for one platform pairing: **Supabase** (Postgres, GoTrue and PostgREST) for the database and authentication,
and **Netlify** (static hosting and Functions) for the pages and the server. Invitation and alert mail goes through
**Resend**, the one provider `lib/services/mail.mjs` implements. Moving to other platforms means rewriting the
adapters in `lib/http/netlify.mjs`, `lib/db/` and `lib/services/mail.mjs`.

Read `SECURITY.md` before you put anything but synthetic data into an instance. The code has never had an
independent security review, and the hosted procedure below was only partly exercised on the one internal instance
that ever ran.

Throughout, `<ref>` is your Supabase project reference, `app.example.com` stands for your own hostname, and every
value marked secret is typed by its owner into the provider's own screen or their own terminal and never pasted into
a chat, a ticket, a log or Git.

## 1. Local development

### Prerequisites

- **Node 26.8.1 exactly** (`.nvmrc`). The first gate of `scripts/check.sh` refuses any other version.
- **npm**, for the one dev dependency, Biome (`package.json`, locked in `package-lock.json`).
- **Python 3**, for the vendored Passport validator the unit tests run (`scripts/check-python.mjs`).
- **Docker and the Supabase CLI**, for the local stack. The stack uses the default local ports 54321 and 54322. On
  Linux, your user must be able to run `docker` without `sudo`.
- **Google Chrome**, for the browser journeys only. `tests/browser/cdp.mjs` uses the macOS application path unless
  `CHROME_PATH` names another binary; on Linux, for example, `export CHROME_PATH=/usr/bin/google-chrome`.
- **git, bash and curl**, and a git clone rather than a downloaded ZIP: the secret scan lists tracked files with
  `git ls-files`.
- **`xxd` and `shasum` on the host.** `tests/db/04-invitations.sh` pipes through both. macOS has them; on Debian or
  Ubuntu, `apt-get install xxd perl` (`shasum` ships with perl).
- **psql** for the hosted steps in section 2. Locally it is optional: the database probes use a host psql when there is
  one and otherwise run psql inside the database container.

**The last full run** (2026-11-24, on Linux) used Node 26.8.1, Supabase CLI 2.109.1, Docker 29.9.3, the stack images
postgres 17.6.1.143, gotrue v2.192.0 and postgrest v14.14, Python 3.13 and Chrome for Testing 158. Earlier runs were on
macOS.

**Running as root**, as in a container or on a CI runner, breaks two things. Chrome refuses to start without
`--no-sandbox`, which `tests/browser/cdp.mjs` does not pass; point `CHROME_PATH` at a wrapper script that runs
`exec /path/to/chrome --no-sandbox "$@"`. And test E7-30 in `tests/e7/stack/` makes a file read-only with
`chmod 0400`, which root ignores, so it fails. Run the suites as an ordinary user where you can.

### Install and check

```sh
npm ci --ignore-scripts
bash scripts/setup-worktree.sh      # checks the tools and the Node version; never starts or changes the stack
E2_DB=skip bash scripts/check.sh    # every gate that needs no database; the stack gates report SKIP
```

`E2_DB=skip` is the documented opt-out for a machine without Docker. The runner prints SKIP for each stack gate and
says so in its last line; a skipped gate is not a pass.

### Start the stack and the site

```sh
supabase start                      # reads supabase/config.toml and applies supabase/migrations/001 to 012
bash tests/db/00-seed.sh            # resets the database and creates two synthetic companies and seven accounts
node tests/browser/dev-shell.mjs    # builds web/ and serves it with the real route functions; prints the origin
```

`supabase status` prints the local keys; scripts here read it by exit status only. Authentication settings and hooks
are read at `supabase start`, so a change to `supabase/config.toml` needs a stop and a start, not a reset.

The dev shell builds `web/` into `.scratch/site/`, applies `netlify.toml`'s headers to the static pages, serves every
route on a loopback port against the local stack, and points the mail transport at a local catcher
(`tests/e7/mail-catcher.mjs`). `--closed` serves the maintenance state.

**Signing in locally.** Sign-in is by emailed link only, and the local GoTrue sends no mail, so typing an address into
`/signin/` sends nothing. The journeys mint a link through GoTrue's admin API instead. To do the same by hand, run this
from the repository root while the shell runs; it prints a single-use sign-in link for a seeded synthetic account:

```sh
node --input-type=module -e "
import { stackEnv } from './tests/e2/helpers/stack.mjs';
import { generateLink } from './lib/db/operator.mjs';
stackEnv();
const [email, origin] = process.argv.slice(1);
const r = await generateLink({ email, type: 'magiclink' });
if (!r.ok) { console.error('no link, status', r.status); process.exit(1); }
console.log(origin + '/signin/#token_hash=' + r.hashedToken + '&type=magiclink');
" synthetic-alpha-admin1@example.invalid http://127.0.0.1:<port>
```

The seeded accounts, all at `example.invalid` (`tests/db/00-seed.sh`): `synthetic-op` (the operator, pages under
`/operator/`); `synthetic-alpha-admin1` and `synthetic-alpha-admin2` (administrators of SYNTHETIC Alpha AG);
`synthetic-alpha-member`; `synthetic-alpha-removed` (a removed member); `synthetic-beta-member` (the first
administrator of SYNTHETIC Beta GmbH); and `synthetic-outsider` (no membership). Administrator and operator pages ask
for a second factor: enrol one at `/mfa/` with any TOTP authenticator app (SHA-1, 30 seconds, six digits).

### The full suite and the journeys

```sh
bash scripts/check.sh                                   # every gate, the stack ones included; reseeds per stack file
node tests/browser/run-journeys.mjs --label first-run   # reseeds, starts the dev shell and headless Chrome
node tests/browser/run-journeys.mjs --label j5 --only J5,J6
```

Nothing else may use the stack while either runs. `scripts/check.sh` writes `.scratch/check/summary.txt` and exits 2
on any failure. The journeys write their results and captures under `.scratch/browser/<label>/`. Three checks of J11
depend on a refresh-token setting no local stack reproduces and were recorded as failing locally on every run.

**Known intermittent failures.** Rerun these on their own before you suspect the code:

- The Python launcher gate: the vendored `parity.mjs` ReDoS check takes one timing sample against a 3.0 ratio and
  can fail, on a different rule each time. A benchmark of the flagged rules is linear.
- The E4 route tests: `capacity.test.mjs` has once answered 500 with `PGRST303` (JWT claims rejected) on one request;
  the cause was not found.
- The browser journeys: a full run once stopped making progress after E7-28. Resume with `--only` and the
  journeys that had not run.

## 2. Standing up a hosted instance

This is the order the internal instance was built in, generalised. It needs a Supabase project, a Netlify site, a
domain you control and a Resend account with a verified sending domain. Steps 1 to 6 were run once on a hosted
project; steps 7 to 12 were written but not all were run. `scripts/check-deploy.mjs --target hosted` and the
restore procedure in section 3 have never run against a hosted project; expect to correct field names on the first run.

### Step 1. The operator's machine

Pick the machine the owner-side scripts run on. It holds the owner connection, the service key, the register and a
copy of the production values. Use an encrypted disk and a private folder outside every Git work tree (the scripts
refuse an env file or a register path inside one). Install Node 26.8.1, the Supabase CLI, psql and the Netlify CLI.

### Step 2. The Supabase project

1. Create a project in the region you need. Keep the database owner password in a password manager.
2. **The owner connection.** Put the password in `~/.pgpass` (mode 0600), then export a psql command that holds none of it, as below.

   ```sh
   export ENTERPRISE_DB_PSQL='psql "host=<host> port=5432 user=<user> dbname=postgres sslmode=require" -X -At'
   echo 'select current_user;' | bash -c "$ENTERPRISE_DB_PSQL"     # prints the owner
   ```

   Use the direct connection or the session pooler (port 5432). Never the transaction pooler: the owner-side scripts
   assume an ordinary session.
3. **The migrations.** Link a dedicated directory, never your working checkout, because `supabase link` writes the
   reference into `supabase/.temp/` and any later `db push` from there targets production:

   ```sh
   mkdir -p ../deploy && git archive HEAD supabase | tar -x -C ../deploy
   supabase link --project-ref <ref> --workdir ../deploy
   supabase db push --workdir ../deploy --dry-run     # must list 001 to 012 and nothing else
   supabase db push --workdir ../deploy
   echo "notify pgrst, 'reload schema';" | bash -c "$ENTERPRISE_DB_PSQL"
   ```

   Never pass `--include-seed`: `supabase/config.toml` names a seed for local resets only. There are no down
   migrations; on an empty project the undo is deleting the project.
4. **The Data API.** Exposed schemas: `api` and nothing else. New tables not exposed automatically. Maximum rows 200.

### Step 3. The server's signing key

The server signs a 60-second token for every database call (`lib/db/server.mjs`). On a hosted project it signs ES256
with a key that must also be the project's **current** Auth signing key, because Supabase trusts only current and
previously used keys, not standby ones. `scripts/check-deploy.mjs` refuses anything but ES256 for a hosted target.

1. Note what the project holds: its current signing key, whether a legacy JWT secret is listed, and whether the legacy
   `anon` and `service_role` API keys exist. The invitation path, the account sweep and the reconciler use the legacy
   `service_role` key (`SUPABASE_SERVICE_ROLE_KEY` in `docs/environment.md`; `SECURITY.md` item 8). A project that has
   no legacy keys cannot run them until `lib/db/operator.mjs` is changed to send a new-style secret key in the
   `apikey` header only.
2. In the private folder: `umask 077; supabase gen signing-key --algorithm ES256 > server-key.jwk`. The file is a
   secret; its `kid` is not.
3. On the project's JWT signing keys page, import `server-key.jwk` as a standby key, then **rotate** so it becomes
   current, then revoke the project's previous key once nothing holds a token it signed.
4. Convert it to the PKCS#8 PEM the server reads, file to file, printing nothing:

   ```sh
   umask 077; node -e 'const fs=require("node:fs"),c=require("node:crypto");fs.writeFileSync(process.argv[2],c.createPrivateKey({key:JSON.parse(fs.readFileSync(process.argv[1],"utf8")),format:"jwk"}).export({type:"pkcs8",format:"pem"}),{flag:"wx",mode:0o600})' server-key.jwk server-key.pem
   ```

   Delete both files once the value is stored in Netlify (step 6). Afterwards the only copies are Netlify's write-only
   store and Supabase's.

Leave `SUPABASE_JWT_SECRET` unset in production: set, it would make `lib/session.mjs` accept HS256 sessions signed with
a secret the dashboard can display.

### Step 4. The Auth settings

| Field | Value | Where the repository says so |
|---|---|---|
| Allow new users to sign up | off | `supabase/config.toml` `enable_signup = false` |
| Confirm email | on | `[auth.email] enable_confirmations = true` |
| Site URL | your origin, exactly as `ENTERPRISE_ORIGIN`, no trailing slash | `docs/environment.md` |
| Redirect URLs | empty; nothing in the product passes `redirect_to` | `lib/services/invitations.mjs`, `lib/session.mjs` |
| Access token expiry | 3600 seconds | `jwt_expiry = 3600` |
| Refresh token rotation, and its reuse interval | on, and 0 | `enable_refresh_token_rotation = true`, `refresh_token_reuse_interval = 0` |
| Email OTP expiry | 3600 seconds | `[auth.email] otp_expiry = 3600`; migration 011's handover window is derived from it |
| Multi-factor: TOTP enrolment and verification | both on | `[auth.mfa.totp]` |
| Hook: Before User Created | on, Postgres function `app.hook_before_user_created` | `[auth.hook.before_user_created]` |
| Hook: MFA Verification Attempt | on, Postgres function `app.hook_mfa_verification_attempt`, if your plan offers it | `[auth.hook.mfa_verification_attempt]` |

The MFA verification-attempt hook is what bounds wrong second-factor codes sent straight to GoTrue. On a plan without
it, only the product's own route bound applies (migration 012), and `scripts/check-deploy.mjs` keeps refusing check
D11. See `SECURITY.md`.

**GoTrue's own mail.** GoTrue sends the returning member's sign-in link itself. Configure custom SMTP (for Resend:
host `smtp.resend.com`, port 465, user `resend`, the password a Resend key with sending access), a sender on your
verified domain, and install `supabase/templates/sign-in.html` byte for byte as both the magic-link and the recovery
template, through the Management API rather than the dashboard editor, so that the deploy check's hash comparison
(D13) matches:

```sh
node -e 'const fs=require("node:fs");const t=fs.readFileSync("supabase/templates/sign-in.html","utf8");const s="Your sign-in link";process.stdout.write(JSON.stringify({mailer_subjects_magic_link:s,mailer_templates_magic_link_content:t,mailer_subjects_recovery:s,mailer_templates_recovery_content:t.replaceAll("type=magiclink","type=recovery")}))' > templates.json
read -rs SUPABASE_ACCESS_TOKEN
curl -sS -X PATCH "https://api.supabase.com/v1/projects/<ref>/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H 'content-type: application/json' \
  --data-binary @templates.json -o /dev/null -w '%{http_code}\n'
unset SUPABASE_ACCESS_TOKEN
```

The recovery template is the same file with the link's type changed to `recovery`; the server accepts both types
(`lib/session.mjs`). Do not edit either template in the dashboard afterwards: one changed byte fails D13.

**The owner-side reads.** Over the owner connection, confirm `show default_transaction_isolation;` is `read committed`,
that `app_server` carries its 8 s statement timeout, and that no login role is a member of `app_maintenance`.

### Step 5. The Netlify site and the domain

1. Create the site without connecting a repository, then `netlify login` and `netlify link` from a clean checkout of
   the revision you deploy. With no repository connected there are no deploy previews or branch deploys, which is what
   you want: previews must never hold a secret.
2. Build settings come from `netlify.toml`: publish `.site`, command `node scripts/build-site.mjs --clean --out .site`,
   functions `netlify/functions`, bundler esbuild. The build's Node version comes from `.nvmrc`.
3. Set the functions' runtime with `netlify env:set AWS_LAMBDA_JS_RUNTIME nodejs24.x` (Netlify requires this variable
   to be set outside `netlify.toml`). The stack-free suites pass on Node 24.
4. Pick the functions' region close to the database if your plan allows it.
5. Add your hostname and the DNS record Netlify shows; wait for the certificate.
6. In Resend, verify a sending domain and create a key with **sending access only**, restricted to that domain.

### Step 6. The environment values

`docs/environment.md` is the contract: every value the application reads, its format and the contexts it belongs in.
Set each in Netlify's environment for the **production** context only, marking secrets as secret. Set the multi-line
signing key from its file so its line breaks survive:

```sh
netlify env:set ENTERPRISE_SERVER_SIGNING_KEY "$(cat server-key.pem)" --context production --scope functions --secret
```

Start with `ENTERPRISE_ACCESS_STATE=closed` and `ENTERPRISE_INVITATION_DELIVERY=handover`.

Write the same production values, one `KEY=VALUE` per line, into `production.env` in the private folder (mode 0600),
with the PEM's lines joined by single spaces. `scripts/check-deploy.mjs` and `scripts/alert-test.mjs` read that file;
the functions never do. While it exists it holds every production secret, so keep it only as long as you run checks
from it.

Never set on Netlify: `ENTERPRISE_MAIL_ENDPOINT` (tests only), `ENTERPRISE_DB_PSQL`, `ENTERPRISE_REGISTER_PATH`,
`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`.

### Step 7. Deploy closed, then check

```sh
npm ci --ignore-scripts
node scripts/build-site.mjs --clean --out .site
netlify deploy --prod
```

Every environment change needs a new deploy to take effect. Never deploy without `--prod`: the CLI's default is a
draft deploy at its own URL, which is a preview.

Then, with the site closed:

```sh
export SUPABASE_ANON_KEY=<the publishable key>
node scripts/smoke.mjs --origin https://app.example.com --supabase https://<ref>.supabase.co --expect-switch closed
export SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=<ref>      # typed by the owner; a secret
node scripts/check-deploy.mjs --target hosted --env production.env --origin https://app.example.com \
    --netlify-names netlify-names.json --expect-switch closed
unset SUPABASE_ACCESS_TOKEN
```

`smoke.mjs` makes read-only requests that prove the headers, the pages and the order in which a request is refused.
`check-deploy.mjs` reads the configuration back from the providers and compares it with what the product needs
(sixteen facts, D1 to D16). `netlify-names.json` holds the variable **names** per context (`production`,
`deploy-preview`, `branch-deploy`, each a list, empty where a context holds nothing); the script keeps names only. An
`UNREAD` line is not a pass. The Management API field names the hosted check reads come from a synthetic fixture
(`tests/e7/fixtures/management-api.json`) and have never been confirmed against a real project.

### Step 8. Open the site and create the first operator

Set `ENTERPRISE_ACCESS_STATE=open`, redeploy, and run both checks again with `--expect-switch open`.

The first operator is created by hand, because every operator routine requires an existing operator at `aal2`. The
operator account must never hold a company membership.

1. Over the owner connection (`bash -c "$ENTERPRISE_DB_PSQL"`, interactive):

   ```sql
   \set ON_ERROR_STOP on
   \set op_email '<the operator address>'
   select lower(btrim(:'op_email')) as op_email_n \gset
   insert into app.operator_allowlist (email_normalized) values (:'op_email_n');
   ```

2. The account, confirmed and without a password, through GoTrue's admin API, with the service key typed at a silent
   prompt:

   ```sh
   read -rs SVC; read -r OP_EMAIL
   curl -sS -X POST "https://<ref>.supabase.co/auth/v1/admin/users" \
     -H "apikey: $SVC" -H "Authorization: Bearer $SVC" -H 'content-type: application/json' \
     --data "$(node -e 'process.stdout.write(JSON.stringify({ email: process.argv[1], email_confirm: true }))' "$OP_EMAIL")" \
     | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const j=JSON.parse(s);console.log(j.id??`refused: ${j.error_code??j.code??"unknown"}`)})'
   unset SVC
   ```

   With a new-style secret key (`sb_secret_...`) send the `apikey` header alone.
3. The operator row and its audit row, back in psql:

   ```sql
   select u.id as op_id from auth.users u
    where lower(btrim(u.email)) = :'op_email_n' and u.email_confirmed_at is not null \gset
   select app.require_disjoint_principal(:'op_id', 'operator');
   begin;
   insert into app.operators (user_id) values (:'op_id');
   select app.audit(null, :'op_id', 'operator', 'operator.add', 'operator', :'op_id',
     jsonb_build_object('user_id', :'op_id', 'operator_user_id', :'op_id'));
   commit;
   \echo :op_id
   ```

   Keep the printed uuid: it is the `--operator` value of every owner-side script.
4. In the browser, request a sign-in link at `https://app.example.com/signin/`, open the mail, enrol a TOTP factor at
   `/mfa/` and verify it. `/operator/` then loads its (empty) list of companies; that load is the proof that the
   signing key, the Data API and the operator row work together.

### Step 9. The register

The register is the operator's record of what happened to each company, kept outside the database so that a restored
backup cannot rewrite it (`lib/operator/register.mjs`). Each line is hash-chained; the **anchored head** is the
`seq:sha256` you record somewhere the operator's machine cannot rewrite, which is the only defence against a register
replaced from scratch.

```sh
export ENTERPRISE_REGISTER_PATH=/absolute/path/outside/any/git/tree/register.jsonl
node scripts/register.mjs init
node scripts/register.mjs sync --operator <operator uuid>
node scripts/register.mjs anchor --copy <a copy kept elsewhere>
```

Write the printed head down outside the machine. Every later check runs `sync`, then
`anchor --anchored-head <the last recorded head> --copy <the copy>`, which verifies the chain, the local head, the
anchored head and the copy before it prints a new head.

### Step 10. Walk it through with synthetic companies

Before any real data: create two synthetic companies on `/operator/new/`, accept the first administrator invitations in
separate browser profiles, invite a creator, two reviewers, a recipient and an excluded member, take one agent through
upload, submission and review, and confirm that every attempt from one company on the other's ids answers 404 or 403
and never data. The automated journeys cannot do this: they reseed and drive the local stack only.

Remove the synthetic companies afterwards (section 3, deletion) and confirm the counts are zero over the owner
connection.

### Step 11. Mail mode

`handover` hands the accept link to the inviting administrator, who is then holding a new invitee's first factor until
it is used. `mail` sends it to the invitee instead. To switch, set `ENTERPRISE_INVITATION_DELIVERY=mail`, redeploy,
rerun the deploy check (in `mail` mode it also confirms the provider refuses an unauthenticated call), and confirm that
no invitation answer carries `acceptUrl`. Publish SPF, DKIM and DMARC records for the sending domain first.

### Step 12. Alerts, the check-in and backups

- `node scripts/alert-test.mjs --env production.env` sends one test alert through the same sink the functions use. To
  exercise the function path, add a synthetic address to the provider's suppression list, invite it, and expect
  `delivery: "failed"` and exactly one `delivery_failed` alert; then remove the suppression. Do not revoke the mail key
  to provoke a failure: the alert travels through the same key and cannot arrive.
- To receive bounce and suppression events, register a webhook at `https://app.example.com/api/mail/events` for
  `email.bounced`, `email.suppressed` and `email.failed`, and set `ENTERPRISE_MAIL_WEBHOOK_SECRET` from its signing
  secret.
- Read your project's backup schedule and retention, and decide whether you will rehearse a restore (section 3) before
  real data arrives.

## 3. Operating an instance

All owner-side scripts read `ENTERPRISE_DB_PSQL` and, where they touch the register, `ENTERPRISE_REGISTER_PATH`.
`sweep-accounts.mjs` and `reconcile.mjs` also need `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` exported. Each
prints its usage when run without arguments. **Whoever holds the owner connection can act as any operator**: the
scripts set the request's claims for their own transaction to reach the same `api` routines a route would, and the
audit row names whatever `--operator` you pass. The control on the owner connection is its custody.

| Task | How |
|---|---|
| Weekly check | Run the expiry sweep on `/operator/`, read companies whose deletion is due, `node scripts/sweep-accounts.mjs` (dry run) then `--apply --operator <uuid>`, read the function log for `internal`, `delivery_failed` and `alert_dropped` lines, then `register.mjs sync` and `anchor`. |
| Onboard a company | `/operator/new/`: slug, name, the first administrator's address, the agreement dates. Then `register.mjs sync` and `anchor`. |
| Delete a company | Suspend, then close it with its typed slug on `/operator/`; then `node scripts/delete-company.mjs --company <uuid> --slug <slug> --reason <code> --operator <uuid>` as a dry run, read it, and repeat with `--apply`. Deletion is irreversible and writes a register line. |
| Export on a customer's instruction | `node scripts/export-company.mjs --company <uuid> --operator <uuid> --instruction <ref> --out <path>`; send the file through a channel the customer names and its SHA-256 separately. |
| Verify a stored attestation | `node scripts/verify-attestation.mjs --row exported-row.json [--release exported-release.json]` |
| Rotate the server's signing key | Generate a new ES256 key and import it as standby; wait twenty minutes for key-set caches; rotate; set the new PEM and `kid` on Netlify and redeploy; wait an hour and fifteen minutes from the rotation (the access-token lifetime) and revoke the old key; then `register.mjs append --act key.replace --kid-before <old> --kid-after <new> --operator <uuid>` and `anchor`. Setting the new key on Netlify before the rotation breaks every server call, because a standby key is not trusted. |

### A lost second factor

A person whose authenticator is gone cannot fix it themselves: GoTrue refuses a new enrolment while a verified factor
exists and refuses removal of that factor at `aal1`. The operator resets it, only after identifying the person on a live
call (never by a mail from the account's own address), and only when the person can enrol a new factor during that
call:

1. Find the account: `select id from auth.users where email = '<address>';`
2. List its factors: `GET /auth/v1/admin/users/<user_id>/factors` with the service key.
3. Delete the verified TOTP factor: `DELETE /auth/v1/admin/users/<user_id>/factors/<factor_id>`, and record it in the
   register, or a restore from an older backup brings it back:
   `node scripts/register.mjs append --act factor.delete --user-id <user_id> --factor-id <factor_id> --ref <ref> --operator <uuid>`
   then `anchor`.
4. End the account's sessions: `delete from auth.sessions where user_id = '<user_id>';` (deleting a factor revokes
   nothing). An access token already issued stays valid at the product's routes until it expires.
5. The person signs in with a link, enrols and verifies a new authenticator at `/account/`, still on the call.

### Restoring from a backup

A restore brings back everything the backup held and nothing that happened afterwards: deleted companies return,
removed members return active, reset factors return working, and no session, refresh token or link token is revoked.
The recovery design undoes that in nine steps, built and rehearsed only against the local stack
(`tests/e7/stack/restore.test.mjs`):

1. If the damaged database is readable, `register.mjs sync` and `anchor`. Then close: `ENTERPRISE_ACCESS_STATE=closed`,
   no exposed schema on the recovery target, Auth email off.
2. Restore the backup into the target.
3. `node scripts/reconcile.mjs begin --operator <uuid> --closed-target --backup-at <ISO time> --apply`: moves the audit
   sequence past the register's highest id, clears every restored redeemable credential, and puts every company that
   is not closed into the `held` status.
4. `node scripts/register.mjs verify --anchored-head <head> --copy <copy>`; if the chain or the head does not verify,
   stop and use `register.mjs gap` only as the script describes.
5. `node scripts/reconcile.mjs plan`, then `apply`, with `--operator <uuid> --closed-target --anchored-head <head>`: re-applies every
   deletion, closure, removal, withdrawal and factor deletion the register records since the backup.
6. Replace the signing key as in hosted step 3, revoke every other key, record `register.mjs append --act key.replace`,
   and confirm with `check-deploy.mjs --target hosted ... --retired-kid <kid>`.
7. Reopen the Data API.
8. For each company, confirm its members and administrators with an administrator on a call, then
   `node scripts/reconcile.mjs lift --operator <uuid> --company <uuid> --confirmation <ref> --anchored-head <head> --apply`.
9. `node scripts/reconcile.mjs end --operator <uuid>`, reopen the site, and run the smoke sequence.

The legacy JWT secret cannot be rotated, only migrated away from, which is why the barrier in step 6 exists only on
the ES256 signing-key system.

## What the alert channel receives

An alert carries exactly the keys `lib/http/alerts.mjs`'s allowlist admits, each either its own value or the word
`invalid`, plus three the module adds. With `ENTERPRISE_ALERT_SINK=mail` it is one message to `ENTERPRISE_ALERT_TO`
through the invitation transport; with `none` it is a line on the function log only.

| Key | What it is | Shape |
|---|---|---|
| `event` | `internal`, `session_unavailable`, `delivery_failed`, `mail_not_configured`, `escaped`, `delivery_undeliverable`, `signin_limited` | a fixed word |
| `route` | the route's name from `makeRoutes()`'s table | `^[a-z][A-Za-z]{1,63}$` |
| `code` | a key of `CODES` in `lib/errors.mjs`, or a system code | a fixed vocabulary |
| `status` | the HTTP status answered | an integer 400 to 599 |
| `companyId` | the route's `:companyId`, after the pipeline's uuid check | a lowercase uuid |
| `requestId` | Netlify's `x-nf-request-id` header | `^[A-Za-z0-9-]{1,64}$` |
| `errorName` | the thrown value's class, from a fixed list | a fixed vocabulary, else `Error` |
| `cause` | why an accepted invitation could not be delivered | `recipient_permanent`, `recipient_temporary`, `suppressed`, `undetermined`, `contact_address` |
| `routedTo` | who was told | a fixed vocabulary |
| `dbCode` | on an `internal` alert for a database answer, its SQLSTATE or PostgREST code | `^(?:[0-9A-Z]{5}\|PGRST[0-9]{3})$` |
| `v` | the record's version | `1` |
| `at` | when the alert was built | an ISO timestamp |
| `count` | the occurrences folded into this alert by the fifteen-minute window | an integer |

**What it therefore cannot carry**, by construction: an error's message or stack, PostgREST's `details`, `hint` and
`message`, a request body, a query string, any header but the request id, a user id, an address, a name, a token and a
cookie. When the mail provider is the thing that is down, an alert cannot be delivered through it; the function log
still holds the line, which is why the weekly check reads it.

## Where data goes

| Service | What reaches it | What it keeps |
|---|---|---|
| Supabase Postgres | everything: tenant content, addresses, audit rows, the download ledger | the live database, provider backups for their retention period (deleted companies included until they age out), and the database log, which can hold a failing row's content |
| GoTrue (Supabase Auth) | addresses, sessions, factors, sign-in links | `auth.*` rows and Auth logs |
| PostgREST | each request's path and query (ids; no bodies are logged by this product) | gateway logs |
| Netlify Functions | request bodies transiently, passport uploads included | function logs: content-free lines and alert records |
| Resend | recipient addresses, company display names, role words, accept links (a live first factor until used) and tags carrying company and invitation ids | sent messages and their bodies for its retention period |
| The operator's machine | the register, export files until the customer confirms receipt, `production.env` while kept | whatever the operator keeps |
| The recipients' own assistants | installed configurations | outside this system entirely |
