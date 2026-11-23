// The renderer's headless runtime for agent86UI (agent86's implementation of Google's A2UI 1.0;
// not affiliated with Google). See ./types.ts for the shapes it gives the widgets, and ./surface.ts
// for how a batch is applied.

export {
  Runtime,
  isValid,
  validationErrors,
  validationResult,
  walk,
  problemText,
} from "./surface.ts";
export type { Problem } from "./surface.ts";
export { Catalog, BASIC_CATALOG_ID } from "./catalog.ts";
export type { FunctionDef, Callers } from "./catalog.ts";
export type { LocalFunction, Scope } from "./functions.ts";
export type * from "./types.ts";
