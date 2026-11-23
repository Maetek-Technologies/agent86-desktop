//! One thread: an `agent86_core::sdk::Agent` owned by an OS thread of its own.
//!
//! `Agent::run_with_events` takes `&mut self`, and the SDK's approval, limit, and secret callbacks
//! are synchronous and run on the turn's thread (see `questions.rs`). So each thread gets a
//! dedicated OS thread with a current-thread tokio runtime: a callback can block until the UI
//! answers without holding up any other thread, and the agent never moves between threads.
//!
//! Cancelling does not go through the command queue (the actor is busy inside the turn). The
//! handle sets a `cancel_requested` flag and trips the agent's [`CancelToken`] directly. The flag
//! exists because agent86-core clears the token when a turn starts ("a cancel requested while no
//! turn was running must not kill this one"), which would swallow a cancel sent between
//! [`ThreadHandle::prompt`] and that point; a watcher running beside the turn re-applies it.
//!
//! A thread can be rebuilt between turns ([`ThreadHandle::reload`]: new settings, a project just
//! trusted): a new agent takes over the conversation and the secrets the old one held.
//!
//! A button pressed on an agent86UI surface when no call waits on it ([`ThreadHandle::ui_action`])
//! runs a turn of its own. Pressed while a turn (or a reload) runs, it is held and runs as soon as
//! that ends, in the order pressed; a cancel drops what is held. Deciding to hold, and the actor
//! deciding at a turn's end whether anything is held, both happen under the hold's lock, so an
//! action is never left behind.

use super::events::{DesktopEvent, StopReason, TurnInfo, TurnMapper, UsageInfo};
use super::history::{self, HistoryItem};
use super::questions::{Answer, Questions, UiAction};
use crate::unstable::{self, ThreadSecrets};
use agent86_core::sdk::{Agent, AgentBuilder, CancelToken, Turn, Ui};
use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use ts_rs::TS;

/// Where a thread's events go: the UI's channel in the app, a collector in tests.
pub type EventSink = Arc<dyn Fn(DesktopEvent) + Send + Sync>;

/// Builds the agent's builder on the actor's thread, inside its runtime.
pub type MakeBuilder = Box<dyn FnOnce() -> Result<AgentBuilder, String> + Send>;

/// How often the watcher re-applies a requested cancel the harness cleared.
const CANCEL_WATCH_INTERVAL: Duration = Duration::from_millis(20);

enum Command {
    Run(Work),
    Reload(MakeBuilder, mpsc::Sender<Result<Built, String>>),
}

/// What a turn starts from.
enum Work {
    Prompt(Turn),
    /// A button pressed on a surface when no call was waiting on it.
    Action(UiAction),
}

/// What a thread's agent offers, as built: for the `/` menu and the `/tools`, `/skills`, and
/// `/agents` lists.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Capabilities {
    /// Skills, run with `/<name> <task>`.
    pub skills: Vec<String>,
    /// Specialist sub-agents, run with `/agent <name> <task>`.
    pub specialists: Vec<String>,
    /// The tools the model is offered.
    pub tools: Vec<String>,
}

/// How a thread is set up beyond its builder.
#[derive(Debug, Clone, Default)]
pub struct ThreadOptions {
    /// Remember secrets for this workspace in the OS keyring and load what was remembered, as
    /// the CLI does. `None` keeps secrets for the thread only (tests never touch the keyring).
    pub keyring_workspace: Option<PathBuf>,
    /// Offer the model agent86UI (`render_ui` with the A2UI basic catalog), and with it, since
    /// agent86-core 1.2.2, `ask_user`, whose questions agent86 builds into a form of the same
    /// catalog. Their surfaces arrive as [`DesktopEvent::Ui`].
    pub agent86ui: bool,
}

/// An agent as built: what the handle keeps of it.
struct Built {
    cancel: CancelToken,
    capabilities: Capabilities,
    secrets: ThreadSecrets,
}

/// What the actor reports once its first agent is built.
struct Started {
    built: Built,
    session_id: String,
    history: Vec<HistoryItem>,
    /// The surfaces the reopened session's history rebuilt (agent86UI).
    surfaces: Vec<serde_json::Value>,
    /// Secrets remembered for the project and loaded into the thread.
    loaded_secrets: Vec<String>,
}

/// State the handle and the actor share.
struct Shared {
    busy: AtomicBool,
    /// Shared with [`Questions`] too, so a cancel answers any open question "no".
    cancel_requested: Arc<AtomicBool>,
    /// Surface actions pressed while the thread was busy, oldest first. Its lock also orders
    /// `busy` between [`ThreadHandle::ui_action`] and the actor's end of a turn.
    held: Mutex<VecDeque<UiAction>>,
}

impl Shared {
    /// At the end of a turn or a reload: the next held action to run (the thread stays busy),
    /// or `None` and the thread is free. After a cancel, everything held is dropped and
    /// returned as the second value.
    fn next_held(&self, cancelled: bool) -> (Option<UiAction>, Vec<UiAction>) {
        let mut held = self.held.lock().unwrap_or_else(|p| p.into_inner());
        let dropped = if cancelled {
            held.drain(..).collect()
        } else {
            Vec::new()
        };
        let next = held.pop_front();
        if next.is_none() {
            self.busy.store(false, Ordering::SeqCst);
        }
        (next, dropped)
    }
}

/// The UI side of a thread. Dropping it cancels any running turn and lets the actor exit.
pub struct ThreadHandle {
    commands: mpsc::Sender<Command>,
    shared: Arc<Shared>,
    questions: Arc<Questions>,
    /// The current agent's cancel token, capabilities, and secrets (a reload replaces them).
    built: Mutex<Built>,
    session_id: String,
    /// The reopened session's conversation; taken once by whoever opened the thread.
    history: Mutex<Vec<HistoryItem>>,
    /// The surfaces its history rebuilt, each as one `createSurface`; taken with the history.
    surfaces: Mutex<Vec<serde_json::Value>>,
    loaded_secrets: Vec<String>,
}

/// Build an agent from `make`, with the thread's question callbacks, its vault attached to the
/// keyring if asked, and its sub-agents reported to `sink`. Call inside the actor's runtime
/// (building may start MCP servers).
fn build(
    make: MakeBuilder,
    questions: &Arc<Questions>,
    sink: &EventSink,
    options: &ThreadOptions,
) -> Result<(Agent, Built, Vec<String>), String> {
    let (approve, limit, secret, wait) = (
        questions.clone(),
        questions.clone(),
        questions.clone(),
        questions.clone(),
    );
    let mut builder = make()?
        // Every question goes to the UI and waits for its answer (M2).
        .approver(move |tool, preview| approve.approve(tool, preview))
        .on_limit(move |hit| limit.raise_limit(hit))
        .on_secret_request(move |request| secret.secret(request));
    if options.agent86ui {
        // A surface a call waits on is a question like the others: one at a time, and never
        // once the turn is cancelled. That is a waiting `render_ui` call's surface, or the form
        // agent86 builds for `ask_user` (offered because this `Ui` can wait and has the basic
        // catalog; agent86 draws it, waits here, and takes it down, with no code of ours).
        builder = builder.ui(Ui::basic().on_wait(move |request| wait.ui_wait(request)));
    }
    let agent = builder.build().map_err(|error| error.to_string())?;
    let secrets = ThreadSecrets::of(&agent);
    let loaded = match &options.keyring_workspace {
        Some(workspace) => secrets.attach_keyring(workspace),
        None => Vec::new(),
    };
    let events = sink.clone();
    unstable::observe_subagents(&agent, secrets.clone(), move |card, announced, update| {
        events(DesktopEvent::Subagent {
            card,
            announced,
            update,
        })
    });
    questions.set_secrets(secrets.clone());
    let built = Built {
        cancel: agent.cancel_handle(),
        capabilities: Capabilities {
            skills: agent.skills(),
            specialists: agent.specialists(),
            tools: agent.tool_names(),
        },
        secrets,
    };
    Ok((agent, built, loaded))
}

impl ThreadHandle {
    /// Start the actor and build its agent. Returns once the agent is built, or with the build
    /// error (a bad workspace, an MCP server that would not start).
    pub fn spawn(
        make: MakeBuilder,
        sink: EventSink,
        options: ThreadOptions,
    ) -> Result<Self, String> {
        let (commands, inbox) = mpsc::channel::<Command>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<Started, String>>();
        let shared = Arc::new(Shared {
            busy: AtomicBool::new(false),
            cancel_requested: Arc::new(AtomicBool::new(false)),
            held: Mutex::new(VecDeque::new()),
        });
        let actor_shared = shared.clone();
        let questions = Questions::new(sink.clone(), shared.cancel_requested.clone());
        let actor_questions = questions.clone();

        std::thread::Builder::new()
            .name("agent86-thread".into())
            .spawn(move || {
                let questions = actor_questions;
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = ready_tx.send(Err(format!("could not start a runtime: {error}")));
                        return;
                    }
                };
                let built = {
                    let _entered = runtime.enter();
                    build(make, &questions, &sink, &options)
                };
                let (mut agent, built, loaded_secrets) = match built {
                    Ok(built) => built,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                let mut cancel = built.cancel.clone();
                let mut secrets = built.secrets.clone();
                let started = Started {
                    built,
                    session_id: agent.session_id().to_owned(),
                    history: history::from_conversation(agent.conversation()),
                    // agent86 rebuilt them from the session's `render_ui` calls; nothing of the
                    // app's own is stored.
                    surfaces: agent
                        .surfaces()
                        .iter()
                        .filter_map(|message| serde_json::to_value(message).ok())
                        .collect(),
                    loaded_secrets,
                };
                if ready_tx.send(Ok(started)).is_err() {
                    return;
                }

                // A held action the last turn or reload handed on, run before anything new.
                let mut next: Option<Work> = None;
                loop {
                    let command = match next.take() {
                        Some(work) => Command::Run(work),
                        None => match inbox.recv() {
                            Ok(command) => command,
                            Err(_) => break,
                        },
                    };
                    match command {
                        Command::Reload(make, reply) => {
                            let rebuilt = {
                                let _entered = runtime.enter();
                                build(make, &questions, &sink, &options)
                            };
                            let answer = rebuilt.map(|(new, built, _)| {
                                built.secrets.carry_over(&secrets);
                                agent = new.with_conversation(agent.conversation().clone());
                                cancel = built.cancel.clone();
                                secrets = built.secrets.clone();
                                built
                            });
                            if answer.is_err() {
                                // The old agent stays; its vault answers questions again.
                                questions.set_secrets(secrets.clone());
                            }
                            next = actor_shared.next_held(false).0.map(Work::Action);
                            let _ = reply.send(answer);
                        }
                        Command::Run(work) => {
                            let events = sink.clone();
                            let mut mapper = TurnMapper::default();
                            let on_event = move |event: agent86_core::sdk::TurnEvent<'_>| {
                                if let Some(event) = mapper.map(&event) {
                                    events(event)
                                }
                            };
                            if let Work::Action(action) = &work {
                                sink(DesktopEvent::UiActionStarted {
                                    action: action.clone(),
                                });
                            }
                            let result = runtime.block_on(async {
                                let turn = async {
                                    match work {
                                        Work::Prompt(turn) => {
                                            agent.run_with_events(turn, on_event).await
                                        }
                                        Work::Action(action) => {
                                            agent
                                                .ui_action_with_events(action.into(), on_event)
                                                .await
                                        }
                                    }
                                };
                                let watch = async {
                                    loop {
                                        if actor_shared.cancel_requested.load(Ordering::SeqCst)
                                            && !cancel.is_cancelled()
                                        {
                                            cancel.cancel();
                                        }
                                        tokio::time::sleep(CANCEL_WATCH_INTERVAL).await;
                                    }
                                };
                                // Biased: the turn is polled first, so its start (where the
                                // harness clears the token) runs before the watcher looks.
                                tokio::select! {
                                    biased;
                                    result = turn => result,
                                    never = watch => never,
                                }
                            });
                            let cancelled = actor_shared.cancel_requested.load(Ordering::SeqCst);
                            let end = match result {
                                Ok(run) => DesktopEvent::TurnEnded {
                                    stop_reason: if cancelled {
                                        StopReason::Cancelled
                                    } else {
                                        StopReason::EndTurn
                                    },
                                    answer: run.answer,
                                    turn: run.turn.as_ref().map(TurnInfo::from),
                                    usage: UsageInfo::from(&run.usage),
                                },
                                Err(_) if cancelled => DesktopEvent::TurnEnded {
                                    stop_reason: StopReason::Cancelled,
                                    answer: String::new(),
                                    turn: None,
                                    usage: UsageInfo::from(&agent.conversation().usage()),
                                },
                                Err(error) => DesktopEvent::TurnFailed {
                                    error: error.to_string(),
                                },
                            };
                            // Free (unless an action is held) before announcing the end, so the UI
                            // can send the next prompt as soon as it hears it.
                            let (held, dropped) = actor_shared.next_held(cancelled);
                            next = held.map(Work::Action);
                            sink(end);
                            for action in dropped {
                                sink(DesktopEvent::UiActionDropped { action });
                            }
                        }
                    }
                }
            })
            .map_err(|error| format!("could not start a thread: {error}"))?;

        let started = ready_rx
            .recv()
            .map_err(|_| "the thread stopped while starting".to_owned())??;
        Ok(Self {
            commands,
            shared,
            questions,
            built: Mutex::new(started.built),
            session_id: started.session_id,
            history: Mutex::new(started.history),
            surfaces: Mutex::new(started.surfaces),
            loaded_secrets: started.loaded_secrets,
        })
    }

    pub fn capabilities(&self) -> Capabilities {
        self.lock_built().capabilities.clone()
    }

    /// The thread's secrets (the current agent's vault).
    pub fn secrets(&self) -> ThreadSecrets {
        self.lock_built().secrets.clone()
    }

    /// Secrets remembered for the project that the thread loaded when it started.
    pub fn loaded_secrets(&self) -> &[String] {
        &self.loaded_secrets
    }

    /// The agent86 session this thread continues (or started).
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// The reopened session's conversation, once; empty for a new session.
    pub fn take_history(&self) -> Vec<HistoryItem> {
        std::mem::take(
            &mut self
                .history
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    /// The surfaces the reopened session's history rebuilt, once; empty for a new session.
    pub fn take_surfaces(&self) -> Vec<serde_json::Value> {
        std::mem::take(
            &mut self
                .surfaces
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    /// Start a turn. Refused while one is running: agent86 runs one turn at a time per agent.
    pub fn prompt(&self, turn: impl Into<Turn>) -> Result<(), String> {
        let turn = turn.into();
        let empty = match &turn {
            Turn::Goal(text) => text.trim().is_empty(),
            Turn::Skill { name, .. } => name.trim().is_empty(),
            Turn::Specialist { name, task, .. } => name.trim().is_empty() || task.trim().is_empty(),
        };
        if empty {
            return Err("The prompt is empty.".into());
        }
        if self.shared.busy.swap(true, Ordering::SeqCst) {
            return Err("A turn is already running in this thread.".into());
        }
        self.start(Work::Prompt(turn))
    }

    /// Hand the model a button pressed on a surface no call waits on: it runs a turn now, or,
    /// while the thread is busy, as soon as it is free. Returns whether it was held. agent86
    /// checks the surface and component when the turn starts (a failure is a `turnFailed`).
    pub fn ui_action(&self, action: UiAction) -> Result<bool, String> {
        let mut held = self
            .shared
            .held
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.shared.busy.swap(true, Ordering::SeqCst) {
            held.push_back(action);
            return Ok(true);
        }
        drop(held);
        self.start(Work::Action(action)).map(|()| false)
    }

    /// Start `work` on the actor; the caller has just made the thread busy.
    fn start(&self, work: Work) -> Result<(), String> {
        self.shared.cancel_requested.store(false, Ordering::SeqCst);
        self.lock_built().cancel.clear();
        self.commands.send(Command::Run(work)).map_err(|_| {
            self.shared.busy.store(false, Ordering::SeqCst);
            "This thread has stopped.".to_owned()
        })
    }

    /// Rebuild the thread's agent from `make`, keeping its conversation and secrets. Refused
    /// while a turn runs. Returns the new agent's capabilities; on failure the old agent stays.
    pub fn reload(&self, make: MakeBuilder) -> Result<Capabilities, String> {
        if self.shared.busy.swap(true, Ordering::SeqCst) {
            return Err("Wait for the turn to end before reloading the thread.".into());
        }
        let (reply, answer) = mpsc::channel();
        if self.commands.send(Command::Reload(make, reply)).is_err() {
            self.shared.busy.store(false, Ordering::SeqCst);
            return Err("This thread has stopped.".into());
        }
        let built = answer
            .recv()
            .map_err(|_| "The thread stopped while reloading.".to_owned())??;
        let capabilities = built.capabilities.clone();
        *self.lock_built() = built;
        Ok(capabilities)
    }

    /// Answer question `qid` of the running turn.
    pub fn answer(&self, qid: u64, answer: Answer) -> Result<(), String> {
        self.questions.answer(qid, answer)
    }

    /// Stop the running turn at its next safe point, answering any open question "no". Does
    /// nothing when idle.
    pub fn cancel(&self) {
        if self.shared.busy.load(Ordering::SeqCst) {
            self.shared.cancel_requested.store(true, Ordering::SeqCst);
            self.lock_built().cancel.cancel();
        }
    }

    /// A turn (or a reload) is running.
    pub fn is_busy(&self) -> bool {
        self.shared.busy.load(Ordering::SeqCst)
    }

    fn lock_built(&self) -> std::sync::MutexGuard<'_, Built> {
        self.built
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Drop for ThreadHandle {
    fn drop(&mut self) {
        // The command channel closes with `self`, so the actor exits after this turn.
        self.cancel();
    }
}
