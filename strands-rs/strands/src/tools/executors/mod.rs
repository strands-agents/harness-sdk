//! Tool executors: how the tool calls of one model turn run.
//!
//! [`ConcurrentToolExecutor`] (the default) runs every call of a batch on its own task;
//! [`SequentialToolExecutor`] runs them one after another. Choose one with
//! [`ToolExecutorStrategy`].
//!
//! The executors only schedule. The agent loop supplies the per-tool pipeline (the before-call
//! hook, the tool stream, the after-call hook and retries) as a function that reports the call's
//! events through a sink and returns its [`ToolOutcome`](crate::tools::ToolOutcome).

mod concurrent;
mod executor;
mod sequential;

pub use concurrent::ConcurrentToolExecutor;
pub use executor::ToolExecutorStrategy;
pub(crate) use executor::{
    BatchOutcome, CallOutcome, EventSink, ExecutorItem, ToolBatch, ToolPipelineFn, failure_result, panic_result,
};
pub use sequential::SequentialToolExecutor;

/// Tests executor scheduling and cancellation with stub pipelines.
#[cfg(test)]
mod tests;
