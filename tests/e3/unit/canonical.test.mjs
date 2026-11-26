/* Case 21: canonical JSON vectors (E3 design section 6; attestation contract 3.4). */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { derive } from '../../../vendor/passport/web/lib/_derive.mjs';
import { transport, validate } from '../../../vendor/passport/web/lib/_validate.mjs';
import { CanonicalError, canonical } from '../../../lib/passport/canonical.mjs';
import { cp, SYNTHETIC, VALIDATED_AT } from './helpers.mjs';

const sha = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

function syntheticRecord() {
  const t = transport(Buffer.from(SYNTHETIC, 'utf8'), 'text/markdown');
  const v = validate(t.text);
  assert.deepEqual(v.errors, []);
  const d = derive(v.front, v.lines, { validatedAt: VALIDATED_AT });
  assert.equal(d.error, undefined);
  return d.record;
}

const VECTORS = [
  ['flat keys sorted', { b: 1, a: 2 }, '{"a":2,"b":1}'],
  ['nested objects sorted at every depth, arrays kept in order', { z: [{ b: 1, a: [3, 1, 2] }], a: { d: null, c: true } }, '{"a":{"c":true,"d":null},"z":[{"a":[3,1,2],"b":1}]}'],
  ['UTF-16 code unit order, not locale order', { a: 1, B: 2, [cp(0xe9)]: 3, z: 4 }, `{"B":2,"a":1,"z":4,"${cp(0xe9)}":3}`],
  ['an astral key sorts before U+FFFF by code unit, after it by code point', { [cp(0xffff)]: 1, [cp(0x1f600)]: 2 }, `{"${cp(0x1f600)}":2,"${cp(0xffff)}":1}`],
  ['U+2028 stays a raw character, as JSON.stringify writes it', { s: `a${cp(0x2028)}b` }, `{"s":"a${cp(0x2028)}b"}`],
  ['an astral character in a value stays raw', { s: `x${cp(0x1f600)}` }, `{"s":"x${cp(0x1f600)}"}`],
  ['an escaped slash in the source JSON is a plain slash in canonical form', JSON.parse(`{"s":"a${cp(0x5c)}/b"}`), '{"s":"a/b"}'],
  ['a backslash and a quote are escaped as JSON.stringify escapes them', { s: `q"${cp(0x5c)}` }, `{"s":"q${cp(0x5c)}"${cp(0x5c, 0x5c)}"}`],
  ['numbers as JSON.stringify prints them', { n: [0, 1.5, -2, 1e21, 5e-7, 0.1] }, '{"n":[0,1.5,-2,1e+21,5e-7,0.1]}'],
  ['empty containers and booleans', { e: {}, f: [], t: true, u: false }, '{"e":{},"f":[],"t":true,"u":false}'],
];

for (const [label, input, expected] of VECTORS) {
  test(`case 21 vector: ${label}`, () => {
    assert.equal(canonical(input), expected);
    assert.deepEqual(JSON.parse(canonical(input)), JSON.parse(expected));
  });
}

test('case 21: locale order and code point order both differ from the canonical order in the vectors that need them', () => {
  const keys = ['a', 'B', cp(0xe9), 'z'];
  assert.notDeepEqual([...keys].sort((x, y) => x.localeCompare(y)), [...keys].sort());
  const astral = [cp(0xffff), cp(0x1f600)];
  const byCodePoint = [...astral].sort((x, y) => x.codePointAt(0) - y.codePointAt(0));
  assert.notDeepEqual(byCodePoint, [...astral].sort());
});

const REFUSED = [
  ['negative zero', { n: -0 }, /negative zero/],
  ['NaN', { n: Number.NaN }, /not a finite number/],
  ['Infinity', { n: Number.POSITIVE_INFINITY }, /not a finite number/],
  ['undefined member, which JSON.stringify drops', { a: undefined }, /\$\.a is undefined/],
  ['undefined array element, which JSON.stringify writes as null', { a: [1, undefined] }, /\$\.a\[1\] is undefined/],
  // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test
  ['an array hole', { a: [1, , 3] }, /\$\.a\[1\] is a hole/],
  ['a Date, which JSON.stringify rewrites through toJSON', { d: new Date(0) }, /not a plain object/],
  ['a Map', { m: new Map() }, /not a plain object/],
  ['a function', { f: () => 1 }, /is a function/],
  ['a bigint', { b: 1n }, /is a bigint/],
  ['a symbol key', { [Symbol('s')]: 1 }, /symbol key/],
];

for (const [label, input, message] of REFUSED) {
  test(`case 21 refusal: ${label}`, () => {
    assert.throws(() => canonical(input), (e) => e instanceof CanonicalError && message.test(e.message));
  });
}

test('case 21 refusal: a cycle', () => {
  const a = { x: 1 };
  a.self = a;
  assert.throws(() => canonical(a), /is a cycle/);
  const shared = { k: 1 };
  assert.equal(canonical({ p: shared, q: shared }), '{"p":{"k":1},"q":{"k":1}}', 'a repeated non-cyclic value is not a cycle');
});

test("case 21: the SYNTHETIC fixture's real derived record is probe 2's 859 bytes, 9c26963e505f9b7b", () => {
  const record = syntheticRecord();
  const text = canonical(record);
  assert.equal(Buffer.byteLength(text, 'utf8'), 859);
  assert.ok(sha(text).startsWith('9c26963e505f9b7b'), sha(text));
  assert.deepEqual(Object.keys(JSON.parse(text)), [
    'capture_path',
    'created',
    'envelope',
    'name',
    'needs',
    'owner_confirmed',
    'passport_version',
    'scrub',
    'source_stack',
    'summary',
    'title',
    'validated_at',
    'validator_version',
  ]);
});

test('case 21 control: JSON.stringify of the same record differs, which is why the module exists', () => {
  const record = syntheticRecord();
  assert.deepEqual(Object.keys(record).slice(0, 4), ['title', 'summary', 'needs', 'name']);
  assert.notEqual(JSON.stringify(record), canonical(record));
  assert.deepEqual(JSON.parse(JSON.stringify(record)), JSON.parse(canonical(record)));
});
