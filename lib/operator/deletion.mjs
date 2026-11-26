/* The owner-side tenant deletion (E7 design 1.2, correction E7D-C-F12).
 *
 * WHAT IS HERE. The claims statement, the before and after counts, and the comparison of both with the routine's
 * own answer. NO credential, NO child process, NO database client: scripts/delete-company.mjs opens the owner
 * connection, exactly as scripts/sweep-accounts.mjs does for the sweep.
 *
 * IT GOES THROUGH THE ONE DOOR AND NEVER AROUND IT. With --apply, one owner transaction sets the operator's
 * claims and calls api.delete_company(company, slug, reason). EVERY PRECONDITION IS THE ROUTINE'S and is
 * evaluated once, in its order: the company exists, it is closed, the slug matches, and either its access period
 * is past export_by or the reason is customer_instruction; then the bound of app.limit_delete_rows(); then the
 * bypass set inside the routine's own transaction; then eighteen deletes in foreign-key order; then the
 * company.delete audit row with company_id null, written last. This module adds no rule of its own to any of
 * that, and it could not: the routine holds the company lock for the whole of it.
 *
 * ABOVE THE BOUND IT REFUSES, and E6 1.6's handoff of "the script above the bound" is DECLINED. E6 said a
 * deletion above app.limit_delete_rows() "runs from the script over a direct connection". That would need a
 * second body of the one door in this file: the eighteen deletes, the bypass, the preconditions and the audit
 * row, copied, with every drift risk E6 built one door to avoid; or a migration moving the body into an
 * owner-callable helper, which is a Codex-reviewed change to accepted data-destroying code. Neither is worth it
 * for a case outside the plan's envelope: E6 section 6 puts the envelope company at about 80,000 rows and the
 * bound is 500,000, six times that. So the script refuses with the routine's own E_DELETE_TOO_LARGE, section 6's
 * C6 measures the deletion at the bound, and if a real company ever approaches it the remedy is a migration
 * raising the constant to what that measurement supports. THE ONE DOOR STAYS ONE.
 *
 * THE FOUR THINGS THE SCRIPT ADDS THAT THE ROUTE DOES NOT HAVE (design 1.2):
 *   1. --instruction is required when the reason is customer_instruction, with the copy script's reference
 *      shape, and it goes into the REGISTER line. The audit guard has no key for free text and should not have
 *      one, so the reference's home is the register and the company workspace, the two places a restore does not
 *      rewind.
 *   2. The counts before and after, from BOTH SIDES. Before: app.export_section_counts for the sixteen deletion
 *      sections it counts, PLUS owner-side counts of idempotency_keys and of the company row, which are the two
 *      deletion sections the copy's section list does not have (E7D-C-F12 corrected the first version, which
 *      compared all eighteen against the copy's counts and would have failed on every run). After: an owner-side
 *      count of rows carrying that company id in every one of the eighteen tables, which must all be zero.
 *   3. The dry run, which is the DEFAULT: the status, whether the slug matches, app.deletion_state, the
 *      before-counts and their total against app.limit_delete_rows(), and what --apply would answer. Read only.
 *   4. The register line, with the audit id read back, then the new head printed. A TOMBSTONE IS DURABLE ONLY
 *      ONCE ITS LINE IS WRITTEN AND THE HEAD ANCHORED, which is why the script prints the head and the guide
 *      does not let a deletion be reported to a customer as done before then.
 *
 * WHY candidate_contributors IS COUNTED THROUGH IDS CAPTURED BEFORE. That table carries no company_id at all: the
 * routine reaches it through app.candidate_versions. After the deletion there are no candidate rows left to join
 * to, so "how many contributor rows does this company still have" has no answer unless the candidate ids were
 * taken first. They are, in the same read as the before-counts.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const REF = /^[A-Za-z0-9._:/-]{1,80}$/;

/** The three reason codes api.delete_company admits, in its own order (008). */
export const REASON_CODES = Object.freeze(['retention_deadline', 'customer_instruction', 'operator_request']);
/** The one that needs an operator-supplied reference, because its authority is not a date the register holds. */
export const REASON_NEEDING_REFERENCE = 'customer_instruction';

/**
 * The eighteen deletion sections of app.deletion_section_names(), children before parents. Sixteen of them are
 * also copy sections and are counted by app.export_section_counts; the two that are not are named here so that
 * nobody has to rediscover why a comparison of all eighteen against that function fails (E7D-C-F12).
 */
export const DELETION_SECTIONS = Object.freeze([
  'installation_witnesses',
  'installation_reports',
  'release_downloads',
  'releases',
  'reviews',
  'review_envelopes',
  'candidate_contributors',
  'candidate_versions',
  'agents',
  'group_members',
  'groups',
  'idempotency_keys',
  'invitations',
  'audit_events',
  'memberships',
  'access_periods',
  'company_quotas',
  'companies',
]);
/** The two the copy's section list does not have, counted owner-side instead. */
export const SECTIONS_COUNTED_OWNER_SIDE = Object.freeze(['idempotency_keys', 'companies']);

export class DeletionError extends Error {
  constructor(rule, where = {}) {
    const at = Object.entries(where)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    super(at ? `deletion: ${rule} (${at})` : `deletion: ${rule}`);
    this.name = 'DeletionError';
    this.rule = rule;
    Object.assign(this, where);
  }
}

export const isUuid = (v) => typeof v === 'string' && UUID.test(v);
export const isSlug = (v) => typeof v === 'string' && SLUG.test(v);
export const isRef = (v) => typeof v === 'string' && REF.test(v);

/**
 * claimsStatement(operatorId) -> the statement that makes an owner session act as a named operator.
 *
 * api.delete_company and the other operator routines derive their actor from app.operator_actor(), which reads
 * request.jwt.claims (001). An owner session sets that setting FOR ITS OWN TRANSACTION, which is how
 * tests/db/30-deletion.sh already measures the routine owner-side and how this script reuses the one door
 * instead of copying it.
 *
 * THE DISCLOSURE THIS ADDS, stated rather than hidden: WHOEVER HOLDS THE OWNER CONNECTION CAN ACT AS ANY
 * REGISTERED OPERATOR AND BYPASS THE SECOND FACTOR the routine asks for. That is already true (the owner can do
 * anything, E2 section 5), and the audit row records the operator the runner named. The control is the
 * credential's custody, in the operator guide, and not the routine.
 */
export function claimsStatement(operatorId) {
  if (!isUuid(operatorId)) throw new DeletionError('an operator id is a lowercase uuid');
  const claims = JSON.stringify({ role: 'app_server', sub: operatorId, aal: 'aal2' });
  return `select set_config('request.jwt.claims', '${claims}', true);`;
}

/**
 * beforeSql(companyId, mark) -> the read-only statement for everything the dry run and the apply need first.
 *
 * One repeatable-read read-only transaction: the company row, app.deletion_state, the sixteen copy-counted
 * sections from app.export_section_counts, the two counted owner-side, the row total the routine will compute,
 * the bound, and the candidate ids contributor rows are reached through after the candidates are gone.
 */
export function beforeSql(companyId, mark) {
  if (!isUuid(companyId)) throw new DeletionError('a company id is a lowercase uuid');
  const id = `'${companyId}'::uuid`;
  return `begin isolation level repeatable read read only;
select '${mark}' || jsonb_build_object(
  'company', (select to_jsonb(x) from (select id, slug, status from app.companies where id = ${id}) x),
  'deletionState', app.deletion_state(${id}),
  'limit', app.limit_delete_rows(),
  'sectionCounts', app.export_section_counts(${id}),
  'idempotencyKeys', (select count(*) from app.idempotency_keys i
                       where i.membership_id in (select m.id from app.memberships m where m.company_id = ${id})),
  'companies', (select count(*) from app.companies c where c.id = ${id}),
  'candidateIds', coalesce((select jsonb_agg(v.id) from app.candidate_versions v where v.company_id = ${id}), '[]'::jsonb))::text;
commit;
`;
}

/**
 * beforeCounts(read) -> { counts, total } over all eighteen deletion sections.
 * The sixteen the copy counts come from app.export_section_counts; the two it does not are the owner-side reads.
 * `total` is the routine's own sum: the deletion sections it counts, plus the idempotency keys, plus one for the
 * company row, which is exactly how api.delete_company computes the number it compares with its bound.
 */
export function beforeCounts(read) {
  const counts = {};
  for (const section of DELETION_SECTIONS) {
    if (section === 'idempotency_keys') counts[section] = Number(read.idempotencyKeys);
    else if (section === 'companies') counts[section] = Number(read.companies);
    else counts[section] = Number(read.sectionCounts?.[section]);
    if (!Number.isInteger(counts[section])) throw new DeletionError('a section was not counted', { section });
  }
  const total = DELETION_SECTIONS.reduce((sum, section) => sum + counts[section], 0);
  return { counts, total };
}

/**
 * afterSql(companyId, candidateIds, mark) -> the read-only statement that counts what is LEFT.
 * Every one of the eighteen tables, by the company's id, and candidate_contributors through the candidate ids
 * captured before, because that table carries no company_id and its candidates are gone.
 */
export function afterSql(companyId, candidateIds, mark) {
  if (!isUuid(companyId)) throw new DeletionError('a company id is a lowercase uuid');
  if (!Array.isArray(candidateIds) || !candidateIds.every(isUuid))
    throw new DeletionError('the candidate ids are lowercase uuids captured before the deletion');
  const id = `'${companyId}'::uuid`;
  const ids = candidateIds.length === 0 ? "'{}'::uuid[]" : `array['${candidateIds.join("','")}']::uuid[]`;
  const byCompany = (table) => `(select count(*) from app.${table} t where t.company_id = ${id})`;
  const pairs = DELETION_SECTIONS.map((section) => {
    if (section === 'companies') return `'companies', (select count(*) from app.companies c where c.id = ${id})`;
    if (section === 'candidate_contributors')
      return `'candidate_contributors', (select count(*) from app.candidate_contributors cc where cc.candidate_id = any (${ids}))`;
    if (section === 'idempotency_keys')
      return `'idempotency_keys', (select count(*) from app.idempotency_keys i where i.membership_id in (select m.id from app.memberships m where m.company_id = ${id}))`;
    return `'${section}', ${byCompany(section)}`;
  });
  return `begin isolation level repeatable read read only;
select '${mark}' || jsonb_build_object(${pairs.join(', ')})::text;
commit;
`;
}

/**
 * compare({ before, deleted, after }) -> { ok, problems }
 *
 * Three facts, each a refusal:
 *   - the routine's own `deleted` answer equals the before-counts, SECTION BY SECTION, so the routine deleted
 *     what was there and not what it expected to be there;
 *   - every after-count is zero, in all eighteen tables;
 *   - no section is missing from either side.
 * A problem names the SECTION and the two numbers, never a row.
 */
export function compare({ before, deleted, after }) {
  const problems = [];
  for (const section of DELETION_SECTIONS) {
    const expected = before[section];
    const claimed = Number(deleted?.[section]);
    const left = Number(after?.[section]);
    if (!Number.isInteger(claimed)) problems.push({ section, rule: 'the routine did not report this section' });
    else if (claimed !== expected)
      problems.push({
        section,
        rule: 'the routine deleted a different number than was there',
        deleted: claimed,
        before: expected,
      });
    if (!Number.isInteger(left)) problems.push({ section, rule: 'this section was not counted afterwards' });
    else if (left !== 0) problems.push({ section, rule: 'rows are left after the deletion', left });
  }
  for (const section of Object.keys(deleted ?? {}))
    if (!DELETION_SECTIONS.includes(section) && section !== 'orphaned_user_ids')
      problems.push({ section, rule: 'the routine reported a section the deletion list does not have' });
  return { ok: problems.length === 0, problems };
}

/**
 * dryRun({ company, deletionState, before, limit, slug, reason, instructionRef }) -> what --apply would meet.
 *
 * Read only, and it answers in the routine's own order, so the operator sees the FIRST refusal they would meet
 * and not a list of everything that is wrong. `wouldRefuse` is null when the routine would go ahead.
 */
export function dryRun({ company, deletionState, before, limit, slug, reason, instructionRef }) {
  if (!REASON_CODES.includes(reason)) throw new DeletionError('unknown reason code');
  const problems = [];
  if (company === null || company === undefined) problems.push('E_NOT_FOUND');
  else {
    if (company.status !== 'closed') problems.push('E_COMPANY_NOT_CLOSED');
    if (company.slug !== slug) problems.push('E_CONFIRMATION_MISMATCH');
    /* The routine's own rule: past export_by, OR the reason is customer_instruction. app.deletion_state says
       'not_eligible' exactly while export_by is ahead. */
    if (deletionState === 'not_eligible' && reason !== 'customer_instruction') problems.push('E_DELETION_NOT_DUE');
    if (before.total > limit) problems.push('E_DELETE_TOO_LARGE');
  }
  if (reason === REASON_NEEDING_REFERENCE && !isRef(instructionRef ?? '')) problems.unshift('E_INSTRUCTION_REQUIRED');
  return {
    companyId: company?.id ?? null,
    status: company?.status ?? null,
    slugMatches: company?.slug === slug,
    deletionState,
    rows: before.total,
    limit,
    overLimit: before.total > limit,
    counts: before.counts,
    wouldRefuse: problems[0] ?? null,
    refusals: problems,
  };
}
