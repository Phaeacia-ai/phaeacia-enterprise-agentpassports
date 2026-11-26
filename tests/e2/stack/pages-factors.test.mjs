/* Pages construction, second factors against the local stack with the configuration of pages design 2.7 in force
   (7.2): S4 with its concurrency, cleanup and barrier arms, S7's scan of the enrolment and factor-list answers, and S8.
   Reseeds once. The first case is the observation that TOTP enrolment is enabled, recorded with the configuration's
   SHA-256; the enrolment answer's measured byte length goes to .scratch/pages-server/s4.json. Sessions GoTrue must
   know are link sessions (S12's method). Every GoTrue request of the file passes a recording wrapper that attributes it
   to the route call that made it, so "no unattended DELETE" is an assertion over the whole run. No assertion message
   carries a secret, a URI, a QR code or a token. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import {
  aalOf,
  addressFindings,
  attribution,
  caller,
  claimsOf,
  configSha256,
  gotrueDirect,
  linkSession,
  logFindings,
  newAccount,
  ROOT,
  shell,
  sql,
  totp,
  wrongCode,
} from '../helpers/pages.mjs';
import { ORIGIN, seed, sleep } from '../helpers/stack.mjs';

seed();
const { COOKIES } = await import('../../../lib/session.mjs');
const { makeRequest } = await import('../../../lib/http/request.mjs');
const { makeRoutes } = await import('../../../lib/http/routes.mjs');
const { QR_CODE_MAX_BYTES, QR_PROLOGUE } = await import('../../../lib/auth/factors.mjs');

const logged = [];
const routes = makeRoutes({ log: (e) => logged.push(e) });
const { call, answers } = caller(routes, { COOKIES, makeRequest });
const run = randomBytes(3).toString('hex');

/* Every GoTrue request, attributed; a DELETE of the held factor waits for its release (the barrier arms). */
const gotrueRequests = [];
let hold = null;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.pathname.startsWith('/auth/v1/')) {
    const entry = { method: init.method ?? 'GET', path: u.pathname, route: attribution.getStore()?.route ?? null };
    gotrueRequests.push(entry);
    if (entry.method === 'DELETE' && hold && u.pathname.endsWith(`/factors/${hold.factorId}`)) await hold.released;
  }
  return originalFetch(url, init);
};

const secrets = new Map();
const codes = [];
const cookiesOf = (s) => ({ access: s.access, refresh: s.refresh });
async function enrol(session) {
  const r = await call('factorsEnroll', cookiesOf(session));
  if (r.status === 201) secrets.set(r.body.factorId, r.body.secret);
  return r;
}
async function verify(session, factorId, code = totp(secrets.get(factorId))) {
  codes.push(code);
  return call('factorsVerify', { ...cookiesOf(session), params: { factorId }, body: { code } });
}
const remove = (session, factorId) => call('factorsRemove', { ...cookiesOf(session), params: { factorId } });
const adopt = (session, answer) => {
  session.access = answer.access;
  session.refresh = answer.refresh;
};
const factorRows = (userId) =>
  sql(
    `select coalesce(string_agg(id::text || ':' || status, ',' order by id), '') from auth.mfa_factors where user_id = '${userId}'`,
  );
const audits = () => Number(sql('select count(*) from app.audit_events'));
async function until(predicate, label) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

let K;
let companyId;
let targetMembership;
const S = {};
const S0 = {};
let F1;
test('S4 first case: with the 2.7 configuration, enrolment at aal1 without factors answers 201 and the QR passes the 2.4 shape check; its byte length is measured', async (t) => {
  const hash = configSha256();
  t.diagnostic(`S4 configuration sha256 ${hash}`);
  K = newAccount('s4');
  companyId = shell('company "$1" "$2"', `pages-s4-${run}`, K.id);
  assert.match(companyId, /^[0-9a-f-]{36}$/);
  const target = newAccount('s4-target');
  targetMembership = shell('member "$1" "$2" "$3"', companyId, target.id, '{member}');
  Object.assign(S, await linkSession(call, K.email));
  Object.assign(S0, await linkSession(call, K.email));
  assert.equal(await aalOf(S.access), 'aal1');
  const r = await enrol(S);
  assert.equal(
    r.status,
    201,
    `enrolment answered ${r.status} ${r.body?.code ?? ''}; S5's 503 means TOTP is not enabled`,
  );
  assert.equal(r.headers['cache-control'], 'private, no-store');
  assert.deepEqual(Object.keys(r.body), ['ok', 'factorId', 'qrCodeSvg', 'uri', 'secret']);
  assert.ok(r.body.qrCodeSvg.startsWith(QR_PROLOGUE), 'the real prologue');
  assert.ok(r.body.qrCodeSvg.trimEnd().endsWith('</svg>'));
  assert.ok(r.body.uri.startsWith('otpauth://totp/'));
  assert.match(r.body.secret, /^[A-Z2-7]{16,128}=*$/);
  F1 = r.body.factorId;
  const measured = {
    at: new Date().toISOString(),
    configSha256: hash,
    qrCodeSvgBytes: Buffer.byteLength(r.body.qrCodeSvg, 'utf8'),
    answerBytes: Buffer.byteLength(r.raw, 'utf8'),
    qrCodeBound: QR_CODE_MAX_BYTES,
  };
  assert.ok(measured.qrCodeSvgBytes <= QR_CODE_MAX_BYTES);
  t.diagnostic(`S4 enrolment measured ${JSON.stringify(measured)}`);
  mkdirSync(join(ROOT, '.scratch', 'pages-server'), { recursive: true });
  writeFileSync(join(ROOT, '.scratch', 'pages-server', 's4.json'), `${JSON.stringify(measured, null, 2)}\n`);
});

test('S4 step-up: set_roles 403 at aal1; a wrong code 422; another user s factor 404; a computed code 204 whose new cookie verifies aal2; set_roles then succeeds; a session made before the step-up cannot refresh', async () => {
  const before = audits();
  const refused = await call('membersSetRoles', {
    access: S.access,
    params: { companyId, membershipId: targetMembership },
    body: { roles: ['it_reviewer'] },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'E_ADMIN_MFA_REQUIRED');
  assert.equal(audits(), before);

  const wrong = await verify(S, F1, wrongCode(secrets.get(F1)));
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.code, 'E_MFA_CODE_INVALID');
  assert.deepEqual(wrong.cookies, []);

  const L = newAccount('s4-other');
  const SL = await linkSession(call, L.email);
  const theirs = await enrol(SL);
  assert.equal(theirs.status, 201);
  const foreign = await verify(S, theirs.body.factorId);
  assert.equal(foreign.status, 404, 'another user s factor');
  assert.equal(foreign.body.code, 'E_NOT_FOUND');

  const ok = await verify(S, F1);
  assert.equal(ok.status, 204, `verification answered ${ok.status} ${ok.body?.code ?? ''}`);
  assert.equal(ok.cookies.length, 2);
  adopt(S, ok);
  assert.equal(await aalOf(S.access), 'aal2', 'the new access cookie verifies as aal2');
  const allowed = await call('membersSetRoles', {
    access: S.access,
    params: { companyId, membershipId: targetMembership },
    body: { roles: ['it_reviewer'] },
  });
  assert.equal(allowed.status, 200, `set_roles answered ${allowed.status} ${allowed.body?.code ?? ''}`);
  assert.equal(audits(), before + 1);

  const stale = await call('authRefresh', { refresh: S0.refresh });
  assert.equal(stale.status, 401, 'the session made before the step-up was deleted with it (O5)');
});

const S1 = {};
let F2;
test('S4 enrolment again: 403 at aal1 with a verified factor, 201 at aal2; the factor list shows verified and unverified factors', async () => {
  Object.assign(S1, await linkSession(call, K.email));
  assert.equal(await aalOf(S1.access), 'aal1');
  const refused = await enrol(S1);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'E_MFA_STEP_UP_REQUIRED');
  const second = await enrol(S);
  assert.equal(second.status, 201);
  F2 = second.body.factorId;
  const list = await call('factorsList', cookiesOf(S));
  assert.equal(list.status, 200);
  assert.equal(list.body.aal, 'aal2');
  const status = Object.fromEntries(list.body.factors.map((f) => [f.factorId, f.status]));
  assert.equal(status[F1], 'verified');
  assert.equal(status[F2], 'unverified');
});

test('S4 removal: the granting factor at aal1 403; an unrelated verified factor leaves the session aal2; the aal2 session refreshes to aal2; the granting factor at aal2 204 with an aal1 cookie and set_roles 403 again; the earlier access token still verifies aal2 until exp', async (t) => {
  const early = await remove(S1, F1);
  assert.equal(early.status, 403);
  assert.equal(early.body.code, 'E_MFA_STEP_UP_REQUIRED');

  const unrelated = await verify(S1, F2);
  assert.equal(unrelated.status, 204, 'F2 verified from the other session, which it alone authenticates');
  adopt(S1, unrelated);
  const removedUnrelated = await remove(S, F2);
  assert.equal(removedUnrelated.status, 204);
  adopt(S, removedUnrelated);
  assert.equal(await aalOf(S.access), 'aal2', 'removing a factor this session was not verified with leaves it aal2');

  const refreshed = await call('authRefresh', { refresh: S.refresh });
  assert.equal(refreshed.status, 204);
  assert.equal(await aalOf(refreshed.access), 'aal2', 'an aal2 session refreshes to aal2');
  adopt(S, refreshed);

  const earlierAccess = S.access;
  const granting = await remove(S, F1);
  assert.equal(granting.status, 204);
  adopt(S, granting);
  assert.equal(await aalOf(S.access), 'aal1', 'the replaced cookie is aal1');
  const again = await call('membersSetRoles', {
    access: S.access,
    params: { companyId, membershipId: targetMembership },
    body: { roles: ['business_reviewer'] },
  });
  assert.equal(again.status, 403);
  assert.equal(again.body.code, 'E_ADMIN_MFA_REQUIRED');
  const limit = {
    earlierTokenAal: await aalOf(earlierAccess),
    secondsLeft: claimsOf(earlierAccess).exp - Date.now() / 1000,
  };
  t.diagnostic(`S4 disclosed limit of 2.4: ${JSON.stringify(limit)}`);
  assert.equal(limit.earlierTokenAal, 'aal2', 'an issued access token keeps its aal2 claim until it expires');
  assert.ok(limit.secondsLeft > 0);
});

test('S4 sign-out then refresh answers 401', async () => {
  const out = await call('authSignout', { access: S.access });
  assert.equal(out.status, 204);
  const after = await call('authRefresh', { refresh: S.refresh });
  assert.equal(after.status, 401);
  assert.equal(after.body.code, 'E_AUTH_INVALID');
});

test('S4 enrolment concurrency: two enrolments started one second apart both succeed with different names; verifying one deletes the other, whose verification then answers 404', async () => {
  const C = newAccount('s4-concurrent');
  const SC = await linkSession(call, C.email);
  const firstEnrolment = enrol(SC);
  await sleep(1000);
  const [one, two] = await Promise.all([firstEnrolment, enrol(SC)]);
  assert.equal(one.status, 201);
  assert.equal(two.status, 201);
  assert.notEqual(one.body.factorId, two.body.factorId);
  const listed = await call('factorsList', cookiesOf(SC));
  const both = listed.body.factors.filter((f) => [one.body.factorId, two.body.factorId].includes(f.factorId));
  assert.equal(both.length, 2, 'both factors exist');
  assert.notEqual(both[0].friendlyName, both[1].friendlyName, 'different names');
  const first = await verify(SC, one.body.factorId);
  assert.equal(first.status, 204);
  adopt(SC, first);
  const secondVerify = await verify(SC, two.body.factorId);
  assert.equal(secondVerify.status, 404, 'the superseded enrolment');
  assert.equal(secondVerify.body.code, 'E_NOT_FOUND');
  assert.equal(factorRows(C.id), `${one.body.factorId}:verified`);
});

test('S4 the enrolment route deletes nothing: a later enrolment leaves a 200-second-old factor and a 400-second-old one with a challenge, while GoTrue s own cleanup removes the 400-second-old one without', async () => {
  const G = newAccount('s4-cleanup');
  const SG = await linkSession(call, G.email);
  const young = (await enrol(SG)).body.factorId;
  const old = (await enrol(SG)).body.factorId;
  const challenged = (await enrol(SG)).body.factorId;
  const challenge = await gotrueDirect('POST', `/factors/${challenged}/challenge`, SG.access, {});
  assert.equal(challenge.status, 200, 'a challenge exists for the third factor');
  sql(
    `update auth.mfa_factors set created_at = now() - interval '200 seconds', updated_at = now() - interval '200 seconds' where id = '${young}'`,
  );
  sql(
    `update auth.mfa_factors set created_at = now() - interval '400 seconds', updated_at = now() - interval '400 seconds' where id in ('${old}', '${challenged}')`,
  );
  const mark = gotrueRequests.length;
  const later = await enrol(SG);
  assert.equal(later.status, 201);
  assert.deepEqual(
    gotrueRequests.slice(mark).filter((r) => r.method === 'DELETE'),
    [],
    'the route issued no DELETE',
  );
  const left = factorRows(G.id);
  assert.ok(left.includes(young), 'the 200-second-old factor stays');
  assert.ok(left.includes(challenged), 'the 400-second-old factor with a challenge stays (O22)');
  assert.ok(!left.includes(old), 'GoTrue s own cleanup removed the 400-second-old factor without a challenge');
});

/* The barrier-controlled race of R-M1, in two arms: the removing session at aal1 (an account with no verified factor)
   and at aal2 (an account that has one). The removal's DELETE is held until another session has verified the factor.
   What GoTrue does with the released DELETE is recorded, because the provider permits it (O22); the assertions are
   that the removal was an explicit request and that no request in the run deleted without one. */
async function barrierArm(t, label, removingSession, verifyingSession, factorId, userId) {
  sql(`update auth.mfa_factors set created_at = now() - interval '400 seconds' where id = '${factorId}'`);
  const listed = await call('factorsList', cookiesOf(removingSession));
  assert.ok(
    listed.body.factors.some((f) => f.factorId === factorId),
    `${label}: the rendered list holds the factor`,
  );
  let release;
  hold = { factorId, released: new Promise((r) => (release = r)) };
  const mark = gotrueRequests.length;
  const removal = remove(removingSession, factorId);
  await until(() => gotrueRequests.slice(mark).some((r) => r.method === 'DELETE'), `${label}: the held DELETE`);
  const verified = await verify(verifyingSession, factorId);
  assert.equal(verified.status, 204, `${label}: the other session verified the factor before the DELETE was released`);
  adopt(verifyingSession, verified);
  release();
  const removed = await removal;
  hold = null;
  const deletes = gotrueRequests.slice(mark).filter((r) => r.method === 'DELETE');
  assert.equal(deletes.length, 1, `${label}: one DELETE in the arm`);
  assert.equal(deletes[0].route, 'factorsRemove', `${label}: the DELETE came from the explicit removal`);
  const after = await call('authRefresh', { refresh: verifyingSession.refresh });
  const outcome = {
    label,
    removalStatus: removed.status,
    removalCode: removed.body?.code ?? null,
    factorAfter: factorRows(userId).includes(factorId) ? factorRows(userId) : 'destroyed',
    verifyingSessionRefresh: after.status,
    verifyingSessionAalAfterRefresh: after.access ? await aalOf(after.access) : null,
  };
  t.diagnostic(`S4 barrier ${JSON.stringify(outcome)}`);
}

test('S4 barrier-controlled race: an explicit removal held until another session verifies the factor is an explicit request, and no request in the run deleted without one; the outcome is recorded', async (t) => {
  const H = newAccount('s4-barrier-a');
  const H1 = await linkSession(call, H.email);
  const H2 = await linkSession(call, H.email);
  const f = (await enrol(H1)).body.factorId;
  assert.equal((await gotrueDirect('POST', `/factors/${f}/challenge`, H1.access, {})).status, 200);
  await barrierArm(t, 'removing session at aal1', H1, H2, f, H.id);

  const J = newAccount('s4-barrier-b');
  const J1 = await linkSession(call, J.email);
  const v0 = (await enrol(J1)).body.factorId;
  const stepped = await verify(J1, v0);
  assert.equal(stepped.status, 204);
  adopt(J1, stepped);
  const g = (await enrol(J1)).body.factorId;
  assert.equal((await gotrueDirect('POST', `/factors/${g}/challenge`, J1.access, {})).status, 200);
  const J2 = await linkSession(call, J.email);
  await barrierArm(t, 'removing session at aal2', J1, J2, g, J.id);

  const unattended = gotrueRequests.filter((r) => r.method === 'DELETE' && r.route !== 'factorsRemove');
  assert.deepEqual(unattended, [], 'no DELETE in the whole run came from anything but an explicit removal');
});

test('S8 cross-site mutations on the four new mutation routes: 403, with no factor created or removed and no profile written', async () => {
  const M = newAccount('s8');
  const SM = await linkSession(call, M.email);
  const control = await enrol(SM);
  assert.equal(control.status, 201, 'same-origin control');
  const factorId = control.body.factorId;
  const factors = factorRows(M.id);
  const profile = () =>
    sql(
      `select coalesce((select encode(convert_to(display_name, 'UTF8'), 'hex') from app.profiles where user_id = '${M.id}'), 'none')`,
    );
  const profileBefore = profile();
  for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { origin: 'https://evil.example.invalid' }]) {
    for (const [name, extra] of [
      ['meDisplayName', { body: { displayName: 'Cross Site' } }],
      ['factorsEnroll', {}],
      ['factorsVerify', { params: { factorId }, body: { code: totp(secrets.get(factorId)) } }],
      ['factorsRemove', { params: { factorId } }],
    ]) {
      const r = await call(name, { ...cookiesOf(SM), headers, ...extra });
      assert.equal(r.status, 403, `${name} ${Object.keys(headers)[0]}`);
      assert.equal(r.body.code, 'E_CROSS_SITE');
    }
  }
  assert.equal(factorRows(M.id), factors, 'no factor created, verified or removed');
  assert.equal(profile(), profileBefore, 'no profile written');
  const sameOrigin = await call('meDisplayName', {
    ...cookiesOf(SM),
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    body: { displayName: 'Same Origin' },
  });
  assert.equal(sameOrigin.status, 204, 'control: the same request from the same origin');
});

test('S7 for this file: a real enrolment answer passes the field-scoped scan, factor labels are the route s own or the caller s (PM-C-F4), and no log line carries a secret, URI, QR, code or address', async () => {
  /* PM-C-F4 (evidence/pages-milestone-critique.md): "factor lists carry no @" claimed more than the code enforces. A
     factor's friendly name is caller-controlled text: the route names each factor it enrols with friendlyName(), which
     holds no address, but a caller may enrol at GoTrue directly with its own bearer and any label, and the list route
     returns GoTrue's label as stored, to that caller only. The claim is narrowed to exactly that: a label is the route's
     shape with no '@', or a label its own caller set directly; every other string of every answer holds no '@'. */
  const direct = newAccount('s7-direct');
  const SD = await linkSession(call, direct.email);
  const label = `synthetic-label-${run}@example.invalid`;
  const enrolled = await gotrueDirect('POST', '/factors', SD.access, { factor_type: 'totp', friendly_name: label });
  assert.equal(enrolled.status, 200, 'GoTrue accepts a caller-set label from the caller s own bearer');
  const own = await call('factorsList', cookiesOf(SD));
  assert.equal(own.status, 200);
  assert.deepEqual(
    own.body.factors.map((f) => f.friendlyName),
    [label],
    'returned as stored',
  );
  const neighbour = newAccount('s7-neighbour');
  const SN = await linkSession(call, neighbour.email);
  assert.equal((await enrol(SN)).status, 201);
  const theirs = await call('factorsList', cookiesOf(SN));
  assert.equal(theirs.status, 200);
  assert.equal(JSON.stringify(theirs.body).includes(label), false, 'another account s list does not carry the label');
  const callerLabels = new Set([label]);
  const ROUTE_LABEL = /^Authenticator app, \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC · [0-9a-f]{6}$/;
  const lists = answers.filter((a) => a.route === 'factorsList' && a.status === 200);
  assert.ok(
    lists.some((a) => a.body.factors.some((f) => ROUTE_LABEL.test(f.friendlyName))),
    'route labels were listed',
  );
  for (const a of lists)
    for (const f of a.body.factors)
      assert.ok(callerLabels.has(f.friendlyName) || ROUTE_LABEL.test(f.friendlyName), `label shape: ${f.friendlyName}`);
  const enrolments = answers.filter((a) => a.route === 'factorsEnroll' && a.status === 201);
  assert.ok(enrolments.length > 0);
  assert.ok(
    enrolments.some((a) => a.body.uri.includes('%40') || a.body.uri.includes('@')),
    'the URI carries the address',
  );
  for (const a of answers) {
    const findings = addressFindings(a.route, a.body).filter((finding) => {
      const at = /^\.factors\[(\d+)\]\.friendlyName holds an address$/.exec(finding);
      return !(a.route === 'factorsList' && at && callerLabels.has(a.body.factors[Number(at[1])].friendlyName));
    });
    assert.deepEqual(findings, [], `${a.route} ${a.status}`);
  }
  const forbidden = [
    ...secrets.values(),
    ...enrolments.map((a) => a.body.uri),
    ...enrolments.map((a) => a.body.qrCodeSvg.slice(300, 400)),
    ...codes,
  ];
  assert.deepEqual(logFindings(logged, forbidden), []);
  assert.ok(!JSON.stringify(logged).includes('<svg'));
});
