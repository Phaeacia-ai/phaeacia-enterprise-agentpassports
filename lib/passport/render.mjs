/* Private rendering of a stored passport, a release and a company catalog.

   DERIVED FILE. Body rendering copied from vendor/passport/web/lib/_render.mjs
   at the pinned upstream revision (upstream.lock.json), source SHA-256
   3e3a5595b974526abf2dce84dd5d4fff8a2bdefebacbfce0f2086dae48517f97, and
   registered in the lock's `derived` list so that verify mode fails when the
   upstream source or these bytes change (adapter section 4, invariant R3).
   Contract: docs/e1/passport-adapter.md section 5. Upstream code is Apache-2.0
   with a NOTICE (vendor/passport/LICENSE, vendor/passport/NOTICE).

   Everything that reaches HTML is escaped here, unconditionally, as upstream
   does (upload-validation.md section 5.1: the HTML gate is a gate, not a
   substitute for escaping). The public shell is REMOVED rather than switched
   off: the topbar and footer with their Gallery, Delete and Manage links,
   every Open Graph and Twitter meta, the canonical origin, the vote control
   and listing state, the view counter, the link expiry, the specimen branch,
   the platform picker, the inline theme script, /assets/site.js and
   /assets/passport.js, and the window-global handoff of the body and the
   platform list, because the install block is never assembled in the browser:
   a release page renders the frozen assembled content the caller passes in,
   and a stored passport renders section 5 as the placeholder note. The head
   carries the robots meta (noindex, nofollow) as a supplement to the private
   response headers, never as access control.

   Helper inventory, one line each, with provenance (critique A5):
     esc, clip                       copied from _render.mjs:31-32, 215-221
     cells, inline, tableRows,
     mdTable                         copied from _render.mjs:223-275, then
                                     corrected here after the E1b critique (H1,
                                     evidence/e1-render-critique.md): tableRows
                                     reads only table rows outside fences
                                     (FENCE and TABLE_ROW_MD imported from the
                                     sections module), cells keeps an escaped
                                     pipe as cell content, inline keeps a code
                                     span literal. The vendored originals are
                                     unchanged; the divergence is deliberate
                                     because this reader now decides the
                                     enterprise loss state, count and rows
     sectionLines, sectionProse      copied from _render.mjs:136-139; the slicers
                                     sliceSection (sectionLines) and sectionParts
                                     and the constants they read (FENCE,
                                     SECTION_BOUNDARY, ANY_HEADING, the WS
                                     classes) are IMPORTED from the vendored
                                     runtime subset, never copied
     goalValue, firstSentence,
     purposeLine                     copied from _render.mjs:174-209
     ownersWords                     copied from inside renderPassport,
                                     _render.mjs:601-604, hoisted; the label is
                                     passed as text and escaped here
     MRZ_SET, checkDigit, mrzPad,
     mrzClean, mrzWords, pad2,
     envClass, pathCode, mrzLines,
     mrz                             copied from _render.mjs:287-370
     REQ_COLUMN                      copied from _render.mjs:397
     BRANCH_LABELS                   the key and label columns of PLATFORMS,
                                     _render.mjs:399-412; the note and next
                                     columns are public-site copy and are dropped
     MARK                            copied from _render.mjs:416
     head()                          rewritten from HEAD_COMMON, _render.mjs:418-432:
                                     favicon links to files outside the import,
                                     the inline theme script and the absolute
                                     asset paths are removed; assets resolve
                                     under the caller's assetBase
     renderPassportPage              derived from renderPassport, _render.mjs:571-1123
     renderLosses                    new: the three-state table of section 5
     renderReleasePage,
     renderCatalogPage               new, enterprise pages built from the same helpers
   Removed: UUID, voteControl, jsonScript, ogInputs, TOPBAR, footer,
   renderNotFound, the CANONICAL re-export, listingOf, categoryLabel.

   Pure functions over plain objects returning HTML strings. No IO, no
   network, no child process, nothing read from disk: a release page renders
   the frozen assembled content passed in, never fetched. */

import {
  FENCE,
  TABLE_ROW_MD,
  sectionLines as sliceSection,
  sectionParts,
} from '../../vendor/passport/web/lib/_sections.mjs';

export const SOURCE_SHA256 = '3e3a5595b974526abf2dce84dd5d4fff8a2bdefebacbfce0f2086dae48517f97';

/* Fixed enterprise wording. The losses table renders in every state; which
   row it shows is the truthful state of section 6 (adapter section 5). */
export const LOSSES_PENDING = 'Not installed yet; losses not assessed';
export const LOSSES_DECLARED_LABEL = 'Declared by the owner, not inferred';
export const DECLARED_NOT_INSTALLED = 'declared, not installed';
/* The label over the owner's own section 6 prose. The prose is passport
   content written before any install, so it carries the declared label
   itself; the state line below the table names the table's state only. On
   the SYNTHETIC fixture, whose section 6 holds a sentence and an empty
   template, both therefore appear: the pending state line and this label
   over the sentence (adapter section 5, decided after the E1b critique). */
export const OWNERS_WORDS_LABEL = 'In the owner’s words · declared by the owner, not inferred';
export const PLACEHOLDER_NOTE =
  'No release yet. Section 5 of the stored passport is the placeholder line below; ' +
  'the installer text is inserted at publication and frozen with the release.';

/* ---------- copied helpers ---------- */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

const sectionLines = (body, heading) => sliceSection(body.split('\n'), heading);

const sectionProse = (lines) =>
  sectionParts(lines)
    .parts.filter((p) => p.kind === 'prose')
    .map((p) => p.text);

/* Reads goal.value out of the section 3 fence. Deliberately narrow: a
   top-level `goal:` mapping, then a `value:` on the next indent level, a
   single-line scalar only. */
function goalValue(body) {
  const blocks = sectionParts(sectionLines(body, '## 3. Functional spec')).parts.filter((p) => p.kind === 'block');
  for (const b of blocks) {
    const lines = b.text.split('\n');
    const at = lines.findIndex((l) => /^goal:\s*$/.test(l));
    if (at < 0) continue;
    for (let i = at + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break;
      const m = lines[i].match(/^\s{1,4}value:[ \t]*(.*)$/);
      if (!m) continue;
      const v = m[1]
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2')
        .trim();
      if (!v || /^[|>][-+0-9]*$/.test(v)) return '';
      return v.length <= 200 ? v : '';
    }
  }
  return '';
}

function firstSentence(s) {
  const t = String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .trim();
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

export function clip(s, n) {
  const t = String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > n * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

/* One table row into cells. Corrected from the copy (H1): a pipe escaped
   with a backslash is cell content and renders as a pipe; `\\\\` is kept as
   written and consumed as a pair so the pipe after it is a delimiter. The
   copied version split on every pipe, so `Left \\| right` became four cells and
   shifted the status and meaning columns. */
function cells(row) {
  const s = row.trim();
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (ch === '\\' && s[i + 1] === '\\') {
      cur += '\\\\';
      i += 1;
    } else if (ch === '|') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  if (out.length > 1 && s.startsWith('|')) out.shift();
  if (out.length > 1 && out[out.length - 1].trim() === '') out.pop();
  return out.map((c) => c.trim());
}

/* Inline Markdown, deliberately tiny: bold, italic and code. Escapes first,
   then re-introduces the three constructs. A link renders as its label
   followed by the visible URL; nothing on these pages is clickable out to
   another host, and only http(s) and mailto are read as links at all. */
/* Corrected from the copy (H1): a code span is lifted out before the bold,
   italic and link passes and put back afterwards, so `**literal**` inside
   backticks keeps its asterisks. The copied version formatted inside code.
   The placeholder is U+0000, which the pinned transport() refuses in a
   passport body and which is not renderable text, so any stray NUL in a
   caller-supplied string (an installation record) is dropped first. */
export function inline(s) {
  const spans = [];
  let t = esc(String(s == null ? '' : s).replace(/\u0000/g, ''));
  t = t.replace(/`([^`]+)`/g, (_, c) => {
    spans.push(c);
    return `\u0000${spans.length - 1}\u0000`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`);
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, (_, p, c) => `${p}<em>${c}</em>`);
  t = t.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g,
    (_, label, href) => `${label} <span class="rawlink">${href}</span>`,
  );
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${spans[Number(i)]}</code>`);
}

/* The table rows of a section: only lines that are table rows OUTSIDE a
   fenced block, under the same fence rule the section slicer and the pinned
   gate use (FENCE from the sections module: a fence closes on a run at least
   as long as the one that opened it). Corrected from the copy (H1), which
   collected every pipe-prefixed line including those quoted inside a fence,
   so a fenced example table after the empty template became three declared
   rows. This is the ONE reading behind lossesState, the rendered rows, the
   declared count and the catalog count. */
export function tableRows(lines) {
  const rows = [];
  let fence = 0;
  for (const l of lines) {
    const m = l.match(FENCE);
    if (m) {
      if (!fence) fence = m[1].length;
      else if (m[1].length >= fence) fence = 0;
      continue;
    }
    if (!fence && TABLE_ROW_MD.test(l)) rows.push(l);
  }
  if (rows.length < 2) return { header: [], data: [] };
  return {
    header: cells(rows[0]),
    data: rows
      .slice(2)
      .map(cells)
      .filter((c) => c.some((x) => x !== '')),
  };
}

export function mdTable(lines, emptyNote) {
  const { header, data } = tableRows(lines);
  if (!header.length || !data.length) return `<p class="caption">${esc(emptyNote)}</p>`;
  return `<div class="scroll"><table><thead><tr>${header.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${data
    .map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? '' : ' class="dim"'}>${inline(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

const ownersWords = (label, paras) =>
  paras.length
    ? `<div class="observations"><span class="lbl">${esc(label)}</span>${paras.map((p) => `<p>${inline(p)}</p>`).join('')}</div>`
    : '';

/* The machine-readable zone: ICAO 9303 7-3-1 weighting, two lines of 44. */
const MRZ_SET = (c) => (c === '<' ? 0 : /[0-9]/.test(c) ? Number(c) : c.charCodeAt(0) - 55);
function checkDigit(s) {
  const w = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += MRZ_SET(s[i]) * w[i % 3];
  return String(sum % 10);
}
const mrzPad = (s, n) => (s + '<'.repeat(Math.max(0, n))).slice(0, n);
const mrzClean = (s) =>
  String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
const mrzWords = (s) =>
  String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '<')
    .replace(/^<|<$/g, '');
const pad2 = (n) => String(Math.max(0, Math.min(99, Number(n) || 0))).padStart(2, '0');
const envClass = (e) => (String(e || '').toLowerCase() === 'read-notify' ? 'A' : 'X');
const pathCode = (p) =>
  String(p || '').toLowerCase() === 'file' ? 'F' : String(p || '').toLowerCase() === 'browser' ? 'W' : 'X';

function mrzLines(row, counts) {
  const type = `P${envClass(row.envelope)}`;
  const issuer = 'PHA';
  const name = mrzPad(`${mrzWords(row.name)}<<${mrzWords(row.title)}`, 39);
  const l1 = type + issuer + name;

  const docNum = mrzPad(mrzClean(row.name), 9);
  const docChk = checkDigit(docNum);
  const issued = mrzPad(mrzClean(row.created).slice(2, 8), 6);
  const issChk = checkDigit(issued);
  const path = pathCode(row.capture_path);
  const checked = mrzPad(mrzClean(String(row.validated_at).slice(0, 10)).slice(2, 8), 6);
  const chkChk = checkDigit(checked);
  const optional = mrzPad(
    `V${mrzPad(mrzClean(row.passport_version), 2)}C${pad2(counts.capabilities)}I${pad2(counts.installable)}L${pad2(counts.losses)}${row.owner_confirmed ? 'Y' : 'N'}`,
    14,
  );
  const optChk = checkDigit(optional);

  const stem = docNum + docChk + issuer + issued + issChk + path + checked + chkChk + optional + optChk;
  const composite = checkDigit(stem.slice(0, 10) + stem.slice(13, 20) + stem.slice(21, 43));
  const l2 = stem + composite;

  return {
    l1,
    l2,
    type,
    issuer,
    name,
    docNum,
    docChk,
    issued,
    issChk,
    path,
    checked,
    chkChk,
    optional,
    optChk,
    composite,
  };
}

function mrz(row, counts) {
  const {
    l1,
    l2,
    type,
    issuer,
    name,
    docNum,
    docChk,
    issued,
    issChk,
    path,
    checked,
    chkChk,
    optional,
    optChk,
    composite,
  } = mrzLines(row, counts);

  const legend = [
    ['L1 1-2', type, `Document type. P for passport, ${envClass(row.envelope)} for the ${row.envelope} envelope.`],
    ['L1 3-5', issuer, 'Issuing authority. This service checked the format and stored the file.'],
    ['L1 6-44', name, 'The name field: the identifier, then the title, split by a double filler.'],
    ['L2 1-10', docNum + docChk, 'The identifier, and its check digit.'],
    [
      'L2 11-13',
      issuer,
      'Issuing authority again, where a passport carries the bearer’s nationality. An agent has none.',
    ],
    ['L2 14-20', issued + issChk, `Issued ${row.created}, and its check digit.`],
    ['L2 21', path, `Capture path: ${row.capture_path}.`],
    ['L2 22-28', checked + chkChk, `Checked ${String(row.validated_at).slice(0, 10)}, and its check digit.`],
    [
      'L2 29-43',
      optional + optChk,
      `Spec version, ${counts.capabilities} capabilities, ${counts.installable} installable, ${counts.losses} losses declared, owner ${row.owner_confirmed ? 'confirmed' : 'did not confirm'}.`,
    ],
    [
      'L2 44',
      composite,
      'Composite check digit over positions 1-10, 14-20 and 22-43. Positions 11-13, 21 and 44 are excluded, as ICAO 9303 excludes them.',
    ],
  ];

  return {
    lines: `<span>${esc(l1)}</span><span>${esc(l2)}</span>`,
    legend: legend
      .map(
        ([pos, val, note]) =>
          `<div><span class="pos">${esc(pos)}</span><span class="v">${esc(val)}</span><span class="k">${esc(note)}</span></div>`,
      )
      .join(''),
  };
}

const REQ_COLUMN = 'Requirement';

/* Branch keys and their labels, the key and label columns of the upstream
   PLATFORMS list. A release names exactly one of these. */
export const BRANCH_LABELS = Object.freeze({
  chatgpt: 'ChatGPT',
  'claude-ai': 'claude.ai',
  'claude-code': 'Claude Code',
  generic: 'Other assistant',
});

/* The label of a branch key, or null. Own-key membership, never a property
   lookup: `toString` and `constructor` are inherited properties of a plain
   object and are not branches (critique M3). */
export function branchLabel(branch) {
  return typeof branch === 'string' && Object.hasOwn(BRANCH_LABELS, branch) ? BRANCH_LABELS[branch] : null;
}

const MARK = `<svg viewBox="-0.20 -5.00 88.20 95.40" aria-hidden="true"><g fill="currentColor" transform="rotate(138 50 50)"><path d="M43.5 32.5A6.5 6.5 0 0 1 56.5 32.5V115.5A6.5 6.5 0 0 1 43.5 115.5Z" fill-opacity=".58"/><path d="M43.5 57C43.5 46 37.5 38 37 26C36.5 12 41 2.5 50 2.5C59 2.5 63.5 12 63 26C62.5 38 56.5 46 56.5 57Z" fill-opacity=".58"/><path d="M43.5 32.5A6.5 6.5 0 0 1 56.5 32.5V57H43.5Z"/></g></svg>`;

/* ---------- the private head ---------- */

/* assetBase is a fixed value from the caller (the build script passes a
   relative directory, the app its served path), never text a user wrote; it is
   escaped anyway because every interpolation is. */
function head(title, assetBase) {
  const a = esc(assetBase);
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#F7F8F5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#071B23" media="(prefers-color-scheme: dark)">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="preload" href="${a}/fonts/schibsted-grotesk-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${a}/fonts/dm-mono-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${a}/fonts/fonts.css">
<link rel="stylesheet" href="${a}/tokens.css">
<link rel="stylesheet" href="${a}/base.css">
<link rel="stylesheet" href="${a}/recipient.css">`;
}

/* The private page header: the mark, the product name and the company name.
   No navigation, no links. */
function privateBar(company) {
  return `<header class="topbar">
  <div class="wrap">
    <span class="ph-lockup">
      ${MARK}
      <span class="ph-wordmark">Phaeacia</span>
      <span class="ph-product">Enterprise · private${company ? ` · ${esc(company)}` : ''}</span>
    </span>
  </div>
</header>`;
}

/* ---------- losses: the three-state table ---------- */

const LOSS_HEADER = ['What', 'Status', 'What that means in practice'];

/* A record counts as a report only when it says so. Anything else, including
   a record whose status is pending, started or missing, is not an outcome and
   renders the pending row. */
function isReport(installation) {
  if (!installation || typeof installation !== 'object') return false;
  const s = String(installation.status || '').toLowerCase();
  return s === 'reported' || s === 'witnessed';
}

/* 'pending', 'declared' or 'reported': which of the three section 5 states
   the declaration renders. Declared rows come from the passport's own section
   6 table; a report comes only from an installation record, never from the
   passport. */
export function lossesState(body, installation) {
  if (isReport(installation)) return 'reported';
  const lossLines = sectionLines(body || '', '## 6. Losses');
  return tableRows(lossLines).data.length ? 'declared' : 'pending';
}

function lossTable(rows) {
  return `<div class="scroll"><table><thead><tr>${LOSS_HEADER.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? '' : ' class="dim"'}>${inline(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

function singleRowTable(text) {
  return `<div class="scroll"><table><thead><tr>${LOSS_HEADER.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody><tr><td colspan="3">${esc(text)}</td></tr></tbody></table></div>`;
}

/* The declaration aside. `body` is the passport body; `installation` is the
   E5 installations row when one exists: { status, actor, at, losses: [{ what,
   status, meaning }], no_loss_reported, note }. The table always renders. The
   owner's own section 6 prose renders in every state under OWNERS_WORDS_LABEL
   because it is passport content; the table's row is the state, and the
   signature line names that state and nothing else: "Pending an install",
   the declared label, or "Recorded at install, not inferred". */
export function renderLosses({ body, installation = null }) {
  const lossLines = sectionLines(body || '', '## 6. Losses');
  const lossProse = sectionProse(lossLines);
  const state = lossesState(body, installation);
  let table = '';
  let signature = '';
  let lede = '';
  if (state === 'reported') {
    const who =
      String(installation.status).toLowerCase() === 'witnessed' ? 'Witnessed by' : 'Reported by the recipient';
    const rows = Array.isArray(installation.losses) ? installation.losses : [];
    lede = `<p class="dn">${esc(who)} ${esc(installation.actor)} at ${esc(installation.at)}. This is the installation record, not the passport.</p>`;
    if (rows.length) {
      table = lossTable(rows.map((r) => [String(r?.what ?? ''), String(r?.status ?? ''), String(r?.meaning ?? '')]));
      signature = `${esc(String(rows.length))}${rows.length === 1 ? ' entry' : ' entries'} reported`;
    } else if (installation.no_loss_reported === true) {
      table = singleRowTable(`No loss reported by ${installation.actor} at ${installation.at}`);
      signature = 'No loss reported';
    } else {
      table = singleRowTable(LOSSES_PENDING);
      signature = esc(LOSSES_PENDING);
    }
    if (installation.note) lede += `<p class="dn">${inline(String(installation.note))}</p>`;
  } else if (state === 'declared') {
    const count = tableRows(lossLines).data.length;
    lede = `<p class="dn">${esc(LOSSES_DECLARED_LABEL)}: these rows were written into the passport by its owner before any install.</p>`;
    table = mdTable(lossLines, '');
    signature = `${esc(String(count))}${count === 1 ? ' entry' : ' entries'}`;
  } else {
    lede = `<p class="dn">Your install ends with a written list: what transferred, what was substituted, and what was lost. No installation has been recorded for this passport, so the list is not yet assessed.</p>`;
    table = singleRowTable(LOSSES_PENDING);
    signature = esc(LOSSES_PENDING);
  }
  const folio =
    state === 'reported'
      ? 'From the installation record'
      : state === 'declared'
        ? LOSSES_DECLARED_LABEL
        : 'Pending an install';
  return `<aside class="docnote" aria-labelledby="pg-decl" data-losses="${esc(state)}">
        <div class="page-head">
          <h2 class="pt" id="pg-decl">Declaration</h2>
          <span class="folio">${esc(folio)}</span>
        </div>
        ${lede}
        ${table}
        ${ownersWords(OWNERS_WORDS_LABEL, lossProse)}
        <p class="signature">
          <span>${esc(state === 'reported' ? 'Recorded at install, not inferred' : state === 'declared' ? LOSSES_DECLARED_LABEL : 'Pending an install')}</span>
          <span class="r">${signature}</span>
        </p>
      </aside>`;
}

/* ---------- the document ---------- */

function counts(row, body) {
  const needs = row.needs || [];
  const lossLines = sectionLines(body, '## 6. Losses');
  return {
    capabilities: needs.length,
    installable: needs.filter((n) => n.installable).length,
    declaredOnly: needs.filter((n) => !n.installable).length,
    losses: tableRows(lossLines).data.length,
  };
}

/* The four-page artefact plus the declaration: cover, bearer, machine-readable
   zone, entry permissions, losses. Derived from renderPassport(); the listed
   path, the vote control, the view counter, the expiry row and the specimen
   branch are removed. */
function document(row, installation) {
  const body = row.body || '';
  const needs = row.needs || [];
  const consentProse = sectionProse(sectionLines(body, '## 2. What it needs from you'));
  const c = counts(row, body);
  const strip = mrz(row, c);
  const purpose = purposeLine(row, body);
  const validated = esc(String(row.validated_at).slice(0, 10));

  const TILTS = ['-3.1deg', '2.4deg', '-1.9deg', '3.4deg', '-2.6deg', '1.8deg'];
  const permits = needs
    .map((n, i) => {
      const tilt = TILTS[i % TILTS.length];
      const stampClass = n.installable ? 'stamp' : 'stamp no';
      const stampText = n.installable ? 'Granted' : 'Not granted';
      const stampSub = n.required_label ? clip(n.required_label, 16) : '';
      return `<div class="permit">
      <div>
        <p class="cap">${esc(n.capability)}${n.ref ? `<span class="ref">${esc(n.ref)}</span>` : ''}</p>
        <p class="why">${inline(n.why)}</p>
        ${n.required_label ? `<p class="ifskip">${esc(REQ_COLUMN)}: ${inline(n.required_label)}</p>` : ''}
        <p class="ifskip">If you skip it: ${inline(n.if_skipped)}</p>
        ${n.installable_label ? `<p class="ifskip">Installable in v0.1: ${inline(n.installable_label)}</p>` : ''}
      </div>
      <span class="${stampClass}" style="--tilt:${esc(tilt)}">
        <span class="s1">${esc(stampText)}</span>${stampSub ? `<span class="s2">${esc(stampSub)}</span>` : ''}
      </span>
    </div>`;
    })
    .join('');

  const BUCKETS = [
    { k: 'req', label: 'required', pick: (n) => n.installable && n.required },
    { k: 'opt', label: 'optional', pick: (n) => n.installable && !n.required },
    { k: 'no', label: 'declared only', pick: (n) => !n.installable },
  ];
  const reqsHtml = BUCKETS.map((b) => {
    const rows = needs.filter(b.pick);
    if (!rows.length) return '';
    return `<div class="rq ${b.k}">
      <p class="rl"><span class="c">${esc(String(rows.length))}</span>${esc(b.label)}</p>
      <ul>${rows.map((n) => `<li>${esc(n.capability)}</li>`).join('')}</ul>
    </div>`;
  }).join('');

  return `<article class="doc">

      <section class="page cover" aria-labelledby="bearer-name">
        <div class="cover-top">
          <span class="cover-mark">${MARK}<span class="w">Phaeacia</span></span>
          <span class="cover-type">Type ${esc(envClass(row.envelope))} &middot; ${esc(row.envelope)}<br>Page 1 of 4</span>
        </div>
        <div class="cover-titlewrap">
          <p class="cover-title">Agent<br>Passport</p>
        </div>
        <div class="cover-foot">
          <span class="lbl">Bearer</span>
          <h1 id="bearer-name">${esc(row.title)}</h1>
          <span class="idr">${esc(row.name)}</span>
          ${
            purpose
              ? `<div class="cover-purpose">
            <span class="lbl">Purpose</span>
            <p class="pv">${inline(purpose.text)}</p>
            <span class="src">${esc(purpose.source)}</span>
          </div>`
              : ''
          }
        </div>
      </section>

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
              <div><dt>Capture path</dt><dd>${esc(row.capture_path)}</dd></div>
              <div><dt>Envelope</dt><dd>${esc(row.envelope)}</dd></div>
              <div><dt>Source stack</dt><dd>${esc(row.source_stack)}</dd></div>
              <div><dt>Scrub</dt><dd>${esc(row.scrub)}</dd></div>
              <div><dt>Signed by owner</dt><dd>${row.owner_confirmed ? 'Confirmed this description' : 'Did not confirm this description'}</dd></div>
            </dl>
            <p class="fieldnote">Source stack is where this agent ran before it was captured. Your rebuild
            does not need it, and nothing in the install tries to reproduce it.</p>
            <div class="observations">
              <span class="lbl">Observations</span>
              <p>${inline(row.summary)}</p>
            </div>
          </div>
        </div>
      </section>

      <section class="page" aria-labelledby="pg-mrz">
        <div class="page-head">
          <h2 class="pt" id="pg-mrz">The machine-readable zone</h2>
          <span class="folio">Page 3 of 4</span>
        </div>
        <div class="mrz">${strip.lines}</div>
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
        ${ownersWords('In the owner’s words', consentProse)}
        <p class="permit-note"><span class="m">Granted means version 0.1 will install that capability.
        Not granted means it is named here, and left out, so you can see what the original could do that
        your copy will not.</span></p>
      </section>

      ${renderLosses({ body, installation })}

    </article>

    <p class="doc-foot">
      <span>Checked ${validated} against rules ${esc(row.validator_version)}</span>
      <span>Private rendering</span>
    </p>`;
}

function evidenceSection(row) {
  const body = row.body || '';
  const goldenParts = sectionParts(sectionLines(body, '## 4. Golden examples')).parts;
  const goldenCount = goldenParts.filter((p) => p.kind === 'block').length;
  const goldenHead =
    goldenCount === 1
      ? 'One golden example, copied from the passport.'
      : `${goldenCount} golden examples, copied from the passport.`;
  const goldenHtml = goldenParts
    .reduce((out, p) => {
      if (p.kind === 'block') {
        out.push(`<div class="blockbox tall">${esc(p.text)}</div>`);
        return out;
      }
      const last = out[out.length - 1];
      const para = `<p>${inline(p.text)}</p>`;
      if (last?.startsWith('<div class="body">')) {
        out[out.length - 1] = `${last.slice(0, -6)}${para}</div>`;
      } else {
        out.push(`<div class="body">${para}</div>`);
      }
      return out;
    }, [])
    .join('');
  return `<section class="sec">
    <div class="rail"><span class="num">01</span><span class="label">Evidence</span></div>
    <div class="col">
      <h2>${esc(goldenHead)}</h2>
      <p class="lede">Golden examples are what the passport offers as evidence that the agent does what
      it says. A rebuild is checked against these. This service checked the file's format, not the truth
      of its examples.</p>
      <div class="stack" style="gap:12px">
        ${goldenHtml}
      </div>
    </div>
  </section>`;
}

/* Section 5 of a stored passport: the placeholder note, and the placeholder
   line itself as text. No installer text exists for it until a release does. */
function placeholderSection(row) {
  const body = row.body || '';
  const lines = sectionLines(body, '## 5. Installer');
  const shown = lines.map((l) => l.trim()).filter((l) => l !== '');
  return `<section class="sec" id="install" tabindex="-1" aria-labelledby="install-h">
    <div class="rail"><span class="num">02</span><span class="label">Install</span></div>
    <div class="col">
      <h2 id="install-h">Section 5: no installer yet</h2>
      <p class="lede">${esc(PLACEHOLDER_NOTE)}</p>
      <div class="blockbox">${esc(shown.join('\n'))}</div>
    </div>
  </section>`;
}

function page({ title, company, assetBase, main }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${head(title, assetBase)}
</head>
<body>

<a class="skip" href="#main">Skip to content</a>

${privateBar(company)}

<main id="main">
<div class="wrap">
${main}
</div>
</main>

</body>
</html>`;
}

function docSection(row, installation, eyebrow) {
  const validated = esc(String(row.validated_at).slice(0, 10));
  return `  <section class="sec doc-sec first">
    <div class="rail"><span class="num">00</span><span class="label">The document</span></div>
    <div class="col">

    <div class="jumprow">
      <p class="eyebrow brass">${esc(eyebrow)} · spec ${esc(row.passport_version)} · checked ${validated}</p>
    </div>

    <div class="docwrap">
    ${document(row, installation)}
    </div>

    </div>
  </section>`;
}

/* A stored passport (a candidate) rendered privately. `row` is the derive()
   record plus `body`; `installation` is the E5 installations row or null. */
export function renderPassportPage({ row, installation = null, company = '', assetBase = '/assets' }) {
  if (!row || typeof row !== 'object') throw new TypeError('renderPassportPage: row is required');
  const main = [docSection(row, installation, 'Passport'), evidenceSection(row), placeholderSection(row)].join(
    '\n\n  ',
  );
  return page({ title: `${row.title} · Passport · Enterprise Phaeacia`, company, assetBase, main });
}

/* A release: the same document, and section 5 as the frozen assembled
   content the caller passes in. `release` is { id, branch, assembled_content,
   published_at, assembled_sha256 }; assembled_content must be a string, it is
   never read from anywhere by this module. */
export function renderReleasePage({ row, release, installation = null, company = '', assetBase = '/assets' }) {
  if (!row || typeof row !== 'object') throw new TypeError('renderReleasePage: row is required');
  if (!release || typeof release.assembled_content !== 'string') {
    throw new TypeError('renderReleasePage: release.assembled_content must be the frozen assembled text');
  }
  const label = branchLabel(release.branch);
  if (!label) throw new TypeError(`renderReleasePage: unknown branch ${JSON.stringify(release.branch)}`);
  const facts = [
    ['Release', release.id],
    ['Branch', `${label} (${release.branch})`],
    ['Published', release.published_at],
    ['Assembled bytes SHA-256', release.assembled_sha256],
  ].filter(([, v]) => v != null && v !== '');
  const install = `<section class="sec" id="install" tabindex="-1" aria-labelledby="install-h">
    <div class="rail"><span class="num">02</span><span class="label">Install</span></div>
    <div class="col">
      <h2 id="install-h">The install block for ${esc(label)}, frozen at publication</h2>
      <p class="lede">This is the assembled document stored with the release: the passport with its
      installer text inserted at section 5. It does not change when the installer files change; a new
      release would carry a new block.</p>
      <dl class="fields">
        ${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('\n        ')}
      </dl>
      <div class="blockbox tall">${esc(release.assembled_content)}</div>
      <p class="caption">The installer text and the judge prompt inside this block are CC BY 4.0, Phaeacia, imported
      from the pinned Agent Passport revision named in upstream.lock.json.</p>
    </div>
  </section>`;
  const main = [docSection(row, installation, 'Release'), evidenceSection(row), install].join('\n\n  ');
  return page({ title: `${row.title} · Release · Enterprise Phaeacia`, company, assetBase, main });
}

/* One company's catalog: its passports with counts, state and the losses
   state. `company` is the shell ({ id, name, memberships, groups }); `entries`
   are [{ id, row, release, installation, state, audience }]. A passport with
   any capability derive() marked not installable is labelled "declared, not
   installed"; nothing here offers an install. */
export function renderCatalogPage({ company, entries, assetBase = '/assets' }) {
  if (!company || typeof company !== 'object') throw new TypeError('renderCatalogPage: company is required');
  const memberships = Array.isArray(company.memberships) ? company.memberships : [];
  const groups = Array.isArray(company.groups) ? company.groups : [];
  const active = memberships.filter((m) => String(m.status || 'active') === 'active');
  const items = (entries || [])
    .map((e) => {
      const row = e.row;
      const c = counts(row, row.body || '');
      const state = lossesState(row.body, e.installation);
      const lossesText =
        state === 'reported'
          ? 'losses reported at install'
          : state === 'declared'
            ? `${c.losses} loss ${c.losses === 1 ? 'row' : 'rows'} declared by the owner`
            : LOSSES_PENDING;
      const declaredOnly = (row.needs || []).filter((n) => !n.installable);
      const release = e.release
        ? `Released for ${esc(branchLabel(e.release.branch) ?? String(e.release.branch))}${e.release.published_at ? ` on ${esc(String(e.release.published_at).slice(0, 10))}` : ''}`
        : 'No release';
      return `<li class="entry" data-id="${esc(e.id)}">
        <div class="card">
          <p class="eyebrow">${esc(e.id)}${e.state ? ` · ${esc(e.state)}` : ''}</p>
          <h3>${esc(row.title)}</h3>
          <p class="mono">${esc(row.name)}</p>
          <p>${inline(firstSentence(row.summary))}</p>
          <p class="caption">${esc(String(c.capabilities))} ${c.capabilities === 1 ? 'capability' : 'capabilities'}, ${esc(String(c.installable))} installable, ${esc(String(c.declaredOnly))} declared only · ${esc(lossesText)} · ${release}${e.audience ? ` · audience ${esc(e.audience)}` : ''}</p>
          ${
            declaredOnly.length
              ? `<p class="chip no">${esc(DECLARED_NOT_INSTALLED)}</p>
          <ul>${declaredOnly.map((n) => `<li>${esc(n.capability)}</li>`).join('')}</ul>`
              : ''
          }
        </div>
      </li>`;
    })
    .join('\n      ');
  const main = `  <section class="sec first">
    <div class="rail"><span class="num">00</span><span class="label">Catalog</span></div>
    <div class="col">
      <p class="eyebrow brass">Company ${esc(company.id)}</p>
      <h1>${esc(company.name)}</h1>
      <p class="lede">${esc(String(active.length))} active ${active.length === 1 ? 'membership' : 'memberships'}${memberships.length !== active.length ? ` (${esc(String(memberships.length - active.length))} not active)` : ''}, ${esc(String(groups.length))} ${groups.length === 1 ? 'group' : 'groups'}, ${esc(String((entries || []).length))} ${(entries || []).length === 1 ? 'passport' : 'passports'}. Synthetic shell for rendering only; it establishes no tenancy isolation.</p>
      <ul class="stack" style="list-style:none;padding:0;gap:16px">
      ${items}
      </ul>
    </div>
  </section>

  <section class="sec">
    <div class="rail"><span class="num">01</span><span class="label">Groups</span></div>
    <div class="col">
      <div class="scroll"><table><thead><tr><th>Group</th><th>Name</th><th>Members</th></tr></thead><tbody>${groups
        .map(
          (g) =>
            `<tr><td>${esc(g.id)}</td><td class="dim">${esc(g.name)}</td><td class="dim">${esc((g.members || []).join(', '))}</td></tr>`,
        )
        .join('')}</tbody></table></div>
      <div class="scroll"><table><thead><tr><th>Membership</th><th>Name</th><th>Role</th><th>Status</th></tr></thead><tbody>${memberships
        .map(
          (m) =>
            `<tr><td>${esc(m.id)}</td><td class="dim">${esc(m.display_name)}</td><td class="dim">${esc(m.role)}</td><td class="dim">${esc(m.status || 'active')}</td></tr>`,
        )
        .join('')}</tbody></table></div>
    </div>
  </section>`;
  return page({ title: `${company.name} · Catalog · Enterprise Phaeacia`, company: company.name, assetBase, main });
}
