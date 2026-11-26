/* E7-19 (E7 design 1.4, S1 to S9): the smoke sequence against tests/browser/dev-shell.mjs and the LOCAL Supabase
   stack, which is what proves the sequence and its expected answers. Only the hosted run proves the hosted site
   (H-S1), and this file says nothing about it.

   Why it is a stack file. S7, S8 and S9 go to the local Supabase (PostgREST and GoTrue), and S1 to S6 go to the dev
   shell, which serves the real function files through the real adapter and parses the real netlify.toml. Nothing
   here writes: the nine requests are read-only, and S5's POST is refused at the pipeline's step 3, before a session
   and before a body, so no row of any kind can come of it.

   THE TWO FAIL-BEFORES, both of design 1.4's own naming:
     the switch closed              S4 answers 503 E_MAINTENANCE, so a run that expected `open` fails at S4
     the CSP line removed from a
       scratch copy of netlify.toml
       fed to the shell             S1 fails, and it is the only thing that fails
   The second is the reason scripts/smoke.mjs reads no file: the four page headers it expects are its own, and what
   serves them is netlify.toml, so removing a line from netlify.toml is a change to the WORLD and not to the check. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { ROOT, startShell } from '../../browser/dev-shell.mjs';
import { stackEnv } from '../../e2/helpers/stack.mjs';
import { checkSmoke, readAnswers, sequence } from '../../../scripts/smoke.mjs';

const { apiUrl } = stackEnv();
const dirs = [];
function scratch(prefix) {
  const d = mkdtempSync(join(tmpdir(), `e7-smoke-${prefix}-`));
  dirs.push(d);
  return d;
}

let shell;
before(async () => {
  const dir = scratch('open');
  shell = await startShell({ siteDir: join(dir, 'site'), manifestPath: join(dir, 'site-manifest.json') });
});
after(async () => {
  await shell?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const anonKey = () => process.env.SUPABASE_ANON_KEY;

/** The whole sequence against a running shell and the local stack. */
const run = async (origin, expectSwitch = 'open') =>
  checkSmoke(await readAnswers({ origin, supabase: apiUrl, anonKey: anonKey() }), { expectSwitch });

test('E7-19: S1 to S9 against the dev shell and the local stack, every expected answer', { timeout: 120_000 }, async () => {
  const result = await run(shell.origin);
  assert.deepEqual(result.findings, [], JSON.stringify(result.findings, null, 2));
  /* Ten answers for nine ids, because S3 is two requests: /accept and /accept/ (design S3). */
  assert.deepEqual(result.checked, ['S1', 'S2', 'S3', 'S3b', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']);
  assert.equal(sequence({ origin: shell.origin, supabase: apiUrl, anonKey: 'k' }).length, 10);
  /* The run wrote nothing: the shell's own record of every /api/ answer is three refusals and no 2xx. */
  const api = shell.record.filter((e) => e.path.startsWith('/api/'));
  assert.deepEqual(
    api.map((e) => `${e.method} ${e.route} ${e.status} ${e.code ?? ''}`.trim()),
    ['GET me 401 E_UNAUTHENTICATED', 'POST invitationsCreate 403 E_CROSS_SITE', 'GET membersList 401 E_UNAUTHENTICATED'],
  );
  /* And no alert: every one of the three is a refusal, which E7-22 says raises nothing. */
  assert.deepEqual(shell.alerts, []);
});

test('E7-19 fail-before 1: with the switch closed, a run that expects `open` fails at S4, S5 and S6', { timeout: 120_000 }, async () => {
  const dir = scratch('closed');
  const closed = await startShell({
    closed: true,
    siteDir: join(dir, 'site'),
    manifestPath: join(dir, 'site-manifest.json'),
  });
  try {
    const wrong = await run(closed.origin, 'open');
    /* Three, not one: the switch is step 1 of the pipeline, so S5's cross-site refusal and S6's session refusal
       never happen either, and a run that expected an open site is told about all three rather than about S4 alone.
       Design 1.4's fail-before names S4 because S4 is the one whose ANSWER the switch decides; the other two are
       the same fact seen twice more, and saying so is stronger than hiding them. */
    assert.deepEqual(
      wrong.findings.map((f) => f.id),
      ['S4', 'S5', 'S6'],
      JSON.stringify(wrong.findings, null, 2),
    );
    assert.match(wrong.findings[0].rule, /answered 503 E_MAINTENANCE; the switch is meant open/);
    for (const f of wrong.findings.slice(1)) assert.match(f.rule, /answered 503 E_MAINTENANCE/);
    /* And the same closed shell with --expect-switch closed is clean: S4 answers 503 E_MAINTENANCE, which is what
       a closed site is supposed to answer, and S5 and S6 are not asserted because the switch precedes them. */
    const right = await run(closed.origin, 'closed');
    assert.deepEqual(right.findings, [], JSON.stringify(right.findings, null, 2));
  } finally {
    await closed.close();
  }
});

test('E7-19 fail-before 2: with the CSP line removed from netlify.toml, S1 fails and nothing else does', { timeout: 120_000 }, async () => {
  const dir = scratch('nocsp');
  const toml = join(dir, 'netlify.toml');
  const text = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');
  const lines = text.split('\n').filter((l) => !l.trim().startsWith('Content-Security-Policy'));
  assert.equal(lines.length, text.split('\n').length - 1, 'exactly one line was removed');
  writeFileSync(toml, lines.join('\n'));
  const own = await startShell({
    netlifyToml: toml,
    siteDir: join(dir, 'site'),
    manifestPath: join(dir, 'site-manifest.json'),
  });
  try {
    const result = await run(own.origin);
    assert.deepEqual(
      result.findings.map((f) => f.id),
      ['S1'],
      JSON.stringify(result.findings, null, 2),
    );
    assert.match(result.findings[0].rule, /content-security-policy is absent/);
  } finally {
    await own.close();
  }
});

test('E7-19: S7 and S8 are what the Data API refuses, read from the answer and not from a configuration file', { timeout: 60_000 }, async () => {
  const answers = await readAnswers({ origin: shell.origin, supabase: apiUrl, anonKey: anonKey() });
  /* The exact refusals the local PostgREST gives, recorded rather than assumed: E2 1.1 (anon holds no usage on api)
     and the fact that `app` is not an exposed schema at all. */
  assert.ok(answers.S7.status >= 400, `S7 answered ${answers.S7.status}`);
  assert.ok(answers.S8.status >= 400, `S8 answered ${answers.S8.status}`);
  /* And with no key at all they are refused too, so the key is not what is holding the door. */
  const keyless = await readAnswers({ origin: shell.origin, supabase: apiUrl, anonKey: '' });
  assert.ok(keyless.S7.status >= 400 && keyless.S8.status >= 400);
});
