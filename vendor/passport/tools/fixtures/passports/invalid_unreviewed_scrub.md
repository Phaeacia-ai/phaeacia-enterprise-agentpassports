---
passport: 0.1
name: unreviewed-scrub-agent
title: Unreviewed Scrub Agent
created: 2026-08-06
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

An agent body that contains scrubbed markers but lacks owner-reviewed.

## 2. What it needs from you

Basic read access.

## 3. Functional spec

The body contains [SCRUBBED:EMAIL] but scrub is only "regex".

## 4. Golden examples

```python
print("test")
```

## 5. Installer

Run install.sh.

## 6. Losses

None.

comparison_mode: structural
