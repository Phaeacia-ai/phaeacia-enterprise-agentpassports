/* One record per publish, describing the SHAPE of what was published.

   The schema is BACKEND-PLAN.md section 2, and the values it prints there were
   produced by running this parse over examples/daily-brief-passport.md, so
   tools/run-tests.mjs asserts this module reproduces them field for field.

   The rule the whole file is written to: **no free text, no identifier, nothing
   a person wrote.** Every value below is an enum fixed by spec/passport-0.1.md,
   a member of the vocabulary in spec/vocabulary.md, a boolean, or an integer.
   Not the title, not the summary, not the agent's name, not one sentence of the
   file. If a field ever needs a string that a stranger typed, it does not
   belong in this record.

   **THE VOCABULARY IS A CLOSED SET WITH EXACTLY ONE WILDCARD.** A `money.*` id
   carries whatever suffix the passport wrote, so it is text a stranger typed
   and **not a vocabulary member**. Collapse it to `money.*` before it reaches
   this record; `normaliseRef` below does that and every path into `refs` goes
   through it.

   This paragraph replaces the phrase "a member of the closed vocabulary", and
   that phrase is not a wording nit: it is what produced the defect. Somebody
   deciding whether a new field is safe read "closed vocabulary", concluded a
   ref is drawn from a fixed set, and stored refs verbatim. A passport carrying
   `capability_ref: money.<seventy-one characters a stranger chose>` then landed
   the sentence in this record, which outlives the passport it describes, and in
   a mail to the operator. The test written to prove every string comes from a
   closed set had the same hole, permitting `startsWith('money.')`, for the same
   reason.

   The wildcard is correct and must not be closed: spec/vocabulary.md explains
   that a refusal list which has to be enumerated first lets an agent escape
   refusal by spending money in a way nobody wrote down. So the guarantee this
   file needs cannot come from the vocabulary and has to be made here.
   Raised by skill-engineer, who read the fix and noticed the sentence survived
   it. See record/findings/the-spec-wildcard-was-the-hole-in-no-text-you-wrote.md

   Two consequences of that rule are load bearing rather than tidy:

   - `day` is a date, never a timestamp. A time to the second, written next to
     the passport it came from, is a join key: anybody holding both stores could
     line the two up by clock. A date at the volume this runs at is a much
     weaker one, and the privacy page says so rather than calling it anonymous.
   - Nothing here carries the passport's uuid, so the record cannot be traced
     back to a page even by whoever holds the store. That is also why deleting a
     passport does not delete this: there is nothing to look up.

   Where the ids actually live. `_derive.mjs` reads the consent table, whose
   Capability column spec/passport-0.1.md section 3 defines as "plain language,
   not the vocabulary id", so `needs[].ref` is empty on every spec-conforming
   passport. The reliable source is section 3's `capability_ref:` lines, which
   the spec requires to carry their value on the same line and which the
   validator already scans for an unknown-id error. This file reads the same
   lines and keeps the good ones. */

import { sectionLines, FENCE } from './_sections.mjs';
import { MESSAGES } from './_validate.mjs';

export const METRICS_VERSION = 1;

/* ── the other half of the corpus: attempts that did not publish ──────────
   ONE ROW PER REFUSED UPLOAD, and it is a different store from the one above.

   Why it exists. Everything above describes a passport that WAS published, so
   somebody who tried, bounced off a validation error and left is invisible in
   the whole system: the only trace a refusal leaves anywhere else is a
   rate-limiter key, which is keyed by address hash and deleted when its window
   ends. During a beta that is the more interesting half. Ten people bouncing off
   E_SCRUB_GATE on the first day is the thing you would want to know, and nothing
   could tell you.

   THE RULE ABOVE APPLIES UNCHANGED AND IS TIGHTER HERE, because the input is a
   file a stranger wrote and we refused. Two fields, both closed:

   - `day`, a date and never a timestamp, for the reason written above. Same
     join-key argument, and it bites harder here: a refusal and a retry a minute
     later are the same person, and a clock time would say so.
   - `code`, a key of MESSAGES. NOT `message` and NOT `details`. That distinction
     is the whole safety argument and it is easy to get wrong, because `err()`
     returns all three together in one object. `message` is a template filled at
     :166-171 with `{refs}`, `{names}`, `{tags}` and `{keys}` — values lifted
     verbatim out of the uploaded file. `details` is worse. **A row carrying
     either is a row carrying text a stranger wrote**, which is exactly what the
     privacy page says cannot happen.

   The membership check below is why MESSAGES is imported rather than the shape
   being asserted with a regexp. A regexp accepts `E_ANYTHING_AT_ALL`; membership
   accepts only codes this site actually defines, so a caller that passes the
   wrong half of an error object gets a dropped row instead of a stored one.
   Failing closed is correct here: a lost count is worth less than a leak.

   NOTHING IS RECORDED FOR A SUCCESSFUL PUBLISH. It would cost a second store
   write on the one path where latency is dangerous — the delete token exists in
   exactly one response, and a production store operation is measured at a median
   of 310 ms (record/findings/one-production-store-op-costs-310ms.md). It is also
   redundant: the metrics store above is exactly one row per publish, keyed by
   day, so the publish count is already available without writing it twice.

   WHAT THE TWO COUNTS DO AND DO NOT ADD UP TO, because the obvious sentence is
   wrong and it was written here before a critic measured it. "Attempts = the
   metrics count plus this one" **double counts the owner-review gate**, and it
   does so on the code this file calls the most interesting one.

   The gate is a designed two-step: `upload.mjs` refuses an unconfirmed passport
   once, hands back a ticket, and the client retries with it. One person, one
   file, one sitting produces **one E_OWNER_UNCONFIRMED row here and one metrics
   row there**. Measured, not reasoned: refuse-then-retry ends 200 with both rows
   present.

   So this store counts REFUSALS, not people and not distinct files, and the
   naive sum inflates exactly where a beta reader would look hardest. The row
   carries its code, so the reader can subtract E_OWNER_UNCONFIRMED and get
   attempts that failed for a reason other than a gate they then passed. What
   cannot be recovered is how many of those refusals were followed by a publish,
   because nothing joins a row to anything, which is the whole point of the
   design and is not a defect to be fixed by adding a join.

   BOTH FIELDS ARE CHECKED, and the first version of this checked only one.

   `code` was validated against MESSAGES and `day` was passed straight through to
   the stored body, on the reasoning that `day` comes from the server's own clock
   and is therefore not user input. That reasoning is correct today and it is not
   a guard. A critic passed `day: '<script>alert(1)</script> a stranger wrote
   this'` and got it back inside the record, because nothing said no.

   Nothing reaches that today: the only caller builds `day` from
   `new Date().toISOString().slice(0,10)`. The defect is that the file's whole
   claim is "this record cannot carry text a stranger wrote", and a claim that
   holds because of who happens to call it is a different and weaker claim than
   one that holds because the record refuses. The next caller is a scheduled
   digest, a backfill or a test helper, and none of them is this one.

   The asymmetry was also disguised. `recordRejection` in _store.mjs does
   `String(record.day).slice(0, 10)` when building the KEY, so `day` looked
   handled; that sanitises the key and not the body it is stored beside. */
export const ATTEMPTS_VERSION = 1;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function rejectionRecord({ day, code }) {
  if (!Object.prototype.hasOwnProperty.call(MESSAGES, code)) return null;
  if (typeof day !== 'string' || !DAY.test(day)) return null;
  return { v: ATTEMPTS_VERSION, day, code };
}

/* The declared-only half of spec/vocabulary.md, plus the money.* prefix. Kept
   as its own set rather than derived from _derive.mjs's VOCAB, because that one
   answers "is this id real" and this one answers "is this id outside the
   envelope", and collapsing the two would make widening the envelope in v0.2
   silently change what this corpus means. */
const OUTSIDE_ENVELOPE = new Set(['email.send', 'msg.send', 'social.post', 'ext.write']);
const outside = ref => OUTSIDE_ENVELOPE.has(ref) || ref.startsWith('money.');

/* ── the one hole in "no text you wrote", and it was open ─────────────────
   `money.*` IS A PREFIX AND NOT AN ID. spec/vocabulary.md:43 says so and gives
   a good reason: "it is a prefix precisely so that nobody has to enumerate the
   ways an agent could spend someone's money before refusing to install one."
   _validate.mjs implements exactly that — any ref starting with `money.`
   validates, without further checking. THAT DECISION IS CORRECT AND IS NOT
   CHANGED HERE. The defect was storing what it admits.

   So the ONE field in this record not drawn from a closed set was `refs`, and
   it was stored verbatim. Demonstrated end to end against this file's real
   callers rather than argued: a passport carrying

     capability_ref: money.urgentyouraccountislockedvisit<...>tounlockitnow

   validates clean, derives clean, and lands 71 characters of a stranger's
   chosen sentence in this record.

   That falsifies two things at once. The rule at the top of this file — "no
   free text, no identifier, nothing a person wrote" — and privacy.html:132,
   which tells a publisher the record "holds no text you wrote. Not the title,
   not the description, not the agent's name, not one sentence of the file."
   Both have been false on every publish since this record existed.

   It matters more than an ordinary stored-string bug for two reasons. This
   corpus is the one thing on the site that OUTLIVES the passport it describes,
   so a deletion does not remove it. And a capability id is an excellent place
   to hide a sentence precisely because nobody reads that column as prose.

   Collapsing to `money.*` costs nothing real. There is no closed set of money
   ids to preserve — that is the whole point of the prefix — so no id under it
   can ever be stored safely, and every question this corpus answers is answered
   by "an agent asked for money capabilities". `outside()` above still fires,
   because it tests the prefix.

   TWO ADDITIONS FROM backend/attempt-counter, kept because they are true here
   and were not true on main.

   The endpoint suite BLESSED this. run-endpoint-tests.mjs's closed-set
   assertion allowed `str.startsWith('money.')` unconditionally, so the test
   written to catch exactly this class had a hole shaped like the spec's
   wildcard.

   And it matters more once the digest exists. This corpus is now MAILED to the
   operator, so a free-text field in it is not a stored-data problem, it is a
   delivery channel for a sentence a stranger wrote, aimed at the one person who
   reads the numbers. */
const MONEY = 'money.';
const normaliseRef = ref => (ref.startsWith(MONEY) ? 'money.*' : ref);

const REF = /capability_ref:\s*([A-Za-z0-9_.*-]+)/;
const STATUS = /^\s*status:\s*([A-Za-z_]+)/;

/* scheduled | on_demand | event | unknown, off the trigger line's own prefix.
   The spec does not close this field, so anything unrecognised is `unknown`
   rather than a guess: a bucket named for what it is beats a bucket that
   quietly absorbs the cases the vocabulary did not anticipate. */
function triggerKind(lines) {
  /* The trigger's OWN value line. Reading the section's first `value:` finds
     `goal.value` instead, because goal is written above trigger in the template
     and in every passport that follows it, so every agent in the corpus would
     have been filed as `unknown`. Find the trigger mapping, then read the value
     nested under it and stop at the next key at the same indent. */
  let depth = null;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (depth === null) {
      if (/^\s*trigger:\s*$/.test(line)) depth = indent;
      /* `trigger: scheduled(...)` inline is legal too. */
      else {
        const inline = line.match(/^\s*trigger:\s*(\S.*)$/);
        if (inline) return classify(inline[1]);
      }
      continue;
    }
    if (indent <= depth) break;
    const m = line.match(/^\s*value:\s*(.+)$/);
    if (m) return classify(m[1]);
  }
  return 'unknown';
}

function classify(raw) {
  const v = String(raw).trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (/^scheduled\b|^cron\b|^every\b|^daily\b|^weekly\b/.test(v)) return 'scheduled';
  if (/^on[_ -]?demand\b|^manual\b|^asked\b|^when asked\b/.test(v)) return 'on_demand';
  if (/^event\b|^webhook\b|^triggered[_ -]?by\b|^on[_ -]?receipt\b/.test(v)) return 'event';
  return 'unknown';
}

/* A block-scalar-safe walk of a mapping's immediate children. The YAML in
   section 3 is read by indentation rather than parsed, everywhere in this
   repository, because pulling in a YAML parser for six integers is a dependency
   the privacy page would have to answer for. */
function listItems(lines, key) {
  const out = [];
  let depth = null, cur = null;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (line.trim() === '' ) continue;
    const indent = line.length - line.trimStart().length;
    if (depth === null) {
      if (new RegExp('^\\s*' + key + ':\\s*$').test(line)) depth = indent;
      continue;
    }
    if (indent <= depth && line.trim() !== '') break;          // the mapping ended
    if (/^\s*-\s/.test(line)) { cur = [line.replace(/^\s*-\s/, '')]; out.push(cur); }
    else if (cur) cur.push(line.trim());
  }
  return out;
}

const countField = (items, field) => {
  const tally = {};
  for (const item of items) {
    for (const l of item) {
      const m = l.match(new RegExp('^' + field + ':\\s*(\\S+)'));
      if (m) { const v = m[1].replace(/^["']|["']$/g, ''); tally[v] = (tally[v] || 0) + 1; break; }
    }
  }
  return tally;
};

/* ── the instrument record/proposals/high-entropy-gate.md specified and nobody
   built ───────────────────────────────────────────────────────────────────

   That proposal, 2026-08-11, deferred a generic high-entropy rule at both
   downstream gates behind a stated trigger: "Add the generic rule to
   preflight.py and _validate.mjs together when 50 publishes have been recorded
   and fewer than one in twenty carries a non-zero high_entropy_hits."

   The field was never implemented. It appeared in no code in either repository,
   and `git log -S` finds no commit that ever contained the string. So for
   twenty days the backstop was not deferred BY MEASUREMENT against a trigger
   that had not fired; it was deferred BY DEFAULT because the instrument the
   trigger reads did not exist. State it that way and not as "evaluated and not
   met": nothing was ever evaluated.

   AN INTEGER, and that is the whole of it. Not the matched strings, not a
   prefix of them, not a line number. Putting a matched string here would
   reintroduce exactly what f179c21 removed, in the one store that outlives the
   passport it describes, and the thing being counted is by construction the
   thing most likely to be a live credential. The file's rule at the top governs
   without amendment: an integer is an integer.

   Paired with `redactions` above it answers the question that actually decides
   whether the backstop is worth its false positives: how often does a passport
   arrive carrying no scrub markers at all AND a non-zero count? That is the
   population a generic rule would protect, and its size is still unknown.

   Kept in step with tools/scrub.py's HIGH_ENTROPY rule and _high_entropy_ok,
   character for character. This is the THIRD implementation of that one rule,
   in a third language, and the other two are compared to each other;
   web/tools/parity.mjs compares this one to scrub.py by BEHAVIOUR on a shared
   input rather than by anybody reading the two sources and agreeing they look
   alike. Do not trust this comment for it; that check is what holds.

   AND THE AGREEMENT IS NARROWER THAN "the same rule", deliberately. scrub.py
   applies its named patterns FIRST and runs the entropy backstop over the text
   they already redacted; this function runs over the body as it arrived. So on
   a document where both a named rule and the backstop would fire, the two
   counts differ, for a correct reason, and the parity check is built on an
   input where no named rule fires precisely so that it measures the rule rather
   than the ordering.

   The one-line counterexample, so nobody has to go looking for it: on the text
   "My integration token is ntn_<the run-4 token> in case that matters",
   scrub.py reports NOTION_TOKEN 1 and HIGH_ENTROPY 0, because the named rule
   replaced the token before the backstop ran, while this function returns 1.
   Same regex, different input.

   AND THE DIVERGENCE IS UNREACHABLE HERE, which is the reason it is a wording
   problem rather than a defect. metricsRecord is called only after validation
   has passed, so a body carrying any of the twenty-one named shapes was already
   refused and never reaches this function; and scrub's two rules that this file
   has no counterpart for, EMAIL and IPV4, cannot produce a 32-character run in
   the entropy class. Fuzzed over 416 documents where no named rule fires: zero
   divergences, and a whole-body matchAll equals the sum of scrub's per-line
   counts, so the per-line loop and the whole-string call agree too.

   That difference is the right way round for what this field is for. The
   population it exists to size is passports that reached the endpoint with no
   scrub at all, which is every browser-path capture: for those there is no
   earlier redaction, the raw body IS the text, and a count taken after
   hypothetical named redactions would understate exactly the population in
   question. The candidate class is
   ASCII-only, so [a-z]/[A-Z]/[0-9] here mean what islower/isupper/isdigit mean
   there; that equivalence is why this port is safe and it stops being true the
   moment somebody widens the class. */
const HIGH_ENTROPY = /(?<![A-Za-z0-9_\-+/=])[A-Za-z0-9_\-+/=]{32,}(?![A-Za-z0-9_\-+/=])/g;

export function highEntropyHits(body) {
  let n = 0;
  for (const m of String(body).matchAll(HIGH_ENTROPY)) {
    const s = m[0];
    /* The case gate scrub.py applies. It is why a git SHA, a uuid and a slug
       are not counted: they are single-case or digitless, and counting them
       would put the trigger's denominator somewhere it cannot be read. */
    if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s)) n++;
  }
  return n;
}

export function metricsRecord({ front, lines, needs, body, day }) {
  const sec3 = sectionLines(lines, '## 3. Functional spec');
  const sec4 = sectionLines(lines, '## 4. Golden examples');

  /* refs, deduped, in first-seen order, from every capability_ref line in the
     file.

     THIS COMMENT USED TO SAY "the validator has already refused the record if
     any of them is outside the closed vocabulary, so no filtering is needed
     here", and it is the sentence that sat directly above the defect. Every
     clause of it is true and the conclusion does not follow: the validator does
     refuse an unknown id, and `money.` is a PREFIX, so `money.<anything>` is
     inside the vocabulary and outside any closed set. "The validator checked
     it" answers a different question from "is this safe to store".

     `normaliseRef` is the filtering that was not needed. It is applied on the
     way in rather than on the way out because every consumer of `refs` —
     `refs_declared_only`, `refs_outside_envelope`, the report tool, the digest
     — would otherwise each have to remember. */
  const refs = [];
  for (const l of lines) {
    const m = l.match(REF);
    if (!m) continue;
    const ref = normaliseRef(m[1].replace(/^["']|["']$/g, ''));
    if (!refs.includes(ref)) refs.push(ref);
  }

  /* declared_only comes off the capabilities list's own status field, which is
     the passport's statement about itself, not off the envelope table. The two
     can legitimately disagree and the difference is worth being able to see. */
  const declaredOnly = [];
  for (const item of listItems(sec3, 'capabilities')) {
    let ref = null, status = null;
    for (const l of item) {
      const r = l.match(REF); if (r) ref = normaliseRef(r[1].replace(/^["']|["']$/g, ''));
      const s = l.match(STATUS); if (s) status = s[1];
    }
    if (ref && status === 'declared_only' && !declaredOnly.includes(ref)) declaredOnly.push(ref);
  }

  const inputs = listItems(sec3, 'inputs');
  const access = countField(inputs, 'access');
  const criticality = countField(inputs, 'criticality');

  /* Quotes stripped for the same reason countField strips them below. A
     quoted `comparison_mode: "structural"` would otherwise be recorded as a
     separate bucket from the bare form, splitting one mode across two rows for
     no reason a reader of the metrics could ever work out. Unreachable before
     2026-09-03, because both validators refused a quoted value; reachable now
     that they correctly accept it. */
  const cmp = (lines.find(l => /comparison_mode:\s*\S+/.test(l)) || '')
    .match(/comparison_mode:\s*(\S+)/);
  if (cmp) cmp[1] = String(cmp[1]).trim().replace(/^(["'])(.*)\1$/, '$2');

  /* Fenced blocks in section 4, counted in pairs. The validator has already
     refused an unbalanced fence, so halving is safe here. */
  const goldens = Math.floor(sec4.filter(l => FENCE.test(l)).length / 2);

  const scrub = String(front.scrub || '').toLowerCase();

  return {
    v: METRICS_VERSION,
    day,

    spec: front.passport,
    envelope: front.envelope,
    capture_path: front.capture_path,
    owner_confirmed: String(front.owner_confirmed).toLowerCase() === 'true',
    scrub_reviewed: scrub.includes('owner-reviewed'),
    redactions: body.includes('[SCRUBBED:'),
    high_entropy_hits: highEntropyHits(body),

    trigger: triggerKind(sec3),
    comparison_mode: cmp ? cmp[1] : 'unknown',

    refs,
    refs_declared_only: declaredOnly,
    refs_outside_envelope: refs.filter(outside),

    access: { open: access.open || 0, credentialed: access.credentialed || 0 },
    criticality: { core: criticality.core || 0, optional: criticality.optional || 0 },
    inputs: inputs.length,
    slots: listItems(sec3, 'personal_slots').length,
    checks: listItems(sec3, 'verification').length,
    goldens,

    consent: {
      rows: needs.length,
      required: needs.filter(n => n.required).length,
      installable: needs.filter(n => n.installable).length,
      declared: needs.filter(n => !n.installable).length,
      /* Rows whose Capability cell held a backticked id, which the spec says it
         should not. Useful for about one release, then it should go. */
      refs_in_wrong_column: needs.filter(n => n.ref).length
    }
  };
}
