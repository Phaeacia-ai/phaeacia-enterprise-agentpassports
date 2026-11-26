---
passport: 0.1
name: bad-capability-agent
title: Bad Capability Agent
created: 2026-08-06
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

An agent with an invalid capability reference.

## 2. What it needs from you

Access to send emails in a non-standard way.

## 3. Functional spec

This agent has a bad capability reference.

capability_ref: email.hack

## 4. Golden examples

```python
print("test")
```

## 5. Installer

Run install.sh.

## 6. Losses

None.

comparison_mode: structural
