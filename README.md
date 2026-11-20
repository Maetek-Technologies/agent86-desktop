# agent86-desktop

A desktop app for [agent86](https://github.com/Maetek-Technologies/agent86): a Tauri 2 shell with a
React front end derived from [agent86-web](https://github.com/Maetek-Technologies/Agent86-web), and a
Rust back end that embeds the agent in-process through
[`agent86-core`](https://crates.io/crates/agent86-core).

> **Status: 1.0.0.** Threads run in tabs, in parallel, with streamed answers, thinking, tool cards
> with diffs, approvals, limit raises, secret prompts, `/` commands, `@` file mentions, and a
> context meter. Sessions are saved to the memory database the agent86 CLI uses
> (`~/.agent86/memory.db`), listed in the sidebar, and can be reopened and renamed. The app has
> its own settings (providers and models, triage, limits, guardrails, MCP servers), set up on
> first run by importing your agent86 CLI config or choosing a provider. A memory panel shows
> and pins what the agent remembers, a secrets panel manages each thread's secrets, a project's
> own skills, specialists, and MCP servers load once you trust them, and sub-agents' work
> (including isolated runs in git worktrees) shows on their delegation's card. It notifies you
> when a background thread needs you or a long turn ends, remembers its window, runs as a single
> instance, can show a tray icon with the running turns, opens or reveals the files tool cards
> show, has light and dark themes, and keyboard shortcuts (listed in Settings, Appearance), and
> updates itself from GitHub Releases. The plan and milestones are in
> [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md).

## Install

Download the installer for Windows, macOS (Apple Silicon or Intel), or Linux from the
[latest release](https://github.com/Maetek-Technologies/agent86-desktop/releases/latest). The
[user guide](docs/USER_GUIDE.md) covers which file to pick, the first launch, setup, and everything
the app does.

## Settings and keys

- **Settings** live in `settings.json` in the app's config folder (on Windows
  `%APPDATA%\com.maetek.agent86.desktop`). The first run offers to import
  `~/.agent86/config.toml` once; after that the two are independent. **Settings** in the
  sidebar edits them; threads opened afterwards use the new settings.
- **API keys** are kept in the OS keyring, service `agent86`, account = the provider's name:
  the same entry `agent86 keys set <provider>` writes, so a key set in either works in both. A
  provider's key variable (such as `OPENROUTER_API_KEY`), when set, wins, as in the CLI. Keys
  never go into `settings.json`, and the UI never reads them back.
- **MCP servers** can name a token as `${NAME}`: it is read from the environment variable
  `NAME`, or else the keyring entry `NAME`.
- **Secrets** a thread holds reach tools as environment variables; the model sees only
  `${secret:NAME}`. One remembered for a project is kept in the OS keyring under the CLI's
  per-project entry, so threads opened there later, in the app or the CLI, load it.
- **Project trust:** a workspace's `.agent86/skills`, `.claude/skills`, `.agent86/agents`, and
  the MCP servers in its `.agent86/config.toml` load only after you review and trust them, and
  again after any change. Trusted projects are listed in Settings, Projects.
- **Open and reveal** on a tool card work only for files inside the thread's workspace or a
  worktree its sub-agents kept. Programs and scripts (`.exe`, `.bat`, `.sh`, `.app`, ...) are only
  revealed in Explorer or Finder, never opened.
- **Appearance** (Settings): theme, notifications, and the tray icon. The window's size and place
  are kept in `window-state.json` beside `settings.json`.
- To try the app without touching your real settings (a first run, say), start it with
  `AGENT86_DESKTOP_CONFIG_DIR` set to another folder; it then runs as an instance of its own.
  Sessions still go to the memory database in your home folder unless `USERPROFILE` (Windows) or
  `HOME` points elsewhere too. On Windows, point `APPDATA` and `LOCALAPPDATA` into that profile
  as well, or Tauri cannot find its own folders and the window's place is not kept.

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
pnpm app:build      # installers for this platform (needs the updater key: docs/RELEASING.md)

pnpm test           # front-end tests (Vitest)
cd src-tauri && cargo test real_model -- --ignored --nocapture   # one real turn with your CLI config's model
pnpm lint && pnpm format:check && pnpm typecheck
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

`cargo` commands need the front end built once (`pnpm build`), because the app embeds `dist/`.

## Layout

| Path         | What it is                                                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`       | The React app; `desktop-client/` is the only code that calls into Rust; `desktop-client/generated/` holds the IPC types `cargo test` writes from Rust (ts-rs); `settings/` is the settings view and first-run screen |
| `src-tauri/` | The Tauri app: commands, settings, keys, the CLI config import, and the thread actors around agent86-core; `src/unstable.rs` is the only code that uses agent86-core outside its semver-covered `sdk` module         |
| `docs/`      | The project plan, the user guide, and how to release                                                                                                                                                                 |

## License

MIT. See [LICENSE](LICENSE).
