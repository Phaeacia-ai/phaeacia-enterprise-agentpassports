# Install-block optimisation, 2026-08-10

What changed in `installer/core.md`, the four branch appendices and the shipped
half of `verification/judge-prompt.md`, why, and where I decided a paragraph did
earn its tokens. Written so the owner can audit the pass without rereading 100 KB.

The rule I worked to, from the brief: **remove anything that does not change what
B's assistant actually does, and keep everything that does.** No byte target.

---

## 1. The arithmetic that shaped every decision

This is the thing to understand before reading anything below, because it inverts
the obvious plan.

A pasted install block is **passport + core + judge block + ONE branch**. Never
two branches. So a sentence that appears in all four branches appears **once** in
any block. Moving it into the core removes three copies from the repository and
**zero bytes from the product**. The four branches totalling 87 KB looked like the
big prize and it is not one.

The only duplication that costs a real installer tokens is:

- **core ↔ branch**: a rule stated in the core and restated in the branch that
  ships with it. Every removal here is a real saving.
- **inside the judge block**: it ships whole, every time.
- **inside a single branch**.

So the pass has two different jobs, and they pull against each other:

1. *Correctness and maintenance*: consolidate the four branch copies into the core
   so they cannot drift. Costs nothing, saves nothing.
2. *Tokens*: delete branch text the core already says, and cut restatement inside
   the judge.

Job 1 grew the core by 4.6 KB, which every block pays. Job 2 shrank the branches
by 10.6 to 29.4 percent. After the round-2 and round-3 corrections the net is a
real saving on one block, a small one on a second, and slightly negative on the
other two; section 6 explains claude-code and section 10 explains why generic
ended up above where it started.

### Measured result

Numbers as they stand after the round-3 corrections in section 11, which put a
further 191 bytes back across three of the four blocks. The round-1 and round-2
numbers are in sections 10 and 11, so the cost of the corrections is visible
rather than folded away.

| branch | before | after | change | before ~tok | after ~tok |
|---|---|---|---|---|---|
| chatgpt | 55,758 B | 55,133 B | **-1.1%** | 13,940 | 13,783 |
| claude-ai | 53,437 B | 48,749 B | **-8.8%** | 13,359 | 12,187 |
| claude-code | 47,968 B | 48,779 B | **+1.7%** | 11,992 | 12,195 |
| generic | 39,028 B | 39,236 B | **+0.5%** | 9,757 | 9,809 |

Per file:

| file | before | after | change |
|---|---|---|---|
| `installer/core.md` | 8,842 | 13,466 | +52.3% |
| `installer/branches/chatgpt.md` | 28,447 | 24,820 | -12.8% |
| `installer/branches/claude-ai.md` | 26,126 | 18,436 | -29.4% |
| `installer/branches/claude-code.md` | 20,657 | 18,467 | -10.6% |
| `installer/branches/generic.md` | 11,717 | 8,923 | -23.8% |
| judge prompt, shipped block only | 11,292 | 9,670 | -14.4% |

Tokens are bytes/4, the usual rough English estimate, not a tokeniser count. Byte
counts are `wc -c` on the file, not the character count `assemble.py` prints; the
two differ by the non-ASCII characters in the branches. The judge row is the
fenced block as `assemble.py` slices it, stripped, remeasured this round at 11,292
and 9,670, one byte under the 11,293 and 9,671 the round-2 table carried.

So the honest headline is now: one block down 8.8%, one down 1.1%, one up 1.7%
and one up 0.5%. Two of the four blocks got bigger than they were before this
pass started, and the reason is sections 10 and 11, not arithmetic drift.

---

## 2. A-only fields: the fix, and why it went where it went

`source_stack` is the owner's example: it says "python scripts on macOS, local
scheduler, a small local model for summarising". B's assistant cannot reproduce
that and should not try. `spec/passport-0.1.md` line 42 already says so in the
strongest terms: *"It exists so B can weight the passport, not so the installer
can branch on it. Installers MUST NOT read it."* **The installer core never said
it.** The spec had the rule and the only document that ever reaches an installer
did not carry it.

**Where the fix went, and why not elsewhere.** Three places could have carried it:

1. Strip the fields at assembly. Rejected. `scripts/assemble.py` inserts installer
   text into the passport body; it never rewrites the passport. Stripping
   frontmatter would break `tools/validate.py` check 1, and the site's
   `web/lib/_render.mjs` hands the page the raw stored body, so the browser copy
   would still carry the fields while the CLI copy did not. Two different products
   from one source is worse than one honest instruction.
2. Change the passport format. Out of scope and wrong: the fields are the format's
   provenance contract and the passport page displays them to a human, which is
   their point.
3. **Tell the assistant, in the core, which fields are not build instructions.**
   Chosen. About 1 KB, paid in every block, and it closes the failure the owner
   named.

The new block sits directly under the prompt-injection paragraph, because it is
the same category of instruction: how to read this document. It covers four things:

- `source_stack`, `capture_path`, `scrub`: the original owner's machine and how the
  file was made. Do not reproduce, require or be steered by them. Of the
  frontmatter, only `owner_confirmed` changes behaviour, and only at step 1.
- `confidence: medium|low`: capture was unsure, so that field is a question for the
  installer, not a fact to assert. **These tags were previously inert.** The
  example passport carries nine `confidence:` lines and the template five, and
  every one of them shipped with no instruction attached. This is the cheapest
  available upgrade: it makes existing tokens do
  work rather than adding new ones.
- `[SCRUBBED:...]`: a removed value. Never guess it, never ask for A's version, ask
  the installer for theirs at step 5.
- Golden examples are shape, never content.

**Related fix in step 5.** The old core said "Do not offer the original owner's
values as defaults", which contradicts the spec: `personal_slots[].default` is "a
safe generic default" written at capture, not A's answer, while `why` is A's
reason. The old wording told the assistant to withhold something the format
intends it to offer. Now: offer `default` or `why` only if the installer stalls,
never as the recommended answer, never filled in silently.

**Also new, in step 6:** provenance does not go into the built agent. Only the
claude.ai branch said this. It is true on all four, and on any platform where the
agent re-reads its own instructions it is the difference between an agent and an
agent that narrates its own paperwork.

---

## 3. What moved from the branches into the core

Each of these was in three or four branches at similar length and is now stated
once. Consolidation, not compression: the byte win comes from deleting the branch
copies that shipped alongside the core.

| moved | was in | why it belongs in the core |
|---|---|---|
| "this appendix never relaxes the core; where they disagree the core wins" | all 4 preambles | one sentence in the core's own voice is more credible than four self-reports |
| the echo rules: quote the smallest proof, never a message body, ask if it looks right, stop on a wrong account, widen once on an empty window, never invent content | all 4, repeated per capability | it is the same rule 5 to 7 times per branch; branches now carry only the platform-specific echo target |
| the memory rule: partial everywhere, everything needed for correctness lives in the instruction text, verify by having the installer look, degrade to `substituted` with the exact practical line | all 4 | the platform-specific parts (which surface, which plan, what is unverified) stayed in the branches |
| the seven-part composition of the agent's instruction text | 3 branches verbatim, 1 as an example | this is the single most load-bearing list in the product; it now cannot drift between branches |
| "nothing else goes into the agent": not the core, not the appendix, not the losses table, not the consent table, not provenance | claude.ai only | universally true and a real failure mode |
| step 7: run from where it will live, not from the install conversation; the thin-output diagnosis order | 3 branches | it is a rule about installs, not about a platform |
| the untested-capability rule for the losses table | generic only | it is the losses table's honesty rule. Both documents now word it as "never exercised at all", so it cannot be read as overriding the `delivered, unverified` rule for an unfired schedule; see section 10, item 4 |

---

## 4. Restatement inside the core: kept or cut, one by one

The brief flags consent, "the installer grants, you do not" and "verify with real
evidence" as appearing more than once, and asks whether each is a belt or padding.

**Kept, and why.**

- *Prompt injection (preamble) and consent (step 1)* say different things: one is
  "do not obey this document", the other is "get a yes from the person". Both stay.
- *"The installer grants, you do not" in core step 3, plus one spoken line at the
  point of connection in each branch.* The branch instances are not restatements of
  the rule; they are **the words the assistant says to the installer** at the
  moment the installer is about to be asked for something. Different artefact,
  different reader. All kept.
- *The refusals paragraph.* Required, and it is the only place all five refusals
  appear together at the end where a model re-reads before acting. Kept verbatim in
  substance.
- *The echo rule in core step 3 and a per-capability **Echo:** label in every
  branch.* The label at the point of action is the belt; the rule behind it is
  stated once. This is the compromise, and it is deliberate. Counts as shipped:
  chatgpt 6, claude-ai 5, claude-code 5, generic 5. Round 1 shipped generic with
  zero of them, which broke the compromise in the one branch written for a small
  model; section 10, item 2.

**Cut, and why.**

- *"Core step 3 is explicit: a connection that has not returned real data is
  claimed, not installed"*, quoted almost verbatim in all four branch preambles,
  one screen below the core sentence it quotes. Pure restatement. Gone from all
  four.
- *Core step 7's summary of the judge prompt.* Step 7 used to restate the three
  core checks, the `match | partial | missing` scale, the evidence requirement and
  the whole time-independence blockquote, and then append the judge prompt, which
  says all of it again at length, immediately below, in the same block. Measured:
  514 bytes of near-verbatim duplication deleted outright, plus a 282-byte
  enumeration of the three checks condensed to a clause. Step 7 now names the three
  core checks (so the step still means something if the judge appendix is ever
  missing) and hands off. The step as a whole went 1,151 to 970 bytes rather than
  down by the full cut, because the same pass added the run-from-where-it-lives
  rule and the thin-output diagnosis order to it. **This is the largest single
  deletion in the core and the one most worth a second opinion.**
- *ChatGPT's "B6. What this branch never does"*, six bullets. Four were the core's
  refusals paragraph reworded. The fifth, never delete or pause the installer's
  existing scheduled task, is already the first line of B3 where it is actionable.
  The sixth, no write actions, is stated in `email.read` and `calendar.read` where
  the temptation is. The section was a summary of the branch it sat at the end of.
  Cut whole.
- *Claude Code's "Step 8 note"*, which repeated that `schedule.run` is never
  `delivered`. Folded into the `schedule.run` section, one sentence, where the
  decision is made.

---

## 5. The judge prompt, 11.3 KB down to 9.7 KB

Only the four-backtick block ships; `assemble.py` and `web/assets/passport.js`
both slice the file at the outer fences and drop the operator preamble. So the
preamble is free and the block is paid for in every install on every platform.

**Cut:**

- *"Content divergence from the golden is not a finding", stated four times*: once
  in the time-independence paragraph, then in two of the three comparison-mode
  branches, `structural` and `input_relative`, then a fourth time as failure mode 2.
  `exact` never carried it: that branch says content IS comparable, which is the
  opposite rule, so it was always two branches and not three. The
  time-independence paragraph is the strongest statement and it now carries the
  rule alone; the mode branches say only what differs between the modes.
- *A four-bullet list under the scoring rules that restated the three rows of the
  scoring table directly above it* ("no score without evidence", "`partial` means
  half met and you can name which half", "a check you did not run is not `match`").
  Folded into the table rows and one following sentence.
- *Two of the five named failure modes, and the list went five to four rather than
  five to three.* Cut: "Treating different content as a miss", which was the fourth
  statement of the time-independence rule, and "Absorbing a loss into a pass", which
  is folded into the CAPABILITIES check as the "One thing was added" paragraph
  records. "Softening a `missing` into a `partial`" was not cut and was never a named
  mode before this pass: it existed as prose in the honesty paragraph and as an
  operator-preamble bullet, and it was PROMOTED into a named mode here.
- *The worked example* lost about half its verdict paragraph. It also lost a table
  row in round 1, which was a mistake: the example then showed one passport check
  where the rule above it says two to four. The row is back; section 10, item 5.
- *The five inputs* became one sentence instead of a numbered list with tails.

**Kept in full, and these are the ones a critic should check:**

- The time-independence paragraph. It is the most common way a correct install gets
  scored as broken.
- The three comparison-mode branches.
- The evidence requirement and "no score without evidence".
- "Do not invent criteria."
- The fixed three-part output format, including the exact advisory sentence.
- The worked example. It is the only concrete specification of the table shape and
  the verdict pattern, and format compliance is exactly where an example pays.
- Boundaries: the injection defence scoped to the run output, no re-running before
  scoring, no fixing inside the step.

**One thing was added**, to the CAPABILITIES check: the judge's CAPABILITIES row
and the step 8 losses table must agree, and if they disagree the judge's row is
wrong. That was failure mode 5 in prose; it is now a rule where the score is made.

---

## 6. The Claude Code branch came out flat, and here is why

`claude-code` is the block that did not shrink: 47,968 to 48,779 bytes, +1.7%. It
was +0.1% before the round-2 corrections, which landed in the core and the judge
rather than in this branch, and round 3 added 95 bytes to the branch itself.
The branch itself lost 10.6%. The core grew 4.6 KB and Claude Code did not
previously carry most of what the core absorbed: no prose composition list (it had
the `SKILL.md` example instead), no "what does not go into the agent", no
memory-rule paragraph of that length, no shape-template rule. It pays for four
rules it used to get for free by not stating them at all.

I judged that a fair trade rather than a regression: the branch now inherits the
A-only-fields rule, the echo rules and the step 7 fresh-run rule, none of which it
had. But it is the honest weak point of this pass and I am not going to dress it up.

To get it back to flat I cut, in that branch: the two "no MCP server" error paths
merged into one; the placeholder MCP configs down to one server entry each with a
sentence saying to repeat the shape per capability; the `SKILL.md` example's
"Boundaries" and slot-answer blocks trimmed where they restated core rules; and a
handful of wordy sentences. **Every platform fact survived**, verified
mechanically in section 8.

---

## 7. Judgement calls I expect to be argued with

1. **Deleting claude.ai's "What this branch does better, factually"** (1.4 KB).
   Three points, spoken only if the installer asks how Claude compares. Point 1
   (connectors are not paywalled here, unlike ChatGPT) is already stated in that
   branch's `email.read` section. Point 2 (no instruction ceiling) is stated in its
   step 6. Point 3 (scheduling is the weak point, say so plainly) is stated twice
   already, in step 2 question 4 and in the `schedule.run` section. So the section
   was a third statement wrapped as a comparison, and it carried facts about a
   *different* platform into an install on this one. **Restorable in one paste if
   the owner disagrees**; the deleted text is in git.
2. **Cutting core step 7's restatement of the judge.** Defended above. The residual
   risk: if `web/assets/installer/judge.md` ever fails to load, `passport.js`
   silently ships the block without it, and step 7 is now thinner in that failure
   case than it used to be. It still names the three core checks and calls the
   scoring advisory. I did not add a guard for this because I do not own
   `passport.js`; see the follow-up in section 9.
3. **Keeping every quoted walk-through script in the ChatGPT branch**, which is why
   that branch only came down 12.8% while claude.ai came down 29.4%. Those blockquotes
   are the exact words the assistant says at the moments of highest installer
   anxiety: connecting a mailbox, hitting a task cap, being told the schedule will
   not survive. They are long and they change what the installer hears. Kept.
4. **Reordering the claude.ai branch into step order** (2, 3, schedule, 6, 7, error
   paths, 9). It used to run 2, 6, 3, schedule, 7, which asks a model reading once
   to hold the Project construction in memory before it knows what will go in it.
   No content moved between sections.
5. **Keeping the losses-table example at four rows in core step 8.** The four rows
   are the four statuses: `lost`, `substituted`, `delivered`, `delivered,
   unverified`. Dropping one drops a status.
6. **Not touching `scripts/assemble.py`.** Nothing about the assembly had to change.

---

## 8. How this was verified

- `python3 scripts/assemble.py examples/daily-brief-passport.md /tmp/asm.md &&
  python3 tools/validate.py /tmp/asm.md` prints **PASS**, and so does each
  `--branch=chatgpt|claude-ai|claude-code|generic`.
- `bash tools/run_tests.sh` prints **ALL TESTS PASSED**.
- Neither assembly hazard fires: no `comparison_mode:` assignment in installer text
  (`comparison_mode` in backticks with no colon is fine, and both `validate.py`
  check 5 and `assemble.py` match only the colon form), and no denied-path string.
- **Fact survival, mechanically.** Every backticked token, every dotted version
  number, every 2-to-4-digit number and every capitalised multi-word name in each
  original branch was extracted and searched for in the new branch plus the new
  core plus the new judge. Claude Code: 0 missing. Generic: 0 missing. ChatGPT: 2,
  both benign (`processing.ordering`, since restored, and a sentence fragment).
  claude.ai: 7, all from the deleted comparison section (`1,500` characters,
  "Free ChatGPT", "Free Claude") or capitalisation artefacts.
- **Contract survival.** Each assembled block was grepped for the nine step
  headings in order, the injection sentence, the credential refusal, the
  real-data rule, the `delivered, unverified` rule, the bundled-grant paragraph,
  "ask before substituting", "one at a time", "even if every row says delivered",
  the refusals section and the new A-only-fields block. All four blocks carry all
  of them.
- No em-dashes or en-dashes anywhere in the changed files.

**Not verified:** nobody has run an install with these files. Whether the shorter
judge scores as honestly as the longer one, and whether the core's echo rules
survive being one screen further from the point of action than the branch copies
were, are empirical questions this pass cannot answer. They need a run of the
verification loop, not a byte count.

---

## 9. Follow-ups outside this track's ownership

1. **`web/assets/passport.js` silently drops the judge prompt if
   `/assets/installer/judge.md` 404s** (`.catch(function () { return ''; })`). With
   core step 7 no longer restating the rubric, that failure now ships a block whose
   verification step is a pointer to something absent. A block missing the judge
   should say so in the block, the way a missing branch already refuses to build.
2. **`spec/passport-0.1.md` line 42 says installers MUST NOT read `source_stack`.**
   That rule now exists in the installer core too. If the spec is ever revised,
   the two need to move together.
3. **The shipped skill folder is a second copy and nothing in CI refreshes it.**
   `skills/agent-passport/references/` holds tracked copies of the core, the judge
   and all four branches, and `assemble.py` resolves them when it runs from inside
   the skill folder, which is how the zipped skill is used. Round 1 left all six
   stale, so a capture done through the skill produced a passport carrying the
   pre-pass core. Round 2 ran `scripts/build.sh`; round 3 copied the three branches
   it edited across by hand, which is the same `cp` build.sh performs for them, and
   all six files are byte-identical to the canonical ones, verified with `diff -q`:
   `references/installer-core.md`, `references/judge-prompt.md` and
   `references/installer-branches/{chatgpt,claude-ai,claude-code,generic}.md`.
   The follow-up that remains is not this track's: nothing in
   `.github/workflows/` or `.githooks/` runs `scripts/build.sh`, so the next
   edit to a canonical installer file will strand these six again. That wants a
   pre-commit check or a CI step that runs the build and fails on a dirty tree.
4. **`web/assets/installer/**` is also a copy, and that one is fine.**
   `web/build.sh` copies the canonical core, branches and judge into it at deploy
   time, and `.github/workflows/deploy-web.yml` triggers on `installer/**` and
   `verification/judge-prompt.md`, so the site cannot serve stale installer text
   after a push. The local files under `web/assets/installer/` are untracked build
   output and were left alone: they are stale on this machine, which is harmless
   and is not something this track should fix by hand.
5. Nothing in `web/` was touched by this track.

---

## 10. Round-2 corrections, after review

Six defects, all of them things round 1 broke rather than things it failed to
improve. Round 1's block sizes: chatgpt 53,524, claude-ai 47,946, claude-code
48,019, generic 37,569. Round 2 took them to 55,046, 48,749, 48,684 and 39,227,
so the corrections cost 1,522 bytes in the chatgpt block, 803 in claude-ai, 665 in
claude-code and 1,658 in generic, and they are worth it: five of the six were
contradictions between two documents that a model reading once cannot resolve.

1. **`chatgpt.md` claimed a six-row table was core step 6's seven-part list, and
   the missing part was `tacit_notes`.** Core step 6 says the notes are never
   paraphrased and never dropped, core's preamble says the core wins on a
   disagreement, and the branch with the only hard length budget gave the notes no
   budget line and left them out of "never drop". So the one place the rule was
   most likely to bite was the one place it was unenforceable. Fixed on both sides.
   The budget table now has seven rows mapped to core's seven parts by number, two
   of them merged into one line and the output contract split in two, summing to
   1500 exactly: 100 / 350 / 250 / 300 / 120 / 250 / 130. `tacit_notes` gets 250
   characters and joins the never-drop list, which round 2 took to five items and
   round 3 to six; see section 11, item 1. The golden shape hint is named as what it
   is, a platform extra that is not part of core
   step 6 and the first thing cut. The worked task-instruction shape gained the
   attributed-notes line, because an example that omits a part of the contract is
   how the contract gets dropped. Error path B5.4's spoken list of what will not be
   cut gained the notes too. Core step 6 gained one sentence saying that where a
   branch caps the length it says which parts compress, and that the slot answers
   and the notes are not among them: if the cap cannot hold them, that is a scope
   conversation and a `lost` row, not a silent trim. The two documents now say the
   same thing in both directions.
2. **`generic.md` shipped with zero `**Echo:**` labels while section 4 above
   claimed one in every branch.** The claim was the thing that had to be true, not
   the other way round: generic is the branch addressed to a small model that is
   told to work one capability at a time and not to summarise, and it was the one
   branch where the echo target was 12 KB away in the core with nothing at the
   point of action. Restored as one line each under `web.fetch`, `email.read`,
   `calendar.read`, `files.read` and `memory.prefs`, naming only the platform-
   specific target, since the core carries the rules. Note this is five where the
   pre-pass file had four: `memory.prefs` never had one and needed it, because
   "your own claim to have saved something is not evidence" is exactly the trap a
   small model falls into. **Verify** is also its own numbered move in G1 again,
   four moves instead of three, for the same reason: one action per move.
3. **The tracked skill copies were stale.** Recorded in section 9, item 3, with the
   six files named and `scripts/build.sh` run.
4. **Core step 8's untested-capability sentence contradicted core step 3.** "A
   capability you never tested is `lost`, not `delivered`" against step 3's "an
   unfired schedule is `delivered, unverified`, never `delivered`": an unfired
   schedule is untested by definition, so the two rules pointed at different cells
   and the four-status table two lines above was demonstrating a third answer.
   Core step 8 now reads "A capability you never exercised at all is `lost`, not
   `delivered`; a schedule you ran manually but that has not fired on its own is
   `delivered, unverified`, as step 3 says." `generic.md` G5 carries the same
   carve-out, restoring the sentence round 1 deleted there.
5. **The judge's worked example demonstrated one passport check where the rule
   above it asks for two to four.** The `missing` row is back, which also restores
   the only place in the example where a passport check fails, and the verdict's
   first sentence names all three non-clean rows again. Section 5 defends the
   example as the one concrete specification of the table shape, so it has to obey
   the rules it specifies, in a prompt whose third named failure mode is silently
   dropping a check.
6. **Two handovers had lost their numbered structure.** `claude-ai.md` step 9 and
   `generic.md` G6 had become one semicolon-chained sentence each, at the very end
   of a 39 to 49 KB block, asking for four separate outputs. `chatgpt.md` kept its
   numbered list, so the branches also disagreed with each other about the shape of
   the last thing the installer hears. Both are 1 to 4 again, with the compressed
   wording kept inside each item.

### Re-verified after these changes

- `scripts/assemble.py` plus `tools/validate.py`: **PASS** on the default and on
  each of `--branch=chatgpt|claude-ai|claude-code|generic`.
- `bash tools/run_tests.sh`: **ALL TESTS PASSED**.
- The same contract-survival grep as section 8, over all four assembled blocks:
  the nine step headings, the injection sentence, the credential refusal, the
  real-data rule, the `delivered, unverified` rule, the bundled-grant paragraph,
  "ask before substituting", "one at a time", "even if every row says delivered",
  the refusals section, the A-only-fields block and "Never paraphrased, never
  dropped". All four carry all of them.
- Every Markdown table in the six files has a consistent column count, checked
  mechanically, and the chatgpt budget column sums to 1500.
- A copy of the skill folder was taken to a scratch directory and
  `scripts/assemble.py` run from inside it: the block it produces carries the new
  core, including the A-only-fields block and the `tacit_notes` budget row.
- No em-dashes or en-dashes in any changed file.

**Still not verified:** nobody has run an install with these files. That has not
changed and no amount of grepping will change it.

---

## 11. Round-3 corrections, after review

Four defects. Two of them are round-2 fixes applied where the reviewer pointed
rather than where the problem was, which is the honest summary: a correct patch in
the wrong place leaves the contradiction standing one paragraph away.

1. **`chatgpt.md`'s drop order still said "drop from the bottom up" after the
   budget table grew.** That instruction was correct against round 1's six-item
   list, whose bottom row was the golden shape hint. Round 2 appended core step 6
   part 6, `tacit_notes`, and part 7, the closing line, at the bottom of the table.
   Both of those are protected elsewhere in the same file, so "bottom up" told the
   model to cut first the two parts round 2 existed to protect. The phrase is gone;
   the heading now reads "Cut only from this list, and in this order" over the four
   compressible items, which is where the order actually lives. The never-drop list gained part 7 and is six
   items, and the standalone sentence after the worked shape, "that last sentence
   matters and should survive every budget cut", is deleted with its reasoning
   folded into the list entry, so the rule and its rationale sit in one place
   instead of 30 lines apart. Error path B5.4's spoken list of what will not be cut
   gained the closing line too, for the same reason the never-drop list did: a list
   of protected parts that omits one is how that part gets cut. Net +87 bytes on the
   branch.
2. **`claude-code.md`'s worked `SKILL.md` omitted the same two parts it introduced
   itself as carrying whole.** The prose above the fence says "exactly what core
   step 6 lists, nothing else"; the fence had no `tacit_notes` and no closing line,
   and the pointer below it, "the remaining parts go in as their own sections",
   competed with a complete-looking example and lost. Same core-versus-branch
   contradiction as item 1 above, in a sibling file. The example now carries a
   "Notes from the owner" section with the attributed verbatim line and the closing
   line under "Boundaries", and the pointer is deleted as redundant. Net +95 bytes.
3. **`generic.md`'s five restored `Echo:` labels were inlined mid-paragraph.**
   Round 2 restored them for point-of-action visibility in the one branch written
   for a small model, then buried each one between "Needs:" and the `Degradation:`
   label in a single run-on line. Every other branch, and `schedule.run` in this
   same file, put those labels on their own line. Each of the five paragraphs is now
   split so `Echo:` and `Degradation:` begin their own line. Content unchanged,
   +9 bytes.
4. **Two numbers in these notes contradicted the tables above them.** The section 5
   heading said the judge went to 9.5 KB when the shipped block is 9,670 bytes, and
   section 7 item 3 said the ChatGPT branch came down 16% when the per-file table
   says -12.8%. Both fixed. Re-reading every other figure against its source found
   five more: the round-2 cost of the claude-code corrections was 665 bytes, not
   666; the judge row counted one byte more than the block `assemble.py` actually
   slices; section 1's "11 to 29 percent" was 10.6 to 29.4 after the branch sizes
   moved; the "roughly fifteen `confidence:` lines" in section 2 are nine in the
   example passport and five in the template, so the claim now names both; and
   section 4's "about 1.1 KB of duplication" in core step 7 was 514 bytes deleted
   outright plus a 282-byte enumeration condensed, against a step that went 1,151 to
   970 bytes because the same pass added two rules to it.
   Section 10's round-2 figures are now stated as absolute block sizes
   rather than as deltas against the section 1 table, so a later round changing that
   table cannot make them wrong again.

### Re-verified after these changes

Every number in section 1 was remeasured this round with `wc -c`, not carried over.

- `scripts/assemble.py` plus `tools/validate.py`: **PASS** on the default and on
  each of `--branch=chatgpt|claude-ai|claude-code|generic`.
- `bash tools/run_tests.sh`: **ALL TESTS PASSED**.
- The same contract-survival grep as section 8 over all four assembled blocks, plus
  "Never paraphrased, never dropped" and the closing line "Do not add sections or
  sources beyond those above". All four carry all of them, and the injection
  paragraph still sits at the same offset in all four.
- The chatgpt budget column still sums to 1500, extracted from the table
  mechanically. No "bottom up" *instruction* survives in `installer/core.md` or
  `installer/branches/`; the only occurrences left under `installer/` are the
  quotations in these notes, which is what this file is for.
- No em-dashes or en-dashes in any changed file.
- The three edited branches were copied into
  `skills/agent-passport/references/installer-branches/`, which is what
  `scripts/build.sh` does for those files, so the tracked skill copies are not
  stale again. `scripts/build.sh` itself was not run: it rewrites files across the
  whole repo while other tracks are editing them.
