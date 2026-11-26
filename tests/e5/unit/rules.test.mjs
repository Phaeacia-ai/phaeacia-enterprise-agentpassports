/* lib/rules/installations.mjs, no stack (E5 design 1.4, 1.5, 3.2; section 5 cases 18, 21 and 26).
   - the status vocabulary and the losses rule, against the migration's own text;
   - the check-in arithmetic at the boundary, including the counterexample the design names: the rule computed from the
     last authorization leaves a pair that re-downloads never due again;
   - every label pinned to its exact sentence, and the gate over the four forbidden words with its counterexample. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  authorizationLabelOf,
  CHECK_IN_INTERVAL_DAYS,
  checkInDueAt,
  INSTALLATION_SOURCES,
  INSTALLATION_STATUSES,
  installationStatusOf,
  compareReports,
  labelOf,
  labelTable,
  lossesRequired,
  newestReport,
  REFUSED_LABEL_TOKENS,
  refusedLabelTokens,
  statusName,
  WITNESS_ROLES,
  witnessLabelOf,
} from '../../../lib/rules/installations.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
/* E5S-C-F1. The rows are the shape api.installation_reports answers, and the fixture is the critic's: the older report
   carries the greater uuid, so a reader that takes a position out of a uuid-ordered list picks the older one. The list
   is handed in reversed as well, because the rule may not depend on the order the read returned. */
const OLDER_GREATER_UUID = { id: 'f0000000-0000-4000-8000-000000000001', status: 'pass', reported_at: '2026-09-01T10:00:00.000Z' };
const NEWER_LESSER_UUID = { id: '10000000-0000-4000-8000-000000000001', status: 'removed', reported_at: '2026-09-02T10:00:00.000Z' };

test('E5S-C-F1: the newest report is the greatest reported_at, whatever order the read returned', () => {
  const uuidOrder = [NEWER_LESSER_UUID, OLDER_GREATER_UUID];
  assert.equal(newestReport(uuidOrder)?.status, 'removed', 'uuid order: the last row is the older report');
  assert.equal(newestReport([...uuidOrder].reverse())?.status, 'removed', 'and the reverse of it answers the same');
  assert.equal(newestReport([OLDER_GREATER_UUID])?.status, 'pass', 'one report is the newest report');
  for (const empty of [[], null, undefined, 'not a list']) assert.equal(newestReport(empty), null, String(empty));
  assert.deepEqual(uuidOrder, [NEWER_LESSER_UUID, OLDER_GREATER_UUID], 'and the caller s array is not reordered');
});

test('E5S-C-F1: reports of the same instant are broken by id, the same way in both directions', () => {
  const same = '2026-09-02T10:00:00.000Z';
  const low = { id: '10000000-0000-4000-8000-000000000001', status: 'pass', reported_at: same };
  const high = { id: 'f0000000-0000-4000-8000-000000000001', status: 'removed', reported_at: same };
  assert.equal(newestReport([low, high])?.id, high.id);
  assert.equal(newestReport([high, low])?.id, high.id, 'the tie does not follow the order the read returned');
  assert.equal(compareReports(low, high) < 0, true);
  assert.equal(compareReports(high, low) > 0, true, 'the comparator is antisymmetric, so a sort is deterministic');
  assert.equal(compareReports(low, low), 0);
  /* A row the database cannot produce: no time at all sorts oldest rather than over a real report. */
  const nothing = { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', status: 'pass' };
  assert.equal(newestReport([nothing, low])?.id, low.id);
  assert.equal(newestReport([nothing])?.id, nothing.id, 'and is still the newest of a list of one');
});
const DAY = 24 * 60 * 60 * 1000;
const at = (ms) => new Date(ms).toISOString();

test('the status vocabulary is the migration s, and installationStatusOf admits nothing else', () => {
  assert.deepEqual([...INSTALLATION_STATUSES], ['pass', 'partial', 'fail', 'removed']);
  for (const s of INSTALLATION_STATUSES) assert.deepEqual(installationStatusOf(s), { ok: true, value: s });
  for (const bad of ['verified', 'PASS', '', null, undefined, 1, ['pass'], 'pass ']) {
    assert.deepEqual(installationStatusOf(bad), { ok: false, code: 'E_BODY_INVALID' }, String(bad));
  }
});

test('case 18: losses are required for partial and fail, and for nothing else', () => {
  assert.deepEqual(
    INSTALLATION_STATUSES.filter(lossesRequired),
    ['partial', 'fail'],
    'the two statuses that are not evidence without a statement of what was lost',
  );
});

test('case 21: the check-in is due at the fourteenth day exactly, from the FIRST authorization', () => {
  const first = Date.parse('2026-09-16T08:00:00.000Z');
  const due = first + CHECK_IN_INTERVAL_DAYS * DAY;
  const before = checkInDueAt(at(first), [], at(due - 1000));
  const exactly = checkInDueAt(at(first), [], at(due));
  const after = checkInDueAt(at(first), [], at(due + DAY));
  assert.equal(before.checkInDue, false, 'one second before');
  assert.equal(exactly.checkInDue, true, 'at the moment');
  assert.equal(after.checkInDue, true, 'a day later');
  assert.equal(exactly.checkInDueAt, at(due));
  assert.equal(before.checkInDueAt, at(due), 'the due moment is known before it arrives');
});

test('case 21: any report clears it, whatever its status, and a later download does not reopen it', () => {
  const first = Date.parse('2026-09-01T08:00:00.000Z');
  const now = at(first + 30 * DAY);
  for (const status of INSTALLATION_STATUSES) {
    assert.deepEqual(
      checkInDueAt(at(first), [{ status, reported_at: at(first + DAY) }], now),
      { checkInDue: false, checkInDueAt: null },
      status,
    );
  }
  /* The re-download moves the LAST authorization, never the first, so the pair stays due until it is reported. */
  assert.equal(checkInDueAt(at(first), [], now).checkInDue, true);
});

test('case 21 fail-before: the same arithmetic on the LAST authorization is never due after a re-download', () => {
  const first = Date.parse('2026-09-01T08:00:00.000Z');
  const now = at(first + 30 * DAY);
  const lastAuthorizedAt = at(first + 29 * DAY);
  assert.equal(checkInDueAt(at(first), [], now).checkInDue, true, 'the accepted rule: due');
  assert.equal(
    checkInDueAt(lastAuthorizedAt, [], now).checkInDue,
    false,
    'the counterexample: a recipient who downloads again every fortnight is never due',
  );
});

test('a pair with no authorization has no check-in and no date', () => {
  for (const value of [null, undefined, '', 'not-a-time', 42]) {
    assert.deepEqual(checkInDueAt(value, [], at(Date.now())), { checkInDue: false, checkInDueAt: null }, String(value));
  }
});

test('case 26: every label is pinned to its exact sentence', () => {
  for (const status of INSTALLATION_STATUSES) {
    assert.equal(labelOf({ source: 'recipient_app', status }), 'Recipient-reported');
    assert.equal(labelOf({ source: 'recipient_mail', status }), 'Recipient-reported through a check-in mail');
    assert.equal(
      labelOf({ source: 'founder_run', status }),
      'Founder-run transfer, recorded by the operator',
    );
    assert.equal(witnessLabelOf({ witnessRole: 'it_reviewer', status }), 'Witnessed by an IT reviewer');
    assert.equal(witnessLabelOf({ witnessRole: 'business_reviewer', status }), 'Witnessed by a business reviewer');
    assert.equal(witnessLabelOf({ witnessRole: 'company_admin', status }), 'Witnessed by a company administrator');
  }
  assert.deepEqual(
    INSTALLATION_STATUSES.map(statusName),
    ['It works', 'It partly works', 'It does not work', 'I have removed it'],
  );
  assert.equal(authorizationLabelOf({ authorizations: 0 }), null);
  assert.equal(authorizationLabelOf({ authorizations: 1 }), 'Download authorized');
  assert.equal(authorizationLabelOf({ authorizations: 2 }), 'Download authorized 2 times');
});

test('E5D-C-F5: no label composed from the ledger alone claims an installation', () => {
  for (const authorizations of [1, 2, 7, 200]) {
    const label = authorizationLabelOf({ authorizations });
    assert.match(label, /^Download authorized/);
    for (const word of ['install', 'you have this', 'installed']) {
      assert.equal(label.toLowerCase().includes(word), false, `${label} says ${word}`);
    }
  }
});

test('an unknown source, role or status throws rather than rendering an empty label', () => {
  for (const bad of [{ source: 'made_up', status: 'pass' }, { source: 'recipient_app', status: 'verified' }, {}]) {
    assert.throws(() => labelOf(bad), TypeError, JSON.stringify(bad));
  }
  for (const bad of [{ witnessRole: 'member', status: 'pass' }, { witnessRole: 'it_reviewer', status: 'x' }, {}]) {
    assert.throws(() => witnessLabelOf(bad), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => statusName('verified'), TypeError);
  assert.throws(() => authorizationLabelOf({ authorizations: -1 }), TypeError);
});

test('case 26: the label gate finds no forbidden word in any sentence this module can produce', () => {
  const rows = labelTable();
  assert.equal(
    rows.length,
    INSTALLATION_SOURCES.length * INSTALLATION_STATUSES.length +
      WITNESS_ROLES.length * INSTALLATION_STATUSES.length +
      INSTALLATION_STATUSES.length +
      2,
    'every pair the module can produce is in the table',
  );
  for (const row of rows) assert.deepEqual(refusedLabelTokens(row.label), [], row.label);
});

test('case 26 fail-before: the gate finds a mutant label carrying each forbidden word', () => {
  assert.deepEqual([...REFUSED_LABEL_TOKENS], ['verified', 'validated', 'confirmed working', 'certified']);
  assert.deepEqual(refusedLabelTokens('Verified by an IT reviewer'), ['verified']);
  assert.deepEqual(refusedLabelTokens('Validated on her machine'), ['validated']);
  assert.deepEqual(refusedLabelTokens('Confirmed working by the reviewer'), ['confirmed working']);
  assert.deepEqual(refusedLabelTokens('Certified installation'), ['certified']);
  assert.deepEqual(refusedLabelTokens('A certified, verified statement'), ['verified', 'certified']);
  /* And it is a string check over a fixed list, not a content detector: it claims nothing about any other sentence. */
  assert.deepEqual(refusedLabelTokens('Witnessed by an IT reviewer'), []);
  assert.deepEqual(refusedLabelTokens('The reviewer confirmed the report'), []);
});

test('case 26: no E5 source file the server half owns puts a forbidden word in a fixed string', () => {
  const sources = [
    'lib/rules/installations.mjs',
    'lib/services/catalog.mjs',
    'lib/services/installations.mjs',
    'lib/services/evidence-reads.mjs',
  ];
  const found = [];
  for (const rel of sources) {
    const text = readFileSync(join(REPO, rel), 'utf8');
    /* Single-quoted strings only: a comment may say "verified" about what a label must never claim, and this gate is
       about what a client renders. The one file that names the words is the rule module's own vocabulary. */
    for (const m of text.matchAll(/'([^'\n]*)'/g)) {
      if (rel === 'lib/rules/installations.mjs' && REFUSED_LABEL_TOKENS.includes(m[1])) continue;
      const hits = refusedLabelTokens(m[1]);
      if (hits.length > 0) found.push(`${rel}: ${m[1]}`);
    }
  }
  assert.deepEqual(found, []);
});

test('E5C-R-F1: two reports inside one millisecond order by their microseconds, not by id', () => {
  /* The reviewer's counterexample (evidence/batch-2-review.md): the column is timestamptz at microsecond resolution,
     Date.parse keeps milliseconds, so an older pass with the greater uuid beat a newer removal 800 microseconds later. */
  const older = { id: 'ffffffff-0000-4000-8000-000000000000', status: 'pass', reported_at: '2026-09-02T10:00:05.000100+00:00' };
  const newer = { id: '00000000-0000-4000-8000-000000000000', status: 'removed', reported_at: '2026-09-02T10:00:05.000900+00:00' };
  assert.equal(newestReport([older, newer]).status, 'removed');
  assert.equal(newestReport([newer, older]).status, 'removed');
  assert.equal(compareReports(older, newer) < 0, true);
  assert.equal(compareReports(newer, older) > 0, true);
  /* A fraction shorter than six digits, none at all, and a Z offset: equal times still fall to the id, once. */
  const a = { id: 'a', reported_at: '2026-09-02T10:00:05.5Z' };
  const b = { id: 'b', reported_at: '2026-09-02T10:00:05.500000+00:00' };
  assert.equal(compareReports(a, b) < 0 && compareReports(b, a) > 0, true, 'equal to the microsecond: the id decides');
  const c = { id: 'c', reported_at: '2026-09-02T10:00:05Z' };
  assert.equal(compareReports(c, a) < 0, true, 'no fraction sorts before half a second later');
});

