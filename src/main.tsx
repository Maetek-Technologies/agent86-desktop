import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyTheme, rememberedTheme } from "./shell/theme.ts";
import "./styles.css";

// The theme last chosen, before the settings arrive, so the first paint does not flash.
applyTheme(rememberedTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
