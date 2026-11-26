/* The display-name rule (pages design 2.1), pure.

   One rule, two enforcement points. api.set_display_name applies it in the database, which is the authority; this
   copy answers a bad body with 422 before a server token is minted, and keeps U+0000 and lone surrogates from
   reaching PostgREST, where each would become a 500. The shared corpus of 2.1 (tests/e2/fixtures/) holds the two
   copies together: U13 runs its Node column here and through the route, S13d and S13p its SQL column against the
   database function, so a change to one copy that the other does not make fails a test instead of drifting.

   In the order both copies apply it:
     1. trim leading and trailing U+0020 SPACE only, as btrim(v, ' ') does. Not trim(), which also removes tabs, line
        breaks, U+00A0 and U+FEFF, and would accept a leading tab that the database refuses;
     2. 1 to 120 Unicode code points after trimming, as char_length counts. Not .length, which counts UTF-16 code
        units and would refuse 61 astral-plane characters that the database accepts;
     3. well-formed: a lone surrogate has no UTF-8 form. The database copy has no such clause, because PostgREST
        refuses the body before any routine runs;
     4. no C0 or C1 control, U+0000 to U+001F and U+007F to U+009F, and no Bidi_Control character, U+061C, U+200E,
        U+200F, U+202A to U+202E and U+2066 to U+2069. The database copy starts at U+0001 because text cannot hold
        U+0000.
   A value that is not a string is refused. That check belongs to the route alone in 2.1's terms: the function's text
   parameter keeps no JSON type, so a number or an array that reached it would be stored as its JSON text. Code points
   are compared as numbers, because lib/ refuses escape sequences in source. */

export const DISPLAY_NAME_MAX_CODE_POINTS = 120;

/* Inclusive ranges of refused code points. */
const REFUSED = Object.freeze([
  Object.freeze([0x0, 0x1f]),
  Object.freeze([0x7f, 0x9f]),
  Object.freeze([0x61c, 0x61c]),
  Object.freeze([0x200e, 0x200f]),
  Object.freeze([0x202a, 0x202e]),
  Object.freeze([0x2066, 0x2069]),
]);

const INVALID = Object.freeze({ ok: false, code: 'E_BODY_INVALID' });

function refusedCodePoint(point) {
  return REFUSED.some(([low, high]) => point >= low && point <= high);
}

/**
 * normalizeDisplayName(value) -> { ok: true, value: <the trimmed name> } | { ok: false, code: 'E_BODY_INVALID' }
 */
export function normalizeDisplayName(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) return INVALID;
  const trimmed = value.replace(/^ +| +$/g, '');
  const points = [...trimmed];
  if (points.length < 1 || points.length > DISPLAY_NAME_MAX_CODE_POINTS) return INVALID;
  for (const ch of points) if (refusedCodePoint(ch.codePointAt(0))) return INVALID;
  return { ok: true, value: trimmed };
}
