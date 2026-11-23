// Catalogs: the components and functions a renderer draws and runs. A catalog is a JSON Schema
// document; this reads out of it what the runtime needs: each component's child-reference and
// action properties, and each function's callers and activation rule. Unlike agent86-ui's
// `catalog.rs` it does not check the document: agent86 has validated every batch against the same
// catalog before the app sees it, so the catalogs here are the app's own, trusted.

import basicDocument from "./fixtures/basic_catalog.json";
import { isObject, own, ownString } from "./json.ts";
import type { Json, JsonObject } from "./types.ts";

/** The basic catalog's id, as the specification publishes it. */
export const BASIC_CATALOG_ID = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";

/** How a component property refers to other components, read from its schema's `$ref`, which is
 * how the specification says validators find structural links. */
export type ChildRef =
  /** One component id (`ComponentId` or `Child`). */
  | { kind: "single" }
  /** A `ChildList`: an array of ids, or a template (`componentId` and `path`). */
  | { kind: "list" }
  /** An array of objects each holding one component id in this field (the basic catalog's
   * `Tabs.tabs[].child`). */
  | { kind: "items"; field: string };

/** What the runtime needs to know about one component type. */
export interface ComponentDef {
  /** The properties that hold child references, sorted by name (agent86's order). */
  children: [property: string, ref: ChildRef][];
  /** The properties that hold an `Action`, run on a gesture rather than resolved. */
  actions: Set<string>;
}

/** Who may call a function (`allowedCallers`). */
export type Callers = "rendererOnly" | "agentOnly" | "rendererOrAgent";

/** What the runtime needs to know about one function. */
export interface FunctionDef {
  returnType: string;
  callers: Callers;
  /** Whether it may only run from a user gesture (`requiresUserActivation`). */
  requiresUserActivation: boolean;
}

/** A loaded catalog. */
export class Catalog {
  readonly id: string;
  readonly document: JsonObject;
  private readonly componentDefs = new Map<string, ComponentDef>();
  private readonly functionDefs = new Map<string, FunctionDef>();

  constructor(document: JsonObject) {
    this.document = document;
    this.id = ownString(document, "catalogId") ?? "";
    const components = own(document, "components");
    if (isObject(components)) {
      for (const [name, schema] of Object.entries(components)) {
        this.componentDefs.set(name, componentDef(schema));
      }
    }
    const functions = own(document, "functions");
    if (isObject(functions)) {
      for (const [name, schema] of Object.entries(functions)) {
        this.functionDefs.set(name, functionDef(schema));
      }
    }
  }

  /** The specification's basic catalog (`catalogs/basic/v1`), vendored. */
  static basic(): Catalog {
    basic ??= new Catalog(basicDocument as unknown as JsonObject);
    return basic;
  }

  /** This catalog's document under another id (the conformance suites call the basic catalog
   * `basic`). */
  withId(id: string): Catalog {
    return new Catalog({ ...this.document, catalogId: id });
  }

  /** One component type, if the catalog has it. */
  component(name: string): ComponentDef | undefined {
    return this.componentDefs.get(name);
  }

  /** One function, if the catalog has it. */
  function(name: string): FunctionDef | undefined {
    return this.functionDefs.get(name);
  }

  /** Whether `name` is component `typeName`'s own property here, not the envelope's: declared in
   * its schema's `properties` (or an `allOf`/`oneOf`/`anyOf` branch, or a local `$ref`), except
   * that a `catalogId` or `metadata` declared beside `id` in the standard shape is the envelope's,
   * as early 1.0 drafts inlined it. A bare `catalogId`, `metadata`, `accessibility`, or `checks`
   * that is not the component's own is the legacy spelling of the `@` key. */
  declaresOwn(typeName: string, name: string): boolean {
    const components = own(this.document, "components");
    const schema = isObject(components) ? own(components, typeName) : undefined;
    return schema !== undefined && ownProperty(schema, name, this.document, 0);
  }
}

let basic: Catalog | undefined;

/** A schema's `properties` objects: its own and those of its `allOf` entries (where catalogs put
 * local properties beside a `Checkable`). */
function propertyMaps(schema: Json): JsonObject[] {
  if (!isObject(schema)) return [];
  const maps: JsonObject[] = [];
  const properties = own(schema, "properties");
  if (isObject(properties)) maps.push(properties);
  const all = own(schema, "allOf");
  if (Array.isArray(all)) {
    for (const entry of all) {
      const inner = isObject(entry) ? own(entry, "properties") : undefined;
      if (isObject(inner)) maps.push(inner);
    }
  }
  return maps;
}

function childRef(property: Json | undefined): ChildRef | null {
  const ref = isObject(property) ? ownString(property, "$ref") : undefined;
  switch (ref) {
    case "common_types.json#/$defs/ComponentId":
    case "common_types.json#/$defs/Child":
      return { kind: "single" };
    case "common_types.json#/$defs/ChildList":
      return { kind: "list" };
    default:
      return null;
  }
}

/** An array property of child references: its items each one id (read as a list of ids), or
 * objects with a child-reference field. */
function itemsRef(property: Json): ChildRef | null {
  const items = isObject(property) ? own(property, "items") : undefined;
  if (!isObject(items)) return null;
  if (childRef(items)?.kind === "single") return { kind: "list" };
  const fields = own(items, "properties");
  if (!isObject(fields)) return null;
  const found = Object.entries(fields).find(([, field]) => childRef(field)?.kind === "single");
  return found ? { kind: "items", field: found[0] } : null;
}

function componentDef(schema: Json): ComponentDef {
  const children = new Map<string, ChildRef>();
  const actions = new Set<string>();
  for (const properties of propertyMaps(schema)) {
    for (const [name, property] of Object.entries(properties)) {
      const ref = childRef(property) ?? itemsRef(property);
      if (ref) children.set(name, ref);
      if (isObject(property) && own(property, "$ref") === "common_types.json#/$defs/Action") {
        actions.add(name);
      }
    }
  }
  const sorted = [...children].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { children: sorted, actions };
}

function functionDef(schema: Json): FunctionDef {
  const object = isObject(schema) ? schema : {};
  const callers = own(object, "allowedCallers");
  return {
    returnType: ownString(object, "returnType") ?? "any",
    callers: callers === "agentOnly" || callers === "rendererOrAgent" ? callers : "rendererOnly",
    requiresUserActivation: own(object, "requiresUserActivation") === true,
  };
}

/** The value at a local JSON Pointer (`/$defs/X`) inside a document. */
function at(document: Json, pointer: string): Json | undefined {
  let current: Json | undefined = document;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) current = current[Number(key)];
    else if (isObject(current)) current = own(current, key);
    else return undefined;
  }
  return current;
}

function ownProperty(schema: Json, name: string, document: Json, depth: number): boolean {
  if (depth > 16 || !isObject(schema)) return false;
  const properties = own(schema, "properties");
  if (isObject(properties)) {
    const property = own(properties, name);
    if (property !== undefined) {
      let standard = false;
      if (isObject(property)) {
        if (name === "catalogId") standard = own(property, "type") === "string";
        if (name === "metadata") {
          const inner = own(property, "properties");
          standard =
            own(property, "type") === "object" &&
            isObject(inner) &&
            Object.keys(inner).length === 1 &&
            Object.hasOwn(inner, "extensions");
        }
      }
      if (!(standard && Object.hasOwn(properties, "id"))) return true;
    }
  }
  const ref = ownString(schema, "$ref");
  if (ref?.startsWith("#")) {
    const target = at(document, ref.slice(1));
    if (target !== undefined && ownProperty(target, name, document, depth + 1)) return true;
  }
  return ["allOf", "oneOf", "anyOf"].some((key) => {
    const parts = own(schema, key);
    return (
      Array.isArray(parts) && parts.some((part) => ownProperty(part, name, document, depth + 1))
    );
  });
}
