/* Pages construction, the display-name write path against the local stack (pages design 7.2): S13 (a) to (h) through
   the route, S13d the shared corpus's same rows sent straight to the database function, and S13p its shape and
   conversion rows. Reseeds once through tests/db/00-seed.sh. S13d and S13p post to PostgREST with a token from
   serverToken and read PostgREST's own answer, not rpc's derived code. Every stored value is compared as UTF-8 hex
   read by the migration owner, so no name is printed. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { CORPUS, routeBody, rpcBody } from '../fixtures/display-name-corpus.mjs';
import { caller, logFindings, mint, newAccount, sessionOf, sql } from '../helpers/pages.mjs';
import { hs256 } from '../helpers/jwt.mjs';
import { seed } from '../helpers/stack.mjs';

const ids = seed();
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { serverToken } = await import('../../../lib/db/server.mjs');
const { normalizeDisplayName } = await import('../../../lib/rules/profiles.mjs');

const logged = [];
const routes = makeRoutes({ log: (e) => logged.push(e) });
const { call } = caller(routes, { COOKIES, makeRequest });
const hex = (text) => Buffer.from(text, 'utf8').toString('hex');
const storedHex = (userId) =>
  sql(
    `select coalesce((select encode(convert_to(display_name, 'UTF8'), 'hex') from app.profiles where user_id = '${userId}'), 'none')`,
  );
const rowState = (userId) =>
  sql(
    `select coalesce((select encode(convert_to(display_name, 'UTF8'), 'hex') || '|' || updated_at from app.profiles where user_id = '${userId}'), 'none')`,
  );
const auditCount = (userId) =>
  Number(
    sql(`select count(*) from app.audit_events where action = 'profile.set_display_name' and entity_id = '${userId}'`),
  );
const everyProfile = () =>
  sql(
    "select coalesce(string_agg(user_id || ':' || encode(convert_to(display_name, 'UTF8'), 'hex') || ':' || updated_at, ',' order by user_id), '') from app.profiles",
  )
    .split(',')
    .filter(Boolean);
const tokenFor = (account, aal = 'aal1') => mint({ sub: account.id, email: account.email, aal });
const setName = (access, body) => call('meDisplayName', { access, body });
const names = [];

let ada;
test('S13 (a) a new name is trimmed and stored for that user alone, with one audit row that holds the user id and nothing of the name', async () => {
  ada = newAccount('ada');
  const before = everyProfile();
  const r = await setName(tokenFor(ada), { displayName: '  Ada Example  ' });
  names.push('Ada Example');
  assert.equal(r.status, 204);
  assert.equal(r.body, null);
  assert.equal(storedHex(ada.id), hex('Ada Example'));
  const after = everyProfile();
  assert.deepEqual(
    after.filter((row) => !before.includes(row)).map((row) => row.split(':')[0]),
    [ada.id],
    'no other row changed',
  );
  assert.ok(before.every((row) => after.includes(row)));
  assert.equal(
    sql(
      `select count(*) || '|' || bool_and(company_id is null) || '|' || string_agg(actor_kind, ',') || '|' || string_agg(entity_type, ',') || '|' || string_agg(entity_id::text, ',') || '|' || string_agg(actor_user_id::text, ',') || '|' || string_agg(details::text, ',') from app.audit_events where action = 'profile.set_display_name' and entity_id = '${ada.id}'`,
    ),
    `1|true|member|profile|${ada.id}|${ada.id}|{"user_id": "${ada.id}"}`,
  );
  assert.equal(
    sql(`select count(*) from app.audit_events a where a::text like '%Ada Example%'`),
    '0',
    'no column holds the name',
  );
});

test('S13 (b) the same name again answers 204, writes no audit row and leaves updated_at alone', async () => {
  const state = rowState(ada.id);
  const r = await setName(tokenFor(ada, 'aal2'), { displayName: 'Ada Example' });
  assert.equal(r.status, 204);
  assert.equal(rowState(ada.id), state, 'updated_at unchanged');
  assert.equal(auditCount(ada.id), 1);
});

test('S13 (c) every corpus row the Node column refuses answers 422 E_BODY_INVALID, with no write and no audit row', async () => {
  const state = rowState(ada.id);
  const refused = CORPUS.filter((row) => row.node === null);
  assert.ok(refused.length >= 20);
  for (const row of refused) {
    const r = await setName(tokenFor(ada), routeBody(row));
    assert.equal(r.status, 422, row.label);
    assert.equal(r.body.code, 'E_BODY_INVALID', row.label);
    assert.equal(rowState(ada.id), state, `${row.label}: no write`);
  }
  assert.equal(auditCount(ada.id), 1, 'no audit row');
});

test('S13 (e) a removed member, an outsider, a user with no membership, an operator, and sessions at aal1 and aal2 each set their own name', async () => {
  const fresh = newAccount('nomember');
  const twice = newAccount('twoaal');
  const classes = [
    ['removed member', { id: ids.U_alpha_removed, email: 'synthetic-alpha-removed@example.invalid' }, 'aal2'],
    ['outsider', { id: ids.U_outsider, email: 'synthetic-outsider@example.invalid' }, 'aal1'],
    ['no membership', fresh, 'aal1'],
    ['operator', { id: ids.U_op, email: 'synthetic-op@example.invalid' }, 'aal2'],
    ['a session at aal1', twice, 'aal1'],
    ['a session at aal2', twice, 'aal2'],
  ];
  for (const [label, account, aal] of classes) {
    const name = `Name for ${label} ${aal}`;
    names.push(name);
    const r = await setName(tokenFor(account, aal), { displayName: name });
    assert.equal(r.status, 204, label);
    assert.equal(storedHex(account.id), hex(name), label);
  }
});

test('S13 (f) one user s call leaves another user s row untouched, and no body key names another user', async () => {
  const other = newAccount('other');
  assert.equal((await setName(tokenFor(other), { displayName: 'Other Person' })).status, 204);
  names.push('Other Person');
  const otherState = rowState(other.id);
  const r = await setName(tokenFor(ada), {
    displayName: 'Ada Renamed',
    userId: other.id,
    user_id: other.id,
    p_user: other.id,
    p_display_name: 'Hijack',
  });
  names.push('Ada Renamed');
  assert.equal(r.status, 204);
  assert.equal(storedHex(ada.id), hex('Ada Renamed'));
  assert.equal(rowState(other.id), otherState, 'the other row is untouched');
  assert.equal(sql(`select count(*) from app.profiles where display_name = 'Hijack'`), '0');
});

const rpc = async (bearer, bodyText, { apikey = process.env.SUPABASE_ANON_KEY } = {}) => {
  const headers = { apikey, 'content-type': 'application/json', accept: 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/set_display_name`, {
    method: 'POST',
    headers,
    body: bodyText,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('S13 (g) neither anon nor authenticated can execute the function through PostgREST, and neither may insert or update app.profiles', async () => {
  const state = rowState(ada.id);
  for (const [label, bearer] of [
    ['anon key alone', null],
    ['anon key as bearer', process.env.SUPABASE_ANON_KEY],
    ['a user s own token', tokenFor(ada)],
  ]) {
    const r = await rpc(bearer, JSON.stringify({ p_display_name: 'Direct' }));
    assert.ok(r.status >= 400, `${label}: ${r.status}`);
    assert.equal(r.body?.code, '42501', label);
  }
  assert.equal(rowState(ada.id), state);
  assert.equal(
    sql(
      "select has_table_privilege('anon', 'app.profiles', 'insert') || '|' || has_table_privilege('anon', 'app.profiles', 'update') || '|' || has_table_privilege('authenticated', 'app.profiles', 'insert') || '|' || has_table_privilege('authenticated', 'app.profiles', 'update')",
    ),
    'false|false|false|false',
  );
});

test('S13 (h) a server token carrying an fn claim is refused E_NOT_SERVER and writes nothing', async () => {
  const now = Math.floor(Date.now() / 1000);
  const bound = hs256(
    {
      role: 'app_server',
      sub: ada.id,
      aal: 'aal1',
      iss: 'phaeacia-server',
      iat: now,
      exp: now + 60,
      fn: 'save_draft',
      args_sha256: 'a'.repeat(64),
      jti: randomUUID(),
    },
    process.env.SUPABASE_JWT_SECRET,
  );
  const state = rowState(ada.id);
  const r = await rpc(bound, JSON.stringify({ p_display_name: 'Bound' }));
  assert.equal(r.body?.code, '42501');
  assert.equal(r.body?.message, 'E_NOT_SERVER');
  assert.equal(rowState(ada.id), state);
});

test('S13d the same rows sent directly with a server token: each refused row is 22023 E_BODY_INVALID with no write, each accepted row stores what normalizeDisplayName returns', async () => {
  const account = newAccount('corpus');
  const session = await sessionOf(tokenFor(account));
  const same = CORPUS.filter((row) => row.kind === 'same');
  for (const row of same) {
    const state = rowState(account.id);
    const audits = auditCount(account.id);
    const r = await rpc(serverToken(session), JSON.stringify(rpcBody(row)));
    if (row.sql.sqlstate) {
      assert.equal(r.body?.code, '22023', row.label);
      assert.equal(r.body?.message, 'E_BODY_INVALID', row.label);
      assert.equal(rowState(account.id), state, `${row.label}: no write`);
      assert.equal(auditCount(account.id), audits, `${row.label}: no audit row`);
      assert.equal(normalizeDisplayName(row.value).ok, false, `${row.label}: Node refuses it too`);
    } else {
      assert.equal(r.status, 200, `${row.label}: ${JSON.stringify(r.body)}`);
      assert.equal(storedHex(account.id), hex(row.sql.stores), row.label);
      assert.equal(
        normalizeDisplayName(row.value).value,
        row.sql.stores,
        `${row.label}: the same value in both layers`,
      );
      names.push(row.sql.stores);
    }
  }
});

test('S13p inputs that are not strings or cannot become text, sent directly: 123 and [] are stored as text, null is 22023, NUL 22P05, a lone surrogate PGRST102, {} writes nothing', async (t) => {
  const account = newAccount('shapes');
  const session = await sessionOf(tokenFor(account));
  const base = await rpc(serverToken(session), JSON.stringify({ p_display_name: 'Base Name' }));
  assert.equal(base.status, 200);
  const rows = CORPUS.filter((row) => row.kind !== 'same');
  const storing = rows.filter((row) => row.sql.stores !== undefined);
  for (const row of [...rows.filter((r) => r.sql.stores === undefined), ...storing]) {
    const state = rowState(account.id);
    const audits = auditCount(account.id);
    const body = JSON.stringify(rpcBody(row));
    if (row.label.startsWith('a lone surrogate')) assert.match(body, /\\ud800/, 'the JSON escape, not U+FFFD');
    if (row.label.startsWith('U+0000')) assert.match(body, /\\u0000/);
    const r = await rpc(serverToken(session), body);
    if (row.sql.stores !== undefined) {
      assert.equal(r.status, 200, row.label);
      assert.equal(storedHex(account.id), hex(row.sql.stores), row.label);
    } else {
      assert.equal(rowState(account.id), state, `${row.label}: no write`);
      assert.equal(auditCount(account.id), audits, `${row.label}: no audit row`);
      if (row.sql.sqlstate) assert.equal(r.body?.code, row.sql.sqlstate, `${row.label}: ${JSON.stringify(r.body)}`);
      else
        t.diagnostic(
          `S13p ${row.label}: PostgREST answered ${r.status} ${r.body?.code ?? ''} (recorded, not specified)`,
        );
    }
    assert.equal(normalizeDisplayName(row.value).ok, false, `${row.label}: the route refuses it first`);
  }
});

test('S7 for this file: no log line carries an address or a display name', () => {
  assert.deepEqual(logFindings(logged, names), []);
});
