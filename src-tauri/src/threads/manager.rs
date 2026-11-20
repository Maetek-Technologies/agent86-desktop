//! The app's threads, by id, with the workspace each one runs in.

use super::actor::{Capabilities, EventSink, MakeBuilder, ThreadHandle};
use super::questions::Answer;
use crate::workspace_files;
use agent86_core::sdk::Turn;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use ts_rs::TS;

/// The most files one `@` search returns.
const FIND_LIMIT: usize = 50;

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
    handle: ThreadHandle,
    workspace: PathBuf,
    mention_max_bytes: u64,
}

#[derive(Default)]
pub struct ThreadManager {
    threads: Mutex<HashMap<String, Thread>>,
    next_id: AtomicU64,
}

impl ThreadManager {
    /// Start a thread in `workspace` and return its id and what its agent offers.
    pub fn open(
        &self,
        make: MakeBuilder,
        sink: EventSink,
        workspace: PathBuf,
        mention_max_bytes: u64,
    ) -> Result<(String, Capabilities), String> {
        let handle = ThreadHandle::spawn(make, sink)?;
        let capabilities = handle.capabilities().clone();
        let id = format!("t{}", self.next_id.fetch_add(1, Ordering::SeqCst) + 1);
        self.lock().insert(
            id.clone(),
            Thread {
                handle,
                workspace,
                mention_max_bytes,
            },
        );
        Ok((id, capabilities))
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

fn unknown(id: &str) -> String {
    format!("No thread with id {id:?}.")
}

#[cfg(test)]
mod tests {
    use super::*;

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
