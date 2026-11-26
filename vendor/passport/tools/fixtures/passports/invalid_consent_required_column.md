---
passport: 0.1
name: minimal-agent
title: Minimal Valid Agent
created: 2026-08-06
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

A minimal agent for testing.

## 2. What it needs from you

Basic read access.

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read files in one folder | It has nothing to report on otherwise | maybe | The agent cannot run | yes |

## 3. Functional spec

This agent reads files and reports.

## 4. Golden examples

```python
print("hello")
```

## 5. Installer

Run the installer script.

## 6. Losses

None.

comparison_mode: structural
