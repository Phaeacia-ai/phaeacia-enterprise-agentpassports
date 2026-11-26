/* Stage 4 of site/spec/upload-validation.md.
   Derivation is part of validation: if any field cannot be derived, the upload
   fails and nothing is stored. A half-parsed passport is worse than no passport,
   because it renders as if it were complete. Fails fast, one error. */

import { err, RULES_VERSION, foldAscii, stripBlanks, stripBlockScalarContent, fenceMap, CAPABILITY_REF_LINE, structuralTrim, mdTrim, yamlTrim, TABLE_ROW_MD, isDeclaredOnly, isFilenameToken, consentCellSegments, consentCellOpaqueWord, consentCellWriteId, consentTokenIsOpaque, consentTokenIsWriteId, safeRefLabel, safeCellEcho, scalar, CONSENT_COLUMNS, PROSE_FIX, capabilityBlockEntries, inputCapabilityRefs, capabilityBlockRefs } from './_validate.mjs';
import { sectionLines, FENCE, ANY_HEADING, collapseWs } from './_sections.mjs';

const VOCAB = new Set([
  'web.fetch', 'email.read', 'calendar.read', 'files.read',
  'schedule.run', 'chat.notify', 'memory.prefs',
  'email.send', 'msg.send', 'social.post', 'ext.write'
]);

/* Section boundaries come from _sections.mjs, which _render.mjs also imports.
   This file used to carry its own: any `#{1,6}` heading ended a section and
   fences were not tracked at all. _render.mjs ended a section at `#{1,2}` and
   did track them. One page was therefore built from two incompatible readings
   of the same file, and a section 2 holding a `### More detail` sub-heading
   gave that page a permit list and a capability count from the truncated view
   beside prose from the full one. Presence is still this file's own signal:
   sectionLines returns [] both for a missing heading and for an empty section,
   and the difference decides E_DERIVE_SUMMARY versus a short summary. */
function sectionBody(lines, heading) {
  if (!lines.some(l => structuralTrim(l) === heading)) return null;
  return sectionLines(lines, heading);
}

/* Split one Markdown table row into cells. Leading and trailing pipes are
   optional in the wild; escaped pipes are not supported, and a cell containing
   one is a malformed table rather than something to repair. */
function cells(row) {
  /* WS_MD, not .trim(): twin of cells() in tools/validate.py. See the note
     there; a \x85 in front of one row made both gates accept a passport whose
     page then rendered five consent rows instead of six. */
  let s = mdTrim(row);
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => mdTrim(c));
}

/* validatedAt is a caller override for sample/test generation, never for the
   real capture path: upload.mjs never passes a third argument, and
   site/spec/schema.sql's insert policy on validated_at (now() minus five
   minutes to now() plus one) would refuse a pinned date on that path anyway.
   Checked the same way _validate.mjs checks front.created, including the
   same 24-hour future ceiling: shape, then Date.parse, then round-trip the
   string back through toISOString(), because Date.parse alone silently
   repairs an impossible date instead of failing it. Mirrors created's own
   gaps too: a shape-only, non-future check still accepts an implausibly
   distant past like year 0000, since created accepts the same and pinning
   from an old commit is exactly this parameter's purpose. Left unchecked
   this does not fail loudly, it reaches the page: a Date object is truthy
   so `||` would store it unstringified, and a malformed string renders
   straight into the MRZ and the "checked" prose, both of which read it with
   _render.mjs's String(row.validated_at).slice(0, 10). */
function checkValidatedAt(v) {
  if (v === undefined) return;
  const shaped = typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v);
  const ms = shaped ? Date.parse(v) : NaN;
  const real = shaped && !Number.isNaN(ms) && new Date(ms).toISOString() === v;
  const future = real && (ms - Date.now()) > 24 * 3600 * 1000;
  if (!real || future) {
    throw new TypeError(
      `derive(): validatedAt must be a real ISO-8601 timestamp in ` +
      `Date.prototype.toISOString() form, not in the future (sample/test ` +
      `generation only, never the real capture path), got ${JSON.stringify(v)}`
    );
  }
}

export function derive(front, lines, { validatedAt } = {}) {
  checkValidatedAt(validatedAt);

  /* 6.1 title */
  const title = collapseWs(String(front.title || ''));
  /* CODE POINTS, not UTF-16 units. `.length` counts surrogate pairs twice, so
     a title of 12 emoji measured 24 here and 12 in scripts/passport-to-page.py,
     which counts code points because Python strings do. Same bound, two
     answers, and the pair has to agree because build-samples.mjs runs the
     Python one. A "character" in the spec is what a reader sees, which is the
     code point, so the JavaScript side is the one that moves. */
  const titleLen = [...title].length;
  if (titleLen < 1 || titleLen > 200) return { error: err('E_DERIVE_TITLE') };

  /* 6.2 summary */
  const sec1 = sectionBody(lines, '## 1. What this agent is');
  if (!sec1) return { error: err('E_DERIVE_SUMMARY') };
  /* Line-start rules, all three, and that is the rule rather than an accident
     of how it was written. A fence is a run of backticks at the start of a
     line; three backticks in the middle of a sentence are an inline code span
     and section 1 is allowed to contain one. scripts/passport-to-page.py
     tested `"```" in text` and refused such a passport, so a file the site
     published could not be turned into a standalone page by the skill that
     captured it. Both now test the same three patterns line by line. */
  for (const l of sec1) {
    if (ANY_HEADING.test(l) || TABLE_ROW_MD.test(l) || FENCE.test(l)) {
      return { error: err('E_DERIVE_SUMMARY') };
    }
  }
  const summary = collapseWs(sec1.join('\n'));
  const summaryLen = [...summary].length;   /* code points, as above */
  if (summaryLen < 20 || summaryLen > 2000) return { error: err('E_DERIVE_SUMMARY') };

  /* 6.3 needs, from the consent table only. Never from the section 3 YAML:
     those two lists can legitimately differ, and the consent table is the one a
     human read and the one the page shows. */
  /* Every capability_ref in section 3, wherever it sits, computed before the
     consent rows because both envelope-floor parts below need it. Read the
     whole section and not just the `capabilities:` block: scoping it there left
     a bypass, since moving `capability_ref: email.send` into `inputs` made
     every part of the floor blind at once. That was 20 of the 30 evasions a
     differential fuzz found. */
  const sec3all = sectionBody(lines, '## 3. Functional spec') || [];
  /* ONE FENCE MACHINE. fenceMap() is the reader this repository already has,
     under the length rule _sections.mjs shares, so check 16 consumes it rather
     than deciding for itself. A delimiter line is not itself YAML, which is how
     tools/validate.py's spec_lines() marks it, so the two languages hand the
     helper the same flags. */
  const sec3Fences = fenceMap(sec3all);
  const sec3Yaml = sec3Fences.inside.map((v, i) => v && !sec3Fences.delimiter[i]);
  const specRefs = new Set();
  /* Anchored to a YAML key at line start, and quote-tolerant, both mirroring
     tools/validate.py. Unanchored, this read `tacit_notes` prose as a
     declaration and refused an honest passport; the narrow class could not
     match a quoted scalar and made the strip beside it dead code.

     scalar(), not a `.replace()` of one quote at each end. This was the third
     and last loose strip in the envelope path; the other two returned opposite
     verdicts from tools/validate.py on a nested-quoted status. Both gates now
     unquote with the same function, which is the only version of this that
     stays true when the next quoting shape turns up.

     `(\S+)`, not `[^\s#]+`, and this line is why the sentence above was not
     enough on its own. A `#` opens a YAML comment only when whitespace
     precedes it, so `money.transfer#1` is one scalar and the narrow class cut
     it to `money.transfer`. specRefs then held a different string here than in
     tools/validate.py, the money guard consulted it and reached the opposite
     answer, and the two gates disagreed on 57 of 13,440 fuzzed passports while
     parity.mjs stayed green because no fixture carries a `#`.

     THE HELPER WAS CONVERGED BEFORE THE REGEX FEEDING IT WAS, twice in one
     session, in three call sites of which this was the last. Converging
     scalar() said nothing about what string scalar() is handed. If a fourth
     call site ever appears, the capture and the helper travel together or it
     is not converged. */
  /* BLOCK-SCALAR CONTENT IS NOT READ (ROW-210). Anchoring was the first repair
     and it was not enough: an owner quoting a config line at the START of a
     line inside `tacit_notes` was read as a declaration and this gate refused
     the honest passport with E_DERIVE_ENVELOPE, as tools/validate.py did with
     FAIL 16. stripBlockScalarContent() is the shared rule; its twin in
     tools/validate.py is strip_block_scalar_content(). This is the fourth call
     site the paragraph above warned about, so the capture and the helper are
     changed together. The scan stays WIDE otherwise, over the whole section
     rather than the `capabilities:` block, for the reason given above. */
  for (const l of stripBlockScalarContent(sec3all, sec3Yaml)) {
    const m = l.match(CAPABILITY_REF_LINE);
    if (m) specRefs.add(scalar(m[1]));
  }
  const declaresWrite = [...specRefs].some(isDeclaredOnly);
  /* This is the widest read of "found" the file has — the whole of section 3,
     `inputs:` included, same scan `declaresWrite` uses. It exists for the
     envelope floor's arithmetic check below (part 3 of 3), to tell
     E_DERIVE_ENVELOPE_INPUT apart from the bare E_DERIVE_ENVELOPE.

     **Corrected 2026-09-08 (spec §8c):** upload.mjs's write-consent gate
     does NOT read this array. An earlier draft did, and treated an id found
     only via `inputs:` as a marker for that gate; the spec is explicit that
     it is not one — an `inputs:` entry carries no `status`, is not the
     passport's own statement about the capability, and the input case is
     already the envelope floor's business via E_DERIVE_ENVELOPE_INPUT, not
     the write-consent gate's. upload.mjs derives its own markers from
     `capabilityEntries` below, filtered by isDeclaredOnly, which is
     block-scoped already. */
  const declaredOnlyRefs = [...specRefs].filter(isDeclaredOnly);
  /* Literal ref/status line text for every capabilities: block entry,
     entry-scoped rather than line-scoped (capabilityBlockEntries' own
     comment carries the reason, including the unanchored-for-Python-parity
     choice that makes it last-match-wins within an entry). upload.mjs's
     write-consent gate reads this for line text ONLY — "what does the owner
     see to delete" — filtered to declared-only refs at each call site.
     `blockRefs`, below, is what answers "does it fire" and "which ids are
     markers"; that split is 2026-09-08, a critic-found fix. An id that
     appears only on an `inputs:` entry has no entry here on purpose; see
     declaredOnlyRefs' comment above for where that shape is handled
     instead. */
  const capabilityEntries = capabilityBlockEntries(lines);
  /* Anchored, block-scoped, not entry-paired: see capabilityBlockRefs()'
     own comment. This is the CORRECT id set for "which declared-only ids
     does the capabilities: block declare" — capabilityEntries above can
     misattribute an id to the wrong entry (or make one up out of prose) and
     must not be trusted for identity, only for best-effort line text. */
  const blockRefs = capabilityBlockRefs(lines);

  const sec2 = sectionBody(lines, '## 2. What it needs from you');
  if (!sec2) return { error: err('E_DERIVE_NEEDS') };

  /* Fence awareness, twin of `fenced` in tools/validate.py consent_rows().
     A line inside a code fence is not a consent row, so neither the filter
     below nor the tripwire may see it: a shell pipeline pasted into section 2
     puts `| jq -r ...` at the start of its continuation lines, and both gates
     refused that honest passport long before the tripwire existed. FENCE is
     the WS_MD reader; an opener carrying an invisible character is refused
     upstream as E_FENCE_INVISIBLE rather than quietly opening a block here. */
  const sec2Fences = fenceMap(sec2);
  const sec2Rows = sec2.filter((l, i) => !sec2Fences.inside[i]);

  /* THE TRIPWIRE, twin of `strays` in tools/validate.py. A line that starts
     with a pipe once every character either engine calls whitespace is removed,
     but does not survive the WS_MD test, is a row the author wrote and neither
     gate reads. Converging the two readings made them agree on a table one row
     short; agreement is not the goal. */
  if (sec2Rows.some(l => yamlTrim(l).startsWith('|') && !TABLE_ROW_MD.test(l))) {
    return { error: err('E_DERIVE_NEEDS') };
  }
  const rows = sec2Rows.filter(l => TABLE_ROW_MD.test(l));
  if (rows.length < 3) return { error: err('E_DERIVE_NEEDS') };   // header, divider, >=1 data

  const header = cells(rows[0]);
  if (header.length !== 5) return { error: err('E_DERIVE_NEEDS') };
  /* `[ \t:|-]`, not `[\s:|-]`: the third copy of this regex, and the one the
     ROW-211 sweep missed. JavaScript's `\s` contains U+FEFF and Python's does
     not, so a BOM inside the separator row was a valid separator here and not
     in tools/validate.py. */
  if (!/^[ \t]*\|?[ \t:|-]+\|?[ \t]*$/.test(rows[1])) return { error: err('E_DERIVE_NEEDS') };

  const needs = [];
  const consentRowsRaw = [];   // same index as needs; see the comment where it is pushed
  for (let i = 2; i < rows.length; i++) {
    const c = cells(rows[i]);
    if (c.length !== 5) return { error: err('E_DERIVE_NEEDS') };
    if (c.every(x => x === '')) continue;

    /* DOCUMENTED DEVIATION from upload-validation.md §6.3, which accepts only
       `required` and `optional` here and fails on anything else. The repository's
       own example passport writes `declared only` in this column for its
       email.send row, and refusing it would mean the site could not render its
       own demo. It is also the more honest value: a capability outside the
       envelope is neither required nor optional, and coercing it to "optional"
       would be a small lie in a product whose thesis is not telling those.
       §6.3 needs the same amendment, and validate.py with it. */
    const reqRaw = c[2].toLowerCase();
    let required;
    if (reqRaw.startsWith('required')) required = true;
    else if (reqRaw.startsWith('optional') || reqRaw.startsWith('declared')) required = false;
    else return { error: err('E_DERIVE_NEEDS') };

    const insRaw = c[4].toLowerCase();
    let installable;
    if (insRaw.startsWith('yes')) installable = true;
    else if (insRaw.startsWith('no')) installable = false;
    else return { error: err('E_DERIVE_NEEDS') };

    /* Both verdict cells travel twice: the boolean, which decides styling and
       the envelope, and the passport's own wording, which is what a reader
       sees. Keeping only the boolean forced the renderer to invent the text
       back, and what it invented ("Declared only") appears in no passport,
       while the install block on the same page carries the passport's table
       verbatim. Echoing keeps page and block identical by construction.
       Amends site/spec/upload-validation.md 6.3, which lists the boolean
       alone. scripts/passport-to-page.py consent_rows() carries the same two
       fields under the same names. */
    /* Backticks are stripped from the capability, and that is now written
       down in site/spec/upload-validation.md 6.3 rather than being one
       implementation's habit. This file stripped them and
       scripts/passport-to-page.py stored the cell raw, on the same input,
       with both suites green: the parity harness compared only the keys
       present on the first row of each side, and no fixture had a backticked
       capability at all. The value is displayed and nothing else, both
       renderers set it in a monospace face already, and the id a backticked
       token carries is extracted separately into `ref` below, so the marks
       carry no information the object does not already hold. */
    const item = {
      capability: c[0].replace(/`/g, ''),
      why: c[1],
      required,
      required_label: c[2],
      if_skipped: c[3],
      installable,
      installable_label: c[4]
    };
    /* The row's raw text, before cells() split it, same index as the `needs`
       entry it belongs to. NOT a field of `item`: `needs[]` is the shape
       tools/run_tests.sh's parity harness compares field for field against
       scripts/passport-to-page.py's twin parser, and a field only one side
       carries is exactly the disagreement that harness exists to catch.
       ROW-228's write-consent gate hands this to the owner verbatim as the
       line to delete; nothing else reads it, so it travels beside `needs`
       rather than inside it. */
    consentRowsRaw.push(rows[i]);

    // ref is set only from a backticked token that is a real vocabulary id.
    // It is never guessed from the prose.
    // A money token shaped like a filename is not a ref either: the same
    // decision the guard below makes, made once, in isFilenameToken().
    // TRIMMED and ASCII-FOLDED, exactly as the guard below reads the token.
    // This read the raw group while the guard read it trimmed, and a critic
    // showed `money.csv ` (trailing space) stored ref "money.csv " here and
    // no ref in scripts/passport-to-page.py, with both gates accepting: the
    // two derivations of one passport disagreed. An id is stored as the id
    // it is, so `Files.Read` is `files.read`.
    const tick = c[0].match(/`([^`]+)`/);
    if (tick) {
      const t = foldAscii(stripBlanks(tick[1]));
      if (VOCAB.has(t) || (t.startsWith('money.') && !isFilenameToken(t))) item.ref = t;
    }

    /* The envelope floor, part 2 of 3. A row that names a write capability by
       id and offers to install it is refused rather than corrected. Coercing
       `installable` to false here was the obvious move and it is wrong: the
       fifth cell also travels verbatim as `installable_label`, so the page
       would carry a "Not granted" stamp beside the passport's own word "yes",
       one contradicting the other in the same block. The note above on
       required_label is about that exact failure. Refusing keeps the file and
       the page telling one story, and matches the verdict tools/validate.py
       check 16 reaches on the same passport. */
    /* Every backticked token, not `item.ref`. `ref` is the FIRST backtick
       group only, so "Read `files.read` and also `email.send`" set ref to
       files.read and the write id walked past. The money guard lives in
       consentTokenIsWriteId() in _validate.mjs, with the list it consults and
       the reasoning beside it. It used to live here as "skip a money token
       the passport does not declare", which is the hole ROW-158 names. */
    if (installable) {
      /* ONE PASS OVER ALL FIVE CELLS, each read twice: first for a token
         that must not be echoed, then for a write id. First hit returns.

         PART ONE ran on the Capability cell only, and on one-word segments
         only, because the rule it enforced was "an installable row may
         backtick only printable ASCII" and that refused an honest German
         filename, a Japanese path and an en-dash in a date. Both restrictions
         were paying for the same over-wide rule; consentTokenIsOpaque() is now
         narrow enough to need neither (ROW-167 on top of ROW-168).

         PART TWO read the Capability cell only, while `installable_label` is
         the fifth cell travelling verbatim into inline(), which renders
         backticks as <code>: `yes (via `money.transfer`)` reached the reader
         in monospace beside a Granted stamp on a row both gates accepted. */
      for (let idx = 0; idx < CONSENT_COLUMNS.length; idx++) {
        if (consentCellOpaqueWord(c[idx]) !== null) {
          /* Every backticked span collapsed, in the echoed row AND in the
             echoed column: the word is by definition a lookalike or a control
             character, and no money regex would match a Cyrillic o. */
          /* GREEDY, first backtick to last, and NOT a repeated per-span
             collapse. A per-span collapse pairs the backticks, and in
             "Move it ``x`` now" the pairs are the two empty spans with the
             lookalike sitting between them, untouched: the collapse would
             hand the message exactly the characters it exists to withhold.
             An existing assertion caught that when this was first written
             the narrow way. Twin: collapse_spans() in tools/validate.py. */
          return { error: err('E_DERIVE_ENVELOPE_OPAQUE', {
            row: safeCellEcho(c[0].trim().replace(/`.*`/, '`...`')),
            cell: CONSENT_COLUMNS[idx],
            column: safeCellEcho(c[4].replace(/`.*`/, '`...`'))
          }) };
        }
        const tok = consentCellWriteId(c[idx], specRefs);
        if (tok === null) continue;
        /* Two codes for one predicate, on purpose. A money token may be an
           honest filename the list does not know, and telling that author
           to mark the row declared-only is a lie about their agent; the
           TOKEN message names both fixes and says only one is true. A fixed
           write id has no filename reading, so E_DERIVE_ENVELOPE's single
           fix is the true one. The wording of both is web-backend's. */
        if (foldAscii(tok).startsWith('money.')) {
          /* The CAPABILITY cell is echoed whichever cell offended: cell 0 is
             what names the row for its author, and echoing the offending cell
             would carry a stranger's money suffix into the message that
             safeRefLabel() exists to keep it out of. The column name says
             where to look and is a fixed string from the header.

             Collapsed on any span CONTAINING a money token, not only one that
             starts with a money token: a word scan finds
             `run money.transfer_acct_99 now`, and the old anchored regex
             would have echoed that suffix whole. */
          return { error: err('E_DERIVE_ENVELOPE_TOKEN', {
            row: safeCellEcho(c[0].trim().replace(/`[^`]*money\.[^`]*`/gi, '`money.*`')),
            token: safeRefLabel(tok),
            cell: CONSENT_COLUMNS[idx],
            /* The Installable cell is echoed verbatim as the passport's own
               wording, and it is now a cell the scan reads, so it can carry
               the suffix safeRefLabel() keeps out of {token}. A probe put
               money.transfer_acct_99 there and the suffix reached the message
               through this field while {token} was correctly collapsed. */
            column: safeCellEcho(c[4].replace(/`[^`]*money\.[^`]*`/gi, '`money.*`')),
            prose: idx === 0 ? '' : ' ' + PROSE_FIX
          }) };
        }
        /* Its own code since ROW-168, rather than the bare E_DERIVE_ENVELOPE
           it shared with the part-3 refusal below. That sharing was why the
           site could not name the offending COLUMN while validate.py could:
           part 3 has no offending cell, and err() prints an unfilled {cell}
           literally. Two codes, two templates, and neither has a placeholder
           the other cannot fill. */
        return { error: err('E_DERIVE_ENVELOPE_FIXED', {
          row: safeCellEcho(c[0].trim().replace(/`[^`]*money\.[^`]*`/gi, '`money.*`')),
          token: safeRefLabel(tok),
          cell: CONSENT_COLUMNS[idx],
          column: safeCellEcho(c[4].replace(/`[^`]*money\.[^`]*`/gi, '`money.*`')),
          prose: idx === 0 ? '' : ' ' + PROSE_FIX
        }) };
      }
    }

    needs.push(item);
  }

  if (needs.length < 1 || needs.length > 24) return { error: err('E_DERIVE_NEEDS') };

  /* The envelope floor, part 3 of 3: a passport that declares a write
     capability in section 3 must show the reader at least one row it will not
     install.

     Part 2 cannot carry this alone, and the reason is in the format rather
     than in this file. The Capability column is prose written for a person,
     the ids live in section 3, and NOTHING LINKS A ROW TO AN ID unless the
     author happened to backtick one. examples/daily-brief-passport.md
     backticks nothing, so a check resting on part 2 alone would be vacuous on
     the repository's own flagship.

     WHAT THIS DOES NOT DO, measured rather than assumed. It makes the TOTAL
     lie impossible, not the flat one: ONE honest declared-only row anywhere in
     the table satisfies it, and buys any number of lying rows beside it. A
     passport with an honest `status: declared_only`, a plain prose row saying
     the write capability installs, and one unrelated declared-only row passes
     every part of this floor and renders "Granted". That shape is real and was
     built. The fix is a machine-readable id column in the consent table, which
     is a format change and not this file's to make.

     `declaresWrite` comes from the whole of section 3, computed above.

     Sibling code since 2026-09-08 (spec upload-validation.md §6.3, ruled by
     HAL): when EVERY declared-only id this check found sits on an `inputs:`
     entry and none in the `capabilities:` block, the code is
     E_DERIVE_ENVELOPE_INPUT and names those ids. The block case wins when an
     id is in both places, because a block entry carries a `status` and is the
     passport's own statement about the capability; a declared-only id found
     in NEITHER place (an `output:` entry, say) gets the bare code, same as
     before — that is not the same test as "not in the block", which a
     critic on this exact branch caught being conflated: `declaredOnlyRefs`
     is the wide whole-of-section-3 scan, so an id under `output:` is also
     "not in the block" without being on an input, and the first version of
     this branch sent it to E_DERIVE_ENVELOPE_INPUT in direct contradiction
     of the spec sentence two lines up. `inputCapabilityRefs()` is what tells
     "on an input" apart from "merely not in the block": it reads `inputs:`
     as its own region, the same way `capabilityBlockRefs()` reads
     `capabilities:` as its own.

     `blockRefs` is `capabilityBlockRefs(lines)`, computed once above,
     NOT `capabilityEntries.map(e => e.ref)`. The same critic found that
     source wrong too: `capabilityEntries` (`capabilityBlockEntries()`)
     pairs a ref with a status per ENTRY, unanchored on purpose for parity
     with tools/validate.py check 16a, so it is last-match-wins within an
     entry — an honest `capability_ref: email.send` entry whose own
     `tacit_notes` field happens to mention a different id mid-line gets
     attributed to THAT id instead. `capabilityBlockRefs()` does not pair
     anything; it is anchored, like the wide scan, so a mid-line mention
     cannot set it. `declaredOnlyRefs` is the wide one, unaffected by
     either bug. */
  if (declaresWrite && !needs.some(n => !n.installable)) {
    const inputRefs = inputCapabilityRefs(lines);
    const onInputOnly = declaredOnlyRefs.length > 0 &&
      declaredOnlyRefs.every(id => inputRefs.has(id) && !blockRefs.has(id));
    if (onInputOnly) {
      const refs = [...new Set(declaredOnlyRefs.map(safeRefLabel))].sort().join(', ');
      return { error: err('E_DERIVE_ENVELOPE_INPUT', { refs }) };
    }
    return { error: err('E_DERIVE_ENVELOPE') };
  }

  /* 6.4 frontmatter-derived */
  return {
    /* Not part of the stored record; ROW-228's gate detection only. See the
       comments where each is computed, above. */
    declaredOnlyRefs,
    capabilityEntries,
    blockRefs,
    consentRowsRaw,
    record: {
      title,
      summary,
      needs,
      name: front.name,
      capture_path: front.capture_path,
      passport_version: front.passport,
      owner_confirmed: String(front.owner_confirmed).toLowerCase() === 'true',
      created: front.created,
      scrub: front.scrub,
      envelope: front.envelope,
      source_stack: front.source_stack,
      validated_at: validatedAt || new Date().toISOString(),
      validator_version: RULES_VERSION
    }
  };
}
