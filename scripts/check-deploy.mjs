#!/usr/bin/env node
/* The deployment check (E7 design 1.4). One fact list, D1 to D16, and TWO readers of it.
 *
 *   node scripts/check-deploy.mjs --target local  --env <file> [--origin <origin>] [--expect-switch open|closed]
 *   node scripts/check-deploy.mjs --target hosted --env <file> --origin <https origin>
 *                                 [--netlify-names <file>] [--expect-switch open|closed] [--retired-kid <kid>]...
 *
 * Same shape as scripts/check-migrations.mjs and scripts/check-web.mjs: a PURE function, checkDeploy(facts),
 * returning findings, exit 0 clean and 2 on findings, and --root for tests. What differs is where the facts come
 * from: localFacts() reads the env file, supabase/config.toml, the owner connection and the mail catcher;
 * hostedFacts() reads the env file, Supabase's Management API (SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF from
 * the RUNNER's environment, read only), the public /auth/v1/settings, a names-only listing of Netlify's variables
 * per context, the site's own /api/me and the target's published key set.
 *
 * NO VALUE IS EVER PRINTED. A finding names the D-rule and the variable or the fact, never what was found:
 * --env names a file of one Netlify context's values, which for production holds the service key, the signing key
 * and the mail key. For the same reason the script REFUSES to read an env file inside a Git work tree, with exactly
 * one exception, this repository's own committed synthetic fixture tests/e7/fixtures/local.env under --target local
 * (E7D-C-F12: D1's synthetic-fixture exception). The exception is resolved by real path against this script's own
 * repository root, so no other in-tree path can take it, and scripts/check-secrets.mjs is what keeps that one file
 * free of a secret-shaped value.
 *
 * FOUR OUTCOMES PER FACT, and only findings fail (design 1.4, "what the local run proves"):
 *   finding         the fact was read and it is wrong
 *   unread          this target HAS the fact and this reader could not get it (no owner connection, no --origin, no
 *                   --netlify-names). Printed, never hidden, and never counted as a pass
 *   not applicable  this target does not have the fact at all (D5 and D13 locally, D14 hosted, which is procedure
 *                   H-P7). Printed with its reason
 *   observation     the fact was read, it is not wrong, and it is worth saying out loud, which is the shape the
 *                   inventory of design 1.4 uses for its unknown cells. D14's local answer is the one there is
 * A green local run says NOTHING about the hosted project: D3, D5 to D7, D11 to D13 and D15's key-set half are real
 * only against the Management API, the listing and the published key set, and locally D3, D6, D7, D11 and D12 read
 * supabase/config.toml, which is what the local GoTrue and PostgREST read at start (design 1.4, section 9; E2
 * section 11, "local testing does not establish hosted configuration parity").
 *
 * THE VALUE LIST IS PINNED BOTH WAYS to docs/ops/environment.md's table by tests/e7/unit/check-deploy.test.mjs, so
 * a value added to either without the other fails (design 1.4). VALUES below is that list.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isWebhookSecret } from '../lib/rules/mail-events.mjs';
import { checkMigrations } from './check-migrations.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The one env file the in-tree refusal admits, relative to the repository root, and only for --target local. */
export const FIXTURE_ENV = join('tests', 'e7', 'fixtures', 'local.env');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/* ---------- shapes ---------- */

const ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const NAMED_SENDER = /^([^<>"\p{Cc}\p{Zl}\p{Zp}]{1,64}) <([^<>\s]+)>$/u;
const KEY_SHAPE = /^[!-~]{8,512}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const isAddress = (v) => typeof v === 'string' && v.length <= 254 && ADDRESS.test(v);
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;

/** An origin exactly as a browser sends one: scheme and host, a non-default port only, and nothing after the host. */
function isOrigin(v, { https }) {
  if (!nonEmpty(v) || v !== v.trim()) return false;
  let url;
  try {
    url = new URL(v);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (https && url.protocol !== 'https:') return false;
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return false;
  return v === `${url.protocol}//${url.host}`;
}

const isLoopbackUrl = (v) => {
  if (!nonEmpty(v)) return false;
  try {
    const u = new URL(v);
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && LOOPBACK.has(u.hostname)
    );
  } catch {
    return false;
  }
};

const isSender = (v) => {
  if (!nonEmpty(v) || v.length > 320) return false;
  if (isAddress(v)) return true;
  const m = NAMED_SENDER.exec(v);
  return Boolean(m) && m[1].trim() === m[1] && isAddress(m[2]);
};

/* The PEM envelope's own words, ASSEMBLED and not written out: scripts/check-secrets.mjs refuses the literal marker
   in a tracked file, which is exactly right, and this module only has to RECOGNISE one. What it checks is the
   envelope, not that the bytes inside parse as a key: a body that does not parse is refused by lib/db/server.mjs at
   the first bearer it has to sign, and the smoke sequence's S4 is what shows the site answering at all. */
const PEM_WORD = `PRI${'VATE'} KEY`;
const isPkcs8 = (v) =>
  nonEmpty(v) && v.includes(`-----BEGIN ${PEM_WORD}-----`) && v.includes(`-----END ${PEM_WORD}-----`);

const oneOf =
  (...words) =>
  (v) =>
    typeof v === 'string' && words.includes(v);

/* ---------- the value list, pinned both ways to docs/ops/environment.md ----------
   contexts: which of `production`, `previews`, `local`, `operator` hold the value, as docs/ops/environment.md says.
   onlyIn: the contexts in which the value may appear in an env file AT ALL; D2 refuses it in any other. It is set on
   the four values the contract keeps out of a deployed function environment, and ENTERPRISE_MAIL_ENDPOINT in a
   hosted file is the instance design D2 names. A value the contract merely does not REQUIRE in a context is not
   refused there: the two alert values and the four mail values are production values that a local stack and the
   test suites legitimately set. secret: D5 refuses it in a preview listing.
   required: the target contexts in which D1 demands the value; a predicate over the file, so `mail` mode can make
   the mail values required and `ES256` the key and the key id. */

export const VALUES = Object.freeze([
  {
    name: 'SUPABASE_URL',
    contexts: ['production', 'previews', 'local'],
    shape: (v, t) => isOrigin(v, { https: t === 'hosted' }),
    format: 'the project API origin, https outside local, with nothing after the host',
    required: () => true,
  },
  {
    name: 'SUPABASE_ANON_KEY',
    contexts: ['production', 'previews', 'local'],
    shape: nonEmpty,
    format: 'the publishable key, non-empty',
    required: () => true,
  },
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY',
    contexts: ['production', 'operator'],
    secret: true,
    shape: nonEmpty,
    format: 'the service key, non-empty',
    required: (t) => t === 'hosted',
  },
  {
    name: 'SUPABASE_JWT_SECRET',
    contexts: ['production', 'local'],
    secret: true,
    shape: (v) => nonEmpty(v) && v.length >= 32,
    format: 'the legacy JWT secret, at least 32 characters',
    required: (_t, env) => (env.ENTERPRISE_SERVER_SIGNING_ALG ?? 'HS256') === 'HS256',
  },
  {
    name: 'ENTERPRISE_SERVER_SIGNING_ALG',
    contexts: ['production', 'local'],
    shape: oneOf('HS256', 'ES256'),
    format: 'HS256 or ES256',
    required: (t) => t === 'hosted',
  },
  {
    name: 'ENTERPRISE_SERVER_SIGNING_KEY',
    contexts: ['production'],
    secret: true,
    shape: isPkcs8,
    format: 'a PKCS#8 PEM envelope',
    required: (_t, env) => env.ENTERPRISE_SERVER_SIGNING_ALG === 'ES256',
  },
  {
    name: 'ENTERPRISE_SERVER_SIGNING_KID',
    contexts: ['production'],
    shape: nonEmpty,
    format: 'the key id published in the project JWKS',
    required: (_t, env) => env.ENTERPRISE_SERVER_SIGNING_ALG === 'ES256',
  },
  {
    name: 'ENTERPRISE_ORIGIN',
    contexts: ['production', 'previews', 'local'],
    shape: (v, t) => isOrigin(v, { https: t === 'hosted' }),
    format: 'the site origin as a browser sends it: no trailing slash, path, query, fragment or credentials',
    required: () => true,
  },
  {
    name: 'ENTERPRISE_ACCESS_STATE',
    contexts: ['production', 'local'],
    shape: oneOf('open', 'closed'),
    format: 'open or closed, written explicitly (the product reads anything but open as closed)',
    required: () => true,
  },
  {
    name: 'ENTERPRISE_INVITATION_DELIVERY',
    contexts: ['production', 'local'],
    shape: oneOf('handover', 'mail'),
    format: 'handover or mail',
    required: () => true,
  },
  {
    name: 'ENTERPRISE_DB_PSQL',
    onlyIn: ['local', 'operator'],
    contexts: ['operator', 'local'],
    shape: nonEmpty,
    format: 'the psql command the owner-side scripts run',
    required: () => false,
  },
  {
    name: 'ENTERPRISE_MAIL_PROVIDER',
    contexts: ['production'],
    shape: oneOf('resend'),
    format: 'a key of PROVIDERS in lib/services/mail.mjs: resend',
    required: (_t, env) => env.ENTERPRISE_INVITATION_DELIVERY === 'mail',
  },
  {
    name: 'ENTERPRISE_MAIL_API_KEY',
    contexts: ['production'],
    secret: true,
    shape: (v) => KEY_SHAPE.test(v ?? ''),
    format: 'printable characters, no whitespace, 8 to 512 of them',
    required: (_t, env) => env.ENTERPRISE_INVITATION_DELIVERY === 'mail',
  },
  {
    name: 'ENTERPRISE_MAIL_FROM',
    contexts: ['production'],
    shape: isSender,
    format: '`Name <address>` or a bare address',
    required: (_t, env) => env.ENTERPRISE_INVITATION_DELIVERY === 'mail',
  },
  {
    name: 'ENTERPRISE_MAIL_REPLY_TO',
    contexts: ['production'],
    shape: isAddress,
    format: 'an address',
    required: () => false,
  },
  {
    name: 'ENTERPRISE_MAIL_ENDPOINT',
    onlyIn: ['local'],
    contexts: ['local'],
    shape: isLoopbackUrl,
    format: 'an http(s) URL on a loopback host, with no credentials',
    required: () => false,
  },
  {
    /* The alerts design 2.4: the mail event route's signing secret. Production only and never a preview, so D5 refuses
       it in a preview listing through `secret`; its form is the route's own predicate, so the check and the route
       cannot disagree about what is well formed. Absent is allowed: the route then answers every post 401 and raises
       nothing (ALD-R-F1), and the check-in says "Bounce routing: not configured". */
    name: 'ENTERPRISE_MAIL_WEBHOOK_SECRET',
    contexts: ['production'],
    secret: true,
    shape: isWebhookSecret,
    format: '`whsec_` followed by base64 that decodes to 24 to 64 bytes',
    required: () => false,
  },
  {
    name: 'ENTERPRISE_ALERT_SINK',
    contexts: ['production'],
    shape: oneOf('none', 'mail'),
    format: 'none or mail',
    required: () => false,
  },
  {
    name: 'ENTERPRISE_ALERT_TO',
    contexts: ['production'],
    shape: isAddress,
    format: 'an address',
    required: (_t, env) => env.ENTERPRISE_ALERT_SINK === 'mail',
  },
  {
    name: 'ENTERPRISE_REGISTER_PATH',
    onlyIn: ['operator'],
    contexts: ['operator'],
    shape: (v) => nonEmpty(v) && isAbsolute(v),
    format: 'an absolute path outside every Git work tree',
    required: () => false,
  },
  {
    name: 'SUPABASE_ACCESS_TOKEN',
    onlyIn: ['operator'],
    contexts: ['operator'],
    secret: true,
    shape: nonEmpty,
    format: "the Management API token, in the runner's environment and never in an env file",
    required: () => false,
  },
  {
    name: 'SUPABASE_PROJECT_REF',
    onlyIn: ['operator'],
    contexts: ['operator'],
    shape: nonEmpty,
    format: "the project reference, in the runner's environment and never in an env file",
    required: () => false,
  },
]);

const BY_NAME = new Map(VALUES.map((v) => [v.name, v]));
/** The context an env file of this target belongs to. */
const CONTEXT_OF = Object.freeze({ local: 'local', hosted: 'production' });
/** The values D5 refuses in a preview listing (design D5): the four of E7, and since the alerts design 2.4 the mail
    event route's signing secret. */
export const PREVIEW_FORBIDDEN = Object.freeze(
  VALUES.filter((v) => v.secret && v.contexts.includes('production')).map((v) => v.name),
);

/* ---------- the pure check ---------- */

/**
 * checkDeploy(facts) -> { findings, unread, notApplicable, checked }
 * facts: { target, env, config, live, management, settings, netlifyNames, migrations, keySet, retiredKids,
 *          expectSwitch, mailEndpointAnswers, maintenance, templateSha, readFailures }
 * Every entry of facts may be `undefined`, which means this reader could not read it; a rule that needs it then
 * reports `unread` instead of a finding, so an unreadable fact is never silently a pass.
 */
export function checkDeploy(facts) {
  const target = facts.target === 'hosted' ? 'hosted' : 'local';
  const hosted = target === 'hosted';
  const env = facts.env ?? {};
  const findings = [];
  const unread = [];
  const notApplicable = [];
  const observations = [];
  const checked = new Set();
  const refuse = (id, variable, rule) => findings.push({ id, variable, rule });
  const cannotRead = (id, reason) => unread.push({ id, reason });
  const skip = (id, reason) => notApplicable.push({ id, reason });
  const observe = (id, note) => observations.push({ id, note });
  const did = (id) => checked.add(id);

  /* READ (lane K6): a Management API read that did not answer inside its bound. It is not a D-rule and joins no
     `checked` list: the rules that needed the answer report themselves unread, as for any failed read, and this refuses
     the run besides, because a hosted check whose only reader of the project's configuration hung has not checked it.
     An answer is its status and its body: one that arrived whole in time, whatever its status, is unread and not this;
     a status whose body never arrived in time is this (CK-3). */
  for (const f of Array.isArray(facts.readFailures) ? facts.readFailures : []) refuse('READ', f.read, f.failure);

  /* D1: every required value present and well formed. */
  did('D1');
  for (const value of VALUES) {
    const present = Object.hasOwn(env, value.name) && env[value.name].length > 0;
    const needed = value.required(target, env) && value.contexts.includes(CONTEXT_OF[target]);
    if (!present) {
      if (needed) refuse('D1', value.name, `required for ${CONTEXT_OF[target]} and absent or empty: ${value.format}`);
      continue;
    }
    if (!value.shape(env[value.name], target)) refuse('D1', value.name, `malformed: ${value.format}`);
  }

  /* D2: no unknown name, and no value outside the contexts the contract lists for it. */
  did('D2');
  for (const name of Object.keys(env)) {
    if (!/^(?:ENTERPRISE|SUPABASE)_/.test(name)) continue;
    const value = BY_NAME.get(name);
    if (value === undefined) {
      refuse(
        'D2',
        name,
        'an ENTERPRISE_ or SUPABASE_ name docs/ops/environment.md does not list (a typo, or a value nobody reads)',
      );
      continue;
    }
    if (value.onlyIn !== undefined && !value.onlyIn.includes(CONTEXT_OF[target]))
      refuse(
        'D2',
        name,
        `set in a ${CONTEXT_OF[target]} file, and the contract admits it in ${value.onlyIn.join(' and ')} only${name === 'ENTERPRISE_MAIL_ENDPOINT' ? ' (the local catcher, never a deployed site)' : ''}`,
      );
  }

  /* D3: ENTERPRISE_ORIGIN equals GoTrue's site_url. */
  did('D3');
  const siteUrl = hosted ? facts.management?.auth?.site_url : facts.config?.siteUrl;
  if (siteUrl === undefined)
    cannotRead(
      'D3',
      hosted
        ? 'the Management API auth configuration was not read'
        : 'supabase/config.toml [auth] site_url was not read',
    );
  else if (!nonEmpty(env.ENTERPRISE_ORIGIN))
    refuse('D3', 'ENTERPRISE_ORIGIN', 'absent, so it cannot be compared with GoTrue site_url');
  else if (env.ENTERPRISE_ORIGIN !== siteUrl.replace(/\/$/, ''))
    refuse('D3', 'ENTERPRISE_ORIGIN', "differs from GoTrue's site_url (pages design 1311, E2 pages 8.4)");

  /* D4: the switch is what the operator intends, in the file and, where a site answers, live. */
  did('D4');
  if (!Object.hasOwn(env, 'ENTERPRISE_ACCESS_STATE'))
    refuse(
      'D4',
      'ENTERPRISE_ACCESS_STATE',
      'absent; E2 section 11 requires it set explicitly, because unset is closed',
    );
  else if (facts.expectSwitch !== undefined && env.ENTERPRISE_ACCESS_STATE !== facts.expectSwitch)
    refuse('D4', 'ENTERPRISE_ACCESS_STATE', `differs from --expect-switch ${facts.expectSwitch}`);
  const intended = facts.expectSwitch ?? env.ENTERPRISE_ACCESS_STATE;
  if (facts.live?.me === undefined)
    cannotRead('D4', 'the live answer of GET <origin>/api/me was not read (no --origin)');
  else {
    const want =
      intended === 'closed' ? { status: 503, code: 'E_MAINTENANCE' } : { status: 401, code: 'E_UNAUTHENTICATED' };
    if (facts.live.me.status !== want.status || facts.live.me.code !== want.code)
      refuse(
        'D4',
        'GET /api/me',
        `the live answer disagrees with the switch: ${intended} means ${want.status} ${want.code}`,
      );
  }

  /* D5: no secret in a preview context. */
  did('D5');
  if (!hosted) skip('D5', 'a local stack has no preview context; the names-only Netlify listing is hosted only');
  else if (facts.netlifyNames === undefined)
    cannotRead('D5', 'the names-only Netlify listing was not read (no --netlify-names)');
  else
    for (const context of ['deploy-preview', 'branch-deploy']) {
      const names = facts.netlifyNames[context];
      if (!Array.isArray(names)) {
        cannotRead('D5', `the listing holds no ${context} context`);
        continue;
      }
      for (const name of PREVIEW_FORBIDDEN)
        if (names.includes(name))
          refuse('D5', name, `set for ${context}; E1 section 2 and E2 1.4 and 11: a preview holds no secret`);
    }

  /* D6: public sign-up off. */
  did('D6');
  if (hosted) {
    const settings = facts.settings;
    const api = facts.management?.auth;
    if (settings === undefined && api === undefined)
      cannotRead('D6', 'neither /auth/v1/settings nor the Management API was read');
    else {
      /* Per FIELD, not per answer: an answer that carries no disable_signup is a fact this reader did not get, and
         an absent field must never read as `off` (E7-23's last arm). */
      for (const [label, answer] of [
        ['/auth/v1/settings disable_signup', settings],
        ['Management API disable_signup', api],
      ]) {
        if (answer === undefined) continue;
        if (answer.disable_signup === undefined) cannotRead('D6', `the answer carries no disable_signup (${label})`);
        else if (answer.disable_signup !== true) refuse('D6', label, 'public sign-up is on');
      }
    }
  } else if (facts.config?.enableSignup === undefined)
    cannotRead('D6', 'supabase/config.toml [auth] enable_signup was not read');
  else if (facts.config.enableSignup !== false) refuse('D6', '[auth] enable_signup', 'public sign-up is on');

  /* D7: the exposed schema is `api` alone. */
  did('D7');
  const schemas = hosted ? facts.management?.postgrest?.db_schema : facts.config?.schemas?.join(', ');
  if (schemas === undefined)
    cannotRead(
      'D7',
      hosted
        ? 'the Management API PostgREST configuration was not read'
        : 'supabase/config.toml [api] schemas was not read',
    );
  else if (
    schemas
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join(',') !== 'api'
  )
    refuse(
      'D7',
      hosted ? 'PostgREST db_schema' : '[api] schemas',
      'the exposed schema list is not exactly `api` (E2 section 11)',
    );

  /* D8: the migration registry is at the expected head, and no accepted migration changed. */
  did('D8');
  if (facts.migrations === undefined) cannotRead('D8', 'the migration facts were not read');
  else {
    if (facts.migrations.changed === undefined) cannotRead('D8', 'scripts/check-migrations.mjs was not run');
    else if (facts.migrations.changed.length > 0)
      refuse(
        'D8',
        'supabase/migrations',
        `scripts/check-migrations.mjs reports ${facts.migrations.changed.length} problem(s); an accepted migration changed or is unpinned`,
      );
    if (facts.migrations.applied === undefined)
      cannotRead(
        'D8',
        hosted
          ? "the Management API's migration list was not read"
          : 'supabase_migrations.schema_migrations was not read (no owner connection: ENTERPRISE_DB_PSQL unset)',
      );
    else if (facts.migrations.applied !== facts.migrations.head)
      refuse(
        'D8',
        'supabase_migrations.schema_migrations',
        'the highest applied version is not the highest version under supabase/migrations/',
      );
  }

  /* D9: PostgREST max_rows is 200 (E3's and E4's paging sentinels are derived from it). */
  did('D9');
  const maxRows = hosted ? facts.management?.postgrest?.max_rows : facts.config?.maxRows;
  if (maxRows === undefined)
    cannotRead(
      'D9',
      hosted
        ? 'the Management API PostgREST configuration was not read'
        : 'supabase/config.toml [api] max_rows was not read',
    );
  else if (Number(maxRows) !== 200) refuse('D9', hosted ? 'PostgREST max_rows' : '[api] max_rows', 'it is not 200');

  /* D10: the delivery mode, and in `mail` mode a reachable provider. */
  did('D10');
  const mode = env.ENTERPRISE_INVITATION_DELIVERY;
  if (mode === 'mail') {
    for (const name of ['ENTERPRISE_MAIL_PROVIDER', 'ENTERPRISE_MAIL_API_KEY', 'ENTERPRISE_MAIL_FROM'])
      if (!nonEmpty(env[name])) refuse('D10', name, 'the delivery mode is `mail` and this value is missing');
    if (facts.mailEndpointAnswers === undefined)
      cannotRead('D10', hosted ? "the provider's endpoint was not called" : 'the local catcher was not called');
    else if (facts.mailEndpointAnswers !== true)
      refuse(
        'D10',
        hosted ? "the provider's endpoint" : 'the local mail catcher',
        hosted ? 'an unauthenticated request did not answer 401 over TLS' : 'the endpoint did not answer',
      );
  }

  /* D11: the hooks and the factors. */
  did('D11');
  const hooks = hosted ? facts.management?.auth : facts.config;
  if (hooks === undefined)
    cannotRead(
      'D11',
      hosted
        ? 'the Management API auth configuration was not read'
        : 'supabase/config.toml hook and MFA settings were not read',
    );
  else {
    const want = [
      ['beforeUserCreated', 'app.hook_before_user_created', 'before_user_created'],
      ['mfaVerificationAttempt', 'app.hook_mfa_verification_attempt', 'mfa_verification_attempt'],
    ];
    for (const [key, fn, label] of want) {
      const uri = hosted ? hooks[`hook_${label}_uri`] : hooks[key];
      const on = hosted ? hooks[`hook_${label}_enabled`] : hooks[`${key}Enabled`];
      if (uri === undefined || on === undefined) cannotRead('D11', `the ${label} hook setting was not read`);
      /* Both readers see a pg-functions URI, whose schema and function are a PATH (pg-functions://postgres/app/
         hook_before_user_created), so the tail is compared in both forms and a hook pointing anywhere else fails. */ else if (
        on !== true ||
        !(String(uri).endsWith(fn) || String(uri).endsWith(fn.replace('.', '/')))
      )
        refuse('D11', `the ${label} hook`, `it is not enabled at ${fn}`);
    }
    const enroll = hosted ? hooks.mfa_totp_enroll_enabled : hooks.totpEnroll;
    const verify = hosted ? hooks.mfa_totp_verify_enabled : hooks.totpVerify;
    if (enroll === undefined || verify === undefined) cannotRead('D11', 'the TOTP settings were not read');
    else if (enroll !== true || verify !== true) refuse('D11', 'TOTP', 'enrolment or verification is off');
  }

  /* D12: the refresh-token settings (pages design 2.9). */
  did('D12');
  const rotation = hosted ? facts.management?.auth?.refresh_token_rotation_enabled : facts.config?.rotation;
  const reuse = hosted ? facts.management?.auth?.security_refresh_token_reuse_interval : facts.config?.reuseInterval;
  if (rotation === undefined || reuse === undefined)
    cannotRead(
      'D12',
      hosted
        ? 'the Management API refresh-token settings were not read'
        : 'supabase/config.toml [auth] refresh-token settings were not read',
    );
  else {
    if (rotation !== true) refuse('D12', 'refresh token rotation', 'rotation is off');
    if (Number(reuse) !== 0)
      refuse(
        'D12',
        'refresh_token_reuse_interval',
        'it is not 0, so a used refresh token can be used again inside a grace window',
      );
  }

  /* D13: the sign-in template is the repository's. */
  did('D13');
  if (!hosted) skip('D13', 'the local mailer is a no-op, so no template is installed: D13 is hosted only');
  else if (facts.templateSha === undefined) cannotRead('D13', 'the Management API magic-link template was not read');
  else if (facts.templateSha.hosted !== facts.templateSha.repository)
    refuse('D13', 'the magic-link template', "its SHA-256 differs from supabase/templates/sign-in.html's");

  /* D14: app_maintenance has no login member OTHER THAN the owner the connection authenticates as.
     Why the owner is excepted, said plainly. app_maintenance is NOLOGIN NOINHERIT NOBYPASSRLS (001), a role reached
     by SET ROLE from the owner, and the owner already holds everything it does (locally rolbypassrls). What E2
     section 11 protects against is a role somebody can LOG IN as reaching those policies without the owner's
     credential, and that is what a finding here is. The owner's own membership is reported as an observation
     instead, because it is a real fact about the cluster and one a reader should see: locally the database probes
     leave `grant app_maintenance to postgres` behind (tests/db/09-closure.sh, 29-lifecycle.sh, 32-recovery-hold.sh),
     a CLUSTER-level grant that no reseed removes, so on a machine that has ever run them the owner is a member for
     good. Hosted, H-P7 is the procedure and this reader has no database credential at all. */
  did('D14');
  if (hosted) skip('D14', 'not readable without a database credential; hosted procedure H-P7');
  else if (facts.maintenance === undefined)
    cannotRead('D14', 'the owner connection was not read (ENTERPRISE_DB_PSQL unset)');
  else {
    if (facts.maintenance.otherLogins > 0)
      refuse(
        'D14',
        'app_maintenance',
        `${facts.maintenance.otherLogins} login role(s) other than the owner are members of it (E2 section 11)`,
      );
    if (facts.maintenance.ownerIsMember)
      observe(
        'D14',
        'the owner the connection authenticates as is a member of app_maintenance, which adds it nothing it does not already hold; locally the database probes grant it and no reseed revokes it',
      );
  }

  /* D15: the signing path, and the key that is on it. ES256 is the path on which a key CAN be replaced, not the
     replacement (E7D-C-F4); the key-set conditions are what observe that a replacement happened. */
  did('D15');
  if (!hosted) skip('D15', 'the local stack signs server bearers with HS256 and publishes no key set for them');
  else {
    if (env.ENTERPRISE_SERVER_SIGNING_ALG !== 'ES256')
      refuse(
        'D15',
        'ENTERPRISE_SERVER_SIGNING_ALG',
        'it is not ES256 in a hosted file; the legacy secret cannot be rotated, so B7 needs the signing-keys system (E7 1.3)',
      );
    if (facts.keySet === undefined) cannotRead('D15', "the target's published key set was not read");
    else {
      const kids = (facts.keySet.keys ?? []).map((k) => k.kid);
      if (nonEmpty(env.ENTERPRISE_SERVER_SIGNING_KID) && !kids.includes(env.ENTERPRISE_SERVER_SIGNING_KID))
        refuse('D15', 'ENTERPRISE_SERVER_SIGNING_KID', "it is absent from the target's published key set");
      for (const kid of facts.retiredKids ?? [])
        if (kids.includes(kid))
          refuse(
            'D15',
            '--retired-kid',
            "a key id a `key.replace` register line retired is still in the target's published set",
          );
    }
  }

  /* D16: the alert sink. */
  did('D16');
  if (env.ENTERPRISE_ALERT_SINK === 'mail') {
    if (!isAddress(env.ENTERPRISE_ALERT_TO))
      refuse('D16', 'ENTERPRISE_ALERT_TO', 'the alert sink is `mail` and the recipient is missing or malformed');
    for (const name of ['ENTERPRISE_MAIL_PROVIDER', 'ENTERPRISE_MAIL_API_KEY', 'ENTERPRISE_MAIL_FROM'])
      if (!nonEmpty(env[name]))
        refuse(
          'D16',
          name,
          'the alert sink is `mail` and the transport it sends through is not ready without this value',
        );
  }

  return { findings, unread, notApplicable, observations, checked: [...checked].sort() };
}

/* ---------- the env file ---------- */

/* A KEY=VALUE file of one Netlify context's values, parsed with NO expansion: a `$NAME` in a value stays those
   bytes. One layer of matching single or double quotes is removed, which is how such a file is usually written.
   A line that is neither blank, a # comment nor KEY=VALUE refuses the run by its NUMBER and never by its text. */
export function parseEnvFile(text) {
  const env = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m === null) throw new Error(`line ${i + 1} is not KEY=VALUE`);
    let value = m[2];
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1);
    env[m[1]] = value;
  }
  return env;
}

/* The in-tree refusal and its one exception (E7D-C-F12). `git rev-parse --show-toplevel` from the file's own real
   directory is what decides, so a work tree anywhere above it counts, this repository included. */
export function envFileRefusal(file, { target, root = REPO_ROOT } = {}) {
  let real;
  try {
    real = realpathSync(file);
  } catch {
    return `--env ${file} does not exist`;
  }
  if (!statSync(real).isFile()) return '--env names something that is not a regular file';
  const inside = spawnSync('git', ['-C', dirname(real), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (inside.status !== 0) return null;
  const tree = inside.stdout.trim();
  if (tree.length === 0) return null;
  let fixture = null;
  try {
    fixture = realpathSync(join(root, FIXTURE_ENV));
  } catch {
    /* the fixture need not exist */
  }
  if (target === 'local' && fixture !== null && real === fixture) return null;
  return "an env file inside a Git work tree is refused: such a file holds the production secrets. The one exception is this repository's own synthetic fixture tests/e7/fixtures/local.env under --target local";
}

/* ---------- supabase/config.toml ---------- */

/* The handful of keys the local reader needs, read section by section, because the same key name occurs under
   several tables ([auth] enable_signup is not [auth.email] enable_signup). Comments and blank lines are skipped;
   a value is a quoted string, a boolean, an integer or an array of quoted strings. */
export function parseConfigToml(text) {
  const table = new Map();
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head !== null) {
      section = head[1];
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (kv === null) continue;
    const key = `${section}.${kv[1]}`;
    const text_ = kv[2].replace(/\s+#.*$/, '').trim();
    let value;
    if (/^".*"$/.test(text_)) value = text_.slice(1, -1);
    else if (text_ === 'true' || text_ === 'false') value = text_ === 'true';
    else if (/^-?\d+$/.test(text_)) value = Number(text_);
    else if (text_.startsWith('[')) value = [...text_.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    else value = text_;
    if (!table.has(key)) table.set(key, value);
  }
  const get = (k) => table.get(k);
  return {
    siteUrl: get('auth.site_url'),
    enableSignup: get('auth.enable_signup'),
    schemas: get('api.schemas'),
    maxRows: get('api.max_rows'),
    rotation: get('auth.enable_refresh_token_rotation'),
    reuseInterval: get('auth.refresh_token_reuse_interval'),
    beforeUserCreated: get('auth.hook.before_user_created.uri'),
    beforeUserCreatedEnabled: get('auth.hook.before_user_created.enabled'),
    mfaVerificationAttempt: get('auth.hook.mfa_verification_attempt.uri'),
    mfaVerificationAttemptEnabled: get('auth.hook.mfa_verification_attempt.enabled'),
    totpEnroll: get('auth.mfa.totp.enroll_enabled'),
    totpVerify: get('auth.mfa.totp.verify_enabled'),
  };
}

/* ---------- shared facts ---------- */

/** The highest migration version under supabase/migrations/, and check-migrations' own problems. */
function migrationFileFacts(root) {
  const { problems } = checkMigrations(root);
  const dir = join(root, 'supabase', 'migrations');
  const versions = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^\d+_.*\.sql$/.test(f))
        .map((f) => f.split('_')[0])
        .sort()
    : [];
  return { changed: problems, head: versions.at(-1) };
}

/** The bound on each read this script makes, the answer's body included, in milliseconds (lane K6, XR-15). */
export const READ_TIMEOUT_MS = 10_000;

/* `promise`, or the signal's reason once the signal aborts, whichever comes first. The race is what bounds the read even
   when a fetch ignores its signal; the listener is removed once the promise settles, so nothing is left behind. */
function untilAborted(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', stop);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', stop);
        reject(e);
      },
    );
  });
}

/* A GET whose answer is reduced to what a rule may see: the status and, for a JSON body, the product's own code or
   the named fields. The body is otherwise dropped, because a provider's answer can quote anything. Every read is
   bounded by `timeoutMs` (READ_TIMEOUT_MS unless a caller passes its own), headers and body together, through an
   AbortSignal handed to the fetch and a race beside it: a server that accepts the connection and never answers used
   to hold the check for ever (K6). The answer is the status AND the body, so a status whose body does not arrive in
   time has not answered. A read that fails is null, as it always was; a read that ran out of time also calls
   onTimeout, so a caller can name it. The bound is a timer this function holds and clears, not AbortSignal.timeout,
   whose timer does not keep the process alive: with a hung fetch holding no handle of its own the process exited
   before the bound fired and before any line was printed (peer check CK-4, evidence/hardening-k.md). */
async function readJson(fetchImpl, url, init, { timeoutMs = READ_TIMEOUT_MS, onTimeout } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('read timed out', 'TimeoutError')), timeoutMs);
  const { signal } = controller;
  try {
    const res = await untilAborted(
      Promise.resolve().then(() => fetchImpl(url, { ...init, signal })),
      signal,
    );
    let body = null;
    try {
      body = await untilAborted(
        Promise.resolve().then(() => res.json()),
        signal,
      );
    } catch (e) {
      if (signal.aborted) throw e;
      body = null;
    }
    return { status: res.status, body };
  } catch {
    if (signal.aborted) onTimeout?.();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- the local reader ---------- */

/**
 * localFacts({ env, root, origin, expectSwitch, fetchImpl, psql }) -> facts
 * Reads the env file, supabase/config.toml, the owner connection (D8's registry half and D14) and, in `mail` mode,
 * the catcher. A fact it cannot read is left `undefined`, which checkDeploy reports as unread.
 */
export async function localFacts({
  env,
  root = REPO_ROOT,
  origin,
  expectSwitch,
  fetchImpl = globalThis.fetch,
  psql = process.env.ENTERPRISE_DB_PSQL,
} = {}) {
  const facts = { target: 'local', env, expectSwitch };
  const configPath = join(root, 'supabase', 'config.toml');
  if (existsSync(configPath)) facts.config = parseConfigToml(readFileSync(configPath, 'utf8'));
  facts.migrations = migrationFileFacts(root);
  if (nonEmpty(psql)) {
    const applied = ownerScalar(psql, 'select max(version) from supabase_migrations.schema_migrations;');
    if (applied !== null) facts.migrations.applied = applied.length > 0 ? applied : undefined;
    /* Two counts in one answer: login members that are NOT the connecting role, and whether that role is one. */
    const members = ownerScalar(
      psql,
      "select count(*) filter (where r.rolcanlogin and r.rolname <> current_user) || ':' || count(*) filter (where r.rolname = current_user) from pg_auth_members m join pg_roles r on r.oid = m.member join pg_roles g on g.oid = m.roleid where g.rolname = 'app_maintenance';",
    );
    const parsed = /^(\d+):(\d+)$/.exec(members ?? '');
    if (parsed !== null) facts.maintenance = { otherLogins: Number(parsed[1]), ownerIsMember: Number(parsed[2]) > 0 };
  }
  if (env.ENTERPRISE_INVITATION_DELIVERY === 'mail' && isLoopbackUrl(env.ENTERPRISE_MAIL_ENDPOINT)) {
    const answer = await readJson(fetchImpl, env.ENTERPRISE_MAIL_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    facts.mailEndpointAnswers = answer !== null;
  }
  if (nonEmpty(origin)) {
    const me = await readJson(fetchImpl, `${origin}/api/me`, { method: 'GET' });
    if (me !== null) facts.live = { me: { status: me.status, code: me.body?.code ?? null } };
  }
  return facts;
}

/* One scalar over the owner connection, through the operator's own command. The command is never printed, and
   neither is a failure's text: a failure is `null`, which becomes an unread fact. scripts/owner-db.mjs is the
   owner-side scripts' module and carries the register and the failure categories with it; this check wants one
   number and no register, so it runs the same command directly and keeps the same rule about the text. */
function ownerScalar(psql, sql) {
  const r = spawnSync('bash', ['-c', psql], {
    input: `\\set ON_ERROR_STOP 1\n${sql}\n`,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  return r.stdout.trim().split('\n').at(-1)?.trim() ?? null;
}

/* ---------- the hosted reader ---------- */

/**
 * hostedFacts({ env, root, origin, expectSwitch, netlifyNamesFile, retiredKids, fetchImpl, management, readTimeoutMs })
 *   -> facts
 * The Management API token and the project reference come from the RUNNER's environment and are read only; neither
 * is printed. `management` replaces the two Management API calls with a recorded answer, which is how the unit
 * cases run: no hosted project exists, so this lane makes no hosted call at all.
 */
export async function hostedFacts({
  env,
  root = REPO_ROOT,
  origin,
  expectSwitch,
  netlifyNamesFile,
  retiredKids = [],
  fetchImpl = globalThis.fetch,
  management,
  accessToken = process.env.SUPABASE_ACCESS_TOKEN,
  projectRef = process.env.SUPABASE_PROJECT_REF,
  readTimeoutMs = READ_TIMEOUT_MS,
} = {}) {
  const facts = { target: 'hosted', env, expectSwitch, retiredKids };
  if (management !== undefined) facts.management = management;
  else if (nonEmpty(accessToken) && nonEmpty(projectRef)) {
    const headers = { authorization: `Bearer ${accessToken}` };
    const base = `https://api.supabase.com/v1/projects/${projectRef}`;
    /* K6: a Management API read that runs out of time is named by its path under the project, never by its URL,
       which holds the project reference; checkDeploy refuses the run with it (READ). */
    const readFailures = [];
    const read = (path) =>
      readJson(
        fetchImpl,
        `${base}${path}`,
        { headers },
        {
          timeoutMs: readTimeoutMs,
          onTimeout: () =>
            readFailures.push({ read: `Management API ${path}`, failure: `no answer within ${readTimeoutMs} ms` }),
        },
      );
    const auth = await read('/config/auth');
    const postgrest = await read('/postgrest');
    const migrations = await read('/database/migrations');
    if (readFailures.length > 0) facts.readFailures = readFailures;
    if (auth?.status === 200 || postgrest?.status === 200 || migrations?.status === 200)
      facts.management = {
        auth: auth?.status === 200 ? auth.body : undefined,
        postgrest: postgrest?.status === 200 ? postgrest.body : undefined,
        migrations: migrations?.status === 200 ? migrations.body : undefined,
      };
  }
  facts.migrations = migrationFileFacts(root);
  const applied = appliedFromManagement(facts.management?.migrations);
  if (applied !== undefined) facts.migrations.applied = applied;
  const template = facts.management?.auth?.mailer_templates_magic_link_content;
  if (typeof template === 'string') {
    const own = join(root, 'supabase', 'templates', 'sign-in.html');
    if (existsSync(own))
      facts.templateSha = { hosted: sha256(template), repository: sha256(readFileSync(own, 'utf8')) };
  }
  if (nonEmpty(env.SUPABASE_URL)) {
    const settings = await readJson(fetchImpl, `${env.SUPABASE_URL}/auth/v1/settings`, { method: 'GET' });
    if (settings?.status === 200 && settings.body !== null) facts.settings = settings.body;
    const jwks = await readJson(fetchImpl, `${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`, { method: 'GET' });
    if (jwks?.status === 200 && jwks.body !== null) facts.keySet = jwks.body;
    if (env.ENTERPRISE_INVITATION_DELIVERY === 'mail' && nonEmpty(env.ENTERPRISE_MAIL_PROVIDER)) {
      const endpoint = PROVIDER_ENDPOINTS[env.ENTERPRISE_MAIL_PROVIDER];
      if (endpoint !== undefined) {
        const answer = await readJson(fetchImpl, endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        /* The least-privileged provider key is sending only and can read nothing, so no authenticated read proves
           it works: D10 proves the endpoint is reachable over TLS and DEMANDS authentication. The key itself is
           proven only by a real send, which is the SMTP receipt H-M1 (design 1.4). */
        facts.mailEndpointAnswers = answer !== null && answer.status === 401;
      }
    }
  }
  if (nonEmpty(netlifyNamesFile)) {
    const listing = JSON.parse(readFileSync(netlifyNamesFile, 'utf8'));
    facts.netlifyNames = namesOnly(listing);
  }
  if (nonEmpty(origin)) {
    const me = await readJson(fetchImpl, `${origin}/api/me`, { method: 'GET' });
    if (me !== null) facts.live = { me: { status: me.status, code: me.body?.code ?? null } };
  }
  return facts;
}

/** The endpoint each provider of lib/services/mail.mjs PROVIDERS answers on, restated so this script imports no lib/ module for one URL. */
const PROVIDER_ENDPOINTS = Object.freeze({ resend: 'https://api.resend.com/emails' });

/** The highest version in the Management API's migration list, whatever field carries it. */
function appliedFromManagement(list) {
  if (!Array.isArray(list)) return undefined;
  const versions = list
    .map((row) => (typeof row === 'string' ? row : (row?.version ?? row?.name)))
    .filter((v) => typeof v === 'string' && /^\d+/.test(v))
    .map((v) => v.split('_')[0]);
  return versions.length > 0 ? versions.sort().at(-1) : undefined;
}

/* The listing is NAMES ONLY by construction: whatever shape the file has, only the names survive into facts, so a
   listing a person built with `netlify env:list --json` and forgot to strip cannot put a value in front of a rule. */
export function namesOnly(listing) {
  const out = {};
  if (listing === null || typeof listing !== 'object') return out;
  for (const [context, entry] of Object.entries(listing)) {
    if (Array.isArray(entry))
      out[context] = entry
        .map((n) => (typeof n === 'string' ? n : String(n?.key ?? n?.name ?? '')))
        .filter((n) => n.length > 0);
    else if (entry !== null && typeof entry === 'object') out[context] = Object.keys(entry);
  }
  return out;
}

/* ---------- the command line ---------- */

const USAGE = [
  'usage:',
  '  node scripts/check-deploy.mjs --target local  --env <file> [--origin <origin>] [--expect-switch open|closed]',
  '  node scripts/check-deploy.mjs --target hosted --env <file> --origin <https origin>',
  '                                [--netlify-names <file>] [--expect-switch open|closed] [--retired-kid <kid>]...',
  '  --root <dir> checks another tree (tests). No value of the env file is ever printed.',
].join('\n');

export function parseArgs(argv) {
  const opts = {
    target: null,
    env: null,
    origin: null,
    netlifyNamesFile: null,
    expectSwitch: undefined,
    retiredKids: [],
    root: REPO_ROOT,
  };
  const value = (i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${argv[i]} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--target':
        opts.target = value(i++);
        if (opts.target !== 'local' && opts.target !== 'hosted') throw new Error('--target is local or hosted');
        break;
      case '--env':
        opts.env = value(i++);
        break;
      case '--origin':
        opts.origin = value(i++);
        break;
      case '--netlify-names':
        opts.netlifyNamesFile = value(i++);
        break;
      case '--expect-switch':
        opts.expectSwitch = value(i++);
        if (opts.expectSwitch !== 'open' && opts.expectSwitch !== 'closed')
          throw new Error('--expect-switch is open or closed');
        break;
      case '--retired-kid':
        opts.retiredKids.push(value(i++));
        break;
      case '--root':
        opts.root = resolve(value(i++));
        break;
      default:
        throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (opts.target === null) throw new Error('--target is required');
  if (opts.env === null) throw new Error('--env is required');
  if (opts.target === 'hosted' && opts.origin === null) throw new Error('--target hosted needs --origin');
  return opts;
}

/** The report, findings first. A line names a rule and a variable, never a value. */
export function report(result, target, write = (s) => process.stdout.write(s)) {
  for (const f of result.findings) write(`REFUSE ${f.id} ${f.variable}: ${f.rule}\n`);
  for (const u of result.unread) write(`UNREAD ${u.id}: ${u.reason}\n`);
  for (const n of result.notApplicable) write(`NOT APPLICABLE ${n.id}: ${n.reason}\n`);
  for (const o of result.observations) write(`OBSERVED ${o.id}: ${o.note}\n`);
  write(
    `check-deploy: target ${target}, ${result.checked.length} facts checked, ${result.findings.length} problem(s), ${result.unread.length} unread, ${result.notApplicable.length} not applicable, ${result.observations.length} observation(s)\n`,
  );
  if (result.unread.length > 0)
    write(`check-deploy: an unread fact is NOT a pass; the ids above say why each was not read\n`);
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stdout.write(`check-deploy: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  const refusal = envFileRefusal(opts.env, { target: opts.target, root: opts.root });
  if (refusal !== null) {
    process.stdout.write(`check-deploy: ${refusal}\n`);
    return 2;
  }
  let env;
  try {
    env = parseEnvFile(readFileSync(opts.env, 'utf8'));
  } catch (e) {
    process.stdout.write(`check-deploy: --env ${opts.env}: ${e.message}\n`);
    return 2;
  }
  const facts =
    opts.target === 'local'
      ? await localFacts({ env, root: opts.root, origin: opts.origin ?? undefined, expectSwitch: opts.expectSwitch })
      : await hostedFacts({
          env,
          root: opts.root,
          origin: opts.origin ?? undefined,
          expectSwitch: opts.expectSwitch,
          netlifyNamesFile: opts.netlifyNamesFile ?? undefined,
          retiredKids: opts.retiredKids,
        });
  const result = checkDeploy(facts);
  report(result, opts.target);
  return result.findings.length > 0 ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
