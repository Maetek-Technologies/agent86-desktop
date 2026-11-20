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

use super::events::{DesktopEvent, StopReason, TurnInfo, UsageInfo};
use super::questions::{Answer, Questions};
use agent86_core::sdk::{AgentBuilder, CancelToken};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

/// Where a thread's events go: the UI's channel in the app, a collector in tests.
pub type EventSink = Arc<dyn Fn(DesktopEvent) + Send + Sync>;

/// Builds the agent's builder on the actor's thread, inside its runtime.
pub type MakeBuilder = Box<dyn FnOnce() -> Result<AgentBuilder, String> + Send>;

/// How often the watcher re-applies a requested cancel the harness cleared.
const CANCEL_WATCH_INTERVAL: Duration = Duration::from_millis(20);

enum Command {
    Prompt(String),
}

/// State the handle and the actor share.
struct Shared {
    busy: AtomicBool,
    /// Shared with [`Questions`] too, so a cancel answers any open question "no".
    cancel_requested: Arc<AtomicBool>,
}

/// The UI side of a thread. Dropping it cancels any running turn and lets the actor exit.
pub struct ThreadHandle {
    commands: mpsc::Sender<Command>,
    cancel: CancelToken,
    shared: Arc<Shared>,
    questions: Arc<Questions>,
}

impl ThreadHandle {
    /// Start the actor and build its agent. Returns once the agent is built, or with the build
    /// error (a bad workspace, an MCP server that would not start).
    pub fn spawn(make: MakeBuilder, sink: EventSink) -> Result<Self, String> {
        let (commands, inbox) = mpsc::channel::<Command>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<CancelToken, String>>();
        let shared = Arc::new(Shared {
            busy: AtomicBool::new(false),
            cancel_requested: Arc::new(AtomicBool::new(false)),
        });
        let actor_shared = shared.clone();
        let questions = Questions::new(sink.clone(), shared.cancel_requested.clone());
        let (approve, limit, secret) = (questions.clone(), questions.clone(), questions.clone());

        std::thread::Builder::new()
            .name("agent86-thread".into())
            .spawn(move || {
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
                // Building may start MCP servers, which need the runtime.
                let built = {
                    let _entered = runtime.enter();
                    make().and_then(|builder| {
                        builder
                            // Every question goes to the UI and waits for its answer (M2).
                            .approver(move |tool, preview| approve.approve(tool, preview))
                            .on_limit(move |hit| limit.raise_limit(hit))
                            .on_secret_request(move |request| secret.secret(request))
                            .build()
                            .map_err(|error| error.to_string())
                    })
                };
                let mut agent = match built {
                    Ok(agent) => agent,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                let cancel = agent.cancel_handle();
                if ready_tx.send(Ok(cancel.clone())).is_err() {
                    return;
                }

                while let Ok(command) = inbox.recv() {
                    match command {
                        Command::Prompt(text) => {
                            let events = sink.clone();
                            let result = runtime.block_on(async {
                                let turn = agent.run_with_events(text.as_str(), |event| {
                                    events(DesktopEvent::from_turn_event(&event))
                                });
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
                            // Free before announcing the end, so the UI can send the next prompt
                            // as soon as it hears it.
                            actor_shared.busy.store(false, Ordering::SeqCst);
                            sink(end);
                        }
                    }
                }
            })
            .map_err(|error| format!("could not start a thread: {error}"))?;

        let cancel = ready_rx
            .recv()
            .map_err(|_| "the thread stopped while starting".to_owned())??;
        Ok(Self {
            commands,
            cancel,
            shared,
            questions,
        })
    }

    /// Start a turn. Refused while one is running: agent86 runs one turn at a time per agent.
    pub fn prompt(&self, text: String) -> Result<(), String> {
        if text.trim().is_empty() {
            return Err("The prompt is empty.".into());
        }
        if self.shared.busy.swap(true, Ordering::SeqCst) {
            return Err("A turn is already running in this thread.".into());
        }
        self.shared.cancel_requested.store(false, Ordering::SeqCst);
        self.cancel.clear();
        self.commands.send(Command::Prompt(text)).map_err(|_| {
            self.shared.busy.store(false, Ordering::SeqCst);
            "This thread has stopped.".to_owned()
        })
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
            self.cancel.cancel();
        }
    }

    #[cfg(test)]
    pub fn is_busy(&self) -> bool {
        self.shared.busy.load(Ordering::SeqCst)
    }
}

impl Drop for ThreadHandle {
    fn drop(&mut self) {
        // The command channel closes with `self`, so the actor exits after this turn.
        self.cancel();
    }
}
