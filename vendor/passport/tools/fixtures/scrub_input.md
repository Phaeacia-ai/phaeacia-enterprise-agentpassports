---
passport: 0.1
name: test-agent-scrub
title: Test Agent for Scrub Validation
created: 2026-08-06
capture_path: file
source_stack: manual
owner_confirmed: true
scrub: regex
envelope: read-notify
---

## 1. What this agent is

A test agent with configuration values for validation purposes.

## 2. What it needs from you

Read access to configuration files.

## 3. Functional spec

Configuration contains the following secrets for testing:

AWS Access Key 1: AKIAIOSFODNN7EXAMPLE
AWS Access Key 2: AKIAI44QH8DHBEXAMPLE

Anthropic key: sk-ant-abc1234567890abcdef-testkey-value
OpenAI key 1: sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCD
OpenAI key 2: sk-svcacc-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345

GitHub token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123
JWT token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c

Contact emails:
- admin@example.com
- test.user+tag@sub.domain.org
- someone_else@another-domain.co.uk

Server IP: 192.168.1.100

API endpoint with key: https://api.example.com/v1?api_key=demo123

Two matches of ONE rule on ONE line, which is the arrangement every other
planted secret in this file avoids and the arrangement that used to leave the
first one in the output while the report claimed both were scrubbed:
Endpoints: https://api.example.com/v1?token=TOKENONEqqqwwweeerrrtttyyy111222 and https://api.example.com/v2?token=TOKENTWOzzzxxxcccvvvbbbnnn333444

Password assignments:
password: SuperSecretPass123!
PASSWD = another-secure-password

High entropy token: aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV

Bare, with no credential-ish label anywhere near it, so that rule 10 is the
only rule that can possibly catch it. Without this line CREDENTIAL_ASSIGN
claims the plant above and the backstop goes silently untested.
Stray value zQ7wE2rT5yU8iO1pA4sD6fG9hJ3kL0zX

Standard-base64 alphabet, which the old character class shattered into
sub-32 fragments so it never even reached the case gate:
uCcqMzIvS0dNREVORy9iUHhSZmlDWUVYQU1QTEVLRVkr

Single case, in an assignment, which is the shape no rule could see before:
NETLIFY_AUTH_TOKEN=a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4

## 4. Golden examples

Here are some near-misses that should NOT be scrubbed:

Git commit hash 1: abcdef1234567890abcdef1234567890abcdef12
Git commit hash 2: 0123456789abcdef0123456789abcdef01234567

UUID 1: 550e8400-e29b-41d4-a716-446655440000
UUID 2: 6ba7b810-9dad-11d1-80b4-00c04fd430c8

Ordinary URLs:
- https://github.com/user/repo/releases/v2.1.0
- https://docs.python.org/3/library/re.html

Semantic version: 1.0.0

Lowercase slug: this-is-a-long-lowercase-slug-value-that-exceeds-thirty-two-chars

The word password appears here in a sentence without any assignment.

ISO datetime: 2026-08-06T14:30:00Z

## 5. Installer

No installation required.

## 6. Losses

None known.

comparison_mode: structural
