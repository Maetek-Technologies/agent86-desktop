//! The app's threads, by id.

use super::actor::{EventSink, MakeBuilder, ThreadHandle};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

#[derive(Default)]
pub struct ThreadManager {
    threads: Mutex<HashMap<String, ThreadHandle>>,
    next_id: AtomicU64,
}

impl ThreadManager {
    /// Start a thread and return its id.
    pub fn open(&self, make: MakeBuilder, sink: EventSink) -> Result<String, String> {
        let handle = ThreadHandle::spawn(make, sink)?;
        let id = format!("t{}", self.next_id.fetch_add(1, Ordering::SeqCst) + 1);
        self.lock().insert(id.clone(), handle);
        Ok(id)
    }

    pub fn prompt(&self, id: &str, text: String) -> Result<(), String> {
        self.with(id, |thread| thread.prompt(text))
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        self.with(id, |thread| {
            thread.cancel();
            Ok(())
        })
    }

    pub fn answer(
        &self,
        id: &str,
        qid: u64,
        answer: super::questions::Answer,
    ) -> Result<(), String> {
        self.with(id, |thread| thread.answer(qid, answer))
    }

    /// Close a thread: cancels its turn, if any, and lets its actor exit.
    pub fn close(&self, id: &str) -> Result<(), String> {
        self.lock().remove(id).map(drop).ok_or_else(|| unknown(id))
    }

    fn with<T>(
        &self,
        id: &str,
        f: impl FnOnce(&ThreadHandle) -> Result<T, String>,
    ) -> Result<T, String> {
        let threads = self.lock();
        let thread = threads.get(id).ok_or_else(|| unknown(id))?;
        f(thread)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, ThreadHandle>> {
        // A panic while holding the lock leaves the map itself intact.
        self.threads
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn unknown(id: &str) -> String {
    format!("No thread with id {id:?}.")
}
