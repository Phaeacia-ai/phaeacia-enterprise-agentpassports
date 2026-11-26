/* Local-stack helpers for the E5 route tests (E5 design section 5). They reuse tests/e4/stack/helpers.mjs, which reuses
   E3's and, through its e3lib bridge, tests/db/e4-lib.sh and tests/db/e5-lib.sh. Every file reseeds and builds its own
   users and companies. Nothing here prints a key. */
import {
  activePolicyId,
  approveBoth,
  auditsOf,
  count,
  e3lib,
  e4routes,
  e4world,
  enableTargets,
  envelopeFor,
  key,
  psqlSession,
  published,
  reseed,
  reviewCompany,
  ROOT,
  sql,
  submitted,
  TARGETS,
  waitFor,
  withFetch,
} from '../../e4/stack/helpers.mjs';

export {
  activePolicyId,
  approveBoth,
  auditsOf,
  count,
  e3lib,
  e4world,
  enableTargets,
  envelopeFor,
  key,
  psqlSession,
  published,
  reseed,
  reviewCompany,
  ROOT,
  sql,
  submitted,
  TARGETS,
  waitFor,
  withFetch,
};

/** The E3, E4 and E5 routes as the tests call them; every write takes a fresh Idempotency-Key unless one is given. */
export async function e5routes(logged = []) {
  const R = await e4routes(logged);
  const idem = (k) => ({ 'idempotency-key': k ?? key() });
  return {
    ...R,
    catalog: (user, companyId, query = {}) => R.call('catalogRead', { user, params: { companyId }, query }),
    download: (user, releaseId) => R.call('releasesDownload', { user, params: { releaseId } }),
    installations: (user, releaseId) => R.call('installationsList', { user, params: { releaseId } }),
    report: (user, releaseId, body, k) =>
      R.call('installationsCreate', { user, params: { releaseId }, headers: idem(k), body }),
    witness: (user, reportId, body, k) =>
      R.call('installationsWitness', { user, params: { reportId }, headers: idem(k), body }),
  };
}

/** Owner-side, labelled as E5 design section 5 labels it: move a membership's authorizations of one release back in
    time, so the derived check-in state can be read at an exact age without waiting fourteen days. No route moves a
    ledger row and the append-only trigger refuses an UPDATE, so the trigger is disabled inside one owner transaction,
    which is the one thing only the migration owner can do. */
export function ageLedger(releaseId, membershipId, interval) {
  sql(`begin;
    alter table app.release_downloads disable trigger release_downloads_append_only;
    update app.release_downloads set authorized_at = authorized_at - interval '${interval}'
     where release_id = '${releaseId}' and membership_id = '${membershipId}';
    alter table app.release_downloads enable trigger release_downloads_append_only;
    commit;`);
}

/** Owner-side ledger rows, for a ceiling that would otherwise need two hundred requests. INSERT is not refused by the
    append-only trigger; only UPDATE, DELETE and TRUNCATE are. */
export function fillLedger(releaseId, membershipId, n) {
  sql(`insert into app.release_downloads (company_id, release_id, membership_id)
       select r.company_id, r.id, '${membershipId}' from app.releases r, generate_series(1, ${n}) where r.id = '${releaseId}'`);
}

/** The reports of one release, owner-side, for an assertion about what a route did or did not write. */
export const reportCount = (releaseId) =>
  Number(sql(`select count(*) from app.installation_reports where release_id='${releaseId}'`));
export const witnessCount = (reportId) =>
  Number(sql(`select count(*) from app.installation_witnesses where report_id='${reportId}'`));
export const ledgerCount = (releaseId, membershipId) =>
  Number(
    sql(
      `select count(*) from app.release_downloads where release_id='${releaseId}' and membership_id='${membershipId}'`,
    ),
  );
