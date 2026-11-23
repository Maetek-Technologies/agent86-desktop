import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Answer, DesktopEvent, UiAction } from "../../desktop-client/events.ts";
import { initialState, reduce, type SessionState } from "../../desktop-client/session-state.ts";
import { LinkConfirm } from "./SurfaceFrame.tsx";
import { SurfaceEntryView, SurfaceProvider, useSurfaces } from "./Surfaces.tsx";

vi.mock("../../desktop-client/backend.ts", () => ({
  surfaceMediaUrl: (threadId: string, path: string) =>
    `agent86-media://localhost/${threadId}/${path}`,
  openSurfaceUrl: vi.fn(() => Promise.resolve()),
}));

const BASIC = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";

function surface(components: unknown[], dataModel: unknown = {}): DesktopEvent {
  return {
    type: "ui",
    toolCallId: "c1",
    message: {
      version: "1.0",
      createSurface: { surfaceId: "form", catalogId: BASIC, components, dataModel },
    },
  };
}

const REQUIRED_NAME = { "@call": "required", args: { value: { "@path": "/name" } } };

const nameForm = surface(
  [
    { id: "root", component: "Column", children: ["name", "ok"] },
    {
      id: "name",
      component: "TextField",
      label: "Name",
      value: { "@path": "/name" },
      "@checks": [{ condition: REQUIRED_NAME, message: "Your name, please" }],
    },
    {
      id: "ok",
      component: "Button",
      child: "ok_label",
      variant: "primary",
      "@checks": [{ condition: REQUIRED_NAME, message: "Fill in your name first" }],
      action: { event: { name: "submit", context: { name: { "@path": "/name" } } } },
    },
    { id: "ok_label", component: "Text", text: "OK" },
  ],
  { name: "" },
);

function Harness({
  events,
  onAnswer = () => {},
  onUiAction = () => {},
}: {
  events: DesktopEvent[];
  onAnswer?: (qid: number, answer: Answer) => void;
  onUiAction?: (action: UiAction) => void;
}) {
  const [state, dispatch] = useReducer(reduce, undefined, (): SessionState =>
    events.reduce(reduce, initialState()),
  );
  const surfaces = useSurfaces({
    threadId: "t1",
    model: "vllm:qwen",
    state,
    onAnswer,
    onUiAction,
    onLocal: dispatch,
  });
  return (
    <SurfaceProvider value={surfaces.context}>
      {state.entries.map((entry) =>
        entry.kind === "surface" ? <SurfaceEntryView key={entry.id} entry={entry} /> : null,
      )}
      {surfaces.link && (
        <LinkConfirm
          url={surfaces.link}
          onOpen={surfaces.closeLink}
          onCancel={surfaces.closeLink}
        />
      )}
    </SurfaceProvider>
  );
}

afterEach(cleanup);

describe("agent86UI surfaces", () => {
  it("draws inside a frame that names the agent, never in the warn style", () => {
    const { container } = render(<Harness events={[nameForm]} />);
    const frame = screen.getByRole("region", { name: "Drawn by the agent: form" });
    expect(frame.textContent).toContain("Drawn by the agent · vllm:qwen");
    expect(container.innerHTML).not.toMatch(/warn/);
  });

  it("writes input back and sends the button's action with its context resolved", () => {
    const onUiAction = vi.fn();
    render(<Harness events={[nameForm]} onUiAction={onUiAction} />);
    const ok = screen.getByRole("button", { name: "OK" });
    // `required` fails on an empty name, so the button waits.
    expect((ok as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Your name, please")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Ada");
    expect((ok as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(ok);

    expect(onUiAction).toHaveBeenCalledTimes(1);
    const action = onUiAction.mock.calls[0]![0] as UiAction;
    expect(action).toMatchObject({
      name: "submit",
      surfaceId: "form",
      sourceComponentId: "ok",
      context: { name: "Ada" },
    });
    expect(Number.isNaN(Date.parse(action.timestamp))).toBe(false);
  });

  it("answers a waiting call from its surface, or dismisses it", () => {
    const onAnswer = vi.fn();
    const onUiAction = vi.fn();
    render(
      <Harness
        events={[
          surface([
            { id: "root", component: "Button", child: "l", action: { event: { name: "go" } } },
            { id: "l", component: "Text", text: "Go" },
          ]),
          { type: "uiWaitRequest", qid: 7, surfaceIds: ["form"] },
        ]}
        onAnswer={onAnswer}
        onUiAction={onUiAction}
      />,
    );
    expect(screen.getByText("The agent is waiting for your answer here")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onUiAction).not.toHaveBeenCalled();
    expect(onAnswer).toHaveBeenCalledWith(7, {
      type: "ui",
      action: expect.objectContaining({ name: "go", surfaceId: "form" }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onAnswer).toHaveBeenLastCalledWith(7, { type: "ui", action: null });
  });

  it("shows workspace and data: media, and refuses the web's", () => {
    render(
      <Harness
        events={[
          surface([
            { id: "root", component: "Column", children: ["a", "b", "c"] },
            { id: "a", component: "Image", url: "img/cat.png", description: "A cat" },
            {
              id: "b",
              component: "Image",
              url: "data:image/png;base64,iVBORw0KGgo=",
              description: "Dot",
            },
            {
              id: "c",
              component: "Image",
              url: "https://tracker.example/p.png",
              description: "Web",
            },
          ]),
        ]}
      />,
    );
    expect(screen.getByAltText<HTMLImageElement>("A cat").src).toBe(
      "agent86-media://localhost/t1/img/cat.png",
    );
    expect(screen.getByAltText<HTMLImageElement>("Dot").src).toMatch(/^data:image\/png/);
    expect(screen.queryByAltText("Web")).toBeNull();
    expect(screen.getByText(/Image not shown\. Media from the web is not shown/)).toBeTruthy();
  });

  it("asks before opening a link, showing the whole address", () => {
    render(
      <Harness
        events={[
          surface([
            {
              id: "root",
              component: "Button",
              child: "l",
              action: {
                functionCall: { "@call": "openUrl", args: { url: "https://docs.example/a?b=1" } },
              },
            },
            { id: "l", component: "Text", text: "Docs" },
          ]),
        ]}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Docs" }));
    });
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("https://docs.example/a?b=1");
    expect(dialog.textContent).toContain("docs.example");
    expect(screen.getByRole("button", { name: "Open link" })).toBeTruthy();
  });

  it("will not offer to open anything but http and https", () => {
    render(<LinkConfirm url="javascript:alert(1)" onOpen={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("This link can't be opened")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open link" })).toBeNull();
  });

  it("marks a surface the agent deleted", () => {
    render(
      <Harness
        events={[
          nameForm,
          {
            type: "ui",
            toolCallId: "c2",
            message: { version: "1.0", deleteSurface: { surfaceId: "form" } },
          },
        ]}
      />,
    );
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByText(/The agent removed the surface/)).toBeTruthy();
  });

  it("locks the surface once sent, until the user unlocks it to send again", () => {
    const onUiAction = vi.fn();
    render(<Harness events={[nameForm]} onUiAction={onUiAction} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    const ok = screen.getByRole("button", { name: "OK" }) as HTMLButtonElement;
    fireEvent.click(ok);
    expect(onUiAction).toHaveBeenCalledTimes(1);
    expect(ok.disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>("Name").disabled).toBe(true);
    expect(screen.getByText("Sent")).toBeTruthy();
    // A second click while locked sends nothing.
    fireEvent.click(ok);
    expect(onUiAction).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Change and send again" }));
    expect(ok.disabled).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>("Name").disabled).toBe(false);
    expect(screen.queryByText("Sent")).toBeNull();
    fireEvent.click(ok);
    expect(onUiAction).toHaveBeenCalledTimes(2);
  });

  it("does not lock for a button that only opens a link", () => {
    render(
      <Harness
        events={[
          surface([
            {
              id: "root",
              component: "Button",
              child: "l",
              action: { functionCall: { "@call": "openUrl", args: { url: "https://a.example/" } } },
            },
            { id: "l", component: "Text", text: "Docs" },
          ]),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Docs" }));
    expect(screen.queryByText("Sent")).toBeNull();
    expect((screen.getByRole("button", { name: "Docs" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
