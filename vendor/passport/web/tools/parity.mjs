/* Validator parity. Runs every fixture through BOTH implementations and fails
   if they disagree, or if either disagrees with what the fixture is for.

   Section 8 of site/spec/upload-validation.md says a fixture corpus run through
   both implementations and compared rule by rule "is the only mechanism that
   actually holds; the rest is intention". It did not exist, and the two had
   already drifted in two places that mattered:

     - tools/validate.py required `created` to be present and never looked at
       it, while the site refused a malformed or future date. A capture could
       pass its own verification loop and be refused on upload.
     - tools/validate.py accepted a section 2 containing one line of prose,
       while the site refused a passport with no consent table. The consent
       table is the part a person reads before deciding, so a passport without
       one is not a passport, and the loop was calling those finished.

   Both are now checks 10 and 11 in validate.py, and this file is what stops
   them drifting apart again.

   Parity is on the VERDICT, not on the error text. The two have different
   vocabularies by design: validate.py prints numbered FAIL lines for a person
   fixing a file, the site returns codes for a page to render. What must never
   differ is the answer to "would this be stored".

   Fixtures are named for their verdict. valid_* must be accepted by both,
   invalid_* refused by both. Each invalid_ fixture mutates exactly one thing,
   so a disagreement names one rule rather than sending somebody bisecting a
   document. (This used to say "every fixture but the two valid_ ones" and went
   stale the moment a third valid_ fixture arrived; count nothing here.) */

import { readFile, readdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validate, transport, SECRETS } from '../lib/_validate.mjs';
import { derive } from '../lib/_derive.mjs';
import { sectionLines, sectionParts } from '../lib/_sections.mjs';

const run = promisify(execFile);

const DIR = fileURLToPath(new URL('../../tools/fixtures/passports/', import.meta.url));
const PY = fileURLToPath(new URL('../../tools/validate.py', import.meta.url));
const PREFLIGHT = fileURLToPath(new URL('../../tools/preflight.py', import.meta.url));
const SCRUB = fileURLToPath(new URL('../../tools/scrub.py', import.meta.url));
const EXAMPLE = fileURLToPath(new URL('../../examples/daily-brief-passport.md', import.meta.url));

/* Divergences that are allowed, each with the reason it is allowed and what
   would have to change to remove it. An empty table is the goal; a table that
   grows silently is the failure this file exists to prevent. */
const ALLOWED = [
  // { file: 'x.md', js: 'REFUSE', py: 'ACCEPT', why: '...' }
];

/* The site's answer. Derivation is part of validation: a passport that parses
   but cannot be derived is not stored, so it counts as a refusal here. */
function jsVerdict(text) {
  const v = validate(text);
  if (v.errors.length) return { verdict: 'REFUSE', detail: v.errors.map(e => e.code).join(',') };
  const d = derive(v.front, v.lines);
  if (d.error) return { verdict: 'REFUSE', detail: d.error.code };
  return { verdict: 'ACCEPT', detail: '' };
}

async function pyVerdict(path) {
  try {
    await run('python3', [PY, path]);
    return { verdict: 'ACCEPT', detail: '' };
  } catch (e) {
    const out = String(e.stdout || '').trim().split('\n').filter(Boolean);
    return { verdict: 'REFUSE', detail: out.join(' | ') };
  }
}

/* Verdict parity is not enough on its own, and the gap was not theoretical: the
   verdict is what validate.py computes, and the two DERIVATIONS had already
   drifted underneath it. The site kept only the booleans of the consent table's
   two verdict columns, so the runtime renderer had to invent the words back and
   printed "Declared only" on a page whose install block, a screen further down,
   carried the passport's own "no, declared only". Both suites stayed green
   throughout, because neither ran the derivation twice and compared it.

   This compares the `needs` array, which is the one structure both
   implementations build from the same table, for every file both accept. */
const P2P = fileURLToPath(new URL('../../scripts/passport-to-page.py', import.meta.url));

async function pyNeeds(path) {
  const { stdout } = await run('python3', [P2P, path]);
  const json = stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1);
  return JSON.parse(json).needs;
}

/* The other half of the derivation: how each side reads a section's Markdown
   into blocks and paragraphs. scripts/passport-to-page.py said in a comment
   that its splitter and the site's "are one algorithm written twice" and that
   a harness diffed them. No harness existed. A comment asserting a test is
   worse than no comment, because it is exactly what stops the next person
   writing one, so --dump-parts was added there and this is the diff.

   Sections 2, 4 and 6, the three whose prose either page renders. */
const DUMPED_SECTIONS = [
  '## 2. What it needs from you',
  '## 4. Golden examples',
  '## 6. Losses'
];

async function pyParts(path) {
  const { stdout } = await run('python3', [P2P, path, '--dump-parts']);
  return JSON.parse(stdout);
}

function jsParts(text) {
  const lines = text.split('\n');
  const out = {};
  for (const heading of DUMPED_SECTIONS) {
    const { parts, open } = sectionParts(sectionLines(lines, heading));
    out[heading] = { parts, open };
  }
  return out;
}

function jsNeeds(text) {
  const v = validate(text);
  if (v.errors.length) return null;
  const d = derive(v.front, v.lines);
  return d.error ? null : d.record.needs;
}

const files = (await readdir(DIR)).filter(f => f.endsWith('.md')).sort();
if (files.length < 10) {
  console.error(`   FAIL: only ${files.length} fixtures, which is not a corpus`);
  process.exit(1);
}

let failures = 0;
const rows = [];

for (const file of [...files, null]) {
  const path = file ? DIR + file : EXAMPLE;
  const name = file || 'examples/daily-brief-passport.md';
  const expected = file ? (file.startsWith('valid_') ? 'ACCEPT' : 'REFUSE') : 'ACCEPT';

  const text = await readFile(path, 'utf8');
  const js = jsVerdict(text);
  const py = await pyVerdict(path);

  const excused = ALLOWED.find(a => a.file === name && a.js === js.verdict && a.py === py.verdict);

  let status = 'ok';
  if (js.verdict !== py.verdict) {
    status = excused ? 'excused' : 'DISAGREE';
  } else if (js.verdict !== expected) {
    status = 'WRONG';
  }
  if (status === 'DISAGREE' || status === 'WRONG') failures++;

  rows.push({ name, expected, js, py, status });
}

const width = Math.max(...rows.map(r => r.name.length));
for (const r of rows) {
  const mark = r.status === 'ok' ? '  ' : r.status === 'excused' ? ' ~' : ' ✗';
  console.log(`  ${mark} ${r.name.padEnd(width)}  want ${r.expected.padEnd(6)}` +
              `  site ${r.js.verdict.padEnd(6)}  validate.py ${r.py.verdict}`);
  if (r.status === 'DISAGREE') {
    console.log(`       the two implementations disagree.`);
    console.log(`       site:        ${r.js.detail || '(accepted)'}`);
    console.log(`       validate.py: ${r.py.detail || '(accepted)'}`);
  }
  if (r.status === 'WRONG') {
    console.log(`       both agree on ${r.js.verdict}, but this fixture is named for ${r.expected}.`);
    console.log(`       site:        ${r.js.detail || '(accepted)'}`);
    console.log(`       validate.py: ${r.py.detail || '(accepted)'}`);
  }
}

console.log(`   ${rows.length} fixtures, ${ALLOWED.length} recorded divergences, ${failures} failures`);

/* Key order is not a divergence; the values are, and so is a key one side has
   and the other does not.

   This was `JSON.stringify(n, Object.keys(n[0] || {}).sort())`, which is the
   replacer-ARRAY form of stringify: an allowlist of property names, built
   from row 0 of each side SEPARATELY. Any key missing from the first row was
   dropped from every row, on both sides, before the comparison. Two arrays
   differing only in `ref` on their second row therefore compared equal:

     a = [{cap:1}, {cap:1, ref:'X'}]   b = [{cap:1}, {cap:1, ref:'Y'}]
     norm(a) === norm(b)   ->   true

   `ref` is the only optional key in a needs row, so it was the one field the
   harness could never see, and it is set from a backticked capability, which
   no fixture had. Sorting each object's own keys instead compares the union
   by construction: a key on one side and not the other now shows up as a
   difference in the JSON, which is what it is. */
const sortKeys = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
const norm = v => JSON.stringify(Array.isArray(v) ? v.map(sortKeys) : v);

/* Show the first index where two rendered arrays differ, rather than two
   walls of JSON. */
function firstDiff(a, b) {
  const x = JSON.parse(norm(a)), y = JSON.parse(norm(b));
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const l = JSON.stringify(x[i]), r = JSON.stringify(y[i]);
    if (l !== r) return `       first difference at index ${i}\n` +
                        `       site:                ${l}\n` +
                        `       passport-to-page.py: ${r}`;
  }
  return '';
}

/* Derivation parity, over everything both implementations accepted. */
let derived = 0;
for (const r of rows.filter(r => r.js.verdict === 'ACCEPT' && r.py.verdict === 'ACCEPT')) {
  const path = r.name.includes('/') ? EXAMPLE : DIR + r.name;
  const text = await readFile(path, 'utf8');
  const a = jsNeeds(text);
  let b;
  try {
    b = await pyNeeds(path);
  } catch (e) {
    console.log(`   ✗ ${r.name}: passport-to-page.py could not derive it: ${String(e.stderr || e).trim()}`);
    failures++;
    continue;
  }
  if (norm(a) !== norm(b)) {
    failures++;
    console.log(`   ✗ ${r.name}: the two derivations disagree on needs`);
    console.log(firstDiff(a, b));
  }
  derived++;
}
console.log(`   ${derived} passports derived by both, needs compared field by field`);

/* The Markdown reading underneath the derivation, over EVERY fixture and not
   only the accepted ones. Splitting a section into blocks and paragraphs does
   not depend on whether the passport is valid, and restricting the diff to
   what both sides accept would leave the rules that only fire on a refused
   file untested: the unfilled-capture-template guard is one, and it is the
   rule that decides whether a page prints an angle-bracketed instruction to
   its recipient as if the owner had written it. */
let split = 0;
for (const r of rows) {
  const path = r.name.includes('/') ? EXAMPLE : DIR + r.name;
  let pyp;
  try {
    pyp = await pyParts(path);
  } catch (e) {
    failures++;
    console.log(`   ✗ ${r.name}: --dump-parts failed: ${String(e.stderr || e).trim()}`);
    continue;
  }
  const jsp = jsParts(await readFile(path, 'utf8'));
  /* The two DUMPED_SECTIONS lists are written out in both languages. Drifting
     in one direction crashes on a missing key; drifting in the other silently
     stops comparing a section, which is the failure this whole harness exists
     to prevent. Check the lists themselves, not only what they produce. */
  const pyHeadings = Object.keys(pyp).sort();
  if (norm(pyHeadings) !== norm([...DUMPED_SECTIONS].sort())) {
    failures++;
    console.log(`   ✗ ${r.name}: DUMPED_SECTIONS disagree: ` +
                `site ${JSON.stringify(DUMPED_SECTIONS)}, ` +
                `passport-to-page.py ${JSON.stringify(pyHeadings)}`);
    continue;
  }
  for (const heading of DUMPED_SECTIONS) {
    const x = jsp[heading], y = pyp[heading];
    if (norm(x.parts) === norm(y.parts) && x.open === y.open) continue;
    failures++;
    console.log(`   ✗ ${r.name}: the two section splitters disagree on ${heading}`);
    if (x.open !== y.open) {
      console.log(`       open fence at line: site ${x.open}, passport-to-page.py ${y.open}`);
    }
    console.log(firstDiff(x.parts, y.parts));
  }
  split++;
}
console.log(`   ${split} passports split by both, sections 2, 4 and 6 compared part by part`);

/* Stage 3, the untrusted-content rules, compared against tools/preflight.py.
   Section 8 of the spec makes this file the sole authority for them, and
   validate.py is deliberately blind to them. That split left the capture skill
   unable to answer "will this upload?", so it told an owner their passport was
   good and the site refused it. preflight.py answers that question offline and
   travels inside the distributable skill; this loop is what stops it becoming a
   second opinion. Codes only, not messages: the wording is this file's alone. */
const STAGE3 = new Set(['E_HTML', 'E_UNFILLED', 'E_ACTIVE_CONTENT', 'E_SECRET_FOUND']);
let pre = 0;
for (const r of rows) {
  const path = r.name.includes('/') ? EXAMPLE : DIR + r.name;
  const text = await readFile(path, 'utf8');
  const t = transport(Buffer.from(text), 'text/markdown');
  const siteCodes = t.error ? [] : [...new Set((validate(t.text ?? String(t)).errors || [])
    .map(e => e.code).filter(c => STAGE3.has(c)))].sort();
  let preCodes;
  try {
    const { stdout } = await run('python3', [PREFLIGHT, '--codes', path]);
    preCodes = stdout.trim() ? stdout.trim().split('\n').sort() : [];
  } catch (e) {
    preCodes = String(e.stdout || '').trim() ? String(e.stdout).trim().split('\n').sort() : [];
  }
  if (norm(siteCodes) !== norm([...new Set(preCodes)].sort())) {
    failures++;
    console.log(`   ✗ ${r.name}: stage 3 disagrees. ` +
                `site ${JSON.stringify(siteCodes)}, preflight.py ${JSON.stringify(preCodes)}`);
    continue;
  }
  pre++;
}
console.log(`   ${pre} passports checked by both for HTML, placeholders, active content and secrets`);

/* Only one fixture in the corpus trips stage 3, and fixtures cannot cover the
   rest: validate.py is blind to these rules by design, so a file that is valid
   apart from a javascript: link would be ACCEPT there and REFUSE here, which
   the verdict loop above would report as a disagreement rather than as the
   intended split. So the remaining stage-3 rules are pinned on synthetic text
   instead, which needs no fixture and no verdict. */
/* A probe is [label, body, expected].

   `expected` is normally one array of codes that BOTH implementations must
   return. Where the two are deliberately out of step, write
   { site: [...], preflight: [...], why: '...' } instead.

   That second form exists because this file reported green for a day while the
   two implementations disagreed. preflight.py gained a credential-assignment
   rule at addcb11 and _validate.mjs never did. Nothing here caught it: no
   fixture in the corpus carries a credential assignment, and the only
   E_SECRET_FOUND probe below was a private key block, which both sides have. A
   harness that cannot express "these two disagree, on purpose, here is why" is
   a harness that reports agreement it never checked.

   A divergence entry is not a way to silence a failure. It fails the moment the
   divergence stops being true in either direction, so closing the gap requires
   editing this table, which is where somebody will read the reason. */
const PROBES = [
  ['clean prose',            'It reads the news and writes a brief.',            []],
  ['a real tag',             'It reads <img src=x onerror=alert(1)> the news.',  ['E_HTML']],
  ['a closing tag',          'It reads </script> the news.',                     ['E_HTML']],
  ['an html comment',        'It reads the news. <!-- todo -->',                 ['E_HTML']],
  ['a capture placeholder',  'It reads <what the agent reads> every morning.',   ['E_UNFILLED']],
  ['a placeholder named for an element', 'Row: <a declared-only capability>.',   ['E_UNFILLED']],
  ['both at once',           'A <span>x</span> and <what the agent reads>.',      ['E_HTML', 'E_UNFILLED']],
  ['a javascript link',      'See [here](javascript:alert(1)) for detail.',      ['E_ACTIVE_CONTENT']],
  ['a data:text/html uri',   'See data:text/html;base64,PHNjcmlwdD4= for it.',   ['E_ACTIVE_CONTENT']],
  ['a private key block',    '-----BEGIN RSA PRIVATE KEY-----',                  ['E_SECRET_FOUND']],
  ['a tag inside a fence',   '```\n<img src=x>\n```\n',                          []],

  /* The credential-assignment rule. preflight.py and tools/scrub.py carry it;
     _validate.mjs does not, pending the decision recorded in
     record/decisions/. Asserted as a divergence so the gap is visible in the
     build output instead of being nothing at all. */
  /* Deliberately carries no vendor prefix. A shape every named rule is blind to
     is the only thing that tests the context rule rather than something else,
     and it keeps a string that trips the repo's own secret scanner out of a
     file that is not covered by the tools/fixtures allowlist. */
  ['a token assigned to a name', 'AUTH_TOKEN=a3f9c2e1b7d4058a6c9e2f1a4b7d0c3e5f8a9b2c',
    ['E_SECRET_FOUND']],
  ['an authorization header', 'Authorization: Bearer a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
    ['E_SECRET_FOUND']],

  /* False positives the credential rule used to produce, all of them ordinary
     content a stranger would write. These are the cases that made preflight.py
     abort an owner's capture on the word "monkey" and told them to rotate a
     credential that did not exist. Both implementations must stay clean.
     Measured against 6055 stranger-written files; see
     record/findings/the-context-rule-fires-on-code-not-only-on-credentials.md. */
  ['key inside another word', 'The monkey = the-quick-brown-fox-jumped over it.', []],
  ['a hotkey',               'Set hotkey=cmd+shift+option+control+space to run it.', []],
  ['a keyword field',        'keyword: geopolitical-forecasting-daily',           []],
  ['dotted names in prose',  'authors: Raffael.Hueberli.and.K.Patel',             []],
  ['a path to a credential', 'cache_key: "articles/2026-08-17/brief.json"',       []],
  ['code in a golden example', 'const key = forge.random.getBytesSync(32)',       []],
  ['camelCase code',         'node.manualKeyframeTracks = track.manualKeyframeTracks', []],
  ['a gpg fingerprint',      'key: F3EF5F62A87FC27A22E643F714CE4FF5015AA242',     []],
  ['a documentation blank',  'OPENAI_API_KEY=your-api-key-goes-here',             []],

  /* ROW-100. The probe above proves nothing about the name `cache_key`: its
     value is a path, so the path exclusion is what let it through, not
     anything about the name. This pair has a NON-path value of the exact
     shape, on both a name that is now excluded and one that is not, so
     together they test the thing the earlier probe could not reach: that the
     fix is on the NAME and not the VALUE. If it were a value-shape exclusion
     instead, the second line here would wrongly pass too. */
  ['a database key name, not a credential', 'sort_key = created_at_descending_then_by_name', []],
  ['the same value shape, a real-looking name', 'SECRET_KEY = created_at_descending_then_by_name',
    ['E_SECRET_FOUND']],

  /* `primary` was in ROW-100's first version of the excluded-word list and a
     critic found it removes a real credential: azurerm_cosmosdb_account and
     azurerm_storage_account both expose `primary_key` as the literal
     Terraform/SDK attribute name for a live master access key (confirmed
     against registry.terraform.io and learn.microsoft.com). `primary` is not
     in the exclusion below; this must still fire. Value shape mirrors a real
     Azure key: base64 alphabet, 20+ chars, no separators a placeholder would
     use. */
  ['an azure-shaped primary key, not database vocabulary',
    'primary_key = xJ3AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfg==',
    ['E_SECRET_FOUND']],

  /* The first version of the ROW-100 exclusion checked only that the excluded
     word's `key` was not immediately followed by a LETTER, so `cache_key`
     followed by `.`, `_` or `-` and more identifier still satisfied the
     lookahead and was wrongly excluded too, even though it is not the WHOLE
     name the exclusion's own comment claims to require. This must fire: the
     name is `cache_key.signing_key`, not `cache_key`. */
  ['an excluded word followed by more identifier, not the whole name',
    'cache_key.signing_key = k9Xm2Qp7Rw4Tz8Bv1Nc5Hj3Ld6Fg0Ys',
    ['E_SECRET_FOUND']],

  /* The rules ported to the endpoint on 2026-08-18. Both sides must catch these,
     because on capture_path: browser there is no scrub.py and no preflight.py and
     this endpoint is the only mechanical gate a passport meets. */
  ['a database URL with a password', 'DATABASE_URL=postgres://appuser:Hunter2Hunter2@db.example.com:5432/prod',
    ['E_SECRET_FOUND']],
  ['a database URL without one',     'DATABASE_URL=postgres://db.example.com:5432/prod',   []],
  ['a plain https URL',              'See https://example.com/docs for detail.',           []],

  /* The URL-token rule, refit on 2026-08-30 for ROW-77. The old form tied the
     parameter to https?:// through \S{0,512}, and the bound was wrong twice: an
     astral path counts differently in Python (code points) and V8 (UTF-16
     units), so the two engines stood on opposite sides of it and the endpoint
     published what preflight refused; and any URL longer than the bound before
     its token parameter published through both. The rule is now anchored at the
     query delimiter with no scan run at all.

     The astral probe pins the cross-engine CLASS, not just this rule: any
     future quantifier bound over a class that can match astral characters
     splits the engines exactly here, and this is the probe that says so. These
     three refused nothing on main at 8ab975e; the control did. */
  ['a short URL with a short token',
    'See https://a.example/cb?token=abc123 for it.',                       ['E_SECRET_FOUND']],
  ['a token behind an astral path',
    'See https://a.example/' + '\u{1F600}'.repeat(300) + '/cb?token=abc123 for it.',
    ['E_SECRET_FOUND']],
  ['a token past 512 characters of URL',
    'See https://a.example/' + 'a'.repeat(600) + '/cb?token=abc123 for it.',
    ['E_SECRET_FOUND']],
  /* The thread's literal proposal, [^\s?&]*[?&], reaches only the FIRST query
     delimiter and would publish this. Anchoring at the delimiter reaches every
     parameter position. */
  ['a token as the second parameter',
    'https://a.example/cb?state=x&token=abc123',                           ['E_SECRET_FOUND']],
  /* What the delimiter anchor must NOT do. (?<=\S) is the whole difference
     between a leaked URL, whose parameter sits mid-run, and documentation
     naming the ?key=value convention after a space. The bare fragment is the
     accepted miss: the old rule missed it too (no scheme), and at 20+ value
     characters CREDENTIAL_ASSIGN takes it. */
  ['a query string with no credential', 'https://example.com/search?q=hello&page=2',        []],
  ['the ?key=value documentation phrase', 'append ?key=value to the URL of the request',    []],
  ['a bare token fragment after whitespace', 'the query was ?token=abc123 in the log',      []],

  /* SIGNED-URL SIGNATURES. The vocabulary held token|key|secret|auth|apikey|
     api_key|access_token and nothing else, so the single most credential-shaped
     URL in circulation published through both gates: a presigned URL's whole
     security IS its signature parameter, and the parameter is not called any of
     those seven things.

     The AWS probe deliberately uses ASIA rather than AKIA. An AKIA key id is
     caught by its own rule, so a probe carrying one measures that rule and
     reports success for this one. A control must fail the way the real thing
     fails.

     The vendor prefix is a bounded ASCII class, (?:[Xx]-[A-Za-z][A-Za-z0-9]{1,9}-)?,
     and not a list of clouds. A bound over a class that CANNOT match an astral
     character is cross-engine safe; the astral probe above is the one that says
     why that sentence has to be checked rather than assumed. The X-Ms probe
     names no vendor we wrote down and must still fire. */
  ['an AWS presigned URL, no key id in it',
    'https://b.s3.amazonaws.com/o.pdf?X-Amz-Credential=ASIAX%2F20260901&X-Amz-Date=20260901T090000Z&X-Amz-Signature=4f2a9c1de8b7360a5c1f9e0d2b8a7645',
    ['E_SECRET_FOUND']],
  ['an Azure SAS URL, bare sig=',
    'https://acct.blob.core.windows.net/c/b.txt?sv=2022-11-02&sp=r&sig=Kx8Qz%2Bm3Lp7Yv1Wq4Nd6Rf9Tg2Hj5Sc8Bn0Am3Zw%3D',
    ['E_SECRET_FOUND']],
  ['a bare signature= parameter',
    'https://api.example.com/v1/pay?ts=1756713600&signature=9d4f8c2b1e7a60539f8c2b1e7a60539f',
    ['E_SECRET_FOUND']],
  ['a signature under a vendor prefix nobody enumerated',
    'https://a.example/o?X-Ms-Signature=4f2a9c1de8b7360a5c1f9e0d2b8a7645',
    ['E_SECRET_FOUND']],
  /* What the widened vocabulary must NOT do. "sig" and "signature" are ordinary
     English words and the delimiter anchor is the whole defence. */
  ['the words sig and signature in prose',
    'The sig field is described in the signature section below.',          []],
  ['a signature parameter after whitespace',
    'the query was ?sig=abc123 in the log',                                []],

  /* WEBHOOK URLS. The path IS the credential: no parameter, no assignment, and
     possession of the URL is the whole authorisation, so every other rule in
     the table is blind to it. This is a list of vendors and it cannot be
     anything else, which makes the negatives the important half: the API
     documentation host, a workspace archive link and an invite link all live on
     the same domains and must publish. */
  ['a Slack trigger webhook',
    'https://hooks.slack.com/triggers/T012AB3CD/8912345678901/8f3c1a9b2d4e6f70a1b2c3d4e5f60718',
    ['E_SECRET_FOUND']],
  ['a Discord webhook',
    'https://discord.com/api/webhooks/1234567890123456789/aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9dE1fG3hI5jK7lM9nO1pQ',
    ['E_SECRET_FOUND']],
  ['a Teams incoming webhook',
    'https://acme.webhook.office.com/webhookb2/1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d@7e8f9a0b/IncomingWebhook/abc123def456',
    ['E_SECRET_FOUND']],
  ['the webhook API documentation host',
    'See https://api.slack.com/messaging/webhooks for the guide.',         []],
  ['a workspace archive link on the same domain',
    'Join the thread at https://acme.slack.com/archives/C012AB3CD',        []],
  ['an invite link on the same domain',
    'https://discord.com/invite/abcdefgh',                                 []],

  /* The four shapes a critic found publishing through the first version of this
     rule. Three are the same vendors already listed, reached by a path or a
     casing the pattern did not cover, which is the characteristic failure of a
     vendor list: the list looks complete and the matching is what is narrow.
     The Telegram bot token is a fifth vendor and a different shape again, the
     credential sitting in the path with no opaque tail after it. */
  ['a Discord webhook on the versioned API path',
    'https://discord.com/api/v10/webhooks/1234567890123456789/aB3dE5fG7hI9jK1lM3nO5pQ',
    ['E_SECRET_FOUND']],
  ['a Slack webhook with an uppercase host',
    'https://HOOKS.SLACK.COM/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
    ['E_SECRET_FOUND']],
  ['a Telegram bot token in the path',
    'https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALD/sendMessage',
    ['E_SECRET_FOUND']],
  ['the legacy Office 365 connector host',
    'https://outlook.office.com/webhook/1a2b3c4d-5e6f@7e8f9a0b/IncomingWebhook/abc123def456',
    ['E_SECRET_FOUND']],
  ['the Telegram documentation host, which carries no token',
    'Read https://core.telegram.org/bots/api for the reference.',           []],

  /* NON-ASCII. Every fixture and every other probe here is ASCII, so a whole class
     of divergence was unreachable by this harness: Python re and V8 disagree about
     \s on exactly U+001C-U+001F, U+0085 (Python only) and U+FEFF (V8 only), and the
     first four are already refused as control characters. The remaining two leaked
     in the dangerous direction, preflight refusing while the endpoint accepted, and
     they are what survives a copy-paste out of a browser chat window. Both sides now
     normalise before scanning; these probes are what notices if either stops. */
  ['a credential split by a BOM',    'DATABASE_URL=postgres://appuser:Hunter\uFEFF2Hunter2@db.example.com:5432/prod',
    ['E_SECRET_FOUND']],
  ['a token split by U+0085',        'AUTH_TOKEN=\u0085a3f9c2e1b7d4058a6c9e2f1a4b7d0c3e5f8a9b2c',
    ['E_SECRET_FOUND']],
  ['a BOM in innocent prose',        'The monkey\uFEFF ate a banana.',                      []],

  /* An astral password. Python counts code points and V8 counts UTF-16 units, so
     an upper bound straddles them: 200 emoji are 200 to one engine and 400 to the
     other. With {3,256} on the password, preflight REFUSED and the endpoint
     ACCEPTED, publishing a live credential. This is the axis the previous commit
     dismissed as making the endpoint stricter, which is true of a LOWER bound and
     false of an upper one. The upper bounds are gone; the scheme bound alone keeps
     the rule linear. */
  ['a password of astral characters',
    'DATABASE_URL=postgres://appuser:' + '\u{1F600}'.repeat(200) + '@db.example.com:5432/prod',
    ['E_SECRET_FOUND']],
  /* The probe that discriminates. A critic built the prefix-matching mutant of the
     placeholder exclusion, the one that silently missed a real credential, and ran
     it against all 897 string literals in this file, run-tests.mjs, every fixture
     and the example passport: NOTHING distinguished them. Reverting that fix would
     have left the whole harness green. The commit claiming "the two cases that
     exposed it are in the test set" was false; neither string was anywhere in the
     tree. This is one of them. */
  ['a real password beginning with an excluded word',
    'DATABASE_URL=postgres://svc:passw0rdOfMine123@prod-db.company.com/app',
    ['E_SECRET_FOUND']],
  /* ONE PROBE PER EXCLUSION BRANCH. A critic built five plausible-but-wrong
     exclusions and ran each against all 1253 string literals in this file, the two
     test suites, every fixture and the example: FOUR were invisible. The one that
     was caught was the bracket branch, which is the only branch a probe covered.
     The worst miss was the first-character defect reintroduced in the ANGLE branch
     instead of the bracket branch — the exact bug fixed at 8a4db00, in the
     neighbouring alternative, seen by nothing.

     A three-branch exclusion needs three probes. Covering one branch and calling it
     covered is the reach error on the instrument used to prove the fix. */
  ['a real password starting with a bracket',
    'DATABASE_URL=postgres://svc:[Str0ngP4ssw0rd@db.internal/prod',
    ['E_SECRET_FOUND']],
  ['a real password wrapped in brackets',
    'DATABASE_URL=postgres://svc:[Str0ngP4ssw0rd!]@db.internal/prod',
    ['E_SECRET_FOUND']],
  /* Both codes, and asserted as observed rather than as assumed: anything in angle
     brackets also reads as an unfilled template placeholder, on both sides. The
     secret rule firing is the part this probe is for. */
  ['a real password wrapped in angles',
    'DATABASE_URL=postgres://svc:<a3f9c2e1b7d4058a>@db.internal/prod',
    ['E_SECRET_FOUND', 'E_UNFILLED']],
  ['a real password starting with an asterisk',
    'DATABASE_URL=postgres://svc:*Str0ngP4ssw0rd@db.internal/prod',
    ['E_SECRET_FOUND']],
  ['a marker followed by more password',
    'DATABASE_URL=postgres://svc:[REDACTED]extra9@db.internal/prod',
    ['E_SECRET_FOUND']],
  /* And a bracketed USERNAME with a real password. The username lookahead was dead
     code: all three of its alternatives required an @ immediately after the marker,
     the pattern requires a : after the username, and the class cannot cross a :.
     Proven unreachable over 300,000 random strings with zero verdict differences.
     Deleted rather than repaired, on the rule the whole exclusion follows: the
     secret is the PASSWORD, and a bracketed username says nothing about it. */
  ['a bracketed username with a real password',
    'DATABASE_URL=postgres://[user]:hunter2Real@localhost:5432/db',
    ['E_SECRET_FOUND']],
  ['a redaction marker in brackets',
    'DATABASE_URL=postgres://svc:[REDACTED]@db.internal/prod',           []],
  ['a redaction marker in angles',
    'DATABASE_URL=postgres://svc:<password>@db.internal/prod',           ['E_UNFILLED']],
  ['a redaction of asterisks',
    'DATABASE_URL=postgres://svc:****@db.internal/prod',                 []],

  /* SHELL INTERPOLATION, one probe per branch of the exclusion added 2026-08-23.
     A connection string whose credential position is ${VAR} or $VAR carries the
     NAME of a secret and none of its value, which is the product's first rule
     stated literally. The rule refused both until today, so the gate told a
     stranger at a public door to rotate a credential that does not exist.
     One probe per alternation branch, because a single probe would pass while
     the other branch rotted. */
  ['a braced shell interpolation',
    'DATABASE_URL=postgres://${PGUSER}:${PGPASSWORD}@${PGHOST}:5432/app',  []],
  ['a bare-dollar shell interpolation',
    'DATABASE_URL=postgres://$DB_USER:$DB_PASSWORD@$DB_HOST/app',          []],
  /* The counterexample that keeps the exclusion honest. A weak password is still
     a password: commit 8a4db00 established that and a proposal to exclude bare
     `password` and `changeme` was withdrawn on 2026-08-23 because it would have
     published exactly this line. If this probe ever goes quiet, that revert has
     happened by accident. */
  ['a weak but live password on a production host',
    'DATABASE_URL=postgres://admin:password@prod-db.example.com/prod',
    ['E_SECRET_FOUND']],

  ['a password over 256 characters',
    'DATABASE_URL=postgres://appuser:' + 'a'.repeat(300) + '@db.example.com:5432/prod',
    ['E_SECRET_FOUND']],

  /* Documentation forms the database rule must not refuse. It had no placeholder
     exclusion at all and fired on the canonical postgresql://<user>:<password>@<host>
     shape, at a door where the stranger cannot see the rule. */
  /* Refused by BOTH, but as E_UNFILLED rather than E_SECRET_FOUND: angle-bracket
     placeholders are what an unfinished capture leaves behind, and a passport
     should not carry them whatever they contain. Asserted as what actually
     happens rather than as what I first assumed, which was that it passed clean. */
  ['the canonical doc connection string', 'postgresql://<user>:<password>@<host>:<port>/<database>',
    ['E_UNFILLED']],
  /* These two FIRE now, and that is the correction rather than a regression.
     They were asserted clean on the reasoning that a weak or repeated password is
     a documentation tell. It is not: guest:guest is RabbitMQ's shipped default,
     root:root and postgres:postgres are MySQL's and Postgres's, and pointed at a
     production host each is a live credential. The exclusion list that suppressed
     them was silently missing ten real credential shapes. Only redaction markers
     are excluded now, matched as whole tokens. */
  ['an upper-case doc form',         'postgres://USER:PASSWORD@HOST:5432/DBNAME',          ['E_SECRET_FOUND']],
  ['a hand-redacted password',       'postgres://appuser:[REDACTED]@db.example.com/prod',  []],
  ['a shipped default credential',   'amqp://guest:guest@rabbitmq:5672/',                  ['E_SECRET_FOUND']],
  ['an ssh remote, not a credential','git@github.com:org/repo.git',                        []],

  /* The only rule in either table that can span a line break, and it broke today.
     `a password assignment` is /\b(password|passwd|pwd)\s*[:=]\s*\S+/i and `\s`
     matches a NEWLINE, so a wrapped assignment is one match over the body and no
     match on either line alone.

     preflight.py has always scanned the whole document. The site was changed to
     scan per line while adding line numbers to E_SECRET_FOUND, which silently
     stopped catching this: preflight refused it, the endpoint published it, and
     parity exited 0 because no probe covered a secret spanning a newline. That
     is preflight lying about the endpoint again, which is the thing this file
     exists to prevent, arriving through the one shape it had no example of.

     Both must catch it. If a future change evaluates either side per line, this
     is what says so. */
  ['a password wrapped to the next line', 'password:\n  Hunter2Hunter2Secret',  ['E_SECRET_FOUND']],
  ['a password with a tab continuation',  'passwd:\n\tHunter2Hunter2Secret',    ['E_SECRET_FOUND']],
];

/* The vendor-prefix vectors, added 2026-08-31 for ROW-108, read from
   tools/fixtures/vendor_probes.json rather than written here.

   Two reasons, and neither is tidiness. First, .gitleaks.toml allowlists
   tools/fixtures/ and nothing else for deliberately fake credentials; a
   sk_live_ literal in this file is a real secret as far as the scanner can
   tell, and the remedy of widening the allowlist to cover a directory of live
   code is explicitly forbidden by that file. Second, the same JSON is read by
   tools/run_tests.sh on the Python side, so a vector added there is checked in
   both engines or in neither.

   That second property is the point. This file's own stage compares regex
   SOURCE and flags, so two engines can hold byte-identical patterns and still
   disagree on a string: Python's \b is Unicode-aware and V8's, without /u, is
   not, which is ROW-109. Pushing one set of strings through both engines is the
   only check here that can see a divergence of that class. It is why the eight
   new rules use explicit ASCII lookarounds rather than \b, and these vectors
   are what says so if somebody changes one back. */
const probeFiles = [
  ['vendor', '../../tools/fixtures/vendor_probes.json'],
  /* The non-vendor secret vectors, added 2026-09-01 for ROW-131 item 1. A
     sibling file rather than more rows above, because that file is named for
     the vendor-prefix rules and a password assignment is not one; a vector
     filed under a name that does not describe it is a vector nobody finds when
     they change the rule it belongs to. Same shape, same contract, same
     both-engines-or-neither property. */
  ['secret', '../../tools/fixtures/secret_probes.json'],
];
for (const [prefix, rel] of probeFiles) {
  const file = fileURLToPath(new URL(rel, import.meta.url));
  const vectors = JSON.parse(await readFile(file, 'utf8'));
  /* Three groups, not two. known_false_positives holds ordinary content the
     password rule refuses today, pinned in the FIRING direction so that a change
     which starts or stops refusing one lands here instead of going green. It is
     optional: vendor_probes.json has none. See the file's own _why. */
  for (const [group, expected] of [['must_fire', ['E_SECRET_FOUND']], ['must_not_fire', []],
                                   ['known_false_positives', ['E_SECRET_FOUND']]]) {
    for (const [label, body] of Object.entries(vectors[group] ?? {})) {
      /* Any _-prefixed key is a note. This used to skip the literal '_note'
         only, so a second note in one file was run as a probe and asserted on. */
      if (label.startsWith('_')) continue;
      PROBES.push([`${prefix} ${group}: ${label}`, body, expected]);
    }
  }
}
const tmp = await mkdtemp(join(tmpdir(), 'preflight-probe-'));
let probed = 0;
let diverged = 0;
for (const [label, body, want] of PROBES) {
  const agreed = Array.isArray(want);
  if (!agreed && !want.why) {
    failures++;
    console.log(`   ✗ stage 3 probe "${label}": a divergence must carry a why`);
    continue;
  }
  const wantSite = agreed ? want : want.site;
  const wantPre = agreed ? want : want.preflight;
  const siteCodes = [...new Set((validate(body).errors || [])
    .map(e => e.code).filter(c => STAGE3.has(c)))].sort();
  const file = join(tmp, 'probe.md');
  await writeFile(file, body, 'utf8');
  let preCodes = [];
  try {
    const { stdout } = await run('python3', [PREFLIGHT, '--codes', file]);
    preCodes = stdout.trim() ? stdout.trim().split('\n') : [];
  } catch (e) {
    preCodes = String(e.stdout || '').trim() ? String(e.stdout).trim().split('\n') : [];
  }
  preCodes = [...new Set(preCodes)].sort();
  if (norm(siteCodes) !== norm([...wantSite].sort()) ||
      norm(preCodes) !== norm([...wantPre].sort())) {
    failures++;
    console.log(`   ✗ stage 3 probe "${label}": want site ${JSON.stringify(wantSite)} ` +
                `preflight ${JSON.stringify(wantPre)}, got ` +
                `site ${JSON.stringify(siteCodes)}, preflight.py ${JSON.stringify(preCodes)}`);
    continue;
  }
  if (agreed) probed++;
  else {
    diverged++;
    console.log(`   ! stage 3 probe "${label}": the two disagree as recorded. ${want.why}`);
  }
}
console.log(`   ${probed} stage 3 probes agree with both implementations`);
if (diverged) console.log(`   ${diverged} recorded divergences between preflight.py and the site`);

/* Stage 4, the rule INVENTORY, which is the check that would have caught this
   repository's actual failure without anyone anticipating it.

   Everything above compares BEHAVIOUR on content somebody thought to write down:
   27 fixtures and a hand-written probe list. A rule added to one implementation
   and not the other is invisible to all of it unless the person adding the rule
   also adds an example that exercises it. That is precisely what did not happen.
   preflight.py gained a credential-assignment rule at addcb11, _validate.mjs
   never did, and this file printed 0 failures for a day.

   So compare the LISTS, not only their behaviour. preflight.py prints its labels
   with --list-secret-rules, and _validate.mjs EXPORTS its SECRETS table which
   this file imports. It used to be read out of the source text, which counted a
   commented-out rule as live and let a disabled rule pass as present; that is
   fixed, and this sentence is kept accurate deliberately, because the file whose
   job is stopping stale beliefs should not carry one.

   The point is that this fails for a rule nobody wrote a test for. Closing a gap
   means editing the table below, which is where the reason is written down. */
const ALLOWED_RULE_DIVERGENCE = [
  /* Empty, and that is the point rather than an accident. Both entries that
     lived here were closed on 2026-08-18 when the credential rule and the
     SendGrid rule were ported to _validate.mjs. The staleness check below is
     what forced this edit: an entry that stops being true fails the build, so
     closing a gap cannot be done without coming here and saying so. */
];

/* The site's list comes from IMPORTING the module, not from reading its source.
   The source-text version of this had a silent wrong-pass and it was the exact
   failure this stage exists to prevent: a rule commented out, which is how
   anybody disables one, still matched the source and was still counted, so this
   printed "10 in the site" while validate() had stopped catching Slack tokens.
   Stages 1 to 3 could not see it either, because no fixture and no probe carries
   one. Reading the executable table removes the guess. */
const preRules = (await run('python3', [PREFLIGHT, '--list-secret-rules'])).stdout
  .trim().split('\n').filter(Boolean);
const siteRules = SECRETS.map(([label]) => label);

if (!siteRules.length) {
  failures++;
  console.log('   ✗ _validate.mjs exported an empty SECRETS table. A silent zero here ' +
              'would restore exactly the blindness this stage exists to remove.');
} else {
  const allowed = new Map(ALLOWED_RULE_DIVERGENCE.map(d => [d.rule, d]));
  const onlyPre = preRules.filter(r => !siteRules.includes(r));
  const onlySite = siteRules.filter(r => !preRules.includes(r));
  for (const [list, side, other] of [[onlyPre, 'preflight.py', 'the site'],
                                     [onlySite, 'the site', 'preflight.py']]) {
    for (const rule of list) {
      const d = allowed.get(rule);
      if (d && d.side === side) continue;
      failures++;
      console.log(`   ✗ secret rule "${rule}" exists in ${side} and not in ${other}, ` +
                  `and is not in ALLOWED_RULE_DIVERGENCE. Add it to both, or record why not.`);
    }
  }
  /* A reworded label looks exactly like one rule deleted and another added, and
     both remedies printed above are then WRONG: "add it to both" duplicates a
     rule that already exists, and "record why not" writes a divergence that is
     not true, which the staleness check below then requires to persist forever.
     That would cement the blindness this stage removes. So say so when the shape
     of the failure is a rename. */
  if (onlyPre.length && onlySite.length) {
    console.log(`   ! both sides have unmatched rules, so this may be a RENAME rather than ` +
                `a missing rule: preflight has ${JSON.stringify(onlyPre)}, the site has ` +
                `${JSON.stringify(onlySite)}. If you reworded a label, change it on BOTH ` +
                `sides. Do not add an ALLOWED_RULE_DIVERGENCE entry for a rule that exists ` +
                `in both; the entry would have to stay forever to keep this green.`);
  }
  for (const d of ALLOWED_RULE_DIVERGENCE) {
    const stillApart = (d.side === 'preflight.py' ? onlyPre : onlySite).includes(d.rule);
    if (!stillApart) {
      failures++;
      console.log(`   ✗ recorded divergence "${d.rule}" no longer exists. Delete its entry ` +
                  `from ALLOWED_RULE_DIVERGENCE.`);
    }
  }
  console.log(`   ${preRules.length} secret rules in preflight.py, ${siteRules.length} in the site, ` +
              `${ALLOWED_RULE_DIVERGENCE.length} recorded divergences`);

  /* And compare the PATTERNS, not only the names. Comparing labels alone let the
     two implementations hold the same rule name over different regexes: loosening
     the site's value bar from {20,} to {8,} made the endpoint refuse
     API_KEY=shortval while preflight accepted it, which is preflight lying about
     the endpoint, and this file exited 0 reporting 13 rules both sides and 28
     probes agreeing. A name is not a rule.

     Sources are compared after normalising one difference that is spelling rather
     than meaning: a JS regex literal escapes / and a Python pattern does not. All
     13 shared rules are byte-identical under that normalisation today, so the
     allowance table below is empty and should stay that way. */
  const PATTERN_MAY_DIFFER = [
    // { rule: '...', why: '...' }
  ];
  const pyDump = JSON.parse((await run('python3', [PREFLIGHT, '--dump-secret-rules'])).stdout);
  const unescapeSlash = s => s.replace(/\\\//g, '/');
  /* All the flags, not one. The dump carried `source` and ignoreCase only, so
     Python's X, S and M and JS's s, m and u were invisible to it. Demonstrated by a
     critic: adding re.X to the private-key rule in preflight alone leaves the source
     byte-identical, this check prints "0 recorded divergences", and preflight stops
     matching a real -----BEGIN RSA PRIVATE KEY----- header because VERBOSE eats the
     spaces. It was caught only because a stage-3 probe for that rule happens to
     exist. That is the same shape as the label-versus-pattern gap this dump was
     added to close, one level down. */
  for (const [label, re] of SECRETS) {
    const py = pyDump[label];
    if (!py) continue;                       // absence is the label check's job, above
    const excused = PATTERN_MAY_DIFFER.find(d => d.rule === label);
    const sameSrc = unescapeSlash(re.source) === unescapeSlash(py.source);
    /* Three flags exist on both sides and mean the same thing: i, s, m. Two exist
       on one side only, and they are NOT counterparts: Python's X (verbose) has no
       JS equivalent, and JS's u (unicode) has no Python one. An earlier version of
       this check mapped X into the u slot, which reported a verbose Python pattern
       as "u differs" and was a false statement in a message about correctness.
       Either flag being set is a divergence by construction, since the other side
       cannot express it, so both must be off. */
    const jsFlags = { i: re.ignoreCase, s: re.dotAll, m: re.multiline };
    const pyFlags = { i: !!py.i, s: !!py.s, m: !!py.m };
    const shared = JSON.stringify(jsFlags) === JSON.stringify(pyFlags);
    const oneSided = py.x ? 'preflight uses re.X, which JS cannot express' :
                     py.a ? 'preflight uses re.ASCII, which changes what \\w, \\b and \\s mean' :
                     re.unicode ? 'the site uses /u, which Python cannot express' : null;
    const sameFlag = shared && !oneSided;
    if (sameSrc && sameFlag) continue;
    if (excused) { console.log(`   ! secret rule "${label}" differs by pattern, recorded: ${excused.why}`); continue; }
    failures++;
    console.log(`   \u2717 secret rule "${label}" has the same NAME and a different PATTERN in the two ` +
                `implementations. ${sameSrc ? (oneSided ? oneSided + '.' : 'Flags differ: ' + JSON.stringify(jsFlags) + ' against ' + JSON.stringify(pyFlags) + '.') : 'The sources differ.'} ` +
                `preflight.py and the endpoint must refuse the same content; a name in common is not that.`);
  }
  console.log(`   ${SECRETS.filter(([l]) => pyDump[l]).length} shared rules compared by pattern, not just by name`);

  /* ReDoS at the endpoint, in V8, which is where the exposure actually is.
     tools/run_tests.sh benchmarks scrub.py in Python. Benchmarking Python and
     concluding about V8 is the cross-engine inference this whole file exists to
     stop, and it inverts the risk: a stall in Python is a slow capture on the
     owner's machine, a stall in V8 is a public endpoint held open on
     attacker-controlled input. V8 also has the required-character optimisation
     that made a critic's first six ReDoS attempts look linear against a rule that
     was genuinely quadratic.

     Same seeds as the Python side, read from the same file, so the two engines are
     measured against identical shapes rather than each against its author's idea of
     a bad input. */
  const seedFile = fileURLToPath(new URL('../../tools/fixtures/redos_seeds.json', import.meta.url));
  const seeds = JSON.parse(await readFile(seedFile, 'utf8')).seeds;
  /* A SCALING check, not a millisecond ceiling. An absolute threshold is
     machine-dependent and seed-length-dependent: the scheme-bound regression below
     reads 319ms at 32KB, under a 1000ms gate, and only crosses it at 64KB. Quadratic
     is a RATIO, so measure the same seed at N and 2N and fail on the ratio. That
     detects super-linearity regardless of machine, constant factor or how long
     somebody happened to make the seed. The ceiling is kept as a second, coarser
     net for anything pathological at a single size. */
  const SEED_N = 16384, SEED_RATIO_MAX = 3.0, SEED_CEILING_MS = 1000;
  const timeOn = (re, motif, n) => {
    const s = motif.repeat(Math.ceil(n / motif.length)).slice(0, n);
    const t0 = process.hrtime.bigint(); re.test(s);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  let seedWorstRatio = 0, seedWho = '', seedWorstMs = 0, seedMsWho = '';
  for (const [label, re] of SECRETS) {
    for (const [name, motif] of Object.entries(seeds)) {
      const a1 = timeOn(re, motif, SEED_N), a2 = timeOn(re, motif, SEED_N * 2);
      if (a2 > seedWorstMs) { seedWorstMs = a2; seedMsWho = label + ' / ' + name; }
      // ignore ratios on timings too small to be signal rather than noise
      if (a1 < 0.5) continue;
      const ratio = a2 / a1;
      if (ratio > seedWorstRatio) { seedWorstRatio = ratio; seedWho = label + ' / ' + name; }
    }
  }
  if (seedWorstRatio > SEED_RATIO_MAX) {
    failures++;
    console.log(`   \u2717 ReDoS: "${seedWho}" scales x${seedWorstRatio.toFixed(1)} when the input doubles. ` +
                `Linear is x2. This runs at the public endpoint on attacker-controlled input.`);
  } else if (seedWorstMs > SEED_CEILING_MS) {
    failures++;
    console.log(`   \u2717 ReDoS: "${seedMsWho}" took ${seedWorstMs.toFixed(0)}ms at ${SEED_N * 2 / 1024}KB in V8.`);
  } else {
    console.log(`   ${SECRETS.length} endpoint rules x ${Object.keys(seeds).length} ReDoS seeds in V8, ` +
                `worst scaling x${seedWorstRatio.toFixed(1)} (linear is x2), worst ${seedWorstMs.toFixed(1)}ms`);
  }

  /* What this still cannot see, printed rather than filed, because the moment to
     say it is while the harness is being trusted most.

     Three layers now: stage 3 compares BEHAVIOUR on content somebody thought to
     write down, the label check compares MEMBERSHIP, and the dump above compares
     THE RULES THEMSELVES. Each caught what the previous one could not.

     Identical patterns are still not identical behaviour. Python re and V8
     disagree about \s, \b and what {n,} counts, so the same text can mean two
     things. That was not theory: a BOM inside a password made preflight refuse and
     this endpoint accept, publishing a live credential, with every layer above
     green. Both sides normalise now and three probes cover it, but the general
     case is bounded by what the probes contain.

     And nothing here proves the rules are RIGHT. Parity proves the two sides
     agree. Two implementations of the same wrong rule agree perfectly. */
  console.log('   NOTE: this proves the two sides AGREE, never that they are right,');
  console.log('         and identical patterns can still behave differently across engines.');

  /* The THIRD table. tools/scrub.py was outside this comparison while the other
     two were inside it, which is the same blindness one table over, and it was
     missing three of preflight's rules. The consequence is not a leak: a PEM
     block still cannot publish, because preflight and the endpoint both catch
     it. It is that the OWNER-FACING gate is silent about the least ambiguous
     credential there is, on the gate SKILL.md presents as where the owner
     reviews what was found. A trust defect rather than a leak, and worth saying
     that way round.

     scrub.py names its rules in its own vocabulary, so this is an explicit map
     rather than string equality. Mapping a new rule is one line, and the point
     is that adding a rule to one table without deciding about the other becomes
     impossible rather than merely unlikely. */
  const SCRUB_TO_PREFLIGHT = {
    ANTHROPIC_KEY: 'an Anthropic key',
    OPENAI_KEY: 'an OpenAI style key',
    AWS_KEY: 'an AWS access key id',
    GITHUB_TOKEN: 'a GitHub token',
    JWT: 'a JWT',
    TOKEN_URL: 'a URL carrying a credential',
    WEBHOOK_URL: 'a webhook URL carrying its own secret',
    PASSWORD_ASSIGN: 'a password assignment',
    SENDGRID_KEY: 'a SendGrid key',
    DB_URL: 'a database URL carrying a password',
    CREDENTIAL_ASSIGN: 'a credential assignment',
    /* Added 2026-08-23, closing a real gap rather than recording one. A PEM
       private key block, a Slack token, a Google API key and a fine-grained
       GitHub token all passed scrub.py untouched, because this file was the
       only place the three rule sets were compared and scrub.py had never been
       brought level. The scrubber is what runs during capture, so those four
       formats were leaving a machine unredacted. */
    GOOGLE_KEY: 'a Google API key',
    SLACK_TOKEN: 'a Slack token',
    PRIVATE_KEY_BLOCK: 'a private key block',
    /* scrub-only, and deliberately so: these redact personal data from the
       owner's own capture. They are not credentials and the gates downstream
       have no business refusing an upload over them.

       READ THE GAP BELOW BEFORE TRUSTING THIS ENTRY. `EMAIL: null` is true of
       what this rule is FOR and false of one shape it actually catches, and a
       null here was quietly doing two jobs: recording a decision about personal
       data, and absorbing an undecided gap about database connection strings.
       Those are separated now. */
    EMAIL: null,
    IPV4: null,
    /* The vendor prefixes added 2026-08-31 for ROW-108. All eight landed in all
       three tables in the same commit, so this map needed no gap entry and
       SCRUB_MAY_LACK stays empty. */
    NOTION_TOKEN: 'a Notion integration token',
    NOTION_LEGACY_TOKEN: 'a legacy Notion integration token',
    STRIPE_KEY: 'a Stripe secret key',
    SLACK_WEBHOOK: 'a Slack webhook URL',
    HUGGINGFACE_TOKEN: 'a Hugging Face token',
    LINEAR_KEY: 'a Linear API key',
    AIRTABLE_TOKEN: 'an Airtable personal access token',
  };
  /* Credential classes NOTHING in this system covers, recorded because a gap
     that is written down is a decision and a gap that is not is an accident.
     This list is not checked mechanically: there is no rule to compare. It is
     here because this is the file somebody reads when asking what the gates
     catch, and the honest answer includes what they do not. */
  const UNCOVERED = [
    /* Empty. 'a database URL carrying a password' was here until 2026-08-18 and
       is now a named rule in all three tables. It was the one credential class
       nothing caught: scrub's EMAIL rule hit it by accident on the user:pass@host
       middle, and a form with no @-shaped middle was caught nowhere at all. */
  ];

  if (UNCOVERED.length) {
    console.log(`   ! ${UNCOVERED.length} credential class(es) recorded as covered by nothing: ` +
                UNCOVERED.map(u => u.what).join('; '));
  }
  /* Rules preflight has that scrub does not, each with the reason. Same contract
     as ALLOWED_RULE_DIVERGENCE above: an entry that stops being true fails. */
  /* Rules preflight has that scrub does not, each with the reason. Same contract
     as ALLOWED_RULE_DIVERGENCE above: an entry that stops being true fails.

     EMPTIED 2026-08-23. It held three entries, and one of them said outright
     "NOT covered by anything in scrub. The owner-facing gate is silent on it."
     That is a recorded gap doing the job of a fix: the scrubber is what runs
     during capture, so a PEM private key block, a Slack token and a Google API
     key were leaving the owner's machine unredacted while this list made the
     situation look managed. All three rules are in scrub.py now. Keep this
     array empty unless a gap is genuinely undecidable, and prefer closing one
     to describing one. */
  const SCRUB_MAY_LACK = [];
  const scrubRules = (await run('python3', [SCRUB, '--list-rules'])).stdout
    .trim().split('\n').filter(Boolean);
  const unmapped = scrubRules.filter(r => !(r in SCRUB_TO_PREFLIGHT));
  for (const r of unmapped) {
    failures++;
    console.log(`   ✗ scrub.py rule "${r}" is not in SCRUB_TO_PREFLIGHT. Map it to its ` +
                `preflight name, or to null if it is not a credential rule.`);
  }
  /* And the other direction, which was unchecked: a mapping to a preflight rule
     that does not exist records a false correspondence and passes. A typo fails
     today only by accident, because the real rule is then uncovered; a mapping to
     a name that exists nowhere failed silently. */
  for (const [scrubRule, preName] of Object.entries(SCRUB_TO_PREFLIGHT)) {
    if (preName === null || preRules.includes(preName)) continue;
    failures++;
    console.log(`   \u2717 SCRUB_TO_PREFLIGHT maps "${scrubRule}" to "${preName}", which is not a ` +
                `rule in preflight.py. Fix the name, or map it to null if it is not a credential rule.`);
  }
  const scrubCovers = new Set(scrubRules.map(r => SCRUB_TO_PREFLIGHT[r]).filter(Boolean));
  const lacking = new Set(SCRUB_MAY_LACK.map(d => d.rule));
  for (const rule of preRules) {
    if (scrubCovers.has(rule) || lacking.has(rule)) continue;
    failures++;
    console.log(`   ✗ preflight.py has secret rule "${rule}" and scrub.py has nothing mapped ` +
                `to it. Add it to scrub, or record it in SCRUB_MAY_LACK with a reason.`);
  }
  for (const d of SCRUB_MAY_LACK) {
    if (!preRules.includes(d.rule)) {
      failures++;
      console.log(`   ✗ SCRUB_MAY_LACK names "${d.rule}", which preflight.py no longer has. ` +
                  `Delete the entry.`);
    } else if (scrubCovers.has(d.rule)) {
      failures++;
      console.log(`   ✗ scrub.py now covers "${d.rule}". Delete its SCRUB_MAY_LACK entry.`);
    }
  }
  console.log(`   ${scrubRules.length} rules in scrub.py, ${SCRUB_MAY_LACK.length} recorded gaps ` +
              `against preflight.py`);

  /* high_entropy_hits, added to _metrics.mjs on 2026-08-31, is a THIRD
     implementation of scrub.py's HIGH_ENTROPY rule, in a third language. The
     other two are compared above; this one had nothing comparing it, which is
     the exact shape of every drift this file exists to catch. A duplicated rule
     with nothing comparing it is a rule that drifts.

     Compared by BEHAVIOUR on a shared input, not by reading the two sources and
     agreeing they look alike. The input is built so that no NAMED scrub rule
     fires on it, because scrub applies its named patterns first and the entropy
     backstop then runs over the already-redacted text: on an input where both
     fire, the two counts differ for a legitimate reason and the comparison
     would be measuring the ordering rather than the rule.

     The near-miss cases are the half that matters. A port that dropped the
     lower-plus-upper-plus-digit gate would count the git hash and the uuid, and
     the metrics trigger in record/proposals/high-entropy-gate.md reads this
     number as a DENOMINATOR: over-counting there would make the backstop look
     unaffordable and defer it a second time, on an artefact rather than on a
     measurement. */
  const entropyInput = [
    'Three that must count, mixed case with digits:',
    'aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uVzz',
    'zQ7wE2rT5yU8iO1pA4sD6fG9hJ3kL0zXqq',
    'Xy9Zw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fedc',
    '',
    'Four that must not, single case or digitless, the shapes the gate exists to keep:',
    'abcdef1234567890abcdef1234567890abcdef12',
    '550e8400-e29b-41d4-a716-446655440000',
    'this-is-a-long-lowercase-slug-value-that-exceeds-thirty-two-chars',
    'ABCDEF1234567890ABCDEF1234567890ABCDEF12',
    ''
  ].join('\n');
  const entTmp = await mkdtemp(join(tmpdir(), 'entropy-parity-'));
  const entIn = join(entTmp, 'in.md');
  const entOut = join(entTmp, 'out.md');
  const entRep = join(entTmp, 'report.json');
  await writeFile(entIn, entropyInput, 'utf8');
  try { await run('python3', [SCRUB, entIn, entOut, entRep]); } catch { /* scrub exits non-zero when it finds things */ }
  const scrubReport = JSON.parse(await readFile(entRep, 'utf8'));
  const scrubEntropy = scrubReport.counts.HIGH_ENTROPY || 0;
  const { highEntropyHits } = await import('../lib/_metrics.mjs');
  const jsEntropy = highEntropyHits(entropyInput);
  if (scrubEntropy !== jsEntropy) {
    failures++;
    console.log(`   ✗ high_entropy_hits in _metrics.mjs counts ${jsEntropy} where scrub.py's ` +
                `HIGH_ENTROPY counts ${scrubEntropy} on the same input. They are one rule in two ` +
                `languages and the metrics trigger reads the JS one as a denominator.`);
  } else if (jsEntropy !== 3) {
    failures++;
    console.log(`   ✗ both implementations count ${jsEntropy} on an input built to contain ` +
                `exactly 3 high-entropy strings and 4 near misses. They agree and they are both ` +
                `wrong, which agreement alone cannot detect.`);
  } else {
    console.log(`   high_entropy_hits agrees with scrub.py's HIGH_ENTROPY: ${jsEntropy} counted, ` +
                `4 near misses kept, compared by behaviour on a shared input`);
  }
}

/* scalar() means the same thing in both languages ------------------------- */
/* Each side turns a regex-captured YAML scalar into its value. They are the
   same gate at two different doors, and nothing compared them until a
   divergence was found by hand on 2026-09-03: the Python side stripped any
   number of quotes of either kind from both ends, so it read "'x'" as x where
   this side reads it as 'x'. That is the permissive direction, which is the bad
   one: the local validator says PASS and the publish path refuses, and the
   owner is told nothing that explains it.

   The probe list lives in tools/fixtures/scalar_probes.json so that neither
   side owns it and adding a case cannot be done for one engine only. */
{
  const { scalar } = await import('../lib/_validate.mjs');
  const PROBES = fileURLToPath(
    new URL('../../tools/fixtures/scalar_probes.json', import.meta.url));
  const probes = JSON.parse(await readFile(PROBES, 'utf8')).probes;
  const pyOut = JSON.parse((await run('python3', [PY, '--dump-scalar'])).stdout);
  const jsOut = probes.map(scalar);
  const diff = probes
    .map((p, i) => [p, pyOut[i], jsOut[i]])
    .filter(([, a, b]) => a !== b);
  if (pyOut.length !== probes.length) {
    failures++;
    console.log(`   \u2717 validate.py --dump-scalar returned ${pyOut.length} results for ` +
                `${probes.length} probes, so the two lists cannot be compared.`);
  } else if (diff.length) {
    failures++;
    console.log(`   \u2717 scalar() disagrees between tools/validate.py and web/lib/_validate.mjs ` +
                `on ${diff.length} of ${probes.length} probes. A passport one gate accepts and ` +
                `the other refuses is a passport nobody can publish for a reason no message gives:`);
    for (const [p, a, b] of diff.slice(0, 6)) {
      console.log(`       ${JSON.stringify(p)}  python ${JSON.stringify(a)}  js ${JSON.stringify(b)}`);
    }
  } else {
    console.log(`   scalar() agrees in both languages over ${probes.length} probes, ` +
                `including unbalanced and doubled quotes`);
  }
}

process.exit(failures ? 1 : 0);
