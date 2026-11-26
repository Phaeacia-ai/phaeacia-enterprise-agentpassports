/* Setting one's own display name (pages design 2.1, 4.1 and 4.3).

   The rule is applied here first, in Node, and again by api.set_display_name, which is the authority. The function
   takes no user id: its principal is the subject of the server token minted from this request's VerifiedSession, so
   the row written is the caller's and no request shape can name another user. No company standing is read and no aal
   is required, because a profile belongs to the account and no admin decision depends on it. The write is idempotent
   on its value, so a retry after a failure is safe. Nothing here logs, and the pipeline logs codes only, so the name
   reaches no log line.

   A capability holder, because it holds the server client: tests/e2/unit/boundaries.test.mjs pins its one name. */

import { callAs } from '../db/server.mjs';
import { AppError } from '../errors.mjs';
import { normalizeDisplayName } from '../rules/profiles.mjs';

/** setDisplayName(session, { displayName }) -> { changed }. E_BODY_INVALID for a value the rule refuses, before any
    token is minted; the database's own refusals arrive as AppErrors from the server client. */
export async function setDisplayName(session, { displayName }) {
  const name = normalizeDisplayName(displayName);
  if (!name.ok) throw new AppError('E_BODY_INVALID');
  const rows = await callAs(session, 'set_display_name', { p_display_name: name.value });
  return { changed: rows?.[0]?.changed === true };
}
