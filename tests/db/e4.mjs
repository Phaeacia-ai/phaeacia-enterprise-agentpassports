#!/usr/bin/env node
/* E4 database probe helper, beside tests/db/e3.mjs (which stays E3's and unedited, lead 2026-09-15), called through
   tests/db/e4-lib.sh by tests/db/22-* to 25-* and by request_changes. Local stack only.

   Every request body and binding digest is built by the real lib/db/server.mjs bindCall(), so each E4 routine call a
   probe makes through PostgREST is also a Node-to-SQL check of the binding and operation projections of design 2.6
   item 1. Bearers carry the claims serverToken() mints, HS256 with the local JWT_SECRET that tests/db/lib.sh exports,
   plus the three binding claims; a probe may add or drop claims to build a refusal.

   Commands (API_URL, ANON_KEY and JWT_SECRET come from the environment):
     call <fn> <sub> <args> [options]      POST /rest/v1/rpc/<fn>; prints "HTTP <status> <body>"
     sql <fn> <sub> <args> [options]       the same call as SQL for an owner psql session
     replay <file>                         POST a call saved with --save, same bearer and body
     audience <uuid> ...                   the canonical audience text the service binds (design 3.4)
     assembled-sha <json-file> <target>    lib/passport/packet.mjs assembledSha256 over {"content"} and the target's text
     golden-sha <target>                   assemble.mjs assemble() of the SYNTHETIC fixture for the target, hashed
     projected <json-file> <target>        lib/passport/packet.mjs projectedAssembledBytes over {"content"}
     vectors-sql                           the E4 binding and operation vectors as SQL (case 14's E4 half)
     canonical-sql                         case 46's envelope canonical vectors as SQL, with the collation counterexample
     reason-sql                            the reason corpus against app.review_reason, as SQL
     group-name-sql <company> <admin-sub>  the group-name corpus against api.create_group, rolled back, as SQL
     field <name>                          read "HTTP <status> <json>" or JSON on stdin, print a field
   <args> is one JSON object or name=value pairs (the word null is JSON null). "@uuid" is a fresh uuid and "@gate" this
   build's gate identity. Options: --aal aal1|aal2; --claims <json merged last>; --drop <claim[,claim]>; --gate <hex>;
   --save <file>. */

import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.env.SUPABASE_URL ??= process.env.API_URL ?? 'http://127.0.0.1:54321';
process.env.SUPABASE_ANON_KEY ??= process.env.ANON_KEY ?? 'unset';
const { bindCall, bindingSql, operationSql } = await import('../../lib/db/server.mjs');
const { GATE_IDENTITY_SHA256 } = await import('../../lib/passport/gate-manifest.mjs');
const { canonical } = await import('../../lib/passport/canonical.mjs');
const { assemble, installerText, readText } = await import('../../lib/passport/assemble.mjs');

const VENDOR = join(REPO, 'vendor/passport');
const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
const fixture = (name) => import(pathToFileURL(join(REPO, 'tests/e4/fixtures', name)).href);

function options(argv) {
  const out = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out.rest.push(a);
  }
  return out;
}

function argsOf(rest) {
  if (rest.length === 1 && rest[0].startsWith('{')) return JSON.parse(rest[0]);
  const out = {};
  for (const pair of rest) {
    const i = pair.indexOf('=');
    if (i < 1) throw new Error(`e4.mjs: not name=value: ${pair}`);
    const v = pair.slice(i + 1);
    out[pair.slice(0, i)] = v === 'null' ? null : v;
  }
  return out;
}

function resolved(args, o) {
  const value = (v) => (v === '@uuid' ? randomUUID() : v === '@gate' ? (o.gate ?? GATE_IDENTITY_SHA256) : v);
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, value(v)]));
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
  return `HTTP ${r.status} ${textBody.slice(0, 4000)}`;
}

/* A SQL literal for one bound parameter, by the value lib/db/server.mjs put in the body. Text travels as hex of its UTF-8
   bytes, so no control character or quote passes through psql's input. */
function literal(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string' && value.startsWith(String.fromCharCode(92, 120))) return `decode('${value.slice(2)}', 'hex')`;
  return `convert_from(decode('${hex(String(value))}', 'hex'), 'UTF8')`;
}

const SQL_TYPES = {
  p_company: 'uuid',
  p_agent: 'uuid',
  p_candidate: 'uuid',
  p_envelope: 'uuid',
  p_release: 'uuid',
  p_policy: 'uuid',
  p_idempotency_key: 'uuid',
  p_expected_version: 'integer',
  p_agent_name: 'text',
  p_content: 'text',
  p_derived_canonical: 'text',
  p_submission_canonical: 'text',
  p_target: 'text',
  p_audience_canonical: 'text',
  p_role: 'text',
  p_decision: 'text',
  p_reason: 'text',
  p_content_sha256: 'bytea',
  p_gate_identity: 'bytea',
  p_expected_assembled_sha256: 'bytea',
  /* E5 design 2.3 B10, so `sql` mode can print a report or a witness call for an owner session (tests/db/e5-lib.sh). */
  p_report: 'uuid',
  p_status: 'text',
  p_losses: 'text',
  p_assistance: 'text',
  p_note: 'text',
};

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const o = options(argv);
  switch (command) {
    case 'call':
    case 'sql': {
      const [fn, sub, ...rest] = o.rest;
      const call = bindCall(fn, resolved(argsOf(rest), o));
      const token = mint(sub, fn, call.argsSha256, o);
      if (o.save) writeFileSync(o.save, JSON.stringify({ fn, token, body: call.body }));
      if (command === 'call') {
        process.stdout.write(`${await post(fn, token, call.body)}\n`);
        return 0;
      }
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      /* Every argument carries its parameter type: a text built from hex is typed text, which no uuid parameter takes. */
      const named = Object.entries(call.body)
        .map(([param, value]) => `${param} => ${literal(value)}::${SQL_TYPES[param]}`)
        .join(', ');
      process.stdout.write(
        `select set_config('request.jwt.claims', '${JSON.stringify(claims)}', true);\nselect api.${fn}(${named})::text;\n`,
      );
      return 0;
    }
    case 'body': {
      /* The request body bindCall builds, for a raw PostgREST call under a token the probe chose. */
      const [fn, ...rest] = o.rest;
      process.stdout.write(`${JSON.stringify(bindCall(fn, resolved(argsOf(rest), o)).body)}\n`);
      return 0;
    }
    case 'replay': {
      const saved = JSON.parse(readFileSync(o.rest[0], 'utf8'));
      process.stdout.write(`${await post(saved.fn, saved.token, saved.body)}\n`);
      return 0;
    }
    case 'audience':
      process.stdout.write(`${canonical({ group_ids: o.rest.map((id) => id.toLowerCase()).sort() })}\n`);
      return 0;
    case 'assembled-sha':
    case 'projected': {
      const { assembledSha256, projectedAssembledBytes } = await import('../../lib/passport/packet.mjs');
      const { content } = JSON.parse(readFileSync(o.rest[0], 'utf8'));
      const text = installerText(VENDOR, `${o.rest[1]}.md`);
      const out = command === 'projected' ? projectedAssembledBytes(content, text) : assembledSha256(content, text);
      process.stdout.write(`${out}\n`);
      return 0;
    }
    case 'golden-sha': {
      const text = readText(join(REPO, 'tests/native-transfer/passport/fixtures/SYNTHETIC-passport.md'));
      const { createHash } = await import('node:crypto');
      const assembled = assemble(text, { root: VENDOR, branch: o.rest[0] });
      process.stdout.write(`${createHash('sha256').update(Buffer.from(assembled, 'utf8')).digest('hex')}\n`);
      return 0;
    }
    case 'vectors-sql':
      process.stdout.write(vectorsSql());
      return 0;
    case 'canonical-sql':
      process.stdout.write(await canonicalSql());
      return 0;
    case 'reason-sql':
      process.stdout.write(await reasonSql());
      return 0;
    case 'group-name-sql':
      process.stdout.write(await groupNameSql(o.rest[0], o.rest[1]));
      return 0;
    case 'reason-expected':
    case 'group-name-expected': {
      /* The Node column of a corpus as the lines its SQL command prints, for a probe to compare. */
      const reason = command === 'reason-expected';
      const { REASON_CORPUS } = await fixture('reason-corpus.mjs');
      const { GROUP_NAME_CORPUS } = await fixture('group-name-corpus.mjs');
      const corpus = reason ? REASON_CORPUS : GROUP_NAME_CORPUS;
      const tag = reason ? 'REASON' : 'GROUP';
      const lines = corpus
        .map((row, i) =>
          row.sql === 'unrepresentable'
            ? null
            : `${tag}|${i}|${row.node === 'E_BODY_INVALID' ? 'err:E_BODY_INVALID' : `ok:${hex(row.node.value)}`}`,
        )
        .filter(Boolean);
      process.stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }
    case 'status-sql':
    case 'status-expected': {
      /* The status corpus: each representable row inserted into app.reviews for one envelope inside a savepoint that is
         always rolled back, then app.envelope_status read; or the lines the Node column expects. */
      const { STATUS_CORPUS } = await fixture('status-and-verdict-corpus.mjs');
      const [envelope, candidate, company, membership] = o.rest;
      const rows = STATUS_CORPUS.map((row, i) => ({ row, i })).filter(({ row }) => row.sql === 'ok');
      if (command === 'status-expected') {
        process.stdout.write(`${rows.map(({ row, i }) => `STATUS|${i}|${row.expected}`).join('\n')}\n`);
        return 0;
      }
      const sql = ['begin;'];
      for (const { row, i } of rows) {
        sql.push('savepoint s;');
        for (const r of row.reviews)
          sql.push(
            `insert into app.reviews (company_id, candidate_id, envelope_id, role, decision, reviewer_membership_id, reason) values ('${company}', '${candidate}', '${envelope}', '${r.role}', '${r.decision}', '${membership}', 'Status corpus row ${i}.');`,
          );
        sql.push(`select 'STATUS|${i}|' || app.envelope_status('${envelope}');`, 'rollback to savepoint s;');
      }
      sql.push('rollback;');
      process.stdout.write(`${sql.join('\n')}\n`);
      return 0;
    }
    case 'verdict-rows': {
      /* One line per verdict corpus row: index|roles as a text[] literal|kinds, comma-separated|it answer|business
         answer|earlierKinds, comma-separated, empty for most rows (Q5 as answered 2026-09-15). */
      const { VERDICT_CORPUS } = await fixture('status-and-verdict-corpus.mjs');
      const answer = (code) => code ?? 'accepted';
      const lines = VERDICT_CORPUS.map(
        (row, i) =>
          `${i}|{${row.roles.join(',')}}|${row.kinds.join(',')}|${answer(row.refusals.it)}|${answer(row.refusals.business)}|${(row.earlierKinds ?? []).join(',')}`,
      );
      process.stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }
    case 'field': {
      const input = readFileSync(0, 'utf8').trim();
      const json = input.startsWith('HTTP ') ? input.slice(input.indexOf(' ', 5) + 1) : input;
      const v = JSON.parse(json)?.[o.rest[0]];
      process.stdout.write(`${v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : v}\n`);
      return 0;
    }
    default:
      process.stderr.write(`e4.mjs: unknown command ${command}\n`);
      return 2;
  }
}

const q = (s) => `$j$${s}$j$`;

/* Case 14's E4 half: ten argument sets through json_to_record with the design 2.3 B8 parameter types into pg_temp
   functions whose bodies are bindingSql(fn) and operationSql(fn), compared with Node's digests. */
function vectorsSql() {
  const SIG = {
    create_envelope: [
      ['p_candidate', 'uuid'],
      ['p_target', 'text'],
      ['p_audience_canonical', 'text'],
      ['p_policy', 'uuid'],
      ['p_gate_identity', 'bytea'],
      ['p_idempotency_key', 'uuid'],
    ],
    record_review: [
      ['p_candidate', 'uuid'],
      ['p_envelope', 'uuid'],
      ['p_role', 'text'],
      ['p_decision', 'text'],
      ['p_reason', 'text'],
      ['p_gate_identity', 'bytea'],
      ['p_idempotency_key', 'uuid'],
    ],
    publish_release: [
      ['p_candidate', 'uuid'],
      ['p_envelope', 'uuid'],
      ['p_expected_assembled_sha256', 'bytea'],
      ['p_gate_identity', 'bytea'],
      ['p_idempotency_key', 'uuid'],
    ],
    withdraw_release: [
      ['p_release', 'uuid'],
      ['p_reason', 'text'],
      ['p_idempotency_key', 'uuid'],
    ],
  };
  const ID = 'abcdef00-1111-4111-8111-111111111111';
  const ENV = 'fedcba00-2222-4222-8222-222222222222';
  const KEY = '33333333-3333-4333-8333-333333333333';
  const GATE = 'a'.repeat(64);
  const astral = String.fromCodePoint(0x1f600);
  const ls = String.fromCodePoint(0x2028);
  const tab = String.fromCodePoint(9);
  const lf = String.fromCodePoint(10);
  const VECTORS = [
    ['envelope_plain', 'create_envelope', { candidate_id: ID, target: 'claude-ai', audience_canonical: `{"group_ids":["${ID}"]}`, policy_id: ENV, gate_identity: GATE, idempotency_key: KEY }],
    ['envelope_uppercase_ids', 'create_envelope', { candidate_id: ID.toUpperCase(), target: 'generic', audience_canonical: '{}', policy_id: ENV.toUpperCase(), gate_identity: GATE.toUpperCase(), idempotency_key: KEY }],
    ['envelope_target_absent', 'create_envelope', { candidate_id: ID, audience_canonical: '[]', policy_id: ENV, gate_identity: GATE, idempotency_key: KEY }],
    ['review_candidate_level', 'record_review', { candidate_id: ID, envelope_id: null, role: 'it', decision: 'changes_requested', reason: 'x', gate_identity: GATE, idempotency_key: KEY }],
    ['review_astral_ls_tab_lf_reason', 'record_review', { candidate_id: ID, envelope_id: ENV, role: 'business', decision: 'approved', reason: `a${astral}${ls}${tab}${lf}b`, gate_identity: GATE, idempotency_key: KEY }],
    ['review_2000_code_point_reason', 'record_review', { candidate_id: ID, envelope_id: ENV, role: 'it', decision: 'approved', reason: astral.repeat(2000), gate_identity: GATE, idempotency_key: KEY }],
    ['publish_plain', 'publish_release', { candidate_id: ID, envelope_id: ENV, expected_assembled_sha256: 'cd'.repeat(32), gate_identity: GATE, idempotency_key: KEY }],
    ['publish_uppercase_hash_gate_absent', 'publish_release', { candidate_id: ID, envelope_id: ENV, expected_assembled_sha256: 'CD'.repeat(32), idempotency_key: KEY }],
    ['withdraw_plain', 'withdraw_release', { release_id: ID, reason: 'The source report format changed.', idempotency_key: KEY }],
    ['withdraw_reason_absent_uppercase_key', 'withdraw_release', { release_id: ID, idempotency_key: KEY.toUpperCase() }],
  ];
  const sql = ['begin;'];
  for (const fn of Object.keys(SIG)) {
    const params = SIG[fn].map(([p, t]) => `${p} ${t}`).join(', ');
    sql.push(`create function pg_temp.bind_${fn}(${params}) returns text language sql as $f$ select encode(${bindingSql(fn)}, 'hex') $f$;`);
    sql.push(`create function pg_temp.op_${fn}(${params}) returns text language sql as $f$ select encode(${operationSql(fn)}, 'hex') $f$;`);
  }
  for (const [name, fn, args] of VECTORS) {
    const call = bindCall(fn, args);
    const cols = SIG[fn].map(([p, t]) => `${p} ${t}`).join(', ');
    const argList = SIG[fn].map(([p]) => `r.${p}`).join(', ');
    sql.push(
      `select 'VECTOR|${name}|' || (pg_temp.bind_${fn}(${argList}) = '${call.argsSha256}') || '|' || (pg_temp.op_${fn}(${argList}) = '${call.operationSha256}') from json_to_record(${q(JSON.stringify(call.body))}) as r(${cols});`,
    );
  }
  sql.push('rollback;');
  return `${sql.join('\n')}\n`;
}

/* Case 46: envelope records hashed by Node canonical() and by app.envelope_canonical, byte for byte, then the collation
   counterexample: two group ids whose order under ICU numeric collation differs from byte order. The design's wording
   ("a linguistic collation that ignores the hyphen") gives no counterexample for fixed-format uuids, whose hyphens sit
   at the same offsets; numeric ordering of digit runs does (evidence/e4-server.md). */
async function canonicalSql() {
  const { ENVELOPE_VECTORS, CRAFTED_PAIR } = await fixture('canonical-vectors.mjs');
  const { envelopeCanonical } = await import('../../lib/passport/packet.mjs');
  const sql = ['begin;'];
  ENVELOPE_VECTORS.forEach((v, i) => {
    const text = envelopeCanonical(v);
    const row = {
      id: v.id,
      company_id: v.company_id,
      agent_id: v.agent_id,
      candidate_id: v.candidate_id,
      revision: 1,
      content_sha256: `\\x${v.content_sha256}`,
      derived_sha256: `\\x${v.derived_sha256}`,
      gate_id: v.gate_id,
      gate_identity_sha256: `\\x${v.gate_identity_sha256}`,
      target: v.target,
      installer_text_sha256: `\\x${v.installer.text_sha256}`,
      core_sha256: `\\x${v.installer.core_sha256}`,
      branch_sha256: `\\x${v.installer.branch_sha256}`,
      judge_sha256: `\\x${v.installer.judge_sha256}`,
      policy_id: v.policy.id,
      policy_sha256: `\\x${v.policy.sha256}`,
      audience_group_ids: v.group_ids,
    };
    sql.push(
      `select 'CANONICAL|${i}|' || (app.envelope_canonical(r) = ${q(text)}) || '|' || encode(sha256(convert_to(app.envelope_canonical(r), 'UTF8')), 'hex') || '|${v.expectedSha256}' from jsonb_populate_record(null::app.review_envelopes, ${q(JSON.stringify(row))}) as r;`,
    );
  });
  const pair = ENVELOPE_VECTORS.findIndex((v) => v.group_ids.length === 2 && v.group_ids.includes(CRAFTED_PAIR[0]));
  sql.push("create collation pg_temp_e4_numeric (provider = icu, locale = 'und-u-kn');");
  sql.push(
    `select 'COLLATION|' || (select string_agg(x, ',' order by x collate "C") from unnest(array['${CRAFTED_PAIR[0]}', '${CRAFTED_PAIR[1]}']) x) || '|' || (select string_agg(x, ',' order by x collate pg_temp_e4_numeric) from unnest(array['${CRAFTED_PAIR[0]}', '${CRAFTED_PAIR[1]}']) x);`,
  );
  sql.push(`select 'PAIR_VECTOR|${pair}';`);
  sql.push('rollback;');
  return `${sql.join('\n')}\n`;
}

/* The reason corpus against app.review_reason: each representable input as hex of its UTF-8 bytes, the answer as ok and
   the hex of the stored text, or the error. */
async function reasonSql() {
  const { REASON_CORPUS } = await fixture('reason-corpus.mjs');
  const sql = [
    'begin;',
    "create function pg_temp.try_reason(t text) returns text language plpgsql as $f$ begin return 'ok:' || encode(convert_to(app.review_reason(t), 'UTF8'), 'hex'); exception when others then return 'err:' || split_part(sqlerrm, ' ', 1); end $f$;",
  ];
  REASON_CORPUS.forEach((row, i) => {
    if (row.sql === 'unrepresentable') return;
    sql.push(`select 'REASON|${i}|' || pg_temp.try_reason(convert_from(decode('${hex(row.input)}', 'hex'), 'UTF8'));`);
  });
  sql.push('rollback;');
  return `${sql.join('\n')}\n`;
}

/* The group-name corpus against api.create_group itself, each call inside a subtransaction that is always rolled back
   (an accepted name raises after reading what was stored), under an admin's claims at aal2. */
async function groupNameSql(company, adminSub) {
  const { GROUP_NAME_CORPUS } = await fixture('group-name-corpus.mjs');
  const claims = JSON.stringify({ role: 'app_server', sub: adminSub, aal: 'aal2' });
  const sql = [
    'begin;',
    `select set_config('request.jwt.claims', '${claims}', true);`,
    `create function pg_temp.try_group(c uuid, n text) returns text language plpgsql as $f$ declare gid uuid; stored text; begin select g.group_id into gid from api.create_group(c, n) g; select x.name into stored from app.groups x where x.id = gid; raise exception 'ACCEPTED:%', encode(convert_to(stored, 'UTF8'), 'hex'); exception when others then if sqlerrm like 'ACCEPTED:%' then return 'ok:' || substr(sqlerrm, 10); end if; return 'err:' || split_part(sqlerrm, ' ', 1); end $f$;`,
  ];
  GROUP_NAME_CORPUS.forEach((row, i) => {
    if (row.sql === 'unrepresentable') return;
    sql.push(`select 'GROUP|${i}|' || pg_temp.try_group('${company}', convert_from(decode('${hex(row.input)}', 'hex'), 'UTF8'));`);
  });
  sql.push('rollback;');
  return `${sql.join('\n')}\n`;
}

process.exitCode = await main();
