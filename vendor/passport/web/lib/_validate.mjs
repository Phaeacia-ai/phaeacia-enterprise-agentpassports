/* Stages 1 to 3 of site/spec/upload-validation.md.
   Stages 2 and 3 COLLECT every error so a passport with four problems is fixed
   in one pass. Stage 1 fails fast, because the first transport failure makes
   the rest meaningless.

   Authority, per that document section 8: the spec is normative, tools/validate.py
   is the reference implementation of the FORMAT rules (section 4), and this file
   is the sole authority for transport, untrusted content, and derivation. Both
   carry RULES_VERSION and must move together. */

/* One fence rule and one section-boundary rule for the whole build. This file
   is named in _sections.mjs as the gate its rules must match, so it is the one
   file that must not keep its own copy of them. _sections.mjs imports nothing,
   so there is no cycle. */
import { FENCE, FENCE_LOOSE, SECTION_BOUNDARY, sectionLines, WS_ANY, WS_BOTH, structuralTrim, yamlTrim, collapseWs, mdTrim, TABLE_ROW_MD, WS_ANY_RE, WS_BOTH_END_RE, WS_BOTH_START_RE, yamlScalarRe } from './_sections.mjs';

export const RULES_VERSION = '0.1.0';
export const MAX_BYTES = 262144;
export const MIN_BYTES = 512;

/* assemble.py requires this literal in section 5 and replaces it on assembly.
   It is the one HTML comment a passport may carry: check 24 would otherwise
   refuse every passport the capture skill emits. Documented deviation. */
export const INSTALLER_PLACEHOLDER = '<!-- installer core and branches inserted on upload -->';

/* Real HTML element names, used only to tell a tag from an unfilled capture
   placeholder when reporting why an upload was refused. Both are refused, so a
   name missing from this list costs a clearer sentence and nothing else. It is
   deliberately the whole element set rather than a "dangerous" subset: a
   passport has no business carrying <span> either, and calling <span> a
   placeholder would be the wrong sentence. */
export const HTML_ELEMENTS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi',
  'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code',
  'col', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog',
  'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr',
  'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li',
  'link', 'main', 'map', 'mark', 'menu', 'meta', 'meter', 'nav', 'noscript',
  'object', 'ol', 'optgroup', 'option', 'output', 'p', 'param', 'picture', 'pre',
  'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'search', 'section',
  'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary',
  'sup', 'svg', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th',
  'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr'
]);

/* A YAML scalar as written by the regexes in this file, minus its quotes.
   `x: v`, `x: "v"` and `x: 'v'` are one value in YAML; a regex sees three
   strings. Every place in this file that compares a captured scalar against a
   literal must go through here. The twin of scalar() in tools/validate.py, and
   the two must agree: they are the same gate at two different doors, and a
   passport the Python side calls valid and this side refuses is a passport
   somebody cannot publish for a reason no message explains. */
export { WS_ANY, WS_BOTH, structuralTrim, yamlTrim, collapseWs, mdTrim, TABLE_ROW_MD, WS_ANY_RE, yamlScalarRe };

/* A YAML list item, WS_ANY on both sides. Twin of LIST_ENTRY in
   tools/validate.py: where an entry STARTS decides which capability_ref is
   paired with which status, so the two gates must split a block in the same
   places. Wide, because a line not read as a new entry is folded into the
   previous one and its status is read as that one's. */
export const LIST_ENTRY = new RegExp(`^[${WS_ANY}]*-[${WS_ANY}]`);

/* A frontmatter `key: value` pair. WS_BOTH after the colon, because the twin
   in tools/validate.py takes everything after the colon and trims it with
   WS_BOTH: `\\s*` here would eat a U+FEFF that Python keeps, and the two gates
   would hold different values for the same key (ROW-211). */
export const FRONT_PAIR = new RegExp(`^([A-Za-z_][A-Za-z0-9_]*):[${WS_BOTH}]*(.*)$`);

export const CAPABILITY_REF = yamlScalarRe('capability_ref');
export const CAPABILITY_REF_LINE = yamlScalarRe('capability_ref', true);
export const STATUS = yamlScalarRe('status');
/* Anchored twin of STATUS, same reason CAPABILITY_REF_LINE exists beside
   CAPABILITY_REF: added 2026-09-08 for capabilityBlockEntries() below, which
   used the unanchored forms of both and a critic built the consequence —
   see that function's own comment for the repro and the fix. */
export const STATUS_LINE = yamlScalarRe('status', true);
export const COMPARISON_MODE = yamlScalarRe('comparison_mode');

/* Walks section 3's `capabilities:` block once and pairs each entry's
   `capability_ref` with its `status`, and both fields with their raw line
   text. Entry-scoped, not line-scoped, and scoped to `capabilities:` alone,
   not `inputs:`: a document-wide scan for `status: used` beside a
   document-wide scan for a write id would fire on a passport whose
   capabilities block is honest and whose `inputs` block happens to mention
   one, so the pairing is done inside a single `- ` entry or not at all. That
   is also why this cannot answer "does section 3 declare a write capability
   anywhere" — `declaresWrite` in _derive.mjs is the wider, unpaired scan for
   that question, spec section 7 check 3's "anywhere in section 3", and an id
   found only in `inputs:` has no entry here at all.

   Two callers: the envelope floor's "Status" check below, which only cares
   whether an entry is declared-only and mis-stated; and ROW-228's
   write-consent gate in upload.mjs, which needs the literal ref and status
   lines to hand an owner as text to delete, not a verdict. One walk, kept in
   one place, because a second copy of this state machine is how the two
   would disagree on where one entry ends and the next begins.

   BLOCK-SCALAR CONTENT IS STRIPPED FIRST (ROW-210), which the first version
   of this function did not do, and it was found on the ROW-228 branch by
   the passport-engineer's critic: `capability_ref: ext.write` quoted at the
   start of a line inside a `notes: |` scalar on a `capabilities:` entry was
   read as that entry's own field, refused `E_ENVELOPE_FLOOR`, while the wide
   `declaresWrite` scan in _derive.mjs — which already strips block-scalar
   content — correctly saw nothing. Same shape as the original ROW-210
   defect, one call site later: a text scan over a region the spec defines
   as free prose is not fixed by a narrower match, it is fixed by not
   reading the prose. Mirrors _derive.mjs's own `stripBlockScalarContent`
   call exactly: `sectionLines` first (the raw lines, fence delimiters
   included), then `fenceMap` to tell YAML lines from fence delimiters and
   from anything outside a fence, then the strip, over the YAML lines only.
   Corrected 2026-09-08: this said `sectionBody` first, which is a different
   function (a presence check plus `sectionLines`) that this walk does not
   call; a critic caught the mismatch between the word "exactly" and the
   code beneath it. */
export function capabilityBlockEntries(lines) {
  const specLines3all = sectionLines(lines, '## 3. Functional spec');
  const specFences = fenceMap(specLines3all);
  const specYaml = specFences.inside.map((v, i) => v && !specFences.delimiter[i]);
  const specLines3 = stripBlockScalarContent(specLines3all, specYaml);
  const entries = [];
  let inCaps = false, entryRef = null, entryStatus = null, refLine = null, statusLine = null;
  const closeEntry = () => {
    if (entryRef !== null) entries.push({ ref: entryRef, status: entryStatus, refLine, statusLine });
    entryRef = null; entryStatus = null; refLine = null; statusLine = null;
  };
  for (const l of specLines3) {
    if (/^capabilities:/.test(l)) { inCaps = true; continue; }
    if (!inCaps) continue;
    /* The block ends at the next key in column 0, exactly as yaml_block() in
       tools/validate.py ends it. A list item's dash in column 0 is legal YAML
       and continues the block. */
    const lt = yamlTrim(l);
    if (lt && !WS_ANY_RE.test(l) && !lt.startsWith('-')) { closeEntry(); inCaps = false; continue; }
    if (LIST_ENTRY.test(l)) closeEntry();   // WS_ANY, twin of input_entries()
    /* `(\S+)` then scalar(), character for character what tools/validate.py
       check 16 does. Two corrections live in that one line.

       First: the class was `[A-Za-z0-9_-]+` and could not match a quoted
       scalar at all, so `status: "declared_only"` produced NO match, read as a
       missing status, and was refused here while tools/validate.py stripped
       the quotes and accepted it. Opposite verdicts on a passport that did
       nothing wrong, with an error telling its author to write the value they
       had written. The `.replace()` beside each of these looked like it
       handled quoting and was dead code.

       Second, and it is the reason `#` is NOT excluded here: a `#` opens a
       YAML comment only when whitespace precedes it, so `declared_only#x` is
       the scalar `declared_only#x` and the entry is not declared-only. The
       class `[^\s#]+` truncated it to `declared_only`, this gate accepted a
       write capability on a bogus status, and tools/validate.py refused the
       same file. The permissive side was the PUBLIC one. A trailing
       ` # comment` is still handled, because the space ends `\S+` before the
       hash. */
    const mRef = l.match(CAPABILITY_REF);
    if (mRef) { entryRef = scalar(mRef[1]); refLine = l; }
    const mSt = l.match(STATUS);
    if (mSt) { entryStatus = scalar(mSt[1]); statusLine = l; }
  }
  closeEntry();
  return entries;
}

/* Sibling of capabilityBlockEntries(), scoped to `inputs:` instead of
   `capabilities:`, same column-0-key boundary rule. Added 2026-09-08: a
   critic on the ROW-228 branch found that nothing in this file or
   _derive.mjs ever read `inputs:` as ITS OWN region — the wide `declaresWrite`
   scan (specRefs in _derive.mjs) reads all of section 3 undifferentiated, so
   "found only on an inputs: entry" and "found only outside the capabilities:
   block" were being treated as the same predicate. They are not: an id under
   `output:`, or any other section-3 key that is neither `inputs:` nor
   `capabilities:`, is in NEITHER place, and spec section 6.3 is explicit that
   shape gets the bare E_DERIVE_ENVELOPE, not E_DERIVE_ENVELOPE_INPUT. This
   function is what lets the two be told apart: it returns only ids actually
   found under `inputs:`, nothing else.

   An `inputs:` entry carries no `status` (spec section 4's schema for it is
   {what, capability_ref, access, ...}, no status field at all), so unlike
   capabilityBlockEntries this returns a bare ref set, not paired lines: there
   is no status half to pair with, and no caller of this function hands an
   owner text to delete. */
export function inputCapabilityRefs(lines) {
  const specLines3all = sectionLines(lines, '## 3. Functional spec');
  const specFences = fenceMap(specLines3all);
  const specYaml = specFences.inside.map((v, i) => v && !specFences.delimiter[i]);
  const specLines3 = stripBlockScalarContent(specLines3all, specYaml);
  const refs = new Set();
  let inInputs = false;
  for (const l of specLines3) {
    if (/^inputs:/.test(l)) { inInputs = true; continue; }
    if (!inInputs) continue;
    const lt = yamlTrim(l);
    if (lt && !WS_ANY_RE.test(l) && !lt.startsWith('-')) { inInputs = false; continue; }
    /* ANCHORED (CAPABILITY_REF_LINE, not CAPABILITY_REF), same reason the
       wide declaresWrite scan in _derive.mjs is anchored: an inputs: entry's
       `what` field is free prose same as tacit_notes is for a capabilities:
       entry, and an owner sentence merely mentioning "capability_ref:
       msg.send" must not be read as a declaration. This function has no
       Python twin to keep in step (unlike capabilityBlockEntries(), whose
       unanchored match mirrors tools/validate.py check 16a's `CAPABILITY_REF
       .search()` on purpose — see that function's own comment), so there is
       no parity cost to anchoring it correctly from the start. */
    const mRef = l.match(CAPABILITY_REF_LINE);
    if (mRef) refs.add(scalar(mRef[1]));
  }
  return refs;
}

/* Anchored, block-scoped, NOT entry-paired: every declared-only-or-not ref
   found anywhere inside the `capabilities:` block, collected the same safe
   way inputCapabilityRefs() collects `inputs:` refs. Added 2026-09-08 as the
   fix for a critic-found regression: ROW-228's write-consent gate used to
   source its marker ids from capabilityBlockEntries()'s entry/ref/status
   PAIRING, which is unanchored on purpose (parity with tools/validate.py
   check 16a, see that function's comment) and therefore last-match-wins
   within an entry — an entry whose own honest `capability_ref: email.send`
   is followed by a `tacit_notes: "...capability_ref: msg.send..."` line
   reports the entry as msg.send, not email.send. Before this commit that
   only degraded a line lookup (the id itself came from the wide, correct
   `declaredOnlyRefs`); after 16ee46a it corrupted the id shown to the owner
   too, since capability_markers now iterates capabilityBlockEntries()'s own
   (wrong) ref set. This function gives upload.mjs a correct id set without
   touching capabilityBlockEntries() or its Python-parity constraint: it
   answers "is this id anywhere in the block", not "which entry does it
   belong to and what is its status", so it cannot misattribute — the same
   anchored match that already makes the wide section-3 scan and
   inputCapabilityRefs() prose-safe. capabilityBlockEntries() remains the
   line-text source (best effort: it can still return zero or, in a
   sufficiently adversarial passport, uncorrelated lines for a given ref;
   that residual is the same one FAIL 16a carries in Python and is not
   closed here). */
export function capabilityBlockRefs(lines) {
  const specLines3all = sectionLines(lines, '## 3. Functional spec');
  const specFences = fenceMap(specLines3all);
  const specYaml = specFences.inside.map((v, i) => v && !specFences.delimiter[i]);
  const specLines3 = stripBlockScalarContent(specLines3all, specYaml);
  const refs = new Set();
  let inCaps = false;
  for (const l of specLines3) {
    if (/^capabilities:/.test(l)) { inCaps = true; continue; }
    if (!inCaps) continue;
    const lt = yamlTrim(l);
    if (lt && !WS_ANY_RE.test(l) && !lt.startsWith('-')) { inCaps = false; continue; }
    const mRef = l.match(CAPABILITY_REF_LINE);
    if (mRef) refs.add(scalar(mRef[1]));
  }
  return refs;
}

/* A key whose value is a YAML block scalar: `note: |`, `what: >-`, `why: |+2`.
   Everything indented under one of these is TEXT, not fields. Mirrors
   BLOCK_SCALAR_KEY in tools/validate.py, character for character. */

/* GROUP 1 IS EVERYTHING BEFORE THE KEY, dash and its spaces included, so its
   length is the COLUMN OF THE KEY, which is where YAML measures a block
   scalar's content from. The first version computed dash + 2, so `-   note: |`
   measured 4 where YAML measures 6 and two real sibling keys were eaten as
   prose. Never assume the separator is one character wide.

   INDENTATION IS SPACES: the leading class is [ ] and not \s. YAML forbids a
   tab in indentation, and the two runtimes' \s disagree on nine of thirty
   shapes measured: Python's lstrip() eats \x1c, \x1e and \x85, this one does
   not, and this one eats U+FEFF where Python's does not. A rule both gates must
   agree on cannot rest on a set neither language pins. Twin of
   BLOCK_SCALAR_KEY in tools/validate.py, character for character. */
export const BLOCK_SCALAR_KEY = /^( *(?:-[ ]+)?)[A-Za-z_][A-Za-z0-9_.-]*: *[|>][-+]?[0-9]* *$/;

/* The line's YAML indentation: the count of leading SPACE characters. Twin of
   yaml_indent() in tools/validate.py. A tab or control character in the indent
   position is not YAML indentation, so it counts as column 0 and closes any
   open block, which is the fail-closed direction: the line is READ as a field
   rather than skipped as prose. */
export function yamlIndent(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

/* Drop the lines that are the CONTENT of a YAML block scalar, keeping the key
   that opened it. Twin of strip_block_scalar_content() in tools/validate.py,
   and the two must move together: this is the fourth call site the comment in
   _derive.mjs warned about, so the rule and the regex feeding it travel as one
   thing or they are not converged.

   WHY THIS EXISTS (ROW-210). The capability_ref scan was anchored to a line
   start, which was a real repair and was not enough. `tacit_notes` is defined
   at spec section 4 as the owner's words "verbatim, quoted not paraphrased",
   and vocabulary.md rule 5 sends capture there when no id fits, so it is at
   once the place most likely to name a capability in prose and the place we
   have promised not to reword. An owner quoting a config line at the START of
   a line inside it was read as declaring the capability, and BOTH gates
   refused the honest passport: tools/validate.py with FAIL 16, this one with
   E_DERIVE_ENVELOPE. Measured on 2026-09-07, not inferred from the source.

   A text scan over a region the spec defines as free prose is not fixed by a
   narrower match. It is fixed by not reading the prose.

   The rule is YAML's own: content is whatever is indented strictly deeper than
   the key that opened the block, and the block ends at the first line that is
   not. Blank lines inside a block are content. The dash of a list entry is
   stepped over so the content of `- what: |` measures from `what` rather than
   from the dash, which is where YAML measures it too.

   ONE FENCE MACHINE PER DOCUMENT, and this is not it. Two earlier versions got
   this wrong, both caught by a critic and neither merged: the first had no
   notion of fences and read a block-scalar key out of the Markdown prose above
   the fence, and the second grew its own machine that TOGGLED on every
   delimiter where fenceMap() below closes only on a delimiter at least as long
   as the one that opened it. A three-backtick fence inside a four-backtick one
   is content to fenceMap and a state flip to a toggle, and the disagreement put
   a declared email.send at status: used in front of a reader as an installable
   row. The second version also reset the block on every delimiter, on the
   premise that a fence cannot sit inside a scalar, which is false: a block
   scalar is text and backticks are text, and that premise reintroduced ROW-210
   for its most likely input, an owner pasting a fenced config into tacit_notes.

   fenceMap() already computes this under the length rule, and its own comment
   says it is deliberately the same rule as _sections.mjs so that the renderer
   and the gate agree about where a fence ends. Consuming it is the fix; writing
   a third reader was the bug.

   The older note, kept because it names the first mistake. _derive.mjs passes
   sectionBody('## 3. Functional
   spec'), which is the whole section INCLUDING the Markdown prose above the
   fence and the fence lines. A `notes_for_reviewer: |` written in that prose is
   not YAML and opens nothing, but this read it as a block-scalar key, and
   because an INDENTED fence is accepted, every line of the real YAML below was
   deeper and was swallowed. A passport declaring email.send at status: used
   with every consent row marked yes went from refused by both gates to accepted
   by both. Caught by a critic before it merged. A rule about YAML applied to a
   region that is not YAML will find YAML in prose, which is the same sentence
   as the bug this function exists to fix, one level up.

   KNOWN HOLE, not closed here: a multi-line QUOTED scalar is not a block
   scalar, so its continuation lines are still read as fields. Closing that
   means parsing YAML rather than matching it, which tools/validate.py's
   input_entries() names as the same larger decision. */
export function stripBlockScalarContent(lines, inYaml = null) {
  const out = [];
  let blockIndent = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    /* THE CALLER SAYS WHICH LINES ARE YAML, and this function runs no fence
       machine of its own. `null` means all of them, which is true of the block
       the twin of input_entries() is handed. Twin of the Python signature,
       where the flag rides on each entry instead. */
    const yes = inYaml === null ? true : inYaml[i];
    if (blockIndent !== null) {
      /* yamlTrim, the WIDE class, not .trim(). Twin of the note in
         tools/validate.py: a blank line cannot extend a block past a dedent, so
         the width buys an attacker nothing that deleting the declaration does
         not buy more cheaply, and the narrow reading refuses a lone-\x85 line
         that PyYAML calls a line break inside the scalar. */
      if (!yamlTrim(line)) continue;                               // blank: inside
      if (yamlIndent(line) > blockIndent) continue;
      blockIndent = null;                                          // dedent: closed
    }
    out.push(line);
    if (!yes) continue;        // a delimiter, or Markdown prose: opens nothing
    const m = BLOCK_SCALAR_KEY.exec(line);
    if (m) blockIndent = m[1].length;   // the COLUMN OF THE KEY, see above
  }
  return out;
}

export function scalar(v) {
  /* structuralTrim, which uses WS_BOTH, rather than .trim(), which uses this
     engine's `\s` and would remove a \ufeff that Python's .strip() keeps. */
  return structuralTrim(v).replace(/^(["'])(.*)\1$/, '$2');
}

const VOCAB = new Set([
  'web.fetch', 'email.read', 'calendar.read', 'files.read',
  'schedule.run', 'chat.notify', 'memory.prefs',
  'email.send', 'msg.send', 'social.post', 'ext.write'
]);

/* The declared-only half of the vocabulary: capabilities that write to the
   world. spec/passport-0.1.md section 5 puts them outside the read-notify
   envelope, section 7 makes that executable, and tools/validate.py check 16 is
   the other implementation of the same rule.

   `money.` is a PREFIX and not an id. vocabulary.md's own note on reading it
   from code is exactly about this: the set is closed except for one wildcard,
   and the wildcard's suffix is text a stranger wrote. Nothing here compares a
   money id for equality, and nothing here stores or prints the suffix. */
const DECLARED_ONLY = new Set(['email.send', 'msg.send', 'social.post', 'ext.write']);
export const DECLARED_ONLY_PREFIX = 'money.';

/* Lower-case the ASCII capitals and nothing else. Not toLowerCase(): the two
   runtimes disagree on 154 codepoints under full folding and the record says
   not to build on their agreement. A-Z is the same table everywhere. Twin of
   fold_ascii() in tools/validate.py. */
export function foldAscii(s) {
  return s.replace(/[A-Z]/g, c => c.toLowerCase());
}

/* Folded on ASCII case: `MONEY.transfer` and `EMAIL.send` in an installable
   row were accepted by both gates, on main and on the branch that closed the
   lower-case prefix, so one capital letter bought what declaring less used
   to buy. Ids are lower-case by vocabulary; nothing honest spells one in
   capitals. */
export function isDeclaredOnly(ref) {
  ref = foldAscii(ref);
  return DECLARED_ONLY.has(ref) || ref.startsWith(DECLARED_ONLY_PREFIX);
}

/* A backticked `money.<ext>` in a consent cell is a filename, not an id. The
   cell is prose written for a person, and "Read the ledger file (`money.csv`)"
   is an honest row that both gates once refused as an offer to move money.

   THIS LIST IS THE WHOLE JUDGEMENT. Until 2026-09-04 the test for "filename,
   not id" was whether the passport declared the token as a capability_ref, and
   that resolved the ambiguity in favour of ACCEPT: an undeclared
   `money.transfer` in an installable row passed both gates, was stored with
   installable: true and rendered Granted, because a lying passport declares
   nothing (ROW-158). So the test is now the shape of the token and the
   presumption runs the other way: a `money.` token is an id unless it is
   exactly `money.<ext>` for an extension in this set. The cost lands on the
   honest author whose ledger is `money.xyz` or `money.ledger.csv`, refused
   with a message that says how to fix it.

   Mirrors FILENAME_EXTENSIONS in tools/validate.py entry for entry; parity
   holds the two to one verdict but cannot read either list, so a change to one
   is a change to both. An entry that is a way of spending money reopens the
   hole by that word; tools/run_tests.sh test 16 checks every entry against
   every money id the repository names and against a floor list of verbs. Every consumer of the decision goes through
   consentTokenIsWriteId() so the list is consulted in exactly one place. */
const FILENAME_EXTENSIONS = new Set([
  'csv', 'tsv', 'txt', 'md', 'json', 'yaml', 'yml', 'xml', 'toml', 'ini',
  'xlsx', 'xls', 'ods', 'numbers', 'parquet', 'db', 'sqlite', 'sqlite3',
  'log', 'dat', 'pdf', 'ofx', 'qif', 'xlsm', 'gnucash',
]);

/* The WHOLE suffix after the prefix, not the last dot segment: read by last
   segment, `money.transfer.csv` skipped, and the evasion cost fell to four
   extra characters. Read whole, the skip is a closed set of exact strings. */
export function isFilenameToken(token) {
  return FILENAME_EXTENSIONS.has(foldAscii(token.slice(DECLARED_ONLY_PREFIX.length)));
}

/* Whether a backticked consent-cell token must be read as a write id. The
   single place the money-guard decision is made: a declared token is an id
   whatever its shape, an undeclared `money.` token is an id unless it is
   shaped like a file, the four fixed ids are ids always. Twin of
   consent_token_is_write_id() in tools/validate.py. */
/* Strip ASCII space and tab, and only those. Not String.prototype.trim():
   JavaScript's trim() and Python's strip() disagree on U+001C to U+001F,
   U+0085 and U+FEFF, so `money.csv` followed by a BOM was stored here and
   refused by tools/validate.py. Twin of strip_blanks(). */
export function stripBlanks(token) {
  return token.replace(/^[ \t]+|[ \t]+$/g, '');
}

/* True when a token carries an ASCII control character or DEL. Unconditional,
   and separate from the lookalike test. 0x00 to 0x1F and 0x7F are not text,
   and they are exactly the characters trim() and Python str.strip() disagree
   about. Twin of is_ascii_control(). */
export function isAsciiControl(token) {
  for (const c of token) {
    const n = c.codePointAt(0);
    if (n < 0x20 || n === 0x7f) return true;
  }
  return false;
}

/* Whether chars matches target with every non-ASCII character a wildcard.
   Position by position, same length. No regex, so nothing backtracks and
   nothing needs escaping; no Unicode table, so the two runtimes cannot
   disagree about a codepoint. Twin of wildcard_matches(). */
/* AT LEAST ONE POSITION MUST MATCH BY EQUALITY. The first version required
   only that every position be equal OR non-ASCII, so a slice of six non-ASCII
   characters matched 'money.' at every position and every CJK or Cyrillic word
   of six characters or more was refused inside a backticked span of an
   installable row. ROW-167 exists to stop refusing a passport for the language
   it is written in and it was doing that to a wider set than the rule it
   replaced. A wildcard match with no anchor is not evidence. THE RESIDUAL IS AN OPEN
   HOLE, not a cost argued down. A token with no ASCII letter or digit in the
   compared region is not a lookalike, so `ⅿоոеу․transfer_acct_99` (Roman
   numeral m, Cyrillic o, Armenian n, Cyrillic e and u, one-dot leader) reads
   as money.transfer and passes, with the whole account suffix in plain ASCII
   because the prefix test reads only six characters. The first version of this
   comment called the residual safe on the ground that fullwidth and CJK
   characters are visibly not the ASCII ones; that is true of fullwidth and
   FALSE of U+217F, which is drawn as an ordinary lowercase m. Built and
   measured by the ROW-167 critic against this code.

   AND IT IS TRADED, NOT FREE. It is not a stated cost against nothing. Main
   at 51eb1bc refuses that attack token today, because the rule this one
   replaces refuses every token carrying any character outside printable
   ASCII, and it closes this route by accident while doing it: measured
   against main's own consent_token_is_opaque(), True for the attack and True
   for Приложение.csv, 売上レポート and Zahlungsübersicht.csv alike. So this
   change closes a live nine-script false positive and opens one confusable
   route that was shut. Tracked as ROW-172, with a
   block-range direction that needs no Unicode table: what separates the
   critic's 93 honest tokens from these attacks is not how much ASCII they
   carry, since Приложение.csv carries none either, but that the honest ones
   draw their non-ASCII from ONE range and the attacks from four. Twin:
   wildcard_matches() in tools/validate.py. */
export function wildcardMatches(chars, target) {
  const t = Array.from(target);
  if (chars.length !== t.length) return false;
  let anchored = false;
  for (let i = 0; i < chars.length; i++) {
    /* A LETTER OR DIGIT anchors, not any equal character. The first anchored
       version accepted the dot as evidence, and 메모장기록.csv, an ordinary
       Korean filename, still matched 'money.' on one full stop in position 5.
       A dot is the commonest character in a filename and is worth nothing as
       evidence that a word is a capability id. */
    if (chars[i] === t[i]) { if (/[A-Za-z0-9]/.test(chars[i])) anchored = true; }
    else if (chars[i].codePointAt(0) <= 0x7f) return false;
  }
  return anchored;
}

/* True when a token containing non-ASCII is a write id in disguise. Twin of
   token_is_id_lookalike(), which carries the reasoning. Two readings: DELETE
   every non-ASCII character, and REPLACE each with a single-character
   wildcard. Neither is enough alone; deletion cannot see a substitution and
   substitution cannot see an insertion.

   Array.from(), NOT indexing or .length. A lookalike outside the Basic
   Multilingual Plane is one codepoint to a reader and two UTF-16 units to a
   naive loop, which would make the length test disagree with the Python
   twin on exactly the input somebody chose for being unusual. */
export function tokenIsIdLookalike(token) {
  const chars = Array.from(foldAscii(token));
  if (!chars.some(c => c.codePointAt(0) > 0x7f)) return false;
  const deleted = chars.filter(c => c.codePointAt(0) <= 0x7f).join('');
  if (isDeclaredOnly(deleted)) return true;
  for (const ref of DECLARED_ONLY) {
    if (wildcardMatches(chars, ref)) return true;
  }
  return wildcardMatches(chars.slice(0, Array.from(DECLARED_ONLY_PREFIX).length),
    DECLARED_ONLY_PREFIX);
}

/* True when a backticked token in an installable row must be refused without
   being echoed: an ASCII control character, which is never text, or a write id
   spelled with characters that are not the ones the id is spelled with. Twin
   of consent_token_is_opaque(). */
export function consentTokenIsOpaque(token) {
  return isAsciiControl(token) || tokenIsIdLookalike(token);
}

/* Every segment of a Capability cell split on its backticks, with a flag for
   "bounded by a backtick on both sides". Not the regex-paired spans: with an
   odd count, or a double-backtick span around a single-backticked id, the
   pairing shifted and the id was never enumerated while the page rendered it
   under Granted. Splitting has no pairing to get wrong. Twin of
   consent_cell_segments(), which carries the reasoning. */
export function consentCellSegments(cell) {
  const parts = cell.split('`');
  const last = parts.length - 1;
  return parts.map((seg, i) => [seg, i > 0 && i < last]);
}

export function consentTokenIsWriteId(token, specRefs) {
  token = foldAscii(token);
  if (!isDeclaredOnly(token)) return false;
  if (token.startsWith(DECLARED_ONLY_PREFIX) && !specRefs.has(token) && isFilenameToken(token)) {
    return false;
  }
  return true;
}

/* A refusal message quotes a consent cell so its author can find the row. The
   cell is a stranger's text, so what it may carry into the message is bounded
   twice: capped, because nothing clipped these fields and a passport may be
   262144 bytes with most of it in one cell; and with every money token
   collapsed whether or not it is backticked, because the span collapses missed
   an UNbackticked money id in the same cell and carried its suffix into an
   endpoint error. Twins of clip_echo() and collapse_bare_money(). */
const ECHO_CAP = 200;
export function safeCellEcho(text) {
  const collapsed = text.replace(/money\.\S*/gi, 'money.*').trim();
  return collapsed.length <= ECHO_CAP ? collapsed : collapsed.slice(0, ECHO_CAP) + '...';
}

/* The five column names of the consent table, in order, so a refusal can say
   which cell carried the id. Fixed strings from the header row, never a
   stranger's text. Twin of CONSENT_COLUMNS in tools/validate.py. */
export const CONSENT_COLUMNS = ['Capability', 'Why', 'Required / Optional',
  'If you skip it', 'Installable in v0.1'];

/* A word with the sentence punctuation trimmed off both ends. A vocabulary id
   begins and ends with an ASCII letter or digit, so that is the whitelist: it
   needs no Unicode table and no guess about which quote a stranger used. Twin
   of id_core(), which carries the reasoning. Only the ends, so `#` and `.`
   inside a word survive and money.transfer#1 is untouched. Never used on its
   own: consentCellWriteId() tests a candidate as written AND as its core, so
   trimming can only add a refusal. */
const ID_TRIM = /^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g;
export function idCore(word) {
  return word.replace(ID_TRIM, '');
}

/* The first write id a consent cell names, or null. Twin of
   consent_cell_write_id(), which carries the reasoning. Two readings of the
   same cell: every SEGMENT between backticks tested whole, and every WORD of
   every INNER segment tested on its own, because `email.send now` is a span
   with an id and a word in it and the whole-span test compares the whole span
   to a fixed id and misses it. Words are read inside backticks only: a word of
   ordinary prose that spells an id is the prose-to-id gap, open by design. */
/* The first backticked word of a cell that must be refused unread, or null.
   Twin of consent_cell_opaque_word(), which carries the reasoning. WORDS of
   INNER segments, and the one-word carve-out is gone: it existed only because
   the old rule refused any non-printable-ASCII character and so had to exempt
   prose, and exempting every multi-word segment opened a hole the width of one
   space. consentTokenIsOpaque() no longer fires on a word that is not already
   shaped like a write id, so nothing needs exempting. */
/* The word boundary for the ID scan: anything that is not printable ASCII
   other than space. A vocabulary id is printable ASCII by definition, so every
   other character is a gap between words for this scan, and the class rather
   than just space and tab is what closes a separator that is not a space:
   `email.send<NBSP>now` split on [ \t]+ is one word, equals no fixed id, and
   reached a Granted stamp in four of five cells with the id itself in
   byte-identical ASCII. The OPACITY scan deliberately does NOT use this: it is
   looking for non-ASCII and cannot use non-ASCII as a boundary. Twin of
   ID_WORD_SPLIT in tools/validate.py. */
const ID_WORD_SPLIT = /[^\x21-\x7e]+/;

/* Each maximal run of ADJACENT code spans, concatenated as a page shows it.
   Twin of consent_cell_code_runs(), which carries the reasoning. inline()
   pairs backticks and emits one <code> per pair, so `email.``send` renders as
   two elements with nothing between them, which a reader sees as the single
   string "email.send" while the split reading sees "email.", "" and "send" and
   no id at all. This PAIRS, which is the reading consentCellSegments() exists
   not to make; both are kept, and a candidate found by either is refused, so
   the pair can only add refusals. */
const CODE_SPAN = /`([^`]+)`/g;
export function consentCellCodeRuns(cell) {
  const out = [];
  let run = [], prevEnd = null;
  CODE_SPAN.lastIndex = 0;
  let m;
  while ((m = CODE_SPAN.exec(cell)) !== null) {
    if (prevEnd !== null && m.index !== prevEnd) { out.push(run.join('')); run = []; }
    run.push(m[1]);
    prevEnd = m.index + m[0].length;
  }
  if (run.length) out.push(run.join(''));
  return out;
}

/* A word tested AS WRITTEN and AS ITS CORE, the first hit or null. The same
   union the id scan uses, and it was missing here: the id scan trims with
   idCore() and has no lookalike test, this scan had the lookalike test and no
   trim, so a lookalike with ordinary sentence punctuation on either end was
   read by neither. `emаil.send.`, `emаil.send,`, `(emаil.send)` and
   `(mоney.transfer)` all reached a Granted stamp through both gates, and all
   four were refused by the printable-ASCII rule this one replaced. Found by
   the ROW-167 critic. Twin: opaque_reading() in tools/validate.py. */
export function opaqueReading(word) {
  for (const probe of [word, idCore(word)]) {
    if (probe && consentTokenIsOpaque(probe)) return probe;
  }
  return null;
}

export function consentCellOpaqueWord(cell) {
  for (const [seg, inner] of consentCellSegments(cell)) {
    if (!inner) continue;
    const token = stripBlanks(seg);
    if (!token) continue;
    for (const word of token.split(/[ \t]+/)) {
      const hit = opaqueReading(word);
      if (hit !== null) return hit;
    }
  }
  /* And the run reading, so a lookalike split across two adjacent spans is
     seen as the one word a reader sees. Space and tab only here: this test is
     looking FOR non-ASCII and must not use it as a boundary. */
  for (const runText of consentCellCodeRuns(cell)) {
    for (const word of stripBlanks(runText).split(/[ \t]+/)) {
      const hit = opaqueReading(word);
      if (hit !== null) return hit;
    }
  }
  return null;
}

export function consentCellWriteId(cell, specRefs) {
  for (const [seg, inner] of consentCellSegments(cell)) {
    const token = stripBlanks(seg);
    if (!token) continue;
    /* Words first, then the whole segment: both orders reach the same
       verdict, and this order names the id rather than the four-word
       segment it sits in. See consent_cell_write_id(). */
    const candidates = inner ? [...token.split(ID_WORD_SPLIT), token] : [token];
    for (const cand of candidates) {
      /* As written and as its core, in that order. The union can only add
         refusals: `money.` is a write id by the prefix test as written and
         its core `money` is not. See consent_cell_write_id(). */
      for (const probe of [cand, idCore(cand)]) {
        if (probe && consentTokenIsWriteId(probe, specRefs)) return probe;
      }
    }
  }
  /* And the run reading. See consentCellCodeRuns(): the renderer pairs
     backticks and this file does not, so an id written across two adjacent
     spans is one word on the page and three segments here. */
  for (const rawRun of consentCellCodeRuns(cell)) {
    /* stripBlanks() FIRST, exactly as the segment path does: without it the
       whole-run candidate for `money.csv ` is "money.csv " and "csv " is not
       a listed extension, so an honest padded filename the segment path skips
       was refused by the run path. Two readings of one cell only work if they
       read it the same way. */
    const runText = stripBlanks(rawRun);
    for (const cand of [...runText.split(ID_WORD_SPLIT), runText]) {
      for (const probe of [cand, idCore(cand)]) {
        if (probe && consentTokenIsWriteId(probe, specRefs)) return probe;
      }
    }
  }
  return null;
}

/* Report a money capability as the prefix, never as the id it arrived as, per
   vocabulary.md: "record `money.*` and not the id it arrived as". These strings
   reach a rendered failure page. */
export function safeRefLabel(ref) {
  return foldAscii(ref).startsWith(DECLARED_ONLY_PREFIX) ? 'money.*' : ref;
}

const DENIED_PATHS = ['browser_profile', 'id_rsa', '.pem', 'credentials/', 'secrets/'];

/* Denied paths were matched with a bare case-sensitive `text.includes()`, so
   `Credentials/`, `ID_RSA`, `id\_rsa` and a name split across a line all walked
   past while staying perfectly readable. tools/validate.py check 9 is the other
   implementation and must reach the same verdict, or web/tools/parity.mjs is
   asserting an agreement that is not there.

   Deletes noise; does NOT collapse every non-alphanumeric run. The reasoning is
   written out at validate.py's normalize_forbidden and is worth one line here:
   collapsing turns `credentials/` into the ordinary word `credentials`, and a
   passport is expected to discuss credentials in prose. The trailing slash is
   the signal, not punctuation.

   The line-break rule rejoins only between two alphanumerics. Rejoining every
   break would join "done." to a following "Pemberton" and fire on `.pem`.

   NFKC FIRST, and it is not decoration. validate.py used casefold() and this
   used toLowerCase(), and the two are different functions:
   `'CREDENTIALſ/'.casefold()` is 'credentials/' while `.toLowerCase()` leaves
   the long s alone, so the two gates returned OPPOSITE verdicts on one
   passport, refused locally and stored here. Python is now on `.lower()`,
   which agrees with `.toLowerCase()`, and NFKC does the folding neither has.
   It also folds the fullwidth solidus, which was a separate evasion.

   `*` and `_` are in the noise class as Markdown emphasis: `cre**den**tials/`
   renders as the denied path. Deleting `_` is safe even though two entries
   contain one, because the entries are normalised through this same function. */
const DENIED_NOISE = /[\\`*_­​‌‍⁠﻿]/g;
const DENIED_SPLIT = /(?<=[a-z0-9])[ \t]*\n[ \t]*(?=[a-z0-9])/g;

function normalizeDenied(text) {
  return text.normalize('NFKC').toLowerCase()
    .replace(DENIED_NOISE, '').replace(DENIED_SPLIT, '');
}

const SECTIONS = [
  '## 1. What this agent is',
  '## 2. What it needs from you',
  '## 3. Functional spec',
  '## 4. Golden examples',
  '## 5. Installer',
  '## 6. Losses'
];

const FRONTMATTER_KEYS = [
  'passport', 'name', 'title', 'created',
  'capture_path', 'source_stack', 'owner_confirmed', 'scrub', 'envelope'
];

/* Section 7 of the spec. These strings are shown to the uploader unchanged.
   There is one copy of each, here. The create page renders them, it does not
   paraphrase them. */
export const MESSAGES = {
  E_CONTENT_TYPE:   'This does not look like a Markdown file. Upload the .md file the capture produced, or paste its text.',
  E_TOO_LARGE:      'That file is larger than 256 KB. A passport describes an agent, it does not contain one. Trim the golden examples and try again.',
  E_TOO_SMALL:      'That file is too short to be a passport. Check that you copied the whole thing, including the frontmatter at the top.',
  E_NOT_UTF8:       'This file is not valid UTF-8 text. Save it as UTF-8 and upload it again.',
  E_CONTROL_CHARS:  'This file contains control characters that do not belong in a text document. Re-export it from your editor as plain UTF-8.',
  E_RATE_LIMIT:     'Too many uploads from this network. Try again in an hour.',
  /* The delete endpoint used to return E_RATE_LIMIT, which told somebody trying
     to delete a passport that they had made too many uploads. Same limiter,
     different verb, so it gets its own string. The number is in the text
     because /delete now prints it beside the token field, and a limit the page
     states is not a trap. */
  E_DELETE_LIMIT:   'Too many delete attempts from this network. The limit is 20 in an hour, counted per network and not per passport. Try again in an hour; your passport and its token are unaffected.',
  E_DUPLICATE:      'This exact passport was uploaded a moment ago. Use the link you already have.',
  E_FRONTMATTER:    'The block at the top of the file is missing or unreadable. A passport starts with three dashes, then the key and value lines, then three dashes.',
  E_MISSING_KEY:    'The passport is missing required information at the top of the file. Missing: {keys}. Re-run the capture rather than filling these in by hand.',
  E_BAD_VALUE:      'One of the values at the top of the file is not valid: {field}. Expected {expected}.',
  E_UNKNOWN_VERSION:'This passport says it is format version {version}. This site only reads version 0.1.',
  E_BAD_ENVELOPE:   'This passport declares the envelope {envelope}. Version 0.1 only accepts read-notify. An agent that writes to the world can still be captured, but its write capabilities are listed and not installed.',
  E_SECTIONS:       'The passport is missing one or more of its six sections, or has one twice. Missing or duplicated: {sections}.',
  E_SECTION_ORDER:  'The six sections are present but out of order. They must run from "What this agent is" through to "Losses".',
  E_COMPARISON_MODE:'The functional spec is missing a valid comparison_mode, or has more than one. It must appear exactly once and be structural, exact, or input_relative.',
  E_CAPABILITY:     'The passport asks for a capability this site does not recognise: {refs}. Capabilities come from the published vocabulary and cannot be invented at capture time.',
  E_ENVELOPE_FLOOR: 'This passport declares the read-notify envelope and then marks a capability that writes to the world as something this version installs: {refs}. Version 0.1 lists those and does not install them. Re-run the capture so they carry status declared_only and read "no, declared only" in the consent table.',
  E_DERIVE_ENVELOPE:'The consent table offers to install a capability that writes to the world, which the read-notify envelope does not install. A capability outside the envelope belongs in that table, and its last column reads "no, declared only".',
  /* Sibling of E_DERIVE_ENVELOPE, ruled by HAL 2026-09-08: the Bateman shape (a
     declared-only write capability that surfaces only on an input, never in the
     capabilities: block, with no consent row at all) gets its own code rather than
     a variant field on E_DERIVE_ENVELOPE, because tools/run_tests.sh holds this
     table equal to site/spec/upload-validation.md §7 text for text and a variant
     field would put the sentence where that parity check cannot see it. Text
     copied byte for byte from the spec (upload-gate-spec, 5d3e8b3); do not
     paraphrase it here. {refs} is filled through safeRefLabel(), same as every
     other {refs} placeholder in this table. */
  E_DERIVE_ENVELOPE_INPUT: 'Section 3 names a capability that writes to the world on one of the agent\'s inputs, {refs}, and the consent table has no row reading "no, declared only". Two fixes, and only one of them is true of your agent: if the original agent did use that capability, the consent row belongs back and its last column reads "no, declared only"; if it did not, the table is not what is wrong, the input is. Change that input\'s capability_ref to the capability the original actually read it with, or delete the input. Never write the row back to satisfy this message when the agent did not write there.',
  /* Wording authored by web-backend (2026-09-04) for the backticked-money-token
     site in _derive.mjs, where the declared-only fix can be a lie about the
     agent. {token} is filled through safeRefLabel(): a money suffix is a
     stranger's text and never reaches a page as written. */
  /* web-backend's wording (2026-09-04) for a backticked token an installable
     row carries that is not printable ASCII. {row} is filled with EVERY
     backticked span collapsed, since the token is by definition a lookalike
     or unprintable and must not be echoed. */
  E_DERIVE_ENVELOPE_OPAQUE: 'Consent row "{row}" backticks a token in its {cell} column that this site will not repeat back, because it is either an ASCII control character, or a capability id spelled with a lookalike character, such as a Cyrillic o in place of the Latin one, or a zero-width space inside the word. Its Installable column says "{column}". If the token is a capability that writes to the world, that column reads "no, declared only"; never write that when it is not true of your agent. If it is an honest filename, retype it: the characters that look wrong are not the ones you meant.',
  E_DERIVE_ENVELOPE_TOKEN: 'Consent row "{row}" names `{token}` in its {cell} column, which writes to the world, and its Installable column says "{column}". Two fixes, and only one of them is true of your agent: if the backticked token is a filename, write it without backticks; if it is a capability that moves money, the column reads "no, declared only". Never write the second when the first is the truth.{prose}',
  /* ROW-168 split the scan over all five cells, and a message written for
     the Capability cell became wrong advice in the other four: an author
     whose Why cell honestly names what SOME OTHER agent did was told to
     mark their own row declared-only, which is a lie about their agent.
     That is the failure this build split the cells to avoid one cell over.
     {prose} is filled with PROSE_FIX for cells 1 to 4 and with the empty
     string for the Capability cell, whose own message is already complete.
     Twin: PROSE_FIX in tools/validate.py, where the measured table is. */
  E_DERIVE_ENVELOPE_FIXED: 'Consent row "{row}" names `{token}` in its {cell} column, which writes to the world, and its Installable column says "{column}". Two fixes, and only one of them is true of your agent: if this row installs that capability, its Installable column reads "no, declared only"; if it does not, the cell should not name it as one.{prose}',
  E_FENCE_INVISIBLE: 'A line in this passport carries an invisible character before its code fence, so the fence never opens and the block below it is read as prose. A Markdown renderer will not open a code block there either. Delete the character before the backticks.',
  E_GOLDEN_COUNT:   'A passport needs between one and three golden examples. This one has {count}. Examples are the evidence that the agent does what the passport says.',
  E_SCRUB_GATE:     'This passport contains redacted sections, but nobody confirmed they were reviewed. Re-run the capture and complete the review step before sharing.',
  E_DENIED_PATH:    'This passport names a file or folder that capture is not allowed to read: {names}. Re-run the capture.',
  E_HTML:           'Passports are Markdown only. This one contains HTML: {tags}. Remove it and upload again.',
  E_UNFILLED:       'The capture did not finish. This passport still carries the template\'s own placeholders: {tags}. Replace each one with the real thing. If they are the losses table in section 6, delete the placeholder row and leave that table empty, because the install is what fills it in.',
  E_ACTIVE_CONTENT: 'This passport contains a link or URI that can execute code. Remove it and upload again.',
  E_SECRET_FOUND:   'This passport still contains something that looks like a credential: {kinds}. It was not stored. Remove it from the passport and upload again, then treat that credential as exposed and rotate it. If you captured this in a chat rather than with the skill, scroll back to the block you copied and fix it there.',
  /* Empty, not over-long: the length check in 4.2 fires first as E_BAD_VALUE,
     so the only title derive() can refuse is one that collapses to nothing.
     On main this string and the spec's row both said "longer than 200
     characters"; 28f60e9 corrected the spec and left this, so an owner whose
     title was one U+FEFF was told to shorten it (critic-211e). Test 21b holds
     this table to the spec's error table, text for text. */
  E_DERIVE_TITLE:   'The title at the top of the file is empty once invisible characters are removed. Give it one line a stranger can read at a glance. An over-long title is refused earlier, as `E_BAD_VALUE`.',
  E_DERIVE_SUMMARY: 'Section 1 could not be read as a description. It should be three plain sentences: what the agent does, when it does it, and what the output is for.',
  E_DERIVE_NEEDS:   'The table in section 2 could not be read. It needs five columns: capability, why, required or optional, what happens if skipped, and whether it installs in v0.1.',
  E_NOT_FOUND:      'No passport at this link. It may have been deleted, it may have expired, or the link may be incomplete.',
  E_DELETE_FAILED:  'That delete token does not match this passport. Nothing was deleted.',

  /* The owner review gate. This is not a validation failure: the passport is
     well formed and publishing it is allowed. It is a stop, and the only way
     past it is a ticket this endpoint minted when it refused, so the second
     request is provably downstream of the first one's refusal and no client can
     skip the exchange by sending a word it guessed.

     What that is and is not: no stateless endpoint can verify that a human read
     a paragraph, and this does not claim to. What it enforces is that the
     exchange happened, and the passport page prints "Did not confirm this
     description" on page 2 whatever the sharer decided. */
  E_OWNER_UNCONFIRMED:
    'This passport has not been through its owner review. Nobody confirmed that what it says about the agent is true, or that the redactions were checked. Publishing it is still your call, but you are publishing something that has not been read.',

  /* ROW-228. A browser-captured passport marking a capability outside the
     read-notify envelope: a declared-only id in its functional spec, a
     consent row whose Installable column starts with "no", or both. Refused
     rather than published as is or silently corrected. The generic message;
     the page reads capability_markers and consent_rows off the response for
     the specifics, because the two lists are not paired (see writeMarkers()
     in netlify/functions/upload.mjs) and a fixed string here cannot
     enumerate them meaningfully.

     DOES NOT ASSERT THE PASSPORT DECLARES A WRITE, on purpose, after a
     critic built the counterexample: the second gate condition is any "no"
     row (needs[].installable === false), which the validator does not
     restrict to declared-only capabilities — a passport can legally mark an
     ordinary read capability "no" for a reason that has nothing to do with
     writing to the world, and the gate cannot tell the two apart from a
     free-text cell. HAL ruled (2026-09-08, on ROW-227) that the predicate
     stays wide rather than narrowing to "declared only" rows only: the cost
     of the wide predicate is one extra confirmation on an unrelated "no"
     row; the cost of narrowing is silently missing the bare-"no" real-write
     shape arm B produced 7 of 7 times, which is the row the gate exists
     for. This wording is site/spec/upload-validation.md §7's text, copied
     byte for byte, not paraphrased: tools/run_tests.sh holds this table
     equal to the spec's text for text, and the spec's own wording already
     says "marks something as declared only" rather than asserting a write,
     independently of this file's earlier draft reaching the same
     conclusion from the critic's counterexample. */
  E_WRITE_UNCONFIRMED:
    'This passport was captured in a chat, and it marks something as declared only: a capability its original had that this version will not install, which is how a passport records a write to somewhere outside the agent. The lines that say so are listed below. Nobody but you can say whether they are true of the agent. If they are, publish it as it stands: nothing on those lines is installed for the recipient. If they are not, delete them from your paste and upload it again. This answer is open for fifteen minutes.',

  /* Sending. Every one of these leaves the passport published and the link
     working: the email is a delivery convenience, never the thing that made
     the link exist. */
  E_SEND_LIMIT:     'Too many emails from this network. The limit is 10 in an hour. The passport is published and the link works; send it yourself in the meantime.',
  /* Its own string, because the network ceiling's wording was wrong on every
     count when this one fired: wrong number, wrong window, and it told somebody
     they had sent too many emails when the cap they hit was on the passport. */
  E_SEND_PASSPORT_LIMIT:
    'This passport has been emailed five times today, which is the most one link can be sent from here in a day. The passport is published and the link works; copy it and send it yourself, or try again tomorrow.',
  E_SEND_ADDRESS:   'That does not look like an email address this site can send to. Check it, or copy the link and send it yourself.',
  E_SEND_UNPUBLISHED:'That passport is not published, so there is no link to send. Publish it first.',
  E_SEND_DISABLED:  'Sending email is not switched on for this deployment. The passport is published and the link works; copy it and send it yourself.',
  E_SEND_FAILED:    'The email did not go out. The passport is published and the link works, so copy it and send it yourself rather than trying again.',

  /* Managing. Deliberately the same sentence as E_DELETE_FAILED in shape: a
     wrong token, a malformed token and an id that is not there are one answer. */
  E_MANAGE_FAILED:  'That link and token do not go together. Check that you pasted both in full.',
  E_MANAGE_LIMIT:   'Too many attempts from this network. The limit is 20 in an hour, counted per network and not per passport. Your passport and its token are unaffected.',

  /* The gallery (GALLERY-SPEC.md §3, §7, §8). E_CATEGORY is the one refusal an
     upload can earn for something outside the file: the list header was sent
     with no category, or with one this site does not carry. Priced like every
     other refusal and counted in the rejection corpus. E_VOTE_FAILED is one
     body for every reason a vote is not recorded, on the same rule as
     E_MANAGE_FAILED: whether a uuid is listed is not for sale one guess at a
     time. */
  E_CATEGORY:       'To list a passport in the gallery, pick one of the categories. Nothing was published: choose a category and publish again, or untick the box to publish without listing.',
  E_VOTE_FAILED:    'That vote was not recorded. The passport may not be listed in the gallery any more, or the link may be incomplete.',
  E_VOTE_LIMIT:     'Too many votes from this network. The limit is 30 in an hour, counted per network. Try again later.',

  /* A 405 is not a failure on our side, and it used to say it was. Every
     endpoint answered a wrong method with E_INTERNAL, so a GET to /api/upload
     returned "Something failed on our side. The passport was not stored",
     which sends whoever is reading it looking for an outage that is not
     happening.

     TWO INDEPENDENT CLAIMS LIVE IN THIS ONE SENTENCE, and the first draft got
     the second one wrong. "Nothing was read and nothing was changed" is a claim
     about ORDER, and it holds because the method check is the first statement
     in all five handlers, ahead of clientIp, every rateLimit and every store
     call. The other half is a claim about WHICH METHODS ARE ACCEPTED, and it
     cannot be answered by looking at the rejection line. This said "only
     accepts POST", which is false for send and subscribe: both answer GET with
     200 from the line directly above, so a HEAD request was told GET is refused
     when it is not. Link preview fetchers and monitors send HEAD, so that was
     reachable rather than theoretical.

     It now names no method. The endpoint is the discriminator and it already
     answers correctly; the message does not need to enumerate a set that
     differs between endpoints, and a message that enumerates it is a second
     copy of the routing table that has to be kept in step. */
  E_METHOD:         'This endpoint does not accept that method. Nothing was read and nothing was changed.',

  E_INTERNAL:       'Something failed on our side. The passport was not stored. Nothing was published.'
};

/* See E_DERIVE_ENVELOPE_FIXED. Every clause of this sentence was
   measured against the live validator rather than reasoned:
     `email.send` in a Why cell                       REFUSED
     email.send, the whole cell, no backticks         REFUSED
     email.send `see docs`                            REFUSED
     `see docs` email.send                            REFUSED
     it used email.send `see docs`                    ACCEPTED
     the original used email.send, this one does not  ACCEPTED
     reads `a.csv`; the original used email.send      ACCEPTED
     we read `a.csv` and it used email.send to `b`    REFUSED
   So "without backticks" ALONE is false, and so was the first
   correction of it: the last line follows that advice exactly and is
   still refused, because a stretch between two spans is inner to a
   validator that will not pair backticks. Twin: PROSE_FIX in
   validate.py, where the full measured table is. */
export const PROSE_FIX =
  'This column is prose about the row rather than the capability the row installs, so there is one more possibility: if the cell only names what some other agent did, write it in a sentence with no backticks, placed before the first backtick in the cell or after the last. A stretch of text that is nothing but the id is read wherever it stands, and so is every word of a stretch lying between two backticks, because this validator does not pair them.';


/* EVERY CHECK-16 REFUSAL IS PURE ASCII, and that is a rule for the messages
   above rather than an accident of how they are worded today. The echo
   invariant in both suites asserts that no check-16 message contains a
   non-ASCII character, and it can assert that only because in this family a
   non-ASCII character could not have arrived any other way than by echo: the
   offending token is by definition a lookalike or an invisible. One message
   that legitimately spells a Cyrillic o destroys the invariant for all of
   them. So an example is SPELLED OUT and never pasted. The next author will
   reach for the character, because it is the obvious way to show a lookalike,
   and the failing test will look like pedantry. Delete the character, not the
   assertion. Twin: the same paragraph beside ECHO_CAP in tools/validate.py. */
export function err(code, fills, details) {
  let message = MESSAGES[code] || MESSAGES.E_INTERNAL;
  if (fills) {
    for (const [k, v] of Object.entries(fills)) {
      message = message.replaceAll('{' + k + '}', String(v));
    }
  }
  const out = { code, message };
  if (details && details.length) out.details = details;
  return out;
}

/* Angle-bracketed prose left behind by a capture, as opposed to a tag. Two
   ways to tell, because the first alone was not enough: the template writes
   "<a declared-only capability>", whose first word is the anchor element, and
   calling that HTML sends the owner looking for markup they never wrote. So a
   run of words with no attribute syntax counts too. Both are refused either
   way; this only decides which sentence the owner reads. */
function isPlaceholder(raw) {
  if (raw.startsWith('</')) return false;
  const inner = raw.slice(1, -1).replace(/\/$/, '');
  const name = inner.match(/^[A-Za-z][A-Za-z0-9-]*/)[0].toLowerCase();
  if (!HTML_ELEMENTS.has(name)) return true;
  return /\s/.test(inner) && !inner.includes('=');
}

/* ── stage 1, transport ─────────────────────────────────────
   Fails fast. Returns { error } or { text }. */
export function transport(buffer, contentType) {
  if (contentType) {
    const ct = String(contentType).split(';')[0].trim().toLowerCase();
    const ok = ct === 'text/markdown' || ct === 'text/plain' ||
               ct === 'application/octet-stream' || ct === '';
    if (!ok) return { error: err('E_CONTENT_TYPE') };
  }

  if (buffer.length > MAX_BYTES) return { error: err('E_TOO_LARGE') };

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return { error: err('E_NOT_UTF8') };
  }

  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // BOM is not an error
  if (buffer.length < MIN_BYTES) return { error: err('E_TOO_SMALL') };

  text = text.replace(/\r\n/g, '\n');                         // the only normalisation

  // C0 controls other than LF (0x0A) and TAB (0x09), plus DEL
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) {
    return { error: err('E_CONTROL_CHARS') };
  }
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
    return { error: err('E_CONTROL_CHARS') };
  }

  return { text };
}

/* Minimal YAML for a passport frontmatter block: flat `key: value` mappings.
   The spec calls for mappings only, so anything nested is a parse failure
   rather than something to interpret. */
function parseFrontmatter(lines) {
  const out = {};
  for (const raw of lines) {
    const line = raw.replace(WS_BOTH_END_RE, '');   // WS_BOTH, twin of validate.py
    if (!structuralTrim(line) || structuralTrim(line).startsWith('#')) continue;
    if (WS_BOTH_START_RE.test(line)) return null;      // nesting, not a flat mapping
    const m = line.match(FRONT_PAIR);   // WS_BOTH after the colon, twin of validate.py
    if (!m) return null;
    let v = structuralTrim(m[2]);
    if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
        (v.startsWith("'") && v.endsWith("'") && v.length > 1)) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/* Which lines sit inside a fenced code block. Fences are ``` or ```` runs.

   `delimiter` marks the lines that actually OPENED or CLOSED a fence, which is
   not the same set as the lines matching FENCE. A three-backtick run inside a
   four-backtick fence closes nothing, so it is content, and a caller that wants
   to know which lines are YAML needs `inside[i] && !delimiter[i]` rather than a
   second regex test. Testing the text was the previous spelling here and it was
   wrong in exactly that case: it called the inner run a delimiter, disagreeing
   with tools/validate.py's spec_lines(), which marks it as YAML. Caught by test
   17 in tools/run_tests.sh before it reached anyone. */
export function fenceMap(lines) {
  const inside = new Array(lines.length).fill(false);
  const delimiter = new Array(lines.length).fill(false);
  let open = null;
  const fences = [];
  lines.forEach((line, i) => {
    const m = line.match(FENCE);
    if (m) {
      if (open === null) { open = m[1].length; fences.push(i); delimiter[i] = true; }
      else if (m[1].length >= open) { open = null; fences.push(i); delimiter[i] = true; }
      inside[i] = true;
      return;
    }
    inside[i] = open !== null;
  });
  return { inside, delimiter, balanced: open === null, count: fences.length };
}

/* ── stages 2 and 3, collecting ─────────────────────────────
   Returns { errors, front, lines, inside }. */
/* Exported, and module scope rather than function scope, so that
   web/tools/parity.mjs can compare this table against the one in
   tools/preflight.py by IMPORTING it instead of reading it out of this
   file's source text.

   That reader was the previous design and it had a silent wrong-pass. A
   rule commented out, which is how anyone disables one, still matched the
   source and was still counted, so parity reported the tables in step
   while a real rule had stopped executing. Reproduced end to end on the
   Slack rule: validate() no longer caught the token, and parity exited 0
   saying "10 in the site".

   Exporting a const does not weaken the check that policies this file. It
   makes the contents authoritative instead of guessed, which is the whole
   point of comparing two implementations at all.

   Frozen because the hoist opened a surface that did not exist before. While
   this array was function-local it was unreachable; at module scope any importer
   can push to it or empty it and change live validation for every request in the
   process. Nothing does. One word closes it. */
/* Make both engines see the same characters before the secret scan. Must match
   normalise_for_scan in tools/preflight.py exactly.

   Enumerated over all 0x110000 code points: Python's \s covers U+001C-U+001F and
   U+0085 where V8's does not, and V8's covers U+FEFF where Python's does not.
   U+001C-U+001F are already refused as control characters above, leaving two.

   Both leaked in the dangerous direction: preflight REFUSED and this endpoint
   ACCEPTED, publishing a live credential. And they are exactly what survives a
   copy-paste out of a browser chat window, which is the path this rule set exists
   for and the one where this endpoint is the only mechanical gate. */
/* Invisible-character evasion, closed 2026-09-01, kept character for character in
   step with tools/preflight.py's INVISIBLE.

   The block above concerns two engines disagreeing about \s. This concerns one
   engine being walked past, and they are different problems sharing a function.

   Fourteen invisible characters placed between the query delimiter and the
   parameter name defeat the URL rule, which is anchored as [?&]name= and depends
   on adjacency. U+FEFF was the only one closed, incidentally, by the line above.
   For key, sig, signature and X-Amz-Signature this is the ONLY thing behind the
   URL rule: the other six names are also carried by CREDENTIAL_ASSIGN, and bare
   "key" cannot be added there without re-opening the word "monkey".

   An explicit class rather than \p{Cf}, because \p{...} needs the /u flag and
   adding /u to the RULE TABLE would change \b and \d semantics across it. This one regex carries /u because its class holds astral code points; the table does not and must not.

   ACCEPTED MISS: U+0085 is mapped to a space rather than removed, so
   ?<U+0085>key= still evades. U+0085 is a line separator; removing it would join
   two lines and could manufacture a match spanning a boundary that exists in
   neither. A URL split across a line break is already broken as a URL. */
const INVISIBLE = /[\u00ad\u034f\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u115f-\u1160\u17b4-\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{110bd}\u{110cd}\u{13430}-\u{1343f}\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0001}\u{e0020}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

export function normaliseForScan(text) {
  return text.replace(INVISIBLE, '').replace(/\u0085/g, ' ');
}

export const SECRETS = Object.freeze([
  ['an Anthropic key',        /\bsk-ant-[A-Za-z0-9\-]{10,}\b/],
  ['an OpenAI style key',     /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['an AWS access key id',    /\bAKIA[0-9A-Z]{16}\b/],
  ['a GitHub token',          /\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ['a Google API key',        /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Slack token',           /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/],
  ['a JWT',                   /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ['a private key block',     /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/],
  /* Anchored at the query delimiter, not at the scheme. The old form tied the
     parameter to https?:// with a scan run between them, and every version of
     that run was wrong: \S{0,512} inverted between engines because Python counts
     code points and V8 counts UTF-16 units, so an astral path put the two on
     opposite sides of the bound and the endpoint published what preflight
     refused; the same bound cut off any parameter past 512 characters, which is
     where a signed URL puts it; and removing the bound is the measured 3.63s
     quadratic at 256KB. Anchoring at [?&] removes the scan entirely, so there is
     no length axis and no backtracking site. Every match of the scheme-tied rule
     contained a [?&]name=\S+ match with a \S before the delimiter, so this form
     is strictly more sensitive: nothing the old rule caught is lost.

     (?<=\S) is what keeps "append ?key=value to the URL" documentation clean: a
     URL leaks its parameter mid-run, never after whitespace. The accepted miss
     is a bare ?token=<short> fragment at the start of a word, which the old rule
     also missed (no scheme), and which CREDENTIAL_ASSIGN catches at 20+ chars. */
  /* The signed-URL signature vocabulary, added 2026-09-01, kept character for
     character in step with tools/preflight.py. A presigned URL's whole security
     is its signature parameter and it is called none of the seven names this
     rule held; an AWS presign was refused only incidentally by its AKIA key id,
     and an ASIA temporary-credential presign was refused by nothing. The vendor
     prefix is a bounded ASCII class rather than a list of clouds, which is safe
     only because that class cannot match an astral character. Measured over
     119,708 third-party files: zero old-only, 23 new-only in three strings none
     of which is a live credential, zero cross-engine disagreements. */
  ['a URL carrying a credential', /(?<=\S)[?&](?:(?:token|key|secret|auth|apikey|api_key|access_token)=(?!(?:\$\{[A-Za-z_][A-Za-z_]{0,64}\}|\{\{[A-Za-z_][A-Za-z _.-]{0,64}\}\}|<[A-Za-z_][A-Za-z _.-]{0,64}>|\[[A-Za-z_][A-Za-z _.-]{0,64}\])(?=[\s&#]|$))\S+|(?:[Ss][Ii][Gg]|(?:[Xx]-[A-Za-z][A-Za-z0-9]{1,9}-)?[Ss][Ii][Gg][Nn][Aa][Tt][Uu][Rr][Ee])=(?!(?:\$\{[A-Za-z_][A-Za-z_]{0,64}\}|\{\{[A-Za-z_][A-Za-z _.-]{0,64}\}\}|<[A-Za-z_][A-Za-z _.-]{0,64}>|\[[A-Za-z_][A-Za-z _.-]{0,64}\])(?=[\s&#]|$))[^\s&#]{16,})/],
  /* A webhook URL whose path IS the credential. No parameter and no assignment,
     so nothing else in this table sees it, and possession of the URL is the
     whole authorisation. This rule is a list of vendors and there is no way
     around that: a webhook URL has no shape, only a host, so the list is the
     rule's ceiling and a vendor not on it is not caught. Measured at zero fires
     over 119,708 third-party files and over the 34 fixture documents; ten
     probes, five real and five near misses, identical in both engines. The
     accepted false positive is a vendor's own documentation placeholder, which
     nothing here can tell from a live URL. */
  ['a webhook URL carrying its own secret', /(?<![A-Za-z0-9_])[Hh][Tt][Tt][Pp][Ss]:\/\/(?:(?:[Hh][Oo][Oo][Kk][Ss]\.[Ss][Ll][Aa][Cc][Kk]\.[Cc][Oo][Mm]\/(?:services|triggers|workflows)|(?:[Cc][Aa][Nn][Aa][Rr][Yy]\.|[Pp][Tt][Bb]\.)?[Dd][Ii][Ss][Cc][Oo][Rr][Dd](?:[Aa][Pp][Pp])?\.[Cc][Oo][Mm]\/api\/(?:v[0-9]{1,2}\/)?webhooks|[A-Za-z0-9-]{1,63}\.[Ww][Ee][Bb][Hh][Oo][Oo][Kk]\.[Oo][Ff][Ff][Ii][Cc][Ee]\.[Cc][Oo][Mm]\/webhookb2|[Oo][Uu][Tt][Ll][Oo][Oo][Kk]\.[Oo][Ff][Ff][Ii][Cc][Ee]\.[Cc][Oo][Mm]\/webhook|[Hh][Oo][Oo][Kk][Ss]\.[Zz][Aa][Pp][Ii][Ee][Rr]\.[Cc][Oo][Mm]\/hooks\/(?:catch|standard))[\/A-Za-z0-9_+=-]{0,4}\/[A-Za-z0-9_\/+=@.-]{16,}|[Aa][Pp][Ii]\.[Tt][Ee][Ll][Ee][Gg][Rr][Aa][Mm]\.[Oo][Rr][Gg]\/bot[0-9]{6,}:[A-Za-z0-9_-]{20,})/],
  /* A password assignment. Rewritten 2026-09-01 and made a union 2026-09-03,
     ported from tools/preflight.py character for character; the full reasoning
     lives beside tools/scrub.py's PASSWORD_ASSIGN, which is the copy the other
     two follow.

     TWO ARMS. The first reads a prefixed NAME and then excludes on the VALUE.
     It exists because /\b(password|passwd|pwd)\s*[:=]\s*\S+/i cannot fire
     between two word characters, so DB_PASSWORD=hunter2, smtp_pass: hunter2 and
     export DB_PASSWORD=hunter2 were all published while `password: hunter2` was
     refused. That is the docker-compose, .env and launchd shape, which is most
     of the places a password is actually written down.

     The second arm is that old rule, kept rather than replaced, with its /i
     inlined as classes. Replacing it was measured and it leaks: an exclusion is
     tested against the value, and a random high-entropy value eventually looks
     like a leading bracket, a dotted chain, a function call or a version
     number. On generated passwords written to a bare `password:` line, 20,000
     samples per generator, the first arm alone releases 15.28% of
     1Password-style values with symbols. The union releases none of them, and
     costs 47 more files of 119,837 than the old rule alone.

     The /i flag is gone with it, and that closes a cross-engine divergence that
     ran the unsafe way: Python's re.I casefolds U+017F to s and V8's /i without
     /u does not, so preflight refused pa<U+017F>sword: and this file accepted
     it. Every letter is spelled as a class now, so the three copies mean one
     thing in both engines.

     Dropping /i alone would have closed that divergence the wrong way, by
     making both sides publish. The trigger classes spell the long s out as
     [Ss<U+017F>], so both sides refuse it. Measured over 119,837 third-party
     files, that widening cost +0 files and +0 occurrences: no ordinary text
     writes a long s.

     THE LOOKBEHIND AT THE FRONT IS THE ReDoS MITIGATION, AND IT IS NOT
     REDUNDANT WITH THE \b FURTHER IN. Nothing in this file said so until
     2026-09-03, and this is the copy that runs at the public door on
     attacker-controlled input, so it is the copy where the omission cost the
     most. (?<![A-Za-z0-9_.\-]) prunes candidate start positions inside an
     identifier run. Without it, [A-Za-z0-9_.\-]* followed by a literal restarts
     at every position of a long name and the rule is quadratic on input that
     carries no password at all.

     Measured in this engine, one occurrence removed and nothing else changed,
     body is the trigger word repeated with no delimiter so the rule never
     matches. Warm the JIT before timing: an earlier version of this table
     reported 0.98 ms at 2,000 bytes and 0.09 ms at 8,000, which is not
     physical, and a non-monotonic row invites the next reader to distrust the
     whole table. That was the first timed call paying for compilation.

         body bytes    with lookbehind    without
              2,000           0.02 ms        8.47 ms
              8,000           0.06 ms      158.47 ms
             32,000           0.27 ms    2,366.45 ms
             65,536                        10,000    ms
            131,072                        40,100    ms
            262,144           2.25 ms     161,900    ms  (MAX_BYTES, line 18)

     Flat on the left, x4 per doubling on the right, which is quadratic read off
     the numbers rather than off the pattern. The last figure is not an
     extrapolation: 262,144 bytes without the lookbehind takes about two and a
     half minutes, on a request this endpoint accepts by size.

     So: \b is a zero-width assertion about word boundaries and this is a
     performance guard on where matching may BEGIN. The two overlap on every
     input a person tries by hand, which is exactly why the next person to tidy
     this rule will find the lookbehind unnecessary by reasoning that is wrong.
     Do not remove it.

     parity.mjs compares this source string against preflight's; only the
     behaviour vectors in tools/fixtures/ can tell you the two still agree in
     fact.

     ROW-150/151/152 (2026-09-05), ported from tools/scrub.py's PASSWORD_ASSIGN,
     character for character. Three fixes in one commit, because parity compares
     source across engines and a rule change cannot be split by engine (see
     record/findings/row-149-a-rule-change-cannot-be-split-by-engine.md, the
     same lesson this rule's own prior widening ran into).

     ROW-150: pwd's optional prefix no longer needs to end in a separator, so
     `dbpwd`, `DBpwd` and their casings now match like `password`/`passwd`
     always did; pass's glued-prefix class is now `[A-Za-z0-9]` rather than
     lowercase-only, so `DBpass`/`DBPass`/`DBPASS` now match. The bare `pass`
     form (no prefix at all) is deliberately still unmatched: this file's own
     fixture note calls it "an ordinary English word and a test status", and
     ROW-150 asks for it to be measured against a corpus before it is added.

     ROW-151: password/passwd/pwd now match on ANY prefix (glued, separated, or
     none) with NO value-side exclusion, folding what used to be a separate
     bare-keyword-only arm into this one. Its operator keeps the shared
     operator's quote handling (`password": "value"` still works) but drops
     that operator's `(?![=>~:])` guard -- NOT the fully guarded operator the
     weak `pass` arm below uses. Giving the strong arm the FULL guarded
     operator was tried and reverted: it broke `PWD=~gy...` and every other
     value starting with `~`, `=`, `>` or `:`, which
     fixtures/password_rule_baseline.json exists to catch, because every
     value-side exclusion in this rule is safe only because the strong arm
     backstops it unconditionally. Closes a hole where a PREFIXED key
     (db_password, DB_PASSWORD) followed by a bracket-leading value released
     the whole rule set, because the bracket exclusion below only ever
     backstopped the bare keyword. Fifteen must_not_fire fixtures moved to
     known_false_positives as the accepted twin of an already-accepted bare
     false positive, including both `if (a.password === b.password) {` and its
     prefixed twin: main's old bare arm never guarded against `===` and this
     one does not either, so both still fire, unchanged from main. Eleven of
     the same shapes also came out of tools/fixtures/scrub_false_positives.md,
     which asserts a no-op and can no longer assert one on them.

     The strong arm's operator is `["'`]?\s*[:=]\s*["'`]?`, NOT
     `["'`]?[ \t]*(?:\r?\n[ \t]*)*[:=][ \t]*(?:\r?\n[ \t]*)*["'`]?` the way the
     weak arm below spells it, and that difference is load-bearing, not
     cosmetic. A critic caught an earlier version of this commit shipping the
     weak arm's explicit space/tab/CRLF-only spelling on the strong arm too,
     which silently dropped 25 codepoints the old bare-keyword arm's bare
     `\s*` always covered: NBSP, the other Unicode spaces, U+2028/U+2029, bare
     CR, VT, FF and U+001C-001F. `password:<NBSP>Tr0ub4dor&3` -- what pasting
     a config line out of Word, Notion, Confluence or a rendered web page
     produces -- shipped unredacted in all three engines for as long as that
     version stood, because parity compares regex SOURCE and all three copies
     had made the identical mistake. The 120,248-file corpus reported zero
     regressions the whole time: it is npm tarballs and node_modules, which
     cannot contain those characters next to this keyword. `\s*` restores
     exactly what the old bare-keyword arm had, on the arm that inherited its
     job.

     Reordered within this commit so the backstop (any-prefix
     password/passwd/pwd, no value exclusion) is the FINAL alternation branch,
     where tools/fixtures/password_rule_baseline.json's main_arm now freezes
     it: that is the arm this session accidentally over-guarded once already
     (the `PWD=~gy...` regression above), so it is the one worth a structural,
     corpus-independent tripwire against a future re-narrowing. Verified
     behaviourally identical to the unreordered form across the full fixture
     corpus, 8,000 generated combinations, and all 120,248 real corpus files:
     zero differing matches.

     ROW-152: value reads to the end of the physical line, `\S+(?:[ \t]+\S+)*`,
     not just the first word, so a space-separated passphrase
     (`password: correct horse battery staple`) is not redacted one word deep.
     Measured to cost nothing beyond ROW-151's cost: every corpus file the
     wider span touches was already going to fire on its first token.

     Same 120,248-file, four-cache corpus as scrub.py's copy of this rule: 477
     files fired before, 564 after, all explained by the ROW-151 twins
     reaching real files. Zero regressions ON THAT CORPUS (verified by full
     file-level diff, not by occurrence count alone) -- which is a narrower
     claim than it sounds, see the note on \s* two arms up: the corpus is
     npm/plugin text and cannot contain the codepoints that regression lived in.
     See record/findings/row-150-151-152-cross-product-gaps-and-the-backstop-arm.md. */
  ['a password assignment',   /(?:(?<![A-Za-z0-9_.\-])(?:(?:[A-Za-z0-9_.\-]*[_\-.][Pp][Aa][Ssſ][Ssſ]|[A-Za-z0-9_.\-]*[A-Za-z0-9][Pp][Aa][Ssſ][Ssſ])(?![A-Za-z])(?=[\"'`]?[ \t]*(?:\r?\n[ \t]*)*[:=](?![=>~:])[ \t]*(?:\r?\n[ \t]*)*[\"'`]?(?=[^\s\"']{8})(?=[^\s\"']{0,256}[0-9]))[\"'`]?[ \t]*(?:\r?\n[ \t]*)*[:=](?![=>~:])[ \t]*(?:\r?\n[ \t]*)*[\"'`]?(?![\"'`])(?=[^\s\"']{3})(?![\[{(<>\/\]])(?!(?:[Tt]rue|TRUE|[Ff]alse|FALSE|[Nn]ull|NULL|[Nn]il|None|undefined|void)(?![A-Za-z0-9_]))(?!(?:[A-Za-z_][A-Za-z0-9_]*\.)+[A-Za-z_][A-Za-z0-9_]*(?![A-Za-z0-9_.]))(?![A-Za-z_][A-Za-z0-9_]*[ \t]*\()(?!\$\{)(?!\$[A-Z_][A-Z0-9_]*(?![A-Za-z0-9_]))(?!(?:[Yy][Oo][Uu][Rr]|[Mm][Yy]|[Ii][Nn][Ss][Ee][Rr][Tt]|[Rr][Ee][Pp][Ll][Aa][Cc][Ee]|[Ee][Xx][Aa][Mm][Pp][Ll][Ee]|[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][Rr]|[Cc][Hh][Aa][Nn][Gg][Ee][Mm][Ee]|[Ss][Aa][Mm][Pp][Ll][Ee]|[Dd][Uu][Mm][Mm][Yy]|[Pp][Aa][Ss][Tt][Ee]|[Tt][Oo][Dd][Oo]|[Xx][Xx][Xx])[A-Za-z\-]*(?![A-Za-z0-9_\-+\/=~.]))(?![0-9]{1,7}(?![A-Za-z0-9_.\-]))(?![\^~>=<]*[0-9]+\.[0-9]+)\S+(?:[ \t]+\S+)*|[A-Za-z0-9_.\-]*(?:[Pp][Aa][Ssſ][Ssſ][Ww][Oo][Rr][Dd]|[Pp][Aa][Ssſ][Ssſ][Ww][Dd]|[Pp][Ww][Dd])s?(?![A-Za-z])[\"'`]?\s*[:=]\s*[\"'`]?\S+(?:[ \t]+\S+)*))/],
  /* Ported from tools/preflight.py on 2026-08-18, character for character. The
     pattern is deliberately case-explicit with no (?i) precisely so it means the
     same thing in Python re and V8; verified by extracting preflight's compiled
     source and compiling it here unchanged.

     Why this is at the public door at all, having been kept out of it twice:
     capture/path-w-prompt.md builds a passport in a browser with no filesystem,
     so it runs neither scrub.py nor preflight.py. Its own words are "there are
     no scripts on this path; you scrub yourself". For capture_path: browser this
     endpoint is not defence in depth, it is the ONLY mechanical secret gate.
     The earlier sizing treated the no-scrub population as a residue; on that
     path it is the whole population.

     ROW-100. The bare `[_\-.]key` branch matched ANY name ending in `_key`,
     `-key` or `.key`, with no shape check on the value beyond the generic
     20+-character run. `cache_key`, `sort_key`, `partition_key`,
     `idempotency_key` and `foreign-key` are ordinary database and caching
     vocabulary, and a passport describing an agent that reads a table or a
     cache is exactly the document that contains them. scrub.py turned lines
     of that vocabulary into [SCRUBBED:CREDENTIAL_ASSIGN], taking the field
     name with the value.

     NAME-EXCLUDED, NOT VALUE-EXCLUDED, and that distinction is the whole
     safety argument. The obvious fix is a value-shape heuristic — "lowercase
     words joined by separators" clears all these lines — and it was
     rejected. `DB_PASSPHRASE=correct-horse-battery-staple` is exactly that
     shape and is a real, strong credential: four dictionary words joined by
     hyphens is LOW per-character entropy, which is precisely the class this
     rule exists to catch because the entropy backstop rule cannot see it
     either (its own comment: "neither can see a 64-character lowercase hex
     token, because it looks exactly like a sha256"). A value-shape exclusion
     would have opened exactly the hole this rule exists to close.

     So the exclusion is on the NAME instead, for five exact, closed compound
     terms with no vendor and no product this fix could find naming a live
     credential after them. `primary` was in the first version of this list
     and is deliberately NOT here: `azurerm_cosmosdb_account.primary_key` and
     `azurerm_storage_account.primary_access_key` are Azure's own documented
     Terraform/SDK attribute names for a live Cosmos DB / Storage master key
     (confirmed against registry.terraform.io and learn.microsoft.com, not
     from memory), so `primary_key = <a real Azure key>` is exactly the
     credential this rule exists to catch, under exactly the name a name-list
     exclusion would have to whitelist. Caught by a critic building the
     counterexample, not by reasoning about the five that remain being safe
     — see record/findings/row-100-primary-key-is-a-real-azure-credential.md.
     Cache/sort/partition/idempotency/foreign have no equivalent found: no
     major vendor names a bearer credential after any of them (Stripe's
     `Idempotency-Key` is client-generated and grants nothing; a "cache key"
     with real auth power was not found under that literal name).

     WHOLE name, not just this word with nothing in front: `cache_key` is
     excluded, `redis_cache_key` and `my_cache_key` are not — the leading
     `(?<![A-Za-z0-9_.\-])` boundary blocks any prefix. The first version of
     this fix got the trailing boundary wrong: `(?![A-Za-z])` only blocks a
     following LETTER, so `cache_key.signing_key`, `partition_key_deploy_key`
     and similar were silently excluded too, because "key" followed by `_`,
     `-` or `.` still satisfied that lookahead. Fixed to
     `(?![A-Za-z0-9_.\-])`, which requires nothing else in the identifier at
     all, matching the comment's own original claim rather than the regex
     that shipped under it.

     This is conservative in the direction that matters: it under-excludes
     rather than over-excludes, so a compound name not on this list still
     gets refused, which costs a false positive rather than a missed
     credential.

     Measured against 6,702 third-party markdown files from this machine's own
     npm cache and installed Claude plugins, same source class as the
     2026-08-17 fix above: zero regressions from this fix (nothing that passed
     before now fails) and zero files freed by the name exclusion on THIS
     corpus — it under-represents the population ROW-100 is actually about
     (README and plugin-doc prose favours code blocks over the
     frontmatter-shaped `key: value` lines a captured passport actually
     contains), so the corpus is the right instrument for "did this change
     break anything" and the wrong one for "does this change help anything".
     The fixture lines constructed directly for the five remaining words are
     the real evidence the fix does what it claims; `SECRET_KEY`/`DEPLOY_KEY`
     -shaped names, the correct-horse-battery-staple boundary case, and a
     real-shaped `primary_key`/Azure-key line all still refused. See
     record/findings/row-100-key-suffix-false-positive-fix.md and
     record/findings/row-100-primary-key-is-a-real-azure-credential.md.

     ROW-149 (2026-09-05). This rule spelled neither U+017F LATIN SMALL LETTER
     LONG S nor U+212A KELVIN SIGN, while carrying s in `secret` and
     `passphrase` and k in `key` and `token`, so four keywords missed under a
     homoglyph, byte-identically in both engines: 'a password assignment'
     above had already closed the same hole for itself. The classes now read
     `[Ssſ]` and `[KkK]` everywhere those letters trigger the rule, the same
     spelling and for the same reason: no case flag, every letter a class, so
     Python re and V8 cannot disagree on it. Measured over 120,248 files from
     this machine's npm cache, Claude plugins and two node_modules trees: 652
     files fire before and after, 1,891 hits both, zero files differing. See
     record/findings/row-149-a-rule-change-cannot-be-split-by-engine.md. */
  ['a credential assignment', /(?<![A-Za-z0-9_.\-])(?:[A-Za-z0-9_.\-]*(?:[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Tt][Oo][KkK][Ee][Nn]|[Ssſ][Ee][Cc][Rr][Ee][Tt]|[Aa][Uu][Tt][Hh]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Pp][Aa][Ssſ][Ssſ][Pp][Hh][Rr][Aa][Ssſ][Ee])s?|[A-Za-z0-9_.\-]*[Aa][Pp][Ii][_\-]?[KkK][Ee][Yy]s?|[A-Za-z0-9_.\-]*[a-z0-9][KK]eys?|(?!(?:[Cc][Aa][Cc][Hh][Ee]|[Ss][Oo][Rr][Tt]|[Pp][Aa][Rr][Tt][Ii][Tt][Ii][Oo][Nn]|[Ii][Dd][Ee][Mm][Pp][Oo][Tt][Ee][Nn][Cc][Yy]|[Ff][Oo][Rr][Ee][Ii][Gg][Nn])[_\-.][KkK][Ee][Yy]s?(?![A-Za-z0-9_.\-]))[A-Za-z0-9_.\-]*[_\-.][KkK][Ee][Yy]s?)(?![A-Za-z])[\"']?\s*[:=]\s*(?:Bearer\s+)?[\"']?(?!(?:[A-Za-z_][A-Za-z0-9_]*\.)+[A-Za-z_][A-Za-z0-9_]*(?![A-Za-z0-9_\-+\/=~.]))(?!(?:[Yy][Oo][Uu][Rr]|[Mm][Yy]|[Ii][Nn][Ss][Ee][Rr][Tt]|[Rr][Ee][Pp][Ll][Aa][Cc][Ee]|[Ee][Xx][Aa][Mm][Pp][Ll][Ee]|[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][Rr]|[Cc][Hh][Aa][Nn][Gg][Ee][Mm][Ee]|[Ss][Aa][Mm][Pp][Ll][Ee]|[Dd][Uu][Mm][Mm][Yy]|[Pp][Aa][Ss][Tt][Ee]|[Tt][Oo][Dd][Oo]|[Xx][Xx][Xx])[A-Za-z0-9_\-]*(?![A-Za-z0-9_\-+\/=~.]))(?![A-Za-z0-9_\-+\/=~.]{0,128}[_\-]?[Hh][Ee][Rr][Ee](?![A-Za-z0-9_\-+\/=~.]))(?![A-Za-z0-9_\-+\/=~.]{0,128}\/[A-Za-z0-9_\-+\/=~.]{0,128}\.[A-Za-z]{2,5}(?![A-Za-z0-9_\-+\/=~.]))[A-Za-z0-9_\-+\/=~.]{20,}[\"']?/],
  /* Named because its value is three dot-separated segments, which is the exact
     shape the credential rule's dotted-chain exclusion refuses so it stops
     matching ordinary code. */
  ['a SendGrid key',          /\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}\b/],
  /* A database URL carrying a password. Until now this was caught by NOTHING:
     scrub's EMAIL rule hit it by accident, on the user:pass@host middle, and a
     form without an @-shaped middle was caught nowhere at all. Measured before
     adding: 5/5 real shapes, 0/6 near-misses (bare https, git@host, a URL with
     no password), 0.17% of 6055 stranger-written files. */
  ['a database URL carrying a password', /\b[a-z][a-z0-9+.\-]{0,31}:\/\/[^\s:\/@]+:(?!<(?:[Rr][Ee][Dd][Aa][Cc][Tt][Ee][Dd]|[Ss][Cc][Rr][Uu][Bb][Bb][Ee][Dd]|[Rr][Ee][Mm][Oo][Vv][Ee][Dd]|[Hh][Ii][Dd][Dd][Ee][Nn]|[Mm][Aa][Ss][Kk][Ee][Dd]|[Ee][Ll][Ii][Dd][Ee][Dd]|[Oo][Mm][Ii][Tt][Tt][Ee][Dd]|[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][Rr]|[Yy][Oo][Uu][Rr][-_]?[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Xx]+|\*+)(?:[:_ -][A-Za-z]+)*[-_0-9]*>@|\[(?:[Rr][Ee][Dd][Aa][Cc][Tt][Ee][Dd]|[Ss][Cc][Rr][Uu][Bb][Bb][Ee][Dd]|[Rr][Ee][Mm][Oo][Vv][Ee][Dd]|[Hh][Ii][Dd][Dd][Ee][Nn]|[Mm][Aa][Ss][Kk][Ee][Dd]|[Ee][Ll][Ii][Dd][Ee][Dd]|[Oo][Mm][Ii][Tt][Tt][Ee][Dd]|[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][Rr]|[Yy][Oo][Uu][Rr][-_]?[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Xx]+|\*+)(?:[:_ -][A-Za-z]+)*[-_0-9]*\]@|\*+@|\$\{[A-Za-z_][A-Za-z0-9_]*\}@|\$[A-Za-z_][A-Za-z0-9_]*@)[^\s:\/@]{3,}@[^\s\/]+/],
  /* ── Vendor prefixes, added 2026-08-31 for ROW-108 ─────────────────────────

     Eight credential shapes over the seven rules below, kept character for
     character in step with tools/preflight.py. Every one passed BOTH gates
     before this block existed, bare in prose. In KEY=value form the credential
     rule above already caught most of them; prose is the shape that leaked,
     because a passport's tacit_notes is prose.

     This endpoint is not defence in depth for these. capture/path-w-prompt.md
     builds a passport in a browser with no filesystem, so it runs neither
     scrub.py nor preflight.py, and a hand-written passport at /upload runs
     neither either. For those this block is the ONLY mechanical gate.

     WHY THE BOUNDS ARE LOWER BOUNDS AND NOT THE DOCUMENTED LENGTHS. The token
     this was written for is a Notion integration token with 47 alphanumerics
     after ntn_; Notion documents 46. ntn_[A-Za-z0-9]{46} with a trailing
     boundary does not match it, and the mechanism matters because it is easy to
     misfix: the rule consumes 46 characters and then needs a non-word
     character, and the 47th is alphanumeric, so the boundary fails. Changing 46
     to 47 fixes this token and breaks on the next one. An open lower bound is
     the only form that encodes no guess about the vendor. Measure the bound
     against a real token; never take it from vendor documentation. A rule with
     a wrong bound passes every false-positive test anybody would write and
     never fires on the thing it exists for.

     WHY (?<![A-Za-z0-9_]) AND NOT \b. Python's \b is Unicode-aware, V8's
     without /u is not, so \bntn_... matches "éntn_TOKEN" here and not in
     preflight. Measured, not assumed, and parity.mjs cannot see it: it compares
     regex SOURCE, and the two sources would be identical. See
     record/findings/parity-compares-regex-source-not-behaviour.md and ROW-109.
     An explicit ASCII class means the same thing in both engines and is
     strictly more sensitive than Python's \b, so this block adds nothing to
     that pile.

     The trailing (?![A-Za-z0-9_]) excludes the underscore deliberately: it is
     what stops an ordinary snake_case identifier such as hf_<32 chars>_cache
     matching, and on the legacy Notion rule it is load bearing. The underscore
     in the lookbehind is why client_secret_..., AWS_SECRET_ACCESS_KEY and
     my_secret_token_value cannot match at all rather than merely being
     unlikely to.

     MEASURED BEFORE ADDING. Zero false positives for all seven over 18,911
     third-party prose and configuration files, and zero on all 34 fixture
     passports, validator fixtures and golden examples, which is the
     disqualifier ROW-108 names. Over every git-tracked file in this project's
     repositories they fire six times, on four distinct literals, and every one
     is a planted test credential: the sk_live_ in
     tools/fixtures/credential_sets.json, whose own note says "Each is a live
     secret. A gate that misses one publishes it", three copies of it in probe
     scripts under record/findings/, a second synthetic sk_live_ in a proposal's
     prose table, and the ntn_ token in the finding that documents this leak.

     Verified behaviourally identical between Python re and V8: first over the
     30 vectors in tools/fixtures/vendor_probes.json, which both test suites
     read, then over 6,628 generated vectors carrying non-ASCII context, at zero
     divergences. Over those same vectors the lookaround form fires where
     Python's \b does not in 363 cases and \b fires where it does not in none,
     which is the "strictly more sensitive" claim measured rather than argued.

     PERMANENTLY EXCLUDED, so nobody re-proposes them: raw 40-character
     AWS-style secrets and generic 40-character lowercase hex, firing on 4.06%
     and 5.15% of that corpus, both hitting git SHAs in ordinary READMEs and
     both firing on tools/fixtures/scrub_input.md in this repo. Refusing about
     one honest document in twenty and telling its author to rotate a commit
     hash is not a trade this door can make.

     Corpus roots and per-repository counts are in the record finding for this
     change rather than here. Two earlier drafts of this comment carried numbers
     that could not be reproduced from their own description, and a critic
     re-derived both: "two hits" was six, and the third-party count named a
     prose-only filter while describing a prose-and-config one. Numbers in this
     repo's prose have been wrong before; these are the re-derived ones.

     THE ACCEPTED COST, named because a critic found it by attacking this block.
     A DOCUMENTATION PLACEHOLDER of the right shape is refused at this public
     door: "put ntn_xxxxxxxx... in your .env" and SK followed by 32 zeros are
     refused exactly as a live token would be. These rules carry none of the
     placeholder exclusions the credential rule above carries, and a passport
     whose job is to name credential TYPES is a document that invites shapes.

     Accepted rather than overlooked. It is not new behaviour: all seven
     pre-existing vendor rules already do this, verified rather than assumed, so
     sk-xxxxxxxx, AKIAXXXXXXXXXXXXXXXX, AIzaXXX..., xoxb-000..., ghp_xxx... and
     sk-ant-xxx... are refused today. Extending eight more vendors to the same
     behaviour is uniform where excluding only these eight would not be. And the
     class did not occur once in 18,911 third-party documentation files. If it
     ever bites a real uploader the fix is one placeholder exclusion applied to
     all twenty rules, not a special case on these seven.

     THIS DOES NOT CLOSE THE DEFECT IT CAME FROM. The path W run 4 model quoted
     the owner's instruction lines verbatim into tacit_notes having already
     listed that token as [SCRUBBED:KEY] on its own step 7 review, four runs out
     of four. Any credential shape would have travelled that path, including the
     six this block still cannot see. These are a backstop; the fix is a
     scrub-completeness check at step 9. */
  ['a Notion integration token',        /(?<![A-Za-z0-9_])ntn_[A-Za-z0-9]{40,}(?![A-Za-z0-9_])/],
  /* Notion's legacy format. The bound is a judgement, not a measurement: the
     canonical length is documented as 43 and nobody here has verified that
     against Notion. Written open and BELOW the documented length on purpose, so
     a real token shorter than the document claims still fires. Measured
     identical at zero false positives at every bound from {20,} to {43}, so
     unlike ntn_ there is no cliff here. */
  ['a legacy Notion integration token', /(?<![A-Za-z0-9_])secret_[A-Za-z0-9]{32,}(?![A-Za-z0-9_])/],
  /* Live and restricted only. sk_test_ and rk_test_ are deliberately absent:
     they are not secrets, and matching them would refuse ordinary Stripe
     documentation. NOT caught by the OpenAI-style rule above, which requires
     sk- with a hyphen. */
  ['a Stripe secret key',               /(?<![A-Za-z0-9_])(?:sk|rk)_live_[A-Za-z0-9]{20,}(?![A-Za-z0-9_])/],
  /* Anchored on the literal host, so it needs no boundary rule of its own.
     Every quantifier is followed by a character outside its own class, so there
     is no backtracking site. */
  ['a Slack webhook URL',               /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{20,}/],
  ['a Hugging Face token',              /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{32,}(?![A-Za-z0-9_])/],
  ['a Linear API key',                  /(?<![A-Za-z0-9_])lin_api_[A-Za-z0-9]{36,}(?![A-Za-z0-9_])/],
  /* TWILIO IS DELIBERATELY ABSENT, and this comment is here so the next person
     to notice the absence does not close it. SK + 32 hex was added on
     2026-08-31 and removed the same day: it is an API key SID, and a SID is an
     IDENTIFIER, the basic-auth username, visible in the console. The two Twilio
     values that are actually secret are the API key Secret, 32 mixed-case, and
     the Auth Token, 32 lowercase hex. Neither carries a prefix, both are
     shape-identical to the two generic classes excluded permanently above, and
     no rule here can catch them without paying that false-positive rate. A
     Twilio rule of this shape refuses the public half and misses both secret
     halves, which is the same reasoning that keeps the AC account SID out. */
  ['an Airtable personal access token', /(?<![A-Za-z0-9_])pat[A-Za-z0-9]{14}\.[0-9a-f]{64}(?![A-Za-z0-9_])/]
]);

export function validate(text) {
  const errors = [];
  const lines = text.split('\n');

  /* 4.1 frontmatter */
  let front = null;
  /* Hoisted out of the block below because 4.2 needs it: a section heading has
     to be in the BODY, and the body is what follows this line. See there. */
  let fmClose = -1;
  if (lines[0] !== '---') {
    errors.push(err('E_FRONTMATTER'));
  } else {
    for (let i = 1; i < Math.min(lines.length, 40); i++) {
      if (lines[i] === '---') { fmClose = i; break; }
    }
    if (fmClose < 0) errors.push(err('E_FRONTMATTER'));
    else {
      front = parseFrontmatter(lines.slice(1, fmClose));
      if (!front) errors.push(err('E_FRONTMATTER'));
    }
  }

  if (front) {
    const missing = FRONTMATTER_KEYS.filter(k => !(k in front) || front[k] === '');
    if (missing.length) errors.push(err('E_MISSING_KEY', { keys: missing.join(', ') }));

    if ('passport' in front && front.passport !== '0.1') {
      errors.push(err('E_UNKNOWN_VERSION', { version: front.passport }));
    }
    if ('envelope' in front && front.envelope !== 'read-notify') {
      errors.push(err('E_BAD_ENVELOPE', { envelope: front.envelope }));
    }
    if ('name' in front && !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(front.name)) {
      errors.push(err('E_BAD_VALUE', { field: 'name', expected: 'lowercase letters, digits, dots and hyphens, up to 64 characters' }));
    }
    if ('title' in front) {
      const t = structuralTrim(front.title);
      if ([...t].length < 1 || [...t].length > 200 || t.includes('\n')) {   /* code points, see _derive.mjs */
        errors.push(err('E_BAD_VALUE', { field: 'title', expected: 'one line of 1 to 200 characters' }));
      }
    }
    if ('created' in front) {
      const d = structuralTrim(front.created);
      /* Date.parse alone is not enough and this is not hypothetical: the
         parity corpus caught it. Date.parse('2026-02-31T00:00:00Z') does not
         fail, it rolls the date forward to 3 March, so a passport dated the
         thirty-first of February was accepted and then rendered with a day
         that does not exist. Parsing back and comparing the parts is the only
         way to tell a real date from one the parser silently repaired. */
      const shaped = /^\d{4}-\d{2}-\d{2}$/.test(d);
      const ms = shaped ? Date.parse(d + 'T00:00:00Z') : NaN;
      const real = shaped && !Number.isNaN(ms) &&
                   new Date(ms).toISOString().slice(0, 10) === d;
      const future = real && (ms - Date.now()) > 24 * 3600 * 1000;
      if (!real || future) {
        errors.push(err('E_BAD_VALUE', { field: 'created', expected: 'a real date as YYYY-MM-DD, not in the future' }));
      }
    }
    if ('capture_path' in front && front.capture_path !== 'file' && front.capture_path !== 'browser') {
      errors.push(err('E_BAD_VALUE', { field: 'capture_path', expected: 'file or browser' }));
    }
    if ('owner_confirmed' in front && !/^(true|false)$/i.test(front.owner_confirmed)) {
      errors.push(err('E_BAD_VALUE', { field: 'owner_confirmed', expected: 'true or false' }));
    }
    if ('scrub' in front && !structuralTrim(front.scrub)) {
      errors.push(err('E_BAD_VALUE', { field: 'scrub', expected: 'a non-empty description of how the file was scrubbed' }));
    }
  }

  const { inside, balanced } = fenceMap(lines);

  /* 4.2 body structure. SKIPS FENCED LINES (ROW-223).

     This counted every line that spelled a section heading, fenced or not. A
     passport whose whole body sits inside one ``` fence opened at line 13 and
     never closed therefore had all six headings counted, passed here, and was
     PUBLISHED: sectionLines() locates a heading with findIndex and no fence
     tracking, so _derive.mjs read a title, a summary and a consent row out of
     the inside of a code block, and a reader of the rendered page saw a
     consent table the Markdown never contained as a table.

     tools/validate.py's heading count skips fenced lines in the same commit,
     and its section readers already did, which is why Python refused this
     document while the site accepted it. Both refuse it now.

     Counting over `lines`, the whole file rather than the body, is unchanged
     and is deliberate: it is the reading tools/validate.py was moved TO in
     this same commit for ROW-221. */
  /* AND THE HEADING HAS TO BE IN THE BODY, not merely somewhere in the file.

     A heading line is a `#` line, and a `#` line is the one non-blank thing
     YAML frontmatter admits without a colon: parseFrontmatter above skips it
     as a comment before it ever tests for a pair. So the frontmatter block is
     a place a heading can sit and satisfy a whole-file count while being
     nowhere in the body. Move `## 1. What this agent is` out of the body and
     into the frontmatter and this accepted the document, then sectionLines()
     found the heading up there and derive() published `--- A minimal agent
     for testing.` as the summary: the closing delimiter, read as prose.

     Pre-existing on main and not a gate split at the time, because
     tools/validate.py refused such a document from the other side. It is the
     twin of the two-sided count that gate now carries, and both halves are
     needed: the file-wide half sees a heading duplicated into the
     frontmatter (ROW-221), the body half sees one MOVED there. */
  const seen = SECTIONS.map(h => {
    const at = [];
    lines.forEach((l, i) => { if (!inside[i] && i > fmClose && structuralTrim(l) === h) at.push(i); });
    return at;
  });
  const dupes = SECTIONS.map(h => {
    let n = 0;
    lines.forEach((l, i) => { if (!inside[i] && structuralTrim(l) === h) n++; });
    return n;
  });
  const bad = [];
  SECTIONS.forEach((h, i) => {
    if (seen[i].length !== 1 || dupes[i] !== 1) bad.push(h.replace(/^##\s*/, ''));
  });
  if (bad.length) errors.push(err('E_SECTIONS', { sections: bad.join(', ') }));
  else {
    const at = seen.map(a => a[0]);
    for (let i = 1; i < at.length; i++) {
      if (at[i] < at[i - 1]) { errors.push(err('E_SECTION_ORDER')); break; }
    }
  }

  /* QUOTES. `comparison_mode: structural` and `comparison_mode: "structural"`
     are the same YAML scalar. This file finds fields by regex rather than by
     parsing YAML, so it saw two different strings and refused the quoted one
     with E_COMPARISON_MODE: legal YAML, correct value, rejected at the public
     door. tools/validate.py had the identical defect in its check 5 and both
     were fixed together on 2026-09-03. Strip before comparing, always. */
  const cmp = [];
  lines.forEach((l, i) => {
    const m = l.match(COMPARISON_MODE);
    if (m) cmp.push({ line: i + 1, value: scalar(m[1]) });
  });
  if (cmp.length !== 1 || !['structural', 'exact', 'input_relative'].includes(cmp[0].value)) {
    errors.push(err('E_COMPARISON_MODE'));
  }

  /* THE QUOTES HAD TO GO IN THE PATTERN, NOT AFTER IT, and the line that used
     to strip them here is why this was worth a comment rather than a one-word
     fix. The class [A-Za-z0-9_.*-]+ excludes " and ', so on

         capability_ref: "web.fetch"

     the regex did not match AT ALL and `if (!m) return` skipped the line. The
     next line then stripped quotes off a value that could never have carried
     any. Somebody intended to handle quoting, wrote the strip, and the
     character class above silently defeated it, so a quoted capability_ref was
     never checked against the vocabulary at the public upload endpoint: any
     id at all, including a write-class one, passed by being quoted.

     A dead repair reads as a live one. The strip is gone rather than kept as
     belt and braces, because the next reader would take its presence as
     evidence the case is handled, which is exactly what happened here.

     THE FIRST REPAIR WAS ALSO WRONG, and it is worth saying how. It kept the
     narrow class and added ["']? on each side. Those two are UNPAIRED and see
     past exactly one quote, so a critic walked through with two of them:

         capability_ref: "'files.write'"     legal YAML, means 'files.write'
         capability_ref: !!str files.write   legal YAML, means files.write

     Both produced no match, both were skipped, and the endpoint returned
     errors: [] on a WRITE-CLASS capability while validate.py refused them.
     Widening a character class to admit the shape you happened to think of is
     the same mistake as the class that excluded quotes in the first place.

     So: capture (\S+) and run it through scalar(), which is character for
     character what tools/validate.py check 6 does. The two doors now execute
     the same two lines, which is the only version of this that stays true. */
  const badRefs = new Set();
  lines.forEach(l => {
    const m = l.match(CAPABILITY_REF);
    if (!m) return;
    const ref = scalar(m[1]);
    if (!VOCAB.has(ref) && !ref.startsWith('money.')) badRefs.add(ref);
  });
  if (badRefs.size) errors.push(err('E_CAPABILITY', { refs: [...badRefs].join(', ') }));

  /* The envelope floor, part 1 of 3: `status: used` on a capability that writes
     to the world. spec section 7 carries the whole rule and tools/validate.py
     check 16 is the other implementation; the two must agree on the verdict or
     web/tools/parity.mjs fails.

     Parts 2 and 3 read the consent table, which this file never parses, so they
     live in _derive.mjs. That split follows the pipeline rather than the rule:
     stages 1 to 3 are here, the consent table is stage 4. Derivation counts as
     a refusal, so the combined verdict still matches validate.py, which does
     all three in one pass.

     capabilityBlockEntries() is entry-scoped, not line-scoped, and its own
     comment carries the reason. ROW-228's write-consent gate reuses the same
     walk for its own, separate purpose: handing an owner literal line text to
     delete, not deciding a refusal. */
  const floorRefs = new Set();
  for (const e of capabilityBlockEntries(lines)) {
    /* A MISSING status counts, not just a wrong one. Reading it the other way
       made this opt-out by omission: `- capability_ref: email.send` with no
       status line fired nothing, and one unrelated declared-only row elsewhere
       satisfied part 3 as well, so the floor was cleared by deleting a line.
       spec section 4 gives the entry as {capability_ref, status}, so the field
       is mandatory by the schema and was optional here. */
    if (e.ref && isDeclaredOnly(e.ref) && e.status !== 'declared_only') {
      floorRefs.add(safeRefLabel(e.ref));
    }
  }
  if (floorRefs.size) {
    errors.push(err('E_ENVELOPE_FLOOR', { refs: [...floorRefs].sort().join(', ') }));
  }

  /* Twin of check 8a in tools/validate.py: a line that opens a fence to a wider
     reader and not to this one. Reported before anything is counted, because
     once a fence fails to open every count downstream describes a different
     document than the author wrote. */
  if (lines.some(l => FENCE_LOOSE.test(l) && !FENCE.test(l))) {
    errors.push(err('E_FENCE_INVISIBLE'));
  }

  if (!balanced) {
    errors.push(err('E_GOLDEN_COUNT', { count: 'an unreadable number, because a code fence is left open' }));
  } else if (seen[3].length === 1 && seen[4].length === 1) {
    /* Section 4 ends at the next level-1 or level-2 heading outside a fence,
       not at the index of `## 5. Installer`. Ending at section 5 put any
       unnumbered heading between the two inside section 4 for this counter and
       outside it for sectionLines(), and both directions were reachable: a
       stray `## Appendix A, outputs` holding the only fenced block was stored
       and then rendered "0 golden examples", while a stray `## Notes` holding
       one was refused here and accepted by the generator. */
    const from = seen[3][0];
    let to = seen[4][0], boundaryFence = null;
    for (let i = from + 1; i < seen[4][0]; i++) {
      const f = lines[i].match(FENCE);
      if (f) {
        if (boundaryFence === null) boundaryFence = f[1].length;
        else if (f[1].length >= boundaryFence) boundaryFence = null;
      } else if (boundaryFence === null && SECTION_BOUNDARY.test(lines[i])) {
        to = i;
        break;
      }
    }
    let opens = 0, open = null;
    for (let i = from; i < to; i++) {
      const m = lines[i].match(FENCE);
      if (!m) continue;
      if (open === null) { open = m[1].length; opens++; }
      else if (m[1].length >= open) open = null;
    }
    if (opens < 1 || opens > 3) errors.push(err('E_GOLDEN_COUNT', { count: opens }));
  }

  /* 4.3 the scrub gate */
  if (text.includes('[SCRUBBED:') && !(front && String(front.scrub || '').includes('owner-reviewed'))) {
    errors.push(err('E_SCRUB_GATE'));
  }
  /* An entry starting with punctuation is anchored to a preceding word
     character. NFKC folds U+2026 to three ASCII dots, so "the run is done…
     Pemberton wrote it" matched `.pem`. `.pem` is the only such entry.
     Mirrors tools/validate.py check 9; the two must reach the same verdict. */
  const normText = normalizeDenied(text);
  const denied = DENIED_PATHS.filter(w => {
    const needle = normalizeDenied(w);
    const anchored = /[a-z0-9]/.test(needle[0]) ? '' : '(?<=[a-z0-9])';
    return new RegExp(anchored + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(normText);
  });
  if (denied.length) errors.push(err('E_DENIED_PATH', { names: denied.join(', ') }));

  /* ── stage 3, untrusted content ───────────────────────── */

  /* Both of the next two refuse the upload. The split is the diagnosis, not
     the verdict, and it exists because the wrong diagnosis cost a real user a
     dead end: the capture template shipped section 6 as
     "| <capability or input> | <delivered / substituted / lost> | ... |",
     every passport a real capture produced carried it, and the site said
     "contains HTML: <capability or input> ... remove it". That is accurate and
     unusable. It is not HTML, and removing it is the wrong remedy: the losses
     table stays and is left empty.

     A placeholder is angle-bracketed prose whose first word is not an HTML
     element name. Unknown element names count as placeholders, which is safe
     because the refusal is identical either way; only the sentence changes. */
  const tags = [];
  const holes = [];
  const TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(\s[^>]*)?>/g;
  lines.forEach((line, i) => {
    if (inside[i]) return;                       // fenced content is text, and is escaped on render
    if (line.includes(INSTALLER_PLACEHOLDER)) return;
    let m;
    TAG.lastIndex = 0;
    while ((m = TAG.exec(line)) !== null) {
      (isPlaceholder(m[0]) ? holes : tags).push('line ' + (i + 1) + ': ' + m[0]);
    }
  });
  const uniq = list => [...new Set(list.map(t => t.split(': ').slice(1).join(': ')))];
  if (tags.length) {
    errors.push(err('E_HTML', { tags: uniq(tags).slice(0, 6).join(', ') }, tags.slice(0, 20)));
  }
  if (holes.length) {
    errors.push(err('E_UNFILLED', { tags: uniq(holes).slice(0, 6).join(', ') }, holes.slice(0, 20)));
  }

  const comments = [];
  lines.forEach((line, i) => {
    if (line.includes(INSTALLER_PLACEHOLDER)) return;
    if (line.includes('<!--')) comments.push('line ' + (i + 1) + ': HTML comment');
  });
  if (comments.length) {
    errors.push(err('E_HTML', { tags: 'an HTML comment' }, comments.slice(0, 20)));
  }

  const active = [];
  if (/javascript:/i.test(text)) active.push('javascript: URI');
  if (/vbscript:/i.test(text)) active.push('vbscript: URI');
  if (/data:text\/html/i.test(text)) active.push('data:text/html URI');
  /* THE LINK TEXT IS BOUNDED, AND THAT BOUND IS LOAD-BEARING RATHER THAN TIDY.
     Unbounded, `[^\]]*` is quadratic on any body with unmatched "[": at every
     one of n start positions it runs to the end of the input looking for a "]"
     that is never there, then gives back one character at a time. Measured end
     to end through transport() then validate() at the 262,144-byte cap, on a
     body of "[" repeated, which contains no link and no credential:

         unbounded   27,803 ms
         bounded        107 ms

     That is one unauthenticated request past a synchronous function's timeout,
     and it was the largest ReDoS at this endpoint by two orders of magnitude
     while every rule in SECRETS was being measured and tightened. The secret
     rules cost 25 ms on that same body; this one cost the other 27.8 seconds.

     THE TRADE, STATED. A markdown link whose TEXT is longer than 256 characters
     is no longer seen as active content. Link text is a label a human reads;
     the 256 is the same bound the credential rules use, and a 257-character
     label is not a thing a passport carries. Everything else is unchanged:
     verified over nine shapes including images, an empty label, a javascript:
     target, two links on one line, and labels of 250, 256, 257 and 600
     characters, where only the last two differ, in the direction stated. */
  const LINK = /!?\[[^\]]{0,256}\]\(\s*([^)\s]+)/g;
  let lm;
  while ((lm = LINK.exec(text)) !== null) {
    const target = lm[1];
    const scheme = target.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
    if (scheme && !['https', 'http', 'mailto'].includes(scheme[1].toLowerCase())) {
      active.push(scheme[1] + ': link target');
    }
  }
  if (active.length) errors.push(err('E_ACTIVE_CONTENT', null, [...new Set(active)].slice(0, 10)));

  // SECRETS is module scope; see its definition above.
  /* Per line, so the error can say WHERE. It used to run once over the whole
     body and report only what kind of thing it found, which made this the one
     content error that named no line: E_HTML and E_UNFILLED both fill `details`.

     That mattered more here than anywhere else in this file. This runs at a
     public front door, on content from somebody who cannot see these rules. They
     were told a credential was exposed, told to rotate it, and not told which
     line. If the finding was right they could not find the secret to remove it;
     if it was wrong they could not find the string to understand why. Either way
     a dead end rather than an edit and a retry, which is the difference that
     decides whether a rule like this belongs at this door at all. ROW-79.

     The detail names the KIND and the LINE and never the matched text, which is
     the one way this differs from E_HTML above. Echoing the value back would put
     the credential into an error response, and from there into whatever logs or
     screenshots that response reaches. A passport is refused precisely so the
     secret does not travel; the refusal must not carry it either.

     Fenced lines are NOT skipped, unlike the tag scan above. A tag inside a fence
     is text because it renders escaped. A credential inside a fence is still a
     credential. */
  const kinds = [];
  const where = [];
  /* Matched against the WHOLE body, with the offset mapped back to a line.

     The first version of this ran the rules per line, which is the obvious way
     to get a line number and is wrong. `a password assignment` is
     /\b(password|passwd|pwd)\s*[:=]\s*\S+/i, and `\s` matches a NEWLINE, so

         password:
           hunter2supersecret

     is one match over the body and no match on either line by itself. Per-line
     evaluation silently stopped catching it. That is a credential the endpoint
     used to refuse and would have published, which is the wrong direction to
     trade anything in, least of all legibility.

     A critic found it while this was already committed. Detection must never be
     the thing that pays for a better error message: match exactly what the
     whole-body scan matched, then say where it started. */
  const scanText = normaliseForScan(text);
  const legacyText = text.replace(/\uFEFF/g, '').replace(/\u0085/g, ' ');
  /* Offsets must be computed over the text the rules actually scan. Stripping
     U+FEFF shortens the document, so a BOM anywhere before a finding shifted every
     match index and the reported line was wrong: a key on line 47 was reported as
     line 45. Introduced by the normalisation that closed the cross-engine leak,
     which is the fix for one defect quietly breaking the fix for another. */
  const scanLines = scanText.split('\n');
  const lineStart = [];
  for (let i = 0, off = 0; i < scanLines.length; i++) { lineStart.push(off); off += scanLines[i].length + 1; }
  const lineOf = idx => {
    let lo = 0, hi = lineStart.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStart[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  for (const [kind, re] of SECRETS) {
    /* A fresh global clone per rule. The stored regexes carry no /g and are
       shared at module scope, so exec()ing them directly would both fail to
       enumerate and leave lastIndex behind on an object every request uses. */
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(scanText)) !== null) {
      if (!kinds.includes(kind)) kinds.push(kind);
      if (where.length < 40) where.push('line ' + lineOf(m.index) + ': ' + kind);
      if (m[0].length === 0) g.lastIndex++;   // a zero-length match would not advance
      if (where.length >= 40) break;
    }
    /* The text AS WRITTEN as well, unioned with the normalised pass above.
       Normalising is not free in one direction: this rule set is anchored
       (?<=\S)[?&], and an invisible character sitting BEFORE the ? satisfies
       that lookbehind because it is not whitespace. Stripping it puts the
       preceding space back against the ?, the rule stops matching, and a
       credential that WAS refused publishes. Removal is still required for an
       invisible between the delimiter and the name, which breaks the adjacency
       the rule needs, so the two positions want opposite things from the same
       character and no single substitution serves both.

       Scanning both and refusing on either is strictly a superset of the
       behaviour before normalisation existed, so it cannot lose a credential
       that used to be caught. Line numbers still come from the normalised pass,
       which is the one whose offsets match the reported document. */
    if (!kinds.includes(kind) && re.test(text)) kinds.push(kind);
    /* And the normalisation this gate used before 2026-09-01, which stripped
       U+FEFF alone. That is a THIRD normalisation, not a subset of the two above:
       it wins on a document needing U+FEFF removed and another invisible kept,
       because the other one is \S and satisfies the rule's lookbehind. Running it
       as its own pass makes this gate a strict superset of what it refused before,
       by construction rather than by measurement. */
    if (!kinds.includes(kind) && re.test(legacyText)) kinds.push(kind);
  }
  if (kinds.length) {
    /* Ordered by line, not by rule. Collection walks rule-by-rule, so a
       two-secret passport otherwise reports line 48 before line 46, and a reader
       scanning line numbers expects them ascending. */
    const byLine = where.slice().sort((a, b) =>
      parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10));
    errors.push(err('E_SECRET_FOUND', { kinds: kinds.join(', ') }, byLine.slice(0, 20)));
  }

  return { errors, front, lines, inside };
}
