/* The check-in's scheduled adapter (docs/e7/alerts-and-checkin-design.md 1.8 and 2.2). netlify/functions/checkin.mjs
   is its one line of wiring, with `config.schedule` and no path: Netlify runs it daily at 06:00 UTC on the published
   deploy, and "Run now" in its UI runs it by hand; no URL reaches it.

     checkinHandler(deps = {}) -> async (req, context) => undefined

   It reads `context.deploy` (the deploy's id, context and whether it is published) and the clock, hands them to
   lib/services/checkin.mjs's runCheckin with the transport and the two reads a service may not make itself, the
   access switch (lib/http/pipeline.mjs) and the key-set load (lib/session.mjs), and returns nothing, because a
   scheduled function's answer goes nowhere. The request body Netlify sends (`next_run`) is not read.

   runCheckin resolves for every outcome it knows. Anything that still escapes it is a defect: one shaped `internal`
   line and one content-free `escaped` alert, exactly as lib/http/netlify.mjs's catch does for a route, and then
   nothing, so the missing check-in is the operator's signal as well as the alert. deps is the test seam and holds
   what replaces a default: mail, signingKeysReady, accessState, log, now. */

import { runCheckin } from '../services/checkin.mjs';
import { mailTransport } from '../services/mail.mjs';
import { signingKeysReady } from '../session.mjs';
import { alert, shapeFields } from './alerts.mjs';
import { accessState } from './pipeline.mjs';

export function checkinHandler(deps = {}) {
  const mail = deps.mail ?? mailTransport();
  return async (_req, context) => {
    const now = typeof deps.now === 'function' ? deps.now() : Date.now();
    try {
      await runCheckin(
        { now, deploy: context?.deploy },
        {
          mail,
          signingKeysReady: deps.signingKeysReady ?? signingKeysReady,
          accessState: deps.accessState ?? accessState,
          log: deps.log,
        },
      );
    } catch (e) {
      process.stderr.write(
        `${JSON.stringify({ event: 'internal', ...shapeFields({ errorName: e?.name ?? 'Error', code: e?.code }) })}\n`,
      );
      try {
        await alert('escaped', shapeFields({ route: 'checkin', code: e?.code, errorName: e?.name ?? 'Error' }), deps);
      } catch {
        /* an alert is a notification */
      }
    }
  };
}
