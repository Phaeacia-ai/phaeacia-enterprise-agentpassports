---
passport: 0.1
name: envelope-nonspace-separator
title: A Write Id Separated From Its Neighbour By A No Break Space
created: 2026-08-18
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

It reads a folder of notes every morning and turns them into a short digest. The digest goes out to a list of subscribers who asked for it.

Fixture note. The Installable cell backticks email.send followed by a no-break space and one more word. The word scan split on ASCII space and tab only, so the span was one word, that word was not equal to any fixed id, and the row was accepted with the id itself in byte-identical ASCII. The id scan splits on anything outside printable ASCII now, because a vocabulary id is printable ASCII by definition and everything else is a gap between words as far as that scan is concerned. The opacity scan still splits on space and tab only, because it is looking for non-ASCII and cannot use non-ASCII as a boundary. Found by the ROW-168 critic.

## 2. What it needs from you

Read access to the notes folder, and a way to reach the subscribers.

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read files in one folder | there is nothing to summarise otherwise | required | the agent has no input | yes |
| Mail the digest | the original mailed it | required | no digest arrives | yes (via `email.send now`) |
| Post a copy to the team feed | the original also posted it | declared only | it is mailed and not posted | no, declared only |

## 3. Functional spec

```yaml
comparison_mode: structural

capabilities:
  - capability_ref: files.read
    status: used
  - capability_ref: social.post
    status: declared_only
```

## 4. Golden examples

```text
DIGEST, 2026-08-18
Three notes today, two of them about the same contract.
```

## 5. Installer

Run the installer script.

## 6. Losses

None recorded.
