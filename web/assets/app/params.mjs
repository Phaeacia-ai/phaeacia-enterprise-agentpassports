/* What a page reads from its own address (pages design section 3, rules 5 and 10).

   The link values. readLanding() reads location.hash once, removes the fragment from the address bar with
   history.replaceState before it returns, and keeps token_hash, type and invite in this module for the page's
   lifetime. shell.startPage() calls it first on every page, before any request, so a fragment never survives into a
   request, a later address or a Referer. The values go only into POST bodies (api.mjs). A reload after the scrub
   finds nothing, which is the design: nothing is stored, so the page falls back to the email form or the incomplete
   link text. The hash is forgotten once an answer has used it; the invitation code once the invitation is accepted.

   The query. company is read as sent and never validated here: the server's 404 decides (rule 10). reason is one of
   the two notices the sign-in page knows, or nothing. */

const link = { tokenHash: null, type: null, invite: null };
let read = false;

const present = (value) => (typeof value === 'string' && value.length > 0 ? value : null);

/** readLanding() -> { tokenHash, type, invite }, each a string or null. Scrubs the fragment on the first call only. */
export function readLanding() {
  if (!read) {
    read = true;
    const fragment = new URLSearchParams(location.hash.slice(1));
    /* A path that begins with two slashes is a scheme-relative URL to replaceState, which the browser refuses as
       another origin (HOSTED-F1: a Site URL ending in a slash made the mailed link `<site>//signin/`). The leading
       slashes collapse to one, and a scrub that fails for any reason still clears the fragment: the page must go on
       and the token must not stay in the address. */
    try {
      history.replaceState(null, '', location.pathname.replace(/^\/{2,}/, '/') + location.search);
    } catch {
      location.hash = '';
    }
    link.tokenHash = present(fragment.get('token_hash'));
    link.type = present(fragment.get('type'));
    link.invite = present(fragment.get('invite'));
  }
  return { tokenHash: link.tokenHash, type: link.type, invite: link.invite };
}

/** The link's token hash has been answered (204 or refused) and is dropped from page memory. */
export function forgetLinkHash() {
  link.tokenHash = null;
  link.type = null;
}

/** The invitation code has been accepted or refused for good and is dropped from page memory. */
export function forgetInvite() {
  link.invite = null;
}

/** The company query value as sent, or null. */
export function companyParam() {
  return present(new URLSearchParams(location.search).get('company'));
}

/** 'expired', 'signed-out' or null. */
export function reasonParam() {
  const reason = new URLSearchParams(location.search).get('reason');
  return reason === 'expired' || reason === 'signed-out' ? reason : null;
}
