import { describe, expect, it } from "vitest";
import {
  classifyHref,
  filePath,
  isMarkdown,
  linkAttributes,
  targetOf,
  type LinkTarget,
} from "./links.ts";

describe("classifyHref", () => {
  it.each<[string, LinkTarget]>([
    ["https://example.com/a?b=1", { kind: "external", url: "https://example.com/a?b=1" }],
    ["  http://localhost:8080/ ", { kind: "external", url: "http://localhost:8080/" }],
    ["mailto:a@example.com", { kind: "external", url: "mailto:a@example.com" }],
    ["#steps", { kind: "anchor", id: "steps" }],
    ["#caf%C3%A9", { kind: "anchor", id: "café" }],
    ["docs/plan.md", { kind: "file", path: "docs/plan.md", from: "document" }],
    ["../README.md#install", { kind: "file", path: "../README.md", from: "document" }],
    ["src/app.ts#L42", { kind: "file", path: "src/app.ts", line: 42, from: "document" }],
    ["my%20notes.md?raw=1", { kind: "file", path: "my notes.md", from: "document" }],
    ["C:\\ws\\a.md", { kind: "file", path: "C:\\ws\\a.md", from: "document" }],
    ["javascript:alert(1)", { kind: "none" }],
    // A local file: URL is a file like any other path; Rust refuses one outside the workspace.
    ["file:///ws/docs/a.md", { kind: "file", path: "/ws/docs/a.md", from: "document" }],
    ["file://localhost/ws/a%20b.md", { kind: "file", path: "/ws/a b.md", from: "document" }],
    ["FILE:///C:/ws/a.md#L3", { kind: "file", path: "C:/ws/a.md", line: 3, from: "document" }],
    ["file://evil.test/share/a.md", { kind: "none" }],
    ["file:a.md", { kind: "none" }],
    ["file://", { kind: "none" }],
    ["tauri://localhost/", { kind: "none" }],
    ["//evil.test/x", { kind: "none" }],
    ["#", { kind: "none" }],
    ["", { kind: "none" }],
  ])("%s", (href, expected) => {
    expect(classifyHref(href)).toEqual(expected);
  });
});

describe("link attributes", () => {
  it.each<LinkTarget>([
    { kind: "external", url: "https://example.com/" },
    { kind: "anchor", id: "steps" },
    { kind: "file", path: "docs/a.md", from: "document" },
    { kind: "file", path: "src/a.ts", line: 3, from: "workspace" },
    { kind: "none" },
  ])("round-trip %j", (target) => {
    const link = document.createElement("a");
    for (const [name, value] of linkAttributes(target)) link.setAttribute(name, value);
    expect(targetOf(link)).toEqual(target);
  });

  it("will not follow an external target that is not a web or mail link", () => {
    const link = document.createElement("a");
    link.dataset.link = "external";
    link.dataset.target = "javascript:alert(1)";
    expect(targetOf(link)).toEqual({ kind: "none" });
  });
});

describe("filePath", () => {
  const doc = "/ws/docs/plan.md";

  it("takes a document's links from its folder", () => {
    expect(filePath({ path: "steps.md", from: "document" }, doc)).toBe("/ws/docs/steps.md");
    expect(filePath({ path: "./a/b.md", from: "document" }, doc)).toBe("/ws/docs/a/b.md");
    expect(filePath({ path: "../README.md", from: "document" }, doc)).toBe("/ws/docs/../README.md");
    expect(filePath({ path: "a/b.md", from: "document" }, "C:\\ws\\docs\\plan.md")).toBe(
      "C:\\ws\\docs\\a\\b.md",
    );
  });

  it("leaves workspace references, absolute paths, and a reply's links as they are", () => {
    expect(filePath({ path: "src/app.ts", from: "workspace" }, doc)).toBe("src/app.ts");
    expect(filePath({ path: "/etc/hosts", from: "document" }, doc)).toBe("/etc/hosts");
    expect(filePath({ path: "docs/a.md", from: "document" })).toBe("docs/a.md");
  });
});

it("knows Markdown files", () => {
  expect(isMarkdown("docs/PLAN.MD")).toBe(true);
  expect(isMarkdown("a.markdown")).toBe(true);
  expect(isMarkdown("src/app.ts")).toBe(false);
  expect(isMarkdown("md")).toBe(false);
});
