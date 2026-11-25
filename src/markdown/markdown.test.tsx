// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDocumentLink, openPath } from "../desktop-client/backend.ts";
import { ThreadContext, type ThreadInfo } from "../thread/ThreadContext.ts";
import { Markdown } from "./Markdown.tsx";

vi.mock("../desktop-client/backend.ts", () => ({
  openDocumentLink: vi.fn(() => Promise.resolve()),
  openPath: vi.fn(() => Promise.resolve()),
}));

afterEach(() => {
  cleanup();
  vi.mocked(openDocumentLink).mockClear();
  vi.mocked(openPath).mockReset().mockResolvedValue(undefined);
});

function inThread(text: string, info: ThreadInfo = {}) {
  const openFile = vi.fn();
  const view = render(
    <ThreadContext.Provider value={{ threadId: "t1", cwd: "/ws", openFile, ...info }}>
      <Markdown text={text} />
    </ThreadContext.Provider>,
  );
  return { ...view, openFile };
}

describe("Markdown (docs/SECURITY.md T10)", () => {
  it("renders GFM: headings, lists, tables, task lists, and code", () => {
    const { container } = render(
      <Markdown
        text={
          "# Title\n\n- a\n- [x] done\n\n| h |\n| - |\n| c |\n\n```ts\nconst x = 1;\n```\n\nSome `code`."
        }
      />,
    );
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("table td")?.textContent).toBe("c");
    expect(container.querySelector("pre code")?.textContent).toBe("const x = 1;");
    expect(container.textContent).toContain("ts");
  });

  it.each([
    "<script>window.pwned = 1</script>",
    '<img src=x onerror="window.pwned=1">',
    '<iframe src="https://evil.test"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '<div onclick="alert(1)">click</div>',
    "<style>body{display:none}</style>",
  ])("does not render raw HTML: %s", (html) => {
    const { container } = render(<Markdown text={`before\n\n${html}\n\nafter`} />);
    expect(container.querySelector("script, iframe, style, img, [onclick], [onerror]")).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,hi",
    "vbscript:x",
    "/local/path",
  ])("does not make a link to %s", (url) => {
    const { container } = render(<Markdown text={`[click](${url})`} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("click");
  });

  it("opens safe links in a new tab without a referrer", () => {
    const { container } = render(<Markdown text="[site](https://example.com)" />);
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  });

  it.each([
    ["[site](https://example.com/a?b=1)", "https://example.com/a?b=1"],
    ["[mail](mailto:a@example.com)", "mailto:a@example.com"],
    ["![pixel](https://example.com/p.png)", "https://example.com/p.png"],
  ])("opens %s through the app, not the webview", (text, url) => {
    const { container } = render(<Markdown text={text} />);
    const link = container.querySelector("a")!;
    // fireEvent returns false when the default (the webview following the link) was prevented.
    expect(fireEvent.click(link)).toBe(false);
    expect(openDocumentLink).toHaveBeenCalledExactlyOnceWith(url);
  });

  it("never loads images: they become links", () => {
    const { container } = render(<Markdown text="![pixel](https://evil.test/p.png?d=secret)" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")?.textContent).toBe("[image: pixel]");
  });

  it("drops an image with an unsafe URL to plain text", () => {
    const { container } = render(<Markdown text="![x](javascript:alert(1))" />);
    expect(container.querySelector("a, img")).toBeNull();
    expect(container.textContent).toBe("[image: x]");
  });
});

describe("Markdown: the thread's files (docs/PROJECT_PLAN.md §7a, 1.2.1)", () => {
  it.each([
    ["[the plan](docs/plan.md)", "docs/plan.md"],
    ["[notes](./my%20notes.markdown)", "./my notes.markdown"],
    ["[abs](/ws/docs/a.md)", "/ws/docs/a.md"],
    ["[url](file:///ws/docs/a.md)", "/ws/docs/a.md"],
  ])("%s opens in the document pane", (text, path) => {
    const { container, openFile } = inThread(text);
    const link = container.querySelector("a")!;
    expect(fireEvent.click(link)).toBe(false);
    expect(openFile).toHaveBeenCalledExactlyOnceWith(path);
    expect(openPath).not.toHaveBeenCalled();
  });

  it("opens any other file with its default app, and shows a refusal", async () => {
    vi.mocked(openPath).mockRejectedValueOnce("report.pdf is outside this thread's workspace");
    const { container, findByRole, openFile } = inThread("[report](out/report.pdf)");
    fireEvent.click(container.querySelector("a")!);
    expect(openPath).toHaveBeenCalledExactlyOnceWith("t1", "out/report.pdf", false);
    expect(openFile).not.toHaveBeenCalled();
    expect((await findByRole("alert")).textContent).toContain("outside this thread's workspace");
  });

  it.each(["`docs/plan.md`", "`README.md`", "`file:///ws/a.md`"])(
    "makes the Markdown path in %s a link to the pane",
    (text) => {
      const { container, openFile } = inThread(`Wrote ${text}.`);
      const link = container.querySelector("a")!;
      expect(link.querySelector("code")).not.toBeNull();
      fireEvent.click(link);
      expect(openFile).toHaveBeenCalledOnce();
    },
  );

  it.each(["`*.md`", "`a b.md`", "`src/app.ts`", "`https://example.com/a.md`", "`.md`"])(
    "leaves %s as code",
    (text) => {
      const { container } = inThread(`See ${text}.`);
      expect(container.querySelector("a")).toBeNull();
      expect(container.querySelector("code")).not.toBeNull();
    },
  );

  it("does not put a link inside a link", () => {
    const { container, openFile } = inThread("[`docs/plan.md`](docs/plan.md)");
    expect(container.querySelectorAll("a")).toHaveLength(1);
    fireEvent.click(container.querySelector("a")!);
    expect(openFile).toHaveBeenCalledExactlyOnceWith("docs/plan.md");
  });

  it("leaves code blocks alone", () => {
    const { container } = inThread("```\ndocs/plan.md\n```");
    expect(container.querySelector("a")).toBeNull();
  });

  it("keeps file links as text outside a thread", () => {
    const { container } = render(<Markdown text="[the plan](docs/plan.md) and `docs/plan.md`" />);
    expect(container.querySelector("a")).toBeNull();
  });

  it("does not follow other schemes or hosts", () => {
    const { container } = inThread(
      "[a](tauri://localhost/) [b](file://evil.test/a.md) [c](javascript:alert(1))",
    );
    expect(container.querySelector("a")).toBeNull();
  });
});
