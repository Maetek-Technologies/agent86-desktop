# agent86-desktop — Project Plan

A native desktop app for agent86: a **Tauri 2** shell whose **React** front end is derived from
[agent86-web](../../agent86-web) (`packages/web`), and whose **Rust** back end embeds the agent
in-process through [`agent86-core`](https://crates.io/crates/agent86-core) (`agent86_core::sdk`, v1.2.3).

Status: v1.0.0 released 2026-11-20 (M0-M8 done): installers for Windows, macOS (arm64 and x64), and Linux on GitHub Releases, with in-app updates. Not yet code-signed. Latest published: v1.2.1 (documents from chat links, and refresh, §7a). The version is now 1.2.2 (agent86-core 1.2.3, §7a), ready to tag; after it, the reordered queue in §7a.

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
├── file_actions.rs      # open / reveal a thread's files: resolved and checked in Rust
├── surface_media.rs     # agent86UI: the agent86-media scheme, workspace media per thread
└── surface_links.rs     # agent86UI: the http(s)-only check before a surface's link opens
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
| `Ui(&AgentMessage)` (1.2.0)    | `ui { toolCallId, message }` → the surface, at its call (`render_ui`, or `ask_user`'s form from 1.2.2) |
| `Ui::on_wait` callback         | `uiWaitRequest { qid, surfaceIds }` → the surface's frame waits (an `agent86_ask_` surface: the agent's questions) |
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
- Auto-update (`tauri-plugin-updater`) from GitHub Releases, verified with the app's update key.
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
- **agent86UI surfaces** are drawn in a frame of their own (dashed, the `--agent` hue), never in
  the warn-coloured style of agent86's approval and secret panels, and a Modal opens inside it,
  not over the app. Media loads only from `data:` URLs and the `agent86-media` scheme, which the
  CSP (`img-src`, `media-src`) allows alongside `'self'`; `asset:` is gone. A link opens only
  after the user saw the URL, and Rust opens only http and https.
- **Markdown viewer (1.2.0):** files are read only through `read_text_file`, under the same
  workspace and worktree rules as `open_path`. mdglass runs with raw HTML off, its output passes
  DOMPurify, images are never loaded (shown as links), and only http, https, and mailto links
  leave the app. Math and Mermaid stay off until their inline styles are settled with the CSP.
- **Release builds:** signed (Windows Authenticode, Apple notarization), updater signatures, and
  dependency auditing in CI (`cargo deny` with `src-tauri/deny.toml`, `pnpm audit`).

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
│   ├── Cargo.toml         # tauri 2, agent86-core = "=1.2.3", tokio, serde, ts-rs, keyring
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
| **M8** | Ship               | Signed installers (MSI/NSIS, DMG, AppImage/deb), updater, release workflow, user docs, v1.0.0. *As built:* `release.yml` runs on a `v*` tag that must match `package.json`: tauri-action (pinned) builds Windows (MSI and per-user NSIS), macOS arm64 and x64 (DMG and the `.app.tar.gz` the updater uses), and Linux (AppImage, deb, rpm) into a **draft** release with `latest.json` (NSIS preferred on Windows); a maintainer publishes it (docs/RELEASING.md). Code signing is wired but optional: Authenticode when `WINDOWS_CERTIFICATE` is set, Developer ID signing and notarization when the `APPLE_*` secrets are; until then the user guide explains SmartScreen and Gatekeeper. Updates (`updates.rs`, the plugin used from Rust): the endpoint is the latest published release's `latest.json`, the minisign public key is in tauri.conf.json, and its private key and password live outside the repo as the `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` secrets, which the workflow requires. Settings, About shows the versions, checks (also on start unless turned off, with a sidebar notice), shows the notes, and downloads and installs with progress, then restarts (on Windows the installer closes the app). Checked on Windows: a local release build makes both installers and their signatures; the check reports no published release against GitHub, finds a 1.0.1 from a local `latest.json`, and refuses a tampered download (signature) without running it. Not checked by hand: a real install-and-update cycle, macOS and Linux installers (CI builds them on the first tag). Also: `cargo deny` (advisories, licenses, sources) in CI; docs/USER_GUIDE.md for users |

---

**After 1.0.0.** A thread's header has a model menu (`ModelPicker`): the settings' models and each
provider's live list (agent86-core's catalog, in `unstable.rs`, the CLI's `/model` source), filtered
as you type, or any `provider:model`. `set_thread_model` rebuilds that thread on the model alone
(no triage), keeping its conversation; the choice is kept across Reload, and an empty choice goes
back to the settings' model. Beside it, a permission menu (`PermissionPicker`, `set_thread_approval`)
sets the thread's approval mode (Ask, Auto, Read-only = agent86's `deny`) the same way; both
choices are the thread's `ThreadOverrides`, laid over the settings on every rebuild.

**1.0.1: logs.** Each thread's agent writes agent86's flight recorder (`AgentBuilder::trace_dir`,
redacted and rotated by agent86) to `settings.trace` (on by default, the CLI's
`~/.agent86/traces`); the app logs its own events through `tauri-plugin-log` (info and up from
the app, warnings from libraries; 5 MB files, two kept; beside a separate profile's settings, else
the platform's log folder). `logs.rs` reads the end of either file (4 MB at most) for the Logs
view (`read_activity`, `read_app_log`, `reveal_log`); the view summarises events, totals tokens and
cost, filters by kind, thread, and text, and refreshes live.

**1.0.2: context windows and renaming.** A model's window is the user's figure, else what its
server reports (`remote_windows::discover_context_window`: OpenRouter's catalogue, cached a day in
the CLI's `~/.agent86/cache/model_context_windows.json`; a vLLM server's `max_model_len`; LM
Studio; Google), else agent86's table, which guesses from the name (`qwen` 32k, `claude` 200k). A
32k guess for a 131k vLLM model left about 2k tokens of conversation, so agent86-core's `fit`
dropped the user's message and Qwen's chat template refused the request ("No user query found").
An embedder that falls back to the hash one is tried once more, and the note and the log say why
it failed. Sessions are renamed from the sidebar (✎) or with F2 on a tab, besides double-clicking
its title.

**1.0.3: never elevated; a collapsible sessions panel.** An update of a per-machine (MSI) install
relaunches the app with the installer's admin token, so the agent's commands ran as administrator
and Windows would not follow the Hugging Face cache's user-made symlinks (memory fell back to the
hash embedder). `elevation.rs` checks the token first thing in `run()` and, when elevated, starts
the app again through `explorer.exe` (unelevated) and exits; it stays elevated, with a warning in
the log, under `AGENT86_DESKTOP_ALLOW_ELEVATED`, a separate profile, or a relaunch under a minute
old that came back elevated (UAC off). The sessions panel hides and shows (‹ › beside the tabs,
Mod+B) and resizes from its right edge (180 to 560 px, keys too, double-click resets), kept in
localStorage as agent86-web keeps it.

**1.1.0: agent86UI.** The agent can draw interactive UI (forms, choices, confirmations): agent86UI,
agent86's implementation of Google's A2UI 1.0 (ADR 0005 upstream; not affiliated with Google), from
agent86-core 1.2.0, now pinned. `TurnEvent`, `BuildError`, `RunError`, and `RunResult` became
`#[non_exhaustive]`; `DesktopEvent::from_turn_event` skips kinds it does not know.
- *Back end.* Each thread's agent is built with `Ui::basic().on_wait(...)` (`ThreadOptions::agent86ui`).
  `TurnEvent::Ui` becomes `ui { toolCallId, message }`; the event names no call, so `TurnMapper`
  gives it the oldest announced call without a result (agent86 announces a step's whole batch, then
  observes call by call). A waiting call is a `ui` question in `questions.rs`, answered with the
  user's `UiAction` or a dismissal, only from the surfaces it waits on, and closed on cancel. A
  press no call waits on goes to `ui_action` (`Agent::ui_action_with_events`): run now, or held
  while a turn or reload runs and run in order when it ends (the hold and the end of a turn decide
  under one lock); Stop drops what is held (`uiActionDropped`). On reopen, `OpenedThread.surfaces`
  is `Agent::surfaces()`: agent86 rebuilt them from the session's history, so nothing is stored.
- *Front end (`src/thread/surface/`).* A renderer of our own: `@a2ui/react` 0.15.0 speaks 1.0, but
  draws Lit web components in shadow DOM with Google's theme, and its `openUrl` and media
  components would all have needed replacing. `runtime/` is agent86-ui's headless runtime ported
  to TypeScript (data model, bindings, templates, the basic catalog's functions, checks, the regex
  dialect's safety rules, actions), checked against the same A2UI conformance suites
  (`runtime/fixtures`, Apache-2.0, commit in `UPSTREAM.md`). The session state keeps the A2UI
  messages as a log (the agent's, and the user's input as `updateDataModel`), and a memoized
  runtime applies its new tail. `widgets.tsx` draws the 18 basic components with the app's look
  (Text as Markdown without HTML, images, or links; icons as glyphs); `SurfaceFrame` names the
  agent; a surface sits at the call that created it and redraws in place; a `render_ui` card is a
  one-line note; a reopened surface goes after the last call in the history that drew it.
- *Safety.* Workspace media goes through `agent86-media://localhost/<thread>/<path>`
  (`surface_media.rs`): relative paths only, canonicalized inside that thread's workspace, files of
  media types only, with range requests. A custom scheme rather than Tauri's asset protocol, whose
  scope is one list for every thread and any file type. Remote media stays off (no setting yet;
  agent86's `[ui] agent86ui_remote_media` arrives with ACP in 1.2.1). `openUrl` asks first and
  `open_surface_url` refuses anything but http and https, and links with credentials in them.

**After 1.1.0: a surface locks once sent.** A2UI leaves a surface live after a press, which let a
form be sent twice. The renderer now locks a surface when the user sends an action from it
(`uiSent`): fields and buttons are disabled and the frame says **Sent**, with **Change and send
again** to unlock. Any message from the agent naming the surface unlocks it, as does a held press
that Stop dropped. A press that only runs a local function (`openUrl`) does not lock. A reopened
session's surfaces start unlocked (nothing is stored).

**1.1.2: questions from the agent (`ask_user`); agent86-core 1.2.2.** agent86 1.2.2 adds
`ask_user` (ADR 0006 upstream): the model sends a short, flat list of questions and agent86 builds
the form itself, so it is always valid. It is offered to any `Ui` with `on_wait` and the basic
catalog, so the threads get it with no new sdk API (and no way to leave it out while keeping
`render_ui`). The form arrives as `ui` events for surface `agent86_ask_<n>` (a `createSurface`: a
Column of the title, an input per question bound to `/answers/<id>`, an "Other" field bound to
`/other/<id>` per choice question, and a Send button, event `answers`, whose one `@checks` rule
holds it until every required question is answered), then an ordinary `uiWaitRequest` through the
same `on_wait` hook, then a `deleteSurface` before the call's result ("The user answered:" and the
answers as JSON, or a dismissal). `Agent::surfaces` never lists it and a reopened session does not
redraw it; `render_ui` refuses the prefix.
- *Back end.* Nothing new: `TurnMapper` already ties the form's messages to the `ask_user` call
  (the oldest open one, even when the batch announced later calls), and `Questions::ui_wait`
  answers its wait like a `render_ui` wait (only from that surface, closed on cancel). The
  scripted thread tests press Send through agent86-ui's headless runtime and check the order of
  events and the observation the model gets, and cover dismissal and Stop.
- *Front end.* A surface is now placed right after the card of the call its `ui` event names
  (`toolCallId`), not at the end, so a form sits at its `ask_user` call even in a batch. The frame
  of an `agent86_ask_` surface is headed **Questions from the agent** (never the internal id), in
  the same agent frame as any surface, since the questions are still the model's words. It takes
  input only while its wait is open. agent86's `deleteSurface` for it does not remove it: the
  reducer moves its log messages to an id of its own (`agent86_ask_<n>~<entry id>`, because a
  reload rebuilds the agent and its forms count from 1 again) and keeps it, locked, as the record
  of what was asked and answered, with the outcome the call's result names (answered, dismissed,
  not answered). The `ask_user` card (`AskUserCard`) lists the questions and the answers as text,
  folded while the form shows them, open when no form is shown (a reopened session).
- *Any waiting surface* now takes the focus when its wait opens, and Esc in it dismisses it, as the
  app's own question panels do. A wait notifies like the app's own questions (**Questions from
  the agent**, or **Answer needed** for a `render_ui` wait).
- *Other 1.2.2 changes* need nothing here: `render_ui` fills in a missing Button `context`, reads
  `{"path": ...}` as `@path`, refuses a waiting call with no event Button, and moves fields placed
  beside a message's kind inside it; broken tool-call JSON gets a longer error and is replayed as
  `{}`; `Tool::retry_hint` is a provided method. `TurnEvent` and agent86-ui's runtime (which
  `runtime/` ports) are unchanged, and `unstable.rs` builds as it was.

**agent86-core 1.2.3.** Its changes reach the threads with no work here. The `sdk` API only gains
(`AgentBuilder::verify`, `RunResult::verification`, `Provider::temperature`, a provided method), and
the app calls none of them. The local-model work (`[limits] context_sizing` and `stall_nudge`) is on
by default in the built-in limits the builder starts from, and so is the platform in the environment
line. The ACP extensions (`com.maetek.agent86/a2ui`, `com.maetek.agent86/questions`) are for ACP
clients; the app is an in-process `Ui`. agent86-ui's A2UI fixtures (the commit in
`src/thread/surface/runtime/fixtures/UPSTREAM.md`) and `TurnEvent` are unchanged, and `unstable.rs`
builds as it was. Not taken up yet: per-provider temperature and the verification gate in the app's
settings.

---

## 7a. Next releases

**1.2.0: Markdown viewer.** Released 2026-11-25 (steps 1–7 below, PR #6). Markdown the agent writes to files is shown today only as raw
source (the `new-file` detail on a tool card) or handed to another app with **open**. 1.2.0 adds a
viewer pane, rendered with [`mdglass`](https://www.npmjs.com/package/mdglass) (markdown-it, GFM
extras, highlight.js, front matter, heading list, `file:line` references). Chat replies keep
`src/markdown/Markdown.tsx` (react-markdown, block-memoized for streaming); mdglass is used only in
the viewer.

| Step | Work | Done when |
| ---- | ---- | --------- |
| 1 | `read_text_file(thread_id, path)` in `commands.rs` | Resolves through `file_roots()` and `file_actions::resolve` like `open_path` (workspace or a kept worktree only); UTF-8 only; 2 MB cap; typed result through ts-rs; Rust tests for refused paths, symlinks out of the workspace, oversized and non-UTF-8 files |
| 2 | `src/markdown/MarkdownViewer.tsx` | One mdglass renderer (`createRenderer` with front matter, GFM, highlight; **math and Mermaid off**), output set as `innerHTML` after a DOMPurify `sanitize` pass; Rendered / Raw toggle (Raw through `Highlight`); a contents list from `result.headings`; front matter as a folded table |
| 3 | Safety plugins and link handling | *Done.* `viewerLinks` (viewer-engine.ts) renders every link with `href="#"` and its target in `data-` attributes (links.ts), so the webview never follows one; images are never loaded and show as `[image: alt]` links, as in chat (SECURITY T10). One click handler in MarkdownViewer: `#id` and footnotes scroll in the document; everything else goes to `onLink`, and `followLink` (follow.ts) opens http, https, and mailto through `open_document_link` (Rust checks again: `surface_links::checked_document_link`), loads a linked `.md` through `read_text_file` (relative to the document's folder), and opens other files and `path:line` references (mdglass `fileReferences`, from the workspace) with `open_path`, whose refusal (programs, scripts, outside the workspace) is shown; anything else is text. markdown-it already drops `javascript:` and `data:` links while parsing |
| 4 | Pane in `ThreadView` | *Done.* `DocumentPane` beside the transcript, state per thread in `ThreadView` (`useDocuments`: a stack, so ← goes back from a followed link; a load that finishes after another document opened is dropped), so `Tab` and the tabs reducer are untouched. ✕ or Esc inside it closes it, and the focus goes back where it was; it takes the focus for each document. Resizable from its left edge (`ResizeHandle`, now shared with the sessions panel), 300 to 960 px and at most 70% of the thread, kept in localStorage (`agent86.document-pane.v1`) and read each time it opens. `ThreadContext` carries `openFile` and `openDocument` for step 5. Links in the viewer are styled as in chat |
| 5 | Entry points | *Done.* **view** beside open and reveal (`FileActions`) for `.md`, `.markdown`, `.mdown`, and `.mkd` paths: on tool cards (reads, new files, and edits) and a kept worktree's files; it calls `ThreadContext.openFile`. **View as document** under a finished assistant reply (shown on hover or focus, not while it streams) opens its text in the pane without a file read |
| 6 | Look | *Done.* `mdglass/styles.css` loads with the viewer's lazy chunk; `.md-document` (styles.css) sets its `--mdg-*` colours to the app's tokens on the element, so light and dark follow `theme.ts` and win over mdglass's `:root` defaults; alerts use `--hl-title`, `--ok`, `--hl-keyword`, `--warn`, and `--error`. Code is highlighted with lowlight's grammars and the app's `hljs-*` colours (step 2), boxed like chat's code blocks; inline code, links, and footnotes look as in chat; wide tables and code scroll inside the pane. No inline styles: checked in a production build under the release CSP (no violations, no `style` attributes in the document) |
| 7 | Tests and docs | *Done.* Vitest: the sanitizer and safe rendering (`viewer.test.tsx`: raw HTML as text, images, `javascript:`, plugin output), link sorting and routing (`links.test.ts`, `follow.test.ts`), the toggle and contents, the pane (`document-pane.test.tsx`), the stack (`documents.test.ts`), the entry points (`toolcard.test.tsx`, an App test from a reopened session); Rust: `read_text` and `checked_document_link`. USER_GUIDE, "Reading Markdown documents"; the README's security notes and §5 here; `docs/releases/v1.2.0.md`. The version stays 1.1.3 until the release's own bump |

Dependencies: `mdglass` 0.1.0 and `dompurify` 3.4.18 (the settled 3.4 line, not the days-old 3.5.0),
pinned. mdglass's `katex: ^0.16` has a low advisory (GHSA-238p-pmpm-9mq7, fixed in 0.18.2) that
fails `pnpm audit --prod`, so `pnpm.overrides` pins `mdglass>katex` to 0.19.1 until mdglass widens
its range; KaTeX is tree-shaken out anyway (math is off). `highlight.js` 11.11.2 is a direct
dependency for `src/highlight/hljs-common.ts`: mdglass highlights with lowlight's grammars, and
`vite.config.ts` aliases `highlight.js/lib/common` there, so the grammars are bundled once. The
viewer's renderer (`viewer-engine.ts`) is a lazy chunk. Not in 1.2.0: math, Mermaid, local images,
editing, live reload of a changed file.

**1.2.1: documents from chat links, and refresh.** Released 2026-11-25 (steps 1–6 below, PR #9). What 1.2.0 missed: the agent writes a document and links it in its
reply, and the link opens it. In 1.2.0 a chat reply's file link was plain text (Markdown.tsx let
only http, https, and mailto through), so a written file reached the pane only through a tool
card's **view**. The pane, `read_text_file`, and the link sorting (links.ts) are reused as they are.

| Step | Work | Done when |
| ---- | ---- | --------- |
| 1 | File links in chat replies | *Done.* `Markdown.tsx` sorts each link with `classifyHref`: http, https, and mailto as before; a Markdown file opens in the thread's pane (`ThreadContext.openFile`, relative paths from the workspace); any other file opens with `open_path`, whose refusal is shown beside the link; anchors and other schemes stay text. Rust's checks are unchanged (workspace or a kept worktree only). Outside a thread (no `ThreadContext`) file links stay text |
| 2 | `file://` links | *Done.* `classifyHref` takes `file:///abs/path` (and `file://localhost/…`, and `file:///C:/…` on Windows) as a file; in chat and in the viewer |
| 3 | Markdown paths in inline code | *Done.* `` `docs/plan.md` `` in a reply (no spaces or wildcards, a Markdown extension) is a link to the file, as in step 1; code blocks are untouched |
| 4 | Tell the agent | *Done.* The thread's system prompt is agent86's `BASE_IDENTITY` plus a short note (`unstable::system_prompt`): when it writes a document for the user, link it in the reply as `[title](path)` relative to the workspace |
| 5 | Refresh | *Done.* ↻ in the pane's header reads a file again in place (`useDocuments.refresh`, a `replace` action in documents.ts), for a document the agent is still writing: same entry in the stack, so ← and Rendered / Raw are kept; a file that could not be read (not written yet) is tried again. Not for a reply shown as a document; disabled while it reads. No file watcher |
| 6 | Tests and docs | *Done.* Vitest for the chat links, inline code paths, and `file://`; a Rust test that the prompt keeps agent86's identity; the pane's ↻ (`document-pane.test.tsx`, `documents.test.ts`); USER_GUIDE and `docs/releases/v1.2.1.md`. react-markdown's own URL check drops `file:` links, so chat passes them to the `a` component (`urlTransform`), which sorts them |

Not in 1.2.1: reloading a changed file by itself (↻ reads it again on request; a file watcher is a
later step).

**1.2.2: agent86-core 1.2.3.** Built (PR #11); the version is set to 1.2.2, ready to tag. Only the
agent changes: context sized to the window, compaction that keeps the task, the platform in the
system prompt, and the stall nudge, all on by default (§7, "agent86-core 1.2.3").
`docs/releases/v1.2.2.md`.

**After 1.2.2, in this order.** Collected from the notes above (not-yet-done and not-verified
items) and §8; each is a release of its own unless small enough to ride along.

| Order | Item | Why here |
| ----- | ---- | -------- |
| 1 | **End-to-end tests** (§8): Playwright against the Vite build with `@tauri-apps/api/mocks` on every PR, then a small `tauri-driver` suite with the mock provider on Windows and Linux | Planned in §8 and not built; 1.2.0 adds the first `innerHTML` rendering, and every later item is safer with UI coverage |
| 2 | **Release verification**: a real install-and-update cycle on all three OSes; notification clicks on Windows; macOS and Linux checks beyond CI (M7, M8 gaps) | Needed before signing makes installs look trusted |
| 3 | **Code signing**: Authenticode and Apple Developer ID with notarization (wired in `release.yml`, secrets missing) | Removes the SmartScreen and Gatekeeper steps from the user guide; waits on certificates |
| 4 | **Math and Mermaid in the viewer** | Needs a CSP decision: KaTeX sets inline `style=` and Mermaid adds `<style>` to its SVGs, both blocked in release builds. Try KaTeX's MathML output first; loosen `style-src-attr` only by an explicit decision; load Mermaid lazily (several MB) |
| 5 | **agent86UI remote media setting**, once agent86's `[ui] agent86ui_remote_media` is in an agent86-core release we pin | Off today with no setting (1.1.0) |
| 6 | **Upstream asks**: promote `Memory::store`, `build_embedder`, the keyring, and the catalogue out of `unstable.rs` into `sdk`; fix `/agent` (`Turn::specialist`) ignoring `isolation: worktree` | Lets the `=` pin on agent86-core relax (§9); depends on agent86's schedule |
| 7 | **Shared UI package with agent86-web** (D1) | Only if drift starts to cost; the Markdown viewer is a candidate to share |

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
| Memory facts and pins, and the CLI-compatible embedder (required by D2), need `Memory::store()` and `build_embedder`, which have no semver promise | Pin `agent86-core = "=1.2.3"`; isolate in `unstable.rs`; ask upstream to promote these into `sdk` (same author) |
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
