/* The shared owner connection for the owner-side scripts (E7 design 1.2, correction E7D-C-F6).
 *
 * Two calls over the one command in ENTERPRISE_DB_PSQL, which is the sweep's existing contract:
 *
 *   ownerQuery(sql)            -> the child's stdout, trimmed. spawnSync with an EXPLICIT 16 MiB maxBuffer and a
 *                                 refusal, not a truncation, above it. For small answers.
 *   ownerStream(sql, onLine)   -> { lines }. spawn, stdout read line by line, back-pressured: the source is paused
 *                                 while onLine's promise is pending, so memory holds ONE line at a time whatever the
 *                                 answer's size. For the export.
 *
 * Both pass the SQL on stdin preceded by \set ON_ERROR_STOP 1, \set VERBOSITY verbose and \set SHOW_CONTEXT never.
 *
 * WHY THIS MODULE EXISTS, twice over.
 *
 * 1. The bound. The sweep ran each statement through spawnSync with Node's DEFAULT maxBuffer. Probe P1 (design
 *    section 10) shows what that default does to a larger answer: a child writing 2,000,000 bytes is killed with
 *    SIGTERM, error.code ENOBUFS, and the caller receives 1,114,112 bytes TRUNCATED WITHOUT AN EXIT STATUS. The
 *    sweep's answers are a few kilobytes so it was never affected; an export is megabytes, and a silently truncated
 *    answer is the one failure a script must never have. Here the bound is explicit and above it is a REFUSAL.
 *
 * 2. A FAILURE IS A CATEGORY AND A CODE, NEVER THE DATABASE'S TEXT (E7D-C-F6). lib/errors.mjs reads only a SQLSTATE
 *    and an E_ token from a PostgREST error and drops PostgreSQL's `details` and `hint`, because a CHECK violation's
 *    detail ECHOES THE FAILING ROW and a connection error echoes the host, the user and the database. The first
 *    version of this design reported a failure "by exit status and the first 500 bytes of stderr, as the sweep does",
 *    which walks straight past that boundary. So every failure here becomes ONE line:
 *
 *      { "event": "owner_db_failed", "category": "connection" | "statement" | "command" | "signal" | "overflow"
 *                                                | "output",
 *        "sqlstate": "23514", "code": "E_DELETE_TOO_LARGE" }
 *
 *    and nothing else. The stderr is read into memory FOR THAT MATCH ALONE and dropped: it is never written to
 *    stdout, to stderr, to the register, to a report or to any retained evidence, and this module has no path that
 *    can write it anywhere. Only the FIRST line is retained even in memory, and only up to 1 KiB of it, because the
 *    match needs no more and a DETAIL line carrying a row is what the retention would otherwise hold.
 *
 *    The detail of a failed statement is in the DATABASE'S OWN LOG, which PostgreSQL writes with the statement and
 *    its DETAIL: at the hosted project the dashboard's Postgres log under the owner's access, locally the database
 *    container's log. The operator reads it there, under the owner's credential, and never copies it into the
 *    register, a chat, a ticket or an evidence file (design 1.2; docs/ops/inventory.md names that log).
 *
 * THE CATEGORY, from how the child ended (design 1.2):
 *   connection  psql exit 2
 *   statement   psql exit 3, which is what ON_ERROR_STOP makes of a failing statement
 *   command     any other non-zero exit, including psql's own exit 1 and a command that could not run at all
 *   signal      the child was killed
 *   overflow    ownerQuery's explicit bound, or a single line above it in ownerStream
 *   output      an answer the CALLER cannot parse; raised by the caller through outputFailure()
 *
 * THE TWO FIELD RULES, which are fromPostgrest's own and no wider:
 *   sqlstate  only when the first line of stderr matches psql's verbose error shape, `ERROR:  23514:` or
 *             `FATAL:  28000:`. A connection failure is reported by psql BEFORE \set VERBOSITY verbose can run, so
 *             it carries no SQLSTATE and none is invented.
 *   code      only when the message after the SQLSTATE BEGINS with a key of CODES, which lets the delete script tell
 *             E_DELETION_NOT_DUE from E_COMPANY_NOT_CLOSED (both P0001) and learn nothing else.
 *
 * ENTERPRISE_DB_PSQL IS THE OPERATOR'S OWN COMMAND AND IS NEVER PRINTED, not in a message, not in a failure line and
 * not in an error's stack. An OwnerDbError's message is its category word and nothing more.
 *
 * It adds no import edge: scripts/ may import *, and the one thing it takes from lib/ is the CODES table
 * (scripts/check-imports.mjs).
 */
import { spawn, spawnSync } from 'node:child_process';

import { CODES } from '../lib/errors.mjs';

/** ownerQuery's explicit bound. Above it the call REFUSES; it never returns a truncated answer. */
export const MAX_BUFFER = 16 * 1024 * 1024;

/** Written before every statement, on stdin, so the child's failure shape is the one the rules above read. */
export const PREAMBLE = '\\set ON_ERROR_STOP 1\n\\set VERBOSITY verbose\n\\set SHOW_CONTEXT never\n';

/* psql's first error line under VERBOSITY verbose. Reading a script from stdin, psql prefixes its diagnostics with
   the input's name and line ("psql:<stdin>:4: ERROR:  23514: ..."); the prefix is psql's own location marker and is
   optional here so the rule holds whether or not the operator's command suppresses it. */
const ERROR_LINE = /^(?:psql:[^\n]*?:\d+: )?(?:ERROR|FATAL): {2}([0-9A-Z]{5}): (.*)$/;
/* fromPostgrest's own token rule (lib/errors.mjs), applied to the message after the SQLSTATE. */
const E_TOKEN = /^(E_[A-Z_]+)\b/;
/* Enough of the first stderr line to carry `ERROR:  23514: E_SOMETHING`, and no more. */
const STDERR_KEEP = 1024;

/** One failure of the owner connection. Its message is the category word; it carries no database text at all. */
export class OwnerDbError extends Error {
  constructor(category, details = {}) {
    super(`owner_db_failed: ${category}`);
    this.name = 'OwnerDbError';
    this.category = category;
    if (details.sqlstate !== undefined) this.sqlstate = details.sqlstate;
    if (details.code !== undefined) this.code = details.code;
  }

  /** The ONE line a script prints for this failure, and the whole of what it may print. */
  get line() {
    const out = { event: 'owner_db_failed', category: this.category };
    if (this.sqlstate !== undefined) out.sqlstate = this.sqlstate;
    if (this.code !== undefined) out.code = this.code;
    return out;
  }
}

/** The caller's own category: the child succeeded and its answer could not be parsed. */
export const outputFailure = () => new OwnerDbError('output');

/** The SQLSTATE and the CODES key, from the first line of stderr and from nothing else. Returns {} when neither. */
export function diagnose(stderr) {
  const first = String(stderr ?? '').split('\n', 1)[0];
  const m = ERROR_LINE.exec(first);
  if (m === null) return {};
  const out = { sqlstate: m[1] };
  const token = E_TOKEN.exec(m[2])?.[1];
  if (token !== undefined && Object.hasOwn(CODES, token)) out.code = token;
  return out;
}

function fromExit(status, stderr) {
  const details = diagnose(stderr);
  if (status === 2) return new OwnerDbError('connection', details);
  if (status === 3) return new OwnerDbError('statement', details);
  return new OwnerDbError('command', details);
}

/* psql executes a final statement at EOF either way; the newline keeps the statement on its own input line, so a
   diagnostic's line number is the statement's. */
const terminated = (sql) => (sql.endsWith('\n') ? sql : `${sql}\n`);

/* The operator's command. Read at every call, so a test may set it per case; never returned to any caller that
   prints, and never put in a message. */
function ownerCommand() {
  const command = process.env.ENTERPRISE_DB_PSQL;
  if (typeof command !== 'string' || command.length === 0) throw new OwnerDbError('command');
  return command;
}

/**
 * ownerQuery(sql, { maxBuffer }) -> the child's stdout, trimmed.
 * Throws OwnerDbError on any failure. The answer is never truncated: above the bound the call refuses with
 * category `overflow`.
 */
export function ownerQuery(sql, options = {}) {
  const command = ownerCommand();
  const r = spawnSync('bash', ['-c', command], {
    input: PREAMBLE + terminated(sql),
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? MAX_BUFFER,
  });
  /* ENOBUFS is how spawnSync reports the bound: it kills the child with SIGTERM and hands back a truncated stdout
     (probe P1). It is checked FIRST, because that kill is the bound and not a signal from outside. */
  if (r.error !== undefined && r.error !== null) {
    if (r.error.code === 'ENOBUFS') throw new OwnerDbError('overflow');
    throw new OwnerDbError('command');
  }
  if (r.signal !== null && r.signal !== undefined) throw new OwnerDbError('signal');
  if (r.status !== 0) throw fromExit(r.status, r.stderr);
  return (r.stdout ?? '').trim();
}

/**
 * ownerStream(sql, onLine, { maxLine }) -> { lines }.
 *
 * Every line of the child's stdout is handed to onLine in order, and the source is PAUSED while onLine's promise is
 * pending (`for await` over a Readable does exactly that), so a 250 MB answer costs one line of memory. A line above
 * the bound refuses rather than growing: an export row is one JSON object and 16 MiB of one row is not an answer
 * this script should be assembling.
 *
 * onLine may throw; the child is killed and the caller's error propagates unchanged.
 */
export async function ownerStream(sql, onLine, options = {}) {
  const command = ownerCommand();
  const maxLine = options.maxLine ?? MAX_BUFFER;
  const child = spawn('bash', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
  let spawnFailed = false;
  child.on('error', () => {
    spawnFailed = true;
  });

  /* The first line of stderr, at most STDERR_KEEP bytes of it, for the match alone. Nothing here writes it out. */
  let stderr = '';
  let stderrDone = false;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (stderrDone) return;
    stderr += chunk;
    const nl = stderr.indexOf('\n');
    if (nl >= 0) {
      stderr = stderr.slice(0, nl);
      stderrDone = true;
    } else if (stderr.length >= STDERR_KEEP) {
      stderr = stderr.slice(0, STDERR_KEEP);
      stderrDone = true;
    }
  });

  const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  /* A child that exits before it has read the whole statement makes stdin EPIPE, which is that exit's symptom and
     not a second failure. */
  child.stdin.on('error', () => {});
  child.stdin.end(PREAMBLE + terminated(sql));

  child.stdout.setEncoding('utf8');
  let rest = '';
  let lines = 0;
  try {
    for await (const chunk of child.stdout) {
      rest += chunk;
      let nl = rest.indexOf('\n');
      while (nl >= 0) {
        const line = rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        lines += 1;
        await onLine(line);
        nl = rest.indexOf('\n');
      }
      if (rest.length > maxLine) throw new OwnerDbError('overflow');
    }
    if (rest.length > 0) {
      lines += 1;
      await onLine(rest);
    }
  } catch (failure) {
    child.kill('SIGKILL');
    await closed;
    throw failure;
  }

  const { code, signal } = await closed;
  if (spawnFailed) throw new OwnerDbError('command');
  if (signal !== null && signal !== undefined) throw new OwnerDbError('signal');
  if (code !== 0) throw fromExit(code, stderr);
  return { lines };
}
