/* The server principal (E2 design sections 1.3 and 6; E3 design section 2.6 item 2).

   serverToken(session) mints { role: 'app_server', sub, aal, iss, iat, exp: iat + 60 }
   from a VerifiedSession and nothing else: the brand check is by identity
   (lib/session.mjs WeakSet), so a handler cannot assemble an aal2 principal
   from parts, and `aal` is copied verbatim from the verified GoTrue token.
   Signing: HS256 with SUPABASE_JWT_SECRET (the local stack and the hosted
   legacy secret), or ES256 with ENTERPRISE_SERVER_SIGNING_KEY (PKCS#8 PEM,
   the imported hosted signing key) and ENTERPRISE_SERVER_SIGNING_KID when
   ENTERPRISE_SERVER_SIGNING_ALG=ES256. The key is read per call from the
   environment and never cached on a module object.

   The bound bearer. serverToken(session, { bind: { fn, args_sha256 } }) adds
   `fn`, `args_sha256` and a fresh uuid `jti`, and only for a function in
   BOUND. An E2 function name is refused: app.server_actor() refuses every
   token carrying `fn`, so a bound E2 call could only fail. callBound(session,
   fn, args) is the only way to call a BOUND function. bindCall() reads each
   argument once into one record; the request body and the binding string are
   both projections of that record through the function's frozen field list,
   so they cannot drift.

   The binding string is `fn` and then one line per field in parameter order:
   a uuid (lowercase, as Postgres prints uuid::text), an integer, 64 lowercase
   hex characters (a bytea parameter, or SHA-256 over the UTF-8 bytes of a text
   parameter), or `-` for an absent value. Lines are joined by one newline with
   no trailing newline, and args_sha256 is SHA-256 over the UTF-8 bytes. An
   absent value is written `-` and sent as an explicit null, never skipped:
   concat_ws skips NULL arguments, which is the trap coalesce(<value>, '-')
   closes on the SQL side. bindingSql(fn) and operationSql(fn) print that SQL
   from the same rows the Node encoders use, so the migration copies its
   recomputation from this table instead of retyping it.

   rpc(name, args, token) posts to /rest/v1/rpc/<name> for the thirteen unbound
   api functions only: E2's nine, E4's three group routines and E5's download,
   which follow E2's admin template and take the unbound bearer (E4 design 2.6
   item 1, E5 design 1.2).
   Importable only from lib/services/ and lib/operator/
   (scripts/check-imports.mjs, design section 8.1). */

import { createHash, createHmac, createPrivateKey, randomUUID, sign } from 'node:crypto';

import { fromPostgrest } from '../errors.mjs';
import { isVerifiedSession } from '../session.mjs';

/* A frozen array, not a frozen Set: freezing a Set leaves its entries writable, so an importer could
   add a name and widen rpc (E3-PREQ-D1). */
export const FUNCTIONS = Object.freeze([
  'invite_member',
  'revoke_invitation',
  'accept_invitation',
  'set_roles',
  'remove_member',
  'provision_company',
  'transfer_first_admin',
  'add_operator',
  'set_display_name',
  /* E4 design 2.6 item 1 (migration 006 part A): the group routines, called through callAs. */
  'create_group',
  'add_group_member',
  'remove_group_member',
  /* E5 design 1.2 and 2.6 item 1 (migration 007): the download authorization. Unbound by decision, not by omission: a
     download performs no state transition and has no fresh-only precondition, so an honest retry is a true second
     authorization, and a claim row per download would spend E3's shared per-membership ceiling on the most frequent
     member action in the product. */
  'authorize_download',
  /* E6 design 2.6 item 1 as corrected (evidence/e6-design-corrections.md section 4), landed by the lead before
     construction: thirteen unbound routines of the lifecycle migration, none of which exists yet. Unbound by the
     design's decision 3.3: each is idempotent by its postcondition or a set-to-value write, and BOUND and FIELDS gain
     nothing. A name here without its routine answers PostgREST's own 404 and widens nothing. */
  'create_company',
  'operator_invite_admin',
  'set_company_status',
  'set_access_period',
  'set_company_quota',
  'operator_register',
  'operator_export_manifest',
  'operator_expiry_run',
  'close_company',
  'delete_company',
  'export_company',
  'transfer_agent',
  'departure_preview',
  /* E6 design 1.2.1 (lane K4, migration 010): the delivery outcome onto the invitation row. Unbound for E6 3.3's reason:
     one word written once is idempotent by its postcondition, so BOUND and FIELDS gain nothing. */
  'record_invitation_delivery',
  /* ENA-7 (migration 011): whether this invitation's caller may be handed a signing link. Unbound: it stamps one
     column once and answers the same thing on a repeat for the same state, so BOUND and FIELDS gain nothing. */
  'claim_invitation_handover',
  /* HB-F2 (migration 012): the route's bound on wrong second-factor codes, begin before GoTrue and end after it.
     Unbound: begin's repeat is a second counted attempt, which fails closed, and end settles one reservation once. */
  'mfa_verify_begin',
  'mfa_verify_end',
]);
const TOKEN_TTL_SECONDS = 60;
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const ABSENT = '-';
/* Postgres reads a JSON string as bytea hex only after a backslash-x prefix; without it the 64
   characters become 64 bytes and the line could never match. Built from its code points because
   scripts/check-imports.mjs refuses escape sequences under lib/. */
const BYTEA_HEX_PREFIX = String.fromCharCode(92, 120);
const NUL = String.fromCharCode(0);
const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function refuse(name, what) {
  throw new TypeError(`bindCall: ${name} is not ${what}`);
}

/* One argument kind: canon() refuses a value the database would read differently from Node and
   returns the single value both projections use; body() is its JSON request value, line() its
   binding line, sql() the expression that recomputes that line from the parameter. */
const KINDS = Object.freeze({
  uuid: Object.freeze({
    canon: (v, name) => (typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : refuse(name, 'a uuid')),
    body: (c) => c,
    line: (c) => c,
    sql: (p) => `${p}::text`,
  }),
  integer: Object.freeze({
    canon: (v, name) =>
      Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? v : refuse(name, 'a 32-bit integer'),
    body: (c) => c,
    line: (c) => String(c),
    sql: (p) => `${p}::text`,
  }),
  /* A lone surrogate has no UTF-8 encoding: Node would hash U+FFFD and Postgres refuses the JSON. NUL is
     well-formed, but Postgres text cannot hold it and the JSON-to-text conversion refuses its escape, so
     without this check the call was hashed, signed and sent and then failed before any routine ran.
     Every other scalar value round-trips with the same digest (evidence/e3-prereq-corrections.md). */
  text: Object.freeze({
    canon: (v, name) =>
      typeof v === 'string' && v.isWellFormed() && !v.includes(NUL) ? v : refuse(name, 'well-formed text without NUL'),
    body: (c) => c,
    line: (c) => sha256hex(c),
    sql: (p) => `encode(sha256(convert_to(${p}, 'UTF8')), 'hex')`,
  }),
  /* A bytea parameter: the body carries the hex after BYTEA_HEX_PREFIX, the line the bare hex. */
  bytea32: Object.freeze({
    canon: (v, name) => (typeof v === 'string' && HEX64.test(v) ? v.toLowerCase() : refuse(name, '64 hex characters')),
    body: (c) => `${BYTEA_HEX_PREFIX}${c}`,
    line: (c) => c,
    sql: (p) => `encode(${p}, 'hex')`,
  }),
});

const FIELDS = Object.freeze({
  company_id: Object.freeze({ param: 'p_company', kind: KINDS.uuid }),
  agent_id: Object.freeze({ param: 'p_agent', kind: KINDS.uuid }),
  agent_name: Object.freeze({ param: 'p_agent_name', kind: KINDS.text }),
  candidate_id: Object.freeze({ param: 'p_candidate', kind: KINDS.uuid }),
  expected_version: Object.freeze({ param: 'p_expected_version', kind: KINDS.integer }),
  content: Object.freeze({ param: 'p_content', kind: KINDS.text }),
  content_sha256: Object.freeze({ param: 'p_content_sha256', kind: KINDS.bytea32 }),
  derived_canonical: Object.freeze({ param: 'p_derived_canonical', kind: KINDS.text }),
  submission_canonical: Object.freeze({ param: 'p_submission_canonical', kind: KINDS.text }),
  gate_identity: Object.freeze({ param: 'p_gate_identity', kind: KINDS.bytea32 }),
  idempotency_key: Object.freeze({ param: 'p_idempotency_key', kind: KINDS.uuid }),
  /* E4 design 2.6 item 1; each parameter name is the signature's in design 2.3 B8. A text field is bound by SHA-256. */
  envelope_id: Object.freeze({ param: 'p_envelope', kind: KINDS.uuid }),
  release_id: Object.freeze({ param: 'p_release', kind: KINDS.uuid }),
  policy_id: Object.freeze({ param: 'p_policy', kind: KINDS.uuid }),
  target: Object.freeze({ param: 'p_target', kind: KINDS.text }),
  audience_canonical: Object.freeze({ param: 'p_audience_canonical', kind: KINDS.text }),
  role: Object.freeze({ param: 'p_role', kind: KINDS.text }),
  decision: Object.freeze({ param: 'p_decision', kind: KINDS.text }),
  reason: Object.freeze({ param: 'p_reason', kind: KINDS.text }),
  expected_assembled_sha256: Object.freeze({ param: 'p_expected_assembled_sha256', kind: KINDS.bytea32 }),
  /* E5 design 2.6 item 1; each parameter name is the signature's in design 2.3 B10. A text field is bound by SHA-256,
     an absent one by `-`, so an absent optional text and the literal text `-` are told apart by the hash. */
  report_id: Object.freeze({ param: 'p_report', kind: KINDS.uuid }),
  status: Object.freeze({ param: 'p_status', kind: KINDS.text }),
  losses: Object.freeze({ param: 'p_losses', kind: KINDS.text }),
  assistance: Object.freeze({ param: 'p_assistance', kind: KINDS.text }),
  note: Object.freeze({ param: 'p_note', kind: KINDS.text }),
});

const list = (...names) => Object.freeze(names);

/* E3 design 2.6 item 2 (binding) and 4.3 (operation), copied. A binding list is the function's
   parameter list in signature order (design 4.4), so it is also the request body. An operation list
   is the in-order subset an honest retry repeats: no derived bytes, no gate identity, no key. */
export const BOUND = Object.freeze({
  create_draft: Object.freeze({
    binding: list(
      'company_id',
      'agent_id',
      'agent_name',
      'content',
      'derived_canonical',
      'gate_identity',
      'idempotency_key',
    ),
    operation: list('company_id', 'agent_id', 'agent_name', 'content'),
  }),
  save_draft: Object.freeze({
    binding: list(
      'candidate_id',
      'expected_version',
      'content',
      'derived_canonical',
      'gate_identity',
      'idempotency_key',
    ),
    operation: list('candidate_id', 'expected_version', 'content'),
  }),
  submit_candidate: Object.freeze({
    binding: list(
      'candidate_id',
      'expected_version',
      'content_sha256',
      'derived_canonical',
      'submission_canonical',
      'gate_identity',
      'idempotency_key',
    ),
    operation: list('candidate_id', 'expected_version', 'submission_canonical'),
  }),
  create_successor: Object.freeze({
    binding: list('candidate_id', 'content_sha256', 'derived_canonical', 'gate_identity', 'idempotency_key'),
    operation: list('candidate_id'),
  }),
  /* E4 design 2.6 item 1, copied. Absent from each operation list, for E3's reasons: the gate identity (a retry across
     a deployment is the same operation), the expected assembled hash (computed, not chosen) and the key. The routines
     are migration 006 part B's; until they exist these entries bind calls nothing can answer. */
  create_envelope: Object.freeze({
    binding: list('candidate_id', 'target', 'audience_canonical', 'policy_id', 'gate_identity', 'idempotency_key'),
    operation: list('candidate_id', 'target', 'audience_canonical', 'policy_id'),
  }),
  record_review: Object.freeze({
    binding: list('candidate_id', 'envelope_id', 'role', 'decision', 'reason', 'gate_identity', 'idempotency_key'),
    operation: list('candidate_id', 'envelope_id', 'role', 'decision', 'reason'),
  }),
  publish_release: Object.freeze({
    binding: list('candidate_id', 'envelope_id', 'expected_assembled_sha256', 'gate_identity', 'idempotency_key'),
    operation: list('candidate_id', 'envelope_id'),
  }),
  withdraw_release: Object.freeze({
    binding: list('release_id', 'reason', 'idempotency_key'),
    operation: list('release_id', 'reason'),
  }),
  /* E5 design 2.6 item 1, copied. Absent from each operation list: only the key. Neither routine touches content, the
     gate or the installer, so there is no gate identity to leave out (design 2.3, after B10). A report whose words
     differ is a different operation and gets its own row; a retry of the same words is answered (design 1.4a). */
  report_installation: Object.freeze({
    binding: list('release_id', 'status', 'losses', 'assistance', 'idempotency_key'),
    operation: list('release_id', 'status', 'losses', 'assistance'),
  }),
  witness_installation: Object.freeze({
    binding: list('report_id', 'status', 'note', 'idempotency_key'),
    operation: list('report_id', 'status', 'note'),
  }),
});

function specOf(fn, who) {
  if (typeof fn !== 'string' || !Object.hasOwn(BOUND, fn))
    throw new TypeError(`${who}: ${String(fn)} is not a bound function`);
  return BOUND[fn];
}

/** The one record an E3 call is built from, and its projections: { fn, body, binding, argsSha256,
    operation, operationSha256 }. An absent (missing, null or undefined) field is null in the body
    and `-` in both strings. Throws TypeError for an unknown function, a key outside the field list
    or a value the database would read differently. */
export function bindCall(fn, args) {
  const spec = specOf(fn, 'bindCall');
  if (typeof args !== 'object' || args === null || Array.isArray(args))
    throw new TypeError('bindCall: args is not an object');
  for (const key of Object.keys(args)) {
    if (!spec.binding.includes(key)) throw new TypeError(`bindCall: ${fn} takes no ${key}`);
  }
  const body = {};
  const lines = new Map();
  for (const name of spec.binding) {
    const { param, kind } = FIELDS[name];
    const value = Object.hasOwn(args, name) ? args[name] : undefined;
    const c = value === undefined || value === null ? null : kind.canon(value, name);
    body[param] = c === null ? null : kind.body(c);
    lines.set(name, c === null ? ABSENT : kind.line(c));
  }
  const binding = [fn, ...spec.binding.map((name) => lines.get(name))].join('\n');
  const operation = [fn, ...spec.operation.map((name) => lines.get(name))].join('\n');
  return Object.freeze({
    fn,
    body: Object.freeze(body),
    binding,
    argsSha256: sha256hex(binding),
    operation,
    operationSha256: sha256hex(operation),
  });
}

const digestSql = (fn, names) =>
  `sha256(convert_to(concat_ws(E'\\n', '${fn}', ${names
    .map((name) => `coalesce(${FIELDS[name].kind.sql(FIELDS[name].param)}, '${ABSENT}')`)
    .join(', ')}), 'UTF8'))`;

/** The bytea SQL expression that recomputes args_sha256 from the function's own parameters. */
export function bindingSql(fn) {
  return digestSql(fn, specOf(fn, 'bindingSql').binding);
}

/** The bytea SQL expression that recomputes operation_sha256 (design 4.3). */
export function operationSql(fn) {
  return digestSql(fn, specOf(fn, 'operationSql').operation);
}

function env(name) {
  const v = process.env[name];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`E_CONFIG ${name}`);
  return v;
}

function bindingClaims(bind) {
  const fn = bind?.fn;
  if (FUNCTIONS.includes(fn)) throw new TypeError(`serverToken: ${fn} is an E2 function and is never bound`);
  specOf(fn, 'serverToken');
  const digest = bind.args_sha256;
  if (typeof digest !== 'string' || !DIGEST.test(digest)) {
    throw new TypeError('serverToken: args_sha256 is not 64 lowercase hex characters');
  }
  return { fn, args_sha256: digest, jti: randomUUID() };
}

export function serverToken(session, { now = Math.floor(Date.now() / 1000), bind } = {}) {
  if (!isVerifiedSession(session)) throw new TypeError('serverToken: not a VerifiedSession');
  const claims = {
    role: 'app_server',
    sub: session.authUserId,
    aal: session.aal,
    iss: 'phaeacia-server',
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    ...(bind === undefined ? {} : bindingClaims(bind)),
  };
  const alg = process.env.ENTERPRISE_SERVER_SIGNING_ALG ?? 'HS256';
  if (alg === 'HS256') {
    const secret = env('SUPABASE_JWT_SECRET');
    const input = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(claims)}`;
    return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
  }
  if (alg === 'ES256') {
    const key = createPrivateKey(env('ENTERPRISE_SERVER_SIGNING_KEY'));
    const input = `${b64u({ alg: 'ES256', typ: 'JWT', kid: env('ENTERPRISE_SERVER_SIGNING_KID') })}.${b64u(claims)}`;
    return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  }
  throw new Error('E_CONFIG ENTERPRISE_SERVER_SIGNING_ALG');
}

async function post(name, body, token, fetchImpl) {
  const r = await fetchImpl(`${env('SUPABASE_URL')}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: env('SUPABASE_ANON_KEY'),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await r.json();
  } catch {
    parsed = null;
  }
  if (r.status >= 200 && r.status < 300) return parsed;
  throw fromPostgrest({ status: r.status, body: parsed });
}

/** POST /rest/v1/rpc/<name>. Returns the parsed JSON body of a 2xx; throws an AppError otherwise. */
export async function rpc(name, args, token, { fetchImpl = fetch } = {}) {
  if (!FUNCTIONS.includes(name)) throw new TypeError(`rpc: ${String(name)} is not an api function`);
  if (typeof token !== 'string' || token.split('.').length !== 3) throw new TypeError('rpc: not a server token');
  return post(name, args ?? {}, token, fetchImpl);
}

/** Mint and call in one step for a verified session. */
export function callAs(session, name, args, options) {
  return rpc(name, args, serverToken(session), options);
}

/** Call a BOUND function with a bearer bound to exactly this body. Nothing is signed or sent when the
    function, the arguments or the session is refused. */
export async function callBound(session, fn, args, { fetchImpl = fetch } = {}) {
  const call = bindCall(fn, args);
  const token = serverToken(session, { bind: { fn: call.fn, args_sha256: call.argsSha256 } });
  return post(call.fn, call.body, token, fetchImpl);
}
