# Validator fixtures, and why they are not in the parity corpus

Ten passports that `tools/validate.py` must refuse, one per branch of checks 12,
13 and 14, plus the mapping from fixture to check number in `tools/run_tests.sh`
test 12. A fixture here that is not named in that test's `EXPECTED` table fails
the suite, because a fixture nothing asserts against is decoration.

**They are deliberately not in `fixtures/passports/`.** That directory is the
parity corpus: `web/tools/parity.mjs` walks it and requires every `invalid_`
fixture to be refused by both `tools/validate.py` and `web/lib/_validate.mjs`.
The site validator implements neither check, so moving these there today turns
parity red and fails the web build for a divergence that is intended rather than
accidental.

The divergence is real and is being sequenced rather than ignored. The rules are
not on `main` yet, and tightening the live upload endpoint ahead of the published
spec would refuse passports that today's spec permits, written by whoever holds
today's capture skill. `web/README.md` on `main` carries the port note, the exact
failure strings and both of check 13's exemptions.

**When the spec and `validate.py` land on `main`, move these five into
`fixtures/passports/`.** Parity goes red and stays red until the web validator
catches up, which closes the gap by construction instead of by anyone
remembering. `parity.mjs` also has an `ALLOWED` divergence table, which is the
other way to do this; it is meant to shrink rather than grow, so a red build that
forces the port is the better instrument here.
