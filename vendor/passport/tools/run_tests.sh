#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

FAILED=""

# ---- Test 0: this file cannot have been cut in half by an apostrophe --------
#
# Every check below is a Python program held in a SINGLE-QUOTED shell string,
# NAME=' ... '. One apostrophe anywhere inside one of them ends the string, and
# everything after it stops being Python and becomes shell.
#
# The reason this is a test and not a comment is the failure mode. It is not a
# syntax error and it is not a red suite. The shell runs whatever words follow,
# and in the case that prompted this, that was a line beginning `login:`, so the
# terminal sat waiting for a username and the suite looked like it had hung. The
# same edit ran green in a background task because nothing was there to answer.
# Diagnosing it from the symptom costs far more than this check does.
#
# Written with a QUOTED HEREDOC rather than a single-quoted payload, so this
# check is not vulnerable to the thing it checks for.
python3 - "$0" <<'PYEOF' || FAILED="${FAILED}QUOTING: a check payload in run_tests.sh contains an apostrophe\n"
import re, sys
src = open(sys.argv[1], encoding="utf-8").read().split("\n")
# PAIR BY SCANNING, NOT BY TWO SEPARATE LISTS. An earlier version collected
# openers matching ^[A-Z_]+=$SQ and closers matching any line that is exactly a
# lone quote, then zipped them. Those are different definitions of a boundary,
# so an ordinary lowercase multi-line shell assignment between two payloads,
#
#     note=$SQ
#     a helper message, entirely legal shell
#     $SQ
#
# made the counts differ and the check announced "almost certainly a stray
# apostrophe" about a file that had none. Loud and wrong, which sends the reader
# hunting for something that is not there. A closing quote only closes if
# something is open.
regions, opener = [], None
for i, l in enumerate(src):
    if opener is None:
        if re.match(r"^[A-Z_]+='$", l):
            opener = i
    elif l == "'":
        regions.append((opener, i))
        opener = None
bad = []
if opener is not None:
    bad.append("the payload opened at line %d is never closed" % (opener + 1))
for a, b in regions:

    # SIMULATE THE SHELL RATHER THAN SCRUBBING THE TEXT, and the difference is
    # not academic. The first version of this check deleted both spellings of
    # the toggle, '" and "', and then looked for a leftover apostrophe. A critic
    # defeated it with the one line most likely to appear in this repository:
    #
    #     v = v.strip("\"'")
    #
    # which is the exact idiom validate.py uses and the subject of the ticket
    # this check was written under. The apostrophe sits against a double quote,
    # so the scrub removed it, and Test 0 printed "no apostrophe inside any of
    # them" while the payload had been cut in half, every later test had been
    # thrown away, and the suite exited 0. A guard that reports clean on the
    # exact failure it exists to catch is worse than no guard at all.
    #
    # So: walk the region tracking whether the shell is inside the single-quoted
    # string. Each apostrophe flips that. Leaving it is legal ONLY for the
    # interpolation idiom, where the excursion is exactly one double-quoted
    # shell word before the string reopens:
    #
    #     r = json.load(open("'"$TMPDIR/report.json"'"))
    #                        ^^^ out, "$TMPDIR/report.json", back in
    #
    # Anything else outside the string is Python being handed to the shell.
    region = "\n".join(src[a + 1:b])
    i = 0
    while True:
        j = region.find("'", i)
        if j < 0:
            break
        k = region.find("'", j + 1)
        line_no = a + 2 + region.count("\n", 0, j)
        if k < 0:
            bad.append("line %d: an apostrophe with nothing to reopen the string: %s"
                       % (line_no, src[line_no - 1].strip()[:70]))
            break
        excursion = region[j + 1:k]
        if not re.fullmatch(r'"[^"\n]*"', excursion):
            bad.append("line %d: %s"
                       % (line_no, src[line_no - 1].strip()[:70]))
        i = k + 1
for b_ in bad:
    print("   " + b_, file=sys.stderr)
if bad:
    print("   Each line above leaves the single-quoted shell string and does not "
          "come straight back through the \"$VAR\" interpolation idiom, so what "
          "follows it is Python handed to the shell. Rewrite the wording without "
          "the apostrophe (\"the login of the owner\", not the possessive).",
          file=sys.stderr)
    sys.exit(1)
# Counted rather than written down, so adding a payload does not make this line
# a lie. A hardcoded number here would be its own small version of the defect.
print("   run_tests.sh: %d check payloads, no apostrophe inside any of them"
      % len(regions))
PYEOF

# ---- Test 1: scrub.py ----
python3 scrub.py fixtures/scrub_input.md "$TMPDIR/scrubbed.md" "$TMPDIR/report.json" || true

# Check report counts
# Two totals now, and they are counted separately on purpose. A near miss is
# NOT a redaction: it is a string the scrubber deliberately left in the file and
# handed to the owner to look at. Summing them would let a rise in near misses
# hide a fall in actual redactions, which is the arithmetic that lets a suite go
# green while the thing it guards gets worse.
SCRUBBED_N=$(python3 -c "import json; r=json.load(open('$TMPDIR/report.json')); print(len([f for f in r['findings'] if f.get('scrubbed') is not False]))")
NEARMISS_N=$(python3 -c "import json; r=json.load(open('$TMPDIR/report.json')); print(len([f for f in r['findings'] if f.get('scrubbed') is False]))")
if [ "$SCRUBBED_N" -lt 18 ] || [ "$SCRUBBED_N" -gt 21 ]; then
    FAILED="${FAILED}SCRUB: redactions=$SCRUBBED_N, expected 18-21\n"
fi
if [ "$NEARMISS_N" -lt 5 ]; then
    FAILED="${FAILED}SCRUB: near misses=$NEARMISS_N, expected >=5; the owner is being shown less than before\n"
fi

CHECK_COUNTS='
import json, sys
r = json.load(open("'"$TMPDIR/report.json"'"))
c = r["counts"]
expected = {"AWS_KEY": 2, "ANTHROPIC_KEY": 1, "OPENAI_KEY": 2, "GITHUB_TOKEN": 1,
            "JWT": 1, "EMAIL": 3, "IPV4": 1, "TOKEN_URL": 3, "PASSWORD_ASSIGN": 2,
            # HIGH_ENTROPY must stay >= 1 even though CREDENTIAL_ASSIGN now
            # catches most of what used to fall through to it. A more specific
            # rule shadowing the backstop is how a backstop stops being tested
            # while every assertion still passes, so the fixture carries a bare
            # plant with no credential-ish label that only rule 10 can reach.
            "HIGH_ENTROPY": 1,
            "CREDENTIAL_ASSIGN": 1,
            "HIGH_ENTROPY_NEAR_MISS": 5}
for k, v in expected.items():
    if c.get(k, 0) < v:
        print(f"SCRUB: missing count for {k}: got {c.get(k, 0)}, need >= {v}", file=sys.stderr)
        sys.exit(1)
'
if ! python3 -c "$CHECK_COUNTS" 2>&1; then
    FAILED="${FAILED}SCRUB: per-type count check failed\n"
fi

# Check output file does not contain planted secrets
if grep -q "AKIAIOSFODNN7EXAMPLE" "$TMPDIR/scrubbed.md"; then
    FAILED="${FAILED}SCRUB: output still contains AWS key\n"
fi
if grep -q "sk-ant-abc1234567890abcdef-testkey-value" "$TMPDIR/scrubbed.md"; then
    FAILED="${FAILED}SCRUB: output still contains anthropic key\n"
fi
if grep -q "admin@example.com" "$TMPDIR/scrubbed.md"; then
    FAILED="${FAILED}SCRUB: output still contains email\n"
fi

# Two matches of one rule on one line. This is the case the fixture avoided for
# as long as it existed, by putting every planted secret on its own line, and it
# is the only arrangement the old index arithmetic got wrong. Against the code
# that shipped, the FIRST of these two survived in full while the report counted
# both as scrubbed.
if grep -q "TOKENONEqqqwwweeerrrtttyyy111222" "$TMPDIR/scrubbed.md"; then
    FAILED="${FAILED}SCRUB: first of two same-rule matches on one line survived\n"
fi
if grep -q "TOKENTWOzzzxxxcccvvvbbbnnn333444" "$TMPDIR/scrubbed.md"; then
    FAILED="${FAILED}SCRUB: second of two same-rule matches on one line survived\n"
fi

# Rule 10 has to REDACT, not just report.
#
# THIS IS THE ASSERTION THAT WAS MISSING, and its absence is why the bug lived.
# The per-type check above asserts HIGH_ENTROPY appears in the REPORT, and the
# rule appended a finding and then wrote the line out untouched, so the suite
# was green over a file that still carried the secret. Presence in the report is
# not evidence of absence from the file. Assert the file.
if grep -q "aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV" "$TMPDIR/scrubbed.md"; then
    FAILED="${FAILED}SCRUB: high-entropy token was reported but left in the output\n"
fi

# The three shapes that walked straight through every rule before 2026-08-17.
#
# 1. Bare high-entropy with no credential-ish label. Guards rule 10 against
#    being shadowed by CREDENTIAL_ASSIGN.
# 2. Standard base64. The old character class had no + or /, so the AWS
#    secret-access-key shape was split into sub-32 fragments and never reached
#    the case gate. It was not that the gate rejected it; the rule never saw it.
# 3. Single-case hex in an assignment. Passes the length bar, fails the
#    lower-plus-upper-plus-digit gate, and looks exactly like a sha256. Only
#    the surrounding name distinguishes a token from a hash, which is why the
#    rule that catches it reads the name and ignores the alphabet.
if grep -q "zQ7wE2rT5yU8iO1pA4sD6fG9hJ3kL0zX" "$TMPDIR/scrubbed.md"; then
    FAILED="${FAILED}SCRUB: bare high-entropy value survived; rule 10 is shadowed\n"
fi
if grep -q "uCcqMzIvS0dNREVORy9iUHhSZmlDWUVYQU1QTEVLRVkr" "$TMPDIR/scrubbed.md"; then
    FAILED="${FAILED}SCRUB: base64 credential survived; the character class lost + and /\n"
fi
if grep -q "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4" "$TMPDIR/scrubbed.md"; then
    FAILED="${FAILED}SCRUB: single-case hex token in an assignment survived\n"
fi

# The other direction, and it earns its place now that rule 10 destroys text
# rather than only mentioning it. Section 4 of the fixture plants near-misses
# that MUST survive: a lowercase slug, a git hash and a uuid all clear the
# thirty-two character bar and all fail the lower-plus-upper-plus-digit test.
# If a future widening of that rule starts eating them, this is what says so.
for KEEP in "abcdef1234567890abcdef1234567890abcdef12" \
            "550e8400-e29b-41d4-a716-446655440000" \
            "this-is-a-long-lowercase-slug-value-that-exceeds-thirty-two-chars"; do
    if ! grep -q "$KEEP" "$TMPDIR/scrubbed.md"; then
        FAILED="${FAILED}SCRUB: near-miss was destroyed, rule 10 is too broad: $KEEP\n"
    fi
done

# The false-positive corpus. Every fixture in this repository asserts that a
# planted secret is CAUGHT, and until 2026-08-17 not one asserted that innocent
# content SURVIVES. So a rule that fired on 1.77% of stranger-written documents,
# wrongly nearly every time, passed the whole suite. It aborted a capture on the
# word "monkey" and rewrote three lines of a golden example into scrub markers.
#
# Scrubbing this fixture must be a no-op: byte-identical output, no destructive
# findings, and no growth in the reported ones. Unchanged output alone would pass
# while the report told the owner their passport carried credentials it did not.
python3 scrub.py fixtures/scrub_false_positives.md "$TMPDIR/fp.md" "$TMPDIR/fp.json" || true
if ! cmp -s fixtures/scrub_false_positives.md "$TMPDIR/fp.md"; then
    FAILED="${FAILED}SCRUB: false-positive corpus was modified. Diff:\n$(diff fixtures/scrub_false_positives.md "$TMPDIR/fp.md" | head -20)\n"
fi
# Destructive findings only. HIGH_ENTROPY_NEAR_MISS carries scrubbed=false and is
# the rule reporting what it deliberately left alone, which is the same
# distinction the counts at the top of this file draw. This corpus produces nine
# of those, on hashes, uuids and documentation blanks, and that is the near-miss
# feature working rather than a false positive: nothing is removed and the owner
# is told what was skipped. It is still more noise than an innocent document
# should generate, and if somebody tightens that threshold, this is the corpus to
# measure it against.
FP_N=$(python3 -c "import json; r=json.load(open('$TMPDIR/fp.json')); print(len([f for f in r['findings'] if f.get('scrubbed') is not False]))")
if [ "$FP_N" != "0" ]; then
    FAILED="${FAILED}SCRUB: false-positive corpus produced $FP_N destructive findings, expected 0\n"
fi
# And a ceiling on the TOTAL, which the destructive count alone cannot give.
# Filtering on `scrubbed is not False` means a rule downgraded from destroying to
# reporting becomes invisible here: it could fire on every line of this fixture,
# report a finding for each, and still leave the file byte-identical with
# FP_N == 0. That is a precision regression the owner would see and this suite
# would not. Thirteen is what the near-miss rule produces today, on hashes,
# uuids, documentation blanks, and (added by ROW-100) four of the six database
# and caching values now excluded by name from CREDENTIAL_ASSIGN: the near-miss
# rule reads the VALUE alone and does not know CREDENTIAL_ASSIGN just excluded
# the name in front of it, so it correctly still flags a 20+ character
# hyphen/underscore-joined value as worth a stranger's attention without
# touching it. That is the near-miss feature working, same as the nine it
# already produced, not a new hole. Was nine before ROW-100 added six lines to
# this fixture; the bound is loose enough not to be brittle and tight enough
# that a rule quietly turning report-only still trips it.
FP_TOTAL=$(python3 -c "import json; print(len(json.load(open('$TMPDIR/fp.json'))['findings']))")
if [ "$FP_TOTAL" -gt 13 ]; then
    FAILED="${FAILED}SCRUB: false-positive corpus produced $FP_TOTAL findings in total, expected <=13. Nothing was destroyed, so check whether a rule became report-only and is now firing on innocent content.\n"
fi

# The credential rule must stay LINEAR on a long run of name characters.
#
# It was quadratic. One 64KB line of "A" took 10.5s in V8 and 128KB took 40.6s,
# against MAX_BYTES of 256KB, so a single upload containing no credential at all
# could hold a function open past its timeout. The cause was an unanchored
# [A-Za-z0-9_.\-]* at the start of the pattern, which makes the engine rescan from
# every position; the left boundary fixed it. The rule this replaced had the same
# flaw, and ROW-72 told another lane to copy that rule to the public endpoint.
#
# The input is 16KB and NOT the 256KB cap, deliberately. At 256KB the quadratic
# form does not fail this test, it hangs it for minutes, and a suite that hangs is
# worse than one that fails: nobody reads a hang as a result. At 16KB the
# quadratic form takes about 8s and the linear one about 1ms, so a 1s bound has
# three orders of magnitude of headroom and still fails within seconds.
#
# THREE shapes, and the reason there are three is the whole lesson. The first
# version of this test carried only the run-of-name-characters case, because that
# was the input the author had thought of. The left-anchor fix made THAT input
# linear and a critic then found a SECOND quadratic path the test could not see:
# two unbounded stars separated by literals inside the path-exclusion lookahead,
# 24s in V8 at the 256KB cap with the "fix" applied. A performance assertion
# pinned to one adversarial input certifies that one input and nothing else, in
# the same way a fixture corpus of planted secrets certifies nothing about
# innocent content. Each entry below targets a different quantifier.
#
# The sizes differ per shape and that is not arbitrary. Each quantifier blows up
# at its own rate, so one size does not separate all three: at 16KB the
# path-exclusion shape took 677ms in its broken form, which is UNDER this bound
# and would have passed. Verified by reverting each fix in turn and watching the
# matching line fail. Size each shape so its broken form is comfortably over the
# bound and its healthy form is microseconds, and never assume one size transfers.
for CASE in "name-run:16384" "path-exclusion:32768" "dotted-chain:32768"; do
    LABEL="${CASE%%:*}"
    N="${CASE##*:}"
    PERF=$(python3 -c "
import sys, time
sys.path.insert(0, '.')
import scrub
rx = dict(scrub.PATTERNS)['CREDENTIAL_ASSIGN']
label = '$LABEL'
n = $N
if label == 'name-run':
    s = 'A' * n
elif label == 'path-exclusion':
    s = 'API_KEY=' + '/' * (n // 2) + '.' * (n // 2)
else:
    s = 'API_KEY=' + 'a.' * (n // 2)
t = time.perf_counter(); rx.search(s); print(int((time.perf_counter() - t) * 1000))
")
    if [ "$PERF" -gt 1000 ]; then
        FAILED="${FAILED}SCRUB: CREDENTIAL_ASSIGN took ${PERF}ms on shape '${LABEL}'. It has gone super-linear again; look for an unbounded quantifier reachable from that shape.\n"
    fi
done

# And once AT THE CAP, which is the number that actually matters.
#
# The loop above uses 16-32KB because that is where a quadratic form separates
# cheaply. But a size cap is not a defence, it is the attacker's budget:
# _validate.mjs checks MAX_BYTES = 262144 BEFORE validating, so it does not limit
# the damage, it specifies exactly how much input a superlinear check is entitled
# to receive. A check downstream of a cap has to be measured at the cap.
#
# The reason this could not be done before is that the broken form does not fail
# here, it hangs for minutes. A subprocess with its own timeout fixes that: over
# budget and a hang both become the same fast, readable failure. Healthy is about
# 20ms per shape, so the 15s ceiling is not a tight fit, it is a liveness bound.
CAP_OUT=$(python3 -c "
import sys, time, signal
sys.path.insert(0, '.')
import scrub
n = 262144
shapes = {
    'name-run': 'A' * n,
    'path-exclusion': 'API_KEY=' + '/' * (n // 2) + '.' * (n // 2),
    'dotted-chain': 'API_KEY=' + 'a.' * (n // 2),
    'url-no-terminator': 'postgres://' + 'a' * n,
    'url-user-pass-no-at': 'postgres://' + 'a' * (n // 2) + ':' + 'b' * (n // 2),
    'url-many-at': 'postgres://u:p' + '@' * n,
}
signal.alarm(15)
worst, worst_label = 0, ''
# EVERY rule against EVERY shape, not one rule against one shape. The previous
# version benchmarked CREDENTIAL_ASSIGN alone, so three rules added at the public
# door on 2026-08-18 were unguarded, and a rule is only ever added when somebody
# is thinking about detection rather than about cost.
for rule, rx in scrub.PATTERNS:
    for label, s in shapes.items():
        t = time.perf_counter(); rx.search(s); ms = int((time.perf_counter() - t) * 1000)
        if ms > worst: worst, worst_label = ms, rule + '/' + label
print(f'{worst} {worst_label}')
" 2>"$TMPDIR/cap.err") || CAP_OUT="FAILED"
# A crash and a timeout both make the command exit non-zero, and reporting a
# crash as a timeout sends the reader to benchmark a regex when the real problem
# is a KeyError. The alarm kills the process with SIGALRM, so a death by signal
# is exit 128+14; anything else that wrote to stderr is a real error, and its
# text is worth more than a guess.
if [ "$CAP_OUT" = "FAILED" ]; then
    if [ -s "$TMPDIR/cap.err" ]; then
        FAILED="${FAILED}SCRUB: the 256KB cap benchmark crashed rather than timing out: $(head -3 "$TMPDIR/cap.err" | tr '\n' ' ')\n"
    else
        FAILED="${FAILED}SCRUB: a rule did not finish 256KB (MAX_BYTES) within 15s, and the timeout means we cannot say which. That is the whole budget an upload is allowed to hand it. Re-run the loop above printing each rule to find it.\n"
    fi
elif [ "${CAP_OUT%% *}" -gt 3000 ]; then
    FAILED="${FAILED}SCRUB: ${CAP_OUT##* } took ${CAP_OUT%% *}ms on 256KB. MAX_BYTES is the attacker's budget, and this is too slow to sit at a public door.\n"
fi

# ReDoS seeds: every rule against every seed, from the shared file.
#
# tools/fixtures/redos_seeds.json carries the shapes and the reasoning. The short
# version: a seed must contain the literal a rule requires, or the engine skips the
# input and the timing measures the skip; and it must then WITHHOLD THE TAIL,
# because backtracking lives on the failing path and a matching input returns early.
#
# The previous seeds were built from pattern heads, which is the matching path.
# Removing the lookbehind from CREDENTIAL_ASSIGN, the documented quadratic, measured
# 0.3ms against a head seed and 8,491ms against a tail-withheld one at 16KB. The
# benchmark would have passed a regression that takes 135 seconds at 64KB.
SEEDED=$(python3 -c "
import sys, json, time
sys.path.insert(0, '.')
import scrub
seeds = json.load(open('fixtures/redos_seeds.json'))['seeds']
N = 32768
worst, who = 0, ''
for rule, rx in scrub.PATTERNS:
    for label, motif in seeds.items():
        s = (motif * (N // len(motif) + 1))[:N]
        t = time.perf_counter(); rx.search(s); ms = int((time.perf_counter() - t) * 1000)
        if ms > worst: worst, who = ms, rule + ' / ' + label
print(f'{worst}|{who}')
")
SEEDED_MS="${SEEDED%%|*}"
if [ "$SEEDED_MS" -gt 1000 ]; then
    FAILED="${FAILED}SCRUB: ${SEEDED#*|} took ${SEEDED_MS}ms on a 32KB seed. Super-linear on an input that reaches it and cannot complete.\n"
fi

# ---- Test 2: validate.py ----
for pf in fixtures/passports/valid_minimal.md fixtures/passports/valid_full.md \
          fixtures/passports/valid_nested_fence.md \
          fixtures/passports/valid_backticked_capability.md \
          fixtures/passports/valid_prose_mentions_ref.md \
          fixtures/passports/valid_prose_ref_at_line_start.md \
          fixtures/passports/valid_quoted_fence_in_tacit_notes.md \
          fixtures/passports/valid_block_scalar_blank_bom.md \
          fixtures/passports/valid_block_scalar_blank_nel.md \
          fixtures/passports/valid_fenced_pipeline_in_section_2.md \
          fixtures/passports/valid_fenced_pipeline_plain_space.md \
          fixtures/passports/valid_fenced_heading_mention.md \
          fixtures/passports/valid_fenced_table_beside_real_one.md \
          fixtures/passports/valid_title_invisible_inside_nel.md \
          fixtures/passports/valid_title_invisible_inside.md; do
    if python3 validate.py "$pf" > /dev/null 2>&1; then
        : # pass expected
    else
        FAILED="${FAILED}VALIDATE: $pf should have exited 0\n"
    fi
done

for pf in fixtures/passports/invalid_envelope_block_scalar_dash_spacing.md \
          fixtures/passports/invalid_envelope_ws_fs.md \
          fixtures/passports/invalid_envelope_ws_nel.md \
          fixtures/passports/invalid_envelope_ws_bom.md \
          fixtures/passports/invalid_envelope_bom_fence.md \
          fixtures/passports/invalid_envelope_fs_fence.md \
          fixtures/passports/invalid_envelope_bom_heading.md \
          fixtures/passports/invalid_envelope_nel_heading.md \
          fixtures/passports/invalid_envelope_caps_bom.md \
          fixtures/passports/invalid_envelope_caps_fs.md \
          fixtures/passports/invalid_envelope_caps_gs.md \
          fixtures/passports/invalid_envelope_caps_nel.md \
          fixtures/passports/invalid_fence_invisible_bom.md \
          fixtures/passports/invalid_fence_invisible_nbsp.md \
          fixtures/passports/invalid_title_only_invisible.md \
          fixtures/passports/invalid_astral_summary.md \
          fixtures/passports/invalid_title_too_long.md \
          fixtures/passports/invalid_frontmatter_line_41.md \
          fixtures/passports/invalid_frontmatter_open_trailing_space.md \
          fixtures/passports/invalid_frontmatter_close_trailing_space.md \
          fixtures/passports/invalid_frontmatter_open_nbsp.md \
          fixtures/passports/invalid_summary_table_row.md \
          fixtures/passports/invalid_summary_subheading.md \
          fixtures/passports/invalid_summary_fence.md \
          fixtures/passports/invalid_summary_indented_h2.md \
          fixtures/passports/invalid_summary_heading_fenced.md \
          fixtures/passports/invalid_summary_too_short.md \
          fixtures/passports/invalid_fence_invisible_in_frontmatter.md \
          fixtures/passports/invalid_envelope_fence_desync.md \
          fixtures/passports/invalid_missing_key.md fixtures/passports/invalid_wrong_order.md \
          fixtures/passports/invalid_bad_capability.md fixtures/passports/invalid_unreviewed_scrub.md \
          fixtures/passports/invalid_golden_unclosed.md \
          fixtures/passports/invalid_golden_stray_heading.md \
          fixtures/passports/invalid_unfilled_template.md; do
    OUTPUT=$(python3 validate.py "$pf" 2>/dev/null) && EXIT_CODE=0 || EXIT_CODE=$?
    if [ "$EXIT_CODE" -eq 0 ]; then
        FAILED="${FAILED}VALIDATE: $pf should have exited 1\n"
    fi
    if ! echo "$OUTPUT" | grep -q "^FAIL"; then
        FAILED="${FAILED}VALIDATE: $pf should print at least one FAIL line\n"
    fi
done

# ---- Test 3: validator parity ----
#
# The corpus above proves validate.py behaves. It says nothing about whether the
# site agrees with it, and those two disagreeing is the failure that actually
# hurts: a capture finishes, passes its own loop, and is refused on upload for a
# rule this file never checked. web/tools/parity.mjs runs the whole corpus
# through both implementations and fails on any disagreement.
#
# Skipped, loudly, without node, because this file is otherwise pure Python and
# a hard dependency here would make the loop unrunnable on a machine that has no
# node rather than telling it something useful.
# The harness itself is guarded the same way as node. It lives under web/, which
# is not always present: this tree is also copied without it, and the file is
# newer than most checkouts. A missing harness is a skip, not a failure.
if [ ! -f ../web/tools/parity.mjs ]; then
    echo "PARITY: skipped, ../web/tools/parity.mjs is not in this tree" >&2
elif command -v node > /dev/null 2>&1; then
    if ! node ../web/tools/parity.mjs > "$TMPDIR/parity.txt" 2>&1; then
        FAILED="${FAILED}PARITY: validate.py and the site disagree. See below.\n"
        cat "$TMPDIR/parity.txt" >&2
    fi
else
    echo "PARITY: skipped, node is not installed" >&2
fi

# ---- Test 4: nothing that ships may carry this machine ----
#
# A skill folder or an installer branch is read by a stranger on their own
# machine, and it travels by copy or zip, so everything inside it travels.
# Repo-local documentation (README.md, HANDOFF.md, verification/) is not shipped
# and is deliberately out of scope.
#
# Two things are checked. First, no file that is not readable text: a stray
# __pycache__ entry is the case that already happened, and a .pyc carries the
# absolute path of the machine that compiled it inside a file nobody thinks to
# read. Second, no path that only one person has.
#
# The home-path rule is an allowlist, not a denylist, and that is the whole
# point of it. Naming the directories to forbid only ever catches last month:
# the first version of this test knew about ~/Local, the repo moved to
# ~/Phaeacia, and the guard went quiet on the very path everyone now types.
# Listing what is generic instead means a new machine-specific directory is
# caught the day it appears, and widening the list is a deliberate act.
LOCAL_PATHS='
import os, re, sys

root = os.path.abspath("..")
shipped = ["skills/agent-passport", "installer", "spec", "capture"]
text_ext = {".md", ".py", ".yaml", ".yml", ".sh", ".json", ".txt", ".html", ".css"}

# Directories every reader has in the same place, plus the name of the example
# agent the installer branches are written around. Nothing else.
generic_home = sorted({".claude", ".config", ".local", "Library",
                       "Downloads", "Desktop", "daily-brief"})
allowed = ", ".join("~/" + d for d in generic_home)

# A /Users/<segment> is fine when the segment is a stand-in rather than an
# account: CHANGEME, a shell variable, or nothing at all, which is what
# /Users/<you> in markup leaves once the angle bracket ends the match.
placeholder = re.compile(
    r"^(CHANGEME|USERNAME|USER|YOU|YOURNAME|YOUR_NAME|YOUR-NAME|NAME|"
    r"\{\{?[^}]+\}?\}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)$")
user_path = re.compile(r"/Users/([^/\s\"\x27<>`]*)")
home_path = re.compile(r"(?:~|\$HOME|\$\{HOME\})/([A-Za-z0-9._-]+)")

hits = []
for base in shipped:
    top = os.path.join(root, base)
    if not os.path.exists(top):
        continue
    for dirpath, dirnames, filenames in os.walk(top):
        dirnames[:] = [d for d in dirnames if d != ".git"]
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root)
            if os.path.splitext(name)[1] not in text_ext:
                hits.append("%s is not readable text, and a shipped folder "
                            "travels whole" % rel)
                continue
            try:
                with open(path, "r", encoding="utf-8") as f:
                    lines = f.read().split("\n")
            except (UnicodeDecodeError, OSError):
                hits.append("%s could not be read as UTF-8 text" % rel)
                continue
            for n, line in enumerate(lines, 1):
                for seg in user_path.findall(line):
                    if seg and not placeholder.match(seg):
                        hits.append(
                            "%s:%d /Users/%s is one account on one machine. "
                            "Write it under $HOME, or use /Users/CHANGEME."
                            % (rel, n, seg))
                for seg in home_path.findall(line):
                    if seg not in generic_home:
                        hits.append(
                            "%s:%d ~/%s is this machine layout, not every "
                            "reader. Generic: %s" % (rel, n, seg, allowed))

for h in hits[:8]:
    print(h, file=sys.stderr)
if len(hits) > 8:
    print("... and %d more" % (len(hits) - 8), file=sys.stderr)
sys.exit(1 if hits else 0)
'
if ! python3 -c "$LOCAL_PATHS"; then
    FAILED="${FAILED}PATHS: a shipped file names a path that only exists on this machine\n"
fi

# ---- Test 9: RETIRED, and it left a hole. Read this before moving on. ----
#
# This test built the standalone HTML page from a passport carrying
# <img src=x onerror=...> and <script> in a consent cell, in section 4 prose and
# in the losses table, and failed if any of it reached the page as markup. It
# existed because deleting the esc() call in md_inline() once put a live payload
# into that page with the whole suite green.
#
# The page it tested is gone: passport-to-page.py lost --standalone when capture
# started publishing to app.phaeacia.ai instead of writing a file. The renderer
# that now faces a stranger is web/lib/_render.mjs, and this suite is the Python
# tool suite, which has no business driving it.
#
# THE HOLE IT LEFT, AND WHO CLOSED IT. web/tools/run-tests.mjs already had
# "hostile passport text cannot escape the page", but it put its payloads in the
# TITLE and the SUMMARY only, so the three surfaces this test was written to add,
# a consent cell, section 4 prose and the losses table, were asserted by nobody
# for the hosted renderer. That is fixed on main in 72a0662: one test drives all
# three routes through renderPassport, parsed out of a real body rather than set
# on a derived record, asserting the payloads arrive ESCAPED rather than merely
# absent, because a renderer that dropped the row would pass the negative
# assertions for the wrong reason. It is mutation-checked against inline()'s
# esc() call. Nothing is owed here; this note is the trail between the two.

# ---- Test 10: section 4's prose survives the derivation ----
#
# The sentence "this is a synthetic example ... so nobody mistakes it for
# evidence about a real agent" has been deletable in three separate rounds of
# this work with every test still green, because the harnesses diffed the layer
# below the one the pages consume. A passport that says its evidence is
# synthetic and a page that does not say so is the one failure this project
# cannot ship.
#
# It used to build the standalone page and read the prose back out of the HTML.
# That page is gone, so this reads the derivation instead: --dump-parts is what
# the upload endpoint ports and what web/tools/parity.mjs diffs the site's own
# reader against, so prose that reaches the parts reaches the published page or
# parity fails. One layer lower than before and one layer short of the pixels,
# which is the honest description of what it now proves.
GOLDEN_PROSE='
import re, subprocess, sys, os, tempfile
src = open("../examples/daily-brief-passport.md", encoding="utf-8").read()
g0 = src.find("## 4. Golden examples")
g1 = src.find("## 5. Installer")
lines, fence, prose = src[g0:g1].split("\n"), None, []
for line in lines[1:]:
    m = re.match(r"^\s*(`{3,})", line)
    if m:
        if fence is None:
            fence = len(m.group(1))
        elif len(m.group(1)) >= fence:
            fence = None
        continue
    if fence is None and line.strip() and not line.startswith("#"):
        prose.append(line.strip())
if not prose:
    print("section 4 of the example passport has no prose to check", file=sys.stderr)
    sys.exit(1)
d = tempfile.mkdtemp()
p = os.path.join(d, "prose-passport.md")
open(p, "w", encoding="utf-8").write(src)
r = subprocess.run([sys.executable, "../scripts/passport-to-page.py", p, "--dump-parts"],
                   capture_output=True, text=True)
if r.returncode != 0:
    print("the derivation refused the example passport: " + r.stderr.strip()[:200],
          file=sys.stderr)
    sys.exit(1)
import json
parts = json.loads(r.stdout)["## 4. Golden examples"]["parts"]
# Prose only. A fenced block is the example itself and is checked elsewhere; the
# rule here is about what the owner wrote AROUND the examples, which is where a
# passport says its evidence is synthetic.
derived = re.sub(r"\s+", " ", " ".join(x["text"] for x in parts if x["kind"] == "prose"))
missing = [s for s in prose if re.sub(r"\s+", " ", s) not in derived]
for s in missing:
    print("section 4 prose missing from the derivation: " + s[:70], file=sys.stderr)
sys.exit(1 if missing else 0)
'
if ! python3 -c "$GOLDEN_PROSE"; then
    FAILED="${FAILED}GOLDEN: prose the owner wrote in section 4 did not reach the derivation\n"
fi

# ---- Test 11: the shipped template's losses table survives the upload gate ----
#
# Section 6 is the one section a capture is supposed to leave empty: the spec
# says the install fills it in. The template shipped it as
# "| <capability or input> | <delivered / substituted / lost> | ... |", and the
# site refuses angle brackets as HTML, so every passport a real capture
# produced was rejected at upload with E_HTML. Nothing caught it because the
# example passport this suite validates uses an empty row instead, and the
# fixtures are all built from that example rather than from the template.
#
# Section 2's placeholders stay: those are rows a capture must replace, and the
# gate refusing an unfilled one is the guard working.
LOSSES_TEMPLATE='
import re, sys
bad = []
for path in ("../spec/passport-template.md", "../capture/path-w-prompt.md"):
    body = open(path, encoding="utf-8").read()
    start = body.find("## 6. Losses")
    if start == -1:
        continue
    lines = body[start:].split("\n")
    section_lines = []
    for line in lines[1:]:          # skip the heading itself, or it ends its own section
        if re.match(r"^#{1,2}\s", line):
            break
        section_lines.append(line)
    for n, line in enumerate(section_lines, 1):
        if line.lstrip().startswith("|") and re.search(r"<[^>]+>", line):
            bad.append("%s section 6 line %d: %s" % (path, n, line.strip()[:70]))
for b in bad:
    print("a losses row the upload gate refuses as HTML: " + b, file=sys.stderr)
sys.exit(1 if bad else 0)
'
if ! python3 -c "$LOSSES_TEMPLATE"; then
    FAILED="${FAILED}TEMPLATE: the shipped losses table would be refused at upload\n"
fi

# ---- Test 12: checks 12 and 13 refuse what they claim to, and nothing else ----
#
# Both checks shipped with no test at all: the suite printed ALL TESTS PASSED
# while asserting nothing about either, in either direction. The negative cases
# matter more than the positive one, because a check nobody can see fail is
# indistinguishable from a check that never fires.
#
# WHY THESE FIXTURES ARE NOT IN fixtures/passports/. That directory is the
# parity corpus: web/tools/parity.mjs walks it and requires an invalid_ fixture
# to be refused by BOTH tools/validate.py and web/lib/_validate.mjs. The site
# validator does not implement checks 12 or 13, so putting these three there
# would turn parity red and fail the web build for a divergence that is
# intended, not accidental. The divergence is real and worth naming: a passport
# refused here is accepted on upload today. Porting the two checks into
# web/lib/_validate.mjs closes it, and then these fixtures can move.
VALIDATOR_CHECKS='
import subprocess, sys, os, glob
py = sys.executable
bad = []

# Each fixture names the check it must trip, and each is a DIFFERENT branch of
# that check. Pinning the number is what stops a fixture drifting onto some
# other failure and still looking green, and naming them individually is what
# stops the whole test passing over an empty directory. Both of those were true
# of the first version: deleting every fixture left it green.
# The value is a distinctive substring of the message that branch produces, not
# just the check number. Two of these trip the same check, and with only "FAIL
# 12" pinned, deleting the `binding: none` branch left the suite green: the
# referential branch caught the fixture too, for a different reason, with a worse
# message. Pinning the wording is what makes each branch observable.
EXPECTED = {
    "invalid_unbound_credentialed.md": "credentialed and has no binding",
    "invalid_binding_none.md":         "which names no slot",
    "invalid_binding_dangling.md":     "no slot in personal_slots has that id",
    "invalid_delta_without_state.md":  "compares against an earlier run",
    "invalid_fidelity_value.md":       "the only values are",
    # ROW-131 item 3. Both of these are ACCEPTED by the validator on main, and
    # the first is the one that matters: a quoted access value is the same YAML
    # scalar as the bare one, the regex saw a different string, so the input
    # skipped the binding requirement entirely. A passport could declare a
    # source behind the login of the original owner and never ask the installer
    # what plays that role on their side.
    #
    # NO APOSTROPHES IN THIS FILE inside a PYVAR=... payload. The payloads are
    # single-quoted shell strings, so one apostrophe in a comment ends the
    # string and the rest of the Python is handed to the shell. The first draft
    # of this very comment did it twice, and the failure is not a syntax error:
    # the shell reached a bare `login:` and sat waiting for a username, which
    # reads as a hung test suite rather than as a broken quote.
    "invalid_unbound_credentialed_quoted.md": "credentialed and has no binding",
    "invalid_access_value.md":         "the only two values are",
    # A dangling `access:` with its value on the indented line beneath is legal
    # YAML meaning `access: credentialed`. This validator reads a line at a
    # time, so the same-line match did not fire, and BOTH branches went quiet:
    # no unrecognised-value report and no missing-binding report. It passed.
    "invalid_access_dangling.md":      "access has no value on this line",
    # The same dangling key with a COMMENT after the colon, which is still YAML
    # null. This needs its own fixture because it broke on ORDER rather than on
    # the pattern: when the value match ran first, its `(\S+)` grabbed the `#`
    # and the dangling branch could never fire, so the author was told their
    # access reads as a token they never wrote. The schema stub in
    # spec/passport-0.1.md is written in exactly this shape, so it is the form
    # somebody is most likely to copy.
    "invalid_access_comment_only.md":  "access has no value on this line",
    # This one asserts on the MISSING BINDING, not on the spelling, and that is
    # the whole point of it. The spelling is reported either way. What this
    # fixture holds down is the case fold: the check that decides whether an
    # input counts as credentialed lowercases the value first, so shouting the
    # word does not buy you an escape from the binding requirement. Remove that
    # fold and the second report disappears while the suite would otherwise
    # stay green. Measured 2026-09-03: mutating it left every other test
    # passing.
    "invalid_access_casefold_unbound.md": "credentialed and has no binding",
}
present = {os.path.basename(p) for p in glob.glob("fixtures/validator/invalid_*.md")}
for missing in sorted(set(EXPECTED) - present):
    bad.append("the negative fixture %s is gone, so nothing proves that branch fires" % missing)
for extra in sorted(present - set(EXPECTED)):
    bad.append("%s is not in EXPECTED, so it asserts nothing; add it with the "
               "check number it must trip" % extra)

for name, want in sorted(EXPECTED.items()):
    path = os.path.join("fixtures/validator", name)
    if not os.path.exists(path):
        continue
    r = subprocess.run([py, "validate.py", path], capture_output=True, text=True)
    out = r.stdout + r.stderr
    if r.returncode == 0:
        bad.append("%s was accepted and should have been refused (%s)" % (name, want))
    elif want not in out:
        bad.append("%s was refused, but not for %r: %s" % (name, want, out.strip()[:80]))
# The positive cases guard the other direction: no check may fire on a passport
# that does everything they ask. The second one exists because check 13 used to
# require `keeps:` to carry a value on its own line, so a `keeps:` written as a
# YAML list, which is legal and means the same thing, was refused with a message
# telling its author to add a state block they had already written. A regression
# there is a false REFUSAL rather than a false acceptance, which is why it needs
# its own fixture: nothing else in this suite would ever go red for it.
POSITIVE = ["fixtures/passports/valid_state_and_binding.md",
            "fixtures/validator/valid_state_keeps_list.md",
            # Every quotable scalar quoted, all of it legal YAML meaning exactly
            # what the unquoted form means. On main this is refused by check 5
            # and check 6, both of which named the quoted string as though the
            # quotes were the error.
            #
            # It lives under fixtures/passports/ rather than fixtures/validator/
            # for a reason worth keeping: parity.mjs runs everything in that
            # directory through BOTH gates and requires the same verdict. Under
            # validator/ it was only ever fed to validate.py, and that is exactly
            # how the first version of this fix shipped a file it called a valid
            # passport which the upload endpoint refused. A fixture that proves a
            # fix in one implementation is an untested claim about the other.
            "fixtures/passports/valid_quoted_scalars.md",
            # A `note: |` block whose PROSE contains lines reading `access:`
            # and `access: credentialed`. Legal YAML, and the passport is
            # correct: block scalar content is text, not fields. Every check
            # that walks input entries used to read those lines as real
            # fields. Verified against main on 2026-09-03: main refuses the
            # valued form, so this fixture closes an existing defect rather
            # than guarding a new one. It lives under passports/ so parity
            # compares both gates on it.
            "fixtures/passports/valid_block_scalar_prose.md"]
for ok in POSITIVE:
    if not os.path.exists(ok):
        bad.append("the positive fixture %s is missing" % ok)
        continue
    r = subprocess.run([py, "validate.py", ok], capture_output=True, text=True)
    if r.returncode != 0:
        bad.append("%s is compliant and was refused: %s"
                   % (os.path.basename(ok), (r.stdout + r.stderr).strip()[:120]))
for b in bad:
    print(b, file=sys.stderr)
sys.exit(1 if bad else 0)
'
if ! python3 -c "$VALIDATOR_CHECKS"; then
    FAILED="${FAILED}CHECKS: the binding and state checks do not refuse what they claim to\n"
fi

# ---- The two denied-path lists must not drift ----
#
# assemble.py and validate.py both carry FORBIDDEN strings and neither may
# import the other, because both ship standalone inside the skill. They drifted:
# validate.py was widened to ten entries and assemble.py was left at five, so
# `.env`, `.key`, `id_ed25519`, `id_ecdsa` and `id_dsa` passed the assembler and
# were then refused in the assembled file. That is precisely the integration
# hazard assemble.py's docstring says it exists to catch, and the guard failed
# open on the five most common modern cases.
#
# Compared here rather than trusted, because a duplicated list with nothing
# comparing it is a list that drifts. That sentence is written twice elsewhere
# in this project about other pairs and it was true here too.
LIST_PARITY='
import importlib.util, os, sys
def load(n, p):
    s = importlib.util.spec_from_file_location(n, p)
    m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
# This script cds to its own directory (tools/) at the top, so the repo root is
# one level up from cwd.
root = os.path.dirname(os.getcwd())
a = load("asm", os.path.join(root, "scripts/assemble.py"))
v = load("val", os.path.join(root, "tools/validate.py"))
if sorted(a.FORBIDDEN) != sorted(v.FORBIDDEN_STRINGS):
    only_v = sorted(set(v.FORBIDDEN_STRINGS) - set(a.FORBIDDEN))
    only_a = sorted(set(a.FORBIDDEN) - set(v.FORBIDDEN_STRINGS))
    print("denied-path lists differ.", file=sys.stderr)
    if only_v: print("  validate.py has, assemble.py lacks: %s" % only_v, file=sys.stderr)
    if only_a: print("  assemble.py has, validate.py lacks: %s" % only_a, file=sys.stderr)
    sys.exit(1)
'
if ! python3 -c "$LIST_PARITY"; then
    FAILED="${FAILED}LISTS: assemble.py and validate.py disagree about denied paths\n"
fi

# ---- SKILL.md's completeness list must match the one the site tells people to run ----
#
# ROW-104 asked for this and predicted the failure it catches. SKILL.md step 0
# lists the files a capture needs before it starts; the site's create page tells
# a reader to `ls -d` the same list. The two were written apart, and the list has
# been wrong twice: seven entries, then ten, and it is eleven now because
# references/installer-core.md was missing while assemble.py hard-fails without
# it. Both times it was extended by reading rather than by running the thing it
# protects.
#
# This compares them mechanically. It is NOT vacuous-when-absent by accident: if
# create.html carries no `ls -d` block, that is announced rather than passed
# over, because a silent skip is exactly how a check like this stops meaning
# anything.
LIST_MATCH='
import os, re, sys
root = os.path.dirname(os.getcwd())
skill = open(os.path.join(root, "skills/agent-passport/SKILL.md")).read()
m = re.search(r"Confirm all \w+ exist: (.+?)\.\n", skill)
if not m:
    print("SKILL.md: no completeness list found", file=sys.stderr); sys.exit(1)
want = [x.strip("`").replace("$SKILL_DIR/", "") for x in re.findall(r"`([^`]+)`", m.group(1))]
page = os.path.join(root, "web/create.html")
if not os.path.exists(page):
    print("NOTE: web/create.html absent; nothing to compare against.")
    sys.exit(0)
html = open(page).read()
block = re.search(r"ls -d(.*?)(?:</|\n\s*\n)", html, re.S)
if not block:
    print("NOTE: web/create.html carries no `ls -d` file list, so SKILL.md\x27s "
          "%d-entry completeness list is compared against nothing. This check goes "
          "live when that page grows one." % len(want))
    sys.exit(0)
got = re.findall(r"(references/[A-Za-z0-9._/-]+|scripts/[A-Za-z0-9._-]+)", block.group(1))
if sorted(set(got)) != sorted(set(want)):
    print("SKILL.md and create.html disagree about the required files.", file=sys.stderr)
    print("  only in SKILL.md:    %s" % sorted(set(want) - set(got)), file=sys.stderr)
    print("  only in create.html: %s" % sorted(set(got) - set(want)), file=sys.stderr)
    sys.exit(1)
print("   SKILL.md and create.html agree on %d required files" % len(want))
'
if ! python3 -c "$LIST_MATCH"; then
    FAILED="${FAILED}LISTS: SKILL.md and create.html disagree about the required files\n"
fi

# ---- Vendor prefix rules, ROW-108 ----
#
# The same fixtures/vendor_probes.json that web/tools/parity.mjs pushes through
# V8. This side runs them through Python, and the two suites reading ONE file is
# the point: parity.mjs compares regex source and flags, never behaviour, so two
# engines can hold byte-identical patterns and disagree on a string. That is
# ROW-109. A vector added to that file is checked in both engines or in neither.
#
# Three things are asserted here, and the third is the one that would have been
# skipped:
#
#   1. every must_fire vector trips at least one preflight rule;
#   2. no must_not_fire vector trips any of them;
#   3. every must_fire vector is redacted by scrub.py under a NAMED rule and not
#      merely by the HIGH_ENTROPY backstop;
#   4. every known_false_positives vector trips a rule, because that group holds
#      ordinary content the password rule refuses today and the point of pinning
#      it is that a change which starts or stops refusing one fails here.
#
# Three matters because the entropy backstop already redacted the Notion token
# this work came from. Had it been asserted only that "scrub removes it", adding
# the named rules would have changed nothing measurable and a later change
# deleting them would have gone green. What the owner reads in their scrub review
# is the difference between "high entropy string" and "a Notion integration
# token", and the owner is the only person who can recognise their own
# credential.
VENDOR_PROBES='
import json, sys, importlib.util, re

spec = importlib.util.spec_from_file_location("preflight", "preflight.py")
pre = importlib.util.module_from_spec(spec); spec.loader.exec_module(pre)
spec2 = importlib.util.spec_from_file_location("scrubmod", "scrub.py")
scrub = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(scrub)

# BOTH probe files, merged. vendor_probes.json holds the vendor-prefix vectors;
# secret_probes.json holds the vectors for the rules that are not tied to one
# vendor. Same shape, same contract, read here and by web/tools/parity.mjs, so a
# vector in either is checked in both engines or in neither.
v = {"must_fire": {}, "must_not_fire": {}, "known_false_positives": {}}
for f in ("fixtures/vendor_probes.json", "fixtures/secret_probes.json"):
    d = json.load(open(f))
    # known_false_positives is optional: vendor_probes.json has none, and a file
    # that grows one later is picked up without editing this loop again.
    for group in ("must_fire", "must_not_fire", "known_false_positives"):
        for name, text in d.get(group, {}).items():
            # Any _-prefixed key is a note, not a vector. The old test skipped
            # only the literal "_note", which meant a second note in one file
            # was silently run as a probe and asserted on.
            if name.startswith("_"):
                continue
            if name in v[group]:
                raise SystemExit("   two probe files both define %r in %s" % (name, group))
            v[group][name] = text
bad = []

for name, text in v["must_fire"].items():
    kinds = [k for k, p in pre.SECRETS if p.search(text)]
    if not kinds:
        bad.append("preflight MISSES a real credential: %s" % name)

for name, text in v["must_not_fire"].items():
    kinds = [k for k, p in pre.SECRETS if p.search(text)]
    if kinds:
        bad.append("preflight REFUSES ordinary content: %s -> %s" % (name, kinds))

# The third group. These are refused on purpose and the assertion runs in the
# firing direction, so a repair that releases one has to come here and say so
# rather than quietly widening the gate.
for name, text in v["known_false_positives"].items():
    kinds = [k for k, p in pre.SECRETS if p.search(text)]
    if not kinds:
        bad.append("preflight no longer refuses a pinned false positive: %s. If "
                   "that is the repair you intended, move it to must_not_fire in "
                   "this commit." % name)

# The named-rule assertion. HIGH_ENTROPY is applied outside PATTERNS, so a rule
# name coming back from the PATTERNS table is by construction a named one.
for name, text in v["must_fire"].items():
    named = [t for t, p in scrub.PATTERNS if p.search(text)]
    if not named:
        bad.append("scrub.py has no NAMED rule for: %s (the entropy backstop may "
                   "still redact it, but the owner sees no vendor name)" % name)

for b in bad:
    print("   " + b, file=sys.stderr)
sys.exit(1 if bad else 0)
'
if ! python3 -c "$VENDOR_PROBES"; then
    FAILED="${FAILED}VENDOR: the secret rules disagree with fixtures/vendor_probes.json or fixtures/secret_probes.json\n"
else
    echo "   secret probes: preflight and scrub agree with fixtures/vendor_probes.json and fixtures/secret_probes.json"
fi

# ---- ROW-149: homoglyphs in the credential keywords ----
#
# CREDENTIAL_ASSIGN spelled the long s (U+017F) and the Kelvin sign (U+212A) in
# none of its keywords, so `ſecret`, `paſſphrase`, `toKen` and `Key` with a
# Kelvin sign walked past both tools. The classes now carry both characters,
# like the password rule does, in all three canonical copies and the generated
# spec row. The five vectors that used to live in an interim block here (a
# Kelvin sign in token, in _key, in camel Key; a long s in secret, in
# passphrase) are now must_fire probes in fixtures/secret_probes.json, read by
# both engines, so this file no longer needs its own probe: the VENDOR_PROBES
# check above and web/tools/parity.mjs cover the same ground the interim block
# did. See record/findings/row-149-a-rule-change-cannot-be-split-by-engine.md.

# ---- The deny list names the files this tool leaves behind, ROW-131 item 2 ----
#
# scripts/publish.py writes <name>-passport.link.md beside the passport, holding
# the delete token twice: bare, and inside the management URL. That token is the
# only thing that can withdraw a published passport and it cannot be reissued.
#
# The deny list in SKILL.md is prose read by a model, so this cannot assert that
# the file is never read. What it CAN assert is that the three names are still
# named, because the failure that actually happened was that they were never
# there: none of *token*, *secret*, .env* or credentials* matches
# "daily-brief-passport.link.md", so a second capture of a folder already
# captured could put the previous passport's delete token in the new one.
#
# A weak check on the right line beats a strong check on nothing. If somebody
# tidies these three out of the list, this says so.
DENY_LIST='
import re, sys
skill = open("../skills/agent-passport/SKILL.md", encoding="utf-8").read()
m = re.search(r"\*\*Deny list, checked before any read:\*\*(.*?)\n", skill)
if not m:
    print("   the deny list paragraph is gone from SKILL.md", file=sys.stderr); sys.exit(1)
line = m.group(1)
missing = [g for g in ("*-passport.link.md", "*-passport.md", "corrections.tsv",
                       ".env*", "credentials*", "*token*", "*secret*", "*.pem", "*.key")
           if g not in line]
if missing:
    print("   the deny list no longer names: %s" % ", ".join(missing), file=sys.stderr)
    sys.exit(1)
print("   deny list names all 9 globs, including this tool own leavings")
'
if ! python3 -c "$DENY_LIST"; then
    FAILED="${FAILED}DENY: SKILL.md deny list lost a glob\n"
fi

# ---- Main's arm stays a strict superset trigger, ROW-131 ----
#
# WHAT THIS ASSERTS. PASSWORD_ASSIGN is a union of two arms. The prefix arm
# reads glued names (db_password, smtpPass) and applies about a dozen
# exclusions to the VALUE. Main's arm is the bare keyword with no exclusions at
# all. This asserts the property the union relies on: everything the bare-keyword
# rule matches, the shipped rule also matches, and over a span that contains it.
#
# WHY IT EXISTS, AND IT IS NOT A HYPOTHETICAL. A critic pass built the
# counterexample the rest of the suite cannot see. One value-side exclusion,
#
#     do not fire on a padded base64 blob, because that is a key and not a
#     password, and reporting it twice sends the reader to the wrong remediation
#
# inserted in the prefix arm AND in main s arm, in all four canonical copies. It
# is not a strawman: it is the argument this repository already makes for
# vendor-prefixed keys. On that tree, run_tests.sh printed ALL TESTS PASSED, the
# JS suites printed 99/99 and 69/69, parity and build were green, and
#
#     DB_PASSWORD=UvImZaYMEtKJGA==     scrub report EMPTY, preflight ACCEPTS
#     password=UvImZaYMEtKJGA==        scrub report EMPTY, preflight ACCEPTS
#     db_password=kJ8s2mQvXz9pLwQ=     scrub report EMPTY, preflight ACCEPTS
#
# Those values are openssl rand -base64 output, which is an ordinary way to make
# a password. PASSWORD_ASSIGN is the only rule in PATTERNS that fires on them, so
# nothing picks up the slack: the owner is told the passport is clean.
#
# WHY THE PROBE FILES DO NOT STOP IT. Every must_fire value is short, outside the
# base64 alphabet, or unpadded; nothing in the set carries a trailing =. The
# known_false_positives group defends exactly one direction, a maintainer
# re-excluding a pinned structural shape. It says nothing about a NEW value-side
# exclusion, which is the shape of every fix this rule will ever attract.
#
# WHY IT IS ONE ASSERTION AND NOT A PILE OF PROBES. Two probes with padded base64
# values would kill that one exploit and not the class. This kills the class,
# because a value-side exclusion cannot narrow either reference without being
# caught here.
#
# WHY THERE ARE TWO REFERENCES, WHICH THE FIRST VERSION OF THIS TEST GOT WRONG.
# The first version carried only the pre-union bare-keyword rule, and that rule
# fires only on a BARE keyword. So it said nothing whatever about db_password,
# DB_PASSWORD or smtp_pass, which is the region this issue was filed about.
# Built and measured rather than reasoned about: the same padded-base64 exclusion
# put in the prefix arm ALONE, in all three canonical copies with the spec 5.2
# row regenerated, passed EVERY gate in this repository green, Python suite,
# parity, 99/99 and 69/69, while
#
#     DB_PASSWORD=UvImZaYMEtKJGA==   preflight ACCEPTS, scrub report EMPTY
#     db_password=kJ8s2mQvXz9pLwQ=   preflight ACCEPTS, scrub report EMPTY
#     smtp_pass: aB3xY9zQwErTyU==    preflight ACCEPTS, scrub report EMPTY
#
# The frozen baseline in fixtures/password_rule_baseline.json is what closes
# that, and the corpus below grew glued keys in the same breath, because a second
# reference over a bare-only corpus would have been the same hole again.
#
# METHOD LIMIT, MEASURED RATHER THAN ASSUMED, AND THE TWO HALVES FAIL
# DIFFERENTLY. Nine sibling exclusions written to imitate the real ones (padded
# base64, 32-plus hex, uuid, jwt, hyphenated word run, a minimum length, a
# no-symbols class, a non-ASCII class, a maximum length), each tried in the
# prefix arm alone and in both arms, so eighteen placements. All eighteen are
# caught as this file stands. But they are caught by different halves and the
# distinction is the whole point:
#
#   Both-arms placements, 9 of 9, are caught by the STRUCTURAL check below,
#   which compares text and therefore does not care what the corpus contains.
#
#   Prefix-arm-only placements have no structural protection at all and rest
#   entirely on corpus coverage. There the probe files ALONE catch 2 of 9. They
#   miss base64, hex, uuid, jwt, non-ASCII and over-length, which is to say they
#   miss every machine-generated high-entropy shape, which is to say they miss
#   real passwords. With the 8,000 generated values it is 9 of 9.
#
# THE DIMENSION, WHICH IS THE PART THAT KEEPS BEING WRONG. Twice now this test
# has been refuted by a narrowing keyed on something the corpus held CONSTANT
# rather than something it varied. First the alphabet: every value was printable
# ASCII, so (?!\S*[^\x00-\x7F]) was invisible. Then the left context: every
# string began at the key, so (?<!# ) was invisible. Both times the seven or nine
# siblings that had been "caught" were points inside the dimension already being
# varied, which measures the generator and not the rule.
#
# The rule reads four regions: LEFT CONTEXT, KEY, SEPARATOR, VALUE. All four are
# varied below, and the enumeration is the defence rather than the count of
# probes. Unlike alphabets, the regions are finite and readable off the pattern,
# so the honest instruction to the next person is: before claiming this covers a
# class, read the rule, list what it reads, and check the corpus varies each one.
# If you narrow the prefix arm on a region this corpus holds constant, the suite
# will pass, and it will not merely be silent, it will print full coverage at
# you. That happened, and it is why the lookaround census below exists as a
# second, corpus-independent check on the prefix arm.
#
# If you narrow this rule in a way you believe is safe, add the shape you are
# excluding to the corpus and let the suite tell you what else it takes with it.
#
# WHAT THIS STILL CANNOT DO, corrected after a critic refuted the previous
# version of this paragraph with artefacts rather than argument.
#
# The paragraph used to say the fixture "converts a silent narrowing into a
# visible line in a diff". That is FALSE and the counterexamples exist: two
# narrowings that release real passwords, pass every gate, and never touch
# fixtures/password_rule_baseline.json at all. A reviewer reading either diff
# sees scrub.py, preflight.py, the skills copies, _validate.mjs and the spec row,
# and no fixture line.
#
# The true statement is narrower and still worth something. The fixture becomes
# visible in a diff only when the CORPUS witnesses the narrowing. It is not an
# independent line of defence sitting behind the corpus; it is the same defence
# reached through a different door, and its coverage is the corpus coverage. What
# it adds is that a WITNESSED narrowing cannot be made green by any other edit:
# this file is the only thing a maintainer can touch to silence it, and that edit
# is loud in review.
#
# It does not prevent a narrowing and nobody may cite it as prevention.
#
# On whether it will just be regenerated reflexively, which is the obvious
# objection and was mine: the spec 5.2 table is a MIRROR, it has no independent
# content, regenerating it is definitionally correct, and that is exactly why it
# gets regenerated without a thought. This file is a BASELINE, and regenerating
# it destroys the only thing it holds. Different objects, and the note inside it
# says which one it is.
#
# ONE COPY IS ENOUGH, AND HERE IS WHY. parity.mjs compares the SOURCE of this
# rule across scrub.py, preflight.py and web/lib/_validate.mjs and fails on any
# drift, so a change that breaks the property in one copy cannot reach the others
# without this going red first. The first reference is compiled with Python re.I,
# which folds U+017F to s; V8 /i does not. So the Python side is the stricter
# reference of the two and a JS twin of this test would assert less.
SUPERSET='
import importlib.util, json, re, random, sys

spec = importlib.util.spec_from_file_location("scrubmod", "scrub.py")
scrub = importlib.util.module_from_spec(spec); spec.loader.exec_module(scrub)
SHIPPED = dict(scrub.PATTERNS)["PASSWORD_ASSIGN"]

# TWO REFERENCES, AND THEY COVER DIFFERENT REGIONS.
#
# The first is the rule that shipped before the union, verbatim. Do not
# "modernise" this line to match the shipped rule: it is here to be the older,
# wider trigger, and rewriting it to agree makes the test vacuous. It can never
# be legitimately relaxed, because it is a historical floor rather than a
# choice: it is what this tool already refused before anyone touched it.
#
# The second is the shipped rule itself, frozen in a fixture. It exists because
# the first one only fires on a BARE keyword and therefore says nothing about
# db_password, DB_PASSWORD or smtp_pass, which is the region the whole issue was
# filed about. That gap is not theoretical: an exclusion inserted in the prefix
# arm ALONE, in all three canonical copies with the spec table regenerated, took
# the entire gate set green while preflight accepted DB_PASSWORD= followed by a
# padded base64 value and the scrub report came back empty.
REFERENCES = [
    ("the pre-union bare-keyword rule",
     re.compile(r"\b(?:password|passwd|pwd)\s*[:=]\s*\S+", re.I),
     "It is a historical floor. It cannot be relaxed, only violated."),
    ("the frozen baseline in fixtures/password_rule_baseline.json",
     re.compile(json.load(open("fixtures/password_rule_baseline.json",
                               encoding="utf-8"))["pattern"]),
     "If you MEANT to release these, update that fixture in this same commit "
     "and say in the message what is now released and why that is safe."),
]

corpus = []
for f in ("fixtures/vendor_probes.json", "fixtures/secret_probes.json"):
    d = json.load(open(f, encoding="utf-8"))
    for group in ("must_fire", "must_not_fire", "known_false_positives"):
        for name, text in d.get(group, {}).items():
            if not name.startswith("_"):
                corpus.append((f + " " + group + " " + name, text))
for i, line in enumerate(open("fixtures/scrub_false_positives.md", encoding="utf-8")):
    corpus.append(("scrub_false_positives.md line %d" % (i + 1), line.rstrip("\n")))

# Seeded, so a failure here is reproducible by re-running rather than by luck.
rnd = random.Random(20260903)
ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
SYM = "!@#$%^&*()-_=+[]{}|;:,.<>?/~`"
HEX = "0123456789abcdef"
WORDS = ["correct", "horse", "battery", "staple", "otter", "kettle", "amber",
         "lantern", "quartz", "tumble"]
def hx(n): return "".join(rnd.choice(HEX) for _ in range(n))
def gen_b64():
    s = "".join(rnd.choice(ALNUM + "+/") for _ in range(rnd.choice((14, 16, 20, 24))))
    return s + "=" * ((4 - len(s) % 4) % 4)
def gen_sym():   return "".join(rnd.choice(ALNUM + SYM) for _ in range(rnd.randint(12, 24)))
def gen_alnum(): return "".join(rnd.choice(ALNUM) for _ in range(rnd.randint(8, 20)))
def gen_words(): return "-".join(rnd.sample(WORDS, 4))
def gen_dotted(): return ".".join(rnd.sample(WORDS, 3))
def gen_hex():   return hx(rnd.choice((32, 40, 64)))
def gen_uuid():  return "%s-%s-%s-%s-%s" % (hx(8), hx(4), hx(4), hx(4), hx(12))
def gen_jwt():
    seg = lambda n: "".join(rnd.choice(ALNUM + "-_") for _ in range(n))
    return "eyJ" + seg(20) + "." + seg(30) + "." + seg(43)
def gen_short():     return "".join(rnd.choice(ALNUM) for _ in range(rnd.randint(3, 7)))
def gen_printable(): return "".join(rnd.choice("".join(chr(c) for c in range(33, 127)))
                                    for _ in range(rnd.randint(3, 40)))
# NON-ASCII AND OVER-LENGTH VALUES, and these are not decoration either. A critic
# refuted the first version of this test with one lookahead, (?!\S*[^\x00-\x7F]),
# argued as "a value carrying non-ASCII is prose, not a credential; it fired on a
# German README". It released password=S<o-umlaut>mmer2026!Xk on a BARE keyword,
# with an empty scrub report and preflight accepting, and passed every gate in
# this repository including this test. The reason it passed is that every
# generator above draws from printable ASCII, so the assertion had the strength
# of its alphabet and nothing more. The two adjacent blind spots the critic named
# without needing to build them were value length above 98, which was the longest
# generated value, and any class over characters outside 0x21 to 0x7E. Both are
# closed below. This is a sample of the property and not the property; the
# structural check further down is the part that does not depend on the alphabet.
LATIN1 = "\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df\u00e9\u00e8\u00ea\u00f1\u00e5\u00f8"
CYRILLIC = "\u0430\u0431\u0432\u0433\u0434\u0435\u0436\u0437\u0438\u043a"
CJK = "\u5bc6\u7801\u4e0a\u6d77\u5317\u4eac\u6f22\u5b57"
def gen_latin1():
    return "".join(rnd.choice(ALNUM + LATIN1) for _ in range(rnd.randint(8, 20)))
def gen_cyrillic():
    return "".join(rnd.choice(ALNUM + CYRILLIC) for _ in range(rnd.randint(8, 20)))
def gen_cjk():
    return "".join(rnd.choice(ALNUM + CJK) for _ in range(rnd.randint(6, 16)))
def gen_astral():
    return "".join(rnd.choice(ALNUM + "\U0001f511\U0001f512\U0001f9e9") for _ in range(rnd.randint(6, 16)))
def gen_long():
    return "".join(rnd.choice(ALNUM + SYM) for _ in range(rnd.randint(100, 400)))
def gen_long_ascii_run():
    return "".join(rnd.choice(ALNUM) for _ in range(rnd.randint(120, 300)))
GENS = (gen_b64, gen_sym, gen_alnum, gen_words, gen_dotted, gen_hex, gen_uuid,
        gen_jwt, gen_short, gen_printable, gen_latin1, gen_cyrillic, gen_cjk,
        gen_astral, gen_long, gen_long_ascii_run)
# Bare spellings first, which is the region the pre-union rule decides.
# paſsword carries U+017F, which Python re.I folds and V8 /i does not; it is
# here so that reference stays the stricter of the two engines.
#
# Then the GLUED spellings, which the pre-union rule cannot see at all because
# \b does not fire between two word characters. Only the frozen baseline
# decides these, and they are the shapes the issue was actually filed about, so
# a corpus without them lets a prefix-arm narrowing through.
KEYS = ["password", "PASSWORD", "Password", "passwd", "PASSWD", "pwd", "PWD",
        "paſsword", "mail.smtp.password", "my-password",
        "db_password", "DB_PASSWORD", "dbPassword", "MYSQL_ROOT_PASSWORD",
        "SMTP_PASSWD", "smtp_passwd", "mysql_passwd", "smtp_pwd", "dbPasswd",
        "PGPASSWORD", "x_password", "api.db_password"]
# THE RULE READS FOUR REGIONS AND THE CORPUS MUST VARY ALL FOUR. Left context,
# key, separator, value. The first two versions of this corpus varied key,
# separator and value, and never varied left context at all: every string began
# at the key. A critic walked through that hole with ONE fixed-width lookbehind
# in the prefix arm,
#
#     (?<!# )     "a commented-out line is documentation, not live config;
#                  it fired on every # DB_PASSWORD=changeme in a README"
#
# which released `# db_password=S3cr3tPassw0rd` and `# DB_PASSWORD=Tr!ckyP4ss`
# with preflight accepting, and passed every gate. The second of those is this
# suite own must_fire probe with two characters put in front of it. And the
# assertion did not merely miss it: it printed both references at full coverage
# and the structural check green, which is worse than silence.
#
# A commented-out credential is not an edge case. The old password somebody
# commented out instead of deleting is still the old password.
#
# SEPS grew a tab, a backtick and a single quote for the same reason: the prefix
# arm supports all three and the corpus used none, so a narrowing keyed on any
# of them was invisible. db_password:<tab>value is an ordinary .properties line.
LEFTS = ["", "# ", "  # ", "; ", "// ", "export ", "- ", "  - ", "| ", "  ",
         "\t", "  \"", "if (a."]
SEPS = [": ", "=", " = ", ":", chr(34) + ": " + chr(34), "  :  ",
        ":\t", "=\t", " = `", "=" + chr(39), ":\n  "]
RIGHTS = ["", " # comment", ",", ";", "  // trailing", " )", chr(34) + ","]
for _ in range(8000):
    corpus.append(("generated", rnd.choice(LEFTS) + rnd.choice(KEYS)
                   + rnd.choice(SEPS) + rnd.choice(GENS)() + rnd.choice(RIGHTS)))

failed = False
vacuous = []

# ---- The structural half, which does not depend on the corpus at all --------
#
# The two references above are corpus tests wearing the clothes of a property
# test: their strength is exactly the alphabet the generators draw from, and a
# narrowing keyed on anything outside it is invisible to them. That is not a
# theory, it is how the first version of this test was refuted.
#
# This assertion is about the TEXT of the rule instead. Main s arm is the final
# alternation branch and it is kept verbatim inside the union; if it is still
# there, character for character, then nothing has been inserted into it, and no
# choice of alphabet can hide an insertion from a string comparison.
#
# THE EXACT LIMIT, IN ONE SENTENCE, because the previous version of this comment
# overclaimed it: endswith proves the branch is PRESENT, never that it is
# REACHABLE. Reachability is decided by text placed BEFORE the branch, and
# endswith reads only the tail. A critic demonstrated both halves on the merged
# tree: the same (?<!# ) moved out to gate the whole union leaves this assertion
# returning True while main s arm is dead on any commented line, and a leading
# lookahead can make the branch unreachable everywhere with the text still
# character-for-character intact.
#
# It is kept anyway. It costs one line, has zero false-positive risk, and does
# close the class it was built for, an insertion INSIDE the arm, which was the
# original exploit shape. Do not widen the claim past that.
#
# The prefix arm has no structural protection of this kind at all and rests on
# the lookaround census below plus corpus coverage above.
BASELINE = json.load(open("fixtures/password_rule_baseline.json", encoding="utf-8"))
ARM = BASELINE["main_arm"]

# The count of each lookaround form, frozen. Every narrowing built against this
# rule, in two critic passes, added at least one lookaround; that is what a
# value-side or context-side exclusion IS. Four integers rather than the prefix
# arm source, because the prefix arm is the arm that legitimately changes and a
# baseline regenerated every few weeks stops being read. Known hole, stated
# rather than left to be found: this fails open if somebody REPLACES one
# lookaround with a different one of the same form.
want = BASELINE["lookaround_counts"]
got = {k: SHIPPED.pattern.count(k) for k in want}
if got != want:
    added = [k for k in want if got[k] > want[k]]
    print("   the lookaround census of PASSWORD_ASSIGN changed: %s (was %s). %s"
          % (got, want, "An ADDED lookaround is how every narrowing of this rule "
             "has been written, so treat this as a narrowing until you have shown "
             "otherwise." if added else "Removing one is usually a widening, which "
             "is safe, but say so."), file=sys.stderr)
    print("   If it is intended, update lookaround_counts in "
          "fixtures/password_rule_baseline.json in this same commit.",
          file=sys.stderr)
    failed = True
if not SHIPPED.pattern.endswith(ARM):
    print("   the bare-keyword arm is no longer the intact final branch of "
          "PASSWORD_ASSIGN. Something was inserted into it, or it was moved or "
          "rewritten. That arm is what backstops every value-side exclusion in "
          "the prefix arm: narrow it and real passwords publish with an empty "
          "scrub report. Expected the pattern to end with:", file=sys.stderr)
    print("     %s" % ARM, file=sys.stderr)
    print("   If you MEANT to change that arm, update main_arm in "
          "fixtures/password_rule_baseline.json in this same commit and say in "
          "the message what is now released.", file=sys.stderr)
    failed = True

counts = []
for label, REF, remedy in REFERENCES:
    released, narrowed = [], []
    covered = 0
    for name, text in corpus:
        # EVERY reference match, not just the first. The first version of this
        # used REF.search and a critic pointed out what that actually asserts:
        # on `password=aaa1 password=Sommer2026x` search returns only (0,13),
        # so a narrowing that released the SECOND assignment and kept the first
        # would pass. No corpus string has two matches today, so it cost
        # nothing, but "the first match is covered" is not the property anyone
        # thinks they are reading, and the corpus is not fixed forever.
        hits = None
        for m in REF.finditer(text):
            covered += 1
            if hits is None:
                hits = [h.span() for h in SHIPPED.finditer(text)]
            # Covered means SOME shipped match contains this reference match.
            if not any(a <= m.start() and b >= m.end() for a, b in hits):
                if hits:
                    narrowed.append((name, text, m.span(), hits[0]))
                else:
                    released.append((name, text))

    # A reference that never fires proves nothing and looks exactly like a pass.
    if not covered:
        print("   %s triggered 0 times over %d strings, so this reference "
              "asserted nothing. Fix the corpus, not the rule."
              % (label, len(corpus)), file=sys.stderr)
        # Distinguished from the coverage failure below, because the FAILED
        # summary line is what most people read and it used to say "stopped
        # covering the rule it replaced" here, which is the opposite of what
        # happened: nothing was asserted at all.
        vacuous.append(label)
        failed = True
        continue

    if released or narrowed:
        # EVIDENCE FIRST, REMEDY LAST, and the order is deliberate. The previous
        # version concatenated the remedy into the headline, so the first
        # actionable instruction on screen was "update that fixture" and the
        # strings being released came after it. If you are worried about a
        # maintainer regenerating the baseline reflexively, printing the
        # regeneration instruction before the evidence is where you build that in.
        print("   PASSWORD_ASSIGN no longer covers %s. Every value-side exclusion "
              "in the prefix arm is safe only because something wider backstops "
              "it; narrow that and real passwords publish with an EMPTY scrub "
              "report. %d of %d triggering strings regressed. These are now "
              "released:" % (label, len(released) + len(narrowed), covered),
              file=sys.stderr)
        for name, text in released[:6]:
            print("     RELEASED  %s  %r" % (name, text[:90]), file=sys.stderr)
        for name, text, ms, hs in narrowed[:6]:
            print("     NARROWED  %s  %r  reference %s, shipped %s"
                  % (name, text[:90], ms, hs), file=sys.stderr)
        print("   Read those before deciding anything. %s" % remedy, file=sys.stderr)
        failed = True
    else:
        counts.append((label, covered))

if failed:
    # The shell reads the exit code of this script and prints one summary
    # line. Tell it which of the two failures happened, so that summary cannot
    # contradict the detail printed above it.
    print("VACUOUS" if vacuous else "REGRESSED", file=sys.stdout)
    sys.exit(1)

print("   superset: bare-keyword arm intact, lookaround census unchanged; %s"
      % ", ".join("%d strings trigger %s, all still caught" % (c, l)
                  for l, c in counts))
'
SUPERSET_OUT=$(python3 -c "$SUPERSET") || SUPERSET_RC=1
if [ "${SUPERSET_RC:-0}" = "1" ]; then
    if printf '%s' "$SUPERSET_OUT" | grep -q VACUOUS; then
        FAILED="${FAILED}SUPERSET: a reference rule matched nothing, so the superset property was not tested at all\n"
    else
        FAILED="${FAILED}SUPERSET: PASSWORD_ASSIGN stopped covering a rule it must cover\n"
    fi
else
    printf '%s\n' "$SUPERSET_OUT"
fi

# ---- The normative spec's secret table, ROW-108 ----
#
# site/spec/upload-validation.md section 5.2 lists the shapes the endpoint
# refuses, and web/lib/_validate.mjs names that document as its normative source
# in its own header. Nothing compared the two, and on 2026-08-31 the table was
# found carrying ten rows against thirteen live rules: a database URL carrying a
# password, a SendGrid key and a credential assignment had been missing since
# 08-18, and the URL row still printed the scheme-tied form abandoned on 08-30.
#
# The part worth keeping in mind rather than just fixing: web/tools/run-tests.mjs
# has compared the STATUS CODE table in that same document against MESSAGES all
# along, and its comment says that pair drifted too. So a working model of this
# check sat twelve lines from the table that went thirteen days unguarded. A
# guard next to a thing is not a guard on it.
#
# Compared by PATTERN and not only by name, for the reason written in
# web/tools/parity.mjs: two tables can hold the same rule name over different
# regexes and report agreement. --dump-secret-rules already existed for exactly
# that comparison; this reuses it against a document instead of against code.
SPEC_TABLE='
import json, re, subprocess, sys

dump = json.loads(subprocess.run(
    [sys.executable, "preflight.py", "--dump-secret-rules"],
    capture_output=True, text=True).stdout)

doc = open("../site/spec/upload-validation.md", encoding="utf-8").read()
m = re.search(r"<!-- secret-table:begin.*?-->\n\n(.*?)\n\n<!-- secret-table:end -->",
              doc, re.S)
if not m:
    print("   the generated secret-table block is gone from upload-validation.md; "
          "section 5.2 is no longer machine-checked", file=sys.stderr)
    sys.exit(1)

rows = {}
for line in m.group(1).split("\n")[2:]:            # skip header and separator
    cells = line.split(" | ")
    if len(cells) != 2: continue
    name = cells[0].lstrip("| ").strip()
    pat = cells[1].rstrip(" |").strip().strip("`").replace("\\|", "|")
    rows[name] = pat

bad = []
for name in dump:
    if name not in rows:
        bad.append("rule %r is live and the normative spec does not list it" % name)
    elif rows[name] != dump[name]["source"]:
        bad.append("rule %r has a different pattern in the spec than in the code" % name)
for name in rows:
    if name not in dump:
        bad.append("the spec lists %r, which is not a live rule" % name)

for b in bad:
    print("   " + b, file=sys.stderr)
print("   regenerate with the block comment in that file, do not hand-edit a row",
      file=sys.stderr) if bad else None
sys.exit(1 if bad else 0)
'
if ! python3 -c "$SPEC_TABLE"; then
    FAILED="${FAILED}SPEC: site/spec/upload-validation.md 5.2 disagrees with the live secret rules\n"
else
    echo "   spec 5.2 lists exactly the live secret rules, compared by pattern"
fi

# ---- preflight.py's own size gate, run as the CLI the skill actually calls ----
#
# ROW-142 (1b47ab8) fixed preflight.py printing "the upload endpoint will accept
# this passport's content" on a file over MAX_BYTES, which the endpoint refuses
# outright. Every other test in this file imports preflight as a module and
# calls .check() directly, so the CLI's E_TOO_LARGE branch in main() -- the one
# ROW-142 added -- has never run under this suite in either output mode.
SIZE_GATE='
import subprocess, sys, os, tempfile
d = tempfile.mkdtemp()
p = os.path.join(d, "oversized-passport.md")
open(p, "wb").write(b"x" * (262144 + 1))

bad = []
r = subprocess.run([sys.executable, "preflight.py", p], capture_output=True, text=True)
if r.returncode != 1:
    bad.append("plain mode: exit %d, want 1" % r.returncode)
if "E_TOO_LARGE" not in r.stderr:
    bad.append("plain mode: E_TOO_LARGE not in stderr: %r" % r.stderr[:200])

r = subprocess.run([sys.executable, "preflight.py", "--codes", p], capture_output=True, text=True)
if r.returncode != 1:
    bad.append("--codes mode: exit %d, want 1" % r.returncode)
if r.stdout.strip() != "E_TOO_LARGE":
    bad.append("--codes mode: stdout was %r, want just E_TOO_LARGE" % r.stdout)

for b in bad:
    print("   " + b, file=sys.stderr)
sys.exit(1 if bad else 0)
'
if ! python3 -c "$SIZE_GATE"; then
    FAILED="${FAILED}PREFLIGHT: the CLI E_TOO_LARGE size gate (ROW-142) is not what it was verified to be\n"
else
    echo "   preflight.py CLI refuses a >262144-byte file with E_TOO_LARGE, plain and --codes"
fi

# ---- Test 13: the two copies of the denied-path check agree ----
#
# scripts/assemble.py carries its own FORBIDDEN list and its own
# normalize_forbidden, because in the built skill it sits beside validate.py and
# in this repository it does not, so neither file can import the other without a
# sys.path trick nobody wants. Its whole job is to predict validate.py check 9
# on the passport it is about to assemble, so a disagreement is worse than no
# check: it either waves through installer text that check 9 will refuse, or
# refuses text that would have been fine and blocks a build for nothing.
#
# Nothing pinned them before. The lists were identical by luck and by both
# having been typed once.
FORBIDDEN_PARITY='
import sys, importlib.util
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m
v = load("v", "validate.py")
a = load("a", "../scripts/assemble.py")
bad = []
if list(v.FORBIDDEN_STRINGS) != list(a.FORBIDDEN):
    bad.append("the two denied-path lists differ: %r vs %r"
               % (v.FORBIDDEN_STRINGS, a.FORBIDDEN))

# Both directions, on the shapes that motivated the normalisation and on the
# shapes that must never fire. A copy that agrees on the list and disagrees on
# the folding is the same defect one layer down.
PROBES = [
    ("reads from Credentials/ every run", True),
    ("the ID_RSA file", True),
    ("the id\\_rsa key", True),
    ("reads from creden\ntials/ nightly", True),
    ("the id`_`rsa key", True),
    ("cre**den**tials/ every morning", True),
    ("it read from secret\u017f/ every run", True),
    ("reads Credentials\uff0fnotes", True),
    ("you grant credentials yourself on your own platform", False),
    ("it never reads secrets from the environment", False),
    ("capture never opens your browser profile", False),
    ("the run is done.\nPemberton was the source", False),
    ("access: credentialed", False),
]
for text, should_hit in PROBES:
    for mod, label in ((v, "validate.py"), (a, "assemble.py")):
        words = mod.FORBIDDEN_STRINGS if label == "validate.py" else mod.FORBIDDEN
        norm = mod.normalize_forbidden(text)
        hit = any(mod.normalize_forbidden(w) in norm for w in words)
        if hit != should_hit:
            bad.append("%s %s %r" % (label,
                                     "missed" if should_hit else "fired on",
                                     text))
for b in bad:
    print(b, file=sys.stderr)
sys.exit(1 if bad else 0)
'
if ! python3 -c "$FORBIDDEN_PARITY"; then
    FAILED="${FAILED}FORBIDDEN: assemble.py and validate.py disagree about denied paths\n"
fi

# ---- Test 14: the envelope floor refuses all three of its shapes ----
#
# Test 14 probes CHECK 16. The test number and the check number diverged on
# 2026-09-04 when the floor was renumbered off the fidelity check's 14
# (ROW-157); the test kept its slot so the record's references to it hold.
#
# Spec section 5 said "declared only" in prose for the whole of v0.1 and nothing
# executed it, so a passport could declare envelope: read-notify and mark
# email.send installable and pass every gate. The rule is three checks because
# the format gives an id three different amounts of context, and each fixture
# below trips exactly one of them. Deleting any one check leaves a hole that was
# tested open before it was closed; the fixture that goes green on its own is
# the proof the other two do not cover it.
ENVELOPE_FLOOR='
import subprocess, sys, os
py = sys.executable
# Each fixture names the BRANCH it must trip, not just "check 16". Seven
# fixtures across four branches, so the old "exactly one FAIL 16" assertion
# could not tell in_inputs from no_declared_row: both trip the arithmetic
# branch and print a byte-identical message, while the table claimed they
# isolated different things. Asserting the branch is what makes the third
# column an assertion rather than a label.
STATUS_WRONG = "writes to the world, so the read-notify envelope"
STATUS_ABSENT = "carries no"
ROW = "consent row"
# The phrase the opaque refusal is recognised by. It said "characters
# outside plain ASCII" until ROW-167 narrowed the rule from "anything
# non-printable-ASCII" to "an id spelled with the wrong characters",
# at which point the old phrase was no longer what the message said or
# what the rule did.
OPAQUE = "spelled with a lookalike character"
ARITHMETIC = "the functional spec declares"

CASES = [
    ("invalid_envelope_status_used.md",     STATUS_WRONG,  "status: used on a write id"),
    ("invalid_envelope_no_status.md",       STATUS_ABSENT, "a write id whose entry carries no status at all"),
    ("invalid_envelope_installable_row.md", ROW,           "a backticked write id in an installable row"),
    ("invalid_envelope_money_declared.md",  ROW,           "a declared money capability backticked in an installable row"),
    ("invalid_envelope_money_undeclared.md", ROW,          "an UNDECLARED money capability backticked in an installable row (ROW-158)"),
    ("invalid_envelope_spaced_token.md",    ROW,           "a write id with a trailing space inside the backticks"),
    ("invalid_envelope_upper_prefix.md",    ROW,           "a money id spelled with a capital letter"),
    ("invalid_envelope_homoglyph.md",       OPAQUE,        "a money id with a Cyrillic o, refused as opaque"),
    ("invalid_envelope_odd_backticks.md",   ROW,           "a write id behind a stray third backtick"),
    ("invalid_envelope_double_backtick_span.md", ROW,      "a money id inside a double-backtick span"),
    ("invalid_envelope_bom_token.md",       OPAQUE,        "a filename token followed by a BOM, refused as opaque"),
    ("invalid_envelope_second_token.md",    ROW,           "a write id as the SECOND backticked token in a cell"),
    ("invalid_envelope_no_declared_row.md", ARITHMETIC,    "a write id declared with no declared-only row"),
    ("invalid_envelope_in_inputs.md",       ARITHMETIC,    "a write id declared under inputs rather than capabilities"),
    # ROW-211, five documents that hide a declaration behind a character only ONE
    # of the two runtimes calls whitespace. Each of these was refused by exactly
    # one gate before the alphabet was pinned, and on invalid_envelope_bom_fence
    # the PERMISSIVE side was the public one: the site accepted it, derived
    # "Mail the digest to the subscriber list, installable: true", and stored it.
    # The first three hide it in the INDENT of a declaration; the last two hide a
    # whole second fenced block behind a delimiter one runtime sees and the other
    # does not. They are here rather than only in test 18 because test 18 pins
    # the classes and these pin what the classes are FOR.
    ("invalid_envelope_ws_fs.md",     ARITHMETIC, "a declaration indented with \\x1c, which only Python called whitespace"),
    ("invalid_envelope_ws_nel.md",    ARITHMETIC, "the same with \\x85"),
    ("invalid_envelope_ws_bom.md",    ARITHMETIC, "the same with \\ufeff, which only JavaScript called whitespace"),
    ("invalid_envelope_bom_fence.md", ARITHMETIC, "a second fenced block opened by \\ufeff```, which the site read as a fence and this file did not"),
    ("invalid_envelope_fs_fence.md",  ARITHMETIC, "the mirror image, \\x1c```, which this file read as a fence and the site did not"),
    # AND THE SAME ALPHABET IN A HEADING, which is a third place and the one I
    # missed. `##\\ufeffExtra` is a heading to JavaScript and not to Python, so
    # section 3 ENDED IN A DIFFERENT PLACE in the two gates: the site never
    # reached the declaration below it, computed declaresWrite = false and
    # accepted a passport with every consent row saying yes, while this file
    # read on and refused. Neither gate had ever agreed about this, on main or
    # on any branch. Found by a critic on 2026-09-07 against a commit whose
    # claim was that no such document existed.
    ("invalid_envelope_bom_heading.md", ARITHMETIC, "a declaration below a heading only JavaScript recognised, \\ufeff after the hashes"),
    ("invalid_envelope_nel_heading.md", ARITHMETIC, "the mirror image, \\x85 after the hashes, which only Python recognised"),
    # AND THE CAPABILITIES BLOCK TERMINATOR, a fourth site and the worst one.
    # str.strip() and str.isspace() against .trim() and /^\\s/ decided where the
    # block ENDS, so 16a paired a different set of refs with a different set of
    # statuses in the two gates. invalid_envelope_caps_bom.md made
    # tools/validate.py, the NORMATIVE gate, the one the skill ships and the one
    # an owner runs before publishing, exit 0 on a functional spec reading
    # `\\ufeff- capability_ref: email.send` / `status: used`. preflight.check()
    # returned [] on it too. Product rule 2 is what the floor exists to hold and
    # the local loop did not hold it. Same on main: a hole neither gate closed.
    ("invalid_envelope_caps_bom.md", STATUS_WRONG, "a used write id behind \\ufeff, which ended the capabilities block for Python only"),
    ("invalid_envelope_caps_fs.md",  STATUS_WRONG, "the same with \\x1c, which ended it for JavaScript only"),
    ("invalid_envelope_caps_gs.md",  STATUS_WRONG, "the same with \\x1d"),
    ("invalid_envelope_caps_nel.md", STATUS_WRONG, "the same with \\x85"),
    # A THIRD FENCE INSIDE A FOURTH. The section opens ````, and a bare ```
    # inside it closes nothing under the length rule. A reader that toggles on
    # every delimiter believes the section ended there and stops seeing the YAML
    # below as YAML, which is where email.send at status: used sits. Built by a
    # critic against a committed fix on 2026-09-07; main refused it, the fix
    # accepted it. The two fence readers are held to one verdict by test 17; this
    # is the same defect as a whole document, because that is how it arrives.
    #
    # Said plainly: main refuses this too, so it does not discriminate the fix
    # from what came before it. It is a REGRESSION guard, and the regression it
    # guards was live in a committed fix for a few hours. A fixture that only
    # ever goes red for the fix that introduced it is still the cheapest way to
    # stop that fix coming back.
    ("invalid_envelope_fence_desync.md",    ARITHMETIC,    "a write id below a shorter fence nested inside a longer one"),
]
bad = []
for name, marker, why in CASES:
    path = os.path.join("fixtures/passports", name)
    r = subprocess.run([py, "validate.py", path], capture_output=True, text=True)
    if r.returncode == 0:
        bad.append("%s was accepted; it must be refused for %s" % (name, why))
        continue
    fails = [l for l in r.stdout.splitlines() if l.startswith("FAIL 16")]
    if len(fails) != 1:
        bad.append("%s tripped %d parts of check 16, expected exactly 1, so it "
                   "no longer isolates %s: %s" % (name, len(fails), why, fails))
    elif marker not in fails[0]:
        bad.append("%s tripped the WRONG branch of check 16. It exists to catch "
                   "%s, so its message should contain %r: %s"
                   % (name, why, marker, fails[0]))
# The positive control. A write capability described honestly, with a backticked
# id, must still pass: the floor refuses the claim that it installs, never the
# capability itself.
for ok, why in (("valid_declared_only_write.md",
                "an honestly declared write capability"),
               ("valid_money_filename.md",
                "a backticked FILENAME under the money prefix, which is not an id"),
               ("valid_prose_mentions_ref.md",
                "prose in section 3 naming a ref the passport does not declare"),
               ("valid_prose_ref_at_line_start.md",
                "an owner quoting a config line at the START of a line inside a "
                "tacit_notes block scalar (ROW-210). Anchoring the scan to a line "
                "start was the first repair and did not cover this; the content of "
                "a block scalar is prose and is not read at all"),
               ("valid_quoted_fence_in_tacit_notes.md",
                "the same owner, quoting a FENCED config block inside tacit_notes, "
                "which is what a person actually pastes. A version of the fix reset "
                "the open block on every fence-shaped line, on the premise that a "
                "fence cannot sit inside a scalar. A block scalar is text and "
                "backticks are text, so that premise reintroduced ROW-210 on its "
                "most likely input")):
    r = subprocess.run([py, "validate.py", "fixtures/passports/" + ok],
                       capture_output=True, text=True)
    if r.returncode != 0:
        bad.append("%s was refused: %s" % (why, (r.stdout + r.stderr).strip()[:200]))
for b in bad:
    print(b, file=sys.stderr)
sys.exit(1 if bad else 0)
'
if ! python3 -c "$ENVELOPE_FLOOR"; then
    FAILED="${FAILED}ENVELOPE: check 16 does not refuse what it claims to\n"
fi

# ---- Test 15: check 16's BRANCHES, probed rather than fixtured ----
#
# WHY THIS EXISTS, and it is the most useful thing in this file. A critic ran
# faithful reverts of six guards against the fixture suite above and ALL SIX
# PASSED: the money prefix deleted from is_declared_only, the money guard forced
# to always skip, and the all-backticks match reverted to first-only, in each of
# the two implementations. web/tools/parity.mjs could not see them either, since
# three were one-sided and no fixture carried the shape.
#
# The reason is structural and worth naming, because it decides how to test the
# next check. A FIXTURE asserts that some part of a check fired on a whole file.
# A PROBE asserts a specific verdict on a specific input. Branches inside a
# check are exactly where those two differ, and exactly where coverage was zero.
# Test 13 was already probe-shaped and caught every mutation aimed at it.
ENVELOPE_BRANCHES='
import os, re, subprocess, sys, importlib.util
spec = importlib.util.spec_from_file_location("v", "validate.py")
v = importlib.util.module_from_spec(spec); spec.loader.exec_module(v)
bad = []

# (token in a consent cell, refs declared in section 3, should the floor fire)
#
# Through consent_token_is_write_id(), the function check 16 itself calls, and
# not through a copy of its logic. Until 2026-09-04 this loop re-implemented
# the guard inline, so it probed what the test author thought the guard did
# and never the guard: forcing the real one to always skip left every probe
# here green (ROW-158). A probe that does not call the code is a comment.
PROBES = [
    ("`email.send`",        set(),                    True,  "a plain write id"),
    ("`money.transfer`",    {"money.transfer"},       True,  "a declared money id"),
    ("`money.transfer `",   {"money.transfer"},       True,  "a declared money id with stray space"),
    ("`money.transfer`",    set(),                    True,  "an UNDECLARED money id, the ROW-158 hole"),
    ("`money.pay`",         set(),                    True,  "an undeclared money id, another verb"),
    ("`money.transfer_v2`", set(),                    True,  "a money suffix that is not an extension"),
    ("`money.csv`",         set(),                    False, "a backticked filename, not an id"),
    ("`money.ods`",         set(),                    False, "a filename with another listed extension"),
    ("`money.CSV`",         set(),                    False, "an upper-case extension"),
    ("`money.transfer.csv`", set(),                   True,  "an id with an extension appended: the whole suffix is read, not the last segment"),
    ("`money.ledger.csv`",   set(),                    True,  "a two-segment ledger name, refused: the documented cost of reading the whole suffix"),
    ("`money.csv`",         {"money.csv"},            True,  "a DECLARED money.csv: declared wins over shape"),
    ("`MONEY.transfer`",    set(),                    True,  "a money id in capitals: ASCII case is folded"),
    ("`Email.Send`",        set(),                    True,  "a fixed write id in capitals"),
    ("`money.OFX`",         set(),                    False, "a financial interchange format, upper-case"),
    ("`files.read`",        set(),                    False, "an installable id"),
    ("`files.read` and `email.send`", set(),          True,  "a write id as the second token"),
]
import re
for cell, refs, should, why in PROBES:
    fired = False
    for token in (t.strip() for t in re.findall(r"`([^`]+)`", cell)):
        if v.consent_token_is_write_id(token, refs):
            fired = True
    if fired != should:
        bad.append("%s: %r with refs %r %s" % (
            why, cell, refs, "did not fire" if should else "fired and must not"))

# ROW-168: consent_cell_write_id(), the function check 16 now calls for each
# of the five cells. Two readings of one cell, and the probes below are here
# because a whole-file fixture cannot tell which of them fired.
#
# (cell text, refs declared in section 3, the id it must name or None, why)
CELL_PROBES = [
    ("`email.send now`",            set(), "email.send",     "a fixed write id with a word after it inside ONE span"),
    ("`run money.transfer now`",    set(), "money.transfer", "a money id with a word on each side inside one span"),
    ("`use ext.write here`",        set(), "ext.write",      "ext.write inside a multi-word span"),
    ("`money.transfer daily`",      set(), "money.transfer", "the prefix case, refused all along, and now named as the id and not as the four words around it"),
    ("`use email.send, here`",      set(), "email.send",     "sentence punctuation trimmed off a word before the id test"),
    ("`(email.send)`",              set(), "email.send",     "brackets trimmed off a one-word segment"),
    ("`email.send.`",               set(), "email.send",     "a full stop after the id"),
    ("`money.csv,`",                set(), "money.csv,",     "an honest ledger filename with a comma INSIDE the backticks: refused as written, and the union deliberately keeps that reading. The fix is to move the comma out"),
    ("`money.`",                    set(), "money.",         "the bare prefix: a write id as written, and its core is not, so the union is what keeps it refused"),
    ("`m\u043eney.transfe\u0433`",       set(), None,             "a lookalike on BOTH ends: the trim takes the Cyrillic r off the end and the Cyrillic o off the front, and `oney.transfe` is not the prefix. The opaque rule is what catches this one, and only in the Capability cell"),
    ("yes (via `money.transfer`)",  set(), "money.transfer", "the Installable cell shape: the fifth cell renders as <code> beside Granted"),
    ("the original used `email.send`", set(), "email.send",  "the Why cell shape"),
    ("nothing calls `ext.write`",   set(), "ext.write",      "the If-you-skip cell shape"),
    ("`files.read` and also `email.send`", set(), "email.send", "the second span, not the first"),
    ("the original used email.send", set(), None,            "BARE PROSE naming an id: the ROW-165 gap, open by design"),
    ("Move the fee via money.transfer now", set(), None,     "bare prose, several words, one of them an id"),
    ("Read `a.csv` und dann `b.csv`", set(), None,           "German prose between two spans is prose"),
    ("`money.csv`",                 set(), None,             "a filename"),
    ("`money.csv`",                 {"money.csv"}, "money.csv", "a DECLARED money.csv: declared wins over shape, here too"),
    ("Buchhaltungs\u00fcbersicht f\u00fchren (`files.read`)", set(), None, "an installable read row written in German"),
    ("plain prose with no backticks", set(), None,           "nothing at all"),
    ("",                            set(), None,             "an empty cell"),
]
for cell, refs, want, why in CELL_PROBES:
    got = v.consent_cell_write_id(cell, refs)
    if got != want:
        bad.append("%s: consent_cell_write_id(%r) = %r, want %r" % (why, cell, got, want))

# id_core: the ends only, never the interior. A lookalike or a zero-width
# space inside a word must survive to the opaque test, which is the test
# built for it; trimming it here would make the word an id and refuse a
# German filename as one.
# THE OPACITY SCAN TRIMS TOO, and until the ROW-167 critic it did not. The
# id scan trims with id_core and carries no lookalike test; the opacity scan
# carried the lookalike test and no trim. So a lookalike with ordinary
# sentence punctuation on either end was read by NEITHER, reached a Granted
# stamp through both gates, and had been refused by the printable-ASCII rule
# ROW-167 replaced. Two scans each carrying half of one reading: neither file
# was wrong on its own and the gap was between them.
for _tok in ["em\u0430il.send.", "em\u0430il.send,", "(em\u0430il.send)",
             "(m\u043eney.transfer)", "em\u0430il.send", "m\u043eney.transfer."]:
    if v.opaque_reading(_tok) is None:
        bad.append("opaque_reading(%r) found nothing: a lookalike with sentence "
                   "punctuation is read by neither scan" % _tok)
# The control in the other direction: trimming must not INVENT a lookalike.
for _tok in ["(\u041f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435.csv)",
             "B\u00fccher.csv,", "(2026\u2013Q1.csv)"]:
    if v.opaque_reading(_tok) is not None:
        bad.append("opaque_reading(%r) called an honest filename a lookalike" % _tok)

for word, want in [
    ("email.send", "email.send"), ("(email.send)", "email.send"),
    ("email.send,", "email.send"), ("\u201cemail.send\u201d", "email.send"),
    ("money.transfer#1", "money.transfer#1"), ("...", ""), ("()", ""), ("email.send.", "email.send"),
    ("", ""), ("Zahlungs\u00fcbersicht.csv", "Zahlungs\u00fcbersicht.csv"),
    ("m\u043eney.transfer", "m\u043eney.transfer"),
]:
    if v.id_core(word) != want:
        bad.append("id_core(%r) = %r, want %r" % (word, v.id_core(word), want))


# A SECOND BASE, whose changing row is INSTALLABLE. The declared-only base
# above cannot carry these: it holds exactly one row marked no, so turning
# that row installable fires part 16c (a passport declaring a write capability
# must show at least one row it will not install) and every probe below would
# be refused for a reason that is not the one being tested.
_ifx = open("fixtures/passports/valid_installable_row_nonascii_prose.md", encoding="utf-8").read()
_irow = "| Kontoführung: `files.read` genügt | the digest quotes the figures | required | the digest has no figures | yes (siehe `Zahlungsübersicht.csv`) |"
assert _irow in _ifx, "the installable probe base row moved"

# A PER-PROCESS PROBE PATH, AND A READ-BACK. These probes wrote to a fixed
# name in the shared system temp directory, and there are 75 worktrees on this
# repo, every one of which runs this suite. A second lane rewriting that file
# between the write and the read hands the validator a passport that is clean,
# which prints no FAIL 16 line, which the echo invariant reads as this payload
# does not offend in this cell and skips in silence. The census cannot see it:
# it needs one surviving hit per cell and one per branch, so a skipped case and
# a covered one look the same to it. Found by the ROW-167 critic, who
# demonstrated the mechanism rather than a lost run. The directory removes the
# collision and the read-back turns whatever window is left into a failure
# rather than a skip.
import tempfile as _tf
_PROBE_DIR = _tf.mkdtemp(prefix="passport_probe_")
_PROBE = os.path.join(_PROBE_DIR, "installable_probe.md")
_DPROBE = os.path.join(_PROBE_DIR, "declared_row_probe.md")

def _verdict(cells):
    _t = _ifx.replace(_irow, "| " + " | ".join(cells) + " |")
    with open(_PROBE, "w", encoding="utf-8") as f: f.write(_t)
    _r = subprocess.run([sys.executable, "validate.py", _PROBE],
                        capture_output=True, text=True)
    if open(_PROBE, encoding="utf-8").read() != _t:
        bad.append("the probe file changed while the validator read it: "
                   "another process is writing %s, so a silent skip in the "
                   "echo invariant is a lost case rather than an honest one"
                   % _PROBE)
    return _r

# THE FIVE CELLS, through the real validator, because consent_cell_write_id
# says nothing about which cells check 16 hands it. One cell at a time, the
# other four honest.
#
# The first version of this probe built its own table by inserting a second
# header and separator above the existing ones, which left the original
# separator standing as a data row of five "---" cells. That row fails CHECK
# 11, so every case here was refused whatever check 16 did, and the P1
# mutation (the loop reverted to cell 0) was killed by a red for the wrong
# reason. Replacing ONE ROW of a fixture that already parses is the version
# that measures the guard.
for _i, _payload in enumerate(["Read it (`email.send`)", "it used `email.send`",
                               "required (`email.send`)", "nothing calls `email.send`",
                               "yes (via `email.send`)"]):
    _cells = ["Read files in one folder", "there is nothing to summarise",
              "required", "the agent has no input", "yes"]
    _cells[_i] = _payload
    _r = _verdict(_cells)
    if _r.returncode == 0:
        bad.append("a write id in consent cell %d (%s) was accepted" % (_i, _payload))
    elif "FAIL 16" not in _r.stdout:
        bad.append("a write id in consent cell %d was refused by something other than check 16: %s"
                   % (_i, _r.stdout.strip()[:160]))
# The control for all five: the honest row itself must pass, or the five
# refusals above are measuring the substitution and not the guard.
_r = _verdict(["Read files in one folder", "there is nothing to summarise",
               "required", "the agent has no input", "yes"])
if _r.returncode != 0:
    bad.append("the five-cell probe base row was refused: %s" % _r.stdout.strip()[:160])

# THE INNER FLAG, pinned. Dropping `inner` from the opaque test opacity-tests
# prose that lies outside every backtick, and a Capability cell of
# "Kontoführung: `files.read` genügt" then refuses an honest installable row
# for the language it is written in. Found by critic-b against 1f509bd as a
# mutation with no probe behind it. The fixture written for it first carried
# German prose containing a SPACE, which the opaque rule carves out anyway, so
# the mutant survived the fixture too; ONE WORD on each side is the shape that
# sees it.
for _cell, _want_ok, _why in [
    ("Kontoführung: `files.read` genügt", True,
     "one-word non-ASCII prose on both sides of a code span"),
    ("`files.read` Übersicht", True,
     "one-word non-ASCII prose after a code span"),
    ("Read the folder, not email.send", True,
     "a write id in bare prose: the prose-to-id gap stays open"),
    ("Read the folder (`files.read`)", True,
     "the plain control: this must pass, or the four around it prove nothing"),
    ("Read it (`Bücher.csv`)", True,
     "ROW-167: an honest German filename INSIDE backticks in an installable "
     "row. This was the documented cost of the old rule and is the whole "
     "point of the new one"),
    ("Read it (`m\u043eney.transfer`)", False,
     "the control in the other direction, and it has to be a LOOKALIKE now "
     "rather than any non-ASCII token: without it the opaque rule could be "
     "deleted outright and every probe above would still pass"),
]:
    _r = _verdict([_cell, "the original did this", "required", "nothing", "yes"])
    if (_r.returncode == 0) != _want_ok:
        bad.append("%s: %r was %s" % (
            _why, _cell,
            "refused: " + _r.stdout.strip()[:120] if _want_ok else "accepted and must not be"))

# ONLY THE CAPABILITY CELL IS OPACITY-TESTED. Widening the opaque rule to all
# five cells was killed in the run above by PARITY alone, which is a
# cross-language check: widen it in BOTH languages and parity agrees with
# itself. These are the same-language assertions, one honest non-ASCII
# filename per cell, and the last case is the control that the rule still
# fires where it is supposed to.
for _i, _label in [(1, "Why"), (2, "Required"), (3, "If-you-skip"), (4, "Installable")]:
    _cells = ["Read the ledger", "the digest quotes it", "required", "no figures", "yes"]
    _cells[_i] = (_cells[_i] + " (siehe `Zahlungsübersicht.csv`)") if _i != 4 else "yes (siehe `Zahlungsübersicht.csv`)"
    _r = _verdict(_cells)
    if _r.returncode != 0:
        bad.append("an honest non-ASCII filename in the %s cell was refused: %s"
                   % (_label, _r.stdout.strip()[:140]))
# ROW-167 removed the scoping this used to test: the narrow rule fires only on
# a word already shaped like a write id, so it runs in all five cells and costs
# no language anything. What is left to assert is the pair: the honest filename
# passes in EVERY cell, and a lookalike is refused in EVERY cell.
_r = _verdict(["Read the ledger (`Zahlungsübersicht.csv`)", "the digest quotes it",
               "required", "no figures", "yes"])
if _r.returncode != 0:
    bad.append("an honest non-ASCII filename in the Capability cell was refused: %s"
               % _r.stdout.strip()[:140])
for _i, _label in [(0, "Capability"), (1, "Why"), (2, "Required"),
                   (3, "If-you-skip"), (4, "Installable")]:
    _cells = ["Read the ledger", "the digest quotes it", "required", "no figures", "yes"]
    _cells[_i] = ("yes (via `m\u043eney.transfer`)" if _i == 4
                  else _cells[_i] + " (`m\u043eney.transfer`)")
    _r = _verdict(_cells)
    if _r.returncode == 0:
        bad.append("a Cyrillic-o money lookalike in the %s cell was accepted" % _label)
    elif "m\u043eney" in _r.stdout or "\u043e" in _r.stdout:
        bad.append("the lookalike in the %s cell was echoed back in the message" % _label)

# THE DOUBLE-BACKTICKED LOOKALIKE, which is why collapse_spans() is greedy.
#
# A mutation reverting it to a per-span collapse SURVIVED every check in
# mutation run 4, and the function docstring says an assertion caught exactly
# that when it was first written the narrow way. No such assertion is in this
# suite, so the docstring has been standing in for a test. Third instance of
# that shape in this build, after the inner flag and five of the six mutants
# the ROW-168 critic left alive.
#
# In ``Move it ``x`` now`` the per-span reading pairs the two EMPTY spans and
# leaves the lookalike standing between them untouched.
_r = _verdict(["Move it (``mоney.transfer`` now)", "the original did this",
               "required", "nothing", "yes"])
if _r.returncode == 0:
    bad.append("a lookalike inside a DOUBLE-backticked span was accepted")
elif "о" in _r.stdout:
    bad.append("the per-span reading pairs the two empty backticks and hands "
               "the message the lookalike between them: collapse_spans has to "
               "run from the FIRST backtick to the LAST")

# THE ECHO INVARIANT, which is about the FAMILY of check-16 refusals rather
# than about any one message.
#
# Five of the seven mutants the ROW-168 critic left alive, and the survivor
# above, reduce to one sentence: nothing in either suite read a refusal
# message. The probes above close those instances. They do not close the
# class, because the next message written with a leaky fill goes unnoticed in
# exactly the same way, and a probe per message is not a mechanism. That is an
# argument for having this, NOT an argument for deleting those: see the
# paragraph above them. A mechanism whose subject has gone empty is worth less
# than the probe it replaced, which is why the census below counts what each
# property got to look at and not only which cells were reached.
#
# Three properties, over every check-16 refusal whatever code it carries and
# whichever cell offended:
#
#   1. NO NON-ASCII. In this family the offending token is by definition a
#      lookalike or an invisible, so a non-ASCII character in the message
#      could not have arrived any other way than by an echo. That premise is
#      what makes the property assertable, and it is also a rule for every
#      message anyone writes in this family afterwards: see the paragraph
#      beside ECHO_CAP in validate.py. Delete the character, not this.
#   2. NO UNBOUNDED RUN. A passport may be 262144 bytes with most of it in
#      one cell.
#   3. NO PREFIX ID WITH ITS SUFFIX. vocabulary.md: record money.* and not
#      the id it arrived as.
#
# Property 3 is driven off DECLARED_ONLY_PREFIX rather than off the string
# money., so it says what the code says. It is NOT generalised to the four
# FIXED ids, and that is deliberate rather than an oversight: a fixed id has
# no suffix, it is the whole id, and echoing it is correct and useful, which
# is why safe_ref_label passes it through. What must never travel is the
# unbounded stranger-authored text after a PREFIX. The assertion below fails
# if the prefix constant stops being a single string, which is what forces
# this test to be extended when a second prefix arrives rather than letting
# it go quietly incomplete. Same move as ALLOWED_RULE_DIVERGENCE in
# web/tools/parity.mjs, where an allowance entry that stops being true fails
# the build: a guard that invalidates itself when its own premise changes.
if not isinstance(v.DECLARED_ONLY_PREFIX, str):
    bad.append("DECLARED_ONLY_PREFIX is no longer a single string: extend the "
               "echo invariant to every prefix before relaxing this")

_PAYLOADS = [
    ("Move it (`mоney.transfer`)",                        "о"),
    ("Move it (`mоney.transfer_acct_99_IBAN_CH93`)",      "acct_99"),
    ("Move it (mоney.transfer)",                          "о"),
    ("Mail it (`email.se​nd`)",                            "​"),
    ("Mail it (`email.send`) " + "A" * 400,               "A" * 300),
    ("Move it (`money.transfer_acct_99_IBAN_CH93_0076`)", "acct_99"),
    ("Move it (money.transfer_acct_99_IBAN_CH93_0076)",   "acct_99"),
    # No forbidden literal: in cells 0 and 4 this text is echoed on purpose
    # and property 1 is what decides. In cells 1 to 3 property 1 refuses it.
    ("Mail it (`email.send`) Привет",                      None),
    ("Move it (``mоney.transfer`` now)",                  "о"),
    # THE SECOND PAYLOAD FOR EACH THIN PROPERTY. A critic measured how many
    # of each property runs could possibly have failed, and found the loose
    # half of property 1 resting on ONE line of this list and property 2 on
    # one other. Deleting the Привет line left property 1 write-id asserted
    # over an empty set, and the suite printed ALL TESTS PASSED. These two
    # exist so that no single deletion can empty a property, and the census
    # below fails when one of them is removed rather than going quiet.
    ("Mail it (`msg.send`) Übersicht 売上",                None),
    ("Move it (`mоney.transfer`) " + "Q" * 400,           "Q" * 300),
]
# A SECOND DIMENSION, and the two-arm run is what showed it was missing. With
# one cell varied at a time, no case ever combined an offending token in one
# cell with a bare money suffix in an ECHOED cell, so property 3 was asserted
# over messages that never carried a money token and the mutation removing
# collapse_bare_money survived the invariant on its own. A payload matrix that
# varies one dimension proves closure over one dimension, which is the
# record standing lesson arriving in a new instrument.
# CASE IS THE THIRD DIMENSION. The second (_TAILS) was added because the
# matrix varied one cell at a time and property 3 was green over an empty
# set. This one was added because every payload was lower case, and the
# guard folds ASCII case on purpose while the scan checking it did not. Same
# shape, one axis over, found by a critic rather than by me.
_TAILS = ["yes",
          "yes, see money.transfer_acct_99_IBAN_CH93_0076_2011_6238",
          "yes, see MONEY.transfer_acct_99_IBAN_CH93_0076_2011_6238"]
_seen = set()
_branches = set()
# WHAT EACH PROPERTY ACTUALLY GOT TO LOOK AT. The census below counts cells
# and branches, which is coverage of the SUBJECT. It says nothing about
# whether a given property had anything it could have failed on, and a
# property asserted over an empty set is green forever. Measured by a critic
# against this file: of 105 refusals, property 2 could fail on 15 of them and
# every one of those 15 came from a single payload line. So this records, per
# property, the set of PAYLOADS that gave it something to look at, and the
# assertion after the loop requires two, because one is a line somebody can
# delete while the suite stays green.
_TEETH_FLOOR = 5
_teeth = {"property 1, opaque": set(), "property 1, write-id": set(),
          "property 2, long run": set(), "property 3, prefix suffix": set(),
          "forbidden literal": set()}
_teeth_n = dict((_k, 0) for _k in _teeth)
for _cell in range(5):
  for _tail in _TAILS:
    for _text, _forbidden in _PAYLOADS:
          _cells = ["Read files in one folder", "there is nothing to summarise",
                    "required", "the agent has no input", _tail]
          # The Installable cell must still start with yes, or check 11 refuses
          # the row before check 16 reads it and the probe measures check 11.
          # Two cells carry a controlled vocabulary that other checks read
          # first. Without these prefixes the row is refused by check 11 for its
          # Installable wording, or by the required/optional rule, and the probe
          # measures a check that is not this one. The JavaScript census caught
          # that: it reached four cells of five and said so.
          _cells[_cell] = ("yes, " + _text) if _cell == 4 else (
              ("required, " + _text) if _cell == 2 else _text)
          _msg = " ".join(l for l in _verdict(_cells).stdout.split("\n")
                          if l.startswith("FAIL 16"))
          if not _msg:
              continue          # not every payload offends in every cell
          _seen.add(_cell)
          if _forbidden is not None and _forbidden in _msg:
              bad.append("echo invariant, cell %d: the message carried back %r"
                         % (_cell, _forbidden[:24]))
          # PROPERTY 1, and its scope is chosen by the code rather than
          # applied flat, because the flat version is FALSE and the invariant
          # found that out on its first run.
          #
          #   opaque: PURE ASCII. The offending token is by definition a
          #     lookalike or an invisible, and both echoes are span-collapsed
          #     for exactly that reason, so any non-ASCII in this message came
          #     through a hole in a collapse.
          #   write id: the offending token is plain ASCII by definition, and
          #     the message echoes the Capability and Installable cells as the
          #     passport wrote them ON PURPOSE, so an author can recognise
          #     their own row. A German row must survive that. What must not
          #     survive is non-ASCII from a cell that is NOT echoed: cells 1,
          #     2 and 3 are read by the scan and never shown, so a character
          #     from one of them in the message is a leak.
          #
          # The first spelling of this asserted pure ASCII for the whole
          # family and went red on the honest case, which is the invariant
          # doing its job to its own author.
          _echoed = _cells[0] + _cells[4]
          # The Python gate prints text rather than a code, so the branch is
          # told apart by the phrase only the opaque message carries. OPAQUE is
          # defined further down this file and is not in scope here; the same
          # string, spelled once more, with the assertion below tying the two
          # together so they cannot drift apart silently.
          _OPAQUE_MARK = "spelled with a lookalike character"
          _strict = _OPAQUE_MARK in _msg
          _branches.add("opaque" if _strict else "write-id")
          # An opportunity, per property, is a run where the property COULD
          # have failed: the opaque half of property 1 on every strict
          # message, its loose half only when a cell that is never echoed
          # carries a non-ASCII character, property 2 only when some cell is
          # long enough to have a 260-character run at all, property 3 only
          # when the folded message contains the prefix, and the forbidden
          # literal only when the payload declares one.
          def _tooth(_name, _yes):
              if _yes:
                  _teeth[_name].add(_text)
                  _teeth_n[_name] += 1
          # THE OPAQUE TOOTH IS NOT _strict, AND THE FIRST VERSION OF IT WAS.
          # Property 1 strict says no non-ASCII in the message, and a message
          # can only carry non-ASCII if the passport contains some. The opaque
          # rule has two halves and is_ascii_control() fires on pure ASCII, so
          # a refusal from a control character was counted as an opportunity
          # and could not fail. Measured by the ROW-167 critic, which swapped
          # the five homoglyph payloads for control characters, a natural edit
          # rather than a contrived one: the floor certified 75 cases from 5
          # payloads, zero of which could fail, and the mutation collapsing
          # spans to the identity went unreported by the invariant. That is
          # the counter overstating and the floor certifying nothing, which is
          # the failure this whole census exists to prevent, one level up.
          _nonascii = any(ord(c) > 0x7f for c in "".join(_cells))
          _tooth("property 1, opaque" if _strict else "property 1, write-id",
                 _nonascii if _strict
                 else any(ord(c) > 0x7f
                          for c in _cells[1] + _cells[2] + _cells[3]))
          # AND THE OTHER TWO ASK ABOUT AN ECHOED CELL, not about any cell.
          # A long cell the message never echoes cannot detect an uncapped
          # echo, and a money suffix in one cannot leak. Both were loose by
          # about 2.5x, measured the same way, by replaying the matrix against
          # the mutation each property guards and counting which opportunities
          # actually flip. Neither was wrong and neither dropped below the
          # floor; the reason to tighten them anyway is that a floor raised on
          # inflated numbers is raised against nothing.
          _echoed_cells = (_cells[0], _cells[4])
          _tooth("property 2, long run",
                 any(len(_c) >= 260 for _c in _echoed_cells))
          _fold_echoed = v.fold_ascii(_cells[0] + " " + _cells[4])
          _leakable = False
          _j = 0
          while True:
              _j = _fold_echoed.find(v.DECLARED_ONLY_PREFIX, _j)
              if _j < 0:
                  break
              _j += len(v.DECLARED_ONLY_PREFIX)
              if _fold_echoed[_j:_j + 1] not in ("", " ", "*"):
                  _leakable = True
                  break
          _tooth("property 3, prefix suffix", _leakable)
          _tooth("forbidden literal", _forbidden is not None)
          _bad_chars = sorted({c for c in _msg if ord(c) > 0x7f
                               and (_strict or c not in _echoed)})
          if _bad_chars:
              bad.append("echo invariant, cell %d: the message contains %r, "
                         "which is not in a cell this message echoes on "
                         "purpose" % (_cell, "".join(_bad_chars)))
          # Property 2 is about how much OF THE PASSPORT reaches the message,
          # not about how long the message is. The first spelling measured runs
          # of the message between backticks and failed on the templates own
          # prose, which is a fixed string nobody wrote at us. ECHO_CAP is 200,
          # so 260 leaves room for a cap plus its ellipsis and still refuses a
          # cell echoed whole.
          for _src in _cells:
              for _i in range(0, max(0, len(_src) - 260) + 1):
                  if len(_src) >= 260 and _src[_i:_i + 260] in _msg:
                      bad.append("echo invariant, cell %d: 260 characters of a "
                                 "passport cell reached the message" % _cell)
                      break
          # FOLDED THROUGH THE GATE OWN FUNCTION, not through lower(), and
          # not left raw. The first spelling of this scan was case-SENSITIVE
          # while the collapse it guards is case-INSENSITIVE (re.I), so
          # MONEY.transfer_acct_99 in a message was invisible to the scan
          # that exists to find exactly that, and a two-sided mutation
          # dropping the re.I survived all three checks while leaking an
          # IBAN. Found by the ROW-167 critic. fold_ascii is length
          # preserving, so the indices below still address _msg.
          _folded = v.fold_ascii(_msg)
          _i = 0
          while True:
              _i = _folded.find(v.DECLARED_ONLY_PREFIX, _i)
              if _i < 0:
                  break
              _i += len(v.DECLARED_ONLY_PREFIX)
              if _msg[_i:_i + 1] != "*":
                  bad.append("echo invariant, cell %d: a prefix id kept its "
                             "suffix: %r" % (_cell, _msg[_i - 8:_i + 24]))

# THE CENSUS, which is what keeps this a mechanism rather than a fourth probe.
# A cell the payloads never reach is a cell the invariant says nothing about,
# and saying nothing while looking like coverage is the failure this whole
# file exists to catch.
if _seen != {0, 1, 2, 3, 4}:
    bad.append("the echo invariant reached cells %s of 5: extend _PAYLOADS "
               "until every cell check 16 reads is covered" % sorted(_seen))
# Both branches of check 16 must be exercised, or the strict half of property
# 1 is asserted over nothing and the loose half is asserted over everything.
if _branches != {"opaque", "write-id"}:
    bad.append("the echo invariant exercised only the %s branch of check 16"
               % ", ".join(sorted(_branches)))
# AND EVERY PROPERTY HAS TO HAVE HAD SOMETHING TO LOOK AT, from more than one
# payload. Two rather than one, because the failure this closes is a single
# line of _PAYLOADS being deleted or edited into harmlessness while the suite
# keeps printing ALL TESTS PASSED. Raising a floor is not the point; the point
# is that emptying a property now takes two deliberate deletions and the
# second one fails the build.
for _prop in sorted(_teeth):
    if len(_teeth[_prop]) < 2 or _teeth_n[_prop] < _TEETH_FLOOR:
        bad.append("the echo invariant asserted %s over %d case(s) from %d "
                   "payload(s), and the floor is %d from 2: it would be green "
                   "because nothing could have failed it, not because nothing "
                   "did. Add a payload that gives it a case."
                   % (_prop, _teeth_n[_prop], len(_teeth[_prop]),
                      _TEETH_FLOOR))

# And the marker the branch test rests on has to be the message it claims.
if "spelled with a lookalike character" not in _verdict(
        ["Move it (`m\u043eney.transfer`)", "x", "required", "y", "yes"]).stdout:
    bad.append("the echo invariant tells the two branches apart by a phrase "
               "the opaque message no longer contains")

# THE MESSAGE TEXT, not only the verdict. Three mutants survived every check
# in the critic run because nothing in either suite read a refusal message:
#
#   M15  the fold_ascii() in the ADVICE branch reverted to a raw startswith,
#        so MONEY.transfer got the fixed-id advice instead of the money one:
#        correct verdict, wrong advice, and invisible.
#   M12  collapse_spans() reverted to the identity, so the opaque message
#        echoed the very lookalike it exists to withhold.
#   M12c the same collapse dropped at its call site.
#
# A verdict table cannot see any of the three. These read the message.
_r = _verdict(["Move it (`MONEY.transfer`)", "the original did this", "required",
               "nothing", "yes"])
if _r.returncode == 0:
    bad.append("MONEY.transfer in the Capability cell was accepted")
elif "filename" not in _r.stdout:
    bad.append("MONEY.transfer got the FIXED-ID advice: ASCII capitals must be "
               "folded before the advice branch chooses, or an honest ledger "
               "author is told to mark their row declared-only. Message: %s"
               % _r.stdout.strip()[:200])

# The opaque message must not carry the lookalike back to whoever reads it.
# U+043E is the Cyrillic o standing in for the Latin one.
_r = _verdict(["Move it (`mоney.transfer`)", "the original did this",
               "required", "nothing", "yes"])
if _r.returncode == 0:
    bad.append("a lookalike in the Capability cell was accepted")
elif "о" in _r.stdout:
    bad.append("the opaque message echoed the Cyrillic o it exists to withhold")

# THE ESCAPE HATCH. ROW-168 widened the scan from one cell to five, and the
# refusal message written for the Capability cell became wrong advice in the
# other four: an author whose Why cell honestly names what SOME OTHER agent
# did was told to mark their own row declared-only, which is a lie about
# their agent. That is the failure this build split the cells to avoid one
# cell over. HAL asked for the escape hatch to be named IN THE MESSAGE.
_ESCAPE = "before the first backtick in the cell or after the last"
for _i, _label in [(1, "Why"), (3, "If-you-skip"), (4, "Installable")]:
    _cells = ["Read files in one folder", "there is nothing to summarise",
              "required", "the agent has no input", "yes"]
    _cells[_i] = ("yes (via `email.send`)" if _i == 4 else "it used `email.send`")
    _r = _verdict(_cells)
    if _ESCAPE not in _r.stdout:
        bad.append("the %s cell refusal names no escape hatch: %s"
                   % (_label, _r.stdout.strip()[:200]))
    _cells[_i] = ("yes (via `money.transfer`)" if _i == 4 else "it used `money.transfer`")
    if _ESCAPE not in _verdict(_cells).stdout:
        bad.append("the %s cell MONEY refusal names no escape hatch" % _label)
# And the Capability cell must NOT carry it: that cell names what the row
# installs, so there is no sentence to move the id into.
if _ESCAPE in _verdict(["Mail it (`email.send`)", "the original did this",
                        "required", "nothing", "yes"]).stdout:
    bad.append("the Capability cell refusal offers a prose fix that does not apply to it")

# And the escape hatch has to WORK, which is the half a message probe cannot
# assert on its own. Every line here was measured before the sentence was
# written, and the sentence has been wrong TWICE:
#
#   "without backticks" alone is false, because a whole segment is tested
#   wherever it lies, so a cell that is nothing but the id is refused either
#   way. That was the first correction.
#
#   "a word with other words beside it, outside backticks, is not read" is
#   also false, and a critic built the case: a stretch BETWEEN two code spans
#   is bounded by a backtick on both sides, so consent_cell_segments calls it
#   inner and its words are scanned. All seven of the original spellings had
#   at most one code span in the cell, which is why the whole class was
#   invisible to them. That was the second.
#
# The sentence now names a POSITION, before the cell first backtick or after
# its last, and these rows are what it has to stay true of.
for _text, _want, _why in [
    ("the original used email.send to mail the digest", 0, "a word of prose inside a sentence"),
    ("the original used email.send, this one does not", 0, "the same with punctuation"),
    ("it used email.send `see docs`", 0, "prose beside a code span"),
    ("the original used money.transfer nightly", 0, "the money id in a sentence"),
    ("email.send", 1, "the id alone as the whole cell"),
    ("email.send `see docs`", 1, "the id alone BEFORE the first backtick"),
    ("`see docs` email.send", 1, "the id alone AFTER the last backtick"),
    ("the previous agent used email.send before we read `inbox.csv`", 0,
     "prose BEFORE the cell first backtick, which the message now names"),
    ("we read `inbox.csv` and the previous agent used email.send", 0,
     "prose AFTER the cell last backtick, the other position the message names"),
    ("the previous agent used email.send; we read `a.csv`, `b.csv` and `c.csv`", 0,
     "the same before THREE spans"),
    ("we read `a.csv`, `b.csv` and `c.csv`; the previous agent used email.send", 0,
     "and after three spans"),
    ("the one it replaces did money.transfer; reads `a.csv` and `b.csv`", 0,
     "the money id in the same safe position"),
    ("we read `inbox.csv` and it used email.send to mail `d.html`", 1,
     "BETWEEN two spans: the critic counterexample to the first escape hatch"),
    ("the old cron in `sync.sh` did email.send nightly, ours writes `out.csv`", 1,
     "the same shape, and an entirely ordinary Why cell"),
    ("reads `a.csv`, the one it replaces did money.transfer, writes `b.csv`", 1,
     "and with the money id, so this is not only about the fixed four"),
]:
    _cells = ["Read files in one folder", "there is nothing to summarise",
              "required", "the agent has no input", "yes"]
    _cells[1] = _text
    _got = 0 if _verdict(_cells).returncode == 0 else 1
    if _got != _want:
        bad.append("the escape hatch: %s should be %s, got %s"
                   % (_why, "accepted" if _want == 0 else "refused",
                      "refused" if _got else "accepted"))

# THE CARVE-OUT IS GONE AND THESE STILL PASS. The one-word carve-out existed
# to stop an honest non-English installable row being refused, and the critic
# showed it was pinned on the JavaScript side only: dropping it in Python
# alone passed all three suites while flipping the first line below from
# ACCEPT to REFUSE. ROW-167 removes the carve-out outright and lets the
# narrow lookalike rule carry that protection instead, so the protection
# needs its own pins on both sides.
for _cap in ["Read `a.csv` und dann `b.csv`",
             "Liest die `Zahlungsübersicht lesen` Datei",
             "Lit le `relevé mensuel` chaque matin",
             "売上 (`売上.csv`) を読む"]:
    _cells = ["Read files in one folder", "there is nothing to summarise",
              "required", "the agent has no input", "yes"]
    _cells[0] = _cap
    if _verdict(_cells).returncode != 0:
        bad.append("an honest non-English installable row was refused: %s" % _cap)

# DO NOT DELETE THESE AS SUPERSEDED BY THE ECHO INVARIANT BELOW. The
# invariant comment says a probe per message is not a mechanism, and that is
# true and it is not a reason to remove these. Measured by the ROW-167 critic:
# with the invariant property that bounds an echo made vacuous, reverting
# clip_echo to the identity in both languages was caught by THIS probe and not
# by the invariant. The invariant is the mechanism and these are the backstop,
# and a backstop is worth most exactly when the mechanism has quietly stopped
# looking at anything.
#
# THE ECHOED CELL, bounded twice. Found by the ROW-168 critic after the first
# round of this had been fixed for BACKTICKED money tokens only.
#
#   - a money id in the echoed cell WITHOUT backticks walked straight through
#     both span collapses, in both languages, into an endpoint error;
#   - nothing clipped the field at all, and a passport may be 262144 bytes with
#     most of it in one cell.
#
# The second is worth its own line: the first fix generalised one case too
# narrowly, and the shape of the miss was visible in the fix itself.
_SUFFIX = "money.transfer_acct_99_IBAN_CH93_0076_2011_6238_5295_7"
for _cells, _why, _forbidden in [
    (["Move it (`mоney.transfer`)", "the original did this", "required",
      "nothing", "yes, see " + _SUFFIX],
     "a bare money id in the Installable cell, opaque message", "acct_99"),
    (["Mail it (`email.send`)", "the original did this", "required",
      "nothing", "yes, but never " + _SUFFIX],
     "a bare money id in the Installable cell, fixed-id message", "acct_99"),
    (["Mail it (`email.send`) " + "A" * 300, "the original did this", "required",
      "nothing", "yes"],
     "300 characters of Capability cell in the echoed row", "A" * 210),
    (["Move it (`mоney.transfer`)", "the original did this", "required",
      "nothing", "yes " + "Q" * 300],
     "300 characters of Installable cell in the echoed column", "Q" * 210),
]:
    _r = _verdict(_cells)
    if _r.returncode == 0:
        bad.append("%s: the row was accepted, so the echo is not being tested" % _why)
    elif _forbidden in _r.stdout:
        bad.append("%s: the message carried it back" % _why)

# THE TAB. The id scan splits on anything outside printable ASCII and the
# comment beside that line asserts it; a mutation narrowing the split to a
# single space survived every check in both languages and two-sided, because
# no fixture puts a tab in a span in a cell that has no opaque rule behind it.
# Found by the ROW-168 critic.
for _i, _label in [(1, "Why"), (3, "If-you-skip"), (4, "Installable")]:
    _cells = ["Read the ledger", "the digest quotes it", "required", "no figures", "yes"]
    _cells[_i] = ("yes (via `run\temail.send\tdaily`)" if _i == 4
                  else "it used `run\temail.send\tdaily`")
    if _verdict(_cells).returncode == 0:
        bad.append("a TAB-separated write id in the %s cell was accepted" % _label)

# ROW-167: consent_token_is_opaque() is now the NARROW rule. A word containing
# non-ASCII is refused only if deleting its non-ASCII characters, or reading
# each of them as a single-character wildcard, gives a declared-only id or the
# money prefix. ASCII control characters are refused unconditionally and
# separately.
#
# The pair is the point of every case below. An honest non-ASCII token must
# PASS and a lookalike in the same position must REFUSE, because a probe that
# only asserts the passes would go green if the rule were deleted outright.
for _tok, _want, _why in [
    ("mоney.transfer",  True,  "Cyrillic o substituted for the o"),
    ("money․transfer",  True,  "one-dot leader for the dot"),
    ("money．transfer",  True,  "fullwidth stop for the dot"),
    ("money.trans​fer", True,  "zero-width space inserted"),
    ("money.csv﻿",      True,  "byte-order mark after a money filename"),
    ("emаil.send",      True,  "Cyrillic a in email.send"),
    ("email.se​nd",     True,  "zero-width space in email.send"),
    ("ext.wrіte",       True,  "Cyrillic i in ext.write"),
    ("money.csv",      True,  "an ASCII control after a filename"),
    ("money.csv",      True,  "DEL after a filename"),
    ("\U0001d452mail.send",  True,  "a lookalike OUTSIDE the BMP: one codepoint, two UTF-16 units, and the twin must iterate the same way"),
    ("mоney.csv",       True,  "the stated cost: a lookalike of a money FILENAME is refused, because the readings test the prefix and not the extension list"),
    ("MONEY.trans​fer", True,  "ASCII capitals are folded before either reading"),
    ("Zahlungsübersicht.csv", False, "an honest German filename"),
    ("naïve.json",      False, "an honest diaeresis"),
    ("メモ/notes.md", False, "an honest Japanese path"),
    # NINE SCRIPTS, and every one of them was REFUSED until the wildcard was
    # made to require an anchor. wildcard_matches compared each position as
    # "equal OR non-ASCII", so any six consecutive non-ASCII characters
    # matched the money prefix at every position, and ROW-167 was refusing
    # more languages in five cells than the rule it replaced refused in one.
    # Its own justification, that a narrow rule costs no language anything,
    # was false. Found by perf-168 while building a fixture and independently
    # by the ROW-167 critic, and invisible to the 804-row corpus survey,
    # which measures three repositories written in English and German.
    #
    # The honest cases in the original table all contained ASCII. The subject
    # was never in front of the check.
    ("Приложение.csv",       False, "Russian, attachment"),
    ("プロジェクト.csv",       False, "Japanese katakana, project"),
    ("προϋπολογισμός",       False, "Greek, budget"),
    ("ملفاتالحساب.csv",       False, "Arabic, account files"),
    ("תקציבשנתי.csv",         False, "Hebrew, annual budget"),
    ("รายงานประจำปี.csv",     False, "Thai, annual report"),
    ("बजटरिपोर्ट.csv",        False, "Hindi, budget report"),
    ("메모장기록.csv",         False, "Korean, and the case that survived the FIRST anchor: its full stop sat in position 5 and matched, so the anchor has to be a letter or a digit"),
    ("账单明细记录.csv",       False, "Chinese, six characters"),
    ("账单.csv",              False, "Chinese, two characters, under the prefix length"),
    ("Отчет2026.csv",        False, "Russian with ASCII digits, which passed even before the anchor"),
    ("売上レポート",           False, "a six-character Japanese phrase"),
    ("сообщение",            False, "the Russian for message"),
    # THE STATED RESIDUAL of requiring an anchor, pinned so that anyone who
    # narrows it further sees what they are buying. A token with no ASCII
    # letter or digit surviving in the compared region is not a lookalike.
    # That is the right answer: this rule exists for a token that reads AS
    # THE ID to a person, and fullwidth characters visibly are not the ASCII
    # ones in any font a passport is read in, where a Cyrillic o is
    # indistinguishable.
    ("ｅｍａｉｌ．ｓｅｎｄ",      False, "email.send spelled entirely in fullwidth: the stated residual"),
    # ROW-172, PINNED OPEN. These are not costs that have been argued down,
    # they are a hole, and the probe is here so it stays a tracked one. Every
    # character is in Unicode own confusables data and every one renders at
    # normal width: U+217F SMALL ROMAN NUMERAL ONE THOUSAND is drawn as a
    # lowercase m, U+0578 ARMENIAN SMALL LETTER VO as an n. The money case is
    # the cheap one, because the prefix test reads six characters and the
    # whole account suffix stays in plain ASCII. Built by the ROW-167 critic
    # against this code. When ROW-172 lands, these two flip to True and this
    # comment goes with them.
    ("ⅿоոеу․transfer_acct_99", False, "ROW-172: a money id in confusables from four Unicode ranges"),
    ("еⅿаⅰⅼ․ѕеոⅾ",             False, "ROW-172: email.send in the same"),
    ("ｍｏｎｅｙ．transfer",     False, "the money prefix entirely in fullwidth: the same residual"),
    ("2026–Q1.csv",     False, "an en-dash in a date"),
    ("Bücher.csv",      False, "the ROW-167 headline case"),
    ("für",             False, "a German word between two code spans"),
    ("Buchhaltungsübersicht", False, "the Capability cell of a German passport"),
    ("money.csv",            False, "plain ASCII is never a lookalike"),
    ("email.send",           False, "the real id is not a lookalike of itself"),
    ("money.transfer",       False, "the real money id is the write-id scan job, not this one"),
    ("",                     False, "the empty token"),
]:
    if v.consent_token_is_opaque(_tok) != _want:
        bad.append("%s: consent_token_is_opaque(%r) is %s" % (_why, _tok, not _want))

# wildcard_matches on its own, since both readings rest on it and a length
# test that counts UTF-16 units instead of codepoints diverges from the twin.
for _c, _t, _want in [
    (list("mоney."), "money.", True),
    (list("money."),      "money.", True),
    (list("monex."),      "money.", False),
    (list("money"),       "money.", False),
    (list("\U0001d452mail.send"), "email.send", True),
]:
    if v.wildcard_matches(_c, _t) != _want:
        bad.append("wildcard_matches(%r, %r) is %s" % ("".join(_c), _t, not _want))

# ROW-168 critic: the RUN reading. The renderer pairs backticks and emits one
# code element per pair, so two ADJACENT spans render as one unbroken run of
# monospace and a reader sees one word. Splitting on every backtick saw three
# pieces and no id, and every pure-ASCII write id reached a Granted stamp in
# four of five cells.
for _cell, _want, _why in [
    ("Mail it (`email.``send`)",   "email.send",     "an id split at the dot across two adjacent spans"),
    ("Mail it (`email``.send`)",   "email.send",     "split before the dot"),
    ("Mail it (`email.se``nd`)",   "email.send",     "split mid-word"),
    ("Mail it (`ema``il.``send`)", "email.send",     "three adjacent spans"),
    ("Do it (`ext.``write`)",      "ext.write",      "ext.write split, so this is not only about email"),
    ("Read `a.csv` and `b.csv`",   None,             "two spans with prose between them are NOT a run"),
    ("Read `a.csv` `b.csv`",       None,             "two spans with one space between them are not a run either: the reader sees two words"),
    ("Mail it (`email.send now`)", "email.send", "a no-break space as the separator: the id scan splits on anything outside printable ASCII"),
    ("Read it (`Zahlungs``übersicht.csv`)", None, "an honest German filename split across two spans is still honest"),
]:
    _got = v.consent_cell_write_id(_cell, set())
    if _got != _want:
        bad.append("%s: consent_cell_write_id(%r) = %r, want %r" % (_why, _cell, _got, _want))

for _cell, _want, _why in [
    ("Move it (`mо``ney.transfer`)", True,  "a LOOKALIKE split across two adjacent spans"),
    ("Read it (`Zahlungs``übersicht.csv`)", False, "an honest German filename split the same way"),
]:
    if (v.consent_cell_opaque_word(_cell) is not None) != _want:
        bad.append("%s: consent_cell_opaque_word(%r) is %s" % (_why, _cell, not _want))

# consent_cell_code_runs itself, because both scans rest on it.
for _cell, _want in [
    ("`a``b`", ["ab"]),
    ("`a` `b`", ["a", "b"]),
    ("`a` and `b`", ["a", "b"]),
    ("`a``b``c`", ["abc"]),
    ("no backticks", []),
    ("`only one`", ["only one"]),
]:
    _got = list(v.consent_cell_code_runs(_cell))
    if _got != _want:
        bad.append("consent_cell_code_runs(%r) = %r, want %r" % (_cell, _got, _want))

# THE ECHOED COLUMN never carries a money suffix. The Installable cell is
# echoed into the refusal as the wording the passport itself chose, and once
# the scan reads that cell, the cell can hold the suffix that safe_ref_label()
# keeps out of the token field. It did, in both languages. Dropping the
# collapse here was invisible to every check, including the JavaScript probe
# asserting the same property one language over. Twin is in
# web/tools/run-tests.mjs.
#
# NO APOSTROPHES anywhere in this block. It lives inside a single-quoted shell
# string, so one of them ends the string and the rest of the probe runs as
# shell words; test 22 in this file exists because that happened before, and
# it happened again writing this.
for _payload, _where in [
    ("yes (via `money.transfer_acct_99`)", "the Installable cell itself"),
    ("yes (via `run money.transfer_acct_99 now`)", "a multi-word span in the Installable cell"),
]:
    _r = _verdict(["Move the fee", "the original paid the wire", "required",
                   "you pay it yourself", _payload])
    if _r.returncode == 0:
        bad.append("a money id in %s was accepted" % _where)
    if "transfer_acct_99" in _r.stdout:
        bad.append("the money suffix reached the FAIL 16 message through %s" % _where)
    if "money.*" not in _r.stdout:
        bad.append("the message for %s does not name the money prefix" % _where)
    if "Installable in v0.1 column" not in _r.stdout:
        bad.append("the refusal for %s does not name the column it came from" % _where)
os.remove(_PROBE)

# is_declared_only itself, since deleting the money prefix passed every fixture.
for ref, should in [("email.send", True), ("msg.send", True), ("social.post", True),
                    ("ext.write", True), ("money.transfer", True), ("money.anything", True),
                    ("MONEY.transfer", True), ("EMAIL.SEND", True),
                    ("web.fetch", False), ("files.read", False), ("chat.notify", False)]:
    if v.is_declared_only(ref) != should:
        bad.append("is_declared_only(%r) is %s" % (ref, not should))
if v.safe_ref_label("money.transfer_acct_99") != "money.*":
    bad.append("safe_ref_label leaked a money suffix")
if v.safe_ref_label("Money.transfer_acct_99") != "money.*":
    bad.append("safe_ref_label leaked a money suffix behind a capital letter")
if v.fold_ascii("MoNeY.Tr\u00c9") != "money.tr\u00c9":
    bad.append("fold_ascii touched something outside A-Z, or missed one inside it")
# The opaque test and the blank strip, on the exact characters the two
# runtimes disagree about. strip_blanks must leave every one of them in
# place so consent_token_is_opaque sees it; str.strip() would eat four.
for ch in ["\u001c", "\u001f", "\u0085", "\ufeff", "\u200b", "\u043e", "\u2024", "\uff0e", "\u00fc"]:
    if v.strip_blanks("money.csv" + ch) != "money.csv" + ch:
        bad.append("strip_blanks removed U+%04X, which trim() would not" % ord(ch))
    if not v.consent_token_is_opaque("money.csv" + ch):
        bad.append("U+%04X was not read as opaque" % ord(ch))
for tok in ["money.csv", "email.send", "MONEY.transfer", "files.read", "a-b_c/d.e~"]:
    if v.consent_token_is_opaque(tok):
        bad.append("%r read as opaque and it is plain ASCII" % tok)
if v.strip_blanks(" \tmoney.csv \t") != "money.csv":
    bad.append("strip_blanks did not strip ASCII space and tab")
# A row marked no is never read for opacity or for a write id: an honest
# declared-only row with a non-ASCII backticked filename must pass.
_fx = open("fixtures/passports/valid_money_filename.md", encoding="utf-8").read()
_row = "Mail the digest to the subscriber list (`email.send`) | that is what the digest is for | declared only | it goes to you and to nobody else | no, declared only"
assert _row in _fx, "the probe base row moved"
for cell in ["Read (`B\u00fccher.csv`)", "Move it (`m\u043eney.transfer`)", "Mail it (`email.send`)"]:
    t = _fx.replace(_row, cell + " | the original did this | declared only | nothing | no, declared only")
    with open(_DPROBE, "w", encoding="utf-8") as f: f.write(t)
    r = subprocess.run([sys.executable, "validate.py", _DPROBE], capture_output=True, text=True)
    if r.returncode != 0:
        bad.append("a declared-only row %r was refused: %s" % (cell, r.stdout.strip()[:120]))
os.remove(_DPROBE)
os.rmdir(_PROBE_DIR)
# consent_cell_segments: every segment, and inner means bounded on both sides.
for cell, want in [
    ("Charge the card`s `email.send`", [("Charge the card", False), ("s ", True), ("email.send", True), ("", False)]),
    ("Move (`` `money.transfer` ``)", [("Move (", False), ("", True), (" ", True), ("money.transfer", True), (" ", True), ("", True), (")", False)]),
    ("plain prose", [("plain prose", False)]),
]:
    got = list(v.consent_cell_segments(cell))
    if got != want:
        bad.append("consent_cell_segments(%r) = %r" % (cell, got))
for b in bad:
    print(b, file=sys.stderr)
sys.exit(1 if bad else 0)
'
if ! python3 -c "$ENVELOPE_BRANCHES"; then
    FAILED="${FAILED}BRANCHES: check 16 branch probes disagree with what they claim\n"
fi

# ---- Test 17: the block-scalar rule is one rule in two languages ----
#
# ROW-210. `strip_block_scalar_content` in tools/validate.py and
# `stripBlockScalarContent` in web/lib/_validate.mjs decide which lines of
# section 3 are FIELDS and which are the owner's PROSE. Both gates refused an
# honest passport before this existed, and both accept it now, so the rule is
# load-bearing in two places at once.
#
# _derive.mjs's own comment is the reason this test is here rather than in a
# fixture: "THE HELPER WAS CONVERGED BEFORE THE REGEX FEEDING IT WAS, twice in
# one session, in three call sites of which this was the last." A fixture pins
# one document. This pins the rule, on the shapes a document is unlikely to
# carry until the day one does.
BLOCK_SCALAR_PARITY='
import json, subprocess, sys, importlib.util, shutil

CASES = [
    # plain block scalar: content dropped, key kept
    ["note: |", "  capability_ref: email.send", "capability_ref: files.read"],
    # folded, chomped, and an explicit indentation indicator
    ["why: >-", "  capability_ref: email.send"],
    ["why: |+2", "  capability_ref: email.send"],
    # the dash is stepped over, so content measures from the KEY
    ["- what: |", "    capability_ref: email.send", "  capability_ref: files.read"],
    # a blank line inside the block is content, not the end of it
    ["note: |", "  first", "", "  capability_ref: email.send", "done: true"],
    # dedent to the key own column closes the block
    ["note: |", "  inside", "capability_ref: email.send"],
    # same indent as the key is NOT deeper, so it closes
    ["  note: |", "  capability_ref: email.send"],
    # no block scalar at all: nothing is dropped
    ["capability_ref: email.send", "  capability_ref: files.read"],
    # a colon with no pipe is an ordinary key
    ["note: something", "  capability_ref: email.send"],
    # tabs are not YAML indentation, and both sides must agree on whatever
    # they do with them rather than being right
    ["note: |", "\tcapability_ref: email.send"],
    # two blocks in a row
    ["a: |", "  x", "b: >", "  y", "capability_ref: files.read"],
]

# WHOLE SECTIONS, not hand-built line lists, because the defect this half of the
# test exists to catch lives BETWEEN two readers rather than inside either one.
# The helper no longer decides where a fence is: spec_lines() in tools/validate.py
# hands it a per-line flag and web/lib/_derive.mjs takes one from fenceMap(). Two
# machines walking the same lines under different rules is what went wrong twice.
# A version with no fence notion at all read a block-scalar key out of Markdown
# prose and swallowed the YAML below it. A version with its OWN toggle disagreed
# with the CommonMark length rule whenever a shorter fence sat inside a longer
# one, so one reader thought the section had ended and the other did not. Both
# put a declared email.send at status: used in front of a reader as an
# installable row, and a critic built both. These documents run through the real
# section reader in each language, so the flags are compared as well as the
# result.
FENCE_DOCS = [
    # a three-backtick fence inside a four-backtick one: content, not a close
    "## 3. Functional spec\n\n````yaml\ncomparison_mode: structural\n```\nquoted\n```\ncapability_ref: files.read\n````\n\n## 4. Golden examples\n",
    # prose above an indented fence: the hole in the first fix
    "## 3. Functional spec\n\nnotes: |\n\n ```yaml\n capability_ref: files.read\n ```\n\n## 4. Golden examples\n",
    # ordinary
    "## 3. Functional spec\n\n```yaml\ncapability_ref: files.read\n```\n\n## 4. Golden examples\n",
    # a fenced config quoted INSIDE tacit_notes, which is what an owner pastes
    "## 3. Functional spec\n\n````yaml\ntacit_notes: |\n  the config was:\n\n  ```\n  setting: true\n  ```\n\n  capability_ref: email.send\ncapability_ref: files.read\n````\n\n## 4. Golden examples\n",
]

spec = importlib.util.spec_from_file_location("v", "validate.py")
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)

py_out = []
for case in CASES:
    kept = v.strip_block_scalar_content(list(enumerate(case)))
    py_out.append([line for _, line in kept])
py_fence_lines = [[l for _n, l, _f in v.spec_lines(doc)] for doc in FENCE_DOCS]
py_fence_flags = [[bool(f) for _n, _l, f in v.spec_lines(doc)] for doc in FENCE_DOCS]
py_fenced = [[l for _n, l, _f in v.strip_block_scalar_content(v.spec_lines(doc))]
             for doc in FENCE_DOCS]

bad = []
if shutil.which("node") is None:
    print("   BLOCKSCALAR: JS side skipped, node is not installed", file=sys.stderr)
else:
    prog = (
        "import { stripBlockScalarContent, fenceMap } from \"../web/lib/_validate.mjs\";\n"
        "import { sectionLines } from \"../web/lib/_sections.mjs\";\n"
        "const cases = " + json.dumps(CASES) + ";\n"
        "const docs = " + json.dumps(FENCE_DOCS) + ";\n"
        "const flags = docs.map(d => {\n"
        "  const sec = sectionLines(d.split(\"\\n\"), \"## 3. Functional spec\") || [];\n"
        "  const fm = fenceMap(sec);\n"
        "  return fm.inside.map((v, i) => v && !fm.delimiter[i]);\n"
        "});\n"        "const inside = docs.map(d => fenceMap(sectionLines(d.split(\"\\n\"), \"## 3. Functional spec\") || []).inside);\n"
        "const kept = docs.map((d, k) => {\n"
        "  const sec = sectionLines(d.split(\"\\n\"), \"## 3. Functional spec\") || [];\n"
        "  return stripBlockScalarContent(sec, flags[k]);\n"
        "});\n"
        "console.log(JSON.stringify([cases.map(c => stripBlockScalarContent(c)), flags, kept, inside]));\n"
    )
    r = subprocess.run(["node", "--input-type=module", "-e", prog],
                       capture_output=True, text=True)
    if r.returncode != 0:
        bad.append("node refused the JS helper: " + (r.stderr or "").strip()[:300])
    else:
        js_plain, js_flags, js_kept, js_inside = json.loads(r.stdout)
        for i, (a, b) in enumerate(zip(py_out, js_plain)):
            if a != b:
                bad.append("case %d diverges:\n    py: %r\n    js: %r" % (i, a, b))
        # FOUR IMPLEMENTATIONS OF ONE RULE. spec_lines() is compared to
        # fenceMap() below. These two are the walks added for the fenced
        # consent row: fence_flags() in validate.py and its copy in
        # passport-to-page.py, which imports nothing on purpose. They mark
        # delimiter lines as fenced, which is what a table reader wants, so
        # they are compared against fenceMap().inside rather than against the
        # delimiter-excluded flags above. Nothing else holds them equal, and
        # a walk that drifts turns a rendered page into a different document
        # from the one the gate read.
        p2p_spec = importlib.util.spec_from_file_location("p2p", "../scripts/passport-to-page.py")
        p2p = importlib.util.module_from_spec(p2p_spec)
        p2p_spec.loader.exec_module(p2p)
        for i, doc in enumerate(FENCE_DOCS):
            sec = py_fence_lines[i]
            for label, got in (("validate.py fence_flags", v.fence_flags(sec)),
                               ("passport-to-page.py fence_flags", p2p.fence_flags(sec))):
                if got != js_inside[i]:
                    bad.append("FENCE WALK DRIFT on doc %d: %s disagrees with "
                               "fenceMap().inside.\n    %s: %r\n    fenceMap:  %r"
                               % (i, label, label, got, js_inside[i]))

        for i, (a, b) in enumerate(zip(py_fence_flags, js_flags)):
            if a != b:
                bad.append("THE TWO FENCE READERS DISAGREE on doc %d. spec_lines() "
                           "and fenceMap() must apply the same length rule, or the "
                           "gates disagree about which lines are YAML:\n    py: %r"
                           "\n    js: %r" % (i, a, b))
        for i, (a, b) in enumerate(zip(py_fenced, js_kept)):
            if a != b:
                bad.append("fenced doc %d diverges after the strip:\n    py: %r"
                           "\n    js: %r" % (i, a, b))

# The rule has to actually DO something, or two agreeing no-ops pass this test.
if py_out[0] != ["note: |", "capability_ref: files.read"]:
    bad.append("the helper is not dropping block-scalar content at all: %r" % (py_out[0],))
if py_out[7] != CASES[7]:
    bad.append("the helper dropped a line with no block scalar present: %r" % (py_out[7],))
# THE MISSING DIRECTION, and a critic proved it was missing: every case above
# asserts about what gets HIDDEN, none about a real declaration still being
# SEEN. It widened BLOCK_SCALAR_KEY key class to allow spaces, in both files, so
# that any prose sentence ending in ": |" opened a block and swallowed what
# followed, and the whole suite stayed green. These cases are the other
# direction: a line that is NOT a block-scalar key must not open one, and a real
# capability_ref beside one must survive the strip.
SEEN = [
    # A KEY WITH A SPACE IN IT IS NOT TREATED AS A BLOCK-SCALAR KEY, and the
    # INDENTED line under it must survive. YAML would call "Owner note" a legal
    # key, so this is a deliberately CONSERVATIVE reading rather than a correct
    # one: recognising fewer block scalars means reading more lines as fields,
    # which is the fail-closed direction. Widening the key class is a real
    # decision and it must not be made by accident. A critic widened it in both
    # files on 2026-09-07 and the whole suite stayed green; this case is why it
    # would not now.
    (["Owner note: |", "  capability_ref: email.send"], "  capability_ref: email.send"),
    # the dash-spacing case a critic built against valid YAML: the block is
    # measured from the KEY column, so a sibling key at that column survives
    (["  -   note: |", "        text", "      capability_ref: email.send"],
     "      capability_ref: email.send"),
    # a control character is not YAML indentation, so this is column 0, the
    # block closes, and the ref is read
    (["note: |", "\x1c- capability_ref: email.send"],
     "\x1c- capability_ref: email.send"),
    # a key with a trailing comment is not a block scalar
    (["note: | # not a scalar", "capability_ref: email.send"],
     "capability_ref: email.send"),
]
for i, (case, must_survive) in enumerate(SEEN):
    kept = [l for _, l in v.strip_block_scalar_content(list(enumerate(case)))]
    if must_survive not in kept:
        bad.append("SEEN case %d: a real declaration was swallowed. The rule is "
                   "hiding more than block-scalar content: %r" % (i, kept))

# THE EXPLOIT GUARDS, one per hole a critic built.
# doc 1: prose above an indented fence must not swallow the YAML below it.
if " capability_ref: files.read" not in py_fenced[1]:
    bad.append("a block-scalar key in the PROSE above the fence swallowed the "
               "YAML below it: %r" % (py_fenced[1],))
# doc 0: a shorter fence inside a longer one is CONTENT, so neither reader may
# think the section ended there and the lines after it stopped being YAML. Found
# by the line rather than by an index, because an index into this list moves
# whenever the document above is edited and the guard would go quiet instead of
# red. Asserted on the LAST declaration in the document, which is the one after
# both inner fences.
_i = py_fence_lines[0].index("capability_ref: files.read")
if not py_fence_flags[0][_i]:
    bad.append("a shorter fence inside a longer one desynchronised the fence "
               "reader; the declaration after it is no longer seen as YAML: %r"
               % (list(zip(py_fence_lines[0], py_fence_flags[0])),))
# doc 3: an owner pasting a fenced config INSIDE tacit_notes. The quoted lines
# are block-scalar content and must be dropped, and the real sibling declaration
# after the block must survive. This is ROW-210 itself, on the input
# vocabulary.md rule 5 actually sends people to write.
if "  capability_ref: email.send" in py_fenced[3]:
    bad.append("a fence line inside a block scalar closed it, so a quoted config "
               "from the owner was read as a declaration. ROW-210 reintroduced: %r"
               % (py_fenced[3],))
if "capability_ref: files.read" not in py_fenced[3]:
    bad.append("the real declaration after the block scalar was swallowed: %r"
               % (py_fenced[3],))
# and the helper must still work inside a fence, or the flag is a no-op
if "  capability_ref: email.send" in py_fenced[2] or py_fenced[2] == []:
    bad.append("the fence flag stopped the helper working inside the fence: %r"
               % (py_fenced[2],))

for b in bad:
    print(b, file=sys.stderr)
sys.exit(1 if bad else 0)
'
if python3 -c "$BLOCK_SCALAR_PARITY"; then
    echo "   the block-scalar rule agrees in both languages over 11 shapes and 4 whole sections, the two fence readers agree line for line on all 4, and 4 more shapes keep a real declaration visible"
else
    FAILED="${FAILED}BLOCKSCALAR: the two block-scalar helpers disagree, or the rule is a no-op\n"
fi

# ---- Test 16: the filename-extension list is one list in three files ----
#
# The money guard's whole judgement is FILENAME_EXTENSIONS, and it lives in
# tools/validate.py, web/lib/_validate.mjs and scripts/passport-to-page.py,
# because the last of those deliberately imports nothing. parity.mjs holds the
# first two to one verdict on the fixtures but cannot read the lists, and a
# fixture carries only the extensions somebody thought to write down. This
# reads all three sets out of the source and requires them equal, so adding an
# extension to one file fails here until it reaches the other two.
EXT_PARITY='
import re, sys
def read_set(path, head):
    text = open(path, encoding="utf-8").read()
    i = text.index(head) + len(head)
    body = text[i:text.index("}" if path.endswith(".py") else "]", i)]
    # Any quoted string, not [a-z0-9]: an entry with an underscore or a
    # capital was invisible to this reader, so "pay_out" would have joined
    # the list unseen by every check below.
    return set(re.findall(r"[\x27\"]([^\x27\"]+)[\x27\"]", body))
py = read_set("validate.py", "FILENAME_EXTENSIONS = {")
js = read_set("../web/lib/_validate.mjs", "const FILENAME_EXTENSIONS = new Set([")
pg = read_set("../scripts/passport-to-page.py", "token[len(\"money.\"):] not in {")
bad = []
if not py: bad.append("could not read FILENAME_EXTENSIONS out of validate.py")
# Every entry is lower-case letters and digits. The guard folds A-Z and
# compares exact strings, so an entry with a capital could never match and
# an entry with punctuation is not an extension; either is a mistake.
odd = sorted(e for e in py if not re.fullmatch(r"[a-z0-9]+", e))
if odd: bad.append("FILENAME_EXTENSIONS entries must be [a-z0-9]+: %r" % odd)
if py != js: bad.append("validate.py and _validate.mjs disagree: %r" % sorted(py ^ js))
if py != pg: bad.append("validate.py and passport-to-page.py disagree: %r" % sorted(py ^ pg))

# No entry may be a way of spending money. The list is the whole judgement
# of the money guard, and an entry like "transfer" would skip exactly the
# token the guard exists to refuse. Nothing structural separates an extension
# from a verb, so this is enforced against evidence rather than shape, two
# ways. First, against every money id the repository itself names: the
# vocabulary examples, every capability_ref in a fixture or example, and the
# probe tables in both suites that assert a token IS an id. That set grows
# with the corpus and cannot be satisfied by an editor who only edits the
# list. Second, against a floor list of money verbs, which is only the words
# somebody thought of and is here so the first check is not the only one.
import glob, os
named = set()
def add(text, pattern):
    for tok in re.findall(pattern, text):
        named.add(tok.lower())
# Sources where a money token is an id BY CONSTRUCTION, not prose that may
# name one as a filename: capability_ref lines, the vocabulary line that
# lists example ids, and the probe rows in both suites that assert a token
# IS a write id (True here, true or REFUSE there). A first version scanned
# the spec prose too and fired on money.xlsx the moment the spec named it
# as a filename, which is the probe being honest about an ambiguous source.
for path in glob.glob("fixtures/passports/*.md") + glob.glob("../examples/*.md"):
    add(open(path, encoding="utf-8").read(), r"capability_ref:\s*[\"\x27]?money\.([A-Za-z0-9_]+)")
for line in open("../spec/vocabulary.md", encoding="utf-8"):
    if "is a prefix, not an id:" in line:
        add(line, r"`money\.([A-Za-z0-9_]+)`")
# Per entry, not per line: one line can hold a True probe beside a False one.
sh = open("run_tests.sh", encoding="utf-8").read()
add(sh, r"\(\"`money\.([A-Za-z0-9_]+)`\",\s*[^,]+,\s*True")      # test 15 PROBES rows
add(sh, r"\(\"money\.([A-Za-z0-9_]+)\",\s*True\)")               # is_declared_only rows
js = open("../web/tools/run-tests.mjs", encoding="utf-8").read()
add(js, r"\[\x27money\.([A-Za-z0-9_]+)\x27,\s*[^,\]]+,\s*true\]")  # consentTokenIsWriteId rows
add(js, r"\[\x27[^\x27]*`money\.([A-Za-z0-9_]+)`[^\x27]*\x27,\s*\x27REFUSE")  # CASES rows
# One carve-out, with its reason at the line: the declared-wins probes in
# both suites assert that a DECLARED money.csv is read as an id, so csv is
# named as an id there on purpose. Nothing else joins this set without a
# probe that shows the token being read as a file.
named -= {"csv"}
hit = py & named
if hit: bad.append("FILENAME_EXTENSIONS contains a suffix the repository names as a money id: %r" % sorted(hit))
VERBS = {"transfer", "send", "pay", "wire", "trade", "authorise", "authorize", "move",
         "spend", "withdraw", "deposit", "buy", "sell", "invoice", "refund", "charge",
         "purchase", "donate", "remit", "settle", "payout", "transact", "order", "bid",
         "stake", "swap", "tip", "fund", "lend", "borrow", "pledge", "commit", "release",
         # nine more a critic found outside the first list: rails and nouns of paying
         "sepa", "ach", "iban", "swift", "payment", "remittance", "disburse", "topup", "cashout"}
hit = py & VERBS
if hit: bad.append("FILENAME_EXTENSIONS contains a money verb: %r" % sorted(hit))
if not (named & VERBS): bad.append("the corpus scan found no money verb at all, so it is reading nothing")

# Everything above reads the list out of the source text. The set the guard
# actually consults is the one in memory, and a line after the literal can
# grow it (FILENAME_EXTENSIONS.add("payment")) without the text reader
# seeing a thing; a critic did exactly that and the suite stayed green. So
# the last word is behavioural: every money word the corpus or the floor
# names is put to each runtime as money.<word>, and each must read it as an
# id. This is the check a grown set cannot pass, however it was grown.
sys.path.insert(0, ".")
import importlib.util, json, subprocess
import validate as v
words = sorted((named | VERBS) - {"csv"})
miss = [w for w in words if not v.consent_token_is_write_id("money." + w, set())]
if miss: bad.append("validate.py at runtime reads these as filenames: %r" % miss)
spec = importlib.util.spec_from_file_location("pg", "../scripts/passport-to-page.py")
pg_mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(pg_mod)
miss = [w for w in words if pg_mod.vocabulary_ref("`money." + w + "`") != "money." + w]
if miss: bad.append("passport-to-page.py at runtime reads these as filenames: %r" % miss)
if os.path.exists("../web/lib/_validate.mjs"):
    try:
        out = subprocess.run(["node", "--input-type=module", "-e",
            "import {consentTokenIsWriteId as f} from \"./../web/lib/_validate.mjs\";"
            "const w=JSON.parse(process.argv[1]);"
            "console.log(JSON.stringify(w.filter(x=>!f(\"money.\"+x,new Set()))))",
            json.dumps(words)], capture_output=True, text=True)
        if out.returncode != 0: bad.append("node could not run the JS runtime probe: " + out.stderr.strip()[:300])
        else:
            miss = json.loads(out.stdout)
            if miss: bad.append("_validate.mjs at runtime reads these as filenames: %r" % miss)
    except FileNotFoundError:
        print("EXTENSIONS: JS runtime probe skipped, node is not installed", file=sys.stderr)
for b in bad: print(b, file=sys.stderr)
sys.exit(1 if bad else 0)
'
if ! python3 -c "$EXT_PARITY"; then
    FAILED="${FAILED}EXTENSIONS: FILENAME_EXTENSIONS differs between its copies or contains a money verb\n"
fi

# ---- Test 18: the whitespace alphabet is one alphabet in two runtimes ----
#
# ROW-211. Python and JavaScript disagree about which characters are `\s`, and
# every rule that skips whitespace to decide what a passport DECLARES inherits
# that disagreement. Measured over every codepoint: Python also calls \x1c \x1d
# \x1e \x1f and \x85 whitespace, JavaScript also calls \ufeff whitespace, and
# nothing else differs. Six characters, and a critic turned each of them into a
# document the two gates read differently. Two of those documents returned
# OPPOSITE VERDICTS, and on one the permissive side was the public gate.
#
# So the classes are written out, WS_ANY and WS_BOTH, and this test holds them
# to three things at once, because pinning any two of the three leaves a way to
# be wrong: they must be the same set in both languages, they must be the union
# and the intersection of what the two live engines actually do, and the
# compiled readers built from them must behave identically. A test that only
# compared the two files would go green on two identical wrong classes; one
# that only compared against the engines would not notice a typo in one file.
WS_PARITY='
import json, re, subprocess, sys, importlib.util, shutil

sys.path.insert(0, ".")
import validate as v

def members(cls, lo=0, hi=0x110000):
    r = re.compile("[%s]" % cls)
    return [i for i in range(lo, hi) if r.match(chr(i))]

py_engine = [i for i in range(0x110000) if re.match(r"\s", chr(i))]
py_any = members(v.WS_ANY)
py_both = members(v.WS_BOTH)

bad = []

# 1. WS_BOTH_CHARS is the class expanded, and it is derived rather than typed,
#    so this only fails if somebody replaces the derivation with a literal.
if sorted(ord(c) for c in v.WS_BOTH_CHARS) != [i for i in py_both if i <= 0x3000]:
    bad.append("WS_BOTH_CHARS is not WS_BOTH expanded: %r" % [hex(ord(c)) for c in v.WS_BOTH_CHARS])

# 2. THE THIRD COPY. scripts/passport-to-page.py imports nothing on purpose and
#    carries its own WS_BOTH. Same reason FILENAME_EXTENSIONS is checked in
#    three places by test 16: a copy nobody compares is a copy that drifts.
spec = importlib.util.spec_from_file_location("pg", "../scripts/passport-to-page.py")
pg = importlib.util.module_from_spec(spec); spec.loader.exec_module(pg)
if members(pg.WS_BOTH) != py_both:
    bad.append("passport-to-page.py WS_BOTH is not the same set as validate.py WS_BOTH")
if sorted(ord(c) for c in pg.WS_BOTH_CHARS) != sorted(ord(c) for c in v.WS_BOTH_CHARS):
    bad.append("passport-to-page.py WS_BOTH_CHARS diverged from validate.py")

# 3. THE FENCE ALPHABET IS NARROW, in all three files, and this is the opposite
#    width from WS_ANY on purpose. Wider here means more lines look like fences,
#    which means more lines are read as prose and FEWER declarations are seen:
#    the fail-OPEN direction. A critic built two documents on that, one of which
#    the public gate accepted while the local loop refused it.
#    THE SAME GOES FOR EVERY REGEX THAT DECIDES MARKDOWN STRUCTURE, and the
#    heading is the one that was missed. A section boundary ends section 3, so a
#    wider class ends it EARLIER and the declarations after it are never read.
#    A critic built `##\ufeffExtra`: a heading to JavaScript, not to Python, and
#    the site accepted a write declaration the normative gate refused.
sec = open("../web/lib/_sections.mjs", encoding="utf-8").read()
md_srcs = [("validate.py FENCE_DELIM", v.FENCE_DELIM.pattern),
           ("validate.py SECTION_BOUNDARY_RE", v.SECTION_BOUNDARY_RE.pattern),
           ("passport-to-page.py FENCE", pg.FENCE.pattern),
           ("passport-to-page.py SECTION_BOUNDARY", pg.SECTION_BOUNDARY.pattern),
           ("passport-to-page.py ANY_HEADING", pg.ANY_HEADING.pattern),
           ("passport-to-page.py TABLE_ROW", pg.TABLE_ROW.pattern),
           ("passport-to-page.py LIST_ITEM", pg.LIST_ITEM.pattern)]
for const in ("FENCE", "SECTION_BOUNDARY", "ANY_HEADING"):
    m = re.search(r"export const %s = /([^/]+)/;" % const, sec)
    if not m:
        bad.append("could not find %s in web/lib/_sections.mjs" % const)
    else:
        md_srcs.append(("_sections.mjs " + const, m.group(1)))
for const in ("TABLE_ROW", "LIST_ITEM"):
    m = re.search(r"^const %s = /([^/]+)/;" % const, sec, re.M)
    if not m:
        bad.append("could not find %s in web/lib/_sections.mjs" % const)
    else:
        md_srcs.append(("_sections.mjs " + const, m.group(1)))
for name, pat in md_srcs:
    # NOT "does it start with the right class": a bare \s ANYWHERE in one of
    # these is the defect, and the first version of this check only looked at
    # the head, which would have passed `^#{1,2}\s` had it been spelled
    # `^[ \t]*#{1,2}\s`.
    if "\\s" in pat:
        bad.append("%s still uses \\s, which is not one alphabet across the two "
                   "runtimes: %r" % (name, pat))
    if not re.match(r"\^(\[ \\t\]\*)?[#`\\|\[]", pat):
        bad.append("%s is not anchored to the narrow class or a literal: %r" % (name, pat))

if shutil.which("node") is None:
    print("   WSPARITY: JS side skipped, node is not installed", file=sys.stderr)
else:
    prog = (
        "import { WS_ANY, WS_BOTH, CAPABILITY_REF, CAPABILITY_REF_LINE, STATUS, scalar,"
        " structuralTrim, yamlTrim } from \"../web/lib/_validate.mjs\";\n"
        "const mem = c => { const r = new RegExp(\"[\" + c + \"]\");"
        " const o = []; for (let i = 0; i < 0x110000; i++)"
        " if (r.test(String.fromCodePoint(i))) o.push(i); return o; };\n"
        "const eng = []; for (let i = 0; i < 0x110000; i++)"
        " if (/\\s/u.test(String.fromCodePoint(i))) eng.push(i);\n"
        "const probe = [];\n"
        "for (const cp of [0x1c,0x1d,0x1e,0x1f,0x85,0xfeff,0xa0,0x20,0x09,0x3000]) {\n"
        "  const ch = String.fromCodePoint(cp);\n"
        "  const cps = s => s === null ? null : [...s].map(c => c.codePointAt(0));\n"
        "  probe.push([cp,\n"
        "    cps((ch + \"- capability_ref: email.send\").match(CAPABILITY_REF_LINE)?.[1] ?? null),\n"
        "    cps((\"capability_ref:\" + ch + \"email.send\").match(CAPABILITY_REF)?.[1] ?? null),\n"
        "    cps((\"capability_ref: email.send\" + ch).match(CAPABILITY_REF)?.[1] ?? null),\n"
        "    cps((\"status:\" + ch + \"used\").match(STATUS)?.[1] ?? null),\n"
        "    cps(scalar(ch + \"email.send\" + ch)),\n"
        "    cps(structuralTrim(ch + \"## 3. Functional spec\" + ch)),\n"
        "    cps(yamlTrim(ch + \"- capability_ref: email.send\"))]);\n"
        "}\n"
        "const blockDocs = JSON.parse(process.argv[1]);\n"
        "const { validate } = await import(\"../web/lib/_validate.mjs\");\n"
        "const { derive } = await import(\"../web/lib/_derive.mjs\");\n"
        "const walk = blockDocs.map(d => {\n"
        "  const v = validate(d);\n"
        "  if (v.errors.length) return \"REFUSE:\" + v.errors.map(e => e.code).join(\",\");\n"
        "  const r = derive(v.front, v.lines);\n"
        "  return r.error ? \"REFUSE:\" + r.error.code : \"ACCEPT\";\n"
        "});\n"
        "console.log(JSON.stringify({any: mem(WS_ANY), both: mem(WS_BOTH), eng, probe, walk}));\n"
    )
    # REAL PASSPORTS, read off disk, not a synthetic stub. The first version of
    # this probe built a minimal document that the JS gate refused for having no
    # section 1, so the assertion below was satisfied by the WRONG refusal and
    # would have passed with the block walk fully reverted. A probe whose
    # subject is refused for an unrelated reason is not a probe.
    _WALK = ["invalid_envelope_caps_bom.md", "invalid_envelope_caps_fs.md",
             "invalid_envelope_caps_nel.md"]
    block_docs = [open("fixtures/passports/" + f, encoding="utf-8").read()
                  for f in _WALK]
    r = subprocess.run(["node", "--input-type=module", "-e", prog,
                        json.dumps(block_docs)], capture_output=True, text=True)
    if r.returncode != 0:
        bad.append("node refused the whitespace probe: " + (r.stderr or "").strip()[:300])
    else:
        js = json.loads(r.stdout)
        # BOTH GATES on the same three documents. Each carries email.send at
        # status: used behind an invisible character that ended the capabilities
        # block for one engine and not the other. The Python half is asserted
        # separately below, because an earlier version of this probe checked
        # only the Python helper and stayed green while the JS half was reverted.
        for i, verdict in enumerate(js["walk"]):
            if not verdict.startswith("REFUSE"):
                bad.append("the hosted gate %s %s, whose capabilities block was "
                           "ended early by an invisible character, so email.send "
                           "at status: used reached a reader as installable"
                           % (verdict, _WALK[i]))
        for f in _WALK:
            r2 = subprocess.run([sys.executable, "validate.py", "fixtures/passports/" + f],
                                capture_output=True, text=True)
            if r2.returncode == 0:
                bad.append("tools/validate.py, the NORMATIVE gate, exits 0 on %s, "
                           "which declares email.send at status: used" % f)
        # 4. THE SAME SET IN BOTH LANGUAGES.
        if js["any"] != py_any:
            bad.append("WS_ANY is not the same set in the two files: py only %r, js only %r"
                       % ([hex(i) for i in sorted(set(py_any) - set(js["any"]))],
                          [hex(i) for i in sorted(set(js["any"]) - set(py_any))]))
        if js["both"] != py_both:
            bad.append("WS_BOTH is not the same set in the two files: py only %r, js only %r"
                       % ([hex(i) for i in sorted(set(py_both) - set(js["both"]))],
                          [hex(i) for i in sorted(set(js["both"]) - set(py_both))]))
        # 5. AND THE RIGHT SETS, measured against the two LIVE engines rather
        #    than against a list somebody wrote down. If a runtime changes what
        #    it calls whitespace, this is where it is noticed.
        union = sorted(set(py_engine) | set(js["eng"]))
        inter = sorted(set(py_engine) & set(js["eng"]))
        if py_any != union:
            bad.append("WS_ANY is not the union of the two engines: missing %r, extra %r"
                       % ([hex(i) for i in sorted(set(union) - set(py_any))],
                          [hex(i) for i in sorted(set(py_any) - set(union))]))
        if py_both != inter:
            bad.append("WS_BOTH is not the intersection of the two engines: missing %r, extra %r"
                       % ([hex(i) for i in sorted(set(inter) - set(py_both))],
                          [hex(i) for i in sorted(set(py_both) - set(inter))]))
        if set(py_engine) == set(js["eng"]):
            bad.append("the two engines now agree about \\s, which they did not on "
                       "2026-09-07. That is not a failure, it is news: re-read this "
                       "test and decide whether two classes are still wanted.")
        # 6. AND THE READERS BUILT FROM THEM BEHAVE THE SAME. Sets can match
        #    while a regex is assembled differently, and that is the shape
        #    parity-compares-regex-source-not-behaviour warns about.
        for cp, lead, sep, tail, st, sc, strt, ymt in js["probe"]:
            ch = chr(cp)
            def cps(m):
                return None if m is None else [ord(c) for c in m]
            def g(rx, s):
                mm = rx.search(s)
                return cps(mm.group(1)) if mm else None
            mine = [g(v.CAPABILITY_REF_LINE, ch + "- capability_ref: email.send"),
                    g(v.CAPABILITY_REF, "capability_ref:" + ch + "email.send"),
                    g(v.CAPABILITY_REF, "capability_ref: email.send" + ch),
                    g(v.STATUS, "status:" + ch + "used"),
                    cps(v.scalar(ch + "email.send" + ch)),
                    # THE TWO TRIMS. Everything else here pins the CLASSES, and a
                    # critic reverted structural_trim() to str.strip() in one
                    # line while this test stayed green and the gates split on a
                    # heading with a trailing \x85. A class nobody trims with is
                    # a class that does nothing.
                    cps(v.structural_trim(ch + "## 3. Functional spec" + ch)),
                    cps(v.yaml_trim(ch + "- capability_ref: email.send"))]
            if mine != [lead, sep, tail, st, sc, strt, ymt]:
                bad.append("the readers disagree on U+%04X:\n    py: %r\n    js: %r"
                           % (cp, mine, [lead, sep, tail, st, sc, strt, ymt]))

# 7. THE RULE HAS TO DO SOMETHING. Two agreeing no-ops pass everything above.
if not v.CAPABILITY_REF_LINE.match("\x1c- capability_ref: email.send"):
    bad.append("WS_ANY does not skip \\x1c, so the \\ufeff gate reads a declaration "
               "this one does not")
if not v.CAPABILITY_REF_LINE.match("\ufeff- capability_ref: email.send"):
    bad.append("WS_ANY does not skip \\ufeff, so the site reads a declaration this "
               "gate does not")
m = v.CAPABILITY_REF.search("capability_ref: email.send\x1c")
if m is None or m.group(1) == "email.send":
    bad.append("the value class swallowed a \\x1c, so an id with an invisible "
               "character in it is read as the clean id")
for cp in (0x1c, 0x1d, 0x1e, 0x1f, 0x85, 0xfeff):
    if v.SECTION_BOUNDARY_RE.match("##" + chr(cp) + "Extra"):
        bad.append("U+%04X after the hashes is a heading here. It is not one to a "
                   "renderer, and calling it one ends section 3 early, which is how "
                   "a declaration below it stops being seen" % cp)
# 7b. THE TRIMS ARE OPPOSITE WIDTHS, and each is used where it is. Two equal
#     trims would satisfy every cross-language comparison above.
for cp in (0x1c, 0x1d, 0x1e, 0x1f, 0x85, 0xfeff):
    ch = chr(cp)
    if v.structural_trim(ch + "## 3. Functional spec") == "## 3. Functional spec":
        bad.append("structural_trim removed U+%04X, so a heading only one engine "
                   "recognises is the heading here too, and the two gates find "
                   "section 3 in different places" % cp)
    if v.yaml_trim(ch + "- capability_ref: email.send") != "- capability_ref: email.send":
        bad.append("yaml_trim did not remove U+%04X, so a declaration behind it "
                   "ENDS the capabilities block and check 16a never sees the "
                   "entry. That is the normative gate passing a write capability "
                   "at status: used" % cp)
# 7c. AND THE BLOCK WALK ITSELF, through yaml_block(), because both trims could
#     be right while the caller still uses str.strip().
_BLOCK_DOC = ("## 3. Functional spec\n\n```yaml\ncomparison_mode: structural\n\n"
              "capabilities:\n  - capability_ref: files.read\n    status: used\n"
              "%s- capability_ref: email.send\n%s  status: used\n```\n\n"
              "## 4. Golden examples\n")
for cp in (0x1c, 0x85, 0xfeff):
    kept = [l for _n, l in v.yaml_block(v.spec_lines(_BLOCK_DOC % (chr(cp), chr(cp))),
                                        "capabilities")]
    if not any("email.send" in l for l in kept):
        bad.append("U+%04X ended the capabilities block early, so the entry below "
                   "it is not checked: %r" % (cp, kept))
if not v.SECTION_BOUNDARY_RE.match("## Extra"):
    bad.append("the heading class no longer matches an ordinary heading, so the "
               "section boundary rule is a no-op")
if v.FENCE_DELIM.match("\ufeff```"):
    bad.append("the fence class is wide again: \\ufeff``` is not a fence to any "
               "renderer, and calling it one is how the site accepted a passport "
               "this file refused")

for b in bad:
    print(b, file=sys.stderr)
sys.exit(1 if bad else 0)
'
if python3 -c "$WS_PARITY"; then
    echo "   the whitespace alphabet is one alphabet: WS_ANY and WS_BOTH agree across three files and are the union and intersection of the two live engines, over every codepoint"
else
    FAILED="${FAILED}WHITESPACE: the two runtimes do not share one whitespace alphabet\n"
fi

# ---- Test 19: no unreviewed whitespace primitive in the five reading files ----
#
# ROW-211, and this test exists because test 18 was the wrong shape. Test 18
# reads a whitelist of named regex constants and fails on a bare backslash-s
# inside one. A critic then found SIX families of gate divergence, one at a
# time, over several hours, and FOUR OF THEM WERE NOT REGEXES: str.strip()
# against .trim(), str.isspace() against /^\s/, in the capabilities block
# terminator, the block-scalar blank test, the consent table row split and the
# frontmatter delimiter. One of them, `caps_bom.md`, made tools/validate.py, the
# normative gate, exit 0 on a passport declaring email.send at status: used.
# Another, `rowhide_nel.md`, passed BOTH gates and published a consent table
# with a capability missing.
#
# The general form is worth naming because it is what went wrong: THE CHECK WAS
# LOOKING WHERE THE FIX WENT. A scan for backslash-s in patterns cannot see a
# problem that is not in a pattern, and writing it that way felt complete
# because every hole known at the time was in a pattern.
#
# So this scans for the PRIMITIVE, in the five files that read a passport, and
# requires every occurrence to be on a list with a reason beside it. A new one
# fails the suite until somebody writes down why it cannot make the two gates
# disagree. It is deliberately noisy: a display-only .trim() costs one line of
# JSON, and that is cheaper than the afternoon this cost.
WS_PRIMITIVES='
import collections, json, re, sys

FILES = [("validate.py", "validate.py"),
         ("passport-to-page.py", "../scripts/passport-to-page.py"),
         ("_validate.mjs", "../web/lib/_validate.mjs"),
         ("_sections.mjs", "../web/lib/_sections.mjs"),
         ("_derive.mjs", "../web/lib/_derive.mjs")]

# Comments and docstrings are excluded: this whole change is documented in prose
# that says the words str.strip() and backslash-s dozens of times, and a scan
# that counted those would be pure noise and would be silenced rather than read.
def code_lines(path):
    out, js, inblk, indoc = [], path.endswith(".mjs"), False, False
    for line in open(path, encoding="utf-8"):
        s = line.strip()
        if js:
            if inblk:
                if "*/" in s: inblk = False
                continue
            if s.startswith("/*"):
                if "*/" not in s: inblk = True
                continue
            if s.startswith("//") or s.startswith("*"): continue
        else:
            q = s.count(chr(34) * 3)
            if indoc:
                if q: indoc = False
                continue
            if s.startswith(chr(34) * 3) or s.startswith("r" + chr(34) * 3):
                if q < 2: indoc = True
                continue
            if s.startswith("#"): continue
        out.append(s)
    return out

# Every spelling of "consult a runtime whitespace class". The first version
# of this list held only the ones the fix had touched, which is the same
# mistake one level up: str.split() with no argument splits on the Python
# whitespace set and .replace(/\\s+/g," ") on the JavaScript one, and the pair sat
# live in the two renderers while the scan read past them. Backslash-S is
# here for the same reason backslash-s is: it is a class, and the two
# runtimes disagree about its complement exactly as much.
# Two rounds of this list have now been widened by a critic naming a spelling
# that was not on it, so it is written as METHOD NAMES with the argument list
# left open rather than as exact call sites. `s.split()` and `s.split(None)`
# are the same function, and the first version of this named only the first;
# the mutation that defeated test 19 came back spelled with an explicit None.
# The Python trims take an optional argument, and the whole point of the
# ROW-211 conversion is that a trim with an explicit WS_ANY_CHARS argument is
# the FIXED form, so those three are matched only in their bare and None-
# argument spellings.
#
# The Unicode property escapes are here because they are the most natural
# JavaScript spelling of "consult the runtime whitespace class" and neither
# earlier version named them: /\p{White_Space}/u and /\p{Zs}/u are exactly
# the thing this check exists to find, and they carry the runtime Unicode
# table with them, which is ROW-214 as well.
PRIM = re.compile(r"\.strip\((?:None)?\)|\.lstrip\((?:None)?\)"
                  r"|\.rstrip\((?:None)?\)|\.trim\(\)"
                  r"|\.isspace\(\)|\.split\((?:None|sep=None)?\)"
                  r"|\.rsplit\((?:None[^)]*)?\)|splitlines\(|\.expandtabs\("
                  r"|re\.split\(|shlex\.split\(|unicodedata\.category\("
                  r"|\.trimStart|\.trimEnd|\.title\(\)|\\s|\\S"
                  r"|White_Space|\\p\{Z")

# COUNTED, not a set. code_lines() strips each line, so two source lines that
# differ only in indentation collapse to one key and one written reason covers
# a line nobody read. That was already true: 20 occurrences, 19 distinct keys,
# with one _derive.mjs line appearing twice. The allowlist carries an entry per
# occurrence now.
live = collections.Counter()
for label, path in FILES:
    for s in code_lines(path):
        if PRIM.search(s):
            # The whole line, not a prefix. A 56-character key collapses two
            # distinct sites into one allowlist entry, so one reason covers
            # a line nobody read.
            live[label + " :: " + s] += 1

doc = json.load(open("fixtures/whitespace_primitives.json"))
allowed = collections.Counter(e["site"] for e in doc["entries"])

bad = []
for s in sorted(live - allowed):
    bad.append("UNREVIEWED whitespace primitive. It may decide what a passport "
               "declares, and nothing says it does not:\n    " + s +
               "\n  Convert it to WS_ANY, WS_BOTH or WS_MD, or add it to "
               "tools/fixtures/whitespace_primitives.json with the reason it "
               "cannot make the two gates disagree.")
for s in sorted(allowed - live):
    bad.append("STALE entry in fixtures/whitespace_primitives.json: this line is "
               "no longer in the source, so its reason is protecting nothing and "
               "the next reader will trust a list that has drifted:\n    " + s)

# The list has to SAY something. An entry with no reason is a rubber stamp, and
# this file is exactly the kind that grows them.
for e in doc["entries"]:
    if len(e.get("why", "")) < 40:
        bad.append("the reason for %r is too short to be a reason" % e["site"])

# And the scan has to be reading something. A regex that stopped matching would
# make every check above vacuous and green.
if sum(live.values()) < 10:
    bad.append("the primitive scan found only %d occurrences, which means it has "
               "stopped reading the source rather than that the source got "
               "clean" % sum(live.values()))

for b in bad:
    print(b, file=sys.stderr)
sys.exit(1 if bad else 0)
'
# ---- Test 20: the two RENDERERS agree, not just the two gates ----
#
# Test 18 pins the whitespace classes and test 19 pins the primitives, and both
# of them read the two GATES. Neither reads the two RENDERERS, and family eight
# lived exactly there: scripts/passport-to-page.py had
# `" ".join(front["title"].split())` and web/lib/_derive.mjs had
# `.trim().replace(/\s+/g, " ")`. Those are different functions over six
# characters, so `title: Daily<U+0085>Brief` became "Daily Brief" offline and
# kept the character on the site, and `title: Daily<U+FEFF>Brief` did the
# reverse. NEITHER GATE REFUSED EITHER FILE. Both renderers accepted it and
# produced different pages, so no parity check over verdicts could see it, and
# website/tools/build-samples.mjs runs the Python one to make what phaeacia.ai
# serves.
#
# So this compares OUTPUT rather than source: every fixture that both renderers
# accept must yield the same title and the same summary. A check over verdicts
# is blind to a divergence that changes only what a reader sees.
RENDER_AGREE='
import glob, importlib.util, json, os, subprocess, sys, tempfile

FILES = sorted(glob.glob("fixtures/passports/*.md") + glob.glob("fixtures/validator/*.md"))

JS = """
import { validate } from "./web/lib/_validate.mjs";
import { derive } from "./web/lib/_derive.mjs";
import { readFileSync } from "node:fs";
const out = {};
for (const f of JSON.parse(process.argv[2])) {
  const v = validate(readFileSync(f, "utf8"));
  if (v.errors.length) continue;
  const d = derive(v.front, v.lines);
  if (d.error) continue;
  out[f] = [d.record.title, d.record.summary];
}
console.log(JSON.stringify(out));
"""

with tempfile.NamedTemporaryFile("w", suffix=".mjs", dir="..", delete=False) as fh:
    fh.write(JS)
    jspath = fh.name
try:
    r = subprocess.run(["node", jspath, json.dumps([os.path.abspath(f) for f in FILES])],
                       capture_output=True, text=True)
    js = json.loads(r.stdout or "{}")
finally:
    os.unlink(jspath)

spec = importlib.util.spec_from_file_location("p2p", "../scripts/passport-to-page.py")

bad, compared = [], 0
for f in FILES:
    key = os.path.abspath(f)
    if key not in js:
        continue
    try:
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        d = m.build(f)
        py = [d.get("title"), d.get("description")]
    except BaseException:
        continue
    compared += 1
    if py != js[key]:
        bad.append("the two renderers disagree about %s, and no gate refuses it:\n"
                   "    passport-to-page.py %r\n    _derive.mjs         %r"
                   % (f, py, js[key]))

# AND THE HALF THE COMPARISON ABOVE CANNOT SEE. It only reads documents BOTH
# renderers accept, so a document one of them refuses is invisible to it by
# construction. The case that matters there is narrow and sharp: if
# validate.py says PASS and passport-to-page.py refuses the same file, in the
# same language on the same rule, an owner whose passport validates cannot
# render it, and the skill runs both. That happened tonight, and no comparison
# over agreed output could have shown it: giving consent_rows() fence
# awareness in validate.py and not in the renderer split the two apart.
for f in FILES:
    v = subprocess.run(["python3", "validate.py", f], capture_output=True, text=True)
    if v.returncode != 0:
        continue
    r = subprocess.run(["python3", "../scripts/passport-to-page.py", f],
                       capture_output=True, text=True)
    if r.returncode != 0:
        bad.append("validate.py says PASS on %s and passport-to-page.py refuses it:\n"
                   "    %s\n  Same language, same rule, opposite answers. An owner "
                   "whose passport validates cannot render it."
                   % (f, (r.stdout + r.stderr).strip().split(chr(10))[0]))

# A comparison that stopped comparing is green for the wrong reason. The Python
# renderer exits the process on a refusal, so a change that makes it refuse
# everything would empty this loop silently.
if compared < 20:
    bad.append("the renderer comparison ran on only %d documents, which means it "
               "has stopped reading the corpus rather than that the corpus "
               "shrank" % compared)

for b in bad:
    print(b, file=sys.stderr)
if not bad:
    print("   the two renderers agree on title and summary over %d documents, and "
          "every document validate.py passes renders" % compared)
sys.exit(1 if bad else 0)
'
# ---- Test 21: the REASON, not just the verdict ----
#
# A critic deleted the E_FENCE_INVISIBLE push from web/lib/_validate.mjs, alone,
# and the whole suite stayed green. The parity harness records ACCEPT or REFUSE
# and not the code, and with the tripwire gone the site still refuses those two
# fixtures, as E_GOLDEN_COUNT. That is the exact message the fix exists to
# replace: a byte-order mark reported as a complaint about golden examples.
#
# So the JavaScript half of family seven could regress all the way back to the
# wrong message with every check in this repository green. Verdict-level parity
# is structurally blind to it. These fixtures exist for their MESSAGE, so the
# message is what gets pinned.
CODE_FIXTURES='
import json, subprocess, sys

# fixture, the FAIL number tools/validate.py must report, the code the site must emit
WANT = [
    ("invalid_fence_invisible_bom.md",    "FAIL 8",  "E_FENCE_INVISIBLE"),
    ("invalid_fence_invisible_nbsp.md",   "FAIL 8",  "E_FENCE_INVISIBLE"),
    ("invalid_fence_invisible_in_frontmatter.md", "FAIL 8", "E_FENCE_INVISIBLE"),
    ("invalid_title_only_invisible.md",   "FAIL 2",  "E_DERIVE_TITLE"),
    ("invalid_title_too_long.md",         "FAIL 3",  "E_BAD_VALUE"),
    ("invalid_summary_too_short.md",      "FAIL 4",  "E_DERIVE_SUMMARY"),
    ("invalid_astral_summary.md",         "FAIL 4",  "E_DERIVE_SUMMARY"),
    ("invalid_frontmatter_line_41.md",    "FAIL 1",  "E_FRONTMATTER"),
    # A trailing space or NBSP after `---`. The site has always compared the
    # delimiter exactly; validate.py stripped WS_MD and, before that, str.strip(),
    # and a comment at 7fd7ed1 asserted the two were the same width. They were
    # not, and test 19 could not see it: it scans for bare primitives and takes
    # a named class as reviewed. Pinned by FAIL number and site code so the
    # exact comparison cannot quietly widen again on either side (critic-211e).
    ("invalid_frontmatter_open_trailing_space.md",  "FAIL 1",  "E_FRONTMATTER"),
    ("invalid_frontmatter_close_trailing_space.md", "FAIL 1",  "E_FRONTMATTER"),
    ("invalid_frontmatter_open_nbsp.md",            "FAIL 1",  "E_FRONTMATTER"),
    # The SHAPE half of the summary rule. _derive.mjs refused section 1 on any
    # heading, table row or fence line; validate.py measured length only, so
    # a sub-heading, a table row, a fenced block, or a `## 2.` heading with a
    # leading space (not a boundary to either gate, so section 1 runs on into
    # the consent table) were py PASS / js REFUSE. Four documents from
    # critic-211e, now refused by both for the same reason.
    ("invalid_summary_table_row.md",    "FAIL 4",  "E_DERIVE_SUMMARY"),
    ("invalid_summary_subheading.md",   "FAIL 4",  "E_DERIVE_SUMMARY"),
    ("invalid_summary_fence.md",        "FAIL 4",  "E_DERIVE_SUMMARY"),
    ("invalid_summary_indented_h2.md",  "FAIL 4",  "E_DERIVE_SUMMARY"),
    # A fence opened above `## 1.` and closed below it. The section
    # reader in validate.py skips fenced lines, so it found no section 1 and checked nothing;
    # the heading count ignores fences, so it saw one heading and was content.
    # PASS on a passport with no readable section 1. The site finds the heading
    # without fence tracking and refuses the fence line it then reads as
    # section 1. Both refuse now; the reasons differ and both are pinned.
    # Was E_DERIVE_SUMMARY, and the change is the point of ROW-223 rather than
    # a pin chased to match the code. The `## 1.` heading of this document sits
    # inside a fence with no unfenced copy, so there is no section 1 at all.
    # validate.py said exactly that on main ("the heading is inside a code
    # block"); the site counted the fenced heading, found section 1, read the
    # rest of the file as its summary and refused the FENCE LINE in it, so the
    # two gates refused the same document for two different reasons and this
    # table recorded that as expected. The heading count on the site skips fenced
    # lines now, so it refuses the missing section, which is what the other
    # gate has always said. Refusing for the right reason.
    ("invalid_summary_heading_fenced.md", "FAIL 4", "E_SECTIONS"),
    # ROW-221. A line spelled exactly like a section heading, placed INSIDE
    # the frontmatter block between the two --- lines, with the real heading
    # still present below. validate.py check 4 counted headings over
    # get_body(), the text after the closing ---, so it never saw the extra
    # one; _validate.mjs 4.2 counts over the whole file and refused the
    # duplicate. py ACCEPT / js REFUSE, pre-existing on main, fail-closed.
    # Check 4 counts over the file now. Built by critic-211e.
    #
    # The ticket proposed a different route, making parse_frontmatter refuse a
    # colonless non-blank line "which is what the site does". It is not what
    # the site does: _validate.mjs skips a line whose structuralTrim starts
    # with # before it ever tests for a pair. That route would have opened a
    # split rather than closed one, and the ticket itself said to check first.
    ("invalid_sec1_heading_in_frontmatter.md", "FAIL 4", "E_SECTIONS"),
    ("invalid_sec2_heading_in_frontmatter.md", "FAIL 4", "E_SECTIONS"),
    # ROW-223. The whole body inside one ``` fence opened at line 13 and never
    # closed: every section heading, section 1 prose and the entire consent
    # table are inside the code block. Neither heading count skipped fenced
    # lines, so on main BOTH gates accepted it and the site published a title,
    # a summary and a consent row read from inside a code block, showing the
    # reader a consent table the Markdown never contained as a table. Found by
    # critic-211h. Both counts skip fenced lines now.
    ("invalid_all_headings_fenced.md", "FAIL 4", "E_SECTIONS"),
    # THE FAIL-OPEN THESE TWO EXIST TO STOP COMING BACK, and it was shipped
    # for about an hour by the first spelling of the ROW-221 fix.
    #
    # `## 6. Losses` MOVED into the frontmatter block and deleted from the
    # body. A heading is a `#` line and a `#` line is a YAML comment to both
    # parsers, so a check 4 that counts over the whole file is satisfied by it
    # while the body has no losses section at all. This gate PASSED that
    # document. The losses table always rendering is not negotiable, so the
    # count is two-sided now: duplicates over the file, presence in the body.
    # Built by the critic on the batch, from the counterexample brief that
    # asked for the opposite case.
    ("invalid_losses_heading_only_in_frontmatter.md", "FAIL 4", "E_SECTIONS"),
    # The same shape on section 1, and the one where the SITE was the fail-open
    # half: sectionLines() found the heading in the frontmatter and derive()
    # published the closing `---` as the summary. Pre-existing on main, where
    # validate.py refused it from the other side so it was never a split.
    ("invalid_sec1_heading_only_in_frontmatter.md", "FAIL 4", "E_SECTIONS"),
]

JS = """
import { validate } from "./web/lib/_validate.mjs";
import { derive } from "./web/lib/_derive.mjs";
import { readFileSync } from "node:fs";
const out = {};
for (const f of JSON.parse(process.argv[2])) {
  const v = validate(readFileSync(f, "utf8"));
  if (v.errors.length) { out[f] = v.errors.map(e => e.code); continue; }
  const d = derive(v.front, v.lines);
  out[f] = d.error ? [d.error.code] : [];
}
console.log(JSON.stringify(out));
"""

import os, tempfile
paths = [os.path.abspath("fixtures/passports/" + n) for n, _p, _c in WANT]
with tempfile.NamedTemporaryFile("w", suffix=".mjs", dir="..", delete=False) as fh:
    fh.write(JS)
    jspath = fh.name
try:
    r = subprocess.run(["node", jspath, json.dumps(paths)], capture_output=True, text=True)
    if r.returncode != 0:
        print("node refused the code helper: " + (r.stderr or "").strip()[:300], file=sys.stderr)
        sys.exit(1)
    js = json.loads(r.stdout)
finally:
    os.unlink(jspath)

bad = []
for (name, want_py, want_js), path in zip(WANT, paths):
    out = subprocess.run(["python3", "validate.py", "fixtures/passports/" + name],
                         capture_output=True, text=True)
    text = out.stdout + out.stderr
    if want_py not in text:
        bad.append("%s: validate.py should report %s and reported:\n    %s"
                   % (name, want_py, text.strip().split(chr(10))[0]))
    if want_js not in js.get(path, []):
        bad.append("%s: the site should emit %s and emitted %r.\n"
                   "  Refusing for the wrong reason is not the same as refusing. The "
                   "verdict-level parity harness cannot see this, which is why the "
                   "code is pinned here."
                   % (name, want_js, js.get(path, [])))

for b in bad:
    print(b, file=sys.stderr)
if not bad:
    print("   %d fixtures refused for the stated reason, FAIL number and site code both" % len(WANT))
sys.exit(1 if bad else 0)
'
if python3 -c "$CODE_FIXTURES"; then
    :
else
    FAILED="${FAILED}CODES: a fixture is refused for a different reason than the one it exists to pin\n"
fi


# ---- Test 21b: the MESSAGE, not just the code ----
#
# Test 21 pins the code a fixture is refused with. It could not see this:
# 28f60e9 rewrote the E_DERIVE_TITLE row in site/spec/upload-validation.md to
# say "empty once invisible characters are removed", which is what the code
# means now that the length check fires first as E_BAD_VALUE, and left the
# string in web/lib/_validate.mjs saying "longer than 200 characters". The
# code was right, the fixture stayed pinned, and an owner whose title was one
# U+FEFF was told to shorten it. On main the two strings were identical; the
# fix split them. Found by critic-211e.
#
# So the spec's error table and the MESSAGES table are held equal, text for
# text, for every code the spec lists. The spec is the document a reader can
# check the site against, which makes it the one that must be true; a string
# that drifts in either file now fails here rather than in a stranger's
# browser. Placeholders like {row} are compared literally, so the two tables
# must also agree about where a placeholder carries its own leading space.
MESSAGE_TABLE='
import re, sys
spec = open("../site/spec/upload-validation.md", encoding="utf-8").read()
js = open("../web/lib/_validate.mjs", encoding="utf-8").read()
# Every three-cell row whose first cell is an HTTP status, backticks or not.
# A row read only when its code is backticked is a row that vanishes from the
# comparison the moment somebody drops the backticks, and critic-211f showed
# the first spelling of this test passing with a spec row unread and the
# site string replaced by nonsense. So the loose shape is read, and a row
# whose code cell is not exactly `E_NAME` is a failure, not a skip.
loose = re.findall(r"^\|\s*(\d{3})\s*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*$", spec, re.M)
rows = []
bad = []
for status, cell, text in loose:
    m = re.fullmatch(r"`(E_[A-Z0-9_]+)`", cell)
    if not m:
        bad.append("spec row with status %s has a code cell %r that is not one backticked E_ code" % (status, cell))
        continue
    rows.append((m.group(1), text))
# The MESSAGES object only, with block comments out FIRST, and the strings
# read from that same text. critic-211g put a sabotaged live string above a
# commented-out copy of the old one: the keys were read from the stripped
# object and saw one entry, the strings were read from the whole file and
# saw two, dict() kept the second, and the second matched the spec. Green,
# and the site would have served the sabotage. One text, stripped once, for
# both reads.
obj = js[js.index("export const MESSAGES = {"):]
obj = obj[:obj.index("\n};")]
obj = re.sub(r"/\*.*?\*/", "", obj, flags=re.S)
keys = re.findall(r"^\s*(E_[A-Z0-9_]+):", obj, re.M)
# Every key, however its value is spelled, so an entry whose string this
# regex cannot read (a template literal, a concatenation) is a failure
# rather than a silent drop.
ents = dict(re.findall(r"^\s*(E_[A-Z0-9_]+):\s*\x27((?:[^\x27\\]|\\.)*)\x27,?\s*$", obj, re.M))
# Codes the site defines and the spec table does not list, each with the
# reason. An entry here that stops being true fails below.
SITE_ONLY = {
    "E_SEND_UNPUBLISHED": "defined in MESSAGES and emitted nowhere in this tree at bf3ed5b; web-backend to keep or drop",
}
spec_codes = {c for c, _ in rows}
for k in keys:
    if k not in ents:
        bad.append("%s is in MESSAGES but its string could not be read as one single-quoted literal" % k)
    elif k not in spec_codes and k not in SITE_ONLY:
        bad.append("%s is in MESSAGES and not in the spec table, and not on the SITE_ONLY list with a reason" % k)
for k in SITE_ONLY:
    if k not in keys:
        bad.append("%s is on the SITE_ONLY list and no longer in MESSAGES; drop it from the list" % k)
    elif k in spec_codes:
        bad.append("%s is on the SITE_ONLY list and now in the spec table; drop it from the list" % k)
import collections
for k, n in collections.Counter(keys).items():
    if n > 1:
        bad.append("%s is defined %d times in MESSAGES; the last one wins silently" % (k, n))
seen = set()
for code, text in rows:
    if code in seen:
        bad.append("%s appears twice in the spec table" % code)
    seen.add(code)
    got = ents.get(code)
    if got is None:
        bad.append("%s is in the spec table and not in MESSAGES" % code)
        continue
    got = got.replace("\\\x27", "\x27")
    if got != text:
        i = next((k for k, (a, b) in enumerate(zip(text, got)) if a != b), min(len(text), len(got)))
        bad.append("%s: spec and _validate.mjs differ from offset %d:\n    spec: ...%s\n    site: ...%s"
                   % (code, i, text[max(0, i - 30):i + 50], got[max(0, i - 30):i + 50]))
if len(rows) < 40:
    bad.append("only %d spec rows read; the table moved or the reader broke" % len(rows))
for b in bad:
    print(b, file=sys.stderr)
if not bad:
    print("   %d error messages agree between the spec table and the site, text for text; %d MESSAGES keys, %d site-only by name" % (len(rows), len(keys), len(SITE_ONLY)))
sys.exit(1 if bad else 0)
'
if python3 -c "$MESSAGE_TABLE"; then
    :
else
    FAILED="${FAILED}MESSAGES: the spec error table and the MESSAGES table in _validate.mjs disagree on a message\n"
fi


if python3 -c "$RENDER_AGREE"; then
    :
else
    FAILED="${FAILED}RENDERERS: passport-to-page.py and _derive.mjs render the same passport differently, and no gate refuses it\n"
fi


if python3 -c "$WS_PRIMITIVES"; then
    echo "   every whitespace primitive in the five reading files is on the reviewed list, with a reason"
else
    FAILED="${FAILED}PRIMITIVES: an unreviewed whitespace primitive, or a stale entry on the reviewed list\n"
fi


# ---- The three section-2 slicers read the same lines ----
#
# ROW-218. Three implementations slice section 2 out of a passport, and until
# today two of them used one rule and the third used another. consent_rows()
# in validate.py ended the slice at the literal heading `## 3. Functional
# spec`; section_lines() in scripts/passport-to-page.py and sectionLines() in
# web/lib/_sections.mjs end a section at the next level-1 or level-2 heading
# outside a fence, whatever it is. A stray `## Notes` between sections 2 and 3
# therefore put the gate's window and the renderers' out of step, and the
# gate's was LARGER: it validated a consent row that neither renderer
# publishes, and on a malformed stray line it refused the owner's table by
# number while every row the owner could see had five columns.
#
# THE FIX IS NOT THE VALUABLE HALF. Test 17 pins the four fence WALKS, and a
# critic diffed those over 4343 generated line sequences and found zero
# disagreements, so the parsers have never been the problem. Nothing pinned
# what gets HANDED to them, and all three section-reading defects found in the
# ROW-211 work came from exactly there: the substring anchor, the fence-blind
# slice, and this. Pin the input, not just the parser.
#
# This compares the two PYTHON slicers, line for line, over every fixture.
# The third leg is already pinned: web/tools/parity.mjs compares
# sectionParts(sectionLines(...)) in _sections.mjs against
# passport-to-page.py --dump-parts for sections 2, 4 and 6 on all 110
# fixtures. So this test plus that one make all three agree transitively, and
# neither can be dropped without the other going red on the first divergence.
# Stated as a transitive argument on purpose: it is weaker than comparing all
# three here directly, and comparing all three here would need a new dump flag
# on the gate, which is a public surface added to pin a private agreement.
SECTION2_SLICERS='
import glob, sys
sys.path.insert(0, ".")
sys.path.insert(0, "../scripts")
import validate
from importlib import util as _util
_spec = _util.spec_from_file_location("p2p", "../scripts/passport-to-page.py")
p2p = _util.module_from_spec(_spec)
_spec.loader.exec_module(p2p)

HEADING = "## 2. What it needs from you"
bad = []
checked = 0
files = sorted(glob.glob("fixtures/passports/*.md")) + ["../examples/daily-brief-passport.md"]
for f in files:
    text = open(f, encoding="utf-8").read()
    body = validate.get_body(text)
    # The renderers name the section by heading and take the lines after it.
    want = p2p.section_lines(body.split("\n"), HEADING)
    got = validate.consent_window(body)
    if got is None:
        # No section 2 to slice. The renderer must agree there is none, or the
        # gate is silently declining to check a section the site will render.
        if want:
            bad.append("%s: the gate found no section 2 and the renderer found %d lines"
                       % (f, len(want)))
        continue
    checked += 1
    if got != want:
        i = next((k for k, (a, b) in enumerate(zip(got, want)) if a != b),
                 min(len(got), len(want)))
        bad.append("%s: gate slice and renderer slice differ at line %d of the section\n"
                   "    gate:     %r\n    renderer: %r\n    gate has %d lines, renderer %d"
                   % (f, i, got[i:i + 1], want[i:i + 1], len(got), len(want)))
if checked < 40:
    bad.append("only %d fixtures had a section 2 to compare; the corpus moved or the reader broke" % checked)
for b in bad:
    print(b, file=sys.stderr)
if not bad:
    print("   the gate and the renderer slice section 2 to the same lines on %d fixtures" % checked)
sys.exit(1 if bad else 0)
'
if python3 -c "$SECTION2_SLICERS"; then
    :
else
    FAILED="${FAILED}SECTION2: consent_rows() and section_lines() disagree about where section 2 ends\n"
fi


# ---- Final ----
# ---- No secret rule may fire on our own fixtures ----
#
# preflight.py's comments say a hit on a fixture passport, a validator fixture
# or a golden example disqualifies a rule outright, because those are the
# documents the gate exists to PASS. That was a stated methodology with nothing
# enforcing it: every one of those 34 files is read by validate.py in this suite
# and by NOTHING that runs the secret table over it. So the disqualifier was a
# promise about how rules get added, kept by whoever remembered.
#
# It is the same shape as the spec-table check twenty lines up: a rule set that
# is not compared is a rule set that drifts. Making it an assertion costs one
# loop and turns "we check this when adding a rule" into "this cannot stop being
# true without the suite saying so".
FIXTURE_CLEAN='
import glob, sys
sys.path.insert(0, ".")
import preflight, scrub

files = sorted(glob.glob("fixtures/passports/*.md")
               + glob.glob("fixtures/validator/*.md")
               + glob.glob("../examples/*.md"))
if len(files) < 30:
    print("   only %d fixture documents found; this check has lost its corpus"
          % len(files), file=sys.stderr)
    sys.exit(1)

hits = []
for f in files:
    text = open(f, encoding="utf-8").read()
    for label, pat in preflight.SECRETS:
        if pat.search(text):
            hits.append("%s: preflight rule %r fires" % (f, label))
    for label, pat in scrub.PATTERNS:
        if pat.search(text):
            hits.append("%s: scrub rule %r fires" % (f, label))

for h in hits:
    print("   " + h, file=sys.stderr)
if hits:
    print("   A rule that refuses one of our own valid documents is wrong no "
          "matter how good it looks elsewhere. Narrow the rule; do not edit "
          "the fixture to suit it.", file=sys.stderr)
    sys.exit(1)
print("   %d fixture documents, no secret or scrub rule fires on any of them"
      % len(files))
'
if ! python3 -c "$FIXTURE_CLEAN"; then
    FAILED="${FAILED}FIXTURES: a secret or scrub rule fires on one of our own valid documents\n"
fi

# ---- scrub.py's rules must match preflight's, by pattern and by behaviour ----
#
# WHY THIS EXISTS. web/tools/parity.mjs is the only place scrub.py is compared to
# anything, and its comparison is a map of rule NAMES. It checks that every scrub
# rule has a preflight counterpart and the reverse; it never looks at what either
# pattern says. So scrub.py could hold any regex at all under the name TOKEN_URL
# and the whole suite stayed green. A critic demonstrated it rather than arguing
# it: reverting scrub's URL vocabulary alone, leaving preflight and the endpoint
# widened, passed run_tests.sh, parity.mjs and the endpoint suite together.
#
# That is the exact defect parity.mjs argues against 700 lines above the map it
# uses: "compared by PATTERN and not just by name ... A name is not a rule." The
# principle was applied to the preflight/site pair and not to this one.
#
# WHY IT LIVES HERE AND NOT IN parity.mjs. parity.mjs needs node. On 2026-09-01 a
# Homebrew upgrade moved simdjson's soname and every node on this machine stopped
# starting, so run_tests.sh reported "validate.py and the site disagree" on a
# clean tree for about an hour. A check that only runs when node runs is absent
# exactly when the toolchain is having a bad day. Both these files are Python.
#
# COMPARED TWO WAYS, because either alone is weak. Source equality catches silent
# drift and is fooled by an equivalent rewrite; behaviour over a vector set
# catches real divergence but only on vectors somebody thought of.
SCRUB_PARITY='
import json, re, sys
sys.path.insert(0, ".")
import preflight, scrub

pre = dict((l, p) for l, p in preflight.SECRETS)
scr = dict((l, p) for l, p in scrub.PATTERNS)

# Mirrors SCRUB_TO_PREFLIGHT in web/tools/parity.mjs. A null there means
# scrub-only and not a credential rule; those are absent here rather than mapped.
MAP = {
    "ANTHROPIC_KEY": "an Anthropic key",
    "OPENAI_KEY": "an OpenAI style key",
    "AWS_KEY": "an AWS access key id",
    "GITHUB_TOKEN": "a GitHub token",
    "JWT": "a JWT",
    "TOKEN_URL": "a URL carrying a credential",
    "WEBHOOK_URL": "a webhook URL carrying its own secret",
    "PASSWORD_ASSIGN": "a password assignment",
    "SENDGRID_KEY": "a SendGrid key",
    "DB_URL": "a database URL carrying a password",
    "CREDENTIAL_ASSIGN": "a credential assignment",
    "GOOGLE_KEY": "a Google API key",
    "SLACK_TOKEN": "a Slack token",
    "PRIVATE_KEY_BLOCK": "a private key block",
}

# An inline (?i) and an re.I flag are the same rule written two ways. Strip the
# inline form before comparing, and fold it into the flags, so a cosmetic
# difference does not have to become an exception with a reason attached.
def norm(p):
    src, flags = p.pattern, p.flags
    if src.startswith("(?i)"):
        src, flags = src[4:], flags | re.I
    return src, flags & ~re.UNICODE

fails = []
for s_name, p_name in sorted(MAP.items()):
    if s_name not in scr:
        fails.append("scrub.py has no rule %r; the map in parity.mjs says it should" % s_name)
        continue
    if p_name not in pre:
        fails.append("preflight.py has no rule %r; the map in parity.mjs says it should" % p_name)
        continue
    if norm(scr[s_name]) != norm(pre[p_name]):
        fails.append(
            "%s and %r have DIFFERENT patterns.\n"
            "       scrub: %s\n"
            "   preflight: %s" % (s_name, p_name, scr[s_name].pattern, pre[p_name].pattern))

VECTORS = [
    "https://b.s3.amazonaws.com/o?X-Amz-Signature=4f2a9c1de8b7360a5c1f9e0d2b8a7645",
    "https://a.blob.core.windows.net/c/b?sv=2022-11-02&sig=Kx8Qz2Bm3Lp7Yv1Wq4Nd6Rf9",
    "https://api.example.com/v1/pay?ts=1756713600&signature=9d4f8c2b1e7a60539f8c2b",
    "https://a.example/o?X-Ms-Signature=4f2a9c1de8b7360a5c1f9e0d2b8a7645",
    "https://hooks.slack.com/triggers/T012AB3CD/8912345678901/8f3c1a9b2d4e6f70a1b2",
    "https://discord.com/api/v10/webhooks/1234567890123456789/aB3dE5fG7hI9jK1lM3nO5pQ",
    "https://HOOKS.SLACK.COM/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX",
    "https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALD/sendMessage",
    "The sig field is described in the signature section below.",
    "append ?key=value to the URL of the request",
    "See https://api.slack.com/messaging/webhooks for the guide.",
    "the query was ?token=abc123 in the log",
    "postgres://u:Hunter2Hunter2@db.example.com:5432/app",
]
for s_name, p_name in sorted(MAP.items()):
    if s_name not in scr or p_name not in pre:
        continue
    for v in VECTORS:
        a, b = bool(scr[s_name].search(v)), bool(pre[p_name].search(v))
        if a != b:
            fails.append("%s and %r DISAGREE on a vector: scrub=%s preflight=%s\n"
                         "   vector: %s" % (s_name, p_name, a, b, v[:90]))

for f in fails:
    print("   " + f, file=sys.stderr)
if fails:
    print("   scrub.py runs on the owner OWN machine and the gates downstream only "
          "refuse. A rule preflight has and scrub lacks is a credential leaving that "
          "machine unredacted.", file=sys.stderr)
    sys.exit(1)
print("   %d scrub rules compared to preflight by pattern and over %d vectors, not by name"
      % (len(MAP), len(VECTORS)))
'
if ! python3 -c "$SCRUB_PARITY"; then
    FAILED="${FAILED}SCRUB: scrub.py and preflight.py disagree on a rule they both carry\n"
fi

# ---- An invisible character must not walk a credential past any gate ----
#
# Fourteen zero-width and formatting characters defeated the URL rule until
# 2026-09-01, because that rule is anchored [?&]name= and anything at all
# between the delimiter and the name breaks the adjacency. For key, sig,
# signature and X-Amz-Signature the URL rule is the ONLY rule, so this
# normalisation is the whole defence and a silent regression here publishes a
# live credential.
#
# THE SECOND ASSERTION IS THE ONE THAT MATTERS AND IT IS EASY TO GET WRONG.
# preflight and the endpoint only need a boolean, so they normalise a copy and
# throw it away. scrub.py has to write a redaction back into the ORIGINAL line,
# so a match found in a string with characters removed is at the wrong offset by
# exactly the number of invisibles to its left. Redacting there cuts a span that
# is short at the front: it leaves the credential in the file and eats the text
# beside it, while the report says the line was scrubbed.
#
# So this asserts the EXACT scrubbed output, not that a redaction happened. A
# test that checks only "a finding was recorded" passes against the broken
# version; it was written that way first and the naive implementation passed it.
INVISIBLE_EVASION='
import sys
sys.path.insert(0, ".")
import preflight, scrub

ZW, SH, WJ = "​", "­", "⁠"
TOK = "abcdefghij0123456789"
bad = []

# The class itself must be identical in the two files, or they drift apart the
# way scrub.py and preflight.py already did once on this exact rule.
if preflight.INVISIBLE.pattern != scrub.INVISIBLE.pattern:
    bad.append("preflight.INVISIBLE and scrub.INVISIBLE are not the same class")

# Control. If a plain credential stops being caught, everything below is vacuous.
if not preflight.check(preflight.normalise_for_scan(
        "https://a.b/c?token=" + TOK)):
    print("   CONTROL FAILED: a plain ?token= URL is not caught, so this whole "
          "check is measuring nothing", file=sys.stderr)
    sys.exit(1)

for name in ("token", "key", "secret", "auth", "apikey", "api_key",
             "access_token", "sig", "signature", "X-Amz-Signature"):
    for ch, label in ((ZW, "U+200B"), (SH, "U+00AD"), (WJ, "U+2060")):
        probe = "https://a.b/c?" + ch + name + "=" + TOK
        if not preflight.check(preflight.normalise_for_scan(probe)):
            bad.append("preflight: %s hidden by %s publishes" % (name, label))

# Exact output, three invisibles deep, plus invisibles earlier in the line so a
# naive offset is wrong by a knowable amount.
cases = [
    ("see https://a.b/c?" + ZW*3 + "token=" + TOK + " now",
     "see https://a.b/c[SCRUBBED:TOKEN_URL] now"),
    ("se" + ZW + "e ht" + ZW + "tps://a.b/c?" + ZW + "key=" + TOK + " x",
     "se" + ZW + "e ht" + ZW + "tps://a.b/c[SCRUBBED:TOKEN_URL] x"),
    ("a https://x/y?" + ZW + "token=" + TOK + " b https://p/q?" + ZW + "key=" + TOK + " c",
     "a https://x/y[SCRUBBED:TOKEN_URL] b https://p/q[SCRUBBED:TOKEN_URL] c"),
]
for src, expected in cases:
    got, _ = scrub.scrub(src)
    if got != expected:
        bad.append("scrub wrote the wrong span:\n     got      %r\n     expected %r"
                   % (got, expected))
    if TOK in got:
        bad.append("scrub left the credential in its own output: %r" % got)

for b in bad:
    print("   " + b, file=sys.stderr)
if bad:
    print("   An invisible character between the delimiter and the parameter "
          "name is the whole evasion. If the span assertions failed, check that "
          "the redaction offset is translated back through _normalise_with_map "
          "rather than used raw.", file=sys.stderr)
    sys.exit(1)
print("   10 names x 3 invisible characters refused, and scrub writes the exact "
      "span through the offset map")
'
if ! python3 -c "$INVISIBLE_EVASION"; then
    FAILED="${FAILED}INVISIBLE: a zero-width character walks a credential past a gate, or scrub redacts the wrong span\n"
fi

# ---- The URL rule must not refuse the shapes of NOT writing a secret ----
#
# CREDENTIAL_ASSIGN excludes placeholders; the URL rule did not, for any of its
# ten names. The case that matters most is not a placeholder at all: product
# rule 1 says a passport names credential TYPES and never values, so an owner
# following the product writes ?X-Amz-Signature=<signature>, and the rule
# refused the type name and told them to rotate a credential they never had.
#
# THE SECOND HALF IS THE ONE TO KEEP. Excluding placeholders is easy to do too
# well: a word list that swallows the rest of the value lets a REAL credential
# through whenever a placeholder word happens to sit in front of it. Both
# adversarial vectors below are real-credential-shaped and MUST still refuse.
# They are the reason .gitleaks.toml carries a scoped entry for this file.
PLACEHOLDER_NOT_A_SECRET='
import sys
sys.path.insert(0, ".")
import preflight

url = next(p for l, p in preflight.SECRETS if l == "a URL carrying a credential")
bad = []

# Control. A real credential must fire, or every assertion below is vacuous.
if not url.search("https://a.b/c?token=abcdefghij0123456789"):
    print("   CONTROL FAILED: the URL rule does not fire on a real ?token=, so "
          "this check is measuring nothing", file=sys.stderr)
    sys.exit(1)

must_pass = [
    # Shapes an owner writes when deliberately NOT writing a secret. All start
    # with a sigil; none can be a credential.
    "https://b.s3.amazonaws.com/f?X-Amz-Signature=<signature>",
    "https://ex.com/d?sig=<SIGNATURE>",
    "https://ex.com/d?sig=[REDACTED]",
    "https://ex.com/d?signature=${SIGNATURE}",
    "https://ex.com/d?sig={{signature}}",
    "https://ex.com/d?token=${TOKEN}",
]
for t in must_pass:
    if url.search(t):
        bad.append("refuses a shape that carries no secret: " + t)

must_refuse = [
    "https://b.s3.amazonaws.com/f?X-Amz-Signature=4f2a9c8b7e6d5c4b3a2918f7e6d5c4b3",
    "https://acct.blob.core.windows.net/c/f?sig=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA%3D%3D",
    "https://ex.com/d?signature=deadbeefdeadbeefdeadbeefdeadbeef",
    "https://api.example.com/v1/items?token=abcdefghij0123456789",
    "https://api.example.com/v1/items?key=abcdefghij0123456789",
    # Hand-set credentials that a WORD-LIST exclusion released. These are the
    # reason this exclusion is a sigil test: each begins with a placeholder word
    # and each is a real credential that main refuses.
    "https://x.example.com/a?auth=XXXqwertyuiopasdfghjklz",
    "https://x.example.com/a?key=YOURqwertyuiopasdfghjkl",
    "https://n8n.example.com/webhook?token=mysupersecretwebhookvalue",
    "https://ex.com/d?token=PLACEHOLDER",
    # REAL CREDENTIAL FORMATS THAT BEGIN WITH A SIGIL. crypt(3) and RFC 2307 are
    # how password verifiers are written down in configuration everywhere, and
    # they start with $ and { BY SPECIFICATION. A one-character exclusion test
    # released every one of them, and ?key=$<anything> hid any credential behind
    # one prepended character. The exclusion must match a COMPLETE bracketed shape
    # anchored to the end of the value; do not shorten it back to a sigil.
    "https://a.b/c?key=$2y$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy",
    "https://a.b/c?auth=$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub",
    "https://a.b/c?token=$6$rounds=5000$usesomesillystri$D4IrlXatmP7rx3P3InaxBe",
    "https://a.b/c?key={SSHA}0m8V8vNsBLBK1lYQ4c3vFTZTMZTk0NDU=",
    "https://a.b/c?secret={MD5}X03MO1qnZdYdgyfeuILPmQ==",
    "https://a.b/c?key=[\"AbC123XyZ890qWeRtYuIoP\"]",
    "https://a.b/c?key=$AbC123XyZ890qWeRtYuIoP",
    "https://a.b/c?key=<AbC123XyZ890qWeRtYuIoP>",
]
for t in must_refuse:
    if not url.search(t):
        bad.append("MISSES a real credential: " + t)

for b in bad:
    print("   " + b, file=sys.stderr)
if bad:
    print("   This exclusion is a SHAPE test: a value starting <, {, $ or [ "
          "cannot be a credential. Do not turn it back into a list of words. A "
          "word list excludes on how a value starts, so it releases any real "
          "credential beginning with one of them, which is how it failed.",
          file=sys.stderr)
    sys.exit(1)
print("   6 bracketed shapes pass the URL rule, 17 real credentials still refused, "
      "including the crypt(3) and RFC 2307 families")
'
if ! python3 -c "$PLACEHOLDER_NOT_A_SECRET"; then
    FAILED="${FAILED}PLACEHOLDER: the URL rule refuses a shape carrying no secret, or misses one that does\n"
fi

# ---- The value-length floor is on the signature arm ONLY ----
#
# ?signature=off is an ordinary line in a mail agent's passport and refused as a
# credential until 2026-09-01. The fix is a sixteen-character floor, and the
# first version put it on all ten names, which broke four probes in parity.mjs
# asserting that ?token=abc123 is caught. Those probes encode a decision already
# taken here: a short token is still a token.
#
# So the floor is on sig / signature / X-*-Signature, which carry HMAC or hash
# output and are never three characters, and NOT on the seven names that were
# already shipping. This asserts both halves, because the whole risk of this
# change is somebody later "tidying" the two arms back into one.
SIGNATURE_FLOOR='
import sys
sys.path.insert(0, ".")
import preflight

url = next(p for l, p in preflight.SECRETS if l == "a URL carrying a credential")
bad = []

if not url.search("https://a.b/c?token=abcdefghij0123456789"):
    print("   CONTROL FAILED: the URL rule does not fire on a real ?token=",
          file=sys.stderr)
    sys.exit(1)

# The seven-name arm keeps \S+. These four are parity.mjs probes; if the floor
# ever spreads to this arm they fail here first, with the reason attached.
short_tokens_must_refuse = [
    "See https://a.example/cb?token=abc123 for it.",
    "https://a.example/cb?state=x&token=abc123",
    "https://mail.example.com/settings?key=off",
    "https://mail.example.com/settings?auth=none",
]
for t in short_tokens_must_refuse:
    if not url.search(t):
        bad.append("the floor has spread to the seven-name arm: " + t)

# The signature arm carries the floor.
settings_must_pass = [
    "https://mail.example.com/settings?signature=off",
    "https://app.example.com/prefs?signature=none",
    "https://docs.example.com/view?sig=1",
    "https://bi.example.com/r?sig=weekly&fmt=pdf",
    # The floor must measure the VALUE, not the rest of the URL. With \\S{16,}
    # this one clears the floor on the parameters that follow it.
    "https://crm.example.com/user?signature=true&theme=darkmodeextralong",
]
for t in settings_must_pass:
    if url.search(t):
        bad.append("a settings URL is still refused as a credential: " + t)

signatures_must_refuse = [
    "https://b.s3.amazonaws.com/f?X-Amz-Signature=4f2a9c8b7e6d5c4b3a2918f7e6d5c4b3",
    "https://acct.blob.core.windows.net/c/f?sig=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA%3D%3D",
    "https://ex.com/d?signature=deadbeefdeadbeefdeadbeefdeadbeef",
]
for t in signatures_must_refuse:
    if not url.search(t):
        bad.append("MISSES a real signature: " + t)

for b in bad:
    print("   " + b, file=sys.stderr)
if bad:
    print("   The rule has two arms on purpose. The seven original names keep "
          "\\S+ because parity.mjs requires a short token to be caught; the "
          "signature names carry [^\\s&#]{16,} because an HMAC is never three "
          "characters. Do not merge the arms.", file=sys.stderr)
    sys.exit(1)
print("   the floor is on the signature arm only: 4 short values still refused, "
      "5 settings URLs released, 3 signatures still refused")
'
if ! python3 -c "$SIGNATURE_FLOOR"; then
    FAILED="${FAILED}FLOOR: the value-length floor is on the wrong arm of the URL rule\n"
fi

# ---- Three passes, because two are not a superset of what we used to refuse ----
#
# Before 2026-09-01 these gates stripped exactly U+FEFF. That single pass is a
# THIRD normalisation, not a subset of "raw" or of "fully normalised", and it wins
# on a document that needs U+FEFF removed and some OTHER invisible kept: the other
# one is \S, so it satisfies the rule's (?<=\S) lookbehind. Put U+FEFF inside a
# parameter name and a soft hyphen before the delimiter and the OLD gate refuses
# while both new passes miss.
#
# Running the old normalisation as its own pass makes "this gate refuses a superset
# of what it used to" a property of the code rather than a claim about the inputs
# somebody thought to try. Delete the legacy pass and these fail.
THREE_PASSES='
import sys
sys.path.insert(0, ".")
import preflight, scrub

FEFF, SHY, ZW, LRM = "\ufeff", "\u00ad", "\u200b", "\u200e"
CRED = "AbC123XyZ890qWeRtY"
bad = []

if not preflight.check("https://a.b/c?key=" + CRED):
    print("   CONTROL FAILED: a plain ?key= URL is not refused", file=sys.stderr)
    sys.exit(1)

for lead, lname in ((SHY, "U+00AD"), (ZW, "U+200B"), (LRM, "U+200E")):
    for name in ("key", "token"):
        probe = "Endpoint " + lead + "?" + name[0] + FEFF + name[1:] + "=" + CRED
        if not preflight.check(probe):
            bad.append("preflight misses %s hidden by %s + an interior U+FEFF"
                       % (name, lname))
        out, _ = scrub.scrub(probe)
        if CRED in out:
            bad.append("scrub leaves the credential in its output for %s + %s"
                       % (name, lname))

for b in bad:
    print("   " + b, file=sys.stderr)
if bad:
    print("   Two normalisation passes are not enough. The pre-2026-09-01 pass "
          "stripped U+FEFF alone and is a THIRD normalisation; it must run as its "
          "own pass or this gate silently refuses less than it used to.",
          file=sys.stderr)
    sys.exit(1)
print("   3 normalisation passes: 6 mixed-invisible probes refused and scrubbed")
'
if ! python3 -c "$THREE_PASSES"; then
    FAILED="${FAILED}PASSES: two normalisation passes are not a superset of the old gate\n"
fi

if [ -z "$FAILED" ]; then
    echo "ALL TESTS PASSED"
    exit 0
else
    # Every failure, not the first one.
    #
    # This was `| head -1`, and it threw away the rest at the moment somebody
    # most needed them. Found while verifying the 256KB check: that check fired
    # correctly, added its message to FAILED, and printed nothing, because a
    # shape-level failure earlier in the file had already taken the one line on
    # offer. I spent several minutes deciding my new assertion was broken when
    # what was broken was the reporting.
    #
    # Same defect as web/build.sh piping parity through `tail -3`, one file over,
    # and the general form is worth naming: a harness that truncates its own
    # diagnosis converts one failing run into two, because the reader has to go
    # and reproduce by hand what the run already knew. Print all of it; a test
    # suite's output is read exactly when things are going badly.
    echo -e "$FAILED"
    exit 1
fi
