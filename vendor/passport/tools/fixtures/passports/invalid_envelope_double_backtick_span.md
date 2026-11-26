---
passport: 0.1
name: envelope-double-backtick-span
title: Write Id Inside a Double-Backtick Span
created: 2026-08-18
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

It reads a folder of notes every morning and turns them into a short digest. The digest goes out to a list of subscribers who asked for it.

Fixture note. The CommonMark way to show a literal backticked token: a double-backtick span around a single-backticked money.transfer. Six backticks, an even count, and the single-backtick pairing still put the id between two spans rather than inside one, so neither gate enumerated it until 2026-09-04. Split on every backtick, it is a segment like any other and both gates refuse.

## 2. What it needs from you

Read access to the notes folder, and a way to reach the subscribers.

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read files in one folder | there is nothing to summarise otherwise | required | the agent has no input | yes |
| Move the fee (`` `money.transfer` ``) | the original paid the wire itself | required | you pay it yourself | yes |
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
