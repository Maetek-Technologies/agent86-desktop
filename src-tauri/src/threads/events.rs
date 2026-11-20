//! What a thread streams to the UI: owned, serializable versions of agent86-core's borrowed
//! [`TurnEvent`]s, plus the turn's end. `cargo test` writes their TypeScript types to
//! `src/desktop-client/generated` (ts-rs).

use super::questions::{ApprovalInfo, LimitInfo};
use agent86_core::sdk::{TurnEvent, TurnSummary, Usage};
use serde::Serialize;
use serde_json::Value;
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

impl DesktopEvent {
    pub fn from_turn_event(event: &TurnEvent<'_>) -> Self {
        match *event {
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
        }
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
