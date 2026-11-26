/* The owner-side whole-company copy (E7 design 1.2, corrections E7D-C-F8 and E7D-C-F12).
 *
 * NAMES FIRST, because this module's is not the word a person reads. scripts/check-imports.mjs rule 7 refuses one
 * token anywhere under lib/ and netlify/ outside a module-reference line, comments and string literals included,
 * and it is the word E6's design uses for this whole idea. The lead decided on 2026-09-17 that the NAMES move and
 * the gate does not, so lib/services/takeout.mjs is the admin's own route's module and this is the operator's; the
 * DATABASE names are unchanged, because SQL is not scanned by that gate, and so is the word on the page and in the
 * script's own name, which lives under scripts/ and is outside the gate's reach.
 *
 * WHAT IS HERE. The section list with its column lists and orders, the snapshot's SQL, the streaming document
 * writer over an injected sink, the completeness comparison, and the rules about where an owner-side output file
 * may be written. NO credential, NO child process, NO database client: the script under scripts/ whose name is the
 * word this file may not spell opens the owner connection and owns every byte that reaches a disk, exactly as
 * scripts/sweep-accounts.mjs does for the sweep.
 *
 * WHAT THIS PRODUCES AND WHY IT IS NOT THE ROUTE'S DOCUMENT. api.export_company is a company ADMINISTRATOR's own
 * copy and there is no operator arm of it, by E6D-C-F1a: the operator keeps the register and a counts-only
 * manifest and never the rows. This script serves the customer the route cannot: a company above the route's
 * ceiling, a suspended company whose administrator cannot sign in, or a closed one. It therefore emits the
 * UNFILTERED tenant, and the document says so in a key the route's does not have, `authority`, so a reader who
 * finds it knows the file is the whole tenant and under what it was taken.
 *
 * THE TWO NAMED DIFFERENCES FROM api.export_company AND NO OTHERS, each marked in SECTIONS below:
 *   1. access_periods is SELECTED rather than emitted empty, and `omitted` loses that name.
 *   2. candidate_versions and candidate_contributors drop app.export_candidate_visible, so another author's
 *      unsubmitted draft and its contributor rows ARE in the file; `withheld` is {} and is still present.
 * Everything else, column for column and order for order, is the routine's, and tests/e7/unit/takeout-text.test.mjs
 * reads both out of migration 008's own text and compares them, so a later change to the routine that this list
 * does not follow fails the check rather than producing a copy that is quietly not the tenant (case E7-10).
 *
 * ONE SNAPSHOT. The sections and the counts they are checked against are read in ONE repeatable-read read-only
 * transaction, so the copy is of one moment and the completeness check compares like with like. The cost, which
 * belongs here rather than in a surprise: a long snapshot holds back vacuum for the whole database while it runs
 * (section 6 C2 measures it); no write is blocked by it.
 *
 * MEMORY HOLDS ONE ROW AT A TIME. Every row leaves psql as one line of to_jsonb(x)::text, which JSON escaping
 * keeps free of raw line breaks, and each section is preceded by a marker line that cannot begin a JSON object.
 * The writer appends each row as it arrives and never assembles a section, let alone the document: a 250 MB
 * tenant costs one row of memory. That is the whole reason this is a script and not a routine (E6D-C-F8: the
 * accepted adapter has no streaming contract and buffers an RPC answer twice inside the function, which is why
 * the route has a ceiling at all).
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REF = /^[A-Za-z0-9._:/-]{1,80}$/;

/** A refusal of this module. Its message names the RULE and never a value (design 3.5). */
export class TakeoutError extends Error {
  constructor(rule, where = {}) {
    const at = Object.entries(where)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    super(at ? `takeout: ${rule} (${at})` : `takeout: ${rule}`);
    this.name = 'TakeoutError';
    this.rule = rule;
    Object.assign(this, where);
  }
}

/** The marker before each section's rows. It cannot begin a JSON object, so no row can be mistaken for one. */
export const SECTION_MARK = '@section ';
/** The marker before the one-line header the snapshot reads first (the company row and the counts). */
export const HEAD_MARK = '@head ';

/* The twenty-one sections, in the document's order, which is app.export_section_names()'s order. Each `select`
   is api.export_company's own for that section, whitespace-normalised to one line, with `c.id` left in place as
   the company's own reference; sectionSql substitutes a validated uuid for it. */
export const SECTIONS = Object.freeze(
  [
    /* THE FIRST NAMED DIFFERENCE. api.export_company emits this section as '[]'::jsonb, because no policy
     admits authenticated to app.access_periods and including it would answer E6's design question 3 by the back
     door. The owner-side copy is the WHOLE tenant for a customer who cannot take it themselves, so the agreement
     and its four dates belong in it, and `omitted` loses this name in exchange (design 1.2). */
    {
      name: 'access_periods',
      select:
        'select company_id, invoice_ref, starts_at, ends_at, export_by, delete_by, created_at, updated_at from app.access_periods where company_id = c.id order by company_id',
    },
    {
      name: 'company_quotas',
      select:
        'select company_id, name, value, updated_at from app.company_quotas where company_id = c.id order by name',
    },
    {
      name: 'memberships',
      select:
        'select id, company_id, user_id, status, roles, created_at, removed_at from app.memberships where company_id = c.id order by created_at, id',
    },
    {
      name: 'invitations',
      select:
        'select id, company_id, email_normalized, roles, expires_at, created_by, created_by_operator, created_at, accepted_membership_id, accepted_at, revoked_at from app.invitations where company_id = c.id order by created_at, id',
    },
    {
      name: 'profiles',
      select:
        'select f.user_id, f.display_name, f.updated_at from app.profiles f where exists (select 1 from app.memberships m where m.company_id = c.id and m.user_id = f.user_id) order by f.user_id',
    },
    {
      name: 'groups',
      select:
        'select id, company_id, name, created_by_membership_id, created_at from app.groups where company_id = c.id order by name',
    },
    {
      name: 'group_members',
      select:
        'select group_id, company_id, membership_id, added_by_membership_id, added_at from app.group_members where company_id = c.id order by group_id, membership_id',
    },
    {
      name: 'agents',
      select:
        'select id, company_id, name, creator_membership_id, owner_membership_id, status, created_at from app.agents where company_id = c.id order by name',
    },
    /* THE SECOND NAMED DIFFERENCE, one of its two halves: app.export_candidate_visible(v.id, me.id) is dropped.
     The route runs as a calling ADMINISTRATOR and must withhold another author's unsubmitted draft, which is E1
     section 6's rule. This script has no calling administrator at all: it runs as the infrastructure maintainer
     for a customer who cannot take their own copy, and a copy that silently dropped one author's drafts would
     not be the tenant. `withheld` is therefore {} and stays present, and `authority` says what it ran under. */
    {
      name: 'candidate_versions',
      select:
        "select id, company_id, agent_id, sequence, state, version, author_membership_id, supersedes_candidate_id, content, encode(content_sha256, 'hex') as content_sha256, derived_canonical, encode(derived_sha256, 'hex') as derived_sha256, derived, gate_id, validated_at, attested_by, attested_at, submitted_at, submitted_by_membership_id, source_platform, confidence, permitted_data, dependencies from app.candidate_versions v where v.company_id = c.id order by agent_id, sequence, version",
    },
    /* THE SECOND NAMED DIFFERENCE, one of its two halves: app.export_candidate_visible(v.id, me.id) is dropped.
     The route runs as a calling ADMINISTRATOR and must withhold another author's unsubmitted draft, which is E1
     section 6's rule. This script has no calling administrator at all: it runs as the infrastructure maintainer
     for a customer who cannot take their own copy, and a copy that silently dropped one author's drafts would
     not be the tenant. `withheld` is therefore {} and stays present, and `authority` says what it ran under. */
    {
      name: 'candidate_contributors',
      select:
        'select cc.id, cc.candidate_id, cc.membership_id, cc.kind, cc.display_name, cc.inherited_from_candidate_id, cc.observed, cc.created_at from app.candidate_contributors cc join app.candidate_versions v on v.id = cc.candidate_id where v.company_id = c.id order by cc.candidate_id, cc.id',
    },
    {
      name: 'review_envelopes',
      select:
        "select id, company_id, agent_id, candidate_id, revision, encode(content_sha256, 'hex') as content_sha256, encode(derived_sha256, 'hex') as derived_sha256, gate_id, encode(gate_identity_sha256, 'hex') as gate_identity_sha256, target, encode(installer_text_sha256, 'hex') as installer_text_sha256, encode(core_sha256, 'hex') as core_sha256, encode(branch_sha256, 'hex') as branch_sha256, encode(judge_sha256, 'hex') as judge_sha256, policy_id, encode(policy_sha256, 'hex') as policy_sha256, assembled_bytes, audience_group_ids, envelope_canonical, encode(envelope_sha256, 'hex') as envelope_sha256, created_by_membership_id, created_at from app.review_envelopes where company_id = c.id order by candidate_id, revision",
    },
    {
      name: 'reviews',
      select:
        'select id, company_id, candidate_id, envelope_id, role, decision, reviewer_membership_id, reason, created_at from app.reviews where company_id = c.id order by created_at, id',
    },
    {
      name: 'releases',
      select:
        "select id, company_id, agent_id, candidate_id, envelope_id, target, gate_id, encode(content_sha256, 'hex') as content_sha256, encode(derived_sha256, 'hex') as derived_sha256, encode(installer_text_sha256, 'hex') as installer_text_sha256, encode(core_sha256, 'hex') as core_sha256, encode(branch_sha256, 'hex') as branch_sha256, encode(judge_sha256, 'hex') as judge_sha256, policy_id, encode(policy_sha256, 'hex') as policy_sha256, audience_group_ids, encode(envelope_sha256, 'hex') as envelope_sha256, assembled_content, encode(assembled_sha256, 'hex') as assembled_sha256, assembled_bytes, state, published_by_membership_id, published_at, superseded_by_release_id, superseded_at, withdrawn_by_membership_id, withdrawn_at, withdrawal_reason from app.releases where company_id = c.id order by published_at, id",
    },
    {
      name: 'release_downloads',
      select:
        'select id, company_id, release_id, membership_id, authorized_at from app.release_downloads where company_id = c.id order by authorized_at, id',
    },
    {
      name: 'installation_reports',
      select:
        'select id, company_id, release_id, membership_id, status, losses, assistance, source, reported_at from app.installation_reports where company_id = c.id order by reported_at, id',
    },
    {
      name: 'installation_witnesses',
      select:
        'select id, company_id, report_id, release_id, witness_membership_id, witness_role, status, note, witnessed_at from app.installation_witnesses where company_id = c.id order by witnessed_at, id',
    },
    {
      name: 'audit_events',
      select:
        'select id, company_id, actor_user_id, actor_kind, action, entity_type, entity_id, details, at from app.audit_events where company_id = c.id order by at, id',
    },
    {
      name: 'release_targets',
      select:
        'select t.target, t.publishable, t.registered_at from app.release_targets t where t.target in (select r.target from app.releases r where r.company_id = c.id union select e.target from app.review_envelopes e where e.company_id = c.id) order by t.target',
    },
    {
      name: 'installer_texts',
      select:
        "select it.gate_id, it.target, it.text, encode(it.text_sha256, 'hex') as text_sha256, encode(it.core_sha256, 'hex') as core_sha256, encode(it.branch_sha256, 'hex') as branch_sha256, encode(it.judge_sha256, 'hex') as judge_sha256 from app.installer_texts it where (it.gate_id, it.target) in (select r.gate_id, r.target from app.releases r where r.company_id = c.id union select e.gate_id, e.target from app.review_envelopes e where e.company_id = c.id) order by it.gate_id, it.target",
    },
    {
      name: 'release_policies',
      select:
        "select pol.id, pol.version, pol.canonical, encode(pol.sha256, 'hex') as sha256, pol.active, pol.registered_at from app.release_policies pol where pol.id in (select r.policy_id from app.releases r where r.company_id = c.id union select e.policy_id from app.review_envelopes e where e.company_id = c.id) order by pol.version",
    },
    {
      name: 'gate_identities',
      select:
        "select gi.id, encode(gi.identity_sha256, 'hex') as identity_sha256, encode(gi.adapter_lock_sha256, 'hex') as adapter_lock_sha256, gi.validator_version, encode(gi.manifest_sha256, 'hex') as manifest_sha256, gi.upstream_commit, gi.registered_at, gi.active from app.gate_identities gi where gi.id in (select v.gate_id from app.candidate_versions v where v.company_id = c.id union select r.gate_id from app.releases r where r.company_id = c.id union select e.gate_id from app.review_envelopes e where e.company_id = c.id) order by gi.registered_at, gi.id",
    },
  ].map(Object.freeze),
);

export const SECTION_NAMES = Object.freeze(SECTIONS.map((s) => s.name));

/* The route's `omitted` list MINUS access_periods, which this copy carries (design 1.2). These are the things no
   copy of a tenant contains, each for a reason: a live invitation's token hash is a credential; idempotency keys
   are a replay ledger and not the customer's records; auth.users, operators, operator_allowlist,
   mfa_attempt_windows and gate_identity_files are Phaeacia's or the platform's and not this company's. */
export const OMITTED = Object.freeze([
  'invitations.token_hash',
  'idempotency_keys',
  'auth.users',
  'operators',
  'operator_allowlist',
  'mfa_attempt_windows',
  'gate_identity_files',
]);

/** The one reason code an owner-side copy runs under. There is no other (design 1.2 step 3). */
export const REASON_CODE = 'customer_instruction';

export const isUuid = (v) => typeof v === 'string' && UUID.test(v);
export const isRef = (v) => typeof v === 'string' && REF.test(v);

// ---------------------------------------------------------------------------
// The snapshot's SQL.
// ---------------------------------------------------------------------------

/* The routine's reference to the company row it locked. Replacing it needs a LEFT BOUNDARY: candidate_contributors
   selects `cc.id`, which ends in the same three characters, and a plain substring replacement turned it into
   `c'<uuid>'::uuid` and made the whole snapshot fail with 42704, "type c does not exist" (observed 2026-09-20
   against the local stack). The boundary is any character that cannot be part of an identifier or a qualifier. */
const COMPANY_REF = /(^|[^A-Za-z0-9_.])c\.id\b/g;

/** One section's select, with the company's own uuid in place of the routine's `c.id`. */
export function sectionSql(name, companyId) {
  if (!isUuid(companyId)) throw new TakeoutError('a company id is a lowercase uuid');
  const section = SECTIONS.find((s) => s.name === name);
  if (section === undefined) throw new TakeoutError('unknown section', { name });
  return section.select.replace(COMPANY_REF, (_, before) => `${before}'${companyId}'::uuid`);
}

/**
 * snapshotSql(companyId) -> the whole psql script for one copy.
 *
 * ONE session, ONE transaction: begin repeatable read read only, the header (the company row and
 * app.export_section_counts, which counts the WHOLE company unfiltered and is the same function the operator's
 * manifest reads), then the twenty-one sections each behind its marker, then commit. Read only, so nothing here
 * can write whatever else is in the operator's command.
 */
export function snapshotSql(companyId) {
  if (!isUuid(companyId)) throw new TakeoutError('a company id is a lowercase uuid');
  const id = `'${companyId}'::uuid`;
  const parts = [
    'begin isolation level repeatable read read only;',
    `select '${HEAD_MARK}' || jsonb_build_object(` +
      `'company', (select to_jsonb(x) from (select id, slug, name, status, created_at from app.companies where id = ${id}) x),` +
      `'counts', app.export_section_counts(${id}))::text;`,
  ];
  for (const section of SECTIONS) {
    parts.push(`select '${SECTION_MARK}${section.name}';`);
    parts.push(`select to_jsonb(x)::text from (${sectionSql(section.name, companyId)}) x;`);
  }
  parts.push('commit;');
  return `${parts.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// The streaming writer.
// ---------------------------------------------------------------------------

/* A row as psql hands it over: one line of to_jsonb(x)::text. The check is structural and cheap on purpose, so
   that peak memory and throughput stay what streaming promises; what proves the copy is COMPLETE is the counts
   comparison against app.export_section_counts in the same snapshot, and what proves the FILE is the one handed
   over is its SHA-256 in the register line. A line that is not a row at all fails this. */
const looksLikeRow = (line) => line.length > 1 && line.startsWith('{') && line.endsWith('}');

/**
 * makeDocument({ sink, company, counts, exportedAt, instructionRef, operatorUserId }) -> a writer.
 *
 * `sink` is one call, sink.write(text). The writer never holds a section, only the counts it has accumulated, so
 * the document may be any size. The key order is the route's, and `counts` comes AFTER `sections` for exactly
 * that reason: it is computed from what was actually written, not from what was expected.
 */
export function makeDocument({ sink, company, exportedAt, instructionRef, operatorUserId }) {
  if (typeof sink?.write !== 'function') throw new TakeoutError('a sink is one call, write(text)');
  if (company === null || typeof company !== 'object' || !isUuid(company.id))
    throw new TakeoutError('the company row is the snapshot’s, with its id');
  if (!isRef(instructionRef)) throw new TakeoutError('an instruction reference matches ^[A-Za-z0-9._:/-]{1,80}$');
  if (!isUuid(operatorUserId)) throw new TakeoutError('an operator id is a lowercase uuid');
  const counts = {};
  let section = null;
  let rowsInSection = 0;
  let sections = 0;
  let began = false;
  let ended = false;
  return {
    counts,
    begin() {
      if (began) throw new TakeoutError('the document was already begun');
      began = true;
      sink.write(
        `{"exportedAt":${JSON.stringify(exportedAt)},"schemaVersion":1,` +
          `"company":${JSON.stringify(company)},"sections":{`,
      );
    },
    beginSection(name) {
      if (!began || ended) throw new TakeoutError('a section outside the document');
      if (section !== null) throw new TakeoutError('a section inside a section', { name });
      if (!SECTION_NAMES.includes(name)) throw new TakeoutError('unknown section', { name });
      if (Object.hasOwn(counts, name)) throw new TakeoutError('a section twice', { name });
      if (name !== SECTION_NAMES[sections]) throw new TakeoutError('sections out of order', { name });
      sink.write(`${sections === 0 ? '' : ','}${JSON.stringify(name)}:[`);
      section = name;
      rowsInSection = 0;
    },
    row(line) {
      if (section === null) throw new TakeoutError('a row outside a section');
      if (!looksLikeRow(line)) throw new TakeoutError('a row is one JSON object on one line', { section });
      sink.write(rowsInSection === 0 ? line : `,${line}`);
      rowsInSection += 1;
    },
    endSection() {
      if (section === null) throw new TakeoutError('no section is open');
      sink.write(']');
      counts[section] = rowsInSection;
      sections += 1;
      section = null;
    },
    end() {
      if (section !== null) throw new TakeoutError('a section is still open', { section });
      if (sections !== SECTION_NAMES.length)
        throw new TakeoutError('the document is short of sections', {
          written: sections,
          expected: SECTION_NAMES.length,
        });
      ended = true;
      sink.write(
        `},"counts":${JSON.stringify(counts)},"withheld":{},"omitted":${JSON.stringify(OMITTED)},` +
          `"authority":{"kind":"owner_side","reasonCode":${JSON.stringify(REASON_CODE)},` +
          `"instructionRef":${JSON.stringify(instructionRef)},"operatorUserId":${JSON.stringify(operatorUserId)}}}\n`,
      );
      return { counts, rows: Object.values(counts).reduce((a, b) => a + b, 0) };
    },
  };
}

/**
 * completeness(written, snapshotCounts) -> { ok, problems }
 *
 * Every section's WRITTEN count equals the snapshot's app.export_section_counts, which counts the whole company
 * unfiltered. Both of this copy's named differences make the two agree where the ROUTE's would not: the route
 * withholds another author's draft and emits access_periods empty, and its own `withheld` records the gap. Here
 * there is no gap, so any difference at all means the file is not the tenant, and the caller removes the partial
 * file and exits naming the SECTIONS, never their rows.
 */
export function completeness(written, snapshotCounts) {
  const problems = [];
  /* E8W-F1 (the E8-4 lane's record under evidence/, its withholdings file): the loop below used to walk SECTION_NAMES alone, which is this
     module's own list, so a section dropped from the list (E7-10's mutant) was never asked about, and the operator's copy
     script exited 0 for a copy missing a whole section, with a register line and an audit row claiming it complete. The snapshot's keys are the
     database's list of the whole company (app.export_section_counts); a key the document does not carry is a
     problem named by section, before any count is compared. */
  for (const name of Object.keys(snapshotCounts ?? {}))
    if (!SECTION_NAMES.includes(name))
      problems.push({ section: name, rule: 'the snapshot counted a section this document does not carry' });
  for (const name of SECTION_NAMES) {
    const wrote = written[name];
    const expected = Number(snapshotCounts?.[name]);
    if (!Number.isInteger(wrote)) problems.push({ section: name, rule: 'no rows were written for this section' });
    else if (!Number.isInteger(expected))
      problems.push({ section: name, rule: 'the snapshot counted no such section' });
    else if (wrote !== expected)
      problems.push({ section: name, rule: 'the written count is not the snapshot’s', wrote, expected });
  }
  for (const name of Object.keys(written))
    if (!SECTION_NAMES.includes(name)) problems.push({ section: name, rule: 'a section the document does not have' });
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Where an owner-side file may be written (E7D-C-F8), shared by every owner-side script.
// ---------------------------------------------------------------------------

/**
 * gitWorkTreeAt(dir) -> the path of the nearest Git work tree at or above `dir`, or null.
 * The caller passes a REAL path, so a link into a work tree is caught as well as a path inside one.
 */
export function gitWorkTreeAt(dir) {
  let at = resolve(dir);
  for (;;) {
    if (existsSync(join(at, '.git'))) return at;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/**
 * checkOutputPath(path) -> { path, partial, dir }
 *
 * The rules, each a refusal before anything is opened (design 1.2 step 1, correction E7D-C-F8):
 *   - absolute, because a relative path means something different from every directory;
 *   - it does not exist, and neither does its partial, because this script never writes over a file;
 *   - its directory exists, is a directory, and is not itself a link;
 *   - the REAL path of that directory and of every ancestor carries no .git, because the secrets gate cannot
 *     recognise a tenant's content and a stray commit would push a whole company to the backup remote.
 *
 * WHY THE LINK RULE IS THE FINAL HOP AND NOT EVERY ANCESTOR, a deviation from E7D-C-F8's wording and recorded
 * as one. The correction asks for the real path of the directory and of every ancestor to be checked and for
 * links to be refused. The first half is what does the work and it is kept whole: realpathSync resolves the
 * ENTIRE chain, so a directory reached THROUGH a link into a Git work tree is caught by the .git walk over the
 * real path exactly as a plain path inside one is. Refusing any ancestor that is a link adds nothing to that
 * and costs something real: on macOS /tmp is a link to /private/tmp, so the rule refused every path under
 * os.tmpdir(), which is where the tests write and where an operator's scratch directory usually is. The final
 * hop is still checked, because a directory that IS a link is the one case where the operator may not have
 * meant the place the name reaches.
 */
export function checkOutputPath(path) {
  if (!isAbsolute(path ?? '')) throw new TakeoutError('an output path is absolute');
  const partial = `${path}.partial`;
  if (existsSync(path)) throw new TakeoutError('the output path already exists');
  if (existsSync(partial)) throw new TakeoutError('a partial file of that name already exists');
  const named = dirname(path);
  if (!existsSync(named)) throw new TakeoutError('the output directory does not exist');
  if (lstatSync(named).isSymbolicLink()) throw new TakeoutError('the output directory is a link');
  const dir = realpathSync(named);
  if (!lstatSync(dir).isDirectory()) throw new TakeoutError('the output path’s parent is not a directory');
  const tree = gitWorkTreeAt(dir);
  if (tree !== null)
    throw new TakeoutError('the output path is inside a Git work tree; a tenant’s records never enter Git');
  return { path, partial, dir };
}

/** The file's SHA-256, for the register line. Fed the bytes as they are written, so the file is read once. */
export function hasher() {
  const h = createHash('sha256');
  return { update: (text) => h.update(text, 'utf8'), digest: () => h.digest('hex') };
}
