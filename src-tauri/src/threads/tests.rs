//! Thread actor tests against a scripted provider: no network, no model, no keyring.

use super::actor::ThreadHandle;
use super::events::{DesktopEvent, StopReason};
use agent86_core::sdk::providers::{
    Completion, CompletionDelta, CompletionRequest, DeltaStream, Provider, ProviderError,
};
use agent86_core::sdk::{Agent, ApprovalMode, Builtins, ToolCall};
use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

enum Reply {
    Text(&'static str),
    Tool(&'static str, Value),
    /// A stream that never yields, until the turn is cancelled.
    Hang,
}

struct Scripted {
    replies: Mutex<VecDeque<Reply>>,
}

impl Scripted {
    fn new(replies: Vec<Reply>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into()),
        })
    }
}

impl Provider for Scripted {
    fn name(&self) -> &str {
        "scripted"
    }

    fn model(&self) -> &str {
        "scripted-model"
    }

    fn stream(&self, _request: CompletionRequest) -> DeltaStream<'_> {
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Reply::Text("(script ended)"));
        let done = |completion: Completion| CompletionDelta {
            done: true,
            completion: Some(completion),
            ..CompletionDelta::default()
        };
        match reply {
            Reply::Hang => futures_util::stream::pending().boxed(),
            Reply::Text(text) => futures_util::stream::iter([
                Ok(CompletionDelta {
                    text: text.to_owned(),
                    ..CompletionDelta::default()
                }),
                Ok(done(Completion {
                    text: text.to_owned(),
                    ..Completion::default()
                })),
            ])
            .boxed(),
            Reply::Tool(name, arguments) => {
                let arguments: Map<String, Value> = arguments.as_object().cloned().unwrap();
                futures_util::stream::iter([Ok(done(Completion {
                    tool_calls: vec![ToolCall {
                        id: "call-1".into(),
                        name: name.into(),
                        arguments,
                    }],
                    ..Completion::default()
                }))])
                .boxed()
            }
        }
    }

    fn fresh(&self) -> Result<Arc<dyn Provider>, ProviderError> {
        Ok(Scripted::new(Vec::new()))
    }
}

struct Harness {
    thread: ThreadHandle,
    events: mpsc::Receiver<DesktopEvent>,
}

fn start(replies: Vec<Reply>, workspace: &Path, builtins: Builtins) -> Result<Harness, String> {
    let provider: Arc<dyn Provider> = Scripted::new(replies);
    let workspace = workspace.to_owned();
    let (tx, events) = mpsc::channel();
    let tx = Mutex::new(tx);
    let thread = ThreadHandle::spawn(
        Box::new(move || {
            Ok(Agent::builder()
                .provider(provider)
                .workspace(workspace)
                .builtins(builtins)
                .approval(ApprovalMode::Ask))
        }),
        Arc::new(move |event| {
            let _ = tx.lock().unwrap().send(event);
        }),
    )?;
    Ok(Harness { thread, events })
}

impl Harness {
    /// Every event up to and including the turn's end.
    fn until_end(&self) -> Vec<DesktopEvent> {
        let mut seen = Vec::new();
        loop {
            let event = self
                .events
                .recv_timeout(Duration::from_secs(180))
                .unwrap_or_else(|_| panic!("the turn did not end; saw {seen:#?}"));
            let end = matches!(
                event,
                DesktopEvent::TurnEnded { .. } | DesktopEvent::TurnFailed { .. }
            );
            seen.push(event);
            if end {
                return seen;
            }
        }
    }
}

fn agent_text(events: &[DesktopEvent]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            DesktopEvent::AgentText { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

#[test]
fn a_text_turn_streams_and_ends() {
    let dir = tempfile::tempdir().unwrap();
    let h = start(
        vec![Reply::Text("hello there")],
        dir.path(),
        Builtins::ReadOnly,
    )
    .unwrap();
    h.thread.prompt("say hello".into()).unwrap();
    let events = h.until_end();
    assert_eq!(agent_text(&events), "hello there");
    match events.last().unwrap() {
        DesktopEvent::TurnEnded {
            stop_reason,
            answer,
            ..
        } => {
            assert_eq!(*stop_reason, StopReason::EndTurn);
            assert_eq!(answer, "hello there");
        }
        other => panic!("expected the turn to end, got {other:?}"),
    }
    assert!(!h.thread.is_busy());
}

#[test]
fn a_tool_call_is_announced_then_its_result() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("notes.txt"), "hi").unwrap();
    let h = start(
        vec![
            Reply::Tool("list_dir", json!({"path": "."})),
            Reply::Text("one file"),
        ],
        dir.path(),
        Builtins::ReadOnly,
    )
    .unwrap();
    h.thread.prompt("what is here?".into()).unwrap();
    let events = h.until_end();

    let call = events
        .iter()
        .position(|e| matches!(e, DesktopEvent::ToolCall { name, .. } if name == "list_dir"))
        .expect("a list_dir call");
    let result = events
        .iter()
        .position(|e| matches!(e, DesktopEvent::ToolResult { id, .. } if id == "call-1"))
        .expect("its result");
    assert!(call < result);
    match &events[result] {
        DesktopEvent::ToolResult { ok, output, .. } => {
            assert!(ok);
            assert!(output.contains("notes.txt"), "output was {output:?}");
        }
        _ => unreachable!(),
    }
    assert_eq!(agent_text(&events), "one file");
}

#[test]
fn a_write_with_nobody_to_approve_it_is_declined() {
    let dir = tempfile::tempdir().unwrap();
    let h = start(
        vec![
            Reply::Tool(
                "write_file",
                json!({"path": "evil.txt", "content": "should not exist"}),
            ),
            Reply::Text("could not write"),
        ],
        dir.path(),
        Builtins::Files,
    )
    .unwrap();
    h.thread.prompt("write a file".into()).unwrap();
    let events = h.until_end();
    let declined = events.iter().any(
        |e| matches!(e, DesktopEvent::ToolResult { name, ok, .. } if name == "write_file" && !ok),
    );
    assert!(
        declined,
        "write_file should fail without approval: {events:#?}"
    );
    assert!(!dir.path().join("evil.txt").exists());
}

#[test]
fn cancel_stops_a_running_turn_and_a_second_prompt_is_refused_meanwhile() {
    let dir = tempfile::tempdir().unwrap();
    let h = start(
        vec![Reply::Hang, Reply::Text("after")],
        dir.path(),
        Builtins::ReadOnly,
    )
    .unwrap();
    h.thread.prompt("take forever".into()).unwrap();
    assert!(h.thread.is_busy());
    assert!(h.thread.prompt("again".into()).is_err());

    std::thread::sleep(Duration::from_millis(200));
    h.thread.cancel();
    let events = h.until_end();
    assert!(
        matches!(
            events.last().unwrap(),
            DesktopEvent::TurnEnded {
                stop_reason: StopReason::Cancelled,
                ..
            }
        ),
        "expected a cancelled end: {events:#?}"
    );

    // The thread is usable again, and the cancel does not leak into the next turn.
    h.thread.prompt("now answer".into()).unwrap();
    let events = h.until_end();
    assert_eq!(agent_text(&events), "after");
    assert!(matches!(
        events.last().unwrap(),
        DesktopEvent::TurnEnded {
            stop_reason: StopReason::EndTurn,
            ..
        }
    ));
}

#[test]
fn a_cancel_sent_right_after_the_prompt_is_not_lost() {
    let dir = tempfile::tempdir().unwrap();
    let h = start(vec![Reply::Hang], dir.path(), Builtins::ReadOnly).unwrap();
    h.thread.prompt("go".into()).unwrap();
    h.thread.cancel();
    let events = h.until_end();
    assert!(matches!(
        events.last().unwrap(),
        DesktopEvent::TurnEnded {
            stop_reason: StopReason::Cancelled,
            ..
        }
    ));
}

#[test]
fn an_empty_prompt_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let h = start(vec![], dir.path(), Builtins::ReadOnly).unwrap();
    assert!(h.thread.prompt("   ".into()).is_err());
    assert!(!h.thread.is_busy());
}

#[test]
fn a_missing_workspace_fails_to_start() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("nope");
    assert!(start(vec![], &missing, Builtins::ReadOnly).is_err());
}

/// A real turn against the model in the agent86 CLI's config, through the same path the app
/// uses. Needs that model to be reachable (and its key, if it has one), so it only runs when
/// asked: `cargo test real_model -- --ignored --nocapture`.
#[test]
#[ignore]
fn real_model_smoke() {
    let config = crate::cli_config::load().expect("CLI config");
    let setup = crate::cli_config::model_setup(&config).expect("model");
    eprintln!(
        "model: {} (window {})",
        setup.reference, setup.context_window
    );
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("hello.txt"), "hi").unwrap();
    let workspace = dir.path().to_owned();
    let (tx, events) = mpsc::channel();
    let tx = Mutex::new(tx);
    let thread = ThreadHandle::spawn(
        Box::new(move || {
            Ok(Agent::builder()
                .provider(setup.provider)
                .workspace(workspace)
                .builtins(Builtins::ReadOnly)
                .approval(ApprovalMode::Ask)
                .context_window(setup.context_window)
                .max_output_tokens(setup.max_output_tokens)
                .max_steps(6))
        }),
        Arc::new(move |event| {
            let _ = tx.lock().unwrap().send(event);
        }),
    )
    .unwrap();
    let h = Harness { thread, events };
    h.thread
        .prompt("Use list_dir to list the files in the workspace, then name them in one short sentence.".into())
        .unwrap();
    let events = h.until_end();
    for event in &events {
        eprintln!("{}", serde_json::to_string(event).unwrap());
    }
    assert!(
        matches!(events.last().unwrap(), DesktopEvent::TurnEnded { .. }),
        "the turn should end normally"
    );
    assert!(events
        .iter()
        .any(|e| matches!(e, DesktopEvent::ToolCall { .. })));
}
