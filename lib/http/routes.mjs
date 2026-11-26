/* Route functions (E2 design section 8.3), one per API route, each a pure
   function of a request object built by lib/http/pipeline.mjs. The Netlify
   files under netlify/functions/ wrap exactly one of these each.

   Each declaration states its method and its path, copied from the config
   line of its function file. The path is written twice on purpose, once
   there for Netlify and once here, and this table is the authoritative
   statement of which path each handler serves: a file that wires the wrong
   handler agrees with itself, so only a fact the file does not produce can
   catch it (pages design 4.1). tests/e2/unit/route-identity.test.mjs fails
   the moment a file's config and its handler's declaration differ.

   makeRoutes(deps): deps.mail is the mail transport (E7 design 1.1: ready()
   and deliver({ to, subject, text })), deps.alert the alert sink (E7 1.5), and
   deps.deliver the test seam that receives the invitation's link material
   ({ to, acceptUrl, expiresAt, companyName, kind }) in place of a transport;
   the four invitation paths get all of them through delivery(deps) below. In
   `mail` mode with neither a deliver function nor a ready transport, the
   invitation routes answer 503 E_MAIL_NOT_CONFIGURED before any write. deps.log
   replaces the stderr logger. Every handler carries its own key as a
   non-writable routeName.

   The seven E3 routes (E3 design 4.4) follow the eleven E2 ones. Create and save declare body: 'passport' and hand
   the service the request's Buffer as it arrived. Submit reads JSON under the passport bound (body: 'submission',
   design 4.5 row 8, E3b critique F1); successor reads its empty object under the E2 JSON bound. A gate refusal on create or save
   is a PassportRefused carrying its problem list as AppError data (design 3.5), which the pipeline's boundary answers
   and logs like every other refusal (E3b critique F4).

   The eight pages routes (pages design 2.1 to 2.4) follow the E3 ones. The four reads and the display-name write call
   one service each. The four factor routes compose lib/auth/factors.mjs with the session cookies, as authRefresh does
   with refreshSession: a factor refusal is logged once with GoTrue's status and error_code, and answered through the
   pipeline's boundary as an AppError, so no secret, URI, QR code, challenge id or code reaches a log line.

   The twelve E4 routes (E4 design 3.4) follow the pages ones, each calling one service. Two pairs share a path by
   method, as invitationsList does with invitationsCreate (pages O10): GET and POST on a company's groups, PUT and DELETE
   on one group member. A bound write answers the status of its first attempt on a replay: 201, or 200 for an envelope
   or a release that already existed. Refusals of 3.5 rows 1 to 9 are the pipeline's, unchanged.

   The five E5 routes (E5 design 3.4) follow the E4 ones. A third pair shares a path by method: GET and POST on one
   release's installations. The download declares no body and carries no Idempotency-Key, by the decision of E5 design
   1.2, and it is a POST and not a GET because it appends to an append-only ledger and a GET that writes is followed by
   every prefetcher, link scanner and cache, and sits outside the cross-site guard the pipeline applies to mutations.

   The mail event route (docs/e7/alerts-and-checkin-design.md 1.4, slice 1) comes last. It takes no session and no id:
   the mail provider is authenticated by the signature over the raw body (body: 'signed'), which
   lib/services/mail-events.mjs verifies before it parses anything. Its function file hands makeRoutes the alert sink,
   through which the service raises the operator's `delivery_undeliverable` alert, and the transport, which slice 2's
   contact mail sends through; the pipeline's own alerts need no wiring, as for every route. */

import { enrollTotp, isTotpCode, listFactors, removeFactor, verifyTotp } from '../auth/factors.mjs';
import { AppError } from '../errors.mjs';
import * as candidates from '../services/candidates.mjs';
import * as catalog from '../services/catalog.mjs';
import { listGroups, listInvitations, listMembers } from '../services/directory.mjs';
import { beginVerification, endVerification } from '../services/factor-bound.mjs';
import * as groups from '../services/groups.mjs';
import { loadIdentity } from '../services/identity.mjs';
import * as installations from '../services/installations.mjs';
import * as agents from '../services/agents.mjs';
import * as takeout from '../services/takeout.mjs';
import { acceptInvitation, createInvitation, resendInvitation, revokeInvitation } from '../services/invitations.mjs';
import { departurePreview } from '../services/lifecycle.mjs';
import { handleMailEvent } from '../services/mail-events.mjs';
import { readQuotas } from '../services/quotas.mjs';
import { removeMember, setRoles } from '../services/members.mjs';
import * as operator from '../services/operator.mjs';
import { setDisplayName } from '../services/profiles.mjs';
import * as releases from '../services/releases.mjs';
import * as reviews from '../services/reviews.mjs';
import { refreshSession, refreshTokenOf, sessionCookies, signOut, startSignIn, verifyTokenHash } from '../session.mjs';
import { afterAnswer, alert, shapeFields } from './alerts.mjs';
import { route } from './pipeline.mjs';
import { error, json, noContent } from './response.mjs';

/* A factor call's refusal: one log line with the application code and GoTrue's status and error_code, then the
   AppError the pipeline answers and logs as refused. */
function factorRefusal(deps, refused) {
  const log = deps.log ?? ((entry) => process.stderr.write(`${JSON.stringify(entry)}\n`));
  log({
    event: 'gotrue_refused',
    code: refused.code,
    gotrueStatus: refused.gotrueStatus,
    gotrueErrorCode: refused.gotrueErrorCode,
  });
  return new AppError(refused.code);
}

/* HB-F2: the account's bound could not be settled after GoTrue answered (lib/services/factor-bound.mjs endVerification
   failed or ran past its bound). One content-free line; the attempt stays counted, which fails closed. */
function boundUnsettled(deps) {
  const log = deps.log ?? ((entry) => process.stderr.write(`${JSON.stringify(entry)}\n`));
  log({ event: 'mfa_bound_unsettled' });
}

/* E7 2.6 item 4: what the four invitation paths receive. deps.deliver stays the test seam; a transport supplies
   ready() and, once the E7 lane lands the rendering, deliver({ to, subject, text }). */
function delivery(deps) {
  return {
    deliver: deps.deliver,
    ready: typeof deps.mail?.ready === 'function' ? () => deps.mail.ready() : undefined,
    mail: deps.mail,
    alert: deps.alert,
  };
}

export function makeRoutes(deps = {}) {
  const table = {
    invitationsCreate: route(
      {
        method: 'POST',
        path: '/api/companies/:companyId/invitations',
        uuidParams: ['companyId'],
        handle: async ({ session, params, body }) => {
          const r = await createInvitation(
            session,
            { companyId: params.companyId, email: body.email, roles: body.roles, expiresInDays: body.expiresInDays },
            delivery(deps),
          );
          /* E6 design 1.2: the answer says which delivery ran, and in handover mode carries the accept link ONCE.
             A page renders what it was given and never assumes; nothing returns the link again. */
          return json(201, { ok: true, ...r });
        },
      },
      deps,
    ),

    invitationsRevoke: route(
      {
        method: 'POST',
        path: '/api/companies/:companyId/invitations/:invitationId/revoke',
        uuidParams: ['companyId', 'invitationId'],
        body: 'none',
        handle: async ({ session, params }) => {
          await revokeInvitation(session, { companyId: params.companyId, invitationId: params.invitationId });
          return noContent();
        },
      },
      deps,
    ),

    invitationsAccept: route(
      {
        method: 'POST',
        path: '/api/invitations/accept',
        handle: async ({ session, body }) => {
          const r = await acceptInvitation(session, { inviteCode: body.inviteCode });
          return json(200, { ok: true, ...r });
        },
      },
      deps,
    ),

    membersSetRoles: route(
      {
        method: 'PATCH',
        path: '/api/companies/:companyId/members/:membershipId/roles',
        uuidParams: ['companyId', 'membershipId'],
        handle: async ({ session, params, body }) => {
          const r = await setRoles(session, {
            companyId: params.companyId,
            membershipId: params.membershipId,
            roles: body.roles,
          });
          return json(200, { ok: true, ...r });
        },
      },
      deps,
    ),

    membersRemove: route(
      {
        method: 'DELETE',
        path: '/api/companies/:companyId/members/:membershipId',
        uuidParams: ['companyId', 'membershipId'],
        body: 'none',
        handle: async ({ session, params }) => {
          const r = await removeMember(session, { companyId: params.companyId, membershipId: params.membershipId });
          return json(200, { ok: true, ...r });
        },
      },
      deps,
    ),

    /* E6 design 1.1 and 3.4. This declaration REPLACES E2's operatorProvision on the same method and path (lead
       decision, 2026-09-17). api.provision_company is unchanged in the database and stays tests/db/00-seed.sh's
       path; it had no usable product route, because it takes a confirmed auth.users id no route creates, and
       because it makes a company with NO access period, which design 1.5 says the product path may not do. The
       answer carries the accept link once in handover mode and never again. */
    operatorCompanyCreate: route(
      {
        method: 'POST',
        path: '/api/operator/companies',
        handle: async ({ session, body }) => {
          const r = await operator.createCompany(
            session,
            {
              slug: body.slug,
              name: body.name,
              firstAdminEmail: body.firstAdminEmail,
              expiresInDays: body.expiresInDays,
              startsAt: body.startsAt,
              endsAt: body.endsAt,
              invoiceRef: body.invoiceRef,
            },
            delivery(deps),
          );
          return json(201, { ok: true, ...r });
        },
      },
      deps,
    ),

    /* The register. It shares its path with the create above by method, as invitationsList does with
       invitationsCreate (pages O10). cursorReset is the lead's decision (b) on the database lane's question 2: a
       cursor naming a company that has since been deleted is not an error to show, so the service drops it,
       re-reads the first page once and says so. */
    operatorRegister: route(
      {
        method: 'GET',
        path: '/api/operator/companies',
        body: 'none',
        handle: async ({ request, session }) => {
          const { cursor, limit } = request.query ?? {};
          const r = await operator.readRegister(session, {
            cursor: cursor === undefined ? undefined : String(cursor),
            limit: limit === undefined ? undefined : Number(limit),
          });
          return json(200, { ok: true, ...r });
        },
      },
      deps,
    ),

    operatorTransferAdmin: route(
      {
        method: 'POST',
        path: '/api/operator/companies/:companyId/transfer-first-admin',
        uuidParams: ['companyId'],
        handle: async ({ session, params, body }) => {
          const r = await operator.transferFirstAdmin(session, { companyId: params.companyId, userId: body.userId });
          return json(200, { ok: true, ...r });
        },
      },
      deps,
    ),

    /* Body { email }: request a sign-in link for an existing confirmed account.
       Always 204: nothing about the address is revealed. Lane K3 (XR-3): when GoTrue answered 429, which the person
       never sees, the operator gets one `signin_limited` line through the route's logger and then one alert through
       the pipeline's per-instance fold (lib/http/alerts.mjs), both from shapeFields over the route, the code, the
       status and Netlify's request id, so nothing of the address reaches either. lib/session.mjs imports nothing,
       which is why they are written here and not beside the call to GoTrue. Neither changes the 204, and the 204 does
       not wait for the alert's send (HKC-F1): the record is written before the answer and the send goes after it,
       carried by the answer to the adapter, which hands it to Netlify's waitUntil (alerts.mjs afterAnswer). */
    authStart: route(
      {
        method: 'POST',
        path: '/api/auth/start',
        session: 'none',
        handle: async ({ request, body }) => {
          if (typeof body.email !== 'string' || body.email.length === 0 || body.email.length > 254)
            return error('E_EMAIL_INVALID');
          const r = await startSignIn(body.email.trim().toLowerCase());
          if (r.limited) {
            const log = deps.log ?? ((entry) => process.stderr.write(`${JSON.stringify(entry)}\n`));
            const fields = shapeFields({
              route: 'authStart',
              code: 'E_RATE_LIMITED',
              status: 429,
              requestId: request.headers['x-nf-request-id'],
            });
            /* The line inside the guard too (the peer check's CR2-2): a logger that throws must not turn this one
               GoTrue answer into a 500 when every other answer is a 204, which would tell the caller what GoTrue said. */
            try {
              log({ event: 'signin_limited', ...fields });
              return afterAnswer(noContent(), (deps.alert ?? alert)('signin_limited', fields, deps));
            } catch {
              /* a line and an alert are notifications; the answer stands */
            }
          }
          return noContent();
        },
      },
      deps,
    ),

    /* Body { tokenHash, type }: server-side verification of the emailed link; sets the HTTP-only session
       cookies. Posted by the page, never followed as a GET link, so a mail scanner cannot consume the
       single-use token. */
    authVerify: route(
      {
        method: 'POST',
        path: '/api/auth/verify',
        session: 'none',
        handle: async ({ body }) => {
          const v = await verifyTokenHash({ tokenHash: body.tokenHash, type: body.type });
          if (!v.ok) return error('E_AUTH_INVALID');
          return noContent({ cookies: sessionCookies(v.tokens) });
        },
      },
      deps,
    ),

    /* Rotate the session from the refresh cookie. */
    authRefresh: route(
      {
        method: 'POST',
        path: '/api/auth/refresh',
        session: 'none',
        body: 'none',
        handle: async ({ request }) => {
          const v = await refreshSession(refreshTokenOf(request));
          if (!v.ok) return error('E_AUTH_INVALID', { cookies: sessionCookies(null) });
          return noContent({ cookies: sessionCookies(v.tokens) });
        },
      },
      deps,
    ),

    /* Revoke at GoTrue when the session verifies; clear the cookies always, including when verification
       cannot complete (the pipeline passes a null session then, M4). */
    authSignout: route(
      {
        method: 'POST',
        path: '/api/auth/signout',
        session: 'optional',
        body: 'none',
        handle: async ({ session }) => {
          if (session) await signOut(session).catch(() => ({ ok: false }));
          return noContent({ cookies: sessionCookies(null) });
        },
      },
      deps,
    ),

    /* Raw passport bytes; Idempotency-Key; X-Agent-Name for a new agent or X-Agent-Id for an existing one. */
    candidatesCreate: route(
      {
        method: 'POST',
        path: '/api/companies/:companyId/candidates',
        uuidParams: ['companyId'],
        body: 'passport',
        handle: async ({ request, session, params, body }) =>
          json(
            201,
            await candidates.createCandidate(session, {
              companyId: params.companyId,
              agentId: request.headers['x-agent-id'],
              agentName: request.headers['x-agent-name'],
              idempotencyKey: request.headers['idempotency-key'],
              contentType: request.headers['content-type'],
              bytes: body,
            }),
          ),
      },
      deps,
    ),

    /* Raw passport bytes replacing the draft's; Idempotency-Key; If-Match the version the browser last saw. */
    candidatesSave: route(
      {
        method: 'PUT',
        path: '/api/candidates/:candidateId',
        uuidParams: ['candidateId'],
        body: 'passport',
        handle: async ({ request, session, params, body }) =>
          json(
            200,
            await candidates.saveCandidate(session, {
              candidateId: params.candidateId,
              idempotencyKey: request.headers['idempotency-key'],
              ifMatch: request.headers['if-match'],
              contentType: request.headers['content-type'],
              bytes: body,
            }),
          ),
      },
      deps,
    ),

    /* JSON submission metadata; Idempotency-Key; If-Match. The content is the stored draft's, re-gated. */
    candidatesSubmit: route(
      {
        method: 'POST',
        path: '/api/candidates/:candidateId/submit',
        uuidParams: ['candidateId'],
        body: 'submission',
        handle: async ({ request, session, params, body }) => {
          const r = await candidates.submitCandidate(session, {
            candidateId: params.candidateId,
            idempotencyKey: request.headers['idempotency-key'],
            ifMatch: request.headers['if-match'],
            body,
          });
          return json(200, r);
        },
      },
      deps,
    ),

    /* An empty JSON object; Idempotency-Key. The parent's stored bytes are re-gated for the new draft. */
    candidatesSuccessor: route(
      {
        method: 'POST',
        path: '/api/candidates/:candidateId/successor',
        uuidParams: ['candidateId'],
        handle: async ({ request, session, params, body }) => {
          const r = await candidates.createSuccessor(session, {
            candidateId: params.candidateId,
            idempotencyKey: request.headers['idempotency-key'],
            body,
          });
          return json(201, r);
        },
      },
      deps,
    ),

    candidatesRead: route(
      {
        method: 'GET',
        path: '/api/candidates/:candidateId',
        uuidParams: ['candidateId'],
        body: 'none',
        handle: async ({ session, params }) =>
          json(200, await candidates.readCandidate(session, { candidateId: params.candidateId })),
      },
      deps,
    ),

    /* Query: state, one of the candidate states; cursor, the nextCursor of the previous page. */
    candidatesList: route(
      {
        method: 'GET',
        path: '/api/companies/:companyId/candidates',
        uuidParams: ['companyId'],
        body: 'none',
        handle: async ({ request, session, params }) =>
          json(200, await candidates.listCandidates(session, { companyId: params.companyId, query: request.query })),
      },
      deps,
    ),

    gateRead: route(
      {
        method: 'GET',
        path: '/api/gate',
        body: 'none',
        handle: async ({ session }) => json(200, await candidates.readGate(session)),
      },
      deps,
    ),

    /* Pages 2.1: user from the verified session; memberships, companies and the own display name through RLS. */
    me: route(
      {
        method: 'GET',
        path: '/api/me',
        body: 'none',
        handle: async ({ session }) => json(200, { ok: true, ...(await loadIdentity(session)) }),
      },
      deps,
    ),

    /* Pages 2.1. Body { displayName }: the caller's own profile, whatever their standing; 204 when created, changed or
       already equal. Unknown keys are ignored, and no body names another user. */
    meDisplayName: route(
      {
        method: 'PUT',
        path: '/api/me/display-name',
        body: 'json',
        handle: async ({ session, body }) => {
          await setDisplayName(session, { displayName: body.displayName });
          return noContent();
        },
      },
      deps,
    ),

    /* Pages 2.2: any active member of the company; labels by the precedence of memberLabel. */
    membersList: route(
      {
        method: 'GET',
        path: '/api/companies/:companyId/members',
        uuidParams: ['companyId'],
        body: 'none',
        handle: async ({ session, params }) =>
          json(200, { ok: true, ...(await listMembers(session, params.companyId)) }),
      },
      deps,
    ),

    /* Pages 2.3: the same path as invitationsCreate with GET (O10). A company admin at aal2; the database decides. */
    invitationsList: route(
      {
        method: 'GET',
        path: '/api/companies/:companyId/invitations',
        uuidParams: ['companyId'],
        body: 'none',
        handle: async ({ session, params }) =>
          json(200, { ok: true, ...(await listInvitations(session, params.companyId)) }),
      },
      deps,
    ),

    /* Pages 2.4: the caller's TOTP factors from GoTrue; aal is the session's, not GoTrue's. */
    factorsList: route(
      {
        method: 'GET',
        path: '/api/auth/factors',
        body: 'none',
        handle: async ({ session }) => {
          const r = await listFactors(session);
          if (!r.ok) throw factorRefusal(deps, r);
          return json(200, { ok: true, aal: session.aal, factors: r.factors });
        },
      },
      deps,
    ),

    /* Pages 2.4: one enrolment, no deletion; the secret reaches this caller once, never logged or stored. */
    factorsEnroll: route(
      {
        method: 'POST',
        path: '/api/auth/factors/totp',
        body: 'none',
        handle: async ({ session }) => {
          const r = await enrollTotp(session);
          if (!r.ok) throw factorRefusal(deps, r);
          return json(201, { ok: true, factorId: r.factorId, qrCodeSvg: r.qrCodeSvg, uri: r.uri, secret: r.secret });
        },
      },
      deps,
    ),

    /* Pages 2.4. Body { code }: challenge and verify in this one request, then both cookies replaced with GoTrue's
       tokens for the same session, now aal2. The route returns no aal; the next verifySession reads it. */
    factorsVerify: route(
      {
        method: 'POST',
        path: '/api/auth/factors/:factorId/verify',
        uuidParams: ['factorId'],
        body: 'json',
        handle: async ({ session, params, body }) => {
          /* HB-F2 (migration 012; evidence/ena7-end1-hbf2.md sections 3 and 5): the account's bound on wrong codes.
             A malformed code is refused first, by verifyTotp's own check and with its own line, and spends nothing.
             Then begin counts the attempt before GoTrue sees it (refused: 429 E_MFA_ATTEMPTS_EXHAUSTED with retryAfter,
             no GoTrue call; no database: 503 E_MFA_UNAVAILABLE, no GoTrue call); then GoTrue; then the end settles the
             attempt with what GoTrue judged, under a short bound, and an unsettled end never changes the answer. */
          if (!isTotpCode(body.code)) throw factorRefusal(deps, await verifyTotp(session, params.factorId, body.code));
          const { attemptId } = await beginVerification(session);
          const r = await verifyTotp(session, params.factorId, body.code);
          const settled = await endVerification(session, attemptId, r.judged);
          if (!settled.ok) boundUnsettled(deps);
          if (!r.ok) throw factorRefusal(deps, r);
          return noContent({ cookies: sessionCookies(r.tokens) });
        },
      },
      deps,
    ),

    /* Pages 2.4: delete the named factor, then refresh so this browser's next request carries the session's aal after
       the removal; when the refresh fails or cannot run, both cookies are cleared. */
    factorsRemove: route(
      {
        method: 'DELETE',
        path: '/api/auth/factors/:factorId',
        uuidParams: ['factorId'],
        body: 'none',
        handle: async ({ request, session, params }) => {
          const r = await removeFactor(session, params.factorId);
          if (!r.ok) throw factorRefusal(deps, r);
          const refreshed = await refreshSession(refreshTokenOf(request)).catch(() => ({ ok: false }));
          return noContent({ cookies: sessionCookies(refreshed.ok ? refreshed.tokens : null) });
        },
      },
      deps,
    ),

    /* E4 3.4: the company's submitted candidates and open envelopes, as row level security lets the caller read them. */
    reviewQueue: route(
      {
        method: 'GET',
        path: '/api/companies/:companyId/review-queue',
        uuidParams: ['companyId'],
        body: 'none',
        handle: async ({ session, params }) =>
          json(200, await reviews.readReviewQueue(session, { companyId: params.companyId })),
      },
      deps,
    ),

    /* E4 3.4 and 4.1: the review screen's read, for a reader of the candidate (E3 4.1). */
    reviewRead: route(
      {
        method: 'GET',
        path: '/api/candidates/:candidateId/review',
        uuidParams: ['candidateId'],
        body: 'none',
        handle: async ({ session, params }) =>
          json(200, await reviews.readReview(session, { candidateId: params.candidateId })),
      },
      deps,
    ),

    /* E4 1.1. JSON { target, audienceGroupIds, policyId }; Idempotency-Key. 201, or 200 when the binding exists. */
    envelopesCreate: route(
      {
        method: 'POST',
        path: '/api/candidates/:candidateId/envelopes',
        uuidParams: ['candidateId'],
        handle: async ({ request, session, params, body }) => {
          const r = await reviews.createEnvelope(session, {
            candidateId: params.candidateId,
            idempotencyKey: request.headers['idempotency-key'],
            body,
          });
          return json(r.existing ? 200 : 201, r);
        },
      },
      deps,
    ),

    /* E4 1.2. JSON { envelopeId, role, decision, reason }; Idempotency-Key. 201. */
    reviewsCreate: route(
      {
        method: 'POST',
        path: '/api/candidates/:candidateId/reviews',
        uuidParams: ['candidateId'],
        handle: async ({ request, session, params, body }) =>
          json(
            201,
            await reviews.recordReview(session, {
              candidateId: params.candidateId,
              idempotencyKey: request.headers['idempotency-key'],
              body,
            }),
          ),
      },
      deps,
    ),

    /* E4 1.3. JSON { envelopeId }; Idempotency-Key. 201, or 200 when the envelope already has a current release. */
    releasesPublish: route(
      {
        method: 'POST',
        path: '/api/candidates/:candidateId/releases',
        uuidParams: ['candidateId'],
        handle: async ({ request, session, params, body }) => {
          const r = await releases.publishRelease(
            session,
            { candidateId: params.candidateId, idempotencyKey: request.headers['idempotency-key'], body },
            { log: deps.log },
          );
          return json(r.existing ? 200 : 201, r);
        },
      },
      deps,
    ),

    /* E4 1.4. JSON { reason }; Idempotency-Key. 200 with the recipients and revokesCopies false. */
    releasesWithdraw: route(
      {
        method: 'POST',
        path: '/api/releases/:releaseId/withdraw',
        uuidParams: ['releaseId'],
        handle: async ({ request, session, params, body }) =>
          json(
            200,
            await releases.withdrawRelease(session, {
              releaseId: params.releaseId,
              idempotencyKey: request.headers['idempotency-key'],
              body,
            }),
          ),
      },
      deps,
    ),

    /* E4 3.4: a reader of the release (3.1); envelope and reviews null unless the caller reads the candidate. */
    releasesRead: route(
      {
        method: 'GET',
        path: '/api/releases/:releaseId',
        uuidParams: ['releaseId'],
        body: 'none',
        handle: async ({ session, params }) =>
          json(200, await releases.readRelease(session, { releaseId: params.releaseId })),
      },
      deps,
    ),

    /* E4 3.4. Query: state, published or withdrawn; cursor, the nextCursor of the previous page. */
    releasesList: route(
      {
        method: 'GET',
        path: '/api/companies/:companyId/releases',
        uuidParams: ['companyId'],
        body: 'none',
        handle: async ({ request, session, params }) =>
          json(200, await releases.listReleases(session, { companyId: params.companyId, query: request.query })),
      },
      deps,
    ),

    /* E4 3.4 and 1.7: any active member of the company. */
    groupsList: route(
      {
        method: 'GET',
        path: '/api/companies/:companyId/groups',
        uuidParams: ['companyId'],
        body: 'none',
        handle: async ({ session, params }) =>
          json(200, { ok: true, ...(await listGroups(session, params.companyId)) }),
      },
      deps,
    ),

    /* E4 1.7: the same path as groupsList with POST (O10). JSON { name }; a company admin at aal2, the database decides. */
    groupsCreate: route(
      {
        method: 'POST',
        path: '/api/companies/:companyId/groups',
        uuidParams: ['companyId'],
        handle: async ({ session, params, body }) =>
          json(201, { ok: true, ...(await groups.createGroup(session, { companyId: params.companyId, body })) }),
      },
      deps,
    ),

    /* E4 1.7: no body; changed false when the membership is already in the group. */
    groupMembersAdd: route(
      {
        method: 'PUT',
        path: '/api/companies/:companyId/groups/:groupId/members/:membershipId',
        uuidParams: ['companyId', 'groupId', 'membershipId'],
        body: 'none',
        handle: async ({ session, params }) =>
          json(200, {
            ok: true,
            ...(await groups.addGroupMember(session, {
              companyId: params.companyId,
              groupId: params.groupId,
              membershipId: params.membershipId,
            })),
          }),
      },
      deps,
    ),

    /* E4 1.7: the same path as groupMembersAdd with DELETE (O10); changed false when the row was absent. */
    groupMembersRemove: route(
      {
        method: 'DELETE',
        path: '/api/companies/:companyId/groups/:groupId/members/:membershipId',
        uuidParams: ['companyId', 'groupId', 'membershipId'],
        body: 'none',
        handle: async ({ session, params }) =>
          json(200, {
            ok: true,
            ...(await groups.removeGroupMember(session, {
              companyId: params.companyId,
              groupId: params.groupId,
              membershipId: params.membershipId,
            })),
          }),
      },
      deps,
    ),

    /* E5 3.4: any active member of the company; the rows are the member's own gallery, decided by row level security
       and the one download predicate. Query: cursor, the nextCursor of the previous page. */
    catalogRead: route(
      {
        method: 'GET',
        path: '/api/companies/:companyId/catalog',
        uuidParams: ['companyId'],
        body: 'none',
        handle: async ({ request, session, params }) =>
          json(200, await catalog.readCatalog(session, { companyId: params.companyId, query: request.query })),
      },
      deps,
    ),

    /* E5 1.2: no body, no Idempotency-Key. 200 with the frozen bytes, their hash, the authorization count after this
       row and the declared losses this service read from those same bytes. */
    releasesDownload: route(
      {
        method: 'POST',
        path: '/api/releases/:releaseId/download',
        uuidParams: ['releaseId'],
        body: 'none',
        handle: async ({ session, params }) =>
          json(200, await catalog.authorizeDownload(session, { releaseId: params.releaseId })),
      },
      deps,
    ),

    /* E5 3.4: a reader of the release; which fields each entry carries is row level security's answer, not this
       route's (E5D-C-F3). */
    installationsList: route(
      {
        method: 'GET',
        path: '/api/releases/:releaseId/installations',
        uuidParams: ['releaseId'],
        body: 'none',
        handle: async ({ session, params }) =>
          json(200, await installations.readInstallations(session, { releaseId: params.releaseId })),
      },
      deps,
    ),

    /* E5 1.4a: the same path as installationsList with POST (O10). JSON { status, losses, assistance };
       Idempotency-Key. 201, and a replay answers the stored report. */
    installationsCreate: route(
      {
        method: 'POST',
        path: '/api/releases/:releaseId/installations',
        uuidParams: ['releaseId'],
        handle: async ({ request, session, params, body }) =>
          json(
            201,
            await installations.reportInstallation(session, {
              releaseId: params.releaseId,
              idempotencyKey: request.headers['idempotency-key'],
              body,
            }),
          ),
      },
      deps,
    ),

    /* E5 1.4b: JSON { status, note }; Idempotency-Key. 201 with the witness and the report it is about. */
    installationsWitness: route(
      {
        method: 'POST',
        path: '/api/installations/:reportId/witness',
        uuidParams: ['reportId'],
        handle: async ({ request, session, params, body }) =>
          json(
            201,
            await installations.witnessInstallation(session, {
              reportId: params.reportId,
              idempotencyKey: request.headers['idempotency-key'],
              body,
            }),
          ),
      },
      deps,
    ),

    /* ---------------------------------------------------------------------------------------------------
       The E6 routes (design 3.4). Eight more operator ones on the operator surface, then five company-facing.
       None carries an Idempotency-Key: every E6 routine is unbound (design 3.3), and a repeat is either a
       set-to-a-value write answering changed: false, a fresh invitation that kills the earlier link, or a
       refusal that says what moved.
       --------------------------------------------------------------------------------------------------- */

    /* Counts only, cut by the twenty-one sections a company document would carry. There is NO operator route
       that returns the document itself (design 1.6, E6D-C-F1a). */
    operatorTakeoutManifest: route(
      {
        method: 'GET',
        path: '/api/operator/companies/:companyId/takeout-manifest',
        uuidParams: ['companyId'],
        body: 'none',
        handle: async ({ session, params }) =>
          json(200, { ok: true, ...(await operator.readExportManifest(session, { companyId: params.companyId })) }),
      },
      deps,
    ),

    /* Suspend and resume. reasonCode is required and is one of three (the lead's decision on E6DB-F4), so the
       audit row says why rather than saying 'operator_request' for every suspension there has ever been. */
    operatorCompanyStatus: route(
      {
        method: 'POST',
        path: '/api/operator/companies/:companyId/status',
        uuidParams: ['companyId'],
        handle: async ({ session, params, body }) =>
          json(200, {
            ok: true,
            ...(await operator.setCompanyStatus(session, {
              companyId: params.companyId,
              status: body.status,
              reasonCode: body.reasonCode,
            })),
          }),
      },
      deps,
    ),

    operatorAccessPeriod: route(
      {
        method: 'POST',
        path: '/api/operator/companies/:companyId/access-period',
        uuidParams: ['companyId'],
        handle: async ({ session, params, body }) =>
          json(200, {
            ok: true,
            ...(await operator.setAccessPeriod(session, {
              companyId: params.companyId,
              startsAt: body.startsAt,
              endsAt: body.endsAt,
              invoiceRef: body.invoiceRef,
            })),
          }),
      },
      deps,
    ),

    operatorCompanyQuota: route(
      {
        method: 'POST',
        path: '/api/operator/companies/:companyId/quotas',
        uuidParams: ['companyId'],
        handle: async ({ session, params, body }) =>
          json(200, {
            ok: true,
            ...(await operator.setQuota(session, {
              companyId: params.companyId,
              name: body.name,
              value: body.value,
            })),
          }),
      },
      deps,
    ),

    /* The succession invitation for a company whose sole administrator is gone. In handover mode the answer
       carries the accept link once, to the operator, which is a customer's first factor in Phaeacia's hands
       until it is used (design 1.1 exception 1). */
    operatorAdminInvitation: route(
      {
        method: 'POST',
        path: '/api/operator/companies/:companyId/admin-invitation',
        uuidParams: ['companyId'],
        handle: async ({ session, params, body }) =>
          json(201, {
            ok: true,
            ...(await operator.inviteAdmin(
              session,
              { companyId: params.companyId, email: body.email, expiresInDays: body.expiresInDays },
              delivery(deps),
            )),
          }),
      },
      deps,
    ),

    operatorCompanyClose: route(
      {
        method: 'POST',
        path: '/api/operator/companies/:companyId/close',
        uuidParams: ['companyId'],
        handle: async ({ session, params, body }) =>
          json(200, {
            ok: true,
            ...(await operator.closeCompany(session, {
              companyId: params.companyId,
              confirmSlug: body.confirmSlug,
              reasonCode: body.reasonCode,
            })),
          }),
      },
      deps,
    ),

    /* The one door. Everything a closed company holds, in one transaction, and its own audit row afterwards with
       company_id null, because the routine deletes that company's audit rows too. */
    operatorCompanyDelete: route(
      {
        method: 'POST',
        path: '/api/operator/companies/:companyId/delete',
        uuidParams: ['companyId'],
        handle: async ({ session, params, body }) =>
          json(200, {
            ok: true,
            ...(await operator.deleteCompany(session, {
              companyId: params.companyId,
              confirmSlug: body.confirmSlug,
              reasonCode: body.reasonCode,
            })),
          }),
      },
      deps,
    ),

    /* Idempotent and bounded per call: a second run finds no company still active past its export_by. It is the
       tidy-up and not the control, because every read boundary tests the time itself (design 1.5, case 38). */
    operatorExpiryRun: route(
      {
        method: 'POST',
        path: '/api/operator/expiry-run',
        handle: async ({ session, body }) =>
          json(200, { ok: true, ...(await operator.runExpiry(session, { limit: body.limit })) }),
      },
      deps,
    ),

    /* Design 1.2's resend: no new routine. api.invite_member runs again with the named row's OWN address and
       roles, which revokes the pending sibling in the same transaction, so THE EARLIER LINK STOPS WORKING. That
       is what the storage makes true and not a policy choice: the token exists only as a SHA-256 hash. */
    invitationsResend: route(
      {
        method: 'POST',
        path: '/api/companies/:companyId/invitations/:invitationId/resend',
        uuidParams: ['companyId', 'invitationId'],
        body: 'none',
        handle: async ({ session, params }) =>
          json(201, {
            ok: true,
            ...(await resendInvitation(
              session,
              { companyId: params.companyId, invitationId: params.invitationId },
              delivery(deps),
            )),
          }),
      },
      deps,
    ),

    /* One read that counts every consequence of a removal before the admin confirms. It is a preview and not a
       promise: a transfer, a role change or a removal can commit between this read and the button. */
    membersDeparture: route(
      {
        method: 'GET',
        path: '/api/companies/:companyId/members/:membershipId/departure',
        uuidParams: ['companyId', 'membershipId'],
        body: 'none',
        handle: async ({ session, params }) =>
          json(200, {
            ok: true,
            ...(await departurePreview(session, {
              companyId: params.companyId,
              membershipId: params.membershipId,
            })),
          }),
      },
      deps,
    ),

    /* The owner at any aal, or a company admin at aal2. expectedOwnerMembershipId is a stale-retry guard and
       never authority: the routine reads the owner from the row it locked (E6D-C-F2). */
    agentsTransfer: route(
      {
        method: 'POST',
        path: '/api/agents/:agentId/transfer',
        uuidParams: ['agentId'],
        handle: async ({ session, params, body }) =>
          json(200, {
            ok: true,
            ...(await agents.transferAgent(session, {
              agentId: params.agentId,
              toMembershipId: body.toMembershipId,
              expectedOwnerMembershipId: body.expectedOwnerMembershipId,
            })),
          }),
      },
      deps,
    ),

    quotasRead: route(
      {
        method: 'GET',
        path: '/api/companies/:companyId/quotas',
        uuidParams: ['companyId'],
        body: 'none',
        handle: async ({ session, params }) =>
          json(200, { ok: true, ...(await readQuotas(session, { companyId: params.companyId })) }),
      },
      deps,
    ),

    /* The company's own document, for its admin at aal2 and nobody else. It loads NO principal (design 1.6): it
       has to work for a suspended company's administrator during the fourteen-day window, so the routine's own
       predicate is the whole of the authorization and the routine carries the window's end itself. The answer is
       buffered twice inside this function and the ceiling is set so that buffering it is affordable. */
    companyTakeout: route(
      {
        method: 'GET',
        path: '/api/companies/:companyId/takeout',
        uuidParams: ['companyId'],
        body: 'none',
        handle: async ({ session, params }) =>
          json(200, { ok: true, ...(await takeout.takeCompanyCopy(session, { companyId: params.companyId })) }),
      },
      deps,
    ),

    /* The mail provider's delivery events (the alerts design 1.4). Any refusal is 401 E_WEBHOOK_INVALID, raised by the
       service; a verified event answers 200 and says nothing about what was done, because the provider needs only
       the acknowledgement. */
    mailEvents: route(
      {
        method: 'POST',
        path: '/api/mail/events',
        session: 'none',
        body: 'signed',
        handle: async ({ request, body }) => {
          await handleMailEvent(
            {
              headers: request.headers,
              rawBody: body,
              route: 'mailEvents',
              requestId: request.headers['x-nf-request-id'],
            },
            deps,
          );
          return json(200, { ok: true });
        },
      },
      deps,
    ),
  };
  for (const [name, handler] of Object.entries(table)) {
    Object.defineProperty(handler, 'routeName', { value: name, enumerable: true });
  }
  return Object.freeze(table);
}
