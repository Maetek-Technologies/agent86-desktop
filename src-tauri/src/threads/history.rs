//! A reopened session's conversation, as transcript items for the UI. agent86 keeps messages, not
//! the turn's events, so this is what a replay can show: what was said, which tools were called,
//! and what they returned (text only, as agent86-web shows a `session/load` replay).

use super::events::MAX_TOOL_OUTPUT_BYTES;
use agent86_core::sdk::{Conversation, Role};
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum HistoryItem {
    User {
        text: String,
    },
    Agent {
        text: String,
    },
    Tool {
        id: String,
        name: String,
        #[ts(type = "Record<string, unknown>")]
        arguments: Value,
        /// What the call returned, if the conversation kept it.
        output: Option<String>,
        ok: bool,
    },
}

/// The conversation as transcript items, oldest first.
pub fn from_conversation(conversation: &Conversation) -> Vec<HistoryItem> {
    let mut items: Vec<HistoryItem> = Vec::new();
    for message in conversation.messages() {
        match message.role {
            Role::System => {}
            Role::User => items.push(HistoryItem::User {
                text: typed_text(&message.text).to_owned(),
            }),
            Role::Assistant => {
                if !message.text.trim().is_empty() {
                    items.push(HistoryItem::Agent {
                        text: message.text.trim_start().to_owned(),
                    });
                }
                for call in message.tool_calls {
                    items.push(HistoryItem::Tool {
                        id: call.id,
                        name: call.name,
                        arguments: Value::Object(call.arguments),
                        output: None,
                        ok: true,
                    });
                }
            }
            Role::Tool => {
                let Some(answers) = message.answers else {
                    continue;
                };
                let found = items.iter_mut().rev().find_map(|item| match item {
                    HistoryItem::Tool { id, output, ok, .. }
                        if *id == answers && output.is_none() =>
                    {
                        Some((output, ok))
                    }
                    _ => None,
                });
                if let Some((output, ok)) = found {
                    *ok = !failed(&message.text);
                    *output = Some(capped(&message.text));
                }
            }
        }
    }
    items
}

/// What the user typed: the message without the files its `@` mentions inlined.
fn typed_text(text: &str) -> &str {
    text.split("\n\n<file path=\"").next().unwrap_or(text)
}

/// agent86's words for a call that did not succeed.
fn failed(text: &str) -> bool {
    let start = text.trim_start();
    start.starts_with("Not executed:") || start.starts_with("Error") || start.starts_with("error:")
}

fn capped(text: &str) -> String {
    if text.len() <= MAX_TOOL_OUTPUT_BYTES {
        return text.to_owned();
    }
    let mut end = MAX_TOOL_OUTPUT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_inlined_mentions_from_what_the_user_typed() {
        assert_eq!(
            typed_text("look at @a.rs\n\n<file path=\"a.rs\">\nx\n</file>"),
            "look at @a.rs"
        );
        assert_eq!(typed_text("plain"), "plain");
    }

    #[test]
    fn reads_agent86s_failures() {
        assert!(failed("Not executed: declined by user."));
        assert!(failed("Error: no such file"));
        assert!(!failed("fn main() {}"));
    }
}
