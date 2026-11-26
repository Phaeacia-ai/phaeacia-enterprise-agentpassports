/* The one control of this product that is not a navigation (pages design section 3's new rule, E5 design 4.3), in a
   module of its own since E6 (design 4.3 and E6D-C-F16): the release page saves an installation block with it, and the
   home and members pages save a company's own copy of its records with it. A page module runs when it is loaded, so
   no page can reach a function inside another page, and the control therefore lives here and nowhere else.
   scripts/check-web.mjs names this file as the one owner of an .href assignment besides dom.mjs and shell.mjs, one
   assignment, so a second copy of the control anywhere under web/ fails the gate.

   The rule it keeps: an object URL is made only for the bytes of the answer the page is handling, it is revoked in the
   same task, and it is never assigned to location. A journey asserts that no blob URL ever becomes a document. */

import { el } from './dom.mjs';

/** A file name part from a value the service supplied: anything outside a small class becomes a hyphen, so a value the
    page did not choose cannot shape the name a browser writes. */
export const nameSafe = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 40);

/** saveBytes(name, text, type): the bytes of the answer being handled, written by the browser as one file. */
export function saveBytes(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = el('a', { 'data-role': 'save-anchor' });
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
