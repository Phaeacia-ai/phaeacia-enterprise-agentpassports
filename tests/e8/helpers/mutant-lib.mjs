/* A fail-before mutant as a COPY of lib/, reachable through a real route table.

   WHY A WHOLE-TREE COPY AND NOT tests/e2/helpers/pages.mjs's scratchCopy. That helper copies ONE module and
   rewrites its relative specifiers to absolute URLs, so the copy imports the real modules around it and the test
   calls the copy's exported function directly. That is the right tool for a mutant whose defect is observable in
   the function itself, which is what S2b and S3 use it for. It cannot build the mutants this day needs: E8-3's
   counterexample is a principal cached ACROSS requests, and E8-1's is a principal that falls back to the caller's
   own company, and both are only observable when a request goes through lib/http/pipeline.mjs, into a route, into
   a service and into the mutated module. Rewriting one module's specifiers leaves the route table importing the
   real one, so the mutant would never be reached.

   So: copy lib/ wholesale under .scratch/e8/, patch the named files in the copy, and import the COPY's
   lib/http/routes.mjs. Relative imports inside the copy resolve inside the copy with no rewriting at all, which is
   also why this is less fragile than a specifier rewrite. Two facts make it work and both are checked here:
     - the only specifiers that leave lib/ are lib/passport/'s three imports of ../../vendor/passport/web/lib/, so
       the copy gets a `vendor` symlink to the real tree beside its `lib`; a pinned vendored file is READ through
       it and never written, and scripts/check-format.mjs asserts that tree is outside the formatter's reach;
     - lib/ imports no package, so nothing has to resolve into node_modules. The copy lives under the repository
       root anyway, so Node's upward walk would find it.
   Nothing under lib/ is edited: this lane owns no file there, and a mutant that edited lib/ and restored it would
   leave the worktree dirty if the process died mid-case.

   .scratch/ is untracked and is ignored by every gate (check-format.mjs runs Biome over biome.json's own includes
   and never the root; check-secrets.mjs scans tracked files), so a mutant copy cannot fail a check or reach Git.

   Each caller names its own mutant, and the name goes in the directory and in the record under
   evidence/e8-tenancy-repro/. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT, stackEnv } from '../../e2/helpers/stack.mjs';

const made = [];

/**
 * mutantRoutes(name, edits, deps) -> { dir, table, applied }
 *   edits: [[ 'lib/services/principal.mjs', [[from, to], ...] ], ...]
 *          each `from` must occur EXACTLY ONCE in the copy, or the mutant is refused: a replacement that silently
 *          matched nothing would produce a mutant identical to the real code and a fail-before that never failed.
 *   deps:  the route table's deps; `log` and `alert` default to sinks that swallow, since a mutant's lines are
 *          not the case's subject.
 * The returned table is the COPY's makeRoutes(deps).
 */
export async function mutantRoutes(name, edits, deps = {}) {
  const dir = join(ROOT, '.scratch', 'e8', `mutant-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, 'lib'), join(dir, 'lib'), { recursive: true });
  symlinkSync(join(ROOT, 'vendor'), join(dir, 'vendor'), 'dir');
  made.push(dir);
  const applied = [];
  for (const [rel, replacements] of edits) {
    const path = join(dir, rel);
    let text = readFileSync(path, 'utf8');
    for (const [from, to] of replacements) {
      assert.equal(text.split(from).length, 2, `mutant ${name}: ${JSON.stringify(from.slice(0, 80))} does not occur once in ${rel}`);
      text = text.replace(from, to);
      applied.push(`${rel}: ${from.split('\n')[0].trim().slice(0, 90)}`);
    }
    writeFileSync(path, text);
  }
  const { makeRoutes } = await import(pathToFileURL(join(dir, 'lib', 'http', 'routes.mjs')).href);
  return { dir, applied, table: makeRoutes({ log: () => {}, alert: () => {}, ...deps }) };
}

/**
 * THE FAILURE A COUNTEREXAMPLE PROVOKED. `assert.throws` and `assert.rejects` both answer undefined, and every
 * fail-before here has to READ the message it provoked, because that message is the record.
 *
 * With ENTERPRISE_E8_MUTANT_UNCAUGHT=1 the failure is RETHROWN instead of returned, so the same case, unchanged,
 * produces a genuinely failing run whose output is the fail-before log under evidence/e8-tenancy-repro/. The
 * committed logs were produced that way and each names the variable. Without it the case passes, which is what
 * the gate runs: a suite that failed on purpose is not a gate.
 */
const uncaught = () => process.env.ENTERPRISE_E8_MUTANT_UNCAUGHT === '1';

export function caught(label, fn) {
  try {
    fn();
  } catch (e) {
    if (uncaught()) throw e;
    return e;
  }
  return assert.fail(`${label}: nothing was thrown, so the check did not fail for the counterexample`);
}

export async function caughtAsync(label, fn) {
  try {
    await fn();
  } catch (e) {
    if (uncaught()) throw e;
    return e;
  }
  return assert.fail(`${label}: nothing was thrown, so the check did not fail for the counterexample`);
}

/** Every mutant directory this process made, removed. Callers put it in an `after()`. */
export function removeMutants() {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  made.length = 0;
}

/**
 * An owner-side read, for a mutant that has to know something the product cannot know: whether a row exists in a
 * company the caller cannot see. No product module holds this power (scripts/check-imports.mjs allows the operator
 * client only to lib/operator/, scripts/, tests/ and one named function, and lib/db/operator.mjs exports no table
 * client at all), which is exactly why an existence oracle is not reachable from inside a service today. A mutant
 * that models one therefore has to be given the privilege from outside, and this is that seam: the project's own
 * database container, as tests/db/lib.sh addresses it. The limit this places on the counterexample is stated in
 * evidence/e8-tenancy.md section 3 beside the finding.
 */
export function ownerCountSource() {
  const { dbContainer } = stackEnv();
  return `
import { execFileSync as e8exec } from 'node:child_process';
function e8ownerCount(table, id) {
  const out = e8exec('docker', ['exec', '-i', ${JSON.stringify(dbContainer)}, 'psql', '-U', 'postgres', '-X', '-At', '-c',
    \`select count(*) from app.\${table} where id = '\${id}'\`], { encoding: 'utf8' });
  return Number(out.trim().split('\\n')[0]);
}
`;
}

/** The same read, for the test process itself. */
export function ownerCount(table, id) {
  const { dbContainer } = stackEnv();
  const out = execFileSync(
    'docker',
    ['exec', '-i', dbContainer, 'psql', '-U', 'postgres', '-X', '-At', '-c', `select count(*) from app.${table} where id = '${id}'`],
    { encoding: 'utf8' },
  );
  return Number(out.trim().split('\n')[0]);
}
