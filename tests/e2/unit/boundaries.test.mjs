/* Case 25 (static part): scripts/check-imports.mjs refuses the E2 design section 8.1 edges. Each
   counterexample is a minimal tree; the control is this repository, which must be clean. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkImports, moduleReferences } from '../../../scripts/check-imports.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'e2-boundaries-'));
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), src);
  }
  return root;
}
const rules = (root) => checkImports(root).problems.map((p) => `${p.rule}: ${p.path}`);
const base = {
  'lib/errors.mjs': 'export const x = 1;\n',
  'lib/session.mjs': "import { createHmac } from 'node:crypto';\nexport const y = createHmac;\n",
  'lib/db/server.mjs':
    "import { x } from '../errors.mjs';\nimport { y } from '../session.mjs';\nexport const s = [x, y];\n",
  'lib/db/operator.mjs': 'export const o = 1;\n',
  'lib/db/user.mjs': "import { y } from '../session.mjs';\nexport const u = y;\n",
  'lib/services/invitations.mjs':
    "import { o } from '../db/operator.mjs';\nimport { s } from '../db/server.mjs';\nexport const i = [o, s];\n",
  'lib/services/members.mjs': "import { s } from '../db/server.mjs';\nexport const m = s;\n",
  'lib/http/routes.mjs': "import { m } from '../services/members.mjs';\nexport const r = m;\n",
  'netlify/functions/members.mjs': "import { r } from '../../lib/http/routes.mjs';\nexport default r;\n",
  'lib/rules/roles.mjs': 'export const ROLES = [];\n',
};

test('the permitted E2 graph is clean', () => {
  const root = tree(base);
  try {
    assert.deepEqual(rules(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a handler importing lib/db/server.mjs or lib/db/operator.mjs is refused', () => {
  const root = tree({
    ...base,
    'netlify/functions/bad-server.mjs': "import { s } from '../../lib/db/server.mjs';\nexport default s;\n",
    'netlify/functions/bad-operator.mjs': "import { o } from '../../lib/db/operator.mjs';\nexport default o;\n",
  });
  try {
    const found = rules(root);
    assert.ok(
      found.some((r) => r.startsWith('handler imports a database client: netlify/functions/bad-server.mjs')),
      found.join('\n'),
    );
    assert.ok(
      found.some((r) => r.startsWith('handler imports a database client: netlify/functions/bad-operator.mjs')),
      found.join('\n'),
    );
    assert.ok(
      found.some((r) =>
        r.startsWith('server client imported outside lib/services, lib/operator: netlify/functions/bad-server.mjs'),
      ),
      found.join('\n'),
    );
    assert.ok(
      found.some((r) =>
        r.startsWith(
          'operator client imported outside lib/operator, scripts, tests, lib/services/invitations.mjs: netlify/functions/bad-operator.mjs',
        ),
      ),
      found.join('\n'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the server client outside lib/services and lib/operator, and the operator client outside its three importers, are refused', () => {
  const root = tree({
    ...base,
    'lib/http/bad.mjs': "import { s } from '../db/server.mjs';\nexport const b = s;\n",
    'lib/services/members-bad.mjs': "import { o } from '../db/operator.mjs';\nexport const b = o;\n",
    'lib/passport/bad.mjs': "import { s } from '../db/server.mjs';\nexport const b = s;\n",
  });
  try {
    const found = rules(root);
    assert.ok(
      found.some(
        (r) => r === 'server client imported outside lib/services, lib/operator: lib/http/bad.mjs -> lib/db/server.mjs',
      ),
      found.join('\n'),
    );
    assert.ok(
      found.some(
        (r) =>
          r ===
          'operator client imported outside lib/operator, scripts, tests, lib/services/invitations.mjs: lib/services/members-bad.mjs -> lib/db/operator.mjs',
      ),
      found.join('\n'),
    );
    assert.ok(
      found.some(
        (r) =>
          r === 'server client imported outside lib/services, lib/operator: lib/passport/bad.mjs -> lib/db/server.mjs',
      ),
      found.join('\n'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lib/rules with IO of any kind is refused: node built-in, fetch, process, a database client', () => {
  const root = tree({
    ...base,
    'lib/rules/io-builtin.mjs': "import { readFileSync } from 'node:fs';\nexport const a = readFileSync;\n",
    'lib/rules/io-fetch.mjs': "export const a = () => fetch('http://x');\n",
    'lib/rules/io-env.mjs': 'export const a = () => process.env.X;\n',
    'lib/rules/io-db.mjs': "import { u } from '../db/user.mjs';\nexport const a = u;\n",
  });
  try {
    const found = rules(root);
    assert.ok(
      found.some((r) => r.startsWith('lib/rules imports nothing with IO: lib/rules/io-builtin.mjs')),
      found.join('\n'),
    );
    assert.ok(
      found.some((r) => r === 'no fetch under lib/rules: lib/rules/io-fetch.mjs'),
      found.join('\n'),
    );
    assert.ok(
      found.some((r) => r === 'no process access under lib/rules: lib/rules/io-env.mjs'),
      found.join('\n'),
    );
    assert.ok(
      found.some((r) => r.startsWith('edge not in the module map (lib/rules/ -> lib/db/user.mjs)')),
      found.join('\n'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('control: this repository has no import-boundary problem', () => {
  assert.deepEqual(rules(REPO), []);
});

test('audit rows come from the database functions only: no lib/ module writes audit_events, and the user client has one read verb', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.mjs')) files.push(p);
    }
  };
  walk(join(REPO, 'lib'));
  /* E7 design 1.2 rule 1 (evidence/e7-scripts.md; the lead, 2026-09-20): the owner-side modules build SQL TEXT that a
     script under scripts/ runs over the operator's own psql connection. They hold no client, so the text scan above
     is the wrong instrument for them: takeout.mjs selects app.audit_events because it is one of the twenty-one
     export sections, register.mjs's sync reads audit rows to render register lines, deletion.mjs counts the
     section, and reconcile.mjs (day 4) builds the transaction whose last statement calls app.audit. For these the
     rule that matters is asserted instead: none imports the user or the server client, so no PostgREST request can
     carry their text. Every other lib/ module stays under the scan. */
  const OWNER_SIDE_SQL_TEXT = new Set([
    'lib/operator/takeout.mjs',
    'lib/operator/register.mjs',
    'lib/operator/deletion.mjs',
    'lib/operator/reconcile.mjs',
  ]);
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    /* Joined with '/', as every name this test compares is written, so a Windows run compares the same text: the scan
       failed there on the separator alone, which hid whatever it would have found (evidence/ena7-end1-hbf2.md). */
    const rel = f
      .slice(REPO.length + 1)
      .split(sep)
      .join('/');
    if (OWNER_SIDE_SQL_TEXT.has(rel)) {
      if (/db\/(user|server)\.mjs/.test(src)) offenders.push(`${rel} (imports a PostgREST client)`);
      continue;
    }
    if (rel !== 'lib/db/user.mjs' && /audit_events/.test(src)) offenders.push(rel);
    if (/\b(insert|update|delete)\b[^\n]*audit/i.test(src)) offenders.push(`${rel} (write)`);
  }
  assert.deepEqual(offenders, []);
  const user = readFileSync(join(REPO, 'lib', 'db', 'user.mjs'), 'utf8');
  assert.deepEqual(
    [...user.matchAll(/method: '([A-Z]+)'/g)].map((m) => m[1]),
    ['GET'],
  );
  assert.ok(!/Prefer/.test(user), 'no write preferences on the user client');
});

test('M2: an encoded or escaped specifier, a file whose name extends an exact importer exception, and bracket or global access in lib/rules are refused', () => {
  const root = tree({
    ...base,
    /* Node resolves %6f to o: the encoded name reaches lib/db/operator.mjs. */
    'lib/services/members.mjs': "export { o } from '../db/%6fperator.mjs';\n",
    /* A string escape decodes the same way at runtime. */
    'lib/services/escaped.mjs': "import { o } from '../db/\\u006fperator.mjs';\nexport const e = o;\n",
    /* The exact-file exception is lib/services/invitations.mjs, not any name that starts with it. */
    'lib/services/invitations.mjs-extra.mjs': "import { o } from '../db/operator.mjs';\nexport const x = o;\n",
    /* lib/rules IO through forms the two regexes did not see. */
    'lib/rules/roles.mjs': "export const state = () => globalThis['process']['env']['ENTERPRISE_ACCESS_STATE'];\n",
    'lib/rules/bracket.mjs': "export const b = () => process['env'].X;\n",
    'lib/rules/gfetch.mjs': "export const g = () => globalThis.fetch('http://x');\n",
    'lib/rules/alias.mjs': "const f = fetch;\nexport const a = () => f('http://x');\n",
    'lib/rules/req.mjs': "export const r = () => require('node:fs');\n",
    'lib/rules/dyn.mjs': "export const d = () => import('./roles.mjs');\n",
    /* Import contract rule 3 (E2 corrections 2, 2026-09-11): the word constructor is refused under lib/rules,
       so the async function constructor cannot be reached by that name. It moved here from the control below. */
    'lib/rules/ctor.mjs': 'export const c = (x) => x.constructor.name;\n',
  });
  try {
    const found = rules(root);
    const expectSome = (label, pred) => assert.ok(found.some(pred), `${label}; found:\n${found.join('\n')}`);
    expectSome('constructor refused', (r) => r === 'no constructor under lib/rules: lib/rules/ctor.mjs');
    expectSome('encoded specifier', (r) => r.includes('lib/services/members.mjs') && /encoded|escaped/.test(r));
    expectSome('escaped specifier', (r) => r.includes('lib/services/escaped.mjs') && /encoded|escaped/.test(r));
    expectSome(
      'extra file inherits nothing',
      (r) =>
        r ===
        'operator client imported outside lib/operator, scripts, tests, lib/services/invitations.mjs: lib/services/invitations.mjs-extra.mjs -> lib/db/operator.mjs',
    );
    for (const f of ['roles', 'bracket', 'gfetch', 'alias', 'req', 'dyn']) {
      expectSome(`lib/rules/${f}.mjs refused`, (r) => r.includes(`lib/rules/${f}.mjs`) && /under lib\/rules/.test(r));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('M2 control: the exact importer exceptions still hold, and a plain lib/rules module passes', () => {
  const root = tree({
    ...base,
    'lib/rules/plain.mjs': "import { ROLES } from './roles.mjs';\nexport const isRole = (r) => ROLES.includes(r);\n",
    /* Inherited object names are not forbidden forms. Reversed in part by the import contract (rule 3,
       2026-09-11): until 5b2c4b4 this control also read x.constructor.name with zero findings; constructor is
       now a refused word under lib/rules (asserted in the M2 test above), and toString and hasOwnProperty stay. */
    'lib/rules/proto.mjs': "export const s = (x) => `${x.toString()} ${x.hasOwnProperty('a')}`;\n",
    'lib/operator/tool.mjs': "import { o } from '../db/operator.mjs';\nexport const t = o;\n",
    'scripts/tool.mjs': "import { o } from '../lib/db/operator.mjs';\nexport const t = o;\n",
  });
  try {
    assert.deepEqual(rules(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* Rule 4 guard (lead decision Q4, E2 corrections 2; made sound over Codex recheck 3 and 4, M2-R4). The import
   contract follows a client through re-export syntax only; a value flow such as `export const t = o`, or a
   function returning the client, is outside it, so a holder that binds a client to a new export is not a gate
   finding. The compensating control is that every capability holder's exported surface is pinned, and a new
   export fails until reviewed. Recheck 3 defeated a text reading of that surface (comments, a regular
   expression, a nested template, a continuation line). Recheck 4 defeated `await import(holder)`: a holder that
   exports a `then` function makes its namespace a thenable, so the promise machinery calls that `then` and
   `await` resolves to whatever it passes to `resolve` -- an object holding exactly the pinned names -- while the
   real namespace still carries the hidden export. realExports() reads the surface through a generated wrapper
   that binds the holder with a *static* `import * as`, which is not subject to thenable adoption, so
   `Object.keys` sees every export including a `then`; the wrapper itself exports only `names`, so awaiting it is
   safe. holderModules() is the gate's own reference reading, so the holder set is discovered, not hand-listed; a
   new lib/ module importing either client joins it and must be pinned. */
function holderModules() {
  const out = [];
  /* Joined with '/' for the same reason as the audit scan above: on Windows the list came out empty, so the pin below
     failed there for the separator and could not see a new holder (evidence/ena7-end1-hbf2.md). */
  for (const f of readdirSync(join(REPO, 'lib'), { recursive: true })
    .map((x) => String(x).split(sep).join('/'))
    .sort()) {
    if (!f.endsWith('.mjs')) continue;
    const rel = `lib/${f}`;
    const importsClient = moduleReferences(readFileSync(join(REPO, rel), 'utf8'))
      .specifiers.filter(({ spec }) => spec.startsWith('.'))
      .map(({ spec }) => posix.join(posix.dirname(rel), spec))
      .some((target) => target === 'lib/db/operator.mjs' || target === 'lib/db/server.mjs');
    if (importsClient) out.push(rel);
  }
  return out.sort();
}

/* Enumeration primitives captured at test-module load, before any holder runs. A holder's top-level code runs
   when the wrapper below statically imports it, so it could reassign the global `Object.keys` or `Reflect.ownKeys`
   binding to drop a name (recheck 5). These captured references are the original native functions, held in this
   module's scope where a holder has no reach; reassigning the globals does not affect them. A module namespace's
   own keys are fixed by the runtime and cannot be forged, so `OWN_KEYS(namespace)` is its true export surface.
   Scope floor: this defends against a holder that reassigns these globals, not against one that patches every
   intrinsic the comparison below uses; a committer able to do that could equally edit this guard, the pins or the
   scanner, which is below the tripwire's threat model (architecture section 11.1). */
const OWN_KEYS = Reflect.ownKeys;
const SORT = Array.prototype.sort;
const PUSH = Array.prototype.push;

/* The real export names of a module, read through a static-import wrapper. The wrapper binds the holder with a
   static `import * as h` (immune to a thenable `then`, recheck 4) and returns the namespace object itself; the
   names are read here with the captured `OWN_KEYS` (immune to a reassigned `Object.keys`, recheck 5). `moduleUrl`
   is interpolated as a JSON string literal, so a specifier holding a quote cannot break out. */
async function realExports(moduleUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'holder-exports-'));
  const wrapper = join(dir, 'wrapper.mjs');
  writeFileSync(wrapper, `import * as h from ${JSON.stringify(moduleUrl)};\nexport const namespace = h;\n`);
  try {
    const w = await import(pathToFileURL(wrapper).href);
    const keys = OWN_KEYS(w.namespace);
    const names = [];
    /* An index walk over the own-key array, not for-of, so a patched Array iterator cannot skip an entry. */
    for (let i = 0; i < keys.length; i++) if (typeof keys[i] === 'string') PUSH.call(names, keys[i]);
    SORT.call(names);
    return names;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* E4 design 2.6 item 6: lib/services/groups.mjs, lib/services/releases.mjs and lib/services/reviews.mjs joined this pin
   with their export sets in the E4 server lane (evidence/e4-server.md), each a reviewed re-pin. */
const PINNED_HOLDER_EXPORTS = {
  /* E5 design 2.6 item 5: lib/services/catalog.mjs and lib/services/installations.mjs joined this pin with their export
     sets in the E5 server lane (evidence/e5-server.md), each a reviewed re-pin. lib/services/evidence-reads.mjs is not
     here and does not join it: it holds the user client only, which no rule 4 restriction follows. */
  'lib/services/candidates.mjs': [
    'PassportRefused',
    'createCandidate',
    'createSuccessor',
    'listCandidates',
    'readCandidate',
    'readGate',
    'saveCandidate',
    'submissionOf',
    'submitCandidate',
  ],
  /* HB-F2 (migration 012): the verify route's holder of the bound's two routines, because lib/http/ may not reach
     lib/db/ (evidence/ena7-end1-hbf2.md). END_BOUND_MS and OUTCOMES are constants the route and its tests read. */
  'lib/services/factor-bound.mjs': ['END_BOUND_MS', 'OUTCOMES', 'beginVerification', 'endVerification'],
  'lib/services/groups.mjs': ['addGroupMember', 'createGroup', 'removeGroupMember'],
  /* E6 design 1.2 and 2.6 item 5: handover delivery, the resend and the accept-URL assembly the two operator-issued
     invitations share, each a reviewed re-pin. deliverInvitation and assembleAcceptUrl are exported so that
     lib/services/operator.mjs builds the same link the admin's path builds, rather than a second copy of it; they
     hold no client of their own and inherit this module's restriction by being in it. requireDelivery is exported
     for the same reason and by E6S-C-F8: the two operator-issued invitations called deliverInvitation after their
     database transaction and never this guard, so mail mode with no transport committed a company and a live
     secret and then answered 502, and the guard belongs in front of all four invitation paths rather than three. */
  /* E7M-C-F2 (b1dbdd0, re-pinned at B4-R-F1): acceptOrigin is the one reader of ENTERPRISE_ORIGIN's shape, exported
     so that requireDelivery's refusal before the write and assembleAcceptUrl's link after it cannot disagree, and so
     that tests/e6/unit pins the shape directly. It reads process.env and no client. */
  'lib/services/invitations.mjs': [
    'ACCOUNT_LINK_FAILED',
    'DELIVERY_MODES',
    'acceptInvitation',
    'acceptOrigin',
    'assembleAcceptUrl',
    'createInvitation',
    'createInviteeAccount',
    'deliverInvitation',
    'deliveryMode',
    'normalizeEmail',
    'requireDelivery',
    'resendInvitation',
    'revokeInvitation',
  ],
  'lib/services/members.mjs': ['removeMember', 'requireAdminPrincipal', 'setRoles'],
  /* E6 design 2.6 item 5 as the corrections list it, with two differences this lane records rather than hides.
     (1) provisionCompany is GONE: POST /api/operator/companies is api.create_company since E6 and nothing else
     called the E2 service function, so it was removed with the route it served (lead decision, 2026-09-17).
     (2) lib/services/quotas.mjs is NOT here and does not join this pin: it holds the USER client only, which no
     rule 4 restriction follows, exactly as lib/services/evidence-reads.mjs does not. The guard discovers its own
     holder set from the gate's reference reading, so a module listed here that holds no client would fail the
     first assertion rather than tighten anything. */
  'lib/services/operator.mjs': [
    'closeCompany',
    'createCompany',
    'deleteCompany',
    'inviteAdmin',
    'readExportManifest',
    'readRegister',
    'runExpiry',
    'setAccessPeriod',
    'setCompanyStatus',
    'setQuota',
    'transferFirstAdmin',
  ],
  'lib/services/agents.mjs': ['readAgent', 'transferAgent'],
  'lib/services/lifecycle.mjs': ['departurePreview'],
  'lib/services/takeout.mjs': ['takeCompanyCopy'],
  'lib/operator/accounts.mjs': ['RECORD_BATCH', 'deleteAccount', 'deleteFactor', 'sweepAccounts'],
  'lib/services/profiles.mjs': ['setDisplayName'],
  'lib/services/catalog.mjs': ['authorizeDownload', 'readCatalog'],
  'lib/services/installations.mjs': ['readInstallations', 'reportInstallation', 'witnessInstallation'],
  'lib/services/releases.mjs': ['listReleases', 'publishRelease', 'readRelease', 'withdrawRelease'],
  'lib/services/reviews.mjs': ['createEnvelope', 'readReview', 'readReviewQueue', 'recordReview'],
};

test('rule 4 guard: the real exports of every lib/ module importing the operator or server client are pinned', async () => {
  assert.deepEqual(holderModules(), Object.keys(PINNED_HOLDER_EXPORTS).sort(), 'the set of capability holders changed');
  for (const [rel, pinned] of Object.entries(PINNED_HOLDER_EXPORTS)) {
    const names = await realExports(pathToFileURL(join(REPO, rel)).href);
    assert.deepEqual(names, [...pinned].sort(), `exports of ${rel} changed; review before pinning`);
  }
});

/* The soundness regression: a module that hides an added export in each form the recheck critics used -- the six
   recheck-3 text-scan bypasses (a same-line second declarator, a comment or a string with an unbalanced
   bracket, a regular expression, a nested template, a continuation line) and the recheck-4 thenable, an exported
   `then` that would substitute the namespace under `await`. realExports() sees every one; the plain
   `await import` on the same module does not, which is why the guard uses the wrapper. */
test('rule 4 guard regression: the wrapper sees exports a text scan or a thenable then would hide', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holder-guard-'));
  const rel = join(dir, 'holder.mjs');
  writeFileSync(
    rel,
    [
      'const impl = 1;',
      'export const sameLine = impl, hiddenA = impl;',
      'export const commentBracket = impl /* ( */, hiddenB = impl;',
      "export const commentQuote = impl /* ' */, hiddenC = impl;",
      "export const regex = /[{]/.test('') ? impl : impl, hiddenD = impl;",
      'export const nestedTemplate = `${`(`}` && impl, hiddenE = impl;',
      'export const continuation = impl',
      '  , hiddenF = impl;',
      'export const hiddenG = impl;',
      'export function then(resolve) {',
      '  resolve({ sameLine, commentBracket, commentQuote, regex, nestedTemplate, continuation });',
      '}',
      '',
    ].join('\n'),
  );
  const url = pathToFileURL(rel).href;
  const viaWrapper = await realExports(url);
  const viaAwait = Object.keys(await import(url)).sort();
  rmSync(dir, { recursive: true, force: true });
  const hidden = viaWrapper.filter((k) => k.startsWith('hidden')).sort();
  assert.deepEqual(
    hidden,
    ['hiddenA', 'hiddenB', 'hiddenC', 'hiddenD', 'hiddenE', 'hiddenF', 'hiddenG'],
    viaWrapper.join(','),
  );
  assert.ok(viaWrapper.includes('then'), 'the wrapper sees the then export');
  /* The thenable substitutes the namespace under await, so the naive reading misses every hidden name: the
     control that proves the wrapper is doing the work. */
  assert.ok(
    !viaAwait.some((k) => k.startsWith('hidden')),
    `await import should be fooled by the thenable, saw ${viaAwait.join(',')}`,
  );
});

/* Recheck 5: a holder that reassigns the global Object.keys or Reflect.ownKeys at its top-level, so a wrapper
   that read exports with the live global would omit the added name. realExports reads with OWN_KEYS captured at
   this module's load, before any holder runs, so the reassignment does not reach it. */
test('rule 4 guard regression: a holder reassigning Object.keys or Reflect.ownKeys cannot hide an export', async () => {
  for (const tamper of [
    "Object.keys = (v) => Reflect.ownKeys(v).filter((n) => n !== 'leaked' && typeof n === 'string');",
    "Reflect.ownKeys = (() => { const real = Reflect.ownKeys; return (v) => real(v).filter((n) => n !== 'leaked'); })();",
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'holder-intrinsic-'));
    const rel = join(dir, 'holder.mjs');
    writeFileSync(rel, `${tamper}\nexport const kept = 1;\nexport const leaked = 2;\n`);
    const names = await realExports(pathToFileURL(rel).href);
    rmSync(dir, { recursive: true, force: true });
    assert.ok(
      names.includes('leaked'),
      `captured enumeration missed the export after ${tamper.slice(0, 24)}: ${names.join(',')}`,
    );
  }
});
