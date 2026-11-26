/* Canonical JSON for the derived record (attestation contract 3.4; E3 design 3.1 step 7).

   Object keys sorted by UTF-16 code unit order at every depth; no insignificant whitespace; strings
   escaped as JSON.stringify escapes them; numbers as JSON.stringify prints them; arrays in their given
   order. The caller hashes the UTF-8 bytes of the returned string.

   Refused, never coerced: -0, NaN and the two infinities; undefined anywhere, as an object member or as an
   array element (including a hole); a cycle; and every value that is not null, a boolean, a finite number,
   a string, an array or a plain object. JSON.stringify would drop, rewrite or throw on each of these in a
   different way, and a canonical form that silently changes its input is not canonical.

   This is the subset of RFC 8785 (JSON Canonicalization Scheme) that the derived record needs, and it
   claims no more: RFC 8785 also defines inputs this module refuses.

   Why this is not JSON.stringify of the record: derive() emits keys in the order it builds them, and two
   objects equal as JSON are not equal as bytes (E3 design probe 2).

   Self-contained on purpose. It depends on no other module, so the canonical form cannot change without
   this file's bytes, and with them the gate identity, changing too. */

export class CanonicalError extends TypeError {
  constructor(path, what) {
    super(`canonical: ${path} ${what}`);
    this.name = 'CanonicalError';
  }
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function write(value, path, ancestors) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalError(path, 'is not a finite number');
      if (Object.is(value, -0)) throw new CanonicalError(path, 'is negative zero');
      return JSON.stringify(value);
    case 'undefined':
      throw new CanonicalError(path, 'is undefined');
    case 'object':
      break;
    default:
      throw new CanonicalError(path, `is a ${typeof value}`);
  }
  if (ancestors.has(value)) throw new CanonicalError(path, 'is a cycle');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = [];
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(value, i)) throw new CanonicalError(`${path}[${i}]`, 'is a hole');
        items.push(write(value[i], `${path}[${i}]`, ancestors));
      }
      return `[${items.join(',')}]`;
    }
    if (!isPlainObject(value)) throw new CanonicalError(path, 'is not a plain object');
    if (Object.getOwnPropertySymbols(value).length > 0) throw new CanonicalError(path, 'has a symbol key');
    /* Array.prototype.sort without a comparator orders strings by UTF-16 code units, which is the rule. */
    const keys = Object.keys(value).sort();
    const members = keys.map((key) => `${JSON.stringify(key)}:${write(value[key], `${path}.${key}`, ancestors)}`);
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** The canonical JSON text of a value. Throws CanonicalError for anything the rules above refuse. */
export function canonical(value) {
  return write(value, '$', new Set());
}
