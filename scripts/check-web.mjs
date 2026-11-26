#!/usr/bin/env node
/* Browser-code gate (pages design section 3 and 4.5, revision 7).

   What this gate is worth, stated first. It is a syntax tripwire over the raw text of every file under web/,
   comments and strings included, so a comment under web/ may not hold a refused word either. It refuses the forms a
   maintainer writes by habit. It cannot refuse every way a name can be assembled while a page runs, so a green run is
   evidence that the known bad forms are absent and nothing more. The run-time checks are the journey assertions of
   section 6 (tests/browser/): the initiator of every /api/ request, the cookie state, the document URLs, and the
   Content-Security-Policy and Trusted Types violations the browser reports. Journey J17 shows those assertions fail on
   a moved caller this gate does not see, and U9 records that miss as a test result.

   Every file, whatever its type:
     rule 1   the session lives only in the HttpOnly cookies: document.cookie and the word cookie in any form,
              localStorage, sessionStorage, indexedDB, caches, serviceWorker;
     rule 2   one module talks to the network: the word fetch in any form (fetch(, window.fetch, globalThis.fetch,
              self.fetch, a plain alias) outside web/assets/app/api.mjs; and everywhere window[, globalThis[, self[,
              XMLHttpRequest, WebSocket, EventSource, sendBeacon, http://, https://, a string starting //.
   Script files (.mjs):
     rule 9   the DOM is built, never parsed: innerHTML, outerHTML, insertAdjacentHTML, document.write, DOMParser,
              createContextualFragment, eval, new Function and Function(, a string first argument to setTimeout or
              setInterval, alert(, confirm(, prompt(, postMessage, an on<event> property assignment, a
              setAttribute of an on<event> or style attribute, and the style property;
              also setHTML, parseHTMLUnsafe, Reflect.set, Reflect.defineProperty, Object.defineProperty and any
              string literal ending in HTML (E4PW-R-F1); setAttributeNS anywhere, a setAttribute whose attribute
              name is not a string literal outside web/assets/app/dom.mjs (whose names come from its closed
              list), and an assignment to .href or .src outside the three places that own one, one assignment
              each: dom.mjs (the inline image), shell.mjs (link()) and save-file.mjs (the save control's object
              URL, moved there from pages/release.mjs by the E6 pages lane so the release, home and members pages
              share one control; E6 design 4.3, E6D-C-F16) (TOOL-R1-F1, evidence/e5-pages-review.md). The
              quoted names href, src, srcdoc, action, formaction and data are
              refused through setAttribute everywhere (TOOL2-R-F3). Bound: a computed property key or Object.assign
              onto an element, a destructured or aliased setAttribute, a key assembled without such a
              literal, for example from char codes, a property write through an alias of Reflect, a
              javascript: scheme assembled from parts inside an owner's one assignment, or a link target set
              through a property this list does not name, an escape inside a quoted attribute name, setAttribute
              reached through call, apply or a bracketed method name, attributes.<name>.value, and the srcset or
              ping attributes (B3-R-F5, evidence/batch-3-review.md), is not seen; script-src 'self' closes the
              handler and scheme cases at run time, the production CSP's Trusted Types requirement and img-src
              should close srcdoc, srcset and ping there (not observed in a browser), nothing closes a wrong link
              target but review, and J17's documented miss
              is the same class on the network side.
     rule 10  shell.mjs is the only writer of location: location =, location[, location.href, location.assign,
              location.replace, location.reload and window.open outside web/assets/app/shell.mjs.
   HTML files (a page is web/index.html, web/<page>/index.html or, one level deeper and no further,
   web/<page>/<part>/index.html, and its module is assets/app/pages/<page>.mjs, home for the root, or
   assets/app/pages/<page>-<part>.mjs for the nested page, so /operator/company/ loads operator-company.mjs; E6 design
   4.1. A page under web/assets/ is none, and a deeper index.html is refused as a file that is no page):
     rule 4   exactly one <script type="module" src="/assets/app/pages/<page>.mjs"></script> naming its own module, which
              must exist, and no other <script; no on<event>= attribute, style= attribute, <style, javascript:, <base,
              <iframe, <object or <embed; the viewport meta the phone observations depend on;
     rule 8   the referrer and robots meta.
   CSS files: no @import and no url(, so the owned stylesheet references no file.
   SVG files: no <script at all, and the HTML attribute refusals.
   Any other entry under web/, a symbolic link included, is refused here as well as by the import gate, because this
   gate would otherwise not know which list reads it.

   The on<event> property, setAttribute and style refusals are tighter than section 3's lists: each is a way to put
   a handler or a style attribute on an element that rule 4's HTML refusals do not see. Exported: checkWeb(root).
   Exit 0 clean, 2 on findings. --root <dir> checks another tree (tests). */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_MODULE = 'web/assets/app/api.mjs';
const SHELL_MODULE = 'web/assets/app/shell.mjs';

const EVERY_FILE = [
  [/cookie/gi, 'rule 1: cookie refused under web/'],
  [/\blocalStorage\b/g, 'rule 1: localStorage refused under web/'],
  [/\bsessionStorage\b/g, 'rule 1: sessionStorage refused under web/'],
  [/\bindexedDB\b/g, 'rule 1: indexedDB refused under web/'],
  [/\bcaches\b/g, 'rule 1: caches refused under web/'],
  [/\bserviceWorker\b/g, 'rule 1: serviceWorker refused under web/'],
  [/\bwindow\s*\[/g, 'rule 2: computed member access on window refused under web/'],
  [/\bglobalThis\s*\[/g, 'rule 2: computed member access on globalThis refused under web/'],
  [/(?<![\w$.])self\s*\[/g, 'rule 2: computed member access on self refused under web/'],
  [/\bXMLHttpRequest\b/g, 'rule 2: XMLHttpRequest refused under web/'],
  [/\bWebSocket\b/g, 'rule 2: WebSocket refused under web/'],
  [/\bEventSource\b/g, 'rule 2: EventSource refused under web/'],
  [/\bsendBeacon\b/g, 'rule 2: sendBeacon refused under web/'],
  [/https?:\/\//gi, 'rule 2: an absolute http or https URL refused under web/'],
  [/['"`]\/\//g, 'rule 2: a string starting // refused under web/'],
];
const FETCH_WORD = [/\bfetch\b/g, 'rule 2: fetch outside web/assets/app/api.mjs'];

const SCRIPT = [
  [/\binnerHTML\b/g, 'rule 9: innerHTML refused'],
  [/\bouterHTML\b/g, 'rule 9: outerHTML refused'],
  [/\binsertAdjacentHTML\b/g, 'rule 9: insertAdjacentHTML refused'],
  [/\bdocument\s*\.\s*write/g, 'rule 9: document.write refused'],
  [/\bDOMParser\b/g, 'rule 9: DOMParser refused'],
  [/\bcreateContextualFragment\b/g, 'rule 9: createContextualFragment refused'],
  [/\beval\b/g, 'rule 9: eval refused'],
  [/\bnew\s+Function\b|\bFunction\s*\(/g, 'rule 9: new Function refused'],
  [/\bset(?:Timeout|Interval)\s*\(\s*['"`]/g, 'rule 9: a string first argument to setTimeout or setInterval refused'],
  [/\balert\s*\(/g, 'rule 9: alert( refused'],
  [/\bconfirm\s*\(/g, 'rule 9: confirm( refused'],
  [/\bprompt\s*\(/g, 'rule 9: prompt( refused'],
  [/\bpostMessage\b/g, 'rule 9: postMessage refused'],
  /* E4PW-R-F1 (evidence/e4-pages-review.md): the Sanitizer API and a markup key assembled at run time. */
  [/\bsetHTML\b/g, 'rule 9: setHTML refused'],
  [/\bparseHTMLUnsafe\b/g, 'rule 9: parseHTMLUnsafe refused'],
  [/\bReflect\s*\.\s*(?:set|defineProperty)\b/g, 'rule 9: Reflect.set and Reflect.defineProperty refused'],
  [/\bObject\s*\.\s*defineProperty\b/g, 'rule 9: Object.defineProperty refused'],
  [/['"`][^'"`\n]*HTML['"`]/g, 'rule 9: a string literal ending in HTML refused (a computed markup key)'],
  [/\.on[a-z]{3,}\s*=(?!=)/g, 'rule 9: an on<event> property assignment refused'],
  [/\bsetAttribute\s*\(\s*['"`](?:on|style)/gi, 'rule 9: setAttribute of an on<event> or style attribute refused'],
  [/\bsetAttributeNS\b/g, 'rule 9: setAttributeNS refused'],
  [
    /\bsetAttribute\s*\(\s*['"`](?:href|src|srcdoc|action|formaction|data|xlink:href)['"`]/gi,
    'rule 9: setAttribute of a target or document attribute (href, src, srcdoc, action, formaction, data) refused',
  ],
  [/\.style\b/g, 'rule 9: the style property refused'],
  /* B3-R-F5 (evidence/batch-3-review.md): the property twins of the attributes refused above, and the attribute-node
     route to any name. `.href` and `.src` stay under TARGET_ASSIGNMENT with their owners. */
  [
    /\.(?:srcdoc|action|formAction|data)\s*=(?!=)/g,
    'rule 9: a document or target property assignment (srcdoc, action, formAction, data) refused',
  ],
  [/\b(?:setAttributeNode(?:NS)?|createAttribute(?:NS)?)\b/g, 'rule 9: setAttributeNode and createAttribute refused'],
];
/* TOOL-R1-F1: forms with owners. A computed attribute name belongs to dom.mjs alone; a .href or .src assignment belongs
   to three files, one assignment each, so a second one in an owner is refused like a first one anywhere else. */
const DOM_MODULE = 'web/assets/app/dom.mjs';
const COMPUTED_ATTRIBUTE = [
  /\bsetAttribute\s*\(\s*(?!['"`])/g,
  'rule 9: setAttribute with a name that is not a string literal outside web/assets/app/dom.mjs',
];
const TARGET_ASSIGNMENT = /\.(?:href|src)\s*=(?!=)/g;
const TARGET_OWNERS = new Map([
  [DOM_MODULE, 1],
  ['web/assets/app/shell.mjs', 1],
  ['web/assets/app/save-file.mjs', 1],
]);
function targetProblems(rel, source, out) {
  const allowed = TARGET_OWNERS.get(rel) ?? 0;
  const found = [...source.matchAll(TARGET_ASSIGNMENT)];
  if (found.length <= allowed) return;
  for (const m of found.slice(allowed))
    out.push({
      rule: 'rule 9: an assignment to .href or .src outside its owners (dom.mjs, shell.mjs, save-file.mjs), one each',
      path: `${rel}:${lineOf(source, m.index)}`,
    });
}

const NAVIGATION = [
  [/\blocation\s*=(?!=)/g, 'rule 10: location = outside web/assets/app/shell.mjs'],
  [/\blocation\s*\[/g, 'rule 10: location[ outside web/assets/app/shell.mjs'],
  [
    /\blocation\s*\.\s*(?:href|assign|replace|reload)\b/g,
    'rule 10: a location writer outside web/assets/app/shell.mjs',
  ],
  [/\bwindow\s*\.\s*open\b/g, 'rule 10: window.open outside web/assets/app/shell.mjs'],
];

const MARKUP = [
  [/<[a-z][^>]*\son[a-z]+\s*=/gi, 'rule 4: an on<event>= attribute refused'],
  [/<[a-z][^>]*\sstyle\s*=/gi, 'rule 4: a style= attribute refused'],
  [/<style\b/gi, 'rule 4: <style refused'],
  [/javascript:/gi, 'rule 4: javascript: refused'],
  [/<base\b/gi, 'rule 4: <base refused'],
  [/<iframe\b/gi, 'rule 4: <iframe refused'],
  [/<object\b/gi, 'rule 4: <object refused'],
  [/<embed\b/gi, 'rule 4: <embed refused'],
];
const REQUIRED_META = [
  ['<meta name="viewport" content="width=device-width, initial-scale=1">', 'rule 4: the viewport meta is missing'],
  ['<meta name="referrer" content="no-referrer">', 'rule 8: the referrer meta is missing'],
  ['<meta name="robots" content="noindex, nofollow">', 'rule 8: the robots meta is missing'],
];
const CSS = [
  [/@import\b/gi, 'CSS: @import refused'],
  [/\burl\s*\(/gi, 'CSS: url( refused'],
];

const WEB_DIRECTORY = /^[a-z0-9][a-z0-9-]*$/;
const WEB_FILE = /^[a-z0-9][a-z0-9-]*\.(?:mjs|html|css|svg)$/;

function lineOf(source, offset) {
  let line = 1;
  for (let i = source.indexOf('\n'); i !== -1 && i < offset; i = source.indexOf('\n', i + 1)) line += 1;
  return line;
}

function scan(rel, source, list, out) {
  for (const [pattern, rule] of list) {
    for (const m of source.matchAll(pattern)) out.push({ rule, path: `${rel}:${lineOf(source, m.index)}` });
  }
}

/* The page a web/ HTML file is, or null: web/index.html is home, web/<page>/index.html is <page>, and
   web/<page>/<part>/index.html is <page>-<part> (E6 design 4.1's /operator/company/ and /operator/new/). Two levels and
   no deeper, and nothing under web/assets/. Bound: web/a-b/index.html and web/a/b/index.html would name one module;
   no page does, and review is what keeps it so. */
function pageOf(rel) {
  if (rel === 'web/index.html') return 'home';
  const m = /^web\/([a-z0-9][a-z0-9-]*)(?:\/([a-z0-9][a-z0-9-]*))?\/index\.html$/.exec(rel);
  if (!m || m[1] === 'assets') return null;
  return m[2] ? `${m[1]}-${m[2]}` : m[1];
}

function htmlProblems(root, rel, source, out) {
  const page = pageOf(rel);
  if (!page) {
    out.push({ rule: "rule 4: an HTML file that is not a page's index.html", path: rel });
    return;
  }
  const expected = `<script type="module" src="/assets/app/pages/${page}.mjs"></script>`;
  const scripts = [...source.matchAll(/<script\b/gi)];
  const exact = source.split(expected).length - 1;
  if (scripts.length !== 1 || exact !== 1)
    out.push({ rule: `rule 4: exactly one script element, ${expected}, and no other <script`, path: rel });
  if (!existsSync(join(root, 'web', 'assets', 'app', 'pages', `${page}.mjs`)))
    out.push({ rule: `rule 4: the page module assets/app/pages/${page}.mjs does not exist`, path: rel });
  scan(rel, source, MARKUP, out);
  for (const [text, rule] of REQUIRED_META) if (!source.includes(text)) out.push({ rule, path: rel });
}

export function checkWeb(root = REPO_ROOT) {
  const problems = [];
  let files = 0;
  const web = join(root, 'web');
  if (!existsSync(web)) return { files, problems };
  const visit = (rel) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const childRel = `${rel}/${name}`;
      const st = lstatSync(join(root, childRel));
      if (st.isSymbolicLink()) {
        problems.push({ rule: 'symbolic link refused under web/', path: childRel });
        continue;
      }
      if (st.isDirectory()) {
        if (!WEB_DIRECTORY.test(name))
          problems.push({ rule: 'directory name outside the web/ contract', path: `${childRel}/` });
        visit(childRel);
        continue;
      }
      if (!st.isFile()) {
        problems.push({ rule: 'entry neither a file nor a directory refused under web/', path: childRel });
        continue;
      }
      files += 1;
      if (!WEB_FILE.test(name)) problems.push({ rule: 'file name or type outside the web/ contract', path: childRel });
      const source = readFileSync(join(root, childRel), 'utf8');
      scan(childRel, source, EVERY_FILE, problems);
      if (childRel !== API_MODULE) scan(childRel, source, [FETCH_WORD], problems);
      if (name.endsWith('.mjs')) {
        scan(childRel, source, SCRIPT, problems);
        if (childRel !== DOM_MODULE) scan(childRel, source, [COMPUTED_ATTRIBUTE], problems);
        targetProblems(childRel, source, problems);
        if (childRel !== SHELL_MODULE) scan(childRel, source, NAVIGATION, problems);
      } else if (name.endsWith('.html')) htmlProblems(root, childRel, source, problems);
      else if (name.endsWith('.css')) scan(childRel, source, CSS, problems);
      else if (name.endsWith('.svg'))
        scan(childRel, source, [[/<script\b/gi, 'SVG: <script refused'], ...MARKUP], problems);
    }
  };
  if (lstatSync(web).isSymbolicLink()) problems.push({ rule: 'symbolic link refused under web/', path: 'web' });
  else visit('web');
  return { files, problems };
}

function main() {
  const args = process.argv.slice(2);
  let root = REPO_ROOT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') root = resolve(args[++i]);
    else {
      process.stdout.write(`check-web: unknown argument ${args[i]}\n`);
      return 2;
    }
  }
  const { files, problems } = checkWeb(root);
  for (const p of problems) process.stdout.write(`REFUSE ${p.rule}: ${p.path}\n`);
  process.stdout.write(`check-web: ${files} files, ${problems.length} problem(s)\n`);
  return problems.length ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
