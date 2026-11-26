#!/usr/bin/env node
/* Installer text manifest generator (E4 design 1.8 and 2.6 item 4).

   For each target of lib/passport/assemble.mjs BRANCHES, in that order: the exact text installerText(root,
   '<target>.md') produces over the vendored tree, its UTF-8 length, SHA-256 over its UTF-8 bytes (what the
   app.installer_texts trigger computes from the column), and SHA-256 over the bytes on disk of the three files it is
   made from: the installer core, the target's branch and the judge prompt. Those files are found in assemble.mjs's own
   LAYOUTS order. That module does not export the order, and it cannot be edited here without changing the gate identity
   (assemble.mjs is on the gate graph), so this script repeats the order and then proves it read what the assembler
   read: the text must begin with the core as the assembler strips it, carry the judge appendix the assembler builds,
   and end with the branch. A layout that disagrees refuses, rather than register a wrong component hash.

   The gate these texts are registered under is the identity scripts/gate-manifest.mjs computes for the same tree, so
   a stale gate manifest and a stale installer manifest are two separate refusals, never one silent mismatch.

   Output, lib/passport/installer-manifest.mjs:
     GATE_IDENTITY_SHA256  the gate identity the four texts belong to
     INSTALLER_TEXTS       one frozen row per target: target, bytes, textSha256, coreSha256, branchSha256, judgeSha256
   Modes:
     (none)        write lib/passport/installer-manifest.mjs
     --out <path>  write the module to another path
     --check       regenerate into .scratch/check/installer-manifest/ and exit 2 on any byte difference from the
                   committed module; this is the scripts/check.sh gate beside E3's gate-manifest --check
     --sql         print the SQL that registers the four texts for this gate identity, one installer.register audit
                   row each, and a check that fails the migration when the database's own hashes and lengths differ
                   from these
   Exit 0 clean, 2 on a difference or a refused tree. --root <dir> reads another tree (tests). */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BRANCHES, installerText, judgePrompt, pyRstrip, readText } from '../lib/passport/assemble.mjs';
import { manifest as gateManifest } from './gate-manifest.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = 'lib/passport/installer-manifest.mjs';
export const VENDOR = 'vendor/passport';
/* app.installer_texts.text: check (octet_length(text) between 1 and 131072). */
export const MAX_TEXT_BYTES = 131072;
/* The dollar-quote tag the registration SQL wraps each text in; a text that contains it is refused. */
export const SQL_TAG = '$installer_text$';

/* assemble.mjs LAYOUTS, repeated in its order (see the header for why, and for the check that holds it). */
const LAYOUTS = Object.freeze({
  core: ['installer/core.md', 'references/installer-core.md'],
  branch_dir: ['installer/branches', 'references/installer-branches'],
  judge: ['verification/judge-prompt.md', 'references/judge-prompt.md'],
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function located(vendor, key) {
  const rel = LAYOUTS[key].find((r) => existsSync(join(vendor, r)));
  if (rel === undefined) throw new Error(`installer-texts: no ${key} under ${vendor}`);
  return join(vendor, rel);
}

/** Every value the generated module and the registration SQL hold, computed from the tree at root. Each row also
    carries the text itself, which the module does not. Throws when a text or a component cannot be registered. */
export async function installerManifest(root = REPO_ROOT) {
  const vendor = join(root, VENDOR);
  const core = located(vendor, 'core');
  const judge = located(vendor, 'judge');
  const branchDir = located(vendor, 'branch_dir');
  const coreText = pyRstrip(readText(core));
  const judgeText = judgePrompt(vendor);
  if (judgeText === null) throw new Error('installer-texts: the judge prompt yields no appendix');
  const texts = [];
  for (const target of BRANCHES) {
    const branch = join(branchDir, `${target}.md`);
    if (!existsSync(branch)) throw new Error(`installer-texts: no branch ${target}`);
    const warnings = [];
    const text = installerText(vendor, `${target}.md`, (w) => warnings.push(w));
    if (warnings.length > 0) throw new Error(`installer-texts: ${target}: ${warnings[0]}`);
    const expected = `${coreText}\n\n${judgeText}\n\n${pyRstrip(readText(branch))}\n`;
    if (text !== expected)
      throw new Error(`installer-texts: ${target}: the text is not core, judge and branch as read`);
    if (!text.isWellFormed() || text.includes(String.fromCharCode(0)))
      throw new Error(`installer-texts: ${target}: the text cannot be stored as PostgreSQL text`);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes < 1 || bytes > MAX_TEXT_BYTES) throw new Error(`installer-texts: ${target}: ${bytes} bytes`);
    if (text.includes(SQL_TAG)) throw new Error(`installer-texts: ${target}: the text contains ${SQL_TAG}`);
    texts.push({
      target,
      text,
      bytes,
      textSha256: sha256(Buffer.from(text, 'utf8')),
      coreSha256: sha256(readFileSync(core)),
      branchSha256: sha256(readFileSync(branch)),
      judgeSha256: sha256(readFileSync(judge)),
    });
  }
  const { gateIdentitySha256 } = await gateManifest(root);
  return { gateIdentitySha256, texts };
}

/** The generated module's exact bytes, formatted as Biome formats them. */
export function render(m) {
  const rows = m.texts
    .map(
      (t) => `  Object.freeze({
    target: '${t.target}',
    bytes: ${t.bytes},
    textSha256: '${t.textSha256}',
    coreSha256: '${t.coreSha256}',
    branchSha256: '${t.branchSha256}',
    judgeSha256: '${t.judgeSha256}',
  }),`,
    )
    .join('\n');
  return `/* GENERATED by scripts/installer-texts.mjs from lib/passport/assemble.mjs installerText() over ${VENDOR}. Do not edit
   by hand: scripts/check.sh regenerates it and fails on any byte difference (E4 design 2.6 item 4). One row per target
   of BRANCHES: the text's UTF-8 length and SHA-256, and the SHA-256 of the core, branch and judge files on disk. */

export const GATE_IDENTITY_SHA256 = '${m.gateIdentitySha256}';
export const INSTALLER_TEXTS = Object.freeze([
${rows}
]);
`;
}

/** The SQL that registers the four texts for this gate identity: one insert, one installer.register audit row per text
    (actor_kind system), then a check that the rows the database now holds carry exactly these hashes and lengths, so a
    literal altered in transport fails the migration instead of registering. The text hash is recomputed by the table's
    trigger, which overwrites the supplied value; the check compares that recomputation with Node's. An absent gate
    identity inserts nothing and fails the same check. */
export function registrationSql(m) {
  const values = m.texts
    .map(
      (t) =>
        `    ('${t.target}', ${SQL_TAG}${t.text}${SQL_TAG},\n     '${t.textSha256}', '${t.coreSha256}', '${t.branchSha256}', '${t.judgeSha256}')`,
    )
    .join(',\n');
  const expected = m.texts.map((t) => `           ('${t.target}', '${t.textSha256}', ${t.bytes})`).join(',\n');
  return `with g as (
  select id, identity_sha256 from app.gate_identities where identity_sha256 = decode('${m.gateIdentitySha256}', 'hex')
), t as (
  insert into app.installer_texts (gate_id, target, text, text_sha256, core_sha256, branch_sha256, judge_sha256)
  select g.id, v.target, v.text, decode(v.text_sha256, 'hex'), decode(v.core_sha256, 'hex'),
         decode(v.branch_sha256, 'hex'), decode(v.judge_sha256, 'hex')
    from g, (values
${values}
    ) as v (target, text, text_sha256, core_sha256, branch_sha256, judge_sha256)
  returning gate_id, target, text_sha256
)
select app.audit(null, null, 'system', 'installer.register', 'installer_text', t.gate_id,
                 jsonb_build_object('gate_identity_sha256', encode(g.identity_sha256, 'hex'), 'release_target', t.target,
                                    'installer_text_sha256', encode(t.text_sha256, 'hex')))
  from t join g on g.id = t.gate_id;
do $registered$
begin
  if (select count(*) from app.installer_texts i join app.gate_identities g on g.id = i.gate_id
       where g.identity_sha256 = decode('${m.gateIdentitySha256}', 'hex')
         and (i.target, encode(i.text_sha256, 'hex'), octet_length(i.text)) in (values
${expected}
         )) <> ${m.texts.length} then
    raise exception 'installer text registration differs from ${OUTPUT}';
  end if;
end $registered$;
`;
}

async function main() {
  const args = process.argv.slice(2);
  let root = REPO_ROOT;
  let out = null;
  let mode = 'write';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') root = resolve(args[++i]);
    else if (args[i] === '--out') out = resolve(args[++i]);
    else if (args[i] === '--check') mode = 'check';
    else if (args[i] === '--sql') mode = 'sql';
    else {
      process.stderr.write(`installer-texts: unknown argument ${args[i]}\n`);
      return 2;
    }
  }
  let m;
  try {
    m = await installerManifest(root);
  } catch (e) {
    process.stdout.write(`REFUSE ${e.message}\n`);
    return 2;
  }
  if (mode === 'sql') {
    process.stdout.write(registrationSql(m));
    return 0;
  }
  const bytes = render(m);
  const summary = m.texts.map((t) => `${t.target} ${t.bytes}`).join(', ');
  if (mode === 'check') {
    const dir = join(root, '.scratch', 'check', 'installer-manifest');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'installer-manifest.mjs'), bytes);
    const committedPath = join(root, OUTPUT);
    const committed = existsSync(committedPath) ? readFileSync(committedPath, 'utf8') : null;
    if (committed !== bytes) {
      process.stdout.write(`REFUSE ${OUTPUT} is stale: regenerated ${summary}; run node scripts/installer-texts.mjs\n`);
      return 2;
    }
    process.stdout.write(`installer-texts: ${summary}, gate ${m.gateIdentitySha256}, committed module matches\n`);
    return 0;
  }
  const target = out ?? join(root, OUTPUT);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  process.stdout.write(`installer-texts: wrote ${target}, ${summary}, gate ${m.gateIdentitySha256}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
