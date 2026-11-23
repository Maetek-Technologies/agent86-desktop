//! What a thread streams to the UI: owned, serializable versions of agent86-core's borrowed
//! [`TurnEvent`]s, plus the turn's end. `cargo test` writes their TypeScript types to
//! `src/desktop-client/generated` (ts-rs).

use super::questions::{ApprovalInfo, LimitInfo, UiAction};
use agent86_core::sdk::{TurnEvent, TurnSummary, Usage};
use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use ts_rs::TS;

/// The most tool output sent to the UI for one call. The model's own copy is not affected.
pub const MAX_TOOL_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DesktopEvent {
    /// A piece of the model's answer, streamed.
    AgentText { text: String },
    /// A piece of the model's reasoning, already redacted.
    Thought { text: String },
    /// A harness notice: `[cancelled]`, a guardrail, a continuation or compaction note.
    Notice { text: String },
    /// A tool call, announced before it runs.
    ToolCall {
        id: String,
        name: String,
        #[ts(type = "Record<string, unknown>")]
        arguments: Value,
        /// agent86's `[tool] name(...)` line, without the prefix.
        title: String,
    },
    /// A call's result. `output` is what the model was shown (after the observation guardrail
    /// and secret redaction), capped at [`MAX_TOOL_OUTPUT_BYTES`].
    ToolResult {
        id: String,
        name: String,
        ok: bool,
        output: String,
        truncated: bool,
        error: Option<String>,
        /// agent86's `[tool] name -> summary` line, without the prefix.
        summary: String,
    },
    /// One A2UI message a `render_ui` call drew (agent86UI): validated against the basic
    /// catalog and redacted by agent86 before it got here. `message` is the A2UI 1.0
    /// agent-to-renderer message as JSON (`createSurface`, `updateComponents`,
    /// `updateDataModel`, or `deleteSurface`). It arrives after its call's `toolCall` and before
    /// its `toolResult`; `toolCallId` is that call (`None` only if agent86 sent a message
    /// outside any call, which it does not do today).
    Ui {
        tool_call_id: Option<String>,
        #[ts(type = "Record<string, unknown>")]
        message: Value,
    },
    /// A model call finished: what it used, and the session's total so far.
    Usage { step: UsageInfo, session: UsageInfo },
    /// The history was compacted (`summary` is `None` when it was trimmed instead).
    Compacted {
        notice: String,
        summary: Option<String>,
    },
    /// A side-effecting call waits for the user's approval. Answer with `answer` and this `qid`.
    ApprovalRequest {
        #[ts(type = "number")]
        qid: u64,
        tool: String,
        preview: ApprovalInfo,
    },
    /// The turn reached a limit; the user may raise it to one of the offers or stop.
    LimitRequest {
        #[ts(type = "number")]
        qid: u64,
        limit: LimitInfo,
    },
    /// The model asks for a secret through `request_secret`. Only its name and reason are sent;
    /// the value goes the other way, once.
    SecretRequest {
        #[ts(type = "number")]
        qid: u64,
        name: String,
        reason: String,
        replacing: bool,
        /// Whether the answer may also keep it for the project (an OS keyring is attached).
        can_remember: bool,
    },
    /// A `render_ui` call drew `surfaceIds` (their `ui` events came first) and the turn waits
    /// for the user's first action on one of them. Answer with `answer`: the action, or a
    /// dismissal.
    UiWaitRequest {
        #[ts(type = "number")]
        qid: u64,
        surface_ids: Vec<String>,
    },
    /// Question `qid` is over: answered, or dropped because the turn was cancelled.
    QuestionClosed {
        #[ts(type = "number")]
        qid: u64,
        answered: bool,
    },
    /// What a sub-agent is doing, reported on the card of the `delegate` call that started it
    /// (`card` is that call's id). `announced` is false for a `/agent` turn, whose card no call
    /// has shown yet.
    Subagent {
        card: String,
        announced: bool,
        update: SubagentUpdate,
    },
    /// A turn starts from a button pressed on a surface (no call was waiting on it): pressed
    /// just now, or held until the last turn ended. Its user message is agent86's
    /// `[ui action] <name> on <surfaceId>: <context>`.
    UiActionStarted { action: UiAction },
    /// A held action was not sent, because the turn it waited for was stopped.
    UiActionDropped { action: UiAction },
    /// The turn is over and the thread takes a new prompt.
    TurnEnded {
        stop_reason: StopReason,
        answer: String,
        turn: Option<TurnInfo>,
        usage: UsageInfo,
    },
    /// The turn failed (the model could not be reached, a limit tripped). The thread takes a new
    /// prompt.
    TurnFailed { error: String },
}

/// One thing a sub-agent did. Nested runs report on their top-level card; their calls' ids are
/// namespaced under it (`<card>/<n>`).
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SubagentUpdate {
    Started {
        #[ts(type = "number")]
        run: u64,
        /// The specialist or role it runs as.
        name: String,
        depth: u32,
        task: String,
    },
    ToolCall {
        id: String,
        name: String,
        /// Already redacted.
        #[ts(type = "Record<string, unknown>")]
        arguments: Value,
    },
    ToolResult {
        id: String,
        name: String,
        ok: bool,
        output: String,
        truncated: bool,
        error: Option<String>,
    },
    Notice {
        text: String,
    },
    Finished {
        #[ts(type = "number")]
        run: u64,
        name: String,
        depth: u32,
        ok: bool,
        /// What it and anything it delegated used.
        usage: UsageInfo,
    },
}

impl SubagentUpdate {
    /// A call's result, its output capped as the main loop's are.
    pub fn tool_result(
        id: &str,
        name: &str,
        ok: bool,
        output: &str,
        error: Option<String>,
    ) -> Self {
        let (output, truncated) = cap(output, MAX_TOOL_OUTPUT_BYTES);
        Self::ToolResult {
            id: id.to_owned(),
            name: name.to_owned(),
            ok,
            output,
            truncated,
            error,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UsageInfo {
    #[ts(type = "number")]
    pub input_tokens: u64,
    #[ts(type = "number")]
    pub output_tokens: u64,
    pub cost_usd: f64,
    #[ts(type = "number")]
    pub cache_read_tokens: u64,
    #[ts(type = "number")]
    pub cache_creation_tokens: u64,
}

impl From<&Usage> for UsageInfo {
    fn from(usage: &Usage) -> Self {
        Self {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cost_usd: usage.cost_usd,
            cache_read_tokens: usage.cache_read_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TurnInfo {
    #[ts(type = "number")]
    pub input_tokens: u64,
    #[ts(type = "number")]
    pub output_tokens: u64,
    pub cost_usd: f64,
    #[ts(type = "number")]
    pub steps: u64,
    #[ts(type = "number")]
    pub tool_calls: u64,
    pub duration_s: f64,
}

impl From<&TurnSummary> for TurnInfo {
    fn from(turn: &TurnSummary) -> Self {
        Self {
            input_tokens: turn.input_tokens,
            output_tokens: turn.output_tokens,
            cost_usd: turn.cost_usd,
            steps: turn.steps,
            tool_calls: turn.tool_calls,
            duration_s: turn.duration_s,
        }
    }
}

/// Maps one turn's events to the UI's, remembering which tool call agent86 is observing so a
/// `TurnEvent::Ui` (which does not name its call) can be given one.
///
/// agent86 announces a step's whole batch of calls first, then, call by call in that order,
/// emits each one's UI messages and then its result. So the call a UI message belongs to is the
/// oldest one announced whose result has not come yet; with several calls in a step it is not
/// the last one announced.
#[derive(Debug, Default)]
pub struct TurnMapper {
    /// Calls announced and not yet answered, in call order.
    open: VecDeque<String>,
}

impl TurnMapper {
    pub fn map(&mut self, event: &TurnEvent<'_>) -> Option<DesktopEvent> {
        match *event {
            TurnEvent::ToolCall { call, .. } => self.open.push_back(call.id.clone()),
            TurnEvent::ToolResult { call, .. } => {
                if let Some(at) = self.open.iter().position(|id| *id == call.id) {
                    self.open.remove(at);
                }
            }
            TurnEvent::Ui(message) => {
                return Some(DesktopEvent::Ui {
                    tool_call_id: self.open.front().cloned(),
                    // An `AgentMessage` is plain serde data; this cannot fail in practice, and a
                    // message that did would be dropped rather than end the turn.
                    message: serde_json::to_value(message).ok()?,
                });
            }
            _ => {}
        }
        DesktopEvent::from_turn_event(event)
    }
}

impl DesktopEvent {
    /// The UI's version of `event`, or `None` for an event this app does not show. `TurnEvent` is
    /// `#[non_exhaustive]` (agent86-core 1.2.0), so a later release may add kinds this does not
    /// know yet; they are skipped rather than failing the turn. `TurnEvent::Ui` needs the turn's
    /// state and goes through [`TurnMapper`].
    pub fn from_turn_event(event: &TurnEvent<'_>) -> Option<Self> {
        let event = match *event {
            TurnEvent::Text(text) => Self::AgentText { text: text.into() },
            TurnEvent::Thinking(text) => Self::Thought { text: text.into() },
            TurnEvent::Notice(text) => Self::Notice { text: text.into() },
            TurnEvent::ToolCall { call, text } => Self::ToolCall {
                id: call.id.clone(),
                name: call.name.clone(),
                arguments: Value::Object(call.arguments.clone()),
                title: strip_tool_prefix(text),
            },
            TurnEvent::ToolResult {
                call,
                result,
                observation,
                text,
            } => {
                let (output, truncated) = cap(observation, MAX_TOOL_OUTPUT_BYTES);
                Self::ToolResult {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    ok: result.ok,
                    output,
                    truncated,
                    error: result.error.clone(),
                    summary: strip_tool_prefix(text),
                }
            }
            TurnEvent::Usage { step, session } => Self::Usage {
                step: step.into(),
                session: session.into(),
            },
            TurnEvent::Compacted { notice, summary } => Self::Compacted {
                notice: notice.into(),
                summary: summary.map(str::to_owned),
            },
            _ => return None,
        };
        Some(event)
    }
}

fn strip_tool_prefix(line: &str) -> String {
    let line = line.trim();
    line.strip_prefix("[tool]")
        .unwrap_or(line)
        .trim()
        .to_owned()
}

/// `text` cut to at most `max` bytes on a character boundary, and whether it was cut.
fn cap(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_owned(), false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_a_type_tag_and_camel_case_fields() {
        let event = DesktopEvent::TurnEnded {
            stop_reason: StopReason::Cancelled,
            answer: String::new(),
            turn: None,
            usage: UsageInfo::from(&Usage::default()),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "turnEnded");
        assert_eq!(json["stopReason"], "cancelled");
        assert_eq!(json["usage"]["inputTokens"], 0);
    }

    #[test]
    fn maps_the_events_it_knows() {
        assert_eq!(
            DesktopEvent::from_turn_event(&TurnEvent::Text("hi")),
            Some(DesktopEvent::AgentText { text: "hi".into() })
        );
        assert_eq!(
            DesktopEvent::from_turn_event(&TurnEvent::Notice("[cancelled]")),
            Some(DesktopEvent::Notice {
                text: "[cancelled]".into()
            })
        );
    }

    #[test]
    fn strips_the_tool_prefix() {
        assert_eq!(strip_tool_prefix("[tool] list_dir(.)\n"), "list_dir(.)");
        assert_eq!(strip_tool_prefix("plain"), "plain");
    }

    #[test]
    fn caps_on_a_character_boundary() {
        assert_eq!(cap("short", 10), ("short".to_owned(), false));
        // "é" is two bytes; a cap of 2 must not split it.
        assert_eq!(cap("aéb", 2), ("a".to_owned(), true));
    }
}
