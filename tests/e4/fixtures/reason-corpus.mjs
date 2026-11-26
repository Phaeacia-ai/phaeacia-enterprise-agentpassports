/* The reason rule's shared corpus (E4 design 1.2): lib/rules/reviews.mjs reviewReasonOf and app.review_reason. Each row
   states its result per layer: node is { ok: true, value } or 'E_BODY_INVALID'; sql is 'ok' (the same value),
   'E_BODY_INVALID', or 'unrepresentable' for an input PostgreSQL text cannot hold, which only Node meets. Every
   invisible character is built from its code point. tests/e4/unit/reviews-rules.test.mjs runs the Node column and
   tests/db/23-review-routines.sh the SQL column (tests/db/e4.mjs reason-sql). */
const cp = (...points) => String.fromCodePoint(...points);
const ok = (value) => ({ ok: true, value });
const BAD = 'E_BODY_INVALID';

export const REASON_CORPUS = Object.freeze([
  { label: 'a plain reason', input: 'Approved.', node: ok('Approved.'), sql: 'ok' },
  { label: 'spaces around it are trimmed', input: '  Approved.  ', node: ok('Approved.'), sql: 'ok' },
  { label: 'a leading tab and a trailing line feed are trimmed', input: `${cp(9)}Reason${cp(10)}`, node: ok('Reason'), sql: 'ok' },
  { label: 'a tab inside is kept', input: `a${cp(9)}b`, node: ok(`a${cp(9)}b`), sql: 'ok' },
  { label: 'a line feed inside is kept', input: `line one${cp(10)}line two`, node: ok(`line one${cp(10)}line two`), sql: 'ok' },
  { label: 'a carriage return inside is refused', input: `a${cp(13)}b`, node: BAD, sql: BAD },
  { label: 'a CRLF inside is refused', input: `a${cp(13, 10)}b`, node: BAD, sql: BAD },
  { label: 'a trailing carriage return is trimmed first', input: `reason${cp(13)}`, node: ok('reason'), sql: 'ok' },
  { label: 'a vertical tab inside is refused', input: `a${cp(11)}b`, node: BAD, sql: BAD },
  { label: 'a leading vertical tab is trimmed', input: `${cp(11)}b`, node: ok('b'), sql: 'ok' },
  { label: 'U+0001 inside', input: `a${cp(1)}b`, node: BAD, sql: BAD },
  { label: 'U+0008 inside', input: `a${cp(8)}b`, node: BAD, sql: BAD },
  { label: 'U+001F inside', input: `a${cp(0x1f)}b`, node: BAD, sql: BAD },
  { label: 'DEL inside', input: `a${cp(0x7f)}b`, node: BAD, sql: BAD },
  { label: 'U+0085 NEL, a C1 control, is not refused and not trimmed', input: `a${cp(0x85)}`, node: ok(`a${cp(0x85)}`), sql: 'ok' },
  { label: 'U+202E inside is not refused by this rule', input: `a${cp(0x202e)}b`, node: ok(`a${cp(0x202e)}b`), sql: 'ok' },
  { label: 'U+2028 inside is kept, around it trimmed', input: `${cp(0x2028)}a${cp(0x2028)}b${cp(0x2029)}`, node: ok(`a${cp(0x2028)}b`), sql: 'ok' },
  { label: 'U+00A0 and U+FEFF around it are trimmed', input: `${cp(0xa0, 0xfeff)}r${cp(0x3000)}`, node: ok('r'), sql: 'ok' },
  { label: 'empty', input: '', node: BAD, sql: BAD },
  { label: 'spaces only', input: '   ', node: BAD, sql: BAD },
  { label: 'the trim class only', input: cp(9, 10, 0xa0, 0x2028, 0x3000, 0xfeff), node: BAD, sql: BAD },
  { label: '2,000 code points', input: 'x'.repeat(2000), node: ok('x'.repeat(2000)), sql: 'ok' },
  { label: '2,001 code points', input: 'x'.repeat(2001), node: BAD, sql: BAD },
  { label: '2,000 astral code points (4,000 UTF-16 units)', input: cp(0x1f600).repeat(2000), node: ok(cp(0x1f600).repeat(2000)), sql: 'ok' },
  { label: '2,001 astral code points', input: cp(0x1f600).repeat(2001), node: BAD, sql: BAD },
  { label: '2,000 code points inside spaces', input: ` ${'y'.repeat(2000)} `, node: ok('y'.repeat(2000)), sql: 'ok' },
  { label: 'U+0000 inside', input: `a${cp(0)}b`, node: BAD, sql: 'unrepresentable' },
  { label: 'a lone high surrogate', input: `a${String.fromCharCode(0xd800)}b`, node: BAD, sql: 'unrepresentable' },
  { label: 'not a string', input: 42, node: BAD, sql: 'unrepresentable' },
]);
