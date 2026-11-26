---
passport: 0.1
name: installable-nonascii-token
title: An Honest Non ASCII Filename Backticked In An Installable Row
created: 2026-08-18
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

It reads a folder of notes every morning and turns them into a short digest. The digest goes out to a list of subscribers who asked for it.

Fixture note. The Capability cell of an installable row backticks a German filename with an umlaut in it, and the Installable cell backticks another. Until ROW-167 both were refused: the rule was that an installable row may backtick only printable ASCII, which needs no Unicode table and closes every lookalike, and also refuses this passport for the language it is written in. 804 installable rows across three repositories carried zero such tokens, so nothing that existed was refused and a German-speaking author writing their first passport was. The rule now fires only on a word already shaped like a write id. The companion fixture invalid_envelope_homoglyph.md is the control: it must still refuse.

## 2. What it needs from you

Read access to the notes folder, and a way to reach the subscribers.

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read files in one folder | there is nothing to summarise otherwise | required | the agent has no input | yes |
| Zahlung lesen (`Zahlungsübersicht.csv`) | the digest quotes the figures | required | the digest has no figures | yes (siehe `Bücher.csv`) |
| Post a copy to the team feed | the original also posted it | declared only | it is mailed and not posted | no, declared only |

## 3. Functional spec

```yaml
comparison_mode: structural

capabilities:
  - capability_ref: files.read
    status: used
  - capability_ref: social.post
    status: declared_only
```

## 4. Golden examples

```text
DIGEST, 2026-08-18
Three notes today, two of them about the same contract.
```

## 5. Installer

Run the installer script.

## 6. Losses

None recorded.
