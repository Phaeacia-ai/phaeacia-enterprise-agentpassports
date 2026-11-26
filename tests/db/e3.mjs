#!/usr/bin/env node
/* E3 database probe helper, called by tests/db/12-* onward. Local stack only.

   Every passport is built by the real lib/passport/gate.mjs, and every request body and binding digest by the
   real lib/db/server.mjs bindCall(), so each routine call a probe makes through PostgREST is also a Node-to-SQL
   check of the binding and operation projections (case 14 at the routine level). Bearers are minted with the
   claims serverToken() mints, HS256 with the local JWT_SECRET that tests/db/lib.sh exports, plus the three
   binding claims; a probe may override or drop claims to build the refusals of case 11.

   Commands (API_URL, ANON_KEY and JWT_SECRET come from the environment):
     passport [--revision N] [--validated-at ISO]      JSON of the gated passport
     call <fn> <sub> <args-json> [options]             POST /rest/v1/rpc/<fn>; prints "HTTP <status> <body>"
     sql <fn> <sub> <args-json> [options]              the same call as SQL for an owner psql session
     replay <file>                                     POST a call saved with --save, same bearer and body
     body <file>                                       the JSON body of a saved call
     binding-sql <fn> | operation-sql <fn>             bindingSql(fn), operationSql(fn)
     vectors-sql                                       case 14's typed cross-runtime vectors as SQL
     field <name>                                      read "HTTP <status> <json>" or JSON on stdin, print a field
   In <args-json>, "@content", "@derived", "@content_sha256" and "@gate" are the passport's values and "@uuid" a
   fresh uuid. Options: --revision N; --validated-at ISO; --aal aal1|aal2; --claims <json merged last>;
   --drop <claim[,claim]>; --gate <hex>; --save <file>; --bind-revision N, which binds the bearer to the same
   call with revision N's passport while the body carries --revision's (the "different content" of case 11). */

import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.env.SUPABASE_URL ??= process.env.API_URL ?? 'http://127.0.0.1:54321';
process.env.SUPABASE_ANON_KEY ??= process.env.ANON_KEY ?? 'unset';
const { bindCall, bindingSql, operationSql } = await import('../../lib/db/server.mjs');
const { gate } = await import('../../lib/passport/gate.mjs');

const SYNTHETIC = readFileSync(join(REPO, 'tests/native-transfer/passport/fixtures/SYNTHETIC-passport.md'), 'utf8');
const PROSE = 'It runs when you paste records and ask it to run.';

function options(argv) {
  const out = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out.rest.push(a);
  }
  return out;
}

export function passport({ revision = '0', validatedAt = new Date().toISOString() } = {}) {
  const text = SYNTHETIC.replace(PROSE, `${PROSE} Revision ${revision}.`);
  const g = gate(Buffer.from(text, 'utf8'), 'text/markdown', { validatedAt });
  if (!g.ok) throw new Error(`passport: the gate refused revision ${revision}: ${JSON.stringify(g.problems)}`);
  return {
    content: g.text,
    derived_canonical: g.derivedCanonical,
    content_sha256: g.contentSha256,
    derived_sha256: g.derivedSha256,
    gate_identity: g.gateIdentitySha256,
    validated_at: g.validatedAt,
  };
}

function withIds(args) {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v === '@uuid' ? randomUUID() : v]));
}

function withPassport(args, o, revision) {
  const p = passport({ revision, validatedAt: o['validated-at'] ?? new Date().toISOString() });
  const value = {
    '@content': p.content,
    '@derived': p.derived_canonical,
    '@content_sha256': p.content_sha256,
    '@gate': o.gate ?? p.gate_identity,
  };
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, Object.hasOwn(value, v) ? value[v] : v]));
}

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function mint(sub, fn, argsSha256, o) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { role: 'app_server', sub, iss: 'phaeacia-server', iat: now, exp: now + 60 };
  if (o.aal) claims.aal = o.aal;
  Object.assign(claims, { fn, args_sha256: argsSha256, jti: randomUUID() });
  if (o.claims) Object.assign(claims, JSON.parse(o.claims));
  if (o.drop) for (const name of o.drop.split(',')) delete claims[name];
  const input = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(claims)}`;
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

async function post(fn, token, body) {
  const r = await fetch(`${process.env.API_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: process.env.ANON_KEY,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const textBody = await r.text();
  return `HTTP ${r.status} ${textBody.slice(0, 1200)}`;
}

/* A SQL literal for one bound parameter, by the value lib/db/server.mjs put in the body. */
function literal(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string' && value.startsWith(String.fromCharCode(92, 120))) return `decode('${value.slice(2)}', 'hex')`;
  const tag = '$lit$';
  if (String(value).includes(tag)) throw new Error('literal: value holds the dollar tag');
  return `${tag}${value}${tag}`;
}

const SQL_TYPES = {
  p_company: 'uuid',
  p_agent: 'uuid',
  p_candidate: 'uuid',
  p_idempotency_key: 'uuid',
  p_expected_version: 'integer',
  p_agent_name: 'text',
  p_content: 'text',
  p_derived_canonical: 'text',
  p_submission_canonical: 'text',
  p_content_sha256: 'bytea',
  p_gate_identity: 'bytea',
};

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const o = options(argv);
  switch (command) {
    case 'passport':
      process.stdout.write(`${JSON.stringify(passport({ revision: o.revision ?? '0', validatedAt: o['validated-at'] }))}\n`);
      return 0;
    case 'call':
    case 'sql': {
      const [fn, sub, argsJson] = o.rest;
      const ids = withIds(JSON.parse(argsJson));
      const args = withPassport(ids, o, o.revision ?? '0');
      const call = bindCall(fn, args);
      const bound = o['bind-revision'] ? bindCall(fn, withPassport(ids, o, o['bind-revision'])) : call;
      const token = mint(sub, fn, bound.argsSha256, o);
      if (o.save) writeFileSync(o.save, JSON.stringify({ fn, token, body: call.body }));
      if (command === 'call') {
        process.stdout.write(`${await post(fn, token, call.body)}\n`);
        return 0;
      }
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      const named = Object.entries(call.body)
        .map(([param, value]) => `${param} => ${literal(value)}${value === null ? `::${SQL_TYPES[param]}` : ''}`)
        .join(', ');
      process.stdout.write(
        `select set_config('request.jwt.claims', '${JSON.stringify(claims)}', true);\nselect api.${fn}(${named})::text;\n`,
      );
      return 0;
    }
    case 'replay': {
      const saved = JSON.parse(readFileSync(o.rest[0], 'utf8'));
      process.stdout.write(`${await post(saved.fn, saved.token, saved.body)}\n`);
      return 0;
    }
    case 'body':
      process.stdout.write(`${JSON.stringify(JSON.parse(readFileSync(o.rest[0], 'utf8')).body)}\n`);
      return 0;
    case 'literal': {
      /* A SQL literal of one passport field for an owner-side statement: content and derived dollar-quoted,
         the two hashes as decode(hex). */
      const p = passport({ revision: o.revision ?? '0', validatedAt: o['validated-at'] });
      const field = o.rest[0];
      if (field === 'content') process.stdout.write(`${literal(p.content)}\n`);
      else if (field === 'derived') process.stdout.write(`${literal(p.derived_canonical)}\n`);
      else if (field === 'content_sha256' || field === 'derived_sha256' || field === 'gate_identity')
        process.stdout.write(`decode('${p[field]}', 'hex')\n`);
      else if (field === 'hex') process.stdout.write(`${p[o.rest[1]]}\n`);
      else throw new Error(`literal: unknown field ${field}`);
      return 0;
    }
    case 'mutate': {
      /* A fail-before mutant: the definition on stdin with E3_FROM replaced once by E3_TO. An anchor that is
         not in the definition is a probe defect, so it fails loudly instead of running the unmutated code. */
      const def = readFileSync(0, 'utf8');
      const from = process.env.E3_FROM ?? '';
      if (!from || !def.includes(from)) {
        process.stderr.write(`mutate: anchor not found: ${from.slice(0, 120)}\n`);
        return 2;
      }
      /* A function replacer inserts the text literally; a string replacer would expand $' and $& in SQL. */
      const to = process.env.E3_TO ?? '';
      process.stdout.write(def.replace(from, () => to));
      return 0;
    }
    case 'binding-sql':
      process.stdout.write(`${bindingSql(o.rest[0])}\n`);
      return 0;
    case 'operation-sql':
      process.stdout.write(`${operationSql(o.rest[0])}\n`);
      return 0;
    case 'vectors-sql':
      process.stdout.write(vectorsSql());
      return 0;
    case 'field': {
      const input = readFileSync(0, 'utf8').trim();
      const json = input.startsWith('HTTP ') ? input.slice(input.indexOf(' ', 5) + 1) : input;
      const v = JSON.parse(json)?.[o.rest[0]];
      process.stdout.write(`${v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : v}\n`);
      return 0;
    }
    default:
      process.stderr.write(`e3.mjs: unknown command ${command}\n`);
      return 2;
  }
}

/* Case 14: ten argument sets through json_to_record with the design 4.4 parameter types into pg_temp functions
   whose bodies are bindingSql(fn) and operationSql(fn), compared with Node's digests, plus the uncoalesced
   counterexample. The vectors are evidence/e3-prereq-2-6.md appendix H's, on the current field lists; every
   invisible character is built from its code point. */
function vectorsSql() {
  const SIG = {
    create_draft: [
      ['p_company', 'uuid'],
      ['p_agent', 'uuid'],
      ['p_agent_name', 'text'],
      ['p_content', 'text'],
      ['p_derived_canonical', 'text'],
      ['p_gate_identity', 'bytea'],
      ['p_idempotency_key', 'uuid'],
    ],
    save_draft: [
      ['p_candidate', 'uuid'],
      ['p_expected_version', 'integer'],
      ['p_content', 'text'],
      ['p_derived_canonical', 'text'],
      ['p_gate_identity', 'bytea'],
      ['p_idempotency_key', 'uuid'],
    ],
    submit_candidate: [
      ['p_candidate', 'uuid'],
      ['p_expected_version', 'integer'],
      ['p_content_sha256', 'bytea'],
      ['p_derived_canonical', 'text'],
      ['p_submission_canonical', 'text'],
      ['p_gate_identity', 'bytea'],
      ['p_idempotency_key', 'uuid'],
    ],
    create_successor: [
      ['p_candidate', 'uuid'],
      ['p_content_sha256', 'bytea'],
      ['p_derived_canonical', 'text'],
      ['p_gate_identity', 'bytea'],
      ['p_idempotency_key', 'uuid'],
    ],
  };
  const ID = 'abcdef00-1111-4111-8111-111111111111';
  const COMPANY = '0b5c3f0e-8d4a-4c1e-9f2a-6d7e8f9a0b1c';
  const KEY = '22222222-2222-4222-8222-222222222222';
  const GATE = 'a'.repeat(64);
  const astral = String.fromCodePoint(0x1f600);
  const ls = String.fromCodePoint(0x2028);
  const slash = `${String.fromCharCode(92)}/`;
  const draft = { company_id: COMPANY, content: 'content', derived_canonical: '{}', gate_identity: GATE, idempotency_key: KEY };
  const save = { candidate_id: ID, expected_version: 3, content: 'content', derived_canonical: '{}', gate_identity: GATE, idempotency_key: KEY };
  const VECTORS = [
    ['draft_by_name_agent_absent', 'create_draft', { ...draft, agent_name: 'weekly-brief' }],
    ['draft_by_id_name_null', 'create_draft', { ...draft, agent_id: ID, agent_name: null }],
    ['draft_both_agent_fields_absent', 'create_draft', { ...draft }],
    ['draft_astral_name_uppercase_company', 'create_draft', { ...draft, company_id: COMPANY.toUpperCase(), agent_name: `brief ${astral}` }],
    ['save_u2028_in_content_and_canonical_json', 'save_draft', { ...save, content: `c${ls}`, derived_canonical: `{"x":"${ls}","s":"${slash}"}` }],
    ['save_256_kib_content', 'save_draft', { ...save, content: 'x'.repeat(262144) }],
    ['save_int4_min_uppercase_candidate', 'save_draft', { ...save, candidate_id: ID.toUpperCase(), expected_version: -2147483648 }],
    [
      'submit_uppercase_content_sha256',
      'submit_candidate',
      { candidate_id: ID, expected_version: 2147483647, content_sha256: 'AB'.repeat(32), derived_canonical: '{}', submission_canonical: '{"confidence":"high"}', gate_identity: GATE, idempotency_key: KEY },
    ],
    ['submit_hash_and_submission_absent', 'submit_candidate', { candidate_id: ID, expected_version: 1, derived_canonical: '{}', gate_identity: GATE, idempotency_key: KEY }],
    ['successor_empty_canonical', 'create_successor', { candidate_id: ID, content_sha256: 'cd'.repeat(32), derived_canonical: '', gate_identity: 'EF'.repeat(32), idempotency_key: KEY }],
  ];
  const q = (s) => `$j$${s}$j$`;
  const sql = ['begin;'];
  /* The four E3 names only, which are SIG's keys: these vectors feed probe 14's E3 routines. BOUND also holds E4's four
     since migration 006 part A (E4 design 2.6 item 1); their cross-runtime vectors are the E4 lane's. */
  for (const fn of Object.keys(SIG)) {
    const params = SIG[fn].map(([p, t]) => `${p} ${t}`).join(', ');
    sql.push(`create function pg_temp.bind_${fn}(${params}) returns text language sql as $f$ select encode(${bindingSql(fn)}, 'hex') $f$;`);
    sql.push(`create function pg_temp.op_${fn}(${params}) returns text language sql as $f$ select encode(${operationSql(fn)}, 'hex') $f$;`);
  }
  sql.push(
    "create function pg_temp.bind_uncoalesced(p_company uuid, p_agent uuid, p_agent_name text, p_content text, p_derived_canonical text, p_gate_identity bytea, p_idempotency_key uuid) returns text language sql as $f$ select encode(sha256(convert_to(concat_ws(E'\\n', 'create_draft', p_company::text, p_agent::text, encode(sha256(convert_to(p_agent_name, 'UTF8')), 'hex'), encode(sha256(convert_to(p_content, 'UTF8')), 'hex'), encode(sha256(convert_to(p_derived_canonical, 'UTF8')), 'hex'), encode(p_gate_identity, 'hex'), p_idempotency_key::text), 'UTF8')), 'hex') $f$;",
  );
  for (const [name, fn, args] of VECTORS) {
    const call = bindCall(fn, args);
    const cols = SIG[fn].map(([p, t]) => `${p} ${t}`).join(', ');
    const argList = SIG[fn].map(([p]) => `r.${p}`).join(', ');
    sql.push(
      `select 'VECTOR_${name}', pg_temp.bind_${fn}(${argList}) = '${call.argsSha256}', pg_temp.op_${fn}(${argList}) = '${call.operationSha256}' from json_to_record(${q(JSON.stringify(call.body))}) as r(${cols});`,
    );
  }
  const first = bindCall('create_draft', VECTORS[0][2]);
  const cols = SIG.create_draft.map(([p, t]) => `${p} ${t}`).join(', ');
  const argList = SIG.create_draft.map(([p]) => `r.${p}`).join(', ');
  sql.push(
    `select 'UNCOALESCED_DIFFERS', pg_temp.bind_uncoalesced(${argList}) <> '${first.argsSha256}' from json_to_record(${q(JSON.stringify(first.body))}) as r(${cols});`,
  );
  sql.push('rollback;');
  return `${sql.join('\n')}\n`;
}

process.exitCode = await main();
