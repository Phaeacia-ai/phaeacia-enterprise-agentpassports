/* K7 (evidence/hardening-k.md; XR-5 in evidence/external-review-2026-09-28.md): every UNBOUND call into the api
   schema that lib/ makes, `callAs(session, name, { ... })` or `rpc(name, { ... }, token)`, sends only keys that are
   parameters of that function as the migrations last define it, and every parameter without a default. BOUND calls
   are outside this file: their argument lists are lib/db/server.mjs FIELDS, whose SQL tests/e3/unit/migration-text
   pins verbatim against the migrations. An unbound call had no such check, so a key renamed on one side reached
   PostgREST as a call to no function, which answers 404 and maps to E_NOT_FOUND or E_INTERNAL at request time.

   Stack-free and text only. The call sites are found in lib/ with comments blanked, member calls (`x.callAs(`)
   included; each site's name must be a string literal or a variable this file names with the literals it takes
   (PARAMETER_NAMES), and its arguments an object literal of plain keys and shorthands, so a spread or a variable
   argument fails here until somebody classifies it. So that no call hides under another name, lib/db/server.mjs may be
   imported outside lib/db/ only by a plain named import, never re-exported, and callAs and rpc are never aliased or
   used as a value (the peer check's CK-5: a namespace call, an aliased import and a namespace rpc all passed).
   The definitions are the last `create or replace function api.<name>(` across supabase/migrations/ in version order,
   with a later `drop function api.<name>` removing it; an OUT parameter is not an argument. The set of sites is pinned
   as a literal (the shape of tests/e8/unit/stderr-shape.test.mjs SITES), so a scanner that stopped seeing a site fails
   rather than passing on fewer sites.

   FAIL-BEFORE: the last case copies lib/ and supabase/migrations/ into a scratch directory, renames one key of one
   call (create_group's p_name to p_title) and one parameter of another definition (departure_preview's p_membership
   to p_member), and requires the scan to name exactly those two sites. */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { after, test } from 'node:test';

const REPO = join(import.meta.dirname, '..', '..', '..');
const { FUNCTIONS } = await import('../../../lib/db/server.mjs');

const scratchDirs = [];
after(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

/* The text with every comment replaced by spaces, strings and template literals skipped, so indices line up. */
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

/* The text with the contents of every string and template literal replaced by spaces, quotes kept. */
function blankStrings(text) {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < text.length && text[i] !== c) {
        const step = text[i] === '\\' ? 2 : 1;
        for (let k = i; k < i + step && k < text.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
        i += step;
      }
      i += 1;
    } else i += 1;
  }
  return out.join('');
}

/* How a file outside lib/db/ may reach the two callers: a plain named import of lib/db/server.mjs, and a call by the
   imported name. Anything else could send a call this scan never sees. */
function reachProblems(rel, code) {
  const problems = [];
  const imports = [...code.matchAll(/\b(import|export)\s+([^;]*?)\s+from\s+'([^']*db\/server\.mjs)'/g)];
  for (const [, verb, clause] of imports) {
    const names = /^\{([^}]*)\}$/.exec(clause.trim());
    if (verb === 'export' || names === null)
      problems.push(
        `${rel}: ${verb} ${clause.replace(/\s+/g, ' ')} from lib/db/server.mjs is not a plain named import`,
      );
    else
      for (const n of names[1]
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean))
        if (/\s+as\s+/.test(n)) problems.push(`${rel}: the import ${n} renames a name of lib/db/server.mjs`);
  }
  /* Both blankings keep every index, so an import is removed by its position in `code`. */
  let bare = blankStrings(code);
  for (const m of imports) bare = bare.slice(0, m.index) + ' '.repeat(m[0].length) + bare.slice(m.index + m[0].length);
  for (const m of bare.matchAll(/(?<![\w$])(callAs|rpc)\b(?!\s*\()/g))
    problems.push(`${rel}: ${m[1]} is used as a value, not called by its name`);
  return problems;
}

/* The balanced group opened at `open` (one of ( { [), split at its depth-1 commas; quotes are skipped. Returns the
   trimmed entries, the index in `text` where each entry's first character stands, and the index of the closing
   character. */
function groupAt(text, open) {
  const closeOf = { '(': ')', '{': '}', '[': ']' };
  assert.ok(closeOf[text[open]], `a group opens at ${open}`);
  let depth = 0;
  const cuts = [];
  let i = open;
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1;
    } else if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) break;
    } else if (c === ',' && depth === 1) cuts.push(i);
  }
  const entries = [];
  const starts = [];
  let from = open + 1;
  for (const cut of [...cuts, i]) {
    const raw = text.slice(from, cut);
    const entry = raw.replace(/\s+/g, ' ').trim();
    if (entry.length > 0) {
      entries.push(entry);
      starts.push(from + (raw.length - raw.trimStart().length));
    }
    from = cut + 1;
  }
  return { entries, starts, close: i };
}

function sources(root, dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      /* Joined with '/', as the SITES names are written, so a Windows run compares the same text: K7 failed there on
         the separator alone, which hid the sites a change adds (evidence/ena7-end1-hbf2.md). */ else if (
        entry.name.endsWith('.mjs')
      )
        out.push({ rel: relative(root, path).split(sep).join('/'), text: readFileSync(path, 'utf8') });
    }
  };
  walk(join(root, dir));
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/* Names passed as a variable, with the literals the file passes into it. A new variable name fails the scan until it
   is listed here with a decision; each literal must occur in the file as a quoted string. */
const PARAMETER_NAMES = {
  'lib/services/groups.mjs fn': ['add_group_member', 'remove_group_member'],
};

/** Every unbound call site under lib/ outside lib/db/: { rel, via, names, keys | null, entry }. */
function callSites(root) {
  const sites = [];
  const problems = [];
  for (const { rel, text } of sources(root, 'lib')) {
    if (rel.startsWith('lib/db/')) continue;
    const code = blankComments(text);
    problems.push(...reachProblems(rel, code));
    for (const m of code.matchAll(/(?<![\w$])(callAs|rpc)\s*\(/g)) {
      const via = m[1];
      if (/function\s*$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
      const { entries, starts } = groupAt(code, m.index + m[0].length - 1);
      const [nameAt, argsAt] = via === 'callAs' ? [1, 2] : [0, 1];
      const nameEntry = entries[nameAt];
      const argsEntry = entries[argsAt];
      let names;
      const literal = /^'([a-z_][a-z0-9_]*)'$/.exec(nameEntry ?? '');
      if (literal) names = [literal[1]];
      else if (/^[A-Za-z_$][\w$]*$/.test(nameEntry ?? '') && PARAMETER_NAMES[`${rel} ${nameEntry}`]) {
        names = PARAMETER_NAMES[`${rel} ${nameEntry}`];
        for (const n of names)
          if (!text.includes(`'${n}'`))
            problems.push(`${rel}: ${nameEntry} is listed as taking '${n}', which the file never names`);
      } else {
        problems.push(`${rel}: a ${via} call whose name is neither a literal nor a listed variable (${nameEntry})`);
        continue;
      }
      let keys = null;
      if (argsEntry?.startsWith('{')) {
        keys = [];
        for (const e of groupAt(code, starts[argsAt]).entries) {
          const k = /^([A-Za-z_$][\w$]*)(?:\s*:.*)?$/s.exec(e);
          if (k) keys.push(k[1]);
          else
            problems.push(`${rel}: ${via}(${names.join('|')}) has an argument entry this scan cannot classify (${e})`);
        }
      } else
        problems.push(
          `${rel}: ${via}(${names.join('|')}) passes arguments that are not an object literal (${argsEntry})`,
        );
      for (const name of names) sites.push({ rel, via, name, keys });
    }
  }
  return { sites, problems };
}

/** The api functions as the migrations last define them: name -> { file, params: [{ name, mode, hasDefault }] }. */
function definitions(root) {
  const dir = join(root, 'supabase', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const defs = new Map();
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8').replace(/--[^\n]*/g, (s) => ' '.repeat(s.length));
    const events = [];
    for (const m of text.matchAll(/create\s+or\s+replace\s+function\s+api\.([a-z_][a-z0-9_]*)\s*\(/gi))
      events.push({ at: m.index, kind: 'define', name: m[1].toLowerCase(), open: m.index + m[0].length - 1 });
    for (const m of text.matchAll(/drop\s+function\s+(?:if\s+exists\s+)?api\.([a-z_][a-z0-9_]*)/gi))
      events.push({ at: m.index, kind: 'drop', name: m[1].toLowerCase() });
    for (const e of events.sort((a, b) => a.at - b.at)) {
      if (e.kind === 'drop') {
        defs.delete(e.name);
        continue;
      }
      const params = groupAt(text, e.open).entries.map((p) => {
        const words = p.split(/\s+/);
        const mode = ['in', 'out', 'inout', 'variadic'].includes(words[0].toLowerCase())
          ? words.shift().toLowerCase()
          : 'in';
        return { name: words[0].toLowerCase(), mode, hasDefault: /\s(default\s|=\s*)/i.test(` ${p}`) };
      });
      defs.set(e.name, { file, params });
    }
  }
  return defs;
}

/** The problems of one scan over `root`: sites that cannot be read, and keys that are not parameters. */
function rpcProblems(root) {
  const { sites, problems } = callSites(root);
  const defs = definitions(root);
  for (const { rel, via, name, keys } of sites) {
    const where = `${rel} ${via}(${name})`;
    if (!FUNCTIONS.includes(name)) problems.push(`${where}: not a name lib/db/server.mjs FUNCTIONS admits`);
    const def = defs.get(name);
    if (def === undefined) {
      problems.push(`${where}: no create or replace function api.${name}( in supabase/migrations`);
      continue;
    }
    if (keys === null) continue;
    const inputs = def.params.filter((p) => p.mode !== 'out');
    for (const k of keys)
      if (!inputs.some((p) => p.name === k))
        problems.push(`${where}: ${k} is not a parameter of api.${name} (${def.file})`);
    for (const p of inputs)
      if (!p.hasDefault && !keys.includes(p.name))
        problems.push(`${where}: omits ${p.name}, which api.${name} has without a default (${def.file})`);
  }
  return { problems, sites };
}

/* The pinned set of sites, `rel name`, one entry per name a site calls. */
const SITES = [
  'lib/services/agents.mjs transfer_agent',
  'lib/services/catalog.mjs authorize_download',
  /* HB-F2 (migration 012): the verify route's bound, begin and end, through their holder. */
  'lib/services/factor-bound.mjs mfa_verify_begin',
  'lib/services/factor-bound.mjs mfa_verify_end',
  'lib/services/groups.mjs add_group_member',
  'lib/services/groups.mjs create_group',
  'lib/services/groups.mjs remove_group_member',
  'lib/services/invitations.mjs accept_invitation',
  /* ENA-7 (migration 011): the handover claim. */
  'lib/services/invitations.mjs claim_invitation_handover',
  'lib/services/invitations.mjs invite_member',
  'lib/services/invitations.mjs invite_member',
  'lib/services/invitations.mjs record_invitation_delivery',
  'lib/services/invitations.mjs revoke_invitation',
  'lib/services/lifecycle.mjs departure_preview',
  'lib/services/members.mjs remove_member',
  'lib/services/members.mjs set_roles',
  'lib/services/operator.mjs close_company',
  'lib/services/operator.mjs create_company',
  'lib/services/operator.mjs delete_company',
  'lib/services/operator.mjs operator_expiry_run',
  'lib/services/operator.mjs operator_export_manifest',
  'lib/services/operator.mjs operator_export_manifest',
  'lib/services/operator.mjs operator_invite_admin',
  'lib/services/operator.mjs operator_register',
  'lib/services/operator.mjs set_access_period',
  'lib/services/operator.mjs set_company_quota',
  'lib/services/operator.mjs set_company_status',
  'lib/services/operator.mjs transfer_first_admin',
  'lib/services/profiles.mjs set_display_name',
  'lib/services/takeout.mjs export_company',
];

test('K7: every unbound callAs/rpc site in lib/ sends only parameters of the api function the migrations last define, and every one without a default', () => {
  const { problems, sites } = rpcProblems(REPO);
  assert.deepEqual(problems, []);
  assert.deepEqual(sites.map((s) => `${s.rel} ${s.name}`).sort(), [...SITES].sort());
});

test('K7 fail-before: a renamed key and a renamed parameter are each named by the scan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'k7-mutant-'));
  scratchDirs.push(dir);
  cpSync(join(REPO, 'lib'), join(dir, 'lib'), { recursive: true });
  cpSync(join(REPO, 'supabase', 'migrations'), join(dir, 'supabase', 'migrations'), { recursive: true });
  const mutate = (rel, from, to) => {
    const path = join(dir, rel);
    const text = readFileSync(path, 'utf8');
    assert.equal(text.split(from).length - 1, 1, `${rel}: "${from}" occurs once`);
    writeFileSync(path, text.replace(from, to));
  };
  assert.deepEqual(rpcProblems(dir).problems, [], 'the unmutated copy is clean');
  mutate(
    'lib/services/groups.mjs',
    "callAs(session, 'create_group', { p_company: companyId, p_name: name }, options)",
    "callAs(session, 'create_group', { p_company: companyId, p_title: name }, options)",
  );
  mutate(
    'supabase/migrations/008_lifecycle.sql',
    'create or replace function api.departure_preview(p_membership uuid)',
    'create or replace function api.departure_preview(p_member uuid)',
  );
  assert.deepEqual(rpcProblems(dir).problems.sort(), [
    'lib/services/groups.mjs callAs(create_group): omits p_name, which api.create_group has without a default (008_lifecycle.sql)',
    'lib/services/groups.mjs callAs(create_group): p_title is not a parameter of api.create_group (008_lifecycle.sql)',
    'lib/services/lifecycle.mjs callAs(departure_preview): omits p_member, which api.departure_preview has without a default (008_lifecycle.sql)',
    'lib/services/lifecycle.mjs callAs(departure_preview): p_membership is not a parameter of api.departure_preview (008_lifecycle.sql)',
  ]);
});

test('K7 fail-before (CK-5): a namespace call, a namespace import, an aliased import and a caller passed as a value are each named', () => {
  const dir = mkdtempSync(join(tmpdir(), 'k7-reach-'));
  scratchDirs.push(dir);
  cpSync(join(REPO, 'lib'), join(dir, 'lib'), { recursive: true });
  cpSync(join(REPO, 'supabase', 'migrations'), join(dir, 'supabase', 'migrations'), { recursive: true });
  writeFileSync(
    join(dir, 'lib', 'services', 'zz-reach.mjs'),
    [
      "import * as server from '../db/server.mjs';",
      "import { callAs as call } from '../db/server.mjs';",
      "export const a = (s) => server.callAs(s, 'create_group', { p_company: 'x', p_title: 'y' });",
      "export const b = (s) => call(s, 'set_display_name', { p_nonexistent: 1 });",
      'export const c = server.rpc;',
      '',
    ].join('\n'),
  );
  assert.deepEqual(rpcProblems(dir).problems.sort(), [
    'lib/services/zz-reach.mjs callAs(create_group): omits p_name, which api.create_group has without a default (008_lifecycle.sql)',
    'lib/services/zz-reach.mjs callAs(create_group): p_title is not a parameter of api.create_group (008_lifecycle.sql)',
    'lib/services/zz-reach.mjs: import * as server from lib/db/server.mjs is not a plain named import',
    'lib/services/zz-reach.mjs: rpc is used as a value, not called by its name',
    'lib/services/zz-reach.mjs: the import callAs as call renames a name of lib/db/server.mjs',
  ]);
});
