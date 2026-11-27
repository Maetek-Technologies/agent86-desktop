![The agent86 logo: a robot detective in a fedora beside a seven-segment 86, on a retro badge reading AGENT 86](public/agent86-logo.png)

# agent 86 desktop

[![CI](https://github.com/Maetek-Technologies/agent86-desktop/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Maetek-Technologies/agent86-desktop/actions/workflows/ci.yml)
[![Release](docs/images/badges/release.svg)](https://github.com/Maetek-Technologies/agent86-desktop/releases/latest)
[![License: MIT](docs/images/badges/license.svg)](LICENSE)

[![agent86-core](docs/images/badges/agent86-core.svg)](https://crates.io/crates/agent86-core)
[![Rust](docs/images/badges/rust.svg)](https://www.rust-lang.org)
[![Tauri](docs/images/badges/tauri.svg)](https://tauri.app)
[![React](docs/images/badges/react.svg)](https://react.dev)
[![TypeScript](docs/images/badges/typescript.svg)](https://www.typescriptlang.org)
[![Platforms](docs/images/badges/platforms.svg)](#install)

A desktop app for the [agent86](https://github.com/Maetek-Technologies/agent86) coding agent. The
agent runs inside the app, embedded in-process through
[`agent86-core`](https://crates.io/crates/agent86-core): there is no separate `agent86` binary,
server, or browser to set up. It is a Tauri 2 shell with a React front end derived from
[agent86-web](https://github.com/Maetek-Technologies/Agent86-web), and it shares API keys,
sessions, and memory with the agent86 CLI, so you can start work in one and carry on in the other. Website:
[maetek-technologies.github.io/agent86-desktop](https://maetek-technologies.github.io/agent86-desktop/).

## Quickstart

1. Download the installer for your system from the
   [latest release](https://github.com/Maetek-Technologies/agent86-desktop/releases/latest) and
   install it.
2. On first launch, import your agent86 CLI settings (`~/.agent86/config.toml`), or pick a
   provider, a model, and (if it needs one) an API key. **Test** checks all three.
3. **New thread** (Ctrl+T or ⌘T), choose a workspace folder, and ask.

By default, every file write, command, and snippet asks for your approval before it runs.

## What it does

- **Threads in tabs.** Several threads run in parallel, each in its own workspace, with streamed
  answers, thinking, a context meter, `/` commands, and `@` file mentions. A tab that needs you
  says so, and a notification tells you when a background thread is waiting or a long turn ends.
- **Tool cards with diffs.** Every tool call shows its arguments and result; edits show as diffs,
  and files on a card can be opened, revealed, or (for Markdown) viewed.
- **Approvals, limits, and secrets.** Approve or deny each change, raise a limit when a turn hits
  one, and hand over secrets in a masked prompt: the model sees only `${secret:NAME}`.
- **Forms and questions from the agent.** The agent can draw forms, choices, and confirmations
  (agent86UI, in Google's A2UI format) and ask you questions through a form, always inside a frame
  marked as drawn by the agent.
- **A Markdown viewer.** Documents the agent writes open rendered beside the conversation, from a
  tool card or a link in its reply, with contents, Raw view, link following, and refresh.
- **Sessions and memory.** Sessions are saved to the same database the CLI uses, listed in the
  sidebar, and can be reopened and renamed. A memory panel shows and pins what the agent remembers.
- **Any model, switchable per thread.** OpenRouter, Anthropic, OpenAI, Google, Ollama, vLLM, and
  other OpenAI-compatible servers; a thread's header switches its model (from each provider's list)
  and its permissions (ask, auto, read-only).
- **Projects, skills, sub-agents, and MCP.** A project's own skills, specialists, and MCP servers
  load once you trust them; sub-agents' work, including isolated runs in git worktrees, shows on
  their delegation's card.
- **Logs.** The agent's activity (tokens, cost, tool calls) and the app's own log.
- **A proper desktop app.** Light and dark themes, keyboard shortcuts, an optional tray icon with
  the running turns, a remembered window, a single instance, and updates from GitHub Releases.

The [user guide](docs/USER_GUIDE.md) covers everything the app does.

## Install

Download the installer for your system from the
[latest release](https://github.com/Maetek-Technologies/agent86-desktop/releases/latest):

| System               | File                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Windows 10 and 11    | `Agent 86_<version>_x64-setup.exe` (for you only, no admin prompt), or the `.msi` for all users |
| macOS, Apple Silicon | `Agent 86_<version>_aarch64.dmg`                                                                |
| macOS, Intel         | `Agent 86_<version>_x64.dmg`                                                                    |
| Linux                | `.AppImage` (any distribution; updates itself), or `.deb` / `.rpm`                              |

The app updates itself from GitHub Releases. The installers are not code-signed yet, so Windows
SmartScreen and macOS Gatekeeper warn on first launch; the
[user guide](docs/USER_GUIDE.md#the-first-time-you-open-it) shows how to get past them.

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
- **The Markdown viewer** reads only files inside the thread's workspace or a kept worktree, up to
  2 MB of UTF-8. Documents render without raw HTML, then pass DOMPurify; images are never loaded,
  links never navigate the window, and only http, https, and mailto links leave the app.
- **Appearance** (Settings): theme, notifications, and the tray icon. The window's size and place
  are kept in `window-state.json` beside `settings.json`.
- To try the app without touching your real settings (a first run, say), start it with
  `AGENT86_DESKTOP_CONFIG_DIR` set to another folder; it then runs as an instance of its own.
  Sessions still go to the memory database in your home folder unless `USERPROFILE` (Windows) or
  `HOME` points elsewhere too. On Windows, point `APPDATA` and `LOCALAPPDATA` into that profile
  as well, or Tauri cannot find its own folders and the window's place is not kept.

## Status

Version 1.2.2 embeds agent86-core 1.2.3. Version 1.0.0 (2026-11-20) did everything above except
the agent's forms and the Markdown viewer; the plan and milestones are in
[docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md).

- [x] 1.0.0: threads, tool cards, approvals, sessions, memory, secrets, project trust, settings
      and first-run import, logs, tray, notifications, and in-app updates, with installers for
      Windows, macOS (arm64 and x64), and Linux (released 2026-11-20)
- [x] 1.1.0 to 1.1.3: surfaces the agent draws (agent86UI, from agent86 1.2.0), locking a surface
      once you send it, questions from the agent (`ask_user`, from agent86 1.2.2), and links in
      replies opening again
- [x] 1.2.0: the Markdown viewer, beside the conversation (released 2026-11-25; see
      [docs/releases/v1.2.0.md](docs/releases/v1.2.0.md))
- [x] 1.2.1: documents opened from links in the agent's replies, and refresh (released
      2026-11-25; see [docs/releases/v1.2.1.md](docs/releases/v1.2.1.md))
- [x] 1.2.2: agent86-core 1.2.3, a harness better suited to local models: context sized to the
      window, compaction that keeps the task, the platform in the system prompt, and a stall nudge
      (see [docs/releases/v1.2.2.md](docs/releases/v1.2.2.md))
- [ ] End-to-end tests: Playwright against the Vite build on every PR, then a small
      `tauri-driver` suite
- [ ] Release verification: a real install-and-update cycle on all three systems
- [ ] Code signing: Authenticode, and Apple Developer ID with notarization
- [ ] Math and Mermaid diagrams in the Markdown viewer

Notes for every release are in [docs/releases](docs/releases).

## Why Tauri?

The goal is a double-click app with no Node, no `agent86` binary, no bridge process, and no browser
token. Tauri gives a small native shell around the system's own WebView, so the React UI from
agent86-web carries over, while the agent itself runs in Rust in the same process through
`agent86-core`'s SDK. agent86's safety model (the workspace jail, approval gate, sandbox,
guardrails, and secret vault) lives in that library, so the app keeps it by building on it rather
than reimplementing it.

## Compatibility with the CLI

The app reads no CLI config at run time (the SDK reads nothing it is not handed), but it stays
compatible with the agent86 CLI where that is cheap:

- The same API keys, in the same OS keyring entries
- The same session and memory database (`~/.agent86/memory.db`), so a session started in one opens
  in the other
- The same per-project remembered secrets
- A one-time import of `~/.agent86/config.toml` on first run

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
```

Before a pull request, run the checks CI runs:

```sh
pnpm test           # front-end tests (Vitest)
pnpm lint && pnpm format:check && pnpm typecheck
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

`cargo` commands need the front end built once (`pnpm build`), because the app embeds `dist/`. To
run one real turn with your CLI config's model:

```sh
cd src-tauri && cargo test real_model -- --ignored --nocapture
```

[docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) covers the design and what comes next, and
[docs/RELEASING.md](docs/RELEASING.md) covers releases.

## Layout

| Path         | What it is                                                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`       | The React app; `desktop-client/` is the only code that calls into Rust; `desktop-client/generated/` holds the IPC types `cargo test` writes from Rust (ts-rs); `settings/` is the settings view and first-run screen |
| `src-tauri/` | The Tauri app: commands, settings, keys, the CLI config import, and the thread actors around agent86-core; `src/unstable.rs` is the only code that uses agent86-core outside its semver-covered `sdk` module         |
| `docs/`      | The project plan, the user guide, release notes, and how to release                                                                                                                                                  |
| `site/`      | The project website, published to GitHub Pages by `.github/workflows/pages.yml`                                                                                                                                      |

## License

MIT. See [LICENSE](LICENSE).
