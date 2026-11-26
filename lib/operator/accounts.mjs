/* The account sweep (E6 design 1.5). Owner-side maintenance, never a route.

   E2 recorded the loose end twice: "an invitee who never opens the link leaves an unconfirmed auth.users row
   with no membership and no session; harmless under RLS, to be swept by an E6 job". Deleting an account is
   GoTrue's operation and needs the service key, and lib/http/ reaches lib/services/ and nothing else, so no
   route can reach this module without a new edge in scripts/check-imports.mjs. That edge is NOT added: the sweep
   is scripts/sweep-accounts.mjs, run by the operator from a terminal and later by a scheduled job, exactly as
   E7's restore and reconciliation scripts are. Its authorization is possession of the database credential and
   the service key, disclosed here in the same terms E2 section 5 uses for app_maintenance rather than enforced
   by a routine. THE SERVICE KEY THEREFORE NEVER ENTERS THE REQUEST PATH, which is the strongest form of E1's
   rule that lib/operator/ must not be reachable from a public route without operator MFA.

   Nothing here opens a database connection. lib/ may reach node:crypto, node:fs and node:path and nothing else,
   so a psql child process cannot live under lib/ at all; the OWNER-SIDE calls are injected by the script as
   `db`, which is two functions and a stated contract. That is not a workaround: it is what keeps this module
   testable without a stack and keeps the credential in the script that was run deliberately.

   E6D-C-F13, settled in part and carried in part, with what remains stated rather than implied.
   The finding: an account can become USED between the sweep's selection and GoTrue's delete, and an interruption
   just after one account is gone loses its audit row.

     What is closed. (a) app.memberships.user_id references auth.users with ON DELETE NO ACTION (observed, P12),
     so an account that gains a membership of any status in the window CANNOT be deleted at all: GoTrue's delete
     fails on the foreign key and this module records nothing for it. That is the case that matters most, because
     it is the one where a person has just accepted an invitation. (b) Each candidate is RE-CHECKED against the
     same predicate immediately before its own delete, one id at a time, so the window is one read and one HTTP
     call rather than the whole run. (c) The audit rows are written in batches of RECORD_BATCH after the deletes
     they describe, so an interruption loses at most that batch rather than the run, and every id is printed as
     it is deleted so the terminal output is recoverable evidence.

     What remains, and this is the consequence to weigh before the sweep is ever enabled. app.operators.user_id
     and app.profiles.user_id both CASCADE. An account that, inside the narrowed window, signs in for the first
     time (which confirms the address and creates a session) or is made an operator can still be deleted, and its
     profile or operator row goes with it. The person meets a signed-out browser and an account that no longer
     exists; their invitation, if still pending, re-creates the account at the next generateLink, so the state is
     recoverable, but nobody is told it happened. Closing this needs a quarantine column on auth.users or a
     deletion protocol GoTrue does not offer, which is a migration and not this lane's.

     And confirmed orphan accounts are RETAINED rather than eventually erased when anything at all touched them:
     the predicate is conservative on purpose, so an account with a profile, an operator row, a session, a
     membership of any status or a live invitation is kept for ever. That is said plainly because "the sweep
     cleans up unused accounts" would otherwise be read as "the sweep eventually erases them all". */

import { adminRequest } from '../db/operator.mjs';

/* One audit write per this many deletes, so an interruption loses at most this many rows (above). Ten is small
   enough that a crash costs little and large enough that a hundred-account run makes ten calls and not a
   hundred. */
export const RECORD_BATCH = 10;

/**
 * The `db` contract the script supplies, run as the database owner over a direct connection:
 *   db.candidates(limit)            -> { userIds: [uuid], remaining: integer }   app.sweep_candidates
 *   db.stillCandidate(userId)       -> boolean                                   the same predicate, one id
 *   db.recorded(operatorId, ids)    -> { recorded: integer }                     app.sweep_recorded
 * Each is one statement as the owner. None of them is reachable through PostgREST: 008 grants these functions to
 * nobody at all.
 */

/** deleteAccount(userId): GoTrue's admin delete. EXPORTED since the E7 shared contracts (E7 2.6 item 10): the
 *  reconciler's C9 re-applies recorded account sweeps through it after a restore (E7 1.3, E7D-C-F3). */
export async function deleteAccount(userId, options) {
  const { status } = await adminRequest(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' }, options);
  /* 404 means the account is already gone, which an interrupted earlier run leaves behind: it is not an error
     and it is not a deletion this run may claim, so it is neither recorded nor counted as a failure. */
  if (status >= 200 && status < 300) return 'deleted';
  if (status === 404) return 'gone';
  return 'refused';
}

/** deleteFactor(userId, factorId): GoTrue's admin factor delete, the lost-second-factor procedure's step 5 as a
 *  call (docs/ops/lost-second-factor.md), used by the reconciler's C8 to re-apply a recorded factor deletion after
 *  a restore (E7 1.3, E7D-C-F3). The same three outcomes as deleteAccount; deleting a factor ends no session. */
export async function deleteFactor(userId, factorId, options) {
  const { status } = await adminRequest(
    `/auth/v1/admin/users/${userId}/factors/${factorId}`,
    { method: 'DELETE' },
    options,
  );
  if (status >= 200 && status < 300) return 'deleted';
  if (status === 404) return 'gone';
  return 'refused';
}

/**
 * sweepAccounts({ dryRun, limit, operatorId, db, log }, options)
 *   -> { candidates, remaining, deleted, gone, refused, skipped, recorded, deletedIds }
 *
 * dryRun is the default and deletes nothing: it reads the candidates and reports them, which is what makes the
 * script safe to run first. With dryRun false, each candidate is re-checked, deleted through GoTrue, and then
 * recorded in batches. An id that stopped being a candidate in the window is `skipped` and nothing is done to it;
 * an id GoTrue refused is `refused` and nothing is recorded for it, so the audit never claims a deletion that did
 * not happen.
 */
export async function sweepAccounts({ dryRun = true, limit = 100, operatorId, db, log = () => {} }, options) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('sweepAccounts: limit');
  if (
    typeof db?.candidates !== 'function' ||
    typeof db?.stillCandidate !== 'function' ||
    typeof db?.recorded !== 'function'
  )
    throw new TypeError('sweepAccounts: db must supply candidates, stillCandidate and recorded');
  const { userIds, remaining } = await db.candidates(limit);
  const out = {
    candidates: userIds.length,
    remaining,
    deleted: 0,
    gone: 0,
    refused: 0,
    skipped: 0,
    recorded: 0,
    deletedIds: [],
  };
  if (dryRun) return out;
  if (typeof operatorId !== 'string') throw new TypeError('sweepAccounts: an apply run needs an operator id');
  const pending = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    const { recorded } = await db.recorded(operatorId, batch);
    out.recorded += recorded;
  };
  for (const userId of userIds) {
    if (!(await db.stillCandidate(userId))) {
      out.skipped += 1;
      log({ event: 'sweep_skipped', userId });
      continue;
    }
    const outcome = await deleteAccount(userId, options);
    if (outcome === 'deleted') {
      out.deleted += 1;
      out.deletedIds.push(userId);
      pending.push(userId);
      log({ event: 'sweep_deleted', userId });
    } else if (outcome === 'gone') {
      out.gone += 1;
      log({ event: 'sweep_already_gone', userId });
    } else {
      out.refused += 1;
      log({ event: 'sweep_refused', userId });
    }
    if (pending.length >= RECORD_BATCH) await flush();
  }
  await flush();
  return out;
}
