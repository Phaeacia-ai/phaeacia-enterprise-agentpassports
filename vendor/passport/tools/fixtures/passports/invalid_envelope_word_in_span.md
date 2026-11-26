---
passport: 0.1
name: envelope-word-in-span
title: A Write Id With A Word Beside It Inside One Code Span
created: 2026-08-18
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

It reads a folder of notes every morning and turns them into a short digest. The digest goes out to a list of subscribers who asked for it.

Fixture note. The consent row backticks `email.send now`. The opaque rule carves out multi-word inner segments, so prose between two code spans is not opacity-tested, and the write-id test compared a fixed id to the whole segment. One word beside the id inside the same span was therefore read by neither, and the row rendered under a Granted stamp. Every word of an inner segment is read on its own now.

## 2. What it needs from you

Read access to the notes folder, and a way to reach the subscribers.

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read files in one folder | there is nothing to summarise otherwise | required | the agent has no input | yes |
| Mail the digest (`email.send now`) | the original mailed it | required | no digest arrives | yes |
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
