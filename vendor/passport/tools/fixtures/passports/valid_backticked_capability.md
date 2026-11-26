---
passport: 0.1
name: backticked-capability-agent
title: Backticked Capability Agent
created: 2026-08-06
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

An agent whose consent table writes the vocabulary id in the capability cell.

## 2. What it needs from you

The capability cell carries a backticked vocabulary id beside the plain-language
name. This fixture exists because `ref` is the only optional key a needs row
carries, and no other fixture sets it: the parity harness compared an allowlist
of keys taken from row zero, so the one field that could differ between the two
derivations was the one field never compared. It also pins the backtick
question, which the two implementations answered differently on the same input.

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read files in one folder | It has nothing to report on otherwise | required | The agent cannot run | yes |
| Fetch a page `web.fetch` | It quotes the page it was pointed at | optional | It reports the local files alone | yes |

## 3. Functional spec

This agent reads files and reports.

## 4. Golden examples

```
FOLDER REPORT
- notes.md, changed today
```

## 5. Installer

Run the installer script.

## 6. Losses

None.

comparison_mode: structural
