/* D15's pure half (E7 design 1.4 D15, 1.3 restore step 6, E7D-C-F4), written here by the day 5 restore lane
   because `scripts/check-deploy.mjs` DOES NOT EXIST YET: the deploy check is day 6's, and case E7-31 needs D15's
   key-set predicate today to assert that a key set still listing the retired key id fails.

   FOR DAY 6 TO WIRE. `keySetFindings` is pure: facts in, findings out, no IO, no clock, no environment. Day 6
   moves this function into `scripts/check-deploy.mjs` beside the other D-rules and points this file's importer at
   it, or imports it from there; it is not a second copy to be kept in step. Its three conditions are D15's three,
   in D15's own order.

   NO VALUE IS ECHOED. A finding names the rule and the variable and nothing read: E7-18's requirement is that no
   value from the fixture appears anywhere in the output, and a key id read out of a hosted environment file is a
   value even though the published set is public. A retired key id that is still listed is named by its INDEX in
   the list the runbook passed, which is enough for an operator to find it and carries nothing. */

/** The design's word for the one algorithm a hosted file may name (1.3: the legacy secret cannot be rotated). */
export const REQUIRED_HOSTED_ALG = 'ES256';

/**
 * D15: the signing path, and the key that is on it.
 *
 * facts:
 *   alg            ENTERPRISE_SERVER_SIGNING_ALG, as the file has it (undefined when absent)
 *   kid            ENTERPRISE_SERVER_SIGNING_KID, as the file has it (undefined when absent)
 *   publishedKids  the `kid`s of <supabase>/auth/v1/.well-known/jwks.json, read from the target
 *   retiredKids    the `kidBefore` of each `key.replace` register line, which the restore runbook passes
 *   hosted         true for a hosted environment file; false for the local one, where HS256 is the path
 *
 * Returns an array of `{ rule, variable }`, empty when the facts pass. Order is D15's.
 */
export function keySetFindings({ alg, kid, publishedKids, retiredKids = [], hosted = true } = {}) {
  const findings = [];
  const published = Array.isArray(publishedKids) ? publishedKids : [];

  /* 1. The path. ES256 is the path on which a key can be replaced at all; it is NOT the replacement. */
  if (hosted && alg !== REQUIRED_HOSTED_ALG)
    findings.push({ rule: `a hosted file signs with ${REQUIRED_HOSTED_ALG} and nothing else`, variable: 'ENTERPRISE_SERVER_SIGNING_ALG' });

  /* 2. The key that is on it is one the target actually publishes. */
  if (hosted) {
    if (typeof kid !== 'string' || kid.length === 0)
      findings.push({ rule: 'a hosted file names the server key id', variable: 'ENTERPRISE_SERVER_SIGNING_KID' });
    else if (!published.includes(kid))
      findings.push({
        rule: 'the server key id is in the target’s published key set',
        variable: 'ENTERPRISE_SERVER_SIGNING_KID',
      });
  }

  /* 3. And no key the recovery retired is still in that set. This is the condition that OBSERVES the replacement:
        a re-import of the source's key leaves its id listed, which is E7D-C-F4's counterexample. */
  retiredKids.forEach((retired, index) => {
    if (published.includes(retired))
      findings.push({ rule: 'a retired key id is absent from the published key set', variable: `--retired-kid[${index}]` });
  });

  return findings;
}
