---
passport: 0.1
name: envelope-spaced-token
title: Write Id With a Trailing Space Inside the Backticks
created: 2026-08-18
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

It reads a folder of notes every morning and turns them into a short digest. The digest goes out to a list of subscribers who asked for it.

Fixture note. The consent row backticks `email.send ` with one trailing space inside the backticks. A critic dropped the .trim() from the JavaScript token read and every suite stayed green while the site accepted this row and validate.py refused it; no fixture carried a padded token, so parity had nothing to compare. This one does. Both gates read the token trimmed and refuse.

## 2. What it needs from you

Read access to the notes folder, and a way to reach the subscribers.

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read files in one folder | there is nothing to summarise otherwise | required | the agent has no input | yes |
| Move the subscription fee (`email.send `) | the original paid the wire itself | required | you pay it yourself | yes |
| Post a copy to the team feed | the original also posted it | declared only | it is mailed and not posted | no, declared only |

## 3. Functional spec

```yaml
comparison_mode: structural

capabilities:
  - capability_ref: files.read
    status: used
  - capability_ref: money.transfer#1
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
