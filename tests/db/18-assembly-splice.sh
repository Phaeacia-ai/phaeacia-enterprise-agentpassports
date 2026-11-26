#!/usr/bin/env bash
# E3 probe 18: case 16, the SQL splice (attestation contract 8.1; docs/e3/design.md section 6). An E4 prerequisite run
# in E3 because the placeholder constant is written in both places: the SYNTHETIC fixture is stored as a candidate row,
# each branch's installer text is spliced into the STORED content with PostgreSQL replace(), and the four results must
# equal the golden assembled hashes of docs/e1/passport-adapter.md section 6, and lib/passport/assemble.mjs must agree.
# E4's registered app.installer_texts does not exist yet: the installer text here is what assemble.mjs installerText()
# produces at the pin, passed as a literal, which is the value that table will hold. Run after tests/db/00-seed.sh.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; source "$ROOT/.scratch/e2/ids.env"; source "$ROOT/tests/db/e3-lib.sh"
RUN="$(run_id)"; T="$E2_TMP/18"; mkdir -p "$T"; PW18='Synthetic-Pass-1234'

section "18 setup: a company, a member, an agent, and the SYNTHETIC fixture stored byte for byte as a candidate"
U_M="$(create_user "e3-18-$RUN-member@example.invalid" "$PW18")"; G="$(company "e3-18-$RUN" "$U_M")"; M_MS="$(membership_of "$G" "$U_M")"
AGENT="$(first "$(sql -c "insert into app.agents (company_id, name, creator_membership_id, owner_membership_id) values ('$G','splice-$RUN','$M_MS','$M_MS') returning id")")"
GATE_ID="$(sql -c "select id from app.gate_identities where active")"
node --input-type=module -e "
  import { writeFileSync } from 'node:fs';
  import { createHash } from 'node:crypto';
  const ROOT = '$ROOT';
  const { assemble, installerText, readText, PLACEHOLDER, BRANCHES } = await import(ROOT + '/lib/passport/assemble.mjs');
  const { gate } = await import(ROOT + '/lib/passport/gate.mjs');
  const fixture = readText(ROOT + '/tests/native-transfer/passport/fixtures/SYNTHETIC-passport.md');
  const g = gate(Buffer.from(fixture, 'utf8'), 'text/markdown', { validatedAt: new Date().toISOString() });
  if (!g.ok || g.text !== fixture) throw new Error('the fixture does not pass the gate unchanged');
  const tag = (name, text) => { const t = '\$' + name + '\$'; if (text.includes(t)) throw new Error('tag in text'); return t + text + t; };
  const sha = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
  const sql = [];
  sql.push(\"insert into app.candidate_versions (company_id, agent_id, sequence, author_membership_id, content, derived_canonical, gate_id, attested_by) values ('$G', '$AGENT', 1, '$M_MS', \" + tag('e3content', g.text) + ', ' + tag('e3derived', g.derivedCanonical) + \", '$GATE_ID', '$M_MS') returning 'ROW|' || id || '|' || encode(content_sha256, 'hex');\");
  for (const branch of BRANCHES) {
    const installer = installerText(ROOT + '/vendor/passport', branch === 'claude-code' || branch === 'claude-ai' || branch === 'chatgpt' || branch === 'generic' ? branch + '.md' : null);
    const node = assemble(fixture, { root: ROOT + '/vendor/passport', branch });
    console.log('NODE|' + branch + '|' + Buffer.byteLength(node, 'utf8') + '|' + sha(node) + '|installer ' + sha(installer));
    sql.push(\"select 'SPLICE|\" + branch + \"|' || octet_length(convert_to(s, 'UTF8')) || '|' || encode(sha256(convert_to(s, 'UTF8')), 'hex') from (select replace(v.content, '\" + PLACEHOLDER + \"', \" + tag('e3installer', installer) + \") s from app.candidate_versions v where v.agent_id = '$AGENT' and v.sequence = 1) x;\");
  }
  const wrong = installerText(ROOT + '/vendor/passport', 'chatgpt.md');
  sql.push(\"select 'CROSSED|' || encode(sha256(convert_to(replace(v.content, '\" + PLACEHOLDER + \"', \" + tag('e3installer', wrong) + \"), 'UTF8')), 'hex') from app.candidate_versions v where v.agent_id = '$AGENT' and v.sequence = 1;\");
  writeFileSync('$T/splice.sql', sql.join('\n') + '\n');
" > "$T/node.txt"
out="$(sql < "$T/splice.sql")"
expect "the fixture is stored, its content_sha256 the trigger's" "$out" '^ROW|[0-9a-f-]\{36\}|[0-9a-f]\{64\}$'

section "18a case 16: the SQL splice over the stored bytes reproduces the four golden assembled hashes, and assemble.mjs agrees"
GOLDEN="chatgpt|70752|11070a1ffbdc39030b661cddc332b8b5594bb78d6ab3c137000739609743ad7a
claude-ai|64621|8e686b27e554e35af47af16a20cc24b48ae40323b4f5bcf37d64192f8b30e761
claude-code|73409|5cdaf5c50d37c355c086f9f05aec2b810de10f109d0d1464682d4f13c85a3dff
generic|54957|d558746392a835f3da4c4a779616761a8e0dba9157962d7da22d772e5d28546d"
# A here-string, not a pipe: a piped loop runs in a subshell, and a FAILED=1 set there would never fail the probe.
while IFS='|' read -r branch bytes hash; do
  expect "SQL splice, $branch: $bytes bytes, the golden hash" "$(printf '%s\n' "$out" | grep "^SPLICE|$branch|")" "^SPLICE|$branch|$bytes|$hash\$"
  expect "assemble.mjs, $branch: the same bytes and hash" "$(grep "^NODE|$branch|" "$T/node.txt")" "^NODE|$branch|$bytes|$hash|"
done <<< "$GOLDEN"
expect "control: chatgpt's installer text spliced in is not claude-ai's golden (the comparison can fail)" "$(printf '%s\n' "$out" | grep '^CROSSED|' | grep -c '8e686b27e554e35af47af16a20cc24b48ae40323b4f5bcf37d64192f8b30e761')" '^0$'
expect "and it is chatgpt's own golden" "$out" 'CROSSED|11070a1ffbdc39030b661cddc332b8b5594bb78d6ab3c137000739609743ad7a'
echo "limit: the installer text is assemble.mjs installerText() at the pin passed as a literal; E4 registers it in app.installer_texts, and the splice inside api.publish_release is E4's"

[ "$FAILED" = 0 ] && echo "18 PASS" || { echo "18 FAIL"; exit 1; }
