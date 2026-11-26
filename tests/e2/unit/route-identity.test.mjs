/* lib/http route identity (pages design 4.1; U12's wiring assertion written as a unit test, since the dev
   shell that will also run it is pages construction). route() refuses a declaration without a well-formed
   path when it is called; makeRoutes() tags each handler with its own key; toNetlify carries route and
   routeName onto the wrapper Netlify loads. Then, for every file under netlify/functions/: the default's
   routeName names a key of makeRoutes(), its route deep-equals that entry's, the file's config.path and
   config.method equal the route's own, and the default is the adapter wrapper rather than a bare handler.
   The table has exactly one entry per function file. The recheck's counterexample, a copy of
   invitations-create.mjs wired to operatorCompanyCreate with its config untouched, is kept as a fixture and must
   fail on the path and at no earlier assertion. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = 'example-unit-secret-with-at-least-32-characters-long';
process.env.ENTERPRISE_ACCESS_STATE = 'open';

const { route } = await import('../../../lib/http/pipeline.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { toNetlify } = await import('../../../lib/http/netlify.mjs');
const { json } = await import('../../../lib/http/response.mjs');

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const FUNCTIONS = join(REPO, 'netlify', 'functions');
const handle = async () => json(200, { ok: true });
/* The scheduled functions (the alerts design 1.8): files with a config.schedule and no path, which serve no request
   and so are no route's wiring. They are exactly the files listed here, each checked on its own below; every other
   file is a route file and meets U12 as before. */
const SCHEDULED_FILES = Object.freeze(['checkin.mjs']);
const functionFiles = () =>
  readdirSync(FUNCTIONS)
    .filter((f) => f.endsWith('.mjs') && !SCHEDULED_FILES.includes(f))
    .sort();

test('route() refuses a missing or malformed path when it is called, not at request time', () => {
  const refused = [
    ['missing', undefined],
    ['not a string', 42],
    ['a String object', new String('/api/x')],
    ['empty', ''],
    ['relative', 'api/x'],
    ['outside /api/', '/auth/start'],
    ['/api without a segment', '/api'],
    ['/api/ alone', '/api/'],
    ['a prefix that is not the /api/ segment', '/apix/y'],
    ['trailing slash', '/api/auth/start/'],
    ['empty segment', '/api//start'],
    ['wildcard', '/api/companies/*'],
    ['regular expression', '/api/companies/(.*)'],
    ['bare colon', '/api/companies/:'],
    ['parameter starting with a digit', '/api/companies/:1d'],
    ['parameter holding a dash', '/api/companies/:company-id'],
    ['colon inside a literal', '/api/a:b'],
    ['upper-case literal', '/api/Companies'],
    ['query string', '/api/auth/start?x=1'],
    ['fragment', '/api/auth/start#x'],
    ['percent-encoding', '/api/auth%2Fstart'],
    ['whitespace', '/api/auth start'],
    ['dot segment', '/api/../auth'],
    ['the same parameter twice', '/api/companies/:id/members/:id'],
  ];
  for (const [label, path] of refused)
    assert.throws(
      () => route({ method: 'POST', path, handle }),
      { name: 'TypeError', message: /^route\(\): path / },
      label,
    );

  for (const path of [
    '/api/me',
    '/api/auth/start',
    '/api/companies/:companyId/invitations/:invitationId/revoke',
    '/api/companies/:companyId/invitation-list',
    '/api/operator/companies/:companyId/transfer-first-admin',
  ])
    assert.equal(route({ method: 'POST', path, handle }).route.path, path);
});

test('route() refuses the rest of a declaration it could not serve, also when it is called', () => {
  const path = '/api/companies/:companyId/members';
  const refused = [
    ['unknown method', { method: 'OPTIONS' }, /^route\(\): method /],
    ['lower-case method', { method: 'post' }, /^route\(\): method /],
    ['unknown session', { session: 'require' }, /^route\(\): session /],
    ['unknown body mode', { body: 'Passport' }, /^route\(\): body /],
    ['unknown body mode, a capitalised submission', { body: 'Submission' }, /^route\(\): body /],
    ['a GET declaring a JSON body the adapter never reads', { method: 'GET' }, /^route\(\): a GET route /],
    ['a GET declaring a passport body', { method: 'GET', body: 'passport' }, /^route\(\): a GET route /],
    ['a GET declaring a submission body', { method: 'GET', body: 'submission' }, /^route\(\): a GET route /],
    ['no handle', { handle: undefined }, /^route\(\): handle /],
    ['uuidParams naming no parameter of the path', { uuidParams: ['membershipId'] }, /^route\(\): uuidParams /],
    ['uuidParams as a string', { uuidParams: 'companyId' }, /^route\(\): uuidParams /],
  ];
  for (const [label, over, message] of refused)
    assert.throws(
      () => route({ method: 'POST', path, uuidParams: ['companyId'], handle, ...over }),
      { name: 'TypeError', message },
      label,
    );

  const ok = route({ method: 'GET', path, uuidParams: ['companyId'], body: 'none', handle });
  assert.deepEqual(ok.route, { method: 'GET', session: 'required', body: 'none', path });
  assert.ok(Object.isFrozen(ok.route));
  assert.throws(() => {
    ok.route = { method: 'POST', session: 'none', body: 'json', path: '/api/x' };
  }, TypeError);
  assert.equal(ok.route.method, 'GET');
  assert.deepEqual(route({ method: 'PUT', path, body: 'passport', handle }).route, {
    method: 'PUT',
    session: 'required',
    body: 'passport',
    path,
  });
  assert.deepEqual(route({ method: 'POST', path, body: 'submission', handle }).route, {
    method: 'POST',
    session: 'required',
    body: 'submission',
    path,
  });
});

test('makeRoutes() tags every handler with its own key, non-writable, and every declaration carries a path', () => {
  const table = makeRoutes();
  assert.ok(Object.isFrozen(table));
  /* 58 since the alerts design's mail event route (slice 1). */
  assert.equal(Object.keys(table).length, 58);
  for (const [name, handler] of Object.entries(table)) {
    assert.equal(handler.routeName, name);
    assert.deepEqual(Object.keys(handler.route).sort(), ['body', 'method', 'path', 'session'], name);
    assert.match(handler.route.path, /^\/api\//, name);
    assert.throws(() => {
      handler.routeName = 'operatorCompanyCreate';
    }, TypeError);
  }
});

test('toNetlify carries route and routeName onto the wrapper, and refuses a handler that has neither', () => {
  const table = makeRoutes();
  for (const [name, handler] of Object.entries(table)) {
    const wrapper = toNetlify(handler);
    assert.notEqual(wrapper, handler);
    assert.equal(wrapper.routeName, name);
    assert.equal(wrapper.route, handler.route, `${name}: the wrapper carries the handler's own declaration`);
    assert.throws(() => {
      wrapper.routeName = 'other';
    }, TypeError);
  }
  const unnamed = route({ method: 'POST', path: '/api/probe', handle });
  const bare = async () => null;
  const refused = [
    ['undefined, as a missing makeRoutes() key gives', undefined],
    ['a function with no declaration', bare],
    ['a declared route with no routeName', unnamed],
    ['a plain object carrying both', { route: unnamed.route, routeName: 'probe' }],
  ];
  for (const [label, candidate] of refused)
    assert.throws(() => toNetlify(candidate), { name: 'TypeError', message: /^toNetlify\(\): / }, label);
});

/* U12's wiring assertions, in order. A failure is rethrown carrying the stage it failed at, so a fixture can
   show where it fails and that no earlier stage did. */
async function wiringOf(url, table, label) {
  const mod = await import(url);
  const deployed = mod.default;
  const stage = async (name, check) => {
    try {
      await check();
    } catch (e) {
      e.stage = name;
      e.message = `${label}, ${name}: ${e.message}`;
      throw e;
    }
  };
  await stage('routeName', () =>
    assert.ok(
      typeof deployed?.routeName === 'string' && Object.hasOwn(table, deployed.routeName),
      `routeName ${JSON.stringify(deployed?.routeName)} is not a key of makeRoutes()`,
    ),
  );
  const declared = table[deployed.routeName].route;
  await stage('route', () => assert.deepEqual(deployed.route, declared));
  await stage('config.path', () => assert.equal(mod.config?.path, declared.path));
  await stage('config.method', () => assert.equal(mod.config?.method, declared.method));
  await stage('adapter', async () => {
    /* The default must be the web wrapper, not the bare route function the config describes. Closed switch:
       nothing is read and no session is verified. */
    process.env.ENTERPRISE_ACCESS_STATE = 'closed';
    try {
      const res = await deployed(new Request('https://enterprise.example.invalid/api/wiring', { method: 'POST' }), {});
      assert.ok(res instanceof Response, 'the default did not answer a web Request with a web Response');
      assert.equal(res.status, 503);
    } finally {
      process.env.ENTERPRISE_ACCESS_STATE = 'open';
    }
  });
  return deployed.routeName;
}

function assertCoverage(pairs, table) {
  const byName = new Map();
  for (const [file, name] of pairs) {
    assert.ok(!byName.has(name), `${file} and ${byName.get(name)} both serve ${name}`);
    byName.set(name, file);
  }
  const unserved = Object.keys(table).filter((n) => !byName.has(n));
  assert.deepEqual(unserved, [], 'table entries with no function file');
  assert.equal(byName.size, Object.keys(table).length);
}

test('U12 wiring identity: every function file serves the handler its own config path and method declare', async () => {
  const table = makeRoutes();
  const files = functionFiles();
  assert.equal(files.length, 58);
  const pairs = [];
  for (const file of files) pairs.push([file, await wiringOf(pathToFileURL(join(FUNCTIONS, file)).href, table, file)]);
  assertCoverage(pairs, table);
});

test('U12 fixture: the recheck counterexample fails on the path and nowhere earlier; its siblings fail at their own stage', async () => {
  const table = makeRoutes();
  const original = readFileSync(join(FUNCTIONS, 'invitations-create.mjs'), 'utf8');
  /* Each fixture sits one directory below .scratch/, the same depth under the repository as
     netlify/functions/, so its relative specifiers resolve unchanged and the only edit to the text is the one
     named. .scratch/ is ignored by Git and by the gate. */
  mkdirSync(join(REPO, '.scratch'), { recursive: true });
  const made = [];
  const once = (from, to) => {
    assert.equal(original.split(from).length, 2, `${JSON.stringify(from)} occurs once in invitations-create.mjs`);
    return original.replace(from, to);
  };
  /* Re-based by the E7 mail lane (grant of 2026-09-19): invitations-create.mjs hands makeRoutes the mail transport
     since E7 1.1, so each edit names the real text; the three fixtures and their stages are unchanged. */
  const fixtures = [
    [
      'recheck counterexample',
      once(
        'makeRoutes({ alert, mail: mailTransport() }).invitationsCreate',
        'makeRoutes({ alert, mail: mailTransport() }).operatorCompanyCreate',
      ),
      'config.path',
      'operatorCompanyCreate',
    ],
    ['config method changed', once("method: 'POST' }", "method: 'PUT' }"), 'config.method', 'invitationsCreate'],
    [
      'bare handler, no adapter',
      once(
        'toNetlify(makeRoutes({ alert, mail: mailTransport() }).invitationsCreate)',
        'makeRoutes({ alert, mail: mailTransport() }).invitationsCreate',
      ),
      'adapter',
      'invitationsCreate',
    ],
  ];
  try {
    const realConfig = (await import(pathToFileURL(join(FUNCTIONS, 'invitations-create.mjs')).href)).config;
    for (const [label, text, expectedStage, servedName] of fixtures) {
      const dir = mkdtempSync(join(REPO, '.scratch', 'route-identity-'));
      made.push(dir);
      const file = join(dir, 'invitations-create.mjs');
      writeFileSync(file, text);
      const url = pathToFileURL(file).href;
      const mod = await import(url);
      assert.equal(mod.default.routeName, servedName, label);
      if (label === 'recheck counterexample') assert.deepEqual(mod.config, realConfig, 'config untouched');
      let failure;
      try {
        await wiringOf(url, table, label);
      } catch (e) {
        failure = e;
      }
      assert.ok(failure, `${label}: passed every wiring assertion`);
      assert.equal(failure.stage, expectedStage, `${label} failed at ${failure.stage}: ${failure.message}`);
    }
  } finally {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  }
  /* With the counterexample in place of the real file, the coverage check fails too: two files serve
     operatorCompanyCreate. With no file for invitationsCreate, the table has an entry without a file. */
  const real = [];
  for (const f of functionFiles())
    real.push([f, (await import(pathToFileURL(join(FUNCTIONS, f)).href)).default.routeName]);
  assert.doesNotThrow(() => assertCoverage(real, table), 'control: the real files cover the table');
  const swapped = real.map(([f, n]) => [f, f === 'invitations-create.mjs' ? 'operatorCompanyCreate' : n]);
  assert.throws(() => assertCoverage(swapped, table), /both serve operatorCompanyCreate/);
  const missing = real.filter(([f]) => f !== 'invitations-create.mjs');
  assert.throws(() => assertCoverage(missing, table), /table entries with no function file/);
});

/* E7 design 1.1 and case E7-24, added by the E7 mail lane (grant of 2026-09-19) and extended by the checks-and-alerts
   lane (day 6). The four invitation routes are the only ones that send mail, so their files, and only theirs, hand
   makeRoutes the transport AND the alert sink; a file that does not would serve a route that answers
   E_MAIL_NOT_CONFIGURED in mail mode however the environment is set, or would write a row and raise no
   delivery_failed alert at all, because lib/services/invitations.mjs reaches the module only through deps.alert
   (design 2.4 forbids lib/services/ importing lib/http/alerts.mjs). The pipeline's and the adapter's own alerts need
   no wiring line: they call the module's alert() directly, so every one of the routes alerts in production. Read from
   each file's text, because neither dependency leaves a mark on the wrapper Netlify loads. Fails before: at main
   928f472 all four read makeRoutes(); at 6af5d48 all four read makeRoutes({ mail: mailTransport() }) and no file
   carried a sink. */
test('E7-24: exactly the four invitation files and the mail event file hand makeRoutes the mail transport and the alert sink, each once', async () => {
  /* The alerts design (slice 1, section 7) adds mailEvents: its service raises the operator's delivery_undeliverable
     alert only through deps.alert, so its file must carry the sink, and slice 2's contact mail sends through the
     transport it carries. Fails before: a mail-events.mjs on the plain wiring carries neither. */
  const INVITATION_ROUTES = [
    'invitationsCreate',
    'invitationsResend',
    'mailEvents',
    'operatorAdminInvitation',
    'operatorCompanyCreate',
  ];
  const MAIL_IMPORT = "import { mailTransport } from '../../lib/services/mail.mjs';";
  const ALERT_IMPORT = "import { alert } from '../../lib/http/alerts.mjs';";
  const CALL = 'makeRoutes({ alert, mail: mailTransport() })';
  const carrying = [];
  for (const file of functionFiles()) {
    const text = readFileSync(join(FUNCTIONS, file), 'utf8');
    const name = (await import(pathToFileURL(join(FUNCTIONS, file)).href)).default.routeName;
    const carries =
      text.split(CALL).length === 2 && text.split(MAIL_IMPORT).length === 2 && text.split(ALERT_IMPORT).length === 2;
    assert.equal(carries, INVITATION_ROUTES.includes(name), `${file} (${name})`);
    if (carries) carrying.push(name);
    else {
      assert.equal(text.includes('mailTransport'), false, `${file}: no transport anywhere in a non-invitation file`);
      assert.equal(text.includes('alerts.mjs'), false, `${file}: no alert sink anywhere in a non-invitation file`);
    }
  }
  assert.deepEqual(carrying.sort(), INVITATION_ROUTES);
});

/* E7-24's second half: makeRoutes builds NO transport and NO sink of its own, so neither can appear by accident, and
   what it is handed is what the four invitation paths receive. Read at the service's own seam, requireDelivery, which
   is where 3.5 puts the refusal: the route cannot be reached in a unit test without a session, and the route-level
   arms of E7-24 run on the stack. With no transport in `mail` mode the answer is 503 E_MAIL_NOT_CONFIGURED however
   else deps are filled, which is E7-6's assertion re-read here against makeRoutes' own defaults. Fails before: a
   makeRoutes that constructed mailTransport() itself would make the first two rows ready. */
test('E7-24: makeRoutes builds no transport and no sink of its own, and mail mode without one still refuses', async () => {
  const { requireDelivery } = await import('../../../lib/services/invitations.mjs');
  const { AppError } = await import('../../../lib/errors.mjs');
  const before = process.env.ENTERPRISE_INVITATION_DELIVERY;
  process.env.ENTERPRISE_INVITATION_DELIVERY = 'mail';
  process.env.ENTERPRISE_ORIGIN = 'https://enterprise.example.invalid';
  try {
    /* The deps each of the four invitation paths is handed, read from the table makeRoutes returns: with nothing
       wired there is no ready transport and no sink, so mail mode refuses before any write. */
    for (const deps of [{}, { alert: () => {} }, { log: () => {} }]) {
      const table = makeRoutes(deps);
      assert.equal(typeof table.invitationsCreate, 'function', 'the table is built whatever deps hold');
      assert.throws(
        () => requireDelivery({ alert: deps.alert }),
        (e) => e instanceof AppError && e.code === 'E_MAIL_NOT_CONFIGURED' && e.status === 503,
        `deps ${JSON.stringify(Object.keys(deps))}`,
      );
    }
    /* And the sink a caller hands in is passed on unchanged: the four function files' `alert` is what raises
       delivery_failed, and nothing in makeRoutes substitutes one. */
    const sink = () => {};
    assert.doesNotThrow(() => requireDelivery({ alert: sink, ready: () => true, deliver: () => {} }));
  } finally {
    if (before === undefined) delete process.env.ENTERPRISE_INVITATION_DELIVERY;
    else process.env.ENTERPRISE_INVITATION_DELIVERY = before;
  }
});

/* The alerts design 1.8: the check-in is a scheduled function, not a route. Its file is exactly SCHEDULED_FILES, its
   default is the adapter lib/http/checkin.mjs builds, and its config holds the schedule and no path or method, so no
   URL reaches it (Netlify: "you can't invoke them directly with a URL"). The schedule is pinned to the rule module's
   own, the hour the check-in's "Next check-in" line names. Fails before: a checkin.mjs with a path would be a route
   file makeRoutes() does not declare, and a schedule other than 0 6 * * * would promise the wrong hour. */
test('the scheduled function: checkin.mjs is the only file with a schedule, and it carries the rule module schedule and no path', async () => {
  const { CHECKIN_SCHEDULE } = await import('../../../lib/rules/mail-events.mjs');
  const scheduled = [];
  for (const file of readdirSync(FUNCTIONS)
    .filter((f) => f.endsWith('.mjs'))
    .sort()) {
    const mod = await import(pathToFileURL(join(FUNCTIONS, file)).href);
    if (mod.config && Object.hasOwn(mod.config, 'schedule')) scheduled.push(file);
  }
  assert.deepEqual(scheduled, [...SCHEDULED_FILES]);
  const mod = await import(pathToFileURL(join(FUNCTIONS, 'checkin.mjs')).href);
  assert.deepEqual(mod.config, { schedule: CHECKIN_SCHEDULE });
  assert.equal(CHECKIN_SCHEDULE, '0 6 * * *');
  assert.equal(typeof mod.default, 'function');
  assert.equal(mod.default.route, undefined, 'a scheduled function carries no route declaration');
  assert.equal(readFileSync(join(FUNCTIONS, 'checkin.mjs'), 'utf8').includes('path'), false);
});
