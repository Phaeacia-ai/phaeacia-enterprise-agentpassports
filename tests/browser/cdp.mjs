/* Headless Chrome over the DevTools protocol, with Node's built-in WebSocket and no dependency (pages design section 6).

   Each identity gets its own Chrome process and scratch profile, so sessions never share a cookie jar; two tabs of one
   identity are two targets of one process. Pages open through Target.createTarget and Target.attachToTarget with
   flatten. Two viewports: desktop 1280 by 800 at scale 1, and phone 390 by 844 at scale 2 with mobile emulation,
   applied again after every navigation because an override set before a navigation did not survive it in E1b.

   What a page records, from the moment it is attached: every request (Network.requestWillBeSent), with its initiator,
   the cookies the browser attached or blocked (names and reasons only, from requestWillBeSentExtraInfo), its status,
   the names of the cookies its answer set, and, for an /api/ answer of 400 or more, the error code read from the body;
   a success body is never read, because an enrolment answer carries the setup key. Main-frame document requests in
   order, with their fragments. Content-Security-Policy and Trusted Types violations through a securitypolicyviolation
   listener installed on every new document and reported through Runtime.addBinding; pageshow events with persisted;
   uncaught exceptions; console errors; log entries at level error; back-forward cache refusals. Cookies are observed
   through Network.getCookies and reduced to name and attributes before anything else sees them; a value is never
   read, compared, logged or written. captureCookies() and restoreCookies() hold whole cookies for the J11 and J12
   arms that restore a session, in memory only.

   Exported: launch({ name, profileDir }), DESKTOP, PHONE. */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

export const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const DESKTOP = Object.freeze({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
export const PHONE = Object.freeze({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

const BINDING = '__journeyReport';
const INIT_SCRIPT = `(() => {
  const report = globalThis.${BINDING};
  if (typeof report !== 'function') return;
  document.addEventListener('securitypolicyviolation', (e) => {
    report(JSON.stringify({ kind: 'csp', directive: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 80), source: e.sourceFile, line: e.lineNumber, page: location.pathname }));
  });
  addEventListener('pageshow', (e) => {
    report(JSON.stringify({ kind: 'pageshow', persisted: e.persisted, page: location.pathname }));
  });
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Connection {
  static open(url) {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => ok(new Connection(ws)), { once: true });
      ws.addEventListener('error', () => fail(new Error('the DevTools socket did not open')), { once: true });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => this.receive(JSON.parse(String(event.data))));
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.fail(new Error(`the DevTools socket closed during ${p.method}`));
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = ++this.next;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail, method });
      this.ws.send(JSON.stringify(message));
    });
  }

  on(sessionId, method, listener) {
    const key = `${sessionId ?? ''}|${method}`;
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key).push(listener);
  }

  receive(message) {
    if (message.id !== undefined) {
      const p = this.pending.get(message.id);
      if (!p) return;
      this.pending.delete(message.id);
      if (message.error) p.fail(new Error(`${p.method}: ${message.error.message}`));
      else p.ok(message.result);
      return;
    }
    for (const listener of this.listeners.get(`${message.sessionId ?? ''}|${message.method}`) ?? []) listener(message.params);
  }
}

const cookieShape = (c) => ({
  name: c.name,
  domain: c.domain,
  path: c.path,
  httpOnly: c.httpOnly,
  secure: c.secure,
  sameSite: c.sameSite ?? null,
  session: c.session,
});

export class Page {
  constructor(browser, targetId, sessionId, label) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.label = label;
    this.viewport = DESKTOP;
    this.requests = [];
    this.byId = new Map();
    this.earlyExtras = new Map();
    this.documents = [];
    this.events = [];
    this.violations = [];
    this.pageshows = [];
    this.exceptions = [];
    this.consoleErrors = [];
    this.logErrors = [];
    this.bfcacheRefusals = [];
    this.bodyReads = [];
    this.mainFrame = null;
    this.loads = 0;
  }

  send(method, params = {}) {
    return this.browser.conn.send(method, params, this.sessionId);
  }

  on(method, listener) {
    this.browser.conn.on(this.sessionId, method, listener);
  }

  async init() {
    this.on('Network.requestWillBeSent', (p) => {
      const entry = {
        id: p.requestId,
        url: p.request.url,
        fragment: p.request.urlFragment ?? '',
        method: p.request.method,
        type: p.type,
        frameId: p.frameId,
        initiator: p.initiator,
        referer: p.request.headers?.Referer ?? p.request.headers?.referer ?? null,
        at: this.events.length,
        status: null,
        code: null,
        sentCookies: null,
        blockedCookies: null,
        setCookieNames: null,
        failed: null,
      };
      const early = this.earlyExtras.get(p.requestId);
      if (early) {
        entry.sentCookies = early.sent;
        entry.blockedCookies = early.blocked;
        this.earlyExtras.delete(p.requestId);
      }
      this.requests.push(entry);
      this.byId.set(p.requestId, entry);
      this.events.push({ kind: 'request', method: entry.method, url: entry.url });
      if (p.type === 'Document' && (!this.mainFrame || p.frameId === this.mainFrame))
        this.documents.push({ url: entry.url, fragment: entry.fragment, at: this.events.length - 1 });
    });
    this.on('Network.requestWillBeSentExtraInfo', (p) => {
      const entry = this.byId.get(p.requestId);
      const associated = p.associatedCookies ?? [];
      const sent = associated.filter((a) => (a.blockedReasons ?? []).length === 0).map((a) => a.cookie.name);
      const blocked = associated.filter((a) => (a.blockedReasons ?? []).length > 0).map((a) => ({ name: a.cookie.name, reasons: a.blockedReasons }));
      /* Chrome may send this event before requestWillBeSent for the same request; it is held until that arrives. */
      if (entry && entry.sentCookies === null) {
        entry.sentCookies = sent;
        entry.blockedCookies = blocked;
      } else this.earlyExtras.set(p.requestId, { sent, blocked });
    });
    this.on('Network.responseReceived', (p) => {
      const entry = this.byId.get(p.requestId);
      if (!entry) return;
      entry.status = p.response.status;
      this.events.push({ kind: 'response', method: entry.method, url: entry.url, status: entry.status });
    });
    this.on('Network.responseReceivedExtraInfo', (p) => {
      const entry = this.byId.get(p.requestId);
      const names = [];
      for (const [name, value] of Object.entries(p.headers ?? {}))
        if (name.toLowerCase() === 'set-cookie') for (const line of String(value).split('\n')) names.push(line.slice(0, line.indexOf('=')));
      if (entry) entry.setCookieNames = names;
    });
    this.on('Network.loadingFinished', (p) => {
      const entry = this.byId.get(p.requestId);
      if (!entry) return;
      entry.encodedDataLength = p.encodedDataLength;
      if (entry.status >= 400 && new URL(entry.url).pathname.startsWith('/api/')) {
        this.bodyReads.push(
          this.send('Network.getResponseBody', { requestId: p.requestId })
            .then((r) => {
              entry.errorText = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
              entry.code = JSON.parse(entry.errorText).code ?? null;
            })
            .catch(() => {
              entry.code = entry.code ?? 'unreadable';
            }),
        );
      }
    });
    this.on('Network.loadingFailed', (p) => {
      const entry = this.byId.get(p.requestId);
      if (entry) entry.failed = { errorText: p.errorText, blockedReason: p.blockedReason ?? null, canceled: p.canceled ?? false };
    });
    this.on('Page.frameNavigated', (p) => {
      if (!p.frame.parentId) this.events.push({ kind: 'frameNavigated', url: p.frame.url });
    });
    this.on('Page.navigatedWithinDocument', (p) => {
      if (p.frameId === this.mainFrame) this.events.push({ kind: 'navigatedWithinDocument', url: p.url, type: p.navigationType ?? null });
    });
    this.on('Page.loadEventFired', () => {
      this.loads += 1;
    });
    this.on('Page.backForwardCacheNotUsed', (p) => {
      this.bfcacheRefusals.push((p.notRestoredExplanations ?? []).map((e) => e.reason));
    });
    this.on('Runtime.bindingCalled', (p) => {
      if (p.name !== BINDING) return;
      const report = JSON.parse(p.payload);
      if (report.kind === 'csp') this.violations.push(report);
      if (report.kind === 'pageshow') this.pageshows.push(report);
      this.events.push({ kind: report.kind, ...report });
    });
    this.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails;
      this.exceptions.push({ text: d.text, description: d.exception?.description?.split('\n')[0] ?? null, url: d.url ?? null });
    });
    this.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error' || p.type === 'assert')
        this.consoleErrors.push({ type: p.type, text: p.args?.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200) });
    });
    this.on('Log.entryAdded', (p) => {
      if (p.entry.level === 'error') this.logErrors.push({ source: p.entry.source, text: p.entry.text.slice(0, 200), url: p.entry.url ?? null });
    });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Network.enable');
    await this.send('Network.setCacheDisabled', { cacheDisabled: false });
    await this.send('Runtime.addBinding', { name: BINDING });
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT_SCRIPT });
    const tree = await this.send('Page.getFrameTree');
    this.mainFrame = tree.frameTree.frame.id;
    await this.setViewport(DESKTOP);
  }

  async setViewport(viewport) {
    this.viewport = viewport;
    await this.send('Emulation.setDeviceMetricsOverride', viewport);
  }

  /** Navigates and waits for the load event, then applies the current viewport again. */
  async navigate(url, { wait = true } = {}) {
    const before = this.loads;
    const r = await this.send('Page.navigate', { url });
    if (wait && !r.errorText) await this.until(() => this.loads > before, { timeout: 15000, what: `load of ${new URL(url).pathname}` });
    await this.setViewport(this.viewport);
    return r;
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  async until(predicate, { timeout = 10000, interval = 50, what = 'a condition' } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > end) throw new Error(`${this.label}: timed out waiting for ${what}`);
      await sleep(interval);
    }
  }

  /** Waits until a page expression is truthy. */
  waitFor(expression, options = {}) {
    return this.until(() => this.evaluate(`Boolean(${expression})`).catch(() => false), { what: expression, ...options });
  }

  waitForSelector(selector, options = {}) {
    return this.waitFor(`document.querySelector(${JSON.stringify(selector)})`, { what: selector, ...options });
  }

  async click(selector) {
    await this.waitForSelector(selector);
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }

  /** Focuses a field, clears it and types into it through Input.insertText. */
  async type(selector, text) {
    await this.waitForSelector(selector);
    await this.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.select?.(); return true; })()`);
    await this.send('Input.insertText', { text });
  }

  text(selector = 'main') {
    return this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? null`);
  }

  location() {
    return this.evaluate('({ pathname: location.pathname, search: location.search, hash: location.hash })');
  }

  /** The storage rule 1 observations of the page itself. */
  storage() {
    return this.evaluate('({ cookie: document.cookie, local: localStorage.length, session: sessionStorage.length })');
  }

  async cookies(origin) {
    const { cookies } = await this.send('Network.getCookies', { urls: [origin] });
    return cookies.map(cookieShape);
  }

  async deleteCookie(name, origin) {
    await this.send('Network.deleteCookies', { name, url: origin });
  }

  /** Whole cookies, held by the harness in memory for a later restore; never logged, compared or written. */
  async captureCookies(origin) {
    const { cookies } = await this.send('Network.getCookies', { urls: [origin] });
    return Object.freeze(cookies.map((c) => Object.freeze({ ...c })));
  }

  async restoreCookies(captured) {
    await this.send('Network.setCookies', {
      cookies: captured.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expires: c.expires,
      })),
    });
  }

  widths() {
    return this.evaluate(
      '({ innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, devicePixelRatio, scrollHeight: document.documentElement.scrollHeight })',
    );
  }

  /** A PNG of the page from top CSS pixels (0 unless given, and never so low that less than a viewport remains) down to
      at most maxHeight CSS pixels, with the width readings taken before and after. The E4 pages lane added top, with the
      lead's approval, so a state at the foot of a long page can be photographed (evidence/e4-pages.md). */
  async screenshot(file, { maxHeight = 2600, top = 0 } = {}) {
    const before = await this.widths();
    const y = Math.max(0, Math.min(Math.floor(top), before.scrollHeight - this.viewport.height));
    const height = Math.min(Math.max(before.scrollHeight - y, this.viewport.height), maxHeight);
    const shot = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y, width: this.viewport.width, height, scale: 1 },
    });
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    const afterShot = await this.widths();
    return { before, after: afterShot, height, top: y };
  }

  async settle(ms = 0) {
    if (ms) await sleep(ms);
    await Promise.all(this.bodyReads);
  }

  /** The parsed JSON body of one recorded answer, read on demand. Journeys call it only for answers that carry no
      setup key: a member list or an identity. */
  async responseJson(entry) {
    const r = await this.send('Network.getResponseBody', { requestId: entry.id });
    return JSON.parse(r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body);
  }

  async history() {
    return this.send('Page.getNavigationHistory');
  }

  async back() {
    const h = await this.history();
    const before = this.loads;
    const pageshowsBefore = this.pageshows.length;
    await this.send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id });
    await this.until(() => this.loads > before || this.pageshows.length > pageshowsBefore, { timeout: 15000, what: 'the history entry' });
    await this.setViewport(this.viewport);
  }

  async reload() {
    const before = this.loads;
    await this.send('Page.reload', { ignoreCache: false });
    await this.until(() => this.loads > before, { timeout: 15000, what: 'the reload' });
    await this.setViewport(this.viewport);
  }

  /** Forgets what was recorded so a journey step can be asserted on its own requests. */
  mark() {
    return { requests: this.requests.length, documents: this.documents.length, events: this.events.length };
  }

  close() {
    return this.browser.conn.send('Target.closeTarget', { targetId: this.targetId });
  }
}

class Browser {
  constructor(child, conn, name, profileDir) {
    this.child = child;
    this.conn = conn;
    this.name = name;
    this.profileDir = profileDir;
    this.pages = [];
  }

  async newPage(label = this.name) {
    const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId, `${this.name}/${label}`);
    await page.init();
    this.pages.push(page);
    return page;
  }

  async close() {
    try {
      await Promise.race([this.conn.send('Browser.close'), sleep(3000)]);
    } catch {
      /* the socket closes as the browser exits */
    }
    await Promise.race([new Promise((ok) => this.child.once('exit', ok)), sleep(5000)]);
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
    rmSync(this.profileDir, { recursive: true, force: true });
  }
}

/** launch({ name, profileDir }): one headless Chrome with its own scratch profile. */
export async function launch({ name, profileDir }) {
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--metrics-recording-only',
      '--password-store=basic',
      '--use-mock-keychain',
      '--mute-audio',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const endpoint = await new Promise((ok, fail) => {
    let seen = '';
    const timer = setTimeout(() => fail(new Error(`${name}: Chrome did not report its DevTools endpoint`)), 30000);
    child.stderr.on('data', (chunk) => {
      seen += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
      if (m) {
        clearTimeout(timer);
        ok(m[1]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`${name}: Chrome exited with ${code} before it was ready`));
    });
  });
  const conn = await Connection.open(endpoint);
  return new Browser(child, conn, name, profileDir);
}
