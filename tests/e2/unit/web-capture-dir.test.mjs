/* PW-R-F1's harness half (evidence/pages-web-review.md): a journey's captures reach its evidence directory only on a full
   run, and a selection (--only) or a mutated site (--site) writes them to the run's scratch record, so a mutant run can
   never overwrite evidence. Q5R-F1 (evidence/q5-reversal.md) narrows it: a full run reaches an evidence directory only
   when it names that directory with --evidence, so a full run made to check a revision rewrites no slice's accepted
   images and a lane's run replaces its own slice's and no other's. E8 day 5 makes it run-scoped (evidence/e8-surface.md):
   a promoted run writes into <evidence>/<label>/ only, refuses a label some earlier run already wrote before the seed,
   and empties or removes nothing, because the earlier rule emptied a named directory at the start and a run that then
   stopped had removed a slice's accepted images with nothing in their place (evidence/e8-surface-repro/
   q5r-f1-fail-before.log). The rule is tests/browser/harness.mjs captureDirFor and promotedEvidence; the runner tests
   hold the runner to them, so a runner that computes the destination some other way, or empties anything, fails here. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { ROOT } from '../../browser/dev-shell.mjs';
import {
  captureDirFor,
  flagsWithoutValue,
  promotedEvidence,
  runLabel,
  SCRATCH,
  unknownArguments,
  unknownJourneyIds,
} from '../../browser/harness.mjs';

const EVIDENCE = 'evidence/e4-pages-repro/captures';
const OTHER = 'evidence/e5-pages-repro/captures';
const KNOWN = [EVIDENCE, OTHER, 'evidence/q5-reversal-repro/captures'];
const scratch = (label) => join(SCRATCH, label, 'captures');
const named = new Set([EVIDENCE]);

test('captures go to evidence only on a full run that names that journey directory, and only under its label (Q5R-F1)', () => {
  /* Run-scoped (E8 day 5): the run's own directory inside the evidence directory, never the evidence directory itself,
     so a promoted run cannot write over an image an accepted record names. */
  assert.equal(
    captureDirFor({ only: null, site: null, evidence: EVIDENCE, label: 'full', promote: named }),
    join(ROOT, EVIDENCE, 'full'),
  );
  assert.notEqual(
    captureDirFor({ only: null, site: null, evidence: EVIDENCE, label: 'full', promote: named }),
    join(ROOT, EVIDENCE),
  );
  /* The Q5R-F1 counterexample: a full run that names nothing, and a directory the run did not name. */
  assert.equal(captureDirFor({ only: null, site: null, evidence: EVIDENCE, label: 'full' }), scratch('full'));
  assert.equal(
    captureDirFor({ only: null, site: null, evidence: EVIDENCE, label: 'full', promote: new Set() }),
    scratch('full'),
  );
  assert.equal(
    captureDirFor({ only: null, site: null, evidence: OTHER, label: 'full', promote: named }),
    scratch('full'),
  );
  assert.equal(
    captureDirFor({ only: new Set(['JE1']), site: null, evidence: EVIDENCE, label: 'sel', promote: named }),
    scratch('sel'),
  );
  assert.equal(
    captureDirFor({ only: null, site: '/tmp/mutant', evidence: EVIDENCE, label: 'mut', promote: named }),
    scratch('mut'),
  );
  assert.equal(
    captureDirFor({ only: new Set(['JE1']), site: '/tmp/m', evidence: EVIDENCE, label: 'both', promote: named }),
    scratch('both'),
  );
  assert.equal(captureDirFor({ only: null, site: null, evidence: null, label: 'e2', promote: named }), scratch('e2'));
});

test('--evidence names journey directories exactly, and never with a selection or a mutated site (Q5R-F1)', () => {
  assert.deepEqual(promotedEvidence({ value: null, only: null, site: null, known: KNOWN }), new Set());
  assert.deepEqual(promotedEvidence({ value: EVIDENCE, only: null, site: null, known: KNOWN }), new Set([EVIDENCE]));
  assert.deepEqual(
    promotedEvidence({ value: `${EVIDENCE},${OTHER}`, only: null, site: null, known: KNOWN }),
    new Set([EVIDENCE, OTHER]),
  );
  for (const value of [
    'evidence',
    'evidence/e4-pages-repro',
    `${EVIDENCE}/`,
    `${EVIDENCE}/../../e2-pages`,
    'all',
    '',
    `${EVIDENCE},`,
    '.',
  ])
    assert.throws(() => promotedEvidence({ value, only: null, site: null, known: KNOWN }), TypeError, value);
  assert.throws(
    () => promotedEvidence({ value: EVIDENCE, only: new Set(['JE1']), site: null, known: KNOWN }),
    TypeError,
  );
  assert.throws(() => promotedEvidence({ value: EVIDENCE, only: null, site: '/tmp/m', known: KNOWN }), TypeError);
  /* Q5R-F1-R-F2: the flag with no value, or with the next flag as its value, is refused, never read as nothing. */
  assert.throws(() => promotedEvidence({ value: null, given: true, only: null, site: null, known: KNOWN }), TypeError);
  assert.throws(
    () => promotedEvidence({ value: '--label', given: true, only: null, site: null, known: KNOWN }),
    TypeError,
  );
  const runner = readFileSync(join(ROOT, 'tests', 'browser', 'run-journeys.mjs'), 'utf8');
  assert.equal(
    /given: args\.includes\('--evidence'\)/.test(runner),
    true,
    'the runner says whether the flag was given',
  );
  /* TOOL2-R-F2 (evidence/batch-2-review.md): `--evidence=<dir>` matched no flag and promoted nothing in silence; the
     runner refuses any glued flag before it reads one, and before the stack check, the seed or an rmSync. */
  const gluedAt = runner.indexOf('args.find((a) => /^--[a-z-]+=/.test(a))');
  assert.ok(gluedAt > 0, 'the runner refuses --flag=value');
  assert.ok(gluedAt < runner.indexOf('const label = runLabel('), 'before any flag is read');
  assert.ok(gluedAt < runner.indexOf("spawnSync('supabase'"), 'and before the stack is touched');
});

test('the runner takes every capture destination from captureDirFor and joins no evidence path itself', () => {
  const runner = readFileSync(join(ROOT, 'tests', 'browser', 'run-journeys.mjs'), 'utf8');
  assert.equal(runner.split('captureDirFor({ only, site, evidence, label, promote })').length - 1, 1);
  assert.equal(runner.split('captureDirFor(').length - 1, 1);
  /* Q5R-F1, run-scoped (E8 day 5): the runner empties and removes nothing at all. Before, it emptied every directory
     the run named, at the start, which is the counterexample these lines fail on. */
  assert.equal(runner.split('rmSync').length - 1, 0, 'no rmSync, imported or called');
  assert.equal(/\brm\(|unlinkSync\(|rmdirSync\(/.test(runner), false, 'and no other removal');
  assert.equal(/join\(ROOT, evidence\)/.test(runner), false);
  assert.equal(/new Journey\(ctx, id, title, \{ captureDir \}\)/.test(runner), true);
  /* A label some earlier run already wrote is refused, and refused before the seed touches the stack. */
  const scopedAt = runner.indexOf('const runScoped = [...promote].map((dir) => join(dir, label));');
  const refusedAt = runner.indexOf('const taken = runScoped.find((dir) => existsSync(join(ROOT, dir)));');
  assert.ok(scopedAt > 0 && refusedAt > scopedAt, 'the run-scoped directories and the refusal of one that exists');
  assert.ok(refusedAt < runner.indexOf('const ids = seed();'), 'before the seed');
  /* The run's record is written into its own directory when the run ends, after the results exist. */
  const recordAt = runner.indexOf("join(ROOT, scoped, 'run.txt')");
  assert.ok(recordAt > runner.indexOf('const failedJourneys = '), 'run.txt after the results');
  assert.equal(runner.split("'run.txt'").length - 1, 1, 'and nowhere else');
});

test('a run label is one directory name: a separator or .. is refused, never resolved into evidence (E4PW-R-F3)', () => {
  for (const label of ['../../evidence/e4-pages-repro', 'a/b', '..', '.hidden', '', 'x'.repeat(81), 'sp ace'])
    assert.throws(
      () => captureDirFor({ only: new Set(['JE6']), site: null, evidence: EVIDENCE, label }),
      TypeError,
      label,
    );
  for (const label of ['run-2026-09-16T10-00-00-000Z', 'sel', 'e4.second', 'x'.repeat(80)])
    assert.equal(captureDirFor({ only: new Set(['JE6']), site: null, evidence: EVIDENCE, label }), scratch(label));
  assert.equal(runLabel('run-1'), 'run-1');
  const runner = readFileSync(join(ROOT, 'tests', 'browser', 'run-journeys.mjs'), 'utf8');
  assert.equal(/const label = runLabel\(/.test(runner), true, 'the runner validates the label at the CLI');
});

test('an unknown flag or journey id is named, so a mistyped selection cannot run 0 of 0 and pass (B3-R-F4)', () => {
  const FLAGS = ['--label', '--only', '--site', '--manifest', '--evidence'];
  /* The critic's counterexample: `--evidnce <dir> --only E6-JL09` reseeded, ran nothing and exited 0. */
  assert.deepEqual(unknownArguments(['--evidnce', 'evidence/x', '--only', 'E6-JL09'], FLAGS), [
    '--evidnce',
    'evidence/x',
  ]);
  assert.deepEqual(unknownJourneyIds(new Set(['E6-JL09']), ['E6-JL2', 'E6-JL9']), ['E6-JL09']);
  /* Well-formed lines pass, values included, and a value that looks like a path or a list is a value. */
  assert.deepEqual(
    unknownArguments(
      ['--label', 'run-1', '--only', 'E6-JL2,E6-JL9', '--evidence', 'evidence/e6-pages-repro/captures'],
      FLAGS,
    ),
    [],
  );
  assert.deepEqual(unknownArguments([], FLAGS), []);
  /* B4-R-F8: a known flag with its value forgotten is named too. The critic's live counterexample was `--only` alone,
     which selected every journey and started a full run (evidence/batch-4-review-repro/b4-f8-only-with-no-value.log.txt). */
  assert.deepEqual(flagsWithoutValue(['--only'], FLAGS), ['--only']);
  assert.deepEqual(flagsWithoutValue(['--only', ''], FLAGS), ['--only']);
  assert.deepEqual(flagsWithoutValue(['--label', 'run-1', '--only'], FLAGS), ['--only']);
  assert.deepEqual(flagsWithoutValue(['--only', '--label', 'run-1'], FLAGS), ['--only']);
  assert.deepEqual(flagsWithoutValue(['--only', 'E6-JL2', '--label', 'run-1'], FLAGS), []);
  assert.deepEqual(flagsWithoutValue([], FLAGS), []);
  assert.deepEqual(unknownJourneyIds(null, ['E6-JL2']), []);
  assert.deepEqual(unknownJourneyIds(new Set(['E6-JL2', 'E6-JL9']), ['E6-JL2', 'E6-JL9']), []);
  /* A stray word, and a flag given twice with a stray value between. */
  assert.deepEqual(unknownArguments(['E6-JL2'], FLAGS), ['E6-JL2']);
  assert.deepEqual(unknownArguments(['--only', 'E6-JL2', 'E6-JL9'], FLAGS), ['E6-JL9']);
});
