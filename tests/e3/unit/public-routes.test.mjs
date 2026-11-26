/* Case 23: the public publisher route scan (E3 design 3.3; adapter section 7). A literal scan after the
   folding of assemble.mjs normalizeForbidden(); it closes the cheap variants the E0 literal scanner accepted
   and claims nothing wider. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gate } from '../../../lib/passport/gate.mjs';
import { publicRoutes } from '../../../lib/passport/rules.mjs';
import { cp, lineOf, SYNTHETIC, VALIDATED_AT, variant } from './helpers.mjs';

const PROSE = 'It runs when you paste records and ask it to run.';
const run = (text) => gate(Buffer.from(text, 'utf8'), 'text/markdown', { validatedAt: VALIDATED_AT });
const routeProblems = (text) => JSON.parse(JSON.stringify(run(text).problems ?? []));

const REFUSED = [
  ['App.Phaeacia.AI, the case variant the E0 scanner accepted', 'Share it at App.Phaeacia.AI today.', 'App.Phaeacia.AI'],
  ['a zero-width space inside the host, the other E0 variant', `Share it at app.phaea${cp(0x200b)}cia.ai today.`, 'app.phaea'],
  ['a soft hyphen inside the api route', `Call phae${cp(0xad)}acia.ai/api directly.`, 'phae'],
  ['fullwidth letters that NFKC folds', `Open ${cp(0xff41, 0xff50, 0xff50)}.phaeacia.ai now.`, 'phaeacia.ai now'],
  ['markdown noise around the host', 'Open `app`.phaeacia.ai now.', '`app`'],
  ['scripts/publish.py', 'Then run scripts/publish.py once.', 'scripts/publish.py'],
  ['the upload box instruction', 'Now paste it into the upload box.', 'paste it into'],
];

for (const [label, sentence, anchor] of REFUSED) {
  test(`case 23: ${label} is E_PUBLIC_ROUTE by name with its line`, () => {
    const text = variant([[PROSE, `${sentence} ${PROSE}`]]);
    assert.deepEqual(routeProblems(text), [{ code: 'E_PUBLIC_ROUTE', line: lineOf(text, anchor) }]);
  });
}

test('case 23: a line break inside scripts/publish.py is joined, and the refusal names the line where the route starts', () => {
  const text = variant([[PROSE, `Then run scripts/pub\nlish.py once. ${PROSE}`]]);
  assert.deepEqual(routeProblems(text), [{ code: 'E_PUBLIC_ROUTE', line: lineOf(text, 'scripts/pub') }]);
  assert.equal(lineOf(text, 'lish.py') - lineOf(text, 'scripts/pub'), 1);
});

test('case 23: a route inside a golden example fence is still refused, because the whole document is scanned', () => {
  const text = variant([['- B2: blue\n', '- B2: app.phaeacia.ai\n']]);
  assert.deepEqual(routeProblems(text), [{ code: 'E_PUBLIC_ROUTE', line: lineOf(text, 'app.phaeacia.ai') }]);
});

test('case 23: two routes on two lines are two problems in line order', () => {
  const text = variant([
    [PROSE, `Use scripts/publish.py. ${PROSE}`],
    ['- C3: copper\n', '- C3: phaeacia.ai/api\n'],
  ]);
  assert.deepEqual(routeProblems(text), [
    { code: 'E_PUBLIC_ROUTE', line: lineOf(text, 'scripts/publish.py') },
    { code: 'E_PUBLIC_ROUTE', line: lineOf(text, 'phaeacia.ai/api') },
  ]);
});

test('case 23 control: the SYNTHETIC passport names no route and passes', () => {
  assert.equal(run(SYNTHETIC).ok, true);
  assert.deepEqual(publicRoutes(SYNTHETIC.split('\n')), []);
});

test('case 23 control: it is a literal scan, so the bare product host is not a publisher route', () => {
  const text = variant([[PROSE, `Read more at phaeacia.ai. ${PROSE}`]]);
  assert.equal(run(text).ok, true);
});
