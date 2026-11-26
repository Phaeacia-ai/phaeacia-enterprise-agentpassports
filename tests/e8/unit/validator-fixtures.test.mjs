/* E8-V1 to E8-V5 (docs/e8/design.md section 3), the validator adversarial fixtures the plan asks for: "add
   malicious cases for permission binding, missing sections, false pass status and write capabilities".

   THE PAIR IS THE PROOF (design 3.3). Each fixture under tests/e8/fixtures/ is committed, and each is asserted
   twice: once through the enterprise side and once through the pinned vendor/passport/tools/validate.py, launched
   the way scripts/check-python.mjs launches it (an absolute interpreter, -I -B, through tests/e3/unit/helpers.mjs's
   `python()`, which is the same resolver tests/e3/unit/rules-parity.test.mjs uses). Three assertions and not two:
     1. the enterprise side reports exactly the expected (check, line) multiset for checks 12 to 15;
     2. the pinned validate.py reports exactly the same multiset for checks 12 to 15;
     3. Python did NOT stop at FAIL 1, so the comparison was actually made.
   Assertion 3 is the one that keeps "the two agree" from being satisfied by Python never reaching the checks;
   `v2-frontmatter-stops-python` is its committed counterexample and is asserted to fail it.

   WHY CHECKS 1 TO 11 ARE COMPARED ON THE VERDICT AND NOT PER LINE (design 3.3, E8D-R-F4). Those checks live in
   the vendored pair. The Node half, vendor/passport/web/lib/_validate.mjs, pushes CODES (E_FRONTMATTER,
   E_MISSING_KEY, E_SECTIONS, E_SECTION_ORDER) with no check number and no line; lib/passport/rules.mjs's
   CHECK_NUMBERS maps 12 to 15 and nothing else; and vendor/passport/web/tools/parity.mjs states the position
   outright, "Parity is on the VERDICT, not on the error text. The two have different vocabularies by design."
   Writing the code-to-check-number mapping that would close the gap is a change to the validator contract,
   outside this package's module map. So E8-V2 asserts the VERDICT on 1 to 11 (both sides refuse) and the
   (check, line) multiset on 12 to 15, and each E8-V2 fixture carries one planted check-15 finding so that second
   comparison is not vacuous on a document whose section is gone. `v2-missing-section-3` is the one exception and
   it is labelled: removing the Functional spec heading removes the block checks 12 to 15 read, so its multiset is
   empty by construction and only the verdict is compared there.

   AN ADMISSION IS NEVER COUNTED AS A PASS (design 3.3, "the honest part"). Six of these fixtures are admitted by
   both sides. Each is marked `admit` in the table below with the reason, and the test asserts the agreement to
   admit rather than reporting it as a refusal. The class counts are asserted at the end, so a fixture cannot
   quietly move from `refuse` to `admit` by a change in either implementation.

   ONE FIXTURE IS ENTERPRISE-ONLY AND SAYS SO. `v4-public-route-folded` is refused by the enterprise gate with
   E_PUBLIC_ROUTE and ADMITTED by the pinned validate.py with exit 0, because the publisher-route scan comes from
   E0's local_policy.py and is not one of validate.py's fifteen checks. It is asserted in that asymmetric shape and
   is not a divergence: there is nothing on the Python side for it to diverge from.

   THE COMMITTED FIXTURES CARRY INVISIBLE CHARACTERS, AND THE TEST CHECKS THAT THEY STILL DO. Three fixtures turn
   on a character a reader cannot see: a zero-width space, a combining acute, a soft hyphen, and one on a trailing
   tab. A normalising editor or a tool that rewrote the file would defang the attack and every assertion here
   would still pass, because a defanged fixture is simply a clean document. Each case therefore carries `carries`,
   a string built from its code points and never typed (tests/e3/unit/helpers.mjs's own lesson), asserted present
   in the committed bytes before anything else runs.

   HOW THE FIXTURES WERE BUILT. Each is tests/native-transfer/passport/fixtures/SYNTHETIC-passport.md with named
   replacements, the shape tests/e3/unit/rules.test.mjs uses for its twenty-two hand-written pairs. The recipes are
   in evidence/e8-approval.md section 5 and the generator that wrote them is recorded there; the committed .md
   files are the artifact, so a later reader can run the pinned validate.py over one directly.

   NO STACK, NO NETWORK. Python is the only child process. If Python cannot run these tests fail: a skipped parity
   check is not a pass (tests/e3/unit/rules.test.mjs's rule, kept). */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { decodeText } from '../../../lib/passport/assemble.mjs';
import { gate } from '../../../lib/passport/gate.mjs';
import { CHECK_NUMBERS, formatChecks } from '../../../lib/passport/rules.mjs';
import { validate } from '../../../vendor/passport/web/lib/_validate.mjs';
import { scratchCopy } from '../../e2/helpers/pages.mjs';
import { cp, linesEqual, pythonFindings, REPO, VALIDATED_AT } from '../../e3/unit/helpers.mjs';
import { caught } from '../helpers/mutant-lib.mjs';

const DIR = join(REPO, 'tests/e8/fixtures');
const ZWSP = cp(0x200b);
const TAB = cp(0x09);
const SHY = cp(0xad);
const ACUTE = cp(0x301);
const EACUTE = cp(0xe9);

/* [name, class, what the fixture must still carry, expected [code, exact line text, occurrence index]]
   class: `refuse` both sides refuse and report the same checks; `admit` both sides admit, recorded as an
   agreement to admit and never counted as a pass; `enterprise-only` the enterprise gate refuses and the pinned
   Python admits, for a rule that is not one of its fifteen checks. */
const CASES = [
  /* E8-V1, check 12, permission binding. The plan's first malicious family. rules.test.mjs already has six
     binding cases; these are the four shapes it has not: a slot id matched by something that is not the id. */
  [
    'v1-binding-case-only',
    'refuse',
    'binding: Delivery_Target',
    [['E_BINDING', '    binding: Delivery_Target']],
  ],
  [
    'v1-binding-normalisation-only',
    'refuse',
    `binding: liefere${ACUTE}_target`,
    [['E_BINDING', `    binding: liefere${ACUTE}_target`]],
  ],
  /* Admitted: yamlScalarRe captures one run of [^WS_BOTH], so a trailing tab is never part of the value on
     either side. The agreement is the finding; nothing here says a tab is safe in general. */
  ['v1-binding-trailing-tab', 'admit', `binding: delivery_target${TAB}`, []],
  /* Admitted: both sides collect every personal_slots id before reading any binding, so a binding may name a
     slot defined below it. Pinned because "the slot has to exist first" is a plausible future narrowing that
     would refuse an honest passport. */
  ['v1-binding-forward-slot', 'admit', 'binding: later_target', []],
  /* Admitted: two credentialed inputs may bind the same slot. One question answers both roles, which is what a
     slot is, and neither side counts bindings per slot. */
  ['v1-binding-shared-slot', 'admit', 'a second credentialed source', []],

  /* E8-V3, check 13, false pass status. The plan's third family: a verification check that compares against a
     previous run while the passport carries no state to compare with. */
  [
    'v3-state-block-empty',
    'refuse',
    'state:\nprocessing:',
    [['E_STATE_REQUIRED', '  - check: The record count is down vs prev']],
  ],
  [
    'v3-keeps-is-a-comment',
    'refuse',
    '  # keeps: the record count',
    [['E_STATE_REQUIRED', '  - check: The record count is down vs prev']],
  ],
  /* Admitted: the delta phrase is in section 4 inside a fence, not in section 3's verification block, and
     neither side looks for it there. A check 13 that fired here would refuse a golden example that quotes one. */
  ['v3-delta-inside-a-fence', 'admit', '```text\nThe record count is down vs prev', []],
  /* Admitted: same reason, in a sub-heading. `###` is not a section boundary to either side, so this also pins
     that the document still has its six required headings. */
  ['v3-delta-in-a-heading', 'admit', '### The record count vs prev', []],

  /* E8-V4, check 15, write capabilities and the access vocabulary. The plan's fourth family. */
  [
    'v4-access-zero-width',
    'refuse',
    `access: creden${ZWSP}tialed`,
    [['E_ACCESS', `    access: creden${ZWSP}tialed`]],
  ],
  /* Admitted: the value is `open` and the comment is past the first whitespace, so neither side reads it.
     Recorded because the dangling form `access:  # open | credentialed` IS refused (rules.test.mjs), and the
     difference between the two is one token. */
  ['v4-access-trailing-comment', 'admit', 'access: open  # the recipient pastes them', []],
  [
    'v4-access-line-continuation',
    'refuse',
    'access: >-\n      open',
    [['E_ACCESS', '    access: >-']],
  ],
  /* Enterprise-only: E_PUBLIC_ROUTE is E0's local_policy.py tuple, not a validate.py check. The soft hyphen is
     deleted by normalizeForbidden before the match, which is the folding this case exists to hold open. */
  ['v4-public-route-folded', 'enterprise-only', `app.phaea${SHY}cia.ai`, []],

  /* E8-V2, checks 1 to 11, missing sections. One fixture per required heading, each also carrying `access:
     nonsense` so checks 12 to 15 are compared on a document whose section is gone. */
  ['v2-missing-section-1', 'refuse', 'access: nonsense', [['E_ACCESS', '    access: nonsense']]],
  ['v2-missing-section-2', 'refuse', 'access: nonsense', [['E_ACCESS', '    access: nonsense']]],
  /* The exception: with `## 3. Functional spec` gone there is no spec block, so checks 12 to 15 find nothing on
     either side and only the verdict is compared. The planted `access: nonsense` is still in the file and is
     deliberately invisible to both sides, which is the point being pinned. */
  ['v2-missing-section-3', 'refuse', 'access: nonsense', []],
  ['v2-missing-section-4', 'refuse', 'access: nonsense', [['E_ACCESS', '    access: nonsense']]],
  ['v2-missing-section-5', 'refuse', 'access: nonsense', [['E_ACCESS', '    access: nonsense']]],
  ['v2-missing-section-6', 'refuse', 'access: nonsense', [['E_ACCESS', '    access: nonsense']]],
];

/* The fixture that is not a case: it is assertion 3's counterexample and is asserted separately. */
const FAIL1_FIXTURE = 'v2-frontmatter-stops-python';

const read = (name) => readFileSync(join(DIR, `${name}.md`));

/** The enterprise side's checks 12 to 15, computed exactly as tests/e3/unit/rules-parity.test.mjs computes them. */
function enterpriseChecks(bytes) {
  const v = validate(decodeText(bytes));
  return formatChecks(v.lines, v.inside)
    .map((p) => `${CHECK_NUMBERS[p.code]}:${p.line}`)
    .sort();
}

/** The expected multiset, resolved against the committed bytes rather than written as numbers. */
function expectedOf(text, expected) {
  return expected.map(([code, line, i = 0]) => `${CHECK_NUMBERS[code]}:${linesEqual(text, line)[i]}`).sort();
}

for (const [name, kind, carries, expected] of CASES) {
  test(`E8-V ${name} (${kind}): the enterprise gate and the pinned validate.py agree`, () => {
    const bytes = read(name);
    const text = decodeText(bytes);
    assert.ok(
      text.includes(carries),
      `${name}: the committed fixture no longer carries its attack (${JSON.stringify(carries)}); a normalised fixture would pass every assertion below while testing nothing`,
    );

    const ours = enterpriseChecks(bytes);
    const want = expectedOf(text, expected);
    assert.deepEqual(ours, want, `${name}: the enterprise checks 12 to 15`);

    const py = pythonFindings(join(DIR, `${name}.md`));
    assert.equal(py.fail1, false, `${name}: Python stopped at FAIL 1, so checks 12 to 15 were never compared`);
    assert.deepEqual(py.findings, want, `${name}: the pinned validate.py agrees per check and per line`);

    /* The verdict, which is what the vendored harness compares and all it compares on checks 1 to 11. */
    const g = gate(bytes, 'text/markdown', { validatedAt: VALIDATED_AT });
    if (kind === 'refuse') {
      assert.equal(g.ok, false, `${name}: the enterprise gate admitted it`);
      assert.equal(py.status, 1, `${name}: the pinned validate.py admitted it`);
    } else if (kind === 'admit') {
      assert.equal(g.ok, true, `${name}: ${JSON.stringify(g.problems)}`);
      assert.equal(py.status, 0, `${name}: the pinned validate.py refused what the enterprise gate admitted`);
    } else {
      /* enterprise-only: the gate refuses for a rule validate.py does not have, and Python admits the document. */
      assert.equal(g.ok, false, `${name}: the enterprise gate admitted a public publisher route`);
      assert.equal(g.code, 'E_PUBLIC_ROUTE', `${name}: refused, but not by the publisher-route scan`);
      assert.equal(py.status, 0, `${name}: the pinned validate.py refused it, so the asymmetry stated here is wrong`);
    }
  });
}

test('E8-V2: every required section removed is refused by both sides, and the comparison was made', () => {
  const rows = [];
  for (const [name, kind] of CASES) {
    if (!name.startsWith('v2-')) continue;
    const bytes = read(name);
    const py = pythonFindings(join(DIR, `${name}.md`));
    rows.push({ name, kind, ok: gate(bytes, 'text/markdown', { validatedAt: VALIDATED_AT }).ok, py: py.status, fail1: py.fail1 });
  }
  assert.equal(rows.length, 6, 'one fixture per required heading');
  assert.deepEqual(
    rows.map((r) => `${r.name} node=${r.ok} py=${r.py} fail1=${r.fail1}`),
    rows.map((r) => `${r.name} node=false py=1 fail1=false`),
    'each section removal is refused by both sides and Python reached checks 12 to 15',
  );
});

test('E8-V2 fail-before: a fixture on which Python stops at FAIL 1 fails the comparability assertion', () => {
  const file = join(DIR, `${FAIL1_FIXTURE}.md`);
  const py = pythonFindings(file);
  assert.equal(py.fail1, true, 'the counterexample no longer stops Python at check 1');
  const e = caught('E8-V2 comparability', () => {
    assert.equal(py.fail1, false, `${FAIL1_FIXTURE}: Python stopped at FAIL 1, so checks 12 to 15 were never compared`);
  });
  assert.match(e.message, /stopped at FAIL 1/);
  console.log(`E8-V2 fail-before at the intended check: ${e.message.split('\n')[0]}`);
  /* And the residue the design names: the enterprise gate DOES reach its own later checks on this document, so
     "both refuse" holds while the per-line comparison does not. That is why assertion 3 exists. */
  const g = gate(read(FAIL1_FIXTURE), 'text/markdown', { validatedAt: VALIDATED_AT });
  assert.equal(g.ok, false);
  assert.equal(py.status, 1, 'both sides refuse it; what is missing is the comparison, not the verdict');
});

/* ---------- E8-V5: the parity runner's exclusion set, pinned by name ---------- */

const CORPUS = ['vendor/passport/tools/fixtures/passports', 'vendor/passport/tools/fixtures/validator'];
const EXCLUDED = Object.freeze([
  'vendor/passport/tools/fixtures/passports/invalid_frontmatter_close_trailing_space.md',
  'vendor/passport/tools/fixtures/passports/invalid_frontmatter_line_41.md',
  'vendor/passport/tools/fixtures/passports/invalid_frontmatter_open_nbsp.md',
  'vendor/passport/tools/fixtures/passports/invalid_frontmatter_open_trailing_space.md',
]);

/** Every fixture of the named directories, with whether the pinned Python stops at FAIL 1 on it. */
function exclusionsOf(dirs) {
  const excluded = [];
  let seen = 0;
  for (const dir of dirs) {
    for (const name of readdirSync(join(REPO, dir)).sort()) {
      if (!name.endsWith('.md') || name === 'README.md') continue;
      seen++;
      if (pythonFindings(join(REPO, dir, name)).fail1) excluded.push(`${dir}/${name}`);
    }
  }
  return { seen, excluded };
}

/* One walk of the 127-fixture corpus, at about 5.5 seconds of Python child processes, shared by the pin and by
   its fail-before: the fail-before differs only by one extra directory, so walking the corpus twice would double
   the cost of this file for nothing. */
const CORPUS_EXCLUSIONS = exclusionsOf(CORPUS);

test('E8-V5: the parity runner excludes exactly four named fixtures, and no fifth appears quietly', () => {
  const { seen, excluded } = CORPUS_EXCLUSIONS;
  assert.ok(seen >= 127, `the corpus has ${seen} fixtures`);
  assert.deepEqual(
    excluded,
    [...EXCLUDED],
    'the set of fixtures on which the pinned validate.py stops at FAIL 1, by name. A fixture that joins this set stops being compared on checks 12 to 15 and nothing else would say so',
  );
  console.log(`E8-V5: ${seen} corpus fixtures, ${excluded.length} excluded, ${seen - excluded.length} comparable`);
});

test('E8-V5 fail-before: a fifth frontmatter-failing fixture makes the pin fail, naming it', () => {
  /* The corpus itself is vendored and pinned, so the fifth fixture goes in a scratch directory that the same
     walker reads. tests/e8/fixtures/ already holds one document Python stops at FAIL 1 on, and reading the
     committed one rather than writing a new file keeps this lane's own footprint at the files it owns. */
  const excluded = [...CORPUS_EXCLUSIONS.excluded, ...exclusionsOf(['tests/e8/fixtures']).excluded];
  const e = caught('E8-V5 exclusion pin', () => {
    assert.deepEqual(excluded, [...EXCLUDED], 'the excluded set');
  });
  assert.match(e.message, /v2-frontmatter-stops-python/);
  console.log(`E8-V5 fail-before at the intended check: the pin named the fifth fixture, tests/e8/fixtures/${FAIL1_FIXTURE}.md`);
});

/* ---------- The fail-before mutants: a weakened check admits a fixture this file refuses ---------- */

/** lib/passport/rules.mjs with one named weakening, imported from a scratch copy. Nothing under lib/ is edited. */
const weakened = (replacements) => scratchCopy('lib/passport/rules.mjs', replacements);

test('E8-V1 fail-before: check 12 folding case on the slot lookup admits the case-only binding', async () => {
  const mutant = await weakened([
    [
      'else if (bound && !slotIds.has(target)) binding.push(problem',
      "else if (bound && ![...slotIds].some((id) => id.toLowerCase() === target.toLowerCase())) binding.push(problem",
    ],
  ]);
  const bytes = read('v1-binding-case-only');
  const v = validate(decodeText(bytes));
  const ours = mutant.formatChecks(v.lines, v.inside).map((p) => `${CHECK_NUMBERS[p.code]}:${p.line}`).sort();
  const want = expectedOf(decodeText(bytes), [['E_BINDING', '    binding: Delivery_Target']]);
  const e = caught('E8-V1 check 12', () => assert.deepEqual(ours, want, 'v1-binding-case-only: the enterprise checks 12 to 15'));
  assert.deepEqual(ours, [], 'the mutant admitted the fixture, which is what makes the case fail');
  console.log(`E8-V1 fail-before at the intended check: ${e.message.split('\n')[0]}`);
});

test('E8-V3 fail-before: check 13 reading a commented keeps as a keeps admits the empty state', async () => {
  const mutant = await weakened([
    ["const KEEPS = new RegExp(`^[${WS_ANY}]*keeps:`);", "const KEEPS = new RegExp(`^[${WS_ANY}]*#?[${WS_ANY}]*keeps:`);"],
  ]);
  const bytes = read('v3-keeps-is-a-comment');
  const v = validate(decodeText(bytes));
  const ours = mutant.formatChecks(v.lines, v.inside).map((p) => `${CHECK_NUMBERS[p.code]}:${p.line}`).sort();
  const want = expectedOf(decodeText(bytes), [['E_STATE_REQUIRED', '  - check: The record count is down vs prev']]);
  const e = caught('E8-V3 check 13', () => assert.deepEqual(ours, want, 'v3-keeps-is-a-comment: the enterprise checks 12 to 15'));
  assert.deepEqual(ours, [], 'the mutant admitted the fixture');
  console.log(`E8-V3 fail-before at the intended check: ${e.message.split('\n')[0]}`);
});

/* This mutant is the one that shows why design 3.3 refuses "assert only that both sides refuse". Stripping the
   zero-width character does NOT admit the document: the value now reads as `credentialed`, so check 15 goes quiet
   and check 12 fires instead, on the same line, for the missing binding. A verdict comparison would have called
   that a pass. The (check, line) multiset catches it, because 15:n became 12:n. */
test('E8-V4 fail-before: check 15 stripping zero-width characters moves the finding from 15 to 12', async () => {
  const mutant = await weakened([
    ['const value = scalar(m[1]);', `const value = scalar(m[1]).split(String.fromCodePoint(0x200b)).join('');`],
  ]);
  const bytes = read('v4-access-zero-width');
  const text = decodeText(bytes);
  const v = validate(text);
  const ours = mutant.formatChecks(v.lines, v.inside).map((p) => `${CHECK_NUMBERS[p.code]}:${p.line}`).sort();
  const want = expectedOf(text, [['E_ACCESS', `    access: creden${ZWSP}tialed`]]);
  const e = caught('E8-V4 check 15', () => assert.deepEqual(ours, want, 'v4-access-zero-width: the enterprise checks 12 to 15'));
  const line = linesEqual(text, `    access: creden${ZWSP}tialed`)[0];
  assert.deepEqual(ours, [`12:${line}`], 'the mutant read the value as `credentialed`, so check 12 fires where check 15 did');
  assert.deepEqual(want, [`15:${line}`]);
  assert.equal(
    mutant.formatChecks(v.lines, v.inside).length,
    1,
    'the mutant still refuses the document, which is exactly why the verdict alone would not have caught it',
  );
  console.log(`E8-V4 fail-before at the intended check: ${e.message.split('\n')[0]}`);
});

test('E8-V4 fail-before: a publisher-route scan that does not fold admits the soft-hyphenated address', async () => {
  const mutant = await weakened([
    ['const folded = normalizeForbidden(lines.join(\'\\n\'));', "const folded = lines.join('\\n');"],
    ['const holds = (from, to, needle) => normalizeForbidden(lines.slice(from, to + 1).join(\'\\n\')).includes(needle);', "const holds = (from, to, needle) => lines.slice(from, to + 1).join('\\n').includes(needle);"],
    ['const needle = normalizeForbidden(route);', 'const needle = route;'],
  ]);
  const bytes = read('v4-public-route-folded');
  const v = validate(decodeText(bytes));
  const found = mutant.publicRoutes(v.lines);
  const e = caught('E8-V4 publisher routes', () =>
    assert.equal(found.length > 0, true, 'v4-public-route-folded: the enterprise gate admitted a public publisher route'),
  );
  assert.deepEqual(found, [], 'the unfolded scan found nothing, which is what makes the case fail');
  console.log(`E8-V4 fail-before at the intended check: ${e.message.split('\n')[0]}`);
});

/* ---------- The class counts, so a fixture cannot move class quietly ---------- */

test('E8-V: every committed fixture is in the table, and the classes are what the record says', () => {
  const onDisk = readdirSync(DIR)
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.slice(0, -3))
    .sort();
  const named = [...CASES.map(([n]) => n), FAIL1_FIXTURE].sort();
  assert.deepEqual(onDisk, named, 'a fixture on disk that no case names is a fixture nothing asserts');

  const counts = {};
  for (const [, kind] of CASES) counts[kind] = (counts[kind] ?? 0) + 1;
  assert.deepEqual(counts, { refuse: 12, admit: 6, 'enterprise-only': 1 }, 'the class counts of evidence/e8-approval.md section 5');
  assert.equal(CASES.length + 1, 20, 'nineteen cases and the comparability counterexample');
});
