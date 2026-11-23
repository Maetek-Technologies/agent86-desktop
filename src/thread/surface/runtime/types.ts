// The renderer's headless runtime for agent86UI (agent86's implementation of Google's A2UI 1.0):
// the shapes the widgets draw from. The runtime applies the agent's messages, resolves every
// binding, function call, template, and check, writes user input back, and builds the `action` a
// button sends. It draws nothing. It follows agent86-ui's `runtime` module (agent86-core 1.2.0)
// and is checked against the same A2UI conformance suites (./fixtures).

import type { UiAction } from "../../../desktop-client/events.ts";

/** A JSON value. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** One component instance, resolved for drawing. A list template gives one per item. */
export interface Node {
  /** The component's id. */
  id: string;
  /** The component type (`""` for a placeholder). */
  component: string;
  /** The data context: `/` at the root, the item's path inside a template. */
  dataPath: string;
  /** The item's index inside the innermost template, or `null`. */
  index: number | null;
  /**
   * The properties with every binding and call resolved. Properties that only hold child ids
   * and actions are left out: children are in `children`, and an action runs through
   * `dispatch`. A property holding children with other fields (Tabs' `tabs`, with each tab's
   * title) is kept.
   */
  properties: JsonObject;
  /** `@accessibility`, resolved, or `null`. */
  accessibility: JsonObject | null;
  /** The failing check results, in order, each with `valid`, `message`, `severity` (default
   * `error`), and any `code`. */
  failures: JsonObject[];
  /** What failed to evaluate on this node (`EXPRESSION_ERROR`): the property resolved to
   * `null`; the node still shows. */
  errors: string[];
  /** The child nodes, by the property that holds them, in catalog order. */
  children: [property: string, nodes: Node[]][];
  /** The component is referenced but not defined yet: draw a placeholder. */
  placeholder: boolean;
}

/** Where a gesture came from. */
export interface Gesture {
  surfaceId: string;
  /** The node the user interacted with (its id, data path, and index are used). */
  node: Node;
  /** A real user activation (a click, a key press), which `openUrl` requires. */
  activation: boolean;
  /** When it happened, RFC 3339; defaults to now. */
  timestamp?: string;
}

/** What a local function asked the renderer to do, besides data writes (already applied). */
export type Effect = { kind: "openUrl"; url: string };

/** What a gesture produced. */
export interface Dispatch {
  /** The `action` to send the agent, for an event. */
  action: UiAction | null;
  effects: Effect[];
}

/** Why an action could not run. */
export interface ActionError {
  /** `INVALID_ACTION`, `EXPRESSION_ERROR`, or `EXECUTION_ERROR`. */
  code: string;
  message: string;
  surfaceId: string;
}
