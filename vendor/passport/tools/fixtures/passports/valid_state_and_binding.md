---
passport: 0.1
name: bound-agent
title: Agent With Bindings And State
created: 2026-08-06
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

A fixture for the two checks that arrived with bindings and state. It carries the
compliant form of both, so a change that makes either check fire on a correct
passport is caught here rather than on somebody's real capture.

## 2. What it needs from you

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read one number you already track | It has nothing to report on otherwise | required | The agent cannot run | yes |
| Remember last time's number | The line shows the change, not just the level | optional | Every line reads as a bare number | yes |

## 3. Functional spec

```yaml
confirmed_by_owner: true

goal:
  value: report one number and how it moved
  confidence: high

inputs:
  - what: a headline number the reader already watches
    capability_ref: web.fetch
    access: credentialed
    binding: headline_number
    tag: headline
    criticality: core
    confidence: high
  - what: an open source for context on that number
    capability_ref: web.fetch
    access: open
    tag: context
    criticality: optional
    confidence: high

output:
  format: one line per number
  delivery: the one channel the installer names
  audience: one person
  confidence: high

comparison_mode: structural

capabilities:
  - capability_ref: web.fetch
    status: used
  - capability_ref: chat.notify
    status: used

personal_slots:
  - id: headline_number
    question: "Which number do you actually watch, and where does it live?"
    why: "the original watched one company's own figure, which is not yours"
    default: none
    required: true

state:
  keeps: the last value of each number, so the next run can show the change
  granularity: per day
  why: without it every line renders with no movement and the point is gone
  confidence: high

verification:
  - check: "each number shows its change vs prev"
    evidence: "read the second half of each line"
  - check: "the first run says plainly that there is nothing to compare against yet"
    evidence: "read the output of the first run"
```

## 4. Golden examples

Synthetic, written to exercise the format.

```
HEADLINE
- 412 (+18 vs prev)
```

## 5. Installer

Inserted on upload.

## 6. Losses

To be filled in during install.

| What | Status | What that means in practice |
|---|---|---|
| | | |
