// Evaluating dynamic values: data bindings, function calls, and the basic catalog's functions, with
// the specification's coercion rules ("`DynamicBoolean` and `CheckRule` Coercion") and catalog
// resolution ("Mixable catalogs and component resolution logic").
//
// A call resolves in its own `catalogId`, else the scope's default catalog (the surface's, or,
// inside a `formatString` template, the template's), else it fails. The function must be declared
// by that catalog and implemented here; the basic catalog's functions are implemented natively,
// whatever catalog declares them. A function that needs a user gesture runs only in a scope that
// has one, and an `agentOnly` function never runs on the renderer.

import type { Catalog, FunctionDef } from "./catalog.ts";
import { DataError, resolve } from "./data.ts";
import type { DataModel } from "./data.ts";
import { ExpressionError, numberValue, parse } from "./expr.ts";
import type { Part } from "./expr.ts";
import {
  formatCurrency,
  formatDate,
  formatNumber,
  numberString,
  pluralCategory,
  toNumber,
  toString,
} from "./format.ts";
import { isObject, own, ownString, put } from "./json.ts";
import { MAX_VALUE_CODE_POINTS, Pattern } from "./regex.ts";
import type { Effect, Json, JsonObject } from "./types.ts";

/** The specification's error categories, as the shared suites name them. */
export type Category = "ExpressionError" | "CatalogError" | "DataError" | "ExecutionError";

/** A failure while evaluating. `ExpressionError`: a function failed, was refused, or a template
 * did not parse; `CatalogError`: a call's catalog could not be resolved; `DataError`: a binding's
 * path is not allowed; `ExecutionError`: a local function ran and failed. */
export class EvalError extends Error {
  readonly category: Category;
  constructor(category: Category, message: string) {
    super(message);
    this.name = "EvalError";
    this.category = category;
  }
}

const expression = (message: string) => new EvalError("ExpressionError", message);

/** What a function asked for: an effect for the renderer, or a data write (a local function's,
 * applied when the action finishes). */
export type LocalEffect = Effect | { kind: "setData"; path: string; value: Json };

/** A function the app implements for its own catalog, run on the renderer: given the resolved
 * arguments and its scope, it returns a value or throws (an `EXECUTION_ERROR`). */
export type LocalFunction = (args: JsonObject, scope: Scope) => Json;

/** Where an expression is evaluated. */
export class Scope {
  /** The surface's data model. */
  readonly data: DataModel;
  /** The data context a relative path resolves against (`/` at the root, the item's path inside a
   * template). */
  path = "/";
  /** The innermost template's item index, for `@index`. */
  index: number | null = null;
  /** The catalog a call without its own `catalogId` resolves in. */
  catalog: string | null;
  /** Whether this runs from a user gesture (an action), which functions that need one require. */
  activation = false;
  /** @internal What functions asked for, in order. */
  effects: LocalEffect[] = [];

  constructor(data: DataModel, catalog: string | null) {
    this.data = data;
    this.catalog = catalog;
  }

  /** This scope with another default catalog, collecting its own effects. */
  withCatalog(catalog: string | null): Scope {
    const scope = new Scope(this.data, catalog);
    scope.path = this.path;
    scope.index = this.index;
    scope.activation = this.activation;
    return scope;
  }

  /** The effects functions asked for, in order, taken out of the scope. */
  takeEffects(): LocalEffect[] {
    const effects = this.effects;
    this.effects = [];
    return effects;
  }

  /** Read the data model at a path relative to this scope (`undefined` when absent or not
   * allowed). */
  get(path: string): Json | undefined {
    try {
      return this.data.get(resolve(this.path, path));
    } catch {
      return undefined;
    }
  }

  /** Ask for a data model write, for a local function: applied when the action that ran it
   * finishes, and dropped when it ran from a binding. */
  set(path: string, value: Json): void {
    this.effects.push({ kind: "setData", path: resolve(this.path, path), value });
  }
}

/** The `DynamicBoolean` coercion: booleans as themselves, a validation result as its `valid`,
 * `"true"`/`"false"` in any case, a nonzero number as true, and everything else (other strings,
 * `null`, objects, arrays) as false. */
export function coerceBool(value: Json | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (isObject(value)) return own(value, "valid") === true;
  if (typeof value === "string") return value.toLowerCase() === "true";
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  return false;
}

/** A validation result's `valid`, if the value is one. */
export function validity(value: Json | undefined): boolean | null {
  if (!isObject(value)) return null;
  const valid = own(value, "valid");
  return typeof valid === "boolean" ? valid : null;
}

function result(valid: boolean, message?: string): JsonObject {
  return valid || message === undefined ? { valid } : { valid, message };
}

const NATIVE = new Set([
  "required",
  "regex",
  "length",
  "numeric",
  "email",
  "formatString",
  "formatNumber",
  "formatCurrency",
  "formatDate",
  "pluralize",
  "openUrl",
  "and",
  "or",
  "not",
]);

/** The email check every reference SDK uses. */
const EMAIL = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/** Evaluates dynamic values against a set of catalogs. */
export class Evaluator {
  private readonly catalogs: Catalog[];
  private readonly locals = new Map<string, [FunctionDef, LocalFunction]>();

  constructor(catalogs: Catalog[]) {
    this.catalogs = catalogs;
  }

  /** Implement a function on the renderer: `def` says who may call it and whether it needs a
   * gesture, as a catalog entry would. It can be called from any of the evaluator's catalogs. */
  register(name: string, def: FunctionDef, fn: LocalFunction): void {
    this.locals.set(name, [def, fn]);
  }

  private catalog(id: string): Catalog | undefined {
    return this.catalogs.find((catalog) => catalog.id === id);
  }

  /** Resolve a dynamic value: a `{"@path": ...}` reads the data model (absent is `null`), a
   * `{"@call": ...}` calls the function, an array resolves element by element, and any other
   * object is a literal (its `@@` keys unescaped to `@`). A literal object with a single-`@` key
   * is refused, as the specification reserves that namespace. Throws EvalError. */
  evaluate(value: Json, scope: Scope): Json {
    if (isObject(value)) {
      const path = ownString(value, "@path");
      if (path !== undefined) {
        try {
          return scope.data.get(resolve(scope.path, path)) ?? null;
        } catch (error) {
          throw asEvalError(error);
        }
      }
      if (typeof own(value, "@call") === "string") return this.call(value, scope);
      const literal: JsonObject = {};
      for (const [key, inner] of Object.entries(value)) {
        if (key.startsWith("@@")) put(literal, `@${key.slice(2)}`, inner);
        else if (key.startsWith("@")) throw expression(`'${key}' is a reserved key`);
        else put(literal, key, inner);
      }
      return literal;
    }
    if (Array.isArray(value)) return value.map((item) => this.evaluate(item, scope));
    return value;
  }

  /** Call a function: `{"@call": name, "catalogId"?: ..., "args"?: {...}}`. Throws EvalError. */
  call(call: JsonObject, scope: Scope): Json {
    const name = ownString(call, "@call") ?? "";
    const rawArgsValue = own(call, "args");
    const rawArgs: JsonObject = isObject(rawArgsValue) ? rawArgsValue : {};
    if (name === "@index") {
      if (scope.index === null) {
        throw expression(
          "@index function can only be evaluated inside a collection template iteration scope.",
        );
      }
      const offsetArg = own(rawArgs, "offset");
      const offset = offsetArg === undefined ? 0 : toNumber(this.evaluate(offsetArg, scope));
      return numberValue(scope.index + offset);
    }
    if (name.startsWith("@")) throw expression(`Unknown system function '${name}'`);
    const catalogId = ownString(call, "catalogId") ?? scope.catalog;
    if (catalogId === null) {
      throw new EvalError(
        "CatalogError",
        `Cannot resolve function '${name}': the call names no catalogId and the surface has no default catalogId`,
      );
    }
    const catalog = this.catalog(catalogId);
    if (!catalog) throw new EvalError("CatalogError", `Catalog not found: ${catalogId}`);
    const local = this.locals.get(name);
    const def = catalog.function(name) ?? local?.[0];
    if (!def) throw expression(`Function '${name}' is not defined in catalog '${catalogId}'`);
    if (def.callers === "agentOnly") {
      throw expression(`Function '${name}' is agentOnly and cannot be called by renderer`);
    }
    if (def.requiresUserActivation && !scope.activation) {
      throw expression(
        `Function '${name}' requires user activation: it can only run from an action`,
      );
    }
    if (!local && !NATIVE.has(name)) {
      throw expression(
        `Function '${name}' of catalog '${catalogId}' has no implementation in this renderer`,
      );
    }
    // Nested calls resolve in their own catalog or the scope's default; only a formatString
    // template passes its catalog on.
    const args: JsonObject = {};
    for (const [key, value] of Object.entries(rawArgs)) put(args, key, this.evaluate(value, scope));
    if (local) {
      try {
        return local[1](args, scope);
      } catch (error) {
        throw new EvalError(
          "ExecutionError",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return this.native(name, args, catalogId, scope);
  }

  private native(name: string, args: JsonObject, catalogId: string, scope: Scope): Json {
    const arg = (key: string): Json => own(args, key) ?? null;
    const number = (key: string): number | null => {
      const value = own(args, key);
      if (value === undefined) return null;
      const n = toNumber(value);
      return Number.isNaN(n) ? null : n;
    };
    const decimals = (): number | null => {
      const d = number("decimals");
      return d === null ? null : Math.round(Math.min(Math.max(d, 0), 20));
    };
    const grouping = () => {
      const value = own(args, "grouping");
      return value === undefined || coerceBool(value);
    };
    const bounds = (value: number, what: string): JsonObject => {
      const min = number("min");
      const max = number("max");
      if (min !== null && value < min) {
        return result(false, `Minimum ${what} is ${numberString(min)}.`);
      }
      if (max !== null && value > max) {
        return result(false, `Maximum ${what} is ${numberString(max)}.`);
      }
      return result(true);
    };
    switch (name) {
      case "required": {
        const value = arg("value");
        const present =
          value === null
            ? false
            : typeof value === "string" || Array.isArray(value)
              ? value.length > 0
              : true;
        return result(present, "This field is required.");
      }
      case "regex": {
        const pattern = typeof arg("pattern") === "string" ? (arg("pattern") as string) : "";
        const compiled = Pattern.compile(pattern);
        if (!(compiled instanceof Pattern)) {
          throw expression(`Invalid or unsafe regex pattern (${compiled}): ${pattern}`);
        }
        const value = toString(arg("value"));
        if (Array.from(value).length > MAX_VALUE_CODE_POINTS) {
          return result(false, "Value exceeds the maximum length for pattern matching.");
        }
        return result(compiled.test(value), "Value does not match required pattern.");
      }
      case "length": {
        const value = arg("value");
        const length = typeof value === "string" || Array.isArray(value) ? value.length : 0;
        return bounds(length, "length");
      }
      case "numeric": {
        const value = toNumber(arg("value"));
        if (Number.isNaN(value)) return result(false, "Value must be a valid number.");
        return bounds(value, "value");
      }
      case "email": {
        const value = arg("value");
        if (typeof value === "string" && EMAIL.test(value)) return result(true);
        return {
          valid: false,
          code: "INVALID_EMAIL",
          severity: "error",
          message: "Please enter a valid email address (e.g. user@example.com).",
        };
      }
      case "formatString": {
        const value = arg("value");
        return typeof value === "string" ? this.template(value, catalogId, scope) : toString(value);
      }
      case "formatNumber":
        return formatNumber(toNumber(arg("value")), decimals(), grouping());
      case "formatCurrency":
        return formatCurrency(
          toNumber(arg("value")),
          toString(arg("currency")),
          decimals(),
          grouping(),
        );
      case "formatDate":
        return formatDate(arg("value"), toString(arg("format")));
      case "pluralize": {
        const category = pluralCategory(toNumber(arg("value")), (key) => Object.hasOwn(args, key));
        const chosen = own(args, category) ?? own(args, "other");
        return chosen === undefined ? "" : toString(chosen);
      }
      case "openUrl": {
        const trimmed = toString(arg("url")).trim();
        const lower = trimmed.toLowerCase();
        if (!(lower.startsWith("https://") || lower.startsWith("http://"))) {
          throw expression(
            `openUrl only opens http and https URLs, not ${JSON.stringify(trimmed)}`,
          );
        }
        scope.effects.push({ kind: "openUrl", url: trimmed });
        return null;
      }
      case "and":
      case "or": {
        const values = arg("values");
        const list = Array.isArray(values) ? values : [];
        if (list.length < 2) throw expression(`${name} requires at least 2 values`);
        return name === "and" ? list.every(coerceBool) : list.some(coerceBool);
      }
      case "not":
        return !coerceBool(arg("value"));
      default:
        throw expression(`Function '${name}' has no implementation`);
    }
  }

  /** Evaluate a `formatString` template: its calls resolve in the catalog the `formatString` call
   * resolved to, and every part becomes text. */
  private template(template: string, catalogId: string, scope: Scope): string {
    let parts: Part[];
    try {
      parts = parse(template);
    } catch (error) {
      throw asEvalError(error);
    }
    const inner = scope.withCatalog(catalogId);
    let out = "";
    for (const part of parts) out += toString(this.evaluate(partValue(part, catalogId), inner));
    scope.effects.push(...inner.takeEffects());
    return out;
  }
}

/** Any error as an EvalError, by its kind. */
export function asEvalError(error: unknown): EvalError {
  if (error instanceof EvalError) return error;
  if (error instanceof DataError) return new EvalError("DataError", error.message);
  if (error instanceof ExpressionError) return expression(error.message);
  return expression(error instanceof Error ? error.message : String(error));
}

/** A template part as a dynamic value: a binding as `{"@path"}`, a call as `{"@call"}` in the
 * template's catalog (system functions stay catalogless). */
function partValue(part: Part, catalogId: string): Json {
  switch (part.kind) {
    case "literal":
      return part.value;
    case "path":
      return { "@path": part.path };
    case "call": {
      const args: JsonObject = {};
      for (const [key, value] of part.args) put(args, key, partValue(value, catalogId));
      const call: JsonObject = { "@call": part.name, args };
      if (!part.name.startsWith("@")) call.catalogId = catalogId;
      return call;
    }
  }
}
