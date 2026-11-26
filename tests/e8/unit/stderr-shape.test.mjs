/* E8-6's stack-free half (docs/e8/design.md 2.3 row E8-6 and 2.4; evidence/e8-surface.md): every line a function
   writes to stderr, read two ways, and neither may carry a tenant string, an address, a token, or PostgREST's
   `details`, `hint` or `message`.

   THE STATIC HALF. Every log site in lib/http/ and lib/services/ is found in the source, and each field it writes is
   checked against the allowlist lib/http/alerts.mjs ALERT_FIELDS names, which is what shapeFields() admits. The
   only ways out to stderr in those two trees are `process.stderr.write(` and `console.`; the first is found in five
   places, four of them SINKS that write the entry a caller hands them (`${JSON.stringify(entry)}\n`, so the entry is
   the site) and one a SITE of its own (the adapter's `internal` line); `console.` is found nowhere. The sites are the
   calls into those sinks, and the set of them is pinned as a literal (the shape of tests/e2/stack/pages-bound.test.mjs
   S11h), so a log line added tomorrow fails here until somebody classifies it. A field passes when it is `event`
   with a string literal, a spread of `shapeFields(...)` (or of a variable the same file assigns from it), or a key
   ALERT_FIELDS names. THREE SITES WRITE FIELDS THE ALLOWLIST DOES NOT NAME, and each is declared below with the
   value expression it writes, pinned, and the rule that closes it: GoTrue's refusal (a status number and a key of
   lib/auth/factors.mjs GOTRUE_ERROR_CODES or the word `unknown`, E7M-C-F5), the installer divergence (a fixed word,
   a target the database constrains, and two SHA-256 values of Phaeacia's own installer texts), and the alert
   record's own `v`, `at` and `count` (E7-20 pins the record's key set exactly). That is finding E8S-F2: three sites
   are closed by rules of their own and not by shapeFields, which is a second policy for log lines; the pin here is
   what stops a fourth field from joining one of them silently.

   THE PURE HALF, against fakes, through the real pipeline and the real adapter. For EVERY code in lib/errors.mjs
   CODES, a route whose handler throws that AppError, called with the hostile strings of tests/e8/fixtures/
   hostile-strings.mjs in the body, the query and the headers, with and without a session; a handler throwing loaded
   errors of five shapes (the `internal` line); the session verifier's four refusals, one of them through a JWKS fetch
   that fails with the strings in its error (`session_refused`, `session_unavailable`); GoTrue answering a factor call
   with the strings in its error body (`gotrue_refused`); and the adapter's own catch, read from process.stderr
   itself. Every line and every alert record the capture receives must be free of every string and every marker,
   must name only allowlisted fields (or a declared site's own), and must equal its own shaped form, so a value that
   passes only because shapeFields would have turned it into `invalid` still fails.

   FAIL-BEFORE (design 2.3 row E8-6): the pipeline's `internal` line as it stood at 0ba9465, re-created in a copy of
   lib/ by tests/e8/helpers/mutant-lib.mjs. The design row says that line "carried the error's message"; at 0ba9465
   it carried the thrown value's `name` and `code` raw (`git show 0ba9465:lib/http/pipeline.mjs`, line 162), which is
   what the mutant re-creates. Both halves fail on it: the static scan names the field, and the pure half finds the
   strings. With ENTERPRISE_E8_MUTANT_UNCAUGHT=1 the two cases fail for real, which is how
   evidence/e8-surface-repro/e8-6-unit-fail-before.log was made. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { hs256, userClaims } from '../../e2/helpers/jwt.mjs';
import { HOSTILE, hostileIn, STRINGS } from '../fixtures/hostile-strings.mjs';
import { caught, caughtAsync, mutantRoutes, removeMutants } from '../helpers/mutant-lib.mjs';

const SECRET = 'example-unit-secret-with-at-least-32-characters-long';
const BASE = 'http://127.0.0.1:54321';
const ORIGIN = 'https://enterprise.example.invalid';
process.env.SUPABASE_URL = BASE;
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = SECRET;
process.env.ENTERPRISE_ACCESS_STATE = 'open';
process.env.ENTERPRISE_ORIGIN = ORIGIN;
delete process.env.ENTERPRISE_ALERT_SINK;

const REPO = join(import.meta.dirname, '..', '..', '..');
const { ALERT_FIELDS, resetAlertWindow, shapeFields, workAfter } = await import('../../../lib/http/alerts.mjs');
const { route } = await import('../../../lib/http/pipeline.mjs');
const { toNetlify } = await import('../../../lib/http/netlify.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { AppError, CODES } = await import('../../../lib/errors.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { COOKIES } = await import('../../../lib/session.mjs');
const { GOTRUE_ERROR_CODES } = await import('../../../lib/auth/factors.mjs');

after(() => removeMutants());

/* ---------------------------------------------------------------------------------------------------
   The static half
   --------------------------------------------------------------------------------------------------- */

const SCOPE = ['lib/http', 'lib/services'];

function sources(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      /* The pinned site list names paths with '/', so a Windows run compares the same text (the static half failed
         there on the separator alone, which hid a real failure behind it; evidence/xr-residuals.md, XRR2-1). */
      else if (entry.name.endsWith('.mjs'))
        out.push({ rel: relative(root, path).split(sep).join('/'), text: readFileSync(path, 'utf8') });
    }
  };
  for (const dir of SCOPE) walk(join(root, dir));
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/* The text with every comment replaced by spaces of the same length, so indices still line up. Strings and
   template literals are skipped rather than parsed; a regular-expression literal holding a quote would confuse this,
   and the pinned site list below is what would then fail, loudly, rather than a site going unseen. */
function blankComments(text) {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1;
      i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (let k = i; k < stop; k += 1) if (out[k] !== '\n') out[k] = ' ';
      i = stop;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') out[i++] = ' ';
    } else i += 1;
  }
  return out.join('');
}

/* The balanced `{ ... }` starting at `open`, and its top-level entries split at depth-0 commas. */
function objectAt(text, open) {
  assert.equal(text[open], '{', `an object literal at ${open}`);
  let depth = 0;
  let i = open;
  const cuts = [];
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1;
    } else if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') {
      depth -= 1;
      if (depth === 0) break;
    } else if (c === ',' && depth === 1) cuts.push(i);
  }
  const body = text.slice(open + 1, i);
  const entries = [];
  let from = 0;
  for (const cut of cuts.map((k) => k - open - 1)) {
    entries.push(body.slice(from, cut));
    from = cut + 1;
  }
  entries.push(body.slice(from));
  return entries.map((e) => e.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/* One entry, classified. */
function field(entry, text) {
  let m = /^event: '([a-z_]+)'$/.exec(entry);
  if (m) return { kind: 'event', event: m[1] };
  if (/^\.\.\.shapeFields\(/.test(entry)) return { kind: 'shaped' };
  m = /^\.\.\.([A-Za-z_]\w*)$/.exec(entry);
  if (m) return new RegExp(`const ${m[1]} = shapeFields\\(`).test(text) ? { kind: 'shaped' } : { kind: 'spread', of: m[1] };
  m = /^([A-Za-z_]\w*): (.+)$/.exec(entry);
  if (m) return { kind: 'key', key: m[1], value: m[2] };
  m = /^([A-Za-z_]\w*)$/.exec(entry);
  if (m) return { kind: 'key', key: m[1], value: m[1] };
  return { kind: 'unreadable', entry };
}

const SINK = '`${JSON.stringify(entry)}\\n`';

/**
 * logSites(root) -> { sites, sinks, consoles }
 * sites: [{ rel, via, event, fields }] for every call into a sink, plus the adapter's own line;
 * sinks: the `process.stderr.write(` calls that write the entry their caller hands them.
 */
function logSites(root) {
  const sites = [];
  const sinks = [];
  const consoles = [];
  for (const { rel, text: raw } of sources(root)) {
    const text = blankComments(raw);
    for (const m of text.matchAll(/console\./g)) consoles.push(`${rel}@${m.index}`);
    for (const m of text.matchAll(/process\.stderr\.write\(/g)) {
      const arg = text.slice(m.index + m[0].length).trimStart();
      if (arg.startsWith(SINK)) sinks.push(rel);
      else {
        const at = text.indexOf('JSON.stringify({', m.index);
        assert.ok(at > m.index && at < m.index + 80, `${rel}: a stderr write that is neither a sink nor a JSON object`);
        sites.push({ rel, via: 'stderr', entries: objectAt(text, at + 'JSON.stringify('.length) });
      }
    }
    for (const m of text.matchAll(/(?<![\w.])log\(\{|\(options\.log \?\? defaultLog\)\(\{/g))
      sites.push({ rel, via: 'log', entries: objectAt(text, m.index + m[0].length - 1) });
    for (const m of text.matchAll(/(?<!function )writeLine\(deps, /g)) {
      const rest = text.slice(m.index + m[0].length);
      if (rest.startsWith('{')) sites.push({ rel, via: 'writeLine', entries: objectAt(text, m.index + m[0].length) });
      else {
        const id = /^([A-Za-z_]\w*)\)/.exec(rest)?.[1];
        const decl = text.indexOf(`const ${id} = {`);
        assert.ok(id && decl > 0, `${rel}: writeLine of something that is neither an object nor a named one`);
        sites.push({ rel, via: `writeLine(${id})`, entries: objectAt(text, decl + `const ${id} = `.length) });
      }
    }
  }
  for (const s of sites) {
    s.fields = s.entries.map((e) => field(e, readFileSync(join(root, s.rel), 'utf8')));
    s.event = s.fields.find((f) => f.kind === 'event')?.event ?? '(variable)';
  }
  return { sites, sinks: sinks.sort(), consoles };
}

const describe = (s) =>
  `${s.rel} ${s.via} ${s.event} [${s.fields.map((f) => (f.kind === 'key' ? f.key : f.kind === 'shaped' ? '...shapeFields' : f.kind === 'event' ? 'event' : `?${f.entry ?? f.of}`)).join(', ')}]`;

/* The pinned set. A new site joins this list with a decision, never silently. */
/* The alerts design's slice 1 (section 7) added the seven lines of the mail event service and the check-in, every one
   of them `event` with a literal and at most ALERT_FIELDS keys (`cause`; `code` and `status`), so no fourth declared
   site: `checkin_recorded` carries `event` only (ALD-R-F12). And one line the design did not list, the check-in's
   scheduled adapter's `internal` line, which is the Netlify adapter's own line for a defect that escapes runCheckin,
   written through shapeFields exactly as that one is (evidence/alerts-slice1.md, ALS-F2). */
const SITES = [
  'lib/http/alerts.mjs writeLine alert_dropped [event]',
  'lib/http/alerts.mjs writeLine(record) (variable) [event, ...shapeFields, v, at, count]',
  'lib/http/checkin.mjs stderr internal [event, ...shapeFields]',
  'lib/http/netlify.mjs stderr internal [event, ...shapeFields]',
  'lib/http/pipeline.mjs log internal [event, ...shapeFields]',
  'lib/http/pipeline.mjs log refused [event, code, status, ...shapeFields]',
  'lib/http/pipeline.mjs log session_refused [event, ...shapeFields]',
  'lib/http/pipeline.mjs log session_unavailable [event]',
  'lib/http/routes.mjs log gotrue_refused [event, code, gotrueStatus, gotrueErrorCode]',
  'lib/http/routes.mjs log mfa_bound_unsettled [event]',
  'lib/http/routes.mjs log signin_limited [event, ...shapeFields]',
  'lib/services/checkin.mjs log checkin_dropped [event, code, status]',
  'lib/services/checkin.mjs log checkin_duplicate [event]',
  'lib/services/checkin.mjs log checkin_recorded [event]',
  'lib/services/checkin.mjs log checkin_sent [event]',
  'lib/services/checkin.mjs log checkin_skipped [event]',
  'lib/services/mail-events.mjs log mail_event_ignored [event]',
  'lib/services/mail-events.mjs log operator_mail_undeliverable [event, cause]',
  'lib/services/releases.mjs log assembly_diverged [event, stage, target, registeredTextSha256, manifestTextSha256]',
];
/* The two services of the alerts design's slice 1 each write through deps.log, and each has a default that writes
   its caller's entry to stderr, as releases.mjs does. Lane K3 added routes.mjs's second, the authStart handler's
   default for its `signin_limited` line, beside factorRefusal's (evidence/hardening-k.md). HB-F2 added a third,
   boundUnsettled's, for the verify route's one content-free line when its bound could not be settled
   (evidence/ena7-end1-hbf2.md). */
const SINKS = [
  'lib/http/alerts.mjs',
  'lib/http/pipeline.mjs',
  'lib/http/routes.mjs',
  'lib/http/routes.mjs',
  'lib/http/routes.mjs',
  'lib/services/checkin.mjs',
  'lib/services/mail-events.mjs',
  'lib/services/releases.mjs',
];

/* The fields three sites write that ALERT_FIELDS does not name, each with the value expression it writes and why the
   value is closed. A change to any value expression fails the pin, because the reason is about that expression. */
const DECLARED = {
  'lib/http/routes.mjs gotrue_refused': {
    gotrueStatus: 'refused.gotrueStatus',
    gotrueErrorCode: 'refused.gotrueErrorCode',
    why: "GoTrue's HTTP status as a number or null, and a key of GOTRUE_ERROR_CODES or the word unknown or null (lib/auth/factors.mjs refused(), E7M-C-F5): never a string GoTrue wrote that the table does not name",
  },
  'lib/services/releases.mjs assembly_diverged': {
    stage: "'installer_text'",
    target: 'envelope.target',
    registeredTextSha256: 'registeredTextSha256',
    manifestTextSha256: 'manifestTextSha256 ?? null',
    why: 'a fixed word; a target the database constrains to app.release_target_names() (006: a foreign key to app.release_targets); and two SHA-256 values of installer texts Phaeacia registers, not of any tenant content',
  },
  'lib/http/alerts.mjs (variable)': {
    v: 'ALERT_VERSION',
    at: 'new Date(Number.isFinite(now) ? now : Date.now()).toISOString()',
    count: 'decision.count',
    why: "the alert record's own version constant, the clock's ISO time and the fold count; the event is checked against ALERT_EVENTS before the record exists, and tests/e7/unit/alerts.test.mjs pins the record's key set exactly (E7-20)",
  },
};

/** The problems of one scan: sites or sinks that moved, and every field outside the allowlist and the declared set. */
function staticProblems(root) {
  const { sites, sinks, consoles } = logSites(root);
  const problems = [];
  const found = sites.map(describe).sort();
  for (const d of found) if (!SITES.includes(d)) problems.push(`an unpinned log site: ${d}`);
  for (const d of SITES) if (!found.includes(d)) problems.push(`a pinned log site is gone: ${d}`);
  if (JSON.stringify(sinks) !== JSON.stringify(SINKS)) problems.push(`the stderr sinks moved: ${sinks.join(', ')}`);
  for (const c of consoles) problems.push(`console. at ${c}`);
  for (const s of sites) {
    const declared = DECLARED[`${s.rel} ${s.event}`] ?? {};
    for (const f of s.fields) {
      if (f.kind === 'event' || f.kind === 'shaped') continue;
      if (f.kind !== 'key') problems.push(`${describe(s)}: an entry this scan cannot classify (${f.entry ?? f.of})`);
      else if (f.key === 'event' && s.via.startsWith('writeLine(')) continue;
      else if (Object.hasOwn(ALERT_FIELDS, f.key)) continue;
      else if (!Object.hasOwn(declared, f.key)) problems.push(`${describe(s)}: ${f.key} is not a field shapeFields admits`);
      else if (declared[f.key] !== f.value)
        problems.push(`${describe(s)}: ${f.key} now writes ${f.value}, not the declared ${declared[f.key]}`);
    }
  }
  return problems;
}

test('E8-6 static: every log site in lib/http/ and lib/services/ writes only allowlisted or declared fields, and the set is pinned', () => {
  /* The alerts design 1.2 adds `cause` and `routedTo`, each a fixed vocabulary, so a line may carry them as it carries
     `code` and `status`. */
  assert.deepEqual(Object.keys(ALERT_FIELDS), [
    'route',
    'code',
    'status',
    'companyId',
    'requestId',
    'errorName',
    'cause',
    'routedTo',
    /* XR-12's remainder: the database's SQLSTATE or PGRST code on an internal answer (evidence/xr-residuals.md). */
    'dbCode',
  ]);
  assert.deepEqual(staticProblems(REPO), []);
  /* The `refused` line writes code and status raw, and they are allowlisted names; their VALUES are the pure half's
     subject below, where every code in CODES is driven through the line. The two defaults the scan calls sinks are
     read here too, so a sink that started writing something other than its caller's entry would move SINKS. */
  const pipeline = readFileSync(join(REPO, 'lib/http/pipeline.mjs'), 'utf8');
  /* K2 (evidence/hardening-k.md): the line carries Netlify's request id through shapeFields, after code and status;
     XR-12's remainder adds the database's code there, shaped by the same allowlist. */
  assert.match(
    pipeline,
    /log\(\{ event: 'refused', code: e\.code, status: e\.status, \.\.\.shapeFields\(\{ requestId, dbCode \}\) \}\);/,
  );
});

test('E8-6 static fail-before: the pipeline internal line of 0ba9465, re-created, is named by the scan', async () => {
  const { dir, applied } = await mutantRoutes('e8-6-static-0ba9465', [
    [
      'lib/http/pipeline.mjs',
      [
        [
          "log({ event: 'internal', ...shapeFields({ errorName: e?.name ?? 'Error', code: e?.code, requestId }) });",
          "log({ event: 'internal', name: e?.name ?? 'Error', code: typeof e?.code === 'string' ? e.code : undefined });",
        ],
      ],
    ],
  ]);
  assert.equal(applied.length, 1);
  const failure = caught('E8-6 static on the 0ba9465 line', () => assert.deepEqual(staticProblems(dir), []));
  assert.match(String(failure.message), /lib\/http\/pipeline\.mjs log internal \[event, name, code\]/);
  assert.match(String(failure.message), /name is not a field shapeFields admits/);
});

/* ---------------------------------------------------------------------------------------------------
   The pure half
   --------------------------------------------------------------------------------------------------- */

const COMPANY = 'bbbbbbbb-2222-4333-8444-555555555555';
const SUB = '0f7d3a51-2f4a-4a7b-9c3e-1b9d3c0f5a11';
const sessionCookie = (claims = {}) =>
  `${COOKIES.access}=${hs256(userClaims({ sub: SUB, email: 's@example.invalid', issuer: `${BASE}/auth/v1`, ...claims }), SECRET)}`;

/* Header values: a web Request refuses a line break and anything outside Latin-1, so the header set carries the
   strings a header can carry; makeRequest is an in-process object and carries all of them. */
const HEADER_SAFE = STRINGS.filter((s) => /^[\x20-\x7e]*$/.test(s));

function hostileRequest({ path, params = {}, cookie, requestId = '01JA-9f2c-4d1e' } = {}) {
  return makeRequest({
    method: 'POST',
    path,
    params,
    query: Object.fromEntries(HOSTILE.map(([, s], i) => [`q${i}`, s])),
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      'x-nf-request-id': requestId,
      'x-synthetic-tenant': STRINGS.join(' | '),
      'user-agent': STRINGS[0],
      referer: `${ORIGIN}/members/?note=${STRINGS[1]}`,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ name: STRINGS[3], email: STRINGS[1], displayName: STRINGS[4], token: STRINGS[2], all: STRINGS }),
  });
}

/* A capture as deps: the route's lines, and the alert records the REAL alert() builds from what the boundary hands
   it, written through its alertWrite seam instead of stderr. The sink is none. */
function capture() {
  const lines = [];
  const records = [];
  const alertModule = import('../../../lib/http/alerts.mjs');
  return {
    lines,
    records,
    deps: {
      log: (entry) => lines.push(entry),
      alert: async (event, fields, deps) => {
        const { alert } = await alertModule;
        await alert(event, fields, { ...deps, alertWrite: (r) => records.push(r), alertSink: () => null });
      },
    },
  };
}

/** Every problem with a set of lines and records: a hostile string or marker, a field outside the allowlist, or a
    value that is not its own shaped form. `declaredKeys` are a site's own extra fields, checked separately. */
function lineProblems(lines, records, { declaredKeys = [] } = {}) {
  const problems = [];
  const found = hostileIn(JSON.stringify({ lines, records }));
  if (found.length) problems.push(`hostile strings in the lines: ${found.join(', ')}`);
  for (const line of lines) {
    const { event, ...rest } = line;
    if (typeof event !== 'string') problems.push(`a line with no event: ${JSON.stringify(line)}`);
    const own = Object.fromEntries(Object.entries(rest).filter(([k]) => !declaredKeys.includes(k)));
    for (const k of Object.keys(own)) if (!Object.hasOwn(ALERT_FIELDS, k)) problems.push(`${event}: ${k} is not allowlisted`);
    const shaped = shapeFields(own);
    if (JSON.stringify(shaped) !== JSON.stringify(own)) problems.push(`${event}: not its own shaped form: ${JSON.stringify(own)}`);
  }
  for (const r of records) {
    const { event, v, at, count, ...rest } = r;
    if (event === 'alert_dropped') continue;
    if (JSON.stringify(shapeFields(rest)) !== JSON.stringify(rest)) problems.push(`alert ${event}: not shaped: ${JSON.stringify(rest)}`);
  }
  return problems;
}

async function everyCode(routeFn) {
  const problems = [];
  let calls = 0;
  for (const code of Object.keys(CODES))
    for (const session of ['none', 'required']) {
      resetAlertWindow();
      const cap = capture();
      const handler = routeFn(
        {
          method: 'POST',
          path: '/api/companies/:companyId/e8-probe',
          uuidParams: ['companyId'],
          session,
          handle: async () => {
            throw new AppError(code);
          },
        },
        cap.deps,
      );
      const res = await handler(
        hostileRequest({
          path: `/api/companies/${COMPANY}/e8-probe`,
          params: { companyId: COMPANY },
          cookie: session === 'required' ? sessionCookie() : undefined,
        }),
      );
      calls += 1;
      if (res.status !== CODES[code]) problems.push(`${code} (${session}): answered ${res.status}`);
      if (hostileIn(res.body).length) problems.push(`${code}: the answer echoes ${hostileIn(res.body)}`);
      /* K2: the line carries the request's shaped request id, here hostileRequest's well-formed default. */
      const expected = [{ event: 'refused', code, status: CODES[code], requestId: '01JA-9f2c-4d1e' }];
      if (JSON.stringify(cap.lines) !== JSON.stringify(expected)) problems.push(`${code} (${session}): lines ${JSON.stringify(cap.lines)}`);
      problems.push(...lineProblems(cap.lines, cap.records).map((p) => `${code} (${session}): ${p}`));
      const alerted = cap.records.map((r) => r.event);
      /* XR-12's remainder: a code that answers 500 is a fault and raises `internal`, as a thrown fault does, except
         E_READ_OVER_BOUND, the expected 500 of a read past its ceiling (XR12-R2). */
      const fault = CODES[code] === 500 && code !== 'E_READ_OVER_BOUND';
      const want = code === 'E_MAIL_NOT_CONFIGURED' ? ['mail_not_configured'] : fault ? ['internal'] : [];
      if (JSON.stringify(alerted) !== JSON.stringify(want)) problems.push(`${code}: alerts ${alerted.join(', ')}`);
    }
  return { problems, calls };
}

test('E8-6 pure: every code in CODES, thrown by a route called with the hostile strings, logs one shaped refused line and nothing of them', async () => {
  const { problems, calls } = await everyCode(route);
  assert.deepEqual(problems, []);
  assert.equal(calls, Object.keys(CODES).length * 2);
  assert.ok(calls >= 160, `${calls} calls`);
});

/* Loaded errors: the shapes a thrown value can take. The strings are in the message, the name, the code, PostgREST's
   three fields and the stack. */
function loadedErrors() {
  const e1 = new Error(`database said: ${STRINGS[0]} for ${STRINGS[1]}`);
  e1.name = `${STRINGS[2]}-name`;
  e1.code = `${STRINGS[3]}-code`;
  e1.details = `row: ${STRINGS[4]}`;
  e1.hint = STRINGS[7];
  e1.stack = `Error: ${STRINGS[8]}\n    at handler (${STRINGS[9]})`;
  const e2 = new TypeError(STRINGS.join(' '));
  e2.code = 'E_NOT_FOUND';
  const e3 = { message: STRINGS[0], code: STRINGS[1], details: STRINGS[2], hint: STRINGS[3], name: STRINGS[5] };
  return [
    ['a loaded Error', e1],
    ['a TypeError whose code is a real code', e2],
    ['a PostgREST-shaped plain object', e3],
    ['a thrown string', STRINGS.join(' ')],
    ['a thrown null', null],
  ];
}

async function internalLines(routeFn) {
  const problems = [];
  for (const [label, thrown] of loadedErrors()) {
    resetAlertWindow();
    const cap = capture();
    const handler = routeFn(
      {
        method: 'POST',
        path: '/api/companies/:companyId/e8-probe',
        uuidParams: ['companyId'],
        session: 'none',
        handle: async () => {
          throw thrown;
        },
      },
      cap.deps,
    );
    const res = await handler(
      hostileRequest({ path: `/api/companies/${COMPANY}/e8-probe`, params: { companyId: COMPANY }, requestId: STRINGS[2] }),
    );
    if (res.status !== 500) problems.push(`${label}: answered ${res.status}`);
    if (cap.lines.length !== 1 || cap.lines[0].event !== 'internal') problems.push(`${label}: lines ${JSON.stringify(cap.lines)}`);
    if (cap.records.length !== 1 || cap.records[0].event !== 'internal') problems.push(`${label}: records ${JSON.stringify(cap.records)}`);
    problems.push(...lineProblems(cap.lines, cap.records).map((p) => `${label}: ${p}`));
  }
  return problems;
}

test('E8-6 pure: a handler throwing loaded values of five shapes writes one shaped internal line and one shaped alert, and none of the strings', async () => {
  assert.deepEqual(await internalLines(route), []);
});

test('E8-6 pure fail-before: the internal line of 0ba9465, re-created, carries the strings', async () => {
  const { dir } = await mutantRoutes('e8-6-pure-0ba9465', [
    [
      'lib/http/pipeline.mjs',
      [
        [
          "log({ event: 'internal', ...shapeFields({ errorName: e?.name ?? 'Error', code: e?.code, requestId }) });",
          "log({ event: 'internal', name: e?.name ?? 'Error', code: typeof e?.code === 'string' ? e.code : undefined });",
        ],
      ],
    ],
  ]);
  const mutant = await import(pathToFileURL(join(dir, 'lib', 'http', 'pipeline.mjs')).href);
  const failure = await caughtAsync('E8-6 pure on the 0ba9465 line', async () => assert.deepEqual(await internalLines(mutant.route), []));
  assert.match(String(failure.message), /hostile strings in the lines: token-shaped, agent name/);
  assert.match(String(failure.message), /internal: name is not allowlisted/);
});

/* The session verifier's four refusals. The ES256 token names a kid and makes the verifier fetch the JWKS, and the
   fetch fails with the strings in its error, which is E_SESSION_UNAVAILABLE's only path. */
test('E8-6 pure: the four session refusals, carrying the strings in the cookie and in a failing JWKS fetch, write shaped lines only', async () => {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const expired = sessionCookie({ now: Math.floor(Date.now() / 1000) - 7200, ttl: 60, email: STRINGS[1], extra: { note: STRINGS[0] } });
  const cases = [
    ['E_NO_SESSION', undefined, 'session_refused', 401],
    ['E_SESSION_INVALID', `${COOKIES.access}=${STRINGS.join('.')}`, 'session_refused', 401],
    ['E_SESSION_INVALID', `${COOKIES.access}=${b64u({ alg: 'HS256', typ: 'JWT', kid: STRINGS[2] })}.${b64u({ sub: STRINGS[3], email: STRINGS[1] })}.bad`, 'session_refused', 401],
    ['E_SESSION_EXPIRED', expired, 'session_refused', 401],
    ['E_SESSION_UNAVAILABLE', `${COOKIES.access}=${b64u({ alg: 'ES256', typ: 'JWT', kid: STRINGS[2] })}.${b64u({ sub: SUB, email: STRINGS[1] })}.c2ln`, 'session_unavailable', 503],
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error(`jwks said: ${STRINGS.join(' ')}`);
  };
  const problems = [];
  try {
    for (const [code, cookie, event, status] of cases) {
      resetAlertWindow();
      const cap = capture();
      const handler = route({ method: 'POST', path: '/api/e8-probe', session: 'required', handle: async () => assert.fail('reached') }, cap.deps);
      const res = await handler(hostileRequest({ path: '/api/e8-probe', cookie }));
      if (res.status !== status) problems.push(`${code}: answered ${res.status}`);
      const want = event === 'session_refused' ? [{ event, code }] : [{ event }];
      if (JSON.stringify(cap.lines) !== JSON.stringify(want)) problems.push(`${code}: lines ${JSON.stringify(cap.lines)}`);
      problems.push(...lineProblems(cap.lines, cap.records).map((p) => `${code}: ${p}`));
      if (event === 'session_unavailable' && cap.records.map((r) => r.event).join() !== 'session_unavailable')
        problems.push(`${code}: records ${JSON.stringify(cap.records)}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(problems, []);
});

/* GoTrue answers a factor call with the strings in its error body: the declared site writes a status and a closed
   word, and the refusal line after it is shaped. Three answers: an unknown error_code, a known one, and a body that
   is not JSON at all. */
test('E8-6 pure: GoTrue refusing a factor call with the strings in its body writes a closed gotrue_refused line and a shaped refusal', async () => {
  const answers = [
    [422, JSON.stringify({ code: 422, error_code: STRINGS[4], msg: STRINGS.join(' ') }), 'unknown'],
    [400, JSON.stringify({ code: 400, error_code: 'mfa_verification_failed', msg: STRINGS[0] }), 'mfa_verification_failed'],
    [500, `upstream said ${STRINGS.join(' ')}`, null],
  ];
  const realFetch = globalThis.fetch;
  const problems = [];
  try {
    for (const [status, body, errorCode] of answers) {
      globalThis.fetch = async () => new Response(body, { status, headers: { 'content-type': 'application/json' } });
      resetAlertWindow();
      const cap = capture();
      const routes = makeRoutes(cap.deps);
      const req = makeRequest({
        method: 'GET',
        path: '/api/auth/factors',
        query: { note: STRINGS[0] },
        headers: { cookie: sessionCookie(), 'x-synthetic-tenant': HEADER_SAFE.join(' | '), 'x-nf-request-id': '01JA-9f2c-4d1e' },
      });
      const res = await routes.factorsList(req);
      const [gotrue, refused, ...more] = cap.lines;
      if (more.length || gotrue?.event !== 'gotrue_refused' || refused?.event !== 'refused')
        problems.push(`${status}: lines ${JSON.stringify(cap.lines)}`);
      if (gotrue?.gotrueStatus !== status) problems.push(`${status}: gotrueStatus ${gotrue?.gotrueStatus}`);
      if (gotrue?.gotrueErrorCode !== errorCode) problems.push(`${status}: gotrueErrorCode ${gotrue?.gotrueErrorCode}`);
      if (errorCode !== null && errorCode !== 'unknown' && !Object.hasOwn(GOTRUE_ERROR_CODES, errorCode)) problems.push(`${status}: ${errorCode}`);
      if (res.status !== refused?.status) problems.push(`${status}: answered ${res.status} but logged ${refused?.status}`);
      problems.push(
        ...lineProblems(cap.lines, cap.records, { declaredKeys: ['gotrueStatus', 'gotrueErrorCode'] }).map((p) => `${status}: ${p}`),
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(problems, []);
});

/* The adapter's own catch takes no deps, so its line and its `escaped` alert go to process.stderr itself, which is
   what this case reads. The handler throws past the pipeline: a named route whose function throws a loaded error. */
test("E8-6 pure: the adapter's catch writes one shaped internal line and one shaped escaped alert to stderr, and none of the strings", async () => {
  resetAlertWindow();
  const thrower = async () => {
    const e = new Error(`escaped: ${STRINGS.join(' ')}`);
    e.name = STRINGS[3];
    e.code = STRINGS[2];
    throw e;
  };
  Object.defineProperty(thrower, 'route', { value: Object.freeze({ method: 'POST', session: 'none', body: 'json', path: '/api/companies/:companyId/e8-probe' }) });
  Object.defineProperty(thrower, 'routeName', { value: 'hostileProbe' });
  const wrapped = toNetlify(thrower);
  const written = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return typeof rest.at(-1) === 'function' ? (rest.at(-1)(), true) : true;
  };
  let res;
  try {
    res = await wrapped(
      new Request(`${ORIGIN}/api/companies/${COMPANY}/e8-probe?note=${encodeURIComponent(STRINGS.join(' '))}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-synthetic-tenant': HEADER_SAFE.join(' | '), 'x-nf-request-id': HEADER_SAFE[2] },
        body: JSON.stringify({ all: STRINGS }),
      }),
      { params: { companyId: COMPANY } },
    );
  } finally {
    process.stderr.write = realWrite;
  }
  assert.equal(res.status, 500);
  const lines = written.join('').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.event), ['internal', 'escaped']);
  assert.deepEqual(lineProblems([lines[0]], [lines[1]]), []);
  /* K2: the adapter's line carries the request id too, shaped, so a token-shaped one is the word `invalid` here. */
  assert.deepEqual(lines[0], { event: 'internal', errorName: 'Error', code: 'invalid', requestId: 'invalid' });
  assert.equal(lines[1].route, 'hostileProbe', 'a route name is letters only (alerts.mjs ROUTE)');
  assert.equal(lines[1].requestId, 'invalid', 'a token-shaped request id is not a request id');
  assert.deepEqual(hostileIn(await res.text()), []);
});

/* Lane K3 (evidence/hardening-k.md; the peer check's CR2-1): the sign-in route called with the hostile strings, the
   address among them, while GoTrue answers 429 with the strings in its body. The static half accepts the site's
   `...fields` because the file assigns `fields` from shapeFields(), and cannot see a later assignment into it; this
   case drives the route, so a raw value added to the line or the alert by any means is found here. The answer is the
   204 every address gets. */
test('E8-6 pure: a GoTrue 429 on sign-in, with the strings in the address and in its body, writes one shaped signin_limited line and alert', async () => {
  const realFetch = globalThis.fetch;
  const problems = [];
  try {
    for (const gotrue of [
      JSON.stringify({ code: 429, error_code: 'over_email_send_rate_limit', msg: STRINGS.join(' ') }),
      JSON.stringify({ code: 429, error_code: STRINGS[4], msg: STRINGS[1] }),
      `rate limited: ${STRINGS.join(' ')}`,
    ]) {
      globalThis.fetch = async () => new Response(gotrue, { status: 429, headers: { 'content-type': 'application/json' } });
      resetAlertWindow();
      const cap = capture();
      const res = await makeRoutes(cap.deps).authStart(hostileRequest({ path: '/api/auth/start' }));
      /* The alert is not awaited before the answer (HKC-F1) and this capture writes its record after an await of its
         own, so the case waits for the work the answer carries before it reads the records. */
      await workAfter(res);
      if (res.status !== 204 || res.body !== null) problems.push(`answered ${res.status} ${res.body}`);
      const expected = { event: 'signin_limited', route: 'authStart', code: 'E_RATE_LIMITED', status: 429, requestId: '01JA-9f2c-4d1e' };
      if (JSON.stringify(cap.lines) !== JSON.stringify([expected])) problems.push(`lines ${JSON.stringify(cap.lines)}`);
      const records = cap.records.map(({ v, at, count, ...rest }) => rest);
      if (JSON.stringify(records) !== JSON.stringify([expected])) problems.push(`records ${JSON.stringify(cap.records)}`);
      problems.push(...lineProblems(cap.lines, cap.records));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(problems, []);
});
