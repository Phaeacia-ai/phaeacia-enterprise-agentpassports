---
passport: "0.1"
name: synthetic-record-sorter
title: SYNTHETIC Record Sorter
created: 2026-09-09
capture_path: browser
source_stack: synthetic preparation fixture, no native source execution
owner_confirmed: false
scrub: synthetic-data-only, owner-reviewed by fixture author, no founder review
envelope: read-notify
---

## 1. What this agent is

This synthetic example turns pasted records into a sorted list. It runs when you paste records and ask it to run. It demonstrates packet assembly without representing a founder workflow or a native assistant result.

## 2. What it needs from you

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Reply in this conversation | Show the sorted records | Required | No result is displayed | yes |

## 3. Functional spec

```yaml
confirmed_by_owner: false
goal:
  value: Return pasted records in ascending identifier order without changing labels
  confidence: high
trigger:
  value: on_demand
  confidence: high
inputs:
  - what: records pasted by the recipient in this conversation
    access: nonsense
    tag: records
    criticality: core
    confidence: high
processing:
  sections: one bullet list
  style: literal record transcription, no preamble
  length: one to twenty records
  ordering: ascending identifier order
  confidence: high
output:
  format: Markdown bullets containing identifier followed by colon and label
  delivery: in-chat
  audience: the recipient who supplied the records
  confidence: high
comparison_mode: exact
capabilities:
  - capability_ref: chat.notify
    status: used
personal_slots:
  - id: delivery_target
    question: Should the result be shown only in this conversation?
    why: The recipient chooses their own output destination
    default: this conversation
    required: true
tacit_notes: |
  SYNTHETIC fixture author instruction, not founder testimony: "Preserve labels exactly."
verification:
  - check: Every supplied identifier appears once in ascending order
    evidence: Compare identifiers against the current pasted input
  - check: Each label matches the supplied label exactly and there is no extra prose
    evidence: Compare the current input labels and inspect the bullet list
```

## 4. Golden examples

SYNTHETIC authored expected output, not an observed native run. No elision. This example illustrates shape; use the current input when checking exact output.

Authored 2026-09-09:

```
- A1: amber
- B2: blue
- C3: copper
```


<!-- installer core and branches inserted on upload -->

## 6. Losses

SYNTHETIC preparation only. To be filled during an actual install and always shown.

| What | Status | What that means in practice |
|---|---|---|
| | | |
