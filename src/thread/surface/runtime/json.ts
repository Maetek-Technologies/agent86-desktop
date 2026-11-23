// Small helpers for JSON values. Objects come from `JSON.parse`, so a key such as `__proto__` or
// `constructor` is an own property; these read and write own properties only, so such a key is
// plain data, never the object's prototype.

import type { Json, JsonObject } from "./types.ts";

export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An own property, or `undefined` (an inherited `toString` is not a property). */
export function own(object: JsonObject, key: string): Json | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/** The own property as a string, if it is one. */
export function ownString(object: JsonObject, key: string): string | undefined {
  const value = own(object, key);
  return typeof value === "string" ? value : undefined;
}

/** Set an own property; `__proto__` becomes a property, not the prototype. */
export function put(object: JsonObject, key: string, value: Json): void {
  if (key === "__proto__") {
    Object.defineProperty(object, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    object[key] = value;
  }
}

/** Remove an own property. */
export function remove(object: JsonObject, key: string): void {
  if (Object.hasOwn(object, key)) delete object[key];
}

/** A deep copy, so the model never shares structure with what a caller still holds. */
export function clone<T extends Json>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [key, inner] of Object.entries(value)) put(out, key, clone(inner));
    return out as T;
  }
  return value;
}

/** Structural equality (object key order does not matter). */
export function equal(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => equal(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
    );
  }
  return false;
}
