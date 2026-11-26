/* One reading of a passport's Markdown, shared by derivation and rendering.

   This file exists because those two had drifted apart inside one page.
   _derive.mjs ended a section at any `#{1,6}` heading and tracked no fences,
   while _render.mjs ended it at `#{1,2}` and did track them. A section 2 with a
   `### More detail` sub-heading was therefore read twice, differently, and the
   single page built from both showed a permit list and a capability count taken
   from the truncated view beside prose taken from the full one. There is one
   boundary rule now and both import it.

   THIS FILE AND section_parts() IN scripts/passport-to-page.py ARE ONE
   ALGORITHM WRITTEN TWICE, and they are required to produce the same part
   count, the same kinds, the same block text and the same paragraphs for any
   input. Change one and change the other. web/tools/parity.mjs runs both over
   every fixture and diffs the result, so this is checked rather than asserted:
   the Python side grows a --dump-parts mode for exactly that. */

/* ── THE WHITESPACE CLASSES, WRITTEN OUT INSTEAD OF `\s` ────────────────────
   Twin of the block in tools/validate.py; read that one for the reasoning. In
   one sentence: `\s` is not one class, this engine also calls \ufeff whitespace
   and Python also calls \x1c \x1d \x1e \x1f and \x85 whitespace, and a critic
   turned each of those six characters into a declaration one gate reads and the
   other does not (ROW-211).

   WS_ANY is the UNION, used wherever whitespace is SKIPPED, so an invisible
   character cannot hide a declaration from either gate. WS_BOTH is the
   INTERSECTION, used NEGATED as the class of a value, so an id carrying an
   invisible character keeps it and is refused as unknown rather than read as
   the clean id it resembles. Opposite widths, one rule: where the two engines
   disagree, take the reading that refuses.

   Test 18 in tools/run_tests.sh compares both classes against both live engines
   character by character, so neither this comment nor its twin can go stale
   quietly. */
export const WS_ANY = '\\t\\n\\v\\f\\r \\u001c-\\u001f\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
export const WS_BOTH = '\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';

/* The same set as characters, for a structural trim, DERIVED rather than
   written out a second time. */
const WS_BOTH_RE = new RegExp(`^[${WS_BOTH}]+|[${WS_BOTH}]+$`, 'g');

/* Trim a line for a STRUCTURAL comparison. Twin of structural_trim() in
   tools/validate.py; read that one. .trim() and str.strip() are different sets,
   so a heading with a trailing \x85 is the heading to one gate and not to the
   other (ROW-211). */
/* Trim a line for a YAML CONTINUATION test, with WS_ANY: the opposite width
   from structuralTrim(), under the same rule. A line NOT read as a continuation
   ENDS the open block, and everything after it stops being checked, so this one
   wants the wide class. Twin of yaml_trim() in tools/validate.py, where a
   critic used U+FEFF to make the normative gate PASS a write capability at
   status: used (ROW-211). */
const WS_ANY_TRIM_RE = new RegExp(`^[${WS_ANY}]+|[${WS_ANY}]+$`, 'g');
export const WS_ANY_RE = new RegExp(`^[${WS_ANY}]`);

export function yamlTrim(s) {
  return String(s).replace(WS_ANY_TRIM_RE, '');
}

/* WS_MD, the Markdown-structure class: ASCII space and tab and nothing else.
   Used for a table row and its cells, where a wider class silently SHORTENS
   the table instead of refusing it (ROW-211). */
export const WS_MD_TRIM_RE = /^[ \t]+|[ \t]+$/g;
export const TABLE_ROW_MD = /^[ \t]*\|/;

export function mdTrim(s) {
  return String(s).replace(WS_MD_TRIM_RE, '');
}

/* The frontmatter parser's two WS_BOTH tests, exported so its twin in
   tools/validate.py and this one trim the same set. A value with a trailing
   \x85 was one value there and a different one here (ROW-211). */
export const WS_BOTH_END_RE = new RegExp(`[${WS_BOTH}]+$`);
export const WS_BOTH_START_RE = new RegExp(`^[${WS_BOTH}]`);

const WS_ANY_RUN_RE = new RegExp(`[${WS_ANY}]+`, 'g');
/* Trim, then squeeze every run of whitespace to one space, WS_ANY-wide.
   The twin of collapse_ws() in scripts/passport-to-page.py, and the reason
   both exist: `.trim().replace(/\s+/g, ' ')` here and `" ".join(s.split())`
   there are different functions over six characters, so the two renderers
   produced different titles for the same passport and neither refused it.
   Widest class on purpose: a renderer wants one output, not a refusal. */
export function collapseWs(s) {
  return yamlTrim(String(s)).replace(WS_ANY_RUN_RE, ' ');
}

export function structuralTrim(s) {
  return String(s).replace(WS_BOTH_RE, '');
}

/* A `key: value` reader built from the classes above. `anchored` adds the line
   start and an optional list dash, which is what the section-wide
   capability_ref scan needs and the block-scoped reads do not. */
export function yamlScalarRe(key, anchored = false) {
  const head = anchored ? `^[${WS_ANY}]*(?:-[${WS_ANY}]*)?` : '';
  return new RegExp(`${head}${key}:[${WS_ANY}]*([^${WS_BOTH}]+)`);
}

/* One regex for both ends of a fence, and a tracked length. A fence closes on
   a run at least as long as the one that opened it; a shorter run inside a
   longer fence is content, so a four-backtick example that quotes a
   three-backtick block stays one block and keeps the quoted line. This is
   deliberately the same rule as fenceMap() in _validate.mjs, which decides
   what gets stored and which lines the HTML gate skips: a renderer that
   disagreed with the gate about where a fence ends would render as prose
   something that was accepted as code. */
/* THE ALPHABET IS NARROW ON PURPOSE, and it is the opposite width from WS_ANY
   in _validate.mjs. A wider whitespace class matches MORE lines as fences,
   which means more lines are treated as prose and FEWER declarations are seen,
   which is fail-open. `[ \t]` is also what a Markdown renderer means: neither
   \ufeff``` nor \x1c``` opens a code block in CommonMark. `\s` here and in
   tools/validate.py are not the same set, and a critic turned that into two
   documents on which the two gates returned opposite verdicts (ROW-211). */
export const FENCE = /^[ \t]*(`{3,})/;

/* Two heading rules, not one, and the difference is the whole point.

   SECTION_BOUNDARY is what ends a section: `## 5. Installer` does, a
   `### sub-heading` does not, because a sub-heading is still that section's
   own content. Consulted outside fences only, so a golden example containing
   "# comment" no longer truncates the section at that line.

   ANY_HEADING is what a heading LOOKS like to the paragraph splitter.
   Narrowing the single old constant to `#{1,2}` fixed the boundary and broke
   the splitter in the same move: a `### ` line stopped being recognised as a
   heading anywhere, and since it is not a fence, a table row, a blank or a
   list item, it fell through into a paragraph and printed as the literal text
   "### Example 1, the morning run" on both pages. */
/* MARKDOWN STRUCTURE IS `[ \t]`, a third alphabet beside WS_ANY and WS_BOTH,
   and narrow for the same reason the fence is: recognising MORE lines as
   structure ends a section EARLIER, so FEWER declarations are seen, which is
   fail-open. `##\ufeffExtra` is a heading to this engine and not to Python, and
   a critic used exactly that to make the site accept a write declaration the
   normative gate refuses (ROW-211). `[ \t]` is also what CommonMark says an ATX
   heading takes after its hashes. */
/* The loose fence reader, used ONLY as a tripwire: a line matching this and
   not FENCE carries an invisible character before its backticks, opens no
   code block in any renderer, and is refused rather than quietly read as
   prose. Twin of FENCE_LOOSE in tools/validate.py. */
export const FENCE_LOOSE = new RegExp(`^[${WS_ANY}]*(\`{3,})`);

export const SECTION_BOUNDARY = /^#{1,2}[ \t]/;
export const ANY_HEADING = /^#{1,6}[ \t]/;

const TABLE_ROW = /^[ \t]*\|/;
/* A list item starts a paragraph of its own. Joining them turned two lines of
   elision rules into "- items 4-11 removed - names replaced", and a numbered
   list into "1. items 4-11 removed 2. shape preserved", which reads as though
   the 2 belonged to the removal. */
const LIST_ITEM = /^[ \t]*(?:[-*+][ \t]|\d+[.)][ \t])/;
/* A paragraph that is one angle-bracketed instruction is an unfilled capture
   template. Upload refuses such a body outright (5.1 check 21 reads it as an
   HTML tag), so this only matters to the offline generator that shares this
   algorithm. The inner space keeps a bare autolink, <https://x>, out of it. */
const PLACEHOLDER = /^<[^<>]*[ \t][^<>]*>$/;   // WS_MD, twin of passport-to-page.py

/* A section body: from its heading to the next section boundary that is not
   inside a fenced block. Takes the whole file as lines, returns that
   section's lines, or [] when the heading is absent. */
export function sectionLines(lines, heading) {
  /* THE HEADING IS LOCATED WITH FENCE TRACKING FROM THE TOP OF THE INPUT,
     not from wherever the heading happens to be (ROW-223).

     This was findIndex with no fence tracking, and the walk below then
     started at the heading it found. So a passport whose whole body sits
     inside one ``` fence opened above section 1 and never closed had its
     headings found INSIDE the code block, and _derive.mjs read a title, a
     summary and a consent row out of the inside of it and PUBLISHED them:
     a reader of the rendered page saw a consent table the Markdown never
     contained as a table. Both gates accepted that document on main.

     scripts/passport-to-page.py section_lines() is the same algorithm and
     changes in the same commit; web/tools/parity.mjs holds the two equal
     part for part over every fixture, so they cannot drift apart quietly. */
  let fence = 0;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FENCE);
    if (m) {
      if (!fence) fence = m[1].length;
      else if (m[1].length >= fence) fence = 0;
      continue;
    }
    if (!fence && structuralTrim(lines[i]) === heading) { start = i; break; }
  }
  if (start < 0) return [];
  const out = [];
  /* Zero by construction: the heading was required to be outside a fence. */
  fence = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(FENCE);
    if (m) {
      if (!fence) fence = m[1].length;
      else if (m[1].length >= fence) fence = 0;
    } else if (!fence && SECTION_BOUNDARY.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

/* Split a section body into fenced blocks and prose paragraphs, IN ORDER.
   Returns { parts, open }, where each part is { kind: 'block'|'prose', text }
   and open is the 1-based line number of a fence left unclosed, or 0.

   In order is the contract, not a detail. The runtime page used to collect
   every prose paragraph, print them all above every block, and call the
   result the section: a caveat written between example one and example two
   then appeared above example one, attached to the wrong output. The two
   renderers now walk this list and place each part where the passport put it.

   The prose half exists because of a real failure. The repository's own example
   passport says, in section 4, that its golden example is synthetic rather than
   captured from a real run. That sentence sits outside the fence, so a renderer
   that showed only the fenced blocks dropped the disclaimer and the page then
   called it "one real run from the original". On a product whose brand is an
   honest account of what did not survive, that is the product's own failure
   mode on its own marketing.

   A sub-heading is prose with its marker removed rather than a dropped line.
   Dropping it is the same failure one size down: the owner wrote
   "### Example 1, the morning run" to label an output, and a renderer that
   silently deletes the owner's label is the behaviour the paragraph above
   exists to prevent. Neither page has anywhere to put a nested heading level,
   so it renders as the sentence it is. */
export function sectionParts(lines) {
  const parts = [];
  let para = [], block = [], fence = 0, fenceAt = 0;

  const flush = () => {
    if (!para.length) return;
    const text = para.join(' ');
    para = [];
    if (!PLACEHOLDER.test(text)) parts.push({ kind: 'prose', text });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!fence) {
      const opening = line.match(FENCE);
      if (opening) { flush(); fence = opening[1].length; fenceAt = i + 1; block = []; continue; }
      if (ANY_HEADING.test(line)) {
        if (SECTION_BOUNDARY.test(line)) break;
        flush();
        parts.push({ kind: 'prose', text: mdTrim(line.replace(/^#{1,6}[ \t]+/, '')) });
        continue;
      }
      if (TABLE_ROW.test(line)) { flush(); continue; }
      if (mdTrim(line) === '') { flush(); continue; }   // WS_MD, twin of passport-to-page.py
      if (LIST_ITEM.test(line)) flush();
      para.push(mdTrim(line));
    } else {
      const closing = line.match(FENCE);
      if (closing && closing[1].length >= fence) {
        parts.push({ kind: 'block', text: block.join('\n') });
        fence = 0; fenceAt = 0;
        continue;
      }
      block.push(line);
    }
  }
  flush();
  return { parts, open: fenceAt };
}
