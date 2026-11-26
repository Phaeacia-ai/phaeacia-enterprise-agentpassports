/* Journey J17's fixture modules (pages design section 6), kept as text: each is written into a scratch copy of the
   built tree as a page's module and never into web/. Each breaks one browser rule in a way a run-time assertion must
   catch. MISS is also U9's documented miss: a name assembled while the page runs, in a form the raw-text list of
   scripts/check-web.mjs does not contain, so the gate passes it (tests/e2/unit/web-gate.test.mjs) and the journey's
   initiator assertion fails on it. The link values are synthetic and reach no provider. */

/** Design J17's first fixture: the fetch name assembled on window, reaching a real route from a page module. */
export const ALIAS = "window['fet' + 'ch']('/api/me', { credentials: 'same-origin' });\n";

/** U9's documented miss: no window[, no globalThis[, no fetch word, and a same-origin call all the same. */
export const MISS = [
  "const name = ['fe', 'tch'].join('');",
  'const send = Reflect.get(globalThis, name);',
  "send('/api/me', { credentials: 'same-origin' });",
  '',
].join('\n');

/** Design J17's second fixture: a navigation outside the fixed set. */
export const EXTERNAL = "location.assign('https://example.invalid/');\n";

/** Design J17's third fixture: the landing fragment carried forward into a later same-origin navigation. The target
    is another page, because a fragment change on the same page is not a new document and no document assertion would
    see it. */
export const CARRY_NAVIGATION = [
  "const value = new URLSearchParams(location.hash.slice(1)).get('token_hash');",
  "history.replaceState(null, '', location.pathname + location.search);",
  "setTimeout(() => location.assign('/accept/#token_hash=' + encodeURIComponent(value)), 200);",
  '',
].join('\n');

/** Added beside the third: the landing value carried into a later request URL with no navigation at all, so the
    carried-input assertion is shown failing where the navigation-set assertion has nothing to see. */
export const CARRY_REQUEST = [
  "const value = new URLSearchParams(location.hash.slice(1)).get('token_hash');",
  "history.replaceState(null, '', location.pathname + location.search);",
  "const probe = document.createElement('img');",
  "probe.src = '/assets/enterprise.css?v=' + encodeURIComponent(value);",
  'document.body.append(probe);',
  '',
].join('\n');

/** A synthetic landing hash for the carry fixtures: shaped like a link secret, issued by nobody. */
export const SYNTHETIC_HASH = 'j17syntheticlandingvalue0000000000000000000000000000';
