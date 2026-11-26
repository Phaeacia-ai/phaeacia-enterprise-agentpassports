#!/usr/bin/env python3
"""Derive the passport page's data object from a real passport file.

Usage: passport-to-page.py PASSPORT.md [--write | --dump-parts]

Without flags, prints the JavaScript constant to stdout. With --write, replaces
the `const PASSPORT = {...};` block in site/index.html in place and leaves every
other line of that file alone. With --dump-parts, prints the parsed section
structure as JSON and writes nothing; web/tools/parity.mjs calls it to diff this
file's Markdown reading against the site's. Unknown flags are rejected rather
than ignored, so a typo does not quietly dump JavaScript to stdout.

**--standalone is gone, with 915 lines of page template behind it.** It wrote a
self-contained HTML page next to the passport, which the capture skill opened as
its last step. That was right while there was nowhere to put a passport and
wrong once app.phaeacia.ai existed: the file froze its installer text on the day
it was made, could not be withdrawn once mailed, never expired, and was a second
renderer of the same document that had to be kept in step with web/lib/_render.mjs
by hand. The skill now calls scripts/publish.py, which posts the passport to the
site and hands back a link. This file is back to being the derivation only.

Why this exists: site/index.html renders from a hand-written constant, which was
correct for building the page and wrong for showing anything real. The upload
endpoint has to perform exactly this derivation to fill the `summary` and `needs`
columns (see site/spec/upload-validation.md), so this script is that derivation,
written once, in the language the rest of the tooling is written in.

THE TWO DERIVATIONS NOW DISAGREE, and the paragraph above is the claim that
disagreement breaks. This file NEVER VALIDATES. It does not import validate.py
and it runs no gate of its own, so it renders a page for any passport at all,
including one that tools/validate.py and the upload endpoint both refuse. The
2026-08-19 envelope floor made that visible rather than causing it: hand this
script `tools/fixtures/passports/invalid_envelope_installable_row.md`, which
both gates refuse, and it emits a consent row with a backticked declared-only
capability and `"installable": true`, no complaint. web/tools/parity.mjs cannot
see it, because parity compares validate.py's verdict against the site's and
never compares THIS file's derived `needs` against _derive.mjs's.

Left unfixed on purpose and recorded instead. The right repair is for this file
to run validate.py first and refuse what it refuses, which is a behaviour change
to a tool that today assumes it was handed a valid passport, and it belongs with
a parity probe that compares the two derivations rather than the two verdicts.
The blast radius meanwhile is site/index.html and nothing else. NOT the
marketing sample: ~/Phaeacia/website/tools/build-samples.mjs imports
web/lib/_validate.mjs and web/lib/_derive.mjs directly and throws on either
error, so that page is built through the gated JS path and never touches this
script. An earlier version of this paragraph named it as a consumer, which was
the same mistake as the sentence above it, one file over.

Until that probe exists, do not read "exactly this derivation" as a guarantee.

Derivation rules, which are the contract:
  title, created, capture_path   frontmatter, verbatim
  description                    the first paragraph of section 1
  needs                          the consent table in section 2, one row each
  golden_parts                   section 4 in its own order: every fenced block
                                 and every paragraph around them, interleaved
  installers                     installer core plus judge plus one branch each

Any of these failing is a failed upload, not a half-parsed passport. This script
exits 1 and says which rule failed, so the endpoint that ports it inherits the
same behaviour.

Stdlib only.
"""

import datetime
import json
import os
import re
import sys
from string import Template

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRANCH_KEYS = [("chatgpt", "chatgpt.md"),
               ("claude_ai", "claude-ai.md"),
               ("claude_code", "claude-code.md")]

VOCABULARY = {"web.fetch", "email.read", "calendar.read", "files.read",
              "schedule.run", "chat.notify", "memory.prefs", "email.send",
              "msg.send", "social.post", "ext.write"}


def fail(rule, detail):
    print("FAIL (%s): %s" % (rule, detail), file=sys.stderr)
    sys.exit(1)


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


_ASSEMBLE = []


def assemble():
    """Import assemble.py from next to this script, once.

    The copy blocks must be byte-identical to what `assemble.py --branch=<x>`
    writes, and the installer text this script reads must come from the same
    place assemble.py reads it from. Importing the module instead of
    re-implementing either makes that true by construction, from any working
    directory and in either layout.
    """
    if not _ASSEMBLE:
        import importlib.util
        path = os.path.join(root, "scripts", "assemble.py")
        if not os.path.exists(path):
            fail("assemble", "scripts/assemble.py not found next to this script "
                             "(looked in %s)" % os.path.join(root, "scripts"))
        # No __pycache__. Product rule 1 is that a passport carries types and
        # never values, and this script runs inside the distributable skill
        # folder: importing assemble.py normally leaves a .pyc there whose
        # embedded co_filename is the author's absolute home path, and the
        # folder is distributed by copy or zip, neither of which reads
        # .gitignore. The capture tool would ship the owner's home directory
        # to the stranger installing the agent.
        sys.dont_write_bytecode = True
        spec = importlib.util.spec_from_file_location("_passport_assemble", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _ASSEMBLE.append(module)
    return _ASSEMBLE[0]


def split_front(text):
    """Frontmatter and body, read the way both gates read them: the delimiter
    is the exact line `---`, no trim of any width, within the first 40 lines.

    This used to strip WS_MD off the opener and WS_BOTH off the closer and
    scan to line 41, three readings none of which either gate uses. It never
    mattered on the --write path, which runs after tools/validate.py has
    passed the file, and it did matter on --dump-parts, where the parity
    harness walks every fixture including the refused ones: a renderer that
    is looser than the gate here can only ever split a document the gate
    refused, and a renderer that is tighter would crash the harness on one it
    accepted. Same reading as the gates, so neither can happen (critic-211e).
    """
    lines = text.split("\n")
    if lines[0] != "---":
        fail("frontmatter", "file does not start with ---")
    for i in range(1, min(len(lines), 40)):
        if lines[i] == "---":
            front = {}
            for line in lines[1:i]:
                if ":" not in line:
                    continue
                k, v = line.split(":", 1)
                v = v.strip(WS_BOTH_CHARS)
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                front[k.strip(WS_BOTH_CHARS)] = v
            return front, "\n".join(lines[i + 1:])
    fail("frontmatter", "no closing --- within the first 40 lines")


# A passport's Markdown, read once. THIS BLOCK AND web/lib/_sections.mjs ARE
# ONE ALGORITHM WRITTEN TWICE, and they are required to produce the same part
# count, the same kinds, the same block text and the same paragraphs for any
# input. Change one and change the other. web/tools/parity.mjs runs both over
# every fixture and diffs the result: --dump-parts below is what it calls, so
# the sentence above is checked rather than asserted. It used to say a harness
# diffed them when none existed, which is the comment most likely to stop the
# next person writing one.
#
# One regex for both ends of a fence, and a tracked length. A fence closes on a
# run at least as long as the one that opened it; a shorter run inside a longer
# fence is content. Matching on "starts with three backticks" split a
# four-backtick example that quotes a three-backtick block in two, so the page
# announced examples the owner never wrote and printed a line from inside one
# as the passport's framing prose. The rule is deliberately the same as
# fenceMap() in web/lib/_validate.mjs, which is the gate that decides what gets
# stored: a generator that disagreed with the gate about where a fence ends
# would publish a page the upload endpoint would not.
# THE THIRD COPY OF THE WHITESPACE RULE, and it is here rather than imported
# because this file deliberately imports nothing from the repo: it renders a
# passport on a machine that may hold only this script. tools/validate.py and
# web/lib/_sections.mjs carry the other two, and test 18 in tools/run_tests.sh
# reads all three out of the source and requires them equal, the same way test
# 16 does for FILENAME_EXTENSIONS. See tools/validate.py for the reasoning; in
# short, `\s` is not one set across the two engines (ROW-211).
WS_BOTH = "\t\n\x0b\x0c\r \xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000"
WS_BOTH_CHARS = "".join(c for c in map(chr, range(0x3001))
                        if re.match("[%s]" % WS_BOTH, c))

# The union, the same one tools/validate.py and web/lib/_sections.mjs call
# WS_ANY: every character EITHER engine calls whitespace.
WS_ANY = ("\t\n\x0b\x0c\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a"
          "\u2028\u2029\u202f\u205f\u3000\ufeff")
WS_ANY_CHARS = "".join(c for c in map(chr, range(0x10000))
                       if re.match("[%s]" % WS_ANY, c))
WS_ANY_RUN = re.compile("[%s]+" % WS_ANY)


def collapse_ws(s):
    """Trim, then squeeze every run of whitespace to one space, WS_ANY-wide.

    This exists because `" ".join(s.split())` and `s.trim().replace(/\s+/g,
    " ")` are not the same function. `str.split()` with no argument splits on
    the Python whitespace set; the JavaScript regex uses the JavaScript one.
    They differ by six characters, so `title: Daily<U+0085>Brief` rendered as
    "Daily Brief" here and "Daily\u0085Brief" on the site, and `title:
    Daily<U+FEFF>Brief` the other way round. Nothing refused either file:
    both renderers accepted it and produced different pages, and
    website/tools/build-samples.mjs runs THIS one to make what phaeacia.ai
    serves. Widest class, because for a renderer the goal is one output
    rather than a refusal.
    """
    return WS_ANY_RUN.sub(" ", s.strip(WS_ANY_CHARS))

# The Markdown-structure class, the same one tools/validate.py calls WS_MD.
WS_MD = " \t"

# Narrow on purpose, and the same class as tools/validate.py FENCE_DELIM and
# web/lib/_sections.mjs FENCE: a wider class here is fail-open.
FENCE = re.compile(r"^[ \t]*(`{3,})")
# Two heading rules, not one. SECTION_BOUNDARY ends a section: `## 5. Installer`
# does, a `### sub-heading` does not, because a sub-heading is still that
# section's own content. ANY_HEADING is what a heading looks like to the
# paragraph splitter, which must recognise every level or print the marker.
# Both are consulted outside fences only, so a golden example containing
# "# comment" is text.
# `[ \t]`, not `\s`. See tools/validate.py WS_MD: a wider class ends a section
# earlier, which is fail-open, and `##\ufeffExtra` was a heading to one engine
# and not the other (ROW-211).
SECTION_BOUNDARY = re.compile(r"^#{1,2}[ \t]")
ANY_HEADING = re.compile(r"^#{1,6}[ \t]")
TABLE_ROW = re.compile(r"^[ \t]*\|")
# A list item starts a paragraph of its own. Joining them produced
# "- items 4-11 removed - names replaced" out of two lines, and
# "1. items 4-11 removed 2. shape preserved" out of a numbered list, which
# reads as though the 2 were part of the removal. A bulleted list of elision
# rules is the likeliest shape this prose takes.
LIST_ITEM = re.compile(r"^[ \t]*(?:[-*+][ \t]|\d+[.)][ \t])")
# A paragraph that is one angle-bracketed instruction is a capture template
# that was never filled in, e.g. capture/path-w-prompt.md's
# "<One to three blocks in this section...>". Upload refuses such a passport
# anyway (upload-validation.md 5.1 check 21 reads it as an HTML tag), so this
# only ever fires on the --write and --dump-parts paths, which do not run that
# gate. The inner space is what keeps a bare Markdown autolink, <https://x>,
# out of the rule: an autolink has no space in it.
PLACEHOLDER = re.compile(r"^<[^<>]*[ \t][^<>]*>$")   # WS_MD, twin of _sections.mjs


def heading_lines(body):
    """Line index of every heading that is not inside a fenced block.

    Substring search over the whole document was not good enough and the way
    it failed named the wrong thing. A golden example that quotes a literal
    "## 5. Installer" line ended section 4 inside the fence, so the fence
    never closed, and the error a capture user saw was
    "E_DERIVE_GOLDEN: section 4 leaves a fenced block open" about a block the
    owner had closed properly. --write and --dump-parts do not run the
    validator, so that message was the whole of the diagnosis. A heading
    inside a fence is text, here as everywhere else in this file.
    """
    at, fence = {}, None
    for i, line in enumerate(body.split("\n")):
        match = FENCE.match(line)
        if match:
            if fence is None:
                fence = len(match.group(1))
            elif len(match.group(1)) >= fence:
                fence = None
            continue
        if fence is None:
            text = line.strip(WS_MD)
            if text.startswith("#") and text not in at:
                at[text] = i
    return at


def section_lines(lines, heading):
    """A section body: from its heading to the next level-1 or level-2 heading
    that is not inside a fenced block. Mirrors sectionLines in
    web/lib/_sections.mjs line for line, and returns [] for a missing heading.
    """
    # THE HEADING IS LOCATED WITH FENCE TRACKING FROM THE TOP OF THE INPUT,
    # not from wherever the heading happens to be (ROW-223).
    #
    # This used a bare scan for the first line equal to the heading, then
    # started its fence walk THERE. So a passport whose whole body sits inside
    # one ``` fence opened above section 1 and never closed had its headings
    # found inside the code block, and this returned a title, a summary and a
    # consent table read out of the inside of it: a reader of the rendered
    # page sees a consent table the Markdown never contained as a table. The
    # site had the identical defect in sectionLines() and is fixed in the same
    # commit, because web/tools/parity.mjs holds these two equal part for part
    # and they are one algorithm written twice.
    #
    # tools/validate.py refuses such a document now, and this is still worth
    # fixing here: --write and --dump-parts do not run the validator, so the
    # offline generator is reachable without a gate in front of it.
    fence, start = None, -1
    for i, line in enumerate(lines):
        match = FENCE.match(line)
        if match:
            if fence is None:
                fence = len(match.group(1))
            elif len(match.group(1)) >= fence:
                fence = None
            continue
        if fence is None and line.strip(WS_BOTH_CHARS) == heading:
            start = i
            break
    if start < 0:
        return []
    # fence is None here by construction: the heading was required to be
    # outside a fence, so the walk below starts closed, as it always did.
    out, fence = [], None
    for line in lines[start + 1:]:
        match = FENCE.match(line)
        if match:
            if fence is None:
                fence = len(match.group(1))
            elif len(match.group(1)) >= fence:
                fence = None
        elif fence is None and SECTION_BOUNDARY.match(line):
            break
        out.append(line)
    return out


def section(body, n, headings):
    """One numbered section's body, with the order of the six checked.

    The slice itself is section_lines(), which is the site's rule: a section
    runs to the next level-2 heading, not to the next NUMBERED one. Ending it
    at the next numbered heading meant a stray `## Notes` between sections 4
    and 5 was read as part of section 4 here and not on the site, one more
    place where the same file said two things. The numbered headings are still
    required, and still required in order, because that is a passport's shape
    and validate.py check 2 says so too.
    """
    lines = body.split("\n")
    at = heading_lines(body)
    if headings[n - 1] not in at:
        fail("section %d" % n, "heading %r not found" % headings[n - 1])
    if n < len(headings):
        if headings[n] not in at or at[headings[n]] <= at[headings[n - 1]]:
            fail("section %d" % n, "next heading not found, sections out of order")
    return "\n".join(section_lines(lines, headings[n - 1]))


def summary_of(text):
    """Section 1 prose, per upload-validation.md 6.2. Never truncated.

    The three rejects are line-start patterns, all of them, matching
    _derive.mjs line for line. Testing `"```" in text` refused a section 1
    whose prose contains an inline code span written with three backticks,
    which is not a fence and which the site accepts and publishes: the skill
    that captured such a passport could not read it back at all.
    """
    stripped = text.strip()
    for line in stripped.split("\n"):
        for pattern, what in ((ANY_HEADING, "a heading"),
                              (TABLE_ROW, "a table"),
                              (FENCE, "a fenced block")):
            if pattern.match(line):
                fail("E_DERIVE_SUMMARY",
                     "section 1 contains %s; it is three sentences of prose" % what)
    summary = collapse_ws(stripped)
    if not 20 <= len(summary) <= 2000:
        fail("E_DERIVE_SUMMARY", "summary is %d characters, must be 20 to 2000" % len(summary))
    return summary


def vocabulary_ref(cell):
    """A backticked token in the capability cell, if it is a valid id. Never guessed."""
    match = re.search(r"`([^`]+)`", cell)
    if not match:
        return None
    # Trimmed and ASCII-folded, as web/lib/_derive.mjs reads it: an id is
    # stored as the id it is, so `Files.Read` is files.read.
    # Space and tab only, as stripBlanks() in _derive.mjs. Python's strip() takes
    # every Unicode space (U+00A0, U+0085, U+001C-U+001F among them) and stripBlanks
    # takes two characters, so the two derivations of one passport disagreed on
    # `ref` for a row the opaque rule never reads; see valid_declared_only_nbsp_ref.md.
    token = re.sub(r"[A-Z]", lambda m: m.group().lower(), match.group(1).strip(" \t"))
    if token in VOCABULARY:
        return token
    # A money token shaped like a filename is not a ref. Mirrors
    # isFilenameToken() in web/lib/_validate.mjs, list for list; this script
    # deliberately imports nothing from validate.py (see the header), so the
    # list is repeated here and must move with the other two.
    if token.startswith("money.") and token[len("money."):] not in {
            "csv", "tsv", "txt", "md", "json", "yaml", "yml", "xml", "toml", "ini",
            "xlsx", "xls", "ods", "numbers", "parquet", "db", "sqlite", "sqlite3",
            "log", "dat", "pdf", "ofx", "qif", "xlsm", "gnucash"}:
        return token
    return None


def fence_flags(lines):
    """True for every line inside a fenced block, delimiters included.

    The twin of fence_flags() in tools/validate.py, kept separate because this
    script imports nothing from the repo (see the header). Test 17 runs both,
    plus spec_lines() and fenceMap() in web/lib/_validate.mjs, over the same
    documents and requires the same answer line for line.
    """
    flags = [False] * len(lines)
    open_len = None
    for i, line in enumerate(lines):
        m = FENCE.match(line)
        if m:
            if open_len is None:
                open_len = len(m.group(1))
            elif len(m.group(1)) >= open_len:
                open_len = None
            flags[i] = True
        else:
            flags[i] = open_len is not None
    return flags


def consent_rows(text):
    """The section 2 consent table, per upload-validation.md 6.3.

    Strict by design: a malformed row fails the upload rather than being skipped.
    A silently dropped row is a capability the installer never sees, which is the
    one failure this table exists to prevent.

    Strict about the row, lenient about the pipes, which is where this used to
    disagree with the site. A trailing pipe is optional in GitHub-flavoured
    Markdown and _derive.mjs has always said so; requiring one here meant a
    passport the site accepted, stored and published could not be turned into
    read here at all, so this file and the site disagreed about a document the
    site itself had stored. The header's first cell
    is no longer required to read "Capability" for the same reason: the site
    stores such a table, so this has to render it.
    """
    def cells_of(line):
        text = line.strip(WS_MD)
        if text.startswith("|"):
            text = text[1:]
        if text.endswith("|"):
            text = text[:-1]
        return [c.strip(WS_MD) for c in text.split("|")]

    # FENCE AWARENESS, the third copy of the walk in tools/validate.py
    # consent_rows() and _derive.mjs. A line inside a code fence is not a
    # consent row: a shell pipeline pasted out of a rendered web page puts
    # `| jq -r ...` at the start of its continuation lines, and this function
    # read it as a row with two columns and refused.
    #
    # Without this, tools/validate.py PASSES the file and THIS SCRIPT refuses
    # it, in the same language, on the same rule. That is worse than the two
    # gates disagreeing: an owner whose passport validates cannot render it,
    # and the skill runs both. Found by measuring the class test 20 is blind
    # to by construction, which is the documents only one renderer accepts.
    lines_all = text.split("\n")
    fenced = fence_flags(lines_all)

    table = [l for i, l in enumerate(lines_all)
             if not fenced[i] and l.strip(WS_MD).startswith("|")]
    if len(table) < 3:
        fail("E_DERIVE_NEEDS", "section 2 has no consent table with at least one row")

    header = cells_of(table[0])
    if len(header) != 5:
        fail("E_DERIVE_NEEDS", "consent table header is not the five expected columns")
    if not re.match(r"^[ \t]*\|?[ \t:|-]+\|?[ \t]*$", table[1]):
        fail("E_DERIVE_NEEDS", "consent table has no separator row under the header")

    rows = []
    for line in table[2:]:
        cells = cells_of(line)
        if len(cells) != 5:
            fail("E_DERIVE_NEEDS", "consent row has %d columns, expected 5: %s"
                 % (len(cells), line[:60]))
        # An all-empty row is spacing, not a capability. _derive.mjs skips it
        # and this refused it as a required cell that is neither.
        if all(c == "" for c in cells):
            continue
        required_cell = cells[2].lower()
        if required_cell.startswith("required"):
            required = True
        elif required_cell.startswith("optional") or required_cell.startswith("declared"):
            required = False
        else:
            fail("E_DERIVE_NEEDS", "required cell is neither required nor optional: %r" % cells[2])
        installable_cell = cells[4].lower()
        if installable_cell.startswith("yes"):
            installable = True
        elif installable_cell.startswith("no"):
            installable = False
        else:
            fail("E_DERIVE_NEEDS", "installable cell is neither yes nor no: %r" % cells[4])
        # Both cells travel twice: the boolean, which decides styling and the
        # envelope, and the passport's own wording, which is what a reader
        # sees. Keeping only the boolean forced the page to invent the text
        # back, and what it invented ("no, not in v0.1") appears in no
        # passport and contradicted the install blocks on the same page.
        #
        # Backticks come off the capability, per upload-validation.md 6.3.
        # This stored the cell raw while _derive.mjs stripped them, on the
        # same input, and both suites stayed green because the parity harness
        # compared only the keys present on the first row of each side and no
        # fixture had a backticked capability at all. The value is displayed
        # and nothing else, both renderers set it in a monospace face, and the
        # id a backticked token carries is extracted into `ref` below.
        row = {
            "capability": cells[0].replace("`", ""),
            "why": cells[1],
            "required": required,
            "required_label": cells[2],
            "if_skipped": cells[3],
            "installable": installable,
            "installable_label": cells[4],
        }
        ref = vocabulary_ref(cells[0])
        if ref:
            row["ref"] = ref
        rows.append(row)

    if not 1 <= len(rows) <= 24:
        fail("E_DERIVE_NEEDS", "%d consent rows, must be 1 to 24" % len(rows))
    return rows


def section_parts(lines):
    """Split a section body into fenced blocks and prose paragraphs, in order.

    Returns (parts, open_fence). Each part is ("block", text) or
    ("prose", text). open_fence is None when every fence closed, otherwise
    (line number, the offending line) of the one left open.

    Order is the contract. A paragraph belongs where the owner wrote it: above
    the block it introduces, or below the block it qualifies. The caller places
    the parts and adds no structure of its own.

    Prose is collapsed to one string per paragraph and rendered through the
    same tiny inline-Markdown reader the site uses: bold, italic, code, and a
    link shown as its label and its visible URL. It used to render as literal
    characters here and as Markdown on the site, so one passport's `x` and
    **bold** came out two different ways on the two pages that both claim to
    be this file's reading of it. See md_inline().
    """
    parts, para, block = [], [], []
    fence, fence_at = None, None

    def flush():
        if not para:
            return
        text = " ".join(para)
        del para[:]
        if not PLACEHOLDER.match(text):
            parts.append(("prose", text))

    for number, line in enumerate(lines, 1):
        if fence is None:
            opening = FENCE.match(line)
            if opening:
                flush()
                fence, fence_at = len(opening.group(1)), (number, line)
                block = []
                continue
            if ANY_HEADING.match(line):
                if SECTION_BOUNDARY.match(line):
                    break
                # A sub-heading is the owner's label for what follows, and
                # neither page has a heading level to put inside a golden
                # example, so it renders as the sentence it is. It used to be
                # tested by the same constant as the section boundary; when
                # that constant narrowed to `#{1,2}` a `### ` line stopped
                # matching anything at all, fell through to the paragraph
                # branch, and printed as the literal text
                # "### Example 1, the morning run" on both pages. Dropping the
                # line instead would be the failure one size down: silently
                # deleting the owner's words is what the prose half of this
                # function exists to prevent.
                flush()
                parts.append(("prose", re.sub(r"^#{1,6}[ \t]+", "", line).strip(WS_MD)))
                continue
            # A table is not prose. Section 4 rarely holds one; section 2 and
            # section 6 are mostly table, and the same splitter reads those on
            # the site. A row rendered as a paragraph is "| Capability | Why |".
            if TABLE_ROW.match(line):
                flush()
                continue
            if not line.strip(WS_MD):
                flush()
                continue
            if LIST_ITEM.match(line):
                flush()
            para.append(line.strip(WS_MD))
        else:
            closing = FENCE.match(line)
            if closing and len(closing.group(1)) >= fence:
                parts.append(("block", "\n".join(block)))
                fence, fence_at = None, None
                continue
            block.append(line)

    flush()
    return parts, fence_at


def golden_parts(text):
    """Section 4 as an ordered list of prose paragraphs and fenced blocks.

    Every block, not the first: the spec allows one to three and validate.py
    check 8 enforces that range, so keeping one silently dropped an output the
    owner chose to publish. This function enforces the same range, because
    --write and --dump-parts do not run the validator and would otherwise
    accept a section 4 the upload endpoint refuses.

    Ordered, and flat, which replaces a per-example `note` list and a separate
    `golden_closing_note`. Those two carried a rule nobody had stated: prose
    attached to the block BELOW it, so a paragraph written between example one
    and example two silently became example two's framing, and only prose
    after the last block escaped into the closing note. The site's renderer
    had a third rule again, printing every paragraph above every block, so one
    passport's elision note landed on a different example depending on which
    page you opened. Keeping the passport's own order is the only reading that
    needs no rule, and it is the one both renderers now walk.

    The prose has to travel at all because that is where the spec puts the
    elision rules and the "templates of shape, never expected content"
    warning; without it a synthetic example reads as a real run.
    """
    parts, open_fence = section_parts(text.split("\n"))
    if open_fence:
        fail("E_DERIVE_GOLDEN",
             "section 4 leaves a fenced block open at line %d: %r"
             % (open_fence[0], open_fence[1][:60]))

    blocks = sum(1 for kind, _ in parts if kind == "block")
    if not blocks:
        fail("E_DERIVE_GOLDEN", "section 4 has no fenced block; a passport "
                                "carries one to three golden examples")
    if blocks > 3:
        fail("E_DERIVE_GOLDEN", "section 4 has %d fenced blocks, must be 1 to 3"
             % blocks)
    return [{"kind": kind, "text": value} for kind, value in parts]


# The three sections whose Markdown both implementations split: section 2 is
# the consent table plus its prose, section 4 the golden examples, section 6
# the losses table plus its prose. --dump-parts prints exactly this and
# web/tools/parity.mjs diffs it against sectionParts() over every fixture.
DUMPED_SECTIONS = ["## 2. What it needs from you",
                   "## 4. Golden examples",
                   "## 6. Losses"]


def dump_parts(passport_path):
    """The parsed section structure, as JSON, for the parity harness.

    This mode exists because a comment claimed a harness diffed the two
    section splitters and no such harness existed. Fifteen lines here and
    twenty there make the claim true; deleting the sentence would have left
    two hand-synchronised parsers and nothing watching them.
    """
    # The whole file, not the body after split_front: jsParts in
    # web/tools/parity.mjs walks `text.split('\n')` and never splits the
    # frontmatter off, so walking the body here compared two different inputs
    # and reported the Markdown readers as disagreeing on a document whose
    # frontmatter delimiter both gates refuse. Section 1 is found by its
    # heading either way; what this changes is only that a document with no
    # readable frontmatter is still split, in both languages, from the same
    # first line.
    lines = read(passport_path).split("\n")
    out = {}
    for heading in DUMPED_SECTIONS:
        parts, open_fence = section_parts(section_lines(lines, heading))
        out[heading] = {
            "parts": [{"kind": kind, "text": text} for kind, text in parts],
            "open": open_fence[0] if open_fence else 0,
        }
    print(json.dumps(out, indent=2, ensure_ascii=False))


def judge_block():
    path = assemble().resolve("judge")
    if path is None:
        return ""
    lines = read(path).split("\n")
    fences = [i for i, line in enumerate(lines) if line.startswith("````")]
    if len(fences) < 2:
        return ""
    body = "\n".join(lines[fences[0] + 1:fences[-1]]).strip()
    return "\n\n## Appendix: the verification judge\n\n" + body


def installers():
    """Installer core plus judge plus one branch each.

    Paths come from assemble.py's layout table, never from a fixed
    installer/ prefix: this script is copied into the distributable skill
    folder, where the same files sit flattened under references/. Hardcoding
    the repo layout made the skill's copy fail on the owner's machine with a
    missing-file error that named a directory the skill does not have.
    """
    asm = assemble()
    core_path = asm.resolve("core")
    if core_path is None:
        fail("installers", "no installer core found under %s" % root)
    core = read(core_path).rstrip() + judge_block()
    branch_dir = asm.resolve("branch_dir")
    if branch_dir is None:
        fail("installers", "no installer branch directory found under %s" % root)
    out = {}
    for key, fname in BRANCH_KEYS:
        path = os.path.join(branch_dir, fname)
        if not os.path.exists(path):
            fail("installers", "missing branch %s" % fname)
        out[key] = core + "\n\n" + read(path).rstrip() + "\n"
    return out


def build(passport_path):
    front, body = split_front(read(passport_path))
    for key in ("title", "created", "capture_path"):
        if key not in front:
            fail("frontmatter", "missing %s" % key)

    headings = ["## 1. What this agent is",
                "## 2. What it needs from you",
                "## 3. Functional spec",
                "## 4. Golden examples",
                "## 5. Installer",
                "## 6. Losses"]

    title = collapse_ws(front["title"])
    if len(title) > 200:
        fail("E_DERIVE_TITLE", "title is %d characters, maximum 200, never truncated" % len(title))

    return {
        "title": title,
        "description": summary_of(section(body, 1, headings)),
        "created": front["created"],
        "capture_path": front["capture_path"],
        "needs": consent_rows(section(body, 2, headings)),
        # Section 4 in document order, prose and blocks interleaved. See
        # golden_parts(); this replaced a per-example note list and a
        # golden_closing_note, which encoded a placement rule the two
        # renderers had each guessed differently.
        "golden_parts": golden_parts(section(body, 4, headings)),
        "installers": installers(),
    }


def as_js(data):
    return "const PASSPORT = " + json.dumps(data, indent=2, ensure_ascii=False) + ";"


def write_into_page(js):
    page_path = os.path.join(root, "site", "index.html")
    # --write targets the repo's own demo page, which exists in the product
    # repo and not in the distributable skill folder. Say that rather than
    # letting a FileNotFoundError traceback stand in for the explanation.
    if not os.path.exists(page_path):
        fail("page", "no site/index.html under %s; --write only runs in the "
                     "product repo, against its own demo page" % root)
    page = read(page_path)
    start = page.find("const PASSPORT = {")
    if start == -1:
        fail("page", "no `const PASSPORT = {` found in site/index.html")
    end = page.find("\n};", start)
    if end == -1:
        fail("page", "no closing `};` found for the PASSPORT constant")
    new = page[:start] + js + page[end + 3:]
    with open(page_path, "w", encoding="utf-8") as f:
        f.write(new)
    print("rewrote the PASSPORT constant in site/index.html (%d bytes total)" % len(new))



def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = set(a for a in sys.argv[1:] if a.startswith("--"))
    usage = ("Usage: passport-to-page.py PASSPORT.md "
             "[--write | --dump-parts]")
    unknown = sorted(flags - {"--write", "--dump-parts"})
    if unknown:
        print("unknown flag: %s" % ", ".join(unknown), file=sys.stderr)
        print(usage, file=sys.stderr)
        sys.exit(1)
    if len(args) != 1 or len(flags) > 1:
        print(usage, file=sys.stderr)
        sys.exit(1)
    if "--dump-parts" in flags:
        dump_parts(args[0])
    elif "--write" in flags:
        write_into_page(as_js(build(args[0])))
    else:
        print(as_js(build(args[0])))


if __name__ == "__main__":
    main()
