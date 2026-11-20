//! The app's threads, by id, with the workspace each one runs in.

use super::actor::{Capabilities, EventSink, MakeBuilder, ThreadHandle, ThreadOptions};
use super::events::{DesktopEvent, SubagentUpdate};
use super::history::HistoryItem;
use super::questions::Answer;
use crate::workspace_files;
use agent86_core::sdk::Turn;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use ts_rs::TS;

/// The most files one `@` search returns.
const FIND_LIMIT: usize = 50;

/// The most threads open at once (agent86-web's `--max-agents` default). Each holds an agent and
/// an OS thread; closing a tab frees one.
pub const MAX_THREADS: usize = 8;

/// A thread just opened.
#[derive(Debug)]
pub struct Opened {
    pub id: String,
    pub capabilities: Capabilities,
    pub session_id: String,
    pub history: Vec<HistoryItem>,
    /// Secrets remembered for the project that the thread loaded.
    pub loaded_secrets: Vec<String>,
}

/// One turn, as the UI asks for it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum TurnRequest {
    /// A message for the model. `mentions` are the `@` paths the user picked; their files are
    /// inlined into what the model sees.
    Goal { text: String, mentions: Vec<String> },
    /// A skill run directly (`/<skill> <task>`).
    Skill { name: String, task: String },
    /// A specialist sub-agent run directly (`/agent <name> <task>`).
    Specialist {
        name: String,
        task: String,
        with_context: bool,
    },
}

struct Thread {
    /// Shared, so a reload can wait on the actor without holding the map's lock.
    handle: Arc<ThreadHandle>,
    workspace: PathBuf,
    mention_max_bytes: u64,
    /// The git worktrees isolated sub-agents of this thread left behind (agent86's `[worktree]`
    /// note), so their files can be opened as the workspace's can.
    worktrees: Arc<Mutex<Vec<PathBuf>>>,
    /// The model chosen for this thread in its header (`provider:model`), instead of the
    /// settings' default and triage. Kept across reloads.
    model: Mutex<Option<String>>,
}

#[derive(Default)]
pub struct ThreadManager {
    threads: Mutex<HashMap<String, Thread>>,
    next_id: AtomicU64,
}

impl ThreadManager {
    /// Start a thread in `workspace`, continuing session `resume` if given. Refused when
    /// [`MAX_THREADS`] are open, or when that session is already open in another thread (two
    /// agents saving one session would overwrite each other).
    pub fn open(
        &self,
        make: MakeBuilder,
        sink: EventSink,
        workspace: PathBuf,
        mention_max_bytes: u64,
        resume: Option<&str>,
        options: ThreadOptions,
    ) -> Result<Opened, String> {
        {
            let threads = self.lock();
            if threads.len() >= MAX_THREADS {
                return Err(format!(
                    "{MAX_THREADS} threads are open, the most at once. Close one first."
                ));
            }
            if let Some(id) = resume {
                if threads.values().any(|t| t.handle.session_id() == id) {
                    return Err("That session is already open in another tab.".into());
                }
            }
        }
        let worktrees = Arc::new(Mutex::new(Vec::new()));
        let handle = ThreadHandle::spawn(make, record_worktrees(sink, worktrees.clone()), options)?;
        let capabilities = handle.capabilities();
        let loaded_secrets = handle.loaded_secrets().to_vec();
        let session_id = handle.session_id().to_owned();
        let history = handle.take_history();
        let id = format!("t{}", self.next_id.fetch_add(1, Ordering::SeqCst) + 1);
        self.lock().insert(
            id.clone(),
            Thread {
                handle: Arc::new(handle),
                workspace,
                mention_max_bytes,
                worktrees,
                model: Mutex::new(None),
            },
        );
        Ok(Opened {
            id,
            capabilities,
            session_id,
            history,
            loaded_secrets,
        })
    }

    pub fn prompt(&self, id: &str, request: TurnRequest) -> Result<(), String> {
        self.with(id, |thread| {
            let turn = match request {
                TurnRequest::Goal { text, mentions } => Turn::Goal(workspace_files::expand(
                    &thread.workspace,
                    &text,
                    &mentions,
                    thread.mention_max_bytes,
                )?),
                TurnRequest::Skill { name, task } => Turn::skill(name, task),
                TurnRequest::Specialist {
                    name,
                    task,
                    with_context,
                } => {
                    let turn = Turn::specialist(name, task);
                    if with_context {
                        turn.with_context()
                    } else {
                        turn
                    }
                }
            };
            thread.handle.prompt(turn)
        })
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        self.with(id, |thread| {
            thread.handle.cancel();
            Ok(())
        })
    }

    pub fn answer(&self, id: &str, qid: u64, answer: Answer) -> Result<(), String> {
        self.with(id, |thread| thread.handle.answer(qid, answer))
    }

    /// The thread's workspace files matching `query`, for the `@` menu.
    pub fn find_files(&self, id: &str, query: &str) -> Result<Vec<String>, String> {
        let workspace = self.with(id, |thread| Ok(thread.workspace.clone()))?;
        // Walked outside the lock, so a big workspace does not hold up other threads.
        Ok(workspace_files::find(&workspace, query, FIND_LIMIT))
    }

    /// The workspace thread `id` runs in.
    pub fn workspace(&self, id: &str) -> Result<PathBuf, String> {
        self.with(id, |thread| Ok(thread.workspace.clone()))
    }

    /// The folders thread `id` may open files in: its workspace, then the worktrees its
    /// sub-agents kept.
    pub fn file_roots(&self, id: &str) -> Result<Vec<PathBuf>, String> {
        self.with(id, |thread| {
            let mut roots = vec![thread.workspace.clone()];
            roots.extend(
                thread
                    .worktrees
                    .lock()
                    .map(|w| w.clone())
                    .unwrap_or_default(),
            );
            Ok(roots)
        })
    }

    /// The model chosen for thread `id`, if one was.
    pub fn model(&self, id: &str) -> Result<Option<String>, String> {
        self.with(id, |thread| {
            Ok(thread.model.lock().map(|m| m.clone()).unwrap_or_default())
        })
    }

    /// Remember `model` as thread `id`'s choice (after its agent was rebuilt with it).
    pub fn set_model(&self, id: &str, model: Option<String>) -> Result<(), String> {
        self.with(id, |thread| {
            if let Ok(mut chosen) = thread.model.lock() {
                *chosen = model;
            }
            Ok(())
        })
    }

    /// The workspaces of the threads running a turn now, for the tray.
    pub fn running(&self) -> Vec<PathBuf> {
        self.lock()
            .values()
            .filter(|thread| thread.handle.is_busy())
            .map(|thread| thread.workspace.clone())
            .collect()
    }

    /// Rebuild thread `id`'s agent from `make`, keeping its conversation and secrets. Only
    /// between turns. The agent is built outside the map's lock.
    pub fn reload(&self, id: &str, make: MakeBuilder) -> Result<Capabilities, String> {
        let handle = self.with(id, |thread| Ok(thread.handle.clone()))?;
        handle.reload(make)
    }

    /// Thread `id`'s secrets: names, held or remembered for the project.
    pub fn secrets(&self, id: &str) -> Result<crate::unstable::ThreadSecrets, String> {
        self.with(id, |thread| Ok(thread.handle.secrets()))
    }

    /// Close a thread: cancels its turn, if any, and lets its actor exit.
    pub fn close(&self, id: &str) -> Result<(), String> {
        self.lock().remove(id).map(drop).ok_or_else(|| unknown(id))
    }

    fn with<T>(&self, id: &str, f: impl FnOnce(&Thread) -> Result<T, String>) -> Result<T, String> {
        let threads = self.lock();
        let thread = threads.get(id).ok_or_else(|| unknown(id))?;
        f(thread)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Thread>> {
        // A panic while holding the lock leaves the map itself intact.
        self.threads
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// `sink`, noting in `worktrees` every worktree a sub-agent's result says was kept, its own or
/// a nested one's.
fn record_worktrees(sink: EventSink, worktrees: Arc<Mutex<Vec<PathBuf>>>) -> EventSink {
    Arc::new(move |event| {
        let output = match &event {
            DesktopEvent::ToolResult { output, .. } => Some(output),
            DesktopEvent::Subagent {
                update: SubagentUpdate::ToolResult { output, .. },
                ..
            } => Some(output),
            _ => None,
        };
        if let Some(path) = output.and_then(|output| kept_worktree(output)) {
            if let Ok(mut kept) = worktrees.lock() {
                if !kept.contains(&path) {
                    kept.push(path);
                }
            }
        }
        sink(event)
    })
}

/// Where agent86's `[worktree]` note in `output` says the worktree is kept, if it says so.
pub fn kept_worktree(output: &str) -> Option<PathBuf> {
    let note = output.find("[worktree] This ran in a git worktree")?;
    let rest = &output[note..];
    const KEPT: &str = "the worktree is kept at ";
    let start = rest.find(KEPT)? + KEPT.len();
    let rest = &rest[start..];
    let end = rest.find(" on branch ")?;
    let path = rest[..end].trim();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

fn unknown(id: &str) -> String {
    format!("No thread with id {id:?}.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kept_worktrees_are_read_from_agent86s_note() {
        let output = "Done.

[worktree] This ran in a git worktree of HEAD (abc1234), not in                       your workspace. Nothing was applied: the worktree is kept at                       /tmp/agent86-wt-1-0-2/sub on branch agent86/wt-1. Its changes:
```diff
```";
        assert_eq!(
            kept_worktree(output),
            Some(PathBuf::from("/tmp/agent86-wt-1-0-2/sub"))
        );
        // One that changed nothing was removed; a mention elsewhere does not count.
        assert_eq!(
            kept_worktree("[worktree] This ran in a git worktree of HEAD (a). It changed nothing."),
            None
        );
        assert_eq!(
            kept_worktree("the worktree is kept at /x on branch y"),
            None
        );
    }

    #[test]
    fn turn_requests_deserialize_from_the_ui_shape() {
        let goal: TurnRequest =
            serde_json::from_str(r#"{"kind":"goal","text":"hi","mentions":["a.rs"]}"#).unwrap();
        assert_eq!(
            goal,
            TurnRequest::Goal {
                text: "hi".into(),
                mentions: vec!["a.rs".into()]
            }
        );
        let specialist: TurnRequest = serde_json::from_str(
            r#"{"kind":"specialist","name":"reviewer","task":"look","withContext":true}"#,
        )
        .unwrap();
        assert_eq!(
            specialist,
            TurnRequest::Specialist {
                name: "reviewer".into(),
                task: "look".into(),
                with_context: true
            }
        );
    }
}
