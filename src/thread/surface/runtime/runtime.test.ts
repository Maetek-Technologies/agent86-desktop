// The runtime through its public API: what the renderer built on it sees, beyond what the shared
// conformance suites check. Ported from agent86-ui's `tests/runtime.rs` and its module tests.

import { expect, test } from "vitest";
import { formatCurrency, formatDate, formatNumber, toNumber } from "./format.ts";
import { BASIC_CATALOG_ID, Runtime, isValid, validationErrors } from "./index.ts";
import type { Gesture, Json, JsonObject, Node } from "./index.ts";
import { Pattern } from "./regex.ts";

function create(components: Json, dataModel: Json): Json {
  return {
    version: "1.0",
    createSurface: { surfaceId: "s", catalogId: BASIC_CATALOG_ID, components, dataModel },
  };
}

function form(): Runtime {
  const runtime = Runtime.basic();
  const problems = runtime.apply([
    create(
      [
        { id: "root", component: "Column", children: ["name", "list", "send"] },
        {
          id: "name",
          component: "TextField",
          label: "Name",
          value: { "@path": "/form/name" },
          "@checks": [
            {
              condition: { "@call": "required", args: { value: { "@path": "/form/name" } } },
              message: "Name, please.",
            },
          ],
        },
        { id: "list", component: "List", children: { path: "/items", componentId: "item" } },
        {
          id: "item",
          component: "Button",
          child: "item_label",
          action: {
            event: {
              name: "pick",
              context: {
                title: { "@path": "title" },
                n: { "@call": "@index", args: { offset: 1 } },
              },
            },
          },
        },
        {
          id: "item_label",
          component: "Text",
          text: { "@call": "formatString", args: { value: "${@index(offset: 1)}. ${title}" } },
        },
        {
          id: "send",
          component: "Button",
          child: "send_label",
          action: { event: { name: "send", context: { name: { "@path": "/form/name" } } } },
          "@checks": [
            { condition: { "@call": "required", args: { value: { "@path": "/form/name" } } } },
          ],
        },
        { id: "send_label", component: "Text", text: "Send" },
      ],
      { form: { name: "" }, items: [{ title: "Tea" }, { title: "Coffee" }] },
    ),
  ]);
  expect(problems).toEqual([]);
  return runtime;
}

function tree(runtime: Runtime, surfaceId = "s"): Node {
  const root = runtime.tree(surfaceId);
  if (!root) throw new Error(`no tree for ${surfaceId}`);
  return root;
}

/** The nodes under a property. */
function under(node: Node | undefined, property: string): Node[] {
  const nodes = node?.children.find(([name]) => name === property)?.[1];
  if (!nodes) throw new Error(`${node?.id ?? "?"} has no ${property}`);
  return nodes;
}

function gesture(node: Node, activation = true): Gesture {
  return { surfaceId: "s", node, activation, timestamp: "2026-11-22T10:00:00Z" };
}

function actionOf(runtime: Runtime, id: string): Json {
  return runtime.component("s", id)?.action ?? null;
}

test("a form: binding, input, checks, and the action a button sends", () => {
  const runtime = form();
  const [name, , send] = under(tree(runtime), "children");
  if (!name || !send) throw new Error("missing children");
  expect(name.component).toBe("TextField");
  expect(name.properties).toEqual({ label: "Name", value: "" });
  expect(runtime.bindingPath(name, "value")).toBe("/form/name");
  expect(runtime.bindingPath(name, "label")).toBeNull();
  expect(isValid(name)).toBe(false);
  expect(validationErrors(name)).toEqual(["Name, please."]);
  // The send button's check fails, so a renderer disables it; its action is not a property.
  expect(isValid(send)).toBe(false);
  expect(send.properties).not.toHaveProperty("action");

  expect(runtime.input("s", "/form/name", "Ada")).toBeNull();
  const [typed, , ready] = under(tree(runtime), "children");
  if (!typed || !ready) throw new Error("missing children");
  expect(typed.properties.value).toBe("Ada");
  expect(isValid(typed)).toBe(true);
  expect(isValid(ready)).toBe(true);

  const outcome = runtime.dispatch(actionOf(runtime, "send"), gesture(ready));
  expect(outcome).toEqual({
    ok: {
      action: {
        name: "send",
        surfaceId: "s",
        sourceComponentId: "send",
        timestamp: "2026-11-22T10:00:00Z",
        context: { name: "Ada" },
      },
      effects: [],
    },
  });
});

test("input through a primitive is refused with a message", () => {
  const runtime = form();
  expect(runtime.input("s", "/form/name/first", "A")).toMatch(/primitive/);
  expect(runtime.input("gone", "/x", 1)).toBeNull();
});

test("a list template makes one node per item, each with its data path and @index", () => {
  const runtime = form();
  const [, list] = under(tree(runtime), "children");
  const items = under(list, "children");
  expect(items.map((n) => [n.id, n.dataPath, n.index])).toEqual([
    ["item", "/items/0", 0],
    ["item", "/items/1", 1],
  ]);
  const label = under(items[1], "child")[0];
  expect(label?.properties.text).toBe("2. Coffee");

  // A gesture on a template instance sends its own context.
  const coffee = items[1];
  if (!coffee) throw new Error("no second item");
  const outcome = runtime.dispatch(actionOf(runtime, "item"), gesture(coffee));
  if (!("ok" in outcome)) throw new Error(outcome.error.message);
  expect(outcome.ok.action?.sourceComponentId).toBe("item");
  expect(outcome.ok.action?.context).toEqual({ title: "Coffee", n: 2 });

  // Bindings inside a template resolve against the item.
  runtime.apply([
    {
      version: "1.0",
      updateComponents: {
        surfaceId: "s",
        components: [{ id: "item_label", component: "Text", text: { "@path": "title" } }],
      },
    },
  ]);
  const [, relisted] = under(tree(runtime), "children");
  const relabel = under(under(relisted, "children")[0], "child")[0];
  if (!relabel) throw new Error("no label");
  expect(runtime.bindingPath(relabel, "text")).toBe("/items/0/title");
});

test("Tabs' children are resolved, and the titles stay in the property", () => {
  const runtime = Runtime.basic();
  const problems = runtime.apply([
    create(
      [
        {
          id: "root",
          component: "Tabs",
          tabs: [
            { title: "One", child: "first" },
            { title: { "@path": "/second" }, child: "second" },
          ],
        },
        { id: "first", component: "Text", text: "1" },
        { id: "second", component: "Text", text: "2" },
      ],
      { second: "Two" },
    ),
  ]);
  expect(problems).toEqual([]);
  const root = tree(runtime);
  expect(root.children.map(([property]) => property)).toEqual(["tabs"]);
  expect(under(root, "tabs").map((n) => n.id)).toEqual(["first", "second"]);
  expect((root.properties.tabs as JsonObject[])[1]?.title).toBe("Two");
});

test("a failing check makes the node invalid; a warning does not", () => {
  const runtime = Runtime.basic();
  runtime.apply([
    create(
      [
        {
          id: "root",
          component: "TextField",
          label: "Email",
          value: { "@path": "/email" },
          "@checks": [
            { condition: { "@call": "email", args: { value: { "@path": "/email" } } } },
            { condition: { "@path": "/hint" } },
          ],
        },
      ],
      {
        email: "nope",
        hint: { valid: false, message: "Use your work address.", severity: "warning" },
      },
    ),
  ]);
  const root = tree(runtime);
  expect(isValid(root)).toBe(false);
  expect(validationErrors(root)).toEqual([
    "Please enter a valid email address (e.g. user@example.com).",
  ]);
  expect(root.failures[1]).toEqual({
    valid: false,
    message: "Use your work address.",
    severity: "warning",
  });
  runtime.input("s", "/email", "ada@example.com");
  expect(isValid(tree(runtime))).toBe(true);
  expect(tree(runtime).failures).toHaveLength(1);
});

test("openUrl runs only from a real activation and comes back as an effect", () => {
  const runtime = Runtime.basic();
  runtime.apply([create([{ id: "root", component: "Text", text: "x" }], {})]);
  const link = tree(runtime);
  const action = { functionCall: { "@call": "openUrl", args: { url: " https://example.com/a " } } };
  expect(runtime.dispatch(action, gesture(link))).toEqual({
    ok: { action: null, effects: [{ kind: "openUrl", url: "https://example.com/a" }] },
  });

  const refused = runtime.dispatch(action, gesture(link, false));
  expect(refused).toMatchObject({ error: { code: "EXPRESSION_ERROR", surfaceId: "s" } });

  const script = { functionCall: { "@call": "openUrl", args: { url: "javascript:alert(1)" } } };
  expect(runtime.dispatch(script, gesture(link))).toMatchObject({
    error: { code: "EXPRESSION_ERROR" },
  });

  // From a binding, openUrl never opens anything: it needs the gesture, so the property fails.
  runtime.apply([
    create(
      [
        {
          id: "root",
          component: "Text",
          text: { "@call": "openUrl", args: { url: "https://example.com" } },
        },
      ],
      {},
    ),
  ]);
  expect(tree(runtime).properties.text).toBeNull();
  expect(tree(runtime).errors[0]).toMatch(/requires user activation/);
});

test("a template that does not parse is a node error and a problem, not a throw", () => {
  const runtime = Runtime.basic();
  const problems = runtime.apply([
    create(
      [
        { id: "root", component: "Column", children: ["bad", "good"] },
        {
          id: "bad",
          component: "Text",
          text: { "@call": "formatString", args: { value: "Hi ${/name" } },
        },
        { id: "good", component: "Text", text: { "@path": "/name" } },
      ],
      { name: "Ada" },
    ),
  ]);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatch(/^EXPRESSION_ERROR on surface s: bad: text: Unclosed interpolation/);
  // Unlike agent86's runtime, the batch is applied: agent86 already accepted it.
  const [bad, good] = under(tree(runtime), "children");
  expect(bad?.properties.text).toBeNull();
  expect(bad?.errors).toEqual(["text: Unclosed interpolation: missing '}'"]);
  expect(good?.properties.text).toBe("Ada");
});

test("a bad message is reported and skipped; the rest of the batch applies", () => {
  const runtime = Runtime.basic();
  runtime.apply([create([{ id: "root", component: "Text", text: "x" }], { name: "Ada" })]);
  const problems = runtime.apply([
    { version: "1.0", updateDataModel: { surfaceId: "s", path: "/age", value: 36 } },
    { version: "1.0", updateDataModel: { surfaceId: "s", path: "/name/first", value: "A" } },
    { version: "1.0", updateDataModel: { surfaceId: "nope", path: "/a", value: 1 } },
    "not a message",
    { version: "1.0", somethingElse: {} },
    { version: "1.0", updateDataModel: { surfaceId: "s", path: "/ok", value: true } },
  ]);
  expect(problems).toHaveLength(4);
  expect(problems[0]).toMatch(/^DATA_ERROR on surface s at \/1\/updateDataModel\/path: Cannot set/);
  expect(runtime.dataModel("s")).toEqual({ name: "Ada", age: 36, ok: true });
});

test("null deletes, components replace by id, and deleteSurface removes the surface", () => {
  const runtime = form();
  runtime.apply([
    { version: "1.0", updateDataModel: { surfaceId: "s", path: "/items", value: null } },
    {
      version: "1.0",
      updateComponents: {
        surfaceId: "s",
        components: [{ id: "send_label", component: "Text", text: "Send it" }],
      },
    },
  ]);
  expect(runtime.dataModel("s")).toEqual({ form: { name: "" } });
  const [, list, send] = under(tree(runtime), "children");
  expect(under(list, "children")).toEqual([]);
  expect(under(send, "child")[0]?.properties.text).toBe("Send it");
  expect(runtime.surfaceIds()).toEqual(["s"]);
  runtime.apply([{ version: "1.0", deleteSurface: { surfaceId: "s" } }]);
  expect(runtime.hasSurface("s")).toBe(false);
  expect(runtime.tree("s")).toBeNull();
});

test("a referenced component not yet sent is a placeholder; a cycle stops", () => {
  const runtime = Runtime.basic();
  const problems = runtime.apply([
    create(
      [
        { id: "root", component: "Column", children: ["later", "loop"] },
        { id: "loop", component: "Card", child: "loop" },
      ],
      {},
    ),
  ]);
  const [later, loop] = under(tree(runtime), "children");
  expect(later).toMatchObject({ id: "later", component: "", placeholder: true, errors: [] });
  const inner = under(loop, "child")[0];
  expect(inner?.placeholder).toBe(true);
  expect(inner?.errors[0]).toMatch(/cycle/);
  expect(problems).toHaveLength(1);
});

test("legacy envelope keys are read as their @ spellings", () => {
  const runtime = Runtime.basic();
  runtime.apply([
    create(
      [
        {
          id: "root",
          component: "Text",
          text: "x",
          accessibility: { label: { "@path": "/label" } },
          checks: [{ condition: false, message: "No." }],
        },
      ],
      { label: "Greeting" },
    ),
  ]);
  const root = tree(runtime);
  expect(root.accessibility).toEqual({ label: "Greeting" });
  expect(root.properties).toEqual({ text: "x" });
  expect(validationErrors(root)).toEqual(["No."]);
});

test("a local function's data writes apply when the action runs, and its failure is reported", () => {
  const runtime = Runtime.basic();
  runtime.register(
    "bump",
    { returnType: "void", callers: "rendererOnly", requiresUserActivation: false },
    (_args, scope) => {
      const current = scope.get("/count");
      scope.set("/count", (typeof current === "number" ? current : 0) + 1);
      return null;
    },
  );
  runtime.apply([create([{ id: "root", component: "Text", text: "x" }], { count: 1 })]);
  const action = { functionCall: { "@call": "bump" } };
  expect(runtime.dispatch(action, gesture(tree(runtime)))).toEqual({
    ok: { action: null, effects: [] },
  });
  expect(runtime.dataModel("s")).toEqual({ count: 2 });
  expect(runtime.dispatch({ nope: true }, gesture(tree(runtime)))).toMatchObject({
    error: { code: "INVALID_ACTION" },
  });
  const missing = { ...gesture(tree(runtime)), surfaceId: "gone" };
  expect(runtime.dispatch(action, missing)).toMatchObject({ error: { code: "INVALID_ACTION" } });
});

test("an event's userMessage is resolved", () => {
  const runtime = form();
  runtime.input("s", "/form/name", "Ada");
  const action = {
    event: {
      name: "hi",
      userMessage: { "@call": "formatString", args: { value: "Hello, ${/form/name}" } },
    },
  };
  const outcome = runtime.dispatch(action, gesture(tree(runtime)));
  if (!("ok" in outcome)) throw new Error(outcome.error.message);
  expect(outcome.ok.action?.userMessage).toBe("Hello, Ada");
  const fresh = runtime.dispatch(
    { event: { name: "now" } },
    { ...gesture(tree(runtime)), timestamp: undefined },
  );
  if (!("ok" in fresh)) throw new Error(fresh.error.message);
  expect(Date.parse(fresh.ok.action?.timestamp ?? "")).not.toBeNaN();
  expect(fresh.ok.action).not.toHaveProperty("userMessage");
});

// From `format.rs`'s and `regex.rs`'s module tests.

test("number formats match Intl en-US", () => {
  expect(formatNumber(1234.567, 2, true)).toBe("1,234.57");
  expect(formatNumber(1234.567, 0, false)).toBe("1235");
  expect(formatNumber(1234.5678, null, true)).toBe("1,234.568");
  expect(formatNumber(1.005, 2, true)).toBe("1.01");
  expect(formatNumber(0.125, 2, true)).toBe("0.13");
  expect(formatNumber(-0.001, 2, true)).toBe("0.00");
  expect(formatNumber(-1234.5, 1, true)).toBe("-1,234.5");
  expect(formatNumber(999.999, 2, true)).toBe("1,000.00");
  expect(formatNumber(1e21, 0, true)).toBe("1,000,000,000,000,000,000,000");
  expect(formatCurrency(99.99, "usd", 2, true)).toBe("$99.99");
  expect(formatCurrency(1234.5, "USD", null, true)).toBe("$1,234.50");
  expect(formatCurrency(-5, "EUR", null, true)).toBe("-€5.00");
  expect(formatCurrency(5, "CHF", null, true)).toBe("CHF\u00a05.00");
});

test("dates format as written", () => {
  expect(formatDate("2026-08-26T12:00:00Z", "yyyy-MM-dd")).toBe("2026-08-26");
  expect(formatDate("2026-09-04T23:30:00-05:00", "yyyy-MM-dd HH:mm")).toBe("2026-09-04 23:30");
  expect(formatDate("2026-01-16T14:30:00Z", "EEEE, d MMMM")).toBe("Friday, 16 January");
  expect(formatDate("2026-01-16T14:30:00Z", "h:mm a")).toBe("2:30 PM");
  expect(formatDate("2026-01-16T00:05:00Z", "hh:mm a, MMM dd, yy")).toBe("12:05 AM, Jan 16, 26");
  expect(formatDate("2026-09-04T23:30:00-05:00", "ISO")).toBe("2026-09-05T04:30:00.000Z");
  expect(formatDate("2024-02-29", "E d")).toBe("Thu 29");
  expect(formatDate("2026-02-30", "yyyy-MM-dd")).toBe("");
  expect(formatDate("not a date", "yyyy")).toBe("");
});

test("numbers read as JavaScript reads them", () => {
  expect(toNumber("42.5")).toBe(42.5);
  expect(toNumber(" 7 ")).toBe(7);
  expect(toNumber("not_a_number")).toBeNaN();
  expect(toNumber(null)).toBe(0);
  expect(toNumber(true)).toBe(1);
  expect(toNumber({})).toBeNaN();
  expect(toNumber("0x1F")).toBe(31);
});

const refusal = (pattern: string) => {
  const compiled = Pattern.compile(pattern);
  return compiled instanceof Pattern ? null : compiled;
};
const matches = (pattern: string, value: string) => {
  const compiled = Pattern.compile(pattern);
  if (!(compiled instanceof Pattern)) throw new Error(`${pattern} refused: ${compiled}`);
  return compiled.test(value);
};

test("regex: the specification's examples", () => {
  for (const accepted of ["^[a-z]+@[a-z]+\\.com$", "^(?=.*\\d).{8,}$", "\\w+\\s+\\w+"]) {
    expect(refusal(accepted)).toBeNull();
  }
  expect(refusal("(a+)+$")).toBe("NESTED_QUANTIFIER");
  expect(refusal("(a|ab)*c")).toBe("OVERLAPPING_ALTERNATION");
  expect(refusal("\\d+\\s*\\d+")).toBe("ADJACENT_OVERLAP");
  expect(refusal("(\\w)\\1")).toBe("UNSUPPORTED_SYNTAX");
  expect(refusal("a".repeat(257))).toBe("PATTERN_TOO_LONG");
});

test("regex: Unicode mode refuses what legacy mode allows", () => {
  for (const refused of [
    "\\a",
    "a{",
    "]",
    "}",
    "\\-",
    "[a-\\d]",
    "\\c1",
    "\\01",
    "(?i)a",
    "(?<n>a)",
    "(?<=a)b",
    "\\p{L}",
    "\\k<n>",
  ]) {
    expect(refusal(refused), refused).toBe("UNSUPPORTED_SYNTAX");
  }
  expect(refusal("[\\-a]")).toBeNull();
  expect(refusal("[\\b]")).toBeNull();
  expect(matches("^$", "")).toBe(true);
});

test("regex: matching follows the dialect", () => {
  expect(matches("abc", "xxabcxx")).toBe(true);
  expect(matches("^abc$", "abc\n")).toBe(false);
  expect(matches("^\\d+$", "١٢٣")).toBe(false);
  expect(matches("^\\w+$", "café")).toBe(false);
  expect(matches("^a.b$", "a\nb")).toBe(false);
  expect(matches("\\b", "é")).toBe(false);
  expect(matches("^.$", "😀")).toBe(true);
  expect(matches("^\\u{1F600}+$", "😀😀")).toBe(true);
  expect(matches("^😀$", "😀")).toBe(true);
  expect(matches("[^]", "x")).toBe(true);
  expect(matches("[]", "x")).toBe(false);
  expect(matches("a{2}", "xaa")).toBe(true);
  expect(matches("^a{2}$", "aaa")).toBe(false);
  expect(matches("a", "a".repeat(4097))).toBe(false);
});
