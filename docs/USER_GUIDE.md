# Agent 86 user guide

Agent 86 is a desktop app for the [agent86](https://github.com/Maetek-Technologies/agent86) coding
agent. The agent runs inside the app: there is no separate `agent86` program, server, or browser to
set up. It shares API keys, sessions, and memory with the agent86 CLI, so you can start work in one
and carry on in the other.

## Install

Download the installer for your system from the
[latest release](https://github.com/Maetek-Technologies/agent86-desktop/releases/latest).

| System                | File                                                                        |
| --------------------- | --------------------------------------------------------------------------- |
| Windows 10 and 11     | `Agent 86_<version>_x64-setup.exe` (installs for you only, no admin prompt); or the `.msi` for an install for all users |
| macOS, Apple Silicon  | `Agent 86_<version>_aarch64.dmg`                                            |
| macOS, Intel          | `Agent 86_<version>_x64.dmg`                                                |
| Linux                 | `.AppImage` (any distribution; updates itself), or `.deb` / `.rpm`          |

Windows needs WebView2, which Windows 11 already has (the installer fetches it on Windows 10 if
needed). On Linux the `.deb` and `.rpm` pull in WebKitGTK; the AppImage carries what it needs.

### The first time you open it

Until the app is code-signed, your system may warn about it:

- **Windows:** SmartScreen says "Windows protected your PC". Choose **More info**, then **Run
  anyway**.
- **macOS:** if macOS says the app "can't be opened" or "is damaged", open **System Settings,
  Privacy & Security** and choose **Open Anyway**, or run
  `xattr -dr com.apple.quarantine "/Applications/Agent 86.app"` once.
- **Linux (AppImage):** make it executable (`chmod +x Agent*.AppImage`) and run it.

## Set up a model

The first start offers two ways in:

- **Use your agent86 CLI settings.** If you use the CLI, the app finds `~/.agent86/config.toml` and
  shows what it would bring over: providers, models, triage, limits, guardrails, MCP servers, and
  prices. It is a one-time copy; later changes on either side stay on that side.
- **Set up a provider.** Pick one (OpenRouter, Anthropic, OpenAI, Google, Ollama, vLLM, and other
  OpenAI-compatible servers), give the model name and, if it needs one, an API key. **Test** sends
  a one-line request to check the address, the key, and the model.

API keys go to your system's keyring (Windows Credential Manager, macOS Keychain, or the Secret
Service on Linux) under the same entries `agent86 keys set <provider>` uses, so a key stored by
either works in both. A provider's key variable (such as `OPENROUTER_API_KEY`), when set, wins.
Keys are never written to the settings file, and the app never shows them again.

Everything else is under **Settings** (Ctrl+, or ⌘,): models and triage, providers and keys,
limits, guardrails and approvals, MCP servers, sub-agents and skills, memory, trusted projects,
appearance, and updates. Threads opened after a change use it; an open thread picks it up with
**Reload** in its header. To try another model in one thread only, use its header's model menu
(below).

## Threads

**New thread** (Ctrl+T or ⌘T) asks for a workspace folder. The agent works only inside it: files
outside are out of reach, and commands run in agent86's sandbox. Each thread is a tab; threads run
in parallel (up to eight open at once), and a tab that needs you shows **waiting for you**.

In the prompt:

- **Enter** sends, **Shift+Enter** starts a new line, **↑** and **↓** go through what you sent before.
- **`/`** lists commands: `/skills`, `/agents`, `/tools`, `/memory`, `/secrets`, a skill by name
  (`/code-reviewer check src/`), or a specialist (`/agent explorer find the parser`).
- **`@`** mentions a file in the workspace; its contents go to the model with your message.
- **Esc** stops a running turn (or closes a menu).

**Changing a thread's model.** Click the model's name in the thread's header. The menu lists the
models your settings name and every model each provider reports (OpenRouter, OpenAI, Anthropic,
Google, Ollama, vLLM, LM Studio); type to filter, or type `provider:model` to use one that is not
listed. The thread switches between turns and keeps its conversation; other threads and your
settings are unchanged. A thread on a model of its own shows a dot beside the name, and its menu
offers **The settings' model** to go back.

The agent's answer streams in with its thinking (folded) and a card for each tool call. Cards for
edits show the diff; reads show the file, highlighted; commands show their output. The header shows
the model, how full its context is, and what the thread has spent. A model's context window is the
one set for it in the settings if there is one, else what its server reports (OpenRouter's
catalogue, a vLLM server's `max_model_len`, LM Studio, Google), else agent86's built-in table.

### Approvals

**Permissions per thread.** The 🛡 button in a thread's header sets what the agent may do there:
**Ask** before each change and command, **Auto** (make changes and run commands without asking), or
**Read-only** (every change and command is refused; reading still works). It applies to that thread
only, between turns, and keeps the conversation and its "always allow" choices; **Use the settings'
mode** goes back to the default from **Settings, Guardrails**. A dot beside it means the thread has
a mode of its own.

Anything that changes your files or runs a command asks first, unless you chose otherwise in
**Settings, Guardrails**. The approval shows exactly what would happen (the diff, the command) and
offers **Allow once**, **Always allow** that tool in this thread, or **Reject**. If a turn reaches a
limit (steps, output), you can raise it for this turn or stop. If the agent needs a secret (a token,
a password), it asks for it by name: the value goes to the tools that need it as an environment
variable and the model only ever sees `${secret:NAME}`.

### Surfaces the agent draws

When a form, a choice, or a confirmation is easier than a question in prose, the agent can draw it:
a few fields to fill in, options to pick from, a slider, a date, buttons. This is **agent86UI**,
agent86's implementation of Google's [A2UI](https://a2ui.org) protocol (agent86 is not affiliated
with or endorsed by Google). The agent describes the surface; the app draws it with its own
widgets, so nothing the model writes runs as code.

- **Where it shows.** A surface appears in the conversation where the agent drew it, inside a
  dashed, blue-tinted frame headed **⧉ Drawn by the agent** and the model's name. When the agent
  changes it later, it changes in place. Anything inside that frame comes from the model, not from
  the app: the app's own questions (approvals, limits, secrets) never look like it, and the app
  never asks for permission or a password inside it.
- **Answering.** Fill it in and press its button. Usually your answer becomes your next message
  (it shows as **⧉ You pressed** *submit* **on** *form*; click it for what was sent) and starts a
  turn. If you press it while the agent is still working, the frame says **Sends when the turn
  ends** and it goes as soon as that turn is over. Pressing **Stop** drops it.
- **After you send.** The surface locks so nothing is sent twice: its fields and buttons grey out
  and the frame says **Sent**. To change your answer, click **Change and send again**. When the
  agent changes the surface (to show a result, say), it unlocks by itself. A button that only
  opens a link does not lock anything.
- **When the agent waits.** For something it cannot go on without, the agent waits for you: the
  frame says **The agent is waiting for your answer here** and takes the keyboard. Press the
  surface's button to answer, or **Dismiss** (or **Esc**) to let it carry on without one (the
  surface stays, and you can still answer later). **Stop** ends the wait too.
- **Links.** A surface's button may open a web page. The app shows you the whole address and where
  it goes first, and opens it in your browser only if you agree. Only `http` and `https` links open.
- **Pictures, video, and sound** show only from files inside the thread's workspace (or embedded in
  the surface). Media from the web is not loaded, so a surface cannot track you or send data out
  through an address.
- **Secrets never go through a surface.** agent86 refuses a password field in a surface; the agent
  asks for a secret through the app's own secret prompt instead.
- **Reopening.** When you reopen a session, its surfaces come back where they were, as you last
  left them. What you typed into a field but never sent is not kept.

### Questions from the agent

When the agent needs to know something before it can go on (where you're leaving from, which kind
of trip you want, a date), it asks with a short form instead of in its reply. agent86 builds the
form from the agent's questions, so it always works, whatever the model.

- **Where it shows.** Right below the agent's **? Questions** line, in the same dashed, blue-tinted
  frame as the surfaces above, headed **? Questions from the agent** and the model's name. The
  questions and their options are the model's words; the app's own approvals and secret prompts
  never look like this.
- **Answering.** The form takes the keyboard at once: type in a field, pick an option, Tab to the
  next question. A question with options also offers **Other**: pick it and say it in your own
  words in the field below. **Send answers** stays greyed until every question not marked
  (optional) has an answer.
- **Not answering.** **Dismiss** (or **Esc**) closes the questions without answering: the agent
  carries on with what it knows and doesn't ask the same questions again in that turn. **Stop**
  ends the turn.
- **Afterwards.** The form stays in the conversation, locked, so you can see what was asked and
  what you answered; its frame says **Answered**, **Dismissed, nothing was sent**, or **Not
  answered**. The **? Questions** line above it opens to the same answers as plain text. When you
  reopen a session the form itself doesn't come back, but that line does, open, with your answers.
- **In another tab**, the tab shows **waiting for you**, and a notification says the agent has
  questions (when notifications are on).

### Sessions

Every thread is saved as it goes, in the same database the CLI uses (`~/.agent86/memory.db`). The
sidebar lists recent sessions, from the app and the CLI; click one to reopen it. To rename one,
hover it in the sidebar and click ✎, or double-click a tab's title (or press F2 on the tab). A
session the app has not seen before asks which folder it belongs to.

### Sub-agents and worktrees

The agent can hand work to sub-agents (`delegate`) and to specialists you define. Their own tool
calls show inside the card that started them. A specialist with `isolation: worktree` works in a
separate git worktree: nothing it changes touches your workspace, and its card shows the branch, the
files, and the diff so you can merge it yourself.

### Files on tool cards

A card's file has **open** (in its default app) and **reveal** (in Explorer, Finder, or your file
manager). Only files inside the thread's workspace, or a worktree its sub-agents kept, can be
opened. Programs and scripts are only revealed, never opened, so a file the agent wrote cannot run
by a click.

### Reading Markdown documents

A Markdown file on a card (`.md`, `.markdown`) also has **view**: it opens rendered, in a pane beside
the conversation, the way GitHub shows it: headings, lists and task lists, tables, `> [!NOTE]`
alerts, footnotes, highlighted code, and front matter as a folded table. A finished reply has
**View as document** (under it, when you point at it) to open it in the same pane.

- **Rendered** and **Raw** switch between the document and its source. **Contents** lists its
  headings; click one to go there.
- **Links:** web and mail links open in your browser or mail app. A link to another Markdown file in
  the workspace opens it in the pane (**←** goes back); a link to any other file, or a reference
  such as `src/app.ts:42`, opens that file in its default app, with the same rules as **open**.
  Links to anything else are shown, not followed.
- **Images are never loaded,** as in replies: each shows as **[image: …]**, a link you can follow
  if you want to see it. Raw HTML in a document shows as text. Math and Mermaid diagrams show as
  their source for now.
- Drag the pane's left edge to resize it (the app remembers the width); **✕** or **Esc** closes it.
  Each thread has its own pane. Files over 2 MB, or not UTF-8 text, are not shown.

## Memory, secrets, and projects

- **Memory** (sidebar, or `/memory`) lists the facts and episodes the agent remembers, shared with
  the CLI. Pin what should stay; forget what should not.
- **Secrets** (thread header, or `/secrets`) lists the secrets a thread holds, by name only. Add one,
  or keep one for the project in the keyring so threads opened there later (in the app or the CLI)
  have it.
- **Project trust.** A workspace can bring its own skills (`.agent86/skills`, `.claude/skills`),
  specialists (`.agent86/agents`), and MCP servers (`.agent86/config.toml`). They load only after
  you review and trust them, and again after any change to them. **Settings, Projects** lists the
  projects you trust.

## Logs

**Logs** in the sidebar (or `/logs` in a thread) shows two records, newest first:

- **Activity:** what the agent did, from agent86's activity log: each turn's start and end, every
  model call (model, tokens in and out, cost, why it stopped, which tools it asked for), every tool
  call (with its arguments and whether it worked), guardrail hits, and errors. Filter by kind
  (turns, model calls, tool calls, or problems), by the thread you are in, or by any text; the top
  line adds up the tokens and cost of what is shown. Click an event for all its details.
- **App log:** what the app itself did: starting, settings saved, threads opened and closed, turns
  started and ended, model and permission changes, update checks, and anything that went wrong.
  Tick **Warnings and errors only** to see just the problems.

**Live** refreshes the view every two seconds; **Reveal file** shows the file in Explorer or
Finder. Secrets are scrubbed from the activity log before it is written, and large text is clipped;
the file rotates at 50 MB. Turn it off, or move it, in **Settings, Logs**. By default it is the
agent86 CLI's own (`~/.agent86/traces/trace.jsonl`), so `agent86 trace` and the app share one
record.

## Appearance, notifications, and shortcuts

**Settings, Appearance** sets the theme (as the system, light, or dark), notifications, and a tray
(menu bar) icon that shows how many turns are running. Notifications tell you when a thread in the
background needs an approval, a limit raise, a secret, or your answers to the agent's questions or
a surface it waits on, and when a turn of 30 seconds or more ends; clicking one shows that thread. The window remembers its size and place. Opening the app
again while it runs brings the open window forward.

The sessions panel on the left hides and shows with the **‹ ›** button at the left end of the tabs
(or Ctrl+B). Drag its right edge to make it wider or narrower (or focus the edge and use the arrow
keys); double-click the edge to reset it. The app remembers both.

| Keys (⌘ on macOS)                         | Does                          |
| ----------------------------------------- | ----------------------------- |
| Ctrl+T                                    | New thread                    |
| Ctrl+W                                    | Close tab                     |
| Ctrl+Tab, Ctrl+Shift+Tab                  | Next, previous tab            |
| Ctrl+PageDown, Ctrl+PageUp (⌘⇧], ⌘⇧[)     | Next, previous tab            |
| Ctrl+1 … Ctrl+8, Ctrl+9                   | Tab 1 to 8, the last tab      |
| Ctrl+L                                    | Focus the prompt              |
| Ctrl+.                                    | Stop the running turn         |
| Ctrl+,                                    | Settings                      |
| Ctrl+B                                    | Show or hide the sessions panel |

## Updates

The app checks GitHub Releases for a newer version when it starts (turn this off in **Settings,
About**). When there is one, the sidebar says so; **Settings, About** shows the release notes and
**Download and install**. Every update is verified against the app's update key before it is
installed. On Windows the installer closes the app to update it; on macOS and with the Linux
AppImage, **Restart now** finishes. A `.deb` or `.rpm` install is updated with your package manager
(download the new package from the release).

On Windows the app never stays running as administrator: the agent's commands would run with
admin rights too. When an update of an all-users install (in `C:\Program Files`) restarts it
elevated, or you start it with **Run as administrator**, it starts itself again as you. To keep
admin rights on purpose, set the environment variable `AGENT86_DESKTOP_ALLOW_ELEVATED=1`.

## Where things are kept

| What                         | Where                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| Settings, window state, trusted projects, session folders | `%APPDATA%\com.maetek.agent86.desktop` (Windows), `~/Library/Application Support/com.maetek.agent86.desktop` (macOS), `~/.config/com.maetek.agent86.desktop` (Linux) |
| Sessions and memory          | `~/.agent86/memory.db`, shared with the CLI                                               |
| Activity log                 | `~/.agent86/traces/trace.jsonl`, shared with the CLI (Settings, Logs)                      |
| App log                      | `%LOCALAPPDATA%\com.maetek.agent86.desktop\logs` (Windows), `~/Library/Logs/com.maetek.agent86.desktop` (macOS), `~/.local/share/com.maetek.agent86.desktop/logs` (Linux) |
| API keys and kept secrets    | The system keyring, service `agent86`                                                      |

To start over, quit the app and delete the settings folder; your sessions, memory, and keys stay.
To uninstall, use **Apps** (Windows), drag the app to the Trash (macOS), or remove the package or
AppImage (Linux); the folders above are left for you to delete.

## Troubleshooting

- **"Set up a model first"** or a key problem on the start screen: open **Settings, Providers** and
  use **Test** on the model.
- **A thread will not open:** eight threads are the most at once; close one. A session already open
  in a tab opens that tab instead.
- **A project's skills or MCP servers are missing:** the project is not trusted yet, or changed since;
  look for the trust banner in its thread.
- **A note says memory fell back to another embedder:** the CLI's embedding model
  (`all-MiniLM-L6-v2`) could not be loaded, for example because it is not downloaded yet and
  **Settings, Memory** keeps the app offline. The thread still runs and is saved, but what it
  remembers is not found by the CLI, and the other way round, until the model loads.
- **Something went wrong and you are not sure what:** open **Logs**, pick **Problems** on the
  Activity tab or **Warnings and errors only** on the App log tab.
- **Report a problem:** [open an issue](https://github.com/Maetek-Technologies/agent86-desktop/issues)
  with the version from **Settings, About**.
