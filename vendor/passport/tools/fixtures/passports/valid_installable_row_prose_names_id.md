---
passport: 0.1
name: installable-prose-names-id
title: An Installable Row Whose Prose Names A Write Id Without Backticks
created: 2026-08-18
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

It reads a folder of notes every morning and turns them into a short digest. The digest goes out to a list of subscribers who asked for it.

Fixture note. The consent row's Why cell says money.transfer in plain prose, with no backticks anywhere. That is the prose-to-id gap (ROW-165), open on purpose: the format links no consent row to an id unless the author backticks one, and reading bare prose here would refuse the honest sentence "the original used email.send" in a row that installs nothing but files.read. This fixture pins that the word scan reads inside backticks only.

## 2. What it needs from you

Read access to the notes folder, and a way to reach the subscribers.

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read files in one folder | there is nothing to summarise otherwise | required | the agent has no input | yes |
| Read files in one folder | the original paid with money.transfer and this one does not | required | the agent has no input | yes |
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
