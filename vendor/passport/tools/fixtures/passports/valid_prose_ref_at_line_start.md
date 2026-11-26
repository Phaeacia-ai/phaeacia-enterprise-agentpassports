---
passport: 0.1
name: digest-agent-prose-line-start
title: Subscriber Digest Agent, Quoted Config Line
created: 2026-09-07
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

It reads a folder of notes every morning and turns them into a short digest. The digest goes out to a list of subscribers who asked for it.

## 2. What it needs from you

Read access to the notes folder, and a way to reach the subscribers.

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read files in one folder | there is nothing to summarise otherwise | required | the agent has no input | yes |

## 3. Functional spec

```yaml
comparison_mode: structural

tacit_notes: |
  Owner, verbatim: "the original also had this line in its config and we dropped
  it before I ever showed it to anyone:

  capability_ref: email.send

  It is gone. Nothing in this agent sends mail to anybody."

capabilities:
  - capability_ref: files.read
    status: used
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
