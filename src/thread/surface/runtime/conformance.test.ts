// The A2UI specification's shared conformance suites for the runtime, run against this port, under
// the rules of agent86-ui's harness (`tests/runtime_conformance.rs`):
//
// - Each case names an `action`; a handler per action drives the runtime and checks the
//   expectation. An unknown action, step op, or key fails the case (the upstream harness guide's
//   strict rule).
// - The same version filters: a suite whose behavior does not change between protocol versions
//   runs every case; the others run 1.0 (or version-less) cases only.
// - The only escape is UNSUPPORTED, which records why a case is skipped; an entry that matches no
//   case fails the run, so the list cannot go stale.

import { describe, expect, test } from "vitest";
import { BASIC_CATALOG_ID, Catalog } from "./catalog.ts";
import { DataError, DataModel, resolve } from "./data.ts";
import { ExpressionError, parse, partToJson } from "./expr.ts";
import { toNumber, toString } from "./format.ts";
import { Evaluator, Scope, asEvalError } from "./functions.ts";
import { equal, isObject, own, ownString } from "./json.ts";
import {
  Runtime,
  isValid,
  validationErrors,
  validationResult,
  walk,
  type Problem,
} from "./surface.ts";
import type { Json, JsonObject, Node } from "./types.ts";

const SUITES = import.meta.glob<Json>("./fixtures/conformance/*.json", {
  eager: true,
  import: "default",
});
const CATALOGS = import.meta.glob<Json>("./fixtures/catalogs/*.json", {
  eager: true,
  import: "default",
});

function suite(name: string): JsonObject[] {
  const cases = SUITES[`./fixtures/conformance/${name}.json`];
  if (!Array.isArray(cases) || cases.length === 0) throw new Error(`${name} holds no cases`);
  return cases.filter(isObject);
}

/** A case's handler fails by throwing this, with what went wrong. */
class CaseFailure extends Error {}

const failure = (message: string) => new CaseFailure(message);

/** Fail on any key outside `allowed` (plus the metadata every case may carry). */
function knownKeys(object: Json | undefined, allowed: string[], at: string): void {
  const meta = ["name", "description", "features"];
  if (!isObject(object)) return;
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key) && !meta.includes(key)) {
      throw failure(`Unknown key '${key}' in ${at}`);
    }
  }
}

function expectError(object: JsonObject): Json | undefined {
  return own(object, "expect_error") ?? own(object, "expectError");
}

const str = (value: Json | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Check an error against `expect_error`: the category the handler mapped it to, and `message` as
 * a regular expression. */
function checkError(expected: Json, category: string, message: string): void {
  const want = isObject(expected) ? (ownString(expected, "category") ?? "") : "";
  if (want !== category) throw failure(`expected a ${want}, got a ${category}: ${message}`);
  const pattern = isObject(expected) ? ownString(expected, "message") : undefined;
  if (pattern !== undefined && !new RegExp(pattern).test(message)) {
    throw failure(`error message ${JSON.stringify(message)} does not match ${pattern}`);
  }
}

function caseVersion(c: JsonObject): string | undefined {
  const catalog = own(c, "catalog");
  return (
    str(own(c, "protocolVersion")) ??
    (isObject(catalog) ? str(own(catalog, "protocolVersion")) : undefined)
  );
}

/** Whether a case declares a protocol version before 1.0. */
const pre10 = (c: JsonObject) => caseVersion(c)?.startsWith("v") ?? false;

function typeName(value: Json | undefined): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  if (typeof value === "object") return "object";
  return typeof value;
}

/** Which cases a suite runs. `all`: every case (the behavior does not change between protocol
 * versions: the data model, paths, the template grammar); `from1_0`: 1.0 or version-less cases
 * only; `only1_0`: cases marked 1.0 only (the version-less ones use 0.9's binding syntax). */
type Versions = "all" | "from1_0" | "only1_0";

type Handler = (c: JsonObject) => void;

/** What each suite ran, for the summary at the end. */
const tally: Record<string, { ran: number; unsupported: number; total: number }> = {};

function run(
  name: string,
  versions: Versions,
  actions: string[],
  unsupported: [name: string, reason: string][],
  handle: Handler,
): void {
  describe(name, () => {
    const cases = suite(name);
    const counts = { ran: 0, unsupported: 0, total: cases.length };
    tally[name] = counts;
    const matched = new Set<string>();
    for (const c of cases) {
      const caseName = ownString(c, "name") ?? "?";
      const action = ownString(c, "action") ?? "?";
      const skip = unsupported.find(([skipped]) => skipped === caseName);
      if (skip) {
        matched.add(caseName);
        counts.unsupported++;
        test.skip(`${caseName} (UNSUPPORTED: ${skip[1]})`, () => {});
        continue;
      }
      if (
        (versions === "from1_0" && pre10(c)) ||
        (versions === "only1_0" && caseVersion(c) !== "1.0")
      ) {
        // This implementation reads A2UI 1.0 only.
        continue;
      }
      counts.ran++;
      test(caseName, () => {
        if (!actions.includes(action)) throw failure(`Unknown action '${action}'`);
        handle(c);
      });
    }
    test("every UNSUPPORTED entry matches a case", () => {
      const stale = unsupported.map(([skipped]) => skipped).filter((s) => !matched.has(s));
      expect(stale).toEqual([]);
      expect(counts.ran).toBeGreaterThan(0);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// The data model, paths, and the template grammar.

function dataModelCase(c: JsonObject): void {
  knownKeys(c, ["action", "catalog", "initial", "watch", "steps"], "case");
  const initial = own(c, "initial");
  const model = new DataModel(initial === undefined ? {} : structuredClone(initial));
  const watched: [number, string][] = [];
  const watch = own(c, "watch");
  for (const path of Array.isArray(watch) ? watch : []) {
    watched.push([model.watch(String(path)), String(path)]);
  }
  // What the last `set` was given, so `mutate_input` can change it afterwards.
  let lastInput: Json = null;
  const steps = own(c, "steps");
  (Array.isArray(steps) ? steps : []).forEach((rawStep, number) => {
    const step = isObject(rawStep) ? rawStep : {};
    const at = `step ${number}`;
    knownKeys(
      step,
      [
        "op",
        "path",
        "value",
        "expect",
        "expect_absent",
        "expect_type",
        "expect_notified",
        "expect_values",
        "expect_error",
      ],
      at,
    );
    const path = ownString(step, "path") ?? "/";
    const op = ownString(step, "op");
    let notified: number[] = [];
    let got: Json | undefined;
    let error: DataError | null = null;
    try {
      switch (op) {
        case "get":
          got = model.get(path);
          break;
        case "set":
          lastInput = structuredClone(own(step, "value") ?? null);
          notified = model.set(path, lastInput);
          break;
        case "delete":
          notified = model.delete(path);
          break;
        case "dispose":
          model.dispose();
          break;
        case "mutate_input":
          // Change what the caller passed to `set`: the model holds its own copy, so nothing in
          // it changes and no one is notified.
          if (typeof lastInput === "object" && lastInput !== null) {
            new DataModel(lastInput).set(path, own(step, "value") ?? null);
          }
          break;
        default:
          throw failure(`Unknown op '${String(op)}' at ${at}`);
      }
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      error = e;
    }
    const expected = expectError(step);
    if (error) {
      if (expected === undefined) throw failure(`${at}: unexpected error: ${error.message}`);
      checkError(expected, "DataError", error.message);
      return;
    }
    if (expected !== undefined) {
      throw failure(`${at}: expected ${JSON.stringify(expected)}, got success`);
    }
    const want = own(step, "expect");
    if (want !== undefined && !equal(got, want)) {
      throw failure(
        `${at}: get ${path} gave ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
      );
    }
    if (own(step, "expect_absent") === true && got !== undefined) {
      throw failure(`${at}: get ${path} gave ${JSON.stringify(got)}, expected absent`);
    }
    const wantType = ownString(step, "expect_type");
    if (wantType !== undefined && typeName(got) !== wantType) {
      throw failure(`${at}: ${path} is ${typeName(got)}, expected ${wantType}`);
    }
    const wantNotified = own(step, "expect_notified");
    if (Array.isArray(wantNotified)) {
      const found = watched.filter(([id]) => notified.includes(id)).map(([, p]) => p);
      const sorted = (list: string[]) => [...list].sort();
      const wanted = wantNotified.filter((p): p is string => typeof p === "string");
      if (!equal(sorted(found), sorted(wanted))) {
        throw failure(
          `${at}: notified ${JSON.stringify(found)}, expected ${JSON.stringify(wanted)}`,
        );
      }
    }
    const values = own(step, "expect_values");
    if (isObject(values)) {
      for (const [watchPath, value] of Object.entries(values)) {
        const found = model.get(watchPath);
        if (!equal(found, value)) {
          throw failure(
            `${at}: ${watchPath} is ${JSON.stringify(found)}, expected ${JSON.stringify(value)}`,
          );
        }
      }
    }
  });
}

run("data_model", "all", ["data_model"], [], dataModelCase);

run("data_context", "all", ["resolve_path"], [], (c) => {
  knownKeys(c, ["action", "catalog", "args", "expect"], "case");
  const args = own(c, "args");
  knownKeys(args, ["path", "contextPath"], "args");
  const object = isObject(args) ? args : {};
  const got = resolve(ownString(object, "contextPath") ?? "/", ownString(object, "path") ?? "");
  expect(got).toBe(own(c, "expect"));
});

/** Join adjacent text literals and drop empty ones, as the harness guide says to before
 * comparing: a template fixes the values, not how text is split. */
function joined(parts: Json[]): Json[] {
  const out: Json[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      if (part === "") continue;
      const previous = out.at(-1);
      if (typeof previous === "string") {
        out[out.length - 1] = previous + part;
        continue;
      }
    }
    out.push(part);
  }
  return out;
}

run("expressions", "all", ["parse_expression_template", "validate"], [], (c) => {
  if (own(c, "action") === "validate") return processCase(c);
  knownKeys(c, ["action", "catalog", "input", "expect", "expect_error"], "case");
  const expected = expectError(c);
  let got: Json[];
  try {
    got = parse(ownString(c, "input") ?? "").map(partToJson);
  } catch (error) {
    if (!(error instanceof ExpressionError)) throw error;
    if (expected === undefined) throw failure(`unexpected error: ${error.message}`);
    checkError(expected, "ParseError", error.message);
    return;
  }
  if (expected !== undefined) {
    throw failure(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
  }
  const want = own(c, "expect");
  expect(joined(got)).toEqual(joined(Array.isArray(want) ? want : []));
});

// ---------------------------------------------------------------------------------------------
// Functions.

/** A catalog a case names by its repository path: the basic catalog is the app's own; a test
 * catalog is read from the fixtures; a catalog for an earlier protocol version is not available
 * to a 1.0 surface, so null. */
function catalogAt(path: string): Catalog | null {
  if (path === "catalogs/basic/v1/catalog.json") return Catalog.basic();
  if (path.startsWith("catalogs/basic/v0_")) return null;
  const file = path.split("/").at(-1) ?? "";
  const document = CATALOGS[`./fixtures/catalogs/${file}`];
  if (!isObject(document)) throw new Error(`no catalog fixture for ${path}`);
  return new Catalog(document);
}

function evaluateFunctionCase(c: JsonObject): void {
  if (own(c, "action") === "validate") return processCase(c);
  knownKeys(
    c,
    [
      "action",
      "catalog",
      "protocolVersion",
      "function",
      "args",
      "expect",
      "expectError",
      "surface",
      "catalogId",
      "catalogPaths",
      "dataModel",
    ],
    "case",
  );
  const initial = own(c, "dataModel");
  const data = new DataModel(isObject(initial) ? structuredClone(initial) : {});
  const call: JsonObject = { "@call": ownString(c, "function") ?? "", args: own(c, "args") ?? {} };
  let evaluator: Evaluator;
  let scope: Scope;
  const surface = own(c, "surface");
  if (surface !== undefined) {
    // On a surface: its catalogs, its default, and the call's own catalogId.
    knownKeys(surface, ["catalogId"], "surface");
    const paths = own(c, "catalogPaths");
    const catalogs = (Array.isArray(paths) ? paths : [])
      .map((p) => catalogAt(String(p)))
      .filter((catalog): catalog is Catalog => catalog !== null);
    const catalogId = ownString(c, "catalogId");
    if (catalogId !== undefined) call.catalogId = catalogId;
    evaluator = new Evaluator(catalogs);
    scope = new Scope(data, isObject(surface) ? (ownString(surface, "catalogId") ?? null) : null);
  } else {
    // Directly, in the basic catalog, from a gesture (as the reference harnesses call functions
    // directly).
    evaluator = new Evaluator([Catalog.basic()]);
    scope = new Scope(data, BASIC_CATALOG_ID);
    scope.activation = true;
  }
  const expected = expectError(c);
  let value: Json;
  try {
    value = evaluator.call(call, scope);
  } catch (error) {
    const e = asEvalError(error);
    if (expected === undefined) throw failure(`unexpected ${e.category}: ${e.message}`);
    checkError(expected, e.category, e.message);
    return;
  }
  if (expected !== undefined) {
    throw failure(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
  }
  const want = own(c, "expect") ?? null;
  let same: boolean;
  if (typeof want === "boolean" && isObject(value)) {
    // A validation result against a boolean: the version-less cases were written for 0.9, where
    // validators returned booleans; in 1.0 they return results, compared by `valid`.
    same = own(value, "valid") === want;
  } else if (
    isObject(want) &&
    isObject(value) &&
    Object.keys(want).length === 1 &&
    Object.hasOwn(want, "valid")
  ) {
    // `{"valid": x}` alone checks only `valid`.
    same = own(value, "valid") === own(want, "valid");
  } else {
    same = equal(want, value);
  }
  if (!same) throw failure(`got ${JSON.stringify(value)}, expected ${JSON.stringify(want)}`);
}

run(
  "functions",
  "from1_0",
  ["evaluate_function", "validate"],
  [
    [
      "test_function_invalid_argument_schema_error",
      "a function argument of the wrong type is a schema error, which only agent86's validator finds; agent86 refuses the batch before the app sees it, and the app keeps no validator",
    ],
  ],
  evaluateFunctionCase,
);

// ---------------------------------------------------------------------------------------------
// Batches through the runtime.

/** An inline test catalog: the basic catalog under the case's id when it lists no components
 * (agent86's harness also completes a listed catalog into a valid one; this runtime does not
 * check catalogs, so it takes the components as they are). */
function inlineCatalog(spec: JsonObject): Catalog {
  const id = ownString(spec, "catalogId") ?? "basic";
  if (!isObject(own(spec, "components"))) return Catalog.basic().withId(id);
  return new Catalog({
    protocolVersion: "1.0",
    catalogId: id,
    components: own(spec, "components") ?? {},
    functions: own(spec, "functions") ?? {},
  });
}

function runtimeFor(c: JsonObject): Runtime {
  const spec = own(c, "catalog");
  const catalog =
    isObject(spec) && Object.hasOwn(spec, "components")
      ? inlineCatalog(spec)
      : Catalog.basic().withId("basic");
  return new Runtime([catalog]);
}

/** A problem's category, as the shared suites name it. */
const category = (problem: Problem) =>
  problem.code === "DATA_ERROR" ? "DataError" : "ValidationError";

function reportMatches(expected: Json, problems: Problem[]): void {
  const want = isObject(expected) ? (ownString(expected, "category") ?? "") : "";
  const pattern = isObject(expected) ? ownString(expected, "message") : undefined;
  const ok = problems.some(
    (p) => category(p) === want && (pattern === undefined || new RegExp(pattern).test(p.message)),
  );
  if (!ok) {
    throw failure(
      `expected a ${want} ${String(pattern)}, got ${JSON.stringify(problems.map((p) => [category(p), p.message]))}`,
    );
  }
}

/** Scalars compare as strings (a suite writes `5` or `'5'`); structured values structurally, as
 * the reference harness does. */
function propertyMatches(actual: Json | undefined, expected: Json): boolean {
  const structured = (v: Json | undefined) => typeof v === "object" && v !== null;
  if (actual === undefined) return expected === null;
  if (structured(actual) || structured(expected)) return equal(actual, expected);
  return toString(actual) === toString(expected);
}

/** Every node of a surface by the names the suites use: its id, and `<id>_<n>` for an instance a
 * template made for item `n`. */
function nodesByName(runtime: Runtime, surface: string): Map<string, Node> {
  const map = new Map<string, Node>();
  const tree = runtime.tree(surface);
  if (tree) {
    for (const node of walk(tree)) {
      if (node.index !== null) {
        const ordinal = node.dataPath.split("/").at(-1) ?? "";
        if (/^[0-9]+$/.test(ordinal)) map.set(`${node.id}_${ordinal}`, node);
      }
      if (!map.has(node.id)) map.set(node.id, node);
    }
  }
  // Components not reachable from root resolve at the root context.
  for (const component of runtime.components(surface)) {
    const id = ownString(component, "id") ?? "";
    if (map.has(id)) continue;
    const node = runtime.node(surface, id);
    if (node) map.set(id, node);
  }
  return map;
}

function checkNode(node: Node, raw: JsonObject | undefined, expected: Json, at: string): void {
  if (!isObject(expected)) return;
  for (const [key, want] of Object.entries(expected)) {
    let got: Json | undefined;
    if (key === "id") got = node.id;
    else if (key === "component") got = node.component;
    // Envelope keys stay on the component as sent.
    else if (key === "@metadata") got = raw === undefined ? undefined : own(raw, key);
    else {
      got = own(node.properties, key);
      if (got === undefined) {
        // A property holding only children is in the node's children.
        const children = node.children.find(([name]) => name === key);
        if (children) {
          const ids = children[1].map((n) => n.id);
          got = Array.isArray(want) ? ids : (ids[0] ?? null);
        }
      }
    }
    if (!propertyMatches(got, want)) {
      throw failure(`${at}.${key} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    }
  }
}

function checkSurfaces(runtime: Runtime, expected: Json): void {
  const surfaces = isObject(expected) ? own(expected, "surfaces") : undefined;
  for (const [surface, want] of Object.entries(isObject(surfaces) ? surfaces : {})) {
    knownKeys(
      want,
      [
        "components",
        "dataModel",
        "exists",
        "isValid",
        "validationErrors",
        "validationResults",
        "validationResult",
      ],
      "expect.surfaces",
    );
    if (!isObject(want)) continue;
    const nodes = nodesByName(runtime, surface);
    const nodeFor = (id: string) => {
      const node = nodes.get(id);
      if (!node) throw failure(`${surface}: no component ${id}`);
      return node;
    };
    const components = own(want, "components");
    if (isObject(components)) {
      for (const [id, component] of Object.entries(components)) {
        checkNode(nodeFor(id), runtime.component(surface, id), component, `${surface}.${id}`);
      }
    } else if (Array.isArray(components)) {
      const count = runtime.components(surface).length;
      if (count !== components.length) {
        throw failure(`${surface}: ${count} components, expected ${components.length}`);
      }
      for (const component of components) {
        const id = isObject(component) ? (ownString(component, "id") ?? "") : "";
        checkNode(nodeFor(id), runtime.component(surface, id), component, `${surface}.${id}`);
      }
    }
    const model = own(want, "dataModel");
    if (model !== undefined && !equal(runtime.dataModel(surface), model)) {
      throw failure(
        `${surface}: data model ${JSON.stringify(runtime.dataModel(surface))}, expected ${JSON.stringify(model)}`,
      );
    }
    const perNode = (field: string, get: (node: Node) => Json) => {
      const entries = own(want, field);
      for (const [id, expectedValue] of Object.entries(isObject(entries) ? entries : {})) {
        const got = get(nodeFor(id));
        const same =
          field === "validationResult" && isObject(expectedValue) && isObject(got)
            ? Object.entries(expectedValue).every(([k, v]) => equal(own(got, k), v))
            : equal(expectedValue, got);
        if (!same) {
          throw failure(
            `${surface}.${id}.${field} is ${JSON.stringify(got)}, expected ${JSON.stringify(expectedValue)}`,
          );
        }
      }
    };
    perNode("isValid", (node) => isValid(node));
    perNode("validationErrors", (node) => validationErrors(node));
    perNode("validationResults", (node) => node.failures);
    perNode("validationResult", (node) => validationResult(node));
  }
}

function messagesOf(value: Json | undefined): Json[] {
  if (Array.isArray(value)) return value;
  if (isObject(value)) {
    const messages = own(value, "messages");
    if (messages !== undefined) return Array.isArray(messages) ? messages : [];
    return [value];
  }
  return [];
}

function processCase(c: JsonObject): void {
  knownKeys(
    c,
    ["action", "catalog", "steps", "payload", "messages", "expect", "expectError", "expect_error"],
    "case",
  );
  const runtime = runtimeFor(c);
  const rawSteps = own(c, "steps");
  const steps: JsonObject[] = Array.isArray(rawSteps)
    ? rawSteps.filter(isObject)
    : [{ payload: own(c, "payload") ?? own(c, "messages") ?? [] }];
  const last = steps.length - 1;
  steps.forEach((step, number) => {
    knownKeys(step, ["payload", "messages", "expect", "expectError", "expect_error"], "step");
    const messages = messagesOf(
      structuredClone(own(step, "payload") ?? own(step, "messages") ?? []),
    );
    const problems = runtime.applyReport(messages);
    // A case-level expectError belongs to the last step.
    const expected = expectError(step) ?? (number === last ? expectError(c) : undefined);
    if (expected !== undefined) {
      reportMatches(expected, problems);
      return;
    }
    if (problems.length > 0) {
      throw failure(
        `step ${number}: unexpected errors ${JSON.stringify(problems.map((p) => [category(p), p.message]))}`,
      );
    }
    const want = own(step, "expect");
    if (want !== undefined && want !== null) checkSurfaces(runtime, want);
  });
  const want = own(c, "expect");
  if (want !== undefined && want !== null) checkSurfaces(runtime, want);
}

const PROCESSOR = ["validate", "process_messages"];

run("index_function", "from1_0", PROCESSOR, [], processCase);
run("validation_result", "from1_0", PROCESSOR, [], processCase);
run("data_deletion", "from1_0", PROCESSOR, [], processCase);
run("data_model_pointers", "from1_0", PROCESSOR, [], processCase);
run("reserved_keys", "from1_0", PROCESSOR, [], processCase);

// ---------------------------------------------------------------------------------------------
// Actions.

/** The local functions the reference harness registers for the action cases: `incrementCounter`
 * adds `step` (default 1) to the number at `path` (default `/counter`); `failingAction` always
 * fails. */
function actionRuntime(): Runtime {
  const runtime = new Runtime([Catalog.basic().withId("basic")]);
  const def = {
    returnType: "void",
    callers: "rendererOnly",
    requiresUserActivation: false,
  } as const;
  runtime.register("incrementCounter", def, (args, scope) => {
    const path = ownString(args, "path") ?? "/counter";
    const stepArg = own(args, "step");
    const step = typeof stepArg === "number" ? stepArg : 1;
    const current = scope.get(path);
    scope.set(path, (current === undefined ? 0 : toNumber(current)) + step);
    return null;
  });
  runtime.register("failingAction", def, () => {
    throw new Error("Action function failed");
  });
  return runtime;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function dispatchCase(c: JsonObject): void {
  knownKeys(
    c,
    [
      "action",
      "protocolVersion",
      "actionPayload",
      "dataModel",
      "scope",
      "surfaceId",
      "sourceComponentId",
      "userActivation",
      "metadata",
      "expectDispatched",
      "expectDataModel",
      "expectError",
    ],
    "case",
  );
  const runtime = actionRuntime();
  const surface = ownString(c, "surfaceId") ?? "main";
  const problems = runtime.apply([
    {
      version: "1.0",
      createSurface: {
        surfaceId: surface,
        catalogId: "basic",
        dataModel: structuredClone(own(c, "dataModel") ?? {}),
      },
    },
  ]);
  expect(problems).toEqual([]);
  const scope = ownString(c, "scope") ?? "/";
  const last = scope.split("/").at(-1) ?? "";
  const node: Node = {
    id: ownString(c, "sourceComponentId") ?? "button",
    component: "Button",
    dataPath: scope,
    index: /^[0-9]+$/.test(last) ? Number(last) : null,
    properties: {},
    accessibility: null,
    failures: [],
    errors: [],
    children: [],
    placeholder: false,
  };
  const outcome = runtime.dispatch(own(c, "actionPayload") ?? null, {
    surfaceId: surface,
    node,
    activation: own(c, "userActivation") !== false,
    timestamp: "2026-11-22T10:00:00Z",
  });
  const expected = own(c, "expectError");
  if ("error" in outcome) {
    const error = outcome.error;
    if (!isObject(expected)) throw failure(`unexpected error ${error.code}: ${error.message}`);
    knownKeys(expected, ["code", "surfaceId", "message", "category"], "expectError");
    const code = ownString(expected, "code");
    if (code !== undefined && error.code !== code) {
      throw failure(`error code ${error.code}, expected ${code}`);
    }
    const wantCategory = ownString(expected, "category");
    if (wantCategory !== undefined) {
      const mapped = error.code === "VALIDATION_FAILED" ? "ValidationError" : "?";
      if (mapped !== wantCategory) throw failure(`error ${error.code} is not a ${wantCategory}`);
    }
    const id = ownString(expected, "surfaceId");
    if (id !== undefined && error.surfaceId !== id) {
      throw failure(`error on ${error.surfaceId}, expected ${id}`);
    }
    const message = ownString(expected, "message");
    if (message !== undefined && !error.message.includes(message)) {
      throw failure(`error ${JSON.stringify(error.message)} does not mention ${message}`);
    }
  } else {
    if (expected !== undefined) {
      throw failure(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(outcome.ok)}`);
    }
    const sent = outcome.ok.action as unknown as JsonObject | null;
    const want = own(c, "expectDispatched");
    if (want === null && sent !== null)
      throw failure(`expected nothing sent, got ${JSON.stringify(sent)}`);
    if (isObject(want)) {
      if (sent === null) throw failure(`expected ${JSON.stringify(want)}, nothing sent`);
      for (const [key, value] of Object.entries(want)) {
        if (key === "timestampIso8601") {
          const timestamp = own(sent, "timestamp");
          if (typeof timestamp !== "string" || !RFC3339.test(timestamp)) {
            throw failure(`timestamp ${String(timestamp)} is not ISO 8601`);
          }
          continue;
        }
        const got = own(sent, key) ?? null;
        if (!equal(got, value)) {
          throw failure(
            `dispatched ${key} is ${JSON.stringify(got)}, expected ${JSON.stringify(value)}`,
          );
        }
      }
    }
  }
  const model = own(c, "expectDataModel");
  if (model !== undefined && !equal(runtime.dataModel(surface), model)) {
    throw failure(
      `data model ${JSON.stringify(runtime.dataModel(surface))}, expected ${JSON.stringify(model)}`,
    );
  }
}

const NO_METADATA =
  "renderer metadata on an action (`action.metadata`) is not part of the app's protocol: the UiAction agent86 accepts (generated from its Rust type) has no metadata field, and a Gesture carries none";

run(
  "actions",
  "only1_0",
  ["dispatch_action"],
  [
    ["test_action_event_with_dispatch_metadata", NO_METADATA],
    ["test_action_event_dispatch_metadata_invalid_uax31_key_error", NO_METADATA],
  ],
  dispatchCase,
);

// ---------------------------------------------------------------------------------------------

test("the suites run what agent86's harness runs", () => {
  // ran + unsupported per suite; agent86-ui runs 316 of these 329 cases (the version filters
  // leave out 12, and it skips 1).
  expect(tally).toEqual({
    data_model: { ran: 52, unsupported: 0, total: 52 },
    data_context: { ran: 11, unsupported: 0, total: 11 },
    expressions: { ran: 98, unsupported: 0, total: 98 },
    functions: { ran: 109, unsupported: 1, total: 116 },
    index_function: { ran: 4, unsupported: 0, total: 4 },
    validation_result: { ran: 6, unsupported: 0, total: 6 },
    data_deletion: { ran: 7, unsupported: 0, total: 7 },
    data_model_pointers: { ran: 7, unsupported: 0, total: 7 },
    reserved_keys: { ran: 10, unsupported: 0, total: 10 },
    actions: { ran: 9, unsupported: 2, total: 18 },
  });
});
