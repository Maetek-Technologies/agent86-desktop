//! Thread actor tests against a scripted provider: no network, no model, no keyring.

use super::actor::{ThreadHandle, ThreadOptions};
use super::events::{DesktopEvent, StopReason, SubagentUpdate};
use super::questions::{Answer, ApprovalChoice};
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
    let provider: Arc<dyn Provider> = Scripted::new(replies);
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
        ThreadOptions::default(),
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
                | DesktopEvent::SecretRequest { qid, .. } => return (*qid, event),
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
        ThreadOptions::default(),
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
