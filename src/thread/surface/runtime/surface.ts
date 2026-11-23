// Surfaces: the state a renderer keeps for each surface, and what it derives from it.
//
// `Runtime.apply` applies a batch: components are stored, the data model updated (`null`
// deletes), and every touched surface evaluated, so a template that does not parse or an `@index`
// outside a list is reported. agent86 has validated the batch before the app sees it, so this
// keeps no validator; unlike agent86's runtime it does not refuse a batch all or nothing, since the
// agent already believes it is shown: a message that cannot be applied is skipped and reported,
// and an evaluation problem shows on its node as well as in the report.
//
// `Runtime.tree` resolves a surface for drawing: a Node per component instance (a list template
// gives one per item), its properties with every binding and call evaluated, its failing checks,
// and its children. `Runtime.input` writes what the user enters (two-way binding), and
// `Runtime.dispatch` runs a component's action on the user's gesture, giving the `action` to send
// the agent or the effects of a local function.

import type { UiAction } from "../../../desktop-client/events.ts";
import { Catalog } from "./catalog.ts";
import type { FunctionDef } from "./catalog.ts";
import { DataError, DataModel, normalize, resolve } from "./data.ts";
import { coerceBool, EvalError, Evaluator, Scope, validity } from "./functions.ts";
import type { LocalEffect, LocalFunction } from "./functions.ts";
import { toString } from "./format.ts";
import { clone, isObject, own, ownString, put } from "./json.ts";
import type { ActionError, Dispatch, Effect, Gesture, Json, JsonObject, Node } from "./types.ts";

/** How deep a component tree may nest before resolution stops, so a cycle cannot recurse without
 * end. */
export const MAX_TREE_DEPTH = 64;

/** What went wrong applying a batch. `DATA_ERROR`: a data model write was refused;
 * `EXPRESSION_ERROR`: something on a component failed to evaluate; `INVALID_MESSAGE`: a message
 * this runtime cannot read (agent86's validator would not have passed it). */
export interface Problem {
  code: "DATA_ERROR" | "EXPRESSION_ERROR" | "INVALID_MESSAGE";
  surfaceId: string | null;
  /** Where in the batch, as a JSON Pointer (`/1/updateDataModel/path`), or `""`. */
  path: string;
  message: string;
}

/** A problem as one line, for a log. */
export function problemText(problem: Problem): string {
  const surface = problem.surfaceId === null ? "" : ` on surface ${problem.surfaceId}`;
  const at = problem.path === "" ? "" : ` at ${problem.path}`;
  return `${problem.code}${surface}${at}: ${problem.message}`;
}

interface SurfaceState {
  catalogId: string | null;
  sendDataModel: boolean;
  /** `createSurface`'s `metadata` (its `extensions`), as sent. */
  metadata: Json | undefined;
  components: Map<string, JsonObject>;
  data: DataModel;
}

/** Whether no check fails with severity `error` (a button with a failing check is disabled). */
export function isValid(node: Node): boolean {
  return !node.failures.some(isError);
}

/** The messages of the failing `error` checks, in order. */
export function validationErrors(node: Node): string[] {
  return node.failures.filter(isError).map((failure) => ownString(failure, "message") ?? "");
}

/** The first failing check, or `{"valid": true}`. */
export function validationResult(node: Node): JsonObject {
  return node.failures[0] ?? { valid: true };
}

/** Every node in this subtree, this one first. */
export function walk(node: Node): Node[] {
  const out = [node];
  for (const [, nodes] of node.children) for (const child of nodes) out.push(...walk(child));
  return out;
}

function isError(failure: JsonObject): boolean {
  return (ownString(failure, "severity") ?? "error") === "error";
}

const ENVELOPE = new Set(["id", "component", "@catalogId", "@metadata", "@checks"]);

/** A renderer's surfaces, headless. */
export class Runtime {
  private readonly catalogs: Catalog[];
  private readonly evaluator: Evaluator;
  private readonly surfaces = new Map<string, SurfaceState>();
  /** Each node's component as sent, for `bindingPath`. */
  private readonly sources = new WeakMap<Node, JsonObject>();

  /** A runtime for a renderer that supports `catalogs`. */
  constructor(catalogs: Catalog[]) {
    this.catalogs = catalogs;
    this.evaluator = new Evaluator(catalogs);
  }

  /** A runtime for the basic catalog. */
  static basic(): Runtime {
    return new Runtime([Catalog.basic()]);
  }

  /** Implement a function on the renderer (see `Evaluator.register`). */
  register(name: string, def: FunctionDef, fn: LocalFunction): void {
    this.evaluator.register(name, def, fn);
  }

  /** The surfaces, by id. */
  surfaceIds(): string[] {
    return [...this.surfaces.keys()].sort();
  }

  hasSurface(surfaceId: string): boolean {
    return this.surfaces.has(surfaceId);
  }

  /** A surface's data model. Read it, do not change it. */
  dataModel(surfaceId: string): Json | undefined {
    return this.surfaces.get(surfaceId)?.data.root();
  }

  /** A surface's `metadata` from `createSurface`. */
  surfaceMetadata(surfaceId: string): Json | undefined {
    return this.surfaces.get(surfaceId)?.metadata;
  }

  /** Whether the surface asked for its data model with every message. */
  sendsDataModel(surfaceId: string): boolean {
    return this.surfaces.get(surfaceId)?.sendDataModel ?? false;
  }

  /** A surface's components as the agent sent them (the latest of each id). */
  components(surfaceId: string): JsonObject[] {
    return [...(this.surfaces.get(surfaceId)?.components.values() ?? [])];
  }

  /** The raw component as sent (to read its `action`), or undefined. */
  component(surfaceId: string, componentId: string): JsonObject | undefined {
    return this.surfaces.get(surfaceId)?.components.get(componentId);
  }

  /** Apply a batch of agent-to-renderer messages, in order. Returns problems (empty when fine);
   * never throws. */
  apply(messages: Json[]): string[] {
    return this.applyReport(messages).map(problemText);
  }

  /** `apply`, with each problem's code, surface, and place in the batch. */
  applyReport(messages: Json[]): Problem[] {
    const problems: Problem[] = [];
    const touched = new Set<string>();
    messages.forEach((message, index) => {
      try {
        const problem = this.applyOne(message, index, touched);
        if (problem) problems.push(problem);
      } catch (error) {
        // Nothing a message holds should get here; if it does, it costs that message only.
        problems.push({
          code: "INVALID_MESSAGE",
          surfaceId: null,
          path: `/${index}`,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    for (const id of [...touched].sort()) {
      const surface = this.surfaces.get(id);
      if (!surface?.components.has("root")) continue;
      const tree = this.resolve(surface, "root", "/", null, 0, []);
      for (const node of walk(tree)) {
        for (const error of node.errors) {
          problems.push({
            code: "EXPRESSION_ERROR",
            surfaceId: id,
            path: "",
            message: `${node.id}: ${error}`,
          });
        }
      }
    }
    return problems;
  }

  private applyOne(message: Json, index: number, touched: Set<string>): Problem | null {
    const invalid = (text: string, surfaceId: string | null = null): Problem => ({
      code: "INVALID_MESSAGE",
      surfaceId,
      path: `/${index}`,
      message: text,
    });
    if (!isObject(message)) return invalid("a message is a JSON object");
    const kind = ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"].find(
      (key) => Object.hasOwn(message, key),
    );
    if (kind === undefined) {
      return invalid(
        "a message holds createSurface, updateComponents, updateDataModel, or deleteSurface",
      );
    }
    const body = own(message, kind);
    if (!isObject(body)) return invalid(`${kind} is a JSON object`);
    const id = ownString(body, "surfaceId");
    if (id === undefined) return invalid(`${kind} needs a string surfaceId`);
    if (kind === "createSurface") {
      const catalogId = ownString(body, "catalogId") ?? null;
      const dataModel = own(body, "dataModel");
      const state: SurfaceState = {
        catalogId,
        sendDataModel: own(body, "sendDataModel") === true,
        metadata: own(body, "metadata"),
        components: new Map(),
        data: new DataModel(dataModel === undefined || dataModel === null ? {} : clone(dataModel)),
      };
      this.store(state, body);
      this.surfaces.set(id, state);
      touched.add(id);
      return null;
    }
    if (kind === "deleteSurface") {
      this.surfaces.delete(id);
      touched.delete(id);
      return null;
    }
    const state = this.surfaces.get(id);
    if (!state) return invalid(`surface ${JSON.stringify(id)} does not exist`, id);
    if (kind === "updateComponents") {
      this.store(state, body);
      touched.add(id);
      return null;
    }
    const pathValue = own(body, "path");
    const path = typeof pathValue === "string" ? pathValue : "/";
    const value = own(body, "value") ?? null;
    try {
      if (value === null) state.data.delete(path);
      else state.data.set(path, value);
    } catch (error) {
      if (!(error instanceof DataError)) throw error;
      return {
        code: "DATA_ERROR",
        surfaceId: id,
        path: `/${index}/updateDataModel/path`,
        message: error.message,
      };
    }
    touched.add(id);
    return null;
  }

  /** Store a message's components, each with its legacy envelope keys moved to their `@`
   * spellings, as renderers accept them during the 1.0 transition: a bare `catalogId` that the
   * component's schema in the surface's catalog does not declare routes it like `@catalogId`, and
   * a bare `metadata`, `accessibility`, or `checks` its schema does not declare is that `@` key. */
  private store(state: SurfaceState, body: JsonObject): void {
    const components = own(body, "components");
    if (!Array.isArray(components)) return;
    for (const raw of components) {
      if (!isObject(raw)) continue;
      const id = ownString(raw, "id");
      if (id === undefined) continue;
      const component = { ...raw };
      const typeName = ownString(component, "component") ?? "";
      const declares = (catalogId: string | null, key: string) =>
        catalogId !== null &&
        (this.catalogs.find((c) => c.id === catalogId)?.declaresOwn(typeName, key) ?? false);
      const legacy = (key: string, declared: boolean) => {
        const prefixed = `@${key}`;
        if (declared || !Object.hasOwn(component, key)) return;
        if (!Object.hasOwn(component, prefixed)) put(component, prefixed, component[key] ?? null);
        delete component[key];
      };
      legacy("catalogId", declares(state.catalogId, "catalogId"));
      const resolved = ownString(component, "@catalogId") ?? state.catalogId;
      for (const key of ["metadata", "accessibility", "checks"]) {
        legacy(key, declares(resolved, key));
      }
      state.components.set(id, component);
    }
  }

  /** The resolved tree from `root`, or null when the surface or its root does not exist. */
  tree(surfaceId: string): Node | null {
    const surface = this.surfaces.get(surfaceId);
    if (!surface?.components.has("root")) return null;
    return this.resolve(surface, "root", "/", null, 0, []);
  }

  /** One component resolved at the root data context, whether or not it is reachable from
   * `root`, or null. */
  node(surfaceId: string, componentId: string): Node | null {
    const surface = this.surfaces.get(surfaceId);
    if (!surface?.components.has(componentId)) return null;
    return this.resolve(surface, componentId, "/", null, 0, []);
  }

  private resolve(
    surface: SurfaceState,
    id: string,
    dataPath: string,
    index: number | null,
    depth: number,
    stack: string[],
  ): Node {
    const node: Node = {
      id,
      component: "",
      dataPath,
      index,
      properties: {},
      accessibility: null,
      failures: [],
      errors: [],
      children: [],
      placeholder: false,
    };
    const component = surface.components.get(id);
    if (!component) {
      node.placeholder = true;
      return node;
    }
    this.sources.set(node, component);
    if (depth > MAX_TREE_DEPTH || stack.includes(id)) {
      node.placeholder = true;
      node.errors.push("the component tree nests too deeply or forms a cycle here");
      return node;
    }
    node.component = ownString(component, "component") ?? "";
    const catalogId = ownString(component, "@catalogId") ?? surface.catalogId;
    const catalog = this.catalogs.find((candidate) => candidate.id === catalogId);
    const def = catalog?.component(node.component) ?? { children: [], actions: new Set() };
    const childKinds = new Map(def.children);

    const scope = new Scope(surface.data, surface.catalogId);
    scope.path = dataPath;
    scope.index = index;

    for (const [key, value] of Object.entries(component)) {
      // An items property (Tabs' `tabs`) holds more than ids (each tab's title), so it stays among
      // the properties as well.
      const kind = childKinds.get(key)?.kind;
      if (ENVELOPE.has(key) || kind === "single" || kind === "list" || def.actions.has(key)) {
        continue;
      }
      const resolved = this.deep(value, scope, node.errors, key);
      if (key === "@accessibility") node.accessibility = isObject(resolved) ? resolved : null;
      else put(node.properties, key, resolved);
    }
    // Checks: in order, failures only.
    const checks = own(component, "@checks");
    if (Array.isArray(checks)) {
      for (const rule of checks) {
        const failure = this.check(rule, scope);
        if (failure) node.failures.push(failure);
      }
    }
    // Children.
    stack.push(id);
    for (const [property, kind] of def.children) {
      const value = own(component, property);
      if (value === undefined) continue;
      const nodes: Node[] = [];
      const child = (childId: string, path: string, i: number | null) =>
        nodes.push(this.resolve(surface, childId, path, i, depth + 1, stack));
      if (kind.kind === "single" && typeof value === "string") {
        child(value, dataPath, index);
      } else if (kind.kind === "list" && Array.isArray(value)) {
        for (const childId of value)
          if (typeof childId === "string") child(childId, dataPath, index);
      } else if (kind.kind === "list" && isObject(value)) {
        const templateId = ownString(value, "componentId") ?? "";
        const listPath = resolve(dataPath, ownString(value, "path") ?? "");
        try {
          const items = surface.data.get(listPath);
          if (Array.isArray(items)) {
            const base = listPath.replace(/\/+$/, "");
            items.forEach((_, i) => child(templateId, `${base}/${i}`, i));
          }
        } catch (error) {
          node.errors.push(
            `${property}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else if (kind.kind === "items" && Array.isArray(value)) {
        for (const item of value) {
          const childId = isObject(item) ? ownString(item, kind.field) : undefined;
          if (childId !== undefined) child(childId, dataPath, index);
        }
      }
      node.children.push([property, nodes]);
    }
    stack.pop();
    return node;
  }

  /** Resolve every binding and call inside a property value, deeply; a failure becomes `null` and
   * a recorded error. A literal object's single-`@` key is refused here too: agent86's validator
   * refuses it before the app sees it, and the app keeps no validator of its own. */
  private deep(value: Json, scope: Scope, errors: string[], at: string): Json {
    const dynamic =
      isObject(value) && (Object.hasOwn(value, "@path") || typeof own(value, "@call") === "string");
    if (dynamic) {
      try {
        const resolved = this.evaluator.evaluate(value, scope);
        // Effects from a binding (a write, an open) never happen.
        scope.takeEffects();
        return resolved;
      } catch (error) {
        scope.takeEffects();
        errors.push(`${at}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }
    if (Array.isArray(value)) {
      return value.map((item, i) => this.deep(item, scope, errors, `${at}/${i}`));
    }
    if (isObject(value)) {
      const out: JsonObject = {};
      for (const key of Object.keys(value)) {
        if (key.startsWith("@") && !key.startsWith("@@")) {
          errors.push(`${at}: '${key}' is a reserved key`);
          return null;
        }
      }
      for (const [key, inner] of Object.entries(value)) {
        const name = key.startsWith("@@") ? `@${key.slice(2)}` : key;
        put(out, name, this.deep(inner, scope, errors, `${at}/${key}`));
      }
      return out;
    }
    return value;
  }

  /** Evaluate one check rule, returning its failure (normalized) or null when it passes. A boolean
   * or a validation result from a function takes the rule's `message` when it has one; a
   * validation result read from the data model keeps its own message (the specification's
   * coercion rules and the shared suites' comparison rules). */
  private check(rule: Json, scope: Scope): JsonObject | null {
    if (!isObject(rule)) return null;
    const condition = own(rule, "condition");
    if (condition === undefined) return null;
    const ruleMessage = ownString(rule, "message");
    const fromData = isObject(condition) && Object.hasOwn(condition, "@path");
    let failure: JsonObject;
    try {
      const value = this.evaluator.evaluate(condition, scope);
      const valid = validity(value);
      if (valid === true) return null;
      if (valid === false && isObject(value)) {
        failure = { ...value };
        const ownMessage = ownString(failure, "message");
        const message = fromData ? (ownMessage ?? ruleMessage) : (ruleMessage ?? ownMessage);
        if (message !== undefined) failure.message = message;
      } else {
        if (coerceBool(value)) return null;
        failure = { valid: false };
        if (ruleMessage !== undefined) failure.message = ruleMessage;
      }
    } catch (error) {
      failure = {
        valid: false,
        message: ruleMessage ?? (error instanceof Error ? error.message : String(error)),
      };
    } finally {
      scope.takeEffects();
    }
    if (!Object.hasOwn(failure, "severity")) failure.severity = "error";
    return failure;
  }

  /** The absolute data model path a node's property is two-way bound to (`{"@path": p}` resolved
   * against `node.dataPath`), or null if that property is not a plain binding. `node` must come
   * from this runtime's `tree` or `node`. */
  bindingPath(node: Node, property: string): string | null {
    const component = this.sources.get(node);
    const value = component === undefined ? undefined : own(component, property);
    if (!isObject(value) || Object.keys(value).length !== 1) return null;
    const path = ownString(value, "@path");
    if (path === undefined) return null;
    try {
      return normalize(resolve(node.dataPath, path));
    } catch {
      return null;
    }
  }

  /** Write what the user entered at an absolute data model path (two-way binding). Returns an
   * error message, or null (also when the surface is gone: the input raced its deletion). */
  input(surfaceId: string, path: string, value: Json): string | null {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) return null;
    try {
      surface.data.set(path, value);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Run an action (a component's `action` property, as sent) for a gesture: an event becomes the
   * `action` to send, with its context resolved; a function call runs locally, its data writes
   * applied and its other effects returned. Never throws. */
  dispatch(action: Json, gesture: Gesture): { ok: Dispatch } | { error: ActionError } {
    const fail = (code: string, message: string) => ({
      error: { code, message, surfaceId: gesture.surfaceId },
    });
    const surface = this.surfaces.get(gesture.surfaceId);
    if (!surface) {
      return fail("INVALID_ACTION", `surface ${JSON.stringify(gesture.surfaceId)} does not exist`);
    }
    const scope = new Scope(surface.data, surface.catalogId);
    scope.path = gesture.node.dataPath;
    scope.index = gesture.node.index;
    scope.activation = gesture.activation;
    const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

    const call = isObject(action) ? own(action, "functionCall") : undefined;
    if (isObject(call)) {
      let effects: LocalEffect[];
      try {
        this.evaluator.call(call, scope);
        effects = scope.takeEffects();
      } catch (error) {
        const code =
          error instanceof EvalError && error.category === "ExecutionError"
            ? "EXECUTION_ERROR"
            : "EXPRESSION_ERROR";
        return fail(code, message(error));
      }
      const others: Effect[] = [];
      for (const effect of effects) {
        if (effect.kind === "setData") {
          try {
            surface.data.set(effect.path, effect.value);
          } catch (error) {
            return fail("EXECUTION_ERROR", message(error));
          }
        } else {
          others.push(effect);
        }
      }
      return { ok: { action: null, effects: others } };
    }

    const event = isObject(action) ? own(action, "event") : undefined;
    if (!isObject(event))
      return fail("INVALID_ACTION", "an action holds an event or a functionCall");
    const name = ownString(event, "name");
    if (name === undefined) return fail("INVALID_ACTION", "an event needs a string name");
    const context: Record<string, unknown> = {};
    const entries = own(event, "context");
    if (isObject(entries)) {
      for (const [key, value] of Object.entries(entries)) {
        try {
          put(context as JsonObject, key, this.evaluator.evaluate(value, scope));
        } catch (error) {
          return fail("EXPRESSION_ERROR", `context ${key}: ${message(error)}`);
        }
      }
    }
    let userMessage: string | undefined;
    const rawMessage = own(event, "userMessage");
    if (rawMessage !== undefined) {
      if (typeof rawMessage !== "string" && !isObject(rawMessage)) {
        return fail("INVALID_ACTION", "userMessage must be a string or a binding");
      }
      try {
        const resolved = this.evaluator.evaluate(rawMessage, scope);
        if (resolved !== null)
          userMessage = typeof resolved === "string" ? resolved : toString(resolved);
      } catch (error) {
        return fail("EXPRESSION_ERROR", `userMessage: ${message(error)}`);
      }
    }
    // Effects from resolving the context (an open, a write) never happen.
    scope.takeEffects();
    const sent: UiAction = {
      name,
      surfaceId: gesture.surfaceId,
      sourceComponentId: gesture.node.id,
      timestamp: gesture.timestamp ?? new Date().toISOString(),
      context,
    };
    if (userMessage !== undefined) sent.userMessage = userMessage;
    return { ok: { action: sent, effects: [] } };
  }
}
