//! Threads: one in-process agent86 agent each (docs/PROJECT_PLAN.md §3.1).

pub mod actor;
pub mod events;
pub mod manager;
pub mod questions;

#[cfg(test)]
mod tests;

pub use actor::EventSink;
pub use events::DesktopEvent;
pub use manager::ThreadManager;
