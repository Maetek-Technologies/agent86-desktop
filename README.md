# agent86-desktop

A desktop app for [agent86](https://github.com/Maetek-Technologies/agent86): a Tauri 2 shell with a
React front end derived from [agent86-web](https://github.com/Maetek-Technologies/Agent86-web), and a
Rust back end that embeds the agent in-process through
[`agent86-core`](https://crates.io/crates/agent86-core).

> **Status: M0 (scaffold).** The window opens and talks to agent86-core. The plan and milestones
> are in [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md).

## Prerequisites

- Rust 1.94 or newer (`rustup`), with the MSVC toolchain on Windows
- Node.js 22.12 or newer and pnpm 10 (`corepack enable`, or `corepack pnpm ...`)
- Platform libraries for Tauri:
  - **Windows:** WebView2 (preinstalled on Windows 11)
  - **macOS:** Xcode Command Line Tools
  - **Linux:** `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev`

The first Rust build compiles agent86-core with its `local-embeddings` feature (candle), which
takes several minutes. Later builds are incremental.

## Development

```sh
pnpm install
pnpm app:dev        # Vite on :1420 plus the Tauri window, with hot reload
pnpm app:build      # release build and installers for this platform

pnpm test           # front-end tests (Vitest)
pnpm lint && pnpm format:check && pnpm typecheck
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

`cargo` commands need the front end built once (`pnpm build`), because the app embeds `dist/`.

## Layout

| Path         | What it is                                                                   |
| ------------ | ---------------------------------------------------------------------------- |
| `src/`       | The React app; `desktop-client/` is the only code that calls into Rust       |
| `src-tauri/` | The Tauri app: commands, and (from M1) the thread actors around agent86-core |
| `docs/`      | The project plan                                                             |

## License

MIT. See [LICENSE](LICENSE).
