#!/usr/bin/env node
/* The owner-side whole-company copy, as a command (E7 design 1.2, corrections E7D-C-F8 and E7D-C-F12).
 *
 *   node scripts/export-company.mjs --company UUID --operator UUID --instruction REF --out PATH
 *
 * WHO RUNS THIS AND WHY IT EXISTS. api.export_company is a company ADMINISTRATOR's own copy and has no operator
 * arm at all (E6D-C-F1a): what the operator keeps is the register and a counts-only manifest, never the rows.
 * This script serves the customer that route cannot: a company above the route's ceiling, a suspended company
 * whose administrator cannot sign in, and a closed one inside its window. Its authorization is POSSESSION of the
 * owner connection, disclosed in E2 section 5's terms and not enforced by a routine, and every run needs a
 * recorded instruction from the customer.
 *
 * THE EIGHT STEPS of design 1.2, in the refusal order of 3.5, EVERY REFUSAL BEFORE ANYTHING IS WRITTEN:
 *   1. the arguments and the environment;
 *   2. the register verifies, or nothing runs;
 *   3. the operator is a row of app.operators and the company exists (the company's STATUS is not a
 *      precondition: the states the route refuses are exactly the states this script is for);
 *   4. one snapshot: begin repeatable read read only, the company row and app.export_section_counts, then the
 *      twenty-one sections, then commit;
 *   5. the file is written AS IT STREAMS to <out>.partial, created exclusively at mode 0600, memory holding one
 *      row at a time;
 *   6. the completeness check: every written count equals the snapshot's;
 *   7. the audit row, one transaction, through keys 008's guard already admits;
 *   8. the register line, then publication. A failure at 7 or 8 REMOVES THE PARTIAL FILE: a copy that is not
 *      recorded is not handed over.
 *
 * PUBLICATION IS ATOMIC AND NO-CLOBBER (E7D-C-F8), and it is a LINK and then an unlink, never a rename over a
 * path: link() fails if the final name exists, so a file that appeared between the check and the publication is
 * refused rather than overwritten, which a rename would not do.
 *
 * WHAT IS LOGGED AND WHAT NEVER IS. Logged to stdout: the company id, each section's name and count, the total
 * rows, the bytes, the SHA-256, the duration, the audit id and the new register head. NEVER logged: a row, a
 * column value, the company's name or slug, an address. The output path itself is printed once, because the
 * operator chose it. A failure of the owner connection is ONE owner_db_failed line with a category, a SQLSTATE
 * and a CODES key, and never the database's text (scripts/owner-db.mjs).
 *
 * HOW THE FILE REACHES THE CUSTOMER is procedure, in the operator guide (design 1.7): a channel the customer's
 * administrator names in writing, encrypted in transit and at rest, never a mail attachment; the customer checks
 * the SHA-256 against the one the operator sends separately; the local copy is deleted once receipt is confirmed,
 * and that deletion is a second register line, written with `register.mjs append`.
 *
 * What it needs:
 *   ENTERPRISE_DB_PSQL        the owner connection. Never printed.
 *   ENTERPRISE_REGISTER_PATH  the register, outside every Git work tree.
 */
import { closeSync, fstatSync, linkSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACT_COPY_TAKEN,
  append as appendLine,
  checkRegisterPath,
  fileStore,
  isRef,
  isUuid,
  RegisterError,
  verify,
  withLock,
} from '../lib/operator/register.mjs';
import {
  checkOutputPath,
  completeness,
  hasher,
  HEAD_MARK,
  makeDocument,
  REASON_CODE,
  SECTION_MARK,
  SECTION_NAMES,
  snapshotSql,
  TakeoutError,
} from '../lib/operator/takeout.mjs';
import { OwnerDbError, outputFailure, ownerQuery, ownerStream } from './owner-db.mjs';

const out = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);

class Refusal extends Error {
  constructor(code, lines, usage = false) {
    super('export-company: refused');
    this.name = 'Refusal';
    this.code = code;
    this.lines = lines;
    this.usage = usage;
  }
}

const USAGE = 'usage: node scripts/export-company.mjs --company UUID --operator UUID --instruction REF --out PATH\n';

const refuse = (rule) => {
  throw new Refusal(2, [`export-company: ${rule}`], true);
};

/* Every value is matched against its shape BEFORE anything is opened, and a refusal names the flag and its rule
   and never what was passed: the reference and the path are the two arguments that can carry something
   identifying, and the company id names a customer to anyone holding the workspace. */
function parseArgs(argv) {
  const a = {};
  const value = (i, flag) => {
    const v = argv[i];
    if (typeof v !== 'string' || v.startsWith('--')) refuse(`${flag} takes a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--company':
      case '--operator': {
        const v = value(++i, flag);
        if (!isUuid(v)) refuse(`${flag} takes a lowercase uuid`);
        a[flag.slice(2)] = v;
        break;
      }
      case '--instruction': {
        const v = value(++i, flag);
        if (!isRef(v))
          refuse(
            '--instruction matches ^[A-Za-z0-9._:/-]{1,80}$: a reference to the customer’s instruction in the company workspace, never free text',
          );
        a.instruction = v;
        break;
      }
      case '--out': {
        const v = value(++i, flag);
        if (!isAbsolute(v)) refuse('--out takes an absolute path');
        a.out = v;
        break;
      }
      default:
        refuse(`unknown argument ${/^--[a-z0-9-]{1,32}$/.test(flag) ? flag : 'given'}`);
    }
  }
  for (const required of ['company', 'operator', 'instruction', 'out'])
    if (a[required] === undefined) refuse(`--${required} is required`);
  return a;
}

/* The register path, the store and the lock are the register module's (design 1.3): one rule with one home, and
   three scripts hold this file. */
function registerPath() {
  try {
    return checkRegisterPath(process.env.ENTERPRISE_REGISTER_PATH);
  } catch (e) {
    if (!(e instanceof RegisterError)) throw e;
    refuse(e.rule);
  }
}

/** Gate 1 for this script: the chain and the local head. Nothing runs against a register that does not verify. */
function verifyRegister(store, anchoredHead) {
  const text = store.read();
  if (text === null) throw new Refusal(1, ['export-company: the register does not exist; run register.mjs init first']);
  const state = verify(text, { localHead: store.readHead(), anchoredHead });
  if (!state.ok)
    throw new Refusal(
      1,
      state.problems.map((p) =>
        JSON.stringify({ event: 'register_refused', rule: p.rule, ...(p.at === undefined ? {} : { at: p.at }) }),
      ),
    );
  return state;
}

/** One marked payload line, so a psql command tag or an operator's own flags cannot be read as the answer. */
function marked(answer, mark) {
  const lines = answer.split('\n').filter((l) => l.startsWith(mark));
  if (lines.length !== 1) throw outputFailure();
  try {
    return JSON.parse(lines[0].slice(mark.length));
  } catch {
    throw outputFailure();
  }
}

/** A SQL string literal. Every value that reaches one here is a uuid, an integer or an act word this file wrote;
    nothing a caller typed reaches a statement without having matched its shape first. */
const quote = (text) => `'${String(text).replaceAll("'", "''")}'`;

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = fileStore(registerPath());
  /* Step 1, the output path: absolute, not existing, its directory real and outside every Git work tree, no link
     anywhere above it. Checked here, before the register is even opened. */
  let paths;
  try {
    paths = checkOutputPath(args.out);
  } catch (e) {
    if (!(e instanceof TakeoutError)) throw e;
    refuse(e.rule);
  }

  return withLock(store, async () => {
    /* Step 2. */
    verifyRegister(store);

    /* Step 3. The operator must be a row of app.operators; the company must exist. Its STATUS is not asked,
       because the states the route refuses are exactly the states this script exists for. */
    const standing = marked(
      ownerQuery(
        `select '${HEAD_MARK}' || jsonb_build_object(` +
          `'operator', exists (select 1 from app.operators o where o.user_id = '${args.operator}'::uuid),` +
          `'company', exists (select 1 from app.companies c where c.id = '${args.company}'::uuid))::text;`,
      ),
      HEAD_MARK,
    );
    if (standing.operator !== true)
      throw new Refusal(1, ['export-company: the operator is not a row of app.operators']);
    if (standing.company !== true) throw new Refusal(1, ['export-company: no such company']);

    /* Steps 4 and 5, together, because the writing IS the reading: every row goes to the file as it arrives and
       nothing holds a section. The partial file is created exclusively at mode 0600 and its mode is VERIFIED
       after the open, because a umask cannot widen what was asked for but a later change to this code could. */
    const startedAt = Date.now();
    const exportedAt = new Date().toISOString();
    const fd = openSync(paths.partial, 'wx', 0o600);
    const mode = fstatSync(fd).mode & 0o777;
    if (mode !== 0o600) {
      closeSync(fd);
      unlinkSync(paths.partial);
      throw new Refusal(1, [`export-company: the partial file opened at mode ${mode.toString(8)}, not 600`]);
    }
    const sha = hasher();
    let bytes = 0;
    const sink = {
      write(text) {
        const buffer = Buffer.from(text, 'utf8');
        writeSync(fd, buffer);
        sha.update(text);
        bytes += buffer.length;
      },
    };

    const removePartial = () => {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
      try {
        unlinkSync(paths.partial);
      } catch {
        /* already gone */
      }
    };

    let document = null;
    let head = null;
    let section = null;
    let written;
    try {
      await ownerStream(snapshotSql(args.company), (line) => {
        if (line.startsWith(HEAD_MARK)) {
          head = JSON.parse(line.slice(HEAD_MARK.length));
          if (head?.company === null || head?.company === undefined) throw outputFailure();
          document = makeDocument({
            sink,
            company: head.company,
            exportedAt,
            instructionRef: args.instruction,
            operatorUserId: args.operator,
          });
          document.begin();
          return;
        }
        if (line.startsWith(SECTION_MARK)) {
          if (document === null) throw outputFailure();
          if (section !== null) document.endSection();
          section = line.slice(SECTION_MARK.length);
          document.beginSection(section);
          return;
        }
        /* psql prints a command tag for BEGIN and COMMIT even under -At; a tag is not a row and is not a
           marker, and neither is an empty line. */
        if (line === '' || line === 'BEGIN' || line === 'COMMIT') return;
        if (document === null || section === null) throw outputFailure();
        document.row(line);
      });
      if (document === null) throw outputFailure();
      if (section !== null) document.endSection();
      written = document.end();
      closeSync(fd);
    } catch (failure) {
      removePartial();
      throw failure;
    }

    /* Step 6. Any difference at all deletes the partial file and names the SECTIONS, never their rows. */
    const check = completeness(written.counts, head.counts);
    if (!check.ok) {
      removePartial();
      for (const p of check.problems) out({ event: 'export_incomplete', ...p });
      throw new Refusal(1, [
        'export-company: the copy is not the tenant; the sections above disagree with the snapshot',
      ]);
    }
    const sha256 = sha.digest();
    const durationMs = Date.now() - startedAt;
    for (const name of SECTION_NAMES) out({ event: 'export_section', section: name, rows: written.counts[name] });
    out({
      event: 'export_written',
      companyId: args.company,
      rows: written.rows,
      bytes,
      sha256,
      durationMs,
      peakRssBytes: process.memoryUsage().rss,
    });

    /* Step 7. One transaction, the operator's claims set for it alone. app.audit returns void, so the id is read
       back through currval of app.audit_events' own sequence IN THE SAME SESSION AND THE SAME TRANSACTION: that
       is the value THIS session last drew, so it is this row's id and cannot be another operator's, which
       `order by id desc limit 1` could be. Every key and shape is already admitted
       by 008's app.audit_details_guard (section_counts against app.export_section_names() for this action), so
       no migration is needed. The disclosure this makes, stated rather than hidden: whoever holds the owner
       connection can act as any registered operator and bypass the second factor the routine asks for. That is
       already true (E2 section 5) and the control is the credential's custody, not the routine. */
    let auditId;
    try {
      const claims = JSON.stringify({ role: 'app_server', sub: args.operator, aal: 'aal2' });
      const answer = ownerQuery(
        `begin;
select set_config('request.jwt.claims', ${quote(claims)}, true);
select app.audit(
  '${args.company}'::uuid, '${args.operator}'::uuid, 'operator', ${quote(ACT_COPY_TAKEN)}, 'company', '${args.company}'::uuid,
  jsonb_build_object('company_id', '${args.company}'::uuid, 'operator_user_id', '${args.operator}'::uuid,
                     'section_counts', ${quote(JSON.stringify(written.counts))}::jsonb,
                     'withheld_rows', 0, 'serialized_bytes', ${Number(bytes)},
                     'reason_code', ${quote(REASON_CODE)}));
select '${HEAD_MARK}' || jsonb_build_object(
  'auditId', currval(pg_get_serial_sequence('app.audit_events', 'id')))::text;
commit;`,
      );
      auditId = Number(marked(answer, HEAD_MARK).auditId);
      if (!Number.isSafeInteger(auditId)) throw outputFailure();
    } catch (failure) {
      removePartial();
      throw failure;
    }
    out({ event: 'export_audited', auditId });

    /* Step 8. The register line, THEN publication. If the append fails the partial file is removed and the
       script exits naming the audit id: the next `register.mjs sync --ref <auditId>=<ref>` writes the line with
       sha256 null, because the file was removed at this step and never handed over. */
    let line;
    try {
      line = appendLine(
        store,
        ACT_COPY_TAKEN,
        {
          companyId: args.company,
          ref: args.instruction,
          sha256,
          bytes,
          rows: written.rows,
          auditId,
          actor: args.operator,
        },
        {},
      );
    } catch (failure) {
      removePartial();
      out({ event: 'register_append_failed', auditId, act: ACT_COPY_TAKEN });
      throw new Refusal(1, [
        `export-company: the copy was audited as ${auditId} and its register line was NOT written, so the file was removed. Run: node scripts/register.mjs sync --operator ${args.operator} --ref ${auditId}=<the instruction reference>`,
        `export-company: the register refused: ${failure instanceof RegisterError ? failure.rule : 'unknown'}`,
      ]);
    }

    /* A LINK and then an unlink, never a rename over a path: link() fails if the final name exists, so a file
       that appeared since step 1 is refused rather than overwritten (E7D-C-F8). */
    try {
      linkSync(paths.partial, paths.path);
    } catch (e) {
      out({ event: 'export_publish_failed', code: e.code === 'EEXIST' ? 'EEXIST' : 'other', auditId, seq: line.seq });
      throw new Refusal(1, [
        'export-company: the output path exists now although it did not at the start; the file is still at <out>.partial and the register line is written',
      ]);
    }
    unlinkSync(paths.partial);

    out({
      event: 'export_done',
      companyId: args.company,
      auditId,
      seq: line.seq,
      head: line.head,
      sha256,
      bytes,
      rows: written.rows,
      durationMs: Date.now() - startedAt,
    });
    process.stdout.write(`export-company: ${paths.path}\n`);
    process.stdout.write(
      `export-company: record the head ${line.head} in the company workspace, send the SHA-256 to the customer separately, and append the discard line once receipt is confirmed.\n`,
    );
    return 0;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = (await main()) ?? 0;
  } catch (failure) {
    if (failure instanceof Refusal) {
      for (const l of failure.lines) process.stderr.write(`${l}\n`);
      if (failure.usage) process.stderr.write(USAGE);
      process.exit(failure.code);
    }
    if (failure instanceof OwnerDbError) {
      out(failure.line);
      process.exit(1);
    }
    if (failure instanceof TakeoutError || failure instanceof RegisterError) {
      out({ event: 'export_refused', rule: failure.rule });
      process.exit(1);
    }
    throw failure;
  }
}
