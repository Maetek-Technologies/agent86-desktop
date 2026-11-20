import { expect, test } from "vitest";
import type { ProviderPreset, ProviderSettings, Settings } from "../desktop-client/events.ts";
import {
  formatPairs,
  keyUse,
  parseAmount,
  parseCount,
  parseLines,
  parsePairs,
  setupSettings,
  splitRef,
  uniqueName,
  usersOf,
  validProviderName,
} from "./settings-model.ts";

const openai: ProviderSettings = {
  kind: "openai",
  baseUrl: "https://openrouter.ai/api/v1",
  key: "required",
  apiKeyEnv: "OPENROUTER_API_KEY",
  maxTokens: null,
  numCtx: null,
  connectTimeoutS: 10,
  readTimeoutS: 300,
  maxRetries: 2,
  promptCache: true,
  store: false,
  routing: null,
};

const base = {
  version: 1,
  model: { default: "", triage: null, contextWindows: {} },
  providers: {},
} as unknown as Settings;

test("refs split at the first colon only", () => {
  expect(splitRef("openrouter:openai/gpt-4o:free")).toEqual({
    provider: "openrouter",
    model: "openai/gpt-4o:free",
  });
  expect(splitRef("vllm:")).toBeNull();
  expect(splitRef("qwen")).toBeNull();
});

test("a kind's own key use wins over the setting", () => {
  expect(keyUse({ ...openai, kind: "anthropic", key: "none" })).toBe("required");
  expect(keyUse({ ...openai, kind: "ollama", key: "required" })).toBe("none");
  expect(keyUse({ ...openai, key: "optional" })).toBe("optional");
});

test("first-run settings put one provider and its model on the defaults", () => {
  const preset: ProviderPreset = {
    name: "openrouter",
    label: "OpenRouter",
    provider: openai,
    exampleModel: "x",
  };
  const s = setupSettings(base, preset, "or", " anthropic/claude ", "");
  expect(s.model.default).toBe("or:anthropic/claude");
  expect(s.providers.or?.baseUrl).toBe("https://openrouter.ai/api/v1");
  const custom = setupSettings(base, preset, "or", "m", " http://host/v1 ");
  expect(custom.providers.or?.baseUrl).toBe("http://host/v1");
});

test("a provider in use is named by the models that use it", () => {
  const s = {
    ...base,
    model: { default: "a:x", triage: { cheap: "b:y", frontier: "a:z" }, contextWindows: {} },
  } as Settings;
  expect(usersOf(s, "a")).toEqual(["a:x", "a:z"]);
  expect(usersOf(s, "c")).toEqual([]);
});

test("names: unique and valid", () => {
  expect(uniqueName(["vllm", "vllm-2"], "vllm")).toBe("vllm-3");
  expect(uniqueName([], "vllm")).toBe("vllm");
  expect(validProviderName("my.host_1")).toBe(true);
  expect(validProviderName("my host")).toBe(false);
  expect(validProviderName("a:b")).toBe(false);
});

test("pairs and lines round-trip, and bad lines are named", () => {
  expect(parsePairs("A=1\n\n B = two ")).toEqual({ pairs: { A: "1", B: "two" } });
  expect(parsePairs("Authorization: Bearer ${T}", ":")).toEqual({
    pairs: { Authorization: "Bearer ${T}" },
  });
  expect(parsePairs("A=1\nnope")).toEqual({ error: "Line 2 should be written name=value." });
  expect(formatPairs({ A: "1", B: "2" })).toBe("A=1\nB=2");
  expect(formatPairs({ X: "y" }, ":")).toBe("X: y");
  expect(parseLines(" -y \n\n pkg ")).toEqual(["-y", "pkg"]);
});

test("numbers: counts and amounts", () => {
  expect(parseCount("40", 1)).toBe(40);
  expect(parseCount("0", 1)).toBeNull();
  expect(parseCount("1.5")).toBeNull();
  expect(parseCount("abc")).toBeNull();
  expect(parseAmount("2.5")).toBe(2.5);
  expect(parseAmount("-1")).toBeNull();
  expect(parseAmount("1.")).toBeNull();
});
