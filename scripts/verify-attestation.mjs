#!/usr/bin/env node
/* Offline replay verification of a stored attestation (attestation contract section 7; E3 design 4.4 and
   case 10). A local tool with no production role and no database access: it reads rows someone exported.

   For each row:
     1. Internal consistency: sha256(content) = content_sha256 and sha256(derived_canonical) = derived_sha256.
        The identity trigger guarantees these for a row the database holds, which is why step 3 exists.
     2. The registered identity is self-consistent: identity_sha256 = sha256 over
        "adapter_lock_sha256\nvalidator_version\nmanifest_sha256" (design 2.7).
     3. Replay. This checkout's committed gate identity must be the row's identity; if it is not, the
        row cannot be replayed here and the tool says which upstream commit and identity to check out,
        rather than replaying under a gate that did not attest the row. Then gate(content) with the row's
        own validated_at must pass, return text byte-equal to content (transport is idempotent on its own
        output) and derivedCanonical byte-equal to derived_canonical.
   With --release, additionally: the release's installer_text spliced into content at the placeholder
   must hash to its assembled_sha256 (contract step 4). Registered installer texts are E4's; this reads
   the text the export carries.

   What replay proves: that the stored bytes pass the named gate now. What it cannot prove: that the gate
   ran at validated_at. A handler that skipped the gate and stored passing bytes is indistinguishable from
   an honest one; one that stored failing bytes is caught.

   Input, JSON, one object or an array of them:
     { content, derived_canonical, content_sha256, derived_sha256,
       gate: { identity_sha256, adapter_lock_sha256, validator_version, manifest_sha256, upstream_commit } }
   A bytea may be 64 hex characters or the same with a leading backslash-x, as PostgREST and psql print it.
   Output names checks, row indexes and hashes only, never content; input that is not JSON gets one fixed
   message, never the parser's, which quotes the input. Exit 0 when every check passes, 2 when any fails, 1 on
   a usage or input error.

   node scripts/verify-attestation.mjs --row exported-row.json [--release exported-release.json]
   node scripts/verify-attestation.mjs --rows exported-rows.json */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLACEHOLDER } from '../lib/passport/assemble.mjs';
import { gate } from '../lib/passport/gate.mjs';
import { GATE_IDENTITY_SHA256, UPSTREAM_COMMIT } from '../lib/passport/gate-manifest.mjs';

const sha256hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

class InputError extends Error {}

function hex(value, name) {
  if (typeof value !== 'string') throw new InputError(`${name} is not a string`);
  const bare = value.startsWith('\\x') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(bare)) throw new InputError(`${name} is not a 32-byte digest`);
  return bare.toLowerCase();
}

function text(value, name) {
  if (typeof value !== 'string') throw new InputError(`${name} is not a string`);
  return value;
}

/** The checks of one exported row: [{ check, ok, detail }]. Throws InputError for a malformed row. */
export function verifyRow(row, release = null) {
  const content = text(row?.content, 'content');
  const derivedCanonical = text(row?.derived_canonical, 'derived_canonical');
  const contentSha = hex(row?.content_sha256, 'content_sha256');
  const derivedSha = hex(row?.derived_sha256, 'derived_sha256');
  const g = row?.gate;
  const identity = hex(g?.identity_sha256, 'gate.identity_sha256');
  const lock = hex(g?.adapter_lock_sha256, 'gate.adapter_lock_sha256');
  const manifest = hex(g?.manifest_sha256, 'gate.manifest_sha256');
  const version = text(g?.validator_version, 'gate.validator_version');
  const upstream = text(g?.upstream_commit, 'gate.upstream_commit');

  const out = [];
  const record = (check, ok, detail = '') => out.push({ check, ok, detail });
  const actualContent = sha256hex(content);
  const actualDerived = sha256hex(derivedCanonical);
  record(
    'content_sha256 matches content',
    actualContent === contentSha,
    `stored ${contentSha.slice(0, 16)}, computed ${actualContent.slice(0, 16)}`,
  );
  record(
    'derived_sha256 matches derived_canonical',
    actualDerived === derivedSha,
    `stored ${derivedSha.slice(0, 16)}, computed ${actualDerived.slice(0, 16)}`,
  );
  const recomputed = sha256hex(`${lock}\n${version}\n${manifest}`);
  record(
    'the registered identity reproduces from its components',
    recomputed === identity,
    `identity ${identity.slice(0, 16)}`,
  );

  if (identity !== GATE_IDENTITY_SHA256) {
    record(
      'replayable at this checkout',
      false,
      `row identity ${identity} (upstream ${upstream}); this checkout is ${GATE_IDENTITY_SHA256} (upstream ${UPSTREAM_COMMIT}); check out a revision whose lib/passport/gate-manifest.mjs has the row identity`,
    );
    return out;
  }
  record('replayable at this checkout', true, `identity ${identity.slice(0, 16)}`);

  let validatedAt = null;
  try {
    validatedAt = JSON.parse(derivedCanonical).validated_at;
  } catch {
    validatedAt = null;
  }
  let result;
  try {
    result = gate(Buffer.from(content, 'utf8'), 'text/markdown', { validatedAt });
  } catch {
    record('replay verdict passes', false, 'derived_canonical carries no usable validated_at');
    return out;
  }
  record(
    'replay verdict passes',
    result.ok,
    result.ok ? '' : `refused ${result.problems.map((p) => `${p.code}@${p.line}`).join(', ')}`,
  );
  if (result.ok) {
    record(
      'replay text is byte-equal to content',
      result.text === content,
      `computed ${result.contentSha256.slice(0, 16)}`,
    );
    record(
      'replay derived record is byte-equal to derived_canonical',
      result.derivedCanonical === derivedCanonical,
      `computed ${result.derivedSha256.slice(0, 16)}`,
    );
  }

  if (release) {
    const installer = text(release.installer_text, 'release.installer_text');
    const assembledSha = hex(release.assembled_sha256, 'release.assembled_sha256');
    const assembled = content.split(PLACEHOLDER).join(installer);
    const actual = sha256hex(assembled);
    record('release assembled_sha256 matches the splice', actual === assembledSha, `computed ${actual.slice(0, 16)}`);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const rows = [];
  let release = null;
  try {
    for (let i = 0; i < args.length; i++) {
      const read = () => {
        const raw = readFileSync(resolve(args[++i]), 'utf8');
        try {
          return JSON.parse(raw);
        } catch {
          /* Never the parser's message: Node quotes part of the input in it (E3a critique F4). */
          throw new InputError('an input file is not valid JSON');
        }
      };
      if (args[i] === '--row') rows.push(read());
      else if (args[i] === '--rows') {
        const list = read();
        if (!Array.isArray(list)) throw new InputError('--rows expects a JSON array');
        rows.push(...list);
      } else if (args[i] === '--release') release = read();
      else throw new InputError(`unknown argument ${args[i]}`);
    }
    if (rows.length === 0) throw new InputError('no --row or --rows given');
    if (release && rows.length !== 1) throw new InputError('--release verifies exactly one --row');
    let failed = 0;
    rows.forEach((row, index) => {
      for (const { check, ok, detail } of verifyRow(row, release)) {
        if (!ok) failed++;
        process.stdout.write(`${ok ? 'PASS' : 'FAIL'} row ${index}: ${check}${detail ? ` (${detail})` : ''}\n`);
      }
    });
    process.stdout.write(`verify-attestation: ${rows.length} row(s), ${failed} failed check(s)\n`);
    return failed === 0 ? 0 : 2;
  } catch (e) {
    process.stderr.write(`verify-attestation: ${e instanceof InputError ? e.message : 'unreadable input'}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
