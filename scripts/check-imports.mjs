#!/usr/bin/env node
/* Import-boundary check (architecture section 11, adapter section 4).

   This gate is the authoritative boundary for module references. It implements
   the contract of docs/setup/import-check-reassessment.md (option B, section
   4, with rule 7 from section 4a) as amended by the lead's answers of
   2026-09-11 (E2 corrections 2, evidence/e2-corrections-2.md). It does not
   parse JavaScript: lib/ and netlify/ are written in a small line grammar, and
   whatever falls outside the grammar is refused rather than interpreted. A form
   someone needs is a contract change reviewed by the lead.

   The contract for lib/ and netlify/:

     1. File set. Every entry is examined with lstat; no name is skipped at any
        depth. A symbolic link is refused. A file name must match
        ^[a-z0-9][a-z0-9-]*\.mjs$ and a directory name ^[a-z0-9][a-z0-9-]*$;
        any other name (node_modules and dot-directories included) and any
        other kind of entry is refused. Files whose names Node can run (.mjs
        .js .cjs .mts .cts .ts) are read even when refused, so their
        references are reported too.
     2. Module references. Accepted only as a whole line at column 0, with the
        spacing Biome writes, in one of these forms:
          import '<spec>';
          import <bindings> from '<spec>';
          export * from '<spec>';
          export * as <name> from '<spec>';
          export { <names> } from '<spec>';
        <spec> is node:[a-z_]+(/[a-z_]+)? or one or more ./ or ../ followed by
        segments of [a-z0-9_-] ending in .mjs, in single quotes, so it holds no
        "%", backslash, "?", "#", uppercase letter, control character or
        attributes clause. <bindings> is <name>, * as <name>, { <names> } or
        <name>, { <names> }; <names> is a comma-separated list of <name> or
        <name> as <name>. Every reference read from a file here, accepted line
        or not, must carry a <spec> of this grammar. A relative <spec> must
        name, by exact string, a file rule 1 accepts or a regular file under
        vendor/passport/ (listed with lstat for this purpose only and never
        read; a link or other entry there is not listed), so a case variant, a
        link or a missing file is refused on every filesystem. The allowlist
        and the edge rules of rule 6 then decide whether the edge is permitted.
        A node: <spec> must name node:crypto, node:fs or node:path, the three
        built-ins lib/ and netlify/ use; node:module, node:vm,
        node:worker_threads, node:child_process and every other built-in load
        or run code outside this graph and are refused (lead, 2026-09-11).
     3. Raw-text refusals over the whole source, comments, strings, templates
        and regular expressions included: the word import followed by "(";
        require; eval; Function followed by "("; the module loaders
        createRequire, getBuiltinModule and dlopen; a backslash followed by u or
        x; and every other occurrence of the word import that does not begin an
        accepted line and is not import.meta. Under lib/rules/ additionally the
        words fetch, process, globalThis, Reflect, Proxy and constructor, and
        any node: specifier.
     4. Transitive sensitivity. A module carries lib/db/operator.mjs or
        lib/db/server.mjs when it re-exports that client or another carrier
        through an export ... from line, or when it re-exports a binding that
        an accepted import line takes from one (default, named, aliased or
        namespace) through export { name };, export { name as alias }; or
        export default name;. Every module referring to a carrier must be one
        the client's own importer restriction allows. A value flow such as
        export const t = o, or a function returning the client, is not syntax
        and is outside the contract; tests/e2/unit/boundaries.test.mjs pins the
        export names of every lib/ module importing either client, so a new
        export on a capability holder fails until it is reviewed.
     5. Capability anchor. The name SUPABASE_SERVICE_ROLE_KEY appears only in
        lib/db/operator.mjs, which catches a copy of the operator client under
        another name.
     6. Everything that is not syntax stays as before: the module map
        (section 1), the refusal of lib/ directories the map does not name,
        importers of the lock's test_only_paths outside vendor/ and tests/,
        lib/ imports of vendor paths outside allowlist.runtime, "fetch(" and
        "child_process" under lib/passport/, the operator client outside
        lib/operator/, scripts/, tests/ and the exact file
        lib/services/invitations.mjs, the server client outside lib/services/
        and lib/operator/ (tests excepted), any lib/db/ client from
        netlify/functions/, package imports outside scripts/ and tests/, and
        cycles. Directory exceptions match by prefix ending in "/", file
        exceptions by equality.
     7. Export recognition. Every occurrence of the word export must begin, at
        column 0, either an export form of rule 2 or a local export: export
        const, let, function, async function or class followed by <name>;
        export default, the rest of the line holding no from followed by a
        quote; or export { <names> }; without from. Anything else is refused:
        a multi-line, indented or attributes-bearing re-export, and the word in
        a comment or string.

   Named exception, lead decision 2026-09-11. lib/passport/render.mjs is
   derived from the pinned vendor renderer, and upstream.lock.json registers
   its bytes in the derived entry whose path is lib/passport/render.mjs
   (adapter contract R3, checked by import-passport.mjs --verify). While the
   file's SHA-256 equals that entry's derived_sha256, read at gate time and
   matched by path, exactly three things are exempt: a named import list split
   over lines, accepted only as "import {", one "  <name>," or
   "  <name> as <name>," per line and "} from '<spec>';"; the words import and
   export where they are not the first word of their line (rules 3 and 7); and
   the refusal of a backslash followed by u or x. The specifier grammar,
   exact-name resolution, import followed by "(", require, eval, Function and
   rules 1, 4, 5 and 6 apply to it as to any file. A missing entry or a
   different hash withdraws the exception, is reported, and leaves the file
   under the full contract. tests/passport/checks.test.mjs pins the references
   read from the file at its registered hash. Open item for the Passport
   specialist: remove the escapes and the split import at the next
   re-derivation, then this exception.

   web/, the third restricted tree (pages design 4.5, revision 7). The published pages and their browser modules live
   there, and the contract above applies with these differences. Rule 1: a file name must match
   ^[a-z0-9][a-z0-9-]*\.(mjs|html|css|svg)$, so nothing executable but .mjs may sit there; .html, .css and .svg files are
   named and never read. Rule 2: a <spec> under web/ is relative only, one or more ./ or ../ then segments of
   [a-z0-9-] ending in .mjs, naming a walked web/ file by exact string; a node: specifier or a bare package name is
   refused, because a browser has neither. Rules 3, 5 and 7 apply unchanged, their findings reported as under web/. The
   map edge 'web/': ['web/'] refuses a web/ module reaching lib/, and lib/ and netlify/ reaching web/ are refused by
   their own edges. The browser-safety rules of the pages design section 3 are not import rules and live in
   scripts/check-web.mjs.

   Outside lib/, netlify/ and web/, edges are unrestricted as before and the walk
   skips vendor/, node_modules/, .scratch/ and .git/ by name. References are
   read from the raw text: import and export statements whose first word
   begins a line (leading blanks and line breaks inside the statement
   allowed), and import() or require() anywhere that is not a property access.
   That reading over-approximates (text in a comment or string with those
   shapes counts) and misses a statement that does not begin a line; it is
   exact for lib/ and netlify/ only because rules 2, 3 and 7 refuse every other
   form there. scripts/ and other files keep the rule 6 checks that name them,
   the refusal of a specifier holding "%", a backslash, whitespace or a control
   character, and exact-name resolution for targets under lib/, netlify/ and
   vendor/passport/. tests/, whose edges and targets no rule restricts, is read
   for the cycle check only.

   What the contract does not claim: names assembled at runtime, capabilities
   passed as values and data-driven behavior are not syntax, so name rules
   bound the syntax and never prove the absence of IO under lib/rules. That
   proof is the node:vm follow-up named in the reassessment's section 4.

   Exported for tests and tools: checkImports(root), moduleReferences(source),
   specifiers(source) and acceptedLines(source). Dependency-free. Exit 0 clean,
   2 on findings. --root <dir> checks another tree (tests). */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESTRICTED_TREES = new Set(['lib', 'netlify', 'web']);
/* Skipped by name outside lib/, netlify/ and web/ only; inside them nothing is skipped (P1b). */
const SKIP = new Set(['vendor', 'node_modules', '.scratch', '.git']);
const EXTENSIONS = ['.mjs', '.js', '.cjs'];

/* Module map edges (architecture section 1). Key: importer directory prefix.
   Value: importee prefixes it may reach. Node built-ins are allowed everywhere
   except lib/rules, which imports nothing with IO. */
/* Pages design 4.1 (revision 7) changed three edges: web/ reaches web/ and nothing else (4.5, O11); lib/auth/ is factor
   management against GoTrue with the caller's own token, reaching lib/session.mjs and nothing else; lib/http/ composes
   it. lib/services/ still cannot reach lib/session.mjs, and no tree but tests/ may reach web/. */
const EDGES = {
  'web/': ['web/'],
  'netlify/functions/': ['lib/http/', 'lib/services/', 'lib/errors.mjs', 'lib/session.mjs'],
  'lib/http/': ['lib/http/', 'lib/services/', 'lib/rules/', 'lib/auth/', 'lib/errors.mjs', 'lib/session.mjs'],
  'lib/auth/': ['lib/auth/', 'lib/session.mjs'],
  'lib/services/': ['lib/rules/', 'lib/db/', 'lib/passport/', 'lib/errors.mjs', 'lib/services/'],
  'lib/rules/': ['lib/rules/'],
  'lib/passport/': ['lib/passport/', 'vendor/passport/'],
  'lib/db/': ['lib/db/', 'lib/errors.mjs', 'lib/session.mjs'],
  'lib/operator/': ['lib/operator/', 'lib/db/', 'lib/services/', 'lib/rules/', 'lib/errors.mjs'],
  'lib/session.mjs': [],
  'lib/errors.mjs': [],
  'scripts/': ['*'],
  'tests/': ['*'],
};
/* E2 design section 8.1 forbidden edges (added by the E2 implementation, 2026-09-10):
   the operator client (service key) is imported only by lib/operator/, scripts/ and the one
   service function's module; the server client (app_server token) only by lib/services/ and
   lib/operator/; a handler never imports a database client; lib/rules has no IO of any kind. */
const OPERATOR_CLIENT = 'lib/db/operator.mjs';
const OPERATOR_IMPORTERS = ['lib/operator/', 'scripts/', 'tests/', 'lib/services/invitations.mjs'];
const SERVER_CLIENT = 'lib/db/server.mjs';
const SERVER_IMPORTERS = ['lib/services/', 'lib/operator/', 'tests/'];
const HANDLERS = 'netlify/functions/';
const DB_CLIENTS = 'lib/db/';
/* Rule 4: the clients whose importer restriction a carrier inherits. */
const SENSITIVE_CLIENTS = [
  {
    module: OPERATOR_CLIENT,
    importers: OPERATOR_IMPORTERS,
    rule: 'operator client re-exported to an importer outside lib/operator, scripts, tests, lib/services/invitations.mjs',
  },
  {
    module: SERVER_CLIENT,
    importers: SERVER_IMPORTERS,
    rule: 'server client re-exported to an importer outside lib/services, lib/operator',
  },
];

/* ---------- the contract: rules 1, 2, 3, 5 and 7 ---------- */

/* Rule 1. Under web/ the file name admits the page, style and image types as well (pages design 4.5). */
const FILE_NAME = /^[a-z0-9][a-z0-9-]*\.mjs$/;
const WEB_FILE_NAME = /^[a-z0-9][a-z0-9-]*\.(?:mjs|html|css|svg)$/;
const DIRECTORY_NAME = /^[a-z0-9][a-z0-9-]*$/;
const RUNNABLE_NAME = /\.[cm]?[jt]s$/;
/* Rule 2 under web/: relative .mjs specifiers only. */
const WEB_SPEC_TEXT = /^(?:\.\.?\/)+[a-z0-9-]+(?:\/[a-z0-9-]+)*\.mjs$/;
const isWeb = (rel) => rel.startsWith('web/');

/* Rules 2 and 7: the accepted-line grammar. */
const NAME = '[A-Za-z_$][A-Za-z0-9_$]*';
const NAMES = `${NAME}(?: as ${NAME})?(?:, ${NAME}(?: as ${NAME})?)*`;
const SPEC = 'node:[a-z_]+(?:/[a-z_]+)?|(?:\\.\\.?/)+[a-z0-9_-]+(?:/[a-z0-9_-]+)*\\.mjs';
const SPEC_TEXT = new RegExp(`^(?:${SPEC})$`);
const BINDINGS = `(?:${NAME}|\\* as ${NAME}|\\{ ${NAMES} \\}|${NAME}, \\{ ${NAMES} \\})`;
const IMPORT_LINE = new RegExp(`^import (?:(${BINDINGS}) from )?'(${SPEC})';$`);
const EXPORT_FROM_LINE = new RegExp(`^export (\\*|\\* as ${NAME}|\\{ ${NAMES} \\}) from '(${SPEC})';$`);
const EXPORT_DECLARATION_LINE = new RegExp(
  `^export (?:const|let|function|async function|class) (${NAME})(?![A-Za-z0-9_$])`,
);
const EXPORT_LIST_LINE = new RegExp(`^export \\{ (${NAMES}) \\};$`);
const EXPORT_DEFAULT_LINE = /^export default(?![A-Za-z0-9_$])(.*)$/;
const DEFAULT_FROM = /\bfrom\s*['"`]/;
const DEFAULT_NAME = new RegExp(`^ (${NAME});$`);
/* The named exception's split import list. */
const SPLIT_IMPORT_ITEM = new RegExp(`^  ${NAME}(?: as ${NAME})?,$`);
const SPLIT_IMPORT_CLOSE = new RegExp(`^\\} from '(?:${SPEC})';$`);

/* Rule 3. */
const WORD = /\b(import|export)\b/g;
const OPEN_PAREN = /\s*\(/y;
const IMPORT_META = /\.meta(?![A-Za-z0-9_$])/y;
const TEXT_REFUSALS = [
  [/\brequire\b/g, 'require refused under lib/ and netlify/'],
  [/\beval\b/g, 'eval refused under lib/ and netlify/'],
  [/\bFunction\s*\(/g, 'Function( refused under lib/ and netlify/'],
  /* Loaders that reach a module by path, or node:module without an import line. At 6898c45, createRequire
     from node:module and process.getBuiltinModule each gave a lib/http module the operator client by a
     literal path with no finding (lead reproduction, 2026-09-11, evidence/e1-lead.md). mainModule added
     after the Codex recheck M2-R3: process.mainModule.constructor._load reaches the module class from a
     CommonJS entry (evidence/e2-corrections-2-recheck.md). Loader guarantees are about the module graph the
     ESM loader builds; a CommonJS entry that exposes process.mainModule is the runtime scope this closes. */
  [/\b(?:createRequire|getBuiltinModule|mainModule|dlopen)\b/g, 'module loader refused under lib/ and netlify/'],
];
/* Rule 2: the node: built-ins lib/ and netlify/ may name; lib/rules names none. */
const BUILTIN_ALLOWLIST = new Set(['node:crypto', 'node:fs', 'node:path']);
const ESCAPE_REFUSAL = [/\\[ux]/g, 'unicode or hex escape sequence refused under lib/ and netlify/'];
/* Rule 3 under lib/rules, each reported once per file. The require and import( entries keep the
   wording of the E2 M2 correction, which the boundary tests assert. */
const RULES_WORDS = [
  [/\bfetch\b/, 'no fetch under lib/rules'],
  [/\bprocess\b/, 'no process access under lib/rules'],
  [/\bglobalThis\b/, 'no globalThis under lib/rules'],
  [/\bReflect\b/, 'no Reflect under lib/rules'],
  [/\bProxy\b/, 'no Proxy under lib/rules'],
  [/\bconstructor\b/, 'no constructor under lib/rules'],
  [/\brequire\b/, 'no require under lib/rules'],
  [/\bimport\s*\(/, 'no dynamic import under lib/rules'],
];

/* Rule 5. Named ..._NAME so the pinned secret rule for a key assignment does not read this line as one. */
const SERVICE_KEY_NAME = /SUPABASE_SERVICE_ROLE_KEY/g;
const SERVICE_KEY_HOLDER = OPERATOR_CLIENT;

/* The named exception. */
const PINNED_DERIVED = ['lib/passport/render.mjs'];

/* Outside tests/, a specifier holding any of these is refused before resolution: Node decodes
   percent-encoding and string escapes and drops tabs and newlines while resolving, so the text
   would not name the file Node loads (critique M2 and M2-R1, 2026-09-11). */
const SPECIFIER_UNSAFE = /[%\\\s\p{Cc}]/u;
/* Outside lib/ and netlify/, targets under these trees are resolved by exact name as well. */
const NAMED_TARGET_TREES = ['lib/', 'netlify/', 'vendor/passport/'];

function isRestricted(rel) {
  return rel.startsWith('lib/') || rel.startsWith('netlify/') || isWeb(rel);
}

/* An importer exception matches a directory (trailing "/") by prefix and a file by equality. */
function importerAllowed(rel, exceptions) {
  return exceptions.some((p) => rel === p || (p.endsWith('/') && rel.startsWith(p)));
}

/* Line numbers and line text by offset. */
function lines(source) {
  const starts = [0];
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const textOf = (line) => source.slice(starts[line - 1], line < starts.length ? starts[line] - 1 : source.length);
  return { starts, lineOf, textOf };
}

function listItems(names) {
  return names.split(', ').map((item) => {
    const [local, alias] = item.split(' as ');
    return { local, exported: alias ?? local };
  });
}

function importLocals(bindings) {
  if (!bindings) return [];
  if (bindings.startsWith('* as ')) return [bindings.slice(5)];
  const brace = bindings.indexOf('{');
  if (brace === -1) return [bindings];
  const head = brace === 0 ? [] : [bindings.slice(0, brace - 2)];
  return [...head, ...listItems(bindings.slice(brace + 2, -2)).map((i) => i.exported)];
}

/* One line of rule 2's export forms or rule 7's local exports, parsed; null when the line is in
   neither grammar. kind: 'from', 'declaration', 'list' or 'default'. A local `export const`/`let`
   declaration records its first name only; a second declarator, a continuation line or a comment,
   template or regular expression in the initializer can hide a further exported binding that this
   text reader does not see (Codex recheck 3, M2-R4). Recording the first name is therefore not a
   complete list of a module's exports, and no caller of this treats it as one: rule 4 uses only the
   `export ... from`, `export { names }` and `export default name` forms (which carry their names on
   the line), and the holder guard in tests/e2/unit/boundaries.test.mjs enumerates the module's real
   exports through Node rather than trusting this reader. */
function parseExportLine(text) {
  let m = EXPORT_FROM_LINE.exec(text);
  if (m) {
    const clause = m[1];
    const exported =
      clause === '*'
        ? ['*']
        : clause.startsWith('* as ')
          ? [clause.slice(5)]
          : listItems(clause.slice(2, -2)).map((i) => i.exported);
    return { kind: 'from', spec: m[2], exported, locals: [] };
  }
  m = EXPORT_DECLARATION_LINE.exec(text);
  if (m) return { kind: 'declaration', spec: null, exported: [m[1]], locals: [m[1]] };
  m = EXPORT_LIST_LINE.exec(text);
  if (m) {
    const items = listItems(m[1]);
    return { kind: 'list', spec: null, exported: items.map((i) => i.exported), locals: items.map((i) => i.local) };
  }
  m = EXPORT_DEFAULT_LINE.exec(text);
  if (m && !DEFAULT_FROM.test(m[1])) {
    const name = DEFAULT_NAME.exec(m[1]);
    return { kind: 'default', spec: null, exported: ['default'], locals: name ? [name[1]] : [] };
  }
  return null;
}

/* The lines of a source that rules 2 and 7 accept, parsed: imports with the local names they bind
   and exports with the names they export and the local names they re-export. Lines outside the
   grammar are not returned; under lib/ and netlify/ the contract refuses them. */
export function acceptedLines(source) {
  const imports = [];
  const exports = [];
  source.split('\n').forEach((text, i) => {
    const m = IMPORT_LINE.exec(text);
    if (m) {
      imports.push({ line: i + 1, spec: m[2], locals: importLocals(m[1]) });
      return;
    }
    const e = parseExportLine(text);
    if (e) exports.push({ line: i + 1, ...e });
  });
  return { imports, exports };
}

function isSplitImport(textOf, line, lineCount) {
  if (textOf(line) !== 'import {') return false;
  let next = line + 1;
  while (next <= lineCount && SPLIT_IMPORT_ITEM.test(textOf(next))) next++;
  return next > line + 1 && next <= lineCount && SPLIT_IMPORT_CLOSE.test(textOf(next));
}

/* Rules 2 (line form), 3, 5 and 7 over one file under lib/ or netlify/. */
function contractProblems(rel, source, pinned) {
  const out = [];
  const { starts, lineOf, textOf } = lines(source);
  const refuse = (rule, offset) => out.push({ rule, path: `${rel}:${lineOf(offset)}` });
  for (const m of source.matchAll(WORD)) {
    const word = m[1];
    const end = m.index + word.length;
    if (word === 'import') {
      OPEN_PAREN.lastIndex = end;
      if (OPEN_PAREN.test(source)) {
        refuse('dynamic import( refused under lib/ and netlify/', m.index);
        continue;
      }
      IMPORT_META.lastIndex = end;
      if (IMPORT_META.test(source)) continue;
    }
    const line = lineOf(m.index);
    const lineStart = starts[line - 1];
    if (pinned && /[^ \t]/.test(source.slice(lineStart, m.index))) continue;
    if (lineStart === m.index) {
      const text = textOf(line);
      if (word === 'export' && parseExportLine(text)) continue;
      if (word === 'import' && (IMPORT_LINE.test(text) || (pinned && isSplitImport(textOf, line, starts.length))))
        continue;
    }
    refuse(
      word === 'import' ? 'import outside an accepted module-reference line' : 'export outside an accepted export line',
      m.index,
    );
  }
  for (const [pattern, rule] of pinned ? TEXT_REFUSALS : [...TEXT_REFUSALS, ESCAPE_REFUSAL]) {
    for (const m of source.matchAll(pattern)) refuse(rule, m.index);
  }
  if (rel.startsWith('lib/rules/')) {
    for (const [pattern, rule] of RULES_WORDS) if (pattern.test(source)) out.push({ rule, path: rel });
  }
  if (rel !== SERVICE_KEY_HOLDER) {
    for (const m of source.matchAll(SERVICE_KEY_NAME)) refuse('service-key name outside lib/db/operator.mjs', m.index);
  }
  return out;
}

/* ---------- reference reading (every file read) ---------- */

/* Statements whose first word begins a line, spanning lines up to the specifier, and import() or
   require() anywhere that is not a property access. */
const STATIC_REFERENCES = [
  { pattern: /^[ \t]*import\s*(['"])([^'"\n]*)\1/gm, form: 'import' },
  { pattern: /^[ \t]*import\s+[^;'"`()]*?\bfrom\s*(['"])([^'"\n]*)\1/gm, form: 'import' },
  {
    pattern: /^[ \t]*export\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}'"`;]*\})\s*from\s*(['"])([^'"\n]*)\1/gm,
    form: 'export from',
  },
];
const DYNAMIC_REFERENCE = /(?<![\w$.])(import|require)\s*\(/g;
const LITERAL_ARGUMENT = /\s*(['"])([^'"\n]*)\1\s*\)/y;

/* Returns { specifiers: [{ spec, line, form }], problems: [{ kind, line }] } in source order. The
   specifier is the raw text between the quotes, never decoded. form is 'import', 'export from',
   'import()' or 'require()'; a dynamic form whose argument is not exactly one string literal is a
   problem, which the gate reports wherever the module map restricts edges. */
export function moduleReferences(source) {
  const { lineOf } = lines(source);
  const found = [];
  const problems = [];
  for (const { pattern, form } of STATIC_REFERENCES) {
    for (const m of source.matchAll(pattern)) found.push({ offset: m.index + m[0].search(/\S/), spec: m[2], form });
  }
  for (const m of source.matchAll(DYNAMIC_REFERENCE)) {
    LITERAL_ARGUMENT.lastIndex = m.index + m[0].length;
    const argument = LITERAL_ARGUMENT.exec(source);
    if (argument) found.push({ offset: m.index, spec: argument[2], form: `${m[1]}()` });
    else problems.push({ kind: `dynamic ${m[1]} without a single string literal`, line: lineOf(m.index) });
  }
  found.sort((a, b) => a.offset - b.offset);
  return { specifiers: found.map(({ offset, spec, form }) => ({ spec, line: lineOf(offset), form })), problems };
}

/* Kept for callers of the previous interface: the bare list of specifiers. */
export function specifiers(source) {
  return moduleReferences(source).specifiers.map((s) => s.spec);
}

/* ---------- walk, resolution and the rule 4 and rule 6 checks ---------- */

/* files: every file read, in walk order. accepted: the files under lib/ and netlify/ that rule 1
   accepts, which exact-name resolution may reach there. */
function walkTree(root) {
  const files = [];
  const accepted = new Set();
  const problems = [];
  const restrictedEntry = (rel) => {
    const st = lstatSync(join(root, rel));
    const name = posix.basename(rel);
    const web = rel === 'web' || isWeb(rel);
    if (st.isSymbolicLink())
      problems.push({
        rule: web ? 'symbolic link refused under web/' : 'symbolic link refused under lib/ and netlify/',
        path: rel,
      });
    else if (st.isDirectory()) {
      if (rel.includes('/') && !DIRECTORY_NAME.test(name))
        problems.push({ rule: 'directory name outside the contract grammar', path: `${rel}/` });
      for (const child of readdirSync(join(root, rel)).sort()) restrictedEntry(`${rel}/${child}`);
    } else if (st.isFile()) {
      if ((web ? WEB_FILE_NAME : FILE_NAME).test(name)) accepted.add(rel);
      else
        problems.push({
          rule: web ? 'file name outside the web/ grammar' : 'file name outside the contract grammar',
          path: rel,
        });
      if (RUNNABLE_NAME.test(name)) files.push(rel);
    } else
      problems.push({
        rule: web
          ? 'entry neither a file nor a directory refused under web/'
          : 'entry neither a file nor a directory refused under lib/ and netlify/',
        path: rel,
      });
  };
  const openEntry = (rel) => {
    for (const name of readdirSync(rel ? join(root, rel) : root).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (!rel && RESTRICTED_TREES.has(name)) {
        restrictedEntry(childRel);
        continue;
      }
      if (SKIP.has(name)) continue;
      const st = statSync(join(root, childRel));
      if (st.isDirectory()) openEntry(childRel);
      else if (st.isFile() && EXTENSIONS.some((e) => name.endsWith(e))) files.push(childRel);
    }
  };
  openEntry('');
  return { files, accepted, problems };
}

/* Regular files under vendor/passport/, listed for exact-name resolution only: the vendor tree is
   not read, and its integrity is the adapter gate's. */
function vendorFiles(root) {
  const out = new Set();
  const visit = (rel) => {
    for (const name of readdirSync(join(root, rel))) {
      const childRel = `${rel}/${name}`;
      const st = lstatSync(join(root, childRel));
      if (st.isDirectory()) visit(childRel);
      else if (st.isFile()) out.add(childRel);
    }
  };
  const base = join(root, 'vendor', 'passport');
  if (existsSync(base) && lstatSync(base).isDirectory()) visit('vendor/passport');
  return out;
}

/* The named exception holds for a file only while its bytes equal the derived entry registered
   for its path in upstream.lock.json. */
function pinnedExceptions(root, lock, problems) {
  const out = new Set();
  for (const rel of PINNED_DERIVED) {
    const abs = join(root, rel);
    if (!existsSync(abs) || !lstatSync(abs).isFile()) continue;
    const entry = (Array.isArray(lock.derived) ? lock.derived : []).find((d) => d?.path === rel);
    if (!entry) {
      problems.push({ rule: 'pinned derived exception withdrawn, no upstream.lock.json derived entry', path: rel });
      continue;
    }
    if (createHash('sha256').update(readFileSync(abs)).digest('hex') === entry.derived_sha256) out.add(rel);
    else problems.push({ rule: 'pinned derived exception withdrawn, bytes differ from derived_sha256', path: rel });
  }
  return out;
}

function stripSuffix(spec) {
  return spec.replace(/[?#].*$/s, '');
}

function resolveSpecifier(fromRel, spec) {
  if (spec.startsWith('node:')) return { kind: 'builtin', target: spec };
  if (spec.startsWith('.')) return { kind: 'file', target: posix.join(posix.dirname(fromRel), stripSuffix(spec)) };
  return { kind: 'package', target: spec };
}

function prefixOf(rel) {
  for (const key of Object.keys(EDGES)) if (rel.startsWith(key)) return key;
  return null;
}

/* An unmapped directory under lib/ is production code with no declared
   edges: every relative import from it is a problem. */
function libDirectoryOf(rel) {
  if (!rel.startsWith('lib/')) return null;
  const parts = rel.split('/');
  return parts.length > 2 ? `${parts.slice(0, 2).join('/')}/` : 'lib/';
}

/* Rule 4. carries: file -> the targets it re-exports through syntax. graph: file -> every edge. */
function reExportProblems(carries, graph) {
  const out = [];
  const reported = new Set();
  for (const client of SENSITIVE_CLIENTS) {
    const carriers = new Set([client.module]);
    let grew;
    do {
      grew = false;
      for (const [rel, targets] of carries) {
        if (!carriers.has(rel) && targets.some((t) => carriers.has(t))) {
          carriers.add(rel);
          grew = true;
        }
      }
    } while (grew);
    carriers.delete(client.module);
    for (const [rel, edges] of graph) {
      for (const { target } of edges) {
        const path = `${rel} -> ${target}`;
        if (!carriers.has(target) || importerAllowed(rel, client.importers) || reported.has(`${client.rule}${path}`))
          continue;
        reported.add(`${client.rule}${path}`);
        out.push({ rule: client.rule, path });
      }
    }
  }
  return out;
}

export function checkImports(root) {
  const problems = [];
  const lockPath = join(root, 'upstream.lock.json');
  const lock = existsSync(lockPath)
    ? JSON.parse(readFileSync(lockPath, 'utf8'))
    : { test_only_paths: [], allowlist: { runtime: [] } };
  const testOnly = new Set((lock.test_only_paths ?? []).map((p) => `vendor/passport/${p}`));
  const runtimeAllow = lock.allowlist?.runtime ?? [];
  const inRuntime = (vendorRel) => {
    for (const pat of runtimeAllow) {
      if (pat.endsWith('/**') ? vendorRel.startsWith(pat.slice(0, -2)) : vendorRel === pat) return true;
    }
    return false;
  };
  const { files, accepted, problems: entryProblems } = walkTree(root);
  problems.push(...entryProblems);
  const vendor = vendorFiles(root);
  const pinned = pinnedExceptions(root, lock, problems);
  const graph = new Map();
  const carries = new Map();
  const unmappedReported = new Set();
  for (const rel of files) {
    const source = readFileSync(join(root, rel), 'utf8');
    const restricted = isRestricted(rel);
    const inTests = rel.startsWith('tests/');
    if (restricted) {
      const found = contractProblems(rel, source, pinned.has(rel));
      /* Rules 3, 5 and 7 are the same under web/; their findings name the tree they were found in. */
      if (isWeb(rel)) for (const p of found) p.rule = p.rule.replace('under lib/ and netlify/', 'under web/');
      problems.push(...found);
    }
    if (rel.startsWith('lib/passport/')) {
      if (/\bfetch\s*\(/.test(source)) problems.push({ rule: 'no fetch under lib/passport', path: rel });
      if (/child_process/.test(source)) problems.push({ rule: 'no child_process under lib/passport', path: rel });
    }
    let prefix = prefixOf(rel);
    let allowedEdges = prefix ? EDGES[prefix] : null;
    const libDir = libDirectoryOf(rel);
    if (!prefix && libDir) {
      if (!unmappedReported.has(libDir)) {
        unmappedReported.add(libDir);
        problems.push({ rule: 'directory under lib/ not in the module map', path: libDir });
      }
      prefix = libDir;
      allowedEdges = [];
    }
    const { specifiers: refs, problems: formProblems } = moduleReferences(source);
    /* Unresolvable forms are refused wherever the map restricts edges. Under
       scripts/ and tests/ the map already grants every edge, and the check
       tools themselves load the pinned vendor module by computed path. */
    const unrestricted = allowedEdges?.includes('*') ?? false;
    for (const p of formProblems) {
      if (unrestricted && p.kind.startsWith('dynamic ')) continue;
      problems.push({ rule: p.kind, path: p.line ? `${rel}:${p.line}` : rel });
    }
    const edges = [];
    for (const { spec, line, form } of refs) {
      if (!inTests && SPECIFIER_UNSAFE.test(spec)) {
        problems.push({
          rule: 'percent-encoded, escaped or control-character specifier refused',
          path: `${rel}:${line} -> ${spec}`,
        });
        continue;
      }
      if (isWeb(rel)) {
        if (!WEB_SPEC_TEXT.test(spec))
          problems.push({
            rule: 'specifier outside the web/ grammar (relative .mjs only)',
            path: `${rel}:${line} -> ${spec}`,
          });
      } else if (restricted && !SPEC_TEXT.test(spec)) {
        problems.push({ rule: 'specifier outside the contract grammar', path: `${rel}:${line} -> ${spec}` });
      }
      const r = resolveSpecifier(rel, spec);
      if (r.kind === 'builtin') {
        if (isWeb(rel)) problems.push({ rule: 'node: specifier refused under web/', path: `${rel} -> ${spec}` });
        else if (prefix === 'lib/rules/')
          problems.push({ rule: 'lib/rules imports nothing with IO', path: `${rel} -> ${spec}` });
        else if (restricted && !BUILTIN_ALLOWLIST.has(spec))
          problems.push({ rule: 'node: built-in outside the lib/ and netlify/ allowlist', path: `${rel} -> ${spec}` });
        continue;
      }
      if (r.kind === 'package') {
        if (prefix && prefix !== 'scripts/' && prefix !== 'tests/')
          problems.push({ rule: 'package import outside scripts/tests', path: `${rel} -> ${spec}` });
        continue;
      }
      const target = r.target;
      const named = restricted || NAMED_TARGET_TREES.some((t) => target.startsWith(t));
      if (!inTests && named && !accepted.has(target) && !vendor.has(target)) {
        problems.push({
          rule: 'relative specifier does not name an examined file exactly',
          path: `${rel}:${line} -> ${spec}`,
        });
      }
      edges.push({ target, form });
      if (testOnly.has(target) && !inTests && !rel.startsWith('vendor/')) {
        problems.push({ rule: 'importer of a test_only path outside vendor/ and tests/', path: `${rel} -> ${target}` });
      }
      if (
        rel.startsWith('lib/') &&
        target.startsWith('vendor/passport/') &&
        !inRuntime(target.slice('vendor/passport/'.length))
      ) {
        problems.push({ rule: 'lib/ imports vendor outside allowlist.runtime', path: `${rel} -> ${target}` });
      }
      if (target === OPERATOR_CLIENT && !importerAllowed(rel, OPERATOR_IMPORTERS)) {
        problems.push({
          rule: 'operator client imported outside lib/operator, scripts, tests, lib/services/invitations.mjs',
          path: `${rel} -> ${target}`,
        });
      }
      if (target === SERVER_CLIENT && !importerAllowed(rel, SERVER_IMPORTERS)) {
        problems.push({
          rule: 'server client imported outside lib/services, lib/operator',
          path: `${rel} -> ${target}`,
        });
      }
      if (rel.startsWith(HANDLERS) && target.startsWith(DB_CLIENTS)) {
        problems.push({ rule: 'handler imports a database client', path: `${rel} -> ${target}` });
      }
      if (allowedEdges && !allowedEdges.includes('*')) {
        const allowed = allowedEdges.some((p) => target.startsWith(p));
        if (!allowed) problems.push({ rule: `edge not in the module map (${prefix} -> ${target})`, path: rel });
      }
    }
    graph.set(rel, edges);
    /* Rule 4 carriers: export ... from targets, and the modules whose imported bindings this file
       re-exports through export { name };, export { name as alias }; or export default name;. */
    const { imports, exports } = acceptedLines(source);
    const reExported = new Set(
      exports.filter((e) => e.kind === 'list' || e.kind === 'default').flatMap((e) => e.locals),
    );
    carries.set(rel, [
      ...edges.filter((e) => e.form === 'export from').map((e) => e.target),
      ...imports
        .filter((i) => i.spec.startsWith('.') && i.locals.some((name) => reExported.has(name)))
        .map((i) => posix.join(posix.dirname(rel), i.spec)),
    ]);
  }
  problems.push(...reExportProblems(carries, graph));
  /* Cycles among repository files. */
  const state = new Map();
  const stack = [];
  const visit = (node) => {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'active') {
      problems.push({ rule: 'import cycle', path: [...stack.slice(stack.indexOf(node)), node].join(' -> ') });
      return;
    }
    state.set(node, 'active');
    stack.push(node);
    for (const { target } of graph.get(node) ?? []) if (graph.has(target)) visit(target);
    stack.pop();
    state.set(node, 'done');
  };
  for (const node of graph.keys()) visit(node);
  return { files: files.length, problems };
}

function main() {
  const args = process.argv.slice(2);
  let root = REPO_ROOT;
  for (let i = 0; i < args.length; i++) if (args[i] === '--root') root = resolve(args[++i]);
  const { files, problems } = checkImports(root);
  for (const p of problems) process.stdout.write(`REFUSE ${p.rule}: ${p.path}\n`);
  process.stdout.write(`check-imports: ${files} files, ${problems.length} problem(s)\n`);
  return problems.length ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
