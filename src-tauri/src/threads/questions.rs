//! Questions a turn asks the user mid-way: approvals, limit raises, and secrets.
//!
//! agent86-core's callbacks are synchronous and run on the turn's thread, one at a time. Each one
//! registers a question with an id, sends it to the UI, and blocks until an answer arrives for
//! that id. A cancelled (or closed) thread answers every open question with "no", so a turn never
//! waits on a page that will not answer. Answers are matched by id and kind; a stale or mistyped
//! answer is refused, so nothing the WebView sends can approve a question that was not asked.

use super::events::DesktopEvent;
use agent86_core::sdk::{ApprovalPreview, LimitHit, SecretRequest};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use ts_rs::TS;

/// How often a waiting question checks whether the turn was cancelled.
const CANCEL_POLL: Duration = Duration::from_millis(50);

/// The user's answer to one question, as the UI sends it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[ts(export)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Answer {
    Approval {
        choice: ApprovalChoice,
    },
    /// The new limit (one of the offers), or `None` to stop.
    Limit {
        value: Option<u32>,
    },
    /// The secret's value, or `None` to decline.
    Secret {
        value: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalChoice {
    AllowOnce,
    /// Allow this tool for the rest of the thread without asking again.
    AllowAlways,
    Reject,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Approval,
    Limit,
    Secret,
}

impl Answer {
    fn kind(&self) -> Kind {
        match self {
            Self::Approval { .. } => Kind::Approval,
            Self::Limit { .. } => Kind::Limit,
            Self::Secret { .. } => Kind::Secret,
        }
    }
}

struct Pending {
    kind: Kind,
    reply: mpsc::Sender<Answer>,
}

/// The open questions of one thread, and what its user allowed for good.
pub struct Questions {
    pending: Mutex<HashMap<u64, Pending>>,
    next_id: Mutex<u64>,
    /// Tools the user allowed for the rest of the thread ("allow always").
    always_allowed: Mutex<HashSet<String>>,
    sink: super::EventSink,
    cancelled: Arc<AtomicBool>,
}

impl Questions {
    /// `cancelled` is the thread's cancel-requested flag: while it is set, every question is
    /// answered "no" at once.
    pub fn new(sink: super::EventSink, cancelled: Arc<AtomicBool>) -> Arc<Self> {
        Arc::new(Self {
            pending: Mutex::new(HashMap::new()),
            next_id: Mutex::new(0),
            always_allowed: Mutex::new(HashSet::new()),
            sink,
            cancelled,
        })
    }

    /// Deliver the UI's answer to question `qid`.
    pub fn answer(&self, qid: u64, answer: Answer) -> Result<(), String> {
        let mut pending = lock(&self.pending);
        let open = pending.get(&qid).ok_or_else(|| {
            format!("Question {qid} is not open (already answered or cancelled).")
        })?;
        if open.kind != answer.kind() {
            return Err(format!("Question {qid} asks something else."));
        }
        let open = pending.remove(&qid).expect("checked above");
        // The asker may have given up (cancelled) a moment ago; then the answer is moot.
        let _ = open.reply.send(answer);
        Ok(())
    }

    /// The approver: `true` lets the call run.
    pub fn approve(&self, tool: &str, preview: &ApprovalPreview) -> bool {
        if lock(&self.always_allowed).contains(tool) {
            return true;
        }
        let answer = self.ask(Kind::Approval, |qid| DesktopEvent::ApprovalRequest {
            qid,
            tool: tool.to_owned(),
            preview: preview.into(),
        });
        match answer {
            Some(Answer::Approval {
                choice: ApprovalChoice::AllowOnce,
            }) => true,
            Some(Answer::Approval {
                choice: ApprovalChoice::AllowAlways,
            }) => {
                lock(&self.always_allowed).insert(tool.to_owned());
                true
            }
            _ => false,
        }
    }

    /// The limit hook: the new limit, or `None` to stop at the one reached.
    pub fn raise_limit(&self, hit: &LimitHit) -> Option<u32> {
        let answer = self.ask(Kind::Limit, |qid| DesktopEvent::LimitRequest {
            qid,
            limit: hit.into(),
        });
        match answer {
            Some(Answer::Limit { value: Some(value) }) if hit.offers.contains(&value) => {
                Some(value)
            }
            _ => None,
        }
    }

    /// The secret hook: the value, or `None` to decline.
    pub fn secret(&self, request: &SecretRequest) -> Option<String> {
        let answer = self.ask(Kind::Secret, |qid| DesktopEvent::SecretRequest {
            qid,
            name: request.name.clone(),
            reason: request.reason.clone(),
            replacing: request.replacing,
        });
        match answer {
            Some(Answer::Secret { value: Some(value) }) if !value.is_empty() => Some(value),
            _ => None,
        }
    }

    /// Put a question to the UI and wait for its answer; `None` when the turn is cancelled.
    fn ask(&self, kind: Kind, event: impl FnOnce(u64) -> DesktopEvent) -> Option<Answer> {
        if self.cancelled.load(Ordering::SeqCst) {
            return None;
        }
        let (reply, answers) = mpsc::channel();
        let qid = {
            let mut next = lock(&self.next_id);
            *next += 1;
            *next
        };
        lock(&self.pending).insert(qid, Pending { kind, reply });
        (self.sink)(event(qid));

        let answer = loop {
            match answers.recv_timeout(CANCEL_POLL) {
                Ok(answer) => break Some(answer),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if self.cancelled.load(Ordering::SeqCst) {
                        break None;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break None,
            }
        };
        // Answered questions were removed by `answer`; a cancelled one is removed here.
        lock(&self.pending).remove(&qid);
        (self.sink)(DesktopEvent::QuestionClosed {
            qid,
            answered: answer.is_some(),
        });
        answer
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What an approval shows: agent86-core's [`ApprovalPreview`], owned and serializable.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalInfo {
    /// The arguments, as JSON, capped by agent86.
    pub summary: String,
    /// What the call would do: a unified diff, a command, code.
    pub detail: Option<String>,
    /// The language of `detail` (`diff`, `bash`, `python`).
    pub lexer: Option<String>,
    /// A caution, for a write into agent86's own configuration or skills.
    pub warning: Option<String>,
    /// Show all of `detail`, never capped.
    pub full: bool,
    /// The file the call would change, before and after (redacted).
    pub change: Option<FileChangeInfo>,
    /// The sub-agent asking, if not the main agent.
    pub asker: Option<AskerInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeInfo {
    pub path: String,
    /// `None` for a new file.
    pub old_text: Option<String>,
    pub new_text: String,
    #[ts(type = "number | null")]
    pub line: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AskerInfo {
    pub agent: String,
    pub depth: u32,
    pub worktree_path: Option<String>,
    pub worktree_branch: Option<String>,
    pub steps: u32,
    pub cost_usd: f64,
}

impl From<&ApprovalPreview> for ApprovalInfo {
    fn from(preview: &ApprovalPreview) -> Self {
        Self {
            summary: preview.summary.clone(),
            detail: preview.detail.clone(),
            lexer: preview.lexer.map(str::to_owned),
            warning: preview.warning.clone(),
            full: preview.full,
            change: preview.change.as_ref().map(|change| FileChangeInfo {
                path: change.path.clone(),
                old_text: change.old_text.clone(),
                new_text: change.new_text.clone(),
                line: change.line,
            }),
            asker: preview
                .asker
                .as_ref()
                .map(|asker| AskerInfo {
                    agent: asker.agent.clone(),
                    depth: asker.depth,
                    worktree_path: asker.worktree.as_ref().map(|(path, _)| path.clone()),
                    worktree_branch: asker.worktree.as_ref().map(|(_, branch)| branch.clone()),
                    steps: asker.steps,
                    cost_usd: asker.cost_usd,
                })
                .or_else(|| {
                    // A specialty's own approval names it without a sub-agent run.
                    preview.agent.as_ref().map(|agent| AskerInfo {
                        agent: agent.clone(),
                        depth: 1,
                        worktree_path: None,
                        worktree_branch: None,
                        steps: 0,
                        cost_usd: 0.0,
                    })
                }),
        }
    }
}

/// A limit the turn reached, and the raises on offer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LimitInfo {
    /// `steps`, `agent_steps`, or `output`.
    #[ts(type = "\"steps\" | \"agent_steps\" | \"output\"")]
    pub kind: String,
    /// What happened, in agent86's words.
    pub headline: String,
    /// The sub-agent that reached it, if not the main agent.
    pub agent: Option<String>,
    pub current: u32,
    /// The values offered, ascending.
    pub offers: Vec<u32>,
    /// The raise lasts for this sub-agent run only.
    pub run_only: bool,
}

impl From<&LimitHit> for LimitInfo {
    fn from(hit: &LimitHit) -> Self {
        Self {
            kind: hit.kind.name().to_owned(),
            headline: hit.headline(),
            agent: hit.agent.clone(),
            current: hit.current,
            offers: hit.offers.clone(),
            run_only: hit.run_only,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn questions() -> (
        Arc<Questions>,
        mpsc::Receiver<DesktopEvent>,
        Arc<AtomicBool>,
    ) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let cancelled = Arc::new(AtomicBool::new(false));
        let q = Questions::new(
            Arc::new(move |event| {
                let _ = tx.lock().unwrap().send(event);
            }),
            cancelled.clone(),
        );
        (q, rx, cancelled)
    }

    fn qid_of(event: DesktopEvent) -> u64 {
        match event {
            DesktopEvent::ApprovalRequest { qid, .. }
            | DesktopEvent::LimitRequest { qid, .. }
            | DesktopEvent::SecretRequest { qid, .. } => qid,
            other => panic!("expected a question, got {other:?}"),
        }
    }

    fn preview() -> ApprovalPreview {
        ApprovalPreview {
            summary: "{\"path\": \"a.txt\"}".into(),
            detail: None,
            lexer: None,
            warning: None,
            full: false,
            agent: None,
            change: None,
            asker: None,
        }
    }

    #[test]
    fn an_answer_of_the_wrong_kind_or_for_no_question_is_refused() {
        let (q, rx, _) = questions();
        assert!(q
            .answer(
                7,
                Answer::Approval {
                    choice: ApprovalChoice::AllowOnce
                }
            )
            .is_err());

        let asker = q.clone();
        let approved = std::thread::spawn(move || asker.approve("write_file", &preview()));
        let qid = qid_of(rx.recv().unwrap());
        assert!(q.answer(qid, Answer::Limit { value: Some(80) }).is_err());
        q.answer(
            qid,
            Answer::Approval {
                choice: ApprovalChoice::Reject,
            },
        )
        .unwrap();
        assert!(!approved.join().unwrap());
        // Answered once; a second answer finds nothing open.
        assert!(q
            .answer(
                qid,
                Answer::Approval {
                    choice: ApprovalChoice::AllowOnce
                }
            )
            .is_err());
    }

    #[test]
    fn allow_always_skips_later_questions_for_that_tool_only() {
        let (q, rx, _) = questions();
        let asker = q.clone();
        let first = std::thread::spawn(move || asker.approve("write_file", &preview()));
        let qid = qid_of(rx.recv().unwrap());
        q.answer(
            qid,
            Answer::Approval {
                choice: ApprovalChoice::AllowAlways,
            },
        )
        .unwrap();
        assert!(first.join().unwrap());
        assert!(matches!(
            rx.recv().unwrap(),
            DesktopEvent::QuestionClosed { answered: true, .. }
        ));

        assert!(q.approve("write_file", &preview()));
        assert!(
            rx.try_recv().is_err(),
            "no question for an always-allowed tool"
        );

        let asker = q.clone();
        let other = std::thread::spawn(move || asker.approve("run_command", &preview()));
        let qid = qid_of(rx.recv().unwrap());
        q.answer(
            qid,
            Answer::Approval {
                choice: ApprovalChoice::AllowOnce,
            },
        )
        .unwrap();
        assert!(other.join().unwrap());
    }

    #[test]
    fn a_cancel_answers_an_open_question_no() {
        let (q, rx, cancelled) = questions();
        let asker = q.clone();
        let approved = std::thread::spawn(move || asker.approve("write_file", &preview()));
        let qid = qid_of(rx.recv().unwrap());
        cancelled.store(true, Ordering::SeqCst);
        assert!(!approved.join().unwrap());
        assert_eq!(
            rx.recv().unwrap(),
            DesktopEvent::QuestionClosed {
                qid,
                answered: false
            }
        );
        // And nothing is asked while cancelled.
        assert!(!q.approve("write_file", &preview()));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn a_limit_raise_must_be_one_of_the_offers() {
        let (q, rx, _) = questions();
        let hit = LimitHit {
            kind: agent86_core::sdk::LimitKind::Steps,
            agent: None,
            current: 40,
            offers: vec![80, 160],
            run_only: false,
        };
        for (given, expected) in [(Some(80), Some(80)), (Some(999), None), (None, None)] {
            let asker = q.clone();
            let hit = hit.clone();
            let raised = std::thread::spawn(move || asker.raise_limit(&hit));
            let qid = qid_of(rx.recv().unwrap());
            q.answer(qid, Answer::Limit { value: given }).unwrap();
            assert_eq!(raised.join().unwrap(), expected);
            let _closed = rx.recv().unwrap();
        }
    }

    #[test]
    fn answers_deserialize_from_the_ui_shape() {
        let answer: Answer =
            serde_json::from_str(r#"{"type":"approval","choice":"allowAlways"}"#).unwrap();
        assert_eq!(
            answer,
            Answer::Approval {
                choice: ApprovalChoice::AllowAlways
            }
        );
        let answer: Answer = serde_json::from_str(r#"{"type":"secret","value":null}"#).unwrap();
        assert_eq!(answer, Answer::Secret { value: None });
    }
}
