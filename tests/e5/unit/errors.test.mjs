/* The E5 code tripwire, no stack (E5 design 3.5). Every E_ code an E5 module or migration 007 can answer is in
   lib/errors.mjs CODES with 3.5's status, so a refusal never becomes 500 E_INTERNAL; a code the registry lacks fails
   here by name. It replaces the arm tests/e4/unit/errors-and-vectors.test.mjs held over the retired download seam. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../../lib/errors.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

const E5_SOURCES = [
  'lib/services/catalog.mjs',
  'lib/services/installations.mjs',
  'lib/rules/installations.mjs',
  'supabase/migrations/007_installations.sql',
];
/* Raised where no PostgREST role reaches (design 3.5, the owner-side refusals): the two append-only triggers. The
   audit guard's own refusals are excluded by prefix, as tests/e4/unit/errors-and-vectors.test.mjs excludes them: they
   answer a malformed audit row written by a routine, which is a defect in that routine and never a client's answer. */
const OWNER_SIDE = new Set(['E_REPORT_APPEND_ONLY', 'E_WITNESS_APPEND_ONLY']);
const auditGuard = (code) => code.startsWith('E_AUDIT_');
const codesIn = (text) => new Set([...text.matchAll(/'(E_[A-Z0-9_]+)'/g)].map((m) => m[1]));

function missing(sources) {
  const out = [];
  for (const [name, text] of sources)
    for (const code of codesIn(text))
      if (!(code in CODES) && !OWNER_SIDE.has(code) && !auditGuard(code)) out.push(`${name}: ${code}`);
  return out;
}

test('every code an E5 module or migration 007 can answer is in CODES', () => {
  const sources = E5_SOURCES.map((rel) => [rel, read(rel)]);
  assert.deepEqual(missing(sources), []);
  const all = new Set(sources.flatMap(([, text]) => [...codesIn(text)]));
  assert.ok(all.size >= 15, `${all.size} codes read`);
});

test('control: a code the registry lacks is named', () => {
  assert.deepEqual(missing([['x.mjs', "throw new AppError('E_INSTALL_MADE_UP');"]]), ['x.mjs: E_INSTALL_MADE_UP']);
});

test('3.5 s statuses for every code E5 adds, and for the ones its services raise before any call', () => {
  const expected = {
    E_RELEASE_SUPERSEDED: 409,
    E_DOWNLOAD_LIMIT: 409,
    E_NOT_DOWNLOADED: 409,
    E_LOSSES_REQUIRED: 422,
    E_REPORT_LIMIT: 409,
    E_ALREADY_WITNESSED: 409,
    E_WITNESS_LIMIT: 409,
    E_WITNESS_IS_RECIPIENT: 403,
    E_RELEASE_WITHDRAWN: 409,
    E_AGENT_ORPHANED: 409,
    E_AGENT_ARCHIVED: 409,
    E_TARGET_NOT_PUBLISHABLE: 409,
    E_IDEMPOTENCY_KEY_INVALID: 422,
    E_BODY_INVALID: 422,
    E_NOT_FOUND: 404,
    E_READ_OVER_BOUND: 500,
    E_INTERNAL: 500,
  };
  for (const [code, status] of Object.entries(expected)) assert.equal(CODES[code], status, code);
});

/* E6S-F1 made this comparison read the LIVE definitions rather than 007's. It compared 007's predicate text with
   007's routine text, and 008 REPLACED the predicate and gave it a new answer, E_ACCESS_PERIOD_ENDED; the routine
   stayed 007's, its case had no arm for the new code, and the else raises a message with no E_ token, so a member
   of a company past its export window met 500 E_INTERNAL on a download where design 1.5 and 3.1 say 409. The pin
   passed throughout, because it was reading a predicate the database no longer had. It now takes the LAST
   definition of each across every migration in order, which is what the database ends up with, so a later
   replacement of either one cannot blind it again. */
function liveDefinition(name) {
  let found = null;
  for (const file of readdirSync(join(REPO, 'supabase/migrations')).sort()) {
    const text = read(`supabase/migrations/${file}`);
    const at = text.lastIndexOf(`create or replace function ${name}(`);
    if (at < 0) continue;
    const open = text.indexOf('$$', at);
    found = { file, text: text.slice(at, text.indexOf('$$;', open + 2) + 3) };
  }
  assert.ok(found, `${name} is defined in some migration`);
  return found;
}

test('every code the LIVE predicate can answer is one the LIVE api.authorize_download maps, and the two lists agree', () => {
  const predicate = liveDefinition('app.download_refusal_for');
  const routine = liveDefinition('api.authorize_download');
  const answered = [...new Set([...predicate.text.matchAll(/'(E_[A-Z_]+)'/g)].map((m) => m[1]))].sort();
  const mapped = [...new Set([...routine.text.matchAll(/when '(E_[A-Z_]+)' then/g)].map((m) => m[1]))].sort();
  assert.deepEqual(
    answered,
    mapped,
    `the predicate (${predicate.file}) answers exactly what the routine (${routine.file}) maps to a status`,
  );
  for (const code of answered) assert.ok(code in CODES, code);
});

test('E6S-F1 control: the comparison this replaced passes on the same pair, which is how the defect survived', () => {
  const sql = read('supabase/migrations/007_installations.sql');
  const predicate = sql.slice(sql.indexOf('create or replace function app.download_refusal_for'));
  const body = predicate.slice(0, predicate.indexOf('$$;'));
  const answered = [...new Set([...body.matchAll(/'(E_[A-Z_]+)'/g)].map((m) => m[1]))].sort();
  const routine = sql.slice(sql.indexOf('create or replace function api.authorize_download'));
  const mapped = [...new Set([...routine.matchAll(/when '(E_[A-Z_]+)' then/g)].map((m) => m[1]))].sort();
  assert.deepEqual(answered, mapped, "007 against 007 agrees, and always did: that is the blindness, not a pass");
  /* And the live predicate answers a code 007's did not, which is the difference the old shape could not see. */
  const live = liveDefinition('app.download_refusal_for');
  const liveCodes = new Set([...live.text.matchAll(/'(E_[A-Z_]+)'/g)].map((m) => m[1]));
  assert.equal(liveCodes.has('E_ACCESS_PERIOD_ENDED'), true);
  assert.equal(answered.includes('E_ACCESS_PERIOD_ENDED'), false);
});
