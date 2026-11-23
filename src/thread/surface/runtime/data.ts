// A surface's data model: a JSON value addressed by JSON Pointers (RFC 6901), with the rules every
// A2UI SDK shares (the specification's conformance suite, `core/data_model.yaml`):
//
// - Empty segments collapse, so `//a///b//`, `/a/b/`, and `/a/b` are one path; `""` and `/` are
//   the root. `~1` unescapes to `/` before `~0` to `~`.
// - `null` reads as absent, and writing through it creates the containers.
// - A write creates missing containers: an array when the next segment is an index, else an
//   object. Array indices are canonical (no leading zeros), at most MAX_ARRAY_INDEX; writing past
//   the end pads with `null`.
// - Writing through a string, number, or boolean is an error, as is a non-numeric segment on an
//   array.
// - `__proto__`, `constructor`, and `prototype` are refused as segments in every SDK, so models
//   move between them unchanged.
// - A watcher is notified when the value at its own path changed: a write to an ancestor, the
//   path, or a descendant that left it the same notifies no one.

import { clone, equal, isObject, own, put, remove } from "./json.ts";
import type { Json, JsonObject } from "./types.ts";

/** The largest array index a write may use. */
export const MAX_ARRAY_INDEX = 10_000;

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/** A data model operation the model or the user cannot do. */
export class DataError extends Error {
  /** The path as given. */
  readonly path: string;
  constructor(path: string, message: string) {
    super(message);
    this.name = "DataError";
    this.path = path;
  }
}

/** The segments of a JSON Pointer, unescaped, with empty segments dropped. Refuses the forbidden
 * segments. */
export function segments(path: string): string[] {
  const out: string[] = [];
  for (const raw of path.split("/")) {
    if (raw === "") continue;
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (FORBIDDEN.has(segment)) {
      throw new DataError(path, `Forbidden path segment '${segment}' in path '${path}'.`);
    }
    out.push(segment);
  }
  return out;
}

/** The JSON Pointer for segments (`/` for none). */
export function pointer(parts: string[]): string {
  if (parts.length === 0) return "/";
  return parts.map((s) => `/${s.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

/** A path in its normal form: segments collapsed and re-escaped, `/` for the root. */
export function normalize(path: string): string {
  return pointer(segments(path));
}

/** Resolve `path` against a context path: an absolute path (starting with `/`) stands alone; a
 * relative one, inside a template, extends the context; `""` and `.` are the context itself. */
export function resolve(context: string, path: string): string {
  if (path.startsWith("/")) return path;
  const base = context.replace(/\/+$/, "");
  if (path === "" || path === ".") return base === "" ? "/" : base;
  return `${base}/${path}`;
}

const USIZE_MAX = "18446744073709551615";

/** A canonical array index: decimal digits, no leading zero unless `0`. Like Rust's `usize`
 * parse, a number past 2^64 - 1 is not an index at all. */
function index(segment: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(segment)) return null;
  if (segment.length > USIZE_MAX.length) return null;
  if (segment.length === USIZE_MAX.length && segment > USIZE_MAX) return null;
  return Number(segment);
}

/** An id for one watch, so the same path can be watched twice. */
export type WatchId = number;

/** A surface's data model. */
export class DataModel {
  private value: Json;
  private watches: [WatchId, string[]][] = [];
  private next = 0;

  /** A data model holding `root` (kept as given; the caller hands it over). */
  constructor(root: Json = {}) {
    this.value = root;
  }

  /** The whole model. Read it, do not change it. */
  root(): Json {
    return this.value;
  }

  /** The value at `path`, or `undefined` when it is absent or `null`. */
  get(path: string): Json | undefined {
    return lookup(this.value, segments(path));
  }

  /** Watch `path`: `set` and `delete` report this id when the value there changes. */
  watch(path: string): WatchId {
    const parts = segments(path);
    const id = this.next++;
    this.watches.push([id, parts]);
    return id;
  }

  /** Stop every watch. */
  dispose(): void {
    this.watches = [];
  }

  /** Set the value at `path` (a copy of it), creating containers on the way; `/` replaces the
   * whole model. Returns the watches whose value changed. */
  set(path: string, value: Json): WatchId[] {
    const parts = segments(path);
    const before = this.snapshot();
    this.value = write(this.value, parts, path, clone(value));
    return this.changed(before);
  }

  /** Remove the value at `path` (an array element becomes `null`; `/` resets the model to `{}`).
   * Nothing is created; an absent path is a no-op. */
  delete(path: string): WatchId[] {
    const parts = segments(path);
    const before = this.snapshot();
    if (parts.length === 0) {
      this.value = {};
    } else if (hasParent(this.value, parts)) {
      this.value = write(this.value, parts, path, undefined);
    }
    return this.changed(before);
  }

  private snapshot(): (Json | undefined)[] {
    return this.watches.map(([, parts]) => clone(lookup(this.value, parts) ?? null));
  }

  private changed(before: (Json | undefined)[]): WatchId[] {
    return this.watches
      .filter(([, parts], i) => !equal(lookup(this.value, parts) ?? null, before[i] ?? null))
      .map(([id]) => id);
  }
}

function step(current: Json, part: string): Json | undefined {
  if (Array.isArray(current)) {
    const i = index(part);
    return i === null ? undefined : current[i];
  }
  if (isObject(current)) return own(current, part);
  return undefined;
}

function lookup(root: Json, parts: string[]): Json | undefined {
  let current: Json | undefined = root;
  for (const part of parts) {
    if (current === undefined) return undefined;
    current = step(current, part);
  }
  return current === null ? undefined : current;
}

/** Whether the container that would hold the last segment exists. */
function hasParent(root: Json, parts: string[]): boolean {
  let current: Json | undefined = root;
  for (const part of parts.slice(0, -1)) {
    if (current === undefined) return false;
    current = step(current, part);
  }
  return Array.isArray(current) || isObject(current);
}

function containerFor(next: string): Json {
  return index(next) === null ? {} : [];
}

/** Write `value` (or remove, for `undefined`) at `parts` under `root`; returns the new root. */
function write(root: Json, parts: string[], path: string, value: Json | undefined): Json {
  const last = parts.at(-1);
  if (last === undefined) return value ?? {};
  const primitive = (segment: string) =>
    new DataError(path, `Cannot set path '${path}': segment '${segment}' is a primitive value.`);
  if (root !== null && typeof root !== "object") {
    throw new DataError(
      path,
      `Cannot set path '${path}': the data model root is a primitive value.`,
    );
  }
  // Check before changing anything, so a refused write leaves the model as it was.
  const top: Json = root ?? containerFor(parts[0] ?? "");
  let current: Json = top;
  const pending: (() => void)[] = [];
  for (let position = 0; position < parts.length - 1; position++) {
    const part = parts[position] ?? "";
    const next = parts[position + 1] ?? "";
    let slot: Json | undefined;
    let assign: (v: Json) => void;
    if (Array.isArray(current)) {
      const items: Json[] = current;
      const i = arrayIndex(part, path);
      slot = items[i];
      assign = (v) => {
        while (items.length < i) items.push(null);
        items[i] = v;
      };
    } else if (isObject(current)) {
      const map: JsonObject = current;
      slot = own(map, part);
      assign = (v) => put(map, part, v);
    } else {
      throw primitive(part);
    }
    if (slot === undefined || slot === null) {
      const i = index(next);
      if (i !== null && i > MAX_ARRAY_INDEX) throw tooLarge(path, next);
      const created = containerFor(next);
      pending.push(() => assign(created));
      slot = created;
    } else if (typeof slot !== "object") {
      throw primitive(next);
    }
    current = slot;
  }
  if (Array.isArray(current)) {
    const items: Json[] = current;
    const i = arrayIndex(last, path);
    pending.forEach((apply) => apply());
    if (value === undefined) {
      if (i < items.length) items[i] = null;
    } else {
      while (items.length < i) items.push(null);
      items[i] = value;
    }
  } else if (isObject(current)) {
    pending.forEach((apply) => apply());
    if (value === undefined) remove(current, last);
    else put(current, last, value);
  } else {
    throw primitive(last);
  }
  return top;
}

function arrayIndex(segment: string, path: string): number {
  const i = index(segment);
  if (i === null) {
    throw new DataError(
      path,
      `Cannot use non-numeric segment '${segment}' on an array in path '${path}'.`,
    );
  }
  if (i > MAX_ARRAY_INDEX) throw tooLarge(path, segment);
  return i;
}

function tooLarge(path: string, segment: string): DataError {
  return new DataError(
    path,
    `Cannot set path '${path}': array index '${segment}' exceeds maximum supported index (${MAX_ARRAY_INDEX}).`,
  );
}
