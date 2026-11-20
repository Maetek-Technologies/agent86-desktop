import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri loads the dev server from this fixed port (src-tauri/tauri.conf.json `devUrl`).
const PORT = 1420;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Keep Rust build output out of Vite's file watcher.
  clearScreen: false,
  server: {
    port: PORT,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    outDir: "dist",
    // The app's CSP has no inline scripts or styles, so keep every asset in a file.
    assetsInlineLimit: 0,
    // WebView2 on Windows is Chromium; macOS WebKit and Linux WebKitGTK need Safari 16-level syntax.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome120" : "safari16",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 700,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
