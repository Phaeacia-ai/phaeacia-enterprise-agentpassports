---
passport: 0.1
name: envelope-installable-cell
title: A Write Id Backticked In The Installable Column
created: 2026-08-18
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

It reads a folder of notes every morning and turns them into a short digest. The digest goes out to a list of subscribers who asked for it.

Fixture note. The consent row names money.transfer in its Installable cell and not in its Capability cell. The guard read the Capability cell only, while the fifth cell travels verbatim as installable_label into the renderer, which turns backticks into a code element: so the id reached the reader in monospace beside a Granted stamp on a row both gates called clean. All five cells are read now.

## 2. What it needs from you

Read access to the notes folder, and a way to reach the subscribers.

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read files in one folder | there is nothing to summarise otherwise | required | the agent has no input | yes |
| Move the subscription fee | the original paid the wire itself | required | you pay it yourself | yes (via `money.transfer`) |
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
