# Content the scrubber must leave alone

Every line below is ordinary content a stranger would write, and every one of them
was destroyed or refused by CREDENTIAL_ASSIGN as it shipped on 2026-08-17. This file
is the corpus that was missing: the repository had 27 fixtures asserting that
planted secrets are caught and not one asserting that innocent content survives, so
a rule with a 1.77% false-positive rate on stranger documents passed every test.

`run_tests.sh` asserts that scrubbing this file changes nothing and reports nothing.
Do not add a real credential here. Anything that belongs in this file is something
the scrubber must not touch.

Sources: measured against 6055 stranger-written markdown files, plus the five prose
cases the orchestrator reproduced against `examples/daily-brief-passport.md`. See
`record/findings/the-context-rule-fires-on-code-not-only-on-credentials.md`.

## The credential word inside an ordinary word

The monkey = the-quick-brown-fox-jumped over the lazy dog today.
MONKEY = the-quick-brown-fox-jumped
The turkey: the-quick-brown-fox-jumped again this morning.
Set hotkey=cmd+shift+option+control+space to summon it.
keyword: geopolitical-forecasting-daily
donkey = the-quick-brown-fox-jumped
whiskey: the-quick-brown-fox-jumped

## Code in a golden example, which is what section 4 is made of

```js
const keypair = ed25519.generateKeyPairSync('ed25519')
const key = forge.random.getBytesSync(32)
node.manualKeyframeTracks = track.manualKeyframeTracks
const tracks = opacityTrack.keyframes.map(k => k.time)
const showIconKey = component.addComponentProperty('show', 'BOOLEAN')
myProjectRequestWithAuth = myProjectRequest.defaults({})
```

```yaml
token: process.env.AXIOM_TOKEN
api_key: config.credentials.apiKey
```

## Names, paths and identifiers that are not credentials

authors: Raffael.Hueberli.and.K.Patel
cache_key: "articles/2026-08-17/brief.json"
GOOGLE_APPLICATION_CREDENTIALS="secrets/production/key.json"
key: F3EF5F62A87FC27A22E643F714CE4FF5015AA242

## Database and caching vocabulary ending in "key" (ROW-100)

`cache_key` above is excluded by its VALUE being a path, which proves nothing
about the five lines below: none of their values are paths, and the earlier
CREDENTIAL_ASSIGN fix (the section above) left the bare `[_\-.]key` branch
open to any name ending in `_key`, `-key` or `.key`, regardless of value
shape. These five are ordinary database and caching field names, still
refused until ROW-100's name-list exclusion. `SECRET_KEY` and `DEPLOY_KEY` two
sections down carry the identical value shape and must still fire: the fix is
on the NAME, not the value, precisely so those two are not swept up with them.

`primary`/`primary_key`/`primary.key` is deliberately NOT in this list. It was
in the first version of this fix and a critic found it removes a real
credential: `azurerm_cosmosdb_account.primary_key` and
`azurerm_storage_account.primary_access_key` are Azure's own documented
Terraform/SDK names for a live master access key. `primary_key = <a real
Azure key>` must still fire and is tested as a must-fire case in
`web/tools/parity.mjs`, not here — this file is false positives only.

cache_key: user-profile-lookup-by-identifier
sort_key = created_at_descending_then_by_name
partition_key: tenant-identifier-for-the-shard
idempotency_key = order-submission-attempt-0001
foreign-key = orders_customer_id_references_pk

## The blanks documentation writes instead of a secret

OPENAI_API_KEY=your-api-key-goes-here
SECRET_KEY="YOURSECRETKEYGOESHERE"
TUNNEL_TOKEN=PASTE_TUNNEL_TOKEN_HERE
API_TOKEN=replace-this-with-your-token
DEPLOY_KEY=example-key-do-not-use-in-production

## Query strings that carry no credential

Documentation names the convention after a space; a leaked URL carries its
parameter mid-run. The lookbehind in TOKEN_URL is what separates these from
the token-past-512-characters case that published on 2026-08-30 (ROW-77).

append ?key=value to the URL of the request
https://example.com/search?q=hello&page=2
the query was ?token=abc123 in the log

The signed-URL vocabulary added on 2026-09-01 put two ordinary English words,
sig and signature, into a rule that runs over the owner's own prose. The
delimiter anchor is the whole defence and these are what test it.

The sig field is described in the signature section below.
Set the signature algorithm to HMAC-SHA256 before signing.
the query was ?sig=abc123 in the log
See the X-Amz-Signature header documentation for the parameter list.

## Hashes and ids, the class no shape rule can separate from a key

The fix landed in commit a3f9c2e1b7d4058a6c9e2f1a4b7d0c3e5f8a9b2c yesterday.
Run id 550e8400-e29b-41d4-a716-446655440000 completed at 06:05.

## Password-shaped names that are not password assignments

Added 2026-09-01 with the PASSWORD_ASSIGN rewrite. Before it the rule could not
fire on any of these because its \b could not cross an underscore; after it the
name matches and only the value exclusions keep them out. That makes this the
section that goes red first if somebody loosens the value side.

Every name here is PREFIXED on purpose, and six lines were respelled that way on
2026-09-03. They were written with a bare password, passwd or pwd, and the rule
that ships refuses those whatever the value is: the bare keyword got its own arm
back that day, because releasing it leaked 15% of real generated passwords. So a
bare form in this file is not a false positive the rule should stop making, it is
a cost already paid, and asserting a no-op on it would have asserted the leak.
The bare spellings are pinned instead in fixtures/secret_probes.json under
known_false_positives, where they are asserted to FIRE.

ROW-151 (2026-09-05) moved eleven of these lines out of this file entirely. The
bracket-bypass it closed (a prefixed name, a colon, then an opening brace with
the value on the next line) could only be closed by giving
`password`/`passwd`/`pwd` a backstop arm with no value-side exclusion at all, on
ANY prefix, not only bare. That backstop is what ROW-151 needed and it costs
exactly the value-side exclusions this section used to rely on for the
prefixed forms too: `===`, `z.string()`, `false`, `{}`, `''`, a bare path, a
bare integer, a shell variable, `changeme`, `[REDACTED]`, `dummy` and an empty
pair all now fire when the name is `*password`/`*passwd`/`*pwd`, prefixed or
not. That is a real cost, paid on purpose, and it is asserted (not silently
accepted) as the "..., prefixed" twins of the existing known_false_positives
entries in fixtures/secret_probes.json, where each is pinned to FIRE. Keeping
them here as "must stay clean" would have been asserting a no-op the rule no
longer performs.
See record/findings/row-150-151-152-cross-product-gaps-and-the-backstop-arm.md.

The eleven lines removed here, all now pinned to FIRE in secret_probes.json's
known_false_positives: the strict-equality comparison, the schema declaration,
the structural opener, the empty string, the bare pwd before a path, the bare
integer, the shell variable, the your- placeholder, the already-redacted
value, the empty pair, and (this one is not a name-prefix twin, it is the
existing "a language keyword as the value" probe) a local variable named
withPassword holding the boolean false, because that name contains "Password"
and the backstop arm does not require a separator before the keyword. That is
eleven. The whole-value dummy probe lives in secret_probes.json, not in this
file, and never did; a critic caught an earlier version of this paragraph
listing it as removed from here, which it never was. `pass` alone (never
`password`/`passwd`/`pwd`) keeps its full value-side exclusion set regardless
of prefix, so the `pass`-only lines below are unaffected and still belong in
this file.

The npm dependency line "minipass": "^7.1.2", names a package.
SHOULD_PASS = [1, 2, 3]
checklist-pass":"checklist-fail" is a pair of css class names.
bypass: ${req.url}
