---
passport: 0.1
name: unfilled-template-agent
title: Unfilled Template Agent
created: 2026-08-06
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

A capture that was handed over with the template's own instructions still in it.
Both implementations refuse it, and both also have to agree that the instruction
is not a paragraph of the owner's prose: a page that printed it would show the
recipient a sentence addressed to the person who filled the template in.

## 2. What it needs from you

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read files in one folder | It has nothing to report on otherwise | required | The agent cannot run | yes |

## 3. Functional spec

This agent reads files and reports.

## 4. Golden examples

<One to three blocks in this section, each a real output from this agent>

## 5. Installer

Run the installer script.

## 6. Losses

None.

comparison_mode: structural
