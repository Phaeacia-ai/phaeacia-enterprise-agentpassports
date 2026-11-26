---
passport: 0.1
name: nested-fence-agent
title: Nested Fence Agent
created: 2026-08-06
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

An agent whose golden examples quote fenced code, so section 4 needs a fence
longer than the one it contains. Three examples, a sub-heading over each, and a
paragraph between two of them, which is the shape every fence implementation in
this repository has to agree about.

## 2. What it needs from you

| Capability | Why | Required / Optional | If you skip it | Installable in v0.1 |
|---|---|---|---|---|
| Read files in one folder | It has nothing to report on otherwise | required | The agent cannot run | yes |

## 3. Functional spec

This agent reads files and reports what it found.

## 4. Golden examples

### Example one, the plain report

Captured on a weekday, with two of the four folders elided.

```
FOLDER REPORT
- notes.md, changed today
```

### Example two, the report that quotes code

This one is fenced with four backticks because the output itself contains a
three-backtick block. A validator that counts fence markers and halves them
reads four markers here and calls this two examples; a renderer that closes on
the first three-backtick run prints the closing line of the quoted block as the
passport's own prose. Both were real.

````
FOLDER REPORT
- snippet.md, changed today, and it contains:

```python
print("hello")
```
````

That paragraph stands between example two and example three. It qualifies the
one above it and says nothing about the one below, so a renderer that hoists
every paragraph above every block attaches it to the wrong output.

### Example three, the empty run

```
FOLDER REPORT
- nothing changed
```

Templates of shape, not expected content. The installer runs this against a
different folder on a different day.

## 5. Installer

Run the installer script.

## 6. Losses

None.

comparison_mode: structural
