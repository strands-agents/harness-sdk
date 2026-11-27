//! Concurrent tool execution.

use std::collections::HashMap;

use indexmap::IndexMap;
use tokio::sync::mpsc;
use tokio::task::JoinSet;

use super::executor::{
    BatchOutcome, CallOutcome, ExecutorItem, Message, ToolBatch, ToolPipelineFn, channel_capacity,
    ended_without_outcome, failure_result, spawn_call, text_result,
};
use crate::models::BoxStream;

/// Runs the tool calls of a turn concurrently, each on its own task (`ConcurrentToolExecutor`).
///
/// Events of different calls interleave; each call's events keep their order. When a call raises
/// an interrupt, its siblings still finish before the agent stops; when a hook fails, the calls
/// still running are aborted and the invocation fails. A tool-stage middleware error is that
/// call's error result, without `AfterToolCallEvent`. A tool that panics becomes an error result
/// with the panic message, and dropping the agent stream aborts calls in flight.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ConcurrentToolExecutor;

impl ConcurrentToolExecutor {
    /// Creates the executor.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

pub(super) fn execute_concurrent<E: Send + 'static>(
    batch: ToolBatch,
    pipeline: ToolPipelineFn<E>,
) -> BoxStream<'static, ExecutorItem<E>> {
    Box::pin(async_stream::stream! {
        let ToolBatch { tool_uses, completed, .. } = batch;
        let (sender, mut receiver) = mpsc::channel(channel_capacity(tool_uses.len()));
        let mut tasks = JoinSet::new();
        let mut task_index = HashMap::new();
        for (index, tool_use) in tool_uses.iter().enumerate() {
            if completed.contains_key(&tool_use.tool_use_id) {
                continue;
            }
            let id = spawn_call(&mut tasks, index, tool_use.clone(), &pipeline, &sender);
            task_index.insert(id, index);
        }
        drop(sender);

        let mut results: IndexMap<String, _> = completed;
        let mut interrupts = Vec::new();
        let mut error = None;
        let mut running = task_index.len();
        while running > 0 && error.is_none() {
            tokio::select! {
                biased;
                Some(message) = receiver.recv() => match message {
                    Message::Event(event) => yield ExecutorItem::Event(event),
                    Message::Done(index, outcome) => {
                        running -= 1;
                        match *outcome {
                            CallOutcome::Result(result) => {
                                results.insert(tool_uses[index].tool_use_id.clone(), result.clone());
                                yield ExecutorItem::Result(result);
                            }
                            CallOutcome::StageError(failure) => {
                                let result = failure_result(&tool_uses[index].tool_use_id, failure);
                                results.insert(tool_uses[index].tool_use_id.clone(), result.clone());
                                yield ExecutorItem::Result(result);
                            }
                            CallOutcome::Interrupts(raised) => interrupts.extend(raised),
                            CallOutcome::Error(failure) => error = Some(failure),
                        }
                    }
                },
                Some(joined) = tasks.join_next_with_id() => {
                    let Err(failure) = joined else { continue };
                    let Some(index) = task_index.get(&failure.id()).copied() else { continue };
                    running -= 1;
                    let tool_use_id = &tool_uses[index].tool_use_id;
                    let result = ended_without_outcome(failure, tool_use_id);
                    results.insert(tool_use_id.clone(), result.clone());
                    yield ExecutorItem::Result(result);
                }
                else => break,
            }
        }
        drop(tasks);

        let ordered = tool_uses
            .iter()
            .map(|tool_use| {
                results
                    .get(&tool_use.tool_use_id)
                    .cloned()
                    .unwrap_or_else(|| text_result(&tool_use.tool_use_id, "Tool execution interrupted"))
            })
            .collect();
        yield ExecutorItem::Done(BatchOutcome {
            results: ordered,
            completed: results,
            interrupts,
            error,
        });
    })
}
