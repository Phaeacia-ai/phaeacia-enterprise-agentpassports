#!/usr/bin/env node
/* The production smoke sequence (E7 design 1.4, S1 to S9).
 *
 *   node scripts/smoke.mjs --origin <origin> --supabase <url> [--expect-switch open|closed]
 *
 * READ ONLY, no account, no write, nine requests. It is the plan's "deployed smoke checks use tightly scoped
 * synthetic identities and non-destructive operations" for the part a machine can do alone: run after every deploy
 * (H-S1) and at the first hosted acceptance. The authenticated half of a smoke, a synthetic member signing in and
 * reading their company, needs a mailbox and is part of the first hosted acceptance (H-M1, H-A5), not of this run.
 * NO HEALTH ENDPOINT IS ADDED for it: S4 already proves the functions run, the switch and the pipeline's order, and
 * a new unauthenticated route would be new surface reporting nothing S4 does not (design 1.4).
 *
 * S5 is the one request with a method other than GET. It is a POST to a company id of all zeros with a foreign
 * Origin, which the pipeline refuses at step 3, BEFORE it reads a session and before it reads a body, so nothing is
 * written and nothing needs to exist: that refusal, and the fact that it comes before the session, is the assertion.
 *
 * The same family shape as scripts/check-migrations.mjs, check-web.mjs and check-deploy.mjs: a PURE function,
 * checkSmoke(answers), returning findings, exit 0 clean and 2 on findings. There is no --root, because this script
 * reads no file in the tree: the four page headers S1 expects are written out below, and what serves them is
 * netlify.toml, hosted through Netlify and locally through tests/browser/dev-shell.mjs, which parses the same file.
 * That is what makes E7-19's second fail-before possible at all: a scratch netlify.toml without the
 * Content-Security-Policy line, fed to the shell, and S1 fails.
 *
 * THE PUBLISHABLE KEY. S7 and S8 need one, and it comes from SUPABASE_ANON_KEY in the runner's environment, never
 * from an argument, because an argument lands in a shell history. It is publishable and still not printed: this
 * script prints a status, a header name and a rule, never a value, a body or a header's contents.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The four headers every page answer carries (netlify.toml `for = "/*"`), by name and by the rule on the value. */
export const PAGE_HEADERS = Object.freeze([
  [
    'content-security-policy',
    (v) => typeof v === 'string' && v.includes("default-src 'none'") && v.includes("script-src 'self'"),
  ],
  ['x-content-type-options', (v) => v === 'nosniff'],
  ['x-frame-options', (v) => v === 'DENY'],
  ['referrer-policy', (v) => v === 'no-referrer'],
]);

/** The nine requests, in order. `send` is what the reader calls; nothing here decides an expectation. */
export function sequence({ origin, supabase, anonKey }) {
  const json = { accept: 'application/json' };
  return [
    { id: 'S1', what: 'GET /', url: `${origin}/`, init: { method: 'GET' } },
    { id: 'S2', what: 'GET /assets/app/shell.mjs', url: `${origin}/assets/app/shell.mjs`, init: { method: 'GET' } },
    { id: 'S3', what: 'GET /accept', url: `${origin}/accept`, init: { method: 'GET', redirect: 'manual' } },
    { id: 'S3b', what: 'GET /accept/', url: `${origin}/accept/`, init: { method: 'GET', redirect: 'manual' } },
    { id: 'S4', what: 'GET /api/me with no cookie', url: `${origin}/api/me`, init: { method: 'GET', headers: json } },
    {
      id: 'S5',
      what: 'POST an invitation with a foreign Origin',
      url: `${origin}/api/companies/00000000-0000-0000-0000-000000000000/invitations`,
      init: {
        method: 'POST',
        headers: { ...json, 'content-type': 'application/json', origin: 'https://example.invalid' },
        body: '{}',
      },
    },
    {
      id: 'S6',
      what: 'GET a members list with a malformed company id and no cookie',
      url: `${origin}/api/companies/not-a-uuid/members`,
      init: { method: 'GET', headers: json },
    },
    {
      id: 'S7',
      what: 'GET the api schema through the Data API with the publishable key',
      url: `${supabase}/rest/v1/my_standing`,
      init: { method: 'GET', headers: { apikey: anonKey, authorization: `Bearer ${anonKey}`, ...json } },
    },
    {
      id: 'S8',
      what: 'GET an app table through the Data API with the publishable key',
      url: `${supabase}/rest/v1/companies`,
      init: { method: 'GET', headers: { apikey: anonKey, authorization: `Bearer ${anonKey}`, ...json } },
    },
    { id: 'S9', what: 'GET the public Auth settings', url: `${supabase}/auth/v1/settings`, init: { method: 'GET' } },
  ];
}

/**
 * checkSmoke(answers, { expectSwitch }) -> { findings, checked }
 * answers: { S1: { status, headers, body, text, redirected }, ... }. An answer that is null is a request that could
 * not be made at all, which is a finding and never a pass.
 */
export function checkSmoke(answers, { expectSwitch = 'open' } = {}) {
  const findings = [];
  const checked = [];
  const refuse = (id, rule) => findings.push({ id, rule });
  const take = (id) => {
    checked.push(id);
    const a = answers[id];
    if (a === null || a === undefined) {
      refuse(id, 'the request could not be made at all');
      return null;
    }
    return a;
  };
  const header = (a, name) => a.headers?.[name] ?? null;
  const code = (a) => (a.body !== null && typeof a.body === 'object' ? a.body.code : null);

  const s1 = take('S1');
  if (s1 !== null) {
    if (s1.status !== 200) refuse('S1', `the home page answered ${s1.status}, not 200`);
    if (!String(header(s1, 'content-type') ?? '').includes('text/html'))
      refuse('S1', 'the home page is not served as text/html');
    for (const [name, ok] of PAGE_HEADERS)
      if (!ok(header(s1, name))) refuse('S1', `the page header ${name} is absent or not the value netlify.toml sets`);
  }

  const s2 = take('S2');
  if (s2 !== null) {
    if (s2.status !== 200) refuse('S2', `the shell module answered ${s2.status}, not 200`);
    const type = String(header(s2, 'content-type') ?? '');
    if (!(type.includes('javascript') || type.includes('ecmascript')))
      refuse('S2', 'the .mjs module is not served with a JavaScript content type, so a browser will refuse it');
    if (header(s2, 'x-content-type-options') !== 'nosniff') refuse('S2', 'the module is served without nosniff');
  }

  for (const id of ['S3', 'S3b']) {
    const s3 = take(id);
    if (s3 === null) continue;
    if (s3.status !== 200)
      refuse(
        id,
        `the accept page answered ${s3.status}, not 200; a redirect here drops the fragment that carries the invitation`,
      );
    if (!String(header(s3, 'content-type') ?? '').includes('text/html'))
      refuse(id, 'the accept page is not served as text/html');
  }

  const s4 = take('S4');
  if (s4 !== null) {
    const want =
      expectSwitch === 'closed' ? { status: 503, code: 'E_MAINTENANCE' } : { status: 401, code: 'E_UNAUTHENTICATED' };
    if (s4.status !== want.status || code(s4) !== want.code)
      refuse(
        'S4',
        `an uncookied /api/me answered ${s4.status} ${code(s4) ?? 'with no code'}; the switch is meant ${expectSwitch}, which is ${want.status} ${want.code}`,
      );
    if (header(s4, 'cache-control') !== 'private, no-store')
      refuse('S4', 'the function answer carries no `Cache-Control: private, no-store`');
  }

  const s5 = take('S5');
  if (s5 !== null && expectSwitch !== 'closed') {
    if (s5.status !== 403 || code(s5) !== 'E_CROSS_SITE')
      refuse(
        'S5',
        `a foreign Origin on a mutation answered ${s5.status} ${code(s5) ?? 'with no code'}, not 403 E_CROSS_SITE before the session is read (pipeline step 3)`,
      );
  }

  const s6 = take('S6');
  if (s6 !== null && expectSwitch !== 'closed') {
    if (s6.status !== 401 || code(s6) !== 'E_UNAUTHENTICATED')
      refuse(
        'S6',
        `a malformed company id with no cookie answered ${s6.status} ${code(s6) ?? 'with no code'}, not 401: the session is step 4 and the id step 5`,
      );
  }

  const s7 = take('S7');
  if (s7 !== null && s7.status < 400)
    refuse(
      'S7',
      `the publishable key read the api schema and answered ${s7.status}; E2 1.1: anon holds no usage on api`,
    );

  const s8 = take('S8');
  if (s8 !== null && s8.status < 400)
    refuse('S8', `the publishable key reached an app table and answered ${s8.status}; app is not an exposed schema`);

  const s9 = take('S9');
  if (s9 !== null) {
    if (s9.status !== 200) refuse('S9', `the public Auth settings answered ${s9.status}, not 200`);
    else {
      const body = s9.body ?? {};
      if (body.disable_signup !== true) refuse('S9', 'public sign-up is not disabled at /auth/v1/settings');
      const external = body.external ?? {};
      const enabled = Object.entries(external).filter(([name, on]) => on === true && name !== 'email');
      if (enabled.length > 0) refuse('S9', `${enabled.length} external provider(s) are enabled and none should be`);
    }
  }

  return { findings, checked };
}

/* ---------- the reader ---------- */

/** One request's answer, reduced to a status, the headers a rule reads and, for JSON, the parsed body. */
async function ask(fetchImpl, { url, init }) {
  try {
    const res = await fetchImpl(url, init);
    const headers = {};
    for (const name of [
      'content-type',
      'cache-control',
      'content-security-policy',
      'x-content-type-options',
      'x-frame-options',
      'referrer-policy',
    ])
      headers[name] = res.headers.get(name);
    let body = null;
    if (String(headers['content-type'] ?? '').includes('application/json')) {
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    } else if (res.body !== null && res.body !== undefined) {
      try {
        await res.body.cancel();
      } catch {
        /* nothing of the answer is kept */
      }
    }
    return { status: res.status, headers, body };
  } catch {
    return null;
  }
}

/** Every answer of the sequence, in order. Nothing is written and nothing is retried. */
export async function readAnswers({ origin, supabase, anonKey, fetchImpl = globalThis.fetch }) {
  const answers = {};
  for (const step of sequence({ origin, supabase, anonKey })) answers[step.id] = await ask(fetchImpl, step);
  return answers;
}

const USAGE = [
  'usage: node scripts/smoke.mjs --origin <origin> --supabase <url> [--expect-switch open|closed]',
  '  read only, nine requests, no account and no write. SUPABASE_ANON_KEY must be in the environment for S7 and S8.',
  "  No status line prints a value, a body or a header's contents.",
].join('\n');

export function parseArgs(argv) {
  const opts = { origin: null, supabase: null, expectSwitch: 'open' };
  const value = (i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${argv[i]} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--origin':
        opts.origin = value(i++);
        break;
      case '--supabase':
        opts.supabase = value(i++);
        break;
      case '--expect-switch':
        opts.expectSwitch = value(i++);
        if (opts.expectSwitch !== 'open' && opts.expectSwitch !== 'closed')
          throw new Error('--expect-switch is open or closed');
        break;
      default:
        throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  for (const [name, v] of [
    ['--origin', opts.origin],
    ['--supabase', opts.supabase],
  ]) {
    if (v === null) throw new Error(`${name} is required`);
    let url;
    try {
      url = new URL(v);
    } catch {
      throw new Error(`${name} is not an absolute URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} is not an http or https URL`);
    if (v !== `${url.protocol}//${url.host}`)
      throw new Error(`${name} carries a path, a query, a fragment or a trailing slash`);
  }
  return opts;
}

export function report(result, write = (s) => process.stdout.write(s)) {
  for (const f of result.findings) write(`REFUSE ${f.id}: ${f.rule}\n`);
  write(`smoke: ${result.checked.length} requests, ${result.findings.length} problem(s)\n`);
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stdout.write(`smoke: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (typeof anonKey !== 'string' || anonKey.length === 0) {
    process.stdout.write('smoke: SUPABASE_ANON_KEY is not in the environment, and S7 and S8 need it\n');
    return 2;
  }
  const answers = await readAnswers({ origin: opts.origin, supabase: opts.supabase, anonKey });
  const result = checkSmoke(answers, { expectSwitch: opts.expectSwitch });
  report(result);
  return result.findings.length > 0 ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
