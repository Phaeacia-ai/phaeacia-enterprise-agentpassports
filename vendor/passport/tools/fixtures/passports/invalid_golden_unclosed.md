---
passport: 0.1
name: unclosed-fence-agent
title: Unclosed Fence Agent
created: 2026-08-06
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

An agent whose section 4 opens a fenced block and never closes it, which is the
branch validate.py check 8 grew when it stopped counting markers and started
tracking fence length. Nothing exercised that branch until this file.

## 2. What it needs from you

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read files in one folder | It has nothing to report on otherwise | required | The agent cannot run | yes |

## 3. Functional spec

This agent reads files and reports.

## 4. Golden examples

```
FOLDER REPORT
- notes.md, changed today

## 5. Installer

Run the installer script.

## 6. Losses

None.

comparison_mode: structural
