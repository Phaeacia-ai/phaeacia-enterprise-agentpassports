/* The enterprise intake rules the pinned JavaScript gate does not have (E3 design 3.2 to 3.4).

   Three rules, each a port of pinned code or a call into code that already exists:

   - The four normative Python format checks that neither pinned validate() nor derive() implements, read
     from vendor/passport/tools/validate.py:2047-2218 at the pin (adapter section 7a): check 15, access
     vocabulary (E_ACCESS); check 12, binding presence (E_BINDING); check 14, input fidelity (E_FIDELITY);
     check 13, verification state (E_STATE_REQUIRED). Reported in that order, so an unreadable access value
     comes before the binding demand that depends on reading it.
   - The public publisher route scan (E_PUBLIC_ROUTE): the four E0 literals of local_policy.py, matched
     after normalizeForbidden() of assemble.mjs, which is the one folder.
   - The fixed-point rule (E_CANONICAL): the text must come back unchanged from
     decodeText(encodeText(text)), the pinned-Python twins in assemble.mjs.

   A port and not a rewrite. Section 3 is located with validate()'s own fence map and the pinned
   sectionLines(); fields are matched with the pinned WS_ANY and WS_BOTH classes through yamlScalarRe();
   entries are split with the pinned LIST_ENTRY after stripBlockScalarContent(); values go through the pinned
   scalar(). The Python helpers spec_lines, yaml_block, input_entries and delta_phrase are mirrored below,
   each named at its twin. Line numbers are 1-based over the whole document, which is what the Python side
   prints, so tests/e3/unit/rules-parity.test.mjs can hold the two to agreement per fixture and per line.

   Known hole, inherited and not introduced: a flow-style entry (- {what: x, access: credentialed}) escapes
   all four checks here and in the pinned Python, because both read one line at a time. Closing it means
   parsing YAML, which is a larger decision than this slice (design 3.2 and 8.3).

   No IO. It does reach assemble.mjs, whose module scope names node:fs for its installer readers; the three
   functions used here read no file. Design 2.1 lists only the vendor modules for this file while 3.3 and
   3.4 name the assemble.mjs functions; this follows 3.3 and 3.4, and the gate manifest therefore lists
   assemble.mjs, which is correct, because its folding decides verdicts. The word the boundary gate refuses
   in comments is avoided above on purpose (scripts/check-imports.mjs rule 3). */

import { sectionLines, structuralTrim, WS_ANY, WS_ANY_RE } from '../../vendor/passport/web/lib/_sections.mjs';
import { yamlScalarRe, yamlTrim } from '../../vendor/passport/web/lib/_sections.mjs';
import { LIST_ENTRY, scalar, stripBlockScalarContent } from '../../vendor/passport/web/lib/_validate.mjs';
import { decodeText, encodeText, normalizeForbidden } from './assemble.mjs';

/* The pinned Python check number of each enterprise code. Used by the parity runner only. */
export const CHECK_NUMBERS = Object.freeze({ E_BINDING: 12, E_STATE_REQUIRED: 13, E_FIDELITY: 14, E_ACCESS: 15 });

/* DELTA_PHRASES of tools/validate.py at the pin, in its order. The JavaScript pair has no twin of check 13,
   so this is a copy of data rather than of code; tests/e3/unit/rules.test.mjs reads the Python list out of
   the vendored source and requires equality, so the copy cannot drift silently. */
export const DELTA_PHRASES = Object.freeze([
  'vs prev',
  'versus prev',
  'against prev',
  'compared to prev',
  'compared with prev',
  'previous run',
  'previous period',
  'previous value',
  'previous figure',
  'previous number',
  'previous reading',
  'prior run',
  'prior period',
  'prior value',
  'last run',
  'earlier run',
  'preceding run',
  'since last run',
  'since the last run',
  'since last time',
  'since it last ran',
  'since the previous',
  'vs yesterday',
  'versus yesterday',
  'against yesterday',
  'compared to yesterday',
  'compared with yesterday',
  'yesterday s value',
  'yesterday s number',
  'yesterday s figure',
  'period over period',
  'day over day',
  'week over week',
  'month over month',
  'run over run',
  'change since the last',
  'change since the previous',
  'change since yesterday',
  'delta since yesterday',
  'difference since yesterday',
  'delta vs',
  'delta versus',
  'delta against',
  'delta from the previous',
]);

/* delta_phrase(): a phrase introduced by one of these names the output's own furniture, not a comparison. */
const FURNITURE = Object.freeze([
  'headed',
  'titled',
  'named',
  'called',
  'labelled',
  'labeled',
  'section',
  'heading',
  'column',
]);

/* local_policy.py PUBLIC_ROUTES (E0), in its order. */
export const PUBLIC_ROUTES = Object.freeze([
  'app.phaeacia.ai',
  'phaeacia.ai/api',
  'scripts/publish.py',
  'paste it into the upload box',
]);

const SPEC_HEADING = '## 3. Functional spec';
const CREDENTIALED = 'credentialed';
const EMPTY_BINDINGS = Object.freeze(['none', 'null', '~', '[]']);

/* yaml_field_re() of tools/validate.py. The value form is the pinned yamlScalarRe(key, true): its prefix
   [WS_ANY]*(?:-[WS_ANY]*)? accepts exactly the strings the Python prefix [WS_ANY]*-?[WS_ANY]* accepts, and
   the rest of the pattern is the same, so the capture is the same. The no-value form has no JavaScript twin
   and is written with the same classes; [^\n] stands for Python's dot, which stops only at a line feed,
   where a JavaScript dot would also stop at U+2028 and U+2029. */
const SLOT_ID = yamlScalarRe('id', true);
const ACCESS = yamlScalarRe('access', true);
const ACCESS_DANGLING = new RegExp(`^[${WS_ANY}]*-?[${WS_ANY}]*access:[${WS_ANY}]*(?:#[^\\n]*)?$`);
const BINDING = yamlScalarRe('binding', true);
const FIDELITY = yamlScalarRe('fidelity', true);
const KEEPS = new RegExp(`^[${WS_ANY}]*keeps:`);

const problem = (code, line) => ({ code, line });

/* spec_lines(): [{ n, line }] for section 3, n 1-based over the document. The heading is the first line
   outside a fence, by validate()'s fence map, whose trim equals the heading; sectionLines() locates it with
   the same walk, and the two are required to agree rather than assumed to. The third element the Python
   returns is dropped here because yaml_block() drops it before any check reads a line. */
function specLines(lines, inside) {
  const at = lines.findIndex((line, i) => !inside[i] && structuralTrim(line) === SPEC_HEADING);
  if (at === -1) return [];
  const body = sectionLines(lines, SPEC_HEADING);
  if (body.some((line, j) => line !== lines[at + 1 + j])) throw new Error('rules: section 3 located two ways');
  return body.map((line, j) => ({ n: at + 2 + j, line }));
}

/* yaml_block(): the entries of a column-0 `key:` block, from its key line to the next non-blank column-0 line
   that is not a list dash. */
function yamlBlock(entries, key) {
  const head = new RegExp(`^${key}:`);
  const out = [];
  let open = false;
  for (const entry of entries) {
    if (head.test(entry.line)) {
      open = true;
      out.push(entry);
      continue;
    }
    if (!open) continue;
    const trimmed = yamlTrim(entry.line);
    if (trimmed && !WS_ANY_RE.test(entry.line) && !trimmed.startsWith('-')) break;
    out.push(entry);
  }
  return out;
}

/* input_entries(): the `inputs:` block after its key, block-scalar content dropped, split at LIST_ENTRY.
   stripBlockScalarContent() returns the kept lines without their positions, so each kept line is matched to
   the earliest unused input line equal to it. That recovery is exact, not a heuristic: every line between two
   kept lines was dropped while one block stayed open with one key column, so a dropped line equal to the
   next kept line would itself have been non-blank and no deeper than that column, and so kept. */
function inputEntries(block) {
  const rest = block.slice(1);
  const kept = stripBlockScalarContent(rest.map((entry) => entry.line));
  const entries = [];
  let current = null;
  let i = 0;
  for (const line of kept) {
    while (i < rest.length && rest[i].line !== line) i++;
    if (i === rest.length) throw new Error('rules: a kept line has no source line');
    const entry = rest[i++];
    if (LIST_ENTRY.test(entry.line)) {
      if (current) entries.push(current);
      current = [entry];
    } else if (current) current.push(entry);
  }
  if (current) entries.push(current);
  return entries;
}

/* delta_phrase(): the first phrase a line contains, or null. Punctuation runs collapse to one space; each
   phrase is anchored at a word boundary on the left and open on the right. */
function deltaPhrase(line) {
  const norm = line.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  for (const phrase of DELTA_PHRASES) {
    for (const m of norm.matchAll(new RegExp(`\\b${phrase}`, 'g'))) {
      const before = norm.slice(0, m.index).replace(/ +$/, '').split(' ').slice(-2);
      if (before.some((word) => FURNITURE.includes(word))) continue;
      return phrase;
    }
  }
  return null;
}

/** Checks 15, 12, 14 and 13 over validate()'s `lines` and `inside`: [{ code, line }], empty when all pass. */
export function formatChecks(lines, inside) {
  const spec = specLines(lines, inside);
  const access = [];
  const binding = [];
  const fidelity = [];
  const state = [];

  const slotIds = new Set();
  for (const { line } of yamlBlock(spec, 'personal_slots')) {
    const m = SLOT_ID.exec(line);
    if (m) slotIds.add(scalar(m[1]));
  }

  const entries = inputEntries(yamlBlock(spec, 'inputs'));
  for (const entry of entries) {
    let credentialed = null;
    let bound = false;
    let target = null;
    let at = null;
    for (const { n, line } of entry) {
      if (ACCESS_DANGLING.test(line)) access.push(problem('E_ACCESS', n));
      else {
        const m = ACCESS.exec(line);
        if (m) {
          const value = scalar(m[1]);
          /* Case-folded on purpose, as the Python does: shouting the word does not escape the binding. */
          if (value.toLowerCase() === CREDENTIALED) credentialed = n;
          if (value !== 'open' && value !== CREDENTIALED) access.push(problem('E_ACCESS', n));
        }
      }
      const b = BINDING.exec(line);
      if (b) {
        bound = true;
        target = scalar(b[1]);
        at = n;
      }
    }
    if (bound && EMPTY_BINDINGS.includes(target.toLowerCase())) binding.push(problem('E_BINDING', at));
    else if (bound && !slotIds.has(target)) binding.push(problem('E_BINDING', at));
    if (credentialed !== null && !bound) binding.push(problem('E_BINDING', credentialed));
  }

  for (const entry of entries) {
    for (const { n, line } of entry) {
      const m = FIDELITY.exec(line);
      if (m && !['exact', 'lossy'].includes(scalar(m[1]))) fidelity.push(problem('E_FIDELITY', n));
    }
  }

  if (!yamlBlock(spec, 'state').some(({ line }) => KEEPS.test(line))) {
    for (const { n, line } of yamlBlock(spec, 'verification')) {
      if (deltaPhrase(line) !== null) state.push(problem('E_STATE_REQUIRED', n));
    }
  }

  return [...access, ...binding, ...fidelity, ...state];
}

/** The fixed-point rule: [] when decodeText(encodeText(text)) === text, else one E_CANONICAL problem on the
    line of the first carriage return, which is the only character that round trip changes in transport
    output (design 3.4, probe 2c). */
export function fixedPoint(text) {
  if (decodeText(encodeText(text)) === text) return [];
  const at = text.indexOf('\r');
  return [problem('E_CANONICAL', at === -1 ? null : text.slice(0, at).split('\n').length)];
}

/** The public publisher route scan over validate()'s `lines`: one E_PUBLIC_ROUTE per route found, on the line
    where its earliest match starts. Folding the whole document once decides whether there is anything to
    locate. A match is located by folding prefixes: a prefix that holds a match keeps it when a line is added,
    because a line feed ends NFKC composition, lower-casing context and noise deletion, and the join of a
    broken line only removes blanks beside a line feed. The line where the earliest match completes is found
    by bisection, then the walk back finds the line where that match starts. */
export function publicRoutes(lines) {
  const folded = normalizeForbidden(lines.join('\n'));
  const holds = (from, to, needle) => normalizeForbidden(lines.slice(from, to + 1).join('\n')).includes(needle);
  const found = new Set();
  for (const route of PUBLIC_ROUTES) {
    const needle = normalizeForbidden(route);
    if (!folded.includes(needle)) continue;
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (holds(0, mid, needle)) hi = mid;
      else lo = mid + 1;
    }
    let start = lo;
    while (start > 0 && !holds(start, lo, needle)) start--;
    found.add(start + 1);
  }
  return [...found].sort((a, b) => a - b).map((line) => problem('E_PUBLIC_ROUTE', line));
}
