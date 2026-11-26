/* Element builders (pages design section 3, rule 9). The DOM is built, never parsed: every element comes from
   createElement, text from createTextNode or textContent, and attributes from setAttribute over a closed list of
   names that holds no URL, no handler and no style. The two URL attributes the pages need are set by the functions
   that own them: an internal link target by shell.mjs, which checks it against the fixed set, and the QR code image
   here, as a data URI of the SVG text, which a browser loads as an image and never runs. Nothing here assigns
   markup, so a Trusted Types policy of none has nothing to refuse. */

const ATTRIBUTE =
  /^(?:class|id|type|name|value|autocomplete|inputmode|for|role|lang|dir|min|max|step|checked|disabled|hidden|alt|width|height|spellcheck|autocapitalize|enterkeyhint|tabindex|datetime|novalidate|data-[a-z][a-z-]*|aria-[a-z]+)$/;

/** el(tag, attributes, ...children): an element with admitted attributes; a string child becomes a text node, and
    null, undefined and false children are skipped. An attribute value of true is set empty, false or null omits it. */
export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value === null || value === undefined) continue;
    if (!ATTRIBUTE.test(name)) throw new TypeError(`dom.mjs: the attribute ${name} is not admitted`);
    node.setAttribute(name, value === true ? '' : String(value));
  }
  return add(node, children);
}

/** add(node, children): appends children as el does and returns the node. */
export function add(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** fill(node, ...children): replaces a node's children. */
export function fill(node, ...children) {
  node.replaceChildren();
  return add(node, children);
}

/** A name someone wrote, isolated so a right-to-left run cannot reorder what stands beside it (section 1). */
export function isolated(value, attributes = {}) {
  const node = el('bdi', attributes);
  node.textContent = value;
  return node;
}

/** A button that runs one press at a time: it is disabled while the handler's promise is pending. */
export function button(label, onPress, attributes = {}) {
  const node = el('button', { type: 'button', ...attributes }, label);
  node.addEventListener('click', async () => {
    if (node.disabled) return;
    node.disabled = true;
    try {
      await onPress();
    } finally {
      node.disabled = false;
    }
  });
  return node;
}

/** A form whose submission never leaves the page: the submit event runs the handler instead, so the Enter key works
    and a form-action of none has nothing to refuse. It is always novalidate: the browser's own constraint checks on an
    email or number field would stop the submit event before the handler runs, so a malformed address would never
    reach the server that judges it and the page would show nothing (found by journey J7). The server's message is the
    one shown (section 3, rule 7). */
export function form(attributes, onSubmit, ...children) {
  const node = el('form', { ...attributes, novalidate: true }, ...children);
  let pending = false;
  node.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending) return;
    pending = true;
    try {
      await onSubmit();
    } finally {
      pending = false;
    }
  });
  return node;
}

/** A labelled field: { wrap, input }. */
export function field({ label, id, type = 'text', ...attributes }) {
  const input = el('input', { id, name: id, type, ...attributes });
  return { wrap: el('div', { class: 'field' }, el('label', { for: id }, label), input), input };
}

/** The QR code of an enrolment answer, as an image of the SVG text (section 3, rule 9). */
export function qrImage(svg, alt) {
  const node = el('img', { alt, class: 'qr', width: 231, height: 231 });
  node.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return node;
}
