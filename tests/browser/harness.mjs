/* The journey harness (pages design section 6): the identities' browsers, a journey's tabs, the screenshots with their
   width readings, and the assertions every journey makes on every tab it opened.

   Asserted on every tab, not recorded (section 6, revisions 2 and 3):
     - the initiator of every /api/ request to the shell: a script whose top stack frame is /assets/app/api.mjs (rule 2);
     - the document URLs (rule 10): the first document on the shell's origin is the landing, whose path and query must be
       in the fixed set with the query in-application navigation may carry, and whose fragment may appear only on
       /signin/, /accept/ or /accept and parse to at most token_hash, type and invite; every later document must be in the
       fixed set, on the shell's origin, with no fragment; and no value of the landing fragment may appear in any later
       document URL, request URL or Referer. Documents on another origin before the landing (the cross-site page of
       J14 and J16) are outside the application and are not the landing;
     - no request URL carries token_hash, an invite parameter, a 64-hex value or a six-digit value;
     - no Content-Security-Policy or Trusted Types violation, no uncaught exception, no console error, and no log entry
       at level error other than the network source, where the browser reports every 4xx answer.
   Asserted where a journey names the state (rule 1): the cookie count for that state, zero, one (the refresh cookie
   alone) or two, never a cookie of another name, HttpOnly, Secure, SameSite Strict and path / on whichever exist, and
   document.cookie empty with both storages at length zero.

   Recorded values are redacted: a URL keeps its path and its parameter names, and every value becomes <redacted>. A
   cookie is reduced to its name and attributes before any assertion reads it. */

import { mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { DESKTOP, launch, PHONE } from './cdp.mjs';
import { ROOT, startShell } from './dev-shell.mjs';

export const SCRATCH = join(ROOT, '.scratch', 'browser');
export const COOKIE_NAMES = Object.freeze(['enterprise_access', 'enterprise_refresh']);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/* The fixed navigation set of web/assets/app/shell.mjs, written here a second time on purpose, so the assertion does
   not inherit a defect of the thing it checks; tests/e2/unit/web-e4-modules.test.mjs holds the two equal. */
export const FIXED = new Set([
  '/',
  '/signin/',
  '/accept/',
  '/accept',
  '/mfa/',
  '/members/',
  '/account/',
  '/reviews/',
  '/review/',
  '/releases/',
  '/release/',
  '/groups/',
  '/catalog/',
  /* E6 design 2.6 item 6, landed by the lead before construction: the three operator pages. */
  '/operator/',
  '/operator/company/',
  '/operator/new/',
  /* The E3 intake pages (docs/e3/intake-pages-design.md section 1), moved for the reason that a page was added. */
  '/drafts/',
  '/drafts/new/',
  '/draft/',
  '/submitted/',
  /* The capture prompt's page (HOSTED-F3, evidence/operator-landing.md), moved for the reason that a page was added. */
  '/capture/',
]);
export const QUERY = new RegExp(`^(?:company=${UUID}|candidate=${UUID}|release=${UUID}|reason=(?:expired|signed-out))$`);

/** Where a journey's captures go (PW-R-F1, evidence/pages-web-review.md; Q5R-F1, evidence/q5-reversal.md): a directory
    named for the run inside its evidence directory, `<evidence>/<label>/`, only on a full run, with no --only and no
    --site, that names that evidence directory with --evidence; the run's scratch record otherwise, so a full run made
    to check something cannot rewrite another slice's accepted images. Run-scoped since E8 day 5 (evidence/e8-surface.md):
    the run writes only into the one directory its label names, which the runner refuses to reuse, so no run empties or
    overwrites an image another run wrote. `promote` is the set of evidence directories the run named.
    tests/e2/unit/web-capture-dir.test.mjs holds the rule and the runner's use of it. */
export function captureDirFor({ only, site, evidence, label, promote }) {
  return !only && !site && evidence && promote?.has(evidence)
    ? join(ROOT, evidence, runLabel(label))
    : join(SCRATCH, runLabel(label), 'captures');
}
/** The evidence directories a run may replace (Q5R-F1): each --evidence value must be, character for character, a
    directory some journey names, and a selection or a mutated site may name none. Anything else is refused rather
    than resolved. Returns the set captureDirFor takes. */
export function promotedEvidence({ value, only, site, known, given = value !== null && value !== undefined }) {
  /* `given` says the flag was on the command line: a bare --evidence, or one followed by another flag, is refused
     rather than read as "promote nothing" (Q5R-F1-R-F2, evidence/e5-pages-review.md). */
  if (!given) return new Set();
  if (value === null || value === undefined || String(value).startsWith('--'))
    throw new TypeError('harness.mjs: --evidence needs the journey directory it names');
  if (only || site) throw new TypeError('harness.mjs: --evidence goes with a full run, not with --only or --site');
  const named = String(value).split(',');
  for (const dir of named)
    if (!known.includes(dir)) throw new TypeError('harness.mjs: --evidence names a directory no journey keeps');
  return new Set(named);
}
/** A run label names one directory under .scratch/browser and nothing else (E4PW-R-F3, evidence/e4-pages-review.md):
    letters, digits, dot, underscore and hyphen, not starting with a dot, at most 80 characters. Anything else, including
    a path separator or `..`, is refused rather than resolved, so a selection or mutant run cannot be steered into
    evidence. */
/** B3-R-F4 (evidence/batch-3-review.md): the runner reads `--flag value`, and an argument it does not read used to be
    ignored, so a mistyped flag (`--evidnce`) or journey id (`E6-JL09`) ran 0 of 0 and exited 0, a silent pass under the
    cadence line that has a lane run "the journeys that read it" by name. Every argument must be a known flag or the value
    of the known flag before it. */
export function unknownArguments(args, knownFlags) {
  const known = new Set(knownFlags);
  return args.filter((a, i) => (a.startsWith('--') ? !known.has(a) : !(i > 0 && known.has(args[i - 1]))));
}

/** The known flags given without a value: last on the line, followed by another flag, or followed by an empty
 *  string. B4-R-F8 (evidence/batch-4-review.md): `--only` with its value forgotten made the selection null, which
 *  means every journey, and a whole run started on the stack. Each such flag is refused before the stack is touched. */
export function flagsWithoutValue(args, knownFlags) {
  const known = new Set(knownFlags);
  return args.filter((a, i) => known.has(a) && (i + 1 >= args.length || args[i + 1] === '' || args[i + 1].startsWith('--')));
}

/** The ids of a selection that name no journey; an empty list means every one is known. */
export function unknownJourneyIds(only, ids) {
  if (!only) return [];
  const known = new Set(ids);
  return [...only].filter((id) => !known.has(id));
}

export function runLabel(label) {
  if (typeof label !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,79}$/.test(label))
    throw new TypeError('harness.mjs: a run label is one directory name under .scratch/browser');
  return label;
}
const FRAGMENT_PAGES = new Set(['/signin/', '/accept/', '/accept']);
const FRAGMENT_KEYS = new Set(['token_hash', 'type', 'invite']);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Run in the page through the DevTools protocol for a capture: each setup key's characters become X with its spacing
   kept, each QR image shows a grey square of the same size, and each accept link a handover answer put in its read-only
   field becomes X of the same length (E6 design 4.3: the link is a live first factor for somebody else and appears in
   no capture; added by the E6 pages lane, the one harness change its journeys need); UNMASK puts the originals back.
   LINK_VISIBLE is read after MASK, and a capture fails its check if any link value is still on the page. */
const PLACEHOLDER_QR = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="231" height="231"><rect width="231" height="231" fill="#d0d0d0"/><text x="115" y="112" font-size="14" text-anchor="middle" font-family="sans-serif">QR code not kept</text><text x="115" y="132" font-size="14" text-anchor="middle" font-family="sans-serif">in evidence</text></svg>',
)}`;
const MASK = `(() => {
  const held = [];
  for (const node of document.querySelectorAll('[data-role="secret"]')) { held.push(['text', node, node.textContent]); node.textContent = node.textContent.replace(/\\S/g, 'X'); }
  for (const node of document.querySelectorAll('img.qr')) { held.push(['src', node, node.getAttribute('src')]); node.src = ${JSON.stringify(PLACEHOLDER_QR)}; }
  for (const node of document.querySelectorAll('input[data-role="accept-link"]')) { held.push(['value', node, node.value]); node.value = node.value.replace(/\\S/g, 'X'); }
  globalThis.__journeyHeld = held;
  return held.length;
})()`;
const LINK_VISIBLE = `(() => {
  const values = [...document.querySelectorAll('input, textarea')].map((n) => n.value).join(' ');
  return /token_hash|[#?&]invite=/.test(values + ' ' + (document.body?.innerText ?? ''));
})()`;
const UNMASK = `(() => {
  for (const [kind, node, value] of globalThis.__journeyHeld ?? []) { if (kind === 'text') node.textContent = value; else if (kind === 'value') node.value = value; else node.src = value; }
  delete globalThis.__journeyHeld;
  return true;
})()`;

/** A URL with every query and fragment value replaced, for records and captions. */
export function redact(url, fragment = '') {
  let u;
  try {
    u = new URL(url);
  } catch {
    return '<unparsable>';
  }
  const names = (params) => [...params.keys()].map((k) => `${k}=<redacted>`).join('&');
  const query = u.search ? `?${names(u.searchParams)}` : '';
  const hash = fragment || u.hash;
  const frag = hash ? `#${names(new URLSearchParams(hash.slice(1)))}` : '';
  return `${u.origin === 'null' ? '' : u.origin}${u.pathname}${query}${frag}`;
}

/** Cookie state for a named state: 0, 1 (the refresh cookie alone) or 2. */
export async function cookieFindings(page, origin, state) {
  const findings = [];
  const cookies = await page.cookies(origin);
  const names = cookies.map((c) => c.name).sort();
  const expected = state === 0 ? [] : state === 1 ? ['enterprise_refresh'] : [...COOKIE_NAMES];
  if (names.join(',') !== expected.join(',')) findings.push(`expected [${expected.join(', ')}], found [${names.join(', ')}]`);
  for (const c of cookies) {
    if (!COOKIE_NAMES.includes(c.name)) findings.push(`a cookie of another name: ${c.name}`);
    if (c.httpOnly !== true) findings.push(`${c.name} is not HttpOnly`);
    if (c.secure !== true) findings.push(`${c.name} is not Secure`);
    if (c.sameSite !== 'Strict') findings.push(`${c.name} is SameSite ${c.sameSite}`);
    if (c.path !== '/') findings.push(`${c.name} has path ${c.path}`);
  }
  const storage = await page.storage().catch(() => null);
  if (storage) {
    if (storage.cookie !== '') findings.push('document.cookie is not empty');
    if (storage.local !== 0) findings.push(`localStorage.length is ${storage.local}`);
    if (storage.session !== 0) findings.push(`sessionStorage.length is ${storage.session}`);
  }
  return { findings, observed: cookies.map(({ name, httpOnly, secure, sameSite, path }) => ({ name, httpOnly, secure, sameSite, path })) };
}

export function initiatorFindings(page, origin) {
  const findings = [];
  for (const r of page.requests) {
    let url;
    try {
      url = new URL(r.url);
    } catch {
      continue;
    }
    if (url.origin !== origin || !url.pathname.startsWith('/api/')) continue;
    const frames = r.initiator?.stack?.callFrames?.length ? r.initiator.stack.callFrames : (r.initiator?.stack?.parent?.callFrames ?? []);
    let top = null;
    try {
      top = new URL(frames[0]?.url).pathname;
    } catch {
      top = null;
    }
    if (r.initiator?.type !== 'script' || top !== '/assets/app/api.mjs')
      findings.push(`${r.method} ${url.pathname}: initiator ${r.initiator?.type ?? 'none'}, top frame ${top ?? 'none'}`);
  }
  return findings;
}

export function documentFindings(page, origin) {
  const findings = [];
  const docs = page.documents;
  const first = docs.findIndex((d) => {
    try {
      return new URL(d.url).origin === origin;
    } catch {
      return false;
    }
  });
  if (first === -1) return { findings, landing: null, later: [] };
  const landing = docs[first];
  const u = new URL(landing.url);
  const query = u.search.slice(1);
  if (!FIXED.has(u.pathname) || (query && !QUERY.test(query))) findings.push(`landing outside the fixed set: ${redact(landing.url)}`);
  const values = [];
  if (landing.fragment) {
    if (!FRAGMENT_PAGES.has(u.pathname)) findings.push(`a fragment on a landing that may not carry one: ${redact(landing.url, landing.fragment)}`);
    const params = new URLSearchParams(landing.fragment.slice(1));
    for (const [key, value] of params) {
      if (!FRAGMENT_KEYS.has(key)) findings.push(`landing fragment key ${key}`);
      if (value.length >= 8) values.push(value);
    }
  }
  const later = docs.slice(first + 1);
  for (const d of later) {
    let v;
    try {
      v = new URL(d.url);
    } catch {
      findings.push('an unparsable later document URL');
      continue;
    }
    const q = v.search.slice(1);
    if (v.origin !== origin || !FIXED.has(v.pathname) || (q && !QUERY.test(q)) || d.fragment)
      findings.push(`a later navigation outside the fixed set: ${redact(d.url, d.fragment)}`);
  }
  for (const r of page.requests.slice(landing ? page.requests.findIndex((x) => x.at >= landing.at) + 1 : 0)) {
    const carried = values.filter((value) => r.url.includes(value) || r.url.includes(encodeURIComponent(value)) || (r.referer ?? '').includes(value));
    if (carried.length) findings.push(`a landing value carried into ${r.type} ${redact(r.url)}`);
  }
  for (const d of later) if (values.some((value) => d.fragment.includes(value))) findings.push(`a landing value carried into a later fragment ${redact(d.url, d.fragment)}`);
  return { findings, landing: redact(landing.url, landing.fragment), later: later.map((d) => redact(d.url, d.fragment)) };
}

export function secretUrlFindings(page) {
  const findings = [];
  for (const r of page.requests) {
    const bare = r.url.replace(new RegExp(UUID, 'g'), '');
    if (/token_hash|[?&]invite=|[0-9a-f]{64}|(?<![0-9])[0-9]{6}(?![0-9])/i.test(bare)) findings.push(`${r.method} ${redact(r.url)} carries a link or code value`);
  }
  return findings;
}

export function healthFindings(page) {
  const findings = [];
  if (page.violations.length) findings.push(`policy violations: ${JSON.stringify(page.violations)}`);
  if (page.exceptions.length) findings.push(`uncaught exceptions: ${JSON.stringify(page.exceptions)}`);
  if (page.consoleErrors.length) findings.push(`console errors: ${JSON.stringify(page.consoleErrors)}`);
  const logs = page.logErrors.filter((e) => e.source !== 'network');
  if (logs.length) findings.push(`log errors: ${JSON.stringify(logs)}`);
  return findings;
}

/** One journey: its checks, its tabs, its captures and notes. captureDir is where its screenshots go: the run's scratch
    record unless the runner names another directory, which tests/browser/run-journeys.mjs does only for a full run of
    a journey that keeps evidence (PW-R-F1: a selection or a mutated site never writes evidence). */
export class Journey {
  constructor(ctx, id, title, { captureDir = join(SCRATCH, ctx.run, 'captures') } = {}) {
    this.ctx = ctx;
    this.id = id;
    this.title = title;
    this.captureDir = captureDir;
    this.checks = [];
    this.tabs = [];
    this.captures = [];
    this.notes = [];
    this.recorded = [];
  }

  get origin() {
    return this.ctx.shell.origin;
  }

  check(label, ok, detail) {
    this.checks.push(ok ? { label, ok: true } : { label, ok: false, detail });
    return Boolean(ok);
  }

  none(label, findings) {
    return this.check(label, findings.length === 0, findings);
  }

  equal(label, actual, expected) {
    return this.check(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
  }

  note(text) {
    this.notes.push(text);
  }

  record(label, value) {
    this.recorded.push({ label, value });
  }

  /** A new tab of an identity's browser; its universal assertions run when the journey finishes. landingOutsideSet
      marks a tab whose first document is deliberately outside the fixed set (J9's malformed id): its document check
      then expects exactly that one finding and nothing else. */
  async tab(identity, label, { universal = true, landingOutsideSet = false } = {}) {
    const page = await this.ctx.page(identity, `${this.id}-${label}`);
    this.tabs.push({ page, universal, identity, label, landingOutsideSet });
    return page;
  }

  async cookies(page, state, label) {
    const r = await cookieFindings(page, this.origin, state);
    this.check(`cookie state ${state} (${label})`, r.findings.length === 0, { findings: r.findings, observed: r.observed });
    return r;
  }

  /** Desktop and phone screenshots of a state, with the phone width readings asserted beside the image. A setup key and
      a QR code on the page are replaced for the two captures by placeholders of the same box, so no image in evidence
      holds a factor's secret (the QR encodes it, O23); the page is put back as it was afterwards. */
  async capture(page, state, { anchor = null } = {}) {
    mkdirSync(this.captureDir, { recursive: true });
    const base = `${this.id}-${state}`;
    const viewport = page.viewport;
    const masked = await page.evaluate(MASK);
    await sleep(masked ? 200 : 0);
    this.check(`no accept link is visible in the capture of ${state}`, (await page.evaluate(LINK_VISIBLE)) === false);
    /* An anchor starts both images a little above that element, measured again in each viewport because the layouts
       differ; without one, both start at the top of the page as before. Added by the E4 pages lane with the lead's
       approval. */
    const topOf = () =>
      anchor
        ? page.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(anchor)}); return n ? Math.max(0, Math.floor(n.getBoundingClientRect().top + scrollY) - 16) : null; })()`)
        : 0;
    await page.setViewport(DESKTOP);
    await sleep(250);
    const desktopTop = await topOf();
    const desktopFile = join(this.captureDir, `${base}-desktop.png`);
    await page.screenshot(desktopFile, { top: desktopTop ?? 0 });
    await page.setViewport(PHONE);
    await sleep(350);
    const phoneTop = await topOf();
    const phoneFile = join(this.captureDir, `${base}-phone.png`);
    const phone = await page.screenshot(phoneFile, { top: phoneTop ?? 0 });
    await page.evaluate(UNMASK);
    const holds = (w) => w.innerWidth === 390 && w.clientWidth === 390 && w.scrollWidth === w.clientWidth;
    this.check(`phone width readings at ${state}`, holds(phone.before) && holds(phone.after), phone);
    if (anchor) this.check(`the capture of ${state} starts at ${anchor}`, desktopTop !== null && phoneTop !== null, { desktopTop, phoneTop });
    this.captures.push({
      journey: this.id,
      state,
      desktop: relative(ROOT, desktopFile),
      phone: relative(ROOT, phoneFile),
      widths: phone.before,
      widthsAfterCapture: phone.after,
      capturedHeight: phone.height,
      capturedFrom: phone.top,
      anchor,
      maskedSecrets: masked,
    });
    await page.setViewport(viewport);
    await sleep(100);
  }

  /** The universal assertions on every tab, then the tabs closed. */
  async finish() {
    for (const { page, universal, label, landingOutsideSet } of this.tabs) {
      await page.settle(100).catch(() => undefined);
      if (universal) {
        this.none(`initiator of every /api/ request (${label})`, initiatorFindings(page, this.origin));
        const docs = documentFindings(page, this.origin);
        if (landingOutsideSet)
          this.check(
            `document URLs: exactly the one deliberate landing outside the fixed set (${label})`,
            docs.findings.length === 1 && docs.findings[0].startsWith('landing outside the fixed set'),
            docs.findings,
          );
        else this.none(`document URLs, landing and later (${label})`, docs.findings);
        this.record(`documents (${label})`, { landing: docs.landing, later: docs.later });
        this.none(`no link or code value in a request URL (${label})`, secretUrlFindings(page));
        this.none(`no policy violation, exception or console error (${label})`, healthFindings(page));
      }
      await page.close().catch(() => undefined);
    }
  }

  get passed() {
    return this.checks.length > 0 && this.checks.every((c) => c.ok);
  }
}

/** The run's context: the shell, the seeded ids, and one headless Chrome per identity, launched on first use. */
export function createContext({ shell, ids, run }) {
  const browsers = new Map();
  return {
    shell,
    ids,
    run,
    state: {},
    /** Closes the running shell and starts another with these options (J13's closed switch, J17's scratch copies). */
    async replaceShell(options) {
      await this.shell.close();
      this.shell = await startShell(options);
      return this.shell;
    },
    async browser(identity) {
      if (!browsers.has(identity))
        browsers.set(identity, await launch({ name: identity, profileDir: join(SCRATCH, 'profiles', `${run}-${identity}`) }));
      return browsers.get(identity);
    },
    async page(identity, label) {
      return (await this.browser(identity)).newPage(label);
    },
    async closeAll() {
      for (const b of browsers.values()) await b.close().catch(() => undefined);
      browsers.clear();
    },
  };
}
