---
passport: 0.1
name: money-undeclared-hash-ref
title: Undeclared Money Capability Offered as Installable, Hash-Suffixed Ref
created: 2026-08-18
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

It reads a folder of notes every morning and turns them into a short digest. The digest goes out to a list of subscribers who asked for it.

Fixture note, because this file does two jobs. It was valid_money_hash_ref until 2026-09-04, named valid_ ONLY because both gates AGREED on it: the ref carries a hash suffix, a hash opens a YAML comment only after whitespace, so money.transfer#1 is one scalar, and the two capture regexes once disagreed about that. It is still the only fixture in the corpus carrying a hash, and it still pins that the two gates read the scalar the same way. Its verdict flipped when ROW-158 closed. The consent row offers `money.transfer` as installable, and the functional spec declares money.transfer#1, which is a different string, so the token is undeclared. The money guard used to skip an undeclared money token, so this passed both gates and rendered Granted. The guard now reads an undeclared money token as an id unless it is shaped like a filename, so both gates refuse this row, and the prefix on the file finally says what the document is.

## 2. What it needs from you

Read access to the notes folder, and a way to reach the subscribers.

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read files in one folder | there is nothing to summarise otherwise | required | the agent has no input | yes |
| Move the subscription fee (`money.transfer`) | the original paid the wire itself | required | you pay it yourself | yes |
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
