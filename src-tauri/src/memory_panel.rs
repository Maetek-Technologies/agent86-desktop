//! The memory panel: facts (what `remember` keeps) and episodes (one per finished turn, recalled
//! into similar later tasks) in the memory database shared with the CLI, a page at a time,
//! pinned so retention never prunes them, or forgotten for good.

use crate::unstable;
use agent86_core::sdk::Memory;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The most entries one page may hold (agent86's own cap for a listing).
pub const MAX_PAGE: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum MemoryKind {
    Fact,
    Episode,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MemoryEntry {
    pub kind: MemoryKind,
    /// Facts and episodes number their rows separately.
    #[ts(type = "number")]
    pub id: i64,
    /// Seconds since the Unix epoch.
    pub stored_at: f64,
    /// The fact, or the episode's task.
    pub text: String,
    /// The episode's outcome.
    pub outcome: Option<String>,
    /// The session the episode came from.
    pub session_id: Option<String>,
    /// A fact's kind (`fact` for what `remember` stores), or an episode's (`compaction` for an
    /// archived history).
    pub category: Option<String>,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MemoryPage {
    pub entries: Vec<MemoryEntry>,
    /// Whether there are more after these.
    pub more: bool,
}

/// One page of `kind`, newest first.
pub fn page(
    memory: &Memory,
    kind: MemoryKind,
    pinned_only: bool,
    offset: usize,
    limit: usize,
) -> Result<MemoryPage, String> {
    let limit = limit.clamp(1, MAX_PAGE);
    // One more than asked, to know whether another page follows.
    let mut entries = unstable::list_memory(memory, kind, pinned_only, offset, limit + 1)?;
    let more = entries.len() > limit;
    entries.truncate(limit);
    Ok(MemoryPage { entries, more })
}

/// Pin or unpin an entry; the entry as it now stands.
pub fn pin(
    memory: &Memory,
    kind: MemoryKind,
    id: i64,
    pinned: bool,
) -> Result<MemoryEntry, String> {
    unstable::pin_memory(memory, kind, id, pinned)?
        .ok_or_else(|| format!("There is no {} #{id} any more.", noun(kind)))
}

/// Delete an entry for good.
pub fn forget(memory: &Memory, kind: MemoryKind, id: i64) -> Result<(), String> {
    if unstable::forget_memory(memory, kind, id)? {
        Ok(())
    } else {
        Err(format!("There is no {} #{id} any more.", noun(kind)))
    }
}

fn noun(kind: MemoryKind) -> &'static str {
    match kind {
        MemoryKind::Fact => "fact",
        MemoryKind::Episode => "episode",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_database_has_no_pages_and_nothing_to_pin() {
        let memory = Memory::in_memory().unwrap();
        let page = page(&memory, MemoryKind::Fact, false, 0, 20).unwrap();
        assert!(page.entries.is_empty());
        assert!(!page.more);
        assert!(pin(&memory, MemoryKind::Episode, 3, true)
            .unwrap_err()
            .contains("episode #3"));
        assert!(forget(&memory, MemoryKind::Fact, 3).is_err());
    }
}
