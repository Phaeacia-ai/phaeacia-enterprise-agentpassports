/* U12 (pages design 7.1 and section 5) and HTTP-D4's strict parser, run without the stack. The shell builds into a
   temporary output and serves it. Asserted: one route per function file, wired to the route its own config declares;
   two files with one path and method, and a path pattern with anything but literal and :name segments, refuse
   startup; the recheck's consistently miswired copy fails on the path; the bundle critique's shadowed makeRoutes and
   the E3b critique's wrapper mutant W1 both carry correct-looking route and routeName metadata and are both refused by
   the strict whole-file parser; the header parser refuses an unknown line in a block, skips comments and blank lines,
   stops at the end of a block, and produces a written-out expected header set, for a fixture and for the real
   netlify.toml; /api/ answers carry no netlify.toml header; two Set-Cookie values survive; a streamed request body is
   accepted; traversal, encoded traversal, an encoded separator, a symbolic link, a file added behind the build and an
   absolute-form request answer 404; a host other than 127.0.0.1 is refused. Fixture function files sit one directory
   below .scratch/, the depth of netlify/functions/, so their relative specifiers resolve unchanged. */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_ANON_KEY = 'unit-anon-key';
process.env.SUPABASE_JWT_SECRET = 'example-unit-secret-with-at-least-32-characters-long';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FUNCTIONS = join(REPO, 'netlify', 'functions');
const { headersFor, parseHeaderRules, routeTable, startShell } = await import('../../browser/dev-shell.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');

const made = [];
const temporary = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
/* A functions directory at the depth of netlify/functions/, holding the named copies. */
function functionsDir(files) {
  mkdirSync(join(REPO, '.scratch'), { recursive: true });
  const dir = mkdtempSync(join(REPO, '.scratch', 'u12-functions-'));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
const real = (file) => readFileSync(join(FUNCTIONS, file), 'utf8');
const once = (text, from, to) => {
  assert.equal(text.split(from).length, 2, `${from} occurs once`);
  return text.replace(from, to);
};

let shell;
before(async () => {
  const dir = temporary('u12-site-');
  shell = await startShell({ stack: false, siteDir: join(dir, 'site'), manifestPath: join(dir, 'site-manifest.json') });
});
after(async () => {
  await shell?.close();
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function raw(port, method, path, { headers = {}, body, chunks } = {}) {
  return new Promise((ok, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () =>
        ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }),
      );
    });
    req.on('error', fail);
    for (const chunk of chunks ?? (body === undefined ? [] : [body])) req.write(chunk);
    req.end();
  });
}

test('U12: the route table has one entry per function file, each serving the route its own config declares', () => {
  const files = readdirSync(FUNCTIONS).filter((f) => f.endsWith('.mjs'));
  const declared = makeRoutes();
  /* The alerts design 1.8: the check-in is a scheduled function, listed apart and never served. */
  assert.deepEqual(shell.scheduled, [{ file: 'checkin.mjs', name: 'checkin', schedule: '0 6 * * *' }]);
  assert.equal(shell.table.length + shell.scheduled.length, files.length);
  assert.deepEqual(shell.table.map((t) => t.name).sort(), Object.keys(declared).sort());
  for (const entry of shell.table) {
    assert.equal(entry.path, declared[entry.name].route.path, entry.file);
    assert.equal(entry.method, declared[entry.name].route.method, entry.file);
    assert.equal(entry.handler.routeName, entry.name, entry.file);
  }
});

test('U12: two files with the same path and method refuse startup', async () => {
  const dir = functionsDir({ 'me.mjs': real('me.mjs'), 'me-again.mjs': real('me.mjs') });
  await assert.rejects(
    routeTable({ functionsDir: dir }),
    /me\.mjs and me-again\.mjs both declare GET \/api\/me|me-again\.mjs and me\.mjs both declare GET \/api\/me/,
  );
});

test('U12: a path pattern with anything but literal and :name segments refuses startup', async () => {
  for (const pattern of ['/api/*', '/api/(.*)', '/api/me/:id?']) {
    const dir = functionsDir({ 'me.mjs': once(real('me.mjs'), "path: '/api/me'", `path: '${pattern}'`) });
    await assert.rejects(routeTable({ functionsDir: dir }), /is neither a literal nor :name/, pattern);
  }
});

test('U12 wiring identity: the recheck counterexample, consistently miswired, fails on the path', async () => {
  /* Re-based by the E7 mail lane (grant of 2026-09-19): the invitation files carry the mail transport since E7 1.1, so
     the swap is of the route name in the real file's text, and the file still agrees with itself. */
  const text = once(
    real('invitations-create.mjs'),
    'makeRoutes({ alert, mail: mailTransport() }).invitationsCreate',
    'makeRoutes({ alert, mail: mailTransport() }).operatorCompanyCreate',
  );
  const dir = functionsDir({ 'invitations-create.mjs': text });
  const mod = await import(pathToFileURL(join(dir, 'invitations-create.mjs')).href);
  assert.equal(mod.default.routeName, 'operatorCompanyCreate', 'it agrees with itself');
  assert.deepEqual(
    { ...mod.default.route },
    { ...makeRoutes().operatorCompanyCreate.route },
    'and with the table on name and route',
  );
  await assert.rejects(
    routeTable({ functionsDir: dir }),
    /config\.path \/api\/companies\/:companyId\/invitations is not makeRoutes\(\)\.operatorCompanyCreate\.route\.path \/api\/operator\/companies/,
  );
});

/* The bundle critique's mutant, evidence/http-bundle-critique-repro/mutant-tree.diff, as the whole file. */
const SHADOWED = [
  "import { toNetlify } from '../../lib/http/netlify.mjs';",
  "import { makeRoutes as realMakeRoutes } from '../../lib/http/routes.mjs';",
  '',
  'function makeRoutes() {',
  '  const routes = realMakeRoutes();',
  '  const wrong = async (request) => routes.operatorCompanyCreate(request);',
  "  Object.defineProperty(wrong, 'route', { value: routes.invitationsCreate.route, enumerable: true });",
  "  Object.defineProperty(wrong, 'routeName', { value: 'invitationsCreate', enumerable: true });",
  '  return { ...routes, invitationsCreate: wrong };',
  '}',
  '',
  'export default toNetlify(makeRoutes().invitationsCreate);',
  "export const config = { path: '/api/companies/:companyId/invitations', method: 'POST' };",
  '',
].join('\n');

/* The E3b critique's W1 (evidence/e3b-critique.md): the correct adapter wrapped, its route and routeName copied, and
   If-Match stripped from the request while maintenance is open. */
const W1 = [
  "import { toNetlify } from '../../lib/http/netlify.mjs';",
  "import { makeRoutes } from '../../lib/http/routes.mjs';",
  '',
  'const wrapped = toNetlify(makeRoutes().candidatesSave);',
  'const stripped = async (request, context) => {',
  '  const headers = new Headers(request.headers);',
  "  headers.delete('if-match');",
  "  return wrapped(new Request(request, { headers, duplex: 'half' }), context);",
  '};',
  "Object.defineProperty(stripped, 'route', { value: wrapped.route, enumerable: true });",
  "Object.defineProperty(stripped, 'routeName', { value: wrapped.routeName, enumerable: true });",
  '',
  'export default stripped;',
  "export const config = { path: '/api/candidates/:candidateId', method: 'PUT' };",
  '',
].join('\n');

test('U12 HTTP-D4: the shadowed makeRoutes and the wrapper W1 carry correct metadata and are refused by the strict parser', async () => {
  for (const [label, file, text, name] of [
    ['shadowed makeRoutes', 'invitations-create.mjs', SHADOWED, 'invitationsCreate'],
    ['W1', 'candidates-save.mjs', W1, 'candidatesSave'],
  ]) {
    const dir = functionsDir({ [file]: text });
    const mod = await import(pathToFileURL(join(dir, file)).href);
    const declared = makeRoutes()[name].route;
    assert.equal(mod.default.routeName, name, `${label}: routeName looks right`);
    assert.deepEqual({ ...mod.default.route }, { ...declared }, `${label}: route looks right`);
    assert.equal(mod.config.path, declared.path, `${label}: config.path looks right`);
    assert.equal(mod.config.method, declared.method, `${label}: config.method looks right`);
    await assert.rejects(
      routeTable({ functionsDir: dir }),
      new RegExp(`${file.replace('.', '\\.')} does not match the function wiring exactly`),
      label,
    );
  }
  const control = functionsDir({
    'candidates-save.mjs': real('candidates-save.mjs'),
    'invitations-create.mjs': real('invitations-create.mjs'),
  });
  assert.deepEqual(
    (await routeTable({ functionsDir: control })).map((t) => t.name),
    ['candidatesSave', 'invitationsCreate'],
  );
});

/* E7 design 1.1 and case E7-24, added by the E7 mail lane (grant of 2026-09-19): the four invitation routes carry the
   mail transport and no other route may. The plain wiring on an invitation route is the file as it stood before E7,
   which a server in mail mode would have answered with E_MAIL_NOT_CONFIGURED forever; the mail wiring on any other
   route hands a transport to a handler that never sends. Both refuse startup; the four real files are the control. */
test('U12 E7-24: the plain wiring on an invitation route, and the mail wiring on any other route, refuse startup', async () => {
  const beforeE7 = [
    "import { toNetlify } from '../../lib/http/netlify.mjs';",
    "import { makeRoutes } from '../../lib/http/routes.mjs';",
    '',
    'export default toNetlify(makeRoutes().invitationsCreate);',
    "export const config = { path: '/api/companies/:companyId/invitations', method: 'POST' };",
    '',
  ].join('\n');
  await assert.rejects(
    routeTable({ functionsDir: functionsDir({ 'invitations-create.mjs': beforeE7 }) }),
    /invitations-create\.mjs: invitationsCreate is a mail route and must hand makeRoutes the mail transport/,
  );
  const mailedMe = once(
    once(
      real('me.mjs'),
      "import { toNetlify } from '../../lib/http/netlify.mjs';\n",
      "import { alert } from '../../lib/http/alerts.mjs';\nimport { toNetlify } from '../../lib/http/netlify.mjs';\n",
    ),
    "import { makeRoutes } from '../../lib/http/routes.mjs';\n",
    "import { makeRoutes } from '../../lib/http/routes.mjs';\nimport { mailTransport } from '../../lib/services/mail.mjs';\n",
  ).replace('makeRoutes().me)', 'makeRoutes({ alert, mail: mailTransport() }).me)');
  await assert.rejects(
    routeTable({ functionsDir: functionsDir({ 'me.mjs': mailedMe }) }),
    /me\.mjs: me is not a mail route and may not carry the mail transport/,
  );
  /* The alerts design, slice 1: the mail event route is a mail route too, and its file on the plain wiring (which
     would raise no delivery_undeliverable alert, the service reaching the sink only through deps.alert) refuses. */
  const plainEvents = [
    "import { toNetlify } from '../../lib/http/netlify.mjs';",
    "import { makeRoutes } from '../../lib/http/routes.mjs';",
    '',
    'export default toNetlify(makeRoutes().mailEvents);',
    "export const config = { path: '/api/mail/events', method: 'POST' };",
    '',
  ].join('\n');
  await assert.rejects(
    routeTable({ functionsDir: functionsDir({ 'mail-events.mjs': plainEvents }) }),
    /mail-events\.mjs: mailEvents is a mail route and must hand makeRoutes the mail transport/,
  );
  const five = [
    'invitations-create.mjs',
    'invitations-resend.mjs',
    'mail-events.mjs',
    'operator-admin-invitation.mjs',
    'operator-company-create.mjs',
  ];
  const control = await routeTable({ functionsDir: functionsDir(Object.fromEntries(five.map((f) => [f, real(f)]))) });
  assert.deepEqual(control.map((t) => t.name).sort(), [
    'invitationsCreate',
    'invitationsResend',
    'mailEvents',
    'operatorAdminInvitation',
    'operatorCompanyCreate',
  ]);
});

/* The alerts design 1.8: the scheduled template. The real checkin.mjs is accepted, listed apart and never served; a
   scheduled file that also declares a path, one that exports anything more, and one named after another handler are
   each refused at startup, so a scheduled file cannot become an unlisted route or a second wiring. */
test('U12 scheduled: the real check-in file is listed and not served; a changed scheduled file refuses startup', async () => {
  const control = await routeTable({ functionsDir: functionsDir({ 'checkin.mjs': real('checkin.mjs') }) });
  assert.deepEqual(control, []);
  assert.deepEqual(control.scheduled, [{ file: 'checkin.mjs', name: 'checkin', schedule: '0 6 * * *' }]);
  const withPath = once(
    real('checkin.mjs'),
    "{ schedule: '0 6 * * *' }",
    "{ schedule: '0 6 * * *', path: '/api/checkin' }",
  );
  await assert.rejects(
    routeTable({ functionsDir: functionsDir({ 'checkin.mjs': withPath }) }),
    /checkin\.mjs does not match the function wiring exactly/,
  );
  const extra = `${real('checkin.mjs')}export const other = 1;\n`;
  await assert.rejects(
    routeTable({ functionsDir: functionsDir({ 'checkin.mjs': extra }) }),
    /checkin\.mjs does not match the function wiring exactly/,
  );
  await assert.rejects(
    routeTable({ functionsDir: functionsDir({ 'other.mjs': real('checkin.mjs') }) }),
    /other\.mjs: a scheduled function file is named after its handler, checkin\.mjs/,
  );
});

test('U12: the header parser produces a written-out expected header set, stops at the end of a block, and refuses an unknown line', () => {
  const fixture = [
    '# a comment before anything',
    '[build]',
    '  publish = ".site"',
    '',
    '[[headers]]',
    '  for = "/api/*"',
    '  [headers.values]',
    '    Cache-Control = "private, no-store"',
    '',
    '[[headers]]',
    '  # a comment inside a block',
    '  for = "/*"',
    '  [headers.values]',
    '    X-Frame-Options = "DENY"',
    '',
    `    Content-Security-Policy = "default-src 'none'; form-action 'none'"`,
    '',
    '[functions]',
    '  X-Not-A-Header = "read past the block"',
    '',
    '[[headers]]',
    '  for = "/signin/"',
    '  [headers.values]',
    '    X-Frame-Options = "SAMEORIGIN"',
    '',
  ].join('\n');
  const rules = parseHeaderRules(fixture);
  assert.deepEqual(rules, [
    { for: '/api/*', values: [['Cache-Control', 'private, no-store']] },
    {
      for: '/*',
      values: [
        ['X-Frame-Options', 'DENY'],
        ['Content-Security-Policy', "default-src 'none'; form-action 'none'"],
      ],
    },
    { for: '/signin/', values: [['X-Frame-Options', 'SAMEORIGIN']] },
  ]);
  assert.deepEqual(headersFor(rules, '/signin/'), {
    'Content-Security-Policy': "default-src 'none'; form-action 'none'",
    'X-Frame-Options': 'SAMEORIGIN',
  });
  assert.deepEqual(headersFor(rules, '/members/'), {
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; form-action 'none'",
  });
  for (const [label, text, message] of [
    [
      'an unknown line in a block',
      '[[headers]]\n  for = "/*"\n  [headers.values]\n    X-A = "b" # trailing\n',
      /refused inside a header block/,
    ],
    ['a second for line', '[[headers]]\n  for = "/*"\n  for = "/x"\n', /refused inside a header block/],
    [
      'a value before the block has a for line',
      '[[headers]]\n  [headers.values]\n    X-A = "b"\n',
      /before the block's for line/,
    ],
    ['a block ending before its for line', '[[headers]]\n[build]\n', /ends before its for line/],
    ['a wildcard inside a path', '[[headers]]\n  for = "/a/*/b"\n', /not an exact path or a path ending/],
    [
      'an unquoted value',
      '[[headers]]\n  for = "/*"\n  [headers.values]\n    X-A = b\n',
      /refused inside a header block/,
    ],
  ])
    assert.throws(() => parseHeaderRules(text), message, label);
});

const REAL_STATIC_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

test('U12: the real netlify.toml gives a page exactly the written-out header set, and an /api/ answer none of it', async () => {
  const rules = parseHeaderRules(readFileSync(join(REPO, 'netlify.toml'), 'utf8'));
  assert.deepEqual(headersFor(rules, '/members/'), REAL_STATIC_HEADERS);
  const page = await raw(shell.port, 'GET', '/members/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  for (const [name, value] of Object.entries(REAL_STATIC_HEADERS))
    assert.equal(page.headers[name.toLowerCase()], value, name);
  const api = await raw(shell.port, 'GET', '/api/me');
  assert.equal(api.status, 401);
  assert.equal(JSON.parse(api.body).code, 'E_UNAUTHENTICATED');
  for (const name of ['x-frame-options', 'cross-origin-opener-policy', 'permissions-policy'])
    assert.equal(api.headers[name], undefined, `${name} is not on an /api/ answer`);
  assert.equal(api.headers['cache-control'], 'private, no-store', 'the function sets its own');
  /* K5 (evidence/hardening-k.md): the function sets its own policy too, and it is not the page's. */
  assert.equal(
    api.headers['content-security-policy'],
    "default-src 'none'; frame-ancestors 'none'",
    'the function sets its own policy',
  );
});

test('U12: two Set-Cookie values of one answer survive as two headers', async () => {
  const r = await raw(shell.port, 'POST', '/api/auth/refresh', { headers: { origin: shell.origin } });
  assert.equal(r.status, 401);
  assert.equal(r.headers['set-cookie'].length, 2);
  assert.deepEqual(
    r.headers['set-cookie'].map((c) => c.slice(0, c.indexOf('='))),
    ['enterprise_access', 'enterprise_refresh'],
  );
  assert.deepEqual(shell.record.at(-1).setCookies, ['enterprise_access', 'enterprise_refresh']);
});

test('U12: a streamed request body is accepted (duplex half), and a declared one too', async () => {
  const body = '{"tokenHash":"short","type":"magiclink"}';
  for (const [label, options] of [
    [
      'chunked',
      {
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
        chunks: [body.slice(0, 9), body.slice(9)],
      },
    ],
    [
      'declared',
      { headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, body },
    ],
  ]) {
    const r = await raw(shell.port, 'POST', '/api/auth/verify', options);
    assert.equal(r.status, 401, `${label}: ${r.body}`);
    assert.equal(JSON.parse(r.body).code, 'E_AUTH_INVALID', `${label}: the body was read and judged`);
  }
});

test('U12: static paths, slashless pages and content types; a matching path with the wrong method falls through to 404', async () => {
  for (const [path, type] of [
    ['/', 'text/html; charset=utf-8'],
    ['/signin', 'text/html; charset=utf-8'],
    ['/accept', 'text/html; charset=utf-8'],
    ['/accept/', 'text/html; charset=utf-8'],
    ['/assets/app/api.mjs', 'text/javascript; charset=utf-8'],
    ['/assets/enterprise.css', 'text/css; charset=utf-8'],
    ['/assets/vendor/fonts/dm-mono-latin-400-normal.woff2', 'font/woff2'],
    ['/assets/vendor/fonts/OFL.txt', 'text/plain; charset=utf-8'],
  ]) {
    const r = await raw(shell.port, 'GET', path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers['content-type'], type, path);
  }
  assert.equal((await raw(shell.port, 'HEAD', '/')).status, 200);
  assert.equal((await raw(shell.port, 'POST', '/')).status, 404);
  assert.equal((await raw(shell.port, 'DELETE', '/api/me')).status, 404);
  assert.equal((await raw(shell.port, 'GET', '/api/unknown')).status, 404);
  assert.equal((await raw(shell.port, 'GET', '/unknown/')).status, 404);
});

test('U12: traversal, encoded traversal, an encoded separator, a symbolic link, an unbuilt file and an absolute-form request answer 404', async () => {
  const dir = temporary('u12-contain-');
  const own = await startShell({
    stack: false,
    siteDir: join(dir, 'site'),
    manifestPath: join(dir, 'site-manifest.json'),
  });
  /* A page beside the served tree, of a type the shell serves, so a traversal that escaped the root would find something
     to answer with; package.json alone is a type the shell never serves, which proved nothing about containment. */
  writeFileSync(join(dir, 'outside.html'), '<!doctype html><title>outside the build</title>');
  try {
    for (const path of [
      '/../outside.html',
      '/assets/../../outside.html',
      '/%2e%2e/outside.html',
      '/assets/%2e%2e/%2e%2e/outside.html',
      '/../package.json',
      '/assets/../../package.json',
      '/%2e%2e/package.json',
      '/assets/%2e%2e/%2e%2e/package.json',
      '/assets%2fapp%2fapi.mjs',
      '/assets%5capp%5capi.mjs',
      '/index.html%00',
      '//etc/passwd',
      `http://127.0.0.1:${own.port}/index.html`,
    ])
      assert.equal((await raw(own.port, 'GET', path)).status, 404, path);
    assert.equal((await raw(own.port, 'GET', '/assets/enterprise.css')).status, 200, 'control before the link');
    rmSync(join(dir, 'site', 'assets', 'enterprise.css'));
    symlinkSync(join(REPO, 'web', 'assets', 'enterprise.css'), join(dir, 'site', 'assets', 'enterprise.css'));
    assert.equal(
      (await raw(own.port, 'GET', '/assets/enterprise.css')).status,
      404,
      'a symbolic link, even to the same bytes',
    );
    cpSync(join(dir, 'site', 'index.html'), join(dir, 'site', 'stale.html'));
    assert.equal((await raw(own.port, 'GET', '/stale.html')).status, 404, 'a file the manifest does not name');
    writeFileSync(join(dir, 'site', 'signin', 'index.html'), 'changed after the build');
    assert.equal((await raw(own.port, 'GET', '/signin/')).status, 404, 'a file whose bytes differ from the manifest');
  } finally {
    await own.close();
  }
});

test('U12: the shell refuses any host but 127.0.0.1 and a closed switch answers 503 before a route runs', async () => {
  for (const host of ['0.0.0.0', 'localhost', '::1', '192.168.1.2'])
    await assert.rejects(startShell({ host, stack: false }), /refused host/, host);
  const dir = temporary('u12-closed-');
  const closed = await startShell({
    stack: false,
    closed: true,
    siteDir: join(dir, 'site'),
    manifestPath: join(dir, 'site-manifest.json'),
  });
  try {
    const r = await raw(closed.port, 'GET', '/api/me');
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.body).code, 'E_MAINTENANCE');
    assert.equal((await raw(closed.port, 'GET', '/')).status, 200, 'static pages are still served');
  } finally {
    await closed.close();
    process.env.ENTERPRISE_ACCESS_STATE = 'open';
  }
});

test('E7M-C-F3: a startup the wiring refuses leaves no catcher listening, no mail environment and the global fetch as it was', async () => {
  /* The critique's counterexample (evidence/e7-mail-critique-repro/catcher-startup.mjs.txt): invitations-create.mjs
     without the mail transport, which startShell refuses after it has started the catcher. Before E8 day 5 the
     catcher stayed listening for a caller that caught the rejection and lived on (evidence/e8-surface-repro/
     e7m-c-f3-fail-before.log). The count is of this process's loopback listeners, so the file's own shell is in both. */
  const loopback = () =>
    process._getActiveHandles().filter((h) => typeof h?.address === 'function' && h.address()?.address === '127.0.0.1')
      .length;
  const bad = functionsDir({
    'invitations-create.mjs': once(
      once(real('invitations-create.mjs'), "import { mailTransport } from '../../lib/services/mail.mjs';\n", ''),
      'makeRoutes({ alert, mail: mailTransport() })',
      'makeRoutes()',
    ),
  });
  const dir = temporary('u12-refused-');
  const before = { listeners: loopback(), fetch: globalThis.fetch, endpoint: process.env.ENTERPRISE_MAIL_ENDPOINT };
  await assert.rejects(
    startShell({
      stack: false,
      functionsDir: bad,
      siteDir: join(dir, 'site'),
      manifestPath: join(dir, 'site-manifest.json'),
    }),
    /does not match the function wiring exactly/,
  );
  assert.equal(loopback(), before.listeners, 'no listener left behind by the refused startup');
  assert.equal(globalThis.fetch, before.fetch, 'the global fetch as it was');
  assert.equal(process.env.ENTERPRISE_MAIL_ENDPOINT, before.endpoint, 'the mail environment as it was');
});
