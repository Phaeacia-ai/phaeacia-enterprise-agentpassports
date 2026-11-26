#!/usr/bin/env node
/* Secret check (architecture section 11): runs the pinned upstream SECRETS
   rules from vendor/passport/web/lib/_validate.mjs over the repository's
   tracked text files, excluding vendor/ (whose fixtures carry deliberate
   probes), node_modules/ and package-lock.json (integrity hashes trip the
   entropy rules). Reports rule name, file and line number only, never the
   matched text. Exit 0 clean, 2 on findings. --paths <a,b> scans the named
   files instead of the tracked set (tests).

   Each rule is matched over the whole file body and the match offset is
   mapped back to a line number, the way the pinned validator's secret scan
   does it: `a password assignment` uses \s, which spans a newline, so a
   value on the line after the key and its colon is one match over the body
   and no match on either line alone. The gate at c874c79 split lines first
   and missed that case (critique H3, 2026-09-10).

   Dispositioned findings: DISPOSITIONS below lists known synthetic matches in
   tracked files that are not this repository's to edit, by exact rule, path,
   line and the SHA-256 of the matched text (the exact substring the pinned
   rule matched, hashed as UTF-8). A finding is dispositioned only when all
   four agree, so changed content at the same location, a match that moves, a
   different rule at that location and any finding elsewhere still fail. A
   disposition whose file was scanned and produced no such finding is stale
   and is itself reported as a problem, so a vanished match cannot leave a
   silent exception behind. The gate at 036dac9 matched rule, path and line
   only (critique 2, M2, 2026-09-10). The hash lets the entry be verified
   without ever printing the matched text.

   What this wrapper does not do, deliberately: the pinned validator scans the
   union of a normalised body (its normaliseForScan: NFKC-style folding of
   look-alike characters) and a legacy body (BOM and U+0085 stripped) so that
   a credential hidden behind cross-engine text differences is still found.
   This gate scans the raw body only. It is a repository hygiene check for
   committed text, not the production intake gate; the intake gate is the
   vendored validator itself. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE = [/^vendor\//, /^node_modules\//, /^package-lock\.json$/];
/* Exact rule, path, line and SHA-256 of the matched text of a known synthetic
   match, with the reason. To renew an entry after a reviewed edit, run the
   gate: it reports the stale entry and the new finding by location only;
   compute the new hash from the matched text locally and never record the
   text itself here. The one entry names a review record that is not part of
   the published tree; it is kept because tests/passport/checks.test.mjs (M2)
   exercises the mechanism against that exact path in a scratch tree. */
export const DISPOSITIONS = Object.freeze([
  {
    rule: 'a password assignment',
    path: 'evidence/e1-adapter-critique.md:136',
    match_sha256: '267c0f8e0b4e70e11070300cac55155afcf6e57d9801a950a72a5b12ffd98314',
    why: 'the critic recorded its two-line synthetic reproduction input for H3; a lead-owned record, not a credential',
  },
]);

const STALE_RULE = 'stale disposition, no matching finding';

function matchHash(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function trackedFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter((p) => p && !EXCLUDE.some((re) => re.test(p)));
}

function isText(bytes) {
  const probe = bytes.subarray(0, 8192);
  return !probe.includes(0);
}

export async function checkSecrets(root, paths) {
  const validatePath = join(root, 'vendor/passport/web/lib/_validate.mjs');
  const { SECRETS } = await import(pathToFileURL(validatePath).href);
  const problems = [];
  let scanned = 0;
  let dispositioned = 0;
  const scannedFiles = new Set();
  const used = new Set();
  for (const rel of paths) {
    const bytes = readFileSync(resolve(root, rel));
    if (!isText(bytes)) continue;
    scanned++;
    scannedFiles.add(rel);
    const body = bytes.toString('utf8');
    const lineStart = [0];
    for (let i = 0; i < body.length; i++) if (body[i] === '\n') lineStart.push(i + 1);
    const lineOf = (idx) => {
      let lo = 0;
      let hi = lineStart.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStart[mid] <= idx) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    for (const [name, re] of SECRETS) {
      /* A fresh global clone per rule: the pinned regexes carry no /g and
         are shared at module scope. */
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      let m = g.exec(body);
      while (m !== null) {
        const path = `${rel}:${lineOf(m.index)}`;
        const d = DISPOSITIONS.find((x) => x.rule === name && x.path === path && x.match_sha256 === matchHash(m[0]));
        if (d) {
          dispositioned++;
          used.add(d);
        } else problems.push({ rule: name, path });
        if (m[0].length === 0) g.lastIndex++;
        m = g.exec(body);
      }
    }
  }
  /* A disposition whose file was scanned without producing its exact
     finding is stale: the reviewed match is gone or changed. Files outside
     this run's path set are not judged. */
  for (const d of DISPOSITIONS) {
    const file = d.path.slice(0, d.path.lastIndexOf(':'));
    if (scannedFiles.has(file) && !used.has(d)) problems.push({ rule: STALE_RULE, path: d.path });
  }
  return { rules: SECRETS.length, scanned, dispositioned, problems };
}

async function main() {
  const args = process.argv.slice(2);
  let root = REPO_ROOT;
  let paths = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') root = resolve(args[++i]);
    else if (args[i] === '--paths') paths = args[++i].split(',');
    else {
      /* A stray argument is refused rather than ignored: `--paths a b` once scanned only `a` and still printed
         "0 problems" (evidence/e4-prereqs.md, lesson 2, 2026-09-15). Paths are one comma-separated list. */
      process.stderr.write(
        `check-secrets: unexpected argument ${JSON.stringify(args[i])}; paths are one comma-separated list after --paths\n`,
      );
      return 1;
    }
  }
  const { rules, scanned, dispositioned, problems } = await checkSecrets(root, paths ?? trackedFiles(root));
  for (const p of problems) process.stdout.write(`REFUSE ${p.rule}: ${p.path}\n`);
  process.stdout.write(
    `check-secrets: ${rules} pinned rules over ${scanned} text files, ${problems.length} problem(s), ${dispositioned} dispositioned\n`,
  );
  return problems.length ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
