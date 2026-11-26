#!/usr/bin/env node
/* The probe C4's answer depends on (docs/e7/design.md section 6 C4).
 *
 *   node tests/e7/measure/c4-role-settings-probe.mjs --label <label>
 *
 * C4 asks for the row count at which `api.delete_company` exceeds `app_server`'s 8 s statement timeout. If the
 * route completes at every size up to the routine's own bound, no 57014 is ever seen, and a measurement that
 * never reaches an edge says NOTHING about whether the edge exists: the timeout might simply not be applied to
 * an impersonated request at all.
 *
 * 001 sets two role settings side by side, `statement_timeout = 8s` and `lock_timeout = 5s`, so one probe
 * settles both. It holds the company's own row lock in an owner session and calls an operator route that waits
 * on that lock. If the local PostgREST applies the role's settings, the call gives up at about five seconds.
 *
 * WHAT COUNTS AS ESTABLISHED, written so it cannot pass by accident. Only a refusal that WAITED near the lock
 * timeout establishes anything. A fast refusal establishes nothing at all, whatever its status: the first version
 * of this probe sent a reason code the routine does not admit, was refused 422 in two milliseconds, and a
 * verdict of "status is not 200 and it took under eight seconds" called that a pass. It is not one.
 */
import { psqlSession } from '../../e2/helpers/stack.mjs';
import { seed as seedStack } from '../../e2/helpers/stack.mjs';
import { e6routes, operators } from '../../e6/stack/helpers.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { owner, record, ROOT, sleep } from './helpers.mjs';

const i = process.argv.indexOf('--label');
const label = i > 0 ? process.argv[i + 1] : null;
if (label === null || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(label)) {
  process.stderr.write('usage: node tests/e7/measure/c4-role-settings-probe.mjs --label LABEL\n');
  process.exit(2);
}

const ids = seedStack();
const R = await e6routes([]);
const OP = operators(ids);
const seedCommand = `node tests/e7/measure/seed.mjs sized --rows 200 --label ${label}-lock`;
const f = JSON.parse(
  execFileSync(process.execPath, [join(ROOT, 'tests/e7/measure/seed.mjs'), 'sized', '--rows', '200', '--label', `${label}-lock`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
    .trim()
    .split('\n')
    .pop(),
);

/* The control first: the same call with nothing holding the lock must SUCCEED, so a refusal below is the lock's
   and not the body's, the actor's or the company's state. */
const control = await R.companyStatus(OP.aal2, f.companyId, { status: 'suspended', reasonCode: 'operator_decision' });
const controlOk = control.status === 200;
process.stdout.write(`control: the unlocked route answered ${control.status} ${control.body?.code ?? 'ok'}\n`);
/* Put it back, so the waiting call below has the same transition to make. */
if (controlOk) await R.companyStatus(OP.aal2, f.companyId, { status: 'active', reasonCode: 'operator_decision' });

const holder = psqlSession();
holder.write(`begin; select id from app.companies where id = '${f.companyId}' for no key update;`);
await sleep(1500);
const t0 = Date.now();
let answer;
try {
  answer = await R.companyStatus(OP.aal2, f.companyId, { status: 'suspended', reasonCode: 'operator_decision' });
} catch (e) {
  answer = { status: 0, body: { code: 'threw', message: String(e?.message ?? e).slice(0, 200) } };
}
const waitedMs = Date.now() - t0;
holder.write('rollback;');
await holder.end();
process.stdout.write(`locked: the route answered ${answer.status} ${answer.body?.code ?? ''} after ${waitedMs} ms\n`);

/* The verdict. Established only by a refusal that WAITED near app_server's 5 s lock timeout. */
const waitedNearTheTimeout = waitedMs >= 3500 && waitedMs <= 7500;
const refused = answer.status !== 200;
const established = controlOk && refused && waitedNearTheTimeout;
const why = !controlOk
  ? 'the control call was itself refused, so nothing below is about the lock'
  : !refused
    ? 'the call SUCCEEDED while the row was locked, which it could not have done if it waited on that lock; the probe is wrong, not the database'
    : !waitedNearTheTimeout
      ? `the refusal came after ${waitedMs} ms, nowhere near the 5 s lock timeout, so it is some other refusal and establishes nothing`
      : 'a refusal after about five seconds, which is app_server’s own lock_timeout applied to an impersonated request';

record('C4-role-settings-probe', {
  condition:
    "an owner session holds the company's row lock; an operator route that takes app.lock_company_operator is called through the local PostgREST as app_server",
  numbers: {
    controlStatus: control.status,
    controlCode: control.body?.code ?? null,
    lockedStatus: answer.status,
    lockedCode: answer.body?.code ?? null,
    waitedMs,
    appServerRoleSettings: owner(
      "select coalesce(string_agg(s, '; ' order by s), 'none') from pg_roles r, unnest(r.rolconfig) s where r.rolname = 'app_server';",
    ),
    roleSettingsApplied: established,
    why,
  },
  seed: { label, commands: ['bash tests/db/00-seed.sh', seedCommand] },
  command: 'POST /api/operator/companies/:companyId/status while an owner session holds that company row',
  notes: [
    'This probe exists because C4 reached no edge: every size up to app.limit_delete_rows() completed well inside 8 s, so no 57014 was observed and the timeout had to be shown to exist some other way.',
    'app_server carries lock_timeout = 5s and statement_timeout = 8s as ONE pair of role settings (001 lines 42 and 43), so what applies one applies the other.',
    'A fast refusal establishes NOTHING. The verdict field says which case this run was.',
  ],
});
process.stdout.write(`verdict: roleSettingsApplied=${established}. ${why}\n`);
