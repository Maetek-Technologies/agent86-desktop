//! Thread actor tests against a scripted provider: no network, no model, no keyring.

use super::actor::{ThreadHandle, ThreadOptions};
use super::events::{DesktopEvent, StopReason, SubagentUpdate};
use super::questions::{Answer, ApprovalChoice, UiAction};
use agent86_core::sdk::providers::{
    Completion, CompletionDelta, CompletionRequest, DeltaStream, Provider, ProviderError,
};
use agent86_core::sdk::{Agent, AgentBuilder, ApprovalMode, Builtins, ToolCall};
use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

enum Reply {
    Text(&'static str),
    Tool(&'static str, Value),
    /// Several calls in one step: `(id, name, arguments)`.
    Calls(Vec<(&'static str, &'static str, Value)>),
    /// A stream that never yields, until the turn is cancelled.
    Hang,
}

struct Scripted {
    replies: Mutex<VecDeque<Reply>>,
    /// Every request the agent sent, so a test can see what the model was shown.
    requests: Mutex<Vec<CompletionRequest>>,
}

impl Scripted {
    fn new(replies: Vec<Reply>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into()),
            requests: Mutex::new(Vec::new()),
        })
    }

    /// What the model was shown as call `id`'s result in the last request that had it.
    fn observation(&self, id: &str) -> Option<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find_map(|request| {
                request
                    .messages
                    .iter()
                    .find(|message| message.tool_call_id.as_deref() == Some(id))
                    .map(|message| message.content.clone())
            })
    }

    /// The tools the first request offered.
    fn offered(&self) -> Vec<String> {
        self.requests.lock().unwrap()[0]
            .tools
            .iter()
            .map(|tool| tool.name.clone())
            .collect()
    }
}

impl Provider for Scripted {
    fn name(&self) -> &str {
        "scripted"
    }

    fn model(&self) -> &str {
        "scripted-model"
    }

    fn stream(&self, request: CompletionRequest) -> DeltaStream<'_> {
        self.requests.lock().unwrap().push(request);
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
            Reply::Calls(calls) => {
                let tool_calls = calls
                    .into_iter()
                    .map(|(id, name, arguments)| ToolCall {
                        id: id.into(),
                        name: name.into(),
                        arguments: arguments.as_object().cloned().unwrap(),
                    })
                    .collect();
                futures_util::stream::iter([Ok(done(Completion {
                    tool_calls,
                    ..Completion::default()
                }))])
                .boxed()
            }
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

/// How long a scripted turn may take before a test gives up on it.
const TURN_TIMEOUT: Duration = Duration::from_secs(60);

fn start(replies: Vec<Reply>, workspace: &Path, builtins: Builtins) -> Result<Harness, String> {
    start_with(replies, workspace, builtins, |builder| builder)
}

fn start_with(
    replies: Vec<Reply>,
    workspace: &Path,
    builtins: Builtins,
    configure: fn(AgentBuilder) -> AgentBuilder,
) -> Result<Harness, String> {
    spawn(
        replies,
        workspace,
        builtins,
        configure,
        ThreadOptions::default(),
    )
}

/// A thread whose agent may draw with agent86UI.
fn start_ui(replies: Vec<Reply>, workspace: &Path) -> Result<Harness, String> {
    spawn(
        replies,
        workspace,
        Builtins::Files,
        |builder| builder,
        ThreadOptions {
            agent86ui: true,
            ..ThreadOptions::default()
        },
    )
}

fn spawn(
    replies: Vec<Reply>,
    workspace: &Path,
    builtins: Builtins,
    configure: fn(AgentBuilder) -> AgentBuilder,
    options: ThreadOptions,
) -> Result<Harness, String> {
    spawn_on(
        Scripted::new(replies),
        workspace,
        builtins,
        configure,
        options,
    )
}

/// [`spawn`], on a provider the test keeps, to see what the model was sent.
fn spawn_on(
    provider: Arc<Scripted>,
    workspace: &Path,
    builtins: Builtins,
    configure: fn(AgentBuilder) -> AgentBuilder,
    options: ThreadOptions,
) -> Result<Harness, String> {
    let provider: Arc<dyn Provider> = provider;
    let workspace = workspace.to_owned();
    let (tx, events) = mpsc::channel();
    let tx = Mutex::new(tx);
    let thread = ThreadHandle::spawn(
        Box::new(move || {
            Ok(configure(
                Agent::builder()
                    .provider(provider)
                    .workspace(workspace)
                    .builtins(builtins)
                    .approval(ApprovalMode::Ask),
            ))
        }),
        Arc::new(move |event| {
            let _ = tx.lock().unwrap().send(event);
        }),
        options,
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
                .recv_timeout(TURN_TIMEOUT)
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

    /// Events up to and including the next question; returns its id and the question.
    fn until_question(&self) -> (u64, DesktopEvent) {
        let mut seen = Vec::new();
        loop {
            let event = self
                .events
                .recv_timeout(TURN_TIMEOUT)
                .unwrap_or_else(|_| panic!("no question came; saw {seen:#?}"));
            match &event {
                DesktopEvent::ApprovalRequest { qid, .. }
                | DesktopEvent::LimitRequest { qid, .. }
                | DesktopEvent::SecretRequest { qid, .. }
                | DesktopEvent::UiWaitRequest { qid, .. } => return (*qid, event),
                DesktopEvent::TurnEnded { .. } | DesktopEvent::TurnFailed { .. } => {
                    panic!("the turn ended without a question: {seen:#?} then {event:?}")
                }
                _ => seen.push(event),
            }
        }
    }

    fn approve(&self, qid: u64, choice: ApprovalChoice) {
        self.thread
            .answer(qid, Answer::Approval { choice })
            .unwrap();
    }
}

fn write(path: &'static str, content: &'static str) -> Reply {
    Reply::Tool("write_file", json!({"path": path, "content": content}))
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
    h.thread.prompt("say hello").unwrap();
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
    h.thread.prompt("what is here?").unwrap();
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
fn cancel_stops_a_running_turn_and_a_second_prompt_is_refused_meanwhile() {
    let dir = tempfile::tempdir().unwrap();
    let h = start(
        vec![Reply::Hang, Reply::Text("after")],
        dir.path(),
        Builtins::ReadOnly,
    )
    .unwrap();
    h.thread.prompt("take forever").unwrap();
    assert!(h.thread.is_busy());
    assert!(h.thread.prompt("again").is_err());

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
    h.thread.prompt("now answer").unwrap();
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
    h.thread.prompt("go").unwrap();
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
    assert!(h.thread.prompt("   ").is_err());
    assert!(!h.thread.is_busy());
}

#[test]
fn a_missing_workspace_fails_to_start() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("nope");
    assert!(start(vec![], &missing, Builtins::ReadOnly).is_err());
}

/// A real turn against the model in the agent86 CLI's config, imported as the first-run screen
/// imports it and built as the app builds it (keys from the real keyring). Needs that model to be
/// reachable, so it only runs when asked: `cargo test real_model -- --ignored --nocapture`.
#[test]
#[ignore]
fn real_model_smoke() {
    let path = crate::cli_import::cli_config_path().expect("a home folder");
    let settings = crate::cli_import::preview(&path)
        .expect("CLI config")
        .settings;
    let setup =
        crate::agent_factory::model(&settings, &settings.model.default, &crate::keys::OsKeys)
            .expect("model");
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
        ThreadOptions::default(),
    )
    .unwrap();
    let h = Harness { thread, events };
    h.thread
        .prompt("Use list_dir to list the files in the workspace, then name them in one short sentence.")
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

#[test]
fn an_approved_write_runs_and_the_approval_shows_the_change() {
    let dir = tempfile::tempdir().unwrap();
    let h = start(
        vec![write("ok.txt", "yes"), Reply::Text("written")],
        dir.path(),
        Builtins::Files,
    )
    .unwrap();
    h.thread.prompt("write ok.txt").unwrap();
    let (qid, question) = h.until_question();
    match &question {
        DesktopEvent::ApprovalRequest { tool, preview, .. } => {
            assert_eq!(tool, "write_file");
            let change = preview.change.as_ref().expect("a write shows its change");
            assert!(change.path.ends_with("ok.txt"), "path was {}", change.path);
            assert_eq!(change.old_text, None);
            assert_eq!(change.new_text, "yes");
        }
        other => panic!("expected an approval, got {other:?}"),
    }
    h.approve(qid, ApprovalChoice::AllowOnce);
    let events = h.until_end();
    assert!(events.contains(&DesktopEvent::QuestionClosed {
        qid,
        answered: true
    }));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("ok.txt")).unwrap(),
        "yes"
    );
    assert_eq!(agent_text(&events), "written");
}

#[test]
fn a_rejected_write_does_not_happen() {
    let dir = tempfile::tempdir().unwrap();
    let h = start(
        vec![write("no.txt", "nope"), Reply::Text("ok, not written")],
        dir.path(),
        Builtins::Files,
    )
    .unwrap();
    h.thread.prompt("write no.txt").unwrap();
    let (qid, _) = h.until_question();
    h.approve(qid, ApprovalChoice::Reject);
    let events = h.until_end();
    assert!(events.iter().any(|e| {
        matches!(e, DesktopEvent::ToolResult { name, ok, .. } if name == "write_file" && !ok)
    }));
    assert!(!dir.path().join("no.txt").exists());
}

#[test]
fn allow_always_asks_once_per_tool_for_the_thread() {
    let dir = tempfile::tempdir().unwrap();
    let h = start(
        vec![
            write("a.txt", "a"),
            write("b.txt", "b"),
            Reply::Text("both"),
        ],
        dir.path(),
        Builtins::Files,
    )
    .unwrap();
    h.thread.prompt("write two files").unwrap();
    let (qid, _) = h.until_question();
    h.approve(qid, ApprovalChoice::AllowAlways);
    let events = h.until_end();
    let asked = events
        .iter()
        .filter(|e| matches!(e, DesktopEvent::ApprovalRequest { .. }))
        .count();
    assert_eq!(asked, 0, "the second write is not asked about");
    assert!(dir.path().join("a.txt").exists());
    assert!(dir.path().join("b.txt").exists());
}

#[test]
fn cancel_while_an_approval_waits_declines_it_and_ends_the_turn() {
    let dir = tempfile::tempdir().unwrap();
    let h = start(
        vec![write("late.txt", "x"), Reply::Text("unreachable")],
        dir.path(),
        Builtins::Files,
    )
    .unwrap();
    h.thread.prompt("write late.txt").unwrap();
    let (qid, _) = h.until_question();
    h.thread.cancel();
    let events = h.until_end();
    assert!(events.contains(&DesktopEvent::QuestionClosed {
        qid,
        answered: false
    }));
    assert!(matches!(
        events.last().unwrap(),
        DesktopEvent::TurnEnded {
            stop_reason: StopReason::Cancelled,
            ..
        }
    ));
    assert!(!dir.path().join("late.txt").exists());
    // The question is gone: answering it now is refused.
    assert!(h
        .thread
        .answer(
            qid,
            Answer::Approval {
                choice: ApprovalChoice::AllowOnce
            }
        )
        .is_err());
}

#[test]
fn a_step_limit_can_be_raised_and_the_turn_goes_on() {
    let dir = tempfile::tempdir().unwrap();
    let h = start_with(
        vec![
            Reply::Tool("list_dir", json!({"path": "."})),
            Reply::Text("done after the raise"),
        ],
        dir.path(),
        Builtins::ReadOnly,
        |builder| builder.max_steps(1),
    )
    .unwrap();
    h.thread.prompt("look around").unwrap();
    let (qid, question) = h.until_question();
    let offers = match &question {
        DesktopEvent::LimitRequest { limit, .. } => {
            assert_eq!(limit.kind, "steps");
            assert_eq!(limit.current, 1);
            limit.offers.clone()
        }
        other => panic!("expected a limit question, got {other:?}"),
    };
    h.thread
        .answer(
            qid,
            Answer::Limit {
                value: Some(offers[0]),
            },
        )
        .unwrap();
    let events = h.until_end();
    assert_eq!(agent_text(&events), "done after the raise");
}

#[test]
fn a_secret_reaches_the_agent_but_never_comes_back_to_the_ui() {
    const VALUE: &str = "s3cret-value-123";
    let dir = tempfile::tempdir().unwrap();
    let h = start(
        vec![
            Reply::Tool(
                "request_secret",
                json!({"name": "DEMO_TOKEN", "reason": "to call the demo API"}),
            ),
            Reply::Text("thanks"),
        ],
        dir.path(),
        Builtins::ReadOnly,
    )
    .unwrap();
    h.thread.prompt("you need a token").unwrap();
    let (qid, question) = h.until_question();
    match &question {
        DesktopEvent::SecretRequest { name, reason, .. } => {
            assert_eq!(name, "DEMO_TOKEN");
            assert_eq!(reason, "to call the demo API");
        }
        other => panic!("expected a secret question, got {other:?}"),
    }
    h.thread
        .answer(
            qid,
            Answer::Secret {
                value: Some(VALUE.into()),
                remember: false,
            },
        )
        .unwrap();
    let events = h.until_end();
    assert!(events.iter().any(|e| {
        matches!(e, DesktopEvent::ToolResult { name, ok, .. } if name == "request_secret" && *ok)
    }));
    for event in &events {
        let json = serde_json::to_string(event).unwrap();
        assert!(!json.contains(VALUE), "the value leaked into {json}");
    }
}

#[test]
fn capabilities_list_skills_and_tools_and_a_skill_runs_directly() {
    let dir = tempfile::tempdir().unwrap();
    let skills = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(skills.path().join("greet")).unwrap();
    std::fs::write(
        skills.path().join("greet").join("SKILL.md"),
        "---\nname: greet\ndescription: Say hello nicely.\n---\nGreet the user warmly.\n",
    )
    .unwrap();
    let skills_dir = skills.path().to_owned();
    let provider: Arc<dyn Provider> = Scripted::new(vec![Reply::Text("Hello, friend!")]);
    let workspace = dir.path().to_owned();
    let (tx, events) = mpsc::channel();
    let tx = Mutex::new(tx);
    let thread = ThreadHandle::spawn(
        Box::new(move || {
            Ok(Agent::builder()
                .provider(provider)
                .workspace(workspace)
                .builtins(Builtins::ReadOnly)
                .skills_dir(skills_dir))
        }),
        Arc::new(move |event| {
            let _ = tx.lock().unwrap().send(event);
        }),
        ThreadOptions::default(),
    )
    .unwrap();
    let caps = thread.capabilities().clone();
    assert_eq!(caps.skills, vec!["greet"]);
    assert!(caps.tools.iter().any(|t| t == "read_file"));
    assert!(caps.tools.iter().any(|t| t == "use_skill"));

    let h = Harness { thread, events };
    h.thread
        .prompt(agent86_core::sdk::Turn::skill("greet", "say hi"))
        .unwrap();
    let events = h.until_end();
    assert_eq!(agent_text(&events), "Hello, friend!");
    // An unknown skill fails the turn with agent86's message, and the thread goes on.
    h.thread
        .prompt(agent86_core::sdk::Turn::skill("nope", "x"))
        .unwrap();
    match h.until_end().last().unwrap() {
        DesktopEvent::TurnFailed { error } => assert!(error.contains("nope"), "{error}"),
        other => panic!("expected a failed turn, got {other:?}"),
    }
}

fn memory_thread(
    replies: Vec<Reply>,
    workspace: &Path,
    memory: agent86_core::sdk::Memory,
    resume: Option<String>,
) -> Harness {
    memory_thread_with(replies, workspace, memory, resume, ThreadOptions::default())
}

fn memory_thread_with(
    replies: Vec<Reply>,
    workspace: &Path,
    memory: agent86_core::sdk::Memory,
    resume: Option<String>,
    options: ThreadOptions,
) -> Harness {
    let provider: Arc<dyn Provider> = Scripted::new(replies);
    let workspace = workspace.to_owned();
    let (tx, events) = mpsc::channel();
    let tx = Mutex::new(tx);
    let thread = ThreadHandle::spawn(
        Box::new(move || {
            let builder = Agent::builder()
                .provider(provider)
                .workspace(workspace)
                .builtins(Builtins::ReadOnly)
                .memory(memory);
            Ok(match resume {
                Some(id) => builder.session(id),
                None => builder,
            })
        }),
        Arc::new(move |event| {
            let _ = tx.lock().unwrap().send(event);
        }),
        options,
    )
    .unwrap();
    Harness { thread, events }
}

#[test]
fn a_saved_session_reopens_with_its_conversation() {
    use super::history::HistoryItem;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("notes.txt"), "hi").unwrap();
    let memory = agent86_core::sdk::Memory::in_memory().unwrap();

    let first = memory_thread(
        vec![
            Reply::Tool("list_dir", json!({"path": "."})),
            Reply::Text("There is notes.txt."),
        ],
        dir.path(),
        memory.clone(),
        None,
    );
    assert!(first.thread.take_history().is_empty());
    first
        .thread
        .prompt("what is here?\n\n<file path=\"x\">\ninlined\n</file>")
        .unwrap();
    first.until_end();
    let id = first.thread.session_id().to_owned();
    drop(first);

    // The CLI's own list sees it, titled from the first message.
    let listed = memory.store().recent_sessions(10).unwrap();
    assert!(listed.iter().any(|s| s.session_id == id));

    let again = memory_thread(vec![], dir.path(), memory.clone(), Some(id.clone()));
    assert_eq!(again.thread.session_id(), id);
    let history = again.thread.take_history();
    assert_eq!(
        history.first(),
        Some(&HistoryItem::User {
            text: "what is here?".into()
        })
    );
    match &history[1] {
        HistoryItem::Tool {
            name, output, ok, ..
        } => {
            assert_eq!(name, "list_dir");
            assert!(output.as_deref().unwrap_or("").contains("notes.txt"));
            assert!(ok);
        }
        other => panic!("expected the tool call, got {other:?}"),
    }
    assert_eq!(
        history.last(),
        Some(&HistoryItem::Agent {
            text: "There is notes.txt.".into()
        })
    );
    // Taken once.
    assert!(again.thread.take_history().is_empty());
}

#[test]
fn the_manager_refuses_a_session_open_twice_and_too_many_threads() {
    use super::manager::{ThreadManager, MAX_THREADS};
    let dir = tempfile::tempdir().unwrap();
    let memory = agent86_core::sdk::Memory::in_memory().unwrap();
    let threads = ThreadManager::default();
    let open = |resume: Option<String>| {
        let provider: Arc<dyn Provider> = Scripted::new(vec![Reply::Text("ok")]);
        let workspace = dir.path().to_owned();
        let memory = memory.clone();
        let resume_for_builder = resume.clone();
        threads.open(
            Box::new(move || {
                let builder = Agent::builder()
                    .provider(provider)
                    .workspace(workspace)
                    .builtins(Builtins::ReadOnly)
                    .memory(memory);
                Ok(match resume_for_builder {
                    Some(id) => builder.session(id),
                    None => builder,
                })
            }),
            Arc::new(|_| {}),
            dir.path().to_owned(),
            0,
            resume.as_deref(),
            ThreadOptions::default(),
        )
    };
    let first = open(None).unwrap();
    let again = open(Some(first.session_id.clone()));
    assert!(again.unwrap_err().contains("already open"));
    for _ in 1..MAX_THREADS {
        open(None).unwrap();
    }
    assert!(open(None).unwrap_err().contains("Close one first"));
    threads.close(&first.id).unwrap();
    assert!(open(None).is_ok());
}

/// A provider that also counts the messages each request carried, to see a conversation survive.
struct Counting {
    inner: Arc<Scripted>,
    seen: Arc<Mutex<Vec<usize>>>,
}

impl Provider for Counting {
    fn name(&self) -> &str {
        "counting"
    }

    fn model(&self) -> &str {
        "counting-model"
    }

    fn stream(&self, request: CompletionRequest) -> DeltaStream<'_> {
        self.seen.lock().unwrap().push(request.messages.len());
        self.inner.stream(request)
    }

    fn fresh(&self) -> Result<Arc<dyn Provider>, ProviderError> {
        self.inner.fresh()
    }
}

#[test]
fn a_reload_keeps_the_conversation_and_the_secrets_and_takes_new_capabilities() {
    let dir = tempfile::tempdir().unwrap();
    let h = start(vec![Reply::Text("first")], dir.path(), Builtins::ReadOnly).unwrap();
    h.thread.prompt("hello").unwrap();
    h.until_end();
    h.thread
        .secrets()
        .set("API_TOKEN", "tok-123456".into(), false)
        .unwrap();
    assert!(!h
        .thread
        .capabilities()
        .tools
        .contains(&"write_file".to_owned()));

    let seen = Arc::new(Mutex::new(Vec::new()));
    let provider: Arc<dyn Provider> = Arc::new(Counting {
        inner: Scripted::new(vec![Reply::Text("second")]),
        seen: seen.clone(),
    });
    let workspace = dir.path().to_owned();
    let capabilities = h
        .thread
        .reload(Box::new(move || {
            Ok(Agent::builder()
                .provider(provider)
                .workspace(workspace)
                .builtins(Builtins::Files)
                .approval(ApprovalMode::Ask))
        }))
        .unwrap();
    assert!(capabilities.tools.contains(&"write_file".to_owned()));
    assert_eq!(h.thread.secrets().list().secrets[0].name, "API_TOKEN");

    h.thread.prompt("again").unwrap();
    assert_eq!(agent_text(&h.until_end()), "second");
    // System, the first exchange, and the new prompt: the old conversation came along.
    assert!(seen.lock().unwrap()[0] >= 4, "{:?}", seen.lock().unwrap());
}

#[test]
fn a_reload_is_refused_during_a_turn_and_a_failed_one_keeps_the_old_agent() {
    let dir = tempfile::tempdir().unwrap();
    let h = start(vec![Reply::Hang], dir.path(), Builtins::ReadOnly).unwrap();
    h.thread.prompt("wait").unwrap();
    let workspace = dir.path().to_owned();
    let refused = h
        .thread
        .reload(Box::new(move || Ok(Agent::builder().workspace(workspace))));
    assert!(refused.unwrap_err().contains("Wait for the turn"));
    h.thread.cancel();
    h.until_end();
    let failed = h
        .thread
        .reload(Box::new(|| Err("no such model".to_owned())));
    assert_eq!(failed.unwrap_err(), "no such model");
    assert!(!h.thread.is_busy());
}

#[test]
fn a_delegated_sub_agent_reports_on_its_calls_card() {
    let dir = tempfile::tempdir().unwrap();
    let h = start_with(
        vec![
            Reply::Tool("delegate", json!({"task": "look around"})),
            Reply::Text("sub-agent answer"),
            Reply::Text("main answer"),
        ],
        dir.path(),
        Builtins::ReadOnly,
        |builder| builder.subagents(agent86_core::sdk::SubAgents::new()),
    )
    .unwrap();
    h.thread.prompt("delegate it").unwrap();
    let events = h.until_end();
    let updates: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            DesktopEvent::Subagent {
                card,
                announced,
                update,
            } => Some((card.clone(), *announced, update.clone())),
            _ => None,
        })
        .collect();
    assert!(
        matches!(&updates.first(), Some((card, true, SubagentUpdate::Started { task, .. })) if card == "call-1" && task.contains("look around")),
        "{updates:?}"
    );
    assert!(
        matches!(
            &updates.last(),
            Some((_, _, SubagentUpdate::Finished { ok: true, .. }))
        ),
        "{updates:?}"
    );
}

// agent86UI (ADR 0005): surfaces the model draws reach the UI, each tied to its call.

/// A `render_ui` call's arguments: a form asking for a name, as agent86's own tests draw it.
fn name_form() -> Value {
    json!({"messages": [{"version": "1.0", "createSurface": {
        "surfaceId": "form",
        "catalogId": agent86_core::sdk::agent86_ui::BASIC_CATALOG_ID,
        "components": [
            {"id": "root", "component": "Column", "children": ["name", "ok"]},
            {"id": "name", "component": "TextField", "label": "Name", "value": {"@path": "/name"}},
            {"id": "ok", "component": "Button", "child": "ok_label",
             "action": {"event": {"name": "submit", "context": {"name": {"@path": "/name"}}}}},
            {"id": "ok_label", "component": "Text", "text": "OK"}
        ],
        "dataModel": {"name": ""}
    }}]})
}

#[test]
fn render_ui_and_ask_user_are_offered_only_when_the_thread_draws() {
    let dir = tempfile::tempdir().unwrap();
    let offers = |h: &Harness, tool: &str| h.thread.capabilities().tools.contains(&tool.to_owned());
    let plain = start(vec![], dir.path(), Builtins::ReadOnly).unwrap();
    assert!(!offers(&plain, "render_ui"));
    assert!(!offers(&plain, "ask_user"));
    // agent86-core 1.2.2 offers `ask_user` to any `Ui` with `on_wait` and the basic catalog.
    let drawing = start_ui(vec![], dir.path()).unwrap();
    assert!(offers(&drawing, "render_ui"));
    assert!(offers(&drawing, "ask_user"));
}

#[test]
fn a_drawn_surface_reaches_the_ui_tied_to_its_call_even_in_a_batch() {
    let dir = tempfile::tempdir().unwrap();
    // Two calls in one step: agent86 announces both, then observes them in order, so the
    // surface's message comes after the first call's result and belongs to the second call.
    let h = start_ui(
        vec![
            Reply::Calls(vec![
                ("c1", "list_dir", json!({"path": "."})),
                ("c2", "render_ui", name_form()),
            ]),
            Reply::Text("I put up a form."),
        ],
        dir.path(),
    )
    .unwrap();
    h.thread.prompt("ask me my name").unwrap();
    let events = h.until_end();

    let order: Vec<String> = events
        .iter()
        .filter_map(|event| match event {
            DesktopEvent::ToolCall { id, .. } => Some(format!("call {id}")),
            DesktopEvent::ToolResult { id, ok, .. } => Some(format!("result {id} {ok}")),
            DesktopEvent::Ui { tool_call_id, .. } => {
                Some(format!("ui {}", tool_call_id.as_deref().unwrap_or("-")))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        order,
        [
            "call c1",
            "call c2",
            "result c1 true",
            "ui c2",
            "result c2 true"
        ]
    );
    let message = events
        .iter()
        .find_map(|event| match event {
            DesktopEvent::Ui { message, .. } => Some(message),
            _ => None,
        })
        .unwrap();
    assert_eq!(message["version"], "1.0");
    assert_eq!(message["createSurface"]["surfaceId"], "form");
    assert_eq!(message["createSurface"]["components"][0]["id"], "root");
    assert_eq!(message["createSurface"]["dataModel"]["name"], "");
    assert_eq!(agent_text(&events), "I put up a form.");
}

#[test]
fn an_invalid_batch_draws_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let broken = json!({"messages": [{"version": "1.0", "createSurface": {
        "surfaceId": "form",
        "catalogId": agent86_core::sdk::agent86_ui::BASIC_CATALOG_ID,
        "components": [{"id": "root", "component": "Txt", "text": "hi"}]
    }}]});
    let h = start_ui(
        vec![Reply::Tool("render_ui", broken), Reply::Text("Sorry.")],
        dir.path(),
    )
    .unwrap();
    h.thread.prompt("ask me my name").unwrap();
    let events = h.until_end();
    assert!(!events.iter().any(|e| matches!(e, DesktopEvent::Ui { .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e, DesktopEvent::ToolResult { ok: false, .. })));
}

/// [`name_form`], with the call waiting for the user's answer.
fn waiting_name_form() -> Value {
    let mut form = name_form();
    form["wait"] = json!(true);
    form
}

fn submit(surface: &str, name: &str) -> UiAction {
    UiAction {
        name: "submit".into(),
        surface_id: surface.into(),
        source_component_id: "ok".into(),
        timestamp: "2026-11-22T10:00:00Z".into(),
        context: json!({ "name": name }).as_object().cloned().unwrap(),
        user_message: None,
    }
}

fn tool_output(events: &[DesktopEvent], call: &str) -> (bool, String) {
    events
        .iter()
        .find_map(|event| match event {
            DesktopEvent::ToolResult { id, ok, output, .. } if id == call => {
                Some((*ok, output.clone()))
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("no result for {call}: {events:#?}"))
}

#[test]
fn a_waiting_surface_is_asked_after_it_is_drawn_and_the_action_is_the_calls_result() {
    let dir = tempfile::tempdir().unwrap();
    let h = start_ui(
        vec![
            Reply::Tool("render_ui", waiting_name_form()),
            Reply::Text("Hello, Ada."),
        ],
        dir.path(),
    )
    .unwrap();
    h.thread.prompt("ask me my name").unwrap();
    let (qid, question) = h.until_question();
    assert!(matches!(
        &question,
        DesktopEvent::UiWaitRequest { surface_ids, .. } if surface_ids == &["form"]
    ));
    // Another surface's button is refused; the question stays open for the right one.
    assert!(h
        .thread
        .answer(
            qid,
            Answer::Ui {
                action: Some(submit("elsewhere", "Eve"))
            }
        )
        .is_err());
    h.thread
        .answer(
            qid,
            Answer::Ui {
                action: Some(submit("form", "Ada")),
            },
        )
        .unwrap();
    let events = h.until_end();
    let (ok, output) = tool_output(&events, "call-1");
    assert!(ok, "{output}");
    assert!(output.contains("Rendered surface form."), "{output}");
    assert!(
        output.contains(r#"[ui action] submit on form: {"name": "Ada"}"#),
        "{output}"
    );
    assert_eq!(agent_text(&events), "Hello, Ada.");
}

#[test]
fn a_dismissed_surface_fails_the_call_but_the_turn_goes_on() {
    let dir = tempfile::tempdir().unwrap();
    let h = start_ui(
        vec![
            Reply::Tool("render_ui", waiting_name_form()),
            Reply::Text("No problem."),
        ],
        dir.path(),
    )
    .unwrap();
    h.thread.prompt("ask me my name").unwrap();
    let (qid, _) = h.until_question();
    h.thread.answer(qid, Answer::Ui { action: None }).unwrap();
    let events = h.until_end();
    let (ok, _) = tool_output(&events, "call-1");
    assert!(!ok);
    assert_eq!(agent_text(&events), "No problem.");
}

#[test]
fn cancel_while_a_surface_waits_closes_the_question_and_ends_the_turn() {
    let dir = tempfile::tempdir().unwrap();
    let h = start_ui(
        vec![Reply::Tool("render_ui", waiting_name_form())],
        dir.path(),
    )
    .unwrap();
    h.thread.prompt("ask me my name").unwrap();
    let (qid, _) = h.until_question();
    h.thread.cancel();
    let events = h.until_end();
    assert!(events.contains(&DesktopEvent::QuestionClosed {
        qid,
        answered: false
    }));
    assert!(matches!(
        events.last(),
        Some(DesktopEvent::TurnEnded {
            stop_reason: StopReason::Cancelled,
            ..
        })
    ));
}

// `ask_user` (agent86-core 1.2.2, ADR 0006 upstream): the model sends questions, agent86 builds
// the form and draws it as `ui` events for surface `agent86_ask_<n>`, waits through the same
// `on_wait` hook as a waiting `render_ui` call, and takes the form down once it is answered.

/// `ask_user`'s arguments: the release notes' weekend trip, one question of each shape the form
/// treats differently (a field, options with "Other", an optional number).
fn trip_questions() -> Value {
    json!({"title": "Your weekend trip", "questions": [
        {"id": "from", "question": "Where are you leaving from?", "kind": "text"},
        {"id": "style", "question": "What kind of trip?", "kind": "choice",
         "options": ["City and culture", "Outdoors"]},
        {"id": "nights", "question": "How many nights?", "kind": "number", "optional": true}
    ]})
}

/// A thread whose model calls `ask_user` first in a batch with `list_dir`, then says `answer`.
fn asking(dir: &Path, answer: &'static str) -> (Harness, Arc<Scripted>) {
    let provider = Scripted::new(vec![
        Reply::Calls(vec![
            ("c1", "ask_user", trip_questions()),
            ("c2", "list_dir", json!({"path": "."})),
        ]),
        Reply::Text(answer),
    ]);
    let h = spawn_on(
        provider.clone(),
        dir,
        Builtins::Files,
        |builder| builder,
        ThreadOptions {
            agent86ui: true,
            ..ThreadOptions::default()
        },
    )
    .unwrap();
    h.thread
        .prompt("Plan a weekend trip for me. Ask me what you need to know first.")
        .unwrap();
    (h, provider)
}

/// Events up to and including the next question, every `ui` message applied to `runtime` as the
/// app's renderer applies them.
fn until_question_drawn(h: &Harness, runtime: &mut Runtime) -> Vec<DesktopEvent> {
    let mut seen = Vec::new();
    loop {
        let event = h
            .events
            .recv_timeout(TURN_TIMEOUT)
            .unwrap_or_else(|_| panic!("no question came; saw {seen:#?}"));
        if let DesktopEvent::Ui { message, .. } = &event {
            let report = runtime.apply(std::slice::from_ref(message));
            assert!(report.is_ok(), "{message}: {:?}", report.errors);
        }
        let asked = matches!(event, DesktopEvent::UiWaitRequest { .. });
        seen.push(event);
        if asked {
            return seen;
        }
    }
}

/// The order of what a turn showed: calls, results, `ui` messages (with their call), and the
/// questions about them.
fn story(events: &[DesktopEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            DesktopEvent::ToolCall { id, name, .. } => Some(format!("call {id} {name}")),
            DesktopEvent::ToolResult { id, ok, .. } => Some(format!("result {id} {ok}")),
            DesktopEvent::Ui {
                tool_call_id,
                message,
            } => {
                let (kind, body) = message.as_object()?.iter().find(|(k, _)| *k != "version")?;
                Some(format!(
                    "ui {} {kind} {}",
                    tool_call_id.as_deref().unwrap_or("-"),
                    body["surfaceId"].as_str().unwrap_or("-")
                ))
            }
            DesktopEvent::UiWaitRequest { surface_ids, .. } => {
                Some(format!("wait {}", surface_ids.join(",")))
            }
            DesktopEvent::QuestionClosed { answered, .. } => Some(format!("closed {answered}")),
            _ => None,
        })
        .collect()
}

#[test]
fn the_agents_questions_are_drawn_answered_from_the_form_and_reach_the_model() {
    let dir = tempfile::tempdir().unwrap();
    let (h, provider) = asking(dir.path(), "A food tour from Boston, then.");
    let mut runtime = Runtime::basic();
    let mut events = until_question_drawn(&h, &mut runtime);
    let Some(DesktopEvent::UiWaitRequest { qid, surface_ids }) = events.last().cloned() else {
        unreachable!()
    };
    assert_eq!(surface_ids, ["agent86_ask_1"]);
    let surface = "agent86_ask_1";

    // The form as agent86 built it: an input per question bound under /answers, an "Other" field
    // for the choice question, and Send, held back until every required question is answered.
    let send = |runtime: &Runtime| runtime.node(surface, "send").expect("a Send button");
    let components: Vec<Value> = runtime.components(surface).unwrap().cloned().collect();
    let bound = |id: &str| {
        components.iter().find(|c| c["id"] == id).unwrap()["value"]["@path"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    assert_eq!(bound("q_from"), "/answers/from");
    assert_eq!(bound("o_style"), "/other/style");
    assert!(
        !send(&runtime).is_valid(),
        "Send waits for the required answers"
    );

    // The user answers as the renderer writes input: a place, and "Other" in their own words.
    runtime
        .input(surface, "/answers/from", json!("Boston"))
        .unwrap();
    runtime
        .input(surface, "/answers/style", json!(["__other__"]))
        .unwrap();
    runtime
        .input(surface, "/other/style", json!("A food tour"))
        .unwrap();
    let button = send(&runtime);
    assert!(button.is_valid(), "{:?}", button.validation_errors());
    let action_json = components.iter().find(|c| c["id"] == "send").unwrap()["action"].clone();
    let action = runtime
        .dispatch(&action_json, &Gesture::on(&button, surface))
        .unwrap()
        .action
        .expect("Send sends an action");
    assert_eq!(action.name, "answers");
    h.thread
        .answer(
            qid,
            Answer::Ui {
                action: Some(UiAction {
                    name: action.name,
                    surface_id: action.surface_id,
                    source_component_id: action.source_component_id,
                    timestamp: action.timestamp,
                    context: action.context,
                    user_message: action.user_message,
                }),
            },
        )
        .unwrap();
    events.extend(h.until_end());

    // Drawn at its own call though list_dir was announced after it, asked, then taken down
    // before its result.
    assert_eq!(
        story(&events),
        [
            "call c1 ask_user",
            "call c2 list_dir",
            "ui c1 createSurface agent86_ask_1",
            "wait agent86_ask_1",
            "closed true",
            "ui c1 deleteSurface agent86_ask_1",
            "result c1 true",
            "result c2 true",
        ]
    );
    let answered = "The user answered:\n\
        {\"from\": \"Boston\", \"style\": \"A food tour\", \"nights\": null}\n\
        In their own words, not one of the options: style.";
    assert_eq!(tool_output(&events, "c1"), (true, answered.to_owned()));
    assert_eq!(provider.observation("c1").as_deref(), Some(answered));
    assert!(provider.offered().contains(&"ask_user".to_owned()));
    assert_eq!(agent_text(&events), "A food tour from Boston, then.");
    // The form is agent86's, not one of the agent's surfaces: a reopened thread would not get it.
    assert!(h.thread.take_surfaces().is_empty());
}

#[test]
fn dismissing_the_questions_tells_the_agent_and_the_turn_goes_on() {
    let dir = tempfile::tempdir().unwrap();
    let (h, provider) = asking(dir.path(), "I'll suggest something general.");
    let (qid, _) = h.until_question();
    h.thread.answer(qid, Answer::Ui { action: None }).unwrap();
    let events = h.until_end();
    assert!(events.contains(&DesktopEvent::QuestionClosed {
        qid,
        answered: true
    }));
    // Taken down all the same, and not a failure: the agent is told to go on without answers.
    assert!(story(&events).contains(&"ui c1 deleteSurface agent86_ask_1".to_owned()));
    let (ok, output) = tool_output(&events, "c1");
    assert!(ok, "{output}");
    assert!(
        output.starts_with("The user closed the form without answering."),
        "{output}"
    );
    assert_eq!(provider.observation("c1"), Some(output));
    assert_eq!(agent_text(&events), "I'll suggest something general.");
}

#[test]
fn stopping_while_the_questions_wait_takes_the_form_down_and_ends_the_turn() {
    let dir = tempfile::tempdir().unwrap();
    let (h, _) = asking(dir.path(), "(not reached)");
    let (qid, _) = h.until_question();
    h.thread.cancel();
    let events = h.until_end();
    assert!(events.contains(&DesktopEvent::QuestionClosed {
        qid,
        answered: false
    }));
    assert!(story(&events).contains(&"ui c1 deleteSurface agent86_ask_1".to_owned()));
    assert!(matches!(
        events.last(),
        Some(DesktopEvent::TurnEnded {
            stop_reason: StopReason::Cancelled,
            ..
        })
    ));
}

/// Events up to and including the `n`th turn end from now.
fn until_ends(h: &Harness, n: usize) -> Vec<DesktopEvent> {
    (0..n).flat_map(|_| h.until_end()).collect()
}

/// A thread whose first turn put up [`name_form`], then answers with `replies`.
fn with_form_up(dir: &Path, replies: Vec<Reply>) -> Harness {
    let mut script = vec![
        Reply::Tool("render_ui", name_form()),
        Reply::Text("The form is up."),
    ];
    script.extend(replies);
    let h = start_ui(script, dir).unwrap();
    h.thread.prompt("ask me my name").unwrap();
    h.until_end();
    h
}

#[test]
fn a_button_pressed_after_the_turn_runs_a_turn_of_its_own() {
    let dir = tempfile::tempdir().unwrap();
    let h = with_form_up(dir.path(), vec![Reply::Text("Hello, Ada.")]);
    let held = h.thread.ui_action(submit("form", "Ada")).unwrap();
    assert!(!held);
    let events = h.until_end();
    assert_eq!(
        events.first(),
        Some(&DesktopEvent::UiActionStarted {
            action: submit("form", "Ada")
        })
    );
    assert!(matches!(
        events.last(),
        Some(DesktopEvent::TurnEnded { answer, stop_reason: StopReason::EndTurn, .. })
            if answer == "Hello, Ada."
    ));
    assert!(!h.thread.is_busy());
}

#[test]
fn a_button_for_a_surface_that_is_not_up_fails_the_turn() {
    let dir = tempfile::tempdir().unwrap();
    let h = with_form_up(dir.path(), vec![]);
    h.thread.ui_action(submit("gone", "Ada")).unwrap();
    let events = h.until_end();
    match events.last() {
        Some(DesktopEvent::TurnFailed { error }) => {
            assert!(error.contains("gone"), "{error}")
        }
        other => panic!("expected the turn to fail, got {other:?}"),
    }
    assert!(!h.thread.is_busy());
}

#[test]
fn a_button_pressed_during_a_turn_is_held_and_runs_when_it_ends() {
    let dir = tempfile::tempdir().unwrap();
    let h = with_form_up(
        dir.path(),
        vec![
            write("a.txt", "x"),
            Reply::Text("Written."),
            Reply::Text("Hello, Ada."),
        ],
    );
    h.thread.prompt("write a.txt").unwrap();
    // The turn waits on its approval, so it is still running when the button is pressed.
    let (qid, _) = h.until_question();
    assert!(h.thread.ui_action(submit("form", "Ada")).unwrap());
    assert!(h.thread.prompt("something else").is_err());
    h.approve(qid, ApprovalChoice::AllowOnce);

    let events = until_ends(&h, 2);
    let marks: Vec<String> = events
        .iter()
        .filter_map(|event| match event {
            DesktopEvent::UiActionStarted { action } => Some(format!("action {}", action.name)),
            DesktopEvent::TurnEnded { answer, .. } => Some(format!("end {answer}")),
            _ => None,
        })
        .collect();
    assert_eq!(marks, ["end Written.", "action submit", "end Hello, Ada."]);
    assert!(!h.thread.is_busy());
}

#[test]
fn stopping_the_turn_drops_the_held_buttons() {
    let dir = tempfile::tempdir().unwrap();
    let h = with_form_up(dir.path(), vec![write("a.txt", "x")]);
    h.thread.prompt("write a.txt").unwrap();
    let (_, _) = h.until_question();
    assert!(h.thread.ui_action(submit("form", "Ada")).unwrap());
    h.thread.cancel();
    let events = h.until_end();
    assert!(matches!(
        events.last(),
        Some(DesktopEvent::TurnEnded {
            stop_reason: StopReason::Cancelled,
            ..
        })
    ));
    let dropped = h.events.recv_timeout(TURN_TIMEOUT).unwrap();
    assert_eq!(
        dropped,
        DesktopEvent::UiActionDropped {
            action: submit("form", "Ada")
        }
    );
    assert!(!h.thread.is_busy());
    assert!(
        h.events.recv_timeout(Duration::from_millis(300)).is_err(),
        "no turn runs after the stop"
    );
}

#[test]
fn a_reopened_session_brings_back_its_surfaces_as_they_were() {
    let dir = tempfile::tempdir().unwrap();
    let memory = agent86_core::sdk::Memory::in_memory().unwrap();
    let drawing = || ThreadOptions {
        agent86ui: true,
        ..ThreadOptions::default()
    };
    let update = json!({"messages": [{"version": "1.0", "updateDataModel": {
        "surfaceId": "form", "path": "/name", "value": "Ada"
    }}]});
    let first = memory_thread_with(
        vec![
            Reply::Tool("render_ui", name_form()),
            Reply::Tool("render_ui", update),
            Reply::Text("The form is up."),
        ],
        dir.path(),
        memory.clone(),
        None,
        drawing(),
    );
    assert!(first.thread.take_surfaces().is_empty());
    first.thread.prompt("ask me my name").unwrap();
    first.until_end();
    let id = first.thread.session_id().to_owned();
    drop(first);

    let again = memory_thread_with(vec![], dir.path(), memory, Some(id), drawing());
    let surfaces = again.thread.take_surfaces();
    assert_eq!(surfaces.len(), 1, "{surfaces:#?}");
    let create = &surfaces[0]["createSurface"];
    assert_eq!(create["surfaceId"], "form");
    assert_eq!(create["dataModel"]["name"], "Ada", "drawn as it was last");
    assert!(again.thread.take_surfaces().is_empty(), "taken once");
}

// agent86UI against the real model in the CLI's config (`~/.agent86/config.toml` and the keyring),
// through the thread actor with agent86UI on. The test stands in for the user: agent86-ui's
// runtime resolves each surface as the app's renderer does, fills its fields, and presses its
// button. Ignored by default (they call the model): `cargo test real_model_agent86ui --
// --ignored --nocapture`.

use agent86_core::sdk::agent86_ui::runtime::{Gesture, Runtime};

/// A thread on the CLI's default model, drawing with agent86UI; saved to `memory` (continuing
/// session `resume`) if given.
fn live_thread(
    workspace: &Path,
    memory: Option<agent86_core::sdk::Memory>,
    resume: Option<String>,
) -> Harness {
    let path = crate::cli_import::cli_config_path().expect("a home folder");
    let settings = crate::cli_import::preview(&path)
        .expect("CLI config")
        .settings;
    let setup =
        crate::agent_factory::model(&settings, &settings.model.default, &crate::keys::OsKeys)
            .expect("model");
    eprintln!("model: {}", setup.reference);
    let workspace = workspace.to_owned();
    let (tx, events) = mpsc::channel();
    let tx = Mutex::new(tx);
    let thread = ThreadHandle::spawn(
        Box::new(move || {
            let mut builder = Agent::builder()
                .provider(setup.provider)
                .workspace(workspace)
                .builtins(Builtins::ReadOnly)
                .approval(ApprovalMode::Ask)
                .context_window(setup.context_window)
                .max_output_tokens(setup.max_output_tokens)
                .max_steps(8);
            if let Some(memory) = memory {
                builder = builder.memory(memory);
            }
            if let Some(id) = resume {
                builder = builder.session(id);
            }
            Ok(builder)
        }),
        Arc::new(move |event| {
            let _ = tx.lock().unwrap().send(event);
        }),
        ThreadOptions {
            agent86ui: true,
            ..ThreadOptions::default()
        },
    )
    .unwrap();
    Harness { thread, events }
}

/// Fill every field of `surface` bound to an absolute path, then press its first button with an
/// event, as the renderer would: the action, with its context resolved.
fn live_press(runtime: &mut Runtime, surface: &str) -> Option<UiAction> {
    let components: Vec<Value> = runtime.components(surface)?.cloned().collect();
    for component in &components {
        let Some(path) = component["value"]["@path"].as_str() else {
            continue;
        };
        if !path.starts_with('/') {
            continue;
        }
        let value = match component["component"].as_str() {
            Some("TextField") if component["variant"] == "number" => json!("4"),
            Some("TextField") => json!("Ada Lovelace"),
            Some("Slider") => json!(4),
            Some("CheckBox") => json!(true),
            Some("DateTimeInput") => json!("2026-12-03"),
            Some("ChoicePicker") => json!([component["options"][0]["value"].clone()]),
            _ => continue,
        };
        eprintln!("  fill {} {path} = {value}", component["id"]);
        runtime.input(surface, path, value).ok()?;
    }
    let tree = runtime.tree(surface)?;
    let button = tree.walk().into_iter().find(|node| {
        node.component == "Button"
            && components
                .iter()
                .any(|c| c["id"] == node.id.as_str() && c["action"].get("event").is_some())
    })?;
    let action_json = components.iter().find(|c| c["id"] == button.id.as_str())?["action"].clone();
    if !button.is_valid() {
        eprintln!(
            "  button {} blocked: {:?}",
            button.id,
            button.validation_errors()
        );
    }
    let action = runtime
        .dispatch(&action_json, &Gesture::on(button, surface))
        .ok()?
        .action?;
    eprintln!(
        "  press {} -> {}",
        button.id,
        serde_json::to_string(&action).unwrap()
    );
    Some(UiAction {
        name: action.name,
        surface_id: action.surface_id,
        source_component_id: action.source_component_id,
        timestamp: action.timestamp,
        context: action.context,
        user_message: action.user_message,
    })
}

/// Events until `turns` turns have ended, each printed. Surfaces are applied to `runtime` and
/// kept in `drawn`; `on_wait` answers a surface's wait (its question id and surfaces).
fn live_turns(
    h: &Harness,
    turns: usize,
    runtime: &mut Runtime,
    drawn: &mut Vec<Value>,
    mut on_wait: impl FnMut(&mut Runtime, u64, &[String]),
) -> Vec<DesktopEvent> {
    let mut seen = Vec::new();
    let mut ended = 0;
    while ended < turns {
        let event = h
            .events
            .recv_timeout(Duration::from_secs(300))
            .expect("the turn stalled");
        let line = serde_json::to_string(&event).unwrap();
        // Streamed text is long and dull; the rest tells the story.
        if !line.starts_with(r#"{"type":"thought""#) && !line.starts_with(r#"{"type":"agentText""#)
        {
            eprintln!("{}", &line[..line.len().min(500)]);
        }
        match &event {
            DesktopEvent::Ui { message, .. } => {
                drawn.push(message.clone());
                let report = runtime.apply(std::slice::from_ref(message));
                assert!(
                    report.is_ok(),
                    "the runtime refused {message}: {:?}",
                    report.errors
                );
            }
            DesktopEvent::UiWaitRequest { qid, surface_ids } => on_wait(runtime, *qid, surface_ids),
            DesktopEvent::TurnEnded { .. } | DesktopEvent::TurnFailed { .. } => ended += 1,
            _ => {}
        }
        seen.push(event);
    }
    seen
}

fn render_ui_results(events: &[DesktopEvent]) -> Vec<(bool, String)> {
    events
        .iter()
        .filter_map(|e| match e {
            DesktopEvent::ToolResult {
                name, ok, output, ..
            } if name == "render_ui" => Some((*ok, output.clone())),
            _ => None,
        })
        .collect()
}

/// The model draws a form and waits; the user fills it and presses its button, which is the
/// call's result. Pressed again after the turn, it runs a turn of its own. Writes the surfaces to
/// `/tmp/a86-live-surfaces.json`.
#[test]
#[ignore]
fn real_model_agent86ui() {
    let dir = tempfile::tempdir().unwrap();
    let h = live_thread(dir.path(), None, None);
    let mut runtime = Runtime::basic();
    let mut drawn = Vec::new();
    h.thread
        .prompt(
            "I'd like to book a table at a restaurant. Show me a form for my name, the party \
             size, and the date, with a Book button, and wait for my answer before going on. \
             Then confirm the booking in one sentence, and leave the form on screen.",
        )
        .unwrap();
    let mut answered = None;
    let seen = live_turns(&h, 1, &mut runtime, &mut drawn, |runtime, qid, surfaces| {
        let action = live_press(runtime, &surfaces[0]).expect("a button to press");
        answered = Some(action.surface_id.clone());
        h.thread
            .answer(
                qid,
                Answer::Ui {
                    action: Some(action),
                },
            )
            .unwrap();
    });
    std::fs::write(
        "/tmp/a86-live-surfaces.json",
        serde_json::to_string_pretty(&drawn).unwrap(),
    )
    .unwrap();
    assert!(!drawn.is_empty(), "the model drew nothing");
    let surface = answered.expect("the model waited for an answer");
    assert!(
        render_ui_results(&seen)
            .iter()
            .any(|(ok, output)| *ok && output.contains("[ui action]")),
        "the action came back as the waiting call's result"
    );
    assert!(matches!(seen.last(), Some(DesktopEvent::TurnEnded { .. })));

    // After the turn: a press no call waits on runs a turn of its own.
    if runtime.surface_ids().any(|id| id == surface) {
        let action = live_press(&mut runtime, &surface).expect("the button again");
        assert!(!h.thread.ui_action(action).unwrap(), "nothing is running");
        let events = live_turns(&h, 1, &mut runtime, &mut drawn, |_, _, _| {
            panic!("no wait expected")
        });
        assert!(matches!(
            events.first(),
            Some(DesktopEvent::UiActionStarted { .. })
        ));
        assert!(matches!(
            events.last(),
            Some(DesktopEvent::TurnEnded { .. })
        ));
    } else {
        eprintln!("(the model deleted the surface, so no press after the turn)");
    }
}

/// The model draws a form and waits; the user dismisses it: the call fails, the turn goes on,
/// and the surface stays up. Then, during the next turn, the user presses its button: the press
/// is held, and runs as a turn of its own once that turn ends.
#[test]
#[ignore]
fn real_model_agent86ui_dismiss_and_hold() {
    let dir = tempfile::tempdir().unwrap();
    let h = live_thread(dir.path(), None, None);
    let mut runtime = Runtime::basic();
    let mut drawn = Vec::new();
    h.thread
        .prompt(
            "Show me a form to sign up for the newsletter: my email, and a Subscribe button. \
             Wait for my answer before going on. If I don't answer, say so in one sentence and \
             leave the form on screen.",
        )
        .unwrap();
    let mut dismissed = None;
    let seen = live_turns(&h, 1, &mut runtime, &mut drawn, |_, qid, surfaces| {
        eprintln!("  dismiss {surfaces:?}");
        dismissed = Some(surfaces[0].clone());
        h.thread.answer(qid, Answer::Ui { action: None }).unwrap();
    });
    let surface = dismissed.expect("the model waited for an answer");
    let results = render_ui_results(&seen);
    assert!(
        results.iter().any(|(ok, _)| !ok),
        "the dismissed call failed: {results:?}"
    );
    assert!(
        matches!(seen.last(), Some(DesktopEvent::TurnEnded { .. })),
        "the turn went on and ended"
    );
    assert!(
        runtime.surface_ids().any(|id| id == surface),
        "the dismissed surface stayed up (unless the model deleted it)"
    );

    // A press during a turn is held until it ends.
    h.thread
        .prompt("In two sentences, why do people read newsletters?")
        .unwrap();
    let action = live_press(&mut runtime, &surface).expect("the button");
    assert!(
        h.thread.ui_action(action).unwrap(),
        "held: a turn is running"
    );
    let events = live_turns(&h, 2, &mut runtime, &mut drawn, |_, _, _| {
        panic!("no wait expected")
    });
    let marks: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            DesktopEvent::TurnEnded { .. } => Some("end"),
            DesktopEvent::TurnFailed { .. } => Some("failed"),
            DesktopEvent::UiActionStarted { .. } => Some("action"),
            _ => None,
        })
        .collect();
    assert_eq!(marks, ["end", "action", "end"]);
}

/// A session where the model drew a form and updated it, closed and reopened: the surface comes
/// back as it was (agent86 rebuilds it from the history), and the reopened agent takes a press on
/// it. Writes the reopened history and surfaces to `/tmp/a86-live-reopen.json`.
#[test]
#[ignore]
fn real_model_agent86ui_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let memory = agent86_core::sdk::Memory::in_memory().unwrap();
    let first = live_thread(dir.path(), Some(memory.clone()), None);
    let mut runtime = Runtime::basic();
    let mut drawn = Vec::new();
    first
        .thread
        .prompt(
            "Show me a form to rate this app: a Slider from 1 to 5 bound to /rating (start it at \
             3), and a Send button whose event's context holds the rating. Don't wait for my \
             answer. Then, in a second render_ui call, set /rating to 5 with updateDataModel.",
        )
        .unwrap();
    live_turns(&first, 1, &mut runtime, &mut drawn, |_, qid, _| {
        first
            .thread
            .answer(qid, Answer::Ui { action: None })
            .unwrap();
    });
    let surface = runtime
        .surface_ids()
        .next()
        .expect("the model drew a surface")
        .to_owned();
    let before = runtime.data_model(&surface).cloned();
    let id = first.thread.session_id().to_owned();
    drop(first);

    let again = live_thread(dir.path(), Some(memory), Some(id));
    let history = again.thread.take_history();
    let surfaces = again.thread.take_surfaces();
    std::fs::write(
        "/tmp/a86-live-reopen.json",
        serde_json::to_string_pretty(&json!({"history": history, "surfaces": surfaces})).unwrap(),
    )
    .unwrap();
    eprintln!(
        "reopened: {} history items, {} surfaces",
        history.len(),
        surfaces.len()
    );
    let rebuilt = surfaces
        .iter()
        .find(|s| s["createSurface"]["surfaceId"] == surface.as_str())
        .expect("the surface came back");
    assert_eq!(
        Some(&rebuilt["createSurface"]["dataModel"]),
        before.as_ref(),
        "as it was when the thread closed"
    );

    // The renderer draws the rebuilt surface, and the reopened agent takes a press on it.
    let mut reopened = Runtime::basic();
    assert!(reopened.apply(&surfaces).is_ok());
    let action = live_press(&mut reopened, &surface).expect("the button");
    assert!(!again.thread.ui_action(action).unwrap());
    let events = live_turns(&again, 1, &mut reopened, &mut drawn, |_, _, _| {
        panic!("no wait expected")
    });
    assert!(matches!(
        events.first(),
        Some(DesktopEvent::UiActionStarted { .. })
    ));
    assert!(
        matches!(events.last(), Some(DesktopEvent::TurnEnded { .. })),
        "the press was accepted on the rebuilt surface: {:?}",
        events.last()
    );
}
