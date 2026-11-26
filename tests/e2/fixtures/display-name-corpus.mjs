/* The shared display-name corpus of pages design 2.1 (revision 7, R6-B1), with an expected result per layer.

   node: what normalizeDisplayName and the route answer. A string is the accepted, normalized value; null is a refusal,
   422 E_BODY_INVALID at the route with zero server-client calls (U13, S13 (c)).
   sql: what the database function reached through PostgREST with a server token answers when the value is sent as the
   JSON value of p_display_name (S13d for the same rows, S13p for the others). { stores } is the stored value;
   { sqlstate } a PostgREST error body carrying that code, with no write and no audit row; { recorded: true } an answer
   that is recorded and not specified, with no write and no audit row.
   kind: same, representable text on which both layers must agree; shape, a JSON type the text parameter loses;
   conversion, a value that cannot become text.

   Rows marked added are this construction's, beyond 2.1's table: the edges of each refused range and the three
   accepted non-ASCII spaces migration 004's probe 20 observed, so an off-by-one in either copy fails a row. Values are
   built from code points so no control, format or bidirectional character sits in this file as a literal. */

const cp = (...points) => String.fromCodePoint(...points);
const lone = (unit) => String.fromCharCode(unit);
const STAR = cp(0x1f600);

const same = (label, value, node) => ({
  label,
  kind: 'same',
  present: true,
  value,
  node,
  sql: node === null ? { sqlstate: '22023' } : { stores: node },
});

export const CORPUS = Object.freeze([
  same('Ada', 'Ada', 'Ada'),
  same('two spaces each side of Ada', '  Ada  ', 'Ada'),
  same('120 code points of one astral character (240 UTF-16 code units)', STAR.repeat(120), STAR.repeat(120)),
  same('Zo and U+00EB', `Zo${cp(0xeb)}`, `Zo${cp(0xeb)}`),
  same('a right-to-left name', cp(0x5e2, 0x5d3, 0x5d4), cp(0x5e2, 0x5d3, 0x5d4)),
  same('an emoji ZWJ sequence', cp(0x1f469, 0x200d, 0x1f4bb), cp(0x1f469, 0x200d, 0x1f4bb)),
  same(
    'U+00A0 inside the name and at both ends, kept',
    `${cp(0xa0)}Ada${cp(0xa0)}Lovelace${cp(0xa0)}`,
    `${cp(0xa0)}Ada${cp(0xa0)}Lovelace${cp(0xa0)}`,
  ),
  same('the empty string', '', null),
  same('three spaces', '   ', null),
  same('121 code points', STAR.repeat(121), null),
  same('U+0001', `A${cp(1)}da`, null),
  same('a tab before Ada, refused and not trimmed', `${cp(9)}Ada`, null),
  same('U+001F', `Ada${cp(0x1f)}`, null),
  same('U+007F', `Ada${cp(0x7f)}`, null),
  same('U+009F', `Ada${cp(0x9f)}`, null),
  same('U+061C', `Ada${cp(0x61c)}`, null),
  same('U+200E', `Ada${cp(0x200e)}`, null),
  same('U+202E', `Ada${cp(0x202e)}`, null),
  same('U+2066', `Ada${cp(0x2066)}`, null),
  /* added: range edges on both sides */
  same('added: one code point', 'A', 'A'),
  same('added: 120 characters inside one space each side', ` ${'x'.repeat(120)} `, 'x'.repeat(120)),
  same('added: U+0080', `Ada${cp(0x80)}`, null),
  same('added: U+007E, below U+007F', `Ada${cp(0x7e)}`, `Ada${cp(0x7e)}`),
  same('added: U+061B, below U+061C', `Ada${cp(0x61b)}`, `Ada${cp(0x61b)}`),
  same('added: U+061D, above U+061C', `Ada${cp(0x61d)}`, `Ada${cp(0x61d)}`),
  same('added: U+200D, below U+200E', `Ada${cp(0x200d)}x`, `Ada${cp(0x200d)}x`),
  same('added: U+200F', `Ada${cp(0x200f)}`, null),
  same('added: U+2010, above U+200F', `Ada${cp(0x2010)}`, `Ada${cp(0x2010)}`),
  same('added: U+2029, below U+202A', `Ada${cp(0x2029)}`, `Ada${cp(0x2029)}`),
  same('added: U+202A', `Ada${cp(0x202a)}`, null),
  same('added: U+202F, above U+202E', `Ada${cp(0x202f)}`, `Ada${cp(0x202f)}`),
  same('added: U+2065, below U+2066', `Ada${cp(0x2065)}`, `Ada${cp(0x2065)}`),
  same('added: U+2069', `Ada${cp(0x2069)}`, null),
  same('added: U+206A, above U+2069', `Ada${cp(0x206a)}`, `Ada${cp(0x206a)}`),
  same('added: U+3000 before, kept', `${cp(0x3000)}Ada`, `${cp(0x3000)}Ada`),
  same('added: U+FEFF before, kept', `${cp(0xfeff)}Ada`, `${cp(0xfeff)}Ada`),
  same('added: U+2028 after, kept', `Ada${cp(0x2028)}`, `Ada${cp(0x2028)}`),
  { label: 'a JSON number, 123', kind: 'shape', present: true, value: 123, node: null, sql: { stores: '123' } },
  { label: 'a JSON array, []', kind: 'shape', present: true, value: [], node: null, sql: { stores: '[]' } },
  { label: 'null', kind: 'shape', present: true, value: null, node: null, sql: { sqlstate: '22023' } },
  { label: 'an absent key, {}', kind: 'shape', present: false, value: undefined, node: null, sql: { recorded: true } },
  {
    label: 'U+0000, the JSON escape',
    kind: 'conversion',
    present: true,
    value: `Ada${cp(0)}`,
    node: null,
    sql: { sqlstate: '22P05' },
  },
  {
    label: 'a lone surrogate, the JSON escape',
    kind: 'conversion',
    present: true,
    value: `Ada${lone(0xd800)}`,
    node: null,
    sql: { sqlstate: 'PGRST102' },
  },
]);

/** The route's JSON body for a row: { displayName: <value> }, or {} for the absent key. */
export const routeBody = (row) => (row.present ? { displayName: row.value } : {});

/** The RPC body for a row: { p_display_name: <value> }, or {} for the absent key. */
export const rpcBody = (row) => (row.present ? { p_display_name: row.value } : {});
