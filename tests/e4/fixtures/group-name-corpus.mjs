/* The group-name rule's shared corpus (E4 design 1.7): lib/rules/reviews.mjs groupNameOf and api.create_group. Each row
   states its result per layer, as the reason corpus does. tests/e4/unit/reviews-rules.test.mjs runs the Node column and
   tests/db/23-review-routines.sh the SQL column against the routine itself (tests/db/e4.mjs group-name-sql). */
const cp = (...points) => String.fromCodePoint(...points);
const ok = (value) => ({ ok: true, value });
const BAD = 'E_BODY_INVALID';

export const GROUP_NAME_CORPUS = Object.freeze([
  { label: 'a plain name', input: 'Finance', node: ok('Finance'), sql: 'ok' },
  { label: 'spaces around it are trimmed', input: '  Finance  ', node: ok('Finance'), sql: 'ok' },
  { label: 'an inner double space is kept', input: 'Finance  team', node: ok('Finance  team'), sql: 'ok' },
  { label: '80 code points', input: 'g'.repeat(80), node: ok('g'.repeat(80)), sql: 'ok' },
  { label: '81 code points', input: 'g'.repeat(81), node: BAD, sql: BAD },
  { label: '80 astral code points', input: cp(0x1f600).repeat(80), node: ok(cp(0x1f600).repeat(80)), sql: 'ok' },
  { label: '80 code points inside spaces', input: `   ${'h'.repeat(80)}   `, node: ok('h'.repeat(80)), sql: 'ok' },
  { label: 'U+00A0 is kept, not trimmed', input: `${cp(0xa0)}Ops`, node: ok(`${cp(0xa0)}Ops`), sql: 'ok' },
  { label: 'right-to-left letters', input: cp(0x5e6, 0x5d5, 0x5d5, 0x5ea), node: ok(cp(0x5e6, 0x5d5, 0x5d5, 0x5ea)), sql: 'ok' },
  { label: 'empty', input: '', node: BAD, sql: BAD },
  { label: 'spaces only', input: '    ', node: BAD, sql: BAD },
  { label: 'a leading tab is not trimmed and is refused', input: `${cp(9)}Ops`, node: BAD, sql: BAD },
  { label: 'U+0001', input: `a${cp(1)}`, node: BAD, sql: BAD },
  { label: 'U+001F', input: `a${cp(0x1f)}`, node: BAD, sql: BAD },
  { label: 'U+007F', input: `a${cp(0x7f)}`, node: BAD, sql: BAD },
  { label: 'U+009F', input: `a${cp(0x9f)}`, node: BAD, sql: BAD },
  { label: 'U+061C', input: `a${cp(0x61c)}`, node: BAD, sql: BAD },
  { label: 'U+200E', input: `a${cp(0x200e)}`, node: BAD, sql: BAD },
  { label: 'U+202E', input: `a${cp(0x202e)}`, node: BAD, sql: BAD },
  { label: 'U+2069', input: `a${cp(0x2069)}`, node: BAD, sql: BAD },
  { label: 'U+2028 is not refused by this rule', input: `a${cp(0x2028)}b`, node: ok(`a${cp(0x2028)}b`), sql: 'ok' },
  { label: 'U+0000', input: `a${cp(0)}`, node: BAD, sql: 'unrepresentable' },
  { label: 'a lone low surrogate', input: `a${String.fromCharCode(0xdc00)}`, node: BAD, sql: 'unrepresentable' },
]);
