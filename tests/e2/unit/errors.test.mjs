/* lib/errors.mjs: database-to-HTTP mapping (design section 6) and the rule
   that database `details`, `hint` and free message text never survive. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppError, CODES, dbErrorCode, errorBody, fromPostgrest, messageFor } from '../../../lib/errors.mjs';

const pg = (code, message, extra = {}) => ({
  status: 400,
  body: { code, message, details: null, hint: null, ...extra },
});

test('E_* messages map by SQLSTATE class to the design statuses', () => {
  const cases = [
    ['42501', 'E_FORBIDDEN', 403],
    ['42501', 'E_ADMIN_MFA_REQUIRED', 403],
    ['42501', 'E_OPERATOR_MFA_REQUIRED', 403],
    ['42501', 'E_NOT_OPERATOR', 403],
    ['42501', 'E_EMAIL_MISMATCH', 403],
    ['42501', 'E_NOT_SERVER', 403],
    ['P0002', 'E_NOT_FOUND', 404],
    ['P0002', 'E_INVITATION_INVALID', 404],
    ['P0002', 'E_USER_NOT_FOUND', 404],
    ['P0001', 'E_LAST_ADMIN', 409],
    ['P0001', 'E_ALREADY_MEMBER', 409],
    ['P0001', 'E_INVITATION_ACCEPTED', 409],
    ['P0001', 'E_MEMBERSHIP_REMOVED', 409],
    ['P0001', 'E_COMPANY_INACTIVE', 409],
    ['22023', 'E_ROLES_INVALID', 422],
    ['22023', 'E_EXPIRY_INVALID', 422],
    ['P0003', 'E_GATE_UNREGISTERED', 503],
  ];
  for (const [sqlstate, code, status] of cases) {
    const e = fromPostgrest(pg(sqlstate, code));
    assert.equal(e.code, code, `${sqlstate} ${code}`);
    assert.equal(e.status, status, `${sqlstate} ${code}`);
  }
});

test('lock timeout 55P03 is 409 E_BUSY; 23505 is 409 E_CONFLICT; 23514 is 422', () => {
  assert.equal(fromPostgrest(pg('55P03', 'canceling statement due to lock timeout')).code, 'E_BUSY');
  assert.equal(fromPostgrest(pg('55P03', 'canceling statement due to lock timeout')).status, 409);
  assert.equal(
    fromPostgrest(pg('23505', 'duplicate key value violates unique constraint "companies_slug_key"')).code,
    'E_CONFLICT',
  );
  const check = fromPostgrest(
    pg('23514', 'new row for relation "companies" violates check constraint "companies_slug_check"'),
  );
  assert.equal(check.status, 422);
  assert.equal(check.code, 'E_BODY_INVALID');
});

test('E3 2.6 item 5: P0003 carries E_GATE_UNREGISTERED to 503, and only with both the SQLSTATE and the CODES entry', () => {
  const e = fromPostgrest({
    status: 500,
    body: { code: 'P0003', message: 'E_GATE_UNREGISTERED', details: 'gate 9c26963e is not active', hint: 'deploy' },
  });
  assert.equal(e.code, 'E_GATE_UNREGISTERED');
  assert.equal(e.status, 503);
  assert.equal(e.cause, undefined);
  assert.deepEqual(errorBody(e.code), {
    ok: false,
    code: 'E_GATE_UNREGISTERED',
    message: messageFor('E_GATE_UNREGISTERED'),
  });
  assert.notEqual(messageFor('E_GATE_UNREGISTERED'), messageFor('E_INTERNAL'));
  assert.ok(!JSON.stringify({ ...e, message: e.message }).includes('9c26963e'));
  /* The critique's GATE_DB_MAPPING rows (critique M2): under any other SQLSTATE the refusal is not a
     503, and PT503 is not read as an instruction. P0001 is case 38's control. */
  for (const [sqlstate, status, code] of [
    ['P0001', 500, 'E_INTERNAL'],
    ['42501', 500, 'E_INTERNAL'],
    ['P0002', 500, 'E_INTERNAL'],
    ['22023', 422, 'E_BODY_INVALID'],
    ['PT503', 500, 'E_INTERNAL'],
  ]) {
    const m = fromPostgrest(pg(sqlstate, 'E_GATE_UNREGISTERED'));
    assert.deepEqual([m.status, m.code], [status, code], sqlstate);
  }
  /* P0003 forwards only a code CODES gives 503. */
  for (const message of ['E_BUSY', 'E_NOT_FOUND', 'E_SOMETHING_NEW', 'gate not registered']) {
    const m = fromPostgrest(pg('P0003', message));
    assert.deepEqual([m.status, m.code], [500, 'E_INTERNAL'], message);
  }
});

test('anything else is 500 E_INTERNAL with no message from the database', () => {
  for (const b of [
    pg('PGRST301', 'JWSError JWSInvalidSignature'),
    pg('PGRST303', 'JWT expired'),
    pg('PGRST202', 'Could not find the function api.accept_invitation(p_invite_code, p_roles)'),
    pg('57014', 'canceling statement due to statement timeout'),
    pg('42501', 'permission denied for function invite_member'),
    pg('P0001', 'E_SOMETHING_NEW'),
    pg('42501', 'E_NOT_FOUND'),
    { status: 502, body: null },
    { status: 500, body: 'not json' },
  ]) {
    const e = fromPostgrest(b);
    assert.equal(e.code, 'E_INTERNAL', JSON.stringify(b));
    assert.equal(e.status, 500);
    assert.equal(e.message, 'E_INTERNAL');
  }
});

test('XR-12: an internal mapping keeps the database code of DB_CODE shape and nothing else of the body', () => {
  const kept = [
    [pg('57014', 'canceling statement due to statement timeout'), '57014'],
    [pg('PGRST301', 'JWSError JWSInvalidSignature'), 'PGRST301'],
    [pg('P0001', 'E_SOMETHING_NEW'), 'P0001'],
    [pg('42501', 'E_NOT_FOUND'), '42501'],
  ];
  for (const [b, dbCode] of kept) assert.deepEqual(fromPostgrest(b).cause, { postgrestStatus: 400, dbCode }, dbCode);
  const tenantText = 'synthetic-tenant-private-sentence';
  for (const body of [
    null,
    'not json',
    { code: tenantText },
    { code: 'pgrst301' },
    { code: '5701' },
    { code: 57014 },
  ]) {
    const e = fromPostgrest({ status: 502, body });
    assert.equal(e.code, 'E_INTERNAL');
    assert.deepEqual(e.cause, { postgrestStatus: 502, dbCode: undefined }, JSON.stringify(body));
  }
  assert.equal(dbErrorCode({ code: '57014', message: tenantText }), '57014');
  assert.equal(dbErrorCode({ code: `57014 ${tenantText}` }), undefined);
  assert.equal(dbErrorCode(undefined), undefined);
  /* A refusal the database names keeps no cause at all, as before. */
  assert.equal(fromPostgrest(pg('P0002', 'E_NOT_FOUND')).cause, undefined);
});

test('database details, hints and row echoes never survive the mapping', () => {
  const secret = 'synthetic-reviewer@example.invalid';
  const b = pg('23514', `new row for relation "invitations" violates check constraint "x"`, {
    details: `Failing row contains (1, ${secret}, ...).`,
    hint: `try ${secret}`,
  });
  const e = fromPostgrest(b);
  const flat = JSON.stringify({ ...e, message: e.message, stack: e.stack, cause: e.cause });
  assert.ok(!flat.includes(secret), `mapped error carries database text: ${flat}`);
  assert.ok(!flat.includes('Failing row'), flat);
  assert.deepEqual(errorBody(e.code), { ok: false, code: 'E_BODY_INVALID', message: messageFor('E_BODY_INVALID') });
});

/* E4 design 3.5 and 2.6 item 3: each code with its status and the SQLSTATE its routine raises it with (null: the service
   alone raises it). Every database-raised code must reach its status through fromPostgrest with details and hint
   dropped; migration 006 part B raises them, and tests/e3/unit/migration-text.test.mjs holds each raise to its class. */
const E4_CODES = [
  ['E_NOT_REVIEWABLE', 409, 'P0001'],
  ['E_ROLE_REQUIRED', 403, '42501'],
  ['E_REVIEWER_IS_CONTRIBUTOR', 403, '42501'],
  ['E_ALREADY_SIGNED', 409, 'P0001'],
  ['E_ENVELOPE_CLOSED', 409, 'P0001'],
  ['E_ENVELOPE_APPROVED', 409, 'P0001'],
  ['E_ENVELOPE_REQUIRED', 409, 'P0001'],
  ['E_ENVELOPE_LIMIT', 409, 'P0001'],
  ['E_DERIVED_CHANGED', 409, null],
  ['E_ADAPTER_CHANGED', 409, 'P0001'],
  ['E_POLICY_CHANGED', 409, 'P0001'],
  ['E_NOT_APPROVED', 409, 'P0001'],
  ['E_ENVELOPE_NOT_APPROVED', 409, 'P0001'],
  ['E_CANDIDATE_SUPERSEDED', 409, 'P0001'],
  ['E_AGENT_ORPHANED', 409, 'P0001'],
  ['E_TARGET_NOT_PUBLISHABLE', 409, 'P0001'],
  ['E_INSTALLER_UNREGISTERED', 503, 'P0003'],
  ['E_ALREADY_WITHDRAWN', 409, 'P0001'],
  ['E_GROUP_NAME_TAKEN', 409, 'P0001'],
  ['E_GROUP_LIMIT', 409, 'P0001'],
  ['E_ASSEMBLY_TOO_LARGE', 422, '22023'],
  ['E_RELEASE_WITHDRAWN', 409, 'P0001'],
  ['E_ASSEMBLY_DIVERGED', 500, 'P0004'],
];

test('E4 design 3.5: every code has its status and a sentence of its own, and each database code reaches it through fromPostgrest', () => {
  for (const [code, status, sqlstate] of E4_CODES) {
    assert.equal(CODES[code], status, code);
    if (code !== 'E_ASSEMBLY_DIVERGED') assert.notEqual(messageFor(code), messageFor('E_INTERNAL'), code);
    if (sqlstate === null) continue;
    const e = fromPostgrest(pg(sqlstate, code, { details: 'Failing row contains (synthetic prose)', hint: 'x' }));
    assert.deepEqual([e.code, e.status, e.cause], [code, status, undefined], `${code} under ${sqlstate}`);
    assert.equal(JSON.stringify(errorBody(e.code)).includes('synthetic prose'), false, code);
  }
  assert.equal(new Set(E4_CODES.map(([code]) => messageFor(code))).size, E4_CODES.length, 'no two share a sentence');
});

test('E4 2.6 item 3: P0004 forwards E_ASSEMBLY_DIVERGED and not a code of another status; the E4 codes under a wrong class are internal', () => {
  for (const [sqlstate, message, want] of [
    ['P0001', 'E_ASSEMBLY_DIVERGED', ['E_INTERNAL', 500]],
    ['P0003', 'E_ASSEMBLY_DIVERGED', ['E_INTERNAL', 500]],
    ['P0004', 'E_NOT_FOUND', ['E_INTERNAL', 500]],
    ['P0004', 'E_INSTALLER_UNREGISTERED', ['E_INTERNAL', 500]],
    ['P0001', 'E_INSTALLER_UNREGISTERED', ['E_INTERNAL', 500]],
    ['42501', 'E_GROUP_LIMIT', ['E_INTERNAL', 500]],
    ['22023', 'E_GROUP_NAME_TAKEN', ['E_BODY_INVALID', 422]],
    ['P0001', 'E_ASSEMBLY_TOO_LARGE', ['E_INTERNAL', 500]],
  ]) {
    const e = fromPostgrest(pg(sqlstate, message));
    assert.deepEqual([e.code, e.status], want, `${message} under ${sqlstate}`);
  }
});

test('AppError refuses unknown codes and errorBody never returns an unknown code', () => {
  assert.throws(() => new AppError('E_MADE_UP'), TypeError);
  assert.deepEqual(errorBody('E_MADE_UP'), { ok: false, code: 'E_INTERNAL', message: messageFor('E_INTERNAL') });
  for (const [code, status] of Object.entries(CODES)) assert.equal(new AppError(code).status, status);
});
