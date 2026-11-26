#!/usr/bin/env node
/* Prove the alert sink, alone, from the operator's machine (E7 design 1.5; hosted checklist H-L1).
 *
 *   node scripts/alert-test.mjs --env <file> [--dry-run]
 *
 * One `alert_test` alert through the SINK THE PRODUCT USES: lib/http/alerts.mjs's own alertSink(env), not a copy of
 * it, so a green run here is about the code that will run in a function. Locally the env file points
 * ENTERPRISE_MAIL_ENDPOINT at tests/e7/mail-catcher.mjs and the message lands there; against the provider it lands
 * in the operator's mailbox. The record carries exactly the fields a real alert carries, through the same
 * shapeFields, so what arrives is what a real alert would look like and the operator can compare them.
 *
 * WHAT THIS PROVES, and it is one thing: that the configured sink can deliver. It says nothing about whether the
 * PRODUCT raises an alert when it should, which is the function path, and nothing about the channel's reliability.
 * `--dry-run` builds and prints the record and sends nothing.
 *
 * ================================================================================================================
 * H-L1's SECOND HALF, THE FUNCTION PATH, AND THE FAULT TO PROVOKE IT WITH (E7D-C-F10)
 *
 * H-L1 also asks for one deliberate delivery failure on a synthetic tenant, before customer data exists, observed
 * to raise exactly one alert carrying the allowlisted fields and nothing else. The first version of that procedure
 * provoked the failure by REVOKING THE MAIL KEY. Do not use that fault. The alert's mail sink and the invitation
 * transport are the SAME transport built from the SAME environment values (lib/services/mail.mjs, read per call),
 * so a revoked key stops the alert as surely as it stops the invitation: the expected alert cannot arrive, and the
 * run proves nothing either way. That coupling is structural and is design 1.5's own stated limit.
 *
 * So the fault has to sit DOWNSTREAM of the transport's configuration and INSIDE the invitation path. There are two
 * places it can sit, the recipient and GoTrue's link issuance, and the procedure is:
 *
 *   1. RECOMMENDED, a recipient the provider refuses. Add a synthetic address to the provider's own suppression
 *      list (an account action, Raffael's), then invite that address on the synthetic tenant. The provider answers
 *      a non-2xx, the invitation answers 201 `delivery: "failed"` with its ids and no link, one `delivery_failed`
 *      alert is raised, and it is sent through the same provider to ENTERPRISE_ALERT_TO, which is a different,
 *      unsuppressed address: nothing about the sending configuration was touched, so the alert can arrive.
 *      Then remove the address from the suppression list and invite again, which must answer `mail`.
 *      If the provider ACCEPTS the message instead of refusing it, this fault did not fire. Record that and go to 2
 *      rather than concluding anything: an accepted message is `delivery: "mail"`, and no alert is due.
 *   2. FALLBACK, a GoTrue link failure. GoTrue's per-project rate limit on the calls the invitation makes
 *      (H-A10 is the observation of where that limit is) answers 429, `createInviteeAccount` fails, and
 *      deliverInvitation answers `failed` with the mail provider untouched. Blunt, and it needs many calls; use it
 *      only if 1 did not fire.
 *
 * PROVIDER-DOWN IS A SEPARATE OBSERVATION and is not this test. When the provider is the thing that is down, no
 * `delivery_failed` alert can be delivered through it. What remains is the function log, which holds the
 * pipeline's own line, the alert record and, where the send itself failed, one `{"event":"alert_dropped"}`.
 *
 * THE OUT-OF-BAND ESCALATION, named rather than assumed (E7D-C-F10's third part). The weekly operator check reads
 * the production function log for `delivery_failed`, `alert_dropped` and `internal` lines since the last check, and
 * compares their count with the alerts that actually arrived. A `delivery_failed` line with no alert beside it, or
 * any `alert_dropped` line, means the channel is the thing that failed, and the remedy is the operator's own
 * mailbox rather than the product's. That check is the backstop the recommendation of design 1.5 rests on, and it
 * is a person with a calendar entry, not a machine. A second, independent channel is a subprocessor decision and
 * stays Raffael's (design section 8 question 2).
 * ================================================================================================================
 *
 * The env file is refused inside a Git work tree, exactly as scripts/check-deploy.mjs refuses one and for the same
 * reason: run against the provider, this file holds the sending key. There is no fixture exception here, so the
 * local rehearsal writes its env file to a directory outside every work tree.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALERT_VERSION, alertSink, shapeFields } from '../lib/http/alerts.mjs';
import { envFileRefusal, parseEnvFile } from './check-deploy.mjs';

/** The event word this script sends. It is NOT one of the module's five events: nothing in the product raises it,
    which is how the operator tells a test alert from a real one in a mailbox. */
export const TEST_EVENT = 'alert_test';

/** The record, with the same shaped fields a real `internal` alert carries, so the two look alike in a mailbox. */
export function testRecord(now = new Date()) {
  return {
    event: TEST_EVENT,
    ...shapeFields({ route: 'alertTest', code: 'E_INTERNAL', status: 500, errorName: 'Error' }),
    v: ALERT_VERSION,
    at: now.toISOString(),
    count: 0,
  };
}

const USAGE = [
  'usage: node scripts/alert-test.mjs --env <file> [--dry-run]',
  '  one alert_test alert through the sink ENTERPRISE_ALERT_SINK names, from this machine.',
  '  The env file must be outside every Git work tree. No value of it is ever printed.',
].join('\n');

export function parseArgs(argv) {
  const opts = { env: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--env') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error('--env needs a value');
      opts.env = v;
      i++;
    } else if (argv[i] === '--dry-run') opts.dryRun = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (opts.env === null) throw new Error('--env is required');
  return opts;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stdout.write(`alert-test: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  /* No fixture exception: this file can hold the sending key, whatever it is called. */
  const refusal = envFileRefusal(opts.env, { target: 'hosted' });
  if (refusal !== null) {
    process.stdout.write(`alert-test: ${refusal}\n`);
    return 2;
  }
  let env;
  try {
    env = parseEnvFile(readFileSync(opts.env, 'utf8'));
  } catch (e) {
    process.stdout.write(`alert-test: --env ${opts.env}: ${e.message}\n`);
    return 2;
  }
  const record = testRecord();
  process.stdout.write(`${JSON.stringify(record)}\n`);
  if (env.ENTERPRISE_ALERT_SINK !== 'mail') {
    process.stdout.write(
      'alert-test: ENTERPRISE_ALERT_SINK is not `mail` in this file, so the sink is stderr and the line above IS the alert. Nothing was sent.\n',
    );
    return 0;
  }
  const sink = alertSink(env);
  if (sink === null) {
    process.stdout.write(
      'alert-test: the sink is `mail` and it cannot send: ENTERPRISE_ALERT_TO is missing or malformed, or the transport is not ready. scripts/check-deploy.mjs D16 names which value, without printing it. Nothing was sent.\n',
    );
    return 2;
  }
  if (opts.dryRun) {
    process.stdout.write('alert-test: --dry-run, so the sink was built and nothing was sent.\n');
    return 0;
  }
  try {
    await sink(record);
  } catch (e) {
    /* A MailError carries a fixed message and at most a network code from a closed list, never the provider's own
       words (lib/services/mail.mjs), so printing those two is safe and printing anything else would not be. */
    const outcome = typeof e?.outcome === 'string' ? e.outcome : 'failed';
    const code = typeof e?.code === 'string' ? e.code : 'none';
    process.stdout.write(
      `alert-test: the send did not succeed: outcome ${outcome}, code ${code}. Nothing else of the answer is kept.\n`,
    );
    return 2;
  }
  process.stdout.write(
    'alert-test: one alert_test alert was accepted by the sink. Now confirm it ARRIVED at the recipient: a sink that accepts is not a channel that delivers.\n',
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
