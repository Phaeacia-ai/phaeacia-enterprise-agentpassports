/* lib/passport/gate.mjs (E3 design 3.1 and 3.5): the order, the refusal shape, the fixed-point rule (the unit
   half of case 8, whose route half is E3b), and C3's replay property (probe 2). */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { SECRETS } from '../../../vendor/passport/web/lib/_validate.mjs';
import { gate } from '../../../lib/passport/gate.mjs';
import { GATE_IDENTITY_SHA256 } from '../../../lib/passport/gate-manifest.mjs';
import { CR, cp, lineOf, SYNTHETIC, VALIDATED_AT, variant } from './helpers.mjs';

const run = (text, contentType = 'text/markdown', validatedAt = VALIDATED_AT) =>
  gate(Buffer.from(text, 'utf8'), contentType, { validatedAt });
const sha = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const PROSE = 'It runs when you paste records and ask it to run.';

test('the SYNTHETIC fixture passes with probe 2 hashes and the manifest identity', () => {
  const g = run(SYNTHETIC);
  assert.equal(g.ok, true);
  assert.equal(g.text, SYNTHETIC);
  assert.equal(Buffer.byteLength(g.text), 2736);
  assert.ok(g.contentSha256.startsWith('778dbc6d7ee4d29a'));
  assert.equal(g.contentSha256, sha(SYNTHETIC));
  assert.ok(g.derivedSha256.startsWith('9c26963e505f9b7b'));
  assert.equal(g.derivedSha256, sha(g.derivedCanonical));
  assert.equal(g.gateIdentitySha256, GATE_IDENTITY_SHA256);
  assert.equal(g.validatedAt, VALIDATED_AT);
  assert.equal(JSON.parse(g.derivedCanonical).validated_at, VALIDATED_AT);
  assert.ok(Object.isFrozen(g));
});

test('C3: replay with the stored validatedAt is byte-identical; with another time only validated_at differs', () => {
  const first = run(SYNTHETIC);
  const replay = run(first.text);
  assert.equal(replay.derivedCanonical, first.derivedCanonical);
  const later = run(first.text, 'text/markdown', '2026-09-12T08:00:01.000Z');
  assert.notEqual(later.derivedCanonical, first.derivedCanonical);
  const a = JSON.parse(first.derivedCanonical);
  const b = JSON.parse(later.derivedCanonical);
  assert.deepEqual(
    Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])),
    ['validated_at'],
  );
});

test('bytes must be a Buffer and validatedAt a real millisecond UTC timestamp; both are caller errors', () => {
  assert.throws(() => gate(SYNTHETIC, 'text/markdown', { validatedAt: VALIDATED_AT }), TypeError);
  assert.throws(() => gate(new Uint8Array(Buffer.from(SYNTHETIC)), 'text/markdown', { validatedAt: VALIDATED_AT }), TypeError);
  assert.throws(() => gate(Buffer.from(SYNTHETIC), 'text/markdown'), TypeError);
  assert.throws(() => gate(Buffer.from(SYNTHETIC), 'text/markdown', { validatedAt: '2026-02-31T00:00:00.000Z' }), TypeError);
  assert.throws(() => gate(Buffer.from(SYNTHETIC), 'text/markdown', { validatedAt: '2026-09-12T08:00:00Z' }), TypeError);
});

test('stage 1: transport refusals fail fast, one problem each, no line', () => {
  const big = Buffer.alloc(262145, 0x61);
  const cases = [
    ['E_CONTENT_TYPE', Buffer.from(SYNTHETIC), 'application/json'],
    ['E_TOO_LARGE', big, 'text/markdown'],
    ['E_TOO_SMALL', Buffer.from('x'.repeat(100)), 'text/plain'],
    ['E_NOT_UTF8', Buffer.concat([Buffer.from(SYNTHETIC), Buffer.from([0xff])]), 'text/markdown'],
    ['E_CONTROL_CHARS', Buffer.from(variant([[PROSE, `${PROSE}${cp(0x01)}`]])), 'application/octet-stream'],
  ];
  for (const [code, bytes, type] of cases) {
    const g = gate(bytes, type, { validatedAt: VALIDATED_AT });
    assert.deepEqual(JSON.parse(JSON.stringify(g)), { ok: false, code, problems: [{ code, line: null }] }, code);
  }
});

/* E3a critique M-GATE: an early `bytes.length >= 262144` refusal survived every test, because no accepted fixture
   sat at the inclusive maximum. Trailing spaces after the last line change no derived field, which keeps the
   verdict about size alone. */
test('stage 1, the inclusive maximum: exactly 262,144 bytes pass, one byte more is E_TOO_LARGE', () => {
  const padded = SYNTHETIC + ' '.repeat(262144 - Buffer.byteLength(SYNTHETIC));
  const bytes = Buffer.from(padded, 'utf8');
  assert.equal(bytes.length, 262144);
  const g = gate(bytes, 'text/markdown', { validatedAt: VALIDATED_AT });
  assert.equal(g.ok, true, JSON.stringify(g.problems));
  assert.equal(g.derivedCanonical, run(SYNTHETIC).derivedCanonical);
  const over = gate(Buffer.concat([bytes, Buffer.from(' ')]), 'text/markdown', { validatedAt: VALIDATED_AT });
  assert.deepEqual(JSON.parse(JSON.stringify(over)), {
    ok: false,
    code: 'E_TOO_LARGE',
    problems: [{ code: 'E_TOO_LARGE', line: null }],
  });
});

test('stage 1 control: a byte-order mark and CRLF line ends are transport normalisation, and the result is the plain fixture', () => {
  const crlf = `${cp(0xfeff)}${SYNTHETIC.split('\n').join(`${CR}\n`)}`;
  const g = run(crlf);
  assert.equal(g.ok, true);
  assert.equal(g.text, SYNTHETIC);
  assert.equal(g.contentSha256, run(SYNTHETIC).contentSha256);
});

test('stage 2, the unit half of case 8: a lone carriage return in prose is E_CANONICAL with its line', () => {
  const text = variant([['turns pasted records', `turns${CR}pasted records`]]);
  assert.deepEqual(JSON.parse(JSON.stringify(run(text))), {
    ok: false,
    code: 'E_CANONICAL',
    problems: [{ code: 'E_CANONICAL', line: lineOf(text, 'turns') }],
  });
});

test('stage 2, probe 2c: CR CR LF leaves a CR LF pair after transport, and that is E_CANONICAL too', () => {
  const text = variant([['## 1. What this agent is\n', `## 1. What this agent is${CR}${CR}\n`]]);
  const g = run(text);
  assert.equal(g.code, 'E_CANONICAL');
  assert.deepEqual(g.problems, [{ code: 'E_CANONICAL', line: lineOf(text, '## 1. What this agent is') }]);
});

test('stage 2 before stage 3 (the lead Q5): a surviving carriage return and a format error answer E_CANONICAL alone', () => {
  const both = variant([
    ['turns pasted records', `turns${CR}pasted records`],
    ['envelope: read-notify\n', ''],
  ]);
  assert.deepEqual(run(both).problems.map((p) => p.code), ['E_CANONICAL']);
  const formatOnly = variant([['envelope: read-notify\n', '']]);
  assert.deepEqual(run(formatOnly).problems, [{ code: 'E_MISSING_KEY', line: null }], 'control: the format error alone');
});

test('stages 3 to 6 all run: one upload reports its format, enterprise and route problems together, in stage order', () => {
  const text = variant([
    ['envelope: read-notify\n', ''],
    ['    access: open\n', '    access: open\n    fidelity: sortof\n'],
    [PROSE, `Share it at app.phaeacia.ai. ${PROSE}`],
  ]);
  const g = run(text);
  assert.equal(g.ok, false);
  assert.deepEqual(g.problems, [
    { code: 'E_MISSING_KEY', line: null },
    { code: 'E_FIDELITY', line: lineOf(text, '    fidelity: sortof') },
    { code: 'E_PUBLIC_ROUTE', line: lineOf(text, 'app.phaeacia.ai') },
  ]);
  assert.equal(g.code, 'E_MISSING_KEY');
});

test('stage 4: a derive() refusal is part of the verdict (adapter R4: no consent data row)', () => {
  const text = variant([['| Reply in this conversation | Show the sorted records | Required | No result is displayed | yes |\n', '']]);
  const g = run(text);
  assert.equal(g.ok, false);
  assert.deepEqual(g.problems.map((p) => p.code), ['E_DERIVE_NEEDS']);
});

test('refusal shape: E_SECRET_FOUND carries a pinned kind and a line, never the credential', () => {
  const key = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
  const text = variant([[PROSE, `Key ${key} here. ${PROSE}`]]);
  const g = run(text);
  assert.equal(g.code, 'E_SECRET_FOUND');
  assert.deepEqual(JSON.parse(JSON.stringify(g.problems)), [
    { code: 'E_SECRET_FOUND', line: lineOf(text, key), kind: 'a Stripe secret key' },
  ]);
  assert.ok(SECRETS.some(([name]) => name === g.problems[0].kind));
  const body = JSON.stringify(g);
  assert.equal(body.includes(key), false);
  assert.equal(body.includes('a1B2c3'), false);
});

test('refusal shape: E_HTML reports lines only; no pinned message and no document text reaches the result', () => {
  const tag = '<img src=x onerror=alert(1)>';
  const text = variant([[PROSE, `${tag} ${PROSE}`]]);
  const g = run(text);
  assert.equal(g.ok, false);
  assert.ok(g.problems.some((p) => p.code === 'E_HTML' && p.line === lineOf(text, tag)), JSON.stringify(g.problems));
  for (const p of g.problems) assert.deepEqual(Object.keys(p).sort(), ['code', 'line']);
  const body = JSON.stringify(g);
  for (const fragment of ['onerror', 'img', 'alert', 'Passports are Markdown']) assert.equal(body.includes(fragment), false, fragment);
});

test('refusal shape: identical problems are reported once', () => {
  const tag = '<b>x</b>';
  const text = variant([[PROSE, `${tag} ${tag} ${PROSE}`]]);
  const g = run(text);
  const keys = g.problems.map((p) => `${p.code}|${p.line}`);
  assert.equal(new Set(keys).size, keys.length, JSON.stringify(g.problems));
});

test('the gate mirrors the pinned transport tolerance of an absent content type; the route refuses it first (E3b)', () => {
  assert.equal(gate(Buffer.from(SYNTHETIC), undefined, { validatedAt: VALIDATED_AT }).ok, true);
  assert.equal(gate(Buffer.from(SYNTHETIC), '', { validatedAt: VALIDATED_AT }).ok, true);
});
