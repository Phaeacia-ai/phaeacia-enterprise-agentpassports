/* The admin's own copy of their company's records (E6 design 1.6, 3.1 note 2, 3.4 and 3.5).

   NAMES, first, because this module's is not the design's. Design 2.1 and 3.4 call the module and the two routes
   after the word the product shows a person, and scripts/check-imports.mjs rule 7 refuses that word anywhere
   under lib/ and netlify/ outside a module-reference line, comments and string literals included, so the design's
   own names cannot be written here at all. The lead decided the names move rather than the gate (2026-09-17):
   this module is takeout.mjs, the routes are GET /api/companies/{companyId}/takeout and
   GET /api/operator/companies/{companyId}/takeout-manifest, and the route ids are companyTakeout and
   operatorTakeoutManifest. THE DATABASE NAMES ARE UNCHANGED, because SQL is not scanned by that gate:
   api.export_company, api.operator_export_manifest, app.limit_export_bytes(), E_EXPORT_TOO_LARGE,
   E_EXPORT_WINDOW_OPEN and the audit actions are exactly what migration 008 has. The word a person reads on the
   page is unchanged too: that is web/ text and the pages lane's. Report section 5 carries the old and new names
   as one table.

   ONE CALLER CLASS: a company admin at aal2 of that company, and nobody else. There is no operator arm anywhere
   in api.export_company and no operator route beside it (E6D-C-F1a): the first version of the design gave the
   same routine to an operator and emitted the same rows either way, which handed a Phaeacia person every
   candidate's content, every member's address and every review reason through a door that counts cannot
   constrain. What the operator keeps is the register and the counts-only manifest, and a customer who cannot take
   their own copy is served by E7's owner-side script under the boundary E2 section 5 already discloses.

   THE ONE COMPANY-SCOPED ROUTE THAT LOADS NO PRINCIPAL. loadPrincipal answers 409 E_COMPANY_INACTIVE for a
   member of a suspended company, and this route has to work for exactly that person during the fourteen-day
   window, which is the whole point of the window. So the routine's own predicate, app.export_admin, is the whole
   of the authorization, and because it skips the loader it carries the read boundary itself: an access period
   with export_by at or before clock_timestamp() refuses 409 E_ACCESS_PERIOD_ENDED ABOVE the admin predicate, so
   the exception is bounded in time and not open for ever, and a stranger guessing a company id meets 404 at the
   admin test either way. Nothing else in E6 skips the principal loader.

   IT IS BUFFERED AND NOT STREAMED, and the first version of the design said otherwise. lib/db/server.mjs's
   callAs reaches PostgREST through post(), which does `await r.json()`: the whole answer is read into memory and
   parsed into JavaScript objects, and the route then serializes it again for its own response. So AT THE CEILING
   THE FUNCTION HOLDS THE DOCUMENT THREE TIMES AT ONCE, and this is what that means in bytes:

     1. the response body PostgREST sent, as text, inside undici's buffer            up to 4 MiB
     2. the parsed JavaScript object graph JSON.parse built from it                  several times its text size,
                                                                                     because every string, array
                                                                                     and object is a heap value
     3. the string JSON.stringify makes of it again in lib/http/response.mjs         up to 4 MiB again

   Terms 1 and 3 are bounded by app.limit_export_bytes() = 4,194,304 bytes, which the routine measures exactly on
   octet_length(doc::text) before it answers. Term 2 is not bounded by any number in this repository and is the
   one a later reader should be told about rather than left to find: it is the ordinary cost of parsing JSON in
   Node, and it is MEASURED and not argued, in the section 6 capacity sample of tests/e6/stack, which records the
   function's own heap before the call, after the parse and after the re-serialization for a document at the
   ceiling. The 30 per cent the design holds back from Netlify's documented 6 MB buffered limit is about terms 1
   and 3, not about term 2.

   Making it a stream is not a small change and is not E6's: rpc() would have to hand back the undecoded Response
   body, fromPostgrest would need a second path for a failure that arrives mid-stream, and the route would write
   bytes instead of returning an object, which is an adapter change three slices of tests rest on.

   WHAT THE DOCUMENT CARRIES is what that admin can already read and nothing more (E6D-C-F1b): another author's
   unsubmitted draft is withheld, because E1 section 6 and app.candidate_visible_to deny that read, and
   access_periods is withheld entirely because no policy admits `authenticated` to it. `withheld` says per section
   how many rows and why, and it is ALWAYS PRESENT even when empty, so a reader can tell "nothing was withheld"
   from "this document predates the rule". The one inclusion beyond a direct read is releases.assembled_content,
   named in the design with its consequence rather than smuggled.

   FIELD NAMES. The envelope is design 1.6's camelCase; the SECTION NAMES inside sections, counts and withheld
   stay exactly as the database wrote them, which is the table's own name in snake_case, because a section is a
   table and its rows carry that table's columns. That is design 1.6's own shape and it is deliberate: this is a
   file somebody reads next to a schema, not a page's answer. The operator's manifest, which IS a page's answer,
   is camelCase in lib/services/operator.mjs, and the two differing is worth knowing rather than fixing. */

import { callAs } from '../db/server.mjs';
import { AppError } from '../errors.mjs';
import { isUuid } from './principal.mjs';

/**
 * takeCompanyCopy(session, { companyId }) -> the document of design 1.6.
 * No principal is loaded, deliberately (above). The refusal order is the routine's alone: 404 for an unknown
 * company, 409 E_ACCESS_PERIOD_ENDED past export_by, 404 without an active company_admin membership, 403
 * E_ADMIN_MFA_REQUIRED at aal1, 403 E_FORBIDDEN for a closed company, then the two size gates.
 */
export async function takeCompanyCopy(session, { companyId }, options) {
  if (!isUuid(companyId)) throw new AppError('E_NOT_FOUND');
  const doc = await callAs(session, 'export_company', { p_company: companyId }, options);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new AppError('E_INTERNAL');
  const { exported_at: exportedAt, schema_version: schemaVersion, ...rest } = doc;
  if (typeof exportedAt !== 'string' || !Number.isInteger(schemaVersion)) throw new AppError('E_INTERNAL');
  if (rest.withheld === null || typeof rest.withheld !== 'object') throw new AppError('E_INTERNAL');
  return { exportedAt, schemaVersion, ...rest };
}
