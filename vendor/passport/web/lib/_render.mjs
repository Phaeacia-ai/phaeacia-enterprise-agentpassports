/* Renders a stored passport as the page a recipient sees.

   Everything that reaches HTML is escaped here. upload-validation.md §5.1 is
   explicit that the HTML gate is a gate, not a substitute for escaping: "if the
   only thing standing between a stored passport and script execution is that
   regex, the design is wrong." So this file escapes unconditionally, including
   content the gate already refused.

   Design direction: ~/Phaeacia/brand/PASSPORT-DIRECTION.md. It was cited here as
   a bare filename while the only copy sat in the Archive folder, so the
   citation resolved to nothing for anybody who went looking. The full path is
   written out for that reason; if it moves again, move this line with it.

   The artefact is a travel document
   with five numbered pages, and every playful element on it is generated from
   the stored passport. A stamp that is not backed by an actual permission, or a
   machine-readable zone that does not encode the actual passport, turns the
   joke into decoration and the honesty claim into a pose. */

import { sectionLines as sliceSection, sectionParts } from './_sections.mjs';
import { CANONICAL } from './_site.mjs';
import { categoryLabel } from './_categories.mjs';
/* The listed-or-not predicate, shared with passport.mjs so the robots header
   and the body cannot disagree. _row.mjs is dependency-free by contract; see
   its header for why that matters to the website's sample build. */
import { listingOf } from './_row.mjs';

/* esc and clip are exported for lib/_gallery-render.mjs, which renders the card
   grid. They are exported rather than copied because two escapers in one app is
   one escaper and a hazard: the copy is the one that stops getting fixed. */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);

/* The uuid shape, and the ONLY thing that may put an id into an attribute.
   passport.mjs states the same rule and _gallery-render.mjs restates it at the
   top of the file: an attribute is built only from a value that passed this
   test, or is a member of a fixed list, or is an integer the renderer formatted
   itself. No string an uploader wrote ever reaches an attribute. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* The vote control, on a gallery card and on a listed passport page.

   IT IS A FORM AND IT WORKS WITH JAVASCRIPT OFF. /api/vote accepts the form
   post and answers 303 to /p/<id>, or to /gallery when `back` is present.
   assets/gallery.js prevents the default and sends JSON instead when it can.
   The no-script path is kept on purpose: this page already works without
   script, and a control that silently does nothing would be the first element
   on the site that fails closed.

   `id` reaches the value attribute only after UUID.test, which is the caller's
   job and is asserted here by refusing to render otherwise. `back` is the fixed
   string or nothing; it is never a field a visitor supplied. */
export function voteControl(id, up, down, back) {
  id = String(id);
  if (!UUID.test(id)) return '';
  const u = String(Math.max(0, Math.trunc(Number(up) || 0)));
  const d = String(Math.max(0, Math.trunc(Number(down) || 0)));
  return `<form class="vote" method="post" action="/api/vote">
  <input type="hidden" name="id" value="${id}">
${back ? `  <input type="hidden" name="back" value="gallery">\n` : ''}  <button type="submit" name="dir" value="up" aria-label="Vote up">▲ <span data-up>${u}</span></button>
  <button type="submit" name="dir" value="down" aria-label="Vote down">▼ <span data-down>${d}</span></button>
  <p class="vote-status" data-vote-status role="status" aria-live="polite" aria-atomic="true"></p>
</form>`;
}

/* Safe embedding of a value inside a <script> element.

   "<" is escaped so a closing script tag inside the body cannot end the
   element. ">" is escaped so the output is BALANCED: escaping only the opener
   left a body's comment closer on the page raw while its own opener was gone,
   so the served example page carried 13 openers and 14 closers. No browser
   cares, because with "<" escaped the parser never enters comment state.

   BE PRECISE ABOUT WHY, because the first version of this comment was not and
   a critic refuted it. It claimed the ROW-135 comment stripper pairs
   delimiters by text and would swallow the passport body. It does not.
   web/tools/served_text.py lexes each script and style body FIRST, collects
   its comment spans, and only then blanks it, so that the markup pass cannot
   misread a closer inside a JS string as a terminator. Measured against that
   lexer: 14 spans and the passport body intact, with the escape and without
   it. It is unaffected either way.

   Do not restate that as "it blanks script bodies before looking for
   comments". This file said exactly that for an hour and it is false in a way
   that matters: a reader who believes it will skip a check that does in fact
   run, and will assume a JS comment written into a template is unreachable.
   It is not. It is simply never reached HERE, for a different and sufficient
   reason: /p/<id> markup is generated per request and never exists as a file,
   and a tool that strips served files cannot strip a page that is not one.

   So this is not a fix for a live defect. It is worth doing on two smaller
   grounds and they should not be inflated: unbalanced delimiters in served
   output are wrong on their own terms, and the escape removes the hazard
   rather than leaving it resting on the stripper staying a lexer. A greedy
   regex would still damage the page with this escape in place, so it buys
   less than it looks like it buys.

   It costs almost nothing. "\\u003e" IS ">" to the JS parser, so
   window.__BODY holds the same string, which is the property this function
   exists to protect. Checked by eval-ing the assignment out of both rendered
   pages and over ">"-heavy shell and HTML bodies: identical every time. The
   served example page grows 5 bytes.

   WHY THE BODY IS A JSON STRING LITERAL AND NOT ESCAPED TEXT IN AN ELEMENT.
   HTML entities are not decoded inside a raw text element, so `&lt;` would
   reach the clipboard literally and corrupt the block someone is about to
   paste into their assistant. Escaping "<" is what makes a closing script tag
   inside the body inert while every character of the original survives.

   This paragraph used to sit inside the template, directly above
   window.__BODY, which meant it was SERVED on every passport page: 932 bytes
   of engineering commentary, including an account of a past bug, delivered to
   every recipient. ROW-135 bans that. It was invisible to the count that
   found the thirteen HTML comments, because a JS comment is not an HTML
   comment and no `<!--` sweep and no comment stripper will ever see it.

   ANYTHING WRITTEN INTO THE TEMPLATE IS SHIPPED. A comment there is not a
   note to the next engineer, it is page content. Two separate defects came
   from forgetting that: an earlier wording put a literal closing script tag
   in it and ended the element early, so __BODY and __PLATFORMS were never
   assigned and the rest of the script printed itself onto the page; and while
   this very fix was being written, a note about comment delimiters put real
   ones on every page. Keep the reasoning here, at the definition, where it
   cannot be served. */
const jsonScript = v => JSON.stringify(v)
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

/* The Markdown reading of a section lives in _sections.mjs, which _derive.mjs
   imports too, so derivation and rendering cannot disagree about where a
   section ends or how its parts split. It was written here and separately
   there, with different heading rules, until that disagreement showed up on
   one page. */
const sectionLines = (body, heading) => sliceSection(body.split('\n'), heading);

const sectionProse = lines =>
  sectionParts(lines).parts.filter(p => p.kind === 'prose').map(p => p.text);

/* ── the purpose line ──────────────────────────────────────────────────────
   One line, at the top of the document, saying what the agent does.

   A recipient who opens a stranger's link has to understand the function in a
   second or two, and the full summary is a paragraph. The obvious fix is to
   write a short description, and that is the one thing this product may not
   do: _derive.mjs's note on required_label is about exactly this failure, a
   renderer inventing wording and printing it as though the owner had written
   it. So the line is never composed. It is quoted, from one of two places, and
   the cover says which one it came from.

   First choice is `goal.value` in the section 3 YAML, which is the owner's own
   statement of what the agent is for, confirmed at the capture step, and which
   this page did not surface anywhere at all. In the repository's example that
   is "deliver a short morning briefing that replaces scrolling the news",
   which is the line the owner asked for.

   Second choice, when the spec carries no goal, is the FIRST SENTENCE of the
   summary. That is an excerpt, not a paraphrase: the whole summary still
   prints under Observations on page 2, so nothing is hidden by leading with
   its opening.

   The reader is only ever shown the passport's own characters. The one
   presentational liberty is capitalising the first letter, done in CSS with
   ::first-letter, because the stored text is a YAML fragment that starts
   lower-case and a lower-case opening on a cover reads as a bug rather than as
   fidelity. Nothing is appended, and no full stop is added. */

/* Reads goal.value out of the section 3 fence. Deliberately narrow: a
   top-level `goal:` mapping, then a `value:` on the next indent level, a
   single-line scalar only. A block scalar (`value: |`) or anything longer than
   a line is refused rather than half-read, because a truncated goal is a
   sentence the owner did not write. */
function goalValue(body) {
  const blocks = sectionParts(sectionLines(body, '## 3. Functional spec')).parts
    .filter(p => p.kind === 'block');
  for (const b of blocks) {
    const lines = b.text.split('\n');
    const at = lines.findIndex(l => /^goal:\s*$/.test(l));
    if (at < 0) continue;
    for (let i = at + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break;                 // left the goal mapping
      const m = lines[i].match(/^\s{1,4}value:[ \t]*(.*)$/);
      if (!m) continue;
      const v = m[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
      if (!v || /^[|>][-+0-9]*$/.test(v)) return '';   // block scalar, not a line
      return v.length <= 200 ? v : '';
    }
  }
  return '';
}

/* The first sentence of the summary, as characters the owner typed. Falls back
   to the whole summary when there is no terminator to cut at, and clips rather
   than running long, because this line has one line of room. */
function firstSentence(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  const one = (m ? m[0] : t).trim();
  return one.length > 200 ? clip(one, 200) : one;
}

function purposeLine(row, body) {
  const goal = goalValue(body);
  if (goal) return { text: goal, source: 'the goal the owner wrote in the spec' };
  const first = firstSentence(row.summary);
  if (first) return { text: first, source: 'the first line of the owner’s description' };
  return null;
}

/* Truncation for a social card description. Cuts at the last word boundary
   before the limit rather than mid-word: slicing this summary at 180 produced
   "…It runs bef", which is the first thing a recipient sees of the product in
   a chat preview. */
export function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const at = cut.lastIndexOf(' ');
  return (at > n * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.–—-]+$/, '') + '…';
}

function cells(row) {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

/* Inline Markdown, deliberately tiny: bold, italic and code. Escapes first,
   then re-introduces the three constructs. Anything else stays literal text,
   which is the correct outcome for a document nobody trusts.

   Links used to be the fourth construct and rendered as live anchors. They are
   now rendered as the label followed by the visible URL, and nothing on this
   page is clickable out to another host.

   The reason is a chain that worked end to end. Anyone can publish a passport,
   and the send box will mail its link from this domain with DKIM and SPF passing.
   A recipient who trusts the message lands on a page on this domain. A live
   anchor in a stranger's prose made that page one click from anywhere, which
   turns an honest sharing tool into the last hop of a phishing funnel wearing
   our certificate. Showing the URL as text keeps every bit of the information
   and costs a copy and paste, which is the right side of that trade for a
   document whose author is a stranger to the reader. */
function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, (_, c) => '<strong>' + c + '</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, (_, p, c) => p + '<em>' + c + '</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g,
    (_, label, href) => label + ' <span class="rawlink">' + href + '</span>');
  return t;
}

/* Data rows of a Markdown table: header and divider dropped, blank rows too. */
function tableRows(lines) {
  const rows = lines.filter(l => l.trim().startsWith('|'));
  if (rows.length < 2) return { header: [], data: [] };
  return {
    header: cells(rows[0]),
    data: rows.slice(2).map(cells).filter(c => c.some(x => x !== ''))
  };
}

function mdTable(lines, emptyNote) {
  const { header, data } = tableRows(lines);
  if (!header.length || !data.length) return '<p class="caption">' + esc(emptyNote) + '</p>';
  return '<div class="scroll"><table><thead><tr>' +
    header.map(h => '<th>' + inline(h) + '</th>').join('') +
    '</tr></thead><tbody>' +
    data.map(r => '<tr>' + r.map((c, i) =>
      '<td' + (i === 0 ? '' : ' class="dim"') + '>' + inline(c) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

/* ── page 3: the machine-readable zone ─────────────────────────────────────
   Built the way a real one is. ICAO 9303 uses a repeating 7-3-1 weighting over
   A=10..Z=35 with a filler of zero, and the check digit is the sum modulo ten.
   Doing it properly costs nine lines and means the strip survives being read by
   someone who knows what it is.

   Two lines of 44, in the TD3 field positions. The field SEMANTICS are ours,
   because an agent has no nationality and no date of birth, and the legend
   rendered beside the strip says so field by field. Every value is read off the
   stored passport: nothing here is filler that looks like data. */
const MRZ_SET = c => (c === '<' ? 0 : /[0-9]/.test(c) ? Number(c) : c.charCodeAt(0) - 55);
function checkDigit(s) {
  const w = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += MRZ_SET(s[i]) * w[i % 3];
  return String(sum % 10);
}
const mrzPad = (s, n) => (s + '<'.repeat(Math.max(0, n))).slice(0, n);
const mrzClean = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const mrzWords = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '<').replace(/^<|<$/g, '');
const pad2 = n => String(Math.max(0, Math.min(99, Number(n) || 0))).padStart(2, '0');

/* read-notify is the only envelope v0.1 accepts, so class A is the only class
   that exists yet. An unknown one is X rather than a guess. */
const envClass = e => (String(e || '').toLowerCase() === 'read-notify' ? 'A' : 'X');
const pathCode = p => (String(p || '').toLowerCase() === 'file' ? 'F'
                    : String(p || '').toLowerCase() === 'browser' ? 'W' : 'X');

/* Split out of mrz() below so a second caller can get the two raw 44-character
   lines without the HTML this file wraps them in for the page. ROW-169's
   request-time card (og-template.mjs's ogCard) needs exactly that: the same
   check-digit computation, unescaped, as two plain strings. One algorithm,
   two callers, rather than a second implementation that could drift from
   this one. See ogInputs() below, the export that reaches it. */
function mrzLines(row, counts) {
  const type = 'P' + envClass(row.envelope);
  const issuer = 'PHA';
  const name = mrzPad(mrzWords(row.name) + '<<' + mrzWords(row.title), 39);
  const l1 = type + issuer + name;

  const docNum = mrzPad(mrzClean(row.name), 9);
  const docChk = checkDigit(docNum);
  const issued = mrzPad(mrzClean(row.created).slice(2, 8), 6);
  const issChk = checkDigit(issued);
  const path = pathCode(row.capture_path);
  const checked = mrzPad(mrzClean(String(row.validated_at).slice(0, 10)).slice(2, 8), 6);
  const chkChk = checkDigit(checked);
  const optional = mrzPad(
    'V' + mrzPad(mrzClean(row.passport_version), 2) +
    'C' + pad2(counts.capabilities) +
    'I' + pad2(counts.installable) +
    'L' + pad2(counts.losses) +
    (row.owner_confirmed ? 'Y' : 'N'), 14);
  const optChk = checkDigit(optional);

  const stem = docNum + docChk + issuer + issued + issChk + path + checked + chkChk + optional + optChk;
  const composite = checkDigit(stem.slice(0, 10) + stem.slice(13, 20) + stem.slice(21, 43));
  const l2 = stem + composite;

  return { l1, l2, type, issuer, name, docNum, docChk, issued, issChk, path, checked, chkChk, optional, optChk, composite };
}

function mrz(row, counts) {
  const { l1, l2, type, issuer, name, docNum, docChk, issued, issChk, path, checked, chkChk, optional, optChk, composite } =
    mrzLines(row, counts);

  const legend = [
    ['L1 1-2',   type,  'Document type. P for passport, ' + envClass(row.envelope) + ' for the ' + row.envelope + ' envelope.'],
    ['L1 3-5',   issuer, 'Issuing authority. This site checked the format and stored the file.'],
    ['L1 6-44',  name,   'The name field: the identifier, then the title, split by a double filler.'],
    ['L2 1-10',  docNum + docChk, 'The identifier, and its check digit.'],
    /* These three characters had no legend row, which on a page whose whole
       joke is exactness left an attentive reader three characters nobody
       accounted for. TD3 carries nationality here. */
    ['L2 11-13', issuer, 'Issuing authority again, where a passport carries the bearer’s nationality. An agent has none.'],
    ['L2 14-20', issued + issChk, 'Issued ' + row.created + ', and its check digit.'],
    ['L2 21',    path,   'Capture path: ' + row.capture_path + '.'],
    ['L2 22-28', checked + chkChk, 'Checked ' + String(row.validated_at).slice(0, 10) + ', and its check digit.'],
    ['L2 29-43', optional + optChk, 'Spec version, ' + counts.capabilities + ' capabilities, ' +
              counts.installable + ' installable, ' + counts.losses + ' losses declared, owner ' +
              (row.owner_confirmed ? 'confirmed' : 'did not confirm') + '.'],
    /* Not "the whole of line two": ICAO 9303 computes the composite over
       1-10, 14-20 and 22-43 only, and the code above does exactly that. The
       three excluded runs are the issuer, the capture path and this digit. */
    ['L2 44',    composite, 'Composite check digit over positions 1-10, 14-20 and 22-43. Positions 11-13, 21 and 44 are excluded, as ICAO 9303 excludes them.']
  ];

  return {
    lines: '<span>' + esc(l1) + '</span><span>' + esc(l2) + '</span>',
    legend: legend.map(([pos, val, note]) =>
      '<div><span class="pos">' + esc(pos) + '</span><span class="v">' + esc(val) +
      '</span><span class="k">' + esc(note) + '</span></div>').join('')
  };
}

/* ROW-169's one export from this file, for netlify/functions/og.mjs. Returns
   exactly what og-template.mjs's ogCard() needs from a stored row: the same
   `counts` triple renderPassport computes below (capabilities, installable,
   losses off needs and the Losses table), and the two raw 44-character strip
   lines mrzLines() computes, unescaped. Deliberately NOT renderPassport
   itself: that renders the whole four-page HTML document, which the card
   function has no use for and should not pay the cost of. The one check-digit
   algorithm still lives only in mrzLines() above; this is a second, thinner
   caller of it, not a second implementation. */
export function ogInputs(row) {
  const needs = row.needs || [];
  const installable = needs.filter(n => n.installable).length;
  const lossLines = sectionLines(row.body || '', '## 6. Losses');
  const lossCount = tableRows(lossLines).data.length;
  const counts = { capabilities: needs.length, installable, losses: lossCount };
  const { l1, l2 } = mrzLines(row, counts);
  return { counts, strip: [l1, l2] };
}

/* The third consent column's name. NEEDS_COLUMNS in
   scripts/passport-to-page.py is the definition and carries the measurements
   behind it; this is the copy that the runtime page prints. Short version:
   "Required" was a question answered by the word "Required", and the spec's
   own "Required / Optional" costs the neighbouring column a sixth of its
   width on a narrow desktop. */
const REQ_COLUMN = 'Requirement';

const PLATFORMS = [
  { key: 'chatgpt',     label: 'ChatGPT',         file: 'chatgpt',
    note: 'Scheduled tasks are first-class here. Connectors are on paid plans only, and the task cap depends on your plan.',
    next: 'Your assistant will interview you for the personal parts, wire up what it can, run the agent once, and show you the losses table.' },
  { key: 'claude-ai',   label: 'claude.ai',       file: 'claude-ai',
    note: 'Connectors are available without a paid add-on. Scheduling is a separate beta rather than a built-in.',
    next: 'Your assistant will interview you for the personal parts, wire up what it can, run the agent once, and show you the losses table.' },
  { key: 'claude-code', label: 'Claude Code',     file: 'claude-code',
    note: 'Writes an Agent Plugin folder. Both layouts are written and the branch says which one actually loads.',
    next: 'Your assistant will write the plugin folder, interview you for the personal parts, run the agent once, and show you the losses table.' },
  { key: 'generic',     label: 'Other assistant', file: 'generic',
    note: 'Cites no platform facts. Your assistant works out its own environment by checking what it can do and asking you.',
    next: 'Your assistant will name what it can provide for each capability, install those, and put everything it cannot provide in the losses table.' }
];

/* The mark, duotone, inheriting `color`. Geometry from DESIGN-GUIDE §2: do not
   retype these paths, they are the ones in assets/mark/. */
const MARK = `<svg viewBox="-0.20 -5.00 88.20 95.40" aria-hidden="true"><g fill="currentColor" transform="rotate(138 50 50)"><path d="M43.5 32.5A6.5 6.5 0 0 1 56.5 32.5V115.5A6.5 6.5 0 0 1 43.5 115.5Z" fill-opacity=".58"/><path d="M43.5 57C43.5 46 37.5 38 37 26C36.5 12 41 2.5 50 2.5C59 2.5 63.5 12 63 26C62.5 38 56.5 46 56.5 57Z" fill-opacity=".58"/><path d="M43.5 32.5A6.5 6.5 0 0 1 56.5 32.5V57H43.5Z"/></g></svg>`;

export const HEAD_COMMON = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#F7F8F5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#071B23" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/assets/favicon/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/assets/favicon/favicon-32.png" sizes="32x32">
<link rel="icon" href="/assets/favicon/favicon-16.png" sizes="16x16">
<link rel="apple-touch-icon" href="/assets/favicon/apple-touch-icon.png">
<link rel="preload" href="/assets/fonts/schibsted-grotesk-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/dm-mono-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/fonts/fonts.css">
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/base.css">
<script>(function(){try{var t=localStorage.getItem('phaeacia-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>`;

export const TOPBAR = `<header class="topbar">
  <div class="wrap">
    <a class="ph-lockup" href="/">
      ${MARK}
      <span class="ph-wordmark">Phaeacia</span>
      <span class="ph-product">Agent Passport</span>
    </a>
    <nav class="topnav" aria-label="Primary">
      <a class="navlink" href="/upload">Upload</a>
      <a class="navlink" href="/about">About</a>
      <a class="navlink drop-sm" href="/delete">Delete</a>
      <a class="navlink" href="/gallery">Gallery</a>
      <a class="navlink drop-md" href="https://phaeacia.ai">Phaeacia</a>
      <button class="themetoggle" type="button" data-theme-toggle><span class="vh">Theme: </span><span data-theme-label>Auto</span></button>
    </nav>
  </div>
</header>`;

/* The contact address is a placeholder until the operating entity exists. It is
   rendered inert on the imprint and is not a link anywhere. A live
   live mail link to the unsubstituted address used to ship in this footer,
   on every route including the runtime-rendered passport page. */
export function footer(meta) {
  return `<footer class="foot wrap">
  <div class="fmark">
    <a class="ph-lockup" href="/">
      ${MARK}
      <span class="ph-wordmark">Phaeacia</span>
    </a>
  </div>
  <div class="fbody">
    <p>A passport carries no credentials. It names the kinds of access an agent needs, and you grant your
    own on your own platform. Version 0.1 installs agents that read and report. Anything that writes to
    the world is listed and marked not installable.</p>
    <div class="flinks">
      <a href="https://phaeacia.ai">Phaeacia</a>
      <a href="/gallery">Gallery</a>
      <a href="/upload">Upload a passport</a>
      <a href="/about">About</a>
      <a href="/p/example">Example passport</a>
      <a href="/delete">Delete a passport</a>
      <a href="/changelog">What changed</a>
      <a href="/privacy">Privacy</a>
      <a href="/imprint">Imprint and contact</a>
    </div>
    <p class="meta">${meta}</p>
  </div>
</footer>`;
}

/* The canonical origin, for the routes that are rendered without a request to
   read one off. Social cards need absolute URLs: a relative og:image is
   ignored by every scraper that matters, and one link pasted into a chat is
   this product's entire distribution loop.

   It now lives in _site.mjs, because send.mjs and upload.mjs need it too and
   neither should import a thousand-line renderer for one string. Re-exported
   here rather than moved outright: this name is referenced from this file's own
   comments and tests, and a rename would be churn with no reader benefit.

   Imported AND re-exported, not `export ... from`, which re-exports without
   creating a local binding. This file uses CANONICAL in four places below and
   the bare re-export form would leave every one of them undefined. Caught by
   running it, which is the only way that particular mistake announces itself. */
export { CANONICAL };

/* The not-found page. Same body for a uuid that never existed and for one that
   was deleted: a visitor must not be able to tell the two apart. That rule is
   why og:url here points at the site root and never at the requested path. */
export function renderNotFound(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${HEAD_COMMON}
<title>No passport here · Agent Passport</title>
<meta name="robots" content="noindex, nofollow">
<meta name="description" content="This link does not lead to a passport.">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Agent Passport">
<meta property="og:title" content="No passport here">
<meta property="og:description" content="This link does not lead to a passport.">
<meta property="og:url" content="${CANONICAL}/">
<meta property="og:image" content="${CANONICAL}/assets/og/og-card.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="An Agent Passport cover: the Phaeacia mark, the document type, and two entry stamps reading granted and not granted.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="No passport here">
<meta name="twitter:description" content="This link does not lead to a passport.">
<meta name="twitter:image" content="${CANONICAL}/assets/og/og-card.png">
<meta name="twitter:image:alt" content="An Agent Passport cover: the Phaeacia mark, the document type, and two entry stamps reading granted and not granted.">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${TOPBAR}
<main id="main"><div class="wrap">
  <section class="hero">
    <div class="stack" style="gap:24px">
      <p class="eyebrow">Not found</p>
      <h1>No passport here.</h1>
      <p class="lede">${esc(message)}</p>
      <div class="actions">
        <a class="btn" href="/p/example">See the example passport</a>
        <a class="textlink" href="/upload">Publish one</a>
      </div>
    </div>
  </section>
</div></main>
${footer('Agent Passport 0.1 · no accounts, no tracking, and one cookie only if you vote')}
<script src="/assets/site.js"></script>
</body>
</html>`;
}

/* `origin` DEFAULTS TO CANONICAL AND THE APP MUST NOT PASS ONE.

   It reaches exactly three places, all of them absolute social-card URLs:
   og:url, og:image and twitter:image. `esc()` stops an attribute break there
   and does nothing about host substitution, so when the app passed
   `new URL(req.url).origin` a request arriving with a different Host produced
   a page whose canonical and card URLs named that host, and an unfurling bot
   fetched our social card from somewhere that is not us. Under a deploy
   preview the same mechanism points every card at the preview's hostname.

   The right value was never the caller's: a social card should name the real
   site whatever host served the page. `renderNotFound` already used CANONICAL
   for these same tags. This is that decision applied to the route that had
   been taking it from the request.

   THE PARAMETER STAYS, and is not vestigial. The marketing site renders this
   same passport for a page it hosts itself, at
   `~/Phaeacia/website/tools/build-samples.mjs:342`, and passes
   `https://phaeacia.ai`. That generator then rewrites the rendered og:url and
   card path by exact string match, and its `swap()` throws rather than
   continuing when a string moves. Hardcoding CANONICAL here would break it,
   loudly and for a good reason. An explicit origin from a build step is a
   different thing from one derived from a stranger's request. */
export function renderPassport(id, row, origin = CANONICAL) {
  const body = row.body || '';
  /* Section 4 in the passport's own order: a paragraph renders where the owner
     put it, above the block it introduces or below the block it qualifies.
     This page used to collect every paragraph of the section and print all of
     them above all of the blocks, so a caveat written between example one and
     example two appeared above example one and read as a statement about it.
     scripts/passport-to-page.py kept the order and this file did not, on the
     same passport, which made the hosted page and the page the owner mails out
     say different things. Both walk this list now. */
  const goldenParts = sectionParts(sectionLines(body, '## 4. Golden examples')).parts;
  const goldenCount = goldenParts.filter(p => p.kind === 'block').length;
  const lossLines = sectionLines(body, '## 6. Losses');
  const needs = row.needs || [];

  /* Sections 2 and 6 carry prose beside their tables, and it was being dropped:
     the renderer called sectionProse for section 4 alone. That is the same
     failure class the note above sectionProse documents, one section over. The
     example passport's section 2 ends "This agent's original could send mail.
     This install will not, and nothing in the install will attempt it." — a
     sentence about what the agent is NOT allowed to do, on a page whose entire
     subject is what it is allowed to do. Section 6's prose is the owner's own
     description of a table that may be empty.

     Sections 1, 3 and 5 have no such gap: 1 is the summary, which page 2 prints
     in full, 3 is the functional spec, which the install block carries verbatim
     to the recipient's assistant, and 5 is the installer itself. Every section
     of the file now reaches either this page or that block. */
  const consentProse = sectionProse(sectionLines(body, '## 2. What it needs from you'));
  const lossProse = sectionProse(lossLines);
  const ownersWords = (label, paras) => paras.length
    ? `<div class="observations"><span class="lbl">${label}</span>` +
      paras.map(p => '<p>' + inline(p) + '</p>').join('') + '</div>'
    : '';

  /* Counted off the booleans, and that stays right. A count is arithmetic over
     a field the derivation parsed from the passport, not a sentence put in the
     passport's mouth; the defect next door was printing invented words as if
     the owner had written them. "declared only" here is this page's own label
     for a count, and the rows it counts print their own wording.

     The declared-only count used to be computed here and printed as a third
     number in a sentence under the stamps. It is now one of the three groups
     in the "what you will need" block, counted there off the same boolean, so
     the arithmetic did not move, only where the reader meets it. */
  const installable = needs.filter(n => n.installable).length;
  const lossCount = tableRows(lossLines).data.length;
  const counts = { capabilities: needs.length, installable, losses: lossCount };

  /* ── the listed path ──────────────────────────────────────────────────────
     A listed passport differs from an unlisted one in four places and nowhere
     else, and the unlisted output is BYTE-IDENTICAL to what this file produced
     before the gallery branch, apart from the topbar's Gallery link and the
     footer's cookie sentence. That is not a preference: the endpoint suite
     diffs an unlisted render against the pre-branch one, so every addition
     below is inside a conditional that produces the empty string, including the
     newlines. Do not add an unconditional line to this function.

     row.gallery is { category, listed_at } when listed, and null or undefined
     otherwise; every reader treats undefined as null. row.votes is attached by
     passport.mjs from the votes-count store before it calls this. */
  /* SHAPE-TESTED, NOT TRUTH-TESTED. `{}`, `[]` and 'other' are all truthy, and
     each one rendered a listed page: no noindex, "does not expire", the vote
     control, a listed line with no category and no date, while an expires_at
     beside it still named a day. Spec §2 invariant 1 says the store never
     writes that shape, so this is the page refusing to trust that rather than
     a live bug. A listing is one whose category is a real slug and whose
     listed_at is an ISO day; anything else is unlisted here, which is the
     safer wrong answer. The date takes the same shape test the card uses in
     _gallery-render.mjs, so the two surfaces read one field one way. */
  const gallery = listingOf(row);
  const listedCategory = gallery ? categoryLabel(gallery.category) : '';
  const listedDate = gallery ? esc(String(gallery.listed_at).slice(0, 10)) : '';
  const votes = row.votes || { up: 0, down: 0 };
  /* The vote control is skipped rather than rendered empty for the specimen and
     for anything whose id is not a uuid: voteControl refuses those itself, and
     a listed line with no control under it is better than a form posting an id
     the endpoint will refuse. */
  const voteHtml = gallery ? voteControl(id, votes.up, votes.down, false) : '';

  const strip = mrz(row, counts);
  const purpose = purposeLine(row, body);
  const validated = esc(String(row.validated_at).slice(0, 10));
  const isSpecimen = id === 'example';

  const seen = Number(row.views || 0);
  const presented = seen === 0 ? 'first presentation'
    : seen === 1 ? 'presented once before this'
    : 'presented ' + seen + ' times before this';

  /* Page 4. One row per capability of the consent table, and one stamp per row,
     saying exactly what that row says. The tilt is two to four degrees, taken
     from the row's position so it is stable across reloads rather than random.
     A passport with a capability nobody will install carries a stamp in the
     refusal colour, on the page, where it cannot be missed. */
  const TILTS = ['-3.1deg', '2.4deg', '-1.9deg', '3.4deg', '-2.6deg', '1.8deg'];
  const permits = needs.map((n, i) => {
    const tilt = TILTS[i % TILTS.length];
    const stampClass = n.installable ? 'stamp' : 'stamp no';
    /* Granted / Not granted is this page's own term, defined in the note under
       the stamps, and it is read off the boolean. Everything else here is the
       passport's own wording and is never composed: why, in _derive.mjs.

       The stamp is a fixed-size object: base.css gives .permit a 176px stamp
       column and .stamp .s2 white-space: nowrap, which leaves the sub-line
       about 148px, and the land keyframe scales the whole thing 1.6x on entry.
       required_label is passport text with no cap on it anywhere: _validate.mjs
       limits the file to 256 KB, _derive.mjs limits the table to 24 rows
       (E_DERIVE_NEEDS), and no cell to anything, so "optional, but the brief
       is thin without it" put forty-one characters into a cell built for
       twenty and grew the stamp leftwards
       across the prose it sits beside. The stamp therefore carries a CLIPPED
       echo, and the passport's full wording prints as prose in the same
       treatment installable_label already had. Nothing unbounded reaches .s2.

       A row stored before the derivation carried the labels has neither, and
       both lines are then omitted rather than worded. Omitting is the honest
       failure here and inventing is not: the old derivation computed a
       declared-only flag and stored only `required`, so a declared-only
       capability comes back as required:false, and "Optional" printed from
       that boolean would put a word in the owner's mouth that contradicts the
       install block further down the same page. The stamp's own Granted /
       Not granted still shows, because that term is this page's, defined here,
       and read off a boolean that means what it says. */
    /* THE ENVELOPE FLOOR IS NOT ENFORCED HERE, ON PURPOSE, and this note is the
       whole of the change this file took for it. The 2026-08-19 audit named
       this line and the buckets below as two of the five surfaces where a write
       capability could reach a reader stamped "Granted". Both are pure
       functions of `n.installable`; neither decides anything. _validate.mjs and
       _derive.mjs refuse the passport before it is stored
       (upload-validation.md 4.6 and 6.3) and tools/validate.py check 16 refuses
       it before it is ever uploaded.

       BE PRECISE ABOUT WHAT THAT BUYS, because the first draft of this note
       was not. It said the record "cannot carry installable: true on a
       declared-only capability any more", and that is false: it cannot carry
       one WHOSE ID THE DERIVATION COULD SEE, which means the backticked rows
       only. A consent row that names a write capability in prose still derives
       to installable:true and still stamps "Granted" here, because nothing in
       the format links that row to an id. A passport doing exactly that was
       built and stored. The renderer is not wrong to stamp it; it has no id to
       go on. The floor is upstream and partial, and this file cannot make it
       whole.

       Enforcing it a second time here was considered and is wrong. A page that
       overrode the stored boolean would print "Not granted" beside
       `installable_label`, which is the passport's own word "yes" echoed
       verbatim two lines down, and the note above on required_label is about
       exactly that class of self-contradiction. This file renders a document
       faithfully; refusing a document is the endpoint's job. If a stored
       passport predating the floor ever renders "Granted" on a write row, the
       fix is to re-derive or delete that record, not to make this line lie
       about what the file says.

       The claim in the footer above ("Anything that writes to the world is
       listed and marked not installable") is what the floor makes true. It was
       on the page before there was anything holding it up. */
    const stampText = n.installable ? 'Granted' : 'Not granted';
    /* Sixteen, measured on the rendered page rather than counted off the CSS.
       The stamp column is 176px. At 20 characters the worst case above came
       out 173px wide, three pixels of headroom, which is not headroom. At 16
       it is 142px, the same width the longest real label ("declared only",
       thirteen characters) already produces, so the clip only ever fires on
       wording no consent column was built for. */
    const stampSub = n.required_label ? clip(n.required_label, 16) : '';
    return `<div class="permit">
      <div>
        <p class="cap">${esc(n.capability)}${n.ref ? '<span class="ref">' + esc(n.ref) + '</span>' : ''}</p>
        <p class="why">${inline(n.why)}</p>
        ${n.required_label
          ? `<p class="ifskip">${esc(REQ_COLUMN)}: ${inline(n.required_label)}</p>`
          : ''}
        <p class="ifskip">If you skip it: ${inline(n.if_skipped)}</p>
        ${n.installable_label
          ? `<p class="ifskip">Installable in v0.1: ${inline(n.installable_label)}</p>`
          : ''}
      </div>
      <span class="${stampClass}" style="--tilt:${tilt}">
        <span class="s1">${esc(stampText)}</span>${
          stampSub ? '<span class="s2">' + esc(stampSub) + '</span>' : ''}
      </span>
    </div>`;
  }).join('');

  /* Page 4, above the stamps: what the recipient has to have ready before they
     start, scannable in one look.

     Three buckets, and the split is by `installable` FIRST, not by `required`.
     That order matters and it is not cosmetic. A declared-only capability
     comes back from the derivation as required:false, and the note above the
     stamps records why: an older derivation stored only the boolean, so
     bucketing on `required` alone would file "Send email, declared only" under
     Optional and contradict the stamp sitting beside it. Anything that will
     not be installed goes in the third bucket whatever its requirement cell
     says, and the row underneath still prints that cell verbatim.

     Nothing here is composed. The bucket names and the counts are this page's
     own, the same way "Granted" is; every capability is the owner's own cell
     text, printed as a list item so no sentence is ever assembled out of
     someone else's words. */
  const BUCKETS = [
    { k: 'req', label: 'required',      pick: n => n.installable && n.required },
    { k: 'opt', label: 'optional',      pick: n => n.installable && !n.required },
    { k: 'no',  label: 'declared only', pick: n => !n.installable }
  ];
  const reqsHtml = BUCKETS.map(b => {
    const rows = needs.filter(b.pick);
    if (!rows.length) return '';
    return `<div class="rq ${b.k}">
      <p class="rl"><span class="c">${esc(String(rows.length))}</span>${esc(b.label)}</p>
      <ul>${rows.map(n => '<li>' + esc(n.capability) + '</li>').join('')}</ul>
    </div>`;
  }).join('');

  const tabs = PLATFORMS.map((p, i) =>
    '<button class="tab" type="button" role="tab" id="tab-' + esc(p.key) + '" data-key="' + esc(p.key) +
    '" aria-controls="platform-panel" aria-selected="' + (i === 0) + '" tabindex="' + (i === 0 ? '0' : '-1') + '">' +
    esc(p.label) + '</button>').join('');

  const goldenHead = goldenCount === 1
    ? 'One golden example, copied from the passport.'
    : goldenCount + ' golden examples, copied from the passport.';

  /* Consecutive paragraphs share one .body wrapper so the 16px rhythm between
     them stays tighter than the 12px stack gap that separates prose from the
     block it belongs to. */
  const goldenHtml = goldenParts.reduce((out, p) => {
    if (p.kind === 'block') { out.push('<div class="blockbox tall">' + esc(p.text) + '</div>'); return out; }
    const last = out[out.length - 1];
    const para = '<p>' + inline(p.text) + '</p>';
    if (last && last.startsWith('<div class="body">')) {
      out[out.length - 1] = last.slice(0, -6) + para + '</div>';
    } else {
      out.push('<div class="body">' + para + '</div>');
    }
    return out;
  }, []).join('');

  const ogTitle = esc(row.title) + ' · Agent Passport';
  const ogDesc = esc(clip(row.summary, 180));

  return `<!DOCTYPE html>
<html lang="en">
<head>
${HEAD_COMMON}
<title>${esc(row.title)} · Agent Passport</title>
${/* A listed passport is indexable: its owner put it in a public gallery and
   asked for it to be found. An unlisted one keeps the tag, and so does the
   404, so a not-found page stays indistinguishable from a private one.
   passport.mjs drops x-robots-tag on the same condition; a meta tag saying
   index under a header saying noindex would be the header winning silently.
*/''}${gallery ? '' : '<meta name="robots" content="noindex, nofollow">\n'}<meta name="description" content="${ogDesc}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Agent Passport">
<meta property="og:title" content="${ogTitle}">
<meta property="og:description" content="${ogDesc}">
<meta property="og:url" content="${esc(origin)}/p/${esc(id)}">
<meta property="og:image" content="${esc(origin)}/og/${esc(id)}.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="An Agent Passport cover: the Phaeacia mark, the document type, and two entry stamps reading granted and not granted.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${ogTitle}">
<meta name="twitter:description" content="${ogDesc}">
<meta name="twitter:image" content="${esc(origin)}/og/${esc(id)}.png">
<meta name="twitter:image:alt" content="An Agent Passport cover: the Phaeacia mark, the document type, and two entry stamps reading granted and not granted.">
${/* After base.css, and only on this route. The recipient page is the only
   page that renders the artefact, so its layer lives in its own file rather
   than in the shared stylesheet.
*/''}
<link rel="stylesheet" href="/assets/recipient.css">
</head>
<body>

<a class="skip" href="#main">Skip to content</a>
<a class="skip" href="#install">Skip to the install block</a>

${TOPBAR}

<main id="main">
<div class="wrap">

  ${/* The artefact is section 00 of this page, on the same rail and the same
     left edge as every section under it. It used to sit 200px to the left of
     the prose that discusses it and be centred in neither.
  */''}
  <section class="sec doc-sec first">
    <div class="rail"><span class="num">00</span><span class="label">The document</span></div>
    <div class="col">

    ${/* The route to the install block, from the top, because that is the
       action the whole page exists to produce. A recipient who already knows
       what this is should not have to scroll past a document to reach it.
       #install is a real section with tabindex="-1", so the jump moves focus
       as well as the viewport and a keyboard user lands on the picker.
    */''}
    <div class="jumprow">
      <p class="eyebrow brass">Passport · spec ${esc(row.passport_version)} · checked ${validated}</p>
      <a class="btn jumpbtn" href="#install">Install this agent
        <span class="sub">pick your assistant, copy one block</span></a>
    </div>${gallery ? `

    ${/* The listed line and the vote control. Both are inside one conditional
       template so that an unlisted render adds not one character here, which
       is what the endpoint suite's byte diff checks. No `back` field: the
       endpoint sends a scriptless vote from this page back to this page. */''}
    <div class="galleryline">
      <p class="glabel">In the gallery${listedCategory ? ' under ' + esc(listedCategory) : ''}${listedDate ? ', listed ' + listedDate : ''}.
        <a class="textlink" href="/gallery">See the rest of it</a></p>
      ${voteHtml}
    </div>` : ''}

    <div class="docwrap">
    <article class="doc">

      ${/* page 1 ─ cover ─────────────────────────────────────────── */''}
      <section class="page cover" aria-labelledby="bearer-name">
        <div class="cover-top">
          <span class="cover-mark">${MARK}<span class="w">Phaeacia</span></span>
          <span class="cover-type">Type ${esc(envClass(row.envelope))} &middot; ${esc(row.envelope)}<br>Page 1 of 4</span>
        </div>
        <div class="cover-titlewrap">
          <p class="cover-title">Agent<br>Passport</p>
          ${isSpecimen ? '<p class="specimen">Specimen</p>' : ''}
        </div>
        <div class="cover-foot">
          <span class="lbl">Bearer</span>
          <h1 id="bearer-name">${esc(row.title)}</h1>
          <span class="idr">${esc(row.name)}</span>
          ${/* Purpose is a field a real travel document carries, so the one
             line that says what the agent does can sit on the cover without
             the artefact stopping being a passport played straight. Quoted,
             never composed: see purposeLine above. The provenance line under
             it is there so nobody can read this as the site's summary of
             someone else's agent.
          */''}
          ${purpose ? `<div class="cover-purpose">
            <span class="lbl">Purpose</span>
            <p class="pv">${inline(purpose.text)}</p>
            <span class="src">${purpose.source}</span>
          </div>` : ''}
        </div>
      </section>

      ${/* page 2 ─ the bearer ────────────────────────────────────── */''}
      <section class="page" aria-labelledby="pg-bearer">
        <div class="page-head">
          <h2 class="pt" id="pg-bearer">The bearer</h2>
          <span class="folio">Page 2 of 4</span>
        </div>
        <div class="bearer-grid">
          <div class="portrait">
            ${MARK}
            <span class="np">No portrait<br>Software bearer</span>
          </div>
          <div>
            <dl class="fields">
              <div><dt>Name</dt><dd>${esc(row.name)}</dd></div>
              <div><dt>Title</dt><dd>${esc(row.title)}</dd></div>
              <div><dt>Issued</dt><dd>${esc(row.created)}</dd></div>
              ${/* A real passport carries a date of expiry, and so does this
                 link. The wording says LINK rather than "valid until",
                 because what expires is the page: the file the owner holds
                 does not stop being true on a date we picked.
              */''}
              <div><dt>Link expires</dt><dd>${
                /* The gallery branch is FIRST, because a listed row has a null
                   expires_at and would otherwise fall through to "Not set",
                   which is true of the field and wrong about the passport.
                   This comment is inside the expression, not beside it: a
                   ${''} block on its own line adds that line's indentation and
                   newline to the output, which would break the byte-identity
                   the unlisted path is held to. */
                gallery ? 'Listed in the gallery, does not expire'
                : row.expires_at ? esc(String(row.expires_at).slice(0, 10))
                : isSpecimen ? 'Never, it is the specimen'
                : 'Not set'
              }</dd></div>
              <div><dt>Capture path</dt><dd>${esc(row.capture_path)}</dd></div>
              <div><dt>Envelope</dt><dd>${esc(row.envelope)}</dd></div>
              <div><dt>Source stack</dt><dd>${esc(row.source_stack)}</dd></div>
              <div><dt>Scrub</dt><dd>${esc(row.scrub)}</dd></div>
              <div><dt>Signed by owner</dt><dd>${row.owner_confirmed ? 'Confirmed this description' : 'Did not confirm this description'}</dd></div>
            </dl>
            ${/* Source stack stays, and stays labelled. It is the environment
               the ORIGINAL ran in, which a recipient can neither check nor
               reproduce, and read as an instruction it is actively wrong: a
               rebuild happens inside the recipient's own assistant, on
               whatever that platform provides. It is provenance, so it keeps
               its row in the record and on the page, with one line saying
               which of the two it is.
            */''}
            <p class="fieldnote">Source stack is where this agent ran before it was captured. Your rebuild
            does not need it, and nothing in the install tries to reproduce it.</p>
            ${/* The full summary, unabridged. The cover leads with one line of
               it, or with the owner's stated goal; this is where the rest of
               the owner's own description stays available.
            */''}
            <div class="observations">
              <span class="lbl">Observations</span>
              <p>${inline(row.summary)}</p>
            </div>
          </div>
        </div>
      </section>

      ${/* page 3 ─ the machine-readable zone ─────────────────────── */''}
      <section class="page" aria-labelledby="pg-mrz">
        <div class="page-head">
          <h2 class="pt" id="pg-mrz">The machine-readable zone</h2>
          <span class="folio">Page 3 of 4</span>
        </div>
        <div class="mrz">${strip.lines}</div>
        ${/* The strip is the best detail in the design and it does not need to
           be studied. One line of what it is, and the field-by-field legend
           folded away behind a disclosure, so reading it is an offer rather
           than homework. The legend itself is unchanged, and so are the real
           check digits it explains.
        */''}
        <p class="mrzcap">The real passport format, with real check digits, computed from this file.</p>
        <details class="mrzkey">
          <summary>Read it field by field</summary>
          <div class="decode">${strip.legend}</div>
          <p class="permit-note"><span class="m">Two lines of 44, in the ICAO 9303 TD3 field positions, with
          check digits computed on the 7-3-1 weighting. Every value is read off this passport. An agent has
          no nationality and no date of birth, so those positions carry the capture path and the date this
          file was checked instead, and the legend above says which is which.</span></p>
        </details>
      </section>

      ${/* page 4 ─ entry permissions ─────────────────────────────── */''}
      <section class="page" aria-labelledby="pg-permits">
        <div class="page-head">
          <h2 class="pt" id="pg-permits">Entry permissions</h2>
          <span class="folio">Page 4 of 4</span>
        </div>
        <div class="reqs">
          <p class="reqs-h">What you will need</p>
          <div class="reqs-grid">${reqsHtml}</div>
          <p class="reqs-note">Each one is an account or a permission on your own platform, and you grant
          it yourself when your assistant asks. This passport carries no credentials, and nothing is
          granted by reading this page. Declared only means the original agent had it and version 0.1
          will not install it.</p>
        </div>
        <div class="permits">${permits}</div>
        ${ownersWords('In the owner&rsquo;s words', consentProse)}
        <p class="permit-note"><span class="m">Granted means version 0.1 will install that capability.
        Not granted means it is named here, and left out, so you can see what the original could do that
        your copy will not.</span></p>
      </section>

      ${/* ── the declaration, and why it is no longer a page ──────────────
         Product rule 3 is that the losses table always renders, even when
         empty. That rule is about the INSTALL: step 8 of installer/core.md,
         which runs inside the recipient's own assistant and fills the table
         in. On THIS page the table is necessarily empty, because nothing has
         been installed yet, and a full numbered page whose content is a
         promise is an empty page with a folio on it. The page is gone. Rule
         3 is untouched and still renders where it was always meant to.
         
         What stays is the statement, small and unmissable, at the foot of
         the artefact: the install ends with a written list of what
         transferred, what was substituted and what was lost. The owner's own
         prose about their losses table stays with it, because that is real
         passport content.
         
         lossCount still feeds the machine-readable zone, unchanged, and a
         passport that genuinely carries loss rows still prints them: that is
         the owner's declared content rather than an empty promise, and
         dropping it would be the opposite failure.
      */''}
      <aside class="docnote" aria-labelledby="pg-decl">
        <div class="page-head">
          <h2 class="pt" id="pg-decl">Declaration</h2>
          <span class="folio">Filled in during your install</span>
        </div>
        <p class="dn">Your install ends with a written list: what transferred, what was substituted, and
        what was lost. Your own assistant fills it in and shows it to you as the last thing it does. It is
        shown even when nothing was lost, so a clean move looks deliberate rather than unreported.</p>
        ${lossCount ? mdTable(lossLines, '') : ''}
        ${ownersWords('In the owner&rsquo;s words', lossProse)}
        <p class="signature">
          <span>Declared by the owner &middot; not inferred</span>
          <span class="r">${lossCount
            ? esc(String(lossCount)) + (lossCount === 1 ? ' entry' : ' entries')
            : 'Nothing declared yet'}</span>
        </p>
      </aside>

    </article>

    <p class="doc-foot">
      <span>Checked ${validated} against rules ${esc(row.validator_version)}</span>
      <span>${esc(presented)}</span>
    </p>
    </div>

    ${isSpecimen ? `<div class="callout quiet">
      <p class="t">This one is a specimen</p>
      <p>This is the repository's own example passport, kept so there is always something real to open.
      Its golden example is synthetic: it was written to exercise the format, not captured from a run,
      and section 4 of the file says so in its own words below. Everything else on these four pages is
      derived from the file exactly as an uploaded passport would be.</p>
    </div>` : ''}

    </div>
  </section>

  <section class="sec">
    <div class="rail"><span class="num">01</span><span class="label">Evidence</span></div>
    <div class="col">
      <h2>${esc(goldenHead)}</h2>
      <p class="lede">Golden examples are what the passport offers as evidence that the agent does what
      it says. Your rebuild is checked against these. This site checked the file's format, not the truth
      of its examples.</p>
      <div class="stack" style="gap:12px">
        ${goldenHtml}
      </div>
    </div>
  </section>

  <section class="sec" id="install" tabindex="-1" aria-labelledby="install-h">
    <div class="rail"><span class="num">02</span><span class="label">Install</span></div>
    <div class="col">
      <h2 id="install-h">Pick where you are installing, then paste the block into that assistant.</h2>
      <p class="lede">You get one branch, not all four. The other options stay available if you picked
      wrong.</p>
      <div class="picker">
        <div class="tablist" role="tablist" aria-label="Install platform">${tabs}</div>
        <div class="tabpanel" role="tabpanel" id="platform-panel" aria-labelledby="tab-chatgpt" tabindex="0">
          <p class="plat" id="plat-note"></p>
          <div class="blockbox tall" id="plat-block">Building the block for this platform.</div>
          <div><button class="btn" id="copy-block" type="button">Copy block</button></div>
          <p class="next" id="plat-next"></p>
        </div>
      </div>
    </div>
  </section>

</div>
</main>

${footer('Passport ' + esc(row.passport_version) + ' · checked ' + validated + ' by rules ' + esc(row.validator_version) + ' · ' + esc(presented))}

<script>
window.__BODY = ${jsonScript(body)};
window.__PLATFORMS = ${jsonScript(PLATFORMS)};
</script>
<script src="/assets/site.js"></script>
<script src="/assets/passport.js"></script>
${gallery ? '<script src="/assets/gallery.js"></script>\n' : ''}</body>
</html>`;
}
