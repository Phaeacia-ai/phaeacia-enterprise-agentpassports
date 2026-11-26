/* scripts/check-deploy.mjs (E7 design 1.4): cases E7-18, E7-23's arms for this script, and the two-way pin between
   docs/environment.md's table and the check's own value list.

   NO HOSTED CALL IS MADE HERE OR ANYWHERE IN THIS LANE: no hosted project exists, so the hosted reader runs against
   tests/e7/fixtures/management-api.json, a SYNTHETIC answer whose own header says it is not a recording, and against
   an injected fetchImpl. SUPABASE_ACCESS_TOKEN is a synthetic value, never printed and never sent anywhere.

   Every env file but the committed local fixture is written into a temporary directory, for two reasons that agree:
   the script REFUSES an env file inside a Git work tree (its one exception is that fixture under --target local, and
   case E7-23 asserts both halves), and a hosted file carries a PEM envelope that scripts/check-secrets.mjs rightly
   refuses to have committed at all.

   E7-18's shape: one case per value per rule, each built by changing EXACTLY ONE line of a clean control, so a case
   that fires for the wrong reason shows up as a second finding. Every case asserts the finding's id and variable and
   asserts that NO value of the file appears anywhere in the output. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FIXTURES = join(ROOT, 'tests', 'e7', 'fixtures');
const SCRIPT = join(ROOT, 'scripts', 'check-deploy.mjs');

const { VALUES, PREVIEW_FORBIDDEN, checkDeploy, envFileRefusal, hostedFacts, localFacts, namesOnly, parseConfigToml, parseEnvFile, report } =
  await import('../../../scripts/check-deploy.mjs');

const dirs = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), 'e7-deploy-'));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/* ---------- the two controls ---------- */

const LOCAL_ENV = readFileSync(join(FIXTURES, 'local.env'), 'utf8');
const MANAGEMENT = JSON.parse(readFileSync(join(FIXTURES, 'management-api.json'), 'utf8'));

/* The hosted control, written at run time. The PEM is an ENVELOPE round a placeholder body: D1 checks the envelope,
   and a body that does not parse is refused by lib/db/server.mjs at the first bearer it signs, not here. The
   envelope's words are assembled, because scripts/check-secrets.mjs refuses the literal marker in a tracked file
   and is right to; the body is base64 of PLACEHOLDER-NOT-A-KEY. */
const PEM_WORD = `PRI${'VATE'} KEY`;
const PEM = `-----BEGIN ${PEM_WORD}-----\\nUExBQ0VIT0xERVItTk9ULUEtS0VZ\\n-----END ${PEM_WORD}-----`;
const HOSTED_ENV = [
  'SUPABASE_URL=https://project-ref-placeholder.supabase.co',
  'SUPABASE_ANON_KEY=placeholder-hosted-publishable-key',
  'SUPABASE_SERVICE_ROLE_KEY=placeholder-hosted-service-key',
  'ENTERPRISE_SERVER_SIGNING_ALG=ES256',
  `ENTERPRISE_SERVER_SIGNING_KEY=${PEM}`,
  'ENTERPRISE_SERVER_SIGNING_KID=kid-placeholder-current',
  'ENTERPRISE_ORIGIN=https://enterprise.example.invalid',
  'ENTERPRISE_ACCESS_STATE=open',
  'ENTERPRISE_INVITATION_DELIVERY=handover',
  'ENTERPRISE_ALERT_SINK=none',
  '',
].join('\n');

/* The words the CONTRACT itself is made of. A rule sentence names them ("open or closed", "the local stack signs
   server bearers with HS256"), and naming the contract is not printing the file's value, so they are excluded from
   the "no value in the output" assertion. Every other value of a file is excluded from nothing. */
const VOCABULARY = new Set(['open', 'closed', 'none', 'mail', 'handover', 'HS256', 'ES256', 'resend']);

/** Every value of an env file that is not a word of the contract's own vocabulary. */
const valuesOf = (text) =>
  Object.values(parseEnvFile(text)).filter((v) => v.length >= 4 && !VOCABULARY.has(v));

/** A clean local fact set, with every reader's answer supplied so no rule is unread. */
function localControl(env = parseEnvFile(LOCAL_ENV)) {
  return {
    target: 'local',
    env,
    config: parseConfigToml(readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8')),
    migrations: { changed: [], head: '009', applied: '009' },
    maintenance: { otherLogins: 0, ownerIsMember: false },
    live: { me: { status: 401, code: 'E_UNAUTHENTICATED' } },
    expectSwitch: 'open',
  };
}

/** A clean hosted fact set, from the synthetic Management API answer and a key set holding the current kid. */
function hostedControl(env = parseEnvFile(HOSTED_ENV)) {
  return {
    target: 'hosted',
    env,
    management: MANAGEMENT,
    settings: { disable_signup: true, external: {} },
    netlifyNames: {
      production: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ENTERPRISE_SERVER_SIGNING_KEY', 'ENTERPRISE_MAIL_API_KEY'],
      'deploy-preview': ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'ENTERPRISE_ORIGIN'],
      'branch-deploy': ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'ENTERPRISE_ORIGIN'],
    },
    migrations: { changed: [], head: '009', applied: '009' },
    keySet: { keys: [{ kid: 'kid-placeholder-current' }, { kid: 'kid-placeholder-gotrue' }] },
    templateSha: { hosted: 'same', repository: 'same' },
    live: { me: { status: 401, code: 'E_UNAUTHENTICATED' } },
    expectSwitch: 'open',
    retiredKids: [],
  };
}

/** The ids and variables of a result's findings, as `D1 NAME` strings. */
const shown = (result) => result.findings.map((f) => `${f.id} ${f.variable}`);
/** Every line the report would print. */
function printed(result, target) {
  let out = '';
  report(result, target, (s) => {
    out += s;
  });
  return out;
}

test('E7-18 control: the committed local fixture and the hosted control pass clean, and every fact is checked', () => {
  const local = checkDeploy(localControl());
  assert.deepEqual(shown(local), [], printed(local, 'local'));
  const hosted = checkDeploy(hostedControl());
  assert.deepEqual(shown(hosted), [], printed(hosted, 'hosted'));
  /* All sixteen facts, in both readers, every run. */
  const D = Array.from({ length: 16 }, (_, i) => `D${i + 1}`).sort();
  assert.deepEqual(local.checked, D);
  assert.deepEqual(hosted.checked, D);
  /* Locally D5, D13 and D15 are not applicable and are SAID so, never silently absent. */
  assert.deepEqual(local.notApplicable.map((n) => n.id), ['D5', 'D13', 'D15']);
  assert.deepEqual(hosted.notApplicable.map((n) => n.id), ['D14']);
  assert.deepEqual(local.unread, []);
  assert.deepEqual(hosted.unread, []);
});

test('E7-18 D1: every required value, absent then malformed, is one finding naming it and no value', () => {
  for (const [label, target, text, control] of [
    ['local', 'local', LOCAL_ENV, localControl],
    ['hosted', 'hosted', HOSTED_ENV, hostedControl],
  ]) {
    const base = parseEnvFile(text);
    const required = VALUES.filter((v) => v.required(target, base) && v.contexts.includes(target === 'hosted' ? 'production' : 'local'));
    assert.ok(required.length >= 6, `${label}: ${required.length} required values`);
    for (const value of required) {
      /* Absent. */
      const without = { ...base };
      delete without[value.name];
      const a = checkDeploy(control(without));
      assert.ok(
        shown(a).includes(`D1 ${value.name}`),
        `${label}, ${value.name} absent: ${printed(a, target)}`,
      );
      /* Malformed: one value that fails this value's own shape. For a value whose ONLY rule is non-empty there is
         no such value, and the case asserts that rather than inventing one: the shape accepts any non-empty
         string, so D1's whole assertion about it is presence, and the shape of the key is the provider's. */
      const wrongValue = malformed(value.name);
      if (wrongValue === null) {
        for (const any of ['x', ' ', 'placeholder-anything-at-all', '\u00e9'])
          assert.equal(value.shape(any, target), true, `${label}, ${value.name}: its only rule is non-empty`);
        assert.equal(value.shape('', target), false, `${label}, ${value.name}: and empty fails it`);
        for (const v of valuesOf(text))
          assert.equal(printed(a, target).includes(v), false, `${label}: ${value.name}'s output names a value`);
        continue;
      }
      const m = checkDeploy(control({ ...base, [value.name]: wrongValue }));
      assert.ok(shown(m).includes(`D1 ${value.name}`), `${label}, ${value.name} malformed: ${printed(m, target)}`);
      /* No value of the file, and not the malformed one either, appears in any line the run printed. */
      const out = `${printed(a, target)}${printed(m, target)}`;
      for (const v of [...valuesOf(text), ...(VOCABULARY.has(wrongValue) ? [] : [wrongValue])])
        assert.equal(out.includes(v), false, `${label}: ${value.name}'s output names a value:\n${out}`);
    }
  }
});

/** A value that fails the named value's shape. One per name, so a case cannot fire for two reasons. */
function malformed(name) {
  switch (name) {
    case 'SUPABASE_URL':
      return 'http://project-ref-placeholder.supabase.co/rest/v1';
    case 'ENTERPRISE_ORIGIN':
      return 'https://enterprise.example.invalid/';
    case 'ENTERPRISE_ACCESS_STATE':
      return 'OPEN';
    case 'ENTERPRISE_INVITATION_DELIVERY':
      return 'handover-and-mail';
    case 'ENTERPRISE_SERVER_SIGNING_ALG':
      return 'RS256';
    case 'ENTERPRISE_SERVER_SIGNING_KEY':
      return 'not-a-pem-envelope';
    case 'SUPABASE_JWT_SECRET':
      return 'too-short';
    default:
      /* A value whose only rule is "non-empty" has no malformed case at all: null says so, and the caller proves it
         rather than taking it on trust. */
      return null;
  }
}

test('E7-18 D1: a value whose only rule is non-empty is still checked, and an empty assignment is absent', () => {
  const base = parseEnvFile(LOCAL_ENV);
  const empty = checkDeploy(localControl({ ...base, SUPABASE_ANON_KEY: '' }));
  assert.deepEqual(shown(empty), ['D1 SUPABASE_ANON_KEY'], printed(empty, 'local'));
  assert.match(printed(empty, 'local'), /absent or empty/);
});

test('E7-18 D2: an unknown ENTERPRISE_ or SUPABASE_ name, and a value outside the contexts the contract admits', () => {
  /* The typo design D2 names. */
  const typo = checkDeploy(localControl({ ...parseEnvFile(LOCAL_ENV), ENTERPRISE_ACCES_STATE: 'open' }));
  assert.deepEqual(shown(typo), ['D2 ENTERPRISE_ACCES_STATE'], printed(typo, 'local'));
  /* A name outside the two prefixes is somebody else's and is not the contract's business. */
  const other = checkDeploy(localControl({ ...parseEnvFile(LOCAL_ENV), NODE_OPTIONS: '--enable-source-maps' }));
  assert.deepEqual(shown(other), []);
  /* The test endpoint in a HOSTED file, which is D2's named instance, and the three other values the contract
     keeps out of a deployed function environment. */
  for (const [name, value] of [
    ['ENTERPRISE_MAIL_ENDPOINT', 'http://127.0.0.1:8025/emails'],
    ['ENTERPRISE_DB_PSQL', 'psql -X -At'],
    ['ENTERPRISE_REGISTER_PATH', '/var/lib/phaeacia/register.jsonl'],
    ['SUPABASE_PROJECT_REF', 'projectrefplaceholder'],
  ]) {
    const r = checkDeploy(hostedControl({ ...parseEnvFile(HOSTED_ENV), [name]: value }));
    assert.deepEqual(shown(r), [`D2 ${name}`], printed(r, 'hosted'));
    assert.equal(printed(r, 'hosted').includes(value), false, 'the value is not printed');
  }
  /* And the same endpoint in a LOCAL file is exactly where it belongs. */
  const local = checkDeploy(localControl({ ...parseEnvFile(LOCAL_ENV), ENTERPRISE_MAIL_ENDPOINT: 'http://127.0.0.1:8025/emails' }));
  assert.deepEqual(shown(local), []);
});

test('E7-18 D3: the origin and GoTrue site_url apart, in both readers', () => {
  const local = checkDeploy({ ...localControl(), config: { ...localControl().config, siteUrl: 'http://127.0.0.1:3001' } });
  assert.deepEqual(shown(local), ['D3 ENTERPRISE_ORIGIN'], printed(local, 'local'));
  const hosted = checkDeploy({
    ...hostedControl(),
    management: { ...MANAGEMENT, auth: { ...MANAGEMENT.auth, site_url: 'https://other.example.invalid' } },
  });
  assert.deepEqual(shown(hosted), ['D3 ENTERPRISE_ORIGIN'], printed(hosted, 'hosted'));
  /* A trailing slash on GoTrue's side is the same origin, and the check says so rather than crying wolf. */
  const slash = checkDeploy({
    ...hostedControl(),
    management: { ...MANAGEMENT, auth: { ...MANAGEMENT.auth, site_url: 'https://enterprise.example.invalid/' } },
  });
  assert.deepEqual(shown(slash), []);
});

test('E7-18 D4: the switch against --expect-switch, absent, and the live answer disagreeing', () => {
  const base = parseEnvFile(LOCAL_ENV);
  const against = checkDeploy({ ...localControl(), expectSwitch: 'closed' });
  assert.deepEqual(shown(against), ['D4 ENTERPRISE_ACCESS_STATE', 'D4 GET /api/me'], printed(against, 'local'));
  const absent = { ...base };
  delete absent.ENTERPRISE_ACCESS_STATE;
  const gone = checkDeploy(localControl(absent));
  assert.ok(shown(gone).includes('D4 ENTERPRISE_ACCESS_STATE'), printed(gone, 'local'));
  assert.match(printed(gone, 'local'), /requires it set explicitly/);
  /* Open, and the site answers as if closed. */
  const live = checkDeploy({ ...localControl(), live: { me: { status: 503, code: 'E_MAINTENANCE' } } });
  assert.deepEqual(shown(live), ['D4 GET /api/me'], printed(live, 'local'));
  /* Closed, and it answers as if closed: clean. */
  const closed = checkDeploy({
    ...localControl({ ...base, ENTERPRISE_ACCESS_STATE: 'closed' }),
    expectSwitch: 'closed',
    live: { me: { status: 503, code: 'E_MAINTENANCE' } },
  });
  assert.deepEqual(shown(closed), []);
});

test('E7-18 D5: each of the five secrets in a preview listing, one case each', () => {
  /* The four of design D5 and, since the alerts design 2.4, the mail event route's signing secret, and exactly those:
     every value the contract marks secret in a production context. */
  assert.deepEqual([...PREVIEW_FORBIDDEN].sort(), [
    'ENTERPRISE_MAIL_API_KEY',
    'ENTERPRISE_MAIL_WEBHOOK_SECRET',
    'ENTERPRISE_SERVER_SIGNING_KEY',
    'SUPABASE_JWT_SECRET',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]);
  for (const context of ['deploy-preview', 'branch-deploy']) {
    for (const name of PREVIEW_FORBIDDEN) {
      const control = hostedControl();
      const r = checkDeploy({
        ...control,
        netlifyNames: { ...control.netlifyNames, [context]: [...control.netlifyNames[context], name] },
      });
      assert.deepEqual(shown(r), [`D5 ${name}`], printed(r, 'hosted'));
      assert.match(printed(r, 'hosted'), new RegExp(`set for ${context}`));
    }
  }
});

test('E7-18 D6, D7, D9, D11, D12: the config facts, one case per fact, in both readers', () => {
  const base = localControl();
  const rows = [
    ['D6 [auth] enable_signup', { ...base, config: { ...base.config, enableSignup: true } }],
    ['D7 [api] schemas', { ...base, config: { ...base.config, schemas: ['api', 'public'] } }],
    ['D9 [api] max_rows', { ...base, config: { ...base.config, maxRows: 100 } }],
    ['D11 the before_user_created hook', { ...base, config: { ...base.config, beforeUserCreated: 'pg-functions://postgres/public/somewhere_else' } }],
    ['D11 the mfa_verification_attempt hook', { ...base, config: { ...base.config, mfaVerificationAttemptEnabled: false } }],
    ['D11 TOTP', { ...base, config: { ...base.config, totpEnroll: false } }],
    ['D12 refresh token rotation', { ...base, config: { ...base.config, rotation: false } }],
    ['D12 refresh_token_reuse_interval', { ...base, config: { ...base.config, reuseInterval: 10 } }],
  ];
  for (const [expected, facts] of rows) {
    const r = checkDeploy(facts);
    assert.deepEqual(shown(r), [expected], printed(r, 'local'));
  }
  const h = hostedControl();
  const hostedRows = [
    ['D6 Management API disable_signup', { auth: { ...MANAGEMENT.auth, disable_signup: false } }],
    ['D7 PostgREST db_schema', { postgrest: { ...MANAGEMENT.postgrest, db_schema: 'api, public' } }],
    ['D9 PostgREST max_rows', { postgrest: { ...MANAGEMENT.postgrest, max_rows: 100 } }],
    ['D11 the before_user_created hook', { auth: { ...MANAGEMENT.auth, hook_before_user_created_uri: 'pg-functions://postgres/public/elsewhere' } }],
    ['D11 the mfa_verification_attempt hook', { auth: { ...MANAGEMENT.auth, hook_mfa_verification_attempt_enabled: false } }],
    ['D11 TOTP', { auth: { ...MANAGEMENT.auth, mfa_totp_verify_enabled: false } }],
    ['D12 refresh token rotation', { auth: { ...MANAGEMENT.auth, refresh_token_rotation_enabled: false } }],
    ['D12 refresh_token_reuse_interval', { auth: { ...MANAGEMENT.auth, security_refresh_token_reuse_interval: 10 } }],
  ];
  for (const [expected, over] of hostedRows) {
    const r = checkDeploy({ ...h, management: { ...MANAGEMENT, ...over } });
    assert.deepEqual(shown(r), [expected], printed(r, 'hosted'));
  }
  /* D6's public half, which is the one a person can read without a token. */
  const settings = checkDeploy({ ...h, settings: { disable_signup: false } });
  assert.deepEqual(shown(settings), ['D6 /auth/v1/settings disable_signup'], printed(settings, 'hosted'));
});

test('E7-18 D8: the head behind, and an accepted migration changed', () => {
  const base = localControl();
  const behind = checkDeploy({ ...base, migrations: { changed: [], head: '009', applied: '008' } });
  assert.deepEqual(shown(behind), ['D8 supabase_migrations.schema_migrations'], printed(behind, 'local'));
  const changed = checkDeploy({ ...base, migrations: { changed: [{ rule: 'x', path: '008_lifecycle.sql' }], head: '009', applied: '009' } });
  assert.deepEqual(shown(changed), ['D8 supabase/migrations'], printed(changed, 'local'));
  /* And the real file facts: the tree at this revision is pinned and at its head. */
  const real = checkDeploy({ ...base, migrations: { ...localFileFacts(), applied: localFileFacts().head } });
  assert.deepEqual(shown(real), []);
});

/** The migration file facts the local reader computes, taken from a real run so the case is about the real tree. */
function localFileFacts() {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { checkDeploy } = await import(${JSON.stringify(SCRIPT)});
    const { localFacts } = await import(${JSON.stringify(SCRIPT)});
    const f = await localFacts({ env: {}, root: ${JSON.stringify(ROOT)}, psql: undefined });
    process.stdout.write(JSON.stringify(f.migrations));
  `], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('E7-18 D10: mail mode without its values, and an endpoint that does not answer', () => {
  const base = parseEnvFile(LOCAL_ENV);
  /* Mail mode with nothing else set: D1 asks for each value, D10 asks again with its own reason, and nothing else. */
  const bare = checkDeploy(localControl({ ...base, ENTERPRISE_INVITATION_DELIVERY: 'mail' }));
  assert.deepEqual(shown(bare).sort(), [
    'D10 ENTERPRISE_MAIL_API_KEY',
    'D10 ENTERPRISE_MAIL_FROM',
    'D10 ENTERPRISE_MAIL_PROVIDER',
  ], printed(bare, 'local'));
  assert.deepEqual(bare.unread.map((u) => u.id), ['D10'], 'the catcher was not called, and that is unread');
  /* Every mail value set, and the endpoint silent. */
  const configured = {
    ...base,
    ENTERPRISE_INVITATION_DELIVERY: 'mail',
    ENTERPRISE_MAIL_PROVIDER: 'resend',
    ENTERPRISE_MAIL_API_KEY: 'placeholder-provider-sending-key',
    ENTERPRISE_MAIL_FROM: 'Phaeacia <no-reply@phaeacia.example.invalid>',
    ENTERPRISE_MAIL_ENDPOINT: 'http://127.0.0.1:8025/emails',
  };
  const silent = checkDeploy({ ...localControl(configured), mailEndpointAnswers: false });
  assert.deepEqual(shown(silent), ['D10 the local mail catcher'], printed(silent, 'local'));
  const answering = checkDeploy({ ...localControl(configured), mailEndpointAnswers: true });
  assert.deepEqual(shown(answering), []);
  /* Hosted: the provider's endpoint must demand authentication, and D10 proves no more than that (design 1.4). */
  const hostedMail = { ...parseEnvFile(HOSTED_ENV), ...{ ENTERPRISE_INVITATION_DELIVERY: 'mail', ENTERPRISE_MAIL_PROVIDER: 'resend', ENTERPRISE_MAIL_API_KEY: 'placeholder-provider-sending-key', ENTERPRISE_MAIL_FROM: 'Phaeacia <no-reply@phaeacia.example.invalid>' } };
  const open = checkDeploy({ ...hostedControl(hostedMail), mailEndpointAnswers: false });
  assert.deepEqual(shown(open), ["D10 the provider's endpoint"], printed(open, 'hosted'));
});

test('E7-18 D13: a template hash apart', () => {
  const r = checkDeploy({ ...hostedControl(), templateSha: { hosted: 'one', repository: 'another' } });
  assert.deepEqual(shown(r), ['D13 the magic-link template'], printed(r, 'hosted'));
});

test('E7-18 D14: a login member of app_maintenance, and the owner as an observation', () => {
  const r = checkDeploy({ ...localControl(), maintenance: { otherLogins: 1, ownerIsMember: false } });
  assert.deepEqual(shown(r), ['D14 app_maintenance'], printed(r, 'local'));
  /* The owner's own membership is not a finding and is not hidden either: it is said, with its reason. */
  const owner = checkDeploy({ ...localControl(), maintenance: { otherLogins: 0, ownerIsMember: true } });
  assert.deepEqual(shown(owner), []);
  assert.deepEqual(owner.observations.map((o) => o.id), ['D14']);
  assert.match(printed(owner, 'local'), /OBSERVED D14: the owner/);
  /* Both at once: the finding stands and the observation rides beside it. */
  const both = checkDeploy({ ...localControl(), maintenance: { otherLogins: 2, ownerIsMember: true } });
  assert.deepEqual(shown(both), ['D14 app_maintenance']);
  assert.equal(both.observations.length, 1);
});

test('E7-18 D15: HS256 in a hosted file, a kid absent from the published set, and a retired kid still in it', () => {
  const base = parseEnvFile(HOSTED_ENV);
  const hs = checkDeploy(hostedControl({ ...base, ENTERPRISE_SERVER_SIGNING_ALG: 'HS256' }));
  assert.ok(shown(hs).includes('D15 ENTERPRISE_SERVER_SIGNING_ALG'), printed(hs, 'hosted'));
  assert.match(printed(hs, 'hosted'), /the legacy secret cannot be rotated/);
  const missing = checkDeploy(hostedControl({ ...base, ENTERPRISE_SERVER_SIGNING_KID: 'kid-placeholder-unpublished' }));
  assert.deepEqual(shown(missing), ['D15 ENTERPRISE_SERVER_SIGNING_KID'], printed(missing, 'hosted'));
  const retired = checkDeploy({ ...hostedControl(), retiredKids: ['kid-placeholder-gotrue'] });
  assert.deepEqual(shown(retired), ['D15 --retired-kid'], printed(retired, 'hosted'));
  /* A retired kid that is genuinely gone is clean, which is what the restore runbook is looking for. */
  const gone = checkDeploy({ ...hostedControl(), retiredKids: ['kid-placeholder-source'] });
  assert.deepEqual(shown(gone), []);
});

test('E7-18 D16: a mail sink without a recipient, and without a transport', () => {
  const base = parseEnvFile(HOSTED_ENV);
  const noRecipient = checkDeploy(hostedControl({ ...base, ENTERPRISE_ALERT_SINK: 'mail' }));
  assert.deepEqual(shown(noRecipient).sort(), [
    'D1 ENTERPRISE_ALERT_TO',
    'D16 ENTERPRISE_MAIL_API_KEY',
    'D16 ENTERPRISE_MAIL_FROM',
    'D16 ENTERPRISE_MAIL_PROVIDER',
    'D16 ENTERPRISE_ALERT_TO',
  ].sort(), printed(noRecipient, 'hosted'));
  /* With a recipient and a ready transport, clean: the sink can actually send. */
  const ready = checkDeploy(hostedControl({
    ...base,
    ENTERPRISE_ALERT_SINK: 'mail',
    ENTERPRISE_ALERT_TO: 'operator@phaeacia.example.invalid',
    ENTERPRISE_MAIL_PROVIDER: 'resend',
    ENTERPRISE_MAIL_API_KEY: 'placeholder-provider-sending-key',
    ENTERPRISE_MAIL_FROM: 'Phaeacia <no-reply@phaeacia.example.invalid>',
  }));
  assert.deepEqual(shown(ready), []);
});

test('E7-18: a fact this reader could not read is UNREAD, never a pass', () => {
  const bare = checkDeploy({ target: 'local', env: parseEnvFile(LOCAL_ENV) });
  assert.deepEqual(shown(bare), [], 'nothing is a finding when nothing was read');
  /* D10 is absent from the list because the mode is `handover`: there is no provider to reach, so nothing is owed.
     D14 is there because the owner connection was not read, which is the case the check.sh gate supplies. */
  assert.deepEqual(bare.unread.map((u) => u.id).sort(), ['D11', 'D12', 'D14', 'D3', 'D4', 'D6', 'D7', 'D8', 'D9'].sort());
  assert.match(printed(bare, 'local'), /an unread fact is NOT a pass/);
  /* E7-23's last arm: a Management API answer missing a field makes its rule UNREAD and never crashes. */
  const hollow = checkDeploy({ ...hostedControl(), management: { auth: {}, postgrest: {} } });
  assert.ok(hollow.unread.length >= 4, printed(hollow, 'hosted'));
  assert.equal(hollow.findings.some((f) => f.id === 'D6' || f.id === 'D7' || f.id === 'D9'), false, printed(hollow, 'hosted'));
  const noAuth = checkDeploy({ ...hostedControl(), management: {} });
  assert.ok(noAuth.unread.map((u) => u.id).includes('D3'), printed(noAuth, 'hosted'));
});

/* ---------- the two-way pin, and E7-23's arms for this script ---------- */

test('E7-18: docs/environment.md and the check value list are pinned BOTH WAYS', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'environment.md'), 'utf8');
  /* Only the Values table's rows: the document's later sections name values in prose, and a prose mention is not a
     row of the contract. A row's first cell holds one or two `NAME`s in backticks. */
  const table = doc.slice(doc.indexOf('## Values'), doc.indexOf('The five `ENTERPRISE_MAIL_*` values'));
  const documented = new Set();
  for (const line of table.split('\n')) {
    if (!line.startsWith('| `')) continue;
    for (const m of line.slice(0, line.indexOf('|', 2)).matchAll(/`([A-Z][A-Z0-9_]*)`/g)) documented.add(m[1]);
  }
  const listed = new Set(VALUES.map((v) => v.name));
  assert.ok(documented.size >= 20, `${documented.size} values in the document's table`);
  /* Both directions, each with its own message, so a failure says which side was edited alone. */
  for (const name of documented)
    assert.ok(listed.has(name), `docs/environment.md lists ${name} and scripts/check-deploy.mjs VALUES does not`);
  for (const name of listed)
    assert.ok(documented.has(name), `scripts/check-deploy.mjs VALUES lists ${name} and docs/environment.md's table does not`);
  assert.deepEqual([...listed].sort(), [...documented].sort());
});

test('E7-18: the committed local fixture holds only names the contract lists, and no secret-shaped value', () => {
  const env = parseEnvFile(LOCAL_ENV);
  const listed = new Set(VALUES.map((v) => v.name));
  for (const name of Object.keys(env)) assert.ok(listed.has(name), `the fixture sets ${name}, which the contract does not list`);
  /* scripts/check-secrets.mjs is the gate that proves the second half over the tracked tree; here the shape a
     reader would mistake for a credential is asserted absent from the fixture's own text. */
  assert.equal(LOCAL_ENV.includes(`BEGIN ${PEM_WORD}`), false);
  for (const value of Object.values(env))
    assert.equal(/^[A-Za-z0-9_\-+/=~.]{20,}$/.test(value) && !value.startsWith('placeholder') && !value.startsWith('example'), false, value);
});

/** The script as a command; nothing of the environment leaks in. */
function run(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, ENTERPRISE_DB_PSQL: '', SUPABASE_ACCESS_TOKEN: '', SUPABASE_PROJECT_REF: '', ...env },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('E7-23: every malformed argument exits 2 with a usage line naming the rule, and echoes no value', () => {
  const rows = [
    [[], /--target is required/],
    [['--target'], /--target needs a value/],
    [['--target', 'staging', '--env', 'x'], /--target is local or hosted/],
    [['--target', 'local'], /--env is required/],
    [['--target', 'local', '--env'], /--env needs a value/],
    [['--target', 'hosted', '--env', 'x'], /--target hosted needs --origin/],
    [['--target', 'local', '--env', 'x', '--expect-switch', 'maybe'], /--expect-switch is open or closed/],
    [['--target', 'local', '--env', 'x', '--expect-switch'], /--expect-switch needs a value/],
    [['--target', 'local', '--env', 'x', '--dry-run'], /unknown argument --dry-run/],
    [['--target', 'local', '--env', 'x', '--retired-kid'], /--retired-kid needs a value/],
  ];
  for (const [args, rule] of rows) {
    const r = run(args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.out}`);
    assert.match(r.out, rule, args.join(' '));
    /* A refused argument list prints the usage and nothing about the file. */
    assert.equal(r.out.includes('REFUSE'), false, args.join(' '));
  }
});

test('E7-23: an env file inside a Git work tree is refused, with exactly one exception', () => {
  /* This repository's own committed fixture, under --target local: admitted, and it is the gate's own call. */
  const ok = run(['--target', 'local', '--env', join('tests', 'e7', 'fixtures', 'local.env')]);
  assert.equal(ok.status, 0, ok.out);
  /* The same file under --target hosted: refused, because the exception is the local target's alone. */
  const wrongTarget = run(['--target', 'hosted', '--env', join('tests', 'e7', 'fixtures', 'local.env'), '--origin', 'https://enterprise.example.invalid']);
  assert.equal(wrongTarget.status, 2, wrongTarget.out);
  assert.match(wrongTarget.out, /inside a Git work tree is refused/);
  /* Any other path inside this repository: refused, local target or not. */
  const dir = join(ROOT, '.scratch');
  /* E7G-F3: only tests/db/00-seed.sh creates ROOT/.scratch, so an unseeded checkout has none; the case makes it. */
  mkdirSync(dir, { recursive: true });
  const inTree = join(dir, 'e7-in-tree.env');
  writeFileSync(inTree, LOCAL_ENV);
  try {
    for (const target of ['local', 'hosted']) {
      const r = run(['--target', target, '--env', inTree, ...(target === 'hosted' ? ['--origin', 'https://enterprise.example.invalid'] : [])]);
      assert.equal(r.status, 2, `${target}: ${r.out}`);
      assert.match(r.out, /inside a Git work tree is refused/);
    }
  } finally {
    rmSync(inTree, { force: true });
  }
  /* And the same content OUTSIDE every work tree is read: it is the tree that refuses, not the name. */
  const out = join(scratch(), 'production.env');
  writeFileSync(out, LOCAL_ENV);
  assert.equal(run(['--target', 'local', '--env', out]).status, 0);
  /* envFileRefusal says so directly too, including for a path that does not exist and for a directory. */
  assert.match(envFileRefusal(join(ROOT, 'tests', 'e7', 'fixtures', 'local.env'), { target: 'hosted' }), /Git work tree/);
  assert.equal(envFileRefusal(join(ROOT, 'tests', 'e7', 'fixtures', 'local.env'), { target: 'local' }), null);
  assert.match(envFileRefusal(join(ROOT, 'no-such-file.env'), { target: 'local' }), /does not exist/);
  assert.match(envFileRefusal(ROOT, { target: 'local' }), /not a regular file/);
});

test('E7-23: a malformed env-file line refuses by its NUMBER and never by its text', () => {
  const dir = scratch();
  const file = join(dir, 'broken.env');
  const secret = 'placeholder-a-line-nobody-should-see';
  writeFileSync(file, `SUPABASE_URL=http://127.0.0.1:54321\n${secret}\nENTERPRISE_ORIGIN=http://127.0.0.1:3000\n`);
  const r = run(['--target', 'local', '--env', file]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /line 2 is not KEY=VALUE/);
  assert.equal(r.out.includes(secret), false, r.out);
  /* A comment and a blank line are not malformed, and no expansion happens: a $NAME stays those bytes. */
  const fine = parseEnvFile('# a comment\n\nA=1\nB="two"\nC=\'three\'\nD=$A/x\n');
  assert.deepEqual(fine, { A: '1', B: 'two', C: 'three', D: '$A/x' });
});

test('E7-23: the hosted reader against the synthetic answer makes no call it was not given, and passes clean', async () => {
  const dir = scratch();
  const file = join(dir, 'production.env');
  writeFileSync(file, HOSTED_ENV);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/auth/v1/settings')) return { status: 200, json: async () => ({ disable_signup: true }) };
    if (String(url).endsWith('/jwks.json')) return { status: 200, json: async () => ({ keys: [{ kid: 'kid-placeholder-current' }] }) };
    if (String(url).endsWith('/api/me')) return { status: 401, json: async () => ({ ok: false, code: 'E_UNAUTHENTICATED' }) };
    throw new Error(`the case did not expect ${url}`);
  };
  const names = join(dir, 'netlify-names.json');
  writeFileSync(names, JSON.stringify({ production: ['SUPABASE_URL'], 'deploy-preview': ['SUPABASE_URL'], 'branch-deploy': ['SUPABASE_URL'] }));
  const facts = await hostedFacts({
    env: parseEnvFile(HOSTED_ENV),
    root: ROOT,
    origin: 'https://enterprise.example.invalid',
    expectSwitch: 'open',
    netlifyNamesFile: names,
    fetchImpl,
    management: MANAGEMENT,
    /* A synthetic token, never printed and never sent: `management` is supplied, so no Management API call is made. */
    accessToken: 'placeholder-synthetic-management-token',
    projectRef: 'projectrefplaceholder',
  });
  /* NOT ONE call to api.supabase.com, because the answer was handed in. */
  assert.deepEqual(calls.filter((u) => u.includes('api.supabase.com')), []);
  assert.deepEqual(calls.sort(), [
    'https://enterprise.example.invalid/api/me',
    'https://project-ref-placeholder.supabase.co/auth/v1/.well-known/jwks.json',
    'https://project-ref-placeholder.supabase.co/auth/v1/settings',
  ]);
  const result = checkDeploy(facts);
  assert.deepEqual(shown(result), [], printed(result, 'hosted'));
  /* D13 compares the synthetic answer's template with the repository's own file, and they are the same bytes. */
  assert.equal(facts.templateSha.hosted, facts.templateSha.repository);
  /* The token is in no line of the report and in no fact. */
  const out = printed(result, 'hosted');
  assert.equal(out.includes('placeholder-synthetic-management-token'), false);
  assert.equal(out.includes(`BEGIN ${PEM_WORD}`), false, 'the signing key is in no line of the report');
});

/* K6 (evidence/hardening-k.md; XR-15). Until K6 readJson had no bound, so a Management API that accepted the
   connection and never answered held the check for ever. Two shapes of hang, both through the injectable fetch: one
   that never settles and ignores its signal (the race bounds it), one that honours the signal as a real fetch does. */
test('K6: a Management API read that does not answer inside its bound refuses the run as READ, naming the path and no value', async () => {
  const TOKEN = 'placeholder-synthetic-management-token';
  const REF = 'projectrefplaceholder';
  const hang = {
    ignoring: () => new Promise(() => {}),
    honouring: (init) =>
      new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })),
  };
  for (const [label, never] of Object.entries(hang)) {
    const fetchImpl = async (url, init) => {
      if (String(url).includes('api.supabase.com')) return never(init);
      if (String(url).endsWith('/auth/v1/settings')) return { status: 200, json: async () => ({ disable_signup: true }) };
      if (String(url).endsWith('/jwks.json')) return { status: 200, json: async () => ({ keys: [{ kid: 'kid-placeholder-current' }] }) };
      if (String(url).endsWith('/api/me')) return { status: 401, json: async () => ({ ok: false, code: 'E_UNAUTHENTICATED' }) };
      throw new Error(`the case did not expect ${url}`);
    };
    const started = Date.now();
    const facts = await hostedFacts({
      env: parseEnvFile(HOSTED_ENV),
      root: ROOT,
      origin: 'https://enterprise.example.invalid',
      expectSwitch: 'open',
      fetchImpl,
      accessToken: TOKEN,
      projectRef: REF,
      readTimeoutMs: 50,
    });
    assert.ok(Date.now() - started < 2000, `${label}: the reads are bounded`);
    assert.equal(facts.management, undefined, label);
    assert.deepEqual(facts.readFailures.map((f) => f.read), [
      'Management API /config/auth',
      'Management API /postgrest',
      'Management API /database/migrations',
    ]);
    const result = checkDeploy(facts);
    assert.deepEqual(
      shown(result).filter((f) => f.startsWith('READ ')),
      ['READ Management API /config/auth', 'READ Management API /postgrest', 'READ Management API /database/migrations'],
      label,
    );
    assert.ok(result.unread.map((u) => u.id).includes('D3'), `${label}: the rules that needed the answer are unread too`);
    assert.equal(result.checked.includes('READ'), false, 'READ is not a D-rule');
    const out = printed(result, 'hosted');
    assert.match(out, /^REFUSE READ Management API \/config\/auth: no answer within 50 ms$/m);
    assert.equal(out.includes(TOKEN) || out.includes(REF), false, `${label}: neither the token nor the project reference is printed`);
  }
  /* An answer inside the bound, even an error status, is not READ: it is the unread it always was. */
  const answering = async (url) =>
    String(url).includes('api.supabase.com') ? { status: 500, json: async () => ({}) } : { status: 404, json: async () => null };
  const answered = await hostedFacts({ env: parseEnvFile(HOSTED_ENV), root: ROOT, fetchImpl: answering, accessToken: TOKEN, projectRef: REF, readTimeoutMs: 50 });
  assert.equal(answered.readFailures, undefined);
  assert.deepEqual(shown(checkDeploy(answered)).filter((f) => f.startsWith('READ ')), []);
  /* CK-3: a status whose body never arrives has not answered, whatever the status: READ. */
  const bodyless = async (url) =>
    String(url).includes('api.supabase.com') ? { status: 500, json: () => new Promise(() => {}) } : { status: 404, json: async () => null };
  const hung = await hostedFacts({ env: parseEnvFile(HOSTED_ENV), root: ROOT, fetchImpl: bodyless, accessToken: TOKEN, projectRef: REF, readTimeoutMs: 50 });
  assert.equal(hung.readFailures.length, 3);
});

/* CK-4 (the peer check of evidence/hardening-k.md): with a hung fetch that holds no handle of its own and nothing else
   running, AbortSignal.timeout's unheld timer let the process exit before the bound fired, with no line printed. The
   test runner keeps its own process alive, so this runs in a child that has nothing else. */
test('K6: a hung read with nothing else running still reaches its bound and the REFUSE READ line', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { hostedFacts, checkDeploy, report } = await import(${JSON.stringify(SCRIPT)});
       const facts = await hostedFacts({ env: {}, fetchImpl: () => new Promise(() => {}), accessToken: 'placeholder-synthetic-management-token', projectRef: 'projectrefplaceholder', readTimeoutMs: 50 });
       report(checkDeploy(facts), 'hosted');
       process.stdout.write('END\\n');`,
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^REFUSE READ Management API \/config\/auth: no answer within 50 ms$/m);
  assert.match(child.stdout, /^END$/m);
});

test('E7-23: the local reader reads what it can and leaves the rest unread, with no owner connection', async () => {
  const facts = await localFacts({ env: parseEnvFile(LOCAL_ENV), root: ROOT, psql: undefined });
  assert.equal(facts.target, 'local');
  assert.equal(facts.maintenance, undefined, 'no owner connection means no answer, not a zero');
  assert.equal(facts.migrations.applied, undefined);
  assert.equal(facts.config.maxRows, 200, 'supabase/config.toml is read');
  assert.deepEqual(facts.config.schemas, ['api']);
  const result = checkDeploy(facts);
  assert.deepEqual(shown(result), [], printed(result, 'local'));
  assert.deepEqual(result.unread.map((u) => u.id).sort(), ['D14', 'D4', 'D8']);
});

test('E7-23: the names-only listing keeps names and drops everything else, whatever shape it has', () => {
  assert.deepEqual(namesOnly({ production: ['A', 'B'] }), { production: ['A', 'B'] });
  /* The shape `netlify env:list --json` produces, values and all: only the names survive. */
  assert.deepEqual(namesOnly({ production: [{ key: 'A', value: 'a-real-secret' }, { name: 'B', value: 'another' }] }), {
    production: ['A', 'B'],
  });
  assert.deepEqual(namesOnly({ production: { A: 'a-real-secret', B: 'another' } }), { production: ['A', 'B'] });
  assert.equal(JSON.stringify(namesOnly({ production: [{ key: 'A', value: 'a-real-secret' }] })).includes('a-real-secret'), false);
  assert.deepEqual(namesOnly(null), {});
  assert.deepEqual(namesOnly('x'), {});
});

/* ---------- the operator document's alert table ---------- */

test('docs/self-hosting.md names every alert key lib/http/alerts.mjs admits, so a reader can see what leaves the product', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'self-hosting.md'), 'utf8');
  /* The alert channel's key set is written out in full, and it is the module's own allowlist plus the keys the
     module adds: a reader must be able to see what leaves the product without reading the code. */
  const keys = doc.slice(doc.indexOf('## What the alert channel receives'), doc.indexOf('**What it therefore cannot carry**'));
  assert.ok(keys.length > 0, 'the section exists');
  for (const key of [...Object.keys(ALERT_FIELDS_OF_RECORD), 'event', 'v', 'at', 'count'])
    assert.match(keys, new RegExp(`\\| \`${key}\` \\|`), `the document does not name the alert key ${key}`);
});

/* The allowlist, read from the module rather than restated, so the document is pinned to the code and not to a copy
   of it: a field added to lib/http/alerts.mjs and not to the document fails the case above. */
const { ALERT_FIELDS: ALERT_FIELDS_OF_RECORD } = await import('../../../lib/http/alerts.mjs');

/* The alerts design 2.4: the mail event route's signing secret, its shape as the route's own predicate. A value in the
   provider's form passes D1; a malformed one is a D1 finding naming only the variable; absent is no finding, because
   the route then refuses every post and the check-in says so (ALD-R-F1). The secrets are made here at run time and
   never printed. */
test('the alerts design 2.4: ENTERPRISE_MAIL_WEBHOOK_SECRET is well formed or a D1 finding, and never required', async () => {
  const { randomBytes } = await import('node:crypto');
  const base = localControl();
  const good = `whsec_${randomBytes(32).toString('base64')}`;
  assert.deepEqual(shown(checkDeploy({ ...base, env: { ...base.env, ENTERPRISE_MAIL_WEBHOOK_SECRET: good } })), []);
  for (const bad of [`whsec_${randomBytes(8).toString('base64')}`, randomBytes(24).toString('base64'), 'whsec_ not base64', `whsec_${randomBytes(80).toString('base64')}`]) {
    const r = checkDeploy({ ...base, env: { ...base.env, ENTERPRISE_MAIL_WEBHOOK_SECRET: bad } });
    assert.deepEqual(shown(r), ['D1 ENTERPRISE_MAIL_WEBHOOK_SECRET']);
    assert.equal(printed(r, 'local').includes(bad), false, 'the value is never printed');
  }
  assert.deepEqual(shown(checkDeploy(base)), [], 'absent is not a finding');
});
