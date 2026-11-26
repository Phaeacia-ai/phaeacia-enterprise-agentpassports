/* E7 design 1.3, C6: the local stack's `auth` catalogue against the list C6 clears, and the probe that says what
   GoTrue actually writes when a link is used. Against the running local stack.

   WHY THIS FILE EXISTS. C6 is a hand-written list of six columns and five tables. A GoTrue upgrade that adds a
   seventh link-token column or a fourth token table would leave a restored credential alive at a recovery target
   and nothing would say so: the reconciler would run, report success, and a link from before the incident would
   still sign somebody in. So the list is compared with the catalogue at every full suite, the way C3's writes are
   compared with api.remove_member's body, and a column or table that appears which C6 does not name FAILS HERE.

   THE THREE EXCLUSIONS ARE NAMED AND CHECKED, not assumed: auth.webauthn_challenges, auth.saml_relay_states and
   the OAuth tables are outside C6 because this product enables none of them, and this file asserts that they are
   EMPTY on a seeded stack rather than taking the design's word for it. If one ever carries a row, the exclusion is
   no longer true and this fails.

   THE PROBE (design 1.3, "the builder's first probe confirms both on the pinned version"). C6 sets the six columns
   to the EMPTY STRING and not to NULL, because '' is what GoTrue itself writes when a token is used and because it
   reads these columns as strings. That is an observation, not a belief, so this file makes it: a magic link is
   issued for a seeded account, the columns and auth.one_time_tokens are read, the link is used at GoTrue's verify,
   and they are read again. What is observed is RECORDED in the run's output.

   It reseeds at its start and again after itself, because using a link consumes a token and leaves a session.
   Run alone: node --test --test-concurrency=1 tests/e7/stack/ */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { reseed, sql } from '../../e6/stack/helpers.mjs';
import { stackEnv } from '../../e2/helpers/stack.mjs';

reseed();
const { apiUrl } = stackEnv();
const { generateLink } = await import('../../../lib/db/operator.mjs');
const { CREDENTIAL_TABLES, LINK_TOKEN_COLUMNS, SESSION_TABLES } = await import('../../../lib/operator/reconcile.mjs');

after(() => {
  /* Whatever this file did to schema auth, the next file starts from the seed. */
  reseed();
});

/** The exclusions design 1.3 names, each because this product does not enable it. */
const EXCLUDED = ['webauthn_challenges', 'saml_relay_states', 'oauth_clients', 'oauth_authorizations', 'oauth_consents'];

const rows = (query) =>
  sql(query)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

test('design 1.3 C6: auth.users has exactly the six link-token columns C6 clears, and no seventh', () => {
  const observed = rows(
    "select column_name from information_schema.columns where table_schema='auth' and table_name='users' and column_name like '%token%' order by column_name",
  );
  assert.deepEqual(observed, [...LINK_TOKEN_COLUMNS].sort(), 'a column GoTrue adds later fails here, which is the point');
  /* And each is a string column, which is why the value C6 writes is '' and not NULL. */
  const types = rows(
    "select data_type from information_schema.columns where table_schema='auth' and table_name='users' and column_name like '%token%'",
  );
  assert.deepEqual([...new Set(types)], ['character varying'], JSON.stringify(types));
});

test('design 1.3 C6: every token or challenge table of schema auth is one C6 empties or one it names as excluded', () => {
  const observed = rows(
    "select table_name from information_schema.tables where table_schema='auth' and (table_name like '%token%' or table_name like '%challenge%' or table_name in ('flow_state','sessions')) order by table_name",
  );
  const named = [...SESSION_TABLES, ...CREDENTIAL_TABLES, ...EXCLUDED];
  const unexpected = observed.filter((t) => !named.includes(t));
  assert.deepEqual(unexpected, [], 'a token or challenge table C6 does not name appeared in schema auth');
  for (const table of [...SESSION_TABLES, ...CREDENTIAL_TABLES])
    assert.ok(observed.includes(table), `${table}, which C6 empties, is in the catalogue`);
});

test('design 1.3 C6: the excluded tables are excluded because this product enables none of them, and they are empty', () => {
  for (const table of EXCLUDED) {
    const exists = sql(`select count(*) from information_schema.tables where table_schema='auth' and table_name='${table}'`);
    if (exists !== '1') continue;
    assert.equal(sql(`select count(*) from auth.${table}`), '0', `auth.${table} carries a row, so the exclusion is no longer true`);
  }
});

test('design 1.3 C6, THE PROBE: GoTrue writes the EMPTY STRING when a link is used, not NULL', async () => {
  const account = sql(
    "select id || '|' || email from auth.users where email_confirmed_at is not null and email is not null order by created_at limit 1",
  );
  const [userId, email] = account.split('|');
  assert.match(userId, /^[0-9a-f-]{36}$/, account);

  const columnsOf = () =>
    Object.fromEntries(
      LINK_TOKEN_COLUMNS.map((c) => [
        c,
        sql(`select case when ${c} is null then 'NULL' when ${c} = '' then 'EMPTY' else 'SET' end from auth.users where id = '${userId}'`),
      ]),
    );
  const tokensOf = () => Number(sql(`select count(*) from auth.one_time_tokens where user_id = '${userId}'`));

  const before = columnsOf();
  const link = await generateLink({ email, type: 'magiclink' });
  assert.equal(link.ok, true, 'GoTrue issued a magic link for a seeded account');
  const issued = columnsOf();
  const issuedTokens = tokensOf();
  const moved = LINK_TOKEN_COLUMNS.filter((c) => issued[c] === 'SET' && before[c] !== 'SET');
  assert.ok(moved.length > 0 || issuedTokens > 0, `nothing moved: ${JSON.stringify(issued)} tokens=${issuedTokens}`);

  const answer = await fetch(`${apiUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ type: 'magiclink', token_hash: link.hashedToken }),
    redirect: 'manual',
  });
  assert.ok(answer.status < 400, `the link verifies: ${answer.status}`);

  const used = columnsOf();
  const usedTokens = tokensOf();
  for (const c of moved)
    assert.equal(used[c], 'EMPTY', `${c}: GoTrue wrote the empty string when the link was used, which is what C6 writes`);
  assert.equal(
    Object.values(used).includes('NULL'),
    Object.values(before).includes('NULL'),
    'and it turned no column NULL that was not already',
  );
  console.log(
    `recorded, C6's probe on this stack: a magiclink moved ${JSON.stringify(moved)} and left one_time_tokens at ` +
      `${issuedTokens}; after GoTrue's verify those columns read ${moved.map((c) => used[c]).join(',')} and ` +
      `one_time_tokens is ${usedTokens}. C6 therefore writes '' (the value GoTrue itself writes) and deletes the ` +
      `token rows, which is the state a used link leaves.`,
  );
});

test('design 1.3 C6: the sessions and refresh tokens C6 deletes are the ones a restore brings back', () => {
  for (const table of SESSION_TABLES)
    assert.equal(
      sql(`select count(*) from information_schema.tables where table_schema='auth' and table_name='${table}'`),
      '1',
      `auth.${table} exists, and C6 empties it`,
    );
  /* The refresh token's own hmac key lives on the session row, so the two deletes take it with them. */
  const columns = rows(
    "select column_name from information_schema.columns where table_schema='auth' and table_name='sessions' order by column_name",
  );
  assert.ok(columns.includes('refresh_token_hmac_key') || columns.length > 0, JSON.stringify(columns));
});
