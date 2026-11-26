# Passport fixtures

The files the test suites and `capture/enterprise.md` still depend on. The directory name is historical: it once
also held the protocol for founder-run transfer experiments between assistants, which were never run and are not
part of this repository.

| File | Used by |
|---|---|
| `fixtures/SYNTHETIC-passport.md` | the synthetic passport most suites upload, assemble and render (`tests/passport/`, `tests/e3/` to `tests/e5/`, `tests/db/`, `scripts/check-python.mjs`) |
| `fixtures/SYNTHETIC-source.txt` | the synthetic agent configuration the passport above describes; read by nothing, kept so the fixture can be understood |
| `private-capture-prompt.txt` | the base text `capture/enterprise.md` was derived from; `tests/e3/unit/capture.test.mjs` asserts the derivation changed nothing but the listed edits |
| `local_policy.py` | `PUBLIC_ROUTES`, which `tests/e3/unit/rules.test.mjs` compares with `lib/passport/rules.mjs` entry for entry |
Everything here is synthetic. Nothing in this directory describes a real agent, person or company.
