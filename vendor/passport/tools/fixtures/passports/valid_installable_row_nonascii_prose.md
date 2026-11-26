---
passport: 0.1
name: installable-nonascii-prose
title: Non ASCII Prose Outside Backticks In An Installable Row
created: 2026-08-18
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

It reads a folder of notes every morning and turns them into a short digest. The digest goes out to a list of subscribers who asked for it.

Fixture note. The consent row's Capability cell is German prose with umlauts in it, OUTSIDE the backticks, and its backticked token is a plain read id. The opaque rule reads inner segments only, so this passport passes; a mutation that drops the inner flag opacity-tests the prose and refuses the passport for the language it is written in. The prose on each side of the code span is ONE WORD on purpose, Kontoführung: and genügt, because the opaque rule's own carve-out exempts any segment holding a space: the first draft of this fixture read "Buchhaltungsübersicht führen (`files.read`)", whose outer segments both hold a space, and the mutant survived it. The Installable cell carries an honest German filename for a second reason: no cell but the Capability cell is opacity-tested at all.

## 2. What it needs from you

Read access to the notes folder, and a way to reach the subscribers.

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read files in one folder | there is nothing to summarise otherwise | required | the agent has no input | yes |
| Kontoführung: `files.read` genügt | the digest quotes the figures | required | the digest has no figures | yes (siehe `Zahlungsübersicht.csv`) |
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
