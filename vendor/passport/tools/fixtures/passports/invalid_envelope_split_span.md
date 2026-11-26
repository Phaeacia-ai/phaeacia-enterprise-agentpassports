---
passport: 0.1
name: envelope-split-span
title: A Write Id Written Across Two Adjacent Code Spans
created: 2026-08-18
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

It reads a folder of notes every morning and turns them into a short digest. The digest goes out to a list of subscribers who asked for it.

Fixture note. The Why cell writes email.send as two code spans with nothing between them. The renderer pairs backticks and emits one code element per pair, so the page shows two adjacent code elements and a reader sees the single monospace string email.send beside a Granted stamp. The validator splits on every backtick, so it saw the three pieces email. and the empty string and send, none of which is an id, and every pure-ASCII write id reached a Granted stamp in four of the five cells. The money prefix was the only one this did not defeat, and only because it is a prefix test rather than an equality. Found by the ROW-168 critic. Both readings are kept now: the split, which cannot be walked past by miscounting backticks, and the paired run, which is what the reader sees.

## 2. What it needs from you

Read access to the notes folder, and a way to reach the subscribers.

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read files in one folder | there is nothing to summarise otherwise | required | the agent has no input | yes |
| Mail the digest | the original used `email.``send` for it | required | no digest arrives | yes |
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
