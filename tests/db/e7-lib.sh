#!/usr/bin/env bash
# Shared helpers for the E7 probes and for the E7 stack tests (docs/e7/design.md 1.2, 2.7). Source after
# tests/db/lib.sh, ids.env, tests/db/e3-lib.sh (which sources e4-lib.sh) and tests/db/e6-lib.sh. Not a probe:
# scripts/check-db.sh runs only tests/db/[0-9][0-9]-*.sh.
#
# WHY THIS FILE EXISTS. E6 section 9 left one readiness dependency open: the owner-side copy script "run once
# against the seed's oversized company before a customer is onboarded". No oversized company exists in
# tests/db/00-seed.sh, and the only one anywhere was built inline by case 25a of tests/db/30-deletion.sh, where
# the E7 stack tests cannot reach it. E7 moves that BUILDER here, unchanged in what it builds, so probe 30 and
# case E7-12 raise the same fixture from one body of code and cannot drift into two companies that are
# "oversized" in different ways. THE CASE 25a PROBE ITSELF DID NOT MOVE: it is still in 30-deletion.sh, and its
# assertions and their order are what they were.

# ---------------------------------------------------------------------------
# The oversized company of case 25a (E6 design 1.6; E7 design 1.2, case E7-12).
#
# CONTENT ALONE above the export route's gate 1: nine candidates each at 003's own content bound of 262,144
# bytes is 2.36 MB of stored content, and gate 1's estimate doubles that for JSON escaping, which is above the
# 4 MiB ceiling app.limit_export_bytes() sets, while EVERY ROW STAYS INSIDE the content bound. That last part is
# not decoration: 003's bound is a table CHECK and not a trigger, so nothing may exceed it, and a company above
# gate 1 has to be made of enough candidates at the bound rather than one candidate past it (E6DB-F18).
#
# The padding is owner-side, as design section 5 labels it: no route writes a candidate at the bound, and
# pad_candidate (tests/db/e6-lib.sh) rewrites the row inside one owner transaction with the identity and
# immutability guards disabled, keeping the stored hash consistent with the new bytes.
#
# build_oversized_company TAG ADMIN_USER -> prints the company id
#   Needs E6_RUN set (e6_person reads it) and a confirmed synthetic account for the administrator. It sets the
#   caller's FAILED on any fixture assertion, exactly as an inline fixture would.
# ---------------------------------------------------------------------------
build_oversized_company() { # tag admin-user
  local tag="$1" admin="$2" big c i
  big="$(company "e6-30big-$tag" "$admin")"
  future_period "$big"
  e6_person "big_author_$tag" "$big" '{member}'
  local author
  eval "author=\$U_big_author_$tag"
  for i in 1 2 3 4 5 6 7 8 9; do
    c="$(field "$(draft_by_name "$author" "$big" "synthetic-30-big-$i-$tag" 30)" candidate_id)"
    if [ -z "$c" ]; then echo "case 25a fixture: draft $i was refused"; FAILED=1; break; fi
    pad_candidate "$c"
  done
  echo "note: owner-side, as design section 5 labels it, each candidate's content is padded to the content bound" >&2
  printf '%s' "$big"
}

# The two facts the fixture must have, asserted by whoever built it. Kept beside the builder so that a caller
# cannot raise the company and forget to check that it is the company the case is about.
assert_oversized() { # company
  expect "case 25a fixture: gate 1's estimate is above the ceiling" "$(sql -c "select 2 * (app.company_content_bytes('$1') + app.company_assembled_bytes('$1')) > app.limit_export_bytes()")" '^t$'
  expect "case 25a fixture: and every candidate row is inside 003's own content bound" "$(sql -c "select max(octet_length(content)) <= 262144 from app.candidate_versions where company_id = '$1'")" '^t$'
}

# ---------------------------------------------------------------------------
# An operator's claims inside an owner session, which is how the owner-side scripts reach api.delete_company and
# write an audit row as a named operator (design 1.2). It is the same statement tests/db/30-deletion.sh already
# uses to measure the routine owner-side; the disclosure it carries is stated in the design and in the operator
# guide: WHOEVER HOLDS THE OWNER CONNECTION CAN ACT AS ANY REGISTERED OPERATOR and bypass the second factor the
# routine asks for. That is already true of the owner (E2 section 5); the control is the credential's custody.
# ---------------------------------------------------------------------------
operator_claims_sql() { # operator-user
  printf "select set_config('request.jwt.claims', '{\"role\":\"app_server\",\"sub\":\"%s\",\"aal\":\"aal2\"}', true);" "$1"
}

# The audit id of the most recent row of one action for one entity, which is what a script reads back after its
# commit to put in its register line.
last_audit_id() { # action entity-id
  sql -c "select coalesce(max(id), 0) from app.audit_events where action = '$1' and entity_id = '$2'"
}
