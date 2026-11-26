#!/usr/bin/env node
/* The capture prompt scan (E3 design section 5; test-plan case 32). A gate in scripts/check.sh over
   capture/enterprise.md, the interview prompt an employee pastes into their own assistant.

   It refuses:
     1. a publisher literal, after the same folding the intake gate's route scan uses, over the whole text:
        normalizeForbidden() of lib/passport/assemble.mjs, so there is one folder and not two. The literals are the four E0
        public routes (PUBLIC_ROUTES of lib/passport/rules.mjs, the one list) plus /share, publish.py,
        scripts/publish.py, upload box and app.phaeacia.ai, which is the E0 scanner's list and the upstream
        share command;
     2. the words upload, publish and share outside the parts allowed to use them (ALLOWED below, each
        with its reason), so an instruction to publish cannot be added to a step that has no business
        giving one;
     3. a final step that does not name the local file and the enterprise upload, or a step 1 without the
        enterprise disclosure, or a stop-condition rule without the intake refusal by line number;
     4. a frontmatter template or section list in step 9 that no longer matches the pinned
        vendor/passport/spec/passport-0.1.md, and a step 9 checklist whose key and heading counts disagree
        with it, so a prompt that drifts from the format the gate enforces fails the build rather than the
        owner's upload.
   It records the file's SHA-256 in .scratch/check/capture.json and prints it, so a change to the prompt is
   visible in the acceptance record.

   What it cannot prove: that an assistant follows the prompt, that the owner saves rather than pastes the
   file elsewhere, or that the assistant's provider does not retain the conversation (design 5).

   Design 2.1 says this script needs nothing beyond node built-ins, while section 5 says it calls
   normalizeForbidden so there is one folder; this follows section 5.

   Exit 0 clean, 2 on findings. --file <path> scans another file (tests). */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeForbidden } from '../lib/passport/assemble.mjs';
import { PUBLIC_ROUTES } from '../lib/passport/rules.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CAPTURE = 'capture/enterprise.md';
const SPEC = 'vendor/passport/spec/passport-0.1.md';

export const LITERALS = Object.freeze([
  ...new Set([...PUBLIC_ROUTES, '/share', 'scripts/publish.py', 'publish.py', 'upload box', 'app.phaeacia.ai']),
]);

/* Where each restricted word may appear, by part of the prompt, and why. A part is the text before the first
   heading ("preamble"), "rules", "evidence", or "step N". */
export const ALLOWED = Object.freeze({
  upload: Object.freeze({
    rules: 'R5 forbids asking for file uploads; R7 names the enterprise site refusing the uploaded file',
    'step 1': 'the disclosure that the owner uploads the finished file and the assistant does not',
    'step 2': 'the question whether the agent uses uploaded knowledge files',
    'step 3': 'a file without golden examples is rejected on upload',
    'step 6': 'the upload validator rejects a comparison without state',
    'step 7': 'unreviewed redactions are rejected on upload',
    'step 9': 'the checklist is the upload validator, and the pinned placeholder comment says upload',
    'step 10': 'the owner uploads the local file to the enterprise site; the assistant does not upload',
  }),
  publish: Object.freeze({
    'step 10': 'the assistant is told not to publish or invoke a publisher',
  }),
  share: Object.freeze({}),
});

const HEADING = /^(RULES THAT HOLD THROUGHOUT|THE EVIDENCE RULE\b.*|STEP (\d+)\. .*)$/;
const WORD = /(?<![a-z])(upload|publish|share)/g;
const NUMBER_WORDS = Object.freeze({ six: 6, seven: 7, eight: 8, nine: 9, ten: 10 });

/** The prompt split into named parts: [{ part, start, lines }] with start the 1-based line of the part's
    first line. */
export function parts(text) {
  const out = [{ part: 'preamble', start: 1, lines: [] }];
  text.split('\n').forEach((line, i) => {
    const m = HEADING.exec(line);
    if (m) {
      const part = m[2] ? `step ${m[2]}` : m[1].startsWith('RULES') ? 'rules' : 'evidence';
      out.push({ part, start: i + 1, lines: [line] });
    } else out[out.length - 1].lines.push(line);
  });
  return out;
}

/* The pinned spec: the six section headings of section 1 and the frontmatter keys of section 2. */
export function specShape(specText) {
  const lines = specText.split('\n');
  const at = (heading) => lines.findIndex((l) => l === heading);
  /* After the "## 1. File shape" line itself, which has the same shape as the headings it lists. */
  const shape = lines.slice(at('## 1. File shape') + 1, at('## 2. Frontmatter'));
  const headings = shape.filter((l) => /^## \d\. /.test(l));
  const table = lines.slice(at('## 2. Frontmatter'), at('## 3. Body sections'));
  const keys = table.map((l) => /^\| `([a-z_]+)` \|/.exec(l)?.[1]).filter(Boolean);
  return { headings, keys };
}

/** The publisher literals in one text: [{ literal, line }], one per literal present. Presence is decided over the
    whole folded text and the line located afterwards, exactly as publicRoutes() of lib/passport/rules.mjs does for
    the intake gate: the first line whose prefix holds the literal, walked back to where the shortest span holding
    it starts. Folding one line or two adjacent lines missed a literal split over three (E3a critique F5). The
    locator is repeated here because rules.mjs exports no general one and is on the gate's manifest;
    tests/e3/unit/capture.test.mjs requires the two to agree on every intake route. */
export function literalFindings(text) {
  const lines = text.split('\n');
  const folded = normalizeForbidden(text);
  const holds = (from, to, needle) => normalizeForbidden(lines.slice(from, to + 1).join('\n')).includes(needle);
  const found = [];
  for (const literal of LITERALS) {
    const needle = normalizeForbidden(literal);
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
    found.push({ literal, line: start + 1 });
  }
  return found;
}

/** Every finding for one prompt text: [{ rule, detail }]. */
export function scan(text, specText) {
  const problems = [];
  const refuse = (rule, detail) => problems.push({ rule, detail });

  for (const { literal, line } of literalFindings(text)) refuse('publisher literal', `${literal} at line ${line}`);

  const split = parts(text);
  for (const { part, start, lines: body } of split) {
    body.forEach((line, j) => {
      for (const m of line.normalize('NFKC').toLowerCase().matchAll(WORD)) {
        if (!Object.hasOwn(ALLOWED[m[1]], part))
          refuse('restricted word outside its allowed parts', `${m[1]} in ${part} at line ${start + j}`);
      }
    });
  }

  const find = (name) => split.find((p) => p.part === name);
  const last = split[split.length - 1];
  const final = last.lines.join('\n');
  if (last.part !== 'step 10') refuse('final step', `the last part is ${last.part}, not step 10`);
  for (const [need, what] of [
    ['captured-passport.md', 'the local file name'],
    ['locally', 'saving the file locally'],
    ['sign in', 'signing in to the enterprise site'],
    ['enterprise', 'the enterprise site'],
    ['upload that local file', 'the owner uploading the local file'],
  ]) {
    if (!final.includes(need)) refuse('final step', `step 10 does not name ${what}`);
  }
  const step1 = find('step 1')?.lines.join(' ') ?? '';
  if (!/private Phaeacia application, where named reviewers read it/.test(step1))
    refuse(
      'enterprise disclosure',
      'step 1 does not say the owner uploads to the private application its reviewers read',
    );
  const rules = find('rules')?.lines.join(' ') ?? '';
  if (!/refuses the uploaded file, it lists the refused rules by line number/.test(rules))
    refuse('stop condition', 'R7 does not name the intake refusal by line number');

  const { headings, keys } = specShape(specText);
  const step9 = find('step 9')?.lines ?? [];
  const open = step9.indexOf('---');
  const close = open === -1 ? -1 : step9.indexOf('---', open + 1);
  const templateKeys =
    open === -1 || close === -1
      ? []
      : step9
          .slice(open + 1, close)
          .map((l) => /^([a-z_]+):/.exec(l)?.[1])
          .filter(Boolean);
  if (JSON.stringify(templateKeys) !== JSON.stringify(keys))
    refuse(
      'frontmatter template',
      `step 9 template keys ${templateKeys.join(',')} differ from the spec's ${keys.join(',')}`,
    );
  const templateHeadings = step9.filter((l) => /^## \d\. /.test(l));
  if (JSON.stringify(templateHeadings) !== JSON.stringify(headings))
    refuse('section list', `step 9 template headings differ from the spec's ${headings.length} sections`);
  const joined9 = step9.join(' ');
  const keyCount = NUMBER_WORDS[/all (\w+) keys present/.exec(joined9)?.[1]];
  const headingCount = NUMBER_WORDS[/All (\w+) headings present/i.exec(joined9)?.[1]];
  if (keyCount !== keys.length) refuse('step 9 checklist', `it counts ${keyCount} keys, the spec has ${keys.length}`);
  if (headingCount !== headings.length)
    refuse('step 9 checklist', `it counts ${headingCount} headings, the spec has ${headings.length}`);
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  let file = join(REPO_ROOT, CAPTURE);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file') file = resolve(args[++i]);
    else {
      process.stderr.write(`check-capture: unknown argument ${args[i]}\n`);
      return 2;
    }
  }
  const bytes = readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const problems = scan(bytes.toString('utf8'), readFileSync(join(REPO_ROOT, SPEC), 'utf8'));
  for (const p of problems) process.stdout.write(`REFUSE ${p.rule}: ${p.detail}\n`);
  const out = join(REPO_ROOT, '.scratch', 'check');
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'capture.json'),
    `${JSON.stringify({ file: relative(REPO_ROOT, file), sha256, problems }, null, 2)}\n`,
  );
  process.stdout.write(`check-capture: ${relative(REPO_ROOT, file)} sha256 ${sha256}, ${problems.length} problem(s)\n`);
  return problems.length ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
