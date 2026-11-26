#!/usr/bin/env bash
# Seed synthetic identities for the E2 probes. Two companies (alpha, beta), operator,
# two admins in alpha, one member in alpha, one removed member in alpha, one member in beta,
# one outsider with an account but no membership. All emails are synthetic.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
OUT="$ROOT/.scratch/e2"; mkdir -p "$OUT"
section "seed: reset database to migration state"
# Reset failure is fatal (L2): every later probe depends on the initial state.
(cd "$ROOT" && supabase db reset > "$OUT/reset.log" 2>&1) || { echo "db reset FAILED; see $OUT/reset.log"; tail -20 "$OUT/reset.log"; exit 1; }
echo "db reset ok"; wait_rest || exit 1
# Local CLI lesson: [api] schemas, auth settings and hooks are read at `supabase start`; a db
# reset restarts the database only. Configuration changes need a stack restart, which the
# probes cannot verify from here; 04h and 06 exercise the running configuration directly.
PW='Synthetic-Pass-1234'
# bash 3.2 (macOS) has no associative arrays: one variable per identity.
U_op="$(create_user synthetic-op@example.invalid "$PW")"
U_alpha_admin1="$(create_user synthetic-alpha-admin1@example.invalid "$PW")"
U_alpha_admin2="$(create_user synthetic-alpha-admin2@example.invalid "$PW")"
U_alpha_member="$(create_user synthetic-alpha-member@example.invalid "$PW")"
U_alpha_removed="$(create_user synthetic-alpha-removed@example.invalid "$PW")"
U_beta_member="$(create_user synthetic-beta-member@example.invalid "$PW")"
U_outsider="$(create_user synthetic-outsider@example.invalid "$PW")"
echo "users: op=$U_op alpha-admin1=$U_alpha_admin1 alpha-admin2=$U_alpha_admin2 alpha-member=$U_alpha_member alpha-removed=$U_alpha_removed beta-member=$U_beta_member outsider=$U_outsider"
sql -c "insert into app.operators (user_id) values ('$U_op');"
sql -c "insert into app.operator_allowlist (email_normalized) values ('synthetic-op@example.invalid');"
OPJWT="$(server_jwt "$U_op" aal2)"
section "seed: provision companies through api.provision_company as operator (app_server token, aal2)"
r="$(rest POST /rpc/provision_company "$OPJWT" "{\"p_slug\":\"synthetic-alpha\",\"p_name\":\"SYNTHETIC Alpha AG\",\"p_first_admin_user\":\"$U_alpha_admin1\"}")"; echo "$r"
ALPHA="$(printf '%s' "$r" | sed -n 's/.*"company_id":"\([^"]*\)".*/\1/p')"
r="$(rest POST /rpc/provision_company "$OPJWT" "{\"p_slug\":\"synthetic-beta\",\"p_name\":\"SYNTHETIC Beta GmbH\",\"p_first_admin_user\":\"$U_beta_member\"}")"; echo "$r"
BETA="$(printf '%s' "$r" | sed -n 's/.*"company_id":"\([^"]*\)".*/\1/p')"
# Remaining alpha memberships are inserted directly by the migration owner for fixture speed;
# the invitation path is proven separately in 04-invitations.sh.
sql -c "insert into app.memberships (company_id, user_id, roles) values
  ('$ALPHA','$U_alpha_admin2','{company_admin,member}'),
  ('$ALPHA','$U_alpha_member','{member}'),
  ('$ALPHA','$U_alpha_removed','{member}');
  update app.memberships set status='removed', removed_at=now() where user_id='$U_alpha_removed';"
{
  echo "ALPHA=$ALPHA"; echo "BETA=$BETA"; echo "PW=$PW"
  for v in U_op U_alpha_admin1 U_alpha_admin2 U_alpha_member U_alpha_removed U_beta_member U_outsider; do eval "echo $v=\$$v"; done
} > "$OUT/ids.env"
sql -c "select c.slug, m.user_id, m.status, m.roles from app.memberships m join app.companies c on c.id=m.company_id order by 1,3,4"
echo "seed written to $OUT/ids.env"
