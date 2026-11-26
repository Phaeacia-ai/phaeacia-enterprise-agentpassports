/* E8-5, and E6PW-R-F12's claim (docs/e8/design.md 2.3 row E8-5; evidence/e8-surface.md).

   E8-5, THE RENDERED SURFACE. Hostile tenant strings, the family of tests/e8/fixtures/hostile-strings.mjs, put into a
   company's display name and a member's display name through the product's own routes, then read in a real browser at
   390 CSS pixels on the three operator pages and on the members page. Every one must appear as TEXT: no element gains
   an attribute from it, no script element appears that the build did not put there, none of the three payloads runs,
   the page's layout survives (innerWidth, clientWidth and scrollWidth read before and after each capture), no line the
   shell's route table logged carries one, and no capture's file name carries one.

   THE AGENT NAME HAS NO RENDERED CASE, AND THAT IS THE ANSWER, NOT AN OMISSION. Design 2.3 row E8-5 asks for "an agent
   name" carrying the family. `app.agents.name` is `check (name ~ '^[a-z0-9][a-z0-9.-]{0,63}$')`
   (supabase/migrations/003_content.sql:105), so no string in the family can be stored as an agent name at all. This
   journey shows that refusal instead, at both doors it could come in by (the product's own x-agent-name header and an
   owner-side UPDATE), and then renders the LONGEST name the constraint admits, 64 characters with no space in them,
   on the members page at phone width, because an unbreakable 64-character run is what that arm can actually test.
   Deviation D5-A2 in docs/e8/design.md's day-5 amendment block.

   WHOSE COMPANY THIS USES. Its own, made for this journey (`smallCompany`), never the shared E6 world: a hostile
   display name on a row of the E6 company would be read by the E6 journeys that run before it, and an accepted
   journey is not a place to put a counterexample. The three hostile companies it creates through the operator route
   are created after every journey that reads the operator register has run, which is why this journey is registered
   after the E6 and E7 journeys in tests/browser/run-journeys.mjs.

   E8-R12, E6PW-R-F12's claim, established (evidence/e6-pages-review.md: "the control can only fail", read from the
   routine and not observed). A revoked invitation whose address has since become an active member still offers
   Resend. This journey presses it and reads what comes back, with the before-and-after contract of
   tests/e8/helpers/no-write.mjs around the press, so "it can only fail" is also "and it writes nothing". */

import { createHash, randomUUID } from 'node:crypto';

import { mintUserToken } from '../../e2/helpers/stack.mjs';
import { passportText, sql } from '../../e3/stack/helpers.mjs';
import { HOSTILE, hostileIn, MARKERS, RUN_120 } from '../../e8/fixtures/hostile-strings.mjs';
import { noWrite } from '../../e8/helpers/no-write.mjs';
import { PHONE } from '../cdp.mjs';
import { tag } from './common.mjs';
import { routes } from './e4-common.mjs';
import { acceptIn, acceptLinkFor, count, e6world, exists, mailMode, ok, operatorAal2, operatorUser, smallAdminAal2, smallCompany, text, waitPath } from './e6-common.mjs';

const S = Object.fromEntries(HOSTILE.map(([name, value]) => [name.replace(/ /g, '_'), value]));

/* Three company names, because one name may hold 200 characters (app.companies name check, 001_identity.sql:89) and
   the family is longer than that. Between them they carry all ten strings. */
const COMPANY_NAMES = [
  ['markup', `${S.script_element} ${S.attribute_payload} ${S.href_payload}`],
  ['controls', `${S.bidirectional_override} / ${S.line_break} / ${S.address} / ${S.passport_sentence}`],
  ['run', `${S.agent_name} ${RUN_120}`],
];
/* The longest name app.agents admits: 64 characters, no space, so a phone layout has nothing to break at. */
const LONG_AGENT = `e8-hostile-${'a'.repeat(53)}`;

const day = 86_400_000;
const isoDay = (days) => new Date(Date.now() + days * day).toISOString().slice(0, 10);
const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;
const md5 = (value) => createHash('md5').update(value, 'utf8').digest('hex');
const aal2Of = (u) => ({ ...u, token: () => mintUserToken({ sub: u.id, email: u.email, aal: 'aal2', ttl: 3600 }) });

/** The owner's own insert of an agent whose name is hostile: the constraint's answer, never the value. */
function ownerRefusal(companyId, name) {
  try {
    sql(`insert into app.agents (company_id, name, creator_membership_id, owner_membership_id)
         select '${companyId}', ${literal(name)}, m.id, m.id from app.memberships m
          where m.company_id = '${companyId}' limit 1`);
    return { refused: false, constraint: 'none: the insert succeeded' };
  } catch (e) {
    const message = String(e?.message ?? e);
    return {
      refused: /violates check constraint/.test(message),
      constraint: /violates check constraint "([a-z_]+)"/.exec(message)?.[1] ?? 'unnamed',
    };
  }
}

/** Every marker found in a page's whole text, its attributes, its scripts and what its payloads would have set. */
async function renderFindings(tab) {
  const seen = await tab.evaluate(`(() => {
    const attributes = [];
    for (const el of document.querySelectorAll('*'))
      for (const a of el.attributes) attributes.push(a.name + '=' + a.value);
    return JSON.stringify({
      attributes,
      scripts: [...document.querySelectorAll('script')].map((s) => s.src || s.textContent.slice(0, 80)),
      javascriptHrefs: [...document.querySelectorAll('[href], [src], [action]')]
        .map((e) => (e.getAttribute('href') || e.getAttribute('src') || e.getAttribute('action') || ''))
        .filter((v) => /^javascript:/i.test(v)),
      ran: [window.__e8hostile, window.__e8img, window.__e8href].map((v) => v === undefined ? 'unset' : String(v)),
      text: document.body.textContent,
      widths: { innerWidth: innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
    });
  })()`);
  const page = JSON.parse(seen);
  return {
    ...page,
    inAttributes: hostileIn(page.attributes.join('\n')),
    inScripts: hostileIn(page.scripts.join('\n')),
  };
}

/** The rendered checks every hostile page meets, at the width it was read at. */
async function rendersAsText(j, tab, label, expected) {
  const f = await renderFindings(tab);
  j.equal(`${label}: no element gained an attribute from a tenant string`, f.inAttributes, []);
  j.equal(`${label}: no script element carries one, and none was added`, f.inScripts, []);
  j.equal(`${label}: no javascript: URL anywhere on the page`, f.javascriptHrefs, []);
  j.equal(`${label}: none of the three payloads ran`, f.ran, ['unset', 'unset', 'unset']);
  j.equal(
    `${label}: the layout holds at 390 CSS pixels (innerWidth, clientWidth, scrollWidth)`,
    [f.widths.innerWidth, f.widths.clientWidth, f.widths.scrollWidth],
    [390, 390, 390],
  );
  const missing = expected.filter((s) => !f.text.includes(s));
  j.equal(`${label}: every string this page shows is in its text`, missing.length, 0);
  return f;
}

/** E8-5. */
export async function e8hostile(ctx, j) {
  const run = tag();
  const { call } = await routes(ctx);
  const op = operatorUser(ctx);
  await e6world(ctx);

  /* The three hostile companies, made through the operator's own route: the service's only name rule is a trimmed
     length of 1 to 200 (lib/services/operator.mjs:70), so every one of these names is a name a customer could be
     given. The harness makes them; the browser only reads them. */
  const companies = [];
  for (const [kind, name] of COMPANY_NAMES) {
    const body = {
      slug: `e8h-${kind}-${run}`,
      name,
      firstAdminEmail: `e8h-${kind}-${run}@example.invalid`,
      startsAt: new Date(Date.now() - day).toISOString(),
      endsAt: new Date(Date.now() + 56 * day).toISOString(),
    };
    const answer = ok(await call('operatorCompanyCreate', { user: op, body }), `hostile company ${kind}`);
    companies.push({ kind, name, id: answer.companyId, slug: body.slug });
  }
  j.equal(
    'the service stored each hostile company name unchanged, all three of them (compared as digests, since one holds a line break)',
    companies.map((c) => sql(`select md5(name) from app.companies where id = '${c.id}'`) === md5(c.name.trim())),
    [true, true, true],
  );

  /* The operator's register, at phone width: every hostile name is on it, as text. */
  const identity = await operatorAal2(j, ctx);
  const register = await j.tab(identity, 'operator-register');
  await register.setViewport(PHONE);
  await register.navigate(`${j.origin}/operator/`);
  await register.waitForSelector('[data-role="register-table"]');
  await rendersAsText(j, register, 'the operator register', [S.script_element, S.attribute_payload, RUN_120]);
  await j.capture(register, 'operator-register-hostile');

  /* The operator's company page for the markup company: the heading is the name. */
  const company = await j.tab(identity, 'operator-company');
  await company.setViewport(PHONE);
  await company.navigate(`${j.origin}/operator/company/?company=${companies[0].id}`);
  await company.waitForSelector('[data-role="company-facts"], [data-role="succession"], h1');
  await rendersAsText(j, company, 'the operator company page', [S.script_element]);
  await j.capture(company, 'operator-company-hostile');

  /* The company page of the company whose name holds a line break and an override. */
  const controls = await j.tab(identity, 'operator-company-controls');
  await controls.setViewport(PHONE);
  await controls.navigate(`${j.origin}/operator/company/?company=${companies[1].id}`);
  await controls.waitForSelector('[data-role="company-facts"], [data-role="succession"], h1');
  await rendersAsText(j, controls, 'the operator company page, control characters', [S.address]);
  await j.capture(controls, 'operator-company-controls');

  /* /operator/new/: a name an operator types, which is the markup family, through the form and back as the answer. */
  const made = await j.tab(identity, 'operator-new');
  await made.setViewport(PHONE);
  await made.navigate(`${j.origin}/operator/new/`);
  await made.waitForSelector('[data-role="create-form"]');
  const typed = `${S.script_element} ${S.attribute_payload}`;
  await made.type('#company-slug', `e8h-typed-${run}`);
  await made.type('#company-name', typed);
  await made.type('#first-admin-email', `e8h-typed-${run}@example.invalid`);
  await made.evaluate(`(() => { document.querySelector('#period-end').value = ${JSON.stringify(isoDay(56))}; return true; })()`);
  await made.click('[data-role="create-company"]');
  await made.waitForSelector('[data-role="created-company"]');
  j.equal('the page shows the name it was given, as text', (await text(made, '[data-role="created-company"]'))?.includes(typed), true);
  await rendersAsText(j, made, 'the operator create answer', [typed]);
  await j.capture(made, 'operator-new-hostile');

  /* The members page of a company of this journey's own, with hostile display names on its rows. The display-name
     rule (lib/rules/profiles.mjs) admits markup and refuses a control or a bidirectional character, so the route is
     asked for each and the refusals are recorded; the two it refuses are then written owner-side, because
     app.profiles checks only the length and the page must hold whatever is in the column. */
  const C = await smallCompany(ctx, `e8h${run}`);
  const throughRoute = {};
  for (const [name, value] of HOSTILE) {
    const r = await call('meDisplayName', { user: C.users.member, body: { displayName: value } });
    throughRoute[name] = r.status;
  }
  j.record('what the display-name route answered for each string', throughRoute);
  const verdict = (name) => (throughRoute[name] >= 400 ? 'refused' : 'admitted');
  j.equal(
    'the rule refuses the line break and the bidirectional override and admits the markup (lib/rules/profiles.mjs)',
    ['line break', 'bidirectional override', 'script element', 'attribute payload', '120 characters'].map(verdict),
    ['refused', 'refused', 'admitted', 'admitted', 'admitted'],
  );
  /* Owner-side, labelled: the column's own check is the length alone, so a value the route refuses can still be in
     it (a migration, a restore, a future writer), and the page is what must hold. */
  const planted = `${S.script_element} ${S.bidirectional_override}`;
  sql(`update app.profiles set display_name = ${literal(planted)} where user_id = '${C.users.member.id}'`);
  sql(`update app.profiles set display_name = ${literal(`${S.attribute_payload} x`)} where user_id = '${C.users.admin.id}'`);

  /* One agent of that company, owned by its member, with the longest name the constraint admits; and the constraint
     shown refusing every hostile string, at the product's door and at the owner's. */
  const agentRefusals = {};
  for (const [name, value] of HOSTILE) {
    const r = await call('candidatesCreate', {
      user: C.users.member,
      params: { companyId: C.companyId },
      headers: { 'idempotency-key': randomUUID(), 'x-agent-name': value.replace(/\n/g, ' ') },
      body: Buffer.from(passportText(), 'utf8'),
    });
    agentRefusals[name] = `${r.status} ${r.body?.code ?? ''}`.trim();
  }
  j.record('what the candidate route answered for each hostile agent name', agentRefusals);
  j.check(
    'the product refuses every hostile agent name on its own merits (app.agents.name, 003_content.sql:105)',
    Object.values(agentRefusals).every((a) => Number(a.split(' ')[0]) >= 400 && !a.includes('IDEMPOTENCY')),
    agentRefusals,
  );
  const ownerSide = ownerRefusal(C.companyId, S.script_element);
  j.equal("and so does the database, to the owner's own insert, by the name check", [ownerSide.refused, ownerSide.constraint], [true, 'agents_name_check']);
  const created = ok(
    await call('candidatesCreate', {
      user: C.users.member,
      params: { companyId: C.companyId },
      headers: { 'idempotency-key': randomUUID(), 'x-agent-name': LONG_AGENT },
      body: Buffer.from(passportText(), 'utf8'),
    }),
    'the long-named agent',
  );
  j.record('the agent name the constraint admits, rendered below', { name: LONG_AGENT, candidateId: created.candidateId });

  const adminIdentity = await smallAdminAal2(j, C);
  const members = await j.tab(adminIdentity, 'members-hostile');
  await members.setViewport(PHONE);
  await members.navigate(`${j.origin}/members/?company=${C.companyId}`);
  await members.waitForSelector('[data-role="own-roles"]');
  await rendersAsText(j, members, 'the members page', [planted]);
  await j.capture(members, 'members-hostile');

  /* The departure preview of the member who owns the agent: the 64-character name, unbroken, at 390 pixels. */
  await members.click(`[data-membership="${C.ms.member}"] [data-role="remove"]`);
  await members.waitForSelector('[data-role="departure"]');
  const departure = await rendersAsText(j, members, 'the departure preview', [LONG_AGENT]);
  j.check('the 64-character agent name is on it', departure.text.includes(LONG_AGENT));
  await j.capture(members, 'members-departure-long-agent', { anchor: '[data-role="departure"]' });

  /* Nothing the shell logged, and no capture's file name, carries any of it. */
  j.equal('no line the route table logged carries a tenant string', hostileIn(JSON.stringify(ctx.shell.logs)), []);
  j.equal('no recorded request path carries one', hostileIn(JSON.stringify(ctx.shell.record)), []);
  j.equal(
    "no capture's file name carries one",
    j.captures.filter((c) => MARKERS.some((m) => c.phone.includes(m) || c.desktop.includes(m))).length,
    0,
  );
  ctx.state.e8hostile = { company: C, adminIdentity };
}

/** E8-R12: E6PW-R-F12's claim, pressed. */
export async function e8resend(ctx, j) {
  const run = tag();
  const { call } = await routes(ctx);
  const held = ctx.state.e8hostile;
  const C = held?.company ?? (await smallCompany(ctx, `e8r${run}`));
  const address = `e8r-${run}@example.invalid`;

  /* A revoked invitation, and then the same address as an active member through a second invitation. */
  const first = ok(await call('invitationsCreate', { user: aal2Of(C.users.admin), params: { companyId: C.companyId }, body: { email: address, roles: ['member'] } }), 'the first invitation');
  ok(await call('invitationsRevoke', { user: aal2Of(C.users.admin), params: { companyId: C.companyId, invitationId: first.invitationId } }), 'the revocation');
  const second = ok(await call('invitationsCreate', { user: aal2Of(C.users.admin), params: { companyId: C.companyId }, body: { email: address, roles: ['member'] } }), 'the second invitation');
  const link = mailMode() ? await acceptLinkFor(j, null, '', address) : second.acceptUrl;
  if (typeof link !== 'string') throw new Error('E8-R12: the second invitation carried no accept link');
  const accepted = await acceptIn(j, `e8r-member-${run}`, link, 'accept');
  await waitPath(accepted, '/members/', { timeout: 30000 });
  j.equal(
    'the address is now an active member, and the first invitation is revoked',
    [
      count('app.memberships m join auth.users u on u.id = m.user_id', `m.company_id = '${C.companyId}' and lower(u.email) = '${address}' and m.status = 'active'`),
      count('app.invitations', `id = '${first.invitationId}' and revoked_at is not null`),
    ],
    [1, 1],
  );

  const adminIdentity = held?.adminIdentity ?? (await smallAdminAal2(j, C));
  const tab = await j.tab(adminIdentity, 'members-resend');
  await tab.setViewport(PHONE);
  await tab.navigate(`${j.origin}/members/?company=${C.companyId}`);
  await tab.waitForSelector(`[data-invitation="${first.invitationId}"]`);
  j.equal(
    'the revoked invitation is on the page in its revoked state and still offers Resend (E6 design 4.1)',
    [
      await tab.evaluate(`document.querySelector('[data-invitation="${first.invitationId}"]').dataset.state`),
      await exists(tab, `[data-invitation="${first.invitationId}"] [data-role="resend"]`),
    ],
    ['revoked', true],
  );
  await j.capture(tab, 'resend-offered-on-a-revoked-invitation', { anchor: `[data-invitation="${first.invitationId}"]` });

  /* Pressed, with the before-and-after contract around it: what comes back, and that nothing was written. */
  const code = await noWrite(
    'E6PW-R-F12: the resend a revoked invitation offers, pressed',
    async () => {
      await tab.click(`[data-invitation="${first.invitationId}"] [data-role="resend"]`);
      await tab.waitForSelector(`[data-invitation="${first.invitationId}"] [data-role="confirm-resend-now"]`);
      await tab.click(`[data-invitation="${first.invitationId}"] [data-role="confirm-resend-now"]`);
      await tab.waitForSelector(`[data-invitation="${first.invitationId}"] [data-role="row-status"] [role="alert"][data-code]`);
      return tab.evaluate(
        `document.querySelector('[data-invitation="${first.invitationId}"] [data-role="row-status"] [role="alert"][data-code]').dataset.code`,
      );
    },
    { content: ['invitations', 'memberships', 'profiles'] },
  );
  j.record('what the offered Resend answered', code);
  j.equal('the control can only fail, and the refusal is the routine’s own (api.invite_member, 008_lifecycle.sql:525)', code, 'E_ALREADY_MEMBER');
  j.equal(
    'and the invitation the page named is unchanged: still revoked, still one row for that address',
    [
      count('app.invitations', `id = '${first.invitationId}' and revoked_at is not null`),
      count('app.invitations', `company_id = '${C.companyId}' and email_normalized = '${address}'`),
    ],
    [1, 2],
  );
  await j.capture(tab, 'resend-refused-already-member', { anchor: `[data-invitation="${first.invitationId}"]` });
}
