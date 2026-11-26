/* lib/errors.mjs for E3 (design 4.5 and 2.6 item 5) and HTTP-D2. The mapper forwards a database code only when
   its SQLSTATE class and CODES agree, so every code 003_content.sql raises is tested through fromPostgrest with
   the errcode the migration uses; the unit half of case 38. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppError, CODES, errorBody, fromPostgrest, messageFor } from '../../../lib/errors.mjs';

const DESIGN_4_5 = {
  E_CANONICAL: 422,
  E_ACCESS: 422,
  E_BINDING: 422,
  E_FIDELITY: 422,
  E_STATE_REQUIRED: 422,
  E_PUBLIC_ROUTE: 422,
  E_SECRET_FOUND: 422,
  E_DERIVED_INVALID: 422,
  E_CLOCK: 422,
  E_GATE_FAILS_NOW: 422,
  E_VERSION_REQUIRED: 428,
  E_IDEMPOTENCY_KEY_INVALID: 422,
  E_NOT_AUTHOR: 403,
  E_NOT_BOUND: 403,
  E_NOT_DRAFT: 409,
  E_VERSION_CONFLICT: 409,
  E_CONTENT_CHANGED: 409,
  E_IDEMPOTENCY_CONFLICT: 409,
  E_IMMUTABLE: 409,
  E_STATE_RESET: 409,
  E_STATE_TRANSITION: 409,
  E_CONTRIBUTORS_FROZEN: 409,
  E_AGENT_NAME_TAKEN: 409,
  E_AGENT_ARCHIVED: 409,
  E_AGENT_LIMIT: 409,
  E_VERSION_LIMIT: 409,
  E_GATE_UNREGISTERED: 503,
  E_ASSEMBLY_DIVERGED: 500,
  E_IDEMPOTENCY_EXPIRED: 409,
  E_IDEMPOTENCY_LIMIT: 409,
  E_SUCCESSOR_EXISTS: 409,
};

test('every code of design 4.5 is in CODES with its status', () => {
  for (const [code, status] of Object.entries(DESIGN_4_5)) assert.equal(CODES[code], status, code);
});

test('every code has its own fixed message, and none but E_INTERNAL and E_ASSEMBLY_DIVERGED reads as internal', () => {
  for (const code of Object.keys(CODES)) {
    assert.equal(typeof messageFor(code), 'string');
    if (code !== 'E_INTERNAL' && code !== 'E_ASSEMBLY_DIVERGED') assert.notEqual(messageFor(code), messageFor('E_INTERNAL'), code);
    assert.deepEqual(errorBody(code), { ok: false, code, message: messageFor(code) });
  }
});

test('HTTP-D2: the 415 message names no content type, so it is true on a passport route and a JSON route', () => {
  const message = messageFor('E_UNSUPPORTED_MEDIA_TYPE');
  assert.doesNotMatch(message, /application\/json|text\/markdown|json/i);
  assert.notEqual(message, 'Send application/json.');
});

test('E3b critique F4: an AppError carries optional data whose keys follow ok, code and message and never replace them', () => {
  const problems = [{ code: 'E_CANONICAL', line: 15 }];
  const e = new AppError('E_CANONICAL', undefined, { problems });
  assert.deepEqual(e.data, { problems });
  assert.deepEqual(Object.keys(errorBody(e.code, e.data)), ['ok', 'code', 'message', 'problems']);
  assert.deepEqual(errorBody(e.code, e.data), { ok: false, code: 'E_CANONICAL', message: messageFor('E_CANONICAL'), problems });
  assert.ok(!Object.hasOwn(new AppError('E_CANONICAL'), 'data'), 'no data unless given');
  assert.deepEqual(Object.keys(errorBody('E_CANONICAL')), ['ok', 'code', 'message']);
  for (const data of [null, [], 'problems', { ok: true }, { code: 'E_NOT_FOUND' }, { message: 'x', problems }])
    assert.throws(() => new AppError('E_CANONICAL', undefined, data), TypeError, JSON.stringify(data));
  /* errorBody called directly: a reserved key in data is ignored, and an unknown code carries no data. */
  assert.deepEqual(errorBody('E_CANONICAL', { code: 'E_NOT_FOUND', ok: true }), errorBody('E_CANONICAL'));
  assert.deepEqual(errorBody('E_MADE_UP', { problems }), errorBody('E_INTERNAL'));
});

test('T1: the E_BODY_INVALID message is about the request, because it also answers a bad agent header and a bad list query', () => {
  const message = messageFor('E_BODY_INVALID');
  assert.doesNotMatch(message, /body/i);
  assert.notEqual(message, 'Request body is not valid.');
});

/* The errcode 003_content.sql raises each database code with. */
const RAISED = [
  ['E_NOT_BOUND', '42501'],
  ['E_NOT_AUTHOR', '42501'],
  ['E_NOT_FOUND', 'P0002'],
  ['E_NOT_DRAFT', 'P0001'],
  ['E_VERSION_CONFLICT', 'P0001'],
  ['E_CONTENT_CHANGED', 'P0001'],
  ['E_IDEMPOTENCY_CONFLICT', 'P0001'],
  ['E_IDEMPOTENCY_EXPIRED', 'P0001'],
  ['E_IDEMPOTENCY_LIMIT', 'P0001'],
  ['E_IMMUTABLE', 'P0001'],
  ['E_STATE_RESET', 'P0001'],
  ['E_STATE_TRANSITION', 'P0001'],
  ['E_CONTRIBUTORS_FROZEN', 'P0001'],
  ['E_AGENT_NAME_TAKEN', 'P0001'],
  ['E_AGENT_ARCHIVED', 'P0001'],
  ['E_AGENT_LIMIT', 'P0001'],
  ['E_VERSION_LIMIT', 'P0001'],
  ['E_SUCCESSOR_EXISTS', 'P0001'],
  ['E_BUSY', 'P0001'],
  ['E_CANONICAL', '22023'],
  ['E_DERIVED_INVALID', '22023'],
  ['E_CLOCK', '22023'],
  ['E_BODY_INVALID', '22023'],
  ['E_GATE_UNREGISTERED', 'P0003'],
];

test('case 38, unit half: each database code reaches its status through fromPostgrest, with details and hint dropped', () => {
  for (const [code, sqlstate] of RAISED) {
    const e = fromPostgrest({ status: 400, body: { code: sqlstate, message: code, details: 'Failing row contains (secret prose)', hint: 'x' } });
    assert.equal(e.code, code, `${code} under ${sqlstate}`);
    assert.equal(e.status, CODES[code]);
    assert.equal(e.cause, undefined);
    assert.equal(JSON.stringify(errorBody(e.code)).includes('secret prose'), false);
  }
});

test('case 38 control: E_GATE_UNREGISTERED under P0001 does not become a 503, and a P0001 code under P0003 is internal', () => {
  assert.equal(fromPostgrest({ status: 400, body: { code: 'P0001', message: 'E_GATE_UNREGISTERED' } }).code, 'E_INTERNAL');
  assert.equal(fromPostgrest({ status: 400, body: { code: 'P0003', message: 'E_NOT_DRAFT' } }).code, 'E_INTERNAL');
});
