---
passport: "0.1"
name: daily-brief
title: Daily Brief
created: 2026-08-06
capture_path: file
source_stack: python scripts on macOS, local scheduler, a small local model for summarising
owner_confirmed: true
scrub: "regex+llm, owner-reviewed"
envelope: read-notify
---

## 1. What this agent is

It reads a fixed set of news sources every weekday morning and writes a short briefing: the handful of stories worth knowing, then the day's calendar, then the weather. It runs before its owner wakes up, so the briefing is waiting rather than requested. It is meant to replace ten minutes of scrolling, not to be comprehensive.

## 2. What it needs from you

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Fetch news from the web | this is the briefing content | Required | there is no briefing | yes |
| Read your calendar | adds today's schedule to the brief | Optional | the brief has no calendar section | yes |
| Run on a schedule | it arrives before you ask for it | Optional | you start it yourself each morning | yes |
| Remember your preferences | keeps your topics and tone between runs | Optional | you restate your topics each run | yes |
| Deliver the brief to you | it has to reach you somehow | Required | it writes a brief nobody sees | yes |
| Send it on to somebody else | the original forwarded a trimmed copy to a colleague | declared only | it goes to you and to nobody else | no, declared only |

Delivery is a channel you pick: chat, your own mailbox, a notification, or a file you keep. It goes to that one place and nowhere else. The original also forwarded a copy to a colleague; this install will not, and will not try.

The fetch step in the original, pasted from the owner's notes so the shape is
visible without naming the sources:

```
curl -s "$FEED_URL" \
 | jq -r '.items[] | .title' \
 | head -20
```

## 3. Functional spec

```yaml
confirmed_by_owner: true

goal:
  value: deliver a short morning briefing that replaces scrolling the news
  confidence: high

trigger:
  value: scheduled(weekdays, time from the delivery_time slot, may run up to 60 minutes late)
  confidence: high

inputs:
  - what: a fixed list of general and regional news sources
    capability_ref: web.fetch
    access: open
    tag: general-news
    criticality: core
    confidence: high
  - what: two specialist sources on the owner's professional beat
    capability_ref: web.fetch
    access: open
    tag: beat-specialist
    criticality: core
    confidence: high
  - what: one source of record on the beat that the open sources do not carry
    capability_ref: web.fetch
    access: credentialed
    binding: beat_source_of_record
    tag: market-wire
    criticality: optional
    confidence: medium
  - what: whatever holds the reader's commitments for the day
    capability_ref: calendar.read
    access: credentialed
    binding: calendar_source
    tag: own-calendar
    criticality: optional
    confidence: high
  - what: current conditions and the day's forecast for one city
    capability_ref: web.fetch
    access: open
    tag: weather
    criticality: optional
    confidence: high

processing:
  sections: top stories, then your day, then weather, in that order every time
  style: second person, declarative, no hedging, no headlines restated as questions
  length: 3 to 6 stories at 2 lines each, calendar as a bare list, weather as one line
  ordering: stories ranked by consequence to the reader, not by recency or source
  confidence: medium

output:
  format: plain text with three fixed uppercase section headings
  delivery: the one channel the installer names, reaching them and nobody else
  audience: one person, reading on a phone before getting up
  confidence: high

comparison_mode: structural

capabilities:
  - capability_ref: web.fetch
    status: used
  - capability_ref: calendar.read
    status: used
  - capability_ref: schedule.run
    status: used
  - capability_ref: chat.notify
    status: used
  - capability_ref: memory.prefs
    status: used
  - capability_ref: email.send
    status: declared_only

personal_slots:
  - id: topics
    question: "Which subjects should the brief cover? Name three to six."
    why: "the original tracked its owner's professional beat, which is not yours"
    default: none
    required: true
  - id: city
    question: "Which city's weather do you want?"
    why: "the original used its owner's home city"
    default: none
    required: false
  - id: delivery_time
    question: "What time should it arrive on weekdays?"
    why: "the original ran before its owner's working day started"
    default: "07:00"
    required: false
  - id: story_count
    question: "How many stories do you want: fewer and longer, or more and shorter?"
    why: "a taste setting, tuned by its owner over months"
    default: "4 stories, 2 lines each"
    required: false
  - id: register
    question: "Should it address you directly, or read like a wire report?"
    why: "the original's register was its owner's preference, not a property of the agent"
    default: none
    required: false
  - id: beat_source_of_record
    question: "Is there one source on your subjects that the free ones do not carry, and can you already read it from here?"
    why: "the original paid for one; you may have a different one, or none, and the brief is worth having either way"
    default: none
    required: false
  - id: calendar_source
    question: "Where does your day live, and is it connected to this assistant already?"
    why: "the original read its owner's own calendar, which is not yours"
    default: none
    required: false
  - id: delivery_target
    question: "Where should it arrive: here in chat, your own mailbox, a notification, or a file you keep?"
    why: "the original mailed it to its owner's own address, and that address is theirs"
    default: "here in chat"
    required: true

tacit_notes: |
  Owner, verbatim at the confirm step: "The ranking rule is the whole thing and it
  is not written down anywhere. It is not the biggest story, it is the story that
  changes what I do today. Half the time that means a small item about a company
  nobody has heard of. If it just gives you the front page, it has failed."

  Also owner: "It skips weekends because I do not want it on weekends, not because
  weekend news is different. Do not be clever about that."

  Note from capture: the sender line and the recipient address in the delivery
  script were [SCRUBBED:EMAIL]. The delivery target is a slot, so that address was
  never going to travel: whoever installs this names their own, and the brief goes
  there and nowhere else.

verification:
  - check: "each requested topic has at least one item, and the brief has 3 to 6 items total"
    evidence: "count items under the top stories heading and map them to the topics the installer named"
  - check: "every item is dated within 24 hours of the installer's run time"
    evidence: "compare item timestamps to when the run happened, not to the golden example's date"
  - check: "the three sections appear in the order top stories, your day, weather"
    evidence: "read the headings in the output"
  - check: "no item is a bare headline, each has a second line saying why it matters"
    evidence: "check that every item is two lines, not one"
```

## 4. Golden examples

This is a synthetic example, written to exercise the format rather than captured from a real run, and it is labelled as such so nobody mistakes it for evidence about a real agent. In a real passport this section holds one to three actual outputs.

Items four through seven were removed and the shape was preserved. These are templates of shape, not expected content: the installer runs this on a different day, from different sources, and different stories are the correct result.

Captured 2026-08-09:

```
MORNING BRIEF, Saturday 9 August

TOP STORIES
- Regulator opens consultation on cross-border data rules.
  Comment window closes in six weeks, which is the part that affects your work.
- Second-round funding for a competitor in the forecasting space.
  Same buyer profile as yours; the pricing page is the thing to read.
- Rail strike confirmed for Tuesday and Wednesday.
  Your Tuesday meeting is in another city.

YOUR DAY
- 09:00 Standup
- 14:30 Call, [SCRUBBED:NAME]
- 18:00 Blocked, no title

WEATHER
- 21C, clear, light wind. Rain after 19:00.
```

## 5. Installer

<!-- installer core and branches inserted on upload -->

## 6. Losses

To be filled in during install, and shown even when every row says delivered.

| What | Status | What that means in practice |
|---|---|---|
| | | |
