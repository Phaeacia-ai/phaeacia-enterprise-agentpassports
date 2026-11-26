# The E8 load run at the capacity envelope

The harness for the capacity target the project set itself before any company's data would enter
an instance (its "item 6"):

> Initial capacity envelope: ten companies, 25 users/company, 20 concurrent active sessions;
> 50 agents/company, ten retained versions/agent, 256 KiB/version. Test catalog/review APIs under
> that envelope with p95 under two seconds excluding external login/assistant time and no
> authorization failures. Reject excess gracefully; observe usage before raising limits.

**These are measurement scripts, not gates.** `scripts/check.sh` runs nothing in this directory,
and nothing here asserts the two-second target. The pattern is `tests/e7/measure/`: the seed is
committed, the data is not, and each record carries the label that produced it, the exact command
and the machine's load average. The records are written under `evidence/`, which `.gitignore`
excludes.

One thing here *does* fail, and it is the clause of item 6 that is not a number: an entitled
caller refused, an unentitled caller admitted, or a non-2xx the run cannot explain. Those are
authorization and correctness results, not capacity targets, and `mix.mjs` exits non-zero on them.

## The three scripts, and the order

```
bash tests/db/00-seed.sh                                            # a clean stack (seed.mjs does this itself)
node tests/e8/load/seed.mjs  --label <label>                        # the envelope's world, ~10 min, ~2 GB
node tests/e8/load/mix.mjs   --label <label> --rounds 10            # the timed mixed run
node tests/e8/load/plans.mjs --label <label>                        # the five hottest reads' plans
node tests/e8/load/mix.mjs   --label <label> --phase excess         # the excess sweep, which MUTATES
bash tests/db/00-seed.sh                                            # the envelope's world is large: reseed after
```

**The order matters.** `plans.mjs` reads the world the timed mix left, which is the world the p95
was measured over. The excess sweep comes last because it drives seven quota ceilings, fills one
release's ledger past 10,000 rows and creates a company of its own; a plan read after it would not
be a plan of the measured world.

`--label` decides every generated identity (the accounts, the company slugs, the agent and group
names) and the twelve-character marker that makes each candidate's body distinct, so the same label
on the same seed rebuilds the same world. It does **not** decide the 262,144-byte body itself, which
is the committed SYNTHETIC passport padded to the content bound by
`tests/e3/stack/helpers.mjs largePassport()`. That is deliberate: **the content is prose and not
hexadecimal** (an earlier fixture padded with md5 hex had nothing to escape, which made an escaping
measurement worth nothing), and a label that decided all 262,144 bytes would have to
generate them.

## What each script does

| Script | What it writes | What it measures |
|---|---|---|
| `seed.mjs` | `.scratch/e8/load/world-<label>.json` (not committed) | nothing; it builds the envelope's world owner-side and records its own duration and figures |
| `mix.mjs` (default phase) | `evidence/e8-load-repro/mix-<label>.json` and `mix-<label>-requests.tsv` | the mixed run: p50, p95, p99 and count per request class for the entitled half; the unentitled half's count, p95 and refusal-code distribution; the authorization-failure count in both directions |
| `plans.mjs` | `evidence/e8-load-repro/plans-<label>.json` and `.txt` | the five hottest reads with `explain (analyze, buffers)`, their buffer counts, the indexes each used and any sequential scan on a table above 10,000 rows |
| `mix.mjs --phase excess` | `evidence/e8-load-repro/excess-<label>.json` | the seven quota ceilings, `E_READ_OVER_BOUND` and the two body bounds, each driven past and each required to answer its own code |

The per-request log (`mix-<label>-requests.tsv`) carries the session's role label, the company's
index, the request class, the caller shape, the status, the code and the timings. **No address, no
display name and no content**, which is why the session column is `c3-reviewer` and not an email.

## The mix, and why it has two halves

The entitled half is this table of shares: `GET catalog` 30 per cent, `GET review-queue` 20,
`GET /api/releases/{id}` 20, `POST /api/releases/{id}/download` 20 and `GET members` 10, over twenty
sessions, two per company across ten companies, **every session established before the first timed
call**, so the p95 excludes login by construction.

The unentitled half was added after review, and it is the part that carries item 6's
no-authorization-failures clause. Without it the run's authorization test is "a 401, a 403 or a 404
where the caller was entitled", which detects a false **refusal** and can never detect a false
**admission**. It is interleaved at ten per cent of the requests issued, with four refusable caller
shapes, and it is **excluded from the headline p95 and reported beside it**, because a tenancy
refusal is a short path and folding it in would flatter the envelope.

**The shares are met by two per-session cycles and not by one both sessions draw from.** The
envelope gives one company two identities and the table asks five caller shapes of them, and two of those
shapes conflict: the members list's caller is "an admin at aal2", while the release read's is "a
recipient", and an admin's release read takes the ledger branch
(`lib/services/releases.mjs:225-227`) and would measure a different read. So the admin identity
carries the members list and no release read, the reviewer identity carries the release read and no
members list, and the union over the two is exactly the table of shares.

## The stack

Every script here uses the local Supabase stack, reseeds only through `bash tests/db/00-seed.sh`,
and never calls `supabase stop`, `start` or `db reset`. **Nothing else may run on the stack while a
run is timed**, and a run taken under a load average above 10 is repeated rather than reported.
`seed.mjs` leaves roughly two gigabytes of synthetic companies behind, so the stack is reseeded
after the sweep.

## The limits, written where they cannot be missed

- **Not hosted latency.** One machine runs the database, PostgREST, GoTrue, all twenty sessions and
  this harness. Local numbers say nothing about a hosted project's latency, and nothing here
  observes the network, the function cold starts or a hosted database's plan limits.
- **The world is owner-side.** The candidate identity trigger is enabled for all 5,000 candidate
  rows and the envelope and release identity triggers are enabled for every envelope and release,
  so each row is one the product's own rules accepted and every release's assembled bytes are the
  product's own assembly. What is **not** established is that the product's ROUTES would have
  produced this world one call at a time; the route suites under `tests/e3/` to `tests/e6/` prove
  that, one call at a time.
- **The derived record is the template's.** Each candidate body differs from the template by its
  twelve-character marker, and all of them carry the template's derived record, restamped at insert.
  The trigger compares the two nowhere (`003:225-270` reads the derived record's shape and its clock
  and nothing else) and no read in the mix replays it; `replayStored()` is on the review path, which
  is not one of the five classes. `tests/e4/stack/capacity.test.mjs` makes the same trade.
- **The largest assembly is 332,817 bytes and not 393,216.** 393,216 is `ASSEMBLED_BYTES_MAX`
  (`lib/passport/packet.mjs:32`) and `app.limit_assembled_bytes()`, a fail-closed ceiling. The
  largest assembly the product can actually make is the content bound plus the largest registered
  installer text, 262,144 − 55 + 70,728 (`claude-code`). The download class is measured at that.
