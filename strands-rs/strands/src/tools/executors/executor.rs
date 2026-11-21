//! Shared executor types.

use std::sync::Arc;

use futures::future::BoxFuture;
use indexmap::IndexMap;
use tokio::sync::mpsc;

use super::concurrent::{ConcurrentToolExecutor, execute_concurrent};
use super::sequential::{SequentialToolExecutor, execute_sequential};
use crate::cancel::CancelSignal;
use crate::error::Error;
use crate::interrupt::Interrupt;
use crate::models::BoxStream;
use crate::telemetry::in_current_context;
use crate::tools::ToolOutcome;
use crate::types::{ToolResultBlock, ToolResultContent, ToolUseBlock};

/// How the tool calls of one model turn run (`ToolExecutorStrategy`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum ToolExecutorStrategy {
    /// Every call runs on its own task ([`ConcurrentToolExecutor`]); the default.
    #[default]
    Concurrent,
    /// Calls run one at a time, in order ([`SequentialToolExecutor`]).
    Sequential,
}

impl From<ConcurrentToolExecutor> for ToolExecutorStrategy {
    fn from(_: ConcurrentToolExecutor) -> Self {
        Self::Concurrent
    }
}

impl From<SequentialToolExecutor> for ToolExecutorStrategy {
    fn from(_: SequentialToolExecutor) -> Self {
        Self::Sequential
    }
}

/// Runs one tool call through the per-tool pipeline: reports its events through the sink and
/// returns its outcome.
pub(crate) type ToolPipelineFn<E> =
    Arc<dyn Fn(ToolUseBlock, EventSink<E>) -> BoxFuture<'static, CallOutcome> + Send + Sync>;

/// How one tool call of a batch ended: a result, the interrupts its tool or hooks raised, a
/// hook error, which stops the batch and fails the invocation, or a tool-stage failure (a
/// middleware error), which the concurrent executor turns into that call's error result and the
/// sequential executor treats like a hook error.
#[derive(Debug)]
pub(crate) enum CallOutcome {
    Result(ToolResultBlock),
    Interrupts(Vec<Interrupt>),
    Error(Error),
    StageError(Error),
}

impl From<ToolOutcome> for CallOutcome {
    fn from(outcome: ToolOutcome) -> Self {
        match outcome {
            ToolOutcome::Result(result) => Self::Result(result),
            ToolOutcome::Interrupt(interrupts) => Self::Interrupts(interrupts.into_interrupts()),
        }
    }
}

pub(crate) enum Message<E> {
    Event(E),
    Done(usize, Box<CallOutcome>),
}

/// Where a tool call's pipeline reports its events. Events of one call keep their order.
///
/// The channel is bounded and [`send`](Self::send) waits for room, so a tool produces events only
/// as fast as the agent stream is consumed.
pub(crate) struct EventSink<E> {
    sender: Option<mpsc::Sender<Message<E>>>,
}

impl<E> Clone for EventSink<E> {
    fn clone(&self) -> Self {
        Self {
            sender: self.sender.clone(),
        }
    }
}

impl<E> EventSink<E> {
    pub(crate) fn new(sender: mpsc::Sender<Message<E>>) -> Self {
        Self { sender: Some(sender) }
    }

    /// A sink that drops every event.
    pub(crate) fn discard() -> Self {
        Self { sender: None }
    }

    /// Reports an event, waiting while the batch has not taken the earlier ones. Does nothing
    /// once the batch's stream is gone.
    pub(crate) async fn send(&self, event: E) {
        if let Some(sender) = &self.sender {
            let _ = sender.send(Message::Event(event)).await;
        }
    }
}

/// The tool calls of one model turn.
pub(crate) struct ToolBatch {
    /// The calls, in the order the model made them.
    pub(crate) tool_uses: Vec<ToolUseBlock>,
    /// Results restored on resume, by tool use id; those calls do not run again.
    pub(crate) completed: IndexMap<String, ToolResultBlock>,
    /// Checked between sequential calls.
    pub(crate) cancel_signal: CancelSignal,
}

/// How a batch ended.
#[derive(Debug, Default)]
pub(crate) struct BatchOutcome {
    /// The results for the tool result message, in call order.
    pub(crate) results: Vec<ToolResultBlock>,
    /// Every finished result by tool use id, restored ones included, for the pending execution
    /// an interrupt saves.
    pub(crate) completed: IndexMap<String, ToolResultBlock>,
    /// The interrupts the calls raised, in the order they ended.
    pub(crate) interrupts: Vec<Interrupt>,
    /// The hook error that stopped the batch; the invocation fails with it after
    /// `AfterToolsEvent`.
    pub(crate) error: Option<Error>,
}

/// One item of an executor's stream.
pub(crate) enum ExecutorItem<E> {
    /// An event a call reported.
    Event(E),
    /// A call's final result; the agent fires `ToolResultEvent` for it.
    Result(ToolResultBlock),
    /// The batch finished; always the last item.
    Done(BatchOutcome),
}

impl ToolExecutorStrategy {
    /// Runs a batch. The stream owns the running calls: dropping it aborts them.
    pub(crate) fn execute<E: Send + 'static>(
        self,
        batch: ToolBatch,
        pipeline: ToolPipelineFn<E>,
    ) -> BoxStream<'static, ExecutorItem<E>> {
        match self {
            Self::Concurrent => execute_concurrent(batch, pipeline),
            Self::Sequential => execute_sequential(batch, pipeline),
        }
    }
}

/// The capacity of a batch's event channel: room for one undelivered item per call.
pub(crate) fn channel_capacity(calls: usize) -> usize {
    calls.max(1)
}

/// The text of a panicking tool's error result: the panic message.
pub(crate) fn panic_result(tool_use_id: &str, payload: &(dyn std::any::Any + Send)) -> ToolResultBlock {
    let message = payload
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "tool execution panicked".to_owned());
    ToolResultBlock::error(tool_use_id, vec![ToolResultContent::text(message)])
}

/// The error result of a call whose tool stage failed: the error's message, with the error kept.
pub(crate) fn failure_result(tool_use_id: &str, error: Error) -> ToolResultBlock {
    ToolResultBlock::error(tool_use_id, vec![ToolResultContent::text(error.to_string())]).with_error(error)
}

pub(crate) fn text_result(tool_use_id: &str, text: &str) -> ToolResultBlock {
    ToolResultBlock::error(tool_use_id, vec![ToolResultContent::text(text)])
}

/// Spawns one call's pipeline in the caller's span and OpenTelemetry context, so its hooks and
/// middleware see them; it reports its events and then its outcome on `sender`.
pub(crate) fn spawn_call<E: Send + 'static>(
    tasks: &mut tokio::task::JoinSet<()>,
    index: usize,
    tool_use: ToolUseBlock,
    pipeline: &ToolPipelineFn<E>,
    sender: &mpsc::Sender<Message<E>>,
) -> tokio::task::Id {
    let future = in_current_context(pipeline(tool_use, EventSink::new(sender.clone())));
    let sender = sender.clone();
    tasks
        .spawn(async move {
            let outcome = future.await;
            let _ = sender.send(Message::Done(index, Box::new(outcome))).await;
        })
        .id()
}

/// The result of a call whose task ended without an outcome. A panic outside the tool body (a
/// hook or middleware) is a bug in that code and resumes on the caller, as it would for a
/// sequential hook; tool panics never get here, the pipeline turns them into error results.
pub(crate) fn ended_without_outcome(error: tokio::task::JoinError, tool_use_id: &str) -> ToolResultBlock {
    match error.try_into_panic() {
        Ok(payload) => std::panic::resume_unwind(payload),
        Err(_) => text_result(tool_use_id, "Tool execution interrupted"),
    }
}
