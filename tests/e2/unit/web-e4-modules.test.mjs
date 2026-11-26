/* E4 design 4.2 and 4.3 and E5 design 4.1 and 4.2, the shared-module changes, run in Node with an injected fetch,
   location and history (U8's method, in a file of its own so its globals are not shared): api.mjs's request headers
   come from a closed set, the Idempotency-Key of a bound write is made once per attempt and sent again on its retry and
   on rule 6's one repeat, the twelve codes of E4 4.2 and E5 4.2 answer the reload action and no other code does, and
   the fixed navigation set of shell.mjs gains the five E4 pages, E5's /catalog/ and the query forms, the same set the
   journeys' document assertion holds. Each test imports a fresh api.mjs. The E5 pages' own modules are checked in
   tests/e2/unit/web-e5-modules.test.mjs. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CODES } from '../../../lib/errors.mjs';
import { FIXED, QUERY } from '../../browser/harness.mjs';

const navigations = [];
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define('location', { hash: '', pathname: '/review/', search: '', assign: (target) => navigations.push(target) });
define('history', { replaceState: () => undefined });
define('document', { getElementById: (id) => ({ id }) });
define('addEventListener', () => undefined);

const APP = '../../../web/assets/app';
let serial = 0;
const freshApi = () => import(`${APP}/api.mjs?e4=${++serial}`);

const CANDIDATE = '9c0e5b1f-2a3d-4c5e-8f60-7a8b9c0d1e2f';
const ENVELOPE = '5b1f9c0e-3d2a-4e5c-9f60-8a7b0c9d2e1f';
const RELEASE = '1a2b3c4d-5e6f-4a8b-9c0d-e1f2a3b4c5d6';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const json = (status, value) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** routes['METHOD /path']: a list of answers used in order, the last repeating. Every request is logged. */
function service(routes) {
  const log = [];
  const counts = new Map();
  globalThis.fetch = async (path, init) => {
    const key = `${init.method} ${path}`;
    log.push({ key, init });
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    const list = routes[key];
    if (!list) throw new Error(`unscripted ${key}`);
    return list[Math.min(n, list.length - 1)]();
  };
  return log;
}
const thrown = () => () => {
  throw new TypeError('network');
};

test('E4 api: a bound write sends the rule 2 shape plus the idempotency-key header and nothing else', async () => {
  const api = await freshApi();
  const log = service({ [`POST /api/candidates/${CANDIDATE}/reviews`]: [() => json(201, { ok: true })] });
  await api.recordReview(CANDIDATE, { envelopeId: ENVELOPE, role: 'it', decision: 'approved', reason: 'r' }, 'k-1');
  assert.deepEqual(log[0].init, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: { accept: 'application/json', 'idempotency-key': 'k-1', 'content-type': 'application/json' },
    body: JSON.stringify({ envelopeId: ENVELOPE, role: 'it', decision: 'approved', reason: 'r' }),
  });
});

/* Moved by the E3 intake pages lane, for the reason that a page was added (docs/e3/intake-pages-design.md 9.3): the
   submit route reads If-Match beside its JSON body, so requestInit admits if-match too, as this module's comment said
   since E4 it would. The agent headers stay refused here: they belong to a passport request (passportInit) only. */
test('E4 api: requestInit admits idempotency-key and if-match alone; another name, another case or a value that is not a string throws', async () => {
  const api = await freshApi();
  assert.deepEqual(api.requestInit('GET', undefined, { 'idempotency-key': 'k' }).headers, {
    accept: 'application/json',
    'idempotency-key': 'k',
  });
  assert.equal(api.requestInit('POST', {}, { 'if-match': '1' }).headers['if-match'], '1');
  for (const headers of [
    { 'If-Match': '1' },
    { 'x-agent-name': 'a' },
    { 'x-agent-id': 'a' },
    { 'Idempotency-Key': 'k' },
    { authorization: 'x' },
    { cookie: 'x' },
    { 'idempotency-key': 7 },
  ])
    assert.throws(() => api.requestInit('POST', {}, headers), TypeError, JSON.stringify(Object.keys(headers)));
});

test('E4 api: writeAttempt makes one random v4 key per attempt and sends it again on every run of that attempt', async () => {
  const api = await freshApi();
  const seen = [];
  const first = api.writeAttempt((key) => seen.push(key));
  first();
  first();
  const second = api.writeAttempt((key) => seen.push(key));
  second();
  assert.match(seen[0], UUID_V4);
  assert.equal(seen[1], seen[0], 'the retry of an attempt sends its key again');
  assert.notEqual(seen[2], seen[0], 'a new attempt has its own key');
});

test('E4 api: a retry after a lost answer reuses the key, and the stored answer comes back as a success', async () => {
  const api = await freshApi();
  const log = service({
    [`POST /api/candidates/${CANDIDATE}/releases`]: [
      thrown(),
      () => json(201, { ok: true, existing: false, idempotentReplay: true }),
    ],
  });
  const run = api.writeAttempt((key) => api.publishRelease(CANDIDATE, ENVELOPE, key));
  const lost = await run();
  assert.equal(lost.network, true);
  assert.equal(lost.action, 'retry');
  const replay = await run();
  assert.equal(replay.ok, true);
  assert.equal(replay.data.idempotentReplay, true);
  assert.equal(log.length, 2);
  assert.equal(log[1].init.headers['idempotency-key'], log[0].init.headers['idempotency-key']);
  assert.match(log[0].init.headers['idempotency-key'], UUID_V4);
});

test("E4 api: rule 6's one repeat after a refresh resends the same key", async () => {
  const api = await freshApi();
  const log = service({
    [`POST /api/releases/${RELEASE}/withdraw`]: [
      () => json(401, { ok: false, code: 'E_UNAUTHENTICATED', message: 'x' }),
      () => json(200, { ok: true, recipients: [], revokesCopies: false }),
    ],
    'POST /api/auth/refresh': [() => new Response(null, { status: 204 })],
  });
  const r = await api.writeAttempt((key) => api.withdrawRelease(RELEASE, 'reason', key))();
  assert.equal(r.ok, true);
  const writes = log.filter((e) => e.key.endsWith('/withdraw'));
  assert.equal(writes.length, 2);
  assert.equal(writes[1].init.headers['idempotency-key'], writes[0].init.headers['idempotency-key']);
  assert.deepEqual(navigations, []);
});

test('E4 and E5 api: the twelve reload codes of E4 4.2 and E5 4.2, each a code the service has, and no other', async () => {
  const api = await freshApi();
  const RELOAD = [
    'E_IDEMPOTENCY_EXPIRED',
    'E_IDEMPOTENCY_CONFLICT',
    'E_NOT_REVIEWABLE',
    'E_ALREADY_SIGNED',
    'E_ENVELOPE_CLOSED',
    'E_ENVELOPE_APPROVED',
    'E_ALREADY_WITHDRAWN',
    'E_CANDIDATE_SUPERSEDED',
    /* E5 design 4.2: the work has moved on since the page read it. */
    'E_RELEASE_WITHDRAWN',
    'E_RELEASE_SUPERSEDED',
    'E_REPORT_LIMIT',
    'E_ALREADY_WITNESSED',
    /* E6 design 2.6 item 7: changed by somebody else, or gone, since the page read it. */
    'E_OWNER_CHANGED',
    'E_SEATS_EXHAUSTED',
    'E_INVITATION_LIMIT',
    'E_COMPANY_CLOSED',
  ];
  for (const code of RELOAD) {
    assert.ok(Object.hasOwn(CODES, code), `${code} is a code of lib/errors.mjs`);
    assert.equal(api.actionFor(code), 'reload', code);
  }
  const reloads = Object.keys(CODES).filter((code) => api.actionFor(code) === 'reload');
  assert.deepEqual(reloads.sort(), [...RELOAD].sort(), 'no other code reloads');
  for (const code of [
    'E_COMPANY_INACTIVE',
    'E_ACCESS_PERIOD_ENDED',
    'E_GATE_FAILS_NOW',
    'E_DERIVED_CHANGED',
    'E_ASSEMBLY_TOO_LARGE',
    'E_REVIEWER_IS_CONTRIBUTOR',
    'E_ROLE_REQUIRED',
    /* E5 design 4.2: these show their message beside the control that caused them, so they do not reload. */
    'E_TARGET_NOT_PUBLISHABLE',
    'E_NOT_DOWNLOADED',
    'E_LOSSES_REQUIRED',
    'E_WITNESS_IS_RECIPIENT',
    'E_WITNESS_LIMIT',
    'E_DOWNLOAD_LIMIT',
  ])
    assert.equal(api.actionFor(code), 'message', code);
});

test('E4 api: the group routes send no key, and the release list sends its cursor as the one query value', async () => {
  const api = await freshApi();
  const company = '2a5d1b3c-4e6f-4a8b-9c0d-1e2f3a4b5c6d';
  const log = service({
    [`POST /api/companies/${company}/groups`]: [() => json(201, { ok: true, groupId: RELEASE, changed: true })],
    [`GET /api/companies/${company}/releases?cursor=${RELEASE}`]: [
      () => json(200, { ok: true, releases: [], nextCursor: null }),
    ],
  });
  await api.createGroup(company, 'Finance');
  await api.releases(company, RELEASE);
  assert.equal(log[0].init.headers['idempotency-key'], undefined);
  assert.equal(log[1].key, `GET /api/companies/${company}/releases?cursor=${RELEASE}`);
});

test("E4 and E5 shell: the fixed set gains the five E4 pages, /catalog/, and the candidate and release forms, and equals the journeys' set", async () => {
  const shell = await import(`${APP}/shell.mjs`);
  const id = '2a5d1b3c-4e6f-4a8b-9c0d-1e2f3a4b5c6d';
  for (const target of [
    '/reviews/',
    '/review/',
    '/releases/',
    '/release/',
    '/groups/',
    '/catalog/',
    `/catalog/?company=${id}`,
    `/reviews/?company=${id}`,
    `/review/?candidate=${id}`,
    `/release/?release=${id}`,
    `/groups/?company=${id}`,
  ])
    assert.equal(shell.isAllowedTarget(target), true, target);
  for (const target of [
    '/review',
    `/review/?candidate=not-a-uuid`,
    `/review/?candidate=${id}&release=${id}`,
    `/release/?release=${id.toUpperCase()}`,
    `/review/?candidate=${id}#x`,
    '/candidates/',
  ])
    assert.equal(shell.isAllowedTarget(target), false, target);
  const paths = [
    ...FIXED,
    '/review',
    '/reviews',
    '/admin/',
    '/candidate/',
    '/groups',
    '/releases//',
    '/catalog',
    '/catalogue/',
  ];
  const queries = [
    '',
    `company=${id}`,
    `candidate=${id}`,
    `release=${id}`,
    'reason=expired',
    'reason=signed-out',
    'candidate=x',
    `next=${id}`,
    `company=${id}&candidate=${id}`,
  ];
  for (const path of paths)
    for (const query of queries) {
      const target = query ? `${path}?${query}` : path;
      assert.equal(shell.isAllowedTarget(target), FIXED.has(path) && (query === '' || QUERY.test(query)), target);
    }
});

test("E4 shell: the navigation set and the journeys' set are equal in both directions (E4PW-R-F2)", () => {
  /* shell.mjs does not export PATHS or QUERY: they are the open-redirect allowlist, and the module's surface stays
     isAllowedTarget. The test reads the module text and lifts both literals, so a path or query form added to one side
     and not the other fails here whichever side it was added to; the enumeration above cannot see a widening of the
     shell. */
  const source = readFileSync(new URL(`${APP}/shell.mjs`, import.meta.url), 'utf8');
  const paths = source.match(/const PATHS = new Set\(\[([^\]]*)\]\);/);
  assert.ok(paths, 'PATHS literal found in shell.mjs');
  const shellPaths = [...paths[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(new Set(shellPaths).size, shellPaths.length, 'no duplicate in PATHS');
  assert.deepEqual([...shellPaths].sort(), [...FIXED].sort(), 'PATHS equals FIXED, both directions');
  const query = source.match(/const QUERY = new RegExp\((`[^`]*`)\);/);
  assert.ok(query, 'QUERY literal found in shell.mjs');
  const uuid = source.match(/const UUID = '([^']*)';/);
  assert.ok(uuid, 'UUID literal found in shell.mjs');
  const shellQuery = new RegExp(query[1].slice(1, -1).replaceAll('${UUID}', uuid[1]));
  assert.equal(shellQuery.source, QUERY.source, "QUERY equals the journeys' QUERY, source for source");
});

test("E4 shell: isAllowedTarget's answers equal the journeys' set over every path the module's text can name (TOOL-R1-F2)", async () => {
  /* The comparison above holds two literals equal; a widening written inside the predicate, `if (parts[0] === '/debug/')
     return true;`, leaves both literals alone and passed 9 of 9 (evidence/e5-pages-review.md, mutant e). This test
     judges decisions, not literals: every slash-led string literal anywhere in shell.mjs, each fixed path, and each of
     those with a segment added, dropped or doubled, crossed with every query form, must get from isAllowedTarget exactly
     the answer FIXED and QUERY give. Its bound: the query space is the seven forms listed below, not lifted from the
     module, so a query admitted inside the predicate (`parts[1] === 'trace=1'`) is not seen, and QUERY is half of the
     open-redirect allowlist (TOOL2-R-F5); and a path admitted through a regular expression or assembled from parts
     names no literal, and is not seen. */
  /* SHELL_UNDER_TEST lets a saved mutant be judged from a scratch mirror without touching web/. */
  const shellUrl = process.env.SHELL_UNDER_TEST
    ? new URL(`file://${process.env.SHELL_UNDER_TEST}`)
    : new URL(`${APP}/shell.mjs`, import.meta.url);
  let shell;
  try {
    shell = await import(shellUrl.href);
  } catch (e) {
    /* A mutant that cannot load reads as 9 of 10, the signature of a caught one (TOOL2-R-F4): shell.mjs imports
       ./dom.mjs relatively, so a saved mutant has to sit beside a copy of it. Say so instead of failing like a catch. */
    assert.fail(`SHELL_UNDER_TEST did not load, which is not a caught mutant: ${e.code ?? e.message}`);
  }
  assert.equal(typeof shell.isAllowedTarget, 'function', 'the module under test exports isAllowedTarget');
  const source = readFileSync(shellUrl, 'utf8');
  const literals = [...source.matchAll(/['"`](\/[^'"`\s?#]*)['"`]/g)].map((m) => m[1]);
  assert.ok(literals.includes('/catalog/'), 'the lift sees the fixed paths');
  const seeds = new Set([...FIXED, ...literals]);
  const paths = new Set(seeds);
  for (const seed of seeds) {
    paths.add(`${seed}x/`);
    paths.add(seed.replace(/\/$/, ''));
    paths.add(`${seed}${seed.slice(1)}`);
    paths.add(`/debug${seed}`);
  }
  const id = '9b2f6c1e-5a44-4f0b-8e6d-2c1a7b3d4e5f';
  const queries = ['', `company=${id}`, `candidate=${id}`, `release=${id}`, 'reason=expired', `agent=${id}`, 'debug=1'];
  let judged = 0;
  for (const path of paths)
    for (const query of queries) {
      const target = query ? `${path}?${query}` : path;
      assert.equal(shell.isAllowedTarget(target), FIXED.has(path) && (query === '' || QUERY.test(query)), target);
      judged += 1;
    }
  assert.ok(judged > 300, `a space worth the name: ${judged} targets`);
});
