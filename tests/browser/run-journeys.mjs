#!/usr/bin/env node
/* The journey runner (pages design sections 6 and 7.3; E4 design 4.3).

   A destructive user of the shared local stack: it checks liveness by the exit status of supabase status alone, then
   reseeds through tests/db/00-seed.sh, starts the dev shell, launches one headless Chrome per identity on first use, and
   runs S6 and the journeys in an order where each one's accounts exist: J4's invitee is renamed in J18 and removed in
   J10, J4's second invitee is removed in J7, the E4 journeys make their own company, J17 and J13 replace the shell and
   so come last. Nothing else may use the stack while it runs. It never starts, stops or restarts the stack.

   J15 is computed at the end from every capture the journeys made: each phone image counts only with innerWidth and
   clientWidth 390 and scrollWidth equal to clientWidth, read before and after the capture.

   Where captures go (PW-R-F1, evidence/pages-web-review.md; Q5R-F1, evidence/q5-reversal.md; run-scoped since E8
   day 5, evidence/e8-surface.md). A journey that keeps evidence names its directory in the table below, and its
   captures go into that directory only on a full run (no --only and no --site) that names it with --evidence, and then
   into a directory of the run's own inside it, <evidence>/<label>/. Nothing is ever emptied or removed: a run whose
   <evidence>/<label>/ already exists is refused before the seed, so a run writes only into a directory no earlier run
   wrote, and the images an accepted record names, flat in the evidence directory or under an earlier run's label, stay
   as they were. When the run ends, each such directory gets a run.txt naming the label, the start and end times, the
   revision and the journeys' result, so every image in it belongs to that one run and says how the run went; a run that
   stops early leaves its images and no run.txt. Every other capture goes to .scratch/browser/<label>/captures/: a full
   run without --evidence, a directory the run did not name, a selection, a mutated site, a journey that names no
   directory. The E2 journeys name no directory: their accepted images in evidence/e2-pages/ are not rewritten by a later
   run. Before E8 day 5 a named directory was emptied when the run started, so a run that then stopped before its first
   journey had already removed a slice's accepted images (evidence/e8-surface-repro/q5r-f1-fail-before.log).

   Output: one line per journey on stdout, with the label of every failing check (never a value); the whole record in
   .scratch/browser/<label>/results.json and the phone readings as a table in .scratch/browser/<label>/phone-readings.md.
   Exit 0 when every check passed, 1 when any failed, 2 when the stack is not running.

   Usage: node tests/browser/run-journeys.mjs [--label run-1] [--only J1,J2] [--site <dir> --manifest <file>]
          [--evidence evidence/e5-pages-repro/captures[,<another journey directory>]]
   --site serves an output that was built and then deliberately changed, verified against its own manifest, instead of
   building web/; the mutant runs of evidence/pages-web-repro/ use it. J17 and J13 always rebuild the real tree. */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { seed } from '../e2/helpers/stack.mjs';
import { ROOT, startShell } from './dev-shell.mjs';
import { captureDirFor, createContext, flagsWithoutValue, Journey, promotedEvidence, unknownArguments, unknownJourneyIds, runLabel, SCRATCH } from './harness.mjs';
import { j13, j14, j16, j17 } from './journeys/boundaries.mjs';
import { jf3 } from './journeys/e4-landings.mjs';
import { jr1, jr2, jr3, jr4, jr5, jr6, jr7, jr8, jr9 } from './journeys/e4-refusals.mjs';
import { je3, je4, jg1, jl1 } from './journeys/e4-releases.mjs';
import { ji1, ji6, ji9 } from './journeys/e5-catalog.mjs';
import { ji4, ji5, ji7, ji8 } from './journeys/e5-evidence.mjs';
import { ji2, ji3 } from './journeys/e5-install.mjs';
import { je1, je2, je5, je6, je7 } from './journeys/e4-reviews.mjs';
import { e6jl2, e6jl9 } from './journeys/e6-home.mjs';
import { e6jl3, e6jl4, e6jl5, e6jl6 } from './journeys/e6-members.mjs';
import { e6jl1, e6jl7, e6jl8, e6jls } from './journeys/e6-operator.mjs';
import { e6jlr } from './journeys/e6-refusals.mjs';
import { e728, e7jl1 } from './journeys/e7-mail.mjs';
import { e8hostile, e8resend } from './journeys/e8-hostile-strings.mjs';
import { ena7jl1 } from './journeys/ena7-code-only.mjs';
import { in1, in2, in3, in4, in5, in6 } from './journeys/intake.mjs';
import { k4jl1 } from './journeys/k4-delivery.mjs';
import { ol1, ol2, ol3, ol4 } from './journeys/operator-landing.mjs';
import { j4, j4b, j18 } from './journeys/invitations.mjs';
import { j7, j8, j9, j10 } from './journeys/members.mjs';
import { j5, j6 } from './journeys/second-factor.mjs';
import { j11, j12 } from './journeys/session.mjs';
import { j1, j2, j3, s6 } from './journeys/sign-in.mjs';

const E4_EVIDENCE = 'evidence/e4-pages-repro/captures';
const Q5_EVIDENCE = 'evidence/q5-reversal-repro/captures';
const E5_EVIDENCE = 'evidence/e5-pages-repro/captures';
/* E6's journeys are E6-JL1 to E6-JL9, the design's JL1 to JL9 renamed because E4 already has a JL1 (lead decision
   2026-09-18), plus E6-JLS for the operator's remaining states and E6-JLR for the hand-built refusals. */
const E6_EVIDENCE = 'evidence/e6-pages-repro/captures';
/* E7's mail lane: the `failed` and `unconfirmed` states and the late open (E7 design section 4, cases E7-JL1 and
   E7-28). Both journeys set the delivery mode for their own steps, so they run in a handover run too. */
const E7_EVIDENCE = 'evidence/e7-mail-repro/captures';
/* E8 day 5: E8-5, the hostile strings on the rendered surface, and E8-R12, E6PW-R-F12's claim pressed. They run
   after every journey that reads the operator register, because E8-5 adds companies to it. */
const E8_EVIDENCE = 'evidence/e8-surface-repro/captures';
/* The E3 intake pages (docs/e3/intake-pages-design.md section 10), added by their lane for the reason that pages and
   their journeys were added. IN-5 suspends a company of its own, so no other journey reads what it changes. */
const INTAKE_EVIDENCE = 'evidence/intake-pages-repro/captures';
/* The operator landing and the capture prompt's page (evidence/operator-landing.md), added for the reason that a page and
   a landing rule were added. They run before E8-5, which adds companies to the register the glance reads. */
const OPERATOR_LANDING_EVIDENCE = 'evidence/operator-landing-repro/captures';
/* K4, the invitation's delivery state (docs/e6/design.md 1.2.1): the list's line for each stored word. It sets the
   delivery mode for its own steps, as E7-JL1 does, and makes its own company. */
const K4_EVIDENCE = 'evidence/invite-delivery-repro/captures';
/* ENA-7's code-only link (evidence/ena7-end1-hbf2.md section 5, ENA7-C4): a confirmed account's link, its landing and
   its acceptance, and a new address's signing link as the control. It sets the delivery mode for its own invitations,
   as K4-JL1 does, and makes its own company, so it runs after E8-5 and no journey that reads the register sees it. */
const ENA7_EVIDENCE = 'evidence/ena7-end1-hbf2-repro/captures';

/* [id, title, journey, the evidence directory of its captures on a full run, or null] */
const JOURNEYS = [
  ['S6', 'Token hash fetched by GET or replayed, through the shell', s6, null],
  ['J1', 'Sign-in request', j1, null],
  ['J2', 'Sign-in link landing, new profile and returning profile', j2, null],
  ['J3', 'GET-fetched and replayed hash', j3, null],
  ['J5', 'Admin without a factor, forced to enrol', j5, null],
  ['J6', 'Admin with a factor at aal1', j6, null],
  ['J9', 'Cross-company', j9, null],
  ['J8', 'Member without the admin role', j8, null],
  ['J4', 'Invitation acceptance', j4, null],
  ['J4b', 'Accept while signed in as someone else', j4b, null],
  ['J18', 'Display name set and seen', j18, null],
  ['J7', 'Member management at aal2', j7, null],
  ['J10', 'Removed mid-session', j10, null],
  ['J11', 'Session expiry, refresh and the step-up boundary', j11, null],
  ['J12', 'Sign-out and back', j12, null],
  ['J16', 'Arrival by cross-site navigation', j16, null],
  ['J14', 'Cross-site mutation', j14, null],
  ['JF3', 'The sign-in and invitation landings restored after sign-out (PW-R-F3)', jf3, E4_EVIDENCE],
  ['JE1', 'A reviewer proposes and approves at phone width; a lost answer retried with its key', je1, E4_EVIDENCE],
  ['JE2', 'An author holding it_reviewer: the exclusion, no control, a hand-built request refused', je2, E4_EVIDENCE],
  ['JE7', 'The author of version 1 reviews a fresh version 2 by someone else: attribution kept, not excluded', je7, Q5_EVIDENCE],
  ['JE6', 'The boundary sentence and the losses table for an empty section 6', je6, E4_EVIDENCE],
  ['JR1', 'An approval refused E_GATE_FAILS_NOW points to requesting changes', jr1, E4_EVIDENCE],
  ['JR2', 'A proposal refused E_ASSEMBLY_TOO_LARGE shows the size and the bound', jr2, E4_EVIDENCE],
  ['JR3', 'A page left open: E_ALREADY_SIGNED reloads', jr3, E4_EVIDENCE],
  ['JR4', 'A page left open: E_ENVELOPE_CLOSED reloads', jr4, E4_EVIDENCE],
  ['JR5', 'A page left open: E_NOT_REVIEWABLE reloads', jr5, E4_EVIDENCE],
  ['JR6', 'A page left open: E_ENVELOPE_APPROVED reloads', jr6, E4_EVIDENCE],
  ['JR9', 'A retry past the claim window: E_IDEMPOTENCY_EXPIRED reloads', jr9, E4_EVIDENCE],
  ['JE3', 'An administrator at aal1 sees the second-factor link, then publishes at aal2', je3, E4_EVIDENCE],
  ['JE4', 'The owner withdraws and sees the recipients and the fixed text', je4, E4_EVIDENCE],
  ['JR7', 'A page left open: E_CANDIDATE_SUPERSEDED reloads', jr7, E4_EVIDENCE],
  ['JR8', 'A page left open: E_ALREADY_WITHDRAWN reloads', jr8, E4_EVIDENCE],
  ['JG1', 'Audience groups read, read-only at aal1, changed at aal2', jg1, E4_EVIDENCE],
  ['JE5', 'A reviewer removed while the review screen is open', je5, E4_EVIDENCE],
  ['JL1', 'The lists, the empty company, home links and every not-found state', jl1, E4_EVIDENCE],
  ['JI1', "A recipient's catalog, and the release page before any download", ji1, E5_EVIDENCE],
  ['JI2', 'The download, the pane, the hash, the losses after the answer, and the saved file', ji2, E5_EVIDENCE],
  ['JI3', 'The report in each status, the losses rule from the page and then from the server', ji3, E5_EVIDENCE],
  ['JI5', 'The check-in at day fourteen, and a report clearing it', ji5, E5_EVIDENCE],
  ['JI4', "A reviewer's page carries the reports and no ledger fact (E5D-C-F3)", ji4, E5_EVIDENCE],
  ['JI7', 'Every write control absent where the service refuses, and the service refusing the hand-built request', ji7, E5_EVIDENCE],
  ['JI8', "A reviewer witnesses; the witness's own report is refused; a second witness reloads", ji8, E5_EVIDENCE],
  ['JI6', 'The catalog of a non-recipient, of an administrator, and at the launch state', ji6, E5_EVIDENCE],
  ['JI9', 'A filtered page that is empty above a cursor offers the continuation (rule 11)', ji9, E5_EVIDENCE],
  ['E6-JL1', 'An operator creates a company at phone width; its administrator accepts in a second browser (the exit evidence)', e6jl1, E6_EVIDENCE],
  ['E6-JL8', 'The accept link is a read-only value, in no a element, never in the address, in no capture', e6jl8, E6_EVIDENCE],
  ['E6-JLS', 'The register’s order and the sweep, the create form’s refusals, no dates, the window closed', e6jls, E6_EVIDENCE],
  ['E6-JL7', 'An operator suspends, reads the manifest, closes and deletes a company; no export control', e6jl7, E6_EVIDENCE],
  ['E6-JL3', 'The departure preview, a transfer from inside it, the removal and the removed person’s next request', e6jl3, E6_EVIDENCE],
  ['E6-JL4', 'An orphan blocked in the catalog, transferred by the administrator, downloadable again with no new review', e6jl4, E6_EVIDENCE],
  ['E6-JL5', 'Resend kills the earlier link; the new one works', e6jl5, E6_EVIDENCE],
  ['E6-JL6', 'The operator sets the seat quota; the members page shows it and the warning at 80%', e6jl6, E6_EVIDENCE],
  ['E6-JL2', 'A suspended company from the home page; Export for its administrator; the reading window', e6jl2, E6_EVIDENCE],
  ['E6-JL9', 'Past export_by with the sweep never run; the operator extends the dates and all of it works again', e6jl9, E6_EVIDENCE],
  ['E6-JLR', 'Every hidden E6 control, hand-built from five sessions, refused with nothing written', e6jlr, E6_EVIDENCE],
  ['E7-JL1', 'The failed and unconfirmed invitation states on the members page and /operator/new/, at both widths', e7jl1, E7_EVIDENCE],
  ['E7-28', 'A mailed invitation opened after its hour: refused, no sign-in issued, recovered by a resend', e728, E7_EVIDENCE],
  ['K4-JL1', 'The delivery line of each pending invitation, an unrecorded row resent, nothing for a plain member, at both widths', k4jl1, K4_EVIDENCE],
  ['OL-1', 'Capture an agent from Your agents: three steps, the prompt byte for byte on the page and on the clipboard, a refused copy, no request, the upload form', ol1, OPERATOR_LANDING_EVIDENCE],
  ['OL-2', 'An operator lands on the register, by way of /mfa/ without a factor or at aal1; nobody else is moved; a failed read offers Retry', ol2, OPERATOR_LANDING_EVIDENCE],
  ['OL-3', 'The operator navigation in the header of every operator page, /account/ and /mfa/, and on no one else’s page', ol3, OPERATOR_LANDING_EVIDENCE],
  ['OL-4', 'The glance against the database: statuses, the soonest agreements with their days, what needs the operator; the two orders', ol4, OPERATOR_LANDING_EVIDENCE],
  ['E8-5', 'Hostile company and member strings on the three operator pages and the members page, at phone width', e8hostile, E8_EVIDENCE],
  ['E8-R12', 'Resend offered on a revoked invitation whose address is now a member: pressed, refused, nothing written', e8resend, E8_EVIDENCE],
  ['ENA7-JL1', 'A confirmed account handed a code-only link: no sign-in in it, the landing asks for one, accepted after the person signs in; a new address still signed in; at both widths', ena7jl1, ENA7_EVIDENCE],
  ['IN-1', 'An author pastes, previews, saves and submits at phone width; a reviewer finds it in the queue', in1, INTAKE_EVIDENCE],
  ['IN-2', 'The content gate refuses a carriage return: the server’s reasons shown, nothing stored; the page’s size bound', in2, INTAKE_EVIDENCE],
  ['IN-3', 'A second member cannot open the first author’s draft on any intake page', in3, INTAKE_EVIDENCE],
  ['IN-4', 'A member removed while the draft is open: the next save shows not available, the draft unchanged', in4, INTAKE_EVIDENCE],
  ['IN-5', 'A suspended company: the list refused with the link home, no upload form, the draft not available', in5, INTAKE_EVIDENCE],
  ['IN-6', 'Changes requested: the reason shown, a new version started from it, the contributors carried over', in6, INTAKE_EVIDENCE],
  ['J17', 'The browser rules can fail', j17, null],
  ['J13', 'Maintenance closed', j13, null],
];

const holds = (w) => Boolean(w) && w.innerWidth === 390 && w.clientWidth === 390 && w.scrollWidth === w.clientWidth;

async function main() {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
  };
  /* This runner reads `--flag value`. A `--flag=value` argument matches no flag, so it used to be ignored in silence:
     `--evidence=<dir>` ran as a run that promotes nothing (TOOL2-R-F2, evidence/batch-2-review.md). */
  const glued = args.find((a) => /^--[a-z-]+=/.test(a));
  if (glued) {
    process.stdout.write(`journeys: write ${glued.split('=')[0]} and its value as two arguments, not with =\n`);
    return 2;
  }
  /* The flags this runner reads, written once (B4-RC-F2: the same literal used to be written twice six lines apart,
     so a sixth flag added to one list and not the other would be half-guarded: named by unknownArguments but not
     refused when given without a value, or the reverse). */
  const FLAGS = ['--label', '--only', '--site', '--manifest', '--evidence'];
  /* B3-R-F4: an unknown flag or an unknown journey id is refused here, before the stack is touched; before this the
     runner reseeded, ran 0 of 0 and exited 0 (evidence/batch-3-review-repro/a2-runner-arguments.log). */
  const unknown = unknownArguments(args, FLAGS);
  if (unknown.length) {
    process.stdout.write(`journeys: unknown argument ${unknown[0]}; the flags are ${FLAGS.join(', ')}\n`);
    return 2;
  }
  /* B4-R-F8: a known flag with no value is refused here too; `--only` alone used to mean every journey. */
  const valueless = flagsWithoutValue(args, FLAGS);
  if (valueless.length) {
    process.stdout.write(`journeys: ${valueless[0]} needs a value; nothing ran, and that is not a pass\n`);
    return 2;
  }
  const label = runLabel(valueOf('--label') ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const only = valueOf('--only') ? new Set(valueOf('--only').split(',')) : null;
  const unknownIds = unknownJourneyIds(only, JOURNEYS.map((entry) => entry[0]));
  if (unknownIds.length) {
    process.stdout.write(`journeys: no journey named ${unknownIds.join(', ')}; nothing ran, and that is not a pass\n`);
    return 2;
  }

  if (spawnSync('supabase', ['status'], { cwd: ROOT, stdio: 'ignore' }).status !== 0) {
    process.stdout.write('journeys: the local stack is not running; nothing ran, and that is not a pass\n');
    return 2;
  }
  const site = valueOf('--site');
  const manifest = valueOf('--manifest');
  if (Boolean(site) !== Boolean(manifest)) {
    process.stdout.write('journeys: --site and --manifest go together\n');
    return 2;
  }
  let promote;
  try {
    promote = promotedEvidence({
      value: valueOf('--evidence') ?? null,
      given: args.includes('--evidence'),
      only,
      site,
      known: JOURNEYS.map((entry) => entry[3]).filter(Boolean),
    });
  } catch (e) {
    process.stdout.write(`journeys: ${e.message}\n`);
    return 2;
  }
  /* Q5R-F1, run-scoped: a promoted run writes into <evidence>/<label>/ and nowhere else in the evidence directory, and
     a directory some earlier run already wrote is refused here, before the seed, rather than emptied or added to. */
  const runScoped = [...promote].map((dir) => join(dir, label));
  const taken = runScoped.find((dir) => existsSync(join(ROOT, dir)));
  if (taken) {
    process.stdout.write(`journeys: ${taken} exists and a run never writes into another run's captures; choose another --label\n`);
    return 2;
  }
  const full = !only && !site;
  const started = Date.now();
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() !== '';
  const ids = seed();
  const shell = await startShell(site ? { build: false, siteDir: site, manifestPath: manifest } : {});
  const ctx = createContext({ shell, ids, run: label });
  const results = [];
  try {
    for (const [id, title, run, evidence] of JOURNEYS) {
      if (only && !only.has(id)) continue;
      const captureDir = captureDirFor({ only, site, evidence, label, promote });
      const j = new Journey(ctx, id, title, { captureDir });
      const t0 = Date.now();
      try {
        await run(ctx, j);
      } catch (e) {
        j.check('the journey ran to its end', false, String(e?.message ?? e).slice(0, 600));
        /* What each open tab showed when the journey stopped, for diagnosis: its path, its last /api/ answers as
           method, path, status and code, and a screenshot kept in the scratch record, never in evidence. */
        const dir = join(SCRATCH, label, 'stopped');
        mkdirSync(dir, { recursive: true });
        for (const [index, { page, label: tabLabel }] of j.tabs.entries()) {
          const where = await page.location().catch(() => null);
          const answers = page.requests
            .filter((r) => r.url.includes('/api/'))
            .slice(-8)
            .map((r) => `${r.method} ${new URL(r.url).pathname} ${r.status} ${r.code ?? ''}`);
          j.record(`stopped: ${tabLabel}`, { path: where?.pathname ?? null, answers, exceptions: page.exceptions });
          await page.screenshot(join(dir, `${id}-${index}-${tabLabel}.png`)).catch(() => undefined);
        }
      }
      try {
        await j.finish();
      } catch (e) {
        j.check('the universal assertions ran', false, String(e?.message ?? e).slice(0, 600));
      }
      const failed = j.checks.filter((c) => !c.ok);
      results.push({
        id,
        title,
        passed: j.passed,
        seconds: Math.round((Date.now() - t0) / 1000),
        checks: j.checks,
        recorded: j.recorded,
        notes: j.notes,
        captures: j.captures,
      });
      process.stdout.write(`${id} ${j.passed ? 'PASS' : 'FAIL'} ${j.checks.length - failed.length}/${j.checks.length} ${title}\n`);
      for (const c of failed) process.stdout.write(`   failed: ${c.label}\n`);
    }
  } finally {
    await ctx.closeAll();
    await ctx.shell.close();
  }

  const captures = results.flatMap((r) => r.captures);
  const phone = captures.map((c) => ({
    label: `${c.journey} ${c.state}: innerWidth ${c.widths.innerWidth}, clientWidth ${c.widths.clientWidth}, scrollWidth ${c.widths.scrollWidth}`,
    ok: holds(c.widths) && holds(c.widthsAfterCapture),
  }));
  /* A selection whose journeys capture nothing (J17 alone) has no phone image to judge: J15 is then reported as not run
     rather than failed, and only a full run with no capture at all fails it. */
  if (phone.length === 0 && only) {
    process.stdout.write('J15 NOT RUN: no journey in this selection captures a state\n');
  } else {
    const j15 = { id: 'J15', title: 'Phone pass', passed: phone.length > 0 && phone.every((c) => c.ok), checks: phone, captures: [], recorded: [], notes: [] };
    results.push(j15);
    process.stdout.write(`J15 ${j15.passed ? 'PASS' : 'FAIL'} ${phone.filter((c) => c.ok).length}/${phone.length} ${j15.title}\n`);
  }

  const dir = join(SCRATCH, label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'results.json'), `${JSON.stringify({ label, full, promoted: runScoped, seconds: Math.round((Date.now() - started) / 1000), results }, null, 2)}\n`);
  const table = [
    '| Journey | State | Phone image | innerWidth | clientWidth | scrollWidth | read again after capture |',
    '|---|---|---|---|---|---|---|',
    ...captures.map(
      (c) =>
        `| ${c.journey} | ${c.state} | \`${c.phone}\` | ${c.widths.innerWidth} | ${c.widths.clientWidth} | ${c.widths.scrollWidth} | ${c.widthsAfterCapture.innerWidth} / ${c.widthsAfterCapture.clientWidth} / ${c.widthsAfterCapture.scrollWidth} |`,
    ),
  ].join('\n');
  writeFileSync(join(dir, 'phone-readings.md'), `${table}\n`);
  const failedJourneys = results.filter((r) => !r.passed).map((r) => r.id);
  for (const scoped of runScoped) {
    mkdirSync(join(ROOT, scoped), { recursive: true });
    writeFileSync(
      join(ROOT, scoped, 'run.txt'),
      `label ${label}\nstarted ${new Date(started).toISOString()}\nfinished ${new Date().toISOString()}\nrevision ${revision}${dirty ? ' with uncommitted changes' : ''}\njourneys ${results.length - failedJourneys.length} of ${results.length} passed${failedJourneys.length ? `; failed ${failedJourneys.join(', ')}` : ''}\nevery image here was written by this one full run\n`,
    );
  }
  process.stdout.write(
    `journeys: ${results.length - failedJourneys.length}/${results.length} passed${failedJourneys.length ? `; failed ${failedJourneys.join(', ')}` : ''}; record ${dir}\n`,
  );
  /* B3-R-F4: a run in which no journey ran is not a pass, whatever let it happen. */
  if (results.filter((r) => r.id !== 'J15').length === 0) {
    process.stdout.write('journeys: no journey ran, and that is not a pass\n');
    return 2;
  }
  return failedJourneys.length ? 1 : 0;
}

main().then(
  (code) => {
    process.exit(code);
  },
  (e) => {
    process.stdout.write(`journeys: the runner stopped: ${e?.message ?? e}\n`);
    process.exit(2);
  },
);
