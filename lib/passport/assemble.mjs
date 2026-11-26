/* Deterministic assembly: the exact Node port of vendor/passport/scripts/assemble.py
   at the pinned revision (upstream.lock.json). Contract: docs/e1/passport-adapter.md
   section 6.

   Every rule below is mirrored from the Python source, not from its description.
   Where JavaScript's built-ins differ from Python's (whitespace sets, universal
   newlines, strict UTF-8, isalnum), the Python behaviour is written out explicitly
   so the assembled bytes are identical. Golden hashes and adversarial folding
   cases in tests/passport/assemble.test.mjs prove the port for the named fixture
   and cases; NFKC and lower-casing come from the runtime and are proven only
   there.

   No IO except reading the vendored installer files and the passport the caller
   names. No network, no child process, nothing executed from the vendor tree. */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const PLACEHOLDER = '<!-- installer core and branches inserted on upload -->';
export const BRANCH_ORDER = Object.freeze(['chatgpt.md', 'claude-ai.md', 'claude-code.md', 'generic.md']);
export const BRANCHES = Object.freeze(BRANCH_ORDER.map((f) => f.slice(0, -3)));

/* assemble.py FORBIDDEN, in the same order. */
export const FORBIDDEN = Object.freeze([
  'browser_profile',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  '.pem',
  '.key',
  '.env',
  'credentials/',
  'secrets/',
]);

/* assemble.py _FORBIDDEN_NOISE: backslash, backtick, asterisk, underscore,
   U+00AD soft hyphen, U+200B zero-width space, U+200C zero-width non-joiner,
   U+200D zero-width joiner, U+2060 word joiner, U+FEFF byte-order mark. */
/* Written as an alternation of single code points rather than a character
   class only because the linter reads a class holding U+200D as an emoji
   sequence; each alternative deletes one code point, exactly as the Python
   class does. The six invisible code points are built with String.fromCodePoint,
   neither escaped nor written literally (contract rule 3 of
   scripts/check-imports.mjs, 2026-09-11); tests/passport/checks.test.mjs
   compares this expression with the original escaped one for every UTF-16
   code unit. */
export const FORBIDDEN_NOISE = new RegExp(
  ['\\\\', '`', '\\*', '_', ...String.fromCodePoint(0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff)].join('|'),
  'g',
);
/* assemble.py _FORBIDDEN_SPLIT. */
const FORBIDDEN_SPLIT = /(?<=[a-z0-9])[ \t]*\n[ \t]*(?=[a-z0-9])/g;

/* Python str.isspace(): the characters str.strip()/rstrip() remove and re's
   \s matches for str patterns. Differs from JavaScript's trim set at
   U+001C..U+001F (Python strips, JavaScript does not) and U+FEFF (JavaScript
   strips, Python does not). The body of a character class, built from code
   points (contract rule 3 of scripts/check-imports.mjs): tab, line feed, U+000B, U+000C,
   carriage return, U+001C to U+001F, space, U+0085, U+00A0, U+1680, the range
   U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F and U+3000. */
export const PY_SPACE = [
  String.fromCodePoint(0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680),
  `${String.fromCodePoint(0x2000)}-${String.fromCodePoint(0x200a)}`,
  String.fromCodePoint(0x2028, 0x2029, 0x202f, 0x205f, 0x3000),
].join('');
const PY_RSTRIP = new RegExp(`[${PY_SPACE}]+$`);
const PY_LSTRIP = new RegExp(`^[${PY_SPACE}]+`);
/* re.search(r"comparison_mode:\s*\S", line) with Python's \s and \S. */
const COMPARISON_MODE = new RegExp(`comparison_mode:[${PY_SPACE}]*[^${PY_SPACE}]`);
/* str.isalnum() on one character: letters (Lu, Ll, Lt, Lm, Lo) or numbers
   (Nd, Nl, No). */
const PY_ALNUM_FIRST = /^[\p{L}\p{N}]/u;

export function pyRstrip(s) {
  return s.replace(PY_RSTRIP, '');
}

export function pyStrip(s) {
  return s.replace(PY_LSTRIP, '').replace(PY_RSTRIP, '');
}

/* Python's open(path, encoding="utf-8") in text mode: strict decoding (an
   invalid sequence raises) and universal newlines (\r\n and \r become \n).
   The decoder keeps a leading U+FEFF, as Python's "utf-8" codec does. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decodeText(bytes) {
  return STRICT_UTF8.decode(bytes).replace(/\r\n?/g, '\n');
}

export function readText(path) {
  return decodeText(readFileSync(path));
}

/* Python's str.encode("utf-8") refuses lone surrogates; Buffer.from would
   silently substitute U+FFFD. Refuse the same way. The surrogate ranges are
   built from char codes (contract rule 3 of scripts/check-imports.mjs). */
const HIGH_SURROGATES = `${String.fromCharCode(0xd800)}-${String.fromCharCode(0xdbff)}`;
const LOW_SURROGATES = `${String.fromCharCode(0xdc00)}-${String.fromCharCode(0xdfff)}`;
export const LONE_SURROGATE = new RegExp(
  `[${HIGH_SURROGATES}](?![${LOW_SURROGATES}])|(?<![${HIGH_SURROGATES}])[${LOW_SURROGATES}]`,
);

export function encodeText(text) {
  if (LONE_SURROGATE.test(text)) {
    throw new Error('text contains a lone surrogate and cannot be encoded as UTF-8');
  }
  return Buffer.from(text, 'utf8');
}

function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

/* normalize_forbidden: NFKC, lower-case, delete the noise characters, join a
   line break that sits between alphanumerics. `options` exists only so the
   tests can build the wrong ports the contract's folding cases must
   distinguish; production callers pass nothing. */
export function normalizeForbidden(text, options = {}) {
  let folded = options.nfkc === false ? text : text.normalize('NFKC');
  folded = options.casefold ? casefoldApprox(folded) : folded.toLowerCase();
  const denoised = options.noise === false ? folded : folded.replace(FORBIDDEN_NOISE, '');
  return options.join === false ? denoised : denoised.replace(FORBIDDEN_SPLIT, '');
}

/* Test-only approximation of Python's str.casefold() for the mutant port of
   regression 4b: full case folding expands sharp s to "ss" and long s to "s".
   Not used by production code. */
function casefoldApprox(s) {
  return s.toLowerCase().replace(/ß/g, 'ss').replace(/ſ/g, 's');
}

/* Python str slicing counts code points; JavaScript's slice counts UTF-16
   units and can cut an astral character in half (critique L1, 2026-09-10). */
function pyLeft(s, n) {
  return Array.from(s).slice(0, n).join('');
}

/* assemble.py check(): the problems an insertion would introduce. */
export function check(text, options = {}) {
  const problems = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMPARISON_MODE.test(line)) {
      problems.push(
        `installer text line ${i + 1} contains a \`comparison_mode:\` assignment, ` +
          'which makes the assembled passport fail validate.py check 5. ' +
          `Write it as prose or without the colon: ${pyLeft(pyStrip(line), 70)}`,
      );
    }
  }
  const normText = normalizeForbidden(text, options);
  for (const word of FORBIDDEN) {
    const needle = normalizeForbidden(word, options);
    const anchored = !PY_ALNUM_FIRST.test(needle.slice(0, 1));
    const pattern = new RegExp(`${anchored ? '(?<=[a-z0-9])' : ''}${reEscape(needle)}`);
    if (pattern.test(normText)) {
      problems.push(
        `installer text contains the denied-path string ${pyRepr(word)}, which fails ` +
          'validate.py check 9 in the assembled passport',
      );
    }
  }
  return problems;
}

/* Python %r of a plain ASCII string without quotes inside: single-quoted. */
function pyRepr(s) {
  return `'${s}'`;
}

/* assemble.py LAYOUTS and resolve(): the first location that exists wins. */
const LAYOUTS = Object.freeze({
  core: ['installer/core.md', 'references/installer-core.md'],
  branch_dir: ['installer/branches', 'references/installer-branches'],
  judge: ['verification/judge-prompt.md', 'references/judge-prompt.md'],
});

/* os.path.exists(): follows links, false on any error. */
function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function resolveLayout(root, key) {
  for (const rel of LAYOUTS[key]) {
    const path = join(root, rel);
    if (exists(path)) return path;
  }
  return null;
}

/* judge_prompt(): the body between the first and last four-backtick fence
   lines, stripped, under the appendix heading; null (with a warning) when the
   file or the fences are missing. */
export function judgePrompt(root, warn = () => {}) {
  const path = resolveLayout(root, 'judge');
  if (path === null) {
    warn('warning: no judge prompt, section 5 will have no verification step');
    return null;
  }
  const lines = readText(path).split('\n');
  const fences = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('````')) fences.push(i);
  if (fences.length < 2) {
    warn('warning: judge prompt has no four-backtick fenced block, skipping');
    return null;
  }
  const body = pyStrip(lines.slice(fences[0] + 1, fences[fences.length - 1]).join('\n'));
  return `## Appendix: the verification judge\n\nRun this at step 7, against the first real run.\n\n${body}`;
}

/* installer_text(only): core, judge appendix, then one branch (or all four in
   BRANCH_ORDER when only is null), each rstripped, joined by "\n\n", plus one
   trailing "\n". */
export function installerText(root, only = null, warn = () => {}) {
  const core = resolveLayout(root, 'core');
  if (core === null) throw new AssembleError(`FAIL: no installer core found under ${root}`);
  const parts = [pyRstrip(readText(core))];
  const judge = judgePrompt(root, warn);
  if (judge) parts.push(judge);
  const branchDir = resolveLayout(root, 'branch_dir') ?? '';
  const wanted = only === null ? BRANCH_ORDER : [only];
  for (const name of wanted) {
    const path = join(branchDir, name);
    if (!exists(path)) {
      warn(`warning: missing branch ${name}`);
      continue;
    }
    parts.push(pyRstrip(readText(path)));
  }
  return `${parts.join('\n\n')}\n`;
}

export class AssembleError extends Error {
  constructor(message, code = 'E_ASSEMBLE') {
    super(message);
    this.code = code;
  }
}

export function branchFile(branch) {
  if (branch === null || branch === undefined) return null;
  const match = BRANCH_ORDER.find((f) => f.slice(0, -3) === branch);
  if (!match)
    throw new AssembleError(
      `FAIL: unknown branch '${branch}', expected one of ${BRANCHES.join(', ')}`,
      'E_UNKNOWN_BRANCH',
    );
  return match;
}

/* main() without the file writing: returns the assembled text for a passport
   string, or throws AssembleError with the code the contract names. */
export function assemble(passportText, { root, branch = null, warn = () => {} }) {
  if (typeof root !== 'string' || !root) throw new AssembleError('root is required', 'E_ASSEMBLE');
  const only = branchFile(branch);
  if (!passportText.includes(PLACEHOLDER)) {
    throw new AssembleError(
      `FAIL: no installer placeholder found\n      expected the line: ${PLACEHOLDER}`,
      'E_NO_PLACEHOLDER',
    );
  }
  const text = installerText(root, only, warn);
  const problems = check(text);
  if (problems.length) throw new AssembleError(problems.map((p) => `FAIL: ${p}`).join('\n'), 'E_INSTALLER_HAZARD');
  return passportText.split(PLACEHOLDER).join(text);
}

/* Convenience for callers that hold bytes: decode like Python, assemble,
   encode like Python. */
export function assembleBytes(passportBytes, options) {
  return encodeText(assemble(decodeText(passportBytes), options));
}
