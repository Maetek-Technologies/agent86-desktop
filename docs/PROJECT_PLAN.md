# agent86-desktop — Project Plan

A native desktop app for agent86: a **Tauri 2** shell whose **React** front end is derived from
[agent86-web](../../agent86-web) (`packages/web`), and whose **Rust** back end embeds the agent
in-process through [`agent86-core`](https://crates.io/crates/agent86-core) (`agent86_core::sdk`, v1.1.0).

Status: M7 (desktop polish) done 2026-11-20: verified in the real app on Windows against a real model; M0-M6 green in CI on Windows, macOS, and Linux. M8 (ship) next.

---

## 1. Goals and non-goals

**Goals**

1. A double-click app with agent86's conversation, tool cards, diffs, approvals, sessions, memory,
   secrets, skills, and specialists. No Node, no `agent86` binary, no bridge, no browser token.
2. Reuse as much of agent86-web's UI as possible (transcript, Markdown, highlighting, DiffView,
   ToolCard, PermissionPanel, SecretPrompt, Spend, tabs, sidebar).
3. Keep agent86's safety model intact: workspace jail, approval gate, sandbox, guardrails, secret
   vault. All of that lives in `agent86-core`, so we keep it by building on the SDK.
4. Stay compatible with the CLI where it is cheap: the same API keys and the same session and
   memory database, so a session started in one opens in the other.
5. Signed installers for Windows, macOS, and Linux, with auto-update.

**Non-goals (v1)**

- Running the `agent86` binary or speaking ACP. The SDK replaces both.
- Remote or hosted agents (agent86-web phase 2 covers that).
- Editing files in the app. It shows diffs and approves changes; it is not an IDE.

---

## 2. What changes compared with agent86-web

| agent86-web                                         | agent86-desktop                                                 |
| --------------------------------------------------- | --------------------------------------------------------------- |
| Browser SPA, WebSocket, JSON-RPC (ACP v1)           | Tauri WebView, Tauri IPC (commands plus `ipc::Channel` streams) |
| Node bridge spawns one `agent86 acp` per thread     | Rust owns one in-process `sdk::Agent` per thread                |
| agent86 reads `~/.agent86/config.toml` and keyring  | **The SDK reads nothing.** The app supplies providers, keys, limits, MCP, memory, and skills |
| Token login, Host/Origin checks, `--root` jail      | Not needed. Tauri capabilities and CSP; the native folder picker chooses workspaces |
| `session/request_permission` with ACP options       | The SDK's `approver(tool, &ApprovalPreview) -> bool` closure     |
| `_com.maetek.agent86/secret/request` extension      | `on_secret_request(&SecretRequest) -> Option<String>`           |
| Process limits (`--max-agents`, idle timeout)       | Thread actors; a cap on concurrent running turns                |
| Project trust gates `.agent86/config.toml`          | Trust gates what *we* choose to load from a project (skills, specialists, MCP) |

---

## 3. Architecture

```
┌──────────────────────────────── agent86-desktop (one process) ────────────────────────────────┐
│                                                                                                │
│  WebView (React 19 + Vite + Tailwind)          Rust (Tauri 2)                                  │
│  ┌────────────────────────────┐   invoke()    ┌──────────────────────────────────────────────┐ │
│  │ UI from agent86-web        │ ───────────▶  │ commands.rs  (typed, validated)               │ │
│  │  Transcript, ToolCard,     │               │ ThreadManager                                 │ │
│  │  DiffView, PermissionPanel │  Channel<Ev>  │  ├─ ThreadActor #1 ── OS thread + tokio rt ─┐ │ │
│  │ desktop-client (TS)        │ ◀───────────  │  │    sdk::Agent::run_with_events          │ │ │
│  │  Backend interface,        │  per thread   │  ├─ ThreadActor #2 ...                      │ │ │
│  │  event reducer → state     │               │ Settings (app config dir) + Keyring         │ │ │
│  └────────────────────────────┘               │ Memory (shared ~/.agent86/memory.db)        │ │ │
│                                               └──────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────▲───────────────────────────────┘
                                                                │ HTTPS to model providers; tools run
                                                                ▼ inside the workspace jail/sandbox
```

### 3.1 Rust back end (`src-tauri/`)

```
src-tauri/src/
├── main.rs / lib.rs     # Tauri builder, plugins, state, command registration
├── commands.rs          # every #[tauri::command]; thin, validates input, calls managers
├── threads/
│   ├── manager.rs       # ThreadId → ThreadHandle; concurrency cap; shutdown
│   ├── actor.rs         # owns sdk::Agent on a dedicated thread; command loop
│   ├── events.rs        # DesktopEvent (serde, ts-rs exported) ← TurnEvent mapping
│   └── questions.rs     # approvals, limit raises, secret requests: id → oneshot reply
├── agent_factory.rs     # Settings + workspace → providers, triage, MCP, skills → AgentBuilder
├── settings.rs          # providers, models, limits, guardrails, MCP; JSON in app config dir
├── cli_import.rs        # one-time import of ~/.agent86/config.toml (parsed with `toml`)
├── keys.rs              # API keys in the OS keyring (service "agent86", account = provider)
├── unstable.rs          # every agent86-core call outside `sdk` (keyring, embedder, tables)
├── sessions.rs          # opens the shared Memory; sessions list; session → workspace map
├── trust.rs             # what a project brings, hashed; trust records by that hash
├── memory_panel.rs      # facts and episodes: pages, pins, forgetting
├── secrets.rs           # the secrets panel's view of a thread's vault (names only)
├── panel_commands.rs    # the memory, secrets, and trust commands
├── desktop.rs           # window theme, tray icon with running turns, notifications
└── file_actions.rs      # open / reveal a thread's files: resolved and checked in Rust
```

**Thread actor.** `Agent::run_with_events` takes `&mut self`, and the approver, limit, and secret
callbacks are synchronous and "called on the turn's thread". So each thread gets its own OS thread
running a `current_thread` tokio runtime that owns its `Agent`. The actor receives `Prompt`,
`Cancel`, `Answer`, `Rename`, and `Close` messages. A callback blocks on a oneshot until the UI
answers. Blocking there is fine because the turn is waiting anyway, and other threads run on
their own runtimes. Cancel calls the `CancelToken` from `agent.cancel_handle()` *and* resolves any
pending question as "deny" or "none", so a blocked callback never hangs.

**Events.** `TurnEvent<'_>` borrows its data, so the actor converts each event into an owned,
serializable `DesktopEvent` and sends it on the thread's `tauri::ipc::Channel`. Channels are
ordered and much faster than global `emit`.

| `TurnEvent`                    | `DesktopEvent` → UI                                          |
| ------------------------------ | ------------------------------------------------------------ |
| `Text(s)`                      | `agentText` → streamed Markdown entry                        |
| `Thinking(s)`                  | `thought` → collapsible thought entry                        |
| `Notice(s)`                    | `notice` → system line (cancelled, guardrail, continuation)  |
| `ToolCall { call, text }`      | `toolCall { id, name, args, title }` → ToolCard (pending)    |
| `ToolResult { call, result, observation, text }` | `toolResult { id, ok, summary, output }` → ToolCard done |
| `Usage { step, session }`      | `usage` → Spend                                              |
| `Compacted { notice, summary }`| `compacted` → compaction notice                              |
| approver callback              | `approvalRequest { qid, tool, summary, detail, lexer, warning, change, agent }` → PermissionPanel and DiffView |
| `on_limit` callback            | `limitRequest { qid, kind, offered }` → limit dialog          |
| `on_secret_request` callback   | `secretRequest { qid, name, reason, replacing }` → SecretPrompt |
| turn end (`RunResult`/`RunError`) | `turnEnded { stopReason, turnSummary, usage }` / `turnFailed { error }` |

**Approvals beyond yes or no.** The SDK approver returns only `bool`. "Allow always for this
thread", or for a tool, is kept in the actor (an allow-set the closure checks before asking the
UI), so the existing PermissionPanel options still work.

**Agent construction (`agent_factory.rs`).**
`Agent::builder()` with `.provider(...)` (OpenAI-compatible, Anthropic, Google, or Ollama, from
settings plus a keyring key), `.workspace(dir)`, `.builtins(Builtins::All)`,
`.approval(ApprovalMode::Ask)`, `.approver(...)`, `.memory(shared)`, `.session(id)` to resume,
`.skills_dir(...)`, `.subagents(SubAgents::new()...)`, `.model(...)`/`.triage(...)`, `.mcp_server(...)`,
limits, `.guardrails(...)`, `.trace_dir(...)`, `.on_limit(...)`, `.on_secret_request(...)`.
Changing model or approval mode mid-thread rebuilds the agent with `.with_conversation(current)`.

### 3.2 Front end (`src/`)

- **Start from a copy of `agent86-web/packages/web/src`** (about 6.8k lines). Keep `markdown/`,
  `highlight/`, `tools/`, `thread/`, `shell/` (Tabs, Sidebar, InlineRename), `secrets/`,
  `memory/`, and `trust/`.
- **Replace `@agent86-web/acp-client` and `api.ts`** with `desktop-client/`:
  - `backend.ts`: a `Backend` interface (`listSessions`, `openThread`, `prompt`, `cancel`,
    `answer`, `settings`, `keys`, `memory`, `pickFolder`, ...) implemented with `@tauri-apps/api`
    `invoke` and `Channel`.
  - `session-state.ts`: port acp-client's reducer so it folds `DesktopEvent`s, not ACP
    `SessionUpdate`s, into the **same state shape** (`UserEntry`, `AgentEntry`, `ThoughtEntry`,
    `ToolEntry`, `FileDiff`, ...). Components keep working with small changes.
  - Types for `DesktopEvent` and the command payloads are generated from Rust (`ts-rs` or
    `tauri-specta`), so the IPC contract is checked at compile time.
- **Drop:** `token.ts`, the login flow, `useBridge`, bridge logs, and WebSocket reconnect and
  generation handling.
- **Change:** `WorkspacePicker` uses the native folder dialog (`tauri-plugin-dialog`) and a
  recent-workspaces list. Add a **Settings** screen for providers and models, API keys, limits,
  guardrails, and MCP servers, plus a first-run wizard.

### 3.3 Desktop-only features

- Native notifications when an approval is waiting or a long turn finishes in a background tab
  (`tauri-plugin-notification`).
- Window state persistence, single instance, and an optional tray icon showing running turns.
- Auto-update (`tauri-plugin-updater`) from GitHub Releases.
- "Open in editor" and "Reveal in Explorer/Finder" for files in tool cards (`tauri-plugin-opener`),
  limited to paths inside the workspace.

---

## 4. Configuration, keys, and data

The SDK discovers nothing, so the app decides what to share with the CLI.

| Data                | Location                                                     | Shared with CLI?     |
| ------------------- | ------------------------------------------------------------ | -------------------- |
| App settings        | `{appConfigDir}/settings.json` (providers, models, limits, MCP, UI prefs) | No (import option below) |
| API keys            | OS keyring, service `agent86`, account = provider name (agent86-core's `SERVICE_NAME`) | **Yes**: `agent86 keys set openrouter` works in both |
| Sessions and memory | `~/.agent86/memory.db` through `sdk::Memory`                 | **Yes**: same schema |
| Traces              | `~/.agent86/traces` or the app data dir                      | Configurable         |
| Trust records       | `{appConfigDir}/trusted-projects.json`                       | No                   |
| Remembered secrets  | OS keyring (per project)                                     | Match the CLI if feasible |

- **Embedder compatibility:** the CLI writes memory with `sentence-transformers:all-MiniLM-L6-v2`.
  `Memory::open` uses the offline `hash:256` embedder, and "episodes and facts written with one
  embedder are only found again with the same one". To really share memory we need the
  `local-embeddings` feature and `Memory::open_with(...)` with the same model, which uses the
  unstable `build_embedder`. Decided: share it (D2).
- **Import from CLI config (M5):** parse `~/.agent86/config.toml` ourselves with `toml`
  (providers, model routes, limits, MCP servers) and offer to copy it into settings. We don't
  depend on agent86-core's hidden `config` module because it has no stability promise.
- **Project config:** a project's `.agent86/skills/`, specialists dir, and MCP servers are loaded
  only after the user trusts the project. Trust records the hash of what is loaded, and the
  agent86-web TrustDialog and TrustBanner are reused.

---

## 5. Security

- **Tauri capabilities:** the webview gets only our commands plus dialog, notification, and
  opener scoped to what is needed. No `fs` or `shell` plugin is exposed to JavaScript. Every file
  and command action happens in Rust, through the SDK's jail and sandbox.
- **Strict CSP** (no inline scripts, `connect-src` limited to IPC). Markdown is rendered without
  raw HTML, as in agent86-web.
- **Approvals cannot be skipped by the UI:** answers are matched to an outstanding `qid` owned by
  the actor. Unknown or stale ids are ignored.
- **Secrets** never cross IPC back to the webview after entry. The UI sees names only, and the
  model sees `${secret:NAME}`.
- **Workspace paths** from the UI are canonicalized in Rust, and `opener` calls must resolve
  inside the thread's workspace.
- **Release builds:** signed (Windows Authenticode, Apple notarization), updater signatures, and
  dependency auditing in CI (`cargo deny`, `pnpm audit`).

---

## 6. Repository layout

```
agent86-desktop/
├── docs/                  # this plan, ARCHITECTURE.md, ADRs, UI notes
├── package.json           # pnpm; vite, react, tailwind, @tauri-apps/api, plugins
├── index.html, vite.config.ts, tsconfig.json
├── src/                   # React app (derived from agent86-web/packages/web)
│   ├── desktop-client/    # Backend interface, Tauri impl, event reducer, generated types
│   ├── settings/          # new: providers, keys, limits, MCP, first-run
│   └── ...                # markdown/, highlight/, tools/, thread/, shell/, secrets/, memory/, trust/
├── src-tauri/
│   ├── Cargo.toml         # tauri 2, agent86-core = "=1.1.0", tokio, serde, ts-rs, keyring
│   ├── tauri.conf.json, capabilities/
│   └── src/               # see 3.1
└── .github/workflows/     # ci.yml (lint, test, build); release.yml (tauri-action matrix)
```

---

## 7. Milestones

| #      | Milestone          | Done when                                                                                       |
| ------ | ------------------ | ----------------------------------------------------------------------------------------------- |
| **M0** | Scaffold           | `pnpm tauri dev` opens a window; Tauri 2, React 19, Vite, Tailwind; `agent86-core` compiles on Windows (MSRV 1.94); CI builds on all three OSes |
| **M1** | One turn end to end | Hard-coded provider and key from the keyring; one thread; prompt → streamed text, thoughts, tool cards; cancel works. *As built:* the model comes from the CLI's `~/.agent86/config.toml` through agent86-core's loader and provider factory (`src-tauri/src/cli_config.rs`), a stopgap until M5; no approver yet, so side-effecting tools are declined |
| **M2** | Approvals and questions | PermissionPanel and DiffView driven by the approver; allow-always set; limit raise dialog; SecretPrompt; cancel unblocks pending questions. *As built:* `src-tauri/src/threads/questions.rs` brokers every question by id and kind; "allow always" is per tool for the thread; secrets are held for the thread only (the SDK keeps no keyring) |
| **M3** | UI port            | Transcript, tool cards, Markdown, highlighting, Spend, PromptInput, slash commands (`/skills`, `/agents`, `/tools`, `Turn::skill`, `Turn::specialist`), `@` file mentions via a Rust file walker. *As built:* IPC types generated by ts-rs (CI checks they are current); `@` mentions are inlined by Rust inside the jail (the CLI, not the SDK, does this for agent86); skills and specialists are the user-level ones until project trust (M6); sub-agents' own tool calls are not shown yet (M6) |
| **M4** | Threads and sessions | Multiple tabs with parallel turns; session list from `Memory::sessions`; resume with `.session(id)`; transcript rebuilt from `Conversation::messages`; rename; concurrency cap. *As built:* one shared `Memory` opened with the CLI's embedder and retention; agent86 records no folder per session, so the app keeps its own map (`session-workspaces.json` in its config dir), reads agent86's `acp-sessions.json` as a hint, and otherwise asks; a session open in one tab is refused in another; at most 8 threads |
| **M5** | Settings and onboarding | Settings UI (providers, models, triage, limits, guardrails, MCP); key management; first-run wizard; import from `~/.agent86/config.toml`. *As built:* `settings.json` (versioned, defaults equal to agent86's built-ins) holds providers with an explicit adapter kind, the default model, triage, per-model context windows, limits, guardrails (approval mode included), MCP servers, sub-agents, skills, memory, and the CLI's `[pricing.models]`; providers are built from it with the SDK's public adapters (`agent_factory.rs`), and `cli_config.rs` is gone. The import parses `config.toml` with `toml` and lays it over agent86's built-in provider sections; it skips `[sandbox]` and `[observability]` and does not apply `AGENT86_MODEL` or project files. Keys use agent86-core's own keyring code (the Windows layout is Python keyring's), so `agent86 keys set` and the app share entries; the UI sees only where a key comes from. MCP values expand `${NAME}` from the environment, then the keyring, as the CLI does. What is still outside `sdk` (keyring, embedder, context-window and price tables, title cleaning) is all in `unstable.rs`. Memory settings apply after a restart; open threads keep their settings |
| **M6** | Memory, secrets, trust, skills | Memory panel (facts, pins), secrets panel, project trust for skills, specialists, and MCP; sub-agents with worktree display. *As built:* the memory panel (sidebar, or `/memory`) lists facts and episodes from the shared database a page at a time, pins and forgets them, with pins in agent86's own table as the CLI keeps them. Each thread keeps a handle to its agent's secret vault, attached to the OS keyring with the CLI's per-project layout, so secrets remembered in either load in both; the secrets panel (`/secrets`, or the thread header) lists names, adds, remembers, and forgets, and the secret prompt can remember too. A project's skills (`.agent86/skills`, `.claude/skills`), specialists (`.agent86/agents`), and the MCP servers in its `.agent86/config.toml` load only once trusted; trust is the SHA-256 of every file that would load, in `trusted-projects.json`, so any change asks again (the CLI, by contrast, loads project skills and agents without asking and trusts only the config file). Trusting reloads the thread: a new agent takes over the conversation and secrets (`reload_thread`, also offered in the header for new settings). Sub-agents report through the harness's observer onto the delegate call's card (a `/agent` turn gets a card of its own): their calls, nested runs, notices, and spend; an isolated run's `[worktree]` note shows as a worktree panel with its path, branch, files, and diff. Found upstream: agent86-core 1.1.0's `/agent` (`Turn::specialist`) ignores `isolation: worktree` and runs in the workspace (approvals still ask); `delegate` isolates |
| **M7** | Desktop polish     | Notifications, tray, window state, single instance, open/reveal file, light and dark themes, keyboard shortcuts. *As built:* every plugin (notification, opener, window-state, single-instance, plus Tauri's tray) is used from Rust only, so the webview's capabilities are still just `core:default`. Settings has an Appearance section (`ui` in `settings.json`): theme (system, light, or dark; `data-theme` on `<html>` plus the native title bar), notifications (on by default), and the tray icon (off by default), applied on save. A notification goes out when an approval, limit, or secret question waits, or a turn of 30 s or more ends, while its tab is hidden or the window is not focused; clicking one brings the window forward on that tab (on Windows only while the toast is on screen, and debug builds post under PowerShell's identity). The tray's tooltip and menu say how many turns run and in which folders (the count also sits beside the macOS menu-bar icon), with Show and Quit. Window size and place are kept in `window-state.json` beside the settings. A second launch brings the running app forward; a separate `AGENT86_DESKTOP_CONFIG_DIR` runs as an instance of its own. Tool cards and worktree panels offer open and reveal (`open_path`): Rust takes a relative path from the workspace, canonicalizes it, and allows it only inside the workspace or a worktree the thread's sub-agents kept (recorded from agent86's `[worktree]` notes); programs, scripts, and shortcuts are only revealed, never opened. Shortcuts work anywhere in the window: Ctrl/⌘ T new thread, W close tab, Ctrl+Tab and Ctrl+Shift+Tab (also Ctrl+PageDown/PageUp, ⌘⇧] and ⌘⇧[), 1-8 and 9 for tabs, L focus the prompt, `.` stop the turn, `,` Settings; Settings lists them. Not verified by hand: a notification click on Windows (popup toasts are out of UI Automation's reach), and anything on macOS and Linux beyond CI |
| **M8** | Ship               | Signed installers (MSI/NSIS, DMG, AppImage/deb), updater, release workflow, user docs, v1.0.0 |

---

## 8. Testing

- **Rust:** a scripted `MockProvider` implementing `sdk::providers::Provider` (no network) drives
  actor tests: event ordering, approvals (allow, deny, cancel while pending), limit and secret
  flows, resume, and concurrent threads. `cargo test`, `clippy -D warnings`, `cargo fmt --check`.
- **Front end:** Vitest. Port agent86-web's component and reducer tests; reducer tests use
  recorded `DesktopEvent` fixtures.
- **IPC contract:** generated TS types are checked in. CI fails if regenerating changes them.
- **End to end:** Playwright against the Vite build with `@tauri-apps/api/mocks` (fast, every
  PR), plus a smaller WebDriver (`tauri-driver`) suite against the real app with the mock
  provider on Windows and Linux.
- **Manual:** a real-provider smoke checklist per release.

---

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Memory facts and pins, and the CLI-compatible embedder (required by D2), need `Memory::store()` and `build_embedder`, which have no semver promise | Pin `agent86-core = "=1.1.0"`; isolate in `unstable.rs`; ask upstream to promote these into `sdk` (same author) |
| `local-embeddings` (candle, tokenizers, enabled per D2) roughly doubles dependencies and binary size, and lengthens three-OS CI builds | Cache cargo builds in CI; measure installer size in M0 |
| Blocking callbacks on the turn thread could deadlock on cancel or close | Cancel and close always resolve pending questions; test it |
| The UI is coupled to ACP-shaped state (`ToolKind`, `locations`, ACP diff content) | Keep the state shape; derive kind and locations from tool name and args in Rust; use `ApprovalPreview.change` for diffs |
| Replayed sessions lack rich tool output | Same limitation agent86-web has with `session/load`; show text-only cards |
| Two codebases drift (web vs desktop UI) | D1: fork for now; extract a shared UI package later if needed |
| Code signing costs and setup (Apple developer account, Windows cert) | Plan for M8; unsigned dev builds before that |

---

## 10. Decisions (2026-11-19)

- **D1. UI reuse: fork.** `agent86-web/packages/web/src` is copied into this repo and adapted. A
  shared UI package can be extracted later if drift becomes a problem.
- **D2. Share `~/.agent86/memory.db` with the CLI.** The app enables agent86-core's
  `local-embeddings` feature and opens memory with the CLI's embedder
  (`sentence-transformers:all-MiniLM-L6-v2`) through `Memory::open_with`, which means accepting
  the unstable `build_embedder` and the larger build. API keys are shared through the keyring.
- **D3. Settings: app-owned `settings.json`** in the app config dir, with a one-time import from
  `~/.agent86/config.toml`.
- **D4. Platforms: Windows, macOS, and Linux together** from M0. CI builds and tests all three on
  every PR.

## 11. Open questions

- **Q5. Alternative architecture.** Implement an in-process ACP agent in Rust over the SDK (with
  the `agent-client-protocol` crate) so the existing `acp-client` and UI run almost unchanged
  through a Tauri transport. This gives more reuse but means rebuilding agent86's ACP mapping and
  extensions. The typed-IPC design above is recommended instead.
- **Q6. Product name and identifier** (e.g. `com.maetek.agent86.desktop`), icons, and licensing (MIT like the others?).
