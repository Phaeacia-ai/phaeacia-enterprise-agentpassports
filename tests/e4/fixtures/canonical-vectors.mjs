/* Case 46 (E4 design 1.1 and 5): envelope bindings for the cross-runtime vectors. lib/passport/packet.mjs
   envelopeCanonical builds each text in Node; tests/db/e4.mjs canonical-sql asks app.envelope_canonical for the same row
   and compares text and SHA-256. The vectors cover one and twenty groups, unsorted input, every target, hashes of all
   zeros and all f, the extreme uuids, and CRAFTED_PAIR: two group ids whose byte order ('10...' before '1a...') is the
   reverse of an ICU numeric collation's (digit runs compared as numbers, so '1' before '10'). Hashes are derived from
   labels, never typed. */
import { createHash } from 'node:crypto';

import { envelopeCanonical } from '../../../lib/passport/packet.mjs';

const h = (label) => createHash('sha256').update(label, 'utf8').digest('hex');
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const CRAFTED_PAIR = Object.freeze(['1a000000-0000-4000-8000-000000000000', '10000000-0000-4000-8000-000000000000']);

function vector(label, over) {
  const v = {
    id: h(`${label} id`).replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/, '$1-$2-4$3-8$4-$5'),
    company_id: id(1),
    agent_id: id(2),
    candidate_id: id(3),
    gate_id: id(4),
    content_sha256: h(`${label} content`),
    derived_sha256: h(`${label} derived`),
    gate_identity_sha256: h(`${label} gate`),
    target: 'claude-ai',
    installer: {
      text_sha256: h(`${label} text`),
      core_sha256: h(`${label} core`),
      branch_sha256: h(`${label} branch`),
      judge_sha256: h(`${label} judge`),
    },
    policy: { id: id(5), sha256: h(`${label} policy`) },
    group_ids: [id(10)],
    ...over,
  };
  v.expectedSha256 = createHash('sha256').update(envelopeCanonical(v), 'utf8').digest('hex');
  return Object.freeze(v);
}

const twenty = Array.from({ length: 20 }, (_, i) => h(`group ${i}`).replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/, '$1-$2-4$3-a$4-$5'));

export const ENVELOPE_VECTORS = Object.freeze([
  vector('one group', {}),
  vector('twenty groups, unsorted', { group_ids: [...twenty].reverse() }),
  vector('the crafted pair, numeric order first', { group_ids: [...CRAFTED_PAIR] }),
  vector('chatgpt, all zeros', {
    target: 'chatgpt',
    content_sha256: '0'.repeat(64),
    derived_sha256: '0'.repeat(64),
    gate_identity_sha256: '0'.repeat(64),
    installer: { text_sha256: '0'.repeat(64), core_sha256: '0'.repeat(64), branch_sha256: '0'.repeat(64), judge_sha256: '0'.repeat(64) },
    policy: { id: id(0), sha256: '0'.repeat(64) },
  }),
  vector('generic, all f', {
    target: 'generic',
    content_sha256: 'f'.repeat(64),
    derived_sha256: 'f'.repeat(64),
    gate_identity_sha256: 'f'.repeat(64),
    installer: { text_sha256: 'f'.repeat(64), core_sha256: 'f'.repeat(64), branch_sha256: 'f'.repeat(64), judge_sha256: 'f'.repeat(64) },
    policy: { id: 'ffffffff-ffff-4fff-bfff-ffffffffffff', sha256: 'f'.repeat(64) },
  }),
  vector('claude-code, digits', { target: 'claude-code', group_ids: [id(99), id(9), id(100)] }),
  vector('extreme uuids', {
    candidate_id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
    group_ids: ['ffffffff-ffff-4fff-bfff-ffffffffffff', '00000000-0000-4000-8000-000000000000'],
  }),
  vector('ids differing in the last character', { group_ids: [id(11).replace(/1$/, 'b'), id(11), id(11).replace(/1$/, 'a')] }),
  vector('ids differing in the first character', { group_ids: [`f${id(12).slice(1)}`, `a${id(12).slice(1)}`, `0${id(12).slice(1)}`] }),
  vector('twenty groups holding the crafted pair', { group_ids: [...twenty.slice(0, 18), ...CRAFTED_PAIR] }),
  vector('second target of the same candidate', { target: 'chatgpt' }),
]);
