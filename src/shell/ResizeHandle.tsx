import { useRef } from "react";

/**
 * A panel's resizable edge: drag, arrow keys (Shift for bigger steps), Home and End, or
 * double-click to reset. `edge` is the side of the panel it sits on: dragging away from the panel
 * makes it wider.
 */
export function ResizeHandle({
  width,
  onResize,
  label,
  min,
  max,
  reset,
  edge,
}: {
  width: number;
  onResize: (width: number) => void;
  label: string;
  min: number;
  max: number;
  reset: number;
  edge: "left" | "right";
}) {
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);
  const clamp = (value: number) =>
    Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : reset;
  // Pixels the panel grows when the pointer or an arrow moves right.
  const sign = edge === "right" ? 1 : -1;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        onResize(clamp(drag.current.width + sign * (event.clientX - drag.current.x)));
      }}
      onPointerUp={(event) => {
        drag.current = undefined;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onDoubleClick={() => onResize(reset)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16;
        if (event.key === "ArrowLeft") onResize(clamp(width - sign * step));
        else if (event.key === "ArrowRight") onResize(clamp(width + sign * step));
        else if (event.key === "Home") onResize(min);
        else if (event.key === "End") onResize(max);
        else return;
        event.preventDefault();
      }}
      className={`absolute top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-accent/50 focus-visible:bg-accent/70 focus-visible:outline-none ${
        edge === "right" ? "-right-0.5" : "-left-0.5"
      }`}
    />
  );
}
