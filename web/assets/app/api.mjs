/* The one module under web/ that talks to the service (pages design section 3, rules 2, 6 and 7).

   Requests (rule 2). send() is the only caller of fetch under web/ (scripts/check-web.mjs refuses the word anywhere
   else, and the journeys assert that every /api/ request's initiator frame is this file). It accepts only paths
   beginning /api/ and sends credentials same-origin, cache no-store, redirect error, accept application/json, and a
   content type of application/json only with a body, which is JSON.stringify of a plain object. A caller may add a
   request header only from a closed set, idempotency-key for E4 (E4 design 4.3) and if-match for the E3 intake pages;
   any other name throws before anything is sent, so the request shape stays checkable. One other shape exists, the
   passport request of the intake pages (passportInit): the author's bytes as a string or a Blob with content-type
   text/markdown and its own closed set of four headers. A failed answer that carries a content gate refusal's list
   returns it as `problems`, each problem's code, line and kind and nothing else. An E_INTERNAL answer returns its
   `requestId` (lane K2, XR-12) only when the value has the request id's shape, for the failure view to show; no other
   code returns one. An E_MFA_ATTEMPTS_EXHAUSTED answer returns its `retryAfter` (HB-F2, migration 012) only when the
   value is an ISO time in UTC, the window's end the failure view shows; no other code returns one.

   Bound writes (E4 design 3.3 and 4.2). writeAttempt() gives one attempt of a write its Idempotency-Key, made once with
   crypto.randomUUID() at the attempt's first send and sent again on every retry of the same attempt, so a retry after a
   lost answer reaches the stored answer (idempotentReplay) instead of writing twice. A page makes a new attempt for each
   request it composes. The one repeat of rule 6 resends the same headers, and so the same key.

   Refresh (rule 6). An answer of 401 E_UNAUTHENTICATED causes one POST /api/auth/refresh through one shared promise,
   so a burst of such answers causes one refresh; on 204 the original call is repeated once. When the refresh is
   refused the page moves to /signin/?reason=expired. No other status or code causes a refresh. Two narrowings the
   design leaves unstated, each chosen for the reason discovery gives: a refresh answering 503 or failing on the
   network is returned to the page as that failure and does not navigate, because an outage says nothing about the
   session; and a repeat that answers 401 again after a 204 refresh moves to sign-in without a second refresh. A call
   whose request was sent before another call's refresh completed repeats without refreshing again.

   Session discovery (rule 6). discoverSession() is the first call of exactly three landings, /, /signin/ and
   /accept/. It refreshes once on 401 E_UNAUTHENTICATED like the ordinary path, never navigates, and answers
   { signedIn: true, me }, { signedIn: false }, { unavailable: true, code } for a 503 or a network failure, or
   { error } for an answer the contract does not name, which the landing shows as its retry state.

   The session-call queue (rule 6). The calls that change the session, link verification, factor verification, factor
   removal, sign-out and the refresh itself, run one at a time in this page, so a refresh never overlaps a factor
   verification. When the page navigates, queued work that has not started is discarded and answers { action:
   'navigating' }, and no answer that arrives afterwards is acted on. A page restored from the back-forward cache keeps
   this module's state, so the restore clears that stop again (shell.mjs onRestore; journey J12 found a restored members
   page that could neither refresh nor move to sign-in without it).

   Codes (rule 7). actionFor() is the table from a code to an action and never to text; the page shows the server's
   message as sent. A code this table does not name gets the message alone. The reload action (E4 design 4.2) means the
   work has moved on since the page read it: the page reads its data again and shows where the work now is. */

import { navigate, onNavigate, onRestore } from './shell.mjs';

const ACTIONS = {
  E_UNAUTHENTICATED: 'sign-in',
  E_MAINTENANCE: 'maintenance',
  E_SESSION_UNAVAILABLE: 'retry',
  E_MFA_UNAVAILABLE: 'retry',
  E_BUSY: 'retry',
  E_RATE_LIMITED: 'retry',
  E_INTERNAL: 'retry',
  E_ADMIN_MFA_REQUIRED: 'mfa',
  E_MFA_STEP_UP_REQUIRED: 'mfa',
  /* E6 design 4.1: an operator page asks and the refusal routes it, so an operator at aal1 is sent to /mfa/ by the
     server's answer and not by anything the page read. Design 4.1 and 4.2 said this row was here; the lead's contract
     landing (design 2.6 item 7) missed it, and the E6 pages lane added it under the lead's grant. E_NOT_OPERATOR is
     not in this table: it shows its message, and the operator pages render it as their not-found state. */
  E_OPERATOR_MFA_REQUIRED: 'mfa',
  E_NOT_FOUND: 'not-found',
  E_EMAIL_MISMATCH: 'sign-out',
  E_IDEMPOTENCY_EXPIRED: 'reload',
  E_IDEMPOTENCY_CONFLICT: 'reload',
  E_NOT_REVIEWABLE: 'reload',
  E_ALREADY_SIGNED: 'reload',
  E_ENVELOPE_CLOSED: 'reload',
  E_ENVELOPE_APPROVED: 'reload',
  E_ALREADY_WITHDRAWN: 'reload',
  E_CANDIDATE_SUPERSEDED: 'reload',
  /* E5 design 4.2: the work has moved on since the page read it, so the page reads its data again. A withdrawal or a
     supersession between the read and the press, a per-recipient report ceiling reached, and a report this membership
     has already witnessed are all states the page can only show correctly by reading again. E_TARGET_NOT_PUBLISHABLE
     and E_NOT_DOWNLOADED are deliberately not here: they show their message beside the control that caused them. */
  E_RELEASE_WITHDRAWN: 'reload',
  E_RELEASE_SUPERSEDED: 'reload',
  E_REPORT_LIMIT: 'reload',
  E_ALREADY_WITNESSED: 'reload',
  /* E6 design 2.6 item 7 as corrected, landed by the lead before construction: an owner changed by somebody else, the
     last seat or the last open invitation taken, and a company closed since the page read it are states the page shows
     correctly only by reading again. E_COMPANY_INACTIVE and E_ACCESS_PERIOD_ENDED are deliberately not here: a read
     answers them too, so a reload would say the same thing, and they show their message. */
  E_OWNER_CHANGED: 'reload',
  E_SEATS_EXHAUSTED: 'reload',
  E_INVITATION_LIMIT: 'reload',
  E_COMPANY_CLOSED: 'reload',
};

/** actionFor(code) -> 'sign-in' | 'maintenance' | 'retry' | 'mfa' | 'not-found' | 'sign-out' | 'reload' | 'message'. A
    missing code (a network failure, or an answer that is not the service's JSON) is 'retry'. */
export function actionFor(code) {
  if (code === null || code === undefined) return 'retry';
  return Object.hasOwn(ACTIONS, code) ? ACTIONS[code] : 'message';
}

/* The request headers a caller may add (E4 design 4.3). The E3 intake pages add if-match, which the submit route reads
   beside its JSON body (docs/e3/intake-pages-design.md section 4); the agent headers go on a passport request only. */
const REQUEST_HEADERS = new Set(['idempotency-key', 'if-match']);
/* A passport request (E3 design 4.4 and 4.6): the raw bytes the author gave, as a string or a Blob, never JSON, with
   the content type the route requires set here because a browser sends none for a .md file it does not know (E3 4.5
   row 7). The headers it may carry are these four and no other. */
const PASSPORT_HEADERS = new Set(['idempotency-key', 'if-match', 'x-agent-name', 'x-agent-id']);
const PASSPORT_TYPE = 'text/markdown';

/* The request id's shape, lib/http/alerts.mjs ALERT_FIELDS.requestId copied, since nothing under web/ imports lib/
   (scripts/check-imports.mjs). The server echoes only a value of this shape; the page checks it again because it is
   shown to the person. */
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;
/* HB-F2: the window's end lib/services/factor-bound.mjs answers, Date.prototype.toISOString's shape. */
const RETRY_AFTER = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const NETWORK = Object.freeze({ ok: false, status: 0, code: null, message: null, action: 'retry', network: true });
const NAVIGATING = Object.freeze({ ok: false, status: 0, code: null, message: null, action: 'navigating' });

let leaving = false;
let queue = Promise.resolve();
let refreshing = null;
let refreshed = 0;

onNavigate(() => {
  leaving = true;
});
onRestore(() => {
  leaving = false;
});

function enqueue(task) {
  const run = queue.then(() => (leaving ? NAVIGATING : task()));
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** requestInit(method, body, headers): the request of rule 2 with the admitted headers. Throws TypeError for a header
    name outside the closed set, a header value that is not a string, or a body that is not a plain object. */
export function requestInit(method, body, headers = {}) {
  const init = {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: { accept: 'application/json' },
  };
  for (const [name, value] of Object.entries(headers)) {
    if (!REQUEST_HEADERS.has(name) || typeof value !== 'string')
      throw new TypeError(`api.mjs: the request header ${name} is not admitted`);
    init.headers[name] = value;
  }
  if (body !== undefined) {
    if (body === null || typeof body !== 'object' || Object.getPrototypeOf(body) !== Object.prototype)
      throw new TypeError('api.mjs: a body is a plain object');
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return init;
}

/** passportInit(method, passport, headers): the request of rule 2 carrying a passport, a string or a Blob sent as it is,
    with the admitted passport headers and content-type text/markdown. Throws TypeError for anything else. */
export function passportInit(method, passport, headers = {}) {
  if (typeof passport !== 'string' && !(typeof Blob === 'function' && passport instanceof Blob))
    throw new TypeError('api.mjs: a passport is a string or a Blob');
  const init = {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: { accept: 'application/json' },
  };
  for (const [name, value] of Object.entries(headers)) {
    if (!PASSPORT_HEADERS.has(name) || typeof value !== 'string')
      throw new TypeError(`api.mjs: the request header ${name} is not admitted on a passport request`);
    init.headers[name] = value;
  }
  init.headers['content-type'] = PASSPORT_TYPE;
  init.body = passport;
  return init;
}

/* A content gate refusal's list (E3 design 3.5): each problem's code, its line, and for E_SECRET_FOUND its kind, the
   three the server sends and nothing else it might add. Null when the answer carries no list. */
function problemsIn(data) {
  if (!Array.isArray(data?.problems)) return null;
  return data.problems
    .filter((p) => p !== null && typeof p === 'object' && typeof p.code === 'string')
    .map((p) => ({
      code: p.code,
      line: Number.isInteger(p.line) ? p.line : null,
      ...(typeof p.kind === 'string' ? { kind: p.kind } : {}),
    }));
}

async function send(method, path, body, headers = {}, passport = false) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) throw new TypeError('api.mjs: only /api/ paths');
  const init = passport ? passportInit(method, body, headers) : requestInit(method, body, headers);
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    return NETWORK;
  }
  const status = response.status;
  let data = null;
  let readable = status === 204;
  if (status !== 204) {
    try {
      data = await response.json();
      readable = typeof data === 'object' && data !== null;
    } catch {
      readable = false;
    }
  }
  if (status >= 200 && status < 300 && readable) return { ok: true, status, data };
  const code = readable && typeof data.code === 'string' ? data.code : null;
  const message = readable && typeof data.message === 'string' ? data.message : null;
  const problems = readable ? problemsIn(data) : null;
  const id = code === 'E_INTERNAL' ? data.requestId : undefined;
  const requestId = typeof id === 'string' && REQUEST_ID.test(id) ? id : null;
  const until = code === 'E_MFA_ATTEMPTS_EXHAUSTED' ? data.retryAfter : undefined;
  const retryAfter = typeof until === 'string' && RETRY_AFTER.test(until) ? until : null;
  return {
    ok: false,
    status,
    code,
    message,
    action: actionFor(code),
    ...(problems ? { problems } : {}),
    ...(requestId ? { requestId } : {}),
    ...(retryAfter ? { retryAfter } : {}),
  };
}

const unauthenticated = (r) => r.status === 401 && r.code === 'E_UNAUTHENTICATED';
const unavailable = (r) => r.network === true || r.status === 503;

function refreshOnce() {
  if (!refreshing) {
    refreshing = enqueue(() => send('POST', '/api/auth/refresh')).then((r) => {
      refreshing = null;
      if (r.ok) refreshed += 1;
      return r;
    });
  }
  return refreshing;
}

function expire() {
  navigate('/signin/?reason=expired');
  return NAVIGATING;
}

async function call(method, path, { body, passport, changesSession = false, headers } = {}) {
  const raw = passport !== undefined;
  const payload = raw ? passport : body;
  const attempt = () =>
    changesSession ? enqueue(() => send(method, path, payload, headers, raw)) : send(method, path, payload, headers, raw);
  const before = refreshed;
  const first = await attempt();
  if (leaving) return NAVIGATING;
  if (!unauthenticated(first)) return first;
  if (refreshed === before) {
    const r = await refreshOnce();
    if (leaving) return NAVIGATING;
    if (!r.ok) return unavailable(r) ? r : expire();
  }
  const repeat = await attempt();
  if (leaving) return NAVIGATING;
  return unauthenticated(repeat) ? expire() : repeat;
}

/** discoverSession(): the non-navigating first call of a landing. An unavailable answer also carries the failed
    answer, so the landing can show the server's message beside its retry. */
export async function discoverSession() {
  const first = await send('GET', '/api/me');
  if (first.ok) return { signedIn: true, me: first.data };
  if (unavailable(first)) return { unavailable: true, code: first.code, answer: first };
  if (!unauthenticated(first)) return { error: first };
  const r = await refreshOnce();
  if (!r.ok) {
    if (unavailable(r)) return { unavailable: true, code: r.code, answer: r };
    return r.status === 401 ? { signedIn: false } : { error: r };
  }
  const repeat = await send('GET', '/api/me');
  if (repeat.ok) return { signedIn: true, me: repeat.data };
  if (unauthenticated(repeat)) return { signedIn: false };
  if (unavailable(repeat)) return { unavailable: true, code: repeat.code, answer: repeat };
  return { error: repeat };
}

/** writeAttempt(sendWith) -> run(): one attempt of a bound write. run() calls sendWith(key) with the attempt's key, made
    with crypto.randomUUID() on the first run and the same on every later run of this attempt. */
export function writeAttempt(sendWith) {
  let key = null;
  return () => {
    key ??= crypto.randomUUID();
    return sendWith(key);
  };
}

/** The step-up decision: any verified factor in the list, which the server already limits to supported types. It is
    never a comparison with one type name, so a second factor type needs no change here (section 8.1, scenario B). */
export function hasVerifiedFactor(factors) {
  return Array.isArray(factors) && factors.some((f) => f !== null && typeof f === 'object' && f.status === 'verified');
}

/** The forced-enrolment rule (section 1, D1 as corrected; Q4 admins only). An identity holding company_admin in any
    active membership and no verified factor is moved to /mfa/ before a page requests or shows company data. Answers
    { moved: true }, { moved: false, factors } with the factor list when it was read, or { moved: false, answer } when
    the factor read failed. Presentation only: the database refuses every administrator action without aal2. */
export async function sendAdminsToEnrolment(identity) {
  const admin = (identity?.memberships ?? []).some((m) => Array.isArray(m.roles) && m.roles.includes('company_admin'));
  if (!admin) return { moved: false, factors: null };
  const list = await factors();
  if (!list.ok) return { moved: false, answer: list };
  if (hasVerifiedFactor(list.data.factors)) return { moved: false, factors: list.data };
  navigate('/mfa/');
  return { moved: true };
}

const segment = (value) => encodeURIComponent(String(value));
const keyed = (key) => ({ 'idempotency-key': key });

export const me = () => call('GET', '/api/me');
export const factors = () => call('GET', '/api/auth/factors');
export const startSignIn = (email) => call('POST', '/api/auth/start', { body: { email } });
export const verifyLink = (tokenHash, type) =>
  call('POST', '/api/auth/verify', { body: { tokenHash, type }, changesSession: true });
export const enrollFactor = () => call('POST', '/api/auth/factors/totp');
export const verifyFactor = (factorId, code) =>
  call('POST', `/api/auth/factors/${segment(factorId)}/verify`, { body: { code }, changesSession: true });
export const removeFactor = (factorId) =>
  call('DELETE', `/api/auth/factors/${segment(factorId)}`, { changesSession: true });
export const setDisplayName = (displayName) => call('PUT', '/api/me/display-name', { body: { displayName } });
export const members = (companyId) => call('GET', `/api/companies/${segment(companyId)}/members`);
export const invitations = (companyId) => call('GET', `/api/companies/${segment(companyId)}/invitations`);
export const invite = (companyId, { email, roles, expiresInDays }) =>
  call('POST', `/api/companies/${segment(companyId)}/invitations`, { body: { email, roles, expiresInDays } });
export const revokeInvitation = (companyId, invitationId) =>
  call('POST', `/api/companies/${segment(companyId)}/invitations/${segment(invitationId)}/revoke`);
export const setRoles = (companyId, membershipId, roles) =>
  call('PATCH', `/api/companies/${segment(companyId)}/members/${segment(membershipId)}/roles`, { body: { roles } });
export const removeMember = (companyId, membershipId) =>
  call('DELETE', `/api/companies/${segment(companyId)}/members/${segment(membershipId)}`);
export const acceptInvitation = (inviteCode) => call('POST', '/api/invitations/accept', { body: { inviteCode } });

/* E4 design 3.4. The three writes that take a key are bound writes; group changes follow E2's retry model and take none. */
export const reviewQueue = (companyId) => call('GET', `/api/companies/${segment(companyId)}/review-queue`);
export const review = (candidateId) => call('GET', `/api/candidates/${segment(candidateId)}/review`);
export const proposeEnvelope = (candidateId, { target, audienceGroupIds, policyId }, key) =>
  call('POST', `/api/candidates/${segment(candidateId)}/envelopes`, {
    body: { target, audienceGroupIds, policyId },
    headers: keyed(key),
  });
export const recordReview = (candidateId, { envelopeId, role, decision, reason }, key) =>
  call('POST', `/api/candidates/${segment(candidateId)}/reviews`, {
    body: { envelopeId, role, decision, reason },
    headers: keyed(key),
  });
export const publishRelease = (candidateId, envelopeId, key) =>
  call('POST', `/api/candidates/${segment(candidateId)}/releases`, { body: { envelopeId }, headers: keyed(key) });
export const withdrawRelease = (releaseId, reason, key) =>
  call('POST', `/api/releases/${segment(releaseId)}/withdraw`, { body: { reason }, headers: keyed(key) });
export const release = (releaseId) => call('GET', `/api/releases/${segment(releaseId)}`);
export const releases = (companyId, cursor = null) =>
  call('GET', `/api/companies/${segment(companyId)}/releases${cursor === null ? '' : `?cursor=${segment(cursor)}`}`);
export const groups = (companyId) => call('GET', `/api/companies/${segment(companyId)}/groups`);
export const createGroup = (companyId, name) => call('POST', `/api/companies/${segment(companyId)}/groups`, { body: { name } });
export const addGroupMember = (companyId, groupId, membershipId) =>
  call('PUT', `/api/companies/${segment(companyId)}/groups/${segment(groupId)}/members/${segment(membershipId)}`);
export const removeGroupMember = (companyId, groupId, membershipId) =>
  call('DELETE', `/api/companies/${segment(companyId)}/groups/${segment(groupId)}/members/${segment(membershipId)}`);

/* E5 design 3.4. The catalog and the installations list are reads; the download takes no Idempotency-Key by the
   decision of design 1.2, because a repeat is a true second authorization and is answered as one; the report and the
   witness are bound writes and take one key per attempt, reused on that attempt's retry (writeAttempt). */
export const catalog = (companyId, cursor = null) =>
  call('GET', `/api/companies/${segment(companyId)}/catalog${cursor === null ? '' : `?cursor=${segment(cursor)}`}`);
export const download = (releaseId) => call('POST', `/api/releases/${segment(releaseId)}/download`);
export const installations = (releaseId) => call('GET', `/api/releases/${segment(releaseId)}/installations`);
export const reportInstallation = (releaseId, { status, losses, assistance }, key) =>
  call('POST', `/api/releases/${segment(releaseId)}/installations`, {
    body: { status, losses, assistance },
    headers: keyed(key),
  });
export const witnessInstallation = (reportId, { status, note }, key) =>
  call('POST', `/api/installations/${segment(reportId)}/witness`, { body: { status, note }, headers: keyed(key) });

/* E6 design 3.4 and 4.1, as built (evidence/e6-services.md 5.1 and 5.2). No E6 route takes an Idempotency-Key (design
   3.3): each write is a set-to-a-value that answers changed: false on a repeat, a fresh invitation that stops the
   earlier link, or a refusal that says what moved. The route names say takeout where the design used the word the
   module-statement gate refuses outside a statement (evidence/e6-services.md 5.1); the word a person reads is the
   page's. */
export const operatorCompanies = (cursor = null) =>
  call('GET', `/api/operator/companies${cursor === null ? '' : `?cursor=${segment(cursor)}`}`);
export const createCompany = ({ slug, name, firstAdminEmail, expiresInDays, startsAt, endsAt, invoiceRef }) =>
  call('POST', '/api/operator/companies', {
    body: { slug, name, firstAdminEmail, expiresInDays, startsAt, endsAt, invoiceRef },
  });
export const takeoutManifest = (companyId) =>
  call('GET', `/api/operator/companies/${segment(companyId)}/takeout-manifest`);
export const setCompanyStatus = (companyId, { status, reasonCode }) =>
  call('POST', `/api/operator/companies/${segment(companyId)}/status`, { body: { status, reasonCode } });
export const setAccessPeriod = (companyId, { startsAt, endsAt, invoiceRef }) =>
  call('POST', `/api/operator/companies/${segment(companyId)}/access-period`, { body: { startsAt, endsAt, invoiceRef } });
export const setCompanyQuota = (companyId, { name, value }) =>
  call('POST', `/api/operator/companies/${segment(companyId)}/quotas`, { body: { name, value } });
export const inviteAdministrator = (companyId, { email, expiresInDays }) =>
  call('POST', `/api/operator/companies/${segment(companyId)}/admin-invitation`, { body: { email, expiresInDays } });
export const grantAdministrator = (companyId, userId) =>
  call('POST', `/api/operator/companies/${segment(companyId)}/transfer-first-admin`, { body: { userId } });
export const closeCompany = (companyId, { confirmSlug, reasonCode }) =>
  call('POST', `/api/operator/companies/${segment(companyId)}/close`, { body: { confirmSlug, reasonCode } });
export const deleteCompany = (companyId, { confirmSlug, reasonCode }) =>
  call('POST', `/api/operator/companies/${segment(companyId)}/delete`, { body: { confirmSlug, reasonCode } });
export const expiryRun = () => call('POST', '/api/operator/expiry-run', { body: {} });
/* The company-facing five. The resend's route reads no body, so none is sent. */
export const resendInvitation = (companyId, invitationId) =>
  call('POST', `/api/companies/${segment(companyId)}/invitations/${segment(invitationId)}/resend`);
export const departure = (companyId, membershipId) =>
  call('GET', `/api/companies/${segment(companyId)}/members/${segment(membershipId)}/departure`);
export const transferAgent = (agentId, { toMembershipId, expectedOwnerMembershipId }) =>
  call('POST', `/api/agents/${segment(agentId)}/transfer`, { body: { toMembershipId, expectedOwnerMembershipId } });
export const quotas = (companyId) => call('GET', `/api/companies/${segment(companyId)}/quotas`);
export const takeout = (companyId) => call('GET', `/api/companies/${segment(companyId)}/takeout`);

/* The E3 intake pages (docs/e3/intake-pages-design.md section 4). The four writes are bound writes and take one key per
   attempt, reused on that attempt's retry (writeAttempt). Create and save send the passport as it is, a string from the
   text area or the chosen file's Blob, as text/markdown; exactly one of the agent headers goes with a create. Save and
   submit send the version the page last read as If-Match. The page reads a draft back through review(), the one read
   that carries the losses rows and the agent's name, with the same permission as the E3 read it begins with. */
export const candidates = (companyId, cursor = null) =>
  call('GET', `/api/companies/${segment(companyId)}/candidates${cursor === null ? '' : `?cursor=${segment(cursor)}`}`);
export const createDraft = (companyId, { agentName = null, agentId = null }, passport, key) =>
  call('POST', `/api/companies/${segment(companyId)}/candidates`, {
    passport,
    headers: { ...keyed(key), ...(agentId === null ? { 'x-agent-name': agentName } : { 'x-agent-id': agentId }) },
  });
export const saveDraft = (candidateId, version, passport, key) =>
  call('PUT', `/api/candidates/${segment(candidateId)}`, {
    passport,
    headers: { ...keyed(key), 'if-match': String(version) },
  });
export const submitDraft = (candidateId, version, submission, key) =>
  call('POST', `/api/candidates/${segment(candidateId)}/submit`, {
    body: submission,
    headers: { ...keyed(key), 'if-match': String(version) },
  });
export const createSuccessor = (candidateId, key) =>
  call('POST', `/api/candidates/${segment(candidateId)}/successor`, { body: {}, headers: keyed(key) });

/** Sign out this device only (Q10) and stay on the page, as the invitation landing does to keep its code. */
export const signOut = () => call('POST', '/api/auth/signout', { changesSession: true });

/** Sign out this device and leave for the signed-out notice; a failure is returned for the page to show. */
export async function signOutHere() {
  const r = await signOut();
  if (r.ok) navigate('/signin/?reason=signed-out');
  return r;
}
