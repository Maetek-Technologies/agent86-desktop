import { expect, test } from "vitest";
import type { ModelMenu } from "../desktop-client/events.ts";
import { looksLikeReference, menuItems } from "./ModelPicker.tsx";

const menu: ModelMenu = {
  configured: ["vllm:qwen", "openrouter:big"],
  providers: [
    {
      provider: "vllm",
      models: [
        { reference: "vllm:qwen", label: null },
        { reference: "vllm:small", label: null },
      ],
      problem: null,
    },
    {
      provider: "openrouter",
      models: [{ reference: "openrouter:big", label: "Big Model" }],
      problem: null,
    },
    { provider: "ollama", models: [], problem: "connection refused" },
  ],
};

test("settings' models come first, providers' lists after, without repeats or the current one", () => {
  const items = menuItems(menu, "", "vllm:qwen", false);
  expect(items.map((i) => [i.group, i.reference])).toEqual([
    ["Settings", "openrouter:big"],
    ["vllm", "vllm:small"],
  ]);
});

test("a thread on its own model can go back to the settings' model", () => {
  const items = menuItems(menu, "", "vllm:small", true);
  expect(items[0]).toEqual({ reference: "", label: "The settings' model", group: "Settings" });
});

test("the filter matches references and labels, ignoring case", () => {
  expect(menuItems(menu, "BIG model", "vllm:qwen", false).map((i) => i.reference)).toEqual([
    "openrouter:big",
  ]);
  expect(menuItems(menu, "nothing-like-it", "vllm:qwen", false)).toEqual([]);
  expect(menuItems(menu, "big", "vllm:qwen", false).map((i) => i.reference)).toEqual([
    "openrouter:big",
  ]);
  expect(menuItems(menu, "SMALL", "vllm:qwen", false).map((i) => i.reference)).toEqual([
    "vllm:small",
  ]);
});

test("a typed provider:model not in the lists can be used", () => {
  const items = menuItems(menu, "vllm:other-model", "vllm:qwen", false);
  expect(items.at(-1)).toEqual({
    reference: "vllm:other-model",
    label: "Use vllm:other-model",
    group: "Typed",
  });
  // Ollama ids have colons of their own.
  expect(looksLikeReference("ollama:llama3.1:8b")).toBe(true);
  expect(looksLikeReference("qwen")).toBe(false);
  expect(looksLikeReference(":x")).toBe(false);
});

test("the current model's provider is listed first", () => {
  const two: ModelMenu = {
    configured: [],
    providers: [
      {
        provider: "openrouter",
        models: [{ reference: "openrouter:a", label: null }],
        problem: null,
      },
      { provider: "vllm", models: [{ reference: "vllm:b", label: null }], problem: null },
    ],
  };
  expect(menuItems(two, "", "vllm:current", false).map((i) => i.group)).toEqual([
    "vllm",
    "openrouter",
  ]);
  expect(menuItems(two, "", "openrouter:current", false).map((i) => i.group)).toEqual([
    "openrouter",
    "vllm",
  ]);
});
