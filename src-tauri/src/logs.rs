//! What the Logs view shows: the agent's activity (agent86's flight recorder, `trace.jsonl`,
//! written by every thread's agent when Settings, Activity log is on) and the app's own log (the
//! `log` crate through tauri-plugin-log). Only these two files are read, at paths Rust decides;
//! both are already redacted (agent86 scrubs secrets from its trace, and the app never logs one).

use serde::Serialize;
use serde_json::{Map, Value};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use ts_rs::TS;

/// The most of a file's end read for one view.
const MAX_TAIL_BYTES: u64 = 4 * 1024 * 1024;

/// One event from the flight recorder.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    /// Seconds since 1970.
    pub ts: f64,
    pub session: String,
    /// `turn_start`, `model_call`, `tool_call`, `guardrail`, `turn_end`, ...
    pub kind: String,
    /// The rest of the record.
    #[ts(type = "Record<string, unknown>")]
    pub fields: Map<String, Value>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ActivityView {
    /// The trace file, when recording is on.
    pub path: Option<String>,
    /// Oldest first; the last `limit` events.
    pub events: Vec<ActivityEvent>,
    /// Why there is nothing to show (recording off, no file yet), if so.
    pub note: Option<String>,
}

/// One entry of the app's log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// `2026-11-20 07:52:01`, local time.
    pub time: String,
    /// `ERROR`, `WARN`, `INFO`, `DEBUG`, `TRACE`.
    pub level: String,
    /// The module that wrote it.
    pub target: String,
    pub message: String,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AppLogView {
    pub path: Option<String>,
    /// Oldest first; the last `limit` entries.
    pub lines: Vec<LogLine>,
    pub note: Option<String>,
}

/// Where the app's log file is, decided at startup.
pub struct LogPaths {
    pub app_log: Option<PathBuf>,
}

/// The file agent86's recorder writes in `dir`.
pub fn trace_file(dir: &Path) -> PathBuf {
    dir.join("trace.jsonl")
}

/// The last `limit` events of the trace at `path`.
pub fn read_activity(path: Option<&Path>, limit: usize) -> ActivityView {
    let Some(path) = path else {
        return ActivityView {
            path: None,
            events: Vec::new(),
            note: Some("The activity log is off (Settings, Activity log).".into()),
        };
    };
    let shown = Some(path.display().to_string());
    let text = match tail(path, MAX_TAIL_BYTES) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ActivityView {
                path: shown,
                events: Vec::new(),
                note: Some("Nothing recorded yet; events appear once a turn runs.".into()),
            }
        }
        Err(error) => {
            return ActivityView {
                path: shown,
                events: Vec::new(),
                note: Some(format!("{}: {error}", path.display())),
            }
        }
    };
    let mut events: Vec<ActivityEvent> = text.lines().filter_map(parse_event).collect();
    let skip = events.len().saturating_sub(limit);
    events.drain(..skip);
    ActivityView {
        path: shown,
        events,
        note: None,
    }
}

fn parse_event(line: &str) -> Option<ActivityEvent> {
    let Value::Object(mut record) = serde_json::from_str::<Value>(line).ok()? else {
        return None;
    };
    let ts = record.remove("ts")?.as_f64()?;
    let session = match record.remove("session") {
        Some(Value::String(session)) => session,
        _ => String::new(),
    };
    let kind = match record.remove("kind")? {
        Value::String(kind) => kind,
        _ => return None,
    };
    Some(ActivityEvent {
        ts,
        session,
        kind,
        fields: record,
    })
}

/// The last `limit` entries of the app's log at `path`.
pub fn read_app_log(path: Option<&Path>, limit: usize) -> AppLogView {
    let Some(path) = path else {
        return AppLogView {
            path: None,
            lines: Vec::new(),
            note: Some("The app has no log folder.".into()),
        };
    };
    let shown = Some(path.display().to_string());
    let text = match tail(path, MAX_TAIL_BYTES) {
        Ok(text) => text,
        Err(error) => {
            return AppLogView {
                path: shown,
                lines: Vec::new(),
                note: Some(format!("{}: {error}", path.display())),
            }
        }
    };
    let mut lines = parse_log(&text);
    let skip = lines.len().saturating_sub(limit);
    lines.drain(..skip);
    AppLogView {
        path: shown,
        lines,
        note: None,
    }
}

/// tauri-plugin-log's lines, `[2026-11-20][07:52:01][INFO][target] message`; a line in any other
/// shape continues the message before it.
pub fn parse_log(text: &str) -> Vec<LogLine> {
    let mut lines: Vec<LogLine> = Vec::new();
    for raw in text.lines() {
        match parse_log_line(raw) {
            Some(line) => lines.push(line),
            None => {
                if let Some(last) = lines.last_mut() {
                    last.message.push('\n');
                    last.message.push_str(raw);
                }
            }
        }
    }
    lines
}

fn parse_log_line(raw: &str) -> Option<LogLine> {
    let mut rest = raw;
    let mut part = || {
        let inner = rest.strip_prefix('[')?;
        let end = inner.find(']')?;
        let value = &inner[..end];
        rest = &inner[end + 1..];
        Some(value.to_owned())
    };
    let (date, time, level, target) = (part()?, part()?, part()?, part()?);
    let known = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"];
    if date.len() != 10 || !known.contains(&level.as_str()) {
        return None;
    }
    Some(LogLine {
        time: format!("{date} {time}"),
        level,
        target,
        message: rest.trim_start().to_owned(),
    })
}

/// The end of the file at `path`, at most `max` bytes, starting at a line boundary.
fn tail(path: &Path, max: u64) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    let start = size.saturating_sub(max);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        // The first line was cut; drop it.
        text = text
            .split_once('\n')
            .map(|(_, rest)| rest.to_owned())
            .unwrap_or_default();
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_events_are_read_oldest_first_and_capped() {
        let dir = tempfile::tempdir().unwrap();
        let path = trace_file(dir.path());
        let lines = [
            r#"{"ts": 1.5, "session": "s1", "kind": "turn_start", "task": "hi"}"#,
            "not json",
            r#"{"ts": 2.0, "session": "s1", "kind": "model_call", "model": "m", "input_tokens": 10}"#,
            r#"{"ts": 3.0, "session": "s1", "kind": "turn_end", "status": "done"}"#,
        ];
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        let view = read_activity(Some(&path), 2);
        assert_eq!(view.events.len(), 2);
        assert_eq!(view.events[0].kind, "model_call");
        assert_eq!(view.events[0].fields["model"], "m");
        assert!(!view.events[0].fields.contains_key("ts"));
        assert_eq!(view.events[1].kind, "turn_end");
        assert!(view.note.is_none());
    }

    #[test]
    fn a_missing_trace_or_recording_off_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let view = read_activity(Some(&trace_file(dir.path())), 10);
        assert!(view.note.unwrap().contains("Nothing recorded yet"));
        assert!(read_activity(None, 10).note.unwrap().contains("off"));
    }

    #[test]
    fn app_log_lines_are_parsed_with_continuations() {
        let text = "[2026-11-20][07:52:01][INFO][agent86_desktop_lib] Agent 86 1.0.1 started\n\
                    [2026-11-20][07:52:09][WARN][agent86_desktop_lib::commands] Thread failed:\n\
                    second line\n\
                    [2026-11-20][07:53:00][ERROR][tao] boom\n";
        let lines = parse_log(text);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].time, "2026-11-20 07:52:01");
        assert_eq!(lines[0].level, "INFO");
        assert_eq!(lines[0].message, "Agent 86 1.0.1 started");
        assert_eq!(lines[1].message, "Thread failed:\nsecond line");
        assert_eq!(lines[2].target, "tao");
    }

    #[test]
    fn a_long_file_is_read_from_a_line_boundary_near_its_end() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.log");
        let line = "[2026-11-20][07:52:01][INFO][x] 0123456789\n";
        std::fs::write(&path, line.repeat(1000)).unwrap();
        let text = tail(&path, 100).unwrap();
        assert!(text.starts_with("[2026"));
        assert!(text.len() <= 100);
    }
}
