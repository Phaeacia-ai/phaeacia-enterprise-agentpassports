/* Invitations (E2 design section 4, 4.1, 6 and 8.3; E6 design 1.2): create, resend, revoke, accept.

   createInvitation: admin standing (early), input normalisation, then api.invite_member under the server token,
   then the invitee's account through createInviteeAccount() (the one service-key use in E2), then delivery. The
   invitation code and the link token hash exist in this process only between the database answer and the delivery
   call; they are never stored or logged.

   Design correction (section 4.1, marked there): the emailed link is the server's own accept URL carrying GoTrue's
   token hash, the verification type and the invitation code; the accept page posts the hash to /api/auth/verify
   (server-side verification sets the HTTP-only cookies) and the code to /api/invitations/accept. GoTrue's
   action_link and redirect_to are unused, so no redirect allowlist entry per code is needed and an unlisted
   redirect cannot silently drop the code.

   DELIVERY IS A MODE, and E6 is where it stops being "none" (design 1.2).

     ENTERPRISE_INVITATION_DELIVERY = handover | mail            unset, empty or absent is handover

   In `handover` the server returns the accept link once, in the answer to the call that made it, instead of
   calling a transport; in `mail` it hands the message to the transport and returns no URL. The answer says which ran, so a page
   renders what it was given and never assumes.

   THE ANSWER'S `delivery` IS `handover`, `mail`, `failed` OR `unconfirmed`, AND `acceptUrl` IS PRESENT ONLY FOR
   `handover`, beside `signsIn`, which says whether the link signs in or carries the code only (ENA-7, below) (E7
   design 1.1 and 2.6 item 2; `unconfirmed` added by the E7 mail lane under E7D-C-F7). `failed` and
   `unconfirmed` are outcomes, not modes: in both the invitation row is written and pending, the answer is 201 with
   its ids and no link, and the recovery is the path that already exists, a Resend (or, for the operator's
   administrator invitations, inviting the same address again), which kills whatever link went out.
     failed        nothing went out: GoTrue could not issue the link, the message could not be rendered, or the
                   provider answered and did not accept it, or the request never left (a refused connection).
     unconfirmed   the request left and its answer was lost (the transport's 5 s timeout, a reset or closed
                   connection): the provider may have accepted it, so the invitee may hold the link, and the product
                   must not say it did not go out.
   The pages say one sentence for both ("could not be confirmed as sent ... that also stops any link that did go
   out"), which is true of each, so a page tells the two apart only by the value. Each raises one `delivery_failed`
   alert through deps.alert when that is a function (E7 1.5), with the company id and an error class, never the link,
   the address or the provider's words. The retired 502 E_DELIVERY_FAILED answered after the row was written and lost
   the caller the ids it needed.

   THE ROW RECORDS THE OUTCOME (E6 design 1.2.1, lane K4, XR-7). The row commits before the attempt, so a function
   killed between the two, or a page closed before the answer, used to leave a pending invitation nothing sent and no
   page could tell apart from one that was sent. Every row is written `not_attempted` by its column default, and
   deliverInvitation writes the answer's own word (`handover`, `mail`, `failed` or `unconfirmed`) through
   api.record_invitation_delivery under the caller's own server token before it returns, on all four paths. The
   routine takes the word and the id and nothing else, so no link, code, address or provider text can reach the row.
   A record that fails never changes the answer: the invitation is made and its ids are owed. The row then stays
   `not_attempted`, which the invitation list reports once no live attempt could still be running, so a lost record
   shows instead of hiding. In handover the record lands before the answer that carries the link: `handover` means
   returned to the caller, not seen by them.

   deps.mail IS THE TRANSPORT (lib/services/mail.mjs; E7 1.1), and deps.deliver the test seam. With a transport the
   message is rendered here from lib/services/mail-templates.mjs and only { to, subject, text, tags } crosses into it,
   the tags being `kind: enterprise-invitation`, the company id and the invitation id (the alerts design 1.4 and 1.9: the
   provider hands them back in its delivery events, so a bounce names its company without anything stored); with
   the seam deps.deliver receives { to, acceptUrl, expiresAt, companyName, kind }, as E7 2.6 item 3 fixed it. Both
   answer the same way: resolving is sent, and a throw whose `outcome` is `unconfirmed` is unconfirmed, any other
   throw failed. `companyName` is the company's display name from the caller's own standing (admin paths) or the
   request or company row (operator paths); `kind` is `member` or `administrator` (a member invitation, the second
   when its roles include company_admin, which is the template's role word), `first_admin` (the company's creation)
   or `succession` (the operator's later administrator invitation), the four messages of E7 design 1.1's table. In
   mail mode requireDelivery asks the transport's ready() as well, so a server configured for mail with a missing or
   malformed provider value refuses BEFORE any write with E_MAIL_NOT_CONFIGURED (E7-6). Without the handover mode E6
   could not produce the plan's exit evidence at all: no mail provider is provisioned before E7, so every invitation
   answered 503 E_MAIL_NOT_CONFIGURED and no company could be onboarded. E_MAIL_NOT_CONFIGURED keeps its meaning for
   `mail` mode with no transport supplied, where it still refuses BEFORE any write, so an unconfigured server creates
   nothing.

   What handover delivery is, said plainly rather than implied. A SIGNING link (signsIn: true) signs its holder in as
   the invited address and grants the invitation's roles: it is the whole of that person's first factor, and whoever
   called the route holds it until it is used. For the two operator-issued invitations that caller is a Phaeacia
   person holding a customer's first administrator's first factor (design 1.1 exception 1, section 8 question 7).
   What bounds it: the link is single use, issuance and acceptance are two audit rows naming two different
   principals, and the first admin enrols their own second factor at first sign-in.

   ENA-7 (security review of 2026-09-30; evidence/ena7-end1-hbf2.md section 5): a signing link is handed ONLY for an
   UNCLAIMED account, one nobody has signed in to, and only to the first company whose live invitation claimed it
   (api.claim_invitation_handover, migration 011, under a per-address lock). Until 011 any administrator could be
   handed a signing link for any existing account, the operator's included, by inviting its address. Every other
   handover answer is a CODE-ONLY link (signsIn: false): the invitation code without a token, which signs nobody in;
   the person signs in with their own address first and then accepts. A refused claim makes no GoTrue call at all.

   The five rules that make it safe enough to ship, each enforced here rather than promised:
     1. It is returned ONCE, to the caller, in the answer to the call that made it. Nothing stores it: the database
        holds only digest(token,'sha256') and GoTrue's hashed token, and no read returns either. There is no later
        call that answers it again, and there is no replay that answers it again either: no invitation routine is
        bound, none takes an Idempotency-Key and none writes an app.idempotency_keys row (design 3.3), so a repeat
        of create or resend is a FRESH invitation with a fresh link, which revokes the pending sibling and kills the
        earlier link, both halves of it: its invitation code answers E_INVITATION_INVALID from that moment, and
        its sign-in token is replaced at GoTrue by createInviteeAccount (E6P-F1). A caller who lost the answer
        does not recover the old link; they issue a new one.
     2. It never enters an audit row, a log line, an error body or the exported document.
        app.audit_details_guard has no key that could hold it; this module logs nothing of the answer;
        assembleAcceptUrl builds it and returns it and nothing else touches it; and a delivery failure answers
        `failed` or `unconfirmed` with no link and no text from GoTrue or the transport.
     3. The page states what the link is. That is the pages lane's fixed text, named in design 1.2 rule 3.
     4. E_MAIL_NOT_CONFIGURED is no longer the answer to every invitation, and keeps its meaning for `mail`.
     5. An operator-issued link is a credential held by Phaeacia; lib/services/operator.mjs repeats this where it
        returns one.

   resendInvitation is design 1.2's replacement and adds NO routine: it reads the named invitation under the
   admin's own token (RLS admits admins), refuses an accepted row, and calls api.invite_member again with that
   row's own address and roles. Everything else follows the accepted replacement path, so the earlier link dies.
   That is not a policy choice: the token is stored only as a SHA-256 hash, so the server cannot reproduce the old
   link, and re-sending the same link would mean storing the token in a form the server can read, which is the one
   thing token_hash exists to prevent. */

import { generateLink } from '../db/operator.mjs';
import { callAs } from '../db/server.mjs';
import { select } from '../db/user.mjs';
import { AppError } from '../errors.mjs';
import { KINDS } from '../rules/mail-events.mjs';
import { normalizeRoles } from '../rules/roles.mjs';
import { invitationMail } from './mail-templates.mjs';
import { requireAdminPrincipal } from './members.mjs';
import { isUuid } from './principal.mjs';

const INVITE_CODE = /^[0-9a-f]{64}$/;
const EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const DEFAULT_EXPIRY_DAYS = 7;

/** The two delivery modes of design 1.2. Anything else in the environment is a configuration error, not a default. */
export const DELIVERY_MODES = Object.freeze(['handover', 'mail']);

/** Lower-cased, trimmed; refused when it is not one plain address (spaces, missing domain, over 254 bytes). */
export function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  const e = input.trim().toLowerCase();
  if (e.length === 0 || e.length > 254 || !EMAIL.test(e)) return null;
  return e;
}

/**
 * deliveryMode(): `handover` or `mail`, from ENTERPRISE_INVITATION_DELIVERY.
 * Unset, empty and absent are `handover`, which is E6's default and what makes the slice shippable without a
 * transport (design 1.2). A value that is neither is a configuration error and throws before any write, because
 * silently falling back to handover would return a credential on a server whose operator asked for mail.
 */
export function deliveryMode() {
  const v = process.env.ENTERPRISE_INVITATION_DELIVERY;
  if (typeof v !== 'string' || v.length === 0) return 'handover';
  if (!DELIVERY_MODES.includes(v)) throw new Error('E_CONFIG ENTERPRISE_INVITATION_DELIVERY');
  return v;
}

/** The one service-key call: create the invitee's account (unconfirmed, no password, hook-gated)
 *  or obtain a sign-in link for an existing one. Returns the link material for delivery only.
 *
 *  NO PREVIOUSLY HANDED LINK STAYS LIVE AFTER A REPLACEMENT (E6P-F1 and its Codex critique E6P-F1-C-F1,
 *  evidence/e6p-f1-repro/). GoTrue holds a `signup` token (the email-confirmation column) and a `magiclink`
 *  token (the recovery column) SEPARATELY on one account, and `generate_link` of a given type replaces only
 *  that type's column. A single-type replacement therefore cannot kill a link that landed in the other column,
 *  and both columns do get populated in ordinary use: a brand-new address's first `magiclink` creates the
 *  account with a `signup`-type token, and a second `magiclink` before it is used (two invitations for one
 *  address, or an overlapping retry) lands a `magiclink` token beside it. Both links were handed to whoever
 *  called the route, so both are live credentials, and a resend touching one column left the other usable
 *  (E6P-F1-C-F1, executed: after two overlapping invitations a resend left the earlier link signing in). What
 *  GoTrue v2.192.0 does with each type, observed on the local stack:
 *    signup    on a new address            400 "Signup requires a valid password"; nothing created
 *    signup    on an unconfirmed account   200, verification_type signup, the signup column REPLACED
 *    signup    on a confirmed account      422; nothing changed
 *    magiclink on a new address            200, the account created UNCONFIRMED, verification_type signup
 *    magiclink on any existing account     200, verification_type magiclink, the magiclink column REPLACED
 *  So each issuance refreshes BOTH columns: `signup` first (a no-op 400 on a brand-new address, a 422 on a
 *  confirmed one, a replacement of the signup column on an unconfirmed one that kills any earlier signup link),
 *  then `magiclink` (which creates the account for a new address, replaces the magiclink column for an existing
 *  one, and is the token handed back). Any earlier handed link, in either column, is dead after this call; the
 *  fresh signup-column token the first step may leave is never handed to anyone, is stored only as a hash, and
 *  is cleared when the magiclink is used and the account confirms. `generate_link` is the only creator, so
 *  account creation stays hook-gated to invited addresses (admin create-user is not used: it bypasses the hook)
 *  and the account stays unconfirmed until first sign-in, so the unclaimed-account sweep still catches it. The
 *  hosted GoTrue version is not pinned here: the regression (tests/e6/stack/routes.test.mjs, E6P-F1) is what
 *  re-establishes this on it. */
export async function createInviteeAccount(email, options, { handover = false } = {}) {
  const signup = await generateLink({ email, type: 'signup' }, options);
  if (!signup.ok && signup.status !== 400 && signup.status !== 422) throw new Error(ACCOUNT_LINK_FAILED);
  /* ENA-7 (evidence/ena7-end1-hbf2.md, section 5, D2). In handover mode a confirmed account (422) is never handed a
     token, so the magiclink call is skipped: its token would be thrown away, and it would start GoTrue's resend timer
     on the person's own sign-in link (ENA7-C3). Mail mode makes both calls, because the link goes to the address. */
  if (handover && !signup.ok && signup.status === 422) return { unclaimed: false };
  const r = await generateLink({ email, type: 'magiclink' }, options);
  if (!r.ok) throw new Error(ACCOUNT_LINK_FAILED);
  /* `unclaimed`: GoTrue's own two answers agree that nobody has signed in to the account. Either this call created
     it (signup 400, nothing existed, then a magiclink of type `signup`), or it exists unconfirmed (signup 200). Every
     other pair is not unclaimed, which costs only a code-only link. ok carries no status: a 2xx is the 200 above.
     And the magiclink answer, which carries the account, must still show it unconfirmed: an earlier link used
     between the two calls confirms it, and its fresh token would then sign in to a claimed account (CR-ENA7-3). */
  const unclaimed =
    ((!signup.ok && signup.status === 400 && r.verificationType === 'signup') || signup.ok === true) &&
    r.emailConfirmedAt === null;
  return { hashedToken: r.hashedToken, verificationType: r.verificationType ?? 'magiclink', unclaimed };
}

/* The one fixed word createInviteeAccount fails with: no GoTrue text, no key. deliverInvitation turns it into the
   `failed` answer; nothing else catches it, so a caller outside that path sees a plain Error with this message. */
export const ACCOUNT_LINK_FAILED = 'account_link_failed';

/**
 * acceptOrigin(): ENTERPRISE_ORIGIN as the accept link's origin, or null when it cannot be one: unset, empty, not an
 * absolute http or https URL, or carrying a path, query, fragment or trailing slash (the link is `${origin}/accept#…`,
 * so anything after the host would put a second path or a second fragment into every link). requireDelivery asks
 * this before any write on all four paths and refuses E_MAIL_NOT_CONFIGURED, because a server that cannot build
 * the link cannot complete an invitation in either mode (E7M-C-F2: a missing origin used to commit the row and
 * then answer 500 with no ids). The pipeline's cross-site guard reads the same variable and compares it as text.
 */
export function acceptOrigin() {
  const v = process.env.ENTERPRISE_ORIGIN;
  if (typeof v !== 'string' || v.length === 0) return null;
  let url;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || v.endsWith('/')) return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.origin === v ? v : null;
}

/** The accept URL, built in one place so create, resend and the two operator-issued invitations cannot differ. Without
 *  a hashedToken it carries the invitation code only, which signs nobody in (ENA-7's code-only link): the accept page
 *  then asks the person to sign in with their own address first (web/assets/app/pages/accept.mjs, needs-sign-in). */
export function assembleAcceptUrl({ hashedToken, verificationType, inviteCode }) {
  const origin = acceptOrigin();
  if (origin === null) throw new Error('E_CONFIG ENTERPRISE_ORIGIN');
  if (hashedToken === undefined) return `${origin}/accept#${new URLSearchParams({ invite: inviteCode })}`;
  return `${origin}/accept#${new URLSearchParams({
    token_hash: hashedToken,
    type: verificationType,
    invite: inviteCode,
  })}`;
}

/* A transport is an object with ready() and deliver(); anything else in deps.mail is not one, and the seam decides. */
const hasTransport = (deps) =>
  deps.mail !== undefined &&
  deps.mail !== null &&
  typeof deps.mail.ready === 'function' &&
  typeof deps.mail.deliver === 'function';

/* The two outcomes after a written row that sent nothing known: one alert when a sink is wired, and the answer. The
   fields are the company id and a fixed error class, plus the transport's network code when it gave one from its
   fixed list; lib/http/alerts.mjs shapes them again. An alert that throws never changes the answer. */
async function undelivered(delivery, { companyId, error }, deps) {
  if (typeof deps.alert === 'function') {
    const fields = { errorName: error?.name === 'MailError' ? 'MailError' : 'Error' };
    if (typeof companyId === 'string') fields.companyId = companyId;
    if (error?.name === 'MailError' && typeof error.code === 'string') fields.code = error.code;
    try {
      await deps.alert('delivery_failed', fields, deps);
    } catch {
      /* the answer stands; the function log keeps the pipeline's own line */
    }
  }
  return { delivery };
}

/* The tags an invitation mail carries (the alerts design 1.9): the kind always, the company and the invitation when
   each is a uuid, which every one of the four paths passes from its routine's own answer. A value that is not a uuid
   is left out rather than sent, so a tag can never carry anything but an id. */
function invitationTags(companyId, invitationId) {
  const tags = { kind: KINDS.invitation };
  if (isUuid(companyId)) tags.company = companyId;
  if (isUuid(invitationId)) tags.invitation = invitationId;
  return tags;
}

/* The outcome onto the row (E6 design 1.2.1): one unbound call under the caller's own server token, skipped when
   there is no session or no invitation id to name. Everything it could throw is swallowed, because the answer it
   follows is already true and owed; the routine writes once, so a repeat cannot overwrite an outcome. */
async function recordDelivery(session, invitationId, delivery, options) {
  if (session === null || session === undefined || !isUuid(invitationId)) return;
  try {
    await callAs(session, 'record_invitation_delivery', { p_invitation: invitationId, p_delivery: delivery }, options);
  } catch {
    /* the row stays not_attempted and the invitation list says nothing confirms it */
  }
}

/**
 * deliverInvitation({ email, inviteCode, expiresAt, companyName, kind, companyId, invitationId, session }, deps, options)
 *   -> { delivery: 'handover', acceptUrl } | { delivery: 'mail' } | { delivery: 'failed' } | { delivery: 'unconfirmed' }
 * The last hop, shared by createInvitation, resendInvitation and lib/services/operator.mjs's two operator-issued
 * invitations, so all four answer the same shapes (E6 design 1.2; E7 design 1.1). The account and the link are made
 * either way: the account is what makes the address able to sign in at all, and the mode decides only who receives
 * the link. A failure here, at GoTrue, in rendering or at the transport, is `failed` or `unconfirmed` (the header):
 * the row is already written, so an error would lose the caller its ids for nothing (E7D-1). The message is rendered
 * from the answer of the call that made this invitation and from nothing stored, because nothing stores a link, so a
 * resend cannot expose an earlier one (E7 1.1). `session` is the caller's, and the outcome is recorded on the row
 * under it before the answer returns (E6 design 1.2.1); without one nothing is recorded and the answer is the same.
 */
export async function deliverInvitation({ session = null, ...invitation }, deps = {}, options) {
  const answer = await attemptDelivery(invitation, session, deps, options);
  await recordDelivery(session, invitation.invitationId, answer.delivery, options);
  return answer;
}

/* ENA-7's claim (migration 011, api.claim_invitation_handover): true only when this caller issued the invitation, the
   address's account is unclaimed and no other company claimed a signing link for it within a link's life. A missing
   session or id is refused here, as the routine would refuse it. A call that FAILS is not a refusal and is not caught:
   it reaches handOver's catch and answers `failed`, with the ids and the alert, as a GoTrue failure does (CR-ENA7-2).
   Read as a refusal, an outage or an app deployed before 011 would answer a code-only link that, for a new address,
   no account stands behind, and nobody would learn of it. */
async function claimHandover(session, invitationId, options) {
  if (session === null || session === undefined || !isUuid(invitationId)) return false;
  return (await callAs(session, 'claim_invitation_handover', { p_invitation: invitationId }, options)) === true;
}

/* Handover (E6 design 1.2, as ENA-7 narrows it; evidence/ena7-end1-hbf2.md section 5, D2). The answer is
   { delivery: 'handover', acceptUrl, signsIn }. signsIn is true only when the claim was granted AND GoTrue agrees the
   account is unclaimed; then the link carries the sign-in token, as before. Otherwise the link carries the invitation
   code only. When the claim is refused, no GoTrue call is made at all, so no other company's handed token is replaced
   and the person's own sign-in link is not held back. A failed claim call, or a GoTrue failure after a granted claim,
   is `failed`, as a GoTrue failure was before. */
async function handOver({ email, inviteCode, companyId, invitationId }, session, deps, options) {
  let acceptUrl;
  let signsIn = false;
  try {
    if (await claimHandover(session, invitationId, options)) {
      const account = await createInviteeAccount(email, options, { handover: true });
      if (account.unclaimed === true) {
        acceptUrl = assembleAcceptUrl({
          hashedToken: account.hashedToken,
          verificationType: account.verificationType,
          inviteCode,
        });
        signsIn = true;
      }
    }
    acceptUrl ??= assembleAcceptUrl({ inviteCode });
  } catch (error) {
    return undelivered('failed', { companyId, error }, deps);
  }
  return { delivery: 'handover', acceptUrl, signsIn };
}

async function attemptDelivery(
  { email, inviteCode, expiresAt, companyName = null, kind = 'member', companyId = null, invitationId = null },
  session,
  deps,
  options,
) {
  const mode = deliveryMode();
  if (mode === 'handover') return handOver({ email, inviteCode, companyId, invitationId }, session, deps, options);
  let acceptUrl;
  try {
    const account = await createInviteeAccount(email, options);
    /* Inside the post-write boundary with the GoTrue call: requireDelivery checked the origin before the write,
       and a configuration that changed between the two still answers `failed` with the ids, never 500 (E7M-C-F2). */
    acceptUrl = assembleAcceptUrl({
      hashedToken: account.hashedToken,
      verificationType: account.verificationType,
      inviteCode,
    });
  } catch (error) {
    return undelivered('failed', { companyId, error }, deps);
  }
  try {
    if (hasTransport(deps)) {
      const { subject, text } = invitationMail({ kind, companyName, acceptUrl, expiresAt });
      await deps.mail.deliver({ to: email, subject, text, tags: invitationTags(companyId, invitationId) });
    } else {
      await deps.deliver({ to: email, acceptUrl, expiresAt, companyName, kind });
    }
  } catch (error) {
    return undelivered(error?.outcome === 'unconfirmed' ? 'unconfirmed' : 'failed', { companyId, error }, deps);
  }
  return { delivery: 'mail' };
}

/* In `mail` mode with no transport supplied nothing is written, which is design 1.2 rule 4 and E2's own behaviour
   for the mode it was the only one of. In `handover` no transport is needed and none is asked for.
   EXPORTED since E6S-C-F8: lib/services/operator.mjs's two operator-issued invitations called deliverInvitation
   after their database transaction and never this guard, so a server configured for mail with no transport
   COMMITTED the company, its access period and a live invitation secret and then answered 502. The guard is one
   call and belongs in front of every one of the four invitation paths, not three of them.
   E7 1.1: a transport (deps.mail) is asked whether it is ready; without one, the seam (deps.deliver) must be a
   function and, when a ready() is supplied beside it, ready. Either way an unready configuration refuses here, before
   any read or write (E7-6). */
export function requireDelivery(deps) {
  /* Both modes build the link, so the origin is a delivery precondition in both, checked before any write. */
  if (acceptOrigin() === null) throw new AppError('E_MAIL_NOT_CONFIGURED');
  if (deliveryMode() !== 'mail') return;
  if (hasTransport(deps)) {
    if (deps.mail.ready() !== true) throw new AppError('E_MAIL_NOT_CONFIGURED');
    return;
  }
  if (typeof deps.deliver !== 'function') throw new AppError('E_MAIL_NOT_CONFIGURED');
  if (typeof deps.ready === 'function' && deps.ready() !== true) throw new AppError('E_MAIL_NOT_CONFIGURED');
}

export async function createInvitation(session, { companyId, email, roles, expiresInDays }, deps = {}, options) {
  requireDelivery(deps);
  const principal = await requireAdminPrincipal(session, companyId, options);
  const emailN = normalizeEmail(email);
  if (!emailN) throw new AppError('E_EMAIL_INVALID');
  const n = normalizeRoles(roles ?? []);
  if (!n.ok) throw new AppError('E_ROLES_INVALID');
  const days = expiresInDays === undefined ? DEFAULT_EXPIRY_DAYS : expiresInDays;
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new AppError('E_EXPIRY_INVALID');
  const [row] = await callAs(
    session,
    'invite_member',
    { p_company: companyId, p_email: emailN, p_roles: n.roles, p_expires_in: `${days} days` },
    options,
  );
  const delivered = await deliverInvitation(
    {
      session,
      email: emailN,
      inviteCode: row.invite_code,
      expiresAt: row.expires_at,
      companyName: principal.companyName ?? null,
      kind: n.roles.includes('company_admin') ? 'administrator' : 'member',
      companyId,
      invitationId: row.invitation_id,
    },
    deps,
    options,
  );
  return { invitationId: row.invitation_id, expiresAt: row.expires_at, ...delivered };
}

/**
 * resendInvitation(session, { companyId, invitationId }, deps)
 *   -> { invitationId, expiresAt, replacesInvitationId, delivery, acceptUrl? }
 * Design 1.2: no new routine. The row is read under the admin's own token, so RLS decides whether it is visible at
 * all, and a row of another company answers the same 404 as an unknown one. Rows 10 to 13 of design 3.5's table for
 * this route are the four refusals below, in that order; everything from row 14 is api.invite_member's own, which
 * is where the seat and pending-invitation bounds live and where the pending sibling is revoked in the same
 * transaction. The new row carries this row's OWN address and roles, so a resend cannot quietly change either.
 */
export async function resendInvitation(session, { companyId, invitationId, expiresInDays }, deps = {}, options) {
  requireDelivery(deps);
  const principal = await requireAdminPrincipal(session, companyId, options);
  if (!isUuid(invitationId)) throw new AppError('E_NOT_FOUND');
  const rows = await select(
    session,
    'invitations',
    { select: 'id,company_id,email_normalized,roles,accepted_at', id: `eq.${invitationId}` },
    options,
  );
  const row = rows[0];
  if (rows.length !== 1 || row?.company_id !== companyId) throw new AppError('E_NOT_FOUND');
  if (row.accepted_at !== null && row.accepted_at !== undefined) throw new AppError('E_INVITATION_ACCEPTED');
  const emailN = normalizeEmail(row.email_normalized);
  if (!emailN) throw new AppError('E_INTERNAL');
  const n = normalizeRoles(row.roles ?? []);
  if (!n.ok) throw new AppError('E_INTERNAL');
  const days = expiresInDays === undefined ? DEFAULT_EXPIRY_DAYS : expiresInDays;
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new AppError('E_EXPIRY_INVALID');
  const [created] = await callAs(
    session,
    'invite_member',
    { p_company: companyId, p_email: emailN, p_roles: n.roles, p_expires_in: `${days} days` },
    options,
  );
  const delivered = await deliverInvitation(
    {
      session,
      email: emailN,
      inviteCode: created.invite_code,
      expiresAt: created.expires_at,
      companyName: principal.companyName ?? null,
      kind: n.roles.includes('company_admin') ? 'administrator' : 'member',
      companyId,
      invitationId: created.invitation_id,
    },
    deps,
    options,
  );
  return {
    invitationId: created.invitation_id,
    expiresAt: created.expires_at,
    replacesInvitationId: invitationId,
    ...delivered,
  };
}

export async function revokeInvitation(session, { companyId, invitationId }, options) {
  await requireAdminPrincipal(session, companyId, options);
  if (!isUuid(invitationId)) throw new AppError('E_NOT_FOUND');
  const rows = await select(
    session,
    'invitations',
    { select: 'id', id: `eq.${invitationId}`, company_id: `eq.${companyId}` },
    options,
  );
  if (rows.length !== 1) throw new AppError('E_NOT_FOUND');
  const [row] = await callAs(session, 'revoke_invitation', { p_invitation: invitationId }, options);
  return { invitationId: row.invitation_id, changed: row.changed === true };
}

export async function acceptInvitation(session, { inviteCode }, options) {
  const code = typeof inviteCode === 'string' ? inviteCode.trim().toLowerCase() : '';
  if (!INVITE_CODE.test(code)) throw new AppError('E_INVITATION_INVALID');
  const [row] = await callAs(session, 'accept_invitation', { p_invite_code: code }, options);
  return {
    companyId: row.company_id,
    membershipId: row.membership_id,
    roles: row.roles,
    reactivated: row.reactivated === true,
  };
}
