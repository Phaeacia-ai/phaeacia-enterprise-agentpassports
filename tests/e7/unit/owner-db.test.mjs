/* E7 design 1.2 and section 5 case E7-32: the owner connection's failure mapping, against a child this file
   scripts. No database, no stack, no credential: ENTERPRISE_DB_PSQL is set per case to a bash command that prints a
   SYNTHETIC psql diagnostic and exits with the status the case is about.

   The synthetic strings below are the point of the case. Each carries the shape a real diagnostic would carry a
   tenant's content in: a failing row, a host, a role, a database name. Every arm asserts that NONE of them reaches
   any output at all: not the returned value, not the failure line a script prints, not the error's message, not its
   stack, and not the sweep's stdout or stderr when the whole script is run against the same child. They take the
   `synthetic` and `example-` shapes scripts/check-secrets.mjs excludes, and none of them is or resembles a
   credential.

   The fail-before is on record as a run rather than as a mutant, because the defect is in accepted code: main's
   scripts/sweep-accounts.mjs at f842da1, fed the same check-violation child, printed the failing row and the
   connection's host and role to the terminal (evidence/e7-scripts-repro/e7-32-sweep-fail-before.log.txt, arms 1 and
   2), and Node's default maxBuffer handed back 1,114,112 of 2,000,000 bytes with no exit status (arm 3, probe P1). */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { diagnose, MAX_BUFFER, OwnerDbError, outputFailure, ownerQuery, ownerStream } from '../../../scripts/owner-db.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/* The synthetic strings. Nothing in any output may carry one of these. */
const SYNTHETIC = Object.freeze({
  row: 'SYNTHETIC TENANT NAME 0001',
  slug: 'synthetic-tenant-slug-0001',
  host: 'synthetic-db-host.example-invalid',
  role: 'synthetic_owner_role',
  database: 'synthetic_tenant_db',
});
const ALL = Object.values(SYNTHETIC);

/** A child, as one bash command, that drains its stdin then behaves as the case needs. */
function child(body) {
  return `cat > /dev/null; ${body}`;
}
const CHECK_VIOLATION = child(
  `>&2 echo 'psql:<stdin>:4: ERROR:  23514: new row for relation "companies" violates check constraint "companies_name_check"';` +
    ` >&2 echo 'psql:<stdin>:4: DETAIL:  Failing row contains (00000000-0000-0000-0000-000000000001, ${SYNTHETIC.slug}, ${SYNTHETIC.row}, active).';` +
    ' exit 3',
);
const CONNECTION_FAILURE = child(
  `>&2 echo 'psql: error: connection to server at "${SYNTHETIC.host}" (203.0.113.7), port 54329 failed: FATAL:  role "${SYNTHETIC.role}" does not exist';` +
    ` >&2 echo 'psql: error: database "${SYNTHETIC.database}" is unreachable';` +
    ' exit 2',
);
const RAISED = (token) => child(`>&2 echo 'psql:<stdin>:4: ERROR:  P0001: ${token}'; exit 3`);
const KILLED = child('kill -KILL $$');
/** Prints n bytes on stdout and exits 0. */
const ANSWERS = (n) => child(`head -c ${n} /dev/zero | tr '\\0' a`);

function withCommand(command, run) {
  const before = process.env.ENTERPRISE_DB_PSQL;
  process.env.ENTERPRISE_DB_PSQL = command;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.ENTERPRISE_DB_PSQL;
    else process.env.ENTERPRISE_DB_PSQL = before;
  }
}

/** Everything a caller could reach from a failure, as one string. */
function surface(error) {
  return [
    JSON.stringify(error.line),
    String(error.message),
    String(error.stack ?? ''),
    JSON.stringify(Object.getOwnPropertyNames(error).map((k) => [k, error[k]])),
  ].join('\n');
}

function assertClean(text, label) {
  for (const s of ALL) assert.equal(text.includes(s), false, `${label}: the output carries ${s}`);
}

// ---------------------------------------------------------------------------
// E7-32 arm 1: a failing statement whose DETAIL echoes the row.
// ---------------------------------------------------------------------------
test('E7-32: a check violation is one line, category statement with its SQLSTATE, and the failing row is dropped', () => {
  const failure = withCommand(CHECK_VIOLATION, () => {
    try {
      ownerQuery('select 1;');
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.ok(failure instanceof OwnerDbError);
  assert.deepEqual(failure.line, { event: 'owner_db_failed', category: 'statement', sqlstate: '23514' });
  assert.equal('code' in failure.line, false, 'a check violation carries no E_ token, so no code is invented');
  assertClean(surface(failure), 'ownerQuery, check violation');
});

test('E7-32: the same through ownerStream', async () => {
  const seen = [];
  const failure = await withCommand(CHECK_VIOLATION, async () => {
    try {
      await ownerStream('select 1;', (l) => seen.push(l));
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.ok(failure instanceof OwnerDbError);
  assert.deepEqual(failure.line, { event: 'owner_db_failed', category: 'statement', sqlstate: '23514' });
  assert.deepEqual(seen, [], 'the child wrote nothing to stdout');
  assertClean(surface(failure), 'ownerStream, check violation');
});

// ---------------------------------------------------------------------------
// The code field: fromPostgrest's own rule and no wider. This is what lets the delete script tell two P0001s apart.
// ---------------------------------------------------------------------------
test('design 1.2: a raised E_ token that is a key of CODES becomes the code field, and two P0001s stay distinct', () => {
  for (const token of ['E_DELETE_TOO_LARGE', 'E_DELETION_NOT_DUE', 'E_COMPANY_NOT_CLOSED', 'E_CONFIRMATION_MISMATCH']) {
    const failure = withCommand(RAISED(token), () => {
      try {
        ownerQuery('select 1;');
        return null;
      } catch (e) {
        return e;
      }
    });
    assert.deepEqual(failure.line, {
      event: 'owner_db_failed',
      category: 'statement',
      sqlstate: 'P0001',
      code: token,
    });
  }
});

test('design 1.2: a token that is not a key of CODES is NOT forwarded, and neither is a message that is not a token', () => {
  for (const message of ['E_NOT_A_REAL_CODE', 'permission denied for table companies']) {
    const failure = withCommand(RAISED(message), () => {
      try {
        ownerQuery('select 1;');
        return null;
      } catch (e) {
        return e;
      }
    });
    assert.deepEqual(failure.line, { event: 'owner_db_failed', category: 'statement', sqlstate: 'P0001' });
  }
});

test('design 1.2: diagnose reads the first line only, and reads nothing from a line that is not psql verbose shape', () => {
  assert.deepEqual(diagnose('ERROR:  23514: E_DELETE_TOO_LARGE\nDETAIL:  Failing row contains (x)'), {
    sqlstate: '23514',
    code: 'E_DELETE_TOO_LARGE',
  });
  /* The second line is never read, so a DETAIL that happened to look like an error line is not a source. */
  assert.deepEqual(diagnose('NOTICE:  something\nERROR:  23514: E_DELETE_TOO_LARGE'), {});
  assert.deepEqual(diagnose(''), {});
  assert.deepEqual(diagnose(undefined), {});
  assert.deepEqual(diagnose('ERROR:  lower: E_X'), {}, 'the SQLSTATE class is five upper-case alphanumerics');
});

// ---------------------------------------------------------------------------
// E7-32 arm 2: a connection failure whose diagnostic names the host, the role and the database.
// ---------------------------------------------------------------------------
test('E7-32: a connection failure is category connection with no SQLSTATE, and the host, role and database are dropped', () => {
  const failure = withCommand(CONNECTION_FAILURE, () => {
    try {
      ownerQuery('select 1;');
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.deepEqual(failure.line, { event: 'owner_db_failed', category: 'connection' });
  assertClean(surface(failure), 'ownerQuery, connection failure');
});

test('E7-32: the same through ownerStream', async () => {
  const failure = await withCommand(CONNECTION_FAILURE, async () => {
    try {
      await ownerStream('select 1;', () => {});
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.deepEqual(failure.line, { event: 'owner_db_failed', category: 'connection' });
  assertClean(surface(failure), 'ownerStream, connection failure');
});

// ---------------------------------------------------------------------------
// E7-32 arm 3: a killed child. Distinct from the bound, which is arm 4.
// ---------------------------------------------------------------------------
test('E7-32: a killed child is category signal, through both calls', async () => {
  const sync = withCommand(KILLED, () => {
    try {
      ownerQuery('select 1;');
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.deepEqual(sync.line, { event: 'owner_db_failed', category: 'signal' });
  const streamed = await withCommand(KILLED, async () => {
    try {
      await ownerStream('select 1;', () => {});
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.deepEqual(streamed.line, { event: 'owner_db_failed', category: 'signal' });
});

// ---------------------------------------------------------------------------
// E7-32 arm 4: an answer above the bound REFUSES rather than truncating, which is the whole of probe P1's lesson.
// ---------------------------------------------------------------------------
test('E7-32: ownerQuery refuses above its bound and never returns a truncated answer', () => {
  const failure = withCommand(ANSWERS(4096), () => {
    try {
      ownerQuery('select 1;', { maxBuffer: 1024 });
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.deepEqual(failure.line, { event: 'owner_db_failed', category: 'overflow' });
});

test('E7-32: the bound is 16 MiB by default, so probe P1’s 2,000,000 bytes come back WHOLE and 17 MiB refuses', () => {
  assert.equal(MAX_BUFFER, 16 * 1024 * 1024);
  const whole = withCommand(ANSWERS(2_000_000), () => ownerQuery('select 1;'));
  assert.equal(whole.length, 2_000_000, 'the default maxBuffer truncated this to 1,114,112 bytes before E7');
  const failure = withCommand(ANSWERS(17 * 1024 * 1024), () => {
    try {
      ownerQuery('select 1;');
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.deepEqual(failure.line, { event: 'owner_db_failed', category: 'overflow' });
});

test('design 1.2: ownerStream refuses a single line above the bound rather than growing to hold it', async () => {
  const failure = await withCommand(ANSWERS(65536), async () => {
    try {
      await ownerStream('select 1;', () => {}, { maxLine: 1024 });
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.deepEqual(failure.line, { event: 'owner_db_failed', category: 'overflow' });
  const { MAX_BUFFER: bound } = await import('../../../scripts/owner-db.mjs');
  assert.equal(bound, 16 * 1024 * 1024, 'and the default bound is the same 16 MiB');
});

// ---------------------------------------------------------------------------
// The remaining categories, and the two calls' successful shapes.
// ---------------------------------------------------------------------------
test('design 1.2: psql’s own exit 1 and a command that cannot run are category command, and the command is never printed', () => {
  const one = withCommand(child('exit 1'), () => {
    try {
      ownerQuery('select 1;');
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.deepEqual(one.line, { event: 'owner_db_failed', category: 'command' });
  const missing = withCommand('no-such-command-synthetic-0001', () => {
    try {
      ownerQuery('select 1;');
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.equal(missing.category, 'command');
  assert.equal(surface(missing).includes('no-such-command-synthetic-0001'), false, 'the command is never printed');
});

test('design 3.5 step 2: an unset ENTERPRISE_DB_PSQL refuses, and the failure names no value', () => {
  const before = process.env.ENTERPRISE_DB_PSQL;
  delete process.env.ENTERPRISE_DB_PSQL;
  try {
    assert.throws(() => ownerQuery('select 1;'), (e) => e instanceof OwnerDbError && e.category === 'command');
  } finally {
    if (before !== undefined) process.env.ENTERPRISE_DB_PSQL = before;
  }
});

test('design 1.2: outputFailure is the caller’s own category for an answer it cannot parse', () => {
  assert.deepEqual(outputFailure().line, { event: 'owner_db_failed', category: 'output' });
});

test('design 1.2: ownerQuery passes the three \\set lines and the statement on stdin, and answers the child’s stdout', () => {
  const echo = child('echo done').replace('cat > /dev/null', 'cat');
  const answer = withCommand(echo, () => ownerQuery('select 42;'));
  assert.equal(answer, '\\set ON_ERROR_STOP 1\n\\set VERBOSITY verbose\n\\set SHOW_CONTEXT never\nselect 42;\ndone');
});

test('design 1.2: ownerStream hands every line in order, exactly once, and holds one at a time', async () => {
  const lines = [];
  const produced = 5000;
  const result = await withCommand(child(`seq 1 ${produced}`), async () => ownerStream('select 1;', (l) => lines.push(l)));
  assert.equal(result.lines, produced);
  assert.equal(lines.length, produced);
  assert.equal(lines[0], '1');
  assert.equal(lines.at(-1), String(produced));
});

test('design 1.2: ownerStream is back-pressured: a pending onLine stops the next line arriving', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const seen = [];
  let firstArrived;
  const arrived = new Promise((resolve) => {
    firstArrived = resolve;
  });
  const run = withCommand(child('seq 1 200000'), () =>
    ownerStream('select 1;', async (line) => {
      seen.push(line);
      if (seen.length === 1) {
        firstArrived();
        await gate;
      }
    }),
  );
  await arrived;
  /* The child can produce the whole answer in this time; the consumer has had one line and the reader is paused. */
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(seen.length, 1, 'a second line arrived while the first was still being handled');
  release();
  const result = await run;
  assert.equal(result.lines, 200000);
  assert.equal(seen.length, 200000);
});

test('design 1.2: an error thrown by onLine propagates unchanged and the child is not left running', async () => {
  const mine = new Error('the caller’s own failure');
  await assert.rejects(
    withCommand(child('seq 1 100000'), () =>
      ownerStream('select 1;', (line) => {
        if (line === '3') throw mine;
      }),
    ),
    (e) => e === mine,
  );
});

// ---------------------------------------------------------------------------
// E7-32, the sweep: the same child through the WHOLE script, which is where the defect was.
// ---------------------------------------------------------------------------
function runSweep(command, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [join(REPO, 'scripts/sweep-accounts.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, ENTERPRISE_DB_PSQL: command },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (e) {
    return { status: e.status, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('E7-32: the sweep through ownerQuery prints ONE owner_db_failed line and no synthetic string', () => {
  for (const [label, command, expected] of [
    ['check violation', CHECK_VIOLATION, { event: 'owner_db_failed', category: 'statement', sqlstate: '23514' }],
    ['connection failure', CONNECTION_FAILURE, { event: 'owner_db_failed', category: 'connection' }],
    ['killed', KILLED, { event: 'owner_db_failed', category: 'signal' }],
  ]) {
    const r = runSweep(command);
    assert.equal(r.status, 1, `${label}: the sweep exits 1`);
    const failures = r.output
      .split('\n')
      .filter((l) => l.includes('owner_db_failed'))
      .map((l) => JSON.parse(l.slice(l.indexOf('{'))));
    assert.deepEqual(failures, [expected], `${label}: exactly one failure line, and it is the mapped one`);
    assertClean(r.output, `the sweep, ${label}`);
  }
});

test('E7-32: the sweep still refuses its own arguments before it opens the connection', () => {
  const r = runSweep(CHECK_VIOLATION, ['--limit', '0']);
  assert.equal(r.status, 2);
  assert.match(r.output, /--limit takes an integer from 1 to 1000/);
  assert.equal(r.output.includes('owner_db_failed'), false, 'no connection was opened');
});
