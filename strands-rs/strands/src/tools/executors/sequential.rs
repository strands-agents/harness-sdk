//! Sequential tool execution.

use tokio::sync::mpsc;
use tokio::task::JoinSet;

use super::executor::{
    BatchOutcome, CallOutcome, ExecutorItem, Message, ToolBatch, ToolPipelineFn, channel_capacity,
    ended_without_outcome, spawn_call, text_result,
};
use crate::models::BoxStream;

/// Runs the tool calls of a turn one at a time, in order (`SequentialToolExecutor`).
///
/// The cancel signal is checked between calls, so calls that have not started end as
/// `Tool execution cancelled`. An interrupt, a hook error or a tool-stage middleware error stops
/// the batch at once; later calls do not run, and an error fails the invocation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct SequentialToolExecutor;

impl SequentialToolExecutor {
    /// Creates the executor.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

enum CallEnd<E> {
    Event(E),
    Outcome(CallOutcome),
}

pub(super) fn execute_sequential<E: Send + 'static>(
    batch: ToolBatch,
    pipeline: ToolPipelineFn<E>,
) -> BoxStream<'static, ExecutorItem<E>> {
    Box::pin(async_stream::stream! {
        let ToolBatch { tool_uses, completed, cancel_signal } = batch;
        let mut outcome = BatchOutcome {
            completed: completed.clone(),
            ..BatchOutcome::default()
        };
        for (index, tool_use) in tool_uses.into_iter().enumerate() {
            if let Some(result) = completed.get(&tool_use.tool_use_id) {
                outcome.results.push(result.clone());
                continue;
            }
            let tool_use_id = tool_use.tool_use_id.clone();
            let result = if cancel_signal.is_cancelled() {
                text_result(&tool_use_id, "Tool execution cancelled")
            } else {
                let (sender, mut receiver) = mpsc::channel(channel_capacity(1));
                let mut tasks = JoinSet::new();
                spawn_call(&mut tasks, index, tool_use, &pipeline, &sender);
                drop(sender);
                let mut ended = None;
                while ended.is_none() {
                    let step = next_step(&mut receiver, &mut tasks, &tool_use_id).await;
                    match step {
                        CallEnd::Event(event) => yield ExecutorItem::Event(event),
                        CallEnd::Outcome(call_outcome) => ended = Some(call_outcome),
                    }
                }
                match ended {
                    Some(CallOutcome::Result(result)) => result,
                    Some(CallOutcome::Interrupts(raised)) => {
                        outcome.interrupts.extend(raised);
                        break;
                    }
                    Some(CallOutcome::Error(error) | CallOutcome::StageError(error)) => {
                        outcome.error = Some(error);
                        break;
                    }
                    None => text_result(&tool_use_id, "Tool execution interrupted"),
                }
            };
            outcome.results.push(result.clone());
            outcome.completed.insert(tool_use_id, result.clone());
            yield ExecutorItem::Result(result);
        }
        yield ExecutorItem::Done(outcome);
    })
}

/// The next event or the outcome of the running call.
async fn next_step<E>(
    receiver: &mut mpsc::Receiver<Message<E>>,
    tasks: &mut JoinSet<()>,
    tool_use_id: &str,
) -> CallEnd<E> {
    if let Ok(message) = receiver.try_recv() {
        return from_message(message);
    }
    tokio::select! {
        biased;
        Some(message) = receiver.recv() => from_message(message),
        Some(Err(error)) = tasks.join_next() => {
            if let Ok(message) = receiver.try_recv() {
                return from_message(message);
            }
            CallEnd::Outcome(CallOutcome::Result(ended_without_outcome(error, tool_use_id)))
        }
        else => CallEnd::Outcome(CallOutcome::Result(text_result(tool_use_id, "Tool execution interrupted"))),
    }
}

fn from_message<E>(message: Message<E>) -> CallEnd<E> {
    match message {
        Message::Event(event) => CallEnd::Event(event),
        Message::Done(_, outcome) => CallEnd::Outcome(*outcome),
    }
}
