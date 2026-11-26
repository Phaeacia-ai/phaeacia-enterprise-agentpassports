# Administering your company in Phaeacia

For the person who administers a company in Phaeacia Enterprise: inviting people, handling departures,
transferring agents, withdrawing a release, taking a copy of your records, and what happens when your
agreement ends. Section 10 is the path every member follows to put an agent in, which you will be asked
about.

This guide was written for the one internal instance Phaeacia ran. Where it says "Phaeacia" as the party
that resets a factor, produces an export or deletes a company, read "the operator of your instance". It
describes what the product does, including where it stops. Where something is a statement by a person
rather than a check the product makes, this guide says so, because the difference matters when something
goes wrong.

---

## 1. What Phaeacia is here for, and what it does not do

Phaeacia carries a configuration from the person who built an agent to the people who are meant to run
it, with a record of who approved it and who received it.

**Approval governs the configuration a recipient receives.** It does not control what a recipient's
assistant does with it afterwards. An approved release is a document that an assistant is asked to
follow; the assistant runs on a vendor's platform under that recipient's own accounts, and Phaeacia
has no presence there.

**A prompt is not a permission.** Text in a configuration that says an assistant may do something does
not grant it anything. Whatever the assistant can reach, it can reach because your own platform
administrator granted it, and whatever it cannot reach stays out of reach no matter what a
configuration says. Read every approval as approving a description, not a capability.

---

## 2. Your second factor

Every administrator action needs a verified authenticator. Signing in with the emailed link gets you
in; it does not get you to an administrator page. You enrol a TOTP authenticator on `/account/` and
the product asks for a code before anything that changes your company.

Why it is required only of administrators: an administrator can invite, remove, set roles, withdraw
and export, and those are the acts worth a second check. Members do not carry that, and requiring it
of everyone was considered and not chosen, because the cost is lockouts.

**If you lose your authenticator:**

- **If your company has a second administrator, it keeps working.** They carry on without you. The
  product refuses to remove the last administrator, so a company that has two can never be left with
  none; it does not follow that every company has two, and a company with one administrator who loses
  their authenticator is exactly the case the reset call below exists for. If you are the only
  administrator, give a second person the role before you need to.
- **You cannot fix it yourself.** While a verified factor exists, the product refuses to enrol another
  one, and refuses to remove the existing one from a session that only has the link. That is
  deliberate: the alternative is that whoever holds your mailbox can replace your second factor.
- **Phaeacia can reset it, after identifying you on a call.** Not by email from your own address, and
  not through the mailbox the sign-in link goes to. A live call in which the operator recognises you,
  or in which an administrator they already know vouches for you, is what counts. You enrol a new
  authenticator during that same call, because the account is back to link-only until you do.

---

## 3. Inviting people

**A link can sign its holder in. Treat every link like a password.** That is the whole shape of it:
anyone holding a link that signs in is the person you invited, as far as the product can tell.

- It **works once**. After it is used, it is spent.
- It **expires on the date shown** on the invitation card.
- **A resend replaces it and stops the earlier one.** If you are unsure who has an old link, resending
  is how you kill it.
- Open a mailed invitation **within the hour**. The invitation itself lasts longer, but the sign-in
  token inside it is shorter-lived, and once it has aged out the link cannot sign you in. A resend is
  the way on; there is nothing else to try.
- **Some links do not sign anyone in**, and the page says so beside the link. That happens when the
  address already has an account somebody uses: the person signs in with their own address first and
  then opens the link to accept. It also happens when another company invited the same address within
  the last hour; then the person cannot use it yet, and a resend after that hour gives a link that
  signs them in.

**When a mail does not arrive.** Check the address on the invitation card first, character by
character: a typo is the common cause and nothing in the product can catch it. Then press Resend,
which issues a new link and revokes the old one. If it still does not arrive, tell Phaeacia; the
invitation itself exists and is pending either way, so nothing is lost by waiting.

**The card says "Created", not "Sent".** Phaeacia does not store a delivery receipt, and a refused or
unconfirmed send leaves exactly the same row, so the honest label is the one about the record it does
have.

If the answer said the delivery could not be confirmed, take it literally: the message may or may not
have gone out. The recovery is the same in both cases, a Resend, which also kills any link that did go
out.

**Your limits.** Twenty-five members per company and fifty pending invitations. Both are set by
Phaeacia per company; if the envelope is wrong for you, that is a conversation, not a setting you can
change.

---

## 4. When someone leaves

Press Remove on the members page and **read the departure preview before you confirm**. It reads your
company as it is at that moment and tells you two things: what stops and what stays. Those counts were
true when the page read them, and somebody can change them before you press Remove.

**What stops.** They lose all access to this company at their next request. Not instantly: a browser
session that is already signed in holds an access token until it expires, which on this configuration
is one hour, and nothing can call that token back before then. The product does not pretend otherwise.
What it does do is refuse them at the next request the token is used for.

**What you transfer first, and why.** If they own agents, the preview says so, and it says how many
current releases stop being downloadable **for everybody** until each agent is transferred. That is
the sharp edge of a departure: removing an owner quietly turns off downloads that other people depend
on. Transfer their agents to another member before you remove them, and nothing stops. The preview
also tells you if they are the sole holder of a reviewer role, in which case reviews needing that role
wait until you give it to somebody.

**What removal cannot undo.**

- The membership stays, as a former member, so every earlier record still names who did what.
- Everything they contributed, reviewed, published, downloaded, reported or witnessed stays recorded
  as it is.
- Releases they published stay published. Their earlier downloads stay recorded.
- **Their account stays.** It belongs to them, not to this company, and any other company they belong
  to is unaffected.
- **Inviting them again restores the membership, but not their groups and not the agents they owned.**
  Those are separate acts.

**The last administrator cannot be removed.** Give another member the administrator role first. This is
not a suggestion the page makes; it is a refusal.

**Invitations they sent go with them.** Removing an administrator, or taking the administrator role away,
revokes every invitation they sent that is still pending, and an invitation they sent can no longer be
accepted once they stop being an administrator here. If one of those people should still join, invite
them again yourself.

---

## 5. Transferring an agent

An agent has one owner, and only an administrator moves it. Transfer is on the members page, from the
row of the person who owns it.

Transfer it **before** the owner leaves, not after. A transfer while they are still a member is one
act and nothing stops; after they are removed, their agents are marked orphaned and their current
releases are not downloadable until somebody owns them again.

A transfer moves ownership and nothing else: the agent's versions, its releases, its history and its
audience are unchanged, and every earlier record still names whoever did the work.

---

## 6. Withdrawing a release, and the checklist that comes with it

Withdrawal is on the release page, and the page states its own limit before you press it:

> Withdrawal stops new downloads through Phaeacia. It cannot remove copies already downloaded, vendor
> account grants, or configurations already installed in a recipient's assistant.

That is why withdrawal comes with a removal checklist rather than a button that finishes the job.
Three lines, as the release page states them:

1. Ask each recipient listed to remove the installed instructions from their assistant.
2. Ask the native administrator to remove any connector or account grant the configuration asked for.
3. A recipient who confirms can record it here as a removal report, and a reviewer or administrator
   can witness it. Both are statements by people, not checks by Phaeacia.

Read the third line carefully. A removal report is somebody saying they removed something. A witness is
somebody else saying they believe it. **Neither is a check Phaeacia made**, and the product never
claims to have verified a removal. What it gives you is a record of who said what and when, which is
what an audit of a withdrawal can actually rest on.

---

## 7. Taking a copy of your company's records

Press **Export** on the members page. It needs your second factor, and it gives you one JSON document
of your company's records: your members and their roles, your agents and their versions, your
releases, reviews, groups, the download ledger, removal reports and witnesses, and your company's
audit trail.

**What it withholds, and why:**

- **Another author's unsubmitted draft.** A version that has not been submitted for review is that
  author's working material, and an export is not a way around that.
- **Your agreement's dates.** They are Phaeacia's record of the commercial arrangement, not your
  company's content. If you need them, ask; they are in your agreement.

**The copy leaves with whoever takes it.** Once it is on your machine it is yours, outside Phaeacia's
control entirely, and nothing in the deletion schedule below reaches it. Store it accordingly.

**If the Export button cannot serve you**, Phaeacia produces the same copy owner-side and hands it
over. Three cases: your company's records are larger than the page's limit and the button refuses; you
can no longer sign in; or the company is closed. In each case:

- Phaeacia needs **your written instruction**. Its reference is written into the file's own key and
  into Phaeacia's lifecycle register. Your company's own audit trail records that a complete copy was
  taken, when, and by which Phaeacia operator, but not the reference itself: the audit trail accepts
  no free text.
- The file arrives through **a channel you name in writing**, encrypted, and never as a mail
  attachment.
- **Check the SHA-256.** Phaeacia sends it separately from the file. If the two do not match, do not
  use the file; ask again.
- The copy is **more complete** than the button's: it includes every author's drafts and your
  agreement's dates, and carries a key saying under what authority it was produced.
- Phaeacia deletes its local copy once you confirm receipt, and records that it did.

---

## 8. When your agreement ends

The schedule, in order:

1. **Writes stop at the end date.** Nobody can publish, submit, review, invite or change anything.
2. **Reading and Export continue for fourteen days.** This window exists so you can take your copy.
   Take it; the window is the last chance and nothing reopens it.
3. **After fourteen days, none of your company's records can be read.** Every read tests the date
   itself, so this happens on time whatever anyone does; what still answers is the notice on your home
   page that the access period has ended. Phaeacia then suspends the company, and closes it before the
   deletion below.
4. **Deletion follows within the next thirty days.**

**What deletion reaches:** every record of your company in Phaeacia's live database. Memberships,
invitations, agents, versions, releases, reviews, groups, the ledger, reports, witnesses and the
company row itself.

**What it does not reach:**

- **The database provider's backups**, until they age out. How long that is depends on the operator's
  hosting plan and is theirs to state. Until they do, take it that a backup of your records exists for
  some period after the live deletion.
- **Copies anyone exported**, yours included.
- **Configurations already installed** in anyone's assistant, and any vendor account grant they asked
  for.
- **The accounts of people who belong to another company.** Their account is theirs; only their
  membership of your company goes.
- **Your members' own accounts and display names**, including the accounts of people who belong to
  no other company. Deletion removes each person's membership of your company; the sign-in account
  (their address) and the display name they chose are not touched. Phaeacia's account sweep removes
  only accounts that were never confirmed and carry no display name, so the account of anyone who
  ever signed in stays after the deletion.

**Instant erasure is not promised**, and this guide will not promise it. What is promised is the
schedule above and a record of the deletion that survives a restore from backup.

---

## 9. Who to contact

The operator of your instance names the contact. Mail from the instance carries a reply-to address when
one is configured. Otherwise, use the channel through which your company was onboarded.

---

## 10. Putting an agent in: the author's path

Everyone in your company can put in an agent they built, administrators and reviewers included. This is
the path they follow; you may be the first to try it.

**Where.** "Your agents" is the first of the company links, on your members page and under each company
on the home page. It lists your own drafts and the versions you submitted, and nobody else's. Only the
author ever sees a draft, an administrator included. Versions other people submitted are on Reviews, for
reviewers and administrators.

**1. The file.** An agent comes in as one Markdown file, the passport, which your own assistant writes
at the end of the capture interview. "Capture an agent" on Your agents opens the page for it. Its first
step is the capture prompt: copy it into a new chat with an assistant your company has approved and
answer its questions. An agent that lives in a folder on your computer is captured the same way for now,
by pasting its instructions into that chat. Never paste a password, key or other secret into it.

**2. Upload.** The page's second step, "Upload the passport file", asks for a name (lowercase letters,
digits, dots and hyphens, up to 64 characters; it stays with every version) and the passport, pasted into
the text box or chosen as a file. The same form is at "Upload a new version" on an agent's card in Your
agents, without the name. A chosen file is sent exactly as it was saved and the text box is then ignored. "Upload and check"
sends it; anything over 256 KiB (262,144 bytes) is refused on the page before it is sent.

- **If the content checks refuse it**, the page shows the service's message and each problem with the
  line it is on. Nothing is stored. The service never sends your text back. Fix the file and upload it
  again.
- **If the name is taken**, and the agent is yours, open it in Your agents and choose "Upload a new
  version" instead.

**3. The draft.** An accepted upload becomes a private draft. Its page has the text to edit and, under
"What the service stored", the service's own reading of what it kept: the title and summary, what the
agent needs (a capability marked "declared, not installed" is described but not installed by this
version of the format), the losses table, which says what does not carry over and is always shown, the
last check, and the stored text. "Save and check" checks your edit and replaces the draft; if the checks
refuse it, nothing is saved and the stored draft stays as it was. If the draft was changed in another
window, the page says so and offers "Load the stored draft"; your unsaved text stays until you press it.

**4. Submit.** Save first: submitting sends the stored draft, not the text box, and the button waits
until the two agree. The page asks where the agent was built, how sure you are that the passport
describes it completely, what data it may see, what it depends on, which colleagues worked on it, and
the names of anyone outside Phaeacia who helped. A colleague you name cannot review it. **An outside name
is recorded as you give it; Phaeacia checks nothing about it.** "Submit for review" asks once more, and
then the service checks the stored text again under the current checks and freezes the version with
that check. Nothing in a submitted version can change afterwards.

**5. After.** The submitted page says where the version stands: waiting for review, approved, replaced by
a newer version, or changes requested, with each reviewer's reason. On a version with changes requested,
"Start a new version from this one" makes a new draft with the same text, and the people recorded on the
old version stay recorded on the new one. "Upload a new version" starts one from a new file instead.

**What the checks are, and are not.** They refuse a passport that breaks the format or its content rules,
for example something that looks like a credential, HTML, a carriage return that would change on
installation, or a public publishing route; the refusal names which. Passing them says the file is well formed and carries none of those. It is not a review of what
the agent does; that is what your reviewers are for.

When your company is suspended or its agreement has ended, the upload page says so and offers no form,
and Your agents shows the service's answer with a link home.
