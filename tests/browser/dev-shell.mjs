/* The local development shell for browser journeys (pages design section 5, revision 7). Test-only: it lives under
   tests/ so nothing publishes it, and it stands in for nothing Netlify does. Every behaviour here that Netlify also
   has (slashless paths, header application, method routing, content types) is a hosted observation (design 8.4).

   Binding. 127.0.0.1 and port 0, so the operating system picks a free port; any other host is refused before a socket
   opens. The origin it reports is http://127.0.0.1:<port>, and ENTERPRISE_ORIGIN is set to exactly that.

   Static files. Before listening it builds with scripts/build-site.mjs --clean --out .scratch/site and verifies the
   output against the manifest in both directions, so it serves what the build would publish and never a leftover of
   an earlier run (4.6). GET and HEAD only. /x/ and /x both answer x/index.html without a redirect. Containment: the
   request target must be an origin-form path; it is decoded once; a path holding an encoded separator, a . or ..
   segment after decoding, a backslash or a NUL is refused; the result is resolved against the real path of the output
   root and refused unless it is the root or below it; the file is lstat'ed and refused unless it is a regular file
   whose real path is itself, named in the manifest, with the manifest's SHA-256. Every refusal is 404. Content types
   as section 5 lists them; anything else is not served.

   Headers. parseHeaderRules() reads netlify.toml: it accepts [[headers]], for = "...", [headers.values] and
   Name = "value" lines inside header blocks, ignores comments and blank lines, leaves a header block when any other
   table begins, and refuses anything else inside a header block, a block without a for line, and a for pattern that is
   not an exact path or a path ending /*. Matching rules apply in file order to static answers only, never to /api/
   answers (O10), so a header a function forgets is seen missing.

   API routes, and HTTP-D4's strict parser. The route table is derived from netlify/functions/*.mjs and never written a
   second time. Each file must equal WIRING, the five-line function wiring, byte for byte apart from the route name, the
   path and the method; a file that differs in any other byte is refused at startup, which is what refuses a locally
   shadowed makeRoutes (evidence/http-bundle-critique-repro/mutant-tree.diff) and a wrapper that copies route and
   routeName onto a function of its own (W1, evidence/e3b-critique.md). Since E7 (design 1.1, case E7-24) the four
   invitation routes, MAIL_ROUTES, hand makeRoutes the mail transport and, since day 6, the alert sink, so they must
   equal MAIL_WIRING instead, the same text with two more import lines and makeRoutes({ alert, mail: mailTransport() });
   since the alerts design (slice 1, section 7) MAIL_ROUTES holds the mail event route too, whose service raises the
   operator's delivery_undeliverable alert through that sink. MAIL_WIRING is refused for any other route, and WIRING
   is refused for those five, so a function file that forgets either one fails startup rather than answering
   E_MAIL_NOT_CONFIGURED, or silently raising no alert, in production. A scheduled function (the check-in, the alerts
   design 1.8) has no path and serves no request: its file must equal SCHEDULED_WIRING, one import of a handler
   factory from lib/http/, its call as the default and a config holding a schedule and nothing else; it is checked at
   startup and listed in `shell.scheduled`, and never served. For a route file that matches, the shell imports it
   and refuses startup unless: the parsed name is a key of makeRoutes(); the default export's routeName is that name;
   its route deep-equals makeRoutes()[name].route; config.path holds only literal and :name segments; config.path and
   config.method equal that route's own path and method (the consistently miswired file fails here, on the path); and
   no two files share a path and method. The handler served is toNetlify(makeRoutes({ deliver, log })[name]), so the
   adapter's maintenance check and bounded body read run as deployed. A request whose path matches a route but whose
   method does not falls through to the static files and answers 404. The web Request is built from the Node request
   with the body as a stream, which needs duplex: 'half'; every Set-Cookie of the answer is written separately.

   Environment. loadStack() reads the local stack the way tests/e2/helpers/stack.mjs does, into process.env and
   nowhere else; nothing here prints it. ENTERPRISE_ACCESS_STATE is open, or closed_restore with closed: true.

   Mail (E7 design 1.1). The shell starts tests/e7/mail-catcher.mjs on its own loopback port, points the transport's
   environment at it and serves the four invitation routes through the REAL transport, exactly as the function files
   build them: makeRoutes({ mail: mailTransport() }). `shell.mail` is that catcher, so a journey reads the message a
   person would have received and can instruct the provider to refuse, hang or drop. The `deliver` capture that stood
   here before is retired rather than pointed at the catcher: it was the seam that skips the transport and the
   templates, which is exactly what `mail` mode has to exercise, and nothing read it. Whether a request mails at all
   is still ENTERPRISE_INVITATION_DELIVERY, which lib/services/invitations.mjs reads per request, so a journey may set
   it for its own steps; in `handover` the catcher simply receives nothing. The key and the sender are synthetic.

   Record. Each /api/ answer is recorded with its method, path, route name, status, error code, the names of the
   cookies it set (never a value), its Sec-Fetch-Site and whether it carried an Origin, and the provider calls made
   while it ran, each as a method and a URL path with no query (attributed through AsyncLocalStorage around the global
   fetch). The pipeline's log lines are kept in memory.

   The shared stack. The shell never starts, stops, resets or restarts it.

   Exported: startShell(options), parseHeaderRules(text), headersFor(rules, path), routeTable(options), WIRING,
   MAIL_WIRING, MAIL_ROUTES, SCHEDULED_WIRING. `shell.alerts` holds the alerts the run raised through the mail routes'
   sink.
   Command line: node tests/browser/dev-shell.mjs [--closed] prints the origin and serves until interrupted. */

import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { verifyOutput } from '../../scripts/build-site.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LOOPBACK = '127.0.0.1';

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
});
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer']);

/** The function wiring every file under netlify/functions/ has, with its three variable parts captured. */
export const WIRING =
  /^import \{ toNetlify \} from '\.\.\/\.\.\/lib\/http\/netlify\.mjs';\nimport \{ makeRoutes \} from '\.\.\/\.\.\/lib\/http\/routes\.mjs';\n\nexport default toNetlify\(makeRoutes\(\)\.([A-Za-z][A-Za-z0-9]*)\);\nexport const config = \{ path: '([^'\n]*)', method: '([A-Z]+)' \};\n$/;

/** The four invitation routes (E7 design 1.1) and the mail event route (the alerts design, slice 1): the only files
    that hand makeRoutes the mail transport and the alert sink, and the only files MAIL_WIRING admits. */
export const MAIL_ROUTES = Object.freeze([
  'invitationsCreate',
  'invitationsResend',
  'operatorAdminInvitation',
  'operatorCompanyCreate',
  'mailEvents',
]);

/** WIRING with the mail transport and the alert sink: two more import lines and makeRoutes({ alert, mail:
    mailTransport() }), nothing else. E7 day 6 added `alert`, which lib/services/invitations.mjs can only raise through
    deps.alert (design 2.4 forbids lib/services/ importing lib/http/alerts.mjs); the pipeline's and the adapter's own
    alerts need no wiring line, because they call the module's alert() directly. */
export const MAIL_WIRING =
  /^import \{ alert \} from '\.\.\/\.\.\/lib\/http\/alerts\.mjs';\nimport \{ toNetlify \} from '\.\.\/\.\.\/lib\/http\/netlify\.mjs';\nimport \{ makeRoutes \} from '\.\.\/\.\.\/lib\/http\/routes\.mjs';\nimport \{ mailTransport \} from '\.\.\/\.\.\/lib\/services\/mail\.mjs';\n\nexport default toNetlify\(makeRoutes\(\{ alert, mail: mailTransport\(\) \}\)\.([A-Za-z][A-Za-z0-9]*)\);\nexport const config = \{ path: '([^'\n]*)', method: '([A-Z]+)' \};\n$/;

/** A scheduled function (the alerts design 1.8): the handler factory `<name>Handler` of lib/http/<name>.mjs, called
    as the default, and a config holding a cron schedule and no path. Captures the name and the schedule. */
export const SCHEDULED_WIRING =
  /^import \{ ([a-z][a-z]*)Handler \} from '\.\.\/\.\.\/lib\/http\/\1\.mjs';\n\nexport default \1Handler\(\);\nexport const config = \{ schedule: '([0-9*]+ [0-9*]+ [0-9*]+ [0-9*]+ [0-9*]+)' \};\n$/;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/* ---------- netlify.toml headers ---------- */

/** parseHeaderRules(text) -> [{ for, values: [[name, value]] }] in file order; throws naming the line it refuses. */
export function parseHeaderRules(text) {
  const rules = [];
  let block = null;
  let inValues = false;
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    const where = `netlify.toml line ${index + 1}`;
    if (line === '' || line.startsWith('#')) return;
    if (line === '[[headers]]') {
      if (block && block.for === null) throw new Error(`${where}: a header block ends before its for line`);
      block = { for: null, values: [] };
      rules.push(block);
      inValues = false;
      return;
    }
    if (line.startsWith('[')) {
      if (block && line === '[headers.values]' && !inValues) {
        if (block.for === null) throw new Error(`${where}: [headers.values] before the block's for line`);
        inValues = true;
        return;
      }
      if (block && block.for === null) throw new Error(`${where}: a header block ends before its for line`);
      block = null;
      inValues = false;
      return;
    }
    if (!block) return;
    if (!inValues) {
      const m = /^for\s*=\s*"([^"]*)"$/.exec(line);
      if (!m || block.for !== null) throw new Error(`${where}: refused inside a header block: ${line}`);
      if (!/^\/[^*]*(?:\/\*)?$/.test(m[1]) && m[1] !== '/*')
        throw new Error(`${where}: a for pattern that is not an exact path or a path ending /*`);
      block.for = m[1];
      return;
    }
    const m = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*"([^"]*)"$/.exec(line);
    if (!m) throw new Error(`${where}: refused inside a header block: ${line}`);
    block.values.push([m[1], m[2]]);
  });
  if (block && block.for === null) throw new Error('netlify.toml: the last header block has no for line');
  return rules;
}

/** headersFor(rules, path) -> { name: value }: every matching rule in file order, a later value replacing an earlier
    one of the same name. */
export function headersFor(rules, path) {
  const out = new Map();
  for (const rule of rules) {
    const matches = rule.for.endsWith('/*') ? path.startsWith(rule.for.slice(0, -1)) : path === rule.for;
    if (!matches) continue;
    for (const [name, value] of rule.values) {
      for (const existing of out.keys()) if (existing.toLowerCase() === name.toLowerCase()) out.delete(existing);
      out.set(name, value);
    }
  }
  return Object.fromEntries(out);
}

/* ---------- the route table ---------- */

function patternSegments(file, path) {
  if (typeof path !== 'string' || !path.startsWith('/'))
    throw new Error(`dev shell: ${file}: config.path does not start with /`);
  return path
    .slice(1)
    .split('/')
    .map((segment) => {
      if (/^[a-z0-9][a-z0-9-]*$/.test(segment)) return { literal: segment };
      if (/^:[A-Za-z][A-Za-z0-9]*$/.test(segment)) return { param: segment.slice(1) };
      throw new Error(`dev shell: ${file}: path segment ${JSON.stringify(segment)} is neither a literal nor :name`);
    });
}

/** routeTable({ functionsDir, mail, log, alert }) -> [{ file, name, path, method, segments, handler }], with the
    scheduled files as `table.scheduled` ([{ file, name, schedule }]); throws at the first file it refuses. */
export async function routeTable({ functionsDir = join(ROOT, 'netlify', 'functions'), mail, log, alert } = {}) {
  const { makeRoutes } = await import(pathToFileURL(join(ROOT, 'lib', 'http', 'routes.mjs')).href);
  const { toNetlify } = await import(pathToFileURL(join(ROOT, 'lib', 'http', 'netlify.mjs')).href);
  const declared = makeRoutes();
  const serving = makeRoutes({ mail, log, alert });
  const table = [];
  const scheduled = [];
  for (const file of readdirSync(functionsDir).sort()) {
    if (!file.endsWith('.mjs')) continue;
    const path = join(functionsDir, file);
    if (!lstatSync(path).isFile()) throw new Error(`dev shell: ${file} is not a regular file`);
    const text = readFileSync(path, 'utf8');
    const timed = SCHEDULED_WIRING.exec(text);
    if (timed) {
      const [, name, schedule] = timed;
      if (file !== `${name}.mjs`) throw new Error(`dev shell: ${file}: a scheduled function file is named after its handler, ${name}.mjs`);
      const mod = await import(pathToFileURL(path).href);
      if (typeof mod.default !== 'function') throw new Error(`dev shell: ${file}: the default export is not a function`);
      if (!isDeepStrictEqual({ ...mod.config }, { schedule }))
        throw new Error(`dev shell: ${file}: the imported config differs from the file's text`);
      scheduled.push({ file, name, schedule });
      continue;
    }
    const plain = WIRING.exec(text);
    const mailed = plain ? null : MAIL_WIRING.exec(text);
    const wiring = plain ?? mailed;
    if (!wiring) throw new Error(`dev shell: ${file} does not match the function wiring exactly`);
    const [, name, textPath, textMethod] = wiring;
    if (mailed && !MAIL_ROUTES.includes(name))
      throw new Error(`dev shell: ${file}: ${name} is not a mail route and may not carry the mail transport`);
    if (plain && MAIL_ROUTES.includes(name))
      throw new Error(`dev shell: ${file}: ${name} is a mail route and must hand makeRoutes the mail transport`);
    if (!Object.hasOwn(declared, name)) throw new Error(`dev shell: ${file}: makeRoutes() has no route ${name}`);
    const mod = await import(pathToFileURL(path).href);
    const route = declared[name].route;
    if (mod.default?.routeName !== name)
      throw new Error(`dev shell: ${file}: the default export's routeName is not ${name}`);
    if (!isDeepStrictEqual({ ...mod.default.route }, { ...route }))
      throw new Error(`dev shell: ${file}: the default export's route differs from makeRoutes().${name}.route`);
    if (mod.config?.path !== textPath || mod.config?.method !== textMethod)
      throw new Error(`dev shell: ${file}: the imported config differs from the file's text`);
    const segments = patternSegments(file, mod.config.path);
    if (mod.config.path !== route.path)
      throw new Error(`dev shell: ${file}: config.path ${mod.config.path} is not makeRoutes().${name}.route.path ${route.path}`);
    if (mod.config.method !== route.method)
      throw new Error(`dev shell: ${file}: config.method ${mod.config.method} is not makeRoutes().${name}.route.method ${route.method}`);
    const twin = table.find((t) => t.path === mod.config.path && t.method === mod.config.method);
    if (twin) throw new Error(`dev shell: ${file} and ${twin.file} both declare ${mod.config.method} ${mod.config.path}`);
    table.push({ file, name, path: mod.config.path, method: mod.config.method, segments, handler: toNetlify(serving[name]) });
  }
  Object.defineProperty(table, 'scheduled', { value: Object.freeze(scheduled), enumerable: false });
  return table;
}

function matchRoute(table, method, rawPath) {
  const parts = rawPath.slice(1).split('/');
  for (const entry of table) {
    if (entry.method !== method || entry.segments.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length && ok; i++) {
      const s = entry.segments[i];
      if (s.literal !== undefined) ok = parts[i] === s.literal;
      else {
        try {
          params[s.param] = decodeURIComponent(parts[i]);
        } catch {
          ok = false;
        }
        ok = ok && parts[i].length > 0;
      }
    }
    if (ok) return { entry, params };
  }
  return null;
}

/* ---------- static files ---------- */

function staticFile(siteRoot, files, rawPath) {
  if (!rawPath.startsWith('/') || rawPath.startsWith('//')) return null;
  if (/%(?:2f|5c|00)/i.test(rawPath)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  if (decoded.split('/').some((s) => s === '.' || s === '..')) return null;
  const rel = decoded.slice(1);
  const candidates = rel === '' || rel.endsWith('/') ? [`${rel}index.html`] : [rel, `${rel}/index.html`];
  for (const candidate of candidates) {
    const abs = resolve(siteRoot, candidate);
    if (!(abs === siteRoot || abs.startsWith(siteRoot + sep))) continue;
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile() || realpathSync(abs) !== abs) continue;
    const key = abs.slice(siteRoot.length + 1).split(sep).join('/');
    if (!files.has(key)) continue;
    const type = CONTENT_TYPES[extname(abs)];
    if (!type) continue;
    const bytes = readFileSync(abs);
    if (sha256(bytes) !== files.get(key)) continue;
    return { key, bytes, type };
  }
  return null;
}

/* ---------- environment ---------- */

/** The local stack's configuration into process.env, as tests/e2/helpers/stack.mjs loads it; nothing is printed. */
export async function loadStack() {
  const { stackEnv } = await import(pathToFileURL(join(ROOT, 'tests', 'e2', 'helpers', 'stack.mjs')).href);
  stackEnv();
}

/* ---------- the server ---------- */

/**
 * startShell({ host, closed, stack, siteDir, manifestPath, build, functionsDir, netlifyToml })
 *   -> { origin, port, mail (the catcher), record, logs, url(path), close() }
 * host must be 127.0.0.1. stack: false skips the stack configuration (unit tests). build: false serves an existing
 * output, verified against its manifest all the same (journey J17's scratch copy).
 */
export async function startShell({
  host = LOOPBACK,
  closed = false,
  stack = true,
  siteDir = join(ROOT, '.scratch', 'site'),
  manifestPath = join(ROOT, '.scratch', 'site-manifest.json'),
  build = true,
  functionsDir,
  netlifyToml = join(ROOT, 'netlify.toml'),
} = {}) {
  if (host !== LOOPBACK) throw new Error(`dev shell: refused host ${host}; the shell binds ${LOOPBACK} only`);
  if (stack) await loadStack();
  if (build) {
    const built = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'build-site.mjs'), '--clean', '--out', siteDir, '--manifest', manifestPath],
      { encoding: 'utf8' },
    );
    if (built.status !== 0) throw new Error(`dev shell: the site build failed\n${built.stdout}${built.stderr}`);
  }
  const verified = verifyOutput(siteDir, manifestPath);
  if (verified.problems.length)
    throw new Error(`dev shell: the output does not match its manifest: ${JSON.stringify(verified.problems)}`);
  const siteRoot = realpathSync(siteDir);
  const rules = parseHeaderRules(readFileSync(netlifyToml, 'utf8'));

  const record = [];
  const logs = [];
  /* The alert sink as a capture (E7 design 1.5, case E7-22): a journey reads the alerts a run raised and can assert
     that a refusal raised none. It is the seam the four function files fill with the module's own alert() in
     production; here nothing is sent anywhere. */
  const alerts = [];
  /* The catcher and the real transport, as the four function files build it (E7 1.1). */
  const { mailTransport } = await import(pathToFileURL(join(ROOT, 'lib', 'services', 'mail.mjs')).href);
  const { startCatcher } = await import(pathToFileURL(join(ROOT, 'tests', 'e7', 'mail-catcher.mjs')).href);
  const mail = await startCatcher();
  /* E7M-C-F3 (evidence/e7-mail-critique.md): from here on startup can still be refused, by a function file that fails
     the wiring or by a listen that fails, and a caller that catches the rejection and stays alive (a test, an embedded
     shell) must not be left with the catcher listening, its environment pointing at it or the global fetch replaced.
     `undo` puts all three back; it runs only on a refusal, and close() does the same work for a shell that started. */
  const envBefore = Object.fromEntries(Object.keys(mail.env()).map((k) => [k, process.env[k]]));
  let fetchBefore = null;
  const undo = async () => {
    if (fetchBefore) globalThis.fetch = fetchBefore;
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await mail.close().catch(() => undefined);
  };
  Object.assign(process.env, mail.env());
  let table;
  try {
    table = await routeTable({
      functionsDir,
      mail: mailTransport(),
      log: (entry) => {
        logs.push(entry);
      },
      alert: async (event, fields) => {
        alerts.push({ event, fields });
      },
    });
  } catch (e) {
    await undo();
    throw e;
  }

  const attribution = new AsyncLocalStorage();
  const realFetch = globalThis.fetch;
  fetchBefore = realFetch;
  globalThis.fetch = (input, init) => {
    const entry = attribution.getStore();
    if (entry) {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      entry.provider.push(`${init?.method ?? input?.method ?? 'GET'} ${url.pathname}`);
    }
    return realFetch(input, init);
  };

  let origin = null;
  const answerApi = async (req, res, rawPath, hit) => {
    const entry = {
      method: req.method,
      path: rawPath,
      route: hit.entry.name,
      status: null,
      code: null,
      setCookies: [],
      fetchSite: req.headers['sec-fetch-site'] ?? null,
      origin: req.headers.origin === undefined ? 'absent' : req.headers.origin === origin ? 'same' : 'foreign',
      provider: [],
    };
    record.push(entry);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(name) || value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    let response;
    try {
      const request = new Request(`${origin}${req.url}`, {
        method: req.method,
        headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? 'half' : undefined,
      });
      response = await attribution.run(entry, () => hit.entry.handler(request, { params: hit.params, ip: LOOPBACK }));
    } catch (e) {
      entry.status = 500;
      entry.code = `shell:${e?.name ?? 'Error'}`;
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('dev shell: the request could not be handed to the route');
    }
    const body = Buffer.from(await response.arrayBuffer());
    entry.status = response.status;
    if (response.status >= 400) {
      try {
        entry.code = JSON.parse(body.toString('utf8')).code ?? null;
      } catch {
        entry.code = null;
      }
    }
    const out = {};
    for (const [name, value] of response.headers) if (name !== 'set-cookie') out[name] = value;
    const cookies = response.headers.getSetCookie();
    entry.setCookies = cookies.map((c) => c.slice(0, c.indexOf('=')));
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(response.status, out);
    res.end(body);
  };

  const server = createServer(async (req, res) => {
    const target = req.url ?? '';
    const q = target.indexOf('?');
    const rawPath = q === -1 ? target : target.slice(0, q);
    if (rawPath.startsWith('/api/')) {
      const hit = matchRoute(table, req.method, rawPath);
      if (hit) return answerApi(req, res, rawPath, hit);
    }
    const file = req.method === 'GET' || req.method === 'HEAD' ? staticFile(siteRoot, verified.files, rawPath) : null;
    if (!file) {
      if (rawPath.startsWith('/api/')) record.push({ method: req.method, path: rawPath, route: null, status: 404, code: null, setCookies: [], fetchSite: req.headers['sec-fetch-site'] ?? null, origin: req.headers.origin === undefined ? 'absent' : 'present', provider: [] });
      req.resume();
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not here.');
    }
    res.writeHead(200, { ...headersFor(rules, rawPath), 'content-type': file.type, 'content-length': file.bytes.length });
    res.end(req.method === 'HEAD' ? undefined : file.bytes);
  });

  try {
    await new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(0, LOOPBACK, ok);
    });
  } catch (e) {
    await undo();
    throw e;
  }
  const { port } = server.address();
  origin = `http://${LOOPBACK}:${port}`;
  process.env.ENTERPRISE_ORIGIN = origin;
  process.env.ENTERPRISE_ACCESS_STATE = closed ? 'closed_restore' : 'open';

  return {
    origin,
    port,
    mail,
    record,
    logs,
    alerts,
    table,
    scheduled: table.scheduled,
    url: (path) => `${origin}${path}`,
    close: async () => {
      await mail.close();
      await new Promise((ok) => {
        globalThis.fetch = realFetch;
        server.close(() => ok());
        server.closeAllConnections();
      });
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const shell = await startShell({ closed: process.argv.includes('--closed') });
  process.stdout.write(`dev shell: ${shell.origin} (${process.env.ENTERPRISE_ACCESS_STATE}); interrupt to stop\n`);
  process.on('SIGINT', () => shell.close().then(() => process.exit(0)));
}
