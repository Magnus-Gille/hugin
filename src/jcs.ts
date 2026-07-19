/** RFC 8785 JSON Canonicalization Scheme for already-materialized JSON values. */

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("JCS rejects lone high surrogates");
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("JCS rejects lone low surrogates");
    }
  }
}

/** RFC 8785 sorts property names by their raw UTF-16 code units. */
export function compareUtf16CodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/**
 * Canonicalize an I-JSON-compatible value using RFC 8785.
 *
 * Numbers and string escaping deliberately use ECMAScript JSON serialization,
 * as required by JCS. Optional object properties whose value is `undefined`
 * are treated as absent before canonicalization, matching JSON object
 * materialization; every other non-JSON value fails closed.
 */
export function canonicalizeJcs(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JCS rejects non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const children: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || value[index] === undefined) {
        throw new TypeError("JCS rejects sparse arrays and undefined array values");
      }
      children.push(canonicalizeJcs(value[index]));
    }
    return `[${children.join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JCS accepts only plain JSON objects");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("JCS rejects symbol-keyed properties");
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort(compareUtf16CodeUnits);
    return `{${keys.map((key) => {
      assertUnicodeScalarString(key);
      return `${JSON.stringify(key)}:${canonicalizeJcs(object[key])}`;
    }).join(",")}}`;
  }
  throw new TypeError(`JCS rejects non-JSON value of type ${typeof value}`);
}
