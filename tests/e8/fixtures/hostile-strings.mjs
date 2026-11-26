/* The hostile tenant strings of E8-5 and E8-6 (docs/e8/design.md 2.3 rows E8-5 and E8-6; evidence/e8-surface.md).
   Synthetic, every one: no person, no address anyone reads, no credential.

   The first four are E7-20's tripwire family, character for character (tests/e7/unit/alerts.test.mjs STRINGS): a
   sentence from a passport, an address, a token-shaped string and an agent's name. The rest are the family day 5's
   brief adds for the rendered surface: a script element, an attribute and href payload, a line break, a
   bidirectional override, and a run of exactly 120 characters, which is the display name's upper bound
   (lib/rules/profiles.mjs DISPLAY_NAME_MAX_CODE_POINTS) and so the longest name a page must lay out at 390 CSS pixels.

   Each string carries a marker a search can find without matching anything a page or a log writes on its own.
   The marker is searched for in logs as well as the whole string, because a log could carry part of a string (the
   line before a line break, the text after an override) and the whole-string search alone would miss that.

   Code points are built from numbers, not written as escapes, the way lib/ builds them, so the file reads the same
   in every editor and no gate has to reason about an escape. */

const cp = (...points) => String.fromCodePoint(...points);

export const LF = cp(0x0a);
export const RLO = cp(0x202e);
export const PDF = cp(0x202c);

/** The run of 120: 'e8x120' and then one letter repeated, so it has no space for a browser to break at. */
export const RUN_120 = `e8x120${'W'.repeat(114)}`;

/** [name, string, marker]. The marker is a substring of the string that no page or log writes by itself. */
export const HOSTILE = Object.freeze([
  ['passport sentence', 'the candidate declines meetings before ten', 'declines meetings'],
  ['address', 'someone@customer.example.invalid', 'customer.example.invalid'],
  ['token-shaped', 'sbp_0123456789abcdef0123456789abcdef01234567', 'sbp_0123456789abcdef'],
  ['agent name', 'Acme Onboarding Agent', 'Acme Onboarding'],
  ['script element', '<script>window.__e8hostile=1</script>', '__e8hostile'],
  ['attribute payload', '"><img src=x onerror="window.__e8img=1">', '__e8img'],
  ['href payload', 'javascript:window.__e8href=1', '__e8href'],
  ['line break', `e8 first line${LF}e8 second line`, 'e8 second line'],
  ['bidirectional override', `e8 ${RLO}tnemyap evil${PDF} end`, 'tnemyap evil'],
  ['120 characters', RUN_120, 'e8x120WWWW'],
]);

export const STRINGS = Object.freeze(HOSTILE.map(([, s]) => s));
export const MARKERS = Object.freeze(HOSTILE.map(([, , m]) => m));

/** Every string or marker found in `text`, by name; an empty list is the pass. */
export function hostileIn(text) {
  const t = String(text);
  return HOSTILE.filter(([, s, m]) => t.includes(s) || t.includes(m)).map(([name]) => name);
}
