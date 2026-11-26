---
passport: 0.1
name: wrong-order-agent
title: Wrong Order Agent
created: 2026-08-06
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

An agent with headings in the wrong order.

## 2. What it needs from you

Basic read access.

## 3. Functional spec

This agent has sections 5 and 4 swapped.

## 5. Installer

Run install.sh.

## 4. Golden examples

```python
print("test")
```

## 6. Losses

None.

comparison_mode: structural
