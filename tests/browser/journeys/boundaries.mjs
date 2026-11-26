/* J13, J14, J16 and J17 (pages design sections 3 and 6): the closed switch, a cross-site mutation, an arrival by a
   cross-site link, and the browser-rule assertions shown able to fail. The cross-site page is served by a second
   loopback server and opened as http://localhost:<port>, which is a different site from http://127.0.0.1:<port>. */

import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { ROOT } from '../dev-shell.mjs';
import { ALIAS, CARRY_NAVIGATION, CARRY_REQUEST, EXTERNAL, MISS, SYNTHETIC_HASH } from '../fixtures/j17.mjs';
import { documentFindings, initiatorFindings, SCRATCH } from '../harness.mjs';
import { apiRequests, line, sleep, sql, tag, waitPath } from './common.mjs';

async function crossSite(pages) {
  const server = createServer((req, res) => {
    const page = pages[(req.url ?? '').split('?')[0]];
    if (!page) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': page.type, 'cache-control': 'no-store' });
    res.end(page.body);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    port: server.address().port,
    close: () =>
      new Promise((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}

export async function j16(ctx, j) {
  const target = `${j.origin}/members/?company=${ctx.ids.ALPHA}`;
  const site = await crossSite({
    '/j16.html': { type: 'text/html; charset=utf-8', body: `<!doctype html><title>elsewhere</title><a id="go" href="${target}">open</a>` },
  });
  try {
    const tab = await j.tab('admin1', 'cross-site-arrival');
    await tab.navigate(`http://localhost:${site.port}/j16.html`);
    await tab.click('#go');
    await waitPath(tab, '/members/');
    await tab.waitForSelector('[data-role="invite-form"]');
    const doc = tab.requests.find((r) => r.type === 'Document' && r.url.startsWith(j.origin));
    await tab.until(() => doc.sentCookies !== null, { timeout: 5000, what: "the document request's cookie report" });
    j.check('the document request from the cross-site link carried no cookie', doc.sentCookies.length === 0, doc.sentCookies);
    /* Chrome 152 names the block SchemefulSameSiteStrict when schemeful same-site is in force and SameSiteStrict
       otherwise; both are the Strict attribute withholding the cookie, and the exact reason is recorded. */
    j.check(
      'Chrome reports both Strict cookies blocked on that request',
      ['enterprise_access', 'enterprise_refresh'].every((n) =>
        doc.blockedCookies?.some((b) => b.name === n && b.reasons.some((reason) => /^(?:Schemeful)?SameSiteStrict$/.test(reason))),
      ),
      doc.blockedCookies,
    );
    j.record('the block reasons Chrome reported on the document request', doc.blockedCookies);
    const firstMe = (await apiRequests(tab, j.origin)).find((x) => x.path === '/api/me');
    j.check(
      "the page's first GET /api/me carried both cookies and answered 200",
      firstMe?.status === 200 && ['enterprise_access', 'enterprise_refresh'].every((n) => firstMe.entry.sentCookies?.includes(n)),
      firstMe && { status: firstMe.status, sent: firstMe.entry.sentCookies },
    );
    j.check('and the page renders signed in, with the administrator controls', true);
    await j.cookies(tab, 2, 'signed in after the arrival');
    await j.capture(tab, 'arrived');
  } finally {
    await site.close();
  }
}

export async function j14(ctx, j) {
  const alpha = ctx.ids.ALPHA;
  const run = tag();
  const addresses = { a: `pages-j14-a-${run}@example.invalid`, c: `pages-j14-c-${run}@example.invalid` };
  const create = `${j.origin}/api/companies/${alpha}/invitations`;
  const script = [
    'const results = {};',
    `const body = (email) => JSON.stringify({ email, roles: [], expiresInDays: 7 });`,
    `try { await fetch(${JSON.stringify(create)}, { method: 'POST', mode: 'no-cors', credentials: 'include', headers: { 'content-type': 'text/plain' }, body: body(${JSON.stringify(addresses.a)}) }); results.a = 'sent'; } catch { results.a = 'threw'; }`,
    `try { await fetch(${JSON.stringify(create)}, { method: 'POST', mode: 'cors', credentials: 'include', headers: { 'content-type': 'application/json' }, body: body(${JSON.stringify(addresses.c)}) }); results.c = 'answered'; } catch { results.c = 'refused'; }`,
    "document.getElementById('b').submit();",
    'document.body.dataset.done = JSON.stringify(results);',
    '',
  ].join('\n');
  const page = [
    '<!doctype html><title>elsewhere</title>',
    `<form id="b" method="post" enctype="text/plain" action="${j.origin}/api/invitations/accept" target="sink">`,
    `<input type="hidden" name='{"inviteCode":"' value='${'a'.repeat(64)}"}'></form>`,
    '<iframe name="sink"></iframe>',
    '<script type="module" src="/j14.mjs"></script>',
  ].join('\n');
  const site = await crossSite({
    '/j14.html': { type: 'text/html; charset=utf-8', body: page },
    '/j14.mjs': { type: 'text/javascript; charset=utf-8', body: script },
  });
  const counts = () => ({
    invitations: Number(sql(`select count(*) from app.invitations where email_normalized like 'pages-j14-%'`)),
    audits: Number(sql('select count(*) from app.audit_events')),
  });
  try {
    const before = counts();
    const mark = ctx.shell.record.length;
    const tab = await j.tab('admin1', 'cross-site-page', { universal: false });
    await tab.navigate(`http://localhost:${site.port}/j14.html`);
    await tab.waitFor('document.body.dataset.done', { timeout: 15000 });
    await sleep(2500);
    const seen = ctx.shell.record.slice(mark);
    j.record(
      'what reached the shell from the cross-site page',
      seen.map((e) => ({ method: e.method, path: e.path.replace(alpha, '<alpha>'), status: e.status, code: e.code, fetchSite: e.fetchSite, origin: e.origin })),
    );
    j.record('what the page itself saw', JSON.parse(await tab.evaluate('document.body.dataset.done')));
    const posts = seen.filter((e) => e.method === 'POST' && e.path === `/api/companies/${alpha}/invitations`);
    const form = seen.filter((e) => e.method === 'POST' && e.path === '/api/invitations/accept');
    j.equal('(a) the no-cors text/plain POST is refused 403 E_CROSS_SITE', posts.map((e) => [e.status, e.code]).slice(0, 1), [[403, 'E_CROSS_SITE']]);
    j.equal('(b) the auto-submitted text/plain form is refused 403 E_CROSS_SITE', form.map((e) => [e.status, e.code]), [[403, 'E_CROSS_SITE']]);
    j.check(
      '(c) the JSON fetch in CORS mode stopped at its preflight: an OPTIONS reached the shell and no second POST did',
      seen.some((e) => e.method === 'OPTIONS') && posts.length === 1,
      seen.map((e) => `${e.method} ${e.status}`),
    );
    j.equal('no invitation row and no audit row were written', counts(), before);
    j.record('the refusal cause the shell observed for (a) and (b)', [...posts, ...form].map((e) => ({ fetchSite: e.fetchSite, origin: e.origin })));
    j.note('The cross-site page is the attack, so its /api/ requests are not held to the initiator rule; this journey asserts on the shell record.');
  } finally {
    await site.close();
  }
}

const FIXTURES = [
  { name: 'alias', page: 'account/index.html', module: 'account', landing: '/account/', text: ALIAS, fails: 'initiator' },
  { name: 'miss', page: 'mfa/index.html', module: 'mfa', landing: '/mfa/', text: MISS, fails: 'initiator' },
  { name: 'external', page: 'index.html', module: 'home', landing: '/', text: EXTERNAL, fails: 'navigation' },
  {
    name: 'carry-navigation',
    page: 'signin/index.html',
    module: 'signin',
    landing: `/signin/#token_hash=${SYNTHETIC_HASH}&type=magiclink`,
    text: CARRY_NAVIGATION,
    fails: 'carried',
  },
  {
    name: 'carry-request',
    page: 'accept/index.html',
    module: 'accept',
    landing: `/accept/#token_hash=${SYNTHETIC_HASH}&type=magiclink`,
    text: CARRY_REQUEST,
    fails: 'carried-only',
  },
];

function files(dir, rel = '') {
  const out = {};
  for (const name of readdirSync(join(dir, rel))) {
    const childRel = rel ? `${rel}/${name}` : name;
    if (statSync(join(dir, childRel)).isDirectory()) Object.assign(out, files(dir, childRel));
    else out[childRel] = createHash('sha256').update(readFileSync(join(dir, childRel))).digest('hex');
  }
  return out;
}

/** A scratch copy of the built tree with one page's module replaced by the fixture, and its own manifest. */
function fixtureSite(fixture) {
  const dir = join(SCRATCH, 'j17', fixture.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(SCRATCH, 'j17'), { recursive: true });
  cpSync(join(ROOT, '.scratch', 'site'), dir, { recursive: true });
  const html = readFileSync(join(dir, fixture.page), 'utf8');
  const from = `/assets/app/pages/${fixture.module}.mjs`;
  if (html.split(from).length !== 2) throw new Error(`J17: ${fixture.page} does not name ${from} once`);
  writeFileSync(join(dir, fixture.page), html.replace(from, `/assets/app/pages/j17-${fixture.name}.mjs`));
  writeFileSync(join(dir, 'assets', 'app', 'pages', `j17-${fixture.name}.mjs`), fixture.text);
  const manifest = join(SCRATCH, 'j17', `${fixture.name}-manifest.json`);
  writeFileSync(manifest, JSON.stringify({ files: files(dir) }));
  return { dir, manifest };
}

export async function j17(ctx, j) {
  try {
    for (const fixture of FIXTURES) {
      const site = fixtureSite(fixture);
      await ctx.replaceShell({ build: false, siteDir: site.dir, manifestPath: site.manifest });
      const tab = await j.tab('j17', fixture.name, { universal: false });
      await tab.navigate(`${j.origin}${fixture.landing}`);
      await sleep(3000);
      await tab.settle();
      const initiator = initiatorFindings(tab, j.origin);
      const docs = documentFindings(tab, j.origin).findings;
      const later = docs.filter((f) => f.startsWith('a later navigation'));
      const carried = docs.filter((f) => f.includes('landing value carried'));
      j.record(`${fixture.name}: what the assertions reported`, { initiator, documents: docs });
      if (fixture.fails === 'initiator') {
        j.check(`${fixture.name}: the initiator assertion fails on its fixture`, initiator.length > 0, initiator);
        j.equal(`${fixture.name}: the document assertions do not`, docs, []);
      }
      if (fixture.fails === 'navigation') {
        j.check(`${fixture.name}: the navigation-set assertion fails on its fixture`, later.length > 0, docs);
        j.equal(`${fixture.name}: the initiator assertion does not`, initiator, []);
      }
      if (fixture.fails === 'carried') {
        j.check(`${fixture.name}: the carried-input assertion fails on its fixture`, carried.length > 0, docs);
        j.check(`${fixture.name}: and so does the navigation-set assertion, since the value rides in a fragment`, later.length > 0, docs);
      }
      if (fixture.fails === 'carried-only') {
        j.check(`${fixture.name}: the carried-input assertion fails on its fixture`, carried.length > 0, docs);
        j.equal(`${fixture.name}: with no later navigation for the set assertion to see`, later, []);
      }
    }
  } finally {
    await ctx.replaceShell({});
  }
}

export async function j13(ctx, j) {
  const alpha = ctx.ids.ALPHA;
  await ctx.replaceShell({ closed: true });
  const synthetic = { hash: 'j13syntheticlinkvalue00000000000000000000', invite: 'b'.repeat(64) };
  const pages = [
    ['home', '/'],
    ['sign-in-landing', `/signin/#token_hash=${synthetic.hash}&type=magiclink`],
    ['accept', `/accept#token_hash=${synthetic.hash}&type=magiclink&invite=${synthetic.invite}`],
    ['mfa', '/mfa/'],
    ['members', `/members/?company=${alpha}`],
    ['account', '/account/'],
  ];
  for (const [name, path] of pages) {
    const tab = await j.tab('admin1', `closed-${name}`);
    await j.cookies(tab, 2, `${name}: before`);
    await tab.navigate(`${j.origin}${path}`);
    await tab.waitForSelector('[data-state="maintenance"]', { timeout: 15000 });
    const answers = await apiRequests(tab, j.origin);
    j.check(`${name}: the maintenance state`, true);
    j.check(`${name}: every API answer is 503 E_MAINTENANCE`, answers.length > 0 && answers.every((x) => x.status === 503 && x.code === 'E_MAINTENANCE'), answers.map(line));
    j.check(`${name}: no answer set a cookie`, answers.every((x) => (x.entry.setCookieNames ?? []).length === 0), answers.map((x) => x.entry.setCookieNames));
    await j.cookies(tab, 2, `${name}: no cookie changed`);
    if (name === 'members') await j.capture(tab, 'maintenance');
  }
  const form = await j.tab('j1', 'closed-form');
  await form.navigate(`${j.origin}/signin/`);
  await form.waitForSelector('[data-role="signin-form"]');
  await form.type('#email', 'synthetic-alpha-member@example.invalid');
  await form.click('[data-role="send-link"]');
  await form.waitForSelector('[data-state="maintenance"]');
  j.equal('the plain sign-in form shows the maintenance state at its first request', (await apiRequests(form, j.origin)).map(line), ['POST /api/auth/start 503 E_MAINTENANCE']);
}
