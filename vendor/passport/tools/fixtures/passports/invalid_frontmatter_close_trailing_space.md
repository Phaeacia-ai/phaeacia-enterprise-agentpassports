---
passport: 0.1
name: full-agent
title: Full Valid Agent with Scrub
created: 2026-08-06
capture_path: browser
source_stack: manual,web
owner_confirmed: true
scrub: regex+llm, owner-reviewed
envelope: read-notify
--- 

## 1. What this agent is

A full-featured agent for testing all validation rules.

## 2. What it needs from you

Read and write access to files and messages.

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read a web page | It quotes the source it summarised | required | Nothing to summarise | yes |
| Read your mail | It watches one label for new items | required | It never notices new items | yes |
| Read files in one folder | Its own notes and prior output live there | optional | It repeats itself between runs | yes |
| Run on a schedule | It is supposed to arrive before you ask | required | You start it by hand each time | yes |
| Send mail as you | The old version mailed the report out | declared only | It posts in chat instead | no, declared only |

## 3. Functional spec

This agent supports multiple capabilities and handles scrubbed output.

Body contains [SCRUBBED:EMAIL] markers from prior runs.

capability_ref: web.fetch
capability_ref: email.read
capability_ref: files.read
capability_ref: schedule.run
capability_ref: money.transfer

## 4. Golden examples

```python
def fetch(url):
    return requests.get(url)
```

```python
def send_email(to, subject, body):
    smtp.send(to, subject, body)
```

```bash
#!/bin/bash
echo "installing dependencies"
pip install -r requirements.txt
```

## 5. Installer

Run install.sh to set up the agent.

## 6. Losses

None known.

comparison_mode: structural
