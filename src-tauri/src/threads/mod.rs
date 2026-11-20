//! Threads: one in-process agent86 agent each (docs/PROJECT_PLAN.md §3.1).

pub mod actor;
pub mod events;
pub mod manager;

#[cfg(test)]
mod tests;

pub use events::DesktopEvent;
pub use manager::ThreadManager;
