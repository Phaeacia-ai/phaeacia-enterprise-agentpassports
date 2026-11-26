/* Q5R-F1-R-F1 (evidence/e5-pages-review.md): the stack capacity samples run inside bash scripts/check.sh, so they may
   replace their evidence copy only when the run asks for it with CAPACITY_EVIDENCE=1. A text tripwire over every file
   under tests/<slice>/stack/, whatever slices exist: outside that guard no string literal names the evidence
   directory, so no write, copy, rename or stream of any verb can reach it by name, on one line or across several
   (TOOL2-R-F1, evidence/batch-2-review.md: the first version matched four verbs one line at a time over four
   hard-coded slices, and the house shape puts a write's verb and path on different lines). It is stricter than the
   rule it holds: a stack test may not read from evidence by name either, and none does. Its bound, stated: a path
   assembled from parts ('evi' + 'dence'), and a helper outside tests/<slice>/stack/ that a stack test calls, are not
   seen. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(?:mjs|js|cjs|sh)$/.test(name) ? [path] : [];
  });
const stackDirs = readdirSync(join(ROOT, 'tests'))
  .map((slice) => join(ROOT, 'tests', slice, 'stack'))
  .filter((dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });

/* Comments name evidence paths freely and are not code: block and line comments are dropped before the search. A
   scanner rather than a regular expression, because a comment opener inside a string ('tests/*\/stack') is not a
   comment and a regular expression that thought so swallowed the unguarded write after it (B3-R-F3,
   evidence/batch-3-review.md). Strings are kept; escapes inside them are skipped. */
export function withoutComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
/* The guard closes on the brace at ITS OWN indentation, so a guard nested one level, or emptied, ends where it ends and
   a write moved after it is outside (B3-R-F3); the first version closed on the first two-space brace anywhere below. */
const GUARD = /^([ \t]*)if \(process\.env\.CAPACITY_EVIDENCE === '1'\) \{\n(?:\1\}|[\s\S]*?\n\1\})/gm;
const NAMES_EVIDENCE = /['"`]\.?\/?evidence(?:\/[^'"`\n]*)?['"`]/;

export function evidenceNamedOutsideGuard(text) {
  let guarded = 0;
  const outside = withoutComments(text).replace(GUARD, () => {
    guarded += 1;
    return '';
  });
  return { guarded, named: NAMES_EVIDENCE.test(outside) };
}

/* One guard per capacity record. E4 one, E5 one, E6 two (the services lane's record and the pages lane's, both in
   tests/e6/stack/capacity.test.mjs, each under its own guard). The count is asserted rather than left open, so a
   sample whose guard was dropped is a failure here and not a silent rewrite of an accepted record; a record added
   under a guard moves the count and this comment together (the pages lane's did, found by the full run at 73b2e83). */
test('no stack test names the evidence directory outside the CAPACITY_EVIDENCE guard', () => {
  assert.ok(stackDirs.length >= 4, 'the slices with a stack directory are found, not listed');
  let guarded = 0;
  for (const file of stackDirs.flatMap(walk)) {
    const found = evidenceNamedOutsideGuard(readFileSync(file, 'utf8'));
    guarded += found.guarded;
    assert.equal(found.named, false, `${file} names the evidence directory outside the guard`);
  }
  assert.equal(guarded, 4, 'the E4, E5 and the two E6 capacity records each carry the guard');
});

test('the tripwire sees the three shapes the batch-3 critic slipped past it (B3-R-F3)', () => {
  /* The guard nested one level, its write moved after it: the guard closes at its own indentation and the write is
     outside. */
  const nested =
    "  test('x', () => {\n    if (process.env.CAPACITY_EVIDENCE === '1') {\n      const a = 1;\n    }\n    writeFileSync(join(ROOT, 'evidence', 'x.txt'), record);\n  });\n";
  assert.deepEqual(evidenceNamedOutsideGuard(nested), { guarded: 1, named: true });
  /* The guard emptied, the write after it, and a two-space brace further down. */
  const emptied = "  if (process.env.CAPACITY_EVIDENCE === '1') {\n  }\n  writeFileSync(join(ROOT, 'evidence', 'x.txt'), record);\n  test('y', () => {\n  });\n";
  assert.deepEqual(evidenceNamedOutsideGuard(emptied), { guarded: 1, named: true });
  /* A comment opener inside a string before an unguarded write. */
  const inString = "const glob = 'tests/*/stack';\nwriteFileSync(join(ROOT, 'evidence', 'x.txt'), record);\n";
  assert.deepEqual(evidenceNamedOutsideGuard(inString), { guarded: 0, named: true });
  /* Controls: a real comment still drops, a string with an escaped quote is one string, a guard at four spaces counts. */
  assert.equal(withoutComments("a /* 'evidence' */ b // 'evidence'\nc"), 'a  b \nc');
  assert.equal(withoutComments("'it\\'s' + \"x\""), "'it\\'s' + \"x\"");
  const deeper = "    if (process.env.CAPACITY_EVIDENCE === '1') {\n      writeFileSync(join(ROOT, 'evidence', 'x.txt'), record);\n    }\n";
  assert.deepEqual(evidenceNamedOutsideGuard(deeper), { guarded: 1, named: false });
});

test('the tripwire sees the shapes the first version missed (TOOL2-R-F1)', () => {
  const guardedWrite = "  if (process.env.CAPACITY_EVIDENCE === '1') {\n    writeFileSync(join(ROOT, 'evidence', 'x', 'capacity.txt'), record);\n  }\n";
  assert.deepEqual(evidenceNamedOutsideGuard(guardedWrite), { guarded: 1, named: false });
  for (const [label, source] of [
    ['a verb and its path on different lines', "writeFileSync(\n  join(ROOT, 'evidence', 'x', 'capacity.txt'),\n  record,\n);\n"],
    ['copyFileSync, a verb outside the first list', "copyFileSync(from, join(ROOT, 'evidence', 'x.txt'));\n"],
    ['a stream', "createWriteStream(join(ROOT, 'evidence/x.txt'));\n"],
    ['a template literal path', 'writeFileSync(`evidence/e6-repro/capacity.txt`, record);\n'],
    ['a relative path', "await writeFile('./evidence/x.txt', record);\n"],
  ])
    assert.equal(evidenceNamedOutsideGuard(source).named, true, label);
  assert.equal(evidenceNamedOutsideGuard("/* written to evidence/e4-server-repro/capacity.txt on request */\n").named, false);
  assert.equal(evidenceNamedOutsideGuard("// see 'evidence/e3b-critique-repro/extra.mjs.txt'\n").named, false);
});
