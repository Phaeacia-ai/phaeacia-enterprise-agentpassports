Agent Passport installer text
Copyright 2026 Raffael Hueberli

Licensed under the Creative Commons Attribution 4.0 International License
(CC BY 4.0), the same licence as the format in `../spec/`.

    Human-readable summary:  https://creativecommons.org/licenses/by/4.0/
    Full legal code:         https://creativecommons.org/licenses/by/4.0/legalcode


WHAT THIS COVERS

`core.md`, everything under `branches/`, and any further branch added here.


WHY CC BY AND NOT THE APACHE LICENCE COVERING THE CODE

Three reasons, and the first is that it is already public by design.
`../web/build.sh` copies this directory into the deployed site and
`../web/netlify.toml` serves it as `text/plain`, because a recipient who was
handed a link has to be able to install without an account. Licensing something
as software while serving it as a public document is an odd pair.

Second, this is part of the interoperability contract rather than the
implementation. The branches are what make a passport installable on a given
platform, so a third party writing a competing host needs them for the same
reason they need the vocabulary. That is format, and the format is open on
purpose.

Third, the Apache licence is a software licence and this is prose. Its terms
turn on "Source form" and "Object form", which have no meaning for installation
instructions, and its patent grant has nothing here to act on. CC BY is the
right instrument for a document.


WHAT THIS DOES NOT COVER

- `../spec/` is CC BY 4.0 as well, under its own notice.
- `../tools/`, `../scripts/`, `../verification/` and `../web/` are Apache 2.0.
  See `../LICENSE`.
- `../skills/` and `../capture/` are proprietary, all rights reserved. See the
  notices in those directories.
